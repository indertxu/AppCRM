/* =====================================================================
   BASE · Calendar — log what you did, step by step:
     1 · What      Client work / Shipment / Something else
     2 · Client    which client (logos, search; your teams first)
     3 · …         Client work: when + billable or not
                   Shipment:    product, quantity, price
     4 · Check     what you did (notes) and a recap before saving
   Client work can be billable (the hours go to Billing › To invoice) or
   not billable (logged for the client, never invoiced — kind
   'client_nonbillable', billable 0). A shipment can become a draft
   invoice right away. "Something else" is a title and a time; the full
   booking (invites, repeats) is one link away.
   Only clients whose team you're on (or with no team) can be picked,
   unless you see Management. Once an entry is on an invoice it's read-only.
   (103_base_billing.sql: calendar_entries.kind / product_id / quantity /
   unit_price / invoice_id)
   ===================================================================== */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
import ClientLogo from "../billing/ClientLogo";
import "./WorkModal.css";

export type WorkKind = "client_work" | "shipment" | "internal";
/** Client work that is logged for the client but never invoiced. */
export const NONBILL_KIND = "client_nonbillable";
export interface WorkRow {
  id: string; entry_date: string; start_min: number; end_min: number; client_id: string | null; notes: string | null;
  kind: string; product_id: string | null; quantity: number | null; unit_price: number | null; invoice_id: string | null;
  status?: string; name?: string | null;
  /** Which of the client's services (projects) the time was for. */
  project_id?: string | null;
}

