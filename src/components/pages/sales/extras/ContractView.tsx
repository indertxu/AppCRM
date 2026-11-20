import { nowMs, todayIso } from "../../../framework/asOf";
import { useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Product } from "../../settings/catalogApi";
import ContractSummary from "./ContractSummary";
import { ContractTrack, ContractMilestones, cpDay, graceLabel } from "./ContractPlan";
import { useEscape } from "./ContractConfirm";
import { Ico, IC } from "./ContractTermsForm";
import { contractFigures, itemFigure, termLabel, PAY_LABEL, type DealContract } from "./contractsApi";
import "./ContractTerms.css";

import { PicOr } from "../../../framework/avatars";
/* =====================================================================
   A signed contract, to look at (Clients › Contracts): its dates on a
   timeline, what it includes, its terms, and what it comes to — with the
   payment plan invoice by invoice. Read only; it's edited on its deal.
   ===================================================================== */

const DOC = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4";
export const contractState = (f: { signed: string; start: string; end: string; graceDays: number; renewal: unknown }) => {
  const now = todayIso();
  if (now < f.start) return f.graceDays > 0 && now >= f.signed ? "In grace period" : "Not started";
  if (now < f.end) return "Running";
  return f.renewal ? "Renewed" : "Ended";
};
export const stateTone = (s: string) => (s === "Running" ? "run" : s === "In grace period" ? "grace" : s === "Not started" ? "soon" : s === "Renewed" ? "run" : "off");

