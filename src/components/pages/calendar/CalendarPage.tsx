import { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import BookingModal, { repeatDates, repeatLabel, sameRule, REPEAT_AHEAD_DAYS, type RepeatRule, type BookingValue } from "./BookingModal";
import CalendarSettingsModal, { type WorkTypeDef, type Targets } from "./CalendarSettingsModal";
import { useAuth } from "../../api/AuthProvider";
import InvitesTray from "./InvitesTray";
import SharedBookingView from "./SharedBookingView";
import { loadMyInvites, syncInvites, loadAttendees, loadMyReplies,
  type InviteCard, type Attendee } from "./invitesApi";
import type { Cutoffs } from "./billingPeriods";
import { cutoffOf, periodOf, inBillingMonth, periodForDate } from "./billingPeriods";
import {
  legacyRoleMap, resolveRoleKey, resolvedLinesOf, roleLinesOfRow, roleKeyOf, roleCounts, rateOn, roleColor, sortRoles,
  type ClientRole, type RoleLine,
} from "../clients/clientsTypes";
import { loadRoles } from "../settings/blueprintsApi";
import ActualModal, { type ActualValue } from "./ActualModal";
import { supabase } from "../../api/supabase";
import { deleteEntryFromOutlook, syncCalendarEntry, useOutlookEvents, outlookOnDay, outlookNotLogged, outlookTime, OUTLOOK_EVENTS_SQL, type OutlookEvent } from "../../api/outlookSync";
import { createPortal } from "react-dom";
import { TicketDesk } from "../homepage/shared/HomeTodo";
import { PageCover } from "../../framework/AppLayout";
import "./CalendarPage.css";
import { useNavSection } from "../../framework/pageAccess";

/** Fallback window, used until the configured hours arrive. */
const DEFAULT_START = 8 * 60;
const DEFAULT_END = 20 * 60;

interface DayHours {
  weekday: number;
  visible_from: number; visible_to: number;
  work_from: number; work_to: number;
  lunch_from: number | null; lunch_to: number | null;
  closed: boolean;
  remote: boolean;
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri"];

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface Entry {
  id: string;
  dateKey: string;
  startMin: number;
  endMin: number;
  type: string;
billable: number;
  clientId: string;
  projectId: string;
  phaseId: string;
  taskId: string;
attendees: string;
  notes: string;
  status: string;
  line: string;
  roleId: string;
  meetKind: string;
  userId: string;
  outlookEventId?: string | null;
  /** Logged from this Outlook event (73_outlook_events.sql). */
  outlookSourceId?: string | null;
  /** One of the dates of a repeating entry (76_calendar_series.sql). */
  seriesId?: string | null;
  /** Came from a colleague's invitation. */
  inviteId?: string | null;
}
/** A repeating entry: its rule and what every date of it carries. */
interface SeriesRow {
  id: string; user_id: string; every_weeks: number; weekdays: number[]; start_date: string; until_date: string | null;
  filled_until: string | null; start_min: number; end_min: number; skip_off: boolean; template: Record<string, any>;
}
const ruleOfSeries = (s: SeriesRow): RepeatRule => ({ every: Number(s.every_weeks) || 1, weekdays: (s.weekdays ?? []).map(Number), until: s.until_date ? String(s.until_date).slice(0, 10) : null, skipOff: s.skip_off !== false });
const REP_ICON = "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3";
const SERIES_SQL = "Repeating entries need 76_calendar_series.sql — run it in Supabase (SQL editor), then try again. The entry was saved once.";
const addDaysIso = (iso: string, n: number) => { const [y, m, d] = iso.split("-").map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
const todayIsoStr = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
/** What every date of a series carries, taken from the entry row. */
const templateOf = (r: Record<string, unknown>) => {
  const keys = ["start_min", "end_min", "work_type_id", "billable", "client_id", "project_id", "phase_id", "task_ids", "attendees", "notes", "billing_line", "role_id", "kind", "meeting_kind"];
  return Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));
};
/** An entry row as the page keeps it. */
const toEntry = (r: Record<string, unknown>): Entry => ({
  id: r.id as string,
  dateKey: r.date_key as string,
  startMin: Number(r.start_min) || 0,
  endMin: Number(r.end_min) || 0,
  type: (r.work_type_id as string) ?? "",
  billable: Number(r.billable) || 0,
  clientId: (r.client_id as string) ?? "",
  projectId: (r.project_id as string) ?? "",
  phaseId: (r.phase_id as string) ?? "",
  taskId: (r.task_ids as string) ?? "",
  attendees: (r.attendees as string) ?? "",
  notes: (r.notes as string) ?? "",
  status: (r.status as string) || "planned",
  line: (r.billing_line as string) || "consultor",
  roleId: (r.role_id as string) ?? "",
  meetKind: (r.meeting_kind as string) ?? "in_person",
  userId: (r.user_id as string) ?? "",
  outlookEventId: (r.outlook_event_id as string) ?? null,
  outlookSourceId: (r.outlook_source_id as string) ?? null,
  seriesId: (r.series_id as string) ?? null,
  inviteId: (r.invite_id as string) ?? null,
} as Entry);
/** An Outlook event drawn on the week grid next to the entries. */
interface OlCell { id: string; startMin: number; endMin: number; userId: string; dateKey: string; ol: OutlookEvent }
const OL_KEY = "cal.outlook";
const OL_ICON = "M8 2v3M16 2v3M3.5 9h17M5 4.5h14A1.5 1.5 0 0 1 20.5 6v13A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5zM12 17.2a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4z";
const OlGlyph = ({ s = 13 }: { s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={OL_ICON} /></svg>
);
const SHOW_AS: Record<string, string> = { free: "Free", tentative: "Tentative", busy: "Busy", oof: "Out of office", workingElsewhere: "Working elsewhere" };

/**
 * An Outlook event, read only: when, where, who — and one button to log it as an entry
 * (the entry then stands in for it; the event itself stays untouched in Outlook).
 */
export function OutlookCard({ ev, anchor, logLabel, onLog, onClose }: {
  ev: OutlookEvent; anchor: DOMRect | null; logLabel: string; onLog: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    if (!anchor) { setPos({ top: Math.max(16, (vh - h) / 2), left: Math.max(16, (vw - w) / 2) }); return; }
    let left = anchor.right + 10;
    if (left + w > vw - 12) left = anchor.left - w - 10;
    if (left < 12) left = Math.min(vw - w - 12, Math.max(12, anchor.left + anchor.width / 2 - w / 2));
    const top = Math.min(vh - h - 12, Math.max(12, anchor.top));
    setPos({ top, left });
  }, [anchor, ev.id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("keydown", k, true);
    const t = window.setTimeout(() => document.addEventListener("mousedown", down), 0);
    return () => { document.removeEventListener("keydown", k, true); window.clearTimeout(t); document.removeEventListener("mousedown", down); };
  }, [onClose]);
  const s = new Date(ev.start), e = new Date(ev.end);
  const sameDayEv = s.toDateString() === new Date(e.getTime() - 1).toDateString();
  const day = s.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const when = ev.allDay ? (sameDayEv || e.getTime() - s.getTime() <= 86400000 ? "All day" : `All day · until ${new Date(e.getTime() - 1).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`)
    : sameDayEv ? `${outlookTime(ev.start)} – ${outlookTime(ev.end)}` : `${outlookTime(ev.start)} → ${new Date(ev.end).toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${outlookTime(ev.end)}`;
  return createPortal(
    <div ref={ref} className={`olc ${pos ? "is-in" : ""}`} role="dialog" aria-label={ev.subject} style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}>
      <div className="olc-top">
        <span className="olc-src"><OlGlyph s={12} />Outlook{ev.recurring ? " · repeats" : ""}</span>
        {ev.showAs && ev.showAs !== "busy" && SHOW_AS[ev.showAs] && <span className={`olc-show is-${ev.showAs}`}>{SHOW_AS[ev.showAs]}</span>}
        <button type="button" className="olc-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <h4 className="olc-title">{ev.subject}</h4>
      <p className="olc-when"><b>{day}</b><span>{when}</span></p>
      <div className="olc-facts">
        {ev.location && <span><i>Where</i>{ev.location}</span>}
        {(ev.organizer || ev.isOrganizer) && <span><i>Organiser</i>{ev.isOrganizer ? "You" : ev.organizer}</span>}
        {ev.attendees > 0 && <span><i>People</i>{ev.attendees} invited</span>}
      </div>
      {ev.preview && <p className="olc-prev">{ev.preview}</p>}
      <div className="olc-acts">
        <button type="button" className="olc-log" onClick={onLog}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>{logLabel}
        </button>
        {ev.joinUrl && <a className="olc-link" href={ev.joinUrl} target="_blank" rel="noopener noreferrer">Join</a>}
        {ev.webLink && <a className="olc-link" href={ev.webLink} target="_blank" rel="noopener noreferrer">Open in Outlook</a>}
      </div>
    </div>,
    document.body,
  );
}
/**
 * Why the Outlook button is orange, in words, with what to do about it (instead of a tooltip
 * nobody hovers): not connected, the function not deployed yet, or Microsoft's error.
 */
export function OutlookStatusCard({ anchor, connected, error, onRetry, onConnect, onHide, onClose }: {
  anchor: DOMRect; connected: boolean; error?: string; onRetry: () => void; onConnect: () => void; onHide: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("keydown", k, true);
    const t = window.setTimeout(() => document.addEventListener("mousedown", down), 0);
    return () => { document.removeEventListener("keydown", k, true); window.clearTimeout(t); document.removeEventListener("mousedown", down); };
  }, [onClose]);
  const notDeployed = !!error && /deploy|isn't deployed|Unknown action/i.test(error);
  const noPermission = !!error && /403|Forbidden|Authorization_RequestDenied|AccessDenied|insufficient/i.test(error);
  const title = !connected ? "Outlook isn't connected" : notDeployed ? "Outlook reading isn't switched on yet" : noPermission ? "Outlook said no" : "Couldn't read your Outlook";
  const text = !connected
    ? "Connect your Outlook (Settings › Interface) to see your Outlook events here."
    : notDeployed
      ? "The outlook-sync function in Supabase is still the old version. Deploy it again (supabase functions deploy outlook-sync) and press Try again."
      : noPermission
        ? "Your Outlook connection can't read the calendar. Connect Outlook again from Settings › Interface."
        : "Microsoft didn't answer as expected. Try again in a minute.";
  const left = Math.max(12, Math.min(window.innerWidth - 332, anchor.right - 320));
  return createPortal(
    <div ref={ref} className="olc olc-status is-in" role="dialog" aria-label={title} style={{ top: anchor.bottom + 10, left, width: 320 }}>
      <div className="olc-top"><span className="olc-src is-warn"><OlGlyph s={12} />Outlook</span>
        <button type="button" className="olc-x" onClick={onClose} aria-label="Close">×</button></div>
      <h4 className="olc-title">{title}</h4>
      <p className="olc-when"><span>{text}</span></p>
      {error && !notDeployed && <p className="olc-prev olc-err">{error}</p>}
      <div className="olc-acts">
        {!connected || noPermission
          ? <button type="button" className="olc-log" onClick={onConnect}>Connect Outlook</button>
          : <button type="button" className="olc-log" onClick={onRetry}>Try again</button>}
        <button type="button" className="olc-link is-btn" onClick={onHide}>Hide them</button>
      </div>
    </div>,
    document.body,
  );
}
/** Entries' days as dates ("Y-M-D" with a zero-based month). */
const keyDate = (k: string) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m, d); };

function startOfWeek(input: Date): Date {
  const d = new Date(input);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
/** ISO-8601 week number, the one people say out loud ("week 42"). */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 864e5 + 1) / 7);
}

/** Small icon for how an entry happens, shown next to its time. */
const MEET_ICON: Record<string, string> = {
  teams: "M15 10l4.5-2.6v9.2L15 14M4 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
};

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function fmtHour(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${period}`;
}
function fmtTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const period = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${period}`;
}
function fmtRange(start: Date, end: Date): string {
  const sM = MONTHS[start.getMonth()];
  const eM = MONTHS[end.getMonth()];
  const y = end.getFullYear();
  return sM === eM
    ? `${sM} ${start.getDate()} – ${end.getDate()}, ${y}`
    : `${sM} ${start.getDate()} – ${eM} ${end.getDate()}, ${y}`;
}
/** A number that rolls to its new value instead of jumping. */
function CountUp({ v, dec = 0, sep = false }: { v: number; dec?: number; sep?: boolean }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const a = from.current; const t0 = performance.now(); let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 650); const e = 1 - Math.pow(1 - k, 3);
      const x = a + (v - a) * e; setShown(x); from.current = x;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [v]);
  const txt = sep ? Math.round(shown).toLocaleString() : (Math.round(shown * 10 ** dec) / 10 ** dec).toFixed(dec).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return <>{txt}</>;
}

