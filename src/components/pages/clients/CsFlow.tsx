// Customer success › a sequence's steps as a tree (114_cs_flows.sql, run by the cs-engine function):
// e-mails, "wait and check" branches (replied · opened, no reply · didn't open), tasks for the client's owners, end.
// A branch's path, once done, carries on with the steps after the branch.
import { useState, type ReactNode } from "react";
import Select from "../../framework/Select";
import type { CsMailLog, CsTemplate, CsFolder, CsSequence, CsRun } from "./useClientsData";
import type { Employee } from "../companies/companiesApi";
import "./CsFlow.css";

export type CsLane = "replied" | "opened" | "none";
export interface CsFlowNode {
  id: string; type: "email" | "branch" | "task" | "stop";
  template_id?: string; wait_days?: number;
  days?: number; paths?: Partial<Record<CsLane, CsFlowNode[]>>;
  title?: string; notes?: string; assign?: string; due_days?: number;
}
export const LANES: { k: CsLane; label: string; hint: string }[] = [
  { k: "replied", label: "Replied", hint: "They wrote back — as soon as it's seen" },
  { k: "opened", label: "Opened, no reply", hint: "Opened it or clicked a link, but didn't write back" },
  { k: "none", label: "Didn't open", hint: "No sign they opened it" },
];
const nid = () => Math.random().toString(36).slice(2, 9);

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
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
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

