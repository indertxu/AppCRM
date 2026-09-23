/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import Select from "../../framework/Select";
import "./BacklogPanel.css";

export interface BkEntry {
  id: string;
  userId: string;
  projectId: string;
  date: string;
  billable: number;
  status: string;
  line: string;
}
export interface BkProj {
  id: string;
  clientId: string;
  typeId: string;
  kickoff: string;
  rate: number;
  supervision: number;
  consultorDays: number;
  connectorDays: number;
  supervisionDays: number;
  status: string;
  team: { userId?: string; role?: string }[];
}

interface Props {
  entries: BkEntry[];
  projects: Record<string, BkProj>;
  clientNames: Record<string, string>;
  typeNames: Record<string, string>;
  people: Record<string, string>;
  supRoles: Set<string>;
  hourProjects: Set<string>;
  hoursPerDay: number;
  scope: "week" | "month" | "year" | "all" | "custom";
  anchor: Date;
  rangeFrom: string;
  rangeTo: string;
  /** service_id (BkProj.typeId) -> the role_id marked "main" for that service in
      Products & Services. Whoever holds that role on a project's team is the
      project's owner for backlog-by-consultant purposes. */
  mainRoleByService: Record<string, string>;
  /** Backlog is a point-in-time snapshot, not a period — everything (available
      days, the consultant breakdown, the project list) is measured as of this
      one date, picked directly rather than derived from scope/anchor. */
  asOf: string;
}

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/* ===================================================================
   Presentation helpers. Same language as the Team tab and the
   consultant modal: count-ups, sweeping arcs, cursor spotlight.
   =================================================================== */
const blVars = (o: Record<string, string | number>) => o as CSSProperties;
const blReduced = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const blEur = (n: number) => Math.round(n).toLocaleString();
const blR0 = (n: number) => Math.round(n).toLocaleString();

function useBlCount(target: number, ms = 1100) {
  const [value, setValue] = useState(() => (blReduced() ? target : 0));
  const from = useRef(value);
  useEffect(() => {
    if (blReduced()) { from.current = target; setValue(target); return; }
    let raf = 0;
    const start = from.current;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      const cur = start + (target - start) * e;
      from.current = cur;
      setValue(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}
function BlCount({ value, fmt = blR0 }: { value: number; fmt?: (n: number) => string }) {
  return <>{fmt(useBlCount(value))}</>;
}
function useBlArmed(ms: number) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), blReduced() ? 0 : ms);
    return () => window.clearTimeout(t);
  }, [ms]);
  return armed;
}
function blSpot(e: ReactPointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse") return;
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-spot]");
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  el.style.setProperty("--mx", `${x}px`);
  el.style.setProperty("--my", `${y}px`);
  if (el.dataset.spot === "tilt") {
    el.style.setProperty("--ry", `${(x / r.width - 0.5) * 6}deg`);
    el.style.setProperty("--rx", `${(0.5 - y / r.height) * 6}deg`);
  }
}
/** Catmull-Rom → cubic Bézier, clamped so the curve never dips below the axis. */
function blSmooth(p: [number, number][], h: number) {
  if (p.length === 0) return "";
  const c = (v: number) => Math.min(h, Math.max(0, v));
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] ?? p2;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(c(p1[1] + (p2[1] - p0[1]) / 6))} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(c(p2[1] - (p3[1] - p1[1]) / 6))} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

