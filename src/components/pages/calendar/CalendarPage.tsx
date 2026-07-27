import { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import BookingModal from "./BookingModal";
import CalendarSettingsModal, { type WorkTypeDef, type Targets } from "./CalendarSettingsModal";
import { useAuth } from "../../api/AuthProvider";
import type { Cutoffs } from "./billingPeriods";
import { cutoffOf, periodOf, inBillingMonth } from "./billingPeriods";
import { effectiveRate, effectiveSupervisionRate } from "../clients/ClientsPage";
import ActualModal, { type ActualValue } from "./ActualModal";
import { supabase } from "../../api/supabase";
import { syncEntryToOutlook, deleteEntryFromOutlook } from "../../api/outlookSync";
import "./CalendarPage.css";

const HOURS = Array.from({ length: 16 }, (_, i) => 5 + i); // 5..20 (5 AM–9 PM)
const DAY_START = 5 * 60; // 5 AM in minutes
const DAY_END = 21 * 60; // 9 PM in minutes
const SPAN = DAY_END - DAY_START; // total minutes shown

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
  const { role } = useAuth();
  const [holidays, setHolidays] = useState<{ date: string; name: string }[]>([]);
  const [vacations, setVacations] = useState<{ id: string; date: string }[]>([]);
  const [vacationAllowance, setVacationAllowance] = useState(22);
  const [defaultCutoffDay, setDefaultCutoffDay] = useState(0);
  const [rates, setRates] = useState<Record<string, { consultor: number; supervision: number; connector: number }>>({});
useEffect(() => {
    (async () => {
     const { data: u0 } = await supabase.auth.getUser();
      const { data: ce } = await supabase
        .from("calendar_entries")
        .select("*")
        .eq("user_id", u0?.user?.id ?? "");
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
        outlookEventId: (r.outlook_event_id as string) ?? null,
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
        .eq("user_id", u0?.user?.id ?? "")
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
      const { data: bs } = await supabase.from("billing_settings").select("default_cutoff_day, vacation_days_per_year").eq("id", "default").maybeSingle();
      if (bs) setVacationAllowance(Number(bs.vacation_days_per_year ?? 22));

      const { data: hol } = await supabase.from("holidays").select("holiday_date, name");
      setHolidays(((hol ?? []) as any[]).map((h) => ({ date: h.holiday_date, name: h.name ?? "" })));

      const { data: vac } = await supabase.from("vacations").select("id, vacation_date").eq("user_id", u0?.user?.id ?? "");
      setVacations(((vac ?? []) as any[]).map((v) => ({ id: v.id, date: v.vacation_date })));
      if (bs) setDefaultCutoffDay(Number(bs.default_cutoff_day) || 0);
    })();
  }, []);

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
const goToday = () => {
    setMonthAnchor(new Date());
    const t = startOfWeek(new Date());
    setDir(t.getTime() < weekStart.getTime() ? -1 : 1);
    setWeekStart(t);
  };

  const openNew = (day: Date, hour: number) => {
    const startMin = hour * 60;
    const endMin = Math.min(hour * 60 + 60, DAY_END);
    const billable = Math.max(0.25, Math.round((endMin - startMin) / 60 / 0.25) * 0.25);
setModal({ day, startMin, endMin, type: workTypes[0]?.id ?? "", billable, clientId: "", projectId: "", phaseId: "", taskId: "", attendees: "", notes: "", line: "" });
  };
  const openEdit = (day: Date, e: Entry) => {
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
        status: entries.find((e) => e.id === id)?.status ?? "planned",
      });
      if (error) { alert(`Could not save entry: ${error.message}`); return; }

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
const billableOf = (list: Entry[]) =>
    list.filter((e) => clientTypeIds.has(e.type) && e.status !== "cancelled" && e.line !== "connector")
        .reduce((s, e) => s + effBillable(e), 0);
  const confirmedOf = (list: Entry[]) =>
    list.filter((e) => clientTypeIds.has(e.type) && e.status === "confirmed" && e.line !== "connector")
        .reduce((s, e) => s + effBillable(e), 0);

