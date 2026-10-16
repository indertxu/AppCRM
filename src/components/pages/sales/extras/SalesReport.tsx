/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../../api/supabase";
import type { Company, Contact } from "../../companies/companiesApi";
import type { Tracking } from "../sales/salesApi";
import { downloadBlob, tableToCsv, tableToXlsx } from "../../../framework/exportFile";
import SalesMultiFilter from "../sales/SalesMultiFilter";
import { useBackToClose } from "../../../framework/useBackToClose";
import SalesForecast from "../sales/SalesForecast";
import { ReportChart, CHART_LABEL, PALETTE, fmtMeasure, type ChartType } from "./ReportCharts";
import {
  GROUP_LABEL, OPS, DEFAULT_OP, NO_VALUE, MEASURE_LABEL, PERIODS,
  buildFields, buildRows, applyConds, buildTable, condComplete, loadFieldLabels, probFor, showCell, sortValue, uid, norm, aggregate,
  inPeriod, periodLabel, prettyRange,
  type Cond, type Field, type Group, type Measure, type ProbSource, type RowMode, type Source, type EngineCtx, type Row, type PeriodKey,
} from "./salesReportEngine";
import "./SalesReport.css";
import { useInactiveIds } from "../../../framework/peopleStatus";
import type { TrackingField } from "./trackingFieldsApi";
import DatePicker from "../../../framework/DatePicker";

/* ─────────────── config ─────────────── */

type View = "list" | "board" | "forecast";
interface ChartCfg { id: string; title: string; type: ChartType; dim: string; measure: Measure; split?: string | null; cumulative?: boolean; wide?: boolean }
export interface ReportConfig {
  name: string;
  view: View;
  rows: { mode: RowMode; source: Source; merge: boolean };
  match: "all" | "any";
  conds: Cond[];
  prob: ProbSource;
  list: { cols: string[]; labels: Record<string, string>; sort: { key: string; dir: "asc" | "desc" } | null; groupBy: string | null; totals: boolean };
  board: { groupBy: string; cardFields: string[]; value: "deal.revenue" | "deal.weighted" };
  forecast: { dateField: string; group: "day" | "month"; value: "weighted" | "full" };
  /** Time range: which date, and a relative period (re-evaluated every time the report opens). */
  period: { field: string; preset: PeriodKey; from: string; to: string };
  charts: ChartCfg[];
}
const DEFAULT_CONFIG: ReportConfig = {
  name: "Untitled report",
  view: "list",
  rows: { mode: "deals", source: "both", merge: true },
  match: "all",
  conds: [],
  prob: "phase",
  list: { cols: ["deal.company", "deal.phase", "deal.owner", "deal.revenue", "deal.weighted", "deal.close", "deal.prob"], labels: {}, sort: null, groupBy: null, totals: true },
  board: { groupBy: "deal.phase", cardFields: ["deal.product", "deal.owner", "deal.close"], value: "deal.revenue" },
  forecast: { dateField: "deal.close", group: "day", value: "weighted" },
  period: { field: "deal.close", preset: "all", from: "", to: "" },
  charts: [
    { id: "c1", title: "Revenue by phase", type: "bar", dim: "deal.phase", measure: "revenue" },
    { id: "c2", title: "Status mix", type: "donut", dim: "deal.status", measure: "count" },
  ],
};
const PRESETS: Record<View, Omit<ChartCfg, "id">[]> = {
  list: [
    { title: "Revenue by phase", type: "bar", dim: "deal.phase", measure: "revenue" },
    { title: "Weighted by owner", type: "hbar", dim: "deal.owner", measure: "weighted" },
    { title: "Revenue by product", type: "donut", dim: "deal.product", measure: "revenue" },
    { title: "Status mix", type: "donut", dim: "deal.status", measure: "count" },
    { title: "Deals by pipeline", type: "bar", dim: "deal.pipeline", measure: "count" },
    { title: "Revenue by month created", type: "area", dim: "created:month", measure: "revenue" },
  ],
  board: [
    { title: "Stage funnel", type: "funnel", dim: "deal.phase", measure: "count" },
    { title: "Value per stage", type: "bar", dim: "deal.phase", measure: "revenue" },
    { title: "Weighted per stage", type: "bar", dim: "deal.phase", measure: "weighted" },
    { title: "Stages by owner", type: "stacked", dim: "deal.owner", measure: "count", split: "deal.phase" },
  ],
  forecast: [
    { title: "Weighted forecast by month", type: "bar", dim: "time:month", measure: "weighted" },
    { title: "Cumulative forecast", type: "area", dim: "time:month", measure: "weighted", cumulative: true },
    { title: "Won vs open by month", type: "stacked", dim: "time:month", measure: "revenue", split: "deal.status" },
    { title: "Forecast by owner", type: "hbar", dim: "deal.owner", measure: "weighted" },
    { title: "Quarterly forecast", type: "bar", dim: "time:quarter", measure: "weighted" },
  ],
};
const PROB_LABEL: Record<ProbSource, string> = { phase: "Phase probability", rep: "Sales estimate", mgr: "Management estimate", avg: "Average of all" };
const VIEW_ICON: Record<View, string> = {
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  board: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  forecast: "M6 3v18M6 6.5h9M6 12h12M6 17.5h7M3.5 6.5h5M3.5 12h5M3.5 17.5h5",
};

/** Fill any option a (possibly older) saved report doesn't have yet. */
function withDefaults(c: Partial<ReportConfig> | null | undefined): ReportConfig {
  const x = (c ?? {}) as Partial<ReportConfig>;
  return {
    ...DEFAULT_CONFIG, ...x,
    rows: { ...DEFAULT_CONFIG.rows, ...(x.rows ?? {}) },
    list: { ...DEFAULT_CONFIG.list, ...(x.list ?? {}) },
    board: { ...DEFAULT_CONFIG.board, ...(x.board ?? {}) },
    forecast: { ...DEFAULT_CONFIG.forecast, ...(x.forecast ?? {}) },
    period: { ...DEFAULT_CONFIG.period, ...(x.period ?? {}) },
    conds: x.conds ?? [], charts: x.charts ?? DEFAULT_CONFIG.charts,
  };
}

/** The working copy survives closing the builder (like the export does). */
let lastSession: { cfg: ReportConfig; id: string | null; saved: string; present: boolean } | null = null;

interface SavedReport { id: string; name: string; owner_id: string | null; shared: boolean; updated_at: string; config: ReportConfig }

