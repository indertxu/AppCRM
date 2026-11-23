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
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deptName, goToSection } from "../../../framework/pageAccess";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../../api/supabase";
import { publicOrigin } from "../../../api/appUrl";
import DatePicker from "../../../framework/DatePicker";
import TimePicker from "../../../framework/TimePicker";
import Select from "../../../framework/Select";
import { PicOr } from "../../../framework/avatars";
import { BRANDS } from "../../settings/integrations/brandIcons";
import { NextCube } from "../../../login/LoginPage";
import ActionsMenu, { AM_ICON, type ActionItem } from "../../../framework/ActionsMenu";
import {
  loadMyTasks, loadDelegatedTasks, toggleTask, deleteTask, canDeleteTask, addPersonalTask, updateTaskMeta, loadTaskUpdates, addTaskUpdate,
  loadTaskTemplates, fromTemplate, newStepId, allRows, addAssignee, removeAssignee,
  TASK_PRIORITIES, TASK_STATUSES,
  type MyTask, type DelegatedTask, type TaskPriority, type TaskStatus, type TaskKind, type TaskUpdate, type TaskTemplate, type TaskStep,
} from "../../sales/sales/salesApi";
import { isoDay } from "./HomeCalendar";
import { globalSearch, globalSearchReady, saveContact, type Contact, type SearchHit } from "../../companies/companiesApi";
import { myConnections, sendFromAccount } from "../../../api/marketingHub";
import { listAssets, sendWhatsApp } from "../../../api/connectedAccounts";
import { outlookMailStatus, syncTicketMail, sendOutlookMail, connectOutlook, fetchMailAttachment, OUTLOOK_CONNECTION_EVENT, type OutlookMailStatus, type MailSyncResult } from "../../../api/outlookSync";
import { loadPrefs, savePref, partnerList } from "../../companies/companiesApi";
import MentionInput, { MentionText, mentionsToPlain, type MentionPerson } from "../../../framework/MentionInput";
import { ClientLogo, CompanyLogo, useClientSite } from "../../clients/ClientWorkspace";
import { SignatureManager, cleanSignature, useSignatures } from "./MailSignatures";
import { ColumnHead } from "../../../framework/ColumnHead";
import type { FCond, FField, FView } from "../../companies/CompaniesPage";
import { domainOf } from "../../clients/clientsTypes";
import { loadInactiveIds } from "../../../framework/peopleStatus";
import "./HomeShared.css";
import "./TicketsModern.css";

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
/** Who is signed in (cached from the session), for "ticked off by". */
let signedInId: string | null = null;
void supabase.auth.getSession().then(({ data }) => { signedInId = data?.session?.user?.id ?? null; }).catch(() => {});
/** A step ticked or unticked: done ones remember who did it and when. */
const tickStep = (s: TaskStep, by: string | null = signedInId): TaskStep => {
  if (s.done) { const { doneBy: _a, doneAt: _b, ...rest } = s; void _a; void _b; return { ...rest, done: false }; }
  return { ...s, done: true, doneBy: by, doneAt: new Date().toISOString() };
};
/** The people @mentioned in a text ("@[Name](employee:<id>)"). */
const MENTION_ID_RE = /@\[[^\]]*\]\(employee:([^)\s]+)\)/g;
export const mentionIds = (text: string | null | undefined) => [...new Set([...(text ?? "").matchAll(MENTION_ID_RE)].map((m) => m[1]))];
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
          <span className="hs-avatars">{t.assignees.slice(0, 3).map((a) => <i key={a.id}><PicOr name={a.name}>{initials(a.name)}</PicOr></i>)}</span>
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
          <textarea className="hs-add-name" rows={1} ref={(el) => grow(el)} value={draft} onChange={(e) => { setDraft(e.target.value.replace(/\n+/g, " ")); if (!e.target.value.trim()) setDraftFrom(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
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
  const toggleStep = (id: string) => saveSteps(steps.map((s) => (s.id === id ? tickStep(s) : s)));
  const stepsRef = useRef<HTMLOListElement>(null);
  const stepSort = useDragSort((from, to) => void meta({ checklist: moveItem(steps, from, to) }));
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
        <ol ref={stepsRef} className={stepSort.sorting ? "is-sorting" : ""}>
          {steps.map((s, i) => (
            <li key={s.id} className={`${s.done ? "is-done" : ""} ${steps.length > 1 ? "has-grip" : ""} ${stepSort.held === i ? "is-held" : ""}`} style={{ ["--i" as string]: i, ...stepSort.styleOf(i) } as React.CSSProperties}>
              {steps.length > 1 && (
                <span className="dsort-grip" role="button" tabIndex={0} onPointerDown={stepSort.grab(i, stepsRef, "li")} onKeyDown={stepSort.key(i, steps.length)}
                  title="Drag to change the order (or ↑ / ↓)" aria-label={`Move step ${i + 1}`}><GripIcon /></span>
              )}
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
        <span><i>Given to</i><b className="htp-about-who">{task.assignees.map((a) => <em key={a.id} className="htp-av"><PicOr name={a.name}>{initials(a.name)}</PicOr></em>)}{task.assignees.map((a) => a.name).join(", ")}</b></span>
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
                            {isSent(t) && <span className="hs-sent-who"><span className="hs-avatars">{t.assignees.slice(0, 3).map((a) => <i key={a.id}><PicOr name={a.name}>{initials(a.name)}</PicOr></i>)}</span><span>{t.assignees[0]?.name}{t.assignees.length > 1 ? ` +${t.assignees.length - 1}` : ""}</span></span>}
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
/** Tickets and tasks share one record; tasks read their stages in work words. */
export type ItemCat = "ticket" | "task";
const TASK_STAGE_TEXT: Record<TicketStage, { label: string; hint: string }> = {
  new: { label: "New", hint: "Just added, not looked at yet" },
  open: { label: "To do", hint: "Accepted, not started" },
  in_progress: { label: "Doing", hint: "Someone is working on it" },
  waiting: { label: "Blocked", hint: "Can't go on: waiting on someone or something" },
  resolved: { label: "Done", hint: "Finished; can be reopened" },
  closed: { label: "Archived", hint: "Done and put away" },
};
export const stageText = (s: TicketStage, cat: ItemCat = "ticket") =>
  cat === "task" ? TASK_STAGE_TEXT[s] : TICKET_STAGES.find((x) => x.key === s) ?? { label: s, hint: "" };
export const stageLabel = (s: TicketStage, cat: ItemCat = "ticket") => stageText(s, cat).label;
const ACTIVE_STAGES: TicketStage[] = ["new", "open", "in_progress", "waiting"];
const isActive = (s: TicketStage) => ACTIVE_STAGES.includes(s);
const STAGE_STATUS: Record<TicketStage, TaskStatus> = { new: "todo", open: "todo", in_progress: "in_progress", waiting: "blocked", resolved: "done", closed: "done" };
const DEFAULT_TYPES = ["Request", "Incident", "Question", "Change", "Internal"];
export const TICKET_SOURCES: Record<string, string> = { manual: "Manual", email: "E-mail", sales: "Sales", phone: "Phone", portal: "Portal", message: "Message" };
/** How a ticket (a conversation) reached us. */
export const TICKET_CHANNELS: Record<string, string> = { message: "Message", email: "E-mail", phone: "Phone call", portal: "Portal", manual: "Other" };
const CHANNEL_SOURCES = ["email", "phone", "portal", "message"];

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
  /** A ticket is a conversation (e-mail, message, call — with a client or the team); a task is work to do. */
  category: ItemCat;
}
export const ticketRef = (t: Pick<Ticket, "no" | "id"> & { category?: ItemCat }) =>
  t.category === "task" ? (t.no ? `#${t.no}` : `#${t.id.slice(0, 4).toUpperCase()}`) : (t.no ? `T-${t.no}` : `#${t.id.slice(0, 4).toUpperCase()}`);
/** Before 59_tickets_vs_tasks.sql: a conversation's channel or a requester makes it a ticket, the rest are tasks. */
const categoryOf = (r: any): ItemCat =>
  r.category === "ticket" || r.category === "task" ? r.category
    : CHANNEL_SOURCES.includes(r.source) || r.requester_email || r.requester_name || r.requester_contact_id ? "ticket" : "task";

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
      .map((x: any) => ({ id: String(x.id ?? newStepId()), text: x.text, done: !!x.done, ...(x.who ? { who: String(x.who) } : {}), ...(x.done && x.doneBy ? { doneBy: String(x.doneBy), doneAt: x.doneAt ?? null } : {}) })),
    firstResponseAt: r.first_response_at ?? null, mergedInto: r.merged_into ?? null,
    category: categoryOf(r),
  };
}

/* ---- who / what everything links to (shared with the global search) ---- */
export interface DirPerson { id: string; name: string; email: string; department: string | null; role: string | null; /** Laid off: keeps their name on old work, never offered. */ former?: boolean }
export interface Directory {
  me: string | null; myDept: string | null;
  people: DirPerson[];
  clients: { id: string; name: string }[];
  companies: { id: string; name: string; legal: string | null }[];
  deals: { id: string; name: string; companyId: string | null; status: string | null }[];
  projects: { id: string; name: string; clientId: string | null }[];
  contacts: { id: string; name: string; email: string | null; title: string | null }[];
  /**
   * true when contacts, companies and deals stay in the database (52_search_server.sql): the three lists
   * above then only hold the ones in use (asked for by ensureDirNames) and pickers search as you type.
   */
  remote?: boolean;
}
/** Fired when names were added to the shared directory: holders re-render. */
export const DIR_EVENT = "directory-names";
let dirPromise: Promise<Directory> | null = null;
export function loadDirectory(fresh = false): Promise<Directory> {
  if (dirPromise && !fresh) return dirPromise;
  dirPromise = (async () => {
    const { data: s } = await supabase.auth.getSession();
    const me = s?.session?.user?.id ?? null;
    const safe = (p: Promise<any[]>) => p.catch(() => [] as any[]);
    // contacts, companies and deals can be hundreds of thousands: with the search in the database
    // they are never downloaded whole (only the ones in use, and what you search for)
    const remote = await globalSearchReady();
    const none = Promise.resolve([] as any[]);
    const [profs, clients, companies, deals, projects, contacts, former] = await Promise.all([
      safe(allRows(() => supabase.from("profiles").select("id, first_name, last_name, email, department, role"))),
      safe(allRows(() => supabase.from("clients").select("id, name"))),
      remote ? none : safe(allRows(() => supabase.from("companies").select("id, name, legal_name"))),
      remote ? none : safe(allRows(() => supabase.from("trackings").select("id, deal_name, company_id, status"))),
      safe(allRows(() => supabase.from("projects").select("id, name, client_id"))),
      remote ? none : safe(allRows(() => supabase.from("contacts").select("id, first_name, last_name, email, job_title"))),
      loadInactiveIds().catch(() => new Set<string>()),
    ]);
    const coName = new Map<string, string>(companies.map((c: any) => [c.id, c.name]));
    const people: DirPerson[] = profs.map((p: any) => ({
      id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || (p.email ?? "").split("@")[0] || "Someone",
      email: p.email ?? "", department: p.department ?? null, role: p.role ?? null, former: former.has(p.id),
    }));
    return {
      me, myDept: people.find((p) => p.id === me)?.department ?? null,
      people: people.sort((a, b) => a.name.localeCompare(b.name)),
      clients: clients.map((c: any) => ({ id: c.id, name: c.name ?? "Client" })),
      companies: companies.map((c: any) => ({ id: c.id, name: c.name ?? "Company", legal: c.legal_name ?? null })),
      deals: deals.map((d: any) => ({ id: d.id, name: (d.deal_name ?? "").trim() || coName.get(d.company_id) || "Deal", companyId: d.company_id ?? null, status: d.status ?? null })),
      projects: projects.map((p: any) => ({ id: p.id, name: p.name ?? "Project", clientId: p.client_id ?? null })),
      contacts: contacts.map((c: any) => ({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Contact", email: c.email ?? null, title: c.job_title ?? null })),
      remote,
    };
  })();
  dirPromise.catch(() => { dirPromise = null; });
  return dirPromise;
}

/**
 * Remote directory: make sure these contacts / companies / deals (by id) and the contacts behind
 * these e-mail addresses are in it, read in a few small requests. Holders re-render (DIR_EVENT).
 */
export async function ensureDirNames(dir: Directory | null, refs: { contacts?: (string | null | undefined)[]; companies?: (string | null | undefined)[]; deals?: (string | null | undefined)[]; emails?: (string | null | undefined)[] }) {
  if (!dir?.remote) return;
  const missing = (ids: (string | null | undefined)[] | undefined, have: { id: string }[]) => {
    const known = new Set(have.map((x) => x.id));
    return [...new Set((ids ?? []).filter((x): x is string => !!x && !known.has(x)))];
  };
  const chunks = <T,>(xs: T[], n = 150) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  const ctIds = missing(refs.contacts, dir.contacts), coIds = missing(refs.companies, dir.companies), dlIds = missing(refs.deals, dir.deals);
  const knownMail = new Set(dir.contacts.map((c) => (c.email ?? "").toLowerCase()));
  const mails = [...new Set((refs.emails ?? []).map((e) => (e ?? "").trim().toLowerCase()).filter((e) => e && !knownMail.has(e)))];
  if (!ctIds.length && !coIds.length && !dlIds.length && !mails.length) return;
  const toContact = (c: any) => ({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Contact", email: c.email ?? null, title: c.position ?? null });
  const add = <T extends { id: string }>(list: T[], rows: T[]) => { const have = new Set(list.map((x) => x.id)); rows.forEach((r) => { if (!have.has(r.id)) { list.push(r); have.add(r.id); } }); };
  await Promise.all([
    ...chunks(ctIds).map((ids) => Promise.resolve(supabase.from("contacts").select("id, first_name, last_name, email, position").in("id", ids))
      .then(({ data }) => add(dir.contacts, ((data ?? []) as any[]).map(toContact)))),
    ...chunks(mails, 60).map((ms) => Promise.resolve(supabase.from("contacts").select("id, first_name, last_name, email, position").or(ms.map((m) => `email.ilike.${m.replace(/[,()]/g, "")}`).join(",")))
      .then(({ data }) => add(dir.contacts, ((data ?? []) as any[]).map(toContact)))),
    ...chunks(coIds).map((ids) => Promise.resolve(supabase.from("companies").select("id, name, legal_name").in("id", ids))
      .then(({ data }) => add(dir.companies, ((data ?? []) as any[]).map((c) => ({ id: c.id, name: c.name ?? "Company", legal: c.legal_name ?? null }))))),
    ...chunks(dlIds).map((ids) => Promise.resolve(supabase.from("trackings").select("id, deal_name, company_id, status, company:companies(name)").in("id", ids))
      .then(({ data }) => add(dir.deals, ((data ?? []) as any[]).map((d) => ({ id: d.id, name: (d.deal_name ?? "").trim() || d.company?.name || "Deal", companyId: d.company_id ?? null, status: d.status ?? null }))))),
  ]).catch(() => {});
  window.dispatchEvent(new Event(DIR_EVENT));
}
/** A picker's options asked from the database as you type (remote directory); what is found is kept in it. */
export function dirSearch(dir: Directory, kind: SearchHit["kind"], keep?: (h: SearchHit) => boolean) {
  return async (q: string) => {
    const hits = ((await globalSearch(q, [kind], 30)) ?? []).filter((h) => !keep || keep(h));
    if (kind === "contact") hits.forEach((h) => { if (!dir.contacts.some((x) => x.id === h.id)) dir.contacts.push({ id: h.id, name: h.label, email: h.email ?? null, title: null }); });
    if (kind === "company") hits.forEach((h) => { if (!dir.companies.some((x) => x.id === h.id)) dir.companies.push({ id: h.id, name: h.label, legal: null }); });
    if (kind === "deal") hits.forEach((h) => { if (!dir.deals.some((x) => x.id === h.id)) dir.deals.push({ id: h.id, name: h.label, companyId: null, status: h.status ?? null }); });
    return hits.map((h) => ({ value: h.id, label: h.label, hint: h.sub ?? undefined }));
  };
}
/** Re-render a directory holder when names arrive. */
export function useDirNames(setDir: (f: (d: Directory | null) => Directory | null) => void) {
  useEffect(() => {
    const f = () => setDir((d) => (d ? { ...d } : d));
    window.addEventListener(DIR_EVENT, f);
    return () => window.removeEventListener(DIR_EVENT, f);
  }, [setDir]);
}

/* ---- tickets: load / write ---- */
/** Fired after any ticket changes, so every desk / search on the page refreshes. */
export const TICKETS_EVENT = "tickets-changed";
const tell = () => window.dispatchEvent(new Event(TICKETS_EVENT));

export async function loadTickets(): Promise<{ tickets: Ticket[]; ready: boolean; ownedDeals: string[]; catReady: boolean }> {
  const { data: s } = await supabase.auth.getSession();
  const me = s?.session?.user?.id ?? null;
  const [rows, tags, owned] = await Promise.all([
    allRows(() => supabase.from("tracking_tasks").select("*").order("created_at", { ascending: false })).catch(() => [] as any[]),
    allRows(() => supabase.from("tracking_assignees").select("id, item_id, employee_id").eq("item_type", "task").eq("kind", "employee")).catch(() => [] as any[]),
    me ? Promise.resolve(supabase.from("tracking_employees").select("tracking_id").eq("profile_id", me).eq("is_owner", true)).then((r: any) => r?.data ?? []).catch(() => [] as any[]) : Promise.resolve([] as any[]),
  ]);
  let ready = rows.length ? "ticket_no" in rows[0] : false;
  let catReady = rows.length ? "category" in rows[0] : false;
  if (!rows.length) {
    const [a, b] = await Promise.all([
      supabase.from("tracking_tasks").select("ticket_no").limit(1),
      supabase.from("tracking_tasks").select("category").limit(1),
    ]);
    ready = !a.error; catReady = !b.error;
  }
  const byTask = new Map<string, string[]>();
  tags.forEach((a: any) => { if (!a.employee_id) return; const l = byTask.get(a.item_id) ?? []; if (!l.includes(a.employee_id)) l.push(a.employee_id); byTask.set(a.item_id, l); });
  // old resolved ones stay out of the way (the last 60 days are kept)
  const cutoff = Date.now() - 60 * 86400000;
  const tickets = rows.map((r: any) => toTicket(r, byTask.get(r.id) ?? []))
    .filter((t) => isActive(t.stage) || new Date(t.resolvedAt ?? t.updatedAt ?? t.createdAt).getTime() >= cutoff);
  return { tickets, ready, catReady, ownedDeals: owned.map((o: any) => o.tracking_id) };
}

/** One client's tickets (conversations with them — not their e-mails, not tasks): by the client, or by its company. */
export async function loadClientTickets(clientId: string, companyId?: string | null): Promise<{ tickets: Ticket[]; ready: boolean }> {
  const or = [`client_id.eq.${clientId}`, ...(companyId ? [`company_id.eq.${companyId}`] : [])].join(",");
  const { data, error } = await supabase.from("tracking_tasks").select("*").or(or).order("created_at", { ascending: false }).limit(500);
  if (error) return { tickets: [], ready: false };
  const rows = (data ?? []) as any[];
  const ready = rows.length ? "ticket_no" in rows[0] : true;
  return { tickets: rows.map((r) => toTicket(r, [])).filter((t) => t.category === "ticket" && !t.mergedInto), ready };
}

const TICKET_COLS: Record<string, string> = {
  title: "title", description: "description", priority: "priority", due: "due_at", kind: "kind", progress: "progress", checklist: "checklist",
  type: "ticket_type", assignee: "assignee_id", team: "team", requesterName: "requester_name", requesterEmail: "requester_email",
  requesterContactId: "requester_contact_id", clientId: "client_id", companyId: "company_id", projectId: "project_id",
  trackingId: "tracking_id", tags: "tags", source: "source", category: "category",
};
const NEEDS_SQL = "Run 14_tickets.sql in Supabase to turn tasks into tickets.";
export const CAT_SQL = "Run 59_tickets_vs_tasks.sql in Supabase to keep tickets and tasks apart.";
const sqlMsg = (m: string) => (/category/i.test(m) || /source_check/i.test(m) ? CAT_SQL : /column|schema cache/i.test(m) ? NEEDS_SQL : null);
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
  if (error) return /created this task/i.test(error.message) ? "Only the person who created it can move its deadline." : sqlMsg(error.message) ?? error.message;
  tell();
  return null;
}
/** byHand: a person files this (e.g. an Inbox e-mail → Create ticket) — the database keeps it even when the sender
 *  isn't in the CRM (132_ticket_mail_manual.sql; that filter is for the automatic mail sync). */
export async function createTicket(t: Partial<Ticket> & { title: string }, ready: boolean, opts: { byHand?: boolean } = {}): Promise<{ id: string | null; error: string | null }> {
  const row: any = { tracking_id: t.trackingId ?? null, phase_id: null, title: t.title.trim(), kind: t.kind ?? "quick", priority: t.priority ?? "normal", status: "todo", progress: 0, due_at: t.due ?? null };
  if (t.description?.trim()) row.description = t.description.trim();
  if (ready) {
    Object.entries(t).forEach(([k, v]) => { if (TICKET_COLS[k] && !(TICKET_COLS[k] in row) && v != null && !(Array.isArray(v) && !v.length)) row[TICKET_COLS[k]] = v; });
    row.stage = "new";
    if (!row.source) row.source = t.trackingId ? "sales" : "manual";
  }
  const ins = (r: any) => {
    const q = supabase.from("tracking_tasks").insert(r).select();
    return (opts.byHand ? q.setHeader("x-ticket-by-hand", "1") : q).maybeSingle();
  };
  let { data, error } = await ins(row);
  // the request's own mark didn't get through (a proxy refusing the extra header): file it the plain way
  if (error && opts.byHand && /fetch|network|cors/i.test(error.message)) { opts = {}; ({ data, error } = await ins(row)); }
  // before 59_tickets_vs_tasks.sql a task is still a task without the column (no channel, no requester)
  if (error && /category/i.test(error.message) && row.category === "task") {
    delete row.category;
    ({ data, error } = await ins(row));
  }
  if (!error && !data) return { id: null, error: row.source === "email" ? "The database didn't keep this ticket: its sender isn't in the CRM. Run sql/132_ticket_mail_manual.sql, or add the sender as a contact." : "Not saved." };
  if (error || !data) return { id: null, error: sqlMsg(error?.message ?? "") ?? error?.message ?? "Not saved." };
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
/** A file or picture dropped on a ticket / task (157_ticket_files.sql): with the comment it came with, and in the Files folder. */
export interface TicketFile { id: string; updateId: string | null; path: string; name: string; mime: string | null; size: number | null; by: string | null; at: string }
const TICKET_BUCKET = "ticket-files";
const toTicketFile = (r: any): TicketFile => ({ id: r.id, updateId: r.update_id ?? null, path: r.storage_path, name: r.name, mime: r.mime ?? null, size: r.size_bytes ?? null, by: r.uploaded_by ?? null, at: r.created_at });
export const isImageFile = (f: { mime: string | null; name: string }) => /^image\//.test(f.mime ?? "") || /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i.test(f.name);
export async function loadTicketThread(id: string): Promise<{ posts: TicketPost[]; events: TicketEvent[]; files: TicketFile[] }> {
  const [{ data: up }, ev, fl] = await Promise.all([
    supabase.from("tracking_task_updates").select("*").eq("task_id", id).order("created_at", { ascending: true }),
    Promise.resolve(supabase.from("ticket_events").select("*").eq("task_id", id).order("created_at", { ascending: true })).then((r: any) => (r?.error ? [] : r?.data ?? [])).catch(() => [] as any[]),
    Promise.resolve(supabase.from("ticket_files").select("*").eq("task_id", id).order("created_at", { ascending: true })).then((r: any) => (r?.error ? [] : r?.data ?? [])).catch(() => [] as any[]),
  ]);
  const files = (fl as any[]).map(toTicketFile);
  const withFiles = new Set(files.map((x) => x.updateId).filter(Boolean));
  return {
    posts: ((up ?? []) as any[]).filter((u) => (u.body ?? "").trim() || withFiles.has(u.id)).map((u) => ({ id: u.id, author: u.author_id ?? null, body: u.body ?? "", visibility: u.visibility === "reply" ? "reply" : "internal", at: u.created_at ?? new Date().toISOString() })),
    events: (ev as any[]).map((e) => ({ id: e.id, author: e.author_id ?? null, action: e.action, detail: e.detail ?? {}, at: e.created_at })),
    files,
  };
}
/** Puts files on a ticket: into the private bucket under the company's folder, one row each (with the comment they came with). */
export async function uploadTicketFiles(taskId: string, updateId: string | null, list: File[]): Promise<{ files: TicketFile[]; error: string | null }> {
  const { data: tr } = await supabase.from("tracking_tasks").select("tenant_id").eq("id", taskId).maybeSingle();
  const tenant = (tr as any)?.tenant_id;
  if (!tenant) return { files: [], error: "Could not read the ticket." };
  const out: TicketFile[] = [];
  let error: string | null = null;
  for (const f of list) {
    const safe = f.name.replace(/[^\w.\-]+/g, "_").slice(-120) || "file";
    const path = `${tenant}/${taskId}/${crypto.randomUUID()}_${safe}`;
    const up = await supabase.storage.from(TICKET_BUCKET).upload(path, f, { contentType: f.type || undefined, upsert: false });
    if (up.error) { error = /bucket|not found/i.test(up.error.message) ? "Run 157_ticket_files.sql in Supabase to keep files on tickets." : up.error.message; continue; }
    const { data, error: e } = await supabase.from("ticket_files").insert({ task_id: taskId, update_id: updateId, storage_path: path, name: f.name, mime: f.type || null, size_bytes: f.size }).select().single();
    if (e || !data) { await supabase.storage.from(TICKET_BUCKET).remove([path]); error = e?.message ?? "Not saved."; continue; }
    out.push(toTicketFile(data));
  }
  return { files: out, error };
}
/** Links that open the files for an hour (the bucket is private). */
export async function ticketFileUrls(paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data } = await supabase.storage.from(TICKET_BUCKET).createSignedUrls(paths, 3600);
  const out: Record<string, string> = {};
  (data ?? []).forEach((x: any) => { if (x?.path && x?.signedUrl) out[x.path] = x.signedUrl; });
  return out;
}
export async function removeTicketFile(f: TicketFile): Promise<string | null> {
  const { error } = await supabase.from("ticket_files").delete().eq("id", f.id);
  if (error) return error.message;
  await supabase.storage.from(TICKET_BUCKET).remove([f.path]);
  return null;
}
const fileSize = (n: number | null) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const STEP_REF_RE = /@\[([^\]]*)\]\(step:([^)\s]+)\)/g;
/** The steps a comment points at ("@S2"), by step id. */
export const stepRefsOf = (text: string | null | undefined) => [...new Set([...(text ?? "").matchAll(STEP_REF_RE)].map((m) => m[2]))];
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
export const MAIL_ROUTING_SQL = "Run 72_mail_routing.sql in Supabase for client and personal mail rules.";
const missingTable = (m?: string | null) => /relation|does not exist|schema cache|column/i.test(m ?? "");

export interface MailPerson { name: string; email: string }
export interface MailAttachment { id: string; name: string; size: number; contentType: string }
export interface MailMsg {
  id: string; ticketId: string | null; mailboxId: string | null; ruleId: string | null; direction: "in" | "out";
  fromName: string | null; fromEmail: string | null; to: MailPerson[]; cc: MailPerson[];
  subject: string; snippet: string; html: string; at: string; conversationId: string | null;
  attachments: MailAttachment[]; status: "new" | "assigned" | "ignored" | "filed"; sentBy: string | null;
  clientId: string | null; contactId: string | null;
}
const toMail = (r: any): MailMsg => ({
  id: r.id, ticketId: r.ticket_id ?? null, mailboxId: r.mailbox_id ?? null, ruleId: r.rule_id ?? null, direction: r.direction === "out" ? "out" : "in",
  fromName: r.from_name ?? null, fromEmail: r.from_email ?? null,
  to: Array.isArray(r.to_recipients) ? r.to_recipients : [], cc: Array.isArray(r.cc_recipients) ? r.cc_recipients : [],
  subject: r.subject ?? "", snippet: r.snippet ?? "", html: r.body_html ?? "", at: r.received_at ?? r.created_at,
  conversationId: r.conversation_id ?? null, attachments: Array.isArray(r.attachments) ? r.attachments : [],
  status: r.status === "assigned" || r.status === "ignored" || r.status === "filed" ? r.status : "new", sentBy: r.sent_by ?? null,
  clientId: r.client_id ?? null, contactId: r.contact_id ?? null,
});
/** A client's e-mails (in and out), newest first. null = 72_mail_routing.sql hasn't been run. */
export async function loadClientMail(clientId: string, ticketIds: string[] = []): Promise<MailMsg[] | null> {
  const ids = ticketIds.filter(Boolean).slice(0, 150);
  let q = supabase.from("ticket_mail_messages").select("*");
  q = ids.length ? q.or(`client_id.eq.${clientId},ticket_id.in.(${ids.join(",")})`) : q.eq("client_id", clientId);
  const { data, error } = await q.order("received_at", { ascending: false }).limit(500);
  if (error) return missingTable(error.message) ? null : [];
  return ((data ?? []) as any[]).map(toMail);
}
/** Files an e-mail under a client, or takes it off (null: if it was only filed, it goes back to the desk's Inbox). */
export async function setMailClient(m: Pick<MailMsg, "id" | "status">, clientId: string | null): Promise<string | null> {
  const patch: Record<string, unknown> = { client_id: clientId };
  if (!clientId && m.status === "filed") patch.status = "new";
  const { error } = await supabase.from("ticket_mail_messages").update(patch).eq("id", m.id);
  return error ? (missingTable(error.message) ? MAIL_ROUTING_SQL : error.message) : null;
}
/**
 * Mail already in the desk from these addresses / @domains goes to the client too; with `moveOut`
 * the ones still waiting in the Inbox (no ticket) leave it.
 */
export async function fileMailFrom(clientId: string, addrs: string[], moveOut: boolean): Promise<string | null> {
  for (const a of addrs) {
    const esc = a.trim().toLowerCase().replace(/[%_\\]/g, (c) => "\\" + c);
    if (!esc) continue;
    const pat = esc.startsWith("@") ? `%${esc}` : esc;
    const { error } = await supabase.from("ticket_mail_messages").update({ client_id: clientId }).is("client_id", null).ilike("from_email", pat);
    if (error) return missingTable(error.message) ? MAIL_ROUTING_SQL : error.message;
    if (moveOut) await supabase.from("ticket_mail_messages").update({ status: "filed" }).eq("client_id", clientId).eq("status", "new").is("ticket_id", null).ilike("from_email", pat);
  }
  return null;
}
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
  if (m.fromEmail) await ensureDirNames(dir, { emails: [m.fromEmail] });
  const contact = m.fromEmail ? dir.contacts.find((c) => (c.email ?? "").toLowerCase() === m.fromEmail!.toLowerCase()) : undefined;
  const res = await createTicket({
    title: (m.subject || "(no subject)").slice(0, 300), description: m.snippet, source: "email",
    requesterName: m.fromName, requesterEmail: m.fromEmail, requesterContactId: contact?.id ?? null, assignee: dir.me,
    ...extra,
  }, ready, { byHand: true });
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
  action: "create" | "append" | "ignore" | "file"; targetTicketId: string | null; set: RuleSet; hits: number; lastHitAt: string | null;
  /** desk = the ticket desk; client = mail that belongs in a client's Emails (72_mail_routing.sql) */
  scope?: "desk" | "client";
  /** someone's own rule (runs first, on their own inbox); null = the team's */
  ownerId?: string | null;
}
const toRule = (r: any): MailRule => ({
  id: r.id, name: r.name ?? "Rule", sort: r.sort ?? 0, active: r.active !== false,
  conditions: { match: "all", ...(r.conditions ?? {}) }, action: ["create", "append", "ignore", "file"].includes(r.action) ? r.action : "create",
  targetTicketId: r.target_ticket_id ?? null, set: r.set_fields ?? {}, hits: r.hits ?? 0, lastHitAt: r.last_hit_at ?? null,
  scope: r.scope === "client" ? "client" : "desk", ownerId: r.owner_id ?? null,
});
/** The desk's rules for everyone (not someone's own, not a client's). */
export const isTeamRule = (r: MailRule) => (r.scope ?? "desk") === "desk" && !r.ownerId;
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
  // the new columns only go out when used, so the team's rules keep working before 72_mail_routing.sql
  const routed = r.scope === "client" || !!r.ownerId || r.action === "file";
  if (routed) { row.scope = r.scope ?? "desk"; row.owner_id = r.ownerId ?? null; }
  const { error } = r.id ? await supabase.from("ticket_mail_rules").update(row).eq("id", r.id) : await supabase.from("ticket_mail_rules").insert(row);
  if (!error) return null;
  if (routed && /scope|owner_id|check constraint|action_check/i.test(error.message)) return MAIL_ROUTING_SQL;
  return missingTable(error.message) ? MAIL_SQL : error.message;
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

/* ---- inbox segments: your own slices of the Inbox (kept in your profile's prefs, only you see them) ---- */
export interface SegConditions extends RuleConditions {
  to_contains?: string; has_attachments?: boolean; client_id?: string | null; within_days?: number | null;
}
export interface MailSegment { id: string; name: string; color: string; conditions: SegConditions }
export const SEG_PREF = "inboxSegments";
export const SEG_COLORS = ["#2f62c4", "#12b57f", "#e08a1e", "#d9453b", "#7a4fd0", "#d6409f", "#0e9ab8", "#111815"];
export const blankSegment = (n: number): MailSegment => ({ id: "", name: "", color: SEG_COLORS[n % SEG_COLORS.length], conditions: { match: "all" } });
/** Does this e-mail belong in the segment? (no conditions = nothing) */
export function segmentMatches(c: SegConditions, m: MailMsg, dir: Directory | null): boolean {
  const lc = (x: unknown) => String(x ?? "").trim().toLowerCase();
  const from = lc(m.fromEmail), fromAll = `${lc(m.fromName)} ${from}`;
  const tests: boolean[] = [];
  if (c.from_contains) tests.push(fromAll.includes(lc(c.from_contains)));
  if (c.from_emails?.length) tests.push(c.from_emails.map(lc).some((e) => e && (from === e || (e.startsWith("@") && from.endsWith(e)) || (!e.includes("@") && from.endsWith(`@${e}`)))));
  if (c.from_contact_ids?.length) {
    const emails = (dir?.contacts ?? []).filter((x) => c.from_contact_ids!.includes(x.id)).map((x) => lc(x.email));
    tests.push(emails.includes(from));
  }
  if (c.mailbox) tests.push([...m.to, ...m.cc].some((x) => lc(x.email) === lc(c.mailbox)));
  if (c.to_contains) tests.push([...m.to, ...m.cc].some((x) => `${lc(x.name)} ${lc(x.email)}`.includes(lc(c.to_contains))));
  if (c.subject_contains) tests.push(lc(m.subject).includes(lc(c.subject_contains)));
  if (c.body_contains) tests.push(lc(m.snippet).includes(lc(c.body_contains)) || lc(m.html).includes(lc(c.body_contains)));
  if (c.has_attachments) tests.push(m.attachments.length > 0);
  if (c.client_id) tests.push(m.clientId === c.client_id);
  if (c.within_days) tests.push(Date.now() - new Date(m.at).getTime() <= c.within_days * 864e5);
  if (!tests.length) return false;
  return c.match === "any" ? tests.some(Boolean) : tests.every(Boolean);
}
export function segmentSummary(c: SegConditions, dir: Directory | null): string {
  const parts: string[] = [];
  if (c.from_emails?.length) parts.push(`from ${c.from_emails.join(" or ")}`);
  if (c.from_contains) parts.push(`sender contains “${c.from_contains}”`);
  if (c.from_contact_ids?.length) parts.push(`from ${c.from_contact_ids.map((id) => dir?.contacts.find((x) => x.id === id)?.name ?? "a contact").join(" or ")}`);
  if (c.mailbox) parts.push(`sent to ${c.mailbox}`);
  if (c.to_contains) parts.push(`to or cc contains “${c.to_contains}”`);
  if (c.subject_contains) parts.push(`subject contains “${c.subject_contains}”`);
  if (c.body_contains) parts.push(`text contains “${c.body_contains}”`);
  if (c.has_attachments) parts.push("has attachments");
  if (c.client_id) parts.push(`filed under ${dir?.clients.find((x) => x.id === c.client_id)?.name ?? "a client"}`);
  if (c.within_days) parts.push(c.within_days === 1 ? "received today" : `received in the last ${c.within_days} days`);
  return parts.length ? parts.join(c.match === "any" ? " or " : " and ") : "no conditions yet (shows nothing)";
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
  panel: "M4 4h16v16H4zM15 4v16",
  pen: "M4 20c3-1 4.5-2.5 6-5M14.5 4.5l5 5L10 19l-6 1 1-6z",
  shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  x: "M18 6 6 18M6 6l12 12",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  check: "M20 6 9 17l-5-5",
  minus: "M6 12h12",
  tag: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  archive: "M3 4h18v5H3zM5 9v11h14V9M10 13h4",
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
  more: "M5 12h.01M12 12h.01M19 12h.01",
  users: "M16 21a6 6 0 0 0-12 0M10 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21a5 5 0 0 0-4-4.9M16 5.2a4 4 0 0 1 0 7.6",
  nobody: "M14 21a6.5 6.5 0 0 0-11 0M8.5 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM16 11l5 5M21 11l-5 5",
  layers: "M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5",
  board: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
};
export const TkIco = ({ d, className }: { d: keyof typeof TK_ICON; className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={TK_ICON[d]} /></svg>
);
const AV_TONES = ["#12b57f", "#3f7fd8", "#d98324", "#8b5cf6", "#d6457a", "#0f9fb3", "#6b8e23"];
const toneOf = (id: string) => AV_TONES[[...id].reduce((s, c) => s + c.charCodeAt(0), 0) % AV_TONES.length];
/** A connected app's own mark, for "Send a notice" (brand paths: Settings › Integrations). */
function NtAppLogo({ kind }: { kind: "outlook" | "gmail" | "ionos" | "whatsapp" }) {
  if (kind === "ionos") return <span className="tdw-nt-word" aria-label="IONOS">IONOS</span>;
  if (kind === "gmail") return (
    <svg viewBox="3 6 42 36" role="img" aria-label="Gmail">
      <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75V40h7c1.657 0 3-1.343 3-3V16.2z" /><path fill="#1e88e5" d="M3 16.2l3.614 1.71L13 23.7V40H6c-1.657 0-3-1.343-3-3V16.2z" />
      <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
      <path fill="#c62828" d="M3 12.298V16.2l10 7.5V11.2L9.876 8.859A4.3 4.3 0 0 0 7.298 8C4.924 8 3 9.924 3 12.298z" /><path fill="#fbc02d" d="M45 12.298V16.2l-10 7.5V11.2l3.124-2.341A4.3 4.3 0 0 1 40.702 8C43.076 8 45 9.924 45 12.298z" />
    </svg>
  );
  const b = BRANDS[kind];
  return <svg viewBox="0 0 24 24" role="img" aria-label={b.title}><path d={b.path} fill="currentColor" /></svg>;
}
export function Avatar({ person, size = 26 }: { person: DirPerson | null | undefined; size?: number }) {
  if (!person) return <span className="tk-av is-none" style={{ width: size, height: size }} title="Unassigned"><TkIco d="user" /></span>;
  return <span className="tk-av" style={{ width: size, height: size, background: toneOf(person.id), fontSize: size * 0.4 }} title={person.name}><PicOr id={person.id}>{initials(person.name)}</PicOr></span>;
}
function StagePill({ stage, cat = "ticket", onClick }: { stage: TicketStage; cat?: ItemCat; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className={`tk-stage is-${stage}`} onClick={onClick} disabled={!onClick} title={stageText(stage, cat).hint}>
      <i />{stageLabel(stage, cat)}
    </button>
  );
}
/** A small menu floating next to what opened it. */
/** The Tickets page header's drop-down list (under its button, left-aligned). */
function HeadMenu({ at, onClose, children }: { at: DOMRect; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { const t = e.target as HTMLElement; if (ref.current && !ref.current.contains(t) && !t.closest?.(".tkp2-pick")) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); window.removeEventListener("resize", onClose); };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="tkp2-menu" role="menu" style={{ top: at.bottom + 8, left: Math.max(8, Math.min(at.left, window.innerWidth - 328)) }}>{children}</div>,
    document.body,
  );
}
function Pop({ anchor, onClose, children, width = 220 }: { anchor: DOMRect; onClose: () => void; children: React.ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const t = window.setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key);
    return () => { window.clearTimeout(t); document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);
  // under the button, lined up with its right edge; with no room on the left, with its left edge
  const vw = window.innerWidth;
  const left = anchor.right - width >= 8 ? Math.min(anchor.right - width, vw - width - 8) : Math.max(8, Math.min(anchor.left, vw - width - 8));
  const below = anchor.bottom + 6 + 320 < window.innerHeight;
  return createPortal(
    <div ref={ref} className="tk-pop" style={{ left, width, ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }) }}>{children}</div>,
    document.body,
  );
}
function PeopleMenu({ dir, value, onPick, allowNone = true, first, firstLabel = "On this task", picked, noneLabel = "Unassigned" }: {
  dir: Directory; value: string | null; onPick: (id: string | null) => void; allowNone?: boolean;
  /** People listed first, under their own heading (the people on the task). */
  first?: string[]; firstLabel?: string;
  /** Several can be picked: these show ticked and a click toggles. */
  picked?: string[]; noneLabel?: string;
}) {
  const [q, setQ] = useState("");
  const f = fold(q);
  const list = dir.people.filter((p) => !p.former && (!f || fold(p.name).includes(f) || fold(p.email).includes(f)));
  const mine = dir.people.find((p) => p.id === dir.me);
  const firstSet = new Set(first ?? []);
  const top = first?.length ? list.filter((p) => firstSet.has(p.id)) : [];
  const rest = top.length ? list.filter((p) => !firstSet.has(p.id)) : list;
  const isOn = (id: string) => (picked ? picked.includes(id) : id === value);
  const opt = (p: DirPerson) => (
    <button type="button" key={p.id} className={`tk-pop-opt ${isOn(p.id) ? "is-on" : ""}`} onClick={() => onPick(p.id)}>
      <Avatar person={p} size={22} /><span>{p.name}{p.id === dir.me ? " (you)" : ""}<em>{p.department ? deptName(p.department) : p.role ?? ""}</em></span>{isOn(p.id) && <TkIco d="check" className="tk-pop-tick" />}
    </button>
  );
  return (
    <div className="tk-people">
      <input className="tk-pop-q" autoFocus placeholder="Find someone…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="tk-pop-list">
        {!picked && !q && mine && value !== mine.id && !firstSet.has(mine.id) && (
          <button type="button" className="tk-pop-opt is-me" onClick={() => onPick(mine.id)}><Avatar person={mine} size={22} /><span>Me</span></button>
        )}
        {allowNone && !q && value && <button type="button" className="tk-pop-opt" onClick={() => onPick(null)}><Avatar person={null} size={22} /><span>{noneLabel}</span></button>}
        {top.length > 0 && <span className="tk-pop-k">{firstLabel}</span>}
        {top.map(opt)}
        {top.length > 0 && rest.length > 0 && <span className="tk-pop-k">Everyone</span>}
        {rest.slice(0, 40).map(opt)}
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
const DESK_TABS: { key: DeskTab; label: string; icon: keyof typeof TK_ICON; hint: string }[] = [
  { key: "mine", label: "Mine", icon: "user", hint: "Yours: you own it, watch it or have a step" },
  { key: "team", label: "Team", icon: "users", hint: "Your department's" },
  { key: "unassigned", label: "Unassigned", icon: "nobody", hint: "Nobody owns it yet" },
  { key: "all", label: "All", icon: "layers", hint: "Everything in the company" },
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
const cleanSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|aw|sv|rv)\s*:\s*)+/i, "").replace(/\[(?:Ticket\s+)?T-\d+\]/gi, "").trim();

/**
 * The ticket desk: the to-do as a ticketing tool. In the home column it is a
 * card; `full` turns it into the full-window view (filters + table).
 */
/** The quick filters at the top of the Tickets page. */
type QuickKey = "" | "reply" | "unassigned" | "today" | "overdue" | "breach" | "blocked" | "archived";

const KIND_PREF = "desk.kind";
const readKind = (): ItemCat => { try { return localStorage.getItem(KIND_PREF) === "ticket" ? "ticket" : "task"; } catch { return "task"; } };

export function TicketDesk({ full: fullProp = false, page = false, openFirst = null, startKind = null, startInbox = false, onClose, onExpand, expandTitle, onShrink, scope = null }: {
  full?: boolean;
  /**
   * One client's tickets (the client pop-up): only its tickets (by client or its company, resolved ones too), new
   * tickets come for it; no Inbox, no Tasks, no "whose" switch, no mail reading. The desk works as on the page.
   */
  scope?: { clientId: string; companyId: string | null; name: string } | null;
  /** The Tickets page opens on its Inbox (?kind=inbox). */
  startInbox?: boolean;
  /** The expand button asks first (the calendar widens its panel); true = handled, no page change. */
  onExpand?: () => boolean;
  expandTitle?: string;
  /** Shown while widened: back to the narrow panel. */
  onShrink?: () => void;
  /** Tickets (conversations) or tasks (work) first; otherwise the last one used. */
  startKind?: ItemCat | null;
  /** The Tickets page (/tickets): the whole desk, the ticket opens next to the list. */
  page?: boolean;
  /** A ticket to open straight away (the page's ?ticket=…). */
  openFirst?: string | null;
  onClose?: () => void;
}) {
  const full = fullProp || page;
  const navTo = useNavigate();
  const today = isoDay(new Date());
  const [data, setData] = useState<{ tickets: Ticket[]; ready: boolean; ownedDeals: string[]; catReady: boolean } | null>(null);
  /** Tickets are conversations (e-mail, messages, calls — with clients or the team); tasks are the work itself. */
  const [kind, setKindState] = useState<ItemCat>(() => (scope ? "ticket" : startKind ?? readKind()));
  const setKind = (k: ItemCat) => {
    if (k !== kind) { setSel(new Set()); setDelAsk(false); setQuick(""); setFStage(""); setFType(""); }
    setKindState(k); if (!scope) { try { localStorage.setItem(KIND_PREF, k); } catch { /* private mode */ } }
  };
  useEffect(() => { if (startKind) setKindState(startKind); }, [startKind]);
  /* the page head: when the section changes its pieces glide to where they now sit (FLIP), new ones fade in,
     and the dark pill slides under the section you picked */
  const headFlip = useRef<Map<string, DOMRect> | null>(null);
  const secNav = useRef<HTMLElement | null>(null);
  const snapHead = () => {
    const m = new Map<string, DOMRect>();
    document.querySelectorAll<HTMLElement>(".tkp2-head [data-flip]").forEach((el) => m.set(el.dataset.flip!, el.getBoundingClientRect()));
    return m;
  };
  useLayoutEffect(() => {
    const nav = secNav.current;
    const pill = nav?.querySelector<HTMLElement>(".tkp2-sec-pill");
    const on = nav?.querySelector<HTMLElement>("button.is-on");
    if (pill && on) {
      const x = `${on.offsetLeft}px`, w = `${on.offsetWidth}px`;
      if (pill.style.getPropertyValue("--x") !== x || pill.style.getPropertyValue("--w") !== w) {
        pill.style.setProperty("--x", x); pill.style.setProperty("--w", w);
        pill.style.setProperty("--y", `${on.offsetTop}px`); pill.style.setProperty("--h", `${on.offsetHeight}px`);
      }
      if (!pill.classList.contains("is-set")) requestAnimationFrame(() => pill.classList.add("is-set"));
    }
    const before = headFlip.current;
    if (!before) return;
    headFlip.current = null;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    document.querySelectorAll<HTMLElement>(".tkp2-head [data-flip]").forEach((el) => {
      const was = before.get(el.dataset.flip!);
      if (!el.animate) return;
      if (!was) { el.animate([{ opacity: 0, transform: "translateY(6px) scale(0.98)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: 60, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" }); return; }
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left, dy = was.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 460, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    });
  });
  const isT = kind === "ticket";
  const noun = isT ? "ticket" : "task";
  const [dir, setDir] = useState<Directory | null>(null);
  useDirNames(setDir);
  const [types, setTypes] = useState<string[]>(DEFAULT_TYPES);
  const [tab, setTab] = useState<DeskTab>(scope ? "all" : "mine");
  const [view, setView] = useState<DeskView>("active");
  const [sort, setSort] = useState<DeskSort>("due");
  const [q, setQ] = useState("");
  const [fPrio, setFPrio] = useState<TaskPriority | "">("");
  const [fType, setFType] = useState("");
  const [openId, setOpenId] = useState<string | null>(openFirst);
  useEffect(() => { if (openFirst) setOpenId(openFirst); }, [openFirst]);
  const [creating, setCreating] = useState<Partial<Ticket> | null>(null);
  const [quick, setQuick] = useState<QuickKey>("");
  // opening a ticket leaves the new-ticket form
  useEffect(() => { if (openId) setCreating(null); }, [openId]);
  const [fStage, setFStage] = useState<TicketStage | "">("");
  const [menu, setMenu] = useState<{ id: string; kind: "stage" | "assignee"; rect: DOMRect } | null>(null);
  const [draft, setDraft] = useState("");
  const [draftPrio, setDraftPrio] = useState<TaskPriority>("normal");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sortMenu, setSortMenu] = useState<DOMRect | null>(null);
  /** On the home card the filter box is a magnifier until it's used. */
  const [qOpen, setQOpen] = useState(false);
  // e-mail, SLA, bulk, views, shortcuts
  const [pane, setPane] = useState<"tickets" | "inbox">(startInbox ? "inbox" : "tickets");
  // the Tickets page: the header's drop-downs (whose · quick filter), and an open item at full width
  const [hmenu, setHmenu] = useState<{ k: "scope" | "quick" | "seg"; at: DOMRect } | null>(null);
  const [wide, setWideState] = useState(() => { try { return localStorage.getItem("ticketsWide") === "1"; } catch { return false; } });
  const setWide = (v: boolean) => { setWideState(v); try { localStorage.setItem("ticketsWide", v ? "1" : "0"); } catch { /* fine */ } };
  useEffect(() => { if (startInbox) setPane("inbox"); }, [startInbox]);
  const [inbox, setInbox] = useState<MailMsg[] | null | undefined>(undefined);
  const [boxes, setBoxes] = useState<Mailbox[]>([]);
  const [mailSt, setMailSt] = useState<OutlookMailStatus | null>(null);
  const [sla, setSla] = useState<SlaMap | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [syncTip, setSyncTip] = useState<DOMRect | null>(null);
  const [settings, setSettings] = useState<{ start?: SettingsTab; prefill?: Partial<MailRule> | null; segNew?: boolean } | null>(null);
  const [preview, setPreview] = useState<MailMsg | null>(null);
  /** An e-mail opens beside the Inbox, half and half; full width is only for that e-mail (not the tickets' choice). */
  const [mailWide, setMailWide] = useState(false);
  useEffect(() => { if (!preview) setMailWide(false); }, [preview]);

  const [addPick, setAddPick] = useState<{ m: MailMsg; rect: DOMRect } | null>(null);
  /** Your Inbox segments, and the one switched on (only its e-mails show). */
  const [segs, setSegs] = useState<MailSegment[]>([]);
  const [segOn, setSegOnState] = useState(() => { try { return localStorage.getItem("tkp.inboxSeg") ?? ""; } catch { return ""; } });
  const setSegOn = (id: string) => { setSegOnState(id); setPreview(null); try { localStorage.setItem("tkp.inboxSeg", id); } catch { /* private mode */ } };
  const storeSegs = (list: MailSegment[]) => { setSegs(list); void savePref(SEG_PREF, list); if (segOn && !list.some((x) => x.id === segOn)) setSegOn(""); };
  useEffect(() => { loadPrefs().then((p) => { const v = p?.[SEG_PREF]; if (Array.isArray(v)) setSegs(v as MailSegment[]); }).catch(() => {}); }, []);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [delAsk, setDelAsk] = useState(false);
  const [bulk, setBulk] = useState<{ kind: "stage" | "assignee" | "priority" | "merge"; rect: DOMRect } | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [cursor, setCursor] = useState(-1);
  /** The page: a list, or a board with a column per stage (drag a card to move it). */
  const [layout, setLayoutState] = useState<"list" | "board">(() => { try { return localStorage.getItem("tkp.layout") === "board" ? "board" : "list"; } catch { return "list"; } });
  const setLayout = (v: "list" | "board") => { setLayoutState(v); try { localStorage.setItem("tkp.layout", v); } catch { /* private mode */ } };
  const [viewsAt, setViewsAt] = useState<DOMRect | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  /** The board's last picked card: Shift-click picks the run from it. */
  const boardAnchor = useRef<string | null>(null);
  const [dropOn, setDropOn] = useState<TicketStage | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const qRef = useRef<HTMLInputElement>(null);

  const scopeKey = scope ? `${scope.clientId}|${scope.companyId ?? ""}` : "";
  const reload = useCallback(() => {
    if (scope) {
      loadClientTickets(scope.clientId, scope.companyId).then((r) => setData({ tickets: r.tickets, ready: r.ready, ownedDeals: [], catReady: true }))
        .catch(() => setData({ tickets: [], ready: false, ownedDeals: [], catReady: true }));
      return;
    }
    loadTickets().then(setData).catch(() => setData({ tickets: [], ready: false, ownedDeals: [], catReady: false }));
  }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const reloadMail = useCallback(() => {
    if (scope) { setInbox([]); return; }
    loadInboxMail().then(setInbox).catch(() => setInbox([]));
    loadMailboxes().then((b) => setBoxes(b ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    reload();
    reloadMail();
    loadDirectory().then(setDir).catch(() => {});
    loadTicketTypes().then(setTypes).catch(() => {});
    loadSla().then((r) => setSla(r.sla)).catch(() => setSla(DEFAULT_SLA));
    if (!scope) getMailStatus().then(setMailSt).catch(() => {});
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

  // remote directory: the names the tickets and the inbox point at
  useEffect(() => {
    if (!dir?.remote) return;
    const ts = data?.tickets ?? [];
    void ensureDirNames(dir, {
      companies: ts.map((t) => t.companyId), deals: ts.map((t) => t.trackingId), contacts: ts.map((t) => t.requesterContactId),
      emails: (inbox ?? []).map((m) => m.fromEmail),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir?.remote, data, inbox]);

  /** Reads new mail of the desk's mailboxes (rules, threads, Inbox). */
  const syncNow = useCallback(async (quiet = false) => {
    if (deskSyncBusy) return;
    deskSyncBusy = true; setSyncing(true);
    const r: MailSyncResult = await syncTicketMail().catch((e) => ({ error: String(e?.message ?? e) }));
    deskSyncBusy = false; setSyncing(false);
    if (!r.error) lastDeskSync = Date.now();
    if (r.error) {
      void quiet;   // the red dot on the refresh button says it; the note is in its tooltip
      setSyncNote({ text: r.error === "mail_scope_missing" || /scope|permission/i.test(r.error) ? "Outlook needs mail permission — connect again with mail." : r.error === "not_connected" ? "Connect Outlook to read mail." : r.error, bad: true });
    } else {
      const bits: string[] = [];
      if (r.stored) bits.push(`${r.stored} new e-mail${r.stored === 1 ? "" : "s"}`);
      if (r.created) bits.push(`${r.created} ticket${r.created === 1 ? "" : "s"} opened`);
      if (r.threaded) bits.push(`${r.threaded} added to tickets`);
      if (r.inbox) bits.push(`${r.inbox} in the Inbox`);
      if (r.unknown) bits.push(`${r.unknown} left out: not in the CRM`);
      const errs = r.errors ?? [];
      setSyncNote(errs.length ? { text: errs[0], bad: true } : { text: bits.length ? bits.join(" · ") : r.note || r.skipped || "Up to date" });
    }
    reload(); reloadMail();
  }, [reload, reloadMail]);
  const mailOn = !!mailSt?.connected && !!mailSt?.mail;
  const hasBoxes = boxes.some((b) => b.active);
  useEffect(() => {
    if ((full && !page) || !mailOn || !hasBoxes || scope) return;
    const tick = () => { if (!document.hidden && Date.now() - lastDeskSync > AUTO_SYNC_MS - 15000) syncNow(true); };
    tick();
    const iv = window.setInterval(tick, AUTO_SYNC_MS);
    return () => window.clearInterval(iv);
  }, [full, page, mailOn, hasBoxes, syncNow]);

  const me = dir?.me ?? null;
  const ready = data?.ready ?? false;
  const everything = data?.tickets ?? [];
  /** The list in view: only tickets, or only tasks. */
  const all = everything.filter((t) => t.category === kind);
  const kindCount = (k: ItemCat) => everything.filter((t) => t.category === k && !t.mergedInto && isActive(t.stage) && inTab(t, tab)).length;
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
  /* the page: its column headers filter and sort (remembered per tickets / tasks); with no Status filter it
     shows what's still open, as the old Open / Waiting / Done switch did by default */
  const [hvS, setHvS] = useState<{ k: ItemCat; v: FView }>(() => ({ k: kind, v: readHead(kind) }));
  const hvOther = useMemo(() => (hvS.k === kind ? null : readHead(kind)), [hvS.k, kind]);
  const hv = hvOther ?? hvS.v;
  useEffect(() => { if (hvS.k !== kind) setHvS({ k: kind, v: readHead(kind) }); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const setHv = (v: FView) => { setHvS({ k: kind, v }); try { localStorage.setItem(`tkp.head.${kind}`, JSON.stringify(v)); } catch { /* private mode */ } };
  /* the list's columns: shown and ordered per tickets / tasks; drag a heading, or use Actions › Columns */
  const [colsS, setColsS] = useState<{ k: ItemCat; v: TklKey[] }>(() => ({ k: kind, v: readCols(kind) }));
  const colsOther = useMemo(() => (colsS.k === kind ? null : readCols(kind)), [colsS.k, kind]);
  const cols = colsOther ?? colsS.v;
  useEffect(() => { if (colsS.k !== kind) setColsS({ k: kind, v: readCols(kind) }); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const setCols = (v: TklKey[]) => { setColsS({ k: kind, v }); try { localStorage.setItem(`tkp.cols.${kind}`, JSON.stringify(v)); } catch { /* private mode */ } };
  const [colDrag, setColDrag] = useState<TklKey | null>(null);
  const [colOver, setColOver] = useState<{ k: TklKey; after: boolean } | null>(null);
  const [colEdit, setColEdit] = useState(false);
  const dropCol = (on: TklKey, after: boolean) => {
    if (!colDrag || colDrag === on) return;
    const next = cols.filter((x) => x !== colDrag);
    next.splice(next.indexOf(on) + (after ? 1 : 0), 0, colDrag);
    setCols(next);
  };
  const endDrag = () => { setColDrag(null); setColOver(null); };
  /** Drag a column heading onto another: it goes before or after it, whichever half you drop on. */
  const headDrag = (k: TklKey) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { setColDrag(k); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", k); } catch { /* */ } },
    onDragEnd: endDrag,
    onDragOver: (e: React.DragEvent) => {
      if (!colDrag) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      if (colOver?.k !== k || colOver.after !== after) setColOver({ k, after });
    },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); if (colOver) dropCol(k, colOver.after); endDrag(); },
  });
  /* the list's width, for its grid (measured before it paints; each list element keeps its own observer) */
  const [tklW, setTklW] = useState(0);
  const tklRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const cs = getComputedStyle(el);
    setTklW(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setTklW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const headFields = useMemo<FField<Ticket>[]>(() => {
    const prio: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    const stageAt = (st: TicketStage) => TICKET_STAGES.findIndex((x) => x.key === st);
    return [
      { key: "no", label: "ID", group: "", type: "number", get: (t) => t.no ?? null },
      { key: "title", label: kind === "ticket" ? "Ticket" : "Task", group: "", type: "text", get: (t) => plain(t.title) },
      { key: "type", label: "Type", group: "", type: "select", get: (t) => t.type ?? "", options: () => types.map((x) => ({ value: x, label: x })) },
      { key: "stage", label: "Status", group: "", type: "select", get: (t) => t.stage, sort: (t) => stageAt(t.stage),
        options: () => TICKET_STAGES.map((x) => ({ value: x.key, label: stageLabel(x.key, kind) })) },
      { key: "priority", label: "Priority", group: "", type: "select", get: (t) => t.priority, sort: (t) => prio[t.priority],
        options: () => TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })) },
      { key: "due", label: "Due", group: "", type: "date", get: (t) => dayOf(t.due) ?? null },
      { key: "steps", label: "Steps", group: "", type: "number", get: (t) => (t.checklist.length ? Math.round((t.checklist.filter((x) => x.done).length / t.checklist.length) * 100) : null) },
      { key: "link", label: "Linked to", group: "", type: "text", get: (t) => linkLabel(t, dir)?.text ?? "" },
      { key: "owner", label: "Owner", group: "", type: "select", get: (t) => t.assignee ?? "",
        options: () => (dir?.people ?? []).filter((p) => !p.former).map((p) => ({ value: p.id, label: p.name })) },
    ];
  }, [kind, types, dir]);
  const headN = isDefaultHead(hv) ? 0 : hv.conds.length;   // filters picked beyond the start (open ones)
  const inView = (t: Ticket) => page ? true
    : fStage ? t.stage === fStage : view === "done" ? !isActive(t.stage) : view === "waiting" ? t.stage === "waiting" : isActive(t.stage);
  const isQuick = (t: Ticket, k: QuickKey) => {
    if (!k) return true;
    if (k === "archived") return t.stage === "closed";
    if (!isActive(t.stage)) return false;
    if (k === "reply") return !t.firstResponseAt && (t.stage === "new" || t.stage === "open") && (!!t.requesterEmail || t.source === "email");
    if (k === "unassigned") return !t.assignee;
    if (k === "today") return groupOf(t, today) === "today";
    if (k === "overdue") return groupOf(t, today) === "overdue";
    if (k === "blocked") return t.stage === "waiting";
    return !!sla && !!slaOf(t, sla, now)?.breached;
  };
  const f = fold(q.trim());
  const matches = (t: Ticket) => !f || fold(`${t.title} ${ticketRef(t)} ${t.type ?? ""} ${t.tags.join(" ")} ${t.requesterName ?? ""} ${linkLabel(t, dir)?.text ?? ""}`).includes(f);
  const shown0 = all.filter((t) => !t.mergedInto && inTab(t, tab) && inView(t) && isQuick(t, quick) && matches(t) && (page || ((!fPrio || t.priority === fPrio) && (!fType || t.type === fType))));
  /* Archived (a quick filter) looks past the Status column's "still open" start */
  const hvQ = quick === "archived" ? { ...hv, conds: hv.conds.filter((c) => c.field !== "stage") } : hv;
  const shown = page ? applyHead(shown0, headFields, { ...hvQ, sort: [] }) : shown0;
  const rank: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const headSorted = !!page && hv.sort.length > 0;
  const sorted = headSorted ? applyHead(shown, headFields, { ...hv, conds: [] }) : [...shown].sort((a, b) => {
    if (sort === "priority") return rank[a.priority] - rank[b.priority] || (a.due ?? "9").localeCompare(b.due ?? "9");
    if (sort === "updated") return (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
    if (sort === "number") return (b.no ?? 0) - (a.no ?? 0);
    return (a.due ?? "9999").localeCompare(b.due ?? "9999") || rank[a.priority] - rank[b.priority];
  });
  const counts = Object.fromEntries(DESK_TABS.map((x) => [x.key, all.filter((t) => !t.mergedInto && isActive(t.stage) && inTab(t, x.key)).length])) as Record<DeskTab, number>;
  const breached = sla ? all.filter((t) => inTab(t, tab) && slaOf(t, sla, now)?.breached).length : 0;
  const seg = segs.find((x) => x.id === segOn) ?? null;
  const segCount = (x: MailSegment) => (inbox ?? []).filter((m) => segmentMatches(x.conditions, m, dir)).length;
  const inboxShown = (inbox ?? []).filter((m) => (!f || fold(`${m.subject} ${m.fromName ?? ""} ${m.fromEmail ?? ""} ${m.snippet}`).includes(f)) && (!seg || segmentMatches(seg.conditions, m, dir)));
  const lastSync = Math.max(lastDeskSync, ...boxes.map((b) => (b.lastSyncAt ? new Date(b.lastSyncAt).getTime() : 0)));
  const lateCount = all.filter((t) => isActive(t.stage) && inTab(t, tab) && groupOf(t, today) === "overdue").length;
  const person = (id: string | null) => (id ? dir?.people.find((p) => p.id === id) ?? null : null);

  const patch = async (t: Ticket, p: Partial<Ticket>) => {
    setData((d) => d && { ...d, tickets: d.tickets.map((x) => (x.id === t.id ? { ...x, ...p } : x)) });
    const e = await saveTicket(t.id, p, ready);
    if (e) { setErr(e); reload(); } else setErr(null);
  };
  /* ---- the add box: it opens up into the whole new task (who, when, how urgent, steps) ---- */
  const [composing, setComposing] = useState(false);
  const blankCompose = () => ({ description: "", due: null as string | null, assignee: (tab === "unassigned" ? null : me) as string | null, watchers: [] as string[], checklist: [] as TaskStep[] });
  const [cd, setCd] = useState(blankCompose);
  const [cPop, setCPop] = useState<{ k: "owner" | "people"; rect: DOMRect } | null>(null);
  const composeRef = useRef<HTMLDivElement>(null);
  const mentionPeople: MentionPerson[] = useMemo(() => (dir?.people ?? []).filter((p) => !p.former).map((p) => ({ id: `employee:${p.id}`, name: p.name, kind: "employee" as const })), [dir]);
  const closeCompose = () => { setComposing(false); setCPop(null); setDraft(""); setDraftPrio("normal"); setCd(blankCompose()); };
  const quickAdd = async () => {
    const title = draft.trim();
    if (!title || adding) return;
    setAdding(true);
    const assignee = composing ? cd.assignee : tab === "unassigned" ? null : me;
    // whoever is @mentioned or given a step comes along as a watcher
    const tagged = [...mentionIds(title), ...mentionIds(cd.description), ...cd.checklist.map((x) => x.who ?? "")];
    const watchers = [...new Set([...cd.watchers, ...tagged])].filter((id) => id && id !== assignee && (dir?.people ?? []).some((p) => p.id === id));
    const res = await createTicket({
      title, priority: draftPrio, assignee, watchers, ...kindFields(),
      ...(cd.description.trim() ? { description: cd.description } : {}), ...(cd.due ? { due: cd.due } : {}), ...(cd.checklist.length ? { checklist: cd.checklist } : {}),
    }, ready);
    setAdding(false);
    if (res.error) { setErr(res.error); return; }
    setErr(null);
    closeCompose();
    (document.activeElement as HTMLElement | null)?.blur();
  };
  /** The full window, with what's been filled in so far. */
  const moreOptions = () => {
    const t: Partial<Ticket> = { ...newDraft(), title: draft, description: cd.description, priority: draftPrio, due: cd.due, assignee: cd.assignee, watchers: cd.watchers, checklist: cd.checklist };
    closeCompose();
    setCreating(t);
  };
  /** Typing @name in the title or the details brings that person along as a watcher, right away. */
  const tagFrom = (text: string) => setCd((c) => {
    const add = mentionIds(text).filter((id) => id !== c.assignee && !c.watchers.includes(id) && (dir?.people ?? []).some((p) => p.id === id));
    return add.length ? { ...c, watchers: [...c.watchers, ...add] } : c;
  });
  const setDue = (iso: string | null) => setCd((c) => ({ ...c, due: iso ? `${iso}T${timeOf(c.due) ?? "18:00"}:00` : null }));
  const dayFrom = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
  const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); return isoDay(d); };
  /** What a new item of the list in view starts with: a ticket is a message unless said otherwise. */
  function kindFields(): Partial<Ticket> {
    return isT ? { category: "ticket", source: "message" } : { category: "task" };
  }
  const newDraft = (): Partial<Ticket> => ({ assignee: me, ...kindFields(), ...(scope ? { clientId: scope.clientId, companyId: scope.companyId } : {}) });
  const cyclePrio = () => setDraftPrio((p) => TASK_PRIORITIES[(TASK_PRIORITIES.indexOf(p) + 1) % TASK_PRIORITIES.length]);
  const openT = all.find((t) => t.id === openId) ?? null;
  // opening one from elsewhere (search, a link) shows the list it belongs to
  const openCat = openId ? everything.find((t) => t.id === openId)?.category : undefined;
  useEffect(() => { if (openCat && openCat !== kind) setKind(openCat); }, [openCat]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- Inbox actions ---- */
  const dropMail = (id: string) => { setInbox((xs) => (xs ? xs.filter((x) => x.id !== id) : xs)); setPreview((p) => (p?.id === id ? null : p)); };
  const mailToTicket = async (m: MailMsg) => {
    if (!dir) return;
    dropMail(m.id);
    const res = await createTicketFromMail(m, dir, ready);
    if (res.error || !res.id) { setErr(res.error); reloadMail(); return; }
    setErr(null); setOpenId(res.id);
  };
  /** An e-mail that's work to do rather than a conversation: a task (it opens under Tasks). */
  const mailToTask = async (m: MailMsg) => {
    if (!dir) return;
    dropMail(m.id);
    const res = await createTicketFromMail(m, dir, ready, { category: "task" });
    if (res.error || !res.id) { setErr(res.error); reloadMail(); return; }
    setErr(null); setPreview(null); setPane("tickets"); setKind("task"); setOpenId(res.id);
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
    setSettings({ start: "mine", prefill: {
      name: `${who}${subj ? ` · ${subj.slice(0, 40)}` : ""}`,
      conditions: { match: "all", ...(contact ? { from_contact_ids: [contact.id] } : { from_emails: m.fromEmail ? [m.fromEmail] : [] }), ...(subj ? { subject_contains: subj.slice(0, 60) } : {}) },
      action: "create", set: { assignee_id: me },
    } });
  };

  /* ---- bulk (full view) ---- */
  const selected = (layout === "board" ? all : sorted).filter((t) => sel.has(t.id));
  const toggleSel = (id: string) => setSel((s0) => { const s1 = new Set(s0); if (s1.has(id)) s1.delete(id); else s1.add(id); return s1; });
  const bulkPatch = async (p: Partial<Ticket>) => {
    const ids = new Set(selected.map((t) => t.id));
    setBulk(null);
    setData((d) => d && { ...d, tickets: d.tickets.map((x) => (ids.has(x.id) ? { ...x, ...p } : x)) });
    const errs = (await Promise.all(selected.map((t) => saveTicket(t.id, p, ready)))).filter(Boolean);
    if (errs.length) { setErr(errs[0]); reload(); } else { setErr(null); setSel(new Set()); }
  };
  /** Deletes the selected ones you may delete (whoever created one); the rest stay and you're told why. */
  const bulkDelete = async () => {
    setDelAsk(false);
    const mine = selected.filter((t) => canDeleteTask({ created_by: t.createdBy }, me));
    const gone = new Set(mine.map((t) => t.id));
    setData((d) => d && { ...d, tickets: d.tickets.filter((x) => !gone.has(x.id)) });
    const errs = (await Promise.all(mine.map((t) => deleteTask(t.id)))).filter(Boolean) as string[];
    setSel(new Set());
    const kept = selected.length - mine.length + errs.length;
    const done = mine.length - errs.length;
    setErr(kept ? `${done} deleted · ${kept} kept: only whoever created a ${noun} can delete it.` : null);
    tell();
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
  const keyState = useRef({ sorted, cursor, pane, full, open: null as string | null });
  keyState.current = { sorted, cursor, pane, full, open: page ? openId : null };
  // on the Tickets page the ticket sits next to the list: j / k keep moving through it
  const blocked = !!(((openT || creating) && !page) || creating || settings || preview || help || addPick || bulk || menu || sortMenu);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (blocked || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      if (document.querySelector(".td-back") || (!full && document.querySelector(".tk-full"))) return;
      const st = keyState.current;
      const cur = st.sorted[st.cursor];
      const go = (d: number) => {
        const n = st.sorted.length; if (!n) return;
        const from = st.cursor >= 0 ? st.cursor : st.open ? st.sorted.findIndex((x) => x.id === st.open) : -1;
        const i = Math.max(0, Math.min(n - 1, (from < 0 ? (d > 0 ? -1 : n) : from) + d));
        setCursor(i);
        if (st.open) setOpenId(st.sorted[i].id);   // the open ticket follows
        window.setTimeout(() => document.querySelector(`[data-tk="${st.sorted[i].id}"]`)?.scrollIntoView({ block: "nearest" }), 0);
      };
      switch (e.key) {
        case "n": e.preventDefault(); setCreating(newDraft()); break;
        case "/": e.preventDefault(); setPane("tickets"); setQOpen(true); window.setTimeout(() => qRef.current?.focus(), 0); break;
        case "j": case "ArrowDown": if (e.key === "ArrowDown" && !full) return; e.preventDefault(); go(1); break;
        case "k": case "ArrowUp": if (e.key === "ArrowUp" && !full) return; e.preventDefault(); go(-1); break;
        case "Enter": case "o": if (cur && st.pane === "tickets") { e.preventDefault(); setOpenId(cur.id); } break;
        case "e": if (cur && isActive(cur.stage)) patch(cur, { stage: "resolved" }); break;
        case "a": if (cur && me && cur.assignee !== me) patch(cur, { assignee: me }); break;
        case "x": if (cur && st.full) toggleSel(cur.id); break;
        case "i": if (!scope && (isT || page)) { if (!isT) setKindState("ticket"); setPreview(null); setPane((p) => (p === "inbox" ? "tickets" : "inbox")); } break;
        case "s": if (!scope) syncNow(); break;
        case "?": setHelp(true); break;
        case "Escape": if (sel.size) { setSel(new Set()); setDelAsk(false); break; } return;
        default: return;
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  });
  useEffect(() => { setCursor(-1); }, [tab, view, q, fPrio, fType, sort, pane, quick, fStage]);
  // switching between tickets and tasks starts from a clean list (the e-mail inbox belongs to tickets)
  useEffect(() => {
    setSel((x) => (x.size ? new Set() : x)); setDelAsk(false); setQuick(""); setFStage(""); setFType("");
    if (!isT) setPane("tickets");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const row = (t: Ticket, i: number) => {
    const link = linkLabel(t, dir);
    const active = isActive(t.stage);
    const late = active && groupOf(t, today) === "overdue";
    const stepsDone = t.checklist.filter((x) => x.done).length;
    const mySteps = me ? t.checklist.filter((x) => !x.done && x.who === me).length : 0;
    const crew = [t.assignee, ...t.watchers.filter((w) => w !== t.assignee)].filter(Boolean) as string[];
    const when = dueInfo(t.due, today);
    return (
      <div key={t.id} data-tk={t.id} className={`tk-row is-p-${t.priority} ${late ? "is-late" : ""} ${active ? "" : "is-done"} ${sorted[cursor]?.id === t.id ? "is-cur" : ""} ${sel.has(t.id) ? "is-picked" : ""}`} style={{ ["--i" as string]: Math.min(i, 12) } as React.CSSProperties}
        onClick={() => setOpenId(t.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(t.id); }}>
        {/* the round box: tick it off (its ring is the priority) */}
        <button type="button" className={`tk-tick is-p-${t.priority}`} onClick={(e) => { e.stopPropagation(); patch(t, { stage: active ? "resolved" : "open" }); }}
          title={active ? (isT ? "Resolve" : "Mark done") : "Reopen"} aria-label={active ? (isT ? "Resolve" : "Mark done") : "Reopen"}>
          <TkIco d="check" />
        </button>
        <div className="tk-row-main">
          <span className="tk-row-title"><Rich text={t.title} /></span>
          {/* the rest shows when the card opens up (hover / focus) */}
          <div className="tk-row-more"><div>
            <div className="tk-row-meta">
              <StagePill stage={t.stage} cat={t.category} onClick={(e) => { e.stopPropagation(); setMenu({ id: t.id, kind: "stage", rect: e.currentTarget.getBoundingClientRect() }); }} />
              {(t.priority === "urgent" || t.priority === "high") && <span className={`tk-prio is-${t.priority}`}><FlagIcon />{PRIORITY_LABEL[t.priority]}</span>}
              <DueChip dueAt={t.due} todayIso={today} done={!active} />
              {isT && <SlaBadge t={t} sla={sla} now={now} compact />}
              {t.checklist.length > 0 ? (
                <span className={`tk-steps ${stepsDone === t.checklist.length ? "is-all" : ""}`} title={`${stepsDone} of ${t.checklist.length} steps done`}>
                  <i style={{ ["--w" as string]: `${Math.round((stepsDone / t.checklist.length) * 100)}%` } as React.CSSProperties} />{stepsDone}/{t.checklist.length}
                </span>
              ) : t.kind === "process" && t.progress > 0 ? <span className="tk-steps"><i style={{ ["--w" as string]: `${t.progress}%` } as React.CSSProperties} />{t.progress}%</span> : null}
              {mySteps > 0 && <span className="tk-mine" title="Steps given to you">{mySteps === 1 ? "1 step for you" : `${mySteps} steps for you`}</span>}
              {link && <span className={`tk-link ${t.clientId && link.icon === "briefcase" ? "has-logo" : ""}`}>{t.clientId && link.icon === "briefcase" ? <ClientLogo name={link.text} clientId={t.clientId} className="tk-link-logo" /> : <TkIco d={link.icon} />}{link.text}</span>}
              {t.source === "email" && <span className="tk-src" title="Came in by e-mail"><TkIco d="mail" /></span>}
              <span className="tk-ref">{ticketRef(t)}</span>
            </div>
          </div></div>
        </div>
        <div className="tk-row-side" onClick={(e) => e.stopPropagation()}>
          <span className="tk-row-acts">
            <span className="tk-row-cb" title="Select (X)">
              <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggleSel(t.id)} aria-label={`Select ${ticketRef(t)}`} />
            </span>
            {me && t.assignee !== me && active && <button type="button" className="tk-act" title="Take it (A)" aria-label="Assign to me" onClick={() => patch(t, { assignee: me })}><TkIco d="user" /></button>}
          </span>
          {when && <span className={`tk-when is-${active ? when.tone : "done"}`} title={`Due ${when.day}${when.time ? ` at ${when.time}` : ""}`}>{when.tone === "late" && active ? when.rel : when.tone === "today" ? (when.time ?? "Today") : when.day.replace(/^\w+, /, "")}</span>}
          {mySteps > 0 && <span className="tk-mine-dot" title={mySteps === 1 ? "1 step for you" : `${mySteps} steps for you`} />}
          <button type="button" className="tk-crew" onClick={(e) => setMenu({ id: t.id, kind: "assignee", rect: e.currentTarget.getBoundingClientRect() })}
            title={crew.length ? crew.map((id) => person(id)?.name ?? "Someone").join(", ") : "Nobody yet — click to give it to someone"}>
            {crew.length ? crew.slice(0, 2).map((id) => <Avatar key={id} person={person(id)} size={24} />) : <Avatar person={null} size={24} />}
            {crew.length > 2 && <em>+{crew.length - 2}</em>}
          </button>
        </div>
      </div>
    );
  };

  const groups: { key: string; label: string; items: Ticket[] }[] = sort === "due" && view !== "done" && !headSorted
    ? GROUPS.map((g) => ({ ...g, items: sorted.filter((t) => groupOf(t, today) === g.key) })).filter((g) => g.items.length)
    : [{ key: "all" as const, label: "", items: sorted }];

  const filters = (
    <div className="tk-filters">
      <div className="tk-q">
        <TkIco d="search" />
        <input ref={qRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={pane === "inbox" ? "Filter e-mail…" : `Filter ${noun}s…`}
          onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); } }} />
        {q && <button type="button" onClick={() => setQ("")} aria-label="Clear"><TkIco d="x" /></button>}
      </div>
      {pane === "tickets" && <>
      <div className="tk-seg" role="tablist">
        {(["active", "waiting", "done"] as DeskView[]).map((v) => (
          <button key={v} type="button" className={view === v ? "is-on" : ""} onClick={() => setView(v)}>{v === "active" ? "Open" : v === "waiting" ? (isT ? "Waiting" : "Blocked") : "Done"}</button>
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
      <b>{q || fPrio || fType ? `No ${noun} matches` : view === "done" ? (isT ? "Nothing resolved lately" : "Nothing done lately") : tab === "mine" ? (isT ? "No conversations waiting on you" : "Nothing on your plate") : `No open ${noun}s here`}</b>
      <span>{view === "active" && !q ? (isT ? "E-mails, messages and calls with clients or the team land here." : "Type above to add a task — it lands on your list.") : "Try another tab or filter."}</span>
    </div>
  ) : full ? (
    <div className="tk-table">
      <div className="tk-th">
        <span className="tk-cb"><input type="checkbox" aria-label="Select all" checked={!!sorted.length && selected.length === sorted.length}
          ref={(el) => { if (el) el.indeterminate = selected.length > 0 && selected.length < sorted.length; }}
          onChange={() => setSel(selected.length === sorted.length ? new Set() : new Set(sorted.map((t) => t.id)))} /></span>
        <span>{isT ? "Ticket" : "Task"}</span><span>Linked to</span><span>Type</span><span>Priority</span><span>Due</span><span>{isT ? "SLA" : "Progress"}</span><span>Owner</span><span>Stage</span>
      </div>
      {sorted.map((t, i) => {
        const link = linkLabel(t, dir);
        const pct = t.checklist.length ? Math.round((t.checklist.filter((x) => x.done).length / t.checklist.length) * 100) : null;
        return (
          <div key={t.id} data-tk={t.id} className={`tk-tr is-p-${t.priority} ${openId === t.id || sel.has(t.id) ? "is-sel" : ""} ${sorted[cursor]?.id === t.id ? "is-cur" : ""}`} style={{ ["--i" as string]: Math.min(i, 14) } as React.CSSProperties} onClick={() => setOpenId(t.id)}>
            <span className="tk-cb" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(t.id)} onChange={() => toggleSel(t.id)} aria-label={`Select ${ticketRef(t)}`} /></span>
            <span className="tk-td-title"><em className="tk-ref">{ticketRef(t)}</em><b><Rich text={t.title} /></b>{t.source === "email" && <span className="tk-src" title="Came in by e-mail"><TkIco d="mail" /></span>}{pct !== null && isT && <span className="tk-pct is-sm"><i style={{ ["--w" as string]: `${pct}%` } as React.CSSProperties} />{pct}%</span>}</span>
            <span className="tk-td-muted">{link ? <span className="tk-link"><TkIco d={link.icon} />{link.text}</span> : "—"}</span>
            <span className="tk-td-muted">{t.type ?? "—"}</span>
            <span><span className={`tk-prio is-${t.priority}`}><FlagIcon />{PRIORITY_LABEL[t.priority]}</span></span>
            <span>{t.due ? <DueChip dueAt={t.due} todayIso={today} done={!isActive(t.stage)} /> : <i className="tk-td-muted">—</i>}</span>
            <span>{!isT ? (pct !== null ? <span className="tk-pct is-sm"><i style={{ ["--w" as string]: `${pct}%` } as React.CSSProperties} />{pct}%</span> : <i className="tk-td-muted">—</i>)
              : slaOf(t, sla ?? DEFAULT_SLA, now) ? <SlaBadge t={t} sla={sla} now={now} compact /> : <i className="tk-td-muted">{t.firstResponseAt && !isActive(t.stage) ? "Done" : "—"}</i>}</span>
            <span onClick={(e) => e.stopPropagation()}>
              <button type="button" className="tk-owner" onClick={(e) => setMenu({ id: t.id, kind: "assignee", rect: e.currentTarget.getBoundingClientRect() })}>
                <Avatar person={person(t.assignee)} size={22} /><span>{person(t.assignee)?.name ?? "Unassigned"}</span>
              </button>
            </span>
            <span onClick={(e) => e.stopPropagation()}><StagePill stage={t.stage} cat={t.category} onClick={(e) => setMenu({ id: t.id, kind: "stage", rect: e.currentTarget.getBoundingClientRect() })} /></span>
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

  /* mail freshness: a small refresh button by the settings gear, green when mail was read lately, red when not */
  const syncState: "off" | "busy" | "ok" | "stale" = !mailOn || !hasBoxes ? "off" : syncing ? "busy"
    : syncNote?.bad || !lastSync || now - lastSync > AUTO_SYNC_MS * 3 ? "stale" : "ok";
  const syncBtn = isT && inbox !== null ? (
    <button type="button" className={`tm-rs is-${syncState}`} aria-label={syncState === "off" ? "Set up mail" : "Read new mail now"}
      onClick={() => { setSyncTip(null); if (syncState === "off") goToSection(navTo, "/settings", "ticketspage/mailboxes"); else syncNow(); }} disabled={syncing}
      onMouseEnter={(e) => setSyncTip(e.currentTarget.getBoundingClientRect())} onMouseLeave={() => setSyncTip(null)}
      onFocus={(e) => setSyncTip(e.currentTarget.getBoundingClientRect())} onBlur={() => setSyncTip(null)}>
      <TkIco d="refresh" className={syncing ? "is-spin" : ""} /><i className="tm-rs-dot" />
    </button>
  ) : null;
  const syncTipEl = syncTip && syncBtn ? createPortal(
    <div className={`tm-rs-tip is-${syncState}`} role="tooltip"
      style={{ top: syncTip.bottom + 8, left: Math.max(8, Math.min(window.innerWidth - 268, syncTip.left + syncTip.width / 2 - 130)) }}>
      <b><i className="tm-rs-dot" />{syncState === "off" ? (mailOn ? "No mailbox is read yet" : "Mail isn't connected")
        : syncState === "busy" ? "Reading mail…" : syncNote?.bad ? "The last read failed"
          : syncState === "ok" ? "Mail is up to date" : lastSync ? `Mail not read for ${ago(new Date(lastSync).toISOString()).replace(/ ago$/, "")}` : "Mail not read yet"}</b>
      {syncState !== "off" && <span>{lastSync > 0 ? <>Last read {ago(new Date(lastSync).toISOString())} · {new Date(lastSync).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</> : "Never read"}</span>}
      {syncNote && syncState !== "off" && <span className={syncNote.bad ? "is-bad" : ""}>{syncNote.text}</span>}
      <small>{syncState === "off" ? "Click to set up mailboxes" : `Reads every ${AUTO_SYNC_MS / 60000} min while the desk is open · click or press S to read now`}</small>
    </div>,
    document.body,
  ) : null;
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
        <button type="button" className="td-ghost is-sm" onClick={() => goToSection(navTo, "/settings", "ticketspage/mailboxes")}><TkIco d="gear" />Mailboxes</button>
      </div>
    ) : null;
  const inboxPane = (
    <div className="tm-pane">
      {mailBanner}
      {inbox === undefined ? <div className="hs-skel tk-skel" /> : inbox === null ? null : !inboxShown.length ? (
        <div className="tk-empty">
          <span className="tk-empty-ico"><TkIco d="inbox" /></span>
          <b>{q ? "No e-mail matches" : seg ? `Nothing in “${seg.name}” right now` : "Inbox zero"}</b>
          <span>{q ? "Try another word." : seg ? "New e-mail that fits the segment shows up here." : "E-mail that no rule or ticket picks up lands here, to sort by hand."}</span>
          {seg && !q && <button type="button" className="td-ghost is-sm" onClick={() => setSegOn("")}>Show all mail</button>}
        </div>
      ) : (
        <div className="tm-list">
          {inboxShown.map((m, i) => (
            <MailRow key={m.id} m={m} boxes={boxes} i={i} on={preview?.id === m.id} onOpen={() => setPreview(m)} onCreate={() => mailToTicket(m)} onTask={() => mailToTask(m)}
              onAdd={(rect) => setAddPick({ m, rect })} onRule={() => ruleFrom(m)} onIgnore={() => mailIgnore(m)} />
          ))}
        </div>
      )}
    </div>
  );
  const deletable = selected.filter((t) => canDeleteTask({ created_by: t.createdBy }, me)).length;
  const bulkBar = selected.length > 0 && pane === "tickets" ? (
    <div className={`tk-bulk ${full ? "" : "is-compact"} ${delAsk ? "is-ask" : ""}`}>
      {delAsk ? (
        <>
          <span className="tk-bulk-q">
            {deletable === 0 ? `You didn't create any of these — only whoever created a ${noun} can delete it.`
              : <>Delete <b>{deletable} {deletable === 1 ? noun : `${noun}s`}</b> for good?{deletable < selected.length ? ` ${selected.length - deletable} you didn't create stay.` : ""} Notes and history go with them.</>}
          </span>
          <span className="td-spacer" />
          <button type="button" onClick={() => setDelAsk(false)}>{deletable ? "Keep" : "OK"}</button>
          {deletable > 0 && <button type="button" className="is-del" onClick={bulkDelete}><TkIco d="trash" />Delete</button>}
        </>
      ) : (
        <>
          <b>{selected.length} selected</b>
          {!(page && layout === "board") && selected.length < sorted.length && <button type="button" className="is-link" onClick={() => setSel(new Set(sorted.map((t) => t.id)))}>All {sorted.length}</button>}
          {full && <button type="button" onClick={(e) => setBulk({ kind: "stage", rect: e.currentTarget.getBoundingClientRect() })}><span className="tk-dot is-open" />Stage</button>}
          <button type="button" onClick={(e) => setBulk({ kind: "assignee", rect: e.currentTarget.getBoundingClientRect() })} title="Owner"><TkIco d="user" />{full && "Owner"}</button>
          {full && <button type="button" onClick={(e) => setBulk({ kind: "priority", rect: e.currentTarget.getBoundingClientRect() })}><FlagIcon />Priority</button>}
          {full && isT && selected.length > 1 && <button type="button" onClick={(e) => setBulk({ kind: "merge", rect: e.currentTarget.getBoundingClientRect() })}><TkIco d="merge" />Merge</button>}
          <button type="button" onClick={() => bulkPatch({ stage: "resolved" })} title={isT ? "Resolve" : "Mark done"}><TkIco d="check" />{isT ? "Resolve" : "Done"}</button>
          <button type="button" className="is-danger" onClick={() => setDelAsk(true)} title="Delete"><TkIco d="trash" />Delete</button>
          <span className="td-spacer" />
          <button type="button" className="is-clear" onClick={() => setSel(new Set())} title="Clear the selection (Esc)"><TkIco d="x" />{full && "Clear"}</button>
        </>
      )}
    </div>
  ) : null;

  /** Tickets (conversations) | Tasks (work): the first choice on the desk. */
  const kindSwitch = (
    <div className="tk-kind" role="tablist" aria-label="Tickets or tasks">
      {(["ticket", "task"] as ItemCat[]).map((k) => (
        <button key={k} type="button" role="tab" aria-selected={kind === k} className={`is-${k} ${kind === k ? "is-on" : ""}`} onClick={() => setKind(k)}
          title={k === "ticket" ? "Conversations: e-mails, messages and calls with clients or the team" : "Work to do: things someone has to get done"}>
          <TkIco d={k === "ticket" ? "mail" : "check"} />{k === "ticket" ? "Tickets" : "Tasks"}<i>{kindCount(k)}</i>
        </button>
      ))}
    </div>
  );
  /** The home card's first choice: Inbox | Tickets | Tasks (the open one shows its name). */
  const deskSwitch = (
    <div className="tk-kind is-3" role="tablist" aria-label="Inbox, tickets or tasks">
      {inbox !== null && (
        <button type="button" role="tab" aria-selected={pane === "inbox"} className={`is-inbox ${pane === "inbox" ? "is-on" : ""}`} title="E-mail waiting to be sorted (I)"
          onClick={() => { if (kind !== "ticket") setKindState("ticket"); setOpenId(null); setQ(""); setPane("inbox"); }}>
          <TkIco d="inbox" /><span>Inbox</span><i className={inbox?.length ? "is-new" : ""}>{inbox?.length ?? 0}</i>
        </button>
      )}
      {(["ticket", "task"] as ItemCat[]).map((k) => (
        <button key={k} type="button" role="tab" aria-selected={pane !== "inbox" && kind === k} className={`is-${k} ${pane !== "inbox" && kind === k ? "is-on" : ""}`}
          onClick={() => { if (pane === "inbox") { setQ(""); setPane("tickets"); } if (k !== kind) setKind(k); }}
          title={k === "ticket" ? "Conversations: e-mails, messages and calls with clients or the team" : "Work to do: things someone has to get done"}>
          <TkIco d={k === "ticket" ? "mail" : "check"} /><span>{k === "ticket" ? "Tickets" : "Tasks"}</span><i>{kindCount(k)}</i>
        </button>
      ))}
    </div>
  );
  const menuT = menu ? all.find((t) => t.id === menu.id) : null;
  const overlays = (
    <>
      {bulk && dir && (
        <Pop anchor={bulk.rect} onClose={() => setBulk(null)} width={bulk.kind === "merge" ? 340 : bulk.kind === "assignee" ? 250 : 200}>
          {bulk.kind === "stage" ? (
            <div className="tk-pop-list">{TICKET_STAGES.map((s) => <button key={s.key} type="button" className="tk-pop-opt" onClick={() => bulkPatch({ stage: s.key })}><span className={`tk-dot is-${s.key}`} /><span>{stageLabel(s.key, kind)}</span></button>)}</div>
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
      {preview && !(page && pane === "inbox") && (page || full ? (
        <MailPreview m={preview} boxes={boxes} onClose={() => setPreview(null)} onCreate={() => mailToTicket(preview)} onTask={() => mailToTask(preview)}
          onAdd={(rect) => setAddPick({ m: preview, rect })} onRule={() => ruleFrom(preview)} onIgnore={() => mailIgnore(preview)} />
      ) : (
        <DeskFloat mail onClose={() => setPreview(null)}>
          <MailPreview key={preview.id} inline m={preview} boxes={boxes} onClose={() => setPreview(null)} onCreate={() => mailToTicket(preview)} onTask={() => mailToTask(preview)}
            onAdd={(rect) => setAddPick({ m: preview, rect })} onRule={() => ruleFrom(preview)} onIgnore={() => mailIgnore(preview)} />
        </DeskFloat>
      ))}
      {settings && dir && (
        <DeskSettings dir={dir} types={types} tickets={all} inbox={inbox ?? []} start={settings.start} prefill={settings.prefill} mail={mailSt}
          segments={segs} segNew={settings.segNew} onSegments={storeSegs} onShowSegment={(id) => { setSettings(null); setPane("inbox"); setSegOn(id); }}
          onClose={() => { setSettings(null); reloadMail(); loadSla().then((r) => setSla(r.sla)).catch(() => {}); }}
          onConnect={() => connectOutlook({ withMail: true })} />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {syncTipEl}
      {sortMenu && (
        <Pop anchor={sortMenu} onClose={() => setSortMenu(null)} width={210}>
          <div className="tk-pop-list">
            {!full && <>
              <span className="tk-pop-k">Show</span>
              {(["active", "waiting", "done"] as DeskView[]).map((v) => (
                <button key={v} type="button" className={`tk-pop-opt ${view === v ? "is-on" : ""}`} onClick={() => { setView(v); setSortMenu(null); }}>
                  <span>{v === "active" ? "Open" : v === "waiting" ? (isT ? "Waiting" : "Blocked") : "Done"}</span>{view === v && <TkIco d="check" className="tk-pop-tick" />}
                </button>
              ))}
              <span className="tk-pop-k">Sort by</span>
            </>}
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
                  <span className={`tk-dot is-${s.key}`} /><span>{stageLabel(s.key, menuT.category)}<em>{stageText(s.key, menuT.category).hint}</em></span>
                </button>
              ))}
            </div>
          ) : (
            <PeopleMenu dir={dir} value={menuT.assignee} onPick={(id) => { setMenu(null); patch(menuT, { assignee: id }); }} />
          )}
        </Pop>
      )}
      {!page && (openT || creating) && dir && (
        <DeskFloat onClose={() => { setOpenId(null); setCreating(null); }}>
          <TicketDrawer key={openT?.id ?? "new"} inline ticket={openT} draft={creating} dir={dir} types={types} ready={ready} tickets={all}
            onTypes={setTypes}
            onClose={() => { setOpenId(null); setCreating(null); }}
            onCreated={(id) => { setCreating(null); setOpenId(id); }}
            onLocal={(t) => setData((d) => d && { ...d, tickets: d.tickets.map((x) => (x.id === t.id ? t : x)) })} />
        </DeskFloat>
      )}
    </>
  );

  if (page) {
    // what needs you: each number is also a filter
    const base = all.filter((t) => !t.mergedInto && inTab(t, tab));
    const nQ = (k: QuickKey) => base.filter((t) => isQuick(t, k)).length;
    const QUICK: { k: Exclude<QuickKey, "">; label: string; tone: string }[] = isT ? [
      { k: "overdue", label: "Overdue", tone: "red" },
      { k: "today", label: "Due today", tone: "amber" },
      { k: "reply", label: "Waiting for a first reply", tone: "blue" },
      { k: "breach", label: "Past their SLA", tone: "red" },
      { k: "unassigned", label: "No owner", tone: "slate" },
      { k: "archived", label: "Archived", tone: "archive" },
    ] : [
      { k: "overdue", label: "Overdue", tone: "red" },
      { k: "today", label: "Due today", tone: "amber" },
      { k: "blocked", label: "Blocked", tone: "violet" },
      { k: "unassigned", label: "No owner", tone: "slate" },
      { k: "archived", label: "Archived", tone: "archive" },
    ];
    const open = !!(openT || creating);
    const board = layout === "board" && pane === "tickets";
    const filtered = !!(quick || fStage || q || fPrio || fType || headN);
    const clearAll = () => { setQuick(""); setFStage(""); setQ(""); setFPrio(""); setFType(""); if (headN) setHv({ ...defaultHead(), sort: hv.sort }); };
    const drawerProps = {
      dir: dir!, types, ready, tickets: all, onTypes: setTypes,
      onClose: () => { setOpenId(null); setCreating(null); },
      onCreated: (id: string) => { setCreating(null); setOpenId(id); },
      onLocal: (t: Ticket) => setData((d) => d && { ...d, tickets: d.tickets.map((x) => (x.id === t.id ? t : x)) }),
    };
    // the board: one column per stage, the same filters as the list (not the Open / Done switch)
    const COLS: TicketStage[] = ["new", "open", "in_progress", "waiting", "resolved"];
    const boardItems = all.filter((t) => !t.mergedInto && inTab(t, tab) && isQuick(t, quick) && matches(t) && (!fPrio || t.priority === fPrio) && (!fType || t.type === fType));
    const colItems = (st: TicketStage) => boardItems.filter((t) => (st === "resolved" ? !isActive(t.stage) : t.stage === st))
      .sort((x, y) => st === "resolved" ? (y.resolvedAt ?? y.updatedAt ?? "").localeCompare(x.resolvedAt ?? x.updatedAt ?? "") : (x.due ?? "9999").localeCompare(y.due ?? "9999") || rank[x.priority] - rank[y.priority]);
    const colOf = (t: Ticket): TicketStage => (isActive(t.stage) ? t.stage : "resolved");
    /** ⌘/Ctrl-click a card picks it (or drops it), Shift-click picks the run up to it in its column; a plain click opens it. */
    const pickCard = (t: Ticket, e: React.MouseEvent) => {
      if (e.shiftKey && boardAnchor.current) {
        const col = colItems(colOf(t)).map((x) => x.id);
        const a = col.indexOf(boardAnchor.current), b = col.indexOf(t.id);
        if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSel((s0) => new Set([...s0, ...col.slice(lo, hi + 1)])); return true; }
      }
      if (e.metaKey || e.ctrlKey || e.shiftKey) { toggleSel(t.id); boardAnchor.current = t.id; return true; }
      return false;
    };
    /** Dragging a picked card takes every picked one along (a small stack shows how many). */
    const dragStart = (t: Ticket, e: React.DragEvent) => {
      setDragId(t.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.id);
      const many = sel.has(t.id) ? sel.size : 0;
      if (many > 1) {
        const g = document.createElement("div");
        g.className = "tkb-ghost"; g.textContent = `${many} ${noun}s`;
        document.body.appendChild(g); e.dataTransfer.setDragImage(g, 24, 20);
        window.setTimeout(() => g.remove(), 0);
      }
    };
    const dropOnCol = (st: TicketStage, id: string) => {
      const t = all.find((x) => x.id === id);
      if (!t) return;
      const list = sel.has(t.id) && sel.size > 1 ? all.filter((x) => sel.has(x.id)) : [t];
      const go = list.filter((x) => (st === "resolved" ? isActive(x.stage) : x.stage !== st));
      if (!go.length) return;
      if (go.length === 1) { void patch(go[0], { stage: st }); return; }
      const ids = new Set(go.map((x) => x.id));
      setData((d) => d && { ...d, tickets: d.tickets.map((x) => (ids.has(x.id) ? { ...x, stage: st } : x)) });
      void Promise.all(go.map((x) => saveTicket(x.id, { stage: st }, ready))).then((errs) => {
        const e = errs.find(Boolean);
        if (e) { setErr(e); reload(); } else { setErr(null); setSel(new Set()); }
      });
    };
    const card = (t: Ticket, i: number) => {
      const link = linkLabel(t, dir);
      const picked = sel.has(t.id);
      const stepsDone = t.checklist.filter((x) => x.done).length;
      const crew = [t.assignee, ...t.watchers.filter((w) => w !== t.assignee)].filter(Boolean) as string[];
      const mine = me ? t.checklist.filter((x) => !x.done && x.who === me).length : 0;
      return (
        <div key={t.id} className={`tkb-card is-p-${t.priority} ${openId === t.id ? "is-open" : ""} ${dragId === t.id || (dragId && picked && sel.has(dragId)) ? "is-drag" : ""} ${picked ? "is-sel" : ""}`} style={{ ["--i" as string]: Math.min(i, 10) } as React.CSSProperties}
          draggable onDragStart={(e) => dragStart(t, e)}
          onDragEnd={() => { setDragId(null); setDropOn(null); }}
          onClick={(e) => { if (!pickCard(t, e)) setOpenId(t.id); }} role="button" tabIndex={0} aria-selected={picked}
          onKeyDown={(e) => { if (e.key === "Enter") setOpenId(t.id); if (e.key === " ") { e.preventDefault(); toggleSel(t.id); } }}>
          <button type="button" className="tkb-pick" aria-pressed={picked} title={picked ? "Unpick (⌘/Ctrl-click)" : "Pick it — ⌘/Ctrl-click picks more, Shift-click a run"}
            onClick={(e) => { e.stopPropagation(); if (!pickCard(t, e)) { toggleSel(t.id); boardAnchor.current = t.id; } }}><TkIco d="check" /></button>
          <div className="tkb-top">
            <span className="tk-ref">{ticketRef(t)}</span>
            {(t.priority === "urgent" || t.priority === "high") && <span className={`tk-prio is-${t.priority}`}><FlagIcon />{PRIORITY_LABEL[t.priority]}</span>}
            {t.type && <span className="tkb-type">{t.type}</span>}
          </div>
          <b className="tkb-title"><Rich text={t.title} /></b>
          {(t.due || t.checklist.length > 0 || link) && (
            <div className="tkb-meta">
              <DueChip dueAt={t.due} todayIso={today} done={!isActive(t.stage)} />
              {t.checklist.length > 0 && <span className={`tk-steps ${stepsDone === t.checklist.length ? "is-all" : ""}`}><i style={{ ["--w" as string]: `${Math.round((stepsDone / t.checklist.length) * 100)}%` } as React.CSSProperties} />{stepsDone}/{t.checklist.length}</span>}
              {link && <span className="tk-link"><TkIco d={link.icon} />{link.text}</span>}
            </div>
          )}
          <div className="tkb-foot">
            {mine > 0 ? <span className="tk-mine">{mine === 1 ? "1 step for you" : `${mine} steps for you`}</span> : <span />}
            <span className="tkb-crew" title={crew.map((id) => person(id)?.name ?? "Someone").join(", ") || "Nobody yet"}>
              {crew.length ? crew.slice(0, 3).map((id) => <Avatar key={id} person={person(id)} size={22} />) : <Avatar person={null} size={22} />}
              {crew.length > 3 && <em>+{crew.length - 3}</em>}
            </span>
          </div>
        </div>
      );
    };
    const boardView = (
      <div className={`tkb ${sel.size ? "has-sel" : ""}`}>
        {COLS.map((st) => {
          const items = colItems(st);
          const shown = st === "resolved" ? items.slice(0, 25) : items;
          return (
            <section key={st} className={`tkb-col is-${st} ${dropOn === st ? "is-drop" : ""}`}
              onDragOver={(e) => { if (!dragId) return; e.preventDefault(); if (dropOn !== st) setDropOn(st); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn((d) => (d === st ? null : d)); }}
              onDrop={(e) => { e.preventDefault(); const id = dragId ?? e.dataTransfer.getData("text/plain"); setDragId(null); setDropOn(null); if (id) dropOnCol(st, id); }}>
              <header className="tkb-h">
                {(() => {
                  const n = items.filter((x) => sel.has(x.id)).length;
                  const allOn = items.length > 0 && n === items.length;
                  return (
                    <button type="button" className={`tkb-all ${allOn ? "is-on" : n ? "is-some" : ""}`} disabled={!items.length} aria-pressed={allOn}
                      title={allOn ? "Unpick everything in this column" : "Pick everything in this column"}
                      onClick={() => setSel((s0) => { const s1 = new Set(s0); items.forEach((x) => (allOn ? s1.delete(x.id) : s1.add(x.id))); return s1; })}>
                      <TkIco d={n && !allOn ? "minus" : "check"} />
                    </button>
                  );
                })()}
                <span className={`tk-dot is-${st}`} /><b>{stageLabel(st, kind)}</b><i>{items.length}</i>
                {st === "new" && <button type="button" className="tkb-add" onClick={() => { setOpenId(null); setCreating(newDraft()); }} title={`New ${noun}`} aria-label={`New ${noun}`}><TkIco d="plus" /></button>}
              </header>
              <div className="tkb-list">
                {shown.map(card)}
                {!items.length && <p className="tkb-empty">{dragId ? "Drop it here" : st === "resolved" ? "Nothing done lately" : "Nothing here"}</p>}
                {items.length > shown.length && <p className="tkb-empty">+{items.length - shown.length} older</p>}
              </div>
            </section>
          );
        })}
      </div>
    );
    // the list: one row per ticket / task, every fact in its own column (narrow lists keep the essentials)
    const hf = (k: string) => headFields.find((x) => x.key === k);
    const headRows = all.filter((t) => !t.mergedInto && inTab(t, tab));
    const tableRow = (t: Ticket, i: number) => {
      const link = linkLabel(t, dir);
      const active = isActive(t.stage);
      const late = active && groupOf(t, today) === "overdue";
      const stepsDone = t.checklist.filter((x) => x.done).length;
      const pct = t.checklist.length ? Math.round((stepsDone / t.checklist.length) * 100) : t.kind === "process" && t.progress > 0 ? t.progress : null;
      const crew = [t.assignee, ...t.watchers.filter((w) => w !== t.assignee)].filter(Boolean) as string[];
      const when = dueInfo(t.due, today);
      const mySteps = me ? t.checklist.filter((x) => !x.done && x.who === me).length : 0;
      const logo = !!(t.clientId && link?.icon === "briefcase");
      const cell: Record<TklKey, React.ReactNode> = {
        id: (
            <span key="id" className="tkl-c is-id">{ticketRef(t)}</span>
        ),
        title: (
            <span key="title" className="tkl-c is-title">
              <b><Rich text={t.title} /></b>
              {t.source === "email" && isT && <span className="tkl-src" title="Came in by e-mail"><TkIco d="mail" /></span>}
              {mySteps > 0 && <span className="tk-mine-dot" title={mySteps === 1 ? "1 step for you" : `${mySteps} steps for you`} />}
              {/* narrow list: what the hidden columns would say, on one quiet line */}
              <small className="tkl-sub">
                <span className={`tk-dot is-${t.stage}`} />{stageLabel(t.stage, t.category)}
                <em>{ticketRef(t)}</em>
                {link && <em>{link.text}</em>}
              </small>
            </span>
        ),
        type: (
            <span key="type" className="tkl-c is-type">{t.type ? <span className="tkl-type" title={t.type}>{t.type}</span> : <i className="tkl-none">—</i>}</span>
        ),
        stage: (
            <span key="stage" className="tkl-c is-stage" onClick={(e) => e.stopPropagation()}>
              <StagePill stage={t.stage} cat={t.category} onClick={(e) => setMenu({ id: t.id, kind: "stage", rect: e.currentTarget.getBoundingClientRect() })} />
            </span>
        ),
        prio: (
            <span key="prio" className="tkl-c is-prio"><span className={`tkl-prio is-${t.priority}`}><FlagIcon />{PRIORITY_LABEL[t.priority]}</span></span>
        ),
        due: (
            <span key="due" className="tkl-c is-due">
              {when ? (
                <span className={`tkl-when is-${active ? when.tone : "done"}`} title={`Due ${when.day}${when.time ? ` at ${when.time}` : ""} (${when.rel})`}>
                  {when.tone === "late" && active ? when.rel : when.day.replace(/^\w+, /, "")}{when.time && !(when.tone === "late" && active) && <em>{when.time}</em>}
                </span>
              ) : <i className="tkl-none">—</i>}
            </span>
        ),
        xtra: (
            <span key="xtra" className="tkl-c is-xtra">
              {isT ? (slaOf(t, sla ?? DEFAULT_SLA, now) ? <SlaBadge t={t} sla={sla} now={now} compact /> : <i className="tkl-none">—</i>)
                : pct !== null ? <span className={`tkl-steps ${pct === 100 ? "is-all" : ""}`} title={t.checklist.length ? `${stepsDone} of ${t.checklist.length} steps done` : `${pct}%`}><i><i style={{ width: `${pct}%` }} /></i>{t.checklist.length ? `${stepsDone}/${t.checklist.length}` : `${pct}%`}</span>
                  : <i className="tkl-none">—</i>}
            </span>
        ),
        link: (
            <span key="link" className="tkl-c is-link">
              {link ? <span className="tkl-link" title={link.text}>{logo ? <ClientLogo name={link.text} clientId={t.clientId} className="tk-link-logo" /> : <TkIco d={link.icon} />}<span>{link.text}</span></span> : <i className="tkl-none">—</i>}
            </span>
        ),
        own: (
            <span key="own" className="tkl-c is-own" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="tkl-crew" onClick={(e) => setMenu({ id: t.id, kind: "assignee", rect: e.currentTarget.getBoundingClientRect() })}
                title={crew.length ? crew.map((id) => person(id)?.name ?? "Someone").join(", ") : "Nobody yet — click to give it to someone"}>
                {crew.length ? crew.slice(0, 3).map((id) => <Avatar key={id} person={person(id)} size={24} />) : <Avatar person={null} size={24} />}
                {crew.length > 3 && <em>+{crew.length - 3}</em>}
              </button>
            </span>
        ),
      };
      return (
        <div key={t.id} data-tk={t.id} role="row" tabIndex={0} style={{ ["--i" as string]: Math.min(i, 14) } as React.CSSProperties}
          className={`tkl-tr is-p-${t.priority} ${late ? "is-late" : ""} ${active ? "" : "is-done"} ${openId === t.id ? "is-open" : ""} ${sorted[cursor]?.id === t.id ? "is-cur" : ""} ${sel.has(t.id) ? "is-picked" : ""}`}
          onClick={() => setOpenId(t.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(t.id); }}>
          <span className="tkl-c is-cb" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggleSel(t.id)} aria-label={`Select ${ticketRef(t)}`} />
          </span>
          <span className="tkl-c is-tick">
            <button type="button" className={`tk-tick is-p-${t.priority}`} onClick={(e) => { e.stopPropagation(); patch(t, { stage: active ? "resolved" : "open" }); }}
              title={active ? (isT ? "Resolve" : "Mark done") : "Reopen"} aria-label={active ? (isT ? "Resolve" : "Mark done") : "Reopen"}><TkIco d="check" /></button>
          </span>
          {cols.map((k) => cell[k])}
        </div>
      );
    };
    const headCell: Record<TklKey, React.ReactNode> = {
      id: <ColumnHead label="ID" view={hv} onView={setHv} fields={[hf("no")]} rows={headRows} />,
      title: <ColumnHead label={isT ? "Ticket" : "Task"} view={hv} onView={setHv} fields={[hf("title")]} rows={headRows} />,
      type: <ColumnHead label="Type" view={hv} onView={setHv} fields={[hf("type")]} rows={headRows} />,
      stage: <ColumnHead label="Status" view={hv} onView={setHv} fields={[hf("stage")]} rows={headRows} />,
      prio: <ColumnHead label="Priority" view={hv} onView={setHv} fields={[hf("priority")]} rows={headRows} />,
      due: <ColumnHead label="Due" view={hv} onView={setHv} fields={[hf("due")]} rows={headRows} />,
      xtra: isT ? <span className="tkl-plain">SLA</span> : <ColumnHead label="Steps" view={hv} onView={setHv} fields={[hf("steps")]} rows={headRows} />,
      link: <ColumnHead label="Linked to" view={hv} onView={setHv} fields={[hf("link")]} rows={headRows} />,
      own: <ColumnHead label="Owner" view={hv} onView={setHv} fields={[hf("owner")]} rows={headRows} />,
    };
    const listView = !data ? <div className="hs-skel tk-skel" /> : !sorted.length ? (
      <div className="tk-empty">
        <span className="tk-empty-ico"><TkIco d={view === "done" ? "check" : "inbox"} /></span>
        <b>{filtered ? `No ${noun} matches` : view === "done" ? (isT ? "Nothing resolved lately" : "Nothing done lately") : tab === "mine" ? (isT ? "No conversations waiting on you" : "Nothing on your plate") : `No open ${noun}s here`}</b>
        <span>{filtered ? <button type="button" className="tkp2-link" onClick={clearAll}>Clear the filters</button> : `New ${noun}s you create or get given show up here.`}</span>
      </div>
    ) : (
      <div ref={tklRef} className={`tkl has-order ${isT ? "is-ticket" : "is-task"} ${colDrag ? "is-moving-col" : ""}`} role="table" aria-label={isT ? "Tickets" : "Tasks"}
        style={{ ["--tkl-order" as string]: tklTemplate(cols, isT, tklW) } as React.CSSProperties}>
        {/* the column names: the ones you can sort by sort when clicked */}
        <div className="tkl-th" role="row">
          <span className="tkl-c is-cb" role="columnheader">
            <input type="checkbox" aria-label="Select all" checked={!!sorted.length && selected.length === sorted.length}
              ref={(el) => { if (el) el.indeterminate = selected.length > 0 && selected.length < sorted.length; }}
              onChange={() => setSel(selected.length === sorted.length ? new Set() : new Set(sorted.map((t) => t.id)))} />
          </span>
          <span className="tkl-c is-tick" />
          {cols.map((k) => (
            <span key={k} role="columnheader" title="Click to sort or filter · drag to move" {...headDrag(k)}
              className={`tkl-c is-${k} tkl-hc ${colDrag === k ? "is-dragging" : ""} ${colOver?.k === k && colDrag !== k ? (colOver.after ? "is-over-r" : "is-over-l") : ""}`}>
              {headCell[k]}
            </span>
          ))}
        </div>
        {groups.map((g) => (
          <div key={g.key} className={`tkl-group is-${g.key}`} role="rowgroup">
            {g.label && <span className="tkl-gh">{g.label}<i>{g.items.length}</i></span>}
            {g.items.map(tableRow)}
          </div>
        ))}
      </div>
    );
    // the page's three parts, each on its own: the Inbox (e-mail to sort), Tickets (conversations), Tasks (work)
    const section: "inbox" | ItemCat = pane === "inbox" ? "inbox" : kind;
    const SECTIONS: { k: "inbox" | ItemCat; label: string; icon: keyof typeof TK_ICON; n: number; hint: string }[] = [
      { k: "inbox", label: "Inbox", icon: "inbox", n: inbox?.length ?? 0, hint: "E-mail no rule or ticket picked up: sort it by hand (I)" },
      { k: "ticket", label: "Tickets", icon: "mail", n: kindCount("ticket"), hint: "Conversations: e-mails, messages and calls with clients or the team" },
      { k: "task", label: "Tasks", icon: "check", n: kindCount("task"), hint: "Work to do: things someone has to get done" },
    ];
    const goSection = (k: "inbox" | ItemCat) => {
      if (k === section) return;
      headFlip.current = snapHead();
      setPreview(null);
      if (k === "inbox") { if (kind !== "ticket") setKindState("ticket"); setOpenId(null); setCreating(null); setPane("inbox"); }
      else { setPane("tickets"); if (k !== kind) setKind(k); }
    };
    const mailNote = syncState === "off" ? (mailOn ? "No mailbox is read yet" : "Mail isn't connected")
      : syncState === "busy" ? "Reading mail…" : syncNote?.bad ? "The last read failed"
        : lastSync > 0 ? `${syncState === "ok" ? "Up to date" : "Not read lately"} · read ${ago(new Date(lastSync).toISOString())}` : "Not read yet";
    const sideMail = pane === "inbox" && !!preview;
    /* the Actions menu: quick create (deal, contact, company — from ActionsMenu), this desk's own new item and its columns */
    const deskActions: ActionItem[] = [
      ...(section !== "inbox" ? [{ key: "new", group: "Create", label: `New ${noun}`, hint: isT ? "A conversation with a client or the team" : "Work someone has to get done", icon: AM_ICON.plus, tone: "green" as const, shortcut: "N", primary: true,
        onSelect: () => { setOpenId(null); setCreating(newDraft()); } }] : []),
      { key: "fields", group: "Setup", label: "Columns", hint: section === "inbox" ? "The ticket and task lists' columns" : `Choose and order the ${noun} list's columns`, icon: AM_ICON.fields, tone: "amber", shortcut: "F",
        onSelect: () => { if (section === "inbox") goSection(kind); if (board) setLayout("list"); setColEdit(true); } },
    ];
    const hiddenCols = TKL_KEYS.filter((k) => !cols.includes(k));
    const colWindow = colEdit && createPortal(
      <div className="tkc-back" onMouseDown={() => setColEdit(false)}>
        <div className="tkc" role="dialog" aria-modal="true" aria-label="Columns" onMouseDown={(e) => e.stopPropagation()}>
          <header className="tkc-h">
            <span className="tkc-ico">{AM_ICON.fields}</span>
            <span className="tkc-t"><b>{isT ? "Ticket list columns" : "Task list columns"}</b><small>Drag to reorder — here or on the headings. Saved on this computer.</small></span>
            <button type="button" className="tkc-x" onClick={() => setColEdit(false)} aria-label="Close"><TkIco d="x" /></button>
          </header>
          <div className="tkc-body">
            <div className="tkc-list">
              {cols.map((k) => (
                <div key={k} className={`tkc-col ${colDrag === k ? "is-dragging" : ""} ${colOver?.k === k && colDrag !== k ? (colOver.after ? "is-over-b" : "is-over-t") : ""}`} draggable
                  onDragStart={(e) => { setColDrag(k); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => { if (!colDrag) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; const r = e.currentTarget.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2; if (colOver?.k !== k || colOver.after !== after) setColOver({ k, after }); }}
                  onDrop={(e) => { e.preventDefault(); if (colOver) dropCol(k, colOver.after); endDrag(); }}>
                  <span className="tkc-grip" aria-hidden="true"><svg viewBox="0 0 8 14"><circle cx="2" cy="2" r="1.2" /><circle cx="6" cy="2" r="1.2" /><circle cx="2" cy="7" r="1.2" /><circle cx="6" cy="7" r="1.2" /><circle cx="2" cy="12" r="1.2" /><circle cx="6" cy="12" r="1.2" /></svg></span>
                  <b>{tklLabel(k, isT)}</b>
                  {k === "title" ? <em>always shown</em> : (
                    <button type="button" className="tkc-hide" onClick={() => setCols(cols.filter((x) => x !== k))} aria-label={`Hide ${tklLabel(k, isT)}`} title="Hide"><TkIco d="x" /></button>
                  )}
                </div>
              ))}
            </div>
            {hiddenCols.length > 0 && (
              <div className="tkc-add">
                <span>Hidden</span>
                <div>{hiddenCols.map((k) => <button key={k} type="button" onClick={() => setCols([...cols, k])}><TkIco d="plus" />{tklLabel(k, isT)}</button>)}</div>
              </div>
            )}
            <p className="tkc-note">On a narrow list (beside an open {noun}) some columns step aside to leave room for the title.</p>
          </div>
          <footer className="tkc-f">
            <button type="button" className="tkc-soft" onClick={() => setCols([...TKL_KEYS])} disabled={isDefaultCols(cols)}>Reset to the usual columns</button>
            <span className="td-spacer" />
            <button type="button" className="tkc-ok" onClick={() => setColEdit(false)}>Done</button>
          </footer>
        </div>
      </div>,
      document.body,
    );
    return (
      <div className={`tkp2 is-${section} ${scope ? "is-scoped" : ""} ${(open && !board) || sideMail ? "has-open" : ""} ${(sideMail ? mailWide : wide) ? "is-wide" : ""} ${sel.size ? "has-sel" : ""}`}>
        <header className="tkp2-head">
          <div className="tkp2-title" data-flip="title">
            {scope && <span className="tkp2-eyebrow">{scope.name}</span>}
            <h1 key={section} className="tkp2-h1">{section === "inbox" ? "Inbox" : isT ? "Tickets" : "Tasks"}</h1>
          </div>
          {!scope && <nav className="tkp2-sections" aria-label="Inbox, tickets or tasks" data-flip="sections" ref={secNav}>
            <span className="tkp2-sec-pill" aria-hidden="true" />
            {SECTIONS.map((x) => (
              <button key={x.k} type="button" aria-current={section === x.k ? "page" : undefined} className={`is-${x.k} ${section === x.k ? "is-on" : ""}`} onClick={() => goSection(x.k)} title={x.hint}>
                <span className="tkp2-sec-ico"><TkIco d={x.icon} /></span>
                <span className="tkp2-sec-l">{x.label}</span>
                <i className={x.k === "inbox" && x.n > 0 ? "is-new" : ""}>{x.n}</i>
              </button>
            ))}
          </nav>}
          {section === "inbox" && inbox && (
            <div className="tkp2-picks" data-flip="picks">
              <button type="button" className={`tkp2-pick is-seg ${seg ? "is-set" : ""} ${hmenu?.k === "seg" ? "is-open" : ""}`} aria-haspopup="menu" aria-expanded={hmenu?.k === "seg"}
                style={seg ? ({ ["--tone" as string]: seg.color } as React.CSSProperties) : undefined} title={seg ? segmentSummary(seg.conditions, dir) : "Show only a segment of your Inbox"}
                onClick={(e) => setHmenu(hmenu?.k === "seg" ? null : { k: "seg", at: e.currentTarget.getBoundingClientRect() })}>
                {seg ? <><em className="tkp2-dot" /><span>{seg.name}</span><i>{segCount(seg)}</i></> : <><TkIco d="layers" /><span>All mail</span><i>{inbox.length}</i></>}
                <TkIco d="chev" className="tkp2-pick-chev" />
              </button>
              {seg && <button type="button" className="tkp2-seg-x" onClick={() => setSegOn("")} title="Show all mail" aria-label="Show all mail"><TkIco d="x" /></button>}
              {hmenu?.k === "seg" && (
                <HeadMenu at={hmenu.at} onClose={() => setHmenu(null)}>
                  <span className="tkp2-menu-h">Segments</span>
                  <button type="button" role="menuitemradio" aria-checked={!seg} className={`tkp2-menu-opt ${!seg ? "is-on" : ""}`} onClick={() => { setSegOn(""); setHmenu(null); }}>
                    <span className="tkp2-menu-ico"><TkIco d="layers" /></span><span className="tkp2-menu-t"><b>All mail</b><small>Everything waiting in the Inbox</small></span><i>{inbox.length}</i>
                  </button>
                  {segs.map((x) => (
                    <button key={x.id} type="button" role="menuitemradio" aria-checked={seg?.id === x.id} className={`tkp2-menu-opt ${seg?.id === x.id ? "is-on" : ""}`} style={{ ["--tone" as string]: x.color } as React.CSSProperties}
                      onClick={() => { setSegOn(x.id); setHmenu(null); }}>
                      <span className="tkp2-menu-ico"><em className="tkp2-dot" /></span><span className="tkp2-menu-t"><b>{x.name}</b><small>{segmentSummary(x.conditions, dir)}</small></span><i>{segCount(x)}</i>
                    </button>
                  ))}
                  <span className="tkp2-menu-sep" />
                  <button type="button" role="menuitem" className="tkp2-menu-opt is-act" onClick={() => { setHmenu(null); setSettings({ start: "segments", segNew: true }); }}>
                    <span className="tkp2-menu-ico"><TkIco d="plus" /></span><span className="tkp2-menu-t"><b>New segment</b><small>From a sender, a domain, a word in the subject…</small></span>
                  </button>
                  {segs.length > 0 && (
                    <button type="button" role="menuitem" className="tkp2-menu-opt is-act" onClick={() => { setHmenu(null); setSettings({ start: "segments" }); }}>
                      <span className="tkp2-menu-ico"><TkIco d="gear" /></span><span className="tkp2-menu-t"><b>Edit segments</b></span>
                    </button>
                  )}
                </HeadMenu>
              )}
            </div>
          )}
          {section !== "inbox" && (() => {
            const cur = DESK_TABS.find((x) => x.key === tab) ?? DESK_TABS[0];
            const qx = QUICK.find((x) => x.k === quick);
            return (
              <div className="tkp2-picks" data-flip="picks">
                {!scope && <button type="button" className={`tkp2-pick ${hmenu?.k === "scope" ? "is-open" : ""}`} aria-haspopup="menu" aria-expanded={hmenu?.k === "scope"} title={cur.hint}
                  onClick={(e) => setHmenu(hmenu?.k === "scope" ? null : { k: "scope", at: e.currentTarget.getBoundingClientRect() })}>
                  <TkIco d={cur.icon} /><span>{cur.label}</span><i>{counts[tab]}</i><TkIco d="chev" className="tkp2-pick-chev" />
                </button>}
                <button type="button" className={`tkp2-pick is-quick ${qx ? `is-set is-${qx.tone}` : ""} ${hmenu?.k === "quick" ? "is-open" : ""}`} aria-haspopup="menu" aria-expanded={hmenu?.k === "quick"} title="Quick filters"
                  onClick={(e) => setHmenu(hmenu?.k === "quick" ? null : { k: "quick", at: e.currentTarget.getBoundingClientRect() })}>
                  {qx ? <><em className="tkp2-dot" /><span>{qx.label}</span><i>{nQ(qx.k)}</i></> : <><TkIco d="filter" /><span>Quick filters</span></>}
                  <TkIco d="chev" className="tkp2-pick-chev" />
                </button>
                {hmenu && (
                  <HeadMenu at={hmenu.at} onClose={() => setHmenu(null)}>
                    {hmenu.k === "scope" ? (
                      <>
                        <span className="tkp2-menu-h">Show</span>
                        {DESK_TABS.map((x) => (
                          <button key={x.key} type="button" role="menuitemradio" aria-checked={tab === x.key} className={`tkp2-menu-opt ${tab === x.key ? "is-on" : ""}`} onClick={() => { setTab(x.key); setHmenu(null); }}>
                            <span className="tkp2-menu-ico"><TkIco d={x.icon} /></span>
                            <span className="tkp2-menu-t"><b>{x.label}</b><small>{x.hint}</small></span>
                            <i>{counts[x.key]}</i>
                          </button>
                        ))}
                      </>
                    ) : (
                      <>
                        <span className="tkp2-menu-h">Quick filters</span>
                        <button type="button" role="menuitemradio" aria-checked={!quick} className={`tkp2-menu-opt ${!quick ? "is-on" : ""}`} onClick={() => { setQuick(""); setHmenu(null); }}>
                          <span className="tkp2-menu-ico"><TkIco d="layers" /></span><span className="tkp2-menu-t"><b>No quick filter</b></span>
                        </button>
                        {QUICK.map((x) => {
                          const n = nQ(x.k);
                          return (
                            <Fragment key={x.k}>
                            {x.k === "archived" && <span className="tkp2-menu-sep" />}
                            <button type="button" role="menuitemradio" aria-checked={quick === x.k} disabled={!n && quick !== x.k} className={`tkp2-menu-opt is-${x.tone} ${quick === x.k ? "is-on" : ""}`}
                              onClick={() => { setQuick(quick === x.k ? "" : x.k); setHmenu(null); }}>
                              <span className="tkp2-menu-ico">{x.k === "archived" ? <TkIco d="archive" /> : <em className="tkp2-dot" />}</span>
                              <span className="tkp2-menu-t"><b>{x.label}</b>{x.k === "archived" && <small>Put away · delete them from here</small>}</span><i>{n}</i>
                            </button>
                            </Fragment>
                          );
                        })}
                      </>
                    )}
                  </HeadMenu>
                )}
              </div>
            );
          })()}
          <span className="td-spacer" />
          {section !== "inbox" && (
            <div className="tkp2-layout" role="tablist" aria-label="Layout" data-flip="layout">
              <button type="button" className={layout === "list" ? "is-on" : ""} onClick={() => setLayout("list")} title="List" aria-label="List"><TkIco d="sort" /></button>
              <button type="button" className={layout === "board" ? "is-on" : ""} onClick={() => setLayout("board")} title="Board: a column per stage" aria-label="Board"><TkIco d="board" /></button>
            </div>
          )}
          <label className="tkp2-search" data-flip="search">
            <TkIco d="search" />
            <input ref={qRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={pane === "inbox" ? "Search e-mail…" : `Search ${noun}s…`}
              onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); } }} />
            {q ? <button type="button" onClick={() => setQ("")} aria-label="Clear"><TkIco d="x" /></button> : <kbd>/</kbd>}
          </label>
          {section === "inbox" ? (
            <div className="tkp2-acts" data-flip="acts-inbox">
              {/* how mail reads: a check while it's up to date; the reload button only when it isn't */}
              {syncState === "ok" ? (
                <span className="tkp2-mailok" title={mailNote} aria-label={mailNote} role="status"><TkIco d="check" /></span>
              ) : syncState === "busy" ? (
                <span className="tkp2-mailok is-busy" title="Reading mail…" aria-label="Reading mail…" role="status"><TkIco d="refresh" className="is-spin" /></span>
              ) : syncState === "stale" ? (
                <button type="button" className="tkp2-icon tkp2-reload" onClick={() => syncNow()} title={`${mailNote} — read new mail now (S)`} aria-label="Read new mail now"><TkIco d="refresh" /><i className="tm-rs-dot" /></button>
              ) : null}
              <button type="button" className="tkp2-soft" onClick={() => setSettings({ start: "mine" })} title="Your own mail rules and Inbox segments"><TkIco d="filter" />Rules</button>
              <button type="button" className="tkp2-soft" onClick={() => goToSection(navTo, "/settings", "ticketspage/mailboxes")} title="The mailboxes the desk reads — in Settings › Tickets"><TkIco d="inbox" />Mailboxes</button>
            </div>
          ) : (
            <div className="tkp2-acts" data-flip="acts-desk">
              <button type="button" className="tkp2-new" onClick={() => { setOpenId(null); setCreating(newDraft()); }} title={`New ${noun} (N)`}><TkIco d="plus" />New {noun}</button>
            </div>
          )}
          <span className="tkp2-am" data-flip="actions"><ActionsMenu items={deskActions} /></span>
          {onShrink && <button type="button" className="tkp2-icon tkp2-shrink" onClick={onShrink} title="Back to the narrow panel" aria-label="Back to the narrow panel"><TkIco d="shrink" /></button>}
          {onExpand && <button type="button" className="tkp2-icon tkp2-expand" onClick={() => { if (onExpand()) return; navTo(section === "inbox" ? "/tickets?kind=inbox" : isT ? "/tickets" : "/tickets?kind=task"); }} title={expandTitle ?? "Open the Tickets page"} aria-label={expandTitle ?? "Open the Tickets page"}><TkIco d="expand" /></button>}
        </header>

        {pane === "tickets" && filtered && (
          <div className="tkp2-active">
            {quick && <span>{QUICK.find((x) => x.k === quick)?.label}<button type="button" onClick={() => setQuick("")} aria-label="Remove filter"><TkIco d="x" /></button></span>}
            {fPrio && <span>{PRIORITY_LABEL[fPrio]}<button type="button" onClick={() => setFPrio("")} aria-label="Remove filter"><TkIco d="x" /></button></span>}
            {fType && <span>{fType}<button type="button" onClick={() => setFType("")} aria-label="Remove filter"><TkIco d="x" /></button></span>}
            {q && <span>“{q}”<button type="button" onClick={() => setQ("")} aria-label="Remove filter"><TkIco d="x" /></button></span>}
            {headN > 0 && <span>{headN === 1 ? "1 column filter" : `${headN} column filters`}<button type="button" onClick={() => setHv({ ...defaultHead(), sort: hv.sort })} aria-label="Remove filter"><TkIco d="x" /></button></span>}
            <button type="button" className="tkp2-link" onClick={clearAll}>Clear all</button>
            {quick === "archived" && !board && sorted.length > 0 && (
              <button type="button" className="tkp2-del-all" onClick={() => { setSel(new Set(sorted.map((t) => t.id))); setDelAsk(true); }} title={`Select every archived ${noun} in view and delete them`}>
                <TkIco d="trash" />Delete all {sorted.length}
              </button>
            )}
            <em>{board ? boardItems.length : sorted.length} {noun}s</em>
          </div>
        )}
        {bulkBar}
        {colWindow}
        {err && <p className="tk-err">{err}</p>}
        {!ready && data && <p className="tk-note">{NEEDS_SQL} Until then your tasks show here with their status.</p>}

        <div className="tkp2-body">
          <div className="tkp2-main">
            <SectionSwap k={`${section}:${pane === "inbox" ? "" : board ? "board" : "list"}`} rank={section === "inbox" ? 0 : section === "ticket" ? 1 : 2}>
              {pane === "inbox" ? inboxPane : board ? boardView : listView}
            </SectionSwap>
          </div>
          <SlidePane wide={sideMail ? mailWide : wide}>
            {sideMail && preview ? (
              <MailPreview key={preview.id} inline wide={mailWide} onWide={() => setMailWide(!mailWide)} m={preview} boxes={boxes} onClose={() => setPreview(null)} onCreate={() => mailToTicket(preview)} onTask={() => mailToTask(preview)}
                onAdd={(rect) => setAddPick({ m: preview, rect })} onRule={() => ruleFrom(preview)} onIgnore={() => mailIgnore(preview)} />
            ) : open && dir && !board ? (
              <TicketDrawer key={openT?.id ?? "new"} inline ticket={openT} draft={creating} {...drawerProps} wide={wide} onWide={() => setWide(!wide)} />
            ) : null}
          </SlidePane>
        </div>
        {/* on the board a ticket / task opens as the same sheet as in the list, floating over the board */}
        {open && dir && board && (
          <div className="tkp2-float" onMouseDown={(e) => { if (e.target === e.currentTarget) drawerProps.onClose(); }}>
            <div className="tkp2-float-card">
              <TicketDrawer key={openT?.id ?? "new"} inline ticket={openT} draft={creating} {...drawerProps} />
            </div>
          </div>
        )}
        {viewsAt && (
          <Pop anchor={viewsAt} onClose={() => { setViewsAt(null); setViewName(null); }} width={260}>
            <div className="tk-pop-list">
              <span className="tk-pop-k">Saved views</span>
              {views.map((v) => (
                <div key={v.name} className={`tkp2-view ${isView(v) ? "is-on" : ""}`}>
                  <button type="button" className="tk-pop-opt" onClick={() => { applyView(v); setViewsAt(null); }}><TkIco d="bookmark" /><span>{v.name}</span>{isView(v) && <TkIco d="check" className="tk-pop-tick" />}</button>
                  <button type="button" className="tkp2-view-x" onClick={() => storeViews(views.filter((x) => x.name !== v.name))} aria-label={`Delete view ${v.name}`}><TkIco d="x" /></button>
                </div>
              ))}
              {!views.length && <p className="tk-pop-empty">No saved views yet. Filter the list, then save it here.</p>}
              {viewName !== null ? (
                <input className="tk-pop-q" autoFocus value={viewName} placeholder="Name this view…" onChange={(e) => setViewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { saveView(); setViewsAt(null); } if (e.key === "Escape") setViewName(null); }} />
              ) : (
                <button type="button" className="tk-pop-opt" onClick={() => setViewName("")}><TkIco d="plus" /><span>Save this view</span></button>
              )}
            </div>
          </Pop>
        )}
        {overlays}
      </div>
    );
  }

  if (full) {
    return (
      <div className="tk-full" role="dialog" aria-label="Tickets">
        <header className="tk-full-head">
          <div>
            <span className="hs-eyebrow">{isT ? "Ticket desk" : "Task desk"}</span>
            <h2 className="tk-full-title">{counts[tab]} open {tab === "mine" ? "on your desk" : tab === "team" ? "in your team" : tab === "unassigned" ? "without an owner" : "in the company"}</h2>
          </div>
          {breached > 0 && <span className="tk-breach-pill"><TkIco d="bolt" />{breached} past SLA</span>}
          <button type="button" className="tk-icon-btn" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><TkIco d="keyboard" /></button>
          {syncBtn}
          <button type="button" className="tk-icon-btn" onClick={() => setSettings({})} title="Mail rules and mailboxes" aria-label="Mail rules and mailboxes"><TkIco d="gear" /></button>
          <button type="button" className="tk-new" onClick={() => setCreating(newDraft())}><TkIco d="plus" />New {noun}</button>
          {onShrink && <button type="button" className="tk-icon-btn" onClick={onShrink} title="Back to the narrow panel" aria-label="Back to the narrow panel"><TkIco d="shrink" /></button>}
          {onExpand && <button type="button" className="tk-icon-btn" onClick={() => { if (onExpand()) return; navTo(isT ? "/tickets" : "/tickets?kind=task"); }} title={expandTitle ?? `Open the ${isT ? "Tickets" : "Tasks"} page`} aria-label={expandTitle ?? `Open the ${isT ? "Tickets" : "Tasks"} page`}><TkIco d="expand" /></button>}
          {(onClose || !onExpand) && <button type="button" className="tk-icon-btn" onClick={onClose} aria-label="Close"><TkIco d="x" /></button>}
        </header>
        <div className="tk-full-body">
          <nav className="tk-full-nav">
            <div className="tk-full-kind">{kindSwitch}</div>
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
    <section className={`hs-card tk-desk is-${kind} ${sel.size ? "has-sel" : ""} ${composing ? "is-composing" : ""}`} aria-label={isT ? "Tickets" : "Tasks"}>
      {/* one line on top: tickets | tasks, how many are late, settings and the full page */}
      <header className="tk-top">
        {deskSwitch}
        {lateCount > 0 && pane !== "inbox" && <button type="button" className="tk-late" onClick={() => { setPane("tickets"); setView("active"); setSort("due"); }} title={`${lateCount} past their due date`}>{lateCount}<span> late</span></button>}
        {isT && pane !== "inbox" && breached > 0 && <span className="tk-breach-pill is-sm" title="Past their SLA"><TkIco d="bolt" />{breached}</span>}
        <span className="td-spacer" />
        {syncBtn}
        {onShrink && <button type="button" className="tk-icon-btn" onClick={onShrink} title="Back to the narrow panel" aria-label="Back to the narrow panel"><TkIco d="shrink" /></button>}
        <button type="button" className="tk-icon-btn" onClick={() => { if (onExpand?.()) return; navTo(pane === "inbox" ? "/tickets?kind=inbox" : isT ? "/tickets" : "/tickets?kind=task"); }} title={expandTitle ?? `Open the ${isT ? "Tickets" : "Tasks"} page`} aria-label={expandTitle ?? `Open the ${isT ? "Tickets" : "Tasks"} page`}><TkIco d="expand" /></button>
      </header>
      {/* one line under it: whose (icons) · a magnifier · what shows and in which order */}
      {pane !== "inbox" && (qOpen || q ? (
        <div className="tk-bar2 is-q">
          <div className="tk-q">
            <TkIco d="search" />
            <input ref={qRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${noun}s…`}
              onBlur={() => { if (!q) setQOpen(false); }}
              onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); setQOpen(false); (e.target as HTMLInputElement).blur(); } }} />
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setQ(""); setQOpen(false); }} aria-label="Close the filter"><TkIco d="x" /></button>
          </div>
        </div>
      ) : (
        <div className="tk-bar2">
          <div className="tk-tabs is-icons" role="tablist">
            {DESK_TABS.map((x) => (
              <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} aria-label={x.label} title={x.hint} className={tab === x.key ? "is-on" : ""} onClick={() => { setTab(x.key); setPane("tickets"); }}>
                <TkIco d={x.icon} /><span className="tk-tab-l">{x.label}</span>{counts[x.key] > 0 && <i>{counts[x.key]}</i>}
              </button>
            ))}
          </div>
          <button type="button" className="tk-bar2-btn" onClick={() => setQOpen(true)} title={`Filter ${noun}s (/)`} aria-label={`Filter ${noun}s`}><TkIco d="search" /></button>
          <button type="button" className={`tk-bar2-view ${view !== "active" || sort !== "due" ? "is-set" : ""}`} onClick={(e) => setSortMenu(e.currentTarget.getBoundingClientRect())}
            title={`Showing ${view === "active" ? "open" : view === "waiting" ? (isT ? "waiting" : "blocked") : "done"} ${noun}s · sorted by ${(SORTS.find((x) => x.key === sort)?.label ?? "").toLowerCase()}`}>
            <span>{view === "active" ? "Open" : view === "waiting" ? (isT ? "Waiting" : "Blocked") : "Done"}</span><TkIco d="chev" />
          </button>
        </div>
      ))}
      {pane === "inbox" ? (
        <>
          <div className="tk-bar2 is-q">
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
      {/* the add box: typing in it turns the card into the new task (the list steps aside) */}
      <div ref={composeRef} className={`tk-cw ${composing ? "is-on" : ""}`}
        onBlur={(e) => {
          const to = e.relatedTarget as HTMLElement | null;
          if (to && (composeRef.current?.contains(to) || to.closest?.(".tk-pop, .dp-pop, .dp-layer, .mi-pop, .sel-pop"))) return;
          if (!draft.trim() && !cd.description.trim() && !cd.checklist.length && !cd.watchers.length && !cd.due) closeCompose();
        }}
        onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented && composing) { e.preventDefault(); closeCompose(); (document.activeElement as HTMLElement | null)?.blur(); } }}>
        <div className="tk-quick">
          <button type="button" className={`tk-quick-prio is-${draftPrio}`} onClick={cyclePrio} title={`Priority: ${PRIORITY_LABEL[draftPrio]} (click to change)`} tabIndex={-1}><FlagIcon /></button>
          <MentionInput value={draft} onChange={(v) => { setDraft(v); if (v.includes("@[")) tagFrom(v); }} people={mentionPeople} onEnter={quickAdd} className="tk-quick-ed"
            placeholder={isT ? (tab === "unassigned" ? "Log a message or call for the team…" : "Log a message, call or request…") : composing ? "What needs doing? @name to tag someone" : tab === "unassigned" ? "Add a task for the team…" : "Add a task…"} />
          {draft.trim() && <button type="button" className="tk-quick-more" onClick={moreOptions} title={`Add details: owner, date, people, steps… (the full ${noun} form)`} aria-label="Add details"><TkIco d="expand" /></button>}
          <button type="button" className="tk-quick-go" onClick={() => (draft.trim() ? quickAdd() : setCreating(newDraft()))} disabled={adding}
            title={draft.trim() ? `Add it (Enter)` : `New ${noun}: the guided form`} aria-label={draft.trim() ? "Add" : `New ${noun}`}><TkIco d="plus" /></button>
        </div>
        <div className="tk-compose" inert={!composing ? true : undefined}><div className="tk-compose-in tdx">
          <div className="tkc-f" style={{ ["--i" as string]: 0 } as React.CSSProperties}>
            <MentionInput multiline value={cd.description} onChange={(v) => { setCd((c) => ({ ...c, description: v })); if (v.includes("@[")) tagFrom(v); }} people={mentionPeople} className="tkc-desc"
              placeholder={isT ? "What was asked or said… @mention a colleague" : "Details: what done looks like… @mention someone"} />
          </div>
          <div className="tkc-row" style={{ ["--i" as string]: 1 } as React.CSSProperties}>
            <span className="tkc-k">Priority</span>
            <div className="tkc-prio" role="radiogroup" aria-label="Priority">
              {[...TASK_PRIORITIES].reverse().map((p) => (
                <button key={p} type="button" role="radio" aria-checked={draftPrio === p} className={`is-${p} ${draftPrio === p ? "is-on" : ""}`} onClick={() => setDraftPrio(p)}><FlagIcon />{PRIORITY_LABEL[p]}</button>
              ))}
            </div>
          </div>
          <div className="tkc-row" style={{ ["--i" as string]: 2 } as React.CSSProperties}>
            <span className="tkc-k">Due</span>
            <div className="tkc-due">
              {([["Today", dayFrom(0)], ["Tomorrow", dayFrom(1)], ["Next week", nextMonday()]] as const).map(([l, iso]) => (
                <button key={l} type="button" className={dayOf(cd.due) === iso ? "is-on" : ""} onClick={() => setDue(dayOf(cd.due) === iso ? null : iso)}>{l}</button>
              ))}
              <span className={`tkc-dp ${cd.due ? "is-set" : ""}`}><DatePicker value={dayOf(cd.due) ?? ""} onChange={(iso) => setDue(iso || null)} placeholder="Pick a day" /></span>
            </div>
          </div>
          <div className="tkc-row" style={{ ["--i" as string]: 3 } as React.CSSProperties}>
            <span className="tkc-k">Owner</span>
            <button type="button" className={`tkc-person ${cd.assignee ? "" : "is-empty"}`} onClick={(e) => setCPop({ k: "owner", rect: e.currentTarget.getBoundingClientRect() })}>
              <Avatar person={person(cd.assignee)} size={22} /><span>{cd.assignee ? (cd.assignee === me ? "Me" : person(cd.assignee)?.name ?? "Someone") : "Nobody yet"}</span><TkIco d="chev" className="tkc-chev" />
            </button>
          </div>
          <div className="tkc-row is-top" style={{ ["--i" as string]: 4 } as React.CSSProperties}>
            <span className="tkc-k">Watchers</span>
            <div className="tkc-people">
              {cd.watchers.map((w) => (
                <span key={w} className="tkc-chip"><Avatar person={person(w)} size={20} />{person(w)?.name.split(/\s+/)[0] ?? "Someone"}
                  <button type="button" onClick={() => setCd((c) => ({ ...c, watchers: c.watchers.filter((x) => x !== w) }))} aria-label="Remove"><TkIco d="x" /></button></span>
              ))}
              <button type="button" className="tkc-add" onClick={(e) => setCPop({ k: "people", rect: e.currentTarget.getBoundingClientRect() })}><TkIco d="plus" />{cd.watchers.length ? "" : "Add people"}</button>
            </div>
          </div>
          {dir && (
            <div className="tkc-steps" style={{ ["--i" as string]: 5 } as React.CSSProperties}>
              <StepsPanel t={{ checklist: cd.checklist } as Ticket} dir={dir} people={mentionPeople} onTask={[cd.assignee, ...cd.watchers].filter(Boolean) as string[]}
                onChecklist={(list) => setCd((c) => ({ ...c, checklist: list }))}
                onInvolve={(ids) => setCd((c) => ({ ...c, watchers: [...new Set([...c.watchers, ...ids.filter((id) => id && id !== c.assignee)])] }))} />
            </div>
          )}
          <div className="tkc-foot" style={{ ["--i" as string]: 6 } as React.CSSProperties}>
            <button type="button" className="tkc-more" onClick={moreOptions} title="Open it in the full window: links, type, team…"><TkIco d="expand" />More options</button>
            <span className="td-spacer" />
            <button type="button" className="td-ghost is-sm" onClick={closeCompose}>Cancel</button>
            <button type="button" className="td-primary is-sm" onClick={quickAdd} disabled={!draft.trim() || adding}>{adding ? "Creating…" : `Create ${noun}`}</button>
          </div>
        </div></div>
        {cPop && dir && (
          <Pop anchor={cPop.rect} onClose={() => setCPop(null)} width={260}>
            {cPop.k === "owner" ? (
              <PeopleMenu dir={dir} value={cd.assignee} noneLabel="Nobody" onPick={(id) => { setCPop(null); setCd((c) => ({ ...c, assignee: id, watchers: c.watchers.filter((w) => w !== id) })); }} />
            ) : (
              <PeopleMenu dir={dir} value={null} allowNone={false} picked={cd.watchers}
                onPick={(id) => { if (id) setCd((c) => ({ ...c, watchers: c.watchers.includes(id) ? c.watchers.filter((x) => x !== id) : [...c.watchers, id] })); }} />
            )}
          </Pop>
        )}
      </div>
      <div className="tk-body">
        {bulkBar}
        {err && <p className="tk-err">{err}</p>}
        {list}
      </div>
      {overlays}
      </>}
    </section>
  );
}

/* ------------------------------ the drawer ------------------------------ */
const ago2 = (iso: string) => ago(iso);
function eventText(e: TicketEvent, dir: Directory, cat: ItemCat = "ticket"): string {
  const d = e.detail ?? {};
  const who = (id: any) => (id ? dir.people.find((p) => p.id === id)?.name ?? "someone" : "nobody");
  switch (e.action) {
    case "created": return d.source === "email" ? "opened it from an e-mail" : cat === "task" ? "created the task" : "opened the ticket";
    case "stage": return `moved it to ${stageLabel(d.to, cat)}`;
    case "priority": return `set priority to ${PRIORITY_LABEL[d.to as TaskPriority] ?? d.to}`;
    case "assignee": return d.to ? `gave it to ${who(d.to)}` : "left it unassigned";
    case "due": return d.to ? `set the due date to ${new Date(d.to).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "removed the due date";
    case "type": return `changed the type to ${d.to ?? "none"}`;
    case "title": return d.to ? `renamed it “${plain(String(d.to))}”` : "renamed it";
    case "description": return "edited the description";
    case "category": return d.to === "task" ? "turned it into a task" : "turned it into a ticket";
    case "client": case "company": case "deal": case "project": {
      const list = e.action === "client" ? dir.clients : e.action === "company" ? dir.companies : e.action === "deal" ? dir.deals : dir.projects;
      const name = (id: any) => (id ? list.find((x) => x.id === id)?.name ?? `a ${e.action}` : null);
      return d.to ? `linked it to ${name(d.to)}` : `took off the ${e.action}${d.from && name(d.from) !== `a ${e.action}` ? ` ${name(d.from)}` : ""}`;
    }
    case "step_add": return `added the step “${plain(String(d.text ?? ""))}”`;
    case "step_done": return `${d.done ? "ticked" : "unticked"} “${plain(String(d.text ?? ""))}”`;
    case "step_who": return d.to ? `gave “${plain(String(d.text ?? ""))}” to ${who(d.to)}` : `took “${plain(String(d.text ?? ""))}” off its person`;
    case "step_remove": return `removed the step “${plain(String(d.text ?? ""))}”`;
    case "watcher_add": return `added ${who(d.who)} as a watcher`;
    case "watcher_remove": return `took ${who(d.who)} off the watchers`;
    default: return e.action;
  }
}

/** The next step a ticket usually takes, for the sheet's main button. */
const NEXT_STEP: Record<TicketStage, { label: string; to: TicketStage } | null> = {
  new: { label: "Accept", to: "open" },
  open: { label: "Start work", to: "in_progress" },
  in_progress: { label: "Resolve", to: "resolved" },
  waiting: { label: "Resume", to: "in_progress" },
  resolved: { label: "Close", to: "closed" },
  closed: { label: "Reopen", to: "open" },
};
const NEXT_TASK_STEP: Record<TicketStage, { label: string; to: TicketStage } | null> = {
  new: { label: "Accept", to: "open" },
  open: { label: "Start", to: "in_progress" },
  in_progress: { label: "Mark done", to: "resolved" },
  waiting: { label: "Unblock", to: "in_progress" },
  resolved: { label: "Archive", to: "closed" },
  closed: { label: "Reopen", to: "open" },
};

/* ---- "Linked to" suggestions: client / company / deal / project names written in the title or the steps ---- */
type LinkKind = "client" | "company" | "deal" | "project";
interface LinkSuggestion { kind: LinkKind; id: string; name: string }
const LINK_FIELD: Record<LinkKind, "clientId" | "companyId" | "trackingId" | "projectId"> = { client: "clientId", company: "companyId", deal: "trackingId", project: "projectId" };
const foldTxt = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const wordsOf = (s: string) => foldTxt(s).replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
/** Words that say nothing about which company it is (legal forms, "group", articles…). */
const NAME_NOISE = new Set(["grupo", "group", "groupe", "gruppo", "holding", "holdings", "sl", "slu", "sa", "sau", "sc", "scoop", "coop", "sll", "sociedad", "limitada", "anonima",
  "inc", "ltd", "llc", "gmbh", "ag", "bv", "nv", "spa", "srl", "sas", "sarl", "plc", "co", "cia", "corp", "corporation", "company", "compania", "the", "de", "del", "la", "las", "los", "el", "y", "and", "e", "s", "l", "u", "a"]);
/** Words of a task that aren't names: what you do, not who for. */
const TASK_NOISE = new Set(["mandar", "enviar", "envio", "propuesta", "propuestas", "oferta", "presupuesto", "reunion", "llamar", "llamada", "preparar", "cerrar", "detalles", "tecnicos", "tecnico",
  "revisar", "hablar", "seguimiento", "contrato", "factura", "facturas", "con", "para", "sobre", "desde", "hacia", "entre", "pedir", "confirmar", "enviarle", "mandarle", "economica", "economico",
  "send", "proposal", "meeting", "call", "follow", "review", "prepare", "close", "with", "about", "from", "invoice", "contract", "check", "update", "demo", "kickoff", "workshop", "this", "that", "next", "week"]);
/** A name's distinctive words: "Grupo Mundomovil, S.L." → ["mundomovil"]. */
const coreOf = (name: string) => wordsOf(name).filter((w) => !NAME_NOISE.has(w));
/** Is this name written in the text (all its distinctive words, or them run together)? */
function nameIn(name: string, textWords: Set<string>, textJoined: string): boolean {
  const core = coreOf(name);
  const joined = core.join("");
  if (!core.length || joined.length < 4) return false;
  if (core.every((w) => textWords.has(w))) return true;
  return joined.length >= 6 && textJoined.includes(joined);
}
/** Suggested links for a ticket: names from the title, description and steps, found among clients, companies, deals and projects. */
/* ---- what to fill in: type, team and tags learned from the tickets / tasks you already have ----
   Each earlier one is compared with this one: same requester (e-mail or contact) and same company / client /
   deal count most, then the e-mail domain, then the words of the title and description (rarer words weigh
   more, like TF-IDF), newer ones a little more. The closest ones then vote for their type, team and tags;
   a value is suggested only when enough of them agree. With little history the type's own name in the text
   and the owner's department fill the gaps. Runs in the browser, in a few ms for thousands of tickets. */
export interface FieldSuggestions { type: { value: string; why: string } | null; team: { value: string; why: string } | null; tags: { value: string; why: string }[] }
const STOP = new Set(("the and for with that this from have has are was were you your our not but can could would should will just about into " +
  "una uno unos unas los las del por para con que como pero sus nos este esta esto estos estas hola gracias saludos buenos dias tardes " +
  "please thanks thank regards hello dear team mail email correo asunto subject fwd").split(" "));
const FREE_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.es", "live.com", "msn.com", "yahoo.com", "yahoo.es", "icloud.com", "me.com", "proton.me", "protonmail.com"]);
function ticketFeatures(t: Ticket): Map<string, number> {
  const out = new Map<string, number>();
  const add = (k: string, w: number) => out.set(k, Math.max(out.get(k) ?? 0, w));
  const email = (t.requesterEmail ?? "").trim().toLowerCase();
  if (email) {
    add(`@mail:${email}`, 5);
    const d = email.split("@")[1];
    if (d && !FREE_DOMAINS.has(d)) add(`@dom:${d}`, 2.5);
  }
  if (t.requesterContactId) add(`@contact:${t.requesterContactId}`, 5);
  if (t.companyId) add(`@co:${t.companyId}`, 3);
  if (t.clientId) add(`@cl:${t.clientId}`, 3);
  if (t.trackingId) add(`@deal:${t.trackingId}`, 3);
  if (t.projectId) add(`@proj:${t.projectId}`, 3);
  if (t.source) add(`@src:${t.source}`, 0.4);
  const text = fold(`${plain(t.title)} ${plain(t.title)} ${plain(t.description).slice(0, 700)}`);
  for (const w of text.split(/[^a-z0-9]+/)) if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) add(w, 1);
  return out;
}
export function suggestFields(t: Ticket, history: Ticket[], dir: Directory, types: string[]): FieldSuggestions {
  const others = history.filter((h) => h.id !== t.id && !h.mergedInto);
  const me = ticketFeatures(t);
  const res: FieldSuggestions = { type: null, team: null, tags: [] };
  if (others.length) {
    // how rare each feature is (inverse document frequency)
    const df = new Map<string, number>();
    const feats = others.map((h) => { const f = ticketFeatures(h); f.forEach((_, k) => { if (me.has(k)) df.set(k, (df.get(k) ?? 0) + 1); }); return f; });
    const N = others.length, now = Date.now();
    const scored = others.map((h, i) => {
      let sim = 0;
      me.forEach((w, k) => { const hw = feats[i].get(k); if (hw) sim += Math.min(w, hw) * Math.log(1 + N / (df.get(k) ?? 1)); });
      if (h.category !== t.category) sim *= 0.6;
      const ageDays = Math.max(0, (now - new Date(h.updatedAt ?? h.createdAt).getTime()) / 86_400_000);
      return { h, sim: sim * (1 + 0.4 * Math.exp(-ageDays / 45)) };
    }).filter((x) => x.sim > 0.8).sort((a, b) => b.sim - a.sim).slice(0, 30);
    const vote = (pick: (h: Ticket) => string[]) => {
      const tally = new Map<string, number>(); let total = 0;
      for (const { h, sim } of scored) { const vs = pick(h); if (!vs.length) continue; total += sim; vs.forEach((v) => tally.set(v, (tally.get(v) ?? 0) + sim)); }
      return [...tally.entries()].map(([value, score]) => ({ value, score, share: total ? score / total : 0, n: scored.filter((x) => pick(x.h).includes(value)).length }))
        .sort((a, b) => b.score - a.score);
    };
    const why = (n: number) => (n === 1 ? "Like 1 similar one" : `Like ${n} similar ones`);
    const ty = vote((h) => (h.type ? [h.type] : []))[0];
    if (ty && ty.share >= 0.4 && ty.score >= 2) res.type = { value: ty.value, why: why(ty.n) };
    const tm = vote((h) => (h.team ? [h.team] : []))[0];
    if (tm && tm.share >= 0.4 && tm.score >= 2) res.team = { value: tm.value, why: why(tm.n) };
    res.tags = vote((h) => h.tags).filter((x) => x.share >= 0.25 && x.score >= 1.5 && !t.tags.includes(x.value)).slice(0, 3).map((x) => ({ value: x.value, why: why(x.n) }));
  }
  // little history: the type's own name in the text; the owner's department
  if (!res.type) {
    const text = fold(`${plain(t.title)} ${plain(t.description).slice(0, 700)}`);
    const hit = types.find((x) => x.length >= 3 && new RegExp(`\\b${fold(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text));
    if (hit) res.type = { value: hit, why: "Named in the text" };
  }
  if (!res.team && t.assignee) {
    const d = dir.people.find((p) => p.id === t.assignee)?.department;
    if (d) res.team = { value: d, why: "The owner's team" };
  }
  if (res.type && t.type) res.type = null;
  if (res.team && t.team) res.team = null;
  return res;
}

function useLinkSuggestions(t: Ticket, dir: Directory, enabled: boolean): LinkSuggestion[] {
  const text = useMemo(() => plain([t.title, t.description, ...(t.checklist ?? []).map((s) => s.text)].join(" \n ")), [t.title, t.description, t.checklist]);
  const [found, setFound] = useState<LinkSuggestion[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) { setFound([]); return; }
    const tw = new Set(wordsOf(text));
    const tj = wordsOf(text).join("");
    const local = () => {
      const out: LinkSuggestion[] = [];
      const scan = (kind: LinkKind, list: { id: string; name: string; legal?: string | null }[]) =>
        list.forEach((x) => { if (nameIn(x.name, tw, tj) || (x.legal && nameIn(x.legal, tw, tj))) out.push({ kind, id: x.id, name: x.name }); });
      scan("client", dir.clients); scan("company", dir.companies); scan("deal", dir.deals); scan("project", dir.projects);
      // a company found: its deals too
      out.filter((x) => x.kind === "company").forEach((c) => dir.deals.filter((d) => d.companyId === c.id && d.status !== "lost").forEach((d) => {
        if (!out.some((y) => y.kind === "deal" && y.id === d.id)) out.push({ kind: "deal", id: d.id, name: d.name });
      }));
      return out;
    };
    setFound(local());
    if (!dir.remote) return;
    // companies and deals live in the database: ask for the words that look like names
    let alive = true;
    const terms = [...new Set(wordsOf(text).filter((w) => w.length >= 4 && !TASK_NOISE.has(w) && !NAME_NOISE.has(w)))].slice(0, 5);
    if (!terms.length) return;
    const h = window.setTimeout(async () => {
      await Promise.all(terms.flatMap((w) => [dirSearch(dir, "company")(w).catch(() => []), dirSearch(dir, "deal")(w).catch(() => [])]));
      if (alive) setFound(local());
    }, 500);
    return () => { alive = false; window.clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, enabled, dir, tick]);
  useEffect(() => { const f = () => setTick((x) => x + 1); window.addEventListener(DIR_EVENT, f); return () => window.removeEventListener(DIR_EVENT, f); }, []);
  // only for what isn't linked yet, best first, a handful
  const order: LinkKind[] = ["client", "company", "deal", "project"];
  return found.filter((x) => !t[LINK_FIELD[x.kind]]).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, 4);
}

export function TicketDrawer({ ticket, draft, dir, types, ready, tickets, inline = false, wide = false, onWide, onClose, onCreated, onLocal, onTypes }: {
  ticket: Ticket | null;
  /** On the Tickets page: shown at full width (the list hidden), and the button that switches it. */
  wide?: boolean; onWide?: () => void;
  /** Shown inside the Tickets page, next to the list (no window over the page). */
  inline?: boolean;
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
    firstResponseAt: null, mergedInto: null, category: "ticket",
    ...(draft ?? {}),
  };
  const [t, setT0] = useState<Ticket>(ticket ?? blank);
  /** The latest ticket, also between a change and the next render (several changes in a row). */
  const tRef = useRef<Ticket>(t);
  const setT = (next: Ticket) => { tRef.current = next; setT0(next); };
  useEffect(() => { if (ticket) setT(ticket); }, [ticket]); // eslint-disable-line react-hooks/exhaustive-deps
  /** A task is work: no requester, no SLA, no replies by e-mail — notes and progress only. */
  const isTask = t.category === "task";
  const noun = isTask ? "task" : "ticket";
  const [thread, setThread] = useState<{ posts: TicketPost[]; events: TicketEvent[]; files?: TicketFile[] } | null>(null);
  /* files and pictures: dropped anywhere on the sheet (or pasted, or picked) they wait in the composer, go with the comment, and sit in the Files folder */
  const [staged, setStaged] = useState<{ id: string; file: File; url: string | null }[]>([]);
  const [dropOn, setDropOn] = useState(false);
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [viewer, setViewer] = useState<TicketFile | null>(null);
  const [folderOpen, setFolderOpen] = useState(true);
  const fileIn = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const [reply, setReply] = useState("");
  const [mode, setMode] = useState<"internal" | "reply">("internal");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [delAsk, setDelAsk] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [reqEdit, setReqEdit] = useState(false);
  /** The requester's e-mail already belongs to a CRM contact (found by searching the CRM). */
  const [reqMatch, setReqMatch] = useState<{ id: string; name: string } | null>(null);
  const [reqBusy, setReqBusy] = useState(false);
  const [newType, setNewType] = useState<string | null>(null);
  const [watchAdd, setWatchAdd] = useState<DOMRect | null>(null);
  const [moreAt, setMoreAt] = useState<DOMRect | null>(null);
  // on the Tickets page the details (type, requester, links, SLA…) sit in a side panel you open when you need it
  const [sideOpen, setSideOpenState] = useState(() => { try { return localStorage.getItem("ticketSide") === "1"; } catch { return false; } });
  const setSideOpen = (v: boolean) => { setSideOpenState(v); try { localStorage.setItem("ticketSide", v ? "1" : "0"); } catch { /* fine */ } };
  /** Description, steps and conversation fold away on a click (remembered on this computer). */
  const folds = useFolds();
  /** Making a new one is a guided walk: details, links, what & who, description, steps, then a last look. */
  const [wStep, setWStep] = useState(0);
  const [wBack, setWBack] = useState(false);
  const [wSeen, setWSeen] = useState(0);
  /* telling the owner and the watchers when it's created: who, and through which of your connected channels (in Next always) */
  const [ntTo, setNtTo] = useState<Set<string> | null>(null);
  const [ntCh, setNtCh] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem("tkNotifyCh") ?? "[]")); } catch { return new Set(); } });
  const [ntChannels, setNtChannels] = useState<{ key: string; label: string; sub: string; kind: "outlook" | "gmail" | "ionos" | "whatsapp" }[] | null>(null);
  const [ntPreview, setNtPreview] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [sendNote, setSendNote] = useState<string | null>(null);
  /** The header's pickers: stage, priority, owner, watchers. */
  const [propAt, setPropAt] = useState<{ k: "stage" | "prio" | "owner" | "people"; rect: DOMRect } | null>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  /** The left pane's scroll: after you post, it goes to the newest message. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const toBottom = () => window.setTimeout(() => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }, 80);
  // e-mail, SLA, merging
  const [mails, setMails] = useState<MailMsg[] | null>(null);
  const [mailOk, setMailOk] = useState<OutlookMailStatus | null>(null);
  const [boxes, setBoxes] = useState<Mailbox[]>([]);
  const [sla, setSla] = useState<SlaMap | null>(null);
  const [byMail, setByMail] = useState(true);
  const [fromAddr, setFromAddr] = useState("");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  /** The signature a reply by e-mail ends with: null = your default, "" = none, else its id. */
  const [sigId, setSigId] = useState<string | null>(null);
  const [sigAt, setSigAt] = useState<DOMRect | null>(null);
  const [sigManage, setSigManage] = useState(false);
  const sigs = useSignatures();
  const sig = sigId === "" ? null : (sigs ?? []).find((s) => (sigId ? s.id === sigId : s.isDefault)) ?? null;
  const [needPerm, setNeedPerm] = useState(false);
  const [mergeAt, setMergeAt] = useState<DOMRect | null>(null);
  const [mergeInto, setMergeInto] = useState<Ticket | null>(null);
  const [pickList, setPickList] = useState<Ticket[] | null>(tickets ?? null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { if (ticket) loadTicketThread(ticket.id).then(setThread).catch(() => setThread({ posts: [], events: [] })); }, [ticket?.id]);
  const tFiles = thread?.files ?? [];
  const filePaths = tFiles.map((x) => x.path).join("|");
  useEffect(() => {
    const need = tFiles.map((x) => x.path).filter((p) => !fileUrls[p]);
    if (need.length) ticketFileUrls(need).then((u) => setFileUrls((x) => ({ ...x, ...u }))).catch(() => {});
  }, [filePaths]); // eslint-disable-line react-hooks/exhaustive-deps
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  useEffect(() => () => { stagedRef.current.forEach((x) => x.url && URL.revokeObjectURL(x.url)); }, []);
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
  // a new one starts with the title in focus
  useEffect(() => { if (creatingMode) window.setTimeout(() => titleRef.current?.querySelector<HTMLElement>(".mi-editor")?.focus(), 80); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // the channels you can send a notice through: your Outlook, your connected Gmail / Outlook / IONOS mailboxes, your WhatsApp numbers
  useEffect(() => {
    if (!creatingMode || wStep !== 5 || ntChannels !== null) return;
    let alive = true;
    (async () => {
      const [st, con, assets] = await Promise.all([outlookMailStatus().catch(() => null), myConnections().catch(() => null), listAssets().catch(() => [])]);
      const out: { key: string; label: string; sub: string; kind: "outlook" | "gmail" | "ionos" | "whatsapp" }[] = [];
      const seen = new Set<string>();
      if (st?.connected && st.mail) { out.push({ key: "outlook", label: "Outlook", sub: st.email ?? "Your Outlook", kind: "outlook" }); if (st.email) seen.add(st.email.toLowerCase()); }
      for (const a of con?.mail ?? []) {
        if (a.status === "error" || seen.has((a.email ?? "").toLowerCase())) continue;
        seen.add((a.email ?? "").toLowerCase());
        out.push({ key: `acc:${a.id}`, label: a.kind === "gmail" ? "Gmail" : a.kind === "ionos" ? "IONOS Mail" : "Outlook", sub: a.email ?? "", kind: a.kind });
      }
      for (const w of assets.filter((x) => x.kind === "whatsapp_number")) out.push({ key: `wa:${w.id}`, label: "WhatsApp", sub: w.username || w.name || "WhatsApp number", kind: "whatsapp" });
      if (alive) { setNtChannels(out); setNtCh((cur0) => new Set([...cur0].filter((k) => out.some((c) => c.key === k)))); }
    })();
    return () => { alive = false; };
  }, [wStep]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || watchAdd || mergeAt || moreAt || propAt || e.defaultPrevented) return;
      // first Esc leaves the field you're typing in; the next one closes the ticket
      const el = e.target as HTMLInputElement | null;
      if (el && /input|textarea/i.test(el.tagName) && el.value) { el.blur(); return; }
      if (el && el.isContentEditable) { el.blur(); return; }
      if (document.querySelector(".sel-pop, .dp-pop, .tk-pop, .mi-pop, .msig-back, .tdx-viewer")) return;
      onClose();
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose, watchAdd, mergeAt, moreAt, propAt]);

  const set = async (p: Partial<Ticket>) => {
    const next = { ...tRef.current, ...p };
    setT(next);
    if (creatingMode) return;
    onLocal?.(next);
    const e = await saveTicket(t.id, p, ready);
    setErr(e);
    if (!e) loadTicketThread(t.id).then(setThread).catch(() => {});
  };
  /** People @mentioned or given a step join the watchers: it shows on their list and they hear about it. */
  const involve = async (ids: string[]) => {
    const cur = tRef.current;
    const add = [...new Set(ids)].filter((id) => id && id !== cur.assignee && !cur.watchers.includes(id) && dir.people.some((p) => p.id === id));
    if (!add.length) return;
    const next = { ...cur, watchers: [...cur.watchers, ...add] };
    setT(next);
    if (creatingMode) return;
    onLocal?.(next);
    await Promise.all(add.map((id) => setWatcher(cur.id, id, true)));
  };
  /** Who can be @mentioned: the people on it first, then everyone. */
  const onTask = [t.assignee, ...t.watchers].filter(Boolean) as string[];
  const mentionPeople: MentionPerson[] = useMemo(() => {
    const order = [...new Set([...onTask, ...dir.people.filter((p) => !p.former).map((p) => p.id)])];
    return order.map((id) => dir.people.find((p) => p.id === id)).filter((p): p is DirPerson => !!p)
      .map((p) => ({ id: `employee:${p.id}`, name: p.name, kind: "employee" as const }));
  }, [dir, onTask.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  /** In a comment, "@S2" points at step 2 (stored by the step's id, so it follows the step when steps move). */
  const stepPeople: MentionPerson[] = t.checklist.map((x, i) => ({ id: `step:${x.id}`, name: `S${i + 1}`, kind: "step" as const, hint: plain(x.text) }));
  const commentPeople = useMemo(() => [...mentionPeople, ...stepPeople], [mentionPeople, t.checklist]); // eslint-disable-line react-hooks/exhaustive-deps
  const stepRefs = useMemo(() => {
    const out: Record<string, string[]> = {};
    (thread?.posts ?? []).forEach((p) => stepRefsOf(p.body).forEach((id) => { (out[id] ??= []).push(p.id); }));
    return out;
  }, [thread]);
  const setDesc = (v: string) => setT({ ...tRef.current, description: v });
  const saveDesc = async () => {
    const cur = tRef.current;
    if (!creatingMode && ticket && cur.description !== ticket.description) await set({ description: cur.description });
    await involve(mentionIds(cur.description));
  };
  const create = async () => {
    if (!t.title.trim() || busy) return;
    if (createdId) { onCreated?.(createdId); return; }
    setBusy(true);
    const res = await createTicket(t, ready);
    if (res.error || !res.id) { setBusy(false); setErr(res.error); return; }
    const errs = await notifyCreated(res.id);
    setBusy(false); setSendNote(null);
    if (errs.length) { setCreatedId(res.id); setErr(`Created — but not every notice went out: ${errs.join(" · ")}`); return; }
    onCreated?.(res.id);
  };
  /** The people it can tell: the owner and the watchers (not you). */
  const ntPeople = [...new Set([t.assignee, ...t.watchers].filter(Boolean) as string[])]
    .map((id) => ({ id, p: dir.people.find((x) => x.id === id) ?? null, role: (id === t.assignee ? "owner" : "watcher") as "owner" | "watcher" }))
    .filter((x) => x.p && x.id !== dir.me);
  const ntPicked = (id: string) => (ntTo ? ntTo.has(id) : true);
  const ntOut = ntPeople.filter((x) => ntPicked(x.id));
  const ntOutCh = (ntChannels ?? []).filter((c) => ntCh.has(c.key));
  /** After it's created: one personal e-mail (or WhatsApp) per person, through each channel you picked. */
  const notifyCreated = async (id: string): Promise<string[]> => {
    if (!ntOut.length || !ntOutCh.length) return [];
    setSendNote("Sending the notices…");
    const fresh = await loadTicket(id).catch(() => ({ ticket: null }));
    const ref = fresh.ticket ? ticketRef(fresh.ticket) : `New ${noun}`;
    const link = `${publicOrigin()}/tickets?ticket=${id}`;
    const meName = person(dir.me)?.name ?? "Someone";
    const linkNames = [t.clientId && dir.clients.find((x) => x.id === t.clientId)?.name, t.companyId && dir.companies.find((x) => x.id === t.companyId)?.name,
      t.trackingId && dir.deals.find((x) => x.id === t.trackingId)?.name, t.projectId && dir.projects.find((x) => x.id === t.projectId)?.name].filter(Boolean) as string[];
    const phones = ntOutCh.some((c) => c.kind === "whatsapp")
      ? Object.fromEntries((((await supabase.from("profiles").select("id, phone").in("id", ntOut.map((x) => x.id))).data ?? []) as any[]).map((r) => [r.id, String(r.phone ?? "").replace(/[^\d+]/g, "")]))
      : {};
    const errs: string[] = [];
    for (const x of ntOut) {
      const m = ticketNoticeEmail({ isTask, ref, title: plain(t.title), description: plain(t.description), priority: t.priority, due: t.due,
        steps: t.checklist.map((st) => ({ text: plain(st.text), who: st.who ? person(st.who)?.name ?? null : null })), from: meName, to: x.p!.name, role: x.role, link, links: linkNames });
      for (const c of ntOutCh) {
        if (c.kind === "whatsapp") {
          const to = phones[x.id];
          if (!to) { errs.push(`${x.p!.name} has no phone for WhatsApp`); continue; }
          const r = await sendWhatsApp(c.key.slice(3), to, { text: m.text });
          if (r.error) errs.push(`WhatsApp to ${x.p!.name}: ${r.error}`);
          continue;
        }
        if (!x.p!.email) { errs.push(`${x.p!.name} has no e-mail`); continue; }
        const r = c.key === "outlook"
          ? await sendOutlookMail({ to: [x.p!.email], subject: m.subject, html: m.html, ref: null })
          : await sendFromAccount(c.key.slice(4), { to: [x.p!.email], subject: m.subject, html: m.html, ref: null });
        if (!r.ok) errs.push(`${c.label} to ${x.p!.name}: ${r.error ?? "not sent"}`);
      }
    }
    return errs;
  };
  const lastIn = [...(mails ?? [])].reverse().find((m) => m.direction === "in");
  const replyTo = (lastIn?.fromEmail || t.requesterEmail || "").trim();
  const mailSubject = (() => {
    // clients read "[Ticket T-1042]"; replies come back to the ticket by it (or by the Outlook conversation)
    const ref = `[Ticket ${ticketRef(t)}]`;
    const base = lastIn?.subject ? (/^(re|aw|sv):/i.test(lastIn.subject) ? lastIn.subject : `RE: ${lastIn.subject}`) : plain(t.title);
    return `${base.replace(/\s*\[(?:Ticket\s+)?T-\d+\]/gi, "").trim()} ${ref}`;
  })();
  const fromChoices = [
    { value: "", label: mailOk?.email ? `Me · ${mailOk.email}` : "My mailbox" },
    ...boxes.filter((b) => b.kind === "shared" && b.active && b.canSend).map((b) => ({ value: b.address, label: b.label ? `${b.label} · ${b.address}` : b.address })),
  ];
  const mailReady = !!mailOk?.connected && !!mailOk?.mail;
  const willMail = mode === "reply" && byMail && mails !== null;
  const send = async () => {
    if ((!reply.trim() && !staged.length) || !ticket || busy) return;
    if (willMail && !reply.trim()) { setErr("Write something to send by e-mail — or switch to an internal note to keep the files with a note."); return; }
    setBusy(true); setNeedPerm(false);
    if (willMail) {
      if (!replyTo) { setBusy(false); setErr("Add the requester's e-mail first (on the right), or untick “Send by e-mail”."); return; }
      const html = reply.trim().split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`).join("")
        + (sig ? `<br><div class="next-signature">${cleanSignature(sig.html)}</div>` : "");
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
      setBusy(false); setReply(""); setCc(""); setShowCc(false); setErr(null); toBottom();
      if (!t.firstResponseAt) { const next = { ...t, firstResponseAt: new Date().toISOString(), stage: t.stage === "new" ? "open" as TicketStage : t.stage }; setT(next); onLocal?.(next); }
      reloadMail();
      if (staged.length) { const up = await uploadTicketFiles(t.id, null, staged.map((x) => x.file)); if (up.error) setErr(up.error); clearStaged(); }
      loadTicketThread(t.id).then(setThread).catch(() => {});
      return;
    }
    const body = reply;
    const res = await postToTicket(t, body, mode, ready);
    if (res.error || !res.post) { setBusy(false); setErr(res.error); return; }
    if (staged.length) {
      const up = await uploadTicketFiles(t.id, res.post.id, staged.map((x) => x.file));
      clearStaged();
      if (up.error) { setBusy(false); setErr(up.error); loadTicketThread(t.id).then(setThread).catch(() => {}); return; }
    }
    setBusy(false);
    setReply(""); setErr(null); toBottom();
    if (mode === "internal" || isTask) void involve(mentionIds(body));
    if (mode === "reply" && !t.firstResponseAt) { const next = { ...t, firstResponseAt: new Date().toISOString() }; setT(next); onLocal?.(next); }
    loadTicketThread(t.id).then(setThread).catch(() => {});
  };
  function clearStaged() { setStaged((xs) => { xs.forEach((x) => x.url && URL.revokeObjectURL(x.url)); return []; }); }
  const stage = (list: File[]) => {
    const ok = list.filter((x) => x.size > 0);
    if (!ok.length) return;
    const big = ok.filter((x) => x.size > 50 * 1048576);
    if (big.length) setErr(`${big.map((x) => x.name).join(", ")}: over 50 MB — not added.`);
    setStaged((xs) => [...xs, ...ok.filter((x) => x.size <= 50 * 1048576).map((file) => ({ id: crypto.randomUUID(), file, url: /^image\//.test(file.type) ? URL.createObjectURL(file) : null }))]);
    if (threadFilter === "history") setThreadFilter("talk");
    window.setTimeout(() => sheetRef.current?.querySelector<HTMLElement>(".tdx-dock .mi-editor, .tdx-dock textarea")?.focus(), 60);
  };
  const unstage = (id: string) => setStaged((xs) => { const x = xs.find((y) => y.id === id); if (x?.url) URL.revokeObjectURL(x.url); return xs.filter((y) => y.id !== id); });
  const openFile = (f: TicketFile) => {
    if (isImageFile(f)) { setViewer(f); return; }
    const u = fileUrls[f.path];
    if (u) window.open(u, "_blank", "noopener");
    else ticketFileUrls([f.path]).then((x) => { setFileUrls((y) => ({ ...y, ...x })); if (x[f.path]) window.open(x[f.path], "_blank", "noopener"); }).catch(() => {});
  };
  const dropFile = async (f: TicketFile) => {
    const e = await removeTicketFile(f);
    if (e) { setErr(e); return; }
    setThread((th) => (th ? { ...th, files: (th.files ?? []).filter((x) => x.id !== f.id) } : th));
  };
  /** Goes to a spot on the sheet (a step, a comment) and makes it glow for a moment. */
  const glow = (sel: string) => {
    const el = sheetRef.current?.querySelector<HTMLElement>(sel);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("is-glow"); void el.offsetWidth; el.classList.add("is-glow");
    window.setTimeout(() => el.classList.remove("is-glow"), 1800);
  };
  const goStep = (id: string) => { if (folds.shut.steps) folds.flip("steps"); window.setTimeout(() => glow(`[data-step="${id}"]`), folds.shut.steps ? 320 : 0); };
  const goPost = (id: string) => {
    const wait = folds.shut.conv || threadFilter === "history";
    if (folds.shut.conv) folds.flip("conv");
    if (threadFilter === "history") setThreadFilter("talk");
    window.setTimeout(() => glow(`[data-post="${id}"]`), wait ? 320 : 0);
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
    const progress = checklist.length ? Math.round((checklist.filter((x) => x.done).length / checklist.length) * 100) : tRef.current.progress;
    return set({ checklist, progress });
  };
  const mergedTarget = t.mergedInto ? (pickList ?? []).find((x) => x.id === t.mergedInto) ?? null : null;
  const remove = async () => {
    const e = await deleteTicket(t.id);
    if (e) { setErr(e); setDelAsk(false); return; }
    onClose();
  };
  const toggleWatch = async (id: string) => {
    const cur = tRef.current;
    const on = !cur.watchers.includes(id);
    const next = { ...cur, watchers: on ? [...cur.watchers, id] : cur.watchers.filter((w) => w !== id) };
    setT(next);
    if (creatingMode) return;
    onLocal?.(next);
    await setWatcher(t.id, id, on);
    loadTicketThread(t.id).then(setThread).catch(() => {});
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
  const canDelete = !creatingMode && canDeleteTask({ created_by: t.createdBy }, dir.me);
  const items = [
    ...(thread?.posts ?? []).map((p) => ({ at: p.at, k: "post" as const, p })),
    ...(thread?.events ?? []).map((e) => ({ at: e.at, k: "event" as const, e })),
    // older tasks have no "created" line in their log: show when and by whom it was made anyway
    ...(thread && !creatingMode && !thread.events.some((e) => e.action === "created")
      ? [{ at: t.createdAt, k: "event" as const, e: { id: "created", author: t.createdBy, action: "created", detail: { source: t.source }, at: t.createdAt } as TicketEvent }] : []),
    ...(mails ?? []).map((m) => ({ at: m.at, k: "mail" as const, m })),
  ].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  const newestMail = (mails ?? []).length ? (mails ?? [])[(mails ?? []).length - 1].id : null;
  /** The conversation (notes / comments and e-mail), only the e-mail, or the history of changes. */
  const [threadFilter, setThreadFilter] = useState<"talk" | "mail" | "history">("talk");
  const visibleItems = items.filter((it) => (threadFilter === "talk" ? it.k !== "event" : threadFilter === "mail" ? it.k === "mail" : it.k === "event"));
  const allAtt = (mails ?? []).flatMap((m) => m.attachments.map((a) => ({ m, a })));
  const opt = (xs: { id: string; name: string }[], none: string) => [{ value: "", label: none }, ...xs.map((x) => ({ value: x.id, label: x.name }))];
  const deal = t.trackingId ? dir.deals.find((d) => d.id === t.trackingId) : null;
  // remote directory: the linked records' names, and pickers that search as you type
  useEffect(() => { void ensureDirNames(dir, { contacts: [t.requesterContactId], companies: [t.companyId], deals: [t.trackingId] }); },
    [dir.remote, t.requesterContactId, t.companyId, t.trackingId]); // eslint-disable-line react-hooks/exhaustive-deps
  const findContacts = useMemo(() => (dir.remote ? dirSearch(dir, "contact") : undefined), [dir]);
  const findCompanies = useMemo(() => (dir.remote ? dirSearch(dir, "company") : undefined), [dir]);
  /** Partners (companies with a partner type, Settings › Companies page): offered with the clients as who it's for. */
  const [partners, setPartners] = useState<{ id: string; name: string; types?: string[] }[]>([]);
  useEffect(() => { let on = true; partnerList().then((p) => { if (on) setPartners(p); }).catch(() => {}); return () => { on = false; }; }, []);
  const forPartner = t.companyId ? partners.find((x) => x.id === t.companyId) ?? null : null;
  const forValue = t.clientId ? `cl:${t.clientId}` : forPartner ? `pa:${forPartner.id}` : "";
  const forOptions = useMemo(() => [{ value: "", label: "No client or partner" },
    ...dir.clients.map((c) => ({ value: `cl:${c.id}`, label: c.name, hint: "Client" })),
    ...partners.map((p) => ({ value: `pa:${p.id}`, label: p.name, hint: p.types?.length ? `Partner · ${p.types.join(", ")}` : "Partner" }))], [dir.clients, partners]);
  const setFor = (v: string) => {
    if (!v) { void set({ clientId: null, ...(forPartner ? { companyId: null } : {}) }); return; }
    if (v.startsWith("cl:")) void set({ clientId: v.slice(3), ...(forPartner ? { companyId: null } : {}) });
    else void set({ companyId: v.slice(3), clientId: null });
  };
  const findDeals = useMemo(() => (dir.remote ? dirSearch(dir, "deal") : undefined), [dir]);
  const departments = [...new Set(dir.people.map((p) => p.department).filter(Boolean))] as string[];
  const suggestions = useLinkSuggestions(t, dir, true);
  // a requester who isn't linked yet: is their e-mail already a contact in the CRM?
  const reqMail = (t.requesterEmail ?? "").trim().toLowerCase();
  useEffect(() => {
    setReqMatch(null);
    if (isTask || t.requesterContactId || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reqMail)) return;
    const local = dir.contacts.find((c) => (c.email ?? "").toLowerCase() === reqMail);
    if (local) { setReqMatch({ id: local.id, name: local.name }); return; }
    let alive = true;
    const tm = window.setTimeout(() => {
      globalSearch(reqMail, ["contact"], 8).then((hits) => {
        if (!alive) return;
        const h = (hits ?? []).find((x) => (x.email ?? "").toLowerCase() === reqMail);
        if (h) {
          if (!dir.contacts.some((c) => c.id === h.id)) dir.contacts.push({ id: h.id, name: h.label, email: h.email ?? null, title: null });
          setReqMatch({ id: h.id, name: h.label });
        }
      }).catch(() => {});
    }, 350);
    return () => { alive = false; window.clearTimeout(tm); };
  }, [reqMail, t.requesterContactId, isTask]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The requester becomes a new CRM contact (name split in first / last, their e-mail, the ticket's company) and is linked. */
  const createRequesterContact = async () => {
    const full = (t.requesterName ?? "").trim() || reqMail.split("@")[0];
    if (!full || reqBusy) return;
    setReqBusy(true);
    const [first, ...rest] = full.split(/\s+/);
    const c = { first_name: first, last_name: rest.join(" ") || null, email: reqMail || null, companyIds: t.companyId ? [t.companyId] : [] } as Contact;
    const e = await saveContact(c);
    setReqBusy(false);
    if (e || !c.id) { setErr(e ?? "The contact wasn't created."); return; }
    dir.contacts.push({ id: c.id, name: full, email: reqMail || null, title: null });
    void set({ requesterContactId: c.id, requesterName: full });
  };
  /* type / team / tags suggested from the earlier tickets / tasks, and the tags already in use (to reuse) */
  useEffect(() => { if (!pickList) loadTickets().then((d) => setPickList(d.tickets)).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const fieldSugg = useMemo(() => (pickList ? suggestFields(t, pickList, dir, types) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pickList, dir, types, t.title, t.description, t.requesterEmail, t.requesterContactId, t.companyId, t.clientId, t.trackingId, t.projectId, t.tags.join("\u0001"), t.type, t.team, t.assignee, t.category, t.source]);
  const usedTags = useMemo(() => {
    const n = new Map<string, number>();
    (pickList ?? []).forEach((x) => x.tags.forEach((g) => n.set(g, (n.get(g) ?? 0) + 1)));
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
  }, [pickList]);
  const [tagMenu, setTagMenu] = useState(false);
  const [tagIdx, setTagIdx] = useState(0);
  const tagOpts = (() => {
    const q = fold(tagDraft.trim().replace(/^#/, ""));
    const list = usedTags.filter((x) => !t.tags.includes(x.tag) && (!q || fold(x.tag).includes(q))).slice(0, 8);
    const exact = q && usedTags.some((x) => fold(x.tag) === q);
    return { list, create: q && !exact && !t.tags.some((g) => fold(g) === q) ? tagDraft.trim().replace(/^#/, "") : "" };
  })();
  const pickTag = (v: string) => { setTagDraft(""); setTagIdx(0); if (v && !t.tags.includes(v)) void set({ tags: [...t.tags, v] }); };
  const nSugg = fieldSugg ? (fieldSugg.type ? 1 : 0) + (fieldSugg.team ? 1 : 0) + fieldSugg.tags.length : 0;
  const fillAll = () => {
    if (!fieldSugg) return;
    const p: Partial<Ticket> = {};
    if (fieldSugg.type) p.type = fieldSugg.type.value;
    if (fieldSugg.team) p.team = fieldSugg.team.value;
    if (fieldSugg.tags.length) p.tags = [...t.tags, ...fieldSugg.tags.map((x) => x.value)];
    void set(p);
  };
  const fieldPill = (label: string, why: string, onClick: () => void) => (
    <button type="button" className="tdx-pill is-fill" onClick={onClick} title={`Suggested: ${why}`}>
      <TkIco d="bolt" /><span>{label}</span><TkIco d="plus" />
    </button>
  );
  /** In an empty "Linked to" row: the name found in the title or steps, one click to link it. */
  const suggestPill = (kind: LinkKind) => {
    const x = suggestions.find((y) => y.kind === kind);
    return x ? (
      <button type="button" className="tdx-pill" onClick={() => linkSuggestion(x)} title={`Found in the ${isTask ? "task" : "ticket"}: link ${x.name}`}>
        <TkIco d="bolt" /><span>{x.name}</span><TkIco d="plus" />
      </button>
    ) : null;
  };
  const linkSuggestion = (x: LinkSuggestion) => {
    const p: Partial<Ticket> = { [LINK_FIELD[x.kind]]: x.id };
    // a deal brings its company along when that's still empty
    if (x.kind === "deal" && !t.companyId) { const d = dir.deals.find((y) => y.id === x.id); if (d?.companyId) p.companyId = d.companyId; }
    void set(p);
  };

  const next = creatingMode ? null : (isTask ? NEXT_TASK_STEP : NEXT_STEP)[t.stage];
  /** Ticket ⇄ task: the same record, moved to the other list. */
  const switchCat = async () => {
    const to: ItemCat = isTask ? "ticket" : "task";
    const p: Partial<Ticket> = { category: to, ...(to === "ticket" && !CHANNEL_SOURCES.includes(t.source) ? { source: "message" } : {}) };
    const e = await saveTicket(t.id, p, ready);
    if (e) { setErr(e); return; }
    const nextT = { ...t, ...p };
    setT(nextT); onLocal?.(nextT); setErr(null);
  };
  const late = !creatingMode && isActive(t.stage) && dueInfo(t.due, today)?.tone === "late";
  const owner = person(t.assignee);
  const crew = t.watchers.filter((w) => w !== t.assignee);
  const talkCount = (thread?.posts.length ?? 0) + (mails?.length ?? 0);
  const histCount = items.filter((it) => it.k === "event").length;
  const useMention = isTask || mode === "internal";
  const detailsBlock = (
          <div className="td-group">
            <span className="td-group-h"><TkIco d="tag" />Details
              {nSugg > 1 && <button type="button" className="tdx-sugg-all" title="Fill in what's suggested (learned from your earlier tickets)" onClick={fillAll}><TkIco d="bolt" />Fill in {nSugg}</button>}
            </span>
            <div className="td-props">
              <div className="td-prop">
                <span className="td-pk">Type</span>
                <div className="td-pv tdx-lv">
                  {newType !== null ? (
                    <input className="td-in" autoFocus value={newType} placeholder="New type…" onChange={(e) => setNewType(e.target.value)} onBlur={saveNewType}
                      onKeyDown={(e) => { if (e.key === "Enter") saveNewType(); if (e.key === "Escape") setNewType(null); }} />
                  ) : (
                    <Select value={t.type ?? ""} onChange={(v) => (v === "__new" ? setNewType("") : set({ type: v || null }))} aria-label="Type"
                      options={[{ value: "", label: "No type" }, ...types.map((x) => ({ value: x, label: x })), { value: "__new", label: "+ New type…" }]} className={t.type ? "" : "is-none"} />
                  )}
                  {!t.type && newType === null && fieldSugg?.type && fieldPill(fieldSugg.type.value, fieldSugg.type.why, () => void set({ type: fieldSugg.type!.value }))}
                </div>
              </div>
              <div className="td-prop">
                <span className="td-pk">Team</span>
                <div className="td-pv tdx-lv">
                  <Select value={t.team ?? ""} onChange={(v) => set({ team: v || null })} aria-label="Team" options={[{ value: "", label: "Any team" }, ...departments.map((d) => ({ value: d, label: deptName(d) }))]} className={t.team ? "" : "is-none"} />
                  {!t.team && fieldSugg?.team && fieldPill(deptName(fieldSugg.team.value), fieldSugg.team.why, () => void set({ team: fieldSugg.team!.value }))}
                </div>
              </div>
              {!isTask && (
                <div className="td-prop">
                  <span className="td-pk">Came in by</span>
                  <div className="td-pv">
                    <Select value={t.source} onChange={(v) => set({ source: v })} aria-label="Channel" options={Object.entries(TICKET_CHANNELS).map(([value, label]) => ({ value, label }))} />
                  </div>
                </div>
              )}
              <div className="td-prop is-top">
                <span className="td-pk">Tags</span>
                <div className="td-pv td-tags">
                  {t.tags.map((x) => <span key={x} className="td-tag">#{x}<button type="button" onClick={() => set({ tags: t.tags.filter((y) => y !== x) })} aria-label="Remove tag"><TkIco d="x" /></button></span>)}
                  <input value={tagDraft} placeholder={t.tags.length ? "+ tag" : "Add a tag…"} onChange={(e) => { setTagDraft(e.target.value); setTagIdx(0); setTagMenu(true); }} aria-label="Add a tag"
                    aria-expanded={tagMenu} aria-autocomplete="list" onFocus={() => setTagMenu(true)}
                    onKeyDown={(e) => {
                      const n = tagOpts.list.length + (tagOpts.create ? 1 : 0);
                      if (e.key === "ArrowDown" && n) { e.preventDefault(); setTagMenu(true); setTagIdx((i) => (i + 1) % n); return; }
                      if (e.key === "ArrowUp" && n) { e.preventDefault(); setTagIdx((i) => (i - 1 + n) % n); return; }
                      if (e.key === "Escape" && tagMenu) { e.preventDefault(); e.stopPropagation(); setTagMenu(false); return; }
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        if (tagMenu && tagIdx < tagOpts.list.length && (tagDraft.trim() || e.key === "Enter") && tagOpts.list[tagIdx]) pickTag(tagOpts.list[tagIdx].tag);
                        else addTag();
                      }
                    }}
                    onBlur={() => { addTag(); setTagMenu(false); }} />
                  {tagMenu && (tagOpts.list.length > 0 || tagOpts.create) && (
                    <div className="td-tag-menu" role="listbox" onMouseDown={(e) => e.preventDefault()}>
                      <span className="td-tag-menu-h">{tagDraft.trim() ? "Tags" : "Tags you've used"}</span>
                      {tagOpts.list.map((x, i) => (
                        <button key={x.tag} type="button" role="option" aria-selected={i === tagIdx} className={`td-tag-opt ${i === tagIdx ? "is-on" : ""}`} onMouseEnter={() => setTagIdx(i)} onClick={() => pickTag(x.tag)}>
                          <span>#{x.tag}</span><em>{x.count}</em>
                        </button>
                      ))}
                      {tagOpts.create && (
                        <button type="button" role="option" aria-selected={tagIdx === tagOpts.list.length} className={`td-tag-opt is-new ${tagIdx === tagOpts.list.length ? "is-on" : ""}`} onMouseEnter={() => setTagIdx(tagOpts.list.length)} onClick={() => pickTag(tagOpts.create)}>
                          <TkIco d="plus" /><span>Create #{tagOpts.create}</span>
                        </button>
                      )}
                    </div>
                  )}
                  {fieldSugg && fieldSugg.tags.length > 0 && (
                    <div className="td-tag-sugg">
                      {fieldSugg.tags.map((x) => <span key={x.value}>{fieldPill(`#${x.value}`, x.why, () => pickTag(x.value))}</span>)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
  );
  /* who asked: a card with their name and e-mail, whether they're a CRM contact, and the fields to change it */
  const requesterBlock = isTask ? null : (() => {
            const who = (t.requesterName ?? "").trim(), mail = (t.requesterEmail ?? "").trim();
            const editing = reqEdit || (!who && !mail);
            return (
              <div className="td-group tdx-req">
                <span className="td-group-h"><TkIco d="mail" />{t.source === "message" ? "From" : "Requester"}</span>
                {(who || mail) && (
                  <div className="tdx-req-card">
                    <span className="tdx-req-av" aria-hidden="true">{initials(who || mail)}</span>
                    <span className="tdx-req-t"><b title={who || mail}>{who || mail}</b>{who && mail && <small title={mail}>{mail}</small>}</span>
                    <button type="button" className={`tdx-req-edit ${reqEdit ? "is-on" : ""}`} onClick={() => setReqEdit((v) => !v)} title="Change the name or e-mail" aria-label="Change the name or e-mail" aria-pressed={reqEdit}><TkIco d="pen" /></button>
                  </div>
                )}
                {editing && (
                  <div className="tdx-req-fields">
                    <label><span>Name</span>
                      <input className="td-in" value={t.requesterName ?? ""} placeholder="Who asked" aria-label="Requester name" onChange={(e) => setT({ ...t, requesterName: e.target.value })} onBlur={() => !creatingMode && set({ requesterName: t.requesterName || null })} /></label>
                    <label><span>E-mail</span>
                      <input className="td-in" value={t.requesterEmail ?? ""} placeholder="name@company.com" type="email" aria-label="Requester e-mail" onChange={(e) => setT({ ...t, requesterEmail: e.target.value })} onBlur={() => !creatingMode && set({ requesterEmail: t.requesterEmail || null })} /></label>
                  </div>
                )}
                <div className={`tdx-req-link ${t.requesterContactId ? "is-on" : ""}`}>
                  <span className="tdx-req-k">{t.requesterContactId ? "CRM contact" : "Not a CRM contact yet"}</span>
                  <Select searchable value={t.requesterContactId ?? ""} onChange={(v) => {
                    const c = dir.contacts.find((x) => x.id === v);
                    set({ requesterContactId: v || null, ...(c ? { requesterName: c.name, requesterEmail: c.email } : {}) });
                  }} options={opt(dir.remote ? dir.contacts.filter((x) => x.id === t.requesterContactId) : dir.contacts, "Search the CRM's contacts…")} loadOptions={findContacts} aria-label="CRM contact" className={t.requesterContactId ? "" : "is-none"} />
                  {!t.requesterContactId && reqMatch && (
                    <button type="button" className="tdx-pill is-fill tdx-req-match" onClick={() => {
                      const c = dir.contacts.find((x) => x.id === reqMatch.id);
                      void set({ requesterContactId: reqMatch.id, ...(c && !t.requesterName ? { requesterName: c.name } : {}) });
                    }} title={`${reqMail} is already in your CRM`}>
                      <TkIco d="bolt" /><span>{reqMatch.name} is in your CRM — link</span><TkIco d="plus" />
                    </button>
                  )}
                  {!t.requesterContactId && !reqMatch && (who || mail) && !creatingMode && (
                    <button type="button" className="tdx-req-new" onClick={() => void createRequesterContact()} disabled={reqBusy}>
                      <TkIco d="plus" />{reqBusy ? "Adding…" : `Add ${who || mail} to the CRM`}
                    </button>
                  )}
                </div>
              </div>
            );
          })();
  const linksBlock = (
          <div className="td-group tdx-links">
            <span className="td-group-h"><TkIco d="link" />Linked to
              {suggestions.length > 1 && (
                <button type="button" className="tdx-sugg-all" title="Link everything found in the title and steps" onClick={() => {
                  const p: Partial<Ticket> = {};
                  suggestions.forEach((x) => { if (!p[LINK_FIELD[x.kind]]) (p as any)[LINK_FIELD[x.kind]] = x.id; });
                  void set(p);
                }}><TkIco d="bolt" />Link all {suggestions.length}</button>
              )}
            </span>
            <div className="td-props">
              <div className="td-prop is-for">
                <span className="td-pk">Client or partner</span>
                <div className="td-pv tdx-lv"><Select searchable value={forValue} onChange={setFor} options={forOptions} aria-label="Client or partner" className={forValue ? "" : "is-none"} placeholder="Pick the client or partner…" />
                  {!forValue && suggestPill("client")}
                  {!creatingMode && t.clientId && <button type="button" className="td-go" onClick={() => nav(`/clients?client=${t.clientId}`)} title="Open the client" aria-label="Open the client"><TkIco d="out" /></button>}
                  {!creatingMode && forPartner && <button type="button" className="td-go" onClick={() => nav("/companies", { state: { focusCompanyId: forPartner.id } })} title="Open the partner" aria-label="Open the partner"><TkIco d="out" /></button>}</div>
              </div>
              <div className="td-prop">
                <span className="td-pk">Company</span>
                <div className="td-pv tdx-lv"><Select searchable value={t.companyId ?? ""} onChange={(v) => set({ companyId: v || null })} options={opt(dir.remote ? dir.companies.filter((x) => x.id === t.companyId) : dir.companies, "No company")} loadOptions={findCompanies} aria-label="Company" className={t.companyId ? "" : "is-none"} />
                  {!t.companyId && suggestPill("company")}
                  {!creatingMode && t.companyId && <button type="button" className="td-go" onClick={() => nav("/companies", { state: { focusCompanyId: t.companyId } })} title="Open the company" aria-label="Open the company"><TkIco d="out" /></button>}</div>
              </div>
              <div className="td-prop">
                <span className="td-pk">Deal</span>
                <div className="td-pv tdx-lv"><Select searchable value={t.trackingId ?? ""} onChange={(v) => set({ trackingId: v || null })} options={opt(dir.remote ? dir.deals.filter((x) => x.id === t.trackingId) : dir.deals, "No deal")} loadOptions={findDeals} aria-label="Deal" className={t.trackingId ? "" : "is-none"} />
                  {!t.trackingId && suggestPill("deal")}
                  {!creatingMode && deal && <button type="button" className="td-go" onClick={() => nav(`/sales?tracking=${deal.id}`)} title="Open the deal" aria-label="Open the deal"><TkIco d="out" /></button>}</div>
              </div>
              <div className="td-prop">
                <span className="td-pk">Project</span>
                <div className="td-pv tdx-lv"><Select searchable value={t.projectId ?? ""} onChange={(v) => set({ projectId: v || null })} options={opt(dir.projects, "No project")} aria-label="Project" className={t.projectId ? "" : "is-none"} />
                  {!t.projectId && suggestPill("project")}</div>
              </div>
            </div>
          </div>
  );
  const titleBlock = (
        <div className="td-title-wrap" ref={titleRef}
          onKeyDownCapture={(e) => {
            if (e.key !== "Enter" || e.shiftKey || document.querySelector(".mi-pop")) return;
            e.preventDefault(); e.stopPropagation();
            (document.activeElement as HTMLElement | null)?.blur();
            if (creatingMode) wNext();
          }}
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            const cur = tRef.current;
            if (!creatingMode && ticket && cur.title.trim() && cur.title !== ticket.title) void set({ title: cur.title.trim() }).then(() => involve(mentionIds(cur.title)));
          }}>
          <MentionInput multiline value={t.title} onChange={(v) => setT({ ...tRef.current, title: v.replace(/\n+/g, " ") })} people={mentionPeople} className="td-title"
            placeholder={isTask ? "What needs doing?" : "What is it about?"} />
        </div>
  );
  const stripBlock = (
          <div className="tdx-strip">
          {!creatingMode && (
            <div className="tdx-prop">
              <span className="tdx-k">Status</span>
              <button type="button" className={`tdx-v tdx-stage is-${t.stage}`} onClick={(e) => setPropAt({ k: "stage", rect: e.currentTarget.getBoundingClientRect() })} title={stageText(t.stage, t.category).hint}>
                <i />{stageLabel(t.stage, t.category)}<TkIco d="chev" className="tdx-chev" />
              </button>
            </div>
          )}
          <div className="tdx-prop">
            <span className="tdx-k">Priority</span>
            <button type="button" className={`tdx-v tdx-prio is-${t.priority}`} onClick={(e) => setPropAt({ k: "prio", rect: e.currentTarget.getBoundingClientRect() })}>
              <FlagIcon />{PRIORITY_LABEL[t.priority]}<TkIco d="chev" className="tdx-chev" />
            </button>
          </div>
          <div className="tdx-prop">
            <span className="tdx-k">Owner</span>
            <button type="button" className={`tdx-v tdx-owner ${owner ? "" : "is-empty"}`} onClick={(e) => setPropAt({ k: "owner", rect: e.currentTarget.getBoundingClientRect() })} title={owner ? `Owner: ${owner.name}` : "Owner: nobody yet"}>
              <Avatar person={owner} size={20} /><span>{owner ? (owner.id === dir.me ? `${owner.name} (you)` : owner.name) : "Nobody yet"}</span><TkIco d="chev" className="tdx-chev" />
            </button>
          </div>
          <div className="tdx-prop">
            <span className="tdx-k">Due</span>
            <div className={`tdx-v tdx-due ${late ? "is-late" : ""} ${t.due ? "" : "is-empty"}`}>
              <DatePicker value={dayOf(t.due) ?? ""} onChange={(iso) => set({ due: iso ? `${iso}T${timeOf(t.due) ?? "18:00"}:00` : null })} placeholder="Add a date" />
              {t.due && <button type="button" className="tdx-clear" onClick={() => set({ due: null })} aria-label="Clear due date"><TkIco d="x" /></button>}
            </div>
          </div>
          <div className="tdx-prop">
            <span className="tdx-k">Watchers</span>
            <button type="button" className={`tdx-v tdx-crew ${crew.length ? "" : "is-empty"}`} onClick={(e) => setPropAt({ k: "people", rect: e.currentTarget.getBoundingClientRect() })}
              title={crew.length ? crew.map((w) => person(w)?.name ?? "Someone").join(", ") : "Add the people who work on it or need to follow it"}>
              {crew.length > 0 && <span className="tdx-avs">{crew.slice(0, 4).map((w) => <Avatar key={w} person={person(w)} size={22} />)}{crew.length > 4 && <em>+{crew.length - 4}</em>}</span>}
              <span className="tdx-plus"><TkIco d="plus" />{crew.length ? "" : "Add people"}</span>
            </button>
          </div>
          </div>
  );
  /* ---- the new-ticket walk: one question at a time, so nothing is left out and nobody gets lost ---- */
  const W_STEPS: { k: "details" | "links" | "what" | "desc" | "steps" | "review"; label: string; q: string; hint: string }[] = [
    { k: "links", label: "For", q: "Who is it for?", hint: "The client or partner first — then, if it helps, the company, deal or project. It then shows on their page too." },
    { k: "details", label: "Details", q: isTask ? "What kind of task is it?" : "What kind of ticket is it?", hint: isTask ? "Its type, team and tags — they route it and help find it later." : "Its type, team, how it came in and who asked — they route it and help find it later." },
    { k: "what", label: "Who & when", q: isTask ? "Who's on it, and by when?" : "Who handles it, and by when?", hint: "How urgent it is, who owns it, the date it's due, and who else should follow it." },
    { k: "desc", label: "Description", q: "Tell the whole story", hint: isTask ? "What has to be done, and what done looks like. Type @ to mention someone." : "What was asked or said, by whom. Type @ to mention someone." },
    { k: "steps", label: "Steps", q: "Break it into steps", hint: "Optional. End a step with @name to give it to someone — they join it." },
    { k: "review", label: "Review", q: "Everything in place?", hint: "A last look before it's created. Click a line to change it." },
  ];
  const wLast = W_STEPS.length - 1;
  const wCan = (_i: number) => true;
  const wGo = (i: number) => {
    if (i === wStep || i < 0 || i > wLast || !wCan(i)) return;
    setWBack(i < wStep); setWStep(i); setWSeen((x) => Math.max(x, i));
  };
  function wNext() {
    if (wStep < wLast) { wGo(wStep + 1); return; }
    if (!t.title.trim()) { titleRef.current?.querySelector<HTMLElement>(".mi-editor")?.focus(); return; }
    void create();
  }
  const wDone = (k: (typeof W_STEPS)[number]["k"]) => {
    if (k === "details") return !!(t.type || t.tags.length || (!isTask && (t.requesterName || t.requesterEmail)));
    if (k === "links") return !!(t.clientId || t.companyId || t.trackingId || t.projectId);
    if (k === "what") return !!(t.assignee || t.due || t.watchers.length || t.priority !== "normal");
    if (k === "desc") return !!plain(t.description).trim();
    if (k === "steps") return t.checklist.length > 0;
    return false;
  };
  const nameOf = (list: { id: string; name: string }[], id: string | null) => (id ? list.find((x) => x.id === id)?.name ?? "Linked" : null);
  const wReview: { step: number; k: string; v: React.ReactNode; empty?: boolean; warn?: boolean }[] = [
    { step: -1, k: "Name", v: plain(t.title) || "No name yet — write it at the top", empty: !t.title.trim(), warn: !t.title.trim() },
    { step: 0, k: "For", v: [nameOf(dir.clients, t.clientId), partners.find((x) => x.id === t.companyId)?.name ?? nameOf(dir.companies, t.companyId), nameOf(dir.deals, t.trackingId), nameOf(dir.projects, t.projectId)].filter(Boolean).join(" · ") || "Nothing linked", empty: !(t.clientId || t.companyId || t.trackingId || t.projectId) },
    { step: 1, k: "Type", v: t.type ?? "No type", empty: !t.type },
    { step: 1, k: "Team", v: t.team ? deptName(t.team) : "Any team", empty: !t.team },
    ...(!isTask ? [{ step: 1, k: "Requester", v: t.requesterName || t.requesterEmail || "Nobody yet", empty: !(t.requesterName || t.requesterEmail) }] : []),
    { step: 1, k: "Tags", v: t.tags.length ? t.tags.map((x) => `#${x}`).join("  ") : "No tags", empty: !t.tags.length },
    { step: 2, k: "Priority", v: <span className={`tdw-prio is-${t.priority}`}><FlagIcon />{PRIORITY_LABEL[t.priority]}</span> },
    { step: 2, k: "Owner", v: owner ? <span className="tdw-who"><Avatar person={owner} size={20} />{owner.id === dir.me ? `${owner.name} (you)` : owner.name}</span> : "Nobody yet", empty: !owner, warn: !owner },
    { step: 2, k: "Due", v: t.due ? new Date(t.due).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "No date", empty: !t.due },
    { step: 2, k: "Watchers", v: crew.length ? <span className="tdw-who">{crew.slice(0, 5).map((w) => <Avatar key={w} person={person(w)} size={20} />)}{crew.length === 1 ? person(crew[0])?.name ?? "1 person" : `${crew.length} people`}</span> : "Nobody else", empty: !crew.length },
    { step: 3, k: "Description", v: plain(t.description).replace(/\s+/g, " ").trim() || "Nothing written", empty: !plain(t.description).trim() },
    { step: 4, k: "Steps", v: t.checklist.length ? (t.checklist.length === 1 ? "1 step" : `${t.checklist.length} steps`) : "No steps", empty: !t.checklist.length },
  ];
  /* who asked, as plain rows like the rest of the form */
  const reqRows = isTask ? null : (
    <div className="td-group tdw-req">
      <span className="td-group-h"><TkIco d="mail" />{t.source === "message" ? "From" : "Requester"}</span>
      <div className="td-props">
        <div className="td-prop">
          <span className="td-pk">Name</span>
          <div className="td-pv"><input className="td-in" value={t.requesterName ?? ""} placeholder="Who asked" aria-label="Requester name" onChange={(e) => setT({ ...tRef.current, requesterName: e.target.value })} /></div>
        </div>
        <div className="td-prop">
          <span className="td-pk">E-mail</span>
          <div className="td-pv"><input className="td-in" value={t.requesterEmail ?? ""} placeholder="name@company.com" type="email" aria-label="Requester e-mail" onChange={(e) => setT({ ...tRef.current, requesterEmail: e.target.value })} /></div>
        </div>
        <div className="td-prop">
          <span className="td-pk">CRM contact</span>
          <div className="td-pv tdx-lv">
            <Select searchable value={t.requesterContactId ?? ""} onChange={(v) => {
              const c = dir.contacts.find((x) => x.id === v);
              void set({ requesterContactId: v || null, ...(c ? { requesterName: c.name, requesterEmail: c.email } : {}) });
            }} options={opt(dir.remote ? dir.contacts.filter((x) => x.id === t.requesterContactId) : dir.contacts, "Search the CRM's contacts…")} loadOptions={findContacts} aria-label="CRM contact" className={t.requesterContactId ? "" : "is-none"} />
            {!t.requesterContactId && reqMatch && (
              <button type="button" className="tdx-pill is-fill tdx-req-match" onClick={() => {
                const c = dir.contacts.find((x) => x.id === reqMatch.id);
                void set({ requesterContactId: reqMatch.id, ...(c && !t.requesterName ? { requesterName: c.name } : {}) });
              }} title={`${reqMail} is already in your CRM`}>
                <TkIco d="bolt" /><span>{reqMatch.name} is in your CRM — link</span><TkIco d="plus" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
  const cur = W_STEPS[wStep];
  const wizard = (
    <>
      <header className="tdw-head">
        <div className="tdw-top">
          <span className={`td-kind is-${t.category}`}><TkIco d={isTask ? "check" : "mail"} />{isTask ? "Task" : "Ticket"}</span>
          <span className="tdw-ttl">New {noun}</span>
          <span className="td-spacer" />
          {inline && onWide && (
            <button type="button" className={`td-icon td-wide ${wide ? "is-on" : ""}`} onClick={onWide} title={wide ? "Back to the list beside it" : "Full width"} aria-label={wide ? "Back to the list" : "Full width"} aria-pressed={wide}>
              <TkIco d={wide ? "shrink" : "expand"} />
            </button>
          )}
          <button type="button" className="td-x" onClick={onClose} aria-label="Close"><TkIco d="x" /></button>
        </div>
        <div className={`tdw-name ${wStep === wLast && !t.title.trim() ? "is-missing" : ""}`}>{titleBlock}</div>
        <ol className="tdw-steps" style={{ ["--p" as string]: wStep / wLast } as React.CSSProperties}>
          {W_STEPS.map((x, i) => {
              const seen = i !== wStep && (i < wStep || i <= wSeen) && x.k !== "review";
              const st = i === wStep ? "is-on" : seen ? (wDone(x.k) ? "is-done" : "is-skip") : "";
              return (
                <li key={x.k} className={`${st} ${wCan(i) ? "" : "is-locked"}`}>
                  <button type="button" onClick={() => wGo(i)} disabled={!wCan(i)} aria-current={i === wStep ? "step" : undefined}
                    title={!wCan(i) ? "Give it a title first" : st === "is-skip" ? `${x.label}: skipped — nothing filled in yet` : x.q}>
                    <i>{st === "is-done" ? <TkIco d="check" /> : i + 1}</i><span>{x.label}</span>
                  </button>
                </li>
              );
          })}
        </ol>
      </header>
      <div className="tdw-body">
        <div key={cur.k} className={`tdw-pane is-${cur.k} ${wBack ? "is-back" : ""}`}>
          <div className="tdw-q">
            <span className="tdw-n">Step {wStep + 1} of {W_STEPS.length}</span>
            <h2>{cur.q}</h2>
            <p>{cur.hint}</p>
          </div>
          {cur.k === "details" && <div className="tdw-form">{detailsBlock}{reqRows}</div>}
          {cur.k === "links" && <div className="tdw-form">{linksBlock}</div>}
          {cur.k === "what" && <div className="tdw-form tdw-what">{stripBlock}</div>}
          {cur.k === "desc" && (
            <div className="tdw-desc">
              <MentionInput multiline value={t.description} onChange={setDesc} people={mentionPeople} className="tdx-desc-ed"
                placeholder={isTask ? "What has to be done, and what done looks like…" : "What was asked or said, by whom…"} />
            </div>
          )}
          {cur.k === "steps" && (
            <div className="tdw-steps-box">
              <StepsPanel t={t} dir={dir} people={mentionPeople} onTask={onTask} onChecklist={setChecklist} onInvolve={(ids) => void involve(ids)} shut={false} onFold={() => {}} />
            </div>
          )}
          {cur.k === "review" && (
            <div className="tdw-form tdw-review">
              {wReview.map((r) => (
                <button type="button" key={r.k} className={`tdw-rv ${r.empty ? "is-empty" : ""} ${r.warn ? "is-warn" : ""}`}
                  onClick={() => (r.step < 0 ? titleRef.current?.querySelector<HTMLElement>(".mi-editor")?.focus() : wGo(r.step))} title={r.step < 0 ? "Change the name" : `Change it (step ${r.step + 1})`}>
                  <span className="tdw-rk">{r.k}</span><span className="tdw-rv-v">{r.v}</span><TkIco d="pen" className="tdw-rv-pen" />
                </button>
              ))}
            </div>
          )}
          {cur.k === "review" && (
            <div className="tdw-notify">
              <div className="tdw-nt-h">
                <span className="tdw-nt-ico"><TkIco d="send" /></span>
                <span className="tdw-nt-t"><b>Send a notice</b><small>They always see it in Next. Choose who also gets a message, and from which app.</small></span>
                {ntOut.length > 0 && ntOutCh.length > 0 && <button type="button" className="tdw-nt-prev" onClick={() => setNtPreview(true)}><TkIco d="eye" />Preview</button>}
              </div>
              <div className="tdw-nt-body">
                <section className="tdw-nt-grp">
                  <span className="tdw-nt-k">Who gets it</span>
                  <div className="tdw-nt-tiles">
                    {ntPeople.length ? ntPeople.map((x) => (
                      <button type="button" key={x.id} className={`tdw-nt-tile is-person ${ntPicked(x.id) ? "is-on" : ""}`} aria-pressed={ntPicked(x.id)} title={x.p!.name}
                        onClick={() => setNtTo((cur0) => { const n = new Set(cur0 ?? ntPeople.map((y) => y.id)); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n; })}>
                        <span className="tdw-nt-face"><Avatar person={x.p} size={46} /><i className="tdw-nt-tick"><TkIco d="check" /></i></span>
                        <b>{x.p!.name.split(" ")[0]}</b><small>{x.role === "owner" ? "Owner" : "Watcher"}</small>
                      </button>
                    )) : <span className="tdw-nt-none">Nobody else is on it yet — give it an owner or watchers in step 3.</span>}
                  </div>
                </section>
                <section className="tdw-nt-grp">
                  <span className="tdw-nt-k">Through{ntChannels !== null && ntChannels.length > 1 && (
                    <button type="button" className="tdw-nt-all" onClick={() => setNtCh((cur0) => { const all = ntChannels.every((c) => cur0.has(c.key)); const n = all ? new Set<string>() : new Set(ntChannels.map((c) => c.key)); try { localStorage.setItem("tkNotifyCh", JSON.stringify([...n])); } catch { /* */ } return n; })}>
                      {ntChannels.every((c) => ntCh.has(c.key)) ? "None" : "All"}
                    </button>
                  )}</span>
                  <div className="tdw-nt-tiles">
                    <span className="tdw-nt-tile is-on is-locked" title="Always: it shows on their list and in their alerts">
                      <span className="tdw-nt-face tdw-nt-app is-next"><NextCube /><i className="tdw-nt-tick"><TkIco d="check" /></i></span>
                      <b>Next</b><small>Always</small>
                    </span>
                    {ntChannels === null ? <span className="tdw-nt-none">Looking for your accounts…</span>
                      : ntChannels.map((c) => (
                        <button type="button" key={c.key} className={`tdw-nt-tile ${ntCh.has(c.key) ? "is-on" : ""}`} aria-pressed={ntCh.has(c.key)} title={`${c.label} · ${c.sub}`}
                          onClick={() => setNtCh((cur0) => { const n = new Set(cur0); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); try { localStorage.setItem("tkNotifyCh", JSON.stringify([...n])); } catch { /* private mode */ } return n; })}>
                          <span className={`tdw-nt-face tdw-nt-app is-${c.kind}`}><NtAppLogo kind={c.kind} /><i className="tdw-nt-tick"><TkIco d="check" /></i></span>
                          <b>{c.kind === "ionos" ? "IONOS" : c.label}</b><small>{c.sub}</small>
                        </button>
                      ))}
                    {ntChannels !== null && !ntChannels.length && <span className="tdw-nt-none">Connect Outlook, Gmail or WhatsApp in Settings › Integrations to also send it there.</span>}
                  </div>
                </section>
              </div>
            </div>
          )}
        </div>
      </div>
      <footer className="tdw-foot">
        {wStep > 0 ? <button type="button" className="td-ghost" onClick={() => wGo(wStep - 1)}><TkIco d="arrow" className="tdw-back-ico" />Back</button> : <button type="button" className="td-ghost" onClick={onClose}>Cancel</button>}
        <span className="tdw-foot-hint">
          {wStep === wLast && !t.title.trim() ? "Give it a name at the top to create it"
            : wStep === wLast ? <>It lands on {t.assignee ? (t.assignee === dir.me ? "your list" : `${person(t.assignee)?.name ?? "their"}'s list`) : "the team's list, with no owner"}{crew.length > 0 && <> · {crew.length === 1 ? `${person(crew[0])?.name ?? "1 watcher"} is notified` : `${crew.length} watchers are notified`}</>}.</>
              : wStep < wLast ? "You can skip this and come back" : ""}
        </span>
        {wStep >= 3 && wStep < wLast && t.title.trim() && <button type="button" className="td-ghost tdw-now" onClick={() => void create()} disabled={busy}>Create now</button>}
        <button type="button" className="td-primary" onClick={wNext} disabled={busy}>
          {wStep === wLast ? (createdId ? `Open the ${noun}` : busy ? (sendNote ? "Sending…" : "Creating…") : ntOut.length && ntOutCh.length ? `Create & notify ${ntOut.length}` : `Create ${noun}`) : <>Next<TkIco d="arrow" /></>}
        </button>
      </footer>
    </>
  );
  const sheet = (
    <aside ref={sheetRef} className={`td tdx ${inline ? "is-inline" : ""} ${creatingMode ? "is-new tdw" : ""} ${creatingMode ? "" : !inline || sideOpen ? "is-side" : "no-side"} ${dropOn ? "is-drop" : ""}`} role={inline ? "region" : "dialog"} aria-modal={inline ? undefined : true}
      aria-label={creatingMode ? `New ${noun}` : `${isTask ? "Task" : "Ticket"} ${ticketRef(t)}`}
      onDragOver={(e) => { if (creatingMode || !e.dataTransfer.types.includes("Files")) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!dropOn) setDropOn(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(false); }}
      onDrop={(e) => { if (creatingMode || !e.dataTransfer.files.length) return; e.preventDefault(); setDropOn(false); stage(Array.from(e.dataTransfer.files)); }}>
      {dropOn && (
        <div className="tdx-drop" aria-hidden="true">
          <span className="tdx-drop-ico"><TkIco d="clip" /></span>
          <b>Drop to add {isTask ? "to a comment" : "to a note"}</b>
          <small>Pictures and files stay on this {noun}, with what you write next to them</small>
        </div>
      )}
      {creatingMode ? wizard : <>
      <header className="td-head tdx-head">
        <div className="td-head-top">
          <span className={`td-kind is-${t.category}`}><TkIco d={isTask ? "check" : "mail"} />{isTask ? "Task" : "Ticket"}</span>
          <span className="td-ref">{creatingMode ? `New ${noun}` : ticketRef(t)}</span>
          {t.type && <span className="td-chip">{t.type}</span>}
          {!isTask && <span className="td-chip is-src">{t.source === "email" ? <TkIco d="mail" /> : null}{TICKET_CHANNELS[t.source] ?? TICKET_SOURCES[t.source] ?? t.source}</span>}
          {isTask && t.source === "sales" && <span className="td-chip is-src"><TkIco d="deal" />From a deal</span>}
          {!creatingMode && !isTask && <SlaBadge t={t} sla={sla} now={now} />}
          <span className="td-spacer" />
          <span className="td-tools">
          {!creatingMode && !inline && (
            <button type="button" className="td-icon" onClick={() => { onClose(); nav(`/tickets?ticket=${t.id}`); }} title="Open on the Tickets page" aria-label="Open on the Tickets page"><TkIco d="expand" /></button>
          )}
          {inline && !creatingMode && (
            <button type="button" className={`td-icon td-side-btn ${sideOpen ? "is-on" : ""}`} onClick={() => setSideOpen(!sideOpen)} aria-pressed={sideOpen}
              title={sideOpen ? "Hide the details" : "Details: type, requester, links, service level…"} aria-label={sideOpen ? "Hide the details" : "Show the details"}>
              <TkIco d="panel" /><span>Details</span>{!sideOpen && (nSugg > 0 || suggestions.length > 0) && <i className="td-side-dot" title="Suggestions inside" />}
            </button>
          )}
          {inline && onWide && (
            <button type="button" className={`td-icon td-wide ${wide ? "is-on" : ""}`} onClick={onWide} title={wide ? "Back to the list beside it" : "Full width"} aria-label={wide ? "Back to the list" : "Full width"} aria-pressed={wide}>
              <TkIco d={wide ? "shrink" : "expand"} />
            </button>
          )}
          {!creatingMode && (canDelete || !t.mergedInto) && (
            <button type="button" className={`td-icon ${moreAt ? "is-on" : ""}`} onClick={(e) => setMoreAt(e.currentTarget.getBoundingClientRect())} title="More" aria-label="More actions" aria-haspopup="menu"><TkIco d="more" className="td-more-ico" /></button>
          )}
          </span>
          <button type="button" className="td-x" onClick={onClose} aria-label="Close"><TkIco d="x" /></button>
        </div>
        {/* the title: @name shows as the person's name (it's stored as a mention) */}
        {titleBlock}

        {/* the facts that matter, each one a click away */}
        <div className="tdx-props">
          {stripBlock}
          <span className="td-spacer" />
          {next && (
            <div className="tdx-next">
              {isActive(t.stage) && t.stage !== "in_progress" && (
                <button type="button" className="td-ghost is-sm" onClick={() => set({ stage: "resolved" })} title={isTask ? "Mark it done" : "Resolve it"}><TkIco d="check" /><span>{isTask ? "Done" : "Resolve"}</span></button>
              )}
              <button type="button" className="td-primary is-sm" onClick={() => set({ stage: next.to })}>{next.label}<TkIco d="arrow" /></button>
            </div>
          )}
        </div>
        {t.mergedInto && (
          <div className="td-merged"><TkIco d="merge" />Merged into {mergedTarget ? <b>{ticketRef(mergedTarget)} “{plain(mergedTarget.title)}”</b> : "another ticket"}
            <button type="button" onClick={() => { const id = t.mergedInto; onClose(); window.setTimeout(() => window.dispatchEvent(new CustomEvent("open-ticket", { detail: id })), 50); }}>Open it</button></div>
        )}
        {delAsk && (
          <div className="td-confirm is-del">
            <span>Delete this {noun} for good? Its notes and history go with it.</span>
            <button type="button" className="td-ghost is-sm" onClick={() => setDelAsk(false)}>Keep it</button>
            <button type="button" className="td-del" onClick={remove}>Delete {noun}</button>
          </div>
        )}
        {mergeInto && (
          <div className="td-confirm">
            <span>Merge into <b>{ticketRef(mergeInto)}</b>? Notes, e-mails and watchers move there; this one closes.</span>
            <button type="button" className="td-ghost is-sm" onClick={() => setMergeInto(null)}>Cancel</button>
            <button type="button" className="td-primary is-sm" onClick={doMerge} disabled={busy}>Merge</button>
          </div>
        )}
      </header>

      <div className="td-body">
        <div className="td-main">
          <div className="tdx-scroll" ref={scrollRef}>
          <section className={`td-sec tdx-sec tdx-sec-desc ${folds.shut.desc ? "is-shut" : ""}`}>
            <div className="tdx-h">
              <h3><button type="button" className="tdx-h-btn" onClick={() => folds.flip("desc")} aria-expanded={!folds.shut.desc}>Description</button></h3>
              {folds.shut.desc
                ? <span className={`tdx-sum ${t.description.trim() ? "" : "is-empty"}`}>{plain(t.description).replace(/\s+/g, " ").trim() || "Nothing written yet"}</span>
                : <span className="tdx-hint">Type <b>@</b> to mention someone</span>}
              <FoldBtn shut={!!folds.shut.desc} onClick={() => folds.flip("desc")} />
            </div>
            <div className="tdx-fold-body"><div className="tdx-fold-in">
              <div className="tdx-desc" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void saveDesc(); }}>
                <MentionInput multiline value={t.description} onChange={setDesc} people={mentionPeople} className="tdx-desc-ed"
                  placeholder={isTask ? "What has to be done, and what done looks like…" : "What was asked or said, by whom…"} />
              </div>
            </div></div>
          </section>

          <StepsPanel t={t} dir={dir} people={mentionPeople} onTask={onTask} onChecklist={setChecklist} onInvolve={(ids) => void involve(ids)}
            shut={!!folds.shut.steps} onFold={() => folds.flip("steps")} refs={stepRefs} onRef={goPost} />

          {!creatingMode && (
            <section className={`td-sec tdx-sec td-conv ${folds.shut.conv ? "is-shut" : ""}`}>
              <div className="tdx-h">
                <h3><button type="button" className="tdx-h-btn" onClick={() => folds.flip("conv")} aria-expanded={!folds.shut.conv}>{isTask ? "Comments" : "Conversation"}{talkCount > 0 && <em>{talkCount}</em>}</button></h3>
                {folds.shut.conv && <span className="tdx-sum">{talkCount ? (talkCount === 1 ? "1 message" : `${talkCount} messages`) : isTask ? "No comments yet" : "Nothing said yet"}</span>}
                {!folds.shut.conv && <div className="tk-seg is-xs" role="tablist">
                  <button type="button" className={threadFilter === "talk" ? "is-on" : ""} onClick={() => setThreadFilter("talk")}>{isTask ? "Comments" : "All"}</button>
                  {!isTask && (mails?.length ?? 0) > 0 && <button type="button" className={threadFilter === "mail" ? "is-on" : ""} onClick={() => setThreadFilter("mail")}>E-mail {mails!.length}</button>}
                  <button type="button" className={threadFilter === "history" ? "is-on" : ""} onClick={() => setThreadFilter("history")}>History{histCount > 0 ? ` ${histCount}` : ""}</button>
                </div>}
                <FoldBtn shut={!!folds.shut.conv} onClick={() => folds.flip("conv")} />
              </div>
              <div className="tdx-fold-body"><div className="tdx-fold-in">
              {allAtt.length > 0 && threadFilter !== "history" && (
                <div className="td-files">
                  <span className="td-k"><TkIco d="clip" />Files <em>{allAtt.length}</em></span>
                  <div className="tm-att">{(mails ?? []).filter((m) => m.attachments.length).map((m) => <Attachments key={m.id} m={m} />)}</div>
                </div>
              )}
              {/* oldest first, newest right above the box you write in */}
              <div className={`td-thread ${threadFilter === "history" ? "is-history" : ""}`}>
                {!thread ? <div className="hs-skel" /> : !visibleItems.length ? (
                  <div className="tdx-empty">
                    <span className="tdx-empty-ico"><TkIco d={threadFilter === "history" ? "clock" : threadFilter === "mail" ? "mail" : "reply"} /></span>
                    <b>{threadFilter === "history" ? "No changes yet" : threadFilter === "mail" ? "No e-mail on this ticket yet" : isTask ? "No comments yet" : "Nothing said yet"}</b>
                    <span>{threadFilter === "history" ? "Every change to it is logged here." : isTask ? "Ask a question, say where it's at, or @mention someone — they get a notification." : "Notes and replies show up here."}</span>
                  </div>
                ) : visibleItems.map((it) => it.k === "mail" ? (
                  <MailCard key={it.m.id} m={it.m} open={it.m.id === newestMail} />
                ) : it.k === "post" ? (
                  <div key={it.p.id} data-post={it.p.id} className={`td-post is-${it.p.visibility} ${isTask ? "is-comment" : ""}`}>
                    <Avatar person={person(it.p.author)} size={30} />
                    <div className="td-post-body">
                      <span className="td-post-h"><b>{person(it.p.author)?.name ?? "Someone"}</b>{isTask ? null : it.p.visibility === "reply" ? <em className="is-reply"><TkIco d="reply" />Reply</em> : <em><TkIco d="lock" />Internal</em>}<time title={fullDate(it.p.at)}>{ago2(it.p.at)}</time></span>
                      {it.p.body.trim() && <p><StepRefText text={it.p.body} steps={t.checklist} onStep={goStep} /></p>}
                      {tFiles.some((x) => x.updateId === it.p.id) && (
                        <FileTiles files={tFiles.filter((x) => x.updateId === it.p.id)} urls={fileUrls} onOpen={openFile} />
                      )}
                    </div>
                  </div>
                ) : (
                  <div key={it.e.id} className="td-event">
                    <span className="td-event-dot" /><b>{person(it.e.author)?.name ?? "Someone"}</b>&nbsp;{eventText(it.e, dir, t.category)}<time title={fullDate(it.e.at)}>{ago2(it.e.at)}</time>
                  </div>
                ))}
              </div>
              </div></div>
            </section>
          )}
          </div>
          {/* the box you write in stays at the bottom; the conversation scrolls above it */}
          {!creatingMode && threadFilter !== "history" && (
            <div className="tdx-dock">
              {(
                <div className={`td-composer tdx-composer is-${isTask ? "task" : mode} ${willMail ? "is-mail" : ""} ${reply.trim() || staged.length ? "has-text" : ""} ${staged.length ? "has-files" : ""}`}
                  onPaste={(e) => { const fs = Array.from(e.clipboardData?.files ?? []); if (fs.length) { e.preventDefault(); stage(fs); } }}>
                  {!isTask && (
                    <div className="td-composer-tabs" role="tablist">
                      <button type="button" role="tab" aria-selected={mode === "internal"} className={mode === "internal" ? "is-on" : ""} onClick={() => setMode("internal")}><TkIco d="lock" />Internal note</button>
                      <button type="button" role="tab" aria-selected={mode === "reply"} className={mode === "reply" ? "is-on" : ""} onClick={() => setMode("reply")}><TkIco d="reply" />Reply to requester</button>
                    </div>
                  )}
                  {/* replying: who it goes to, from where, with what subject and signature — like an e-mail */}
                  {mode === "reply" && !isTask && mails !== null && (
                    <div className={`td-mailbar tdx-env ${byMail ? "" : "is-off"}`}>
                      <div className="tdx-env-row is-to">
                        <span className="tdx-env-k">{byMail ? "To" : "Log"}</span>
                        {!byMail ? <span className="tdx-env-none">Kept on the ticket, not e-mailed</span>
                          : replyTo ? <span className="tdx-env-to" title={replyTo}>{lastIn?.fromName || t.requesterName ? <><b>{lastIn?.fromName || t.requesterName}</b><em>{replyTo}</em></> : <b>{replyTo}</b>}</span>
                          : <span className="tdx-env-none">No address yet — add the requester's e-mail in Details</span>}
                        {byMail && !showCc && <button type="button" className="tdx-env-add" onClick={() => setShowCc(true)}>Cc</button>}
                        <label className="tdx-switch" title={byMail ? "Sent by e-mail from Outlook and kept here" : "Only kept on the ticket"}>
                          <input type="checkbox" checked={byMail} onChange={() => setByMail((v) => !v)} /><i aria-hidden="true" /><span>E-mail</span>
                        </label>
                      </div>
                      {byMail && showCc && (
                        <div className="tdx-env-row">
                          <span className="tdx-env-k">Cc</span>
                          <input className="tdx-env-in" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="name@company.com, …" autoFocus={!cc} aria-label="Cc" />
                          <button type="button" className="tdx-env-x" onClick={() => { setCc(""); setShowCc(false); }} aria-label="Remove Cc" title="Remove Cc"><TkIco d="x" /></button>
                        </div>
                      )}
                      {byMail && fromChoices.length > 1 && (
                        <div className="tdx-env-row">
                          <span className="tdx-env-k">From</span>
                          <span className="tdx-env-from"><Select size="sm" value={fromAddr} onChange={setFromAddr} options={fromChoices} aria-label="From" /></span>
                        </div>
                      )}
                      {byMail && (
                        <div className="tdx-env-row">
                          <span className="tdx-env-k">Subject</span>
                          <span className="tdx-env-subj" title={mailSubject}>{mailSubject}</span>
                        </div>
                      )}
                      {byMail && (
                        <div className="tdx-env-row">
                          <span className="tdx-env-k">Signature</span>
                          <button type="button" className={`tdx-env-sig ${sig ? "" : "is-none"}`} onClick={(e) => setSigAt(e.currentTarget.getBoundingClientRect())} aria-haspopup="menu">
                            <TkIco d="pen" /><span>{sigs === null ? "…" : sig ? sig.name : sigs.length ? "No signature" : "Add your signature"}</span><TkIco d="chev" className="tdx-chev" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {staged.length > 0 && (
                    <div className="tdx-staged" aria-label="Files to add">
                      {staged.map((x) => (
                        <span key={x.id} className={`tdx-stf ${x.url ? "is-pic" : ""}`} title={x.file.name}>
                          {x.url ? <img src={x.url} alt="" /> : <span className="tdx-stf-ico"><TkIco d="clip" /></span>}
                          {!x.url && <span className="tdx-stf-t"><b>{x.file.name}</b><small>{fileSize(x.file.size)}</small></span>}
                          <button type="button" onClick={() => unstage(x.id)} aria-label={`Remove ${x.file.name}`} title="Remove"><TkIco d="x" /></button>
                        </span>
                      ))}
                      {willMail && <em className="tdx-staged-note">Kept on the {noun}, not e-mailed</em>}
                    </div>
                  )}
                  <div className="tdx-write">
                    <Avatar person={person(dir.me)} size={28} />
                    {useMention ? (
                      <MentionInput multiline value={reply} onChange={setReply} people={commentPeople} onEnter={send} className="tdx-write-ed"
                        placeholder={inline ? (isTask ? "Write a comment… @ to mention" : "A note for your team… @ to mention") : isTask ? "Write a comment… type @ to mention someone" : "Write a note only your team sees… type @ to mention someone"} />
                    ) : (
                      <textarea value={reply} onChange={(e) => { setReply(e.target.value); grow(e.target); }} rows={inline ? 1 : 2}
                        placeholder={inline ? (willMail ? `Write to ${lastIn?.fromName || t.requesterName || replyTo || "the requester"}…` : "Log what you told them…")
                          : willMail ? `Write to ${lastIn?.fromName || t.requesterName || replyTo || "the requester"} — it goes out from Outlook…` : `Log what you told ${t.requesterName || t.requesterEmail || "the requester"}…`}
                        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
                    )}
                  </div>
                  {willMail && sig && (
                    <div className="tdx-sig-prev" aria-label="Signature">
                      <div dangerouslySetInnerHTML={{ __html: cleanSignature(sig.html) }} />
                    </div>
                  )}
                  {(needPerm || (willMail && mailOk && !mailReady)) && (
                    <div className="td-perm">
                      <TkIco d="mail" />
                      <span>{mailOk?.connected ? "Your Outlook connection can't send mail yet — connect again with mail permission." : "Connect Outlook to send replies by e-mail."}</span>
                      <button type="button" onClick={() => connectOutlook({ withMail: true })}>Connect with mail</button>
                    </div>
                  )}
                  <div className="td-composer-foot">
                    <span>{isTask ? "Everyone on this task sees it · @mentions are notified" : mode === "internal" ? "Only your team sees notes · @mentions are notified" : willMail ? "Sent by e-mail and kept here" : "Kept here, not e-mailed"} · ⌘ Enter</span>
                    <button type="button" className="tdx-clip" onClick={() => fileIn.current?.click()} title="Add pictures or files — or drop them anywhere on it" aria-label="Add pictures or files"><TkIco d="clip" /></button>
                    <input ref={fileIn} type="file" multiple hidden onChange={(e) => { stage(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
                    <button type="button" className="td-send" onClick={send} disabled={(!reply.trim() && !staged.length) || busy}>
                      {busy ? "Sending…" : isTask ? "Comment" : mode === "internal" ? "Add note" : willMail ? <><TkIco d="send" />Send e-mail</> : "Log reply"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="td-side" aria-label="Details">
          {detailsBlock}

          {requesterBlock}

          {linksBlock}

          {!creatingMode && !isTask && <SlaTimers t={t} sla={sla} now={now} />}
          {!creatingMode && <TimeInStage t={t} events={thread?.events ?? []} now={now} />}

          {!creatingMode && (
            <dl className="td-meta">
              <div><dt>Opened</dt><dd>{new Date(t.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}{t.createdBy ? `, by ${person(t.createdBy)?.name ?? "someone"}` : ""}</dd></div>
              {t.updatedAt && <div><dt>Updated</dt><dd>{ago2(t.updatedAt)}</dd></div>}
              {t.resolvedAt && !isActive(t.stage) && <div><dt>Resolved</dt><dd>{ago2(t.resolvedAt)}</dd></div>}
            </dl>
          )}

          {/* every picture and file put on it, in one folder */}
          {!creatingMode && (
            <div className={`td-group tdx-folder ${folderOpen ? "is-open" : ""}`}>
              <button type="button" className="tdx-folder-h" onClick={() => setFolderOpen((v) => !v)} aria-expanded={folderOpen}>
                <span className="tdx-folder-ico"><TkIco d="folder" /></span>
                <b>Files</b><em>{tFiles.length}</em>
                <TkIco d="chev" className="tdx-folder-chev" />
              </button>
              {folderOpen && (tFiles.length ? (
                <div className="tdx-folder-body">
                  <FileTiles files={[...tFiles].reverse()} urls={fileUrls} onOpen={openFile} big onRemove={(f) => void dropFile(f)} canRemove={(f) => f.by === dir.me} />
                </div>
              ) : (
                <p className="tdx-folder-empty">Drop pictures or files anywhere on this {noun} — they go with your comment and are kept here.</p>
              ))}
            </div>
          )}
        </aside>
      </div>
      </>}

      {err && <p className="td-err" role="alert">{err}</p>}
      {propAt && (
        <Pop anchor={propAt.rect} onClose={() => setPropAt(null)} width={propAt.k === "stage" ? 250 : propAt.k === "prio" ? 190 : 270}>
          {propAt.k === "stage" ? (
            <div className="tk-pop-list">
              {TICKET_STAGES.map((s) => (
                <button key={s.key} type="button" className={`tk-pop-opt ${t.stage === s.key ? "is-on" : ""}`} onClick={() => { setPropAt(null); set({ stage: s.key }); }}>
                  <span className={`tk-dot is-${s.key}`} /><span>{stageLabel(s.key, t.category)}<em>{stageText(s.key, t.category).hint}</em></span>{t.stage === s.key && <TkIco d="check" className="tk-pop-tick" />}
                </button>
              ))}
            </div>
          ) : propAt.k === "prio" ? (
            <div className="tk-pop-list">
              {TASK_PRIORITIES.map((p) => (
                <button key={p} type="button" className={`tk-pop-opt ${t.priority === p ? "is-on" : ""}`} onClick={() => { setPropAt(null); set({ priority: p }); }}>
                  <span className={`tk-prio is-${p}`}><FlagIcon /></span><span>{PRIORITY_LABEL[p]}</span>{t.priority === p && <TkIco d="check" className="tk-pop-tick" />}
                </button>
              ))}
            </div>
          ) : propAt.k === "owner" ? (
            <PeopleMenu dir={dir} value={t.assignee} first={crew} firstLabel="Watching it" noneLabel="Nobody" onPick={(id) => { setPropAt(null); set({ assignee: id }); }} />
          ) : (
            <div className="tdx-crew-pop">
              <p className="tdx-crew-lead">Watchers get a notification, see it on their list and can be given steps.</p>
              <PeopleMenu dir={dir} value={null} allowNone={false} picked={t.watchers} onPick={(id) => { if (id) void toggleWatch(id); }} />
            </div>
          )}
        </Pop>
      )}
      {ntPreview && createPortal((() => {
        const x = ntOut[0];
        const m = ticketNoticeEmail({ isTask, ref: `${isTask ? "#" : "T-"}…`, title: plain(t.title) || `New ${noun}`, description: plain(t.description), priority: t.priority, due: t.due,
          steps: t.checklist.map((st) => ({ text: plain(st.text), who: st.who ? person(st.who)?.name ?? null : null })), from: person(dir.me)?.name ?? "You", to: x?.p?.name ?? "there", role: x?.role ?? "owner",
          link: `${publicOrigin()}/tickets`, links: [t.clientId && dir.clients.find((y) => y.id === t.clientId)?.name, t.companyId && dir.companies.find((y) => y.id === t.companyId)?.name].filter(Boolean) as string[] });
        return (
          <div className="tdw-mail-back" onMouseDown={() => setNtPreview(false)}>
            <div className="tdw-mail" role="dialog" aria-modal="true" aria-label="The notice" onMouseDown={(e) => e.stopPropagation()}>
              <header><span><b>{m.subject}</b><small>To {ntOut.map((y) => y.p!.name).join(", ")} · by {ntOutCh.map((c) => c.label).join(", ")}</small></span>
                <button type="button" className="td-x" onClick={() => setNtPreview(false)} aria-label="Close"><TkIco d="x" /></button></header>
              <iframe title="The e-mail" srcDoc={m.html} sandbox="" />
            </div>
          </div>
        );
      })(), document.body)}
      {viewer && createPortal((() => {
        const pics = tFiles.filter(isImageFile);
        const at = pics.findIndex((x) => x.id === viewer.id);
        const go = (d: number) => { const n = pics[(at + d + pics.length) % pics.length]; if (n) setViewer(n); };
        const post = viewer.updateId ? thread?.posts.find((p) => p.id === viewer.updateId) : null;
        return (
          <div className="tdx-viewer" role="dialog" aria-modal="true" aria-label={viewer.name} onMouseDown={() => setViewer(null)}
            onKeyDown={(e) => { if (e.key === "Escape") setViewer(null); if (e.key === "ArrowRight") go(1); if (e.key === "ArrowLeft") go(-1); }} tabIndex={-1} ref={(el) => el?.focus()}>
            <div className="tdx-viewer-top" onMouseDown={(e) => e.stopPropagation()}>
              <span className="tdx-viewer-t"><b>{viewer.name}</b><small>{person(viewer.by)?.name ?? "Someone"} · {ago2(viewer.at)}{pics.length > 1 ? ` · ${at + 1} of ${pics.length}` : ""}</small></span>
              {post && <button type="button" className="tdx-viewer-btn" onClick={() => { setViewer(null); goPost(post.id); }}><TkIco d="reply" />Go to the comment</button>}
              {fileUrls[viewer.path] && <a className="tdx-viewer-btn" href={fileUrls[viewer.path]} target="_blank" rel="noopener noreferrer" download={viewer.name}><TkIco d="out" />Open</a>}
              <button type="button" className="tdx-viewer-x" onClick={() => setViewer(null)} aria-label="Close"><TkIco d="x" /></button>
            </div>
            {pics.length > 1 && <button type="button" className="tdx-viewer-nav is-prev" onMouseDown={(e) => e.stopPropagation()} onClick={() => go(-1)} aria-label="Previous"><TkIco d="chev" /></button>}
            {fileUrls[viewer.path] ? <img src={fileUrls[viewer.path]} alt={viewer.name} onMouseDown={(e) => e.stopPropagation()} /> : <div className="hs-skel tdx-viewer-sk" />}
            {pics.length > 1 && <button type="button" className="tdx-viewer-nav is-next" onMouseDown={(e) => e.stopPropagation()} onClick={() => go(1)} aria-label="Next"><TkIco d="chev" /></button>}
          </div>
        );
      })(), document.body)}
      {sigAt && (
        <Pop anchor={sigAt} onClose={() => setSigAt(null)} width={260}>
          <div className="tk-pop-list" role="menu">
            {(sigs ?? []).map((x) => (
              <button key={x.id} type="button" role="menuitemradio" aria-checked={sig?.id === x.id} className={`tk-pop-opt ${sig?.id === x.id ? "is-on" : ""}`} onClick={() => { setSigAt(null); setSigId(x.id); }}>
                <TkIco d="pen" /><span>{x.name}{x.isDefault && <em>Your default</em>}</span>
              </button>
            ))}
            <button type="button" role="menuitemradio" aria-checked={!sig} className={`tk-pop-opt ${!sig && sigs?.length ? "is-on" : ""}`} onClick={() => { setSigAt(null); setSigId(""); }}>
              <TkIco d="x" /><span>No signature</span>
            </button>
            <button type="button" role="menuitem" className="tk-pop-opt" onClick={() => { setSigAt(null); setSigManage(true); }}>
              <TkIco d="plus" /><span>{sigs?.length ? "Manage signatures…" : "Add a signature…"}<em>Paste yours, or bring it from Outlook</em></span>
            </button>
          </div>
        </Pop>
      )}
      {sigManage && <SignatureManager onClose={() => setSigManage(false)} startId={sig?.id ?? null} />}
      {moreAt && (
        <Pop anchor={moreAt} onClose={() => setMoreAt(null)} width={240}>
          <div className="tk-pop-list" role="menu">
            {isActive(t.stage) ? (
              <button type="button" role="menuitem" className="tk-pop-opt" onClick={() => { setMoreAt(null); set({ stage: "resolved" }); }}><TkIco d="check" /><span>{isTask ? "Mark done" : "Resolve"}</span></button>
            ) : (
              <button type="button" role="menuitem" className="tk-pop-opt" onClick={() => { setMoreAt(null); set({ stage: "open" }); }}><TkIco d="refresh" /><span>Reopen</span></button>
            )}
            <button type="button" role="menuitem" className="tk-pop-opt" onClick={() => { setMoreAt(null); switchCat(); }}>
              <TkIco d={isTask ? "mail" : "check"} /><span>{isTask ? "Turn into a ticket" : "Turn into a task"}<em>{isTask ? "It's a conversation, not work to do" : "It's work to do, not a conversation"}</em></span>
            </button>
            {!t.mergedInto && <button type="button" role="menuitem" className="tk-pop-opt" onClick={() => { const r = moreAt; setMoreAt(null); openMerge(r); }}><TkIco d="merge" /><span>Merge into another {noun}…</span></button>}
            {canDelete && <button type="button" role="menuitem" className="tk-pop-opt is-danger" onClick={() => { setMoreAt(null); setDelAsk(true); }}><TkIco d="trash" /><span>Delete {noun}…</span></button>}
          </div>
        </Pop>
      )}
      {mergeAt && (
        <Pop anchor={mergeAt} onClose={() => setMergeAt(null)} width={340}>
          {pickList ? <TicketPick tickets={pickList.filter((x) => x.category === t.category)} exclude={t.id} onPick={(x) => { setMergeAt(null); setMergeInto(x); }} placeholder={`Merge into which ${noun}?`} /> : <div className="hs-skel" />}
        </Pop>
      )}
      {watchAdd && (
        <Pop anchor={watchAdd} onClose={() => setWatchAdd(null)} width={250}>
          <PeopleMenu dir={dir} value={null} allowNone={false} onPick={(id) => { setWatchAdd(null); if (id && !t.watchers.includes(id)) toggleWatch(id); }} />
        </Pop>
      )}
    </aside>
  );
  if (inline) return sheet;
  return createPortal(
    <div className="td-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>{sheet}</div>,
    document.body,
  );
}

/**
 * The Tickets page (/tickets): the whole desk on a page of its own. ?ticket=… opens one;
 * the search's "Ticket inbox" lands on the e-mail waiting to be sorted.
 */
/** The Tickets page's sheet floating over any page (the home's card, the search): a ticket, a task, the
 *  guided walk for a new one, or an e-mail — in the page's modern look, not the old side drawer. */
function DeskFloat({ onClose, mail = false, children }: { onClose: () => void; mail?: boolean; children: React.ReactNode }) {
  useEffect(() => {
    document.body.classList.add("tkp-on");
    return () => { if (!document.querySelector(".tkp-page:not(.tkp-float-host)")) document.body.classList.remove("tkp-on"); };
  }, []);
  useEffect(() => {
    if (!mail) return;   // the ticket sheet handles its own Esc (first out of a field, then closed)
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".tk-pop, .tdx-viewer")) onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [mail, onClose]);
  return createPortal(
    <div className="tkp-page tkp-float-host">
      <div className="tkp2-float" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className={`tkp2-float-card is-over ${mail ? "is-mail" : ""}`}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
export function TicketsPage() {
  const loc = useLocation();
  const qs = new URLSearchParams(loc.search);
  const first = qs.get("ticket");
  const k = qs.get("kind");
  // the page's pop-ups (priority, people, date…) are portalled to <body>: this marks them as the Tickets page's, for its look
  useEffect(() => { document.body.classList.add("tkp-on"); return () => document.body.classList.remove("tkp-on"); }, []);
  return (
    <div className="tkp-page">
      <TicketDesk page openFirst={first} startKind={k === "task" ? "task" : "ticket"} startInbox={k === "inbox"} />
    </div>
  );
}

/** A ticket drawer opened from anywhere by id (global search). */
export function TicketDrawerById({ id, onClose }: { id: string; onClose: () => void }) {
  const [state, setState] = useState<{ t: Ticket | null; ready: boolean; dir: Directory; types: string[] } | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([loadTicket(id), loadDirectory(), loadTicketTypes()]).then(([r, dir, types]) => { if (alive) setState({ t: r.ticket, ready: r.ready, dir, types }); });
    const f = () => setState((s) => s && { ...s, dir: { ...s.dir } });
    window.addEventListener(DIR_EVENT, f);
    return () => { alive = false; window.removeEventListener(DIR_EVENT, f); };
  }, [id]);
  if (!state?.t) return null;
  return (
    <DeskFloat onClose={onClose}>
      <TicketDrawer inline ticket={state.t} dir={state.dir} types={state.types} ready={state.ready} onClose={onClose}
        onLocal={(t) => setState((s) => s && { ...s, t })} onTypes={(types) => setState((s) => s && { ...s, types })} />
    </DeskFloat>
  );
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
export function MailFrame({ html, maxHeight = 560 }: { html: string; maxHeight?: number }) {
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
/** The two SLA clocks (first reply, resolution) for the ticket's priority: met, missed, or time left. */
function SlaTimers({ t, sla, now }: { t: Ticket; sla: SlaMap | null; now: number }) {
  const target = sla?.[t.priority];
  const created = new Date(t.createdAt).getTime();
  const row = (label: string, minutes: number | null | undefined, doneAt: string | null) => {
    const head = (tgt: string | null) => <span className="tp-sla-top"><span>{label}</span>{tgt && <em>Target {tgt}</em>}</span>;
    if (!minutes) return <div className="tp-sla is-none">{head(null)}<b>No target</b></div>;
    const due = created + minutes * 60000;
    if (doneAt) {
      const took = new Date(doneAt).getTime() - created;
      const ok = new Date(doneAt).getTime() <= due;
      return (
        <div className={`tp-sla ${ok ? "is-met" : "is-breach"}`}>
          {head(span(minutes * 60000))}
          <b><TkIco d={ok ? "check" : "x"} />{ok ? "Met" : "Missed"}<small>took {span(took)}</small></b>
        </div>
      );
    }
    if (!isActive(t.stage)) return <div className="tp-sla is-none">{head(span(minutes * 60000))}<b>—</b></div>;
    const left = due - now;
    const tone = left < 0 ? "is-breach" : left < minutes * 60000 * 0.25 ? "is-soon" : "is-ok";
    const used = Math.max(0, Math.min(100, 100 - (left / (minutes * 60000)) * 100));
    return (
      <div className={`tp-sla ${tone}`}>
        {head(span(minutes * 60000))}
        <b><TkIco d={left < 0 ? "bolt" : "clock"} />{left < 0 ? `Late by ${span(left)}` : `${span(left)} left`}</b>
        <i className="tp-sla-bar"><i style={{ width: `${left < 0 ? 100 : used}%` }} /></i>
      </div>
    );
  };
  return (
    <div className="td-group td-slas">
      <span className="td-group-h"><TkIco d="bolt" />Service level <em>{PRIORITY_LABEL[t.priority].toLowerCase()} priority</em></span>
      <div className="tp-sla-list">
        {row("First reply", target?.firstResponse, t.firstResponseAt)}
        {row("Resolution", target?.resolution, isActive(t.stage) ? null : t.resolvedAt)}
      </div>
    </div>
  );
}

/* ---- steps: tick them off, give each one to someone ---- */
/* ---------------------------------------------------------------------
   Reordering a list by dragging its grip (steps of a task, of a template).
   The row follows the pointer, the others slide out of the way; on release
   onMove(from, to). The grip also takes ↑ / ↓ from the keyboard.
   --------------------------------------------------------------------- */
export function useDragSort(onMove: (from: number, to: number) => void) {
  const [st, setSt] = useState<{ from: number; over: number; dy: number; size: number } | null>(null);
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  /** rowSel: the rows, inside `list` (direct children). */
  const grab = (index: number, ref: { current: HTMLElement | null }, rowSel: string) => (e: React.PointerEvent) => {
    const list = ref.current;
    if (!list || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const rows = Array.from(list.querySelectorAll<HTMLElement>(`:scope > ${rowSel}`));
    const rects = rows.map((r) => r.getBoundingClientRect());
    if (!rects[index]) return;
    const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0;
    const size = rects[index].height + gap;
    const y0 = e.clientY;
    const mid = (r: DOMRect) => r.top + r.height / 2;
    let cur = { from: index, over: index, dy: 0, size };
    setSt(cur);
    document.body.classList.add("is-dragsorting");
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      const c = mid(rects[index]) + dy;
      let over = index;
      rects.forEach((r, i) => { if (i < index && c < mid(r)) over = Math.min(over, i); if (i > index && c > mid(r)) over = Math.max(over, i); });
      cur = { from: index, over, dy, size };
      setSt(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.classList.remove("is-dragsorting");
      setSt(null);
      if (cur.over !== cur.from) moveRef.current(cur.from, cur.over);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  /** ↑ / ↓ on the grip */
  const key = (index: number, count: number) => (e: React.KeyboardEvent) => {
    const to = e.key === "ArrowUp" ? index - 1 : e.key === "ArrowDown" ? index + 1 : -1;
    if (to < 0 || to >= count) return;
    e.preventDefault();
    moveRef.current(index, to);
  };
  /** where each row is drawn while one is held */
  const styleOf = (i: number): React.CSSProperties | undefined => {
    if (!st) return undefined;
    if (i === st.from) return { transform: `translateY(${st.dy}px)`, position: "relative", zIndex: 5, transition: "none" };
    if (st.from < st.over && i > st.from && i <= st.over) return { transform: `translateY(${-st.size}px)` };
    if (st.from > st.over && i >= st.over && i < st.from) return { transform: `translateY(${st.size}px)` };
    return { transform: "translateY(0)" };
  };
  return { grab, key, styleOf, held: st?.from ?? null, sorting: st !== null };
}
export const moveItem = <T,>(list: T[], from: number, to: number): T[] => { const out = [...list]; const [x] = out.splice(from, 1); out.splice(to, 0, x); return out; };
export const GripIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
);

function StepsPanel({ t, dir, people, onTask, onChecklist, onInvolve, shut = false, onFold, refs, onRef }: {
  t: Ticket; dir: Directory; people: MentionPerson[]; onTask: string[];
  onChecklist: (steps: TaskStep[]) => Promise<unknown> | void; onInvolve: (ids: string[]) => void;
  /** folded away (only the heading and how far along it is shows) */
  shut?: boolean; onFold?: () => void;
  /** The comments that point at each step ("@S2"), by step id — newest last; click to go to it. */
  refs?: Record<string, string[]>; onRef?: (postId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [pick, setPick] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const steps = t.checklist;
  const listRef = useRef<HTMLDivElement>(null);
  const sort = useDragSort((from, to) => void onChecklist(moveItem(steps, from, to)));
  const done = steps.filter((x) => x.done).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  const person = (id?: string | null) => (id ? dir.people.find((p) => p.id === id) ?? null : null);
  const commit = async (list: TaskStep[], who?: string | null) => { await onChecklist(list); if (who) onInvolve([who]); };
  /** "Send the draft @Ana": the step, given to Ana (a name at the end is who; one in the middle stays in the text). */
  const add = () => {
    const raw = draft.trim();
    if (!raw) return;
    const who = mentionIds(raw)[0] ?? null;
    const text = raw.replace(/(\s*@\[[^\]]*\]\([^)]*\))+\s*$/, "").trim();
    if (!text) return;
    setDraft("");
    void commit([...steps, { id: newStepId(), text, done: false, ...(who ? { who } : {}) }], who);
  };
  const saveEdit = () => {
    if (!editing) return;
    const v = editing.text.trim();
    const id = editing.id;
    setEditing(null);
    const cur = steps.find((x) => x.id === id);
    if (!cur || !v || v === cur.text) return;
    void commit(steps.map((x) => (x.id === id ? { ...x, text: v } : x)));
  };
  return (
    <section className={`td-sec tdx-sec tdx-steps ${shut ? "is-shut" : ""}`}>
      <div className="tdx-h">
        <h3>{onFold ? <button type="button" className="tdx-h-btn" onClick={onFold} aria-expanded={!shut}>Steps{steps.length > 0 && <em>{done}/{steps.length}</em>}</button> : <>Steps{steps.length > 0 && <em>{done}/{steps.length}</em>}</>}</h3>
        {steps.length > 0 && <span className={`tdx-meter ${pct === 100 ? "is-all" : ""}`} aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>}
        {steps.length > 0 && <span className="tdx-pct">{pct}%</span>}
        {shut && !steps.length && <span className="tdx-sum is-empty">No steps yet</span>}
        {onFold && <FoldBtn shut={shut} onClick={onFold} />}
      </div>
      <div className="tdx-fold-body"><div className="tdx-fold-in">
      <div className={`tdx-step-list ${sort.sorting ? "is-sorting" : ""}`} ref={listRef}>
        {steps.map((x, i) => {
          const w = person(x.who);
          return (
            <div key={x.id} data-step={x.id} className={`tdx-step ${x.done ? "is-done" : ""} ${x.who && x.who === dir.me && !x.done ? "is-mine" : ""} ${sort.held === i ? "is-held" : ""}`} style={sort.styleOf(i)}>
              {steps.length > 1 && (
                <span className="dsort-grip" role="button" tabIndex={0} onPointerDown={sort.grab(i, listRef, ".tdx-step")} onKeyDown={sort.key(i, steps.length)}
                  title="Drag to change the order (or ↑ / ↓)" aria-label={`Move step ${i + 1}`}><GripIcon /></span>
              )}
              <span className="tdx-step-no" title={`Step ${i + 1} — write @S${i + 1} in a comment to point at it`}>S{i + 1}</span>
              <button type="button" className="tdx-step-tick" onClick={() => void commit(steps.map((y) => (y.id === x.id ? tickStep(y, dir.me) : y)))}
                aria-label={x.done ? "Mark as not done" : "Mark as done"} title={x.done ? "Not done yet" : "Done"}><TkIco d="check" /></button>
              {editing?.id === x.id ? (
                <div className="tdx-step-edit" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) saveEdit(); }}>
                  <MentionInput value={editing.text} onChange={(v) => setEditing((ed) => (ed ? { ...ed, text: v } : ed))} people={people} onEnter={saveEdit} className="tdx-step-ed" />
                </div>
              ) : (
                <span className="tdx-step-txt" onClick={() => setEditing({ id: x.id, text: x.text })} title="Click to edit">
                  <span className="tdx-step-t"><Rich text={x.text} /></span>
                  {x.done && x.doneBy && (
                    <em className="tdx-step-by" title={x.doneAt ? new Date(x.doneAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : undefined}>
                      <TkIco d="check" />Done by {x.doneBy === dir.me ? "you" : person(x.doneBy)?.name ?? "someone"}{x.doneAt ? ` · ${ago(x.doneAt)}` : ""}
                    </em>
                  )}
                </span>
              )}
              {(refs?.[x.id]?.length ?? 0) > 0 && (
                <button type="button" className="tdx-step-ref" onClick={() => onRef?.(refs![x.id][refs![x.id].length - 1])}
                  title={refs![x.id].length === 1 ? "A comment points at this step — go to it" : `${refs![x.id].length} comments point at this step — go to the newest`}>
                  <TkIco d="reply" /><span>{refs![x.id].length}</span>
                </button>
              )}
              <button type="button" className={`tdx-step-who ${w ? "is-set" : ""}`} onClick={(e) => setPick({ id: x.id, rect: e.currentTarget.getBoundingClientRect() })}
                title={w ? `${w.name} does this step — click to change` : "Give this step to someone"}>
                {w ? <><Avatar person={w} size={20} /><span>{w.id === dir.me ? "You" : w.name.split(/\s+/)[0]}</span></> : <><TkIco d="user" /><span>Assign</span></>}
              </button>
              <button type="button" className="tdx-step-x" onClick={() => void commit(steps.filter((y) => y.id !== x.id))} aria-label="Remove step" title="Remove step"><TkIco d="x" /></button>
            </div>
          );
        })}
        <div className="tdx-step-add">
          <TkIco d="plus" />
          <MentionInput value={draft} onChange={setDraft} people={people} onEnter={add} className="tdx-step-ed"
            placeholder={steps.length ? "Add a step… end with @name to give it to someone" : "Break it into steps… end with @name to give one to someone"} />
          {draft.trim() && <button type="button" className="tdx-step-go" onMouseDown={(e) => e.preventDefault()} onClick={add}>Add</button>}
        </div>
      </div>
      </div></div>
      {pick && (
        <Pop anchor={pick.rect} onClose={() => setPick(null)} width={270}>
          <PeopleMenu dir={dir} value={steps.find((y) => y.id === pick.id)?.who ?? null} first={onTask} noneLabel="Nobody"
            onPick={(id) => { const sid = pick.id; setPick(null); void commit(steps.map((y) => (y.id === sid ? { ...y, who: id } : y)), id); }} />
        </Pop>
      )}
    </section>
  );
}

/* ---- the Tickets page's column headers filter and sort the list (the CRM's ColumnHead menus) ----
   The few operators a header sets, worked out here (CompaniesPage's applyView would pull that whole page in). */
function headHit<T>(f: FField<T>, c: FCond, r: T): boolean {
  const v = f.get(r);
  const empty = v === null || v === undefined || v === "";
  if (c.op === "has") return !empty;
  if (c.op === "empty") return empty;
  if (c.op === "in") return !c.values?.length || c.values.includes(String(v ?? ""));
  if (c.op === "nin") return !c.values?.includes(String(v ?? ""));
  if (c.op === "contains") return !(c.text ?? "").trim() || fold(String(v ?? "")).includes(fold((c.text ?? "").trim()));
  if (empty) return false;
  if (f.type === "number") {
    const n = Number(v), a = c.min ? Number(c.min) : null, b = c.max ? Number(c.max) : null;
    if (c.op === "between") return (a === null || n >= a) && (b === null || n <= b);
    if (c.op === "gt") return a === null || n > a;
    if (c.op === "lt") return a === null || n < a;
    if (c.op === "eq") return a === null || n === a;
    return true;
  }
  if (f.type === "date") {
    const d = String(v).slice(0, 10), today = isoDay(new Date());
    const off = (n: number) => isoDay(new Date(Date.now() + n * 86_400_000));
    switch (c.op) {
      case "between": return (!c.min || d >= c.min) && (!c.max || d <= c.max);
      case "before": return !c.min || d < c.min;
      case "after": return !c.min || d > c.min;
      case "last7": return d >= off(-7) && d <= today;
      case "last30": return d >= off(-30) && d <= today;
      case "last90": return d >= off(-90) && d <= today;
      case "next30": return d >= today && d <= off(30);
      case "this_month": return d.slice(0, 7) === today.slice(0, 7);
      case "this_year": return d.slice(0, 4) === today.slice(0, 4);
    }
  }
  return true;
}
function applyHead<T>(rows: T[], fields: FField<T>[], view: FView): T[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const conds = view.conds.filter((c) => byKey.has(c.field));
  let out = !conds.length ? rows : rows.filter((r) => {
    const hits = conds.map((c) => headHit(byKey.get(c.field)!, c, r));
    return view.match === "any" ? hits.some(Boolean) : hits.every(Boolean);
  });
  const sorts = view.sort.filter((x) => byKey.has(x.key));
  if (sorts.length) {
    out = [...out].sort((a, b) => {
      for (const x of sorts) {
        const f = byKey.get(x.key)!;
        const va = f.sort ? f.sort(a) : f.get(a), vb = f.sort ? f.sort(b) : f.get(b);
        const na = va === null || va === undefined || va === "", nb = vb === null || vb === undefined || vb === "";
        if (na && nb) continue;
        if (na) return 1;
        if (nb) return -1;
        const d = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
        if (d) return x.dir === "asc" ? d : -d;
      }
      return 0;
    });
  }
  return out;
}
/** Where the headers start: Status shows what's still open (tick Resolved / Closed in its menu to see those). */
const OPEN_STAGES = () => TICKET_STAGES.filter((x) => isActive(x.key)).map((x) => x.key as string);
const defaultHead = (): FView => ({ match: "all", conds: [{ id: "h:stage:open", field: "stage", op: "in", values: OPEN_STAGES() }], sort: [] });
const isDefaultHead = (v: FView) => v.conds.length === 1 && v.conds[0].field === "stage" && v.conds[0].op === "in"
  && [...(v.conds[0].values ?? [])].sort().join() === OPEN_STAGES().sort().join();
const readHead = (kind: ItemCat): FView => {
  try {
    const v = JSON.parse(localStorage.getItem(`tkp.head.${kind}`) ?? "null");
    if (v && Array.isArray(v.conds) && Array.isArray(v.sort)) return { match: v.match === "any" ? "any" : "all", conds: v.conds, sort: v.sort };
  } catch { /* private mode */ }
  return defaultHead();
};

/* ---- the list's columns: which ones and in what order is up to each person (per tickets / tasks, on this
   computer). The title always stays; on a narrow list some columns still step aside, as before. ---- */
const TKL_KEYS = ["id", "title", "type", "stage", "prio", "due", "xtra", "link", "own"] as const;
type TklKey = (typeof TKL_KEYS)[number];
const tklLabel = (k: TklKey, isT: boolean) => ({ id: "ID", title: isT ? "Ticket" : "Task", type: "Type", stage: "Status", prio: "Priority", due: "Due", xtra: isT ? "SLA" : "Steps", link: "Linked to", own: "Owner" })[k];
const readCols = (kind: ItemCat): TklKey[] => {
  try {
    const v = JSON.parse(localStorage.getItem(`tkp.cols.${kind}`) ?? "null");
    if (Array.isArray(v)) {
      const xs = v.filter((x, i): x is TklKey => (TKL_KEYS as readonly string[]).includes(x) && v.indexOf(x) === i);
      if (!xs.includes("title")) xs.unshift("title");
      return xs;
    }
  } catch { /* private mode */ }
  return [...TKL_KEYS];
};
const isDefaultCols = (xs: TklKey[]) => xs.join() === TKL_KEYS.join();
/** The grid for the columns shown, in their order, at the list's width (the same steps as the CSS that hides cells). */
const tklTemplate = (order: TklKey[], isT: boolean, w: number) => {
  const W = w > 0 ? w : 9999;
  const off = new Set<TklKey>();
  if (W <= 1180) off.add("link");
  if (W <= 1020) off.add("type");
  if (W <= 900) { off.add("id"); off.add("xtra"); }
  if (W <= 700) { off.add("stage"); off.add("prio"); }
  const size: Record<TklKey, string> = {
    id: isT ? "58px" : "50px",
    title: W > 1180 ? "minmax(240px, 1fr)" : W > 1020 ? "minmax(200px, 1fr)" : W > 900 ? "minmax(180px, 1fr)" : W > 700 ? "minmax(160px, 1fr)" : "minmax(0, 1fr)",
    type: "96px", stage: "108px", prio: "84px", due: W <= 700 ? "minmax(64px, auto)" : "124px", xtra: isT ? "108px" : "92px",
    link: "minmax(110px, 160px)", own: "64px",
  };
  return `${W <= 700 ? "16px 24px" : "18px 26px"} ${order.filter((k) => !off.has(k)).map((k) => size[k]).join(" ")}`;
};

/* ---- the Tickets page's right-hand panel: it grows out of the list's edge when something opens, shrinks
   back into it when it closes (what it showed stays until it's gone), and widens to the full page and back —
   real widths that animate, so the list and the open sheet make room for each other as they move ---- */
function SlidePane({ wide, children }: { wide: boolean; children: React.ReactNode }) {
  const present = !!children;
  const last = useRef<React.ReactNode>(null);
  if (present) last.current = children;
  const [mounted, setMounted] = useState(present);
  const [shown, setShown] = useState(false);
  const [moving, setMoving] = useState(false);
  const moveT = useRef<number | null>(null);
  const move = () => {
    setMoving(true);
    if (moveT.current) window.clearTimeout(moveT.current);
    moveT.current = window.setTimeout(() => setMoving(false), 560);
  };
  useEffect(() => {
    if (present) {
      setMounted(true);
      move();
      let r2 = 0;
      const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setShown(true)); });
      return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
    }
    setShown(false);
    move();
    const t = window.setTimeout(() => { setMounted(false); last.current = null; }, 520);
    return () => window.clearTimeout(t);
  }, [present]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } move(); }, [wide]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (moveT.current) window.clearTimeout(moveT.current); }, []);
  if (!mounted && !present) return null;
  return (
    <div className={`tkp2-pane tkp2-slide ${shown && present ? "is-in" : ""} ${moving ? "is-moving" : ""}`}>
      <div className="tkp2-slide-in">{present ? children : last.current}</div>
    </div>
  );
}

/* ---- "You've been given a task": the e-mail a new ticket / task can send to its owner and watchers ----
   Next's look: ink header with a lime tag, white card, the context and the steps, one lime button to open it. Inline
   styles and tables only, so Outlook, Gmail and phones all show it the same. */
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function ticketNoticeEmail(o: {
  isTask: boolean; ref: string; title: string; description: string; steps: { text: string; who?: string | null }[];
  priority: TaskPriority; due: string | null; from: string; to: string; role: "owner" | "watcher"; link: string; links: string[];
}): { subject: string; html: string; text: string } {
  const noun = o.isTask ? "task" : "ticket";
  const what = o.role === "owner" ? `assigned you a ${noun}` : `added you to a ${noun}`;
  const subject = `${o.from} ${what}: ${o.title} [${o.ref}]`;
  const due = o.due ? new Date(o.due).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : null;
  const prioTone: Record<TaskPriority, string> = { urgent: "#c23a2b", high: "#c9771f", normal: "#4a524e", low: "#7b8580" };
  const desc = o.description.trim();
  const para = (s: string) => escHtml(s).replace(/\n{2,}/g, "</p><p style=\"margin:0 0 10px\">").replace(/\n/g, "<br>");
  const fact = (k: string, v: string, tone = "#111815") => `<td style="padding:0 18px 0 0;vertical-align:top"><div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#8a9a93;margin-bottom:4px">${k}</div><div style="font-size:14px;font-weight:600;color:${tone}">${escHtml(v)}</div></td>`;
  const steps = o.steps.map((x, i) => `<tr><td style="padding:7px 0;vertical-align:top;width:40px"><span style="display:inline-block;min-width:26px;padding:3px 0;border-radius:7px;background:#f3f4f3;color:#4a524e;font-size:11px;font-weight:700;text-align:center">S${i + 1}</span></td><td style="padding:7px 0;font-size:14px;line-height:1.45;color:#111815">${escHtml(x.text)}${x.who ? ` <span style="color:#7b8580">· ${escHtml(x.who)}</span>` : ""}</td></tr>`).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f3;padding:28px 12px;font-family:Inter,'Segoe UI',Helvetica,Arial,sans-serif">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="background:#111815;padding:22px 28px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-size:18px;font-weight:700;letter-spacing:-.02em;color:#ffffff">Next</td>
    <td align="right"><span style="display:inline-block;padding:5px 12px;border-radius:999px;background:#d4f25f;color:#1f2a06;font-size:12px;font-weight:700">${o.isTask ? "New task" : "New ticket"} · ${escHtml(o.ref)}</span></td>
  </tr></table>
</td></tr>
<tr><td style="padding:28px 28px 8px">
  <div style="font-size:14px;color:#4a524e;margin-bottom:6px">Hi ${escHtml(o.to.split(/\s+/)[0] || o.to)},</div>
  <div style="font-size:15px;color:#4a524e;margin-bottom:14px"><b style="color:#111815">${escHtml(o.from)}</b> ${what}${o.role === "watcher" ? " — you'll hear about what happens on it" : ""}.</div>
  <div style="font-size:24px;font-weight:700;letter-spacing:-.03em;line-height:1.2;color:#111815;margin-bottom:18px">${escHtml(o.title)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:20px"><tr>
    ${fact("Priority", PRIORITY_LABEL[o.priority], prioTone[o.priority])}${due ? fact("Due", due) : ""}${o.links.length ? fact("For", o.links.join(" · ")) : ""}
  </tr></table>
</td></tr>
${desc ? `<tr><td style="padding:0 28px 8px"><div style="padding:16px 18px;border-radius:16px;background:#f7f8f7;font-size:14px;line-height:1.6;color:#111815"><div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#8a9a93;margin-bottom:8px">Context</div><p style="margin:0 0 10px">${para(desc)}</p></div></td></tr>` : ""}
${o.steps.length ? `<tr><td style="padding:12px 28px 4px"><div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#8a9a93;margin-bottom:4px">Steps</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${steps}</table></td></tr>` : ""}
<tr><td style="padding:22px 28px 30px">
  <a href="${escHtml(o.link)}" style="display:inline-block;padding:14px 24px;border-radius:999px;background:#d4f25f;color:#1f2a06;font-size:15px;font-weight:700;text-decoration:none">Open the ${noun} in Next &rarr;</a>
</td></tr>
</table>
<div style="max-width:600px;padding:14px 8px;font-size:12px;color:#8a9a93;text-align:center">Sent from Next by ${escHtml(o.from)} · Reply in Next so everyone on the ${noun} sees it.</div>
</td></tr></table></body></html>`;
  const text = `${o.from} ${what}: ${o.title} (${o.ref})\n${due ? `Due ${due} · ` : ""}Priority ${PRIORITY_LABEL[o.priority]}\n${desc ? `\n${desc}\n` : ""}${o.steps.length ? `\n${o.steps.map((x, i) => `S${i + 1}. ${x.text}`).join("\n")}\n` : ""}\nOpen it: ${o.link}`;
  return { subject, html, text };
}

/** A comment's text with its "@S2" step mentions as live chips (numbered as the steps are now); click one to go to the step. */
function StepRefText({ text, steps, onStep }: { text: string; steps: TaskStep[]; onStep?: (id: string) => void }) {
  if (!text.includes("](step:")) return <Rich text={text} />;
  const out: React.ReactNode[] = [];
  let last = 0, n = 0;
  for (const m of text.matchAll(STEP_REF_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(<Rich key={`t${n++}`} text={text.slice(last, at)} />);
    const i = steps.findIndex((x) => x.id === m[2]);
    const st = i >= 0 ? steps[i] : null;
    out.push(
      <button key={`s${n++}`} type="button" className={`tdx-sref ${st ? (st.done ? "is-done" : "") : "is-gone"}`} onClick={() => st && onStep?.(st.id)}
        title={st ? `Step ${i + 1}: ${plain(st.text)}` : "This step was removed"} disabled={!st}>
        {st ? `S${i + 1}` : m[1]}{st?.done && <TkIco d="check" />}
      </button>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(<Rich key={`t${n++}`} text={text.slice(last)} />);
  return <>{out}</>;
}

/** Pictures as thumbnails, other files as chips; click to open (pictures in a viewer). */
function FileTiles({ files, urls, onOpen, onRemove, canRemove, big = false }: {
  files: TicketFile[]; urls: Record<string, string>; onOpen: (f: TicketFile) => void;
  onRemove?: (f: TicketFile) => void; canRemove?: (f: TicketFile) => boolean; big?: boolean;
}) {
  const pics = files.filter(isImageFile), docs = files.filter((f) => !isImageFile(f));
  return (
    <div className={`tdx-files ${big ? "is-big" : ""}`}>
      {pics.length > 0 && (
        <div className="tdx-pics">
          {pics.map((f) => (
            <span key={f.id} className="tdx-pic">
              <button type="button" className="tdx-pic-b" onClick={() => onOpen(f)} title={f.name}>
                {urls[f.path] ? <img src={urls[f.path]} alt={f.name} loading="lazy" /> : <i className="tdx-pic-ph" />}
              </button>
              {onRemove && canRemove?.(f) && <button type="button" className="tdx-file-x" onClick={() => onRemove(f)} aria-label={`Remove ${f.name}`} title="Remove"><TkIco d="x" /></button>}
            </span>
          ))}
        </div>
      )}
      {docs.length > 0 && (
        <div className="tdx-docs">
          {docs.map((f) => (
            <span key={f.id} className="tdx-doc">
              <button type="button" className="tdx-doc-b" onClick={() => onOpen(f)} title={`Open ${f.name}`}>
                <span className="tdx-doc-ico"><TkIco d="clip" /></span>
                <span className="tdx-doc-t"><b>{f.name}</b><small>{fileSize(f.size)}</small></span>
              </button>
              {onRemove && canRemove?.(f) && <button type="button" className="tdx-file-x" onClick={() => onRemove(f)} aria-label={`Remove ${f.name}`} title="Remove"><TkIco d="x" /></button>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The page's sections (Inbox, Tickets, Tasks — and list / board) cross over instead of blinking: the one you
 * leave stays a moment, sliding away and fading, while the next slides in from the side you went to. The
 * leaving one keeps its own scroll position (it is the same element, only frozen). Rows don't play their own
 * entrance inside a section that came in this way, so the list moves as one.
 */
function SectionSwap({ k, rank, children }: { k: string; rank: number; children: React.ReactNode }) {
  const cur = useRef<{ k: string; rank: number; node: React.ReactNode }>({ k, rank, node: children });
  const swapped = useRef(false);
  const [out, setOut] = useState<{ k: string; node: React.ReactNode; dir: number; n: number } | null>(null);
  const prev = cur.current;
  if (prev.k !== k) {
    swapped.current = true;
    const dir = rank === prev.rank ? 1 : rank > prev.rank ? 1 : -1;
    setOut((o) => ({ k: prev.k, node: prev.node, dir, n: (o?.n ?? 0) + 1 }));
  }
  cur.current = { k, rank, node: children };
  useEffect(() => {
    if (!out) return;
    const t = window.setTimeout(() => setOut(null), 260);
    return () => window.clearTimeout(t);
  }, [out?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const leaving = out && out.k !== k ? out : null;
  return (
    <div className="tkp2-swap" style={{ ["--dir" as string]: out?.dir ?? 1 } as React.CSSProperties}>
      {leaving && <div key={leaving.k} className="tkp2-swap-l is-out" aria-hidden="true" inert>{leaving.node}</div>}
      <div key={k} className={`tkp2-swap-l ${swapped.current ? "is-swapped" : ""}`}>{children}</div>
    </div>
  );
}

/* ---- a sheet's sections fold away: which ones are folded is remembered on this computer ---- */
function useFolds() {
  const [shut, setShut] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem("ticketFold") ?? "{}") ?? {}; } catch { return {}; } });
  const flip = (k: string) => setShut((x) => {
    const n = { ...x, [k]: !x[k] };
    try { localStorage.setItem("ticketFold", JSON.stringify(n)); } catch { /* private mode */ }
    return n;
  });
  return { shut, flip };
}
function FoldBtn({ shut, onClick }: { shut: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`tdx-fold ${shut ? "is-shut" : ""}`} onClick={onClick} aria-expanded={!shut} title={shut ? "Expand" : "Collapse"} aria-label={shut ? "Expand" : "Collapse"}>
      <TkIco d="chev" />
    </button>
  );
}

/* ---- where the time went: each stage, as one bar ---- */
function TimeInStage({ t, events, now }: { t: Ticket; events: TicketEvent[]; now: number }) {
  const segs = stageSegments(t, events, now);
  const total = Math.max(1, segs.reduce((n, s) => n + (s.to - s.from), 0));
  const created = new Date(t.createdAt).getTime();
  return (
    <div className="td-group tdx-time" aria-label="Time in each stage">
      <span className="td-group-h"><TkIco d="clock" />Time in each stage
        <em>{isActive(t.stage) ? `open ${span(now - created)}` : t.resolvedAt ? `done in ${span(new Date(t.resolvedAt).getTime() - created)}` : ""}</em></span>
      <div className="tp-bar">
        {segs.map((sg, i) => (
          <span key={i} className={`tp-seg is-${sg.stage} ${sg.ongoing ? "is-now" : ""}`} style={{ flexGrow: Math.max(0.04, (sg.to - sg.from) / total) }} title={`${stageLabel(sg.stage, t.category)}: ${span(sg.to - sg.from)}`} />
        ))}
      </div>
      {/* the total per stage (a stage visited twice counts once), the current one marked */}
      <ol className="tp-steps">
        {(() => {
          const sum = new Map<TicketStage, { ms: number; now: boolean }>();
          segs.forEach((sg) => { const x = sum.get(sg.stage) ?? { ms: 0, now: false }; x.ms += sg.to - sg.from; x.now = x.now || !!sg.ongoing; sum.set(sg.stage, x); });
          return [...sum.entries()].filter(([, x]) => x.now || x.ms >= 60_000).map(([st, x]) => (
            <li key={st} className={`is-${st} ${x.now ? "is-now" : ""}`}>
              <span className={`tk-dot is-${st}`} />
              <b>{stageLabel(st, t.category)}</b>
              {x.now && <i className="tp-now">Now</i>}
              <em>{span(x.ms)}</em>
            </li>
          ));
        })()}
      </ol>
    </div>
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
/* ---- Who wrote: the company's logo when we know the company (its client, or a company in the CRM with the
   sender's e-mail domain), else the person's initials. Free mail (gmail…) and our own domains stay initials. ---- */
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.es", "live.com", "msn.com", "yahoo.com", "yahoo.es",
  "icloud.com", "me.com", "mac.com", "aol.com", "gmx.com", "gmx.de", "gmx.net", "web.de", "protonmail.com", "proton.me", "zoho.com", "mail.com", "yandex.com", "telefonica.net"]);
const mailCo = new Map<string, { name: string; website: string } | null>();
const mailCoSubs = new Set<() => void>();
let mailCoQueue: string[] = [];
let mailCoTimer: ReturnType<typeof setTimeout> | null = null;
const domainOfMail = (email?: string | null) => { const d = String(email ?? "").split("@")[1]?.trim().toLowerCase().replace(/^www\./, "") ?? ""; return d.includes(".") ? d : ""; };
function askMailCo(d: string) {
  if (mailCo.has(d) || mailCoQueue.includes(d)) return;
  mailCoQueue.push(d);
  if (mailCoTimer) return;
  mailCoTimer = setTimeout(async () => {
    const ds = mailCoQueue; mailCoQueue = []; mailCoTimer = null;
    for (let i = 0; i < ds.length; i += 20) {
      const part = ds.slice(i, i + 20);
      try {
        // the site starts with the domain, or has it right after "//" or a dot (altia.es ≠ novaltia.es)
        const ors = part.flatMap((d) => [`website.ilike.${d}*`, `website.ilike.*/${d}*`, `website.ilike.*.${d}*`]).join(",");
        const { data } = await supabase.from("companies").select("name, website").or(ors).limit(600);
        const rows = ((data ?? []) as { name: string | null; website: string | null }[]).filter((r) => r.website);
        part.forEach((d) => {
          // the company whose site is this domain (or the domain is a part of it: mail.acme.com → acme.com)
          const hit = rows.find((r) => domainOf(r.website) === d) ?? rows.find((r) => { const w = domainOf(r.website); return !!w && d.endsWith(`.${w}`); });
          mailCo.set(d, hit ? { name: hit.name || d, website: hit.website! } : null);
        });
      } catch { part.forEach((d) => mailCo.set(d, null)); }
    }
    mailCoSubs.forEach((f) => f());
  }, 40);
}
function MailAvatar({ m, boxes, name, lg = false }: { m: MailMsg; boxes: Mailbox[]; name: string; lg?: boolean }) {
  const clientSite = useClientSite(null, m.clientId);
  const d = domainOfMail(m.fromEmail);
  const ours = !d || FREE_MAIL.has(d) || boxes.some((b) => domainOfMail(b.address) === d);
  const [, bump] = useState(0);
  useEffect(() => {
    if (ours) return;
    const f = () => bump((v) => v + 1);
    mailCoSubs.add(f);
    askMailCo(d);
    return () => { mailCoSubs.delete(f); };
  }, [d, ours]);
  const co = !ours ? mailCo.get(d) : null;
  const site = clientSite || co?.website || "";
  if (site) return <CompanyLogo name={co?.name || name} website={site} className={`tm-row-av tm-logo ${lg ? "is-lg" : ""}`} />;
  return <span className={`tm-row-av ${lg ? "is-lg" : ""}`} style={{ background: toneOf(m.fromEmail || name) }}><PicOr name={name}>{initials(name)}</PicOr></span>;
}

function MailRow({ m, boxes, i, on = false, onOpen, onCreate, onTask, onAdd, onRule, onIgnore }: {
  m: MailMsg; boxes: Mailbox[]; i: number; on?: boolean;
  onOpen: () => void; onCreate: () => void; onTask?: () => void; onAdd: (r: DOMRect) => void; onRule: () => void; onIgnore: () => void;
}) {
  const box = boxes.find((b) => b.id === m.mailboxId);
  const name = m.fromName || m.fromEmail || "Unknown sender";
  return (
    <div className={`tm-row ${on ? "is-on" : ""}`} style={{ ["--i" as string]: Math.min(i, 12) } as React.CSSProperties} role="button" tabIndex={0}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <MailAvatar m={m} boxes={boxes} name={name} />
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
        {onTask && <button type="button" className="tm-act" onClick={onTask} title="Create a task from this e-mail"><TkIco d="check" /></button>}
        <button type="button" className="tm-act" onClick={(e) => onAdd(e.currentTarget.getBoundingClientRect())} title="Add to an existing ticket"><TkIco d="link" /></button>
        <button type="button" className="tm-act" onClick={onRule} title="Make a rule from this e-mail"><TkIco d="filter" /></button>
        <button type="button" className="tm-act" onClick={onIgnore} title="Ignore — hide it from the Inbox"><TkIco d="ban" /></button>
      </div>
    </div>
  );
}
function MailPreview({ m, boxes, inline = false, wide = false, onWide, onClose, onCreate, onTask, onAdd, onRule, onIgnore }: {
  wide?: boolean; onWide?: () => void;
  m: MailMsg; boxes: Mailbox[]; onClose: () => void; onCreate: () => void; onTask?: () => void; onAdd: (r: DOMRect) => void; onRule: () => void; onIgnore: () => void;
  /** Beside the list (the Tickets page's Inbox) instead of a window over the page. */
  inline?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  const box = boxes.find((b) => b.id === m.mailboxId);
  const card = (
      <div className={`tm-modal ${inline ? "is-inline" : ""}`} role={inline ? "region" : "dialog"} aria-label="E-mail">
        <header className="tm-modal-h">
          <MailAvatar m={m} boxes={boxes} name={m.fromName || m.fromEmail || "?"} lg />
          <div className="tm-modal-who">
            <b>{m.fromName || m.fromEmail}</b>
            <span>{m.fromEmail}{box ? ` → ${box.label || box.address}` : ""} · {fullDate(m.at)}</span>
          </div>
          {inline && onWide && <button type="button" className={`td-x tm-wide ${wide ? "is-on" : ""}`} onClick={onWide} title={wide ? "Back to the list beside it" : "Full width"} aria-label={wide ? "Back to the list" : "Full width"} aria-pressed={wide}><TkIco d={wide ? "shrink" : "expand"} /></button>}
          <button type="button" className="td-x" onClick={onClose} aria-label="Close"><TkIco d="x" /></button>
        </header>
        <h3 className="tm-modal-subj">{m.subject || "(no subject)"}</h3>
        {(m.to.length > 0 || m.cc.length > 0) && <p className="tm-modal-to">To {m.to.map((x) => x.email).join(", ")}{m.cc.length ? ` · Cc ${m.cc.map((x) => x.email).join(", ")}` : ""}</p>}
        <div className="tm-modal-body">{m.html ? <MailFrame html={m.html} maxHeight={2000} /> : <p className="tm-card-snip">{m.snippet}</p>}<Attachments m={m} /></div>
        <footer className="tm-modal-f">
          <button type="button" className="td-ghost tm-f-opt" onClick={onIgnore} title="Ignore — hide it from the Inbox"><TkIco d="ban" /><span>Ignore</span></button>
          <button type="button" className="td-ghost tm-f-opt" onClick={onRule} title="Make a rule from this e-mail"><TkIco d="filter" /><span>Make a rule</span></button>
          <span className="td-spacer" />
          <button type="button" className="td-ghost tm-f-opt" onClick={(e) => onAdd(e.currentTarget.getBoundingClientRect())} title="Add to an existing ticket"><TkIco d="link" /><span>Add to ticket…</span></button>
          {onTask && <button type="button" className="td-ghost" onClick={onTask} title="It's work to do, not a conversation"><TkIco d="check" />Create task</button>}
          <button type="button" className="td-primary" onClick={onCreate}><TkIco d="plus" />Create ticket</button>
        </footer>
      </div>
  );
  if (inline) return card;
  return createPortal(
    <div className="td-back tm-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>{card}</div>,
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
type SettingsTab = "rules" | "mine" | "segments" | "mailboxes" | "sla";
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
    : r.action === "file" ? `file it under ${dir?.clients.find((x) => x.id === r.set.client_id)?.name ?? "the client"}`
    : r.action === "append" ? `add it to ${tgt ? `${ticketRef(tgt)} “${plain(tgt.title)}”` : "a ticket"}`
    : `open a ticket${r.set.type ? ` (${r.set.type})` : ""}${r.set.priority ? `, ${PRIORITY_LABEL[r.set.priority].toLowerCase()} priority` : ""}${r.set.assignee_id ? ` for ${r.set.assignee_id === dir?.me ? "me" : dir?.people.find((p) => p.id === r.set.assignee_id)?.name ?? "someone"}` : r.ownerId ? " for me" : ""}`;
  return { when, then };
}
function RuleEditor({ rule, dir, types, tickets, boxes, inbox, onSave, onCancel, personal }: {
  rule: MailRule; dir: Directory; types: string[]; tickets: Ticket[]; boxes: Mailbox[]; inbox: MailMsg[]; personal?: boolean;
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
      <input className="tr-name" value={r.name} autoFocus placeholder={personal ? "Name this rule, e.g. “My Acme requests”" : "Name this rule, e.g. “Acme support requests”"} onChange={(e) => setR({ ...r, name: e.target.value })} />
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
              <div className="tr-chip-add"><Select searchable value="" onChange={(v) => v && setC({ from_contact_ids: [...new Set([...(c.from_contact_ids ?? []), v])] })} options={opt(dir.remote ? [] : dir.contacts.filter((x) => x.email), "+ contact")}
                loadOptions={dir.remote ? dirSearch(dir, "contact", (h) => !!h.email) : undefined} /></div>
            </div>
          </div>
          <div className="tr-f"><span>From anyone at</span><Select searchable value={c.from_company_id ?? ""} onChange={(v) => setC({ from_company_id: v || null })} options={opt(dir.remote ? dir.companies.filter((x) => x.id === c.from_company_id) : dir.companies, "Any company")}
            loadOptions={dir.remote ? dirSearch(dir, "company") : undefined} /></div>
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
            <div className="tr-f"><span>Owner</span><Select searchable value={r.set.assignee_id ?? ""} onChange={(v) => setS({ assignee_id: v || null })} options={opt(dir.people.filter((p) => !p.former), personal ? "Me" : "Unassigned")} /></div>
            <div className="tr-f"><span>Team</span><Select value={r.set.team ?? ""} onChange={(v) => setS({ team: v || null })} options={[{ value: "", label: "Any team" }, ...departments.map((d) => ({ value: d, label: deptName(d) }))]} /></div>
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
function SegmentEditor({ seg, dir, boxes, inbox, onSave, onSaveShow, onCancel }: {
  seg: MailSegment; dir: Directory; boxes: Mailbox[]; inbox: MailMsg[];
  onSave: (s: MailSegment) => void; onSaveShow: (s: MailSegment) => void; onCancel: () => void;
}) {
  const [g, setG] = useState<MailSegment>(seg);
  const [emails, setEmails] = useState((seg.conditions.from_emails ?? []).join(", "));
  const c = g.conditions;
  const setC = (p: Partial<SegConditions>) => setG({ ...g, conditions: { ...c, ...p } });
  const list = emails.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const live: MailSegment = { ...g, name: g.name.trim(), conditions: { ...c, from_emails: list } };
  const hits = inbox.filter((m) => segmentMatches(live.conditions, m, dir));
  // one click: the senders' domains that come up most in the Inbox
  const domains = useMemo(() => {
    const n = new Map<string, number>();
    for (const m of inbox) { const d = (m.fromEmail ?? "").toLowerCase().split("@")[1]; if (d) n.set(d, (n.get(d) ?? 0) + 1); }
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [inbox]);
  const toggleDomain = (d: string) => {
    const k = `@${d}`;
    setEmails((list.includes(k) ? list.filter((x) => x !== k) : [...list, k]).join(", "));
  };
  const opt = (xs: { id: string; name: string }[], none: string) => [{ value: "", label: none }, ...xs.map((x) => ({ value: x.id, label: x.name }))];
  const ok = !!live.name && segmentSummary(live.conditions, dir) !== "no conditions yet (shows nothing)";
  return (
    <div className="tr-ed tsg-ed" style={{ ["--c" as string]: g.color } as React.CSSProperties}>
      <div className="tsg-top">
        <span className="tsg-dot is-big" />
        <input className="tr-name" value={g.name} autoFocus placeholder="Name this segment, e.g. “Altia” or “Invoices”" onChange={(e) => setG({ ...g, name: e.target.value })} />
        <div className="tsg-colors" role="radiogroup" aria-label="Colour">
          {SEG_COLORS.map((x) => (
            <button key={x} type="button" role="radio" aria-checked={g.color === x} className={g.color === x ? "is-on" : ""} style={{ ["--c" as string]: x } as React.CSSProperties} onClick={() => setG({ ...g, color: x })} aria-label="Colour" />
          ))}
        </div>
      </div>
      <div className="tr-block">
        <div className="tr-block-h"><span className="tr-step tsg-step"><TkIco d="filter" /></span><b>Which e-mails</b>
          <div className="tk-seg">
            <button type="button" className={c.match !== "any" ? "is-on" : ""} onClick={() => setC({ match: "all" })}>matching all</button>
            <button type="button" className={c.match === "any" ? "is-on" : ""} onClick={() => setC({ match: "any" })}>any</button>
          </div>
        </div>
        {domains.length > 0 && (
          <div className="tsg-quick">
            <span>Senders in your Inbox</span>
            {domains.map(([d, n]) => (
              <button key={d} type="button" className={list.includes(`@${d}`) ? "is-on" : ""} onClick={() => toggleDomain(d)}>@{d}<i>{n}</i></button>
            ))}
          </div>
        )}
        <div className="tr-grid">
          <label><span>From these addresses or domains</span><input className="td-in" value={emails} placeholder="ana@acme.es, @acme.es" onChange={(e) => setEmails(e.target.value)} /></label>
          <label><span>Sender contains</span><input className="td-in" value={c.from_contains ?? ""} placeholder="acme" onChange={(e) => setC({ from_contains: e.target.value })} /></label>
          <div className="tr-f"><span>From these contacts</span>
            <div className="tr-chips">
              {(c.from_contact_ids ?? []).map((id) => (
                <span key={id} className="td-tag">{dir.contacts.find((x) => x.id === id)?.name ?? "Contact"}<button type="button" onClick={() => setC({ from_contact_ids: (c.from_contact_ids ?? []).filter((x) => x !== id) })} aria-label="Remove"><TkIco d="x" /></button></span>
              ))}
              <div className="tr-chip-add"><Select searchable value="" onChange={(v) => v && setC({ from_contact_ids: [...new Set([...(c.from_contact_ids ?? []), v])] })} options={opt(dir.remote ? [] : dir.contacts.filter((x) => x.email), "+ contact")}
                loadOptions={dir.remote ? dirSearch(dir, "contact", (h) => !!h.email) : undefined} /></div>
            </div>
          </div>
          <div className="tr-f"><span>Sent to mailbox</span><Select value={c.mailbox ?? ""} onChange={(v) => setC({ mailbox: v })} options={[{ value: "", label: "Any mailbox" }, ...boxes.map((b) => ({ value: b.address, label: b.label ? `${b.label} · ${b.address}` : b.address }))]} /></div>
          <label><span>To or Cc contains</span><input className="td-in" value={c.to_contains ?? ""} placeholder="finance@" onChange={(e) => setC({ to_contains: e.target.value })} /></label>
          <label><span>Subject contains</span><input className="td-in" value={c.subject_contains ?? ""} placeholder="Invoice" onChange={(e) => setC({ subject_contains: e.target.value })} /></label>
          <label><span>Text contains</span><input className="td-in" value={c.body_contains ?? ""} placeholder="urgent" onChange={(e) => setC({ body_contains: e.target.value })} /></label>
          <div className="tr-f"><span>Filed under client</span><Select searchable value={c.client_id ?? ""} onChange={(v) => setC({ client_id: v || null })} options={opt(dir.clients, "Any client")} /></div>
          <div className="tr-f"><span>Received</span><Select value={String(c.within_days ?? "")} onChange={(v) => setC({ within_days: v ? Number(v) : null })}
            options={[{ value: "", label: "Any time" }, { value: "1", label: "Today" }, { value: "7", label: "In the last 7 days" }, { value: "30", label: "In the last 30 days" }]} /></div>
          <div className="tr-f"><span>Attachments</span>
            <button type="button" role="switch" aria-checked={!!c.has_attachments} className={`tsg-att ${c.has_attachments ? "is-on" : ""}`} onClick={() => setC({ has_attachments: !c.has_attachments })}>
              <TkIco d="clip" />Only e-mails with attachments<i className={`ts-switch ${c.has_attachments ? "is-on" : ""}`}><i /></i>
            </button>
          </div>
        </div>
      </div>
      <div className={`tr-preview tsg-preview ${hits.length ? "is-hit" : ""}`}>
        <div className="tsg-preview-h"><TkIco d="inbox" />
          {hits.length ? <span><b>{hits.length}</b> e-mail{hits.length === 1 ? "" : "s"} in the Inbox fit{hits.length === 1 ? "s" : ""} it now</span>
            : <span>{segmentSummary(live.conditions, dir) === "no conditions yet (shows nothing)" ? "Add at least one condition." : "Nothing in the Inbox fits it right now — new e-mail that does will show up."}</span>}
        </div>
        {hits.length > 0 && (
          <ul className="tsg-hits">
            {hits.slice(0, 4).map((m) => (
              <li key={m.id}><b>{m.fromName || m.fromEmail || "Unknown sender"}</b><span>{m.subject || "(no subject)"}</span><time>{ago(m.at)}</time></li>
            ))}
            {hits.length > 4 && <li className="is-more">+ {hits.length - 4} more</li>}
          </ul>
        )}
      </div>
      <div className="tr-foot">
        <button type="button" className="td-ghost" onClick={onCancel}>Cancel</button>
        <span className="td-spacer" />
        <button type="button" className="td-ghost" disabled={!ok} onClick={() => onSave(live)}>{g.id ? "Save" : "Save segment"}</button>
        <button type="button" className="td-primary" disabled={!ok} onClick={() => onSaveShow(live)}><TkIco d="eye" />Save &amp; show{hits.length > 0 && <i className="tsg-n">{hits.length}</i>}</button>
      </div>
    </div>
  );
}
/** Settings › Tickets: the team's mail rules, the mailboxes and the service levels — the desk's own panels, on the settings page. */
export function DeskSettingsPanel({ tab }: { tab: "rules" | "mailboxes" | "sla" }) {
  const [dir, setDir] = useState<Directory | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [inbox, setInbox] = useState<MailMsg[]>([]);
  const [mail, setMail] = useState<OutlookMailStatus | null>(null);
  useEffect(() => {
    loadDirectory().then(setDir).catch(() => {});
    if (tab === "rules") {
      loadTicketTypes().then(setTypes).catch(() => {});
      loadTickets().then((d) => setTickets(d.tickets)).catch(() => {});
      loadInboxMail().then((m) => setInbox(m ?? [])).catch(() => {});
    }
    if (tab !== "sla") getMailStatus().then(setMail).catch(() => {});
  }, [tab]);
  if (!dir) return <div className="hs-skel ts-embed-skel" />;
  return <DeskSettings embed dir={dir} types={types} tickets={tickets} inbox={inbox} start={tab} mail={mail} onClose={() => {}} onConnect={() => connectOutlook({ withMail: true })} />;
}
function DeskSettings({ dir, types, tickets, inbox, start, prefill, mail, onClose, onConnect, segments = [], segNew, onSegments, onShowSegment, embed = false }: {
  dir: Directory; types: string[]; tickets: Ticket[]; inbox: MailMsg[];
  start?: SettingsTab; prefill?: Partial<MailRule> | null; mail: OutlookMailStatus | null;
  onClose: () => void; onConnect: () => void;
  segments?: MailSegment[]; segNew?: boolean; onSegments?: (list: MailSegment[]) => void; onShowSegment?: (id: string) => void;
  /** on the settings page: just one panel (rules / mailboxes / sla), no window around it */
  embed?: boolean;
}) {
  // the desk's window holds what's yours (your rules, your segments); the team's rules, the mailboxes and
  // the service levels live in Settings › Tickets
  const [tab, setTab] = useState<SettingsTab>(embed ? (start ?? "rules") : start === "segments" ? "segments" : "mine");
  const navigate = useNavigate();
  const toSettings = (part: "rules" | "mailboxes" | "sla") => { onClose(); goToSection(navigate, "/settings", `ticketspage/${part}`); };
  // the service levels are their own panel (opened from Tickets); the mail panel is rules + mailboxes
  const slaOnly = start === "sla";
  const [rules, setRules] = useState<MailRule[] | null>(null);
  const [boxes, setBoxes] = useState<Mailbox[] | null>(null);
  const [sla, setSla] = useState<SlaMap | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState<MailRule | null>(prefill ? blankRule(0, prefill) : null);
  const [segEd, setSegEd] = useState<MailSegment | null>(segNew ? blankSegment(segments.length) : null);
  const [err, setErr] = useState<string | null>(null);
  const [newBox, setNewBox] = useState({ address: "", label: "" });
  const reload = useCallback(async () => {
    const [r, b, s] = await Promise.all([loadMailRules(), loadMailboxes(), loadSla()]);
    setMissing(r === null || b === null || !s.ready);
    setRules(r ?? []); setBoxes(b ?? []); setSla(s.sla);
    void ensureDirNames(dir, { contacts: (r ?? []).flatMap((x) => x.conditions.from_contact_ids ?? []), companies: (r ?? []).map((x) => x.conditions.from_company_id),
      emails: inbox.map((m) => m.fromEmail) });
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (embed) return; if (e.key === "Escape" && !editing && !segEd) onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose, editing, segEd]);
  const moveSeg = (i: number, d: number) => {
    const list = [...segments]; const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    onSegments?.(list);
  };
  const run = async (p: Promise<string | null>) => { const e = await p; setErr(e); if (!e) await reload(); return e; };
  const myInbox = (boxes ?? []).find((b) => b.kind === "personal" && b.ownerId === dir.me);
  const team = (rules ?? []).filter(isTeamRule);
  const mine = (rules ?? []).filter((r) => r.ownerId === dir.me && (r.scope ?? "desk") === "desk");
  const clientRuleCount = (rules ?? []).filter((r) => r.scope === "client").length;
  const shown = tab === "mine" ? mine : team;
  const myInboxCard = (
    <div className={`ts-mine ${myInbox ? "is-on" : ""}`}>
      <TkIco d="user" />
      <div><b>My own inbox{mail?.email ? ` · ${mail.email}` : ""}</b>
        <span>{myInbox ? (myInbox.storeAll ? "Every e-mail from someone in the CRM lands in the desk's Inbox." : "Only replies to tickets and mail that matches a rule come in — the rest stays private.") : "Off — your personal mail stays out of the desk, and your rules don't run yet."}</span></div>
      {myInbox && (
        <label className="ts-check"><input type="checkbox" checked={myInbox.storeAll} onChange={() => run(saveMailbox({ ...myInbox, storeAll: !myInbox.storeAll }))} />Bring in everything</label>
      )}
      <button type="button" role="switch" aria-checked={!!myInbox} className={`ts-switch ${myInbox ? "is-on" : ""}`} title={myInbox ? "On" : "Off"}
        onClick={() => myInbox ? run(deleteMailbox(myInbox.id)) : run(saveMailbox({ address: mail?.email || dir.people.find((p) => p.id === dir.me)?.email || "", kind: "personal", ownerId: dir.me, label: "My inbox", canSend: true }))}><i /></button>
    </div>
  );
  const move = async (i: number, d: number) => {
    const list = [...shown]; const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const ids = new Set(list.map((x) => x.id));
    setRules([...(rules ?? []).filter((x) => !ids.has(x.id)), ...list]);
    await Promise.all(list.map((x, k) => saveMailRule({ ...x, sort: k })));
    reload();
  };
  const win = (
    <div className={`td-back tm-back ${embed ? "is-embed" : ""}`} onMouseDown={(e) => { if (!embed && e.target === e.currentTarget && !editing && !segEd) onClose(); }}>
      <div className={`ts is-desk ${embed ? "is-embed" : ""} ${slaOnly ? "is-sla" : ""} ${editing || segEd ? "is-editing" : ""}`} role={embed ? undefined : "dialog"} aria-label={embed ? undefined : "My mail rules and Inbox segments"}>
        {!embed && <header className="ts-h">
          <span className="ts-ico"><TkIco d={slaOnly ? "bolt" : editing ? "filter" : tab === "segments" ? "layers" : tab === "mailboxes" ? "inbox" : "filter"} /></span>
          <div><h3>{slaOnly ? "Service levels" : editing ? (editing.id ? "Edit rule" : "New rule") : segEd ? (segEd.id ? "Edit segment" : "New segment") : tab === "segments" ? "Inbox segments" : tab === "mailboxes" ? "Mailboxes" : tab === "mine" ? "My mail rules" : "Mail rules"}</h3>
            <span className="ts-sub">{slaOnly ? "How fast tickets get a first reply and are resolved" : editing ? "What happens to e-mail that matches" : segEd ? "Which e-mails belong in it" : tab === "segments" ? "Your own views of the Inbox" : tab === "mailboxes" ? "The inboxes the desk reads" : tab === "mine" ? "What happens to new e-mail in your own inbox" : "What happens to new e-mail"}</span></div>
          <span className="td-spacer" />
          <button type="button" className="td-x" onClick={onClose} aria-label="Close"><TkIco d="x" /></button>
        </header>}
        {!embed && !slaOnly && !editing && !segEd && <nav className="ts-tabs">
          {([["mine", "My rules", "user"], ["segments", "Inbox segments", "layers"]] as const).map(([k, l, ic]) => (
            <button key={k} type="button" className={tab === k ? "is-on" : ""} onClick={() => { setTab(k); setEditing(null); setSegEd(null); }}><TkIco d={ic} />{l}
              {k === "mine" && rules ? <i>{mine.length}</i> : k === "segments" ? <i>{segments.length}</i> : null}</button>
          ))}
          <span className="td-spacer" />
          <button type="button" className="ts-tabs-out" onClick={() => toSettings("rules")} title="The team's rules, the mailboxes the desk reads and the service levels"><TkIco d="gear" />Team rules &amp; mailboxes<TkIco d="arrow" className="ts-tabs-out-arr" /></button>
        </nav>}
        <div className="ts-body">
          {missing && <p className="tk-note">{MAIL_SQL}</p>}
          {!slaOnly && mail && (!mail.connected || !mail.mail) && (embed ? tab === "mailboxes" : tab !== "segments") && (
            <div className="ts-connect">
              <TkIco d="mail" />
              <div><b>{mail.connected ? "Your Outlook can't read or send mail yet" : "Connect your Outlook"}</b>
                <span>The desk reads mailboxes and sends replies through your Microsoft 365 account. Connect once with mail permission.</span></div>
              <button type="button" className="td-primary" onClick={onConnect}>Connect with mail</button>
            </div>
          )}
          {err && <p className="tk-err">{err}</p>}

          {!slaOnly && (tab === "rules" || tab === "mine") && (editing ? (
            <RuleEditor rule={editing} dir={dir} types={types} tickets={tickets} boxes={boxes ?? []} inbox={inbox} personal={tab === "mine"}
              onCancel={() => setEditing(null)}
              onSave={async (r) => {
                const e = await run(saveMailRule({ ...r, sort: r.id ? r.sort : shown.length, ...(tab === "mine" ? { ownerId: dir.me, scope: "desk" as const } : {}) }));
                if (!e) setEditing(null);
              }} />
          ) : (
            <>
              {tab === "rules" ? (
                <p className="ts-lead">New mail runs through these rules from top to bottom; the first one that matches decides. Replies to a ticket (its <code>[Ticket T-1042]</code> in the subject, or the same Outlook conversation) always go back to that ticket.
                  {clientRuleCount > 0 && <> Mail from a client's domains is also filed in that client's <b>Emails</b> ({clientRuleCount} client rule{clientRuleCount === 1 ? "" : "s"}, set in Clients).</>}</p>
              ) : (
                <>
                  <p className="ts-lead">Your own rules sort the mail that reaches <b>your inbox</b>, before the team's rules — only you see and change them. Tickets they open are yours unless the rule says otherwise.</p>
                  {myInboxCard}
                </>
              )}
              <div className="ts-list">
                {!rules ? <div className="hs-skel" /> : !shown.length ? (
                  tab === "mine"
                    ? <div className="tk-empty"><span className="tk-empty-ico"><TkIco d="user" /></span><b>No rules of your own yet</b><span>For example: mail from @acme.es → a ticket for me, high priority.</span></div>
                    : <div className="tk-empty"><span className="tk-empty-ico"><TkIco d="filter" /></span><b>No rules yet</b><span>E-mail that matches nothing waits in the Inbox for someone to sort it.</span></div>
                ) : shown.map((r, i) => {
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
                        <button type="button" className="tk-icon-btn" disabled={i === shown.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><TkIco d="down" /></button>
                        <button type="button" className="tk-icon-btn is-del" onClick={() => run(deleteMailRule(r.id))} aria-label="Delete rule"><TkIco d="trash" /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button type="button" className="tk-new ts-add" onClick={() => setEditing(blankRule(shown.length, tab === "mine" ? { ownerId: dir.me } : undefined))}><TkIco d="plus" />{tab === "mine" ? "New rule of my own" : "New rule"}</button>
            </>
          ))}

          {!slaOnly && tab === "segments" && (segEd ? (
            <SegmentEditor seg={segEd} dir={dir} boxes={boxes ?? []} inbox={inbox} onCancel={() => setSegEd(null)}
              onSave={(x) => {
                const saved = x.id ? x : { ...x, id: `sg${Date.now().toString(36)}` };
                onSegments?.(x.id ? segments.map((y) => (y.id === x.id ? saved : y)) : [...segments, saved]);
                setSegEd(null);
              }}
              onSaveShow={(x) => {
                const saved = x.id ? x : { ...x, id: `sg${Date.now().toString(36)}` };
                onSegments?.(x.id ? segments.map((y) => (y.id === x.id ? saved : y)) : [...segments, saved]);
                onShowSegment?.(saved.id);
              }} />
          ) : (
            <>
              <p className="ts-lead">Your own slices of the Inbox — only you see them. Say what an e-mail must have (a sender, a domain, a word in the subject, an attachment…), then switch the segment on at the top of the Inbox to see just those.</p>
              <div className="ts-list">
                {!segments.length ? (
                  <div className="tk-empty"><span className="tk-empty-ico"><TkIco d="layers" /></span><b>No segments yet</b><span>For example: everything from @altia.es, or invoices with an attachment.</span></div>
                ) : segments.map((x, i) => {
                  const n = inbox.filter((m) => segmentMatches(x.conditions, m, dir)).length;
                  return (
                    <div key={x.id} className="ts-rule tsg-row" style={{ ["--i" as string]: i, ["--c" as string]: x.color } as React.CSSProperties}>
                      <span className="tsg-dot" />
                      <div className="ts-rule-main" onClick={() => setSegEd(x)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setSegEd(x); }}>
                        <b>{x.name}</b>
                        <span><em>Mail</em> {segmentSummary(x.conditions, dir)}</span>
                        <small>{n === 0 ? "Nothing in the Inbox right now" : n === 1 ? "1 e-mail in the Inbox now" : `${n} e-mails in the Inbox now`}</small>
                      </div>
                      <div className="ts-rule-side">
                        <button type="button" className="tsg-show" onClick={() => onShowSegment?.(x.id)} title="Show only these e-mails in the Inbox"><TkIco d="eye" />Show</button>
                        <button type="button" className="tk-icon-btn" disabled={i === 0} onClick={() => moveSeg(i, -1)} aria-label="Move up"><TkIco d="up" /></button>
                        <button type="button" className="tk-icon-btn" disabled={i === segments.length - 1} onClick={() => moveSeg(i, 1)} aria-label="Move down"><TkIco d="down" /></button>
                        <button type="button" className="tk-icon-btn is-del" onClick={() => onSegments?.(segments.filter((y) => y.id !== x.id))} aria-label="Delete segment"><TkIco d="trash" /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button type="button" className="tk-new ts-add" onClick={() => setSegEd(blankSegment(segments.length))}><TkIco d="plus" />New segment</button>
            </>
          ))}

          {!slaOnly && tab === "mailboxes" && (
            <>
              <p className="ts-lead">The desk reads the inboxes listed here every few minutes while someone has the home page open (or on a schedule, see 19_ticket_mail.sql). Shared mailboxes need you to have access to them in Outlook.</p>
              <p className="ts-lead ts-gdpr"><TkIco d="shield" />Only e-mail from people already in the CRM comes in: a contact, a colleague, or someone at a company you have (its e-mail or website domain). Anything else is never read or stored (GDPR).</p>
              {myInboxCard}
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

          {slaOnly && sla && (
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
    </div>
  );
  return embed ? win : createPortal(win, document.body);
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
