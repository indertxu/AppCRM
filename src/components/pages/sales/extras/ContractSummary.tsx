import { useState, type ReactNode } from "react";
import { PAY_LABEL, UNIT_LABEL, termKey, type ContractFigures, type PayKey, type Term, pricingMatrix } from "./contractsApi";
import { ContractTrack, ContractMilestones, PaymentPlan, graceLabel } from "./ContractPlan";
import "./ContractTerms.css";

const short = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toLocaleString("de-DE", { maximumFractionDigits: 2 })}M`;
  if (a >= 1e4) return `${(n / 1e3).toLocaleString("de-DE", { maximumFractionDigits: 1 })}k`;
  return Math.round(n).toLocaleString("de-DE");
};
const PAY_SHORT: Record<PayKey, string> = { upfront: "Upfront", annually: "Yearly", semiannually: "6-monthly", quarterly: "Quarterly", monthly: "Monthly" };

/** Every length × every way to pay, side by side: click one to pick it. */
export function PriceMatrix({ m, term, payment, onPick, money }: {
  m: ReturnType<typeof pricingMatrix>; term: Term; payment: PayKey; onPick?: (t: Term, p: PayKey) => void; money: (n: number) => string;
}) {
  const [per, setPer] = useState<"total" | "year">("total");
  if (!m.payments.length || !m.durations.length) return null;
  const vals = Object.values(m.cells).map((c) => c.perYear).filter((x) => x > 0);
  const best = vals.length ? Math.min(...vals) : 0;
  const worst = vals.length ? Math.max(...vals) : 0;
  return (
    <div className="ctx">
      <div className="ctx-h">
        <span className="cts-h">Every option<em>{m.durations.length * m.payments.length}</em></span>
        <div className="ctf-seg is-sm" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={per === "total"} className={per === "total" ? "is-on" : ""} onClick={() => setPer("total")}>Total</button>
          <button type="button" role="radio" aria-checked={per === "year"} className={per === "year" ? "is-on" : ""} onClick={() => setPer("year")}>A year</button>
        </div>
      </div>
      <div className="ctx-grid" style={{ gridTemplateColumns: `62px repeat(${m.payments.length}, minmax(0, 1fr))` }} role="grid">
        <span className="ctx-corner" />
        {m.payments.map((p) => <span key={p} className={`ctx-col ${p === payment ? "is-on" : ""}`} title={PAY_LABEL[p]}>{PAY_SHORT[p]}</span>)}
        {m.durations.map((t) => {
          const rowOn = termKey(t) === termKey(term);
          return [
            <span key={`${termKey(t)}h`} className={`ctx-row ${rowOn ? "is-on" : ""}`} title={`${t.value} ${UNIT_LABEL[t.unit][Number(t.value) === 1 ? 0 : 1]}`}><b>{t.value}</b>{t.unit === "years" ? (Number(t.value) === 1 ? "year" : "yrs") : t.unit === "months" ? "mo" : "d"}</span>,
            ...m.payments.map((p) => {
              const c = m.cells[`${termKey(t)}|${p}`];
              const on = rowOn && p === payment;
              const isBest = c && c.perYear > 0 && c.perYear === best && best !== worst;
              const heat = c && worst > best ? 1 - (c.perYear - best) / (worst - best) : 0;
              return (
                <button key={`${termKey(t)}|${p}`} type="button" className={`ctx-cell ${on ? "is-on" : ""} ${isBest ? "is-best" : ""}`} style={{ ["--h" as any]: heat }}
                  onClick={() => onPick?.(t, p)} disabled={!onPick} title={c ? `${t.value} ${UNIT_LABEL[t.unit][1]}, ${PAY_LABEL[p].toLowerCase()}: ${money(c.total)} in all · ${money(c.perYear)} a year` : ""}>
                  {c ? short(per === "total" ? c.total : c.perYear) : "—"}
                  {isBest && <i>best</i>}
                </button>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}

/** What a contract comes to: the total, each year (list → net), how it's built up, and when it's invoiced. */
export default function ContractSummary({ f, money, note, matrix, noTimeline }: { f: ContractFigures; money: (n: number) => string; note?: string; matrix?: ReactNode; noTimeline?: boolean }) {
  const savedPct = f.list > 0 ? Math.round((f.discount / f.list) * 100) : 0;
  const maxY = Math.max(...f.years.map((x) => x.list), 1);
  return (
    <div className="cts">
      <div className="cts-hero">
        <div className="cts-hero-top">
          <span>Contract total</span>
          {savedPct > 0 && <em className="cts-save">−{savedPct}%</em>}
        </div>
        <b>{money(f.total)}</b>
        <em>{f.discount > 0 ? <>List {money(f.list)} · <i>saves {money(f.discount)}</i></> : "At list price — no discounts"}</em>
        {f.list > 0 && <span className="cts-hero-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, (f.total / f.list) * 100)}%` }} /></span>}
        <div className="cts-hero-k">
          <span><em>Year 1</em><b>{money(f.firstYear)}</b></span>
          <span><em>List a year</em><b>{money(f.annualList)}</b></span>
          <span><em>Invoices</em><b>{f.invoices.length}</b></span>
        </div>
      </div>
      {!noTimeline && <div className="cts-sec is-time">
        <span className="cts-h">Timeline{f.graceDays > 0 ? <em className="is-grace">grace {graceLabel(f.graceDays)}</em> : null}</span>
        <ContractMilestones f={f} />
        <ContractTrack f={f} />
      </div>}
      {note && <p className="cts-note">{note}</p>}
      {matrix}
      <div className="cts-sec">
        <span className="cts-h">How it adds up</span>
        {f.breakdown.map((b, i) => (
          <div key={i} className={`cts-row ${b.amount < 0 ? "is-off" : ""}`}><span title={b.label}>{b.label}</span><b>{b.amount < 0 ? `−${money(-b.amount)}` : money(b.amount)}</b></div>
        ))}
        {f.incrementsWaived && <div className="cts-row is-info"><span>Yearly increments waived: paid upfront</span><b>—</b></div>}
        <div className="cts-row is-total"><span>Total</span><b>{money(f.total)}</b></div>
      </div>
      {f.years.length > 1 && (
        <div className="cts-sec">
          <span className="cts-h">Each year</span>
          <div className="cts-years">
            {f.years.map((y) => (
              <div key={y.year} className="cts-year" title={`List ${money(y.list)} → ${money(y.net)}`}>
                <span>Y{y.year}{y.share < 1 ? <small> · {Math.round(y.share * 12)}m</small> : null}</span>
                <span className="cts-year-bar"><s style={{ width: `${Math.max(6, (y.list / maxY) * 100)}%` }} /><i style={{ width: `${Math.max(5, (y.net / maxY) * 100)}%` }} /></span>
                <b>{money(y.net)}</b>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="cts-sec">
        <span className="cts-h">Payment plan<em>{f.invoices.length}</em></span>
        <PaymentPlan f={f} money={money} />
      </div>
    </div>
  );
}
