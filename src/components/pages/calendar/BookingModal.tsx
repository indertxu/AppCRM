import { useEffect, useRef, useState } from "react";
import type { WorkTypeDef } from "./CalendarSettingsModal";
import type { Client, Project, ProjectType } from "../clients/ClientsPage";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import { supabase } from "../../api/supabase";
import { busyAt } from "./invitesApi";
import { useAuth } from "../../api/AuthProvider";
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
}

interface BookingModalProps {
  day: Date;
  editing: boolean;
  /** The entry being edited, so its invitations can be loaded and changed. */
  entryId?: string | null;
  types: WorkTypeDef[];
  initial: BookingValue;
  onSave: (v: BookingValue) => void;
  onDelete?: () => void;
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
  day, editing, entryId, types, initial, onSave, onDelete, onClose,
}: BookingModalProps) {
  const [startH, setStartH] = useState(Math.floor(initial.startMin / 60));
  const [startM, setStartM] = useState(initial.startMin % 60);
  const [endH, setEndH] = useState(Math.floor(initial.endMin / 60));
  const [endM, setEndM] = useState(initial.endMin % 60);
  const [type, setType] = useState<string>(initial.type || types[0]?.id || "");
  const [billable, setBillable] = useState(initial.billable);

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
  const [line, setLine] = useState(initial.line ?? "");
  const [roleId, setRoleId] = useState(initial.roleId ?? "");
  const [roles, setRoles] = useState<{ id: string; name: string; is_supervision: boolean }[]>([]);
  /** Rate unit and smallest bookable amount, per service, from the catalogue. */
  const [svcUnits, setSvcUnits] = useState<Record<string, { unit: "hour" | "day"; min: number }>>({});
const [pickedLine, setPickedLine] = useState(editing || !!initial.line);
  const [closing, setClosing] = useState(false);
  const [closeClient, setCloseClient] = useState("");
  const [closeProject, setCloseProject] = useState("");
const closeDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const [closeBusy, setCloseBusy] = useState(false);
  /**
   * Colleagues summoned to this meeting. The organiser decides what each of
   * them bills for attending, which is why it is a map and not a list.
   */
  const [summoned, setSummoned] = useState<Record<string, number>>({});
  const [summonNote, setSummonNote] = useState("");
  /** How the time is spent: on a call, on Teams, or in the room. */
  const [meetKind, setMeetKind] = useState<string>(initial.meetKind ?? "in_person");
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
  /** Folded when editing, since the type is already decided; open when logging
   *  new work, where the list is the first thing you need. */
  const [typesOpen, setTypesOpen] = useState(!editing);
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
      return { ...m, [id]: billable };
    });

  const [attendeeIds, setAttendeeIds] = useState<string[]>(
    initial.attendees ? initial.attendees.split(",").filter(Boolean) : []
  );

  // Options come from the roles defined in the catalogue, filtered to the ones
  // this person is assigned to there. Each role still maps to a billing line,
  // because Backlog, Billing and Bonus all group by that.
  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id ?? "";
      const { data } = await supabase.from("client_roles").select("id, name, is_supervision, user_ids").order("name");
      setRoles(((data ?? []) as any[]).filter((r) => (Array.isArray(r.user_ids) ? r.user_ids : []).includes(uid)));
    })();
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

  const pickRole = (r: { id: string; name: string; is_supervision: boolean }) => {
    setLine(r.is_supervision ? "supervision" : "consultor");
    setRoleId(r.id);
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
setSignedDays(Object.fromEntries(((ps ?? []) as Record<string, unknown>[]).flatMap((r) => [
     [`${r.id}|consultor`, Number(r.consultor_days) || 0],
        [`${r.id}|connector`, Number(r.connector_days) || 0],
        [`${r.id}|supervision`, Number(r.supervision_days) || 0],
      ])));

      const { data: ce } = await supabase.from("calendar_entries").select("id, project_id, billable, status, billing_line");
      const { data: ea } = await supabase.from("entry_actuals").select("entry_id, actual_billable");
      const actualMap = Object.fromEntries(((ea ?? []) as Record<string, unknown>[])
        .map((r) => [r.entry_id as string, Number(r.actual_billable) || 0]));
      const agg: Record<string, { done: number; booked: number }> = {};
      ((ce ?? []) as Record<string, unknown>[]).forEach((r) => {
        const pid = r.project_id as string | null;
        if (!pid || r.status === "cancelled") return;
const v = actualMap[r.id as string] ?? (Number(r.billable) || 0);
        const k = `${pid}|${(r.billing_line as string) || "consultor"}`;
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
  const showPanel = isClientWork && !!project;
  const projectLabel = (p: Project) => {
    const t = projectTypes.find((x) => x.id === p.projectTypeId)?.name ?? "Project";
    return p.kickoffDate ? `${t} · ${p.kickoffDate}` : t;
  };
  const showThird = showPanel && taskIds.length > 0;
  // Colleagues can be summoned to anything that takes up time, not just client
  // work, so internal bookings and meetings open the same panel. Client work
  // still waits until tasks are picked, since the panel summarises them.
  const showAside = showThird || (!!selectedType && !isClientWork);
  // Notes should be available for any work, including non-client (still logged, just not billed).
  const showNotes = !!selectedType && (showThird || !isClientWork);

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
  };

const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;

  /** Who is already booked while this entry runs. Busy or not, nothing more. */
  const [busyMates, setBusyMates] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!mates.length) return;
    const d = day;
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    busyAt(mates.map((m) => m.id), iso, startMin, endMin).then(setBusyMates).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mates, day, startMin, endMin]);

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
      date_key: `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`,
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

  const save = () => {
    if (error) return;
    onSave({
startMin, endMin, type, billable, clientId, projectId,
      phaseId: openPhaseId,
      taskId: taskIds.join(","),
     attendees: attendeeIds.join(","),
      summoned: Object.entries(summoned).map(([id, b]) => ({ id, billable: Number(b) || 0 })),
      summonNote: summonNote.trim() || undefined,
      notes,
      line: line || "consultor",
      roleId,
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

 // Notes no longer live in a fourth panel, so the shell only shifts for the side one.
 // The summary panel counts too: with it open the set is 1572 wide, so the
 // shift has to match or it hangs off the right of the screen.
 // Three panels for client work; card + summon panel only for internal work,
 // which sits right beside the card instead of leaving a gap where the
 // client/phase panel would have been.
 const shellClass = `bm-shell ${
   showThird ? "has-third" : showAside ? "has-third-only" : showPanel ? "has-side" : ""
 }`;

if (!pickedLine) {
    return (
      <div className="bm-backdrop" onMouseDown={onClose}>
        <div className="bm-pick" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          <span className="bm-eyebrow">Log work</span>
          <h2 className="bm-pick-title">What kind of day is this?</h2>
          <div className="bm-pick-opts">
            {roles.length === 0 && (
              <p className="bm-pick-none">
                You are not assigned to any role in the catalogue, so there is no
                consultancy line to log against. Ask a manager to add you.
              </p>
            )}
            {roles.map((r, i) => (
              <button key={r.id} className="bm-pick-opt" style={{ animationDelay: `${i * 45}ms` }}
                onClick={() => pickRole(r)}>
                <span className="bm-pick-ico">{r.is_supervision ? "🧭" : "👤"}</span>
                <span className="bm-pick-name">{r.name}</span>
                <span className="bm-pick-note">
                  {r.is_supervision ? "Billed at the supervision rate." : "Counts towards your billable target."}
                </span>
              </button>
            ))}
            <button className="bm-pick-opt" style={{ animationDelay: `${roles.length * 45}ms` }}
              onClick={() => { setLine("connector"); setRoleId(""); setPickedLine(true); }}>
              <span className="bm-pick-ico">🔗</span>
              <span className="bm-pick-name">Connector</span>
              <span className="bm-pick-note">Billed to the client, not to your target.</span>
            </button>
            <button className="bm-pick-opt" onClick={() => setClosing(true)}>
              <span className="bm-pick-ico">🏁</span>
              <span className="bm-pick-name">Finalize a project</span>
              <span className="bm-pick-note">Set its end date and close it.</span>
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
                  End date: <strong>{DOW_LONG[day.getDay()]}, {MONTHS_LONG[day.getMonth()]} {day.getDate()}</strong>
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

          <button className="bm-cancel bm-pick-cancel" onClick={onClose}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="bm-backdrop" onMouseDown={onClose}>
      <div className={shellClass} onMouseDown={(e) => e.stopPropagation()}>
        <div className="bm-card" role="dialog" aria-modal="true">
          <div className="bm-head">
            <div>
           <span className="bm-eyebrow">
                {editing ? "Edit entry" : "Log work"} · {line === "connector"
                  ? "Connector"
                  : roles.find((r) => r.id === roleId)?.name ?? (line === "supervision" ? "Project management" : "Consultor")}
              </span>
              <h2 className="bm-date">
                {DOW_LONG[day.getDay()]}, {MONTHS_LONG[day.getMonth()]} {day.getDate()}
              </h2>
            </div>
            <button className="bm-x" onClick={onClose} aria-label="Close">×</button>
          </div>

          {/* One control, not four boxes: the range reads left to right and the
              duration is part of the same block. */}
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

            <div className="bm-range-dur">
              <span>Duration</span>
              <b>{durLabel}</b>
            </div>
          </div>


          <div className="bm-field bm-block">
            <label>Type of work</label>
            {types.length === 0 ? (
              <p className="bm-empty">No types of work yet — add them in Catalog, under Blueprints.</p>
            ) : (
              /* Once picked, the list folds down to the chosen one. Clicking it
                 again opens the list back up, so the card never needs to scroll. */
              <div className={`bm-types ${type && !typesOpen ? "is-folded" : ""}`}>
                {(type && !typesOpen ? types.filter((x) => x.id === type) : types).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`bm-type ${type === t.id ? "is-sel" : ""}`}
                    style={type === t.id ? { borderColor: t.color, background: `${t.color}1a` } : undefined}
                    onClick={() => {
                      if (type === t.id && !typesOpen) { setTypesOpen(true); return; }
                      pickType(t.id);
                      setTypesOpen(false);
                    }}
                  >
                    <span className="bm-dot" style={{ background: t.color }} />
                    <span className="bm-type-name">{t.name || "Untitled type"}</span>
                    {!t.clientRelated && <span className="bm-type-tag">Non-client</span>}
                    {type === t.id && (
                      <svg className="bm-type-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d={typesOpen ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="bm-field bm-block">
            <label>How</label>
            <div className="bm-hows">
              {MEET_KINDS.map((k) => (
                <button key={k.id} type="button"
                  className={`bm-how ${meetKind === k.id ? "is-on" : ""}`}
                  onClick={() => setMeetKind(k.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={k.icon} /></svg>
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          {isClientWork && (
            <div className="bm-field bm-block">
              <label>Client</label>
              <Select
                value={clientId}
                onChange={pickClient}
                options={clients.map((c) => ({ value: c.id, label: c.name }))}
                placeholder="Select client"
              />
            </div>
          )}

          {isClientWork && !!clientId && (
            <div className="bm-field bm-block">
              <label>Project</label>
              <Select
                value={projectId}
                onChange={pickProject}
                options={clientProjects.map((p) => ({ value: p.id, label: projectLabel(p) }))}
                placeholder={clientProjects.length ? "Select project" : "No projects for this client"}
              />
            </div>
          )}

          {error && <p className="bm-error">{error}</p>}

            {/* Inside the card, above the buttons: as a sibling of the card it
                rendered outside the white panel entirely. */}
          {showNotes && (
            <div className="bm-notesbar">
              <label className="bm-notesbar-label" htmlFor="bm-notes-field">
                {isClientWork ? "Session notes" : "Notes"}
                <span>{notes.trim().length > 0 ? `${notes.trim().length} chars` : "optional"}</span>
              </label>
              <textarea
                id="bm-notes-field"
                className="bm-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={isClientWork
                  ? "What was covered, decisions taken, blockers, follow-ups…"
                  : "What this time was spent on — keep it logged even if it isn't billed."}
              />
            </div>
          )}
          <div className="bm-actions">
            {editing && onDelete ? (
              <button className="bm-delete" onClick={onDelete}>Delete</button>
            ) : (<span />)}
            <div className="bm-actions-right">
              <button className="bm-cancel" onClick={onClose}>Cancel</button>
              <button className="bm-save" onClick={save} disabled={!!error}>
                {editing ? "Save changes" : "Add entry"}
              </button>
            </div>
          </div>
        </div>

        {/* Panel 2 — phases & tasks */}
        {showPanel && (
<aside className="bm-side" key={projectId}>
            <div className="bm-side-head">
              <span className="bm-eyebrow">Working on</span>
              <h3 className="bm-side-title">{client?.name}</h3>
<p className="bm-side-sub">{project ? projectLabel(project) : ""}</p>
              {project && (() => {
const ln = line || "consultor";
                const signed = signedDays[`${project.id}|${ln}`] ?? 0;
                const u = used[`${project.id}|${ln}`] ?? { done: 0, booked: 0 };
                const left = +(signed - u.done - u.booked).toFixed(2);
                const pct = (n: number) => (signed > 0 ? Math.min(100, (n / signed) * 100) : 0);
                return (
                  <div className="bm-budget">
                    <div className="bm-budget-track">
                      <div className="bm-budget-fill" style={{ width: `${pct(u.done + u.booked)}%` }} />
                      <div className="bm-budget-fill is-done" style={{ width: `${pct(u.done)}%` }} />
                    </div>
                    <div className="bm-budget-row">
                      <span>{u.done.toFixed(2)} used · {u.booked.toFixed(2)} booked · {signed} signed</span>
                      <strong className={left < 0 ? "is-over" : ""}>
                        {left < 0
                          ? `${Math.abs(left).toFixed(decimals)}${unitShort} over`
                          : `${left.toFixed(decimals)}${unitShort} left`}
                      </strong>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="bm-side-body">
              <label className="bm-side-label">Phase &amp; tasks</label>
              {phases.length === 0 ? (
                <p className="bm-empty">This client has no phases yet.</p>
              ) : (
                <div className="bm-phases">
                  {phases.map((p, i) => {
                    const open = openPhaseId === p.id;
                    const count = (p.tasks ?? []).filter((t) => taskIds.includes(t.id)).length;
                    return (
                      <div className={`bm-phase ${open ? "is-open" : ""}`} key={p.id}>
                        <button
                          type="button"
                          className="bm-phase-head"
                          onClick={() => setOpenPhaseId(open ? "" : p.id)}
                        >
                          <span className="bm-phase-num">{i + 1}</span>
                          <span className="bm-phase-name">{p.name || "Untitled phase"}</span>
                          {count > 0 && <span className="bm-phase-count">{count}</span>}
                          <span className="bm-phase-days">{p.days}{unitShort}</span>
                        </button>
                        {open && (
                          <div className="bm-tasks">
                            {(p.tasks ?? []).length === 0 ? (
                              <p className="bm-empty bm-empty-sm">No tasks in this phase.</p>
                            ) : (
                              (p.tasks ?? []).map((t) => (
                                <button
                                  key={t.id}
                                  type="button"
                                  className={`bm-task ${taskIds.includes(t.id) ? "is-sel" : ""}`}
                                  onClick={() => toggleTask(t.id)}
                                >
                                  <span className="bm-task-dot" />
                                  {t.name || "Untitled task"}
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="bm-side-sep" />
              {stepper}
            </div>
          </aside>
        )}

        {/* Panel 3 — summary + attendees */}
        {showAside && (
          <aside className="bm-third">
            <div className="bm-side-head">
              <span className="bm-eyebrow">{showThird ? "Summary" : "Who is coming"}</span>
              <h3 className="bm-side-title">
                {showThird
                  ? `${picked.length} task${picked.length > 1 ? "s" : ""} selected`
                  : selectedType?.name ?? "Internal work"}
              </h3>
            </div>

            <div className="bm-side-body">
              {showThird && (
                <>
                  <label className="bm-side-label">Selected work</label>
                  <div className="bm-picked-list">
                    {picked.map((p) => (
                      <div className="bm-picked-row" key={p.taskId}>
                        <span className="bm-picked-text">
                          <span className="bm-picked-task">{p.taskName}</span>
                          <span className="bm-picked-phase">{p.phaseName}</span>
                        </span>
                        <button
                          type="button"
                          className="bm-picked-x"
                          onClick={() => toggleTask(p.taskId)}
                          aria-label="Remove task"
                        >×</button>
                      </div>
                    ))}
                  </div>

                  <div className="bm-side-sep" />
                </>
              )}

              {/* Summon colleagues: they get an invitation to accept, and the
                  organiser decides what each of them bills for being there. */}
              <div className="bm-summon">
                <label className="bm-side-label">
                  Summon colleagues
                  {Object.keys(summoned).length > 0 && <i>{Object.keys(summoned).length}</i>}
                </label>

                <div className="bm-summon-list">
                  {mates.map((m) => {
                    const on = m.id in summoned;
                    return (
                      <div className={`bm-summon-row ${on ? "is-on" : ""}`} key={m.id}>
                        <button type="button" className="bm-summon-pick" onClick={() => toggleMate(m.id)}>
                          <span className="bm-person-av">{(m.name || "?").charAt(0).toUpperCase()}</span>
                          <span className="bm-person-text">
                            <span className="bm-person-name">{m.name}</span>
                            <span className="bm-person-pos">{m.role}</span>
                          </span>
                          <span className={`bm-free ${busyMates.has(m.id) ? "is-busy" : ""}`}>
                            {busyMates.has(m.id) ? "Busy" : "Free"}
                          </span>
                          {on && <span className="bm-person-check">✓</span>}
                        </button>

                        {on && (
                          <div className="bm-summon-bill">
                            <span>bills</span>
                            <input type="number" min="0" step={step} className="cat-nospin"
                              value={summoned[m.id]}
                              onFocus={(e) => e.target.select()}
                              onChange={(e) => setSummoned((s) => ({ ...s, [m.id]: Number(e.target.value) || 0 }))} />
                            <em>{unitShort}</em>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {Object.keys(summoned).length > 0 && (
                  <input className="bm-summon-note" value={summonNote}
                    onChange={(e) => setSummonNote(e.target.value)}
                    placeholder="Add a line for them (optional)" />
                )}
              </div>

              {showThird && (
                <>
                  <div className="bm-side-sep" />

                  <div className="bm-people">
                    <label className="bm-side-label">People from {client?.name}</label>
                    {contacts.length === 0 ? (
                      <p className="bm-empty bm-empty-sm">No contacts saved for this client.</p>
                    ) : (
                      <div className="bm-people-list">
                        {contacts.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className={`bm-person ${attendeeIds.includes(c.id) ? "is-sel" : ""}`}
                            onClick={() => toggleAttendee(c.id)}
                          >
                            <span className="bm-person-av">{(c.name || "?").charAt(0).toUpperCase()}</span>
                            <span className="bm-person-text">
                              <span className="bm-person-name">{c.name || "Unnamed"}</span>
                              {c.position && <span className="bm-person-pos">{c.position}</span>}
                            </span>
                            {attendeeIds.includes(c.id) && <span className="bm-person-check">✓</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </aside>
        )}

      </div>
    </div>
  );
}