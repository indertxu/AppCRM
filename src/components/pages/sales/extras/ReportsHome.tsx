/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as RDragEvent, type ReactNode } from "react";
import Select from "../../../framework/Select";
import { ReportChart, PALETTE } from "./ReportCharts";
import {
  entityOf, PERIODS, GROUP_LABEL, loadCrmData, buildCrmFields, buildCrmRows, aggregateCrm, testTree, toCell, showCell, sortValue,
  setReportPeriod, withPeriodTag, prettyRange, forgetCrmData, DEFAULT_REPORT_PERIOD, uid,
  type Field, type CrmRow, type Agg, type EntityKey,
} from "./salesReportEngine";
import { loadPrefs, savePref } from "../../companies/companiesApi";
import type { CrmReport } from "./SalesReport";
import "./ReportsHome.css";

/* =====================================================================
   Reports › Home — the first thing Reports shows: your own board of
   figures, charts and short tables, each one read live from a saved
   report (yours or shared with you) or a ready-made one. "Customize"
   adds, removes, resizes and reorders them; the board is kept per user
   (profiles.prefs → reports_home).
   ===================================================================== */

export interface HomeSaved { id: string; name: string; owner_id: string | null; shared: boolean; updated_at: string; config: any }
export interface HomeTemplate { title: string; hint: string; make: () => CrmReport }
type WSize = "s" | "m" | "l";
type WShow = "figures" | "chart" | "table";
interface Widget {
  id: string;
  /** Where it reads from: a saved report, or a ready-made one (by its title). */
  src: { saved?: string; tpl?: string };
  show: WShow;
  /** Which of the report's charts (its id; the position when the id is gone, e.g. a ready-made one). */
  chartId?: string | null; chartIdx?: number;
  size: WSize;
  /** A table's rows. */
  rows?: number;
}
interface Board { v: 1; widgets: Widget[] }
const PREF = "reports_home";
type Fig = { label: string; value: string; sub: string };
type Res =
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
const Grip = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
);
const vars = (o: Record<string, string | number>) => o as CSSProperties;
const SIZE_LABEL: Record<WSize, string> = { s: "A third of the width", m: "Half the width", l: "The whole width" };
const glabel = (g: string) => GROUP_LABEL[g as EntityKey] ?? g;

