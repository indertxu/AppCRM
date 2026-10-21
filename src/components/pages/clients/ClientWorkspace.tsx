/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { Client, Project, ProjectType, ClientRole } from "./clientsTypes";
import { projectValue, signedOf, legacyRoleMap, resolvedLinesOf, lineRate, roleNameOf, roleCounts, totalDiscountOf, domainOf, logoCandidates } from "./clientsTypes";
import { supabase } from "../../api/supabase";
import ClientDirectory, { copyIntoClientFolders } from "./ClientDirectory";
import { ClientUpsells } from "./ClientsPage";
import MentionInput, { type MentionPerson } from "../../framework/MentionInput";
import { addTask, toggleTask, updateTaskMeta, saveClientProducts, type PaymentSchedule, type TaskPriority, type TrackTask } from "../sales/sales/salesApi";
import { loadProducts, type Product as CatalogProduct } from "../settings/catalogApi";
import { listCompanyFields, listContactFields, sessionUserId, saveContact, useRequiredFields, type CompanyField, type ContactField } from "../companies/companiesApi";
import { countryLabel, formatAddress, languageName, linkedInHandle, isFixedRequired, missingFixed } from "../contacts/contactProfile";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import "../../framework/MentionInput.css";
import "./ClientWorkspace.css";

interface Props {
  client: Client;
  projects: Project[];
  projectTypes: ProjectType[];
  usage: Record<string, { planned: number; done: number }>;
  /** Every role, to name each project's role lines. */
  roles?: ClientRole[];
  onOpenProject: (p: Project) => void;
  onNewProject: () => void;
  onDeleteProject: (id: string) => void;
  onClose: () => void;
}

type Tab = "overview" | "deals" | "projects" | "contract" | "upsells" | "folders";

interface Note { id: string; body: string; mentions: string[]; author_id: string | null; created_at: string; src: "client" | "sale"; deal?: string | null; dealId?: string | null }
interface ContactLog { id: string; contacted_at: string; channel: string | null; contact_name: string | null; reason: string | null; logged_by: string | null; }
interface TrackFile { id: string; tracking_id: string; name: string; note: string | null; mime: string | null; storage_path: string; created_at: string; size_bytes?: number | null; line_id?: string | null }
/** A proposal sales generated on a deal (deal_proposals): a named scenario with its value and document. */
interface DealProposal { id: string; tracking_id: string; name: string; is_main: boolean; total: number | null; file_id: string | null; created_at: string }
interface Touch { at: string; kind: string; who: string; why: string }
interface Person { key: string; id: string | null; name: string; position: string; email: string; phone: string; billing: boolean; crm: boolean; c: any | null }
interface Deal {
  id: string; name: string; status: string | null;
  phase?: string | null; pipeline?: string | null; created_at?: string | null; close_date?: string | null; price?: number | null;
}
export type Line = Record<string, any> & { id: string; name: string };
/** A task from one of the client's sales (tracking_tasks) or the client's own (client_tasks, src "client"). */
type Task = TrackTask & { tracking_id: string; assignees: string[]; src?: "client" | "sale" };

/* ============================== helpers ============================== */

const DAY = 86400000;
const str = (v: unknown) => (v == null ? "" : String(v).trim());
/** "Sale · Won", "Sale · Hold"… for the blocks that keep each sale's tasks and notes apart. */
const saleSub = (status?: string | null) => {
  const s = status === "paused" ? "hold" : (status ?? "");
  return s ? `Sale · ${s.charAt(0).toUpperCase()}${s.slice(1)}` : "Sale";
};
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const clamp = (n: number, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const toDate = (s: string) => new Date(s.length === 10 ? `${s}T12:00:00` : s);
const daysSince = (s: string) => Math.floor((Date.now() - toDate(s).getTime()) / DAY);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmt = (s?: string | null) => (s ? toDate(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtD = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const eur = (n: number) => `${Math.round(n).toLocaleString()} €`;
const d2 = (n: number) => (+n.toFixed(2)).toLocaleString();
const ago = (s: string) => {
  const d = daysSince(s);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
};
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/** Website and LinkedIn of the client's company, edited in place (the logo comes from the website). */
function WebLinks({ companyId, website, linkedin, onSaved }: {
  companyId: string; website: string; linkedin: string;
  onSaved: (patch: { website: string | null; linkedin: string | null }) => void;
}) {
  const [edit, setEdit] = useState(false);
  const [w, setW] = useState(website);
  const [l, setL] = useState(linkedin);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!edit) { setW(website); setL(linkedin); } }, [website, linkedin, edit]);
  const clean = (v: string) => v.trim().replace(/\/+$/, "");
  const save = async () => {
    const patch = { website: clean(w) || null, linkedin: clean(l) || null };
    setBusy(true); setErr(null);
    const { error } = await supabase.from("companies").update(patch).eq("id", companyId);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onSaved(patch); setEdit(false);
  };
  const host = website.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!edit) {
    return (
      <div className="cw-web">
        <span className={`cw-web-chip ${website ? "" : "is-empty"}`}><Ico n="globe" s={13} />{website ? host : "No website"}</span>
        <span className={`cw-web-chip ${linkedin ? "" : "is-empty"}`}><Ico n="linkedin" s={13} />{linkedin ? linkedInHandle(linkedin) : "No LinkedIn"}</span>
        <button className="cw-web-edit" onClick={() => setEdit(true)}>
          <Ico n="edit" s={13} />{website || linkedin ? "Edit links" : "Add website & LinkedIn"}
        </button>
      </div>
    );
  }
  return (
    <div className="cw-web is-edit" onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") { e.stopPropagation(); setEdit(false); } }}>
      <label><Ico n="globe" s={13} /><input autoFocus value={w} onChange={(e) => setW(e.target.value)} placeholder="www.company.com" /></label>
      <label><Ico n="linkedin" s={13} /><input value={l} onChange={(e) => setL(e.target.value)} placeholder="linkedin.com/company/…" /></label>
      <button className="cw-web-cancel" onClick={() => setEdit(false)}>Cancel</button>
      <button className="cw-web-save" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      {err && <span className="cw-web-err">{err}</span>}
    </div>
  );
}

/* ---- Company logos (from the website; LinkedIn has no public way to read a logo) ---- */
/** Per domain, for the session: which candidate to try next (a failed one is never asked for again) and which loaded. */
const logoNext = new Map<string, number>();
const logoGood = new Map<string, string>();
/**
 * The company's logo from its website, else its initials. Initials show until the
 * image has really loaded, so nothing flickers; a blank default icon counts as no logo.
 */
export function CompanyLogo({ name, website, className = "" }: { name: string; website?: string | null; className?: string }) {
  const d = domainOf(website) ?? "";
  const cands = useMemo(() => logoCandidates(website), [website]);
  const [i, setI] = useState(() => logoNext.get(d) ?? 0);
  const [ok, setOk] = useState(() => !!logoGood.get(d));
  useEffect(() => { setI(logoNext.get(d) ?? 0); setOk(!!logoGood.get(d)); }, [d]);
  const src = logoGood.get(d) ?? cands[i];
  const miss = () => { const n = i + 1; logoNext.set(d, n); setI(n); setOk(false); };
  // One fixed square: the initials, and the logo laid over them once it has really loaded.
  // The image never shows at its own size and never sits next to the initials.
  return (
    <span className={`co-logo ${className} ${src && ok ? "is-img" : ""}`.trim()} aria-hidden="true">
      <span className="co-logo-ini">{initials(name)}</span>
      {src && (
        <img key={src} className="co-logo-img" src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false}
          onLoad={(e) => {
            const w = e.currentTarget.naturalWidth, h = e.currentTarget.naturalHeight;
            // too small to be a logo (Google's 16px globe, a tiny favicon): try the next one / keep the initials
            if (!w || !h || Math.max(w, h) < 32) { miss(); return; }
            logoGood.set(d, src); setOk(true);
          }}
          onError={miss} />
      )}
    </span>
  );
}
/* ---- Client → website lookup, shared by every page that only knows a client id or name (Management, …).
   Loaded once per session in a few light queries, then read synchronously from memory. ---- */
const siteKey = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[.,]/g, " ").replace(/\b(s\s?a\s?u?|s\s?l\s?u?|s\s?c|inc|ltd|llc|gmbh|ag|bv|sas|srl|spa|plc|corp)\b/g, " ").replace(/\s+/g, " ").trim();
const clientSites = new Map<string, string>();
let clientSitesP: Promise<void> | null = null;
let clientSitesVer = 0;
const clientSiteSubs = new Set<(v: number) => void>();
function loadClientSites(): Promise<void> {
  if (clientSitesP) return clientSitesP;
  clientSitesP = (async () => {
    try {
      const { data: cls } = await supabase.from("clients").select("id, name, company_id");
      const clients = (cls ?? []) as { id: string; name: string | null; company_id: string | null }[];
      const ids = Array.from(new Set(clients.map((c) => c.company_id).filter(Boolean))) as string[];
      const cos: { id: string; name: string | null; legal_name?: string | null; website: string | null }[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await supabase.from("companies").select("id, name, legal_name, website").in("id", ids.slice(i, i + 200));
        cos.push(...((data ?? []) as any[]));
      }
      // clients with no linked company (or one with no website): look for a company with the same name
      const byId = new Map(cos.map((c) => [c.id, c]));
      const orphanNames = clients.filter((c) => c.name && !(c.company_id && byId.get(c.company_id)?.website)).map((c) => c.name as string);
      for (let i = 0; i < orphanNames.length; i += 150) {
        const { data } = await supabase.from("companies").select("id, name, legal_name, website").in("name", orphanNames.slice(i, i + 150)).not("website", "is", null);
        cos.push(...((data ?? []) as any[]));
      }
      cos.forEach((c) => {
        if (!c.website || !domainOf(c.website)) return;
        clientSites.set(`co:${c.id}`, c.website);
        [c.name, c.legal_name].forEach((n) => { const k = siteKey(n); if (k && !clientSites.has(`n:${k}`)) clientSites.set(`n:${k}`, c.website!); });
      });
      clients.forEach((c) => {
        const w = (c.company_id && byId.get(c.company_id)?.website) || clientSites.get(`n:${siteKey(c.name)}`) || "";
        if (w && domainOf(w)) { clientSites.set(`id:${c.id}`, w); const k = siteKey(c.name); if (k && !clientSites.has(`n:${k}`)) clientSites.set(`n:${k}`, w); }
      });
    } catch { /* no logos: the initials stay */ }
    clientSitesVer++;
    clientSiteSubs.forEach((f) => f(clientSitesVer));
  })();
  return clientSitesP;
}
/** Companies that aren't clients yet (e.g. incoming handoffs): asked for by id, batched, once each. */
const companyAsked = new Set<string>();
let companyQueue: string[] = [];
let companyTimer: ReturnType<typeof setTimeout> | null = null;
function askCompanySite(id: string) {
  if (companyAsked.has(id)) return;
  companyAsked.add(id); companyQueue.push(id);
  if (companyTimer) return;
  companyTimer = setTimeout(async () => {
    const ids = companyQueue; companyQueue = []; companyTimer = null;
    try {
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await supabase.from("companies").select("id, name, legal_name, website").in("id", ids.slice(i, i + 200));
        ((data ?? []) as any[]).forEach((c) => {
          if (!c.website || !domainOf(c.website)) return;
          clientSites.set(`co:${c.id}`, c.website);
          [c.name, c.legal_name].forEach((n: string | null) => { const k = siteKey(n); if (k && !clientSites.has(`n:${k}`)) clientSites.set(`n:${k}`, c.website); });
        });
      }
    } catch { /* initials stay */ }
    clientSitesVer++;
    clientSiteSubs.forEach((f) => f(clientSitesVer));
  }, 30);
}
/** The website we know for a client (by client id, company id, else by name); "" until loaded or when there is none. */
export function useClientSite(name?: string | null, clientId?: string | null, companyId?: string | null): string {
  const [, setV] = useState(clientSitesVer);
  useEffect(() => {
    clientSiteSubs.add(setV);
    void loadClientSites();
    return () => { clientSiteSubs.delete(setV); };
  }, []);
  useEffect(() => { if (companyId) askCompanySite(companyId); }, [companyId]);
  return (clientId && clientSites.get(`id:${clientId}`)) || (companyId && clientSites.get(`co:${companyId}`))
    || (name ? clientSites.get(`n:${siteKey(name)}`) : "") || "";
}
/** CompanyLogo for places that only know the client's id / company id / name. */
export function ClientLogo({ name, clientId, companyId, website, className = "" }: { name: string; clientId?: string | null; companyId?: string | null; website?: string | null; className?: string }) {
  const known = useClientSite(name, clientId, companyId);
  return <CompanyLogo name={name || "?"} website={website || known} className={className} />;
}
const plain = (body: string) => body.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
const reduceMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const cssVars = (o: Record<string, string | number>) => o as React.CSSProperties;

/** Render a note body, turning "@[name](id)" tokens into mention pills. */
function renderNoteBody(body: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /@\[([^\]]+)\]\((?:employee|contact):[^)\s]+\)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(body))) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push(<span className="cw-mention-pill" key={i++}>{m[1]}</span>);
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts.length ? parts : body;
}

/* contract maths */
const perYear = (p: unknown) => {
  const k = norm(str(p));
  if (/month|mes|mensual/.test(k)) return 12;
  if (/quarter|trim/.test(k)) return 4;
  if (/semi|half|semest/.test(k)) return 2;
  if (/week|seman/.test(k)) return 52;
  return 1;
};
const periodLabel = (p: unknown) => ({ 12: "month", 4: "quarter", 2: "half-year", 52: "week", 1: "year" } as Record<number, string>)[perYear(p)];
const lineTotal = (l: Line) => {
  const q = Number(l.quantity) || 1, p = Number(l.price) || 0, v = Number(l.discount_value) || 0;
  if (l.discount_mode === "percent") return p * q * (1 - v / 100);
  if (l.discount_mode === "rate") return Math.max(0, p - v) * q;
  if (l.discount_mode === "total" || l.discount_mode === "amount") return Math.max(0, p * q - v);
  return p * q;
};
const lineAnnual = (l: Line) => (l.recurring ? lineTotal(l) * perYear(l.period) : 0);
/** The payment terms of a line (null = paid as one block, no increases). */
const scheduleOf = (l: Line): PaymentSchedule | null => {
  const sc = l.schedule;
  if (!sc || typeof sc !== "object" || !(Number(sc.count) > 0)) return null;
  return { count: Math.round(Number(sc.count)), increases: Array.isArray(sc.increases) ? sc.increases.map((x: unknown) => Number(x) || 0) : [] };
};
/** Each term of a recurring line: its length, its price per period (with the increases so far) and what it adds up to. */
const termsOf = (l: Line, sc: PaymentSchedule | null = scheduleOf(l)) => {
  const years = Number(l.term_years) || 1;
  const count = sc?.count ?? 1;
  const len = years / count;
  const unit = lineTotal(l);
  let mult = 1;
  return Array.from({ length: count }, (_, i) => {
    mult *= 1 + (sc?.increases[i] ?? 0) / 100;
    const u = unit * mult;
    return { i, len, from: i * len, inc: sc?.increases[i] ?? 0, unit: u, amount: u * perYear(l.period) * len };
  });
};
/** What a signed product is worth over its contract: every term of a recurring line (1 year when no term), or the one-off price, plus the set-up fee. */
export const lineContractValue = (l: Line) => (l.recurring ? termsOf(l).reduce((t, x) => t + x.amount, 0) : lineTotal(l)) + (Number(l.one_time_fee) || 0);
export { lineAnnual, lineTotal };
export const isActive = (l: Line) => !l.status || /active|signed|live/i.test(String(l.status));
const addYears = (d0: Date, y: number) => {
  const d = new Date(d0);
  d.setFullYear(d.getFullYear() + Math.floor(y));
  d.setMonth(d.getMonth() + Math.round((y % 1) * 12));
  return d;
};
export function termOf(l: Line) {
  const s = str(l.start_date) || str(l.signing_date);
  const y = Number(l.term_years) || 0;
  if (!s || !y) return null;
  const start = toDate(s);
  let end = addYears(start, y);
  let renewed = 0;
  const step = Number(l.renew_years) || y;
  while (l.auto_renew && end.getTime() < Date.now() && renewed < 50) { end = addYears(end, step); renewed++; }
  const from = renewed ? addYears(end, -step) : start;
  return {
    start, end, renewed,
    pct: clamp((Date.now() - from.getTime()) / Math.max(1, end.getTime() - from.getTime())),
    left: Math.ceil((end.getTime() - Date.now()) / DAY),
  };
}