const BL_ICON = {
  days: "M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM12 12v3l2 1.5",
  value: "M12 3v18M16.5 6.5H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7",
  length: "M3 12h18M3 8v8M21 8v8M8 10l-2 2 2 2M16 10l2 2-2 2",
  rate: "M4 19V9M10 19V5M16 19v-7M22 19H2",
  swap: "M16 3l4 4-4 4M4 7h16M8 21l-4-4 4-4M20 17H4",
  trend: "M3 17l6-6 4 4 8-8M17 7h4v4",
  chev: "M9 6l6 6-6 6",
  cal: "M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  warn: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  empty: "M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4",
};
function BlIcon({ d, w = 2 }: { d: string; w?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const BL_ARC = "M16 70 A54 54 0 0 1 124 70";

/** A glass headline card. Becomes a button when it has something to flip. */
function BlCard({
  i, icon, label, swap, onClick, title, className = "", children,
}: {
  i: number; icon: string; label: string; swap?: string; onClick?: () => void; title?: string;
  className?: string; children: ReactNode;
}) {
  const body = (
    <>
      <span className="bl-kpi-head">
        <span className="bl-kpi-ico"><BlIcon d={icon} /></span>
        <span className="bl-kpi-label">{label}</span>
        {swap && <span className="bl-kpi-swap"><BlIcon d={BL_ICON.swap} w={2.2} /><span>{swap}</span></span>}
      </span>
      {children}
    </>
  );
  const cls = `bl-kpi ${onClick ? "is-action" : ""} ${className}`;
  return onClick ? (
    <button type="button" className={cls} data-spot="tilt" style={blVars({ "--i": i })} onClick={onClick} title={title}>{body}</button>
  ) : (
    <div className={cls} data-spot="tilt" style={blVars({ "--i": i })}>{body}</div>
  );
}

function startOfWeek(input: Date): Date {
  const d = new Date(input);
  const day = d.getDay();
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  d.setHours(0, 0, 0, 0);
  return d;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function endOfMonth(y: number, m: number): Date {
  return new Date(y, m + 1, 0);
}

/** A clickable list-header cell: shows the label (with an active dot + sort
 *  arrow), and on click drops a menu of sort/filter options for that column. */
function ColHeader({
  label, align = "left", menuAlign, isOpen, onToggle, active, sortArrow, children,
}: {
  label: string; align?: "left" | "right"; menuAlign?: "left" | "right"; isOpen: boolean; onToggle: () => void;
  active?: boolean; sortArrow?: "asc" | "desc" | null; children: ReactNode;
}) {
  const mAlign = menuAlign ?? align;
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onToggle(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onToggle(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [isOpen, onToggle]);
  return (
    <span className={`bl-hcell ${align === "right" ? "is-r" : ""} ${isOpen ? "is-open" : ""} ${active ? "is-active" : ""}`} ref={ref}>
      <button type="button" className="bl-hbtn" onClick={onToggle} aria-expanded={isOpen}>
        <span>{label}</span>
        {sortArrow && <b className="bl-hsort">{sortArrow === "asc" ? "↑" : "↓"}</b>}
        {active && <i className="bl-hdot" aria-hidden="true" />}
        <svg className="bl-hcaret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {isOpen && <div className={`bl-hmenu ${mAlign === "right" ? "is-r" : ""}`}>{children}</div>}
    </span>
  );
}


type Line = "consultor" | "supervision" | "connector";
type Tally = Record<Line, number>;

const blank = (): Tally => ({ consultor: 0, supervision: 0, connector: 0 });
const sum = (t: Tally) => t.consultor + t.supervision + t.connector;

interface ProjRow {
  id: string;
  clientId: string;
  type: string;
  status: string;
  kickoff: string;
  sold: Tally;
  billed: Tally;
  planned: Tally;
  byUser: Record<string, { billed: number; planned: number }>;
  rate: number;
  supervisionRate: number;
}

export default function BacklogPanel({
  entries, projects, clientNames, typeNames, people, supRoles,
  hourProjects, hoursPerDay,
  scope, anchor, rangeFrom, rangeTo, mainRoleByService, asOf: asOfProp,
}: Props) {
  const [chartMode, setChartMode] = useState<"days" | "value">("days");
  /** Cards read in days by default; three of them flip to the h + d split. */
  const [unitMode, setUnitMode] = useState<"days" | "split">("days");
  const hpd = hoursPerDay > 0 ? hoursPerDay : 8;
  const isHourly = (id: string) => hourProjects.has(id);
  const inDays = (id: string, x: number) => (isHourly(id) ? x / hpd : x);
  const [chartOpen, setChartOpen] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [onlyLeft, setOnlyLeft] = useState(true);
  const [onlyUnowned, setOnlyUnowned] = useState(false);

  /** Which contracted bucket an entry eats into. Mirrors the team panel's rate logic. */
  const lineOf = (p: BkProj, line: string, userId: string): Line => {
    if (line === "connector") return "connector";
    const member = (p.team ?? []).find((m) => m.userId === userId);
    if (line === "supervision" || supRoles.has(member?.role ?? "")) return "supervision";
    return "consultor";
  };

  /** The team member holding the service's "main" role — the project's owner. */
  const ownerOf = (p: BkProj): string | null => {
    const mainRole = mainRoleByService[p.typeId];
    if (!mainRole) return null;
    return (p.team ?? []).find((m) => m.role === mainRole)?.userId ?? null;
  };
  /** True if this consultant holds a supervision-tagged role on the project's team. */
  const isSupervisorOn = (p: BkProj, userId: string): boolean =>
    (p.team ?? []).some((m) => m.userId === userId && supRoles.has(m.role ?? ""));

  const [consultantFilter, setConsultantFilter] = useState<string>("");

  // ── Column sort + filters (opened from the list headers) ───────────────────
  type SortKey = "client" | "progress" | "days" | "value" | "team" | "kickoff";
  type SortDir = "asc" | "desc";
  const [sortKey, setSortKey] = useState<SortKey>("client");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [openMenu, setOpenMenu] = useState<SortKey | null>(null);
  // Per-column filters. Empty/neutral = off.
  const [fClient, setFClient] = useState("");                              // substring match
  const [fDays, setFDays] = useState<"any" | "left" | "none">("any");      // days-left state
  const [fDaysMin, setFDaysMin] = useState("");                            // min days left
  const [fValueMin, setFValueMin] = useState("");                          // min € left
  const [fTeamUser, setFTeamUser] = useState("");                          // a user on the team, or "__none"
  const [fProgress, setFProgress] = useState<"any" | "unstarted" | "partial" | "done">("any");
  const [fKickoff, setFKickoff] = useState<"any" | "30" | "90" | "180" | "365" | "older">("any"); // age buckets

  const clearColumnFilters = () => {
    setFClient(""); setFDays("any"); setFDaysMin(""); setFValueMin("");
    setFTeamUser(""); setFProgress("any"); setFKickoff("any");
  };
  const activeFilterCount =
    (fClient ? 1 : 0) + (fDays !== "any" ? 1 : 0) + (fDaysMin ? 1 : 0) + (fValueMin ? 1 : 0) +
    (fTeamUser ? 1 : 0) + (fProgress !== "any" ? 1 : 0) + (fKickoff !== "any" ? 1 : 0);

  const setSort = (k: SortKey, d: SortDir) => { setSortKey(k); setSortDir(d); };
  // Days since a project's kickoff (null when no kickoff on record).
  const ageDays = (r: ProjRow): number | null => {
    if (!r.kickoff) return null;
    const k = new Date(`${r.kickoff}T00:00:00`).getTime();
    if (Number.isNaN(k)) return null;
    return Math.floor((Date.now() - k) / 86400000);
  };

  /** Everything is measured as of the close of the selected period, not "now". */
  const asOf = asOfProp || iso(new Date());

  const rows = useMemo<ProjRow[]>(() => {
    const acc: Record<string, ProjRow> = {};
    Object.values(projects).forEach((p) => {
      // A project only enters the backlog once it has kicked off.
      if (p.kickoff && p.kickoff > asOf) return;
      acc[p.id] = {
        id: p.id,
        clientId: p.clientId,
        type: typeNames[p.typeId] || "No project type",
        status: p.status,
        kickoff: p.kickoff,
        sold: {
          consultor: p.consultorDays,
          supervision: p.supervisionDays,
          connector: p.connectorDays,
        },
        billed: blank(),
        planned: blank(),
        byUser: {},
        rate: p.rate,
        supervisionRate: p.supervision,
      };
    });

    // Cumulative up to the period close: everything logged on or before asOf.
    entries.forEach((e) => {
      if (e.status === "cancelled" || e.line === "closure") return;
      if (!e.projectId || !e.userId) return;
      if (e.date && e.date > asOf) return;
      const p = projects[e.projectId];
      const row = acc[e.projectId];
      if (!p || !row) return;

      const bucket = lineOf(p, e.line, e.userId);
      const done = e.status === "confirmed";
      if (done) row.billed[bucket] += e.billable;
      else row.planned[bucket] += e.billable;

      if (!row.byUser[e.userId]) row.byUser[e.userId] = { billed: 0, planned: 0 };
      if (done) row.byUser[e.userId].billed += e.billable;
      else row.byUser[e.userId].planned += e.billable;
    });

    return Object.values(acc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, projects, typeNames, supRoles, asOf]);

  /** Still to deliver = sold minus what's already billed. Scheduled days still count as pending. */
  const availableOf = (r: ProjRow): Tally => ({
    consultor: Math.max(0, r.sold.consultor - r.billed.consultor),
    supervision: Math.max(0, r.sold.supervision - r.billed.supervision),
    connector: Math.max(0, r.sold.connector - r.billed.connector),
  });
  const valueOf = (r: ProjRow, t: Tally) =>
    t.consultor * r.rate + t.connector * r.rate + t.supervision * r.supervisionRate;

  /** Consultancy backlog that can't be attributed to anyone yet — the project's
      service has no "main" role set in Products & Services, or nobody on the
      team holds that role. This is why summing every consultant's personal
      backlog can land below the panel's overall total: this slice sits in the
      total but is invisible in every individual view until it's assigned. */
  const unownedBacklog = useMemo(() => {
    let days = 0, value = 0;
    const ids = new Set<string>();
    rows.forEach((r) => {
      if (sum(r.sold) === 0) return;
      if (onlyLeft && sum(availableOf(r)) <= 0.001) return;
      const p = projects[r.id];
      if (!p) return;
      if (ownerOf(p) !== null) return;
      const avail = availableOf(r);
      if (avail.consultor <= 0.001) return;
      days += inDays(r.id, avail.consultor);
      value += avail.consultor * r.rate;
      ids.add(r.id);
    });
    return { days, value, projectCount: ids.size, ids };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, projects, onlyLeft, mainRoleByService]);

  const visible = rows
    .filter((r) => {
      if (sum(r.sold) === 0) return false;
      if (onlyLeft && sum(availableOf(r)) <= 0.001) return false;
      if (onlyUnowned && !unownedBacklog.ids.has(r.id)) return false;
      if (consultantFilter) {
        const p = projects[r.id];
        if (!p) return false;
        const owns = ownerOf(p) === consultantFilter;
        const supervises = isSupervisorOn(p, consultantFilter);
        if (!owns && !supervises) return false;
      }
      // ── Column filters ──
      if (fClient) {
        const name = (clientNames[r.clientId] ?? "").toLowerCase();
        const type = (r.type ?? "").toLowerCase();
        if (!name.includes(fClient.toLowerCase()) && !type.includes(fClient.toLowerCase())) return false;
      }
      if (fDays === "left" && sum(availableOf(r)) <= 0.001) return false;
      if (fDays === "none" && sum(availableOf(r)) > 0.001) return false;
      if (fDaysMin) {
        const min = Number(fDaysMin) || 0;
        if (inDays(r.id, sum(availableOf(r))) < min) return false;
      }
      if (fValueMin) {
        const min = Number(fValueMin) || 0;
        if (valueOf(r, availableOf(r)) < min) return false;
      }
      if (fTeamUser) {
        const uids = Object.keys(r.byUser);
        if (fTeamUser === "__none") { if (uids.length > 0) return false; }
        else if (!uids.includes(fTeamUser)) return false;
      }
      if (fProgress !== "any") {
        const sold = sum(r.sold);
        const billedPct = sold > 0 ? (sum(r.billed) / sold) * 100 : 0;
        if (fProgress === "unstarted" && billedPct > 0.01) return false;
        if (fProgress === "partial" && (billedPct <= 0.01 || billedPct >= 99.99)) return false;
        if (fProgress === "done" && billedPct < 99.99) return false;
      }
      if (fKickoff !== "any") {
        const age = ageDays(r);
        if (age == null) return false;
        if (fKickoff === "30" && age > 30) return false;
        if (fKickoff === "90" && age > 90) return false;
        if (fKickoff === "180" && age > 180) return false;
        if (fKickoff === "365" && age > 365) return false;
        if (fKickoff === "older" && age <= 365) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortKey) {
        case "client":
          return dir * (clientNames[a.clientId] ?? "").localeCompare(clientNames[b.clientId] ?? "");
        case "progress": {
          const pa = sum(a.sold) > 0 ? sum(a.billed) / sum(a.sold) : 0;
          const pb = sum(b.sold) > 0 ? sum(b.billed) / sum(b.sold) : 0;
          return dir * (pa - pb);
        }
        case "days":
          return dir * (inDays(a.id, sum(availableOf(a))) - inDays(b.id, sum(availableOf(b))));
        case "value":
          return dir * (valueOf(a, availableOf(a)) - valueOf(b, availableOf(b)));
        case "team":
          return dir * (Object.keys(a.byUser).length - Object.keys(b.byUser).length);
        case "kickoff": {
          // Oldest kickoff first when ascending; missing kickoffs sort last.
          const ka = a.kickoff || "9999-99-99";
          const kb = b.kickoff || "9999-99-99";
          return dir * ka.localeCompare(kb);
        }
        default:
          return 0;
      }
    });

  const clientCount = new Set(visible.map((r) => r.clientId)).size;

  /** Every consultant worth offering in the filter: owns at least one project
      with something still to deliver, or supervises one. */
  const consultantOptions = useMemo(() => {
    const ids = new Set<string>();
    rows.forEach((r) => {
      const p = projects[r.id];
      if (!p || sum(r.sold) === 0) return;
      const owner = ownerOf(p);
      if (owner) ids.add(owner);
      (p.team ?? []).forEach((m) => { if (m.userId && supRoles.has(m.role ?? "")) ids.add(m.userId); });
    });
    return Array.from(ids)
      .map((id) => ({ id, name: people[id] || "Unknown" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, projects, people, supRoles, mainRoleByService]);

  /** For the selected consultant: consultancy backlog comes only from projects
      they OWN (their main-role assignment), and never counts connector or
      supervision lines. Supervision backlog is separate — it comes from any
      project (owned or not) where they hold a supervision-tagged role. */
  const myBreakdown = useMemo(() => {
    if (!consultantFilter) return null;
    let consultDays = 0, consultValue = 0, superDays = 0, superValue = 0;
    rows.forEach((r) => {
      if (sum(r.sold) === 0) return;
      if (onlyLeft && sum(availableOf(r)) <= 0.001) return;
      const p = projects[r.id];
      if (!p) return;
      const avail = availableOf(r);
      if (ownerOf(p) === consultantFilter) {
        consultDays += inDays(r.id, avail.consultor);
        consultValue += avail.consultor * r.rate;
      }
      if (isSupervisorOn(p, consultantFilter)) {
        superDays += inDays(r.id, avail.supervision);
        superValue += avail.supervision * r.supervisionRate;
      }
    });
    return { consultDays, consultValue, superDays, superValue };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consultantFilter, rows, projects, onlyLeft, mainRoleByService, supRoles]);

  /** When a consultant is picked, the headline KPIs reflect only THEIR share:
   *  consultancy on projects they own + supervision where they supervise, in
   *  days and value, plus the sold/billed for the % dial — never the whole
   *  project. Connector is tracked apart (their owned projects), split into
   *  implemented (billed) vs pending, and never folded into the totals. */
  const personalKpis = useMemo(() => {
    if (!consultantFilter) return null;
    let soldDays = 0, billedDays = 0, plannedDays = 0, availDays = 0, availValue = 0;
    let connImplDays = 0, connPendDays = 0, connImplValue = 0, connPendValue = 0;
    rows.forEach((r) => {
      if (sum(r.sold) === 0) return;
      const p = projects[r.id];
      if (!p) return;
      const owns = ownerOf(p) === consultantFilter;
      const supervises = isSupervisorOn(p, consultantFilter);
      if (!owns && !supervises) return;

      // Consultancy line counts only for projects this person owns.
      if (owns) {
        const soldC = r.sold.consultor, billedC = r.billed.consultor, plannedC = r.planned.consultor;
        const availC = Math.max(0, soldC - billedC);
        soldDays += inDays(r.id, soldC);
        billedDays += inDays(r.id, billedC);
        plannedDays += inDays(r.id, plannedC);
        availDays += inDays(r.id, availC);
        availValue += availC * r.rate;

        // Connector of their owned projects — kept out of the totals above.
        const connImpl = r.billed.connector;
        const connPend = Math.max(0, r.sold.connector - r.billed.connector);
        connImplDays += inDays(r.id, connImpl);
        connPendDays += inDays(r.id, connPend);
        connImplValue += connImpl * r.rate;
        connPendValue += connPend * r.rate;
      }
      // Supervision line counts wherever they hold a supervision role.
      if (supervises) {
        const soldS = r.sold.supervision, billedS = r.billed.supervision, plannedS = r.planned.supervision;
        const availS = Math.max(0, soldS - billedS);
        soldDays += inDays(r.id, soldS);
        billedDays += inDays(r.id, billedS);
        plannedDays += inDays(r.id, plannedS);
        availDays += inDays(r.id, availS);
        availValue += availS * r.supervisionRate;
      }
    });
    return {
      soldDays, billedDays, plannedDays, availDays, availValue,
      connImplDays, connPendDays, connImplValue, connPendValue,
      connTotalDays: connImplDays + connPendDays,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consultantFilter, rows, projects, mainRoleByService, supRoles]);

  const totalSold = visible.reduce((s, r) => s + inDays(r.id, sum(r.sold)), 0);
  const totalBilled = visible.reduce((s, r) => s + inDays(r.id, sum(r.billed)), 0);
  const totalPlanned = visible.reduce((s, r) => s + inDays(r.id, sum(r.planned)), 0);
  const totalAvailable = visible.reduce((s, r) => s + inDays(r.id, sum(availableOf(r))), 0);
  const totalValue = visible.reduce((s, r) => s + valueOf(r, availableOf(r)), 0);

  // When a consultant is selected, the headline KPIs switch to their share
  // (computed in personalKpis); otherwise they show the panel-wide totals.
  const kSold = personalKpis ? personalKpis.soldDays : totalSold;
  const kBilled = personalKpis ? personalKpis.billedDays : totalBilled;
  const kAvailable = personalKpis ? personalKpis.availDays : totalAvailable;
  const kValue = personalKpis ? personalKpis.availValue : totalValue;
  const deliveredPct = kSold > 0 ? (kBilled / kSold) * 100 : 0;

  // Split of what is still to deliver: genuine day-rate days vs hourly hours.
  const availDayDays = visible.filter((r) => !isHourly(r.id)).reduce((s, r) => s + sum(availableOf(r)), 0);
  const availHourHours = visible.filter((r) => isHourly(r.id)).reduce((s, r) => s + sum(availableOf(r)), 0);

  // Connector days bill on their own pool, so they get their own counter.
  const coreOf = (r: ProjRow) => {
    const a = availableOf(r);
    return { consultor: a.consultor, supervision: a.supervision, connector: 0 } as Tally;
  };
  const connOf = (r: ProjRow) => {
    const a = availableOf(r);
    return { consultor: 0, supervision: 0, connector: a.connector } as Tally;
  };
  const availCore = visible.reduce((s, r) => s + inDays(r.id, r.sold.consultor + r.sold.supervision - r.billed.consultor - r.billed.supervision), 0);
  const availConnector = visible.reduce((s, r) => s + inDays(r.id, availableOf(r).connector), 0);
  const valueCore = visible.reduce((s, r) => s + valueOf(r, coreOf(r)), 0);
  const valueConnector = visible.reduce((s, r) => s + valueOf(r, connOf(r)), 0);

  /** Average consultancy day-rate, weighted by consultancy days sold across live projects. */
  const avgDayRate = (() => {
    let daySum = 0, weighted = 0, count = 0, rateSum = 0;
    visible.forEach((r) => {
      if (r.rate > 0) { rateSum += r.rate; count += 1; }
      // Hourly: rate is €/hour and volume is hours — put both on a day basis.
      const days = inDays(r.id, r.sold.consultor);
      const dayRate = isHourly(r.id) ? r.rate * hpd : r.rate;
      if (days > 0 && dayRate > 0) { weighted += dayRate * days; daySum += days; }
    });
    const byDays = daySum > 0 ? weighted / daySum : 0;
    const simple = count > 0 ? rateSum / count : 0;
    return { byDays, simple, count, byHour: byDays / hpd };
  })();

  /** Last day anyone logged against each project — the closest thing to an end date we have. */
  const lastDay = useMemo(() => {
    const out: Record<string, string> = {};
    entries.forEach((e) => {
      if (e.status === "cancelled" || !e.projectId || !e.date) return;
      if (!out[e.projectId] || e.date > out[e.projectId]) out[e.projectId] = e.date;
    });
    return out;
  }, [entries]);

  const spans = Object.values(projects)
    .map((p) => {
      const end = lastDay[p.id];
      if (!p.kickoff || !end) return null;
      const a = new Date(`${p.kickoff}T00:00:00`).getTime();
      const b = new Date(`${end}T00:00:00`).getTime();
      const d = Math.round((b - a) / 86400000);
      return d >= 0 ? d : null;
    })
    .filter((d): d is number => d !== null);
  const avgSpan = spans.length ? spans.reduce((s, d) => s + d, 0) / spans.length : 0;
  const minSpan = spans.length ? Math.min(...spans) : 0;
  const maxSpan = spans.length ? Math.max(...spans) : 0;

  /* ---------- Backlog over time ---------- */
  /** Bucket closing dates for the selected period. Backlog is measured at each close. */
  const bounds = useMemo<{ label: string; end: string }[]>(() => {
    const out: { label: string; end: string }[] = [];
    const push = (label: string, d: Date) => out.push({ label, end: iso(d) });

    if (scope === "week") {
      const ws = startOfWeek(anchor);
      ["Mon", "Tue", "Wed", "Thu", "Fri"].forEach((n, i) => push(n, addDays(ws, i)));
    } else if (scope === "month") {
      const y = anchor.getFullYear(), m = anchor.getMonth();
      const last = endOfMonth(y, m);
      for (let k = 0; k < 5; k++) {
        const d = new Date(y, m, 7 + k * 7);
        push(`W${k + 1}`, d > last ? last : d);
        if (d >= last) break;
      }
    } else if (scope === "year") {
      const y = anchor.getFullYear();
      for (let m = 0; m < 12; m++) push(MONTHS_SHORT[m], endOfMonth(y, m));
    } else if (scope === "custom" && rangeFrom && rangeTo) {
      const a = new Date(`${rangeFrom}T00:00:00`);
      const b = new Date(`${rangeTo}T00:00:00`);
      const span = Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
      if (span <= 14) {
        for (let i = 0; i < span; i++) {
          const d = addDays(a, i);
          push(`${d.getDate()}`, d);
        }
      } else if (span <= 120) {
        let k = 1;
        for (let s = startOfWeek(a); s <= b; s = addDays(s, 7), k++) {
          const e = addDays(s, 6);
          push(`W${k}`, e > b ? b : e);
        }
      } else {
        for (let s = new Date(a.getFullYear(), a.getMonth(), 1); s <= b; s = new Date(s.getFullYear(), s.getMonth() + 1, 1)) {
          const e = endOfMonth(s.getFullYear(), s.getMonth());
          push(MONTHS_SHORT[s.getMonth()], e > b ? b : e);
        }
      }
    } else {
      // All time: monthly, from the first thing that ever happened up to now.
      const dates = entries.map((e) => e.date).filter(Boolean).sort();
      const kicks = Object.values(projects).map((p) => p.kickoff).filter(Boolean).sort();
      const first = [dates[0], kicks[0]].filter(Boolean).sort()[0];
      if (!first) return out;
      let s = new Date(`${first}T00:00:00`);
      s = new Date(s.getFullYear(), s.getMonth(), 1);
      const now = new Date();
      const cap = new Date(now.getFullYear(), now.getMonth(), 1);
      const all: { label: string; end: string }[] = [];
      for (; s <= cap; s = new Date(s.getFullYear(), s.getMonth() + 1, 1)) {
        const e = endOfMonth(s.getFullYear(), s.getMonth());
        all.push({ label: MONTHS_SHORT[s.getMonth()], end: iso(e > now ? now : e) });
      }
      return all.slice(-18);
    }
    return out;
  }, [scope, anchor, rangeFrom, rangeTo, entries, projects]);

  /** Backlog at each close: sold days of started projects minus what was billed by then. */
  const series = useMemo(() => {
    const confirmed = entries
      .filter((e) => e.status === "confirmed" && e.line !== "closure" && e.projectId && e.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    const billedSoFar: Record<string, Tally> = {};
    let i = 0;

    return bounds.map((b) => {
      while (i < confirmed.length && confirmed[i].date <= b.end) {
        const e = confirmed[i];
        const p = projects[e.projectId];
        if (p) {
          if (!billedSoFar[e.projectId]) billedSoFar[e.projectId] = blank();
          billedSoFar[e.projectId][lineOf(p, e.line, e.userId)] += e.billable;
        }
        i += 1;
      }

      let days = 0;
      let value = 0;
      Object.values(projects).forEach((p) => {
        if (p.kickoff && p.kickoff > b.end) return;
        const bl = billedSoFar[p.id] ?? blank();
        const c = Math.max(0, p.consultorDays - bl.consultor);
        const s = Math.max(0, p.supervisionDays - bl.supervision);
        const k = Math.max(0, p.connectorDays - bl.connector);
        days += c + s + k;
        value += c * p.rate + k * p.rate + s * p.supervision;
      });
      return { label: b.label, end: b.end, days, value };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, entries, projects, supRoles]);

  const chartKey = chartMode === "days" ? "days" : "value";
  const peak = Math.max(1, ...series.map((p) => p[chartKey]));
  const first = series.length ? series[0][chartKey] : 0;
  const last = series.length ? series[series.length - 1][chartKey] : 0;
  const delta = last - first;

  const CW = 1000;
  const CH = 150;
  const px = (i: number) => (series.length <= 1 ? CW / 2 : (i / (series.length - 1)) * CW);
  const py = (v: number) => CH - (v / (peak * 1.12)) * CH;
  const fmt = (v: number) => (chartMode === "days" ? v.toFixed(2) : Math.round(v).toLocaleString());

  const w = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);
  const scheduledPct = totalSold > 0 ? ((totalBilled + totalPlanned) / totalSold) * 100 : 0;

  /* ---------- presentation ---------- */
  const armed = useBlArmed(320);
  const canFlip = availHourHours > 0;
  const split = unitMode === "split" && canFlip;
  const flip = () => setUnitMode((m) => (m === "days" ? "split" : "days"));
  const asOfLabel = (() => {
    const d = new Date(`${asOf}T00:00:00`);
    return Number.isNaN(d.getTime()) ? asOf : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  })();
  const valueTotal = valueCore + valueConnector;
  const spanMax = Math.max(1, maxSpan);
  const dash = (pct: number) => `${armed ? Math.min(100, Math.max(0, pct)).toFixed(2) : "0"} 101`;
  const chartPts = series.map((p, i) => [px(i), py(p[chartKey])] as [number, number]);
  const smoothLine = blSmooth(chartPts.length === 1 ? [[0, chartPts[0][1]], [CW, chartPts[0][1]]] : chartPts, CH);
  const smoothArea = smoothLine ? `${smoothLine} L${CW},${CH} L0,${CH} Z` : "";
  const axisStep = series.length <= 12 ? 1 : Math.ceil(series.length / 12);

  return (
    <div className="bl" onPointerMove={blSpot}>
      {/* ---------- headline cards on the dark band ---------- */}
      <section className="bl-hero">
        <div className="bl-kpis">
          <BlCard
            i={0}
            className="is-gauge"
            icon={BL_ICON.days}
            label="Days to deliver"
            swap={canFlip ? (split ? "By line" : "Days and hours") : undefined}
            onClick={canFlip ? flip : undefined}
            title={canFlip ? "Click to split hours from days" : undefined}
          >
            <span className="bl-gauge">
              <span className="bl-dial">
                <svg viewBox="0 0 140 80" aria-hidden="true">
                  <path className="bl-arc-bg" d={BL_ARC} pathLength={100} />
                  <path className={`bl-arc-proj ${armed && scheduledPct > 0 ? "" : "is-zero"}`} d={BL_ARC} pathLength={100} style={{ strokeDasharray: dash(scheduledPct) }} />
                  <path className={`bl-arc-fill ${armed && deliveredPct > 0 ? "" : "is-zero"}`} d={BL_ARC} pathLength={100} style={{ strokeDasharray: dash(deliveredPct) }} />
                </svg>
                <span className="bl-dial-pct"><BlCount value={deliveredPct} /><em>%</em></span>
                <small className="bl-dial-cap">billed</small>
              </span>
              <span className="bl-gauge-txt">
                <b className="bl-val"><BlCount value={kAvailable} /><em>days left</em></b>
                <small>of {kSold.toFixed(0)} days sold</small>
              </span>
            </span>
            <span className="bl-facts">
              {personalKpis ? (
                <>
                  <span><b>{kAvailable.toFixed(1)}</b>Their work</span>
                  <span className="is-conn"><b>{personalKpis.connTotalDays.toFixed(1)}</b>Connector</span>
                </>
              ) : split ? (
                <>
                  <span><b>{availDayDays.toFixed(1)}</b>Days</span>
                  <span className="is-conn"><b>{availHourHours.toFixed(0)}</b>Hours</span>
                </>
              ) : (
                <>
                  <span><b>{availCore.toFixed(1)}</b>Consultancy</span>
                  <span className="is-conn"><b>{availConnector.toFixed(1)}</b>Connector</span>
                </>
              )}
            </span>
          </BlCard>

          <BlCard i={1} icon={BL_ICON.value} label="Unbilled value">
            <b className="bl-val"><BlCount value={kValue} fmt={blEur} /><em>€</em></b>
            {personalKpis ? (
              <>
                <span className="bl-facts">
                  <span><b>{blEur(kValue)}</b>Their work</span>
                  <span className="is-conn"><b>{blEur(personalKpis.connPendValue)}</b>Connector left</span>
                </span>
                <span className="bl-facts" style={{ marginTop: 6 }}>
                  <span><b>{personalKpis.connImplDays.toFixed(1)}d</b>Connector done</span>
                  <span className="is-conn"><b>{personalKpis.connPendDays.toFixed(1)}d</b>Connector pending</span>
                </span>
              </>
            ) : (
              <>
                <span className="bl-mix" aria-hidden="true">
                  <i style={{ width: `${armed && valueTotal > 0 ? (valueCore / valueTotal) * 100 : 0}%` }} />
                  <i className="is-conn" style={{ width: `${armed && valueTotal > 0 ? (valueConnector / valueTotal) * 100 : 0}%` }} />
                </span>
                <span className="bl-facts">
                  <span><b>{blEur(valueCore)}</b>Consultancy</span>
                  <span className="is-conn"><b>{blEur(valueConnector)}</b>Connector</span>
                </span>
              </>
            )}
          </BlCard>

          <BlCard i={2} icon={BL_ICON.length} label="Avg project length">
            <b className="bl-val"><BlCount value={avgSpan} /><em>days</em></b>
            <span className="bl-range" aria-hidden="true" title={`${minSpan} to ${maxSpan} days`}>
              <i className="bl-range-band" style={{ left: `${(minSpan / spanMax) * 100}%`, width: `${armed ? ((maxSpan - minSpan) / spanMax) * 100 : 0}%` }} />
              {spans.length > 0 && <i className="bl-range-avg" style={{ left: `${(avgSpan / spanMax) * 100}%` }} />}
            </span>
            <span className="bl-facts is-3">
              <span><b>{minSpan}</b>Shortest</span>
              <span><b>{maxSpan}</b>Longest</span>
              <span className="is-conn"><b>{spans.length}</b>Projects</span>
            </span>
          </BlCard>

          <BlCard
            i={3}
            icon={BL_ICON.rate}
            label={`Avg ${split ? "hour" : "day"} rate`}
            swap={canFlip ? (split ? "Per day" : "Per hour") : undefined}
            onClick={canFlip ? flip : undefined}
            title={canFlip ? "Click to show the per-hour rate" : undefined}
          >
            <b className="bl-val"><BlCount value={split ? avgDayRate.byHour : avgDayRate.byDays} fmt={blEur} /><em>€/{split ? "hour" : "day"}</em></b>
            <span className="bl-facts">
              {split ? (
                <>
                  <span><b>{blEur(avgDayRate.byHour)}</b>Per hour</span>
                  <span className="is-conn"><b>{blEur(avgDayRate.byDays)}</b>Per day</span>
                </>
              ) : (
                <>
                  <span><b>{blEur(avgDayRate.byDays)}</b>Weighted</span>
                  <span className="is-conn"><b>{blEur(avgDayRate.simple)}</b>Per project</span>
                </>
              )}
            </span>
          </BlCard>
        </div>
      </section>

      {/* ---------- light sheet ---------- */}
      <section className="bl-sheet">
        {/* ---------- toolbar ---------- */}
        <div className="bl-card bl-toolbar">
          <p className="bl-note">
            <span className="bl-asof"><BlIcon d={BL_ICON.cal} w={1.9} />As of <b>{asOfLabel}</b></span>
            <span>
              {visible.length} {visible.length === 1 ? "project" : "projects"} across {clientCount} {clientCount === 1 ? "client" : "clients"} kicked off by then
            </span>
          </p>
          <div className="bl-legend" aria-hidden="true">
            <span><i className="is-billed" />Billed</span>
            <span><i className="is-planned" />Scheduled</span>
            <span><i className="is-free" />Not booked</span>
          </div>
          <div className="bl-pick">
            <Select
              value={consultantFilter}
              onChange={setConsultantFilter}
              placeholder="All consultants"
              options={[{ value: "", label: "All consultants" }, ...consultantOptions.map((c) => ({ value: c.id, label: c.name }))]}
            />
          </div>
          <label className="bl-switch">
            <input type="checkbox" checked={onlyLeft} onChange={(e) => setOnlyLeft(e.target.checked)} />
            <span className="bl-switch-ui" aria-hidden="true" />
            <span>Only projects with days left</span>
          </label>
        </div>

        {/* ---------- one consultant's backlog ---------- */}
        {myBreakdown && (
          <div className="bl-card bl-mine">
            <span className="bl-mine-who">
              <span className="bl-av is-lg">{(people[consultantFilter] || "?").charAt(0).toUpperCase()}</span>
              <span className="bl-mine-name">
                <b>{people[consultantFilter] || "This consultant"}</b>
                <small>Personal backlog</small>
              </span>
            </span>
            <div className="bl-mine-figs">
              <div className="bl-mine-fig">
                <span>Consultancy <i>owned projects</i></span>
                <b><BlCount value={myBreakdown.consultDays} fmt={(n) => n.toFixed(1)} /><em>d</em></b>
                <small>{blEur(myBreakdown.consultValue)} €</small>
              </div>
              <div className="bl-mine-fig is-super">
                <span>Supervision <i>assigned as supervisor</i></span>
                <b><BlCount value={myBreakdown.superDays} fmt={(n) => n.toFixed(1)} /><em>d</em></b>
                <small>{blEur(myBreakdown.superValue)} €</small>
              </div>
              <div className="bl-mine-fig is-total">
                <span>Total</span>
                <b><BlCount value={myBreakdown.consultDays + myBreakdown.superDays} fmt={(n) => n.toFixed(1)} /><em>d</em></b>
                <small>{blEur(myBreakdown.consultValue + myBreakdown.superValue)} €</small>
              </div>
            </div>
          </div>
        )}

        {/* ---------- backlog nobody owns yet ---------- */}
        {unownedBacklog.days > 0.05 && (
          <div className={`bl-unowned ${onlyUnowned ? "is-active" : ""}`}>
            <span className="bl-unowned-ico"><BlIcon d={BL_ICON.warn} w={1.9} /></span>
            <span>
              <b>{unownedBacklog.days.toFixed(1)}d</b> ({blEur(unownedBacklog.value)} €) of consultancy backlog across{" "}
              <b>{unownedBacklog.projectCount}</b> project{unownedBacklog.projectCount === 1 ? "" : "s"} isn't owned by anyone yet. Set a main role for
              {" "}the service in Products &amp; Services, or add that person to the project's team, and it'll show up under them here.
            </span>
            <button type="button" className="bl-unowned-btn" onClick={() => setOnlyUnowned((v) => !v)}>
              {onlyUnowned ? "Show all" : `Show the ${unownedBacklog.projectCount}`}
            </button>
          </div>
        )}

        {/* ---------- projects (this is the only part that scrolls) ---------- */}
        <div className="bl-scroll">
        {visible.length === 0 ? (
          <div className="bl-empty">
            <span className="bl-empty-art"><BlIcon d={BL_ICON.empty} w={1.6} /></span>
            <p>Nothing left to deliver. Every sold day is billed.</p>
          </div>
        ) : (
          <div className="bl-list">
            <div className="bl-head">
              <ColHeader label="Client and project" isOpen={openMenu === "client"} onToggle={() => setOpenMenu(openMenu === "client" ? null : "client")}
                active={!!fClient} sortArrow={sortKey === "client" ? sortDir : null}>
                <button className="bl-mi" onClick={() => setSort("client", "asc")}>Sort A → Z</button>
                <button className="bl-mi" onClick={() => setSort("client", "desc")}>Sort Z → A</button>
                <div className="bl-msep" />
                <label className="bl-mlabel">Search client or type</label>
                <input className="bl-minput" value={fClient} onChange={(e) => setFClient(e.target.value)} placeholder="Type to filter…" autoFocus />
              </ColHeader>

              <ColHeader label="Progress" isOpen={openMenu === "progress"} onToggle={() => setOpenMenu(openMenu === "progress" ? null : "progress")}
                active={fProgress !== "any"} sortArrow={sortKey === "progress" ? sortDir : null}>
                <button className="bl-mi" onClick={() => setSort("progress", "asc")}>Least billed first</button>
                <button className="bl-mi" onClick={() => setSort("progress", "desc")}>Most billed first</button>
                <div className="bl-msep" />
                <label className="bl-mlabel">Show</label>
                {(["any", "unstarted", "partial", "done"] as const).map((v) => (
                  <button key={v} className={`bl-mi ${fProgress === v ? "is-on" : ""}`} onClick={() => setFProgress(v)}>
                    {v === "any" ? "All" : v === "unstarted" ? "Not started" : v === "partial" ? "In progress" : "Fully billed"}
                  </button>
                ))}
              </ColHeader>

              <ColHeader label="Days left" align="right" isOpen={openMenu === "days"} onToggle={() => setOpenMenu(openMenu === "days" ? null : "days")}
                active={fDays !== "any" || !!fDaysMin} sortArrow={sortKey === "days" ? sortDir : null}>
                <button className="bl-mi" onClick={() => setSort("days", "desc")}>Most days first</button>
                <button className="bl-mi" onClick={() => setSort("days", "asc")}>Fewest days first</button>
                <div className="bl-msep" />
                <label className="bl-mlabel">Show</label>
                {(["any", "left", "none"] as const).map((v) => (
                  <button key={v} className={`bl-mi ${fDays === v ? "is-on" : ""}`} onClick={() => setFDays(v)}>
                    {v === "any" ? "All" : v === "left" ? "With days left" : "Fully delivered"}
                  </button>
                ))}
                <div className="bl-msep" />
                <label className="bl-mlabel">At least (days)</label>
                <input className="bl-minput" type="number" min="0" value={fDaysMin} onChange={(e) => setFDaysMin(e.target.value)} placeholder="e.g. 5" />
              </ColHeader>

              <ColHeader label="Value left" align="right" isOpen={openMenu === "value"} onToggle={() => setOpenMenu(openMenu === "value" ? null : "value")}
                active={!!fValueMin} sortArrow={sortKey === "value" ? sortDir : null}>
                <button className="bl-mi" onClick={() => setSort("value", "desc")}>Highest value first</button>
                <button className="bl-mi" onClick={() => setSort("value", "asc")}>Lowest value first</button>
                <div className="bl-msep" />
                <label className="bl-mlabel">At least (€)</label>
                <input className="bl-minput" type="number" min="0" value={fValueMin} onChange={(e) => setFValueMin(e.target.value)} placeholder="e.g. 5000" />
              </ColHeader>

              <ColHeader label="Team" isOpen={openMenu === "team"} onToggle={() => setOpenMenu(openMenu === "team" ? null : "team")}
                active={!!fTeamUser} sortArrow={sortKey === "team" ? sortDir : null} menuAlign="right">
                <button className="bl-mi" onClick={() => setSort("team", "desc")}>Biggest team first</button>
                <button className="bl-mi" onClick={() => setSort("team", "asc")}>Smallest team first</button>
                <div className="bl-msep" />
                <label className="bl-mlabel">Has member</label>
                <div className="bl-mscroll">
                  <button className={`bl-mi ${fTeamUser === "" ? "is-on" : ""}`} onClick={() => setFTeamUser("")}>Anyone</button>
                  <button className={`bl-mi ${fTeamUser === "__none" ? "is-on" : ""}`} onClick={() => setFTeamUser("__none")}>No one yet</button>
                  {consultantOptions.map((c) => (
                    <button key={c.id} className={`bl-mi ${fTeamUser === c.id ? "is-on" : ""}`} onClick={() => setFTeamUser(c.id)}>{c.name}</button>
                  ))}
                </div>
              </ColHeader>

              <ColHeader label="Kickoff" isOpen={openMenu === "kickoff"} onToggle={() => setOpenMenu(openMenu === "kickoff" ? null : "kickoff")}
                active={fKickoff !== "any"} sortArrow={sortKey === "kickoff" ? sortDir : null} menuAlign="right">
                <button className="bl-mi" onClick={() => setSort("kickoff", "desc")}>Newest first</button>
                <button className="bl-mi" onClick={() => setSort("kickoff", "asc")}>Oldest first</button>
                <div className="bl-msep" />
                <label className="bl-mlabel">Age since kickoff</label>
                {([["any", "Any age"], ["30", "Last 30 days"], ["90", "Last 3 months"], ["180", "Last 6 months"], ["365", "Last year"], ["older", "Over a year"]] as const).map(([v, lbl]) => (
                  <button key={v} className={`bl-mi ${fKickoff === v ? "is-on" : ""}`} onClick={() => setFKickoff(v)}>{lbl}</button>
                ))}
              </ColHeader>

              <span className="bl-hcell-end">
                {activeFilterCount > 0 && (
                  <button type="button" className="bl-hclear" onClick={clearColumnFilters} title="Clear all column filters">
                    Clear {activeFilterCount}
                  </button>
                )}
              </span>
            </div>
            {visible.map((r, ri) => {
              const avail = availableOf(r);
              const sold = sum(r.sold);
              const isOpen = open === r.id;
              const u = isHourly(r.id) ? "h" : "d";
              const team = Object.entries(r.byUser)
                .sort((a, b) => (b[1].billed + b[1].planned) - (a[1].billed + a[1].planned));
              const billedW = Math.min(100, w(sum(r.billed), sold));
              const planW = Math.min(100 - billedW, w(sum(r.planned), sold));
              const teamMax = Math.max(0.0001, ...team.map(([, v]) => v.billed + v.planned));
              return (
                <div className={`bl-row ${isOpen ? "is-open" : ""} ${unownedBacklog.ids.has(r.id) ? "is-unowned" : ""}`} key={r.id} style={blVars({ "--i": Math.min(ri, 14) })}>
                  <button type="button" className="bl-row-main" data-spot="" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                    <span className="bl-who">
                      <span className="bl-av">{(clientNames[r.clientId] ?? "?").charAt(0).toUpperCase()}</span>
                      <span className="bl-who-t">
                        <b>{clientNames[r.clientId] ?? "—"}</b>
                        <small>{r.type}</small>
                      </span>
                    </span>

                    <span className="bl-prog">
                      <span className="bl-bar">
                        <i className="is-billed" style={{ width: `${billedW}%` }} title={`${sum(r.billed).toFixed(2)} billed`} />
                        <i className="is-planned" style={{ width: `${planW}%` }} title={`${sum(r.planned).toFixed(2)} scheduled`} />
                      </span>
                      <span className="bl-prog-txt">
                        <span><b>{sum(r.billed).toFixed(1)}</b> billed</span>
                        <span><b>{sum(r.planned).toFixed(1)}</b> scheduled</span>
                        <span>of <b>{sold.toFixed(1)}</b>{u} sold</span>
                      </span>
                    </span>

                    <span className="bl-num"><b>{sum(avail).toFixed(2)}<em>{u}</em></b></span>
                    <span className="bl-num is-val"><b>{blEur(valueOf(r, avail))} €</b></span>

                    <span className="bl-team">
                      {team.length === 0 ? (
                        <em className="bl-team-none">No one yet</em>
                      ) : (
                        <span className="bl-avs">
                          {team.slice(0, 4).map(([uid]) => (
                            <span className="bl-av is-sm" key={uid} title={people[uid] ?? "Unknown user"}>{(people[uid] ?? "?").charAt(0).toUpperCase()}</span>
                          ))}
                          {team.length > 4 && <span className="bl-av is-sm is-more">+{team.length - 4}</span>}
                        </span>
                      )}
                    </span>

                    <span className="bl-kick">
                      {(() => {
                        const age = ageDays(r);
                        if (age == null) return <em className="bl-kick-none">—</em>;
                        const label = age < 31 ? `${age}d` : age < 365 ? `${Math.round(age / 30)}mo` : `${(age / 365).toFixed(1)}y`;
                        return <><b>{label}</b><small>{r.kickoff}</small></>;
                      })()}
                    </span>

                    <span className="bl-chev"><BlIcon d={BL_ICON.chev} w={2.4} /></span>
                  </button>

                  {isOpen && (
                    <div className="bl-detail">
                      <div className="bl-chips">
                        <span className="bl-chips-k">Sold</span>
                        {r.sold.consultor > 0 && <i>{r.sold.consultor} consultancy</i>}
                        {r.sold.supervision > 0 && <i>{r.sold.supervision} supervision</i>}
                        {r.sold.connector > 0 && <i className="is-conn">{r.sold.connector} connector</i>}
                      </div>
                      {team.length > 0 && (
                        <div className="bl-dtable">
                          <div className="bl-dhead">
                            <span>Consultant</span>
                            <span className="is-r">Billed</span>
                            <span className="is-r">Scheduled</span>
                            <span />
                          </div>
                          {team.map(([uid, v], di) => (
                            <div className="bl-dline" key={uid} style={blVars({ "--d": di })}>
                              <span className="bl-dwho"><span className="bl-av is-sm">{(people[uid] ?? "?").charAt(0).toUpperCase()}</span>{people[uid] ?? "Unknown user"}</span>
                              <span className="is-r bl-dbilled">{v.billed.toFixed(2)}</span>
                              <span className="is-r bl-dplanned">{v.planned.toFixed(2)}</span>
                              <span className="bl-dbar" aria-hidden="true">
                                <i className="is-billed" style={{ width: `${(v.billed / teamMax) * 100}%` }} />
                                <i className="is-planned" style={{ width: `${(v.planned / teamMax) * 100}%` }} />
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </div>
      </section>
    </div>
  );
}