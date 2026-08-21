/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../framework/DatePicker";
import TimePicker from "../../framework/TimePicker";
import Select from "../../framework/Select";
import MentionInput, { type MentionPerson } from "../../framework/MentionInput";
import "../../framework/MentionInput.css";

// Convert serialized mentions "@[Name](id)" into plain "@Name".
const cleanMentionsFn = (t: string) => t.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
import { supabase } from "../../api/supabase";
import { loadPipeline, listPipelines, type Phase, type Pipeline } from "../settings/pipelineApi";
import { loadServices, type Service } from "../settings/catalogApi";
import type { Company, Contact } from "../companies/companiesApi";
import type { Product } from "../settings/catalogApi";
import type { Employee } from "./SalesPage";
import {
  setTrackingPhase, setTrackingStatus, deleteTracking,
  loadNotes, addNote, updateNote, deleteNote,
  loadTasks, addTask, toggleTask, updateTask, deleteTask,
  loadMeetings, addMeeting, updateMeeting, deleteMeeting,
  loadPhaseEvents, stampPhaseEntry, clearPhaseEventsAfter,
  setProductPrice, loadPotentialServices, addPotentialService, updatePotentialService, deletePotentialService,
  createHandoffs,
  loadAssignees, addAssignee, removeAssignee,
  type Tracking, type TrackNote, type TrackTask, type TrackMeeting, type PhaseEvent, type PotentialService, type Assignee,
} from "./salesApi";

