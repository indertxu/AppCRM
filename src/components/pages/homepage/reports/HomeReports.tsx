/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home · REPORTS — a source of cards for the home board (HomePage.tsx): any
 * report from the Reports page (yours, one shared with you, or a ready-made
 * one) as a card: one of its charts, its figures or its first rows. Each card
 * keeps what it shows in its settings (BoardItem.cfg):
 *   { saved?: reportId, tpl?: ready-made title, show: "chart" | "figures" | "table", chartId?, chartIdx? }
 * The numbers are worked out exactly like Reports › Home (ReportsHome.compute):
 * the report's own period, rules and sort, read live from the CRM.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../api/supabase";
import Select from "../../../framework/Select";
import { compute, type Res, type Widget, type WShow } from "../../sales/extras/ReportsHome";
import { fromSaved, TEMPLATES, type CrmReport } from "../../sales/extras/SalesReport";
import { ReportChart, PALETTE } from "../../sales/extras/ReportCharts";
import {
  entityOf, PERIODS, prettyRange, loadCrmData, buildCrmFields, buildCrmRows, setReportPeriod, forgetCrmData, DEFAULT_REPORT_PERIOD, partsUsed, type EntityKey,
} from "../../sales/extras/salesReportEngine";
import { renderSlots, type HomeSlot } from "../consultancy/ConsultancyHome";
import "../../sales/extras/SalesReport.css";
import "../../sales/extras/ReportsHome.css";
import "./HomeReports.css";

export interface SavedRep { id: string; name: string; owner_id: string | null; updated_at: string; config: any }
export interface RepCfg { saved?: string; tpl?: string; show: WShow; chartId?: string | null; chartIdx?: number }

/* ---- the reports you can see: read once per visit, shared by every card, the edit bar and the library ---- */
let SAVED: SavedRep[] | null = null;
let SAVED_P: Promise<SavedRep[]> | null = null;
let ME: string | null = null;
const subs = new Set<() => void>();
export function loadSavedReports(fresh = false): Promise<SavedRep[]> {
  if (SAVED_P && !fresh) return SAVED_P;
  SAVED_P = (async () => {
    const { data: s } = await supabase.auth.getSession();
    ME = s?.session?.user?.id ?? null;
    const r: any = await supabase.from("sales_reports").select("id, name, owner_id, updated_at, config").order("updated_at", { ascending: false });
    SAVED = r.error ? [] : ((r.data ?? []) as SavedRep[]);
    subs.forEach((f) => f());
    return SAVED;
  })().catch(() => { SAVED = []; subs.forEach((f) => f()); return [] as SavedRep[]; });
  return SAVED_P;
}
export function useSavedReports(): SavedRep[] | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    subs.add(f);
    void loadSavedReports();
    return () => { subs.delete(f); };
  }, []);
  return SAVED;
}

/* the ready-made reports, made once (their chart ids are new each time one is made: they go by position) */
let TPL: Map<string, CrmReport> | null = null;
const tplMap = () => (TPL ??= new Map(TEMPLATES.map((t) => [t.title, t.make()])));
export const templateTitles = () => TEMPLATES.map((t) => ({ title: t.title, hint: t.hint }));

/** The report a card reads from (null: deleted or not shared with you any more). */
export function reportOfCfg(cfg: RepCfg | undefined, saved: SavedRep[] | null): { r: CrmReport; name: string; s?: SavedRep } | null {
  if (!cfg) return null;
  if (cfg.saved) { const s = saved?.find((x) => x.id === cfg.saved); return s ? { r: fromSaved(s.config, s.name), name: s.name, s } : null; }
  if (cfg.tpl) { const r = tplMap().get(cfg.tpl); return r ? { r, name: cfg.tpl } : null; }
  return null;
}
export const reportOfSaved = (s: SavedRep) => fromSaved(s.config, s.name);
export const reportOfTpl = (t: string) => tplMap().get(t) ?? null;

