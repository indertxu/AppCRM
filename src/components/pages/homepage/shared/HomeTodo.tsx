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
 * Only whoever created a task can delete it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../api/supabase";
import DatePicker from "../../../framework/DatePicker";
import TimePicker from "../../../framework/TimePicker";
import {
  loadMyTasks, loadDelegatedTasks, toggleTask, deleteTask, canDeleteTask, addPersonalTask, updateTaskMeta, loadTaskUpdates, addTaskUpdate,
  TASK_PRIORITIES, TASK_STATUSES,
  type MyTask, type DelegatedTask, type TaskPriority, type TaskStatus, type TaskKind, type TaskUpdate,
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
  const [adding, setAdding] = useState(false);
  // tasks I made and gave to others
  const [delegated, setDelegated] = useState<DelegatedTask[]>([]);
  const [meId, setMeId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => { if (alive) setMeId(data?.session?.user?.id ?? null); });
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
  }, []);

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
    const kind: TaskKind = tab === "process" ? "process" : "quick";
    const { task, error } = await addPersonalTask({ title, description: draftDesc, kind, priority: draftPrio, due_at: draftDue ? `${draftDue}T18:00:00` : null });
    setAdding(false);
    if (error || !task) { setErr(error ?? "Couldn't add the task."); return; }
    setTasks((xs) => [task, ...xs]);
    setDraft(""); setDraftDesc(""); setDraftPrio("normal"); setDraftDue("");
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
          <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder={tab === "process" ? "Name a process… (longer work, with progress)" : "Name a quick task…"} aria-label="Task name" />
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
        </div>
      )}
      {err && <p className="hs-err" role="alert">{err} <button onClick={() => setErr(null)} aria-label="Dismiss">×</button></p>}

      {loading ? (
        <div className="hs-skel hs-skel-tall" />
      ) : tab === "quick" ? (
        groups.length === 0 ? (
          <div className="hs-clear">
            <span className="hs-clear-art" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" /></svg></span>
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
            <span className="hs-clear-art is-proc" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 18h4l3-12 3 8h6" /></svg></span>
            <b>No processes running</b>
            <small>For longer work: give it a status and a %, and post notes on where it's at.</small>
          </div>
        ) : (
          <ul className="hs-task-groups hs-procs">{processes.map((t, i) => card(t, i))}</ul>
        )
      ) : tab === "delegated" ? (
        delegated.length === 0 ? (
          <div className="hs-clear">
            <span className="hs-clear-art is-sent" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-3-7z" /></svg></span>
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
        <p className="hs-empty">Nothing ticked off yet.</p>
      ) : (
        <ul className="hs-task-done-list">{done.map((t, i) => row(t, i))}</ul>
      )}

      {openTask && createPortal(
        <TaskPanel task={openTask} onClose={() => setOpenId(null)}
          onChange={(patch) => patchLocal(openTask.id, patch)}
          onOpenDeal={openTask.tracking_id ? () => nav(`/sales?tracking=${openTask.tracking_id}`) : undefined}
          onDelete={canDeleteTask(openTask, meId) ? () => remove(openTask) : undefined} />,
        document.body,
      )}
    </section>
  );
}

/* ============================ Task panel ============================
   Everything about one task: name, description, kind, priority, due date,
   and — for where it's at — status, % done and a timeline of progress notes.
   Used here and on the deal page in Sales. */
