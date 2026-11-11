/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { Client, ClientStatus, Project, ProjectType, ClientRole } from "./clientsTypes";
import { projectValue, signedOf, legacyRoleMap, resolvedLinesOf, lineRate, roleNameOf, roleCounts, totalDiscountOf, domainOf, logoCandidates, projectStatusOf, PROJECT_STATUS_LABEL } from "./clientsTypes";
import { supabase } from "../../api/supabase";
import ClientDirectory, { copyIntoClientFolders } from "./ClientDirectory";
import { ClientUpsells } from "./ClientsPage";
import MentionInput, { type MentionPerson, MentionText, mentionsToPlain, registerMentionNames } from "../../framework/MentionInput";
import { addTask, toggleTask, updateTaskMeta, saveClientProducts, loadDealContracts, saveDealContract, type ContractTerms, type PaymentSchedule, type TaskPriority, type TrackTask } from "../sales/sales/salesApi";
import { loadTrackingProducts, updateTrackingProduct, lineBreakdown, incrementsToSchedule, catalogIncrements, type TrackingProduct, type TermPatch } from "../sales/sales/salesApi";
import LineCalcModal from "../../framework/LineCalcModal";
import { loadProducts, type Product as CatalogProduct } from "../settings/catalogApi";
import { listCompanyFields, listContactFields, sessionUserId, saveContact, useRequiredFields, type CompanyField, type ContactField } from "../companies/companiesApi";
import { countryLabel, formatAddress, languageName, linkedInHandle, isFixedRequired, missingFixed } from "../contacts/contactProfile";
import Select from "../../framework/Select";
import { loadClientTickets, createTicket, stageLabel, ticketRef, PRIORITY_LABEL, type Ticket, type TicketStage } from "../homepage/shared/HomeTodo";
import { loadClientMail, setMailClient, fileMailFrom, loadMailRules, saveMailRule, deleteMailRule, createTicketFromMail, loadDirectory, MailFrame, TicketDrawerById, MAIL_ROUTING_SQL, type MailMsg, type MailRule } from "../homepage/shared/HomeTodo";
import DatePicker from "../../framework/DatePicker";
import { useClientEdit } from "../../framework/pageAccess";
import "../../framework/MentionInput.css";
import "./ClientWorkspace.css";
import { NumInput } from "../../framework/NumInput";

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
  /** A signed product was deleted here: the list behind refreshes its figures. */
  onLinesChanged?: () => void;
  /** Days used and booked per project role ("projectId|roleId"), for the projects' overview. */
  lineUsage?: Record<string, { done: number; booked: number }>;
  /** Marks the client active or lost (churned). */
  onSetStatus?: (status: ClientStatus, opts: { at?: string | null; reason?: string | null; stopProducts?: boolean }) => Promise<string | null>;
  onClose: () => void;
  /** Opened from a link (a report row…): go straight to this contract (a deal id) or to the signed products. */
  focus?: { contract?: string | null; products?: boolean } | null;
}

type Tab = "overview" | "deals" | "projects" | "contract" | "upsells" | "tickets" | "emails" | "folders";

interface Note { id: string; body: string; mentions: string[]; author_id: string | null; created_at: string; src: "client" | "sale"; deal?: string | null; dealId?: string | null }
interface ContactLog { id: string; contacted_at: string; channel: string | null; contact_name: string | null; reason: string | null; logged_by: string | null; direction?: "in" | "out" | null; source?: string | null }
interface TrackFile { id: string; tracking_id: string; name: string; note: string | null; mime: string | null; storage_path: string; created_at: string; size_bytes?: number | null; line_id?: string | null }
/** A proposal sales generated on a deal (deal_proposals): a named scenario with its value and document. */
interface DealProposal { id: string; tracking_id: string; name: string; is_main: boolean; total: number | null; file_id: string | null; created_at: string }
interface Touch { at: string; kind: string; who: string; why: string; dir?: "in" | "out"; source?: string | null; us?: string }
interface Person { key: string; id: string | null; name: string; position: string; email: string; phone: string; billing: boolean; crm: boolean; c: any | null }
interface Deal {
  id: string; name: string; status: string | null;
  phase?: string | null; pipeline?: string | null; created_at?: string | null; close_date?: string | null; price?: number | null;
}
export type Line = Record<string, any> & { id: string; name: string };
/** A task from one of the client's sales (tracking_tasks) or the client's own (client_tasks, src "client"). */
type Task = TrackTask & { tracking_id: string; assignees: string[]; src?: "client" | "sale" };

/* The display face of the client pop-up: names and figures. */
if (typeof document !== "undefined" && !document.getElementById("cw-font")) {
  const l = document.createElement("link");
  l.id = "cw-font"; l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@500;600;700;800&display=swap";
  document.head.appendChild(l);
}

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
const fmtShort = (s?: string | null) => (s ? toDate(s).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");
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
function WebLinks({ companyId, website, linkedin, onSaved, readOnly = false }: {
  companyId: string; website: string; linkedin: string;
  onSaved: (patch: { website: string | null; linkedin: string | null }) => void;
  /** Without the right to change the company: only the links. */
  readOnly?: boolean;
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
        {!readOnly && (
          <button className="cw-web-edit" onClick={() => setEdit(true)}>
            <Ico n="edit" s={13} />{website || linkedin ? "Edit links" : "Add website & LinkedIn"}
          </button>
        )}
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
const plain = (body: string) => mentionsToPlain(body);
const reduceMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const cssVars = (o: Record<string, string | number>) => o as React.CSSProperties;

/** Render a note body, turning "@[name](id)" tokens into mention pills. */
function renderNoteBody(body: string): React.ReactNode {
  return <MentionText text={body} />;
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
/** The payment terms of a line (null = paid as one block, no increases). */
const scheduleOf = (l: Line): PaymentSchedule | null => {
  const sc = l.schedule;
  if (!sc || typeof sc !== "object" || !(Number(sc.count) > 0)) return null;
  return { count: Math.round(Number(sc.count)), increases: Array.isArray(sc.increases) ? sc.increases.map((x: unknown) => Number(x) || 0) : [] };
};
/** A recurring line's first contract year, as signed: the year-1 amount the deal worked out (breakdown.years[0]),
 *  else its price per period × periods a year. Year 1 only: the increases of later years come on top. */
const firstYearOf = (l: Line) => {
  const y0 = Number(Array.isArray(l.breakdown?.years) ? l.breakdown.years[0] : NaN);
  const term = Number(l.term_years) || 1;
  // a contract shorter than a year keeps only part of year 1 in the breakdown: not a year's rate
  if (Number.isFinite(y0) && y0 > 0 && term >= 1) return y0;
  return lineTotal(l) * perYear(l.period);
};
/** Which contract year a line is in on `at` (0 = the first; after the term it stays on the last one). */
const contractYearOf = (l: Line, at = Date.now()) => {
  const s0 = str(l.start_date) || str(l.signing_date);
  if (!s0) return 0;
  const el = (at - toDate(s0).getTime()) / (365.25 * DAY);
  return Number.isFinite(el) && el > 0 ? Math.floor(el + 1e-9) : 0;
};
/** How much a recurring line's price has gone up by contract year `y`: its payment terms' increases
 *  (one term per year, or longer terms), else the yearly % — never past the contract's last year. */
const increaseBy = (l: Line, y: number) => {
  const term = Number(l.term_years) || 1;
  const sc = scheduleOf(l);
  if (sc && sc.count > 1) {
    const len = term / sc.count;
    const k = Math.min(sc.count - 1, Math.floor(y / len + 1e-9));
    let m = 1;
    for (let i = 0; i <= k; i++) m *= 1 + (sc.increases[i] ?? 0) / 100;
    return m;
  }
  const pct = Number(l.annual_increase_pct) || 0;
  if (!sc && pct && term > 1) return Math.pow(1 + pct / 100, Math.min(y, Math.ceil(term - 1e-9) - 1));
  return 1;
};
/** What the partner takes from a line in contract year `y` (0 = the first): once, or year by year, as set in the
 *  deal's calculator (breakdown.partnerYears); nothing for lines signed before that was kept. */
const partnerCut = (l: Line, y: number) => {
  const py = l.breakdown?.partnerYears;
  return Array.isArray(py) ? Math.max(0, Number(py[y]) || 0) : 0;
};
const partnerTotal = (l: Line) => (Array.isArray(l.breakdown?.partnerYears) ? (l.breakdown.partnerYears as unknown[]).reduce((t: number, x) => t + Math.max(0, Number(x) || 0), 0) : 0);
/** Is a line running on `at`: started, and its term not over (an auto-renewing one rolls on). */
const runsAt = (l: Line, at = Date.now()) => {
  const s0 = str(l.start_date) || str(l.signing_date);
  if (s0 && toDate(s0).getTime() > at) return false;
  const t = termOf(l);
  return !t || t.end.getTime() >= at;
};
/** What a recurring line is billing a year right now — always as of today: year 1 at the signed price, year 2 with
 *  its increase…, less what the partner takes that year. Nothing before it starts or once its term is over (a renewal
 *  signed as a new line takes over then, so the two never add up). One-offs and set-up fees aren't recurring. */
const lineAnnual = (l: Line, at = Date.now()) => {
  if (!l.recurring || !runsAt(l, at)) return 0;
  const y = contractYearOf(l, at);
  return Math.max(0, firstYearOf(l) * increaseBy(l, y) - partnerCut(l, y));
};
/** Each term of a recurring line: its length, its price per period (with the increases so far) and what it adds up to. */
const termsOf = (l: Line, sc: PaymentSchedule | null = scheduleOf(l)) => {
  const years = Number(l.term_years) || 1;
  const count = sc?.count ?? 1;
  const len = years / count;
  const unit = firstYearOf(l) / perYear(l.period);
  let mult = 1;
  return Array.from({ length: count }, (_, i) => {
    mult *= 1 + (sc?.increases[i] ?? 0) / 100;
    const u = unit * mult;
    return { i, len, from: i * len, inc: sc?.increases[i] ?? 0, unit: u, amount: u * perYear(l.period) * len };
  });
};
/** What a signed product is worth over its contract: every term of a recurring line (1 year when no term), or the one-off price, plus the set-up fee. */
export const lineContractValue = (l: Line) => Math.max(0, (l.recurring ? termsOf(l).reduce((t, x) => t + x.amount, 0) : lineTotal(l)) - partnerTotal(l)) + (Number(l.one_time_fee) || 0);
/** What a line bills once: a one-off's price (less the partner's cut) and any set-up fee. */
export const lineOneTime = (l: Line) => (l.recurring ? 0 : Math.max(0, lineTotal(l) - partnerTotal(l))) + (Number(l.one_time_fee) || 0);
export { lineAnnual, lineTotal };
/** The contract a line belongs to: the deal it was signed on, or the existing contract an upsell was signed into (122). */
export const contractKeyOf = (l: Line) => str(l.contract_tracking_id) || str(l.tracking_id);
/** Whole contract years between a contract's start and a line's own start (an upsell joins in a later year). */
const yearOffsetOf = (l: Line, start: Date | null) => {
  const s = str(l.start_date) || str(l.signing_date);
  if (!start || !s) return 0;
  return Math.max(0, Math.floor((toDate(s).getTime() - start.getTime()) / (365.2425 * 86400000) + 1e-6));
};
/** How many contract years a line runs (a one-off: 1). */
const yearsOf = (l: Line) => (l.recurring ? Math.max(1, Math.ceil((Number(l.term_years) || 1) - 1e-9)) : 1);
/** What the client pays for a line in contract year `y` (0 = the first), before the partner's cut. */
export const lineYearGross = (l: Line, y: number) => {
  const fee = y === 0 ? Number(l.one_time_fee) || 0 : 0;
  if (!l.recurring) return y === 0 ? lineTotal(l) + fee : 0;
  if (y >= yearsOf(l)) return 0;
  return firstYearOf(l) * increaseBy(l, y) + fee;
};
/** What a line is billing a year right now before the partner's cut (0 when it isn't running). */
const lineAnnualGross = (l: Line, at = Date.now()) => (l.recurring && runsAt(l, at) ? firstYearOf(l) * increaseBy(l, contractYearOf(l, at)) : 0);
/** The partner on a deal's product line (tracking_products): who, and how much they take. */
interface DealPart { partner: string | null; mode: string | null; value: number; once: boolean }
/** Rebuild what a recurring line pays each year and the partner's share of it, after its price or term changed. */
function rebuildYears(l: Line, partner: { mode: "none" | "percent" | "amount" | "once"; value: number }) {
  const n = yearsOf(l);
  const years = Array.from({ length: n }, (_, y) => Math.round(firstYearOf({ ...l, breakdown: null }) * increaseBy(l, y) * 100) / 100);
  const v = Math.max(0, Number(partner.value) || 0);
  const partnerYears = years.map((amt, y) => partner.mode === "percent" ? Math.round(amt * Math.min(v, 100)) / 100
    : partner.mode === "amount" ? Math.min(v, amt)
      : partner.mode === "once" ? (y === 0 ? Math.min(v, years.reduce((a, b) => a + b, 0)) : 0) : 0);
  return { years, partnerYears, total: Math.round(years.reduce((a, b) => a + b, 0) * 100) / 100 };
}
/** How the partner's share of a line reads back for its editor: a % of every year, an amount a year, or once. */
function partnerModeOf(l: Line): { mode: "none" | "percent" | "amount" | "once"; value: number } {
  const py = Array.isArray(l.breakdown?.partnerYears) ? (l.breakdown.partnerYears as unknown[]).map((x) => Number(x) || 0) : [];
  const ys = Array.isArray(l.breakdown?.years) ? (l.breakdown.years as unknown[]).map((x) => Number(x) || 0) : [];
  if (!py.some((x) => x > 0)) return { mode: "none", value: 0 };
  if (py.length > 1 && py.slice(1).every((x) => !x)) return { mode: "once", value: py[0] };
  const pct = ys[0] ? Math.round((py[0] / ys[0]) * 1000) / 10 : 0;
  if (ys.length === py.length && py.every((x, i) => Math.abs(x - (ys[i] * pct) / 100) < 1)) return { mode: "percent", value: pct };
  return { mode: "amount", value: py[0] };
}
/** Running: an active status, and not past the day it was set to stop on (a churned client's contract end, 121). */
export const isActive = (l: Line) => (!l.status || /active|signed|live/i.test(String(l.status))) && !(l.ends_on && String(l.ends_on) <= todayISO());
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
/** When a signed product starts: its own start, else its signing date, else its contract's (the deal's order form). */
export const lineStartOf = (l: Line, ct?: any) => str(l.start_date) || str(l.signing_date) || str(ct?.contractStart) || str(ct?.signDate);
/** A signed product's term, filled in from its contract when the product itself doesn't carry the start or the years. */
export function termWith(l: Line, ct?: any) {
  const own = termOf(l);
  if (own || !ct) return own;
  const s = lineStartOf(l, ct);
  const y = Number(l.term_years) || Number(ct.termYears) || 0;
  if (!s || !y) return null;
  return termOf({ ...l, start_date: s, term_years: y, auto_renew: !!l.auto_renew || !!ct.autoRenew, renew_years: Number(l.renew_years) || Number(ct.renewYears) || null } as Line);
}
/** A signed product's next renewal — its own term, else its contract's, else (a subscription) its yearly anniversary.
    The one rule for the client page, the Clients list and Customer success (and the renewal e-mails). */
export function renewalOf(l: Line, ct?: any): { end: Date; left: number; kind: "term" | "deal" | "anniversary" } | null {
  if (!isActive(l)) return null;
  const t = termWith(l, ct);
  if (t) return t.left >= 0 ? { end: t.end, left: t.left, kind: termOf(l) ? "term" : "deal" } : null;
  const s = lineStartOf(l, ct);
  if (!s || !l.recurring) return null;
  let end = addYears(toDate(s), 1);
  for (let n = 0; end.getTime() < Date.now() && n < 80; n++) end = addYears(end, 1);
  return { end, left: Math.ceil((end.getTime() - Date.now()) / DAY), kind: "anniversary" };
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
  din: "M17 7L7 17M7 17h9M7 17V8",
  dout: "M7 17L17 7M17 7H8M17 7v9",
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
  calc: "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM8 6h8v4H8zM8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18v.01",
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
  filter: "M22 3H2l8 9.46V19l4 2v-8.54z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
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

/** A labelled field of the inline editors. */
function Fld({ label, wide, span, children }: { label: string; wide?: boolean; span?: number; children: React.ReactNode }) {
  return <label className={`cw-f ${wide ? "is-wide" : ""}`} style={span ? { gridColumn: `span ${span}` } : undefined}><span>{label}</span>{children}</label>;
}
function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} className={`cw-tg ${on ? "is-on" : ""}`} onClick={onClick}><i />{label}</button>;
}
const fmtMY = (d: Date) => d.toLocaleDateString(undefined, { month: "short", year: "numeric" });

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
                  <NumInput inputMode="decimal" value={inc ? String(inc) : ""} placeholder="0" disabled={i === 0 && !inc} onChange={(e) => setInc(i, e.target.value)} />
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

function AddLineForm({ clientId, persons, contracts = [], onCancel, onSaved }: {
  clientId: string; persons: Person[];
  /** The client's contracts: an upsell can be signed into one instead of standing as a contract of its own. */
  contracts?: { tid: string; name: string }[];
  onCancel: () => void; onSaved: () => void | Promise<void>;
}) {
  const [inContract, setInContract] = useState("");
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
      contractTrackingId: inContract || null,
    }]);
    setBusy(false);
    if (e) { setErr(e); return; }
    await onSaved();
  };
  return (
    <div className="cw-logform cw-addl">
      <div className="cw-addl-grid">
        {contracts.length > 0 && (
          <label className="is-wide"><span>Contract</span>
            <Select value={inContract} onChange={setInContract}
              options={[{ value: "", label: "A contract of its own" }, ...contracts.map((c) => ({ value: c.tid, label: `Upsell into ${c.name}`, hint: "Adds to that contract" }))]} />
          </label>
        )}
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

/**
 * Active or lost (churned): a chip that opens a small menu. Losing a client asks when and why,
 * and can stop its running products so they stop counting as recurring revenue.
 */
export function ClientStatusPicker({ status, churnedAt, reason, running = 0, canEdit, onSave, size = "md" }: {
  status?: ClientStatus; churnedAt?: string | null; reason?: string | null; running?: number; canEdit: boolean;
  onSave: (status: ClientStatus, opts: { at?: string | null; reason?: string | null; stopProducts?: boolean }) => Promise<string | null>;
  size?: "sm" | "md";
}) {
  const st: ClientStatus = status === "churned" ? "churned" : "active";
  /** Churned on a later day (the contract's end): still active until then. */
  const leaving = st === "active" && !!churnedAt && churnedAt > todayISO();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [step, setStep] = useState<"menu" | "churn">("menu");
  const [at, setAt] = useState(todayISO());
  const [why, setWhy] = useState("");
  const [stop, setStop] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r) return;
      const w = 300, h = pop.current?.offsetHeight ?? 220;
      const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left));
      const below = r.bottom + 6 + h <= window.innerHeight - 12;
      setPos({ left, top: below ? r.bottom + 6 : Math.max(12, r.top - 6 - h) });
    };
    place();
    const t = window.setTimeout(place, 0);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.clearTimeout(t); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, step]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      // the date picker's calendar opens in a layer of its own (changing month included)
      if (pop.current?.contains(t) || btn.current?.contains(t) || (t as HTMLElement).closest?.(".dp-layer, .dp-pop, .sel-pop, .sel-layer")) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down, true); window.removeEventListener("keydown", key, true); };
  }, [open]);
  const save = async (next: ClientStatus) => {
    setBusy(true); setErr(null);
    const e = await onSave(next, next === "churned" ? { at, reason: why, stopProducts: stop && running > 0 } : {});
    setBusy(false);
    if (e) { setErr(e); return; }
    setOpen(false);
  };
  const title = st === "churned" ? `Churned${churnedAt ? ` on ${fmt(churnedAt)}` : ""}${reason ? ` · ${reason}` : ""}`
    : leaving ? `Active until ${fmt(churnedAt)} — churns then${reason ? ` · ${reason}` : ""}` : "Active client";
  const later = at > todayISO();
  return (
    <>
      <button ref={btn} type="button" className={`cw-cst is-${st} ${leaving ? "is-leaving" : ""} is-${size} ${canEdit ? "" : "is-ro"}`} title={canEdit ? `${title} · change` : title}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); if (!canEdit) return; setStep("menu"); setErr(null); setAt(leaving && churnedAt ? churnedAt : todayISO()); setWhy(reason ?? ""); setStop(true); setOpen((o) => !o); }}>
        <i />{st === "churned" ? "Churned" : leaving ? (size === "sm" ? "Leaving" : `Leaves ${fmtShort(churnedAt)}`) : "Active"}{canEdit && <Ico n="chev" s={11} />}
      </button>
      {open && createPortal(
        <div ref={pop} className="cw-cst-pop" style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Client status">
          {step === "menu" ? (
            <>
              <button type="button" className={`cw-cst-opt is-active ${st === "active" && !leaving ? "is-on" : ""}`} disabled={busy} onClick={() => (st === "active" && !leaving ? setOpen(false) : void save("active"))}>
                <i /><span><b>Active</b><small>{leaving ? "Keep them: cancel the churn" : "A client we work with"}</small></span>{st === "active" && !leaving && <Ico n="check" s={14} />}
              </button>
              <button type="button" className={`cw-cst-opt is-churned ${st === "churned" || leaving ? "is-on" : ""}`} disabled={busy} onClick={() => setStep("churn")}>
                <i /><span><b>Churned</b><small>{st === "churned" && churnedAt ? `Since ${fmt(churnedAt)} · change` : leaving ? `On ${fmt(churnedAt)} (contract end) · change` : "We lost them, or the contract ends on a day"}</small></span>{(st === "churned" || leaving) && <Ico n="check" s={14} />}
              </button>
            </>
          ) : (
            <div className="cw-cst-form">
              <b className="cw-cst-h">{st === "churned" || leaving ? "Churn" : "Mark as churned"}</b>
              <label><span>{later ? "Contract ends on" : "Lost on"}</span><span className="cw-date"><DatePicker value={at} onChange={(d) => setAt(d || todayISO())} /></span></label>
              {later && <p className="cw-cst-note">Stays active until then and turns churned on that day.</p>}
              <label><span>Why</span><input value={why} autoFocus placeholder="e.g. Moved to another tool" onChange={(e) => setWhy(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) void save("churned"); }} /></label>
              {running > 0 && (
                <button type="button" className={`cw-cst-check ${stop ? "is-on" : ""}`} onClick={() => setStop(!stop)}>
                  <i>{stop && <Ico n="check" s={11} />}</i>{later
                    ? <>Stop its {running} running product{running === 1 ? "" : "s"} on {fmt(at)} (counted as recurring until then)</>
                    : <>Stop its {running} running product{running === 1 ? "" : "s"} (no longer counted as recurring)</>}
                </button>
              )}
              <div className="cw-cst-foot">
                <button type="button" className="cw-ghost" onClick={() => setStep("menu")}>Back</button>
                <button type="button" className="cw-btn-primary is-sm is-red" disabled={busy} onClick={() => void save("churned")}>{busy ? "Saving…" : later ? "Churn on that day" : "Mark churned"}</button>
              </div>
            </div>
          )}
          {err && <p className="cw-err">{err}</p>}
        </div>,
        document.body,
      )}
    </>
  );
}