/** What a report can show on a card. */
export function showOptions(r: CrmReport | null): { value: string; label: string; hint?: string }[] {
  if (!r) return [];
  return [
    ...r.charts.map((c, i) => ({ value: `chart:${i}`, label: c.title || `Chart ${i + 1}`, hint: "Chart" })),
    { value: "figures", label: "Its figures", hint: r.figures?.length ? `${r.figures.length} figures` : "Count and totals" },
    { value: "table", label: "Its first rows", hint: "Table" },
  ];
}
export const showValue = (c: RepCfg) => (c.show === "chart" ? `chart:${c.chartIdx ?? 0}` : c.show);
/** A card's settings for a pick from showOptions. */
export function cfgFor(src: { saved?: string; tpl?: string }, r: CrmReport, v: string): RepCfg {
  if (v.startsWith("chart:")) { const i = Number(v.slice(6)) || 0; return { ...src, show: "chart", chartIdx: i, chartId: r.charts[i]?.id ?? null }; }
  return { ...src, show: v === "table" ? "table" : "figures" };
}
/** The pick a report starts with: its first chart, else its figures. */
export const firstShow = (r: CrmReport) => (r.charts.length ? "chart:0" : "figures");
/** A card's starting size (columns × rows) for what it shows. */
export const sizeFor = (show: WShow): [number, number] => (show === "figures" ? [12, 6] : show === "table" ? [10, 10] : [8, 10]);
/** The card's name in the edit bar. */
export function cfgLabel(cfg: RepCfg | undefined): string {
  const rep = reportOfCfg(cfg, SAVED);
  if (!rep || !cfg) return "Report";
  if (cfg.show === "chart") { const ch = (cfg.chartId && rep.r.charts.find((c) => c.id === cfg.chartId)) || rep.r.charts[cfg.chartIdx ?? 0]; return ch?.title || rep.name; }
  return rep.name;
}

/* ---- the numbers: worked out once per card setting, kept for the visit (moving a card never reads again) ---- */
const RES = new Map<string, { res: Res; at: number }>();
const STALE = 15 * 60_000;
const sigOf = (cfg: RepCfg, s?: SavedRep) => JSON.stringify([cfg.saved ?? null, cfg.tpl ?? null, cfg.show, cfg.chartId ?? null, cfg.chartIdx ?? 0, s?.updated_at ?? ""]);
const widgetOf = (id: string, cfg: RepCfg): Widget => ({ id, src: { saved: cfg.saved, tpl: cfg.tpl }, show: cfg.show, chartId: cfg.chartId ?? null, chartIdx: cfg.chartIdx ?? 0, size: "m", rows: 30 });

