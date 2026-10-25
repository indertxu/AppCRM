/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { PageCover, PageLoader } from "../../framework/AppLayout";
import { supabase } from "../../api/supabase";
import { inBillingMonth, periodOf, billingWindow, type Cutoffs } from "../calendar/billingPeriods";
import {
  mapClientRole, sortRoles, roleColor, roleLinesOfRow, resolvedLinesOf, legacyRoleMap, resolveRoleKey, roleKeyOf,
  roleNameOf, roleCounts, rateOn, totalDiscountOf, parseHolds, type ClientRole, type RoleLine, type HoldPeriod,
} from "../clients/clientsTypes";
import CalendarSettingsModal, { type WorkTypeDef, type Targets, type CapValue } from "../calendar/CalendarSettingsModal";
import UserTargetModal, { type UserTarget } from "./UserTargetModal";
import DatePicker from "../../framework/DatePicker";
import BacklogPanel from "./BacklogPanel";
import SavedDaysModal from "./SavedDaysModal";
import BonusPanel from "./BonusPanel";
import ConsultantModal from "./ConsultantModal";
import BillingPanel from "./BillingPanel";
import IncomingPanel from "./IncomingPanel";
import MgmtSecurityModal from "./MgmtSecurityModal";
import { useMgmtAccess, type Level } from "./mgmtAccess";
import { useInactiveIds } from "../../framework/peopleStatus";
import { ClientLogo } from "../clients/ClientWorkspace";
import "./ManagementPage.css";
import { useNavSection } from "../../framework/pageAccess";

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

type Scope = "week" | "month" | "year" | "all" | "custom";

interface Entry {
  id: string;
  userId: string;
  projectId: string;
  date: string;
  billable: number;
  status: string;
  line: string;
  typeId: string;
  durationDays: number;
  /** Clock minutes the entry occupies, for capacity against the working day. */
  durationMin: number;
  billingPeriod: string | null;
}
interface Proj {
  id: string;
  clientId: string;
  typeId: string;
  kickoff: string;
  /** The roles sold on the project: days, rate and discount for each. */
  lines: RoleLine[];
  /** € off the whole project ("total" discount), 0 when none. */
  totalDiscount: number;
  status: string;
  /** When a closed project ended. */
  endDate: string;
  /** Its pauses (on hold): not counted in its length. */
  holds: HoldPeriod[];
  taxed: boolean;
  taxRate: number;
  legalName: string;
  vat: string;
  address: any;
  contacts: any[];
  team: { userId?: string; role?: string }[];
}
interface Row {
  userId: string;
  name: string;
  daysDone: number;
  /** Split by how the service bills, since a day and an hour are not the same. */
  hoursDone: number;
  hoursPlanned: number;
  daysPlanned: number;
amountDone: number;
  amountPlanned: number;
  connDays: number;
  connAmount: number;
  byProject: Record<string, {
    rateKind: string; rate: number;
    daysDone: number; daysPlanned: number;
    hoursDone: number; hoursPlanned: number;
    amountDone: number; amountPlanned: number;
  }>;
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
function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Mon-Fri days between two ISO dates, inclusive. Drives prorated targets. */
function businessDays(fromIso: string, toIso: string): number {
  if (!fromIso || !toIso) return 0;
  const a = new Date(`${fromIso}T00:00:00`);
  const b = new Date(`${toIso}T00:00:00`);
  if (b < a) return 0;
  let n = 0;
  for (const d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) n += 1;
  }
  return n;
}

/** Dates the Team tab needs: the period on screen plus two months each side. */
function windowFor(anchor: Date, scope: string): [string, string] | null {
  if (scope === "all") return null;
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const span = scope === "year" ? 12 : scope === "custom" ? 6 : 2;
  const from = new Date(anchor.getFullYear(), anchor.getMonth() - span, 1);
  const to = new Date(anchor.getFullYear(), anchor.getMonth() + span + 1, 0);
  return [iso(from), iso(to)];
}

/** Pages through the rows: a plain select stops at a thousand. */
async function fetchEntriesUncached(range: [string, string] | null): Promise<any[]> {
  const cols = "id, user_id, project_id, entry_date, billable, status, billing_line, role_id, work_type_id, start_min, end_min, billing_period";
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from("calendar_entries").select(cols)
      .order("entry_date", { ascending: true }).range(from, from + 999);
    if (range) q = q.gte("entry_date", range[0]).lte("entry_date", range[1]);
    const { data: page, error } = await q;
    if (error) { console.error("[mg] loading entries failed:", error.message); break; }
    out.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  return out;
}

/** The full-history fetch (range === null), used by Backlog/Billing/Bonus, is
 *  the slow one. It doesn't change while you flip between tabs, so cache it for
 *  a short window: the first jump pays for it, later jumps are instant. Team
 *  always passes a range, so it never touches this cache. */
let _allEntriesCache: { at: number; rows: any[] } | null = null;
let _allEntriesInFlight: Promise<any[]> | null = null;
const ALL_ENTRIES_TTL = 60_000;
export function invalidateEntriesCache() { _allEntriesCache = null; _allEntriesInFlight = null; }

async function fetchEntries(range: [string, string] | null): Promise<any[]> {
  if (range) return fetchEntriesUncached(range);
  const now = Date.now();
  if (_allEntriesCache && now - _allEntriesCache.at < ALL_ENTRIES_TTL) return _allEntriesCache.rows;
  if (_allEntriesInFlight) return _allEntriesInFlight;
  _allEntriesInFlight = fetchEntriesUncached(null).then((rows) => {
    _allEntriesCache = { at: Date.now(), rows };
    _allEntriesInFlight = null;
    return rows;
  }).catch((e) => { _allEntriesInFlight = null; throw e; });
  return _allEntriesInFlight;
}

/**
 * Management's loading states use the app-wide cube loader. The full one
 * covers the page area (rail stays visible) and fades out; the subtle one
 * sits over the backlog panel while the long history loads.
 */
function LoadingOverlay({ subtle = false, show = true }: { subtle?: boolean; show?: boolean }) {
  if (!subtle) return <PageCover show={show} label="Crunching the numbers" />;
  return (
    <div className="mg-loading is-subtle" role="status" aria-live="polite">
      <div className="mg-loading-card is-cube">
        <PageLoader fill={false} size={92} label="Loading the full history" />
      </div>
    </div>
  );
}

/* ===================================================================
   Team tab building blocks. Presentation only: every figure they show
   is computed inside ManagementPage exactly as before.
   =================================================================== */

const tmVars = (o: Record<string, string | number>) => o as CSSProperties;
const tmReduced = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const tmHue = (s: string) => {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};
const tmInitials = (name: string) =>
  name.split(" ").filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";

/** Eased count-up: from zero on mount, then glides between values when the period changes. */
function useTmCount(target: number, ms = 1100) {
  const [value, setValue] = useState(() => (tmReduced() ? target : 0));
  const from = useRef(value);
  useEffect(() => {
    if (tmReduced()) { from.current = target; setValue(target); return; }
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
function TmCount({ value, format }: { value: number; format: (n: number) => string }) {
  return <>{format(useTmCount(value))}</>;
}

/** Flips true just after mount so arcs have a zero state to sweep from. */
function useTmArmed(ms: number) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), tmReduced() ? 0 : ms);
    return () => window.clearTimeout(t);
  }, [ms]);
  return armed;
}

