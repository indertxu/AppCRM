import { useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Product } from "../../settings/catalogApi";
import ContractSummary from "./ContractSummary";
import { ContractTrack, ContractMilestones, cpDay, graceLabel } from "./ContractPlan";
import { useEscape } from "./ContractConfirm";
import { Ico, IC } from "./ContractTermsForm";
import { contractFigures, itemFigure, termLabel, PAY_LABEL, type DealContract } from "./contractsApi";
import "./ContractTerms.css";

/* =====================================================================
   A signed contract, to look at (Clients › Contracts): its dates on a
   timeline, what it includes, its terms, and what it comes to — with the
   payment plan invoice by invoice. Read only; it's edited on its deal.
   ===================================================================== */

const DOC = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4";
export const contractState = (f: { signed: string; start: string; end: string; graceDays: number; renewal: unknown }) => {
  const now = new Date().toISOString().slice(0, 10);
  if (now < f.start) return f.graceDays > 0 && now >= f.signed ? "In grace period" : "Not started";
  if (now < f.end) return "Running";
  return f.renewal ? "Renewed" : "Ended";
};
export const stateTone = (s: string) => (s === "Running" ? "run" : s === "In grace period" ? "grace" : s === "Not started" ? "soon" : s === "Renewed" ? "run" : "off");