interface Props {
  deals: Tracking[];
  contacts: Contact[];
  companies: Company[];
  employees: { id: string; name: string }[];
  trackAssignees: Record<string, string[]>;
  trackOwners: Record<string, string>;
  potentialTotals: Record<string, number>;
  pipelineNames: string[];
  productNames: string[];
  phaseNames: string[];
  me: string | null;
  /** Custom deal fields: columns, conditions, groupings and chart dimensions. */
  trackingFields?: TrackingField[];
  helpers: {
    pipelineName: (id: string | null) => string;
    productName: (id: string | null) => string | null;
    phaseName: (t: Tracking) => string;
    phaseProbOf: (t: Tracking) => number | null;
    closeDateOf: (t: Tracking) => string | null;
    progressOf: (t: Tracking) => number | null;
    trackTitle: (t: Tracking) => string;
  };
  onOpenDeal: (id: string) => void;
  onClose: () => void;
}

const Ico = ({ d, w = 2 }: { d: string; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  x: "M6 6l12 12M18 6L6 18", plus: "M12 5v14M5 12h14", grip: "", eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4", save: "M5 3h11l3 3v15H5zM8 3v6h8M8 21v-7h8v7", down: "M12 4v11M7 10l5 5 5-5M5 20h14",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13", up: "M12 19V5M6 11l6-6 6 6", dn: "M12 5v14M6 13l6 6 6-6", chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8", copy: "M8 8h11v11H8zM5 16V5h11",
};

/* small reusable pieces */
function Seg<T extends string>({ value, options, onChange, small }: { value: T; options: { value: T; label: string; icon?: string }[]; onChange: (v: T) => void; small?: boolean }) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className={`rb-seg ${small ? "is-sm" : ""}`} style={{ ["--n" as string]: options.length, ["--k" as string]: idx } as CSSProperties}>
      <span className="rb-seg-pill" />
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? "is-on" : ""} onClick={() => onChange(o.value)}>
          {o.icon && <Ico d={o.icon} w={1.9} />}{o.label}
        </button>
      ))}
    </div>
  );
}
function Pick({ value, options, onChange, placeholder }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; placeholder: string }) {
  return <SalesMultiFilter single values={value ? [value] : []} onChange={(v) => v[0] && onChange(v[0])} options={options} placeholder={placeholder} searchFrom={10} />;
}
function Sec({ title, hint, children, open: openInit = true, extra }: { title: string; hint?: string; children: ReactNode; open?: boolean; extra?: ReactNode }) {
  const [open, setOpen] = useState(openInit);
  return (
    <section className={`rb-sec ${open ? "is-open" : ""}`}>
      <header>
        <button className="rb-sec-h" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <svg className="rb-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
          <b>{title}</b>{hint && <em>{hint}</em>}
        </button>
        {extra}
      </header>
      <div className="rb-sec-body"><div>{children}</div></div>
    </section>
  );
}
function useTween(target: number, ms = 800) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const a = from.current, start = performance.now(); let raf = 0;
    const step = (now: number) => { const k = Math.min(1, (now - start) / ms); setV(a + (target - a) * (1 - Math.pow(1 - k, 4))); if (k < 1) raf = requestAnimationFrame(step); else from.current = target; };
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
function Kpi({ label, value, fmt, sub, i, hero }: { label: string; value: number; fmt: (n: number) => string; sub?: string; i: number; hero?: boolean }) {
  const v = useTween(value);
  return (
    <div className={`rb-kpi ${hero ? "is-hero" : ""}`} style={{ ["--i" as string]: i } as CSSProperties}>
      <span>{label}</span><b>{fmt(v)}</b>{sub && <em>{sub}</em>}
    </div>
  );
}

/* ─────────────── component ─────────────── */