/** A small month calendar under the date range: click any day to jump to its week (or month). */
export function JumpPicker({ value, mode = "week", onPick, onClose }: {
  value: Date; mode?: "week" | "month"; onPick: (d: Date) => void; onClose: () => void;
}) {
  const [anchor, setAnchor] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));
  const [dirA, setDirA] = useState<1 | -1>(1);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => { if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [onClose]);
  const first = new Date(anchor);
  const lead = (first.getDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, i) => new Date(anchor.getFullYear(), anchor.getMonth(), 1 - lead + i));
  const rows = Array.from({ length: 6 }, (_, r) => cells.slice(r * 7, r * 7 + 7)).filter((r, i) => i < 5 || r[0].getMonth() === anchor.getMonth());
  const now = new Date();
  const selWeek = startOfWeek(value).getTime();
  const shift = (n: 1 | -1) => { setDirA(n); setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + n, 1)); };
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return (
    <div className="cv-jump" ref={ref} role="dialog" aria-label="Jump to date">
      <div className="cv-jump-head">
        <button type="button" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
        <b key={`${anchor.getFullYear()}-${anchor.getMonth()}`} className={dirA === 1 ? "is-next" : "is-prev"}>
          {MONTH_NAMES[anchor.getMonth()]} <em>{anchor.getFullYear()}</em>
        </b>
        <button type="button" onClick={() => shift(1)} aria-label="Next month">›</button>
      </div>
      <div className="cv-jump-dow">{["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i}>{d}</span>)}</div>
      <div key={`g-${anchor.getFullYear()}-${anchor.getMonth()}`} className={`cv-jump-grid ${dirA === 1 ? "is-next" : "is-prev"}`}>
        {rows.map((r) => {
          const on = mode === "week" ? startOfWeek(r[0]).getTime() === selWeek : false;
          return (
            <div key={r[0].toISOString()} className={`cv-jump-row ${on ? "is-on" : ""} ${mode === "week" ? "is-week" : ""}`}>
              {r.map((d) => (
                <button type="button" key={d.toISOString()}
                  className={`${d.getMonth() !== anchor.getMonth() ? "is-out" : ""} ${sameDay(d, now) ? "is-today" : ""} ${d.getDay() === 0 || d.getDay() === 6 ? "is-we" : ""} ${mode === "month" && d.getMonth() === value.getMonth() && d.getFullYear() === value.getFullYear() && d.getMonth() === anchor.getMonth() ? "is-mon" : ""}`}
                  onClick={() => { onPick(d); onClose(); }}>
                  {d.getDate()}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="cv-jump-foot">
        <button type="button" onClick={() => { onPick(new Date()); onClose(); }}>Today</button>
        <span><kbd>←</kbd><kbd>→</kbd> move · <kbd>T</kbd> today</span>
      </div>
    </div>
  );
}

function monthMatrix(anchor: Date): Date[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const rows: Date[][] = [];
  let cur = startOfWeek(first);
  while (cur <= last) {
    rows.push(Array.from({ length: 5 }, (_, i) => addDays(cur, i)));
    cur = addDays(cur, 7);
  }
  return rows;
}
const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Where each entry sits across the width of a day.
 *
 * On your own calendar nothing changes: overlapping entries split the width
 * between them. Once other people are on screen, whoever has something that
 * day takes a column, and anything of theirs that overlaps is merged into a
 * single Busy block from the first start to the last finish. Nobody with an
 * empty day holds a column, so a Tuesday where only two of four people are
 * working uses the full width for those two.
 */
function laidOut<T extends { id: string; startMin: number; endMin: number; userId: string }>(
  list: T[],
  owners: string[],
): (T & { left: number; width: number; lane: number; merged: number })[] {
  const many = owners.length > 1;
  // Only the people who actually have something today get a column.
  const present = owners.filter((uid) => list.some((e) => e.userId === uid));
  const cols = Math.max(1, present.length);
  const slice = 100 / cols;
  const out: (T & { left: number; width: number; lane: number; merged: number })[] = [];

  present.forEach((uid, col) => {
    const mine = list.filter((e) => e.userId === uid)
      .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    if (!mine.length) return;

    if (many) {
      // Runs of overlapping entries collapse into one block each.
      let run: T[] = [];
      const flush = () => {
        if (!run.length) return;
        const first = run[0];
        out.push({
          ...first,
          startMin: Math.min(...run.map((r) => r.startMin)),
          endMin: Math.max(...run.map((r) => r.endMin)),
          left: col * slice,
          width: slice,
          lane: 0,
          merged: run.length,
        });
        run = [];
      };
      mine.forEach((e) => {
        if (run.length && e.startMin < Math.max(...run.map((r) => r.endMin))) run.push(e);
        else { flush(); run = [e]; }
      });
      flush();
      return;
    }

    // On your own, overlapping entries share the width as before.
    const free: number[] = [];
    const placed = mine.map((e) => {
      let lane = free.findIndex((end) => end <= e.startMin);
      if (lane === -1) { lane = free.length; free.push(e.endMin); } else { free[lane] = e.endMin; }
      return { ...e, lane };
    });
    placed.forEach((e, _i, all) => {
      const busy = all.filter((o) => o.startMin < e.endMin && o.endMin > e.startMin);
      const lanes = busy.reduce((n, o) => Math.max(n, o.lane + 1), 1);
      out.push({ ...e, left: (e.lane / lanes) * 100, width: 100 / lanes, merged: 1 });
    });
  });
  return out;
}

/**
 * The key a day is grouped by: 'YYYY-M-D' with a zero-based month, which is
 * what every row in calendar_entries already uses. Anything writing this key
 * has to use getMonth() as-is — writing it one-based makes August land in
 * September's column.
 */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
/** Real ISO date (YYYY-MM-DD) for comparing against billing cutoffs. */
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** dateKey is stored as 'YYYY-M-D' (0-based month); rebuild it as real ISO. */
function isoFromKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface ModalState {
  day: Date;
  editingId?: string;
  /** Editing one date of a repeating entry: its series and rule. */
  seriesId?: string | null;
  repeat?: RepeatRule | null;
startMin: number;
  endMin: number;
type: string;
  billable: number;
  clientId: string;
  projectId: string;
  phaseId: string;
  taskId: string;
attendees: string;
  notes: string;
  line: string;
  roleId: string;
  meetKind?: string;
  /** Logging an Outlook event: the entry keeps its id. */
  outlookSourceId?: string;
}
export default function CalendarPage() {
  const navigate = useNavigate();
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [dir, setDir] = useState<1 | -1>(1);
  const [entries, setEntries] = useState<Entry[]>([]);
  /** My repeating entries, by id. */
  const [series, setSeries] = useState<Record<string, SeriesRow>>({});
const [modal, setModal] = useState<ModalState | null>(null);
const [showSettings, setShowSettings] = useState(false);
const [dragging, setDragging] = useState<{ id: string; grabMin: number } | null>(null);
  /** Hover / drag-to-create preview on the week grid, in minutes. */
  const [ghost, setGhost] = useState<{ key: string; anchor: number; cur: number; drag: boolean; len?: number } | null>(null);
  useEffect(() => {
    if (!ghost?.drag) return;
    const up = () => setGhost(null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [ghost?.drag]);
const [view, setView] = useState<"week" | "month">("week");
  useNavSection("/calendar", 0, (part) => { if (part === "week" || part === "month") setView(part); });
  const [jumpOpen, setJumpOpen] = useState(false);
  const [actuals, setActuals] = useState<Record<string, ActualValue>>({});
  const [actualFor, setActualFor] = useState<Entry | null>(null);
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => new Date());
const [workTypes, setWorkTypes] = useState<WorkTypeDef[]>([]);
const [clientNames, setClientNames] = useState<Record<string, string>>({});
const [targets, setTargets] = useState<Targets>({ perDay: 1, minPerDay: 0.5, minPerWeek: 3, minPerMonth: 12, minRevenueMonth: 0 });
  const [cutoffs, setCutoffs] = useState<Cutoffs>({});
  // "projectId|period" for invoices already sent/paid — those periods are locked
  // for billable entries, so new work rolls into the next bill instead of
  // silently making an already-issued invoice wrong.
  const [lockedBills, setLockedBills] = useState<Set<string>>(new Set());
  // Details for the "period closed" dialog shown instead of a system alert.
  const [closedNotice, setClosedNotice] = useState<{ monthName: string; period: string; iso: string; reason: "invoiced" | "cutoff" } | null>(null);
  const { session, role } = useAuth();
  const myId = session?.user?.id ?? "";
  /**
   * Whose calendar is on screen. Bosses can pick anyone in the company,
   * managers their own department, everyone else only their own.
   */
  /** Extra people whose entries are laid over your own. Up to three, so the
   *  week never carries more than four sets of bars. */
  const [alsoView, setAlsoView] = useState<string[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string; role: string; department: string }[]>([]);
  /** Whether this person reads other calendars in full or only as busy blocks. */
  const [canSeeDetail, setCanSeeDetail] = useState(false);
  const [detailDept, setDetailDept] = useState<string | null>(null);
  /** Invitations waiting on this person, of any kind of event. */
  const [invites, setInvites] = useState<InviteCard[]>([]);
  const [trayOpen, setTrayOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!trayOpen) return;
    const onClick = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setTrayOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTrayOpen(false); };
    // Deferred so the click that opens it does not close it again.
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [trayOpen]);
  /** Bumped when something outside the grid changes what is booked. */
  const [reloadKey, setReloadKey] = useState(0);
  /** An entry someone else arranged: read-only, whoever booked it owns it. */
  const [shared, setShared] = useState<{ id: string; inviteId: string | null } | null>(null);
  /** Who is on each entry you organised, and where each of them stands. */
  const [attendees, setAttendees] = useState<Record<string, Attendee[]>>({});
  const [unseenReplies, setUnseenReplies] = useState(0);
  useEffect(() => {
    if (!myId || !entries.length) return;
    loadAttendees(entries.map((e) => ({ id: e.id, inviteId: e.inviteId }))).then(setAttendees).catch(() => {});
    loadMyReplies(myId).then((rs) => setUnseenReplies(rs.filter((r) => !r.seen).length)).catch(() => {});
    // reloadKey too: dropping someone from a booking changes who is on it
    // without changing how many entries there are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId, entries.length, reloadKey]);
  useEffect(() => {
    if (!myId) return;
    loadMyInvites(myId).then(setInvites).catch(() => {});
  }, [myId]);

  const [whoOpen, setWhoOpen] = useState(false);
  const whoRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!whoOpen) return;
    const onClick = (e: MouseEvent) => {
      if (whoRef.current && !whoRef.current.contains(e.target as Node)) setWhoOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setWhoOpen(false); };
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [whoOpen]);
  const seenIds = useMemo(() => [myId, ...alsoView].filter(Boolean), [myId, alsoView]);
  const seenKey = seenIds.join(",");

  /**
   * Hours come from the most specific scope that has them: the person being
   * looked at, then their department, then the company. Whoever is watching
   * sees the window that applies to that calendar, not their own.
   */
  /** Projects billed by the hour, so the tracker can keep the units apart. */
  const [hourProjects, setHourProjects] = useState<Set<string>>(new Set());
  /**
   * What a billed day is worth in hours, from Targets and bonus in Management.
   * Goals are expressed in days, so hourly work has to be converted with this
   * before the two can be added up.
   */
  const [hoursPerDay, setHoursPerDay] = useState(8);
  /** The days/hours breakdown behind the headline figure, opened on click. */
  const [showSplit, setShowSplit] = useState(false);
  const [statLine, setStatLine] = useState<string>(() => { try { return localStorage.getItem("cal.statLine") || "all"; } catch { return "all"; } });
  const [lineOpen, setLineOpen] = useState(false);
  const lineRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!lineOpen) return;
    const off = (e: MouseEvent) => { if (lineRef.current && !lineRef.current.contains(e.target as Node)) setLineOpen(false); };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [lineOpen]);
  /** The to-do panel on the right, open or closed — remembered on this browser. */
  const [todoOpen, setTodoOpen] = useState<boolean>(() => { try { return localStorage.getItem("cal.todo") === "1"; } catch { return false; } });
  const [todoSeen, setTodoSeen] = useState(false);
  useEffect(() => { if (todoOpen) setTodoSeen(true); }, [todoOpen]);
  const toggleTodo = () => setTodoOpen((v) => { try { localStorage.setItem("cal.todo", v ? "0" : "1"); } catch { /* ignore */ } return !v; });
  useEffect(() => {
    (async () => {
      const { data: svc } = await supabase.from("services").select("id, rate_unit").eq("rate_unit", "hour");
      const ids = (svc ?? []).map((s: any) => s.id);
      if (!ids.length) { setHourProjects(new Set()); return; }
      const { data: pj } = await supabase.from("projects").select("id").in("service_id", ids);
      setHourProjects(new Set((pj ?? []).map((p: any) => p.id)));
    })();
  }, []);

  const [hoursByDay, setHoursByDay] = useState<Record<number, DayHours>>({});
  // The grid follows the first calendar on screen, which is always your own
  // unless you are looking at someone else.
  const hoursFor = alsoView.length === 1 ? alsoView[0] : myId;

  /** Your own entries always read in full; someone else's only if allowed. */
  const opaque = (uid: string) => {
    if (uid === myId) return false;
    if (canSeeDetail && !detailDept) return false;              // boss
    if (canSeeDetail && detailDept) {
      const p = people.find((x) => x.id === uid);
      return (p?.department ?? "") !== detailDept;               // outside the dept
    }
    return true;
  };
  useEffect(() => {
    (async () => {
      const { data: prof } = await supabase.from("profiles")
        .select("department").eq("id", hoursFor).maybeSingle();
      const dept = (prof as any)?.department ?? null;
      const { data } = await supabase.from("calendar_hours").select("*");
      const all = (data ?? []) as any[];
      const pickFor = (wd: number) =>
        all.find((r) => r.weekday === wd && r.scope === "user" && r.scope_ref === hoursFor)
        ?? (dept ? all.find((r) => r.weekday === wd && r.scope === "department" && r.scope_ref === dept) : undefined)
        ?? all.find((r) => r.weekday === wd && r.scope === "company");
      const out: Record<number, DayHours> = {};
      for (let wd = 0; wd < 7; wd++) {
        const r = pickFor(wd);
        if (r) out[wd] = r as DayHours;
      }
      setHoursByDay(out);
    })();
  }, [hoursFor]);

  /** The window the grid draws: the widest of the days on screen. */
  const { DAY_START, DAY_END, SPAN, HOURS } = useMemo(() => {
    const days = Object.values(hoursByDay).filter((d) => !d.closed);
    const from = days.length ? Math.min(...days.map((d) => d.visible_from)) : DEFAULT_START;
    const to = days.length ? Math.max(...days.map((d) => d.visible_to)) : DEFAULT_END;
    const s = Math.floor(from / 60) * 60;
    const e = Math.ceil(to / 60) * 60;
    const hrs: number[] = [];
    for (let h = s / 60; h < e / 60; h++) hrs.push(h);
    return { DAY_START: s, DAY_END: e, SPAN: Math.max(60, e - s), HOURS: hrs };
  }, [hoursByDay]);

  const viewingOther = alsoView.length > 0;
  /** One colour per person on screen, yours always first. */
  const OVERLAY = ["#12b57f", "#5b8def", "#d98324", "#a259d9"];
  const colourOf = (uid: string) => OVERLAY[Math.max(0, seenIds.indexOf(uid))] ?? OVERLAY[0];
  /**
   * Work-type colours are picked freely, so some come out far too bright for
   * white text (#e0fd08, #7eea57). Rather than switch those entries to dark
   * ink — which would leave two different text colours on one screen — the
   * fill itself is deepened until it is no lighter than the green already in
   * use. Hue is kept, so a yellow work type still reads as yellow.
   */
  const MAX_LUM = 0.35;
  const readableBg = (hex: string): string => {
    const h = (hex || "").replace("#", "").trim();
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return hex;
    let r = parseInt(full.slice(0, 2), 16);
    let g = parseInt(full.slice(2, 4), 16);
    let b = parseInt(full.slice(4, 6), 16);
    const chan = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const lum = () => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
    let guard = 0;
    while (lum() > MAX_LUM && guard < 60) {
      r = Math.round(r * 0.94);
      g = Math.round(g * 0.94);
      b = Math.round(b * 0.94);
      guard += 1;
    }
    const hx = (n: number) => n.toString(16).padStart(2, "0");
    return `#${hx(r)}${hx(g)}${hx(b)}`;
  };
  /** The colour an entry is drawn in: the person's when overlaying, else its work type. */
  const bgOf = (userId: string, typeColor?: string | null) =>
    readableBg(viewingOther ? colourOf(userId) : (typeColor ?? "#12b57f"));
  const nameOf = (uid: string) => people.find((p) => p.id === uid)?.name ?? "";
  const toggleView = (uid: string) => {
    if (uid === myId) return;
    setAlsoView((xs) => xs.includes(uid) ? xs.filter((x) => x !== uid)
      : xs.length >= 3 ? xs : [...xs, uid]);
  };

  useEffect(() => {
    if (!myId) return;
    (async () => {
      const { data: me } = await supabase.from("profiles")
        .select("role, department, is_superadmin").eq("id", myId).maybeSingle();
      const r = (me as any)?.role ?? role;
      const boss = (me as any)?.is_superadmin === true || r === "boss";
      const manager = ["consultancy_manager", "sales_manager", "customer_success_manager"].includes(r);
      // Everyone can look someone up; what changes is how much they see. A
      // manager or boss reads the entries, everyone else just gets the busy
      // blocks, which is enough to find a free slot.
      setCanSeeDetail(boss || manager);

      const { data } = await supabase.from("profiles")
        .select("id, first_name, last_name, username, email, role, department");
      let rows = (data ?? []) as any[];
      // A manager reads their own department in full; anyone can see the rest
      // as busy blocks, so the list is never cut.
      if (manager && !boss) setDetailDept((me as any)?.department ?? null);
      setPeople(rows.map((x) => ({
        id: x.id,
        name: [x.first_name, x.last_name].filter(Boolean).join(" ") || x.username || x.email || "Unnamed",
        role: x.role ?? "", department: x.department ?? "",
      })).sort((a, b) => a.name.localeCompare(b.name)));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId]);
  const [holidays, setHolidays] = useState<{ date: string; name: string }[]>([]);
  const [vacations, setVacations] = useState<{ id: string; date: string }[]>([]);
  const [vacationAllowance, setVacationAllowance] = useState(22);
  const [defaultCutoffDay, setDefaultCutoffDay] = useState(0);
  /** The roles sold on each project (rate per role), and every role of the catalogue. */
  const [projLines, setProjLines] = useState<Record<string, RoleLine[]>>({});
  const [allRoles, setAllRoles] = useState<ClientRole[]>([]);
  /** The shared loader covers the page until the first week of entries is in. */
  const [firstLoad, setFirstLoad] = useState(true);
  // Never leave the cover up if the first fetch fails.
  useEffect(() => { const t = window.setTimeout(() => setFirstLoad(false), 9000); return () => window.clearTimeout(t); }, []);
useEffect(() => {
    (async () => {
      // Only the weeks around the one on screen. Loading two years to draw
      // five days made every visit wait, and a plain select stops at a
      // thousand rows anyway, so the far months came back empty.
      const from = new Date(weekStart); from.setDate(from.getDate() - 60);
      const to = new Date(weekStart); to.setDate(to.getDate() + 60);
      const ce: any[] = [];
      for (let page = 0; ; page += 1000) {
        const { data: rows } = await supabase
          .from("calendar_entries").select("*").in("user_id", seenIds)
          .gte("entry_date", isoOf(from)).lte("entry_date", isoOf(to))
          .order("entry_date", { ascending: true })
          .range(page, page + 999);
        ce.push(...(rows ?? []));
        if (!rows || rows.length < 1000) break;
      }
      setFirstLoad(false);
      setEntries((ce ?? []).map((r: Record<string, unknown>) => toEntry(r)));

const { data: ea } = await supabase.from("entry_actuals").select("*");
      setActuals(Object.fromEntries(((ea ?? []) as Record<string, unknown>[]).map((r) => [
        r.entry_id as string,
        {
          startMin: Number(r.actual_start_min) || 0,
          endMin: Number(r.actual_end_min) || 0,
          billable: Number(r.actual_billable) || 0,
          reason: (r.reason as string) ?? "",
        },
      ])));

      const { data: cl } = await supabase.from("clients").select("id, name");
      setClientNames(Object.fromEntries(((cl ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name])));

      // Targets now come from Management (per-consultant, monthly). We load THIS
      // user's row and subdivide the monthly figures per view (see monthlyTargets).
      const { data: ut } = await supabase
        .from("user_targets")
        .select("min_days_month, min_billing_month, high_days_month, high_billing_month")
        .in("user_id", seenIds)
        .maybeSingle();
      setTargets({
        perDay: 0,
        minPerDay: 0,
        minPerWeek: 0,
        minPerMonth: Number(ut?.min_days_month) || 0,
        minRevenueMonth: Number(ut?.min_billing_month) || 0,
        highPerMonth: Number(ut?.high_days_month) || 0,
        highRevenueMonth: Number(ut?.high_billing_month) || 0,
      });

      // Each project's roles with their own rate; old projects read through their legacy columns.
      const [{ data: pj }, roleList] = await Promise.all([
        supabase.from("projects").select("id, role_lines, consultor_days, connector_days, supervision_days, price_per_day, supervision_price, discount_mode, discount_value, supervision_discount_mode, supervision_discount_value"),
        loadRoles(),
      ]);
      const legacy = legacyRoleMap(roleList);
      setAllRoles(roleList);
      setProjLines(Object.fromEntries(((pj ?? []) as Record<string, unknown>[]).map((r) =>
        [r.id as string, resolvedLinesOf({ roleLines: roleLinesOfRow(r) }, legacy)])));

      const { data } = await supabase.from("work_types").select("*").order("created_at");
      setWorkTypes((data ?? []).map((r: { id: string; name: string | null; client_related: boolean; color: string | null }) => ({
        id: r.id,
        name: r.name ?? "",
        clientRelated: !!r.client_related,
        color: r.color ?? "#12b57f",
      })));

      const { data: bp } = await supabase.from("billing_periods").select("period, cutoff_date");
      if (bp) setCutoffs(Object.fromEntries((bp as { period: string; cutoff_date: string }[]).map((r) => [r.period, r.cutoff_date])));
      const { data: inv } = await supabase.from("invoices").select("project_id, period, status");
      if (inv) setLockedBills(new Set((inv as any[])
        .filter((r) => r.status === "sent" || r.status === "paid")
        .map((r) => `${r.project_id}|${r.period}`)));
      const { data: bs } = await supabase.from("billing_settings").select("default_cutoff_day, vacation_days_per_year, hours_per_day").eq("id", "default").maybeSingle();
      if (bs) {
        setVacationAllowance(Number(bs.vacation_days_per_year ?? 22));
        setHoursPerDay(Number(bs.hours_per_day) || 8);
      }

      const { data: hol } = await supabase.from("holidays").select("holiday_date, name");
      setHolidays(((hol ?? []) as any[]).map((h) => ({ date: h.holiday_date, name: h.name ?? "" })));

      const { data: vac } = await supabase.from("vacations").select("id, vacation_date").in("user_id", seenIds);
      setVacations(((vac ?? []) as any[]).map((v) => ({ id: v.id, date: v.vacation_date })));
      if (bs) setDefaultCutoffDay(Number(bs.default_cutoff_day) || 0);

      // Repeating entries of mine (76_calendar_series.sql; nothing if it isn't run yet).
      if (myId) {
        const { data: srs, error: sErr } = await supabase.from("calendar_series").select("*").eq("user_id", myId);
        if (!sErr) setSeries(Object.fromEntries(((srs ?? []) as SeriesRow[]).map((r) => [r.id, r])));
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
    // weekStart too: the window follows whatever week is on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seenKey, reloadKey, weekStart.getFullYear(), weekStart.getMonth()]);

  /**
   * Wraps setWorkTypes so every change also lands in the work_types table
   * immediately. Without this, a type created in the UI has an id that only
   * exists in memory, and booking with it trips the FK constraint.
   */
  /**
   * Persist work types whenever they change. Runs as an effect (not inside a
   * state updater) so it fires reliably and only after render commits. Debounced
   * so typing a name doesn't fire a write per keystroke.
   */
  const typesLoaded = useRef(false);
  const prevTypeIds = useRef<string[]>([]);
  useEffect(() => {
    if (!typesLoaded.current) {
      typesLoaded.current = true;
      prevTypeIds.current = workTypes.map((t) => t.id);
      return;
    }
    const handle = setTimeout(() => {
      const toSave = workTypes.filter((t) => t.name.trim().length > 0);
      if (toSave.length) {
        supabase.from("work_types").upsert(
          toSave.map((t) => ({ id: t.id, name: t.name, client_related: t.clientRelated, color: t.color }))
        ).then(({ error }) => { if (error) console.error("work_types upsert failed:", error.message); });
      }
      // Delete rows removed since the last commit.
      const nowIds = new Set(workTypes.map((t) => t.id));
      const gone = prevTypeIds.current.filter((id) => !nowIds.has(id));
      if (gone.length) {
        supabase.from("work_types").delete().in("id", gone)
          .then(({ error }) => { if (error) console.error("work_types delete failed:", error.message); });
      }
      prevTypeIds.current = workTypes.map((t) => t.id);
    }, 500);
    return () => clearTimeout(handle);
  }, [workTypes]);

  const addHoliday = async (iso: string, name: string) => {
    setHolidays((h) => (h.some((x) => x.date === iso) ? h : [...h, { date: iso, name }]));
    await supabase.from("holidays").upsert({ holiday_date: iso, name }, { onConflict: "holiday_date" });
  };
  const removeHoliday = async (iso: string) => {
    setHolidays((h) => h.filter((x) => x.date !== iso));
    await supabase.from("holidays").delete().eq("holiday_date", iso);
  };

  const closeSettings = async () => {
    // Final sweep in case a type was left mid-edit.
    if (workTypes.length)
      await supabase.from("work_types").upsert(workTypes
        .filter((t) => t.name.trim().length > 0)
        .map((t) => ({ id: t.id, name: t.name, client_related: t.clientRelated, color: t.color })));
    // Targets live in Management; time off, holidays, hours and cutoffs in Settings › Calendar.
    setShowSettings(false);
  };

  const today = new Date();
  const days = useMemo(
    () => Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  /* ---- your Outlook, read only (grey blocks), on or off from the header ---- */
  const [olOn, setOlOn] = useState<boolean>(() => { try { return !!new URLSearchParams(window.location.search).get("outlook") || localStorage.getItem(OL_KEY) !== "0"; } catch { return true; } });
  const [olPick, setOlPick] = useState<{ ev: OutlookEvent; anchor: DOMRect | null } | null>(null);
  const olRange = useMemo(() => {
    if (view === "month") {
      const m = monthMatrix(monthAnchor).flat();
      return { from: m[0], to: addDays(m[m.length - 1], 3) };
    }
    return { from: weekStart, to: addDays(weekStart, 7) };
  }, [view, monthAnchor, weekStart]);
  const ol = useOutlookEvents(olRange.from, olRange.to, olOn && !!myId);
  const olShown = useMemo(() => (olOn ? outlookNotLogged(ol.events, entries.filter((e) => e.userId === myId)
    .map((e) => ({ date: keyDate(e.dateKey), startMin: e.startMin, endMin: e.endMin, outlookEventId: e.outlookEventId, outlookSourceId: e.outlookSourceId }))) : []),
  [olOn, ol.events, entries, myId]);
  const [olInfo, setOlInfo] = useState<DOMRect | null>(null);
  const setOlShown = (on: boolean) => { setOlOn(on); try { localStorage.setItem(OL_KEY, on ? "1" : "0"); } catch { /* ignore */ } };
  const toggleOl = (rect?: DOMRect) => {
    // orange: say why, instead of hiding them
    if (olOn && (!ol.connected || ol.error) && rect) { setOlInfo(rect); return; }
    setOlShown(!olOn);
  };
  // Home › an Outlook event: /calendar?outlook=<id>&d=<YYYY-MM-DD> opens its week and its card.
  const [olWanted, setOlWanted] = useState<{ id: string; day: Date } | null>(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const id = q.get("outlook"), d = q.get("d");
      if (!id || !d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
      const [y, m, dd] = d.split("-").map(Number);
      return { id, day: new Date(y, m - 1, dd) };
    } catch { return null; }
  });
  useEffect(() => {
    if (!olWanted) return;
    if (view !== "week") setView("week");
    const wk = startOfWeek(olWanted.day);
    if (wk.getTime() !== weekStart.getTime()) { setWeekStart(wk); return; }
    if (ol.loading || olRange.from.getTime() !== wk.getTime()) return;
    const ev = ol.events.find((x) => x.id === olWanted.id);
    if (ev) setOlPick({ ev, anchor: null });
    setOlWanted(null);
    navigate("/calendar", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [olWanted, weekStart, view, ol.loading, ol.events, olRange]);

  const jumpTo = (d: Date) => {
    const t = startOfWeek(d);
    setDir(t.getTime() < weekStart.getTime() ? -1 : 1);
    setWeekStart(t);
    setMonthAnchor(new Date(d.getFullYear(), d.getMonth(), 1));
  };
  // Keyboard: ←/→ move, T today, W/M switch view. Ignored while typing or with a popup open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable=true]") || document.querySelector("[role=dialog]")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "t" || e.key === "T") goToday();
      else if (e.key === "w" || e.key === "W") switchView("week");
      else if (e.key === "m" || e.key === "M") switchView("month");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
const go = (delta: 1 | -1) => {
    setDir(delta);
if (view === "month") {
      setMonthAnchor((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
    } else {
      setWeekStart((w) => addDays(w, delta * 7));
    }
  };
  /**
   * Switching view keeps you where you were in time. The two views track their
   * own position, so without this, moving to March in the month view and then
   * back to weeks dropped you on today again.
   */
  const switchView = (next: "week" | "month") => {
    if (next === view) return;
    if (next === "month") {
      setMonthAnchor(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1));
    } else {
      // Today's week when the month on screen is the current one, otherwise the
      // first week of that month.
      const now = new Date();
      const sameMonth = monthAnchor.getFullYear() === now.getFullYear()
        && monthAnchor.getMonth() === now.getMonth();
      setWeekStart(startOfWeek(sameMonth ? now : new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1)));
    }
    setView(next);
  };

// Is today on screen? (then the Today button steps aside)
  const atToday = (() => {
    const now = new Date();
    if (view === "month") return monthAnchor.getFullYear() === now.getFullYear() && monthAnchor.getMonth() === now.getMonth();
    return startOfWeek(now).getTime() === startOfWeek(weekStart).getTime();
  })();

const goToday = () => {
    setMonthAnchor(new Date());
    const t = startOfWeek(new Date());
    setDir(t.getTime() < weekStart.getTime() ? -1 : 1);
    setWeekStart(t);
  };

  const openNew = (day: Date, hour: number) => openRange(day, hour * 60, Math.min(hour * 60 + 60, DAY_END));
  const openRange = (day: Date, startMin: number, endMin: number) => {
    // Booking while looking at other calendars is the point of looking: the
    // entry is yours, since your own week is always one of the ones on screen.
    const billable = Math.max(0.25, Math.round((endMin - startMin) / 60 / 0.25) * 0.25);
setModal({ day, startMin, endMin, type: workTypes[0]?.id ?? "", billable, clientId: "", projectId: "", phaseId: "", taskId: "", attendees: "", notes: "", line: "", roleId: "" });
  };
  /** Log an Outlook event: a new entry at its time, its title as the note, linked back to it. */
  const logOutlook = (ev: OutlookEvent) => {
    const s = new Date(ev.start);
    const day = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    const on = outlookOnDay(ev, day);
    const hd = hoursByDay[day.getDay()];
    const [startMin, endMin] = !on || on === "allday"
      ? [hd?.work_from ?? 9 * 60, hd?.work_to ?? 17 * 60]
      : [Math.round(on.startMin / 15) * 15, Math.max(Math.round(on.startMin / 15) * 15 + 15, Math.round(on.endMin / 15) * 15)];
    const billable = Math.max(0.25, Math.round((endMin - startMin) / 60 / 0.25) * 0.25);
    setOlPick(null);
    setModal({ day, startMin, endMin, type: workTypes[0]?.id ?? "", billable, clientId: "", projectId: "", phaseId: "", taskId: "", attendees: "", notes: ev.subject, line: "", roleId: "",
      meetKind: ev.online ? "teams" : "in_person", outlookSourceId: ev.id });
  };
  /* ---------- repeating entries ---------- */
  /** Public holidays and my own days off, for series that skip them. */
  const offDaysOf = async (uid: string) => {
    const set = new Set(holidays.map((h) => String(h.date).slice(0, 10)));
    const { data } = await supabase.from("vacations").select("vacation_date").eq("user_id", uid);
    ((data ?? []) as any[]).forEach((v) => set.add(String(v.vacation_date).slice(0, 10)));
    return set;
  };
  /** Billable time can't land in a period that is over or already invoiced. */
  const closedOn = (iso: string, projectId: unknown, billable: unknown) => {
    if (!projectId || !(Number(billable) > 0)) return false;
    const period = periodForDate(iso, cutoffs, defaultCutoffDay);
    return cutoffOf(period, cutoffs, defaultCutoffDay) < todayIsoStr() || lockedBills.has(`${projectId}|${period}`);
  };
  /** How far ahead a series with no end is turned into entries: three months past today or the week on screen. */
  const seriesHorizon = () => {
    const t = todayIsoStr(), w = isoOf(weekStart);
    return addDaysIso(w > t ? w : t, REPEAT_AHEAD_DAYS);
  };
  /**
   * Adds the dates of a series as entries (in batches), then — in the background,
   * one by one — invites the colleagues on it and puts each one in Outlook.
   */
  const addSeriesDates = async (s: { id: string; template: Record<string, any>; skipOff: boolean }, uid: string, dates: string[]) => {
    const off = s.skipOff ? await offDaysOf(uid) : new Set<string>();
    const t = s.template;
    const keep = dates.filter((d) => !off.has(d) && !closedOn(d, t.project_id, t.billable));
    const { summoned, summon_note, ...cols } = t;
    const rows = keep.map((d) => {
      const [y, m, dd] = d.split("-").map(Number);
      return { ...cols, id: crypto.randomUUID(), user_id: uid, date_key: dateKey(new Date(y, m - 1, dd)), entry_date: d, status: "planned", series_id: s.id };
    });
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from("calendar_entries").insert(rows.slice(i, i + 200));
      if (error) { alert(`Could not add the repeating dates: ${error.message}`); return 0; }
    }
    setEntries((list) => [...list, ...rows.map((r) => toEntry(r))]);
    const who = (summoned ?? []) as { id: string; billable: number }[];
    void (async () => {
      for (const r of rows) {
        if (who.length) await syncInvites(r.id, uid, who, (cols.billing_line as string) || "consultor", summon_note ?? undefined, (cols.role_id as string) || null).catch(() => {});
        const res = await syncCalendarEntry(r.id).catch(() => null);
        if (res?.ok && res.eventId) setEntries((list) => list.map((e) => (e.id === r.id ? { ...e, outlookEventId: res.eventId } : e)));
      }
    })();
    return rows.length;
  };
  /** Takes these entries out, and their Outlook events after them. */
  const dropEntries = async (rows: { id: string; outlook_event_id?: string | null }[]) => {
    if (!rows.length) return;
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 200) await supabase.from("calendar_entries").delete().in("id", ids.slice(i, i + 200));
    setEntries((list) => list.filter((e) => !ids.includes(e.id)));
    void (async () => { for (const r of rows) if (r.outlook_event_id) await deleteEntryFromOutlook(r.outlook_event_id, r.id).catch(() => {}); })();
  };
  // Series with no end (or a far one) get their next dates as time goes by, or as you browse ahead.
  const topping = useRef(false);
  useEffect(() => {
    if (!myId || topping.current) return;
    const horizon = seriesHorizon();
    const due = Object.values(series).filter((s) => {
      const limit = s.until_date && String(s.until_date).slice(0, 10) < horizon ? String(s.until_date).slice(0, 10) : horizon;
      return String(s.filled_until ?? s.start_date).slice(0, 10) < limit;
    });
    if (!due.length) return;
    topping.current = true;
    (async () => {
      for (const s of due) {
        const rule = ruleOfSeries(s);
        const start = String(s.start_date).slice(0, 10);
        const from = String(s.filled_until ?? s.start_date).slice(0, 10);
        const limit = rule.until && rule.until < horizon ? rule.until : horizon;
        const dates = repeatDates(start, rule, limit, 5000).filter((d) => d > from);
        // Marked first, so two open tabs don't both add the same dates.
        const { error } = await supabase.from("calendar_series").update({ filled_until: limit }).eq("id", s.id);
        if (error) continue;
        setSeries((m) => ({ ...m, [s.id]: { ...s, filled_until: limit } }));
        if (dates.length) await addSeriesDates({ id: s.id, template: s.template ?? {}, skipOff: rule.skipOff }, myId, dates);
      }
      topping.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, weekStart.getTime(), myId]);

  const openEdit = (day: Date, e: Entry) => {
    if (e.userId !== myId) return;
    // Came from an invitation, so it belongs to whoever sent it.
    if (e.inviteId) { setShared({ id: e.id, inviteId: e.inviteId }); return; }
    setModal({
      day,
      editingId: e.id,
      startMin: e.startMin,
      endMin: e.endMin,
      // Drop a work type that has since been deleted, so the user re-picks a valid one.
      type: workTypes.some((t) => t.id === e.type) ? e.type : "",
      billable: e.billable,
     clientId: e.clientId ?? "",
      projectId: e.projectId ?? "",
      phaseId: e.phaseId ?? "",
taskId: e.taskId ?? "",
attendees: e.attendees ?? "",
      notes: e.notes ?? "",
      line: e.line ?? "consultor",
      roleId: e.roleId ?? "",
      meetKind: e.meetKind ?? "in_person",
      seriesId: e.seriesId ?? null,
      repeat: e.seriesId && series[e.seriesId] ? ruleOfSeries(series[e.seriesId]) : null,
    });
  };
const saveModal = (vIn: BookingValue) => {
if (!modal) return;
    const { date: movedTo, repeat: ruleIn, scope, ...v } = vIn;
    const d = movedTo ?? modal.day;
    const key = dateKey(d);
    const id = modal.editingId ?? crypto.randomUUID();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const rule = ruleIn ?? null;
    const oldSeries = modal.editingId ? modal.seriesId ?? null : null;
    const was = entries.find((e) => e.id === id);
    /** The day the entry was on before this change: "the ones after" count from it. */
    const origIso = was ? isoFromKey(was.dateKey) : iso;
    const ruleChanged = !!oldSeries && !sameRule(rule, modal.repeat ?? null);

    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u?.user) { alert("Not signed in."); return; }

      // Safeguard: don't let billable work land in a period whose invoice for
      // that client is already sent/paid — it would make an issued invoice wrong.
      // The work should go to the next open period instead.
      if (v.projectId && v.billable > 0) {
        const period = periodForDate(iso, cutoffs, defaultCutoffDay);
        // A period is CLOSED for new billable work when either:
        //  - its cutoff day is already in the past (the period is over), or
        //  - this client's invoice for it is already sent/paid.
        // In both cases the work belongs to the current open period instead.
        const todayIso = (() => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; })();
        const cutoffPassed = cutoffOf(period, cutoffs, defaultCutoffDay) < todayIso;
        const alreadyInvoiced = lockedBills.has(`${v.projectId}|${period}`);
        if (cutoffPassed || alreadyInvoiced) {
          const [yy, mm] = period.split("-");
          const monthName = new Date(Number(yy), Number(mm) - 1, 1)
            .toLocaleDateString("en-GB", { month: "long", year: "numeric" });
          // Record the attempt for billing to see in the Management panel.
          try {
            await supabase.from("billing_alerts").insert({
              project_id: v.projectId,
              period,
              entry_date: iso,
              billable: v.billable,
              // The role it was logged on (what the line was before roles).
              billing_line: v.roleId || v.line || "consultor",
              attempted_by: u.user.id,
            });
          } catch (e) {
            console.error("Could not record billing alert:", e);
          }
          setClosedNotice({ monthName, period, iso, reason: alreadyInvoiced ? "invoiced" : "cutoff" });
          return;
        }
      }

      // The type must be one the DB actually knows about, or the FK rejects it.
      if (v.type && !workTypes.some((t) => t.id === v.type)) {
        console.warn("Booking used an unknown work_type_id:", v.type, "known:", workTypes.map((t) => t.id));
        alert("This booking's type of work no longer exists. Pick a type again in the booking, then save.");
        return;
      }
      const fromOl = !modal.editingId && modal.outlookSourceId ? modal.outlookSourceId : null;
      const row: Record<string, unknown> = {
        id,
        user_id: u.user.id,
        date_key: key,
        entry_date: iso,
        start_min: v.startMin,
        end_min: v.endMin,
        work_type_id: v.type || null,
        billable: v.billable,
        client_id: v.clientId || null,
        project_id: v.projectId || null,
        phase_id: v.phaseId || null,
        task_ids: v.taskId || null,
        attendees: v.attendees || null,
notes: v.notes || null,
        billing_line: v.line || "consultor",
        role_id: v.roleId || null,
        kind: "delivery",
        meeting_kind: v.meetKind || "in_person",
        status: entries.find((e) => e.id === id)?.status ?? "planned",
      };
      if (fromOl) row.outlook_source_id = fromOl;

      // Repeats: a new series starts on this entry (a new entry, an entry that
      // starts repeating, or a series whose rule changed from this date on).
      const tpl = { ...templateOf(row), summoned: v.summoned ?? [], summon_note: v.summonNote ?? null };
      let newSeries: SeriesRow | null = null;
      if (rule && (!oldSeries || ruleChanged)) {
        const limit = rule.until ? (rule.until < addDaysIso(iso, 366) ? rule.until : addDaysIso(iso, 366)) : seriesHorizon();
        const s: SeriesRow = {
          id: crypto.randomUUID(), user_id: u.user.id, every_weeks: rule.every, weekdays: rule.weekdays, start_date: iso,
          until_date: rule.until, filled_until: limit, start_min: v.startMin, end_min: v.endMin, skip_off: rule.skipOff, template: tpl,
        };
        const { error: se } = await supabase.from("calendar_series").insert(s);
        if (se) alert(SERIES_SQL);
        else { newSeries = s; row.series_id = s.id; }
      }

      let { error } = await supabase.from("calendar_entries").upsert(row);
      let linked = !!fromOl;
      if (error && fromOl && /outlook_source_id/i.test(error.message)) {
        // 73_outlook_events.sql not run yet: keep the entry, without the link
        delete row.outlook_source_id;
        ({ error } = await supabase.from("calendar_entries").upsert(row));
        linked = false;
        if (!error) alert(OUTLOOK_EVENTS_SQL);
      }
      if (error) { alert(`Could not save entry: ${error.message}`); return; }

      // Invitations follow whoever is on the entry now: dropped people lose
      // theirs, new ones get one, and those already on it are left alone.
      if (v.summoned) {
        setReloadKey((k) => k + 1);
        await syncInvites(
          id, u.user.id,
          v.summoned.map((s) => ({ id: s.id, billable: s.billable })),
          v.line || "consultor",
          v.summonNote,
          v.roleId || null,
        ).catch(() => {});
      }

      const fields = { ...v, seriesId: (row.series_id as string) ?? (oldSeries || null) };
      delete (fields as any).summoned; delete (fields as any).summonNote;
      setEntries((list) =>
        modal.editingId
          ? list.map((e) => (e.id === id ? { ...e, ...fields, dateKey: key } : e))
        : [...list, { id, dateKey: key, ...fields, status: "planned", outlookSourceId: fromOl } as Entry]
      );
      setModal(null);

      // An entry of a series, changed for "this and the ones after".
      if (oldSeries && scope === "following") {
        const { data: later } = await supabase.from("calendar_entries")
          .select("id, outlook_event_id").eq("series_id", oldSeries).gt("entry_date", origIso);
        const rest = ((later ?? []) as { id: string; outlook_event_id: string | null }[]).filter((r) => r.id !== id);
        if (ruleChanged) {
          // New rule (or no repeat any more): the old dates after this one go, the old series ends here.
          await dropEntries(rest);
          const end = newSeries ? addDaysIso(origIso, -1) : origIso;
          await supabase.from("calendar_series").update({ until_date: end, filled_until: end }).eq("id", oldSeries);
          setSeries((m) => (m[oldSeries] ? { ...m, [oldSeries]: { ...m[oldSeries], until_date: end, filled_until: end } } : m));
        } else if (rest.length) {
          // Same rule: the dates after this one take the new times and details (their status stays).
          const { id: _i, user_id: _u, date_key: _k, entry_date: _d, status: _s, ...upd } = row;
          delete upd.outlook_source_id; delete upd.series_id;
          const ids = rest.map((r) => r.id);
          for (let i = 0; i < ids.length; i += 200) await supabase.from("calendar_entries").update(upd).in("id", ids.slice(i, i + 200));
          await supabase.from("calendar_series").update({ start_min: v.startMin, end_min: v.endMin, template: tpl }).eq("id", oldSeries);
          setSeries((m) => (m[oldSeries] ? { ...m, [oldSeries]: { ...m[oldSeries], start_min: v.startMin, end_min: v.endMin, template: tpl } } : m));
          const { seriesId: _sid, ...same } = fields;
          setEntries((list) => list.map((e) => (ids.includes(e.id) ? { ...e, ...same } : e)));
          void (async () => {
            for (const r of rest) {
              if (v.summoned) await syncInvites(r.id, u.user.id, v.summoned, v.line || "consultor", v.summonNote, v.roleId || null).catch(() => {});
              await syncCalendarEntry(r.id).catch(() => null);
            }
          })();
        }
      }
      // The new series' other dates.
      if (newSeries) {
        setSeries((m) => ({ ...m, [newSeries!.id]: newSeries! }));
        const dates = repeatDates(iso, rule!, newSeries.filled_until!, 400).slice(1);
        if (dates.length) void addSeriesDates({ id: newSeries.id, template: tpl, skipOff: rule!.skipOff }, u.user.id, dates);
      }

      // Logged from an Outlook event: it's already in Outlook, leave it as it is.
      if (fromOl && linked) return;
      // Into the booker's Outlook with everything on it, colleagues invited
      // (no-op if Outlook isn't connected).
      void syncCalendarEntry(id).then((r) => {
        if (r.ok && r.eventId) setEntries((list) => list.map((e) => (e.id === id ? { ...e, outlookEventId: r.eventId } as any : e)));
      });
    })();
  };
const moveEntry = async (id: string, day: Date, newStart: number) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    const dur = entry.endMin - entry.startMin;
    const start = Math.max(DAY_START, Math.min(newStart, DAY_END - dur));
    const end = start + dur;
    const key = dateKey(day);
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;

    setEntries((list) => list.map((e) => (e.id === id ? { ...e, startMin: start, endMin: end, dateKey: key } : e)));

    const { error } = await supabase.from("calendar_entries")
      .update({ start_min: start, end_min: end, date_key: key, entry_date: iso })
      .eq("id", id);
    if (error) alert(`Could not move entry: ${error.message}`);
    else void syncCalendarEntry(id);
  };

const saveActual = async (entryId: string, v: ActualValue) => {
    const { data: u } = await supabase.auth.getUser();
    if (!u?.user) { alert("Not signed in."); return; }
    const { error } = await supabase.from("entry_actuals").upsert({
      entry_id: entryId,
      user_id: u.user.id,
      actual_start_min: v.startMin,
      actual_end_min: v.endMin,
      actual_billable: v.billable,
      reason: v.reason || null,
    }, { onConflict: "entry_id" });
    if (error) { alert(`Could not save actuals: ${error.message}`); return; }
    setActuals((a) => ({ ...a, [entryId]: v }));
    setActualFor(null);
  };

  const clearActual = async (entryId: string) => {
    const { error } = await supabase.from("entry_actuals").delete().eq("entry_id", entryId);
    if (error) { alert(`Could not remove: ${error.message}`); return; }
    setActuals((a) => {
      const next = { ...a };
      delete next[entryId];
      return next;
    });
    setActualFor(null);
  };

  const setStatus = async (id: string, status: string) => {
    const current = entries.find((e) => e.id === id)?.status;
    const next = current === status ? "planned" : status;
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, status: next } : e)));
    const { error } = await supabase.from("calendar_entries").update({ status: next }).eq("id", id);
    if (error) alert(`Could not update: ${error.message}`);
    else void syncCalendarEntry(id);
  };

  const deleteModal = async (scope?: "one" | "following") => {
    if (!modal?.editingId) return;
    const entry = entries.find((e) => e.id === modal.editingId) as any;
    const sid = modal.seriesId ?? null;
    if (sid && scope === "following" && entry) {
      // This date and every one after it; the series ends the day before.
      const from = isoFromKey(entry.dateKey);
      const { data: later, error: le } = await supabase.from("calendar_entries")
        .select("id, outlook_event_id").eq("series_id", sid).gte("entry_date", from);
      if (le) { alert(`Could not delete: ${le.message}`); return; }
      const rows = ((later ?? []) as { id: string; outlook_event_id: string | null }[]);
      if (!rows.some((r) => r.id === entry.id)) rows.push({ id: entry.id, outlook_event_id: entry.outlookEventId ?? null });
      const end = addDaysIso(from, -1);
      await supabase.from("calendar_series").update({ until_date: end, filled_until: end }).eq("id", sid);
      setSeries((m) => (m[sid] ? { ...m, [sid]: { ...m[sid], until_date: end, filled_until: end } } : m));
      setModal(null);
      await dropEntries(rows);
      return;
    }
    const { error } = await supabase.from("calendar_entries").delete().eq("id", modal.editingId);
    if (error) { alert(`Could not delete: ${error.message}`); return; }
    setEntries((list) => list.filter((e) => e.id !== modal.editingId));
    setModal(null);
    // Remove the matching Outlook event (best-effort, no-op if not connected).
    if (entry?.outlookEventId) await deleteEntryFromOutlook(entry.outlookEventId, modal.editingId);
  };

const clientTypeIds = new Set(workTypes.filter((t) => t.clientRelated).map((t) => t.id));
const effBillable = (e: Entry) =>
    Number(actuals[e.id]?.billable ?? e.billable) || 0;
  /**
   * The same entry expressed in DAYS. An entry on an hourly service stores its
   * billable in hours, so adding it straight to a day figure counted six hours
   * as six days. Targets are set in days, so everything is converted here
   * before it is summed or compared to a goal.
   */
  /** "h" for entries on an hourly service, "d" otherwise. */
  const unitOf = (e: Entry) =>
    e.projectId && hourProjects.has(e.projectId) ? "h" : "d";
  const effDays = (e: Entry) => {
    const v = effBillable(e);
    return e.projectId && hourProjects.has(e.projectId) && hoursPerDay > 0
      ? v / hoursPerDay
      : v;
  };
  /** The role an entry is logged on (old entries: their line, read as the matching role). */
  const roleMap = useMemo(() => legacyRoleMap(allRoles), [allRoles]);
  const keyOf = (e: Entry) => resolveRoleKey(roleKeyOf(e), roleMap);
  /** Whether an entry's time counts for the consultant's target (a connector role doesn't). */
  const counts = (e: Entry) => roleCounts(keyOf(e), allRoles);
  const roleOf = (e: Entry) => allRoles.find((r) => r.id === keyOf(e));
  /** Project time on a role that doesn't count: drawn with a striped edge in the role's colour. */
  const noCount = (e: Entry) => !!e.projectId && e.line !== "closure" && e.line !== "sales" && !counts(e);
  const roleIdx = (id: string) => sortRoles(allRoles).findIndex((r) => r.id === id);
  const noCountStyle = (e: Entry) => {
    const r = roleOf(e);
    return { ["--rc" as string]: roleColor(r, Math.max(0, roleIdx(r?.id ?? ""))) };
  };
const billableOf = (list: Entry[]) =>
    list.filter((e) => clientTypeIds.has(e.type) && e.status !== "cancelled" && counts(e))
        .reduce((s, e) => s + effDays(e), 0);
  const confirmedOf = (list: Entry[]) =>
    list.filter((e) => clientTypeIds.has(e.type) && e.status === "confirmed" && counts(e))
        .reduce((s, e) => s + effDays(e), 0);

const monthDays = monthMatrix(monthAnchor).flat().filter((d) => d.getMonth() === monthAnchor.getMonth());
  const scopeDays = view === "month" ? monthDays : days;
  // Month scope follows the billing window (prev cutoff → this cutoff), which can
  // include late days of the previous calendar month and exclude late days of this one.
  const scopeEntries = view === "month"
    ? entries.filter((e) => inBillingMonth(isoFromKey(e.dateKey), periodOf(monthAnchor), cutoffs, defaultCutoffDay))
    : entries.filter((e) => scopeDays.some((d) => dateKey(d) === e.dateKey));
  const weekPlanned = billableOf(scopeEntries);
  const weekDone = confirmedOf(scopeEntries);

  /**
   * Days and hours are different units, so the tracker shows whichever the
   * period actually contains: only days, only hours, or both side by side.
   */
  const split = (list: Entry[], onlyConfirmed: boolean) => {
    const rows = list.filter((e) =>
      clientTypeIds.has(e.type) && counts(e)
      && (onlyConfirmed ? e.status === "confirmed" : e.status !== "cancelled"));
    let days = 0, hours = 0;
    rows.forEach((e) => {
      if (e.projectId && hourProjects.has(e.projectId)) hours += effBillable(e);
      else days += effBillable(e);
    });
    return { days, hours };
  };
  const plannedSplit = split(scopeEntries, false);
  const hasDays = plannedSplit.days > 0;
  const hasHours = plannedSplit.hours > 0;
  const WEEKS_PER_MONTH = 4.333;
  const div = view === "month" ? 1 : WEEKS_PER_MONTH;

  // Dynamic target: aim for the minimum; once reached, the goal jumps to the high tier.
  const minDays = targets.minPerMonth / div;
  const highDaysRaw = (targets.highPerMonth ?? 0) / div;
  const highDays = highDaysRaw > minDays ? highDaysRaw : 0; // only if a real higher tier exists
  const reachedMinDays = minDays > 0 && weekPlanned >= minDays;
  // Once the minimum is cleared the bar measures against the higher tier.
  // It is no longer badged or recoloured: the goal figure next to the number
  // already says what is being aimed at.
  const scopeGoal = reachedMinDays && highDays > 0 ? highDays : minDays;

  const minRev = targets.minRevenueMonth / div;
  const highRevRaw = (targets.highRevenueMonth ?? 0) / div;
  const highRev = highRevRaw > minRev ? highRevRaw : 0;

  /** Per-day rate for an entry: its role's rate on the project, after that role's discount. */
  const rateOf = (e: Entry) => {
    const ls = projLines[e.projectId];
    return ls ? rateOn(ls, keyOf(e)) : 0;
  };

  const revenueOf = (list: Entry[]) =>
    list.filter((e) => clientTypeIds.has(e.type) && e.status !== "cancelled" && e.line !== "closure")
        .reduce((s, e) => s + effBillable(e) * rateOf(e), 0);
  const scopeRevenue = revenueOf(scopeEntries);
  // Dynamic revenue target: jump to the high tier once the minimum is billed.
  const reachedMinRev = minRev > 0 && scopeRevenue >= minRev;
  const scopeRevenueGoal = reachedMinRev && highRev > 0 ? highRev : minRev;
  const revPct = scopeRevenueGoal > 0
    ? Math.min(100, (scopeRevenue / scopeRevenueGoal) * 100)
    : 0;
  // Against the target while one exists, against what is booked otherwise.
  const trackBase = scopeGoal > 0 ? scopeGoal : weekPlanned;
  const weekDonePct = scopeGoal > 0 ? Math.min(100, (weekDone / scopeGoal) * 100) : 0;

  const holidaySet = new Map(holidays.map((h) => [h.date, h.name]));
  const vacationSet = new Set(vacations.map((v) => v.date));

  /** Toggle a vacation day for the current user. */
  const vacationsUsed = vacations.length;

  const dirClass = dir === 1 ? "slide-next" : "slide-prev";
  const animKey = weekStart.getTime();

  const nowMin = today.getHours() * 60 + today.getMinutes();
  const nowVisible = nowMin >= DAY_START && nowMin <= DAY_END;
  const nowPct = ((nowMin - DAY_START) / SPAN) * 100;

  const minAt = (el: HTMLElement, clientY: number) => {
    const r = el.getBoundingClientRect();
    const m = DAY_START + ((clientY - r.top) / r.height) * SPAN;
    return Math.max(DAY_START, Math.min(DAY_END - 30, Math.floor(m / 30) * 30));
  };
  const ghostRange = (g: { anchor: number; cur: number; len?: number }) => g.len
    ? [g.cur, Math.min(DAY_END, g.cur + g.len)]
    : g.cur >= g.anchor ? [g.anchor, Math.min(DAY_END, g.cur + 30)] : [g.cur, Math.min(DAY_END, g.anchor + 30)];
  const durLabel = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);
  const num2 = (n: number) => String(Math.round(n * 100) / 100);

  /** What the bar can count: everything that counts for the target, or one role. */
  const statLines: { id: string; label: string; hint: string; color?: string }[] = [
    { id: "all", label: "All billable", hint: "Every role that counts for your target" },
    ...sortRoles(allRoles).map((r, i) => ({
      id: r.id, label: r.name, color: roleColor(r, i),
      hint: r.countsForTarget ? "Counts for your target" : "Billed to the client, not to your target",
    })),
  ];
  // A choice saved before roles (a line name) is read as its role; a role that is gone falls back to all.
  const statKey = statLine === "all" ? "all" : resolveRoleKey(statLine, roleMap);
  const statCur = statLines.find((l) => l.id === statKey) ?? statLines[0];
  const statId = statCur.id;
  /** Billing figures in the bar: which line they count. */
  const daysOnLine = (list: Entry[], onlyConfirmed: boolean) => list
    .filter((e) => clientTypeIds.has(e.type) && (onlyConfirmed ? e.status === "confirmed" : e.status !== "cancelled"))
    .filter((e) => (statId === "all" ? counts(e) : keyOf(e) === statId))
    .reduce((sum, e) => sum + effDays(e), 0);
  const cutoffInfo = (() => {
    const per = periodForDate(isoOf(today), cutoffs, defaultCutoffDay);
    const cIso = cutoffOf(per, cutoffs, defaultCutoffDay);
    if (!cIso) return null;
    const c = new Date(`${cIso}T00:00:00`);
    const left = Math.round((c.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 864e5);
    return { left, label: `${MONTHS[c.getMonth()]} ${c.getDate()}`, month: MONTHS_FULL[Number(per.slice(5)) - 1] ?? per };
  })();

  return (
    <div className="cal cal-ov cal-v3">
      <PageCover show={firstLoad} label="Loading your calendar" />
      <div className="cal-scan-wrap" aria-hidden="true">
        <div className="cal-scan" />
      </div>

<header className="cv-bar"
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty("--hx", `${e.clientX - r.left}px`); e.currentTarget.style.setProperty("--hy", `${e.clientY - r.top}px`); }}>
        <span className="cv-bar-fx" aria-hidden="true" />
        <div className="cv-l">
          <button className="cal-home" onClick={() => navigate("/home")} aria-label="Back to home" title="Home">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div className="cv-title">
            <h1 className="cal-title">Calendar</h1>
            <span className="cv-title-sub">{view === "month" ? `${MONTHS_FULL[monthAnchor.getMonth()]} ${monthAnchor.getFullYear()}` : `Week ${isoWeek(weekStart)} · ${weekStart.getFullYear()}`}</span>
          </div>
          <div className="cal-view-seg" data-view={view}>
            <span className="cal-view-slider" />
            <button className={view === "week" ? "is-on" : ""} onClick={() => switchView("week")} title="Week (W)">Week</button>
            <button className={view === "month" ? "is-on" : ""} onClick={() => switchView("month")} title="Month (M)">Month</button>
          </div>
          <div className="cv-nav">
            {/* Today only shows once you leave the current week / month (it slides in and out) */}
            <span className={`cv-nav-todaywrap ${atToday ? "is-here" : ""}`} aria-hidden={atToday}>
              <span className="cv-nav-todayin">
                <button className="cv-nav-today" onClick={goToday} title="Jump to today (T)" tabIndex={atToday ? -1 : 0}>Today</button>
                <span className="cv-nav-sep" />
              </span>
            </span>
            <button className="cv-nav-arrow" onClick={() => go(-1)} aria-label={view === "month" ? "Previous month" : "Previous week"} title="Previous (←)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div className="cv-nav-range-wrap">
              <button className={`cv-nav-range ${jumpOpen ? "is-open" : ""}`} onClick={() => setJumpOpen((v) => !v)} title="Pick a date">
                <span key={view === "month" ? monthAnchor.getTime() : weekStart.getTime()} className={dirClass === "slide-next" ? "is-next" : "is-prev"}>
                  {view === "month" ? `${MONTHS_FULL[monthAnchor.getMonth()]} ${monthAnchor.getFullYear()}` : fmtRange(weekStart, addDays(weekStart, 4))}
                </span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
              </button>
              {jumpOpen && (
                <JumpPicker value={view === "month" ? monthAnchor : weekStart} mode={view}
                  onPick={jumpTo} onClose={() => setJumpOpen(false)} />
              )}
            </div>
            <button className="cv-nav-arrow" onClick={() => go(1)} aria-label={view === "month" ? "Next month" : "Next week"} title="Next (→)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
            </button>
          </div>
        </div>

        {/* One line of billing figures: the line you pick, for everyone on screen. */}
        <div className="cv-stats">
          <div className="cv-line" ref={lineRef}>
            <button type="button" className={`cv-line-btn ${lineOpen ? "is-open" : ""}`} onClick={() => setLineOpen((v) => !v)} title="Which billing line the figures count">
              {statCur.color && <i className="cv-line-dot" style={{ background: statCur.color }} />}
              {statCur.label}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {lineOpen && (
              <div className="cv-line-pop" role="listbox">
                {statLines.map((l) => (
                  <button key={l.id} type="button" role="option" aria-selected={statId === l.id} className={statId === l.id ? "is-on" : ""}
                    onClick={() => { setStatLine(l.id); setLineOpen(false); try { localStorage.setItem("cal.statLine", l.id); } catch { /* ignore */ } }}>
                    <b>{l.color && <i className="cv-line-dot" style={{ background: l.color }} />}{l.label}</b><small>{l.hint}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          {seenIds.slice(0, 4).map((uid) => {
            const mine = uid === myId;
            const booked = daysOnLine(scopeEntries.filter((e) => e.userId === uid), false);
            const done = daysOnLine(scopeEntries.filter((e) => e.userId === uid), true);
            const goal = mine && statId === "all" ? scopeGoal : 0;
            const pct = goal > 0 ? Math.min(100, (booked / goal) * 100) : 0;
            const dpct = goal > 0 ? Math.min(100, (done / goal) * 100) : 0;
            return (
              <div key={uid} className={`cv-stat ${mine && hasHours ? "is-click" : ""}`} title={`${nameOf(uid) || "You"}: ${booked.toFixed(2)}d booked · ${done.toFixed(2)}d confirmed`}
                onClick={() => mine && hasHours && setShowSplit((v) => !v)}>
                {viewingOther && <i className="cv-stat-dot" style={{ background: colourOf(uid) }} />}
                {viewingOther && <span className="cv-stat-who">{mine ? "You" : (nameOf(uid) || "").split(" ")[0]}</span>}
                <b className={goal > 0 && booked < goal ? "is-under" : ""}><CountUp v={booked} dec={2} /><em>d</em></b>
                {goal > 0 && <small>/ {goal.toFixed(2).replace(/\.00$/, "")}</small>}
                {goal > 0 && <span className="cv-stat-bar"><i className="is-plan" style={{ width: `${pct}%` }} /><i className="is-done" style={{ width: `${dpct}%` }} /></span>}
                {!viewingOther && <span className="cv-stat-sub">{done.toFixed(2).replace(/\.00$/, "")}d confirmed</span>}
                {mine && showSplit && hasHours && (
              <span className="cal-wk-split" role="dialog">
                <span className="cal-wk-split-head">Booked this period</span>
                {hasDays && (
                  <span className="cal-wk-split-row">
                    <em>Day-rate work</em><b>{plannedSplit.days.toFixed(2)}<i>d</i></b>
                  </span>
                )}
                <span className="cal-wk-split-row">
                  <em>Hourly work</em>
                  <b>{plannedSplit.hours.toFixed(2)}<i>h</i></b>
                </span>
                <span className="cal-wk-split-row is-conv">
                  <em>at {hoursPerDay}h per day</em>
                  <b>{(plannedSplit.hours / (hoursPerDay || 8)).toFixed(2)}<i>d</i></b>
                </span>
                <span className="cal-wk-split-row is-total">
                  <em>Total</em><b>{weekPlanned.toFixed(2)}<i>d</i></b>
                </span>
                <span className="cal-wk-split-row is-done">
                  <em>Of which confirmed</em><b>{weekDone.toFixed(2)}<i>d</i></b>
                </span>
              </span>
            )}
              </div>
            );
          })}
          {!viewingOther && (
            <div className="cv-stat is-rev" title={scopeRevenueGoal > 0 ? `${Math.round(revPct)}% of the revenue target` : "Revenue booked"}>
              <b><CountUp v={scopeRevenue} sep /><em>€</em></b>
              {scopeRevenueGoal > 0 && <small>/ {Math.round(scopeRevenueGoal).toLocaleString()}</small>}
              {scopeRevenueGoal > 0 && <span className="cv-stat-bar"><i className="is-done" style={{ width: `${revPct}%` }} /></span>}
            </div>
          )}
          {cutoffInfo && (
            <div className={`cv-stat is-cut ${cutoffInfo.left <= 3 ? "is-hot" : ""}`} title={`Billing for ${cutoffInfo.month} closes ${cutoffInfo.label}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21V4h11l-1.5 4H20l-1.5 4H15v9" /></svg>
              <span>{cutoffInfo.left === 0 ? "Closes today" : cutoffInfo.left > 0 ? `${cutoffInfo.left}d to cutoff` : "Closed"}</span>
            </div>
          )}
        </div>

        <div className="cv-r">
          {people.length > 1 && (
            <div className="cal-who" ref={whoRef}>
              <button type="button" className={`cal-who-btn ${whoOpen ? "is-open" : ""}`}
                onClick={() => setWhoOpen((v) => !v)} aria-expanded={whoOpen}>
                <span className="cal-who-stack">
                  {seenIds.slice(0, 4).map((uid, i) => (
                    <i key={uid} style={{ background: colourOf(uid), zIndex: 4 - i }}>
                      {(uid === myId ? "You" : nameOf(uid) || "?").slice(0, 1).toUpperCase()}
                    </i>
                  ))}
                </span>
                <span className="cal-who-txt">
                  <b>{alsoView.length === 0 ? "My calendar" : `You + ${alsoView.length}`}</b>
                  {viewingOther && <em>{alsoView.length + 1} calendars</em>}
                </span>
                <svg className="cal-who-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
              </button>

              {whoOpen && (
                <div className="cal-who-pop" role="listbox" aria-multiselectable="true">
                  <p className="cal-who-hint">Lay up to three colleagues over your week</p>
                  {people.map((pp, i) => {
                    const on = seenIds.includes(pp.id);
                    const full = !on && alsoView.length >= 3 && pp.id !== myId;
                    return (
                      <button key={pp.id} type="button" role="option" aria-selected={on}
                        className={`cal-who-opt ${on ? "is-on" : ""} ${full ? "is-full" : ""}`}
                        style={{ animationDelay: `${i * 22}ms` }}
                        disabled={full}
                        onClick={() => toggleView(pp.id)}>
                        <span className="cal-who-opt-av"
                          style={on ? { background: colourOf(pp.id), color: "#fff" } : undefined}>
                          {(pp.name || "?").slice(0, 1).toUpperCase()}
                        </span>
                        <span className="cal-who-opt-txt">
                          <b>{pp.id === myId ? `${pp.name} (you)` : pp.name}</b>
                          <em>{pp.id === myId ? "always shown" : pp.role.replace(/_/g, " ")}</em>
                        </span>
                        {on && (
                          <svg className="cal-who-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <div className="cv-icons">
          <button type="button" className={`cal-gear cal-olbtn ${olOn ? "is-on" : ""} ${olOn && !ol.loading && (ol.error || !ol.connected) ? "is-warn" : ""}`} onClick={(x) => toggleOl(x.currentTarget.getBoundingClientRect())} aria-pressed={olOn}
            title={!olOn ? "Show your Outlook events" : !ol.connected ? "Outlook isn't connected — connect it in Settings" : ol.error ? `Outlook: ${ol.error}` : `Showing ${olShown.length} Outlook event${olShown.length === 1 ? "" : "s"} · click to hide`}>
            <OlGlyph s={16} />
            {olOn && ol.connected && !ol.error && olShown.length > 0 && <span className="cal-olbtn-n">{olShown.length}</span>}
          </button>
          <div className="cal-bell-wrap" ref={bellRef}>
          <button className="cal-bell" onClick={() => setTrayOpen((v) => !v)}
            aria-label={`${invites.length} invitations`} title="Invitations">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>
            {invites.length + unseenReplies > 0 && (
              <span className="cal-bell-dot">{invites.length + unseenReplies}</span>
            )}
          </button>
          {trayOpen && (
            <InvitesTray invites={invites} userId={myId}
              unit={(pid) => (pid && hourProjects.has(pid) ? "h" : "d")}
              workTypes={workTypes.map((w) => ({ id: w.id, name: w.name, color: w.color }))}
              onChanged={() => {
                loadMyInvites(myId).then(setInvites).catch(() => {});
                loadMyReplies(myId).then((rs) => setUnseenReplies(rs.filter((r) => !r.seen).length)).catch(() => {});
                // Accepting adds an entry to the week, so the grid reloads too.
                setReloadKey((k) => k + 1);
              }}
              onClose={() => { setTrayOpen(false); setUnseenReplies(0); }} />
          )}
        </div>
          <button className="cal-btn cal-gear" onClick={() => setShowSettings(true)} aria-label="My time off" title="My time off — ask for holidays">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          </div>
          <button className={`cv-todo-btn ${todoOpen ? "is-on" : ""}`} onClick={toggleTodo} title={todoOpen ? "Hide your to-do" : "Show your to-do"} aria-pressed={todoOpen}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg>
            To-do
          </button>
        </div>
      </header>

      <div className={`cv-main ${todoOpen ? "has-todo" : ""}`}>
      <section className="cv-cal">
{view === "month" ? (
      <div key={`m-${monthAnchor.getFullYear()}-${monthAnchor.getMonth()}`} className={`cal-month ${dirClass}`}>
          <div className="cal-month-head">
            {DOW.map((n) => (<div className="cal-month-dow" key={n}>{n}</div>))}
          </div>
          <div className="cal-month-body">
        {monthMatrix(monthAnchor).map((row, ri) => (
              <div className="cal-month-row" key={ri}>
                {row.map((d, ci) => {
              const inMonth = d.getMonth() === monthAnchor.getMonth();
                  const dayList = entries.filter((e) => e.dateKey === dateKey(d));
                  const planned = billableOf(dayList);
                  const under = planned < targets.minPerDay;
                  const isCutoff = isoOf(d) === cutoffOf(periodOf(d), cutoffs, defaultCutoffDay);
                  return (
                    <div
                      className={`cal-mcell ${inMonth ? "" : "is-out"} ${sameDay(d, today) ? "is-today" : ""} ${isCutoff ? "is-cutoff" : ""}`}
                      key={d.toISOString()}
                      style={{ ["--i" as string]: ri * 5 + ci }}
                      onClick={() => openNew(d, 9)}
                    >
                      <span className="cv-madd" aria-hidden="true">+</span>
                      {inMonth && dayList.length > 0 && (
                        <span className={`cv-mload ${under ? "is-under" : ""}`}>
                          <i style={{ width: `${Math.min(100, (planned / (targets.minPerDay || 1)) * 100)}%` }} />
                        </span>
                      )}
                      <div className="cal-mcell-head">
                        <span className="cal-mcell-date">{d.getDate()}</span>
                        {isCutoff && (
                          <span className="cal-mcell-cutoff" title={`Billing closes this day for ${periodOf(d)}`}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M4 21V4h11l-1.5 4H20l-1.5 4H15v9" />
                            </svg>
                          </span>
                        )}
                        {dayList.length > 0 && (
                          <span className={`cal-mcell-sum ${under ? "is-under" : ""}`}>{num2(planned)}d</span>
                        )}
                      </div>
                      <div className="cal-mcell-list">
                        {dayList
                          .slice()
                          .sort((a, b) => a.startMin - b.startMin)
                          .map((e) => {
                            const wt = workTypes.find((t) => t.id === e.type);
                            return (
                              <button
                                key={e.id}
                               className={`cal-mchip is-${e.status} ${noCount(e) ? "is-connector" : ""}`}
                                style={{ ["--ec" as string]: bgOf(e.userId, wt?.color), ...(noCount(e) ? noCountStyle(e) : {}) }}
                                onClick={(ev) => { ev.stopPropagation(); if (!opaque(e.userId) && e.merged === 1) openEdit(d, e); }}
                                title={`${fmtTime(e.startMin)} – ${fmtTime(e.endMin)}`}
                              >
                                <span className="cal-mchip-time">{fmtTime(e.startMin).replace(":00", "")}</span>
                                <span className="cal-mchip-name">
                                  {e.clientId ? clientNames[e.clientId] ?? "—" : wt?.name ?? "Meeting"}
                                </span>
                              </button>
                            );
                          })}
                        {olShown.map((ev) => ({ ev, on: outlookOnDay(ev, d) })).filter((x) => x.on).map(({ ev, on }) => (
                          <button key={`ol-${ev.id}`} className="cal-mchip is-ol" title={`${ev.subject} · Outlook`} style={{ ["--ec" as string]: "#8796a1" }}
                            onClick={(x) => { x.stopPropagation(); setOlPick({ ev, anchor: x.currentTarget.getBoundingClientRect() }); }}>
                            <span className="cal-mchip-time">{on === "allday" ? <OlGlyph s={10} /> : fmtTime((on as { startMin: number }).startMin).replace(":00", "")}</span>
                            <span className="cal-mchip-name">{ev.subject}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : (
      <div
        className="cal-grid"
        /* 56px an hour keeps rows readable whatever window is configured. */
        style={{ ["--cal-h" as string]: `${Math.max(560, HOURS.length * 56)}px` }}
      >
        <div className="cal-corner" />

        <div key={`h-${animKey}`} className={`cal-head-days ${dirClass}`}>
          {days.map((d, i) => {
            const isCutoff = isoOf(d) === cutoffOf(periodOf(d), cutoffs, defaultCutoffDay);
            return (
            <div className={`cal-head-day ${sameDay(d, today) ? "is-today" : ""} ${isCutoff ? "is-cutoff" : ""}`} key={d.toISOString()}>
              {isCutoff && (
                <span className="cal-cutoff-flag" title={`Billing closes this day for ${periodOf(d)}`}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 21V4h11l-1.5 4H20l-1.5 4H15v9" />
                  </svg>
                  <em>Billing cutoff</em>
                </span>
              )}
{(() => {
                const dayList = entries.filter((e) => e.dateKey === dateKey(d) && e.userId === myId);
                const planned = billableOf(dayList);
                const done = confirmedOf(dayList);
                const goal = targets.minPerDay || 1;
                const under = targets.minPerDay > 0 && planned < targets.minPerDay;
                return (
                  <>
                    <span className="cv-hd-date">{d.getDate()}</span>
                    <span className="cv-hd-txt">
                      <span className="cal-dow">
                        {DOW[i]}
                        {hoursByDay[d.getDay()]?.remote && <em className="cv-hd-tag" title="Remote day">Remote</em>}
                      </span>
                      <span className={`cv-hd-load ${under ? "is-under" : ""}`} title={`${num2(planned)}d planned · ${num2(done)}d confirmed · min ${targets.minPerDay}d`}>
                        <span className="cv-hd-bar">
                          <i className="is-plan" style={{ width: `${Math.min(100, (planned / goal) * 100)}%` }} />
                          <i className="is-done" style={{ width: `${Math.min(100, (done / goal) * 100)}%` }} />
                        </span>
                        <b>{num2(planned)}</b><em>/{num2(goal)}d</em>
                      </span>
                    </span>
                  </>
                );
              })()}
            </div>
            );
          })}
        </div>

        <div className="cal-times">
          {HOURS.map((h) => (
            <div className="cal-time" key={h}>
              <span>{fmtHour(h)}</span>
            </div>
          ))}
        </div>

        <div key={`b-${animKey}`} className={`cal-days ${dirClass}`}>
          {days.map((d) => {
            const isToday = sameDay(d, today);
            const key = dateKey(d);
            const iso = isoOf(d);
            const holidayName = holidaySet.get(iso);
            const isVacation = vacationSet.has(iso);
            // Outlook events of the day: timed ones inside the window share the lanes with your entries
            // (their own column when colleagues are laid over); all-day and out-of-hours ones become tags.
            const olToday = olShown.map((ev) => ({ ev, on: outlookOnDay(ev, d) })).filter((x) => x.on);
            const olTags = olToday.filter((x) => x.on === "allday" || (x.on as { endMin: number }).endMin <= DAY_START || (x.on as { startMin: number }).startMin >= DAY_END);
            const olCells: OlCell[] = olToday.filter((x) => !olTags.includes(x)).map(({ ev, on }) => {
              const o = on as { startMin: number; endMin: number };
              const st = Math.max(DAY_START, o.startMin);
              return { id: `ol:${ev.id}`, startMin: st, endMin: Math.max(st + 15, Math.min(DAY_END, o.endMin)), userId: viewingOther ? "__outlook" : myId, dateKey: key, ol: ev };
            });
            const dayEntries = laidOut<Entry | OlCell>([...entries.filter((e) => e.dateKey === key), ...olCells], viewingOther ? [...seenIds, "__outlook"] : seenIds);
            return (
             <div
                className={`cal-col ${isToday ? "is-today" : ""} ${dragging ? "is-drop" : ""} ${holidayName != null ? "is-holiday" : ""} ${isVacation ? "is-vacation" : ""} ${hoursByDay[d.getDay()]?.remote ? "is-remote" : ""}`}
                key={d.toISOString()}
                onDragOver={(ev) => { if (dragging) { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; } }}
                onDrop={(ev) => {
                  if (!dragging) return;
                  ev.preventDefault();
                  const rect = ev.currentTarget.getBoundingClientRect();
                  const pct = (ev.clientY - rect.top) / rect.height;
                  const raw = DAY_START + pct * SPAN - dragging.grabMin;
                  const snapped = Math.round(raw / 15) * 15;
                  moveEntry(dragging.id, d, snapped);
                  setDragging(null);
                  setGhost(null);
                }}
                onDragOverCapture={(ev) => {
                  if (!dragging) return;
                  const ent = entries.find((x) => x.id === dragging.id);
                  if (!ent) return;
                  const len = ent.endMin - ent.startMin;
                  const r = ev.currentTarget.getBoundingClientRect();
                  const raw = DAY_START + ((ev.clientY - r.top) / r.height) * SPAN - dragging.grabMin;
                  const m = Math.max(DAY_START, Math.min(DAY_END - len, Math.round(raw / 15) * 15));
                  if (!ghost || ghost.key !== key || ghost.cur !== m) setGhost({ key, anchor: m, cur: m, drag: false, len });
                }}
                onMouseDown={(ev) => {
                  if (ev.button !== 0 || dragging || (ev.target as HTMLElement).closest(".cal-event, .cal-daytag, .cal-ol, .cal-oltags")) return;
                  ev.preventDefault();
                  const m = minAt(ev.currentTarget, ev.clientY);
                  setGhost({ key, anchor: m, cur: m, drag: true });
                }}
                onMouseMove={(ev) => {
                  if (dragging) return;
                  if ((ev.target as HTMLElement).closest(".cal-event, .cal-ol, .cal-oltags")) { if (ghost && !ghost.drag) setGhost(null); return; }
                  const m = minAt(ev.currentTarget, ev.clientY);
                  if (ghost?.drag) { if (ghost.key === key && ghost.cur !== m) setGhost({ ...ghost, cur: m }); return; }
                  if (!ghost || ghost.key !== key || ghost.cur !== m) setGhost({ key, anchor: m, cur: m, drag: false });
                }}
                onMouseUp={(ev) => {
                  if (!ghost?.drag || ghost.key !== key) return;
                  ev.stopPropagation();
                  const [s0, e0] = ghostRange(ghost);
                  setGhost(null);
                  openRange(d, s0, ghost.cur === ghost.anchor ? Math.min(DAY_END, s0 + 60) : e0);
                }}
                onMouseLeave={() => { if (ghost && !ghost.drag && ghost.key === key) setGhost(null); }}
              >
                {(holidayName != null || isVacation) && (
                  <span className={`cal-daytag ${isVacation ? "is-vac" : "is-hol"}`}>
                    {isVacation ? "Vacation" : (holidayName || "Holiday")}
                  </span>
                )}
                {olTags.length > 0 && (
                  <span className={`cal-oltags ${holidayName != null || isVacation ? "is-low" : ""}`}>
                    {olTags.slice(0, 3).map(({ ev, on }) => (
                      <button type="button" key={ev.id} className="cal-oltag" title={`${ev.subject} · ${on === "allday" ? "All day" : `${outlookTime(ev.start)} – ${outlookTime(ev.end)}`} · Outlook`}
                        onClick={(x) => { x.stopPropagation(); setOlPick({ ev, anchor: x.currentTarget.getBoundingClientRect() }); }}>
                        <OlGlyph s={10} />{on === "allday" ? "" : <b>{outlookTime(ev.start)}</b>}<span>{ev.subject}</span>
                      </button>
                    ))}
                    {olTags.length > 3 && <em>+{olTags.length - 3}</em>}
                  </span>
                )}
                {/* Shading straight from the configured hours: outside the
                    working window, and the lunch break. */}
                {(() => {
                  const hd = hoursByDay[d.getDay()];
                  if (!hd) return null;
                  const p = (m: number) => ((m - DAY_START) / SPAN) * 100;
                  if (hd.closed) return <span className="cal-off is-closed" style={{ top: 0, height: "100%" }} />;
                  return (
                    <>
                      {hd.work_from > DAY_START && (
                        <span className="cal-off" style={{ top: 0, height: `${p(hd.work_from)}%` }} />
                      )}
                      {hd.work_to < DAY_END && (
                        <span className="cal-off" style={{ top: `${p(hd.work_to)}%`, height: `${100 - p(hd.work_to)}%` }} />
                      )}
                      {hd.lunch_from != null && hd.lunch_to != null && (
                        <span className="cal-lunch"
                          style={{ top: `${p(hd.lunch_from)}%`, height: `${p(hd.lunch_to) - p(hd.lunch_from)}%` }} />
                      )}
                    </>
                  );
                })()}

                {HOURS.map((h) => (
                  <button
                    className="cal-slot"
                    key={h}
                    onClick={() => openNew(d, h)}
                    aria-label={`Add entry at ${fmtHour(h)}`}
                  />
                ))}

                {nowVisible && days.some((x) => sameDay(x, today)) && (
                  <span className={`cal-now ${isToday ? "" : "is-faint"}`} style={{ top: `${nowPct}%` }}>
                    {isToday && <em>{fmtTime(nowMin)}</em>}
                  </span>
                )}

                {ghost && ghost.key === key && (() => {
                  const [gs, ge] = ghostRange(ghost);
                  const short = ghost.cur === ghost.anchor && !ghost.len ? Math.min(DAY_END, gs + 60) : ge;
                  return (
                    <span className={`cv-ghost ${ghost.drag ? "is-drag" : ""} ${ghost.len ? "is-move" : ""}`}
                      style={{ top: `${((gs - DAY_START) / SPAN) * 100}%`, height: `${((short - gs) / SPAN) * 100}%` }}>
                      <b>{ghost.len ? "Move here" : ghost.drag ? "New entry" : "+ Add"}</b>
                      <em>{fmtTime(gs)} – {fmtTime(short)} · {durLabel(short - gs)}</em>
                    </span>
                  );
                })()}

                {dayEntries.map((e, ei) => {
                  if ("ol" in e) {
                    const top = ((e.startMin - DAY_START) / SPAN) * 100;
                    const height = ((e.endMin - e.startMin) / SPAN) * 100;
                    const ev = e.ol;
                    return (
                      <div key={e.id} className={`cal-ol ${e.endMin - e.startMin <= 45 ? "is-short" : ""} ${e.merged > 1 ? "is-merged" : ""} is-${ev.showAs}`}
                        style={{ top: `${top}%`, height: `${height}%`, left: `calc(${e.left}% + 2px)`, width: `calc(${e.width}% - 4px)`, zIndex: 2 + e.lane, ["--i" as string]: ei }}
                        role="button" tabIndex={0} title={`${ev.subject} · Outlook`}
                        onMouseDown={(x) => x.stopPropagation()}
                        onClick={(x) => { x.stopPropagation(); setOlPick({ ev, anchor: x.currentTarget.getBoundingClientRect() }); }}
                        onKeyDown={(x) => { if (x.key === "Enter") setOlPick({ ev, anchor: x.currentTarget.getBoundingClientRect() }); }}>
                        <span className="cal-ol-title"><OlGlyph s={11} />{e.merged > 1 ? `${e.merged} in Outlook` : ev.subject}</span>
                        <span className="cal-ol-time">{fmtTime(e.startMin)} – {fmtTime(e.endMin)}{e.merged === 1 && ev.location ? ` · ${ev.location}` : ""}</span>
                      </div>
                    );
                  }
                  const top = ((e.startMin - DAY_START) / SPAN) * 100;
const height = ((e.endMin - e.startMin) / SPAN) * 100;
const wt = workTypes.find((t) => t.id === e.type);
                    return (
<div
                      key={e.id}
                 className={`cal-event is-${e.status} ${e.endMin - e.startMin <= 60 ? "is-short" : ""} ${dragging?.id === e.id ? "is-lifted" : ""} ${noCount(e) ? "is-connector" : ""} ${e.line === "closure" ? "is-closure" : ""} ${opaque(e.userId) || e.merged > 1 ? "is-opaque" : ""}`}
                      style={{
                        top: `${top}%`, height: `${height}%`,
                        left: `calc(${e.left}% + 2px)`,
                        width: `calc(${e.width}% - 4px)`,
                        zIndex: 2 + e.lane,
                        ["--ec" as string]: bgOf(e.userId, wt?.color),
                        ["--i" as string]: ei,
                        ...(noCount(e) ? noCountStyle(e) : {}),
                      }}
                      title={viewingOther ? nameOf(e.userId) : undefined}
                      data-shared={attendees[e.id]?.length ? "1" : undefined}
onClick={(ev) => { ev.stopPropagation(); if (!opaque(e.userId) && e.merged === 1) openEdit(d, e); }}
                      role="button"
                      tabIndex={0}
                      draggable
                      onDragStart={(ev) => {
                        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                        const offsetPct = (ev.clientY - rect.top) / rect.height;
                        setDragging({ id: e.id, grabMin: Math.round(offsetPct * (e.endMin - e.startMin)) });
                        ev.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => { setDragging(null); setGhost(null); }}
                    >
{(attendees[e.id]?.length ?? 0) > 0 && (() => {
                        const who = attendees[e.id];
                        const waiting = who.some((a) => a.status === "pending");
                        const refused = who.some((a) => a.status === "declined");
                        return (
                          <span className={`cal-ev-with ${refused ? "is-declined" : waiting ? "is-waiting" : "is-set"}`}
                            title={who.map((a) => `${a.name}: ${a.status}`).join("\n")}>
                            {who.slice(0, 3).map((a) => (
                              <i key={a.invitee_id} className={`is-${a.status}`}>{a.name.charAt(0).toUpperCase()}</i>
                            ))}
                            {who.length > 3 && <u>+{who.length - 3}</u>}
                          </span>
                        );
                      })()}

                      <span className="cal-event-head">
                        <span className="cal-event-title">
                          {e.merged > 1
                            ? `Busy · ${e.merged}`
                            : opaque(e.userId)
                              ? "Busy"
                              : e.clientId ? clientNames[e.clientId] ?? "—" : wt?.name ?? "Meeting"}
                        </span>
                        {!opaque(e.userId) && e.merged === 1 && <span className="cal-event-bill">{num2(e.billable)}{unitOf(e)}</span>}
                      </span>
                      <span className="cal-event-time" data-role={noCount(e) ? (roleOf(e)?.name ?? "Not on target").toUpperCase() : undefined}>
                        {MEET_ICON[e.meetKind ?? ""] && !opaque(e.userId) && e.merged === 1 && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={MEET_ICON[e.meetKind ?? ""]} /></svg>
                        )}
                        {fmtTime(e.startMin)} – {fmtTime(e.endMin)}
                        {e.seriesId && !opaque(e.userId) && e.merged === 1 && (
                          <svg className="cal-event-rep" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-label="Repeats"><title>{series[e.seriesId] ? `Repeats · ${repeatLabel(ruleOfSeries(series[e.seriesId]))}` : "Repeats"}</title><path d={REP_ICON} /></svg>
                        )}
                      </span>
                      {!opaque(e.userId) && e.merged === 1 && (e.clientId && wt?.name || e.notes) && (
                        <span className="cal-event-meta">{[e.clientId ? wt?.name : "", e.notes].filter(Boolean).join(" · ")}</span>
                      )}
{actuals[e.id] && <span className="cal-event-actual" title="Actuals logged">⏱</span>}
                      {(e.status === "confirmed" || e.status === "cancelled") && (
                        <span className="cal-event-flag">{e.status === "confirmed" ? "✓" : "✕"}</span>
                      )}
                      {/* Confirming, cancelling and logging actuals belong to
                          whoever booked it. */}
                      {e.userId === myId && e.merged === 1 && (
                      <span className="cal-event-actions">
                        <button className="cal-ev-btn is-ok" title="Took place"
                          onClick={(ev) => { ev.stopPropagation(); setStatus(e.id, "confirmed"); }}>✓</button>
<button className="cal-ev-btn is-no" title="Did not take place"
                          onClick={(ev) => { ev.stopPropagation(); setStatus(e.id, "cancelled"); }}>✕</button>
                        <button className="cal-ev-btn is-log" title="Log what actually happened"
                          onClick={(ev) => { ev.stopPropagation(); setActualFor(e); }}>⏱</button>
                      </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
</div>
      </div>
      )}
      </section>
      <aside className="cv-todo" aria-label="Your to-do" aria-hidden={!todoOpen}>
        <div className="cv-todo-in">{(todoOpen || todoSeen) && <TicketDesk startKind="task" />}</div>
      </aside>
      </div>

{olInfo && (
        <OutlookStatusCard anchor={olInfo} connected={ol.connected} error={ol.error}
          onRetry={() => { setOlInfo(null); ol.reload(); }} onConnect={() => { setOlInfo(null); navigate("/settings"); }}
          onHide={() => { setOlInfo(null); setOlShown(false); }} onClose={() => setOlInfo(null)} />
      )}
{olPick && (
        <OutlookCard ev={olPick.ev} anchor={olPick.anchor} logLabel="Log it as work" onLog={() => logOutlook(olPick.ev)} onClose={() => setOlPick(null)} />
      )}

{actualFor && (
        <ActualModal
          planned={{ startMin: actualFor.startMin, endMin: actualFor.endMin, billable: actualFor.billable }}
          existing={actuals[actualFor.id] ?? null}
          onSave={(v) => saveActual(actualFor.id, v)}
          onClear={actuals[actualFor.id] ? () => clearActual(actualFor.id) : undefined}
          onClose={() => setActualFor(null)}
        />
      )}

      {shared && (
        <SharedBookingView entryId={shared.id} inviteId={shared.inviteId}
          onLeft={() => setReloadKey((k) => k + 1)}
          onClose={() => setShared(null)} />
      )}

      {showSettings && (
        <CalendarSettingsModal types={workTypes} setTypes={setWorkTypes} targets={targets} setTargets={setTargets} hideTargets cutoffs={cutoffs} setCutoffs={setCutoffs} defaultCutoffDay={defaultCutoffDay} setDefaultCutoffDay={setDefaultCutoffDay} holidays={holidays.map((h) => h.date)} onAddHoliday={addHoliday} onRemoveHoliday={removeHoliday} vacationAllowance={vacationAllowance} setVacationAllowance={setVacationAllowance} canEditTimeOff={role === "boss"} requestOnly onOpenSetup={() => { setShowSettings(false); navigate("/settings", { state: { settingsView: "calendarpage" } }); }} onClose={closeSettings} />
      )}

      {modal && (
<BookingModal
          day={modal.day}
          editing={!!modal.editingId}
          entryId={modal.editingId ?? null}
          types={workTypes}
initial={{
            startMin: modal.startMin,
            endMin: modal.endMin,
            type: modal.type,
            billable: modal.billable,
          clientId: modal.clientId,
            projectId: modal.projectId,
            phaseId: modal.phaseId,
taskId: modal.taskId,
attendees: modal.attendees,
            notes: modal.notes,
            line: modal.line,
            roleId: modal.roleId,
            meetKind: modal.meetKind,
            repeat: modal.repeat ?? null,
          }}
          inSeries={!!modal.editingId && !!modal.seriesId}
          onSave={saveModal}
          onDelete={modal.editingId ? deleteModal : undefined}
          onClose={() => setModal(null)}
        />
      )}

      {closedNotice && (
        <div className="cal-closed-backdrop" onMouseDown={() => setClosedNotice(null)}>
          <div className="cal-closed" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true">
            <div className="cal-closed-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="10" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <h3 className="cal-closed-title">
              {closedNotice.reason === "invoiced" ? "That month is already billed" : "That month is already closed"}
            </h3>
            <p className="cal-closed-text">
              {closedNotice.reason === "invoiced" ? (
                <>This client's invoice for <b>{closedNotice.monthName}</b> has already been sent, so billable
                work dated <b>{closedNotice.iso}</b> can't be added to it — it would change an invoice that's
                already gone out.</>
              ) : (
                <>The billing period for <b>{closedNotice.monthName}</b> has already closed (its cut-off has
                passed), so billable work dated <b>{closedNotice.iso}</b> can't be added to it.</>
              )}
            </p>
            <p className="cal-closed-text cal-closed-muted">
              Log it in the current open period instead. Billing has been notified of this attempt and can
              re-open {closedNotice.monthName} if it really belongs there.
            </p>
            <div className="cal-closed-actions">
              <button className="cal-closed-ok" onClick={() => setClosedNotice(null)}>Got it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}