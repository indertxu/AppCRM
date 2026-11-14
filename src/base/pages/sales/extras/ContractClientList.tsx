import { useEffect, useMemo, useState } from "react";
import { loadProducts, type Product } from "../../settings/catalogApi";
import { loadContractsForDeals, contractFigures, itemFigure, termLabel, PAY_LABEL, type DealContract } from "./contractsApi";
import { ContractTrack, ContractMilestones, PaymentPlan, cpDay, graceLabel } from "./ContractPlan";
import "./ContractTerms.css";

/* =====================================================================
   On the client's page (Contract tab): the contracts signed on its won
   deals — dates (signed → grace → start → renewal), what's in each, and
   the payment plan, invoice by invoice, including the one before renewal.
   ===================================================================== */

const DOC = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4";

export default function ContractClientList({ deals, money, onOpenDeal }: {
  deals: { id: string; name: string }[];
  money: (n: number) => string;
  onOpenDeal?: (id: string) => void;
}) {
  const key = deals.map((d) => d.id).sort().join(",");
  const [rows, setRows] = useState<DealContract[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  useEffect(() => {
    if (!key) { setRows([]); return; }
    let alive = true;
    loadContractsForDeals(key.split(",")).then((x) => {
      if (!alive) return;
      setRows(x);
      if (x.some((c) => c.data.items.length)) loadProducts().then((p) => { if (alive) setProducts(p); }).catch(() => {});
    }).catch(() => {});
    return () => { alive = false; };
  }, [key]);
  const name = useMemo(() => new Map(deals.map((d) => [d.id, d.name])), [deals]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id!, p])), [products]);
  if (!rows.length) return null;
  const now = new Date().toISOString().slice(0, 10);

  return (
    <section className="ccl" data-sec="deal-contracts">
      <header className="ccl-h">
        <b>Signed contracts</b>
        <em>{rows.length} · the terms, dates and payment plan agreed on the deal</em>
      </header>
      {rows.map((c) => {
        const f = contractFigures(c.data, products);
        const next = f.invoices.find((iv) => iv.date >= now);
        const live = now >= f.start && now < f.end;
        const state = now < f.start ? (f.graceDays > 0 && now >= f.signed ? "In grace period" : "Not started") : live ? "Running" : f.renewal ? "Renewed" : "Ended";
        return (
          <article className="ccl-card" key={c.id}>
            <div className="ccl-top">
              <span className="ccl-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={DOC} /></svg></span>
              <div className="ccl-id">
                <b>{c.name}</b>
                <em>
                  {onOpenDeal ? <button type="button" onClick={() => onOpenDeal(c.tracking_id)}>{name.get(c.tracking_id) ?? "Deal"}</button> : name.get(c.tracking_id) ?? "Deal"}
                  {" · "}{termLabel(c.data.term)} · {PAY_LABEL[c.data.payment].toLowerCase()}
                </em>
              </div>
              <span className={`ccl-state is-${state.split(" ")[0].toLowerCase()}`}>{state}</span>
              <div className="ccl-fig">
                <b>{money(f.total)}</b>
                <em>{f.discount > 0 ? `of ${money(f.list)} list` : "at list price"}</em>
              </div>
            </div>
            <div className="ccl-body">
              <div className="ccl-l">
                <ContractMilestones f={f} />
                <ContractTrack f={f} />
                <div className="ccl-kpis">
                  <span><em>Year 1</em><b>{money(f.firstYear)}</b></span>
                  <span><em>A year, list</em><b>{money(f.annualList)}</b></span>
                  {next && <span className="is-next"><em>Next invoice</em><b>{cpDay(next.date, "2-digit")} · {money(next.amount)}</b></span>}
                  {f.renewal && <span><em>Renewal invoice</em><b>{cpDay(f.renewal.invoiceDate, "2-digit")}</b></span>}
                  {f.graceDays > 0 && <span className="is-grace"><em>Grace</em><b>{graceLabel(f.graceDays)}</b></span>}
                </div>
                {(c.data.items.length > 0 || Number(c.data.fee) > 0) && (
                  <div className="ccl-items">
                    {c.data.items.map((it) => {
                      const p = byId.get(it.product_id);
                      const fig = itemFigure(it, p);
                      return <span key={it.id}><b>{p?.name ?? "Product"}</b><em>{money(fig.perYear || fig.amount)}{fig.perYear ? " a year" : ""}</em></span>;
                    })}
                    {Number(c.data.fee) > 0 && <span><b>Contract fee</b><em>{money(c.data.fee)} a year</em></span>}
                  </div>
                )}
              </div>
              <div className="ccl-r">
                <span className="ccl-sub">Payment plan</span>
                <PaymentPlan f={f} money={money} max={5} />
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}