export default function TrackingDetail({ tracking, companies, contacts, products, employees, onBack }: {
  tracking: Tracking; companies: Company[]; contacts: Contact[]; products: Product[]; employees: Employee[]; onBack: () => void;
}) {
  const [phases, setPhases] = useState<Phase[]>([]);
  const [allPhases, setAllPhases] = useState<Phase[]>([]);
  const [curPhase, setCurPhase] = useState<string | null>(tracking.current_phase_id);
  const [status, setStatus] = useState(tracking.status);
  const [notes, setNotes] = useState<TrackNote[]>([]);
  const [tasks, setTasks] = useState<TrackTask[]>([]);
  const [meetings, setMeetings] = useState<TrackMeeting[]>([]);
  const [events, setEvents] = useState<PhaseEvent[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [potentials, setPotentials] = useState<PotentialService[]>([]);
  const [allPipelines, setAllPipelines] = useState<Pipeline[]>([]);
  const [handoffMenu, setHandoffMenu] = useState(false);
  const [handoffPicked, setHandoffPicked] = useState<Set<string>>(new Set());
  const [handoffSent, setHandoffSent] = useState(false);
  const [assignees, setAssignees] = useState<Record<string, Assignee[]>>({});
  const [companyContactIds, setCompanyContactIds] = useState<string[]>([]);

  const reloadAssignees = async () => {
    const ids = [...notes, ...tasks, ...meetings].map((x: any) => x.id);
    setAssignees(await loadAssignees(tracking.id, ids).catch(() => ({})));
  };

  useEffect(() => {
    if (tracking.pipeline_id) loadPipeline(tracking.pipeline_id).then(({ phases }) => { setAllPhases(phases); setPhases(phases.filter((p) => p.sales_visible !== false)); }).catch(() => {});
    Promise.all([loadNotes(tracking.id), loadTasks(tracking.id), loadMeetings(tracking.id)]).then(([n, t, m]) => {
      setNotes(n); setTasks(t); setMeetings(m);
      const ids = [...n, ...t, ...m].map((x: any) => x.id);
      loadAssignees(tracking.id, ids).then(setAssignees).catch(() => {});
    }).catch(() => {});
    loadPhaseEvents(tracking.id).then(setEvents).catch(() => {});
    loadServices().then(setServices).catch(() => {});
    listPipelines().then(setAllPipelines).catch(() => {});
    loadPotentialServices(tracking.id).then(setPotentials).catch(() => {});
    // contacts already linked to this tracking's company
    if (tracking.company_id) {
      supabase.from("company_contacts").select("contact_id").eq("company_id", tracking.company_id)
        .then(({ data }: any) => setCompanyContactIds((data ?? []).map((r: any) => r.contact_id)));
    }
  }, [tracking.id, tracking.pipeline_id, tracking.company_id]);

  useEffect(() => {
    if (curPhase && events.length === 0) {
      stampPhaseEntry(tracking.id, curPhase).then((e) => { if (e) setEvents((xs) => [...xs, e]); }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curPhase, events.length]);

  const company = companies.find((c) => c.id === tracking.company_id);
  const product = products.find((p) => p.id === tracking.product_id);
  const contactName = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "Contact";
  };
  const empName = (id: string) => employees.find((e) => e.id === id)?.name ?? "Employee";
  const title = company?.name || (tracking.contactIds[0] ? contactName(tracking.contactIds[0]) : "Untitled");

  // win/loss phases in this pipeline
  const winPhase = phases.find((p) => p.sales_outcome === "win");
  const lossPhase = phases.find((p) => p.sales_outcome === "loss");

  // Handoff destinations = pipelines referenced by any phase's handover_to.
  const handoffTargets = useMemo(() => {
    const ids = Array.from(new Set(allPhases.map((p) => p.handover_to).filter(Boolean))) as string[];
    return ids.map((id) => ({ id, name: allPipelines.find((pl) => pl.id === id)?.name ?? "Pipeline" }));
  }, [allPhases, allPipelines]);
  const canHandoff = status === "won" && handoffTargets.length > 0;

  const curIdx = phases.findIndex((p) => p.id === curPhase);
  const curPhaseObj = phases.find((p) => p.id === curPhase);
  const normalPhases = phases.filter((p) => !p.sales_outcome);
  const pct = (() => {
    if (!phases.length) return 0;
    if (curPhaseObj?.sales_outcome === "win") return 100;
    if (curPhaseObj?.sales_outcome === "loss") return 0;
    const normalIdx = normalPhases.findIndex((p) => p.id === curPhase);
    if (normalIdx < 0 || normalPhases.length === 0) return 0;
    // First normal phase = 0%. The 100% is reserved for the win phase (if any);
    // otherwise the last normal phase is the finish line.
    const steps = winPhase ? normalPhases.length : normalPhases.length - 1;
    if (steps <= 0) return 0;
    return Math.round((normalIdx / steps) * 100);
  })();
  const phaseEnteredAt = (phaseId: string) => events.find((e) => e.phase_id === phaseId)?.entered_at ?? null;

  // Move to a phase, syncing status from the phase's outcome.
  const applyPhase = async (id: string) => {
    const newIdx = phases.findIndex((p) => p.id === id);
    setCurPhase(id);
    await setTrackingPhase(tracking.id, id);
    // Keep entry dates only up to and including the new current phase; clear later ones.
    const keepIds = phases.slice(0, newIdx + 1).map((p) => p.id);
    const e = await stampPhaseEntry(tracking.id, id);
    await clearPhaseEventsAfter(tracking.id, keepIds);
    setEvents((xs) => {
      let next = xs.filter((ev) => ev.phase_id && keepIds.includes(ev.phase_id));
      if (e && !next.find((x) => x.phase_id === id)) next = [...next, e];
      return next;
    });
    const ph = phases.find((p) => p.id === id);
    const next = ph?.sales_outcome === "win" ? "won" : ph?.sales_outcome === "loss" ? "lost" : "active";
    setStatus(next); await setTrackingStatus(tracking.id, next);
  };

  // Clicking a status button: sync the phase too.
  const applyStatus = async (s: string) => {
    if (s === "won") {
      if (!winPhase) return;
      await applyPhase(winPhase.id);
    } else if (s === "lost") {
      if (!lossPhase) return;
      await applyPhase(lossPhase.id);
    } else {
      // active/paused: if currently on a win/loss phase, step back to the last normal phase
      const cur = phases.find((p) => p.id === curPhase);
      if (cur?.sales_outcome) {
        const normals = phases.filter((p) => !p.sales_outcome);
        const back = normals[normals.length - 1];
        if (back) { setCurPhase(back.id); await setTrackingPhase(tracking.id, back.id); }
      }
      setStatus(s); await setTrackingStatus(tracking.id, s);
    }
  };

  const remove = async () => { if (confirm(`Delete tracking for "${title}"?`)) { await deleteTracking(tracking.id); onBack(); } };

  const phaseNotes = useMemo(() => notes.filter((n) => n.phase_id === curPhase), [notes, curPhase]);
  const phaseTasks = useMemo(() => tasks.filter((t) => t.phase_id === curPhase), [tasks, curPhase]);
  const phaseMeetings = useMemo(() => meetings.filter((m) => m.phase_id === curPhase), [meetings, curPhase]);

  // People available to @-mention: employees (internal) + contacts linked to the client's company.
  const mentionPeople = useMemo<MentionPerson[]>(() => {
    const emps: MentionPerson[] = employees
      .filter((e) => e.name && e.name !== "-")
      .map((e) => ({ id: `employee:${e.id}`, name: e.name, kind: "employee" }));
    const linked: MentionPerson[] = contacts
      .filter((c) => companyContactIds.includes(c.id!))
      .map((c) => ({ id: `contact:${c.id}`, name: [c.first_name, c.last_name].filter(Boolean).join(" "), kind: "contact" }));
    return [...emps, ...linked];
  }, [employees, contacts, companyContactIds]);

  const unassign = async (itemId: string, assigneeId: string) => {
    await removeAssignee(assigneeId);
    setAssignees((prev) => ({ ...prev, [itemId]: (prev[itemId] ?? []).filter((a) => a.id !== assigneeId) }));
  };

  // Extract mention ids still present in the serialized text "@[Name](id)".
  const extractMentions = (t: string): { id: string; name: string }[] => {
    const out: { id: string; name: string }[] = [];
    const re = /@\[([^\]]+)\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) out.push({ name: m[1], id: m[2] });
    return out;
  };
  // Convert serialized mentions "@[Name](id)" into plain "@Name" for storage.
  const cleanMentions = (t: string) => cleanMentionsFn(t);

  // Persist the mentions found in the final text against a freshly-created item.
  const persistFromText = async (itemType: string, itemId: string, rawText: string) => {
    const mentions = extractMentions(rawText);
    const seen = new Set<string>();
    const created: any[] = [];
    for (const mn of mentions) {
      if (seen.has(mn.id)) continue; seen.add(mn.id);
      const [kind, refId] = mn.id.split(":") as ["employee" | "contact", string];
      if (!refId) continue;
      const a = await addAssignee(itemType, itemId, kind, refId);
      if (a) created.push(a);
    }
    if (created.length) setAssignees((prev) => ({ ...prev, [itemId]: [...(prev[itemId] ?? []), ...created] }));
  };

  // ---- add handlers ----
  const [newNote, setNewNote] = useState("");
  const submitNote = async () => {
    if (!cleanMentions(newNote).trim()) return;
    const n = await addNote(tracking.id, curPhase, cleanMentions(newNote).trim());
    if (n) { setNotes((xs) => [...xs, n]); await persistFromText("note", n.id, newNote); }
    setNewNote("");
  };
  const removeNote = async (id: string) => { await deleteNote(id); setNotes((xs) => xs.filter((n) => n.id !== id)); };
  const editNote = async (id: string, body: string) => { await updateNote(id, body); setNotes((xs) => xs.map((n) => n.id === id ? { ...n, body } : n)); };

  const [newTask, setNewTask] = useState("");
  const submitTask = async () => {
    if (!cleanMentions(newTask).trim()) return;
    const t = await addTask(tracking.id, curPhase, cleanMentions(newTask).trim());
    if (t) { setTasks((xs) => [...xs, t]); await persistFromText("task", t.id, newTask); }
    setNewTask("");
  };
  const flipTask = async (t: TrackTask) => { const done = !t.done; setTasks((xs) => xs.map((x) => x.id === t.id ? { ...x, done } : x)); await toggleTask(t.id, done); };
  const removeTask = async (id: string) => { await deleteTask(id); setTasks((xs) => xs.filter((t) => t.id !== id)); };
  const editTask = async (id: string, title: string) => { await updateTask(id, title); setTasks((xs) => xs.map((t) => t.id === id ? { ...t, title } : t)); };

  const [meetTitle, setMeetTitle] = useState("");
  const [meetDate, setMeetDate] = useState("");
  const [meetTime, setMeetTime] = useState("10:00");
  const submitMeeting = async () => {
    if (!cleanMentions(meetTitle).trim() || !meetDate) return;
    const iso = `${meetDate}T${meetTime || "00:00"}:00`;
    const m = await addMeeting(tracking.id, curPhase, cleanMentions(meetTitle).trim(), iso);
    if (m) { setMeetings((xs) => [...xs, m]); await persistFromText("meeting", m.id, meetTitle); }
    setMeetTitle(""); setMeetDate(""); setMeetTime("10:00");
  };
  const removeMeeting = async (id: string) => { await deleteMeeting(id); setMeetings((xs) => xs.filter((m) => m.id !== id)); };
  const editMeeting = async (id: string, title: string) => { await updateMeeting(id, { title }); setMeetings((xs) => xs.map((m) => m.id === id ? { ...m, title } : m)); };

  // ---- revenue ----
  const productDefault = product?.tiers?.[0]?.price ?? 0;
  const [productPrice, setPrice] = useState<number>(tracking.product_price ?? productDefault);
  const savePrice = async (v: number) => { setPrice(v); await setProductPrice(tracking.id, v); };
  const serviceName = (id: string | null) => services.find((s) => s.id === id)?.name ?? "Service";
  const addPotential = async (serviceId: string) => {
    const svc = services.find((s) => s.id === serviceId);
    const price = svc?.roles?.reduce((sum: number, r: any) => sum + (r.price || 0), 0) ?? 0;
    const p = await addPotentialService(tracking.id, serviceId, svc?.name ?? null, price);
    if (p) setPotentials((xs) => [...xs, p]);
  };
  const editPotential = async (id: string, price: number) => { setPotentials((xs) => xs.map((p) => p.id === id ? { ...p, price } : p)); await updatePotentialService(id, price); };
  const removePotential = async (id: string) => { await deletePotentialService(id); setPotentials((xs) => xs.filter((p) => p.id !== id)); };
  const totalPotential = productPrice + potentials.reduce((s, p) => s + (p.price || 0), 0);
  const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

  const doHandoff = async () => {
    const destinations = handoffTargets.filter((t) => handoffPicked.has(t.id));
    if (!destinations.length) return;
    const services = potentials.map((p) => ({ label: p.label || serviceName(p.service_id), price: p.price || 0 }));
    await createHandoffs({
      tracking_id: tracking.id,
      company_id: tracking.company_id,
      company_name: company?.name ?? null,
      product_id: tracking.product_id,
      destinations,
      services,
      potential_value: totalPotential,
    });
    setHandoffSent(true);
  };

  const fmtMeet = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-";
  const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" }) : null;

  // Assignee row (chips + dropdown) reused across items
  // Small "people tagged" indicator: avatars if they fit, else an icon; hover shows who in a portal popup.
  const MiniAssignees = ({ itemId, compact }: { itemId: string; compact?: boolean }) => {
    const list = assignees[itemId] ?? [];
    const [hover, setHover] = useState(false);
    const wrapRef = useRef<HTMLSpanElement>(null);
    const [pop, setPop] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
    if (list.length === 0) return null;
    const rows = list.map((a) => {
      const isEmp = a.kind === "employee";
      return { key: a.id, isEmp, name: isEmp ? empName(a.employee_id!) : contactName(a.contact_id!) };
    });
    const open = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setPop({ left: r.right, top: r.top });
      setHover(true);
    };
    const popup = hover && createPortal(
      <span className="sl-tag-pop" style={{ position: "fixed", left: pop.left, top: pop.top, transform: "translate(-100%, calc(-100% - 6px))" }}>
        {rows.map((r) => (
          <span key={r.key} className="sl-tag-pop-row">
            <span className={`sl-mini-av ${r.isEmp ? "sl-asg-int" : "sl-asg-ext"}`}>{r.name.slice(0, 1).toUpperCase()}</span>
            <span className="sl-tag-pop-name">{r.name}</span>
            <span className="sl-tag-pop-kind">{r.isEmp ? "Team" : "Contact"}</span>
          </span>
        ))}
      </span>,
      document.body
    );
    if (compact) {
      return (
        <span className="sl-tagged-wrap" ref={wrapRef} onMouseEnter={open} onMouseLeave={() => setHover(false)}>
          <span className="sl-tagged">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            {list.length}
          </span>
          {popup}
        </span>
      );
    }
    const shown = rows.slice(0, 2);
    const extra = rows.length - shown.length;
    return (
      <span className="sl-tagged-wrap" ref={wrapRef} onMouseEnter={open} onMouseLeave={() => setHover(false)}>
        <span className="sl-mini-asg">
          {shown.map((r) => <span key={r.key} className={`sl-mini-av ${r.isEmp ? "sl-asg-int" : "sl-asg-ext"}`}>{r.name.slice(0, 1).toUpperCase()}</span>)}
          {extra > 0 && <span className="sl-mini-more">+{extra}</span>}
        </span>
        {popup}
      </span>
    );
  };

  const AssigneeArea = ({ itemId }: { itemId: string }) => {
    const list = assignees[itemId] ?? [];
    if (list.length === 0) return null;
    return (
      <div className="sl-assignees">
        {list.map((a) => {
          const isEmp = a.kind === "employee";
          const name = isEmp ? empName(a.employee_id!) : contactName(a.contact_id!);
          return (
            <span key={a.id} className={`sl-asg ${isEmp ? "sl-asg-int" : "sl-asg-ext"}`}>
              <span className="sl-asg-av">{name.slice(0, 1).toUpperCase()}</span>
              {name}
              <button onClick={() => unassign(itemId, a.id)} aria-label="Remove">×</button>
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div className="sl sl-detail">
      <header className="sl-head sl-d-head">
        <button className="sl-back" onClick={onBack} aria-label="Back">‹</button>
        <span className="sl-d-avatar">{title.slice(0, 1).toUpperCase()}</span>
        <div className="sl-d-id">
          <h1 className="sl-title">{title}</h1>
          <div className="sl-d-metaline">
            <span className={`sl-d-badge sl-badge-${status}`}>{status}</span>
            <span className="sl-d-sub">
              {company ? "Company" : "Contact"}
              {tracking.contactIds.length > 0 && ` \u00b7 ${tracking.contactIds.map(contactName).join(", ")}`}
              {product && ` \u00b7 ${product.name}`}
            </span>
          </div>
        </div>
        <div className="sl-d-actions">
          {canHandoff && (
            <div className="sl-handoff-wrap">
              <button className="sl-handoff-btn" onClick={() => setHandoffMenu((v) => !v)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                Handoff
              </button>
              {handoffMenu && (
                <>
                  <div className="sl-handoff-layer" onMouseDown={() => { setHandoffMenu(false); setHandoffSent(false); }} />
                  <div className="sl-handoff-pop">
                    {handoffSent ? (
                      <div className="sl-handoff-done">
                        <div className="sl-handoff-done-ico">✓</div>
                        <div className="sl-handoff-done-txt">Sent to {handoffPicked.size} destination{handoffPicked.size !== 1 ? "s" : ""}</div>
                        <div className="sl-handoff-foot">Management integration — coming soon</div>
                      </div>
                    ) : (
                      <>
                        <div className="sl-handoff-head">Send this deal onward</div>
                        <div className="sl-handoff-sec-label">Destinations</div>
                        {handoffTargets.map((t) => {
                          const on = handoffPicked.has(t.id);
                          return (
                            <button key={t.id} className={`sl-handoff-dest ${on ? "is-picked" : ""}`}
                              onClick={() => setHandoffPicked((prev) => { const n = new Set(prev); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; })}>
                              <span className={`sl-handoff-check ${on ? "is-on" : ""}`}>{on ? "✓" : ""}</span>
                              <span className="sl-handoff-dest-name">{t.name}</span>
                            </button>
                          );
                        })}
                        {potentials.length > 0 && (
                          <>
                            <div className="sl-handoff-sec-label">Recommended services</div>
                            {potentials.map((p) => (
                              <div key={p.id} className="sl-handoff-svc">
                                <span className="sl-handoff-svc-name">{p.label || serviceName(p.service_id)}</span>
                                <span className="sl-handoff-svc-price">{money(p.price)}</span>
                              </div>
                            ))}
                          </>
                        )}
                        <button className="sl-handoff-send" disabled={handoffPicked.size === 0}
                          onClick={doHandoff}>
                          Send{handoffPicked.size > 0 ? ` to ${handoffPicked.size}` : ""}
                        </button>
                        <div className="sl-handoff-foot">Sending to management — coming soon</div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="sl-seg">
            {["active", "won", "lost", "paused"].map((s) => {
              const disabled = (s === "won" && !winPhase) || (s === "lost" && !lossPhase);
              return (
                <button key={s} className={`sl-seg-btn ${status === s ? "is-on" : ""} sl-seg-${s}`} disabled={disabled}
                  onClick={() => applyStatus(s)} title={disabled ? "Define a win/loss phase in the pipeline first" : ""}>{s}</button>
              );
            })}
          </div>
          <button className="sl-d-del" onClick={remove}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
          </button>
        </div>
      </header>

      <div className="sl-scroll">
        {/* Pipeline flow — hero */}
        <div className={`sl-pipe sl-pipe-${status}`}>
          <div className="sl-pipe-head">
            <span className="sl-pipe-title">Pipeline progress</span>
            <span className="sl-pipe-pct">{pct}<i>%</i></span>
          </div>
          <div className="sl-pipe-bar"><div className="sl-pipe-bar-fill" style={{ width: `${pct}%` }} /></div>
          <div className="sl-flow">
            {phases.length === 0 ? <span className="sl-pipe-empty">This pipeline has no phases.</span> : phases.map((p, i) => {
              const entered = phaseEnteredAt(p.id);
              const state = i < curIdx ? "done" : i === curIdx ? "cur" : "future";
              return (
                <div key={p.id} className="sl-flow-item">
                  {i > 0 && <div className={`sl-flow-bar ${i <= curIdx ? "is-on" : ""}`} />}
                  <button className={`sl-flow-node is-${state} ${p.sales_outcome ? `oc-${p.sales_outcome}` : ""}`} onClick={() => applyPhase(p.id)}>
                    <span className="sl-flow-num">{p.sales_outcome === "win" ? "★" : p.sales_outcome === "loss" ? "✕" : state === "done" ? "✓" : i + 1}</span>
                    <span className="sl-flow-text">
                      <span className="sl-flow-name">{p.name}</span>
                      <span className="sl-flow-date">{entered ? fmtDate(entered) : "—"}</span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Four columns */}
        <div className="sl-work">
          <section className="sl-panel">
            <h3 className="sl-panel-title">Notes<span>{phaseNotes.length}</span></h3>
            <div className="sl-note-add">
              <MentionInput multiline value={newNote} onChange={setNewNote} people={mentionPeople}
                onMention={() => {}} placeholder="Write a note... use @ to mention" />
              <button className="sl-add-btn" onClick={submitNote} disabled={!cleanMentions(newNote).trim()}>Add note</button>
            </div>
            <div className="sl-notes">
              {phaseNotes.length === 0 ? <p className="sl-hint">No notes yet.</p> : phaseNotes.map((n) => (
                <NoteItem key={n.id} note={n} onEdit={editNote} onDelete={removeNote} tagged={<MiniAssignees itemId={n.id} compact />}>
                  <AssigneeArea itemId={n.id} />
                </NoteItem>
              ))}
            </div>
          </section>

          <section className="sl-panel">
            <h3 className="sl-panel-title">Tasks<span>{phaseTasks.filter((t) => !t.done).length}</span></h3>
            <div className="sl-task-add">
              <MentionInput multiline value={newTask} onChange={setNewTask} people={mentionPeople}
                onMention={() => {}} onEnter={submitTask} placeholder="Add a task... use @ to mention" />
              <button className="sl-add-btn" onClick={submitTask} disabled={!cleanMentions(newTask).trim()}>Add</button>
            </div>
            <div className="sl-tasks">
              {phaseTasks.length === 0 ? <p className="sl-hint">No tasks yet.</p> : phaseTasks.map((t) => (
                <TaskItem key={t.id} task={t} onToggle={flipTask} onEdit={editTask} onDelete={removeTask} tagged={<MiniAssignees itemId={t.id} compact />} />
              ))}
            </div>
          </section>

          <section className="sl-panel">
            <h3 className="sl-panel-title">Meetings<span>{phaseMeetings.length}</span></h3>
            <div className="sl-meet-add">
              <MentionInput multiline value={meetTitle} onChange={setMeetTitle} people={mentionPeople}
                onMention={() => {}} placeholder="Meeting title... use @ to mention" />
              <div className="sl-meet-when">
                <DatePicker value={meetDate} onChange={setMeetDate} placeholder="Date" />
                <TimePicker value={meetTime} onChange={setMeetTime} />
              </div>
              <button className="sl-add-btn" onClick={submitMeeting} disabled={!cleanMentions(meetTitle).trim() || !meetDate}>Schedule</button>
            </div>
            <div className="sl-meetings">
              {phaseMeetings.length === 0 ? <p className="sl-hint">No meetings yet.</p> : phaseMeetings.map((m) => (
                <MeetingItem key={m.id} meeting={m} fmtMeet={fmtMeet} onEdit={editMeeting} onDelete={removeMeeting} tagged={<MiniAssignees itemId={m.id} compact />} />
              ))}
            </div>
          </section>

          <section className="sl-panel sl-panel-rev">
            <h3 className="sl-panel-title">Potential revenue<span className="sl-rev-total">{money(totalPotential)}</span></h3>
            {product ? (
              <div className="sl-rev-item sl-rev-product">
                <div className="sl-rev-body"><span className="sl-rev-name">{product.name}</span><span className="sl-rev-tag">Product</span></div>
                <div className="sl-rev-price"><input type="number" value={productPrice} onChange={(e) => savePrice(parseFloat(e.target.value) || 0)} /></div>
              </div>
            ) : <p className="sl-hint">No product assigned.</p>}
            {potentials.map((p) => (
              <div key={p.id} className="sl-rev-item">
                <div className="sl-rev-body"><span className="sl-rev-name">{p.label || serviceName(p.service_id)}</span><span className="sl-rev-tag sl-rev-tag-svc">Service</span></div>
                <div className="sl-rev-price"><input type="number" value={p.price} onChange={(e) => editPotential(p.id, parseFloat(e.target.value) || 0)} /><button className="sl-rev-x" onClick={() => removePotential(p.id)}>×</button></div>
              </div>
            ))}
            {services.length > 0 && (
              <div className="sl-rev-add">
                <Select value="" onChange={(v) => v && addPotential(v)} placeholder="+ Add potential service" options={services.map((s) => ({ value: s.id!, label: s.name }))} />
              </div>
            )}
            <div className="sl-rev-foot"><span>Total if won</span><b>{money(totalPotential)}</b></div>
          </section>
        </div>
      </div>
    </div>
  );
}
// ============================ Note item (expand/collapse + inline edit) ============================
function NoteItem({ note, onEdit, onDelete, tagged, children }: {
  note: TrackNote;
  onEdit: (id: string, body: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [overflowing, setOverflowing] = useState(false);
  const pRef = useRef<HTMLParagraphElement>(null);

  // Detect whether the collapsed text is clipped (so we only show the toggle when needed).
  useEffect(() => {
    const el = pRef.current;
    if (el && !editing) setOverflowing(el.scrollHeight > el.clientHeight + 2);
  }, [note.body, editing, expanded]);

  const save = async () => {
    const body = draft.trim();
    if (body && body !== note.body) await onEdit(note.id, body);
    setEditing(false);
  };
  const cancel = () => { setDraft(note.body); setEditing(false); };

  if (editing) {
    return (
      <div className="sl-note sl-note-editing">
        <textarea className="sl-note-edit" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
        <div className="sl-note-edit-actions">
          <button className="sl-note-cancel" onClick={cancel}>Cancel</button>
          <button className="sl-note-save" onClick={save} disabled={!draft.trim()}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sl-note">
      <div className="sl-note-tools">
        {tagged}
        <button className="sl-note-edit-btn" onClick={() => { setDraft(note.body); setEditing(true); }} aria-label="Edit">✎</button>
        <button className="sl-note-x" onClick={() => onDelete(note.id)} aria-label="Delete">×</button>
      </div>
      <p
        ref={pRef}
        className={`sl-note-body ${expanded ? "is-expanded" : "is-clamped"}`}
        onClick={() => (overflowing || expanded) && setExpanded((v) => !v)}
        style={{ cursor: (overflowing || expanded) ? "pointer" : "default" }}
      >
        {note.body}
      </p>
      {(overflowing || expanded) && (
        <button className="sl-note-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {children}
    </div>
  );
}

// ============================ Task item (one line, check, inline edit) ============================
function TaskItem({ task, onToggle, onEdit, onDelete, tagged }: {
  task: TrackTask;
  onToggle: (t: TrackTask) => void;
  onEdit: (id: string, title: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const save = async () => { const v = draft.trim(); if (v && v !== task.title) await onEdit(task.id, v); setEditing(false); };
  const cancel = () => { setDraft(task.title); setEditing(false); };

  if (editing) {
    return (
      <div className="sl-task sl-task-editing">
        <input className="sl-inline-edit" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }} />
        <div className="sl-inline-actions">
          <button className="sl-note-cancel" onClick={cancel}>Cancel</button>
          <button className="sl-note-save" onClick={save} disabled={!draft.trim()}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`sl-task ${task.done ? "is-done" : ""}`}>
      <button className="sl-check" onClick={() => onToggle(task)} aria-label="Toggle">{task.done ? "✓" : ""}</button>
      <span className="sl-task-title" title={cleanMentionsFn(task.title)}>{cleanMentionsFn(task.title)}</span>
      {tagged}
      <button className="sl-note-edit-btn sl-inline-edit-btn" onClick={() => { setDraft(task.title); setEditing(true); }} aria-label="Edit">✎</button>
      <button className="sl-task-x sl-inline-x" onClick={() => onDelete(task.id)} aria-label="Delete">×</button>
    </div>
  );
}

// ============================ Meeting item (date/time left, title clamp+expand, edit) ============================
function MeetingItem({ meeting, fmtMeet, onEdit, onDelete, tagged }: {
  meeting: TrackMeeting;
  fmtMeet: (iso: string | null) => string;
  onEdit: (id: string, title: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meeting.title);
  const [overflowing, setOverflowing] = useState(false);
  const pRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = pRef.current;
    if (el && !editing) setOverflowing(el.scrollHeight > el.clientHeight + 2);
  }, [meeting.title, editing, expanded]);

  const save = async () => { const v = draft.trim(); if (v && v !== meeting.title) await onEdit(meeting.id, v); setEditing(false); };
  const cancel = () => { setDraft(meeting.title); setEditing(false); };

  // fmtMeet gives "12 Aug, 10:00"; split date and time for the left block.
  const at = fmtMeet(meeting.meet_at);
  const [datePart, timePart] = at.includes(",") ? at.split(",").map((s) => s.trim()) : [at, ""];

  return (
    <div className="sl-meeting">
      <div className="sl-meet-when-block">
        <span className="sl-meet-date">{datePart}</span>
        {timePart && <span className="sl-meet-time">{timePart}</span>}
      </div>
      <div className="sl-meet-content">
        {editing ? (
          <div className="sl-meet-edit">
            <textarea className="sl-inline-edit" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <div className="sl-inline-actions">
              <button className="sl-note-cancel" onClick={cancel}>Cancel</button>
              <button className="sl-note-save" onClick={save} disabled={!draft.trim()}>Save</button>
            </div>
          </div>
        ) : (
          <>
            <div className="sl-meet-tools">
              {tagged}
              <button className="sl-note-edit-btn" onClick={() => { setDraft(meeting.title); setEditing(true); }} aria-label="Edit">✎</button>
              <button className="sl-note-x" onClick={() => onDelete(meeting.id)} aria-label="Delete">×</button>
            </div>
            <p ref={pRef}
              className={`sl-meet-title-body ${expanded ? "is-expanded" : "is-clamped"}`}
              onClick={() => (overflowing || expanded) && setExpanded((v) => !v)}
              style={{ cursor: (overflowing || expanded) ? "pointer" : "default" }}
            >{cleanMentionsFn(meeting.title)}</p>
            {(overflowing || expanded) && (
              <button className="sl-note-more" onClick={() => setExpanded((v) => !v)}>{expanded ? "Show less" : "Show more"}</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}