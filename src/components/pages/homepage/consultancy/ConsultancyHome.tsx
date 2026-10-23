/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home · CONSULTANCY — the whole page, in three columns:
 *   left    your calendar (tall) and, under it, the department backlog as a 2×2
 *   middle  the ticket desk (to-do + tickets), full height
 *   right   team (or your own) performance, then outstanding bills
 * The calendar and the desk come from the shared home pieces (props).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../api/supabase";
import { loadRoles } from "../../settings/blueprintsApi";
import { roleLinesOfRow, resolveRoleKey, legacyRoleMap, roleKeyOf, roleCounts, rateOn, lineRate } from "../../clients/clientsTypes";
import { goToSection } from "../../../framework/pageAccess";
import { ClientLogo } from "../../clients/ClientWorkspace";
import { CAL_SUMMARY_EVENT, type CalSummary } from "../shared/HomeCalendar";
import { TICKETS_EVENT } from "../shared/HomeTodo";
import "./ConsultancyHome.css";

const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const d1 = (n: number) => (+n.toFixed(1)).toLocaleString();

interface Props {
  userId: string;
  isLead: boolean;   // boss / consultancy_manager sees the whole team; consultant sees self
  hoursPerDay: number;
  /** The shared calendar card (left column, on top). */
  calendar: ReactNode;
  /** The ticket desk (middle column). */
  desk: ReactNode;
  /** The hero: greeting, the global search, where the page measures its top. */
  greeting: string;
  firstName: string | null;
  search: ReactNode;
  heroRef?: Ref<HTMLElement>;
}

