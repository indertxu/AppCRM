import { useEffect, useState } from "react";
import type { WorkTypeDef } from "./CalendarSettingsModal";
import type { Client, Project, ProjectType } from "../clients/ClientsPage";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import { supabase } from "../../api/supabase";
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
  phaseId: string;
  taskId: string;
  attendees: string;
}

interface BookingModalProps {
  day: Date;
  editing: boolean;
  types: WorkTypeDef[];
  initial: BookingValue;
  onSave: (v: BookingValue) => void;
  onDelete?: () => void;
  onClose: () => void;
}

export default function BookingModal({
  day, editing, types, initial, onSave, onDelete, onClose,
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
const [pickedLine, setPickedLine] = useState(editing || !!initial.line);
  const [closing, setClosing] = useState(false);
  const [closeClient, setCloseClient] = useState("");
  const [closeProject, setCloseProject] = useState("");
const closeDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const [closeBusy, setCloseBusy] = useState(false);
  const [attendeeIds, setAttendeeIds] = useState<string[]>(
    initial.attendees ? initial.attendees.split(",").filter(Boolean) : []
  );

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
        projectTypeId: (r.project_type_id as string) ?? "",
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

      const { data: pt } = await supabase.from("project_types").select("*");
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
  const phases = project?.phases ?? [];
  const contacts = project?.contacts ?? [];
  const showPanel = isClientWork && !!project;
  const projectLabel = (p: Project) => {
    const t = projectTypes.find((x) => x.id === p.projectTypeId)?.name ?? "Project";
    return p.kickoffDate ? `${t} · ${p.kickoffDate}` : t;
  };
  const showThird = showPanel && taskIds.length > 0;

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
    if (!t?.clientRelated) {
      setClientId(""); setProjectId(""); setOpenPhaseId(""); setTaskIds([]); setAttendeeIds([]);
      setBillable(0); // non-client work is never billable
    }
  };
  const pickClient = (id: string) => {
    setClientId(id); setProjectId(""); setOpenPhaseId(""); setTaskIds([]); setAttendeeIds([]);
  };
  const pickProject = (id: string) => {
    setProjectId(id); setOpenPhaseId(""); setTaskIds([]); setAttendeeIds([]);
  };

const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;

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

  const decBill = () => setBillable((b) => Math.max(0, +(b - 0.25).toFixed(2)));
  const incBill = () => setBillable((b) => +(b + 0.25).toFixed(2));

  const save = () => {
    if (error) return;
    onSave({
      startMin, endMin, type,
      billable: isClientWork ? billable : 0,
      clientId, projectId,
      phaseId: openPhaseId,
      taskId: taskIds.join(","),
     attendees: attendeeIds.join(","),
      notes,
      line: line || "consultor",
    });
  };

  const stepper = (
    <div className="bm-field bm-block">
      <label>Billable time to client</label>
      {isClientWork ? (
        <>
          <div className="bm-stepper">
            <button type="button" className="bm-step" onClick={decBill} disabled={billable <= 0} aria-label="Decrease billable time">−</button>
            <div className="bm-step-value">
              <span className="bm-step-num">{billable.toFixed(2)}</span>
              <span className="bm-step-unit">days</span>
            </div>
            <button type="button" className="bm-step" onClick={incBill} aria-label="Increase billable time">+</button>
          </div>
          {billable === 0 && (
            <span className="bm-step-hint">Logged as client work, but not billed.</span>
          )}
        </>
      ) : (
        <div className="bm-nonbill">
          <span className="bm-nonbill-num">0.00 days</span>
          <span className="bm-nonbill-note">Non-client work — never billable.</span>
        </div>
      )}
    </div>
  );

 const shellClass = `bm-shell ${showThird ? "has-fourth" : showPanel ? "has-side" : ""}`;

if (!pickedLine) {
    return (
      <div className="bm-backdrop" onMouseDown={onClose}>
        <div className="bm-pick" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          <span className="bm-eyebrow">Log work</span>
          <h2 className="bm-pick-title">What kind of day is this?</h2>
          <div className="bm-pick-opts">
            <button className="bm-pick-opt" onClick={() => { setLine("consultor"); setPickedLine(true); }}>
              <span className="bm-pick-ico">👤</span>
              <span className="bm-pick-name">Consultor</span>
              <span className="bm-pick-note">Counts towards your billable target.</span>
            </button>
<button className="bm-pick-opt" onClick={() => { setLine("connector"); setPickedLine(true); }}>
              <span className="bm-pick-ico">🔗</span>
              <span className="bm-pick-name">Connector</span>
              <span className="bm-pick-note">Billed to the client, not to your target.</span>
            </button>
          <button className="bm-pick-opt" onClick={() => { setLine("supervision"); setPickedLine(true); }}>
              <span className="bm-pick-ico">🧭</span>
              <span className="bm-pick-name">Project management</span>
              <span className="bm-pick-note">Billed at the supervision rate.</span>
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
                {editing ? "Edit entry" : "Log work"} · {line === "connector" ? "Connector" : "Consultor"}
              </span>
              <h2 className="bm-date">
                {DOW_LONG[day.getDay()]}, {MONTHS_LONG[day.getMonth()]} {day.getDate()}
              </h2>
            </div>
            <button className="bm-x" onClick={onClose} aria-label="Close">×</button>
          </div>

          <div className="bm-times">
            <div className="bm-field">
              <label>Start</label>
              <div className="bm-time">
                <select value={startH} onChange={(e) => setStartH(Number(e.target.value))}>
                  {MODAL_HOURS.map((h) => (<option key={h} value={h}>{hourLabel(h)}</option>))}
                </select>
                <span className="bm-colon">:</span>
                <select value={startM} onChange={(e) => setStartM(Number(e.target.value))}>
                  {MINUTES.map((m) => (<option key={m} value={m}>{String(m).padStart(2, "0")}</option>))}
                </select>
              </div>
            </div>

            <div className="bm-arrow">→</div>

            <div className="bm-field">
              <label>Finish</label>
              <div className="bm-time">
                <select value={endH} onChange={(e) => setEndH(Number(e.target.value))}>
                  {MODAL_HOURS.map((h) => (<option key={h} value={h}>{hourLabel(h)}</option>))}
                </select>
                <span className="bm-colon">:</span>
                <select value={endM} onChange={(e) => setEndM(Number(e.target.value))}>
                  {MINUTES.map((m) => (<option key={m} value={m}>{String(m).padStart(2, "0")}</option>))}
                </select>
              </div>
            </div>
          </div>

          <div className="bm-dur-row">
            <span className="bm-dur-label">Duration</span>
            <span className="bm-dur">{durLabel}</span>
          </div>

          <div className="bm-field bm-block">
            <label>Type of work</label>
            {types.length === 0 ? (
              <p className="bm-empty">No types of work yet — add them in calendar settings (⚙).</p>
            ) : (
              <div className="bm-types">
                {types.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`bm-type ${type === t.id ? "is-sel" : ""}`}
                    style={type === t.id ? { borderColor: t.color, background: `${t.color}1a` } : undefined}
                    onClick={() => pickType(t.id)}
                  >
                    <span className="bm-dot" style={{ background: t.color }} />
                    <span className="bm-type-name">{t.name || "Untitled type"}</span>
                    {!t.clientRelated && <span className="bm-type-tag">Non-client</span>}
                  </button>
                ))}
              </div>
            )}
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

          {!isClientWork && stepper}

          {error && <p className="bm-error">{error}</p>}

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
                        {left < 0 ? `${Math.abs(left).toFixed(2)}d over` : `${left.toFixed(2)}d left`}
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
                          <span className="bm-phase-days">{p.days}d</span>
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
        {showThird && (
          <aside className="bm-third">
            <div className="bm-side-head">
              <span className="bm-eyebrow">Summary</span>
              <h3 className="bm-side-title">{picked.length} task{picked.length > 1 ? "s" : ""} selected</h3>
            </div>

            <div className="bm-side-body">
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
            </div>
          </aside>
        )}

        {/* Panel 4 — notes */}
        {showThird && (
          <aside className="bm-fourth">
            <div className="bm-side-head">
              <span className="bm-eyebrow">Notes</span>
              <h3 className="bm-side-title">Session notes</h3>
            </div>
            <div className="bm-side-body">
              <textarea
                className="bm-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What was covered, decisions taken, blockers, follow-ups…"
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}