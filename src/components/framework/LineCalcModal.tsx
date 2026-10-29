/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { calcBreakdown, discountOf, BASE_KEY, PRICE_SUFFIX, varAmount, withoutPriceOverrides, type Calculator, type CalcDiscount, type CalcVariable, type TierDuration } from "../pages/settings/catalogApi";
import { lineBreakdown, yearAmounts, hasIncrements, type LineIncrements, type RevenueLineFields, type TermPatch } from "../pages/sales/sales/salesApi";
import Select from "./Select";
import { listPartnerRates, partnerList, partnerDefault, partnerCut, type PartnerRate } from "../pages/companies/companiesApi";
import "./LineCalcModal.css";

/** Partners and their default cuts, read once per visit. */
// The partners are the companies with a partner type (Settings › Companies page); read again on each opening.
const loadPartners = (): Promise<{ partners: { id: string; name: string }[]; rates: PartnerRate[] }> =>
  Promise.all([partnerList(true).catch(() => []), listPartnerRates().catch(() => [])]).then(([partners, rates]) => ({ partners, rates }));

/**
 * The commitment picked on the deal (months), kept with the calculator values.
 * The tier's price already has its commitment discount when it reaches `price`,
 * exactly like the catalogue preview: tier price × (1 − commitment %) is the
 * base the calculator inputs (and "% of base") work from.
 */
const MONTHS_KEY = "__months";

/** − value + : one box, the value centred, the focus ring on the same box you see. */
function Step({ value, onChange, step = 1, min = 0, max, disabled, suffix, size, label }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number;
  disabled?: boolean; suffix?: string; size?: "sm" | "lg"; label?: string;
}) {
  const clamp = (v: number) => {
    let x = Math.max(min, +(+v).toFixed(2));
    if (max != null) x = Math.min(max, x);
    return x;
  };
  return (
    <div className={`lcx-step ${size ? `is-${size}` : ""} ${disabled ? "is-disabled" : ""}`}>
      <button type="button" onClick={() => onChange(clamp(value - step))} disabled={disabled || value <= min} aria-label={`Less ${label ?? ""}`}>−</button>
      <span className="lcx-step-val">
        <input type="number" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={label}
          onFocus={(e) => e.target.select()} onChange={(e) => onChange(clamp(parseFloat(e.target.value) || 0))} />
        {suffix && <em>{suffix}</em>}
      </span>
      <button type="button" onClick={() => onChange(clamp(value + step))} disabled={disabled || (max != null && value >= max)} aria-label={`More ${label ?? ""}`}>+</button>
    </div>
  );
}