/** One pointer handler drives every spotlight and tilt on the Team tab. */
function tmSpotlight(e: ReactPointerEvent<HTMLElement>) {
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

const TM_ICON = {
  days: "M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 14l2 2 4-4",
  money: "M12 3v18M16.5 6.5H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7",
  swap: "M16 3l4 4-4 4M4 7h16M8 21l-4-4 4-4M20 17H4",
  arrow: "M5 12h14M13 6l6 6-6 6",
  team: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 19v-1a4 4 0 0 0-3-3.87M16 3.13a3.5 3.5 0 0 1 0 6.75",
  rate: "M4 19V9M10 19V5M16 19v-7M22 19H2",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
};
function TmIcon({ d, w = 2 }: { d: string; w?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const TM_ARC = "M16 70 A54 54 0 0 1 124 70";

/** Team headline strip: a small arc with the % of goal, the figure beside it; a click swaps to the planned vs realized bar. */
function TeamKpi({
  index, label, unit, icon, done, planned, goal, projPct, fmt, breakdown, onToggle,
}: {
  index: number; label: string; unit: string; icon: string;
  done: number; planned: number; goal: number; projPct: number;
  fmt: (n: number) => string; breakdown: boolean; onToggle: () => void;
}) {
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const armed = useTmArmed(380 + index * 120);
  const pctRaw = goal > 0 ? (done / goal) * 100 : 0;
  const over = pctRaw > 100;
  const fill = Math.min(1, pctRaw / 100);
  const overFill = over ? Math.min(1, (pctRaw - 100) / 100) : 0;
  const projFill = goal > 0 ? Math.min(1, (done + planned) / goal) : 0;
  const on = (f: number) => (armed ? f : 0);
  // Gap longer than the path so an empty arc never paints a round cap at either end.
  const dash = (f: number) => `${(on(f) * 100).toFixed(2)} 101`;
  const zero = (f: number) => (on(f) <= 0.0005 ? " is-zero" : "");
  const sp = unit === "€" ? " " : "";
  const u = `${sp}${unit}`;

  const barScale = Math.max(done + planned, goal, 1);
  const doneW = Math.min(100, (done / barScale) * 100);
  const planW = Math.min(100 - doneW, (planned / barScale) * 100);
  const goalAt = goal > 0 ? Math.min(97, Math.max(3, (goal / barScale) * 100)) : 0;

  return (
    <button
      type="button"
      className={`tm-kpi ${over ? "is-over" : ""} ${breakdown ? "is-breakdown" : ""}`}
      data-spot="tilt"
      style={tmVars({ "--i": index })}
      onClick={onToggle}
      aria-pressed={breakdown}
      title={breakdown ? "Show the total" : "Show planned and realized"}
    >
      <span className="tm-kpi-swap"><TmIcon d={TM_ICON.swap} w={2.2} /><span>{breakdown ? "Show total" : "Show planned"}</span></span>

      <span className="tm-gauge">
        <span className="tm-arc" aria-hidden={breakdown}>
          <span className="tm-dial">
            <svg viewBox="0 0 140 80" aria-hidden="true">
              <defs>
                <linearGradient id={`f${gid}`} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#1fb98a" />
                  <stop offset="100%" stopColor="#c9f2dd" />
                </linearGradient>
                <linearGradient id={`o${gid}`} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#e0a43c" />
                  <stop offset="100%" stopColor="#fbe2b0" />
                </linearGradient>
              </defs>
              <path className="tm-arc-bg" d={TM_ARC} pathLength={100} />
              <path className={`tm-arc-proj${zero(projFill)}`} d={TM_ARC} pathLength={100} style={{ strokeDasharray: dash(projFill) }} />
              <path className={`tm-arc-fill${zero(fill)}`} d={TM_ARC} pathLength={100} stroke={`url(#f${gid})`} style={{ strokeDasharray: dash(fill) }} />
              {over && <path className="tm-arc-over" d={TM_ARC} pathLength={100} stroke={`url(#o${gid})`} style={{ strokeDasharray: dash(overFill) }} />}
              {goal > 0 && (
                <g className="tm-arc-tip" style={{ transform: `rotate(${on(over ? overFill : fill) * 180}deg)` }}>
                  <circle cx="16" cy="70" r="5" />
                </g>
              )}
            </svg>
            <span className="tm-dial-pct"><TmCount value={pctRaw} format={(n) => Math.round(n).toLocaleString()} /><em>%</em></span>
          </span>
          <span className="tm-kpi-main">
            <span className="tm-kpi-label"><span className="tm-kpi-ico"><TmIcon d={icon} /></span>{label}</span>
            <b className="tm-kpi-val"><TmCount value={done} format={fmt} /><em>{unit}</em></b>
            <small className="tm-kpi-goal">
              {goal > 0 ? `of ${fmt(goal)}${u} goal` : "No goal set"}
              {over && <span className="tm-over"><i />Over goal</span>}
            </small>
          </span>
        </span>

        <span className="tm-bar" aria-hidden={!breakdown}>
          <span className="tm-kpi-label"><span className="tm-kpi-ico"><TmIcon d={icon} /></span>{label}, planned and realized</span>
          <span className="tm-bar-track">
            <span className="tm-bar-done" style={{ width: `${breakdown ? doneW : 0}%` }} />
            <span className="tm-bar-plan" style={{ left: `${doneW}%`, width: `${breakdown ? planW : 0}%` }} />
            {goal > 0 && (
              <span className={`tm-bar-goal ${goalAt > 72 ? "is-end" : ""}`} style={{ left: `${goalAt}%` }}>
                <span>Goal {fmt(goal)}{u}</span>
              </span>
            )}
          </span>
          <span className="tm-bar-legend">
            <span><i className="is-done" />{fmt(done)}{u} realized</span>
            <span><i className="is-plan" />+{fmt(planned)}{u} planned</span>
            <b>{fmt(done + planned)}{u} in total</b>
          </span>
        </span>
      </span>

      <span className="tm-kpi-facts">
        <span><i className="is-done" />Realized<b>{fmt(done)}{u}</b></span>
        <span><i className="is-plan" />Planned<b>+{fmt(planned)}{u}</b></span>
        <span><i className="is-proj" />With planned<b>{goal > 0 ? `${Math.round(projPct)}%` : "–"}</b></span>
      </span>
    </button>
  );
}

/** A compact headline card on the Team band: label, one figure and a footer of facts. */
function TeamStat({ index, icon, label, value, unit, fmt, children }: {
  index: number; icon: string; label: string; value: number; unit?: string;
  fmt: (n: number) => string; children?: ReactNode;
}) {
  return (
    <div className="tm-kpi tm-stat" data-spot="tilt" style={tmVars({ "--i": index })}>
      <span className="tm-kpi-label"><span className="tm-kpi-ico"><TmIcon d={icon} /></span>{label}</span>
      <b className="tm-kpi-val"><TmCount value={value} format={fmt} />{unit && <em>{unit}</em>}</b>
      {children}
    </div>
  );
}

type TmTone = "none" | "red" | "green" | "purple";
const tmTone = (goalMin: number, goalHigh: number, done: number): TmTone =>
  goalMin <= 0 ? "none" : done < goalMin ? "red" : goalHigh > 0 && done >= goalHigh ? "purple" : "green";
const TM_STATUS: Record<TmTone, string> = {
  none: "No targets", red: "Below minimum", green: "Minimum met", purple: "High tier",
};

/** A metric filter chip in the Team header: opens a menu with a real/planned/both
 *  basis selector and a min–max range. */
function MetricChip({
  label, unit, active, isOpen, onToggle, basis, setBasis, min, setMin, max, setMax, onClear,
  sortDir, onSort,
}: {
  label: string; unit: string; active: boolean; isOpen: boolean; onToggle: () => void;
  basis: "done" | "planned" | "both"; setBasis: (b: "done" | "planned" | "both") => void;
  min: string; setMin: (v: string) => void; max: string; setMax: (v: string) => void; onClear: () => void;
  sortDir: "desc" | "asc" | null; onSort: (dir: "desc" | "asc" | null) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onToggle(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onToggle(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [isOpen, onToggle]);
  const basisLabel = basis === "done" ? "real" : basis === "planned" ? "planned" : "real + planned";
  const rangeSummary = active ? `${min || "0"}–${max || "∞"}${unit ? unit : ""} ` : "";
  const sortArrow = sortDir === "desc" ? "↓" : sortDir === "asc" ? "↑" : "";
  const summary = `${rangeSummary}${basisLabel}`;
  const chipActive = active || !!sortDir;
  return (
    <span className={`tm-chip ${isOpen ? "is-open" : ""} ${chipActive ? "is-active" : ""}`} ref={ref}>
      <button type="button" className="tm-chip-btn" onClick={onToggle} aria-expanded={isOpen}>
        <b>{label}</b>
        {sortArrow && <span className="tm-chip-arrow">{sortArrow}</span>}
        <span className="tm-chip-sum">{summary}</span>
        {chipActive && <i className="tm-chip-dot" aria-hidden="true" />}
        <svg className="tm-chip-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {isOpen && (
        <div className="tm-chip-menu">
          <label className="tm-chip-lbl">Sort</label>
          <div className="tm-chip-sort">
            <button className={sortDir === "desc" ? "is-on" : ""} onClick={() => onSort(sortDir === "desc" ? null : "desc")}>Highest first ↓</button>
            <button className={sortDir === "asc" ? "is-on" : ""} onClick={() => onSort(sortDir === "asc" ? null : "asc")}>Lowest first ↑</button>
          </div>
          <label className="tm-chip-lbl">Based on</label>
          <div className="tm-chip-seg">
            {(["done", "planned", "both"] as const).map((b) => (
              <button key={b} className={basis === b ? "is-on" : ""} onClick={() => setBasis(b)}>
                {b === "done" ? "Real" : b === "planned" ? "Planned" : "Both"}
              </button>
            ))}
          </div>
          <label className="tm-chip-lbl">Range ({unit || "€"})</label>
          <div className="tm-chip-range">
            <input type="number" min="0" value={min} onChange={(e) => setMin(e.target.value)} placeholder="Min" />
            <span>–</span>
            <input type="number" min="0" value={max} onChange={(e) => setMax(e.target.value)} placeholder="Max" />
          </div>
          {chipActive && <button className="tm-chip-clear" onClick={onClear}>Clear</button>}
        </div>
      )}
    </span>
  );
}

/** One target bar on a consultant card: fill, min and high ticks, and the share of the minimum. */
function TeamMetric({
  label, unit, done, planned, min, high, tone, pct, format,
}: {
  label: string; unit: string; done: number; planned: number; min: number; high: number;
  tone: TmTone; pct: number | null; format: (n: number) => string;
}) {
  // Scale covers realized + planned, so the planned stretch always fits on the bar.
  const scale = Math.max(high, min, done + planned, 1) * 1.04;
  const at = (n: number) => Math.min(97, Math.max(3, (n / scale) * 100));
  const fillPct = Math.min(100, (done / scale) * 100);
  const planPct = Math.min(100 - fillPct, (planned / scale) * 100);
  const withPlan = min > 0 ? ((done + planned) / min) * 100 : null;
  const mark = (n: number) => (unit === "d" ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : n.toLocaleString());
  const u = unit === "d" ? "d" : " €";
  return (
    <div className={`tm-metric tone-${tone}`}>
      <div className="tm-metric-h">
        <span className="tm-metric-l">{label}<b className="tm-metric-n"><TmCount value={done} format={format} /><em>{u}</em></b></span>
        <span className="tm-metric-agg">
          {planned > 0.005 && (
            <span className="tm-plan-v" title={withPlan !== null ? `${Math.round(withPlan)}% of minimum once the planned days are realized` : "Planned, not yet realized"}>
              +{format(planned)}{u} planned
            </span>
          )}
          <span className="tm-metric-tot" title="Delivered + planned">Total <b><TmCount value={done + planned} format={format} />{u}</b></span>
        </span>
      </div>
      <div className="tm-track">
        <span className="tm-fill" style={{ width: `${fillPct}%` }} />
        {planned > 0.005 && <span className="tm-plan" style={{ left: `${fillPct}%`, width: `${planPct}%` }} />}
        {min > 0 && <span className={`tm-tick ${done >= min ? "is-hit" : ""}`} style={{ left: `${at(min)}%` }} />}
        {high > 0 && <span className={`tm-tick is-high ${done >= high ? "is-hit" : ""}`} style={{ left: `${at(high)}%` }} />}
      </div>
      <div className="tm-metric-f">
        <span className="tm-pct">{pct === null ? "No target" : `${Math.round(pct)}% of minimum`}</span>
        {(min > 0 || high > 0) && (
          <span className="tm-marks">
            {min > 0 && <span>Min <b>{mark(min)}{u}</b></span>}
            {high > 0 && <span className="is-high">High <b>{mark(high)}{u}</b></span>}
          </span>
        )}
      </div>
    </div>
  );
}

/** A consultant row on the Team tab. The whole row opens the detail modal; the sliders button opens their targets. */
function TeamCard({
  index, name, projectCount, daysDone, amountDone, daysPlanned, amountPlanned, goals, onOpen,
}: {
  index: number; name: string; projectCount: number; daysDone: number; amountDone: number;
  daysPlanned: number; amountPlanned: number;
  goals: { days: number; daysHigh: number; money: number; moneyHigh: number; custom: boolean };
  onOpen: () => void;
}) {
  const dTone = tmTone(goals.days, goals.daysHigh, daysDone);
  const mTone = tmTone(goals.money, goals.moneyHigh, amountDone);
  const set = [dTone, mTone].filter((t) => t !== "none");
  const overall: TmTone = set.length === 0 ? "none"
    : set.includes("red") ? "red"
    : set.every((t) => t === "purple") ? "purple" : "green";
  const dayPct = goals.days > 0 ? (daysDone / goals.days) * 100 : null;
  const moneyPct = goals.money > 0 ? (amountDone / goals.money) * 100 : null;

  return (
    <article
      className={`tm-card tone-${overall}`}
      data-spot=""
      style={tmVars({ "--i": Math.min(index, 16), "--h": tmHue(name) })}
    >
      <button type="button" className="tm-card-hit" onClick={onOpen} aria-label={`Open details for ${name}`} />
      <span className="tm-card-who">
        <span className="tm-av">{tmInitials(name)}</span>
        <span className="tm-who">
          <b>{name}</b>
          <small>
            {projectCount} project{projectCount === 1 ? "" : "s"}
            <span className="tm-status is-inline"><i />{TM_STATUS[overall]}</span>
          </small>
        </span>
      </span>

      <TeamMetric label="Days delivered" unit="d" done={daysDone} planned={daysPlanned} min={goals.days} high={goals.daysHigh}
        tone={dTone} pct={dayPct} format={(n) => n.toFixed(2)} />
      <TeamMetric label="Value" unit="€" done={amountDone} planned={amountPlanned} min={goals.money} high={goals.moneyHigh}
        tone={mTone} pct={moneyPct} format={(n) => Math.round(n).toLocaleString()} />

      <span className="tm-status is-col"><i />{TM_STATUS[overall]}</span>
      <span className="tm-go" aria-hidden="true"><TmIcon d={TM_ICON.arrow} w={2.2} /></span>
    </article>
  );
}


/* The dark header floats as a rounded card (index.css: .fh). Every tab gives its
   headline cards the same fixed height (--mg-hero-h), so the card is sized from the
   title bar plus that height — known before any data loads, identical on every tab,
   measured before paint — and only shrinks while a panel scrolls its cards away. */
const MG_HERO = ".tm-hero, .bl-hero, .bn-hero, .bp-hero, .ic-hero";
const mgLiveHero = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>(MG_HERO)).find((el) => !el.closest(".mg-xfade")) ?? null;
function useFloatingHero(root: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!root) return;
    let raf = 0;
    let heroH = 0;
    const readH = () => {
      const v = parseFloat(getComputedStyle(root).getPropertyValue("--mg-hero-h"));
      heroH = Number.isFinite(v) ? v : 0;
    };
    const measure = () => {
      raf = 0;
      const bar = root.querySelector<HTMLElement>(":scope > .mg-bar");
      if (!bar) return;
      // Layout box, not the painted one: the bar rises in with a transform on load.
      const barB = bar.offsetParent === root ? bar.offsetTop + bar.offsetHeight
        : bar.getBoundingClientRect().bottom - root.getBoundingClientRect().top + root.scrollTop;
      const hero = mgLiveHero(root);
      const has = hero ? "1" : "0";
      if (root.dataset.hero !== has) root.dataset.hero = has;
      // Only a panel that scrolls as a whole (a direct child) carries its cards away.
      const sc = hero?.parentElement;
      const cut = sc && sc.parentElement === root ? Math.max(0, sc.scrollTop) : 0;
      root.style.setProperty("--mg-bar-b", `${Math.round(barB)}px`);
      root.style.setProperty("--fh-h", `${Math.max(0, Math.round(barB - 22 + Math.max(0, heroH + 10 - cut)))}px`);
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(measure); };
    const ro = new ResizeObserver(() => { readH(); queue(); });
    const bar = root.querySelector<HTMLElement>(":scope > .mg-bar");
    ro.observe(root); if (bar) ro.observe(bar);
    readH(); measure();
    // Tabs and loading states swap the panel: re-check which hero is live.
    const mo = new MutationObserver(queue);
    mo.observe(root, { childList: true, subtree: true });
    if (document.fonts?.ready) document.fonts.ready.then(() => { readH(); queue(); });
    // When a panel scrolls, its headline cards scroll up under the title bar.
    // Fade them out and feather their cut edge so no clipped fragments show,
    // and re-measure every frame so the dark card shrinks with them.
    const HERO = ":scope > .tm-hero, :scope > .bl-hero, :scope > .bn-hero, :scope > .bp-hero, :scope > .ic-hero";
    let sraf = 0; let scroller: HTMLElement | null = null;
    const paint = () => {
      sraf = 0;
      const t = scroller; if (!t) return;
      const hero = t.querySelector<HTMLElement>(HERO);
      if (!hero) return;
      const y = t.scrollTop, h = hero.offsetHeight || 1;
      if (y <= 0) {
        hero.style.opacity = ""; hero.style.maskImage = ""; hero.style.webkitMaskImage = ""; hero.style.pointerEvents = "";
      } else {
        const p = Math.min(1, y / (h * 0.55));
        const m = `linear-gradient(180deg, transparent ${y}px, #000 ${y + 56}px)`;
        hero.style.opacity = String(+(1 - p).toFixed(3));
        hero.style.maskImage = m; hero.style.webkitMaskImage = m;
        hero.style.pointerEvents = p > 0.6 ? "none" : "";
      }
      measure();
    };
    const onScroll = (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || t.parentElement !== root) return;
      scroller = t;
      if (!sraf) sraf = requestAnimationFrame(paint);
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      ro.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf); if (sraf) cancelAnimationFrame(sraf);
      root.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    };
  }, [root]);
}
/**
 * Switching tabs keeps the dark card where it is: the outgoing headline cards are
 * copied into a still layer that fades out while the incoming ones rise in, and the
 * card eases back to full height if the old panel had scrolled its cards away.
 */