/* tasks */
const PRI: TaskPriority[] = ["urgent", "high", "normal", "low"];
const STATUS = ["todo", "in_progress", "blocked", "done"];
const toTask = (t: any, assignees: string[] = []): Task => {
  const done = !!t.done || t.status === "done";
  return {
    ...t,
    done,
    priority: PRI.includes(t.priority) ? t.priority : "normal",
    status: done ? "done" : STATUS.includes(t.status) && t.status !== "done" ? t.status : "todo",
    progress: Math.max(0, Math.min(100, Number(t.progress) || (done ? 100 : 0))),
    assignees,
  };
};
const dueInfo = (due?: string | null) => {
  if (!due) return null;
  const d = toDate(due); const t = new Date(); t.setHours(0, 0, 0, 0);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  const n = Math.round((dd.getTime() - t.getTime()) / DAY);
  const label = n === 0 ? "Today" : n === 1 ? "Tomorrow" : n === -1 ? "Yesterday" : n < 0 ? `${-n}d late` : n < 7 ? dd.toLocaleDateString(undefined, { weekday: "short" }) : dd.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return { n, label, tone: n < 0 ? "late" : n === 0 ? "today" : n <= 3 ? "soon" : "later" };
};

/* ============================== icons ============================== */

const IC: Record<string, string> = {
  overview: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  building: "M3 21h18M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M16 9h3a2 2 0 0 1 2 2v10M9 7h3M9 11h3M9 15h3",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  pulse: "M22 12h-4l-3 9L9 3l-3 9H2",
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  contract: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  check: "M20 6 9 17l-5-5",
  tasks: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  note: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  phone: "M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  pin: "M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  out: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  arrow: "M5 12h14M13 6l6 6-6 6",
  chev: "m6 9 6 6 6-6",
  plus: "M12 5v14M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
  cal: "M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM16 2v4M8 2v4M3 10h18",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  repeat: "m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  briefcase: "M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  trash: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  linkedin: "M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2zM4 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z",
  spark: "M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  euro: "M4 10h12M4 14h9M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2",
  flag: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  deal: "M3 3v18h18M7 15l4-4 3 3 6-7",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  star: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z",
  copy: "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
};
const Ico = ({ n, s = 16 }: { n: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={IC[n] ?? ""} />
  </svg>
);
const KIND_ICON: Record<string, string> = { call: "phone", phone: "phone", email: "mail", mail: "mail", meeting: "users", visit: "pin", message: "chat", delivery: "briefcase", note: "note" };
const kindIcon = (k: string) => KIND_ICON[k] ?? "pulse";
const CHANNELS = ["call", "email", "meeting", "visit", "message"];

/* ============================== small pieces ============================== */

/** Eased count-up from the last shown value to `target`. */
function useCount(target: number, ms = 950) {
  const [v, setV] = useState(0);
  const shown = useRef(0);
  useEffect(() => {
    if (reduceMotion()) { shown.current = target; setV(target); return; }
    const a = shown.current, t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const x = a + (target - a) * (1 - Math.pow(1 - k, 3));
      shown.current = x; setV(x);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
function Num({ v, dp = 0, suffix }: { v: number; dp?: number; suffix?: React.ReactNode }) {
  const x = useCount(v);
  return <>{dp ? (+x.toFixed(dp)).toLocaleString(undefined, { maximumFractionDigits: dp }) : Math.round(x).toLocaleString()}{suffix}</>;
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string; n?: number }[]; onChange: (v: T) => void }) {
  const i = Math.max(0, options.findIndex((o) => o.v === value));
  return (
    <div className="cw-seg" style={cssVars({ "--n": options.length, "--i": i })}>
      <span className="cw-seg-ink" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.v} className={o.v === value ? "is-on" : ""} onClick={() => onChange(o.v)}>
          {o.label}{o.n != null && <i>{o.n}</i>}
        </button>
      ))}
    </div>
  );
}

function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  return <span className="cw-ava" style={cssVars({ "--h": hue(name), width: size, height: size, fontSize: Math.round(size * 0.36) })}>{initials(name)}</span>;
}

/** Label → value rows; only what is filled in. */
function FactRows({ rows, empty = "Nothing filled in yet" }: { rows: { k: string; v: React.ReactNode }[]; empty?: string }) {
  const xs = rows.filter((r) => r.v != null && r.v !== "" && r.v !== "—" && r.v !== false);
  if (!xs.length) return <p className="cw-rows-empty">{empty}</p>;
  return <dl className="cw-rows">{xs.map((r) => <div key={r.k}><dt>{r.k}</dt><dd>{r.v}</dd></div>)}</dl>;
}

