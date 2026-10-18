/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { calcBreakdown, discountOf, BASE_KEY, type Calculator, type CalcDiscount } from "../pages/settings/catalogApi";
import { lineBreakdown, type RevenueLineFields, type TermPatch } from "../pages/sales/sales/salesApi";
import "./LineCalcModal.css";

/** A row's discount: hidden behind "+ Discount" until used, then % or € with the amount it takes off. */
function DiscountControl({ dkey, amount, discounts, setDisc, money }: {
  dkey: string; amount: number;
  discounts: Record<string, CalcDiscount>;
  setDisc: (key: string, patch: Partial<CalcDiscount>) => void;
  money: (n: number) => string;
}) {
  const d = discounts[dkey] ?? { mode: "none" as const, value: 0 };
  const [open, setOpen] = useState(d.mode !== "none");
  const off = discountOf(amount, d);
  if (!open || d.mode === "none") {
    return (
      <button type="button" className="lc-disc-add" onClick={() => { setOpen(true); setDisc(dkey, { mode: "percent" }); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M19 5L5 19M7 7h.01M17 17h.01" /></svg>
        Discount
      </button>
    );
  }
  return (
    <div className="lc-disc">
      <div className="lc-seg lc-seg-xs">
        <button type="button" className={d.mode === "percent" ? "is-on" : ""} onClick={() => setDisc(dkey, { mode: "percent" })}>%</button>
        <button type="button" className={d.mode === "amount" ? "is-on" : ""} onClick={() => setDisc(dkey, { mode: "amount" })}>{"\u20ac"}</button>
      </div>
      <input type="number" min="0" value={d.value} onFocus={(e) => e.target.select()} autoFocus
        onChange={(e) => setDisc(dkey, { value: parseFloat(e.target.value) || 0 })} aria-label="Discount" />
      <span className="lc-disc-off">-{money(off)}</span>
      <button type="button" className="lc-disc-x" onClick={() => { setDisc(dkey, { mode: "none", value: 0 }); setOpen(false); }} aria-label="Remove discount">×</button>
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
    <label className={`lc-rate ${rates[rkey] != null && rates[rkey] !== baseRate ? "is-custom" : ""}`}>
      <input type="number" min="0" value={v} onFocus={(e) => e.target.select()}
        onChange={(e) => setRate(rkey, parseFloat(e.target.value) || 0)} />
      <span>€/{unit}</span>
    </label>
  );
}

/** − value + */
function Stepper({ value, onChange, step = 1, disabled, suffix, wide }: {
  value: number; onChange: (v: number) => void; step?: number; disabled?: boolean; suffix?: string; wide?: boolean;
}) {
  const set = (v: number) => onChange(Math.max(0, +v.toFixed(2)));
  return (
    <div className={`lc-step ${disabled ? "is-disabled" : ""} ${wide ? "is-wide" : ""}`}>
      <button type="button" onClick={() => set(value - step)} disabled={disabled || value <= 0} aria-label="Less">−</button>
      <input type="number" min="0" step={step} value={value} disabled={disabled} onFocus={(e) => e.target.select()}
        onChange={(e) => set(parseFloat(e.target.value) || 0)} />
      {suffix && <em>{suffix}</em>}
      <button type="button" onClick={() => set(value + step)} disabled={disabled} aria-label="More">+</button>
    </div>
  );
}

/**
 * Per-line calculator popup: tier, calculator inputs, term or quantity, and a
 * discount. Everything that decides the value of one revenue line lives here.
 */
export default function LineCalcModal({ title, line, tiers, roles, roleName, calculator, unit, minUnit, onApply, onClose, money, variant }: {
  title: string;
  line: RevenueLineFields;
  tiers?: { id?: string; name: string; price: number }[];
  roles?: { role_id: string; price: number }[];
  roleName?: (id: string) => string;
  calculator?: Calculator | null;
  unit?: "hour" | "day" | null;
  minUnit?: number | null;
  onApply: (patch: TermPatch) => void;
  onClose: () => void;
  money: (n: number) => string;
  variant?: "modern";
}) {
  const [tierId, setTierId] = useState<string>(line.tier_id ?? "");
  const [roleId, setRoleId] = useState<string>(line.role_id ?? "");
  const [values, setValues] = useState<Record<string, number>>(line.calc_values ?? {});
  const [manualPrice, setManualPrice] = useState<number>(Number(line.price) || 0);
  const [qty, setQty] = useState<number>(line.quantity == null ? 1 : Number(line.quantity));
  const [years, setYears] = useState<number>(line.term_years == null ? 1 : Number(line.term_years));
  const [discounts, setDiscounts] = useState<Record<string, CalcDiscount>>(() => {
    const d = { ...(line.calc_discounts ?? {}) };
    // Fold a pre-existing whole-line discount into the base row.
    if (!d[BASE_KEY] && line.discount_mode && line.discount_mode !== "none") {
      d[BASE_KEY] = { mode: line.discount_mode as "percent" | "amount", value: Number(line.discount_value) || 0 };
    }
    return d;
  });
  const setDisc = (key: string, patch: Partial<CalcDiscount>) =>
    setDiscounts((x) => ({ ...x, [key]: { mode: "none", value: 0, ...(x[key] ?? {}), ...patch } }));
  const [rates, setRates] = useState<Record<string, number>>(line.calc_rates ?? {});
  const setRate = (key: string, v: number) => setRates((x) => ({ ...x, [key]: v }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const unitWord = unit === "hour" ? "hours" : "days";
  const isQtyCalc = calculator?.output_kind === "quantity";

  // Base unit price: the chosen tier, the chosen role, or whatever was typed.
  const tierPrice = tiers?.find((t) => t.id === tierId)?.price;
  const rolePrice = roles?.find((r) => r.role_id === roleId)?.price;
  const basePrice = tierPrice ?? rolePrice ?? manualPrice;

  // A price calculator overrides the unit price. A quantity calculator sets
  // how many units instead, leaving the price alone.
  const priceCalc = calculator && !isQtyCalc ? calculator : null;
  const qtyCalc = calculator && isQtyCalc ? calculator : null;
  const priceBd = priceCalc ? calcBreakdown(priceCalc, values, basePrice, discounts) : null;
  const qtyBd = qtyCalc ? calcBreakdown(qtyCalc, values, Number(qtyCalc.base_amount) || 0) : null;
  const quantity = qtyBd ? qtyBd.total : qty;

  const draft: RevenueLineFields = {
    price: basePrice, quantity, recurring: line.recurring, period: line.period,
    term_years: years, calc_values: values, calc_discounts: discounts, calc_rates: rates,
  };
  const bd = lineBreakdown(draft, calculator, basePrice);
  // Rounding the days up to the billable minimum adds (extra days × base rate)
  // on top of the calculated line. For quantity calculators the breakdown total
  // ignores rounding, so we add it explicitly; for the rest, lineBreakdown with
  // minUnit already does it.
  const bdBill = lineBreakdown(draft, calculator, basePrice, minUnit);
  const roundExtraDays = +(bdBill.qty - bdBill.rawQty).toFixed(2);
  const billableTotal = isQtyCalc
    ? bd.total + roundExtraDays * basePrice
    : bdBill.total;
  const roundExtra = billableTotal - bd.total;
  const rounds = roundExtraDays > 0 && roundExtra > 0.5;

  const apply = () => {
    onApply({
      // `price` stays the pre-discount base. Discounts live per row so the
      // receipt can show where each one was applied.
      price: basePrice,
      quantity,
      term_years: years,
      tier_id: tierId || null,
      role_id: roleId || null,
      calc_values: values,
      calc_discounts: discounts,
      calc_rates: rates,
      discount_mode: "none",
      discount_value: 0,
    });
    onClose();
  };

  const vars = calculator?.variables ?? [];
  const kindWord = unit ? "Service" : "Product";
  const discTotal = bd.rows.reduce((a, r) => a + (r.discount || 0), 0);
  const varRow = (v: any) => {
    const k = v.id ?? String(v.sort);
    const val = values[k] ?? (Number(v.default_value) || 0);
    const rowAmount = bd.rows.find((r) => r.key === k)?.amount ?? 0;
    const out = qtyBd ? (qtyBd.rows.find((r) => r.key === k)?.amount ?? 0) : null;
    const showRate = !!qtyCalc;
    const showDisc = !!priceCalc || !!qtyCalc;
    // The supervision row's days can be set by hand (they start from the calculator).
    const dk = `${k}@days`;
    const supDays = qtyCalc && v.is_supervision && (val || v.var_type === "percent") ? (
      <span className="lc-supdays">
        <Stepper value={values[dk] ?? (out ?? 0)} onChange={(n) => setValues((x) => ({ ...x, [dk]: n }))} suffix={unitWord} />
        {values[dk] != null && (
          <button type="button" className="lc-supdays-reset" title="Back to the calculated days"
            onClick={() => setValues((x) => { const y = { ...x }; delete y[dk]; return y; })}>Auto</button>
        )}
      </span>
    ) : null;
    const control = v.var_type === "percent"
      ? <span className="lc-var-fixed">{v.amount}% of base</span>
      : v.var_type === "fixed"
        ? (
          <div className="lc-seg">
            <button type="button" className={val ? "is-on" : ""} onClick={() => setValues((x) => ({ ...x, [k]: 1 }))}>Yes</button>
            <button type="button" className={!val ? "is-on" : ""} onClick={() => setValues((x) => ({ ...x, [k]: 0 }))}>No</button>
          </div>
        )
        : <Stepper value={val} onChange={(n) => setValues((x) => ({ ...x, [k]: n }))} />;
    return (
      <div key={k} className={`lc-var ${val || v.var_type === "percent" ? "is-active" : ""}`}>
        <div className="lc-var-top">
          <span className="lc-var-name">{v.name}{v.unit_label ? <em>{v.unit_label}</em> : null}</span>
          {control}
        </div>
        {/* Rows not in use stay one line; their rate and discount appear once they count. */}
        {(val || v.var_type === "percent" || (discounts[k]?.mode ?? "none") !== "none") && (out != null || showRate || showDisc || (!qtyCalc && rowAmount > 0)) && (
          <div className="lc-var-sub">
            {supDays ?? (out != null && <span className="lc-out">{out} {unitWord}</span>)}
            {out == null && rowAmount > 0 && <span className="lc-out">{money(rowAmount)}</span>}
            {showRate && <RateControl rkey={k} rates={rates} baseRate={v.rate != null && v.rate !== "" ? Number(v.rate) : basePrice} setRate={setRate} unit={unit ?? "day"} />}
            {v.is_supervision && <span className="lc-sup">Supervision</span>}
            <span className="lc-var-gap" />
            {showDisc && <DiscountControl dkey={k} amount={rowAmount} discounts={discounts} setDisc={setDisc} money={money} />}
          </div>
        )}
      </div>
    );
  };
  const choice = (list: { key: string; on: boolean; name: string; sub: string; pick: () => void }[]) => (
    <div className="lc-choices">
      {list.map((c) => (
        <button type="button" key={c.key} className={`lc-choice ${c.on ? "is-on" : ""}`} onClick={c.pick}>
          <span className="lc-choice-dot" aria-hidden="true" />
          <b>{c.name}</b><span>{c.sub}</span>
        </button>
      ))}
    </div>
  );
  const totalShown = rounds ? billableTotal : bd.total;

  return createPortal(
    <div className="lc-backdrop" onMouseDown={onClose}>
      <div className={`lc ${variant === "modern" ? "is-modern" : ""}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Calculator for ${title}`}>
        <header className="lc-head">
          <span className="lc-head-glow" aria-hidden="true" />
          <div className="lc-head-txt">
            <span className="lc-eyebrow">Line calculator · {kindWord}</span>
            <h3 className="lc-title">{title}</h3>
          </div>
          <button type="button" className="lc-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="lc-main">
          <div className="lc-form">
            {tiers && tiers.length > 0 && (
              <section className="lc-sec">
                <h4 className="lc-sec-t"><i>1</i>Tier</h4>
                {choice([
                  ...tiers.map((t) => ({ key: t.id ?? t.name, on: tierId === t.id, name: t.name || "Unnamed", sub: money(t.price), pick: () => setTierId(t.id ?? "") })),
                  { key: "__custom", on: tierId === "", name: "Custom", sub: "Type a price", pick: () => setTierId("") },
                ])}
              </section>
            )}

            {roles && roles.length > 0 && (
              <section className="lc-sec">
                <h4 className="lc-sec-t"><i>1</i>Rate</h4>
                {choice([
                  ...roles.map((r, i) => ({ key: r.role_id, on: roleId === r.role_id, name: roleName ? roleName(r.role_id) : `Rate ${i + 1}`, sub: `${money(r.price)}/${unit ?? "day"}`, pick: () => setRoleId(r.role_id) })),
                  { key: "__custom", on: roleId === "", name: "Custom", sub: "Type a rate", pick: () => setRoleId("") },
                ])}
              </section>
            )}

            <section className="lc-sec">
              <h4 className="lc-sec-t"><i>{(tiers?.length || roles?.length) ? 2 : 1}</i>{unit ? `Rate per ${unit}` : "Base price"}</h4>
              <div className="lc-price">
                <label className={`lc-money ${tierPrice != null || rolePrice != null ? "is-locked" : ""}`}>
                  <input type="number" min="0" value={tierPrice ?? rolePrice ?? manualPrice}
                    disabled={tierPrice != null || rolePrice != null} onFocus={(e) => e.target.select()}
                    onChange={(e) => setManualPrice(parseFloat(e.target.value) || 0)} />
                  <em>€{unit ? ` / ${unit}` : ""}</em>
                </label>
                {(tierPrice != null || rolePrice != null) && <span className="lc-hint">From the {tierPrice != null ? "tier" : "rate"} — pick Custom to type your own</span>}
                <span className="lc-var-gap" />
                {qtyCalc
                  ? <DiscountControl dkey={BASE_KEY} amount={bd.rows.find((r) => r.key === BASE_KEY)?.amount ?? 0} discounts={discounts} setDisc={setDisc} money={money} />
                  : <DiscountControl dkey={BASE_KEY} amount={basePrice} discounts={discounts} setDisc={setDisc} money={money} />}
              </div>
            </section>

            {vars.length > 0 && (
              <section className="lc-sec">
                <h4 className="lc-sec-t"><i>{(tiers?.length || roles?.length) ? 3 : 2}</i>{isQtyCalc ? `Estimate the ${unitWord}` : "Calculator"}</h4>
                <div className="lc-vars">{vars.map(varRow)}</div>
              </section>
            )}

            <section className="lc-sec">
              <h4 className="lc-sec-t"><i>{1 + (tiers?.length || roles?.length ? 1 : 0) + 1 + (vars.length ? 1 : 0)}</i>{line.recurring ? "Contract term" : unit ? `How many ${unitWord}` : "Quantity"}</h4>
              <div className="lc-price">
                {line.recurring
                  ? <Stepper value={years} onChange={setYears} step={1} suffix={years === 1 ? "year" : "years"} wide />
                  : <Stepper value={quantity} onChange={setQty} step={1} disabled={!!qtyBd} suffix={unit ? unitWord : "units"} wide />}
                {!line.recurring && qtyBd && <span className="lc-hint">Set by the calculator above</span>}
                {!line.recurring && rounds && (
                  <span className="lc-badge" title={`Billable minimum in steps of ${minUnit}`}>Billed as {bdBill.qty} {unit ? unitWord : "units"}</span>
                )}
              </div>
            </section>
          </div>

          <aside className="lc-sum">
            <div className="lc-total">
              <span>Line total</span>
              <b>{money(totalShown)}</b>
              {(discTotal > 0 || rounds) && (
                <small>
                  {discTotal > 0 && <>{money(discTotal)} discount</>}
                  {discTotal > 0 && rounds && " · "}
                  {rounds && <>+{money(roundExtra)} rounding</>}
                </small>
              )}
            </div>
            <div className="lc-rows">
              {bd.rows.map((r) => (
                <div key={r.key} className="lc-row">
                  <span>{r.label}{r.detail ? <em> {r.detail}</em> : null}</span>
                  <b>{money(r.amount)}{r.discount > 0 ? <i> -{money(r.discount)}</i> : null}</b>
                </div>
              ))}
              {!qtyBd && <div className="lc-row is-sub"><span>Unit price</span><b>{money(bd.unitPrice)}</b></div>}
              {bd.multiplierLabel && <div className="lc-row"><span>{bd.multiplierLabel}</span><b>{money(bd.total)}</b></div>}
              {rounds && (
                <div className="lc-row is-round">
                  <span>Round up to the billable minimum (+{roundExtraDays} {unit ? unitWord : "units"})</span>
                  <b>+{money(roundExtra)}</b>
                </div>
              )}
            </div>
            <div className="lc-actions">
              <button type="button" className="lc-cancel" onClick={onClose}>Cancel</button>
              <button type="button" className="lc-apply" onClick={apply}>
                Apply
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body);
}
