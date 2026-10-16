/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { Client, Project, ProjectType } from "./clientsTypes";
import { effectiveRate, effectiveSupervisionRate, projectValue } from "./clientsTypes";
import { supabase } from "../../api/supabase";
import ClientDirectory, { ContractDocs } from "./ClientDirectory";
import MentionInput, { type MentionPerson } from "../../framework/MentionInput";
import { addTask, toggleTask, updateTaskMeta, type TaskPriority, type TrackTask } from "../sales/sales/salesApi";
import { listCompanyFields, listContactFields, sessionUserId, type CompanyField, type ContactField } from "../companies/companiesApi";
import { countryLabel, formatAddress, languageName, linkedInHandle } from "../contacts/contactProfile";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import "../../framework/MentionInput.css";
import "./ClientWorkspace.css";

interface Props {
  client: Client;
  projects: Project[];
  projectTypes: ProjectType[];
  usage: Record<string, { planned: number; done: number }>;
  onOpenProject: (p: Project) => void;
  onNewProject: () => void;
  onDeleteProject: (id: string) => void;
  onClose: () => void;
}

type Tab = "overview" | "projects" | "contract" | "tasks" | "notes" | "docs";

interface Note { id: string; body: string; mentions: string[]; author_id: string | null; created_at: string; src: "client" | "sale"; deal?: string | null }
interface ContactLog { id: string; contacted_at: string; channel: string | null; contact_name: string | null; reason: string | null; logged_by: string | null; }
interface TrackFile { id: string; name: string; note: string | null; mime: string | null; storage_path: string; created_at: string; }
interface Touch { at: string; kind: string; who: string; why: string }
interface Person { key: string; id: string | null; name: string; position: string; email: string; phone: string; billing: boolean; crm: boolean; c: any | null }
interface Deal { id: string; name: string; status: string | null }
type Line = Record<string, any> & { id: string; name: string };
type Task = TrackTask & { tracking_id: string; assignees: string[] };

/* ============================== helpers ============================== */

const DAY = 86400000;
const str = (v: unknown) => (v == null ? "" : String(v).trim());
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
const plain = (body: string) => body.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
const reduceMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const vt = (name: string) => ({ viewTransitionName: name } as React.CSSProperties);
const cssVars = (o: Record<string, string | number>) => o as React.CSSProperties;

/** Animate a layout change (a card growing to full width) where the browser can. */
function morph(fn: () => void) {
  const d = document as any;
  if (!d.startViewTransition || reduceMotion()) { fn(); return; }
  d.startViewTransition(() => flushSync(fn));
}

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
const isActive = (l: Line) => !l.status || /active|signed|live/i.test(String(l.status));
const addYears = (d0: Date, y: number) => {
  const d = new Date(d0);
  d.setFullYear(d.getFullYear() + Math.floor(y));
  d.setMonth(d.getMonth() + Math.round((y % 1) * 12));
  return d;
};
function termOf(l: Line) {
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
  spark: "M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  euro: "M4 10h12M4 14h9M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2",
  flag: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7",
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

function Fact({ k, v, wide }: { k: string; v: React.ReactNode; wide?: boolean }) {
  const empty = v == null || v === "" || v === "—";
  return (
    <div className={`cw-fact ${empty ? "is-empty" : ""} ${wide ? "is-wide" : ""}`}>
      <dt>{k}</dt>
      <dd>{empty ? "—" : v}</dd>
    </div>
  );
}

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
          <small>{p.position || (p.crm ? "Contact" : "Project contact")}</small>
        </span>
        <span className="cw-pc-quick">
          {p.email && <a href={`mailto:${p.email}`} onClick={(e) => e.stopPropagation()} aria-label="Email"><Ico n="mail" s={14} /></a>}
          {p.phone && <a href={`tel:${p.phone}`} onClick={(e) => e.stopPropagation()} aria-label="Call"><Ico n="phone" s={14} /></a>}
          {c.linkedin && <a href={c.linkedin} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label="LinkedIn"><Ico n="linkedin" s={14} /></a>}
        </span>
        <span className={`cw-pc-last is-${tone}`}><i />{d == null ? "never" : shortAgo(last!)}</span>
      </div>
      <div className="cw-reveal" aria-hidden={!open}>
        <div className="cw-reveal-in">
          <dl className="cw-facts is-2 is-filled">
            <Fact k="Email" v={p.email && <a href={`mailto:${p.email}`}>{p.email}</a>} />
            <Fact k="Phone" v={p.phone && <a href={`tel:${p.phone}`}>{p.phone}</a>} />
            <Fact k="Position" v={p.position} />
            <Fact k="Language" v={c.language ? languageName(c.language) : ""} />
            <Fact k="LinkedIn" v={c.linkedin && <a href={c.linkedin} target="_blank" rel="noreferrer">{linkedInHandle(c.linkedin)}</a>} />
            <Fact k="Last contact" v={last ? `${fmt(last)} · ${ago(last)}` : ""} />
            <Fact k="Address" v={addr} wide />
            {custom.map((x) => <Fact key={x.k} k={x.k} v={x.v} />)}
            {str(c.notes) && <Fact k="Notes" v={str(c.notes)} wide />}
          </dl>
          <div className="cw-pc-actions">
            <button className="cw-ghost" onClick={() => onLog(p.name)}><Ico n="pulse" s={14} />Log contact</button>
            {p.crm && p.id && <button className="cw-ghost is-go" onClick={() => onOpenContact(p.id!)}>Open in Contacts<Ico n="arrow" s={14} /></button>}
          </div>
        </div>
      </div>
    </article>
  );
}

