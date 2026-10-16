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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../api/supabase";
import DatePicker from "../../../framework/DatePicker";
import TimePicker from "../../../framework/TimePicker";
import {
  loadMyTasks, loadDelegatedTasks, toggleTask, deleteTask, canDeleteTask, addPersonalTask, updateTaskMeta, loadTaskUpdates, addTaskUpdate,
  loadTaskTemplates, fromTemplate, newStepId,
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