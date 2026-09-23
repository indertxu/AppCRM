import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import "./ConsultantModal.css";

/* The numbers are computed in ManagementPage (insightsFor / computeBonus /
   the capacity block) and handed in whole, so this file is presentation only.
   Props and exported types are unchanged from the previous version. */
export interface Insights {
  billableDays: number;
  billableAmount: number;
  clientUnbilledDays: number;
  internalDays: number;
  totalWorked: number;
  blendedRate: number;
  invoicedAmount: number;
  invoicedDays: number;
  availableDays: number;
  capUtilisation: number;
  utilisation: number;
  occupancy: number;
  idleDays: number;
  trend: { label: string; amount: number; days: number }[];
}
export interface BonusResult { amount: number; tier: 0 | 1 | 2; minMet: boolean; highMet: boolean; }
export interface CapView {
  minDays: number | null; minBilling: number | null; bonusPct1: number | null;
  highDays: number | null; highBilling: number | null; bonusPct2: number | null;
}
export interface CapWork { available: number; worked: number; billable: number; workedPct: number; billablePct: number; }

export interface ProjectRow {
  key: string;
  client: string;
  service: string;
  rateKind: string;
  rate: number;
  hourly: boolean;
  amountPlanned: number;
  daysPlanned: number;
  amountDone: number;
  daysDone: number;
}

interface Props {
  name: string;
  scopeLabel: string;
  scope: string;
  hoursPerDay: number;
  ins: Insights;
  cap: CapView | null;
  showBonus: boolean;
  bonusInvoiced: BonusResult;
  cw: CapWork | null;
  capMode: "worked" | "billable";
  onToggleCap: () => void;
  projectRows: ProjectRow[];
  projOpenKey: string | null;
  onToggleProject: (key: string) => void;
  renderLedger: (key: string) => ReactNode;
  onClose: () => void;
}

/* ------------------------------------------------------------------ helpers */

const eur = (n: number) => Math.round(n).toLocaleString();
const d2 = (n: number) => (+n.toFixed(2)).toLocaleString();
const pct0 = (n: number) => Math.round(n).toLocaleString();
const vars = (o: Record<string, string | number>) => o as CSSProperties;
const EXIT_MS = 300;

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const hueOf = (s: string) => {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};

/** Eased count-up. Starts from 0 on mount, then glides between values on change. */
function useCountUp(target: number, ms = 1100, delay = 0) {
  const [value, setValue] = useState(() => (reducedMotion() ? target : 0));
  const from = useRef(value);
  useEffect(() => {
    if (reducedMotion()) { from.current = target; setValue(target); return; }
    let raf = 0;
    const startFrom = from.current;
    const t0 = performance.now() + delay;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - t0) / ms));
      const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      const cur = startFrom + (target - startFrom) * e;
      from.current = cur;
      setValue(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, delay]);
  return value;
}

function Count({ value, format = eur, delay = 0 }: { value: number; format?: (n: number) => string; delay?: number }) {
  return <>{format(useCountUp(value, 1100, delay))}</>;
}

/** Flips true shortly after mount so CSS transitions have a start state to move from. */
function useArmed(ms: number) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), reducedMotion() ? 0 : ms);
    return () => window.clearTimeout(t);
  }, [ms]);
  return armed;
}

const useSvgId = () => useId().replace(/[^a-zA-Z0-9_-]/g, "");

