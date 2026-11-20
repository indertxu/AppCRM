/* =====================================================================
   Marketing › Workflows (SQL 149, run by marketing-hub "wf_due" every 5 minutes)

   A workflow starts by itself — someone got / opened / clicked / answered an e-mail
   campaign, a post went out, someone filled in a form — and then runs steps, like the
   customer-success sequences: e-mails (Marketing templates), "wait & check" branches
   (replied · opened, no reply · didn't open), tasks for the team, end.

   Opened from the Overview ("Workflows" next to the tabs). The flow editor is a timeline:
   every step a card on a rail, the days it happens on the rail, "+" between steps.
   ===================================================================== */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { supabase } from "../../../api/supabase";
import Select from "../../../framework/Select";
import { NumInput } from "../../../framework/NumInput";
import { listEmployees, type Employee } from "../../companies/companiesApi";
import { ChipField, flowDays, dayText, type CsDayRange } from "../../clients/CsFlow";
import type { MailAcct } from "../../../api/marketingHub";
import "./MkWorkflows.css";

/* ---------- the data ---------- */
export type WfLane = "replied" | "opened" | "none";
export interface WfNode {
  id: string; type: "email" | "branch" | "task" | "stop";
  template_id?: string; wait_days?: number;
  /** e-mail: goes as a reply to the e-mail before it — same thread, "RE: <first subject>", the earlier ones quoted below */
  thread?: boolean;
  days?: number; paths?: Partial<Record<WfLane, WfNode[]>>;
  title?: string; notes?: string; assign?: string; due_days?: number;
}
export type WfTrigger =
  | { kind: "campaign"; campaign_id?: string | null; event?: "sent" | "opened" | "clicked" | "replied" | "not_opened"; days?: number; backfill?: boolean }
  | { kind: "post"; post_id?: string | null; networks?: string[] | null; list_id?: string | null; backfill?: boolean }
  | { kind: "form"; form_id?: string | null; backfill?: boolean }
  /** someone is added to a (fixed) list — by hand, an import or a form that adds to it */
  | { kind: "list"; list_id?: string | null; backfill?: boolean }
  | { kind?: undefined };
export interface MkWorkflow {
  id: string; name: string; status: "draft" | "active" | "paused"; trigger: WfTrigger; flow: WfNode[];
  sender_account: string | null; from_address: string | null; owner_id: string | null;
  activated_at: string | null; last_run_at: string | null; last_error: string | null;
  created_by: string | null; created_at: string; updated_at: string;
}
/** What the page around it already has (Marketing): passed in, nothing is read twice. */
export interface WfWorld {
  campaigns: { id: string; name: string; subject: string; status: string; started_at: string | null; created_at: string }[];
  posts: { id: string; title: string | null; body: string; networks: string[]; status: string; published_at: string | null; scheduled_at: string | null }[];
  forms: { id: string; name: string; status: string }[];
  lists: { id: string; name: string; kind: "dynamic" | "static"; entity: string; member_count?: number | null }[];
  accounts: MailAcct[];
  outlookMail: string | null;
  meId: string | null;
  nets: { key: string; label: string; color: string }[];
  toast: (t: string) => void;
  /** Leave to E-mail › Templates (a new template for a step). */
  onTemplates: () => void;
  onConnect: () => void;
}
interface Tpl { id: string; name: string; subject: string; updated_at: string }
interface RunRow { workflow_id: string; status: string; node: string }
/** Every row of a query, 1000 at a time: the API hands back at most 1000 rows per request, so one
 *  big read silently cut the figures off (a workflow showed 0 e-mails though it had sent them all). */
async function pageAll(q: () => any, page = 1000): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await q().range(from, from + page - 1);
    if (error || !data) return out;
    out.push(...data);
    if (data.length < page) return out;
  }
}
interface SendRow { workflow_id: string; wf_node: string | null; status: string; opened_at: string | null; clicked_at: string | null; replied_at: string | null }
interface EvRow { id: string; workflow_id: string; run_id: string | null; node: string | null; kind: string; detail: any; created_at: string }

const MISSING = /mk_workflow|relation|schema cache|does not exist|Could not find the table/i;
const nid = () => Math.random().toString(36).slice(2, 9);
const LANES: { k: WfLane; label: string; hint: string }[] = [
  { k: "replied", label: "Replied", hint: "They wrote back — as soon as the reply is seen" },
  { k: "opened", label: "Opened, no reply", hint: "They opened it or clicked a link, but didn't write back" },
  { k: "none", label: "Didn't open", hint: "They didn't open it" },
];
const EVENTS: { value: NonNullable<Extract<WfTrigger, { kind: "campaign" }>["event"]>; label: string; hint: string }[] = [
  { value: "opened", label: "opens it", hint: "the first time they open it (or click a link)" },
  { value: "clicked", label: "clicks a link", hint: "any link in the e-mail" },
  { value: "replied", label: "replies", hint: "a reply reaches a synced mailbox" },
  { value: "not_opened", label: "doesn't open it", hint: "after the days you choose" },
  { value: "sent", label: "gets it", hint: "everyone it's delivered to" },
];
/* fields a task or an e-mail can name */
const WF_FIELDS: Record<string, string> = {
  first_name: "First name", full_name: "Full name", email: "E-mail", company: "Company", position: "Position", city: "City",
  post_title: "The post", post_url: "Post link", form_name: "The form", list_name: "The list", workflow: "This workflow",
};
const WF_GROUPS = [
  { label: "The person", keys: ["first_name", "full_name", "email", "position", "city"] },
  { label: "Their company", keys: ["company"] },
  { label: "What started it", keys: ["list_name", "form_name", "post_title", "post_url", "workflow"] },
];

/* ---------- icons ---------- */
const P: Record<string, string> = {
  flow: "M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 9v3a3 3 0 0 0 3 3h6M18 9V6",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  split: "M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6M6 21V3",
  task: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  stop: "M7 7h10v10H7z", plus: "M12 5v14M5 12h14", back: "M15 18l-6-6 6-6", trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  up: "M12 19V5M6 11l6-6 6 6", dn: "M12 5v14M6 13l6 6 6-6", clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  social: "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
  form: "M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1zM8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M8 12h8M8 16h5",
  bolt: "M13 2L3 14h9l-1 8 10-12h-9z", play: "M7 4.8v14.4l12-7.2z", pause: "M7 5h3v14H7zM14 5h3v14h-3z",
  reply: "M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v2", eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeoff: "M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a10.6 10.6 0 0 0 5.4-1.6M9.9 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z", users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  warn: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", check: "M5 12.5l4.5 4.5L19 7.5",
};
const Ico = ({ n, s = 16 }: { n: keyof typeof P; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[n]} /></svg>
);
const KIND_ICO: Record<WfNode["type"], keyof typeof P> = { email: "mail", branch: "split", task: "task", stop: "stop" };
const LANE_ICO: Record<WfLane, keyof typeof P> = { replied: "reply", opened: "eye", none: "eyeoff" };
const TRIG_ICO: Record<string, keyof typeof P> = { campaign: "mail", post: "social", form: "form", list: "users" };