export default function ClientWorkspace({
  client, projects, projectTypes, usage, lineUsage, roles = [], onOpenProject, onNewProject, onDeleteProject, onLinesChanged, onSetStatus, onClose, focus,
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
  /** The contracts signed with the deals behind these products (set on the deal's contract panel). */
  const [dealContracts, setDealContracts] = useState<Record<string, ContractTerms>>({});
  const contractDealKey = Array.from(new Set(lines.map((l) => String(l.tracking_id ?? "")).filter(Boolean))).sort().join(",");
  useEffect(() => {
    if (!contractDealKey) { setDealContracts({}); return; }
    let alive = true;
    loadDealContracts(contractDealKey.split(",")).then((x) => { if (alive) setDealContracts(x); }).catch(() => {});
    return () => { alive = false; };
  }, [contractDealKey]);
  /** The partner on each of the deals' product lines, by "deal|product". */
  const [dealParts, setDealParts] = useState<Record<string, DealPart>>({});
  const can = useClientEdit();
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
  const [logDir, setLogDir] = useState<"out" | "in">("out");
  const [logWhy, setLogWhy] = useState("");
  const [logDate, setLogDate] = useState(todayISO());
  const [logBusy, setLogBusy] = useState(false);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [projFilter, setProjFilter] = useState<"all" | "open" | "on_hold" | "closed">("all");
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
        // who the partner is on each product sold, and what they take
        void supabase.from("tracking_products").select("tracking_id, product_id, partner_id, partner_mode, partner_value, partner_periods, version_active").in("tracking_id", ids)
          .then(async ({ data, error }) => {
            if (!alive || error) return;
            const rows = ((data ?? []) as any[]).filter((r) => r.partner_id && Number(r.partner_value));
            const pids = [...new Set(rows.map((r) => r.partner_id))];
            const names = new Map<string, string>();
            if (pids.length) ((await supabase.from("companies").select("id, name").in("id", pids)).data ?? []).forEach((c: any) => names.set(c.id, c.name));
            if (!alive) return;
            const out: Record<string, DealPart> = {};
            rows.sort((a, b) => Number(!!a.version_active) - Number(!!b.version_active)).forEach((r) => {
              out[`${r.tracking_id}|${r.product_id}`] = {
                partner: names.get(r.partner_id) ?? null, mode: r.partner_mode ?? null, value: Number(r.partner_value) || 0,
                once: r.partner_periods ? r.partner_periods.mode === "once" : r.partner_mode === "amount",
              };
            });
            setDealParts(out);
          });
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
  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";
  const mentionPeople: MentionPerson[] = useMemo(
    () => Object.entries(people).map(([id, name]) => ({ id: `employee:${id}`, name, kind: "employee" as const })),
    [people]);
  useEffect(() => { registerMentionNames(people); }, [people]);

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
      who: l.contact_name || (l.logged_by ? "Their team" : "—"), why: l.reason || "Contact logged",
      dir: l.direction === "in" ? "in" : "out", source: l.source ?? null, us: l.logged_by ? people[l.logged_by] ?? "" : "",
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
  const oneTime = lines.reduce((s, l) => s + lineOneTime(l), 0);
  /** What the sale signed: recurring lines for their whole term (1 year when none), one-offs and set-up fees. */
  const lineContract = lineContractValue;
  const contractValue = activeLines.reduce((s, l) => s + lineContract(l), 0);
  const openProjects = projects.filter((p) => projectStatusOf(p.status) === "open");
  const openValue = openProjects.reduce((s, p) => s + projectValue(p), 0);
  const nextRenewal = activeLines.map((l) => renewalOf(l, dealContracts[contractKeyOf(l)]))
    .filter((t): t is NonNullable<ReturnType<typeof renewalOf>> => !!t).sort((a, b) => a.end.getTime() - b.end.getTime())[0] ?? null;
  /** The same, before the partners take their share: what the client itself pays. */
  const grossYear = activeLines.reduce((s, l) => s + lineAnnualGross(l), 0);
  const partnerYearNow = Math.max(0, grossYear - recurringYear);
  const contractGross = activeLines.reduce((s, l) => s + lineContractValue(l) + partnerTotal(l), 0);
  const partnerAll = contractGross - contractValue;
  const partOf = (l: Line): DealPart | null => dealParts[`${str(l.tracking_id)}|${str(l.product_id)}`] ?? null;
  /** "Partner · 30% of every year", "Partner · 637 € once"… — from the line's own split, named from the deal. */
  const partnerText = (l: Line) => {
    const m = partnerModeOf(l);
    if (m.mode === "none") return "";
    const who = partOf(l)?.partner ?? "Partner";
    return `${who}, ${m.mode === "percent" ? `${d2(m.value)}% of every year` : m.mode === "once" ? `${eur(m.value)} once` : `${eur(m.value)} a year`}`;
  };

  /** One contract per deal: its order form (if sales saved one) and the products it signed here. */
  const contractGroups = useMemo(() => {
    // an upsell deal whose products were all signed into another contract isn't a contract of its own
    const merged = new Set(lines.filter((l) => str(l.contract_tracking_id) && str(l.tracking_id) && str(l.contract_tracking_id) !== str(l.tracking_id)).map((l) => str(l.tracking_id)));
    const keys = Array.from(new Set([...Object.keys(dealContracts), ...lines.map(contractKeyOf).filter(Boolean)]));
    return keys.map((tid) => ({ tid, ct: dealContracts[tid] ?? null, lines: lines.filter((l) => contractKeyOf(l) === tid) }))
      .filter((g) => g.lines.length || (g.ct && !merged.has(g.tid)))
      .sort((a, b) => str(b.ct?.signDate || b.lines[0]?.signing_date).localeCompare(str(a.ct?.signDate || a.lines[0]?.signing_date)));
  }, [dealContracts, lines]);
  const handLines = lines.filter((l) => !contractKeyOf(l));
  /** Puts a product (or a whole upsell deal) into an existing contract, or back on its own (null). */
  const [mvBusy, setMvBusy] = useState<string | null>(null);
  const moveToContract = async (ls: Line[], into: string | null) => {
    setMvBusy(ls[0]?.id ?? null);
    for (const l of ls) {
      const v = into && into !== str(l.tracking_id) ? into : null;
      const { error } = await supabase.from("client_products").update({ contract_tracking_id: v }).eq("id", l.id);
      if (error) { setMvBusy(null); window.alert(/contract_tracking_id/i.test(error.message) ? "Run 122_upsell_in_contract.sql in Supabase first." : error.message); return; }
    }
    setMvBusy(null);
    await reloadLines();
    onLinesChanged?.();
  };
  // arriving for one contract (from a report row): its section, once everything has loaded
  const focused = useRef(false);

  /* ---- editing: a contract, a signed product, a deal (Settings › Client page › Editing rights) ---- */
  const [ctEdit, setCtEdit] = useState<{ tid: string; v: Record<string, any> } | null>(null);
  const [ctBusy, setCtBusy] = useState(false);
  const [ctErr, setCtErr] = useState<string | null>(null);
  const [lnEdit, setLnEdit] = useState<{ id: string; v: Record<string, any> } | null>(null);
  /* The deal's calculator for a signed product (Settings › Client page › Editing rights › Deal calculator):
     change the figures it was valued with (users, entities…) on its deal, and the product is repriced here. */
  const [calcCat, setCalcCat] = useState<CatalogProduct[] | null>(null);
  const [calcLn, setCalcLn] = useState<{ line: Line; tp: TrackingProduct; prod: CatalogProduct } | null>(null);
  const [calcMsg, setCalcMsg] = useState<{ id: string; text: string; bad?: boolean } | null>(null);
  const canValue = can("valuation");
  useEffect(() => { if (canValue && !calcCat) loadProducts().then(setCalcCat).catch(() => setCalcCat([])); }, [canValue]); // eslint-disable-line react-hooks/exhaustive-deps
  const calcProdOf = (l: Line) => (l.tracking_id ? calcCat?.find((p) => p.id === l.product_id && !!p.calculator) : undefined);
  const openCalc = async (l: Line, siblings: Line[]) => {
    const prod = calcProdOf(l);
    if (!prod || !l.tracking_id) return;
    setCalcMsg(null);
    const tps = (await loadTrackingProducts(l.tracking_id).catch(() => [] as TrackingProduct[])).filter((t) => t.product_id === l.product_id);
    // the same product twice on one deal: the line's place among its twins here
    const twin = siblings.filter((x) => x.tracking_id === l.tracking_id && x.product_id === l.product_id).findIndex((x) => x.id === l.id);
    const tp = tps[Math.max(0, twin)] ?? tps[0];
    if (!tp) { setCalcMsg({ id: l.id, text: "This product isn't on its deal any more, so there is no valuation to change.", bad: true }); return; }
    setCalcLn({ line: l, tp, prod });
  };
  const applyCalc = async (patch: TermPatch) => {
    if (!calcLn) return;
    const { line: l, tp, prod } = calcLn;
    const next = { ...tp, ...patch } as TrackingProduct;
    const e1 = await updateTrackingProduct(tp.id, String(l.tracking_id), patch);
    if (e1) { setCalcMsg({ id: l.id, text: `The deal wasn't updated: ${e1}`, bad: true }); return; }
    const bd = lineBreakdown(next, prod.calculator as any, prod.tiers?.find((x) => x.id === next.tier_id)?.price);
    const years = Number(next.term_years) || Number(l.term_years) || 1;
    const row: Record<string, any> = {
      price: Math.round(bd.unitPrice * 100) / 100, quantity: next.recurring ? 1 : bd.qty, discount_mode: "none", discount_value: 0,
      breakdown: {
        ...(l.breakdown ?? {}), multiplier: bd.multiplierLabel, gross: bd.gross, discount: bd.discount, total: bd.total,
        rows: bd.rows.map((r) => ({ label: r.label, detail: r.detail, amount: r.amount, discount: r.discount })),
        years: bd.years, partnerYears: bd.partnerYears, edited: false, revalued: new Date().toISOString(),
      },
    };
    if (l.recurring) {
      // the price is per the deal line's period (as when the deal was handed over)
      row.period = next.period === "monthly" ? "monthly" : "yearly";
      row.term_years = years;
      row.schedule = incrementsToSchedule(bd.years[0] ?? 0, years, next.increments);
    }
    let { error } = await supabase.from("client_products").update(row).eq("id", l.id);
    if (error && /schedule/i.test(error.message)) { delete row.schedule; ({ error } = await supabase.from("client_products").update(row).eq("id", l.id)); }
    if (error) { setCalcMsg({ id: l.id, text: error.message, bad: true }); return; }
    setCalcMsg({ id: l.id, text: `Revalued: ${eur(l.recurring ? bd.years[0] ?? bd.total : bd.total)}${l.recurring ? " the first year" : ""} — on the deal too.` });
    await reloadLines();
    onLinesChanged?.();
  };
  const [lnBusy, setLnBusy] = useState(false);
  const [lnErr, setLnErr] = useState<string | null>(null);
  const [lnOpen, setLnOpen] = useState<Set<string>>(new Set());
  const [dlEdit, setDlEdit] = useState<{ id: string; v: Record<string, any> } | null>(null);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlErr, setDlErr] = useState<string | null>(null);
  /** The contracts whose order form (scope, parties, terms) is open. */
  const [ofOpen, setOfOpen] = useState<Set<string>>(new Set());
  const toggleOf = (id: string) => setOfOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleLn = (id: string) => setLnOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const startCtEdit = (tid: string, ct: ContractTerms | null, gl: Line[]) => {
    const l0 = gl[0] ?? {} as Line;
    setCtErr(null);
    setCtEdit({ tid, v: {
      signDate: str(ct?.signDate) || str(l0.signing_date), contractStart: str(ct?.contractStart) || str(l0.start_date),
      termYears: String(ct?.termYears || l0.term_years || ""), autoRenew: ct?.autoRenew ?? !!l0.auto_renew,
      renewYears: String(ct?.renewYears ?? l0.renew_years ?? ""), nonTerminableYears: String(ct?.nonTerminableYears ?? l0.non_terminable_years ?? ""),
      paymentTermsDays: String(ct?.paymentTermsDays ?? l0.payment_terms_days ?? ""), billingFrequency: str(ct?.billingFrequency) || "annually",
      contractRef: str(ct?.contractRef) || str(l0.contract_ref), currency: str(ct?.currency) || "EUR", notes: str(ct?.notes),
    } });
  };
  const num = (v: unknown) => (str(v) === "" ? null : Number(String(v).replace(",", ".")));
  const saveCtEdit = async (ct: ContractTerms | null, gl: Line[]) => {
    if (!ctEdit) return;
    const v = ctEdit.v;
    const termYears = num(v.termYears);
    if (termYears != null && !(termYears > 0)) { setCtErr("The term has to be more than 0 years."); return; }
    setCtBusy(true); setCtErr(null);
    // the products of the deal: dates, renewals, payment, reference — and the term, rebuilding each year's amount
    for (const l of gl) {
      const row: Record<string, any> = {
        signing_date: v.signDate || null, start_date: v.contractStart || v.signDate || null,
        non_terminable_years: num(v.nonTerminableYears), payment_terms_days: num(v.paymentTermsDays), contract_ref: str(v.contractRef) || null,
      };
      if (l.recurring) {
        row.auto_renew = !!v.autoRenew; row.renew_years = v.autoRenew ? num(v.renewYears) ?? termYears : null;
        if (termYears != null && termYears !== Number(l.term_years)) {
          row.term_years = termYears;
          const next = { ...l, term_years: termYears };
          const b = rebuildYears({ ...next, quantity: 1, price: firstYearOf(l) / perYear(l.period), discount_mode: "none", discount_value: 0 }, partnerModeOf(l));
          row.breakdown = { ...(l.breakdown ?? {}), years: b.years, partnerYears: b.partnerYears, total: b.total };
        }
      }
      const { error } = await supabase.from("client_products").update(row).eq("id", l.id);
      if (error) { setCtBusy(false); setCtErr(error.message); return; }
    }
    // the order form on the deal
    const base: ContractTerms = ct ?? {
      signDate: null, contractStart: null, termYears: termYears ?? 1, increments: { mode: "none", value: 0, perYear: [] },
      license: { list: 0, discount: 0, final: 0, firstYear: 0 }, services: { list: 0, discount: 0, final: 0 }, schedule: [], total: 0,
    } as ContractTerms;
    const terms: ContractTerms = {
      ...base, signDate: v.signDate || null, contractStart: v.contractStart || null, termYears: termYears ?? base.termYears,
      autoRenew: !!v.autoRenew, renewYears: v.autoRenew ? num(v.renewYears) : null, nonTerminableYears: num(v.nonTerminableYears),
      paymentTermsDays: num(v.paymentTermsDays), billingFrequency: str(v.billingFrequency) || null, contractRef: str(v.contractRef) || null,
      currency: str(v.currency) || null, notes: str(v.notes) || null,
    };
    const e = ctEdit.tid ? await saveDealContract(ctEdit.tid, terms) : null;
    setCtBusy(false);
    if (e) { setCtErr(e); return; }
    if (ctEdit.tid) setDealContracts((m) => ({ ...m, [ctEdit.tid]: terms }));
    setCtEdit(null);
    await reloadLines();
    onLinesChanged?.();
  };

  const startLnEdit = (l: Line) => {
    const pm = partnerModeOf(l);
    setLnErr(null);
    setLnEdit({ id: l.id, v: {
      status: str(l.status) || "active", billing: l.recurring ? (perYear(l.period) === 12 ? "monthly" : "yearly") : "once",
      amount: String(Math.round(lineTotal(l) * 100) / 100), fee: String(Number(l.one_time_fee) || ""),
      signing: str(l.signing_date), start: str(l.start_date), term: String(l.term_years ?? ""), inc: String(l.annual_increase_pct ?? ""),
      autoRenew: !!l.auto_renew, renew: String(l.renew_years ?? ""), nonTerm: String(l.non_terminable_years ?? ""),
      pay: String(l.payment_terms_days ?? ""), ref: str(l.contract_ref), pMode: pm.mode, pValue: pm.mode === "none" ? "" : String(Math.round(pm.value * 100) / 100),
      contract: str(l.contract_tracking_id) && str(l.contract_tracking_id) !== str(l.tracking_id) ? str(l.contract_tracking_id) : "",
    } });
  };
  const saveLnEdit = async (l: Line) => {
    if (!lnEdit) return;
    const v = lnEdit.v;
    const amount = num(v.amount) ?? 0;
    if (!(amount >= 0)) { setLnErr("The price isn't a number."); return; }
    const recurring = v.billing !== "once";
    const period = v.billing === "monthly" ? "monthly" : "yearly";
    const term = recurring ? num(v.term) : 1;
    const inc = num(v.inc);
    const row: Record<string, any> = {
      status: v.status || "active", recurring, period, price: amount, quantity: 1, discount_mode: "none", discount_value: 0,
      one_time_fee: num(v.fee) ?? 0, signing_date: v.signing || null, start_date: v.start || v.signing || null,
      term_years: term, annual_increase_pct: recurring ? inc : null,
      auto_renew: recurring && !!v.autoRenew, renew_years: recurring && v.autoRenew ? num(v.renew) ?? term : null,
      non_terminable_years: num(v.nonTerm), payment_terms_days: num(v.pay), contract_ref: str(v.ref) || null,
    };
    const next = { ...l, ...row } as Line;
    const pm = { mode: v.pMode as "none" | "percent" | "amount" | "once", value: num(v.pValue) ?? 0 };
    const was = partnerModeOf(l);
    const priceSame = Math.abs(amount - lineTotal(l)) < 0.005 && recurring === !!l.recurring && perYear(period) === perYear(l.period);
    const termSame = Number(term ?? 0) === Number(l.term_years ?? 0) && Number(inc ?? 0) === Number(l.annual_increase_pct ?? 0);
    const partnerSame = pm.mode === was.mode && Math.abs(pm.value - was.value) < 0.01;
    if (!(priceSame && termSame && partnerSame)) {
      if (recurring) {
        const b = rebuildYears(next, pm);
        row.breakdown = { ...(priceSame ? l.breakdown ?? {} : { multiplier: l.breakdown?.multiplier ?? null }), years: b.years, partnerYears: b.partnerYears, total: b.total, edited: true };
      } else {
        const v1 = Math.max(0, pm.value);
        const cut = pm.mode === "percent" ? Math.round(amount * Math.min(v1, 100)) / 100 : pm.mode === "none" ? 0 : Math.min(v1, amount);
        row.breakdown = { ...(priceSame ? l.breakdown ?? {} : {}), years: [amount], partnerYears: [cut], total: amount, edited: true };
      }
    }
    // an upsell signed into an existing contract (122)
    const into = str(v.contract) && str(v.contract) !== str(l.tracking_id) ? str(v.contract) : null;
    if (into !== (str(l.contract_tracking_id) || null)) row.contract_tracking_id = into;
    setLnBusy(true); setLnErr(null);
    let { error } = await supabase.from("client_products").update(row).eq("id", l.id);
    if (error && /contract_tracking_id/i.test(error.message)) { setLnBusy(false); setLnErr("Run 122_upsell_in_contract.sql in Supabase first."); return; }
    if (error && /breakdown/i.test(error.message)) { delete row.breakdown; ({ error } = await supabase.from("client_products").update(row).eq("id", l.id)); }
    setLnBusy(false);
    if (error) { setLnErr(error.message); return; }
    setLnEdit(null);
    await reloadLines();
    onLinesChanged?.();
  };

  const saveDlEdit = async () => {
    if (!dlEdit) return;
    const v = dlEdit.v;
    if (!str(v.name)) { setDlErr("Give the deal a name."); return; }
    setDlBusy(true); setDlErr(null);
    const row = { deal_name: str(v.name), status: v.status || "active", close_date: v.close || null, product_price: num(v.value) };
    const { error } = await supabase.from("trackings").update(row).eq("id", dlEdit.id);
    setDlBusy(false);
    if (error) { setDlErr(error.message); return; }
    setDeals((xs) => xs.map((d) => (d.id === dlEdit.id ? { ...d, name: row.deal_name, status: row.status, close_date: row.close_date, price: row.product_price } : d)));
    setDlEdit(null);
  };

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
    // no contract, no project: what they signed comes first
    { v: "contract", label: "Contracts", icon: "contract", hint: "What they signed", n: lines.length || undefined },
    { v: "projects", label: "Projects", icon: "briefcase", hint: "Services delivered", n: projects.length || undefined },
    { v: "upsells", label: "Upsells", icon: "spark", hint: "What else they could buy" },
    { v: "tickets", label: "Tickets", icon: "tasks", hint: "Their requests and incidents" },
    { v: "emails", label: "Emails", icon: "mail", hint: "What their people wrote" },
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
      ...(contractGroups.length ? [{ k: "contracts", label: contractGroups.length === 1 ? "Contract" : "Contracts", n: contractGroups.length > 1 ? contractGroups.length : undefined }] : []),
      { k: "products", label: "Signed products", n: lines.length || undefined }, { k: "services", label: "Service engagements", n: projects.length || undefined },
    ],
    upsells: [],
    tickets: [],
    emails: [],
    folders: [],
  };
  const subs = SUBS[tab];
  /** Which way the page moves when you switch: down the menu slides up, up the menu slides down. */
  const prevTab = useRef(tab);
  const tabDir = useRef<"down" | "up">("down");
  if (prevTab.current !== tab) {
    tabDir.current = TABS.findIndex((x) => x.v === tab) >= TABS.findIndex((x) => x.v === prevTab.current) ? "down" : "up";
    prevTab.current = tab;
  }
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
  useEffect(() => {
    if (focused.current || !loaded || !focus || (!focus.contract && !focus.products)) return;
    const gi = focus.contract ? contractGroups.findIndex((g) => g.tid === focus.contract) : -1;
    focused.current = true;
    // its own section; a contract with nothing signed here yet → the client's contract summary
    const k = gi === 0 ? "contracts" : gi > 0 ? `contract-${contractGroups[gi].tid}` : focus.products ? "products" : "summary";
    window.setTimeout(() => goSec("contract", k), 260);
  }, [loaded, focus, contractGroups]); // eslint-disable-line react-hooks/exhaustive-deps

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
  /** The signed product asked to be deleted (asks once), and why it couldn't be. */
  const [delLine, setDelLine] = useState<string | null>(null);
  const [delLineBusy, setDelLineBusy] = useState(false);
  const [delLineErr, setDelLineErr] = useState<{ id: string; msg: string } | null>(null);
  /** Delete a signed product (e.g. the same deal's product written twice). Only that row goes; the deal stays. */
  const deleteLine = async (id: string) => {
    setDelLineBusy(true); setDelLineErr(null);
    const { data, error } = await supabase.from("client_products").delete().eq("id", id).select("id");
    setDelLineBusy(false);
    if (error || !(data ?? []).length) {
      setDelLineErr({ id, msg: error ? `Not deleted: ${error.message}` : "Not deleted: you don't have permission to delete signed products." });
      return;
    }
    setDelLine(null);
    setLines((xs) => xs.filter((x) => x.id !== id));
    onLinesChanged?.();
  };
  /** Signed products that appear more than once for the same product and deal. */
  const dupLines = useMemo(() => {
    const by = new Map<string, string[]>();
    lines.forEach((l) => { const k = `${l.product_id ?? l.name}|${l.tracking_id ?? ""}`; by.set(k, [...(by.get(k) ?? []), l.id]); });
    return new Set(Array.from(by.values()).filter((ids) => ids.length > 1).flat());
  }, [lines]);
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
      contact_name: logWho.trim() || null, reason: logWhy.trim() || null, logged_by: me, direction: logDir,
    };
    let res = await supabase.from("client_contacts_log").insert(tenantId ? { ...row, tenant_id: tenantId } : row).select().single();
    if (res.error && /direction/i.test(res.error.message)) { delete row.direction; res = await supabase.from("client_contacts_log").insert(tenantId ? { ...row, tenant_id: tenantId } : row).select().single(); }
    if (res.error && tenantId && /tenant_id/i.test(res.error.message)) res = await supabase.from("client_contacts_log").insert(row).select().single();
    setLogBusy(false);
    if (res.error) { setLogErr(res.error.message); return; }
    setContactLog((xs) => [res.data as ContactLog, ...xs]);
    setLogOpen(false); setLogWhy(""); setLogWho(""); setLogDir("out");
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
  // a client since its first signature — a project's, a signed product's or a contract's — and started with its first kick-off or contract start
  const firstSigned = [
    ...projects.map((p) => p.signingDate),
    ...lines.map((l) => str(l.signing_date) || str(dealContracts[contractKeyOf(l)]?.signDate) || str(l.start_date)),
    ...contractGroups.map((g) => str(g.ct?.signDate)),
  ].map((d) => str(d).slice(0, 10)).filter(Boolean).sort()[0] ?? "";
  const firstKick = [
    ...projects.map((p) => p.kickoffDate),
    ...lines.map((l) => lineStartOf(l, dealContracts[contractKeyOf(l)])),
    ...contractGroups.map((g) => str(g.ct?.contractStart) || str(g.ct?.signDate)),
  ].map((d) => str(d).slice(0, 10)).filter(Boolean).sort()[0] ?? "";

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
    { k: projects.length ? "First kick-off" : "Started", v: firstKick ? fmt(firstKick) : "" },
    { k: "Projects", v: `${projects.length} · ${projects.filter((p) => projectStatusOf(p.status) === "open").length} open` },
    { k: "Sales deals", v: deals.length ? String(deals.length) : "" },
  ];
  const custom = coFields.map((f) => ({ k: f.label, v: customValue(co.custom?.[f.id], f.type) }));
  const filled = [...identity, ...reach, ...place, ...engagement, ...custom].filter((x) => x.v).length;
  const totalFacts = identity.length + reach.length + place.length + engagement.length + custom.length;

  const filteredProjects = projects.filter((p) => projFilter === "all" || projectStatusOf(p.status) === projFilter);

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

  /* ---- a project as a row that opens into its overview (roles, days, team) — the editor only on "Edit" ---- */
  const [pjOpen, setPjOpen] = useState<Set<string>>(new Set());
  const togglePj = (id: string) => setPjOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const projectRow = (p: Project, i: number, canDelete: boolean) => {
    const days = signedOf(p);
    const u = usage[p.id] ?? { planned: 0, done: 0 };
    const left = +(days - u.planned - u.done).toFixed(2);
    const pct = (x: number) => (days > 0 ? Math.min(100, (x / days) * 100) : 0);
    const st = projectStatusOf(p.status);
    const un = unitOf(p);
    const open = pjOpen.has(p.id);
    const name = typeName(p.projectTypeId);
    const team = (p.team ?? []).filter((m) => m.name);
    const ls = linesOf(p);
    return (
      <article key={p.id} className={`cw-pt-item cw-pj ${open ? "is-exp" : ""} is-${st}`} style={cssVars({ "--i": i })}>
        <div className="cw-pj-row" role="button" tabIndex={0} aria-expanded={open} onClick={() => { hideTip(); togglePj(p.id); }} onKeyDown={(e) => { if (e.key === "Enter") togglePj(p.id); }}>
          <span className="cw-pt-name">
            <span className="cw-line-ico" style={cssVars({ "--h": hue(name) })}>{initials(name)}</span>
            <span><b>{name}</b><small>{[p.signingDate ? `Signed ${fmt(p.signingDate)}` : "", p.kickoffDate ? `kick-off ${fmt(p.kickoffDate)}` : ""].filter(Boolean).join(" · ") || "No dates yet"}</small></span>
          </span>
          <span><span className={`cw-status is-${st}`}><i />{PROJECT_STATUS_LABEL[st]}</span></span>
          <span className="cw-pj-prog">
            <b>{d2(u.done)} of {d2(days)}{un}{left < 0 ? <em className="is-over"> · {d2(-left)}{un} over</em> : null}</b>
            <i><em className="is-booked" style={{ width: `${pct(u.done + u.planned)}%` }} /><em style={{ width: `${pct(u.done)}%` }} /></i>
          </span>
          <span className="is-r cw-pt-v">{eur(projectValue(p))}</span>
          <span className="cw-pj-team">
            {team.slice(0, 3).map((m) => <span key={m.id} title={m.name}><Avatar name={m.name} size={24} /></span>)}
            {team.length > 3 && <em>+{team.length - 3}</em>}
            {!team.length && <small>—</small>}
          </span>
          <span className="cw-pt-acts"><button type="button" className="cw-icon-btn is-sm cw-pt-chev" onClick={(e) => { e.stopPropagation(); togglePj(p.id); }} aria-label={open ? "Less" : "More"}><Ico n="chev" s={14} /></button></span>
        </div>
        <div className={`cw-reveal ${open ? "is-on" : ""}`} aria-hidden={!open}><div className="cw-reveal-in">
          <div className="cw-pt-more">
            <div className="cw-pt-cols is-pj">
              <dl className="cw-dl">
                {([
                  ["Status", PROJECT_STATUS_LABEL[st]],
                  ["Signed", p.signingDate ? fmt(p.signingDate) : ""],
                  ["Kick-off", p.kickoffDate ? fmt(p.kickoffDate) : ""],
                  ["Ends", p.endDate ? fmt(p.endDate) : ""],
                  ["Sold", `${d2(days)} ${un === "h" ? "hours" : "days"}`],
                  ["Used", `${d2(u.done)}${un}`],
                  ["Booked", `${d2(u.planned)}${un}`],
                  ["Left", `${d2(left)}${un}`],
                  ["Average rate", `${eur(avgRate(p))} / ${un === "h" ? "hour" : "day"}`],
                  ["Discount", totalDiscountOf(p) ? eur(totalDiscountOf(p)) : ""],
                  ["Tax", p.taxed ? `${p.taxRate}%` : "No tax"],
                  ["Payment", p.paymentDays ? `${p.paymentDays} days` : ""],
                  ["Team", team.map((m) => m.name).join(", ")],
                ] as [string, string][]).filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
              <div className="cw-pt-years cw-pj-roles">
                <div className="cw-pt-yr is-head"><span>Role</span><span>Sold</span><span>Used</span><span>Rate</span><span>Value</span></div>
                {ls.length === 0 && <p className="cw-k-none">No roles on this project.</p>}
                {ls.map((l, k) => {
                  const lu = lineUsage?.[`${p.id}|${l.roleId}`];
                  return (
                    <div key={k} className="cw-pt-yr">
                      <span title={roleCounts(l.roleId, roles) ? undefined : "Doesn't count for billing"}>{roleNameOf(l.roleId, roles)}{roleCounts(l.roleId, roles) ? null : <i className="is-soft">not billed</i>}</span>
                      <span>{d2(l.days)}{un}</span>
                      <span>{lu ? `${d2(lu.done)}${un}` : "—"}</span>
                      <span>{eur(lineRate(l))}</span>
                      <span><b>{eur(l.days * lineRate(l))}</b></span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="cw-pt-foot">
              {canDelete && (
                <span className={`cw-line-del is-shown ${confirmDel === p.id ? "is-asking" : ""}`}>
                  {confirmDel === p.id ? (
                    <><span>Delete this project?</span><button className="is-yes" onClick={() => { setConfirmDel(null); onDeleteProject(p.id); }}>Delete</button><button onClick={() => setConfirmDel(null)}>Keep</button></>
                  ) : <button className="cw-pt-delbtn" onClick={() => setConfirmDel(p.id)}><Ico n="trash" s={13} />Delete</button>}
                </span>
              )}
              <button type="button" className="cw-btn-primary is-sm" onClick={() => { hideTip(); onOpenProject(p); }}><Ico n="edit" s={13} />Edit project</button>
            </div>
          </div>
        </div></div>
      </article>
    );
  };

  /** The closing row of a project list: how much was sold, delivered and what it's worth. */
  const projTotal = (list: Project[]) => {
    if (list.length < 1) return null;
    const sold = list.reduce((t, p) => t + signedOf(p), 0);
    const done = list.reduce((t, p) => t + (usage[p.id]?.done ?? 0), 0);
    const val = list.reduce((t, p) => t + projectValue(p), 0);
    const open = list.filter((p) => projectStatusOf(p.status) === "open").length;
    return (
      <div className="cw-pj-row is-tot">
        <span><b>{list.length} project{list.length === 1 ? "" : "s"}</b><small>{open} open</small></span>
        <span />
        <span className="cw-pj-prog"><b>{d2(done)} of {d2(sold)} days delivered</b><i><em style={{ width: `${sold > 0 ? Math.min(100, (done / sold) * 100) : 0}%` }} /></i></span>
        <span className="is-r cw-pt-v">{eur(val)}</span>
        <span /><span />
      </div>
    );
  };

  /* ---- the company card: full width when opened, in the main column when closed ---- */
  const companyCard = (
    <section data-sec="company" className={`cw-card cw-box cw-co ${coOpen ? "is-open" : ""} ${coMoved ? "is-moved" : ""}`} style={cssVars({ "--i": 4 })}>
      <SecHead icon="building" tone="green" title="Company" sub={`${filled} of ${totalFacts} details filled`}>
        {co.id && <button className="cw-icon-btn" onClick={openCompany} aria-label="Open in Companies" {...tipOn(<TipCard title="Open in Companies" />)}><Ico n="out" s={15} /></button>}
        <button className="cw-ghost" onClick={() => { hideTip(); setCoMoved(true); setCoOpen((o) => !o); }} aria-expanded={coOpen}>
          <Ico n={coOpen ? "shrink" : "expand"} s={14} />{coOpen ? "Less" : "See everything"}
        </button>
      </SecHead>
      <div className="cw-sec-body">
      <div className="cw-co-split">
      <div className="cw-co-main">
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
      {co.id && <WebLinks companyId={co.id} website={str(co.website)} linkedin={str(co.linkedin)} readOnly={!can("company")}
        onSaved={(patch) => setCompany((c: any) => (c ? { ...c, ...patch } : c))} />}
      </div>
      <dl className="cw-co-facts">
        {([
          ["Phone", str(co.phone) ? <a href={telHref(str(co.phone))}>{co.phone}</a> : null],
          ["Email", str(co.email) ? <a href={`mailto:${co.email}`}>{co.email}</a> : null],
          ["Address", fullAddress || null],
          ["Client since", firstSigned ? fmt(firstSigned) : null],
          ["Sector", str(co.sector) || null],
          ["Size", str(co.employees) || str(co.size) || null],
        ] as [string, React.ReactNode][]).map(([k, v]) => <div key={k} className={v ? "" : "is-empty"}><dt>{k}</dt><dd>{v ?? "—"}</dd></div>)}
      </dl>
      </div>
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
                  {onSetStatus && (
                    <ClientStatusPicker status={client.status} churnedAt={client.churnedAt} reason={client.churnReason} canEdit={can("company")}
                      running={activeLines.length} onSave={async (st, o) => { const e = await onSetStatus(st, o); if (!e && st === "churned" && o.stopProducts) { await reloadLines(); onLinesChanged?.(); } return e; }} />
                  )}
                  {placeLine && <span className="cw-tag" style={cssVars({ "--i": 1 })}><Ico n="pin" s={12} />{placeLine}</span>}
                  {co.id && <button className="cw-tag is-link" style={cssVars({ "--i": 2 })} onClick={openCompany}
                    {...tipOn(<TipCard title="Open in Companies" sub={[webHost, str(co.phone)].filter(Boolean).join(" · ") || undefined} />)}><Ico n="building" s={12} />Company</button>}
                </div>
              </div>
            </div>
            <div className="cw-kpis">
              <div className="cw-kpi" style={cssVars({ "--i": 0 })} {...tipOn(<TipCard title="Signed with this client" sub="Net to us: what partners take is left out"
                rows={[["Projects", eur(totals.value)], ["Products", eur(contractValue)], ["Client pays for products", partnerAll > 0.5 ? eur(contractGross) : ""], ["Partner share", partnerAll > 0.5 ? `−${eur(partnerAll)}` : ""]]} />)}>
                <span className="cw-kpi-k">Signed</span>
                <span className="cw-kpi-v is-neon">{eur(totals.value + contractValue)}</span>
              </div>
              <div className="cw-kpi" style={cssVars({ "--i": 1 })} {...tipOn(<TipCard title="Recurring a year, today" sub="Net to us"
                rows={[["Billed to the client", eur(grossYear)], ["Partner share", partnerYearNow > 0.5 ? `−${eur(partnerYearNow)}` : "None"], ["Net", eur(recurringYear)]]} />)}>
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
        <div className={`cw-body ${tab === "folders" || tab === "emails" ? "is-fixed" : ""}`} ref={bodyRef} onScroll={() => { hideTip(); spyNow(); }}>
          <div className={`cw-panel is-${tab} is-from-${tabDir.current} ${!loaded && (tab === "overview" || tab === "deals") ? "is-loading" : ""}`} key={tab}>
            {tab !== "folders" && tab !== "emails" && tab !== "tickets" && (() => {
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
                    {...tipOn(<TipCard title="Projects" rows={projRows((p) => `${PROJECT_STATUS_LABEL[projectStatusOf(p.status)]} · ${eur(projectValue(p))}`)} />)}>
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
                    <span className="cw-tile-sub">{activeLines.filter((l) => l.recurring).length ? `${activeLines.filter((l) => l.recurring).length} subscription${activeLines.filter((l) => l.recurring).length === 1 ? "" : "s"}${partnerYearNow > 0.5 ? ` · net of ${eur(partnerYearNow)} partner` : ""}` : "No subscriptions"}</span>
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
                    <section data-sec="people" className="cw-card cw-box cw-people" style={cssVars({ "--i": 6 })}>
                      <SecHead icon="users" tone="blue" title="Contacts"
                        sub={`${persons.length} ${persons.length === 1 ? "person" : "people"}${persons.some((p) => p.billing) ? ` · ${persons.filter((p) => p.billing).length} billing` : ""}`}>
                        {persons.length > PEOPLE_LIMIT && (
                          <label className="cw-search"><Ico n="search" s={14} /><input value={peopleQ} placeholder="Search people" onChange={(e) => setPeopleQ(e.target.value)} /></label>
                        )}
                        {can("company") && (
                          <button className="cw-btn-primary is-sm" onClick={() => { setAddPersonErr(null); setAddPerson((v) => (v ? null : { first: "", last: "", position: "", email: "", phone: "", billing: false })); }}>
                            <Ico n={addPerson ? "x" : "plus"} s={14} />{addPerson ? "Cancel" : "Add"}
                          </button>
                        )}
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
                    <section ref={pulseRef} data-sec="pulse" className={`cw-card cw-box cw-pulse is-${health}`} style={cssVars({ "--i": 5 })}>
                      <SecHead icon="pulse" tone="teal" title="Last contacted" sub={touches.length ? `${touches.length} touchpoint${touches.length === 1 ? "" : "s"}` : "Nothing on record yet"}>
                        <button className="cw-btn-primary is-sm" onClick={() => (logOpen ? setLogOpen(false) : startLog())}>
                          <Ico n={logOpen ? "x" : "plus"} s={14} />{logOpen ? "Cancel" : "Log"}
                        </button>
                      </SecHead>

                      <div className={`cw-sec-body ${touches.length ? "cw-pulse-grid" : ""}`}>
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
                            <p className="cw-pulse-last"><b>{last.who}</b>{last.us && <> · <span className="cw-pulse-us">{last.dir === "in" ? "to" : "by"} <b>{last.us}</b></span></>} · <span className="cw-kind-t">{last.kind}</span>{last.dir && <span className={`cw-pulse-dir is-${last.dir}`}><Ico n={last.dir === "in" ? "din" : "dout"} s={11} />{last.dir === "in" ? "they reached us" : "we reached out"}</span>}</p>
                          ) : <p className="cw-hint">Log the first call, email or meeting.</p>}
                          {nextMeeting && <p className="cw-pulse-next"><Ico n="cal" s={13} />Next: {nextMeeting.title || "Meeting"} · {fmt(nextMeeting.at)}</p>}
                        </div>
                      </div>

                      <div className={`cw-reveal ${logOpen ? "is-on" : ""}`} aria-hidden={!logOpen}>
                        <div className="cw-reveal-in">
                          <div className="cw-logform">
                            <div className="cw-dirpick" role="radiogroup" aria-label="Who reached whom">
                              <button role="radio" aria-checked={logDir === "out"} className={logDir === "out" ? "is-on" : ""} onClick={() => setLogDir("out")}><Ico n="dout" s={13} />We reached out</button>
                              <button role="radio" aria-checked={logDir === "in"} className={logDir === "in" ? "is-on is-in" : ""} onClick={() => setLogDir("in")}><Ico n="din" s={13} />They reached us</button>
                            </div>
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
                            <li key={`${t.at}-${i}`} data-kind={t.kind} data-dir={t.dir ?? ""} style={cssVars({ "--i": i })}
                              {...tipOn(<TipCard title={t.us ? (t.dir === "in" ? `${t.who} → ${t.us}` : `${t.us} → ${t.who}`) : t.who} sub={`${t.dir === "in" ? "From them" : t.dir === "out" ? "From us" : t.kind} · ${t.kind}${t.source === "email" ? " (Outlook)" : ""} · ${fmt(t.at)} · ${ago(t.at)}`}>{t.why}</TipCard>)}>
                              <span className="cw-tl-dot"><Ico n={kindIcon(t.kind)} s={12} />{t.dir && <em className={`cw-tl-dir is-${t.dir}`}><Ico n={t.dir === "in" ? "din" : "dout"} s={9} /></em>}</span>
                              <span className="cw-tl-who">{t.who}{t.us && <small className="cw-tl-us">{t.dir === "in" ? "to" : "by"} {t.us}</small>}</span>
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
                <section className="cw-zone cw-box" data-sec="tasks" data-tone="amber" style={cssVars({ "--i": 7 })}>
                  <header className="cw-zone-h">
                    <span className="cw-zone-ico"><Ico n="tasks" s={17} /></span>
                    <div><h3>Tasks</h3><small>{openTasks.length ? `${openTasks.length} open${lateTasks.length ? ` · ${lateTasks.length} overdue` : ""}` : "Nothing open"} · the client's own and those from sales</small></div>
                  </header>
                <div className="cw-stack">

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
                <section className="cw-zone cw-box" data-sec="notes" data-tone="blue" style={cssVars({ "--i": 8 })}>
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
                  const dl = lines.filter((l) => str(l.tracking_id) === v.d.id);
                  const dNet = dl.filter(isActive).reduce((t, l) => t + lineContractValue(l), 0);
                  const dGross = dl.filter(isActive).reduce((t, l) => t + lineContractValue(l) + partnerTotal(l), 0);
                  const dEd = dlEdit?.id === v.d.id;
                  const dv = dlEdit?.v ?? {};
                  const setDv = (patch: Record<string, any>) => setDlEdit((e) => (e ? { ...e, v: { ...e.v, ...patch } } : e));
                  return (
                    <article key={v.d.id} className="cw-deal" data-sec={`deal-${v.d.id}`} data-st={tone} style={cssVars({ "--i": i })}>
                      <header className="cw-deal-h">
                        <span className="cw-deal-ico"><Ico n={tone === "won" ? "star" : "flag"} s={17} /></span>
                        <div className="cw-deal-id">
                          <h4>{v.d.name}</h4>
                          <small>{[v.d.pipeline, v.d.phase].filter(Boolean).join(" · ") || "Sales deal"}</small>
                        </div>
                        <span className={`cw-dstat is-${tone}`}><i />{stLabel}</span>
                        <div className="cw-deal-val" {...tipOn(dl.length ? <TipCard title="Signed in this deal" rows={[["Client pays", eur(dGross)], ["Partner share", dGross - dNet > 0.5 ? `−${eur(dGross - dNet)}` : ""], ["Net to us", eur(dNet)], ["Deal value", v.value != null ? eur(v.value) : ""]]} /> : null)}>
                          <b>{dl.length ? eur(dNet) : v.value != null ? eur(v.value) : "—"}</b>
                          <small>{dl.length ? (dGross - dNet > 0.5 ? `Signed, net · ${eur(dGross)} paid` : "Signed") : v.main ? `Main: ${v.main.name}` : "Deal value"}</small>
                        </div>
                        {can("deals") && !dEd && (
                          <button className="cw-icon-btn" onClick={() => { setDlErr(null); setDlEdit({ id: v.d.id, v: { name: v.d.name, status: v.d.status || "active", close: str(v.d.close_date).slice(0, 10), value: v.d.price != null ? String(v.d.price) : "" } }); }}
                            aria-label="Edit the deal" {...tipOn(<TipCard title="Edit the deal" />)}><Ico n="edit" s={14} /></button>
                        )}
                        <button className="cw-icon-btn" onClick={() => openDeal(v.d.id)} aria-label="Open in Sales" {...tipOn(<TipCard title="Open in Sales" />)}><Ico n="out" s={15} /></button>
                      </header>
                      {dEd && (
                        <div className="cw-ed is-deal" onMouseEnter={hideTip}>
                          <div className="cw-ed-grid">
                            <Fld label="Deal name" wide><input autoFocus value={dv.name} onChange={(e) => setDv({ name: e.target.value })} /></Fld>
                            <Fld label="Status"><Select size="sm" value={dv.status} onChange={(x) => setDv({ status: x })} options={[
                              { value: "active", label: "Active" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }, { value: "paused", label: "On hold" },
                              ...(["active", "won", "lost", "paused"].includes(dv.status) ? [] : [{ value: dv.status, label: String(dv.status).replace(/_/g, " ") }]),
                            ]} /></Fld>
                            <Fld label="Close date"><span className="cw-date"><DatePicker value={dv.close} onChange={(d) => setDv({ close: d })} /></span></Fld>
                            <Fld label="Deal value"><span className="cw-ed-unit"><input inputMode="decimal" value={dv.value} placeholder="—" onChange={(e) => setDv({ value: e.target.value })} /><em>€</em></span></Fld>
                          </div>
                          {dlErr && <p className="cw-err">{dlErr}</p>}
                          <div className="cw-ed-foot">
                            <span>The deal itself, as Sales sees it. What was signed is changed in Contracts.</span>
                            <button type="button" className="cw-ghost" onClick={() => setDlEdit(null)}>Cancel</button>
                            <button type="button" className="cw-btn-primary is-sm" disabled={dlBusy} onClick={() => void saveDlEdit()}>{dlBusy ? "Saving…" : "Save deal"}</button>
                          </div>
                        </div>
                      )}
                      <div className="cw-deal-facts">
                        {v.d.created_at && <span><Ico n="cal" s={12} />Opened {fmt(v.d.created_at)}</span>}
                        {v.d.close_date && <span><Ico n="check" s={12} />Closed {fmt(v.d.close_date)}</span>}
                        <button onClick={() => goSec("overview", "tasks")}><Ico n="tasks" s={12} />{v.tasksOpen} open task{v.tasksOpen === 1 ? "" : "s"}</button>
                        <button onClick={() => goSec("overview", "notes")}><Ico n="note" s={12} />{v.notesN} note{v.notesN === 1 ? "" : "s"}</button>
                      </div>
                      {dl.length > 0 && (
                        <div className="cw-deal-prods">
                          {dl.map((l) => (
                            <span key={l.id} className={isActive(l) ? "" : "is-off"}>
                              <b>{l.name}</b>
                              <em>{l.recurring ? `${eur(lineAnnualGross(l) || firstYearOf(l))}/yr` : eur(lineTotal(l))}{partnerTotal(l) > 0.5 ? " · partner" : ""}</em>
                            </span>
                          ))}
                          <button className="cw-linkbtn" onClick={() => goSec("contract", dealContracts[v.d.id] || dl.length ? (contractGroups[0]?.tid === v.d.id ? "contracts" : `contract-${v.d.id}`) : "products")}>See the contract<Ico n="arrow" s={12} /></button>
                        </div>
                      )}
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
                    { v: "open", label: "Open", n: projects.filter((p) => projectStatusOf(p.status) === "open").length },
                    ...(projects.some((p) => projectStatusOf(p.status) === "on_hold") ? [{ v: "on_hold" as const, label: "On hold", n: projects.filter((p) => projectStatusOf(p.status) === "on_hold").length }] : []),
                    { v: "closed", label: "Closed", n: projects.filter((p) => projectStatusOf(p.status) === "closed").length },
                  ]} />
                  <button className="cw-btn-primary" onClick={() => { hideTip(); onNewProject(); }}><Ico n="plus" s={15} />New project</button>
                </div>
                {filteredProjects.length === 0 ? (
                  <div className="cw-empty is-big"><Ico n="briefcase" s={24} /><p>{projects.length ? "No projects match this filter." : "No projects yet."}</p></div>
                ) : (
                  <div className="cw-pt cw-pj-list">
                    <div className="cw-pj-row is-head"><span>Service</span><span>Status</span><span>Delivered</span><span className="is-r">Value</span><span>Team</span><span /></div>
                    {filteredProjects.map((p, i) => projectRow(p, i, true))}
                    {projTotal(filteredProjects)}
                  </div>
                )}
              </div>
            )}

            {/* ===== CONTRACT ===== */}
            {tab === "contract" && (
              <div className="cw-stack cw-kpage">
                <div className="cw-khero" data-sec="summary">
                  <div className="cw-khero-main" {...tipOn(activeLines.some((l) => l.recurring) ? <TipCard title="Recurring today" sub="Net to us, a year" rows={activeLines.filter((l) => l.recurring).map((l) => [l.name, `${eur(lineAnnual(l))}${lineAnnualGross(l) - lineAnnual(l) > 0.5 ? ` of ${eur(lineAnnualGross(l))}` : ""}`] as [string, React.ReactNode])} /> : null)}>
                    <span className="cw-khero-k">Recurring today</span>
                    <b className="cw-khero-v"><Num v={recurringYear} /><small>€ a year</small></b>
                    <span className="cw-khero-sub">
                      {partnerYearNow > 0.5
                        ? <>{eur(grossYear)} billed to the client, {eur(partnerYearNow)} of it to partners</>
                        : <>{activeLines.filter((l) => l.recurring).length || "No"} running subscription{activeLines.filter((l) => l.recurring).length === 1 ? "" : "s"}</>}
                    </span>
                  </div>
                  <dl className="cw-khero-side">
                    <div {...tipOn(activeLines.length ? <TipCard title="Signed, net" sub="Each product over its term, less partners" rows={activeLines.map((l) => [l.name, eur(lineContractValue(l))] as [string, React.ReactNode])} /> : null)}>
                      <dt>Signed, net</dt><dd><Num v={contractValue} /> €</dd>{partnerAll > 0.5 && <small>of {eur(contractGross)} paid</small>}
                    </div>
                    <div><dt>Services</dt><dd><Num v={totals.value} /> €</dd><small>{projects.length} project{projects.length === 1 ? "" : "s"}</small></div>
                    <div><dt>One-time</dt><dd><Num v={oneTime} /> €</dd><small>fees and one-offs</small></div>
                    <div><dt>Next renewal</dt><dd>{nextRenewal ? fmtD(nextRenewal.end) : "—"}</dd><small>{nextRenewal ? `in ${nextRenewal.left} days` : "no term on file"}</small></div>
                  </dl>
                </div>

                {contractGroups.map((g, gi) => {
                  const { tid, ct, lines: gl } = g;
                  const live = gl.filter(isActive);
                  // the contract's own products set its dates and term (an upsell signed into it later doesn't)
                  const own = gl.filter((l) => str(l.tracking_id) === tid);
                  const g0 = own.length ? own : gl;
                  const startS = str(ct?.contractStart) || str(ct?.signDate) || str(g0[0]?.start_date) || str(g0[0]?.signing_date);
                  const termY = Number(ct?.termYears) || Math.max(1, ...g0.map((l) => Number(l.term_years) || 1));
                  const start = startS ? toDate(startS) : null;
                  // a grace period: signed on one day, starts on a later one
                  const signS = str(ct?.signDate) || str(g0[0]?.signing_date);
                  const graceDays = start && signS ? Math.round((start.getTime() - toDate(signS).getTime()) / DAY) : 0;
                  const graceTxt = graceDays > 0 ? (Number(ct?.graceMonths) ? `${ct!.graceMonths}-month grace` : `${graceDays} days of grace`) : "";
                  // an upsell signed into this contract later counts from its own start year
                  const off = (l: Line) => (str(l.contract_tracking_id) && str(l.contract_tracking_id) !== str(l.tracking_id) ? yearOffsetOf(l, start) : 0);
                  const n = Math.max(1, (ct?.schedule ?? []).length, ...gl.map((l) => off(l) + yearsOf(l)));
                  const now = Date.now();
                  const years = Array.from({ length: n }, (_, i) => {
                    const lic = gl.length ? gl.reduce((t, l) => t + (i >= off(l) ? lineYearGross(l, i - off(l)) : 0), 0) : Number(ct?.schedule?.[i]?.license) || 0;
                    // services live in Services / Projects, not in the contract
                    const svc = 0;
                    const partner = gl.reduce((t, l) => t + (i >= off(l) ? partnerCut(l, i - off(l)) : 0), 0);
                    const from = start ? addYears(start, i) : null;
                    const to = start ? new Date(addYears(start, i + 1).getTime() - DAY) : null;
                    return { i, pays: lic + svc, svc, partner, net: lic + svc - partner, from, to, now: !!from && !!to && now >= from.getTime() && now < to.getTime() + DAY, past: !!to && to.getTime() + DAY <= now };
                  });
                  const tot = years.reduce((a, y) => ({ pays: a.pays + y.pays, partner: a.partner + y.partner, net: a.net + y.net }), { pays: 0, partner: 0, net: 0 });
                  const end = start ? addYears(start, termY) : null;
                  const tm = (live.filter((l) => g0.includes(l)).length ? live.filter((l) => g0.includes(l)) : live).map(termOf).filter((t): t is NonNullable<ReturnType<typeof termOf>> => !!t).sort((a, b) => a.end.getTime() - b.end.getTime())[0] ?? null;
                  const autoRenew = ct?.autoRenew ?? g0.some((l) => !!l.auto_renew);
                  const left = tm ? tm.left : end ? Math.ceil((end.getTime() - now) / DAY) : null;
                  const cur = years.findIndex((y) => y.now);
                  const status = gl.length && !live.length ? { tone: "off", label: "Ended" }
                    : left == null ? { tone: "ok", label: "Active" }
                      : left < 0 ? { tone: "off", label: "Ended" }
                        : left <= 90 ? { tone: "warn", label: autoRenew ? `Renews in ${left} days` : `Ends in ${left} days` }
                          : { tone: "ok", label: cur >= 0 ? `Active · year ${cur + 1} of ${n}` : start && start.getTime() > now ? `Grace period · starts ${fmtD(start)}` : "Active" };
                  const span = tm ? { a: tm.renewed ? addYears(tm.end, -(Number(gl.find((l) => l.renew_years)?.renew_years) || termY)) : tm.start, b: tm.end } : start && end ? { a: start, b: end } : null;
                  const pct = span ? clamp((now - span.a.getTime()) / Math.max(1, span.b.getTime() - span.a.getTime())) : 0;
                  const partners = Array.from(new Set(gl.map(partnerText).filter(Boolean)));
                  /** What makes up a signed product's yearly price (the deal's calculator), when there's more than one part. */
                  const yearRows = (l?: Line): { label: string; detail?: string | null; amount: number; discount: number }[] => {
                    const rs = Array.isArray(l?.breakdown?.rows) ? (l!.breakdown.rows as any[]) : [];
                    return rs.length > 1 ? rs.map((r) => ({ label: String(r.label ?? ""), detail: [r.detail, "a year"].filter(Boolean).join(" · "), amount: Number(r.amount) || 0, discount: Number(r.discount) || 0 })) : [];
                  };
                  const ups = gl.filter((l) => str(l.tracking_id) !== tid);
                  const upScope = ups.map((l) => ({ name: l.name, rows: yearRows(l), sub: `Upsell · ${l.tracking_id ? dealName(String(l.tracking_id)) : "added by hand"}${l.signing_date ? ` · signed ${fmt(l.signing_date)}` : ""}`, list: Number(l.breakdown?.gross), discount: Number(l.breakdown?.discount) || 0, pct: null as number | null, final: lineContractValue(l) + partnerTotal(l) }));
                  const ctLines = (ct?.lines ?? []).filter((ln) => ln.kind !== "service");
                  const scope = ctLines.length
                    ? [...ctLines.map((ln) => ({
                      name: ln.name, rows: (ln.rows ?? []).length > 1 ? ln.rows ?? [] : yearRows(gl.find((l) => norm(l.name) === norm(ln.name))),
                      sub: ln.kind === "service" ? `Services${ct?.servicesBilling === "per_day" ? " · per day performed" : " · fixed fee"}${ln.qty ? ` · ${ln.qty} ${ln.unit === "hour" ? "hours" : "days"}` : ""}` : ln.recurring === false ? "One-time" : "Subscription",
                      list: Number(ln.list), discount: Number(ln.discount) || 0, pct: ln.discountPct ?? null, final: Number(ln.final),
                    })), ...upScope]
                    : [...gl.filter((l) => str(l.tracking_id) === tid), ...ups].map((l) => (str(l.tracking_id) !== tid ? upScope[ups.indexOf(l)] : { name: l.name, rows: yearRows(l), sub: l.recurring ? `Every ${periodLabel(l.period)}` : "One-off", list: Number(l.breakdown?.gross), discount: Number(l.breakdown?.discount) || 0, pct: null as number | null, final: lineContractValue(l) + partnerTotal(l) }));
                  const money = (x: number) => (Number.isFinite(x) ? eur(x) : "—");
                  const editing = ctEdit?.tid === tid;
                  const ev = ctEdit?.v ?? {};
                  const setEv = (patch: Record<string, any>) => setCtEdit((e) => (e ? { ...e, v: { ...e.v, ...patch } } : e));
                  const signers = ct?.signatories ?? [];
                  const fact = (k: string, v: React.ReactNode) => (v ? <div key={k}><dt>{k}</dt><dd>{v}</dd></div> : null);
                  return (
                    <section className="cw-box cw-k" data-sec={gi === 0 ? "contracts" : `contract-${tid}`} key={tid} style={cssVars({ "--i": gi + 1 })}>
                      <header className="cw-k-h">
                        <span className="cw-k-ico"><Ico n="contract" s={18} /></span>
                        <div className="cw-k-id">
                          <h3>{dealName(tid)}</h3>
                          <small>{[ct?.contractRef ? `No. ${ct.contractRef}` : "", (ct?.signDate || g0[0]?.signing_date) ? `Signed ${fmt(ct?.signDate || g0[0]?.signing_date)}` : "", graceTxt, `${termY} ${termY === 1 ? "year" : "years"}`, autoRenew ? `renews every ${ct?.renewYears || gl.find((l) => l.renew_years)?.renew_years || termY}y` : "no auto-renewal"].filter(Boolean).join(" · ")}</small>
                        </div>
                        <span className={`cw-k-st is-${status.tone}`}><i />{status.label}</span>
                        <div className="cw-k-acts">
                          {ct?.documentFileId && (
                            <button type="button" className="cw-ghost" onClick={async () => {
                              const { data: f } = await supabase.from("tracking_files").select("storage_path").eq("id", ct.documentFileId!).maybeSingle();
                              if (!f) return;
                              const { data } = await supabase.storage.from("tracking-files").createSignedUrl((f as any).storage_path, 60);
                              if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener");
                            }}><Ico n="file" s={13} />Signed PDF</button>
                          )}
                          {can("contracts") && !editing && contractGroups.length > 1 && gl.length > 0 && gl.every((l) => str(l.tracking_id) === tid) && (
                            <span className="cw-k-into" title="An upsell signed into another contract stops counting as a contract of its own">
                              <Select size="sm" value="" disabled={!!mvBusy} onChange={(x) => void moveToContract(gl, x || null)} placeholder={mvBusy === gl[0]?.id ? "Moving…" : "Upsell into…"}
                                options={contractGroups.filter((x) => x.tid !== tid).map((x) => ({ value: x.tid, label: dealName(x.tid), hint: "Its products join that contract" }))} />
                            </span>
                          )}
                          {can("contracts") && !editing && <button type="button" className="cw-ghost" onClick={() => startCtEdit(tid, ct, gl)}><Ico n="edit" s={13} />Edit</button>}
                          <button type="button" className="cw-icon-btn" onClick={() => openDeal(tid)} aria-label="Open the deal" {...tipOn(<TipCard title="Open the deal in Sales" />)}><Ico n="out" s={15} /></button>
                        </div>
                      </header>

                      {editing && (
                        <div className="cw-ed" onMouseEnter={hideTip}>
                          <div className="cw-ed-grid">
                            <Fld label="Signed"><span className="cw-date"><DatePicker value={ev.signDate} onChange={(d) => setEv({ signDate: d })} /></span></Fld>
                            <Fld label="Starts"><span className="cw-date"><DatePicker value={ev.contractStart} onChange={(d) => setEv({ contractStart: d })} /></span></Fld>
                            <Fld label="Term (years)"><input inputMode="decimal" value={ev.termYears} onChange={(e) => setEv({ termYears: e.target.value })} /></Fld>
                            <Fld label="Licences billed"><Select size="sm" value={ev.billingFrequency} onChange={(x) => setEv({ billingFrequency: x })} options={[
                              { value: "upfront", label: "Upfront" }, { value: "annually", label: "Annually" }, { value: "semiannually", label: "Every 6 months" }, { value: "quarterly", label: "Quarterly" }, { value: "monthly", label: "Monthly" },
                            ]} /></Fld>
                            <Fld label="Payment (days)"><input inputMode="numeric" value={ev.paymentTermsDays} placeholder="30" onChange={(e) => setEv({ paymentTermsDays: e.target.value })} /></Fld>
                            <Fld label="Non-terminable (years)"><input inputMode="decimal" value={ev.nonTerminableYears} placeholder="—" onChange={(e) => setEv({ nonTerminableYears: e.target.value })} /></Fld>
                            <Fld label="Contract no."><input value={ev.contractRef} placeholder="—" onChange={(e) => setEv({ contractRef: e.target.value })} /></Fld>
                            <Fld label="Currency"><input value={ev.currency} onChange={(e) => setEv({ currency: e.target.value.toUpperCase().slice(0, 3) })} /></Fld>
                            <Fld label="Renewal">
                              <span className="cw-ed-inline">
                                <Toggle on={!!ev.autoRenew} onClick={() => setEv({ autoRenew: !ev.autoRenew })} label={ev.autoRenew ? "Automatic" : "No"} />
                                {ev.autoRenew && <><em>every</em><input className="is-xs" inputMode="decimal" value={ev.renewYears} placeholder={String(ev.termYears || 1)} onChange={(e) => setEv({ renewYears: e.target.value })} /><em>years</em></>}
                              </span>
                            </Fld>
                            <Fld label="Notes" wide><textarea rows={2} value={ev.notes} placeholder="Anything special agreed" onChange={(e) => setEv({ notes: e.target.value })} /></Fld>
                          </div>
                          {ctErr && <p className="cw-err">{ctErr}</p>}
                          <div className="cw-ed-foot">
                            <span>{gl.length ? `Also changes ${gl.length === 1 ? "its signed product" : `its ${gl.length} signed products`}: dates, term, renewal and payment.` : "Saved on the deal's order form."}</span>
                            <button type="button" className="cw-ghost" onClick={() => setCtEdit(null)}>Cancel</button>
                            <button type="button" className="cw-btn-primary is-sm" disabled={ctBusy} onClick={() => void saveCtEdit(ct, gl)}>{ctBusy ? "Saving…" : "Save contract"}</button>
                          </div>
                        </div>
                      )}

                      <div className="cw-k-time">
                        <div className="cw-k-ends">
                          <span><i>{span && tm?.renewed ? "This term" : "Start"}</i>{span ? fmtD(span.a) : "—"}</span>
                          <span className="is-r"><i>{autoRenew ? "Renews" : "Ends"}</i>{span ? fmtD(span.b) : "—"}</span>
                        </div>
                        <div className="cw-k-track">
                          {years.map((y) => (
                            <span key={y.i} className={y.now ? "is-now" : y.past ? "is-past" : ""} {...tipOn(<TipCard title={`Year ${y.i + 1}`} sub={y.from && y.to ? `${fmtD(y.from)} – ${fmtD(y.to)}` : undefined} rows={[["Client pays", eur(y.pays)], ["Partner", y.partner ? `−${eur(y.partner)}` : ""], ["Net to us", eur(y.net)]]} />)}>
                              <em>Y{y.i + 1}</em>
                            </span>
                          ))}
                          {span && pct > 0 && pct < 1 && <i className={`cw-k-today ${pct < 0.05 ? "is-l" : pct > 0.95 ? "is-r" : ""}`} style={{ left: `${pct * 100}%` }}><b>Today</b></i>}
                        </div>
                      </div>

                      <div className={`cw-keq ${tot.partner > 0.5 ? "" : "is-solo"}`}>
                        <div className="cw-keq-t"><small>The client pays</small><b>{eur(tot.pays)}</b><em>over {n} year{n === 1 ? "" : "s"}{years[0]?.svc ? `, ${eur(years[0].svc)} of it services` : ""}</em></div>
                        {tot.partner > 0.5 && <>
                          <span className="cw-keq-op" aria-hidden="true">−</span>
                          <div className="cw-keq-t is-partner"><small>Partner share</small><b>{eur(tot.partner)}</b><em title={partners.join(", ")}>{partners.join(", ")}</em></div>
                        </>}
                        <span className="cw-keq-op" aria-hidden="true">=</span>
                        <div className="cw-keq-t is-net"><small>Net to us</small><b>{eur(tot.net)}</b><em>{tot.pays > 0 ? `${Math.round((tot.net / tot.pays) * 100)}% of what the client pays` : "—"}</em></div>
                      </div>

                        <div className="cw-k-tbl">
                          <div className="cw-k-tr is-head is-y"><span>Year</span><span className="is-r">Client pays</span><span className="is-r">Partner</span><span className="is-r">Net</span></div>
                          {years.map((y) => (
                            <div className={`cw-k-tr is-y ${y.now ? "is-now" : ""} ${y.past ? "is-past" : ""}`} key={y.i}>
                              <span><b>Year {y.i + 1}{y.now && <i>now</i>}</b><em>{y.from && y.to ? `${fmtMY(y.from)} – ${fmtMY(y.to)}` : ""}</em></span>
                              <span className="is-r">{eur(y.pays)}</span>
                              <span className="is-r is-p">{y.partner > 0.5 ? `−${eur(y.partner)}` : "—"}</span>
                              <span className="is-r"><b>{eur(y.net)}</b></span>
                            </div>
                          ))}
                          <div className="cw-k-tr is-y is-tot"><span><b>Total</b></span><span className="is-r">{eur(tot.pays)}</span><span className="is-r is-p">{tot.partner > 0.5 ? `−${eur(tot.partner)}` : "—"}</span><span className="is-r"><b>{eur(tot.net)}</b></span></div>
                        </div>
                      <button type="button" className={`cw-k-more ${ofOpen.has(tid) ? "is-on" : ""}`} aria-expanded={ofOpen.has(tid)} onClick={() => toggleOf(tid)}>
                        <span className="cw-k-more-ico"><Ico n="file" s={15} /></span>
                        <span className="cw-k-more-t"><b>Order form</b><em>{[scope.length ? `${scope.length} line${scope.length === 1 ? "" : "s"}` : "", ct?.customer ? "parties" : "", signers.length ? "signatures" : "", ct ? "terms" : ""].filter(Boolean).join(", ") || "What the products were sold as"}</em></span>
                        <span className="cw-k-more-go">{ofOpen.has(tid) ? "Hide" : "Show"}<Ico n="chev" s={14} /></span>
                      </button>
                      <div className={`cw-k-ofw ${ofOpen.has(tid) ? "is-on" : ""}`} aria-hidden={!ofOpen.has(tid)}>
                        <div className="cw-k-ofw-in">
                          <div className="cw-k-of">
                            <header className="cw-k-of-h">
                              <div>
                                <small>Order form</small>
                                <b>{ct?.customer?.legalName || ct?.customer?.name || client.name}</b>
                              </div>
                              <dl>
                                {ct?.contractRef && <div><dt>Contract no.</dt><dd>{ct.contractRef}</dd></div>}
                                <div><dt>Signed</dt><dd>{(ct?.signDate || gl[0]?.signing_date) ? fmt(ct?.signDate || gl[0]?.signing_date) : "—"}</dd></div>
                                {start && graceTxt && <div><dt>Starts</dt><dd>{fmtD(start)}<small className="cw-k-grace">{graceTxt}</small></dd></div>}
                                <div><dt>Term</dt><dd>{termY} {termY === 1 ? "year" : "years"}</dd></div>
                              </dl>
                            </header>

                            <section className="cw-k-of-s">
                              <h5>What was sold</h5>
                              <div className="cw-k-tbl">
                                <div className="cw-k-tr is-head is-s"><span>Line</span><span className="is-r">List</span><span className="is-r">Discount</span><span className="is-r">Final</span></div>
                                {scope.length === 0 && <p className="cw-k-none">Nothing on the order form.</p>}
                                {scope.map((ln, j) => (
                                  <div key={j} className="cw-k-sl">
                                    <div className="cw-k-tr is-s">
                                      <span><b>{ln.name}</b><em>{ln.sub}</em></span>
                                      <span className="is-r">{money(ln.list)}</span>
                                      <span className={`is-r ${ln.discount ? "is-d" : "is-mu"}`}>{ln.discount ? `−${eur(ln.discount)}${ln.pct ? ` (${d2(ln.pct)}%)` : ""}` : "—"}</span>
                                      <span className="is-r"><b>{money(ln.final)}</b></span>
                                    </div>
                                    {ln.rows.map((r, k) => (
                                      <div key={k} className="cw-k-tr is-s is-sub"><span>{r.label}{r.detail ? <em> {r.detail}</em> : null}</span><span className="is-r">{money(Number(r.amount))}</span><span className="is-r is-d">{Number(r.discount) ? `−${eur(Number(r.discount))}` : ""}</span><span /></div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            </section>

                            {(ct?.customer || ct?.contactPerson?.name || ct?.adminUser?.name || signers.length > 0) && (
                              <section className="cw-k-of-s">
                                <h5>Who signed</h5>
                                <div className="cw-k-parties">
                                  {ct?.customer && (
                                    <div><small>Customer</small><b>{ct.customer.legalName || ct.customer.name || "—"}</b>
                                      <em>{[ct.customer.vat && `VAT ${ct.customer.vat}`, ct.customer.regNo && `Reg. ${ct.customer.regNo}`].filter(Boolean).join(", ") || "—"}</em>
                                      {(ct.customer.address || ct.customer.country) && <em title={[ct.customer.address, ct.customer.country ? countryLabel(ct.customer.country) : ""].filter(Boolean).join(", ")}>{[ct.customer.address, ct.customer.country ? countryLabel(ct.customer.country) : ""].filter(Boolean).join(", ")}</em>}
                                    </div>
                                  )}
                                  {ct?.contactPerson?.name && <div><small>Contact person</small><b>{ct.contactPerson.name}</b><em>{ct.contactPerson.role || "—"}</em>{(ct.contactPerson.email || ct.contactPerson.phone) && <em>{[ct.contactPerson.email, ct.contactPerson.phone].filter(Boolean).join(", ")}</em>}</div>}
                                  {ct?.adminUser?.name && <div><small>Admin user</small><b>{ct.adminUser.name}</b><em>{ct.adminUser.email || "—"}</em></div>}
                                  {signers.map((x, j) => (
                                    <div key={j} className={`is-sign is-${x.side}`}><small>{x.side === "supplier" ? "Signed for us" : "Signed for the client"}</small><b>{x.name}</b><em>{[x.role, x.email].filter(Boolean).join(", ") || "—"}</em></div>
                                  ))}
                                </div>
                              </section>
                            )}

                            <section className="cw-k-of-s">
                              <h5>Terms</h5>
                              <dl className="cw-k-terms">
                                {fact("Licences billed", ct?.billingFrequency ? ({ upfront: "Upfront", annually: "Annually", semiannually: "Every 6 months", quarterly: "Quarterly", monthly: "Monthly" } as Record<string, string>)[ct.billingFrequency] ?? ct.billingFrequency : "")}
                                {fact("Payment", (ct?.paymentTermsDays ?? gl[0]?.payment_terms_days) ? `${ct?.paymentTermsDays ?? gl[0]?.payment_terms_days} days` : "")}
                                {fact("Renewal", autoRenew ? `Automatic, every ${ct?.renewYears || gl.find((l) => l.renew_years)?.renew_years || termY} years` : "Not automatic")}
                                {fact("Non-terminable", (ct?.nonTerminableYears ?? gl[0]?.non_terminable_years) ? `${ct?.nonTerminableYears ?? gl[0]?.non_terminable_years} years` : "")}
                                {fact("Currency", ct?.currency ? `${ct.currency}${ct.pricesExclVat !== false ? ", excl. VAT" : ""}` : "")}
                                {fact("E-signature", ct?.esignId || "")}
                                {ct?.newsletter != null && fact("Newsletter", ct.newsletter ? "Yes" : "No")}
                                {ct?.marketingConsent != null && fact("Logo & name as reference", ct.marketingConsent ? "Yes" : "No")}
                              </dl>
                              {(ct?.termsUrl || !ct) && (
                                <p className="cw-k-of-foot">
                                  {ct?.termsUrl && <a href={ct.termsUrl} target="_blank" rel="noreferrer"><Ico n="out" s={12} />General terms, DPA and SLA</a>}
                                  {!ct && <span>No order form saved on the deal: the figures come from the signed products.</span>}
                                </p>
                              )}
                              {ct?.notes && !editing && <p className="cw-k-notes">{ct.notes}</p>}
                            </section>
                          </div>
                        </div>
                      </div>
                    </section>
                  );
                })}

                <section className="cw-box cw-pt-box" data-sec="products" style={cssVars({ "--i": contractGroups.length + 1 })}>
                  <SecHead icon="repeat" tone="violet" title="Signed products" sub={lines.length ? `${activeLines.length} active of ${lines.length}${handLines.length ? ` · ${handLines.length} added by hand` : ""}` : "Added when a deal is won, or by hand"}>
                    {lines.length > 0 && can("products") && (
                      <button className="cw-btn-primary is-sm" onClick={() => setAddLine((v) => !v)}><Ico n={addLine ? "x" : "plus"} s={14} />{addLine ? "Cancel" : "Add product"}</button>
                    )}
                  </SecHead>
                  {addLine && <AddLineForm clientId={client.id} persons={persons} contracts={contractGroups.map((g) => ({ tid: g.tid, name: dealName(g.tid) }))} onCancel={() => setAddLine(false)} onSaved={async () => { setAddLine(false); await reloadLines(); onLinesChanged?.(); }} />}
                  {lines.length === 0 ? (!addLine && (
                    can("products") ? (
                      <button className="cw-empty is-action" onClick={() => setAddLine(true)} disabled={!loaded}>
                        <span className="cw-empty-plus"><Ico n="plus" s={18} /></span>
                        <p>{loaded ? <><b>No signed products yet</b><small>Add a signed contract with one of your products</small></> : "Loading…"}</p>
                      </button>
                    ) : <div className="cw-empty"><Ico n="contract" s={20} /><p>{loaded ? "No signed products yet." : "Loading…"}</p></div>
                  )) : (
                    <div className={`cw-pt ${canValue && lines.some((l) => calcProdOf(l)) ? "has-calc" : ""}`}>
                      <div className="cw-pt-row is-head"><span>Product</span><span>Term</span><span className="is-r">Billed</span><span className="is-r">Partner</span><span className="is-r">Net</span><span>Status</span><span /></div>
                      {calcLn && (
                        <LineCalcModal
                          title={`${calcLn.prod.name} · ${dealName(String(calcLn.line.tracking_id))}`}
                          line={calcLn.tp}
                          tiers={calcLn.prod.tiers}
                          calculator={calcLn.prod.calculator as any}
                          money={(n) => eur(n)}
                          defaultIncrements={catalogIncrements(calcLn.prod as any)}
                          onApply={(patch) => void applyCalc(patch)}
                          onClose={() => setCalcLn(null)}
                        />
                      )}
                      {lines.map((l, i) => {
                        const lct = dealContracts[contractKeyOf(l)];
                        const term = termWith(l, lct);
                        const per = periodLabel(l.period);
                        const open = lnOpen.has(l.id);
                        const ed = lnEdit?.id === l.id;
                        const gross = l.recurring ? lineAnnualGross(l) : lineTotal(l) + (Number(l.one_time_fee) || 0);
                        const net = l.recurring ? lineAnnual(l) : lineOneTime(l);
                        const ptxt = partnerText(l);
                        const lv = lnEdit?.v ?? {};
                        const setLv = (patch: Record<string, any>) => setLnEdit((e) => (e ? { ...e, v: { ...e.v, ...patch } } : e));
                        const sc = scheduleOf(l);
                        const preview = ed ? (() => {
                          const rec = lv.billing !== "once";
                          const amt = num(lv.amount) ?? 0;
                          const nx = { ...l, recurring: rec, period: lv.billing === "monthly" ? "monthly" : "yearly", price: amt, quantity: 1, discount_mode: "none", discount_value: 0, term_years: rec ? num(lv.term) : 1, annual_increase_pct: num(lv.inc), breakdown: null } as Line;
                          const b = rec ? rebuildYears(nx, { mode: lv.pMode, value: num(lv.pValue) ?? 0 }) : { years: [amt], partnerYears: [lv.pMode === "percent" ? (amt * (num(lv.pValue) ?? 0)) / 100 : lv.pMode === "none" ? 0 : Math.min(amt, num(lv.pValue) ?? 0)], total: amt };
                          return b;
                        })() : null;
                        return (
                          <article key={l.id} className={`cw-pt-item ${isActive(l) ? "" : "is-off"} ${open ? "is-exp" : ""} ${ed ? "is-ed" : ""}`} style={cssVars({ "--i": i })}>
                            <div className="cw-pt-row" role="button" tabIndex={0} aria-expanded={open} onClick={() => { hideTip(); toggleLn(l.id); }} onKeyDown={(e) => { if (e.key === "Enter") toggleLn(l.id); }}>
                              <span className="cw-pt-name">
                                <span className="cw-line-ico" style={cssVars({ "--h": hue(l.name) })}>{initials(l.name)}</span>
                                <span><b>{l.name}</b><small>{l.recurring ? `Every ${per}` : "One-off"} · {l.tracking_id ? dealName(l.tracking_id) : "added by hand"}{contractKeyOf(l) && contractKeyOf(l) !== str(l.tracking_id) ? ` · upsell in ${dealName(contractKeyOf(l))}` : ""}{l.breakdown?.revalued ? ` · revalued ${fmt(String(l.breakdown.revalued).slice(0, 10))}` : ""}</small></span>
                              </span>
                              <span className="cw-pt-term">
                                {term ? <><b>{fmtMY(term.start)} → {fmtMY(term.end)}</b><i><em style={{ width: `${term.pct * 100}%` }} /></i></> : <b className="is-muted">{lineStartOf(l, lct) ? `${l.signing_date || lct?.signDate ? "Signed" : "Starts"} ${fmt(str(l.signing_date) || str(lct?.signDate) || lineStartOf(l, lct))}` : "No term"}</b>}
                              </span>
                              <span className="is-r cw-pt-v">{eur(gross)}{l.recurring && <small>/yr</small>}</span>
                              <span className="is-r cw-pt-p" {...tipOn(ptxt ? <TipCard title="Partner share" sub={ptxt} /> : null)}>{gross - net > 0.5 ? `−${eur(gross - net)}` : "—"}</span>
                              <span className="is-r cw-pt-v is-net">{eur(net)}{l.recurring && <small>/yr</small>}</span>
                              <span className="cw-pt-st">
                                <span className={`cw-status ${isActive(l) ? "is-open" : "is-closed"}`}><i />{l.status || "active"}</span>
                                {dupLines.has(l.id) && <span className="cw-status is-dup" title="The same product from the same deal is here more than once">Twice</span>}
                              </span>
                              <span className="cw-pt-acts" onClick={(e) => e.stopPropagation()}>
                                {canValue && !ed && calcProdOf(l) && <button type="button" className="cw-icon-btn is-sm cw-pt-calc" onClick={() => void openCalc(l, lines)} aria-label={`Deal calculator for ${l.name}`} {...tipOn(<TipCard title="Deal calculator" sub="Change the figures it was valued with on its deal; the product is repriced" />)}><Ico n="calc" s={13} /></button>}
                                {can("products") && !ed && <button type="button" className="cw-icon-btn is-sm" onClick={() => { startLnEdit(l); setLnOpen((s) => new Set(s).add(l.id)); }} aria-label={`Edit ${l.name}`} {...tipOn(<TipCard title="Edit this product" />)}><Ico n="edit" s={13} /></button>}
                                <button type="button" className="cw-icon-btn is-sm cw-pt-chev" onClick={() => toggleLn(l.id)} aria-label={open ? "Less" : "More"}><Ico n="chev" s={14} /></button>
                              </span>
                            </div>

                            {calcMsg?.id === l.id && <p className={`cw-pt-msg ${calcMsg.bad ? "is-bad" : ""}`} role="status">{calcMsg.text}<button type="button" onClick={() => setCalcMsg(null)} aria-label="Dismiss">×</button></p>}
                            {ed && (
                              <div className="cw-ed is-line" onMouseEnter={hideTip}>
                                <div className="cw-ed-grid">
                                  {(contractGroups.length > 1 || (contractGroups.length > 0 && !l.tracking_id) || !!lv.contract) && (
                                    <Fld label="Contract"><Select size="sm" value={lv.contract ?? ""} onChange={(x) => setLv({ contract: x })} options={[
                                      { value: "", label: l.tracking_id ? `Its own · ${dealName(String(l.tracking_id))}` : "A contract of its own" },
                                      ...contractGroups.filter((g) => g.tid !== str(l.tracking_id)).map((g) => ({ value: g.tid, label: `Upsell into ${dealName(g.tid)}`, hint: "Counts in that contract" })),
                                    ]} /></Fld>
                                  )}
                                  <Fld label="Status"><Select size="sm" value={lv.status} onChange={(x) => setLv({ status: x })} options={[
                                    { value: "active", label: "Active" }, { value: "paused", label: "Paused" }, { value: "cancelled", label: "Cancelled" }, { value: "ended", label: "Ended" },
                                  ]} /></Fld>
                                  <Fld label="Billed"><Select size="sm" value={lv.billing} onChange={(x) => setLv({ billing: x })} options={[
                                    { value: "yearly", label: "Every year" }, { value: "monthly", label: "Every month" }, { value: "once", label: "One-off" },
                                  ]} /></Fld>
                                  <Fld label={lv.billing === "once" ? "Price" : `Price a ${lv.billing === "monthly" ? "month" : "year"} (year 1)`}><span className="cw-ed-unit"><input inputMode="decimal" value={lv.amount} onChange={(e) => setLv({ amount: e.target.value })} /><em>€</em></span></Fld>
                                  <Fld label="Set-up fee"><span className="cw-ed-unit"><input inputMode="decimal" value={lv.fee} placeholder="0" onChange={(e) => setLv({ fee: e.target.value })} /><em>€</em></span></Fld>
                                  <Fld label="Signed"><span className="cw-date"><DatePicker value={lv.signing} onChange={(d) => setLv({ signing: d })} /></span></Fld>
                                  <Fld label="Starts"><span className="cw-date"><DatePicker value={lv.start} onChange={(d) => setLv({ start: d })} /></span></Fld>
                                  {lv.billing !== "once" && <Fld label="Term (years)"><input inputMode="decimal" value={lv.term} placeholder="1" onChange={(e) => setLv({ term: e.target.value })} /></Fld>}
                                  {lv.billing !== "once" && (
                                    <Fld label="Increase a year">
                                      {sc && sc.count > 1 ? <span className="cw-ed-note">Per term · {sc.increases.filter(Boolean).map((x) => `+${x}%`).join(", ") || "none"}</span>
                                        : <span className="cw-ed-unit"><input inputMode="decimal" value={lv.inc} placeholder="0" onChange={(e) => setLv({ inc: e.target.value })} /><em>%</em></span>}
                                    </Fld>
                                  )}
                                  <Fld label="Partner share" span={2}>
                                    <span className="cw-ed-inline">
                                      <Select size="sm" value={lv.pMode} onChange={(x) => setLv({ pMode: x })} options={[
                                        { value: "none", label: "No partner" }, { value: "percent", label: "% of every year" }, { value: "amount", label: "Amount a year" }, { value: "once", label: "Once, year 1" },
                                      ]} />
                                      {lv.pMode !== "none" && <span className="cw-ed-unit is-sm"><input inputMode="decimal" value={lv.pValue} placeholder="0" onChange={(e) => setLv({ pValue: e.target.value })} /><em>{lv.pMode === "percent" ? "%" : "€"}</em></span>}
                                    </span>
                                  </Fld>
                                  {lv.billing !== "once" && (
                                    <Fld label="Renewal">
                                      <span className="cw-ed-inline">
                                        <Toggle on={!!lv.autoRenew} onClick={() => setLv({ autoRenew: !lv.autoRenew })} label={lv.autoRenew ? "Automatic" : "No"} />
                                        {lv.autoRenew && <><em>every</em><input className="is-xs" inputMode="decimal" value={lv.renew} placeholder={String(lv.term || 1)} onChange={(e) => setLv({ renew: e.target.value })} /><em>y</em></>}
                                      </span>
                                    </Fld>
                                  )}
                                  <Fld label="Non-terminable (years)"><input inputMode="decimal" value={lv.nonTerm} placeholder="—" onChange={(e) => setLv({ nonTerm: e.target.value })} /></Fld>
                                  <Fld label="Payment (days)"><input inputMode="numeric" value={lv.pay} placeholder="30" onChange={(e) => setLv({ pay: e.target.value })} /></Fld>
                                  <Fld label="Contract no."><input value={lv.ref} placeholder="—" onChange={(e) => setLv({ ref: e.target.value })} /></Fld>
                                </div>
                                {preview && (
                                  <div className="cw-ed-prev">
                                    {preview.years.map((y, k) => (
                                      <span key={k}><i>{lv.billing === "once" ? "Once" : `Year ${k + 1}`}</i><b>{eur(y - (preview.partnerYears[k] ?? 0))}</b>{(preview.partnerYears[k] ?? 0) > 0.5 && <em>{eur(y)} − {eur(preview.partnerYears[k])} partner</em>}</span>
                                    ))}
                                  </div>
                                )}
                                {lnErr && <p className="cw-err">{lnErr}</p>}
                                <div className="cw-ed-foot">
                                  <span>Net to us, year by year, as it will count in the ARR and the client list.</span>
                                  <button type="button" className="cw-ghost" onClick={() => setLnEdit(null)}>Cancel</button>
                                  <button type="button" className="cw-btn-primary is-sm" disabled={lnBusy} onClick={() => void saveLnEdit(l)}>{lnBusy ? "Saving…" : "Save product"}</button>
                                </div>
                              </div>
                            )}

                            <div className={`cw-reveal ${open && !ed ? "is-on" : ""}`} aria-hidden={!open || ed}>
                              <div className="cw-reveal-in">
                                <div className="cw-pt-more">
                                  <div className="cw-pt-cols">
                                    <dl className="cw-dl">
                                      {([
                                        ["Signed", (l.signing_date || lct?.signDate) ? fmt(l.signing_date || lct?.signDate) : ""],
                                        ["Starts", lineStartOf(l, lct) ? fmt(lineStartOf(l, lct)) : ""],
                                        [(l.auto_renew || lct?.autoRenew) ? "Renews" : "Ends", term ? fmtD(term.end) : ""],
                                        ["Term", (l.term_years || lct?.termYears) ? `${l.term_years || lct?.termYears} ${Number(l.term_years || lct?.termYears) === 1 ? "year" : "years"}` : ""],
                                        ["Price", `${eur(lineTotal(l))}${l.recurring ? ` a ${per}` : ""}`],
                                        ["Yearly increase", Number(l.annual_increase_pct) ? `${l.annual_increase_pct}%` : ""],
                                        ["Set-up fee", Number(l.one_time_fee) ? eur(Number(l.one_time_fee)) : ""],
                                        ["Renewal", l.recurring ? (l.auto_renew ? `Automatic${l.renew_years ? `, every ${l.renew_years} years` : ""}` : "Not automatic") : ""],
                                        ["Non-terminable", l.non_terminable_years ? `${l.non_terminable_years} years` : ""],
                                        ["Payment", l.payment_terms_days ? `${l.payment_terms_days} days` : ""],
                                        ["Contract no.", str(l.contract_ref)],
                                        ["Bill to", str(l.billing_contact_name)],
                                        ["Partner", ptxt],
                                        ["From", l.tracking_id ? dealName(l.tracking_id) : "Added by hand"],
                                      ] as [string, string][]).filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
                                    </dl>
                                    <div className="cw-pt-years">
                                      <div className="cw-pt-yr is-head"><span>{l.recurring ? "Year" : "Paid"}</span><span>Billed</span><span>Partner</span><span>Net</span></div>
                                      {Array.from({ length: yearsOf(l) }, (_, y) => {
                                        const g = lineYearGross(l, y), pc = partnerCut(l, y);
                                        const now = l.recurring && runsAt(l) && contractYearOf(l) === y;
                                        return (
                                          <div key={y} className={`cw-pt-yr ${now ? "is-now" : ""}`}>
                                            <span>{l.recurring ? <>Year {y + 1}{now && <i>now</i>}</> : "Once"}</span>
                                            <span>{eur(g)}</span>
                                            <span className="is-p">{pc > 0.5 ? `−${eur(pc)}` : "—"}</span>
                                            <span><b>{eur(Math.max(0, g - pc))}</b></span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                  {l.recurring && (Number(l.term_years) || 0) > 1 && (() => {
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
                                            {can("products") && (
                                              <button className="cw-linkbtn" onClick={() => { setSchedErr(null); setSchedEdit({ id: l.id, v: sc ?? { count: 1, increases: [] } }); }}>
                                                {sc && sc.count > 1 ? "Edit terms" : "Split into terms"}<Ico n="arrow" s={12} />
                                              </button>
                                            )}
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
                                  {can("products") && (
                                    <div className="cw-pt-foot">
                                      {delLineErr?.id === l.id && <p className="cw-err">{delLineErr.msg}</p>}
                                      <span className={`cw-line-del is-shown ${delLine === l.id ? "is-asking" : ""}`}>
                                        {delLine === l.id ? (
                                          <>
                                            <span>Delete this signed product?</span>
                                            <button className="is-yes" disabled={delLineBusy} onClick={() => void deleteLine(l.id)}>{delLineBusy ? "Deleting…" : "Delete"}</button>
                                            <button disabled={delLineBusy} onClick={() => { setDelLine(null); setDelLineErr(null); }}>Keep</button>
                                          </>
                                        ) : (
                                          <button className="cw-pt-delbtn" onClick={() => { setDelLineErr(null); setDelLine(l.id); }}><Ico n="trash" s={13} />Delete</button>
                                        )}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                      <div className="cw-pt-row is-tot">
                        <span><b>Running today</b></span><span />
                        <span className="is-r cw-pt-v">{eur(grossYear)}<small>/yr</small></span>
                        <span className="is-r cw-pt-p">{partnerYearNow > 0.5 ? `−${eur(partnerYearNow)}` : "—"}</span>
                        <span className="is-r cw-pt-v is-net">{eur(recurringYear)}<small>/yr</small></span>
                        <span /><span />
                      </div>
                    </div>
                  )}
                </section>

                <section className="cw-card cw-box" data-sec="services">
                  <SecHead icon="briefcase" tone="green" title="Service engagements" sub={projects.length ? `${projects.length} project${projects.length === 1 ? "" : "s"} · open one to see its roles, days and team` : "Services sold, delivered as projects"} />
                  {(() => {
                    // Agreed in a contract but not built as a project yet (management builds it from the handoff).
                    const agreed = Object.values(dealContracts).flatMap((ct) => (ct.lines ?? []).filter((ln) => ln.kind === "service").map((ln) => ({ ln, ct })));
                    if (projects.length > 0 || !agreed.length) return null;
                    return (
                      <div className="cw-eng">
                        <div className="cw-eng-row is-head"><span>Agreed in the contract</span><span>Signed</span><span>Days</span><span>Billed</span><span className="is-r">Value</span></div>
                        {agreed.map(({ ln, ct }, i) => (
                          <div className="cw-eng-row is-static" key={i} style={cssVars({ "--i": i })}>
                            <span data-k="Service"><b>{ln.name}</b></span>
                            <span data-k="Signed">{ct.signDate ? fmt(ct.signDate) : "—"}</span>
                            <span data-k="Days">{ln.qty ?? "—"}</span>
                            <span data-k="Billed">{ct.servicesBilling === "fixed" ? "Fixed fee" : `Per day${ct.servicesTolerancePct ? ` ±${ct.servicesTolerancePct}%` : ""}`}</span>
                            <span data-k="Value" className="is-r"><b>{eur(ln.final)}</b></span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  {projects.length === 0 ? (Object.values(dealContracts).some((ct) => (ct.lines ?? []).some((ln) => ln.kind === "service")) ? null : <div className="cw-empty"><Ico n="briefcase" s={20} /><p>No projects signed yet.</p></div>) : (
                    <div className="cw-pt cw-pj-list">
                      <div className="cw-pj-row is-head"><span>Service</span><span>Status</span><span>Delivered</span><span className="is-r">Value</span><span>Team</span><span /></div>
                      {projects.map((p, i) => projectRow(p, i, false))}
                      {projTotal(projects)}
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

            {/* ===== EMAILS ===== */}
            {tab === "tickets" && <ClientTickets client={client} companyId={str(co.id) || null} />}
            {tab === "emails" && <ClientMail client={client} persons={persons} />}

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

/* ============================== Tickets ============================== */
const TK_OPEN: TicketStage[] = ["new", "open", "in_progress", "waiting"];
/** Clients › Tickets: the client's requests and incidents (the desk's tickets — not its e-mails, not tasks). */
function ClientTickets({ client, companyId }: { client: Client; companyId: string | null }) {
  const [list, setList] = useState<Ticket[] | null>(null);
  const [ready, setReady] = useState(true);
  const [view, setView] = useState<"open" | "done" | "all">("open");
  const [open, setOpen] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await loadClientTickets(client.id, companyId);
    setList(r.tickets); setReady(r.ready);
  }, [client.id, companyId]);
  useEffect(() => { void load(); }, [load]);
  const isOpen = (t: Ticket) => TK_OPEN.includes(t.stage);
  const shown = (list ?? []).filter((t) => view === "all" || (view === "open" ? isOpen(t) : !isOpen(t)));
  const nOpen = (list ?? []).filter(isOpen).length;
  const add = async () => {
    const t = title.trim(); if (!t) return;
    setBusy(true); setErr(null);
    const r = await createTicket({ title: t, clientId: client.id, companyId, category: "ticket", source: "manual" }, ready);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setTitle(""); await load();
    if (r.id) setOpen(r.id);
  };
  return (
    <div className="cw-tk">
      <header className="cw-folders-h cw-tk-h">
        <span className="cw-zone-ico"><Ico n="tasks" s={18} /></span>
        <div className="cw-folders-t">
          <h3>Tickets</h3>
          <small>{list === null ? "Loading…" : `${nOpen} open · ${list.length} in all — their requests and incidents, apart from their e-mails`}</small>
        </div>
        <div className="cw-tk-seg" role="tablist">
          {([["open", "Open", nOpen], ["done", "Resolved", (list ?? []).length - nOpen], ["all", "All", (list ?? []).length]] as const).map(([k, l, n]) => (
            <button type="button" key={k} role="tab" aria-selected={view === k} className={view === k ? "is-on" : ""} onClick={() => setView(k)}>{l}<i>{n}</i></button>
          ))}
        </div>
      </header>
      <form className="cw-tk-new" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Ico n="plus" s={15} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New ticket for this client — what do they need?" maxLength={200} />
        <button type="submit" className="cw-btn-primary is-sm" disabled={!title.trim() || busy}>{busy ? "Opening…" : "Open ticket"}</button>
      </form>
      {err && <p className="cw-tk-err">{err}</p>}
      {list !== null && shown.length === 0 && (
        <div className="cw-empty"><Ico n="tasks" s={20} /><p>{view === "open" ? "No open tickets." : view === "done" ? "Nothing resolved yet." : "No tickets for this client yet."}</p></div>
      )}
      <div className="cw-tk-list">
        {shown.map((t, i) => (
          <button type="button" key={t.id} className={`cw-tk-row is-${t.stage}`} style={cssVars({ "--i": Math.min(i, 12) })} onClick={() => setOpen(t.id)}>
            <span className="cw-tk-ref">{ticketRef(t)}</span>
            <span className="cw-tk-main">
              <b>{t.title || "Untitled"}</b>
              <em>{[t.requesterName || t.requesterEmail, t.type, `opened ${ago(t.createdAt)}`].filter(Boolean).join(" · ")}</em>
            </span>
            {t.priority !== "normal" && <span className={`cw-tk-pri is-${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>}
            <span className={`cw-tk-st is-${t.stage}`}>{stageLabel(t.stage)}</span>
            <span className="cw-tk-go"><Ico n="chev" s={14} /></span>
          </button>
        ))}
      </div>
      {open && <TicketDrawerById id={open} onClose={() => { setOpen(null); void load(); }} />}
    </div>
  );
}

/* ============================== Emails ============================== */

/** Domains anyone can have: never offered as "all mail from @…". */
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|web|mail|yandex|zoho)\./i;
const lcm = (s: unknown) => String(s ?? "").trim().toLowerCase();
/** "ana@acme.es" or "@acme.es" (a bare "acme.es" becomes "@acme.es"); null when it isn't either. */
const routeAddr = (raw: string): string | null => {
  let v = lcm(raw).replace(/^mailto:/, "").replace(/[<>,;\s]/g, "");
  if (!v) return null;
  if (!v.includes("@")) v = `@${v}`;
  return /^[^@\s]*@[^@\s.]+(\.[^@\s.]+)+$/.test(v) ? v : null;
};
const mailWhen = (iso: string) => {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
};
const mailFull = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** The client's own mail rule (Clients › Emails): who it catches and what happens. */
const clientRuleOf = (rules: MailRule[], clientId: string) => rules.filter((r) => r.scope === "client" && r.set.client_id === clientId);

/** Saves the routing of one client: the addresses / @domains that bring mail here, and whether it also opens a ticket. */
async function saveClientRoute(clientId: string, clientName: string, rule: MailRule | null, addrs: string[], action: "file" | "create"): Promise<string | null> {
  if (!addrs.length) return rule ? deleteMailRule(rule.id) : null;
  return saveMailRule({
    ...(rule ?? {}), id: rule?.id, name: rule?.name || `${clientName} · e-mail`, sort: rule?.sort ?? 0, active: rule?.active ?? true,
    conditions: { ...(rule?.conditions ?? {}), match: "any", from_emails: addrs }, action, targetTicketId: null,
    set: { ...(rule?.set ?? {}), client_id: clientId }, scope: "client", ownerId: null,
  });
}

/** Address chips with an input to add more (and a few suggestions). */
interface RoutePerson { email: string; name: string; sub?: string }
/**
 * The addresses of a mail rule: a whole domain ("@acme.es", everyone at the company) or one person.
 * Chips, an input for anything typed, the company's domains as one-click suggestions and a picker of its people.
 */
function RouteChips({ addrs, suggest = [], people = [], busy, onChange, placeholder }: {
  addrs: string[]; suggest?: string[]; people?: RoutePerson[]; busy?: boolean; placeholder: string; onChange: (next: string[], added: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);
  const add = (raw: string) => {
    const parts = raw.split(/[,;\s]+/).map(routeAddr);
    if (parts.some((x) => x === null) && raw.trim()) { setBad(true); return; }
    const fresh = [...new Set(parts.filter((x): x is string => !!x))].filter((x) => !addrs.includes(x));
    setDraft(""); setBad(false);
    if (fresh.length) onChange([...addrs, ...fresh], fresh);
  };
  const byMail = new Map(people.map((p) => [lcm(p.email), p]));
  const domains = suggest.filter((d) => !addrs.includes(d)).slice(0, 3);
  const left = people.filter((p) => p.email && !addrs.includes(lcm(p.email)));
  return (
    <div className="cw-mr-field">
      <div className={`cw-mr-chips ${bad ? "is-bad" : ""}`}>
        {addrs.map((a) => {
          const p = a.startsWith("@") ? null : byMail.get(a);
          return (
            <span className={`cw-mr-chip ${a.startsWith("@") ? "is-domain" : p ? "is-person" : ""}`} key={a} title={a.startsWith("@") ? `Everyone at ${a.slice(1)}` : a}>
              <Ico n={a.startsWith("@") ? "globe" : p ? "user" : "mail"} s={12} />
              {a.startsWith("@") ? <>{a}<em>everyone</em></> : p ? <>{p.name}<em>{a}</em></> : a}
              <button type="button" disabled={busy} onClick={() => onChange(addrs.filter((x) => x !== a), [])} aria-label={`Remove ${a}`}><Ico n="x" s={11} /></button>
            </span>
          );
        })}
        <input value={draft} placeholder={placeholder} disabled={busy} aria-label="Add an address or @domain"
          onChange={(e) => { setDraft(e.target.value); setBad(false); }}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === ",") && draft.trim()) { e.preventDefault(); add(draft); }
            else if (e.key === "Backspace" && !draft && addrs.length) onChange(addrs.slice(0, -1), []);
          }}
          onBlur={() => { if (draft.trim()) add(draft); }} />
      </div>
      {(domains.length > 0 || left.length > 0) && (
        <div className="cw-mr-adds">
          {domains.map((d) => (
            <button type="button" key={d} className="cw-mr-sug" disabled={busy} onClick={() => onChange([...addrs, d], [d])} title={`Everyone who writes from ${d}`}>
              <Ico n="globe" s={11} />Everyone at {d}
            </button>
          ))}
          {left.length > 0 && (
            <div className="cw-mr-pick">
              <Select searchable size="sm" value="" disabled={busy} placeholder="+ One person…" onChange={(v) => v && onChange([...addrs, v], [v])}
                options={left.map((p) => ({ value: lcm(p.email), label: p.name, hint: [p.sub, lcm(p.email)].filter(Boolean).join(" · ") }))} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type MailWho = "all" | "out" | string;   // a sender's address (lower case)
/** Clients › Emails: what this client's people wrote (and what we answered), by person, with the rule that files it here. */
function ClientMail({ client, persons }: { client: Client; persons: Person[] }) {
  const [msgs, setMsgs] = useState<MailMsg[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [rules, setRules] = useState<MailRule[]>([]);
  const [who, setWho] = useState<MailWho>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [routing, setRouting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Senders who aren't this client's people but are in Contacts (any company). */
  const [found, setFound] = useState<Map<string, { name: string; sub: string }>>(new Map());

  const load = useCallback(async () => {
    const { data: tks } = await supabase.from("tracking_tasks").select("id").eq("client_id", client.id).not("ticket_no", "is", null).limit(150);
    const [m, r] = await Promise.all([loadClientMail(client.id, ((tks ?? []) as any[]).map((t) => String(t.id))), loadMailRules()]);
    setMissing(m === null);
    setMsgs((m ?? []).slice().sort((a, b) => b.at.localeCompare(a.at)));
    setRules(clientRuleOf(r ?? [], client.id));
  }, [client.id]);
  useEffect(() => { void load(); }, [load]);

  const byEmail = useMemo(() => {
    const m = new Map<string, Person>();
    persons.forEach((p) => { const e = lcm(p.email); if (e) m.set(e, p); });
    return m;
  }, [persons]);
  // senders we don't know from this client: look them up in Contacts
  useEffect(() => {
    const miss = [...new Set((msgs ?? []).filter((m) => m.direction === "in").map((m) => lcm(m.fromEmail)))]
      .filter((e) => e && !byEmail.has(e) && /^[^,()\s]+@[^,()\s]+$/.test(e)).slice(0, 80);
    if (!miss.length) return;
    let alive = true;
    void supabase.from("contacts").select("id, first_name, last_name, email, position").or(miss.map((e) => `email.ilike.${e}`).join(",")).limit(200)
      .then(({ data }) => {
        if (!alive) return;
        const m = new Map<string, { name: string; sub: string }>();
        ((data ?? []) as any[]).forEach((c) => {
          const e = lcm(c.email);
          if (e && miss.includes(e)) m.set(e, { name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || e, sub: str(c.position) || "In Contacts" });
        });
        setFound(m);
      });
    return () => { alive = false; };
  }, [msgs, byEmail]);
  /** Where we know a person from: the client's contacts (Companies / Contacts) or the contract / project sheet. */
  const personSub = (p: Person) => p.position || (p.crm ? "Contact" : "On the contract");
  const senders = useMemo(() => {
    const map = new Map<string, { email: string; name: string; sub: string; n: number; last: string; kind: "client" | "crm" | "other" }>();
    (msgs ?? []).forEach((m) => {
      if (m.direction !== "in") return;
      const e = lcm(m.fromEmail);
      if (!e) return;
      const p = byEmail.get(e) ?? null, f = found.get(e) ?? null;
      const cur = map.get(e) ?? {
        email: e, name: p?.name || f?.name || m.fromName || e, sub: p ? personSub(p) : f ? f.sub : e, n: 0, last: m.at,
        kind: p ? "client" as const : f ? "crm" as const : "other" as const,
      };
      cur.n += 1;
      if (m.at > cur.last) cur.last = m.at;
      map.set(e, cur);
    });
    const all = [...map.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last));
    return { known: all.filter((s) => s.kind !== "other"), others: all.filter((s) => s.kind === "other") };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, byEmail, found]);
  const sent = (msgs ?? []).filter((m) => m.direction === "out").length;
  const quietList = persons.filter((p) => lcm(p.email) && !senders.known.some((s) => s.email === lcm(p.email)));
  const quiet = quietList.length;
  /** Everyone a rule can name: the client's people, then the other senders. */
  const people = useMemo<RoutePerson[]>(() => {
    const seen = new Set<string>(), out: RoutePerson[] = [];
    persons.forEach((p) => { const e = lcm(p.email); if (e && !seen.has(e)) { seen.add(e); out.push({ email: e, name: p.name, sub: personSub(p) }); } });
    [...senders.known, ...senders.others].forEach((x) => { if (!seen.has(x.email)) { seen.add(x.email); out.push({ email: x.email, name: x.name, sub: x.kind === "other" ? "Wrote to us" : x.sub }); } });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persons, senders]);
  const nameOf = (a: string) => (a.startsWith("@") ? a : people.find((p) => p.email === a)?.name ?? a);

  const shown = useMemo(() => {
    const t = lcm(q);
    return (msgs ?? []).filter((m) => {
      if (who === "out" && m.direction !== "out") return false;
      if (who !== "all" && who !== "out") {
        const hit = m.direction === "in" ? lcm(m.fromEmail) === who : [...m.to, ...m.cc].some((x) => lcm(x.email) === who);
        if (!hit) return false;
      }
      return !t || `${m.subject} ${m.fromName ?? ""} ${m.fromEmail ?? ""} ${m.snippet}`.toLowerCase().includes(t);
    });
  }, [msgs, who, q]);
  const cur = shown.find((m) => m.id === sel) ?? shown[0] ?? null;

  /* ---- routing: this client's rule ---- */
  const rule = rules[0] ?? null;
  const addrs = rule?.conditions.from_emails ?? [];
  const action: "file" | "create" = rule?.action === "create" ? "create" : "file";
  const suggest = useMemo(() => {
    const ds = new Map<string, number>();
    [...persons.map((p) => p.email), ...senders.others.map((s) => s.email)].forEach((e) => {
      const d = lcm(e).split("@")[1];
      if (d && !FREE_MAIL.test(d)) ds.set(`@${d}`, (ds.get(`@${d}`) ?? 0) + 1);
    });
    return [...ds.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  }, [persons, senders.others]);
  const route = async (next: string[], act: "file" | "create", added: string[] = []) => {
    setBusy("route"); setErr(null);
    let e = await saveClientRoute(client.id, client.name, rule, next, act);
    if (!e && added.length) e = await fileMailFrom(client.id, added, act === "file");
    if (!e && act !== action && next.length && act === "file") e = await fileMailFrom(client.id, next, true);
    setBusy(null); setErr(e);
    await load();
  };

  const makeTicket = async (m: MailMsg) => {
    setBusy(m.id); setErr(null);
    const dir = await loadDirectory();
    const res = await createTicketFromMail(m, dir, true, { clientId: client.id });
    setBusy(null);
    if (res.error) { setErr(res.error); return; }
    await load();
    if (res.id) setTicket(res.id);
  };
  const unfile = async (m: MailMsg) => {
    setBusy(m.id); setErr(null);
    const e = await setMailClient(m, null);
    setBusy(null);
    if (e) setErr(e); else { setSel(null); await load(); }
  };

  const whoOpts = [
    { value: "all", label: `Everyone (${msgs?.length ?? 0})` },
    ...(sent ? [{ value: "out", label: `Sent by us (${sent})` }] : []),
    ...[...senders.known, ...senders.others].map((s) => ({ value: s.email, label: `${s.name} (${s.n})` })),
    ...quietList.map((p) => ({ value: lcm(p.email), label: `${p.name} (0)` })),
  ];
  const routeLine = addrs.length
    ? <>Mail from <b>{addrs.slice(0, 2).map(nameOf).join(", ")}</b>{addrs.length > 2 ? ` and ${addrs.length - 2} more` : ""} lands here{action === "create" ? " and opens a ticket" : ""}, along with mail from this client's contacts.</>
    : <>Mail from this client's contacts lands here. Add their domain so new addresses are caught too.</>;

  return (
    <div className="cw-mail">
      <header className="cw-folders-h cw-mail-h">
        <span className="cw-zone-ico"><Ico n="mail" s={18} /></span>
        <div className="cw-folders-t">
          <h3>Emails</h3>
          <small>{routeLine}</small>
        </div>
        <button type="button" className={`cw-mail-route ${routing ? "is-on" : ""} ${addrs.length ? "" : "is-new"}`} onClick={() => setRouting(!routing)} aria-expanded={routing}>
          <Ico n="filter" s={14} />{addrs.length ? <>Mail rule<i>{addrs.length}</i></> : "Add a mail rule"}<span className="cw-mail-route-chev"><Ico n="chev" s={13} /></span>
        </button>
      </header>

      {routing && (
        <div className="cw-mr">
          <div className="cw-mr-row">
            <span className="cw-mr-k">When mail comes from</span>
            <RouteChips addrs={addrs} suggest={suggest} people={people} busy={busy === "route"} placeholder={addrs.length ? "Type an address or @domain" : "@acme.com or ana@acme.com"}
              onChange={(next, added) => void route(next, action, added)} />
          </div>
          <div className="cw-mr-row">
            <span className="cw-mr-k">Then</span>
            <div className="cw-mr-seg" role="radiogroup">
              {([["file", "Keep it here", "Out of the desk's Inbox"], ["create", "Keep it here and open a ticket", "Each new conversation becomes a ticket"]] as const).map(([k, l, h]) => (
                <button type="button" key={k} role="radio" aria-checked={action === k} className={action === k ? "is-on" : ""} disabled={!addrs.length || busy === "route"}
                  onClick={() => action !== k && void route(addrs, k)}><b>{l}</b><small>{h}</small></button>
              ))}
            </div>
          </div>
          <p className="cw-mr-note"><Ico n="clock" s={12} />Runs on new mail the desk reads (shared mailboxes and the inboxes people turned on). Mail already in the desk from these addresses moves here when you add them.{rules.length > 1 ? ` ${rules.length - 1} more rule${rules.length === 2 ? "" : "s"} for this client in Settings › Clients.` : ""}</p>
        </div>
      )}
      {missing && <p className="cw-err">{MAIL_ROUTING_SQL}</p>}
      {err && <p className="cw-err">{err}</p>}

      {msgs && msgs.length === 0 ? (
        <div className="cw-mail-zero">
          <span className="cw-empty-plus"><Ico n="mail" s={20} /></span>
          <b>No e-mails from this client yet</b>
          <small>{addrs.length ? "New mail from their addresses will show up here." : quiet ? `Mail from their ${quiet} contact${quiet === 1 ? "" : "s"} lands here on its own. Add their @domain so new addresses are caught too.` : "Add a mail rule so their e-mails land here."}</small>
        </div>
      ) : (
      <div className="cw-mail-box">

        <div className="cw-mail-list">
          <div className="cw-mail-bar">
            <label className="cw-mail-search"><Ico n="search" s={14} />
              <input value={q} placeholder="Search subject, sender, text" onChange={(e) => { setQ(e.target.value); setSel(null); }} />
              {q && <button type="button" onClick={() => setQ("")} aria-label="Clear"><Ico n="x" s={12} /></button>}
            </label>
            <div className="cw-mail-whopick"><Select value={who} onChange={(v) => { setWho(v || "all"); setSel(null); }} options={whoOpts} /></div>
          </div>
          <div className="cw-mail-items">
            {!msgs ? [0, 1, 2, 3].map((k) => <span key={k} className="cw-mail-skel" />)
              : !shown.length ? (
                <div className="cw-mail-empty">
                  <span className="cw-empty-plus"><Ico n="mail" s={18} /></span>
                  <b>{!msgs.length ? "No e-mails yet" : who !== "all" && who !== "out" && !q ? `Nothing from ${nameOf(who)} yet` : "Nothing matches"}</b>
                  <small>{msgs.length ? (who !== "all" && who !== "out" && !q ? "Mail they send, or that we send them, shows up here." : "Try another person or search.") : addrs.length ? "New mail from their addresses will show up here." : "Add a mail rule above, or wait for their contacts to write."}</small>
                </div>
              ) : shown.map((m, i) => {
                const out = m.direction === "out";
                const name = out ? (m.to[0]?.name || m.to[0]?.email || "—") : (byEmail.get(lcm(m.fromEmail))?.name || m.fromName || m.fromEmail || "Unknown");
                return (
                  <button type="button" key={m.id} className={`cw-mail-it ${cur?.id === m.id ? "is-on" : ""} ${out ? "is-out" : ""}`} style={cssVars({ "--i": Math.min(i, 12) })} onClick={() => setSel(m.id)}>
                    <span className="cw-mail-av">{out ? <Ico n="send" s={12} /> : initials(name)}</span>
                    <span className="cw-mail-it-m">
                      <span className="cw-mail-it-top"><b>{out ? `To ${name}` : name}</b><time>{mailWhen(m.at)}</time></span>
                      <span className="cw-mail-it-s">{m.subject || "(no subject)"}</span>
                      <span className="cw-mail-it-x">{m.snippet}</span>
                      {(m.ticketId || (m.status === "new" && !m.ticketId) || m.attachments.length > 0) && (
                        <span className="cw-mail-tags">
                          {m.ticketId && <i className="is-ticket">Ticket</i>}
                          {m.status === "new" && !m.ticketId && !out && <i className="is-inbox">In the desk Inbox</i>}
                          {m.attachments.length > 0 && <i><Ico n="file" s={10} />{m.attachments.length}</i>}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>

        <div className="cw-mail-read">
          {cur ? (
            <>
              <header className="cw-mail-rh">
                <h4>{cur.subject || "(no subject)"}</h4>
                <div className="cw-mail-rmeta">
                  <span className="cw-mail-av is-lg">{cur.direction === "out" ? <Ico n="send" s={14} /> : initials(byEmail.get(lcm(cur.fromEmail))?.name || cur.fromName || cur.fromEmail || "?")}</span>
                  <div className="cw-mail-rwho">
                    <span className="cw-mail-rwho-top"><b>{cur.direction === "out" ? "Sent by us" : byEmail.get(lcm(cur.fromEmail))?.name || cur.fromName || cur.fromEmail}</b><time>{mailFull(cur.at)}</time></span>
                    <small title={[cur.fromEmail, ...cur.to.map((x) => x.email), ...cur.cc.map((x) => x.email)].filter(Boolean).join(", ")}>{cur.fromEmail}{cur.to.length ? ` → ${cur.to.map((x) => x.email).join(", ")}` : ""}{cur.cc.length ? ` · cc ${cur.cc.map((x) => x.email).join(", ")}` : ""}</small>
                  </div>
                </div>
                <div className="cw-mail-ract">
                  {cur.ticketId ? (
                    <button type="button" className="cw-btn-primary is-sm" onClick={() => setTicket(cur.ticketId)}><Ico n="tasks" s={14} />Open ticket</button>
                  ) : cur.direction === "in" && (
                    <button type="button" className="cw-btn-primary is-sm" disabled={busy === cur.id} onClick={() => void makeTicket(cur)}><Ico n="plus" s={14} />{busy === cur.id ? "Opening…" : "Make a ticket"}</button>
                  )}
                  {cur.clientId === client.id && !cur.ticketId && (
                    <button type="button" className="cw-mail-ghost" disabled={busy === cur.id} onClick={() => void unfile(cur)}
                      {...{ title: cur.status === "filed" ? "Take it off this client; it goes back to the desk's Inbox" : "Take it off this client" }}><Ico n="x" s={13} />Not this client</button>
                  )}
                </div>
              </header>
              <div className="cw-mail-body" key={cur.id}>
                <MailFrame html={cur.html || `<p>${escHtml(cur.snippet || "")}</p>`} maxHeight={20000} />
                {cur.attachments.length > 0 && (
                  <p className="cw-mail-att"><Ico n="file" s={13} />{cur.attachments.map((a) => a.name).join(" · ")}{cur.ticketId ? " — open the ticket to download" : ""}</p>
                )}
              </div>
            </>
          ) : (
            <div className="cw-mail-none"><Ico n="mail" s={26} /><span>{msgs === null ? "Loading…" : "Pick an e-mail to read it"}</span></div>
          )}
        </div>
      </div>
      )}
      {ticket && <TicketDrawerById id={ticket} onClose={() => { setTicket(null); void load(); }} />}
    </div>
  );
}

/** Settings › Clients: every client's mail rule in one list. */
export function ClientMailRulesEditor({ canEdit }: { canEdit: boolean }) {
  const [rules, setRules] = useState<MailRule[] | null>(null);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<string>("");
  const load = useCallback(async () => {
    const [r, c] = await Promise.all([loadMailRules(), supabase.from("clients").select("id, name").order("name")]);
    setRules((r ?? []).filter((x) => x.scope === "client"));
    if (r === null) setErr(MAIL_ROUTING_SQL);
    setClients(((c.data ?? []) as any[]).map((x) => ({ id: String(x.id), name: x.name ?? "" })));
  }, []);
  useEffect(() => { void load(); }, [load]);
  const nameOf = (id?: string | null) => clients.find((c) => c.id === id)?.name ?? "Unknown client";
  const run = async (key: string, p: Promise<string | null>) => { setBusy(key); setErr(null); const e = await p; setBusy(null); setErr(e); await load(); return e; };
  const list = (rules ?? []).slice().sort((a, b) => nameOf(a.set.client_id).localeCompare(nameOf(b.set.client_id)));
  const taken = new Set(list.map((r) => r.set.client_id));
  return (
    <div className="cmr">
      <p className="st-note">Mail from these addresses or domains is filed in the client's <b>Emails</b> tab — and, if you choose, opens a ticket. Mail from a client's own contacts is filed there anyway; a domain catches everyone else at the company.</p>
      {err && <p className="cmr-err">{err}</p>}
      {!rules ? <div className="cmr-skel" /> : (
        <div className="cmr-list">
          {!list.length && <p className="cmr-empty">No client has a mail rule yet. Add one here, or from a client's Emails tab.</p>}
          {list.map((r) => {
            const a = r.conditions.from_emails ?? [];
            const act: "file" | "create" = r.action === "create" ? "create" : "file";
            return (
              <div className={`cmr-row ${r.active ? "" : "is-off"}`} key={r.id}>
                <div className="cmr-client"><b>{nameOf(r.set.client_id)}</b><small>{r.hits ? `Used ${r.hits} time${r.hits === 1 ? "" : "s"}` : "Not used yet"}</small></div>
                <div className="cmr-addrs">
                  {canEdit ? (
                    <RouteChips addrs={a} busy={busy === r.id} placeholder="Add an address or @domain"
                      onChange={(next, added) => void run(r.id, (async () => {
                        const e = await saveClientRoute(r.set.client_id!, nameOf(r.set.client_id), r, next, act);
                        return e ?? (added.length ? fileMailFrom(r.set.client_id!, added, act === "file") : null);
                      })())} />
                  ) : <span className="cmr-ro">{a.join(", ")}</span>}
                </div>
                <div className="cmr-act">
                  <Select value={act} disabled={!canEdit || busy === r.id} onChange={(v) => v !== act && void run(r.id, saveClientRoute(r.set.client_id!, nameOf(r.set.client_id), r, a, v === "create" ? "create" : "file"))}
                    options={[{ value: "file", label: "Keep in Emails" }, { value: "create", label: "Keep + open a ticket" }]} />
                </div>
                {canEdit && (
                  <div className="cmr-side">
                    <button type="button" role="switch" aria-checked={r.active} className={`cmr-switch ${r.active ? "is-on" : ""}`} title={r.active ? "On" : "Off"}
                      onClick={() => void run(r.id, saveMailRule({ ...r, active: !r.active }))}><i /></button>
                    <button type="button" className="cmr-del" onClick={() => void run(r.id, deleteMailRule(r.id))} aria-label="Delete rule"><Ico n="trash" s={14} /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {canEdit && rules && (
        <div className="cmr-new">
          <Select searchable value={adding} onChange={(v) => setAdding(v)} placeholder="Add a rule for a client…"
            options={clients.filter((c) => !taken.has(c.id)).map((c) => ({ value: c.id, label: c.name }))} />
          {adding && (
            <RouteChips addrs={[]} busy={busy === "new"} placeholder="@domain.com or ana@domain.com, then Enter"
              onChange={(next) => void run("new", (async () => {
                const e = await saveClientRoute(adding, nameOf(adding), null, next, "file");
                if (!e) { await fileMailFrom(adding, next, true); setAdding(""); }
                return e;
              })())} />
          )}
        </div>
      )}
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