export function ViewShell({ title, eyebrow, state, total, sub, onClose, side, children, foot, wide, head, footEnd, mode, size, ico }: {
  title: string; eyebrow: ReactNode; state?: string; total?: string; sub?: string; onClose: () => void; side?: ReactNode; children: ReactNode; foot?: ReactNode;
  /** Nearly the whole screen, for the detailed views. */
  wide?: boolean;
  /** More in the header, before the close button (e.g. Edit). */
  head?: ReactNode;
  /** The footer's right-hand buttons, in place of Close. */
  footEnd?: ReactNode;
  /** "edit": the window shows it's being edited. */
  mode?: "edit";
  /** "sm": a small window that fits its content (a question, a short list). */
  size?: "sm";
  /** In place of the document icon (e.g. the client's logo). */
  ico?: ReactNode;
}) {
  useEscape(onClose);
  return createPortal(
    <div className="ctm-back" onMouseDown={onClose}>
      <div className={`ctm ctv ${wide ? "is-wide" : ""} ${size === "sm" ? "is-sm" : ""} ${mode === "edit" ? "is-editing" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header className="ctm-h">
          <span className="ctm-ico" aria-hidden="true">{ico ?? <Ico d={DOC} />}</span>
          <div className="ctm-h-t">
            <em>{eyebrow}</em>
            <span className="ctv-title"><h2 className="ctv-name">{title}</h2>{state && <span className={`ctv-state is-${stateTone(state)}`}>{state}</span>}</span>
          </div>
          {total && <span className="ctm-pill"><em>{sub}</em><b>{total}</b></span>}
          {head}
          <button type="button" className="ctm-x" onClick={onClose} aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </header>
        <div className={`ctm-body ${side ? "" : "is-one"} ${wide ? "is-wide" : ""}`}>
          <div className="ctm-main">{children}</div>
          {side && <aside className="ctm-side">{side}</aside>}
        </div>
        <footer className="ctm-f">
          {foot}
          <span className="ctm-f-sp" />
          {footEnd ?? <button type="button" className="ctm-btn" onClick={onClose}>Close</button>}
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

const DAYMS = 864e5;
export const HERO_ICO = {
  value: "M20 12V8H6a2 2 0 0 1 0-4h12v4M4 6v12a2 2 0 0 0 2 2h14v-4M18 12a2 2 0 0 0 0 4h4v-4z",
  year: "M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3",
  gross: "M3 3v18h18M7 15l4-4 3 3 5-6",
  total: "M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5",
  term: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
};
export type HeroKpi = { k: string; v: ReactNode; sub?: ReactNode; main?: boolean; ico?: string; bars?: { v: number; on?: boolean; label?: string }[] };
/** A contract's figures as cards — the first one dark, with its years as small bars — and its term as a card of its own:
 *  how far through it is, signed → starts → ends. */
export function ViewHero({ kpis, term }: {
  kpis: HeroKpi[];
  term?: { signed?: string | null; start?: string | null; end?: string | null; renews?: boolean; state?: string } | null;
}) {
  const t = term && term.start && term.end ? term : null;
  let pct = 0, big = "", small = "", chip = "";
  if (t) {
    const a = +new Date(`${t.start!.slice(0, 10)}T12:00:00`), b = +new Date(`${t.end!.slice(0, 10)}T12:00:00`), now = nowMs();
    pct = b > a ? Math.max(0, Math.min(1, (now - a) / (b - a))) : now >= b ? 1 : 0;
    const left = Math.ceil((b - now) / DAYMS), until = Math.ceil((a - now) / DAYMS);
    if (now < a) { big = `${until}`; small = until === 1 ? "day to start" : "days to start"; chip = "Not started"; }
    else if (now >= b) { big = t.renews ? "Renewed" : "Ended"; small = ""; chip = cpDay(t.end!.slice(0, 10)); }
    else { big = `${Math.round(pct * 100)}%`; small = "of the term"; chip = left > 60 ? `${Math.round(left / 30.4)} months left` : `${left} day${left === 1 ? "" : "s"} left`; }
  }
  return (
    <div className={`ctv-hero ${t ? "has-term" : ""}`} style={{ ["--n" as any]: kpis.length }}>
      {kpis.map((x, i) => {
        const max = Math.max(1, ...(x.bars ?? []).map((y) => y.v));
        return (
          <div key={i} className={`ctv-kpi ${x.main ? "is-main" : ""}`}>
            <span className="ctv-kpi-h"><em>{x.k}</em>{x.ico && <span className="ctv-kpi-ico"><Ico d={x.ico} /></span>}</span>
            <b className="ctv-kpi-v">{x.v}</b>
            {x.bars && x.bars.length > 1 && (
              <span className="ctv-spark" aria-hidden="true">
                {x.bars.map((y, j) => <i key={j} className={y.on ? "is-on" : ""} style={{ height: `${Math.max(14, (y.v / max) * 100)}%` }} title={y.label} />)}
              </span>
            )}
            <i className="ctv-kpi-sub">{x.sub ?? "\u00a0"}</i>
          </div>
        );
      })}
      {t && (
        <div className={`ctv-kpi is-term is-${stateTone(t.state ?? "")}`}>
          <span className="ctv-kpi-h"><em>Term</em><span className="ctv-kpi-ico"><Ico d={HERO_ICO.term} /></span></span>
          <span className="ctv-term-big"><b>{big}</b>{small && <em>{small}</em>}{chip && <i>{chip}</i>}</span>
          <span className="ctv-bar" aria-hidden="true"><span style={{ width: `${pct * 100}%` }} /></span>
          <span className="ctv-term-d">
            {t.signed && t.signed.slice(0, 10) !== t.start!.slice(0, 10) && <span><em>Signed</em><b>{cpDay(t.signed.slice(0, 10))}</b></span>}
            <span><em>Starts</em><b>{cpDay(t.start!.slice(0, 10))}</b></span>
            <span className="is-r"><em>{t.renews ? "Renews" : "Ends"}</em><b>{cpDay(t.end!.slice(0, 10))}</b></span>
          </span>
        </div>
      )}
    </div>
  );
}

export default function ContractView({ contract, products, clientName, dealName, money, onClose, onOpenDeal, onOpenClient, onEdit }: {
  contract: DealContract; products: Product[]; clientName: string; dealName: string; money: (n: number) => string;
  onClose: () => void; onOpenDeal?: () => void; onOpenClient?: () => void;
  /** Opens the contract's editor (the deal's contract window). */
  onEdit?: () => void;
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
    <ViewShell wide head={onEdit ? <button type="button" className="scv-edit" onClick={onEdit}><Ico d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />Edit</button> : undefined} title={contract.name} eyebrow={<>Contract · {clientName}</>} state={state} onClose={onClose}
      side={<ContractSummary noTimeline f={f} money={money} note={!d.signed ? "No signing day on the deal: dates count from today." : undefined} />}
      foot={<>
        {onOpenDeal && <button type="button" className="ctm-btn" onClick={onOpenDeal}>Open the deal · {dealName}</button>}
        {onOpenClient && <button type="button" className="ctm-btn is-main" onClick={onOpenClient}>Open {clientName}</button>}
      </>}>
      <ViewHero
        kpis={[
          { main: true, ico: HERO_ICO.value, k: "Contract value", v: money(f.total), sub: f.discount > 0.5 ? `List ${money(f.list)} · ${money(f.discount)} off` : `${termLabel(d.term)} · ${PAY_LABEL[d.payment]}`,
            bars: f.years.map((y, i) => ({ v: y.net, label: `Year ${i + 1} · ${money(y.net)}`, on: i === 0 })) },
          { ico: HERO_ICO.year, k: "First year", v: money(f.firstYear), sub: `${money(f.annualList)} a year, list` },
        ]}
        term={{ signed: f.signed, start: f.start, end: f.end, renews: !!f.renewal, state }} />
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
                <span className="ctm-item-ini" aria-hidden="true"><PicOr name={p?.name}>{(p?.name ?? "?").slice(0, 1).toUpperCase()}</PicOr></span>
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
      {f.years.length > 0 && (
        <ViewSec icon="M3 3v18h18M7 15l4-4 3 3 5-6" title="Year by year" sub={`${f.years.length} contract year${f.years.length === 1 ? "" : "s"} from ${cpDay(f.start)}`}>
          <div className="scv-table" role="table">
            <div className="scv-tr is-head" role="row"><span>Year</span><span>Period</span><span className="is-r">List</span><span className="is-r">Increase</span><span className="is-r">Discounts</span><span className="is-r">Invoices</span><span className="is-r">Net</span></div>
            {f.years.map((y, i) => {
              const at = (n: number) => { const d = new Date(`${f.start}T12:00:00`); d.setFullYear(d.getFullYear() + Math.floor(n)); const m = Math.round((n % 1) * 12); if (m) d.setMonth(d.getMonth() + m); return d; };
              const from = at(i).toISOString().slice(0, 10);
              const to = new Date(+at(i + y.share) - 864e5).toISOString().slice(0, 10);
              const today = todayIso();
              const on = today >= from && today <= to;
              const inv = f.invoices.filter((v) => v.date >= from && v.date <= to);
              const off = y.duration + y.payment + y.commercial;
              return (
                <div className={`scv-tr ${on ? "is-now" : ""} ${to < today ? "is-past" : ""}`} role="row" key={y.year}>
                  <span><b>Year {y.year}</b>{y.share < 1 && <em> · {Math.round(y.share * 12)} months</em>}{on && <i className="scv-now">now</i>}</span>
                  <span className="scv-d">{cpDay(from)} – {cpDay(to)}</span>
                  <span className="is-r">{money(y.list)}</span>
                  <span className={`is-r ${y.increment > 0.5 ? "is-up" : ""}`}>{y.increment > 0.5 ? `+${money(y.increment)}` : "—"}</span>
                  <span className="is-r">{off > 0.5 ? `−${money(off)}` : "—"}</span>
                  <span className="is-r">{inv.length ? `${inv.length} · ${money(inv.reduce((t, v) => t + v.amount, 0))}` : "—"}</span>
                  <span className="is-r"><b>{money(y.net)}</b></span>
                </div>
              );
            })}
            <div className="scv-tr is-foot" role="row"><span><b>Total</b></span><span /><span className="is-r">{money(f.list)}</span><span /><span className="is-r">{f.discount > 0.5 ? `−${money(f.discount)}` : "—"}</span><span className="is-r">{f.invoices.length}</span><span className="is-r"><b>{money(f.total)}</b></span></div>
          </div>
        </ViewSec>
      )}
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
