/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home · shared column · TO-DO
 *
 * Two lists:
 *   • Quick — small things you tick off. Grouped by when they're due.
 *   • Processes — longer work: a status (To do / In progress / Blocked /
 *     Done), a % done and progress notes saying where it's at.
 * Every task has a name, an optional description, a priority (Urgent, High,
 * Normal, Low) and can belong to a deal or be personal. Add one right here;
 * open any task to change its name, description, priority, kind, due date,
 * status and % and to post an update.
 *
 * The task panel (TaskPanel) is exported: the deal page in Sales opens the
 * same one.
 *
 * Tasks you're tagged on in a deal, untagged ones on deals you own, and the
 * personal ones you made all show up. "Delegated" lists the tasks you made
 * and gave to someone else, so you can follow how they're going.
 * Only whoever created a task can delete it or move its deadline.
 *
 * ⤢ opens the full-window task view (TaskWorkspace): every task, filters, and
 * the task in detail side by side. Predefined tasks / processes (Settings →
 * Tasks) are offered from the ✦ button when adding one.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../api/supabase";
import DatePicker from "../../../framework/DatePicker";
import TimePicker from "../../../framework/TimePicker";
import Select from "../../../framework/Select";
import {
  loadMyTasks, loadDelegatedTasks, toggleTask, deleteTask, canDeleteTask, addPersonalTask, updateTaskMeta, loadTaskUpdates, addTaskUpdate,
  loadTaskTemplates, fromTemplate, newStepId, allRows, addAssignee, removeAssignee,
  TASK_PRIORITIES, TASK_STATUSES,
  type MyTask, type DelegatedTask, type TaskPriority, type TaskStatus, type TaskKind, type TaskUpdate, type TaskTemplate, type TaskStep,
} from "../../sales/sales/salesApi";
import { isoDay } from "./HomeCalendar";
import { outlookMailStatus, syncTicketMail, sendOutlookMail, connectOutlook, fetchMailAttachment, OUTLOOK_CONNECTION_EVENT, type OutlookMailStatus, type MailSyncResult } from "../../../api/outlookSync";
import { loadPrefs, savePref } from "../../companies/companiesApi";
import { MentionText, mentionsToPlain } from "../../../framework/MentionInput";
import { ClientLogo } from "../../clients/ClientWorkspace";
import "./HomeShared.css";

type Tab = "quick" | "process" | "delegated" | "done";
const TABS: Tab[] = ["quick", "process", "delegated", "done"];
type Group = "overdue" | "today" | "week" | "later" | "none";
const GROUPS: { key: Group; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "week", label: "Next 7 days" },
  { key: "later", label: "Later" },
  { key: "none", label: "No due date" },
];
export const PRIORITY_LABEL: Record<TaskPriority, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
export const STATUS_LABEL: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done" };
const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_RANK: Record<TaskStatus, number> = { blocked: 0, in_progress: 1, todo: 2, done: 3 };

const dayOf = (iso?: string | null) => (iso ? iso.slice(0, 10) : null);
const timeOf = (iso?: string | null) => (iso && iso.length > 10 ? iso.slice(11, 16) : null);
const daysBetween = (a: string, b: string) => Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
/** "@[Name](employee:id)" → a name pill. */
function Rich({ text }: { text: string }) { return <MentionText text={text} />; }
const plain = (t: string) => mentionsToPlain(t);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";

/**
 * When a task is due, said plainly: the day in words and the time, coloured by
 * how close it is — late (red), today (amber), tomorrow / this week (green),
 * later (grey).
 */
export type DueTone = "late" | "today" | "soon" | "later";
export function dueInfo(dueAt: string | null | undefined, todayIso: string): { day: string; time: string | null; tone: DueTone; rel: string } | null {
  const d = dayOf(dueAt);
  if (!d) return null;
  const diff = daysBetween(todayIso, d);
  const tm = timeOf(dueAt);
  const time = tm && tm !== "00:00" ? tm : null;
  const nice = new Date(d + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  if (diff < 0) return { day: nice, time, tone: "late", rel: diff === -1 ? "1 day late" : `${-diff} days late` };
  if (diff === 0) return { day: "Today", time, tone: "today", rel: "today" };
  if (diff === 1) return { day: "Tomorrow", time, tone: "soon", rel: "tomorrow" };
  return { day: nice, time, tone: diff <= 7 ? "soon" : "later", rel: `in ${diff} days` };
}
const CalIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
);
/** The deadline chip: [📅 Today | 12:00] */
export function DueChip({ dueAt, todayIso, done }: { dueAt?: string | null; todayIso: string; done?: boolean }) {
  const d = dueInfo(dueAt, todayIso);
  if (!d) return null;
  return (
    <span className={`hs-due is-${done ? "done" : d.tone}`} title={`Due ${d.day}${d.time ? ` at ${d.time}` : ""} (${d.rel})`}>
      <CalIcon /><b>{d.tone === "late" && !done ? d.rel : d.day}</b>
      {d.tone === "late" && !done ? <em>{d.day}{d.time ? ` · ${d.time}` : ""}</em> : d.time && <em>{d.time}</em>}
    </span>
  );
}
/** A textarea as tall as its text. */
const grow = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; } };

export const FlagIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M5 4h11l-2 4 2 4H5z" fill="currentColor" /></svg>
);

export default function HomeTodo() {
  const nav = useNavigate();
  const today = isoDay(new Date());
  const [tasks, setTasks] = useState<MyTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("quick");
  const [openId, setOpenId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Just ticked: stays in place for a moment (with undo) before moving to Done. */
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const timers = useRef<Record<string, number>>({});
  // quick add
  const [draft, setDraft] = useState("");
  const [draftDesc, setDraftDesc] = useState("");
  const [draftPrio, setDraftPrio] = useState<TaskPriority>("normal");
  const [draftDue, setDraftDue] = useState("");
  /** Filled in from a predefined task: its kind, deadline time and steps. */
  const [draftFrom, setDraftFrom] = useState<{ template_id: string; kind: TaskKind; time: string | null; checklist: TaskStep[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  /** The full-window view, open on this task ("" = none picked). */
  const [workspace, setWorkspace] = useState<string | null>(null);
  // tasks I made and gave to others
  const [delegated, setDelegated] = useState<DelegatedTask[]>([]);
  const [meId, setMeId] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => { if (alive) setMeId(data?.session?.user?.id ?? null); });
    void loadTaskTemplates().then((t) => { if (alive) setTemplates(t); });
    Promise.all([loadMyTasks(), loadDelegatedTasks().catch(() => [] as DelegatedTask[])])
      .then(([t, d]) => {
        if (!alive) return;
        // A task I made and gave to someone else is theirs to do: it's under Delegated, not in my list.
        const given = new Set(d.map((x) => x.id));
        setTasks(t.filter((x) => !(given.has(x.id) && !x.assigned)));
        setDelegated(d); setLoading(false);
      })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; Object.values(timers.current).forEach((t) => window.clearTimeout(t)); };
  }, [reloadKey]);

  const groupOf = (t: MyTask): Group => {
    const d = dayOf(t.due_at);
    if (!d) return "none";
    const diff = daysBetween(today, d);
    if (diff < 0) return "overdue";
    if (diff === 0) return "today";
    if (diff <= 7) return "week";
    return "later";
  };
  const byPrioThenDue = (a: MyTask, b: MyTask) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999") || (a.created_at ?? "").localeCompare(b.created_at ?? "");

  const isOpen = (t: MyTask) => !t.done || leaving.has(t.id);
  const quick = useMemo(() => tasks.filter((t) => t.kind === "quick" && isOpen(t)), [tasks, leaving]); // eslint-disable-line react-hooks/exhaustive-deps
  const processes = useMemo(() => tasks.filter((t) => t.kind === "process" && isOpen(t))
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || byPrioThenDue(a, b)), [tasks, leaving]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = useMemo(() => tasks.filter((t) => t.done && !leaving.has(t.id))
    .sort((a, b) => (b.completed_at ?? b.due_at ?? b.created_at ?? "").localeCompare(a.completed_at ?? a.due_at ?? a.created_at ?? "")).slice(0, 40), [tasks, leaving]);
  const groups = useMemo(() => GROUPS.map((g) => ({
    ...g, items: quick.filter((t) => groupOf(t) === g.key).sort(byPrioThenDue),
  })).filter((g) => g.items.length), [quick]); // eslint-disable-line react-hooks/exhaustive-deps
  const openTasks = tasks.filter((t) => !t.done);
  const overdue = openTasks.filter((t) => groupOf(t) === "overdue").length;
  const urgent = openTasks.filter((t) => t.priority === "urgent").length;

  const patchLocal = (id: string, patch: Partial<MyTask>) => {
    setTasks((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    setDelegated((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };
  const delegatedOpen = useMemo(() => delegated.filter((t) => !t.done)
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || byPrioThenDue(a, b)), [delegated]); // eslint-disable-line react-hooks/exhaustive-deps
  const delegatedDone = useMemo(() => delegated.filter((t) => t.done), [delegated]);

  const setDone = (t: MyTask, value: boolean) => {
    patchLocal(t.id, { done: value, status: value ? "done" : t.progress > 0 && t.progress < 100 ? "in_progress" : "todo", progress: value ? 100 : t.progress === 100 ? 0 : t.progress });
    void toggleTask(t.id, value);
    window.clearTimeout(timers.current[t.id]);
    if (value && tab !== "done") {
      setLeaving((s) => new Set(s).add(t.id));
      timers.current[t.id] = window.setTimeout(() => setLeaving((s) => { const n = new Set(s); n.delete(t.id); return n; }), 1600);
    } else {
      setLeaving((s) => { const n = new Set(s); n.delete(t.id); return n; });
    }
  };
  const cyclePriority = async (t: MyTask) => {
    const next = TASK_PRIORITIES[(TASK_PRIORITIES.indexOf(t.priority) + 1) % TASK_PRIORITIES.length];
    patchLocal(t.id, { priority: next });
    const e = await updateTaskMeta(t.id, { priority: next });
    if (e) { setErr(e); patchLocal(t.id, { priority: t.priority }); }
  };

  const add = async () => {
    const title = draft.trim();
    if (!title || adding) return;
    setAdding(true); setErr(null);
    const kind: TaskKind = draftFrom ? draftFrom.kind : tab === "process" ? "process" : "quick";
    const { task, error } = await addPersonalTask({
      title, description: draftDesc, kind, priority: draftPrio,
      due_at: draftDue ? `${draftDue}T${draftFrom?.time ?? "18:00"}:00` : null,
      checklist: draftFrom?.checklist ?? [], template_id: draftFrom?.template_id ?? null,
    });
    setAdding(false);
    if (error || !task) { setErr(error ?? "Couldn't add the task."); return; }
    setTasks((xs) => [task, ...xs]);
    if (kind !== tab && (tab === "quick" || tab === "process")) setTab(kind);
    setDraft(""); setDraftDesc(""); setDraftPrio("normal"); setDraftDue(""); setDraftFrom(null);
  };
  const pickTemplate = (t: TaskTemplate) => {
    const f = fromTemplate(t);
    setDraft(f.title); setDraftDesc(f.description); setDraftPrio(f.priority);
    setDraftDue(f.due_at ? f.due_at.slice(0, 10) : "");
    setDraftFrom({ template_id: t.id, kind: f.kind, time: f.due_at ? f.due_at.slice(11, 16) : null, checklist: f.checklist });
  };
  const remove = async (t: MyTask) => {
    const e = await deleteTask(t.id);
    if (e) { setErr(e); return; }
    setOpenId(null);
    setTasks((xs) => xs.filter((x) => x.id !== t.id));
    setDelegated((xs) => xs.filter((x) => x.id !== t.id));
  };

  const dealChip = (t: MyTask) => t.tracking_id ? (
    <button className="hs-task-deal" onClick={(e) => { e.stopPropagation(); nav(`/sales?tracking=${t.tracking_id}`); }} title="Open the deal">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7h18v13H3z" /><path d="M8 7V4h8v3" /></svg>
      <span>{t.deal}</span>
    </button>
  ) : <span className="hs-task-personal">Personal</span>;

  const prioFlag = (t: MyTask, always = false) => (always || t.priority !== "normal") && (
    <button className={`hs-prio is-${t.priority}`} onClick={(e) => { e.stopPropagation(); void cyclePriority(t); }}
      title={`Priority: ${PRIORITY_LABEL[t.priority]} — click to change`} aria-label={`Priority ${PRIORITY_LABEL[t.priority]}`}>
      <FlagIcon /><span>{PRIORITY_LABEL[t.priority]}</span>
    </button>
  );

  /* one quick task */
  const row = (t: MyTask, i: number) => {
    const isLeaving = leaving.has(t.id);
    return (
      <li key={t.id} className={`hs-task is-p-${t.priority} is-s-${t.status} ${t.done ? "is-done" : ""} ${isLeaving ? "is-leaving" : ""}`} style={{ ["--i" as string]: i } as React.CSSProperties}
        onClick={() => setOpenId(t.id)}>
        <button className="hs-check" role="checkbox" aria-checked={t.done} onClick={(e) => { e.stopPropagation(); setDone(t, !t.done); }}
          aria-label={t.done ? "Mark as not done" : "Mark as done"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9" /></svg>
        </button>
        <div className="hs-task-body">
          <p className="hs-task-title"><Rich text={t.title} /></p>
          {t.description?.trim() && <p className="hs-task-desc"><Rich text={t.description} /></p>}
          <div className="hs-task-meta">
            {prioFlag(t)}
            {!t.done && (t.kind === "process" || t.status !== "todo") && (
              <span className={`hs-st is-${t.status}`}><i />{t.status === "todo" ? `${t.progress}%` : `${STATUS_LABEL[t.status]}${t.progress > 0 ? ` · ${t.progress}%` : ""}`}</span>
            )}
            <DueChip dueAt={t.due_at} todayIso={today} done={t.done} />
            {dealChip(t)}
          </div>
        </div>
        {isLeaving && <button className="hs-undo" onClick={(e) => { e.stopPropagation(); setDone(t, false); }}>Undo</button>}
      </li>
    );
  };

  /* one process */
  const card = (t: MyTask, i: number) => {
    const isLeaving = leaving.has(t.id);
    return (
      <li key={t.id} className={`hs-proc is-${t.status} is-p-${t.priority} ${isLeaving ? "is-leaving" : ""}`} style={{ ["--i" as string]: i, ["--pct" as string]: `${t.progress}%` } as React.CSSProperties}
        onClick={() => setOpenId(t.id)}>
        <div className="hs-proc-top">
          <span className={`hs-st is-${t.status}`}><i />{STATUS_LABEL[t.status]}</span>
          {prioFlag(t)}
          <b className="hs-proc-pct">{t.progress}<small>%</small></b>
        </div>
        <p className="hs-task-title"><Rich text={t.title} /></p>
        {t.description?.trim() && <p className="hs-task-desc"><Rich text={t.description} /></p>}
        <span className="hs-proc-bar" aria-label={`${t.progress}% done`}><i /></span>
        {t.lastNote && (
          <p className="hs-proc-note">“<Rich text={t.lastNote.body} />” <small>· {ago(t.lastNote.at)}</small></p>
        )}
        <div className="hs-task-meta">
          <DueChip dueAt={t.due_at} todayIso={today} done={t.done} />
          {dealChip(t)}
        </div>
        {isLeaving && <button className="hs-undo" onClick={(e) => { e.stopPropagation(); setDone(t, false); }}>Undo</button>}
      </li>
    );
  };

  /* one task I gave to someone: who has it, where it's at */
  const sent = (t: DelegatedTask, i: number) => (
    <li key={t.id} className={`hs-proc hs-sent is-${t.status} is-p-${t.priority}`} style={{ ["--i" as string]: i, ["--pct" as string]: `${t.progress}%` } as React.CSSProperties}
      onClick={() => setOpenId(t.id)}>
      <div className="hs-proc-top">
        <span className="hs-sent-who" title={t.assignees.map((a) => a.name).join(", ")}>
          <span className="hs-avatars">{t.assignees.slice(0, 3).map((a) => <i key={a.id}>{initials(a.name)}</i>)}</span>
          <span>{t.assignees.length === 1 ? t.assignees[0].name : `${t.assignees[0].name} +${t.assignees.length - 1}`}</span>
        </span>
        <b className="hs-proc-pct">{t.progress}<small>%</small></b>
      </div>
      <p className="hs-task-title"><Rich text={t.title} /></p>
      {t.description?.trim() && <p className="hs-task-desc"><Rich text={t.description} /></p>}
      <span className="hs-proc-bar" aria-label={`${t.progress}% done`}><i /></span>
      {t.lastNote && <p className="hs-proc-note">“<Rich text={t.lastNote.body} />” <small>· {ago(t.lastNote.at)}</small></p>}
      <div className="hs-task-meta">
        <span className={`hs-st is-${t.status}`}><i />{STATUS_LABEL[t.status]}</span>
        {prioFlag(t)}
        <DueChip dueAt={t.due_at} todayIso={today} done={t.done} />
        {dealChip(t)}
      </div>
    </li>
  );

  const tabIndex = TABS.indexOf(tab);
  // The sliding pill takes the size of the tab it sits on (tabs are as wide as their words).
  const segRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const seg = segRef.current;
    if (!seg) return;
    const place = () => {
      const b = seg.querySelector<HTMLButtonElement>('button[aria-selected="true"]');
      if (!b) return;
      seg.style.setProperty("--pl", `${b.offsetLeft}px`);
      seg.style.setProperty("--pw", `${b.offsetWidth}px`);
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    ro?.observe(seg);
    return () => ro?.disconnect();
  }, [tab, loading, quick.length, processes.length, delegatedOpen.length]);
  const openTask = tasks.find((t) => t.id === openId) ?? delegated.find((t) => t.id === openId) ?? null;

  return (
    <section className="hs-card hs-todo" aria-label="To-do">
      <header className="hs-head">
        <button className="hs-expand" onClick={() => setWorkspace("")} title="Open every task in a full window" aria-label="Open full window"><ExpandIcon /></button>
        <div className="hs-titles">
          <span className="hs-eyebrow">To-do</span>
          <h2 className="hs-title">
            {loading ? "Your tasks" : openTasks.length ? <><span className="hs-count">{openTasks.length}</span> to do</> : "All clear"}
          </h2>
          {!loading && (overdue > 0 || urgent > 0) && (
            <div className="hs-flags">
              {overdue > 0 && <span className="hs-late-pill">{overdue} overdue</span>}
              {urgent > 0 && <span className="hs-late-pill is-urgent">{urgent} urgent</span>}
            </div>
          )}
        </div>
      </header>
      <div className="hs-seg is-4" ref={segRef} role="tablist" aria-label="Tasks" data-i={tabIndex}>
        <i className="hs-seg-pill" aria-hidden="true" />
        <button role="tab" aria-selected={tab === "quick"} onClick={() => setTab("quick")}><span>Quick</span>{quick.length ? <em>{quick.length}</em> : null}</button>
        <button role="tab" aria-selected={tab === "process"} onClick={() => setTab("process")}><span>Processes</span>{processes.length ? <em>{processes.length}</em> : null}</button>
        <button role="tab" aria-selected={tab === "delegated"} onClick={() => setTab("delegated")} title="Tasks you made and gave to someone else">
          <span>Delegated</span>{delegatedOpen.length ? <em>{delegatedOpen.length}</em> : null}
        </button>
        <button role="tab" aria-selected={tab === "done"} onClick={() => setTab("done")}><span>Done</span></button>
      </div>

      {(tab === "quick" || tab === "process") && (
        <div className={`hs-add ${draft.trim() ? "is-writing" : ""}`}>
          <div className="hs-add-row">
          <button type="button" className={`hs-prio is-${draftPrio} is-solid`} title={`Priority: ${PRIORITY_LABEL[draftPrio]} — click to change`}
            onClick={() => setDraftPrio(TASK_PRIORITIES[(TASK_PRIORITIES.indexOf(draftPrio) + 1) % TASK_PRIORITIES.length])}>
            <FlagIcon />
          </button>
          <input value={draft} onChange={(e) => { setDraft(e.target.value); if (!e.target.value.trim()) setDraftFrom(null); }} onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder={tab === "process" ? "Name a process… (longer work, with progress)" : "Name a quick task…"} aria-label="Task name" />
          {!draft.trim() && <TemplatePicker templates={templates} kind={tab === "process" ? "process" : "quick"} onPick={pickTemplate} compact />}
          <div className="hs-add-due"><DatePicker value={draftDue} onChange={setDraftDue} placeholder="Due" /></div>
          <button type="button" className="hs-add-go" onClick={add} disabled={!draft.trim() || adding} aria-label="Add task">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          </div>
          {draft.trim() && (
            <textarea className="hs-add-desc" value={draftDesc} rows={2} onChange={(e) => setDraftDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void add(); }}
              placeholder="Description (optional) — what exactly needs doing" aria-label="Description" />
          )}
          {draft.trim() && draftFrom && (
            <div className="hs-add-from">
              <SparkIcon /><span>From a template · {draftFrom.kind === "process" ? "process" : "quick task"}{draftFrom.checklist.length ? ` · ${draftFrom.checklist.length} steps` : ""}</span>
              <button onClick={() => setDraftFrom(null)} aria-label="Don't use the template">×</button>
            </div>
          )}
        </div>
      )}
      {err && <p className="hs-err" role="alert">{err} <button onClick={() => setErr(null)} aria-label="Dismiss">×</button></p>}

      {loading ? (
        <div className="hs-skel hs-skel-tall" />
      ) : tab === "quick" ? (
        groups.length === 0 ? (
          <div className="hs-clear">
            <span className="hs-clear-art" aria-hidden="true">{EMPTY_ART.quick}</span>
            <b>Nothing quick to do</b>
            <small>Type above to add one — or tasks you're tagged on in a deal show up here.</small>
          </div>
        ) : (
          <div className="hs-task-groups">
            {groups.map((g) => (
              <div key={g.key} className={`hs-task-group is-${g.key}`}>
                <span className="hs-task-group-h">{g.label}<i>{g.items.length}</i></span>
                <ul>{g.items.map((t, i) => row(t, i))}</ul>
              </div>
            ))}
          </div>
        )
      ) : tab === "process" ? (
        processes.length === 0 ? (
          <div className="hs-clear">
            <span className="hs-clear-art is-process" aria-hidden="true">{EMPTY_ART.process}</span>
            <b>No processes running</b>
            <small>For longer work: give it a status and a %, and post notes on where it's at.</small>
          </div>
        ) : (
          <ul className="hs-task-groups hs-procs">{processes.map((t, i) => card(t, i))}</ul>
        )
      ) : tab === "delegated" ? (
        delegated.length === 0 ? (
          <div className="hs-clear">
            <span className="hs-clear-art is-delegated" aria-hidden="true">{EMPTY_ART.delegated}</span>
            <b>Nothing delegated</b>
            <small>When you create a task and tag someone with @, you can follow it from here.</small>
          </div>
        ) : (
          <ul className="hs-task-groups hs-procs">
            {delegatedOpen.map((t, i) => sent(t, i))}
            {delegatedDone.length > 0 && <li className="hs-task-group-h hs-sent-sep">Done<i>{delegatedDone.length}</i></li>}
            {delegatedDone.slice(0, 20).map((t, i) => sent(t, delegatedOpen.length + i))}
          </ul>
        )
      ) : done.length === 0 ? (
        <div className="hs-clear">
          <span className="hs-clear-art is-done" aria-hidden="true">{EMPTY_ART.done}</span>
          <b>Nothing ticked off yet</b>
          <small>Tasks you finish land here.</small>
        </div>
      ) : (
        <ul className="hs-task-done-list">{done.map((t, i) => row(t, i))}</ul>
      )}

      {openTask && createPortal(
        <TaskPanel task={openTask} onClose={() => setOpenId(null)}
          onChange={(patch) => patchLocal(openTask.id, patch)}
          onOpenDeal={openTask.tracking_id ? () => nav(`/sales?tracking=${openTask.tracking_id}`) : undefined}
          onDelete={canDeleteTask(openTask, meId) ? () => remove(openTask) : undefined}
          onExpand={() => { setWorkspace(openTask.id); setOpenId(null); }} />,
        document.body,
      )}
      {workspace !== null && (
        <TaskWorkspace initialId={workspace || null} onClose={() => { setWorkspace(null); setReloadKey((k) => k + 1); }} />
      )}
    </section>
  );
}

/* ============================ Icons ============================ */
const ExpandIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>
);
const CollapseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7" /></svg>
);
const LockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);
const SparkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></svg>
);
const StepsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg>
);

/* ============================ Predefined tasks: picker ============================
   A small button that opens the company's predefined tasks and processes
   (Settings → Tasks). Picking one fills in name, description, priority,
   deadline and — for a process — its steps. */