/** Catmull-Rom → cubic Bézier, clamped to the plot so curves never dip below zero. */
function smoothPath(p: [number, number][], h: number) {
  if (p.length === 0) return "";
  const c = (v: number) => Math.min(h, Math.max(0, v));
  const f = (n: number) => n.toFixed(2);
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = c(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = c(p2[1] - (p3[1] - p1[1]) / 6);
    d += ` C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

const ICON = {
  rate: "M12 3v18M16.5 6.5H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7",
  clock: "M12 7.5V12l3 2M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0z",
  invoice: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  bonus: "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z",
  left: "M6 3h12M6 21h12M7 3c0 4.5 5 6 5 9s-5 4.5-5 9M17 3c0 4.5-5 6-5 9s5 4.5 5 9",
  swap: "M16 3l4 4-4 4M4 7h16M8 21l-4-4 4-4M20 17H4",
  arrowL: "M19 12H5M11 18l-6-6 6-6",
  arrowR: "M5 12h14M13 6l6 6-6 6",
  chevL: "M15 18l-6-6 6-6",
  chevR: "M9 6l6 6-6 6",
  x: "M18 6L6 18M6 6l12 12",
};
function Icon({ d, w = 2 }: { d: string; w?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/* ------------------------------------------------------------ sub-components */

const SLICE_COLOR: Record<string, string> = {
  bill: "#0a6f4d", unbilled: "#e0a43c", internal: "#8fa39b", idle: "#d5ddd9",
};

function UtilisationCard({ ins, armed }: { ins: Insights; armed: boolean }) {
  const [hot, setHot] = useState<string | null>(null);
  const slices = [
    { key: "bill", label: "Billable", days: ins.billableDays },
    { key: "unbilled", label: "Client, unbilled", days: ins.clientUnbilledDays },
    { key: "internal", label: "Internal", days: ins.internalDays },
    { key: "idle", label: "Idle", days: ins.idleDays },
  ].filter((s) => s.days > 0.01);
  const totalDays = slices.reduce((sum, s) => sum + s.days, 0);
  const barBase = ins.availableDays > 0 ? ins.availableDays : (ins.totalWorked || 1);
  const base = Math.max(barBase, totalDays, 0.0001);

  let acc = 0;
  const segs = slices.map((s, i) => {
    const pct = (s.days / base) * 100;
    const seg = { ...s, pct, offset: acc, i };
    acc += pct;
    return seg;
  });
  const gap = segs.length > 1 ? 0.9 : 0;
  const hotSeg = segs.find((s) => s.key === hot) ?? null;
  const billPct = (ins.billableDays / base) * 100;

  return (
    <section className="cm-card cm-util-card" data-spot="">
      <header className="cm-card-h">
        <h3>Where the time went</h3>
        <span className="cm-card-sub">
          {d2(totalDays)}d logged{ins.availableDays > 0 && <> of {d2(ins.availableDays)}d available</>}
        </span>
      </header>
      {segs.length === 0 ? (
        <p className="cm-empty">No time logged in this period.</p>
      ) : (
        <div className="cm-util">
          <div className={`cm-donut ${hot ? "has-hot" : ""}`}>
            <svg viewBox="0 0 42 42" aria-hidden="true">
              <circle className="cm-donut-track" cx="21" cy="21" r="15.9155" />
              {segs.map((s) => {
                const len = Math.max(0, s.pct - gap);
                return (
                  <circle
                    key={s.key}
                    className={`cm-donut-seg ${hot === s.key ? "is-hot" : ""}`}
                    cx="21" cy="21" r="15.9155"
                    stroke={SLICE_COLOR[s.key]}
                    style={vars({
                      "--i": s.i,
                      strokeDasharray: armed ? `${len} ${100 - len}` : "0 100",
                      strokeDashoffset: armed ? -s.offset : 0,
                    })}
                    onPointerEnter={() => setHot(s.key)}
                    onPointerLeave={() => setHot(null)}
                  />
                );
              })}
            </svg>
            <div className="cm-donut-c" key={hotSeg?.key ?? "default"}>
              {hotSeg ? (
                <>
                  <b>{pct0(hotSeg.pct)}<em>%</em></b>
                  <span>{hotSeg.label.toLowerCase()}</span>
                  <small>{d2(hotSeg.days)} days</small>
                </>
              ) : (
                <>
                  <b><Count value={billPct} format={pct0} delay={350} /><em>%</em></b>
                  <span>billable</span>
                  <small>{d2(ins.billableDays)} days</small>
                </>
              )}
            </div>
          </div>
          <ul className="cm-legend">
            {segs.map((s) => (
              <li
                key={s.key}
                className={`cm-leg ${hot === s.key ? "is-hot" : ""}`}
                style={vars({ "--c": SLICE_COLOR[s.key], "--w": `${armed ? Math.min(100, s.pct) : 0}%`, "--i": s.i })}
                onPointerEnter={() => setHot(s.key)}
                onPointerLeave={() => setHot(null)}
              >
                <i className="cm-leg-dot" />
                <span className="cm-leg-label">{s.label}</span>
                <b className="cm-leg-val">{d2(s.days)}d</b>
                <span className="cm-leg-bar"><i /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function TrendCard({ trend }: { trend: Insights["trend"] }) {
  const gid = useSvgId();
  const [hover, setHover] = useState<number | null>(null);
  const n = trend.length;
  const H = 40;

  const model = useMemo(() => {
    const max = Math.max(1, ...trend.map((t) => t.amount));
    const pts = trend.map((t, i) => [n === 1 ? 50 : (i / (n - 1)) * 100, H - (t.amount / max) * (H - 6)] as [number, number]);
    const linePts: [number, number][] = n === 1 ? [[0, pts[0][1]], [100, pts[0][1]]] : pts;
    const line = smoothPath(linePts, H);
    const peak = trend.reduce((best, t, i) => (t.amount > trend[best].amount ? i : best), 0);
    const total = trend.reduce((s, t) => s + t.amount, 0);
    return { max, pts, line, area: `${line} L100,${H} L0,${H} Z`, peak, total };
  }, [trend, n]);

  const step = n <= 12 ? 1 : n <= 26 ? 2 : Math.ceil(n / 12);
  const active = hover ?? model.peak;

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(n === 1 ? 0 : Math.round(f * (n - 1)));
  };

  return (
    <section className="cm-card cm-trend-card" data-spot="">
      <header className="cm-card-h">
        <h3>Billing over time</h3>
        {n > 0 && <span className="cm-card-sub">{eur(model.total)} € across {n} {n === 1 ? "period" : "periods"}</span>}
      </header>
      {n === 0 ? (
        <p className="cm-empty">No billed work in this range yet.</p>
      ) : (() => {
        const t = trend[active];
        const [ax, ay] = model.pts[active];
        const topPct = (ay / H) * 100;
        return (
          <>
            <div className="cm-trend-plot" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
              <div className="cm-trend-grid" aria-hidden="true"><i /><i /><i /><i /></div>
              <div className="cm-trend-draw">
                <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id={`a${gid}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#12a877" stopOpacity="0.32" />
                      <stop offset="100%" stopColor="#12a877" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id={`l${gid}`} x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#0a6f4d" />
                      <stop offset="100%" stopColor="#1fb98a" />
                    </linearGradient>
                  </defs>
                  <path d={model.area} fill={`url(#a${gid})`} />
                  <path d={model.line} fill="none" stroke={`url(#l${gid})`} className="cm-trend-line" vectorEffect="non-scaling-stroke" />
                </svg>
              </div>
              <span className={`cm-trend-guide ${hover !== null ? "is-on" : ""}`} style={{ left: `${ax}%` }} />
              <span className={`cm-trend-dot ${hover === null ? "is-peak" : ""}`} style={{ left: `${ax}%`, top: `${topPct}%` }} />
              <div
                className={`cm-trend-tip ${topPct < 45 ? "is-below" : ""}`}
                style={{ left: `clamp(64px, ${ax}%, calc(100% - 64px))`, top: `${topPct}%` }}
              >
                <span>{hover === null ? `Best period, ${t.label}` : t.label}</span>
                <b>{eur(t.amount)} €</b>
                <small>{d2(t.days)} days billed</small>
              </div>
            </div>
            <div className="cm-trend-x" aria-hidden="true">
              {trend.map((pt, i) =>
                i % step === 0 || i === n - 1 ? (
                  <span
                    key={i}
                    className={`${i === active ? "is-on" : ""} ${i === 0 ? "is-first" : ""} ${i === n - 1 ? "is-last" : ""}`}
                    style={{ left: `${model.pts[i][0]}%` }}
                  >
                    {pt.label}
                  </span>
                ) : null
              )}
            </div>
          </>
        );
      })()}
    </section>
  );
}

