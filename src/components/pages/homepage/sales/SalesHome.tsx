/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home · SALES — the whole page, laid out like the consultancy home:
 *   hero    greeting and four sales figures of your choice (Customize)
 *   left    your calendar, and under it the pipeline by stage (the department's
 *           when you see the team, yours otherwise)
 *   middle  the ticket desk (to-do + tickets)
 *   right   deals about to close (and, for those who see the team, the team),
 *           then the deals that need attention: overdue, stuck in a stage,
 *           gone quiet, without a close date, with late tasks
 * A rep sees their own deals (owner or on the deal's team); the boss and the
 * sales managers see everyone's.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode, type Ref } from "react";
import { useNavigate } from "react-router-dom";
import Select from "../../../framework/Select";
import { supabase } from "../../../api/supabase";
import { listTrackings, loadTrackingTeams, loadPotentialTotals, type Tracking } from "../../sales/sales/salesApi";
import { listPipelines, loadPhasesByPipeline, type Phase, type Pipeline } from "../../settings/pipelineApi";
import { listCompanies, loadPrefs, savePref } from "../../companies/companiesApi";
import { ClientLogo } from "../../clients/ClientWorkspace";
import { CAL_SUMMARY_EVENT, isoDay, type CalSummary } from "../shared/HomeCalendar";
import { TICKETS_EVENT } from "../shared/HomeTodo";
import { useCount, Ring, HeroPicker, Fig, Txt } from "../consultancy/ConsultancyHome";
import "../consultancy/ConsultancyHome.css";
import "./SalesHome.css";

const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const short = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : eur(n));
const dayMs = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((new Date(b.slice(0, 10) + "T00:00:00").getTime() - new Date(a.slice(0, 10) + "T00:00:00").getTime()) / dayMs);
const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((x) => x[0]).join("").slice(0, 2).toUpperCase() || "?";

/* how long before a deal counts as stuck in its stage / gone quiet; how far "about to close" looks */
const STUCK_DAYS = 30;
const QUIET_DAYS = 21;
const SOON_DAYS = 30;
const CLOSE_WINDOW = 45;
/** a close date further back than this: an old, parked deal, not one to chase today */
const OVERDUE_REACH = 180;
/** the longest list drawn at once (the rest is one click away in Sales) */
const LIST_CAP = 40;

interface Props {
  userId: string;
  seesTeam: boolean;
  calendar: ReactNode;
  desk: ReactNode;
  greeting: string;
  firstName: string | null;
  heroRef?: Ref<HTMLElement>;
  alertsBell?: ReactNode;
}

/* ---------------- the figures the top row can show ---------------- */
type SKey = "pipeline" | "weighted" | "won_month" | "closing" | "winrate" | "attention" | "new_month" | "avg_won" | "booked" | "tickets" | "tasks";
const SALES_KPIS: { key: SKey; group: string; label: string }[] = [
  { key: "pipeline", group: "Pipeline", label: "Open pipeline" },
  { key: "weighted", group: "Pipeline", label: "Weighted forecast" },
  { key: "closing", group: "Pipeline", label: "Closing in 30 days" },
  { key: "attention", group: "Pipeline", label: "Deals that need attention" },
  { key: "new_month", group: "Pipeline", label: "New deals this month" },
  { key: "won_month", group: "Results", label: "Won this month" },
  { key: "winrate", group: "Results", label: "Win rate (90 days)" },
  { key: "avg_won", group: "Results", label: "Average won deal" },
  { key: "booked", group: "You", label: "Booked today" },
  { key: "tickets", group: "You", label: "Open tickets" },
  { key: "tasks", group: "You", label: "Open tasks" },
];
const SALES_DEFAULT: SKey[] = ["pipeline", "weighted", "won_month", "closing"];
const SALES_PREF = "homeHeroKpisSales";
const isSKey = (k: unknown): k is SKey => SALES_KPIS.some((x) => x.key === k);

type Why = "overdue" | "stuck" | "quiet" | "nodate" | "tasks";
const WHY: Record<Why, { label: string; tone: "warn" | "amber" | "mute" }> = {
  overdue: { label: "Overdue", tone: "warn" },
  tasks: { label: "Late tasks", tone: "warn" },
  stuck: { label: "Stuck", tone: "amber" },
  quiet: { label: "Quiet", tone: "amber" },
  nodate: { label: "No date", tone: "mute" },
};
const WHY_ORDER: Why[] = ["overdue", "tasks", "stuck", "quiet", "nodate"];
interface Flag { why: Why; text: string }