export function TemplatePicker({ templates, kind, onPick, compact }: {
  templates: TaskTemplate[]; kind?: TaskKind; onPick: (t: TaskTemplate) => void; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean }>({ left: 0, top: 0, up: false });
  const btn = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc, true); };
  }, [open]);
  if (!templates.length) return null;
  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) {
      const up = r.bottom + 340 > window.innerHeight && r.top > 340;
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), top: up ? r.top - 8 : r.bottom + 8, up });
    }
    setOpen((v) => !v);
  };
  const sorted = [...templates].sort((a, b) => (a.kind === kind ? 0 : 1) - (b.kind === kind ? 0 : 1));
  const groupsOf: { k: TaskKind; label: string; items: TaskTemplate[] }[] = (["quick", "process"] as TaskKind[])
    .map((k) => ({ k, label: k === "quick" ? "Quick tasks" : "Processes", items: sorted.filter((t) => t.kind === k) }))
    .filter((g) => g.items.length)
    .sort((a, b) => (a.k === kind ? -1 : b.k === kind ? 1 : 0));
  const dueRule = (t: TaskTemplate) => t.due_in_days == null ? null : t.due_in_days === 0 ? `Due today · ${t.due_time}` : t.due_in_days === 1 ? `Due tomorrow · ${t.due_time}` : `Due in ${t.due_in_days} days · ${t.due_time}`;
  return (
    <>
      <button ref={btn} type="button" className={`htpl-btn ${compact ? "is-compact" : ""} ${open ? "is-open" : ""}`} onClick={toggle}
        title="Start from a predefined task or process" aria-haspopup="menu" aria-expanded={open}>
        <SparkIcon />{!compact && <span>Templates</span>}
      </button>
      {open && createPortal(
        <div ref={pop} className={`htpl-pop ${pos.up ? "is-up" : ""}`} role="menu"
          style={{ left: pos.left, top: pos.top, transform: pos.up ? "translateY(-100%)" : undefined }}>
          {groupsOf.map((g) => (
            <div key={g.k} className="htpl-group">
              <span className="htpl-group-h">{g.label}</span>
              {g.items.map((t, i) => (
                <button key={t.id} role="menuitem" className={`htpl-item is-p-${t.priority}`} style={{ ["--i" as string]: i } as React.CSSProperties}
                  onClick={() => { onPick(t); setOpen(false); }}>
                  <span className={`htpl-ico is-${t.kind}`}>{t.kind === "process" ? <StepsIcon /> : <FlagIcon />}</span>
                  <span className="htpl-txt">
                    <b>{t.title}</b>
                    <small>
                      {[dueRule(t), t.checklist.length ? `${t.checklist.length} steps` : null, t.priority !== "normal" ? PRIORITY_LABEL[t.priority] : null].filter(Boolean).join(" · ") || (t.description ?? "")}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/* ============================ One task in detail ============================
   Everything about a task: name, description, kind, priority, deadline, where
   it's at (status, %, steps), progress notes. Two layouts: "panel" (the slide-in
   on Home / Sales) and "page" (inside the full-window task view).
   Only whoever created the task can move its deadline or delete it. */
function TaskDetail({ task, layout, onClose, onChange, onOpenDeal, onDelete, onExpand, onCollapse }: {
  task: MyTask & { assignees?: { id: string; name: string }[] };
  layout: "panel" | "page";
  onClose: () => void;
  onChange: (patch: Partial<MyTask>) => void;
  onOpenDeal?: () => void;
  onDelete?: () => void | Promise<void>;
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [progress, setProgress] = useState<number>(task.progress);
  const [note, setNote] = useState("");
  const [updates, setUpdates] = useState<TaskUpdate[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [meId, setMeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState(plain(task.title));
  const [desc, setDesc] = useState(plain(task.description ?? ""));
  const [confirmDel, setConfirmDel] = useState(false);
  const [newStep, setNewStep] = useState("");
  const steps = task.checklist ?? [];
  const stepsDone = steps.filter((s) => s.done).length;
  const byStep = steps.length > 0;
  const dirty = status !== task.status || progress !== task.progress || !!note.trim();

  // Another task picked (page layout): start from its values.
  useEffect(() => {
    setStatus(task.status); setProgress(task.progress); setNote(""); setErr(null); setConfirmDel(false);
    setTitle(plain(task.title)); setDesc(plain(task.description ?? ""));
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Changes made elsewhere (a step ticked, the list's tick) show up here too.
  useEffect(() => { setStatus(task.status); setProgress(task.progress); }, [task.status, task.progress]);

  useEffect(() => {
    let alive = true;
    setUpdates(null);
    void supabase.auth.getSession().then(({ data }) => { if (alive) setMeId(data?.session?.user?.id ?? null); });
    loadTaskUpdates(task.id).then(async (u) => {
      if (!alive) return;
      setUpdates(u);
      const ids = [...new Set([...u.map((x) => x.author_id), task.created_by].filter(Boolean))] as string[];
      if (ids.length) {
        const { data } = await supabase.from("profiles").select("id, first_name, last_name").in("id", ids);
        if (alive) setNames(Object.fromEntries(((data ?? []) as any[]).map((p) => [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || "—"])));
      }
    });
    if (layout !== "panel") return () => { alive = false; };
    // Capture phase: Escape closes this panel only, not a list it was opened from.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => { alive = false; window.removeEventListener("keydown", key, true); };
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isCreator = !task.created_by || (!!meId && task.created_by === meId);
  const creatorName = task.created_by ? (task.created_by === meId ? "you" : names[task.created_by] ?? "the creator") : null;

  const meta = async (patch: Partial<MyTask>) => {
    const prev: Partial<MyTask> = Object.fromEntries(Object.keys(patch).map((k) => [k, (task as any)[k]]));
    onChange(patch); setErr(null);
    const e = await updateTaskMeta(task.id, patch as any);
    if (e) { setErr(e); onChange(prev); }
  };
  const pickStatus = (s: TaskStatus) => {
    setStatus(s);
    if (s === "done") setProgress(100);
    else if (s === "todo" && progress === 100) setProgress(0);
    else if (s === "in_progress" && progress === 0) setProgress(10);
  };
  /** The % moves the status along: 0 → To do, 1–99 → In progress (unless blocked), 100 → Done. */
  const statusFor = (v: number, cur: TaskStatus): TaskStatus =>
    v === 100 ? "done" : v === 0 ? (cur === "blocked" ? "blocked" : "todo") : cur === "done" || cur === "todo" ? "in_progress" : cur;
  const pickProgress = (v: number) => { setProgress(v); setStatus(statusFor(v, status)); };

  // ---- steps: ticking them moves the % (and the status) and saves straight away ----
  const saveSteps = (list: TaskStep[]) => {
    if (!list.length) { void meta({ checklist: list }); return; }
    const pct = Math.round((list.filter((s) => s.done).length / list.length) * 100);
    const st = statusFor(pct, task.status);
    setProgress(pct); setStatus(st);
    void meta({ checklist: list, progress: pct, status: st, done: st === "done" });
  };
  const toggleStep = (id: string) => saveSteps(steps.map((s) => (s.id === id ? { ...s, done: !s.done } : s)));
  const removeStep = (id: string) => saveSteps(steps.filter((s) => s.id !== id));
  const addStep = () => {
    const t = newStep.trim();
    if (!t) return;
    setNewStep("");
    saveSteps([...steps, { id: newStepId(), text: t, done: false }]);
  };
  const renameStep = (id: string, text: string) => {
    const t = text.trim();
    if (!t) { removeStep(id); return; }
    if (steps.find((s) => s.id === id)?.text !== t) void meta({ checklist: steps.map((s) => (s.id === id ? { ...s, text: t } : s)) });
  };

  const save = async () => {
    setSaving(true); setErr(null);
    const { update, error } = await addTaskUpdate(task.id, { body: note, status, progress });
    setSaving(false);
    if (error) { setErr(error); return; }
    onChange({
      status, progress: status === "done" ? 100 : progress, done: status === "done",
      ...(update?.body ? { lastNote: { body: update.body, at: update.created_at, author: update.author_id } } : {}),
    });
    if (update) setUpdates((u) => [update, ...(u ?? [])]);
    setNote("");
  };
  const saveTitle = () => {
    const v = title.trim();
    if (v && v !== plain(task.title).trim()) void meta({ title: v }); // (an untouched title keeps its @mentions)
    else setTitle(plain(task.title));
  };
  const saveDesc = () => {
    const v = desc.trim();
    if (v !== plain(task.description ?? "").trim()) void meta({ description: v || null }); // (untouched keeps its @mentions)
  };

  const due = task.due_at ? dueInfo(task.due_at, isoDay(new Date())) : null;
  const created = task.created_at ? new Date(task.created_at) : null;

  /* ---------- the pieces ---------- */
  const priorityRow = (
    <div className="htp-row">
      <span className="htp-lbl">Priority</span>
      <div className="htp-prios">
        {TASK_PRIORITIES.map((p) => (
          <button key={p} className={`hs-prio is-${p} ${task.priority === p ? "is-on" : ""}`} onClick={() => task.priority !== p && meta({ priority: p })}>
            <FlagIcon /><span>{PRIORITY_LABEL[p]}</span>
          </button>
        ))}
      </div>
    </div>
  );
  const deadlineRow = (
    <div className="htp-row is-top">
      <span className="htp-lbl">Deadline</span>
      <div className="htp-deadline">
        {isCreator ? (
          <div className="htp-due">
            <DatePicker value={dayOf(task.due_at) ?? ""} onChange={(d) => meta({ due_at: d ? `${d}T${timeOf(task.due_at) ?? "18:00"}:00` : null })} placeholder="No deadline" />
            {task.due_at && (
              <TimePicker value={timeOf(task.due_at) ?? "18:00"} ariaLabel="Due time"
                onChange={(tm) => meta({ due_at: `${dayOf(task.due_at)}T${tm || "18:00"}:00` })} />
            )}
          </div>
        ) : null}
        {due ? (
          <div className={`htp-due-say is-${task.done ? "done" : due.tone} ${isCreator ? "" : "is-locked"}`}>
            <CalIcon /><b>{due.day}{due.time ? ` · ${due.time}` : ""}</b><span>{task.done ? "done" : due.rel}</span>
            {isCreator
              ? <button className="htp-clear" onClick={() => meta({ due_at: null })}>Remove</button>
              : <i className="htp-lock" title={`Only ${creatorName} can change the deadline`}><LockIcon /></i>}
          </div>
        ) : !isCreator ? (
          <div className="htp-due-say is-none is-locked"><CalIcon /><b>No deadline</b><i className="htp-lock"><LockIcon /></i></div>
        ) : null}
        {!isCreator && <small className="htp-lock-note">Only {creatorName} can change the deadline.</small>}
      </div>
    </div>
  );
  const whereBox = (
    <div className="htp-where">
      <span className="htp-lbl">Where it's at</span>
      <div className="htp-status" role="radiogroup" aria-label="Status">
        {TASK_STATUSES.map((s) => (
          <button key={s} role="radio" aria-checked={status === s} className={`is-${s} ${status === s ? "is-on" : ""}`} onClick={() => pickStatus(s)}>
            <i />{STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      <div className={`htp-progress ${byStep ? "is-by-steps" : ""}`} style={{ ["--pct" as string]: `${progress}%` } as React.CSSProperties}>
        <b>{progress}<small>%</small></b>
        {byStep ? (
          <div className="htp-stepbar">
            <span className="htp-stepbar-track"><i /></span>
            <small>{stepsDone} of {steps.length} steps done · the % follows the steps</small>
          </div>
        ) : (
          <>
            <input type="range" min={0} max={100} step={5} value={progress} onChange={(e) => pickProgress(Number(e.target.value))} aria-label="Percent done" />
            <div className="htp-steps">
              {[0, 25, 50, 75, 100].map((v) => <button key={v} className={progress === v ? "is-on" : ""} onClick={() => pickProgress(v)}>{v}%</button>)}
            </div>
          </>
        )}
      </div>
      <textarea className="htp-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3}
        placeholder="Add an update — what's done, what's next, what's blocking it…" />
      <div className="htp-save">
        {err && <span className="htp-err">{err}</span>}
        <button className="htp-btn is-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : note.trim() ? "Post update" : "Save"}
        </button>
      </div>
    </div>
  );
  const stepsBox = (task.kind === "process" || byStep) && (
    <div className="htp-checklist">
      <div className="htp-checklist-h">
        <span className="htp-lbl">Steps</span>
        {byStep && <span className="htp-checklist-count"><b>{stepsDone}</b>/{steps.length}</span>}
      </div>
      {byStep && (
        <ol>
          {steps.map((s, i) => (
            <li key={s.id} className={s.done ? "is-done" : ""} style={{ ["--i" as string]: i } as React.CSSProperties}>
              <button className="htp-step-check" role="checkbox" aria-checked={s.done} onClick={() => toggleStep(s.id)} aria-label={s.done ? "Not done" : "Done"}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path pathLength={1} d="M6 12.5l4 4 8-9" /></svg>
              </button>
              <span className="htp-step-n">{i + 1}</span>
              <input className="htp-step-text" defaultValue={s.text} key={s.text}
                onBlur={(e) => renameStep(s.id, e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} aria-label={`Step ${i + 1}`} />
              <button className="htp-step-x" onClick={() => removeStep(s.id)} aria-label="Remove step">×</button>
            </li>
          ))}
        </ol>
      )}
      <div className="htp-step-add">
        <span aria-hidden="true">+</span>
        <input value={newStep} onChange={(e) => setNewStep(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addStep(); }}
          placeholder={byStep ? "Add a step…" : "Break it into steps — ticking them moves the %"} aria-label="New step" />
        {newStep.trim() && <button onClick={addStep}>Add</button>}
      </div>
    </div>
  );
  const timeline = (
    <div className="htp-timeline">
      <span className="htp-lbl">Updates</span>
      {updates === null ? <div className="hs-skel" style={{ height: 60 }} />
        : updates.length === 0 ? <p className="hs-empty">No updates yet.</p>
        : (
          <ol>
            {updates.map((u) => (
              <li key={u.id} className={u.status ? `is-${u.status}` : ""}>
                <i aria-hidden="true" />
                <div>
                  <div className="htp-tl-head">
                    <b>{u.author_id && u.author_id === meId ? "You" : (u.author_id && names[u.author_id]) || "Someone"}</b>
                    {u.status && <span className={`hs-st is-${u.status}`}>{STATUS_LABEL[u.status]}{u.progress != null && u.status !== "done" ? ` · ${u.progress}%` : ""}</span>}
                    <small>{ago(u.created_at)}</small>
                  </div>
                  {u.body && <p><Rich text={u.body} /></p>}
                </div>
              </li>
            ))}
          </ol>
        )}
    </div>
  );
  const about = (
    <div className="htp-about">
      {creatorName && <span><i>Created by</i><b>{creatorName === "you" ? "You" : creatorName}</b>{created && <em>{created.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</em>}</span>}
      {task.assignees && task.assignees.length > 0 && (
        <span><i>Given to</i><b className="htp-about-who">{task.assignees.map((a) => <em key={a.id} className="htp-av">{initials(a.name)}</em>)}{task.assignees.map((a) => a.name).join(", ")}</b></span>
      )}
      {task.promoted_at && <span className="htp-promoted"><SparkIcon />Became a process on {new Date(task.promoted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} (it stayed open too long for a quick task)</span>}
    </div>
  );
  const danger = onDelete && (
    <div className={`htp-danger ${confirmDel ? "is-asking" : ""}`}>
      {confirmDel ? (
        <>
          <span>Delete this task and its updates?</span>
          <button className="htp-btn" onClick={() => setConfirmDel(false)}>Cancel</button>
          <button className="htp-btn is-danger" onClick={() => void onDelete()}>Delete</button>
        </>
      ) : (
        <button className="htp-del" onClick={() => setConfirmDel(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
          Delete task
        </button>
      )}
    </div>
  );

  return (
    <div className={`htp is-${status} ${layout === "page" ? "is-page" : ""}`} role={layout === "panel" ? "dialog" : "region"} aria-modal={layout === "panel" ? true : undefined} aria-label="Task">
      <header className={`htp-head is-p-${task.priority}`}>
        <div className="htp-head-top">
          <div className="htp-kind" role="radiogroup" aria-label="Kind of task">
            {(["quick", "process"] as TaskKind[]).map((k) => (
              <button key={k} role="radio" aria-checked={task.kind === k} className={task.kind === k ? "is-on" : ""} onClick={() => task.kind !== k && meta({ kind: k })}>
                {k === "quick" ? "Quick task" : "Process"}
              </button>
            ))}
          </div>
          <div className="htp-head-tools">
            {onExpand && <button className="htp-x" onClick={onExpand} aria-label="Open full window" title="Open full window — every task, side by side"><ExpandIcon /></button>}
            {onCollapse && <button className="htp-x" onClick={onCollapse} aria-label="Back to the side panel" title="Back to the side panel"><CollapseIcon /></button>}
            {layout === "panel" && <button className="htp-x" onClick={onClose} aria-label="Close">×</button>}
          </div>
        </div>
        <textarea className="htp-title" ref={grow} value={title} rows={1} onChange={(e) => { setTitle(e.target.value); grow(e.target); }} onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }}
          placeholder="Task name" aria-label="Task name" />
        <textarea className="htp-desc" ref={grow} value={desc} rows={1}
          onChange={(e) => { setDesc(e.target.value); grow(e.target); }} onBlur={saveDesc}
          placeholder="Add a description — the details, links, what done looks like…" aria-label="Description" />
        <div className="htp-sub">
          {task.tracking_id
            ? <button className={`hs-task-deal ${onOpenDeal ? "" : "is-here"}`} onClick={onOpenDeal} disabled={!onOpenDeal}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7h18v13H3z" /><path d="M8 7V4h8v3" /></svg><span>{task.deal}</span></button>
            : <span className="hs-task-personal">Personal</span>}
          {due && <DueChip dueAt={task.due_at} todayIso={isoDay(new Date())} done={task.done} />}
        </div>
      </header>

      {layout === "page" ? (
        <div className="htp-body htp-grid" key={task.id}>
          <div className="htp-main">{whereBox}{stepsBox}{timeline}</div>
          <aside className="htp-side">{priorityRow}{deadlineRow}{about}{danger}</aside>
        </div>
      ) : (
        <div className="htp-body">
          {priorityRow}{deadlineRow}{whereBox}{stepsBox}{timeline}{about}{danger}
        </div>
      )}
    </div>
  );
}

/** The slide-in panel (Home, Sales). ⤢ opens the full-window task view. */
export function TaskPanel({ task, onClose, onChange, onOpenDeal, onDelete, onExpand }: {
  task: MyTask & { assignees?: { id: string; name: string }[] }; onClose: () => void; onChange: (patch: Partial<MyTask>) => void;
  /** Click on the deal chip (left out when you're already on the deal). */
  onOpenDeal?: () => void;
  onDelete?: () => void | Promise<void>;
  onExpand?: () => void;
}) {
  return (
    <div className="htp-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <TaskDetail task={task} layout="panel" onClose={onClose} onChange={onChange} onOpenDeal={onOpenDeal} onDelete={onDelete} onExpand={onExpand} />
    </div>
  );
}

/* ============================ Full-window task view ============================
   Every task at once: views on the left (all, quick, processes, delegated,
   done), the list in the middle (search, priority filter, grouped by when it's
   due or by stage), and the task in detail on the right. Opened with ⤢ from the
   panel or the to-do card. */
type WsView = "all" | "quick" | "process" | "delegated" | "done";
const WS_VIEWS: { key: WsView; label: string; hint: string }[] = [
  { key: "all", label: "Everything open", hint: "All you have to do" },
  { key: "quick", label: "Quick tasks", hint: "Tick and forget" },
  { key: "process", label: "Processes", hint: "Longer work, with progress" },
  { key: "delegated", label: "Delegated", hint: "Given to someone else" },
  { key: "done", label: "Done", hint: "Ticked off" },
];
export function TaskWorkspace({ initialId, extra, onClose }: {
  initialId?: string | null;
  /** A task that may not be in "my" lists (e.g. opened from a deal): shown anyway. */
  extra?: MyTask | null;
  onClose: () => void;
}) {
  const nav = useNavigate();
  const today = isoDay(new Date());
  const [mine, setMine] = useState<MyTask[]>([]);
  const [sent, setSent] = useState<DelegatedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [meId, setMeId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [view, setView] = useState<WsView>("all");
  const [q, setQ] = useState("");
  const [prios, setPrios] = useState<Set<TaskPriority>>(new Set());
  const [selId, setSelId] = useState<string | null>(initialId ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  // new task
  const [draft, setDraft] = useState<{ title: string; description: string; priority: TaskPriority; kind: TaskKind; due_at: string | null; checklist: TaskStep[]; template_id: string | null }>(
    { title: "", description: "", priority: "normal", kind: "quick", due_at: null, checklist: [], template_id: null });
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => { if (alive) setMeId(data?.session?.user?.id ?? null); });
    void loadTaskTemplates().then((t) => { if (alive) setTemplates(t); });
    Promise.all([loadMyTasks(), loadDelegatedTasks().catch(() => [] as DelegatedTask[])]).then(([m, d]) => {
      if (!alive) return;
      const given = new Set(d.map((x) => x.id));
      const list = m.filter((x) => !(given.has(x.id) && !x.assigned));
      if (extra && !list.some((x) => x.id === extra.id) && !given.has(extra.id)) list.unshift(extra);
      setMine(list); setSent(d); setLoading(false);
      const it = list.find((x) => x.id === initialId) ?? d.find((x) => x.id === initialId);
      if (it) setView(d.some((x) => x.id === it.id) ? "delegated" : it.done ? "done" : "all");
    }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { setClosing(true); window.setTimeout(onClose, 220); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("keydown", key, true);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", key, true); document.body.style.overflow = prev; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (id: string, p: Partial<MyTask>) => {
    setMine((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
    setSent((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
  };
  const remove = async (t: MyTask) => {
    const e = await deleteTask(t.id);
    if (e) { setErr(e); return; }
    setMine((xs) => xs.filter((x) => x.id !== t.id)); setSent((xs) => xs.filter((x) => x.id !== t.id)); setSelId(null);
  };
  const tick = (t: MyTask) => {
    const v = !t.done;
    patch(t.id, { done: v, status: v ? "done" : t.progress > 0 && t.progress < 100 ? "in_progress" : "todo", progress: v ? 100 : t.progress === 100 ? 0 : t.progress });
    void toggleTask(t.id, v);
  };

  const counts = {
    all: mine.filter((t) => !t.done).length,
    quick: mine.filter((t) => !t.done && t.kind === "quick").length,
    process: mine.filter((t) => !t.done && t.kind === "process").length,
    delegated: sent.filter((t) => !t.done).length,
    done: mine.filter((t) => t.done).length,
  };
  const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const source: (MyTask | DelegatedTask)[] = view === "delegated" ? sent : mine;
  const shown = source
    .filter((t) => view === "done" ? t.done : view === "delegated" ? true : !t.done && (view === "all" || t.kind === view))
    .filter((t) => !prios.size || prios.has(t.priority))
    .filter((t) => { const n = norm(q.trim()); return !n || norm(`${plain(t.title)} ${plain(t.description ?? "")} ${t.deal ?? ""}`).includes(n); });
  const byPrio = (a: MyTask, b: MyTask) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999");
  const groupOf = (t: MyTask): Group => {
    const d = dayOf(t.due_at);
    if (!d) return "none";
    const diff = daysBetween(today, d);
    return diff < 0 ? "overdue" : diff === 0 ? "today" : diff <= 7 ? "week" : "later";
  };
  const groups: { key: string; label: string; items: MyTask[] }[] = view === "process" || view === "delegated"
    ? (["blocked", "in_progress", "todo", "done"] as TaskStatus[]).map((s) => ({ key: s, label: STATUS_LABEL[s], items: shown.filter((t) => t.status === s).sort(byPrio) })).filter((g) => g.items.length)
    : view === "done"
      ? [{ key: "done", label: "Done", items: [...shown].sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "")) }].filter((g) => g.items.length)
      : GROUPS.map((g) => ({ key: g.key, label: g.label, items: shown.filter((t) => groupOf(t) === g.key).sort(byPrio) })).filter((g) => g.items.length);

  const sel = [...mine, ...sent].find((t) => t.id === selId) ?? null;
  const isSent = (t: MyTask): t is DelegatedTask => "assignees" in t;

  const pickTemplate = (t: TaskTemplate) => {
    const f = fromTemplate(t);
    setDraft({ title: f.title, description: f.description, priority: f.priority, kind: f.kind, due_at: f.due_at, checklist: f.checklist, template_id: f.template_id });
  };
  const add = async () => {
    const title = draft.title.trim();
    if (!title || adding) return;
    setAdding(true); setErr(null);
    const kind: TaskKind = draft.template_id ? draft.kind : view === "process" ? "process" : draft.kind;
    const { task, error } = await addPersonalTask({ ...draft, title, kind });
    setAdding(false);
    if (error || !task) { setErr(error ?? "Couldn't add the task."); return; }
    setMine((xs) => [task, ...xs]); setSelId(task.id);
    if (view === "delegated" || view === "done") setView("all");
    setDraft({ title: "", description: "", priority: "normal", kind: "quick", due_at: null, checklist: [], template_id: null });
  };

  return createPortal(
    <div className={`htw-scrim ${closing ? "is-closing" : ""}`}>
      <div className="htw" role="dialog" aria-modal="true" aria-label="Tasks">
        <header className="htw-bar">
          <div className="htw-brand">
            <span className="htw-logo" aria-hidden="true"><StepsIcon /></span>
            <div><span className="hs-eyebrow">Your work</span><h1>Tasks</h1></div>
          </div>
          <label className="htw-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks, descriptions, deals…" />
            {q && <button onClick={() => setQ("")} aria-label="Clear">×</button>}
          </label>
          <div className="htw-prio-filter" role="group" aria-label="Priority">
            {TASK_PRIORITIES.map((p) => (
              <button key={p} className={`hs-prio is-${p} ${prios.has(p) ? "is-on" : ""}`}
                onClick={() => setPrios((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; })}>
                <FlagIcon /><span>{PRIORITY_LABEL[p]}</span>
              </button>
            ))}
          </div>
          <button className="htw-close" onClick={close} aria-label="Close (Esc)" title="Close (Esc)">
            <CollapseIcon /><span>Close</span>
          </button>
        </header>

        <div className="htw-body">
          <nav className="htw-nav" aria-label="Views">
            {WS_VIEWS.map((v, i) => (
              <button key={v.key} className={`htw-view is-${v.key} ${view === v.key ? "is-on" : ""}`} style={{ ["--i" as string]: i } as React.CSSProperties}
                onClick={() => setView(v.key)}>
                <span className="htw-view-ico" aria-hidden="true" />
                <span className="htw-view-txt"><b>{v.label}</b><small>{v.hint}</small></span>
                <em>{counts[v.key]}</em>
              </button>
            ))}
            <div className="htw-nav-sum">
              {(() => {
                const open = mine.filter((t) => !t.done);
                const late = open.filter((t) => groupOf(t) === "overdue").length;
                const urgent = open.filter((t) => t.priority === "urgent").length;
                const avg = open.filter((t) => t.kind === "process").reduce((s, t, _i, a) => s + t.progress / a.length, 0);
                return (
                  <>
                    <div><b className={late ? "is-late" : ""}>{late}</b><span>overdue</span></div>
                    <div><b className={urgent ? "is-urgent" : ""}>{urgent}</b><span>urgent</span></div>
                    <div><b>{Math.round(avg)}%</b><span>processes, on average</span></div>
                  </>
                );
              })()}
            </div>
          </nav>

          <section className="htw-list" aria-label="Task list">
            {view !== "delegated" && view !== "done" && (
              <div className={`htw-add ${draft.title.trim() ? "is-writing" : ""}`}>
                <div className="htw-add-row">
                  <button type="button" className={`hs-prio is-${draft.priority} is-solid`} title={`Priority: ${PRIORITY_LABEL[draft.priority]} — click to change`}
                    onClick={() => setDraft((d) => ({ ...d, priority: TASK_PRIORITIES[(TASK_PRIORITIES.indexOf(d.priority) + 1) % TASK_PRIORITIES.length] }))}>
                    <FlagIcon />
                  </button>
                  <input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                    placeholder={view === "process" ? "Name a new process…" : "Name a new task…"} aria-label="New task" />
                  <TemplatePicker templates={templates} kind={view === "process" ? "process" : "quick"} onPick={pickTemplate} compact />
                  <button className="hs-add-go" onClick={add} disabled={!draft.title.trim() || adding} aria-label="Add task">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                </div>
                {draft.title.trim() && (
                  <div className="htw-add-more">
                    <textarea value={draft.description} rows={2} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="Description (optional)" />
                    <div className="htw-add-meta">
                      <DatePicker value={dayOf(draft.due_at) ?? ""} onChange={(v) => setDraft((d) => ({ ...d, due_at: v ? `${v}T${timeOf(d.due_at) ?? "18:00"}:00` : null }))} placeholder="Deadline" />
                      {draft.due_at && <TimePicker value={timeOf(draft.due_at) ?? "18:00"} onChange={(tm) => setDraft((d) => ({ ...d, due_at: `${dayOf(d.due_at)}T${tm || "18:00"}:00` }))} ariaLabel="Due time" />}
                      {draft.checklist.length > 0 && <span className="htw-add-steps"><StepsIcon />{draft.checklist.length} steps</span>}
                    </div>
                  </div>
                )}
              </div>
            )}
            {err && <p className="hs-err" role="alert">{err} <button onClick={() => setErr(null)} aria-label="Dismiss">×</button></p>}
            <div className="htw-scroll" key={view}>
              {loading ? (
                <><div className="hs-skel" /><div className="hs-skel" /><div className="hs-skel" /></>
              ) : groups.length === 0 ? (
                <div className="htw-empty">
                  <span className={`hs-clear-art is-${view}`} aria-hidden="true">{EMPTY_ART[view]}</span>
                  <b>{q || prios.size ? "Nothing matches" : view === "done" ? "Nothing ticked off yet" : view === "delegated" ? "Nothing delegated" : "All clear"}</b>
                  <small>{q || prios.size ? "Try another search or priority." : view === "delegated" ? "Tag someone with @ on a task you create and follow it from here." : "Add a task above, or start from a template."}</small>
                </div>
              ) : groups.map((g) => (
                <div key={g.key} className={`htw-group is-${g.key}`}>
                  <span className="htw-group-h">{g.label}<i>{g.items.length}</i></span>
                  <ul>
                    {g.items.map((t, i) => (
                      <li key={t.id} className={`htw-item is-p-${t.priority} is-s-${t.status} ${t.done ? "is-done" : ""} ${selId === t.id ? "is-sel" : ""}`}
                        style={{ ["--i" as string]: i, ["--pct" as string]: `${t.progress}%` } as React.CSSProperties}
                        onClick={() => setSelId(t.id)}>
                        <button className="hs-check" role="checkbox" aria-checked={t.done} onClick={(e) => { e.stopPropagation(); tick(t); }} aria-label={t.done ? "Mark as not done" : "Mark as done"}>
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9" /></svg>
                        </button>
                        <div className="htw-item-body">
                          <b className="htw-item-title"><Rich text={t.title} /></b>
                          {t.description?.trim() && <span className="htw-item-desc"><Rich text={t.description} /></span>}
                          <div className="htw-item-meta">
                            {isSent(t) && <span className="hs-sent-who"><span className="hs-avatars">{t.assignees.slice(0, 3).map((a) => <i key={a.id}>{initials(a.name)}</i>)}</span><span>{t.assignees[0]?.name}{t.assignees.length > 1 ? ` +${t.assignees.length - 1}` : ""}</span></span>}
                            {t.priority !== "normal" && <span className={`hs-prio is-${t.priority}`}><FlagIcon /><span>{PRIORITY_LABEL[t.priority]}</span></span>}
                            {!t.done && (t.kind === "process" || t.status !== "todo") && <span className={`hs-st is-${t.status}`}><i />{STATUS_LABEL[t.status]}{t.kind === "process" ? ` · ${t.progress}%` : ""}</span>}
                            <DueChip dueAt={t.due_at} todayIso={today} done={t.done} />
                            {t.deal ? <span className="htw-item-deal">{t.deal}</span> : null}
                            {(t.checklist?.length ?? 0) > 0 && <span className="htw-item-steps"><StepsIcon />{t.checklist!.filter((s) => s.done).length}/{t.checklist!.length}</span>}
                          </div>
                          {t.kind === "process" && !t.done && <span className="htw-item-bar"><i /></span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <section className="htw-detail" aria-label="Task">
            {sel ? (
              <TaskDetail key="detail" task={sel} layout="page" onClose={() => setSelId(null)}
                onChange={(p) => patch(sel.id, p)}
                onOpenDeal={sel.tracking_id ? () => { onClose(); nav(`/sales?tracking=${sel.tracking_id}`); } : undefined}
                onDelete={canDeleteTask(sel, meId) ? () => remove(sel) : undefined} />
            ) : (
              <div className="htw-pick">
                <span className="htw-pick-art" aria-hidden="true"><StepsIcon /></span>
                <b>Pick a task</b>
                <small>Its status, steps, deadline and every update show up here.</small>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* Empty-state art: drawn with pathLength=1 so every stroke draws in full. */
const EMPTY_ART: Record<string, React.ReactNode> = {
  quick: <svg viewBox="0 0 24 24"><path pathLength={1} d="M6 12.5l4 4 8-9" /></svg>,
  all: <svg viewBox="0 0 24 24"><path pathLength={1} d="M6 12.5l4 4 8-9" /></svg>,
  process: <svg viewBox="0 0 24 24"><path pathLength={1} d="M3 12h4l2.5-6 5 12 2.5-6h4" /></svg>,
  delegated: <svg viewBox="0 0 24 24"><path pathLength={1} d="M21 3 10 14M21 3l-7 18-4-7-7-4z" /></svg>,
  done: <svg viewBox="0 0 24 24"><path pathLength={1} d="M4 13l4 4L18 7M10 17l1 1L21 8" /></svg>,
};
/* =====================================================================
   TICKET DESK (14_tickets.sql)
   Every task — deal tasks, personal to-dos, processes — is a ticket with
   a number, a stage, an owner, a type, a requester (ready for e-mail /
   Outlook later), links to a client / company / deal / project, tags,
   a conversation (replies + internal notes) and an activity log.
   Before the SQL runs it still works on the plain tasks (status / done).
   ===================================================================== */
export type TicketStage = "new" | "open" | "in_progress" | "waiting" | "resolved" | "closed";
export const TICKET_STAGES: { key: TicketStage; label: string; hint: string }[] = [
  { key: "new", label: "New", hint: "Nobody has looked at it yet" },
  { key: "open", label: "Open", hint: "Accepted, not started" },
  { key: "in_progress", label: "In progress", hint: "Someone is on it" },
  { key: "waiting", label: "Waiting", hint: "Blocked — on the client, a colleague or a third party" },
  { key: "resolved", label: "Resolved", hint: "Done; can be reopened" },
  { key: "closed", label: "Closed", hint: "Done and archived" },
];
export const stageLabel = (s: TicketStage) => TICKET_STAGES.find((x) => x.key === s)?.label ?? s;
const ACTIVE_STAGES: TicketStage[] = ["new", "open", "in_progress", "waiting"];
const isActive = (s: TicketStage) => ACTIVE_STAGES.includes(s);
const STAGE_STATUS: Record<TicketStage, TaskStatus> = { new: "todo", open: "todo", in_progress: "in_progress", waiting: "blocked", resolved: "done", closed: "done" };
const DEFAULT_TYPES = ["Request", "Incident", "Question", "Change", "Internal"];
export const TICKET_SOURCES: Record<string, string> = { manual: "Manual", email: "E-mail", sales: "Sales", phone: "Phone", portal: "Portal" };

export interface Ticket {
  id: string; no: number | null; title: string; description: string;
  stage: TicketStage; priority: TaskPriority; type: string | null;
  assignee: string | null; createdBy: string | null; watchers: string[]; team: string | null;
  requesterName: string | null; requesterEmail: string | null; requesterContactId: string | null;
  clientId: string | null; companyId: string | null; projectId: string | null; trackingId: string | null;
  tags: string[]; source: string; due: string | null;
  createdAt: string; updatedAt: string | null; resolvedAt: string | null;
  kind: TaskKind; progress: number; checklist: TaskStep[];
  /** First reply to the requester (SLA). */
  firstResponseAt: string | null;
  /** Merged into this ticket (19_ticket_mail.sql). */
  mergedInto: string | null;
}
export const ticketRef = (t: Pick<Ticket, "no" | "id">) => (t.no ? `T-${t.no}` : `#${t.id.slice(0, 4).toUpperCase()}`);

const stageFromRow = (r: any): TicketStage =>
  TICKET_STAGES.some((s) => s.key === r.stage) ? r.stage
    : r.done || r.status === "done" ? "resolved" : r.status === "in_progress" ? "in_progress" : r.status === "blocked" ? "waiting" : "open";
function toTicket(r: any, watchers: string[]): Ticket {
  return {
    id: r.id, no: r.ticket_no ?? null, title: r.title ?? "", description: r.description ?? "",
    stage: stageFromRow(r),
    priority: (["low", "normal", "high", "urgent"].includes(r.priority) ? r.priority : "normal") as TaskPriority,
    type: r.ticket_type ?? null, assignee: r.assignee_id ?? null, createdBy: r.created_by ?? null, watchers, team: r.team ?? null,
    requesterName: r.requester_name ?? null, requesterEmail: r.requester_email ?? null, requesterContactId: r.requester_contact_id ?? null,
    clientId: r.client_id ?? null, companyId: r.company_id ?? null, projectId: r.project_id ?? null, trackingId: r.tracking_id ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [], source: r.source ?? (r.tracking_id ? "sales" : "manual"), due: r.due_at ?? null,
    createdAt: r.created_at ?? new Date().toISOString(), updatedAt: r.updated_at ?? null,
    resolvedAt: r.resolved_at ?? r.completed_at ?? null,
    kind: r.kind === "process" ? "process" : "quick", progress: Math.max(0, Math.min(100, Number(r.progress) || 0)),
    checklist: (Array.isArray(r.checklist) ? r.checklist : []).filter((x: any) => x && typeof x.text === "string")
      .map((x: any) => ({ id: String(x.id ?? newStepId()), text: x.text, done: !!x.done })),
    firstResponseAt: r.first_response_at ?? null, mergedInto: r.merged_into ?? null,
  };
}

/* ---- who / what everything links to (shared with the global search) ---- */
export interface DirPerson { id: string; name: string; email: string; department: string | null; role: string | null }
export interface Directory {
  me: string | null; myDept: string | null;
  people: DirPerson[];
  clients: { id: string; name: string }[];
  companies: { id: string; name: string; legal: string | null }[];
  deals: { id: string; name: string; companyId: string | null; status: string | null }[];
  projects: { id: string; name: string; clientId: string | null }[];
  contacts: { id: string; name: string; email: string | null; title: string | null }[];
}
let dirPromise: Promise<Directory> | null = null;
export function loadDirectory(fresh = false): Promise<Directory> {
  if (dirPromise && !fresh) return dirPromise;
  dirPromise = (async () => {
    const { data: s } = await supabase.auth.getSession();
    const me = s?.session?.user?.id ?? null;
    const safe = (p: Promise<any[]>) => p.catch(() => [] as any[]);
    const [profs, clients, companies, deals, projects, contacts] = await Promise.all([
      safe(allRows(() => supabase.from("profiles").select("id, first_name, last_name, email, department, role"))),
      safe(allRows(() => supabase.from("clients").select("id, name"))),
      safe(allRows(() => supabase.from("companies").select("id, name, legal_name"))),
      safe(allRows(() => supabase.from("trackings").select("id, deal_name, company_id, status"))),
      safe(allRows(() => supabase.from("projects").select("id, name, client_id"))),
      safe(allRows(() => supabase.from("contacts").select("id, first_name, last_name, email, job_title"))),
    ]);
    const coName = new Map<string, string>(companies.map((c: any) => [c.id, c.name]));
    const people: DirPerson[] = profs.map((p: any) => ({
      id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || (p.email ?? "").split("@")[0] || "Someone",
      email: p.email ?? "", department: p.department ?? null, role: p.role ?? null,
    }));
    return {
      me, myDept: people.find((p) => p.id === me)?.department ?? null,
      people: people.sort((a, b) => a.name.localeCompare(b.name)),
      clients: clients.map((c: any) => ({ id: c.id, name: c.name ?? "Client" })),
      companies: companies.map((c: any) => ({ id: c.id, name: c.name ?? "Company", legal: c.legal_name ?? null })),
      deals: deals.map((d: any) => ({ id: d.id, name: (d.deal_name ?? "").trim() || coName.get(d.company_id) || "Deal", companyId: d.company_id ?? null, status: d.status ?? null })),
      projects: projects.map((p: any) => ({ id: p.id, name: p.name ?? "Project", clientId: p.client_id ?? null })),
      contacts: contacts.map((c: any) => ({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Contact", email: c.email ?? null, title: c.job_title ?? null })),
    };
  })();
  dirPromise.catch(() => { dirPromise = null; });
  return dirPromise;
}

/* ---- tickets: load / write ---- */
/** Fired after any ticket changes, so every desk / search on the page refreshes. */
export const TICKETS_EVENT = "tickets-changed";
const tell = () => window.dispatchEvent(new Event(TICKETS_EVENT));

export async function loadTickets(): Promise<{ tickets: Ticket[]; ready: boolean; ownedDeals: string[] }> {
  const { data: s } = await supabase.auth.getSession();
  const me = s?.session?.user?.id ?? null;
  const [rows, tags, owned] = await Promise.all([
    allRows(() => supabase.from("tracking_tasks").select("*").order("created_at", { ascending: false })).catch(() => [] as any[]),
    allRows(() => supabase.from("tracking_assignees").select("id, item_id, employee_id").eq("item_type", "task").eq("kind", "employee")).catch(() => [] as any[]),
    me ? Promise.resolve(supabase.from("tracking_employees").select("tracking_id").eq("profile_id", me).eq("is_owner", true)).then((r: any) => r?.data ?? []).catch(() => [] as any[]) : Promise.resolve([] as any[]),
  ]);
  let ready = rows.length ? "ticket_no" in rows[0] : false;
  if (!rows.length) {
    const { error } = await supabase.from("tracking_tasks").select("ticket_no").limit(1);
    ready = !error;
  }
  const byTask = new Map<string, string[]>();
  tags.forEach((a: any) => { if (!a.employee_id) return; const l = byTask.get(a.item_id) ?? []; if (!l.includes(a.employee_id)) l.push(a.employee_id); byTask.set(a.item_id, l); });
  // old resolved ones stay out of the way (the last 60 days are kept)
  const cutoff = Date.now() - 60 * 86400000;
  const tickets = rows.map((r: any) => toTicket(r, byTask.get(r.id) ?? []))
    .filter((t) => isActive(t.stage) || new Date(t.resolvedAt ?? t.updatedAt ?? t.createdAt).getTime() >= cutoff);
  return { tickets, ready, ownedDeals: owned.map((o: any) => o.tracking_id) };
}

const TICKET_COLS: Record<string, string> = {
  title: "title", description: "description", priority: "priority", due: "due_at", kind: "kind", progress: "progress", checklist: "checklist",
  type: "ticket_type", assignee: "assignee_id", team: "team", requesterName: "requester_name", requesterEmail: "requester_email",
  requesterContactId: "requester_contact_id", clientId: "client_id", companyId: "company_id", projectId: "project_id",
  trackingId: "tracking_id", tags: "tags", source: "source",
};
const NEEDS_SQL = "Run 14_tickets.sql in Supabase to turn tasks into tickets.";
/** Saves a change to a ticket. Stage also moves status / done (the trigger keeps them in step; before the SQL we set them). */
export async function saveTicket(id: string, patch: Partial<Ticket>, ready: boolean): Promise<string | null> {
  const row: any = {};
  Object.entries(patch).forEach(([k, v]) => { if (TICKET_COLS[k]) row[TICKET_COLS[k]] = v; });
  if (patch.stage) {
    if (ready) row.stage = patch.stage;
    else { row.status = STAGE_STATUS[patch.stage]; row.done = patch.stage === "resolved" || patch.stage === "closed"; }
  }
  if (!ready) {
    const extra = Object.keys(row).filter((k) => !["title", "description", "priority", "due_at", "kind", "progress", "checklist", "status", "done", "tracking_id"].includes(k));
    if (extra.length) return NEEDS_SQL;
  }
  const { error } = await supabase.from("tracking_tasks").update(row).eq("id", id);
  if (error) return /created this task/i.test(error.message) ? "Only the person who created it can move its deadline." : /column|schema cache/i.test(error.message) ? NEEDS_SQL : error.message;
  tell();
  return null;
}
export async function createTicket(t: Partial<Ticket> & { title: string }, ready: boolean): Promise<{ id: string | null; error: string | null }> {
  const row: any = { tracking_id: t.trackingId ?? null, phase_id: null, title: t.title.trim(), kind: t.kind ?? "quick", priority: t.priority ?? "normal", status: "todo", progress: 0, due_at: t.due ?? null };
  if (t.description?.trim()) row.description = t.description.trim();
  if (ready) {
    Object.entries(t).forEach(([k, v]) => { if (TICKET_COLS[k] && !(TICKET_COLS[k] in row) && v != null && !(Array.isArray(v) && !v.length)) row[TICKET_COLS[k]] = v; });
    row.stage = "new";
    if (!row.source) row.source = t.trackingId ? "sales" : "manual";
  }
  const { data, error } = await supabase.from("tracking_tasks").insert(row).select().single();
  if (error || !data) return { id: null, error: /column|schema cache/i.test(error?.message ?? "") ? NEEDS_SQL : error?.message ?? "Not saved." };
  const id = (data as any).id as string;
  if (t.watchers?.length) await Promise.all(t.watchers.map((w) => addAssignee("task", id, "employee", w)));
  tell();
  return { id, error: null };
}
export async function deleteTicket(id: string): Promise<string | null> {
  const e = await deleteTask(id);
  if (!e) tell();
  return e;
}
export async function setWatcher(id: string, personId: string, on: boolean): Promise<void> {
  if (on) await addAssignee("task", id, "employee", personId);
  else {
    const { data } = await supabase.from("tracking_assignees").select("id").eq("item_type", "task").eq("item_id", id).eq("kind", "employee").eq("employee_id", personId);
    await Promise.all(((data ?? []) as any[]).map((r) => removeAssignee(r.id)));
  }
  tell();
}

export interface TicketPost { id: string; author: string | null; body: string; visibility: "internal" | "reply"; at: string }
export interface TicketEvent { id: string; author: string | null; action: string; detail: any; at: string }
export async function loadTicketThread(id: string): Promise<{ posts: TicketPost[]; events: TicketEvent[] }> {
  const [{ data: up }, ev] = await Promise.all([
    supabase.from("tracking_task_updates").select("*").eq("task_id", id).order("created_at", { ascending: true }),
    Promise.resolve(supabase.from("ticket_events").select("*").eq("task_id", id).order("created_at", { ascending: true })).then((r: any) => (r?.error ? [] : r?.data ?? [])).catch(() => [] as any[]),
  ]);
  return {
    posts: ((up ?? []) as any[]).filter((u) => (u.body ?? "").trim()).map((u) => ({ id: u.id, author: u.author_id ?? null, body: u.body, visibility: u.visibility === "reply" ? "reply" : "internal", at: u.created_at })),
    events: (ev as any[]).map((e) => ({ id: e.id, author: e.author_id ?? null, action: e.action, detail: e.detail ?? {}, at: e.created_at })),
  };
}
export async function postToTicket(t: Ticket, body: string, visibility: "internal" | "reply", ready: boolean): Promise<{ post: TicketPost | null; error: string | null }> {
  const { data: s } = await supabase.auth.getSession();
  const me = s?.session?.user?.id ?? null;
  const row: any = { task_id: t.id, author_id: me, body: body.trim(), status: STAGE_STATUS[t.stage], progress: t.progress };
  if (ready) row.visibility = visibility;
  let { data, error } = await supabase.from("tracking_task_updates").insert(row).select().single();
  if (error && /visibility|column/i.test(error.message)) {
    delete row.visibility;
    ({ data, error } = await supabase.from("tracking_task_updates").insert(row).select().single());
  }
  if (error || !data) return { post: null, error: error?.message ?? "Not sent." };
  // the first reply on a new ticket opens it
  if (ready && t.stage === "new") await saveTicket(t.id, { stage: "open" }, ready);
  if (ready && visibility === "reply") await supabase.from("tracking_tasks").update({ first_response_at: new Date().toISOString() }).eq("id", t.id).is("first_response_at", null);
  tell();
  return { post: { id: (data as any).id, author: me, body: row.body, visibility, at: (data as any).created_at ?? new Date().toISOString() }, error: null };
}
export async function loadTicketTypes(): Promise<string[]> {
  const { data, error } = await supabase.from("crm_options").select("label, sort, kind").eq("kind", "ticket_type").order("sort");
  const own = error ? [] : ((data ?? []) as any[]).filter((r) => r.kind === "ticket_type").map((r) => r.label as string);
  return own.length ? own : DEFAULT_TYPES;
}
export async function addTicketType(label: string, sort: number): Promise<string | null> {
  const { error } = await supabase.from("crm_options").insert({ kind: "ticket_type", label: label.trim(), sort });
  return error ? (/duplicate|unique/i.test(error.message) ? null : /check/i.test(error.message) ? NEEDS_SQL : error.message) : null;
}

/** One ticket by id (for the global search and links). */
export async function loadTicket(id: string): Promise<{ ticket: Ticket | null; ready: boolean }> {
  const [{ data }, { data: tags }] = await Promise.all([
    supabase.from("tracking_tasks").select("*").eq("id", id).maybeSingle(),
    supabase.from("tracking_assignees").select("employee_id").eq("item_type", "task").eq("kind", "employee").eq("item_id", id),
  ]);
  if (!data) return { ticket: null, ready: false };
  const watchers = [...new Set(((tags ?? []) as any[]).map((t) => t.employee_id).filter(Boolean))] as string[];
  return { ticket: toTicket(data, watchers), ready: "ticket_no" in (data as any) };
}


/* =====================================================================
   E-MAIL, SLA, RULES, MERGING (19_ticket_mail.sql + the outlook-sync function)
   ===================================================================== */
export const MAIL_SQL = "Run 19_ticket_mail.sql in Supabase to bring e-mail into the desk.";
const missingTable = (m?: string | null) => /relation|does not exist|schema cache|column/i.test(m ?? "");

export interface MailPerson { name: string; email: string }
export interface MailAttachment { id: string; name: string; size: number; contentType: string }
export interface MailMsg {
  id: string; ticketId: string | null; mailboxId: string | null; ruleId: string | null; direction: "in" | "out";
  fromName: string | null; fromEmail: string | null; to: MailPerson[]; cc: MailPerson[];
  subject: string; snippet: string; html: string; at: string; conversationId: string | null;
  attachments: MailAttachment[]; status: "new" | "assigned" | "ignored"; sentBy: string | null;
}
const toMail = (r: any): MailMsg => ({
  id: r.id, ticketId: r.ticket_id ?? null, mailboxId: r.mailbox_id ?? null, ruleId: r.rule_id ?? null, direction: r.direction === "out" ? "out" : "in",
  fromName: r.from_name ?? null, fromEmail: r.from_email ?? null,
  to: Array.isArray(r.to_recipients) ? r.to_recipients : [], cc: Array.isArray(r.cc_recipients) ? r.cc_recipients : [],
  subject: r.subject ?? "", snippet: r.snippet ?? "", html: r.body_html ?? "", at: r.received_at ?? r.created_at,
  conversationId: r.conversation_id ?? null, attachments: Array.isArray(r.attachments) ? r.attachments : [],
  status: r.status === "assigned" || r.status === "ignored" ? r.status : "new", sentBy: r.sent_by ?? null,
});
/** The e-mails of a ticket (in and out), oldest first. null = the table is missing. */
export async function loadTicketMail(ticketId: string): Promise<MailMsg[] | null> {
  const { data, error } = await supabase.from("ticket_mail_messages").select("*").eq("ticket_id", ticketId).order("received_at");
  if (error) return missingTable(error.message) ? null : [];
  return ((data ?? []) as any[]).map(toMail);
}
/** Mail that reached the desk and isn't on a ticket yet. null = the table is missing. */
export async function loadInboxMail(): Promise<MailMsg[] | null> {
  const { data, error } = await supabase.from("ticket_mail_messages").select("*").eq("status", "new").is("ticket_id", null)
    .order("received_at", { ascending: false }).limit(300);
  if (error) return missingTable(error.message) ? null : [];
  return ((data ?? []) as any[]).map(toMail);
}
/** Puts a mail (and the rest of its conversation still in the Inbox) on a ticket. */
export async function setMailTicket(m: MailMsg, ticketId: string): Promise<string | null> {
  const { error } = await supabase.from("ticket_mail_messages").update({ ticket_id: ticketId, status: "assigned" }).eq("id", m.id);
  if (error) return error.message;
  if (m.conversationId) await supabase.from("ticket_mail_messages").update({ ticket_id: ticketId, status: "assigned" }).eq("conversation_id", m.conversationId).is("ticket_id", null);
  tell();
  return null;
}
export async function ignoreMail(id: string): Promise<string | null> {
  const { error } = await supabase.from("ticket_mail_messages").update({ status: "ignored" }).eq("id", id);
  return error?.message ?? null;
}
/** A new ticket from an e-mail: subject, text, requester (and their contact / company when known). */
export async function createTicketFromMail(m: MailMsg, dir: Directory, ready: boolean, extra: Partial<Ticket> = {}): Promise<{ id: string | null; error: string | null }> {
  const contact = m.fromEmail ? dir.contacts.find((c) => (c.email ?? "").toLowerCase() === m.fromEmail!.toLowerCase()) : undefined;
  const res = await createTicket({
    title: (m.subject || "(no subject)").slice(0, 300), description: m.snippet, source: "email",
    requesterName: m.fromName, requesterEmail: m.fromEmail, requesterContactId: contact?.id ?? null, assignee: dir.me,
    ...extra,
  }, ready);
  if (res.id) await setMailTicket(m, res.id);
  return res;
}

/* ---- SLA ---- */
export interface SlaTarget { firstResponse: number | null; resolution: number | null }   // minutes
export type SlaMap = Record<TaskPriority, SlaTarget>;
export const DEFAULT_SLA: SlaMap = {
  urgent: { firstResponse: 60, resolution: 480 }, high: { firstResponse: 240, resolution: 1440 },
  normal: { firstResponse: 480, resolution: 4320 }, low: { firstResponse: 1440, resolution: 10080 },
};
export async function loadSla(): Promise<{ sla: SlaMap; ready: boolean }> {
  const { data, error } = await supabase.from("ticket_sla").select("priority, first_response_minutes, resolution_minutes");
  if (error) return { sla: DEFAULT_SLA, ready: false };
  const out: SlaMap = { ...DEFAULT_SLA };
  ((data ?? []) as any[]).forEach((r) => {
    if (r.priority in out) out[r.priority as TaskPriority] = { firstResponse: r.first_response_minutes ?? null, resolution: r.resolution_minutes ?? null };
  });
  return { sla: out, ready: true };
}
export async function saveSla(priority: TaskPriority, t: SlaTarget): Promise<string | null> {
  const row = { priority, first_response_minutes: t.firstResponse, resolution_minutes: t.resolution };
  const { data } = await supabase.from("ticket_sla").select("id").eq("priority", priority).maybeSingle();
  const { error } = data ? await supabase.from("ticket_sla").update(row).eq("id", (data as any).id) : await supabase.from("ticket_sla").insert(row);
  return error ? (missingTable(error.message) ? MAIL_SQL : error.message) : null;
}
/** Where a ticket stands against its SLA right now. */
export interface SlaState { kind: "response" | "resolution"; dueAt: number; left: number; window: number; breached: boolean }
export function slaOf(t: Ticket, sla: SlaMap, now = Date.now()): SlaState | null {
  if (!isActive(t.stage) || t.mergedInto) return null;
  const target = sla[t.priority];
  const start = new Date(t.createdAt).getTime();
  if (!t.firstResponseAt && target.firstResponse) {
    const dueAt = start + target.firstResponse * 60000;
    return { kind: "response", dueAt, left: dueAt - now, window: target.firstResponse * 60000, breached: dueAt < now };
  }
  if (target.resolution) {
    const dueAt = start + target.resolution * 60000;
    return { kind: "resolution", dueAt, left: dueAt - now, window: target.resolution * 60000, breached: dueAt < now };
  }
  return null;
}
export const span = (ms: number) => {
  const m = Math.max(0, Math.round(Math.abs(ms) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r && h < 10 ? `${h}h ${r}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh && d < 7 ? `${d}d ${rh}h` : `${d}d`;
};

/* ---- mailboxes ---- */
export interface Mailbox {
  id: string; address: string; label: string | null; kind: "personal" | "shared"; ownerId: string | null; active: boolean;
  canSend: boolean; isDefaultFrom: boolean; storeAll: boolean; lastSyncAt: string | null; lastError: string | null;
}
const toBox = (r: any): Mailbox => ({
  id: r.id, address: r.address, label: r.label ?? null, kind: r.kind === "personal" ? "personal" : "shared", ownerId: r.owner_id ?? null,
  active: r.active !== false, canSend: r.can_send !== false, isDefaultFrom: !!r.is_default_from, storeAll: !!r.store_all,
  lastSyncAt: r.last_sync_at ?? null, lastError: r.last_error ?? null,
});
export async function loadMailboxes(): Promise<Mailbox[] | null> {
  const { data, error } = await supabase.from("ticket_mailboxes").select("*").order("created_at");
  if (error) return missingTable(error.message) ? null : [];
  return ((data ?? []) as any[]).map(toBox);
}
export async function saveMailbox(b: Partial<Mailbox> & { address: string }): Promise<string | null> {
  const row: any = {
    address: b.address.trim().toLowerCase(), label: b.label?.trim() || null, kind: b.kind ?? "shared", owner_id: b.ownerId ?? null,
    active: b.active ?? true, can_send: b.canSend ?? true, is_default_from: !!b.isDefaultFrom, store_all: !!b.storeAll,
  };
  if (row.is_default_from) await supabase.from("ticket_mailboxes").update({ is_default_from: false }).neq("id", b.id ?? "00000000-0000-0000-0000-000000000000");
  const { error } = b.id ? await supabase.from("ticket_mailboxes").update(row).eq("id", b.id) : await supabase.from("ticket_mailboxes").insert(row);
  return error ? (missingTable(error.message) ? MAIL_SQL : /duplicate|unique/i.test(error.message) ? "That mailbox is already on the list." : error.message) : null;
}
export async function deleteMailbox(id: string): Promise<string | null> {
  const { error } = await supabase.from("ticket_mailboxes").delete().eq("id", id);
  return error?.message ?? null;
}

/* ---- mail rules ---- */
export interface RuleConditions {
  match: "all" | "any";
  from_contains?: string; from_emails?: string[]; from_contact_ids?: string[]; from_company_id?: string | null;
  mailbox?: string; subject_contains?: string; subject_regex?: string; body_contains?: string;
}
export interface RuleSet { type?: string | null; priority?: TaskPriority | null; assignee_id?: string | null; team?: string | null; tags?: string[]; client_id?: string | null; company_id?: string | null }
export interface MailRule {
  id: string; name: string; sort: number; active: boolean; conditions: RuleConditions;
  action: "create" | "append" | "ignore"; targetTicketId: string | null; set: RuleSet; hits: number; lastHitAt: string | null;
}
const toRule = (r: any): MailRule => ({
  id: r.id, name: r.name ?? "Rule", sort: r.sort ?? 0, active: r.active !== false,
  conditions: { match: "all", ...(r.conditions ?? {}) }, action: ["create", "append", "ignore"].includes(r.action) ? r.action : "create",
  targetTicketId: r.target_ticket_id ?? null, set: r.set_fields ?? {}, hits: r.hits ?? 0, lastHitAt: r.last_hit_at ?? null,
});
export async function loadMailRules(): Promise<MailRule[] | null> {
  const { data, error } = await supabase.from("ticket_mail_rules").select("*").order("sort").order("created_at");
  if (error) return missingTable(error.message) ? null : [];
  return ((data ?? []) as any[]).map(toRule);
}
export async function saveMailRule(r: Partial<MailRule> & { name: string }): Promise<string | null> {
  const row: any = {
    name: r.name.trim() || "Rule", sort: r.sort ?? 0, active: r.active ?? true, conditions: r.conditions ?? { match: "all" },
    action: r.action ?? "create", target_ticket_id: r.action === "append" ? r.targetTicketId ?? null : null, set_fields: r.set ?? {},
  };
  const { error } = r.id ? await supabase.from("ticket_mail_rules").update(row).eq("id", r.id) : await supabase.from("ticket_mail_rules").insert(row);
  return error ? (missingTable(error.message) ? MAIL_SQL : error.message) : null;
}
export async function deleteMailRule(id: string): Promise<string | null> {
  const { error } = await supabase.from("ticket_mail_rules").delete().eq("id", id);
  return error?.message ?? null;
}
/** Same test the server runs (to preview a rule against the Inbox). */
export function ruleMatchesMail(c: RuleConditions, m: MailMsg, dir: Directory | null): boolean {
  const lc = (x: unknown) => String(x ?? "").trim().toLowerCase();
  const from = lc(m.fromEmail), fromAll = `${lc(m.fromName)} ${from}`;
  const tests: boolean[] = [];
  if (c.from_contains) tests.push(fromAll.includes(lc(c.from_contains)));
  if (c.from_emails?.length) tests.push(c.from_emails.map(lc).some((e) => e && (from === e || (e.startsWith("@") && from.endsWith(e)))));
  if (c.from_contact_ids?.length) {
    const emails = (dir?.contacts ?? []).filter((x) => c.from_contact_ids!.includes(x.id)).map((x) => lc(x.email));
    tests.push(emails.includes(from));
  }
  if (c.mailbox) tests.push([...m.to, ...m.cc].some((x) => lc(x.email) === lc(c.mailbox)));
  if (c.subject_contains) tests.push(lc(m.subject).includes(lc(c.subject_contains)));
  if (c.subject_regex) { try { tests.push(new RegExp(c.subject_regex, "i").test(m.subject)); } catch { tests.push(false); } }
  if (c.body_contains) tests.push(lc(m.snippet).includes(lc(c.body_contains)) || lc(m.html).includes(lc(c.body_contains)));
  if (!tests.length) return false;
  return c.match === "any" ? tests.some(Boolean) : tests.every(Boolean);
}

/* ---- merging ---- */
/** Merges `from` into `into`: notes, e-mails and watchers move; `from` is closed and points to `into`. */
export async function mergeTicket(from: Ticket, into: Ticket, ready: boolean): Promise<string | null> {
  if (from.id === into.id) return "Pick another ticket.";
  const { error: e1 } = await supabase.from("tracking_task_updates").update({ task_id: into.id }).eq("task_id", from.id);
  if (e1) return e1.message;
  await supabase.from("ticket_mail_messages").update({ ticket_id: into.id }).eq("ticket_id", from.id);
  for (const w of from.watchers) if (!into.watchers.includes(w)) await setWatcher(into.id, w, true);
  if (from.assignee && from.assignee !== into.assignee && !into.watchers.includes(from.assignee)) await setWatcher(into.id, from.assignee, true);
  const { data: s } = await supabase.auth.getSession();
  await supabase.from("tracking_task_updates").insert({ task_id: into.id, author_id: s?.session?.user?.id ?? null, body: `Merged ${ticketRef(from)} “${plain(from.title)}” into this ticket.`, status: STAGE_STATUS[into.stage], progress: into.progress });
  const patch: any = { stage: "closed" };
  const { error: e2 } = await supabase.from("tracking_tasks").update({ ...(ready ? { stage: "closed" } : { status: "done", done: true }), merged_into: into.id, tags: [...new Set([...from.tags, "merged"])] }).eq("id", from.id);
  if (e2) {
    // before 19_ticket_mail.sql: close it and say where it went
    const e3 = await saveTicket(from.id, { ...patch, tags: [...new Set([...from.tags, `merged-into-${ticketRef(into)}`])] }, ready);
    if (e3) return e3;
  }
  tell();
  return null;
}

/* ---------------------------- small pieces ---------------------------- */
const TK_ICON: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  x: "M18 6 6 18M6 6l12 12",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  check: "M20 6 9 17l-5-5",
  tag: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  sort: "M3 6h13M3 12h9M3 18h5M17 8l4-4 4 4M21 4v16",
  chev: "M6 9l6 6 6-6",
  building: "M3 21h18M5 21V5l7-3v19M19 21V9l-7-3M9 9h.01M9 13h.01M9 17h.01",
  deal: "M3 12l4-4 4 4 6-6 4 4M21 10v6h-6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  briefcase: "M3 8h18v12H3zM8 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3",
  refresh: "M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  merge: "M7 4v5a5 5 0 0 0 5 5 5 5 0 0 0 5-5V4M12 14v7M9 18l3 3 3-3",
  clip: "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  arrow: "M5 12h14M13 6l6 6-6 6",
  up: "M12 19V5M5 12l7-7 7 7",
  down: "M12 5v14M19 12l-7 7-7-7",
  bookmark: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
  reply: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 5 5v6",
  ban: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM5 5l14 14",
  out: "M7 17 17 7M8 7h9v9",
};
export const TkIco = ({ d, className }: { d: keyof typeof TK_ICON; className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={TK_ICON[d]} /></svg>
);
const AV_TONES = ["#12b57f", "#3f7fd8", "#d98324", "#8b5cf6", "#d6457a", "#0f9fb3", "#6b8e23"];
const toneOf = (id: string) => AV_TONES[[...id].reduce((s, c) => s + c.charCodeAt(0), 0) % AV_TONES.length];
export function Avatar({ person, size = 26 }: { person: DirPerson | null | undefined; size?: number }) {
  if (!person) return <span className="tk-av is-none" style={{ width: size, height: size }} title="Unassigned"><TkIco d="user" /></span>;
  return <span className="tk-av" style={{ width: size, height: size, background: toneOf(person.id), fontSize: size * 0.4 }} title={person.name}>{initials(person.name)}</span>;
}
function StagePill({ stage, onClick }: { stage: TicketStage; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className={`tk-stage is-${stage}`} onClick={onClick} disabled={!onClick} title={TICKET_STAGES.find((s) => s.key === stage)?.hint}>
      <i />{stageLabel(stage)}
    </button>
  );
}
/** A small menu floating next to what opened it. */
function Pop({ anchor, onClose, children, width = 220 }: { anchor: DOMRect; onClose: () => void; children: React.ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const t = window.setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key);
    return () => { window.clearTimeout(t); document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
  const below = anchor.bottom + 6 + 320 < window.innerHeight;
  return createPortal(
    <div ref={ref} className="tk-pop" style={{ left, width, ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }) }}>{children}</div>,
    document.body,
  );
}
function PeopleMenu({ dir, value, onPick, allowNone = true }: { dir: Directory; value: string | null; onPick: (id: string | null) => void; allowNone?: boolean }) {
  const [q, setQ] = useState("");
  const f = fold(q);
  const list = dir.people.filter((p) => !f || fold(p.name).includes(f) || fold(p.email).includes(f));
  const mine = dir.people.find((p) => p.id === dir.me);
  return (
    <div className="tk-people">
      <input className="tk-pop-q" autoFocus placeholder="Find someone…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="tk-pop-list">
        {!q && mine && value !== mine.id && (
          <button type="button" className="tk-pop-opt is-me" onClick={() => onPick(mine.id)}><Avatar person={mine} size={22} /><span>Assign to me</span></button>
        )}
        {allowNone && !q && value && <button type="button" className="tk-pop-opt" onClick={() => onPick(null)}><Avatar person={null} size={22} /><span>Unassigned</span></button>}
        {list.slice(0, 40).map((p) => (
          <button type="button" key={p.id} className={`tk-pop-opt ${p.id === value ? "is-on" : ""}`} onClick={() => onPick(p.id)}>
            <Avatar person={p} size={22} /><span>{p.name}<em>{p.department ?? p.role ?? ""}</em></span>{p.id === value && <TkIco d="check" className="tk-pop-tick" />}
          </button>
        ))}
        {!list.length && <p className="tk-pop-empty">Nobody called that.</p>}
      </div>
    </div>
  );
}
const fold = (s: string) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/* ------------------------------ the desk ------------------------------ */
type DeskTab = "mine" | "team" | "unassigned" | "all";
type DeskView = "active" | "waiting" | "done";
type DeskSort = "due" | "priority" | "updated" | "number";
const SORTS: { key: DeskSort; label: string }[] = [
  { key: "due", label: "By due date" }, { key: "priority", label: "By priority" }, { key: "updated", label: "Recently updated" }, { key: "number", label: "Newest first" },
];
const DESK_TABS: { key: DeskTab; label: string }[] = [
  { key: "mine", label: "Mine" }, { key: "team", label: "Team" }, { key: "unassigned", label: "Unassigned" }, { key: "all", label: "All" },
];
const groupOf = (t: Ticket, today: string): Group => {
  const d = dayOf(t.due);
  if (!d) return "none";
  const diff = daysBetween(today, d);
  return diff < 0 ? "overdue" : diff === 0 ? "today" : diff <= 7 ? "week" : "later";
};
function linkLabel(t: Ticket, dir: Directory | null): { icon: keyof typeof TK_ICON; text: string } | null {
  if (!dir) return null;
  if (t.clientId) { const c = dir.clients.find((x) => x.id === t.clientId); if (c) return { icon: "briefcase", text: c.name }; }
  if (t.trackingId) { const d = dir.deals.find((x) => x.id === t.trackingId); if (d) return { icon: "deal", text: d.name }; }
  if (t.companyId) { const c = dir.companies.find((x) => x.id === t.companyId); if (c) return { icon: "building", text: c.name }; }
  if (t.projectId) { const p = dir.projects.find((x) => x.id === t.projectId); if (p) return { icon: "folder", text: p.name }; }
  if (t.requesterName || t.requesterEmail) return { icon: "mail", text: t.requesterName || t.requesterEmail || "" };
  return null;
}

/* mail sync: one at a time per page, every few minutes while the home page is open */
let lastDeskSync = 0;
let deskSyncBusy = false;
const AUTO_SYNC_MS = 5 * 60000;
interface SavedView { name: string; tab: DeskTab; view: DeskView; sort: DeskSort; q: string; prio: TaskPriority | ""; type: string }
const VIEWS_PREF = "tickets.views";
const typingIn = (el: EventTarget | null) => {
  const e = el as HTMLElement | null;
  if (!e) return false;
  if (e.tagName === "INPUT") return !["checkbox", "radio", "button", "submit", "reset"].includes((e as HTMLInputElement).type);
  return e.isContentEditable || ["TEXTAREA", "SELECT"].includes(e.tagName);
};
const cleanSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|aw|sv|rv)\s*:\s*)+/i, "").replace(/\[T-\d+\]/g, "").trim();

/**
 * The ticket desk: the to-do as a ticketing tool. In the home column it is a
 * card; `full` turns it into the full-window view (filters + table).
 */
export function TicketDesk({ full = false, onClose }: { full?: boolean; onClose?: () => void }) {
  const today = isoDay(new Date());
  const [data, setData] = useState<{ tickets: Ticket[]; ready: boolean; ownedDeals: string[] } | null>(null);
  const [dir, setDir] = useState<Directory | null>(null);
  const [types, setTypes] = useState<string[]>(DEFAULT_TYPES);
  const [tab, setTab] = useState<DeskTab>("mine");
  const [view, setView] = useState<DeskView>("active");
  const [sort, setSort] = useState<DeskSort>("due");
  const [q, setQ] = useState("");
  const [fPrio, setFPrio] = useState<TaskPriority | "">("");
  const [fType, setFType] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<Partial<Ticket> | null>(null);
  const [menu, setMenu] = useState<{ id: string; kind: "stage" | "assignee"; rect: DOMRect } | null>(null);
  const [draft, setDraft] = useState("");
  const [draftPrio, setDraftPrio] = useState<TaskPriority>("normal");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [sortMenu, setSortMenu] = useState<DOMRect | null>(null);
  // e-mail, SLA, bulk, views, shortcuts
  const [pane, setPane] = useState<"tickets" | "inbox">("tickets");
  const [inbox, setInbox] = useState<MailMsg[] | null | undefined>(undefined);
  const [boxes, setBoxes] = useState<Mailbox[]>([]);
  const [mailSt, setMailSt] = useState<OutlookMailStatus | null>(null);
  const [sla, setSla] = useState<SlaMap | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [settings, setSettings] = useState<{ start?: SettingsTab; prefill?: Partial<MailRule> | null } | null>(null);
  const [preview, setPreview] = useState<MailMsg | null>(null);
  const [addPick, setAddPick] = useState<{ m: MailMsg; rect: DOMRect } | null>(null);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [bulk, setBulk] = useState<{ kind: "stage" | "assignee" | "priority" | "merge"; rect: DOMRect } | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [now, setNow] = useState(() => Date.now());
  const qRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => { loadTickets().then(setData).catch(() => setData({ tickets: [], ready: false, ownedDeals: [] })); }, []);
  const reloadMail = useCallback(() => {
    loadInboxMail().then(setInbox).catch(() => setInbox([]));
    loadMailboxes().then((b) => setBoxes(b ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    reload();
    reloadMail();
    loadDirectory().then(setDir).catch(() => {});
    loadTicketTypes().then(setTypes).catch(() => {});
    loadSla().then((r) => setSla(r.sla)).catch(() => setSla(DEFAULT_SLA));
    getMailStatus().then(setMailSt).catch(() => {});
    if (full) loadPrefs().then((p) => { const v = p?.[VIEWS_PREF]; if (Array.isArray(v)) setViews(v); }).catch(() => {});
    const on = () => { reload(); reloadMail(); };
    const conn = () => { getMailStatus(true).then(setMailSt).catch(() => {}); };
    const openOne = (e: Event) => { const id = (e as CustomEvent).detail; if (typeof id === "string") setOpenId(id); };
    const iv = window.setInterval(() => setNow(Date.now()), 60000);
    window.addEventListener(TICKETS_EVENT, on);
    window.addEventListener(OUTLOOK_CONNECTION_EVENT, conn);
    window.addEventListener("open-ticket", openOne);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener(TICKETS_EVENT, on); window.removeEventListener(OUTLOOK_CONNECTION_EVENT, conn); window.removeEventListener("open-ticket", openOne);
    };
  }, [reload, reloadMail, full]);

  /** Reads new mail of the desk's mailboxes (rules, threads, Inbox). */
  const syncNow = useCallback(async (quiet = false) => {
    if (deskSyncBusy) return;
    deskSyncBusy = true; setSyncing(true);
    const r: MailSyncResult = await syncTicketMail().catch((e) => ({ error: String(e?.message ?? e) }));
    deskSyncBusy = false; setSyncing(false);
    lastDeskSync = Date.now();
    if (r.error) {
      if (!quiet) setSyncNote({ text: r.error === "mail_scope_missing" || /scope|permission/i.test(r.error) ? "Outlook needs mail permission — connect again with mail." : r.error === "not_connected" ? "Connect Outlook to read mail." : r.error, bad: true });
    } else {
      const bits: string[] = [];
      if (r.stored) bits.push(`${r.stored} new e-mail${r.stored === 1 ? "" : "s"}`);
      if (r.created) bits.push(`${r.created} ticket${r.created === 1 ? "" : "s"} opened`);
      if (r.threaded) bits.push(`${r.threaded} added to tickets`);
      if (r.inbox) bits.push(`${r.inbox} in the Inbox`);
      const errs = r.errors ?? [];
      setSyncNote(errs.length ? { text: errs[0], bad: true } : { text: bits.length ? bits.join(" · ") : r.note || r.skipped || "Up to date" });
    }
    reload(); reloadMail();
  }, [reload, reloadMail]);
  const mailOn = !!mailSt?.connected && !!mailSt?.mail;
  const hasBoxes = boxes.some((b) => b.active);
  useEffect(() => {
    if (full || !mailOn || !hasBoxes) return;
    const tick = () => { if (!document.hidden && Date.now() - lastDeskSync > AUTO_SYNC_MS - 15000) syncNow(true); };
    tick();
    const iv = window.setInterval(tick, AUTO_SYNC_MS);
    return () => window.clearInterval(iv);
  }, [full, mailOn, hasBoxes, syncNow]);

  const me = dir?.me ?? null;
  const ready = data?.ready ?? false;
  const all = data?.tickets ?? [];
  const deptOf = useMemo(() => new Map((dir?.people ?? []).map((p) => [p.id, p.department])), [dir]);
  const inTab = useCallback((t: Ticket, k: DeskTab) => {
    if (k === "all") return true;
    if (k === "unassigned") return !t.assignee && !t.watchers.length;
    if (k === "mine") return !!me && (t.assignee === me || t.watchers.includes(me)
      || (!t.assignee && !t.watchers.length && (t.createdBy === me || (!!t.trackingId && (data?.ownedDeals ?? []).includes(t.trackingId)))));
    const dept = dir?.myDept;
    if (!dept) return true;
    return [t.assignee, t.createdBy, ...t.watchers].some((id) => id && deptOf.get(id) === dept);
  }, [me, data, dir, deptOf]);
  const inView = (t: Ticket) => view === "done" ? !isActive(t.stage) : view === "waiting" ? t.stage === "waiting" : isActive(t.stage);
  const f = fold(q.trim());
  const matches = (t: Ticket) => !f || fold(`${t.title} ${ticketRef(t)} ${t.type ?? ""} ${t.tags.join(" ")} ${t.requesterName ?? ""} ${linkLabel(t, dir)?.text ?? ""}`).includes(f);
  const shown = all.filter((t) => !t.mergedInto && inTab(t, tab) && inView(t) && matches(t) && (!fPrio || t.priority === fPrio) && (!fType || t.type === fType));
  const rank: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const sorted = [...shown].sort((a, b) => {
    if (sort === "priority") return rank[a.priority] - rank[b.priority] || (a.due ?? "9").localeCompare(b.due ?? "9");
    if (sort === "updated") return (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
    if (sort === "number") return (b.no ?? 0) - (a.no ?? 0);
    return (a.due ?? "9999").localeCompare(b.due ?? "9999") || rank[a.priority] - rank[b.priority];
  });
  const counts = Object.fromEntries(DESK_TABS.map((x) => [x.key, all.filter((t) => !t.mergedInto && isActive(t.stage) && inTab(t, x.key)).length])) as Record<DeskTab, number>;
  const breached = sla ? all.filter((t) => inTab(t, tab) && slaOf(t, sla, now)?.breached).length : 0;
  const inboxShown = (inbox ?? []).filter((m) => !f || fold(`${m.subject} ${m.fromName ?? ""} ${m.fromEmail ?? ""} ${m.snippet}`).includes(f));
  const lastSync = Math.max(lastDeskSync, ...boxes.map((b) => (b.lastSyncAt ? new Date(b.lastSyncAt).getTime() : 0)));
  const lateCount = all.filter((t) => isActive(t.stage) && inTab(t, tab) && groupOf(t, today) === "overdue").length;
  const person = (id: string | null) => (id ? dir?.people.find((p) => p.id === id) ?? null : null);

  const patch = async (t: Ticket, p: Partial<Ticket>) => {
    setData((d) => d && { ...d, tickets: d.tickets.map((x) => (x.id === t.id ? { ...x, ...p } : x)) });
    const e = await saveTicket(t.id, p, ready);
    if (e) { setErr(e); reload(); } else setErr(null);
  };
  const quickAdd = async () => {
    const title = draft.trim();
    if (!title || adding) return;
    setAdding(true);
    const res = await createTicket({ title, priority: draftPrio, assignee: me, ...(tab === "unassigned" ? { assignee: null } : {}) }, ready);
    setAdding(false);
    if (res.error) { setErr(res.error); return; }
    setErr(null); setDraft(""); setDraftPrio("normal");
  };
  const cyclePrio = () => setDraftPrio((p) => TASK_PRIORITIES[(TASK_PRIORITIES.indexOf(p) + 1) % TASK_PRIORITIES.length]);
  const openT = all.find((t) => t.id === openId) ?? null;

  /* ---- Inbox actions ---- */
  const dropMail = (id: string) => { setInbox((xs) => (xs ? xs.filter((x) => x.id !== id) : xs)); setPreview((p) => (p?.id === id ? null : p)); };
  const mailToTicket = async (m: MailMsg) => {
    if (!dir) return;
    dropMail(m.id);
    const res = await createTicketFromMail(m, dir, ready);
    if (res.error || !res.id) { setErr(res.error); reloadMail(); return; }
    setErr(null); setOpenId(res.id);
  };
  const mailIntoTicket = async (m: MailMsg, t: Ticket) => {
    dropMail(m.id);
    const e = await setMailTicket(m, t.id);
    if (e) { setErr(e); reloadMail(); return; }
    setErr(null);
    if (!t.requesterEmail && m.fromEmail) await saveTicket(t.id, { requesterEmail: m.fromEmail, requesterName: m.fromName }, ready);
  };
  const mailIgnore = async (m: MailMsg) => { dropMail(m.id); const e = await ignoreMail(m.id); if (e) { setErr(e); reloadMail(); } };
  const ruleFrom = (m: MailMsg) => {
    const subj = cleanSubject(m.subject);
    const contact = m.fromEmail ? dir?.contacts.find((c) => (c.email ?? "").toLowerCase() === m.fromEmail!.toLowerCase()) : undefined;
    const who = m.fromName || m.fromEmail || "Sender";
    setPreview(null);
    setSettings({ start: "rules", prefill: {
      name: `${who}${subj ? ` · ${subj.slice(0, 40)}` : ""}`,
      conditions: { match: "all", ...(contact ? { from_contact_ids: [contact.id] } : { from_emails: m.fromEmail ? [m.fromEmail] : [] }), ...(subj ? { subject_contains: subj.slice(0, 60) } : {}) },
      action: "create", set: { assignee_id: me },
    } });
  };

  /* ---- bulk (full view) ---- */
  const selected = sorted.filter((t) => sel.has(t.id));
  const toggleSel = (id: string) => setSel((s0) => { const s1 = new Set(s0); if (s1.has(id)) s1.delete(id); else s1.add(id); return s1; });
  const bulkPatch = async (p: Partial<Ticket>) => {
    const ids = new Set(selected.map((t) => t.id));
    setBulk(null);
    setData((d) => d && { ...d, tickets: d.tickets.map((x) => (ids.has(x.id) ? { ...x, ...p } : x)) });
    const errs = (await Promise.all(selected.map((t) => saveTicket(t.id, p, ready)))).filter(Boolean);
    if (errs.length) { setErr(errs[0]); reload(); } else { setErr(null); setSel(new Set()); }
  };
  const bulkMerge = async (into: Ticket) => {
    setBulk(null);
    for (const t of selected) if (t.id !== into.id) { const e = await mergeTicket(t, into, ready); if (e) { setErr(e); break; } }
    setSel(new Set()); reload();
  };

  /* ---- saved views ---- */
  const applyView = (v: SavedView) => { setTab(v.tab); setView(v.view); setSort(v.sort); setQ(v.q); setFPrio(v.prio); setFType(v.type); setPane("tickets"); };
  const storeViews = (vs: SavedView[]) => { setViews(vs); savePref(VIEWS_PREF, vs).catch(() => {}); };
  const saveView = () => {
    const name = (viewName ?? "").trim();
    setViewName(null);
    if (!name) return;
    storeViews([...views.filter((v) => v.name !== name), { name, tab, view, sort, q, prio: fPrio, type: fType }]);
  };
  const isView = (v: SavedView) => v.tab === tab && v.view === view && v.sort === sort && v.q === q && v.prio === fPrio && v.type === fType;

  /* ---- keyboard ---- */
  const keyState = useRef({ sorted, cursor, pane, full });
  keyState.current = { sorted, cursor, pane, full };
  const blocked = !!(openT || creating || settings || preview || help || addPick || bulk || menu || sortMenu || (!full && expanded));
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (blocked || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      if (!full && document.querySelector(".tk-full, .td-back")) return;
      const st = keyState.current;
      const cur = st.sorted[st.cursor];
      const go = (d: number) => { const n = st.sorted.length; if (!n) return; const i = Math.max(0, Math.min(n - 1, (st.cursor < 0 ? (d > 0 ? -1 : n) : st.cursor) + d)); setCursor(i); window.setTimeout(() => document.querySelector(`[data-tk="${st.sorted[i].id}"]`)?.scrollIntoView({ block: "nearest" }), 0); };
      switch (e.key) {
        case "n": e.preventDefault(); setCreating({ assignee: me }); break;
        case "/": e.preventDefault(); setPane("tickets"); window.setTimeout(() => qRef.current?.focus(), 0); break;
        case "j": case "ArrowDown": if (e.key === "ArrowDown" && !full) return; e.preventDefault(); go(1); break;
        case "k": case "ArrowUp": if (e.key === "ArrowUp" && !full) return; e.preventDefault(); go(-1); break;
        case "Enter": case "o": if (cur && st.pane === "tickets") { e.preventDefault(); setOpenId(cur.id); } break;
        case "e": if (cur && isActive(cur.stage)) patch(cur, { stage: "resolved" }); break;
        case "a": if (cur && me && cur.assignee !== me) patch(cur, { assignee: me }); break;
        case "x": if (cur && st.full) toggleSel(cur.id); break;
        case "i": setPane((p) => (p === "inbox" ? "tickets" : "inbox")); break;
        case "s": syncNow(); break;
        case "?": setHelp(true); break;
        default: return;
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  });
  useEffect(() => { setCursor(-1); }, [tab, view, q, fPrio, fType, sort, pane]);

  const row = (t: Ticket, i: number) => {
    const link = linkLabel(t, dir);
    const late = isActive(t.stage) && groupOf(t, today) === "overdue";
    return (
      <div key={t.id} data-tk={t.id} className={`tk-row is-p-${t.priority} ${late ? "is-late" : ""} ${isActive(t.stage) ? "" : "is-done"} ${sorted[cursor]?.id === t.id ? "is-cur" : ""}`} style={{ ["--i" as string]: Math.min(i, 12) } as React.CSSProperties}
        onClick={() => setOpenId(t.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(t.id); }}>
        <span className="tk-row-bar" aria-hidden="true" />
        <div className="tk-row-main">
          <div className="tk-row-top">
            <span className="tk-ref">{ticketRef(t)}</span>
            {t.type && <span className="tk-type">{t.type}</span>}
            {t.priority === "urgent" || t.priority === "high" ? <span className={`tk-prio is-${t.priority}`}><FlagIcon />{PRIORITY_LABEL[t.priority]}</span> : null}
            {t.source === "email" && <span className="tk-src" title="Came in by e-mail"><TkIco d="mail" /></span>}
          </div>
          <span className="tk-row-title"><Rich text={t.title} /></span>
          <div className="tk-row-meta">
            {link && <span className={`tk-link ${t.clientId && link.icon === "briefcase" ? "has-logo" : ""}`}>{t.clientId && link.icon === "briefcase" ? <ClientLogo name={link.text} clientId={t.clientId} className="tk-link-logo" /> : <TkIco d={link.icon} />}{link.text}</span>}
            <DueChip dueAt={t.due} todayIso={today} done={!isActive(t.stage)} />
            <SlaBadge t={t} sla={sla} now={now} compact />
            {(t.checklist.length > 0 || (t.kind === "process" && t.progress > 0)) && <span className="tk-pct"><i style={{ ["--w" as string]: `${t.checklist.length ? Math.round((t.checklist.filter((x) => x.done).length / t.checklist.length) * 100) : t.progress}%` } as React.CSSProperties} />{t.checklist.length ? `${t.checklist.filter((x) => x.done).length}/${t.checklist.length}` : `${t.progress}%`}</span>}
          </div>
        </div>
        <div className="tk-row-side" onClick={(e) => e.stopPropagation()}>
          {/* quick actions: shown when the row is hovered or focused */}
          <span className="tk-row-acts">
            {isActive(t.stage) && <button type="button" className="tk-act" title="Resolve (E)" aria-label="Resolve" onClick={() => patch(t, { stage: "resolved" })}><TkIco d="check" /></button>}
            {me && t.assignee !== me && isActive(t.stage) && <button type="button" className="tk-act" title="Take it (A)" aria-label="Assign to me" onClick={() => patch(t, { assignee: me })}><TkIco d="user" /></button>}
            <button type="button" className="tk-act" title="Open" aria-label="Open" onClick={() => setOpenId(t.id)}><TkIco d="arrow" /></button>
          </span>
          <StagePill stage={t.stage} onClick={(e) => setMenu({ id: t.id, kind: "stage", rect: e.currentTarget.getBoundingClientRect() })} />
          <button type="button" className="tk-av-btn" onClick={(e) => setMenu({ id: t.id, kind: "assignee", rect: e.currentTarget.getBoundingClientRect() })} title={person(t.assignee)?.name ?? "Unassigned — click to assign"}>
            <Avatar person={person(t.assignee)} size={26} />
            {t.watchers.filter((w) => w !== t.assignee).length > 0 && <em className="tk-av-more">+{t.watchers.filter((w) => w !== t.assignee).length}</em>}
          </button>
        </div>
      </div>
    );
  };

  const groups: { key: string; label: string; items: Ticket[] }[] = sort === "due" && view !== "done"
    ? GROUPS.map((g) => ({ ...g, items: sorted.filter((t) => groupOf(t, today) === g.key) })).filter((g) => g.items.length)
    : [{ key: "all" as const, label: "", items: sorted }];

  const filters = (
    <div className="tk-filters">
      <div className="tk-q">
        <TkIco d="search" />
        <input ref={qRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={pane === "inbox" ? "Filter e-mail…" : "Filter tickets…"}
          onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); } }} />
        {q && <button type="button" onClick={() => setQ("")} aria-label="Clear"><TkIco d="x" /></button>}
      </div>
      {pane === "tickets" && <>
      <div className="tk-seg" role="tablist">
        {(["active", "waiting", "done"] as DeskView[]).map((v) => (
          <button key={v} type="button" className={view === v ? "is-on" : ""} onClick={() => setView(v)}>{v === "active" ? "Open" : v === "waiting" ? "Waiting" : "Done"}</button>
        ))}
      </div>
      {full ? (
        <Select size="sm" value={sort} onChange={(v) => setSort(v as DeskSort)} aria-label="Sort"
          options={SORTS.map((x) => ({ value: x.key, label: x.label }))} />
      ) : (
        <button type="button" className={`tk-icon-btn ${sort !== "due" ? "is-on" : ""}`} title={`Sort: ${SORTS.find((x) => x.key === sort)?.label}`} aria-label="Sort"
          onClick={(e) => setSortMenu(e.currentTarget.getBoundingClientRect())}><TkIco d="sort" /></button>
      )}
      {full && <>
        <Select size="sm" value={fPrio} onChange={(v) => setFPrio(v as TaskPriority | "")} aria-label="Priority"
          options={[{ value: "", label: "Any priority" }, ...TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))]} />
        <Select size="sm" value={fType} onChange={setFType} aria-label="Type" options={[{ value: "", label: "Any type" }, ...types.map((t) => ({ value: t, label: t }))]} />
      </>}
      </>}
    </div>
  );

  const list = !data ? <div className="hs-skel tk-skel" /> : !sorted.length ? (
    <div className="tk-empty">
      <span className="tk-empty-ico"><TkIco d={view === "done" ? "check" : "inbox"} /></span>
      <b>{q || fPrio || fType ? "No ticket matches" : view === "done" ? "Nothing resolved lately" : tab === "mine" ? "Your desk is clear" : "No open tickets here"}</b>
      <span>{view === "active" && !q ? "Type above to log a ticket — it lands on your desk." : "Try another tab or filter."}</span>
    </div>
  ) : full ? (
    <div className="tk-table">
      <div className="tk-th">
        <span className="tk-cb"><input type="checkbox" aria-label="Select all" checked={!!sorted.length && selected.length === sorted.length}
          ref={(el) => { if (el) el.indeterminate = selected.length > 0 && selected.length < sorted.length; }}
          onChange={() => setSel(selected.length === sorted.length ? new Set() : new Set(sorted.map((t) => t.id)))} /></span>
        <span>Ticket</span><span>Linked to</span><span>Type</span><span>Priority</span><span>Due</span><span>SLA</span><span>Owner</span><span>Stage</span>
      </div>
      {sorted.map((t, i) => {
        const link = linkLabel(t, dir);
        const pct = t.checklist.length ? Math.round((t.checklist.filter((x) => x.done).length / t.checklist.length) * 100) : null;
        return (
          <div key={t.id} data-tk={t.id} className={`tk-tr is-p-${t.priority} ${openId === t.id || sel.has(t.id) ? "is-sel" : ""} ${sorted[cursor]?.id === t.id ? "is-cur" : ""}`} style={{ ["--i" as string]: Math.min(i, 14) } as React.CSSProperties} onClick={() => setOpenId(t.id)}>
            <span className="tk-cb" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(t.id)} onChange={() => toggleSel(t.id)} aria-label={`Select ${ticketRef(t)}`} /></span>
            <span className="tk-td-title"><em className="tk-ref">{ticketRef(t)}</em><b><Rich text={t.title} /></b>{t.source === "email" && <span className="tk-src" title="Came in by e-mail"><TkIco d="mail" /></span>}{pct !== null && <span className="tk-pct is-sm"><i style={{ ["--w" as string]: `${pct}%` } as React.CSSProperties} />{pct}%</span>}</span>
            <span className="tk-td-muted">{link ? <span className="tk-link"><TkIco d={link.icon} />{link.text}</span> : "—"}</span>
            <span className="tk-td-muted">{t.type ?? "—"}</span>
            <span><span className={`tk-prio is-${t.priority}`}><FlagIcon />{PRIORITY_LABEL[t.priority]}</span></span>
            <span>{t.due ? <DueChip dueAt={t.due} todayIso={today} done={!isActive(t.stage)} /> : <i className="tk-td-muted">—</i>}</span>
            <span>{slaOf(t, sla ?? DEFAULT_SLA, now) ? <SlaBadge t={t} sla={sla} now={now} compact /> : <i className="tk-td-muted">{t.firstResponseAt && !isActive(t.stage) ? "Done" : "—"}</i>}</span>
            <span onClick={(e) => e.stopPropagation()}>
              <button type="button" className="tk-owner" onClick={(e) => setMenu({ id: t.id, kind: "assignee", rect: e.currentTarget.getBoundingClientRect() })}>
                <Avatar person={person(t.assignee)} size={22} /><span>{person(t.assignee)?.name ?? "Unassigned"}</span>
              </button>
            </span>
            <span onClick={(e) => e.stopPropagation()}><StagePill stage={t.stage} onClick={(e) => setMenu({ id: t.id, kind: "stage", rect: e.currentTarget.getBoundingClientRect() })} /></span>
          </div>
        );
      })}
    </div>
  ) : (
    <div className="tk-groups">
      {groups.map((g) => (
        <div key={g.key} className={`tk-group is-${g.key}`}>
          {g.label && <span className="tk-group-h">{g.label}<i>{g.items.length}</i></span>}
          {g.items.map(row)}
        </div>
      ))}
    </div>
  );

  const syncBar = (
    <div className="tm-sync">
      <span className={`tm-sync-dot ${mailOn && hasBoxes ? "is-on" : ""} ${syncing ? "is-busy" : ""}`} />
      <span className="tm-sync-txt">
        {syncing ? "Reading mail…" : syncNote ? <span className={syncNote.bad ? "is-bad" : ""}>{syncNote.text}</span>
          : lastSync > 0 ? <>Read {ago(new Date(lastSync).toISOString())}{mailOn && hasBoxes && !full ? " · every 5 min" : ""}</> : hasBoxes ? "Not read yet" : "No mailbox yet"}
      </span>
      <button type="button" className="tm-sync-btn" onClick={() => syncNow()} disabled={syncing || !mailOn} title={mailOn ? "Read new mail now (S)" : "Connect Outlook with mail first"}>
        <TkIco d="refresh" className={syncing ? "is-spin" : ""} />Sync now
      </button>
    </div>
  );
  const mailBanner = inbox === null ? <p className="tk-note">{MAIL_SQL}</p>
    : mailSt && !mailOn ? (
      <div className="tm-banner">
        <span className="tm-banner-ico"><TkIco d="mail" /></span>
        <div><b>{mailSt.connected ? "Give the desk access to your mail" : "Bring e-mail into the desk"}</b>
          <span>{mailSt.connected ? "Your Outlook is connected for the calendar only. Connect again to read and send mail." : "Connect Outlook to read mailboxes, file mail into tickets and reply by e-mail."}</span></div>
        <button type="button" className="td-primary is-sm" onClick={() => connectOutlook({ withMail: true })}>Connect mail</button>
      </div>
    ) : mailSt && !hasBoxes ? (
      <div className="tm-banner is-soft">
        <span className="tm-banner-ico"><TkIco d="inbox" /></span>
        <div><b>No mailbox is being read yet</b><span>Add your support / department mailbox, or switch on your own inbox.</span></div>
        <button type="button" className="td-ghost is-sm" onClick={() => setSettings({ start: "mailboxes" })}><TkIco d="gear" />Mailboxes</button>
      </div>
    ) : null;
  const inboxPane = (
    <div className="tm-pane">
      {mailBanner}
      {inbox !== null && syncBar}
      {inbox === undefined ? <div className="hs-skel tk-skel" /> : inbox === null ? null : !inboxShown.length ? (
        <div className="tk-empty">
          <span className="tk-empty-ico"><TkIco d="inbox" /></span>
          <b>{q ? "No e-mail matches" : "Inbox zero"}</b>
          <span>{q ? "Try another word." : "E-mail that no rule or ticket picks up lands here, to sort by hand."}</span>
        </div>
      ) : (
        <div className="tm-list">
          {inboxShown.map((m, i) => (
            <MailRow key={m.id} m={m} boxes={boxes} i={i} onOpen={() => setPreview(m)} onCreate={() => mailToTicket(m)}
              onAdd={(rect) => setAddPick({ m, rect })} onRule={() => ruleFrom(m)} onIgnore={() => mailIgnore(m)} />
          ))}
        </div>
      )}
    </div>
  );
  const bulkBar = full && selected.length > 0 && pane === "tickets" ? (
    <div className="tk-bulk">
      <b>{selected.length} selected</b>
      <button type="button" onClick={(e) => setBulk({ kind: "stage", rect: e.currentTarget.getBoundingClientRect() })}><span className="tk-dot is-open" />Stage</button>
      <button type="button" onClick={(e) => setBulk({ kind: "assignee", rect: e.currentTarget.getBoundingClientRect() })}><TkIco d="user" />Owner</button>
      <button type="button" onClick={(e) => setBulk({ kind: "priority", rect: e.currentTarget.getBoundingClientRect() })}><FlagIcon />Priority</button>
      {selected.length > 1 && <button type="button" onClick={(e) => setBulk({ kind: "merge", rect: e.currentTarget.getBoundingClientRect() })}><TkIco d="merge" />Merge</button>}
      <button type="button" onClick={() => bulkPatch({ stage: "resolved" })}><TkIco d="check" />Resolve</button>
      <span className="td-spacer" />
      <button type="button" className="is-clear" onClick={() => setSel(new Set())}><TkIco d="x" />Clear</button>
    </div>
  ) : null;

  const menuT = menu ? all.find((t) => t.id === menu.id) : null;
  const overlays = (
    <>
      {bulk && dir && (
        <Pop anchor={bulk.rect} onClose={() => setBulk(null)} width={bulk.kind === "merge" ? 340 : bulk.kind === "assignee" ? 250 : 200}>
          {bulk.kind === "stage" ? (
            <div className="tk-pop-list">{TICKET_STAGES.map((s) => <button key={s.key} type="button" className="tk-pop-opt" onClick={() => bulkPatch({ stage: s.key })}><span className={`tk-dot is-${s.key}`} /><span>{s.label}</span></button>)}</div>
          ) : bulk.kind === "priority" ? (
            <div className="tk-pop-list">{TASK_PRIORITIES.map((p) => <button key={p} type="button" className="tk-pop-opt" onClick={() => bulkPatch({ priority: p })}><span className={`tk-prio is-${p}`}><FlagIcon /></span><span>{PRIORITY_LABEL[p]}</span></button>)}</div>
          ) : bulk.kind === "assignee" ? (
            <PeopleMenu dir={dir} value={null} onPick={(id) => bulkPatch({ assignee: id })} />
          ) : (
            <TicketPick tickets={selected} onPick={bulkMerge} placeholder="Keep which one? The others merge into it." />
          )}
        </Pop>
      )}
      {addPick && (
        <Pop anchor={addPick.rect} onClose={() => setAddPick(null)} width={340}>
          <TicketPick tickets={all} onPick={(t) => { const m = addPick.m; setAddPick(null); mailIntoTicket(m, t); }} placeholder="Add this e-mail to which ticket?" />
        </Pop>
      )}
      {preview && (
        <MailPreview m={preview} boxes={boxes} onClose={() => setPreview(null)} onCreate={() => mailToTicket(preview)}
          onAdd={(rect) => setAddPick({ m: preview, rect })} onRule={() => ruleFrom(preview)} onIgnore={() => mailIgnore(preview)} />
      )}
      {settings && dir && (
        <DeskSettings dir={dir} types={types} tickets={all} inbox={inbox ?? []} start={settings.start} prefill={settings.prefill} mail={mailSt}
          onClose={() => { setSettings(null); reloadMail(); loadSla().then((r) => setSla(r.sla)).catch(() => {}); }}
          onConnect={() => connectOutlook({ withMail: true })} />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {sortMenu && (
        <Pop anchor={sortMenu} onClose={() => setSortMenu(null)} width={190}>
          <div className="tk-pop-list">
            {SORTS.map((x) => (
              <button key={x.key} type="button" className={`tk-pop-opt ${sort === x.key ? "is-on" : ""}`} onClick={() => { setSort(x.key); setSortMenu(null); }}>
                <span>{x.label}</span>{sort === x.key && <TkIco d="check" className="tk-pop-tick" />}
              </button>
            ))}
          </div>
        </Pop>
      )}
      {menu && menuT && dir && (
        <Pop anchor={menu.rect} onClose={() => setMenu(null)} width={menu.kind === "stage" ? 200 : 250}>
          {menu.kind === "stage" ? (
            <div className="tk-pop-list">
              {TICKET_STAGES.map((s) => (
                <button key={s.key} type="button" className={`tk-pop-opt ${menuT.stage === s.key ? "is-on" : ""}`} onClick={() => { setMenu(null); patch(menuT, { stage: s.key }); }}>
                  <span className={`tk-dot is-${s.key}`} /><span>{s.label}<em>{s.hint}</em></span>
                </button>
              ))}
            </div>
          ) : (
            <PeopleMenu dir={dir} value={menuT.assignee} onPick={(id) => { setMenu(null); patch(menuT, { assignee: id }); }} />
          )}
        </Pop>
      )}
      {(openT || creating) && dir && (
        <TicketDrawer ticket={openT} draft={creating} dir={dir} types={types} ready={ready} tickets={all}
          onTypes={setTypes}
          onClose={() => { setOpenId(null); setCreating(null); }}
          onCreated={(id) => { setCreating(null); setOpenId(id); }}
          onLocal={(t) => setData((d) => d && { ...d, tickets: d.tickets.map((x) => (x.id === t.id ? t : x)) })} />
      )}
      {expanded && createPortal(<div className="tk-full-back"><TicketDesk full onClose={() => setExpanded(false)} /></div>, document.body)}
    </>
  );

  if (full) {
    return (
      <div className="tk-full" role="dialog" aria-label="Tickets">
        <header className="tk-full-head">
          <div>
            <span className="hs-eyebrow">Ticket desk</span>
            <h2 className="tk-full-title">{counts[tab]} open {tab === "mine" ? "on your desk" : tab === "team" ? "in your team" : tab === "unassigned" ? "without an owner" : "in the company"}</h2>
          </div>
          {breached > 0 && <span className="tk-breach-pill"><TkIco d="bolt" />{breached} past SLA</span>}
          <button type="button" className="tk-icon-btn" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><TkIco d="keyboard" /></button>
          <button type="button" className="tk-icon-btn" onClick={() => setSettings({})} title="Mail rules, mailboxes and SLAs" aria-label="Desk settings"><TkIco d="gear" /></button>
          <button type="button" className="tk-new" onClick={() => setCreating({ assignee: me })}><TkIco d="plus" />New ticket</button>
          <button type="button" className="tk-icon-btn" onClick={onClose} aria-label="Close"><TkIco d="x" /></button>
        </header>
        <div className="tk-full-body">
          <nav className="tk-full-nav">
            <span className="tk-nav-k">Views</span>
            {DESK_TABS.map((x) => (
              <button key={x.key} type="button" className={pane === "tickets" && tab === x.key ? "is-on" : ""} onClick={() => { setTab(x.key); setPane("tickets"); }}>{x.label}<i>{counts[x.key]}</i></button>
            ))}
            <button type="button" className={`tk-nav-inbox ${pane === "inbox" ? "is-on" : ""}`} onClick={() => setPane("inbox")}><TkIco d="inbox" />Inbox<i className={inbox?.length ? "is-new" : ""}>{inbox?.length ?? 0}</i></button>
            <span className="tk-nav-k">Saved views</span>
            {views.map((v) => (
              <div key={v.name} className={`tk-nav-view ${pane === "tickets" && isView(v) ? "is-on" : ""}`}>
                <button type="button" onClick={() => applyView(v)}><TkIco d="bookmark" />{v.name}</button>
                <button type="button" className="tk-nav-view-x" onClick={() => storeViews(views.filter((x) => x.name !== v.name))} aria-label={`Delete view ${v.name}`}><TkIco d="x" /></button>
              </div>
            ))}
            {viewName !== null ? (
              <input className="tk-nav-in" autoFocus value={viewName} placeholder="Name this view…" onChange={(e) => setViewName(e.target.value)} onBlur={saveView}
                onKeyDown={(e) => { if (e.key === "Enter") saveView(); if (e.key === "Escape") setViewName(null); }} />
            ) : (
              <button type="button" className="tk-nav-add" onClick={() => setViewName("")}><TkIco d="plus" />Save current view</button>
            )}
            <span className="tk-nav-k">By stage</span>
            {TICKET_STAGES.map((s) => {
              const n = all.filter((t) => inTab(t, tab) && t.stage === s.key).length;
              return <span key={s.key} className="tk-nav-stat"><span className={`tk-dot is-${s.key}`} />{s.label}<i>{n}</i></span>;
            })}
          </nav>
          <div className="tk-full-main">
            {filters}
            {bulkBar}
            {err && <p className="tk-err">{err}</p>}
            {!ready && data && <p className="tk-note">{NEEDS_SQL} Until then your tasks show here with their status.</p>}
            {pane === "inbox" ? inboxPane : list}
          </div>
        </div>
        {overlays}
      </div>
    );
  }

  return (
    <section className="hs-card tk-desk" aria-label="Tickets">
      <header className="hs-head tk-head">
        <div className="hs-titles">
          <span className="hs-eyebrow">To-do &amp; tickets</span>
          <h2 className="hs-title"><span className="hs-count">{counts[tab]}</span> open{lateCount > 0 && <span className="hs-late-pill">{lateCount} late</span>}{breached > 0 && <span className="tk-breach-pill is-sm" title="Past their SLA"><TkIco d="bolt" />{breached}</span>}</h2>
        </div>
        <div className="tk-head-btns">
          <button type="button" className="tk-new is-sm" onClick={() => setCreating({ assignee: me })} title="New ticket with all the details (N)"><TkIco d="plus" />New</button>
          <button type="button" className="tk-icon-btn" onClick={() => setSettings({})} title="Mail rules, mailboxes and SLAs" aria-label="Desk settings"><TkIco d="gear" /></button>
          <button type="button" className="tk-icon-btn" onClick={() => setExpanded(true)} title="Open the full ticket desk" aria-label="Full view"><TkIco d="expand" /></button>
        </div>
      </header>
      <div className="tk-tabs" role="tablist">
        {DESK_TABS.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={pane === "tickets" && tab === x.key} className={pane === "tickets" && tab === x.key ? "is-on" : ""} onClick={() => { setTab(x.key); setPane("tickets"); }}>
            {x.label}{counts[x.key] > 0 && <i>{counts[x.key]}</i>}
          </button>
        ))}
        <button type="button" role="tab" aria-selected={pane === "inbox"} className={`tk-tab-inbox ${pane === "inbox" ? "is-on" : ""}`} onClick={() => setPane("inbox")} title="E-mail waiting to be sorted (I)">
          <TkIco d="inbox" />Inbox{(inbox?.length ?? 0) > 0 && <i className="is-new">{inbox!.length}</i>}
        </button>
      </div>
      {pane === "inbox" ? (
        <>
          <div className="tk-filters">
            <div className="tk-q">
              <TkIco d="search" />
              <input ref={qRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter e-mail…" />
              {q && <button type="button" onClick={() => setQ("")} aria-label="Clear"><TkIco d="x" /></button>}
            </div>
          </div>
          {err && <p className="tk-err">{err}</p>}
          {inboxPane}
          {overlays}
        </>
      ) : <>
      <div className="tk-quick">
        <button type="button" className={`tk-quick-prio is-${draftPrio}`} onClick={cyclePrio} title={`Priority: ${PRIORITY_LABEL[draftPrio]} (click to change)`}><FlagIcon /></button>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tab === "unassigned" ? "Log a ticket for the team…" : "Log a ticket or to-do…"}
          onKeyDown={(e) => { if (e.key === "Enter") quickAdd(); }} disabled={adding} />
        <button type="button" className="tk-quick-go" onClick={quickAdd} disabled={!draft.trim() || adding} aria-label="Add"><TkIco d="plus" /></button>
      </div>
      {filters}
      {err && <p className="tk-err">{err}</p>}
      {list}
      {overlays}
      </>}
    </section>
  );
}

/* ------------------------------ the drawer ------------------------------ */
const ago2 = (iso: string) => ago(iso);
function eventText(e: TicketEvent, dir: Directory): string {
  const d = e.detail ?? {};
  const who = (id: any) => (id ? dir.people.find((p) => p.id === id)?.name ?? "someone" : "nobody");
  switch (e.action) {
    case "created": return d.source === "email" ? "opened it from an e-mail" : "opened the ticket";
    case "stage": return `moved it to ${stageLabel(d.to)}`;
    case "priority": return `set priority to ${PRIORITY_LABEL[d.to as TaskPriority] ?? d.to}`;
    case "assignee": return d.to ? `gave it to ${who(d.to)}` : "left it unassigned";
    case "due": return d.to ? `set the due date to ${new Date(d.to).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "removed the due date";
    case "type": return `changed the type to ${d.to ?? "none"}`;
    case "title": return "renamed it";
    default: return e.action;
  }
}

export function TicketDrawer({ ticket, draft, dir, types, ready, tickets, onClose, onCreated, onLocal, onTypes }: {
  ticket: Ticket | null;
  /** The desk's tickets (to merge into); loaded on demand when missing. */
  tickets?: Ticket[];
  /** Creating: the fields to start from. */
  draft?: Partial<Ticket> | null;
  dir: Directory; types: string[]; ready: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
  onLocal?: (t: Ticket) => void;
  onTypes?: (t: string[]) => void;
}) {
  const nav = useNavigate();
  const today = isoDay(new Date());
  const creatingMode = !ticket;
  const blank: Ticket = {
    id: "", no: null, title: "", description: "", stage: "new", priority: "normal", type: null, assignee: dir.me, createdBy: dir.me, watchers: [], team: dir.myDept,
    requesterName: null, requesterEmail: null, requesterContactId: null, clientId: null, companyId: null, projectId: null, trackingId: null,
    tags: [], source: "manual", due: null, createdAt: new Date().toISOString(), updatedAt: null, resolvedAt: null, kind: "quick", progress: 0, checklist: [],
    firstResponseAt: null, mergedInto: null,
    ...(draft ?? {}),
  };
  const [t, setT] = useState<Ticket>(ticket ?? blank);
  useEffect(() => { if (ticket) setT(ticket); }, [ticket]);
  const [thread, setThread] = useState<{ posts: TicketPost[]; events: TicketEvent[] } | null>(null);
  const [reply, setReply] = useState("");
  const [mode, setMode] = useState<"internal" | "reply">("internal");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [delAsk, setDelAsk] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [newType, setNewType] = useState<string | null>(null);
  const [watchAdd, setWatchAdd] = useState<DOMRect | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  // e-mail, SLA, merging
  const [mails, setMails] = useState<MailMsg[] | null>(null);
  const [mailOk, setMailOk] = useState<OutlookMailStatus | null>(null);
  const [boxes, setBoxes] = useState<Mailbox[]>([]);
  const [sla, setSla] = useState<SlaMap | null>(null);
  const [byMail, setByMail] = useState(true);
  const [fromAddr, setFromAddr] = useState("");
  const [cc, setCc] = useState("");
  const [needPerm, setNeedPerm] = useState(false);
  const [mergeAt, setMergeAt] = useState<DOMRect | null>(null);
  const [mergeInto, setMergeInto] = useState<Ticket | null>(null);
  const [pickList, setPickList] = useState<Ticket[] | null>(tickets ?? null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { if (ticket) loadTicketThread(ticket.id).then(setThread).catch(() => setThread({ posts: [], events: [] })); }, [ticket?.id]);
  const reloadMail = useCallback(() => { if (ticket) loadTicketMail(ticket.id).then(setMails).catch(() => setMails([])); }, [ticket?.id]);
  useEffect(() => {
    reloadMail();
    getMailStatus().then(setMailOk).catch(() => {});
    loadSla().then((r) => setSla(r.sla)).catch(() => setSla(DEFAULT_SLA));
    loadMailboxes().then((b) => {
      const list = b ?? [];
      setBoxes(list);
      const def = list.find((x) => x.kind === "shared" && x.active && x.canSend && x.isDefaultFrom);
      if (def) setFromAddr((v) => v || def.address);
    }).catch(() => {});
    const iv = window.setInterval(() => setNow(Date.now()), 60000);
    const on = () => reloadMail();
    window.addEventListener(TICKETS_EVENT, on);
    return () => { window.clearInterval(iv); window.removeEventListener(TICKETS_EVENT, on); };
  }, [reloadMail]);
  useEffect(() => { if (tickets) setPickList(tickets); }, [tickets]);
  useEffect(() => { grow(titleRef.current); }, [t.title]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !watchAdd && !mergeAt) onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose, watchAdd, mergeAt]);

  const set = async (p: Partial<Ticket>) => {
    const next = { ...t, ...p };
    setT(next);
    if (creatingMode) return;
    onLocal?.(next);
    const e = await saveTicket(t.id, p, ready);
    setErr(e);
    if (!e) loadTicketThread(t.id).then(setThread).catch(() => {});
  };
  const create = async () => {
    if (!t.title.trim() || busy) return;
    setBusy(true);
    const res = await createTicket(t, ready);
    setBusy(false);
    if (res.error || !res.id) { setErr(res.error); return; }
    onCreated?.(res.id);
  };
  const lastIn = [...(mails ?? [])].reverse().find((m) => m.direction === "in");
  const replyTo = (lastIn?.fromEmail || t.requesterEmail || "").trim();
  const mailSubject = (() => {
    const ref = `[${ticketRef(t)}]`;
    const base = lastIn?.subject ? (/^(re|aw|sv):/i.test(lastIn.subject) ? lastIn.subject : `RE: ${lastIn.subject}`) : plain(t.title);
    return base.includes(ref) ? base : `${base} ${ref}`;
  })();
  const fromChoices = [
    { value: "", label: mailOk?.email ? `Me · ${mailOk.email}` : "My mailbox" },
    ...boxes.filter((b) => b.kind === "shared" && b.active && b.canSend).map((b) => ({ value: b.address, label: b.label ? `${b.label} · ${b.address}` : b.address })),
  ];
  const mailReady = !!mailOk?.connected && !!mailOk?.mail;
  const willMail = mode === "reply" && byMail && mails !== null;
  const send = async () => {
    if (!reply.trim() || !ticket || busy) return;
    setBusy(true); setNeedPerm(false);
    if (willMail) {
      if (!replyTo) { setBusy(false); setErr("Add the requester's e-mail first (on the right), or untick “Send by e-mail”."); return; }
      const html = reply.trim().split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`).join("");
      const r = await sendOutlookMail({
        to: [replyTo], cc: cc.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean),
        subject: mailSubject, html, from: fromAddr || null, ref: `ticket:${t.id}`,
      });
      if (!r.ok) {
        setBusy(false);
        if (r.needsMailPermission) { setNeedPerm(true); setErr(null); return; }
        setErr(r.retryAfter ? `Outlook is busy — try again in ${r.retryAfter}s.` : r.error ?? "Not sent.");
        return;
      }
      // the sent mail is the reply: it shows on the thread; the ticket counts as answered
      if (ready) {
        await supabase.from("tracking_tasks").update({ first_response_at: new Date().toISOString() }).eq("id", t.id).is("first_response_at", null);
        if (t.stage === "new") await saveTicket(t.id, { stage: "open" }, ready);
        else window.dispatchEvent(new Event(TICKETS_EVENT));
      }
      setBusy(false); setReply(""); setCc(""); setErr(null);
      if (!t.firstResponseAt) { const next = { ...t, firstResponseAt: new Date().toISOString(), stage: t.stage === "new" ? "open" as TicketStage : t.stage }; setT(next); onLocal?.(next); }
      reloadMail();
      loadTicketThread(t.id).then(setThread).catch(() => {});
      return;
    }
    const res = await postToTicket(t, reply, mode, ready);
    setBusy(false);
    if (res.error || !res.post) { setErr(res.error); return; }
    setReply(""); setErr(null);
    if (mode === "reply" && !t.firstResponseAt) { const next = { ...t, firstResponseAt: new Date().toISOString() }; setT(next); onLocal?.(next); }
    loadTicketThread(t.id).then(setThread).catch(() => {});
  };
  const doMerge = async () => {
    if (!mergeInto || busy) return;
    setBusy(true);
    const e = await mergeTicket(t, mergeInto, ready);
    setBusy(false);
    if (e) { setErr(e); setMergeInto(null); return; }
    const into = mergeInto.id;
    onClose();
    window.setTimeout(() => window.dispatchEvent(new CustomEvent("open-ticket", { detail: into })), 50);
  };
  const openMerge = (r: DOMRect) => {
    setMergeAt(r);
    if (!pickList) loadTickets().then((d) => setPickList(d.tickets)).catch(() => setPickList([]));
  };
  const setChecklist = (checklist: TaskStep[]) => {
    const progress = checklist.length ? Math.round((checklist.filter((x) => x.done).length / checklist.length) * 100) : t.progress;
    set({ checklist, progress });
  };
  const mergedTarget = t.mergedInto ? (pickList ?? []).find((x) => x.id === t.mergedInto) ?? null : null;
  const remove = async () => {
    const e = await deleteTicket(t.id);
    if (e) { setErr(e); setDelAsk(false); return; }
    onClose();
  };
  const toggleWatch = async (id: string) => {
    const on = !t.watchers.includes(id);
    const next = { ...t, watchers: on ? [...t.watchers, id] : t.watchers.filter((w) => w !== id) };
    setT(next);
    if (creatingMode) return;
    onLocal?.(next);
    await setWatcher(t.id, id, on);
  };
  const addTag = () => {
    const v = tagDraft.trim().replace(/^#/, "");
    setTagDraft("");
    if (!v || t.tags.includes(v)) return;
    set({ tags: [...t.tags, v] });
  };
  const saveNewType = async () => {
    const v = (newType ?? "").trim();
    setNewType(null);
    if (!v) return;
    if (!types.includes(v)) {
      const e = await addTicketType(v, types.length);
      if (e) { setErr(e); return; }
      onTypes?.([...types, v]);
    }
    set({ type: v });
  };
  const person = (id: string | null) => (id ? dir.people.find((p) => p.id === id) ?? null : null);
  const stageIdx = TICKET_STAGES.findIndex((s) => s.key === t.stage);
  const canDelete = !creatingMode && canDeleteTask({ created_by: t.createdBy }, dir.me);
  const items = [
    ...(thread?.posts ?? []).map((p) => ({ at: p.at, k: "post" as const, p })),
    ...(thread?.events ?? []).filter((e) => e.action !== "title").map((e) => ({ at: e.at, k: "event" as const, e })),
    ...(mails ?? []).map((m) => ({ at: m.at, k: "mail" as const, m })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const newestMail = (mails ?? []).length ? (mails ?? [])[(mails ?? []).length - 1].id : null;
  const [threadFilter, setThreadFilter] = useState<"all" | "mail" | "notes">("all");
  const visibleItems = items.filter((it) => threadFilter === "all" || (threadFilter === "mail" ? it.k === "mail" : it.k === "post"));
  const allAtt = (mails ?? []).flatMap((m) => m.attachments.map((a) => ({ m, a })));
  const opt = (xs: { id: string; name: string }[], none: string) => [{ value: "", label: none }, ...xs.map((x) => ({ value: x.id, label: x.name }))];
  const deal = t.trackingId ? dir.deals.find((d) => d.id === t.trackingId) : null;
  const departments = [...new Set(dir.people.map((p) => p.department).filter(Boolean))] as string[];

  return createPortal(
    <div className="td-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="td" role="dialog" aria-label={creatingMode ? "New ticket" : `Ticket ${ticketRef(t)}`}>
        <header className="td-head">
          <div className="td-head-top">
            <span className="td-ref">{creatingMode ? "New ticket" : ticketRef(t)}</span>
            {t.type && <span className="td-chip">{t.type}</span>}
            <span className="td-chip is-src">{t.source === "email" ? <TkIco d="mail" /> : null}{TICKET_SOURCES[t.source] ?? t.source}</span>
            {!creatingMode && isActive(t.stage) && dueInfo(t.due, today)?.tone === "late" && <span className="td-chip is-late">Overdue</span>}
            {!creatingMode && <SlaBadge t={t} sla={sla} now={now} />}
            <span className="td-spacer" />
            <button type="button" className="td-x" onClick={onClose} aria-label="Close"><TkIco d="x" /></button>
          </div>
          <textarea ref={titleRef} className="td-title" rows={1} value={t.title} placeholder="What needs doing?" autoFocus={creatingMode}
            onChange={(e) => setT({ ...t, title: e.target.value })}
            onBlur={() => { if (!creatingMode && ticket && t.title.trim() && t.title !== ticket.title) set({ title: t.title.trim() }); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); if (creatingMode) create(); } }} />
          <div className="td-steps" role="radiogroup" aria-label="Stage">
            {TICKET_STAGES.map((s, i) => (
              <button key={s.key} type="button" role="radio" aria-checked={t.stage === s.key}
                className={`td-step is-${s.key} ${i < stageIdx ? "is-past" : ""} ${t.stage === s.key ? "is-on" : ""}`}
                onClick={() => set({ stage: s.key })} title={s.hint}>
                <i />{s.label}
              </button>
            ))}
          </div>
          {t.mergedInto && (
            <div className="td-merged"><TkIco d="merge" />Merged into {mergedTarget ? <b>{ticketRef(mergedTarget)} “{plain(mergedTarget.title)}”</b> : "another ticket"}
              <button type="button" onClick={() => { const id = t.mergedInto; onClose(); window.setTimeout(() => window.dispatchEvent(new CustomEvent("open-ticket", { detail: id })), 50); }}>Open it →</button></div>
          )}
        </header>

        <div className="td-body">
          <div className="td-main">
            {!creatingMode && <ProgressPanel t={t} events={thread?.events ?? []} sla={sla} now={now} onChecklist={setChecklist} />}
            <section className="td-sec">
              <span className="td-k">Description</span>
              <textarea className="td-desc" value={t.description} placeholder="Add the details: what's asked, by whom, what done looks like…"
                onChange={(e) => { setT({ ...t, description: e.target.value }); grow(e.target); }} ref={(el) => grow(el)}
                onBlur={() => { if (!creatingMode && ticket && t.description !== ticket.description) set({ description: t.description }); }} />
            </section>

            {creatingMode && t.checklist.length > 0 && (
              <section className="td-sec">
                <span className="td-k">Checklist <em>{t.checklist.filter((s) => s.done).length}/{t.checklist.length}</em></span>
                <div className="td-check">
                  {t.checklist.map((s) => (
                    <label key={s.id} className={s.done ? "is-done" : ""}>
                      <input type="checkbox" checked={s.done} onChange={() => {
                        const checklist = t.checklist.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x));
                        const progress = Math.round((checklist.filter((x) => x.done).length / checklist.length) * 100);
                        set({ checklist, progress });
                      }} />
                      <span>{s.text}</span>
                    </label>
                  ))}
                </div>
              </section>
            )}

            {!creatingMode && (
              <section className="td-sec td-conv">
                <div className="td-conv-h">
                  <span className="td-k">Conversation &amp; activity</span>
                  <div className="tk-seg is-xs">
                    {([["all", "All"], ["mail", `E-mail${mails?.length ? ` ${mails.length}` : ""}`], ["notes", "Notes"]] as const).map(([k, l]) => (
                      <button key={k} type="button" className={threadFilter === k ? "is-on" : ""} onClick={() => setThreadFilter(k)}>{l}</button>
                    ))}
                  </div>
                </div>
                <div className={`td-composer is-${mode} ${willMail ? "is-mail" : ""}`}>
                  <div className="td-composer-tabs">
                    <button type="button" className={mode === "internal" ? "is-on" : ""} onClick={() => setMode("internal")}><TkIco d="lock" />Internal note</button>
                    <button type="button" className={mode === "reply" ? "is-on" : ""} onClick={() => setMode("reply")}><TkIco d="reply" />Reply to requester</button>
                  </div>
                  {mode === "reply" && mails !== null && (
                    <div className="td-mailbar">
                      <label className="td-mail-toggle"><input type="checkbox" checked={byMail} onChange={() => setByMail((v) => !v)} />Send by e-mail</label>
                      {byMail && (
                        <>
                          <span className="td-mail-f"><em>To</em><b>{replyTo || "no address yet"}</b></span>
                          {fromChoices.length > 1 && <span className="td-mail-f is-from"><em>From</em><Select size="sm" value={fromAddr} onChange={setFromAddr} options={fromChoices} aria-label="From" /></span>}
                          <span className="td-mail-f is-cc"><em>Cc</em><input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="optional" /></span>
                          <span className="td-mail-subj" title={mailSubject}><em>Subject</em>{mailSubject}</span>
                        </>
                      )}
                    </div>
                  )}
                  <textarea value={reply} onChange={(e) => { setReply(e.target.value); grow(e.target); }} rows={2}
                    placeholder={mode === "internal" ? "Only your team sees this…" : willMail ? `Write to ${t.requesterName || replyTo || "the requester"} — goes out from Outlook…` : `Note the reply to ${t.requesterName || t.requesterEmail || "the requester"}…`}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
                  {(needPerm || (willMail && mailOk && !mailReady)) && (
                    <div className="td-perm">
                      <TkIco d="mail" />
                      <span>{mailOk?.connected ? "Your Outlook connection can't send mail yet — connect again with mail permission." : "Connect Outlook to send replies by e-mail."}</span>
                      <button type="button" onClick={() => connectOutlook({ withMail: true })}>Connect with mail</button>
                    </div>
                  )}
                  <div className="td-composer-foot">
                    <span>⌘ Enter to send</span>
                    <button type="button" className="td-send" onClick={send} disabled={!reply.trim() || busy}>
                      {busy ? "Sending…" : mode === "internal" ? "Add note" : willMail ? <><TkIco d="send" />Send e-mail</> : "Log reply"}
                    </button>
                  </div>
                </div>
                {allAtt.length > 0 && (
                  <div className="td-files">
                    <span className="td-k"><TkIco d="clip" />Files on this ticket <em>{allAtt.length}</em></span>
                    <div className="tm-att">{(mails ?? []).filter((m) => m.attachments.length).map((m) => <Attachments key={m.id} m={m} />)}</div>
                  </div>
                )}
                <div className="td-thread">
                  {!thread ? <div className="hs-skel" /> : !visibleItems.length ? <p className="td-none">{threadFilter === "mail" ? "No e-mail on this ticket yet." : "No notes yet. Updates and changes will show up here."}</p> : [...visibleItems].reverse().map((it) => it.k === "mail" ? (
                    <MailCard key={it.m.id} m={it.m} open={it.m.id === newestMail} />
                  ) : it.k === "post" ? (
                    <div key={it.p.id} className={`td-post is-${it.p.visibility}`}>
                      <Avatar person={person(it.p.author)} size={30} />
                      <div className="td-post-body">
                        <span className="td-post-h"><b>{person(it.p.author)?.name ?? "Someone"}</b>{it.p.visibility === "reply" ? <em className="is-reply">Reply</em> : <em><TkIco d="lock" />Internal</em>}<time>{ago2(it.p.at)}</time></span>
                        <p><Rich text={it.p.body} /></p>
                      </div>
                    </div>
                  ) : (
                    <div key={it.e.id} className="td-event">
                      <span className="td-event-dot" /><b>{person(it.e.author)?.name ?? "Someone"}</b> {eventText(it.e, dir)}<time>{ago2(it.e.at)}</time>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          <aside className="td-side">
            <div className="td-f">
              <span className="td-k">Owner</span>
              <Select searchable value={t.assignee ?? ""} onChange={(v) => set({ assignee: v || null })} options={opt(dir.people, "Unassigned")} />
              {t.assignee !== dir.me && dir.me && <button type="button" className="td-mini" onClick={() => set({ assignee: dir.me })}>Assign to me</button>}
            </div>
            <div className="td-f">
              <span className="td-k">Priority</span>
              <div className="td-prio">
                {TASK_PRIORITIES.map((p) => (
                  <button key={p} type="button" className={`is-${p} ${t.priority === p ? "is-on" : ""}`} onClick={() => set({ priority: p })}><FlagIcon />{PRIORITY_LABEL[p]}</button>
                ))}
              </div>
            </div>
            <div className="td-f-row">
              <div className="td-f">
                <span className="td-k">Type</span>
                {newType !== null ? (
                  <input className="td-in" autoFocus value={newType} placeholder="New type…" onChange={(e) => setNewType(e.target.value)} onBlur={saveNewType}
                    onKeyDown={(e) => { if (e.key === "Enter") saveNewType(); if (e.key === "Escape") setNewType(null); }} />
                ) : (
                  <Select value={t.type ?? ""} onChange={(v) => (v === "__new" ? setNewType("") : set({ type: v || null }))}
                    options={[{ value: "", label: "No type" }, ...types.map((x) => ({ value: x, label: x })), { value: "__new", label: "+ New type…" }]} />
                )}
              </div>
              <div className="td-f">
                <span className="td-k">Due</span>
                <div className="td-due">
                  <DatePicker value={dayOf(t.due) ?? ""} onChange={(iso) => set({ due: iso ? `${iso}T${timeOf(t.due) ?? "18:00"}:00` : null })} placeholder="No due date" />
                  {t.due && <button type="button" className="td-clear" onClick={() => set({ due: null })} aria-label="Clear due date"><TkIco d="x" /></button>}
                </div>
              </div>
            </div>
            <div className="td-f">
              <span className="td-k">Watchers <em>get every update</em></span>
              <div className="td-watch">
                {t.watchers.map((w) => (
                  <span key={w} className="td-watcher"><Avatar person={person(w)} size={20} />{person(w)?.name ?? "Someone"}<button type="button" onClick={() => toggleWatch(w)} aria-label="Remove"><TkIco d="x" /></button></span>
                ))}
                <button type="button" className="td-add" onClick={(e) => setWatchAdd(e.currentTarget.getBoundingClientRect())}><TkIco d="plus" />Add</button>
              </div>
            </div>

            <div className="td-group">
              <span className="td-group-h"><TkIco d="mail" />Requester</span>
              <Select searchable value={t.requesterContactId ?? ""} onChange={(v) => {
                const c = dir.contacts.find((x) => x.id === v);
                set({ requesterContactId: v || null, ...(c ? { requesterName: c.name, requesterEmail: c.email } : {}) });
              }} options={opt(dir.contacts, "Pick a contact…")} />
              <div className="td-f-row">
                <input className="td-in" value={t.requesterName ?? ""} placeholder="Name" onChange={(e) => setT({ ...t, requesterName: e.target.value })} onBlur={() => !creatingMode && set({ requesterName: t.requesterName || null })} />
                <input className="td-in" value={t.requesterEmail ?? ""} placeholder="E-mail" type="email" onChange={(e) => setT({ ...t, requesterEmail: e.target.value })} onBlur={() => !creatingMode && set({ requesterEmail: t.requesterEmail || null })} />
              </div>
            </div>

            <div className="td-group">
              <span className="td-group-h"><TkIco d="link" />Linked to</span>
              <label className="td-lk"><TkIco d="briefcase" /><Select searchable value={t.clientId ?? ""} onChange={(v) => set({ clientId: v || null })} options={opt(dir.clients, "No client")} /></label>
              <label className="td-lk"><TkIco d="building" /><Select searchable value={t.companyId ?? ""} onChange={(v) => set({ companyId: v || null })} options={opt(dir.companies, "No company")} /></label>
              <label className="td-lk"><TkIco d="deal" /><Select searchable value={t.trackingId ?? ""} onChange={(v) => set({ trackingId: v || null })} options={opt(dir.deals, "No deal")} /></label>
              <label className="td-lk"><TkIco d="folder" /><Select searchable value={t.projectId ?? ""} onChange={(v) => set({ projectId: v || null })} options={opt(dir.projects, "No project")} /></label>
              {!creatingMode && (t.clientId || deal || t.companyId) && (
                <div className="td-jump">
                  {t.clientId && <button type="button" onClick={() => nav(`/clients?client=${t.clientId}`)}>Open client →</button>}
                  {deal && <button type="button" onClick={() => nav(`/sales?tracking=${deal.id}`)}>Open deal →</button>}
                  {t.companyId && <button type="button" onClick={() => nav("/companies", { state: { focusCompanyId: t.companyId } })}>Open company →</button>}
                </div>
              )}
            </div>

            <div className="td-f-row">
              <div className="td-f">
                <span className="td-k">Team</span>
                <Select value={t.team ?? ""} onChange={(v) => set({ team: v || null })} options={[{ value: "", label: "Any team" }, ...departments.map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) }))]} />
              </div>
              <div className="td-f">
                <span className="td-k">Source</span>
                <Select value={t.source} onChange={(v) => set({ source: v })} options={Object.entries(TICKET_SOURCES).map(([value, label]) => ({ value, label }))} />
              </div>
            </div>
            <div className="td-f">
              <span className="td-k">Tags</span>
              <div className="td-tags">
                {t.tags.map((x) => <span key={x} className="td-tag">#{x}<button type="button" onClick={() => set({ tags: t.tags.filter((y) => y !== x) })} aria-label="Remove tag"><TkIco d="x" /></button></span>)}
                <input value={tagDraft} placeholder={t.tags.length ? "+ tag" : "Add a tag…"} onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(); } }} onBlur={addTag} />
              </div>
            </div>
            {!creatingMode && (
              <dl className="td-meta">
                <div><dt>Opened</dt><dd>{new Date(t.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}{t.createdBy ? ` · ${person(t.createdBy)?.name ?? ""}` : ""}</dd></div>
                {t.updatedAt && <div><dt>Updated</dt><dd>{ago2(t.updatedAt)}</dd></div>}
                {t.resolvedAt && !isActive(t.stage) && <div><dt>Resolved</dt><dd>{ago2(t.resolvedAt)}</dd></div>}
              </dl>
            )}
          </aside>
        </div>

        {err && <p className="td-err">{err}</p>}
        <footer className="td-foot">
          {canDelete && (delAsk ? (
            <span className="td-del-ask">Delete this ticket for good?<button type="button" className="td-del" onClick={remove}>Delete</button><button type="button" className="td-ghost" onClick={() => setDelAsk(false)}>Keep</button></span>
          ) : <button type="button" className="td-ghost is-del" onClick={() => setDelAsk(true)}><TkIco d="trash" />Delete</button>)}
          {!creatingMode && !t.mergedInto && (mergeInto ? (
            <span className="td-del-ask is-merge"><span>Merge into <b>{ticketRef(mergeInto)}</b>? Notes, e-mails and watchers move; this one closes.</span>
              <button type="button" className="td-primary is-sm" onClick={doMerge} disabled={busy}>Merge</button><button type="button" className="td-ghost" onClick={() => setMergeInto(null)}>Cancel</button></span>
          ) : <button type="button" className="td-ghost" onClick={(e) => openMerge(e.currentTarget.getBoundingClientRect())}><TkIco d="merge" />Merge into…</button>)}
          <span className="td-spacer" />
          {creatingMode ? (
            <>
              <button type="button" className="td-ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="td-primary" onClick={create} disabled={!t.title.trim() || busy}>{busy ? "Creating…" : "Create ticket"}</button>
            </>
          ) : isActive(t.stage) ? (
            <button type="button" className="td-primary" onClick={() => set({ stage: "resolved" })}><TkIco d="check" />Resolve</button>
          ) : (
            <>
              <button type="button" className="td-ghost" onClick={() => set({ stage: "open" })}>Reopen</button>
              {t.stage !== "closed" && <button type="button" className="td-primary" onClick={() => set({ stage: "closed" })}>Close ticket</button>}
            </>
          )}
        </footer>
        {mergeAt && (
          <Pop anchor={mergeAt} onClose={() => setMergeAt(null)} width={340}>
            {pickList ? <TicketPick tickets={pickList} exclude={t.id} onPick={(x) => { setMergeAt(null); setMergeInto(x); }} placeholder="Merge into which ticket?" /> : <div className="hs-skel" />}
          </Pop>
        )}
        {watchAdd && (
          <Pop anchor={watchAdd} onClose={() => setWatchAdd(null)} width={250}>
            <PeopleMenu dir={dir} value={null} allowNone={false} onPick={(id) => { setWatchAdd(null); if (id && !t.watchers.includes(id)) toggleWatch(id); }} />
          </Pop>
        )}
      </aside>
    </div>,
    document.body,
  );
}

/** A ticket drawer opened from anywhere by id (global search). */
export function TicketDrawerById({ id, onClose }: { id: string; onClose: () => void }) {
  const [state, setState] = useState<{ t: Ticket | null; ready: boolean; dir: Directory; types: string[] } | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([loadTicket(id), loadDirectory(), loadTicketTypes()]).then(([r, dir, types]) => { if (alive) setState({ t: r.ticket, ready: r.ready, dir, types }); });
    return () => { alive = false; };
  }, [id]);
  if (!state?.t) return null;
  return <TicketDrawer ticket={state.t} dir={state.dir} types={state.types} ready={state.ready} onClose={onClose}
    onLocal={(t) => setState((s) => s && { ...s, t })} onTypes={(types) => setState((s) => s && { ...s, types })} />;
}

/* =====================================================================
   DESK PIECES — mail, SLA, progress, settings
   ===================================================================== */
/* ---- the Outlook connection (one check per page) ---- */
let mailStatusP: Promise<OutlookMailStatus> | null = null;
export function getMailStatus(fresh = false): Promise<OutlookMailStatus> {
  if (!mailStatusP || fresh) {
    mailStatusP = outlookMailStatus();
    mailStatusP.catch(() => { mailStatusP = null; });
  }
  return mailStatusP;
}
if (typeof window !== "undefined") window.addEventListener(OUTLOOK_CONNECTION_EVENT, () => { mailStatusP = null; });

/** An e-mail body made safe: no scripts / handlers / forms, links open outside, remote images held back until asked. */
export function sanitizeMail(html: string, blockImages: boolean): { html: string; blocked: number } {
  let blocked = 0;
  try {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    doc.querySelectorAll("script, iframe, object, embed, form, base, link, meta").forEach((n) => n.remove());
    doc.querySelectorAll("*").forEach((el) => {
      [...el.attributes].forEach((a) => {
        const n = a.name.toLowerCase();
        if (n.startsWith("on") || ((n === "href" || n === "src" || n === "xlink:href" || n === "action") && /^\s*(javascript|vbscript):/i.test(a.value))) el.removeAttribute(a.name);
      });
      if (el.tagName === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
      if (blockImages && el.tagName === "IMG" && /^\s*https?:/i.test(el.getAttribute("src") ?? "")) { el.removeAttribute("src"); el.removeAttribute("srcset"); blocked++; }
    });
    return { html: doc.body ? doc.body.innerHTML : "", blocked };
  } catch { return { html: "", blocked: 0 }; }
}
/** The e-mail, in a sandboxed frame (no scripts) sized to its content. */
function MailFrame({ html, maxHeight = 560 }: { html: string; maxHeight?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(90);
  const [images, setImages] = useState(false);
  const safe = useMemo(() => sanitizeMail(html, !images), [html, images]);
  const doc = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    html,body{margin:0;padding:0;background:#fff}body{font:13.5px/1.55 Inter,system-ui,-apple-system,sans-serif;color:#0b241a;padding:14px 16px;overflow-wrap:anywhere}
    img{max-width:100%;height:auto}blockquote{margin:6px 0;padding-left:10px;border-left:3px solid #d4e2dc;color:#5a7d6d}table{max-width:100%!important}a{color:#0a6f4d}p{margin:0 0 8px}
  </style></head><body>${safe.html}</body></html>`, [safe.html]);
  const fit = () => { try { const b = ref.current?.contentDocument?.body; if (b) setH(Math.min(maxHeight, Math.max(56, b.scrollHeight + 6))); } catch { /* sandboxed */ } };
  return (
    <div className="tm-frame-wrap">
      {safe.blocked > 0 && !images && (
        <button type="button" className="tm-imgs" onClick={() => setImages(true)}><TkIco d="eye" />{safe.blocked} image{safe.blocked === 1 ? "" : "s"} held back · show</button>
      )}
      <iframe ref={ref} className="tm-frame" title="E-mail" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} style={{ height: h }} onLoad={fit} />
    </div>
  );
}
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fullDate = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function Attachments({ m }: { m: MailMsg }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!m.attachments.length) return null;
  const get = async (a: MailAttachment) => {
    setBusy(a.id); setErr(null);
    const r = await fetchMailAttachment(m.id, a.id);
    setBusy(null);
    if ("error" in r) { setErr(r.error); return; }
    const url = URL.createObjectURL(r.blob);
    const link = document.createElement("a"); link.href = url; link.download = r.name; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  return (
    <div className="tm-att">
      {m.attachments.map((a) => (
        <button key={a.id} type="button" className="tm-att-chip" onClick={() => get(a)} disabled={busy === a.id} title={`Download ${a.name}`}>
          <TkIco d="clip" /><span>{a.name}</span><em>{busy === a.id ? "…" : fmtBytes(a.size || 0)}</em>
        </button>
      ))}
      {err && <span className="tm-att-err">{err}</span>}
    </div>
  );
}
/** One e-mail on a ticket's thread: folded to its preview, open to read it all. */
function MailCard({ m, open: open0 = false }: { m: MailMsg; open?: boolean }) {
  const [open, setOpen] = useState(open0);
  const who = m.direction === "out" ? (m.to.map((x) => x.name || x.email).join(", ") || "—") : (m.fromName || m.fromEmail || "Someone");
  return (
    <div className={`tm-card is-${m.direction} ${open ? "is-open" : ""}`}>
      <span className="tm-card-ico"><TkIco d={m.direction === "out" ? "send" : "mail"} /></span>
      <div className="tm-card-body">
        <button type="button" className="tm-card-h" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <b>{m.direction === "out" ? "E-mail sent to " : ""}{who}</b>
          {m.direction === "in" && m.fromEmail && m.fromName && <em>{m.fromEmail}</em>}
          {m.attachments.length > 0 && <span className="tm-card-clip"><TkIco d="clip" />{m.attachments.length}</span>}
          <time title={fullDate(m.at)}>{ago(m.at)}</time>
          <TkIco d="chev" className="tm-card-chev" />
        </button>
        <span className="tm-card-subj">{m.subject || "(no subject)"}</span>
        {open ? (
          <>
            <div className="tm-card-meta">
              {m.direction === "in" ? <>To {m.to.map((x) => x.email).join(", ") || "—"}{m.cc.length ? ` · Cc ${m.cc.map((x) => x.email).join(", ")}` : ""}</> : <>From {m.fromEmail ?? "you"}{m.cc.length ? ` · Cc ${m.cc.map((x) => x.email).join(", ")}` : ""}</>}
              <span>{fullDate(m.at)}</span>
            </div>
            {m.html ? <MailFrame html={m.html} /> : <p className="tm-card-snip">{m.snippet}</p>}
            <Attachments m={m} />
          </>
        ) : <p className="tm-card-snip">{m.snippet}</p>}
      </div>
    </div>
  );
}

/* ---- SLA badge ---- */
export function SlaBadge({ t, sla, now, compact = false }: { t: Ticket; sla: SlaMap | null; now: number; compact?: boolean }) {
  if (!sla) return null;
  const st = slaOf(t, sla, now);
  if (!st) return null;
  const tone = st.breached ? "is-breach" : st.left < st.window * 0.25 ? "is-soon" : "is-ok";
  const what = st.kind === "response" ? "First reply" : "Resolve";
  const text = st.breached ? `${compact ? "" : `${what} `}late ${span(st.left)}` : `${compact ? "" : `${what} in `}${span(st.left)}`;
  return (
    <span className={`tk-sla ${tone}`} title={`${what} due ${fullDate(new Date(st.dueAt).toISOString())} (SLA for ${PRIORITY_LABEL[t.priority].toLowerCase()} priority)`}>
      <TkIco d="bolt" />{text}
    </span>
  );
}

/* ---- progress: where the ticket stands and where its time went ---- */
const STAGE_PCT: Record<TicketStage, number> = { new: 0, open: 15, in_progress: 50, waiting: 60, resolved: 100, closed: 100 };
function stageSegments(t: Ticket, events: TicketEvent[], now: number) {
  const moves = events.filter((e) => e.action === "stage" && e.detail?.to).sort((a, b) => a.at.localeCompare(b.at));
  const first = (moves[0]?.detail?.from as TicketStage) || (moves.length ? "new" : t.stage);
  const segs: { stage: TicketStage; from: number; to: number; ongoing: boolean }[] = [];
  let cur: TicketStage = TICKET_STAGES.some((s) => s.key === first) ? first : "new";
  let at = new Date(t.createdAt).getTime();
  for (const mv of moves) {
    const when = new Date(mv.at).getTime();
    if (when > at) segs.push({ stage: cur, from: at, to: when, ongoing: false });
    cur = mv.detail.to as TicketStage; at = Math.max(at, when);
  }
  segs.push({ stage: t.stage, from: at, to: isActive(t.stage) ? now : Math.max(at, new Date(t.resolvedAt ?? t.updatedAt ?? t.createdAt).getTime()), ongoing: isActive(t.stage) });
  return segs.filter((s) => s.to >= s.from);
}
function ProgressPanel({ t, events, sla, now, onChecklist }: {
  t: Ticket; events: TicketEvent[]; sla: SlaMap | null; now: number; onChecklist: (steps: TaskStep[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const done = t.checklist.filter((x) => x.done).length;
  const pct = t.checklist.length ? Math.round((done / t.checklist.length) * 100) : STAGE_PCT[t.stage];
  const segs = stageSegments(t, events, now);
  const total = Math.max(1, segs.reduce((n, s) => n + (s.to - s.from), 0));
  const target = sla?.[t.priority];
  const created = new Date(t.createdAt).getTime();
  const timer = (label: string, minutes: number | null | undefined, doneAt: string | null) => {
    if (!minutes) return <div className="tp-sla is-none"><span>{label}</span><b>No target</b></div>;
    const due = created + minutes * 60000;
    if (doneAt) {
      const took = new Date(doneAt).getTime() - created;
      const ok = new Date(doneAt).getTime() <= due;
      return <div className={`tp-sla ${ok ? "is-met" : "is-breach"}`}><span>{label}</span><b>{ok ? "Met" : "Missed"} · {span(took)}</b><em>target {span(minutes * 60000)}</em></div>;
    }
    if (!isActive(t.stage)) return <div className="tp-sla is-none"><span>{label}</span><b>—</b><em>target {span(minutes * 60000)}</em></div>;
    const left = due - now;
    const tone = left < 0 ? "is-breach" : left < minutes * 60000 * 0.25 ? "is-soon" : "is-ok";
    return (
      <div className={`tp-sla ${tone}`}>
        <span>{label}</span><b>{left < 0 ? `Late ${span(left)}` : `${span(left)} left`}</b><em>target {span(minutes * 60000)}</em>
        <i className="tp-sla-bar"><i style={{ width: `${Math.max(0, Math.min(100, 100 - (left / (minutes * 60000)) * 100))}%` }} /></i>
      </div>
    );
  };
  const addStep = () => {
    const v = draft.trim();
    if (!v) return;
    setDraft("");
    onChecklist([...t.checklist, { id: newStepId(), text: v, done: false }]);
  };
  return (
    <section className="tp">
      <div className="tp-top">
        <div className="tp-ring" style={{ ["--p" as string]: pct } as React.CSSProperties}>
          <svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15.5" /><circle cx="18" cy="18" r="15.5" className="tp-ring-v" style={{ strokeDasharray: `${(pct / 100) * 97.4} 97.4` }} /></svg>
          <b>{pct}<i>%</i></b>
        </div>
        <div className="tp-top-txt">
          <span className="td-k">Progress</span>
          <b>{t.checklist.length ? `${done} of ${t.checklist.length} steps done` : `${stageLabel(t.stage)} — add steps to track it in detail`}</b>
          <span className="tp-top-sub">Open {span(now - created)}{t.resolvedAt && !isActive(t.stage) ? ` · resolved in ${span(new Date(t.resolvedAt).getTime() - created)}` : ""}</span>
        </div>
        <div className="tp-slas">
          {timer("First reply", target?.firstResponse, t.firstResponseAt)}
          {timer("Resolution", target?.resolution, isActive(t.stage) ? null : t.resolvedAt)}
        </div>
      </div>
      <div className="tp-time" aria-label="Time in each stage">
        <div className="tp-bar">
          {segs.map((sg, i) => (
            <span key={i} className={`tp-seg is-${sg.stage} ${sg.ongoing ? "is-now" : ""}`} style={{ flexGrow: Math.max(0.04, (sg.to - sg.from) / total) }} title={`${stageLabel(sg.stage)} · ${span(sg.to - sg.from)}`} />
          ))}
        </div>
        <ol className="tp-steps">
          {segs.map((sg, i) => (
            <li key={i} className={`is-${sg.stage} ${sg.ongoing ? "is-now" : ""}`}>
              <span className={`tk-dot is-${sg.stage}`} />
              <b>{stageLabel(sg.stage)}</b>
              <em>{span(sg.to - sg.from)}{sg.ongoing ? " so far" : ""}</em>
              <time>{new Date(sg.from).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</time>
            </li>
          ))}
        </ol>
      </div>
      <div className="tp-check">
        {t.checklist.map((x) => (
          <label key={x.id} className={x.done ? "is-done" : ""}>
            <input type="checkbox" checked={x.done} onChange={() => onChecklist(t.checklist.map((y) => (y.id === x.id ? { ...y, done: !y.done } : y)))} />
            <span>{x.text}</span>
            <button type="button" className="tp-check-x" onClick={(e) => { e.preventDefault(); onChecklist(t.checklist.filter((y) => y.id !== x.id)); }} aria-label="Remove step"><TkIco d="x" /></button>
          </label>
        ))}
        <div className="tp-add">
          <TkIco d="plus" />
          <input value={draft} placeholder={t.checklist.length ? "Add a step…" : "Break it into steps — progress follows them"} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addStep(); } }} onBlur={addStep} />
        </div>
      </div>
    </section>
  );
}

/* ---- pick a ticket (merge / add a mail to / rule target) ---- */
function TicketPick({ tickets, exclude, onPick, placeholder = "Find a ticket by number or title…" }: {
  tickets: Ticket[]; exclude?: string; onPick: (t: Ticket) => void; placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const f = fold(q.trim());
  const list = tickets.filter((t) => t.id !== exclude && !t.mergedInto && (!f || fold(`${ticketRef(t)} ${t.title} ${t.requesterName ?? ""} ${t.requesterEmail ?? ""}`).includes(f)))
    .sort((a, b) => Number(isActive(b.stage)) - Number(isActive(a.stage)) || (b.no ?? 0) - (a.no ?? 0)).slice(0, 40);
  return (
    <div className="tk-people">
      <input className="tk-pop-q" autoFocus placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="tk-pop-list">
        {list.map((t) => (
          <button key={t.id} type="button" className="tk-pop-opt" onClick={() => onPick(t)}>
            <span className={`tk-dot is-${t.stage}`} />
            <span>{plain(t.title)}<em>{ticketRef(t)} · {stageLabel(t.stage)}{t.requesterEmail ? ` · ${t.requesterEmail}` : ""}</em></span>
          </button>
        ))}
        {!list.length && <p className="tk-pop-empty">No ticket matches.</p>}
      </div>
    </div>
  );
}

/* ---- the Inbox: mail that reached the desk without a ticket ---- */
function MailRow({ m, boxes, i, onOpen, onCreate, onAdd, onRule, onIgnore }: {
  m: MailMsg; boxes: Mailbox[]; i: number;
  onOpen: () => void; onCreate: () => void; onAdd: (r: DOMRect) => void; onRule: () => void; onIgnore: () => void;
}) {
  const box = boxes.find((b) => b.id === m.mailboxId);
  const name = m.fromName || m.fromEmail || "Unknown sender";
  return (
    <div className="tm-row" style={{ ["--i" as string]: Math.min(i, 12) } as React.CSSProperties} role="button" tabIndex={0}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <span className="tm-row-av" style={{ background: toneOf(m.fromEmail || name) }}>{initials(name)}</span>
      <div className="tm-row-main">
        <div className="tm-row-top">
          <b>{name}</b>
          {box && <span className="tm-box">{box.label || box.address}</span>}
          {m.attachments.length > 0 && <TkIco d="clip" className="tm-row-clip" />}
          <time title={fullDate(m.at)}>{ago(m.at)}</time>
        </div>
        <span className="tm-row-subj">{m.subject || "(no subject)"}</span>
        <span className="tm-row-snip">{m.snippet}</span>
      </div>
      <div className="tm-row-acts" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="tm-act is-main" onClick={onCreate} title="Create a ticket from this e-mail"><TkIco d="plus" />Ticket</button>
        <button type="button" className="tm-act" onClick={(e) => onAdd(e.currentTarget.getBoundingClientRect())} title="Add to an existing ticket"><TkIco d="link" /></button>
        <button type="button" className="tm-act" onClick={onRule} title="Make a rule from this e-mail"><TkIco d="filter" /></button>
        <button type="button" className="tm-act" onClick={onIgnore} title="Ignore — hide it from the Inbox"><TkIco d="ban" /></button>
      </div>
    </div>
  );
}
function MailPreview({ m, boxes, onClose, onCreate, onAdd, onRule, onIgnore }: {
  m: MailMsg; boxes: Mailbox[]; onClose: () => void; onCreate: () => void; onAdd: (r: DOMRect) => void; onRule: () => void; onIgnore: () => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  const box = boxes.find((b) => b.id === m.mailboxId);
  return createPortal(
    <div className="td-back tm-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tm-modal" role="dialog" aria-label="E-mail">
        <header className="tm-modal-h">
          <span className="tm-row-av is-lg" style={{ background: toneOf(m.fromEmail || "x") }}>{initials(m.fromName || m.fromEmail || "?")}</span>
          <div className="tm-modal-who">
            <b>{m.fromName || m.fromEmail}</b>
            <span>{m.fromEmail}{box ? ` → ${box.label || box.address}` : ""} · {fullDate(m.at)}</span>
          </div>
          <button type="button" className="td-x" onClick={onClose} aria-label="Close"><TkIco d="x" /></button>
        </header>
        <h3 className="tm-modal-subj">{m.subject || "(no subject)"}</h3>
        {(m.to.length > 0 || m.cc.length > 0) && <p className="tm-modal-to">To {m.to.map((x) => x.email).join(", ")}{m.cc.length ? ` · Cc ${m.cc.map((x) => x.email).join(", ")}` : ""}</p>}
        <div className="tm-modal-body">{m.html ? <MailFrame html={m.html} maxHeight={2000} /> : <p className="tm-card-snip">{m.snippet}</p>}<Attachments m={m} /></div>
        <footer className="tm-modal-f">
          <button type="button" className="td-ghost" onClick={onIgnore}><TkIco d="ban" />Ignore</button>
          <button type="button" className="td-ghost" onClick={onRule}><TkIco d="filter" />Make a rule</button>
          <span className="td-spacer" />
          <button type="button" className="td-ghost" onClick={(e) => onAdd(e.currentTarget.getBoundingClientRect())}><TkIco d="link" />Add to ticket…</button>
          <button type="button" className="td-primary" onClick={onCreate}><TkIco d="plus" />Create ticket</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/* ---- keyboard help ---- */
const SHORTCUTS: [string, string][] = [
  ["N", "New ticket"], ["/", "Filter"], ["J / K", "Next / previous ticket"], ["Enter", "Open it"], ["E", "Resolve it"],
  ["A", "Assign it to me"], ["X", "Select it (full view)"], ["I", "Inbox"], ["S", "Sync mail"], ["?", "This help"],
];
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "?") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="td-back tm-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tk-keys" role="dialog" aria-label="Keyboard shortcuts">
        <header><TkIco d="keyboard" /><b>Keyboard shortcuts</b><button type="button" className="td-x" onClick={onClose} aria-label="Close"><TkIco d="x" /></button></header>
        <dl>{SHORTCUTS.map(([k, v]) => <div key={k}><dt>{k.split(" / ").map((x, i) => <kbd key={i}>{x}</kbd>)}</dt><dd>{v}</dd></div>)}</dl>
      </div>
    </div>,
    document.body,
  );
}

/* ---- desk settings: mail rules, mailboxes, SLA ---- */
type SettingsTab = "rules" | "mailboxes" | "sla";
const blankRule = (sort: number, from?: Partial<MailRule>): MailRule => ({
  id: "", name: "", sort, active: true, conditions: { match: "all" }, action: "create", targetTicketId: null, set: {}, hits: 0, lastHitAt: null, ...(from ?? {}),
});
function ruleSummary(r: MailRule, dir: Directory | null, tickets: Ticket[]): { when: string; then: string } {
  const c = r.conditions, parts: string[] = [];
  if (c.from_emails?.length) parts.push(`from ${c.from_emails.join(" or ")}`);
  if (c.from_contains) parts.push(`sender contains “${c.from_contains}”`);
  if (c.from_contact_ids?.length) parts.push(`from ${c.from_contact_ids.map((id) => dir?.contacts.find((x) => x.id === id)?.name ?? "a contact").join(" or ")}`);
  if (c.from_company_id) parts.push(`from someone at ${dir?.companies.find((x) => x.id === c.from_company_id)?.name ?? "a company"}`);
  if (c.mailbox) parts.push(`sent to ${c.mailbox}`);
  if (c.subject_contains) parts.push(`subject contains “${c.subject_contains}”`);
  if (c.subject_regex) parts.push(`subject matches /${c.subject_regex}/`);
  if (c.body_contains) parts.push(`text contains “${c.body_contains}”`);
  const when = parts.length ? parts.join(c.match === "any" ? " or " : " and ") : "no conditions yet (never runs)";
  const tgt = r.targetTicketId ? tickets.find((t) => t.id === r.targetTicketId) : null;
  const then = r.action === "ignore" ? "ignore it"
    : r.action === "append" ? `add it to ${tgt ? `${ticketRef(tgt)} “${plain(tgt.title)}”` : "a ticket"}`
    : `open a ticket${r.set.type ? ` (${r.set.type})` : ""}${r.set.priority ? `, ${PRIORITY_LABEL[r.set.priority].toLowerCase()} priority` : ""}${r.set.assignee_id ? ` for ${dir?.people.find((p) => p.id === r.set.assignee_id)?.name ?? "someone"}` : ""}`;
  return { when, then };
}
function RuleEditor({ rule, dir, types, tickets, boxes, inbox, onSave, onCancel }: {
  rule: MailRule; dir: Directory; types: string[]; tickets: Ticket[]; boxes: Mailbox[]; inbox: MailMsg[];
  onSave: (r: MailRule) => Promise<void>; onCancel: () => void;
}) {
  const [r, setR] = useState<MailRule>(rule);
  const [emails, setEmails] = useState((rule.conditions.from_emails ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<DOMRect | null>(null);
  const c = r.conditions;
  const setC = (p: Partial<RuleConditions>) => setR({ ...r, conditions: { ...c, ...p } });
  const setS = (p: Partial<RuleSet>) => setR({ ...r, set: { ...r.set, ...p } });
  const live: MailRule = { ...r, conditions: { ...c, from_emails: emails.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean) } };
  const hits = inbox.filter((m) => ruleMatchesMail(live.conditions, m, dir));
  const departments = [...new Set(dir.people.map((p) => p.department).filter(Boolean))] as string[];
  const target = r.targetTicketId ? tickets.find((t) => t.id === r.targetTicketId) : null;
  const opt = (xs: { id: string; name: string }[], none: string) => [{ value: "", label: none }, ...xs.map((x) => ({ value: x.id, label: x.name }))];
  return (
    <div className="tr-ed">
      <input className="tr-name" value={r.name} autoFocus placeholder="Name this rule, e.g. “Acme support requests”" onChange={(e) => setR({ ...r, name: e.target.value })} />
      <div className="tr-block">
        <div className="tr-block-h"><span className="tr-step">1</span><b>When an e-mail arrives</b>
          <div className="tk-seg">
            <button type="button" className={c.match !== "any" ? "is-on" : ""} onClick={() => setC({ match: "all" })}>matching all</button>
            <button type="button" className={c.match === "any" ? "is-on" : ""} onClick={() => setC({ match: "any" })}>any</button>
          </div>
        </div>
        <div className="tr-grid">
          <label><span>From these addresses</span><input className="td-in" value={emails} placeholder="ana@acme.es, @acme.es" onChange={(e) => setEmails(e.target.value)} /></label>
          <label><span>Sender contains</span><input className="td-in" value={c.from_contains ?? ""} placeholder="acme" onChange={(e) => setC({ from_contains: e.target.value })} /></label>
          <div className="tr-f"><span>From these contacts</span>
            <div className="tr-chips">
              {(c.from_contact_ids ?? []).map((id) => (
                <span key={id} className="td-tag">{dir.contacts.find((x) => x.id === id)?.name ?? "Contact"}<button type="button" onClick={() => setC({ from_contact_ids: (c.from_contact_ids ?? []).filter((x) => x !== id) })} aria-label="Remove"><TkIco d="x" /></button></span>
              ))}
              <div className="tr-chip-add"><Select searchable value="" onChange={(v) => v && setC({ from_contact_ids: [...new Set([...(c.from_contact_ids ?? []), v])] })} options={opt(dir.contacts.filter((x) => x.email), "+ contact")} /></div>
            </div>
          </div>
          <div className="tr-f"><span>From anyone at</span><Select searchable value={c.from_company_id ?? ""} onChange={(v) => setC({ from_company_id: v || null })} options={opt(dir.companies, "Any company")} /></div>
          <div className="tr-f"><span>Sent to mailbox</span><Select value={c.mailbox ?? ""} onChange={(v) => setC({ mailbox: v })} options={[{ value: "", label: "Any mailbox" }, ...boxes.map((b) => ({ value: b.address, label: b.label ? `${b.label} · ${b.address}` : b.address }))]} /></div>
          <label><span>Subject contains</span><input className="td-in" value={c.subject_contains ?? ""} placeholder="Invoice" onChange={(e) => setC({ subject_contains: e.target.value })} /></label>
          <label><span>Subject matches (regex)</span><input className="td-in tr-mono" value={c.subject_regex ?? ""} placeholder="^(RE: )?Ticket #\d+" onChange={(e) => setC({ subject_regex: e.target.value })} /></label>
          <label><span>Text contains</span><input className="td-in" value={c.body_contains ?? ""} placeholder="urgent" onChange={(e) => setC({ body_contains: e.target.value })} /></label>
        </div>
      </div>
      <div className="tr-block">
        <div className="tr-block-h"><span className="tr-step">2</span><b>Then</b></div>
        <div className="tr-actions">
          {([["create", "Open a new ticket", "plus"], ["append", "Add it to a ticket", "link"], ["ignore", "Ignore it", "ban"]] as const).map(([k, l, ic]) => (
            <button key={k} type="button" className={r.action === k ? "is-on" : ""} onClick={() => setR({ ...r, action: k })}><TkIco d={ic} />{l}</button>
          ))}
        </div>
        {r.action === "create" && (
          <div className="tr-grid">
            <div className="tr-f"><span>Type</span><Select value={r.set.type ?? ""} onChange={(v) => setS({ type: v || null })} options={[{ value: "", label: "No type" }, ...types.map((x) => ({ value: x, label: x }))]} /></div>
            <div className="tr-f"><span>Priority</span><Select value={r.set.priority ?? ""} onChange={(v) => setS({ priority: (v || null) as TaskPriority | null })} options={[{ value: "", label: "Normal" }, ...TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))]} /></div>
            <div className="tr-f"><span>Owner</span><Select searchable value={r.set.assignee_id ?? ""} onChange={(v) => setS({ assignee_id: v || null })} options={opt(dir.people, "Unassigned")} /></div>
            <div className="tr-f"><span>Team</span><Select value={r.set.team ?? ""} onChange={(v) => setS({ team: v || null })} options={[{ value: "", label: "Any team" }, ...departments.map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) }))]} /></div>
            <div className="tr-f"><span>Client</span><Select searchable value={r.set.client_id ?? ""} onChange={(v) => setS({ client_id: v || null })} options={opt(dir.clients, "From the sender")} /></div>
            <label><span>Tags</span><input className="td-in" value={(r.set.tags ?? []).join(", ")} placeholder="support, acme" onChange={(e) => setS({ tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
          </div>
        )}
        {r.action === "append" && (
          <button type="button" className="tr-target" onClick={(e) => setPick(e.currentTarget.getBoundingClientRect())}>
            <TkIco d="link" />{target ? <><b>{ticketRef(target)}</b>{plain(target.title)}</> : "Pick the ticket…"}
          </button>
        )}
      </div>
      <div className={`tr-preview ${hits.length ? "is-hit" : ""}`}>
        <TkIco d="inbox" />
        {hits.length ? <span><b>{hits.length}</b> e-mail{hits.length === 1 ? "" : "s"} in the Inbox match{hits.length === 1 ? "es" : ""}: {hits.slice(0, 3).map((m) => `“${m.subject || "(no subject)"}”`).join(", ")}{hits.length > 3 ? "…" : ""}</span>
          : <span>No e-mail in the Inbox matches yet. Rules run on new mail as it arrives.</span>}
      </div>
      <div className="tr-foot">
        <button type="button" className="td-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="td-primary" disabled={busy || !r.name.trim() || (r.action === "append" && !r.targetTicketId)}
          onClick={async () => { setBusy(true); await onSave(live); setBusy(false); }}>{busy ? "Saving…" : r.id ? "Save rule" : "Create rule"}</button>
      </div>
      {pick && (
        <Pop anchor={pick} onClose={() => setPick(null)} width={340}>
          <TicketPick tickets={tickets} onPick={(t) => { setPick(null); setR({ ...r, targetTicketId: t.id }); }} />
        </Pop>
      )}
    </div>
  );
}
function DeskSettings({ dir, types, tickets, inbox, start, prefill, mail, onClose, onConnect }: {
  dir: Directory; types: string[]; tickets: Ticket[]; inbox: MailMsg[];
  start?: SettingsTab; prefill?: Partial<MailRule> | null; mail: OutlookMailStatus | null;
  onClose: () => void; onConnect: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(start ?? "rules");
  const [rules, setRules] = useState<MailRule[] | null>(null);
  const [boxes, setBoxes] = useState<Mailbox[] | null>(null);
  const [sla, setSla] = useState<SlaMap | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState<MailRule | null>(prefill ? blankRule(0, prefill) : null);
  const [err, setErr] = useState<string | null>(null);
  const [newBox, setNewBox] = useState({ address: "", label: "" });
  const reload = useCallback(async () => {
    const [r, b, s] = await Promise.all([loadMailRules(), loadMailboxes(), loadSla()]);
    setMissing(r === null || b === null || !s.ready);
    setRules(r ?? []); setBoxes(b ?? []); setSla(s.sla);
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !editing) onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose, editing]);
  const run = async (p: Promise<string | null>) => { const e = await p; setErr(e); if (!e) await reload(); return e; };
  const myInbox = (boxes ?? []).find((b) => b.kind === "personal" && b.ownerId === dir.me);
  const move = async (i: number, d: number) => {
    const list = [...(rules ?? [])]; const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setRules(list);
    await Promise.all(list.map((x, k) => saveMailRule({ ...x, sort: k })));
    reload();
  };
  return createPortal(
    <div className="td-back tm-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !editing) onClose(); }}>
      <div className="ts" role="dialog" aria-label="Desk settings">
        <header className="ts-h">
          <span className="ts-ico"><TkIco d="gear" /></span>
          <div><span className="hs-eyebrow">Ticket desk</span><h3>Mail &amp; service levels</h3></div>
          <span className="td-spacer" />
          <button type="button" className="td-x" onClick={onClose} aria-label="Close"><TkIco d="x" /></button>
        </header>
        <nav className="ts-tabs">
          {([["rules", "Mail rules", "filter"], ["mailboxes", "Mailboxes", "inbox"], ["sla", "Service levels", "bolt"]] as const).map(([k, l, ic]) => (
            <button key={k} type="button" className={tab === k ? "is-on" : ""} onClick={() => { setTab(k); setEditing(null); }}><TkIco d={ic} />{l}
              {k === "rules" && rules ? <i>{rules.length}</i> : k === "mailboxes" && boxes ? <i>{boxes.length}</i> : null}</button>
          ))}
        </nav>
        <div className="ts-body">
          {missing && <p className="tk-note">{MAIL_SQL}</p>}
          {mail && (!mail.connected || !mail.mail) && (
            <div className="ts-connect">
              <TkIco d="mail" />
              <div><b>{mail.connected ? "Your Outlook can't read or send mail yet" : "Connect your Outlook"}</b>
                <span>The desk reads mailboxes and sends replies through your Microsoft 365 account. Connect once with mail permission.</span></div>
              <button type="button" className="td-primary" onClick={onConnect}>Connect with mail</button>
            </div>
          )}
          {err && <p className="tk-err">{err}</p>}

          {tab === "rules" && (editing ? (
            <RuleEditor rule={editing} dir={dir} types={types} tickets={tickets} boxes={boxes ?? []} inbox={inbox}
              onCancel={() => setEditing(null)}
              onSave={async (r) => { const e = await run(saveMailRule({ ...r, sort: r.id ? r.sort : (rules?.length ?? 0) })); if (!e) setEditing(null); }} />
          ) : (
            <>
              <p className="ts-lead">New mail runs through these rules from top to bottom; the first one that matches decides. Replies to a ticket (its <code>[T-1042]</code> in the subject, or the same Outlook conversation) always go back to that ticket.</p>
              <div className="ts-list">
                {!rules ? <div className="hs-skel" /> : !rules.length ? (
                  <div className="tk-empty"><span className="tk-empty-ico"><TkIco d="filter" /></span><b>No rules yet</b><span>E-mail that matches nothing waits in the Inbox for someone to sort it.</span></div>
                ) : rules.map((r, i) => {
                  const sm = ruleSummary(r, dir, tickets);
                  return (
                    <div key={r.id} className={`ts-rule ${r.active ? "" : "is-off"}`} style={{ ["--i" as string]: i } as React.CSSProperties}>
                      <span className="ts-rule-n">{i + 1}</span>
                      <div className="ts-rule-main" onClick={() => setEditing(r)} role="button" tabIndex={0}>
                        <b>{r.name}</b>
                        <span><em>When</em> {sm.when}</span>
                        <span><em>Then</em> {sm.then}</span>
                        <small>{r.hits ? `Used ${r.hits} time${r.hits === 1 ? "" : "s"}${r.lastHitAt ? ` · last ${ago(r.lastHitAt)}` : ""}` : "Not used yet"}</small>
                      </div>
                      <div className="ts-rule-side">
                        <button type="button" role="switch" aria-checked={r.active} className={`ts-switch ${r.active ? "is-on" : ""}`} onClick={() => run(saveMailRule({ ...r, active: !r.active }))} title={r.active ? "On" : "Off"}><i /></button>
                        <button type="button" className="tk-icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><TkIco d="up" /></button>
                        <button type="button" className="tk-icon-btn" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><TkIco d="down" /></button>
                        <button type="button" className="tk-icon-btn is-del" onClick={() => run(deleteMailRule(r.id))} aria-label="Delete rule"><TkIco d="trash" /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button type="button" className="tk-new ts-add" onClick={() => setEditing(blankRule(rules?.length ?? 0))}><TkIco d="plus" />New rule</button>
            </>
          ))}

          {tab === "mailboxes" && (
            <>
              <p className="ts-lead">The desk reads the inboxes listed here every few minutes while someone has the home page open (or on a schedule, see 19_ticket_mail.sql). Shared mailboxes need you to have access to them in Outlook.</p>
              <div className={`ts-mine ${myInbox ? "is-on" : ""}`}>
                <TkIco d="user" />
                <div><b>My own inbox{mail?.email ? ` · ${mail.email}` : ""}</b>
                  <span>{myInbox ? (myInbox.storeAll ? "Every e-mail lands in the desk's Inbox." : "Only replies to tickets and mail that matches a rule come in — the rest stays private.") : "Off — your personal mail stays out of the desk."}</span></div>
                {myInbox && (
                  <label className="ts-check"><input type="checkbox" checked={myInbox.storeAll} onChange={() => run(saveMailbox({ ...myInbox, storeAll: !myInbox.storeAll }))} />Bring in everything</label>
                )}
                <button type="button" role="switch" aria-checked={!!myInbox} className={`ts-switch ${myInbox ? "is-on" : ""}`}
                  onClick={() => myInbox ? run(deleteMailbox(myInbox.id)) : run(saveMailbox({ address: mail?.email || dir.people.find((p) => p.id === dir.me)?.email || "", kind: "personal", ownerId: dir.me, label: "My inbox", canSend: true }))}><i /></button>
              </div>
              <div className="ts-list">
                {(boxes ?? []).filter((b) => b.kind === "shared").map((b, i) => (
                  <div key={b.id} className={`ts-box ${b.active ? "" : "is-off"}`} style={{ ["--i" as string]: i } as React.CSSProperties}>
                    <span className="ts-box-ico"><TkIco d="inbox" /></span>
                    <div className="ts-box-main">
                      <b>{b.label || b.address}</b>
                      <span>{b.address}{b.lastSyncAt ? ` · read ${ago(b.lastSyncAt)}` : " · not read yet"}</span>
                      {b.lastError && <small className="ts-box-err">{b.lastError.slice(0, 160)}</small>}
                    </div>
                    <label className="ts-check"><input type="checkbox" checked={b.canSend} onChange={() => run(saveMailbox({ ...b, canSend: !b.canSend }))} />Reply from it</label>
                    <label className="ts-check"><input type="radio" name="tk-default-from" checked={b.isDefaultFrom} onChange={() => run(saveMailbox({ ...b, isDefaultFrom: true }))} />Default “From”</label>
                    <button type="button" role="switch" aria-checked={b.active} className={`ts-switch ${b.active ? "is-on" : ""}`} onClick={() => run(saveMailbox({ ...b, active: !b.active }))}><i /></button>
                    <button type="button" className="tk-icon-btn is-del" onClick={() => run(deleteMailbox(b.id))} aria-label="Remove mailbox"><TkIco d="trash" /></button>
                  </div>
                ))}
              </div>
              <div className="ts-newbox">
                <input className="td-in" value={newBox.address} placeholder="support@yourcompany.com" type="email" onChange={(e) => setNewBox({ ...newBox, address: e.target.value })} />
                <input className="td-in" value={newBox.label} placeholder="Label (Support, Consultancy…)" onChange={(e) => setNewBox({ ...newBox, label: e.target.value })} />
                <button type="button" className="tk-new" disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newBox.address.trim())}
                  onClick={async () => { const e = await run(saveMailbox({ address: newBox.address, label: newBox.label, kind: "shared", isDefaultFrom: !(boxes ?? []).some((b) => b.isDefaultFrom) })); if (!e) setNewBox({ address: "", label: "" }); }}>
                  <TkIco d="plus" />Add shared mailbox</button>
              </div>
            </>
          )}

          {tab === "sla" && sla && (
            <>
              <p className="ts-lead">How fast a ticket should get its first reply to the requester and be resolved, by priority. Tickets show the time left — amber in the last quarter, red when late.</p>
              <div className="ts-sla">
                <div className="ts-sla-h"><span>Priority</span><span>First reply within</span><span>Resolved within</span></div>
                {TASK_PRIORITIES.map((p) => (
                  <SlaRow key={p} p={p} v={sla[p]} onSave={(v) => run(saveSla(p, v))} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
function SlaRow({ p, v, onSave }: { p: TaskPriority; v: SlaTarget; onSave: (v: SlaTarget) => void }) {
  const toH = (m: number | null) => (m == null ? "" : String(+(m / 60).toFixed(2)));
  const [fr, setFr] = useState(toH(v.firstResponse));
  const [res, setRes] = useState(toH(v.resolution));
  useEffect(() => { setFr(toH(v.firstResponse)); setRes(toH(v.resolution)); }, [v.firstResponse, v.resolution]);
  const commit = () => {
    const m = (x: string) => (x.trim() === "" ? null : Math.max(1, Math.round(Number(x.replace(",", ".")) * 60)) || null);
    const next = { firstResponse: m(fr), resolution: m(res) };
    if (next.firstResponse !== v.firstResponse || next.resolution !== v.resolution) onSave(next);
  };
  return (
    <div className="ts-sla-r">
      <span className={`tk-prio is-${p}`}><FlagIcon />{PRIORITY_LABEL[p]}</span>
      <label><input className="td-in" inputMode="decimal" value={fr} placeholder="No target" onChange={(e) => setFr(e.target.value)} onBlur={commit} /><em>hours</em></label>
      <label><input className="td-in" inputMode="decimal" value={res} placeholder="No target" onChange={(e) => setRes(e.target.value)} onBlur={commit} /><em>hours</em></label>
    </div>
  );
}