const monthDays = monthMatrix(monthAnchor).flat().filter((d) => d.getMonth() === monthAnchor.getMonth());
  const scopeDays = view === "month" ? monthDays : days;
  // Month scope follows the billing window (prev cutoff → this cutoff), which can
  // include late days of the previous calendar month and exclude late days of this one.
  const scopeEntries = view === "month"
    ? entries.filter((e) => inBillingMonth(isoFromKey(e.dateKey), periodOf(monthAnchor), cutoffs, defaultCutoffDay))
    : entries.filter((e) => scopeDays.some((d) => dateKey(d) === e.dateKey));
  const weekPlanned = billableOf(scopeEntries);
  const weekDone = confirmedOf(scopeEntries);
  const WEEKS_PER_MONTH = 4.333;
  const div = view === "month" ? 1 : WEEKS_PER_MONTH;

  // Dynamic target: aim for the minimum; once reached, the goal jumps to the high tier.
  const minDays = targets.minPerMonth / div;
  const highDaysRaw = (targets.highPerMonth ?? 0) / div;
  const highDays = highDaysRaw > minDays ? highDaysRaw : 0; // only if a real higher tier exists
  const reachedMinDays = minDays > 0 && weekPlanned >= minDays;
  const scopeGoal = reachedMinDays && highDays > 0 ? highDays : minDays;
  const goalIsHigh = reachedMinDays && highDays > 0;

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
  const revGoalIsHigh = reachedMinRev && highRev > 0;
  const revPct = scopeRevenueGoal > 0
    ? Math.min(100, (scopeRevenue / scopeRevenueGoal) * 100)
    : 0;
  const weekPct = scopeGoal > 0 ? Math.min(100, (weekPlanned / scopeGoal) * 100) : 0;
  const weekDonePct = scopeGoal > 0 ? Math.min(100, (weekDone / scopeGoal) * 100) : 0;

  const holidaySet = new Map(holidays.map((h) => [h.date, h.name]));
  const vacationSet = new Set(vacations.map((v) => v.date));

  /** Toggle a vacation day for the current user. */
  const toggleVacation = async (iso: string) => {
    const { data: u } = await supabase.auth.getUser();
    const uid = u?.user?.id;
    if (!uid) return;
    if (vacationSet.has(iso)) {
      setVacations((list) => list.filter((v) => v.date !== iso));
      await supabase.from("vacations").delete().eq("user_id", uid).eq("vacation_date", iso);
    } else {
      setVacations((list) => [...list, { id: crypto.randomUUID(), date: iso }]);
      await supabase.from("vacations").upsert({ user_id: uid, vacation_date: iso }, { onConflict: "user_id,vacation_date" });
    }
  };
  const vacationsUsed = vacations.length;

  const dirClass = dir === 1 ? "slide-next" : "slide-prev";
  const animKey = weekStart.getTime();

  const nowVisible = today.getHours() >= 5 && today.getHours() < 21;
  const nowPct = (((today.getHours() - 5) * 60 + today.getMinutes()) / SPAN) * 100;

  return (
    <div className="cal">
      <div className="cal-scan-wrap" aria-hidden="true">
        <div className="cal-scan" />
      </div>

<header className="cal-bar">
        <div className="cal-bar-left">
          <button className="cal-home" onClick={() => navigate("/home")} aria-label="Back to home" title="Home">‹</button>
          <h1 className="cal-title">Calendar</h1>
        </div>
<div className="cal-week-bar">
          <span className="cal-week-figure">
            <strong className={weekPlanned < scopeGoal ? "is-under" : ""}>{weekPlanned.toFixed(2)}</strong>
            <em>/ {scopeGoal.toFixed(2).replace(/\.00$/, "")}d</em>
            {goalIsHigh && <span className="cal-tier-tag">HIGH</span>}
          </span>
          <div className={`cal-week-track ${goalIsHigh ? "is-high" : ""}`}>
            <div className="cal-week-fill" style={{ width: `${weekPct}%` }} />
            <div className="cal-week-fill is-done" style={{ width: `${weekDonePct}%` }} />
          </div>
<div className="cal-week-legend">
            <span><i className="dot-done" />{weekDone.toFixed(2)}</span>
            <span><i className="dot-plan" />{(weekPlanned - weekDone).toFixed(2)}</span>
          </div>

          {scopeRevenueGoal > 0 && (
            <div className="cal-rev">
              <span className="cal-rev-fig">
                <strong className={scopeRevenue < scopeRevenueGoal ? "is-under" : ""}>
                  {Math.round(scopeRevenue).toLocaleString()}
                </strong>
                <em>/ {Math.round(scopeRevenueGoal).toLocaleString()}</em>
                {revGoalIsHigh && <span className="cal-tier-tag">HIGH</span>}
              </span>
              <div className={`cal-rev-track ${revGoalIsHigh ? "is-high" : ""}`}>
                <div className="cal-rev-fill" style={{ width: `${revPct}%` }} />
              </div>
            </div>
          )}
        </div>
        <div className="cal-nav">
<div className="cal-nav-btns">
            <div className="cal-view-seg" data-view={view}>
              <span className="cal-view-slider" />
              <button className={view === "week" ? "is-on" : ""} onClick={() => setView("week")}>Week</button>
              <button className={view === "month" ? "is-on" : ""} onClick={() => setView("month")}>Month</button>
            </div>
<button className="cal-btn" onClick={() => go(-1)} aria-label="Previous week">‹</button>
<button className="cal-today" onClick={goToday} title="Jump to today">
              {view === "month"
                ? `${MONTHS_FULL[monthAnchor.getMonth()]} ${monthAnchor.getFullYear()}`
                : fmtRange(weekStart, addDays(weekStart, 4))}
            </button>
            <button className="cal-btn" onClick={() => go(1)} aria-label="Next week">›</button>
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
                                style={{ background: wt?.color ?? "#12b57f" }}
                                onClick={(ev) => { ev.stopPropagation(); openEdit(d, e); }}
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
      <div className="cal-grid">
        <div className="cal-corner" />

        <div key={`h-${animKey}`} className={`cal-head-days ${dirClass}`}>
          {days.map((d, i) => {
            const isCutoff = isoOf(d) === cutoffOf(periodOf(d), cutoffs, defaultCutoffDay);
            const dIso = isoOf(d);
            const dayIsVac = vacationSet.has(dIso);
            const dayIsHol = holidaySet.has(dIso);
            return (
            <div className={`cal-head-day ${sameDay(d, today) ? "is-today" : ""} ${isCutoff ? "is-cutoff" : ""}`} key={d.toISOString()}>
              {!dayIsHol && (
                <button
                  className={`cal-vac-btn ${dayIsVac ? "is-on" : ""}`}
                  onClick={() => toggleVacation(dIso)}
                  title={dayIsVac ? "Remove vacation" : "Mark as vacation"}
                >🏖️</button>
              )}
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
            const dayEntries = entries.filter((e) => e.dateKey === key);
            return (
             <div
                className={`cal-col ${isToday ? "is-today" : ""} ${dragging ? "is-drop" : ""} ${holidayName != null ? "is-holiday" : ""} ${isVacation ? "is-vacation" : ""}`}
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
                 className={`cal-event is-${e.status} ${e.line === "connector" ? "is-connector" : ""} ${e.line === "closure" ? "is-closure" : ""}`}
                      style={{ top: `${top}%`, height: `${height}%`, background: wt?.color ?? "#12b57f" }}
onClick={(ev) => { ev.stopPropagation(); openEdit(d, e); }}
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
<span className="cal-event-head">
                        <span className="cal-event-title">
                          {e.clientId ? clientNames[e.clientId] ?? "—" : wt?.name ?? "—"}
                        </span>
                        <span className="cal-event-bill">{e.billable}d</span>
                      </span>
                      <span className="cal-event-time">
                        {fmtTime(e.startMin)} – {fmtTime(e.endMin)}
                      </span>
{actuals[e.id] && <span className="cal-event-actual" title="Actuals logged">⏱</span>}
                      {(e.status === "confirmed" || e.status === "cancelled") && (
                        <span className="cal-event-flag">{e.status === "confirmed" ? "✓" : "✕"}</span>
                      )}
                      <span className="cal-event-actions">
                        <button className="cal-ev-btn is-ok" title="Took place"
                          onClick={(ev) => { ev.stopPropagation(); setStatus(e.id, "confirmed"); }}>✓</button>
<button className="cal-ev-btn is-no" title="Did not take place"
                          onClick={(ev) => { ev.stopPropagation(); setStatus(e.id, "cancelled"); }}>✕</button>
                        <button className="cal-ev-btn is-log" title="Log what actually happened"
                          onClick={(ev) => { ev.stopPropagation(); setActualFor(e); }}>⏱</button>
                      </span>
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

      {showSettings && (
        <CalendarSettingsModal types={workTypes} setTypes={setWorkTypes} targets={targets} setTargets={setTargets} hideTargets cutoffs={cutoffs} setCutoffs={setCutoffs} defaultCutoffDay={defaultCutoffDay} setDefaultCutoffDay={setDefaultCutoffDay} holidays={holidays.map((h) => h.date)} onAddHoliday={addHoliday} onRemoveHoliday={removeHoliday} vacationAllowance={vacationAllowance} setVacationAllowance={setVacationAllowance} canEditTimeOff={role === "boss"} onClose={closeSettings} />
      )}

      {modal && (
<BookingModal
          day={modal.day}
          editing={!!modal.editingId}
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
          }}
          onSave={saveModal}
          onDelete={modal.editingId ? deleteModal : undefined}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}