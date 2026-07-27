/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
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
  scope: "week" | "month" | "year" | "all" | "custom";
  anchor: Date;
  rangeFrom: string;
  rangeTo: string;
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
  scope, anchor, rangeFrom, rangeTo,
}: Props) {
  const [chartMode, setChartMode] = useState<"days" | "value">("days");
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

  /** Everything is measured as of the close of the selected period, not "now". */
  const asOf = useMemo(() => {
    const today = iso(new Date());
    if (scope === "week") return iso(addDays(startOfWeek(anchor), 4));
    if (scope === "month") return iso(endOfMonth(anchor.getFullYear(), anchor.getMonth()));
    if (scope === "year") return `${anchor.getFullYear()}-12-31`;
    if (scope === "custom") return rangeTo || today;
    return today;
  }, [scope, anchor, rangeTo]);

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
      return true;
    })
    .sort((a, b) => {
      const ca = (clientNames[a.clientId] ?? "").localeCompare(clientNames[b.clientId] ?? "");
      if (ca !== 0) return ca;
      return valueOf(b, availableOf(b)) - valueOf(a, availableOf(a));
    });

  const clientCount = new Set(visible.map((r) => r.clientId)).size;

  const totalSold = visible.reduce((s, r) => s + sum(r.sold), 0);
  const totalBilled = visible.reduce((s, r) => s + sum(r.billed), 0);
  const totalPlanned = visible.reduce((s, r) => s + sum(r.planned), 0);
  const totalAvailable = visible.reduce((s, r) => s + sum(availableOf(r)), 0);
  const totalValue = visible.reduce((s, r) => s + valueOf(r, availableOf(r)), 0);

  // Connector days bill on their own pool, so they get their own counter.
  const coreOf = (r: ProjRow) => {
    const a = availableOf(r);
    return { consultor: a.consultor, supervision: a.supervision, connector: 0 } as Tally;
  };
  const connOf = (r: ProjRow) => {
    const a = availableOf(r);
    return { consultor: 0, supervision: 0, connector: a.connector } as Tally;
  };
  const availCore = visible.reduce((s, r) => s + r.sold.consultor + r.sold.supervision - r.billed.consultor - r.billed.supervision, 0);
  const availConnector = visible.reduce((s, r) => s + availableOf(r).connector, 0);
  const valueCore = visible.reduce((s, r) => s + valueOf(r, coreOf(r)), 0);
  const valueConnector = visible.reduce((s, r) => s + valueOf(r, connOf(r)), 0);

  /** Average consultancy day-rate, weighted by consultancy days sold across live projects. */
  const avgDayRate = (() => {
    let daySum = 0, weighted = 0, count = 0, rateSum = 0;
    visible.forEach((r) => {
      if (r.rate > 0) { rateSum += r.rate; count += 1; }
      const days = r.sold.consultor;
      if (days > 0 && r.rate > 0) { weighted += r.rate * days; daySum += days; }
    });
    const byDays = daySum > 0 ? weighted / daySum : 0;      // weighted by volume
    const simple = count > 0 ? rateSum / count : 0;         // plain average across projects
    return { byDays, simple, count };
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
      <div className="bk-kpis">
        <div className="bk-kpi">
          <div className="bk-ring">
            <svg viewBox="0 0 80 80" width="80" height="80">
              <defs>
                <linearGradient id="bkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#86efc0" />
                  <stop offset="100%" stopColor="#0a6f4d" />
                </linearGradient>
              </defs>
              <g transform="rotate(-90 40 40)">
                <circle cx="40" cy="40" r={R} className="bk-ring-bg" />
                <circle cx="40" cy="40" r={R} className="bk-ring-sch" style={arc(scheduledPct)} />
                <circle cx="40" cy="40" r={R} className="bk-ring-fg" stroke="url(#bkGrad)" style={arc(deliveredPct)} />
              </g>
              <text x="40" y="38" className="bk-ring-num" textAnchor="middle">
                {Math.round(deliveredPct)}<tspan className="bk-ring-pct">%</tspan>
              </text>
              <text x="40" y="53" className="bk-ring-cap" textAnchor="middle">billed</text>
            </svg>
          </div>
          <div className="bk-kpi-body">
            <span className="bk-kpi-label">Days still to deliver</span>
            <span className="bk-kpi-fig">
              <b>{totalAvailable.toFixed(2)}</b>
              <em>of {totalSold.toFixed(2)} sold</em>
              {series.length > 1 && (
                <span className={`bk-delta ${delta > 0 ? "is-up" : delta < 0 ? "is-down" : ""}`}>
                  {delta > 0 ? "↑" : delta < 0 ? "↓" : "—"} {Math.abs(delta).toFixed(2)}
                </span>
              )}
            </span>
            <span className="bk-breakdown">
              <span className="bk-bd-item" title="Consultancy plus supervision days">
                <b>{availCore.toFixed(2)}</b>
                <i>Consultancy</i>
              </span>
              <span className="bk-bd-item is-conn">
                <b>{availConnector.toFixed(2)}</b>
                <i>Connector</i>
              </span>
            </span>
          </div>
        </div>

        <div className="bk-kpi">
          <div className="bk-kpi-body">
            <span className="bk-kpi-label">Unbilled value</span>
            <span className="bk-kpi-fig">
              <b>{Math.round(totalValue).toLocaleString()}</b>
              <em>€</em>
            </span>
            <span className="bk-breakdown">
              <span className="bk-bd-item" title="Consultancy plus supervision, at their own rates">
                <b>{Math.round(valueCore).toLocaleString()}</b>
                <i>Consultancy</i>
              </span>
              <span className="bk-bd-item is-conn">
                <b>{Math.round(valueConnector).toLocaleString()}</b>
                <i>Connector</i>
              </span>
            </span>
          </div>
        </div>

        <div className="bk-kpi">
          <div className="bk-kpi-body">
            <span className="bk-kpi-label">Average project length</span>
            <span className="bk-kpi-fig">
              <b>{Math.round(avgSpan)}</b>
              <em>days</em>
            </span>
            <span className="bk-breakdown">
              <span className="bk-bd-item">
                <b>{minSpan}</b>
                <i>Shortest</i>
              </span>
              <span className="bk-bd-item">
                <b>{maxSpan}</b>
                <i>Longest</i>
              </span>
              <span className="bk-bd-item is-conn">
                <b>{spans.length}</b>
                <i>Projects</i>
              </span>
            </span>
          </div>
        </div>

        <div className="bk-kpi">
          <div className="bk-kpi-body">
            <span className="bk-kpi-label">Avg consultancy day rate</span>
            <span className="bk-kpi-fig">
              <b>{Math.round(avgDayRate.byDays).toLocaleString()}</b>
              <em>€ / day</em>
            </span>
            <span className="bk-breakdown">
              <span className="bk-bd-item" title="Weighted by consultancy days sold">
                <b>{Math.round(avgDayRate.byDays).toLocaleString()}</b>
                <i>Weighted</i>
              </span>
              <span className="bk-bd-item is-conn" title="Plain average across live projects">
                <b>{Math.round(avgDayRate.simple).toLocaleString()}</b>
                <i>Per project</i>
              </span>
            </span>
          </div>
        </div>
      </div>

      {series.length > 1 && (
        <div className="bk-chart-card">
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
          <label className="bk-filter">
            <input type="checkbox" checked={onlyLeft} onChange={(e) => setOnlyLeft(e.target.checked)} />
            <span>Only projects with days left</span>
          </label>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="bk-empty">Nothing left to deliver. Every sold day is billed.</p>
      ) : (
        <div className="bk-grid">
          {visible.map((r) => {
            const avail = availableOf(r);
            const sold = sum(r.sold);
            const isOpen = open === r.id;
            const team = Object.entries(r.byUser)
              .sort((a, b) => (b[1].billed + b[1].planned) - (a[1].billed + a[1].planned));
            return (
              <article className={`bk-card ${isOpen ? "is-open" : ""}`} key={r.id}>
                <div className="bk-card-top">
                  <span className="bk-card-id">
                    <span className="bk-card-client">{clientNames[r.clientId] ?? "—"}</span>
                    <span className="bk-card-type">{r.type}</span>
                  </span>
                  <span className="bk-card-val">{Math.round(valueOf(r, avail)).toLocaleString()} €</span>
                </div>

                <div className="bk-card-hero">
                  <b>{sum(avail).toFixed(2)}</b>
                  <em>days left</em>
                </div>

                <div className="bk-card-bar">
                  <span className="bk-s-billed" style={{ width: `${w(sum(r.billed), sold)}%` }}
                    title={`${sum(r.billed).toFixed(2)} billed`} />
                  <span className="bk-s-planned" style={{ width: `${w(sum(r.planned), sold)}%` }}
                    title={`${sum(r.planned).toFixed(2)} scheduled`} />
                </div>
                <div className="bk-card-scale">
                  <span>{sum(r.billed).toFixed(2)} billed · {sum(r.planned).toFixed(2)} scheduled</span>
                  <span>{sold.toFixed(2)} sold</span>
                </div>

                <div className="bk-card-chips">
                  {r.sold.consultor > 0 && <i>{r.sold.consultor} consultancy</i>}
                  {r.sold.supervision > 0 && <i>{r.sold.supervision} supervision</i>}
                  {r.sold.connector > 0 && <i className="is-conn">{r.sold.connector} connector</i>}
                </div>

                <button className="bk-card-foot" onClick={() => setOpen(isOpen ? null : r.id)}>
                  <span className="bk-avs">
                    {team.slice(0, 4).map(([uid]) => (
                      <span className="bk-av" key={uid}>{(people[uid] ?? "?").charAt(0).toUpperCase()}</span>
                    ))}
                  </span>
                  <span className="bk-foot-txt">
                    {team.length === 0 ? "No time logged" : `${team.length} ${team.length === 1 ? "consultant" : "consultants"}`}
                  </span>
                  <span className={`bk-chev ${isOpen ? "is-open" : ""}`}>›</span>
                </button>

                {isOpen && team.length > 0 && (
                  <div className="bk-detail">
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
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}