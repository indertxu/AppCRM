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
   invoice right away. "Something else" is a name and a time.
   Every kind has a name (shown on the calendar, the invite and its
   notification), a People step — colleagues get an invitation to accept or
   decline (entry_invites → alert_invite), contacts are noted on the entry —
   and can drop a task in your to-do, due when the entry ends.
   Only clients whose team you're on (or with no team) can be picked,
   unless you see Management. Once an entry is on an invoice it's read-only.
   (103_base_billing.sql: calendar_entries.kind / product_id / quantity /
   unit_price / invoice_id)
   ===================================================================== */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { BRANDS } from "../settings/brandIcons";
import { syncInvites } from "./invitesApi";
import { unsyncEntryEverywhere, inviteChannels, type Person } from "../../api/calendarPush";
import { loadInactiveIds } from "../../framework/peopleStatus";
import { createTicket } from "../homepage/shared/HomeTodo";
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
  /** Contacts on it (comma-separated contact ids). */
  attendees?: string | null;
}

interface Props {
  /** The day and time picked on the grid (a new entry), or the entry opened. */
  day: Date; startMin: number; endMin: number;
  entry?: WorkRow | null;
  myId: string;
  /** Logging an Outlook / Google event: its id (kept as outlook_source_id, so the event counts as logged), title and source. */
  source?: { id: string; subject: string; src: "outlook" | "google"; account?: string | null } | null;
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
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  building: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4",
  plus: "M12 5v14M5 12h14",
  person: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0",
  task: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9",
  team: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8",
};
const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

let clientCache: Promise<BClient[]> | null = null;
let catCache: Promise<CatItem[]> | null = null;

type StepKey = "what" | "client" | "when" | "product" | "check" | "details" | "team" | "guests";
const STEPS: Record<WorkKind, { k: StepKey; label: string }[]> = {
  client_work: [{ k: "what", label: "What" }, { k: "client", label: "Client" }, { k: "when", label: "Time" }, { k: "team", label: "Team" }, { k: "guests", label: "Guests" }, { k: "check", label: "Billing" }],
  shipment: [{ k: "what", label: "What" }, { k: "client", label: "Client" }, { k: "product", label: "Product" }, { k: "team", label: "Team" }, { k: "guests", label: "Guests" }, { k: "check", label: "Send" }],
  internal: [{ k: "what", label: "What" }, { k: "details", label: "Details" }, { k: "team", label: "Team" }, { k: "guests", label: "Guests" }],
};
type Mate = { id: string; name: string; role: string };
type Contact = { id: string; name: string; sub: string; email: string };
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;
const ini = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const hue = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
let mateCache: Promise<Mate[]> | null = null;
const contactOf = (c: any): Contact => ({
  id: String(c.id),
  name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Contact",
  sub: [c.position, c.email].filter(Boolean).join(" · "),
  email: String(c.email ?? "").trim(),
});

