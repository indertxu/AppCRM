/* =====================================================================
   BASE · Calendar — log what you did for a client, simply:
     Client work — hours for a client (billable = the hours); they add up
                   in Billing › To bill and in Billing › Time
     Shipment    — a product sent to a client (quantity × price); it can
                   become a draft invoice right away
     Something else — any other time: a title and when (internal, a meeting…);
                   the full booking (invites, repeats) is one link away
   Only clients whose team you're on (or with no team) can be picked, unless
   you see Management. Once an entry is on an invoice it's read-only.
   (103_base_billing.sql: calendar_entries.kind / product_id / quantity /
   unit_price / invoice_id)
   ===================================================================== */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../components/api/supabase";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import TimePicker from "../../framework/TimePicker";
import { usePageAccess } from "../../framework/pageAccess";
import {
  loadCatalog, loadClients, nextNumber, draftFor, saveInvoice, money, round2, newKey, type CatItem, type BClient,
} from "../billing/billingApi";
import "./WorkModal.css";

export type WorkKind = "client_work" | "shipment" | "internal";
export interface WorkRow {
  id: string; entry_date: string; start_min: number; end_min: number; client_id: string | null; notes: string | null;
  kind: string; product_id: string | null; quantity: number | null; unit_price: number | null; invoice_id: string | null;
  status?: string; name?: string | null;
}