export function TaskPanel({ task, onClose, onChange, onOpenDeal, onDelete }: {
  task: MyTask; onClose: () => void; onChange: (patch: Partial<MyTask>) => void;
  /** Click on the deal chip (left out when you're already on the deal). */
  onOpenDeal?: () => void;
  onDelete?: () => void | Promise<void>;
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
  const dirty = status !== task.status || progress !== task.progress || !!note.trim();

  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => { if (alive) setMeId(data?.session?.user?.id ?? null); });
    loadTaskUpdates(task.id).then(async (u) => {
      if (!alive) return;
      setUpdates(u);
      const ids = [...new Set(u.map((x) => x.author_id).filter(Boolean))] as string[];
      if (ids.length) {
        const { data } = await supabase.from("profiles").select("id, first_name, last_name").in("id", ids);
        if (alive) setNames(Object.fromEntries(((data ?? []) as any[]).map((p) => [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || "—"])));
      }
    });
    // Capture phase: Escape closes this panel only, not a list it was opened from.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => { alive = false; window.removeEventListener("keydown", key, true); };
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const pickProgress = (v: number) => {
    setProgress(v);
    if (v === 100) setStatus("done");
    else if (v === 0) { if (status !== "blocked") setStatus("todo"); }
    else if (status === "done" || status === "todo") setStatus("in_progress");
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

  return (
    <div className="htp-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`htp is-${status}`} role="dialog" aria-modal="true" aria-label="Task">
        <header className={`htp-head is-p-${task.priority}`}>
          <div className="htp-head-top">
            <div className="htp-kind" role="radiogroup" aria-label="Kind of task">
              {(["quick", "process"] as TaskKind[]).map((k) => (
                <button key={k} role="radio" aria-checked={task.kind === k} className={task.kind === k ? "is-on" : ""} onClick={() => task.kind !== k && meta({ kind: k })}>
                  {k === "quick" ? "Quick task" : "Process"}
                </button>
              ))}
            </div>
            <button className="htp-x" onClick={onClose} aria-label="Close">×</button>
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
            {task.assigned && <span className="hs-task-tag">@ you</span>}
          </div>
        </header>

        <div className="htp-body">
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
          <div className="htp-row is-top">
            <span className="htp-lbl">Deadline</span>
            <div className="htp-deadline">
              <div className="htp-due">
                <DatePicker value={dayOf(task.due_at) ?? ""} onChange={(d) => meta({ due_at: d ? `${d}T${timeOf(task.due_at) ?? "18:00"}:00` : null })} placeholder="No deadline" />
                {task.due_at && (
                  <TimePicker value={timeOf(task.due_at) ?? "18:00"} ariaLabel="Due time"
                    onChange={(tm) => meta({ due_at: `${dayOf(task.due_at)}T${tm || "18:00"}:00` })} />
                )}
              </div>
              {task.due_at && (() => {
                const d = dueInfo(task.due_at, isoDay(new Date()));
                return d && (
                  <div className={`htp-due-say is-${task.done ? "done" : d.tone}`}>
                    <CalIcon /><b>{d.day}{d.time ? ` · ${d.time}` : ""}</b><span>{task.done ? "done" : d.rel}</span>
                    <button className="htp-clear" onClick={() => meta({ due_at: null })}>Remove</button>
                  </div>
                );
              })()}
            </div>
          </div>

          <div className="htp-where">
            <span className="htp-lbl">Where it's at</span>
            <div className="htp-status" role="radiogroup" aria-label="Status">
              {TASK_STATUSES.map((s) => (
                <button key={s} role="radio" aria-checked={status === s} className={`is-${s} ${status === s ? "is-on" : ""}`} onClick={() => pickStatus(s)}>
                  <i />{STATUS_LABEL[s]}
                </button>
              ))}
            </div>
            <div className="htp-progress" style={{ ["--pct" as string]: `${progress}%` } as React.CSSProperties}>
              <b>{progress}<small>%</small></b>
              <input type="range" min={0} max={100} step={5} value={progress} onChange={(e) => pickProgress(Number(e.target.value))} aria-label="Percent done" />
              <div className="htp-steps">
                {[0, 25, 50, 75, 100].map((v) => <button key={v} className={progress === v ? "is-on" : ""} onClick={() => pickProgress(v)}>{v}%</button>)}
              </div>
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

          {onDelete && (
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
          )}
        </div>
      </div>
    </div>
  );
}