/** BASE: a compact pill that opens a little list (the service, next to the client). */
function PillMenu({ label, value, options, onChange, disabled }: {
  label: string; value: string; options: { v: string; label: string; sub?: string }[]; onChange: (v: string) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", off); window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", off); window.removeEventListener("keydown", esc, true); };
  }, [open]);
  const cur = options.find((o) => o.v === value) ?? options[0];
  return (
    <span className={`wm-pm ${open ? "is-open" : ""}`} ref={ref}>
      <button type="button" className="wm-pm-btn" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label={label} title={label}>
        <span>{cur?.label}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <span className="wm-pm-menu" role="listbox" aria-label={label}>
          {options.map((o) => (
            <button key={o.v || "_"} type="button" role="option" aria-selected={o.v === value} className={o.v === value ? "is-on" : ""} onClick={() => { onChange(o.v); setOpen(false); }}>
              <span><b>{o.label}</b>{o.sub && <small>{o.sub}</small>}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

type How = "in_person" | "video" | "phone";
const SYNC_KEY = "wm-cal-sync";
const readSync = (): { outlook: boolean; google: boolean } => {
  try { const v = JSON.parse(localStorage.getItem(SYNC_KEY) ?? "null"); if (v && typeof v === "object") return { outlook: v.outlook !== false, google: v.google !== false }; } catch { /* */ }
  return { outlook: true, google: true };
};

export default function WorkModal({ day, startMin, endMin, entry, myId, source, onSaved, onDeleted, onClose }: Props) {
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
  // the entry's name, whatever its kind (a shipment's own "2 × Product" label counts as no name)
  const [title, setTitle] = useState(entry ? (entry.name ?? "") : source?.subject ?? "");
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
  /* people: colleagues (invited, they answer) and contacts (noted on it) */
  const [mates, setMates] = useState<Mate[]>([]);
  const [invited, setInvited] = useState<string[]>([]);
  const [inviteState, setInviteState] = useState<Record<string, string>>({});
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pq, setPq] = useState("");     // guests: contacts / an e-mail
  const [tq, setTq] = useState("");     // team: a colleague
  const [found, setFound] = useState<Contact[] | null>(null);
  const [toTodo, setToTodo] = useState(false);
  /* e-mail invitations (SQL 151 invite_mail): Gmail through Google, the rest through Outlook */
  const [teamMail, setTeamMail] = useState(true);
  const [guestsMail, setGuestsMail] = useState(false);
  const [extra, setExtra] = useState<Person[]>([]);
  const [suggested, setSuggested] = useState<Contact[] | null>(null);
  const [channels, setChannels] = useState<{ outlook: boolean; google: string | null } | null>(null);
  /* which of my calendars it goes to (Next always), and what kind of meeting it is */
  const [sync, setSyncRaw] = useState(readSync);
  const setSync = (v: { outlook: boolean; google: boolean }) => { setSyncRaw(v); if (!entry) try { localStorage.setItem(SYNC_KEY, JSON.stringify(v)); } catch { /* */ } };
  const [how, setHow] = useState<How>("in_person");
  const [vp, setVp] = useState<"teams" | "meet">("teams");
  // the call link comes from the calendar it lives in: Teams from Outlook, Meet from Google (you pick when it's in both)
  const olOn = !!channels?.outlook && sync.outlook;
  const gOn = !!channels?.google && sync.google;
  const platform: "teams" | "meet" | null = olOn && gOn ? vp : olOn ? "teams" : gOn ? "meet" : null;
  useEffect(() => { inviteChannels().then(setChannels).catch(() => setChannels({ outlook: false, google: null })); }, []);
  useEffect(() => {
    (mateCache ??= Promise.all([
      supabase.from("profiles").select("id, first_name, last_name, username, email, role"),
      loadInactiveIds().catch(() => new Set<string>()),
    ]).then(([{ data }, former]) => ((data ?? []) as any[]).filter((x) => !former.has(x.id)).map((x) => ({
      id: String(x.id), name: [x.first_name, x.last_name].filter(Boolean).join(" ") || x.username || x.email || "Unnamed",
      role: String(x.role ?? "").replace(/_/g, " "),
    })).sort((a, b) => a.name.localeCompare(b.name)))).then((m) => setMates(m.filter((x) => x.id !== myId))).catch(() => { mateCache = null; });
    if (entry?.id) {
      supabase.from("entry_invites").select("invitee_id, status").eq("entry_id", entry.id).neq("status", "declined").then(({ data }) => {
        const st: Record<string, string> = {};
        ((data ?? []) as any[]).forEach((r) => { st[r.invitee_id] = r.status; });
        setInviteState(st); setInvited(Object.keys(st));
      });
      supabase.from("calendar_entries").select("invite_mail, meeting_kind").eq("id", entry.id).maybeSingle().then(({ data }) => {
        const im = (data as any)?.invite_mail;
        const mk = String((data as any)?.meeting_kind ?? "");
        if (mk === "teams" || mk === "meet") { setHow("video"); setVp(mk); } else if (mk === "phone") setHow("phone");
        if (im?.sync && typeof im.sync === "object") setSyncRaw({ outlook: im.sync.outlook !== false, google: im.sync.google !== false });
        if (im && typeof im === "object") {
          setTeamMail(im.team !== false); setGuestsMail(!!im.guests);
          setExtra(Array.isArray(im.emails) ? im.emails.filter((x: any) => x?.email).map((x: any) => ({ email: String(x.email), name: String(x.name || x.email) })) : []);
        }
      });
    }
    const ids = (entry?.attendees ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (ids.length) {
      supabase.from("contacts").select("id, first_name, last_name, email, position").in("id", ids).then(({ data }) => setContacts(((data ?? []) as any[]).map(contactOf)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id]);
  // contacts: searched as you type
  useEffect(() => {
    const t = pq.trim();
    if (t.length < 2) { setFound(null); return; }
    let alive = true;
    const h = window.setTimeout(() => {
      const like = `%${t.replace(/[%,()]/g, " ")}%`;
      supabase.from("contacts").select("id, first_name, last_name, email, position")
        .or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like}`).limit(8)
        .then(({ data }) => { if (alive) setFound(((data ?? []) as any[]).map(contactOf)); });
    }, 220);
    return () => { alive = false; window.clearTimeout(h); };
  }, [pq]);
  const toggleExtra = (p: Person) => setExtra((l) => (l.some((x) => x.email.toLowerCase() === p.email.toLowerCase()) ? l.filter((x) => x.email.toLowerCase() !== p.email.toLowerCase()) : [...l, p]));
  const toggleMate = (id: string) => setInvited((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  const toggleContact = (c: Contact) => setContacts((l) => (l.some((x) => x.id === c.id) ? l.filter((x) => x.id !== c.id) : [...l, c]));

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
  // guests to suggest: the people at the client's company
  const coId = kind !== "internal" ? client?.company_id ?? null : null;
  useEffect(() => {
    if (!coId) { setSuggested([]); return; }
    let alive = true; setSuggested(null);
    supabase.from("company_contacts").select("contact_id").eq("company_id", coId).limit(80).then(async ({ data }) => {
      const ids = Array.from(new Set(((data ?? []) as any[]).map((r) => r.contact_id).filter(Boolean)));
      const { data: cs } = ids.length ? await supabase.from("contacts").select("id, first_name, last_name, email, position").in("id", ids) : { data: [] as any[] };
      if (alive) setSuggested(((cs ?? []) as any[]).map(contactOf).sort((a, b) => Number(!!b.email) - Number(!!a.email) || a.name.localeCompare(b.name)));
    });
    return () => { alive = false; };
  }, [coId]);
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
    if (k === "details") return !title.trim() ? "Give it a name." : e > s ? null : "The end has to be after the start.";
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
    const autoName = kind === "shipment" ? `${round2(qn)} × ${prod!.label}` : kind === "client_work" ? client?.name ?? "Client work" : "";
    const ownName = title.trim();
    const row: Record<string, unknown> = {
      id, user_id: myId, date_key: keyOf(date), entry_date: date,
      start_min: s, end_min: kind === "shipment" ? Math.max(e, s + 15) : e,
      billable: kind === "client_work" && billable ? hours : 0,
      client_id: kind === "internal" ? null : clientId, notes: notes.trim() || null, kind: realKind,
      // the name you gave it (a shipment keeps its "2 × Product" label when you didn't); title is what invites and their notifications show
      name: ownName || (kind === "shipment" ? autoName : null),
      title: ownName || autoName || null,
      attendees: contacts.length ? contacts.map((c) => c.id).join(",") : null,
      // e-mail invitations: colleagues and / or guests get a real Outlook / Google invitation
      invite_mail: { team: teamMail, guests: guestsMail, emails: extra, sync, video: kind !== "shipment" && how === "video" ? platform : null },
      meeting_kind: kind === "shipment" ? null : how === "video" ? platform ?? "teams" : how,
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
    // colleagues: an invitation each (they accept or decline; the database notifies them). Client work they bill like you.
    if (invited.length || Object.keys(inviteState).length) {
      const each = kind === "client_work" && billable ? hours : 0;
      const ie = await syncInvites(id, myId, invited.map((pid) => ({ id: pid, billable: each })), "consultor").catch((x) => String(x?.message ?? x));
      if (ie) { setErr(`Saved, but the invitations didn't go out: ${ie}`); setBusy(false); onSaved(row); return; }
    }
    // a task in your to-do, due when this ends
    if (toTodo && !editing) {
      const r = await createTicket({ title: ownName || autoName || "Calendar entry", due: `${date}T${toHM(kind === "shipment" ? s : e)}:00`, assignee: myId, coOwners: [],
        category: "task", source: "manual", ...(kind !== "internal" && clientId ? { clientId } : {}) } as any, true);
      if (r.error) { setErr(`Saved, but the task couldn't be made: ${r.error}`); setBusy(false); onSaved(row); return; }
    }
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
    await unsyncEntryEverywhere(entry.id).catch(() => {}); // its Outlook / Google events first, while the row still says which
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
  const clientChip = client && (
    <span className="wm-cchip"><ClientLogo name={client.name} website={client.website} size={22} />{client.name}</span>
  );

  // BASE v4: the last step's options — one card, one row each (label left, control right), all the same pill switch
  const brand = (k: "outlook" | "gcal") => (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={BRANDS[k]?.path ?? ""} fill={BRANDS[k]?.hex ?? "#0b3a2b"} /></svg>
  );
  const seg = <T extends string>(label: string, value: T, opts: [T, string, string?][], set: (v: T) => void, cls = "", off = false) => {
    const i = Math.max(0, opts.findIndex(([k]) => k === value));
    return (
      <div className={`wm-sg ${cls}`} role="radiogroup" aria-label={label} style={{ ["--n" as string]: opts.length, ["--i" as string]: i } as CSSProperties}>
        <i className="wm-sg-ink" aria-hidden="true" />
        {opts.map(([k, l, ic]) => (
          <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? "is-on" : ""} disabled={off} onClick={() => set(k)}>
            {ic && <Ico d={ic} s={14} />}<span translate={/Teams|Meet/.test(l) ? "no" : undefined}>{l}</span>
          </button>
        ))}
      </div>
    );
  };
  const row = (k: string, label: string, control: ReactNode, sub?: ReactNode) => (
    <div className={`wm-row is-${k}`} key={k}>
      <span className="wm-row-k"><b>{label}</b>{sub && <small>{sub}</small>}</span>
      <div className="wm-row-v">{control}</div>
    </div>
  );
  const calChip = (k: "outlook" | "google", label: string, logo: ReactNode, who?: string | null) => (
    <button type="button" className={`wm-cal2 ${sync[k] ? "is-on" : ""}`} aria-pressed={sync[k]} title={who ? `${label} · ${who}` : label}
      onClick={() => setSync({ ...sync, [k]: !sync[k] })}>
      <i className="wm-cal2-logo">{logo}</i><span translate="no">{label}</span>
    </button>
  );
  const dueText = (() => { const [y, m, d] = date.split("-").map(Number); return `${new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · ${kind === "shipment" ? from : to}`; })();
  const optionRows = (<>
    {row("cals", "Calendars", (
      <div className="wm-cals2">
        <span className="wm-cal2 is-on is-fixed" title="Always in Next"><i className="wm-cal2-logo"><img src="/favicon.svg" alt="" /></i><span translate="no">Next</span></span>
        {channels?.outlook && calChip("outlook", "Outlook", brand("outlook"))}
        {!!channels?.google && calChip("google", "Google", brand("gcal"), channels.google)}
        {channels && !channels.outlook && !channels.google && <small className="wm-row-note">Connect Outlook or Google in Settings › Integrations</small>}
        {!channels && <span className="wm-skel is-pill" />}
      </div>
    ), "Next always")}
    {kind !== "shipment" && row("meet", "Meeting", seg<How>("Meeting", how, [
      ["in_person", "In person", "M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z"],
      ["video", "Video", "M15 10l4.5-2.6v9.2L15 14M4 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"],
      ["phone", "Phone", "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"],
    ], setHow))}
    {kind !== "shipment" && how === "video" && row("call", "Call on", olOn && gOn
      ? seg<"teams" | "meet">("Call on", vp, [["teams", "Teams"], ["meet", "Google Meet"]], setVp, "is-call")
      : <small className="wm-row-note">{olOn ? <>Outlook makes a <span translate="no">Teams</span> link for everyone</> : gOn ? <>Google makes a <span translate="no">Meet</span> link for everyone</> : "Add it to Outlook or Google to get a call link"}</small>,
      olOn && gOn ? "one link for all" : undefined)}
    {kind === "shipment" && !editing && row("inv", "Invoice", (
      <button type="button" className={`wm-sw ${invoiceNow ? "is-on" : ""}`} role="switch" aria-checked={invoiceNow} onClick={() => setInvoiceNow((v) => !v)}><i /></button>
    ), "make the draft now")}
    {!editing && row("todo", "To-do", (
      <button type="button" className={`wm-sw ${toTodo ? "is-on" : ""}`} role="switch" aria-checked={toTodo} aria-label="Add it to my to-do" onClick={() => setToTodo((v) => !v)}><i /></button>
    ), toTodo ? `due ${dueText}` : "add it as a task")}
  </>);
  const peopleCount = invited.length + contacts.length + extra.length;
  const canMail = olOn || gOn;
  const viaText = !channels ? "Checking your calendars…"
    : !channels.outlook && !channels.google ? "Connect Outlook or Google in Settings › Integrations to send invitations."
    : !canMail ? "It's only in Next — add it to your Outlook or Google (last step) to send invitations."
    : how === "video" && platform === "teams" && olOn ? "Sent from your Outlook, with the Teams link."
    : how === "video" && platform === "meet" && gOn ? "Sent from your Google Calendar, with the Meet link."
    : olOn && gOn ? "Gmail addresses get it from your Google Calendar, everyone else from your Outlook."
    : olOn ? "Sent from your Outlook." : `Sent from your Google Calendar (${channels.google}).`;
  const mailToggle = (on: boolean, set: (v: boolean) => void, label: string) => (
    <button type="button" className={`wm-toggle wm-todo wm-mail ${on && canMail ? "is-on" : ""}`} disabled={!canMail} onClick={() => set(!on)} aria-pressed={on && canMail}>
      <i /><span className="wm-todo-t"><b>{label}</b><small>{viaText}</small></span>
      <Ico d={I.mail} s={16} />
    </button>
  );
  const pqMail = EMAIL_RE.test(pq.trim()) ? pq.trim() : "";
  const addTyped = () => {
    if (!pqMail) return;
    const hit = [...(suggested ?? []), ...(found ?? [])].find((c) => c.email.toLowerCase() === pqMail.toLowerCase());
    if (hit) { if (!contacts.some((x) => x.id === hit.id)) toggleContact(hit); }
    else if (!extra.some((x) => x.email.toLowerCase() === pqMail.toLowerCase())) toggleExtra({ email: pqMail, name: pqMail });
    setPq("");
  };
  const contactRow = (c: Contact, i: number) => { const on = contacts.some((x) => x.id === c.id); return (
    <button key={c.id} type="button" className={`wm-ppl-row is-contact ${on ? "is-on" : ""}`} style={{ ["--d" as string]: `${Math.min(i, 10) * 20}ms` }} onClick={() => toggleContact(c)} aria-pressed={on}>
      <i className="wm-av is-contact"><Ico d={I.person} s={15} /></i>
      <span className="wm-ppl-t"><b>{c.name}</b><small>{c.sub || "Contact"}{!c.email ? " · no e-mail, so no invitation" : ""}</small></span>
      <span className="wm-cl-tick"><Ico d={I.check} s={14} /></span>
    </button>
  ); };
  const mateRows = (() => {
    const t = tq.trim().toLowerCase();
    const list = t ? mates.filter((m) => m.name.toLowerCase().includes(t) || m.role.toLowerCase().includes(t)) : mates;
    return list.slice(0, t ? 8 : 60);
  })();
  const stLabel = (id: string) => inviteState[id] === "accepted" ? "Accepted" : inviteState[id] === "pending" ? "Waiting for an answer" : null;

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
              <span className="wm-big-s">for {clientChip}
                {shownProjs.length > 0 && (
                  <PillMenu label="Service" disabled={billed} value={projectId}
                    options={[{ v: "", label: "General", sub: "Not one service" },
                      ...shownProjs.map((p) => ({ v: p.id, label: svcName(p.service_id), sub: p.status === "on_hold" ? "On hold" : p.status === "closed" ? "Closed" : p.kickoff ? `Since ${new Date(`${p.kickoff}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : "Open" }))]}
                    onChange={setProjectId} />
                )}
              </span>
            </div>
            {whenFields}
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
            <label className="wm-f"><span>Name</span>
              <input className="wm-in" autoFocus value={title} placeholder="e.g. Team meeting, preparing the offer…" onChange={(x) => setTitle(x.target.value)} />
            </label>
            {whenFields}
            <label className="wm-f"><span>Notes <small>optional</small></span>
              <textarea className="wm-in" rows={2} value={notes} placeholder="Anything worth keeping" onChange={(x) => setNotes(x.target.value)} />
            </label>
          </div>
        );
      case "team":
        return (
          <div className="wm-ppl">
            <label className="wm-search"><Ico d={I.search} s={16} />
              <input autoFocus value={tq} placeholder="Find a colleague…" onChange={(x) => setTq(x.target.value)} />
            </label>
            {invited.length > 0 && (
              <div className="wm-ppl-chips">
                {invited.map((id) => { const m = mates.find((x) => x.id === id); const st = inviteState[id]; return (
                  <span key={id} className={`wm-chip is-mate ${st ? `is-${st}` : "is-new"}`} title={stLabel(id) ?? "Gets an invitation when you save"}>
                    <i style={{ ["--h" as string]: hue(id) } as CSSProperties}>{ini(m?.name ?? "?")}</i>{m?.name ?? "Colleague"}
                    <button type="button" onClick={() => toggleMate(id)} aria-label={`Remove ${m?.name ?? "colleague"}`}><Ico d={I.x} s={12} /></button>
                  </span>
                ); })}
              </div>
            )}
            <div className="wm-ppl-list">
              <span className="wm-ppl-k"><Ico d={I.team} s={13} />Your team <em>they accept or decline it in Next</em></span>
              {mateRows.map((m, i) => { const on = invited.includes(m.id); return (
                <button key={m.id} type="button" className={`wm-ppl-row ${on ? "is-on" : ""}`} style={{ ["--d" as string]: `${Math.min(i, 10) * 20}ms` }} onClick={() => toggleMate(m.id)} aria-pressed={on}>
                  <i className="wm-av" style={{ ["--h" as string]: hue(m.id) } as CSSProperties}>{ini(m.name)}</i>
                  <span className="wm-ppl-t"><b>{m.name}</b><small>{stLabel(m.id) ?? (m.role || "Colleague")}</small></span>
                  <span className="wm-cl-tick"><Ico d={I.check} s={14} /></span>
                </button>
              ); })}
              {!mateRows.length && <p className="wm-empty">{tq.trim() ? `No colleague matches “${tq.trim()}”.` : "Nobody else in your company yet."}</p>}
            </div>
            {invited.length > 0 && mailToggle(teamMail, setTeamMail, "Also send it to their calendars")}
          </div>
        );
      case "guests":
        return (
          <div className="wm-ppl">
            <label className="wm-search"><Ico d={I.search} s={16} />
              <input autoFocus value={pq} placeholder="Find a contact or type an e-mail…" onChange={(x) => setPq(x.target.value)}
                onKeyDown={(x) => { if (x.key === "Enter" && pqMail) { x.preventDefault(); x.stopPropagation(); addTyped(); } }} />
            </label>
            {(contacts.length > 0 || extra.length > 0) && (
              <div className="wm-ppl-chips">
                {contacts.map((c) => (
                  <span key={c.id} className="wm-chip is-contact" title={c.sub || "Contact"}>
                    <i><Ico d={I.person} s={12} /></i>{c.name}
                    <button type="button" onClick={() => toggleContact(c)} aria-label={`Remove ${c.name}`}><Ico d={I.x} s={12} /></button>
                  </span>
                ))}
                {extra.map((p) => (
                  <span key={p.email} className="wm-chip is-contact is-mail" title={p.email}>
                    <i><Ico d={I.mail} s={12} /></i>{p.name || p.email}
                    <button type="button" onClick={() => toggleExtra(p)} aria-label={`Remove ${p.email}`}><Ico d={I.x} s={12} /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="wm-ppl-list">
              {pq.trim().length < 2 ? (<>
                {coId && <span className="wm-ppl-k"><Ico d={I.building} s={13} />At {client?.name} <em>their people in your contacts</em></span>}
                {coId && (suggested === null ? <span className="wm-skel" /> : suggested.length ? suggested.map(contactRow)
                  : <p className="wm-empty">No contacts at {client?.name} yet — search for anyone, or type an e-mail.</p>)}
                {!coId && <p className="wm-empty">Search your contacts, or type any e-mail address to add someone who isn't in Next.</p>}
              </>) : (<>
                {pqMail && !contacts.some((c) => c.email.toLowerCase() === pqMail.toLowerCase()) && !extra.some((x) => x.email.toLowerCase() === pqMail.toLowerCase()) && (
                  <button type="button" className="wm-ppl-row is-add" onClick={addTyped}>
                    <i className="wm-av is-contact"><Ico d={I.mail} s={15} /></i>
                    <span className="wm-ppl-t"><b>Add {pqMail}</b><small>Someone who isn't in your contacts · Enter</small></span>
                    <span className="wm-cl-tick"><Ico d={I.plus} s={14} /></span>
                  </button>
                )}
                <span className="wm-ppl-k"><Ico d={I.person} s={13} />Contacts</span>
                {found === null ? <span className="wm-skel" /> : found.length ? found.map(contactRow) : <p className="wm-empty">No contact matches “{pq.trim()}”.</p>}
              </>)}
            </div>
            {(contacts.length > 0 || extra.length > 0) && mailToggle(guestsMail, setGuestsMail, "Send them a calendar invitation")}
            {last && <section className="wm-sec wm-rows">{optionRows}</section>}
          </div>
        );
      case "check":
        return (
          <div className="wm-fin">
            {kind === "shipment" && <section className="wm-sec">{whenFields}</section>}
            <section className="wm-sec wm-what">
              <label className="wm-fl"><span>Name <small>optional · on the calendar and on invitations</small></span>
                <input value={title} disabled={billed} onChange={(x) => setTitle(x.target.value)}
                  placeholder={kind === "shipment" ? (prod ? `${round2(qn)} × ${prod.label}` : "e.g. Spring order") : client ? `e.g. Weekly call with ${client.name}` : "e.g. Kick-off workshop"} />
              </label>
              <label className="wm-fl"><span>{kind === "shipment" ? "Notes" : "What you did"} <small>optional{kind === "client_work" && billable ? " · it can go on the invoice" : ""}</small></span>
                <textarea rows={1} value={notes} disabled={billed}
                  ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }}
                  placeholder={kind === "shipment" ? "Tracking number, address, what went in the box…" : "What was done"}
                  onChange={(x) => { setNotes(x.target.value); x.target.style.height = "auto"; x.target.style.height = `${x.target.scrollHeight}px`; }} />
              </label>
            </section>
            <section className="wm-sec wm-rows">
              {kind === "client_work" && row("bill", "Billing", seg<"yes" | "no">("Billing", billable ? "yes" : "no",
                [["yes", "Billable", I.euro], ["no", "Not billable", I.noeuro]], (v) => setBillable(v === "yes"), billable ? "" : "is-amber", billed),
                billable ? `${hrs(hours)} · next invoice` : "never invoiced")}
              {optionRows}
            </section>
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
            <p>{longDay}{kind && cur !== "what" ? <> · {kind === "shipment" ? from : `${from} – ${to}`}</> : null}{kind && kind !== "internal" && client && cur !== "client" ? <> · {client.name}</> : null}{peopleCount && last ? <> · {peopleCount} {peopleCount === 1 ? "person" : "people"}</> : null}</p>
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
