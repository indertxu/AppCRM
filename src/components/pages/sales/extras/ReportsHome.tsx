/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Select from "../../../framework/Select";
import { ReportChart, PALETTE } from "./ReportCharts";
import ErrorBoundary from "../../../framework/ErrorBoundary";
import {
  entityOf, PERIODS, GROUP_LABEL, loadCrmData, buildCrmFields, buildCrmRows, aggregateCrm, testTree, toCell, showCell, sortValue,
  setReportPeriod, withPeriodTag, prettyRange, forgetCrmData, DEFAULT_REPORT_PERIOD, uid, partsUsed,
  type Field, type CrmRow, type Agg, type EntityKey,
} from "./salesReportEngine";
import { loadPrefs, savePref } from "../../companies/companiesApi";
import type { CrmReport } from "./SalesReport";
import { HomeBoard, firstFit, compactAll, type BoardItem, type BoardKit } from "../../homepage/HomePage";
import "./ReportsHome.css";

/* =====================================================================
   Reports › Home — the first thing Reports shows: your own board of
   figures, charts and short tables, each one read live from a saved
   report (yours or shared with you) or a ready-made one. The board is the
   home page's grid (HomeBoard): while customizing, each card is dragged
   anywhere and resized from its right / bottom edge; kept per user
   (profiles.prefs → reports_home, v2: each widget with its x / y / w / h).
   ===================================================================== */

export interface HomeSaved { id: string; name: string; owner_id: string | null; shared: boolean; updated_at: string; config: any }
export interface HomeTemplate { title: string; hint: string; make: () => CrmReport }
/** The old fixed widths (v1 boards), read once into the grid. */
type WSize = "s" | "m" | "l";
export type WShow = "figures" | "chart" | "table";
export interface Widget {
  id: string;
  /** Where it reads from: a saved report, or a ready-made one (by its title). */
  src: { saved?: string; tpl?: string };
  show: WShow;
  /** Which of the report's charts (its id; the position when the id is gone, e.g. a ready-made one). */
  chartId?: string | null; chartIdx?: number;
  size?: WSize;
  /** A table's rows. */
  rows?: number;
  /** Where it sits on the grid (24 columns × rows). */
  x?: number; y?: number; w?: number; h?: number;
}
interface Board { v: 2; widgets: Widget[] }
const PREF = "reports_home";
type Fig = { label: string; value: string; sub: string };
export type Res =
  | { state: "gone" }
  | { state: "error"; msg: string }
  | { state: "ok"; count: number; total: number; figs?: Fig[]; chart?: { title: string; type: any; agg: Agg }; noChart?: boolean; table?: { cols: { label: string; num: boolean }[]; rows: string[][] } };