export default function SalesHome({ userId, seesTeam, calendar, desk, greeting, firstName, heroRef, alertsBell }: Props) {
  const nav = useNavigate();
  const today = isoDay(new Date());
  const [loading, setLoading] = useState(true);
  const [deals, setDeals] = useState<Tracking[]>([]);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [pipes, setPipes] = useState<Pipeline[]>([]);
  const [phases, setPhases] = useState<Record<string, Phase[]>>({});
  const [companies, setCompanies] = useState<Record<string, string>>({});
  const [people, setPeople] = useState<Record<string, string>>({});
  /** when each deal entered the stage it is in now */
  const [inStage, setInStage] = useState<Record<string, string>>({});
  /** the last note written on each deal */
  const [lastNote, setLastNote] = useState<Record<string, string>>({});
  /** late open tasks per deal */
  const [lateTasks, setLateTasks] = useState<Record<string, number>>({});
  const [pipeSel, setPipeSel] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"closing" | "team">("closing");
  const [whyFilter, setWhyFilter] = useState<Why | "all">("all");

  useEffect(() => {
    let alive = true;
    const all = listTrackings().catch(() => [] as Tracking[]);
    const rows = (q: PromiseLike<any>) => Promise.resolve(q).then((r: any) => (r?.error ? [] : r?.data ?? []), () => []);
    Promise.all([
      all,
      loadTrackingTeams().catch(() => ({ members: {} as Record<string, string[]>, owners: {} as Record<string, string> })),
      loadPotentialTotals({ trackings: all }).catch(() => ({} as Record<string, number>)),
      listPipelines().catch(() => [] as Pipeline[]),
      loadPhasesByPipeline().catch(() => ({} as Record<string, Phase[]>)),
      listCompanies().catch(() => [] as any[]),
      rows(supabase.from("profiles").select("id, first_name, last_name, email")),
      rows(supabase.from("tracking_phase_events").select("tracking_id, phase_id, entered_at").range(0, 49999)),
      rows(supabase.from("tracking_notes").select("tracking_id, created_at").range(0, 49999)),
      rows(supabase.from("tracking_tasks").select("tracking_id, done, status, due_at").range(0, 49999)),
    ]).then(([ts, team, pt, ps, ph, cos, profs, evs, notes, tks]) => {
      if (!alive) return;
      const mine = seesTeam ? ts : ts.filter((t) => team.owners[t.id] === userId || (team.members[t.id] ?? []).includes(userId));
      setDeals(mine);
      setOwners(team.owners);
      setTotals(pt);
      const sales = ps.filter((p) => p.is_sales);
      setPipes(sales);
      setPhases(ph);
      setCompanies(Object.fromEntries((cos as any[]).map((c) => [c.id, c.name])));
      setPeople(Object.fromEntries((profs as any[]).map((p) => [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "—"])));
      const cur = new Map(mine.map((t) => [t.id, t.current_phase_id]));
      const enter: Record<string, string> = {};
      (evs as any[]).forEach((e) => {
        if (!cur.has(e.tracking_id) || cur.get(e.tracking_id) !== e.phase_id || !e.entered_at) return;
        if (!enter[e.tracking_id] || e.entered_at > enter[e.tracking_id]) enter[e.tracking_id] = e.entered_at;
      });
      setInStage(enter);
      const last: Record<string, string> = {};
      (notes as any[]).forEach((n) => { if (n.tracking_id && n.created_at && (!last[n.tracking_id] || n.created_at > last[n.tracking_id])) last[n.tracking_id] = n.created_at; });
      setLastNote(last);
      const now = Date.now(), late: Record<string, number> = {};
      (tks as any[]).forEach((k) => {
        if (!k.tracking_id || k.done || k.status === "done" || !k.due_at || new Date(k.due_at).getTime() >= now) return;
        late[k.tracking_id] = (late[k.tracking_id] ?? 0) + 1;
      });
      setLateTasks(late);
      // the pipeline with the most open deals first
      const count = (id: string) => mine.filter((t) => t.pipeline_id === id && t.status === "active").length;
      setPipeSel([...sales].sort((a, b) => count(b.id) - count(a.id))[0]?.id ?? null);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [userId, seesTeam]);

  /* ---- your figures on top: saved with your profile ---- */
  const [slots, setSlots] = useState<SKey[]>(SALES_DEFAULT);
  const [picker, setPicker] = useState<DOMRect | null>(null);
  useEffect(() => {
    loadPrefs().then((p) => {
      const v = p?.[SALES_PREF];
      if (Array.isArray(v)) { const ks = v.filter(isSKey).slice(0, 4); if (ks.length === 4) setSlots(ks); }
    }).catch(() => {});
  }, []);
  const changeSlots = (next: SKey[]) => { setSlots(next); savePref(SALES_PREF, next).catch(() => {}); };

  /* ---- today's load (from the calendar card) and your open tickets / tasks ---- */
  const [cal, setCal] = useState<CalSummary | null>(null);
  useEffect(() => {
    const on = (e: Event) => setCal((e as CustomEvent<CalSummary>).detail);
    window.addEventListener(CAL_SUMMARY_EVENT, on);
    return () => window.removeEventListener(CAL_SUMMARY_EVENT, on);
  }, []);
  type Tix = { open: number; late: number };
  const [tix, setTix] = useState<Tix | null>(null);
  const [tasks, setTasks] = useState<Tix | null>(null);
  const wantsTix = slots.includes("tickets") || slots.includes("tasks");
  useEffect(() => {
    if (!wantsTix) return;
    let alive = true;
    const load = async () => {
      let r: any = await supabase.from("tracking_tasks").select("id, done, status, stage, due_at, source, requester_email, requester_name, category").eq("assignee_id", userId).range(0, 4999);
      if (r.error) r = await supabase.from("tracking_tasks").select("id, done, status, due_at").eq("assignee_id", userId).range(0, 4999);
      if (!alive || r.error) return;
      const now = Date.now();
      const open = ((r.data ?? []) as any[]).filter((t) => !(t.done || t.status === "done" || ["resolved", "closed"].includes(t.stage)));
      const isTicket = (t: any) => (t.category ? t.category === "ticket" : ["email", "phone", "portal", "message"].includes(t.source) || !!t.requester_email || !!t.requester_name);
      const tally = (xs: any[]): Tix => ({ open: xs.length, late: xs.filter((t) => t.due_at && new Date(t.due_at).getTime() < now).length });
      setTix(tally(open.filter(isTicket)));
      setTasks(tally(open.filter((t) => !isTicket(t))));
    };
    load().catch(() => {});
    const again = () => { load().catch(() => {}); };
    window.addEventListener(TICKETS_EVENT, again);
    return () => { alive = false; window.removeEventListener(TICKETS_EVENT, again); };
  }, [userId, wantsTix]);

  /* ---- reading the deals ---- */
  const titleOf = (t: Tracking) => (t.deal_name ?? "").trim() || (t.company_id ? companies[t.company_id] : "") || "Deal";
  const companyOf = (t: Tracking) => (t.company_id ? companies[t.company_id] ?? "" : "");
  const phaseOf = (t: Tracking) => (phases[t.pipeline_id ?? ""] ?? []).find((p) => p.id === t.current_phase_id) ?? null;
  const closeOf = (t: Tracking) => t.mgr_close_date || t.rep_close_date || null;
  const probOf = (t: Tracking) => {
    const p = t.mgr_close_prob ?? t.rep_close_prob ?? phaseOf(t)?.close_probability ?? null;
    return p == null ? 0 : Math.max(0, Math.min(100, Number(p)));
  };
  const valueOf = (t: Tracking) => totals[t.id] ?? 0;
  const ownerOf = (t: Tracking) => (owners[t.id] ? people[owners[t.id]] ?? "" : "");
  const open = (t: Tracking) => nav(`/sales?tracking=${t.id}`);

  const active = useMemo(() => deals.filter((t) => t.status === "active"), [deals]);
  const ym = today.slice(0, 7);
  const lastYm = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return isoDay(d).slice(0, 7); })();
  const fig = useMemo(() => {
    const inPlay = active.reduce((s, t) => s + valueOf(t), 0);
    const weighted = active.reduce((s, t) => s + valueOf(t) * (probOf(t) / 100), 0);
    const closing = active.filter((t) => { const d = closeOf(t); if (!d) return false; const n = daysBetween(today, d); return n >= 0 && n <= SOON_DAYS; });
    const wonIn = (m: string) => deals.filter((t) => t.status === "won" && (t.close_date ?? "").slice(0, 7) === m);
    const wonNow = wonIn(ym), wonLast = wonIn(lastYm);
    const since90 = isoDay(new Date(Date.now() - 90 * dayMs));
    const closed90 = deals.filter((t) => (t.status === "won" || t.status === "lost") && (t.close_date ?? "") >= since90);
    const won90 = closed90.filter((t) => t.status === "won").length;
    const since365 = isoDay(new Date(Date.now() - 365 * dayMs));
    const wonYear = deals.filter((t) => t.status === "won" && (t.close_date ?? "") >= since365);
    const newNow = deals.filter((t) => (t.created_at ?? "").slice(0, 7) === ym);
    return {
      inPlay, weighted, open: active.length,
      closing: closing.length, closingValue: closing.reduce((s, t) => s + valueOf(t), 0),
      wonValue: wonNow.reduce((s, t) => s + valueOf(t), 0), wonCount: wonNow.length, wonLast: wonLast.reduce((s, t) => s + valueOf(t), 0),
      winRate: closed90.length ? (won90 / closed90.length) * 100 : null, closed90: closed90.length,
      avgWon: wonYear.length ? wonYear.reduce((s, t) => s + valueOf(t), 0) / wonYear.length : 0, wonYear: wonYear.length,
      newCount: newNow.length, newValue: newNow.reduce((s, t) => s + valueOf(t), 0),
    };
  }, [active, deals, totals, phases, today]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- pipeline by stage ---- */
  const stages = useMemo(() => {
    const list = (phases[pipeSel ?? ""] ?? []).filter((p) => !p.sales_outcome && p.sales_visible !== false);
    return list.map((p) => {
      const here = active.filter((t) => t.current_phase_id === p.id);
      const ages = here.map((t) => (inStage[t.id] ? daysBetween(inStage[t.id], today) : null)).filter((x): x is number => x != null);
      return {
        id: p.id, name: p.name, color: p.color || null, prob: p.close_probability ?? null,
        count: here.length, value: here.reduce((s, t) => s + valueOf(t), 0),
        age: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null,
        stuck: here.filter((t) => inStage[t.id] && daysBetween(inStage[t.id], today) > STUCK_DAYS).length,
      };
    });
  }, [phases, pipeSel, active, totals, inStage, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const stageMax = Math.max(1, ...stages.map((s) => s.value));
  const pipeTotal = stages.reduce((s, x) => s + x.value, 0);
  const pipeCount = stages.reduce((s, x) => s + x.count, 0);

  /* ---- about to close ---- */
  const closing = useMemo(() => active
    .map((t) => ({ t, d: closeOf(t) as string | null }))
    .filter((x): x is { t: Tracking; d: string } => !!x.d && daysBetween(today, x.d) >= 0 && daysBetween(today, x.d) <= CLOSE_WINDOW)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : valueOf(b.t) - valueOf(a.t))), [active, today, totals]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- the team (who owns what) ---- */
  const teamRows = useMemo(() => {
    if (!seesTeam) return [];
    const by = new Map<string, { id: string; name: string; pipe: number; deals: number; won: number; wonCount: number }>();
    const row = (id: string) => { if (!by.has(id)) by.set(id, { id, name: people[id] ?? "—", pipe: 0, deals: 0, won: 0, wonCount: 0 }); return by.get(id)!; };
    deals.forEach((t) => {
      const o = owners[t.id];
      if (!o) return;
      if (t.status === "active") { const r = row(o); r.pipe += valueOf(t); r.deals += 1; }
      if (t.status === "won" && (t.close_date ?? "").slice(0, 7) === ym) { const r = row(o); r.won += valueOf(t); r.wonCount += 1; }
    });
    return [...by.values()].sort((a, b) => b.won - a.won || b.pipe - a.pipe);
  }, [seesTeam, deals, owners, people, totals, ym]); // eslint-disable-line react-hooks/exhaustive-deps
  const teamMax = Math.max(1, ...teamRows.map((r) => r.pipe));

  /* ---- what needs attention ----
     Only deals in play: past the first ~40% of their pipeline's stages (qualified, not
     just a lead or a company on a list), or with a close date that is recent or ahead.
     Hundreds of old leads would otherwise drown the few deals worth chasing. */
  const inPlay = useMemo(() => {
    const idx = new Map<string, { i: number; n: number }>();
    Object.values(phases).forEach((list) => {
      const open = list.filter((p) => !p.sales_outcome);
      open.forEach((p, i) => idx.set(p.id, { i, n: open.length }));
    });
    return (t: Tracking) => {
      const d = closeOf(t);
      if (d && daysBetween(today, d) >= -OVERDUE_REACH) return true;
      const at = idx.get(t.current_phase_id ?? "");
      return !!at && at.n > 0 && at.i >= Math.ceil(at.n * 0.4);
    };
  }, [phases, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const attention = useMemo(() => active.filter(inPlay).map((t) => {
    const flags: Flag[] = [];
    const d = closeOf(t);
    if (!d) flags.push({ why: "nodate", text: "No close date" });
    else { const n = daysBetween(today, d); if (n < 0) flags.push({ why: "overdue", text: `${-n}d overdue` }); }
    if (lateTasks[t.id]) flags.push({ why: "tasks", text: `${lateTasks[t.id]} late ${lateTasks[t.id] === 1 ? "task" : "tasks"}` });
    if (inStage[t.id]) { const n = daysBetween(inStage[t.id], today); if (n > STUCK_DAYS) flags.push({ why: "stuck", text: `${n}d in ${phaseOf(t)?.name ?? "stage"}` }); }
    const lastTouch = lastNote[t.id] ?? t.created_at ?? null;
    if (lastTouch) { const n = daysBetween(lastTouch, today); if (n > QUIET_DAYS) flags.push({ why: "quiet", text: `Quiet ${n}d` }); }
    flags.sort((a, b) => WHY_ORDER.indexOf(a.why) - WHY_ORDER.indexOf(b.why));
    return { t, flags, rank: flags.length ? WHY_ORDER.indexOf(flags[0].why) : 9 };
  }).filter((x) => x.flags.length).sort((a, b) => a.rank - b.rank || valueOf(b.t) - valueOf(a.t)),
  [active, inPlay, today, lateTasks, inStage, lastNote, totals, phases]); // eslint-disable-line react-hooks/exhaustive-deps
  const whyCount = (w: Why) => attention.filter((a) => a.flags.some((f) => f.why === w)).length;
  const shown = whyFilter === "all" ? attention : attention.filter((a) => a.flags.some((f) => f.why === whyFilter));
  const overdue = whyCount("overdue");

  /* ---- the hero ---- */
  const cPipe = useCount(loading ? 0 : fig.inPlay);
  const cWeighted = useCount(loading ? 0 : fig.weighted);
  const cWon = useCount(loading ? 0 : fig.wonValue);
  const cClosing = useCount(loading ? 0 : fig.closing, 600);
  const cToday = useCount(cal?.todayMin ?? 0, 700);
  const dateLabel = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const glow = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  const wait = loading ? "…" : null;
  const meter = (v: number, goal: number) => <span className="chx-meter"><i style={{ width: `${goal > 0 ? Math.min(100, (v / goal) * 100) : 0}%` }} /></span>;
  const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long" });
  const heroFig = (k: SKey): ReactNode => {
    const toSales = () => nav("/sales");
    switch (k) {
      case "pipeline": return (
        <Fig onClick={toSales} title="Open Sales">
          <Txt label={seesTeam ? "Team open pipeline" : "Your open pipeline"} value={wait ?? `${eur(cPipe)} €`} sub={`${fig.open} open ${fig.open === 1 ? "deal" : "deals"}`} />
        </Fig>
      );
      case "weighted": return (
        <Fig onClick={toSales} title="Open Sales">
          <Txt label="Weighted forecast" value={wait ?? `${eur(cWeighted)} €`} sub={fig.inPlay ? `${Math.round((fig.weighted / fig.inPlay) * 100)}% of the pipeline, by close chance` : "No open deals"}>
            {meter(fig.weighted, fig.inPlay)}
          </Txt>
        </Fig>
      );
      case "won_month": {
        const diff = fig.wonLast > 0 ? Math.round(((fig.wonValue - fig.wonLast) / fig.wonLast) * 100) : null;
        return (
          <Fig cls="is-billed" onClick={toSales} title="Open Sales">
            <Txt label={`${seesTeam ? "Team won" : "You won"} this month`} value={wait ?? `${eur(cWon)} €`} unit={loading ? "" : ` · ${fig.wonCount} ${fig.wonCount === 1 ? "deal" : "deals"}`}
              sub={diff == null ? `Nothing won in ${monthName(lastYm)}` : `${diff >= 0 ? "+" : ""}${diff}% on ${monthName(lastYm)} (${eur(fig.wonLast)} €)`} />
          </Fig>
        );
      }
      case "closing": return (
        <Fig cls={overdue ? "has-late" : ""} onClick={() => setRightTab("closing")} title="See the deals about to close">
          <Txt label="Closing in 30 days" value={wait ?? Math.round(cClosing)} big unit={fig.closing ? ` · ${eur(fig.closingValue)} €` : ""}>
            <span className="chx-chips">
              {overdue > 0 && <span className="chx-chip is-late">{overdue} past their date</span>}
              {overdue === 0 && <span className="chx-chip is-ok">{fig.closing ? "All dates ahead" : "Nothing due"}</span>}
            </span>
          </Txt>
        </Fig>
      );
      case "winrate": return (
        <Fig onClick={toSales} title="Open Sales">
          <Ring pct={fig.winRate ?? 0} size={58} stroke={6}><b>{fig.winRate == null ? "—" : `${Math.round(fig.winRate)}%`}</b></Ring>
          <Txt label="Win rate, last 90 days" value={wait ?? (fig.winRate == null ? "—" : `${Math.round(fig.winRate)}%`)} sub={fig.closed90 ? `${fig.closed90} deals closed, won or lost` : "No deals closed yet"} />
        </Fig>
      );
      case "attention": return (
        <Fig cls={overdue ? "has-late" : ""} onClick={() => setWhyFilter("all")} title="See the deals that need attention">
          <Txt label="Deals that need attention" value={wait ?? attention.length} big>
            <span className="chx-chips">
              {overdue > 0 && <span className="chx-chip is-late">{overdue} overdue</span>}
              {whyCount("stuck") > 0 && <span className="chx-chip is-today">{whyCount("stuck")} stuck</span>}
              {attention.length === 0 && !loading && <span className="chx-chip is-ok">All moving</span>}
            </span>
          </Txt>
        </Fig>
      );
      case "new_month": return (
        <Fig onClick={toSales} title="Open Sales">
          <Txt label="New deals this month" value={wait ?? fig.newCount} big unit={fig.newValue ? ` · ${eur(fig.newValue)} €` : ""} sub="Opened since the 1st" />
        </Fig>
      );
      case "avg_won": return (
        <Fig onClick={toSales} title="Open Sales">
          <Txt label="Average won deal" value={wait ?? `${eur(fig.avgWon)} €`} sub={fig.wonYear ? `Over ${fig.wonYear} deals won in the last 12 months` : "No deals won in the last 12 months"} />
        </Fig>
      );
      case "booked": {
        const pct = cal ? (cal.todayCap > 0 ? (cal.todayMin / cal.todayCap) * 100 : cal.todayMin > 0 ? 101 : 0) : 0;
        const hrs = (m: number) => `${+(m / 60).toFixed(1)}h`;
        return (
          <Fig cls="is-today" onClick={() => nav("/calendar")} title="Open your calendar">
            <Ring pct={pct} size={58} stroke={6}><b>{cal ? `${Math.round(Math.min(pct, 999))}%` : "…"}</b></Ring>
            <Txt label="Booked today" value={cal ? hrs(cToday) : "…"} unit={cal ? ` of ${hrs(cal.todayCap)}` : ""}
              sub={cal?.next ? <>Next: <em>{cal.next.time}</em> {cal.next.title}</> : cal ? "Nothing else booked" : "Reading your calendar…"} />
          </Fig>
        );
      }
      case "tickets": case "tasks": {
        const x = k === "tickets" ? tix : tasks;
        return (
          <Fig cls={`is-tix ${x && x.late > 0 ? "has-late" : ""}`} onClick={() => nav(k === "tickets" ? "/tickets" : "/tickets?kind=task")} title={k === "tickets" ? "Open your tickets" : "Open your tasks"}>
            <Txt label={k === "tickets" ? "Open tickets" : "Open tasks"} value={x ? x.open : "…"} big>
              <span className="chx-chips">
                {x && x.late > 0 && <span className="chx-chip is-late">{x.late} late</span>}
                {x && x.late === 0 && <span className="chx-chip is-ok">{x.open ? "All on time" : "Nothing pending"}</span>}
              </span>
            </Txt>
          </Fig>
        );
      }
    }
  };

  const whenLabel = (d: string) => {
    const n = daysBetween(today, d);
    return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n < 7 ? `In ${n} days` : new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };

  return (
    <div className="ch-home sx-home">
      {/* ============ HERO ============ */}
      <section className="chx-hero" ref={heroRef} onPointerMove={glow} aria-label="Your day in sales">
        <i className="chx-hero-grid" aria-hidden="true" />
        <i className="chx-hero-glow" aria-hidden="true" />
        <div className="chx-hero-top">
          <div className="chx-hello">
            <h1 className="chx-greet">{greeting}{firstName ? `, ${firstName}` : ""}</h1>
            <span className="chx-date">{dateLabel}</span>
          </div>
          <span className="chx-grow" />
          {alertsBell}
          <button type="button" className={`chx-edit ${picker ? "is-on" : ""}`} onClick={(e) => setPicker(picker ? null : e.currentTarget.getBoundingClientRect())}
            aria-haspopup="dialog" aria-expanded={!!picker} title="Choose the four figures below">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
            Customize
          </button>
        </div>
        <div className="chx-figs">
          {slots.map((k, i) => <Fragment key={`${k}-${i}`}>{heroFig(k)}</Fragment>)}
        </div>
      </section>
      {picker && <HeroPicker anchor={picker} slots={slots} kpis={SALES_KPIS} defaults={SALES_DEFAULT}
        sub="Pick any sales figure. Clicking one opens where it comes from."
        onChange={(s) => changeSlots(s.filter(isSKey))} onClose={() => setPicker(null)} />}

      {/* ============ LEFT: calendar + pipeline by stage ============ */}
      <div className="ch-col ch-col-mid">
        {calendar}
        <section className="cz-card sx-stages" aria-label="Pipeline by stage">
          <header className="cz-head">
            <div className="cz-titles">
              <span className="cz-eyebrow">{seesTeam ? "Department pipeline" : "Your pipeline"} by stage</span>
              <h2 className="cz-title">{loading ? "…" : <>{eur(pipeTotal)} €<small>{pipeCount} open {pipeCount === 1 ? "deal" : "deals"}</small></>}</h2>
            </div>
            {pipes.length > 1 ? (
              <div className="sx-pipe-pick">
                <Select size="sm" value={pipeSel ?? ""} onChange={(v) => setPipeSel(v)} aria-label="Pipeline"
                  options={pipes.map((p) => ({ value: p.id, label: p.name }))} />
              </div>
            ) : <button type="button" className="cz-link" onClick={() => nav("/sales")}>Sales<i aria-hidden="true">→</i></button>}
          </header>
          {loading ? <div className="cz-skel" /> : stages.length === 0 ? <p className="cz-empty">No stages in this pipeline yet.</p> : (
            <ol className="sx-funnel" key={pipeSel ?? ""}>
              {stages.map((s, i) => (
                <li key={s.id} style={{ ["--i" as string]: i, ["--c" as string]: s.color || "#12b57f" } as React.CSSProperties}>
                  <button type="button" onClick={() => nav("/sales")} title={`Open Sales · ${s.name}`}>
                    <span className="sx-st-name"><i />{s.name}</span>
                    <span className={`sx-st-bar ${s.count ? "" : "is-zero"}`}>
                      <i style={{ width: `${s.value ? Math.max(3, (s.value / stageMax) * 100) : 0}%` }} />
                      <span className="sx-st-more">
                        {s.prob != null && <span>{Math.round(Number(s.prob))}%</span>}
                        {s.age != null && <span>avg {s.age}d</span>}
                        {s.stuck > 0 && <em>{s.stuck} stuck</em>}
                        {s.prob == null && s.age == null && !s.stuck && <span>{s.count ? "no stage dates" : "empty"}</span>}
                      </span>
                    </span>
                    <span className="sx-st-n">{s.count.toLocaleString("en-US")}</span>
                    <span className="sx-st-v">{s.value ? `${short(s.value)} €` : "—"}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {/* ============ MIDDLE: to-do & tickets ============ */}
      <div className="ch-col ch-col-desk">{desk}</div>

      {/* ============ RIGHT: about to close / team, then needs attention ============ */}
      <div className="ch-col ch-col-right">
        <section className="cz-card sx-close" aria-label={rightTab === "team" ? "The sales team" : "Deals about to close"}>
          <header className="cz-head">
            <div className="cz-titles">
              <span className="cz-eyebrow">{rightTab === "team" ? "Sales team this month" : "About to close"}</span>
              <h2 className="cz-title">{loading ? "…" : rightTab === "team"
                ? <>{eur(teamRows.reduce((s, r) => s + r.won, 0))} €<small>won · {teamRows.filter((r) => r.wonCount).length} of {teamRows.length} people</small></>
                : <>{eur(closing.reduce((s, x) => s + valueOf(x.t), 0))} €<small>{closing.length} {closing.length === 1 ? "deal" : "deals"} · next {CLOSE_WINDOW} days</small></>}</h2>
            </div>
            {seesTeam ? (
              <div className="sx-seg" role="tablist" aria-label="Show">
                <button role="tab" aria-selected={rightTab === "closing"} className={rightTab === "closing" ? "is-on" : ""} onClick={() => setRightTab("closing")}>Closing</button>
                <button role="tab" aria-selected={rightTab === "team"} className={rightTab === "team" ? "is-on" : ""} onClick={() => setRightTab("team")}>Team</button>
              </div>
            ) : <button type="button" className="cz-link" onClick={() => nav("/sales")}>Deals<i aria-hidden="true">→</i></button>}
          </header>
          {loading ? <div className="cz-skel" /> : rightTab === "team" ? (
            teamRows.length === 0 ? <p className="cz-empty">No deal has an owner yet.</p> : (
              <div className="sx-list">
                {teamRows.map((r, i) => (
                  <div key={r.id} className="sx-rep" style={{ ["--i" as string]: Math.min(i, 10) } as React.CSSProperties}>
                    <span className="sx-rep-av" aria-hidden="true">{initials(r.name)}</span>
                    <span className="sx-rep-main">
                      <b>{r.name}</b>
                      <span className="sx-rep-bar"><i style={{ width: `${(r.pipe / teamMax) * 100}%` }} /></span>
                      <small>{eur(r.pipe)} € open · {r.deals} {r.deals === 1 ? "deal" : "deals"}</small>
                    </span>
                    <span className={`sx-rep-won ${r.won ? "is-on" : ""}`}><b>{r.won ? `${short(r.won)} €` : "—"}</b><small>{r.wonCount ? `${r.wonCount} won` : "none won"}</small></span>
                  </div>
                ))}
              </div>
            )
          ) : closing.length === 0 ? <p className="cz-empty">No deal expected to close in the next {CLOSE_WINDOW} days.</p> : (
            <div className="sx-list">
              {closing.slice(0, LIST_CAP).map(({ t, d }, i) => {
                const pr = probOf(t);
                const n = daysBetween(today, d);
                return (
                  <button type="button" key={t.id} className={`sx-deal ${n <= 7 ? "is-near" : ""}`} style={{ ["--i" as string]: Math.min(i, 10) } as React.CSSProperties} onClick={() => open(t)}>
                    <ClientLogo name={companyOf(t) || titleOf(t)} companyId={t.company_id} className="cz-logo" />
                    <span className="sx-deal-main">
                      <b>{titleOf(t)}</b>
                      <small>{phaseOf(t)?.name ?? "—"}{seesTeam && ownerOf(t) ? ` · ${ownerOf(t)}` : ""}</small>
                    </span>
                    <span className="sx-deal-side">
                      <b>{valueOf(t) ? `${eur(valueOf(t))} €` : "—"}</b>
                      <span className="sx-when" title={`${Math.round(pr)}% chance to close`}><em className={`sx-prob ${pr >= 70 ? "is-hi" : pr >= 40 ? "is-mid" : ""}`} style={{ ["--p" as string]: pr } as React.CSSProperties} />{whenLabel(d)}</span>
                    </span>
                  </button>
                );
              })}
              {closing.length > LIST_CAP && (
                <button type="button" className="sx-more" onClick={() => nav("/sales")}>The next {LIST_CAP} of {closing.length} · all in Sales →</button>
              )}
            </div>
          )}
        </section>

        <section className="cz-card sx-attn" aria-label="Deals that need attention">
          <header className="cz-head">
            <div className="cz-titles">
              <span className="cz-eyebrow">Needs attention</span>
              <h2 className="cz-title">{loading ? "…" : <>{attention.length}<small>{attention.length === 1 ? "deal" : "deals"}{overdue ? ` · ${overdue} overdue` : ""}</small></>}</h2>
            </div>
          </header>
          {!loading && attention.length > 0 && (
            <div className="sx-why" role="tablist" aria-label="Why">
              <button role="tab" aria-selected={whyFilter === "all"} className={whyFilter === "all" ? "is-on" : ""} onClick={() => setWhyFilter("all")}>All <i>{attention.length}</i></button>
              {WHY_ORDER.filter((w) => whyCount(w) > 0).map((w) => (
                <button key={w} role="tab" aria-selected={whyFilter === w} className={`is-${WHY[w].tone} ${whyFilter === w ? "is-on" : ""}`} onClick={() => setWhyFilter(whyFilter === w ? "all" : w)}>{WHY[w].label} <i>{whyCount(w)}</i></button>
              ))}
            </div>
          )}
          {loading ? <div className="cz-skel" /> : attention.length === 0 ? (
            <p className="cz-empty is-good">Every deal has a date ahead, recent notes and keeps moving.</p>
          ) : (
            <div className="sx-list">
              {shown.slice(0, LIST_CAP).map(({ t, flags }, i) => (
                <button type="button" key={t.id} className="sx-deal is-attn" style={{ ["--i" as string]: Math.min(i, 10) } as React.CSSProperties} onClick={() => open(t)}>
                  <ClientLogo name={companyOf(t) || titleOf(t)} companyId={t.company_id} className="cz-logo" />
                  <span className="sx-deal-main">
                    <b>{titleOf(t)}</b>
                    <span className="sx-flags">
                      {flags.slice(0, 2).map((f) => <span key={f.why} className={`sx-flag is-${WHY[f.why].tone}`}>{f.text}</span>)}
                      {flags.length > 2 && <span className="sx-flag is-mute">+{flags.length - 2}</span>}
                    </span>
                  </span>
                  <span className="sx-deal-side">
                    <b>{valueOf(t) ? `${short(valueOf(t))} €` : "—"}</b>
                    <small>{seesTeam && ownerOf(t) ? ownerOf(t).split(" ")[0] : phaseOf(t)?.name ?? ""}</small>
                  </span>
                </button>
              ))}
              {shown.length > LIST_CAP && (
                <button type="button" className="sx-more" onClick={() => nav("/sales")}>The {LIST_CAP} most urgent of {shown.length.toLocaleString("en-US")} · all in Sales →</button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
