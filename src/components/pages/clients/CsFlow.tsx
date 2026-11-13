// Customer success › a sequence's steps as a tree (114_cs_flows.sql, run by the cs-engine function):
// e-mails, "wait and check" branches (replied · opened, no reply · didn't open), tasks for the client's owners, end.
// A branch's path, once done, carries on with the steps after the branch.
// Drawn as a timeline: each step on a rail, the wait before it on the rail too, "+" between steps to insert one.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Select from "../../framework/Select";
import type { CsMailLog, CsTemplate, CsFolder, CsSequence, CsRun } from "./useClientsData";
import type { Employee } from "../companies/companiesApi";
import "./CsFlow.css";
import { NumInput } from "../../framework/NumInput";

export type CsLane = "replied" | "opened" | "none";
export interface CsFlowNode {
  id: string; type: "email" | "branch" | "task" | "stop";
  template_id?: string; wait_days?: number;
  days?: number; paths?: Partial<Record<CsLane, CsFlowNode[]>>;
  title?: string; notes?: string; assign?: string; due_days?: number;
}
export const LANES: { k: CsLane; label: string; hint: string }[] = [
  { k: "replied", label: "Replied", hint: "Anyone at the client wrote back — one reply is enough, as soon as it's seen" },
  { k: "opened", label: "Opened, no reply", hint: "Someone at the client opened it or clicked a link, but nobody wrote back" },
  { k: "none", label: "Didn't open", hint: "Nobody at the client opened it" },
];
const nid = () => Math.random().toString(36).slice(2, 9);

/* ---------- fields: shown as cards, stored as {{key}} ---------- */
export const FIELD_CHIP: Record<string, string> = {
  first_name: "First name", contact_name: "Full name", client: "Client", legal_name: "Legal name",
  owner_name: "Sender", owner_first_name: "Sender's first name", owner_email: "Sender's e-mail",
  renewal_date: "Renewal date", days_to_renewal: "Days to renewal", today: "Today", year: "Year",
};
export const FIELD_GROUPS: { label: string; keys: string[] }[] = [
  { label: "The person it goes to", keys: ["first_name", "contact_name"] },
  { label: "Their company", keys: ["client", "legal_name", "renewal_date", "days_to_renewal"] },
  { label: "You, the sender", keys: ["owner_name", "owner_first_name", "owner_email"] },
  { label: "Dates", keys: ["today", "year"] },
];
/** what a task can name: the client and its main contact (the task's person is the one it's for) */
const TASK_GROUPS: { label: string; keys: string[] }[] = [
  { label: "The client", keys: ["client", "legal_name", "renewal_date", "days_to_renewal"] },
  { label: "Its main contact", keys: ["contact_name", "first_name"] },
  { label: "Dates", keys: ["today"] },
];
const TASK_CHIP: Record<string, string> = { ...FIELD_CHIP, first_name: "Contact's first name", contact_name: "Contact" };
const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const chip = (k: string, names: Record<string, string>) => `<span class="csf-fld" contenteditable="false" data-f="${k}">${esc(names[k] ?? k)}</span>`;
/** "Call {{client}}" → text with field cards (HTML) */
export const chipsOf = (text: string, names: Record<string, string> = FIELD_CHIP, multi = false) =>
  (multi ? esc(text ?? "").replace(/\n/g, "<br>") : esc(text ?? "")).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (names[String(k).toLowerCase()] ? chip(String(k).toLowerCase(), names) : m));
/** the editor's HTML → "Call {{client}}" */
function textOfEl(el: HTMLElement, multi: boolean): string {
  let out = "";
  const walk = (n: Node) => {
    n.childNodes.forEach((c) => {
      if (c.nodeType === 3) out += (c.textContent ?? "").replace(/​/g, "");
      else if (c instanceof HTMLElement) {
        if (c.dataset.f) { out += `{{${c.dataset.f}}}`; return; }
        if (c.tagName === "BR") { out += multi ? "\n" : " "; return; }
        const block = c.tagName === "DIV" || c.tagName === "P";
        if (block && out && !out.endsWith("\n")) out += multi ? "\n" : " ";
        walk(c);
      }
    });
  };
  walk(el);
  out = out.replace(/ /g, " ");
  return multi ? out.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") : out.replace(/\s+/g, " ").replace(/^\s+/, "");
}

