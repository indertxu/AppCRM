import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Plus, Pencil, Trash2, Star, FileText, Receipt, Building2, Sparkles, Check, ExternalLink, History, BellRing, Wand2 } from "lucide-react";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import { NumInput } from "../../framework/NumInput";
import {
  loadBilling, markBillingSeen, unseenOf, watchBilling, saveEntity, makeEntityDefault, deleteEntity, saveInvoice, deleteInvoice, setInvoiceStatus,
  nextInvoiceNumber, invoiceTotals, entityAddress, eventText, billingMoney, billingDay, billingAgo,
  EMPTY_ENTITY, INVOICE_STATUS, PLAN_NAME,
  type BillingData, type BillingEntity, type BillingInvoice, type BillingEvent, type InvoiceStatus,
} from "../../api/billingApi";
import { Card, Kpi, Modal, useConfirm } from "./SuperAdminHome";
import "./SuperAdminBilling.css";

/* =====================================================================
   Platform console › a company › Billing. The same records the company's
   owner sees in Settings › Your account (SQL 137): who they're billed as,
   and every invoice Next issued them. Changes made on their side show here
   as new (SQL 138), and what Next changes reaches their owner's Home.
   ===================================================================== */

export const BILLING_SEEN_EVENT = "sa:billing-seen";
const STATUS_OPTS = (Object.keys(INVOICE_STATUS) as InvoiceStatus[]).map((s) => ({ value: s, label: INVOICE_STATUS[s] }));
const CURRENCIES = ["EUR", "USD", "GBP", "CHF"].map((c) => ({ value: c, label: c }));
const today = () => new Date().toISOString().slice(0, 10);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return iso(d); };

type InvDraft = Omit<BillingInvoice, "id"> & { id?: string };