/** A widget's figures, chart or table, read from its report's rows (the report's own period, rules and sort). */
function compute(w: Widget, r: CrmReport, rawFields: Field[], allRows: CrmRow[]): Res {
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

export default function ReportsHome({ saved, me, templates, toReport, onOpenSaved, onOpenReport, tabs }: {
  saved: HomeSaved[];
  me: string | null;
  templates: HomeTemplate[];
  toReport: (s: HomeSaved) => CrmReport;
  onOpenSaved: (s: HomeSaved) => void;
  onOpenReport: (r: CrmReport) => void;
  /** Home | New report, at the head of the board. */
  tabs: ReactNode;
}) {
  // the ready-made reports, made once (their chart ids are new each time one is made)
  const tpl = useMemo(() => new Map(templates.map((t) => [t.title, t.make()])), [templates]);
  const [board, setBoard] = useState<Board | null>(null);
  const [custom, setCustom] = useState(false);
  const [tick, setTick] = useState(0);
  const [ver, setVer] = useState(0);
  const cache = useRef(new Map<string, Res>());
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const [addSrc, setAddSrc] = useState("");
  const [addShow, setAddShow] = useState("");

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
    return out;
  };

  const [ready, setReady] = useState(false);
  useEffect(() => {
    let off = false;
    loadPrefs().then((p) => {
      if (off) return;
      const b = p?.[PREF];
      setBoard(b && Array.isArray(b.widgets) ? { v: 1, widgets: b.widgets } : null);
    }).catch(() => { if (!off) setBoard(null); }).finally(() => { if (!off) setReady(true); });
    return () => { off = true; };
  }, []);
  // no board of your own yet: a starter one, made once your reports are in
  const widgets: Widget[] = useMemo(() => board?.widgets ?? (ready ? starter() : []), [board, ready, saved.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const put = (ws: Widget[]) => { const b: Board = { v: 1, widgets: ws }; setBoard(b); void savePref(PREF, b).catch(() => {}); };
  const patch = (id: string, p: Partial<Widget>) => put(widgets.map((w) => (w.id === id ? { ...w, ...p } : w)));
  const remove = (id: string) => put(widgets.filter((w) => w.id !== id));

  const sigOf = (w: Widget) => {
    const rep = reportOf(w);
    return JSON.stringify([w.src, w.show, w.chartId ?? null, w.chartIdx ?? 0, w.rows ?? 6, rep?.s?.updated_at ?? "", tick]);
  };

  // read each report's part of the CRM once (shared by every widget on it), then work out each widget
  const need = widgets.map((w) => sigOf(w)).join("|");
  useEffect(() => {
    let off = false;
    const todo = widgets.map((w) => ({ w, sig: sigOf(w), rep: reportOf(w) })).filter((x) => !cache.current.has(x.sig));
    if (!todo.length) return;
    const groups = new Map<string, typeof todo>();
    todo.forEach((x) => {
      if (!x.rep) { cache.current.set(x.sig, { state: "gone" }); return; }
      const k = `${x.rep.r.source}|${(x.rep.r.with ?? []).join(",")}`;
      groups.set(k, [...(groups.get(k) ?? []), x]);
    });
    setVer((v) => v + 1);
    (async () => {
      for (const xs of groups.values()) {
        const r0 = xs[0].rep!.r;
        const extra = (r0.with ?? []) as EntityKey[];
        try {
          const d = await loadCrmData(r0.source, undefined, extra);
          const fs = await buildCrmFields(r0.source, d, extra);
          if (off) return;
          const rows = buildCrmRows(r0.source, d, extra);
          xs.forEach((x) => { try { cache.current.set(x.sig, compute(x.w, x.rep!.r, fs, rows)); } catch (e: any) { cache.current.set(x.sig, { state: "error", msg: String(e?.message ?? e) }); } });
          setReportPeriod(DEFAULT_REPORT_PERIOD);
        } catch (e: any) {
          if (off) return;
          xs.forEach((x) => cache.current.set(x.sig, { state: "error", msg: String(e?.message ?? e) }));
        }
        if (!off) setVer((v) => v + 1);
      }
    })();
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
  const add = () => {
    if (!addRep || !addSrc) return;
    const show = addShow || (addRep.charts.length ? "chart:0" : "figures");
    const src = addSrc.startsWith("s:") ? { saved: addSrc.slice(2) } : { tpl: addSrc.slice(2) };
    const w: Widget = show.startsWith("chart:")
      ? { id: uid(), src, show: "chart", chartIdx: Number(show.slice(6)), chartId: addRep.charts[Number(show.slice(6))]?.id ?? null, size: "m" }
      : { id: uid(), src, show: show as WShow, size: show === "figures" ? "l" : "m" };
    put([...widgets, w]);
    setAddSrc(""); setAddShow("");
    window.requestAnimationFrame(() => document.querySelector(`[data-w="${w.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  /* ---- reorder ---- */
  const dropOn = (e: RDragEvent, id: string) => {
    e.preventDefault();
    if (!drag || drag === id) { setDrag(null); setOver(null); return; }
    const it = widgets.find((w) => w.id === drag);
    if (!it) return;
    const rest = widgets.filter((w) => w.id !== drag);
    const j = rest.findIndex((w) => w.id === id);
    rest.splice(j < 0 ? rest.length : j + (over?.after ? 1 : 0), 0, it);
    put(rest); setDrag(null); setOver(null);
  };

  const open = (w: Widget) => { const rep = reportOf(w); if (!rep) return; if (rep.s) onOpenSaved(rep.s); else onOpenReport(rep.r); };
  const recent = [...saved].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6);

  const card = (w: Widget, i: number) => {
    const rep = reportOf(w);
    const res = cache.current.get(sigOf(w));
    const e = rep ? entityOf(rep.r.source) : null;
    const per = rep?.r.period && rep.r.period.key !== "all" ? (rep.r.period.key === "custom" ? prettyRange("custom", rep.r.period.from, rep.r.period.to) : PERIODS.find((p) => p.key === rep.r.period!.key)?.label) : "";
    const title = !rep ? "Report no longer there" : w.show === "chart" ? (res?.state === "ok" && res.chart ? res.chart.title : rep.r.charts[w.chartIdx ?? 0]?.title || rep.name) : rep.name;
    const sub = !rep ? "It was deleted or isn't shared with you any more" : [w.show === "chart" ? rep.name : w.show === "table" ? "First rows" : "", res?.state === "ok" ? `${res.count.toLocaleString("en-GB")} ${res.count === 1 ? e?.label.toLowerCase() ?? "row" : e?.plural.toLowerCase() ?? "rows"}` : "", per ?? ""].filter(Boolean).join(" · ");
    const sz = w.size;
    return (
      <section key={w.id} data-w={w.id} className={`rh-w sz-${sz} is-${w.show} ${custom ? "is-edit" : ""} ${drag === w.id ? "is-drag" : ""} ${over?.id === w.id ? (over.after ? "is-after" : "is-before") : ""}`}
        style={vars({ "--c": e?.tone ?? "#1fb98a", "--i": i })}
        draggable={custom} onDragStart={(ev) => { setDrag(w.id); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", title); }}
        onDragEnd={() => { setDrag(null); setOver(null); }}
        onDragOver={(ev) => { if (!drag) return; ev.preventDefault(); const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); const after = ev.clientX > r.left + r.width / 2; if (over?.id !== w.id || over.after !== after) setOver({ id: w.id, after }); }}
        onDrop={(ev) => dropOn(ev, w.id)}>
        <header className="rh-w-h">
          {custom && <span className="rh-grip" title="Drag to move"><Grip /></span>}
          {e && <span className="rh-w-ico"><Ico d={e.icon} /></span>}
          <div className="rh-w-t">
            <b title={title}>{title}</b>
            {sub && <em title={sub}>{sub}</em>}
          </div>
          {!custom && rep && (
            <button type="button" className="rh-open" onClick={() => open(w)} title="Open the report"><Ico d={I.out} /></button>
          )}
        </header>
        {custom && (
          <div className="rh-w-bar">
            {rep && (
              <span className="rh-w-show">
                <Select size="sm" aria-label="What it shows" value={w.show === "chart" ? `chart:${w.chartIdx ?? 0}` : w.show}
                  options={showOptions(rep.r)} onChange={(v) => patch(w.id, v.startsWith("chart:") ? { show: "chart", chartIdx: Number(v.slice(6)), chartId: rep.r.charts[Number(v.slice(6))]?.id ?? null } : { show: v as WShow })} />
              </span>
            )}
            {w.show === "table" && rep && (
              <div className="rh-seg" role="radiogroup" aria-label="Rows">{[3, 6, 10].map((n) => <button type="button" role="radio" aria-checked={(w.rows ?? 6) === n} key={n} className={(w.rows ?? 6) === n ? "is-on" : ""} onClick={() => patch(w.id, { rows: n })} title={`${n} rows`}>{n}</button>)}</div>
            )}
            <div className="rh-size" role="radiogroup" aria-label="Width">
              {(["s", "m", "l"] as WSize[]).map((z) => (
                <button type="button" key={z} role="radio" aria-checked={sz === z} className={sz === z ? "is-on" : ""} title={SIZE_LABEL[z]} onClick={() => patch(w.id, { size: z })}>
                  <span className={`rh-size-ico is-${z}`}><i /><i /><i /></span>
                </button>
              ))}
            </div>
            <button type="button" className="rh-x" onClick={() => remove(w.id)} aria-label={`Remove ${title}`} title="Remove from your home"><Ico d={I.x} w={2.4} /></button>
          </div>
        )}
        <div className="rh-w-b">
          {!rep ? <p className="rh-none">Remove it, or put another report in its place.</p>
            : !res ? <div className="rh-skel" aria-label="Loading"><i /><i /><i /></div>
              : res.state === "error" ? <p className="rh-none is-bad">Couldn't read it: {res.msg}</p>
                : res.state === "gone" ? <p className="rh-none">Report no longer there.</p>
                  : w.show === "figures" && res.figs ? (
                    <div className="rh-figs">
                      {res.figs.map((f, k) => (
                        <div key={k} className="rh-fig" style={vars({ "--fc": k === 0 ? e?.tone ?? "#1fb98a" : PALETTE[k % PALETTE.length] })}>
                          <span title={f.label}>{f.label}</span><b>{f.value}</b><em>{f.sub}</em>
                        </div>
                      ))}
                    </div>
                  ) : w.show === "chart" ? (
                    res.chart ? (res.chart.agg.keys.length ? <ReportChart type={res.chart.type} agg={res.chart.agg} /> : <p className="rh-none">No data for this chart.</p>)
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
    <div className="rh">
      <div className="rh-top">
        {tabs}
        <div className="rh-top-acts">
          {!custom && <button type="button" className="rh-btn is-ghost" onClick={() => { forgetCrmData(); cache.current.clear(); setTick((x) => x + 1); }} title="Read the CRM again"><Ico d={I.refresh} />Refresh</button>}
          {custom && <button type="button" className="rh-btn is-ghost" onClick={() => { if (window.confirm("Put your home back the way it started? Your widgets go.")) { setBoard(null); void savePref(PREF, null).catch(() => {}); } }}><Ico d={I.reset} />Reset</button>}
          <button type="button" className={`rh-btn ${custom ? "is-main" : "is-ghost"}`} onClick={() => setCustom((v) => !v)} aria-pressed={custom}>
            <Ico d={custom ? I.check : I.sliders} w={custom ? 2.4 : 2} />{custom ? "Done" : "Customize"}
          </button>
        </div>
      </div>

      {recent.length > 0 && !custom && (
        <div className="rh-recent" aria-label="Your latest reports">
          <span className="rh-recent-h">Jump back in</span>
          {recent.map((s) => {
            const e = entityOf((s.config?.v === 2 ? s.config.source : "deal") as EntityKey);
            return (
              <button type="button" key={s.id} className="rh-chip" style={vars({ "--c": e?.tone ?? "#1fb98a" })} onClick={() => onOpenSaved(s)} title={s.name}>
                <span className="rh-chip-ico"><Ico d={e?.icon ?? I.chart} /></span><span>{s.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {custom && (
        <div className="rh-add">
          <span className="rh-add-ico"><Ico d={I.plus} w={2.4} /></span>
          <div className="rh-add-t"><b>Add to your home</b><em>Pick a report, then what of it to show. Drag the cards to reorder them; the three bars set their width.</em></div>
          <span className="rh-add-src"><Select value={addSrc} onChange={(v) => { setAddSrc(v); setAddShow(""); }} options={srcOptions} placeholder="A report…" searchable aria-label="Report" /></span>
          <span className="rh-add-show"><Select value={addShow || (addRep ? (addRep.charts.length ? "chart:0" : "figures") : "")} onChange={setAddShow} options={showOptions(addRep)} placeholder="Show…" disabled={!addRep} aria-label="What to show" /></span>
          <button type="button" className="rh-btn is-main" disabled={!addRep} onClick={add}><Ico d={I.plus} w={2.4} />Add</button>
        </div>
      )}

      {!ready ? (
        <div className="rh-grid">{[0, 1, 2].map((k) => <section key={k} className={`rh-w ${k ? "sz-m" : "sz-l"}`}><div className="rh-skel"><i /><i /><i /></div></section>)}</div>
      ) : widgets.length ? (
        <div className={`rh-grid ${drag ? "is-dragging" : ""}`}>{widgets.map(card)}</div>
      ) : (
        <div className="rh-empty">
          <span><Ico d={I.home} /></span>
          <b>Your home is empty</b>
          <em>Put the figures, charts and tables you look at every day here — from your reports, the ones shared with you, or the ready-made ones.</em>
          {!custom && <button type="button" className="rh-btn is-main" onClick={() => setCustom(true)}><Ico d={I.sliders} />Customize</button>}
        </div>
      )}
    </div>
  );
}