export function ViewShell({ title, eyebrow, state, total, sub, onClose, side, children, foot }: {
  title: string; eyebrow: ReactNode; state?: string; total?: string; sub?: string; onClose: () => void; side?: ReactNode; children: ReactNode; foot?: ReactNode;
}) {
  useEscape(onClose);
  return createPortal(
    <div className="ctm-back" onMouseDown={onClose}>
      <div className="ctm ctv" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header className="ctm-h">
          <span className="ctm-ico" aria-hidden="true"><Ico d={DOC} /></span>
          <div className="ctm-h-t">
            <em>{eyebrow}</em>
            <h2 className="ctv-name">{title}</h2>
          </div>
          {state && <span className={`ctv-state is-${stateTone(state)}`}>{state}</span>}
          {total && <span className="ctm-pill"><span><em>{sub}</em><b>{total}</b></span></span>}
          <button type="button" className="ctm-x" onClick={onClose} aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </header>
        <div className={`ctm-body ${side ? "" : "is-one"}`}>
          <div className="ctm-main">{children}</div>
          {side && <aside className="ctm-side">{side}</aside>}
        </div>
        <footer className="ctm-f">
          {foot}
          <span className="ctm-f-sp" />
          <button type="button" className="ctm-btn" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export function ViewSec({ icon, title, sub, children, aside }: { icon: string; title: string; sub?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="ctf-sec ctv-sec">
      <header className="ctf-sec-h">
        <span className="ctf-ico"><Ico d={icon} /></span>
        <div className="ctf-sec-t"><b>{title}</b>{sub && <em>{sub}</em>}</div>
        {aside}
      </header>
      {children}
    </section>
  );
}

export default function ContractView({ contract, products, clientName, dealName, money, onClose, onOpenDeal, onOpenClient }: {
  contract: DealContract; products: Product[]; clientName: string; dealName: string; money: (n: number) => string;
  onClose: () => void; onOpenDeal?: () => void; onOpenClient?: () => void;
}) {
  const d = contract.data;
  const f = useMemo(() => contractFigures(d, products), [d, products]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id!, p])), [products]);
  const state = contractState(f);
  const durPct = d.durations.find((x) => x.unit === d.term.unit && Number(x.value) === Number(d.term.value))?.discountPct ?? 0;
  const payPct = d.payments.find((x) => x.key === d.payment)?.discountPct ?? 0;
  const on = d.discounts.filter((x) => x.on);
  const inc = d.increments.mode !== "none" && d.increments.value ? `+${d.increments.value}${d.increments.mode === "pct" ? "%" : " €"} a year${d.increments.waivedIfUpfront ? " · none if paid upfront" : ""}` : "Flat";
  const terms: [string, string, string?][] = [
    ["Length", termLabel(d.term), durPct ? `−${durPct}%` : undefined],
    ["Paid", PAY_LABEL[d.payment], payPct ? `−${payPct}%` : undefined],
    ["Invoiced", d.prepayDays ? `${d.prepayDays} days before each period` : "On the day each period starts"],
    ["Due", `${d.paymentTermsDays} days after the invoice`],
    ["Increments", inc],
    ["Renewal", d.autoRenew ? `Renews for ${termLabel(d.renew ?? { value: 1, unit: "years" })}${d.noticeDays ? ` · ${d.noticeDays} days' notice` : ""}` : "Ends at the end of its length"],
    ["Grace period", f.graceDays ? graceLabel(f.graceDays) : "None"],
    ...on.map((x) => ["Discount", x.name || "Commercial discount", `−${x.value}${x.mode === "pct" ? "%" : " €/yr"}`] as [string, string, string]),
  ];
  return (
    <ViewShell title={contract.name} eyebrow={<>Contract · {clientName}</>} state={state} total={money(f.total)} sub={`${termLabel(d.term)} · ${PAY_LABEL[d.payment]}`} onClose={onClose}
      side={<ContractSummary noTimeline f={f} money={money} note={!d.signed ? "No signing day on the deal: dates count from today." : undefined} />}
      foot={<>
        {onOpenDeal && <button type="button" className="ctm-btn" onClick={onOpenDeal}>Open the deal · {dealName}</button>}
        {onOpenClient && <button type="button" className="ctm-btn is-main" onClick={onOpenClient}>Open {clientName}</button>}
      </>}>
      <ViewSec icon={IC.start} title="Dates" sub={`Signed ${cpDay(f.signed)}${f.graceDays ? ` · ${graceLabel(f.graceDays)} of grace` : ""} · ${f.renewal ? "renews" : "ends"} ${cpDay(f.end)}`}>
        <ContractMilestones f={f} />
        <ContractTrack f={f} />
      </ViewSec>
      <ViewSec icon="M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5" title="What it includes"
        aside={<span className="ctm-sec-fig">{money(f.annualList)}<em>a year, list</em></span>}>
        <div className="ctv-items">
          {d.items.map((it) => {
            const p = byId.get(it.product_id);
            const fig = itemFigure(it, p);
            return (
              <div className="ctv-item" key={it.id}>
                <span className="ctm-item-ini" aria-hidden="true">{(p?.name ?? "?").slice(0, 1).toUpperCase()}</span>
                <span className="ctv-item-t"><b>{p?.name ?? "Product"}</b><em>{fig.rows.map((r) => r.detail || r.label).filter(Boolean).slice(0, 3).join(" · ") || fig.detail}</em></span>
                <span className="ctv-item-f"><b>{money(fig.amount)}</b><em>{fig.detail}{fig.perYear && fig.detail !== "a year" ? ` · ${money(fig.perYear)}/yr` : ""}</em></span>
              </div>
            );
          })}
          {Number(d.fee) > 0 && (
            <div className="ctv-item">
              <span className="ctm-item-ini is-fee" aria-hidden="true">€</span>
              <span className="ctv-item-t"><b>Fee of its own</b><em>{d.items.length ? "On top of its products" : "The contract is this fee"}</em></span>
              <span className="ctv-item-f"><b>{money(d.fee)}</b><em>a year</em></span>
            </div>
          )}
          {!d.items.length && !Number(d.fee) && <p className="ctf-empty">Nothing in it yet.</p>}
        </div>
      </ViewSec>
      <ViewSec icon={IC.tune} title="Terms" sub="As agreed on the deal">
        <div className="ctv-terms">
          {terms.map(([k, v, b], i) => (
            <span key={i}><em>{k}</em><b>{v}{b && <i>{b}</i>}</b></span>
          ))}
        </div>
      </ViewSec>
    </ViewShell>
  );
}