function mgCrossfade(root: HTMLElement | null) {
  if (!root) return;
  root.querySelectorAll(".mg-xfade").forEach((n) => n.remove());
  const w = window as unknown as { __mgTabT?: number };
  window.clearTimeout(w.__mgTabT);
  root.dataset.tabbing = "1";
  w.__mgTabT = window.setTimeout(() => { delete root.dataset.tabbing; }, 650);
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const hero = mgLiveHero(root);
  if (!hero || !hero.parentElement) return;
  const rt = root.getBoundingClientRect();
  const hr = hero.getBoundingClientRect();
  if (hr.height < 4) return;
  const shell = hero.parentElement.cloneNode(false) as HTMLElement;
  shell.removeAttribute("style");
  shell.appendChild(hero.cloneNode(true));
  const ghost = document.createElement("div");
  ghost.className = "mg-xfade";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.top = `${Math.round(hr.top - rt.top + root.scrollTop)}px`;
  ghost.style.height = `${Math.round(hr.height)}px`;
  ghost.appendChild(shell);
  root.appendChild(ghost);
  window.setTimeout(() => ghost.remove(), 460);
}
function fhMove(e: { clientX: number; clientY: number; currentTarget: HTMLElement; pointerType?: string }) {
  if (e.pointerType && e.pointerType !== "mouse") return;
  const root = e.currentTarget;
  const r = root.getBoundingClientRect();
  const x = e.clientX - r.left - 14, y = e.clientY - r.top + root.scrollTop - 12;
  const h = parseFloat(root.style.getPropertyValue("--fh-h")) || 0;
  root.style.setProperty("--fh-x", `${Math.round(x)}px`);
  root.style.setProperty("--fh-y", `${Math.round(y)}px`);
  root.style.setProperty("--fh-on", x >= 0 && y >= 0 && y <= h && x <= r.width - 28 ? "1" : "0");
}
const fhLeave = (e: { currentTarget: HTMLElement }) => e.currentTarget.style.setProperty("--fh-on", "0");

export default function ManagementPage() {
  const fhRef = useRef<HTMLDivElement | null>(null);
  const [fhEl, setFhEl] = useState<HTMLDivElement | null>(null);
  const fhSet = useCallback((el: HTMLDivElement | null) => { fhRef.current = el; if (el) setFhEl(el); }, []);
  useFloatingHero(fhEl);
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState(() => new Date());
  const [scope, setScope] = useState<Scope>("month");
  const [cutoffs, setCutoffs] = useState<Cutoffs>({});
  /** True once the saved cutoffs were read — never delete cutoffs based on a list that failed to load. */
  const cutoffsLoaded = useRef(false);
  const [defaultCutoffDay, setDefaultCutoffDay] = useState(0);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  /** Backlog is a snapshot, not a period — just the one date it's measured as of. */
  /** Bonus is read as of a date too (no week/month/year selector). */
  const [bonusAsOf, setBonusAsOf] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  const [backlogAsOf, setBacklogAsOf] = useState(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [connOpen, setConnOpen] = useState(false);
  // Team consultant search: the header turns into a search field on click.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHi, setSearchHi] = useState(0); // highlighted suggestion index
  // Team metric filters (chips next to the search): range + real/planned/both.
  type MetricBasis = "done" | "planned" | "both";
  const [fDaysBasis, setFDaysBasis] = useState<MetricBasis>("done");
  const [fDaysMin, setFDaysMin] = useState("");
  const [fDaysMax, setFDaysMax] = useState("");
  const [fAmtBasis, setFAmtBasis] = useState<MetricBasis>("done");
  const [fAmtMin, setFAmtMin] = useState("");
  const [fAmtMax, setFAmtMax] = useState("");
  const [teamChip, setTeamChip] = useState<"days" | "amount" | null>(null);
  // Sort the list by a metric, high→low or low→high. null = default order.
  type TeamSort = { key: "days" | "amount"; dir: "desc" | "asc" } | null;
  const [teamSort, setTeamSort] = useState<TeamSort>(null);
  const [projOpen, setProjOpen] = useState<string | null>(null); // "userId|projectKey"
  // Which of the top KPI gauges (by key: "days" / "money") is showing the
  // planned+realized breakdown instead of its single headline figure.
  const [kpiBreakdown, setKpiBreakdown] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<"team" | "backlog" | "billing" | "bonus" | "incoming">("team");
  // Global search → Management › a tab (deep link "management/<tab>[/<billing phase>]").
  useNavSection("/management", 0, (part) => {
    if (["team", "backlog", "billing", "bonus", "incoming"].includes(part)) { setTab(part as typeof tab); if (part === "billing") setScope("month"); }
  });

  /* ---- access control (Security settings, stored in mgmt_access) ---- */
  const access = useMgmtAccess();
  const lv = (a: Parameters<typeof access.level>[0]): Level => access.level(a);
  const lvTeam = lv("team"), lvBacklog = lv("backlog"), lvBilling = lv("billing"), lvBonus = lv("bonus");
  const TAB_DEFS = [
    { key: "team", label: "Team" }, { key: "backlog", label: "Backlog" }, { key: "billing", label: "Billing" },
    { key: "bonus", label: "Bonus" }, { key: "incoming", label: "Incoming" },
  ] as const;
  const visibleTabs = TAB_DEFS.filter((t) => lv(t.key) !== "none");
  // Whether the page itself opens is decided in Settings → Organization → Page access;
  // here we only block it when no tab inside is visible to this user.
  const pageAllowed = visibleTabs.length > 0;
  useEffect(() => {
    if (!access.ready || !visibleTabs.length) return;
    if (!visibleTabs.some((t) => t.key === tab)) setTab(visibleTabs[0].key);
  }, [access.ready, visibleTabs.map((t) => t.key).join(","), tab]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Backlog, Billing and Bonus work off the whole history; Team does not. */
  const needsAll = tab === "backlog" || tab === "billing" || tab === "bonus";

  const [entries, setEntries] = useState<Entry[]>([]);
  const [clientTypeIds, setClientTypeIds] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<Record<string, Proj>>({});
  const [clientNames, setClientNames] = useState<Record<string, string>>({});
const [people, setPeople] = useState<Record<string, string>>({});
  const inactive = useInactiveIds(); // laid off in Settings → Organization
  // Current user + whether they can see everyone's saved days (boss / consultancy_manager).
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [seesAllSaved, setSeesAllSaved] = useState(false);
  const [showBank, setShowBank] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id ?? null;
      setMyUserId(uid);
      if (!uid) return;
      const { data: prof } = await supabase.from("profiles").select("role, is_superadmin").eq("id", uid).maybeSingle();
      const r = ((prof as any)?.role ?? "").toLowerCase();
      const boss = (prof as any)?.is_superadmin === true || r === "boss";
      setSeesAllSaved(boss || r === "consultancy_manager");
    })();
  }, []);
  /** Every role of the catalogue: its name, colour and whether it counts for the consultant's target. */
  const [roles, setRoles] = useState<ClientRole[]>([]);
const [typeNames, setTypeNames] = useState<Record<string, string>>({});
  /** service_id -> the role_id marked as that service's "main" role (Catalog > service > Roles and rates). */
  const [mainRoleByService, setMainRoleByService] = useState<Record<string, string>>({});
const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [userTargets, setUserTargets] = useState<Record<string, UserTarget>>({});
  const [capacity, setCapacity] = useState<Record<string, CapValue>>({});
  /**
   * The bonus everyone is on unless their own card says otherwise. Before this
   * every consultant had to be set up field by field.
   */
  const [genBonus, setGenBonus] = useState<CapValue>({
    minDays: 12, minBilling: 12000, bonusPct1: 5,
    highDays: 18, highBilling: 20000, bonusPct2: 8,
  });
  /** Projects billed by the hour, so days and hours never end up in one total. */
  const [hourProjects, setHourProjects] = useState<Set<string>>(new Set());
  /** What a billed day is worth in hours, from Targets and bonus. */
  const [hoursPerDay, setHoursPerDay] = useState(8);
  const [capMode, setCapMode] = useState<"worked" | "billable">("worked");
  /** Working hours per weekday, from the calendar settings, lunch taken out. */
  const [dayCapacity, setDayCapacity] = useState<Record<number, number>>({});
  /** A person's own weekly hours, when the Hours panel has one for them (scope "user"). */
  const [userDayCapacity, setUserDayCapacity] = useState<Record<string, Record<number, number>>>({});
  /** Company holidays and each person's vacation days: not available time. */
  const [holidaySet, setHolidaySet] = useState<Set<string>>(new Set());
  const [vacationsBy, setVacationsBy] = useState<Record<string, Set<string>>>({});
  useEffect(() => {
    const hoursOf = (r: any) => {
      if (r.closed) return 0;
      const lunch = r.lunch_from != null && r.lunch_to != null ? r.lunch_to - r.lunch_from : 0;
      return Math.max(0, (r.work_to - r.work_from - lunch)) / 60;
    };
    supabase.from("calendar_hours").select("weekday, work_from, work_to, lunch_from, lunch_to, closed, scope, scope_ref")
      .then(({ data }) => {
        const rows = (data ?? []) as any[];
        const out: Record<number, number> = {};
        rows.filter((r) => r.scope === "company").forEach((r) => { out[r.weekday] = hoursOf(r); });
        const perUser: Record<string, Record<number, number>> = {};
        rows.filter((r) => r.scope === "user" && r.scope_ref).forEach((r) => { (perUser[r.scope_ref] ??= {})[r.weekday] = hoursOf(r); });
        setDayCapacity(out);
        setUserDayCapacity(perUser);
      });
    supabase.from("holidays").select("holiday_date").range(0, 99999)
      .then(({ data, error }) => { if (!error) setHolidaySet(new Set(((data ?? []) as any[]).map((r) => String(r.holiday_date).slice(0, 10)))); });
    supabase.from("vacations").select("user_id, vacation_date").range(0, 99999)
      .then(({ data, error }) => {
        if (error) return;
        const by: Record<string, Set<string>> = {};
        ((data ?? []) as any[]).forEach((r) => { if (r.user_id && r.vacation_date) (by[r.user_id] ??= new Set()).add(String(r.vacation_date).slice(0, 10)); });
        setVacationsBy(by);
      });
  }, []);
  /**
   * Full working days per week, derived from the weekly hours rather than
   * typed in per person. Each open weekday contributes its own hours (lunch
   * already taken out) divided by the length of a billed day, so a company
   * open Monday to Thursday counts as four days and a short Friday counts as
   * the fraction it really is. Falls back to five until the hours load.
   */
  const weekDaysFromHours = useMemo(() => {
    const hrs = Object.values(dayCapacity);
    if (!hrs.length || hoursPerDay <= 0) return 5;
    const total = hrs.reduce((s, h) => s + h, 0) / hoursPerDay;
    return total > 0 ? total : 5;
  }, [dayCapacity, hoursPerDay]);
  useEffect(() => {
    (async () => {
      const { data: svc } = await supabase.from("services").select("id, rate_unit").eq("rate_unit", "hour");
      const ids = (svc ?? []).map((s: any) => s.id);
      if (ids.length) {
        const { data: pj } = await supabase.from("projects").select("id").in("service_id", ids);
        setHourProjects(new Set((pj ?? []).map((p: any) => p.id)));
      }
    })();
  }, []);
  const [capSavedId, setCapSavedId] = useState<string | null>(null);
  const [bonusLag, setBonusLag] = useState(2);
  const [targetFor, setTargetFor] = useState<string | null>(null);
  const [capFocusUser, setCapFocusUser] = useState<string | null>(null);
