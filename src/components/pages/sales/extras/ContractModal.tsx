/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Select from "../../../framework/Select";
import DatePicker from "../../../framework/DatePicker";
import { NumInput } from "../../../framework/NumInput";
import type { Product } from "../../settings/catalogApi";
import ContractTermsForm, { Pct, Sec, Ico, TermInput } from "./ContractTermsForm";
import ContractConfirm, { useEscape } from "./ContractConfirm";
import { graceLabel } from "./ContractPlan";
import ContractSummary, { PriceMatrix } from "./ContractSummary";
import {
  contractFigures, contractDates, itemFigure, pricingMatrix, saveDealContract, deleteDealContract, uid, termLabel, PAY_LABEL,
  type DealContract, type ContractItem,
} from "./contractsApi";
import "./ContractTerms.css";

/* =====================================================================
   A contract on a deal: what it includes (products, each priced by its
   calculator — the product's own discounts, term and increments don't
   count, the contract's do — or just a fee of its own), its terms, and
   what it comes to, year by year and invoice by invoice.
   ===================================================================== */

const num = (v: string) => { const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const DOC = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4";
const BOX = "M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5";
const billLabel = (p: Product) => (p.billing === "recurring" ? (p.billing_period === "yearly" ? "Yearly" : "Monthly") : "One-time");

export default function ContractModal({ contract, products, money, readOnly, onClose, onSaved, onDeleted }: {
  contract: DealContract;
  products: Product[];
  money: (n: number) => string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (c: DealContract) => void;
  onDeleted: (id: string) => void;
}) {
  const [c, setC] = useState<DealContract>(() => structuredClone(contract));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = c.data;
  const setD = (p: Partial<DealContract["data"]>) => setC((x) => ({ ...x, data: { ...x.data, ...p } }));
  const f = useMemo(() => contractFigures(d, products), [d, products]);
  const m = useMemo(() => pricingMatrix(d, products), [d, products]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id!, p])), [products]);
  const allowed = products.filter((p) => p.active !== false && (!d.productIds.length || d.productIds.includes(p.id!)));
  const inIds = new Set(d.items.map((it) => it.product_id));
  const quick = allowed.filter((p) => !inIds.has(p.id!)).slice(0, 5);
  const setItem = (id: string, p: Partial<ContractItem>) => setD({ items: d.items.map((it) => (it.id === id ? { ...it, ...p } : it)) });
  const addItem = (pid: string) => {
    const p = byId.get(pid);
    if (!p) return;
    const values: Record<string, number> = {};
    (p.calculator?.variables ?? []).forEach((v) => { values[v.id ?? String(v.sort)] = Number(v.default_value) || 0; });
    setD({ items: [...d.items, { id: uid(), product_id: pid, tier_id: p.tiers[0]?.id ?? null, values, quantity: 1 }] });
  };
  const dirty = JSON.stringify(c) !== JSON.stringify(contract);
  const [ask, setAsk] = useState<null | "close" | "remove">(null);
  const close = () => { if (dirty && !readOnly) { setAsk("close"); return; } onClose(); };
  useEscape(() => { if (ask) setAsk(null); else close(); });
  const dt = contractDates(d);
  const itemsYear = d.items.reduce((s, it) => s + itemFigure(it, byId.get(it.product_id)).perYear, 0);

  const save = async () => {
    setBusy(true); setErr(null);
    const r = await saveDealContract(c, products);
    setBusy(false);
    if (r.error || !r.row) { setErr(r.error ?? "Not saved"); setAsk(null); return; }
    onSaved(r.row);
  };
  const remove = async () => {
    if (!c.id) { onClose(); return; }
    setBusy(true);
    const e = await deleteDealContract(c.id);
    setBusy(false);
    if (e) { setErr(e); return; }
    onDeleted(c.id);
  };

  return createPortal(
    <div className="ctm-back" onMouseDown={close}>
      <div className="ctm" role="dialog" aria-modal="true" aria-label="Contract" onMouseDown={(e) => e.stopPropagation()}>
        <header className="ctm-h">
          <span className="ctm-ico" aria-hidden="true"><Ico d={DOC} /></span>
          <div className="ctm-h-t">
            <em>Contract on the deal{readOnly ? " · read only" : ""}</em>
            <input className="ctm-name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="Name the contract" disabled={readOnly} aria-label="Contract name" />
          </div>
          <span className="ctm-pill" title="What it comes to with these terms">
            <span><em>{termLabel(d.term)} · {PAY_LABEL[d.payment]}</em><b>{money(f.total)}</b></span>
          </span>
          <button type="button" className="ctm-x" onClick={close} aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </header>

        <div className="ctm-body">
          <fieldset className="ctm-main" disabled={readOnly}>
            <Sec icon={BOX} n={1} title="What it includes" sub="Each product at what its calculator gives — its own discounts, term and increments are left out: the contract's apply"
              aside={d.items.length > 0 ? <span className="ctm-sec-fig">{money(itemsYear + (Number(d.fee) || 0))}<em>a year</em></span> : undefined}>
              <div className="ctm-items">
                {d.items.map((it) => {
                  const p = byId.get(it.product_id);
                  const fig = itemFigure(it, p);
                  const vars = p?.calculator?.variables ?? [];
                  return (
                    <div className="ctm-item" key={it.id}>
                      <div className="ctm-item-h">
                        <span className="ctm-item-ini" aria-hidden="true">{(p?.name ?? "?").trim().slice(0, 1).toUpperCase()}</span>
                        <span className="ctm-item-t">
                          <b>{p?.name ?? "Product removed"}</b>
                          {p && <em>{billLabel(p)}{vars.length ? " · priced by its calculator" : ""}</em>}
                        </span>
                        {p && p.tiers.length > 1 && (
                          <span className="ctm-tier"><Select size="sm" value={it.tier_id ?? ""} onChange={(v) => setItem(it.id, { tier_id: v })} options={p.tiers.map((t) => ({ value: t.id!, label: t.name, hint: money(Number(t.price) || 0) }))} aria-label="Tier" /></span>
                        )}
                        <span className="ctm-item-fig"><b>{money(fig.amount)}</b><em>{fig.detail}{fig.perYear && fig.detail !== "a year" ? ` · ${money(fig.perYear)}/yr` : ""}</em></span>
                        <button type="button" className="ctf-x" onClick={() => setD({ items: d.items.filter((x) => x.id !== it.id) })} aria-label="Take it out" title="Take it out">×</button>
                      </div>
                      <div className="ctm-item-b">
                        <div className="ctm-vars">
                          {vars.length > 0 ? vars.map((v) => {
                            const k = v.id ?? String(v.sort);
                            return (
                              <label key={k} className="ctm-var">
                                <span title={v.name}>{v.name || "Input"}</span>
                                <span className="ctf-num"><NumInput inputMode="decimal" value={String(it.values?.[k] ?? v.default_value ?? 0)} onChange={(e) => setItem(it.id, { values: { ...it.values, [k]: num(e.target.value) } })} />{v.unit_label ? <span>{v.unit_label}</span> : null}</span>
                              </label>
                            );
                          }) : (
                            <label className="ctm-var"><span>Quantity</span><span className="ctf-num"><NumInput inputMode="decimal" value={String(it.quantity)} onChange={(e) => setItem(it.id, { quantity: Math.max(0, num(e.target.value)) })} /></span></label>
                          )}
                        </div>
                        {fig.rows.length > 0 && (
                          <div className="ctm-calc">
                            {fig.rows.map((r, i) => (
                              <div key={i} className={`ctm-calc-r ${r.amount < 0 ? "is-off" : ""}`}>
                                <span title={r.label}>{r.label}</span>
                                {r.detail && <em title={r.detail}>{r.detail}</em>}
                                <b>{r.amount < 0 ? `−${money(-r.amount)}` : money(r.amount)}</b>
                              </div>
                            ))}
                            {fig.rows.length > 1 && <div className="ctm-calc-r is-total"><span>Comes to</span><b>{money(fig.amount)}</b></div>}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div className={`ctm-item is-fee ${Number(d.fee) ? "is-on" : ""}`}>
                  <div className="ctm-item-h">
                    <span className="ctm-item-ini is-fee" aria-hidden="true">€</span>
                    <span className="ctm-item-t"><b>Fee of its own</b><em>{d.items.length ? "On top of its products" : "No products: the contract is this fee"}</em></span>
                    <Pct value={d.fee} onChange={(v) => setD({ fee: Math.max(0, v) })} suffix="€ a year" width={160} label="Fee per year" />
                  </div>
                </div>
              </div>
              {!readOnly && allowed.length > 0 && (
                <div className="ctm-addrow">
                  {quick.map((p) => (
                    <button key={p.id} type="button" className="ctm-quick" onClick={() => addItem(p.id!)} title={`Add ${p.name}`}>
                      <span>+</span>{p.name}<em>{billLabel(p)}</em>
                    </button>
                  ))}
                  {allowed.length > quick.length && (
                    <span className="ctm-add"><Select size="sm" value="" onChange={(v) => v && addItem(v)} searchable placeholder="More products…" options={allowed.map((p) => ({ value: p.id!, label: p.name, hint: billLabel(p) }))} aria-label="Add a product" /></span>
                  )}
                </div>
              )}
            </Sec>

            <ContractTermsForm value={d} onChange={(cfg) => setD(cfg)}
              pick={{
                term: d.term, payment: d.payment,
                setTerm: (t) => setD({ term: t }), setPayment: (p) => setD({ payment: p }),
                start: (
                  <div className="ctd">
                    <div className="ctd-box">
                      <span className="ctd-k">Signed</span>
                      <DatePicker value={d.signed ?? ""} onChange={(v) => setD({ signed: v || null })} placeholder="Not yet" />
                      <em>{d.signed ? "The day it's signed" : "Not signed yet — counts from today"}</em>
                    </div>
                    <span className="ctd-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>
                    <div className={`ctd-box is-grace ${dt.graceDays ? "is-on" : ""}`}>
                      <span className="ctd-k">Grace period</span>
                      {d.start ? (
                        <span className="ctd-fixed">{dt.graceDays ? graceLabel(dt.graceDays) : "None"}<button type="button" onClick={() => setD({ start: null, grace: dt.graceDays ? { value: dt.graceDays, unit: "days" } : null })}>Set it</button></span>
                      ) : (
                        <span className="ctd-grace">
                          <TermInput value={d.grace ?? { value: 0, unit: "months" }} onChange={(t) => setD({ grace: t.value > 0 ? t : null })} />
                        </span>
                      )}
                      <em>{dt.graceDays ? "Signed now, it starts later" : "It starts the day it's signed"}</em>
                    </div>
                    <span className="ctd-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>
                    <div className={`ctd-box is-start ${d.start ? "is-set" : ""}`}>
                      <span className="ctd-k">Starts</span>
                      <DatePicker value={dt.start} onChange={(v) => setD({ start: v || null })} placeholder="Start" />
                      <em>{d.start ? <>Set by hand · <button type="button" onClick={() => setD({ start: null })}>use signed + grace</button></> : "Signed + grace period"}</em>
                    </div>
                  </div>
                ),
              }} />
          </fieldset>

          <aside className="ctm-side">
            <ContractSummary f={f} money={money} note={!d.signed && !d.start ? "Not signed yet: dates count from today until you set the signing day." : undefined}
              matrix={<PriceMatrix m={m} term={d.term} payment={d.payment} money={money} onPick={readOnly ? undefined : (t, p) => setD({ term: t, payment: p })} />} />
          </aside>
        </div>

        <footer className="ctm-f">
          {err && <p className="ctm-err">{err}</p>}
          {!readOnly && c.id && <button type="button" className="ctm-del" onClick={() => setAsk("remove")} disabled={busy}>Remove from the deal</button>}
          <span className="ctm-f-sp" />
          <span className="ctm-f-sum">Year 1 <b>{money(f.firstYear)}</b> · {f.invoices.length} invoice{f.invoices.length === 1 ? "" : "s"}</span>
          <button type="button" className="ctm-btn" onClick={close}>{readOnly ? "Close" : "Cancel"}</button>
          {!readOnly && <button type="button" className="ctm-btn is-main" onClick={save} disabled={busy || (!dirty && !!c.id)}>{busy ? "Saving…" : c.id ? "Save contract" : "Add to the deal"}</button>}
        </footer>
        {ask === "close" && (
          <ContractConfirm title="Save the contract before closing?" body={c.id ? "You changed this contract; the changes aren't saved yet." : "This contract isn't on the deal yet."}
            onCancel={() => setAsk(null)}
            actions={[{ label: "Discard", tone: "danger", onClick: onClose }, { label: busy ? "Saving…" : c.id ? "Save and close" : "Add to the deal", tone: "main", onClick: () => void save(), disabled: busy }]} />
        )}
        {ask === "remove" && (
          <ContractConfirm icon="trash" title={`Remove “${c.name}” from the deal?`} body="Its terms, products and payment plan go with it. The template stays in the catalog."
            onCancel={() => setAsk(null)} actions={[{ label: busy ? "Removing…" : "Remove", tone: "danger", onClick: () => void remove(), disabled: busy }]} />
        )}
      </div>
    </div>,
    document.body,
  );
}
