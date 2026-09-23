/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import Select from "../../framework/Select";
import "./BacklogPanel.css";

export interface BkEntry {
  id: string;
  userId: string;
  projectId: string;
  date: string;
  billable: number;
  status: string;
  line: string;
}
export interface BkProj {
  id: string;
  clientId: string;
  typeId: string;
  kickoff: string;
  rate: number;
  supervision: number;
  consultorDays: number;
  connectorDays: number;
  supervisionDays: number;
  status: string;
  team: { userId?: string; role?: string }[];
}

interface Props {
  entries: BkEntry[];
  projects: Record<string, BkProj>;
  clientNames: Record<string, string>;
  typeNames: Record<string, string>;
  people: Record<string, string>;
  supRoles: Set<string>;
  hourProjects: Set<string>;
  hoursPerDay: number;
  scope: "week" | "month" | "year" | "all" | "custom";
  anchor: Date;
  rangeFrom: string;
  rangeTo: string;
  /** service_id (BkProj.typeId) -> the role_id marked "main" for that service in
      Products & Services. Whoever holds that role on a project's team is the
      project's owner for backlog-by-consultant purposes. */
  mainRoleByService: Record<string, string>;
  /** Backlog is a point-in-time snapshot, not a period — everything (available
      days, the consultant breakdown, the project list) is measured as of this
      one date, picked directly rather than derived from scope/anchor. */
  asOf: string;
}

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function startOfWeek(input: Date): Date {
  const d = new Date(input);
  const day = d.getDay();
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  d.setHours(0, 0, 0, 0);
  return d;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function endOfMonth(y: number, m: number): Date {
  return new Date(y, m + 1, 0);
}

type Line = "consultor" | "supervision" | "connector";
type Tally = Record<Line, number>;

const blank = (): Tally => ({ consultor: 0, supervision: 0, connector: 0 });
const sum = (t: Tally) => t.consultor + t.supervision + t.connector;

interface ProjRow {
  id: string;
  clientId: string;
  type: string;
  status: string;
  kickoff: string;
  sold: Tally;
  billed: Tally;
  planned: Tally;
  byUser: Record<string, { billed: number; planned: number }>;
  rate: number;
  supervisionRate: number;
}

export default function BacklogPanel({
  entries, projects, clientNames, typeNames, people, supRoles,
  hourProjects, hoursPerDay,
  scope, anchor, rangeFrom, rangeTo, mainRoleByService, asOf: asOfProp,
}: Props) {
  const [chartMode, setChartMode] = useState<"days" | "value">("days");
  /** Cards read in days by default; three of them flip to the h + d split. */
  const [unitMode, setUnitMode] = useState<"days" | "split">("days");
  const hpd = hoursPerDay > 0 ? hoursPerDay : 8;
  const isHourly = (id: string) => hourProjects.has(id);
  const inDays = (id: string, x: number) => (isHourly(id) ? x / hpd : x);
  const [chartOpen, setChartOpen] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [onlyLeft, setOnlyLeft] = useState(true);

  /** Which contracted bucket an entry eats into. Mirrors the team panel's rate logic. */
  const lineOf = (p: BkProj, line: string, userId: string): Line => {
    if (line === "connector") return "connector";
    const member = (p.team ?? []).find((m) => m.userId === userId);
    if (line === "supervision" || supRoles.has(member?.role ?? "")) return "supervision";
    return "consultor";
  };

  /** The team member holding the service's "main" role — the project's owner. */
  const ownerOf = (p: BkProj): string | null => {
    const mainRole = mainRoleByService[p.typeId];
    if (!mainRole) return null;
    return (p.team ?? []).find((m) => m.role === mainRole)?.userId ?? null;
  };
  /** True if this consultant holds a supervision-tagged role on the project's team. */
  const isSupervisorOn = (p: BkProj, userId: string): boolean =>
    (p.team ?? []).some((m) => m.userId === userId && supRoles.has(m.role ?? ""));

  const [consultantFilter, setConsultantFilter] = useState<string>("");

  /** Everything is measured as of the close of the selected period, not "now". */
  const asOf = asOfProp || iso(new Date());

  const rows = useMemo<ProjRow[]>(() => {
    const acc: Record<string, ProjRow> = {};
    Object.values(projects).forEach((p) => {
      // A project only enters the backlog once it has kicked off.
      if (p.kickoff && p.kickoff > asOf) return;
      acc[p.id] = {
        id: p.id,
        clientId: p.clientId,
        type: typeNames[p.typeId] || "No project type",
        status: p.status,
        kickoff: p.kickoff,
        sold: {
          consultor: p.consultorDays,
          supervision: p.supervisionDays,
          connector: p.connectorDays,
        },
        billed: blank(),
        planned: blank(),
        byUser: {},
        rate: p.rate,
        supervisionRate: p.supervision,
      };
    });

    // Cumulative up to the period close: everything logged on or before asOf.
    entries.forEach((e) => {
      if (e.status === "cancelled" || e.line === "closure") return;
      if (!e.projectId || !e.userId) return;
      if (e.date && e.date > asOf) return;
      const p = projects[e.projectId];
      const row = acc[e.projectId];
      if (!p || !row) return;

      const bucket = lineOf(p, e.line, e.userId);
      const done = e.status === "confirmed";
      if (done) row.billed[bucket] += e.billable;
      else row.planned[bucket] += e.billable;

      if (!row.byUser[e.userId]) row.byUser[e.userId] = { billed: 0, planned: 0 };
      if (done) row.byUser[e.userId].billed += e.billable;
      else row.byUser[e.userId].planned += e.billable;
    });

    return Object.values(acc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, projects, typeNames, supRoles, asOf]);

  /** Still to deliver = sold minus what's already billed. Scheduled days still count as pending. */
  const availableOf = (r: ProjRow): Tally => ({
    consultor: Math.max(0, r.sold.consultor - r.billed.consultor),
    supervision: Math.max(0, r.sold.supervision - r.billed.supervision),
    connector: Math.max(0, r.sold.connector - r.billed.connector),
  });
  const valueOf = (r: ProjRow, t: Tally) =>
    t.consultor * r.rate + t.connector * r.rate + t.supervision * r.supervisionRate;

  const visible = rows
    .filter((r) => {
      if (sum(r.sold) === 0) return false;
      if (onlyLeft && sum(availableOf(r)) <= 0.001) return false;
      if (consultantFilter) {
        const p = projects[r.id];
        if (!p) return false;
        const owns = ownerOf(p) === consultantFilter;
        const supervises = isSupervisorOn(p, consultantFilter);
        if (!owns && !supervises) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ca = (clientNames[a.clientId] ?? "").localeCompare(clientNames[b.clientId] ?? "");
      if (ca !== 0) return ca;
      return valueOf(b, availableOf(b)) - valueOf(a, availableOf(a));
    });

  const clientCount = new Set(visible.map((r) => r.clientId)).size;

  /** Every consultant worth offering in the filter: owns at least one project
      with something still to deliver, or supervises one. */
  const consultantOptions = useMemo(() => {
    const ids = new Set<string>();
    rows.forEach((r) => {
      const p = projects[r.id];
      if (!p || sum(r.sold) === 0) return;
      const owner = ownerOf(p);
      if (owner) ids.add(owner);
      (p.team ?? []).forEach((m) => { if (m.userId && supRoles.has(m.role ?? "")) ids.add(m.userId); });
    });
    return Array.from(ids)
      .map((id) => ({ id, name: people[id] || "Unknown" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, projects, people, supRoles, mainRoleByService]);

  /** For the selected consultant: consultancy backlog comes only from projects
      they OWN (their main-role assignment), and never counts connector or
      supervision lines. Supervision backlog is separate — it comes from any
      project (owned or not) where they hold a supervision-tagged role. */
  const myBreakdown = useMemo(() => {
    if (!consultantFilter) return null;
    let consultDays = 0, consultValue = 0, superDays = 0, superValue = 0;
    rows.forEach((r) => {
      if (sum(r.sold) === 0) return;
      if (onlyLeft && sum(availableOf(r)) <= 0.001) return;
      const p = projects[r.id];
      if (!p) return;
      const avail = availableOf(r);
      if (ownerOf(p) === consultantFilter) {
        consultDays += inDays(r.id, avail.consultor);
        consultValue += avail.consultor * r.rate;
      }
      if (isSupervisorOn(p, consultantFilter)) {
        superDays += inDays(r.id, avail.supervision);
        superValue += avail.supervision * r.supervisionRate;
      }
    });
    return { consultDays, consultValue, superDays, superValue };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consultantFilter, rows, projects, onlyLeft, mainRoleByService, supRoles]);

  /** Consultancy backlog that can't be attributed to anyone yet — the project's
      service has no "main" role set in Products & Services, or nobody on the
      team holds that role. This is why summing every consultant's personal
      backlog can land below the panel's overall total: this slice sits in the
      total but is invisible in every individual view until it's assigned. */
  const unownedBacklog = useMemo(() => {
    let days = 0, value = 0, projectCount = 0;
    rows.forEach((r) => {
      if (sum(r.sold) === 0) return;
      if (onlyLeft && sum(availableOf(r)) <= 0.001) return;
      const p = projects[r.id];
      if (!p) return;
      if (ownerOf(p) !== null) return;
      const avail = availableOf(r);
      if (avail.consultor <= 0.001) return;
      days += inDays(r.id, avail.consultor);
      value += avail.consultor * r.rate;
      projectCount += 1;
    });
    return { days, value, projectCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, projects, onlyLeft, mainRoleByService]);

  const totalSold = visible.reduce((s, r) => s + inDays(r.id, sum(r.sold)), 0);
  const totalBilled = visible.reduce((s, r) => s + inDays(r.id, sum(r.billed)), 0);
  const totalPlanned = visible.reduce((s, r) => s + inDays(r.id, sum(r.planned)), 0);
  const totalAvailable = visible.reduce((s, r) => s + inDays(r.id, sum(availableOf(r))), 0);
  const totalValue = visible.reduce((s, r) => s + valueOf(r, availableOf(r)), 0);

  // Split of what is still to deliver: genuine day-rate days vs hourly hours.
  const availDayDays = visible.filter((r) => !isHourly(r.id)).reduce((s, r) => s + sum(availableOf(r)), 0);
  const availHourHours = visible.filter((r) => isHourly(r.id)).reduce((s, r) => s + sum(availableOf(r)), 0);

  // Connector days bill on their own pool, so they get their own counter.
  const coreOf = (r: ProjRow) => {
    const a = availableOf(r);
    return { consultor: a.consultor, supervision: a.supervision, connector: 0 } as Tally;
  };
  const connOf = (r: ProjRow) => {
    const a = availableOf(r);
    return { consultor: 0, supervision: 0, connector: a.connector } as Tally;
  };
  const availCore = visible.reduce((s, r) => s + inDays(r.id, r.sold.consultor + r.sold.supervision - r.billed.consultor - r.billed.supervision), 0);
  const availConnector = visible.reduce((s, r) => s + inDays(r.id, availableOf(r).connector), 0);
  const valueCore = visible.reduce((s, r) => s + valueOf(r, coreOf(r)), 0);
  const valueConnector = visible.reduce((s, r) => s + valueOf(r, connOf(r)), 0);

  /** Average consultancy day-rate, weighted by consultancy days sold across live projects. */
  const avgDayRate = (() => {
    let daySum = 0, weighted = 0, count = 0, rateSum = 0;
    visible.forEach((r) => {
      if (r.rate > 0) { rateSum += r.rate; count += 1; }
      // Hourly: rate is €/hour and volume is hours — put both on a day basis.
      const days = inDays(r.id, r.sold.consultor);
      const dayRate = isHourly(r.id) ? r.rate * hpd : r.rate;
      if (days > 0 && dayRate > 0) { weighted += dayRate * days; daySum += days; }
    });
    const byDays = daySum > 0 ? weighted / daySum : 0;
    const simple = count > 0 ? rateSum / count : 0;
    return { byDays, simple, count, byHour: byDays / hpd };
  })();

  /** Last day anyone logged against each project — the closest thing to an end date we have. */
  const lastDay = useMemo(() => {
    const out: Record<string, string> = {};
    entries.forEach((e) => {
      if (e.status === "cancelled" || !e.projectId || !e.date) return;
      if (!out[e.projectId] || e.date > out[e.projectId]) out[e.projectId] = e.date;
    });
    return out;
  }, [entries]);

  const spans = Object.values(projects)
    .map((p) => {
      const end = lastDay[p.id];
      if (!p.kickoff || !end) return null;
      const a = new Date(`${p.kickoff}T00:00:00`).getTime();
      const b = new Date(`${end}T00:00:00`).getTime();
      const d = Math.round((b - a) / 86400000);
      return d >= 0 ? d : null;
    })
    .filter((d): d is number => d !== null);
  const avgSpan = spans.length ? spans.reduce((s, d) => s + d, 0) / spans.length : 0;
  const minSpan = spans.length ? Math.min(...spans) : 0;
  const maxSpan = spans.length ? Math.max(...spans) : 0;

  /* ---------- Backlog over time ---------- */
  /** Bucket closing dates for the selected period. Backlog is measured at each close. */
  const bounds = useMemo<{ label: string; end: string }[]>(() => {
    const out: { label: string; end: string }[] = [];
    const push = (label: string, d: Date) => out.push({ label, end: iso(d) });

    if (scope === "week") {
      const ws = startOfWeek(anchor);
      ["Mon", "Tue", "Wed", "Thu", "Fri"].forEach((n, i) => push(n, addDays(ws, i)));
    } else if (scope === "month") {
      const y = anchor.getFullYear(), m = anchor.getMonth();
      const last = endOfMonth(y, m);
      for (let k = 0; k < 5; k++) {
        const d = new Date(y, m, 7 + k * 7);
        push(`W${k + 1}`, d > last ? last : d);
        if (d >= last) break;
      }
    } else if (scope === "year") {
      const y = anchor.getFullYear();
      for (let m = 0; m < 12; m++) push(MONTHS_SHORT[m], endOfMonth(y, m));
    } else if (scope === "custom" && rangeFrom && rangeTo) {
      const a = new Date(`${rangeFrom}T00:00:00`);
      const b = new Date(`${rangeTo}T00:00:00`);
      const span = Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
      if (span <= 14) {
        for (let i = 0; i < span; i++) {
          const d = addDays(a, i);
          push(`${d.getDate()}`, d);
        }
      } else if (span <= 120) {
        let k = 1;
        for (let s = startOfWeek(a); s <= b; s = addDays(s, 7), k++) {
          const e = addDays(s, 6);
          push(`W${k}`, e > b ? b : e);
        }
      } else {
        for (let s = new Date(a.getFullYear(), a.getMonth(), 1); s <= b; s = new Date(s.getFullYear(), s.getMonth() + 1, 1)) {
          const e = endOfMonth(s.getFullYear(), s.getMonth());
          push(MONTHS_SHORT[s.getMonth()], e > b ? b : e);
        }
      }
    } else {
      // All time: monthly, from the first thing that ever happened up to now.
      const dates = entries.map((e) => e.date).filter(Boolean).sort();
      const kicks = Object.values(projects).map((p) => p.kickoff).filter(Boolean).sort();
      const first = [dates[0], kicks[0]].filter(Boolean).sort()[0];
      if (!first) return out;
      let s = new Date(`${first}T00:00:00`);
      s = new Date(s.getFullYear(), s.getMonth(), 1);
      const now = new Date();
      const cap = new Date(now.getFullYear(), now.getMonth(), 1);
      const all: { label: string; end: string }[] = [];
      for (; s <= cap; s = new Date(s.getFullYear(), s.getMonth() + 1, 1)) {
        const e = endOfMonth(s.getFullYear(), s.getMonth());
        all.push({ label: MONTHS_SHORT[s.getMonth()], end: iso(e > now ? now : e) });
      }
      return all.slice(-18);
    }
    return out;
  }, [scope, anchor, rangeFrom, rangeTo, entries, projects]);

  /** Backlog at each close: sold days of started projects minus what was billed by then. */
  const series = useMemo(() => {
    const confirmed = entries
      .filter((e) => e.status === "confirmed" && e.line !== "closure" && e.projectId && e.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    const billedSoFar: Record<string, Tally> = {};
    let i = 0;

    return bounds.map((b) => {
      while (i < confirmed.length && confirmed[i].date <= b.end) {
        const e = confirmed[i];
        const p = projects[e.projectId];
        if (p) {
          if (!billedSoFar[e.projectId]) billedSoFar[e.projectId] = blank();
          billedSoFar[e.projectId][lineOf(p, e.line, e.userId)] += e.billable;
        }
        i += 1;
      }

      let days = 0;
      let value = 0;
      Object.values(projects).forEach((p) => {
        if (p.kickoff && p.kickoff > b.end) return;
        const bl = billedSoFar[p.id] ?? blank();
        const c = Math.max(0, p.consultorDays - bl.consultor);
        const s = Math.max(0, p.supervisionDays - bl.supervision);
        const k = Math.max(0, p.connectorDays - bl.connector);
        days += c + s + k;
        value += c * p.rate + k * p.rate + s * p.supervision;
      });
      return { label: b.label, end: b.end, days, value };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, entries, projects, supRoles]);

  const chartKey = chartMode === "days" ? "days" : "value";
  const peak = Math.max(1, ...series.map((p) => p[chartKey]));
  const first = series.length ? series[0][chartKey] : 0;
  const last = series.length ? series[series.length - 1][chartKey] : 0;
  const delta = last - first;

  const CW = 1000;
  const CH = 150;
  const px = (i: number) => (series.length <= 1 ? CW / 2 : (i / (series.length - 1)) * CW);
  const py = (v: number) => CH - (v / (peak * 1.12)) * CH;
  const linePath = series.map((p, i) => `${i === 0 ? "M" : "L"} ${px(i).toFixed(1)} ${py(p[chartKey]).toFixed(1)}`).join(" ");
  const areaPath = series.length
    ? `${linePath} L ${px(series.length - 1).toFixed(1)} ${CH} L ${px(0).toFixed(1)} ${CH} Z`
    : "";
  const fmt = (v: number) => (chartMode === "days" ? v.toFixed(2) : Math.round(v).toLocaleString());

  const w = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);
  const deliveredPct = totalSold > 0 ? (totalBilled / totalSold) * 100 : 0;
  const scheduledPct = totalSold > 0 ? ((totalBilled + totalPlanned) / totalSold) * 100 : 0;
  const R = 34;
  const C = 2 * Math.PI * R;
  const arc = (p: number) => ({ strokeDasharray: `${(Math.min(100, p) / 100) * C} ${C}` });

  return (
    <div className="bk">
      <div className="bk-kpis bkc-row">
        <article className={`bkc bkc-gauge ${availHourHours > 0 ? "bkc-clickable" : ""}`}
          onClick={() => availHourHours > 0 && setUnitMode((m) => (m === "days" ? "split" : "days"))}
          title={availHourHours > 0 ? "Click to split hours from days" : undefined}>
          <div className="bkc-head">
            <span className="bkc-label">Days to deliver{availHourHours > 0 && <span className="bkc-flip">⇄</span>}</span>
            <span className="bkc-pct">{Math.round(deliveredPct)}<i>% billed</i></span>
          </div>
          <div className="bkc-gauge-body">
            <div className="bkc-ring">
              <svg viewBox="0 0 140 82" className="bkc-svg" aria-hidden="true">
                <path className="bkc-arc-bg" d="M16 70 A54 54 0 0 1 124 70" pathLength={169.65} />
                <path className="bkc-arc-proj" d="M16 70 A54 54 0 0 1 124 70" pathLength={169.65}
                  style={{ strokeDasharray: `${(169.65 * Math.min(1, scheduledPct / 100)).toFixed(2)} 169.65` }} />
                <path className="bkc-arc-fill" d="M16 70 A54 54 0 0 1 124 70" pathLength={169.65}
                  style={{ strokeDasharray: `${(169.65 * Math.min(1, deliveredPct / 100)).toFixed(2)} 169.65` }} />
              </svg>
              <span className="bkc-ring-mid"><b>{totalAvailable.toFixed(0)}</b><i>left</i></span>
            </div>
            <div className="bkc-figs">
              <span className="bkc-sub">of {totalSold.toFixed(0)} days sold</span>
              {unitMode === "split" && availHourHours > 0 ? (
                <div className="bkc-split">
                  <span><b>{availDayDays.toFixed(1)}</b>Days</span>
                  <span className="is-conn"><b>{availHourHours.toFixed(0)}</b>Hours</span>
                </div>
              ) : (
                <div className="bkc-split">
                  <span><b>{availCore.toFixed(1)}</b>Consultancy</span>
                  <span className="is-conn"><b>{availConnector.toFixed(1)}</b>Connector</span>
                </div>
              )}
            </div>
          </div>
        </article>

        <article className="bkc">
          <div className="bkc-head"><span className="bkc-label">Unbilled value</span></div>
          <span className="bkc-fig"><b>{Math.round(totalValue).toLocaleString()}</b><em>€</em></span>
          <div className="bkc-split">
            <span><b>{Math.round(valueCore).toLocaleString()}</b>Consultancy</span>
            <span className="is-conn"><b>{Math.round(valueConnector).toLocaleString()}</b>Connector</span>
          </div>
        </article>

        <article className="bkc">
          <div className="bkc-head"><span className="bkc-label">Avg project length</span></div>
          <span className="bkc-fig"><b>{Math.round(avgSpan)}</b><em>days</em></span>
          <div className="bkc-split bkc-split-3">
            <span><b>{minSpan}</b>Shortest</span>
            <span><b>{maxSpan}</b>Longest</span>
            <span className="is-conn"><b>{spans.length}</b>Projects</span>
          </div>
        </article>

        <article className={`bkc ${availHourHours > 0 ? "bkc-clickable" : ""}`}
          onClick={() => availHourHours > 0 && setUnitMode((m) => (m === "days" ? "split" : "days"))}
          title={availHourHours > 0 ? "Click to show the per-hour rate" : undefined}>
          <div className="bkc-head"><span className="bkc-label">Avg {unitMode === "split" && availHourHours > 0 ? "hour" : "day"} rate{availHourHours > 0 && <span className="bkc-flip">⇄</span>}</span></div>
          <span className="bkc-fig">
            <b>{Math.round(unitMode === "split" && availHourHours > 0 ? avgDayRate.byHour : avgDayRate.byDays).toLocaleString()}</b>
            <em>€/{unitMode === "split" && availHourHours > 0 ? "hour" : "day"}</em>
          </span>
          <div className="bkc-split">
            {unitMode === "split" && availHourHours > 0 ? (
              <>
                <span><b>{Math.round(avgDayRate.byHour).toLocaleString()}</b>Per hour</span>
                <span className="is-conn"><b>{Math.round(avgDayRate.byDays).toLocaleString()}</b>Per day</span>
              </>
            ) : (
              <>
                <span><b>{Math.round(avgDayRate.byDays).toLocaleString()}</b>Weighted</span>
                <span className="is-conn"><b>{Math.round(avgDayRate.simple).toLocaleString()}</b>Per project</span>
              </>
            )}
          </div>
        </article>
      </div>

      {series.length > 1 && (
        <div className={`bk-chart-card ${chartOpen ? "is-open" : "is-collapsed"}`}>
          <button className="bk-chart-toggle-row" onClick={() => setChartOpen((v) => !v)}>
            <span className="bk-kpi-label">Backlog over the period</span>
            <span className="bk-chart-toggle-right">
              <span className="bk-chart-peek"><b>{fmt(last)}</b> {chartMode === "days" ? "days left" : "€ left"} at close</span>
              <span className={`bk-chart-caret ${chartOpen ? "is-open" : ""}`}>›</span>
            </span>
          </button>
          {chartOpen && (<>
          <div className="bk-chart-head">
            <div>
              <span className="bk-kpi-label">Backlog over the period</span>
              <span className="bk-chart-now">
                <b>{fmt(last)}</b>
                <em>{chartMode === "days" ? "days left at close" : "€ left at close"}</em>
                <span className={`bk-delta ${delta > 0 ? "is-up" : delta < 0 ? "is-down" : ""}`}>
                  {delta > 0 ? "↑" : delta < 0 ? "↓" : "—"} {fmt(Math.abs(delta))} over the period
                </span>
              </span>
            </div>
            <div className="bk-chart-toggle" data-mode={chartMode}>
              <span className="bk-chart-slider" />
              <button className={chartMode === "days" ? "is-on" : ""} onClick={() => setChartMode("days")}>Days</button>
              <button className={chartMode === "value" ? "is-on" : ""} onClick={() => setChartMode("value")}>Value</button>
            </div>
          </div>

          <div
            className="bk-chart"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = (e.clientX - rect.left) / rect.width;
              const idx = Math.max(0, Math.min(series.length - 1, Math.round(frac * (series.length - 1))));
              setHover(idx);
            }}
            onMouseLeave={() => setHover(null)}
          >
            <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" className="bk-chart-svg">
              <defs>
                <linearGradient id="bkArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#12b57f" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="#12b57f" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={areaPath} fill="url(#bkArea)" />
              <path d={linePath} fill="none" stroke="#0a6f4d" strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </svg>
            {hover !== null && series[hover] && (
              <span className="bk-chart-guide" style={{ left: `${(px(hover) / CW) * 100}%` }} />
            )}
            <div className="bk-chart-dots">
              {series.map((p, i) => (
                <span
                  className={`bk-chart-dot ${hover === i ? "is-hover" : ""}`}
                  key={p.end}
                  style={{ left: `${(px(i) / CW) * 100}%`, top: `${(py(p[chartKey]) / CH) * 100}%` }}
                />
              ))}
              {hover !== null && series[hover] && (
                <div
                  className="bk-chart-tip"
                  style={{
                    left: `${(px(hover) / CW) * 100}%`,
                    top: `${(py(series[hover][chartKey]) / CH) * 100}%`,
                  }}
                >
                  <span className="bk-tip-label">{series[hover].label}</span>
                  <div className="bk-tip-rows">
                    <span className="bk-tip-row"><i>Days</i><b>{series[hover].days.toFixed(2)}</b></span>
                    <span className="bk-tip-row"><i>Value</i><b>{Math.round(series[hover].value).toLocaleString()} €</b></span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bk-chart-axis">
            {series.map((p) => <span key={p.end}>{p.label}</span>)}
          </div>
          </>)}
        </div>
      )}

      <div className="bk-toolbar">
        <p className="bk-note">
          As of <b>{asOf}</b> · {visible.length} {visible.length === 1 ? "project" : "projects"} across {clientCount} {clientCount === 1 ? "client" : "clients"} kicked off by then
        </p>
        <div className="bk-toolbar-right">
          <div className="bk-key">
            <span><i className="bk-k-billed" /> Billed</span>
            <span><i className="bk-k-planned" /> Scheduled</span>
            <span><i className="bk-k-free" /> Not booked</span>
          </div>
          <div className="bk-consultant-pick">
            <Select
              value={consultantFilter}
              onChange={setConsultantFilter}
              placeholder="All consultants"
              options={[{ value: "", label: "All consultants" }, ...consultantOptions.map((c) => ({ value: c.id, label: c.name }))]}
            />
          </div>
          <label className="bk-filter">
            <input type="checkbox" checked={onlyLeft} onChange={(e) => setOnlyLeft(e.target.checked)} />
            <span>Only projects with days left</span>
          </label>
        </div>
      </div>

      {myBreakdown && (
        <div className="bk-mine">
          <span className="bk-mine-who">
            <span className="bk-mine-av">{(people[consultantFilter] || "?").charAt(0).toUpperCase()}</span>
            {people[consultantFilter] || "This consultant"}'s backlog
          </span>
          <div className="bk-mine-figs">
            <div className="bk-mine-fig">
              <span className="bk-mine-k">Consultancy <i>· owned projects</i></span>
              <b>{myBreakdown.consultDays.toFixed(1)}<em>d</em></b>
              <span className="bk-mine-v">{Math.round(myBreakdown.consultValue).toLocaleString()} €</span>
            </div>
            <div className="bk-mine-fig is-super">
              <span className="bk-mine-k">Supervision <i>· assigned as supervisor</i></span>
              <b>{myBreakdown.superDays.toFixed(1)}<em>d</em></b>
              <span className="bk-mine-v">{Math.round(myBreakdown.superValue).toLocaleString()} €</span>
            </div>
            <div className="bk-mine-fig is-total">
              <span className="bk-mine-k">Total</span>
              <b>{(myBreakdown.consultDays + myBreakdown.superDays).toFixed(1)}<em>d</em></b>
              <span className="bk-mine-v">{Math.round(myBreakdown.consultValue + myBreakdown.superValue).toLocaleString()} €</span>
            </div>
          </div>
        </div>
      )}

      {unownedBacklog.days > 0.05 && (
        <div className="bk-unowned">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
          <span>
            <b>{unownedBacklog.days.toFixed(1)}d</b> ({Math.round(unownedBacklog.value).toLocaleString()} €) of consultancy backlog across{" "}
            <b>{unownedBacklog.projectCount}</b> project{unownedBacklog.projectCount === 1 ? "" : "s"} isn't owned by anyone yet — set a main role for
            {" "}the service in Products &amp; Services, or add that person to the project's team, and it'll show up under them here.
          </span>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="bk-empty">Nothing left to deliver. Every sold day is billed.</p>
      ) : (
        <div className="bk-list">
          <div className="bk-list-head">
            <span>Client &amp; project</span>
            <span className="bk-lh-prog">Progress</span>
            <span className="bk-r">Days left</span>
            <span className="bk-r">Value left</span>
            <span className="bk-lh-team">Team</span>
            <span />
          </div>
          {visible.map((r) => {
            const avail = availableOf(r);
            const sold = sum(r.sold);
            const isOpen = open === r.id;
            const u = isHourly(r.id) ? "h" : "d";
            const team = Object.entries(r.byUser)
              .sort((a, b) => (b[1].billed + b[1].planned) - (a[1].billed + a[1].planned));
            return (
              <div className={`bk-lrow-wrap ${isOpen ? "is-open" : ""}`} key={r.id}>
                <button className="bk-lrow" onClick={() => setOpen(isOpen ? null : r.id)}>
                  <span className="bk-lcell bk-lclient">
                    <span className="bk-lclient-name">{clientNames[r.clientId] ?? "—"}</span>
                    <span className="bk-lclient-type">{r.type}</span>
                  </span>

                  <span className="bk-lcell bk-lprog">
                    <span className="bk-lbar">
                      <span className="bk-lbar-billed" style={{ width: `${w(sum(r.billed), sold)}%` }}
                        title={`${sum(r.billed).toFixed(2)} billed`} />
                      <span className="bk-lbar-planned" style={{ width: `${w(sum(r.planned), sold)}%` }}
                        title={`${sum(r.planned).toFixed(2)} scheduled`} />
                    </span>
                    <span className="bk-lprog-txt">
                      {sum(r.billed).toFixed(1)} billed · {sum(r.planned).toFixed(1)} sched · {sold.toFixed(1)} sold {u}
                    </span>
                  </span>

                  <span className="bk-lcell bk-r bk-ldays"><b>{sum(avail).toFixed(2)}</b><u>{u}</u></span>
                  <span className="bk-lcell bk-r bk-lval">{Math.round(valueOf(r, avail)).toLocaleString()} €</span>

                  <span className="bk-lcell bk-lteam">
                    {team.length === 0 ? (
                      <em className="bk-lteam-none">—</em>
                    ) : (
                      <span className="bk-avs">
                        {team.slice(0, 4).map(([uid]) => (
                          <span className="bk-av" key={uid}>{(people[uid] ?? "?").charAt(0).toUpperCase()}</span>
                        ))}
                        {team.length > 4 && <span className="bk-av bk-av-more">+{team.length - 4}</span>}
                      </span>
                    )}
                  </span>

                  <span className={`bk-lchev ${isOpen ? "is-open" : ""}`}>›</span>
                </button>

                {isOpen && (
                  <div className="bk-ldetail">
                    <div className="bk-lchips">
                      {r.sold.consultor > 0 && <i>{r.sold.consultor} consultancy</i>}
                      {r.sold.supervision > 0 && <i>{r.sold.supervision} supervision</i>}
                      {r.sold.connector > 0 && <i className="is-conn">{r.sold.connector} connector</i>}
                    </div>
                    {team.length > 0 && (
                      <>
                        <div className="bk-dhead">
                          <span>Consultant</span>
                          <span className="bk-r">Billed</span>
                          <span className="bk-r">Scheduled</span>
                        </div>
                        {team.map(([uid, v]) => (
                          <div className="bk-dline" key={uid}>
                            <span className="bk-dwho">{people[uid] ?? "Unknown user"}</span>
                            <span className="bk-r bk-dbilled">{v.billed.toFixed(2)}</span>
                            <span className="bk-r bk-dplanned">{v.planned.toFixed(2)}</span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}