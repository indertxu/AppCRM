import { useEffect, useRef, useState } from "react";
import type { WorkTypeDef } from "./CalendarSettingsModal";
import type { Client, Project, ProjectType } from "../clients/ClientsPage";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import { supabase } from "../../api/supabase";
import { busyAt } from "./invitesApi";
import { useAuth } from "../../api/AuthProvider";
import { loadRoles } from "../settings/blueprintsApi";
import {
  legacyRoleMap, resolveRoleKey, resolvedLinesOf, roleLinesOfRow, roleKeyOf, roleCounts, roleColor, roleNameOf,
  sortRoles, type ClientRole, type RoleLine,
} from "../clients/clientsTypes";
import "./BookingModal.css";

const MODAL_HOURS = Array.from({ length: 17 }, (_, i) => 5 + i); // 5..21
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const DAY_MIN = 5 * 60;
const DAY_MAX = 21 * 60;

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hourLabel(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${period}`;
}

export interface BookingValue {
  startMin: number;
  endMin: number;
  type: string;
  billable: number;
clientId: string;
  projectId: string;
  notes: string;
  line: string;
  roleId: string;
  phaseId: string;
  taskId: string;
  attendees: string;
  /** teams, phone or in_person. */
  meetKind?: string;
  /** The day it happens, when moved from the one the modal opened on. */
  date?: Date;
  /** Repeats on these weekdays (76_calendar_series.sql); null = just once. */
  repeat?: RepeatRule | null;
  /** On an entry of a series: change only this one, or this and the ones after it. */
  scope?: "one" | "following";
  summoned?: { id: string; billable: number }[];
  summonNote?: string;
}

/** "Every Monday", "every 2 weeks on Tue and Thu", "every weekday"… until a date or with no end. */
export interface RepeatRule {
  /** 1 = every week, 2 = every other week. */
  every: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  /** Last day it may happen (YYYY-MM-DD), or null for no end. */
  until: string | null;
  /** Leave out holidays and days off. */
  skipOff: boolean;
}
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayOfIso = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
export const sameRule = (a?: RepeatRule | null, b?: RepeatRule | null) =>
  (!a && !b) || (!!a && !!b && a.every === b.every && a.until === b.until && a.skipOff === b.skipOff
    && [...a.weekdays].sort().join() === [...b.weekdays].sort().join());
const isWeekdays = (r: RepeatRule) => r.every === 1 && [...r.weekdays].sort().join() === "1,2,3,4,5";
/** How a rule reads: "Every Monday", "Every 2 weeks on Tue, Thu", "Every weekday". */
export function repeatLabel(r: RepeatRule): string {
  const days = WEEK_ORDER.filter((d) => r.weekdays.includes(d));
  const base = isWeekdays(r) ? "Every weekday"
    : days.length === 7 && r.every === 1 ? "Every day"
    : r.every === 1 && days.length === 1 ? `Every ${DOW_LONG[days[0]]}`
    : `Every ${r.every > 1 ? `${r.every} weeks` : "week"} on ${days.map((d) => DOW_SHORT[d]).join(", ")}`;
  if (!r.until) return base;
  const u = dayOfIso(r.until);
  return `${base} until ${MONTHS_LONG[u.getMonth()].slice(0, 3)} ${u.getDate()}`;
}
/**
 * The days a rule lands on, from the first one (always included) up to `to`.
 * Weeks count from the Monday of the first day, so "every 2 weeks" keeps its rhythm.
 */
export function repeatDates(first: string, r: RepeatRule, to: string, max = 400): string[] {
  const start = dayOfIso(first);
  const monday = new Date(start); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const end = r.until && r.until < to ? r.until : to;
  const out: string[] = [first];
  const d = new Date(start); d.setDate(d.getDate() + 1);
  while (out.length < max) {
    const iso = isoDay(d);
    if (iso > end) break;
    const week = Math.floor(Math.round((d.getTime() - monday.getTime()) / 86400000) / 7);
    if (r.weekdays.includes(d.getDay()) && week % Math.max(1, r.every) === 0) out.push(iso);
    d.setDate(d.getDate() + 1);
  }
  return out;
}
/** How far ahead entries are made for a series with no end (more are added as time goes by). */
export const REPEAT_AHEAD_DAYS = 91;

interface BookingModalProps {
  day: Date;
  editing: boolean;
  /** The entry being edited, so its invitations can be loaded and changed. */
  entryId?: string | null;
  types: WorkTypeDef[];
  initial: BookingValue;
  /** The entry being edited belongs to a series: saving and deleting ask how far it goes. */
  inSeries?: boolean;
  onSave: (v: BookingValue) => void;
  onDelete?: (scope?: "one" | "following") => void;
  onClose: () => void;
}


/**
 * Time picker with its own dropdown, because the native <select> renders an OS
 * menu that ignores the app's styling.
 *
 * Each part anchors its own popover, and the outside-click listener runs on
 * click rather than mousedown: the modal closes itself on backdrop mousedown,
 * so listening to the same event made the two fight each other.
 */
const MEET_KINDS = [
  { id: "teams", label: "Teams", icon: "M15 10l4.5-2.6v9.2L15 14M4 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" },
  { id: "phone", label: "Call", icon: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" },
  { id: "in_person", label: "In person", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" },
];

function TimeField({ hour, minute, onHour, onMinute }: {
  hour: number; minute: number;
  onHour: (h: number) => void; onMinute: (m: number) => void;
}) {
  const [open, setOpen] = useState<"h" | "m" | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(null); } };
    // Deferred so the click that opened the popover does not close it again.
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const period = hour < 12 ? "AM" : "PM";
  const hr = hour % 12 === 0 ? 12 : hour % 12;

  const list = (which: "h" | "m") => (
    <div className="bm-tf-pop" role="listbox">
      {(which === "h" ? MODAL_HOURS : MINUTES).map((v) => {
        const on = which === "h" ? v === hour : v === minute;
        return (
          <button key={v} type="button" role="option" aria-selected={on}
            className={`bm-tf-opt ${on ? "is-on" : ""}`}
            ref={on ? (el) => el?.scrollIntoView({ block: "center" }) : undefined}
            onClick={() => { if (which === "h") onHour(v); else onMinute(v); setOpen(null); }}>
            {which === "h" ? hourLabel(v) : String(v).padStart(2, "0")}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="bm-tf" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <div className="bm-tf-part">
        <button type="button" className={`bm-tf-btn ${open === "h" ? "is-open" : ""}`}
          onClick={() => setOpen(open === "h" ? null : "h")}>
          <b>{hr}</b><i>{period}</i>
        </button>
        {open === "h" && list("h")}
      </div>

      <span className="bm-tf-colon">:</span>

      <div className="bm-tf-part">
        <button type="button" className={`bm-tf-btn bm-tf-min ${open === "m" ? "is-open" : ""}`}
          onClick={() => setOpen(open === "m" ? null : "m")}>
          <b>{String(minute).padStart(2, "0")}</b>
        </button>
        {open === "m" && list("m")}
      </div>
    </div>
  );
}

export default function BookingModal({
  day, editing, entryId, types, initial, inSeries, onSave, onDelete, onClose,
}: BookingModalProps) {
  /** Repeats (null = once), and the scope question when changing an entry of a series. */
  const [rep, setRep] = useState<RepeatRule | null>(initial.repeat ?? null);
  const [scopeAsk, setScopeAsk] = useState(false);
  const [untilOpen, setUntilOpen] = useState(false);
  const untilRef = useRef<HTMLButtonElement>(null);
  const [startH, setStartH] = useState(Math.floor(initial.startMin / 60));
  const [startM, setStartM] = useState(initial.startMin % 60);
  const [endH, setEndH] = useState(Math.floor(initial.endMin / 60));
  const [endM, setEndM] = useState(initial.endMin % 60);
  const [type, setType] = useState<string>(initial.type || types[0]?.id || "");
  const [billable, setBillable] = useState(initial.billable);
  /** The day it happens. Starts on the clicked day and can be moved at the last minute. */
  const [when, setWhen] = useState<Date>(() => new Date(day.getFullYear(), day.getMonth(), day.getDate()));
  const [dayOpen, setDayOpen] = useState(false);
  const dayBtnRef = useRef<HTMLButtonElement>(null);
  const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const moved = isoOf(when) !== isoOf(day);
  // "Every Monday" follows the day: moving the first one to a Tuesday makes it every Tuesday.
  const prevDow = useRef(when.getDay());
  useEffect(() => {
    const was = prevDow.current, now = when.getDay();
    prevDow.current = now;
    if (was === now) return;
    setRep((r) => (r && r.weekdays.length === 1 && r.weekdays[0] === was ? { ...r, weekdays: [now] } : r));
  }, [when]);
  /** Picks a repeat: once, every week, every 2 weeks or every weekday. */
  const repMode = !rep ? "once" : isWeekdays(rep) ? "weekdays" : rep.every === 2 ? "2w" : "1w";
  const pickRep = (m: string) => setRep((r) => {
    if (m === "once") return null;
    const keep = { until: r?.until ?? null, skipOff: r?.skipOff ?? true };
    const ownDays = r && !isWeekdays(r) ? r.weekdays : [when.getDay()];
    if (m === "weekdays") return { every: 1, weekdays: [1, 2, 3, 4, 5], ...keep };
    return { every: m === "2w" ? 2 : 1, weekdays: ownDays, ...keep };
  });
  const toggleRepDay = (d: number) => setRep((r) => {
    if (!r) return r;
    const has = r.weekdays.includes(d);
    if (has && r.weekdays.length === 1) return r;
    return { ...r, weekdays: has ? r.weekdays.filter((x) => x !== d) : [...r.weekdays, d] };
  });
  /** What the rule gives, for the line under it: how many dates and until when. */
  const repCount = (() => {
    if (!rep) return null;
    const first = isoOf(when);
    const ahead = new Date(when); ahead.setDate(ahead.getDate() + REPEAT_AHEAD_DAYS);
    const list = repeatDates(first, rep, rep.until ?? isoOf(ahead));
    return { n: list.length, last: list[list.length - 1] };
  })();

const { session, role } = useAuth();
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
const [projectTypes, setProjectTypes] = useState<ProjectType[]>([]);
  const [signedDays, setSignedDays] = useState<Record<string, number>>({});
  const [used, setUsed] = useState<Record<string, { done: number; booked: number }>>({});
  const [clientId, setClientId] = useState(initial.clientId ?? "");
  const [projectId, setProjectId] = useState(initial.projectId ?? "");
  const [openPhaseId, setOpenPhaseId] = useState("");
  const [taskIds, setTaskIds] = useState<string[]>(
    initial.taskId ? initial.taskId.split(",").filter(Boolean) : []
  );
const [notes, setNotes] = useState(initial.notes ?? "");
  /** The role this time is logged on: one of the roles sold on the project. */
  const [roleId, setRoleId] = useState(initial.roleId ?? "");
  /** Every role in the catalogue, and the ones this person is assigned to. */
  const [allRoles, setAllRoles] = useState<ClientRole[]>([]);
  const [roles, setRoles] = useState<ClientRole[]>([]);
  /** The role the entry already had when editing: it stays available so saving never moves it. */
  const [keepRole, setKeepRole] = useState(initial.roleId ?? "");
  /** The roles sold on each project (old projects read through their legacy columns). */
  const [projLines, setProjLines] = useState<Record<string, RoleLine[]>>({});
  /** Rate unit and smallest bookable amount, per service, from the catalogue. */
  const [svcUnits, setSvcUnits] = useState<Record<string, { unit: "hour" | "day"; min: number }>>({});
const [pickedLine, setPickedLine] = useState(editing || !!initial.line);
  const [closing, setClosing] = useState(false);
  const [closeClient, setCloseClient] = useState("");
  const [closeProject, setCloseProject] = useState("");
const closeDate = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
  const [closeBusy, setCloseBusy] = useState(false);
  /**
   * Colleagues summoned to this meeting. The organiser decides what each of
   * them bills for attending, which is why it is a map and not a list.
   */
  const [summoned, setSummoned] = useState<Record<string, number>>({});
  const [summonNote, setSummonNote] = useState("");
  /** How the time is spent: on a call, on Teams, or in the room. */
  const [meetKind, setMeetKind] = useState<string>(initial.meetKind ?? "in_person");
  /** Which step of the flow is on screen; editing opens on the review. */
  const [wizStep, setWizStep] = useState<"work" | "when" | "client" | "tasks" | "people" | "notes">(editing ? "notes" : "work");
  const [wizDir, setWizDir] = useState<1 | -1>(1);
  const [confirmDel, setConfirmDel] = useState(false);
  /** Steps already shown, so a step only ticks once you have been through it. */
  const [seen, setSeen] = useState<Set<string>>(() => new Set(editing ? ["work", "when", "client", "tasks", "people", "notes"] : ["work"]));
  useEffect(() => { setSeen((s) => (s.has(wizStep) ? s : new Set([...s, wizStep]))); }, [wizStep]);
  const [clientQ, setClientQ] = useState("");
  const [peopleOpen, setPeopleOpen] = useState(false);
  /** Who was already summoned, so reopening shows them and they can be dropped. */
  useEffect(() => {
    if (!entryId) return;
    supabase.from("entry_invites")
      .select("invitee_id, billable").eq("entry_id", entryId).neq("status", "declined")
      .then(({ data }) => {
        const m: Record<string, number> = {};
        ((data ?? []) as any[]).forEach((r) => { m[r.invitee_id] = Number(r.billable) || 0; });
        setSummoned(m);
      });
  }, [entryId]);
  const [mates, setMates] = useState<{ id: string; name: string; role: string }[]>([]);
  useEffect(() => {
    supabase.auth.getUser().then(({ data: u }) => {
      const me = u?.user?.id ?? "";
      supabase.from("profiles").select("id, first_name, last_name, username, email, role")
        .then(({ data }) => {
          setMates((data ?? [])
            .filter((x: any) => x.id !== me)
            .map((x: any) => ({
              id: x.id,
              name: [x.first_name, x.last_name].filter(Boolean).join(" ") || x.username || x.email || "Unnamed",
              role: (x.role ?? "").replace(/_/g, " "),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)));
        });
    });
  }, []);
  const toggleMate = (id: string) =>
    setSummoned((m) => {
      if (id in m) { const { [id]: _drop, ...rest } = m; return rest; }
      return { ...m, [id]: isClientWork ? billable : 0 };
    });

  const [attendeeIds, setAttendeeIds] = useState<string[]>(
    initial.attendees ? initial.attendees.split(",").filter(Boolean) : []
  );

  // Options come from the roles defined in the catalogue, filtered to the ones
  // this person is assigned to there. On a project, the role is narrowed to
  // the roles that project was sold with (see projRoles).
  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id ?? "";
      const all = await loadRoles();
      setAllRoles(all);
      // Your own roles, plus every role that doesn't count for the target
      // (connector work, which anyone could always log).
      setRoles(all.filter((r) => (r.userIds ?? []).includes(uid) || !r.countsForTarget));
      // An entry from before roles were stored only has its line: show it on the matching role.
      if (!initial.roleId && initial.line && initial.line !== "closure" && initial.line !== "sales") {
        const k = resolveRoleKey(initial.line, legacyRoleMap(all));
        if (k !== initial.line) { setRoleId(k); setKeepRole(k); }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    supabase.from("services").select("id, rate_unit, min_unit").then(({ data }) => {
      const out: Record<string, { unit: "hour" | "day"; min: number }> = {};
      (data ?? []).forEach((r: any) => {
        const unit = r.rate_unit === "hour" ? "hour" : "day";
        out[r.id] = { unit, min: Number(r.min_unit) || (unit === "hour" ? 0.5 : 0.25) };
      });
      setSvcUnits(out);
    });
  }, []);

  const pickRole = (r: ClientRole | null) => {
    setRoleId(r?.id ?? "");
    setPickedLine(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    (async () => {
const { data: ps } = await supabase.from("projects").select("*").order("created_at");
      const seesAll = role === "boss" || role === "consultancy_manager" || role === "customer_success";
      const myId = session?.user?.id ?? "";

      const mapped = ((ps ?? []) as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        clientId: r.client_id as string,
        // Projects are classified by service now; project_type_id is the old field.
        projectTypeId: ((r.service_id as string) ?? (r.project_type_id as string)) ?? "",
        kickoffDate: (r.kickoff_date as string) ?? "",
        phases: (r.phases as Project["phases"]) ?? [],
        contacts: (r.contacts as Project["contacts"]) ?? [],
team: (r.team as { userId?: string }[]) ?? [],
        status: (r.status as string) || "open",
      }));

      const visible = seesAll
        ? mapped
        : mapped.filter((p) => (p.team ?? []).some((m) => m.userId === myId));
      setProjects(visible as unknown as Project[]);

      const allowed = new Set(visible.map((p) => p.clientId));
      const { data: cs } = await supabase.from("clients").select("id, name").order("name");
      setClients(((cs ?? []) as unknown as Client[]).filter((c) => seesAll || allowed.has(c.id)));
      // Days sold per project and role, and what is already used on each.
      const legacy = legacyRoleMap(await loadRoles());
      const lines: Record<string, RoleLine[]> = {};
      ((ps ?? []) as Record<string, unknown>[]).forEach((r) => {
        lines[r.id as string] = resolvedLinesOf({ roleLines: roleLinesOfRow(r) }, legacy);
      });
      setProjLines(lines);
      setSignedDays(Object.fromEntries(Object.entries(lines).flatMap(([pid, ls]) => ls.map((l) => [`${pid}|${l.roleId}`, l.days]))));

      const { data: ce } = await supabase.from("calendar_entries").select("id, project_id, billable, status, billing_line, role_id");
      const { data: ea } = await supabase.from("entry_actuals").select("entry_id, actual_billable");
      const actualMap = Object.fromEntries(((ea ?? []) as Record<string, unknown>[])
        .map((r) => [r.entry_id as string, Number(r.actual_billable) || 0]));
      const agg: Record<string, { done: number; booked: number }> = {};
      ((ce ?? []) as Record<string, unknown>[]).forEach((r) => {
        const pid = r.project_id as string | null;
        if (!pid || r.status === "cancelled") return;
const v = actualMap[r.id as string] ?? (Number(r.billable) || 0);
        // When editing, the entry itself is left out: the bar adds what is on screen.
        if (editing && r.id === entryId) return;
        const k = `${pid}|${resolveRoleKey(roleKeyOf(r as { role_id?: string | null; billing_line?: string | null }), legacy)}`;
        if (!agg[k]) agg[k] = { done: 0, booked: 0 };
        if (r.status === "confirmed") agg[k].done += v;
        else agg[k].booked += v;
      });
      setUsed(agg);

      const { data: pt } = await supabase.from("services").select("id, name");
      setProjectTypes(((pt ?? []) as Record<string, unknown>[]).map((r) => ({
        id: r.id as string, name: (r.name as string) ?? "",
      })));
    })();
  }, []);

  const selectedType = types.find((t) => t.id === type);
  const isClientWork = !!selectedType?.clientRelated;
const client = clients.find((c) => c.id === clientId);
const clientProjects = projects.filter((p) => p.clientId === clientId && p.status !== "closed");
  const openProjectsOf = (cid: string) => projects.filter((p) => p.clientId === cid && p.status !== "closed");
  const project = projects.find((p) => p.id === projectId);
  // The project's service decides the unit and the step. Without a project we
  // fall back to days, which is what the rest of the app assumes.
  const svc = project ? svcUnits[project.projectTypeId] : undefined;
  const unit: "hour" | "day" = svc?.unit ?? "day";
  const step = svc?.min ?? 0.25;
  const unitLabel = unit === "hour" ? (billable === 1 ? "hour" : "hours") : (billable === 1 ? "day" : "days");
  const decimals = step < 0.1 ? 3 : 2;
  /** "h" or "d", so every figure in the modal speaks the service's unit. */
  const unitShort = unit === "hour" ? "h" : "d";
  const phases = project?.phases ?? [];
  const contacts = project?.contacts ?? [];
  /**
   * The roles you can log on a project: the ones it was sold with that you
   * hold. If you hold none of them, any role on the project (someone has to be
   * able to log the time); a project with no roles at all leaves the choice open.
   */
  const projRolesOf = (pid: string): RoleLine[] => {
    const ls = projLines[pid] ?? [];
    const mine = ls.filter((l) => roles.some((r) => r.id === l.roleId) || (editing && l.roleId === keepRole));
    const counting = mine.filter((l) => roleCounts(l.roleId, allRoles));
    // nothing of yours that counts: any counting role on the project (someone has to log the time)
    const base = counting.length ? mine : [...ls.filter((l) => roleCounts(l.roleId, allRoles)), ...mine.filter((l) => !counting.includes(l))];
    const out = base.length ? base : ls;
    // counting roles first, so a fallback never lands on a connector-type role
    return [...out.filter((l) => roleCounts(l.roleId, allRoles)), ...out.filter((l) => !roleCounts(l.roleId, allRoles))]
      .filter((l, i, a) => a.findIndex((x) => x.roleId === l.roleId) === i);
  };
  const projRoles = project ? projRolesOf(project.id) : [];
  /**
   * The role a project is logged on. The one picked stays when the project has
   * it, or when it is a role that doesn't count (connector time is logged as
   * such even on a project sold without it). A counting role the project
   * wasn't sold with moves to the project's own consultancy role.
   */
  const roleFor = (pid: string) => {
    const opts = projRolesOf(pid);
    if (roleId && (opts.some((l) => l.roleId === roleId) || (projLines[pid] ?? []).some((l) => l.roleId === roleId))) return roleId;
    if (roleId && allRoles.some((r) => r.id === roleId && !r.countsForTarget)) return roleId;
    return opts[0]?.roleId ?? roleId;
  };
  const roleIdx = (id: string) => sortRoles(allRoles).findIndex((r) => r.id === id);
  const colorOf = (id: string) => roleColor(allRoles.find((r) => r.id === id), Math.max(0, roleIdx(id)));
  const projectLabel = (p: Project) => {
    const t = projectTypes.find((x) => x.id === p.projectTypeId)?.name ?? "Project";
    return p.kickoffDate ? `${t} · ${p.kickoffDate}` : t;
  };
  // Selected tasks resolved back to their phase, for the summary panel
  const picked = phases.flatMap((p) =>
    (p.tasks ?? [])
      .filter((t) => taskIds.includes(t.id))
      .map((t) => ({ phaseName: p.name || "Untitled phase", taskId: t.id, taskName: t.name || "Untitled task" }))
  );

  const toggleTask = (id: string) =>
    setTaskIds((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const toggleAttendee = (id: string) =>
    setAttendeeIds((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));

  const pickType = (id: string) => {
    setType(id);
    const t = types.find((x) => x.id === id);
if (!t?.clientRelated) { setClientId(""); setProjectId(""); setOpenPhaseId(""); setTaskIds([]); setAttendeeIds([]); }
  };
  const pickClient = (id: string) => {
    setClientId(id); setProjectId(""); setOpenPhaseId(""); setTaskIds([]); setAttendeeIds([]);
  };
  const pickProject = (id: string) => {
    setProjectId(id); setOpenPhaseId(""); setTaskIds([]); setAttendeeIds([]);
    // The role follows the project: one it was sold with, ideally the one picked.
    if (id) setRoleId(roleFor(id));
  };

const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;

  /** Who is already booked while this entry runs. Busy or not, nothing more. */
  const [busyMates, setBusyMates] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!mates.length) return;
    const d = when;
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    busyAt(mates.map((m) => m.id), iso, startMin, endMin).then(setBusyMates).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mates, when, startMin, endMin]);

  const doClose = async () => {
    if (!closeProject || !closeDate) return;
    setCloseBusy(true);
const { error } = await supabase
      .from("projects")
      .update({ status: "closed", end_date: closeDate })
      .eq("id", closeProject);
    if (error) { setCloseBusy(false); alert(`Could not close project: ${error.message}`); return; }

    const { data: u } = await supabase.auth.getUser();
    const proj = projects.find((p) => p.id === closeProject);
    await supabase.from("calendar_entries").insert({
      user_id: u?.user?.id,
      date_key: `${when.getFullYear()}-${when.getMonth()}-${when.getDate()}`,
      entry_date: closeDate,
      start_min: startMin,
      end_min: endMin,
      work_type_id: null,
      billable: 0,
      client_id: closeClient,
      project_id: closeProject,
      notes: `Project closed — ${proj ? projectLabel(proj) : ""}`,
      billing_line: "closure",
      status: "confirmed",
    });

    setCloseBusy(false);
    onClose();
  };

let error: string | null = null;
  if (endMin <= startMin) error = "Finish must be after the start time.";
  else if (startMin < DAY_MIN || endMin > DAY_MAX) error = "Times must be between 5 AM and 9 PM.";
  else if (!type) error = "Pick a type of work.";
else if (isClientWork && !clientId) error = "Pick a client.";
  else if (isClientWork && !projectId) error = "Pick a project.";
  else if (rep?.until && rep.until < isoOf(when)) error = "The repeat ends before the first day.";

  const durLabel = (() => {
    if (endMin <= startMin) return "—";
    const d = endMin - startMin;
    const h = Math.floor(d / 60);
    const m = d % 60;
    return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ") || "0m";
  })();

  // Steps by the service's smallest bookable amount, and snaps to a multiple of
  // it so a value typed elsewhere cannot drift off the grid.
  const snap = (v: number) => +(Math.round(v / step) * step).toFixed(4);
  // Switching to a project on a different unit would leave a value off the new
  // grid, so it is snapped as soon as the step changes.
  useEffect(() => {
    setBillable((b) => {
      if (b <= 0) return b;
      const snapped = +(Math.round(b / step) * step).toFixed(4);
      return snapped < step ? step : snapped;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // The smallest bookable amount is a floor, not just a step: below it there is
  // nothing valid to book, so the entry drops to zero in one go rather than
  // landing on a fraction the service does not allow.
  const decBill = () => setBillable((b) => {
    const next = snap(b - step);
    return next < step ? 0 : next;
  });
  const incBill = () => setBillable((b) => snap(b + step));

  const ruleChanged = !sameRule(rep, initial.repeat ?? null);
  /** On an entry of a series, saving first asks how far the change goes. */
  const askOrSave = () => { if (error) return; if (inSeries) { setConfirmDel(false); setScopeAsk(true); } else save(); };
  const save = (scope?: "one" | "following") => {
    if (error) return;
    onSave({
      repeat: rep,
      scope: inSeries ? (ruleChanged ? "following" : scope ?? "one") : undefined,
startMin, endMin, type,
      // internal work (a type that isn't client work) never bills — for you or for whoever you bring along
      billable: isClientWork ? billable : 0,
      clientId, projectId,
      phaseId: openPhaseId,
      taskId: taskIds.join(","),
     attendees: attendeeIds.join(","),
      summoned: Object.entries(summoned).map(([id, b]) => ({ id, billable: isClientWork ? Number(b) || 0 : 0 })),
      summonNote: summonNote.trim() || undefined,
      notes,
      // Project work is one line now; the role says what it bills as.
      line: initial.line === "sales" || initial.line === "closure" ? initial.line : "consultor",
      roleId: initial.line === "closure" ? (initial.roleId ?? "") : isClientWork && projectId ? roleFor(projectId) : roleId,
      meetKind,
      date: moved ? when : undefined,
    });
  };

  const stepper = (
    <div className="bm-field bm-block">
      <label>
        Billable time to client
        {svc && <em className="bm-step-hint">min {step} {unit === "hour" ? "h" : "d"}</em>}
      </label>
      <div className="bm-stepper">
        <button type="button" className="bm-step" onClick={decBill} disabled={billable <= 0} aria-label="Decrease billable time">−</button>
        <div className="bm-step-value">
          <span className="bm-step-num">{billable.toFixed(decimals)}</span>
          <span className="bm-step-unit">{unitLabel}</span>
        </div>
        <button type="button" className="bm-step" onClick={incBill} aria-label="Increase billable time">+</button>
      </div>
    </div>
  );

if (!pickedLine) {
    return (
      <div className="bm-backdrop" onMouseDown={onClose}>
        <div className="bm-pick bm-pick5" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          <header className="bm-pick-head">
            <div>
              <span className="bm-eyebrow">Log work · {DOW_LONG[when.getDay()]}, {MONTHS_LONG[when.getMonth()]} {when.getDate()}</span>
              <h2 className="bm-pick-title">What kind of job is this?</h2>
              <p className="bm-pick-sub">Pick the role this time is logged on.</p>
            </div>
            <button className="bm-x" onClick={onClose} aria-label="Close">×</button>
          </header>
          <div className="bm-pick-body">
          <div className="bm-pick-opts">
            {!roles.some((r) => r.countsForTarget) && (
              <p className="bm-pick-none">
                You are not assigned to any role in the catalogue. You can still log
                project work: it goes on one of the roles the project was sold with.
              </p>
            )}
            {sortRoles(roles).map((r, i) => {
              const counts = roleCounts(r.id, allRoles);
              return (
                <button key={r.id} className={`bm-pick-opt is-role ${counts ? "is-con" : "is-link"}`}
                  style={{ animationDelay: `${60 + i * 50}ms`, ["--rc" as string]: colorOf(r.id) }}
                  onClick={() => pickRole(r)}>
                  <span className="bm-pick-ico">
                    {counts
                      ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
                      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>}
                  </span>
                  <span className="bm-pick-txt">
                    <span className="bm-pick-name">{r.name}</span>
                    <span className="bm-pick-note">{counts ? "Counts towards your billable target." : "Billed to the client, not to your target."}</span>
                  </span>
                  <svg className="bm-pick-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              );
            })}
            {!roles.some((r) => r.countsForTarget) && (
              <button className="bm-pick-opt is-con" style={{ animationDelay: "60ms" }} onClick={() => pickRole(null)}>
                <span className="bm-pick-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
                </span>
                <span className="bm-pick-txt">
                  <span className="bm-pick-name">Project work</span>
                  <span className="bm-pick-note">The role comes from the project you pick.</span>
                </span>
                <svg className="bm-pick-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            )}
            <button className={`bm-pick-opt is-fin ${closing ? "is-on" : ""}`} style={{ animationDelay: `${60 + Math.max(1, roles.length) * 50}ms` }}
              onClick={() => setClosing((v) => !v)} aria-expanded={closing}>
              <span className="bm-pick-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21V4h11l-1.5 4H20l-1.5 4H15v9" /></svg>
              </span>
              <span className="bm-pick-txt">
                <span className="bm-pick-name">Finalize a project</span>
                <span className="bm-pick-note">Set its end date and close it.</span>
              </span>
              <svg className="bm-pick-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </div>

          {closing && (
            <div className="bm-close">
              <div className="bm-field">
                <label>Client</label>
                <Select
                  value={closeClient}
                  onChange={(v) => { setCloseClient(v); setCloseProject(""); }}
                  options={clients.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder="Select client"
                />
              </div>
              {!!closeClient && (
                <div className="bm-field">
                  <label>Project</label>
                  <Select
                    value={closeProject}
                    onChange={setCloseProject}
                    options={openProjectsOf(closeClient).map((p) => ({ value: p.id, label: projectLabel(p) }))}
                    placeholder={openProjectsOf(closeClient).length ? "Select project" : "No open projects"}
                  />
                </div>
              )}
{!!closeProject && (
                <p className="bm-close-note">
                  End date: <strong>{DOW_LONG[when.getDay()]}, {MONTHS_LONG[when.getMonth()]} {when.getDate()}</strong>
                </p>
              )}
              <button
                className="bm-save bm-close-btn"
                onClick={doClose}
                disabled={!closeProject || closeBusy}
              >
                {closeBusy ? "Closing…" : "Close project"}
              </button>
            </div>
          )}

          </div>
          <footer className="bm-pick-foot">
            <button className="bm-cancel bm-pick-cancel" onClick={onClose}>Cancel</button>
          </footer>
        </div>
      </div>
    );
  }

  // ===== Step-by-step flow =====
  type StepId = "work" | "when" | "client" | "tasks" | "people" | "notes";
  const steps: { id: StepId; label: string }[] = [
    { id: "work", label: "Type of work" },
    { id: "when", label: "When & how" },
    ...(isClientWork ? [{ id: "client" as StepId, label: "Client & project" }, { id: "tasks" as StepId, label: "Tasks & time" }] : []),
    { id: "people", label: "People" },
    { id: "notes", label: editing ? "Notes & review" : "Review" },
  ];
  const stepIdx = Math.max(0, steps.findIndex((s) => s.id === wizStep));
  const cur = steps[stepIdx] ?? steps[0];
  const go = (id: StepId) => {
    const to = steps.findIndex((s) => s.id === id);
    setWizDir(to >= stepIdx ? 1 : -1);
    setWizStep(id);
    setConfirmDel(false);
  };
  const next = () => { const n = steps[stepIdx + 1]; if (n) go(n.id); };
  const back = () => { const p = steps[stepIdx - 1]; if (p) go(p.id); };
  const timeOk = endMin > startMin && startMin >= DAY_MIN && endMin <= DAY_MAX;
  const stepDone = (id: StepId) => seen.has(id) && id !== wizStep && stepReady(id);
  const stepReady = (id: StepId) =>
    id === "work" ? !!type
    : id === "when" ? timeOk && !(rep?.until && rep.until < isoOf(when))
    : id === "client" ? !!clientId && !!projectId
    : id === "tasks" ? true
    : id === "people" ? true
    : !!notes.trim();
  // You can jump back to anything, and forward only past steps that are ready.
  const canReach = (i: number) => editing || steps.slice(0, i).every((s) => stepReady(s.id));
  const blocker =
    cur.id === "work" ? (!type ? "Pick a type of work" : "")
    : cur.id === "when" ? (!timeOk ? (endMin <= startMin ? "Finish must be after the start" : "Between 5 AM and 9 PM") : rep?.until && rep.until < isoOf(when) ? "The repeat ends before the first day" : "")
    : cur.id === "client" ? (!clientId ? "Pick a client" : !projectId ? "Pick a project" : "")
    : "";
  const fmt = (m: number) => `${hourLabel(Math.floor(m / 60)).replace(" ", ":" + String(m % 60).padStart(2, "0") + " ")}`;
  const howOf = MEET_KINDS.find((k) => k.id === meetKind);
  const clientList = clients.filter((c) => !clientQ.trim() || c.name.toLowerCase().includes(clientQ.trim().toLowerCase()));
  const later = (fn: () => void) => window.setTimeout(fn, 220);
  /** The role the time will be saved on (on a project, always one it was sold with). */
  const curRole = project ? roleFor(project.id) : roleId;
  /** A new repeating entry books its time on every date. */
  const repTimes = !editing && rep && repCount ? repCount.n : 1;
  const budget = (() => {
    if (!project) return null;
    const signed = signedDays[`${project.id}|${curRole}`] ?? 0;
    const u = used[`${project.id}|${curRole}`] ?? { done: 0, booked: 0 };
    // The entry being edited is left out of `used`, so its time is added here as on screen.
    const left = +(signed - u.done - u.booked - billable * repTimes).toFixed(2);
    const pct = (n: number) => (signed > 0 ? Math.min(100, (n / signed) * 100) : 0);
    return { signed, u, left, pct };
  })();
  const summonedList = mates.filter((m) => m.id in summoned);
  const contactList = contacts.filter((c) => attendeeIds.includes(c.id));
  const everyone = [
    ...summonedList.map((m) => ({ key: `m${m.id}`, name: m.name, kind: "is-mate", note: isClientWork ? `${(summoned[m.id] ?? 0)}${unitShort}` : "" })),
    ...contactList.map((c) => ({ key: `c${c.id}`, name: c.name || c.email || "Contact", kind: "is-client", note: "" })),
  ];
  const roleName = curRole ? roleNameOf(curRole, allRoles) : "Project work";

  const preview: Record<StepId, string> = {
    work: selectedType?.name ?? "",
    when: timeOk ? `${fmt(startMin)} – ${fmt(endMin)} · ${durLabel}${howOf ? ` · ${howOf.label}` : ""}${rep ? ` · ${repeatLabel(rep)}` : ""}` : "",
    client: client ? [client.name, project ? projectLabel(project) : ""].filter(Boolean).join(" · ") : "",
    tasks: taskIds.length || billable ? [taskIds.length ? `${taskIds.length} task${taskIds.length > 1 ? "s" : ""}` : "", `${billable.toFixed(decimals)}${unitShort}`].filter(Boolean).join(" · ") : "",
    people: [summonedList.length ? `${summonedList.length} colleague${summonedList.length > 1 ? "s" : ""}` : "", contactList.length ? `${contactList.length} from ${client?.name ?? "client"}` : ""].filter(Boolean).join(" · "),
    notes: notes.trim() ? `${notes.trim().length} chars of notes` : "",
  };

  const panel = (() => {
    switch (cur.id) {
      case "work":
        return (
          <>
            <p className="bm6-lead">What are you spending this time on?</p>
            {types.length === 0 ? (
              <p className="bm-empty">No types of work yet — add them in Catalog, under Blueprints.</p>
            ) : (
              <div className="bm6-types">
                {types.map((t, i) => (
                  <button key={t.id} type="button" style={{ ["--tc" as string]: t.color, ["--i" as string]: i }}
                    className={`bm6-type ${type === t.id ? "is-on" : ""}`}
                    onClick={() => { pickType(t.id); later(() => { setWizDir(1); setWizStep("when"); }); }}>
                    <span className="bm6-type-dot" />
                    <span className="bm6-type-txt">
                      <b>{t.name || "Untitled type"}</b>
                      <small>{t.clientRelated ? "Client work · billable" : "Internal · not billed"}</small>
                    </span>
                    <svg className="bm6-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                  </button>
                ))}
              </div>
            )}
          </>
        );
      case "when":
        return (
          <>
            <p className="bm6-lead">When does it happen, and how?</p>
            <div className={`bm-day ${moved ? "is-moved" : ""}`}>
              <span className="bm-range-lbl">Day</span>
              <button ref={dayBtnRef} type="button" className={`bm-day-btn ${dayOpen ? "is-open" : ""}`}
                onClick={() => setDayOpen(true)}>
                <span className="bm-day-cal" aria-hidden="true">
                  <small>{MONTHS_LONG[when.getMonth()].slice(0, 3)}</small>
                  <b key={isoOf(when)} className="bm6-pop">{when.getDate()}</b>
                </span>
                <span className="bm-day-txt">
                  <b key={`d${isoOf(when)}`} className="bm6-pop">{DOW_LONG[when.getDay()]}, {MONTHS_LONG[when.getMonth()]} {when.getDate()}</b>
                  <small>{moved ? `Moved from ${DOW_LONG[day.getDay()].slice(0, 3)}, ${MONTHS_LONG[day.getMonth()].slice(0, 3)} ${day.getDate()}` : "Same times and details, any day"}</small>
                </span>
                <span className="bm-day-chg">
                  Change
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                </span>
              </button>
              {moved && (
                <button type="button" className="bm-day-undo" onClick={() => setWhen(new Date(day.getFullYear(), day.getMonth(), day.getDate()))}>
                  Undo
                </button>
              )}
              <DatePicker hideTrigger open={dayOpen} onOpenChange={setDayOpen} anchorRef={dayBtnRef}
                value={isoOf(when)}
                onChange={(iso) => { const [y, m, d] = iso.split("-").map(Number); if (y && m && d) setWhen(new Date(y, m - 1, d)); }} />
            </div>
            <div className="bm-range">
              <div className="bm-range-side">
                <span className="bm-range-lbl">Start</span>
                <TimeField hour={startH} minute={startM} onHour={setStartH} onMinute={setStartM} />
              </div>
              <span className="bm-range-sep" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M12 5l7 7-7 7" /></svg>
              </span>
              <div className="bm-range-side">
                <span className="bm-range-lbl">Finish</span>
                <TimeField hour={endH} minute={endM} onHour={setEndH} onMinute={setEndM} />
              </div>
              <div className="bm-range-dur"><span>Duration</span><b key={durLabel} className="bm6-pop">{durLabel}</b></div>
            </div>
            <label className="bm6-label">Repeat {rep && repCount && <small>{repCount.n} date{repCount.n > 1 ? "s" : ""}{rep.until ? "" : ` in the next ${Math.round(REPEAT_AHEAD_DAYS / 30)} months · keeps going`}</small>}</label>
            <div className={`bm-rep ${rep ? "is-on" : ""}`}>
              <div className="bm-rep-modes" role="radiogroup" aria-label="Repeat">
                {[
                  { id: "once", label: "Doesn't repeat" },
                  { id: "1w", label: "Every week" },
                  { id: "2w", label: "Every 2 weeks" },
                  { id: "weekdays", label: "Every weekday" },
                ].map((m) => (
                  <button key={m.id} type="button" role="radio" aria-checked={repMode === m.id}
                    className={`bm-rep-mode ${repMode === m.id ? "is-on" : ""}`} onClick={() => pickRep(m.id)}>
                    {m.id !== "once" && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" /></svg>}
                    {m.label}
                  </button>
                ))}
              </div>
              {rep && (
                <div className="bm-rep-more">
                  <div className="bm-rep-days" role="group" aria-label="On these days">
                    {WEEK_ORDER.map((d) => (
                      <button key={d} type="button" aria-pressed={rep.weekdays.includes(d)} title={DOW_LONG[d]}
                        className={`bm-rep-day ${rep.weekdays.includes(d) ? "is-on" : ""} ${d === when.getDay() ? "is-first" : ""}`}
                        onClick={() => toggleRepDay(d)}>
                        {DOW_SHORT[d].slice(0, 2)}
                      </button>
                    ))}
                  </div>
                  <div className="bm-rep-end">
                    <span className="bm-rep-k">Ends</span>
                    <div className="bm-rep-seg">
                      <button type="button" className={!rep.until ? "is-on" : ""} onClick={() => setRep({ ...rep, until: null })}>Never</button>
                      <button type="button" ref={untilRef} className={rep.until ? "is-on" : ""}
                        onClick={() => {
                          if (!rep.until) { const u = new Date(when); u.setMonth(u.getMonth() + 3); setRep({ ...rep, until: isoOf(u) }); }
                          setUntilOpen(true);
                        }}>
                        {rep.until ? (() => { const u = dayOfIso(rep.until); return `${MONTHS_LONG[u.getMonth()].slice(0, 3)} ${u.getDate()}, ${u.getFullYear()}`; })() : "On a date"}
                      </button>
                    </div>
                    <DatePicker hideTrigger open={untilOpen} onOpenChange={setUntilOpen} anchorRef={untilRef}
                      value={rep.until ?? isoOf(when)}
                      onChange={(iso) => setRep((r) => (r ? { ...r, until: iso } : r))} />
                  </div>
                  <button type="button" role="switch" aria-checked={rep.skipOff}
                    className={`bm-rep-skip ${rep.skipOff ? "is-on" : ""}`} onClick={() => setRep({ ...rep, skipOff: !rep.skipOff })}>
                    <i aria-hidden="true" />Skip holidays &amp; days off
                  </button>
                </div>
              )}
            </div>
            <label className="bm6-label">How</label>
            <div className="bm6-hows">
              {MEET_KINDS.map((k, i) => (
                <button key={k.id} type="button" style={{ ["--i" as string]: i }}
                  className={`bm6-how ${meetKind === k.id ? "is-on" : ""}`}
                  onClick={() => { setMeetKind(k.id); if (timeOk) later(next); }}>
                  <span className="bm6-how-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={k.icon} /></svg></span>
                  <b>{k.label}</b>
                  <small>{k.id === "teams" ? "Outlook adds a Teams link" : k.id === "phone" ? "A call, no room" : "At the client or the office"}</small>
                </button>
              ))}
            </div>
          </>
        );
      case "client":
        return (
          <>
            {!clientId ? (
              <>
                <p className="bm6-lead">Which client is it for?</p>
                <label className="bm6-search">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                  <input autoFocus value={clientQ} onChange={(e) => setClientQ(e.target.value)} placeholder="Search a client…" />
                </label>
                <div className="bm6-list">
                  {clientList.length === 0 && <p className="bm-empty">No client matches.</p>}
                  {clientList.map((c, i) => {
                    const n = openProjectsOf(c.id).length;
                    return (
                      <button key={c.id} type="button" className="bm6-row" style={{ ["--i" as string]: Math.min(i, 12) }}
                        onClick={() => {
                          pickClient(c.id);
                          const ps = openProjectsOf(c.id);
                          if (ps.length === 1) { pickProject(ps[0].id); later(() => { setWizDir(1); setWizStep("tasks"); }); }
                        }}>
                        <span className="bm6-av">{c.name.slice(0, 2).toUpperCase()}</span>
                        <span className="bm6-row-txt"><b>{c.name}</b><small>{n ? `${n} open project${n > 1 ? "s" : ""}` : "No open projects"}</small></span>
                        <svg className="bm6-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <button type="button" className="bm6-chosen" onClick={() => { pickClient(""); setClientQ(""); }}>
                  <span className="bm6-av">{(client?.name ?? "?").slice(0, 2).toUpperCase()}</span>
                  <span className="bm6-row-txt"><small>Client</small><b>{client?.name}</b></span>
                  <em>Change</em>
                </button>
                <p className="bm6-lead">Which project?</p>
                <div className="bm6-list">
                  {clientProjects.length === 0 && <p className="bm-empty">This client has no open projects.</p>}
                  {clientProjects.map((p, i) => {
                    const ln = roleFor(p.id);
                    const signed = signedDays[`${p.id}|${ln}`] ?? 0;
                    const u = used[`${p.id}|${ln}`] ?? { done: 0, booked: 0 };
                    const pct = signed > 0 ? Math.min(100, ((u.done + u.booked) / signed) * 100) : 0;
                    return (
                      <button key={p.id} type="button" style={{ ["--i" as string]: i }}
                        className={`bm6-row bm6-proj ${projectId === p.id ? "is-on" : ""}`}
                        onClick={() => { pickProject(p.id); later(() => { setWizDir(1); setWizStep("tasks"); }); }}>
                        <span className="bm6-row-txt">
                          <b>{projectLabel(p)}</b>
                          <small>{ln ? `${roleNameOf(ln, allRoles)} · ` : ""}{signed ? `${(u.done + u.booked).toFixed(2)} of ${signed}${unitShort} used or booked` : "No signed days on this role"}</small>
                          <span className="bm6-mini"><i style={{ width: `${pct}%` }} /></span>
                        </span>
                        <svg className="bm6-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </>
        );
      case "tasks":
        return (
          <>
            {projRoles.length > 1 && (
              <div className="bm6-roles" role="radiogroup" aria-label="Role on this project">
                <label className="bm6-label">Role on this project</label>
                <div className="bm6-roles-row">
                  {projRoles.map((l, i) => {
                    const u = used[`${project!.id}|${l.roleId}`] ?? { done: 0, booked: 0 };
                    const left = +(l.days - u.done - u.booked).toFixed(2);
                    return (
                      <button key={l.roleId} type="button" role="radio" aria-checked={curRole === l.roleId}
                        className={`bm6-role ${curRole === l.roleId ? "is-on" : ""} ${roleCounts(l.roleId, allRoles) ? "" : "is-nocount"}`}
                        style={{ ["--rc" as string]: colorOf(l.roleId), ["--i" as string]: i }}
                        onClick={() => setRoleId(l.roleId)}>
                        <i />
                        <b>{roleNameOf(l.roleId, allRoles)}</b>
                        <small>{l.days ? `${left.toFixed(decimals)}${unitShort} left` : "No days sold"}{roleCounts(l.roleId, allRoles) ? "" : " · not on your target"}</small>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <p className="bm6-lead">What did you work on, and what goes to the client?</p>
            {phases.length === 0 ? (
              <p className="bm-empty">This project has no phases yet.</p>
            ) : (
              <div className="bm-phases bm6-phases">
                {phases.map((p, i) => {
                  const open = openPhaseId === p.id;
                  const count = (p.tasks ?? []).filter((t) => taskIds.includes(t.id)).length;
                  return (
                    <div className={`bm-phase ${open ? "is-open" : ""}`} key={p.id} style={{ ["--i" as string]: i }}>
                      <button type="button" className="bm-phase-head" onClick={() => setOpenPhaseId(open ? "" : p.id)}>
                        <span className="bm-phase-num">{i + 1}</span>
                        <span className="bm-phase-name">{p.name || "Untitled phase"}</span>
                        {count > 0 && <span className="bm-phase-count">{count}</span>}
                        <span className="bm-phase-days">{p.days}{unitShort}</span>
                      </button>
                      {open && (
                        <div className="bm-tasks">
                          {(p.tasks ?? []).length === 0 ? (
                            <p className="bm-empty bm-empty-sm">No tasks in this phase.</p>
                          ) : (p.tasks ?? []).map((t) => (
                            <button key={t.id} type="button" className={`bm-task ${taskIds.includes(t.id) ? "is-sel" : ""}`} onClick={() => toggleTask(t.id)}>
                              <span className="bm-task-dot" />{t.name || "Untitled task"}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        );
      case "people":
        return (
          <>
            <p className="bm6-lead">Who else is in it? They get an invitation in the app and in Outlook.</p>
            <div className={`bm6-people ${isClientWork && project ? "has-two" : ""}`}>
              <div className="bm6-col">
                <label className="bm6-label">Colleagues {summonedList.length > 0 && <i>{summonedList.length}</i>}</label>
                <div className="bm6-list bm6-list-sm">
                  {mates.map((m) => {
                    const on = m.id in summoned;
                    return (
                      <div className={`bm-summon-row ${on ? "is-on" : ""}`} key={m.id}>
                        <button type="button" className="bm-summon-pick" onClick={() => toggleMate(m.id)}>
                          <span className="bm-person-av">{(m.name || "?").charAt(0).toUpperCase()}</span>
                          <span className="bm-person-text"><span className="bm-person-name">{m.name}</span><span className="bm-person-pos">{m.role}</span></span>
                          <span className={`bm-free ${busyMates.has(m.id) ? "is-busy" : ""}`}>{busyMates.has(m.id) ? "Busy" : "Free"}</span>
                          {on && <span className="bm-person-check">✓</span>}
                        </button>
                        {on && isClientWork && (
                          <div className="bm-summon-bill">
                            <span>bills</span>
                            <input type="number" min="0" step={step} className="cat-nospin" value={summoned[m.id]}
                              onFocus={(e) => e.target.select()}
                              onChange={(e) => setSummoned((s) => ({ ...s, [m.id]: Number(e.target.value) || 0 }))} />
                            <em>{unitShort}</em>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {summonedList.length > 0 && !isClientWork && <p className="bm-summon-free">Internal work — they join without billing anything.</p>}
                {summonedList.length > 0 && (
                  <input className="bm-summon-note" value={summonNote} onChange={(e) => setSummonNote(e.target.value)} placeholder="Add a line for them (optional)" />
                )}
              </div>
              {isClientWork && project && (
                <div className="bm6-col">
                  <label className="bm6-label">From {client?.name} {contactList.length > 0 && <i>{contactList.length}</i>}</label>
                  {contacts.length === 0 ? (
                    <p className="bm-empty bm-empty-sm">No contacts saved for this client.</p>
                  ) : (
                    <div className="bm6-list bm6-list-sm">
                      {contacts.map((c) => (
                        <button key={c.id} type="button" className={`bm-person ${attendeeIds.includes(c.id) ? "is-sel" : ""}`} onClick={() => toggleAttendee(c.id)}>
                          <span className="bm-person-av">{(c.name || "?").charAt(0).toUpperCase()}</span>
                          <span className="bm-person-text">
                            <span className="bm-person-name">{c.name || "Unnamed"}</span>
                            <span className="bm-person-pos">{[c.position, c.email].filter(Boolean).join(" · ") || "No email — not invited in Outlook"}</span>
                          </span>
                          {attendeeIds.includes(c.id) && <span className="bm-person-check">✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        );
      default:
        return (
          <>
            <label className="bm6-label" htmlFor="bm-notes-field">{isClientWork ? "Session notes" : "Notes"} <small>{notes.trim() ? `${notes.trim().length} chars` : "optional"}</small></label>
            <textarea id="bm-notes-field" className="bm-notes bm6-notes" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder={isClientWork ? "What was covered, decisions taken, blockers, follow-ups…" : "What this time was spent on — keep it logged even if it isn't billed."} />
            <div className="bm6-review">
              {steps.filter((s) => s.id !== "notes").map((s, i) => s.id === "people" ? (
                <div key={s.id} className={`bm6-rv bm6-rv-people ${everyone.length ? "" : "is-empty"} ${peopleOpen ? "is-open" : ""}`} style={{ ["--i" as string]: i }}>
                  <small>{s.label}</small>
                  {everyone.length === 0 ? <b>—</b> : (
                    <div className="bm6-who">
                      {(peopleOpen ? everyone : everyone.slice(0, 3)).map((p) => (
                        <span key={p.key} className={`bm6-who-chip ${p.kind}`}>
                          <i>{(p.name || "?").charAt(0).toUpperCase()}</i>{p.name}
                          {p.note && <u>{p.note}</u>}
                        </span>
                      ))}
                      {!peopleOpen && everyone.length > 3 && (
                        <span className="bm6-more" tabIndex={0} role="button" onClick={() => setPeopleOpen(true)}
                          onKeyDown={(e) => { if (e.key === "Enter") setPeopleOpen(true); }}>
                          +{everyone.length - 3}
                          <span className="bm6-more-pop" role="tooltip">
                            {everyone.slice(3).map((p) => <span key={p.key}><i>{(p.name || "?").charAt(0).toUpperCase()}</i>{p.name}</span>)}
                          </span>
                        </span>
                      )}
                      {peopleOpen && everyone.length > 3 && <button type="button" className="bm6-less" onClick={() => setPeopleOpen(false)}>Show less</button>}
                    </div>
                  )}
                  <button type="button" className="bm6-rv-edit" onClick={() => go("people")}>Edit</button>
                </div>
              ) : (
                <button type="button" key={s.id} className={`bm6-rv ${preview[s.id] ? "" : "is-empty"}`} style={{ ["--i" as string]: i }} onClick={() => go(s.id)}>
                  <small>{s.label}</small>
                  <b>{preview[s.id] || "—"}</b>
                  <em>Edit</em>
                </button>
              ))}
            </div>
            {picked.length > 0 && (
              <div className="bm6-chips">{picked.map((p) => <span key={p.taskId}>{p.taskName}<i>{p.phaseName}</i></span>)}</div>
            )}
          </>
        );
    }
  })();

  return (
    <div className="bm-backdrop" onMouseDown={onClose}>
      <div className="bm6" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        {/* Left: the steps, each with what you picked, and a live summary */}
        <aside className="bm6-rail">
          <div className="bm6-rail-head">
            <span className="bm-eyebrow">{editing ? "Edit entry" : "Log work"} · {roleName}</span>
            <h2 key={isoOf(when)} className="bm6-pop">{DOW_LONG[when.getDay()]}, {MONTHS_LONG[when.getMonth()]} {when.getDate()}</h2>
            {!editing && (
              <button type="button" className="bm6-line" onClick={() => setPickedLine(false)}>Change job type</button>
            )}
          </div>
          <ol className="bm6-steps">
            {steps.map((s, i) => {
              const done = stepDone(s.id);
              const on = s.id === cur.id;
              const reach = canReach(i);
              return (
                <li key={s.id} className={`bm6-step ${on ? "is-on" : ""} ${done ? "is-done" : ""} ${reach ? "" : "is-locked"}`} style={{ ["--i" as string]: i }}>
                  <button type="button" disabled={!reach} onClick={() => go(s.id)}>
                    <span className="bm6-step-n">{done && !on ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg> : i + 1}</span>
                    <span className="bm6-step-txt">
                      <b>{s.label}</b>
                      {preview[s.id] && <small key={preview[s.id]}>{preview[s.id]}</small>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="bm6-sum">
            <div className="bm6-sum-row">
              <span>Billable</span>
              <b key={billable}>{isClientWork ? `${billable.toFixed(decimals)} ${unitLabel}` : "Not billed"}</b>
            </div>
            {isClientWork && repTimes > 1 && billable > 0 && (
              <div className="bm6-sum-rep">× {repTimes} dates{rep && !rep.until ? ` in ${Math.round(REPEAT_AHEAD_DAYS / 30)} months` : ""} · {(billable * repTimes).toFixed(decimals)}{unitShort} in all</div>
            )}
            {budget && budget.signed > 0 && (
              <div className="bm6-budget">
                <div className="bm6-budget-track">
                  <i className="is-booked" style={{ width: `${budget.pct(budget.u.done + budget.u.booked + billable * repTimes)}%` }} />
                  <i className="is-done" style={{ width: `${budget.pct(budget.u.done)}%` }} />
                </div>
                <span className={budget.left < 0 ? "is-over" : ""}>
                  {budget.left < 0 ? `${Math.abs(budget.left).toFixed(decimals)}${unitShort} over the signed ${budget.signed}${unitShort}` : `${budget.left.toFixed(decimals)}${unitShort} left of ${budget.signed}${unitShort}`}
                </span>
              </div>
            )}
            {(summonedList.length > 0 || contactList.length > 0) && (
              <div className="bm6-faces">
                {[...summonedList.map((m) => m.name), ...contactList.map((c) => c.name)].slice(0, 6).map((n, i) => (
                  <i key={`${n}${i}`} title={n} style={{ ["--i" as string]: i }}>{(n || "?").charAt(0).toUpperCase()}</i>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Right: the step you are on */}
        <section className="bm6-main">
          <header className="bm6-head">
            <div>
              <small>Step {stepIdx + 1} of {steps.length}</small>
              <h3>{cur.label}</h3>
            </div>
            <div className="bm6-prog"><i style={{ width: `${((stepIdx + 1) / steps.length) * 100}%` }} /></div>
            <button className="bm-x bm6-x" onClick={onClose} aria-label="Close">×</button>
          </header>
          <div key={cur.id} className={`bm6-body ${wizDir === 1 ? "is-fwd" : "is-back"}`}>{panel}</div>
          {/* Always in view on the tasks step, however many phases there are. */}
          {cur.id === "tasks" && <div className="bm6-pinned">{stepper}</div>}
          <footer className="bm6-foot">
            {scopeAsk ? (
              <div className="bm6-confirm bm6-scope">
                <span className="bm6-scope-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" /></svg></span>
                <span>{ruleChanged ? (rep ? "The repeat changed — it applies from this one on." : "Stop repeating after this one?") : "This entry repeats. Save the change for…"}</span>
                <button type="button" className="bm6-keep" onClick={() => setScopeAsk(false)}>Back</button>
                {!ruleChanged && <button type="button" className="bm6-keep is-alt" onClick={() => save("one")}>Only this one</button>}
                <button type="button" className="bm6-go-all" onClick={() => save("following")}>{ruleChanged ? "Save from here" : "This and the ones after"}</button>
              </div>
            ) : editing && onDelete ? (
              confirmDel ? (
                <div className="bm6-confirm">
                  <span>{inSeries ? "Delete just this one, or this and the ones after it?" : `Delete this entry${entryId ? " (and its Outlook event)" : ""}?`}</span>
                  <button type="button" className="bm6-keep" onClick={() => setConfirmDel(false)}>Keep it</button>
                  {inSeries ? (
                    <>
                      <button type="button" className="bm6-kill is-soft" onClick={() => onDelete("one")}>Only this one</button>
                      <button type="button" className="bm6-kill" onClick={() => onDelete("following")}>This and after</button>
                    </>
                  ) : <button type="button" className="bm6-kill" onClick={() => onDelete()}>Yes, delete</button>}
                </div>
              ) : (
                <button className="bm-delete" onClick={() => setConfirmDel(true)}>Delete</button>
              )
            ) : <span />}
            {!confirmDel && !scopeAsk && (
              <div className="bm6-foot-r">
                {blocker && <span className="bm6-hint">{blocker}</span>}
                {stepIdx > 0 ? <button className="bm-cancel" onClick={back}>Back</button> : <button className="bm-cancel" onClick={onClose}>Cancel</button>}
                {editing && cur.id !== "notes" && <button className="bm-cancel bm6-save-now" onClick={askOrSave} disabled={!!error}>Save</button>}
                {cur.id === "notes" ? (
                  <button className="bm-save" onClick={askOrSave} disabled={!!error} title={error ?? undefined}>{editing ? "Save changes" : rep && repCount && repCount.n > 1 ? `Add ${repCount.n} entries` : "Add entry"}</button>
                ) : (
                  <button className="bm-save" onClick={next} disabled={!!blocker}>Continue</button>
                )}
              </div>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}