export default function SalesReport(p: Props) {
  // Laid-off people: never offered as a choice (their past deals still show their name).
  const inactive = useInactiveIds();
  const formerNames = useMemo(() => new Set(p.employees.filter((e) => inactive.has(e.id)).map((e) => e.name)), [p.employees, inactive]);
  useBackToClose("sales-report", p.onClose);
  const [cfg, setCfg] = useState<ReportConfig>(withDefaults(lastSession?.cfg));
  const [reportId, setReportId] = useState<string | null>(lastSession?.id ?? null);
  const [savedSnap, setSavedSnap] = useState<string>(lastSession?.saved ?? JSON.stringify(DEFAULT_CONFIG));
  const [present, setPresent] = useState(lastSession?.present ?? false);
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [shared, setShared] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [tableMissing, setTableMissing] = useState(false);
  const [contactLabels, setContactLabels] = useState<Record<string, string>>({});
  const [companyLabels, setCompanyLabels] = useState<Record<string, string>>({});
  const [colQ, setColQ] = useState("");
  const [editLabel, setEditLabel] = useState<string | null>(null);
  const [listLimit, setListLimit] = useState(150);
  const [chartEdit, setChartEdit] = useState<string | null>(null);
  const dragKey = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const set = <K extends keyof ReportConfig>(k: K, v: ReportConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const setIn = <K extends "list" | "board" | "forecast" | "rows" | "period">(k: K, patch: Partial<ReportConfig[K]>) => setCfg((c) => ({ ...c, [k]: { ...c[k], ...patch } }));
  const dirty = JSON.stringify(cfg) !== savedSnap;

  useEffect(() => { lastSession = { cfg, id: reportId, saved: savedSnap, present }; }, [cfg, reportId, savedSnap, present]);
  useEffect(() => {
    loadFieldLabels("contact_fields").then(setContactLabels);
    loadFieldLabels("company_fields").then(setCompanyLabels);
    loadSaved();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".smf-menu, .dp-pop")) { if (menu) setMenu(false); else p.onClose(); } };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [menu, p]);
  useEffect(() => {
    if (!menu) return;
    const off = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener("mousedown", off, true);
    return () => window.removeEventListener("mousedown", off, true);
  }, [menu]);
  useEffect(() => { if (note) { const t = setTimeout(() => setNote(null), 2600); return () => clearTimeout(t); } }, [note]);

  /* ---- saved reports (Supabase) ---- */
  async function loadSaved() {
    const { data, error } = await supabase.from("sales_reports").select("id, name, owner_id, shared, updated_at, config").order("updated_at", { ascending: false });
    if (error) { setTableMissing(true); return; }
    setSaved((data ?? []) as SavedReport[]);
    const cur = (data ?? []).find((r: any) => r.id === reportId);
    if (cur) setShared(!!cur.shared);
  }
  const openReport = (r: SavedReport) => {
    const c = withDefaults({ ...r.config, name: r.name });
    setCfg(c); setReportId(r.id); setShared(r.shared); setSavedSnap(JSON.stringify(c)); setMenu(false);
    setPresent(!!(r.config as any)?.openInView); // opens the way it was saved: View or Edit
    setNote(`Opened “${r.name}”`);
  };
  const newReport = () => { setCfg(DEFAULT_CONFIG); setReportId(null); setShared(false); setSavedSnap(JSON.stringify(DEFAULT_CONFIG)); setMenu(false); setPresent(false); };
  const save = async (asCopy = false) => {
    if (tableMissing) { setNote("Run empower_sales_reports.sql in Supabase to save reports"); return; }
    setBusy(true);
    const name = (asCopy ? `${cfg.name} (copy)` : cfg.name).trim() || "Untitled report";
    const body = { name, config: { ...cfg, name, openInView: present }, shared, updated_at: new Date().toISOString() };
    const res = !asCopy && reportId
      ? await supabase.from("sales_reports").update(body).eq("id", reportId).select("id").single()
      : await supabase.from("sales_reports").insert(body).select("id").single();
    setBusy(false);
    if (res.error) { setNote(`Couldn't save: ${res.error.message}`); return; }
    const c = { ...cfg, name };
    setCfg(c); setReportId((res.data as any).id); setSavedSnap(JSON.stringify(c)); setNote(asCopy ? "Saved as a copy" : "Report saved");
    loadSaved();
  };
  const remove = async (r: SavedReport) => {
    if (!window.confirm(`Delete “${r.name}”? This can't be undone.`)) return;
    const { error } = await supabase.from("sales_reports").delete().eq("id", r.id);
    if (error) { setNote(error.message); return; }
    if (r.id === reportId) newReport();
    loadSaved();
  };

  /* ---- engine ---- */
  const ctx: EngineCtx = useMemo(() => ({
    contacts: p.contacts, companies: p.companies, employees: p.employees, trackAssignees: p.trackAssignees, trackOwners: p.trackOwners,
    potentialTotals: p.potentialTotals, pipelineNames: p.pipelineNames, productNames: p.productNames, phaseNames: p.phaseNames,
    contactLabels, companyLabels, dealFields: p.trackingFields ?? [],
    pipelineName: p.helpers.pipelineName, productName: p.helpers.productName, phaseName: p.helpers.phaseName,
    phaseProbOf: p.helpers.phaseProbOf, closeDateOf: p.helpers.closeDateOf, progressOf: p.helpers.progressOf,
    probSource: cfg.prob,
  }), [p, contactLabels, companyLabels, cfg.prob]);
  const fields = useMemo(() => buildFields(ctx), [ctx]);
  const rowMode: RowMode = cfg.view === "list" ? cfg.rows.mode : "deals";
  const available = useMemo(() => fields.filter((f) => (rowMode === "contacts" ? true : f.group !== "contact")), [fields, rowMode]);
  const fieldByKey = useMemo(() => new Map(available.map((f) => [f.key, f])), [available]);
  const allByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  const baseRows = useMemo(() => buildRows(p.deals, rowMode, cfg.rows.source, p.contacts, p.companies), [p.deals, rowMode, cfg.rows.source, p.contacts, p.companies]);
  const periodField = allByKey.get(cfg.period.field) ?? allByKey.get("deal.close");
  const matched = useMemo(() => {
    const byConds = applyConds(baseRows, cfg.conds, cfg.match, fieldByKey);
    if (cfg.period.preset === "all" || !periodField) return byConds;
    return byConds.filter((r) => inPeriod(periodField.get(r), cfg.period.preset, cfg.period.from, cfg.period.to));
  }, [baseRows, cfg.conds, cfg.match, fieldByKey, cfg.period, periodField]);
  const dealRows = useMemo<Row[]>(() => { const s = new Set<string>(); return matched.filter((r) => { const id = r.deal.id as string; if (s.has(id)) return false; s.add(id); return true; }); }, [matched]);
  const deals = useMemo(() => dealRows.map((r) => r.deal), [dealRows]);

  const revenueOf = (t: Tracking) => p.potentialTotals[t.id as string] || 0;
  const probOf = (t: Tracking) => probFor(ctx, t).p;
  const weightedOf = (t: Tracking) => (revenueOf(t) * (probOf(t) ?? 0)) / 100;
  const dateField = allByKey.get(cfg.forecast.dateField) ?? allByKey.get("deal.close")!;
  const dateOf = (t: Tracking) => dateField?.get({ deal: t, contact: null, company: null }) ?? null;
  const createdOf = (t: Tracking) => (t.created_at ? String(t.created_at).slice(0, 10) : null);

  /* ---- headline figures ---- */
  const kpi = useMemo(() => {
    const open = deals.filter((t) => t.status !== "won" && t.status !== "lost");
    const probs = open.map(probOf).filter((x): x is number => x != null);
    return {
      deals: deals.length,
      revenue: deals.reduce((a, t) => a + revenueOf(t), 0),
      weighted: open.reduce((a, t) => a + weightedOf(t), 0),
      avg: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0,
      won: deals.filter((t) => t.status === "won").reduce((a, t) => a + revenueOf(t), 0),
    };
  }, [deals, ctx]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- list table ---- */
  const colFields = cfg.list.cols.map((k) => fieldByKey.get(k)).filter((f): f is Field => !!f);
  const table = useMemo(() => {
    const rows = buildTable(matched, colFields, rowMode, cfg.rows.merge);
    const s = cfg.list.sort;
    if (s) {
      const ci = colFields.findIndex((f) => f.key === s.key);
      if (ci >= 0) rows.sort((a, b) => {
        const va = sortValue(a.cells[ci]), vb = sortValue(b.cells[ci]);
        if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
        const r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
        return s.dir === "asc" ? r : -r;
      });
    }
    return rows;
  }, [matched, cfg.list.cols, cfg.list.sort, rowMode, cfg.rows.merge, fieldByKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const groupF = cfg.list.groupBy ? fieldByKey.get(cfg.list.groupBy) ?? null : null;
  const dealById = useMemo(() => new Map(p.deals.map((t) => [t.id as string, t])), [p.deals]);
  const totalsFor = (dealIds: string[]) => colFields.map((f) => {
    if (!f.sum) return null;
    let t = 0, any = false;
    new Set(dealIds).forEach((id) => { const d = dealById.get(id); if (!d) return; const v = f.get({ deal: d, contact: null, company: null }); const n = Number(v); if (v != null && Number.isFinite(n)) { t += n; any = true; } });
    return any ? t : null;
  });
  const grouped = useMemo(() => {
    if (!groupF) return null;
    const m = new Map<string, typeof table>();
    table.forEach((r) => {
      const d = dealById.get(r.dealIds[0]); const v = d ? groupF.get({ deal: d, contact: null, company: null }) : null;
      const k = v == null || v === "" ? "—" : String(v);
      if (!m.has(k)) m.set(k, []); m.get(k)!.push(r);
    });
    const order = groupF.options ?? [];
    return [...m.entries()].sort(([a], [b]) => (a === "—" ? 1 : b === "—" ? -1 : order.indexOf(a) - order.indexOf(b) || a.localeCompare(b)));
  }, [table, groupF, dealById]);

  /* ---- board ---- */
  const boardF = fieldByKey.get(cfg.board.groupBy) ?? fieldByKey.get("deal.phase")!;
  const boardCols = useMemo(() => {
    const m = new Map<string, Tracking[]>();
    deals.forEach((t) => { const v = boardF?.get({ deal: t, contact: null, company: null }); const k = v == null || v === "" ? "—" : String(v); if (!m.has(k)) m.set(k, []); m.get(k)!.push(t); });
    const order = boardF?.options ?? [];
    return [...m.entries()].sort(([a], [b]) => (a === "—" ? 1 : b === "—" ? -1 : (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999) || a.localeCompare(b)));
  }, [deals, boardF]);
  const boardValue = (t: Tracking) => (cfg.board.value === "deal.weighted" ? weightedOf(t) : revenueOf(t));

  /* ---- charts ---- */
  // time dims: "time:<grain>" = by the report's date (close date), "created:<grain>" = by creation date
  const chartData = (c: ChartCfg) => aggregate({
    deals: dealRows, dim: c.dim.startsWith("created:") ? `time:${c.dim.slice(8)}` : c.dim, measure: c.measure, split: c.split, fieldByKey: allByKey,
    revenueOf, weightedOf, probOf, dateOf: c.dim.startsWith("created:") ? createdOf : dateOf,
    cumulative: c.cumulative,
  });
  const addChart = (pr: Omit<ChartCfg, "id">) => { const id = uid(); set("charts", [...cfg.charts, { ...pr, id }]); setChartEdit(id); };
  const patchChart = (id: string, patch: Partial<ChartCfg>) => set("charts", cfg.charts.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const moveChart = (id: string, dir: -1 | 1) => {
    const i = cfg.charts.findIndex((c) => c.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= cfg.charts.length) return;
    const next = [...cfg.charts]; [next[i], next[j]] = [next[j], next[i]]; set("charts", next);
  };
  const dimOptions = useMemo(() => [
    { value: "time:week", label: "Expected close · by week" }, { value: "time:month", label: "Expected close · by month" }, { value: "time:quarter", label: "Expected close · by quarter" },
    { value: "created:month", label: "Created · by month" }, { value: "created:quarter", label: "Created · by quarter" },
    ...fields.filter((f) => f.group !== "contact" && (f.kind === "enum" || f.key === "deal.company")).map((f) => ({ value: f.key, label: `${GROUP_LABEL[f.group]} · ${f.label}` })),
  ], [fields]);

  /** Dates a report can be placed / filtered by: the built-in ones plus any custom date field. */
  const dateFieldOptions = useMemo(() => [
    { value: "deal.close", label: "Expected close date" }, { value: "deal.rep_close_date", label: "Expected close · sales" },
    { value: "deal.mgr_close_date", label: "Expected close · management" }, { value: "deal.close_date", label: "Close date" }, { value: "deal.created", label: "Deal created" },
    ...fields.filter((f) => f.key.startsWith("deal.custom.") && f.kind === "date").map((f) => ({ value: f.key, label: f.label })),
  ], [fields]);

  /* ---- conditions ---- */
  const fieldOptions = available.map((f) => ({ value: f.key, label: `${GROUP_LABEL[f.group]} · ${f.label}` }));
  const addCond = () => { const f = fieldByKey.get("deal.phase") ?? available[0]; set("conds", [...cfg.conds, { id: uid(), field: f.key, op: DEFAULT_OP[f.kind], a: "", b: "", vals: [] }]); };
  const patchCond = (id: string, patch: Partial<Cond>) => set("conds", cfg.conds.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const changeCondField = (id: string, key: string) => { const f = fieldByKey.get(key); if (f) patchCond(id, { field: key, op: DEFAULT_OP[f.kind], a: "", b: "", vals: [] }); };

  /* ---- columns ---- */
  const toggleCol = (k: string) => setIn("list", { cols: cfg.list.cols.includes(k) ? cfg.list.cols.filter((x) => x !== k) : [...cfg.list.cols, k] });
  const dropOn = (target: string) => {
    const from = dragKey.current; dragKey.current = null; setDragOver(null);
    if (!from || from === target) return;
    const next = cfg.list.cols.filter((x) => x !== from); next.splice(next.indexOf(target), 0, from);
    setIn("list", { cols: next });
  };
  const labelOf = (f: Field) => cfg.list.labels[f.key] || f.label;
  const clickHead = (k: string) => {
    const s = cfg.list.sort;
    setIn("list", { sort: !s || s.key !== k ? { key: k, dir: "asc" } : s.dir === "asc" ? { key: k, dir: "desc" } : null });
  };

  /* ---- export the current report data ---- */
  const exportData = (fmt: "xlsx" | "csv") => {
    const cols = colFields.length ? colFields : [fieldByKey.get("deal.company")!].filter(Boolean);
    const rows = (cfg.view === "list" ? table : buildTable(dealRows, cols, "deals", false));
    const data = { columns: cols.map((f) => ({ label: labelOf(f), format: (f.kind === "money" ? "money" : f.kind === "date" ? "date" : f.kind === "percent" ? "percent" : f.kind === "number" ? "number" : "text") as any })), rows: rows.map((r) => r.cells as any) };
    const base = (cfg.name || "sales-report").replace(/[\\/:*?"<>|]+/g, "-");
    downloadBlob(fmt === "xlsx" ? tableToXlsx(data, "Report") : tableToCsv(data), `${base}.${fmt}`);
  };

  const nq = norm(colQ.trim());
  const groupOptions = available.filter((f) => f.kind === "enum").map((f) => ({ value: f.key, label: `${GROUP_LABEL[f.group]} · ${f.label}` }));
  const viewName = { list: "List", board: "Board", forecast: "Forecast" }[cfg.view];

  return createPortal(
    <div className={`rb ${present ? "is-present" : ""}`} role="dialog" aria-label="Sales report builder">
      {/* ============ top bar ============ */}
      <header className="rb-top">
        <div className="rb-brand">
          <span className="rb-logo"><Ico d={I.chart} w={2.2} /></span>
          <div className="rb-name">
            <input value={cfg.name} onChange={(e) => set("name", e.target.value)} aria-label="Report name" spellCheck={false} />
            <span>{dirty ? <i className="is-dirty">Unsaved changes</i> : reportId ? <i>Saved</i> : <i>Not saved yet</i>} · {viewName} · {deals.length} {deals.length === 1 ? "deal" : "deals"}</span>
          </div>
        </div>
        <div className="rb-actions">
          <div className="rb-menu-wrap" ref={menuRef}>
            <button className="rb-btn is-ghost" onClick={() => { setMenu((m) => !m); loadSaved(); }}><Ico d={I.folder} />Reports</button>
            {menu && (
              <div className="rb-menu">
                <button className="rb-menu-new" onClick={newReport}><Ico d={I.plus} />New report</button>
                {tableMissing && <p className="rb-menu-note">Saving needs the <b>sales_reports</b> table — run <code>empower_sales_reports.sql</code> once.</p>}
                {!tableMissing && saved.length === 0 && <p className="rb-menu-note">No saved reports yet.</p>}
                <div className="rb-menu-list">
                  {saved.map((r) => (
                    <div key={r.id} className={`rb-menu-item ${r.id === reportId ? "is-on" : ""}`}>
                      <button onClick={() => openReport(r)}>
                        <b>{r.name}</b>
                        <span>{({ list: "List", board: "Board", forecast: "Forecast" } as any)[r.config?.view] ?? "Report"} · {new Date(r.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{r.shared ? " · shared" : ""}{r.owner_id !== p.me ? " · by a colleague" : ""}</span>
                      </button>
                      {r.owner_id === p.me && <button className="rb-menu-del" onClick={() => remove(r)} aria-label={`Delete ${r.name}`}><Ico d={I.trash} /></button>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button className={`rb-btn is-ghost rb-share ${shared ? "is-on" : ""}`} onClick={() => setShared((s) => !s)} title="Shared reports are visible to everyone in the company">
            <Ico d={I.share} />{shared ? "Shared" : "Private"}
          </button>
          <button className="rb-btn is-ghost" onClick={() => exportData("xlsx")} title="Download this report's data as Excel"><Ico d={I.down} />Excel</button>
          {reportId && <button className="rb-btn is-ghost" onClick={() => save(true)} disabled={busy} title="Save as a new report"><Ico d={I.copy} />Copy</button>}
          <button className="rb-btn is-primary" onClick={() => save(false)} disabled={busy || (!dirty && !!reportId)}><Ico d={I.save} />{busy ? "Saving…" : "Save"}</button>
          <button className={`rb-btn rb-mode ${present ? "is-on" : ""}`} onClick={() => setPresent((v) => !v)}>
            <Ico d={present ? I.edit : I.eye} />{present ? "Edit" : "View"}
          </button>
          <button className="rb-x" onClick={p.onClose} aria-label="Close"><Ico d={I.x} /></button>
        </div>
      </header>

      <div className="rb-body">
        {/* ============ configuration ============ */}
        <aside className="rb-side" aria-hidden={present}>
          <Sec title="View" hint="how the report reads">
            <Seg value={cfg.view} onChange={(v) => set("view", v)} options={[
              { value: "list", label: "List", icon: VIEW_ICON.list }, { value: "board", label: "Board", icon: VIEW_ICON.board }, { value: "forecast", label: "Forecast", icon: VIEW_ICON.forecast },
            ]} />
          </Sec>

          {cfg.view === "list" ? (
            <Sec title="Each row is" hint={cfg.rows.mode === "deals" ? "a deal" : cfg.rows.mode === "contacts" ? "a contact" : "a company"}>
              <Seg value={cfg.rows.mode} onChange={(m) => { setIn("rows", { mode: m }); if (m !== "contacts") { setIn("list", { cols: cfg.list.cols.filter((k) => !k.startsWith("contact.")) }); set("conds", cfg.conds.filter((c) => !c.field.startsWith("contact."))); } }}
                options={[{ value: "deals", label: "A deal" }, { value: "contacts", label: "A contact" }, { value: "companies", label: "A company" }]} small />
              {cfg.rows.mode === "contacts" && (
                <div className="rb-field"><label>Contacts from</label>
                  <Seg value={cfg.rows.source} onChange={(s) => setIn("rows", { source: s })} options={[{ value: "deal", label: "The deal" }, { value: "company", label: "Its company" }, { value: "both", label: "Both" }]} small />
                </div>
              )}
              {cfg.rows.mode !== "deals" && (
                <label className="rb-check"><input type="checkbox" checked={cfg.rows.merge} onChange={(e) => setIn("rows", { merge: e.target.checked })} /><span className="rb-box" />
                  One row per {cfg.rows.mode === "contacts" ? "contact" : "company"}, even across several deals</label>
              )}
            </Sec>
          ) : (
            <div className="rb-note">The {viewName.toLowerCase()} shows one card per deal. Contact rows apply to the list view.</div>
          )}

          <Sec title="Time range" hint={cfg.period.preset === "all" ? "all time" : `${periodLabel(cfg.period.preset)} · ${prettyRange(cfg.period.preset, cfg.period.from, cfg.period.to)}`}>
            <div className="rb-field" style={{ marginTop: 0 }}><label>Date</label>
              <Pick value={cfg.period.field} onChange={(v) => setIn("period", { field: v })} placeholder="Date"
                options={dateFieldOptions} />
            </div>
            <div className="rb-periods">
              {(["all", "this_month", "next_month", "this_quarter", "next_quarter", "this_year", "next_90", "past"] as PeriodKey[]).map((k) => (
                <button key={k} className={`rb-chip ${cfg.period.preset === k ? "is-on" : ""}`} onClick={() => setIn("period", { preset: k })}>{periodLabel(k)}</button>
              ))}
            </div>
            <div className="rb-field"><label>Or any period</label>
              <Pick value={cfg.period.preset} onChange={(v) => setIn("period", { preset: v as PeriodKey })} placeholder="Period"
                options={PERIODS.map((x) => ({ value: x.key, label: x.group === "Any" ? x.label : `${x.group} · ${x.label}` }))} />
            </div>
            {cfg.period.preset === "custom" && (
              <div className="rb-vals rb-custom">
                <span className="rb-date"><DatePicker value={cfg.period.from ?? ""} onChange={(d) => setIn("period", { from: d })} placeholder="From" /></span>
                <span>to</span>
                <span className="rb-date"><DatePicker value={cfg.period.to ?? ""} onChange={(d) => setIn("period", { to: d })} placeholder="To" /></span>
              </div>
            )}
            <p className="rb-hint">{cfg.period.preset === "custom" ? "Fixed dates — leave one empty for “from / until”." : "Relative: a saved report on “This quarter” always shows the current quarter."}</p>
          </Sec>

          <Sec title="Conditions" hint={cfg.conds.length ? `${cfg.conds.filter((c) => condComplete(c, fieldByKey.get(c.field))).length} active` : "all deals"}
            extra={cfg.conds.length > 1 ? <Seg value={cfg.match} onChange={(v) => set("match", v)} options={[{ value: "all", label: "All" }, { value: "any", label: "Any" }]} small /> : undefined}>
            {cfg.conds.length === 0 && <p className="rb-empty">No conditions — every deal you can see is included.</p>}
            <div className="rb-conds">
              {cfg.conds.map((c) => {
                const f = fieldByKey.get(c.field); if (!f) return null;
                const needsVal = !NO_VALUE.has(c.op);
                const ph = f.kind === "money" ? "€" : f.kind === "percent" ? "%" : f.kind === "text" ? "Text" : "";
                return (
                  <div key={c.id} className={`rb-cond ${condComplete(c, f) ? "" : "is-incomplete"}`}>
                    <div className="rb-cond-top">
                      <Pick value={c.field} onChange={(v) => changeCondField(c.id, v)} options={fieldOptions} placeholder="Field" />
                      <button className="rb-icon-btn" onClick={() => set("conds", cfg.conds.filter((x) => x.id !== c.id))} aria-label="Remove condition"><Ico d={I.x} /></button>
                    </div>
                    <Pick value={c.op} onChange={(v) => patchCond(c.id, { op: v })} options={OPS[f.kind]} placeholder="Condition" />
                    {needsVal && f.kind === "date" && c.op === "in_period" && (
                      <Pick value={c.a} onChange={(v) => patchCond(c.id, { a: v })} placeholder="Choose a period"
                        options={PERIODS.filter((x) => x.key !== "all" && x.key !== "custom").map((x) => ({ value: x.key, label: `${x.group} · ${x.label}` }))} />
                    )}
                    {needsVal && f.kind !== "enum" && c.op !== "in_period" && (
                      <div className="rb-vals">
                        <input className="rb-in" type={f.kind === "date" ? "date" : "text"} inputMode={f.kind === "text" || f.kind === "date" ? undefined : "decimal"} value={c.a} placeholder={ph} onChange={(e) => patchCond(c.id, { a: e.target.value })} />
                        {c.op === "between" && <><span>and</span><input className="rb-in" type={f.kind === "date" ? "date" : "text"} inputMode={f.kind === "date" ? undefined : "decimal"} value={c.b} placeholder={ph} onChange={(e) => patchCond(c.id, { b: e.target.value })} /></>}
                      </div>
                    )}
                    {needsVal && f.kind === "enum" && (
                      <div className="rb-chips">
                        {(f.options ?? []).filter((o) => f.key !== "deal.owner" || !formerNames.has(o) || c.vals.includes(o)).map((o) => { const on = c.vals.includes(o); return <button key={o} className={`rb-chip ${on ? "is-on" : ""}`} onClick={() => patchCond(c.id, { vals: on ? c.vals.filter((x) => x !== o) : [...c.vals, o] })}>{o}</button>; })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button className="rb-add" onClick={addCond}><Ico d={I.plus} />Add condition</button>
          </Sec>

          <Sec title="Probability" hint={PROB_LABEL[cfg.prob]} open={false}>
            <Pick value={cfg.prob} onChange={(v) => set("prob", v as ProbSource)} placeholder="Probability"
              options={(Object.keys(PROB_LABEL) as ProbSource[]).map((k) => ({ value: k, label: PROB_LABEL[k] }))} />
            <p className="rb-hint">Drives weighted revenue, the probability column and the charts. Deals without one use their pipeline progress.</p>
          </Sec>

          {cfg.view === "list" && (
            <Sec title="Columns" hint={`${colFields.length} picked`}>
              <div className="rb-picked">
                {colFields.length === 0 && <span className="rb-empty">Pick at least one column below.</span>}
                {colFields.map((f) => (
                  <span key={f.key} draggable className={`rb-pill ${dragOver === f.key ? "is-over" : ""}`}
                    onDragStart={() => { dragKey.current = f.key; }} onDragOver={(e) => { e.preventDefault(); setDragOver(f.key); }}
                    onDragLeave={() => setDragOver((d) => (d === f.key ? null : d))} onDrop={() => dropOn(f.key)} onDragEnd={() => { dragKey.current = null; setDragOver(null); }}
                    onDoubleClick={() => setEditLabel(f.key)} title="Drag to reorder · double-click to rename">
                    <svg className="rb-grip" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
                    {editLabel === f.key ? (
                      <input autoFocus className="rb-pill-in" defaultValue={labelOf(f)} onBlur={(e) => { const v = e.target.value.trim(); setIn("list", { labels: { ...cfg.list.labels, [f.key]: v === f.label ? "" : v } }); setEditLabel(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditLabel(null); }} />
                    ) : <><em>{GROUP_LABEL[f.group]}</em>{labelOf(f)}</>}
                    <button onClick={() => toggleCol(f.key)} aria-label={`Remove ${f.label}`}><Ico d={I.x} w={2.4} /></button>
                  </span>
                ))}
              </div>
              <div className="rb-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                <input value={colQ} onChange={(e) => setColQ(e.target.value)} placeholder="Find a field…" /></div>
              <div className="rb-fieldlist">
                {((rowMode === "contacts" ? ["deal", "contact", "company"] : ["deal", "company"]) as Group[]).map((g) => {
                  const fs = available.filter((f) => f.group === g && (!nq || norm(f.label).includes(nq)));
                  if (!fs.length) return null;
                  return (
                    <div key={g} className="rb-fgroup"><span>{g === "company" && rowMode === "contacts" ? "Company (of the deal)" : GROUP_LABEL[g]}</span>
                      <div className="rb-chips">{fs.map((f) => <button key={f.key} className={`rb-chip ${cfg.list.cols.includes(f.key) ? "is-on" : ""}`} onClick={() => toggleCol(f.key)}>{f.label}</button>)}</div>
                    </div>
                  );
                })}
              </div>
              <div className="rb-field"><label>Group rows by</label>
                <Pick value={cfg.list.groupBy ?? "__none"} onChange={(v) => setIn("list", { groupBy: v === "__none" ? null : v })} placeholder="No grouping"
                  options={[{ value: "__none", label: "No grouping" }, ...groupOptions]} />
              </div>
              <label className="rb-check"><input type="checkbox" checked={cfg.list.totals} onChange={(e) => setIn("list", { totals: e.target.checked })} /><span className="rb-box" />Totals row (and subtotals per group)</label>
            </Sec>
          )}

          {cfg.view === "board" && (
            <Sec title="Board" hint="columns and cards">
              <div className="rb-field"><label>Columns are</label>
                <Pick value={cfg.board.groupBy} onChange={(v) => setIn("board", { groupBy: v })} placeholder="Group by" options={groupOptions} /></div>
              <div className="rb-field"><label>Headline figure</label>
                <Seg value={cfg.board.value} onChange={(v) => setIn("board", { value: v })} options={[{ value: "deal.revenue", label: "Potential" }, { value: "deal.weighted", label: "Weighted" }]} small /></div>
              <div className="rb-field"><label>On each card</label>
                <div className="rb-chips">
                  {available.filter((f) => f.group !== "contact" && !["deal.company", "deal.count"].includes(f.key)).map((f) => {
                    const on = cfg.board.cardFields.includes(f.key);
                    return <button key={f.key} className={`rb-chip ${on ? "is-on" : ""}`} onClick={() => setIn("board", { cardFields: on ? cfg.board.cardFields.filter((x) => x !== f.key) : [...cfg.board.cardFields, f.key] })}>{f.label}</button>;
                  })}
                </div>
              </div>
            </Sec>
          )}

          {cfg.view === "forecast" && (
            <Sec title="Forecast" hint="timeline">
              <div className="rb-field"><label>Place deals by</label>
                <Pick value={cfg.forecast.dateField} onChange={(v) => setIn("forecast", { dateField: v })} placeholder="Date"
                  options={dateFieldOptions} /></div>
              <div className="rb-field"><label>Timeline</label>
                <Seg value={cfg.forecast.group} onChange={(g) => setIn("forecast", { group: g })} options={[{ value: "day", label: "By day" }, { value: "month", label: "By month" }]} small /></div>
              <div className="rb-field"><label>Value</label>
                <Seg value={cfg.forecast.value} onChange={(m) => setIn("forecast", { value: m })} options={[{ value: "weighted", label: "Weighted" }, { value: "full", label: "Full value" }]} small /></div>
            </Sec>
          )}

          <Sec title="Charts" hint={`${cfg.charts.length} on the report`}>
            <div className="rb-gallery">
              {PRESETS[cfg.view].map((pr) => (
                <button key={pr.title} className="rb-preset" onClick={() => addChart(pr)} title={`Add “${pr.title}”`}>
                  <span className={`rb-preset-ico is-${pr.type}`}><i /><i /><i /></span>{pr.title}
                </button>
              ))}
              <button className="rb-preset is-custom" onClick={() => addChart({ title: "Custom chart", type: "bar", dim: "deal.phase", measure: "count" })}><Ico d={I.plus} />Custom chart</button>
            </div>
            <div className="rb-chartlist">
              {cfg.charts.map((c, ci) => (
                <div key={c.id} className={`rb-chartcfg ${chartEdit === c.id ? "is-open" : ""}`}>
                  <div className="rb-chartcfg-h">
                    <button className="rb-chartcfg-t" onClick={() => setChartEdit(chartEdit === c.id ? null : c.id)}><Ico d={I.sliders} /><b>{c.title}</b><em>{CHART_LABEL[c.type]}</em></button>
                    <button className="rb-icon-btn" onClick={() => moveChart(c.id, -1)} disabled={ci === 0} aria-label="Move up"><Ico d={I.up} /></button>
                    <button className="rb-icon-btn" onClick={() => moveChart(c.id, 1)} disabled={ci === cfg.charts.length - 1} aria-label="Move down"><Ico d={I.dn} /></button>
                    <button className="rb-icon-btn" onClick={() => set("charts", cfg.charts.filter((x) => x.id !== c.id))} aria-label="Remove chart"><Ico d={I.trash} /></button>
                  </div>
                  {chartEdit === c.id && (
                    <div className="rb-chartcfg-b">
                      <input className="rb-in" value={c.title} onChange={(e) => patchChart(c.id, { title: e.target.value })} placeholder="Title" />
                      <div className="rb-types">
                        {(Object.keys(CHART_LABEL) as ChartType[]).map((t) => (
                          <button key={t} className={`rb-type ${c.type === t ? "is-on" : ""}`} onClick={() => patchChart(c.id, { type: t })} title={CHART_LABEL[t]}>
                            <span className={`rb-preset-ico is-${t}`}><i /><i /><i /></span>{CHART_LABEL[t]}
                          </button>
                        ))}
                      </div>
                      <div className="rb-field"><label>Group by</label><Pick value={c.dim} onChange={(v) => patchChart(c.id, { dim: v })} options={dimOptions} placeholder="Dimension" /></div>
                      <div className="rb-field"><label>Measure</label><Pick value={c.measure} onChange={(v) => patchChart(c.id, { measure: v as Measure })} placeholder="Measure"
                        options={(Object.keys(MEASURE_LABEL) as Measure[]).map((m) => ({ value: m, label: MEASURE_LABEL[m] }))} /></div>
                      {c.type === "stacked" && <div className="rb-field"><label>Split by</label><Pick value={c.split ?? ""} onChange={(v) => patchChart(c.id, { split: v })} placeholder="Split" options={dimOptions.filter((o) => !o.value.includes(":"))} /></div>}
                      <div className="rb-checks">
                        {(c.type === "line" || c.type === "area" || c.type === "bar") && (c.dim.startsWith("time:") || c.dim.startsWith("created:")) && (
                          <label className="rb-check"><input type="checkbox" checked={!!c.cumulative} onChange={(e) => patchChart(c.id, { cumulative: e.target.checked })} /><span className="rb-box" />Cumulative</label>
                        )}
                        <label className="rb-check"><input type="checkbox" checked={!!c.wide} onChange={(e) => patchChart(c.id, { wide: e.target.checked })} /><span className="rb-box" />Full width</label>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Sec>
        </aside>

        {/* ============ live preview ============ */}
        <main className="rb-preview">
          <div className="rb-paper" key={cfg.view}>
            <div className="rb-paper-head">
              <div>
                <span className="rb-eyebrow">{viewName} report · {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</span>
                <h1>{cfg.name || "Untitled report"}</h1>
                {(cfg.period.preset !== "all" || cfg.conds.some((c) => condComplete(c, fieldByKey.get(c.field)))) && (
                  <div className="rb-applied">
                    {cfg.period.preset !== "all" && (
                      <span className="is-time"><b>{periodField?.label ?? "Date"}</b> {periodLabel(cfg.period.preset).toLowerCase()} · {prettyRange(cfg.period.preset, cfg.period.from, cfg.period.to)}</span>
                    )}
                    {cfg.conds.filter((c) => condComplete(c, fieldByKey.get(c.field))).map((c) => {
                      const f = fieldByKey.get(c.field)!; const op = OPS[f.kind].find((o) => o.value === c.op)?.label ?? c.op;
                      const val = NO_VALUE.has(c.op) ? "" : f.kind === "enum" ? c.vals.join(", ") : c.op === "in_period" ? `${periodLabel(c.a).toLowerCase()} (${prettyRange(c.a)})` : c.op === "between" ? `${c.a} – ${c.b}` : c.a;
                      return <span key={c.id}><b>{f.label}</b> {op} {val}</span>;
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="rb-kpis">
              <Kpi i={0} label="Deals" value={kpi.deals} fmt={(n) => Math.round(n).toLocaleString("es-ES")} sub={cfg.view === "list" && rowMode !== "deals" ? `${table.length} rows` : undefined} />
              <Kpi i={1} label="Potential revenue" value={kpi.revenue} fmt={(n) => fmtMeasure("revenue", n)} />
              <Kpi i={2} label="Weighted (open)" value={kpi.weighted} fmt={(n) => fmtMeasure("weighted", n)} sub={PROB_LABEL[cfg.prob]} hero />
              <Kpi i={3} label="Avg. probability" value={kpi.avg} fmt={(n) => `${Math.round(n)}%`} sub="open deals" />
              <Kpi i={4} label="Won" value={kpi.won} fmt={(n) => fmtMeasure("revenue", n)} />
            </div>

            {cfg.charts.length > 0 && (
              <div className="rb-charts">
                {cfg.charts.map((c, i) => (
                  <figure key={c.id} className={`rb-chart ${c.wide || c.type === "line" || c.type === "area" ? "is-wide" : ""}`} style={{ ["--i" as string]: i } as CSSProperties}>
                    <figcaption>
                      <b>{c.title}</b>
                      <span>{MEASURE_LABEL[c.measure]}{c.cumulative ? " · cumulative" : ""} · by {dimOptions.find((o) => o.value === c.dim)?.label.split(" · ").pop()?.toLowerCase() ?? "—"}</span>
                      {!present && <button className="rb-icon-btn" onClick={() => setChartEdit(c.id)} aria-label="Edit chart"><Ico d={I.sliders} /></button>}
                    </figcaption>
                    <ReportChart type={c.type} agg={chartData(c)} />
                  </figure>
                ))}
              </div>
            )}

            {/* ---------- the view ---------- */}
            {cfg.view === "list" && (
              colFields.length === 0 ? <div className="rb-blank">Choose columns in the panel to build the table.</div>
              : table.length === 0 ? <div className="rb-blank">Nothing matches these conditions.</div>
              : (
                <div className="rb-tablewrap">
                  <table className="rb-table">
                    <thead><tr>
                      {colFields.map((f) => {
                        const s = cfg.list.sort?.key === f.key ? cfg.list.sort.dir : null;
                        return (
                          <th key={f.key} className={`${["money", "number", "percent"].includes(f.kind) ? "is-num" : ""} ${s ? "is-sorted" : ""}`}>
                            <button onClick={() => clickHead(f.key)}>{labelOf(f)}<span className="rb-sortico">{s === "asc" ? "↑" : s === "desc" ? "↓" : "↕"}</span></button>
                          </th>
                        );
                      })}
                    </tr></thead>
                    <tbody>
                      {(grouped ?? [["", table] as [string, typeof table]]).map(([g, rows]) => (
                        <ReportRows key={g || "_"} title={grouped ? g : null} rows={rows} colFields={colFields} limit={listLimit}
                          totals={cfg.list.totals && grouped ? totalsFor(rows.flatMap((r) => r.dealIds)) : null}
                          onOpen={(id) => p.onOpenDeal(id)} />
                      ))}
                    </tbody>
                    {cfg.list.totals && (
                      <tfoot><tr>
                        {totalsFor(table.flatMap((r) => r.dealIds)).map((t, i) => (
                          <td key={i} className={t != null ? "is-num" : ""}>{i === 0 && t == null ? `Total · ${table.length} ${table.length === 1 ? "row" : "rows"}` : t != null ? showCell(colFields[i], t) : ""}</td>
                        ))}
                      </tr></tfoot>
                    )}
                  </table>
                  {table.length > listLimit && <button className="rb-more" onClick={() => setListLimit((n) => n + 300)}>Show {Math.min(300, table.length - listLimit)} more of {table.length - listLimit}</button>}
                </div>
              )
            )}

            {cfg.view === "board" && (
              deals.length === 0 ? <div className="rb-blank">Nothing matches these conditions.</div> : (
                <div className="rb-board">
                  {boardCols.map(([col, ts], ci) => {
                    const sum = ts.reduce((a, t) => a + boardValue(t), 0);
                    const max = Math.max(1, ...boardCols.map(([, x]) => x.reduce((a, t) => a + boardValue(t), 0)));
                    return (
                      <div className="rb-bcol" key={col} style={{ ["--i" as string]: ci, ["--c" as string]: PALETTE[ci % PALETTE.length] } as CSSProperties}>
                        <header>
                          <div><b>{col}</b><em>{ts.length}</em></div>
                          <span>{fmtMeasure("revenue", sum)}</span>
                          <i className="rb-bcol-bar"><i style={{ width: `${(sum / max) * 100}%` }} /></i>
                        </header>
                        <div className="rb-bcards">
                          {ts.map((t, ti) => (
                            <button key={t.id} className="rb-bcard" onClick={() => p.onOpenDeal(t.id as string)} style={{ ["--j" as string]: Math.min(ti, 12) } as CSSProperties}>
                              <span className="rb-bcard-top"><b>{p.helpers.trackTitle(t)}</b><em>{fmtMeasure("revenue", boardValue(t))}</em></span>
                              {cfg.board.cardFields.map((k) => {
                                const f = fieldByKey.get(k); if (!f) return null;
                                const v = showCell(f, (() => { const raw = f.get({ deal: t, contact: null, company: t.company_id ? (p.companies.find((c) => c.id === t.company_id) ?? null) : null }); return raw == null || raw === "" ? null : f.kind === "date" ? { date: String(raw).slice(0, 10) } : ["money", "number", "percent"].includes(f.kind) ? Number(raw) : String(raw); })());
                                return v ? <span key={k} className="rb-bcard-f"><small>{f.label}</small>{v}</span> : null;
                              })}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}

            {cfg.view === "forecast" && (
              <div className="rb-fc">
                <SalesForecast
                  onKpis={() => {}}
                  trackings={deals}
                  potentialTotals={p.potentialTotals}
                  closeDateOf={(t) => dateOf(t)}
                  probOf={(t) => { const r = probFor({ ...ctx, progressOf: () => null }, t); return r.p; }}
                  fallbackProbOf={p.helpers.progressOf}
                  probLabel={PROB_LABEL[cfg.prob]}
                  trackTitle={p.helpers.trackTitle}
                  phaseName={p.helpers.phaseName}
                  ownerName={(t) => p.employees.find((e) => e.id === p.trackOwners[t.id as string])?.name ?? null}
                  productName={(t) => p.helpers.productName(t.product_id)}
                  onOpen={(id) => p.onOpenDeal(id)}
                  group={cfg.forecast.group}
                  onGroupChange={(g) => setIn("forecast", { group: g })}
                  valueMode={cfg.forecast.value}
                  onValueModeChange={(m) => setIn("forecast", { value: m })}
                />
              </div>
            )}
          </div>
        </main>
      </div>

      {note && <div className="rb-toast" role="status">{note}</div>}
    </div>,
    document.body,
  );
}

/* table body for one group (or the whole table) */
function ReportRows({ title, rows, colFields, limit, totals, onOpen }: {
  title: string | null; rows: { cells: any[]; dealIds: string[]; key: string }[]; colFields: Field[]; limit: number;
  totals: (number | null)[] | null; onOpen: (id: string) => void;
}) {
  return (
    <>
      {title != null && (
        <tr className="rb-grow"><td colSpan={colFields.length}>
          <b>{title}</b><em>{rows.length} {rows.length === 1 ? "row" : "rows"}</em>
          {totals && totals.map((t, i) => (t != null ? <span key={i}>{colFields[i].label}: <strong>{showCell(colFields[i], t)}</strong></span> : null))}
        </td></tr>
      )}
      {rows.slice(0, limit).map((r, ri) => (
        <tr key={r.key} className="rb-row" onClick={() => r.dealIds.length === 1 && onOpen(r.dealIds[0])} style={{ ["--r" as string]: Math.min(ri, 20) } as CSSProperties}>
          {r.cells.map((c, ci) => <td key={ci} className={typeof c === "number" ? "is-num" : ""}>{showCell(colFields[ci], c)}</td>)}
        </tr>
      ))}
    </>
  );
}