function BonusCard({
  invoiced, minB, highB, bonus, need, armed,
}: { invoiced: number; minB: number; highB: number; bonus: BonusResult; need: string | null; armed: boolean }) {
  const scale = Math.max(highB, minB, invoiced, 1) * 1.06;
  const at = (v: number) => Math.min(100, (v / scale) * 100);
  const flag = (v: number) => Math.min(96, Math.max(4, at(v)));
  const fill = armed ? at(invoiced) : 0;
  /* Keep marker labels inside the track and stack them when they sit close together. */
  const edge = (x: number) => (x > 82 ? "is-end" : x < 18 ? "is-start" : "");
  const stacked = minB > 0 && highB > 0 && Math.abs(flag(highB) - flag(minB)) < 24;
  const heading = bonus.highMet ? "Top tier reached" : bonus.minMet ? "On the way to the top tier" : "On the way to the bonus minimum";

  return (
    <section className="cm-card cm-bonus-card" data-spot="">
      <header className="cm-card-h">
        <h3>{heading}</h3>
        {need ? <span className="cm-need">Needs {need} more</span>
          : <span className="cm-card-sub">{eur(invoiced)} € invoiced so far</span>}
      </header>
      <div className={`cm-btrack ${stacked ? "is-stacked" : ""}`} style={vars({ "--w": `${fill}%` })}>
        <div className="cm-bfill" />
        {minB > 0 && (
          <span className={`cm-bmark ${invoiced >= minB ? "is-hit" : ""} ${edge(flag(minB))}`} style={{ left: `${flag(minB)}%` }}>
            <span>Minimum {eur(minB)} €</span>
          </span>
        )}
        {highB > 0 && (
          <span className={`cm-bmark ${invoiced >= highB ? "is-hit" : ""} ${edge(flag(highB))} ${stacked ? "is-low" : ""}`} style={{ left: `${flag(highB)}%` }}>
            <span>Top tier {eur(highB)} €</span>
          </span>
        )}
        <span className="cm-bnow"><span>{eur(invoiced)} €</span></span>
      </div>
    </section>
  );
}