const prefersStill = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
/** Counts up to a figure the first time it's known, then eases between values. */
function useCount(target: number, ms = 900): number {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (prefersStill()) { setV(target); from.current = target; return; }
    const a = from.current, t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      const x = a + (target - a) * e;
      setV(x); from.current = x;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

/** A ring that fills to `pct` (0–100+); over 100 it turns warm. */
function Ring({ pct, size = 64, stroke = 7, children }: { pct: number; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <span className={`chx-ring ${pct > 100 ? "is-over" : pct >= 75 ? "is-full" : ""}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="chx-ring-track" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} className="chx-ring-fill" strokeWidth={stroke}
          strokeDasharray={`${c} ${c}`} style={{ strokeDashoffset: c * (1 - p / 100) }} />
      </svg>
      <span className="chx-ring-in">{children}</span>
    </span>
  );
}

interface Bill { id: string; client: string; clientId: string | null; period: string; amount: number; status: string; ageMonths: number; }
interface PersonRow { userId: string; name: string; daysDone: number; daysPlanned: number; daysTarget: number; billed: number; billedPlanned: number; billTarget: number; bonus: number; series: number[]; }
interface TopProject { id: string; name: string; client: string; clientId: string | null; daysLeft: number; value: number; }

/** A tiny cumulative line: days delivered through the billing period, against the target. */
function Spark({ series, target }: { series: number[]; target: number }) {
  if (series.length < 2) return <span className="cz-spark is-empty" />;
  const W = 120, H = 32;
  const max = Math.max(target, series[series.length - 1], 1);
  const pts = series.map((v, i) => `${((i / (series.length - 1)) * W).toFixed(1)},${(H - (v / max) * (H - 3) - 1.5).toFixed(1)}`);
  const ty = H - (target / max) * (H - 3) - 1.5;
  return (
    <svg className="cz-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {target > 0 && <line x1="0" x2={W} y1={ty} y2={ty} className="cz-spark-target" />}
      <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} className="cz-spark-area" />
      <polyline points={pts.join(" ")} className="cz-spark-line" />
    </svg>
  );
}

export default function ConsultancyHome({ userId, isLead, hoursPerDay, calendar, desk, greeting, firstName, search, heroRef }: Props) {
  const nav = useNavigate();
  const [loading, setLoading] = useState(true);
  const [bills, setBills] = useState<Bill[]>([]);
  const [backlog, setBacklog] = useState({ consDays: 0, connDays: 0, valueCore: 0, valueConn: 0, value: 0, projects: 0, otherLabel: "Other roles" });
  const [topProjects, setTopProjects] = useState<TopProject[]>([]);
  const [team, setTeam] = useState<PersonRow[]>([]);
  const [teamTotals, setTeamTotals] = useState({ daysDone: 0, daysPlanned: 0, daysTarget: 0, billed: 0, billTarget: 0, bonus: 0 });
  const [cal, setCal] = useState<CalSummary | null>(null);
  const [tix, setTix] = useState<{ open: number; late: number; today: number } | null>(null);

  // today's load comes from the calendar card once it has its data
  useEffect(() => {
    const on = (e: Event) => setCal((e as CustomEvent<CalSummary>).detail);
    window.addEventListener(CAL_SUMMARY_EVENT, on);
    return () => window.removeEventListener(CAL_SUMMARY_EVENT, on);
  }, []);
  // my open tickets (refreshed whenever the desk changes something)
  useEffect(() => {
    let alive = true;
    const load = async () => {
      let r: any = await supabase.from("tracking_tasks").select("id, done, status, stage, due_at").eq("assignee_id", userId).range(0, 4999);
      if (r.error) r = await supabase.from("tracking_tasks").select("id, done, status, due_at").eq("assignee_id", userId).range(0, 4999);
      if (!alive || r.error) return;
      const now = Date.now();
      const end = new Date(); end.setHours(23, 59, 59, 999);
      const open = ((r.data ?? []) as any[]).filter((t) => !(t.done || t.status === "done" || ["resolved", "closed"].includes(t.stage)));
      setTix({
        open: open.length,
        late: open.filter((t) => t.due_at && new Date(t.due_at).getTime() < now).length,
        today: open.filter((t) => t.due_at && new Date(t.due_at).getTime() >= now && new Date(t.due_at).getTime() <= end.getTime()).length,
      });
    };
    load().catch(() => {});
    const again = () => { load().catch(() => {}); };
    window.addEventListener(TICKETS_EVENT, again);
    return () => { alive = false; window.removeEventListener(TICKETS_EVENT, again); };
  }, [userId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const todayISO = new Date().toISOString().slice(0, 10);

      // ---- department backlog — replicates the Management Backlog page exactly ----
      // available = sold − billed (confirmed) per role; planned/booked does NOT
      // count as consumed. value = Σ available × that role's rate. Roles that
      // count for the consultant's target make the consultancy bucket, the rest
      // (a connector, say) the other one. Only kicked-off projects count.
      const [{ data: projs }, { data: pu }, roles] = await Promise.all([
        supabase.from("projects").select("*"),
        supabase.from("project_role_usage").select("project_id, role_key, done"),
        loadRoles(),
      ]);
      const legacy = legacyRoleMap(roles);
      const linesOf = (p: any) => {
        const out: ReturnType<typeof roleLinesOfRow> = [];
        for (const l of roleLinesOfRow(p)) {
          const roleId = resolveRoleKey(l.roleId, legacy);
          const same = out.find((x) => x.roleId === roleId);
          if (same) same.days += l.days; else out.push({ ...l, roleId });
        }
        return out;
      };
      // billed (confirmed) per project per role
      const billedByProjRole: Record<string, Record<string, number>> = {};
      (pu ?? []).forEach((r: any) => {
        const k = resolveRoleKey(r.role_key || "consultor", legacy);
        (billedByProjRole[r.project_id] ??= {})[k] = (billedByProjRole[r.project_id]?.[k] || 0) + (Number(r.done) || 0);
      });

      // client names (backlog projects, bills)
      const projClient: Record<string, string> = {};
      (projs ?? []).forEach((p: any) => { projClient[p.id] = p.client_id; });
      const allClientIds = Array.from(new Set(Object.values(projClient).filter(Boolean)));
      const clientName: Record<string, string> = {};
      if (allClientIds.length) {
        const { data: cl } = await supabase.from("clients").select("id, name").in("id", allClientIds as string[]);
        (cl ?? []).forEach((c: any) => { clientName[c.id] = c.name; });
      }

      let consDays = 0, connDays = 0, valueCore = 0, valueConn = 0, projCount = 0;
      const tops: TopProject[] = [];
      (projs ?? []).forEach((p: any) => {
        // only kicked-off projects enter the backlog
        if (p.kickoff_date && p.kickoff_date > todayISO) return;
        const lines = linesOf(p);
        if (lines.reduce((s, l) => s + l.days, 0) === 0) return;
        const b = billedByProjRole[p.id] || {};
        let any = false, left = 0, val = 0;
        for (const l of lines) {
          const avail = Math.max(0, l.days - (b[l.roleId] || 0));
          if (avail <= 0.001) continue;
          any = true; left += avail; val += avail * lineRate(l);
          if (roleCounts(l.roleId, roles)) { consDays += avail; valueCore += avail * lineRate(l); }
          else { connDays += avail; valueConn += avail * lineRate(l); }
        }
        if (any) {
          projCount += 1;
          const cid = p.client_id ?? null;
          tops.push({ id: p.id, name: p.name || clientName[cid] || "Project", client: clientName[cid] || "", clientId: cid, daysLeft: left, value: val });
        }
      });
      const others = roles.filter((r) => !r.countsForTarget).map((r) => r.name);
      if (alive) {
        setBacklog({
          consDays, connDays, valueCore, valueConn,
          value: valueCore + valueConn,
          projects: projCount,
          otherLabel: others.length ? others.join(", ") : "Other roles",
        });
        setTopProjects(tops.sort((a, b) => b.value - a.value).slice(0, 3));
      }

      // ---- team panel: MATCHES the Management Team tab (Month scope) ----
      const nowP = new Date();
      const curPeriod = `${nowP.getFullYear()}-${String(nowP.getMonth() + 1).padStart(2, "0")}`;
      const cutoffDay = 22;
      const periodForDate = (iso: string) => {
        const d = new Date(iso + "T00:00:00");
        if (d.getDate() > cutoffDay) { const n = new Date(d.getFullYear(), d.getMonth() + 1, 1); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; }
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      };
      const [{ data: prof }, { data: ut }, { data: bs2 }, { data: svc }, { data: allCe }, { data: inv }] = await Promise.all([
        supabase.from("profiles").select("id, first_name, last_name, role, department"),
        supabase.from("user_targets").select("*"),
        supabase.from("billing_settings").select("min_days_month, min_billing_month, bonus_pct_1").eq("id", "default").maybeSingle(),
        supabase.from("services").select("id, rate_unit"),
        supabase.from("calendar_entries").select("user_id, billable, billing_line, role_id, entry_date, billing_period, project_id, status")
          .neq("status", "cancelled").neq("billing_line", "closure")
          .gte("entry_date", new Date(nowP.getFullYear(), nowP.getMonth() - 1, 10).toISOString().slice(0, 10))
          .lte("entry_date", new Date(nowP.getFullYear(), nowP.getMonth() + 1, 10).toISOString().slice(0, 10))
          .range(0, 99999),
        supabase.from("invoices").select("project_id, amount, period, status"),
      ]);
      const defMinDays = Number((bs2 as any)?.min_days_month) || 12;
      const defMinBill = Number((bs2 as any)?.min_billing_month) || 0;
      const defPct = Number((bs2 as any)?.bonus_pct_1) || 3;
      // which projects bill by the hour → their days are tracked separately
      const hourUnit: Record<string, boolean> = {};
      (svc ?? []).forEach((r: any) => { hourUnit[r.id] = r.rate_unit === "hour"; });
      const isHourProj: Record<string, boolean> = {};
      (projs ?? []).forEach((p: any) => { isHourProj[p.id] = !!hourUnit[p.service_id]; });

      const capById: Record<string, any> = {}; (ut ?? []).forEach((r: any) => { capById[r.user_id] = r; });
      const nameById: Record<string, string> = {};
      (prof ?? []).forEach((p: any) => { nameById[p.id] = [p.first_name, p.last_name].filter(Boolean).join(" ") || "—"; });
      const linesByProj: Record<string, ReturnType<typeof roleLinesOfRow>> = {};
      (projs ?? []).forEach((p: any) => { linesByProj[p.id] = linesOf(p); });

      // team = everyone who appears on a project's team (like Management's inTeam)
      const inTeam = new Set<string>();
      (projs ?? []).forEach((p: any) => {
        const t = Array.isArray(p.team) ? p.team : [];
        t.forEach((m: any) => { if (m?.userId || m?.user_id) inTeam.add(m.userId || m.user_id); });
      });

      const doneByUser: Record<string, number> = {};
      const plannedByUser: Record<string, number> = {};
      const billedByUser: Record<string, number> = {};
      const billedPlannedByUser: Record<string, number> = {};
      const doneByUserDay: Record<string, Record<string, number>> = {};
      (allCe ?? []).forEach((e: any) => {
        const key = resolveRoleKey(roleKeyOf(e), legacy);
        if (key !== "sales" && !roleCounts(key, roles)) return;    // roles that don't count are excluded, like Management
        const per = e.billing_period || periodForDate(e.entry_date);
        if (per !== curPeriod) return;
        // hourly projects' days are NOT summed into the day figure
        if (isHourProj[e.project_id]) return;
        const dv = Number(e.billable) || 0;
        if (dv <= 0) return;
        const rate = rateOn(linesByProj[e.project_id] ?? [], key);
        if (e.status === "confirmed") {
          doneByUser[e.user_id] = (doneByUser[e.user_id] || 0) + dv;
          billedByUser[e.user_id] = (billedByUser[e.user_id] || 0) + dv * rate;
          const m = (doneByUserDay[e.user_id] ??= {});
          m[e.entry_date] = (m[e.entry_date] || 0) + dv;
        } else {
          plannedByUser[e.user_id] = (plannedByUser[e.user_id] || 0) + dv;
          billedPlannedByUser[e.user_id] = (billedPlannedByUser[e.user_id] || 0) + dv * rate;
        }
      });
      // the billing period's days so far (23rd of last month → today) for the sparklines
      const pStart = new Date(nowP.getFullYear(), nowP.getMonth() - (nowP.getDate() > cutoffDay ? 0 : 1), cutoffDay + 1);
      const periodDays: string[] = [];
      for (let d = new Date(pStart); d <= nowP && periodDays.length < 40; d.setDate(d.getDate() + 1)) {
        periodDays.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
      }
      const seriesOf = (uid: string) => {
        const m = doneByUserDay[uid] || {};
        let acc = 0;
        return periodDays.map((d) => (acc += m[d] || 0));
      };

      const teamIds = new Set<string>([
        ...Object.keys(doneByUser), ...Object.keys(plannedByUser),
        ...inTeam,
      ]);
      const rows: PersonRow[] = [...teamIds].map((uid) => {
        const cap = capById[uid] || {};
        const daysDone = doneByUser[uid] || 0;
        const daysPlanned = plannedByUser[uid] || 0;
        const billed = billedByUser[uid] || 0;
        const billedPlanned = billedPlannedByUser[uid] || 0;
        const daysTarget = cap.min_days_month != null ? Number(cap.min_days_month) : defMinDays;
        const billTarget = cap.min_billing_month != null ? Number(cap.min_billing_month) : defMinBill;
        const minMet = daysDone >= daysTarget && (billTarget === 0 || billed >= billTarget);
        const bonus = minMet ? billed * ((cap.bonus_pct_1 != null ? Number(cap.bonus_pct_1) : defPct) / 100) : 0;
        return { userId: uid, name: nameById[uid] || "Unknown", daysDone, daysPlanned, daysTarget, billed, billedPlanned, billTarget, bonus, series: seriesOf(uid) };
      }).sort((a, b) => (b.daysDone + b.daysPlanned) - (a.daysDone + a.daysPlanned));

      const shown = isLead ? rows : rows.filter((r) => r.userId === userId);
      if (alive) {
        setTeam(shown);
        setTeamTotals({
          daysDone: rows.reduce((s, r) => s + r.daysDone, 0),
          daysPlanned: rows.reduce((s, r) => s + r.daysPlanned, 0),
          daysTarget: rows.reduce((s, r) => s + r.daysTarget, 0),
          billed: rows.reduce((s, r) => s + r.billed, 0),
          billTarget: rows.reduce((s, r) => s + r.billTarget, 0),
          bonus: rows.reduce((s, r) => s + r.bonus, 0),
        });
      }

      // ---- outstanding bills of MY projects (unpaid) ----
      // My projects = projects I've delivered on this scope.
      const myProjectIds = new Set((allCe ?? []).filter((e: any) => e.user_id === userId).map((e: any) => e.project_id));
      const nowMonths = nowP.getFullYear() * 12 + nowP.getMonth();
      const unpaid = (inv ?? [])
        .filter((i: any) => i.status !== "paid" && (isLead || myProjectIds.has(i.project_id)))
        .map((i: any) => {
          const cid = projClient[i.project_id] ?? null;
          const [py, pm] = String(i.period ?? "").split("-").map(Number);
          const age = py && pm ? Math.max(0, nowMonths - (py * 12 + pm - 1)) : 0;
          return { id: `${i.project_id}|${i.period}`, client: (cid && clientName[cid]) || "—", clientId: cid, period: i.period, amount: Number(i.amount) || 0, status: String(i.status ?? ""), ageMonths: age };
        })
        .sort((a: Bill, b: Bill) => b.amount - a.amount)
        .slice(0, 40);
      if (alive) setBills(unpaid);

      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [userId, isLead, hoursPerDay]);

  const outstandingTotal = useMemo(() => bills.reduce((s, b) => s + b.amount, 0), [bills]);
  const lateBills = bills.filter((b) => b.ageMonths >= 2).length;
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);
  const teamDayPct = pct(teamTotals.daysDone, teamTotals.daysTarget);
  const teamPlanPct = pct(teamTotals.daysDone + teamTotals.daysPlanned, teamTotals.daysTarget);
  const teamBillPct = pct(teamTotals.billed, teamTotals.billTarget);
  const totalDays = backlog.consDays + backlog.connDays;
  const coreShare = totalDays > 0 ? (backlog.consDays / totalDays) * 100 : 0;
  const avg = (v: number, d: number) => (d > 0 ? v / d : 0);
  const periodLabel = (p: string) => {
    const [y, m] = String(p).split("-").map(Number);
    return y && m ? new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : p;
  };

  // ---- hero figures ----
  const hrs = (m: number) => { const h = m / 60; return `${+h.toFixed(1)}h`; };
  const todayPct = cal ? (cal.todayCap > 0 ? (cal.todayMin / cal.todayCap) * 100 : cal.todayMin > 0 ? 101 : 0) : 0;
  const myRow = team.find((r) => r.userId === userId);
  const billedNow = isLead ? teamTotals.billed : myRow?.billed ?? 0;
  const billedGoal = isLead ? teamTotals.billTarget : myRow?.billTarget ?? 0;
  const billPctHero = billedGoal > 0 ? (billedNow / billedGoal) * 100 : 0;
  const aging = useMemo(() => {
    const a = { fresh: 0, one: 0, old: 0 };
    bills.forEach((b) => { if (b.ageMonths >= 2) a.old += b.amount; else if (b.ageMonths >= 1) a.one += b.amount; else a.fresh += b.amount; });
    return a;
  }, [bills]);
  const cBilled = useCount(loading ? 0 : billedNow);
  const cOut = useCount(loading ? 0 : outstandingTotal);
  const cOpen = useCount(tix?.open ?? 0, 600);
  const cToday = useCount(cal?.todayMin ?? 0, 700);
  const dateLabel = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const glow = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  const share = (x: number) => (outstandingTotal > 0 ? (x / outstandingTotal) * 100 : 0);

  return (
    <div className="ch-home">
      {/* ============ HERO: greeting, search, the four figures of the day ============ */}
      <section className="chx-hero" ref={heroRef} onPointerMove={glow} aria-label="Your day">
        <i className="chx-hero-grid" aria-hidden="true" />
        <i className="chx-hero-glow" aria-hidden="true" />
        <div className="chx-hero-top">
          <div className="chx-hello">
            <span className="chx-date">{dateLabel}</span>
            <h1 className="chx-greet">{greeting}{firstName ? `, ${firstName}` : ""}</h1>
          </div>
          <div className="chx-search">{search}</div>
        </div>
        <div className="chx-figs">
          <button type="button" className="chx-fig is-today" onClick={() => nav("/calendar")} title="Open your calendar">
            <Ring pct={todayPct} size={58} stroke={6}><b>{cal ? `${Math.round(Math.min(todayPct, 999))}%` : "…"}</b></Ring>
            <span className="chx-fig-txt">
              <span className="chx-fig-k">Booked today</span>
              <b className="chx-fig-v">{cal ? hrs(cToday) : "…"}<small>{cal ? ` of ${hrs(cal.todayCap)}` : ""}</small></b>
              <span className="chx-fig-s">{cal?.next ? <>Next: <em>{cal.next.time}</em> {cal.next.title}{cal.next.today ? "" : " (later this week)"}</> : cal ? "Nothing else booked" : "Reading your calendar…"}</span>
            </span>
          </button>
          <button type="button" className={`chx-fig is-tix ${tix && tix.late > 0 ? "has-late" : ""}`} onClick={() => document.querySelector<HTMLElement>(".tk-quick input")?.focus()} title="Your open tickets">
            <span className="chx-fig-txt">
              <span className="chx-fig-k">Open tickets</span>
              <b className="chx-fig-v is-big">{tix ? Math.round(cOpen) : "…"}</b>
              <span className="chx-chips">
                {tix && tix.late > 0 && <span className="chx-chip is-late">{tix.late} late</span>}
                {tix && tix.today > 0 && <span className="chx-chip is-today">{tix.today} due today</span>}
                {tix && tix.late === 0 && tix.today === 0 && <span className="chx-chip is-ok">{tix.open ? "All on time" : "Inbox zero"}</span>}
              </span>
            </span>
          </button>
          <button type="button" className="chx-fig is-billed" onClick={() => goToSection(nav, "/management", "team")} title="Open Management › Team">
            <span className="chx-fig-txt">
              <span className="chx-fig-k">{isLead ? "Team billed this month" : "You billed this month"}</span>
              <b className="chx-fig-v">{loading ? "…" : `${eur(cBilled)} €`}<small>{billedGoal > 0 ? ` of ${eur(billedGoal)} €` : ""}</small></b>
              <span className="chx-meter"><i style={{ width: `${Math.min(100, billPctHero)}%` }} /></span>
              <span className="chx-fig-s">{billedGoal > 0 ? `${Math.round(billPctHero)}% of the target` : "No billing target set"}{isLead && teamTotals.bonus > 0 ? ` · ${eur(teamTotals.bonus)} € bonus` : ""}</span>
            </span>
          </button>
          <button type="button" className="chx-fig is-out" onClick={() => goToSection(nav, "/management", "billing/sent")} title="Open Management › Billing › Sent">
            <span className="chx-fig-txt">
              <span className="chx-fig-k">Waiting to be paid</span>
              <b className="chx-fig-v">{loading ? "…" : `${eur(cOut)} €`}<small>{loading ? "" : ` · ${bills.length} ${bills.length === 1 ? "bill" : "bills"}`}</small></b>
              <span className="chx-aging" aria-label="By age">
                <i className="is-fresh" style={{ width: `${share(aging.fresh)}%` }} />
                <i className="is-one" style={{ width: `${share(aging.one)}%` }} />
                <i className="is-old" style={{ width: `${share(aging.old)}%` }} />
              </span>
              <span className="chx-fig-s chx-aging-key">
                <span><em className="is-fresh" />This month</span><span><em className="is-one" />1 month</span><span><em className="is-old" />Older</span>
              </span>
            </span>
          </button>
        </div>
      </section>

      {/* ============ LEFT: calendar + backlog 2×2 ============ */}
      <div className="ch-col ch-col-mid">
        {calendar}
        <section className="cz-card cz-backlog" aria-label="Department backlog">
          <header className="cz-head">
            <div className="cz-titles">
              <span className="cz-eyebrow">Department backlog</span>
              <h2 className="cz-title">{loading ? "…" : <>{eur(backlog.value)} €<small>still to deliver</small></>}</h2>
            </div>
            <button type="button" className="cz-link" onClick={() => goToSection(nav, "/management", "backlog")}>Backlog<i aria-hidden="true">→</i></button>
          </header>
          <div className="cz-kpis">
            <div className="cz-kpi is-hero" tabIndex={0}>
              <div className="cz-kpi-rest">
                <span className="cz-kpi-k">Unbilled value</span>
                <b className="cz-kpi-v">{loading ? "…" : eur(backlog.value)}<i>€</i></b>
                <span className="cz-kpi-s">{d1(totalDays)} days left to deliver</span>
              </div>
              <div className="cz-kpi-more">
                <span className="cz-kpi-k">Where it sits</span>
                <span className="cz-split"><i style={{ width: `${coreShare}%` }} /><i className="is-alt" style={{ width: `${100 - coreShare}%` }} /></span>
                <span className="cz-legend"><span><em className="is-core" />Consultancy <b>{eur(backlog.valueCore)} €</b></span><span><em className="is-alt" />{backlog.otherLabel} <b>{eur(backlog.valueConn)} €</b></span></span>
              </div>
            </div>
            <div className="cz-kpi" tabIndex={0}>
              <div className="cz-kpi-rest">
                <span className="cz-kpi-k"><em className="is-core" />Consultancy</span>
                <b className="cz-kpi-v">{d1(backlog.consDays)}<i>d</i></b>
                <span className="cz-kpi-s">{eur(backlog.valueCore)} €</span>
              </div>
              <div className="cz-kpi-more">
                <span className="cz-kpi-k">Consultancy</span>
                <span className="cz-facts">
                  <span><b>{Math.round(coreShare)}%</b> of the days</span>
                  <span><b>{eur(avg(backlog.valueCore, backlog.consDays))} €</b> avg / day</span>
                </span>
              </div>
            </div>
            <div className="cz-kpi" tabIndex={0}>
              <div className="cz-kpi-rest">
                <span className="cz-kpi-k" title="Roles that don't count for the consultant's target"><em className="is-alt" />{backlog.otherLabel}</span>
                <b className="cz-kpi-v">{d1(backlog.connDays)}<i>d</i></b>
                <span className="cz-kpi-s">{eur(backlog.valueConn)} €</span>
              </div>
              <div className="cz-kpi-more">
                <span className="cz-kpi-k">{backlog.otherLabel}</span>
                <span className="cz-facts">
                  <span><b>{Math.round(100 - coreShare)}%</b> of the days</span>
                  <span><b>{eur(avg(backlog.valueConn, backlog.connDays))} €</b> avg / day</span>
                </span>
              </div>
            </div>
            <div className="cz-kpi" tabIndex={0}>
              <div className="cz-kpi-rest">
                <span className="cz-kpi-k">Projects in backlog</span>
                <b className="cz-kpi-v">{backlog.projects}</b>
                <span className="cz-kpi-s">kicked off, days to deliver</span>
              </div>
              <div className="cz-kpi-more">
                <span className="cz-kpi-k">Biggest</span>
                {topProjects.length === 0 ? <span className="cz-kpi-s">Nothing left to deliver.</span> : (
                  <span className="cz-tops">
                    {topProjects.map((p) => (
                      <span key={p.id} className="cz-top">
                        <ClientLogo name={p.client || p.name} clientId={p.clientId} className="cz-logo is-xs" />
                        <span className="cz-top-n">{p.client || p.name}</span>
                        <b>{d1(p.daysLeft)}d</b>
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ============ MIDDLE: to-do & tickets ============ */}
      <div className="ch-col ch-col-desk">{desk}</div>

      {/* ============ RIGHT: team + bills ============ */}
      <div className="ch-col ch-col-right">
        <section className="cz-card cz-team" aria-label={isLead ? "Team performance" : "Your performance"}>
          <header className="cz-head">
            <div className="cz-titles">
              <span className="cz-eyebrow">{isLead ? "Team performance" : "Your performance"}</span>
              <h2 className="cz-title">{loading ? "…" : <>{Math.round(teamDayPct)}%<small>of the month's days</small></>}</h2>
            </div>
            <button type="button" className="cz-link" onClick={() => goToSection(nav, "/management", "team")}>Management<i aria-hidden="true">→</i></button>
          </header>

          {isLead && (
            <div className="cz-meters">
              <div className="cz-meter" tabIndex={0}>
                <span className="cz-meter-k">Days</span>
                <b>{d1(teamTotals.daysDone)}<em> / {d1(teamTotals.daysTarget)}</em></b>
                <span className="cz-bar"><i className="is-plan" style={{ width: `${teamPlanPct}%` }} /><i style={{ width: `${teamDayPct}%` }} /></span>
                <span className="cz-meter-more">+{d1(teamTotals.daysPlanned)} planned</span>
              </div>
              <div className="cz-meter" tabIndex={0}>
                <span className="cz-meter-k">Billed</span>
                <b>{eur(teamTotals.billed)}<em> / {eur(teamTotals.billTarget)} €</em></b>
                <span className="cz-bar"><i style={{ width: `${teamBillPct}%` }} /></span>
                <span className="cz-meter-more">{teamTotals.bonus > 0 ? `${eur(teamTotals.bonus)} € in bonus` : "no bonus earned yet"}</span>
              </div>
            </div>
          )}

          <div className="cz-people">
            {loading ? <div className="cz-skel" /> : team.length === 0 ? <p className="cz-empty">No delivery booked this month yet.</p> : team.map((r, i) => {
              const donePct = pct(r.daysDone, r.daysTarget);
              const planPct = pct(r.daysDone + r.daysPlanned, r.daysTarget);
              const p = Math.round(donePct);
              return (
                <div className="cz-person" key={r.userId} tabIndex={0} style={{ ["--i" as string]: Math.min(i, 10) } as React.CSSProperties}>
                  <div className="cz-person-row">
                    <span className={`cz-av ${p >= 100 ? "is-hit" : ""}`} aria-hidden="true" style={{ ["--p" as string]: donePct, ["--q" as string]: planPct } as React.CSSProperties}>{r.name.split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase()}</span>
                    <span className="cz-person-name">{r.name}</span>
                    <span className="cz-bar is-thin"><i className="is-plan" style={{ width: `${planPct}%` }} /><i style={{ width: `${donePct}%` }} /></span>
                    <span className={`cz-pct ${p >= 100 ? "is-hit" : ""}`}>{p}%</span>
                  </div>
                  <div className="cz-person-more">
                    <div className="cz-person-in">
                      <span className="cz-stat"><em>Days</em><b>{d1(r.daysDone)}{r.daysPlanned > 0 && <i>+{d1(r.daysPlanned)}</i>}<small> / {d1(r.daysTarget)}</small></b></span>
                      <span className="cz-stat"><em>Billed</em><b>{eur(r.billed)} €{r.billTarget > 0 && <small> / {eur(r.billTarget)}</small>}</b></span>
                      <span className="cz-stat"><em>Bonus</em><b className={r.bonus > 0 ? "is-on" : ""}>{r.bonus > 0 ? `${eur(r.bonus)} €` : "—"}</b></span>
                      <Spark series={r.series} target={r.daysTarget} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="cz-card cz-bills" aria-label="Outstanding bills">
          <header className="cz-head">
            <div className="cz-titles">
              <span className="cz-eyebrow">{isLead ? "Team outstanding bills" : "Outstanding bills"}</span>
              <h2 className="cz-title">{loading ? "…" : <>{eur(outstandingTotal)} €<small>{bills.length} {bills.length === 1 ? "bill" : "bills"}{lateBills > 0 ? ` · ${lateBills} older than a month` : ""}</small></>}</h2>
            </div>
            <button type="button" className="cz-link" onClick={() => goToSection(nav, "/management", "billing/sent")}>Billing<i aria-hidden="true">→</i></button>
          </header>
          {loading ? <div className="cz-skel" /> : bills.length === 0 ? (
            <p className="cz-empty is-good">Nothing outstanding.</p>
          ) : (
            <div className="cz-bills-list">
              {bills.map((b, i) => (
                <button type="button" className={`cz-bill ${b.ageMonths >= 2 ? "is-old" : b.ageMonths >= 1 ? "is-one" : "is-fresh"}`} key={b.id} style={{ ["--i" as string]: Math.min(i, 10) } as React.CSSProperties}
                  onClick={() => goToSection(nav, "/management", "billing/sent")}>
                  <ClientLogo name={b.client} clientId={b.clientId} className="cz-logo" />
                  <span className="cz-bill-main">
                    <span className="cz-bill-client">{b.client}</span>
                    <span className="cz-bill-sub">
                      <span>{periodLabel(b.period)}</span>
                      <span className={`cz-tag ${b.ageMonths >= 2 ? "is-warn" : ""}`}>{b.status === "sent" ? "Awaiting payment" : b.status ? b.status.replace(/_/g, " ") : "Not sent"}</span>
                      {b.ageMonths >= 1 && <span>{b.ageMonths} {b.ageMonths === 1 ? "month" : "months"} old</span>}
                    </span>
                  </span>
                  <span className="cz-bill-amt">{eur(b.amount)} €</span>
                  <span className="cz-bill-go" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
