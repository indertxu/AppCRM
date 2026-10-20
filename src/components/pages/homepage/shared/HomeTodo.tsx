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
/** "@[Name](employee:id)" → a bold "@Name". */
function Rich({ text }: { text: string }) {
  const parts = (text ?? "").split(/(@\[[^\]]+\]\([^)]+\))/g);
  return <>{parts.map((p, i) => { const m = /^@\[([^\]]+)\]/.exec(p); return m ? <b key={i}>@{m[1]}</b> : <span key={i}>{p}</span>; })}</>;
}
const plain = (t: string) => (t ?? "").replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
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
          <p className="hs-proc-note">“{plain(t.lastNote.body)}” <small>· {ago(t.lastNote.at)}</small></p>
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
      {t.lastNote && <p className="hs-proc-note">“{plain(t.lastNote.body)}” <small>· {ago(t.lastNote.at)}</small></p>}
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
                  {u.body && <p>{plain(u.body)}</p>}
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
                          {t.description?.trim() && <span className="htw-item-desc">{plain(t.description)}</span>}
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

  const reload = useCallback(() => { loadTickets().then(setData).catch(() => setData({ tickets: [], ready: false, ownedDeals: [] })); }, []);
  useEffect(() => {
    reload();
    loadDirectory().then(setDir).catch(() => {});
    loadTicketTypes().then(setTypes).catch(() => {});
    const on = () => reload();
    const openOne = (e: Event) => { const id = (e as CustomEvent).detail; if (typeof id === "string") setOpenId(id); };
    window.addEventListener(TICKETS_EVENT, on);
    window.addEventListener("open-ticket", openOne);
    return () => { window.removeEventListener(TICKETS_EVENT, on); window.removeEventListener("open-ticket", openOne); };
  }, [reload]);

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
  const shown = all.filter((t) => inTab(t, tab) && inView(t) && matches(t) && (!fPrio || t.priority === fPrio) && (!fType || t.type === fType));
  const rank: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const sorted = [...shown].sort((a, b) => {
    if (sort === "priority") return rank[a.priority] - rank[b.priority] || (a.due ?? "9").localeCompare(b.due ?? "9");
    if (sort === "updated") return (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
    if (sort === "number") return (b.no ?? 0) - (a.no ?? 0);
    return (a.due ?? "9999").localeCompare(b.due ?? "9999") || rank[a.priority] - rank[b.priority];
  });
  const counts = Object.fromEntries(DESK_TABS.map((x) => [x.key, all.filter((t) => isActive(t.stage) && inTab(t, x.key)).length])) as Record<DeskTab, number>;
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

  const row = (t: Ticket, i: number) => {
    const link = linkLabel(t, dir);
    const late = isActive(t.stage) && groupOf(t, today) === "overdue";
    return (
      <div key={t.id} className={`tk-row is-p-${t.priority} ${late ? "is-late" : ""} ${isActive(t.stage) ? "" : "is-done"}`} style={{ ["--i" as string]: Math.min(i, 12) } as React.CSSProperties}
        onClick={() => setOpenId(t.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(t.id); }}>
        <span className="tk-row-bar" aria-hidden="true" />
        <div className="tk-row-main">
          <div className="tk-row-top">
            <span className="tk-ref">{ticketRef(t)}</span>
            {t.type && <span className="tk-type">{t.type}</span>}
            {t.priority === "urgent" || t.priority === "high" ? <span className={`tk-prio is-${t.priority}`}><FlagIcon />{PRIORITY_LABEL[t.priority]}</span> : null}
            {t.source === "email" && <span className="tk-src" title="Came in by e-mail"><TkIco d="mail" /></span>}
          </div>
          <span className="tk-row-title">{plain(t.title)}</span>
          <div className="tk-row-meta">
            {link && <span className="tk-link"><TkIco d={link.icon} />{link.text}</span>}
            <DueChip dueAt={t.due} todayIso={today} done={!isActive(t.stage)} />
            {t.kind === "process" && t.progress > 0 && <span className="tk-pct"><i style={{ width: `${t.progress}%` }} />{t.progress}%</span>}
          </div>
        </div>
        <div className="tk-row-side" onClick={(e) => e.stopPropagation()}>
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
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tickets…" />
        {q && <button type="button" onClick={() => setQ("")} aria-label="Clear"><TkIco d="x" /></button>}
      </div>
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
      <div className="tk-th"><span>Ticket</span><span>Linked to</span><span>Type</span><span>Priority</span><span>Due</span><span>Owner</span><span>Stage</span></div>
      {sorted.map((t, i) => {
        const link = linkLabel(t, dir);
        return (
          <div key={t.id} className={`tk-tr is-p-${t.priority} ${openId === t.id ? "is-sel" : ""}`} style={{ ["--i" as string]: Math.min(i, 14) } as React.CSSProperties} onClick={() => setOpenId(t.id)}>
            <span className="tk-td-title"><em className="tk-ref">{ticketRef(t)}</em><b>{plain(t.title)}</b></span>
            <span className="tk-td-muted">{link ? <span className="tk-link"><TkIco d={link.icon} />{link.text}</span> : "—"}</span>
            <span className="tk-td-muted">{t.type ?? "—"}</span>
            <span><span className={`tk-prio is-${t.priority}`}><FlagIcon />{PRIORITY_LABEL[t.priority]}</span></span>
            <span>{t.due ? <DueChip dueAt={t.due} todayIso={today} done={!isActive(t.stage)} /> : <i className="tk-td-muted">—</i>}</span>
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

  const menuT = menu ? all.find((t) => t.id === menu.id) : null;
  const overlays = (
    <>
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
        <TicketDrawer ticket={openT} draft={creating} dir={dir} types={types} ready={ready}
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
          <button type="button" className="tk-new" onClick={() => setCreating({ assignee: me })}><TkIco d="plus" />New ticket</button>
          <button type="button" className="tk-icon-btn" onClick={onClose} aria-label="Close"><TkIco d="x" /></button>
        </header>
        <div className="tk-full-body">
          <nav className="tk-full-nav">
            <span className="tk-nav-k">Views</span>
            {DESK_TABS.map((x) => (
              <button key={x.key} type="button" className={tab === x.key ? "is-on" : ""} onClick={() => setTab(x.key)}>{x.label}<i>{counts[x.key]}</i></button>
            ))}
            <span className="tk-nav-k">By stage</span>
            {TICKET_STAGES.map((s) => {
              const n = all.filter((t) => inTab(t, tab) && t.stage === s.key).length;
              return <span key={s.key} className="tk-nav-stat"><span className={`tk-dot is-${s.key}`} />{s.label}<i>{n}</i></span>;
            })}
          </nav>
          <div className="tk-full-main">
            {filters}
            {err && <p className="tk-err">{err}</p>}
            {!ready && data && <p className="tk-note">{NEEDS_SQL} Until then your tasks show here with their status.</p>}
            {list}
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
          <h2 className="hs-title"><span className="hs-count">{counts[tab]}</span> open{lateCount > 0 && <span className="hs-late-pill">{lateCount} late</span>}</h2>
        </div>
        <div className="tk-head-btns">
          <button type="button" className="tk-new is-sm" onClick={() => setCreating({ assignee: me })} title="New ticket with all the details"><TkIco d="plus" />New</button>
          <button type="button" className="tk-icon-btn" onClick={() => setExpanded(true)} title="Open the full ticket desk" aria-label="Full view"><TkIco d="expand" /></button>
        </div>
      </header>
      <div className="tk-tabs" role="tablist">
        {DESK_TABS.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} className={tab === x.key ? "is-on" : ""} onClick={() => setTab(x.key)}>
            {x.label}{counts[x.key] > 0 && <i>{counts[x.key]}</i>}
          </button>
        ))}
      </div>
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

export function TicketDrawer({ ticket, draft, dir, types, ready, onClose, onCreated, onLocal, onTypes }: {
  ticket: Ticket | null;
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

  useEffect(() => { if (ticket) loadTicketThread(ticket.id).then(setThread).catch(() => setThread({ posts: [], events: [] })); }, [ticket?.id]);
  useEffect(() => { grow(titleRef.current); }, [t.title]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !watchAdd) onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose, watchAdd]);

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
  const send = async () => {
    if (!reply.trim() || !ticket || busy) return;
    setBusy(true);
    const res = await postToTicket(t, reply, mode, ready);
    setBusy(false);
    if (res.error || !res.post) { setErr(res.error); return; }
    setReply(""); setErr(null);
    loadTicketThread(t.id).then(setThread).catch(() => {});
  };
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
  ].sort((a, b) => a.at.localeCompare(b.at));
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
        </header>

        <div className="td-body">
          <div className="td-main">
            <section className="td-sec">
              <span className="td-k">Description</span>
              <textarea className="td-desc" value={t.description} placeholder="Add the details: what's asked, by whom, what done looks like…"
                onChange={(e) => { setT({ ...t, description: e.target.value }); grow(e.target); }} ref={(el) => grow(el)}
                onBlur={() => { if (!creatingMode && ticket && t.description !== ticket.description) set({ description: t.description }); }} />
            </section>

            {t.checklist.length > 0 && (
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
                <span className="td-k">Conversation &amp; activity</span>
                <div className={`td-composer is-${mode}`}>
                  <div className="td-composer-tabs">
                    <button type="button" className={mode === "internal" ? "is-on" : ""} onClick={() => setMode("internal")}><TkIco d="lock" />Internal note</button>
                    <button type="button" className={mode === "reply" ? "is-on" : ""} onClick={() => setMode("reply")}><TkIco d="mail" />Reply to requester</button>
                  </div>
                  <textarea value={reply} onChange={(e) => { setReply(e.target.value); grow(e.target); }} rows={2}
                    placeholder={mode === "internal" ? "Only your team sees this…" : `Write to ${t.requesterName || t.requesterEmail || "the requester"}… (e-mail sending comes with Outlook)`}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
                  <div className="td-composer-foot">
                    <span>⌘ Enter to send</span>
                    <button type="button" className="td-send" onClick={send} disabled={!reply.trim() || busy}>{mode === "internal" ? "Add note" : "Send reply"}</button>
                  </div>
                </div>
                <div className="td-thread">
                  {!thread ? <div className="hs-skel" /> : !items.length ? <p className="td-none">No notes yet. Updates and changes will show up here.</p> : [...items].reverse().map((it) => it.k === "post" ? (
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
