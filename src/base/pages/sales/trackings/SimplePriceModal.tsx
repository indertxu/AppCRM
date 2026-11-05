/* =====================================================================
   BASE · Deals — the price of one line, simply (instead of Enterprise's
   calculators and versions): the price (or a tier), how many, extras that
   add to the price, and a discount. One version only.
   Stored on the line as before, so totals work everywhere:
     price        = base + extras
     calc_values  = { base, "add:<label>": amount, … }   (to show them again)
     discount_mode / discount_value, quantity, term_years, tier_id
   ===================================================================== */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Select from "../../../framework/Select";
import { lineBreakdown, type RevenueLineFields, type TermPatch } from "../sales/salesApi";
import "./SimplePriceModal.css";

interface Props {
  title: string;
  kind: "product" | "service";
  line: RevenueLineFields;
  tiers?: { id?: string; name: string; price: number }[];
  /** A service sold by the hour / day. */
  unit?: "hour" | "day" | null;
  money: (n: number) => string;
  onApply: (patch: TermPatch) => void;
  onClose: () => void;
}
interface Extra { key: string; label: string; amount: string }
const ADD = "add:";
const num = (s: string) => { const n = Number(String(s).replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const k = () => Math.random().toString(36).slice(2, 9);

export default function SimplePriceModal({ title, kind, line, tiers = [], unit, money, onApply, onClose }: Props) {
  const cv = (line.calc_values ?? {}) as Record<string, number>;
  const savedExtras = Object.entries(cv).filter(([key]) => key.startsWith(ADD)).map(([key, v]) => ({ key: k(), label: key.slice(ADD.length), amount: String(v) }));
  const extrasSum0 = savedExtras.reduce((a, x) => a + num(x.amount), 0);
  const [tier, setTier] = useState<string>(line.tier_id ?? "");
  const [base, setBase] = useState(String(cv.base != null ? cv.base : Math.max(0, (Number(line.price) || 0) - extrasSum0)));
  const [qty, setQty] = useState(String(line.quantity ?? 1));
  const [years, setYears] = useState(String(line.term_years ?? 1));
  const [extras, setExtras] = useState<Extra[]>(savedExtras);
  const [dMode, setDMode] = useState<"none" | "percent" | "amount">(line.discount_mode === "percent" || line.discount_mode === "amount" ? line.discount_mode : "none");
  const [dVal, setDVal] = useState(String(line.discount_value ?? 0));
  const [closing, setClosing] = useState(false);
  const close = () => { setClosing(true); setTimeout(onClose, 200); };
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".sel-layer")) close(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  });

  const extrasSum = extras.reduce((a, x) => a + num(x.amount), 0);
  const patch: TermPatch = useMemo(() => {
    const values: Record<string, number> = { base: num(base) };
    extras.filter((x) => x.label.trim() || num(x.amount)).forEach((x, i) => { values[`${ADD}${x.label.trim() || `Extra ${i + 1}`}`] = num(x.amount); });
    return {
      price: Math.round((num(base) + extrasSum) * 100) / 100,
      quantity: Math.max(0, num(qty)) || 1,
      ...(line.recurring ? { term_years: Math.max(1, Math.round(num(years))) } : {}),
      ...(tiers.length ? { tier_id: tier || null } : {}),
      calc_values: values,
      discount_mode: dMode, discount_value: dMode === "none" ? 0 : num(dVal),
    };
  }, [base, extras, extrasSum, qty, years, tier, dMode, dVal, line.recurring, tiers.length]);
  const bd = lineBreakdown({ ...line, ...patch, calc_values: null } as RevenueLineFields, null);

  const pickTier = (id: string) => { setTier(id); const t = tiers.find((x) => x.id === id); if (t) setBase(String(t.price)); };
  const per = line.recurring ? (line.period === "monthly" ? "/ month" : "/ year") : unit ? `/ ${unit}` : "";

  return createPortal(
    <div className={`spm-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={`spm is-${kind}`} role="dialog" aria-modal="true" aria-label={`Price of ${title}`}>
        <header className="spm-head">
          <div><span>{kind === "product" ? "Product" : "Service"} · price</span><h2>{title}</h2></div>
          <button className="spm-x" onClick={close} aria-label="Close">×</button>
        </header>
        <div className="spm-body">
          {tiers.length > 1 && (
            <label className="spm-f"><span>Tier</span>
              <Select value={tier} onChange={pickTier} options={tiers.map((t) => ({ value: t.id ?? t.name, label: t.name, hint: money(t.price) }))} placeholder="Pick a tier" />
            </label>
          )}
          <div className="spm-row">
            <label className="spm-f is-grow"><span>Price {per}</span>
              <span className="spm-in"><input inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} onFocus={(e) => e.currentTarget.select()} /><i>€</i></span>
            </label>
            {line.recurring ? (
              <label className="spm-f"><span>Years</span><span className="spm-in"><input inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value)} onFocus={(e) => e.currentTarget.select()} /></span></label>
            ) : (
              <label className="spm-f"><span>{unit ? `${unit === "hour" ? "Hours" : "Days"}` : "Quantity"}</span><span className="spm-in"><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} onFocus={(e) => e.currentTarget.select()} /></span></label>
            )}
          </div>

          <div className="spm-sec">
            <div className="spm-sec-h"><b>Extras</b><small>Things that add to the price {per && `(${per.replace("/ ", "per ")})`}</small></div>
            {extras.map((x) => (
              <div className="spm-extra" key={x.key}>
                <input className="spm-txt" value={x.label} placeholder="e.g. Extra entity, rush delivery…" onChange={(e) => setExtras((xs) => xs.map((y) => (y.key === x.key ? { ...y, label: e.target.value } : y)))} />
                <span className="spm-in is-sm"><b>+</b><input inputMode="decimal" value={x.amount} onChange={(e) => setExtras((xs) => xs.map((y) => (y.key === x.key ? { ...y, amount: e.target.value } : y)))} onFocus={(e) => e.currentTarget.select()} /><i>€</i></span>
                <button className="spm-del" onClick={() => setExtras((xs) => xs.filter((y) => y.key !== x.key))} aria-label="Remove">×</button>
              </div>
            ))}
            <button className="spm-add" onClick={() => setExtras((xs) => [...xs, { key: k(), label: "", amount: "0" }])}>+ Add an extra</button>
          </div>

          <div className="spm-sec">
            <div className="spm-sec-h"><b>Discount</b></div>
            <div className="spm-disc">
              <div className="spm-seg">
                {([["none", "None"], ["percent", "%"], ["amount", "€"]] as const).map(([m, l]) => (
                  <button key={m} className={dMode === m ? "is-on" : ""} onClick={() => setDMode(m)}>{l}</button>
                ))}
              </div>
              {dMode !== "none" && (
                <span className="spm-in is-sm"><input inputMode="decimal" value={dVal} onChange={(e) => setDVal(e.target.value)} onFocus={(e) => e.currentTarget.select()} autoFocus /><i>{dMode === "percent" ? "%" : "€"}</i></span>
              )}
              {bd.unitDiscount > 0 && <small>−{money(bd.unitDiscount)} {per}</small>}
            </div>
          </div>
        </div>
        <footer className="spm-foot">
          <div className="spm-total">
            <small>{money(bd.unitPrice)} {per}{bd.multiplierLabel ? ` ${bd.multiplierLabel}` : ""}</small>
            <b>{money(bd.total)}</b>
          </div>
          <button className="spm-btn" onClick={close}>Cancel</button>
          <button className="spm-btn is-primary" onClick={() => { onApply(patch); close(); }}>Save</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
