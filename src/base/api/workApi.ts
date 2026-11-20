/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tasks (to-dos, processes, tickets' tasks) and the clients' signed products:
 * what Home, Clients and Settings › Tasks read and write. The task rows live in
 * tracking_tasks (the table keeps its old name).
 */
import { supabase } from "../../components/api/supabase";

/**
 * Signed-in user id from the local session. Not auth.getUser(): that asks the
 * auth server while holding supabase-js's auth lock, and every query started in
 * the meantime waits behind it.
 */
async function myUser(): Promise<{ id: string; email: string | null } | null> {
  const { data } = await supabase.auth.getSession();
  const u = data?.session?.user;
  return u?.id ? { id: u.id, email: u.email ?? null } : null;
}
const myId = async () => (await myUser())?.id ?? null;

/**
 * Every row of a list, past Supabase's 1,000-row page — and never a silent
 * partial list.
 *
 * Before, a page that failed (a busy database, a statement timeout on a page
 * deep into the list, too many requests at once) simply ended the read: with
 * ~9,000 deals the page showed 1,000 or 3,000 and nobody knew. Now:
 *  - every page is retried (3 attempts, short back-off) before giving up, and at
 *    most 4 pages of one list are asked for at a time;
 *  - reading only stops at a page that comes back SHORT (never on an error,
 *    never on an estimated count);
 *  - `split`: the name of a uuid column (e.g. "id" or "tracking_id"). The table
 *    is then read in 16 slices by that column's first hex digit (+ the rows
 *    where it's empty), 4 slices at a time. Each slice is a small indexed range
 *    instead of OFFSET 8,000 over the whole table — fast and steady at 10k–100k.
 *  - if a page still fails after the retries, what was read is returned and the
 *    list is flagged incomplete (see `rowsIncomplete` / the "rows-incomplete" event)
 *    so the screen can say so and offer a retry.
 */
const RETRIES = 3;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let incompleteReads = 0;
/** How many list reads came back incomplete since the last reset (0 = all good). */
export function rowsIncomplete(): number { return incompleteReads; }
export function resetRowsIncomplete(): void { incompleteReads = 0; }
function flagIncomplete(what: string, err: unknown) {
  incompleteReads += 1;
  console.warn(`[rows] could not read all of ${what}:`, (err as any)?.message ?? err);
  try { window.dispatchEvent(new CustomEvent("rows-incomplete", { detail: { what } })); } catch { /* not in a browser */ }
}
async function getPage(q: any, from: number, to: number): Promise<{ rows: any[] | null; err: unknown }> {
  let err: unknown = null;
  for (let a = 0; a < RETRIES; a++) {
    try {
      const { data, error } = await q.range(from, to);
      if (!error && data) return { rows: data as any[], err: null };
      err = error ?? new Error("no data");
    } catch (e) { err = e; }
    await pause(250 * (a + 1) * (a + 1));
  }
  return { rows: null, err };
}
/** Run `jobs` with at most `n` at a time. */
async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (k < jobs.length) { const i = k++; out[i] = await jobs[i](); }
  }));
  return out;
}
/** All pages of one query, one after the other, until a short page. */
async function readSequential(query: () => any, page: number, what: string): Promise<any[]> {
  const out: any[] = [];
  for (let n = 0; ; n++) {
    const { rows, err } = await getPage(query(), n * page, n * page + page - 1);
    if (!rows) { flagIncomplete(what, err); return out; }
    out.push(...rows);
    if (rows.length < page) return out;
  }
}
const HEX = "0123456789abcdef";
export async function allRows(query: () => any, page = 1000, split?: string): Promise<any[]> {
  const what = (() => { try { return String(query()?.url?.pathname ?? "rows"); } catch { return "rows"; } })();
  if (!split) {
    // Unsplit: the first page alone, then the rest page after page (each retried).
    const { rows: first, err } = await getPage(query(), 0, page - 1);
    if (!first) { flagIncomplete(what, err); return []; }
    if (first.length < page) return first;
    const out = [...first];
    // then windows of 4 pages at a time (bounded, so a big list doesn't flood the database)
    for (let n = 1; ; n += 4) {
      const win = await Promise.all([0, 1, 2, 3].map((k) => getPage(query(), (n + k) * page, (n + k) * page + page - 1)));
      for (const r of win) {
        if (!r.rows) { flagIncomplete(what, r.err); return out; }
        out.push(...r.rows);
        if (r.rows.length < page) return out;
      }
    }
  }
  const lo = (i: number) => `${HEX[i]}0000000-0000-0000-0000-000000000000`;
  const slices: (() => Promise<any[]>)[] = Array.from({ length: 16 }, (_, i) => () =>
    readSequential(() => {
      let q = query().gte(split, lo(i));
      if (i < 15) q = q.lt(split, lo(i + 1));
      return q;
    }, page, `${what} [${HEX[i]}]`));
  // rows where the column is empty can't fall in any slice
  slices.push(() => readSequential(() => query().is(split, null), page, `${what} [empty]`));
  const parts = await pool(slices, 4);
  return parts.flat();
}