function StatCard({
  i, icon, label, onClick, swapTo, value, unit, sub, meter, tag, tone,
}: {
  i: number; icon: string; label: string; onClick?: () => void; swapTo?: string;
  value: ReactNode; unit?: string; sub?: ReactNode; meter?: number; tag?: ReactNode; tone?: string;
}) {
  const body = (
    <>
      <span className="cm-stat-k">
        <span className="cm-stat-ico"><Icon d={icon} /></span>
        <span className="cm-stat-label">{label}</span>
        {swapTo && <span className="cm-swap"><Icon d={ICON.swap} w={2.2} />{swapTo}</span>}
      </span>
      <span className="cm-stat-v">{value}{unit && <em>{unit}</em>}</span>
      {sub && <span className="cm-stat-s">{sub}</span>}
      {tag}
      {meter !== undefined && (
        <span className="cm-stat-meter" style={vars({ "--w": `${Math.min(100, Math.max(0, meter))}%` })}><i /></span>
      )}
    </>
  );
  const cls = `cm-stat cm-rise ${tone ?? ""} ${onClick ? "is-action" : ""}`;
  return onClick ? (
    <button type="button" className={cls} data-spot="tilt" style={vars({ "--i": i })} onClick={onClick}>{body}</button>
  ) : (
    <div className={cls} data-spot="tilt" style={vars({ "--i": i })}>{body}</div>
  );
}