export default function CsFlowEditor({ nodes, onChange, templates, folders, people, campaign, sent, startText, stats, here, onNewTemplate }: {
  nodes: CsFlowNode[]; onChange: (n: CsFlowNode[]) => void;
  templates: CsTemplate[]; folders: CsFolder[]; people: Employee[];
  campaign: boolean; sent: boolean; startText: string;
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
  const firstTpl = flowEmails(nodes)[0]?.template_id ?? templates[0]?.id ?? "";

  const setNode = (listPath: Path, i: number, patch: Partial<CsFlowNode>) => onChange(withList(nodes, listPath, (xs) => xs.map((n, k) => (k === i ? { ...n, ...patch } : n))));
  const move = (listPath: Path, i: number, d: -1 | 1) => onChange(withList(nodes, listPath, (xs) => { const ys = [...xs]; const j = i + d; if (j < 0 || j >= ys.length) return xs; [ys[i], ys[j]] = [ys[j], ys[i]]; return ys; }));
  const drop = (listPath: Path, i: number) => onChange(withList(nodes, listPath, (xs) => xs.filter((_, k) => k !== i)));
  const add = (listPath: Path, n: CsFlowNode) => onChange(withList(nodes, listPath, (xs) => [...xs, n]));

  const adder = (listPath: Path, nested = false) => {
    const list = listAt(nodes, [...listPath, 0]);
    const ended = list[list.length - 1]?.type === "stop";
    if (ended) return null;
    return (
      <div className={`csf-add ${nested ? "is-nested" : ""}`}>
        <span className="csf-add-l">{nested ? "Add here" : "Add a step"}</span>
        <button type="button" onClick={() => add(listPath, newEmailNode(firstTpl, list.length ? 3 : 0))}><Ico n="mail" s={13} />E-mail</button>
        <button type="button" onClick={() => add(listPath, newBranch(firstTpl))} disabled={!list.some((x) => x.type === "email") && !nested && !listPath.length && !list.length}><Ico n="split" s={13} />Wait &amp; check</button>
        <button type="button" onClick={() => add(listPath, newTask())}><Ico n="task" s={13} />Task</button>
        <button type="button" onClick={() => add(listPath, { id: nid(), type: "stop" })}><Ico n="stop" s={12} />End</button>
      </div>
    );
  };

  const tools = (listPath: Path, i: number, len: number, lockFirst = false) => (
    <div className="csf-tools">
      <button type="button" disabled={i === 0 || (lockFirst && i === 1)} onClick={() => move(listPath, i, -1)} aria-label="Move earlier" title="Earlier"><Ico n="up" s={12} /></button>
      <button type="button" disabled={i === len - 1 || (lockFirst && i === 0)} onClick={() => move(listPath, i, 1)} aria-label="Move later" title="Later"><Ico n="dn" s={12} /></button>
      <button type="button" disabled={lockFirst && i === 0} onClick={() => drop(listPath, i)} aria-label="Remove this step" title="Remove"><Ico n="trash" s={12} /></button>
    </div>
  );

  const wait = (n: CsFlowNode, listPath: Path, i: number, top: boolean) => {
    if (n.type === "branch" || n.type === "stop") return null;
    if (top && i === 0 && campaign) return <div className="csf-wait"><span className="csf-pill is-start"><Ico n="send" s={11} />When you press Send</span></div>;
    const v = Number(n.wait_days) || 0;
    return (
      <div className="csf-wait">
        <span className="csf-pill"><Ico n="clock" s={11} />{i === 0 && !top ? "Wait" : top && i === 0 ? "Wait" : "Then wait"}
          <input type="number" min={0} value={v} onChange={(e) => setNode(listPath, i, { wait_days: Math.max(0, Number(e.target.value) || 0) })} aria-label="Days to wait" />
          day{v === 1 ? "" : "s"}{!v ? " · right away" : ""}</span>
      </div>
    );
  };

  const renderList = (listPath: Path, depth: number): ReactNode => {
    const list = listAt(nodes, [...listPath, 0]);
    const top = !listPath.length;
    return (
      <ol className={`csf-list ${top ? "is-top" : "is-lane"}`}>
        {list.map((n, i) => {
          const path: Path = [...listPath, i];
          const ptr = ptrOf(path);
          const at = here[ptr] ?? 0;
          const firstSent = campaign && sent && top && i === 0;
          return (
            <li key={n.id ?? i} className={`csf-item is-${n.type}`}>
              {wait(n, listPath, i, top)}
              {n.type === "email" && (() => {
                const st = stats[ptr];
                const t = templates.find((x) => x.id === n.template_id);
                return (
                  <div className="csf-card is-email">
                    <span className="csf-ico is-email"><Ico n="mail" s={15} /></span>
                    <div className="csf-main">
                      <em>E-mail{at ? <span className="csf-here" title="Clients waiting here now">{at} here</span> : null}</em>
                      <Select size="sm" value={n.template_id ?? ""} disabled={firstSent} onChange={(v) => (v === "__new" ? onNewTemplate() : setNode(listPath, i, { template_id: v }))} placeholder="Pick an e-mail blueprint…" searchable options={tplOpts} />
                      {t && <span className="csf-sub">Subject: <b>{t.subject || "(no subject)"}</b></span>}
                      {st && st.sent > 0 && (
                        <div className="csf-stats" aria-label="What this e-mail did">
                          <span><b>{st.sent}</b>sent</span>
                          <span title="The e-mail's pictures loaded (some apps hide them; Apple Mail loads them by itself)"><b>{pct(st.opened, st.sent)}</b>opened</span>
                          <span><b>{pct(st.clicked, st.sent)}</b>clicked</span>
                          <span className="is-reply"><b>{pct(st.replied, st.sent)}</b>replied</span>
                        </div>
                      )}
                    </div>
                    {tools(listPath, i, list.length, firstSent)}
                  </div>
                );
              })()}
              {n.type === "task" && (
                <div className="csf-card is-task">
                  <span className="csf-ico is-task"><Ico n="task" s={15} /></span>
                  <div className="csf-main">
                    <em>Task{at ? <span className="csf-here">{at} here</span> : null}</em>
                    <div className="csf-row">
                      <Select size="sm" value={n.assign ?? "owners"} onChange={(v) => setNode(listPath, i, { assign: v })} options={whoOpts} searchable />
                      <span className="csf-inl">due in <input type="number" min={0} value={Number(n.due_days) || 0} onChange={(e) => setNode(listPath, i, { due_days: Math.max(0, Number(e.target.value) || 0) })} aria-label="Due in days" /> day{Number(n.due_days) === 1 ? "" : "s"}</span>
                    </div>
                    <input className="csf-in" value={n.title ?? ""} onChange={(e) => setNode(listPath, i, { title: e.target.value })} placeholder="What to do — e.g. Call {{client}}, they replied" />
                    <textarea className="csf-in is-notes" rows={2} value={n.notes ?? ""} onChange={(e) => setNode(listPath, i, { notes: e.target.value })} placeholder="Notes for them (optional)" />
                  </div>
                  {tools(listPath, i, list.length)}
                </div>
              )}
              {n.type === "stop" && (
                <div className="csf-card is-stop">
                  <span className="csf-ico is-stop"><Ico n="stop" s={13} /></span>
                  <div className="csf-main"><em>End</em><span className="csf-sub">The client leaves the sequence here.</span></div>
                  {tools(listPath, i, list.length)}
                </div>
              )}
              {n.type === "branch" && (() => {
                const lane = lanes[n.id] ?? "replied";
                const prevEmail = list.slice(0, i).some((x) => x.type === "email") || !top;
                return (
                  <div className={`csf-card is-branch d-${Math.min(depth, 3)}`}>
                    <div className="csf-bh">
                      <span className="csf-ico is-branch"><Ico n="split" s={15} /></span>
                      <div className="csf-main">
                        <em>Wait &amp; check{at ? <span className="csf-here">{at} waiting</span> : null}</em>
                        <span className="csf-sub">Wait up to <input type="number" min={0} value={Number(n.days) || 0} onChange={(e) => setNode(listPath, i, { days: Math.max(0, Number(e.target.value) || 0) })} aria-label="Days to wait" /> day{Number(n.days) === 1 ? "" : "s"} for the e-mail before, then go by what the client did:</span>
                        {!prevEmail && <span className="csf-warn">Put an e-mail before this check — it looks at the last e-mail sent.</span>}
                      </div>
                      {tools(listPath, i, list.length)}
                    </div>
                    <div className="csf-lanes" role="tablist" aria-label="What the client did">
                      {LANES.map((l) => {
                        const steps = n.paths?.[l.k] ?? [];
                        const there = Object.entries(here).filter(([k]) => k.startsWith(`${ptr}/${l.k}/`)).reduce((s, [, v]) => s + v, 0);
                        return (
                          <button key={l.k} type="button" role="tab" aria-selected={lane === l.k} className={`csf-lane is-${l.k} ${lane === l.k ? "is-on" : ""}`} onClick={() => setLanes((x) => ({ ...x, [n.id]: l.k }))} title={l.hint}>
                            <Ico n={LANE_ICO[l.k]} s={13} /><b>{l.label}</b>
                            <i>{steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : "carries on"}{there ? ` · ${there} here` : ""}</i>
                          </button>
                        );
                      })}
                    </div>
                    <div className={`csf-lanebody is-${lane}`} role="tabpanel">
                      <p className="csf-lanehint">{LANES.find((l) => l.k === lane)!.hint}{lane === "replied" ? "." : ` — decided after the ${Number(n.days) || 0} day${Number(n.days) === 1 ? "" : "s"}.`} {(n.paths?.[lane] ?? []).length ? "Then on with the steps after this check, unless it ends." : "Nothing here: the client goes straight on to the steps after this check."}</p>
                      {renderList([...listPath, i, lane], depth + 1)}
                      {adder([...listPath, i, lane], true)}
                    </div>
                  </div>
                );
              })()}
            </li>
          );
        })}
      </ol>
    );
  };

  return (
    <div className="csf">
      <div className="csf-start"><span className="csf-dot"><Ico n="flag" s={12} /></span><div><b>Start</b><i>{startText}</i></div></div>
      {renderList([], 0)}
      {adder([])}
    </div>
  );
}