export interface TrackTask {
  id: string; phase_id: string | null;
  /** The task's name (may carry @mentions). */
  title: string;
  /** Details under the name (optional; may carry @mentions). */
  description?: string | null;
  done: boolean; due_at?: string | null; created_at?: string;
  /** Who made it — only they can delete it. Null on tasks from before empower_tasks_v2.sql. */
  created_by?: string | null;
  // To-do v2 (empower_tasks_v2.sql). Filled with defaults when the columns aren't there yet.
  priority?: TaskPriority; kind?: TaskKind; status?: TaskStatus; progress?: number;
  /** A process's steps; ticking them moves its %. */
  checklist?: TaskStep[];
  /** The predefined task / process it was made from. */
  template_id?: string | null;
  /** When the "quick → process" rule turned it into a process. */
  promoted_at?: string | null;
}
/** A step of a task; `who` is the person it's given to (a profile id). */
export interface TaskStep { id: string; text: string; done: boolean; who?: string | null; /** Who ticked it off, and when. */ doneBy?: string | null; doneAt?: string | null }
export const newStepId = () => Math.random().toString(36).slice(2, 10);
export interface Assignee { id: string; item_type: string; item_id: string; kind: "employee" | "contact"; employee_id: string | null; contact_id: string | null; }

export async function loadTasks(trackingId: string): Promise<TrackTask[]> {
  const { data } = await supabase.from("tracking_tasks").select("*").eq("tracking_id", trackingId).order("created_at");
  return ((data ?? []) as any[]).map(normTask) as TrackTask[];
}
export interface TaskExtras { description?: string | null; priority?: TaskPriority; kind?: TaskKind; checklist?: TaskStep[]; template_id?: string | null }
export async function addTask(trackingId: string, phaseId: string | null, title: string, dueAt?: string | null, extras?: TaskExtras): Promise<TrackTask | null> {
  const base = { tracking_id: trackingId, phase_id: phaseId, title, due_at: dueAt ?? null };
  const more: Record<string, unknown> = {};
  if (extras?.description?.trim()) more.description = extras.description.trim();
  if (extras?.priority && extras.priority !== "normal") more.priority = extras.priority;
  if (extras?.kind && extras.kind !== "quick") more.kind = extras.kind;
  if (extras?.checklist?.length) more.checklist = extras.checklist;
  if (extras?.template_id) more.template_id = extras.template_id;
  let { data, error } = await supabase.from("tracking_tasks").insert({ ...base, ...more }).select().single();
  // Before empower_tasks_v2.sql the new columns don't exist: still save the task itself.
  if (error && Object.keys(more).length && /column/i.test(error.message ?? "")) {
    ({ data, error } = await supabase.from("tracking_tasks").insert(base).select().single());
  }
  return data ? (normTask(data) as TrackTask) : null;
}
export async function toggleTask(id: string, done: boolean) {
  await supabase.from("tracking_tasks").update({ done }).eq("id", id);
}
export async function updateTask(id: string, patch: { title?: string; description?: string | null; due_at?: string | null }) {
  await supabase.from("tracking_tasks").update(patch).eq("id", id);
}
/** Only whoever created a task may delete it (the database checks too). Returns the error text, if any. */
export async function deleteTask(id: string): Promise<string | null> {
  const { error } = await supabase.from("tracking_tasks").delete().eq("id", id);
  if (!error) return null;
  return /created this task/i.test(error.message ?? "") ? "Only the person who created this task can delete it." : error.message;
}
/** Can this person delete the task? Its creator can; old tasks with no creator recorded, anyone. */
export const canDeleteTask = (t: { created_by?: string | null }, me: string | null | undefined) => !t.created_by || (!!me && t.created_by === me);