/** A quick action: call, email, website, map… */
function Act({ icon, href, children, ext }: { icon: string; href: string; children: React.ReactNode; ext?: boolean }) {
  return (
    <a className="cw-act" href={href} {...(ext ? { target: "_blank", rel: "noreferrer" } : {})} onClick={(e) => e.stopPropagation()}>
      <Ico n={icon} s={14} /><span>{children}</span>
    </a>
  );
}
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, "")}`;

const customValue = (v: unknown, type: string) => {
  if (v == null || v === "") return "";
  if (type === "boolean") return v ? "Yes" : "No";
  if (type === "date") return fmt(String(v));
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
};

function SecHead({ icon, tone, title, sub, children }: { icon: string; tone: string; title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="cw-sh">
      <span className="cw-sh-ico" data-tone={tone}><Ico n={icon} s={16} /></span>
      <div className="cw-sh-t"><h3>{title}</h3>{sub && <small>{sub}</small>}</div>
      {children && <div className="cw-sh-tools">{children}</div>}
    </header>
  );
}

const shortAgo = (s: string) => {
  const d = daysSince(s);
  if (d <= 0) return "today";
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
};

/* ============================== hover cards ============================== */

type TipState = { r: DOMRect; node: React.ReactNode; id: number };
type TipOn = (node: React.ReactNode) => {
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: () => void;
};

/** One floating card for the whole popup, placed under (or over) whatever is hovered. */
function TipLayer({ tip }: { tip: TipState | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) { setPos(null); return; }
    const w = el.offsetWidth, h = el.offsetHeight;
    const up = tip.r.bottom + h + 16 > window.innerHeight && tip.r.top - h - 16 > 0;
    const x = clamp(tip.r.left + tip.r.width / 2 - w / 2, 12, window.innerWidth - w - 12);
    setPos({ x, y: up ? tip.r.top - h - 8 : tip.r.bottom + 8, up });
  }, [tip]);
  if (!tip) return null;
  return (
    <div ref={ref} key={tip.id} role="tooltip"
      className={`cw-tip ${pos ? "is-in" : ""} ${pos?.up ? "is-up" : ""}`}
      style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: 0 }}>
      {tip.node}
    </div>
  );
}

function TipCard({ title, sub, rows, children }: { title?: React.ReactNode; sub?: React.ReactNode; rows?: [string, React.ReactNode][]; children?: React.ReactNode }) {
  const rs = (rows ?? []).filter(([, v]) => v != null && v !== "" && v !== false);
  return (
    <div className="cw-tipc">
      {title && <b className="cw-tipc-t">{title}</b>}
      {sub && <small className="cw-tipc-s">{sub}</small>}
      {children && <p className="cw-tipc-p">{children}</p>}
      {rs.length > 0 && <dl>{rs.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
    </div>
  );
}

/* ============================== person card ============================== */

function PersonCard({ p, i, open, onToggle, last, fields, onOpenContact, onLog, tipOn }: {
  p: Person; i: number; open: boolean; onToggle: () => void; last: string | null;
  fields: ContactField[]; onOpenContact: (id: string) => void; onLog: (name: string) => void; tipOn: TipOn;
}) {
  const c = p.c ?? {};
  const d = last ? daysSince(last) : null;
  const tone = d == null ? "none" : d > 60 ? "bad" : d > 30 ? "warn" : "ok";
  const addr = p.crm ? formatAddress(c) : "";
  const custom = fields.map((f) => ({ k: f.label, v: customValue(c.custom?.[f.id], f.type) })).filter((x) => x.v);
  return (
    <article className={`cw-pc ${open ? "is-open" : ""} ${p.billing ? "is-billing" : ""}`} style={cssVars({ "--i": i })}>
      <div className="cw-pc-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={onToggle} onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}
        {...(open ? {} : tipOn(
          <TipCard title={p.name} sub={[p.position, p.billing ? "Billing contact" : "", p.crm ? "CRM contact" : "From the project sheet"].filter(Boolean).join(" · ")}
            rows={[["Email", p.email], ["Phone", p.phone], ["Language", c.language ? languageName(c.language) : ""], ["Last contact", last ? `${fmt(last)} · ${ago(last)}` : "Never"]]} />,
        ))}>
        <Avatar name={p.name} size={40} />
        <span className="cw-pc-id">
          <b>{p.name}</b>
          <small>{p.position || (p.crm ? "Contact" : "Project contact")}{p.phone && <> · <a className="cw-pc-tel" href={telHref(p.phone)} onClick={(e) => e.stopPropagation()}>{p.phone}</a></>}</small>
        </span>
        <span className="cw-pc-quick">
          {p.email && <a href={`mailto:${p.email}`} onClick={(e) => e.stopPropagation()} aria-label="Email"><Ico n="mail" s={14} /></a>}
          {p.phone && <a href={telHref(p.phone)} onClick={(e) => e.stopPropagation()} aria-label="Call"><Ico n="phone" s={14} /></a>}
          {c.linkedin && <a href={c.linkedin} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label="LinkedIn"><Ico n="linkedin" s={14} /></a>}
        </span>
        <span className={`cw-pc-last is-${tone}`}><i />{d == null ? "never" : shortAgo(last!)}</span>
      </div>
      <div className="cw-reveal" aria-hidden={!open}>
        <div className="cw-reveal-in">
          {(p.phone || p.email || c.linkedin) && (
            <div className="cw-acts">
              {p.phone && <Act icon="phone" href={telHref(p.phone)}>{p.phone}</Act>}
              {p.email && <Act icon="mail" href={`mailto:${p.email}`}>{p.email}</Act>}
              {c.linkedin && <Act icon="linkedin" href={c.linkedin} ext>{linkedInHandle(c.linkedin)}</Act>}
            </div>
          )}
          <FactRows rows={[
            { k: "Position", v: p.position },
            { k: "Role", v: p.billing ? "Billing contact" : "" },
            { k: "Language", v: c.language ? languageName(c.language) : "" },
            { k: "Last contact", v: last ? `${fmt(last)} · ${ago(last)}` : "" },
            { k: "Address", v: addr },
            ...custom,
            { k: "Notes", v: str(c.notes) },
          ]} empty="No more details on file" />
          <div className="cw-pc-actions">
            <button className="cw-ghost" onClick={() => onLog(p.name)}><Ico n="pulse" s={14} />Log contact</button>
            {p.crm && p.id && <button className="cw-ghost is-go" onClick={() => onOpenContact(p.id!)}>Open in Contacts<Ico n="arrow" s={14} /></button>}
          </div>
        </div>
      </div>
    </article>
  );
}

/* ============================== payment terms ============================== */

/** Split a multi-year contract into terms, each with its own increase %. */
function ScheduleEditor({ years, unit, per, value, onChange }: {
  years: number; unit: number; per: string; value: PaymentSchedule; onChange: (v: PaymentSchedule) => void;
}) {
  const [all, setAll] = useState("");
  const max = Math.max(1, Math.min(24, Math.round(years * 12)));
  const count = Math.min(Math.max(1, value.count), max);
  const incs = Array.from({ length: count }, (_, i) => value.increases[i] ?? 0);
  const setCount = (n: number) => { const c = Math.min(max, Math.max(1, n)); onChange({ count: c, increases: Array.from({ length: c }, (_, i) => value.increases[i] ?? 0) }); };
  const setInc = (i: number, v: string) => onChange({ count, increases: incs.map((x, j) => (j === i ? Number(String(v).replace(",", ".")) || 0 : x)) });
  const len = years / count;
  const lenLabel = (k: number) => {
    const a = k * len, b = (k + 1) * len;
    const fmtY = (y: number) => (Number.isInteger(y) ? `${y}` : y.toFixed(1));
    return len >= 1 && Number.isInteger(len) ? (len === 1 ? `Year ${b}` : `Years ${fmtY(a + 1)}–${fmtY(b)}`) : `${Math.round(a * 12) + 1}–${Math.round(b * 12)} mo`;
  };
  let mult = 1;
  return (
    <div className="cw-sched">
      <div className="cw-sched-head">
        <span className="cw-sched-k">Paid in</span>
        <span className="cw-step">
          <button type="button" onClick={() => setCount(count - 1)} disabled={count <= 1}>−</button>
          <b>{count}</b>
          <button type="button" onClick={() => setCount(count + 1)} disabled={count >= max}>+</button>
        </span>
        <span className="cw-sched-k">term{count === 1 ? "" : "s"} over {years} year{years === 1 ? "" : "s"}</span>
        {count > 1 && (
          <span className="cw-sched-all">
            <input inputMode="decimal" value={all} placeholder="%" onChange={(e) => setAll(e.target.value)} />
            <button type="button" onClick={() => { const v = Number(all.replace(",", ".")) || 0; onChange({ count, increases: incs.map((_, i) => (i === 0 ? 0 : v)) }); }}>Same increase each term</button>
          </span>
        )}
      </div>
      {count > 1 && (
        <div className="cw-sched-rows">
          {incs.map((inc, i) => {
            mult *= 1 + inc / 100;
            return (
              <div className="cw-sched-row" key={i}>
                <span className="cw-sched-n">{i + 1}</span>
                <span className="cw-sched-t">{lenLabel(i)}</span>
                <label className="cw-sched-inc">
                  <input inputMode="decimal" value={inc ? String(inc) : ""} placeholder="0" disabled={i === 0 && !inc} onChange={(e) => setInc(i, e.target.value)} />
                  <em>% {i === 0 ? "start" : "increase"}</em>
                </label>
                <b className="cw-sched-v">{eur(unit * mult)}<em> / {per}</em></b>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================== add a signed product by hand ============================== */

function AddLineForm({ clientId, persons, onCancel, onSaved }: {
  clientId: string; persons: Person[]; onCancel: () => void; onSaved: () => void | Promise<void>;
}) {
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [pid, setPid] = useState("");
  const [tier, setTier] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("1");
  const [disc, setDisc] = useState("");
  const [signed, setSigned] = useState(todayISO());
  const [term, setTerm] = useState("1");
  const [renew, setRenew] = useState(true);
  const [fee, setFee] = useState("");
  const [ref, setRef] = useState("");
  const [billing, setBilling] = useState(persons.find((p) => p.billing)?.key ?? "");
  const [sched, setSched] = useState<PaymentSchedule>({ count: 1, increases: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { loadProducts().then((xs) => setProducts(xs.filter((x) => x.active !== false))).catch(() => setProducts([])); }, []);
  const prod = products?.find((x) => x.id === pid) ?? null;
  const recurring = prod?.billing === "recurring";
  const period = prod?.billing_period === "yearly" ? "year" : "month";
  const pick = (id: string) => {
    setPid(id);
    const pr = products?.find((x) => x.id === id);
    const t = pr?.tiers?.[0];
    setTier(t?.id ?? t?.name ?? "");
    setPrice(t ? String(t.price) : "");
  };
  const pickTier = (k: string) => {
    setTier(k);
    const t = prod?.tiers.find((x) => (x.id ?? x.name) === k);
    if (t) setPrice(String(t.price));
  };
  const n = (v: string) => Number(String(v).replace(",", ".")) || 0;
  const unit = n(price) * (n(qty) || 1) * (1 - Math.min(100, n(disc)) / 100);
  const save = async () => {
    if (!prod?.id) { setErr("Pick a product."); return; }
    if (!signed) { setErr("Add the signing date."); return; }
    setBusy(true); setErr(null);
    const who = persons.find((p) => p.key === billing);
    const e = await saveClientProducts(clientId, null, [{
      productId: prod.id, price: n(price), quantity: n(qty) || 1, recurring, period: recurring ? period : null,
      termYears: recurring ? n(term) || null : null, discountMode: n(disc) ? "percent" : null, discountValue: n(disc) || null,
      signingDate: signed, oneTimeFee: n(fee), autoRenew: recurring && renew, renewYears: recurring && renew ? n(term) || 1 : null,
      contractRef: ref.trim(), billingContactName: who?.name ?? null, billingContactEmail: who?.email || null,
      schedule: recurring && (sched.count > 1 || sched.increases.some(Boolean)) ? sched : null,
    }]);
    setBusy(false);
    if (e) { setErr(e); return; }
    await onSaved();
  };
  return (
    <div className="cw-logform cw-addl">
      <div className="cw-addl-grid">
        <label className="is-wide"><span>Product</span>
          <Select value={pid} onChange={pick} placeholder={products ? (products.length ? "Pick a product…" : "No products in the catalog yet") : "Loading…"}
            options={(products ?? []).map((x) => ({ value: x.id!, label: x.name, hint: x.billing === "recurring" ? `Every ${x.billing_period === "yearly" ? "year" : "month"}` : "One-off" }))} />
        </label>
        {prod && prod.tiers.length > 1 && (
          <label><span>Tier</span>
            <Select value={tier} onChange={pickTier} options={prod.tiers.map((t) => ({ value: t.id ?? t.name, label: t.name, hint: eur(t.price) }))} />
          </label>
        )}
        <label><span>Price{recurring ? ` / ${period}` : ""}</span><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" /></label>
        <label><span>Quantity</span><input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label><span>Discount %</span><input inputMode="decimal" value={disc} onChange={(e) => setDisc(e.target.value)} placeholder="0" /></label>
        <label><span>Signed on</span><span className="cw-date"><DatePicker value={signed} onChange={(d) => setSigned(d || "")} /></span></label>
        {recurring && <label><span>Term (years)</span><input inputMode="decimal" value={term} onChange={(e) => setTerm(e.target.value)} /></label>}
        <label><span>Set-up fee</span><input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" /></label>
        <label><span>Contract ref.</span><input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. CT-2026-031" /></label>
        {persons.length > 0 && (
          <label><span>Billing contact</span>
            <Select value={billing} onChange={setBilling} placeholder="—" options={[{ value: "", label: "—" }, ...persons.map((p) => ({ value: p.key, label: p.name, hint: p.email }))]} />
          </label>
        )}
        {recurring && (
          <button type="button" className={`cw-addp-bill ${renew ? "is-on" : ""}`} onClick={() => setRenew((v) => !v)}>
            <i>{renew && <Ico n="check" s={11} />}</i>Renews automatically
          </button>
        )}
      </div>
      {recurring && n(term) > 1 && (
        <ScheduleEditor years={n(term)} unit={unit} per={period} value={sched} onChange={setSched} />
      )}
      {err && <p className="cw-err">{err}</p>}
      <div className="cw-logactions">
        <span className="cw-addl-sum">{prod ? <>{eur(unit)}{recurring ? <em> / {period}</em> : null}{n(fee) ? <em> + {eur(n(fee))} set-up</em> : null}</> : null}</span>
        <button className="cw-ghost" onClick={onCancel}>Cancel</button>
        <button className="cw-btn-primary is-sm" disabled={busy || !prod} onClick={() => void save()}>{busy ? "Saving…" : "Add signed product"}</button>
      </div>
    </div>
  );
}

/* ============================== workspace ============================== */

export default function ClientWorkspace({
  client, projects, projectTypes, usage, roles = [], onOpenProject, onNewProject, onDeleteProject, onClose,
}: Props) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("overview");
  const [closing, setClosing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [me, setMe] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [clientRow, setClientRow] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  const [coFields, setCoFields] = useState<CompanyField[]>([]);
  const [ctFields, setCtFields] = useState<ContactField[]>([]);
  const [crmContacts, setCrmContacts] = useState<any[]>([]);
  const [units, setUnits] = useState<Record<string, "hour" | "day">>({});
  const [people, setPeople] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Note[]>([]);
  const [saleNotes, setSaleNotes] = useState<Note[]>([]);
  const [contactLog, setContactLog] = useState<ContactLog[]>([]);
  const [trackFiles, setTrackFiles] = useState<TrackFile[]>([]);
  const [proposals, setProposals] = useState<DealProposal[]>([]);
  /** What already sits in the client's folders ("name|size" and bare names), to tell which sales files arrived. */
  const [dirKeys, setDirKeys] = useState<{ sized: Set<string>; names: Set<string> }>({ sized: new Set(), names: new Set() });
  const [dirRev, setDirRev] = useState(0);
  const [copyBusy, setCopyBusy] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [meetings, setMeetings] = useState<{ at: string; title: string }[]>([]);
  const [nextMeeting, setNextMeeting] = useState<{ at: string; title: string } | null>(null);
  const [calendar, setCalendar] = useState<Touch[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [saleTasks, setTasks] = useState<Task[]>([]);
  /** The client's own tasks, made once it is a client (client_tasks, handoff_v2.sql). */
  const [clientTasks, setClientTasks] = useState<Task[]>([]);
  const tasks = useMemo(() => [...clientTasks, ...saleTasks], [clientTasks, saleTasks]);

  // UI state
  const [coOpen, setCoOpen] = useState(false);
  const [coMoved, setCoMoved] = useState(false);
  const [openPeople, setOpenPeople] = useState<Set<string>>(new Set());
  const [allPeople, setAllPeople] = useState(false);
  const [peopleQ, setPeopleQ] = useState("");
  const [historyAll, setHistoryAll] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logChannel, setLogChannel] = useState("call");
  const [logWho, setLogWho] = useState("");
  const [logWhy, setLogWhy] = useState("");
  const [logDate, setLogDate] = useState(todayISO());
  const [logBusy, setLogBusy] = useState(false);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [projFilter, setProjFilter] = useState<"all" | "open" | "closed">("all");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<"open" | "late" | "done" | "all">("open");
  /** Tasks from the sales (before it was a client) or the client's own (after). */
  const [taskSrc, setTaskSrc] = useState<"all" | "client" | "sale">("all");
  const [taskDraft, setTaskDraft] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [taskPri, setTaskPri] = useState<TaskPriority>("normal");
  /** Where a new task goes: "client" (general) or a sale's id. */
  const [taskDeal, setTaskDeal] = useState("client");
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskErr, setTaskErr] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteFilter, setNoteFilter] = useState<"all" | "client" | "sale">("all");
  const [noteQ, setNoteQ] = useState("");
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const [confirmNote, setConfirmNote] = useState<string | null>(null);
  const [addPerson, setAddPerson] = useState<{ first: string; last: string; position: string; email: string; phone: string; billing: boolean } | null>(null);
  const [addPersonBusy, setAddPersonBusy] = useState(false);
  const [addPersonErr, setAddPersonErr] = useState<string | null>(null);
  useRequiredFields();
  /** "*" on a built-in contact field the team made required (only when the person goes into the CRM). */
  const pReq = (k: string) => (co.id && isFixedRequired("contact", k) ? <em className="cw-req"> *</em> : null);
  const [addLine, setAddLine] = useState(false);
  const [schedEdit, setSchedEdit] = useState<{ id: string; v: PaymentSchedule } | null>(null);
  const [schedErr, setSchedErr] = useState<string | null>(null);

  const pulseRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  /* ---- open / close ---- */
  const closingRef = useRef(false);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(onClose, reduceMotion() ? 0 : 280);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // the project editor (or a picker) is open on top: let it handle Escape
      if (document.querySelector(".pf-backdrop, .ncm-backdrop, .sel-layer, .dp-layer, .tp-layer")) return;
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [requestClose]);

  /* ---- load everything about this client ---- */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const today = todayISO();
        const [svc, prof, cl, nt, lg, ce, cp, cf, ctf, uid] = await Promise.all([
          supabase.from("services").select("id, rate_unit"),
          supabase.from("profiles").select("id, first_name, last_name"),
          supabase.from("clients").select("*").eq("id", client.id).maybeSingle(),
          supabase.from("client_notes").select("*").eq("client_id", client.id).order("created_at", { ascending: false }),
          supabase.from("client_contacts_log").select("*").eq("client_id", client.id).order("contacted_at", { ascending: false }),
          supabase.from("calendar_entries").select("entry_date, user_id, title, notes, kind")
            .eq("client_id", client.id).eq("status", "confirmed").lte("entry_date", today)
            .order("entry_date", { ascending: false }).limit(15),
          supabase.from("client_products").select("*").eq("client_id", client.id),
          listCompanyFields().catch(() => [] as CompanyField[]),
          listContactFields().catch(() => [] as ContactField[]),
          sessionUserId().catch(() => null),
        ]);
        if (!alive) return;
        const u: Record<string, "hour" | "day"> = {};
        (svc.data ?? []).forEach((r: any) => { u[r.id] = r.rate_unit === "hour" ? "hour" : "day"; });
        setUnits(u);
        const pp: Record<string, string> = {};
        (prof.data ?? []).forEach((r: any) => { pp[r.id] = [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown"; });
        setPeople(pp);
        setClientRow(cl.data ?? null);
        setTenantId((cl.data as any)?.tenant_id ?? null);
        setNotes(((nt.data ?? []) as any[]).map((n) => ({ ...n, mentions: n.mentions ?? [], src: "client" as const })));
        supabase.from("client_tasks").select("*").eq("client_id", client.id).order("created_at", { ascending: false })
          .then(({ data, error }) => { if (alive && !error) setClientTasks(((data ?? []) as any[]).map((t) => ({ ...toTask({ ...t, tracking_id: "" }, []), src: "client" as const }))); });
        setContactLog((lg.data ?? []) as ContactLog[]);
        setCoFields(cf);
        setCtFields(ctf);
        setMe(uid);
        setCalendar(((ce.data ?? []) as any[]).map((e) => ({
          at: `${e.entry_date}T12:00:00`,
          kind: e.kind === "meeting" ? "meeting" : "delivery",
          who: pp[e.user_id] ?? "A consultant",
          why: e.title || str(e.notes).slice(0, 80) || (e.kind === "meeting" ? "Client meeting" : "On-site work"),
        })));

        // signed products = the contract lines
        const raw = (cp.data ?? []) as any[];
        const pids = [...new Set(raw.map((r) => r.product_id).filter(Boolean))];
        const pn: Record<string, string> = {};
        if (pids.length) {
          const { data } = await supabase.from("products").select("id,name").in("id", pids);
          (data ?? []).forEach((p: any) => { pn[p.id] = p.name; });
        }
        if (!alive) return;
        setLines(raw
          .map((r) => ({ ...r, name: pn[r.product_id] ?? "Product" }))
          .sort((a, b) => str(b.signing_date).localeCompare(str(a.signing_date))));

        // the CRM company behind the client: details, people, deals → tasks, files, meetings
        const companyId = (cl.data as any)?.company_id ?? null;
        if (!companyId) return;
        const [co, links, trk] = await Promise.all([
          supabase.from("companies").select("*").eq("id", companyId).maybeSingle(),
          supabase.from("company_contacts").select("contact_id").eq("company_id", companyId),
          supabase.from("trackings").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
        ]);
        if (!alive) return;
        setCompany(co.data ?? null);
        const cids = (links.data ?? []).map((l: any) => l.contact_id);
        if (cids.length) {
          const { data } = await supabase.from("contacts").select("*").in("id", cids);
          if (alive) setCrmContacts(data ?? []);
        }
        const trows = (trk.data ?? []) as any[];
        const dl: Deal[] = trows.map((t) => ({
          id: t.id, name: str(t.deal_name) || client.name, status: t.status ?? null, created_at: t.created_at ?? null,
          close_date: t.close_date ?? null, price: t.product_price != null ? Number(t.product_price) : null,
        }));
        setDeals(dl);
        const ids = dl.map((d) => d.id);
        if (!ids.length) return;
        // where each deal stands: its pipeline and phase
        const phaseIds = [...new Set(trows.map((t) => t.current_phase_id).filter(Boolean))];
        const pipeIds = [...new Set(trows.map((t) => t.pipeline_id).filter(Boolean))];
        void Promise.all([
          phaseIds.length ? supabase.from("pipeline_phases").select("id, name").in("id", phaseIds) : Promise.resolve({ data: [] as any[] }),
          pipeIds.length ? supabase.from("pipelines").select("id, name").in("id", pipeIds) : Promise.resolve({ data: [] as any[] }),
        ]).then(([ph, pi]) => {
          if (!alive) return;
          const phN = new Map(((ph.data ?? []) as any[]).map((x) => [x.id, String(x.name)]));
          const piN = new Map(((pi.data ?? []) as any[]).map((x) => [x.id, String(x.name)]));
          const byId = new Map(trows.map((t) => [t.id, t]));
          setDeals((xs) => xs.map((d) => ({ ...d, phase: phN.get(byId.get(d.id)?.current_phase_id) ?? null, pipeline: piN.get(byId.get(d.id)?.pipeline_id) ?? null })));
        });
        // the proposals sales generated (deal_proposals — missing until its SQL is run)
        supabase.from("deal_proposals").select("*").in("tracking_id", ids).order("created_at", { ascending: false })
          .then(({ data, error }) => { if (alive && !error) setProposals(((data ?? []) as any[]).map((p) => ({ ...p, total: p.total != null ? Number(p.total) : null }))); });
        const nowIso = new Date().toISOString();
        const [tf, mt, nx, tt, tn] = await Promise.all([
          supabase.from("tracking_files").select("*").in("tracking_id", ids),
          supabase.from("tracking_meetings").select("title, meet_at").in("tracking_id", ids).not("meet_at", "is", null).lte("meet_at", nowIso).order("meet_at", { ascending: false }).limit(15),
          supabase.from("tracking_meetings").select("title, meet_at").in("tracking_id", ids).gt("meet_at", nowIso).order("meet_at", { ascending: true }).limit(1),
          supabase.from("tracking_tasks").select("*").in("tracking_id", ids).order("created_at", { ascending: false }),
          supabase.from("tracking_notes").select("*").in("tracking_id", ids).order("created_at", { ascending: false }),
        ]);
        if (!alive) return;
        // Sales can keep items out of the handoff (share_client = false, handoff_v2.sql);
        // documents copied into the client folders are flagged the same way.
        const shared = (r: any) => r.share_client !== false;
        setTrackFiles(((tf.data ?? []) as any[]).filter(shared) as TrackFile[]);
        setMeetings(((mt.data ?? []) as any[]).map((m) => ({ at: m.meet_at, title: m.title })));
        const n0 = (nx.data ?? [])[0] as any;
        setNextMeeting(n0 ? { at: n0.meet_at, title: n0.title } : null);
        const dealName = new Map(dl.map((d) => [d.id, d.name]));
        setSaleNotes(((tn.data ?? []) as any[]).filter((n) => str(n.body) && shared(n)).map((n) => ({
          id: n.id, body: n.body, mentions: [], created_at: n.created_at,
          author_id: n.created_by ?? n.author_id ?? n.user_id ?? null, src: "sale" as const, deal: dealName.get(n.tracking_id) ?? null, dealId: n.tracking_id,
        })));
        const taskRows = ((tt.data ?? []) as any[]).filter(shared);
        const byTask: Record<string, string[]> = {};
        if (taskRows.length) {
          const { data: ta } = await supabase.from("tracking_assignees").select("item_id, employee_id")
            .eq("item_type", "task").eq("kind", "employee").in("item_id", taskRows.map((t) => t.id));
          (ta ?? []).forEach((a: any) => { (byTask[a.item_id] ??= []).push(a.employee_id); });
        }
        if (alive) setTasks(taskRows.map((t) => ({ ...toTask(t, byTask[t.id] ?? []), src: "sale" as const })));
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [client.id, client.name]);

  /* ---- derived ---- */
  const unitOf = (p: Project) => (units[p.projectTypeId] === "hour" ? "h" : "d");
  const legacy = useMemo(() => legacyRoleMap(roles), [roles]);
  /** The roles sold on a project (legacy rows read as their real roles). */
  const linesOf = (p: Project) => resolvedLinesOf(p, legacy);
  /** Average day rate over every role, after each role's discount. */
  const avgRate = (p: Project) => {
    const ls = linesOf(p);
    const d = ls.reduce((t, l) => t + l.days, 0);
    return d > 0 ? ls.reduce((t, l) => t + l.days * lineRate(l), 0) / d : ls[0] ? lineRate(ls[0]) : 0;
  };
  /** One tooltip row per role: days and rate, marked when it doesn't count for billing. */
  const roleTipRows = (p: Project, un: string): [string, React.ReactNode][] => linesOf(p).map((l) => [
    `${roleNameOf(l.roleId, roles)}${roleCounts(l.roleId, roles) ? "" : " (doesn't count)"}`,
    `${d2(l.days)}${un} · ${eur(lineRate(l))}${lineRate(l) !== l.rate ? ` (list ${eur(l.rate)})` : ""}`,
  ]);
  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";
  const mentionPeople: MentionPerson[] = useMemo(
    () => Object.entries(people).map(([id, name]) => ({ id: `employee:${id}`, name, kind: "employee" as const })),
    [people]);

  const totals = useMemo(() => projects.reduce((acc, p) => {
    const signed = signedOf(p);
    const u = usage[p.id] ?? { planned: 0, done: 0 };
    acc.signed += signed; acc.done += u.done; acc.booked += u.planned; acc.value += projectValue(p);
    return acc;
  }, { signed: 0, done: 0, booked: 0, value: 0 }), [projects, usage]);
  const donePct = totals.signed > 0 ? Math.min(100, (totals.done / totals.signed) * 100) : 0;

  const info = projects[0];
  const co = company ?? {};
  const cr = clientRow ?? {};
  const addr = { ...(cr.address ?? {}), ...(info?.address ?? {}) } as Record<string, string>;
  const city = str(co.city) || str(addr.city);
  const country = str(co.country) || str(addr.country);
  const website = str(co.website);
  const webHref = website && !/^https?:\/\//i.test(website) ? `https://${website}` : website;
  const webHost = website.replace(/^https?:\/\//i, "").replace(/\/$/, "");

  // every touchpoint we know about, newest first
  const touches = useMemo<Touch[]>(() => {
    const xs: Touch[] = [];
    contactLog.forEach((l) => xs.push({
      at: l.contacted_at, kind: str(l.channel).toLowerCase() || "log",
      who: l.contact_name || (l.logged_by ? people[l.logged_by] : "") || "—", why: l.reason || "Contact logged",
    }));
    meetings.forEach((m) => xs.push({ at: m.at, kind: "meeting", who: "Sales", why: m.title || "Meeting" }));
    calendar.forEach((c) => xs.push(c));
    return xs
      .filter((x) => x.at && !isNaN(toDate(x.at).getTime()) && toDate(x.at).getTime() <= Date.now() + 60_000)
      .sort((a, b) => toDate(b.at).getTime() - toDate(a.at).getTime());
  }, [contactLog, meetings, calendar, people]);
  const last = touches[0] ?? null;
  const lastDays = last ? Math.max(0, daysSince(last.at)) : null;
  const health = lastDays == null ? "none" : lastDays > 60 ? "bad" : lastDays > 30 ? "warn" : "ok";
  const healthLabel = { none: "No contact yet", ok: "Healthy", warn: "Getting quiet", bad: "Neglected" }[health];
  const lastDaysAnim = useCount(lastDays ?? 0, 1100);
  const ringFill = lastDays == null ? 0 : Math.max(0.05, 1 - lastDaysAnim / 90);

  // people: CRM contacts of the company + anyone only on the project sheet
  const persons = useMemo<Person[]>(() => {
    const out: Person[] = [];
    const seen = new Set<string>();
    crmContacts.forEach((c) => {
      const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Unnamed";
      out.push({ key: `crm:${c.id}`, id: c.id, name, position: str(c.position), email: str(c.email), phone: str(c.phone), billing: !!c.is_billing, crm: true, c });
      if (c.email) seen.add(norm(c.email));
      seen.add(norm(name));
    });
    const sheet = [...(Array.isArray(cr.contacts) ? cr.contacts : []), ...projects.flatMap((p) => (Array.isArray(p.contacts) ? p.contacts : []))];
    sheet.forEach((c: any, i: number) => {
      const name = str(c?.name) || "Unnamed";
      const em = str(c?.email);
      if ((em && seen.has(norm(em))) || seen.has(norm(name))) return;
      if (em) seen.add(norm(em));
      seen.add(norm(name));
      out.push({ key: `pj:${i}:${name}`, id: null, name, position: str(c?.position), email: em, phone: str(c?.phone), billing: !!c?.billing, crm: false, c: null });
    });
    return out.sort((a, b) => Number(b.billing) - Number(a.billing) || a.name.localeCompare(b.name));
  }, [crmContacts, cr.contacts, projects]);
  const lastByPerson = useMemo(() => {
    const m = new Map<string, string>();
    touches.forEach((t) => { if (!m.has(norm(t.who))) m.set(norm(t.who), t.at); });
    return m;
  }, [touches]);
  const PEOPLE_LIMIT = 6;
  const peopleFiltered = persons.filter((p) => !peopleQ || norm(`${p.name} ${p.email} ${p.position}`).includes(norm(peopleQ)));
  const peopleShown = allPeople || peopleQ ? peopleFiltered : peopleFiltered.slice(0, PEOPLE_LIMIT);

  // contract
  const activeLines = lines.filter(isActive);
  const recurringYear = activeLines.reduce((s, l) => s + lineAnnual(l), 0);
  const oneTime = lines.reduce((s, l) => s + (l.recurring ? 0 : lineTotal(l)) + (Number(l.one_time_fee) || 0), 0);
  /** What the sale signed: recurring lines for their whole term (1 year when none), one-offs and set-up fees. */
  const lineContract = lineContractValue;
  const contractValue = activeLines.reduce((s, l) => s + lineContract(l), 0);
  const openProjects = projects.filter((p) => p.status !== "closed");
  const openValue = openProjects.reduce((s, p) => s + projectValue(p), 0);
  const nextRenewal = activeLines.map(termOf).filter((t): t is NonNullable<ReturnType<typeof termOf>> => !!t && t.left >= 0)
    .sort((a, b) => a.end.getTime() - b.end.getTime())[0] ?? null;

  // tasks
  const openTasks = tasks.filter((t) => !t.done);
  const lateTasks = openTasks.filter((t) => (dueInfo(t.due_at)?.n ?? 1) < 0);
  const shownTasks = useMemo(() => {
    const xs = taskFilter === "open" ? tasks.filter((t) => !t.done)
      : taskFilter === "late" ? tasks.filter((t) => !t.done && (dueInfo(t.due_at)?.n ?? 1) < 0)
        : taskFilter === "done" ? tasks.filter((t) => t.done) : tasks;
    const pr = (p?: string) => PRI.indexOf((p ?? "normal") as TaskPriority);
    return [...xs].sort((a, b) => Number(a.done) - Number(b.done)
      || (a.due_at ? toDate(a.due_at).getTime() : Infinity) - (b.due_at ? toDate(b.due_at).getTime() : Infinity)
      || pr(a.priority) - pr(b.priority));
  }, [tasks, taskFilter]);

  // notes
  const allNotes = useMemo(() => [...notes, ...saleNotes].sort((a, b) => b.created_at.localeCompare(a.created_at)), [notes, saleNotes]);
  const shownNotes = allNotes.filter((n) => (noteFilter === "all" || n.src === noteFilter) && (!noteQ || norm(plain(n.body)).includes(norm(noteQ))));
  // One block for the client's own notes, then one per sale.
  const noteGroups = useMemo(() => {
    const g: { key: string; label: string; sub: string; items: Note[] }[] = [];
    const own = shownNotes.filter((n) => n.src === "client");
    if (own.length) g.push({ key: "client", label: "Client", sub: "Since it became a client", items: own });
    const order = deals.map((d) => d.id);
    const bySale = new Map<string, Note[]>();
    shownNotes.filter((n) => n.src === "sale").forEach((n) => { const k = n.dealId ?? ""; bySale.set(k, [...(bySale.get(k) ?? []), n]); });
    Array.from(bySale.entries())
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .forEach(([k, items]) => {
        const d = deals.find((x) => x.id === k);
        g.push({ key: k || "sale", label: d?.name ?? items[0]?.deal ?? "Sale", sub: saleSub(d?.status), items });
      });
    return g;
  }, [shownNotes, deals]);

  /* ---- deals: their proposals and documents ---- */
  const isProposalFile = useCallback((f: TrackFile) => /^proposal\s*·/i.test(f.note ?? "") || proposals.some((p) => p.file_id === f.id), [proposals]);
  const inFolders = (f: TrackFile) => {
    const n = f.name.toLowerCase();
    return f.size_bytes != null ? dirKeys.sized.has(`${n}|${f.size_bytes}`) || (!dirKeys.sized.size && dirKeys.names.has(n)) : dirKeys.names.has(n);
  };
  const dealView = useMemo(() => deals.map((d) => {
    const files = trackFiles.filter((f) => f.tracking_id === d.id);
    const props = proposals.filter((p) => p.tracking_id === d.id)
      .sort((a, b) => Number(b.is_main) - Number(a.is_main) || b.created_at.localeCompare(a.created_at));
    const linked = new Set(props.map((p) => p.file_id).filter(Boolean));
    // proposal files with no proposal row (made before the table existed) still count as proposals
    const looseProps = files.filter((f) => !linked.has(f.id) && /^proposal\s*·/i.test(f.note ?? ""));
    const docs = files.filter((f) => !isProposalFile(f));
    const main = props.find((p) => p.is_main) ?? null;
    return {
      d, props, looseProps, docs, main,
      value: main?.total ?? (d.price || null),
      tasksOpen: saleTasks.filter((t) => t.tracking_id === d.id && !t.done).length,
      notesN: saleNotes.filter((n) => n.dealId === d.id).length,
    };
  }), [deals, trackFiles, proposals, saleTasks, saleNotes, isProposalFile]);
  const fileById = useMemo(() => new Map(trackFiles.map((f) => [f.id, f])), [trackFiles]);
  const proposalFiles = useMemo(() => dealView.flatMap((v) => [...v.props.map((p) => (p.file_id ? fileById.get(p.file_id) : undefined)), ...v.looseProps])
    .filter((f): f is TrackFile => !!f), [dealView, fileById]);
  const proposalsMissing = proposalFiles.filter((f) => !inFolders(f));
  const wonDeals = deals.filter((d) => /won|handed|closed_won|client/i.test(String(d.status ?? ""))).length;

  /* ---- side menu: the four sections, each with what is inside it ---- */
  const TABS: { v: Tab; label: string; icon: string; hint: string; n?: number; alert?: boolean }[] = [
    { v: "overview", label: "Overview", icon: "overview", hint: "People, tasks & notes", alert: lateTasks.length > 0 },
    { v: "deals", label: "Deals", icon: "deal", hint: "Sales & proposals", n: deals.length || undefined },
    { v: "projects", label: "Projects", icon: "briefcase", hint: "Services delivered", n: projects.length || undefined },
    { v: "contract", label: "Contracts", icon: "contract", hint: "What they signed", n: lines.length || undefined },
    { v: "upsells", label: "Upsells", icon: "spark", hint: "What else they could buy" },
    { v: "folders", label: "Folders", icon: "folder", hint: "Every file of this client" },
  ];
  const SUBS: Record<Tab, { k: string; label: string; n?: number }[]> = {
    overview: [
      { k: "glance", label: "At a glance" }, { k: "company", label: "Company" }, { k: "people", label: "Contacts", n: persons.length || undefined },
      { k: "pulse", label: "Last contacted" }, { k: "tasks", label: "Tasks", n: openTasks.length || undefined }, { k: "notes", label: "Notes", n: allNotes.length || undefined },
    ],
    deals: deals.length > 1 ? deals.map((d) => ({ k: `deal-${d.id}`, label: d.name })) : [],
    projects: [],
    contract: [
      { k: "summary", label: "Summary" },
      { k: "products", label: "Signed products", n: lines.length || undefined }, { k: "services", label: "Service engagements", n: projects.length || undefined },
    ],
    upsells: [],
    folders: [],
  };
  const subs = SUBS[tab];
  const [spy, setSpy] = useState("");
  const sideRef = useRef<HTMLElement>(null);
  const [ink, setInk] = useState<{ y: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const nav = sideRef.current;
    if (!nav) return;
    const place = () => {
      const b = nav.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
      if (b) setInk({ y: b.offsetTop, h: b.offsetHeight });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [tab]);
  /** Which section of the page is at the top of the scroll. */
  const spyNow = () => {
    const body = bodyRef.current;
    if (!body || subs.length < 2) return;
    const line = body.getBoundingClientRect().top + 110;
    const present = subs.filter((x) => body.querySelector(`[data-sec="${x.k}"]`));
    if (!present.length) return;
    let cur = present[0].k, best = -Infinity;
    present.forEach((x) => {
      const y = body.querySelector<HTMLElement>(`[data-sec="${x.k}"]`)!.getBoundingClientRect().top;
      if (y <= line && y > best) { best = y; cur = x.k; }
    });
    if (body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 4) cur = present[present.length - 1].k;
    setSpy(cur);
  };
  const jump = (k: string) => {
    const body = bodyRef.current;
    const el = body?.querySelector<HTMLElement>(`[data-sec="${k}"]`);
    if (!body || !el) return;
    body.scrollTo({ top: el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 14, behavior: reduceMotion() ? "auto" : "smooth" });
    setSpy(k);
  };
  /** Go to a section of a page (switching page first when needed). */
  const goSec = (t: Tab, k: string) => {
    hideTip();
    if (tab === t) { jump(k); return; }
    setTab(t); setSpy(k);
    window.setTimeout(() => jump(k), 80);
  };
  const go = (t: Tab) => { setTab(t); setSpy(SUBS[t][0]?.k ?? ""); bodyRef.current?.scrollTo({ top: 0, behavior: "auto" }); };

  const openDeal = (id: string) => navigate(`/sales?tracking=${id}`);
  const openSalesFile = async (f: TrackFile) => {
    const { data, error } = await supabase.storage.from("tracking-files").createSignedUrl(f.storage_path, 60);
    if (error || !data) { setCopyMsg({ ok: false, text: error?.message ?? "Could not open the file." }); return; }
    window.open(data.signedUrl, "_blank");
  };
  /** Copies sales files into the client's folders: proposals to "Proposals", the rest to "Sales documents". */
  const copyToFolders = async (fs: TrackFile[], busyKey: string) => {
    if (!fs.length) return;
    setCopyBusy(busyKey); setCopyMsg(null);
    const res = await copyIntoClientFolders(client.id, fs.map((f) => ({
      key: f.id, fromBucket: "tracking-files", fromPath: f.storage_path, name: f.name, mime: f.mime, size: f.size_bytes ?? null, note: f.note,
      folder: isProposalFile(f) ? "Proposals" : "Sales documents",
    })));
    setCopyBusy(null);
    const n = Object.keys(res.done).length;
    setCopyMsg(res.errors.length ? { ok: false, text: res.errors.join(" · ") } : { ok: true, text: `${n} file${n === 1 ? "" : "s"} copied to the client's folders` });
    setDirRev((v) => v + 1);
  };
  useEffect(() => {
    let alive = true;
    supabase.from("client_files").select("name, size_bytes").eq("client_id", client.id).then(({ data }) => {
      if (!alive) return;
      const sized = new Set<string>(), names = new Set<string>();
      ((data ?? []) as any[]).forEach((f) => { const n = String(f.name).toLowerCase(); names.add(n); if (f.size_bytes != null) sized.add(`${n}|${f.size_bytes}`); });
      setDirKeys({ sized, names });
    });
    return () => { alive = false; };
  }, [client.id, dirRev]);
  useEffect(() => { if (!copyMsg?.ok) return; const t = window.setTimeout(() => setCopyMsg(null), 4000); return () => window.clearTimeout(t); }, [copyMsg]);

  /* ---- actions ---- */
  const openCompany = () => co.id && navigate("/companies", { state: { focusCompanyId: co.id } });
  const openContact = (id: string) => navigate("/contacts", { state: { focusContactId: id } });
  const savePerson = async () => {
    if (!addPerson || !addPerson.first.trim()) return;
    const d = addPerson;
    if (co.id) {
      // the built-in fields this form shows that Settings › Contacts page makes required
      const gap = missingFixed("contact", { last_name: d.last, position: d.position, email: d.email, phone: d.phone }, ["last_name", "position", "email", "phone"]);
      if (gap.length) { setAddPersonErr(`Required — please fill in: ${gap.join(", ")}.`); return; }
    }
    setAddPersonBusy(true); setAddPersonErr(null);
    if (co.id) {
      const c: any = {
        first_name: d.first.trim(), last_name: d.last.trim() || null, position: d.position.trim() || null,
        email: d.email.trim() || null, phone: d.phone.trim() || null, is_billing: d.billing, custom: {}, companyIds: [co.id],
      };
      const e = await saveContact(c);
      setAddPersonBusy(false);
      if (e) { setAddPersonErr(e); return; }
      setCrmContacts((xs) => [...xs, { ...c, id: c.id }]);
    } else {
      const next = [...(Array.isArray(cr.contacts) ? cr.contacts : []), {
        name: [d.first.trim(), d.last.trim()].filter(Boolean).join(" "), position: d.position.trim(), email: d.email.trim(), phone: d.phone.trim(), billing: d.billing,
      }];
      const { error } = await supabase.from("clients").update({ contacts: next }).eq("id", client.id);
      setAddPersonBusy(false);
      if (error) { setAddPersonErr(error.message); return; }
      setClientRow((x: any) => ({ ...(x ?? {}), contacts: next }));
    }
    setAddPerson(null);
  };
  const reloadLines = async () => {
    const { data } = await supabase.from("client_products").select("*").eq("client_id", client.id);
    const raw = (data ?? []) as any[];
    const pids = [...new Set(raw.map((r) => r.product_id).filter(Boolean))];
    const pn: Record<string, string> = {};
    if (pids.length) ((await supabase.from("products").select("id,name").in("id", pids)).data ?? []).forEach((x: any) => { pn[x.id] = x.name; });
    setLines(raw.map((r) => ({ ...r, name: pn[r.product_id] ?? "Product" })).sort((a, b) => str(b.signing_date).localeCompare(str(a.signing_date))));
  };
  const togglePerson = (k: string) => setOpenPeople((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const startLog = (who = "") => {
    setLogWho(who); setLogErr(null); setLogDate(todayISO()); setLogOpen(true);
    if (tab !== "overview") setTab("overview");
    window.setTimeout(() => pulseRef.current?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" }), 60);
  };

  const saveLog = async () => {
    setLogBusy(true); setLogErr(null);
    const at = logDate === todayISO() ? new Date().toISOString() : `${logDate}T12:00:00`;
    const row: Record<string, unknown> = {
      client_id: client.id, contacted_at: at, channel: logChannel,
      contact_name: logWho.trim() || null, reason: logWhy.trim() || null, logged_by: me,
    };
    let res = await supabase.from("client_contacts_log").insert(tenantId ? { ...row, tenant_id: tenantId } : row).select().single();
    if (res.error && tenantId && /tenant_id/i.test(res.error.message)) res = await supabase.from("client_contacts_log").insert(row).select().single();
    setLogBusy(false);
    if (res.error) { setLogErr(res.error.message); return; }
    setContactLog((xs) => [res.data as ContactLog, ...xs]);
    setLogOpen(false); setLogWhy(""); setLogWho("");
  };

  const addNote = async () => {
    const body = noteDraft.trim();
    if (!body) return;
    setNoteErr(null);
    const mentions = Array.from(body.matchAll(/@\[[^\]]+\]\(employee:([0-9a-f-]+)\)/g)).map((m) => m[1]);
    const authorId = me;
    if (authorId && !people[authorId]) {
      const { data: prof } = await supabase.from("profiles").select("first_name, last_name, email").eq("id", authorId).maybeSingle();
      const nm = prof ? ([(prof as any).first_name, (prof as any).last_name].filter(Boolean).join(" ") || (prof as any).email) : null;
      if (nm) setPeople((pp) => ({ ...pp, [authorId]: nm }));
    }
    const { data, error } = await supabase.from("client_notes").insert({ client_id: client.id, body, mentions, author_id: authorId }).select().single();
    if (error || !data) { setNoteErr(error?.message ?? "Could not save the note."); return; }
    setNotes((xs) => [{ ...(data as any), mentions: (data as any).mentions ?? [], src: "client" }, ...xs]);
    setNoteDraft("");
  };
  const deleteNote = async (id: string) => {
    const { error } = await supabase.from("client_notes").delete().eq("id", id);
    setConfirmNote(null);
    if (error) { setNoteErr(error.message); return; }
    setNotes((xs) => xs.filter((n) => n.id !== id));
  };

  const createTask = async () => {
    const title = taskDraft.trim();
    if (!title || !taskDeal) return;
    setTaskBusy(true); setTaskErr(null);
    if (taskDeal === "client") {
      const { data, error } = await supabase.from("client_tasks").insert({
        client_id: client.id, title, due_at: taskDue ? `${taskDue}T18:00:00` : null, priority: taskPri, status: "todo", done: false, created_by: me,
      }).select().single();
      setTaskBusy(false);
      if (error || !data) { setTaskErr(/client_tasks/i.test(error?.message ?? "") ? "Run handoff_v2.sql in Supabase to enable client tasks." : (error?.message ?? "Could not create the task.")); return; }
      setClientTasks((xs) => [{ ...toTask({ ...(data as any), tracking_id: "" }, []), src: "client" }, ...xs]);
    } else {
      const t = await addTask(taskDeal, null, title, taskDue ? `${taskDue}T18:00:00` : null, { priority: taskPri });
      setTaskBusy(false);
      if (!t) { setTaskErr("Could not create the task."); return; }
      setTasks((xs) => [{ ...toTask({ ...t, tracking_id: taskDeal }, []), src: "sale" }, ...xs]);
    }
    setTaskDraft(""); setTaskDue(""); setTaskPri("normal");
    if (taskFilter === "done") setTaskFilter("open");
  };
  const flipTask = async (t: Task) => {
    const done = !t.done;
    const patch = (xs: Task[]) => xs.map((x) => (x.id === t.id ? { ...x, done, status: done ? "done" as const : "todo" as const, progress: done ? 100 : x.progress } : x));
    if (t.src === "client") {
      setClientTasks(patch);
      await supabase.from("client_tasks").update({ done, status: done ? "done" : "todo" }).eq("id", t.id);
      return;
    }
    setTasks(patch);
    await toggleTask(t.id, done);
    void updateTaskMeta(t.id, { status: done ? "done" : "todo" });
  };

  const dealName = (id: string) => (id ? deals.find((d) => d.id === id)?.name ?? "Deal" : "Client");
  /**
   * Tasks and notes are kept apart by where they come from: the client's own
   * (made once it is a client) first, then one block per sale.
   */
  const sources = useMemo(() => [
    { key: "client", title: "Client", sub: "Since it became a client" },
    ...deals.map((d) => ({ key: d.id, title: d.name, sub: saleSub(d.status) })),
  ], [deals]);
  const firstSigned = projects.map((p) => p.signingDate).filter(Boolean).sort()[0] ?? "";
  const firstKick = projects.map((p) => p.kickoffDate).filter(Boolean).sort()[0] ?? "";

  /* ---- company facts ---- */
  const identity = [
    { k: "Trade name", v: str(co.name) || client.name },
    { k: "Legal name", v: str(co.legal_name) || str(cr.legal_name) || str(info?.legalName) },
    { k: "VAT", v: str(co.vat_number) || str(cr.vat_number) || str(info?.vatNumber) },
    { k: "Registry no.", v: str(co.reg_number) },
  ];
  const reach = [
    { k: "Website", v: website ? <a href={webHref} target="_blank" rel="noreferrer">{webHost}</a> : "" },
    { k: "Email", v: str(co.email) ? <a href={`mailto:${co.email}`}>{co.email}</a> : "" },
    { k: "Phone", v: str(co.phone) ? <a href={`tel:${co.phone}`}>{co.phone}</a> : "" },
  ];
  const street = [str(co.street) || str(addr.street), str(co.addr_number) || str(addr.number)].filter(Boolean).join(" ");
  const place = [
    { k: "Street", v: street },
    { k: "Details", v: str(co.addr_details) || str(addr.details) },
    { k: "Postal code", v: str(co.postal_code) || str(addr.postalCode) },
    { k: "City", v: city },
    { k: "Province", v: str(co.province) },
    { k: "Country", v: country ? countryLabel(country) : "" },
  ];
  const engagement = [
    { k: "Client since", v: firstSigned ? fmt(firstSigned) : "" },
    { k: "First kick-off", v: firstKick ? fmt(firstKick) : "" },
    { k: "Projects", v: `${projects.length} · ${projects.filter((p) => p.status !== "closed").length} open` },
    { k: "Sales deals", v: deals.length ? String(deals.length) : "" },
  ];
  const custom = coFields.map((f) => ({ k: f.label, v: customValue(co.custom?.[f.id], f.type) }));
  const filled = [...identity, ...reach, ...place, ...engagement, ...custom].filter((x) => x.v).length;
  const totalFacts = identity.length + reach.length + place.length + engagement.length + custom.length;

  const filteredProjects = projects.filter((p) => projFilter === "all" || (projFilter === "closed" ? p.status === "closed" : p.status !== "closed"));

  /* ---- hover cards ---- */
  const [tip, setTip] = useState<TipState | null>(null);
  const tipTimer = useRef(0);
  const tipOn: TipOn = useCallback((node: React.ReactNode) => (node == null ? {} : {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget;
      window.clearTimeout(tipTimer.current);
      tipTimer.current = window.setTimeout(() => setTip({ r: el.getBoundingClientRect(), node, id: Date.now() }), 260);
    },
    onMouseLeave: () => { window.clearTimeout(tipTimer.current); setTip(null); },
  }), []);
  const hideTip = () => { window.clearTimeout(tipTimer.current); setTip(null); };
  useEffect(() => () => window.clearTimeout(tipTimer.current), []);

  const projRows = (f: (p: Project) => React.ReactNode): [string, React.ReactNode][] => projects.map((p) => [typeName(p.projectTypeId), f(p)]);
  const missing = [...identity, ...reach, ...place, ...custom].filter((x) => !x.v).map((x) => x.k);
  const placeLine = [city, country && countryLabel(country)].filter(Boolean).join(", ");
  const fullAddress = [street, [str(co.postal_code) || str(addr.postalCode), city].filter(Boolean).join(" "), str(co.province) !== city ? str(co.province) : "", country ? countryLabel(country) : ""].filter(Boolean).join(", ");
  const legal = str(identity[1].v) || str(identity[0].v);
  const vat = str(identity[2].v);

  /* ---- the company card: full width when opened, in the main column when closed ---- */
  const companyCard = (
    <section data-sec="company" className={`cw-card cw-co ${coOpen ? "is-open" : ""} ${coMoved ? "is-moved" : ""}`} style={cssVars({ "--i": 4 })}>
      <SecHead icon="building" tone="green" title="Company" sub={`${filled} of ${totalFacts} details filled`}>
        {co.id && <button className="cw-icon-btn" onClick={openCompany} aria-label="Open in Companies" {...tipOn(<TipCard title="Open in Companies" />)}><Ico n="out" s={15} /></button>}
        <button className="cw-ghost" onClick={() => { hideTip(); setCoMoved(true); setCoOpen((o) => !o); }} aria-expanded={coOpen}>
          <Ico n={coOpen ? "shrink" : "expand"} s={14} />{coOpen ? "Less" : "See everything"}
        </button>
      </SecHead>
      <div className="cw-sec-body">
      <div className="cw-co-hero" {...(coOpen ? {} : tipOn(
        <TipCard title={legal} sub={str(co.name) && str(co.name) !== legal ? `Trades as ${co.name}` : undefined}
          rows={[["VAT", vat], ["Registry", str(co.reg_number)], ["Website", webHost], ["Email", str(co.email)], ["Phone", str(co.phone)],
            ["Address", [street, str(co.postal_code) || str(addr.postalCode), placeLine].filter(Boolean).join(", ")]]} />,
      ))}>
        <b>{legal}</b>
        <span>{[vat && `VAT ${vat}`, placeLine, webHost].filter(Boolean).join("  ·  ") || "No details yet"}</span>
      </div>
      <div className="cw-co-meter" {...tipOn(<TipCard title={`${filled} of ${totalFacts} details filled`} sub={missing.length ? `Missing: ${missing.join(", ")}` : "Everything is filled in"} />)}>
        <span style={{ width: `${(filled / Math.max(1, totalFacts)) * 100}%` }} />
      </div>
      {co.id && <WebLinks companyId={co.id} website={str(co.website)} linkedin={str(co.linkedin)}
        onSaved={(patch) => setCompany((c: any) => (c ? { ...c, ...patch } : c))} />}
      <div className="cw-reveal" aria-hidden={!coOpen}>
        <div className="cw-reveal-in">
          <div className="cw-co2">
            {(website || str(co.email) || str(co.phone) || fullAddress) && (
              <div className="cw-acts">
                {str(co.phone) && <Act icon="phone" href={telHref(str(co.phone))}>{co.phone}</Act>}
                {str(co.email) && <Act icon="mail" href={`mailto:${co.email}`}>{co.email}</Act>}
                {website && <Act icon="globe" href={webHref} ext>{webHost}</Act>}
                {fullAddress && <Act icon="pin" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`} ext>{fullAddress}</Act>}
              </div>
            )}
            <div className="cw-co2-grid">
              {[
                { t: "Identity", icon: "building", rows: identity },
                { t: "Engagement", icon: "briefcase", rows: engagement },
                ...(custom.some((x) => x.v) ? [{ t: "More details", icon: "spark", rows: custom }] : []),
              ].map((g, gi) => (
                <section className="cw-co2-g" key={g.t} style={cssVars({ "--i": gi })}>
                  <h4><Ico n={g.icon} s={13} />{g.t}</h4>
                  <FactRows rows={g.rows} />
                </section>
              ))}
            </div>
            {str(co.notes) && (
              <section className="cw-co2-about" style={cssVars({ "--i": 3 })}>
                <h4><Ico n="note" s={13} />About</h4>
                <p>{co.notes}</p>
              </section>
            )}
            {missing.length > 0 && (
              <p className="cw-co2-miss">
                <span>Missing: {missing.join(", ")}</span>
                {co.id && <button className="cw-linkbtn" onClick={openCompany}>Fill in Companies<Ico n="arrow" s={13} /></button>}
              </p>
            )}
          </div>
        </div>
      </div>
      </div>
    </section>
  );

  /* ============================== render ============================== */
  return (
    <div className={`cw-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={requestClose}>
      <div className="cw" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={client.name}>
        {/* ---------- header ---------- */}
        <header className="cw-head">
          <div className="cw-head-row">
            <div className="cw-id">
              <CompanyLogo className="cw-av" name={client.name} website={str(company?.website) || null} />
              <div className="cw-id-t">
                <h2 className="cw-name">{client.name}</h2>
                <div className="cw-tags">
                  <span className={`cw-tag is-health is-${health}`} style={cssVars({ "--i": 0 })}
                    {...tipOn(<TipCard title={healthLabel} sub={last ? `Last contact ${ago(last.at)} · ${last.kind} with ${last.who}` : "No contact on record yet"}>
                      Healthy up to 30 days without contact, getting quiet up to 60, neglected after that.
                    </TipCard>)}><i />{healthLabel}</span>
                  {placeLine && <span className="cw-tag" style={cssVars({ "--i": 1 })}><Ico n="pin" s={12} />{placeLine}</span>}
                  {co.id && <button className="cw-tag is-link" style={cssVars({ "--i": 2 })} onClick={openCompany}
                    {...tipOn(<TipCard title="Open in Companies" sub={[webHost, str(co.phone)].filter(Boolean).join(" · ") || undefined} />)}><Ico n="building" s={12} />Company</button>}
                </div>
              </div>
            </div>
            <div className="cw-kpis">
              <div className="cw-kpi" style={cssVars({ "--i": 0 })} {...tipOn(<TipCard title="Signed with this client" rows={[["Projects", eur(totals.value)], ["Products", eur(contractValue)]]} />)}>
                <span className="cw-kpi-k">Signed</span>
                <span className="cw-kpi-v is-neon">{eur(totals.value + contractValue)}</span>
              </div>
              <div className="cw-kpi" style={cssVars({ "--i": 1 })}>
                <span className="cw-kpi-k">Recurring</span>
                <span className="cw-kpi-v">{eur(recurringYear)}<em>/yr</em></span>
              </div>
              <button className="cw-kpi is-btn" style={cssVars({ "--i": 2 })} onClick={() => go("deals")}>
                <span className="cw-kpi-k">Deals</span>
                <span className="cw-kpi-v">{deals.length}{wonDeals ? <em>{wonDeals} won</em> : null}</span>
              </button>
            </div>
            <button className="cw-x" onClick={requestClose} aria-label="Close"><Ico n="x" s={18} /></button>
          </div>
        </header>

        <div className={`cw-layout t-${tab}`}>
          {/* ---------- side menu ---------- */}
          <aside className="cw-side">
            <span className="cw-side-k">Client</span>
            <nav className="cw-side-nav" ref={sideRef} role="tablist" aria-orientation="vertical">
              {ink && <span className="cw-side-ink" style={{ transform: `translateY(${ink.y}px)`, height: ink.h }} aria-hidden="true" />}
              {TABS.map((t, i) => (
                <div className={`cw-side-grp ${tab === t.v ? "is-on" : ""}`} key={t.v}>
                  <button data-tab={t.v} role="tab" title={t.label} aria-selected={tab === t.v} className={`cw-side-item ${tab === t.v ? "is-on" : ""}`}
                    style={cssVars({ "--i": i })} onClick={() => { hideTip(); go(t.v); }}>
                    <i className="cw-side-ico"><Ico n={t.icon} s={15} /></i>
                    <span className="cw-side-t"><b>{t.label}</b><small>{t.hint}</small></span>
                    {t.alert ? <em className="is-alert" aria-label="Overdue tasks" /> : t.n != null ? <em>{t.n}</em> : null}
                  </button>
                  {tab === t.v && SUBS[t.v].length > 1 && (
                    <div className="cw-side-subs">
                      {SUBS[t.v].map((x, j) => (
                        <button key={x.k} className={(spy || SUBS[t.v][0].k) === x.k ? "is-on" : ""} style={cssVars({ "--i": j })} onClick={() => goSec(t.v, x.k)}>
                          <i /><span>{x.label}</span>{x.n != null && <em>{x.n}</em>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </nav>
            <div className="cw-side-foot">
              <button className={`cw-side-health is-${health}`} onClick={() => goSec("overview", "pulse")}>
                <i />
                <span><b>{healthLabel}</b><small>{last ? `Last contact ${ago(last.at)}` : "No contact on record"}</small></span>
              </button>
              {nextMeeting && (
                <p className="cw-side-next"><Ico n="cal" s={13} /><span>{nextMeeting.title || "Meeting"}<small>{fmt(nextMeeting.at)}</small></span></p>
              )}
            </div>
          </aside>

        {/* ---------- body ---------- */}
        <div className={`cw-body ${tab === "folders" ? "is-fixed" : ""}`} ref={bodyRef} onScroll={() => { hideTip(); spyNow(); }}>
          <div className={`cw-panel is-${tab} ${!loaded && (tab === "overview" || tab === "deals") ? "is-loading" : ""}`} key={tab}>
            {tab !== "folders" && (() => {
              const t = TABS.find((x) => x.v === tab);
              return t ? (
                <header className="cw-tabhead">
                  <span className="cw-tabhead-ico"><Ico n={t.icon} s={18} /></span>
                  <div className="cw-tabhead-t"><h2>{t.label}</h2><small>{t.hint}</small></div>
                </header>
              ) : null;
            })()}
            {!loaded && (tab === "overview" || tab === "deals") && (
              <div className="cw-skel" aria-hidden="true">
                <span className="cw-skel-strip" />
                {[0, 1, 2].map((k) => (
                  <span className="cw-skel-sec" key={k}><i /><i /><i /><i /></span>
                ))}
              </div>
            )}
            {/* ===== OVERVIEW ===== */}
            {tab === "overview" && (
              <div className="cw-ov">
                <div className="cw-snap" data-sec="glance">
                  <button className="cw-tile" data-tone="green" style={cssVars({ "--i": 0 })} onClick={() => go("projects")}
                    {...tipOn(<TipCard title="Projects" rows={projRows((p) => `${p.status || "open"} · ${eur(projectValue(p))}`)} />)}>
                    <span className="cw-tile-top"><span className="cw-tile-ico"><Ico n="briefcase" s={15} /></span><span className="cw-tile-k">Projects</span></span>
                    <b className="cw-tile-v"><Num v={openValue} /><small> €</small></b>
                    <span className="cw-tile-sub">{openProjects.length} open of {projects.length}{projects.length > openProjects.length ? ` · ${eur(totals.value)} in all` : ""}</span>
                    <span className="cw-tile-bar"><span style={{ width: `${donePct}%` }} /></span>
                  </button>
                  <button className="cw-tile" data-tone="violet" style={cssVars({ "--i": 1 })} onClick={() => go("contract")}
                    {...tipOn(<TipCard title="Contract" rows={[
                      ["Recurring / year", recurringYear ? eur(recurringYear) : ""], ["One-time", oneTime ? eur(oneTime) : ""], ["Projects", eur(totals.value)],
                      ["Active products", activeLines.length ? String(activeLines.length) : ""],
                      ["Next renewal", nextRenewal ? `${fmtD(nextRenewal.end)} · in ${nextRenewal.left}d` : ""],
                    ]} />)}>
                    <span className="cw-tile-top"><span className="cw-tile-ico"><Ico n="repeat" s={15} /></span><span className="cw-tile-k">Recurring</span></span>
                    <b className="cw-tile-v"><Num v={recurringYear} /><small> € / year</small></b>
                    <span className="cw-tile-sub">{activeLines.filter((l) => l.recurring).length ? `${activeLines.filter((l) => l.recurring).length} subscription${activeLines.filter((l) => l.recurring).length === 1 ? "" : "s"}` : "No subscriptions"}</span>
                  </button>
                  <button className="cw-tile" data-tone="pink" style={cssVars({ "--i": 2 })} onClick={() => go("contract")}
                    {...tipOn(<TipCard title="Sales contract" sub="Signed products over their term, plus one-offs and set-up fees"
                      rows={activeLines.map((l) => [l.name, eur(lineContract(l))] as [string, React.ReactNode])} />)}>
                    <span className="cw-tile-top"><span className="cw-tile-ico"><Ico n="contract" s={15} /></span><span className="cw-tile-k">Sales contract</span></span>
                    <b className="cw-tile-v"><Num v={contractValue} /><small> €</small></b>
                    <span className="cw-tile-sub">{activeLines.length ? `${activeLines.length} signed product${activeLines.length === 1 ? "" : "s"}${nextRenewal ? ` · renews ${fmtD(nextRenewal.end)}` : ""}` : "Nothing signed yet"}</span>
                  </button>
                  <button className={`cw-tile ${lateTasks.length ? "is-alert" : ""}`} data-tone="amber" style={cssVars({ "--i": 3 })} onClick={() => jump("tasks")}
                    {...tipOn(openTasks.length
                      ? <TipCard title={`${openTasks.length} open task${openTasks.length === 1 ? "" : "s"}`} rows={openTasks.slice(0, 5).map((t) => [plain(t.title).slice(0, 38), dueInfo(t.due_at)?.label ?? "No date"] as [string, React.ReactNode])} />
                      : <TipCard title="No open tasks" />)}>
                    <span className="cw-tile-top"><span className="cw-tile-ico"><Ico n="tasks" s={15} /></span><span className="cw-tile-k">Tasks</span></span>
                    <b className="cw-tile-v"><Num v={openTasks.length} /><small> open{lateTasks.length ? <em> · {lateTasks.length} late</em> : null}</small></b>
                  </button>
                  <button className="cw-tile" data-tone="blue" style={cssVars({ "--i": 4 })} onClick={() => jump("notes")}
                    {...tipOn(allNotes[0] ? <TipCard title={people[allNotes[0].author_id ?? ""] ?? "Note"} sub={`${fmt(allNotes[0].created_at)} · ${ago(allNotes[0].created_at)}`}>{plain(allNotes[0].body)}</TipCard> : null)}>
                    <span className="cw-tile-top"><span className="cw-tile-ico"><Ico n="note" s={15} /></span><span className="cw-tile-k">Latest note</span></span>
                    <span className="cw-tile-note">{allNotes[0] ? plain(allNotes[0].body) : "No notes yet"}</span>
                  </button>
                </div>

                {companyCard}
                    <section data-sec="people" className="cw-card cw-people" style={cssVars({ "--i": 6 })}>
                      <SecHead icon="users" tone="blue" title="Contacts"
                        sub={`${persons.length} ${persons.length === 1 ? "person" : "people"}${persons.some((p) => p.billing) ? ` · ${persons.filter((p) => p.billing).length} billing` : ""}`}>
                        {persons.length > PEOPLE_LIMIT && (
                          <label className="cw-search"><Ico n="search" s={14} /><input value={peopleQ} placeholder="Search people" onChange={(e) => setPeopleQ(e.target.value)} /></label>
                        )}
                        <button className="cw-btn-primary is-sm" onClick={() => { setAddPersonErr(null); setAddPerson((v) => (v ? null : { first: "", last: "", position: "", email: "", phone: "", billing: false })); }}>
                          <Ico n={addPerson ? "x" : "plus"} s={14} />{addPerson ? "Cancel" : "Add"}
                        </button>
                      </SecHead>
                      <div className={`cw-reveal ${addPerson ? "is-on" : ""}`} aria-hidden={!addPerson}>
                        <div className="cw-reveal-in">
                          {addPerson && (
                            <div className="cw-logform cw-addp">
                              <div className="cw-addp-grid">
                                <label><span>First name</span><input autoFocus value={addPerson.first} onChange={(e) => setAddPerson({ ...addPerson, first: e.target.value })} /></label>
                                <label><span>Last name{pReq("last_name")}</span><input value={addPerson.last} onChange={(e) => setAddPerson({ ...addPerson, last: e.target.value })} /></label>
                                <label><span>Position{pReq("position")}</span><input value={addPerson.position} placeholder="e.g. CFO" onChange={(e) => setAddPerson({ ...addPerson, position: e.target.value })} /></label>
                                <label><span>Email{pReq("email")}</span><input type="email" value={addPerson.email} onChange={(e) => setAddPerson({ ...addPerson, email: e.target.value })} /></label>
                                <label><span>Phone{pReq("phone")}</span><input type="tel" value={addPerson.phone} placeholder="+34 600 000 000" onChange={(e) => setAddPerson({ ...addPerson, phone: e.target.value })}
                                  onKeyDown={(e) => { if (e.key === "Enter" && !addPersonBusy) void savePerson(); }} /></label>
                                <button type="button" className={`cw-addp-bill ${addPerson.billing ? "is-on" : ""}`} onClick={() => setAddPerson({ ...addPerson, billing: !addPerson.billing })}>
                                  <i>{addPerson.billing && <Ico n="check" s={11} />}</i>Billing contact
                                </button>
                              </div>
                              {addPersonErr && <p className="cw-err">{addPersonErr}</p>}
                              <div className="cw-logactions">
                                <span className="cw-addp-note">{co.id ? `Saved to ${str(co.name) || "the company"} in Contacts` : "Saved on this client"}</span>
                                <button className="cw-btn-primary is-sm" disabled={addPersonBusy || !addPerson.first.trim()} onClick={() => void savePerson()}>{addPersonBusy ? "Saving…" : "Save contact"}</button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      {persons.length === 0 ? (
                        <div className="cw-empty"><Ico n="users" s={20} /><p>{loaded ? "No contacts on file for this client." : "Loading contacts…"}</p></div>
                      ) : (
                        <div className="cw-people-grid is-rows">
                          {peopleShown.map((p, i) => (
                            <PersonCard key={p.key} p={p} i={i} open={openPeople.has(p.key)} onToggle={() => { hideTip(); togglePerson(p.key); }}
                              last={lastByPerson.get(norm(p.name)) ?? null} fields={ctFields}
                              onOpenContact={openContact} onLog={startLog} tipOn={tipOn} />
                          ))}
                        </div>
                      )}
                      {!peopleQ && persons.length > PEOPLE_LIMIT && (
                        <button className="cw-more-btn" onClick={() => setAllPeople((v) => !v)}>
                          {allPeople ? "Show fewer" : `Show all ${persons.length} contacts`}<Ico n="chev" s={14} />
                        </button>
                      )}
                    </section>

                    <section ref={pulseRef} data-sec="pulse" className={`cw-card cw-pulse is-${health}`} style={cssVars({ "--i": 5 })}>
                      <SecHead icon="pulse" tone="teal" title="Last contacted" sub={touches.length ? `${touches.length} touchpoint${touches.length === 1 ? "" : "s"}` : "Nothing on record yet"}>
                        <button className="cw-btn-primary is-sm" onClick={() => (logOpen ? setLogOpen(false) : startLog())}>
                          <Ico n={logOpen ? "x" : "plus"} s={14} />{logOpen ? "Cancel" : "Log"}
                        </button>
                      </SecHead>

                      <div className="cw-sec-body">
                      <div className="cw-pulse-top" {...tipOn(last ? <TipCard title={last.who} sub={`${last.kind} · ${fmt(last.at)} · ${ago(last.at)}`}>{last.why}</TipCard> : null)}>
                        <div className="cw-pring">
                          <svg viewBox="0 0 110 110" aria-hidden="true">
                            <circle className="cw-pring-bg" cx="55" cy="55" r="46" />
                            <circle className="cw-pring-fill" cx="55" cy="55" r="46" style={{ strokeDasharray: `${(2 * Math.PI * 46 * ringFill).toFixed(1)} ${(2 * Math.PI * 46).toFixed(1)}` }} />
                          </svg>
                          <span className="cw-pring-mid">
                            {lastDays == null ? <b>—</b> : lastDays === 0 ? <b className="is-word">Today</b> : <b>{Math.round(lastDaysAnim)}</b>}
                            <i>{lastDays == null ? "no contact" : lastDays === 0 ? "in touch" : lastDays === 1 ? "day ago" : "days ago"}</i>
                          </span>
                        </div>
                        <div className="cw-pulse-info">
                          <span className={`cw-health is-${health}`}><i />{healthLabel}</span>
                          {last ? (
                            <p className="cw-pulse-last"><b>{last.who}</b> · <span className="cw-kind-t">{last.kind}</span></p>
                          ) : <p className="cw-hint">Log the first call, email or meeting.</p>}
                          {nextMeeting && <p className="cw-pulse-next"><Ico n="cal" s={13} />Next: {nextMeeting.title || "Meeting"} · {fmt(nextMeeting.at)}</p>}
                        </div>
                      </div>

                      <div className={`cw-reveal ${logOpen ? "is-on" : ""}`} aria-hidden={!logOpen}>
                        <div className="cw-reveal-in">
                          <div className="cw-logform">
                            <div className="cw-chans">
                              {CHANNELS.map((ch) => (
                                <button key={ch} className={logChannel === ch ? "is-on" : ""} onClick={() => setLogChannel(ch)}><Ico n={kindIcon(ch)} s={13} />{ch}</button>
                              ))}
                            </div>
                            <div className="cw-logrow">
                              <PersonCombo value={logWho} onChange={setLogWho} people={persons} />
                              <span className="cw-date"><DatePicker value={logDate} maxDate={todayISO()} onChange={(d) => setLogDate(d || todayISO())} /></span>
                            </div>
                            <input value={logWhy} placeholder="What was it about?" onChange={(e) => setLogWhy(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter" && !logBusy) void saveLog(); }} />
                            {logErr && <p className="cw-err">{logErr}</p>}
                            <div className="cw-logactions"><button className="cw-btn-primary is-sm" disabled={logBusy} onClick={saveLog}>{logBusy ? "Saving…" : "Save contact"}</button></div>
                          </div>
                        </div>
                      </div>

                      {touches.length > 0 && (
                        <ol className={`cw-timeline ${historyAll ? "is-all" : ""}`}>
                          {(historyAll ? touches : touches.slice(0, 4)).map((t, i) => (
                            <li key={`${t.at}-${i}`} data-kind={t.kind} style={cssVars({ "--i": i })}
                              {...tipOn(<TipCard title={t.who} sub={`${t.kind} · ${fmt(t.at)} · ${ago(t.at)}`}>{t.why}</TipCard>)}>
                              <span className="cw-tl-dot"><Ico n={kindIcon(t.kind)} s={12} /></span>
                              <span className="cw-tl-who">{t.who}</span>
                              <span className="cw-tl-why">{t.why}</span>
                              <time>{shortAgo(t.at)}</time>
                            </li>
                          ))}
                        </ol>
                      )}
                      {touches.length > 4 && (
                        <button className="cw-more-btn" onClick={() => setHistoryAll((v) => !v)}>
                          {historyAll ? "Show less" : `Full history · ${touches.length}`}<Ico n="chev" s={14} />
                        </button>
                      )}
                      </div>
                    </section>

                <section className="cw-zone" data-sec="tasks" data-tone="amber" style={cssVars({ "--i": 7 })}>
                  <header className="cw-zone-h">
                    <span className="cw-zone-ico"><Ico n="tasks" s={17} /></span>
                    <div><h3>Tasks</h3><small>{openTasks.length ? `${openTasks.length} open${lateTasks.length ? ` · ${lateTasks.length} overdue` : ""}` : "Nothing open"} · the client's own and those from sales</small></div>
                  </header>
                <div className="cw-stack">
                  <div className="cw-tstats">
                    {[
                      { k: "Open", v: openTasks.length, tone: "green" },
                      { k: "Overdue", v: lateTasks.length, tone: "red" },
                      { k: "This week", v: openTasks.filter((t) => { const d = dueInfo(t.due_at); return !!d && d.n >= 0 && d.n <= 7; }).length, tone: "amber" },
                      { k: "Done", v: tasks.length - openTasks.length, tone: "blue" },
                    ].map((x, i) => (
                      <div className="cw-tstat" data-tone={x.tone} key={x.k} style={cssVars({ "--i": i })}><b><Num v={x.v} /></b><span>{x.k}</span></div>
                    ))}
                  </div>

                  {(
                    <section className={`cw-card cw-tadd ${taskDraft.trim() ? "is-typing" : ""}`}>
                      <div className="cw-tadd-row">
                        <span className="cw-tadd-ico"><Ico n="plus" s={15} /></span>
                        <input value={taskDraft} placeholder="Add a task for this client…" onChange={(e) => setTaskDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && !taskBusy) void createTask(); }} />
                        <button className="cw-btn-primary is-sm" disabled={!taskDraft.trim() || taskBusy} onClick={createTask}>{taskBusy ? "Adding…" : "Add"}</button>
                      </div>
                      <div className="cw-reveal">
                        <div className="cw-reveal-in">
                          <div className="cw-tadd-opts">
                            <div className="cw-pri">
                              {PRI.map((p) => <button key={p} data-p={p} className={taskPri === p ? "is-on" : ""} onClick={() => setTaskPri(p)}><i />{p}</button>)}
                            </div>
                            <span className="cw-tadd-date"><DatePicker value={taskDue} onChange={setTaskDue} placeholder="Due date" /></span>
                            <span className="cw-tadd-deal"><Select size="sm" aria-label="Where the task goes" value={taskDeal} onChange={setTaskDeal}
                              options={[{ value: "client", label: "Client", hint: "General" }, ...deals.map((d) => ({ value: d.id, label: d.name, hint: "Sale" }))]} /></span>
                          </div>
                        </div>
                      </div>
                      {taskErr && <p className="cw-err">{taskErr}</p>}
                    </section>
                  )}

                  <div className="cw-toolbar">
                    <Seg value={taskFilter} onChange={setTaskFilter} options={[
                      { v: "open", label: "Open", n: openTasks.length },
                      { v: "late", label: "Overdue", n: lateTasks.length },
                      { v: "done", label: "Done", n: tasks.length - openTasks.length },
                      { v: "all", label: "All", n: tasks.length },
                    ]} />
                    <Seg value={taskSrc} onChange={setTaskSrc} options={[
                      { v: "all", label: "Everything" },
                      { v: "client", label: "Client", n: tasks.filter((t) => t.src === "client").length },
                      { v: "sale", label: "From sales", n: tasks.filter((t) => t.src !== "client").length },
                    ]} />
                  </div>

                  {shownTasks.length === 0 ? (
                    <div className="cw-empty is-big"><Ico n="tasks" s={24} /><p>{taskFilter === "late" ? "Nothing overdue." : taskFilter === "done" ? "No finished tasks yet." : tasks.length ? "All caught up." : "No tasks for this client yet."}</p></div>
                  ) : (
                    <>{sources.map((src) => {
                      if (taskSrc !== "all" && (src.key === "client") !== (taskSrc === "client")) return null;
                      const list = shownTasks.filter((t) => (src.key === "client" ? t.src === "client" : t.src !== "client" && t.tracking_id === src.key));
                      if (!list.length) return null;
                      const open = list.filter((t) => !t.done).length;
                      return (
                        <div className={`cw-sgroup ${src.key === "client" ? "is-client" : "is-sale"}`} key={src.key}>
                          <h4 className="cw-sgroup-h">
                            <span className="cw-sgroup-ico"><Ico n={src.key === "client" ? "briefcase" : "flag"} s={13} /></span>
                            <b>{src.title}</b><em>{src.sub}</em>
                            <i>{taskFilter === "done" ? `${list.length} done` : `${open} open`}</i>
                          </h4>
                    <ul className="cw-tasks">
                      {list.map((t, i) => {
                        const due = dueInfo(t.due_at);
                        return (
                          <li key={t.id} className={`cw-task ${t.done ? "is-done" : ""}`} data-p={t.priority} style={cssVars({ "--i": i })}
                            {...tipOn(<TipCard title={plain(t.title)}
                              sub={[t.priority !== "normal" ? `${t.priority} priority` : "", t.status === "in_progress" ? "in progress" : t.status === "blocked" ? "blocked" : ""].filter(Boolean).join(" · ") || undefined}
                              rows={[
                                ["Due", t.due_at ? `${fmt(t.due_at)}${due && !t.done ? ` · ${due.label}` : ""}` : ""], ["Deal", dealName(t.tracking_id)],
                                ["Progress", t.kind === "process" ? `${t.progress ?? 0}%` : ""],
                                ["Assigned", t.assignees.map((id) => people[id]).filter(Boolean).join(", ")],
                                ["Created", t.created_at ? `${fmt(t.created_at)}${t.created_by && people[t.created_by] ? ` by ${people[t.created_by]}` : ""}` : ""],
                              ]}>{t.description ? plain(String(t.description)) : null}</TipCard>)}>
                            <button className="cw-check" onClick={() => flipTask(t)} aria-pressed={t.done} aria-label={t.done ? "Mark as open" : "Mark as done"}>
                              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                            </button>
                            <p className="cw-task-title">{renderNoteBody(t.title)}</p>
                            {t.src !== "client" && <span className="cw-badge is-violet">Sales</span>}
                            {t.kind === "process" && !t.done && <span className="cw-tprog"><span><i style={{ width: `${t.progress ?? 0}%` }} /></span></span>}
                            {due && !t.done && <span className={`cw-due is-${due.tone}`}>{due.label}</span>}
                            <span className="cw-task-people">{t.assignees.slice(0, 3).map((id) => <span key={id}><Avatar name={people[id] ?? "?"} size={22} /></span>)}</span>
                          </li>
                        );
                      })}
                    </ul>
                        </div>
                      );
                    })}</>
                  )}
                </div>
                </section>

                <section className="cw-zone" data-sec="notes" data-tone="blue" style={cssVars({ "--i": 8 })}>
                  <header className="cw-zone-h">
                    <span className="cw-zone-ico"><Ico n="note" s={17} /></span>
                    <div><h3>Notes</h3><small>{allNotes.length ? `${allNotes.length} note${allNotes.length === 1 ? "" : "s"}${saleNotes.length ? ` · ${saleNotes.length} from sales` : ""}` : "Nothing written yet"}</small></div>
                  </header>
                <div className="cw-notes-wrap">
                  <section className="cw-card cw-composer">
                    <div className="cw-composer-head">
                      {me && <Avatar name={people[me] ?? "Me"} size={34} />}
                      <div className="cw-note-add">
                        <MentionInput value={noteDraft} onChange={setNoteDraft} people={mentionPeople}
                          placeholder="Write a note… type @ to tag someone" multiline className="cw-mention" />
                      </div>
                    </div>
                    <div className={`cw-composer-foot ${noteDraft.trim() ? "is-on" : ""}`}>
                      <div><button className="cw-btn-primary is-sm" disabled={!noteDraft.trim()} onClick={addNote}><Ico n="note" s={14} />Add note</button></div>
                    </div>
                    {noteErr && <p className="cw-err">{noteErr}</p>}
                  </section>

                  <div className="cw-toolbar">
                    <Seg value={noteFilter} onChange={setNoteFilter} options={[
                      { v: "all", label: "All", n: allNotes.length },
                      { v: "client", label: "Client", n: notes.length },
                      { v: "sale", label: "From sales", n: saleNotes.length },
                    ]} />
                    <label className="cw-search"><Ico n="search" s={14} /><input value={noteQ} placeholder="Search notes" onChange={(e) => setNoteQ(e.target.value)} /></label>
                  </div>

                  {noteGroups.length === 0 ? (
                    <div className="cw-empty is-big"><Ico n="note" s={24} /><p>{allNotes.length ? "No notes match." : "No notes yet. Write the first one above."}</p></div>
                  ) : noteGroups.map((g) => (
                    <div className={`cw-ngroup cw-sgroup ${g.key === "client" ? "is-client" : "is-sale"}`} key={g.key}>
                      <h4 className="cw-sgroup-h">
                        <span className="cw-sgroup-ico"><Ico n={g.key === "client" ? "briefcase" : "flag"} s={13} /></span>
                        <b>{g.label}</b><em>{g.sub}</em><i>{g.items.length} note{g.items.length === 1 ? "" : "s"}</i>
                      </h4>
                      <ol className="cw-nlist">
                        {g.items.map((n, i) => {
                          const who = people[n.author_id ?? ""] ?? (n.src === "sale" ? "Sales" : "Unknown");
                          return (
                            <li key={`${n.src}-${n.id}`} className={`cw-note is-${n.src}`} style={cssVars({ "--i": i })}>
                              <Avatar name={who} size={32} />
                              <div className="cw-note-card">
                                <div className="cw-note-top">
                                  <b>{who}</b>
                                  <time {...tipOn(<TipCard title={toDate(n.created_at).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
                                    sub={n.src === "sale" ? `From the sale${n.deal ? ` · ${n.deal}` : ""}` : n.mentions.length ? `Tagged ${n.mentions.map((m) => people[m]).filter(Boolean).join(", ")}` : undefined} />)}>
                                    {ago(n.created_at)}
                                  </time>
                                  {n.src === "sale" && <span className="cw-badge is-violet">Sales</span>}
                                  {n.src === "client" && n.author_id && n.author_id === me && (
                                    confirmNote === n.id ? (
                                      <span className="cw-note-confirm">Delete?<button className="is-yes" onClick={() => deleteNote(n.id)}>Yes</button><button onClick={() => setConfirmNote(null)}>No</button></span>
                                    ) : (
                                      <button className="cw-note-del" onClick={() => setConfirmNote(n.id)} aria-label="Delete note"><Ico n="trash" s={13} /></button>
                                    )
                                  )}
                                </div>
                                <p>{renderNoteBody(n.body)}</p>
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  ))}
                </div>
                </section>
              </div>
            )}

            {/* ===== DEALS ===== */}
            {tab === "deals" && (
              <div className="cw-stack">
                <div className="cw-toolbar cw-deals-bar">
                  <p className="cw-deals-lead">
                    <b>{deals.length} deal{deals.length === 1 ? "" : "s"}</b>
                    <span>{(() => { const n = dealView.reduce((t, v) => t + v.props.length + v.looseProps.length, 0); return `${n} proposal${n === 1 ? "" : "s"} sent`; })()} · a deal's main proposal is what it sold</span>
                  </p>
                  {proposalsMissing.length > 0 && (
                    <button className="cw-btn-primary is-sm" disabled={copyBusy === "all"} onClick={() => void copyToFolders(proposalsMissing, "all")}>
                      <Ico n="copy" s={14} />{copyBusy === "all" ? "Copying…" : `Copy ${proposalsMissing.length} proposal${proposalsMissing.length === 1 ? "" : "s"} to the folders`}
                    </button>
                  )}
                </div>
                {copyMsg && <p className={copyMsg.ok ? "cw-okmsg" : "cw-err"}>{copyMsg.text}</p>}
                {deals.length === 0 ? (
                  <div className="cw-empty is-big"><Ico n="deal" s={24} /><p>{loaded ? (co.id ? "No sales deals for this company." : "This client isn't linked to a CRM company, so it has no deals.") : "Loading deals…"}</p></div>
                ) : dealView.map((v, i) => {
                  const st = String(v.d.status ?? "open").toLowerCase();
                  const tone = /won|handed|client/.test(st) ? "won" : /lost|cancel/.test(st) ? "lost" : /paused|hold/.test(st) ? "hold" : "open";
                  const stLabel = st === "paused" ? "On hold" : st.charAt(0).toUpperCase() + st.slice(1).replace(/_/g, " ");
                  const fileRow = (f: TrackFile, extra?: React.ReactNode) => {
                    const there = inFolders(f);
                    return (
                      <div className="cw-dfile" key={f.id}>
                        <button className="cw-dfile-open" onClick={() => void openSalesFile(f)} {...tipOn(<TipCard title={f.name} sub={[fmt(f.created_at), f.note ?? ""].filter(Boolean).join(" · ")} />)}>
                          <span className="cw-dfile-ico" data-k={(f.name.split(".").pop() ?? "").slice(0, 4).toUpperCase()}><Ico n="file" s={14} /></span>
                          <span className="cw-dfile-name">{extra ?? f.name}</span>
                          <Ico n="download" s={13} />
                        </button>
                        {there ? <span className="cw-dfile-in" {...tipOn(<TipCard title="Already in the client's folders" />)}><Ico n="check" s={12} />In folders</span>
                          : <button className="cw-dfile-copy" disabled={copyBusy === f.id} onClick={() => void copyToFolders([f], f.id)}>
                            <Ico n="copy" s={12} />{copyBusy === f.id ? "Copying…" : "To folders"}
                          </button>}
                      </div>
                    );
                  };
                  return (
                    <article key={v.d.id} className="cw-deal" data-sec={`deal-${v.d.id}`} data-st={tone} style={cssVars({ "--i": i })}>
                      <header className="cw-deal-h">
                        <span className="cw-deal-ico"><Ico n={tone === "won" ? "star" : "flag"} s={17} /></span>
                        <div className="cw-deal-id">
                          <h4>{v.d.name}</h4>
                          <small>{[v.d.pipeline, v.d.phase].filter(Boolean).join(" · ") || "Sales deal"}</small>
                        </div>
                        <span className={`cw-dstat is-${tone}`}><i />{stLabel}</span>
                        <div className="cw-deal-val">
                          <b>{v.value != null ? eur(v.value) : "—"}</b>
                          <small>{v.main ? `Main: ${v.main.name}` : "Deal value"}</small>
                        </div>
                        <button className="cw-icon-btn" onClick={() => openDeal(v.d.id)} aria-label="Open in Sales" {...tipOn(<TipCard title="Open in Sales" />)}><Ico n="out" s={15} /></button>
                      </header>
                      <div className="cw-deal-facts">
                        {v.d.created_at && <span><Ico n="cal" s={12} />Opened {fmt(v.d.created_at)}</span>}
                        {v.d.close_date && <span><Ico n="check" s={12} />Closed {fmt(v.d.close_date)}</span>}
                        <button onClick={() => goSec("overview", "tasks")}><Ico n="tasks" s={12} />{v.tasksOpen} open task{v.tasksOpen === 1 ? "" : "s"}</button>
                        <button onClick={() => goSec("overview", "notes")}><Ico n="note" s={12} />{v.notesN} note{v.notesN === 1 ? "" : "s"}</button>
                      </div>
                      <div className="cw-deal-grid">
                        <section className="cw-deal-col" data-tone="amber">
                          <h5><Ico n="send" s={13} />Proposals<i>{v.props.length + v.looseProps.length}</i></h5>
                          {v.props.length + v.looseProps.length === 0 ? <p className="cw-deal-empty">No proposals generated on this deal.</p> : (
                            <div className="cw-dprops">
                              {v.props.map((pr) => {
                                const f = pr.file_id ? fileById.get(pr.file_id) : undefined;
                                return (
                                  <div className={`cw-dprop ${pr.is_main ? "is-main" : ""}`} key={pr.id}>
                                    <div className="cw-dprop-top">
                                      <b>{pr.name}</b>
                                      {pr.is_main && <span className="cw-dprop-main"><Ico n="star" s={11} />Main</span>}
                                      <em>{pr.total != null ? eur(pr.total) : ""}</em>
                                    </div>
                                    {f ? fileRow(f) : <p className="cw-deal-empty is-sm">No document generated yet</p>}
                                  </div>
                                );
                              })}
                              {v.looseProps.map((f) => (
                                <div className="cw-dprop" key={f.id}>
                                  <div className="cw-dprop-top"><b>{(f.note ?? "").replace(/^proposal\s*·\s*/i, "") || "Proposal"}</b></div>
                                  {fileRow(f)}
                                </div>
                              ))}
                            </div>
                          )}
                        </section>
                        <section className="cw-deal-col" data-tone="blue">
                          <h5><Ico n="file" s={13} />Documents<i>{v.docs.length}</i></h5>
                          {v.docs.length === 0 ? <p className="cw-deal-empty">No documents shared from this deal.</p> : (
                            <div className="cw-dfiles">{v.docs.map((f) => fileRow(f))}</div>
                          )}
                        </section>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {/* ===== PROJECTS ===== */}
            {tab === "projects" && (
              <div className="cw-stack">
                <div className="cw-toolbar">
                  <Seg value={projFilter} onChange={setProjFilter} options={[
                    { v: "all", label: "All", n: projects.length },
                    { v: "open", label: "Open", n: projects.filter((p) => p.status !== "closed").length },
                    { v: "closed", label: "Closed", n: projects.filter((p) => p.status === "closed").length },
                  ]} />
                  <button className="cw-btn-primary" onClick={() => { hideTip(); onNewProject(); }}><Ico n="plus" s={15} />New project</button>
                </div>
                {filteredProjects.length === 0 ? (
                  <div className="cw-empty is-big"><Ico n="briefcase" s={24} /><p>{projects.length ? "No projects match this filter." : "No projects yet."}</p></div>
                ) : (
                  <div className="cw-proj-grid">
                    {filteredProjects.map((p, i) => {
                      const days = signedOf(p);
                      const u = usage[p.id] ?? { planned: 0, done: 0 };
                      const pl = +(days - u.planned - u.done).toFixed(2);
                      const pct = (n: number) => (days > 0 ? Math.min(100, (n / days) * 100) : 0);
                      const usedPct = Math.round(pct(u.done));
                      const closed = p.status === "closed";
                      const s = p.kickoffDate || p.signingDate;
                      const elapsed = s && p.endDate ? clamp((Date.now() - toDate(s).getTime()) / Math.max(1, toDate(p.endDate).getTime() - toDate(s).getTime())) : null;
                      const C = 2 * Math.PI * 26;
                      const rate = avgRate(p);
                      const un = unitOf(p);
                      return (
                        <article key={p.id} className={`cw-proj ${closed ? "is-closed" : ""} ${pl < 0 ? "is-over" : ""}`} style={cssVars({ "--i": i })}
                          role="button" tabIndex={0} onClick={() => { hideTip(); onOpenProject(p); }}
                          onKeyDown={(e) => { if (e.key === "Enter") onOpenProject(p); }}
                          {...tipOn(<TipCard title={typeName(p.projectTypeId)} sub={`${p.status || "open"} · click to edit`} rows={[
                            ["Used", `${d2(u.done)}${un}`], ["Booked", `${d2(u.planned)}${un}`], ["Left", `${d2(pl)}${un}`], ["Signed", `${d2(days)}${un}`],
                            ["Kick-off", p.kickoffDate ? fmt(p.kickoffDate) : ""], ["End", p.endDate ? fmt(p.endDate) : ""],
                            ["Time elapsed", elapsed != null ? `${Math.round(elapsed * 100)}%` : ""],
                            ["Rate", `${eur(rate)} / ${un === "h" ? "hour" : "day"}${linesOf(p).length > 1 ? " avg." : ""}`], ...roleTipRows(p, un), ["Team", (p.team ?? []).map((m) => m.name).filter(Boolean).join(", ")],
                          ]} />)}>
                          <header className="cw-proj-top">
                            <div className="cw-proj-ring">
                              <svg viewBox="0 0 64 64" aria-hidden="true">
                                <circle className="bg" cx="32" cy="32" r="26" />
                                <circle className="fg" cx="32" cy="32" r="26" style={cssVars({ "--dash": `${((C * usedPct) / 100).toFixed(1)}`, "--c": C.toFixed(1) })} />
                              </svg>
                              <b>{usedPct}<i>%</i></b>
                            </div>
                            <div className="cw-proj-id">
                              <h4>{typeName(p.projectTypeId)}</h4>
                              <span className={`cw-status ${closed ? "is-closed" : "is-open"}`}><i />{p.status || "open"}</span>
                            </div>
                            <b className="cw-proj-val">{eur(projectValue(p))}</b>
                          </header>
                          <div className="cw-proj-bar" aria-hidden="true">
                            <span className="is-booked" style={{ width: `${pct(u.done + u.planned)}%` }} />
                            <span className="is-done" style={{ width: `${pct(u.done)}%` }} />
                          </div>
                          <footer className="cw-proj-foot">
                            <span className={`cw-proj-figs ${pl < 0 ? "is-over" : ""}`}>{d2(u.done)} / {d2(days)}{un}{pl < 0 ? ` · ${d2(-pl)}${un} over` : elapsed != null ? ` · ${Math.round(elapsed * 100)}% of time` : ""}</span>
                            <div className="cw-team">
                              {(p.team ?? []).filter((m) => m.name).slice(0, 3).map((m) => <span key={m.id}><Avatar name={m.name} size={24} /></span>)}
                              {(p.team ?? []).length > 3 && <span className="cw-team-more">+{p.team.length - 3}</span>}
                            </div>
                          </footer>
                          <div className={`cw-proj-del ${confirmDel === p.id ? "is-asking" : ""}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onMouseEnter={hideTip}>
                            {confirmDel === p.id ? (
                              <>
                                <span>Delete?</span>
                                <button className="is-yes" onClick={() => { setConfirmDel(null); onDeleteProject(p.id); }}>Delete</button>
                                <button onClick={() => setConfirmDel(null)}>Keep</button>
                              </>
                            ) : (
                              <button className="is-x" onClick={() => setConfirmDel(p.id)} aria-label="Delete project"><Ico n="trash" s={13} /></button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ===== CONTRACT ===== */}
            {tab === "contract" && (
              <div className="cw-stack cw-secs">
                <div className="cw-ckpis" data-sec="summary">
                  {[
                    { k: "Engagement", v: totals.value, sub: "€ in projects", icon: "briefcase", tone: "green", rows: projRows((p) => eur(projectValue(p))) },
                    { k: "Recurring", v: recurringYear, sub: "€ per year", icon: "repeat", tone: "violet", rows: activeLines.filter((l) => l.recurring).map((l) => [l.name, eur(lineAnnual(l))] as [string, React.ReactNode]) },
                    { k: "One-time", v: oneTime, sub: "€ fees & one-offs", icon: "euro", tone: "blue", rows: lines.filter((l) => !l.recurring || Number(l.one_time_fee)).map((l) => [l.name, eur((l.recurring ? 0 : lineTotal(l)) + (Number(l.one_time_fee) || 0))] as [string, React.ReactNode]) },
                  ].map((x, i) => (
                    <div className="cw-ckpi" data-tone={x.tone} key={x.k} style={cssVars({ "--i": i })} {...tipOn(x.rows.length ? <TipCard title={x.k} rows={x.rows} /> : null)}>
                      <span className="cw-ckpi-top"><span className="cw-ckpi-ico"><Ico n={x.icon} s={15} /></span><span className="cw-ckpi-k">{x.k}</span></span>
                      <b><Num v={x.v} /></b>
                      <small>{x.sub}</small>
                    </div>
                  ))}
                  <div className="cw-ckpi" data-tone="amber" style={cssVars({ "--i": 3 })}>
                    <span className="cw-ckpi-top"><span className="cw-ckpi-ico"><Ico n="cal" s={15} /></span><span className="cw-ckpi-k">Next renewal</span></span>
                    <b className="is-date">{nextRenewal ? fmtD(nextRenewal.end) : "—"}</b>
                    <small>{nextRenewal ? `in ${nextRenewal.left} days` : "No term on file"}</small>
                  </div>
                </div>

                <section className="cw-card" data-sec="products">
                  <SecHead icon="contract" tone="violet" title="Signed products" sub={lines.length ? `${activeLines.length} active` : "Added when a deal is won, or by hand"}>
                    {lines.length > 0 && (
                      <button className="cw-btn-primary is-sm" onClick={() => setAddLine((v) => !v)}><Ico n={addLine ? "x" : "plus"} s={14} />{addLine ? "Cancel" : "Add product"}</button>
                    )}
                  </SecHead>
                  {addLine && <AddLineForm clientId={client.id} persons={persons} onCancel={() => setAddLine(false)} onSaved={async () => { setAddLine(false); await reloadLines(); }} />}
                  {lines.length === 0 ? (!addLine && (
                    <button className="cw-empty is-action" onClick={() => setAddLine(true)} disabled={!loaded}>
                      <span className="cw-empty-plus"><Ico n="plus" s={18} /></span>
                      <p>{loaded ? <><b>No signed products yet</b><small>Add a signed contract with one of your products</small></> : "Loading…"}</p>
                    </button>
                  )) : (
                    <div className="cw-lines">
                      {lines.map((l, i) => {
                        const term = termOf(l);
                        const per = periodLabel(l.period);
                        return (
                          <article key={l.id} className={`cw-line ${isActive(l) ? "" : "is-off"}`} style={cssVars({ "--i": i })}
                            {...tipOn(<TipCard title={l.name} sub={`${l.status || "active"}${str(l.contract_ref) ? ` · Ref ${l.contract_ref}` : ""}`} rows={[
                              ["Price", `${Number(l.quantity) || 1} × ${eur(Number(l.price) || 0)}${l.recurring ? ` / ${per}` : ""}`],
                              ["Discount", l.discount_mode && l.discount_mode !== "none" && Number(l.discount_value) ? (l.discount_mode === "percent" ? `${l.discount_value}%` : eur(Number(l.discount_value))) : ""],
                              ["Yearly", l.recurring ? eur(lineAnnual(l)) : ""], ["Set-up fee", Number(l.one_time_fee) ? eur(Number(l.one_time_fee)) : ""],
                              ["Signed", l.signing_date ? fmt(l.signing_date) : ""], ["Start", l.start_date ? fmt(l.start_date) : ""],
                              ["Term", l.term_years ? `${l.term_years}y${term ? ` · until ${fmtD(term.end)}` : ""}` : ""],
                              ["Auto-renew", l.auto_renew ? `Yes${l.renew_years ? `, every ${l.renew_years}y` : ""}` : ""],
                              ["Non-terminable", l.non_terminable_years ? `${l.non_terminable_years}y` : ""],
                              ["Increase", l.annual_increase_pct != null && l.annual_increase_pct !== "" ? `${l.annual_increase_pct}% / year` : ""],
                              ["Payment", l.payment_terms_days ? `${l.payment_terms_days} days` : ""],
                              ["Billing", [str(l.billing_contact_name), str(l.billing_contact_email)].filter(Boolean).join(" · ")],
                              ["External ref", str(l.external_ref)], ["Deal", l.tracking_id ? dealName(l.tracking_id) : ""],
                            ]} />)}>
                            <div className="cw-line-head">
                              <span className="cw-line-ico" style={cssVars({ "--h": hue(l.name) })}>{initials(l.name)}</span>
                              <span className="cw-line-id">
                                <b>{l.name}</b>
                                <small>{l.recurring ? <><Ico n="repeat" s={12} />Every {per}</> : "One-off"}</small>
                              </span>
                              <span className="cw-line-price"><b>{eur(lineTotal(l))}{l.recurring && <em> / {per}</em>}</b></span>
                              <span className={`cw-status ${isActive(l) ? "is-open" : "is-closed"}`}><i />{l.status || "active"}</span>
                            </div>
                            {Array.isArray(l.breakdown?.rows) && l.breakdown.rows.length > 0 && (
                              <div className="cw-line-bd">
                                {l.breakdown.rows.map((r: any, j: number) => (
                                  <div key={j}>
                                    <span>{r.label}{r.detail ? <em> {r.detail}</em> : null}</span>
                                    <b>{eur(Number(r.amount) || 0)}{Number(r.discount) ? <i> −{eur(Number(r.discount))}</i> : null}</b>
                                  </div>
                                ))}
                                <div className="is-total">
                                  <span>{l.breakdown.version ? `Sold as ${l.breakdown.version}` : "Sold"}{l.breakdown.multiplier ? ` · ${l.breakdown.multiplier}` : ""}</span>
                                  <b>{eur(Number(l.breakdown.total) || 0)}</b>
                                </div>
                              </div>
                            )}
                            {l.recurring && (Number(l.term_years) || 0) > 1 && (() => {
                              const sc = scheduleOf(l);
                              const ts = termsOf(l, sc);
                              const editing = schedEdit?.id === l.id;
                              const s0 = str(l.start_date) || str(l.signing_date);
                              const el = s0 ? (Date.now() - toDate(s0).getTime()) / (365.25 * DAY) : -1;
                              return (
                                <div className="cw-line-sched" onMouseEnter={hideTip}>
                                  {!editing ? (
                                    <div className="cw-line-terms">
                                      {sc && sc.count > 1 ? ts.map((t) => (
                                        <span key={t.i} className={el >= t.from && el < t.from + t.len ? "is-now" : ""}>
                                          <i>T{t.i + 1}</i>{eur(t.unit)}<em>/{per}</em>{t.inc ? <small>+{t.inc}%</small> : null}
                                        </span>
                                      )) : <span className="is-plain">Paid as one {l.term_years}-year term</span>}
                                      <button className="cw-linkbtn" onClick={() => { setSchedErr(null); setSchedEdit({ id: l.id, v: sc ?? { count: 1, increases: [] } }); }}>
                                        {sc && sc.count > 1 ? "Edit terms" : "Split into terms"}<Ico n="arrow" s={12} />
                                      </button>
                                    </div>
                                  ) : (
                                    <>
                                      <ScheduleEditor years={Number(l.term_years) || 1} unit={lineTotal(l)} per={per} value={schedEdit.v} onChange={(v) => setSchedEdit({ id: l.id, v })} />
                                      {schedErr && <p className="cw-err">{schedErr}</p>}
                                      <div className="cw-logactions">
                                        <button className="cw-ghost" onClick={() => setSchedEdit(null)}>Cancel</button>
                                        <button className="cw-btn-primary is-sm" onClick={async () => {
                                          const v = schedEdit.v.count > 1 || schedEdit.v.increases.some(Boolean) ? schedEdit.v : null;
                                          const { error } = await supabase.from("client_products").update({ schedule: v }).eq("id", l.id);
                                          if (error) { setSchedErr(/schedule/i.test(error.message) ? "Run client_terms.sql in Supabase first." : error.message); return; }
                                          setLines((xs) => xs.map((x) => (x.id === l.id ? { ...x, schedule: v } : x)));
                                          setSchedEdit(null);
                                        }}>Save terms</button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              );
                            })()}
                            {term && (
                              <div className="cw-term">
                                <div className="cw-term-bar"><span style={{ width: `${term.pct * 100}%` }} /></div>
                                <em className={term.left < 60 ? "is-soon" : ""}>{term.left < 0 ? "Ended" : `${l.auto_renew ? "Renews" : "Ends"} ${fmtD(term.end)}`}</em>
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="cw-card" data-sec="services">
                  <SecHead icon="briefcase" tone="green" title="Service engagements" sub="Hover a row for rates, tax and payment" />
                  {projects.length === 0 ? <div className="cw-empty"><Ico n="briefcase" s={20} /><p>No projects signed yet.</p></div> : (
                    <div className="cw-eng">
                      <div className="cw-eng-row is-head"><span>Service</span><span>Signed</span><span>Days</span><span>Day rate</span><span className="is-r">Value</span></div>
                      {projects.map((p, i) => {
                        const rate = avgRate(p);
                        const un = unitOf(p);
                        return (
                          <button className="cw-eng-row" key={p.id} style={cssVars({ "--i": i })} onClick={() => { hideTip(); onOpenProject(p); }}
                            {...tipOn(<TipCard title={typeName(p.projectTypeId)} rows={[
                              ...roleTipRows(p, un),
                              ["Discount", totalDiscountOf(p) ? `${eur(totalDiscountOf(p))} total` : ""],
                              ["Tax", p.taxed ? `${p.taxRate}%` : "No tax"], ["Payment", p.paymentDays ? `${p.paymentDays} days` : ""],
                            ]} />)}>
                            <span data-k="Service"><b>{typeName(p.projectTypeId)}</b></span>
                            <span data-k="Signed">{fmt(p.signingDate)}</span>
                            <span data-k="Days">{d2(signedOf(p))}{un}</span>
                            <span data-k="Day rate">{eur(rate)}</span>
                            <span data-k="Value" className="is-r"><b>{eur(projectValue(p))}</b></span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* ===== UPSELLS ===== */}
            {tab === "upsells" && (
              <div className="cw-stack cw-upsells">
                <ClientUpsells clientId={client.id} clientName={client.name} />
              </div>
            )}

            {/* ===== FOLDERS ===== */}
            {tab === "folders" && (
              <div className="cw-folders">
                <header className="cw-folders-h">
                  <span className="cw-zone-ico"><Ico n="folder" s={18} /></span>
                  <div className="cw-folders-t">
                    <h3>Folders</h3>
                    <small>Contracts, proposals and everything filed for this client. Drop files anywhere below to upload them to the open folder; sales documents land here at handoff.</small>
                  </div>
                  {proposalsMissing.length > 0 && (
                    <button className="cw-btn-primary is-sm" disabled={copyBusy === "all"} onClick={() => void copyToFolders(proposalsMissing, "all")}
                      {...tipOn(<TipCard title="Proposals not in the folders yet" rows={proposalsMissing.map((f) => [f.name, deals.find((d) => d.id === f.tracking_id)?.name ?? ""] as [string, React.ReactNode])} />)}>
                      <Ico n="copy" s={14} />{copyBusy === "all" ? "Copying…" : `Bring ${proposalsMissing.length} proposal${proposalsMissing.length === 1 ? "" : "s"} from sales`}
                    </button>
                  )}
                </header>
                {copyMsg && <p className={copyMsg.ok ? "cw-okmsg" : "cw-err"}>{copyMsg.text}</p>}
                <div className="cw-folders-box"><ClientDirectory key={dirRev} clientId={client.id} tenantId={tenantId} /></div>
              </div>
            )}

          </div>
        </div>
        </div>
        <TipLayer tip={tip} />
      </div>
    </div>
  );
}

/** "With whom": type a name, or pick one of the client's people from the list under it. */
function PersonCombo({ value, onChange, people }: { value: string; onChange: (v: string) => void; people: { key: string; name: string; position?: string }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const q = value.trim().toLowerCase();
  const list = people.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.position ?? "").toLowerCase().includes(q)).slice(0, 7);
  const show = open && list.length > 0 && !(list.length === 1 && list[0].name === value);
  useLayoutEffect(() => {
    if (!show) return;
    const place = () => { const r = ref.current?.getBoundingClientRect(); if (r) setPos({ top: r.bottom + 6, left: r.left, width: Math.max(r.width, 240) }); };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [show]);
  const pick = (n: string) => { onChange(n); setOpen(false); };
  return (
    <div className="cw-combo" ref={ref}>
      <input value={value} placeholder="With whom" autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(list.length - 1, i + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); pick(list[hi].name); }
          else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
        }} />
      {show && pos && createPortal(
        <div className="sel-pop is-sm cw-combo-pop" style={{ top: pos.top, left: pos.left, minWidth: pos.width }} onMouseDown={(e) => e.preventDefault()}>
          {list.map((p, i) => (
            <button type="button" key={p.key} className={`sel-option ${i === hi ? "is-hi" : ""}`} onMouseEnter={() => setHi(i)} onClick={() => pick(p.name)}>
              <span>{p.name}{p.position && <small>{p.position}</small>}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
