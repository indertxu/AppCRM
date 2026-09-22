import { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import BookingModal from "./BookingModal";
import CalendarSettingsModal, { type WorkTypeDef, type Targets } from "./CalendarSettingsModal";
import { useAuth } from "../../api/AuthProvider";
import InvitesTray from "./InvitesTray";
import SharedBookingView from "./SharedBookingView";
import { loadMyInvites, syncInvites, loadAttendees, loadMyReplies,
  type InviteCard, type Attendee } from "./invitesApi";
import type { Cutoffs } from "./billingPeriods";
import { cutoffOf, periodOf, inBillingMonth } from "./billingPeriods";
import { effectiveRate, effectiveSupervisionRate } from "../clients/ClientsPage";
import ActualModal, { type ActualValue } from "./ActualModal";
import { supabase } from "../../api/supabase";
import { syncEntryToOutlook, deleteEntryFromOutlook } from "../../api/outlookSync";
import "./CalendarPage.css";

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
}

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
}
export default function CalendarPage() {
  const navigate = useNavigate();
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [dir, setDir] = useState<1 | -1>(1);
  const [entries, setEntries] = useState<Entry[]>([]);
const [modal, setModal] = useState<ModalState | null>(null);
const [showSettings, setShowSettings] = useState(false);
const [dragging, setDragging] = useState<{ id: string; grabMin: number } | null>(null);
const [view, setView] = useState<"week" | "month">("week");
  const [actuals, setActuals] = useState<Record<string, ActualValue>>({});
  const [actualFor, setActualFor] = useState<Entry | null>(null);
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => new Date());
const [workTypes, setWorkTypes] = useState<WorkTypeDef[]>([]);
const [clientNames, setClientNames] = useState<Record<string, string>>({});
const [targets, setTargets] = useState<Targets>({ perDay: 1, minPerDay: 0.5, minPerWeek: 3, minPerMonth: 12, minRevenueMonth: 0 });
  const [cutoffs, setCutoffs] = useState<Cutoffs>({});
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
  const [rates, setRates] = useState<Record<string, { consultor: number; supervision: number; connector: number }>>({});
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
      setEntries((ce ?? []).map((r: Record<string, unknown>) => ({
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
        inviteId: (r.invite_id as string) ?? null,
      })));

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

      const { data: pj } = await supabase.from("projects").select("id, price_per_day, supervision_price, discount_mode, discount_value");
      setRates(Object.fromEntries(((pj ?? []) as Record<string, unknown>[]).map((r) => {
        const base = Number(r.price_per_day) || 0;
        const sup = Number(r.supervision_price) || 0;
        const d = Number(r.discount_value) || 0;
        const mode = r.discount_mode as string;
        const cons = effectiveRate(base, mode, d);
        return [r.id as string, {
          consultor: cons,
          connector: cons, // connector bills at the consultancy day rate
          supervision: effectiveSupervisionRate(sup, mode, d),
        }];
      })));

      const { data } = await supabase.from("work_types").select("*").order("created_at");
      setWorkTypes((data ?? []).map((r: { id: string; name: string | null; client_related: boolean; color: string | null }) => ({
        id: r.id,
        name: r.name ?? "",
        clientRelated: !!r.client_related,
        color: r.color ?? "#12b57f",
      })));

      const { data: bp } = await supabase.from("billing_periods").select("period, cutoff_date");
      if (bp) setCutoffs(Object.fromEntries((bp as { period: string; cutoff_date: string }[]).map((r) => [r.period, r.cutoff_date])));
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
    // Targets are managed in Management now, not here.
    // Billing cutoffs: replace the whole set + default day.
    await supabase.from("billing_settings").upsert({ id: "default", default_cutoff_day: defaultCutoffDay, vacation_days_per_year: vacationAllowance });
    const rows = Object.entries(cutoffs).map(([period, cutoff_date]) => ({ period, cutoff_date }));
    if (rows.length) await supabase.from("billing_periods").upsert(rows);
    setShowSettings(false);
  };

  const today = new Date();
  const days = useMemo(
    () => Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

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

const goToday = () => {
    setMonthAnchor(new Date());
    const t = startOfWeek(new Date());
    setDir(t.getTime() < weekStart.getTime() ? -1 : 1);
    setWeekStart(t);
  };

  const openNew = (day: Date, hour: number) => {
    // Booking while looking at other calendars is the point of looking: the
    // entry is yours, since your own week is always one of the ones on screen.
    const startMin = hour * 60;
    const endMin = Math.min(hour * 60 + 60, DAY_END);
    const billable = Math.max(0.25, Math.round((endMin - startMin) / 60 / 0.25) * 0.25);
setModal({ day, startMin, endMin, type: workTypes[0]?.id ?? "", billable, clientId: "", projectId: "", phaseId: "", taskId: "", attendees: "", notes: "", line: "", roleId: "" });
  };
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
    });
  };