/* ============================ To-do (home) ============================
 * Tasks come in two kinds: QUICK ones (tick and forget) and PROCESSES (longer
 * work with a status, a % done and progress notes). Each has a priority.
 * A task can belong to a deal, or be personal (no deal, made from Home).
 * The extra columns come from empower_tasks_v2.sql; before it's run, every
 * task reads as a quick, normal-priority one.
 */
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskKind = "quick" | "process";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export const TASK_PRIORITIES: TaskPriority[] = ["urgent", "high", "normal", "low"];
export const TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];

/** A task on someone's to-do list, with the deal it belongs to (if any). */
export interface MyTask extends TrackTask {
  tracking_id: string | null;
  /** Deal name (or the client's name when the deal has none); null for a personal task. */
  deal: string | null;
  company: string | null;
  /** Someone tagged me on it (vs. one on a deal I own, or one I made for myself). */
  assigned: boolean;
  priority: TaskPriority;
  kind: TaskKind;
  status: TaskStatus;
  progress: number;
  updated_at?: string | null;
  completed_at?: string | null;
  /** The latest progress note, if any. */
  lastNote?: { body: string; at: string; author: string | null } | null;
}
const normTask = (t: any) => ({
  ...t,
  done: !!t.done || t.status === "done",
  priority: (["low", "normal", "high", "urgent"].includes(t.priority) ? t.priority : "normal") as TaskPriority,
  kind: (t.kind === "process" ? "process" : "quick") as TaskKind,
  status: (TASK_STATUSES.includes(t.status) ? t.status : t.done ? "done" : "todo") as TaskStatus,
  progress: Math.max(0, Math.min(100, Number(t.progress) || (t.done ? 100 : 0))),
  checklist: (Array.isArray(t.checklist) ? t.checklist : [])
    .filter((x: any) => x && typeof x.text === "string")
    .map((x: any) => ({ id: String(x.id ?? newStepId()), text: x.text, done: !!x.done, ...(x.who ? { who: String(x.who) } : {}), ...(x.done && x.doneBy ? { doneBy: String(x.doneBy), doneAt: x.doneAt ?? null } : {}) })) as TaskStep[],
});