/** A row's discount: "+ Discount" until used, then % or € with what it takes off. */
function DiscountControl({ dkey, amount, discounts, setDisc, money }: {
  dkey: string; amount: number;
  discounts: Record<string, CalcDiscount>;
  setDisc: (key: string, patch: Partial<CalcDiscount>) => void;
  money: (n: number) => string;
}) {
  const d = discounts[dkey] ?? { mode: "none" as const, value: 0 };
  const [open, setOpen] = useState(d.mode !== "none");
  // Only a discount the user just added grabs the focus (not one already saved on the line).
  const [fresh, setFresh] = useState(false);
  const off = discountOf(amount, d);
  if (!open || d.mode === "none") {
    return (
      <button type="button" className="lcx-disc-add" onClick={() => { setOpen(true); setFresh(true); setDisc(dkey, { mode: "percent" }); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M19 5L5 19M7 7h.01M17 17h.01" /></svg>
        Discount
      </button>
    );
  }
  return (
    <div className="lcx-disc">
      <div className="lcx-seg is-xs">
        <button type="button" className={d.mode === "percent" ? "is-on" : ""} onClick={() => setDisc(dkey, { mode: "percent" })}>%</button>
        <button type="button" className={d.mode === "amount" ? "is-on" : ""} onClick={() => setDisc(dkey, { mode: "amount" })}>{"€"}</button>
      </div>
      <label className="lcx-disc-in">
        <input type="number" min="0" value={d.value} onFocus={(e) => e.target.select()} autoFocus={fresh}
          onChange={(e) => setDisc(dkey, { value: parseFloat(e.target.value) || 0 })} aria-label="Discount" />
      </label>
      <span className="lcx-disc-off">−{money(off)}</span>
      <button type="button" className="lcx-disc-x" onClick={() => { setDisc(dkey, { mode: "none", value: 0 }); setOpen(false); }} aria-label="Remove discount">×</button>
    </div>
  );
}

/** Per-row rate override, used by service duration calculators. */
function RateControl({ rkey, rates, baseRate, setRate, unit }: {
  rkey: string; rates: Record<string, number>; baseRate: number;
  setRate: (key: string, v: number) => void; unit: string;
}) {
  const v = rates[rkey] == null ? baseRate : rates[rkey];
  return (
    <label className={`lcx-rate ${rates[rkey] != null && rates[rkey] !== baseRate ? "is-custom" : ""}`} title="Rate for this row">
      <input type="number" min="0" value={v} onFocus={(e) => e.target.select()}
        onChange={(e) => setRate(rkey, parseFloat(e.target.value) || 0)} />
      <span>€/{unit}</span>
    </label>
  );
}

/**
 * Yearly increases of a multi-year line: none, a % a year, a fixed amount a
 * year, or each year typed by hand. Shows what every year comes to.
 */
export function IncrementsEditor({ value, onChange, firstYear, years, money, compact }: {
  value: LineIncrements;
  onChange: (v: LineIncrements) => void;
  /** What year 1 costs (the line's own yearly price). */
  firstYear: number;
  years: number;
  money: (n: number) => string;
  compact?: boolean;
}) {
  const n = Math.max(1, Math.ceil(years || 1));
  const amounts = yearAmounts(firstYear, n, value);
  const set = (patch: Partial<LineIncrements>) => onChange({ ...value, ...patch } as LineIncrements);
  const modes: { k: LineIncrements["mode"]; label: string }[] = [
    { k: "none", label: "None" }, { k: "pct", label: "% a year" }, { k: "fixed", label: "€ a year" }, { k: "custom", label: "Each year" },
  ];
  const pickMode = (k: LineIncrements["mode"]) => {
    // Switching to "each year" starts from what the years come to now.
    if (k === "custom") set({ mode: "custom", perYear: amounts.map((a) => Math.round(a)) });
    else set({ mode: k });
  };
  const maxA = Math.max(1, ...amounts);
  return (
    <div className={`lc-inc ${compact ? "is-compact" : ""}`}>
      <div className="lc-inc-top">
        <div className="lc-seg lc-inc-seg">
          {modes.map((m) => (
            <button type="button" key={m.k} className={value.mode === m.k ? "is-on" : ""} onClick={() => pickMode(m.k)}>{m.label}</button>
          ))}
        </div>
        {(value.mode === "pct" || value.mode === "fixed") && (
          <label className="lc-money lc-inc-val">
            <input type="number" min="0" step={value.mode === "pct" ? 0.5 : 50} value={Number(value.value) || 0} onFocus={(e) => e.target.select()}
              onChange={(e) => set({ value: parseFloat(e.target.value) || 0 })} aria-label="Yearly increase" />
            <em>{value.mode === "pct" ? "% / year" : "€ / year"}</em>
          </label>
        )}
      </div>
      {n > 1 ? (
        <div className="lc-inc-years">
          {amounts.map((a, i) => {
            const prev = i > 0 ? amounts[i - 1] : 0;
            const up = i > 0 && prev ? ((a / prev) - 1) * 100 : 0;
            return (
              <div key={i} className={`lc-inc-year ${i === 0 ? "is-first" : ""}`} style={{ ["--h" as any]: `${Math.max(8, (a / maxA) * 100)}%` }}>
                <span className="lc-inc-bar" aria-hidden="true"><i /></span>
                <span className="lc-inc-y">Year {i + 1}</span>
                {value.mode === "custom" && i > 0 ? (
                  <label className="lc-inc-in">
                    <input type="number" min="0" value={value.perYear?.[i] ?? Math.round(a)} onFocus={(e) => e.target.select()}
                      onChange={(e) => { const arr = [...(value.perYear ?? amounts.map((x) => Math.round(x)))]; arr[i] = parseFloat(e.target.value) || 0; set({ perYear: arr }); }} />
                    <em>€</em>
                  </label>
                ) : <b>{money(a)}</b>}
                {i > 0 && Math.abs(up) > 0.005 && <small className={up < 0 ? "is-down" : ""}>{up > 0 ? "+" : ""}{up.toFixed(1)}%</small>}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="lc-hint">Increases apply from year 2 — set a term longer than one year.</p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

/** A number that glides to its new value (count-up), so totals feel alive. */
function useTween(target: number, ms = 560) {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !Number.isFinite(target)) { cur.current = target; setV(target); return; }
    const from = cur.current;
    if (Math.abs(from - target) < 0.005) { setV(target); return; }
    const start = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      cur.current = from + (target - from) * e;
      setV(cur.current);
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return v;
}
function Tween({ value, fmt }: { value: number; fmt: (n: number) => string }) {
  const v = useTween(value);
  return <>{fmt(Math.abs(v - value) < 0.005 ? value : v)}</>;
}

const SEG_COLORS = ["#5eead4", "#a78bfa", "#60a5fa", "#fbbf24", "#f472b6", "#34d399", "#fb923c", "#93c5fd", "#c4b5fd"];
const plural = (u: string) => u || "units";
const singular = (u: string) => (u && u.endsWith("s") ? u.slice(0, -1) : u || "unit");

/** One plain sentence saying what an input does ("€450 per 5 entities above 5 included"). */
function ruleOf(v: CalcVariable, isQty: boolean, unitWord: string, money: (n: number) => string): string {
  const amt = Number(v.amount) || 0;
  const what = isQty ? `${amt} ${amt === 1 ? singular(unitWord) : unitWord}` : money(amt);
  const u = v.unit_label || "units";
  const inc = Number(v.included) || 0;
  const above = inc ? ` above the first ${inc}` : "";
  if (v.var_type === "fixed") return `${what} when it's on`;
  if (v.var_type === "percent") return isQty ? `${amt}% of the base time` : `${amt}% of the base price`;
  if (v.var_type === "per_block") return `${what} for every ${Number(v.block_size) || 1} ${plural(u)}${above}${v.round_mode === "down" ? " (full blocks)" : ""}`;
  return `${what} per ${singular(u)}${above}`;
}
const sliderMax = (v: CalcVariable, val: number) => {
  const base = Math.ceil(((Number(v.default_value) || 0) * 3 + (Number(v.included) || 0) + (v.var_type === "per_block" ? (Number(v.block_size) || 1) * 4 : 10)) / 5) * 5;
  return Math.max(10, base, Math.ceil((val * 1.25) / 5) * 5);
};

/**
 * A collapsible section: a calm header (accent marker, icon, title) that shows
 * a one-line summary while closed, and slides its content open/closed.
 */
function Zone({ cls, accent, icon, title, sub, summary, open, onToggle, children }: {
  cls: string; accent: string; icon: ReactNode; title: string; sub?: string; summary?: ReactNode;
  open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <section className={`lcx-zone ${cls} ${open ? "is-open" : ""}`} style={{ ["--z" as any]: accent }}>
      <button type="button" className="lcx-zone-h" onClick={onToggle} aria-expanded={open}>
        <span className="lcx-zone-ic" aria-hidden="true">{icon}</span>
        <span className="lcx-zone-t">
          <b>{title}</b>
          <small className="lcx-zone-sub">{sub}</small>
        </span>
        <span className="lcx-zone-sum" aria-hidden={open}>{summary}</span>
        <span className="lcx-zone-chev" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </button>
      <div className="lcx-zone-b"><div className="lcx-zone-in"><div className="lcx-zone-pad">{children}</div></div></div>
    </section>
  );
}

type GuideStep = { sel: string; title: string; text: string };

/**
 * Per-line calculator popup: tier and commitment, the product's calculator
 * inputs, term and yearly increase (or quantity), discounts and the partner,
 * with a live visual result beside it. It prices exactly like the catalogue's
 * live preview (Settings › Products & services): same tiers, commitment
 * discounts, calculator maths (calcBreakdown) and yearly schedule.
 */
export default function LineCalcModal({ title, line, tiers, roles, roleName, calculator, unit, minUnit, onApply, onClose, money, partnerItem, defaultIncrements }: {
  title: string;
  line: RevenueLineFields;
  /** The catalogue tiers (with their commitment discounts, when the product has them). */
  tiers?: { id?: string; name: string; price: number; durations?: TierDuration[] | null }[];
  roles?: { role_id: string; price: number }[];
  roleName?: (id: string) => string;
  calculator?: Calculator | null;
  unit?: "hour" | "day" | null;
  minUnit?: number | null;
  onApply: (patch: TermPatch) => void;
  onClose: () => void;
  money: (n: number) => string;
  variant?: "modern";
  /** Shows the partner section: which catalogue item this line is (for the partner's default cut). */
  partnerItem?: { type: "product" | "service"; id: string | null; /** The partner that brought the deal's company: offered first. */ broughtBy?: string | null };
  /** The catalogue product's yearly increase, used when the line has none of its own yet. */
  defaultIncrements?: LineIncrements | null;
}) {
  const [tierId, setTierId] = useState<string>(line.tier_id ?? "");
  const [roleId, setRoleId] = useState<string>(line.role_id ?? "");
  const [values, setValues] = useState<Record<string, number>>(() => { const v = { ...(line.calc_values ?? {}) }; delete v[MONTHS_KEY]; return v; });
  const [months, setMonths] = useState<number>(() => Number(line.calc_values?.[MONTHS_KEY]) || 0);
  const [manualPrice, setManualPrice] = useState<number>(Number(line.price) || 0);

  const tierOf = (id: string) => tiers?.find((t) => t.id === id);
  const commitPct = (id: string, m: number) => {
    if (!m || !line.recurring) return 0;
    const d = (tierOf(id)?.durations ?? []).find((x) => Number(x.months) === m);
    return d ? Number(d.discount_pct) || 0 : 0;
  };
  // A price typed over the tier's (after its commitment) / the rate's own (null = use theirs).
  const [override, setOverride] = useState<number | null>(() => {
    const own = Number(line.price) || 0;
    const t = line.tier_id ? tierOf(line.tier_id) : undefined;
    const list = t ? Number(t.price) * (1 - commitPct(line.tier_id!, Number(line.calc_values?.[MONTHS_KEY]) || 0) / 100)
      : line.role_id ? roles?.find((r) => r.role_id === line.role_id)?.price : undefined;
    return list != null && own > 0 && Math.abs(own - Number(list)) > 0.005 ? own : null;
  });
  const [qty, setQty] = useState<number>(line.quantity == null ? 1 : Number(line.quantity));
  const [years, setYears] = useState<number>(line.term_years == null ? 1 : Number(line.term_years));
  const [inc, setInc] = useState<LineIncrements>(() => line.increments && line.increments.mode ? line.increments : defaultIncrements ?? { mode: "none", value: 0, perYear: [] });
  const [discounts, setDiscounts] = useState<Record<string, CalcDiscount>>(() => {
    const d = { ...(line.calc_discounts ?? {}) };
    // Fold a pre-existing whole-line discount into the base row.
    if (!d[BASE_KEY] && line.discount_mode && line.discount_mode !== "none") {
      d[BASE_KEY] = { mode: line.discount_mode as "percent" | "amount", value: Number(line.discount_value) || 0 };
    }
    return d;
  });
  const setDisc = (key: string, patch: Partial<CalcDiscount>) =>
    setDiscounts((x) => ({ ...x, [key]: Object.assign({ mode: "none", value: 0 } as CalcDiscount, x[key], patch) }));
  const [rates, setRates] = useState<Record<string, number>>(line.calc_rates ?? {});
  const setRate = (key: string, v: number) => setRates((x) => ({ ...x, [key]: v }));
  const [partnerId, setPartnerId] = useState<string>(line.partner_id ?? "");
  const [partnerMode, setPartnerMode] = useState<"percent" | "amount">(line.partner_mode === "amount" ? "amount" : "percent");
  const [partnerValue, setPartnerValue] = useState<number>(Number(line.partner_value) || 0);
  const [partnerData, setPartnerData] = useState<{ partners: { id: string; name: string }[]; rates: PartnerRate[] } | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  // Which sections are open: the price and the calculator (or, without one, the term).
  const [openZ, setOpenZ] = useState<Record<string, boolean>>(() => {
    const hasVars = (calculator?.variables?.length ?? 0) > 0;
    return { tier: true, calc: hasVars, term: !hasVars };
  });
  const toggleZ = (k: string) => setOpenZ((x) => ({ ...x, [k]: !x[k] }));
  // The calculator row whose slider and extras are shown.
  const [openRow, setOpenRow] = useState<string | null>(null);
  // Narrow screens: the result is a bottom sheet that can be pulled up.
  const [sheet, setSheet] = useState(false);
  const [guide, setGuide] = useState<number | null>(null);
  const guideRef = useRef<number | null>(null);
  guideRef.current = guide;
  const rootRef = useRef<HTMLDivElement>(null);

  const wantsPartner = !!partnerItem;
  useEffect(() => { if (wantsPartner) loadPartners().then(setPartnerData).catch(() => {}); }, [wantsPartner]);
  const pickPartner = (id: string) => {
    setPartnerId(id);
    if (!id || !partnerItem || !partnerData) return;
    const d = partnerDefault(partnerData.rates, id, partnerItem.type, partnerItem.id);
    if (d) { setPartnerMode(d.mode); setPartnerValue(d.value); }
  };
  const partnerDef = partnerId && partnerItem && partnerData ? partnerDefault(partnerData.rates, partnerId, partnerItem.type, partnerItem.id) : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (guideRef.current != null) { e.stopPropagation(); setGuide(null); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const unitWord = unit === "hour" ? "hours" : "days";
  const isQtyCalc = calculator?.output_kind === "quantity";
  const isService = !!unit;

  // Base unit price: the chosen tier (after its commitment), the chosen role, or whatever was typed.
  const tier = tierOf(tierId);
  const durs = line.recurring && tier ? (tier.durations ?? []).filter((d) => Number(d.months) > 0) : [];
  const dur = durs.find((d) => Number(d.months) === months);
  const tierRaw = tier ? Number(tier.price) || 0 : undefined;
  const tierPrice = tierRaw != null ? tierRaw * (1 - (Number(dur?.discount_pct) || 0) / 100) : undefined;
  const rolePrice = roles?.find((r) => r.role_id === roleId)?.price;
  // The tier's / rate's price is a starting point: it can be changed and the tier / rate is kept.
  const listPrice = tierPrice ?? rolePrice;
  const basePrice = listPrice != null ? (override ?? listPrice) : manualPrice;

  // A price calculator builds the unit price. A quantity calculator sets how
  // many units instead, leaving the price alone.
  const priceCalc = calculator && !isQtyCalc ? calculator : null;
  const qtyCalc = calculator && isQtyCalc ? calculator : null;
  const qtyBd = qtyCalc ? calcBreakdown(qtyCalc, values, Number(qtyCalc.base_amount) || 0) : null;
  const quantity = qtyBd ? qtyBd.total : qty;

  const draft: RevenueLineFields = {
    price: basePrice, quantity, recurring: line.recurring, period: line.period,
    term_years: years, calc_values: values, calc_discounts: discounts, calc_rates: rates,
    increments: line.recurring ? inc : null,
  };
  const bd = lineBreakdown(draft, calculator, basePrice);
  // Rounding the days up to the billable minimum adds (extra days × base rate)
  // on top of the calculated line. For quantity calculators the breakdown total
  // ignores rounding, so we add it explicitly; for the rest, lineBreakdown with
  // minUnit already does it.
  const bdBill = lineBreakdown(draft, calculator, basePrice, minUnit);
  const roundExtraDays = +(bdBill.qty - bdBill.rawQty).toFixed(2);
  const billableTotal = isQtyCalc ? bd.total + roundExtraDays * basePrice : bdBill.total;
  const roundExtra = billableTotal - bd.total;
  const rounds = roundExtraDays > 0 && roundExtra > 0.5;
  const totalShown = rounds ? billableTotal : bd.total;
  const partnerOff = partnerId ? partnerCut(totalShown, partnerMode, partnerValue) : 0;
  const partnerName = partnerData?.partners.find((x) => x.id === partnerId)?.name ?? "Partner";

  // What the same line would cost at list price: the tier's own price, no
  // commitment, no override, no discounts. The difference is what the deal saves.
  const listBase = tierRaw ?? rolePrice ?? basePrice;
  const listBd = lineBreakdown({ ...draft, price: listBase, calc_values: withoutPriceOverrides(values), calc_discounts: {}, increments: line.recurring ? inc : null }, calculator, listBase, minUnit);
  const listTotal = isQtyCalc ? listBd.total + roundExtraDays * listBase : listBd.total;
  const saving = Math.max(0, listTotal - totalShown);
  const savingPct = listTotal > 0 ? (saving / listTotal) * 100 : 0;

  const perYear = line.recurring && line.period === "monthly" ? 12 : 1;
  const perSuffix = line.recurring ? (line.period === "monthly" ? "/mo" : "/yr") : "";
  const multiYear = !!line.recurring && years > 1;
  const yearsArr = line.recurring ? bd.years : [];

  const apply = () => {
    const vals: Record<string, number> = { ...values };
    if (tierId && months && dur) vals[MONTHS_KEY] = months; else delete vals[MONTHS_KEY];
    onApply({
      // `price` stays the pre-discount base (after the commitment). Discounts live
      // per row so the receipt can show where each one was applied.
      price: basePrice,
      quantity,
      term_years: years,
      tier_id: tierId || null,
      role_id: roleId || null,
      calc_values: vals,
      calc_discounts: discounts,
      calc_rates: rates,
      discount_mode: "none",
      discount_value: 0,
      ...(line.recurring ? { increments: hasIncrements(inc) ? inc : null } : {}),
      ...(partnerItem ? { partner_id: partnerId || null, partner_mode: partnerId ? partnerMode : null, partner_value: partnerId ? partnerValue : null } : {}),
    });
    onClose();
  };

  /* ------------------------------------------------ focus → centre the field */
  const centerField = useCallback((e: FocusEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
    if ((t as HTMLInputElement).type === "range") return;
    const pane = e.currentTarget;
    const pr = pane.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const off = (r.top + r.height / 2) - (pr.top + pr.height / 2);
    if (Math.abs(off) < pr.height * 0.16) return;
    pane.scrollBy({ top: off, behavior: "smooth" });
  }, []);

  /* --------------------------------------------------------------- the guide */
  const guideSteps: GuideStep[] = [
    { sel: ".lcx-calc", title: "Two panels", text: "On the left you set the deal, on the right you see the result. Every section folds: closed, it shows a one-line summary." },
    { sel: ".lcx-z-tier", title: isService ? "Rate" : "Tier & price", text: isService ? "Pick the role's rate, or type a custom one. You can change the price for this deal; the rate stays linked." : "Pick the edition. Its catalogue price is the starting point: type over it to change it for this deal (the tier is kept), or add a discount." },
    { sel: ".lcx-z-commit", title: "Commitment", text: "Longer contracts get the tier's commitment discount, straight from the catalogue. It's applied to the tier price before anything else." },
    { sel: ".lcx-z-calc", title: isQtyCalc ? `Estimate the ${unitWord}` : "Calculator inputs", text: isQtyCalc ? `Answer the questions and the ${unitWord} work themselves out. Open a row (the arrow) to set its own rate or ${unitWord}.` : "Type the numbers or use − / +. Open a row with its arrow for the slider and a discount on that row." },
    { sel: ".lcx-z-term", title: line.recurring ? "Term & yearly increase" : "Quantity", text: line.recurring ? "How many years the client signs for, and how the price goes up each year: a %, a fixed amount, or each year by hand." : "How many units are sold. With a duration calculator this comes from the answers above." },
    { sel: ".lcx-z-partner", title: "Partner", text: "If a partner brings the deal, pick them: their usual cut is filled in, and you see what's left for us." },
    { sel: ".lcx-viz", title: "Live result", text: "Everything updates as you go: how the price is built, every contract year, the list price vs this deal and the total. Apply saves it to the line." },
  ];
  const [guideBox, setGuideBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const liveSteps = guide == null ? [] : guideSteps.filter((s) => rootRef.current?.querySelector(s.sel));
  const gStep = guide != null ? liveSteps[Math.min(guide, liveSteps.length - 1)] : undefined;
  useLayoutEffect(() => {
    if (!gStep || !rootRef.current) { setGuideBox(null); return; }
    const el = rootRef.current.querySelector(gStep.sel) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    let raf = 0; let n = 0;
    const measure = () => {
      const root = rootRef.current; if (!root) return;
      const rr = root.getBoundingClientRect(); const r = el.getBoundingClientRect();
      setGuideBox({ x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height });
      if (++n < 40) raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide, gStep?.sel]);
  useEffect(() => {
    if (guide == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); setGuide((g) => (g == null ? g : g + 1 >= liveSteps.length ? null : g + 1)); }
      if (e.key === "ArrowLeft") { e.preventDefault(); setGuide((g) => (g == null ? g : Math.max(0, g - 1))); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [guide, liveSteps.length]);

  /* --------------------------------------------------------- the left side */
  const vars = calculator?.variables ?? [];
  const rowColor = (key: string) => {
    if (key === BASE_KEY) return "#a7f3d0";
    const i = vars.findIndex((v) => (v.id ?? String(v.sort)) === key);
    return SEG_COLORS[(i < 0 ? 0 : i) % SEG_COLORS.length];
  };
  const maxTier = Math.max(1, ...(tiers ?? []).map((t) => Number(t.price) || 0));

  const varRow = (v: CalcVariable) => {
    const k = v.id ?? String(v.sort);
    const val = values[k] ?? (Number(v.default_value) || 0);
    const rowAmount = bd.rows.find((r) => r.key === k)?.amount ?? 0;
    const rowNet = bd.rows.find((r) => r.key === k)?.net ?? rowAmount;
    const out = qtyBd ? (qtyBd.rows.find((r) => r.key === k)?.amount ?? 0) : null;
    const counts = !!val || v.var_type === "percent";
    const ownRole = v.role_id ? (roleName ? roleName(v.role_id) : "Own role") : v.is_supervision ? "Supervision" : "";
    const dk = `${k}@days`;
    const setVal = (n: number) => setValues((x) => ({ ...x, [k]: n }));
    const max = sliderMax(v, val);
    const numeric = v.var_type === "per_unit" || v.var_type === "per_block";
    const hasDisc = (discounts[k]?.mode ?? "none") !== "none";
    const isOpen = openRow === k;
    // the input's price, changeable here when the catalogue allows it
    const editable = !!v.price_editable;
    const pk = `${k}${PRICE_SUFFIX}`;
    const listAmt = Number(v.amount) || 0;
    const amtNow = varAmount(v, values, k);
    const customPrice = editable && values[pk] != null && Math.abs(Number(values[pk]) - listAmt) > 0.0001;
    const vNow = customPrice ? { ...v, amount: amtNow } : v;
    const uWord = v.unit_label || "units";
    const priceLabel = v.var_type === "percent" ? (isQtyCalc ? "% of the base time" : "% of the base price")
      : isQtyCalc ? (v.var_type === "per_block" ? `${unitWord} per block` : v.var_type === "fixed" ? unitWord[0].toUpperCase() + unitWord.slice(1) : `${unitWord[0].toUpperCase() + unitWord.slice(1)} per ${singular(uWord)}`)
      : v.var_type === "per_block" ? "Price per block" : v.var_type === "fixed" ? "Price" : `Price per ${singular(uWord)}`;
    const priceUnit = v.var_type === "percent" ? "%" : isQtyCalc ? unitWord : v.var_type === "per_block" ? "/ block" : v.var_type === "fixed" ? "" : `/ ${singular(uWord)}`;
    const setPrice = (n: number) => setValues((x) => ({ ...x, [pk]: Math.max(0, n) }));
    const listPriceText = v.var_type === "percent" ? `${listAmt}%` : isQtyCalc ? `${listAmt} ${unitWord}` : money(listAmt);
    const canOpen = numeric || counts || hasDisc || !!qtyCalc || editable;
    return (
      <div key={k} className={`lcx-in ${counts ? "is-on" : ""} ${hot === k ? "is-hot" : ""} ${isOpen ? "is-open" : ""}`} style={{ ["--c" as any]: rowColor(k) }}
        onMouseEnter={() => setHot(k)} onMouseLeave={() => setHot(null)}>
        <div className="lcx-in-top">
          <button type="button" className="lcx-in-name" onClick={() => canOpen && setOpenRow(isOpen ? null : k)} aria-expanded={isOpen} title={ruleOf(vNow, isQtyCalc, unitWord, money)}>
            <span className="lcx-in-dot" aria-hidden="true" />
            <span className="lcx-in-txt">
              <b>{v.name || "Input"}</b>
              <small>
                {ruleOf(vNow, isQtyCalc, unitWord, money)}
                {customPrice ? <em className="lcx-in-deal" title={`List: ${listPriceText}`}>deal price</em>
                  : editable ? <em className="lcx-in-editable" title="You can change this price for this deal">editable</em> : null}
              </small>
            </span>
          </button>
          <span className={`lcx-in-amt ${rowAmount > 0 || (out ?? 0) > 0 ? "" : "is-zero"}`}>
            <span className="lcx-in-amt-v">{out != null ? `${+out.toFixed(2)} ${unitWord}` : rowAmount > 0 ? <>+{money(rowNet)}{perSuffix && <em>{perSuffix}</em>}</> : null}</span>
            {hasDisc && rowAmount > rowNet + 0.004 && <i className="lcx-in-off">−{money(rowAmount - rowNet)}</i>}
          </span>
          {v.var_type === "fixed" ? (
            <button type="button" role="switch" aria-checked={!!val} className={`lcx-sw ${val ? "is-on" : ""}`} onClick={() => setVal(val ? 0 : 1)} aria-label={v.name}>
              <i />
            </button>
          ) : v.var_type === "percent" ? (
            <span className="lcx-in-pct">+{amtNow}%</span>
          ) : (
            <Step value={val} onChange={setVal} suffix={plural(v.unit_label || "")} label={v.name} />
          )}
          {canOpen ? (
            <button type="button" className="lcx-in-more" onClick={() => setOpenRow(isOpen ? null : k)} aria-label={isOpen ? "Less" : "More options"} aria-expanded={isOpen}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
            </button>
          ) : <span className="lcx-in-more is-blank" />}
        </div>
        <div className="lcx-in-x"><div className="lcx-in-xin">
          {numeric && (
            <div className="lcx-slide">
              <input type="range" min={0} max={max} step={1} value={Math.min(val, max)} aria-label={`${v.name} slider`} tabIndex={isOpen ? 0 : -1}
                style={{ ["--p" as any]: `${Math.min(100, (val / max) * 100)}%` }}
                onChange={(e) => setVal(Number(e.target.value) || 0)} />
              {Number(v.included) > 0 && (
                <span className="lcx-slide-inc" style={{ ["--p" as any]: `${Math.min(100, ((Number(v.included) || 0) / max) * 100)}%` }} title={`${v.included} included`}>
                  <i />{v.included} incl.
                </span>
              )}
            </div>
          )}
          {editable && (
            <div className={`lcx-vp ${customPrice ? "is-custom" : ""}`}>
              <span className="lcx-vp-k">{priceLabel}<small>for this deal</small></span>
              <label className="lcx-vp-in">
                {!isQtyCalc && v.var_type !== "percent" && <i>€</i>}
                <input type="number" min="0" step={v.var_type === "percent" ? 0.5 : isQtyCalc ? 0.25 : 1} value={+amtNow.toFixed(2)} tabIndex={isOpen ? 0 : -1}
                  onFocus={(e) => e.target.select()} onChange={(e) => setPrice(parseFloat(e.target.value) || 0)} aria-label={`${v.name} — ${priceLabel}`} />
                {priceUnit && <em>{priceUnit}</em>}
              </label>
              {customPrice ? (
                <button type="button" className="lcx-chipbtn" tabIndex={isOpen ? 0 : -1} title="Back to the catalogue price"
                  onClick={() => setValues((x) => { const y = { ...x }; delete y[pk]; return y; })}>List {listPriceText}</button>
              ) : <span className="lcx-vp-list">catalogue price</span>}
            </div>
          )}
          <div className="lcx-in-sub">
            {out != null && qtyCalc && ownRole && (
              <span className="lcx-own">
                <Step size="sm" value={values[dk] ?? out} onChange={(n) => setValues((x) => ({ ...x, [dk]: n }))} suffix={unitWord} label={`${v.name} ${unitWord}`} />
                {values[dk] != null && (
                  <button type="button" className="lcx-chipbtn" title="Back to the calculated time"
                    onClick={() => setValues((x) => { const y = { ...x }; delete y[dk]; return y; })}>Auto</button>
                )}
              </span>
            )}
            {qtyCalc && <RateControl rkey={k} rates={rates} baseRate={v.rate != null && (v.rate as any) !== "" ? Number(v.rate) : v.role_rate != null ? Number(v.role_rate) : basePrice} setRate={setRate} unit={unit ?? "day"} />}
            {ownRole && <span className="lcx-role" title="This time is billed as this role">{ownRole}</span>}
            <span className="lcx-gap" />
            {(counts || hasDisc) && rowAmount > 0 && <DiscountControl dkey={k} amount={rowAmount} discounts={discounts} setDisc={setDisc} money={money} />}
          </div>
        </div></div>
      </div>
    );
  };

  const I = {
    tier: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5z" /><path d="m3 13 9 5 9-5" /></svg>,
    rate: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
    commit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M16 3v4M8 3v4M3 10h18" /></svg>,
    calc: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="3" width="14" height="18" rx="3" /><path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" /></svg>,
    term: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>,
    qty: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M4 12h16M4 17h10" /></svg>,
    partner: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" /></svg>,
  };

  const pickTier = (id: string) => {
    setTierId(id);
    setOverride(null);
    // keep the commitment only if the new tier offers the same one
    if (!(tierOf(id)?.durations ?? []).some((d) => Number(d.months) === months)) setMonths(0);
  };

  /* ------------------------------------------------------- the right side */
  // How one period's price is built: every row's net, then what the discounts took off.
  const segs = bd.rows.filter((r) => r.amount > 0.004).map((r) => ({ key: r.key, label: r.key === BASE_KEY ? (tier ? `${tier.name || "Tier"} price` : isService ? "Base rate" : "Base price") : r.label, detail: r.key === BASE_KEY ? (dur ? `${dur.months}-month commitment · −${dur.discount_pct}%` : override != null ? "changed for this deal" : "") : r.detail === "once" ? "add-on, included" : r.detail, net: r.net, amount: r.amount, discount: r.discount }));
  const unitGross = Math.max(0.0001, segs.reduce((a, s) => a + s.amount, 0));
  const unitDisc = segs.reduce((a, s) => a + s.discount, 0);
  const maxYear = Math.max(1, ...yearsArr);
  const heroLabel = line.recurring ? (multiYear ? "First year" : perYear === 12 ? "Per year · 12 months" : "Per year") : isQtyCalc ? "Line total" : quantity !== 1 ? "Line total" : "Price";
  const heroValue = line.recurring ? (yearsArr[0] ?? bd.unitPrice * perYear) : totalShown;

  /* ---------------------------------------------- one-line section summaries */
  const baseD = discounts[BASE_KEY];
  const baseDTxt = baseD && baseD.mode !== "none" && Number(baseD.value) ? ` · −${baseD.mode === "percent" ? `${baseD.value}%` : money(Number(baseD.value))}` : "";
  const sumTier = isService
    ? `${roleId ? (roleName ? roleName(roleId) : "Rate") : "Custom rate"} · ${money(basePrice)}/${unit ?? "day"}${baseDTxt}`
    : `${tier ? tier.name || "Tier" : "Custom price"} · ${money(basePrice)}${perSuffix}${baseDTxt}`;
  const sumCommit = dur ? `${dur.months} months · −${dur.discount_pct}%` : "Standard · no commitment";
  const addOns = bd.rows.filter((r) => r.key !== BASE_KEY).reduce((a, r) => a + (r.net ?? r.amount), 0);
  const varBits = vars.map((v) => {
    const k = v.id ?? String(v.sort); const val = values[k] ?? (Number(v.default_value) || 0);
    if (v.var_type === "fixed") return val ? v.name : "";
    if (v.var_type === "percent") return "";
    return val ? `${v.name} ${val}` : "";
  }).filter(Boolean);
  const sumCalc = isQtyCalc
    ? `${+quantity.toFixed(2)} ${unitWord}${varBits.length ? ` · ${varBits.slice(0, 2).join(" · ")}` : ""}`
    : varBits.length ? `${varBits.slice(0, 2).join(" · ")}${varBits.length > 2 ? ` +${varBits.length - 2}` : ""} · +${money(addOns)}${perSuffix}` : "Nothing added";
  const incTxt = hasIncrements(inc) ? (inc.mode === "pct" ? `+${Number(inc.value) || 0}%/yr` : inc.mode === "fixed" ? `+${money(Number(inc.value) || 0)}/yr` : "set per year") : "flat";
  const sumTerm = line.recurring ? `${years} ${years === 1 ? "year" : "years"}${years > 1 ? ` · ${incTxt}` : ""}` : `${+quantity.toFixed(2)} ${isService ? unitWord : "units"}`;
  const sumPartner = partnerId ? `${partnerName} · ${partnerMode === "percent" ? `${partnerValue}%` : money(partnerValue)}` : "No partner";

  // The guide opens the section it points at.
  const zoneOf: Record<string, string> = { ".lcx-z-tier": "tier", ".lcx-z-commit": "commit", ".lcx-z-calc": "calc", ".lcx-z-term": "term", ".lcx-z-partner": "partner" };
  useEffect(() => {
    const z = gStep ? zoneOf[gStep.sel] : undefined;
    if (z) setOpenZ((x) => (x[z] ? x : { ...x, [z]: true }));
    if (gStep?.sel === ".lcx-viz") setSheet(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gStep?.sel]);

  const yearsNote = multiYear ? (hasIncrements(inc) ? (inc.mode === "pct" ? `+${Number(inc.value) || 0}% a year` : inc.mode === "fixed" ? `+${money(Number(inc.value) || 0)} a year` : "set year by year") : "flat") : perYear === 12 ? "12 months" : "one year";

  return createPortal(
    <div className="lcx-backdrop" onMouseDown={() => (guide == null ? onClose() : setGuide(null))}>
      <div ref={rootRef} className={`lcx ${sheet ? "is-sheet" : ""}`} role="dialog" aria-modal="true" aria-label={`Calculator for ${title}`}>
        {/* ============================================ panel 1 · the calculator */}
        <section className="lcx-calc" onMouseDown={(e) => e.stopPropagation()}>
          <header className="lcx-head">
            <span className="lcx-head-ic" aria-hidden="true">{isService ? I.rate : I.calc}</span>
            <div className="lcx-head-txt">
              <span className="lcx-eyebrow">Deal calculator · {isService ? "Service" : "Product"}</span>
              <h3 className="lcx-title" title={title}>{title}</h3>
            </div>
            <span className="lcx-head-gap" />
            <button type="button" className="lcx-how" onClick={() => setGuide(0)}>
              <i aria-hidden="true">i</i>How it works
            </button>
            <button type="button" className="lcx-x" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>

          <div className="lcx-main" onFocusCapture={centerField}>
            {/* 1 · Tier & price / Rate */}
            <Zone cls="lcx-z-tier" accent={isService ? "#3b82f6" : "#10a36d"} icon={isService ? I.rate : I.tier}
              title={isService ? "Rate" : tiers?.length ? "Tier & price" : "Price"}
              sub={isService ? `What one ${unit ?? "day"} is billed at` : tiers?.length ? "The edition sold and its price on this deal" : "The price of one unit"}
              summary={sumTier} open={!!openZ.tier} onToggle={() => toggleZ("tier")}>
              {tiers && tiers.length > 0 && (
                <div className="lcx-tiers">
                  {tiers.map((t, i) => {
                    const on = tierId === t.id;
                    const nd = (t.durations ?? []).length;
                    return (
                      <button type="button" key={t.id ?? t.name ?? i} className={`lcx-tier ${on ? "is-on" : ""}`} onClick={() => pickTier(t.id ?? "")} title={t.name}
                        style={{ ["--w" as any]: `${Math.max(6, ((Number(t.price) || 0) / maxTier) * 100)}%` }}>
                        <span className="lcx-tier-top"><span className="lcx-tier-radio" aria-hidden="true" /><b>{t.name || "Unnamed"}</b></span>
                        <span className="lcx-tier-p">{money(Number(t.price) || 0)}<em>{perSuffix}</em></span>
                        {line.recurring && nd > 0 && <small>{nd} commitment option{nd === 1 ? "" : "s"}</small>}
                      </button>
                    );
                  })}
                  <button type="button" className={`lcx-tier is-custom ${tierId === "" ? "is-on" : ""}`}
                    onClick={() => { if (listPrice != null) setManualPrice(basePrice); setTierId(""); setOverride(null); setMonths(0); }}>
                    <span className="lcx-tier-top"><span className="lcx-tier-radio" aria-hidden="true" /><b>Custom</b></span>
                    <span className="lcx-tier-p is-muted">Type a price</span>
                  </button>
                </div>
              )}
              {roles && roles.length > 0 && (
                <div className="lcx-tiers">
                  {roles.map((r, i) => (
                    <button type="button" key={r.role_id} className={`lcx-tier ${roleId === r.role_id ? "is-on" : ""}`} onClick={() => { setRoleId(r.role_id); setOverride(null); }}>
                      <span className="lcx-tier-top"><span className="lcx-tier-radio" aria-hidden="true" /><b>{roleName ? roleName(r.role_id) : `Rate ${i + 1}`}</b></span>
                      <span className="lcx-tier-p">{money(r.price)}<em>/{unit ?? "day"}</em></span>
                    </button>
                  ))}
                  <button type="button" className={`lcx-tier is-custom ${roleId === "" ? "is-on" : ""}`}
                    onClick={() => { if (listPrice != null) setManualPrice(basePrice); setRoleId(""); setOverride(null); }}>
                    <span className="lcx-tier-top"><span className="lcx-tier-radio" aria-hidden="true" /><b>Custom</b></span>
                    <span className="lcx-tier-p is-muted">Type a rate</span>
                  </button>
                </div>
              )}
              <div className="lcx-price">
                <div className="lcx-price-row">
                  <div className="lcx-price-k">
                    <span className="lcx-k">{isService ? `Rate per ${unit ?? "day"} on this deal` : "Price on this deal"}</span>
                    {listPrice != null && (override != null ? (
                      <p className="lcx-note is-warn">
                        {tierPrice != null ? (dur ? "Tier after commitment" : "Tier") : "Rate"}: {money(listPrice)} ·{" "}
                        <button type="button" className="lcx-link" onClick={() => setOverride(null)}>Use it</button>
                      </p>
                    ) : (
                      <p className="lcx-note">From the {tierPrice != null ? "tier" : "rate"}{dur ? `, −${dur.discount_pct}% for ${dur.months} months` : ""}. Type to change it.</p>
                    ))}
                  </div>
                  <DiscountControl dkey={BASE_KEY} amount={qtyCalc ? (bd.rows.find((r) => r.key === BASE_KEY)?.amount ?? 0) : basePrice} discounts={discounts} setDisc={setDisc} money={money} />
                  <label className={`lcx-money ${listPrice != null && override != null ? "is-changed" : ""}`}>
                    <span>€</span>
                    <input type="number" min="0" value={+basePrice.toFixed(2)} onFocus={(e) => e.target.select()} aria-label="Price"
                      onChange={(e) => { const v = parseFloat(e.target.value) || 0; if (listPrice != null) setOverride(Math.abs(v - listPrice) > 0.005 ? v : null); else setManualPrice(v); }} />
                    <em>{isService ? `/${unit ?? "day"}` : perSuffix}</em>
                  </label>
                </div>
              </div>
            </Zone>

            {/* 2 · Commitment */}
            {durs.length > 0 && (
              <Zone cls="lcx-z-commit" accent="#3b82f6" icon={I.commit} title="Commitment" sub="Longer contracts get the tier's catalogue discount"
                summary={sumCommit} open={!!openZ.commit} onToggle={() => toggleZ("commit")}>
                <div className="lcx-commits">
                  <button type="button" className={`lcx-commit ${!dur ? "is-on" : ""}`} onClick={() => { setMonths(0); setOverride(null); }}>
                    <b>Standard</b><span>{money(tierRaw ?? 0)}{perSuffix}</span><small>No commitment</small>
                  </button>
                  {durs.map((d) => {
                    const on = dur?.months === d.months;
                    const final = (tierRaw ?? 0) * (1 - (Number(d.discount_pct) || 0) / 100);
                    return (
                      <button type="button" key={d.months} className={`lcx-commit ${on ? "is-on" : ""}`} onClick={() => { setMonths(Number(d.months)); setOverride(null); }}>
                        <b>{d.months} months</b><span>{money(final)}{perSuffix}</span>
                        <small className="is-save">−{d.discount_pct}% · saves {money((tierRaw ?? 0) - final)}</small>
                      </button>
                    );
                  })}
                </div>
              </Zone>
            )}

            {/* 3 · Calculator */}
            {vars.length > 0 && (
              <Zone cls="lcx-z-calc" accent="#7c5cff" icon={I.calc}
                title={isQtyCalc ? `Estimate the ${unitWord}` : "Calculator"}
                sub={isQtyCalc ? `Answer the questions; the ${unitWord} add up on their own` : priceCalc?.include_base === false ? "The price is built only from these inputs" : "Added on top of the price"}
                summary={sumCalc} open={!!openZ.calc} onToggle={() => toggleZ("calc")}>
                <div className="lcx-ins">{vars.map(varRow)}</div>
              </Zone>
            )}

            {/* 4 · Term & increase / Quantity */}
            <Zone cls="lcx-z-term" accent="#e08a1e" icon={line.recurring ? I.term : I.qty}
              title={line.recurring ? "Term & yearly increase" : isService ? `How many ${unitWord}` : "Quantity"}
              sub={line.recurring ? "How long the client signs for and how the price moves" : qtyBd ? "Set by the calculator above" : "How many are sold"}
              summary={sumTerm} open={!!openZ.term} onToggle={() => toggleZ("term")}>
              <div className="lcx-term">
                {line.recurring ? (
                  <>
                    <div className="lcx-term-row">
                      <span className="lcx-k">Contract term</span>
                      <div className="lcx-yquick">
                        {[1, 2, 3, 5].map((n) => (
                          <button type="button" key={n} className={years === n ? "is-on" : ""} onClick={() => setYears(n)}>{n} yr</button>
                        ))}
                      </div>
                      <Step value={years} onChange={(n) => setYears(Math.max(1, n))} min={1} max={20} step={1} suffix={years === 1 ? "year" : "years"} label="Years" />
                    </div>
                    <div className="lcx-term-inc">
                      <span className="lcx-k">Yearly increase</span>
                      <IncrementsEditor value={inc} onChange={setInc} firstYear={bd.unitPrice * perYear} years={years} money={money} />
                    </div>
                  </>
                ) : (
                  <div className="lcx-term-row">
                    <span className="lcx-k">{isService ? `${unitWord[0].toUpperCase()}${unitWord.slice(1)}` : "Units"}</span>
                    <span className="lcx-gap" />
                    {rounds && <span className="lcx-badge" title={`Billable minimum in steps of ${minUnit}`}>Billed as {bdBill.qty} {isService ? unitWord : "units"}</span>}
                    <Step value={+quantity.toFixed(2)} onChange={setQty} step={1} disabled={!!qtyBd} suffix={isService ? unitWord : "units"} label="Quantity" />
                  </div>
                )}
              </div>
            </Zone>

            {/* 5 · Partner */}
            {partnerItem && (
              <Zone cls="lcx-z-partner" accent="#d9468f" icon={I.partner} title="Partner" sub="A partner's cut, if one brought the deal"
                summary={sumPartner} open={!!openZ.partner} onToggle={() => toggleZ("partner")}>
                <div className="lcx-partner">
                  <div className="lcx-pt-pick">
                    <Select value={partnerId} onChange={pickPartner} aria-label="Partner" placeholder="No partner"
                      options={[
                        { value: "", label: "No partner" },
                        ...(partnerData?.partners ?? []).map((pt) => ({ value: pt.id, label: pt.name })),
                        ...(partnerId && partnerData && !partnerData.partners.some((x) => x.id === partnerId) ? [{ value: partnerId, label: "Partner (no longer tagged)" }] : []),
                      ]} />
                  </div>
                  {partnerId && (
                    <>
                      <div className="lcx-seg">
                        <button type="button" className={partnerMode === "percent" ? "is-on" : ""} onClick={() => setPartnerMode("percent")}>%</button>
                        <button type="button" className={partnerMode === "amount" ? "is-on" : ""} onClick={() => setPartnerMode("amount")}>{"€"}</button>
                      </div>
                      <label className="lcx-money is-sm">
                        <input type="number" min="0" value={partnerValue} onFocus={(e) => e.target.select()}
                          onChange={(e) => setPartnerValue(parseFloat(e.target.value) || 0)} aria-label="Partner cut" />
                        <em>{partnerMode === "percent" ? "%" : "€"}</em>
                      </label>
                      <span className="lcx-pt-off">−{money(partnerOff)}</span>
                      <button type="button" className="lcx-pt-remove" onClick={() => { setPartnerId(""); setPartnerValue(0); }} title="Remove the partner from this line">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        Remove
                      </button>
                    </>
                  )}
                </div>
                {partnerData && partnerData.partners.length === 0 && !partnerId && (
                  <p className="lcx-note">No partners yet: in Settings › Companies page, switch a company type on as a partner type and give it to the company.</p>
                )}
                {!partnerId && partnerItem?.broughtBy && partnerData?.partners.some((x) => x.id === partnerItem.broughtBy) && (
                  <p className="lcx-note">
                    {partnerData.partners.find((x) => x.id === partnerItem.broughtBy)?.name} brought this company ·{" "}
                    <button type="button" className="lcx-link" onClick={() => pickPartner(partnerItem.broughtBy!)}>Add them as the partner</button>
                  </p>
                )}
                {partnerDef && (partnerDef.mode !== partnerMode || partnerDef.value !== partnerValue) && (
                  <p className="lcx-note">
                    Default for this partner: {partnerDef.mode === "percent" ? `${partnerDef.value}%` : money(partnerDef.value)} ·{" "}
                    <button type="button" className="lcx-link" onClick={() => { setPartnerMode(partnerDef.mode); setPartnerValue(partnerDef.value); }}>Use it</button>
                  </p>
                )}
              </Zone>
            )}
          </div>
        </section>

        {/* ============================================ panel 2 · the live result */}
        <aside className="lcx-viz" onMouseDown={(e) => e.stopPropagation()}>
          <div className="lcx-viz-head">
            <span className="lcx-live"><i />Live result</span>
            <button type="button" className="lcx-sheet-tog" onClick={() => setSheet((x) => !x)} aria-label={sheet ? "Hide details" : "Show details"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 15 6-6 6 6" /></svg>
            </button>
            <button type="button" className="lcx-side-info" onClick={() => setGuide(Math.max(0, guideSteps.length - 1))} aria-label="About the result">i</button>
          </div>

          <div className="lcx-hero">
            <span className="lcx-hero-k">{heroLabel}</span>
            <b className="lcx-hero-v"><Tween value={heroValue} fmt={money} /></b>
            <div className="lcx-hero-chips">
              {multiYear && <span className="lcx-chip">{years} yrs <b><Tween value={totalShown} fmt={money} /></b></span>}
              {!line.recurring && quantity !== 1 && !isQtyCalc && <span className="lcx-chip">{money(bd.unitPrice)} × {bdBill.qty}</span>}
              {isQtyCalc && <span className="lcx-chip">{+bdBill.qty.toFixed(2)} {unitWord}</span>}
              {saving > 0.5 && <span className="lcx-chip is-save">−{money(saving)} · {savingPct.toFixed(savingPct < 10 ? 1 : 0)}%</span>}
            </div>
          </div>

          <div className="lcx-viz-scroll" onFocusCapture={centerField}>
            {/* how one period's price is built */}
            <div className="lcx-card">
              <div className="lcx-card-h"><b>How it's built</b><small>{line.recurring ? (perYear === 12 ? "per month" : "per year") : isQtyCalc ? "whole line" : "per unit"}</small></div>
              <div className="lcx-stack" aria-hidden="true">
                {segs.map((s) => (
                  <span key={s.key} className={`lcx-stack-s ${hot === s.key ? "is-hot" : ""}`} style={{ ["--c" as any]: rowColor(s.key), flexGrow: Math.max(0.0001, s.net) / unitGross }} title={`${s.label} ${money(s.net)}`} />
                ))}
                {unitDisc > 0.004 && <span className="lcx-stack-s is-disc" style={{ flexGrow: unitDisc / unitGross }} title={`Discounts −${money(unitDisc)}`} />}
              </div>
              <div className="lcx-legend">
                {segs.map((s) => (
                  <div key={s.key} className={`lcx-lg ${hot === s.key ? "is-hot" : ""}`} style={{ ["--c" as any]: rowColor(s.key) }}
                    onMouseEnter={() => s.key !== BASE_KEY && setHot(s.key)} onMouseLeave={() => setHot(null)} title={s.detail || undefined}>
                    <i aria-hidden="true" />
                    <span>{s.label}</span>
                    <em>{money(s.net)}{s.discount > 0.004 && <small>−{money(s.discount)}</small>}</em>
                  </div>
                ))}
                {segs.length === 0 && <p className="lcx-empty">Pick a tier or type a price to start.</p>}
              </div>
            </div>

            {/* every contract year */}
            {multiYear && yearsArr.length > 1 && (
              <div className="lcx-card">
                <div className="lcx-card-h"><b>{multiYear ? "Contract years" : "First year"}</b><small>{yearsNote}</small></div>
                <div className="lcx-years" style={{ ["--n" as any]: yearsArr.length }}>
                  {yearsArr.map((a, i) => {
                    const up = i > 0 && yearsArr[i - 1] ? (a / yearsArr[i - 1] - 1) * 100 : 0;
                    return (
                      <div key={i} className="lcx-yr" style={{ ["--h" as any]: `${Math.max(8, (a / maxYear) * 100)}%`, ["--i" as any]: i }}>
                        <span className="lcx-yr-v">{money(a)}</span>
                        <span className="lcx-yr-col"><i /></span>
                        <span className="lcx-yr-k">Y{i + 1}{i > 0 && Math.abs(up) > 0.05 && <em className={up < 0 ? "is-down" : ""}>{up > 0 ? "+" : ""}{up.toFixed(1)}%</em>}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* list vs this deal */}
            {saving > 0.5 && (
              <div className="lcx-card">
                <div className="lcx-card-h"><b>List vs this deal</b><small>{line.recurring ? (multiYear ? `${years}-year contract` : "first year") : "line total"}</small></div>
                <div className="lcx-vs">
                  <div className="lcx-vs-row"><span>List</span><span className="lcx-vs-bar is-list"><i style={{ width: "100%" }} /></span><b>{money(listTotal)}</b></div>
                  <div className="lcx-vs-row"><span>Deal</span><span className="lcx-vs-bar"><i style={{ width: `${Math.max(3, (totalShown / listTotal) * 100)}%` }} /></span><b>{money(totalShown)}</b></div>
                </div>
              </div>
            )}

            {rounds && (
              <div className="lcx-card is-round">
                <div className="lcx-sub"><span>Rounded up to the billable minimum (+{roundExtraDays} {isService ? unitWord : "units"})</span><b>+{money(roundExtra)}</b></div>
              </div>
            )}

            {/* partner split */}
            {partnerOff > 0 && (
              <div className="lcx-card">
                <div className="lcx-card-h"><b>Partner split</b><small>{partnerName}{partnerMode === "percent" ? ` · ${partnerValue}%` : ""}</small></div>
                <div className="lcx-split" aria-hidden="true">
                  <span className="is-us" style={{ flexGrow: Math.max(0, totalShown - partnerOff) }} />
                  <span className="is-pt" style={{ flexGrow: partnerOff }} />
                </div>
                <div className="lcx-split-k">
                  <span><i className="is-us" />For us <b>{money(totalShown - partnerOff)}</b></span>
                  <span><i className="is-pt" />{partnerName} <b>{money(partnerOff)}</b></span>
                </div>
              </div>
            )}
          </div>

          <div className="lcx-actions">
            <div className="lcx-actions-total">
              <span>{partnerOff > 0 ? "Deal value (for us)" : line.recurring && multiYear ? "Whole contract" : "Line total"}</span>
              <b><Tween value={totalShown - partnerOff} fmt={money} /></b>
            </div>
            <div className="lcx-actions-btns">
              <button type="button" className="lcx-cancel" onClick={onClose}>Cancel</button>
              <button type="button" className="lcx-apply" onClick={apply}>
                Apply to deal
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              </button>
            </div>
          </div>
        </aside>

        {/* the "How it works" guide */}
        {guide != null && gStep && (
          <div className="lcx-guide" onMouseDown={(e) => { e.stopPropagation(); setGuide(null); }}>
            {guideBox && (
              <span className="lcx-spot" style={{ left: guideBox.x - 8, top: guideBox.y - 8, width: guideBox.w + 16, height: guideBox.h + 16 }} />
            )}
            {guideBox && (() => {
              const root = rootRef.current?.getBoundingClientRect();
              const W = root?.width ?? 1200; const H = root?.height ?? 800;
              const cw = 340;
              const right = guideBox.x + guideBox.w + 24;
              const left = guideBox.x - cw - 24;
              const x = right + cw < W - 12 ? right : left > 12 ? left : Math.min(W - cw - 12, Math.max(12, guideBox.x + 16));
              const y = Math.min(H - 220, Math.max(16, guideBox.y + 8));
              const n = liveSteps.length; const at = Math.min(guide, n - 1);
              return (
                <div key={gStep.sel} className="lcx-gcard" style={{ left: x, top: y, width: cw }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={gStep.title}>
                  <span className="lcx-gcard-n"><i>{at + 1}</i> of {n}</span>
                  <button type="button" className="lcx-gcard-x" onClick={() => setGuide(null)} aria-label="Close the guide">×</button>
                  <b>{gStep.title}</b>
                  <p>{gStep.text}</p>
                  <div className="lcx-gcard-f">
                    <span className="lcx-gdots">{liveSteps.map((_, i) => <i key={i} className={i === at ? "is-on" : ""} />)}</span>
                    {at > 0 && <button type="button" className="lcx-gbtn" onClick={() => setGuide(at - 1)}>Back</button>}
                    <button type="button" className="lcx-gbtn is-main" onClick={() => setGuide(at + 1 >= n ? null : at + 1)}>{at + 1 >= n ? "Done" : "Next"}</button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>,
    document.body);
}