interface Props {
  /** The day and time picked on the grid (a new entry), or the entry opened. */
  day: Date; startMin: number; endMin: number;
  entry?: WorkRow | null;
  myId: string;
  /** "Something else": open the full booking instead. */
  onOther?: () => void;
  onSaved: (row: Record<string, unknown>) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");
const toHM = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const fromHM = (s: string) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const keyOf = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${y}-${m - 1}-${d}`; };
const I = {
  work: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  ship: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  other: "M8 2v3M16 2v3M3.5 9h17M5 4.5h14A1.5 1.5 0 0 1 20.5 6v13A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5z",
  x: "M18 6L6 18M6 6l12 12",
  go: "M9 18l6-6-6-6",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  back: "M15 18l-6-6 6-6",
};
const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

let clientCache: Promise<BClient[]> | null = null;
let catCache: Promise<CatItem[]> | null = null;

export default function WorkModal({ day, startMin, endMin, entry, myId, onOther, onSaved, onDeleted, onClose }: Props) {
  const navigate = useNavigate();
  const access = usePageAccess();
  const anyClient = access.isSuper || access.canSee("management") || (access.level ?? "") === "boss";
  const editing = !!entry;
  const billed = !!entry?.invoice_id;
  const [kind, setKind] = useState<WorkKind | null>(entry ? (entry.kind === "shipment" || entry.kind === "internal" ? entry.kind : "client_work") : null);
  const [title, setTitle] = useState(entry?.kind === "internal" ? entry.name ?? "" : "");
  const [clientId, setClientId] = useState(entry?.client_id ?? "");
  const [date, setDate] = useState(entry?.entry_date ?? isoOf(day));
  const [from, setFrom] = useState(toHM(entry?.start_min ?? startMin));
  const [to, setTo] = useState(toHM(entry?.end_min ?? endMin));
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [item, setItem] = useState<string>("");
  const [qty, setQty] = useState(String(entry?.quantity ?? 1));
  const [price, setPrice] = useState(entry?.unit_price != null ? String(entry.unit_price) : "");
  const [invoiceNow, setInvoiceNow] = useState(true);
  const [clients, setClients] = useState<BClient[] | null>(null);
  const [catalog, setCatalog] = useState<CatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [invNo, setInvNo] = useState<string | null>(null);

  useEffect(() => {
    (clientCache ??= loadClients()).then(setClients).catch(() => { clientCache = null; setClients([]); });
    (catCache ??= loadCatalog()).then(setCatalog).catch(() => { catCache = null; });
    if (entry?.invoice_id) supabase.from("invoices").select("number").eq("id", entry.invoice_id).maybeSingle().then(({ data }) => setInvNo((data as any)?.number ?? null));
  }, [entry?.invoice_id]);
  // the product of a shipment being opened
  useEffect(() => {
    if (!entry?.product_id || item || !catalog.length) return;
    const c = catalog.find((x) => x.kind === "product" && x.id === entry.product_id && (entry.unit_price == null || x.price === Number(entry.unit_price)))
      ?? catalog.find((x) => x.kind === "product" && x.id === entry.product_id);
    if (c) setItem(c.key);
  }, [catalog, entry, item]);

  const close = () => { setClosing(true); setTimeout(onClose, 200); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".sel-layer, .dp-layer, .tp-layer")) close(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const mine = (c: BClient) => !c.team.length || c.team.some((m) => m.userId === myId);
  const options = useMemo(() => (clients ?? [])
    .filter((c) => anyClient || mine(c) || c.id === entry?.client_id)
    .map((c) => ({ value: c.id, label: c.name, hint: c.team.length ? `${c.team.length} on the team` : undefined })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [clients, anyClient, myId, entry?.client_id]);
  const hidden = (clients?.length ?? 0) - options.length;
  const products = useMemo(() => catalog.filter((c) => c.kind === "product").map((c) => ({ value: c.key, label: c.label, hint: money(c.price) })), [catalog]);
  const prod = catalog.find((c) => c.key === item);
  const pickItem = (k: string) => { setItem(k); const c = catalog.find((x) => x.key === k); if (c) setPrice(String(c.price)); };

  const s = fromHM(from), e = fromHM(to);
  const hours = round2(Math.max(0, (e - s) / 60));
  const q = Number(qty.replace(",", ".")) || 0;
  const p = Number(price.replace(",", ".")) || 0;

  const save = async () => {
    setErr(null);
    if (kind !== "internal" && !clientId) { setErr("Pick the client."); return; }
    if (kind === "internal" && !title.trim()) { setErr("Give it a title."); return; }
    if (kind === "internal" && e <= s) { setErr("The end has to be after the start."); return; }
    if (kind === "client_work" && e <= s) { setErr("The end has to be after the start."); return; }
    if (kind === "shipment" && (!prod || q <= 0)) { setErr("Pick the product and how many."); return; }
    setBusy(true);
    const id = entry?.id ?? crypto.randomUUID();
    const today = isoOf(new Date());
    const row: Record<string, unknown> = {
      id, user_id: myId, date_key: keyOf(date), entry_date: date,
      start_min: s, end_min: kind === "shipment" ? Math.max(e, s + 15) : e,
      billable: kind === "client_work" ? hours : 0,
      client_id: kind === "internal" ? null : clientId, notes: notes.trim() || null, kind,
      name: kind === "shipment" ? `${round2(q)} × ${prod!.label}` : kind === "internal" ? title.trim() : null,
      product_id: kind === "shipment" ? prod!.id : null,
      quantity: kind === "shipment" ? q : null,
      unit_price: kind === "shipment" ? p : null,
      status: entry?.status && entry.status !== "planned" ? entry.status : date <= today ? "confirmed" : "planned",
      work_type_id: null, project_id: null, billing_line: "consultor",
    };
    const { error } = await supabase.from("calendar_entries").upsert(row);
    if (error) { setBusy(false); setErr(/column|does not exist/i.test(error.message) ? "This needs src/base/sql/103_base_billing.sql in Supabase." : error.message); return; }
    // a new shipment can go straight onto a draft invoice
    if (kind === "shipment" && !editing && invoiceNow) {
      try {
        const c = clients?.find((x) => x.id === clientId);
        const d = draftFor(c, await nextNumber());
        d.lines = [{ key: newKey(), description: `${prod!.label} · shipped ${date.slice(8)}/${date.slice(5, 7)}`, quantity: q, unit: "unit", unit_price: p, product_id: prod!.id }];
        d.entry_ids = [id];
        const invId = await saveInvoice(d);
        row.invoice_id = invId;
      } catch (x: any) { setErr(`Saved, but the invoice couldn't be made: ${x?.message ?? x}`); setBusy(false); onSaved(row); return; }
    }
    setBusy(false);
    onSaved({ ...row, invoice_id: row.invoice_id ?? entry?.invoice_id ?? null });
    close();
  };
  const del = async () => {
    if (!entry || billed) return;
    if (!window.confirm("Delete this entry?")) return;
    setBusy(true);
    const { error } = await supabase.from("calendar_entries").delete().eq("id", entry.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onDeleted(entry.id); close();
  };

  const longDay = (() => { const [y, m, d] = date.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }); })();

  return createPortal(
    <div className={`wm-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(x) => { if (x.target === x.currentTarget) close(); }}>
      <div className={`wm ${kind ? `is-${kind}` : "is-pick"}`} role="dialog" aria-modal="true">
        <header className="wm-head">
          {kind && !editing && <button className="wm-back" onClick={() => setKind(null)} aria-label="Back"><Ico d={I.back} s={16} /></button>}
          <div className="wm-head-t">
            <h2>{!kind ? "What did you do?" : kind === "client_work" ? (editing ? "Client work" : "Log client work") : kind === "shipment" ? (editing ? "Shipment" : "Log a shipment") : (editing ? "Time" : "Something else")}</h2>
            <p>{longDay}</p>
          </div>
          <button className="wm-x" onClick={close} aria-label="Close"><Ico d={I.x} s={17} /></button>
        </header>

        {!kind ? (
          <div className="wm-pick">
            <button className="wm-opt is-work" style={{ ["--d" as string]: "0ms" }} onClick={() => setKind("client_work")}>
              <span className="wm-opt-ico"><Ico d={I.work} s={20} /></span>
              <span className="wm-opt-t"><b>Client work</b><small>Hours spent for a client — they add up in Billing.</small></span>
              <Ico d={I.go} s={16} />
            </button>
            <button className="wm-opt is-ship" style={{ ["--d" as string]: "60ms" }} onClick={() => setKind("shipment")}>
              <span className="wm-opt-ico"><Ico d={I.ship} s={20} /></span>
              <span className="wm-opt-t"><b>Shipment</b><small>A product sent to a client — it turns into an invoice.</small></span>
              <Ico d={I.go} s={16} />
            </button>
            <button className="wm-opt is-other" style={{ ["--d" as string]: "120ms" }} onClick={() => setKind("internal")}>
              <span className="wm-opt-ico"><Ico d={I.other} s={20} /></span>
              <span className="wm-opt-t"><b>Something else</b><small>Internal work, a meeting, time off — not billed.</small></span>
              <Ico d={I.go} s={16} />
            </button>
          </div>
        ) : (
          <>
            <div className="wm-body" key={kind}>
              {billed && (
                <button className="wm-billed" onClick={() => navigate(`/billing?invoice=${entry!.invoice_id}`)}>
                  <Ico d={I.lock} s={15} />Billed on invoice {invNo ?? "…"} — it can't be changed. <u>Open the invoice</u>
                </button>
              )}
              {kind === "internal" && (
                <label className="wm-f"><span>Title</span>
                  <input className="wm-in" autoFocus value={title} placeholder="e.g. Team meeting, preparing the offer…" onChange={(x) => setTitle(x.target.value)} />
                </label>
              )}
              {kind !== "internal" && <label className="wm-f"><span>Client</span>
                {clients ? <Select value={clientId} onChange={setClientId} options={options} placeholder="Pick a client…" searchable disabled={billed} aria-label="Client" />
                  : <span className="wm-skel" />}
                {!anyClient && hidden > 0 && <small className="wm-hint">Only the clients whose team you're on.</small>}
              </label>}
              {kind === "shipment" && (
                <div className="wm-row3">
                  <label className="wm-f is-wide"><span>Product</span>
                    <Select value={item} onChange={pickItem} options={products} placeholder={products.length ? "Pick a product…" : "No products in Settings yet"} searchable disabled={billed} aria-label="Product" />
                  </label>
                  <label className="wm-f"><span>Quantity</span><input className="wm-in" inputMode="decimal" value={qty} disabled={billed} onChange={(x) => setQty(x.target.value)} onFocus={(x) => x.currentTarget.select()} /></label>
                  <label className="wm-f"><span>Price each</span><span className="wm-eur"><input className="wm-in" inputMode="decimal" value={price} disabled={billed} onChange={(x) => setPrice(x.target.value)} onFocus={(x) => x.currentTarget.select()} /><i>€</i></span></label>
                </div>
              )}
              <div className="wm-row3">
                <label className="wm-f is-wide"><span>Day</span>{billed ? <b className="wm-ro">{longDay}</b> : <DatePicker value={date} onChange={setDate} />}</label>
                <label className="wm-f"><span>{kind === "shipment" ? "At" : "From"}</span>{billed ? <b className="wm-ro">{from}</b> : <TimePicker value={from} onChange={(v) => { const d = fromHM(v) - s; setFrom(v); if (kind === "shipment") return; setTo(toHM(Math.min(23 * 60 + 55, e + d))); }} />}</label>
                {kind !== "shipment" && <label className="wm-f"><span>To</span>{billed ? <b className="wm-ro">{to}</b> : <TimePicker value={to} onChange={setTo} />}</label>}
              </div>
              <label className="wm-f"><span>{kind === "shipment" ? "Notes" : "What you did"} <small>optional</small></span>
                <textarea className="wm-in" rows={3} value={notes} disabled={billed} placeholder={kind === "shipment" ? "Tracking number, address, what went in the box…" : kind === "internal" ? "Anything worth keeping" : "What was done — it can go on the invoice"} onChange={(x) => setNotes(x.target.value)} />
              </label>
              {kind === "shipment" && !editing && (
                <button type="button" className={`wm-toggle ${invoiceNow ? "is-on" : ""}`} onClick={() => setInvoiceNow((v) => !v)}>
                  <i />Make the invoice now <small>a draft in Billing, ready to send</small>
                </button>
              )}
              {kind === "internal" && !editing && onOther && (
                <button type="button" className="wm-full" onClick={onOther}>Invite people or make it repeat? <u>Open the full booking</u></button>
              )}
              {err && <p className="wm-err">{err}</p>}
            </div>
            <footer className="wm-foot">
              <span className="wm-sum">
                {kind === "client_work" ? <><b>{hours.toLocaleString("en-GB", { maximumFractionDigits: 2 })} h</b> for the client</>
                  : kind === "internal" ? <><b>{hours.toLocaleString("en-GB", { maximumFractionDigits: 2 })} h</b> not billed</>
                  : <><b>{money(round2(q * p))}</b> to bill</>}
              </span>
              {editing && !billed && <button className="wm-btn is-danger" disabled={busy} onClick={del}>Delete</button>}
              <button className="wm-btn" onClick={close}>{billed ? "Close" : "Cancel"}</button>
              {!billed && <button className="wm-btn is-primary" disabled={busy || !clients} onClick={save}>{busy ? "Saving…" : editing ? "Save" : kind === "shipment" && invoiceNow ? "Log & invoice" : "Log it"}</button>}
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
