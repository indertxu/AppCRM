/* =====================================================================
   BASE · Billing — one invoice: who it's for, its lines, tax and terms.
   A draft is edited freely; once sent its lines are locked and what's left
   is following it up (paid, void, print, e-mail it again).
   ===================================================================== */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import {
  UNITS, addDays, billToOf, daysBetween, deleteInvoice, fmtDate, lineAmount, mailInvoice, money, newKey, printInvoice,
  round2, saveInvoice, setInvoiceStatus, stateOf, todayIso, totalsOf, STATE_LABEL,
  type BClient, type CatItem, type Draft, type InvLine,
} from "./billingApi";

interface Props {
  draft: Draft;
  clients: BClient[];
  catalog: CatItem[];
  seller: string;
  onClose: () => void;
  /** Saved, sent, paid, deleted…: the lists reload. */
  onChanged: () => void;
}

const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const IC = {
  x: "M18 6L6 18M6 6l12 12",
  plus: "M12 5v14M5 12h14",
  box: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  print: "M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  check: "M20 6L9 17l-5-5",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  undo: "M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 7",
  ban: "M4.9 4.9l14.2 14.2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  mail: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 7l9 6 9-6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
};

/** A number field that keeps what you type until you leave it. */
function Num({ value, onChange, disabled, className, suffix }: { value: number; onChange: (n: number) => void; disabled?: boolean; className?: string; suffix?: string }) {
  const [txt, setTxt] = useState<string | null>(null);
  const shown = txt ?? (value ? String(round2(value)).replace(".", ",") : "0");
  return (
    <span className={`bzi-num ${className ?? ""}`}>
      <input inputMode="decimal" disabled={disabled} value={shown}
        onFocus={(e) => { setTxt(shown); e.currentTarget.select(); }}
        onChange={(e) => { setTxt(e.target.value); const n = Number(e.target.value.replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")); if (!Number.isNaN(n)) onChange(n); }}
        onBlur={() => setTxt(null)} />
      {suffix && <i>{suffix}</i>}
    </span>
  );
}

export default function InvoiceModal({ draft, clients, catalog, seller, onClose, onChanged }: Props) {
  const [d, setD] = useState<Draft>(draft);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickQ, setPickQ] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [closing, setClosing] = useState(false);
  const dirty = useRef(false);
  const locked = d.status !== "draft";
  const state = stateOf({ status: d.status, due_date: addDays(d.issue_date, d.payment_days) });
  const { net, tax, total } = totalsOf(d.lines, d.tax_rate);
  const due = addDays(d.issue_date, d.payment_days);
  const late = d.status === "sent" ? daysBetween(due, todayIso()) : 0;

  const set = (patch: Partial<Draft>) => { dirty.current = true; setD((x) => ({ ...x, ...patch })); };
  const setLine = (k: string, patch: Partial<InvLine>) => set({ lines: d.lines.map((l) => (l.key === k ? { ...l, ...patch } : l)) });
  const addLine = (l?: Partial<InvLine>) => set({ lines: [...d.lines, { key: newKey(), description: "", quantity: 1, unit: "", unit_price: 0, ...l }] });

  const close = () => {
    if (dirty.current && !locked && !window.confirm("Close without saving this invoice?")) return;
    setClosing(true); setTimeout(onClose, 220);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !pickOpen && !document.querySelector(".sel-layer, .dp-layer")) close(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const clientOpts = useMemo(() => clients.map((c) => ({ value: c.id, label: c.name, hint: c.vat || undefined })), [clients]);
  const pickClient = (id: string) => {
    const c = clients.find((x) => x.id === id);
    if (!c) return;
    set({ client_id: id, bill_to: billToOf(c), payment_days: c.payment_days, tax_rate: c.tax_rate });
  };
  const items = useMemo(() => {
    const q = pickQ.trim().toLowerCase();
    return catalog.filter((c) => !q || c.label.toLowerCase().includes(q));
  }, [catalog, pickQ]);
  const addItem = (c: CatItem) => {
    addLine({ description: c.label, quantity: 1, unit: c.unit, unit_price: c.price, product_id: c.kind === "product" ? c.id : null, service_id: c.kind === "service" ? c.id : null });
    setPickOpen(false); setPickQ("");
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setErr(null);
    try { await fn(); dirty.current = false; onChanged(); } catch (e: any) { setErr(e?.message ?? String(e)); }
    setBusy(null);
  };
  const check = () => {
    if (!d.client_id) return "Pick who the invoice is for.";
    if (!d.number.trim()) return "The invoice needs a number.";
    if (!d.lines.some((l) => l.description.trim() && lineAmount(l) !== 0)) return "Add at least one line with an amount.";
    return null;
  };
  const save = (status: Draft["status"] = d.status, extra: Partial<Draft> = {}) => run(status === "sent" && d.status === "draft" ? "send" : "save", async () => {
    const e = check(); if (e) throw new Error(e);
    const next = { ...d, ...extra, status };
    const id = await saveInvoice(next);
    setD({ ...next, id });
    if (status === "sent" && d.status === "draft") mailInvoice(next, seller);
  });
  const mark = (status: Draft["status"], extra: Partial<Draft>, label: string) => run(label, async () => {
    await setInvoiceStatus(d.id!, status, { sent_date: extra.sent_date ?? d.sent_date, paid_date: extra.paid_date === undefined ? d.paid_date : extra.paid_date });
    setD((x) => ({ ...x, status, ...extra }));
  });
  const del = () => run("delete", async () => { await deleteInvoice(d.id!); setClosing(true); setTimeout(onClose, 220); });

  return createPortal(
    <div className={`bzi-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="bzi-modal" role="dialog" aria-modal="true" aria-label={`Invoice ${d.number}`}>
        <header className="bzi-head">
          <div className="bzi-head-t">
            <span className="bzi-kicker">{d.id ? "Invoice" : "New invoice"}</span>
            <div className="bzi-head-row">
              {locked ? <h2>{d.number}</h2> : (
                <input className="bzi-numfield" value={d.number} onChange={(e) => set({ number: e.target.value })} aria-label="Invoice number" />
              )}
              <span className={`bz-pill is-${state}`}>{STATE_LABEL[state]}</span>
              {d.status === "sent" && <span className="bzi-due-note">{late > 0 ? `${late} day${late === 1 ? "" : "s"} late` : late === 0 ? "Due today" : `Due in ${-late} day${late === -1 ? "" : "s"}`}</span>}
              {d.status === "paid" && d.paid_date && <span className="bzi-due-note">Paid {fmtDate(d.paid_date)}</span>}
            </div>
          </div>
          <button className="bzi-x" onClick={close} aria-label="Close"><Ico d={IC.x} s={18} /></button>
        </header>

        <div className="bzi-body">
          <section className="bzi-top">
            <div className="bzi-to">
              <span className="bzi-lbl">Bill to</span>
              {locked ? <strong className="bzi-to-name">{d.bill_to.name || "—"}</strong> : (
                <Select value={d.client_id} onChange={pickClient} options={clientOpts} placeholder="Pick a client…" searchable aria-label="Client" />
              )}
              {d.client_id && (
                <div className="bzi-to-card">
                  <b>{d.bill_to.legal_name || d.bill_to.name}</b>
                  {d.bill_to.vat && <span>VAT {d.bill_to.vat}</span>}
                  {d.bill_to.address && <span>{d.bill_to.address}</span>}
                  {d.bill_to.email ? <span className="bzi-to-mail"><Ico d={IC.mail} s={13} />{d.bill_to.contact ? `${d.bill_to.contact} · ` : ""}{d.bill_to.email}</span>
                    : <span className="bzi-to-warn">No billing e-mail on this client</span>}
                </div>
              )}
            </div>
            <div className="bzi-terms">
              <label><span className="bzi-lbl">Issued</span>
                {locked ? <b>{fmtDate(d.issue_date)}</b> : <DatePicker value={d.issue_date} onChange={(v) => set({ issue_date: v })} />}
              </label>
              <label><span className="bzi-lbl">Pay within</span>
                <Num value={d.payment_days} onChange={(n) => set({ payment_days: Math.max(0, Math.round(n)) })} disabled={locked} suffix="days" className="is-days" />
              </label>
              <div><span className="bzi-lbl">Due</span><b className="bzi-due">{fmtDate(due)}</b></div>
            </div>
          </section>

          <section className="bzi-lines">
            <div className="bzi-lrow bzi-lhead">
              <span>Description</span><span>Qty</span><span>Unit</span><span>Price</span><span>Amount</span><span />
            </div>
            {d.lines.length === 0 && <p className="bzi-empty">No lines yet — add one, or pick a product or service.</p>}
            {d.lines.map((l, i) => (
              <div className="bzi-lrow" key={l.key} style={{ ["--i" as string]: i }}>
                <input className="bzi-desc" value={l.description} disabled={locked} placeholder="What you're billing"
                  onChange={(e) => setLine(l.key, { description: e.target.value })} />
                <Num value={l.quantity} onChange={(n) => setLine(l.key, { quantity: n })} disabled={locked} />
                {locked ? <span className="bzi-unit-ro">{UNITS.find((u) => u.value === l.unit)?.label ?? l.unit}</span> : (
                  <Select size="sm" value={l.unit} onChange={(v) => setLine(l.key, { unit: v })} options={UNITS} aria-label="Unit" />
                )}
                <Num value={l.unit_price} onChange={(n) => setLine(l.key, { unit_price: n })} disabled={locked} suffix="€" />
                <b className="bzi-amt">{money(lineAmount(l))}</b>
                {!locked ? <button className="bzi-lx" onClick={() => set({ lines: d.lines.filter((x) => x.key !== l.key) })} aria-label="Remove line"><Ico d={IC.x} s={14} /></button> : <span />}
              </div>
            ))}
            {!locked && (
              <div className="bzi-add">
                <button className="bzi-addbtn" onClick={() => addLine()}><Ico d={IC.plus} s={14} />Add line</button>
                <div className="bzi-pick-wrap">
                  <button className={`bzi-addbtn ${pickOpen ? "is-on" : ""}`} onClick={() => setPickOpen((v) => !v)}><Ico d={IC.box} s={14} />Product or service</button>
                  {pickOpen && (
                    <div className="bzi-pick" onMouseDown={(e) => e.stopPropagation()}>
                      <label className="bzi-pick-q"><Ico d={IC.search} s={14} /><input autoFocus value={pickQ} placeholder="Search the catalogue" onChange={(e) => setPickQ(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setPickOpen(false); } if (e.key === "Enter" && items[0]) addItem(items[0]); }} /></label>
                      <div className="bzi-pick-list">
                        {items.length === 0 && <p className="bzi-empty">Nothing in the catalogue matches.</p>}
                        {items.map((c) => (
                          <button key={c.key} onClick={() => addItem(c)}>
                            <i className={`is-${c.kind}`}>{c.kind === "product" ? "P" : "S"}</i>
                            <span>{c.label}</span>
                            <b>{money(c.price)}{c.unit && c.unit !== "unit" ? <small> / {UNITS.find((u) => u.value === c.unit)?.label.replace(/s$/, "") ?? c.unit}</small> : null}</b>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {d.entry_ids.length > 0 && <span className="bzi-linked"><Ico d={IC.clock} s={13} />Bills {d.entry_ids.length} calendar entr{d.entry_ids.length === 1 ? "y" : "ies"}</span>}
              </div>
            )}
            {locked && d.entry_ids.length > 0 && <p className="bzi-linked is-ro"><Ico d={IC.clock} s={13} />Bills {d.entry_ids.length} calendar entr{d.entry_ids.length === 1 ? "y" : "ies"}</p>}
          </section>

          <section className="bzi-foot-grid">
            <label className="bzi-notes"><span className="bzi-lbl">Notes on the invoice</span>
              <textarea value={d.notes} disabled={locked} placeholder="Bank details, purchase order, a thank-you…" onChange={(e) => set({ notes: e.target.value })} />
            </label>
            <div className="bzi-totals">
              <div><span>Net</span><b>{money(net)}</b></div>
              <div><span>Tax <Num value={d.tax_rate} onChange={(n) => set({ tax_rate: n })} disabled={locked} suffix="%" className="is-tax" /></span><b>{money(tax)}</b></div>
              <div className="is-total"><span>Total</span><b>{money(total)}</b></div>
            </div>
          </section>
          {err && <p className="bzi-err">{err}</p>}
        </div>

        <footer className="bzi-actions">
          {confirmDel ? (
            <div className="bzi-confirm">
              <span>Delete this draft? Its work goes back to “To bill”.</span>
              <button className="bzi-btn" onClick={() => setConfirmDel(false)}>Keep it</button>
              <button className="bzi-btn is-danger" disabled={!!busy} onClick={del}>{busy === "delete" ? "Deleting…" : "Delete"}</button>
            </div>
          ) : (
            <>
              {d.status === "draft" && d.id && <button className="bzi-btn is-ghost is-danger" onClick={() => setConfirmDel(true)}><Ico d={IC.trash} s={15} />Delete</button>}
              {d.status === "sent" && <button className="bzi-btn is-ghost" disabled={!!busy} onClick={() => mark("void", {}, "void")}><Ico d={IC.ban} s={15} />Void</button>}
              {d.status === "paid" && <button className="bzi-btn is-ghost" disabled={!!busy} onClick={() => mark("sent", { paid_date: null }, "unpay")}><Ico d={IC.undo} s={15} />Mark unpaid</button>}
              {d.status === "void" && <button className="bzi-btn is-ghost" disabled={!!busy} onClick={() => mark("sent", {}, "unvoid")}><Ico d={IC.undo} s={15} />Restore</button>}
              <span className="bzi-sp" />
              <button className="bzi-btn" onClick={() => { if (!printInvoice(d, seller)) setErr("Your browser blocked the print window — allow pop-ups for this site."); }}><Ico d={IC.print} s={15} />Print / PDF</button>
              {d.status === "draft" && <button className="bzi-btn" disabled={!!busy} onClick={() => save("draft")}>{busy === "save" ? "Saving…" : "Save draft"}</button>}
              {d.status === "draft" && <button className="bzi-btn is-primary" disabled={!!busy} onClick={() => save("sent", { sent_date: todayIso() })}><Ico d={IC.send} s={15} />{busy === "send" ? "Sending…" : "Send"}</button>}
              {d.status === "sent" && <button className="bzi-btn" onClick={() => mailInvoice(d, seller)}><Ico d={IC.mail} s={15} />E-mail again</button>}
              {d.status === "sent" && <button className="bzi-btn is-primary" disabled={!!busy} onClick={() => mark("paid", { paid_date: todayIso() }, "paid")}><Ico d={IC.check} s={15} />{busy === "paid" ? "Saving…" : "Mark as paid"}</button>}
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