const I = {
  plus: "M12 5v14M5 12h14", x: "M6 6l12 12M18 6L6 18", right: "M9 6l6 6-6 6", out: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5", sliders: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  check: "M5 12l5 5 9-10", reset: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5", home: "M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2", table: "M4 4h16v16H4zM4 10h16M4 15h16M10 4v16", hash: "M5 9h14M5 15h14M10 4L8 20M16 4l-2 16",
};
const Ico = ({ d, w = 2 }: { d: string; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const vars = (o: Record<string, string | number>) => o as CSSProperties;
/** A widget's starting size on the 24-column grid. */
const sizeOf = (w: Pick<Widget, "show" | "size">): [number, number] => {
  const cols = w.size === "s" ? 8 : w.size === "l" ? 24 : w.size === "m" ? 12 : w.show === "figures" ? 24 : 12;
  return [cols, w.show === "figures" ? 6 : 11];
};
/** Widgets without a place (a v1 board, a starter one, a new one): placed one after the other, top to bottom. */
function placeAll(ws: Widget[]): Widget[] {
  const placed: BoardItem[] = [];
  const out = ws.map((w) => {
    if (w.x != null && w.y != null && w.w && w.h) { placed.push({ id: w.id, key: "w", x: w.x, y: w.y, w: w.w, h: w.h }); return w; }
    const [cw, ch] = sizeOf(w);
    const at = firstFit(placed, cw, ch);
    placed.push({ id: w.id, key: "w", x: at.x, y: at.y, w: cw, h: ch });
    return { ...w, x: at.x, y: at.y, w: cw, h: ch };
  });
  return out;
}
const glabel = (g: string) => GROUP_LABEL[g as EntityKey] ?? g;

/** A widget's figures, chart or table, read from its report's rows (the report's own period, rules and sort). */
export function compute(w: Widget, r: CrmReport, rawFields: Field[], allRows: CrmRow[]): Res {
  setReportPeriod(r.period ?? DEFAULT_REPORT_PERIOD);
  const fields = rawFields.map((f) => { const l = withPeriodTag(f.label); return l === f.label ? f : ({ ...f, label: l } as Field); });
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const rows = r.filter ? allRows.filter((x) => testTree(r.filter, x, byKey)) : allRows;
  const base = { state: "ok" as const, count: rows.length, total: allRows.length };
  if (w.show === "figures") {
    const cols = (r.cols ?? []).map((k) => byKey.get(k)).filter((f): f is Field => !!f);
    const figs = r.figures ?? [{ id: "count", fn: "count", value: null }, ...cols.filter((f) => f.kind === "money").slice(0, 3).map((f) => ({ id: f.key, fn: "sum" as const, value: f.key }))];
    return {
      ...base, figs: figs.map((fg: any) => {
        const f = fg.value ? byKey.get(fg.value) : undefined;
        if (fg.fn === "count" || !f) return { label: fg.label || entityOf(r.source)?.plural || "Rows", value: rows.length.toLocaleString("en-GB"), sub: `of ${allRows.length.toLocaleString("en-GB")}` };
        const ns = rows.map((x) => Number(f.get(x as any))).filter((n) => Number.isFinite(n));
        const fn = fg.fn === "sum" && f.kind === "percent" ? "avg" : fg.fn;
        const v = !ns.length ? 0 : fn === "sum" ? ns.reduce((a, b) => a + b, 0) : fn === "avg" ? ns.reduce((a, b) => a + b, 0) / ns.length : fn === "min" ? Math.min(...ns) : Math.max(...ns);
        const word = ({ sum: "total", avg: "average", min: "lowest", max: "highest" } as Record<string, string>)[fn] ?? "";
        return { label: fg.label || r.labels?.[f.key] || f.label, value: showCell(f, v) || "0", sub: `${glabel(f.group)} · ${word}` };
      }),
    };
  }
  if (w.show === "chart") {
    const ch = (w.chartId && r.charts.find((c) => c.id === w.chartId)) || r.charts[w.chartIdx ?? 0] || r.charts[0];
    if (!ch) return { ...base, noChart: true };
    const agg = aggregateCrm({ rows, dim: ch.dim, fn: ch.fn, value: ch.value, split: ch.split, fieldByKey: byKey, cumulative: ch.cumulative, limit: ch.top === 0 ? 60 : ch.top ?? undefined, order: ch.order, other: ch.top ? false : undefined });
    return { ...base, chart: { title: ch.title, type: ch.type, agg } };
  }
  const cols = (r.cols ?? []).map((k) => byKey.get(k)).filter((f): f is Field => !!f).slice(0, 5);
  let list = rows;
  const sf = r.sort ? byKey.get(r.sort.key) : null;
  if (sf && r.sort) {
    const dir = r.sort.dir === "desc" ? -1 : 1;
    list = [...rows].sort((a, b) => {
      const x = sortValue(toCell(sf, sf.get(a as any))), y = sortValue(toCell(sf, sf.get(b as any)));
      if (x == null) return y == null ? 0 : 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }
  return {
    ...base,
    table: {
      cols: cols.map((f) => ({ label: r.labels?.[f.key] || f.label, num: f.kind === "money" || f.kind === "number" || f.kind === "percent" })),
      rows: list.slice(0, w.rows ?? 6).map((x) => cols.map((f) => (f.list ? f.list(x as any).join(", ") : showCell(f, toCell(f, f.get(x as any)))))),
    },
  };
}

export default function ReportsHome({ saved, me, templates, toReport, onOpenSaved, onOpenReport, custom, onCustom, refreshTick = 0 }: {
  saved: HomeSaved[];
  me: string | null;
  templates: HomeTemplate[];
  toReport: (s: HomeSaved) => CrmReport;
  onOpenSaved: (s: HomeSaved) => void;
  onOpenReport: (r: CrmReport) => void;
  /** Customizing the board (the page's header has the button). */
  custom: boolean;
  onCustom: (on: boolean) => void;
  /** Bumped by the header's Refresh: read the CRM again. */
  refreshTick?: number;
}) {
  // the ready-made reports, made once (their chart ids are new each time one is made)
  const tpl = useMemo(() => new Map(templates.map((t) => [t.title, t.make()])), [templates]);
  const [board, setBoard] = useState<Board | null>(null);
  const [tick, setTick] = useState(0);
  const cache = useRef(new Map<string, Res>());
  const firstTick = useRef(refreshTick);
  useEffect(() => {
    if (refreshTick === firstTick.current) return;
    forgetCrmData(); cache.current.clear(); setTick((x) => x + 1);
  }, [refreshTick]);
  const [ver, setVer] = useState(0);
  const [addSrc, setAddSrc] = useState("");
  const [addShow, setAddShow] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  const savedById = useMemo(() => new Map(saved.map((s) => [s.id, s])), [saved]);
  const reportOf = (w: Widget): { r: CrmReport; name: string; s?: HomeSaved } | null => {
    if (w.src.saved) { const s = savedById.get(w.src.saved); return s ? { r: toReport(s), name: s.name, s } : null; }
    if (w.src.tpl) { const r = tpl.get(w.src.tpl); return r ? { r, name: w.src.tpl } : null; }
    return null;
  };

  /** A board to start from: your latest reports (their figures and first charts), else a few ready-made ones. */
  const starter = (): Widget[] => {
    const out: Widget[] = [];
    const recent = [...saved].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (recent[0]) out.push({ id: uid(), src: { saved: recent[0].id }, show: "figures", size: "l" });
    recent.filter((s) => Array.isArray(s.config?.charts) && s.config.charts.length).slice(0, 4)
      .forEach((s) => out.push({ id: uid(), src: { saved: s.id }, show: "chart", chartIdx: 0, chartId: s.config.charts[0]?.id ?? null, size: "m" }));
    if (out.length < 3) {
      const pick = ["Open pipeline by phase", "ARR this year: new + renewals", "Overdue invoices"].filter((t) => tpl.has(t));
      if (!out.length && pick[0]) out.push({ id: uid(), src: { tpl: pick[0] }, show: "figures", size: "l" });
      pick.forEach((t) => { if (out.length < 5) out.push({ id: uid(), src: { tpl: t }, show: "chart", chartIdx: 0, size: "m" }); });
    }
    return placeAll(out);
  };

  const [ready, setReady] = useState(false);
  useEffect(() => {
    let off = false;
    loadPrefs().then((p) => {
      if (off) return;
      const b = p?.[PREF];
      // v1 (fixed widths, in order) is placed on the grid once
      setBoard(b && Array.isArray(b.widgets) ? { v: 2, widgets: placeAll(b.widgets as Widget[]) } : null);
    }).catch(() => { if (!off) setBoard(null); }).finally(() => { if (!off) setReady(true); });
    return () => { off = true; };
  }, []);
  // no board of your own yet: a starter one, made once your reports are in
  const widgets: Widget[] = useMemo(() => board?.widgets ?? (ready ? starter() : []), [board, ready, saved.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const put = (ws: Widget[]) => { const b: Board = { v: 2, widgets: ws }; setBoard(b); void savePref(PREF, b).catch(() => {}); };
  const patch = (id: string, p: Partial<Widget>) => put(widgets.map((w) => (w.id === id ? { ...w, ...p } : w)));
  const remove = (id: string) => put(widgets.filter((w) => w.id !== id));

  const sigOf = (w: Widget) => {
    const rep = reportOf(w);
    return JSON.stringify([w.src, w.show, w.chartId ?? null, w.chartIdx ?? 0, w.rows ?? 30, rep?.s?.updated_at ?? "", tick]);
  };

  // read each report's part of the CRM once (shared by every widget on it), then work out each widget
  const need = widgets.map((w) => sigOf(w)).join("|");
  useEffect(() => {
    let off = false;
    const todo = widgets.map((w) => ({ w: { ...w, rows: w.rows ?? 30 }, sig: sigOf(w), rep: reportOf(w) })).filter((x) => !cache.current.has(x.sig));
    if (!todo.length) return;
    const groups = new Map<string, typeof todo>();
    todo.forEach((x) => {
      if (!x.rep) { cache.current.set(x.sig, { state: "gone" }); return; }
      const k = `${x.rep.r.source}|${(x.rep.r.with ?? []).join(",")}`;
      groups.set(k, [...(groups.get(k) ?? []), x]);
    });
    setVer((v) => v + 1);
    // every part of the CRM at once (each read only once), and of each only what its widgets' reports use
    void Promise.all([...groups.values()].map(async (xs) => {
      const r0 = xs[0].rep!.r;
      const extra = (r0.with ?? []) as EntityKey[];
      const only = [...new Set(xs.flatMap((x) => partsUsed(x.rep!.r)))];
      try {
        const d = await loadCrmData(r0.source, undefined, extra, only);
        const fs = await buildCrmFields(r0.source, d, extra);
        if (off) return;
        const rows = buildCrmRows(r0.source, d, extra);
        xs.forEach((x) => { try { cache.current.set(x.sig, compute(x.w, x.rep!.r, fs, rows)); } catch (e: any) { console.error("[reports] widget", e); cache.current.set(x.sig, { state: "error", msg: String(e?.message ?? e) }); } });
        setReportPeriod(DEFAULT_REPORT_PERIOD);
      } catch (e: any) {
        console.error("[reports] read", e);
        if (off) return;
        xs.forEach((x) => cache.current.set(x.sig, { state: "error", msg: String(e?.message ?? e) }));
      }
      if (!off) setVer((v) => v + 1);
    }));
    return () => { off = true; };
  }, [need]); // eslint-disable-line react-hooks/exhaustive-deps
  void ver;

  /* ---- add a widget ---- */
  const srcOptions = useMemo(() => [
    ...[...saved].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ value: `s:${s.id}`, label: s.name, hint: `${entityOf((s.config?.v === 2 ? s.config.source : "deal") as EntityKey)?.plural ?? ""}${s.owner_id && me && s.owner_id !== me ? " · shared with you" : ""}` })),
    ...templates.map((t) => ({ value: `t:${t.title}`, label: t.title, hint: "Ready-made" })),
  ], [saved, templates, me]);
  const addRep = addSrc ? (addSrc.startsWith("s:") ? (() => { const s = savedById.get(addSrc.slice(2)); return s ? toReport(s) : null; })() : tpl.get(addSrc.slice(2)) ?? null) : null;
  const showOptions = (r: CrmReport | null) => r ? [
    { value: "figures", label: "Its figures", hint: r.figures?.length ? `${r.figures.length} figures` : "Count and totals" },
    ...r.charts.map((c, i) => ({ value: `chart:${i}`, label: c.title || `Chart ${i + 1}`, hint: "Chart" })),
    { value: "table", label: "Its first rows", hint: "Table" },
  ] : [];
  const showValue = (w: Widget) => (w.show === "chart" ? `chart:${w.chartIdx ?? 0}` : w.show);
  const showPatch = (r: CrmReport, v: string): Partial<Widget> => (v.startsWith("chart:") ? { show: "chart", chartIdx: Number(v.slice(6)), chartId: r.charts[Number(v.slice(6))]?.id ?? null } : { show: v as WShow });
  const add = () => {
    if (!addRep || !addSrc) return;
    const show = addShow || (addRep.charts.length ? "chart:0" : "figures");
    const src = addSrc.startsWith("s:") ? { saved: addSrc.slice(2) } : { tpl: addSrc.slice(2) };
    const base: Widget = { id: uid(), src, show: "figures", ...showPatch(addRep, show) } as Widget;
    const [cw, ch] = sizeOf(base);
    const at = firstFit(widgets.map((w) => ({ id: w.id, key: "w", x: w.x ?? 0, y: w.y ?? 0, w: w.w ?? 12, h: w.h ?? 10 })), cw, ch);
    const w: Widget = { ...base, x: at.x, y: at.y, w: cw, h: ch };
    put([...widgets, w]);
    setAddSrc(""); setAddShow("");
    setFlash(w.id); window.setTimeout(() => setFlash((f) => (f === w.id ? null : f)), 1600);
    window.setTimeout(() => document.querySelector(`.rh-board .hb-card[data-id="${w.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 80);
  };

  const open = (w: Widget) => { const rep = reportOf(w); if (!rep) return; if (rep.s) onOpenSaved(rep.s); else onOpenReport(rep.r); };

  /* ---- the grid (the home page's): items, row height, the slots each card is drawn into ---- */
  const items: BoardItem[] = useMemo(() => compactAll(widgets.map((w) => ({ id: w.id, key: "w", x: w.x ?? 0, y: w.y ?? 0, w: w.w ?? 12, h: w.h ?? 10 }))), [widgets]);
  const onGrid = (next: BoardItem[]) => {
    const at = new Map(next.map((i) => [i.id, i]));
    put(widgets.map((w) => { const i = at.get(w.id); return i ? { ...w, x: i.x, y: i.y, w: i.w, h: i.h } : w; }));
  };
  const wrap = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(36);
  useLayoutEffect(() => {
    const m = () => setStep(Math.max(28, Math.min(46, Math.round((window.innerHeight - 110) / 20))));
    m();
    window.addEventListener("resize", m);
    return () => window.removeEventListener("resize", m);
  }, []);
  const [els, setEls] = useState<Record<string, HTMLElement>>({});
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const slotRef = useCallback((id: string) => {
    let f = refs.current.get(id);
    if (!f) {
      f = (el: HTMLElement | null) => setEls((m) => {
        if (el) return m[id] === el ? m : { ...m, [id]: el };
        if (!(id in m)) return m;
        const next = { ...m }; delete next[id]; return next;
      });
      refs.current.set(id, f);
    }
    return f;
  }, []);
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const titleOf = (w: Widget) => {
    const rep = reportOf(w);
    if (!rep) return "Report no longer there";
    if (w.show === "chart") { const res = cache.current.get(sigOf(w)); return (res?.state === "ok" && res.chart ? res.chart.title : ((w.chartId && rep.r.charts.find((c) => c.id === w.chartId)) || rep.r.charts[w.chartIdx ?? 0])?.title) || rep.name; }
    return rep.name;
  };
  const kit: BoardKit = {
    min: () => [4, 4],
    title: () => "Widget",
    label: (it) => { const w = byId.get(it.id); return w ? titleOf(w) : "Widget"; },
    icon: () => <Ico d={I.chart} />,
    color: () => "#12b57f",
    shown: (it) => it.key,
    fig: () => false,
    link: () => false,
    look: (_it, pxW) => (pxW < 300 ? "Slim" : pxW < 430 ? "Compact" : pxW < 620 ? "Standard" : pxW < 900 ? "Wide" : "Extra wide"),
    presets: () => [{ label: "Small", w: 8, h: 8 }, { label: "Medium", w: 12, h: 11 }, { label: "Large", w: 16, h: 14 }, { label: "Full width", w: 24, h: 11 }, { label: "Figures strip", w: 24, h: 6 }],
    bar: (it, pxW) => {
      const w = byId.get(it.id); const rep = w ? reportOf(w) : null;
      if (!w || !rep || pxW < 400) return null;
      return (
        <span className="rh-bar-pick" onPointerDown={(e) => e.stopPropagation()}>
          <Select size="sm" aria-label="What it shows" value={showValue(w)} options={showOptions(rep.r)} onChange={(v) => patch(w.id, showPatch(rep.r, v))} />
        </span>
      );
    },
    menu: (it, ctx) => {
      const w = byId.get(it.id); const rep = w ? reportOf(w) : null;
      if (!w || !rep) return null;
      return (
        <>
          <b className="hb-sizes-h">Shows</b>
          <div className="rh-menu" role="radiogroup" aria-label="What it shows">
            {showOptions(rep.r).map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={o.value === showValue(w)} className={o.value === showValue(w) ? "is-on" : ""} onClick={() => { patch(w.id, showPatch(rep.r, o.value)); ctx.close(); }}>
                <span>{o.label}</span><em>{o.hint}</em>
              </button>
            ))}
          </div>
          {w.show === "table" && (
            <div className="rh-menu-rows"><span>Rows</span>{[6, 12, 30].map((n) => <button key={n} type="button" className={(w.rows ?? 30) === n ? "is-on" : ""} onClick={() => patch(w.id, { rows: n })}>{n}</button>)}</div>
          )}
        </>
      );
    },
    stackH: (it) => Math.max(220, Math.min(560, it.h * 34)),
  };

  /** One widget's card, drawn into its place on the grid. */
  const card = (w: Widget): ReactNode => {
    const rep = reportOf(w);
    const res = cache.current.get(sigOf(w));
    const e = rep ? entityOf(rep.r.source) : null;
    const tone = e?.tone ?? "#12b57f";
    const per = rep?.r.period && rep.r.period.key !== "all" ? (rep.r.period.key === "custom" ? prettyRange("custom", rep.r.period.from, rep.r.period.to) : PERIODS.find((p) => p.key === rep.r.period!.key)?.label) : "";
    const title = titleOf(w);
    const ok = res?.state === "ok" ? res : null;
    const sub = !rep ? "It was deleted or isn't shared with you any more" : [w.show === "chart" ? rep.name : w.show === "table" ? "First rows" : glabel(rep.r.source), ok ? `${ok.count.toLocaleString("en-GB")} ${ok.count === 1 ? e?.label.toLowerCase() ?? "row" : e?.plural.toLowerCase() ?? "rows"}` : "", per ?? ""].filter(Boolean).join(" · ");
    return (
      <section className={`rh-card is-${w.show}`} style={vars({ "--c": tone })}>
        <header className="rh-card-h">
          <span className="rh-card-ico"><Ico d={e?.icon ?? I.chart} /></span>
          <div className="rh-card-t">
            <b title={title}>{title}</b>
            {sub && <em title={sub}>{sub}</em>}
          </div>
          {!custom && rep && <button type="button" className="rh-open" onClick={() => open(w)} title="Open the report"><Ico d={I.out} /></button>}
        </header>
        <div className="rh-card-b">
          {!rep ? <p className="rh-none">Remove it, or put another report in its place.</p>
            : !res ? <div className="rh-skel" aria-label="Loading"><i /><i /><i /></div>
              : res.state === "error" ? <p className="rh-none is-bad">Couldn't read it: {res.msg}</p>
                : res.state === "gone" ? <p className="rh-none">Report no longer there.</p>
                  : w.show === "figures" && res.figs ? (
                    <div className="rh-kpis">
                      {res.figs.map((f, k) => {
                        const c = k === 0 ? tone : PALETTE[(k + 1) % PALETTE.length];
                        return (
                          <div key={k} className="rh-kpi" style={vars({ "--fc": c })}>
                            <span className="rh-kpi-l"><i />{f.label}</span>
                            <b title={f.value}>{f.value}</b>
                            <em>{f.sub}</em>
                            <span className="rh-kpi-bars" aria-hidden="true">{[0.45, 0.7, 0.35, 0.9, 0.6].map((h, j) => <i key={j} style={{ height: `${h * 100}%` }} />)}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : w.show === "chart" ? (
                    res.chart ? (res.chart.agg.keys.length ? <div className={`rh-chart is-${res.chart.type}`}><ErrorBoundary what="This chart" small resetKey={sigOf(w)}><ReportChart type={res.chart.type} agg={res.chart.agg} /></ErrorBoundary></div> : <p className="rh-none">No data for this chart.</p>)
                      : <p className="rh-none">This report has no charts yet — show its figures or first rows instead.</p>
                  ) : res.table ? (
                    res.table.rows.length ? (
                      <div className="rh-tbl-w">
                        <table className="rh-tbl">
                          <thead><tr>{res.table.cols.map((c, k) => <th key={k} className={c.num ? "is-n" : ""}>{c.label}</th>)}</tr></thead>
                          <tbody>{res.table.rows.map((r, k) => <tr key={k}>{r.map((v, j) => <td key={j} className={res.table!.cols[j]?.num ? "is-n" : ""} title={v}>{v || "—"}</td>)}</tr>)}</tbody>
                        </table>
                        {res.count > res.table.rows.length && <button type="button" className="rh-more" onClick={() => open(w)}>All {res.count.toLocaleString("en-GB")}<Ico d={I.right} w={2.4} /></button>}
                      </div>
                    ) : <p className="rh-none">No rows with its rules right now.</p>
                  ) : null}
        </div>
      </section>
    );
  };

  return (
    <div className="rh" ref={wrap}>
      {custom && (
        <div className="rh-add">
          <span className="rh-add-ico"><Ico d={I.plus} w={2.4} /></span>
          <div className="rh-add-t"><b>Add to your home</b><em>Pick a report, then what of it to show. Drag a card to move it; pull its right or bottom edge to resize it.</em></div>
          <span className="rh-add-src"><Select value={addSrc} onChange={(v) => { setAddSrc(v); setAddShow(""); }} options={srcOptions} placeholder="A report…" searchable aria-label="Report" /></span>
          <span className="rh-add-show"><Select value={addShow || (addRep ? (addRep.charts.length ? "chart:0" : "figures") : "")} onChange={setAddShow} options={showOptions(addRep)} placeholder="Show…" disabled={!addRep} aria-label="What to show" /></span>
          <button type="button" className="rh-btn is-main" disabled={!addRep} onClick={add}><Ico d={I.plus} w={2.4} />Add</button>
          <button type="button" className="rh-btn is-ghost" onClick={() => { if (window.confirm("Put your home back the way it started? Your widgets go.")) { setBoard(null); void savePref(PREF, null).catch(() => {}); } }} title="Back to the board everyone starts with"><Ico d={I.reset} />Reset</button>
        </div>
      )}

      {!ready ? (
        <div className="rh-wait"><i /><i /><i /></div>
      ) : widgets.length ? (
        <>
          <HomeBoard kit={kit} className="rh-board" items={items} editing={custom} step={step} slotRef={slotRef} flash={flash} duo
            onOpen={() => {}} onPreview={() => {}} onChange={onGrid} onRemove={remove} />
          {widgets.map((w) => (els[w.id] ? createPortal(card(w), els[w.id], w.id) : null))}
        </>
      ) : (
        <div className="rh-empty">
          <span><Ico d={I.home} /></span>
          <b>Your home is empty</b>
          <em>Put the figures, charts and tables you look at every day here — from your reports, the ones shared with you, or the ready-made ones.</em>
          {!custom && <button type="button" className="rh-btn is-main" onClick={() => onCustom(true)}><Ico d={I.sliders} />Customize</button>}
        </div>
      )}
    </div>
  );
}
