import type { ContractFigures } from "./contractsApi";
import "./ContractTerms.css";

/** What a contract comes to: the total, each year (list → net), how it's built up, and when it's invoiced. */
export default function ContractSummary({ f, money, note }: { f: ContractFigures; money: (n: number) => string; note?: string }) {
  const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return (
    <div className="cts">
      <div className="cts-hero">
        <span>Contract total</span>
        <b>{money(f.total)}</b>
        <em>{f.discount > 0 ? <>List {money(f.list)} · <i>−{money(f.discount)}</i></> : "No discounts"}</em>
      </div>
      <div className="cts-kpis">
        <span><em>Year 1</em><b>{money(f.firstYear)}</b></span>
        <span><em>Per year (list)</em><b>{money(f.annualList)}</b></span>
        <span><em>Runs</em><b>{day(f.start)} → {day(f.end)}</b></span>
      </div>
      {note && <p className="cts-note">{note}</p>}
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
            {f.years.map((y) => {
              const max = Math.max(...f.years.map((x) => x.list), 1);
              return (
                <div key={y.year} className="cts-year">
                  <span>Y{y.year}{y.share < 1 ? <small> · {Math.round(y.share * 12)}m</small> : null}</span>
                  <i style={{ width: `${Math.max(6, (y.net / max) * 100)}%` }} />
                  <b>{money(y.net)}</b>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="cts-sec">
        <span className="cts-h">Invoices<em>{f.invoices.length}</em></span>
        <div className="cts-inv">
          {f.invoices.slice(0, 8).map((iv, i) => (
            <div key={i} className="cts-inv-r">
              <span><b>{day(iv.date)}</b><em>{iv.label} · due {day(iv.due)}</em></span>
              <b>{money(iv.amount)}</b>
            </div>
          ))}
          {f.invoices.length > 8 && <p className="cts-more">+ {f.invoices.length - 8} more</p>}
          {f.renewal && <div className="cts-inv-r is-renew"><span><b>{day(f.renewal.invoiceDate)}</b><em>Renewal invoice · it renews {day(f.renewal.date)}</em></span><b>↻</b></div>}
        </div>
      </div>
    </div>
  );
}
