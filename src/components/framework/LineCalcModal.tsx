/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { calcBreakdown, discountOf, BASE_KEY, type Calculator, type CalcDiscount } from "../pages/settings/catalogApi";
import { lineBreakdown, type RevenueLineFields, type TermPatch } from "../pages/sales/salesApi";
import "./LineCalcModal.css";

function DiscountControl({ dkey, amount, discounts, setDisc, money }: {
  dkey: string; amount: number;
  discounts: Record<string, CalcDiscount>;
  setDisc: (key: string, patch: Partial<CalcDiscount>) => void;
  money: (n: number) => string;
}) {
  const d = discounts[dkey] ?? { mode: "none" as const, value: 0 };
  const off = discountOf(amount, d);
  return (
    <div className="sl-calc-disc">
      <div className="sl-calc-switch sl-calc-switch-xs">
        <button className={d.mode === "none" ? "is-on" : ""} onClick={() => setDisc(dkey, { mode: "none" })}>-</button>
        <button className={d.mode === "percent" ? "is-on" : ""} onClick={() => setDisc(dkey, { mode: "percent" })}>%</button>
        <button className={d.mode === "amount" ? "is-on" : ""} onClick={() => setDisc(dkey, { mode: "amount" })}>{"\u20ac"}</button>
      </div>
      {d.mode !== "none" && (
        <>
          <input type="number" min="0" value={d.value} onFocus={(e) => e.target.select()}
            onChange={(e) => setDisc(dkey, { value: parseFloat(e.target.value) || 0 })} />
          <span className="sl-calc-off">-{money(off)}</span>
        </>
      )}
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
    <label className="sl-calc-rate">
      <input type="number" min="0" value={v} onFocus={(e) => e.target.select()}
        onChange={(e) => setRate(rkey, parseFloat(e.target.value) || 0)} />
      <span>/{unit}</span>
    </label>
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

  return (
    <div className="sl-calc-backdrop" onMouseDown={onClose}>
      <div className={`sl-calc ${variant === "modern" ? "sl-calc-modern" : ""}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sl-calc-head">
          <div>
            <span className="sl-calc-eyebrow">Line calculator</span>
            <h3 className="sl-calc-title">{title}</h3>
          </div>
          <button className="sl-calc-x" onClick={onClose}>×</button>
        </div>

        <div className="sl-calc-body">
          {tiers && tiers.length > 0 && (
            <div className="sl-calc-sec">
              <p className="sl-calc-sec-t">Tier</p>
              <div className="sl-calc-tiers">
                {tiers.map((t) => (
                  <button key={t.id ?? t.name} className={tierId === t.id ? "is-on" : ""} onClick={() => setTierId(t.id ?? "")}>
                    <b>{t.name || "Unnamed"}</b><span>{money(t.price)}</span>
                  </button>
                ))}
                <button className={tierId === "" ? "is-on" : ""} onClick={() => setTierId("")}>
                  <b>Custom</b><span>manual price</span>
                </button>
              </div>
            </div>
          )}

          {roles && roles.length > 0 && (
            <div className="sl-calc-sec">
              <p className="sl-calc-sec-t">Rate</p>
              <div className="sl-calc-tiers">
                {roles.map((r, i) => (
                  <button key={r.role_id} className={roleId === r.role_id ? "is-on" : ""} onClick={() => setRoleId(r.role_id)}>
                    <b>{roleName ? roleName(r.role_id) : `Rate ${i + 1}`}</b><span>{money(r.price)}/{unit ?? "day"}</span>
                  </button>
                ))}
                <button className={roleId === "" ? "is-on" : ""} onClick={() => setRoleId("")}>
                  <b>Custom</b><span>manual rate</span>
                </button>
              </div>
            </div>
          )}

          <div className="sl-calc-sec">
            <p className="sl-calc-sec-t">{unit ? `Rate per ${unit}` : "Base price"}</p>
            <div className="sl-calc-inline">
              <input type="number" min="0" value={tierPrice ?? rolePrice ?? manualPrice}
                disabled={tierPrice != null || rolePrice != null} onFocus={(e) => e.target.select()}
                onChange={(e) => setManualPrice(parseFloat(e.target.value) || 0)} />
              {qtyCalc
                ? <DiscountControl dkey={BASE_KEY} amount={bd.rows.find((r) => r.key === BASE_KEY)?.amount ?? 0} discounts={discounts} setDisc={setDisc} money={money} />
                : <DiscountControl dkey={BASE_KEY} amount={basePrice} discounts={discounts} setDisc={setDisc} money={money} />}
            </div>
          </div>

          {vars.length > 0 && (
            <div className="sl-calc-sec">
              <p className="sl-calc-sec-t">{isQtyCalc ? `Estimate the ${unitWord}` : "Calculator"}</p>
              <div className="sl-calc-vars">
                {vars.map((v) => {
                  const k = v.id ?? String(v.sort);
                  const val = values[k] ?? (Number(v.default_value) || 0);
                  const rowAmount = bd.rows.find((r) => r.key === k)?.amount ?? 0;
                  const showRate = !!qtyCalc;
                  const showDisc = !!priceCalc || !!qtyCalc;
                  if (v.var_type === "percent") {
                    return (
                      <div key={k} className="sl-calc-var sl-calc-var-fixed">
                        <span>{v.name}</span>
                        <em>{v.amount}% of base</em>
                        {showRate && <RateControl rkey={k} rates={rates} baseRate={basePrice} setRate={setRate} unit={unit ?? "day"} />}
                        {showDisc && <DiscountControl dkey={k} amount={rowAmount} discounts={discounts} setDisc={setDisc} money={money} />}
                      </div>
                    );
                  }
                  if (v.var_type === "fixed") {
                    return (
                      <div key={k} className="sl-calc-var">
                        <span>{v.name}</span>
                        <div className="sl-calc-switch">
                          <button className={val ? "is-on" : ""} onClick={() => setValues((x) => ({ ...x, [k]: 1 }))}>Yes</button>
                          <button className={!val ? "is-on" : ""} onClick={() => setValues((x) => ({ ...x, [k]: 0 }))}>No</button>
                        </div>
                        {qtyBd && <span className="sl-calc-out">{qtyBd.rows.find((r) => r.key === k)?.amount ?? 0} {unitWord}</span>}
                        {showRate && <RateControl rkey={k} rates={rates} baseRate={basePrice} setRate={setRate} unit={unit ?? "day"} />}
                        {showDisc && <DiscountControl dkey={k} amount={rowAmount} discounts={discounts} setDisc={setDisc} money={money} />}
                      </div>
                    );
                  }
                  return (
                    <div key={k} className="sl-calc-var">
                      <span>{v.name}{v.unit_label ? ` (${v.unit_label})` : ""}</span>
                      <input type="number" min="0" value={val} onFocus={(e) => e.target.select()}
                        onChange={(e) => setValues((x) => ({ ...x, [k]: parseFloat(e.target.value) || 0 }))} />
                      {qtyBd && <span className="sl-calc-out">{qtyBd.rows.find((r) => r.key === k)?.amount ?? 0} {unitWord}</span>}
                      {showRate && <RateControl rkey={k} rates={rates} baseRate={basePrice} setRate={setRate} unit={unit ?? "day"} />}
                      {showDisc && <DiscountControl dkey={k} amount={rowAmount} discounts={discounts} setDisc={setDisc} money={money} />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="sl-calc-sec">
            <p className="sl-calc-sec-t">{line.recurring ? "Contract term" : unit ? `How many ${unitWord}` : "Quantity"}</p>
            <div className="sl-calc-inline">
              {line.recurring ? (
                <>
                  <input type="number" min="0" step="0.5" value={years} onFocus={(e) => e.target.select()}
                    onChange={(e) => setYears(parseFloat(e.target.value) || 0)} />
                  <em>{years === 1 ? "year" : "years"}</em>
                </>
              ) : (
                <>
                  <input type="number" min="0" step="0.5" value={quantity} disabled={!!qtyBd}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setQty(parseFloat(e.target.value) || 0)} />
                  <em>{unit ? unitWord : "units"}</em>
                  {qtyBd && <span className="sl-calc-note">set by the calculator above</span>}
                  {rounds && (
                    <span className="sl-calc-billqty" title={`Billable minimum in steps of ${minUnit}`}>
                      → bill {bdBill.qty} {unit ? unitWord : "units"}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="sl-calc-receipt">
            {bd.rows.map((r) => (
              <div key={r.key} className="sl-rc-row">
                <span>{r.label}{r.detail ? ` (${r.detail})` : ""}</span>
                <em>{money(r.amount)}{r.discount > 0 ? <i className="sl-rc-off"> -{money(r.discount)}</i> : null}</em>
              </div>
            ))}
            {!qtyBd && <div className="sl-rc-row sl-rc-sub"><span>Unit price</span><em>{money(bd.unitPrice)}</em></div>}
            {bd.multiplierLabel && <div className="sl-rc-row"><span>{bd.multiplierLabel}</span><em>{money(bd.total)}</em></div>}
            {rounds && (
              <div className="sl-rc-row sl-rc-round">
                <span>Round up to minimum billable (+{roundExtraDays} {unit ? unitWord : "units"})</span>
                <em>+{money(roundExtra)}</em>
              </div>
            )}
            <div className="sl-rc-row sl-rc-total">
              <span>Line total</span>
              <em>
                {rounds && <i className="sl-rc-calc">{money(bd.total)}</i>}
                {money(rounds ? billableTotal : bd.total)}
              </em>
            </div>
          </div>
        </div>

        <div className="sl-calc-foot">
          <button className="sl-calc-cancel" onClick={onClose}>Cancel</button>
          <button className="sl-calc-apply" onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  );
}