const Ico = ({ d, w = 2 }: { d: string; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const REPORT_ICON = "M4 20V10M10 20V4M16 20v-7M22 20H2";

export default function ReportCards({ slots }: { slots: HomeSlot[] }) {
  const nav = useNavigate();
  const saved = useSavedReports();
  const [, setVer] = useState(0);
  const cards = useMemo(() => slots.filter((s) => s.key === "report").map((s) => ({ s, cfg: s.cfg as RepCfg | undefined })), [slots]);
  const need = saved ? cards.map(({ cfg }) => (cfg ? sigOf(cfg, reportOfCfg(cfg, saved)?.s) : "")).join("|") : "";

  useEffect(() => {
    if (!saved) return;
    let off = false;
    // a long visit: read the CRM again for cards older than STALE
    const now = Date.now();
    if ([...RES.values()].some((x) => now - x.at > STALE)) { RES.clear(); forgetCrmData(); }
    const todo = cards.map(({ s, cfg }) => ({ s, cfg, rep: reportOfCfg(cfg, saved) }))
      .filter((x) => x.cfg && !RES.has(sigOf(x.cfg, x.rep?.s)));
    if (!todo.length) return;
    const groups = new Map<string, typeof todo>();
    todo.forEach((x) => {
      if (!x.rep) { RES.set(sigOf(x.cfg!, undefined), { res: { state: "gone" }, at: now }); return; }
      const k = `${x.rep.r.source}|${(x.rep.r.with ?? []).join(",")}`;
      groups.set(k, [...(groups.get(k) ?? []), x]);
    });
    setVer((v) => v + 1);
    void Promise.all([...groups.values()].map(async (xs) => {
      {
        const r0 = xs[0].rep!.r;
        const extra = (r0.with ?? []) as EntityKey[];
        try {
          const d = await loadCrmData(r0.source, undefined, extra, [...new Set(xs.flatMap((x) => partsUsed(x.rep!.r)))]);
          const fs = await buildCrmFields(r0.source, d, extra);
          const rows = buildCrmRows(r0.source, d, extra);
          xs.forEach((x) => {
            const sig = sigOf(x.cfg!, x.rep!.s);
            try { RES.set(sig, { res: compute(widgetOf(x.s.id, x.cfg!), x.rep!.r, fs, rows), at: Date.now() }); }
            catch (e: any) { RES.set(sig, { res: { state: "error", msg: String(e?.message ?? e) }, at: Date.now() }); }
          });
          setReportPeriod(DEFAULT_REPORT_PERIOD);
        } catch (e: any) {
          xs.forEach((x) => RES.set(sigOf(x.cfg!, x.rep!.s), { res: { state: "error", msg: String(e?.message ?? e) }, at: Date.now() }));
        }
        if (!off) setVer((v) => v + 1);
      }
    }));
    return () => { off = true; };
  }, [need]); // eslint-disable-line react-hooks/exhaustive-deps

  const card = (_key: string, slot: HomeSlot): ReactNode => {
    const cfg = slot.cfg as RepCfg | undefined;
    const rep = saved ? reportOfCfg(cfg, saved) : null;
    const res = cfg && saved ? RES.get(sigOf(cfg, rep?.s))?.res : undefined;
    const e = rep ? entityOf(rep.r.source) : null;
    const tone = e?.tone ?? "#2f6fd6";
    const per = rep?.r.period && rep.r.period.key !== "all"
      ? (rep.r.period.key === "custom" ? prettyRange("custom", rep.r.period.from, rep.r.period.to) : PERIODS.find((p) => p.key === rep.r.period!.key)?.label ?? "")
      : "";
    const ok = res?.state === "ok" ? res : null;
    const chartTitle = cfg?.show === "chart" && rep ? (ok?.chart?.title || ((cfg.chartId && rep.r.charts.find((c) => c.id === cfg.chartId)) || rep.r.charts[cfg.chartIdx ?? 0])?.title || rep.name) : "";
    const title = !saved ? "…" : !rep ? "Report no longer there" : cfg?.show === "chart" ? chartTitle : rep.name;
    const eyebrow = !rep ? "Report" : cfg?.show === "chart" ? rep.name : cfg?.show === "table" ? "First rows" : "Figures";
    const count = ok ? `${ok.count.toLocaleString("en-GB")} ${ok.count === 1 ? (e?.label.toLowerCase() ?? "row") : (e?.plural.toLowerCase() ?? "rows")}` : "";
    const open = () => { if (rep?.s) nav(`/reports?report=${rep.s.id}`); else nav("/reports"); };
    return (
      <section className={`cz-card hr-card is-${cfg?.show ?? "chart"}`} style={{ ["--c" as string]: tone } as CSSProperties} aria-label={title}>
        <header className="cz-head hr-head">
          <span className="hr-ico" aria-hidden="true"><Ico d={e?.icon ?? REPORT_ICON} /></span>
          <div className="cz-titles">
            <span className="cz-eyebrow" title={eyebrow}>{eyebrow}</span>
            <h2 className="cz-title hr-title" title={title}><span>{title}</span>{(count || per) && <small>{[count, per].filter(Boolean).join(" · ")}</small>}</h2>
          </div>
          {rep && <button type="button" className="cz-link hr-open" onClick={open} title="Open the report">Report<i aria-hidden="true">→</i></button>}
        </header>
        <div className="hr-body">
          {!saved || (rep && !res) ? <div className="cz-skel" />
            : !rep || res?.state === "gone" ? <p className="cz-empty">It was deleted or isn't shared with you any more. Take the card away, or add another report.</p>
              : res?.state === "error" ? <p className="cz-empty is-bad">Couldn't read it: {res.msg}</p>
                : !ok ? null
                  : cfg?.show === "figures" && ok.figs ? (
                    <div className="rh-figs hr-figs">
                      {ok.figs.map((f, k) => (
                        <div key={k} className="rh-fig" style={{ ["--fc" as string]: k === 0 ? tone : PALETTE[k % PALETTE.length] } as CSSProperties}>
                          <span title={f.label}>{f.label}</span><b title={f.value}>{f.value}</b><em>{f.sub}</em>
                        </div>
                      ))}
                    </div>
                  ) : cfg?.show === "chart" ? (
                    ok.chart ? (ok.chart.agg.keys.length ? <div className={`hr-chart is-${ok.chart.type}`}><ReportChart type={ok.chart.type} agg={ok.chart.agg} /></div> : <p className="cz-empty">No data for this chart right now.</p>)
                      : <p className="cz-empty">This report has no charts any more. Show its figures or first rows instead (Adjust home).</p>
                  ) : ok.table ? (
                    ok.table.rows.length ? (
                      <div className="rh-tbl-w hr-tbl">
                        <table className="rh-tbl">
                          <thead><tr>{ok.table.cols.map((c, k) => <th key={k} className={c.num ? "is-n" : ""}>{c.label}</th>)}</tr></thead>
                          <tbody>{ok.table.rows.map((r, k) => <tr key={k}>{r.map((v, j) => <td key={j} className={ok.table!.cols[j]?.num ? "is-n" : ""} title={v}>{v || "—"}</td>)}</tr>)}</tbody>
                        </table>
                        {ok.count > ok.table.rows.length && <button type="button" className="rh-more" onClick={open}>All {ok.count.toLocaleString("en-GB")}<Ico d="M9 6l6 6-6 6" w={2.4} /></button>}
                      </div>
                    ) : <p className="cz-empty">No rows with its rules right now.</p>
                  ) : null}
        </div>
      </section>
    );
  };
  return renderSlots(slots, card);
}

/** While adjusting: what the card shows (one of the report's charts, its figures, its first rows). */
export function ReportShowPick({ cfg, onPick }: { cfg: RepCfg | undefined; onPick: (cfg: RepCfg) => void }) {
  const saved = useSavedReports();
  const rep = saved ? reportOfCfg(cfg, saved) : null;
  if (!rep || !cfg) return null;
  return (
    <span className="hr-pick" onPointerDown={(e) => e.stopPropagation()}>
      <Select size="sm" aria-label="What it shows" value={showValue(cfg)} options={showOptions(rep.r)}
        onChange={(v) => onPick(cfgFor({ saved: cfg.saved, tpl: cfg.tpl }, rep.r, v))} />
    </span>
  );
}

/** The card's size menu: what it shows (for cards too narrow for the bar's dropdown). */
export function ReportShowMenu({ cfg, onPick }: { cfg: RepCfg | undefined; onPick: (cfg: RepCfg) => void }) {
  const saved = useSavedReports();
  const rep = saved ? reportOfCfg(cfg, saved) : null;
  if (!rep || !cfg) return null;
  const cur = showValue(cfg);
  return (
    <>
      <b className="hb-sizes-h">Shows</b>
      <div className="hr-menu" role="radiogroup" aria-label="What it shows">
        {showOptions(rep.r).map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={o.value === cur} className={o.value === cur ? "is-on" : ""}
            onClick={() => onPick(cfgFor({ saved: cfg.saved, tpl: cfg.tpl }, rep.r, o.value))}>
            <span>{o.label}</span><em>{o.hint}</em>
          </button>
        ))}
      </div>
    </>
  );
}

