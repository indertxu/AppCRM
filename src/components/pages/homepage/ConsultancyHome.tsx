/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import "./ConsultancyHome.css";

const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const d1 = (n: number) => (+n.toFixed(1)).toLocaleString();
const d2 = (n: number) => (+n.toFixed(2)).toLocaleString();

interface Props {
  userId: string;
  isLead: boolean;   // boss / consultancy_manager sees the whole team; consultant sees self
  hoursPerDay: number;
}

interface AgendaItem { id: string; date: string; start: number; end: number; title: string; client: string | null; line: string; kind: string; billable: number; color: string; }
interface Bill { id: string; client: string; period: string; amount: number; due: string | null; late: number; }
interface PersonRow { userId: string; name: string; daysDone: number; daysPlanned: number; daysTarget: number; billed: number; billedPlanned: number; billTarget: number; bonus: number; }

const fmtMin = (m: number) => {
  const h = Math.floor(m / 60), mm = m % 60;
  const ap = h < 12 ? "AM" : "PM";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(mm).padStart(2, "0")} ${ap}`;
};
const dayLabel = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};

export default function ConsultancyHome({ userId, isLead, hoursPerDay }: Props) {
  const nav = useNavigate();
  const [loading, setLoading] = useState(true);
  const [agenda, setAgenda] = useState<AgendaItem[]>([]);
  // Visible week for the calendar grid, anchored to Monday.
  const [calLoading, setCalLoading] = useState(true);
  const mondayOf = (d: Date) => { const x = new Date(d); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); x.setHours(0,0,0,0); return x; };
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const todayKey = new Date().toISOString().slice(0, 10);
  const [selDay, setSelDay] = useState<string>(todayKey);
  const [bills, setBills] = useState<Bill[]>([]);
  const [backlog, setBacklog] = useState({ consDays: 0, connDays: 0, valueCore: 0, valueConn: 0, value: 0, projects: 0 });
  const [team, setTeam] = useState<PersonRow[]>([]);
  const [teamTotals, setTeamTotals] = useState({ daysDone: 0, daysTarget: 0, billed: 0, billTarget: 0 });

  // ---- calendar: my entries across the visible 3-day window ----
  useEffect(() => {
    let alive = true;
    (async () => {
      setCalLoading(true);
      // Load the visible week (for the strip) plus everything upcoming (for the list).
      const from = weekStart.toISOString().slice(0, 10);
      const end = new Date(weekStart); end.setDate(end.getDate() + 60);
      const to = end.toISOString().slice(0, 10);
      const { data: ag } = await supabase
        .from("calendar_entries")
        .select("id, entry_date, start_min, end_min, title, kind, meeting_kind, client_id, work_type_id, billing_line, billable")
        .eq("user_id", userId)
        .gte("entry_date", from).lte("entry_date", to)
        .neq("status", "cancelled")
        .order("entry_date").order("start_min");
      const clientNames: Record<string, string> = {};
      const wtColor: Record<string, string> = {};
      const cids = Array.from(new Set((ag ?? []).map((m: any) => m.client_id).filter(Boolean)));
      const wtids = Array.from(new Set((ag ?? []).map((m: any) => m.work_type_id).filter(Boolean)));
      if (cids.length) { const { data: cl } = await supabase.from("clients").select("id, name").in("id", cids); (cl ?? []).forEach((c: any) => { clientNames[c.id] = c.name; }); }
      if (wtids.length) { const { data: wt } = await supabase.from("work_types").select("id, color").in("id", wtids); (wt ?? []).forEach((w: any) => { wtColor[w.id] = w.color || "#12b57f"; }); }
      if (!alive) return;
      setAgenda((ag ?? []).map((m: any) => ({
        id: m.id, date: m.entry_date, start: m.start_min, end: m.end_min ?? (m.start_min + 60),
        title: m.title || (m.kind === "meeting" ? "Meeting" : m.client_id ? "Client session" : "Work"),
        client: m.client_id ? clientNames[m.client_id] : null,
        line: m.billing_line || "consultor",
        kind: m.kind === "meeting" ? (m.meeting_kind || "meeting") : (m.client_id ? "session" : "internal"),
        billable: Number(m.billable) || 0,
        color: m.work_type_id ? (wtColor[m.work_type_id] || "#12b57f") : "#8aa0b5",
      })));
      setCalLoading(false);
    })();
    return () => { alive = false; };
  }, [userId, weekStart]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const todayISO = new Date().toISOString().slice(0, 10);
      const hpd = hoursPerDay > 0 ? hoursPerDay : 8;

      // ---- department backlog — replicates the Management Backlog page exactly ----
      // available = sold − billed (confirmed) per line; planned/booked does NOT
      // count as consumed. value = consultancy days × rate + connector × rate +
      // supervision × supRate. Only kicked-off projects count.
      const { data: projs } = await supabase.from("projects").select("*");
      const { data: pu } = await supabase.from("project_usage").select("project_id, billing_line, done");
      // billed (confirmed) per project per line
      const billedByProjLine: Record<string, { consultor: number; supervision: number; connector: number }> = {};
      (pu ?? []).forEach((r: any) => {
        const line = (r.billing_line === "connector" ? "connector" : r.billing_line === "supervision" ? "supervision" : "consultor") as "consultor" | "supervision" | "connector";
        if (!billedByProjLine[r.project_id]) billedByProjLine[r.project_id] = { consultor: 0, supervision: 0, connector: 0 };
        billedByProjLine[r.project_id][line] += Number(r.done) || 0;
      });

      let consDays = 0, connDays = 0, valueCore = 0, valueConn = 0, projCount = 0;
      (projs ?? []).forEach((p: any) => {
        // only kicked-off projects enter the backlog
        if (p.kickoff_date && p.kickoff_date > todayISO) return;
        const soldC = Number(p.consultor_days) || 0;
        const soldS = Number(p.supervision_days) || 0;
        const soldK = Number(p.connector_days) || 0;
        if (soldC + soldS + soldK === 0) return;
        const b = billedByProjLine[p.id] || { consultor: 0, supervision: 0, connector: 0 };
        const availC = Math.max(0, soldC - b.consultor);
        const availS = Math.max(0, soldS - b.supervision);
        const availK = Math.max(0, soldK - b.connector);
        if (availC + availS + availK <= 0.001) return;
        projCount += 1;
        const rate = Number(p.price_per_day) || 0;
        const supRate = Number(p.supervision_price) || 0;
        // consultancy bucket = consultor + supervision (days and value)
        consDays += availC + availS;
        connDays += availK;
        valueCore += availC * rate + availS * supRate;
        valueConn += availK * rate;
      });
      if (alive) setBacklog({
        consDays, connDays, valueCore, valueConn,
        value: valueCore + valueConn,
        projects: projCount,
      });

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
        supabase.from("calendar_entries").select("user_id, billable, billing_line, entry_date, billing_period, project_id, status")
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
      const rateByProj: Record<string, number> = {};
      const supRateByProj: Record<string, number> = {};
      (projs ?? []).forEach((p: any) => { rateByProj[p.id] = Number(p.price_per_day) || 0; supRateByProj[p.id] = Number(p.supervision_price) || 0; });

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
      (allCe ?? []).forEach((e: any) => {
        if (e.billing_line === "connector") return;                 // connector excluded like Management
        const per = e.billing_period || periodForDate(e.entry_date);
        if (per !== curPeriod) return;
        // hourly projects' days are NOT summed into the day figure
        if (isHourProj[e.project_id]) return;
        const dv = Number(e.billable) || 0;
        if (dv <= 0) return;
        const rate = e.billing_line === "supervision" ? (supRateByProj[e.project_id] || 0) : (rateByProj[e.project_id] || 0);
        if (e.status === "confirmed") {
          doneByUser[e.user_id] = (doneByUser[e.user_id] || 0) + dv;
          billedByUser[e.user_id] = (billedByUser[e.user_id] || 0) + dv * rate;
        } else {
          plannedByUser[e.user_id] = (plannedByUser[e.user_id] || 0) + dv;
          billedPlannedByUser[e.user_id] = (billedPlannedByUser[e.user_id] || 0) + dv * rate;
        }
      });

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
        return { userId: uid, name: nameById[uid] || "Unknown", daysDone, daysPlanned, daysTarget, billed, billedPlanned, billTarget, bonus };
      }).sort((a, b) => (b.daysDone + b.daysPlanned) - (a.daysDone + a.daysPlanned));

      const shown = isLead ? rows : rows.filter((r) => r.userId === userId);
      if (alive) {
        setTeam(shown);
        setTeamTotals({
          daysDone: rows.reduce((s, r) => s + r.daysDone, 0),
          daysTarget: rows.reduce((s, r) => s + r.daysTarget, 0),
          billed: rows.reduce((s, r) => s + r.billed, 0),
          billTarget: rows.reduce((s, r) => s + r.billTarget, 0),
        });
      }

      // ---- outstanding bills of MY projects (unpaid) ----
      // My projects = projects I've delivered on this scope.
      const myProjectIds = new Set((allCe ?? []).filter((e: any) => e.user_id === userId).map((e: any) => e.project_id));
      const clientByProj: Record<string, string> = {};
      const projClient: Record<string, string> = {};
      (projs ?? []).forEach((p: any) => { projClient[p.id] = p.client_id; });
      const allClientIds = Array.from(new Set(Object.values(projClient)));
      if (allClientIds.length) {
        const { data: cl } = await supabase.from("clients").select("id, name").in("id", allClientIds as string[]);
        (cl ?? []).forEach((c: any) => { clientByProj[c.id] = c.name; });
      }
      const unpaid = (inv ?? [])
        .filter((i: any) => i.status !== "paid" && (isLead || myProjectIds.has(i.project_id)))
        .map((i: any) => {
          const cid = projClient[i.project_id];
          return { id: `${i.project_id}|${i.period}`, client: clientByProj[cid] || "—", period: i.period, amount: Number(i.amount) || 0, due: null, late: 0 };
        })
        .sort((a: any, b: any) => b.amount - a.amount)
        .slice(0, 8);
      if (alive) setBills(unpaid);

      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [userId, isLead, hoursPerDay]);

  const outstandingTotal = useMemo(() => bills.reduce((s, b) => s + b.amount, 0), [bills]);
  const teamDayPct = teamTotals.daysTarget > 0 ? Math.min(100, (teamTotals.daysDone / teamTotals.daysTarget) * 100) : 0;
  const teamBillPct = teamTotals.billTarget > 0 ? Math.min(100, (teamTotals.billed / teamTotals.billTarget) * 100) : 0;

  return (
    <div className="ch-bento">
      {/* ============ LEFT: week strip + upcoming work list ============ */}
      <section className="ch-card ch-cal">
        {(() => {
          const iso = (d: Date) => d.toISOString().slice(0, 10);
          const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; });
          const DOW = ["L", "M", "X", "J", "V", "S", "D"];
          const countOn = (dIso: string) => agenda.filter((a) => a.date === dIso).length;
          const weekLabel = `${weekStart.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${weekDays[6].toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
          const shiftWeek = (n: number) => { const d = new Date(weekStart); d.setDate(d.getDate() + n * 7); setWeekStart(d); };
          const kindClass = (a: AgendaItem) =>
            a.kind === "meeting" || a.kind === "teams" || a.kind === "phone" || a.kind === "in_person" ? "is-meeting"
            : a.kind === "internal" ? "is-internal" : "is-work";
          const kindLabel = (a: AgendaItem) =>
            a.kind === "internal" ? "Internal" : (a.kind === "session" || a.kind === "work") ? "Client" : "Meeting";
          const dateHdr = (dIso: string) => {
            const d = new Date(dIso + "T00:00:00");
            const diff = Math.round((d.getTime() - new Date(todayKey + "T00:00:00").getTime()) / 86400000);
            const rel = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "long" });
            return `${rel} · ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
          };

          // upcoming entries from the selected day forward, grouped by day
          const upcoming = agenda.filter((a) => a.date >= selDay).sort((x, y) => x.date === y.date ? x.start - y.start : x.date.localeCompare(y.date));
          const grouped: { date: string; items: AgendaItem[] }[] = [];
          upcoming.forEach((a) => { const g = grouped.find((x) => x.date === a.date); if (g) g.items.push(a); else grouped.push({ date: a.date, items: [a] }); });

          return (
            <>
              {/* week strip */}
              <div className="ch-wk">
                <div className="ch-wk-bar">
                  <button className="ch-wk-arrow" onClick={() => shiftWeek(-1)} aria-label="Previous week">‹</button>
                  <span className="ch-wk-label">{weekLabel}</span>
                  <button className="ch-wk-arrow" onClick={() => shiftWeek(1)} aria-label="Next week">›</button>
                </div>
                <div className="ch-wk-days">
                  {weekDays.map((d, i) => {
                    const dIso = iso(d);
                    const n = countOn(dIso);
                    const isToday = dIso === todayKey;
                    const isSel = dIso === selDay;
                    return (
                      <button key={dIso} className={`ch-wk-day ${isToday ? "is-today" : ""} ${isSel ? "is-sel" : ""}`}
                        onClick={() => setSelDay(dIso)}>
                        <span className="ch-wk-dow">{DOW[i]}</span>
                        <span className="ch-wk-num">{d.getDate()}</span>
                        <span className="ch-wk-dots">{Array.from({ length: Math.min(n, 3) }).map((_, k) => <i key={k} />)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* upcoming work list */}
              <div className="ch-up-head">
                <span className="ch-eyebrow">Upcoming work</span>
                <button className="ch-open" onClick={() => nav("/calendar")}>Open →</button>
              </div>
              <div className="ch-up-list">
                {calLoading ? <div className="ch-skel" style={{ height: 120 }} /> : grouped.length === 0 ? (
                  <p className="ch-empty">Nothing scheduled ahead.</p>
                ) : grouped.map((g) => (
                  <div className="ch-up-day" key={g.date}>
                    <div className="ch-up-daylabel">{dateHdr(g.date)}<span>{g.items.length}</span></div>
                    {g.items.map((a) => (
                      <div className={`ch-up-ev ${kindClass(a)}`} key={a.id} style={{ "--evc": a.color } as any}
                        onClick={() => nav("/calendar")}>
                        <span className="ch-up-time">{fmtMin(a.start)}</span>
                        <span className="ch-up-body">
                          <b>{a.title}</b>
                          {a.client && <em>{a.client}</em>}
                        </span>
                        <span className="ch-up-kind">{kindLabel(a)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          );
        })()}
      </section>

      {/* ============ TOP-RIGHT: backlog summary ============ */}
      <section className="ch-card ch-backlog">
        <div className="ch-head"><span className="ch-eyebrow">Department backlog</span>
          <button className="ch-open" onClick={() => nav("/management")}>Backlog →</button></div>
        <div className="ch-bk-grid">
          {/* total unbilled value — the hero, matches Management */}
          <div className="ch-bk-hero ch-bk-value">
            <span className="ch-bk-k">Unbilled value</span>
            <b className="ch-bk-v is-neon">{eur(backlog.value)}<i>€</i></b>
            <span className="ch-bk-sub">{d1(backlog.consDays + backlog.connDays)} days left to deliver</span>
          </div>
          {/* consultancy */}
          <div className="ch-bk-split">
            <span className="ch-bk-split-k"><i className="dot-core" />Consultancy</span>
            <div className="ch-bk-split-figs">
              <b>{d1(backlog.consDays)}<i>d</i></b>
              <span>{eur(backlog.valueCore)} €</span>
            </div>
          </div>
          {/* connector */}
          <div className="ch-bk-split">
            <span className="ch-bk-split-k"><i className="dot-conn" />Connector</span>
            <div className="ch-bk-split-figs">
              <b>{d1(backlog.connDays)}<i>d</i></b>
              <span>{eur(backlog.valueConn)} €</span>
            </div>
          </div>
          {/* projects */}
          <div className="ch-bk-mini"><span>Projects</span><b>{backlog.projects}</b></div>
        </div>
      </section>

      {/* ============ BOTTOM-LEFT/CENTER: team panel ============ */}
      <section className="ch-card ch-team">
        <div className="ch-head"><span className="ch-eyebrow">{isLead ? "Team performance" : "Your performance"}</span>
          <button className="ch-open" onClick={() => nav("/management")}>Management →</button></div>

        {isLead && (
          <div className="ch-team-totals">
            <div className="ch-tt">
              <span className="ch-tt-k">Team days</span>
              <div className="ch-tt-bar"><span style={{ width: `${teamDayPct}%` }} /></div>
              <b>{d1(teamTotals.daysDone)} <em>/ {d1(teamTotals.daysTarget)}</em></b>
            </div>
            <div className="ch-tt">
              <span className="ch-tt-k">Team billed</span>
              <div className="ch-tt-bar"><span className="is-money" style={{ width: `${teamBillPct}%` }} /></div>
              <b>{eur(teamTotals.billed)} <em>/ {eur(teamTotals.billTarget)} €</em></b>
            </div>
          </div>
        )}

        <div className="ch-team-list">
          <div className="ch-team-head"><span>Consultant</span><span>Days delivered</span><span className="ch-r">Billed</span><span className="ch-r">Bonus</span></div>
          {loading ? <div className="ch-skel" /> : team.map((r) => {
            const donePct = r.daysTarget > 0 ? Math.min(100, (r.daysDone / r.daysTarget) * 100) : 0;
            const planPct = r.daysTarget > 0 ? Math.min(100, ((r.daysDone + r.daysPlanned) / r.daysTarget) * 100) : 0;
            const pct = Math.round(donePct);
            return (
              <div className="ch-team-row" key={r.userId}>
                <span className="ch-team-who"><span className="ch-team-av">{r.name.charAt(0)}</span>{r.name}</span>
                <span className="ch-team-prog">
                  <span className="ch-team-prog-top">
                    <b>{d1(r.daysDone)}</b>
                    {r.daysPlanned > 0 && <em className="ch-team-plan">+{d1(r.daysPlanned)}</em>}
                    <span className="ch-team-of">/ {d1(r.daysTarget)}d</span>
                    <span className={`ch-team-pct ${pct >= 100 ? "is-hit" : ""}`}>{pct}%</span>
                  </span>
                  <span className="ch-team-bar">
                    <span className="ch-team-bar-plan" style={{ width: `${planPct}%` }} />
                    <span className="ch-team-bar-done" style={{ width: `${donePct}%` }} />
                  </span>
                </span>
                <span className="ch-r ch-team-billed">{eur(r.billed)} €</span>
                <span className={`ch-r ch-team-bonus ${r.bonus > 0 ? "is-on" : ""}`}>{r.bonus > 0 ? `${eur(r.bonus)} €` : "—"}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* ============ BOTTOM-RIGHT: outstanding bills ============ */}
      <section className="ch-card ch-bills">
        <div className="ch-head"><span className="ch-eyebrow">Outstanding bills</span>
          <span className="ch-bills-total">{eur(outstandingTotal)} €</span></div>
        {loading ? <div className="ch-skel" /> : bills.length === 0 ? (
          <p className="ch-empty ch-empty-good">Nothing outstanding. ✓</p>
        ) : (
          <div className="ch-bills-list">
            {bills.map((b, i) => (
              <div className="ch-bill-row" key={b.id} style={{ animationDelay: `${i * 0.04}s` }} onClick={() => nav("/management")}>
                <span className="ch-bill-client">{b.client}</span>
                <span className="ch-bill-period">{b.period}</span>
                <span className="ch-bill-amt">{eur(b.amount)} €</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}