/* ---------- tree helpers ---------- */
type Path = (number | WfLane)[];
const ptrOf = (p: Path) => p.join("/");
function listAt(nodes: WfNode[], listPath: Path): WfNode[] {
  let xs = nodes;
  for (let i = 0; i + 1 < listPath.length; i += 2) xs = xs[listPath[i] as number]?.paths?.[listPath[i + 1] as WfLane] ?? [];
  return xs;
}
function withList(nodes: WfNode[], listPath: Path, fn: (xs: WfNode[]) => WfNode[]): WfNode[] {
  if (!listPath.length) return fn(nodes);
  const [i, lane, ...rest] = listPath as [number, WfLane, ...Path];
  return nodes.map((n, k) => (k !== i ? n : { ...n, paths: { ...(n.paths ?? {}), [lane]: withList(n.paths?.[lane] ?? [], rest, fn) } }));
}
function walk(nodes: WfNode[], fn: (n: WfNode) => void) { nodes.forEach((n) => { fn(n); if (n.type === "branch") LANES.forEach((l) => walk(n.paths?.[l.k] ?? [], fn)); }); }
const countOf = (nodes: WfNode[]) => { const c = { email: 0, branch: 0, task: 0 }; walk(nodes, (n) => { if (n.type !== "stop") c[n.type]++; }); return c; };
const newNode = (kind: WfNode["type"], tpl: string, first: boolean): WfNode =>
  kind === "email" ? { id: nid(), type: "email", template_id: tpl, wait_days: first ? 0 : 2 }
  : kind === "task" ? { id: nid(), type: "task", title: "Follow up with {{full_name}}", assign: "owner", due_days: 2, wait_days: 0 }
  : kind === "branch" ? { id: nid(), type: "branch", days: 3, paths: {
      replied: [{ id: nid(), type: "task", title: "{{full_name}} replied — get back to them", assign: "owner", due_days: 1, wait_days: 0 }],
      opened: [{ id: nid(), type: "email", template_id: tpl, wait_days: 0 }], none: [{ id: nid(), type: "email", template_id: tpl, wait_days: 0 }] } }
  : { id: nid(), type: "stop" };
const blankWorkflow = (meId: string | null): Omit<MkWorkflow, "id" | "created_at" | "updated_at"> => ({
  name: "", status: "draft", trigger: { kind: "list" }, flow: [],
  sender_account: null, from_address: null, owner_id: meId, activated_at: null, last_run_at: null, last_error: null, created_by: meId,
});
const fmtN = (n: number) => n.toLocaleString("en-GB");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const ago = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

/** In words: what starts it. */
function triggerText(t: WfTrigger, w: WfWorld): string {
  if (t.kind === "campaign") {
    const c = w.campaigns.find((x) => x.id === t.campaign_id);
    const verb = ({ opened: "opens", clicked: "clicks a link in", replied: "replies to", not_opened: "doesn't open", sent: "gets" } as Record<string, string>)[t.event ?? "opened"] ?? "opens";
    if (!c) return `Someone ${verb} an e-mail campaign`;
    return `Someone ${verb} “${c.name || c.subject}”${t.event === "not_opened" ? ` within ${t.days ?? 3} days` : ""}`;
  }
  if (t.kind === "post") {
    const p = w.posts.find((x) => x.id === t.post_id);
    const nets = (t.networks ?? []).map((k) => w.nets.find((n) => n.key === k)?.label ?? k);
    const what = p ? `“${p.title || p.body.slice(0, 40)}” goes out` : `A post${nets.length ? ` on ${nets.join(" or ")}` : ""} goes out`;
    const l = w.lists.find((x) => x.id === t.list_id);
    return `${what}${l ? ` · to ${l.name}` : ""}`;
  }
  if (t.kind === "form") {
    const f = w.forms.find((x) => x.id === t.form_id);
    return f ? `Someone submits “${f.name}”` : "Someone submits any form";
  }
  if (t.kind === "list") {
    const l = w.lists.find((x) => x.id === t.list_id);
    return l ? `Someone joins “${l.name}”` : "Someone joins a list";
  }
  return "Choose what starts it";
}
/** What's missing before it can be switched on (null = ready). */
function notReady(wf: Pick<MkWorkflow, "trigger" | "flow" | "sender_account">, w: WfWorld, tpls: Tpl[]): string | null {
  const t = wf.trigger;
  if (!t.kind) return "Choose what starts it.";
  if (t.kind === "campaign" && !t.campaign_id) return "Pick the e-mail campaign that starts it.";
  if (t.kind === "list" && !t.list_id) return "Pick the list people join.";
  if (!wf.flow.length) return "Add at least one step.";
  let noTpl = false, mails = 0;
  walk(wf.flow, (n) => { if (n.type === "email") { mails++; if (!n.template_id || !tpls.some((x) => x.id === n.template_id)) noTpl = true; } });
  if (noTpl) return "Every e-mail step needs a template.";
  if (mails && !wf.sender_account && !w.outlookMail) return "Choose the account the e-mails go from.";
  if (mails && t.kind === "post" && !t.list_id) return "A post's workflow e-mails a fixed audience: pick one, or keep only tasks.";
  return null;
}

/* =====================================================================
   The list of workflows
   ===================================================================== */