function ProjectView({
  row, index, count, onBack, onPrev, onNext, ledger,
}: {
  row: ProjectRow; index: number; count: number;
  onBack: () => void; onPrev: () => void; onNext: () => void; ledger: ReactNode;
}) {
  const gid = useSvgId();
  const u = row.hourly ? "h" : "d";
  const unitWord = row.hourly ? "hour" : "day";
  const done = row.amountPlanned > 0 ? (row.amountDone / row.amountPlanned) * 100
    : row.daysPlanned > 0 ? (row.daysDone / row.daysPlanned) * 100 : 0;
  const remAmt = Math.max(0, row.amountPlanned - row.amountDone);
  const remDays = Math.max(0, row.daysPlanned - row.daysDone);
  const arc = Math.min(100, Math.max(0, done));

  return (
    <div className="cm-pview" style={vars({ "--h": hueOf(row.client) })}>
      <div className="cm-phero">
        <div className="cm-phero-nav cm-rise" style={vars({ "--i": 0 })}>
          <button type="button" className="cm-back" onClick={onBack}>
            <Icon d={ICON.arrowL} w={2.2} />
            All projects
          </button>
          {count > 1 && (
            <div className="cm-pager">
              <button type="button" onClick={onPrev} disabled={index <= 0} aria-label="Previous project"><Icon d={ICON.chevL} w={2.4} /></button>
              <span>{index + 1} of {count}</span>
              <button type="button" onClick={onNext} disabled={index >= count - 1} aria-label="Next project"><Icon d={ICON.chevR} w={2.4} /></button>
            </div>
          )}
        </div>

        <div className="cm-phero-main">
          <div className="cm-phero-id cm-rise" style={vars({ "--i": 1 })}>
            <span className="cm-plogo is-lg">{(row.client || "?").charAt(0).toUpperCase()}</span>
            <div className="cm-phero-text">
              <h2 className="cm-title">{row.client}</h2>
              <div className="cm-chips">
                <span className="cm-chip">{row.service}</span>
                <span className="cm-chip">{row.rateKind}</span>
                <span className="cm-chip is-ghost">Billed per {unitWord}</span>
              </div>
            </div>
          </div>

          <div className="cm-ring cm-rise" style={vars({ "--i": 2 })}>
            <svg viewBox="0 0 42 42" aria-hidden="true">
              <defs>
                <linearGradient id={`r${gid}`} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#d6f7e6" />
                  <stop offset="100%" stopColor="#3fcf9a" />
                </linearGradient>
              </defs>
              <circle className="cm-ring-track" cx="21" cy="21" r="15.9155" />
              <circle className="cm-ring-arc" cx="21" cy="21" r="15.9155" stroke={`url(#r${gid})`} style={{ strokeDasharray: `${arc} ${100 - arc}` }} />
            </svg>
            <div className="cm-ring-c">
              <b><Count value={done} format={pct0} delay={300} /><em>%</em></b>
              <span>of booked billed</span>
            </div>
          </div>
        </div>

        <div className="cm-kpis">
          <StatCard i={3} icon={ICON.rate} label="Rate" value={<Count value={row.rate} />} unit={`€/${unitWord}`} sub={row.rateKind} />
          <StatCard i={4} icon={ICON.clock} label="Booked" value={<Count value={row.amountPlanned} />} unit="€" sub={`${d2(row.daysPlanned)}${u} planned`} />
          <StatCard i={5} icon={ICON.invoice} label="Billed" value={<Count value={row.amountDone} />} unit="€" sub={`${d2(row.daysDone)}${u} delivered`} meter={done} tone="is-good" />
          <StatCard i={6} icon={ICON.left} label="Left to bill" value={<Count value={remAmt} />} unit="€" sub={`${d2(remDays)}${u} still open`} />
        </div>
      </div>

      <div className="cm-sheet">
        <section className="cm-card cm-ledger-card cm-rise" style={vars({ "--i": 5 })}>
          <header className="cm-card-h">
            <h3>Every entry on this project</h3>
            <span className="cm-card-sub">{row.service}</span>
          </header>
          <div className="cm-ledger">{ledger}</div>
        </section>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- the modal */

export default function ConsultantModal({
  name, scopeLabel, scope, hoursPerDay, ins, cap, showBonus, bonusInvoiced, cw,
  capMode, onToggleCap, projectRows, projOpenKey, onToggleProject, renderLedger, onClose,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const projPaneRef = useRef<HTMLElement>(null);
  const armed = useArmed(260);
  const [rateMode, setRateMode] = useState<"day" | "hour">("day");

  /* Close plays the exit animation first, then tells the parent. */
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(() => onCloseRef.current(), reducedMotion() ? 0 : EXIT_MS);
  }, []);

  /* Project detail takes over the whole panel. The last opened row is kept
     so its content stays on screen while the panel slides back out. */
  const openRow = projectRows.find((r) => r.key === projOpenKey) ?? null;
  const lastRowRef = useRef<ProjectRow | null>(null);
  if (openRow) lastRowRef.current = openRow;
  const shownRow = openRow ?? lastRowRef.current;
  const inProject = openRow !== null;
  const shownIdx = shownRow ? projectRows.findIndex((r) => r.key === shownRow.key) : -1;

  const back = useCallback(() => { if (projOpenKey) onToggleProject(projOpenKey); }, [projOpenKey, onToggleProject]);
  const goTo = useCallback((idx: number) => {
    const r = projectRows[idx];
    if (r && r.key !== projOpenKey) onToggleProject(r.key);
  }, [projectRows, projOpenKey, onToggleProject]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (inProject) back(); else requestClose();
        return;
      }
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (!inProject || typing) return;
      if (e.key === "ArrowLeft") goTo(shownIdx - 1);
      if (e.key === "ArrowRight") goTo(shownIdx + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inProject, back, goTo, shownIdx, requestClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    if (projOpenKey) projPaneRef.current?.scrollTo({ top: 0 });
  }, [projOpenKey]);

  /* One pointer handler drives every cursor spotlight and card tilt. */
  const onSpot = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-spot]");
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    el.style.setProperty("--mx", `${x}px`);
    el.style.setProperty("--my", `${y}px`);
    if (el.dataset.spot === "tilt") {
      el.style.setProperty("--ry", `${(x / r.width - 0.5) * 9}deg`);
      el.style.setProperty("--rx", `${(0.5 - y / r.height) * 9}deg`);
    }
  };

  /* ---- derived numbers ---- */
  const initials = name.split(" ").filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const rateHour = hoursPerDay > 0 ? ins.blendedRate / hoursPerDay : 0;
  const bonusOn = showBonus && !!cap && scope !== "week" && scope !== "custom";
  const tierLabel = bonusInvoiced.tier === 2 ? "Top tier" : bonusInvoiced.tier === 1 ? "Minimum met" : "Below minimum";

  const daysGap = cap?.minDays != null ? cap.minDays - ins.invoicedDays : 0;
  const billGap = cap?.minBilling != null ? cap.minBilling - ins.invoicedAmount : 0;
  const need = !bonusInvoiced.minMet && (daysGap > 0 || billGap > 0)
    ? daysGap > 0 && billGap > 0 ? `${d2(daysGap)}d and ${eur(billGap)} €`
      : daysGap > 0 ? `${d2(daysGap)}d` : `${eur(billGap)} €`
    : null;

  const totals = projectRows.reduce(
    (t, r) => ({ booked: t.booked + r.amountPlanned, billed: t.billed + r.amountDone }),
    { booked: 0, billed: 0 },
  );

  return createPortal(
    <div className={`cm-root ${closing ? "is-closing" : ""}`}>
      <div className="cm-backdrop" onMouseDown={requestClose} />

      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`cm ${inProject ? "is-project" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={inProject && shownRow ? `${name}, ${shownRow.client}` : `${name} detail`}
        onPointerMove={onSpot}
      >
        <div className="cm-aurora" aria-hidden="true"><i /><i /><i /><span /></div>

        {/* Persistent top bar: breadcrumbs grow a second step in project view. */}
        <header className="cm-bar">
          <nav className="cm-crumbs" aria-label="Breadcrumb">
            <button type="button" className="cm-crumb" onClick={inProject ? back : undefined} tabIndex={inProject ? 0 : -1}>
              <span className="cm-av-sm">{initials}</span>
              <span className="cm-crumb-t">{name}</span>
            </button>
            {shownRow && (
              <span className="cm-crumb-leaf" aria-hidden={!inProject}>
                <Icon d={ICON.chevR} w={2.4} />
                <span className="cm-crumb-t">{shownRow.client}</span>
              </span>
            )}
          </nav>
          <span className="cm-scope"><i />{scopeLabel}</span>
          <button type="button" className="cm-x" onClick={requestClose} aria-label="Close">
            <Icon d={ICON.x} w={2.2} />
            <kbd>Esc</kbd>
          </button>
        </header>

        <div className="cm-stage">
          {/* ---------------- overview pane ---------------- */}
          <section className="cm-pane cm-pane-main" aria-hidden={inProject}>
            <div className="cm-hero">
              <div className="cm-hero-id cm-rise" style={vars({ "--i": 0 })}>
                <span className="cm-av-lg"><span>{initials}</span></span>
                <div>
                  <h2 className="cm-title">{name}</h2>
                  <div className="cm-chips">
                    <span className="cm-chip"><Count value={ins.totalWorked} format={d2} /> days worked</span>
                    <span className="cm-chip">{projectRows.length} {projectRows.length === 1 ? "project" : "projects"}</span>
                    <span className="cm-chip is-ghost">{hoursPerDay}h working day</span>
                  </div>
                </div>
              </div>

              <div className="cm-stats">
                <StatCard
                  i={1}
                  icon={ICON.rate}
                  label="Blended rate"
                  swapTo={rateMode === "day" ? "Per hour" : "Per day"}
                  onClick={() => setRateMode((m) => (m === "day" ? "hour" : "day"))}
                  value={<Count value={rateMode === "day" ? ins.blendedRate : rateHour} />}
                  unit={rateMode === "day" ? "€/day" : "€/hour"}
                  sub={rateMode === "day" ? `${eur(rateHour)} € per hour` : `${eur(ins.blendedRate)} € per day`}
                />

                {cw && cw.available > 0 && (
                  <StatCard
                    i={2}
                    icon={ICON.clock}
                    label={capMode === "worked" ? "Time booked" : "Billable share"}
                    swapTo={capMode === "worked" ? "Billable" : "Booked"}
                    onClick={onToggleCap}
                    value={<Count value={capMode === "worked" ? cw.workedPct : cw.billablePct} format={pct0} />}
                    unit="%"
                    sub={`${(capMode === "worked" ? cw.worked : cw.billable).toFixed(1)} of ${cw.available.toFixed(1)} hours`}
                    meter={capMode === "worked" ? cw.workedPct : cw.billablePct}
                  />
                )}

                <StatCard
                  i={3}
                  icon={ICON.invoice}
                  label="Invoiced"
                  value={<Count value={ins.invoicedAmount} />}
                  unit="€"
                  sub={`${d2(ins.invoicedDays)} days, of ${eur(ins.billableAmount)} € billable`}
                  meter={ins.billableAmount > 0 ? (ins.invoicedAmount / ins.billableAmount) * 100 : 0}
                />

                {bonusOn && (
                  <StatCard
                    i={4}
                    icon={ICON.bonus}
                    label="Bonus this period"
                    tone="is-bonus"
                    value={<Count value={bonusInvoiced.amount} />}
                    unit="€"
                    tag={
                      <span className={`cm-tier t${bonusInvoiced.tier}`}>
                        <span className="cm-tier-steps"><i /><i /></span>
                        {tierLabel}
                      </span>
                    }
                  />
                )}
              </div>
            </div>

            <div className="cm-sheet">
              <div className="cm-grid">
                <UtilisationCard ins={ins} armed={armed} />
                <TrendCard trend={ins.trend} />
              </div>

              {bonusOn && cap && (cap.minBilling != null || cap.highBilling != null) && (
                <BonusCard
                  invoiced={ins.invoicedAmount}
                  minB={cap.minBilling ?? 0}
                  highB={cap.highBilling ?? 0}
                  bonus={bonusInvoiced}
                  need={need}
                  armed={armed}
                />
              )}

              <section className="cm-projects">
                <header className="cm-card-h">
                  <h3>Projects <span className="cm-count">{projectRows.length}</span></h3>
                  {projectRows.length > 0 && (
                    <span className="cm-card-sub">{eur(totals.billed)} € billed of {eur(totals.booked)} € booked</span>
                  )}
                </header>

                {projectRows.length === 0 ? (
                  <p className="cm-empty">Nothing logged in this period. Time booked against a client will show up here.</p>
                ) : (
                  <>
                    <div className="cm-phead" aria-hidden="true">
                      <span>Client and project</span>
                      <span className="is-rate">Rate</span>
                      <span className="is-booked">Booked</span>
                      <span>Billed</span>
                      <span />
                    </div>
                    <div className="cm-plist">
                      {projectRows.map((v, i) => {
                        const u = v.hourly ? "h" : "d";
                        const p = v.amountPlanned > 0 ? (v.amountDone / v.amountPlanned) * 100 : 0;
                        return (
                          <button
                            type="button"
                            key={v.key}
                            className="cm-prow"
                            data-spot=""
                            style={vars({ "--i": Math.min(i, 14), "--h": hueOf(v.client), "--p": `${Math.min(100, p)}%` })}
                            onClick={() => onToggleProject(v.key)}
                            aria-label={`Open ${v.client}, ${v.service}`}
                          >
                            <span className="cm-p-id">
                              <span className="cm-plogo">{(v.client || "?").charAt(0).toUpperCase()}</span>
                              <span className="cm-p-name">
                                <b>{v.client}</b>
                                <small>{v.service}<i>{v.rateKind}</i></small>
                              </span>
                            </span>
                            <span className="cm-p-num is-rate">{eur(v.rate)}<small>per {v.hourly ? "hour" : "day"}</small></span>
                            <span className="cm-p-num is-booked">{eur(v.amountPlanned)}<small>{d2(v.daysPlanned)}{u}</small></span>
                            <span className="cm-p-num is-billed">{eur(v.amountDone)}<small>{d2(v.daysDone)}{u}</small></span>
                            <span className="cm-p-go"><Icon d={ICON.arrowR} w={2.2} /></span>
                            <span className="cm-p-prog"><i /></span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>
            </div>
          </section>

          {/* ---------------- project pane (full takeover) ---------------- */}
          <section ref={projPaneRef} className="cm-pane cm-pane-proj" aria-hidden={!inProject}>
            {shownRow && (
              <ProjectView
                key={shownRow.key}
                row={shownRow}
                index={shownIdx}
                count={projectRows.length}
                onBack={back}
                onPrev={() => goTo(shownIdx - 1)}
                onNext={() => goTo(shownIdx + 1)}
                ledger={renderLedger(shownRow.key)}
              />
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body
  );
}