interface Props {
  /** The day and time picked on the grid (a new entry), or the entry opened. */
  day: Date; startMin: number; endMin: number;
  entry?: WorkRow | null;
  myId: string;
  /** Logging an Outlook / Google event: its id (kept as outlook_source_id, so the event counts as logged), title and source. */
  source?: { id: string; subject: string; src: "outlook" | "google"; account?: string | null } | null;
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
const hrs = (h: number) => `${h.toLocaleString("en-GB", { maximumFractionDigits: 2 })} h`;
const I = {
  work: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  ship: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  other: "M8 2v3M16 2v3M3.5 9h17M5 4.5h14A1.5 1.5 0 0 1 20.5 6v13A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5z",
  x: "M18 6L6 18M6 6l12 12",
  go: "M9 18l6-6-6-6",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  back: "M15 18l-6-6 6-6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  euro: "M17 6.5A7 7 0 1 0 17 17.5M4 10h9M4 14h9",
  noeuro: "M17 6.5A7 7 0 0 0 7 6M5.6 8.3A7 7 0 0 0 17 17.5M4 10h5M4 14h7M3 3l18 18",
  team: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8",
};
const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

let clientCache: Promise<BClient[]> | null = null;
let catCache: Promise<CatItem[]> | null = null;

type StepKey = "what" | "client" | "when" | "product" | "check" | "details";
const STEPS: Record<WorkKind, { k: StepKey; label: string }[]> = {
  client_work: [{ k: "what", label: "What" }, { k: "client", label: "Client" }, { k: "when", label: "Time" }, { k: "check", label: "Billing" }],
  shipment: [{ k: "what", label: "What" }, { k: "client", label: "Client" }, { k: "product", label: "Product" }, { k: "check", label: "Send" }],
  internal: [{ k: "what", label: "What" }, { k: "details", label: "Details" }],
};
const DURS = [30, 60, 120, 240, 480];

export default function WorkModal({ day, startMin, endMin, entry, myId, source, onOther, onSaved, onDeleted, onClose }: Props) {
  const navigate = useNavigate();
  const access = usePageAccess();
  const anyClient = access.isSuper || access.canSee("management") || (access.level ?? "") === "boss";
  const editing = !!entry;
  const billed = !!entry?.invoice_id;
  const startKind: WorkKind | null = entry ? (entry.kind === "shipment" || entry.kind === "internal" ? entry.kind : "client_work") : null;
  const [kind, setKind] = useState<WorkKind | null>(startKind);
  const [billable, setBillable] = useState(entry ? entry.kind !== NONBILL_KIND : true);
  const [step, setStep] = useState(entry ? STEPS[startKind!].length - 1 : 0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [title, setTitle] = useState(entry?.kind === "internal" ? entry.name ?? "" : source?.subject ?? "");
  const [clientId, setClientId] = useState(entry?.client_id ?? "");
  const [projectId, setProjectId] = useState(entry?.project_id ?? "");
  /** The client's services (projects): what the time can be for. */
  const [projs, setProjs] = useState<{ id: string; service_id: string | null; status: string; kickoff: string | null }[] | null>(null);
  const [q, setQ] = useState("");
  const [date, setDate] = useState(entry?.entry_date ?? isoOf(day));
  const [from, setFrom] = useState(toHM(entry?.start_min ?? startMin));
  const [to, setTo] = useState(toHM(entry?.end_min ?? endMin));
  const [notes, setNotes] = useState(entry?.notes ?? source?.subject ?? "");
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
  const advT = useRef(0);

  useEffect(() => {
    (clientCache ??= loadClients()).then(setClients).catch(() => { clientCache = null; setClients([]); });
    (catCache ??= loadCatalog()).then(setCatalog).catch(() => { catCache = null; });
    if (entry?.invoice_id) supabase.from("invoices").select("number").eq("id", entry.invoice_id).maybeSingle().then(({ data }) => setInvNo((data as any)?.number ?? null));
    return () => window.clearTimeout(advT.current);
  }, [entry?.invoice_id]);
  // the product of a shipment being opened
  useEffect(() => {
    if (!entry?.product_id || item || !catalog.length) return;
    const c = catalog.find((x) => x.kind === "product" && x.id === entry.product_id && (entry.unit_price == null || x.price === Number(entry.unit_price)))
      ?? catalog.find((x) => x.kind === "product" && x.id === entry.product_id);
    if (c) setItem(c.key);
  }, [catalog, entry, item]);

  const close = () => { setClosing(true); setTimeout(onClose, 200); };

  const mine = (c: BClient) => !c.team.length || c.team.some((m) => m.userId === myId);
  const pickable = useMemo(() => (clients ?? []).filter((c) => anyClient || mine(c) || c.id === entry?.client_id)
    // your teams first, then by name
    .sort((a, b) => Number(b.team.some((m) => m.userId === myId)) - Number(a.team.some((m) => m.userId === myId)) || a.name.localeCompare(b.name)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [clients, anyClient, myId, entry?.client_id]);
  const shown = useMemo(() => { const t = q.trim().toLowerCase(); return t ? pickable.filter((c) => c.name.toLowerCase().includes(t) || c.legal_name?.toLowerCase().includes(t)) : pickable; }, [pickable, q]);
  const hidden = (clients?.length ?? 0) - pickable.length;
  const client = clients?.find((c) => c.id === clientId) ?? null;
  useEffect(() => {
    if (!clientId) { setProjs([]); return; }
    let alive = true;
    setProjs(null);
    supabase.from("projects").select("id, service_id, status, kickoff_date").eq("client_id", clientId).then(({ data }) => {
      if (!alive) return;
      const ps = ((data ?? []) as any[]).map((p) => ({ id: String(p.id), service_id: p.service_id ? String(p.service_id) : null, status: String(p.status ?? "open"), kickoff: p.kickoff_date ?? null }));
      setProjs(ps);
      // another client picked: the service no longer applies
      setProjectId((cur) => (cur && !ps.some((p) => p.id === cur) ? "" : cur));
    });
    return () => { alive = false; };
  }, [clientId]);
  const svcName = (sid: string | null) => (sid && catalog.find((c) => c.kind === "service" && c.id === sid)?.name) || "Project";
  const shownProjs = (projs ?? []).filter((p) => p.status !== "closed" || p.id === projectId);
  const proj = (projs ?? []).find((p) => p.id === projectId) ?? null;
  const products = useMemo(() => catalog.filter((c) => c.kind === "product").map((c) => ({ value: c.key, label: c.label, hint: money(c.price) })), [catalog]);
  const prod = catalog.find((c) => c.key === item);
  const pickItem = (k: string) => { setItem(k); const c = catalog.find((x) => x.key === k); if (c) setPrice(String(c.price)); };

  const s = fromHM(from), e = fromHM(to);
  const hours = round2(Math.max(0, (e - s) / 60));
  const qn = Number(qty.replace(",", ".")) || 0;
  const p = Number(price.replace(",", ".")) || 0;
  const steps = kind ? STEPS[kind] : STEPS.client_work;
  const cur = steps[step]?.k ?? "what";
  const last = step === steps.length - 1;

  /** Why this step can't go on yet (null: it can). */
  const blocker = (k: StepKey): string | null => {
    if (k === "what") return kind ? null : "Pick what you did.";
    if (k === "client") return clientId ? null : "Pick the client.";
    if (k === "when") return e > s ? null : "The end has to be after the start.";
    if (k === "product") return prod && qn > 0 ? null : "Pick the product and how many.";
    if (k === "details") return !title.trim() ? "Give it a title." : e > s ? null : "The end has to be after the start.";
    return null;
  };
  const go = (to: number) => {
    if (to === step) return;
    if (to > step) for (let i = step; i < to; i++) { const b = blocker(steps[i].k); if (b) { setErr(b); return; } }
    setErr(null); setDir(to > step ? 1 : -1); setStep(to);
  };
  const next = () => go(step + 1);
  const back = () => go(step - 1);
  const pickKind = (k: WorkKind) => {
    setKind(k); setErr(null); setDir(1); setStep(1);
  };
  const pickClient = (id: string) => {
    if (billed) return;
    setClientId(id); setErr(null);
    window.clearTimeout(advT.current);
    advT.current = window.setTimeout(() => { setDir(1); setStep(2); }, 220);
  };

  useEffect(() => {
    const k = (x: KeyboardEvent) => {
      if (document.querySelector(".sel-layer, .dp-layer, .tp-layer")) return;
      if (x.key === "Escape") close();
      else if (x.key === "Enter" && !(x.target instanceof HTMLTextAreaElement) && kind && !busy) { x.preventDefault(); if (last) void save(); else next(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const save = async () => {
    if (billed) return;
    for (const st of steps) { const b = blocker(st.k); if (b) { setErr(b); return; } }
    setErr(null);
    setBusy(true);
    const id = entry?.id ?? crypto.randomUUID();
    const today = isoOf(new Date());
    const realKind = kind === "client_work" && !billable ? NONBILL_KIND : kind!;
    const row: Record<string, unknown> = {
      id, user_id: myId, date_key: keyOf(date), entry_date: date,
      start_min: s, end_min: kind === "shipment" ? Math.max(e, s + 15) : e,
      billable: kind === "client_work" && billable ? hours : 0,
      client_id: kind === "internal" ? null : clientId, notes: notes.trim() || null, kind: realKind,
      name: kind === "shipment" ? `${round2(qn)} × ${prod!.label}` : kind === "internal" ? title.trim() : null,
      product_id: kind === "shipment" ? prod!.id : null,
      quantity: kind === "shipment" ? qn : null,
      unit_price: kind === "shipment" ? p : null,
      status: entry?.status && entry.status !== "planned" ? entry.status : date <= today ? "confirmed" : "planned",
      work_type_id: null, project_id: kind === "client_work" && projectId ? projectId : null, billing_line: "consultor",
    };
    if (source && !editing) row.outlook_source_id = source.id;
    let { error } = await supabase.from("calendar_entries").upsert(row);
    // before the Outlook columns exist: save it anyway (the event just won't count as logged)
    if (error && row.outlook_source_id && /outlook_source_id/i.test(error.message)) { delete row.outlook_source_id; ({ error } = await supabase.from("calendar_entries").upsert(row)); }
    if (error) { setBusy(false); setErr(/column|does not exist/i.test(error.message) ? "This needs src/base/sql/103_base_billing.sql in Supabase." : error.message); return; }
    // a new shipment can go straight onto a draft invoice
    if (kind === "shipment" && !editing && invoiceNow) {
      try {
        const d = draftFor(client ?? undefined, await nextNumber());
        d.lines = [{ key: newKey(), description: `${prod!.label} · shipped ${date.slice(8)}/${date.slice(5, 7)}`, quantity: qn, unit: "unit", unit_price: p, product_id: prod!.id }];
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
  const heading = !kind ? (source ? "Log this event" : "What did you do?")
    : kind === "client_work" ? (editing ? "Client work" : "Log client work")
    : kind === "shipment" ? (editing ? "Shipment" : "Log a shipment")
    : (editing ? "Time" : "Something else");
  const kindIco = kind === "shipment" ? I.ship : kind === "internal" ? I.other : I.work;

  /* ---------- the pieces ---------- */
  const whenFields = (
    <div className="wm-when">
      <label className="wm-f is-wide"><span>Day</span>{billed ? <b className="wm-ro">{longDay}</b> : <DatePicker value={date} onChange={setDate} />}</label>
      <label className="wm-f"><span>{kind === "shipment" ? "At" : "From"}</span>{billed ? <b className="wm-ro">{from}</b> : <TimePicker value={from} onChange={(v) => { const d = fromHM(v) - s; setFrom(v); if (kind === "shipment") return; setTo(toHM(Math.min(23 * 60 + 55, e + d))); }} />}</label>
      {kind !== "shipment" && <label className="wm-f"><span>To</span>{billed ? <b className="wm-ro">{to}</b> : <TimePicker value={to} onChange={setTo} />}</label>}
    </div>
  );
  const durChips = kind !== "shipment" && !billed && (
    <div className="wm-durs" role="group" aria-label="How long">
      {DURS.map((m) => (
        <button key={m} type="button" className={e - s === m ? "is-on" : ""} onClick={() => setTo(toHM(Math.min(23 * 60 + 55, s + m)))}>
          {m < 60 ? `${m} min` : `${m / 60} h`}
        </button>
      ))}
    </div>
  );
  const clientChip = client && (
    <span className="wm-cchip"><ClientLogo name={client.name} website={client.website} size={22} />{client.name}</span>
  );

  const body = (() => {
    switch (cur) {
      case "what":
        return (
          <div className="wm-pick">
            {([
              ["client_work", I.work, "Client work", "Hours spent for a client — billable or not."],
              ["shipment", I.ship, "Shipment", "A product sent to a client — it can become an invoice."],
              ["internal", I.other, "Something else", "Internal work, a meeting, time off — never billed."],
            ] as [WorkKind, string, string, string][]).filter(([k]) => !(source && k === "shipment")).map(([k, ico, t, sub], i) => (
              <button key={k} className={`wm-opt is-${k} ${kind === k ? "is-on" : ""}`} style={{ ["--d" as string]: `${i * 60}ms` }} disabled={editing && k !== kind} onClick={() => pickKind(k)}>
                <span className="wm-opt-ico"><Ico d={ico} s={20} /></span>
                <span className="wm-opt-t"><b>{t}</b><small>{sub}</small></span>
                <span className="wm-opt-go"><Ico d={I.go} s={16} /></span>
              </button>
            ))}
          </div>
        );
      case "client":
        return (
          <div className="wm-cl">
            <label className="wm-search"><Ico d={I.search} s={16} />
              <input autoFocus value={q} placeholder="Search clients…" onChange={(x) => setQ(x.target.value)} disabled={billed}
                onKeyDown={(x) => { if (x.key === "Enter" && shown.length === 1) { x.stopPropagation(); pickClient(shown[0].id); } }} />
            </label>
            <div className="wm-cl-list" role="listbox" aria-label="Client">
              {!clients ? [0, 1, 2, 3].map((i) => <span key={i} className="wm-skel" />)
                : shown.length === 0 ? <p className="wm-empty">{q ? `No client matches “${q}”.` : "No clients yet — add them in Clients."}</p>
                : shown.map((c, i) => {
                  const onTeam = c.team.some((m) => m.userId === myId);
                  return (
                    <button key={c.id} role="option" aria-selected={c.id === clientId} className={`wm-cl-row ${c.id === clientId ? "is-on" : ""}`}
                      style={{ ["--d" as string]: `${Math.min(i, 10) * 25}ms` }} onClick={() => pickClient(c.id)} disabled={billed && c.id !== clientId}>
                      <ClientLogo name={c.name} website={c.website} size={34} />
                      <span className="wm-cl-t"><b>{c.name}</b><small>{onTeam ? "You're on the team" : c.team.length ? `${c.team.length} on the team` : "No team yet"}</small></span>
                      <span className="wm-cl-tick"><Ico d={I.check} s={14} /></span>
                    </button>
                  );
                })}
            </div>
            {!anyClient && hidden > 0 && <small className="wm-hint"><Ico d={I.team} s={13} />Only the clients whose team you're on.</small>}
          </div>
        );
      case "when":
        return (
          <div className="wm-stack">
            <div className="wm-big">
              <span className="wm-big-n">{hrs(hours)}</span>
              <span className="wm-big-s">for {clientChip}</span>
            </div>
            {shownProjs.length > 0 && (
              <div className="wm-f">
                <span>On which of their services</span>
                <div className="wm-svcs" role="radiogroup" aria-label="Service">
                  <button type="button" role="radio" aria-checked={!projectId} className={!projectId ? "is-on" : ""} disabled={billed} onClick={() => setProjectId("")}>
                    <i /><b>General</b><small>Not one service</small>
                  </button>
                  {shownProjs.map((p) => (
                    <button key={p.id} type="button" role="radio" aria-checked={projectId === p.id} className={projectId === p.id ? "is-on" : ""} disabled={billed} onClick={() => setProjectId(p.id)}>
                      <i /><b>{svcName(p.service_id)}</b><small>{p.status === "on_hold" ? "On hold" : p.status === "closed" ? "Closed" : p.kickoff ? `Since ${new Date(`${p.kickoff}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : "Open"}</small>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {whenFields}
            {durChips}
          </div>
        );
      case "product":
        return (
          <div className="wm-stack">
            <label className="wm-f"><span>Product</span>
              <Select value={item} onChange={pickItem} options={products} placeholder={products.length ? "Pick a product…" : "No products in Settings yet"} searchable disabled={billed} aria-label="Product" />
            </label>
            <div className="wm-row2">
              <label className="wm-f"><span>Quantity</span>
                <span className="wm-step">
                  <button type="button" disabled={billed || qn <= 1} onClick={() => setQty(String(Math.max(1, round2(qn - 1))))} aria-label="One less">−</button>
                  <input className="wm-in" inputMode="decimal" value={qty} disabled={billed} onChange={(x) => setQty(x.target.value)} onFocus={(x) => x.currentTarget.select()} />
                  <button type="button" disabled={billed} onClick={() => setQty(String(round2(qn + 1)))} aria-label="One more">+</button>
                </span>
              </label>
              <label className="wm-f"><span>Price each</span><span className="wm-eur"><input className="wm-in" inputMode="decimal" value={price} disabled={billed} onChange={(x) => setPrice(x.target.value)} onFocus={(x) => x.currentTarget.select()} /><i>€</i></span></label>
            </div>
            <div className="wm-total"><span>Total for {clientChip}</span><b>{money(round2(qn * p))}</b></div>
          </div>
        );
      case "details":
        return (
          <div className="wm-stack">
            <label className="wm-f"><span>Title</span>
              <input className="wm-in" autoFocus value={title} placeholder="e.g. Team meeting, preparing the offer…" onChange={(x) => setTitle(x.target.value)} />
            </label>
            {whenFields}
            {durChips}
            <label className="wm-f"><span>Notes <small>optional</small></span>
              <textarea className="wm-in" rows={2} value={notes} placeholder="Anything worth keeping" onChange={(x) => setNotes(x.target.value)} />
            </label>
            {!editing && onOther && (
              <button type="button" className="wm-full" onClick={onOther}>Invite people or make it repeat? <u>Open the full booking</u></button>
            )}
          </div>
        );
      case "check":
        return (
          <div className="wm-stack">
            {kind === "client_work" && (
              <div className="wm-bill" role="radiogroup" aria-label="Billing">
                <button type="button" role="radio" aria-checked={billable} className={`wm-bopt ${billable ? "is-on" : ""}`} disabled={billed} onClick={() => setBillable(true)}>
                  <span className="wm-bopt-ico"><Ico d={I.euro} s={18} /></span>
                  <span className="wm-bopt-t"><b>Billable</b><small>The {hrs(hours)} go to the client's next invoice</small></span>
                  <i className="wm-radio" />
                </button>
                <button type="button" role="radio" aria-checked={!billable} className={`wm-bopt is-nb ${!billable ? "is-on" : ""}`} disabled={billed} onClick={() => setBillable(false)}>
                  <span className="wm-bopt-ico"><Ico d={I.noeuro} s={18} /></span>
                  <span className="wm-bopt-t"><b>Not billable</b><small>Logged for the client, never invoiced</small></span>
                  <i className="wm-radio" />
                </button>
              </div>
            )}
            {kind === "shipment" && (<>{whenFields}</>)}
            <label className="wm-f"><span>{kind === "shipment" ? "Notes" : "What you did"} <small>optional</small></span>
              <textarea className="wm-in" rows={3} value={notes} disabled={billed}
                placeholder={kind === "shipment" ? "Tracking number, address, what went in the box…" : billable ? "What was done — it can go on the invoice" : "What was done"}
                onChange={(x) => setNotes(x.target.value)} />
            </label>
            {kind === "shipment" && !editing && (
              <button type="button" className={`wm-toggle ${invoiceNow ? "is-on" : ""}`} onClick={() => setInvoiceNow((v) => !v)}>
                <i />Make the invoice now <small>a draft in Billing, ready to send</small>
              </button>
            )}
            <div className="wm-recap">
              <span className="wm-recap-ico"><Ico d={kindIco} s={17} /></span>
              <span className="wm-recap-t">
                <b>{kind === "shipment" ? `${round2(qn)} × ${prod?.label ?? "—"}` : client?.name ?? "—"}{kind === "client_work" && proj ? ` · ${svcName(proj.service_id)}` : ""}</b>
                <small>{longDay} · {kind === "shipment" ? from : `${from} – ${to}`}{kind === "shipment" && client ? ` · ${client.name}` : ""}</small>
              </span>
              <span className={`wm-recap-tag ${kind === "client_work" && !billable ? "is-nb" : ""}`}>
                {kind === "shipment" ? money(round2(qn * p)) : billable ? `${hrs(hours)} billable` : `${hrs(hours)} not billed`}
              </span>
            </div>
          </div>
        );
    }
  })();

  const sum = !kind ? null
    : kind === "client_work" ? <><b>{hrs(hours)}</b>{billable ? " billable" : " not billed"}</>
    : kind === "internal" ? <><b>{hrs(hours)}</b> not billed</>
    : <><b>{money(round2(qn * p))}</b> to bill</>;

  return createPortal(
    <div className={`wm-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(x) => { if (x.target === x.currentTarget) close(); }}>
      <div className={`wm wm2 ${kind ? `is-${kind}` : "is-pick"} ${kind === "client_work" && !billable ? "is-nonbill" : ""}`} role="dialog" aria-modal="true" aria-label={heading}>
        <header className="wm-head">
          <span className="wm-head-ico"><Ico d={kindIco} s={20} /></span>
          <div className="wm-head-t">
            <h2>{heading}</h2>
            <p>{longDay}{kind && kind !== "internal" && client && cur !== "client" ? <> · {client.name}</> : null}</p>
          </div>
          <button className="wm-x" onClick={close} aria-label="Close"><Ico d={I.x} s={17} /></button>
        </header>

        {kind && (
          <ol className="wm-steps" style={{ ["--n" as string]: steps.length, ["--at" as string]: step } as CSSProperties}>
            {steps.map((st, i) => (
              <li key={st.k} className={i < step ? "is-done" : i === step ? "is-cur" : ""}>
                <button type="button" onClick={() => go(i)} disabled={(editing && i === 0) || (i > step && !editing)}>
                  <i>{i < step ? <Ico d={I.check} s={12} /> : i + 1}</i><span>{st.label}</span>
                </button>
              </li>
            ))}
          </ol>
        )}

        <div className="wm-body">
          {source && (
            <div className={`wm-src is-${source.src}`}>
              <span className="wm-src-ico" aria-hidden="true">{source.src === "google" ? "31" : <Ico d={I.other} s={14} />}</span>
              <span className="wm-src-t"><small>From {source.src === "google" ? "Google Calendar" : "Outlook"}{source.account ? ` · ${source.account}` : ""}</small><b>{source.subject || "(no title)"}</b></span>
              <span className="wm-src-when">{from} – {to}</span>
            </div>
          )}
          {billed && (
            <button className="wm-billed" onClick={() => navigate(`/billing?invoice=${entry!.invoice_id}`)}>
              <Ico d={I.lock} s={15} />Billed on invoice {invNo ?? "…"} — it can't be changed. <u>Open the invoice</u>
            </button>
          )}
          <div className={`wm-pane ${dir > 0 ? "is-fwd" : "is-back"}`} key={`${kind}-${cur}`}>{body}</div>
          {err && <p className="wm-err">{err}</p>}
        </div>

        {kind && (
          <footer className="wm-foot">
            <span className="wm-sum">{sum}</span>
            {editing && !billed && last && <button className="wm-btn is-danger" disabled={busy} onClick={del}>Delete</button>}
            {step > (editing ? 1 : 0) ? <button className="wm-btn" onClick={back}><Ico d={I.back} s={15} />Back</button>
              : <button className="wm-btn" onClick={close}>{billed ? "Close" : "Cancel"}</button>}
            {last ? (!billed && <button className="wm-btn is-primary" disabled={busy || !clients} onClick={save}>
              {busy ? "Saving…" : editing ? "Save" : kind === "shipment" && invoiceNow ? "Log & invoice" : "Log it"}</button>)
              : cur !== "client" || clientId ? <button className="wm-btn is-primary" onClick={next}>Next<Ico d={I.go} s={15} /></button> : null}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