const saveModal = (v: {
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
    summoned?: { id: string; billable: number }[];
    summonNote?: string;
  }) => {
if (!modal) return;
    const key = dateKey(modal.day);
    const id = modal.editingId ?? crypto.randomUUID();
    const d = modal.day;
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u?.user) { alert("Not signed in."); return; }
      // The type must be one the DB actually knows about, or the FK rejects it.
      if (v.type && !workTypes.some((t) => t.id === v.type)) {
        console.warn("Booking used an unknown work_type_id:", v.type, "known:", workTypes.map((t) => t.id));
        alert("This booking's type of work no longer exists. Pick a type again in the booking, then save.");
        return;
      }
      const { error } = await supabase.from("calendar_entries").upsert({
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
      });
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
        ).catch(() => {});
      }

      setEntries((list) =>
        modal.editingId
          ? list.map((e) => (e.id === id ? { ...e, ...v, dateKey: key } : e))
        : [...list, { id, dateKey: key, ...v, status: "planned" }]
      );
      setModal(null);

      // One-way Outlook sync (no-op if the consultant hasn't connected Outlook).
      const existing = entries.find((e) => e.id === id) as any;
      const wtName = workTypes.find((t) => t.id === v.type)?.name ?? "";
      const outlookEventId = await syncEntryToOutlook({
        outlookEventId: existing?.outlookEventId ?? null,
        date: iso,
        startMin: v.startMin,
        endMin: v.endMin,
        workType: wtName,
        client: v.clientId ? clientNames[v.clientId] ?? "" : "",
        project: v.projectId || "",
        phase: v.phaseId || "",
        tasks: v.taskId || "",
        notes: v.notes || "",
      });
      if (outlookEventId) {
        await supabase.from("calendar_entries").update({ outlook_event_id: outlookEventId }).eq("id", id);
        setEntries((list) => list.map((e) => (e.id === id ? { ...e, outlookEventId } as any : e)));
      }
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
  };

  const deleteModal = async () => {
    if (!modal?.editingId) return;
    const entry = entries.find((e) => e.id === modal.editingId) as any;
    const { error } = await supabase.from("calendar_entries").delete().eq("id", modal.editingId);
    if (error) { alert(`Could not delete: ${error.message}`); return; }
    setEntries((list) => list.filter((e) => e.id !== modal.editingId));
    setModal(null);
    // Remove the matching Outlook event (best-effort, no-op if not connected).
    if (entry?.outlookEventId) await deleteEntryFromOutlook(entry.outlookEventId);
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
const billableOf = (list: Entry[]) =>
    list.filter((e) => clientTypeIds.has(e.type) && e.status !== "cancelled" && e.line !== "connector")
        .reduce((s, e) => s + effDays(e), 0);
  const confirmedOf = (list: Entry[]) =>
    list.filter((e) => clientTypeIds.has(e.type) && e.status === "confirmed" && e.line !== "connector")
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
      clientTypeIds.has(e.type) && e.line !== "connector"
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

  /** Per-day rate for an entry, picking supervision/connector/consultancy. */
  const rateOf = (e: Entry) => {
    const r = rates[e.projectId];
    if (!r) return 0;
    if (e.line === "supervision") return r.supervision;
    if (e.line === "connector") return r.connector;
    return r.consultor;
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
  const trackPct = trackBase > 0 ? Math.min(100, (weekPlanned / trackBase) * 100) : 0;
  const trackDonePct = trackBase > 0 ? Math.min(100, (weekDone / trackBase) * 100) : 0;
  const weekPct = scopeGoal > 0 ? Math.min(100, (weekPlanned / scopeGoal) * 100) : 0;
  const weekDonePct = scopeGoal > 0 ? Math.min(100, (weekDone / scopeGoal) * 100) : 0;

  const holidaySet = new Map(holidays.map((h) => [h.date, h.name]));
  const vacationSet = new Set(vacations.map((v) => v.date));

  /** Toggle a vacation day for the current user. */
  const vacationsUsed = vacations.length;

  const dirClass = dir === 1 ? "slide-next" : "slide-prev";
  const animKey = weekStart.getTime();

  // Minutes since midnight for "now", placed on the same DAY_START..DAY_END grid
  // the hour rows and events use. Using a different base (e.g. a hardcoded 5 AM)
  // shifts the line by however far DAY_START is from that base.
  const nowMin = today.getHours() * 60 + today.getMinutes();
  const nowVisible = nowMin >= DAY_START && nowMin <= DAY_END;
  const nowPct = ((nowMin - DAY_START) / SPAN) * 100;

  return (
    <div className="cal">
      <div className="cal-scan-wrap" aria-hidden="true">
        <div className="cal-scan" />
      </div>

<header className="cal-bar">
        <div className="cal-bar-left">
          <button className="cal-home" onClick={() => navigate("/home")} aria-label="Back to home" title="Home">‹</button>
          <h1 className="cal-title">Calendar</h1>
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
        </div>
        <div className="cal-week-bar">
          {/* Measured against the target when there is one; against what is
              booked when there is not, so the bar always means something. */}
          {/* One figure, always in days. Hourly work is converted with the
              hours-per-day setting, so the total is directly comparable to the
              goal. The days/hours split is a click away rather than inline. */}
          <span className="cal-wk-main">
            <b className={scopeGoal > 0 && weekPlanned < scopeGoal ? "is-under" : ""}>
              {weekPlanned.toFixed(2)}<i>d</i>
            </b>
            {scopeGoal > 0 && (
              <span className="cal-wk-goal">/ {scopeGoal.toFixed(2).replace(/\.00$/, "")}<i>d</i></span>
            )}
          </span>

          <span className="cal-wk-barwrap">
            <span
              className={`cal-wk-track ${hasHours ? "is-clickable" : ""}`}
              role={hasHours ? "button" : undefined}
              tabIndex={hasHours ? 0 : undefined}
              title={hasHours ? "See the days and hours behind this" : undefined}
              onClick={() => hasHours && setShowSplit((v) => !v)}
              onKeyDown={(ev) => {
                if (hasHours && (ev.key === "Enter" || ev.key === " ")) {
                  ev.preventDefault();
                  setShowSplit((v) => !v);
                }
              }}
            >
              <i className="is-plan" style={{ width: `${trackPct}%` }} />
              <i className="is-done" style={{ width: `${trackDonePct}%` }} />
            </span>

            {showSplit && hasHours && (
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
          </span>

          {scopeRevenueGoal > 0 && (
            <div className="cal-rev">
              <span className="cal-rev-fig">
                <strong className={scopeRevenue < scopeRevenueGoal ? "is-under" : ""}>
                  {Math.round(scopeRevenue).toLocaleString()}
                </strong>
                <em>/ {Math.round(scopeRevenueGoal).toLocaleString()}</em>
              </span>
              <div className="cal-rev-track">
                <div className="cal-rev-fill" style={{ width: `${revPct}%` }} />
              </div>
            </div>
          )}
        </div>
        <div className="cal-nav">
<div className="cal-nav-btns">
            <div className="cal-view-seg" data-view={view}>
              <span className="cal-view-slider" />
              <button className={view === "week" ? "is-on" : ""} onClick={() => switchView("week")}>Week</button>
              <button className={view === "month" ? "is-on" : ""} onClick={() => switchView("month")}>Month</button>
            </div>
<button className="cal-btn" onClick={() => go(-1)} aria-label="Previous week">‹</button>
<button className="cal-today" onClick={goToday} title="Jump to today">
              {view === "month"
                ? `${MONTHS_FULL[monthAnchor.getMonth()]} ${monthAnchor.getFullYear()}`
                : fmtRange(weekStart, addDays(weekStart, 4))}
            </button>
            <button className="cal-btn" onClick={() => go(1)} aria-label="Next week">›</button>
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
            <button className="cal-btn cal-gear" onClick={() => setShowSettings(true)} aria-label="Calendar settings" title="Calendar settings">⚙</button>
          </div>
        </div>
      </header>

{view === "month" ? (
      <div key={`m-${monthAnchor.getFullYear()}-${monthAnchor.getMonth()}`} className={`cal-month ${dirClass}`}>
          <div className="cal-month-head">
            {DOW.map((n) => (<div className="cal-month-dow" key={n}>{n}</div>))}
          </div>
          <div className="cal-month-body">
        {monthMatrix(monthAnchor).map((row, ri) => (
              <div className="cal-month-row" key={ri}>
                {row.map((d) => {
              const inMonth = d.getMonth() === monthAnchor.getMonth();
                  const dayList = entries.filter((e) => e.dateKey === dateKey(d));
                  const planned = billableOf(dayList);
                  const under = planned < targets.minPerDay;
                  const isCutoff = isoOf(d) === cutoffOf(periodOf(d), cutoffs, defaultCutoffDay);
                  return (
                    <div
                      className={`cal-mcell ${inMonth ? "" : "is-out"} ${sameDay(d, today) ? "is-today" : ""} ${isCutoff ? "is-cutoff" : ""}`}
                      key={d.toISOString()}
                      onClick={() => openNew(d, 9)}
                    >
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
                          <span className={`cal-mcell-sum ${under ? "is-under" : ""}`}>{planned.toFixed(2)}</span>
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
                               className={`cal-mchip is-${e.status} ${e.line === "connector" ? "is-connector" : ""}`}
                                style={{ background: bgOf(e.userId, wt?.color) }}
                                onClick={(ev) => { ev.stopPropagation(); if (!opaque(e.userId) && e.merged === 1) openEdit(d, e); }}
                                title={`${fmtTime(e.startMin)} – ${fmtTime(e.endMin)}`}
                              >
                                <span className="cal-mchip-time">{fmtTime(e.startMin).replace(":00", "")}</span>
                                <span className="cal-mchip-name">
                                  {e.clientId ? clientNames[e.clientId] ?? "—" : wt?.name ?? "—"}
                                </span>
                              </button>
                            );
                          })}
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
<span className="cal-dow">{DOW[i]}</span>
              {(() => {
                const dayList = entries.filter((e) => e.dateKey === dateKey(d));
                const planned = billableOf(dayList);
                const done = confirmedOf(dayList);
                const goal = targets.minPerDay || 1;
                const pFrac = Math.min(1, planned / goal);
                const dFrac = Math.min(1, done / goal);
                const under = planned < targets.minPerDay;
                return (
                  <span
                    className={`cal-ring ${under ? "is-under" : ""}`}
                    title={`${planned} planned · ${done} completed · min ${targets.minPerDay}`}
                    style={{
                      background: `conic-gradient(#12b57f 0turn ${dFrac}turn, rgba(18,181,127,0.32) ${dFrac}turn ${pFrac}turn, rgba(10,111,77,0.1) ${pFrac}turn 1turn)`,
                    }}
                  >
                    <span className="cal-ring-inner">{d.getDate()}</span>
                  </span>
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
            const dayEntries = laidOut(entries.filter((e) => e.dateKey === key), seenIds);
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
                }}
              >
                {(holidayName != null || isVacation) && (
                  <span className={`cal-daytag ${isVacation ? "is-vac" : "is-hol"}`}>
                    {isVacation ? "Vacation" : (holidayName || "Holiday")}
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

                {isToday && nowVisible && (
                  <span className="cal-now" style={{ top: `${nowPct}%` }} />
                )}

                {dayEntries.map((e) => {
                  const top = ((e.startMin - DAY_START) / SPAN) * 100;
const height = ((e.endMin - e.startMin) / SPAN) * 100;
const wt = workTypes.find((t) => t.id === e.type);
                    return (
<div
                      key={e.id}
                 className={`cal-event is-${e.status} ${e.line === "connector" ? "is-connector" : ""} ${e.line === "closure" ? "is-closure" : ""} ${opaque(e.userId) || e.merged > 1 ? "is-opaque" : ""}`}
                      style={{
                        top: `${top}%`, height: `${height}%`,
                        left: `calc(${e.left}% + 2px)`,
                        width: `calc(${e.width}% - 4px)`,
                        zIndex: 2 + e.lane,
                        background: bgOf(e.userId, wt?.color),
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
                      onDragEnd={() => setDragging(null)}
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
                              : e.clientId ? clientNames[e.clientId] ?? "—" : wt?.name ?? "—"}
                        </span>
                        {!opaque(e.userId) && e.merged === 1 && <span className="cal-event-bill">{e.billable}{unitOf(e)}</span>}
                      </span>
                      <span className="cal-event-time">
                        {fmtTime(e.startMin)} – {fmtTime(e.endMin)}
                      </span>
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
        <CalendarSettingsModal types={workTypes} setTypes={setWorkTypes} targets={targets} setTargets={setTargets} hideTargets cutoffs={cutoffs} setCutoffs={setCutoffs} defaultCutoffDay={defaultCutoffDay} setDefaultCutoffDay={setDefaultCutoffDay} holidays={holidays.map((h) => h.date)} onAddHoliday={addHoliday} onRemoveHoliday={removeHoliday} vacationAllowance={vacationAllowance} setVacationAllowance={setVacationAllowance} canEditTimeOff={role === "boss"} onClose={closeSettings} />
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
          }}
          onSave={saveModal}
          onDelete={modal.editingId ? deleteModal : undefined}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}