/* ============================== workspace ============================== */

export default function ClientWorkspace({
  client, projects, projectTypes, usage, onOpenProject, onNewProject, onDeleteProject, onClose,
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
  const [meetings, setMeetings] = useState<{ at: string; title: string }[]>([]);
  const [nextMeeting, setNextMeeting] = useState<{ at: string; title: string } | null>(null);
  const [calendar, setCalendar] = useState<Touch[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

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
  const [taskDraft, setTaskDraft] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [taskPri, setTaskPri] = useState<TaskPriority>("normal");
  const [taskDeal, setTaskDeal] = useState("");
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskErr, setTaskErr] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteFilter, setNoteFilter] = useState<"all" | "client" | "sale">("all");
  const [noteQ, setNoteQ] = useState("");
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const [confirmNote, setConfirmNote] = useState<string | null>(null);

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
          supabase.from("trackings").select("id, deal_name, status, created_at").eq("company_id", companyId).order("created_at", { ascending: false }),
        ]);
        if (!alive) return;
        setCompany(co.data ?? null);
        const cids = (links.data ?? []).map((l: any) => l.contact_id);
        if (cids.length) {
          const { data } = await supabase.from("contacts").select("*").in("id", cids);
          if (alive) setCrmContacts(data ?? []);
        }
        const dl: Deal[] = ((trk.data ?? []) as any[]).map((t) => ({ id: t.id, name: str(t.deal_name) || client.name, status: t.status ?? null }));
        setDeals(dl);
        setTaskDeal(dl[0]?.id ?? "");
        const ids = dl.map((d) => d.id);
        if (!ids.length) return;
        const nowIso = new Date().toISOString();
        const [tf, mt, nx, tt, tn] = await Promise.all([
          supabase.from("tracking_files").select("id, name, note, mime, storage_path, created_at").in("tracking_id", ids),
          supabase.from("tracking_meetings").select("title, meet_at").in("tracking_id", ids).not("meet_at", "is", null).lte("meet_at", nowIso).order("meet_at", { ascending: false }).limit(15),
          supabase.from("tracking_meetings").select("title, meet_at").in("tracking_id", ids).gt("meet_at", nowIso).order("meet_at", { ascending: true }).limit(1),
          supabase.from("tracking_tasks").select("*").in("tracking_id", ids).order("created_at", { ascending: false }),
          supabase.from("tracking_notes").select("*").in("tracking_id", ids).order("created_at", { ascending: false }),
        ]);
        if (!alive) return;
        setTrackFiles((tf.data ?? []) as TrackFile[]);
        setMeetings(((mt.data ?? []) as any[]).map((m) => ({ at: m.meet_at, title: m.title })));
        const n0 = (nx.data ?? [])[0] as any;
        setNextMeeting(n0 ? { at: n0.meet_at, title: n0.title } : null);
        const dealName = new Map(dl.map((d) => [d.id, d.name]));
        setSaleNotes(((tn.data ?? []) as any[]).filter((n) => str(n.body)).map((n) => ({
          id: n.id, body: n.body, mentions: [], created_at: n.created_at,
          author_id: n.created_by ?? n.author_id ?? n.user_id ?? null, src: "sale" as const, deal: dealName.get(n.tracking_id) ?? null,
        })));
        const taskRows = (tt.data ?? []) as any[];
        const byTask: Record<string, string[]> = {};
        if (taskRows.length) {
          const { data: ta } = await supabase.from("tracking_assignees").select("item_id, employee_id")
            .eq("item_type", "task").eq("kind", "employee").in("item_id", taskRows.map((t) => t.id));
          (ta ?? []).forEach((a: any) => { (byTask[a.item_id] ??= []).push(a.employee_id); });
        }
        if (alive) setTasks(taskRows.map((t) => toTask(t, byTask[t.id] ?? [])));
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [client.id, client.name]);

  /* ---- derived ---- */
  const unitOf = (p: Project) => (units[p.projectTypeId] === "hour" ? "h" : "d");
  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";
  const mentionPeople: MentionPerson[] = useMemo(
    () => Object.entries(people).map(([id, name]) => ({ id: `employee:${id}`, name, kind: "employee" as const })),
    [people]);

  const totals = useMemo(() => projects.reduce((acc, p) => {
    const signed = p.consultorDays + p.connectorDays + p.supervisionDays;
    const u = usage[p.id] ?? { planned: 0, done: 0 };
    acc.signed += signed; acc.done += u.done; acc.booked += u.planned; acc.value += projectValue(p);
    return acc;
  }, { signed: 0, done: 0, booked: 0, value: 0 }), [projects, usage]);
  const left = +(totals.signed - totals.done - totals.booked).toFixed(2);
  const donePct = totals.signed > 0 ? Math.min(100, (totals.done / totals.signed) * 100) : 0;
  const gauge = useCount(donePct, 1300);

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
  const noteGroups = useMemo(() => {
    const g: { label: string; items: Note[] }[] = [];
    shownNotes.forEach((n) => {
      const label = toDate(n.created_at).toLocaleDateString(undefined, { month: "long", year: "numeric" });
      if (!g.length || g[g.length - 1].label !== label) g.push({ label, items: [] });
      g[g.length - 1].items.push(n);
    });
    return g;
  }, [shownNotes]);

  /* ---- tabs + sliding ink ---- */
  const TABS: { v: Tab; label: string; icon: string; n?: number; alert?: boolean }[] = [
    { v: "overview", label: "Overview", icon: "overview" },
    { v: "projects", label: "Projects", icon: "briefcase", n: projects.length },
    { v: "contract", label: "Contract", icon: "contract", n: lines.length || undefined },
    { v: "tasks", label: "Tasks", icon: "tasks", n: openTasks.length || undefined, alert: lateTasks.length > 0 },
    { v: "notes", label: "Notes", icon: "note", n: allNotes.length || undefined },
    { v: "docs", label: "Docs", icon: "folder" },
  ];
  const tabsRef = useRef<HTMLElement>(null);
  const [ink, setInk] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const nav = tabsRef.current;
    if (!nav) return;
    const place = () => {
      const b = nav.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
      if (!b) return;
      setInk({ x: b.offsetLeft, w: b.offsetWidth });
      if (nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: b.offsetLeft - 24, behavior: reduceMotion() ? "auto" : "smooth" });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [tab]);
  const go = (t: Tab) => { setTab(t); bodyRef.current?.scrollTo({ top: 0 }); };

  /* ---- actions ---- */
  const openCompany = () => co.id && navigate("/companies", { state: { focusCompanyId: co.id } });
  const openContact = (id: string) => navigate("/contacts", { state: { focusContactId: id } });
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
    const t = await addTask(taskDeal, null, title, taskDue ? `${taskDue}T18:00:00` : null, { priority: taskPri });
    setTaskBusy(false);
    if (!t) { setTaskErr("Could not create the task."); return; }
    setTasks((xs) => [toTask({ ...t, tracking_id: taskDeal }, []), ...xs]);
    setTaskDraft(""); setTaskDue(""); setTaskPri("normal");
    if (taskFilter === "done") setTaskFilter("open");
  };
  const flipTask = async (t: Task) => {
    const done = !t.done;
    setTasks((xs) => xs.map((x) => (x.id === t.id ? { ...x, done, status: done ? "done" : "todo", progress: done ? 100 : x.progress } : x)));
    await toggleTask(t.id, done);
    void updateTaskMeta(t.id, { status: done ? "done" : "todo" });
  };

  const dealName = (id: string) => deals.find((d) => d.id === id)?.name ?? "Deal";
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
  const legal = str(identity[1].v) || str(identity[0].v);
  const vat = str(identity[2].v);

  /* ---- the company card: full width when opened, in the main column when closed ---- */
  const companyCard = (
    <section className={`cw-card cw-co ${coOpen ? "is-open" : ""} ${coMoved ? "is-moved" : ""}`} style={{ ...vt("cw-co"), ...cssVars({ "--i": 4 }) }}>
      <SecHead icon="building" tone="green" title="Company" sub={`${filled} of ${totalFacts} details filled`}>
        {co.id && <button className="cw-icon-btn" onClick={openCompany} aria-label="Open in Companies" {...tipOn(<TipCard title="Open in Companies" />)}><Ico n="out" s={15} /></button>}
        <button className="cw-ghost" onClick={() => { hideTip(); morph(() => { setCoMoved(true); setCoOpen((o) => !o); }); }} aria-expanded={coOpen}>
          <Ico n={coOpen ? "shrink" : "expand"} s={14} />{coOpen ? "Less" : "See everything"}
        </button>
      </SecHead>
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
      <div className="cw-reveal" aria-hidden={!coOpen}>
        <div className="cw-reveal-in">
          <div className="cw-co-groups">
            {[
              { t: "Identity", icon: "building", rows: identity },
              { t: "Reach", icon: "globe", rows: reach },
              { t: "Address", icon: "pin", rows: place },
              { t: "Engagement", icon: "briefcase", rows: engagement },
              ...(custom.length ? [{ t: "Custom fields", icon: "spark", rows: custom }] : []),
            ].map((g, gi) => (
              <div className="cw-co-group" key={g.t} style={cssVars({ "--i": gi })}>
                <h4><Ico n={g.icon} s={13} />{g.t}</h4>
                <dl className="cw-facts">{g.rows.map((r) => <Fact key={r.k} k={r.k} v={r.v} />)}</dl>
              </div>
            ))}
            {str(co.notes) && (
              <div className="cw-co-group is-notes" style={cssVars({ "--i": 6 })}>
                <h4><Ico n="note" s={13} />About</h4>
                <p>{co.notes}</p>
              </div>
            )}
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
          <span className="cw-orb is-a" aria-hidden="true" />
          <button className="cw-x" onClick={requestClose} aria-label="Close"><Ico n="x" s={18} /></button>

          <div className="cw-head-row">
            <div className="cw-id">
              <span className="cw-av">{initials(client.name)}</span>
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
              <div className="cw-kpi cw-kpi-gauge" style={cssVars({ "--i": 0 })}
                {...tipOn(<TipCard title={`${Math.round(donePct)}% of signed days used`} rows={projRows((p) => {
                  const s = p.consultorDays + p.connectorDays + p.supervisionDays; const u = usage[p.id] ?? { planned: 0, done: 0 };
                  return `${s > 0 ? Math.round((u.done / s) * 100) : 0}% · ${d2(u.done)} / ${d2(s)}${unitOf(p)}`;
                })} />)}>
                <div className="cw-ring">
                  <svg viewBox="0 0 140 82" aria-hidden="true">
                    <defs>
                      <linearGradient id="cw-arc-g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stopColor="#12b57f" /><stop offset="1" stopColor="#35ffa0" /></linearGradient>
                    </defs>
                    <path className="cw-arc-bg" d="M16 70 A54 54 0 0 1 124 70" pathLength={100} />
                    <path className="cw-arc-fill" d="M16 70 A54 54 0 0 1 124 70" pathLength={100} style={{ strokeDasharray: `${gauge.toFixed(2)} 100` }} />
                  </svg>
                  <span className="cw-ring-mid"><b>{Math.round(gauge)}</b><i>% used</i></span>
                </div>
                <div className="cw-kpi-side"><span className="cw-kpi-k">Signed</span><b className="cw-kpi-v"><Num v={totals.signed} dp={2} /></b></div>
              </div>
              {([
                ["Used", totals.done, (p: Project) => `${d2((usage[p.id] ?? { done: 0 }).done)}${unitOf(p)}`, ""],
                ["Booked", totals.booked, (p: Project) => `${d2((usage[p.id] ?? { planned: 0 }).planned)}${unitOf(p)}`, ""],
                ["Left", left, (p: Project) => { const u = usage[p.id] ?? { planned: 0, done: 0 }; return `${d2(p.consultorDays + p.connectorDays + p.supervisionDays - u.done - u.planned)}${unitOf(p)}`; }, left < 0 ? "is-over" : "is-neon"],
              ] as [string, number, (p: Project) => string, string][]).map(([k, v, f, cls], i) => (
                <div className="cw-kpi" key={k} style={cssVars({ "--i": i + 1 })} {...tipOn(<TipCard title={`${k} · ${d2(v)}`} rows={projRows(f)} />)}>
                  <span className="cw-kpi-k">{k}</span><b className={`cw-kpi-v ${cls}`}><Num v={v} dp={2} /></b>
                </div>
              ))}
              <div className="cw-kpi" style={cssVars({ "--i": 4 })} {...tipOn(<TipCard title={`Contract value · ${eur(totals.value)}`} rows={projRows((p) => eur(projectValue(p)))} />)}>
                <span className="cw-kpi-k">Value</span><b className="cw-kpi-v is-neon"><Num v={totals.value} /><em>€</em></b>
              </div>
            </div>
          </div>

          <nav className="cw-tabs" ref={tabsRef} role="tablist">
            {ink && <span className="cw-tabs-ink" style={{ transform: `translateX(${ink.x}px)`, width: ink.w }} aria-hidden="true" />}
            {TABS.map((t, i) => (
              <button key={t.v} data-tab={t.v} role="tab" aria-selected={tab === t.v}
                className={tab === t.v ? "is-on" : ""} style={cssVars({ "--i": i })} onClick={() => { hideTip(); go(t.v); }}>
                <Ico n={t.icon} s={15} />{t.label}
                {t.n != null && <i className={t.alert ? "is-alert" : ""}>{t.n}</i>}
              </button>
            ))}
          </nav>
        </header>

        {/* ---------- body ---------- */}
        <div className={`cw-body ${tab === "docs" ? "is-fixed" : ""}`} ref={bodyRef} onScroll={hideTip}>
          <div className="cw-panel" key={tab}>
            {/* ===== OVERVIEW ===== */}
            {tab === "overview" && (
              <div className="cw-ov">
                <div className="cw-snap" style={vt("cw-snap")}>
                  <button className="cw-tile" data-tone="green" style={cssVars({ "--i": 0 })} onClick={() => go("projects")}
                    {...tipOn(<TipCard title="Projects" rows={projRows((p) => `${p.status || "open"} · ${eur(projectValue(p))}`)} />)}>
                    <span className="cw-tile-top"><span className="cw-tile-ico"><Ico n="briefcase" s={15} /></span><span className="cw-tile-k">Projects</span></span>
                    <b className="cw-tile-v"><Num v={projects.filter((p) => p.status !== "closed").length} /><small> open of {projects.length}</small></b>
                    <span className="cw-tile-bar"><span style={{ width: `${donePct}%` }} /></span>
                  </button>
                  <button className="cw-tile" data-tone="violet" style={cssVars({ "--i": 1 })} onClick={() => go("contract")}
                    {...tipOn(<TipCard title="Contract" rows={[
                      ["Recurring / year", recurringYear ? eur(recurringYear) : ""], ["One-time", oneTime ? eur(oneTime) : ""], ["Projects", eur(totals.value)],
                      ["Active products", activeLines.length ? String(activeLines.length) : ""],
                      ["Next renewal", nextRenewal ? `${fmtD(nextRenewal.end)} · in ${nextRenewal.left}d` : ""],
                    ]} />)}>
                    <span className="cw-tile-top"><span className="cw-tile-ico"><Ico n="contract" s={15} /></span><span className="cw-tile-k">Contract</span></span>
                    <b className="cw-tile-v">{recurringYear > 0 ? <><Num v={recurringYear} /><small> € / year</small></> : <><Num v={totals.value + oneTime} /><small> €</small></>}</b>
                  </button>
                  <button className={`cw-tile ${lateTasks.length ? "is-alert" : ""}`} data-tone="amber" style={cssVars({ "--i": 2 })} onClick={() => go("tasks")}
                    {...tipOn(openTasks.length
                      ? <TipCard title={`${openTasks.length} open task${openTasks.length === 1 ? "" : "s"}`} rows={openTasks.slice(0, 5).map((t) => [plain(t.title).slice(0, 38), dueInfo(t.due_at)?.label ?? "No date"] as [string, React.ReactNode])} />
                      : <TipCard title="No open tasks" />)}>
                    <span className="cw-tile-top"><span className="cw-tile-ico"><Ico n="tasks" s={15} /></span><span className="cw-tile-k">Tasks</span></span>
                    <b className="cw-tile-v"><Num v={openTasks.length} /><small> open{lateTasks.length ? <em> · {lateTasks.length} late</em> : null}</small></b>
                  </button>
                  <button className="cw-tile" data-tone="blue" style={cssVars({ "--i": 3 })} onClick={() => go("notes")}
                    {...tipOn(allNotes[0] ? <TipCard title={people[allNotes[0].author_id ?? ""] ?? "Note"} sub={`${fmt(allNotes[0].created_at)} · ${ago(allNotes[0].created_at)}`}>{plain(allNotes[0].body)}</TipCard> : null)}>
                    <span className="cw-tile-top"><span className="cw-tile-ico"><Ico n="note" s={15} /></span><span className="cw-tile-k">Latest note</span></span>
                    <span className="cw-tile-note">{allNotes[0] ? plain(allNotes[0].body) : "No notes yet"}</span>
                  </button>
                </div>

                {coOpen && companyCard}
                <div className="cw-ov-cols">
                  <div className="cw-ov-main">
                    {!coOpen && companyCard}
                    <section className="cw-card cw-people" style={{ ...vt("cw-people"), ...cssVars({ "--i": 6 }) }}>
                      <SecHead icon="users" tone="blue" title="Contacts"
                        sub={`${persons.length} ${persons.length === 1 ? "person" : "people"}${persons.some((p) => p.billing) ? ` · ${persons.filter((p) => p.billing).length} billing` : ""}`}>
                        {persons.length > PEOPLE_LIMIT && (
                          <label className="cw-search"><Ico n="search" s={14} /><input value={peopleQ} placeholder="Search people" onChange={(e) => setPeopleQ(e.target.value)} /></label>
                        )}
                      </SecHead>
                      {persons.length === 0 ? (
                        <div className="cw-empty"><Ico n="users" s={20} /><p>{loaded ? "No contacts on file for this client." : "Loading contacts…"}</p></div>
                      ) : (
                        <div className="cw-people-grid">
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
                  </div>

                  <div className="cw-ov-side">
                    <section ref={pulseRef} className={`cw-card cw-pulse is-${health}`} style={{ ...vt("cw-pulse"), ...cssVars({ "--i": 5 }) }}>
                      <SecHead icon="pulse" tone="teal" title="Last contacted" sub={touches.length ? `${touches.length} touchpoint${touches.length === 1 ? "" : "s"}` : "Nothing on record yet"}>
                        <button className="cw-btn-primary is-sm" onClick={() => (logOpen ? setLogOpen(false) : startLog())}>
                          <Ico n={logOpen ? "x" : "plus"} s={14} />{logOpen ? "Cancel" : "Log"}
                        </button>
                      </SecHead>

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
                        <ol className="cw-timeline">
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
                    </section>
                  </div>
                </div>
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
                      const days = p.consultorDays + p.connectorDays + p.supervisionDays;
                      const u = usage[p.id] ?? { planned: 0, done: 0 };
                      const pl = +(days - u.planned - u.done).toFixed(2);
                      const pct = (n: number) => (days > 0 ? Math.min(100, (n / days) * 100) : 0);
                      const usedPct = Math.round(pct(u.done));
                      const closed = p.status === "closed";
                      const s = p.kickoffDate || p.signingDate;
                      const elapsed = s && p.endDate ? clamp((Date.now() - toDate(s).getTime()) / Math.max(1, toDate(p.endDate).getTime() - toDate(s).getTime())) : null;
                      const C = 2 * Math.PI * 26;
                      const rate = effectiveRate(p.pricePerDay, p.discountMode, p.discountValue);
                      const un = unitOf(p);
                      return (
                        <article key={p.id} className={`cw-proj ${closed ? "is-closed" : ""} ${pl < 0 ? "is-over" : ""}`} style={cssVars({ "--i": i })}
                          role="button" tabIndex={0} onClick={() => { hideTip(); onOpenProject(p); }}
                          onKeyDown={(e) => { if (e.key === "Enter") onOpenProject(p); }}
                          {...tipOn(<TipCard title={typeName(p.projectTypeId)} sub={`${p.status || "open"} · click to edit`} rows={[
                            ["Used", `${d2(u.done)}${un}`], ["Booked", `${d2(u.planned)}${un}`], ["Left", `${d2(pl)}${un}`], ["Signed", `${d2(days)}${un}`],
                            ["Kick-off", p.kickoffDate ? fmt(p.kickoffDate) : ""], ["End", p.endDate ? fmt(p.endDate) : ""],
                            ["Time elapsed", elapsed != null ? `${Math.round(elapsed * 100)}%` : ""],
                            ["Rate", `${eur(rate)} / ${un === "h" ? "hour" : "day"}`], ["Team", (p.team ?? []).map((m) => m.name).filter(Boolean).join(", ")],
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
              <div className="cw-stack">
                <div className="cw-ckpis">
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

                <section className="cw-card cw-cdocs-card">
                  <SecHead icon="folder" tone="violet" title="Contract documents" sub="Drop PDFs, Word files or anything else — they're kept for this client" />
                  <ContractDocs clientId={client.id} tenantId={tenantId} />
                </section>

                <section className="cw-card">
                  <SecHead icon="contract" tone="violet" title="Signed products" sub={lines.length ? `${activeLines.length} active` : "Added when a deal is won"} />
                  {lines.length === 0 ? (
                    <div className="cw-empty"><Ico n="contract" s={20} /><p>{loaded ? "No signed products yet." : "Loading…"}</p></div>
                  ) : (
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

                <section className="cw-card">
                  <SecHead icon="briefcase" tone="green" title="Service engagements" sub="Hover a row for rates, tax and payment" />
                  {projects.length === 0 ? <div className="cw-empty"><Ico n="briefcase" s={20} /><p>No projects signed yet.</p></div> : (
                    <div className="cw-eng">
                      <div className="cw-eng-row is-head"><span>Service</span><span>Signed</span><span>Days</span><span>Day rate</span><span className="is-r">Value</span></div>
                      {projects.map((p, i) => {
                        const rate = effectiveRate(p.pricePerDay, p.discountMode, p.discountValue);
                        const sup = effectiveSupervisionRate(p.supervisionPrice, p.supervisionDiscountMode, p.supervisionDiscountValue);
                        const un = unitOf(p);
                        return (
                          <button className="cw-eng-row" key={p.id} style={cssVars({ "--i": i })} onClick={() => { hideTip(); onOpenProject(p); }}
                            {...tipOn(<TipCard title={typeName(p.projectTypeId)} rows={[
                              ["Consultancy", `${d2(p.consultorDays)}${un}`], ["Connector", p.connectorDays ? `${d2(p.connectorDays)}${un}` : ""],
                              ["Supervision", p.supervisionDays ? `${d2(p.supervisionDays)}${un} · ${eur(sup)}` : ""],
                              ["List rate", rate !== p.pricePerDay ? eur(p.pricePerDay) : ""],
                              ["Discount", p.discountMode !== "none" && p.discountValue ? (p.discountMode === "percent" ? `${p.discountValue}%` : `${eur(p.discountValue)} ${p.discountMode === "total" ? "total" : "/ day"}`) : ""],
                              ["Tax", p.taxed ? `${p.taxRate}%` : "No tax"], ["Payment", p.paymentDays ? `${p.paymentDays} days` : ""],
                            ]} />)}>
                            <span data-k="Service"><b>{typeName(p.projectTypeId)}</b></span>
                            <span data-k="Signed">{fmt(p.signingDate)}</span>
                            <span data-k="Days">{d2(p.consultorDays + p.connectorDays + p.supervisionDays)}{un}</span>
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

            {/* ===== TASKS ===== */}
            {tab === "tasks" && (
              <div className="cw-stack is-narrow">
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

                {deals.length === 0 ? (
                  <p className="cw-hint"><Ico n="flag" s={14} /> {loaded ? "Tasks live on the client's sales deals, and this client has none yet." : "Loading…"}</p>
                ) : (
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
                          {deals.length > 1 && (
                            <span className="cw-tadd-deal"><Select size="sm" aria-label="Deal" value={taskDeal} onChange={setTaskDeal} options={deals.map((d) => ({ value: d.id, label: d.name }))} /></span>
                          )}
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
                </div>

                {shownTasks.length === 0 ? (
                  <div className="cw-empty is-big"><Ico n="tasks" s={24} /><p>{taskFilter === "late" ? "Nothing overdue." : taskFilter === "done" ? "No finished tasks yet." : tasks.length ? "All caught up." : "No tasks for this client yet."}</p></div>
                ) : (
                  <ul className="cw-tasks">
                    {shownTasks.map((t, i) => {
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
                          {t.kind === "process" && !t.done && <span className="cw-tprog"><span><i style={{ width: `${t.progress ?? 0}%` }} /></span></span>}
                          {due && !t.done && <span className={`cw-due is-${due.tone}`}>{due.label}</span>}
                          <span className="cw-task-people">{t.assignees.slice(0, 3).map((id) => <span key={id}><Avatar name={people[id] ?? "?"} size={22} /></span>)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {/* ===== NOTES ===== */}
            {tab === "notes" && (
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
                  <div className="cw-ngroup" key={g.label}>
                    <h4 className="cw-ngroup-h">{g.label}</h4>
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
            )}

            {/* ===== DOCS ===== */}
            {tab === "docs" && (
              <div className="cw-docs">
                <div className="cw-docs-left">
                  <section className="cw-card">
                    <SecHead icon="file" tone="blue" title="From the sale" sub="Attached during the sales tracking" />
                    {trackFiles.length === 0 ? <div className="cw-empty"><Ico n="file" s={20} /><p>No files were attached during the sale.</p></div> : (
                      <div className="cw-trackfiles">
                        {trackFiles.map((f, i) => (
                          <div className="cw-tf" key={f.id} style={cssVars({ "--i": i })} {...tipOn(<TipCard title={f.name} sub={`Added ${fmt(f.created_at)}`}>{f.note}</TipCard>)}>
                            <span className="cw-tf-kind" style={cssVars({ "--h": hue((f.name.split(".").pop() ?? "").toLowerCase()) })}>{(f.name.split(".").pop() ?? "•").slice(0, 4).toUpperCase()}</span>
                            <span className="cw-tf-t"><b>{f.name}</b></span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
                <div className="cw-docs-right">
                  <h3 className="cw-dir-title"><Ico n="folder" s={15} />Client directory</h3>
                  <ClientDirectory clientId={client.id} tenantId={tenantId} />
                </div>
              </div>
            )}
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