const [targets, setTargets] = useState<Targets>({
perDay: 1, minPerDay: 0.5, minPerWeek: 3, minPerMonth: 12, minRevenueWeek: 0, minRevenueMonth: 0,
  });
  const [workTypes, setWorkTypes] = useState<WorkTypeDef[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  // True only while a full-history load (Backlog/Billing/Bonus) is in flight.
  const [loadingAll, setLoadingAll] = useState(false);

  useEffect(() => {
    // Guard against overlapping runs: flipping tabs fast can start a new load
    // before the previous finishes. Only the latest run may apply its results
    // or clear the overlay; stale runs bail out. This is what stopped the old
    // "shows wrong data, sometimes no overlay" flicker.
    let cancelled = false;
    if (needsAll) setLoadingAll(true);
    (async () => {
      // Team only needs the period on screen and a couple of months either
      // side. Backlog, Billing and Bonus need the lot, so they ask for it when
      // you open them rather than making every visit wait for six thousand rows.
      const ce = await fetchEntries(needsAll ? null : windowFor(anchor, scope));
      if (cancelled) return;
      // Only fetch the actuals for the entries we actually loaded, instead of
      // pulling the whole table on every visit. Chunked to keep the "in" list
      // within Postgres/PostgREST limits.
      const entryIds = ((ce ?? []) as any[]).map((r) => r.id);
      const actual: Record<string, number> = {};
      for (let i = 0; i < entryIds.length; i += 500) {
        const slice = entryIds.slice(i, i + 500);
        if (!slice.length) break;
        const { data: ea } = await supabase.from("entry_actuals").select("entry_id, actual_billable").in("entry_id", slice);
        if (cancelled) return;
        ((ea ?? []) as any[]).forEach((r) => { actual[r.entry_id] = Number(r.actual_billable) || 0; });
      }
      // Build entries now, but DON'T setState yet — applying it before projects
      // are ready is what let a fast (cached) load paint new entries against
      // stale projects for a frame. Everything is set together below.
      const processedEntries: Entry[] = ((ce ?? []) as any[]).map((r) => {
        const dur = (Number(r.end_min) || 0) - (Number(r.start_min) || 0);
        const iso = r.entry_date ?? "";
        // Full workday length depends on the weekday: Fri 09:00–14:30 = 5.5h, else 8h.
        const dow = iso ? new Date(`${iso}T00:00:00`).getDay() : 1; // 0=Sun … 5=Fri
        const fullDay = dow === 5 ? 330 : 480; // minutes
        return {
          id: r.id,
          userId: r.user_id ?? "",
          projectId: r.project_id ?? "",
          date: iso,
          billable: actual[r.id] ?? (Number(r.billable) || 0),
          status: r.status ?? "planned",
          // the role the time was logged on (closing / sales keep their line);
          // legacy line keys are swapped for real roles once roles are loaded
          line: roleKeyOf(r),
          typeId: r.work_type_id ?? "",
          durationDays: dur > 0 ? +(dur / fullDay).toFixed(3) : 0,
          durationMin: dur > 0 ? dur : 0,
          billingPeriod: r.billing_period ?? null,
        };
      });

      // These are all independent lookups on tiny tables, so fire them together
      // instead of awaiting one after another (that stacking was the slow part).
      const [
        { data: wtypes },
        { data: pj },
        { data: ut },
        { data: pt },
        { data: rl },
        { data: cl },
        { data: tg },
        { data: wt },
        { data: us },
        { data: prof },
        { data: svcMain },
      ] = await Promise.all([
        supabase.from("work_types").select("id, client_related"),
        (async () => {
          // the hold dates come with 58_project_hold_dates.sql; without it the rest still loads
          const cols = "id, client_id, service_id, project_type_id, kickoff_date, price_per_day, supervision_price, discount_mode, discount_value, supervision_discount_mode, supervision_discount_value, role_lines, team, consultor_days, connector_days, supervision_days, status, end_date, legal_name, vat_number, address, contacts, taxed, tax_rate";
          const r = await supabase.from("projects").select(`${cols}, hold_periods`);
          return r.error && /hold_periods|column/i.test(r.error.message) ? await supabase.from("projects").select(cols) : r;
        })(),
        supabase.from("user_targets").select("*"),
        supabase.from("services").select("id, name"),
        supabase.from("client_roles").select("*"),
        supabase.from("clients").select("id, name"),
        supabase.from("calendar_targets").select("*").eq("id", "default").maybeSingle(),
        supabase.from("work_types").select("*").order("created_at"),
        supabase.functions.invoke("manage-users", { body: { action: "list" } }),
        supabase.from("profiles").select("id, role, job_title"),
        supabase.from("service_roles").select("service_id, role_id").eq("is_main", true),
      ]);
      if (cancelled) return;

      setClientTypeIds(new Set(((wtypes ?? []) as any[]).filter((t) => t.client_related).map((t) => t.id)));

      const roleList = sortRoles(((rl ?? []) as any[]).map(mapClientRole));
      const legacy = legacyRoleMap(roleList);
      processedEntries.forEach((e) => { e.line = resolveRoleKey(e.line, legacy); });

      // Entries + projects (and everything below) applied together in one batch,
      // so the panel never renders new entries against old projects.
      setEntries(processedEntries);
      setRoles(roleList);

      setProjects(Object.fromEntries(((pj ?? []) as any[]).map((r) => {
return [r.id, {
          id: r.id,
          clientId: r.client_id,
          typeId: r.service_id ?? r.project_type_id ?? "",
          kickoff: r.kickoff_date ?? "",
          lines: resolvedLinesOf({ roleLines: roleLinesOfRow(r) }, legacy),
          totalDiscount: totalDiscountOf({ discountMode: r.discount_mode, discountValue: Number(r.discount_value) || 0 }),
          status: r.status ?? "open",
          endDate: r.end_date ?? "",
          holds: parseHolds(r.hold_periods),
          legalName: r.legal_name ?? "",
          vat: r.vat_number ?? "",
          address: r.address ?? null,
          contacts: Array.isArray(r.contacts) ? r.contacts : [],
          taxed: !!r.taxed,
          taxRate: Number(r.tax_rate) || 0,
          team: r.team ?? [],
        } as Proj];
      })));

      setUserTargets(Object.fromEntries(((ut ?? []) as any[]).map((r) => [r.user_id, {
        minPerWeek: r.min_per_week === null ? null : Number(r.min_per_week),
        minPerMonth: r.min_per_month === null ? null : Number(r.min_per_month),
minRevenueWeek: r.min_revenue_week === null ? null : Number(r.min_revenue_week),
        minRevenueMonth: r.min_revenue_month === null ? null : Number(r.min_revenue_month),
      }])));
      setCapacity(Object.fromEntries(((ut ?? []) as any[]).map((r) => [r.user_id, {
        minDays: r.min_days_month ?? null,
        minBilling: r.min_billing_month ?? null,
        bonusPct1: r.bonus_pct_1 ?? null,
        highDays: r.high_days_month ?? null,
        highBilling: r.high_billing_month ?? null,
        bonusPct2: r.bonus_pct_2 ?? null,
      }])));

      setTypeNames(Object.fromEntries(((pt ?? []) as any[]).map((t) => [t.id, t.name ?? ""])));
      setMainRoleByService(Object.fromEntries(((svcMain ?? []) as any[]).map((r) => [r.service_id, r.role_id])));


      setClientNames(Object.fromEntries(((cl ?? []) as any[]).map((c) => [c.id, c.name])));

if (tg) setTargets({
        perDay: Number(tg.per_day) || 0,
        minPerDay: Number(tg.min_per_day) || 0,
        minPerWeek: Number(tg.min_per_week) || 0,
        minPerMonth: Number(tg.min_per_month) || 0,
minRevenueWeek: Number(tg.min_revenue_week) || 0,
        minRevenueMonth: Number(tg.min_revenue_month) || 0,
      });

      setWorkTypes(((wt ?? []) as any[]).map((r) => ({
        id: r.id, name: r.name ?? "", clientRelated: !!r.client_related, color: r.color ?? "#12b57f",
      })));

      const excluded = new Set(
        ((prof ?? []) as any[])
          .filter((p) => {
            const jt = (p.job_title ?? "").toLowerCase();
            const rl = (p.role ?? "").toLowerCase();
            return rl === "boss" || jt === "ceo" || jt === "cfo";
          })
          .map((p) => p.id)
      );
setExcluded(excluded);
      setPeople(Object.fromEntries(((us?.users ?? []) as any[])
        .map((u) => [
          u.id,
          [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—",
        ])));

      const { data: bp } = await supabase.from("billing_periods").select("period, cutoff_date");
      if (bp) { setCutoffs(Object.fromEntries((bp as any[]).map((r) => [r.period, r.cutoff_date]))); cutoffsLoaded.current = true; }
      const { data: bs } = await supabase.from("billing_settings").select("default_cutoff_day, bonus_lag_months, hours_per_day, min_days_month, min_billing_month, bonus_pct_1, high_days_month, high_billing_month, bonus_pct_2").eq("id", "default").maybeSingle();
      if (bs) {
        const b = bs as any;
        setDefaultCutoffDay(Number(b.default_cutoff_day) || 0);
        setBonusLag(Number(b.bonus_lag_months ?? 2));
        setHoursPerDay(Number(b.hours_per_day) || 8);
        setGenBonus({
          minDays: b.min_days_month ?? 12,
          minBilling: b.min_billing_month ?? 12000,
          bonusPct1: b.bonus_pct_1 ?? 5,
          highDays: b.high_days_month ?? 18,
          highBilling: b.high_billing_month ?? 20000,
          bonusPct2: b.bonus_pct_2 ?? 8,
        });
      }

      setLoading(false);
      setLoadingAll(false);
    })();
    // Any newer run supersedes this one: mark it cancelled so its late results
    // and its overlay-off never land after a newer load has started.
    return () => { cancelled = true; };
    // Reloads when the window it needs changes: a different period, or a tab
    // that wants the full history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAll, scope, anchor.getFullYear(), anchor.getMonth(), rangeFrom, rangeTo]);

const closeSettings = async () => {
    // Every write is checked. These used to be fire-and-forget, so a failing
    // upsert closed the dialog as if it had saved and the values silently
    // reverted on the next load.
    const fail = (what: string, error: { message: string } | null) => {
      if (!error) return false;
      alert(`Could not save ${what}: ${error.message}`);
      return true;
    };

    const { data: existing } = await supabase.from("work_types").select("id");
    const keep = new Set(workTypes.map((t) => t.id));
    const gone = ((existing ?? []) as any[]).filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (gone.length) {
      const { error } = await supabase.from("work_types").delete().in("id", gone);
      if (fail("work types", error)) return;
    }
    if (workTypes.length) {
      const { error } = await supabase.from("work_types").upsert(workTypes.map((t) => ({
        id: t.id, name: t.name, client_related: t.clientRelated, color: t.color,
      })));
      if (fail("work types", error)) return;
    }
    {
      const { error } = await supabase.from("calendar_targets").upsert({
        id: "default",
        per_day: targets.perDay,
        min_per_day: targets.minPerDay,
        min_per_week: targets.minPerWeek,
        min_per_month: targets.minPerMonth,
        min_revenue_week: targets.minRevenueWeek,
        min_revenue_month: targets.minRevenueMonth,
      });
      if (fail("the general targets", error)) return;
    }
    // Billing cutoffs (shared with the calendar) and the company-wide bonus.
    // tenant_id is left off deliberately: the column defaults to
    // current_tenant(), the same way calendar_hours works. The conflict
    // target has to name both key columns or a tenant would collide with
    // another tenant's 'default' row and be refused by RLS.
    {
      const { error } = await supabase.from("billing_settings").upsert({
        id: "default",
        default_cutoff_day: defaultCutoffDay,
        hours_per_day: hoursPerDay,
        min_days_month: genBonus.minDays,
        min_billing_month: genBonus.minBilling,
        bonus_pct_1: genBonus.bonusPct1,
        high_days_month: genBonus.highDays,
        high_billing_month: genBonus.highBilling,
        bonus_pct_2: genBonus.bonusPct2,
      }, { onConflict: "id,tenant_id" });
      if (fail("the targets for everyone", error)) return;
    }
    const cutoffRows = Object.entries(cutoffs).map(([period, cutoff_date]) => ({ period, cutoff_date }));
    // Months put back on the default day ("Use default") must be removed, not just left out of the upsert.
    const { data: savedCuts } = cutoffsLoaded.current ? await supabase.from("billing_periods").select("period") : { data: [] };
    const backToDefault = ((savedCuts ?? []) as { period: string }[]).map((r) => r.period).filter((p) => !(p in cutoffs));
    if (backToDefault.length) {
      const { error } = await supabase.from("billing_periods").delete().in("period", backToDefault);
      if (fail("the billing cutoffs", error)) return;
    }
    if (cutoffRows.length) {
      const { error } = await supabase.from("billing_periods").upsert(cutoffRows);
      if (fail("the billing cutoffs", error)) return;
    }
    setShowSettings(false);
  };

const saveUserTarget = async (uid: string, v: UserTarget) => {
    const { error } = await supabase.from("user_targets").upsert({
      user_id: uid,
      min_per_week: v.minPerWeek,
      min_per_month: v.minPerMonth,
min_revenue_week: v.minRevenueWeek,
      min_revenue_month: v.minRevenueMonth,
    }, { onConflict: "user_id" });
    if (error) { alert(`Could not save targets: ${error.message}`); return; }
    setUserTargets((s) => ({ ...s, [uid]: v }));
    setTargetFor(null);
  };

  const changeCapacity = (uid: string, patch: Partial<CapValue>) =>
    setCapacity((c) => ({
      ...c,
      [uid]: {
        minDays: null, minBilling: null, bonusPct1: null,
        highDays: null, highBilling: null, bonusPct2: null,
        ...c[uid], ...patch,
      },
    }));

  const saveCapacity = async (uid: string) => {
    const c = capacity[uid];
    if (!c) return;
    const { error } = await supabase.from("user_targets").upsert({
      user_id: uid,
      min_days_month: c.minDays,
      min_billing_month: c.minBilling,
      bonus_pct_1: c.bonusPct1,
      high_days_month: c.highDays,
      high_billing_month: c.highBilling,
      bonus_pct_2: c.bonusPct2,
    }, { onConflict: "user_id" });
    if (error) { alert(`Could not save: ${error.message}`); return; }
    setCapSavedId(uid);
    window.setTimeout(() => setCapSavedId((x) => (x === uid ? null : x)), 1600);
  };

  /** Goals for one person, falling back to the company defaults. */
  const goalsFor = (uid: string) => {
    // Monthly minimums/highs come from the two-tier targets (Management settings),
    // falling back to the company bonus so only the exceptions need setting up.
    const c = { ...genBonus, ...Object.fromEntries(
      Object.entries(capacity[uid] ?? {}).filter(([, v]) => v != null)) } as CapValue;
    const minM = c?.minDays ?? null;
    const highM = c?.highDays ?? null;
    const minRevM = c?.minBilling ?? null;
    const highRevM = c?.highBilling ?? null;
    // Subdivide monthly → scope. week ≈ month/4.333; year ≈ month×12.
    const WPM = 4.333;
    const scaleDays = (m: number | null) => {
      if (m == null) return 0;
      return scope === "week" ? +(m / WPM).toFixed(2)
        : scope === "month" ? m
        : scope === "year" ? m * 12
        : scope === "custom" ? +((m / WPM) * rangeWeeks).toFixed(2) : 0;
    };
    const scaleMoney = (m: number | null) => {
      if (m == null) return 0;
      return scope === "week" ? Math.round(m / WPM)
        : scope === "month" ? m
        : scope === "year" ? m * 12
        : scope === "custom" ? Math.round((m / WPM) * rangeWeeks) : 0;
    };
    return {
      days: scaleDays(minM),
      daysHigh: scaleDays(highM),
      money: scaleMoney(minRevM),
      moneyHigh: scaleMoney(highRevM),
      custom: !!c && (c.minDays != null || c.minBilling != null || c.highDays != null || c.highBilling != null),
    };
  };

  const weekStart = startOfWeek(anchor);
  // Step the period from inside the consultant popup; the outer page reads the
  // same `anchor`, so it stays in sync when the popup closes.
  const shiftPeriod = (delta: number) => setAnchor((a) => {
    const d = new Date(a);
    if (scope === "month") d.setMonth(d.getMonth() + delta);
    else if (scope === "week") d.setDate(d.getDate() + delta * 7);
    else if (scope === "year") d.setFullYear(d.getFullYear() + delta);
    return d;
  });
  const _nowP = new Date();
  const canNextPeriod =
    scope === "month" ? (anchor.getFullYear() < _nowP.getFullYear() || (anchor.getFullYear() === _nowP.getFullYear() && anchor.getMonth() < _nowP.getMonth()))
    : scope === "week" ? startOfWeek(anchor).getTime() < startOfWeek(_nowP).getTime()
    : scope === "year" ? anchor.getFullYear() < _nowP.getFullYear()
    : false;
  /** First and last calendar day of the period being viewed (null = open, for "all"). */
  const scopeWindow = (): [string | null, string | null] => {
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (scope === "week") return [iso(weekStart), iso(addDays(weekStart, 6))];
    if (scope === "month") {
      const w = billingWindow(periodOf(anchor), cutoffs, defaultCutoffDay);
      const [y, m, d] = w.from.split("-").map(Number);
      return [iso(new Date(y, m - 1, d + 1)), w.to]; // a billing month starts the day after the previous cutoff
    }
    if (scope === "year") return [`${anchor.getFullYear()}-01-01`, `${anchor.getFullYear()}-12-31`];
    if (scope === "custom") return [rangeFrom || null, rangeTo || null];
    return [null, null];
  };
  /**
   * Hours a person had available to work between two dates, from the Hours panel:
   * every real day counts its weekday's hours (lunch already out), skipping company
   * holidays and that person's vacation days. Uses their own schedule if they have one.
   * Counts up to today only, so a running period measures what they've had so far.
   */
  const availableHoursFor = (uid: string, from: string | null, to: string | null): number => {
    if (!from || !to) return 0;
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const end = to > todayIso ? todayIso : to;
    if (end < from) return 0;
    const sched = userDayCapacity[uid] ?? dayCapacity;
    const known = Object.keys(sched).length > 0;
    const vac = vacationsBy[uid];
    const [fy, fm, fd] = from.split("-").map(Number);
    let hours = 0;
    for (const d = new Date(fy, fm - 1, fd); ; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (key > end) break;
      if (holidaySet.has(key) || vac?.has(key)) continue;
      const wd = d.getDay();
      // Until the Hours panel loads (or if it's empty), assume Mon–Fri at a billed day's length.
      hours += known ? (sched[wd] ?? 0) : (wd >= 1 && wd <= 5 ? hoursPerDay : 0);
    }
    return hours;
  };
  const inScope = (iso: string) => {
    if (scope === "all") return true;
    if (!iso) return false;
    if (scope === "custom") {
      if (rangeFrom && iso < rangeFrom) return false;
      if (rangeTo && iso > rangeTo) return false;
      return true;
    }
    const d = new Date(`${iso}T00:00:00`);
    if (scope === "year") return d.getFullYear() === anchor.getFullYear();
    if (scope === "month")
      return inBillingMonth(iso, periodOf(anchor), cutoffs, defaultCutoffDay);
    const end = addDays(weekStart, 5);
    return d >= weekStart && d < end;
  };

  /**
   * Scope test for BILLING figures (revenue, bonus base): an entry moved to
   * another billing period must count in that period, not its work date.
   * Work-time metrics keep using inScope(e.date) instead.
   */
  const inBillingScope = (e: Entry) => {
    const override = e.billingPeriod;
    if (!override) return inScope(e.date);
    // Entry has been moved to a specific billing period ('YYYY-MM').
    if (scope === "all") return true;
    if (scope === "year") return override.slice(0, 4) === String(anchor.getFullYear());
    if (scope === "month") return override === periodOf(anchor);
    // week / custom: a moved entry bills on its target period's cutoff; fall back
    // to the natural date test since sub-month billing windows aren't period-keyed.
    return inScope(e.date);
  };

  /** Weeks-worth of target covered by the custom range, so goals stay comparable. */
  const rangeWeeks = scope === "custom" ? businessDays(rangeFrom, rangeTo) / 5 : 0;

  /**
   * The rate an entry bills at: the project's line for the role it was logged
   * on (its own discount applied). `kind` is that role, the key used to group.
   */
  const rateFor = (p: Proj, line: string, _userId: string): { rate: number; kind: string } =>
    ({ rate: rateOn(p.lines, line), kind: line });
  /** Project time on a role that doesn't count for the consultant's target (a connector, say). */
  const noCount = (line: string) => line !== "closure" && line !== "sales" && !roleCounts(line, roles);
  /** Names of the roles that don't count, for the card that lists their time. */
  const noCountName = (() => {
    const ns = roles.filter((r) => !r.countsForTarget).map((r) => r.name);
    return ns.length ? ns.join(" · ") : "Roles that don't count";
  })();

  const allRows = useMemo<Row[]>(() => {
    const acc: Record<string, Row> = {};
    const blank = (uid: string): Row => ({
      userId: uid, name: people[uid] ?? "—",
daysDone: 0, daysPlanned: 0, hoursDone: 0, hoursPlanned: 0, amountDone: 0, amountPlanned: 0,
      connDays: 0, connAmount: 0, byProject: {},
    });

    entries.forEach((e) => {
      if (e.status === "cancelled" || e.line === "closure") return;
     if (!e.projectId || !e.userId) return;
      if (!inBillingScope(e)) return; // revenue/bonus base: follow the invoiced period
      const p = projects[e.projectId];
      if (!p) return;

const { rate, kind } = rateFor(p, e.line, e.userId);
      const amount = e.billable * rate;
      if (!acc[e.userId]) acc[e.userId] = blank(e.userId);
      const row = acc[e.userId];
if (noCount(e.line)) return;
      const inHours = hourProjects.has(e.projectId);
      if (e.status === "confirmed") {
        if (inHours) row.hoursDone += e.billable; else row.daysDone += e.billable;
        row.amountDone += amount;
      } else {
        if (inHours) row.hoursPlanned += e.billable; else row.daysPlanned += e.billable;
        row.amountPlanned += amount;
      }

      const key = `${e.projectId}|${kind}`;
      if (!row.byProject[key])
        row.byProject[key] = { rateKind: kind, rate, daysDone: 0, daysPlanned: 0, amountDone: 0, amountPlanned: 0 };
      const cell = row.byProject[key];
      if (e.status === "confirmed") { cell.daysDone += e.billable; cell.amountDone += amount; }
      else { cell.daysPlanned += e.billable; cell.amountPlanned += amount; }
    });

   const inTeam = new Set(
      Object.values(projects).flatMap((p) => (p.team ?? []).map((m) => m.userId).filter(Boolean) as string[])
    );
    // Everyone on a project team gets a card even with no hours yet — except people
    // who've been laid off. (If they logged hours in the period, that's history: they show.)
    Object.keys(people).forEach((uid) => {
      if (!acc[uid] && !excluded.has(uid) && inTeam.has(uid) && !inactive.has(uid)) acc[uid] = blank(uid);
    });

    return Object.values(acc).sort((a, b) =>
      (b.amountDone + b.amountPlanned) - (a.amountDone + a.amountPlanned)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [entries, projects, people, roles, excluded, anchor, scope, rangeFrom, rangeTo, cutoffs, defaultCutoffDay, inactive]);
  // Team access "own": only the signed-in consultant's card, KPIs and figures.
  const rows = lvTeam === "own" ? allRows.filter((r) => r.userId === access.userId) : allRows;

  // Billing access "own": only bills for projects the user works on.
  const billingScope = useMemo(() => {
    if (lvBilling !== "own" || !access.userId) return { projects, entries };
    const me = access.userId;
    const mine = new Set<string>();
    Object.values(projects).forEach((p: any) => { if ((p.team ?? []).some((t: any) => t.userId === me)) mine.add(p.id); });
    entries.forEach((e) => { if (e.userId === me) mine.add(e.projectId); });
    return {
      projects: Object.fromEntries(Object.entries(projects).filter(([id]) => mine.has(id))) as typeof projects,
      entries: entries.filter((e) => mine.has(e.projectId)),
    };
  }, [lvBilling, access.userId, projects, entries]);

  // Team consultant search: live-filter the list, and a suggestions dropdown.
  const searchNorm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const filteredRows = useMemo(() => {
    const q = searchNorm(searchQuery.trim());
    const basisVal = (done: number, planned: number, basis: MetricBasis) =>
      basis === "done" ? done : basis === "planned" ? planned : done + planned;
    const out = rows.filter((r) => {
      if (q && !searchNorm(r.name).includes(q)) return false;
      // Days filter
      if (fDaysMin || fDaysMax) {
        const v = basisVal(r.daysDone, r.daysPlanned, fDaysBasis);
        if (fDaysMin && v < (Number(fDaysMin) || 0)) return false;
        if (fDaysMax && v > (Number(fDaysMax) || 0)) return false;
      }
      // Amount filter
      if (fAmtMin || fAmtMax) {
        const v = basisVal(r.amountDone, r.amountPlanned, fAmtBasis);
        if (fAmtMin && v < (Number(fAmtMin) || 0)) return false;
        if (fAmtMax && v > (Number(fAmtMax) || 0)) return false;
      }
      return true;
    });
    if (teamSort) {
      const val = (r: Row) => teamSort.key === "days"
        ? basisVal(r.daysDone, r.daysPlanned, fDaysBasis)
        : basisVal(r.amountDone, r.amountPlanned, fAmtBasis);
      out.sort((a, b) => (teamSort.dir === "desc" ? val(b) - val(a) : val(a) - val(b)));
    }
    return out;
  }, [rows, searchQuery, fDaysBasis, fDaysMin, fDaysMax, fAmtBasis, fAmtMin, fAmtMax, teamSort]);
  const daysFilterActive = !!(fDaysMin || fDaysMax);
  const amtFilterActive = !!(fAmtMin || fAmtMax);
  const searchSuggestions = useMemo(() => {
    const q = searchNorm(searchQuery.trim());
    if (!q) return [];
    // Once the query exactly matches a name (e.g. after picking one), the list
    // is already filtered to it — no need to keep the dropdown open.
    if (rows.some((r) => searchNorm(r.name) === q)) return [];
    // Names that start with the query rank above those that merely contain it.
    return rows
      .filter((r) => searchNorm(r.name).includes(q))
      .sort((a, b) => {
        const as = searchNorm(a.name).startsWith(q) ? 0 : 1;
        const bs = searchNorm(b.name).startsWith(q) ? 0 : 1;
        return as - bs || a.name.localeCompare(b.name);
      })
      .slice(0, 6);
  }, [rows, searchQuery]);

  // Goals scaled to the current scope
  const dayGoal =
    scope === "week" ? targets.minPerWeek
    : scope === "month" ? targets.minPerMonth
    : scope === "year" ? targets.minPerMonth * 12
    : scope === "custom" ? targets.minPerWeek * rangeWeeks
    : 0;
const moneyGoal =
    scope === "week" ? targets.minRevenueWeek
    : scope === "month" ? targets.minRevenueMonth
    : scope === "year" ? targets.minRevenueMonth * 12
    : scope === "custom" ? targets.minRevenueWeek * rangeWeeks
    : 0;

  const totalDone = rows.reduce((s, r) => s + r.amountDone, 0);
  const totalPlanned = rows.reduce((s, r) => s + r.amountPlanned, 0);
  const totalDays = rows.reduce((s, r) => s + r.daysDone, 0);
  // Time on roles that don't count for the target (a connector, say) is billed
  // at that role's rate but deliberately excluded from consultants' figures, so
  // it isn't visible anywhere else — surface it on its own, grouped by month.
  const monthLabel = (ym: string) => {
    const [y, mo] = ym.split("-").map(Number);
    return new Date(y, (mo || 1) - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  };
  const connectorByMonth = (() => {
    const m = new Map<string, { days: number; value: number; count: number }>();
    for (const e of entries) {
      if (!noCount(e.line) || e.status === "cancelled" || !inScope(e.date)) continue;
      if (lvTeam === "own" && e.userId !== access.userId) continue;
      const p = projects[e.projectId];
      const rate = p ? rateFor(p, e.line, e.userId).rate : 0;
      const key = e.date.slice(0, 7);
      const cur = m.get(key) ?? { days: 0, value: 0, count: 0 };
      cur.days += e.billable || 0;
      cur.value += (e.billable || 0) * rate;
      cur.count += 1;
      m.set(key, cur);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([month, v]) => ({ month, ...v }));
  })();
  const connectorDaysTotal = connectorByMonth.reduce((s, r) => s + r.days, 0);
  const connectorValueTotal = connectorByMonth.reduce((s, r) => s + r.value, 0);
  // Billable days consumed per project, split by role, from the loaded entries
  // (full in All-time view). Lets the project detail show consumed vs signed.
  const consumedByProject = (() => {
    const m = new Map<string, Record<string, number>>();
    for (const e of entries) {
      if (e.status === "cancelled" || e.line === "closure" || e.line === "sales") continue;
      const cur = m.get(e.projectId) ?? {};
      cur[e.line] = (cur[e.line] ?? 0) + (e.billable || 0);
      m.set(e.projectId, cur);
    }
    return m;
  })();
  const nameByUser: Record<string, string> = Object.fromEntries(rows.map((r) => [r.userId, r.name]));
  const connectorEntries = entries
    .filter((e) => noCount(e.line) && e.status !== "cancelled" && inScope(e.date) && (lvTeam !== "own" || e.userId === access.userId))
    .map((e) => {
      const p = projects[e.projectId];
      const rate = p ? rateFor(p, e.line, e.userId).rate : 0;
      return {
        date: e.date,
        user: nameByUser[e.userId] ?? people[e.userId] ?? "—",
        role: roleNameOf(e.line, roles),
        client: p ? (clientNames[p.clientId] ?? "Client") : "—",
        project: p ? (typeNames[p.typeId] ?? "Project") : "—",
        days: e.billable || 0,
        value: (e.billable || 0) * rate,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const connectorPeople = new Set(connectorEntries.map((e) => e.user)).size;
  const fmtDay = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return isNaN(+d) ? iso : d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  };
const totalDaysPlanned = rows.reduce((s, r) => s + r.daysPlanned, 0);
  const teamDayGoal = rows.reduce((s, r) => s + goalsFor(r.userId).days, 0);
const teamMoneyGoal = rows.reduce((s, r) => s + goalsFor(r.userId).money, 0);
  /** How many consultants sit below their minimum, meet it or reach the high tier. */
  const teamTones = rows.reduce((acc, r) => {
    const g = goalsFor(r.userId);
    const set = [tmTone(g.days, g.daysHigh, r.daysDone), tmTone(g.money, g.moneyHigh, r.amountDone)].filter((t) => t !== "none");
    const o: TmTone = set.length === 0 ? "none" : set.includes("red") ? "red" : set.every((t) => t === "purple") ? "purple" : "green";
    acc[o] += 1;
    return acc;
  }, { none: 0, red: 0, green: 0, purple: 0 } as Record<TmTone, number>);
  const teamTargeted = teamTones.red + teamTones.green + teamTones.purple;

  const dayPct = teamDayGoal > 0 ? (totalDays / teamDayGoal) * 100 : 0;
  const moneyPct = teamMoneyGoal > 0 ? (totalDone / teamMoneyGoal) * 100 : 0;
  const dayProjPct = teamDayGoal > 0 ? ((totalDays + totalDaysPlanned) / teamDayGoal) * 100 : 0;
  const moneyProjPct = teamMoneyGoal > 0 ? ((totalDone + totalPlanned) / teamMoneyGoal) * 100 : 0;
  const RING_R = 34;
  const RING_C = 2 * Math.PI * RING_R;
  const ring = (p: number) => ({
    strokeDasharray: `${(Math.min(100, p) / 100) * RING_C} ${RING_C}`,
  });

  /** Switch to custom, seeding the range with the month in view the first time. */
  const openCustom = () => {
    if (!rangeFrom && !rangeTo) {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      setRangeFrom(toISO(first));
      setRangeTo(toISO(last));
    }
    setScope("custom");
  };

  const step = (d: 1 | -1) =>
    setAnchor((a) =>
      scope === "year" ? new Date(a.getFullYear() + d, 0, 1)
      : scope === "week" ? addDays(a, d * 7)
      : new Date(a.getFullYear(), a.getMonth() + d, 1)
    );

  const label = (() => {
    if (scope === "all") return "All time";
    if (scope === "custom") return "Custom range";
    if (scope === "year") return `${anchor.getFullYear()}`;
    if (scope === "month") return `${MONTHS_FULL[anchor.getMonth()]} ${anchor.getFullYear()}`;
    const e = addDays(weekStart, 4);
    return `${MONTHS_SHORT[weekStart.getMonth()]} ${weekStart.getDate()} – ${MONTHS_SHORT[e.getMonth()]} ${e.getDate()}`;
  })();

  /**
   * Deep per-consultant analytics for the expanded row, computed over the
   * current scope. Splits work into billable (client + has a rate) vs
   * client-facing-unbilled vs internal; derives averages, blended rate,
   * utilisation and a per-period trend.
   */
  /**
   * Two-tier marginal bonus on an invoiced amount.
   * Gate: must meet the minimum days AND billing to earn anything.
   * Up to the high billing threshold pays pct1; the excess above it pays pct2.
   */
  const computeBonus = (amount: number, days: number, cap: CapValue | undefined) => {
    if (!cap) return { amount: 0, tier: 0 as 0 | 1 | 2, minMet: false, highMet: false };
    const { minDays, minBilling, bonusPct1, highDays, highBilling, bonusPct2 } = cap;
    // Minimum tier: BOTH the days and the billing minimums must be met.
    const hasMin = minDays != null || minBilling != null;
    const minMet = hasMin
      && (minDays == null || days >= minDays)
      && (minBilling == null || amount >= minBilling);
    if (!minMet) return { amount: 0, tier: 0 as 0 | 1 | 2, minMet: false, highMet: false };
    // High tier: again BOTH thresholds. When reached, the WHOLE invoiced
    // amount pays pct2 — the tiers are flat rates, not marginal brackets.
    const hasHigh = highBilling != null && bonusPct2 != null;
    const highMet = hasHigh
      && (highDays == null || days >= highDays)
      && (highBilling == null || amount >= highBilling);
    const p1 = (bonusPct1 ?? 0) / 100;
    const p2 = (bonusPct2 ?? 0) / 100;
    if (highMet) {
      return { amount: amount * p2, tier: 2 as const, minMet: true, highMet: true };
    }
    return { amount: amount * p1, tier: 1 as const, minMet: true, highMet: false };
  };

  const insightsFor = (uid: string) => {
    const mine = entries.filter((e) =>
      e.userId === uid && e.status !== "cancelled" && e.line !== "closure" && !noCount(e.line) && inScope(e.date)
    );

    let billableDays = 0, billableAmount = 0;
    let clientUnbilledDays = 0;   // client-facing but no rate/project → not invoiced
    let internalDays = 0;         // non-client work types
    const perDay: Record<string, { billable: number; total: number; amount: number }> = {};
    const rateSamples: number[] = [];

    mine.forEach((e) => {
      const p = e.projectId ? projects[e.projectId] : null;
      const isClientType = clientTypeIds.size === 0 ? !!p : clientTypeIds.has(e.typeId);
      const rate = p ? rateFor(p, e.line, uid).rate : 0;
      const billed = !!p && rate > 0 && isClientType && e.billable > 0;
      // For non-billed work, billable is 0, so measure real time worked instead.
      const worked = e.billable > 0 ? e.billable : e.durationDays;

      if (!perDay[e.date]) perDay[e.date] = { billable: 0, total: 0, amount: 0 };
      perDay[e.date].total += worked;

      if (billed) {
        billableDays += e.billable;
        billableAmount += e.billable * rate;
        perDay[e.date].billable += e.billable;
        perDay[e.date].amount += e.billable * rate;
        rateSamples.push(rate);
      } else if (isClientType) {
        clientUnbilledDays += worked;
      } else {
        internalDays += worked;
      }
    });

    const totalWorked = billableDays + clientUnbilledDays + internalDays;
    const blendedRate = billableDays > 0 ? billableAmount / billableDays : 0;
    const utilisation = totalWorked > 0 ? (billableDays / totalWorked) * 100 : 0;

    // INVOICED figures = bonus base. These follow the billing period (override),
    // not the work date, because bonuses are paid on what the client was invoiced.
    let invoicedAmount = 0, invoicedDays = 0;
    entries.forEach((e) => {
      if (e.userId !== uid || e.status === "cancelled" || e.line === "closure" || noCount(e.line)) return;
      if (!e.projectId) return;
      if (!inBillingScope(e)) return;
      const p = projects[e.projectId];
      if (!p) return;
      const isClientType = clientTypeIds.size === 0 ? !!p : clientTypeIds.has(e.typeId);
      const rate = rateFor(p, e.line, uid).rate;
      if (rate > 0 && isClientType && e.billable > 0) {
        invoicedAmount += e.billable * rate;
        invoicedDays += e.billable;
      }
    });

    // Scope length in business days & weeks, for averages
    let bizDays = 0;
    if (scope === "week") bizDays = 5;
    else if (scope === "month") bizDays = 22;
    else if (scope === "year") bizDays = 260;
    else if (scope === "custom") bizDays = businessDays(rangeFrom, rangeTo);
    else {
      // "all": span of logged dates
      const ds = mine.map((e) => e.date).filter(Boolean).sort();
      bizDays = ds.length ? businessDays(ds[0], ds[ds.length - 1]) : 0;
    }
    const weeks = bizDays > 0 ? bizDays / 5 : 0;
    const months = bizDays > 0 ? bizDays / 22 : 0;

    // Available capacity over the scope, from the consultant's configured full days/week.
    const cap = { ...genBonus, ...Object.fromEntries(
      Object.entries(capacity[uid] ?? {}).filter(([, v]) => v != null)) } as CapValue;
    // Full working days per week now comes from the weekly hours set in the
    // calendar settings: each open weekday contributes its hours (lunch already
    // removed) divided by the length of a billed day. A company open Mon-Thu
    // 9-18 with an hour for lunch therefore reads as 4 days, not a flat 5.
    const fullDaysWeek = weekDaysFromHours;
    const billTargetWeek = cap?.billableDays ?? null; // billable-days target
    // Available time from the Hours panel over the period actually viewed (real days,
    // minus holidays and vacations, up to today). For "all", the span they logged in.
    const [winFrom, winTo] = scope === "all"
      ? (() => { const ds = mine.map((e) => e.date).filter(Boolean).sort(); return [ds[0] ?? null, ds[ds.length - 1] ?? null] as [string | null, string | null]; })()
      : scopeWindow();
    const availableHours = availableHoursFor(uid, winFrom, winTo);
    const availableDays = hoursPerDay > 0 ? availableHours / hoursPerDay : 0;
    // Utilisation vs available time: how much of their capacity was billable.
    const capUtilisation = availableDays > 0 ? (billableDays / availableDays) * 100 : 0;
    // How much of capacity was worked at all (billable + unbilled + internal).
    const occupancy = availableDays > 0 ? (totalWorked / availableDays) * 100 : 0;
    const idleDays = Math.max(0, availableDays - totalWorked);

    const avgDaysWeek = weeks > 0 ? billableDays / weeks : 0;
    const avgAmountWeek = weeks > 0 ? billableAmount / weeks : 0;
    const avgDaysMonth = months > 0 ? billableDays / months : 0;
    const avgAmountMonth = months > 0 ? billableAmount / months : 0;
    const avgAmountDay = bizDays > 0 ? billableAmount / bizDays : 0;

    // Trend: bucket billable amount by period across the scope
    const trend: { label: string; amount: number; days: number }[] = [];
    const buckets: Record<string, { amount: number; days: number }> = {};
    const keyFor = (iso: string) => {
      const d = new Date(`${iso}T00:00:00`);
      if (scope === "week" || scope === "custom") return iso; // per day
      if (scope === "year" || scope === "all") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      // month → per ISO week number within the month
      const wk = Math.ceil(d.getDate() / 7);
      return `W${wk}`;
    };
    mine.forEach((e) => {
      const p = e.projectId ? projects[e.projectId] : null;
      const rate = p ? rateFor(p, e.line, uid).rate : 0;
      const isClientType = clientTypeIds.size === 0 ? !!p : clientTypeIds.has(e.typeId);
      if (!(p && rate > 0 && isClientType)) return;
      const k = keyFor(e.date);
      if (!buckets[k]) buckets[k] = { amount: 0, days: 0 };
      buckets[k].amount += e.billable * rate;
      buckets[k].days += e.billable;
    });
    Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, v]) =>
      trend.push({ label: k, amount: v.amount, days: v.days })
    );

    return {
      billableDays, billableAmount, clientUnbilledDays, internalDays, totalWorked,
      blendedRate, utilisation,
      invoicedAmount, invoicedDays,
      availableDays, availableHours, capUtilisation, occupancy, idleDays, fullDaysWeek, billTargetWeek,
      avgDaysWeek, avgAmountWeek, avgDaysMonth, avgAmountMonth, avgAmountDay,
      trend, activeDays: Object.keys(perDay).length,
    };
  };

  // Access gate: wait for the rules (never flash restricted data), then block
  // the whole page if nothing in Management is visible to this user.
  if (!access.ready) {
    return <div className="mg mg-dark"><LoadingOverlay /></div>;
  }
  if (!pageAllowed) {
    return (
      <div className="mg mg-dark">
        <div className="mg-noaccess">
          <span className="mg-noaccess-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" /></svg>
          </span>
          <h2>No access to Management</h2>
          <p>Your access hasn&apos;t been enabled. Ask an administrator to grant it in Management → Security.</p>
          <button className="mg-btn" onClick={() => navigate("/home")}>Back to home</button>
        </div>
      </div>
    );
  }

  return (
    <div ref={fhSet} onPointerMove={fhMove} onPointerLeave={fhLeave}
      className={`mg mg-tab-${tab} ${tab === "team" || tab === "backlog" || tab === "billing" || tab === "bonus" || tab === "incoming" ? "mg-dark fh" : ""}`}>
      <LoadingOverlay show={loading} />
      <header className="mg-bar">
        <div className="mg-bar-left">
          <button className="mg-home" onClick={() => navigate("/home")} aria-label="Back to home">‹</button>
          <h1 className="mg-title">Management</h1>
          <div className="mg-tabseg" data-tab={tab}>
            <span className="mg-tabseg-slider" style={{ transform: `translateX(${Math.max(0, visibleTabs.findIndex((t) => t.key === tab)) * 84}px)` }} />
            {visibleTabs.map((t) => (
              <button key={t.key} className={tab === t.key ? "is-on" : ""}
                onClick={() => { if (t.key === tab) return; mgCrossfade(fhRef.current); setTab(t.key); if (t.key === "billing") setScope("month"); }}>
                {t.label}
              </button>
            ))}
          </div>
          {lv(tab) === "own" && <span className="mg-own-chip" title="Your access to this tab is limited to your own data">Only your data</span>}
        </div>

        <div className="mg-nav">
          {tab !== "billing" && tab !== "backlog" && tab !== "bonus" && (
          <div className="mg-seg" data-scope={scope}>
            <span className="mg-seg-slider" />
            {(
              <>
                <button className={scope === "week" ? "is-on" : ""} onClick={() => setScope("week")}>Week</button>
                <button className={scope === "month" ? "is-on" : ""} onClick={() => setScope("month")}>Month</button>
                <button className={scope === "year" ? "is-on" : ""} onClick={() => setScope("year")}>Year</button>
                <button className={scope === "all" ? "is-on" : ""} onClick={() => setScope("all")}>All</button>
                <button className={scope === "custom" ? "is-on" : ""} onClick={openCustom}>Custom</button>
              </>
            )}
          </div>
          )}

          {tab === "backlog" && (
            <div className="mg-asof">
              <span className="mg-asof-label">Backlog as of</span>
              <DatePicker value={backlogAsOf} onChange={setBacklogAsOf} placeholder="Today" />
            </div>
          )}

          {tab === "bonus" && (
            <div className="mg-asof">
              <span className="mg-asof-label">Bonus as of</span>
              <DatePicker value={bonusAsOf} onChange={(d) => d && setBonusAsOf(d)} placeholder="Today" />
            </div>
          )}

          {tab !== "backlog" && tab !== "bonus" && (scope === "custom" ? (
            <div className="mg-range">
              <span className="mg-range-field">
                <DatePicker value={rangeFrom} onChange={setRangeFrom} placeholder="From" />
              </span>
              <span className="mg-range-arrow">→</span>
              <span className="mg-range-field">
                <DatePicker value={rangeTo} onChange={setRangeTo} placeholder="To" />
              </span>
              {rangeFrom && rangeTo && (
                <span className="mg-range-count">
                  {businessDays(rangeFrom, rangeTo)} working days
                </span>
              )}
            </div>
          ) : (
            <>
              {scope !== "all" && <button className="mg-btn" onClick={() => step(-1)} aria-label="Previous">‹</button>}
              <span className="mg-period">{label}</span>
              {scope !== "all" && <button className="mg-btn" onClick={() => step(1)} aria-label="Next">›</button>}
            </>
          ))}

          {tab === "billing" && lv("saved_days") !== "none" && (
            <button className="mg-btn mg-bank" onClick={() => setShowBank(true)} title="Saved days bank">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v5" /></svg>
              Saved days
            </button>
          )}

          {(lv("settings") === "all" || lv("security") === "all") && (
            <button className="mg-btn mg-gear" onClick={() => { setCapFocusUser(null); setShowSettings(true); }} aria-label="Settings" title="Settings">⚙</button>
          )}
        </div>
      </header>

      {/* Same-size placeholders while a tab has no headline cards yet (loading). */}
      <div className="mg-hero-skel" aria-hidden="true">
        {Array.from({ length: tab === "billing" ? 5 : tab === "incoming" ? 3 : 4 }, (_, i) => (
          <span key={i} style={tmVars({ "--i": i })}><i /><b /><em /></span>
        ))}
      </div>

      {targetFor && (
        <UserTargetModal
          name={people[targetFor] ?? "—"}
          general={{
            minPerWeek: targets.minPerWeek,
minPerMonth: targets.minPerMonth,
            minRevenueWeek: targets.minRevenueWeek,
            minRevenueMonth: targets.minRevenueMonth,
          }}
         value={userTargets[targetFor] ?? { minPerWeek: null, minPerMonth: null, minRevenueWeek: null, minRevenueMonth: null }}
          onSave={(v) => saveUserTarget(targetFor, v)}
          onClose={() => setTargetFor(null)}
        />
      )}

      {showBank && (
        <SavedDaysModal
          seesAll={lv("saved_days") === "all"}
          myUserId={myUserId}
          people={people}
          clientNames={clientNames}
          roles={roles}
          projectNames={Object.fromEntries(Object.values(projects).map((p) => [
            p.id,
            `${clientNames[p.clientId] ?? "Client"} · ${typeNames[p.typeId] ?? "Service"}`,
          ]))}
          onClose={() => setShowBank(false)}
        />
      )}

      {showSettings && (
        <CalendarSettingsModal
          types={workTypes}
          setTypes={setWorkTypes}
          targets={targets}
          setTargets={setTargets}
          cutoffs={cutoffs}
          setCutoffs={setCutoffs}
          defaultCutoffDay={defaultCutoffDay}
          setDefaultCutoffDay={setDefaultCutoffDay}
          genBonus={genBonus}
          setGenBonus={setGenBonus}
          hoursPerDay={hoursPerDay}
          setHoursPerDay={setHoursPerDay}
          managementMode
          securityPanel={lv("security") === "all"
            ? <MgmtSecurityModal embedded people={people} onClose={() => {}} onSaved={() => access.reload()} />
            : undefined}
          securityOnly={lv("settings") !== "all"}
          consultants={allRows.filter((r) => !inactive.has(r.userId)).map((r) => ({ userId: r.userId, name: r.name }))}
          capacity={capacity}
          onCapacityChange={changeCapacity}
          onCapacitySave={saveCapacity}
          capSavedId={capSavedId}
          initialCapOpen={capFocusUser}
          onClose={() => { setCapFocusUser(null); closeSettings(); }}
        />
      )}

{tab === "team" ? (
      <div className="tm" onPointerMove={tmSpotlight}>
        {/* Two headline cards on the dark band, same as before: realized
            against goal in an arc, planned vs realized on click. */}
        <section className="tm-hero">
          <div className="tm-kpis">
            {([
              {
                key: "days", label: "Days delivered", unit: "d", icon: TM_ICON.days,
                done: totalDays, planned: totalDaysPlanned, goal: teamDayGoal, projPct: dayProjPct,
                fmt: (n: number) => (+n.toFixed(n < 100 ? 2 : 0)).toLocaleString(),
              },
              {
                key: "money", label: "Value", unit: "\u20ac", icon: TM_ICON.money,
                done: totalDone, planned: totalPlanned, goal: teamMoneyGoal, projPct: moneyProjPct,
                fmt: (n: number) => Math.round(n).toLocaleString(),
              },
            ]).map((c, ci) => (
              <TeamKpi
                key={c.key}
                index={ci}
                label={c.label}
                unit={c.unit}
                icon={c.icon}
                done={c.done}
                planned={c.planned}
                goal={c.goal}
                projPct={c.projPct}
                fmt={c.fmt}
                breakdown={!!kpiBreakdown[c.key]}
                onToggle={() => setKpiBreakdown((prev) => ({ ...prev, [c.key]: !prev[c.key] }))}
              />
            ))}
            <TeamStat index={2} icon={TM_ICON.team} label="On target" value={teamTones.green + teamTones.purple}
              unit={`/ ${teamTargeted || rows.length}`} fmt={(n) => Math.round(n).toLocaleString()}>
              <span className="tm-stat-bar" aria-hidden="true">
                {(["red", "green", "purple"] as const).map((t) => (
                  <i key={t} className={`tone-${t}`} style={{ flexGrow: teamTones[t] }} />
                ))}
              </span>
              <span className="tm-stat-facts">
                <span className="tone-red"><i />{teamTones.red} below</span>
                <span className="tone-green"><i />{teamTones.green} met</span>
                <span className="tone-purple"><i />{teamTones.purple} high</span>
              </span>
            </TeamStat>
            <TeamStat index={3} icon={TM_ICON.rate} label="Avg day rate" value={totalDays > 0 ? totalDone / totalDays : 0}
              unit="€/day" fmt={(n) => Math.round(n).toLocaleString()}>
              <span className="tm-stat-facts is-plain">
                <span><b>{rows.length ? (+(totalDays / rows.length).toFixed(1)).toLocaleString() : 0}d</b>per consultant</span>
                <span><b>{rows.length ? Math.round(totalDone / rows.length).toLocaleString() : 0} €</b>each</span>
              </span>
            </TeamStat>
          </div>
        </section>

        <section className="tm-sheet">
          <header className="tm-sheet-h">
            {searchOpen ? (
              <div className="tm-search is-open">
                <svg className="tm-search-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
                <input
                  className="tm-search-input"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setSearchHi(0); }}
                  placeholder="Search consultants…"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { setSearchOpen(false); setSearchQuery(""); }
                    else if (e.key === "ArrowDown") { e.preventDefault(); setSearchHi((h) => Math.min(h + 1, searchSuggestions.length - 1)); }
                    else if (e.key === "ArrowUp") { e.preventDefault(); setSearchHi((h) => Math.max(h - 1, 0)); }
                    else if (e.key === "Enter" && searchSuggestions[searchHi]) {
                      e.preventDefault();
                      const s = searchSuggestions[searchHi];
                      setSearchQuery(s.name); setSearchHi(0);
                    }
                  }}
                />
                {searchQuery && (
                  <button className="tm-search-clear" onClick={() => { setSearchQuery(""); setSearchHi(0); }} aria-label="Clear search">×</button>
                )}
                <button className="tm-search-close" onClick={() => { setSearchOpen(false); setSearchQuery(""); }} aria-label="Close search">Done</button>
                {searchSuggestions.length > 0 && (
                  <div className="tm-search-drop">
                    {searchSuggestions.map((s, i) => (
                      <button
                        key={s.userId}
                        className={`tm-search-opt ${i === searchHi ? "is-hi" : ""}`}
                        onMouseEnter={() => setSearchHi(i)}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSearchQuery(s.name);
                          setSearchHi(0);
                        }}
                      >
                        <span className="tm-search-av">{s.name.charAt(0).toUpperCase()}</span>
                        <span>{s.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button className="tm-sheet-title" onClick={() => setSearchOpen(true)} title="Search consultants">
                <h2>Consultants <span className="tm-count">{filteredRows.length}</span></h2>
                <svg className="tm-title-search" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              </button>
            )}
            <span className="tm-chips">
              <MetricChip
                label="Days" unit="d"
                active={daysFilterActive} isOpen={teamChip === "days"} onToggle={() => setTeamChip(teamChip === "days" ? null : "days")}
                basis={fDaysBasis} setBasis={setFDaysBasis}
                min={fDaysMin} setMin={setFDaysMin} max={fDaysMax} setMax={setFDaysMax}
                onClear={() => { setFDaysMin(""); setFDaysMax(""); if (teamSort?.key === "days") setTeamSort(null); }}
                sortDir={teamSort?.key === "days" ? teamSort.dir : null}
                onSort={(dir) => setTeamSort(dir ? { key: "days", dir } : null)}
              />
              <MetricChip
                label="Amount" unit=""
                active={amtFilterActive} isOpen={teamChip === "amount"} onToggle={() => setTeamChip(teamChip === "amount" ? null : "amount")}
                basis={fAmtBasis} setBasis={setFAmtBasis}
                min={fAmtMin} setMin={setFAmtMin} max={fAmtMax} setMax={setFAmtMax}
                onClear={() => { setFAmtMin(""); setFAmtMax(""); if (teamSort?.key === "amount") setTeamSort(null); }}
                sortDir={teamSort?.key === "amount" ? teamSort.dir : null}
                onSort={(dir) => setTeamSort(dir ? { key: "amount", dir } : null)}
              />
            </span>
            <span className="tm-legend" aria-label="Status colours">
              <span className="tone-red"><i />Below minimum</span>
              <span className="tone-green"><i />Minimum met</span>
              <span className="tone-purple"><i />High tier</span>
            </span>
          </header>

          {loading ? (
            <PageLoader fill={false} size={80} label="Loading the team" />
          ) : rows.length === 0 ? (
            <p className="tm-empty">No consultants found for this period. Anyone on a project team, or with time logged, shows up here.</p>
          ) : filteredRows.length === 0 ? (
            <p className="tm-empty">No consultant matches “{searchQuery}”.</p>
          ) : (
            <div className="tm-list">
              {connectorEntries.length > 0 && (
                <button className="cn-card" onClick={() => setConnOpen(true)}>
                  <span className="cn-card-ic" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 12h8" /><circle cx="5" cy="12" r="2.4" /><circle cx="19" cy="12" r="2.4" /><path d="M12 8V5M12 19v-3" /></svg>
                  </span>
                  <div className="cn-card-txt">
                    <span className="cn-card-name">{noCountName}</span>
                    <span className="cn-card-sub">{connectorPeople} {connectorPeople === 1 ? "person" : "people"} · {connectorEntries.length} {connectorEntries.length === 1 ? "entry" : "entries"} · tap for detail</span>
                  </div>
                  <div className="cn-card-fig">
                    <b>{(+connectorDaysTotal.toFixed(2)).toLocaleString()} d</b>
                    <span>{Math.round(connectorValueTotal).toLocaleString()} €</span>
                  </div>
                  <svg className="cn-card-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                </button>
              )}
              {filteredRows.map((r, ri) => {
                const open = expanded === r.userId;
                const g = goalsFor(r.userId);
                const projectCount = new Set(Object.keys(r.byProject).map((k) => k.split("|")[0])).size;
                return (
                  <Fragment key={r.userId}>
                    <TeamCard
                      index={ri}
                      name={r.name}
                      projectCount={projectCount}
                      daysDone={r.daysDone}
                      amountDone={r.amountDone}
                      daysPlanned={r.daysPlanned}
                      amountPlanned={r.amountPlanned}
                      goals={{
                        ...g,
                        // Only their own saved values count as custom; goalsFor merges in the company defaults first.
                        custom: Object.values(capacity[r.userId] ?? {}).some((v) => v != null),
                      }}
                      onOpen={() => setExpanded(open ? null : r.userId)}
                    />
                {open && (() => {
                      const ins = insightsFor(r.userId);
                      const utilSlices = [
                        { key: "bill", label: "Billable", days: ins.billableDays, color: "var(--forest)" },
                        { key: "unbilled", label: "Client · unbilled", days: ins.clientUnbilledDays, color: "#e0a03e" },
                        { key: "internal", label: "Internal", days: ins.internalDays, color: "#8aa0b5" },
                        { key: "idle", label: "Idle / available", days: ins.idleDays, color: "rgba(10,111,77,0.1)" },
                      ].filter((s) => s.days > 0.01);
                      // Bar is measured against available capacity when we know it, else against worked time.
                      const barBase = ins.availableDays > 0 ? ins.availableDays : (ins.totalWorked || 1);
                      // Their own bonus where they have one, the company's otherwise.
                      const cap = { ...genBonus, ...Object.fromEntries(
                        Object.entries(capacity[r.userId] ?? {}).filter(([, v]) => v != null)) } as CapValue;

                      /**
                       * Capacity against the hours the company actually works.
                       * "worked" is every hour with something on it, billable or
                       * not; "billable" is the share of those that reach a
                       * client, with days converted at the configured rate.
                       */
                      const cw = (() => {
                        const mine = entries.filter(
                          (e) => e.userId === r.userId && e.status !== "cancelled" && inScope(e.date));
                        const worked = mine.reduce((s, e) => s + e.durationMin / 60, 0);

                        // Available hours: the whole period on the Hours panel (holidays and
                        // vacations out, up to today) — not only the days they logged.
                        const available = ins.availableHours;

                        const billable = r.daysDone * hoursPerDay + r.hoursDone;
                        return {
                          available, worked, billable,
                          workedPct: available > 0 ? (worked / available) * 100 : 0,
                          billablePct: available > 0 ? (billable / available) * 100 : 0,
                        };
                      })();

                      const bonusInvoiced = computeBonus(ins.invoicedAmount, ins.invoicedDays, cap);
                      const showBonus = !!cap && (cap.minDays != null || cap.minBilling != null || cap.bonusPct1 != null);
                      // Same period the header shows, so the pop-up never reads "This month"
                      // while you're looking at another one.
                      const fmtIso = (iso: string) => {
                        const d = new Date(`${iso}T00:00:00`);
                        return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
                      };
                      const scopeLabel = scope === "custom"
                        ? (rangeFrom && rangeTo ? `${fmtIso(rangeFrom)} – ${fmtIso(rangeTo)}` : "Custom range")
                        : label;

                      const projectRows = Object.entries(r.byProject).map(([key, v]) => {
                        const pid = key.split("|")[0];
                        const hourly = hourProjects.has(pid);
                        return {
                          key,
                          client: clientNames[projects[pid]?.clientId ?? ""] ?? "\u2014",
                          service: typeNames[projects[pid]?.typeId ?? ""] || "No service",
                          rateKind: roleNameOf(v.rateKind, roles),
                          rate: v.rate,
                          hourly,
                          amountPlanned: v.amountPlanned,
                          daysPlanned: v.daysPlanned,
                          amountDone: v.amountDone,
                          daysDone: v.daysDone,
                          kickoff: projects[pid]?.kickoff ?? null,
                          signedDays: (projects[pid]?.lines ?? []).reduce((n, l) => n + l.days, 0),
                          split: (() => {
                            const used = consumedByProject.get(pid) ?? {};
                            const keys = [...(projects[pid]?.lines ?? []).map((l) => l.roleId), ...Object.keys(used)]
                              .filter((k, i, a) => a.indexOf(k) === i);
                            return keys.map((k, i) => {
                              const at = roles.findIndex((x) => x.id === k);
                              return {
                                key: k, name: roleNameOf(k, roles), color: roleColor(roles[at], at < 0 ? i : at),
                                signed: (projects[pid]?.lines ?? []).filter((l) => l.roleId === k).reduce((n, l) => n + l.days, 0),
                                used: used[k] ?? 0,
                              };
                            });
                          })(),
                        };
                      });

                      const renderLedger = (key: string) => {
                        const projId = key.split("|")[0];
                        const kind = key.split("|")[1];
                        const v = r.byProject[key];
                        const u = hourProjects.has(projId) ? "h" : "d";
                        const feed = entries
                          .filter((e) =>
                            e.userId === r.userId && e.projectId === projId &&
                            e.status !== "cancelled" && e.line !== "closure" &&
                            inScope(e.date) && e.line === kind)
                          .sort((a, b) => a.date.localeCompare(b.date));
                        return (
                          <>
                            <div className="cm-dl-head">
                              <span>Date</span><span>Status</span>
                              <span className="cm-r">{u === "h" ? "Hours" : "Days"}</span><span className="cm-r">Value</span>
                            </div>
                            {feed.length === 0 ? (
                              <p className="cm-empty" style={{ padding: "6px 4px" }}>No entries.</p>
                            ) : feed.map((e) => (
                              <div className="cm-dl-row" key={e.id}>
                                <span className="cm-dl-date" title={e.date}>
                                  {(() => { const d = new Date(e.date + "T00:00:00"); return isNaN(+d) ? e.date : d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }); })()}
                                  {e.billingPeriod && <span className="cm-dl-moved">→ {e.billingPeriod}</span>}
                                </span>
                                <span className={`cm-dl-status is-${e.status}`}>{e.status}</span>
                                <span className="cm-r">{e.billable.toFixed(2)}</span>
                                <span className="cm-r">{Math.round(e.billable * v.rate).toLocaleString()} €</span>
                              </div>
                            ))}
                          </>
                        );
                      };

                      return (
                        <ConsultantModal
                          name={r.name}
                          scopeLabel={scopeLabel}
                          scope={scope}
                          hoursPerDay={hoursPerDay}
                          ins={ins}
                          cap={showBonus ? cap : null}
                          showBonus={showBonus}
                          bonusInvoiced={bonusInvoiced}
                          cw={cw.available > 0 ? cw : null}
                          capMode={capMode}
                          onToggleCap={() => setCapMode((m) => (m === "worked" ? "billable" : "worked"))}
                          projectRows={projectRows}
                          projOpenKey={projOpen && projOpen.startsWith(r.userId + "|") ? projOpen.slice(r.userId.length + 1) : null}
                          onToggleProject={(key) => {
                            const full = `${r.userId}|${key}`;
                            setProjOpen(projOpen === full ? null : full);
                          }}
                          renderLedger={renderLedger}
                          onShiftPeriod={shiftPeriod}
                          canPrevPeriod={true}
                          canNextPeriod={canNextPeriod}
                          onClose={() => setExpanded(null)}
                        />
                      );
                    })()}
                  </Fragment>
                );
              })}
            </div>
          )}
        </section>

        {connOpen && (
          <div className="cn-backdrop" onMouseDown={() => setConnOpen(false)}>
            <div className="cn-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
              <header className="cn-head">
                <div>
                  <span className="cn-eyebrow">{noCountName}</span>
                  <h3 className="cn-title">Who did what · which project · when</h3>
                </div>
                <div className="cn-tot">
                  <b>{(+connectorDaysTotal.toFixed(2)).toLocaleString()} d</b>
                  <span>{Math.round(connectorValueTotal).toLocaleString()} €</span>
                </div>
                <button className="cn-x" onClick={() => setConnOpen(false)} aria-label="Close">×</button>
              </header>
              <div className="cn-tbl">
                <div className="cn-tr cn-tr-h">
                  <span>Date</span><span>Consultant</span><span>Client · Project</span><span className="cn-r">Days</span><span className="cn-r">Value</span>
                </div>
                <div className="cn-scroll">
                  {connectorEntries.map((e, i) => (
                    <div className="cn-tr" key={i}>
                      <span className="cn-date">{fmtDay(e.date)}</span>
                      <span className="cn-user">{e.user}</span>
                      <span className="cn-proj"><ClientLogo className="mg-logo mg-logo-xs" name={e.client} /><b>{e.client}</b> · {e.project}{roles.filter((x) => !x.countsForTarget).length > 1 ? ` · ${e.role}` : ""}</span>
                      <span className="cn-r cn-d">{(+e.days.toFixed(2)).toLocaleString()}</span>
                      <b className="cn-r cn-v">{Math.round(e.value).toLocaleString()} €</b>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      ) : tab === "backlog" ? (
        <div className="mg-backlog-wrap">
          <BacklogPanel
            entries={entries}
            projects={projects}
            clientNames={clientNames}
            typeNames={typeNames}
            people={people}
            roles={roles}
            hourProjects={hourProjects}
            hoursPerDay={hoursPerDay}
            scope={scope}
            anchor={anchor}
            rangeFrom={rangeFrom}
            rangeTo={rangeTo}
            mainRoleByService={mainRoleByService}
            asOf={backlogAsOf}
            lockUser={lvBacklog === "own" ? access.userId ?? "__nobody" : undefined}
          />
          {loadingAll && <LoadingOverlay subtle />}
        </div>
      ) : tab === "billing" ? (
        <BillingPanel
          entries={billingScope.entries}
          projects={billingScope.projects}
          clientNames={clientNames}
          typeNames={typeNames}
          people={people}
          roles={roles}
          hourProjects={hourProjects}
          anchor={anchor}
          cutoffs={cutoffs}
          defaultCutoffDay={defaultCutoffDay}
        />
      ) : tab === "bonus" ? (
        <BonusPanel
          entries={entries.map((e) => ({
            id: e.id, userId: e.userId, projectId: e.projectId, date: e.date,
            billable: e.billable, status: e.status, line: e.line, typeId: e.typeId,
            billingPeriod: e.billingPeriod, durationMin: e.durationMin,
          }))}
          projects={projects}
          people={people}
          clientNames={clientNames}
          clientTypeIds={clientTypeIds}
          clientRoles={roles}
          cutoffs={cutoffs}
          defaultCutoffDay={defaultCutoffDay}
          asOf={bonusAsOf}
          hourProjects={hourProjects}
          hoursPerDay={hoursPerDay}
          onlyUser={lvBonus === "own" ? access.userId ?? "__nobody" : undefined}
          canEdit={lv("settings") === "all" && lvBonus === "all"}
          canPay={lvBonus === "all"}
          legacy={{ general: genBonus, perPerson: capacity, lag: bonusLag }}
        />
      ) : (
        <IncomingPanel />
      )}
    </div>
  );
}