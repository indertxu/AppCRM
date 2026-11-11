/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Select from "../../../framework/Select";
import DatePicker from "../../../framework/DatePicker";
import { NumInput } from "../../../framework/NumInput";
import type { Product } from "../../settings/catalogApi";
import ContractTermsForm, { Pct } from "./ContractTermsForm";
import ContractSummary from "./ContractSummary";
import {
  contractFigures, itemFigure, saveDealContract, deleteDealContract, uid,
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
  const byId = useMemo(() => new Map(products.map((p) => [p.id!, p])), [products]);
  const allowed = products.filter((p) => p.active !== false && (!d.productIds.length || d.productIds.includes(p.id!)));
  const setItem = (id: string, p: Partial<ContractItem>) => setD({ items: d.items.map((it) => (it.id === id ? { ...it, ...p } : it)) });
  const addItem = (pid: string) => {
    const p = byId.get(pid);
    if (!p) return;
    const values: Record<string, number> = {};
    (p.calculator?.variables ?? []).forEach((v) => { values[v.id ?? String(v.sort)] = Number(v.default_value) || 0; });
    setD({ items: [...d.items, { id: uid(), product_id: pid, tier_id: p.tiers[0]?.id ?? null, values, quantity: 1 }] });
  };
  const dirty = JSON.stringify(c) !== JSON.stringify(contract);
  const close = () => { if (dirty && !readOnly && !window.confirm("Close without saving the contract?")) return; onClose(); };

  const save = async () => {
    setBusy(true); setErr(null);
    const r = await saveDealContract(c, products);
    setBusy(false);
    if (r.error || !r.row) { setErr(r.error ?? "Not saved"); return; }
    onSaved(r.row);
  };
  const remove = async () => {
    if (!c.id) { onClose(); return; }
    if (!window.confirm(`Remove “${c.name}” from the deal?`)) return;
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
          <span className="ctm-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" /></svg></span>
          <div className="ctm-h-t">
            <em>Contract on the deal</em>
            <input className="ctm-name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="Name the contract" disabled={readOnly} aria-label="Contract name" />
          </div>
          <button type="button" className="ctm-x" onClick={close} aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </header>

        <div className="ctm-body">
          <fieldset className="ctm-main" disabled={readOnly}>
            <section className="ctf-sec">
              <header className="ctf-sec-h">
                <span className="ctf-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5" /></svg></span>
                <div className="ctf-sec-t"><b>What it includes</b><em>Each product counts at what its calculator gives — its own discounts, term and increments are left out: the contract's apply</em></div>
              </header>
              {d.items.length === 0 && <p className="ctm-empty">No products: the contract is its fee of its own.</p>}
              <div className="ctm-items">
                {d.items.map((it) => {
                  const p = byId.get(it.product_id);
                  const fig = itemFigure(it, p);
                  const vars = p?.calculator?.variables ?? [];
                  return (
                    <div className="ctm-item" key={it.id}>
                      <div className="ctm-item-h">
                        <b>{p?.name ?? "Product removed"}</b>
                        {p && p.tiers.length > 1 && (
                          <span className="ctm-tier"><Select size="sm" value={it.tier_id ?? ""} onChange={(v) => setItem(it.id, { tier_id: v })} options={p.tiers.map((t) => ({ value: t.id!, label: t.name, hint: money(Number(t.price) || 0) }))} aria-label="Tier" /></span>
                        )}
                        <span className="ctm-item-fig"><b>{money(fig.amount)}</b><em>{fig.detail}{fig.perYear && fig.detail !== "a year" ? ` · ${money(fig.perYear)} a year` : ""}</em></span>
                        <button type="button" className="ctf-x" onClick={() => setD({ items: d.items.filter((x) => x.id !== it.id) })} aria-label="Take it out">×</button>
                      </div>
                      {vars.length > 0 ? (
                        <div className="ctm-vars">
                          {vars.map((v) => {
                            const k = v.id ?? String(v.sort);
                            return (
                              <label key={k} className="ctm-var">
                                <span title={v.name}>{v.name || "Input"}</span>
                                <span className="ctf-num"><NumInput inputMode="decimal" value={String(it.values?.[k] ?? v.default_value ?? 0)} onChange={(e) => setItem(it.id, { values: { ...it.values, [k]: num(e.target.value) } })} />{v.unit_label ? <span>{v.unit_label}</span> : null}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="ctm-vars">
                          <label className="ctm-var"><span>Quantity</span><span className="ctf-num"><NumInput inputMode="decimal" value={String(it.quantity)} onChange={(e) => setItem(it.id, { quantity: Math.max(0, num(e.target.value)) })} /></span></label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="ctm-addrow">
                {allowed.length > 0 && (
                  <span className="ctm-add"><Select value="" onChange={(v) => v && addItem(v)} searchable placeholder="+ Add a product" options={allowed.map((p) => ({ value: p.id!, label: p.name, hint: p.billing === "recurring" ? (p.billing_period === "yearly" ? "Yearly" : "Monthly") : "One-time" }))} aria-label="Add a product" /></span>
                )}
                <span className="ctm-fee"><span>Fee of its own</span><Pct value={d.fee} onChange={(v) => setD({ fee: Math.max(0, v) })} suffix="€ a year" width={150} label="Fee per year" /></span>
              </div>
            </section>

            <ContractTermsForm value={d} onChange={(cfg) => setD(cfg)}
              pick={{
                term: d.term, payment: d.payment,
                setTerm: (t) => setD({ term: t }), setPayment: (p) => setD({ payment: p }),
                start: <span className="ctm-start"><DatePicker value={d.start ?? ""} onChange={(v) => setD({ start: v || null })} placeholder="When it's signed" />{d.start && <button type="button" className="ctf-add" onClick={() => setD({ start: null })}>When it's signed</button>}</span>,
              }} />
          </fieldset>

          <aside className="ctm-side">
            <ContractSummary f={f} money={money} note={!d.start ? "Dates count from today until a start date is set." : undefined} />
          </aside>
        </div>

        <footer className="ctm-f">
          {err && <p className="ctm-err">{err}</p>}
          {!readOnly && c.id && <button type="button" className="ctm-del" onClick={remove} disabled={busy}>Remove from the deal</button>}
          <span className="ctm-f-sp" />
          <button type="button" className="ctm-btn" onClick={close}>{readOnly ? "Close" : "Cancel"}</button>
          {!readOnly && <button type="button" className="ctm-btn is-main" onClick={save} disabled={busy || (!dirty && !!c.id)}>{busy ? "Saving…" : c.id ? "Save contract" : "Add to the deal"}</button>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