export default function MkWorkflows({ w, onBack }: { w: WfWorld; onBack: () => void }) {
  const [rows, setRows] = useState<MkWorkflow[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [people, setPeople] = useState<Employee[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [sends, setSends] = useState<SendRow[]>([]);
  const [open, setOpen] = useState<string | "new" | null>(() => { try { return sessionStorage.getItem("mk-wf-open"); } catch { return null; } });
  const setOpenKeep = (v: string | "new" | null) => { setOpen(v); try { if (v && v !== "new") sessionStorage.setItem("mk-wf-open", v); else sessionStorage.removeItem("mk-wf-open"); } catch { /* private mode */ } };
  const load = async () => {
    const [wf, tp, rn, sd] = await Promise.all([
      supabase.from("mk_workflows").select("*").order("updated_at", { ascending: false }),
      supabase.from("mk_templates").select("id, name, subject, updated_at").order("name"),
      pageAll(() => supabase.from("mk_workflow_runs").select("workflow_id, status, node").order("id")),
      pageAll(() => supabase.from("marketing_sends").select("workflow_id, wf_node, status, opened_at, clicked_at, replied_at").not("workflow_id", "is", null).order("id")),
    ]);
    if (wf.error) { setMissing(MISSING.test(wf.error.message)); setRows([]); return; }
    setRows(((wf.data ?? []) as any[]).map((x) => ({ ...x, trigger: x.trigger ?? {}, flow: Array.isArray(x.flow) ? x.flow : [] })));
    setTpls((tp.data ?? []) as Tpl[]);
    setRuns(rn as RunRow[]);
    setSends(sd as SendRow[]);
  };
  useEffect(() => { void load(); listEmployees().then(setPeople).catch(() => {}); }, []);
  const statsOf = (id: string) => {
    const r = runs.filter((x) => x.workflow_id === id), s = sends.filter((x) => x.workflow_id === id && x.status === "sent");
    return { live: r.filter((x) => x.status === "active").length, done: r.filter((x) => x.status !== "active").length, total: r.length,
      sent: s.length, opened: s.filter((x) => x.opened_at).length, replied: s.filter((x) => x.replied_at).length };
  };
  const cur = open && open !== "new" ? rows?.find((x) => x.id === open) ?? null : null;
  if (open && (open === "new" || cur)) {
    return <WorkflowEditor key="ed" w={w} wf={cur} tpls={tpls} people={people} runs={runs.filter((x) => x.workflow_id === open)} sends={sends.filter((x) => x.workflow_id === open)}
      onBack={() => { setOpenKeep(null); void load(); }} onSaved={async (id) => { await load(); setOpenKeep(id); }} onDeleted={async () => { setOpenKeep(null); await load(); }} />;
  }
  const shown = rows ?? [];
  return (
    <section className="mkw">
      <header className="mkw-head">
        <button type="button" className="mkw-back" onClick={onBack} aria-label="Back to the overview"><Ico n="back" s={18} /></button>
        <span className="mkw-head-ico"><Ico n="flow" s={20} /></span>
        <div className="mkw-head-t"><h2>Workflows</h2><p>Steps that start by themselves when someone joins a list or submits a form</p></div>
        <span className="mkw-sp" />
        <button type="button" className="mkw-new" onClick={() => setOpenKeep("new")} disabled={missing}><Ico n="plus" s={15} />New workflow</button>
      </header>
      {missing && <div className="mkw-note is-warn"><Ico n="warn" />Workflows need <b>149_mk_workflows.sql</b> in Supabase.</div>}
      {rows === null ? <div className="mkw-loading"><i /><i /><i /></div> : !shown.length ? (
        <div className="mkw-empty">
          <span className="mkw-empty-art"><Ico n="flow" s={30} /></span>
          <b>No workflows yet</b>
          <p>For example: when someone opens your newsletter, wait two days and send the case study; if they reply, give the sales team a task.</p>
          {!missing && <button type="button" className="mkw-new" onClick={() => setOpenKeep("new")}><Ico n="plus" s={15} />Make the first one</button>}
        </div>
      ) : (
        <div className="mkw-grid">
          {shown.map((x, i) => {
            const st = statsOf(x.id), c = countOf(x.flow);
            return (
              <button type="button" key={x.id} className={`mkw-card is-${x.status}`} style={{ ["--i" as string]: i } as CSSProperties} onClick={() => setOpenKeep(x.id)}>
                <span className="mkw-card-top">
                  <span className={`mkw-trig is-${x.trigger.kind ?? "none"}`}><Ico n={TRIG_ICO[x.trigger.kind ?? ""] ?? "bolt"} s={15} /></span>
                  <span className={`mkw-status is-${x.status}`}><i />{x.status === "active" ? "On" : x.status === "paused" ? "Paused" : "Draft"}</span>
                </span>
                <b className="mkw-card-name">{x.name || autoName(x, w)}</b>
                <span className="mkw-card-when">{triggerText(x.trigger, w)}</span>
                <span className="mkw-card-steps">
                  {c.email > 0 && <em><Ico n="mail" s={12} />{c.email}</em>}
                  {c.branch > 0 && <em><Ico n="split" s={12} />{c.branch}</em>}
                  {c.task > 0 && <em><Ico n="task" s={12} />{c.task}</em>}
                  {!x.flow.length && <em>No steps yet</em>}
                </span>
                <span className="mkw-card-figs">
                  <span><b>{fmtN(st.live)}</b>in progress</span>
                  <span><b>{fmtN(st.sent)}</b>e-mails</span>
                  <span><b>{pct(st.opened, st.sent)}</b>opened</span>
                  <span><b>{fmtN(st.replied)}</b>replies</span>
                </span>
                {x.last_error && x.status === "active" && <span className="mkw-card-err"><Ico n="warn" s={12} />{x.last_error}</span>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* =====================================================================
   One workflow: what starts it, who it comes from, its steps, how it's going
   ===================================================================== */
function WorkflowEditor({ w, wf, tpls, people, runs, sends, onBack, onSaved, onDeleted }: {
  w: WfWorld; wf: MkWorkflow | null; tpls: Tpl[]; people: Employee[]; runs: RunRow[]; sends: SendRow[];
  onBack: () => void; onSaved: (id: string) => Promise<void>; onDeleted: () => Promise<void>;
}) {
  const [d, setD] = useState(() => (wf ? { ...wf } : { ...blankWorkflow(w.meId), id: "", created_at: "", updated_at: "" } as MkWorkflow));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  // a test: the e-mails to one address, seconds apart
  const [testTo, setTestTo] = useState("");
  const [testGap, setTestGap] = useState(10);
  const [testLane, setTestLane] = useState<WfLane>("none");
  const [testing, setTesting] = useState<{ until: number; n: number } | null>(null);
  const [testRes, setTestRes] = useState<{ error?: string; gap?: number; results?: { step: number; subject: string | null; ok: boolean; error: string | null }[] } | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setTestTo((v) => v || data.user?.email || "")); }, []);
  useEffect(() => { if (!testing) return; const t = window.setInterval(() => setTick((x) => x + 1), 500); return () => clearInterval(t); }, [testing]);
  const [events, setEvents] = useState<EvRow[]>([]);
  const [askDel, setAskDel] = useState(false);
  const saved = useRef(JSON.stringify(wf ?? null));
  const dirty = JSON.stringify(wf ? d : null) !== saved.current || !wf;
  const set = (p: Partial<MkWorkflow>) => setD((x) => ({ ...x, ...p }));
  const setTrig = (t: WfTrigger) => set({ trigger: t });
  useEffect(() => { if (msg?.tone !== "ok") return; const t = window.setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); }, [msg]);
  useEffect(() => {
    if (!wf) return;
    supabase.from("mk_workflow_events").select("*").eq("workflow_id", wf.id).order("created_at", { ascending: false }).limit(40)
      .then(({ data }: any) => setEvents((data ?? []) as EvRow[]));
  }, [wf]);

  const blocker = notReady(d, w, tpls);
  const save = async (patch: Partial<MkWorkflow> = {}): Promise<string | null> => {
    const row = { name: (d.name || "").trim() || autoName(d, w), trigger: d.trigger, flow: d.flow, sender_account: d.sender_account || null, from_address: d.from_address || null,
      owner_id: d.owner_id || null, status: d.status, updated_at: new Date().toISOString(), ...patch };
    const res = d.id ? await supabase.from("mk_workflows").update(row).eq("id", d.id).select("*").single() : await supabase.from("mk_workflows").insert(row).select("*").single();
    if (res.error) { setMsg({ tone: "err", text: MISSING.test(res.error.message) ? "Workflows need 149_mk_workflows.sql in Supabase." : res.error.message }); return null; }
    const nx = { ...(res.data as any), trigger: (res.data as any).trigger ?? {}, flow: (res.data as any).flow ?? [] } as MkWorkflow;
    setD(nx); saved.current = JSON.stringify(nx);
    return nx.id;
  };
  const doSave = async () => { setBusy("save"); const id = await save(); setBusy(null); if (id) { setMsg({ tone: "ok", text: "Saved" }); await onSaved(id); } };
  const runNow = async (id: string) => {
    const { data, error } = await supabase.functions.invoke("marketing-hub", { body: { action: "wf_run", id } });
    if (error || (data as any)?.error) return setMsg({ tone: "err", text: (data as any)?.error ?? error?.message ?? "It couldn't run now — it will on its own in a few minutes." });
    const s = data as any;
    const bits = [s.enrolled ? `${s.enrolled} started` : "", s.sent ? `${s.sent} e-mail${s.sent === 1 ? "" : "s"} sent` : "", s.tasks ? `${s.tasks} task${s.tasks === 1 ? "" : "s"}` : ""].filter(Boolean);
    setMsg({ tone: "ok", text: bits.length ? `Ran now: ${bits.join(" · ")}` : "Ran now: nothing new to do yet" });
  };
  const toggle = async () => {
    if (d.status === "active") { setBusy("toggle"); const id = await save({ status: "paused" }); setBusy(null); if (id) { setMsg({ tone: "ok", text: "Paused — nobody moves on until you switch it on again" }); await onSaved(id); } return; }
    if (blocker) { setMsg({ tone: "err", text: blocker }); return; }
    setBusy("toggle");
    const id = await save({ status: "active", ...(d.activated_at ? {} : { activated_at: new Date().toISOString() }) });
    // a dynamic list: read who's in it now (the people already in it start only with "Also the people already in it")
    if (id && d.trigger.kind === "list" && d.trigger.list_id && w.lists.find((l) => l.id === (d.trigger as any).list_id)?.kind === "dynamic") {
      await import("../mkListSync").then((m) => m.syncDynamicLists({ force: true, listId: (d.trigger as any).list_id })).catch(() => null);
    }
    if (id) { await runNow(id); await onSaved(id); }
    setBusy(null);
  };
  const del = async () => {
    if (!d.id) return onBack();
    setBusy("del");
    const { error } = await supabase.from("mk_workflows").delete().eq("id", d.id);
    setBusy(null);
    if (error) return setMsg({ tone: "err", text: error.message });
    w.toast("Workflow deleted"); await onDeleted();
  };

  // how each step is doing (by its place in the tree)
  const nodeStats = useMemo(() => {
    const o: Record<string, { sent: number; opened: number; replied: number; here: number }> = {};
    sends.forEach((s) => { if (s.status !== "sent" || !s.wf_node) return; const x = (o[s.wf_node] ??= { sent: 0, opened: 0, replied: 0, here: 0 }); x.sent++; if (s.opened_at) x.opened++; if (s.replied_at) x.replied++; });
    runs.forEach((r) => { if (r.status !== "active") return; const x = (o[r.node] ??= { sent: 0, opened: 0, replied: 0, here: 0 }); x.here++; });
    return o;
  }, [sends, runs]);
  const live = runs.filter((r) => r.status === "active").length;
  // the e-mail steps along the path a test follows, and whether there's a check to choose a lane for
  const testSteps = useMemo(() => {
    let n = 0, branch = false;
    const go = (list: WfNode[]): boolean => {
      for (const x of list) {
        if (x.type === "stop") return true;
        if (x.type === "email") n++;
        if (x.type === "branch") { branch = true; const l = x.paths?.[testLane] ?? []; if (l.length && go(l)) return true; }
      }
      return false;
    };
    go(d.flow);
    return { n, branch };
  }, [d.flow, testLane]);
  const runTest = async () => {
    const to = testTo.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { setTestRes({ error: "Write the e-mail address to send the test to." }); return; }
    if (!testSteps.n) { setTestRes({ error: "Add an e-mail step with a template first." }); return; }
    const gap = Math.max(0, Math.min(120, testGap || 0));
    const eff = testSteps.n > 1 && gap * (testSteps.n - 1) > 120 ? Math.floor(120 / (testSteps.n - 1)) : gap;
    setTestRes(null); setTesting({ until: Date.now() + eff * Math.max(0, testSteps.n - 1) * 1000 + 3000, n: testSteps.n });
    const { data, error } = await supabase.functions.invoke("marketing-hub", { body: { action: "wf_test", to, gap, lane: testLane, flow: d.flow,
      sender_account: d.sender_account || null, from_address: d.from_address || null, name: (d.name || "").trim() || autoName(d, w) } });
    setTesting(null);
    if (error || (data as any)?.error) { setTestRes({ error: (data as any)?.error ?? error?.message ?? "The test couldn't run." }); return; }
    setTestRes(data as any);
  };
  const sent = sends.filter((s) => s.status === "sent");

  return (
    <section className="mkw is-ed">
      <header className="mkw-head">
        <button type="button" className="mkw-back" onClick={onBack} aria-label="Back to the workflows"><Ico n="back" s={18} /></button>
        <span className="mkw-head-ico"><Ico n="flow" s={20} /></span>
        <input className="mkw-name" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={autoName(d, w)} aria-label="Workflow name" />
        {d.status !== "active" && <span className={`mkw-status is-${d.status}`}><i />{d.status === "paused" ? "Paused" : "Draft"}</span>}
        <span className="mkw-sp" />
        {msg && <span className={`mkw-msg is-${msg.tone}`}>{msg.tone === "ok" ? <Ico n="check" s={14} /> : <Ico n="warn" s={14} />}{msg.text}</span>}
        {askDel ? (
          <span className="mkw-ask">Delete it?<button type="button" className="is-danger" onClick={() => void del()} disabled={!!busy}>Delete</button><button type="button" onClick={() => setAskDel(false)}>Keep</button></span>
        ) : <button type="button" className="mkw-ghost is-ico" onClick={() => setAskDel(true)} aria-label="Delete this workflow" title="Delete"><Ico n="trash" s={15} /></button>}
        {d.status === "active" && d.id && <button type="button" className="mkw-ghost" onClick={async () => { setBusy("run"); if (dirty) await save(); await runNow(d.id); setBusy(null); }} disabled={!!busy}><Ico n="bolt" s={14} />Run now</button>}
        <button type="button" className="mkw-ghost" onClick={() => void doSave()} disabled={!!busy || (!dirty && !!d.id)}>{busy === "save" ? "Saving…" : dirty || !d.id ? "Save" : "Saved"}</button>
        <button type="button" className={`mkw-switch ${d.status === "active" ? "is-on" : ""}`} onClick={() => void toggle()} disabled={!!busy}
          title={d.status === "active" ? "Pause it" : blocker ?? "Switch it on: it starts with what happens from now"}>
          <i />{busy === "toggle" ? "…" : d.status === "active" ? "On" : "Switch on"}
        </button>
      </header>

      <div className="mkw-ed">
        <aside className="mkw-side">
          <TriggerCard t={d.trigger} onChange={setTrig} w={w} />
          <div className="mkw-box">
            <span className="mkw-box-k"><Ico n="send" s={14} />E-mails go from</span>
            <Select value={d.sender_account ?? ""} onChange={(v) => set({ sender_account: v || null })} placeholder="Choose an account…"
              options={[
                ...(w.outlookMail ? [{ value: "", label: w.outlookMail, hint: "Your Outlook" }] : []),
                ...w.accounts.map((a) => ({ value: a.id, label: a.email, hint: a.status === "error" ? "Sign in again in Integrations" : a.kind === "gmail" ? "Gmail" : a.kind === "ionos" ? "IONOS" : "Outlook", disabled: a.status === "error" })),
              ]} />
            {!w.outlookMail && !w.accounts.length && <button type="button" className="mkw-link" onClick={w.onConnect}>Connect Gmail, Outlook or IONOS →</button>}
            <input className="mkw-in" value={d.from_address ?? ""} onChange={(e) => set({ from_address: e.target.value })} placeholder="Another address of that mailbox (optional)" />
          </div>
          <div className="mkw-box is-test">
            <span className="mkw-box-k"><Ico n="bolt" s={14} />Test it</span>
            <p className="mkw-hint">Every e-mail of this workflow to one address, seconds apart instead of days — as it is now, saved or not.</p>
            <input className="mkw-in" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Send the test to…" aria-label="Test address" />
            <span className="mkw-test-gap">
              <NumInput type="number" min={0} max={120} value={testGap} onChange={(e) => setTestGap(Math.max(0, Math.min(120, Number(e.target.value) || 0)))} aria-label="Seconds between e-mails" />
              seconds between e-mails
            </span>
            {testSteps.branch && (
              <Select size="sm" value={testLane} onChange={(v) => setTestLane(v as WfLane)}
                options={LANES.map((l) => ({ value: l.k, label: `At a check: ${l.label.toLowerCase()}` }))} />
            )}
            <button type="button" className="mkw-test-go" onClick={() => void runTest()} disabled={!!testing}>
              <Ico n="send" s={14} />{testing ? `Sending… ${Math.max(0, Math.ceil((testing.until - Date.now()) / 1000))}s` : `Send ${testSteps.n || ""} test e-mail${testSteps.n === 1 ? "" : "s"}`}
            </button>
            {testRes?.error && <p className="mkw-test-res is-err">{testRes.error}</p>}
            {testRes?.results && (
              <ol className="mkw-test-res">
                {testRes.results.map((r) => (
                  <li key={r.step} className={r.ok ? "is-ok" : "is-err"}>
                    <Ico n={r.ok ? "check" : "warn"} s={13} />
                    <span><b>{r.subject ?? `E-mail ${r.step}`}</b>{r.ok ? "" : <em>{r.error}</em>}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="mkw-box">
            <span className="mkw-box-k"><Ico n="users" s={14} />Marketing owner</span>
            <Select value={d.owner_id ?? ""} onChange={(v) => set({ owner_id: v || null })} placeholder="Who looks after it"
              options={people.filter((p) => !p.former).map((p) => ({ value: p.id, label: p.name }))} searchable />
            <p className="mkw-hint">Tasks “for the marketing owner” go to this person.</p>
          </div>
          {d.id && (
            <div className="mkw-box is-figs">
              <span className="mkw-box-k"><Ico n="bolt" s={14} />How it's going</span>
              <div className="mkw-figs">
                <span><b>{fmtN(live)}</b>in progress</span>
                <span><b>{fmtN(runs.length - live)}</b>finished</span>
                <span><b>{fmtN(sent.length)}</b>e-mails</span>
                <span><b>{pct(sent.filter((s) => s.opened_at).length, sent.length)}</b>opened</span>
              </div>
              {d.last_run_at && <p className="mkw-hint">Last looked {ago(d.last_run_at)}{d.status === "active" ? " · every 5 minutes" : ""}</p>}
              {d.last_error && <p className="mkw-hint is-err"><Ico n="warn" s={12} />{d.last_error}</p>}
              {!!events.length && (
                <ol className="mkw-log">
                  {events.slice(0, 8).map((e) => <li key={e.id}><i className={`is-${e.kind}`} /><span>{evText(e)}</span><em>{ago(e.created_at)}</em></li>)}
                </ol>
              )}
            </div>
          )}
        </aside>

        <div className="mkw-canvas">
          <div className="mkw-start">
            <span className={`mkw-trig is-${d.trigger.kind ?? "none"}`}><Ico n={TRIG_ICO[d.trigger.kind ?? ""] ?? "bolt"} s={16} /></span>
            <span><em>Starts when</em><b>{triggerText(d.trigger, w)}</b></span>
            <span className="mkw-day">Day 0</span>
          </div>
          <FlowEditor nodes={d.flow} onChange={(flow) => set({ flow })} tpls={tpls} people={people} stats={nodeStats} onTemplates={async () => { if (dirty) await save(); w.onTemplates(); }} />
          {blocker && d.flow.length > 0 && <p className="mkw-note"><Ico n="warn" s={14} />{blocker}</p>}
        </div>
      </div>
    </section>
  );
}
const autoName = (d: Pick<MkWorkflow, "trigger">, w: WfWorld) => (d.trigger.kind ? `When ${triggerText(d.trigger, w).replace(/^./, (c) => c.toLowerCase())}` : "Untitled workflow");
function evText(e: EvRow): string {
  const x = e.detail ?? {};
  switch (e.kind) {
    case "enrol": return `${x.made ?? 0} started`;
    case "email": return `E-mailed ${x.to ?? ""}`;
    case "task": return `Task: ${x.title ?? ""}`;
    case "branch": return `Went to “${LANES.find((l) => l.k === x.lane)?.label ?? x.lane}”`;
    case "skip": return `Skipped an e-mail: ${x.reason ?? ""}`;
    case "error": return `Couldn't e-mail ${x.to ?? ""}: ${x.error ?? ""}`;
    case "end": return "Finished";
    case "failed": return `Stopped: ${x.error ?? "an error"}`;
    case "stopped": return "Stopped";
    default: return e.kind;
  }
}

/* ---------- what starts it ---------- */
function TriggerCard({ t, onChange, w }: { t: WfTrigger; onChange: (t: WfTrigger) => void; w: WfWorld }) {
  // what starts a workflow: someone joins a list, someone submits a form (a workflow made earlier on an e-mail
  // or a post keeps showing that choice so it can still be edited)
  const kinds: { k: "list" | "form" | "campaign" | "post"; label: string; hint: string }[] = [
    { k: "list", label: "Joins a list", hint: "someone is added to a list" },
    { k: "form", label: "Submits a form", hint: "someone sends one of your forms" },
    ...(t.kind === "campaign" ? [{ k: "campaign" as const, label: "E-mail", hint: "someone opens, clicks or replies" }] : []),
    ...(t.kind === "post" ? [{ k: "post" as const, label: "Post", hint: "a post goes out" }] : []),
  ];
  const camps = [...w.campaigns].filter((c) => c.status !== "draft" && c.status !== "cancelled")
    .sort((a, b) => (b.started_at ?? b.created_at).localeCompare(a.started_at ?? a.created_at));
  return (
    <div className="mkw-box is-trig">
      <span className="mkw-box-k"><Ico n="bolt" s={14} />Starts when</span>
      <div className="mkw-kinds" role="radiogroup" aria-label="What starts it" style={{ gridTemplateColumns: `repeat(${kinds.length}, minmax(0, 1fr))` }}>
        {kinds.map((k) => (
          <button type="button" key={k.k} role="radio" aria-checked={t.kind === k.k} title={`${k.label}: ${k.hint}`} className={`mkw-kind is-${k.k} ${t.kind === k.k ? "is-on" : ""}`}
            onClick={() => t.kind !== k.k && onChange(k.k === "campaign" ? { kind: "campaign", event: "opened", backfill: true } : k.k === "post" ? { kind: "post" } : k.k === "list" ? { kind: "list" } : { kind: "form" })}>
            <span><Ico n={TRIG_ICO[k.k]} s={16} /></span><b>{k.label}</b><i>{k.hint}</i>
          </button>
        ))}
      </div>
      {t.kind === "campaign" && (
        <div className="mkw-trig-f">
          <label><span>Campaign</span>
            <Select value={t.campaign_id ?? ""} onChange={(v) => onChange({ ...t, campaign_id: v })} placeholder="Pick a campaign…" searchable
              options={camps.map((c) => ({ value: c.id, label: c.name || c.subject || "Untitled", hint: c.status === "sent" ? `Sent ${c.started_at ? new Date(c.started_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}` : c.status === "scheduled" ? "Scheduled" : c.status === "sending" ? "Sending" : c.status }))} />
          </label>
          <label><span>When someone</span>
            <Select value={t.event ?? "opened"} onChange={(v) => onChange({ ...t, event: v as any })} options={EVENTS.map((e) => ({ value: e.value, label: e.label, hint: e.hint }))} />
          </label>
          {t.event === "not_opened" && (
            <label className="is-row"><span>within</span><NumInput type="number" min={1} value={t.days ?? 3} onChange={(e) => onChange({ ...t, days: Math.max(1, Number(e.target.value) || 1) })} /><span>days of getting it</span></label>
          )}
          <Check on={t.backfill !== false} onChange={(v) => onChange({ ...t, backfill: v })} label="Also the people who already did" />
        </div>
      )}
      {t.kind === "post" && (
        <div className="mkw-trig-f">
          <label><span>Post</span>
            <Select value={t.post_id ?? ""} onChange={(v) => onChange({ ...t, post_id: v || null })} searchable
              options={[{ value: "", label: "Any post", hint: "each one that goes out" }, ...w.posts.filter((p) => p.status === "published" || p.status === "scheduled")
                .sort((a, b) => (b.published_at ?? b.scheduled_at ?? "").localeCompare(a.published_at ?? a.scheduled_at ?? ""))
                .map((p) => ({ value: p.id, label: p.title || p.body.slice(0, 60) || "Untitled post", hint: p.status === "published" ? "Published" : "Scheduled" }))]} />
          </label>
          {!t.post_id && (
            <div className="mkw-nets">
              {w.nets.map((n) => {
                const on = (t.networks ?? []).includes(n.key);
                return <button type="button" key={n.key} className={on ? "is-on" : ""} style={{ ["--nc" as string]: n.color } as CSSProperties}
                  onClick={() => onChange({ ...t, networks: on ? (t.networks ?? []).filter((x) => x !== n.key) : [...(t.networks ?? []), n.key] })}>{n.label}</button>;
              })}
              <i>{(t.networks ?? []).length ? "only these networks" : "every network"}</i>
            </div>
          )}
          <label><span>Who it's for</span>
            <Select value={t.list_id ?? ""} onChange={(v) => onChange({ ...t, list_id: v || null })} searchable
              options={[{ value: "", label: "Just the team", hint: "tasks, no e-mails" },
                ...w.lists.map((l) => ({ value: l.id, label: l.name, hint: l.kind === "static" ? `${fmtN(l.member_count ?? 0)} · fixed list` : "Save it as fixed to use it", disabled: l.kind !== "static" }))]} />
          </label>
          <Check on={!!t.backfill} onChange={(v) => onChange({ ...t, backfill: v })} label="Also posts that already went out" />
        </div>
      )}
      {t.kind === "form" && (
        <div className="mkw-trig-f">
          <label><span>Form</span>
            <Select value={t.form_id ?? ""} onChange={(v) => onChange({ ...t, form_id: v || null })} searchable
              options={[{ value: "", label: "Any form" }, ...w.forms.map((f) => ({ value: f.id, label: f.name, hint: f.status === "live" ? "Live" : f.status === "closed" ? "Closed" : "Draft" }))]} />
          </label>
          <Check on={!!t.backfill} onChange={(v) => onChange({ ...t, backfill: v })} label="Also the answers that came in before" />
        </div>
      )}
      {t.kind === "list" && (
        <div className="mkw-trig-f">
          <label><span>List</span>
            <Select value={t.list_id ?? ""} onChange={(v) => onChange({ ...t, list_id: v || null })} placeholder="Pick a list…" searchable
              options={w.lists.map((l) => ({ value: l.id, label: l.name, hint: l.kind === "static" ? `${fmtN(l.member_count ?? 0)} · fixed list` : `${fmtN(l.member_count ?? 0)} · dynamic list` }))} />
          </label>
          <p className="mkw-trig-note">{w.lists.find((l) => l.id === t.list_id)?.kind === "dynamic"
            ? "Starts for each person who comes into it: whenever a contact, company or deal changes and the list's rules take someone new in, or you change the rules (checked on the server every 5 minutes, even with Next closed). Someone who leaves the list and comes back starts again."
            : "Starts for each person added to it — by hand, an import, or a form that adds people to this list."}</p>
          <Check on={!!t.backfill} onChange={(v) => onChange({ ...t, backfill: v })} label="Also the people already in it" />
        </div>
      )}
    </div>
  );
}
const Check = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button type="button" role="checkbox" aria-checked={on} className={`mkw-check ${on ? "is-on" : ""}`} onClick={() => onChange(!on)}><i><Ico n="check" s={11} /></i>{label}</button>
);

/* ---------- the steps ---------- */
const KINDS: { k: WfNode["type"]; label: string; hint: string }[] = [
  { k: "email", label: "E-mail", hint: "Send one of your templates" },
  { k: "branch", label: "Wait & check", hint: "Go one way or another by what they did with the e-mail" },
  { k: "task", label: "Task", hint: "Someone in the team does something" },
  { k: "stop", label: "End", hint: "Nothing more after this" },
];
function FlowEditor({ nodes, onChange, tpls, people, stats, onTemplates }: {
  nodes: WfNode[]; onChange: (n: WfNode[]) => void; tpls: Tpl[]; people: Employee[];
  stats: Record<string, { sent: number; opened: number; replied: number; here: number }>; onTemplates: () => void;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    if (!adding) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setAdding(null); } };
    const off = (e: MouseEvent) => { if (!(e.target as Element).closest?.(".mkw-add-menu, .mkw-ins, .mkw-lane-add, .mkw-first")) setAdding(null); };
    window.addEventListener("keydown", k, true); document.addEventListener("mousedown", off);
    return () => { window.removeEventListener("keydown", k, true); document.removeEventListener("mousedown", off); };
  }, [adding]);
  const days = flowDays(nodes as any);
  const firstTpl = (() => { let t = ""; walk(nodes, (n) => { if (!t && n.type === "email" && n.template_id) t = n.template_id; }); return t || tpls[0]?.id || ""; })();
  const tplOpts = [...tpls.map((t) => ({ value: t.id, label: t.name, hint: t.subject || undefined })), { value: "__new", label: "+ New template…", hint: "in E-mail › Templates" }];
  const whoOpts = [
    { value: "owner", label: "The marketing owner", hint: "of this workflow" },
    { value: "contact", label: "The person's owners", hint: "assigned to the contact" },
    { value: "creator", label: "Whoever made the workflow" },
    ...people.filter((p) => !p.former).map((p) => ({ value: p.id, label: p.name })),
  ];
  const setNode = (lp: Path, i: number, p: Partial<WfNode>) => onChange(withList(nodes, lp, (xs) => xs.map((n, k) => (k === i ? { ...n, ...p } : n))));
  const move = (lp: Path, i: number, dlt: -1 | 1) => onChange(withList(nodes, lp, (xs) => { const ys = [...xs]; const j = i + dlt; if (j < 0 || j >= ys.length) return xs; [ys[i], ys[j]] = [ys[j], ys[i]]; return ys; }));
  const drop = (lp: Path, i: number) => onChange(withList(nodes, lp, (xs) => xs.filter((_, k) => k !== i)));
  const addAt = (lp: Path, at: number, kind: WfNode["type"]) => {
    const n = newNode(kind, firstTpl, !lp.length && at === 0);
    onChange(withList(nodes, lp, (xs) => (kind === "stop" ? [...xs.slice(0, at), n] : [...xs.slice(0, at), n, ...xs.slice(at)])));
    setAdding(null);
  };
  const menu = (lp: Path, at: number, len: number) => {
    if (adding !== `${ptrOf(lp)}@${at}`) return null;
    const before = listAt(nodes, [...lp, 0]).slice(0, at);
    const noMail = !lp.length && !before.some((x) => x.type === "email");
    return (
      <div className="mkw-add-menu" role="menu" aria-label="Add a step">
        {KINDS.map((k) => {
          const off = (k.k === "branch" && noMail) || (k.k === "stop" && at < len);
          return (
            <button key={k.k} type="button" role="menuitem" disabled={off} onClick={() => addAt(lp, at, k.k)} title={off ? (k.k === "stop" ? "An end goes last" : "Put an e-mail before a check") : undefined}>
              <span className={`mkw-tile is-${k.k}`}><Ico n={KIND_ICO[k.k]} s={15} /></span><span><b>{k.label}</b><i>{k.hint}</i></span>
            </button>
          );
        })}
      </div>
    );
  };
  const when = (r: CsDayRange | undefined) => (r ? <span className="mkw-day" title={r.lo === r.hi ? undefined : "Depends on when they reply"}>{dayText(r)}</span> : null);
  const tools = (lp: Path, i: number, len: number) => (
    <span className="mkw-tools">
      <button type="button" disabled={i === 0} onClick={() => move(lp, i, -1)} aria-label="Move earlier" title="Earlier"><Ico n="up" s={13} /></button>
      <button type="button" disabled={i === len - 1} onClick={() => move(lp, i, 1)} aria-label="Move later" title="Later"><Ico n="dn" s={13} /></button>
      <button type="button" className="is-del" onClick={() => drop(lp, i)} aria-label="Remove this step" title="Remove"><Ico n="trash" s={13} /></button>
    </span>
  );
  const waitIn = (n: WfNode, lp: Path, i: number, verb: string, from: string) => {
    const v = Math.max(0, Number(n.wait_days) || 0);
    return (
      <span className={`mkw-wait ${v ? "" : "is-now"}`}>
        <Ico n="clock" s={13} />{verb}
        <NumInput type="number" min={0} value={v} onChange={(e) => setNode(lp, i, { wait_days: Math.max(0, Number(e.target.value) || 0) })} aria-label="Days after" />
        day{v === 1 ? "" : "s"} after {from}{v ? "" : " (same day)"}
      </span>
    );
  };

  const renderList = (lp: Path, lane: WfLane | null): ReactNode => {
    const list = listAt(nodes, [...lp, 0]);
    const top = !lp.length;
    const ended = list[list.length - 1]?.type === "stop";
    const endKey = `${ptrOf(lp)}@${list.length}`;
    return (
      <ol className={`mkw-list ${top ? "is-top" : "is-lane"}`}>
        {list.map((n, i) => {
          const path: Path = [...lp, i];
          const ptr = ptrOf(path);
          const st = stats[ptr];
          const insKey = `${ptrOf(lp)}@${i}`;
          const from = i > 0 ? "the step before" : top ? "it starts" : lane === "replied" ? "they reply" : "the check";
          return (
            <li key={n.id ?? i} className={`mkw-item is-${n.type}`}>
              <div className={`mkw-gap ${adding === insKey ? "is-open" : ""}`}>
                <button type="button" className="mkw-ins" onClick={() => setAdding(adding === insKey ? null : insKey)} aria-label="Add a step here" title="Add a step here"><Ico n="plus" s={12} /></button>
                {menu(lp, i, list.length)}
              </div>
              <div className="mkw-row">
                <span className={`mkw-tile is-${n.type}`}><Ico n={KIND_ICO[n.type]} s={n.type === "stop" ? 13 : 16} /></span>
                {n.type === "email" && (
                  <div className="mkw-step is-email">
                    <div className="mkw-step-h">
                      <b>E-mail</b>{st?.here ? <span className="mkw-here">{st.here} waiting</span> : null}
                      <span className="mkw-sp" />{when(days.at[ptr])}{tools(lp, i, list.length)}
                    </div>
                    {waitIn(n, lp, i, "Sent", from)}
                    <Select value={n.template_id ?? ""} onChange={(v) => (v === "__new" ? onTemplates() : setNode(lp, i, { template_id: v }))} placeholder="Pick a template…" searchable options={tplOpts} />
                    {!(top && i === 0) && (
                      <div className={`mkw-thread ${n.thread ? "is-on" : ""}`}>
                        <Check on={!!n.thread} onChange={(v) => setNode(lp, i, { thread: v || undefined })} label="Send as a reply to the previous e-mail" />
                        {n.thread && <em>It arrives in the same conversation as the one before (Outlook, Gmail…), as “RE: subject of the first one”, with the earlier e-mails quoted below. The template's own subject isn't used.</em>}
                      </div>
                    )}
                    {st?.sent ? <span className="mkw-step-figs"><em>{fmtN(st.sent)} sent</em><em>{pct(st.opened, st.sent)} opened</em><em>{fmtN(st.replied)} replied</em></span> : null}
                  </div>
                )}
                {n.type === "task" && (
                  <div className="mkw-step is-task">
                    <div className="mkw-step-h"><b>Task</b>{st?.here ? <span className="mkw-here">{st.here} waiting</span> : null}<span className="mkw-sp" />{when(days.at[ptr])}{tools(lp, i, list.length)}</div>
                    {waitIn(n, lp, i, "Made", from)}
                    <ChipField value={n.title ?? ""} onChange={(v) => setNode(lp, i, { title: v })} placeholder="What to do, e.g. Call {{full_name}}" groups={WF_GROUPS} names={WF_FIELDS} label="Task" />
                    <div className="mkw-two">
                      <Select size="sm" value={n.assign ?? "owner"} onChange={(v) => setNode(lp, i, { assign: v })} options={whoOpts} searchable />
                      <span className="mkw-due">due in<NumInput type="number" min={0} value={n.due_days ?? 2} onChange={(e) => setNode(lp, i, { due_days: Math.max(0, Number(e.target.value) || 0) })} aria-label="Due in days" />days</span>
                    </div>
                    <textarea className="mkw-notes" rows={2} value={n.notes ?? ""} onChange={(e) => setNode(lp, i, { notes: e.target.value })} placeholder="Notes for whoever does it (optional)" />
                  </div>
                )}
                {n.type === "stop" && (
                  <div className="mkw-step is-stop"><div className="mkw-step-h"><b>End</b><span className="mkw-hint">nothing more after this</span><span className="mkw-sp" />{tools(lp, i, list.length)}</div></div>
                )}
                {n.type === "branch" && (
                  <div className="mkw-step is-branch">
                    <div className="mkw-step-h">
                      <b>Wait & check</b><span className="mkw-sp" />{when(days.at[ptr])}{tools(lp, i, list.length)}
                    </div>
                    <span className="mkw-wait"><Ico n="clock" s={13} />Wait up to
                      <NumInput type="number" min={0} value={n.days ?? 3} onChange={(e) => setNode(lp, i, { days: Math.max(0, Number(e.target.value) || 0) })} aria-label="Days to wait" />
                      days for the e-mail before it — a reply goes on at once
                    </span>
                    <div className="mkw-lanes">
                      {LANES.map((l) => {
                        const lpL: Path = [...path, l.k];
                        const r = days.lane[`${ptr}/${l.k}`];
                        const ln = (n.paths?.[l.k] ?? []).length;
                        const k = `${ptrOf(lpL)}@${ln}`;
                        return (
                          <div key={l.k} className={`mkw-lane is-${l.k}`}>
                            <span className="mkw-lane-h" title={l.hint}><Ico n={LANE_ICO[l.k]} s={13} /><b>{l.label}</b>{r && <em>{dayText(r)}</em>}</span>
                            {ln ? renderList(lpL, l.k) : <p className="mkw-lane-none">Carries on below</p>}
                            {(n.paths?.[l.k] ?? [])[ln - 1]?.type !== "stop" && (
                              <div className="mkw-lane-foot">
                                <button type="button" className="mkw-lane-add" onClick={() => setAdding(adding === k ? null : k)}><Ico n="plus" s={12} />Step</button>
                                {menu(lpL, ln, ln)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
        {top && (
          <li className="mkw-item is-end">
            {!ended && (
              <div className={`mkw-gap is-last ${adding === endKey ? "is-open" : ""}`}>
                <button type="button" className={`mkw-ins ${!list.length ? "mkw-first" : ""}`} onClick={() => setAdding(adding === endKey ? null : endKey)}>
                  <Ico n="plus" s={12} />{!list.length && <span>Add the first step</span>}
                </button>
                {menu(lp, list.length, list.length)}
              </div>
            )}
            {!!list.length && <div className="mkw-row is-fin"><span className="mkw-tile is-fin"><Ico n="check" s={13} /></span><span className="mkw-fin">Done{days.end ? ` · ${dayText(days.end)}` : ""}</span></div>}
          </li>
        )}
      </ol>
    );
  };
  return <div className="mkw-flow">{renderList([], null)}</div>;
}