/** The library's Reports section: every report you can see, each with what to show and "+ Add". */
export function ReportLibrary({ q, onBoard, onAdd }: { q: string; onBoard: (src: { saved?: string; tpl?: string }) => number; onAdd: (cfg: RepCfg) => void }) {
  const saved = useSavedReports();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [tplOpen, setTplOpen] = useState(false);
  const fold = (s: string) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const f = fold(q);
  const mine = (saved ?? []).filter((s) => !f || fold(`${s.name} ${entityOf((s.config?.v === 2 ? s.config.source : "deal") as EntityKey)?.plural ?? ""} report`).includes(f));
  const tpls = templateTitles().filter((t) => !f || fold(`${t.title} ${t.hint} report ready-made`).includes(f));
  const row = (key: string, name: string, sub: string, r: CrmReport | null, src: { saved?: string; tpl?: string }, i: number) => {
    const e = r ? entityOf(r.source) : null;
    const n = onBoard(src);
    const v = pick[key] ?? (r ? firstShow(r) : "");
    return (
      <div key={key} className={`hb-lib-it hr-lib-it ${n ? "is-in" : ""}`} style={{ ["--i" as string]: Math.min(i, 12) } as CSSProperties}>
        <span className="hb-lib-pic hr-lib-pic" style={{ ["--rc" as string]: e?.tone ?? "#2f6fd6" } as CSSProperties}><Ico d={e?.icon ?? REPORT_ICON} /></span>
        <span className="hb-lib-txt">
          <b title={name}>{name}</b>
          <small>{sub}</small>
          {n > 0 && <span className="hb-lib-where">{n === 1 ? "On the board" : `${n} cards on the board`}</span>}
          {r && (
            <span className="hr-lib-show">
              <Select size="sm" aria-label={`What to show of ${name}`} value={v} options={showOptions(r)} onChange={(x) => setPick((p) => ({ ...p, [key]: x }))} />
            </span>
          )}
        </span>
        <span className="hb-lib-acts">
          <button type="button" className="is-add" disabled={!r} onClick={() => r && onAdd(cfgFor(src, r, v))} title="Add it to the board">+ Add</button>
        </span>
      </div>
    );
  };
  return (
    <>
      {f && saved && mine.length === 0 && tpls.length === 0 && <p className="hb-lib-none">No report matches “{q}”.</p>}
      {!saved ? <p className="hb-lib-none">Reading your reports…</p>
        : mine.length === 0 && !f ? <p className="hb-lib-none hr-lib-none">You have no saved reports yet. Make one in Reports, or start from a ready-made one below.</p>
          : mine.map((s, i) => {
            const r = reportOfSaved(s);
            const e = entityOf(r.source);
            const sub = [e?.plural ?? "", r.charts.length ? `${r.charts.length} ${r.charts.length === 1 ? "chart" : "charts"}` : "No charts", s.owner_id && ME && s.owner_id !== ME ? "Shared with you" : ""].filter(Boolean).join(" · ");
            return row(`s:${s.id}`, s.name, sub, r, { saved: s.id }, i);
          })}
      {tpls.length > 0 && (
        <>
          <button type="button" className={`hr-lib-tpl ${tplOpen || f ? "is-open" : ""}`} onClick={() => setTplOpen((o) => !o)} aria-expanded={tplOpen || !!f}>
            <Ico d="M9 6l6 6-6 6" w={2.4} />Ready-made <i>{tpls.length}</i>
          </button>
          {(tplOpen || f) && tpls.map((t, i) => row(`t:${t.title}`, t.title, t.hint, reportOfTpl(t.title), { tpl: t.title }, i))}
        </>
      )}
    </>
  );
}