export default function CoBilling({ tenantId, tenantName, plan, activeUsers, onSeen }: {
  tenantId: string; tenantName: string; plan: string; activeUsers: number; onSeen?: () => void;
}) {
  const [data, setData] = useState<BillingData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** when this person had last looked, before this visit: what's newer is marked new */
  const [since, setSince] = useState<string | null | undefined>(undefined);
  const sinceRef = useRef<string | null | undefined>(undefined);
  const [edit, setEdit] = useState<(Omit<BillingEntity, "id"> & { id?: string }) | null>(null);
  const [inv, setInv] = useState<InvDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, askEl] = useConfirm();

  const load = async () => {
    try {
      const d = await loadBilling(tenantId);
      setData(d);
      if (sinceRef.current === undefined) { sinceRef.current = d.seenAt; setSince(d.seenAt); }
      if (!d.noEvents) { await markBillingSeen(tenantId).catch(() => {}); onSeen?.(); window.dispatchEvent(new Event(BILLING_SEEN_EVENT)); }
    } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => {
    sinceRef.current = undefined; setSince(undefined); setData(null);
    void load();
    return watchBilling(tenantId, () => void load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const fresh = useMemo(() => (data && since !== undefined ? unseenOf(data.events, "client", since) : []), [data, since]);
  const freshRefs = useMemo(() => new Set(fresh.map((e) => e.ref_id)), [fresh]);
  const ents = data?.entities ?? [];
  const invoices = data?.invoices ?? [];
  const def = ents.find((x) => x.is_default) ?? ents[0] ?? null;
  const paid = invoices.filter((x) => x.status === "paid");
  const open = invoices.filter((x) => x.status === "pending" || x.status === "overdue");
  const cur = invoices[0]?.currency ?? "EUR";
  const last = invoices[0] ?? null;

  const run = async (p: Promise<string | null>) => { setBusy(true); setErr(null); const e = await p; setBusy(false); if (e) setErr(e); else await load(); return !e; };

  const newInvoice = async () => {
    const number = await nextInvoiceNumber().catch(() => `NX-${new Date().getFullYear()}-0001`);
    const start = new Date(); start.setDate(1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    const prev = invoices[0];
    setInv({
      entity_id: def?.id ?? null, number, issued_on: today(), period_start: iso(start), period_end: iso(end), due_on: addDays(today(), 15),
      plan, users: prev?.users ?? activeUsers, price_per_user: prev?.price_per_user ?? 0, discount_pct: prev?.discount_pct ?? 0, net: 0,
      vat_pct: prev?.vat_pct ?? 21, vat: 0, total: 0, currency: prev?.currency ?? "EUR", status: "pending", paid_on: null,
      bill_to_name: def?.legal_name ?? null, bill_to_tax_id: def?.tax_id ?? null, bill_to_address: def ? entityAddress(def) || null : null,
      lines: null, pdf_url: null, notes: null,
    });
  };

  const removeEntity = async (x: BillingEntity) => {
    if (!(await ask({ kicker: "Billing", title: `Remove ${x.legal_name}?`, ok: "Remove", tone: "danger", icon: <Trash2 size={18} />,
      body: <ul className="sa-ask-list"><li>Invoices already issued keep the name and tax ID they were billed to.</li><li>{tenantName}'s owner sees that Next removed it.</li></ul> }))) return;
    await run(deleteEntity(x.id));
  };
  const removeInvoice = async (v: BillingInvoice) => {
    if (!(await ask({ kicker: "Billing", title: `Delete invoice ${v.number}?`, ok: "Delete", tone: "danger", icon: <Trash2 size={18} />,
      body: <ul className="sa-ask-list"><li>It disappears from {tenantName}'s billing history too.</li><li>To keep a record, set it to <b>Void</b> instead.</li></ul> }))) return;
    await run(deleteInvoice(v.id));
  };

  if (!data) return <div className="sa-loading is-sm"><span className="sa-spinner" /> Loading the billing…</div>;
  if (data.notReady) return <div className="sa-alert">Company billing isn't in the database yet: run <code>src/base/sql/137_tenant_billing.sql</code>.</div>;

  return (
    <div className="sab">
      {err && <div className="sa-alert">{err}</div>}

      {fresh.length > 0 && (
        <section className="sab-news" role="status">
          <span className="sab-news-ico"><BellRing size={18} strokeWidth={2} /></span>
          <div className="sab-news-txt">
            <b>{tenantName} changed their billing</b>
            <ul>
              {fresh.slice(0, 4).map((e) => { const t = eventText(e); return <li key={e.id}><b>{e.actor_name ?? "Someone"}</b> {t.what}{t.detail && <em> · {t.detail}</em>}<i>{billingAgo(e.created_at)}</i></li>; })}
              {fresh.length > 4 && <li className="is-more">and {fresh.length - 4} more below</li>}
            </ul>
          </div>
          <button type="button" className="sa-btn" onClick={() => { const now = new Date().toISOString(); sinceRef.current = now; setSince(now); }}><Check size={15} /> <span>Got it</span></button>
        </section>
      )}

      <div className="sa-kpis is-4 sab-kpis">
        <Kpi label="Billed as" value={def ? def.legal_name : "—"} sub={def ? `${def.tax_id}${ents.length > 1 ? ` · ${ents.length} entities` : ""}` : "No entity yet"} />
        <Kpi label="Paid so far" value={billingMoney(paid.reduce((s, x) => s + x.total, 0), cur)} sub={`${paid.length} of ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`} />
        <Kpi label="Outstanding" value={billingMoney(open.reduce((s, x) => s + x.total, 0), cur)} sub={open.length ? `${open.length} open · ${open.filter((x) => x.status === "overdue").length} overdue` : "Nothing open"}
          tone={open.some((x) => x.status === "overdue") ? "bad" : undefined} />
        <Kpi label="Last invoice" value={last ? billingMoney(last.total, last.currency) : "—"} sub={last ? `${last.number} · ${billingDay(last.issued_on)}` : "None yet"} />
      </div>

      <div className="sa-row sab-row">
        <Card className="sab-ents" title={<span className="sab-h"><Building2 size={16} /> Billed as</span>}
          sub={`The legal entities and tax IDs ${tenantName} is invoiced under. Their owner sees and edits this same list.`}
          right={!edit && <button type="button" className="sa-btn is-primary" onClick={() => setEdit({ ...EMPTY_ENTITY })}><Plus size={15} strokeWidth={2.2} /> <span>Add entity</span></button>}>
          {edit && (
            <EntityForm value={edit} onChange={setEdit} busy={busy} onCancel={() => setEdit(null)}
              onSave={async () => { if (await run(saveEntity(edit, tenantId, !ents.length))) setEdit(null); }} />
          )}
          {!ents.length && !edit && <p className="sab-empty">No billing entity yet. Add the legal name and tax ID their invoices should carry — or wait for the owner to fill it in on their side.</p>}
          <div className="sab-ents-list">
            {ents.map((x) => (
              <div key={x.id} className={`sab-ent ${x.is_default ? "is-default" : ""} ${freshRefs.has(x.id) ? "is-new" : ""}`}>
                <button type="button" className="sab-star" title={x.is_default ? "Used by default" : "Use by default"} aria-label={x.is_default ? "Default entity" : "Use by default"}
                  onClick={() => !x.is_default && void run(makeEntityDefault(x.id))}><Star size={15} strokeWidth={2} /></button>
                <div className="sab-ent-txt">
                  <b>{x.legal_name}{freshRefs.has(x.id) && <i className="sab-new">Updated by them</i>}</b>
                  <span className="sab-tax">{x.tax_id}</span>
                  <small>{entityAddress(x) || "No address yet"}</small>
                  {(x.email || x.iban || x.po_reference || x.phone) && (
                    <small>{[x.email, x.phone, x.iban && `IBAN ${x.iban}`, x.po_reference && `Ref. ${x.po_reference}`].filter(Boolean).join(" · ")}</small>
                  )}
                </div>
                <span className="sab-acts">
                  <button type="button" className="sa-icon" aria-label="Edit" title="Edit" onClick={() => setEdit({ ...x })}><Pencil size={14} /></button>
                  <button type="button" className="sa-icon is-danger" aria-label="Remove" title="Remove" onClick={() => void removeEntity(x)}><Trash2 size={14} /></button>
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="sab-feed-card" title={<span className="sab-h"><History size={16} /> Changes</span>} sub="Both sides, newest first">
          {data.noEvents ? <p className="sab-empty">The change history starts once <code>sql/138_tenant_billing_events.sql</code> is in the database.</p>
            : !data.events.length ? <p className="sab-empty">Nothing changed yet.</p>
            : <Feed events={data.events} fresh={new Set(fresh.map((e) => e.id))} viewer="next" />}
        </Card>
      </div>

      <Card className="sab-inv-card" title={<span className="sab-h"><Receipt size={16} /> Invoices</span>}
        sub={`What Next billed ${tenantName} for the CRM. They see every invoice in their account, with the detail.`}
        right={<button type="button" className="sa-btn is-primary" onClick={() => void newInvoice()}><Plus size={15} strokeWidth={2.2} /> <span>New invoice</span></button>}>
        {!invoices.length ? <p className="sab-empty">No invoices yet. <button type="button" className="sa-link" onClick={() => void newInvoice()}>Issue the first one</button>.</p> : (
          <div className="sa-tablewrap">
            <table className="sa-table sab-inv">
              <thead><tr>
                <th>Invoice</th><th>Period</th><th>Billed to</th><th className="is-num">Users</th><th className="is-num">Per user</th>
                <th className="is-num">Total</th><th>Status</th><th className="is-act" aria-label="Actions" />
              </tr></thead>
              <tbody>
                {invoices.map((v) => {
                  const ent = ents.find((x) => x.id === v.entity_id);
                  return (
                    <tr key={v.id} className={freshRefs.has(v.id) ? "is-new" : ""}>
                      <td><b className="sab-num">{v.number}</b><small>{billingDay(v.issued_on)}{v.due_on ? ` · due ${billingDay(v.due_on)}` : ""}</small></td>
                      <td>{v.period_start ? `${billingDay(v.period_start)} – ${billingDay(v.period_end)}` : "—"}<small>{PLAN_NAME[v.plan ?? ""] ?? v.plan ?? ""}</small></td>
                      <td className="sab-to"><b>{v.bill_to_name ?? ent?.legal_name ?? "—"}</b><small>{v.bill_to_tax_id ?? ent?.tax_id ?? ""}</small></td>
                      <td className="is-num">{v.users}</td>
                      <td className="is-num">{billingMoney(v.price_per_user, v.currency)}{v.discount_pct > 0 && <small>−{v.discount_pct}%</small>}</td>
                      <td className="is-num"><b>{billingMoney(v.total, v.currency)}</b><small>{billingMoney(v.net, v.currency)} + VAT</small></td>
                      <td>
                        <span className={`sab-status is-${v.status}`}>
                          <Select size="sm" value={v.status} options={STATUS_OPTS} aria-label={`Status of ${v.number}`} onChange={(s) => void run(setInvoiceStatus(v.id, s as InvoiceStatus))} />
                        </span>
                      </td>
                      <td className="is-act">
                        {v.pdf_url && <a className="sa-icon" href={v.pdf_url} target="_blank" rel="noreferrer" aria-label="Open the PDF" title="Open the PDF"><ExternalLink size={14} /></a>}
                        <button type="button" className="sa-icon" aria-label="Edit" title="Edit" onClick={() => setInv({ ...v })}><Pencil size={14} /></button>
                        <button type="button" className="sa-icon is-danger" aria-label="Delete" title="Delete" onClick={() => void removeInvoice(v)}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {inv && <InvoiceModal value={inv} entities={ents} tenantName={tenantName} busy={busy} onClose={() => setInv(null)}
        onSave={async (v) => { if (await run(saveInvoice(v, tenantId))) setInv(null); }} />}
      {askEl}
    </div>
  );
}

/* ---------- the change feed (also used on the company's side) ---------- */
export function Feed({ events, fresh, viewer }: { events: BillingEvent[]; fresh: Set<string>; viewer: "next" | "client" }) {
  return (
    <ol className="sab-feed">
      {events.slice(0, 30).map((e) => {
        const t = eventText(e);
        const who = e.actor_name ?? (e.side === "next" ? "Next" : "The company");
        return (
          <li key={e.id} className={`is-${e.side} ${fresh.has(e.id) ? "is-new" : ""}`}>
            <span className="sab-feed-dot" aria-hidden="true">{e.kind.startsWith("invoice") ? <FileText size={13} /> : <Building2 size={13} />}</span>
            <div>
              <p><b>{who}</b> {t.what}{t.detail && <em> — {t.detail}</em>}</p>
              <small><span className={`sab-side is-${e.side}`}>{e.side === "next" ? "Next" : viewer === "next" ? "Company" : "Your company"}</span> {billingAgo(e.created_at)}{fresh.has(e.id) && <i className="sab-new">New</i>}</small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- forms ---------- */
function EntityForm({ value, onChange, onSave, onCancel, busy }: {
  value: Omit<BillingEntity, "id"> & { id?: string }; onChange: (v: Omit<BillingEntity, "id"> & { id?: string }) => void; onSave: () => void; onCancel: () => void; busy: boolean;
}) {
  const f = (k: keyof BillingEntity) => (e: ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  const ok = value.legal_name.trim() && value.tax_id.trim();
  return (
    <div className="sab-form">
      <div className="sab-grid">
        <label className="sa-mf"><span>Legal name *</span><input autoFocus value={value.legal_name} onChange={f("legal_name")} placeholder="Company SL" /></label>
        <label className="sa-mf"><span>Tax ID (CIF / VAT) *</span><input value={value.tax_id} onChange={f("tax_id")} placeholder="ESB12345678" /></label>
        <label className="sa-mf"><span>Billing e-mail</span><input value={value.email ?? ""} onChange={f("email")} placeholder="billing@company.com" /></label>
        <label className="sa-mf"><span>Phone</span><input value={value.phone ?? ""} onChange={f("phone")} /></label>
        <label className="sa-mf is-wide"><span>Address</span><input value={value.street ?? ""} onChange={f("street")} placeholder="Street and number" /></label>
        <label className="sa-mf"><span>Postal code</span><input value={value.postal_code ?? ""} onChange={f("postal_code")} /></label>
        <label className="sa-mf"><span>City</span><input value={value.city ?? ""} onChange={f("city")} /></label>
        <label className="sa-mf"><span>Province</span><input value={value.province ?? ""} onChange={f("province")} /></label>
        <label className="sa-mf"><span>Country</span><input value={value.country ?? ""} onChange={f("country")} /></label>
        <label className="sa-mf"><span>IBAN (direct debit)</span><input value={value.iban ?? ""} onChange={f("iban")} placeholder="ES00 0000 0000 0000 0000 0000" /></label>
        <label className="sa-mf"><span>PO / reference</span><input value={value.po_reference ?? ""} onChange={f("po_reference")} placeholder="On every invoice" /></label>
      </div>
      <div className="sab-form-foot">
        <button type="button" className={`sab-check ${value.is_default ? "is-on" : ""}`} onClick={() => onChange({ ...value, is_default: !value.is_default })}><i><Star size={12} /></i>Use by default</button>
        <span className="sab-grow" />
        <button type="button" className="sa-cancel" onClick={onCancel}>Cancel</button>
        <button type="button" className="sa-confirm" disabled={busy || !ok} onClick={onSave}>{busy ? "Saving…" : value.id ? "Save" : "Add entity"}</button>
      </div>
    </div>
  );
}

function InvoiceModal({ value, entities, tenantName, busy, onClose, onSave }: {
  value: InvDraft; entities: BillingEntity[]; tenantName: string; busy: boolean; onClose: () => void; onSave: (v: InvDraft) => void;
}) {
  const [v, setV] = useState<InvDraft>(value);
  const set = (p: Partial<InvDraft>) => setV((x) => ({ ...x, ...p }));
  const t = invoiceTotals(v);
  const pickEntity = (id: string) => {
    const e = entities.find((x) => x.id === id);
    set({ entity_id: id || null, bill_to_name: e?.legal_name ?? null, bill_to_tax_id: e?.tax_id ?? null, bill_to_address: e ? entityAddress(e) || null : null });
  };
  const period = (k: "month" | "quarter" | "year") => {
    const d = new Date(); const y = d.getFullYear(), m = d.getMonth();
    const [s, e] = k === "month" ? [new Date(y, m, 1), new Date(y, m + 1, 0)] : k === "quarter" ? [new Date(y, m - (m % 3), 1), new Date(y, m - (m % 3) + 3, 0)] : [new Date(y, 0, 1), new Date(y, 11, 31)];
    set({ period_start: iso(s), period_end: iso(e) });
  };
  const ok = v.number.trim() && v.issued_on && v.users >= 0 && v.price_per_user >= 0;
  return (
    <Modal icon={<Receipt size={19} strokeWidth={1.9} />} kicker={v.id ? "Edit invoice" : "New invoice"} title={v.id ? v.number : `Bill ${tenantName}`}
      sub={v.id ? `${tenantName} sees the change in their account.` : `${tenantName}'s owner sees it in their account and gets a notification.`}
      width={760} onClose={onClose}
      foot={<>
        <span className="sa-modal-note">Totals are worked out from users × price × months, less the discount, plus VAT.</span>
        <div className="sa-modal-actions">
          <button className="sa-cancel" onClick={onClose}>Cancel</button>
          <button className="sa-confirm" disabled={busy || !ok} onClick={() => onSave(v)}>{busy ? "Saving…" : v.id ? "Save invoice" : "Issue invoice"}</button>
        </div>
      </>}>
      <div className="sab-inv-form">
        <div className="sab-inv-fields">
          <div className="sab-grid is-3">
            <label className="sa-mf"><span>Number</span><input value={v.number} onChange={(e) => set({ number: e.target.value })} /></label>
            <div className="sa-mf"><span>Date</span><DatePicker value={v.issued_on} onChange={(d) => set({ issued_on: d })} /></div>
            <div className="sa-mf"><span>Due</span><DatePicker value={v.due_on ?? ""} onChange={(d) => set({ due_on: d || null })} placeholder="No due date" /></div>
          </div>
          <div className="sa-mf">
            <span>Period <em className="sab-quick">{(["month", "quarter", "year"] as const).map((k) => <button key={k} type="button" onClick={() => period(k)}><Wand2 size={11} /> This {k}</button>)}</em></span>
            <div className="sab-grid is-2">
              <DatePicker value={v.period_start ?? ""} onChange={(d) => set({ period_start: d || null })} placeholder="From" />
              <DatePicker value={v.period_end ?? ""} onChange={(d) => set({ period_end: d || null })} placeholder="To" />
            </div>
          </div>
          <div className="sab-grid is-2">
            <div className="sa-mf"><span>Billed to</span>
              <span className="sa-chipsel is-full"><Select value={v.entity_id ?? ""} onChange={pickEntity} aria-label="Billed to"
                options={[{ value: "", label: entities.length ? "No entity" : "No entity yet — add one first" }, ...entities.map((e) => ({ value: e.id, label: e.legal_name, hint: e.tax_id }))]} /></span>
            </div>
            <div className="sa-mf"><span>Plan</span>
              <span className="sa-seg sab-plan" role="radiogroup" aria-label="Plan">
                {(["enterprise", "base"] as const).map((p) => <button key={p} type="button" role="radio" aria-checked={v.plan === p} className={v.plan === p ? "is-on" : ""} onClick={() => set({ plan: p })}>{PLAN_NAME[p]}</button>)}
              </span>
            </div>
          </div>
          <div className="sab-grid is-4">
            <label className="sa-mf"><span>Users</span><NumInput value={v.users} onChange={(e) => set({ users: Math.max(0, Math.round(Number(e.target.value.replace(",", ".")) || 0)) })} /></label>
            <label className="sa-mf"><span>Per user / mo</span><NumInput value={v.price_per_user} onChange={(e) => set({ price_per_user: Math.max(0, Number(e.target.value.replace(",", ".")) || 0) })} /></label>
            <label className="sa-mf"><span>Discount %</span><NumInput value={v.discount_pct} onChange={(e) => set({ discount_pct: Math.min(100, Math.max(0, Number(e.target.value.replace(",", ".")) || 0)) })} /></label>
            <label className="sa-mf"><span>VAT %</span><NumInput value={v.vat_pct} onChange={(e) => set({ vat_pct: Math.min(100, Math.max(0, Number(e.target.value.replace(",", ".")) || 0)) })} /></label>
          </div>
          <div className="sab-grid is-2">
            <div className="sa-mf"><span>Status</span><span className="sa-chipsel is-full"><Select value={v.status} onChange={(s) => set({ status: s as InvoiceStatus })} options={STATUS_OPTS} aria-label="Status" /></span></div>
            <div className="sa-mf"><span>Currency</span><span className="sa-chipsel is-full"><Select value={v.currency} onChange={(c) => set({ currency: c })} options={CURRENCIES} aria-label="Currency" /></span></div>
          </div>
          <label className="sa-mf"><span>PDF link</span><input value={v.pdf_url ?? ""} onChange={(e) => set({ pdf_url: e.target.value })} placeholder="https://…" /></label>
          <label className="sa-mf"><span>Note for them</span><textarea rows={2} value={v.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="Shown on the invoice in their account" /></label>
        </div>
        <aside className="sab-sum">
          <span className="sab-sum-k"><Sparkles size={13} /> The invoice</span>
          <b className="sab-sum-to">{v.bill_to_name ?? "No entity"}</b>
          <small>{[v.bill_to_tax_id, v.bill_to_address].filter(Boolean).join(" · ") || "Pick who it's billed to"}</small>
          <div className="sab-sum-lines">
            <div><span>{v.users} user{v.users === 1 ? "" : "s"} × {billingMoney(v.price_per_user, v.currency)}{t.months > 1 ? ` × ${t.months} months` : " / month"}</span><b>{billingMoney(t.gross, v.currency)}</b></div>
            {v.discount_pct > 0 && <div className="is-disc"><span>Discount {v.discount_pct}%</span><b>−{billingMoney(t.discount, v.currency)}</b></div>}
            <div className="is-sub"><span>Net</span><b>{billingMoney(t.net, v.currency)}</b></div>
            <div><span>VAT {v.vat_pct}%</span><b>{billingMoney(t.vat, v.currency)}</b></div>
          </div>
          <div className="sab-sum-total"><span>Total</span><b>{billingMoney(t.total, v.currency)}</b></div>
          <span className={`sab-status-pill is-${v.status}`}>{INVOICE_STATUS[v.status]}</span>
        </aside>
      </div>
    </Modal>
  );
}

/** Small "N new" badge text for the company tab. */
export const billingBadge = (n: number) => (n > 0 ? (n > 9 ? "9+" : String(n)) : null);