/** A text box where fields are cards: type, or add a field from the menu; a card's × takes it out. */
export function ChipField({ value, onChange, placeholder, multi = false, groups = FIELD_GROUPS, names = FIELD_CHIP, label }: {
  value: string; onChange: (v: string) => void; placeholder?: string; multi?: boolean;
  groups?: { label: string; keys: string[] }[]; names?: Record<string, string>; label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const shown = useRef<string | null>(null);
  const range = useRef<Range | null>(null);
  const [menu, setMenu] = useState(false);
  const [empty, setEmpty] = useState(!value);
  const wrap = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!ref.current || shown.current === value) return;
    ref.current.innerHTML = chipsOf(value ?? "", names, multi);
    shown.current = value; setEmpty(!value);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!menu) return;
    const off = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(false); } };
    document.addEventListener("mousedown", off); window.addEventListener("keydown", k, true);
    return () => { document.removeEventListener("mousedown", off); window.removeEventListener("keydown", k, true); };
  }, [menu]);
  const sync = () => {
    const el = ref.current; if (!el) return;
    const v = textOfEl(el, multi);
    if (!v && !el.querySelector("[data-f]") && el.innerHTML) el.innerHTML = "";
    shown.current = v; setEmpty(!v); onChange(v);
  };
  const keep = () => { const s = window.getSelection(); if (s && s.rangeCount && ref.current?.contains(s.anchorNode)) range.current = s.getRangeAt(0).cloneRange(); };
  const insert = (k: string) => {
    const el = ref.current; if (!el) return;
    el.focus();
    const s = window.getSelection();
    let r = range.current && el.contains(range.current.startContainer) ? range.current : null;
    if (!r) { r = document.createRange(); r.selectNodeContents(el); r.collapse(false); }
    s?.removeAllRanges(); s?.addRange(r);
    const tmp = document.createElement("span"); tmp.innerHTML = chip(k, names);
    const node = tmp.firstChild!;
    const sp = document.createTextNode(" ");
    const head = document.createRange(); head.setStart(el, 0); head.setEnd(r.startContainer, r.startOffset);
    const prev = head.toString().slice(-1);
    r.deleteContents(); r.insertNode(sp); r.insertNode(node);
    if (prev && !/\s/.test(prev)) r.insertNode(document.createTextNode(" "));
    const after = document.createRange(); after.setStartAfter(sp); after.collapse(true);
    s?.removeAllRanges(); s?.addRange(after); range.current = after.cloneRange();
    setMenu(false); sync();
  };
  return (
    <div className={`csf-cf ${multi ? "is-multi" : ""} ${menu ? "is-menu" : ""}`} ref={wrap}>
      <div ref={ref} className={`csf-cf-in ${empty ? "is-empty" : ""}`} contentEditable suppressContentEditableWarning role="textbox" aria-multiline={multi} aria-label={label ?? placeholder} data-ph={placeholder}
        onInput={sync} onKeyUp={keep} onMouseUp={keep} onBlur={keep}
        onKeyDown={(e) => { if (e.key === "Enter" && !multi) e.preventDefault(); }}
        onPaste={(e) => { e.preventDefault(); const t = e.clipboardData.getData("text/plain"); document.execCommand("insertText", false, multi ? t : t.replace(/\s*\n\s*/g, " ")); }}
        onClick={(e) => { const f = (e.target as HTMLElement).closest?.("[data-f]"); if (f && ref.current?.contains(f)) { f.remove(); sync(); } }} />
      <button type="button" className="csf-cf-add" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu((m) => !m)} aria-expanded={menu} title="Add a field — filled in for each client"><Ico n="brace" s={13} /><span>Field</span></button>
      {menu && (
        <div className="csf-cf-menu" role="menu">
          {groups.map((g) => (
            <div key={g.label} className="csf-cf-g"><span>{g.label}</span>
              <div>{g.keys.map((k) => <button key={k} type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(k)}><i className="csf-fld">{names[k] ?? k}</i></button>)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A sequence's steps: its tree, or its old straight list of e-mails read as one. */
export function flowOf(q: Partial<CsSequence> & { flow?: any }): CsFlowNode[] {
  const f = q.flow;
  const nodes = Array.isArray(f) ? f : Array.isArray(f?.nodes) ? f.nodes : null;
  if (nodes && nodes.length) return nodes as CsFlowNode[];
  return (q.steps ?? []).map((s) => ({ id: s.id || nid(), type: "email" as const, template_id: s.template_id, wait_days: Number(s.wait_days) || 0 }));
}
/** Every e-mail in the tree, in order (for the lists and summaries). */
export function flowEmails(nodes: CsFlowNode[]): CsFlowNode[] {
  const out: CsFlowNode[] = [];
  const walk = (xs: CsFlowNode[]) => xs.forEach((n) => { if (n.type === "email") out.push(n); if (n.type === "branch") LANES.forEach((l) => walk(n.paths?.[l.k] ?? [])); });
  walk(nodes);
  return out;
}
/** How many of each kind of step. */
export function flowCount(nodes: CsFlowNode[]): { email: number; branch: number; task: number } {
  const c = { email: 0, branch: 0, task: 0 };
  const walk = (xs: CsFlowNode[]) => xs.forEach((n) => { if (n.type !== "stop") c[n.type] += 1; if (n.type === "branch") LANES.forEach((l) => walk(n.paths?.[l.k] ?? [])); });
  walk(nodes);
  return c;
}
/** When each step happens, in days from the start (day 0): a range when it depends on the path taken
 *  (a reply can come any time during a check). at: each step · lane: where each path starts · end: the last step. */
export type CsDayRange = { lo: number; hi: number };
export function flowDays(nodes: CsFlowNode[]): { at: Record<string, CsDayRange>; lane: Record<string, CsDayRange>; end: CsDayRange | null } {
  const at: Record<string, CsDayRange> = {};
  const lane: Record<string, CsDayRange> = {};
  const walk = (list: CsFlowNode[], path: string, t: CsDayRange): CsDayRange | null => {
    let cur = t;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      const p = path ? `${path}/${i}` : String(i);
      if (n.type === "email" || n.type === "task") { const w = Math.max(0, Number(n.wait_days) || 0); cur = { lo: cur.lo + w, hi: cur.hi + w }; at[p] = cur; }
      else if (n.type === "stop") { at[p] = cur; return null; }
      else if (n.type === "branch") {
        const d = Math.max(0, Number(n.days) || 0);
        at[p] = cur;
        const ends: CsDayRange[] = [];
        for (const l of LANES) {
          const st = l.k === "replied" ? { lo: cur.lo, hi: cur.hi + d } : { lo: cur.lo + d, hi: cur.hi + d };
          lane[`${p}/${l.k}`] = st;
          const e = walk(n.paths?.[l.k] ?? [], `${p}/${l.k}`, st);
          if (e) ends.push(e);
        }
        if (!ends.length) return null;
        cur = { lo: Math.min(...ends.map((e) => e.lo)), hi: Math.max(...ends.map((e) => e.hi)) };
      }
    }
    return cur;
  };
  const end = walk(nodes, "", { lo: 0, hi: 0 });
  const all = Object.values(at);
  return { at, lane, end: end ?? (all.length ? { lo: Math.min(...all.map((x) => x.lo)), hi: Math.max(...all.map((x) => x.hi)) } : null) };
}
/** The example's day 0: 1 January (next year), so every date reads easily. */
export const exampleStart = () => new Date(new Date().getFullYear() + 1, 0, 1);
/** day n → "Thu 4 Jan", counted on the calendar from day 0 (a sent campaign: its real day; else the example) */
export const dayFmt = (startAt: Date | null) => {
  const b = startAt ?? exampleStart();
  return (n: number, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) => new Date(b.getFullYear(), b.getMonth(), b.getDate() + n).toLocaleDateString("en-GB", opts).replace(",", "");
};
export const dayText = (r: CsDayRange | null | undefined) => (!r ? "" : r.lo === r.hi ? `Day ${r.lo}` : `Day ${r.lo}–${r.hi}`);

export const flowHasBranches = (nodes: CsFlowNode[]): boolean => nodes.some((n) => n.type === "branch" || n.type === "task");
export const newEmailNode = (template_id = "", wait_days = 3): CsFlowNode => ({ id: nid(), type: "email", template_id, wait_days });
const newTask = (title = "Follow up with {{client}}"): CsFlowNode => ({ id: nid(), type: "task", title, assign: "owners", due_days: 2, wait_days: 0 });
const newBranch = (tpl = ""): CsFlowNode => ({
  id: nid(), type: "branch", days: 3,
  paths: {
    replied: [newTask("{{client}} replied — get back to them")],
    opened: [newEmailNode(tpl, 0)],
    none: [newEmailNode(tpl, 0)],
  },
});

export type CsNodeStats = { sent: number; opened: number; clicked: number; replied: number };
/** What each e-mail step did: sent, opened, clicked, replied (by its place in the tree). */
export function flowStats(log: CsMailLog[], seqId: string | undefined): Record<string, CsNodeStats> {
  const out: Record<string, CsNodeStats> = {};
  if (!seqId) return out;
  for (const l of log as any[]) {
    if (l.sequence_id !== seqId || l.status !== "sent") continue;
    const k = l.node ?? String(l.step ?? 0);
    const s = (out[k] ??= { sent: 0, opened: 0, clicked: 0, replied: 0 });
    s.sent += 1; if (l.opened_at) s.opened += 1; if (l.clicked_at) s.clicked += 1; if (l.replied_at) s.replied += 1;
  }
  return out;
}
/** How many clients are at each step right now. */
export function flowHere(runs: CsRun[], seqId: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!seqId) return out;
  runs.forEach((r: any) => { if (r.sequence_id === seqId && r.status === "active") { const k = r.node ?? String(r.step ?? 0); out[k] = (out[k] ?? 0) + 1; } });
  return out;
}

const I: Record<string, string> = {
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  split: "M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6M6 21V3M18 3v3",
  task: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  stop: "M7 7h10v10H7z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  up: "M12 19V5M6 11l6-6 6 6", dn: "M12 5v14M6 13l6 6 6-6", trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  plus: "M12 5v14M5 12h14", reply: "M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v2", eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeoff: "M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a10.6 10.6 0 0 0 5.4-1.6",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z", users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5", x: "M18 6 6 18M6 6l12 12", user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  cal: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  brace: "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1",
  click: "M9 9l5 12 1.8-5.2L21 14zM7.2 2.2 8 5.1M5.1 8l-2.9-.8M14 4.1 12 6M6 12l-1.9 2",
};
const Ico = ({ n, s = 14 }: { n: keyof typeof I; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={I[n]} /></svg>
);
const LANE_ICO: Record<CsLane, keyof typeof I> = { replied: "reply", opened: "eye", none: "eyeoff" };
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

type Path = (number | CsLane)[];
const ptrOf = (p: Path) => p.join("/");
function listAt(nodes: CsFlowNode[], path: Path): CsFlowNode[] {
  let xs = nodes;
  for (let i = 0; i + 1 < path.length; i += 2) xs = xs[path[i] as number]?.paths?.[path[i + 1] as CsLane] ?? [];
  return xs;
}
/** a copy of the tree with the list at `listPath` (a path to a list: [] or [2, "opened"]) changed */
function withList(nodes: CsFlowNode[], listPath: Path, fn: (xs: CsFlowNode[]) => CsFlowNode[]): CsFlowNode[] {
  if (!listPath.length) return fn(nodes);
  const [i, lane, ...rest] = listPath as [number, CsLane, ...Path];
  return nodes.map((n, k) => (k !== i ? n : { ...n, paths: { ...(n.paths ?? {}), [lane]: withList(n.paths?.[lane] ?? [], rest, fn) } }));
}

const KINDS: { k: CsFlowNode["type"]; label: string; hint: string; ico: keyof typeof I }[] = [
  { k: "email", label: "E-mail", hint: "Send one of your blueprints", ico: "mail" },
  { k: "branch", label: "Wait & check", hint: "Go one way or another by what they did", ico: "split" },
  { k: "task", label: "Task", hint: "Someone in the team does something", ico: "task" },
  { k: "stop", label: "End", hint: "The client leaves here", ico: "stop" },
];

export default function CsFlowEditor({ nodes, onChange, templates, folders, people, campaign, sent, startText, stats, here, onNewTemplate, startAt = null }: {
  nodes: CsFlowNode[]; onChange: (n: CsFlowNode[]) => void;
  templates: CsTemplate[]; folders: CsFolder[]; people: Employee[];
  campaign: boolean; sent: boolean; startText: string;
  /** a campaign's day 0 (sent, or today if it went now): the days also show as dates */
  startAt?: Date | null;
  stats: Record<string, CsNodeStats>; here: Record<string, number>; onNewTemplate: () => void;
}) {
  const folderName = (t: CsTemplate) => (t.folder_id ? folders.find((f) => f.id === t.folder_id)?.name ?? "" : "");
  const tplOpts = [...[...templates].sort((x, y) => (folderName(x) || "￿").localeCompare(folderName(y) || "￿") || x.name.localeCompare(y.name))
    .map((t) => ({ value: t.id, label: t.name, hint: [folderName(t), t.attachments.length ? `${t.attachments.length} file${t.attachments.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || undefined })), { value: "__new", label: "+ New blueprint…" }];
  const whoOpts = [
    { value: "owners", label: "The client's owners", hint: "everyone starred or listed" },
    { value: "primary", label: "The client's main owner" },
    { value: "sender", label: campaign ? "Whoever sends it" : "The sequence's creator" },
    ...people.filter((p) => !p.former).map((p) => ({ value: p.id, label: p.name })),
  ];
  const [lanes, setLanes] = useState<Record<string, CsLane>>({});
  /** where the "add a step" menu is open: "<list ptr>@<index>" */
  const [adding, setAdding] = useState<string | null>(null);
  const firstTpl = flowEmails(nodes)[0]?.template_id ?? templates[0]?.id ?? "";
  const days = flowDays(nodes);
  const fmtD = dayFmt(startAt);
  const whenTip = (r: CsDayRange) => `${r.lo === r.hi ? (r.lo === 0 ? "The first day" : `${r.lo} day${r.lo === 1 ? "" : "s"} after the start`) : `Between ${r.lo} and ${r.hi} days after the start, depending on when the client replies`}${startAt ? "" : " — in the example that starts on 1 January"}`;
  /** when a step happens: the date (an example starting 1 January, or the real one once sent) and its day number */
  const when = (r: CsDayRange | undefined, prefix = "") => {
    if (!r) return null;
    return (
      <span className={`csf-when ${r.lo !== r.hi ? "is-range" : ""}`} title={whenTip(r)}>
        <Ico n="cal" s={12} /><b>{prefix}{r.lo === r.hi ? fmtD(r.lo) : `${fmtD(r.lo)} – ${fmtD(r.hi)}`}</b><i>{dayText(r)}</i>
      </span>
    );
  };
  const mailNo: Record<string, number> = {};
  flowEmails(nodes).forEach((n, i) => { mailNo[n.id] = i + 1; });

  const setNode = (listPath: Path, i: number, patch: Partial<CsFlowNode>) => onChange(withList(nodes, listPath, (xs) => xs.map((n, k) => (k === i ? { ...n, ...patch } : n))));
  const move = (listPath: Path, i: number, d: -1 | 1) => onChange(withList(nodes, listPath, (xs) => { const ys = [...xs]; const j = i + d; if (j < 0 || j >= ys.length) return xs; [ys[i], ys[j]] = [ys[j], ys[i]]; return ys; }));
  const drop = (listPath: Path, i: number) => onChange(withList(nodes, listPath, (xs) => xs.filter((_, k) => k !== i)));
  const addAt = (listPath: Path, at: number, kind: CsFlowNode["type"]) => {
    const n = kind === "email" ? newEmailNode(firstTpl, at === 0 ? 0 : 3)
      : kind === "branch" ? newBranch(firstTpl) : kind === "task" ? newTask() : { id: nid(), type: "stop" as const };
    // an end goes last: what came after it would never happen
    onChange(withList(nodes, listPath, (xs) => (kind === "stop" ? [...xs.slice(0, at), n] : [...xs.slice(0, at), n, ...xs.slice(at)])));
    setAdding(null);
  };
  useEffect(() => {
    if (!adding) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setAdding(null); } };
    window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true);
  }, [adding]);

  const menu = (listPath: Path, at: number, len: number) => {
    const key = `${ptrOf(listPath)}@${at}`;
    if (adding !== key) return null;
    const list = listAt(nodes, [...listPath, 0]);
    const noMailYet = !listPath.length && !list.slice(0, at).some((x) => x.type === "email");
    return (
      <div className="csf-menu" role="menu" aria-label="Add a step">
        {KINDS.map((k) => {
          const off = (k.k === "branch" && noMailYet) || (k.k === "stop" && at < len);
          return (
            <button key={k.k} type="button" role="menuitem" className={`is-${k.k}`} disabled={off} onClick={() => addAt(listPath, at, k.k)}
              title={off ? (k.k === "stop" ? "An end goes last" : "Put an e-mail before a check") : undefined}>
              <span className={`csf-tile is-${k.k} is-sm`}><Ico n={k.ico} s={14} /></span>
              <span><b>{k.label}</b><i>{k.hint}</i></span>
            </button>
          );
        })}
      </div>
    );
  };

  const tools = (listPath: Path, i: number, len: number, lockFirst = false) => (
    <div className="csf-tools">
      <button type="button" disabled={i === 0 || (lockFirst && i === 1)} onClick={() => move(listPath, i, -1)} aria-label="Move earlier" title="Earlier"><Ico n="up" s={13} /></button>
      <button type="button" disabled={i === len - 1 || (lockFirst && i === 0)} onClick={() => move(listPath, i, 1)} aria-label="Move later" title="Later"><Ico n="dn" s={13} /></button>
      <button type="button" className="is-del" disabled={lockFirst && i === 0} onClick={() => drop(listPath, i)} aria-label="Remove this step" title="Remove"><Ico n="trash" s={13} /></button>
    </div>
  );

  /** the line before a step: its wait (e-mails and tasks), and a "+" to put a step in between */
  const gap = (n: CsFlowNode, listPath: Path, i: number, len: number, top: boolean) => {
    const key = `${ptrOf(listPath)}@${i}`;
    void n; void top;
    const canInsert = !(campaign && sent && top && i === 0) && !(top && i === 0 && campaign);
    return (
      <div className={`csf-gap ${adding === key ? "is-open" : ""}`}>
        <div className="csf-gap-rail">
          {canInsert && <button type="button" className="csf-ins" onClick={() => setAdding(adding === key ? null : key)} aria-label="Add a step here" title="Add a step here"><Ico n="plus" s={12} /></button>}
        </div>
        <div className="csf-gap-b">{menu(listPath, i, len)}</div>
      </div>
    );
  };

  /** "Sent [3] days after the step before" — what each e-mail and task waits for, and from when */
  const timing = (n: CsFlowNode, listPath: Path, i: number, top: boolean, laneK: CsLane | null, verb: string) => {
    if (top && i === 0 && campaign) return <div className="csf-timing is-now"><Ico n="send" s={13} /><span>{sent ? "Went out when you pressed Send" : "Goes out the moment you press Send"}</span></div>;
    const v = Math.max(0, Number(n.wait_days) || 0);
    const from = i > 0 ? "the step before" : top ? "the start" : laneK === "replied" ? "they reply" : "the check decides";
    return (
      <div className={`csf-timing ${v ? "" : "is-now"}`}>
        <Ico n="clock" s={13} /><span>{verb}</span>
        <NumInput type="number" min={0} value={v} onChange={(e) => setNode(listPath, i, { wait_days: Math.max(0, Number(e.target.value) || 0) })} aria-label="Days after" />
        <span>day{v === 1 ? "" : "s"} after {from}{v ? "" : " (the same day)"}</span>
      </div>
    );
  };

  const renderList = (listPath: Path, depth: number, laneK: CsLane | null = null): ReactNode => {
    const list = listAt(nodes, [...listPath, 0]);
    const top = !listPath.length;
    const ended = list[list.length - 1]?.type === "stop";
    const endKey = `${ptrOf(listPath)}@${list.length}`;
    return (
      <ol className={`csf-list ${top ? "is-top" : "is-lane"}`}>
        {list.map((n, i) => {
          const path: Path = [...listPath, i];
          const ptr = ptrOf(path);
          const at = here[ptr] ?? 0;
          const firstSent = campaign && sent && top && i === 0;
          const lock = campaign && top && i === 0 && n.type === "email";
          return (
            <li key={n.id ?? i} className={`csf-item is-${n.type}`}>
              {gap(n, listPath, i, list.length, top)}
              <div className="csf-row">
                <span className={`csf-tile is-${n.type}`}><Ico n={n.type === "email" ? "mail" : n.type === "task" ? "task" : n.type === "branch" ? "split" : "stop"} s={n.type === "stop" ? 13 : 16} /></span>
                {n.type === "email" && (() => {
                  const st = stats[ptr];
                  const t = templates.find((x) => x.id === n.template_id);
                  return (
                    <div className="csf-card is-email">
                      <div className="csf-ch">
                        <span className="csf-k">E-mail {mailNo[n.id] ?? ""}</span>
                        {at > 0 && <span className="csf-here" title="Clients waiting here now">{at} here</span>}
                        <span className="csf-sp" />
                        {tools(listPath, i, list.length, lock)}
                        {when(days.at[ptr])}
                      </div>
                      {timing(n, listPath, i, top, laneK, "Sent")}
                      <div className="csf-tpl">
                        <Select size="sm" value={n.template_id ?? ""} disabled={firstSent} onChange={(v) => (v === "__new" ? onNewTemplate() : setNode(listPath, i, { template_id: v }))} placeholder="Pick an e-mail blueprint…" searchable options={tplOpts} />
                      </div>
                      {t ? (
                        <div className="csf-subj"><span>Subject</span><b translate="no" dangerouslySetInnerHTML={{ __html: chipsOf(t.subject || "(no subject)") }} /></div>
                      ) : <p className="csf-warn">Pick the e-mail it sends.</p>}
                      {st && st.sent > 0 && (
                        <div className="csf-stats" aria-label="What this e-mail did">
                          <span><Ico n="send" s={11} /><b>{st.sent}</b>sent</span>
                          <span title="The e-mail's pictures loaded (some apps hide them; Apple Mail loads them by itself)"><Ico n="eye" s={11} /><b>{pct(st.opened, st.sent)}</b>opened</span>
                          <span><Ico n="click" s={11} /><b>{pct(st.clicked, st.sent)}</b>clicked</span>
                          <span className="is-reply"><Ico n="reply" s={11} /><b>{pct(st.replied, st.sent)}</b>replied</span>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {n.type === "task" && (
                  <div className="csf-card is-task">
                    <div className="csf-ch">
                      <span className="csf-k">Task</span>
                      {at > 0 && <span className="csf-here">{at} here</span>}
                      <span className="csf-sp" />
                      {tools(listPath, i, list.length)}
                      {when(days.at[ptr])}
                    </div>
                    {timing(n, listPath, i, top, laneK, "Created")}
                    <ChipField value={n.title ?? ""} onChange={(v) => setNode(listPath, i, { title: v })} placeholder="What to do — e.g. Call the client" label="Task title" groups={TASK_GROUPS} names={TASK_CHIP} />
                    <div className="csf-meta">
                      <label className="csf-m is-who"><Ico n="user" s={13} /><span>For</span>
                        <Select size="sm" value={n.assign ?? "owners"} onChange={(v) => setNode(listPath, i, { assign: v })} options={whoOpts} searchable />
                      </label>
                      <label className="csf-m"><Ico n="cal" s={13} /><span>Due in</span>
                        <NumInput type="number" min={0} value={Number(n.due_days) || 0} onChange={(e) => setNode(listPath, i, { due_days: Math.max(0, Number(e.target.value) || 0) })} aria-label="Due in days" />
                        <span>day{Number(n.due_days) === 1 ? "" : "s"}</span>
                        {days.at[ptr] && <em className="csf-due">→ {fmtD(days.at[ptr].lo + (Number(n.due_days) || 0))}{days.at[ptr].lo !== days.at[ptr].hi ? ` – ${fmtD(days.at[ptr].hi + (Number(n.due_days) || 0))}` : ""}</em>}
                      </label>
                    </div>
                    <ChipField multi value={n.notes ?? ""} onChange={(v) => setNode(listPath, i, { notes: v })} placeholder="Notes for them (optional)" label="Task notes" groups={TASK_GROUPS} names={TASK_CHIP} />
                  </div>
                )}
                {n.type === "stop" && (
                  <div className="csf-card is-stop">
                    <span className="csf-k">End</span><span className="csf-stop-t">The client leaves the {campaign ? "campaign" : "sequence"} here.</span>
                    <span className="csf-sp" />
                    {tools(listPath, i, list.length)}
                    {when(days.at[ptr])}
                  </div>
                )}
                {n.type === "branch" && (() => {
                  const lane = lanes[n.id] ?? "replied";
                  const before = [...list.slice(0, i)].reverse().find((x) => x.type === "email");
                  const prevEmail = !!before || !top;
                  const days_ = Number(n.days) || 0;
                  const t0 = days.at[ptr];
                  const dec = t0 ? { lo: t0.lo + days_, hi: t0.hi + days_ } : undefined;
                  const decTxt = dec ? (dec.lo === dec.hi ? fmtD(dec.lo) : `${fmtD(dec.lo)} – ${fmtD(dec.hi)}`) : "";
                  const mailName = before ? `e-mail ${mailNo[before.id] ?? ""}` : "the e-mail before";
                  const sub: Record<CsLane, string> = { replied: `Any day until ${decTxt}`, opened: `On ${decTxt}`, none: `On ${decTxt}` };
                  const title: Record<CsLane, string> = { replied: "Someone replies", opened: "Opened, no reply", none: "Nobody opens it" };
                  return (
                    <div className={`csf-card is-branch d-${Math.min(depth, 3)}`}>
                      <div className="csf-ch">
                        <span className="csf-k">Wait &amp; check</span>
                        {at > 0 && <span className="csf-here">{at} waiting</span>}
                        <span className="csf-sp" />
                        {tools(listPath, i, list.length)}
                        {when(t0 && dec ? { lo: t0.lo, hi: dec.hi } : undefined)}
                      </div>
                      <div className="csf-timing is-check">
                        <Ico n="clock" s={13} /><span>Waits up to</span>
                        <NumInput type="number" min={0} value={days_} onChange={(e) => setNode(listPath, i, { days: Math.max(0, Number(e.target.value) || 0) })} aria-label="Days to wait" />
                        <span>day{days_ === 1 ? "" : "s"} to see what the client does with <b>{mailName}</b>{decTxt ? <> — it decides on <b>{decTxt}</b></> : null}. The whole client counts: if anyone there replies, it's a reply.</span>
                      </div>
                      {!prevEmail && <p className="csf-warn">Put an e-mail before this check — it looks at the last e-mail sent.</p>}
                      <div className="csf-lanes" role="tablist" aria-label="What the client did">
                        {LANES.map((l) => {
                          const steps = n.paths?.[l.k] ?? [];
                          const there = Object.entries(here).filter(([k]) => k.startsWith(`${ptr}/${l.k}/`)).reduce((s, [, v]) => s + v, 0);
                          return (
                            <button key={l.k} type="button" role="tab" aria-selected={lane === l.k} className={`csf-lane is-${l.k} ${lane === l.k ? "is-on" : ""}`} onClick={() => setLanes((x) => ({ ...x, [n.id]: l.k }))} title={l.hint}>
                              <span className="csf-lane-i"><Ico n={LANE_ICO[l.k]} s={14} /></span>
                              <span className="csf-lane-t"><b>{title[l.k]}</b><i>{sub[l.k]}</i></span>
                              <em className="csf-lane-n">{steps.length || "—"}{there ? <span title="Clients on this path now"> · {there}</span> : null}</em>
                            </button>
                          );
                        })}
                      </div>
                      <div className={`csf-lanebody is-${lane}`} role="tabpanel">
                        <p className="csf-lanehint"><b>If {lane === "replied" ? "anyone at the client replies" : lane === "opened" ? "someone opens it but nobody replies" : "nobody at the client opens it"}</b>{lane === "replied" ? ` (any day until ${decTxt})` : ` (seen on ${decTxt})`}:</p>
                        {renderList([...listPath, i, lane], depth + 1, lane)}
                        {listAt(nodes, [...listPath, i, lane, 0]).slice(-1)[0]?.type !== "stop" && <p className="csf-then"><Ico n="dn" s={12} />{(n.paths?.[lane] ?? []).length ? "Then they carry on with the steps below this check." : "Nothing extra: they go straight on to the steps below this check."}</p>}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </li>
          );
        })}
        {!ended && (
          <li className={`csf-item is-add ${adding === endKey ? "is-open" : ""}`}>
            <div className="csf-row">
              <button type="button" className="csf-tile is-add" onClick={() => setAdding(adding === endKey ? null : endKey)} aria-label="Add a step" aria-expanded={adding === endKey}><Ico n={adding === endKey ? "x" : "plus"} s={15} /></button>
              <div className="csf-add-b">
                {adding === endKey ? menu(listPath, list.length, list.length)
                  : <button type="button" className="csf-add" onClick={() => setAdding(endKey)}>{top ? (list.length ? "Add a step" : "Add the first step") : "Add a step to this path"}</button>}
              </div>
            </div>
          </li>
        )}
      </ol>
    );
  };

  return (
    <div className="csf">
      <div className="csf-row csf-start">
        <span className="csf-tile is-start"><Ico n="flag" s={14} /></span>
        <div className="csf-start-t"><div><b>Start</b><i>{startText}</i></div>{when({ lo: 0, hi: 0 })}</div>
      </div>
      {renderList([], 0)}
    </div>
  );
}

/* =====================================================================
   Day by day: what one client goes through, on a calendar that starts on
   1 January (or on the day a campaign was sent). One story per way the
   checks can go (they reply · they open it, no reply · they don't open it).
   ===================================================================== */
type CsEv = { day: number; until?: number; kind: "email" | "task" | "wait" | CsLane | "stop" | "end"; title: string; html?: string; sub?: string };
export type CsStory = { key: string; label: string; outs: { lane: CsLane; mail: number }[]; ev: CsEv[]; end: number };
const nodeAtP = (root: CsFlowNode[], ptr: string | null): CsFlowNode | null => {
  if (!ptr) return null;
  const parts = ptr.split("/");
  let list: CsFlowNode[] | undefined = root;
  let node: CsFlowNode | null = null;
  for (let k = 0; k < parts.length; k += 2) {
    node = list?.[Number(parts[k])] ?? null;
    if (!node) return null;
    if (k + 1 < parts.length) list = node.paths?.[parts[k + 1] as CsLane] ?? [];
  }
  return node;
};
const nextP = (root: CsFlowNode[], ptr: string): string | null => {
  const parts = ptr.split("/");
  const sib = [...parts.slice(0, -1), String(Number(parts[parts.length - 1]) + 1)].join("/");
  if (nodeAtP(root, sib)) return sib;
  return parts.length < 3 ? null : nextP(root, parts.slice(0, -2).join("/"));
};
const SHORT: Record<CsLane, string> = { replied: "Replies", opened: "Opens", none: "No open" };
const LANE_SAY: Record<CsLane, string> = { replied: "Someone replies", opened: "Opened, no reply", none: "Nobody opens it" };

/** Every way a client can go through the steps (up to `cap`), with the day of each thing. A reply is shown the day after. */
export function flowStories(nodes: CsFlowNode[], templates: CsTemplate[], whoOf: (n: CsFlowNode) => string, cap = 12): CsStory[] {
  const out: CsStory[] = [];
  const mailNo: Record<string, number> = {};
  flowEmails(nodes).forEach((n, i) => { mailNo[n.id] = i + 1; });
  const finish = (ev: CsEv[], outs: CsStory["outs"], day: number) => {
    const multi = outs.length > 1;
    out.push({ key: outs.map((o) => o.lane).join(">") || "all", outs, ev, end: day,
      label: outs.length ? outs.map((o) => `${LANE_SAY[o.lane]}${multi ? ` (e-mail ${o.mail})` : ""}`).join(" → ") : "Every client" });
  };
  const sim = (ptr: string | null, day: number, ev0: CsEv[], outs: CsStory["outs"], lastMail: number) => {
    if (out.length >= cap) return;
    let p = ptr, d = day, last = lastMail;
    const ev = [...ev0];
    for (let g = 0; g < 200 && p; g++) {
      const n = nodeAtP(nodes, p);
      if (!n) break;
      if (n.type === "email") {
        d += Math.max(0, Number(n.wait_days) || 0);
        const t = templates.find((x) => x.id === n.template_id);
        last = mailNo[n.id] ?? last;
        ev.push({ day: d, kind: "email", title: `E-mail ${last} goes out`, sub: t ? t.name : "No blueprint picked yet" });
        p = nextP(nodes, p); continue;
      }
      if (n.type === "task") {
        d += Math.max(0, Number(n.wait_days) || 0);
        const due = d + Math.max(0, Number(n.due_days) || 0);
        ev.push({ day: d, kind: "task", title: "A task is created", html: chipsOf(n.title || "Follow up with {{client}}", TASK_CHIP), sub: `For ${whoOf(n)} · due ${due === d ? "the same day" : `${due - d} day${due - d === 1 ? "" : "s"} later`}` });
        p = nextP(nodes, p); continue;
      }
      if (n.type === "stop") { ev.push({ day: d, kind: "stop", title: "They leave here — nothing else happens" }); finish(ev, outs, d); return; }
      if (n.type === "branch") {
        const w = Math.max(0, Number(n.days) || 0);
        for (const l of LANES) {
          if (out.length >= cap) return;
          const od = l.k === "replied" ? d + Math.min(1, w) : d + w;
          const say = l.k === "replied" ? `Someone at the client replies to e-mail ${last}` : l.k === "opened" ? `Someone opened e-mail ${last}, nobody replied` : `Nobody at the client opened e-mail ${last}`;
          const ev2: CsEv[] = [...ev, { day: d, until: od, kind: "wait", title: `Waiting to see what they do with e-mail ${last}`, sub: `Up to ${w} day${w === 1 ? "" : "s"}` },
            { day: od, kind: l.k, title: say, sub: l.k === "replied" ? "Seen within the hour" : `Checked at the end of the ${w}-day wait` }];
          const lp = (n.paths?.[l.k] ?? []).length ? `${p}/${l.k}/0` : nextP(nodes, p);
          sim(lp, od, ev2, [...outs, { lane: l.k, mail: last }], last);
        }
        return;
      }
      break;
    }
    if (ev.length) ev.push({ day: d, kind: "end", title: "Done — the last step is behind them" });
    finish(ev, outs, d);
  };
  sim(nodes.length ? "0" : null, 0, [], [], 0);
  return out;
}

const EV_ICO: Record<CsEv["kind"], keyof typeof I> = { email: "mail", task: "task", wait: "clock", replied: "reply", opened: "eye", none: "eyeoff", stop: "stop", end: "flag" };

export function CsFlowCalendar({ nodes, templates, people, campaign, startAt = null }: {
  nodes: CsFlowNode[]; templates: CsTemplate[]; people: Employee[]; campaign: boolean; startAt?: Date | null;
}) {
  const whoOf = (n: CsFlowNode) => {
    const a = n.assign ?? "owners";
    return a === "owners" ? "the client's owners" : a === "primary" ? "the client's main owner" : a === "sender" ? (campaign ? "whoever sends it" : "the sequence's creator") : people.find((p) => p.id === a)?.name ?? "someone";
  };
  const stories = flowStories(nodes, templates, whoOf);
  const [pick, setPick] = useState(0);
  const st = stories[Math.min(pick, stories.length - 1)];
  const fmt = dayFmt(startAt);
  const long = (n: number) => fmt(n, { day: "numeric", month: "long" });
  if (!st || !st.ev.length) return <div className="csc"><p className="csc-empty">Add the first step to see it day by day.</p></div>;
  const byDay = new Map<number, CsEv[]>();
  st.ev.forEach((e) => byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]));
  const dayList = [...byDay.keys()].sort((a, b) => a - b);
  return (
    <div className="csc">
      <div className="csc-h">
        <span className="csc-h-i"><Ico n="cal" s={17} /></span>
        <div>
          <b>{startAt ? `Sent on ${long(0)}` : `Example: it starts on ${long(0)}`}</b>
          <i>What one client goes through, day by day.{stories.length > 1 ? " It depends on what they do — pick a case:" : ""}</i>
        </div>
      </div>
      {stories.length > 1 && (
        <div className="csc-cases" role="tablist" aria-label="What the client does">
          {stories.map((s, i) => {
            const lastLane = s.outs[s.outs.length - 1]?.lane ?? "replied";
            return (
              <button key={s.key + i} type="button" role="tab" aria-selected={i === pick} className={`csc-case is-${lastLane} ${i === pick ? "is-on" : ""}`} onClick={() => setPick(i)} title={`${s.label} · last step ${fmt(s.end)} (day ${s.end})`}>
                {s.outs.map((o, k) => <span key={k} className={`csc-case-i is-${o.lane}`}><Ico n={LANE_ICO[o.lane]} s={11} /></span>)}
                <b>{s.outs.map((o) => SHORT[o.lane]).join(" → ") || "Every client"}</b>
              </button>
            );
          })}
        </div>
      )}
      <ol className="csc-list">
        {dayList.map((d) => (
          <li key={d} className="csc-row">
            <div className="csc-date"><b>{fmt(d, { day: "numeric" })}</b><span>{fmt(d, { month: "short" })}</span><em>Day {d}</em></div>
            <div className="csc-evs">
              {byDay.get(d)!.map((e, k) => (
                <div key={k} className={`csc-ev is-${e.kind}`}>
                  <span className="csc-ev-i"><Ico n={EV_ICO[e.kind]} s={13} /></span>
                  <div>
                    <b>{e.title}{e.kind === "wait" && e.until != null ? <> until <u>{fmt(e.until)}</u></> : null}</b>
                    {e.html && <span className="csc-ev-h" dangerouslySetInnerHTML={{ __html: e.html }} />}
                    {e.sub && <i>{e.sub}</i>}
                  </div>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ol>
      {st.outs.some((o) => o.lane === "replied") && <p className="csc-note">A reply can come any day while it waits — here it comes the day after. It's followed straight away.</p>}
    </div>
  );
}
