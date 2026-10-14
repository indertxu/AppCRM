import { useState, type CSSProperties, type MouseEvent as RMouseEvent } from "react";
import type { Agg, Measure } from "./salesReportEngine";

export type ChartType = "bar" | "hbar" | "stacked" | "donut" | "line" | "area" | "funnel";
export const CHART_LABEL: Record<ChartType, string> = {
  bar: "Columns", hbar: "Bars", stacked: "Stacked columns", donut: "Donut", line: "Line", area: "Area", funnel: "Funnel",
};
export const PALETTE = ["#1fb98a", "#0f8f62", "#e0a43c", "#6c8fb0", "#7fd9b4", "#d4a017", "#8b6fd6", "#2bb3c0", "#e0574b", "#a3b1aa", "#5b8f3e", "#c46a9a"];

export const fmtMeasure = (m: Measure, v: number) =>
  m === "count" ? Math.round(v).toLocaleString("es-ES")
  : m === "avgprob" ? `${Math.round(v)}%`
  : `${Math.round(v).toLocaleString("es-ES")} €`;
const fmtShort = (m: Measure, v: number) => {
  if (m === "count") return Math.round(v).toLocaleString("es-ES");
  if (m === "avgprob") return `${Math.round(v)}%`;
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toLocaleString("es-ES", { maximumFractionDigits: 1 })}M`;
  if (a >= 1e3) return `${(v / 1e3).toLocaleString("es-ES", { maximumFractionDigits: a >= 1e4 ? 0 : 1 })}k`;
  return Math.round(v).toLocaleString("es-ES");
};
/** A "nice" axis maximum and its 4 grid steps. */
function niceScale(max: number) {
  if (max <= 0) return { top: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = max / 4, pow = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / pow;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
  const top = step * 4;
  return { top, ticks: [0, step, step * 2, step * 3, top] };
}
const vars = (o: Record<string, string | number>) => o as CSSProperties;

interface Tip { x: number; y: number; title: string; lines: { color: string; name: string; value: string }[] }
function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="rc-tip" style={{ left: tip.x, top: tip.y }}>
      <b>{tip.title}</b>
      {tip.lines.map((l, i) => <span key={i}><i style={{ background: l.color }} />{l.name}<em>{l.value}</em></span>)}
    </div>
  );
}
const tipAt = (e: RMouseEvent, host: HTMLElement | null) => {
  const r = host?.getBoundingClientRect();
  return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
};

/* ---------- columns / bars / stacked ---------- */
function Bars({ agg, horizontal, stacked }: { agg: Agg; horizontal?: boolean; stacked?: boolean }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const totals = agg.labels.map((_, i) => agg.series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const max = stacked ? Math.max(0, ...totals) : Math.max(0, ...agg.series.flatMap((s) => s.values));
  const { top, ticks } = niceScale(max);
  const multi = agg.series.length > 1;
  const color = (si: number, li: number) => (multi ? PALETTE[si % PALETTE.length] : PALETTE[li % 2 === 0 ? 0 : 1]);
  const show = (e: RMouseEvent, i: number) => {
    const p = tipAt(e, host);
    setTip({ ...p, title: agg.labels[i], lines: agg.series.map((s, si) => ({ color: color(si, i), name: s.name, value: fmtMeasure(agg.measure, s.values[i] || 0) })).filter((l) => !multi || l.value !== fmtMeasure(agg.measure, 0)) });
  };
  if (horizontal) {
    return (
      <div className="rc rc-hbars" ref={setHost} onMouseLeave={() => setTip(null)}>
        {agg.labels.map((l, i) => (
          <div className="rc-hrow" key={agg.keys[i]} style={vars({ "--i": i })} onMouseMove={(e) => show(e, i)}>
            <span className="rc-hlabel" title={l}>{l}</span>
            <span className="rc-htrack">
              {agg.series.map((s, si) => (
                <i key={si} style={{ width: `${((s.values[i] || 0) / top) * 100}%`, background: color(si, i) }} />
              ))}
            </span>
            <b className="rc-hval">{fmtShort(agg.measure, totals[i])}</b>
          </div>
        ))}
        <TipBox tip={tip} />
      </div>
    );
  }
  return (
    <div className="rc rc-cols" ref={setHost} onMouseLeave={() => setTip(null)}>
      <div className="rc-grid">
        {ticks.slice().reverse().map((t) => <span key={t}><em>{fmtShort(agg.measure, t)}</em></span>)}
      </div>
      <div className="rc-plot">
        {agg.labels.map((l, i) => (
          <div className="rc-col" key={agg.keys[i]} onMouseMove={(e) => show(e, i)} style={vars({ "--i": i })}>
            <div className={`rc-stack ${stacked ? "is-stacked" : multi ? "is-grouped" : ""}`}>
              {agg.series.map((s, si) => (
                <i key={si} style={{ height: `${((s.values[i] || 0) / top) * 100}%`, background: color(si, i) }} />
              ))}
            </div>
            <span className="rc-xlabel" title={l}>{l}</span>
          </div>
        ))}
      </div>
      <TipBox tip={tip} />
    </div>
  );
}

/* ---------- donut ---------- */
function Donut({ agg }: { agg: Agg }) {
  const [hover, setHover] = useState<number | null>(null);
  const vals = agg.labels.map((_, i) => agg.series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const segs = vals.map((v, i) => { const s = { start: acc, len: (v / total) * 100, i }; acc += s.len; return s; });
  const h = hover != null ? hover : null;
  return (
    <div className="rc rc-donut">
      <div className="rc-donut-fig">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="44" className="rc-donut-bg" pathLength={100} />
          {segs.map((s) => (
            <circle key={s.i} cx="60" cy="60" r="44" pathLength={100} className={`rc-seg ${h === s.i ? "is-hover" : ""} ${h != null && h !== s.i ? "is-dim" : ""}`}
              style={vars({ stroke: PALETTE[s.i % PALETTE.length], "--len": Math.max(0, s.len - 0.6), "--start": s.start, "--i": s.i })}
              onMouseEnter={() => setHover(s.i)} onMouseLeave={() => setHover(null)} />
          ))}
        </svg>
        <div className="rc-donut-mid">
          <b>{fmtShort(agg.measure, h != null ? vals[h] : agg.measure === "avgprob" ? total / Math.max(1, vals.length) : total)}</b>
          <span>{h != null ? agg.labels[h] : agg.measure === "avgprob" ? "average" : "total"}</span>
        </div>
      </div>
      <ul className="rc-legend">
        {agg.labels.map((l, i) => (
          <li key={agg.keys[i]} className={h === i ? "is-hover" : ""} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <i style={{ background: PALETTE[i % PALETTE.length] }} />
            <span title={l}>{l}</span>
            <em>{fmtShort(agg.measure, vals[i])}</em>
            <small>{Math.round((vals[i] / total) * 100)}%</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- line / area ---------- */
function Line({ agg, area }: { agg: Agg; area?: boolean }) {
  const [hi, setHi] = useState<number | null>(null);
  const W = 600, H = 210, P = 8;
  const max = Math.max(0, ...agg.series.flatMap((s) => s.values));
  const { top, ticks } = niceScale(max);
  const n = agg.labels.length;
  const x = (i: number) => (n <= 1 ? W / 2 : P + (i * (W - P * 2)) / (n - 1));
  const y = (v: number) => H - (v / top) * (H - 12) - 2;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <div className="rc rc-line" onMouseLeave={() => setHi(null)}>
      <div className="rc-grid is-line">{ticks.slice().reverse().map((t) => <span key={t}><em>{fmtShort(agg.measure, t)}</em></span>)}</div>
      <div className="rc-lineplot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            {agg.series.map((_, si) => (
              <linearGradient key={si} id={`rc-g${si}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PALETTE[si % PALETTE.length]} stopOpacity="0.32" />
                <stop offset="100%" stopColor={PALETTE[si % PALETTE.length]} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {agg.series.map((s, si) => (
            <g key={si}>
              {area && <path className="rc-area" d={`${path(s.values)} L${x(n - 1)},${H} L${x(0)},${H} Z`} fill={`url(#rc-g${si})`} />}
              <path className="rc-path" d={path(s.values)} stroke={PALETTE[si % PALETTE.length]} pathLength={100} vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          {hi != null && <line x1={x(hi)} x2={x(hi)} y1="0" y2={H} className="rc-cursor" vectorEffect="non-scaling-stroke" />}
        </svg>
        {agg.series.map((s, si) => s.values.map((v, i) => (
          <span key={`${si}-${i}`} className={`rc-pt ${hi === i ? "is-on" : ""}`}
            style={{ left: `${(x(i) / W) * 100}%`, top: `${(y(v) / H) * 100}%`, background: PALETTE[si % PALETTE.length] }} />
        )))}
        <div className="rc-hit">
          {agg.labels.map((_, i) => <span key={i} onMouseEnter={() => setHi(i)} />)}
        </div>
        {hi != null && (
          <div className="rc-tip is-fixed" style={{ left: `${(x(hi) / W) * 100}%` }}>
            <b>{agg.labels[hi]}</b>
            {agg.series.map((s, si) => <span key={si}><i style={{ background: PALETTE[si % PALETTE.length] }} />{s.name}<em>{fmtMeasure(agg.measure, s.values[hi] || 0)}</em></span>)}
          </div>
        )}
      </div>
      <div className="rc-xaxis">
        {agg.labels.map((l, i) => <span key={i} style={{ left: `${(x(i) / W) * 100}%` }} className={n > 10 && i % Math.ceil(n / 8) !== 0 && i !== n - 1 ? "is-skip" : ""}>{l}</span>)}
      </div>
    </div>
  );
}

/* ---------- funnel ---------- */
function Funnel({ agg }: { agg: Agg }) {
  const vals = agg.labels.map((_, i) => agg.series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const max = Math.max(1, ...vals);
  return (
    <div className="rc rc-funnel">
      {agg.labels.map((l, i) => {
        const conv = i > 0 && vals[i - 1] > 0 ? Math.round((vals[i] / vals[i - 1]) * 100) : null;
        return (
          <div className="rc-fstep" key={agg.keys[i]} style={vars({ "--i": i })}>
            {conv != null && <span className="rc-fconv">↓ {conv}%</span>}
            <div className="rc-fbar" style={{ width: `${Math.max(8, (vals[i] / max) * 100)}%`, background: `linear-gradient(90deg, ${PALETTE[(i * 2) % PALETTE.length]}, ${PALETTE[(i * 2 + 1) % PALETTE.length]})` }}>
              <span>{l}</span><b>{fmtMeasure(agg.measure, vals[i])}</b>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ReportChart({ type, agg }: { type: ChartType; agg: Agg }) {
  if (!agg.labels.length) return <div className="rc-empty">No data for this chart with the current conditions.</div>;
  switch (type) {
    case "hbar": return <Bars agg={agg} horizontal />;
    case "stacked": return <Bars agg={agg} stacked />;
    case "donut": return <Donut agg={agg} />;
    case "line": return <Line agg={agg} />;
    case "area": return <Line agg={agg} area />;
    case "funnel": return <Funnel agg={agg} />;
    default: return <Bars agg={agg} />;
  }
}