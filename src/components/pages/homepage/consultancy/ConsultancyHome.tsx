/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home · CONSULTANCY — the whole page, in three columns:
 *   left    your calendar (tall) and, under it, the department backlog as a 2×2
 *   middle  the ticket desk (to-do + tickets), full height
 *   right   team (or your own) performance, then outstanding bills
 * The calendar and the desk come from the shared home pieces (props).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../api/supabase";
import { loadRoles } from "../../settings/blueprintsApi";
import { roleLinesOfRow, resolveRoleKey, legacyRoleMap, roleKeyOf, roleCounts, rateOn, lineRate } from "../../clients/clientsTypes";
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
}

interface Bill { id: string; client: string; period: string; amount: number; due: string | null; late: number; }
interface PersonRow { userId: string; name: string; daysDone: number; daysPlanned: number; daysTarget: number; billed: number; billedPlanned: number; billTarget: number; bonus: number; }

export default function ConsultancyHome({ userId, isLead, hoursPerDay, calendar, desk }: Props) {
  const nav = useNavigate();
  const [loading, setLoading] = useState(true);
  const [bills, setBills] = useState<Bill[]>([]);
  const [backlog, setBacklog] = useState({ consDays: 0, connDays: 0, valueCore: 0, valueConn: 0, value: 0, projects: 0, otherLabel: "Other roles" });
  const [team, setTeam] = useState<PersonRow[]>([]);
  const [teamTotals, setTeamTotals] = useState({ daysDone: 0, daysTarget: 0, billed: 0, billTarget: 0 });

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

      let consDays = 0, connDays = 0, valueCore = 0, valueConn = 0, projCount = 0;
      (projs ?? []).forEach((p: any) => {
        // only kicked-off projects enter the backlog
        if (p.kickoff_date && p.kickoff_date > todayISO) return;
        const lines = linesOf(p);
        if (lines.reduce((s, l) => s + l.days, 0) === 0) return;
        const b = billedByProjRole[p.id] || {};
        let any = false;
        for (const l of lines) {
          const avail = Math.max(0, l.days - (b[l.roleId] || 0));
          if (avail <= 0.001) continue;
          any = true;
          if (roleCounts(l.roleId, roles)) { consDays += avail; valueCore += avail * lineRate(l); }
          else { connDays += avail; valueConn += avail * lineRate(l); }
        }
        if (any) projCount += 1;
      });
      const others = roles.filter((r) => !r.countsForTarget).map((r) => r.name);
      if (alive) setBacklog({
        consDays, connDays, valueCore, valueConn,
        value: valueCore + valueConn,
        projects: projCount,
        otherLabel: others.length ? others.join(", ") : "Other roles",
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
        .slice(0, 40);
      if (alive) setBills(unpaid);

      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [userId, isLead, hoursPerDay]);

  const outstandingTotal = useMemo(() => bills.reduce((s, b) => s + b.amount, 0), [bills]);
  const teamDayPct = teamTotals.daysTarget > 0 ? Math.min(100, (teamTotals.daysDone / teamTotals.daysTarget) * 100) : 0;
  const teamBillPct = teamTotals.billTarget > 0 ? Math.min(100, (teamTotals.billed / teamTotals.billTarget) * 100) : 0;

  return (
    <div className="ch-home">
      {/* ============ LEFT: calendar + backlog 2×2 ============ */}
      <div className="ch-col ch-col-mid">
        {calendar}
        <section className="ch-card ch-backlog">
          <div className="ch-head"><span className="ch-eyebrow">Department backlog</span>
            <button className="ch-open" onClick={() => nav("/management")}>Backlog →</button></div>
          <div className="ch-bk2">
            <div className="ch-kpi is-hero">
              <span className="ch-kpi-k">Unbilled value</span>
              <b className="ch-kpi-v is-neon">{loading ? "…" : eur(backlog.value)}<i>€</i></b>
              <span className="ch-kpi-s">{d1(backlog.consDays + backlog.connDays)} days left to deliver</span>
            </div>
            <div className="ch-kpi">
              <span className="ch-kpi-k"><i className="dot-core" />Consultancy</span>
              <b className="ch-kpi-v">{d1(backlog.consDays)}<i>d</i></b>
              <span className="ch-kpi-s">{eur(backlog.valueCore)} €</span>
            </div>
            <div className="ch-kpi">
              <span className="ch-kpi-k" title="Roles that don't count for the consultant's target"><i className="dot-conn" />{backlog.otherLabel}</span>
              <b className="ch-kpi-v">{d1(backlog.connDays)}<i>d</i></b>
              <span className="ch-kpi-s">{eur(backlog.valueConn)} €</span>
            </div>
            <div className="ch-kpi">
              <span className="ch-kpi-k">Projects in backlog</span>
              <b className="ch-kpi-v">{backlog.projects}</b>
              <span className="ch-kpi-s">kicked off, days to deliver</span>
            </div>
          </div>
        </section>
      </div>

      {/* ============ MIDDLE: to-do & tickets ============ */}
      <div className="ch-col ch-col-desk">{desk}</div>

      {/* ============ RIGHT: team + bills ============ */}
      <div className="ch-col ch-col-right">
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
          {loading ? <div className="ch-skel" /> : team.length === 0 ? <p className="ch-empty">No delivery booked this month yet.</p> : team.map((r) => {
            const donePct = r.daysTarget > 0 ? Math.min(100, (r.daysDone / r.daysTarget) * 100) : 0;
            const planPct = r.daysTarget > 0 ? Math.min(100, ((r.daysDone + r.daysPlanned) / r.daysTarget) * 100) : 0;
            const pct = Math.round(donePct);
            return (
              <div className="ch-person" key={r.userId}>
                <span className="ch-team-av">{r.name.charAt(0)}</span>
                <div className="ch-person-main">
                  <span className="ch-person-top">
                    <b className="ch-person-name">{r.name}</b>
                    <span className={`ch-team-pct ${pct >= 100 ? "is-hit" : ""}`}>{pct}%</span>
                  </span>
                  <span className="ch-team-bar">
                    <span className="ch-team-bar-plan" style={{ width: `${planPct}%` }} />
                    <span className="ch-team-bar-done" style={{ width: `${donePct}%` }} />
                  </span>
                  <span className="ch-person-meta">
                    <span><b>{d1(r.daysDone)}</b>{r.daysPlanned > 0 && <em className="ch-team-plan"> +{d1(r.daysPlanned)}</em>} / {d1(r.daysTarget)} d</span>
                    <span>{eur(r.billed)} €</span>
                    <span className={`ch-team-bonus ${r.bonus > 0 ? "is-on" : ""}`}>{r.bonus > 0 ? `bonus ${eur(r.bonus)} €` : "no bonus yet"}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="ch-card ch-bills">
        <div className="ch-head"><span className="ch-eyebrow">{isLead ? "Team outstanding bills" : "Outstanding bills"}</span>
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
    </div>
  );
}