/* ============================ Task settings & predefined tasks ============================ */
export interface TaskSettings { auto_process_on: boolean; auto_process_days: number }
export const DEFAULT_TASK_SETTINGS: TaskSettings = { auto_process_on: false, auto_process_days: 7 };
let settingsCache: { at: number; value: TaskSettings } | null = null;
export async function loadTaskSettings(fresh = false): Promise<TaskSettings> {
  if (!fresh && settingsCache && Date.now() - settingsCache.at < 60_000) return settingsCache.value;
  const { data, error } = await supabase.from("task_settings").select("auto_process_on, auto_process_days").maybeSingle();
  const value = error || !data ? DEFAULT_TASK_SETTINGS : {
    auto_process_on: !!(data as any).auto_process_on,
    auto_process_days: Math.max(1, Number((data as any).auto_process_days) || 7),
  };
  settingsCache = { at: Date.now(), value };
  return value;
}
export async function saveTaskSettings(v: TaskSettings): Promise<string | null> {
  const { error } = await supabase.from("task_settings").upsert({ ...v, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
  if (!error) settingsCache = { at: Date.now(), value: v };
  return error ? (/relation|does not exist/i.test(error.message) ? "Run empower_tasks_v2.sql in Supabase first." : error.message) : null;
}

/**
 * The "quick → process" rule: a quick task still open after N days becomes a
 * process (it gets a status, a % and progress notes). Applied when tasks are
 * loaded; returns the rows as they are now.
 */
async function autoPromote(rows: any[]): Promise<any[]> {
  const st = await loadTaskSettings().catch(() => DEFAULT_TASK_SETTINGS);
  if (!st.auto_process_on) return rows;
  const cutoff = Date.now() - st.auto_process_days * 86400000;
  const stale = rows.filter((t) => t.kind === "quick" && !t.done && t.status !== "done" && !t.promoted_at
    && t.created_at && new Date(t.created_at).getTime() < cutoff);
  if (!stale.length) return rows;
  const at = new Date().toISOString();
  const { error } = await supabase.from("tracking_tasks").update({ kind: "process", promoted_at: at }).in("id", stale.map((t) => t.id));
  if (error) return rows;
  const ids = new Set(stale.map((t) => t.id));
  return rows.map((t) => (ids.has(t.id) ? { ...t, kind: "process", promoted_at: at } : t));
}

export interface TaskTemplate {
  id: string; kind: TaskKind; title: string; description: string | null; priority: TaskPriority;
  /** Deadline: this many days after it's created (null = none), at due_time. */
  due_in_days: number | null; due_time: string;
  /** Steps of a predefined process. */
  checklist: string[];
  sort: number;
}
export async function loadTaskTemplates(): Promise<TaskTemplate[]> {
  const { data, error } = await supabase.from("task_templates").select("*").order("sort").order("created_at");
  if (error) return [];
  return ((data ?? []) as any[]).map((t) => ({
    id: t.id, kind: t.kind === "process" ? "process" : "quick", title: t.title ?? "", description: t.description ?? null,
    priority: (["low", "normal", "high", "urgent"].includes(t.priority) ? t.priority : "normal") as TaskPriority,
    due_in_days: t.due_in_days == null ? null : Number(t.due_in_days), due_time: t.due_time || "18:00",
    checklist: Array.isArray(t.checklist) ? t.checklist.map((x: any) => String(typeof x === "string" ? x : x?.text ?? "")).filter(Boolean) : [],
    sort: Number(t.sort) || 0,
  }));
}
export async function saveTaskTemplate(t: Omit<TaskTemplate, "id"> & { id?: string }): Promise<{ template: TaskTemplate | null; error: string | null }> {
  const row = {
    kind: t.kind, title: t.title.trim(), description: t.description?.trim() || null, priority: t.priority,
    due_in_days: t.due_in_days, due_time: t.due_time || "18:00", checklist: t.checklist.map((x) => x.trim()).filter(Boolean), sort: t.sort,
  };
  const q = t.id ? supabase.from("task_templates").update(row).eq("id", t.id) : supabase.from("task_templates").insert(row);
  const { data, error } = await q.select().single();
  if (error || !data) return { template: null, error: error ? (/relation|does not exist/i.test(error.message) ? "Run empower_tasks_v2.sql in Supabase first." : /row-level|policy/i.test(error.message) ? "Only the boss and managers can change predefined tasks." : error.message) : "not saved" };
  return { template: { ...row, id: (data as any).id ?? t.id ?? "" } as TaskTemplate, error: null };
}
export async function deleteTaskTemplate(id: string): Promise<string | null> {
  const { error } = await supabase.from("task_templates").delete().eq("id", id);
  return error ? error.message : null;
}
/** What a new task gets from a predefined one: name, description, priority, kind, deadline and steps. */
export function fromTemplate(t: TaskTemplate, now = new Date()) {
  let due_at: string | null = null;
  if (t.due_in_days != null) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + t.due_in_days);
    due_at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${t.due_time || "18:00"}:00`;
  }
  return {
    title: t.title, description: t.description ?? "", priority: t.priority, kind: t.kind, due_at, template_id: t.id,
    checklist: t.checklist.map((text) => ({ id: newStepId(), text, done: false })) as TaskStep[],
  };
}

/**
 * My to-do: tasks I'm tagged on, untagged tasks on deals I own (the owner's
 * to do), and the personal ones I made. Latest progress note included.
 */
export async function loadMyTasks(): Promise<MyTask[]> {
  const uid = await myId();
  if (!uid) return [];
  const [{ data: mine }, { data: owned }, personal] = await Promise.all([
    supabase.from("tracking_assignees").select("item_id").eq("item_type", "task").eq("kind", "employee").eq("employee_id", uid),
    supabase.from("tracking_employees").select("tracking_id").eq("profile_id", uid).eq("is_owner", true),
    // personal tasks I made (no deal) — empty until the SQL adds created_by
    Promise.resolve(supabase.from("tracking_tasks").select("*").is("tracking_id", null).eq("created_by", uid))
      .then((r: any) => (r?.error ? [] : (r?.data ?? []))).catch(() => [] as any[]),
  ]);
  const taggedIds = [...new Set(((mine ?? []) as any[]).map((r) => r.item_id))];
  const ownedDeals = [...new Set(((owned ?? []) as any[]).map((r) => r.tracking_id))];
  const [tagged, onMyDeals] = await Promise.all([
    taggedIds.length ? allRows(() => supabase.from("tracking_tasks").select("*").in("id", taggedIds).order("id")) : Promise.resolve([] as any[]),
    ownedDeals.length ? allRows(() => supabase.from("tracking_tasks").select("*").in("tracking_id", ownedDeals).order("id")) : Promise.resolve([] as any[]),
  ]);
  const taggedSet = new Set(taggedIds);
  const others = onMyDeals.filter((t: any) => !taggedSet.has(t.id));
  const mineOnly = (personal as any[]).filter((t) => !t.tracking_id && !taggedSet.has(t.id));
  // tickets (conversations: e-mail, messages, calls) aren't to-dos — they live in the Tickets list
  let all = [...tagged, ...others, ...mineOnly].filter((t: any) =>
    t.category ? t.category !== "ticket" : !["email", "phone", "portal", "message"].includes(t.source));
  if (!all.length) return [];
  all = await autoPromote(all);
  const byId = new Map(all.map((t: any) => [t.id, t]));
  const fresh = (xs: any[]) => xs.map((t) => byId.get(t.id) ?? t);
  // Of the tasks on my deals, the ones already given to someone else aren't mine.
  const dealIds = [...new Set(all.map((t: any) => t.tracking_id).filter(Boolean))];
  const [{ data: given }, { data: deals }, notes] = await Promise.all([
    others.length
      ? supabase.from("tracking_assignees").select("item_id").eq("item_type", "task").eq("kind", "employee").in("item_id", others.map((t: any) => t.id))
      : Promise.resolve({ data: [] as any[] }),
    dealIds.length ? supabase.from("trackings").select("id, deal_name, company_id").in("id", dealIds) : Promise.resolve({ data: [] as any[] }),
    Promise.resolve(supabase.from("tracking_task_updates").select("task_id, body, created_at, author_id").in("task_id", all.map((t: any) => t.id)).order("created_at", { ascending: false }))
      .then((r: any) => (r?.error ? [] : (r?.data ?? []))).catch(() => [] as any[]),
  ]);
  const givenSet = new Set(((given ?? []) as any[]).map((r) => r.item_id));
  const companyIds = [...new Set(((deals ?? []) as any[]).map((d) => d.company_id).filter(Boolean))];
  const { data: cos } = companyIds.length
    ? await supabase.from("companies").select("id, name").in("id", companyIds)
    : { data: [] as any[] };
  const coName = new Map<string, string>(((cos ?? []) as any[]).map((c) => [c.id, c.name]));
  const dealById = new Map<string, any>(((deals ?? []) as any[]).map((d) => [d.id, d]));
  const lastNote = new Map<string, any>();
  (notes as any[]).forEach((n) => { if (n.body && !lastNote.has(n.task_id)) lastNote.set(n.task_id, n); });
  const shape = (t: any, assigned: boolean): MyTask => {
    const d = t.tracking_id ? dealById.get(t.tracking_id) : null;
    const company = d?.company_id ? coName.get(d.company_id) ?? null : null;
    const n = lastNote.get(t.id);
    return {
      ...normTask(t), assigned, company,
      deal: t.tracking_id ? ((d?.deal_name ?? "").trim() || company || "Deal") : null,
      lastNote: n ? { body: n.body, at: n.created_at, author: n.author_id ?? null } : null,
    };
  };
  return [
    ...fresh(tagged).map((t: any) => shape(t, true)),
    ...fresh(others).filter((t: any) => !givenSet.has(t.id)).map((t: any) => shape(t, false)),
    ...fresh(mineOnly).map((t: any) => shape(t, false)),
  ];
}

/** A task I made and gave to someone else (tagged them), to follow how it's going. */
export interface DelegatedTask extends MyTask {
  /** The people it was given to (not me). */
  assignees: { id: string; name: string }[];
}
/**
 * Tasks I created and tagged someone else on — on a deal or personal — with
 * who has them, their status / % and the latest progress note.
 */
export async function loadDelegatedTasks(): Promise<DelegatedTask[]> {
  const uid = await myId();
  if (!uid) return [];
  const mine = await allRows(() => supabase.from("tracking_tasks").select("*").eq("created_by", uid).order("id")).then(autoPromote).catch(() => [] as any[]);
  if (!mine.length) return [];
  const { data: tags } = await supabase.from("tracking_assignees").select("item_id, employee_id")
    .eq("item_type", "task").eq("kind", "employee").in("item_id", mine.map((t: any) => t.id));
  const byTask = new Map<string, string[]>();
  ((tags ?? []) as any[]).forEach((a) => {
    if (!a.employee_id || a.employee_id === uid) return;
    const l = byTask.get(a.item_id) ?? []; if (!l.includes(a.employee_id)) l.push(a.employee_id); byTask.set(a.item_id, l);
  });
  const given = mine.filter((t: any) => byTask.has(t.id));
  if (!given.length) return [];
  const people = [...new Set([...byTask.values()].flat())];
  const dealIds = [...new Set(given.map((t: any) => t.tracking_id).filter(Boolean))] as string[];
  const [{ data: profs }, { data: deals }, notes] = await Promise.all([
    supabase.from("profiles").select("id, first_name, last_name, email").in("id", people),
    dealIds.length ? supabase.from("trackings").select("id, deal_name, company_id").in("id", dealIds) : Promise.resolve({ data: [] as any[] }),
    Promise.resolve(supabase.from("tracking_task_updates").select("task_id, body, created_at, author_id").in("task_id", given.map((t: any) => t.id)).order("created_at", { ascending: false }))
      .then((r: any) => (r?.error ? [] : (r?.data ?? []))).catch(() => [] as any[]),
  ]);
  const companyIds = [...new Set(((deals ?? []) as any[]).map((d) => d.company_id).filter(Boolean))];
  const { data: cos } = companyIds.length ? await supabase.from("companies").select("id, name").in("id", companyIds) : { data: [] as any[] };
  const coName = new Map<string, string>(((cos ?? []) as any[]).map((c) => [c.id, c.name]));
  const dealById = new Map<string, any>(((deals ?? []) as any[]).map((d) => [d.id, d]));
  const nameOf = new Map<string, string>(((profs ?? []) as any[]).map((p) => [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || (p.email ?? "").split("@")[0] || "Someone"]));
  const lastNote = new Map<string, any>();
  (notes as any[]).forEach((n) => { if (n.body && !lastNote.has(n.task_id)) lastNote.set(n.task_id, n); });
  return given.map((t: any) => {
    const d = t.tracking_id ? dealById.get(t.tracking_id) : null;
    const company = d?.company_id ? coName.get(d.company_id) ?? null : null;
    const n = lastNote.get(t.id);
    return {
      ...normTask(t), assigned: false, company,
      deal: t.tracking_id ? ((d?.deal_name ?? "").trim() || company || "Deal") : null,
      lastNote: n ? { body: n.body, at: n.created_at, author: n.author_id ?? null } : null,
      assignees: (byTask.get(t.id) ?? []).map((id) => ({ id, name: nameOf.get(id) ?? "Someone" })),
    } as DelegatedTask;
  });
}

/** A personal task from Home (no deal). Returns the error text, or the new task. */
export async function addPersonalTask(input: { title: string; description?: string | null; kind: TaskKind; priority: TaskPriority; due_at?: string | null; checklist?: TaskStep[]; template_id?: string | null }): Promise<{ task: MyTask | null; error: string | null }> {
  const { data, error } = await supabase.from("tracking_tasks").insert({
    tracking_id: null, phase_id: null, title: input.title, due_at: input.due_at ?? null,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.checklist?.length ? { checklist: input.checklist } : {}),
    ...(input.template_id ? { template_id: input.template_id } : {}),
    kind: input.kind, priority: input.priority, status: "todo", progress: 0,
  }).select().single();
  if (error || !data) {
    const msg = error?.message ?? "not saved";
    return { task: null, error: /column|tracking_id|null value/i.test(msg) ? "Run empower_tasks_v2.sql in Supabase first (it adds priority, processes and personal tasks)." : msg };
  }
  return { task: { ...normTask(data), assigned: false, deal: null, company: null, lastNote: null } as MyTask, error: null };
}

/** Change a task's priority, kind, status, % or due date. */
export async function updateTaskMeta(id: string, patch: Partial<Pick<MyTask, "priority" | "kind" | "status" | "progress" | "due_at" | "title" | "description" | "checklist">>): Promise<string | null> {
  const { error } = await supabase.from("tracking_tasks").update(patch).eq("id", id);
  if (!error) return null;
  if (/created this task/i.test(error.message)) return "Only the person who created this task can change its deadline.";
  return /column/i.test(error.message) ? "Run empower_tasks_v2.sql in Supabase first." : error.message;
}

export interface TaskUpdate { id: string; task_id: string; author_id: string | null; body: string | null; status: TaskStatus | null; progress: number | null; created_at: string }
/** The progress notes of a task, newest first. */
export async function loadTaskUpdates(taskId: string): Promise<TaskUpdate[]> {
  const { data, error } = await supabase.from("tracking_task_updates").select("*").eq("task_id", taskId).order("created_at", { ascending: false });
  return error ? [] : ((data ?? []) as TaskUpdate[]);
}
/** A progress note — with the status and % at that moment (and they're applied to the task). */
export async function addTaskUpdate(taskId: string, u: { body: string; status: TaskStatus; progress: number }): Promise<{ update: TaskUpdate | null; error: string | null }> {
  const err = await updateTaskMeta(taskId, { status: u.status, progress: u.status === "done" ? 100 : u.progress });
  if (err) return { update: null, error: err };
  const body = u.body.trim();
  if (!body) return { update: null, error: null };
  const me = await myId();
  const { data, error } = await supabase.from("tracking_task_updates")
    .insert({ task_id: taskId, author_id: me, body, status: u.status, progress: u.status === "done" ? 100 : u.progress }).select().single();
  if (error || !data) return { update: null, error: error ? error.message : "not saved" };
  // The row as saved; author / time filled in if the reply left them out.
  const row = data as TaskUpdate;
  return { update: { ...row, author_id: row.author_id ?? me, created_at: row.created_at ?? new Date().toISOString() }, error: null };
}

// ---- Meetings ----
export async function addAssignee(itemType: string, itemId: string, kind: "employee" | "contact", refId: string): Promise<Assignee | null> {
  const row: any = { item_type: itemType, item_id: itemId, kind };
  if (kind === "employee") row.employee_id = refId; else row.contact_id = refId;
  const { data } = await supabase.from("tracking_assignees").insert(row).select().single();
  return (data as any) ?? null;
}
export async function removeAssignee(id: string) {
  await supabase.from("tracking_assignees").delete().eq("id", id);
}

// Remove phase-entry stamps for phases beyond the given one (when going back).
export async function saveClientProducts(clientId: string, trackingId: string | null, products: {
  productId: string; price: number; quantity: number; recurring: boolean; period: string | null;
  termYears: number | null; discountMode: string | null; discountValue: number | null; signingDate: string;
  startDate?: string; oneTimeFee?: number; nonTerminableYears?: number | null; autoRenew?: boolean;
  renewYears?: number | null; annualIncreasePct?: number | null; paymentTermsDays?: number | null;
  contractRef?: string; externalRef?: string;
  billingContactName?: string | null; billingContactEmail?: string | null;
  /** How a multi-year contract is paid: in `count` terms, each with its own increase over the one before. */
  schedule?: PaymentSchedule | null;
  /** How the final price was built (rows, discounts, total) — shown on the client page (handoff_v3.sql). */
  breakdown?: any;
  /** An upsell signed into an existing contract: the deal that contract was signed on (122_upsell_in_contract.sql). */
  contractTrackingId?: string | null;
}[]): Promise<string | null> {
  if (!products.length) return null;
  const rows = products.map((p) => ({
    client_id: clientId, product_id: p.productId, tracking_id: trackingId,
    signing_date: p.signingDate || null,
    start_date: p.startDate || p.signingDate || null,
    price: p.price, quantity: p.quantity, recurring: p.recurring,
    period: p.period, term_years: p.termYears,
    discount_mode: p.discountMode, discount_value: p.discountValue,
    one_time_fee: p.oneTimeFee ?? 0,
    non_terminable_years: p.nonTerminableYears ?? null,
    auto_renew: p.autoRenew ?? false,
    renew_years: p.renewYears ?? null,
    annual_increase_pct: p.annualIncreasePct ?? null,
    payment_terms_days: p.paymentTermsDays ?? null,
    contract_ref: p.contractRef || null,
    external_ref: p.externalRef || null,
    billing_contact_name: p.billingContactName ?? null,
    billing_contact_email: p.billingContactEmail ?? null,
    status: "active",
    ...(p.schedule ? { schedule: p.schedule } : {}),
    ...(p.breakdown ? { breakdown: p.breakdown } : {}),
    ...(p.contractTrackingId ? { contract_tracking_id: p.contractTrackingId } : {}),
  }));
  let { error } = await supabase.from("client_products").insert(rows);
  if (error && /contract_tracking_id/i.test(error.message)) return "Run 122_upsell_in_contract.sql in Supabase first.";
  // handoff_v3.sql / client_terms.sql not run yet: save without the breakdown / payment terms
  if (error && /breakdown/i.test(error.message)) ({ error } = await supabase.from("client_products").insert(rows.map((r: any) => { const c = { ...r }; delete c.breakdown; return c; })));
  if (error && /schedule/i.test(error.message)) ({ error } = await supabase.from("client_products").insert(rows.map((r: any) => { const c = { ...r }; delete c.schedule; delete c.breakdown; return c; })));
  return error?.message ?? null;
}

/* ============================ When a signed product ends ============================ */
const lineStart = (l: any) => { const s = String(l.start_date || l.signing_date || ""); const t = s ? new Date(s.slice(0, 10) + "T00:00:00").getTime() : NaN; return Number.isFinite(t) ? t : null; };
/** When a signed recurring product ends (start + its term); null when it has no term. */
export function lineEnd(l: any): number | null {
  const s = lineStart(l), y = Number(l.term_years) || 0;
  if (s == null || !y) return null;
  const d = new Date(s); d.setMonth(d.getMonth() + Math.round(y * 12));
  return d.getTime();
}
export interface PaymentSchedule { count: number; increases: number[] }
