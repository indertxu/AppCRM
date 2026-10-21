/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import SalesMultiFilter from "./SalesMultiFilter";
import SalesRangeFilter, { EMPTY_RANGES, activeRangeCount, HeaderRangePopover, rangeActive, clearRange, type SalesRanges, type RangeKind } from "./SalesRangeFilter";
import SalesForecast, { type ForecastKpis } from "./SalesForecast";
import { supabase } from "../../../api/supabase";
import { listCompanies, listContacts, myProfile, sessionUserId, loadPrefs, savePref, type Company, type Contact } from "../../companies/companiesApi";
import { listPipelines, loadPipeline, loadPhasesByPipeline, sortPipelines, moveDealsToPipeline, type Pipeline, type Phase } from "../../settings/pipelineApi";
import { useBulkSelection, BulkBar, BulkCheck, DataTools, SettingsShell, GEAR, type BulkAction, type SxSection } from "../../companies/CompaniesPage";
import { PageCover, PageLoader } from "../../../framework/AppLayout";
import { loadProducts, loadServices, type Product } from "../../settings/catalogApi";
import { listTrackings, loadTrackingTeams, loadSalesBoot, type SalesBootRows, setTrackingPhase, setTrackingStatus, deleteTracking, setTrackingOwner, addTrackingEmployee, removeTrackingEmployee, setDealCloseDate, setDealCloseProb, stampPhaseEntry, clearPhaseEventsAfter, trackingPct, loadPotentialTotals, yearTotalsFromLastRows, type Tracking,
  clientExistsForCompany, hasClientProductsForTracking, loadTrackingProducts } from "./salesApi";
import TrackingDetail from "../trackings/TrackingDetail";
import { HxPrompt } from "../trackings/HandoffConfirmServices";
import ExportModal from "../extras/ExportModal";
import SalesReport from "../extras/SalesReport";
import NewTracking from "./NewTracking";
import TrackingFieldsModal from "../extras/TrackingFieldsModal";
import { listTrackingFields, type TrackingField } from "../extras/trackingFieldsApi";
import ActionsMenu, { AM_ICON, type ActionItem } from "../../../framework/ActionsMenu";
import SalesRolesModal from "../extras/SalesRolesModal";
import DealImport from "../extras/DealImport";
import { loadAccessRules, resolvePerms, accessFromPerms, type RuleMap } from "../extras/salesAccess";
import HandoverConfirm from "../trackings/HandoverConfirm";
import HandedOverView from "../trackings/HandedOverView";
import {
  loadSalesRoles, loadHandovers, loadAllPhaseEvents, frozenCopy, planHandover, performHandover,
  type SalesRole, type TrackingHandover, type HandoverPlan,
} from "../extras/salesRolesApi";
import "../../companies/CompaniesPage.css";
import "./SalesPage.css";
import "../trackings/Handover.css";
import { useInactiveIds } from "../../../framework/peopleStatus";

export interface Employee { id: string; name: string; role?: string; email?: string; is_superadmin?: boolean }


const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/* ===================================================================
   Overview building blocks (presentation only). Same visual language as
   Management's Team tab and the consultant modal.
   =================================================================== */
/** Status shown to people: "paused" is called "hold" (the stored value stays "paused"). */
const statusText = (s: string | null | undefined) => (s === "paused" ? "hold" : s ?? "");

const soVars = (o: Record<string, string | number>) => o as CSSProperties;
const soReduced = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const soHue = (s: string) => {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};

/** Eased count-up: from zero on mount, then glides when the value changes. */
function useSoCount(target: number, ms = 1100) {
  const [value, setValue] = useState(() => (soReduced() ? target : 0));
  const from = useRef(value);
  useEffect(() => {
    if (soReduced()) { from.current = target; setValue(target); return; }
    let raf = 0;
    const start = from.current;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      const cur = start + (target - start) * e;
      from.current = cur;
      setValue(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}
function SoCount({ value }: { value: number }) {
  return <>{Math.round(useSoCount(value)).toLocaleString("de-DE")}</>;
}
function useSoArmed(ms: number) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), soReduced() ? 0 : ms);
    return () => window.clearTimeout(t);
  }, [ms]);
  return armed;
}

/** One pointer handler drives every spotlight and tilt on the overview. */
function soSpotlight(e: ReactPointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse") return;
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-spot]");
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  el.style.setProperty("--mx", `${x}px`);
  el.style.setProperty("--my", `${y}px`);
  if (el.dataset.spot === "tilt") {
    el.style.setProperty("--ry", `${(x / r.width - 0.5) * 7}deg`);
    el.style.setProperty("--rx", `${(0.5 - y / r.height) * 7}deg`);
  }
}

const SO_ICON = {
  total: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 10h18M8 5v14",
  active: "M13 2L3 14h7l-1 8 10-12h-7z",
  won: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3",
  lost: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15 9l-6 6M9 9l6 6",
  rate: "M3 17l6-6 4 4 8-8M17 7h4v4",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  board: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  forecast: "M6 3v18M6 6.5h9M6 12h12M6 17.5h7M3.5 6.5h5M3.5 12h5M3.5 17.5h5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 2",
  report: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  export: "M12 4v11M7 10l5 5 5-5M5 20h14",
  arrow: "M5 12h14M13 6l6 6-6 6",
  star: "M12 2l3 6.5 7 .6-5.3 4.6 1.6 6.9L12 17.8 5.7 20.6l1.6-6.9L2 9.1l7-.6z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  empty: "M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4",
  roles: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6",
};
function SoIcon({ d, w = 2, fill = false }: { d: string; w?: number; fill?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const SO_ARC = "M16 70 A54 54 0 0 1 124 70";

/* ---------------- Overview KPIs: two stat cards ----------------
   Total: count · value, and a bar split open / won / lost with its legend.
   Won:   a ring (share of deals won) around the trophy, count · value, and two
          meters (% of the deals, % of the value). Clicking a card filters the list. */
const fmtEur0 = (n: number) => `${Math.round(n).toLocaleString("de-DE")} €`;

function SoStatShell({ index, tone, on, onClick, title, loading, children }: {
  index: number; tone: string; on: boolean; onClick: () => void; title?: string; loading: boolean; children: ReactNode;
}) {
  return (
    <button type="button" className={`so-kpi so-stat tone-${tone} ${on ? "is-on" : ""} ${loading ? "is-loading" : ""}`}
      data-spot="tilt" style={soVars({ "--i": index })} onClick={onClick} aria-pressed={on} title={title}>
      <span className="so-stat-glow" aria-hidden="true" />
      {children}
      <span className="so-kpi-check so-stat-check" aria-hidden="true" />
    </button>
  );
}

function SoStatTotal({ label, total, value, open, openValue, won, lost, on, onClick, loading }: {
  label: string; total: number; value: number; open: number; openValue: number; won: number; lost: number;
  on: boolean; onClick: () => void; loading: boolean;
}) {
  const armed = useSoArmed(520);
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  const seg = [
    { k: "open", n: open, label: "open" },
    { k: "won", n: won, label: "won" },
    { k: "lost", n: lost, label: "lost" },
  ];
  return (
    <SoStatShell index={0} tone="total" on={on} onClick={onClick} title="Show every deal" loading={loading}>
      <span className="so-stat-ico" aria-hidden="true"><SoIcon d={SO_ICON.total} w={1.9} /></span>
      <span className="so-stat-main">
        <span className="so-stat-eyebrow">{label}</span>
        <span className="so-stat-figs">
          <b className="so-stat-n"><SoCount value={total} /></b>
          <i className="so-stat-unit">{total === 1 ? "deal" : "deals"}</i>
          <span className="so-stat-dot" aria-hidden="true" />
          <b className="so-stat-money"><SoCount value={value} /><em>€</em></b>
        </span>
      </span>
      <span className="so-stat-aside">
        <span className="so-stat-split" aria-hidden="true">
          {seg.map((s) => (
            <i key={s.k} className={`is-${s.k}`} style={{ flexGrow: armed ? Math.max(pct(s.n), s.n ? 2 : 0) : 0 }} />
          ))}
          {total === 0 && <i className="is-none" style={{ flexGrow: 1 }} />}
        </span>
        <span className="so-stat-legend">
          {seg.map((s) => (
            <span key={s.k} className={`is-${s.k}`}><i aria-hidden="true" /><b>{s.n.toLocaleString("de-DE")}</b> {s.label}</span>
          ))}
        </span>
        <small className="so-stat-note">{open ? `${fmtEur0(openValue)} still in play` : total ? "Nothing open in this selection" : "No deals match"}</small>
      </span>
    </SoStatShell>
  );
}

function SoStatWon({ won, value, total, totalValue, on, onClick, loading }: {
  won: number; value: number; total: number; totalValue: number; on: boolean; onClick: () => void; loading: boolean;
}) {
  const armed = useSoArmed(620);
  const dealPct = total ? Math.round((won / total) * 100) : 0;
  const valPct = totalValue ? Math.round((value / totalValue) * 100) : 0;
  const C = 2 * Math.PI * 22;
  return (
    <SoStatShell index={1} tone="won" on={on} onClick={onClick} title="Show the won deals" loading={loading}>
      <span className="so-stat-ring" aria-hidden="true">
        <svg viewBox="0 0 52 52">
          <circle className="so-ring-bg" cx="26" cy="26" r="22" />
          <circle className={`so-ring-fg ${armed && dealPct > 0 ? "" : "is-zero"}`} cx="26" cy="26" r="22" strokeDasharray={`${armed ? (dealPct / 100) * C : 0} ${C}`} />
        </svg>
        <SoIcon d={SO_ICON.won} w={1.9} />
      </span>
      <span className="so-stat-main">
        <span className="so-stat-eyebrow">Won</span>
        <span className="so-stat-figs">
          <b className="so-stat-n"><SoCount value={won} /></b>
          <i className="so-stat-unit">{won === 1 ? "deal" : "deals"}</i>
          <span className="so-stat-dot" aria-hidden="true" />
          <b className="so-stat-money"><SoCount value={value} /><em>€</em></b>
        </span>
      </span>
      <span className="so-stat-aside">
        {[{ k: "deals", p: dealPct, label: "of the deals" }, { k: "value", p: valPct, label: "of the value" }].map((m) => (
          <span key={m.k} className="so-stat-meter">
            <span><b><SoCount value={m.p} />%</b> {m.label}</span>
            <span className="so-stat-track" aria-hidden="true"><i style={{ width: `${armed ? m.p : 0}%` }} /></span>
          </span>
        ))}
      </span>
    </SoStatShell>
  );
}

/** A status card in the dark band. Clicking it filters the list, as before. */
function SoKpi({
  index, tone, icon, label, value, sub, share, dial, on, onClick, title, unit, money, moneyLabel,
}: {
  index: number; tone: string; icon: string; label: string; value: number; sub: string;
  share?: number | null; dial?: number | null; on: boolean; onClick: () => void; title?: string;
  /** e.g. "€" for money figures */
  unit?: string;
  /** A money figure shown next to the count (e.g. the deals' total value). */
  money?: number; moneyLabel?: string;
}) {
  const armed = useSoArmed(420 + index * 90);
  const s = Math.max(0, Math.min(1, share ?? 0));
  const d = Math.max(0, Math.min(100, dial ?? 0));
  return (
    <button
      type="button"
      className={`so-kpi tone-${tone} ${on ? "is-on" : ""}`}
      data-spot="tilt"
      style={soVars({ "--i": index, "--w": `${armed ? s * 100 : 0}%` })}
      onClick={onClick}
      aria-pressed={on}
      title={title}
    >
      <span className="so-kpi-top">
        <span className="so-kpi-ico"><SoIcon d={icon} /></span>
        <span className="so-kpi-label">{label}</span>
        <span className="so-kpi-check" aria-hidden="true" />
      </span>
      <span className="so-kpi-body">
        <span className="so-kpi-txt">
          <span className="so-kpi-figs">
            <b className="so-kpi-val"><SoCount value={value} />{dial != null && <em>%</em>}{unit && <em className="so-kpi-unit">{unit}</em>}</b>
            {money != null && (
              <span className="so-kpi-money"><b><SoCount value={money} /><em>€</em></b>{moneyLabel && <i>{moneyLabel}</i>}</span>
            )}
          </span>
          <small>{sub}</small>
        </span>
        {dial != null && (
          <span className="so-kpi-dial" aria-hidden="true">
            <svg viewBox="0 0 140 80">
              <path className="so-dial-bg" d={SO_ARC} pathLength={100} />
              <path className={`so-dial-fg ${armed && d > 0 ? "" : "is-zero"}`} d={SO_ARC} pathLength={100}
                style={{ strokeDasharray: `${armed ? d : 0} 101` }} />
            </svg>
          </span>
        )}
      </span>
      {share != null && <span className="so-kpi-bar" aria-hidden="true"><i /></span>}
    </button>
  );
}

/* ---------------- Opening fast ----------------
   What Sales showed last time is kept (in memory, and for this browser tab in
   sessionStorage), so coming back paints the list at once and then refreshes it
   quietly. Signing out forgets it; another user never sees it (checked by id). */
type DealsBundle = [
  Tracking[], Record<string, number>, { members: Record<string, string[]>; owners: Record<string, string> },
  { roles: SalesRole[]; missing: boolean }, TrackingHandover[], Record<string, string[]>, { rules: RuleMap; missing: boolean },
];
interface SalesSnap {
  uid: string; at: number; deals: DealsBundle;
  me: { id: string; role: string; is_superadmin: boolean } | null;
  companies: Company[]; pipelines: Pipeline[]; phaseByPipe: Record<string, Phase[]>;
  employees: Employee[]; products: Product[]; trackingFields: TrackingField[]; contacts?: Contact[];
}
const SNAP_KEY = "empower.sales.snap.v1";
let salesSnap: SalesSnap | null = null;
function readSalesSnap(): SalesSnap | null {
  if (salesSnap) return salesSnap;
  try { const raw = sessionStorage.getItem(SNAP_KEY); if (raw) salesSnap = JSON.parse(raw) as SalesSnap; } catch { /* storage off or unreadable */ }
  return salesSnap;
}
function writeSalesSnap(s: SalesSnap) {
  salesSnap = s;
  try {
    const { contacts: _c, ...light } = s; // contacts are the heavy part: memory only
    const raw = JSON.stringify(light);
    if (raw.length < 3_000_000) sessionStorage.setItem(SNAP_KEY, raw); else sessionStorage.removeItem(SNAP_KEY);
  } catch { /* quota or private mode: memory copy still works */ }
}
function forgetSalesSnap() {
  salesSnap = null;
  try { sessionStorage.removeItem(SNAP_KEY); } catch { /* nothing to forget */ }
}
try {
  (supabase.auth as any).onAuthStateChange?.((ev: string) => { if (ev === "SIGNED_OUT") forgetSalesSnap(); });
} catch { /* no auth events here */ }

/** Companies by id, a few hundred per request, all requests at once. */
async function companiesByIds(ids: (string | null | undefined)[]): Promise<Company[]> {
  const uniq = Array.from(new Set(ids.filter(Boolean) as string[]));
  if (!uniq.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += 150) chunks.push(uniq.slice(i, i + 150));
  const parts = await Promise.all(chunks.map((c) =>
    Promise.resolve(supabase.from("companies").select("*").in("id", c)).then(({ data }: any) => (data ?? []) as Company[]).catch(() => [] as Company[])));
  return parts.flat().sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/** How many rows the list draws at first; more follow as you scroll. */
const LIST_STEP = 60;

// ============================ Deals list columns ============================
/** The rich built-in columns (as before) plus plain ones; the deal column is always first. */
type ColDef = { key: string; label: string; min: number; track: string; right?: boolean; sort?: "stage" | "product" | "rev" | "close" | "prob" };
const BUILTIN_COLS: ColDef[] = [
  { key: "stage", label: "Stage", min: 200, track: "minmax(200px, 1.25fr)", sort: "stage" },
  { key: "product", label: "Product and owner", min: 170, track: "minmax(170px, 1fr)", sort: "product" },
  { key: "value", label: "Potential value · expected close", min: 150, track: "150px", right: true, sort: "rev" },
  { key: "prob", label: "Close chance", min: 110, track: "110px", right: true, sort: "prob" },
];
const PLAIN_COLS: ColDef[] = [
  { key: "company", label: "Company", min: 150, track: "minmax(150px, 1fr)" },
  { key: "pipeline", label: "Pipeline", min: 130, track: "minmax(130px, 0.8fr)" },
  { key: "phase", label: "Phase", min: 130, track: "minmax(130px, 0.8fr)" },
  { key: "status", label: "Status", min: 90, track: "90px" },
  { key: "owner", label: "Owner", min: 130, track: "minmax(130px, 0.8fr)" },
  { key: "team", label: "People on the deal", min: 150, track: "minmax(150px, 1fr)" },
  { key: "productName", label: "Product", min: 140, track: "minmax(140px, 0.9fr)" },
  { key: "revenue", label: "Potential value", min: 120, track: "120px", right: true, sort: "rev" },
  { key: "expected", label: "Expected close", min: 120, track: "120px", right: true, sort: "close" },
  { key: "closed", label: "Won / lost on", min: 110, track: "110px", right: true },
  { key: "started", label: "Started", min: 100, track: "100px", right: true },
  { key: "contacts", label: "Contacts", min: 90, track: "90px", right: true },
  { key: "phaseProb", label: "Phase probability", min: 110, track: "110px", right: true },
  { key: "repProb", label: "Sales estimate", min: 110, track: "110px", right: true },
  { key: "mgrProb", label: "Management estimate", min: 120, track: "120px", right: true },
];
const DEFAULT_COLS = ["stage", "product", "value", "prob"];
const COLS_PREF = "deals.columns";
const fieldCol = (f: TrackingField): ColDef => ({ key: `f:${f.id}`, label: f.label, min: 130, track: f.type === "number" || f.type === "date" ? "120px" : "minmax(130px, 0.9fr)", right: f.type === "number" });
const fmtDay = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" }) : "");
const fmtField = (f: TrackingField, v: unknown): string => {
  if (v == null || v === "") return "";
  if (f.type === "boolean") return v === true || v === "true" ? "Yes" : "No";
  if (f.type === "date") return fmtDay(String(v));
  if (f.type === "number") return Number(v).toLocaleString("de-DE");
  return Array.isArray(v) ? v.join(", ") : String(v);
};

/** Pick, order and reset the list's columns (saved per person). */
function DealColumns({ all, cols, onChange }: { all: ColDef[]; cols: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [open]);
  const byKey = new Map(all.map((c) => [c.key, c]));
  const shown = cols.filter((k) => byKey.has(k));
  const hidden = all.filter((c) => !shown.includes(c.key) && c.label.toLowerCase().includes(q.trim().toLowerCase()));
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= shown.length) return; const n = [...shown]; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
  const same = shown.join() === DEFAULT_COLS.join();
  return (
    <div className="so-colpick" ref={ref}>
      <button type="button" className={`so-colbtn ${open ? "is-on" : ""}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Choose the columns">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></svg>
        Columns<em>{shown.length + 1}</em>
      </button>
      {open && (
        <div className="so-colpop" role="dialog" aria-label="Columns">
          <div className="so-colpop-head">
            <b>Columns</b>
            {!same && <button type="button" onClick={() => onChange(DEFAULT_COLS)}>Reset</button>}
          </div>
          <span className="so-colpop-k">Shown · in this order</span>
          <ul className="so-colpop-list">
            <li className="is-fixed"><span className="so-colpop-grip" />Deal<em>always first</em></li>
            {shown.map((k, i) => (
              <li key={k}>
                <span className="so-colpop-mv">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6" /></svg></button>
                  <button type="button" disabled={i === shown.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg></button>
                </span>
                <span className="so-colpop-l">{byKey.get(k)!.label}</span>
                <button type="button" className="so-colpop-x" onClick={() => onChange(shown.filter((x) => x !== k))} aria-label={`Hide ${byKey.get(k)!.label}`}>
                  <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </li>
            ))}
          </ul>
          <span className="so-colpop-k">Add a column</span>
          <input className="so-colpop-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search columns…" />
          <ul className="so-colpop-list is-add">
            {hidden.map((c) => (
              <li key={c.key}>
                <button type="button" onClick={() => onChange([...shown, c.key])}>
                  <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>{c.label}{c.key.startsWith("f:") && <em>custom</em>}
                </button>
              </li>
            ))}
            {!hidden.length && <li className="is-none">Nothing else to add.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}


/* The dark header floats as a rounded card (index.css: .fh). The card is sized to the header + figures
   (they change height with the data, the tab and the width) and a soft glow follows the pointer over it. */
function useFloatingHero(ref: { current: HTMLElement | null }, sel: string) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const rt = root.getBoundingClientRect();
      let bottom = 0;
      root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height > 0) bottom = Math.max(bottom, r.bottom - rt.top + root.scrollTop);
      });
      root.style.setProperty("--fh-h", `${Math.max(0, Math.round(bottom - 22))}px`);
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(measure); };
    const ro = new ResizeObserver(queue);
    const watch = () => { ro.observe(root); root.querySelectorAll<HTMLElement>(sel).forEach((el) => ro.observe(el)); };
    watch(); measure();
    const mo = new MutationObserver(() => { watch(); queue(); });
    mo.observe(root, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  });
}
function fhMove(e: { clientX: number; clientY: number; currentTarget: HTMLElement; pointerType?: string }) {
  if (e.pointerType && e.pointerType !== "mouse") return;
  const root = e.currentTarget;
  const r = root.getBoundingClientRect();
  const x = e.clientX - r.left - 14, y = e.clientY - r.top + root.scrollTop - 12;
  const h = parseFloat(root.style.getPropertyValue("--fh-h")) || 0;
  root.style.setProperty("--fh-x", `${Math.round(x)}px`);
  root.style.setProperty("--fh-y", `${Math.round(y)}px`);
  root.style.setProperty("--fh-on", x >= 0 && y >= 0 && y <= h && x <= r.width - 28 ? "1" : "0");
}
const fhLeave = (e: { currentTarget: HTMLElement }) => e.currentTarget.style.setProperty("--fh-on", "0");

/**
 * The Deals page. With `settings`, the same page renders as Settings › Deals page instead:
 * import & export, deal fields and sales roles, with the data and permissions the page already loads.
 */
export default function SalesPage({ settings }: { settings?: { onBack: () => void } } = {}) {
  const fhRef = useRef<HTMLDivElement>(null);
  useFloatingHero(fhRef, ".sl-head, .so-kpis");
  const navigate = useNavigate();
  // Last time's data (if any): the page paints with it straight away and refreshes underneath.
  const [snap0] = useState(readSalesSnap);
  const [trackings, setTrackings] = useState<Tracking[]>(() => snap0?.deals[0] ?? []);
  // First load (nothing kept from before): skeleton rows until everything the list needs is in
  // (deals, who I am and what I may see, the deals' companies, people, pipelines and phases) —
  // all fetched in one round of parallel requests and applied in one render.
  const [booted, setBooted] = useState(!!snap0);
  /** Loading progress: requests answered / asked (drives the bar over the list). */
  const [bootStep, setBootStep] = useState<{ done: number; total: number }>({ done: 0, total: 1 });
  /** True while the kept copy is on screen and the fresh data is still coming. */
  const [refreshing, setRefreshing] = useState(!!snap0);
  /** The shared page loader covers the first load; never trap the page behind it: a very slow or failed load lets go after 15 s. */
  const [coverGaveUp, setCoverGaveUp] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setCoverGaveUp(true), 15000); return () => window.clearTimeout(t); }, []);
  const [rawTotals, setPotentialTotals] = useState<Record<string, number>>(() => snap0?.deals[1] ?? {});
  const [companies, setCompanies] = useState<Company[]>(() => snap0?.companies ?? []);
  const [contacts, setContacts] = useState<Contact[]>(() => snap0?.contacts ?? []);
  const [pipelines, setPipelines] = useState<Pipeline[]>(() => snap0?.pipelines ?? []);
  const [products, setProducts] = useState<Product[]>(() => snap0?.products ?? []);
  const [employees, setEmployees] = useState<Employee[]>(() => snap0?.employees ?? []);
  const [trackAssignees, setTrackAssignees] = useState<Record<string, string[]>>(() => snap0?.deals[2].members ?? {});
  const [trackOwners, setTrackOwners] = useState<Record<string, string>>(() => snap0?.deals[2].owners ?? {});
  const [me, setMe] = useState<{ id: string; role: string; is_superadmin: boolean } | null>(() => snap0?.me ?? null);
  const [phaseByPipe, setPhaseByPipe] = useState<Record<string, Phase[]>>(() => snap0?.phaseByPipe ?? {});
  const [openId, setOpenId] = useState<string | null>(null);

  /** Arriving from the sales calendar with ?tracking=… opens that deal. */
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("tracking");
    if (id) setOpenId(id);
  }, []);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [importing, setImporting] = useState(false);
  /** Sales roles (who sees which pipelines, up to which phase) and the handovers they caused. */
  const [salesRoles, setSalesRoles] = useState<SalesRole[]>(() => snap0?.deals[3].roles ?? []);
  const [rolesReady, setRolesReady] = useState(!!snap0);
  /** Access settings (Sales roles → Who sees what → Adjust settings). */
  const [accessRules, setAccessRules] = useState<RuleMap>(() => snap0?.deals[6].rules ?? {});
  const [accessMissing, setAccessMissing] = useState(() => !!snap0?.deals[6].missing);
  const [handovers, setHandovers] = useState<TrackingHandover[]>(() => snap0?.deals[4] ?? []);
  const [phaseEvents, setPhaseEvents] = useState<Record<string, string[]>>(() => snap0?.deals[5] ?? {});
  const [pendingHandover, setPendingHandover] = useState<{ plan: HandoverPlan; t: Tracking; phaseId: string; phases: Phase[] } | null>(null);
  /** Custom deal fields (Actions → Deal fields). */
  const [trackingFields, setTrackingFields] = useState<TrackingField[]>(() => snap0?.trackingFields ?? []);
  const [view, setView] = useState<"list" | "kanban" | "forecast">("list");
  // List columns: saved per person (profile prefs), with a local copy so they show at once.
  const [cols, setCols] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(COLS_PREF) ?? "null"); return Array.isArray(v) ? v : DEFAULT_COLS; } catch { return DEFAULT_COLS; }
  });
  useEffect(() => {
    loadPrefs().then((p) => { if (Array.isArray(p?.[COLS_PREF])) setCols(p[COLS_PREF]); }).catch(() => {});
  }, []);
  const saveCols = (next: string[]) => {
    setCols(next);
    try { localStorage.setItem(COLS_PREF, JSON.stringify(next)); } catch { /* private mode */ }
    savePref(COLS_PREF, next).catch(() => {});
  };
  const [fcKpi, setFcKpi] = useState<ForecastKpis | null>(null);
  // Board view needs a pipeline; if none is picked when switching to it, pick
  // the first sales pipeline (or the first available) so the board isn't empty.
  const autoPipeRef = useRef<string | null>(null);
  useEffect(() => {
    if (view === "kanban" && fPipeline.length === 0 && pipelines.length > 0) {
      const pool = visiblePipelines.length ? visiblePipelines : pipelines;
      const firstSales = pool.find((p) => (p as any).is_sales) ?? pool[0];
      autoPipeRef.current = firstSales.id;
      setFPipeline([firstSales.id]);
    }
    // Leaving the board: undo the pipeline the board chose by itself. If the
    // user picked pipelines themselves, leave their choice alone.
    if (view !== "kanban" && autoPipeRef.current) {
      if (fPipeline.length === 1 && fPipeline[0] === autoPipeRef.current) setFPipeline([]);
      autoPipeRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, pipelines]);

  const [q, setQ] = useState("");
  // Every filter is multi-select: empty list = no filter.
  const [fStatus, setFStatus] = useState<string[]>([]);
  const [fPipeline, setFPipeline] = useState<string[]>([]);
  const [fProduct, setFProduct] = useState<string[]>([]);
  const [fCompany, setFCompany] = useState<string[]>([]);
  const [fPhase, setFPhase] = useState<string[]>([]);
  const [fOwner, setFOwner] = useState<string[]>([]);
  const [fMember, setFMember] = useState<string[]>([]);
  // The board shows one pipeline; with several selected the user picks which.
  const [boardPipe, setBoardPipe] = useState("");
  // Custom ranges: probability %, expected close date, potential revenue.
  const [fRanges, setFRanges] = useState<SalesRanges>(EMPTY_RANGES);
  // List headers: which column holds a range from its 3rd click, and the open popover.
  const [rangeCol, setRangeCol] = useState<RangeKind | null>(null);
  const [headPop, setHeadPop] = useState<{ kind: RangeKind; rect: DOMRect } | null>(null);
  const [sort, setSort] = useState("recent");
  const [probView, setProbView] = useState<"phase" | "rep" | "mgr" | "avg">("phase");

  /**
   * The catalog (products, services, their tiers and calculators) is read once per visit:
   * the potential-revenue totals and the product column both use the same copy.
   */
  const catalogRef = useRef<{ products: Promise<Product[]>; services: Promise<any[]> } | null>(null);
  const catalog = () => (catalogRef.current ??= {
    products: loadProducts().catch(() => [] as Product[]),
    services: loadServices().catch(() => [] as any[]),
  });

  /** Deals and everything hanging off them — every request at once. `tm` times each one (first load). */
  const fetchDeals = (tm: <T>(what: string, p: Promise<T>) => Promise<T> = (_w, p) => p): Promise<DealsBundle> => {
    const cat = catalog();
    const deals = tm("deals + their contacts", listTrackings().catch(() => [] as Tracking[]));
    return Promise.all([
      deals,
      // Totals reuse the deals and the catalog above instead of reading them again.
      tm("potential revenue (products, services, catalog)", loadPotentialTotals({ trackings: deals, products: cat.products, services: cat.services }).catch(() => ({} as Record<string, number>))),
      tm("deal teams", loadTrackingTeams().catch(() => ({ members: {} as Record<string, string[]>, owners: {} as Record<string, string> }))),
      tm("sales roles", loadSalesRoles().catch(() => ({ roles: [] as SalesRole[], missing: true }))),
      tm("handovers", loadHandovers().catch(() => [] as TrackingHandover[])),
      tm("phase history", loadAllPhaseEvents().catch(() => ({} as Record<string, string[]>))),
      tm("access rules", loadAccessRules().catch(() => ({ rules: {} as RuleMap, missing: true }))),
    ]);
  };
  const applyDeals = ([ts, pt, team, r, h, ev, acc]: DealsBundle) => {
    setTrackings(ts); setPotentialTotals(pt); setTrackAssignees(team.members); setTrackOwners(team.owners);
    setSalesRoles(r.roles); setHandovers(h); setPhaseEvents(ev); setAccessRules(acc.rules); setAccessMissing(acc.missing);
    setRolesReady(true);
  };
  /** Deals bundle from the one-call read. */
  const bundleOf = (b: SalesBootRows): DealsBundle => [b.trackings, b.totals, b.teams, b.roles, b.handovers, b.phaseEvents, b.access];
  // After closing a deal or a change: one call when the database has sales_boot(), table by table otherwise.
  const reload = async () => {
    const b = await loadSalesBoot().catch(() => null);
    applyDeals(b ? bundleOf(b) : await fetchDeals());
  };

  useEffect(() => {
    let alive = true;

    // Every request of the first round is timed; the console gets one line with the total and
    // the slowest request, and a table with all of them (also in window.__salesLoad).
    const t0 = performance.now();
    const marks: { request: string; ms: number; rows: number | string }[] = [];
    let asked = 0, answered = 0;
    const tm = <T,>(what: string, p: Promise<T>): Promise<T> => {
      asked += 1;
      if (alive) setBootStep({ done: answered, total: asked });
      return p.then((v) => {
        answered += 1;
        marks.push({ request: what, ms: Math.round(performance.now() - t0), rows: Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v as object).length : "" });
        if (alive) setBootStep({ done: answered, total: asked });
        return v;
      });
    };

    // Kept copy from another user (same tab, different account)? Drop it before anything else.
    tm("auth session (local)", sessionUserId().catch(() => null)).then((uid) => {
      if (!alive || !snap0 || snap0.uid === uid) return;
      forgetSalesSnap();
      setBooted(false); setRefreshing(false); setRolesReady(false);
      setTrackings([]); setCompanies([]); setContacts([]); setMe(null);
    });

    const fromProfiles = (rows: any[]): Employee[] => rows.map((p) => ({
      id: p.id,
      name: [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || p.email || "—",
      role: p.role ?? "", email: p.email ?? "", is_superadmin: !!p.is_superadmin,
    }));
    const mergeCos = (a: Company[], b: Company[]) => {
      const byId = new Map(a.map((c) => [c.id, c]));
      b.forEach((c) => byId.set(c.id, c));
      return Array.from(byId.values());
    };
    let fullList: Company[] | null = null;
    let dealList: Company[] = [];
    const loadFullCompanies = () => listCompanies().catch(() => [] as Company[]);
    const takeFull = (cos: Company[]) => { if (!alive || !cos.length) return; fullList = cos; setCompanies(mergeCos(cos, dealList)); };

    /** Everything the list needs is in: one render, then the console report. */
    const finish = (dealsB: DealsBundle, meRow: SalesSnap["me"], cos: Company[], ps: Pipeline[], phases: Record<string, Phase[]>, profs: any[]) => {
      if (!alive) return;
      const sales = sortPipelines(ps.filter((p) => p.is_sales));
      applyDeals(dealsB);
      setMe(meRow);
      dealList = cos;
      setCompanies((cur) => mergeCos(fullList ?? cur, cos));
      setPipelines(sales);
      setPhaseByPipe(Object.fromEntries(sales.map((p) => [p.id, (phases[p.id] ?? []).filter((ph) => ph.sales_visible !== false)])));
      setEmployees((cur) => (cur.length ? cur : fromProfiles(profs)));
      setBooted(true);
      setRefreshing(false);
      const total = Math.round(performance.now() - t0);
      const sorted = [...marks].sort((a, b) => b.ms - a.ms);
      (window as any).__salesLoad = { total, requests: sorted };
      console.groupCollapsed(`[sales] ${snap0 ? "refreshed" : "ready"} in ${total} ms · ${dealsB[0].length} deals · slowest: ${sorted[0]?.request ?? "—"} (${sorted[0]?.ms ?? 0} ms)`);
      console.table(sorted);
      console.groupEnd();
      // Not needed for the first paint: they fill in while you look at the list
      // (asked after it, so they don't queue in front of the first read).
      if (!fullList) loadFullCompanies().then(takeFull);
      listContacts().then((cs) => { if (alive) setContacts(cs); }).catch(() => {});
      listTrackingFields().then((fs) => { if (alive) setTrackingFields(fs); }).catch(() => {});
      supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(({ data }: any) => {
        const users = (data?.users ?? []) as any[];
        if (!alive || !users.length) return;
        const byId = new Map<string, any>(profs.map((x) => [x.id, x]));
        setEmployees(users.map((u: any) => {
          const p = byId.get(u.id);
          const profName = p ? [p.first_name, p.last_name].filter(Boolean).join(" ").trim() : "";
          return {
            id: u.id, name: u.full_name || profName || u.email || "—",
            role: p?.role || u.role || "", email: u.email ?? p?.email ?? "", is_superadmin: !!p?.is_superadmin,
          };
        }));
      }).catch(() => {});
    };

    /** Without sales_boot() in the database: every table at once, as before. */
    const tableByTable = () => {
      const cat = catalog();
      cat.products.then((ps) => { if (alive) setProducts(ps); });
      const profiles = tm("people (profiles)", Promise.resolve(
        supabase.from("profiles").select("id, first_name, last_name, email, role, is_superadmin"),
      ).then(({ data }: any) => (data ?? []) as any[]).catch(() => [] as any[]));
      const deals = fetchDeals(tm);
      // The list only needs the companies behind the deals. The full directory is asked for at
      // once; if it's slow (thousands of companies), the deals' own companies are read by id
      // instead — whichever has them first opens the page.
      const fullP = loadFullCompanies();
      fullP.then(takeFull);
      const dealCompanies = tm("companies of the deals", deals.then(([ts]) => new Promise<Company[]>((resolve) => {
        const ids = new Set(ts.map((t) => t.company_id).filter(Boolean) as string[]);
        let settled = false;
        const done = (cos: Company[]) => { if (!settled) { settled = true; resolve(cos); } };
        fullP.then((full) => {
          const have = new Set(full.map((c) => c.id));
          if (Array.from(ids).every((id) => have.has(id))) done(full.filter((c) => ids.has(c.id!)));
        });
        companiesByIds(Array.from(ids)).then(done);
      })));
      Promise.all([
        deals,
        tm("my profile", myProfile().catch(() => null)),
        dealCompanies,
        tm("pipelines", listPipelines().catch(() => [] as Pipeline[])),
        tm("pipeline phases", loadPhasesByPipeline().catch(() => ({} as Record<string, Phase[]>))),
        profiles,
      ]).then(([dealsB, meRow, cos, ps, phases, profs]) => finish(dealsB, meRow, cos, ps, phases, profs));
    };

    // One request for everything (sales_boot in the database); table by table if it isn't there.
    tm("sales_boot — everything in one request", loadSalesBoot().catch(() => null)).then((b) => {
      if (!alive) return;
      if (!b) { tableByTable(); return; }
      catalogRef.current = { products: Promise.resolve(b.products as Product[]), services: Promise.resolve(b.services) };
      setProducts(b.products as Product[]);
      finish(bundleOf(b), b.me, b.companies as Company[], b.pipelines as Pipeline[], b.phasesByPipeline as Record<string, Phase[]>, b.profiles);
    });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep what's on screen for next time (written a moment after it settles).
  useEffect(() => {
    if (!booted || refreshing || !me) return;
    const t = window.setTimeout(() => {
      sessionUserId().then((uid) => {
        if (!uid || uid !== me.id) return;
        writeSalesSnap({
          uid, at: Date.now(), me, companies, pipelines, phaseByPipe, employees, products, trackingFields, contacts,
          deals: [trackings, rawTotals, { members: trackAssignees, owners: trackOwners }, { roles: salesRoles, missing: false }, handovers, phaseEvents, { rules: accessRules, missing: accessMissing }],
        });
      }).catch(() => {});
    }, 700);
    return () => window.clearTimeout(t);
  }, [booted, refreshing, me, trackings, rawTotals, trackAssignees, trackOwners, salesRoles, handovers, phaseEvents, accessRules, accessMissing, companies, pipelines, phaseByPipe, employees, products, trackingFields, contacts]);

  // A pipeline that shows up later (none at the moment) still gets its phases.
  useEffect(() => {
    if (!booted) return;
    pipelines.forEach((p) => {
      if (!phaseByPipe[p.id]) {
        loadPipeline(p.id).then(({ phases }) => setPhaseByPipe((prev) => ({ ...prev, [p.id]: phases.filter((ph) => ph.sales_visible !== false) })))
          .catch(() => setPhaseByPipe((prev) => ({ ...prev, [p.id]: prev[p.id] ?? [] })));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelines, booted]);

  // Lookups by id (a list of thousands of deals × thousands of companies must not search arrays per row).
  const companyById = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);
  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const companyName = (id: string | null) => (id ? companyById.get(id)?.name ?? null : null);
  const contactName = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "—";
  };
  const pipelineName = (id: string | null) => pipelines.find((p) => p.id === id)?.name ?? "—";
  const productName = (id: string | null) => products.find((p) => p.id === id)?.name ?? null;
  const phaseName = (t: Tracking) => (phaseByPipe[t.pipeline_id ?? ""] ?? []).find((p) => p.id === t.current_phase_id)?.name ?? "—";

  // The three close estimates for a deal, then the one chosen by probView.
  const phaseProbOf = (t: Tracking): number | null => {
    if (t.status === "won") return 100;
    if (t.status === "lost") return 0;
    const ph = (phaseByPipe[t.pipeline_id ?? ""] ?? []).find((p) => p.id === t.current_phase_id);
    if (!ph) return null;
    if (ph.sales_outcome === "win") return 100;
    if (ph.sales_outcome === "loss") return 0;
    return ph.close_probability ?? null;
  };
  const avgProbOf = (t: Tracking): number | null => {
    const vals = [phaseProbOf(t), t.rep_close_prob ?? null, t.mgr_close_prob ?? null].filter((v): v is number => v != null);
    return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  };
  const shownProbOf = (t: Tracking): number | null => {
    if (probView === "rep") return t.rep_close_prob ?? null;
    if (probView === "mgr") return t.mgr_close_prob ?? null;
    if (probView === "avg") return avgProbOf(t);
    return phaseProbOf(t);
  };
  // Expected close date to show in the list: if I'm on this deal's sales team I see
  // the rep's estimate (fallback to the manager's); otherwise the manager's
  // (fallback to the rep's).
  const closeDateOf = (t: Tracking): string | null => {
    const onTeam = !!me && (trackAssignees[t.id] ?? []).includes(me.id);
    const rep = t.rep_close_date || null, mgr = t.mgr_close_date || null;
    return onTeam ? (rep ?? mgr) : (mgr ?? rep);
  };
  const trackTitle = (t: Tracking) => t.deal_name?.trim() || companyName(t.company_id) || (t.contactIds[0] ? contactName(t.contactIds[0]) : "Untitled");

  // People offered in the owner / "on deal" filters: sales-team roles, plus
  // anyone already set as an owner or member (so nobody disappears from the
  // filter just because their role changed).
  const inactive = useInactiveIds(); // laid-off people (Settings → Organization)
  const salesPeople = useMemo(() => {
    const SALES = new Set(["sales", "sales_manager", "boss"]);
    const involved = new Set<string>(Object.values(trackOwners));
    Object.values(trackAssignees).forEach((ids) => ids.forEach((id) => involved.add(id)));
    return employees
      .filter((e) => SALES.has(e.role ?? "") || involved.has(e.id))
      .filter((e) => !inactive.has(e.id)) // former employees aren't offered as a filter
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [employees, trackOwners, trackAssignees, inactive]);

  const allPhaseNames = useMemo(() => {
    const s = new Set<string>();
    Object.values(phaseByPipe).forEach((ph) => ph.forEach((p) => s.add(p.name)));
    return Array.from(s);
  }, [phaseByPipe]);

  /**
   * Everything this person is allowed to see, before any filter is applied.
   * The KPIs, the company dropdown and the board all read from here, so they
   * can never report on deals the list is hiding.
   */
  // What this person's sales roles let them see (bosses / sales managers: everything).
  // What I can see and do in Sales (Who sees what → Adjust settings).
  const perms = useMemo(() => (me
    ? resolvePerms({ id: me.id, name: "", role: me.role, is_superadmin: me.is_superadmin }, { rules: accessRules, roles: salesRoles, pipelines, phaseByPipe })
    : null), [me, accessRules, salesRoles, pipelines, phaseByPipe]);
  const canFields = !!perms?.fields.value;
  const canManage = !!perms?.manage.value;
  const canImport = !!perms?.import.value;
  const canReports = !!perms?.reports.value;
  const exportLevel = perms?.export.value ?? "none";
  const createLevel = perms?.create.value ?? "none";
  const allowedViews = (["list", "kanban", "forecast"] as const).filter((v) => !perms || perms.views[v === "kanban" ? "board" : v].value);
  const access = useMemo(() => (perms ? accessFromPerms({
    me: me?.id ?? null, perms, roles: salesRoles, phaseByPipe, events: phaseEvents, handovers,
    onDeal: (t) => !!me && ((trackAssignees[t.id] ?? []).includes(me.id) || trackOwners[t.id] === me.id),
  }) : { restricted: true, myRoles: [], pipelines: null, view: () => null }), [me, perms, salesRoles, phaseByPipe, phaseEvents, handovers, trackAssignees, trackOwners]);
  /** Deals this person handed over: they keep a frozen copy, as it was at the handover. */
  const frozenById = useMemo(() => {
    const m = new Map<string, TrackingHandover>();
    if (access.restricted) trackings.forEach((t) => { const v = access.view(t); if (v?.mode === "frozen") m.set(t.id, v.handover); });
    return m;
  }, [access, trackings]);
  const mine = useMemo(() => {
    // Until we know who's looking, show nothing (not everything).
    // (and until their settings are loaded, nothing either).
    if (!me || !rolesReady) return [];
    if (!access.restricted) return trackings;
    // All deals or only theirs, as far as their role lets them see
    // (plus frozen copies of deals they handed over).
    return trackings.flatMap((t) => {
      const v = access.view(t);
      if (!v) return [];
      return v.mode === "frozen" ? [frozenCopy(t, v.handover)] : [t];
    });
  }, [trackings, me, access, rolesReady]);
  // Export: everything, or only what this person can see (Who sees what → Adjust settings).
  const exportDeals = exportLevel === "all" ? trackings : mine;
  const exportCompanies = useMemo(() => {
    if (exportLevel === "all") return companies;
    const ids = new Set(mine.map((t) => t.company_id).filter(Boolean));
    return companies.filter((c) => ids.has(c.id!));
  }, [exportLevel, companies, mine]);
  const exportContacts = useMemo(() => {
    if (exportLevel === "all") return contacts;
    const cos = new Set(mine.map((t) => t.company_id).filter(Boolean) as string[]);
    const ids = new Set(mine.flatMap((t) => t.contactIds));
    return contacts.filter((c) => ids.has(c.id!) || c.companyIds.some((x) => cos.has(x)));
  }, [exportLevel, contacts, mine]);
  // A view this person can't use isn't shown; land on one they can.
  useEffect(() => {
    if (perms && allowedViews.length && !(allowedViews as readonly string[]).includes(view)) setView(allowedViews[0]);
  }, [perms, view]); // eslint-disable-line react-hooks/exhaustive-deps
  // Values shown for a frozen deal are the ones it had at the handover.
  // Deal value: the whole contract (a 3-year subscription × 3) or only this year's share.
  const [valueMode, setValueModeS] = useState<"term" | "year">(() => { try { return localStorage.getItem("sales.valueMode") === "year" ? "year" : "term"; } catch { return "term"; } });
  const setValueMode = (v: "term" | "year") => { setValueModeS(v); try { localStorage.setItem("sales.valueMode", v); } catch { /* private mode */ } };
  const baseTotals = useMemo(() => (valueMode === "year" ? yearTotalsFromLastRows() ?? rawTotals : rawTotals), [valueMode, rawTotals]);
  const potentialTotals = useMemo(() => {
    if (!frozenById.size) return baseTotals;
    const out = { ...baseTotals };
    frozenById.forEach((h, id) => { out[id] = Number(h.snapshot?.total) || 0; });
    return out;
  }, [baseTotals, frozenById]);
  const visiblePipelines = useMemo(() => (access.pipelines ? pipelines.filter((p) => access.pipelines!.has(p.id)) : pipelines), [pipelines, access]);


  /** Only the companies behind the deals this person can see. */
  const myCompanies = useMemo(() => {
    const ids = new Set(mine.map((t) => t.company_id).filter(Boolean));
    return companies.filter((c) => ids.has(c.id!));
  }, [mine, companies]);

  /** Every filter except status: what the KPI cards count (the cards themselves pick the status). */
  const filteredBase = useMemo(() => {
    const n = norm(q.trim());
    return mine.filter((t) => {
      if (fPipeline.length && !fPipeline.includes(t.pipeline_id ?? "")) return false;
      if (fProduct.length && !fProduct.includes(t.product_id ?? "")) return false;
      if (fCompany.length && !fCompany.includes(t.company_id ?? "")) return false;
      if (fPhase.length && !fPhase.includes(phaseName(t))) return false;
      if (fOwner.length && !fOwner.includes(trackOwners[t.id] ?? "")) return false;
      if (fMember.length && !(trackAssignees[t.id] ?? []).some((u) => fMember.includes(u))) return false;
      // Ranges (an open side is skipped; a deal with no value fails an active range)
      if (fRanges.probMin !== null || fRanges.probMax !== null) {
        const pr = shownProbOf(t);
        if (pr == null) return false;
        if (fRanges.probMin !== null && pr < fRanges.probMin) return false;
        if (fRanges.probMax !== null && pr > fRanges.probMax) return false;
      }
      if (fRanges.dateFrom || fRanges.dateTo) {
        const cd = (closeDateOf(t) ?? "").slice(0, 10);
        if (!cd) return false;
        if (fRanges.dateFrom && cd < fRanges.dateFrom) return false;
        if (fRanges.dateTo && cd > fRanges.dateTo) return false;
      }
      if (fRanges.revMin !== null || fRanges.revMax !== null) {
        const rv = potentialTotals[t.id!] || 0;
        if (fRanges.revMin !== null && rv < fRanges.revMin) return false;
        if (fRanges.revMax !== null && rv > fRanges.revMax) return false;
      }
      if (fRanges.createdFrom || fRanges.createdTo) {
        const cr = (t.created_at ?? "").slice(0, 10);
        if (!cr) return false;
        if (fRanges.createdFrom && cr < fRanges.createdFrom) return false;
        if (fRanges.createdTo && cr > fRanges.createdTo) return false;
      }
      // Close date: when it was actually won or lost (open deals have none, so they drop out).
      if (fRanges.closedFrom || fRanges.closedTo) {
        const cl = (t.close_date ?? "").slice(0, 10);
        if (!cl) return false;
        if (fRanges.closedFrom && cl < fRanges.closedFrom) return false;
        if (fRanges.closedTo && cl > fRanges.closedTo) return false;
      }
      if (!n) return true;
      return [trackTitle(t), companyName(t.company_id) ?? "", pipelineName(t.pipeline_id), productName(t.product_id) ?? "", ...t.contactIds.map(contactName)]
        .some((v) => norm(v).includes(n));
    });
  }, [mine, q, fPipeline, fProduct, fCompany, fPhase, fOwner, fMember, fRanges, probView, companies, contacts, pipelines, products, phaseByPipe, potentialTotals, trackAssignees, trackOwners, me]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The KPI cards follow every filter — owner, pipeline, ranges, search… and the status (won / lost / on hold…) too. */
  const metrics = useMemo(() => {
    const base = fStatus.length ? filteredBase.filter((t) => fStatus.includes(t.status)) : filteredBase;
    const val = (list: Tracking[]) => list.reduce((s, t) => s + (potentialTotals[t.id!] || 0), 0);
    const open = base.filter((t) => t.status === "active" || t.status === "paused");
    const won = base.filter((t) => t.status === "won");
    const lost = base.filter((t) => t.status === "lost");
    return {
      total: base.length, totalValue: val(base),
      open: open.length, openValue: val(open),
      won: won.length, wonValue: val(won), lost: lost.length,
    };
  }, [filteredBase, fStatus, potentialTotals]);

  const shown = useMemo(() => {
    let list = filteredBase.filter((t) => !fStatus.length || fStatus.includes(t.status));
    list = [...list].sort((a, b) => {
      if (sort === "az") return trackTitle(a).localeCompare(trackTitle(b));
      if (sort === "za") return trackTitle(b).localeCompare(trackTitle(a));
      if (sort === "stage_lo" || sort === "stage_hi") {
        const sa = trackingPct(phaseByPipe[a.pipeline_id ?? ""] ?? [], a.current_phase_id);
        const sb = trackingPct(phaseByPipe[b.pipeline_id ?? ""] ?? [], b.current_phase_id);
        return (sort === "stage_lo" ? sa - sb : sb - sa) || phaseName(a).localeCompare(phaseName(b));
      }
      if (sort === "prod_az" || sort === "prod_za") {
        const na = productName(a.product_id) ?? "", nb = productName(b.product_id) ?? "";
        if (!na && !nb) return 0;
        if (!na) return 1;
        if (!nb) return -1;
        return sort === "prod_az" ? na.localeCompare(nb) : nb.localeCompare(na);
      }
      if (sort === "oldest") return (a.created_at ?? "").localeCompare(b.created_at ?? "");
      if (sort === "prob_hi" || sort === "prob_lo") {
        const pa = shownProbOf(a), pb = shownProbOf(b);
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return sort === "prob_hi" ? pb - pa : pa - pb;
      }
      // Deals with no close date / no revenue always go to the bottom,
      // whichever direction is chosen.
      if (sort === "close_soon" || sort === "close_late") {
        const da = closeDateOf(a), db = closeDateOf(b);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return sort === "close_soon" ? da.localeCompare(db) : db.localeCompare(da);
      }
      if (sort === "rev_hi" || sort === "rev_lo") {
        const ra = potentialTotals[a.id!] || 0, rb = potentialTotals[b.id!] || 0;
        if (!ra && !rb) return 0;
        if (!ra) return 1;
        if (!rb) return -1;
        return sort === "rev_hi" ? rb - ra : ra - rb;
      }
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredBase, fStatus, sort, probView, phaseByPipe, potentialTotals, me]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clicking the KPI card that is already active clears the filter again.
  // Status cards combine: Active + Won shows both; clicking an active card removes it.
  const toggleStatus = (s: string) => setFStatus((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const anyFilterButStatus = !!(q || fPipeline.length || fProduct.length || fCompany.length || fPhase.length || fOwner.length || fMember.length || activeRangeCount(fRanges));
  const anyFilter = q || fStatus.length || fPipeline.length || fProduct.length || fCompany.length || fPhase.length || fOwner.length || fMember.length || activeRangeCount(fRanges) || sort !== "recent";
  const clearAll = () => { setQ(""); setFStatus([]); setFPipeline([]); setFProduct([]); setFCompany([]); setFPhase([]); setFOwner([]); setFMember([]); setFRanges(EMPTY_RANGES); setSort("recent"); setRangeCol(null); setHeadPop(null); };
  const kanbanPipe = fPipeline.length ? (fPipeline.includes(boardPipe) ? boardPipe : fPipeline[0]) : "";

  /* ---- filter bar: filters scroll sideways instead of wrapping ---- */
  const ftrackRef = useRef<HTMLDivElement>(null);
  const [fEdge, setFEdge] = useState({ l: false, r: false });
  const measureTrack = () => {
    const el = ftrackRef.current;
    if (!el) return;
    const l = el.scrollLeft > 2;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setFEdge((cur) => (cur.l === l && cur.r === r ? cur : { l, r }));
  };
  useLayoutEffect(measureTrack); // labels change width as filters change
  useEffect(() => {
    const el = ftrackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measureTrack);
    ro.observe(el);
    // a vertical mouse wheel over the filters scrolls them sideways
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener("wheel", onWheel); };
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const nudgeTrack = (dir: -1 | 1) => {
    const el = ftrackRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(200, el.clientWidth * 0.7), behavior: "smooth" });
  };

  /* ---- sortable list headers ----
     number/date columns: low→high, high→low, range popover, reset.
     text columns:        A→Z, Z→A, reset. */
  type HeadCol = "deal" | "stage" | "product" | "rev" | "close" | "prob";
  const HEAD_SORT: Record<HeadCol, { asc: string; desc: string; range?: RangeKind }> = {
    deal: { asc: "az", desc: "za" },
    stage: { asc: "stage_lo", desc: "stage_hi" },
    product: { asc: "prod_az", desc: "prod_za" },
    rev: { asc: "rev_lo", desc: "rev_hi", range: "rev" },
    close: { asc: "close_soon", desc: "close_late", range: "close" },
    prob: { asc: "prob_lo", desc: "prob_hi", range: "prob" },
  };
  const headStep = (c: HeadCol): 0 | 1 | 2 | 3 => {
    const d = HEAD_SORT[c];
    if (d.range && (headPop?.kind === d.range || (rangeCol === d.range && rangeActive(fRanges, d.range)))) return 3;
    return sort === d.asc ? 1 : sort === d.desc ? 2 : 0;
  };
  const resetHead = (c: HeadCol) => {
    const d = HEAD_SORT[c];
    setSort("recent");
    if (d.range) { setFRanges((r) => clearRange(r, d.range!)); if (rangeCol === d.range) setRangeCol(null); }
    setHeadPop(null);
  };
  const clickHead = (c: HeadCol, e: ReactMouseEvent<HTMLButtonElement>) => {
    const d = HEAD_SORT[c];
    const step = headStep(c);
    if (step === 0) { setSort(d.asc); setHeadPop(null); return; }
    if (step === 1) { setSort(d.desc); return; }
    if (step === 2 && d.range) { setRangeCol(d.range); setHeadPop({ kind: d.range, rect: e.currentTarget.getBoundingClientRect() }); return; }
    resetHead(c);
  };
  const headBtn = (col: HeadCol, label: string) => {
    const step = headStep(col);
    const hint = HEAD_SORT[col].range
      ? ["Click: low → high", "Click: high → low", "Click: set a range", "Click: back to normal"][step]
      : ["Click: A → Z", "Click: Z → A", "Click: back to normal", ""][step];
    return (
      <button type="button" data-head-range={HEAD_SORT[col].range ? "" : undefined}
        className={`so-th ${step ? "is-on" : ""} ${step === 3 ? "is-range" : ""}`}
        onClick={(e) => clickHead(col, e)} title={hint} aria-sort={step === 1 ? "ascending" : step === 2 ? "descending" : "none"}>
        {label}
        <span className="so-th-ico" aria-hidden="true">
          {step === 1 ? <svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
            : step === 2 ? <svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
            : step === 3 ? <svg viewBox="0 0 24 24"><path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" /></svg>
            : <svg viewBox="0 0 24 24"><path d="M8 9l4-4 4 4M8 15l4 4 4-4" /></svg>}
        </span>
      </button>
    );
  };
  useEffect(() => { console.info("[sales] build: forecast KPIs in top row (v3)"); }, []);

  // Move a tracking to a phase (drag in kanban). Mirrors the detail logic.
  const moveTrackingToPhase = async (trackingId: string, phaseId: string, pipelinePhases: Phase[], skipHandover = false, askClient = true) => {
    const t = trackings.find((x) => x.id === trackingId);
    if (!t || t.current_phase_id === phaseId || frozenById.has(trackingId)) return;
    // Past the last phase a role sees: hand it over first (double confirmation).
    if (!skipHandover) {
      const plan = planHandover({
        roles: salesRoles, pipelineId: t.pipeline_id, phases: pipelinePhases, fromPhaseId: t.current_phase_id, toPhaseId: phaseId,
        owner: trackOwners[t.id] ?? null, team: trackAssignees[t.id] ?? [], dealRoles: t.deal_roles,
      });
      if (plan) { setPendingHandover({ plan, t, phaseId, phases: pipelinePhases }); return; }
    }
    const newIdx = pipelinePhases.findIndex((p) => p.id === phaseId);
    const keepIds = pipelinePhases.slice(0, newIdx + 1).map((p) => p.id);
    const ph = pipelinePhases.find((p) => p.id === phaseId);
    const nextStatus = ph?.sales_outcome === "win" ? "won" : ph?.sales_outcome === "loss" ? "lost" : "active";
    setTrackings((xs) => xs.map((x) => x.id === trackingId ? { ...x, current_phase_id: phaseId, status: nextStatus } : x));
    await setTrackingPhase(trackingId, phaseId);
    await stampPhaseEntry(trackingId, phaseId);
    await clearPhaseEventsAfter(trackingId, keepIds);
    await setTrackingStatus(trackingId, nextStatus);
    // Just won and its client isn't set up yet: ask to create it now.
    if (askClient && nextStatus === "won" && t.status !== "won" && t.company_id) {
      const need = !(await clientExistsForCompany(t.company_id).catch(() => true))
        || ((await loadTrackingProducts(t.id).catch(() => [])).length > 0 && !(await hasClientProductsForTracking(t.id).catch(() => true)));
      if (need) setWonAsk(t);
    }
  };
  /** A deal just dropped on Won whose client isn't set up: "create the client now?". */
  const [wonAsk, setWonAsk] = useState<Tracking | null>(null);
  /** The deal opened to create its client right away (from that question). */
  const [clientFor, setClientFor] = useState<string | null>(null);
  const wonAskModal = wonAsk && (
    <HxPrompt icon="trophy" title="Deal won — create the client?"
      sub={<>Set up <b>{trackTitle(wonAsk)}</b> now with its legal details, contacts and the products signed. Signing dates start on the day it was won. The handoff to management stays for later.</>}
      ghost="Later" primary="Create client"
      onGhost={() => setWonAsk(null)} onClose={() => setWonAsk(null)}
      onPrimary={() => { setClientFor(wonAsk.id); setOpenId(wonAsk.id); setWonAsk(null); }} />
  );

  const confirmHandover = async () => {
    const p = pendingHandover;
    if (!p) return;
    const t = p.t;
    const err = await performHandover(t.id, p.plan, {
      phase_id: t.current_phase_id, status: t.status, total: rawTotals[t.id] ?? 0,
      rep_close_prob: t.rep_close_prob ?? null, mgr_close_prob: t.mgr_close_prob ?? null,
      rep_close_date: t.rep_close_date ?? null, mgr_close_date: t.mgr_close_date ?? null, custom: t.custom ?? {},
    });
    if (err) { window.alert(`Couldn't hand the deal over: ${err}`); return; }
    await moveTrackingToPhase(t.id, p.phaseId, p.phases, true);
    setPendingHandover(null);
    await reload();
  };
  const handoverModal = pendingHandover && (
    <HandoverConfirm
      deal={trackTitle(pendingHandover.t)}
      roleName={pendingHandover.plan.role.name} roleColor={pendingHandover.plan.role.color}
      fromNames={pendingHandover.plan.fromIds.map((id) => employees.find((e) => e.id === id)?.name ?? "—")}
      toName={employees.find((e) => e.id === pendingHandover.plan.toProfile)?.name ?? "—"}
      lastPhase={pendingHandover.plan.lastPhase?.name ?? "—"} toPhase={pendingHandover.plan.toPhase.name}
      onConfirm={confirmHandover} onCancel={() => setPendingHandover(null)} />
  );

  /** The list arrived after the skeleton (first load): rows rise in right away, no entrance delay. */
  const [loadedLate] = useState(() => !snap0);

  // Big lists draw in steps: the first rows now, the next ones as you scroll near the end.
  const [listCap, setListCap] = useState(LIST_STEP);
  useEffect(() => { setListCap(LIST_STEP); }, [shown]);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setListCap((c) => c + LIST_STEP * 2);
    }, { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [listCap, shown.length > listCap, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Multi-select (list and board): act on many deals at once ----
  const bulk = useBulkSelection(view === "list" ? shown.slice(0, listCap).map((t) => t.id) : view === "kanban" ? shown.filter((t) => t.pipeline_id === kanbanPipe).map((t) => t.id) : []);
  const [exportIds, setExportIds] = useState<string[] | null>(null);
  const canAssignDeals = canManage || !!(me && (me.is_superadmin || ["boss", "sales_manager"].includes(me.role)));
  /** Selected deals that can be changed (handed-over ones are a frozen copy). */
  const picked = () => bulk.ids.map((id) => trackings.find((t) => t.id === id)).filter((t): t is Tracking => !!t && !frozenById.has(t.id));
  const skippedNote = (done: number, total: number, why: string) => (done === total ? "" : ` · ${total - done} skipped (${why})`);
  const nameOfEmp = (id: string) => employees.find((e) => e.id === id)?.name ?? "someone";
  const people = employees.filter((e) => !inactive.has(e.id)).map((e) => ({ value: e.id, label: e.name, hint: e.role?.replace(/_/g, " ") }));
  const selPipes = Array.from(new Set(picked().map((t) => t.pipeline_id).filter(Boolean) as string[]));
  const bulkStatus = async (status: string) => {
    let n = 0;
    for (const t of picked()) {
      const phs = phaseByPipe[t.pipeline_id ?? ""] ?? [];
      if (status === "won" || status === "lost") {
        const ph = phs.find((p) => p.sales_outcome === (status === "won" ? "win" : "loss"));
        if (ph) { await moveTrackingToPhase(t.id, ph.id, phs, true, false); n++; continue; }
      } else {
        const cur = phs.find((p) => p.id === t.current_phase_id);
        if (cur?.sales_outcome) {
          const back = phs.filter((p) => !p.sales_outcome).pop();
          if (back) { await setTrackingPhase(t.id, back.id); await stampPhaseEntry(t.id, back.id); }
        }
      }
      await setTrackingStatus(t.id, status); n++;
    }
    await reload();
    return n;
  };
  const ICO = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
  const bulkActions: BulkAction[] = [
    {
      key: "move", label: "Move to pipeline", icon: ICO("M5 12h14M13 6l6 6-6 6"),
      options: visiblePipelines.map((p) => ({ value: p.id, label: p.name, hint: `${(phaseByPipe[p.id] ?? []).length} phases` })),
      run: async (v) => {
        if (!v) return null;
        const ds = picked().filter((t) => t.pipeline_id !== v);
        if (!ds.length) return "They're already in that pipeline.";
        const err = await moveDealsToPipeline(ds.map((t) => t.id), v);
        await reload(); bulk.clear();
        return err ?? { done: `${ds.length} moved to ${pipelineName(v)}` };
      },
    },
    {
      key: "phase", label: "Move to phase", icon: ICO("M4 6h10M4 12h16M4 18h7"),
      options: selPipes.flatMap((pid) => (phaseByPipe[pid] ?? []).map((ph) => ({ value: ph.id, label: ph.name, group: selPipes.length > 1 ? pipelineName(pid) : undefined, hint: ph.sales_outcome === "win" ? "Won" : ph.sales_outcome === "loss" ? "Lost" : undefined }))),
      disabledReason: selPipes.length === 0 ? "These deals have no pipeline yet." : undefined,
      run: async (v) => {
        if (!v) return null;
        const pid = selPipes.find((p) => (phaseByPipe[p] ?? []).some((ph) => ph.id === v))!;
        const phs = phaseByPipe[pid] ?? [];
        const ds = picked().filter((t) => t.pipeline_id === pid);
        let n = 0, handover = 0;
        for (const t of ds) {
          if (t.current_phase_id === v) { n++; continue; }
          // past the last phase a sales role sees: that needs the hand-over, deal by deal
          const plan = planHandover({ roles: salesRoles, pipelineId: t.pipeline_id, phases: phs, fromPhaseId: t.current_phase_id, toPhaseId: v, owner: trackOwners[t.id] ?? null, team: trackAssignees[t.id] ?? [], dealRoles: t.deal_roles });
          if (plan) { handover++; continue; }
          await moveTrackingToPhase(t.id, v, phs, true, false); n++;
        }
        await reload(); bulk.clear();
        const total = picked().length || bulk.ids.length;
        return { done: `${n} moved to ${phs.find((p) => p.id === v)?.name ?? "the phase"}${handover ? ` · ${handover} need a hand-over (open them one by one)` : ""}${skippedNote(n + handover, Math.max(total, ds.length), "other pipeline")}` };
      },
    },
    {
      key: "owner", label: "Main sales rep", icon: ICO("M12 2l3 6.5 7 1-5 5 1.2 7L12 18l-6.2 3.5L7 14.5l-5-5 7-1z"),
      options: [{ value: "__none", label: "Nobody", hint: "Clear the owner" }, ...people],
      disabledReason: canAssignDeals ? undefined : "Only boss and sales managers can change who owns a deal.",
      run: async (v) => {
        if (!v) return null;
        const ds = picked();
        for (const t of ds) await setTrackingOwner(t.id, v === "__none" ? null : v);
        await reload(); bulk.clear();
        return { done: v === "__none" ? `Owner cleared on ${ds.length}` : `${nameOfEmp(v)} now owns ${ds.length}` };
      },
    },
    {
      key: "status", label: "Mark as", icon: ICO("M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"),
      options: [{ value: "active", label: "Active" }, { value: "paused", label: "Paused" }, { value: "won", label: "Won", hint: "Goes to the pipeline's win phase" }, { value: "lost", label: "Lost", hint: "Goes to the pipeline's loss phase" }],
      run: async (v) => { if (!v) return null; const n = await bulkStatus(v); bulk.clear(); return { done: `${n} marked ${v}` }; },
    },
    {
      key: "team-add", label: "Add to the team", more: true, icon: ICO("M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"),
      options: people,
      disabledReason: canAssignDeals ? undefined : "Only boss and sales managers can change the team.",
      run: async (v) => {
        if (!v) return null;
        let n = 0;
        for (const t of picked()) if (!(trackAssignees[t.id] ?? []).includes(v)) { await addTrackingEmployee(t.id, v); n++; }
        await reload(); bulk.clear();
        return { done: `${nameOfEmp(v)} added to ${n} deal${n === 1 ? "" : "s"}` };
      },
    },
    {
      key: "team-remove", label: "Remove from the team", more: true, icon: ICO("M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 11h6"),
      options: people.filter((p) => picked().some((t) => (trackAssignees[t.id] ?? []).includes(p.value))),
      disabledReason: canAssignDeals ? undefined : "Only boss and sales managers can change the team.",
      run: async (v) => {
        if (!v) return null;
        let n = 0;
        for (const t of picked()) if ((trackAssignees[t.id] ?? []).includes(v)) {
          if (trackOwners[t.id] === v) await setTrackingOwner(t.id, null);
          await removeTrackingEmployee(t.id, v); n++;
        }
        await reload(); bulk.clear();
        return { done: `${nameOfEmp(v)} taken off ${n} deal${n === 1 ? "" : "s"}` };
      },
    },
    {
      key: "rep-date", label: "Expected close (sales)", more: true, input: "date", icon: ICO("M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"),
      run: async (v) => { const ds = picked(); for (const t of ds) await setDealCloseDate(t.id, "rep", v || null); await reload(); bulk.clear(); return { done: v ? `Expected close set on ${ds.length}` : `Expected close cleared on ${ds.length}` }; },
    },
    {
      key: "rep-prob", label: "Sales estimate (%)", more: true, input: "percent", icon: ICO("M19 5L5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"),
      run: async (v) => { const ds = picked(); const n = v === "" || v == null ? null : Math.max(0, Math.min(100, Number(v))); for (const t of ds) await setDealCloseProb(t.id, "rep", n); await reload(); bulk.clear(); return { done: n == null ? `Sales estimate cleared on ${ds.length}` : `Sales estimate ${n}% on ${ds.length}` }; },
    },
    ...(canManage ? [
      {
        key: "mgr-date", label: "Expected close (management)", more: true, input: "date" as const, icon: ICO("M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 15l2 2 4-4"),
        run: async (v?: string) => { const ds = picked(); for (const t of ds) await setDealCloseDate(t.id, "mgr", v || null); await reload(); bulk.clear(); return { done: `Management close date on ${ds.length}` }; },
      },
      {
        key: "mgr-prob", label: "Management estimate (%)", more: true, input: "percent" as const, icon: ICO("M19 5L5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"),
        run: async (v?: string) => { const ds = picked(); const n = v === "" || v == null ? null : Math.max(0, Math.min(100, Number(v))); for (const t of ds) await setDealCloseProb(t.id, "mgr", n); await reload(); bulk.clear(); return { done: `Management estimate on ${ds.length}` }; },
      },
    ] : []),
    {
      key: "export", label: "Export these", more: true, icon: ICO("M12 3v12M7 10l5 5 5-5M5 21h14"),
      run: () => { setExportIds(bulk.ids); setExporting(true); return null; },
    },
    {
      key: "delete", label: "Delete", danger: true, more: true, icon: ICO("M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"),
      disabledReason: canManage ? undefined : "Only boss and sales managers can delete deals.",
      run: async () => {
        const ds = picked();
        for (const t of ds) await deleteTracking(t.id);
        setTrackings((xs) => xs.filter((x) => !ds.some((d) => d.id === x.id)));
        bulk.clear(); await reload();
        return { done: `${ds.length} deleted` };
      },
    },
  ];

  if (openId) {
    const t = mine.find((x) => x.id === openId);
    const frozen = t ? frozenById.get(t.id) : undefined;
    if (t && frozen) return <HandedOverView tracking={t} handover={frozen} companies={companies} contacts={contacts} employees={employees} trackingFields={trackingFields} onBack={() => { setOpenId(null); reload(); }} />;
    if (t) return <TrackingDetail tracking={t} companies={companies} contacts={contacts} products={products} employees={employees} trackingFields={trackingFields} salesRoles={salesRoles}
      startWithClient={clientFor === t.id} onBack={() => { setOpenId(null); setClientFor(null); reload(); }} />;
  }


  const ready = booted;

  // ---- list columns ----
  const allCols: ColDef[] = [...BUILTIN_COLS, ...PLAIN_COLS, ...trackingFields.map(fieldCol)];
  const activeCols = cols.map((k) => allCols.find((c) => c.key === k)).filter(Boolean) as ColDef[];
  const colTemplate = ["minmax(240px, 1.5fr)", ...activeCols.map((c) => c.track), "30px"].join(" ");
  const colMinW = 240 + activeCols.reduce((n, c) => n + c.min, 0) + 30 + (activeCols.length + 1) * 28 + 42;
  const plainCell = (k: string, t: Tracking): ReactNode => {
    const pct = (v: number | null | undefined) => (v == null ? "" : `${v}%`);
    switch (k) {
      case "company": return companyName(t.company_id) ?? "";
      case "pipeline": return pipelineName(t.pipeline_id);
      case "phase": return phaseName(t);
      case "status": return t.status === "active" ? "Active" : t.status === "won" ? "Won" : t.status === "lost" ? "Lost" : "Hold";
      case "owner": return trackOwners[t.id] ? employeeById.get(trackOwners[t.id])?.name ?? "" : "";
      case "team": return (trackAssignees[t.id] ?? []).map((id) => employeeById.get(id)?.name).filter(Boolean).join(", ");
      case "productName": return productName(t.product_id) ?? "";
      case "revenue": { const v = potentialTotals[t.id] ?? 0; return v > 0 ? `${v.toLocaleString("de-DE")} €` : ""; }
      case "expected": return fmtDay(closeDateOf(t));
      case "closed": return t.status === "won" || t.status === "lost" ? fmtDay(t.close_date) : "";
      case "started": return fmtDay(t.created_at);
      case "contacts": return t.contactIds.length ? String(t.contactIds.length) : "";
      case "phaseProb": return pct(phaseProbOf(t));
      case "repProb": return pct(t.rep_close_prob);
      case "mgrProb": return pct(t.mgr_close_prob);
    }
    if (k.startsWith("f:")) { const f = trackingFields.find((x) => `f:${x.id}` === k); return f ? fmtField(f, (t.custom ?? {})[f.id]) : ""; }
    return "";
  };

  const exportModal = exporting && (
    <ExportModal
      deals={exportIds ? exportDeals.filter((t) => exportIds.includes(t.id)) : exportDeals}
      contacts={exportContacts}
      companies={exportCompanies}
      employees={employees}
      trackAssignees={trackAssignees}
      potentialTotals={exportLevel === "all" ? rawTotals : potentialTotals}
      pipelineNames={pipelines.map((p) => p.name)}
      productNames={products.map((p) => p.name)}
      phaseNames={allPhaseNames}
      trackingFields={trackingFields}
      helpers={{ pipelineName, productName, phaseName, phaseProbOf, closeDateOf }}
      onClose={() => { setExporting(false); setExportIds(null); }}
    />
  );
  const importModal = importing && (
    <DealImport
      pipelines={pipelines} phaseByPipe={phaseByPipe} products={products}
      people={employees.filter((e) => !inactive.has(e.id))} roles={salesRoles}
      trackings={trackings} meId={me?.id ?? null}
      onDone={() => {
        // new companies and contacts may have been created too
        reload();
        listCompanies().then(setCompanies).catch(() => {});
        listContacts().then(setContacts).catch(() => {});
      }}
      onClose={() => setImporting(false)}
    />
  );

  // ---- Settings › Deals page ----
  if (settings) {
    if ((!me || !rolesReady || !perms || !ready || refreshing) && !coverGaveUp) return <PageLoader label="Loading deal settings…" />;
    const I = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
    const dataItems = [
      ...(canImport ? [{ key: "import", title: "Import deals", hint: "From another CRM's Excel or CSV, with their companies and contacts", icon: I("M12 15V3M7 8l5-5 5 5M5 21h14"), tone: "#3f7fd8", onOpen: () => setImporting(true) }] : []),
      ...(exportLevel !== "none" ? [{ key: "export", title: "Export", hint: exportLevel === "all" ? "Every deal, contact or company to Excel" : "The deals you can see, to Excel", icon: I("M12 3v12M7 10l5 5 5-5M5 21h14"), tone: "#8b5cf6", onOpen: () => setExporting(true) }] : []),
    ];
    const sections: SxSection[] = [
      ...(dataItems.length ? [{ k: "data", label: "Import & export", icon: "upload", tone: "blue" as const, title: "Import & export", hint: "Bring deals in from another CRM, and take them out to Excel", body: <DataTools items={dataItems} /> }] : []),
      ...(canFields ? [{ k: "fields", label: "Deal fields", icon: "sliders", tone: "amber" as const, count: trackingFields.length, title: "Deal fields", hint: "Your own fields on every deal: add, rename, reorder and mark them required",
        body: <TrackingFieldsModal inline canEdit={canFields} onChanged={setTrackingFields} onClose={settings.onBack} /> }] : []),
      ...(canManage ? [{ k: "roles", label: "Sales roles", icon: "users", tone: "violet" as const, count: salesRoles.length, title: "Sales roles", hint: "Who sees which pipelines and deals, and moving deals between people",
        body: (
          <SalesRolesModal
            inline
            canEdit={canManage}
            employees={employees.filter((e) => !inactive.has(e.id))}
            pipelines={pipelines}
            phaseByPipe={phaseByPipe}
            access={{
              rules: accessRules, missing: accessMissing, onRulesChanged: setAccessRules,
              trackings, owners: trackOwners, teams: trackAssignees, events: phaseEvents, handovers,
            }}
            meId={me?.id ?? null}
            transfer={{
              people: employees, inactive, trackings, owners: trackOwners, teams: trackAssignees, totals: rawTotals,
              dealTitle: trackTitle, onDone: () => { reload(); },
            }}
            onChanged={setSalesRoles}
            onClose={settings.onBack}
          />
        ) }] : []),
    ];
    if (!sections.length) sections.push({ k: "none", label: "Deals page", icon: "lock", tone: "slate", title: "Nothing to set up", hint: "Import, export, deal fields and sales roles are for the sales managers",
      body: <p className="st-note">Ask a sales manager or the boss if you need one of these.</p> });
    return (
      <>
        <SettingsShell icon="trend" title="Deals page" sub="Bringing deals in and out, the fields every deal carries, and who sees what"
          onBack={settings.onBack}
          tags={<>
            <span className="sx-tag">{trackings.length.toLocaleString("en-GB")} deal{trackings.length === 1 ? "" : "s"}</span>
            <span className="sx-tag">{trackingFields.length} custom field{trackingFields.length === 1 ? "" : "s"}</span>
            <span className="sx-tag">{salesRoles.length} sales role{salesRoles.length === 1 ? "" : "s"}</span>
          </>}
          sections={sections} />
        {exportModal}
        {importModal}
      </>
    );
  }

  // Who can open Sales at all: anyone with at least one view (Who sees what → Adjust settings).
  // (While the first load runs, the shared page loader covers the page — see PageCover below.)
  if (me && rolesReady && perms && !perms.canOpen) {
    return (
      <div className="sl sl-ov">
        <header className="sl-head">
          <button className="sl-back" onClick={() => navigate("/home")} aria-label="Back">‹</button>
          <h1 className="sl-title">Deals</h1>
        </header>
        <section className="so-sheet">
          <div className="so-empty">
            <span className="so-empty-art"><SoIcon d={SO_ICON.empty} w={1.6} /></span>
            <p>Deals are only available to the sales team.</p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="sl sl-ov fh" ref={fhRef} onPointerMove={(e) => { soSpotlight(e); fhMove(e); }} onPointerLeave={fhLeave}>
      <header className="sl-head">
        <button className="sl-back" onClick={() => navigate("/home")} aria-label="Back">‹</button>
        <h1 className="sl-title">Deals</h1>
        {allowedViews.length > 1 && (
          <div className="so-views" data-view={view} role="tablist" aria-label="View">
            <span className="so-views-pill" aria-hidden="true" style={{ transform: `translateX(${Math.max(0, allowedViews.indexOf(view)) * 94}px)` }} />
            {allowedViews.includes("list") && (
              <button type="button" role="tab" aria-selected={view === "list"} className={view === "list" ? "is-on" : ""} onClick={() => setView("list")}>
                <SoIcon d={SO_ICON.list} w={1.9} />List
              </button>
            )}
            {allowedViews.includes("kanban") && (
              <button type="button" role="tab" aria-selected={view === "kanban"} className={view === "kanban" ? "is-on" : ""} onClick={() => setView("kanban")}>
                <SoIcon d={SO_ICON.board} w={1.9} />Board
              </button>
            )}
            {allowedViews.includes("forecast") && (
              <button type="button" role="tab" aria-selected={view === "forecast"} className={view === "forecast" ? "is-on" : ""} onClick={() => setView("forecast")}>
                <SoIcon d={SO_ICON.forecast} w={1.9} />Forecast
              </button>
            )}
          </div>
        )}
        {(() => { const items: ActionItem[] = [
          ...(createLevel !== "none" ? [{ key: "new", group: "Create", label: "New deal", hint: "Open a deal with a company or contact", icon: AM_ICON.plus, primary: true, tone: "green" as const, shortcut: "N", onSelect: () => setCreating(true) }] : []),
          ...(canReports ? [{ key: "reports", group: "Analyse", label: "Reports", hint: "Lists, boards, forecasts and charts", icon: <SoIcon d={SO_ICON.report} w={1.9} />, tone: "blue" as const, shortcut: "R", onSelect: () => setReporting(true) }] : []),
          ...(exportLevel !== "none" || canImport || canFields || canManage ? [{ key: "settings", group: "Setup", label: "Deals settings", hint: "Import, export, deal fields and sales roles", icon: GEAR, tone: "slate" as const, shortcut: "S", onSelect: () => navigate("/settings", { state: { settingsView: "salespage" } }) }] : []),
        ]; return items.length ? <ActionsMenu items={items} /> : null; })()}
      </header>

      {view === "forecast" ? (
        /* Forecast view: its own headline figures replace the status cards. */
        <div className="so-kpis is-forecast" key="fc-kpis">
          <SoKpi index={0} tone="total" icon={SO_ICON.total} unit="€"
            label={fcKpi?.ranged ? "Pipeline in period" : "Open pipeline"} value={fcKpi?.pipeline ?? 0}
            sub={`${fcKpi?.openCount ?? 0} open ${(fcKpi?.openCount ?? 0) === 1 ? "deal" : "deals"}`}
            on={false} onClick={() => {}} title="Total value of the open deals in view" />
          <SoKpi index={1} tone="won" icon={SO_ICON.rate} unit="€"
            label={fcKpi?.ranged ? "Weighted in period" : "Weighted forecast"} value={fcKpi?.weighted ?? 0}
            sub={fcKpi?.estimated ? `${fcKpi.estimated} without a probability · using pipeline progress` : `value × ${(fcKpi?.probLabel ?? "probability").toLowerCase()}`}
            share={fcKpi && fcKpi.pipeline ? fcKpi.weighted / fcKpi.pipeline : 0}
            on={false} onClick={() => {}} title="Each deal's value × its close probability" />
          <SoKpi index={2} tone="active" icon={SO_ICON.active} unit="€"
            label="Next 90 days" value={fcKpi?.next90 ?? 0}
            sub={`weighted, closing by ${fcKpi?.next90By ?? "—"}`}
            share={fcKpi && fcKpi.weighted ? fcKpi.next90 / fcKpi.weighted : 0}
            on={false} onClick={() => {}} title="Weighted value expected to close in the next 90 days" />
          <SoKpi index={3} tone="lost" icon={SO_ICON.clock}
            label="Overdue" value={fcKpi?.overdueCount ?? 0}
            sub={fcKpi?.overdueCount ? `${Math.round(fcKpi.overdueValue).toLocaleString("de-DE")} € past its expected close date` : "nothing late"}
            share={fcKpi && fcKpi.openCount ? fcKpi.overdueCount / fcKpi.openCount : 0}
            on={false} onClick={() => {}} title="Open deals whose expected close date has passed" />
        </div>
      ) : (
      /* Status cards: each one filters the list, clicking it again clears it. */
      <div className={`so-kpis is-stats ${ready ? "" : "is-loading"}`} key="status-kpis" aria-busy={!ready}>
        <SoStatTotal label={anyFilterButStatus || fStatus.length ? "Deals in this selection" : "Total deals"} loading={!ready}
          total={metrics.total} value={metrics.totalValue} open={metrics.open} openValue={metrics.openValue} won={metrics.won} lost={metrics.lost}
          on={fStatus.length === 0} onClick={() => setFStatus([])} />
        <SoStatWon won={metrics.won} value={metrics.wonValue} total={metrics.total} totalValue={metrics.totalValue} loading={!ready}
          on={fStatus.includes("won")} onClick={() => toggleStatus("won")} />
      </div>
      )}

      <section className="so-sheet">
        {/* Real progress of the first load (requests answered / asked); a quiet sweep while a kept copy refreshes. */}
        <div className={`so-loadbar ${ready && !refreshing ? "is-done" : ""} ${refreshing ? "is-quiet" : ""}`} aria-hidden="true"
          style={{ ["--p" as string]: ready && !refreshing ? 1 : Math.max(0.08, bootStep.done / Math.max(1, bootStep.total)) } as CSSProperties}><i /></div>
        <div className="sl-filters so-fbar">
          <div className="sl-search">
            <span className="sl-search-ico"><SoIcon d={SO_ICON.search} w={2.1} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />
            {q && <button onClick={() => setQ("")} aria-label="Clear search">×</button>}
          </div>
          <div className={`so-fscroll ${fEdge.l ? "has-l" : ""} ${fEdge.r ? "has-r" : ""} ${fEdge.l || fEdge.r ? "is-over" : ""}`}>
          <button type="button" className="so-farrow is-l" onClick={() => nudgeTrack(-1)} aria-label="Scroll filters left" disabled={!fEdge.l}>
            <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>
          </button>
          <div className="so-ftrack" ref={ftrackRef} onScroll={measureTrack}>
          <SalesMultiFilter values={fStatus} onChange={setFStatus} placeholder="Any status" noun="statuses"
            options={[{ value: "active", label: "Active" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }, { value: "paused", label: "Hold" }]} />
          <SalesMultiFilter values={fPipeline} onChange={setFPipeline} placeholder="All pipelines" noun="pipelines"
            options={visiblePipelines.map((p) => ({ value: p.id, label: p.name }))} />
          <SalesMultiFilter values={fProduct} onChange={setFProduct} placeholder="All products" noun="products"
            options={products.map((p) => ({ value: p.id!, label: p.name }))} />
          <SalesMultiFilter single values={[probView]} onChange={(v) => v[0] && setProbView(v[0] as typeof probView)} placeholder="Probability"
            options={[
              { value: "phase", label: "Phase probability" },
              { value: "rep", label: "Sales estimate" },
              { value: "mgr", label: "Management estimate" },
              { value: "avg", label: "Average of all" },
            ]} />
          <SalesMultiFilter values={fPhase} onChange={setFPhase} placeholder="Any stage" noun="stages"
            options={allPhaseNames.map((p) => ({ value: p, label: p }))} />
          <SalesMultiFilter values={fOwner} onChange={setFOwner} placeholder="Any owner" noun="owners"
            options={salesPeople.map((e) => ({ value: e.id, label: e.name }))} />
          <SalesMultiFilter values={fMember} onChange={setFMember} placeholder="Anyone on deal" noun="people"
            options={salesPeople.map((e) => ({ value: e.id, label: e.name }))} />
          <SalesRangeFilter value={fRanges} onChange={setFRanges}
            probLabel={probView === "rep" ? "Sales estimate" : probView === "mgr" ? "Management estimate" : probView === "avg" ? "Average of all" : "Phase probability"} />
          <SalesMultiFilter single values={[valueMode]} onChange={(v) => v[0] && setValueMode(v[0] as "term" | "year")} placeholder="Deal value" searchFrom={99}
            options={[{ value: "term", label: "Value: whole contract" }, { value: "year", label: "Value: this year only" }]} />
          <SalesMultiFilter single values={[sort]} onChange={(v) => v[0] && setSort(v[0])} placeholder="Sort" searchFrom={99}
            options={[{ value: "recent", label: "Most recent" }, { value: "oldest", label: "Oldest" }, { value: "az", label: "A-Z" }, { value: "za", label: "Z-A" }, { value: "stage_lo", label: "Stage: early → late" }, { value: "stage_hi", label: "Stage: late → early" }, { value: "prod_az", label: "Product: A-Z" }, { value: "prod_za", label: "Product: Z-A" }, { value: "prob_hi", label: "Probability: high → low" }, { value: "prob_lo", label: "Probability: low → high" }, { value: "close_soon", label: "Expected close: soonest first" }, { value: "close_late", label: "Expected close: latest first" }, { value: "rev_hi", label: "Revenue: high → low" }, { value: "rev_lo", label: "Revenue: low → high" }]} />
          </div>
          <button type="button" className="so-farrow is-r" onClick={() => nudgeTrack(1)} aria-label="Scroll filters right" disabled={!fEdge.r}>
            <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
          </button>
          </div>
          {anyFilter && <button className="sl-clear" onClick={clearAll}>Clear</button>}
          {view === "list" && <DealColumns all={allCols} cols={cols} onChange={saveCols} />}
          <span className={`so-count ${ready ? "" : "is-loading"}`}>{ready
            ? <><b>{shown.length.toLocaleString("de-DE")}</b> {shown.length === 1 ? "deal" : "deals"}</>
            : <><i className="so-count-dots" aria-hidden="true"><i /><i /><i /></i> deals</>}</span>
        </div>

        {view === "kanban" && fPipeline.length > 1 && (
          <div className="so-boardpick" role="tablist" aria-label="Board pipeline">
            {fPipeline.map((id) => (
              <button key={id} role="tab" aria-selected={kanbanPipe === id} className={kanbanPipe === id ? "is-on" : ""} onClick={() => setBoardPipe(id)}>
                {pipelines.find((p) => p.id === id)?.name ?? "Pipeline"}
              </button>
            ))}
          </div>
        )}
        {view === "forecast" ? (
          <div className="sl-scroll">
            <SalesForecast
              onKpis={setFcKpi}
              trackings={shown}
              potentialTotals={potentialTotals}
              closeDateOf={closeDateOf}
              probOf={shownProbOf}
              fallbackProbOf={(t) => trackingPct(phaseByPipe[t.pipeline_id ?? ""] ?? [], t.current_phase_id)}
              probLabel={probView === "rep" ? "Sales estimate" : probView === "mgr" ? "Management estimate" : probView === "avg" ? "Average estimate" : "Phase probability"}
              trackTitle={trackTitle}
              phaseName={phaseName}
              ownerName={(t) => (trackOwners[t.id] ? employeeById.get(trackOwners[t.id])?.name ?? null : null)}
              productName={(t) => productName(t.product_id)}
              onOpen={(id) => setOpenId(id)}
            />
          </div>
        ) : view === "kanban" ? (
          <KanbanView
            kanbanPipe={kanbanPipe}
            phaseByPipe={phaseByPipe}
            trackings={shown}
            potentialTotals={potentialTotals}
            trackTitle={trackTitle}
            companyName={companyName}
            onOpen={(id) => setOpenId(id)}
            onMove={(id, phaseId, phs) => {
              // dragging one of several ticked cards moves all of them
              if (bulk.has(id) && bulk.ids.length > 1) { const a = bulkActions.find((x) => x.key === "phase"); void a?.run(phaseId); return; }
              void moveTrackingToPhase(id, phaseId, phs);
            }}
            selected={bulk.has} selecting={bulk.active} onToggle={(id, range) => bulk.toggle(id, range)}
            cardDetail={(t) => {
              const owner = trackOwners[t.id] ? employeeById.get(trackOwners[t.id])?.name ?? null : null;
              const close = closeDateOf(t);
              const prob = shownProbOf(t);
              const prod = productName(t.product_id);
              return (
                <>
                  {prod && <span className="so-kx"><b>{prod}</b></span>}
                  {owner && <span className="so-kx"><SoIcon d={SO_ICON.star} fill />{owner}</span>}
                  <span className="so-kx">{close ? `Close ${new Date(close).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" })}` : "No close date"}</span>
                  {prob != null && <span className="so-kx"><b>{prob}%</b> chance</span>}
                  {t.contactIds.length > 0 && <span className="so-kx">{t.contactIds.length} contact{t.contactIds.length === 1 ? "" : "s"}</span>}
                </>
              );
            }}
          />
        ) : shown.length === 0 && ready ? (
          <div className="so-empty">
            <span className="so-empty-art"><SoIcon d={SO_ICON.empty} w={1.6} /></span>
            <p>{trackings.length === 0 ? "No deals yet. Open one to follow a company through your pipeline." : "No deals match those filters."}</p>
            {trackings.length === 0
              ? <button className="sl-new" onClick={() => setCreating(true)}>Open your first deal</button>
              : anyFilter && <button className="sl-clear" onClick={clearAll}>Clear filters</button>}
          </div>
        ) : (
          <div className="sl-scroll so-xscroll">
            <div className="so-cols" style={{ ["--so-cols" as string]: colTemplate, ["--so-minw" as string]: `${colMinW}px` } as CSSProperties}>
            {/* One header for the whole list, so rows don't repeat a label under every figure. */}
            <div className="so-thead">
              <span className="so-th-deal"><BulkCheck on={bulk.allOn} partial={bulk.someOn} onToggle={bulk.toggleAll} label="Select every deal shown" />{headBtn("deal", "Deal")}</span>
              {activeCols.map((c) => (
                <span key={c.key} className={`${c.right ? "is-r" : ""} ${c.key === "value" ? "so-th-stack" : ""}`}>
                  {c.key === "value" ? <>{headBtn("rev", "Potential value")}{headBtn("close", "Expected close")}</>
                    : c.key === "prob" ? headBtn("prob", probView === "phase" ? "Close chance" : probView === "rep" ? "Sales estimate" : probView === "mgr" ? "Mgmt estimate" : "Avg. estimate")
                    : c.sort ? headBtn(c.sort, c.label)
                    : <span className="so-th so-th-plain" title={c.label}>{c.label}</span>}
                </span>
              ))}
              <span />
            </div>
            {headPop && (
              <HeaderRangePopover
                kind={headPop.kind} anchor={headPop.rect} value={fRanges} onChange={setFRanges}
                onClose={() => setHeadPop(null)}
                probLabel={probView === "rep" ? "Sales estimate" : probView === "mgr" ? "Management estimate" : probView === "avg" ? "Average estimate" : "Phase probability"} />
            )}
            <div className={`so-list ${loadedLate ? "is-after-load" : ""}`}>
              {shown.slice(0, listCap).map((t, i) => (
                <TrackingRow
                  key={t.id}
                  index={i}
                  tracking={t}
                  title={trackTitle(t)}
                  company={companyName(t.company_id)}
                  contactCount={t.contactIds.length}
                  pipeline={pipelineName(t.pipeline_id)}
                  phases={phaseByPipe[t.pipeline_id ?? ""] ?? []}
                  product={productName(t.product_id)}
                  revenue={potentialTotals[t.id!] ?? 0}
                  ownerName={trackOwners[t.id] ? (employeeById.get(trackOwners[t.id])?.name ?? null) : null}
                  closeDate={closeDateOf(t)}
                  closeProbOverride={shownProbOf(t)}
                  probLabel={probView === "phase" ? "close" : probView === "rep" ? "sales" : probView === "mgr" ? "mgmt" : "avg"}
                  handedOver={frozenById.has(t.id)}
                  onOpen={() => setOpenId(t.id)}
                  selected={bulk.has(t.id)}
                  selecting={bulk.active}
                  onToggle={(range) => bulk.toggle(t.id, range)}
                  cols={activeCols}
                  cell={(k) => plainCell(k, t)}
                />
              ))}
              {shown.length > listCap && (
                <div ref={moreRef} className="so-more" aria-hidden="true">
                  <i /><i /><i />
                </div>
              )}
            </div>
            </div>
          </div>
        )}
      </section>

      {view !== "forecast" && (
        <BulkBar count={bulk.ids.length} noun={["deal", "deals"]} actions={bulkActions} onClear={bulk.clear}
          onSelectAll={bulk.toggleAll} allOn={bulk.allOn} />
      )}

      {exportModal}
      {reporting && (
        <SalesReport
          deals={mine}
          contacts={contacts}
          companies={companies}
          employees={employees}
          trackAssignees={trackAssignees}
          trackOwners={trackOwners}
          potentialTotals={potentialTotals}
          pipelineNames={pipelines.map((p) => p.name)}
          productNames={products.map((p) => p.name)}
          phaseNames={allPhaseNames}
          me={me?.id ?? null}
          trackingFields={trackingFields}
          helpers={{
            pipelineName, productName, phaseName, phaseProbOf, closeDateOf, trackTitle,
            progressOf: (t) => trackingPct(phaseByPipe[t.pipeline_id ?? ""] ?? [], t.current_phase_id),
          }}
          onOpenDeal={(id) => { setReporting(false); window.setTimeout(() => setOpenId(id), 60); }}
          onClose={() => setReporting(false)}
        />
      )}
      {creating && (
        <NewTracking
          companies={companies} contacts={contacts} pipelines={visiblePipelines} products={products} fields={trackingFields}
          people={employees.filter((e) => !inactive.has(e.id))} me={me ? { id: me.id, lead: createLevel === "anyone" } : null}
          level={createLevel === "none" ? "self" : createLevel}
          roles={salesRoles} phaseByPipe={phaseByPipe}
          onClose={() => setCreating(false)}
          onCreated={async (id) => { setCreating(false); await reload(); setOpenId(id); }}
        />
      )}
      {handoverModal}
      {wonAskModal}
      {importModal}
      <PageCover show={!ready && !coverGaveUp} label="Loading deals…" />
    </div>
  );
}

function TrackingRow({ tracking, title, company, contactCount, pipeline, phases, product, revenue, ownerName, closeDate, closeProbOverride, probLabel, onOpen, index = 0, handedOver = false, selected = false, selecting = false, onToggle, cols = BUILTIN_COLS, cell }: {
  /** The columns after the deal, in order (built-in rich ones or plain values from `cell`). */
  cols?: ColDef[]; cell?: (key: string) => ReactNode;
  tracking: Tracking; title: string; company: string | null; contactCount: number; handedOver?: boolean;
  selected?: boolean; selecting?: boolean; onToggle?: (range: boolean) => void;
  pipeline: string; phases: Phase[]; product: string | null; revenue?: number; closeDate?: string | null;
  ownerName?: string | null; closeProbOverride?: number | null; probLabel?: string; onOpen: () => void; index?: number;
}) {
  const curIdx = phases.findIndex((p) => p.id === tracking.current_phase_id);
  // Same adaptive formula as the detail view: first phase 0%, win phase 100%.
  const pct = trackingPct(phases, tracking.current_phase_id);
  const stage = curIdx >= 0 ? phases[curIdx]?.name ?? "-" : "Not started";
  // The overview chooses which probability to show (phase / sales / mgmt / avg);
  // it's passed in. Fall back to the phase value if not provided.
  const curPhase = curIdx >= 0 ? phases[curIdx] : undefined;
  const phaseProb: number | null =
    tracking.status === "won" ? 100 :
    tracking.status === "lost" ? 0 :
    curPhase?.sales_outcome === "win" ? 100 :
    curPhase?.sales_outcome === "loss" ? 0 :
    curPhase?.close_probability != null ? curPhase.close_probability : null;
  const closeProb: number | null = closeProbOverride !== undefined ? closeProbOverride : phaseProb;
  const probTone = closeProb == null ? "none" : closeProb >= 70 ? "hi" : closeProb >= 40 ? "mid" : "lo";
  const started = tracking.created_at ? new Date(tracking.created_at).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" }) : "-";
  const cp = Math.max(0, Math.min(100, closeProb ?? 0));
  const teamCount = Object.keys(tracking.deal_roles ?? {}).length;

  return (
    <button
      className={`so-row is-${tracking.status} prob-${probTone} ${selected ? "is-sel" : ""} ${selecting ? "is-selecting" : ""}`}
      data-spot=""
      style={soVars({ "--i": Math.min(index, 14), "--h": soHue(title), "--cp": `${cp}%` })}
      // While picking, a click picks; shift-click picks a run of rows.
      onClick={(e) => { if (onToggle && (selecting || e.shiftKey || e.metaKey || e.ctrlKey)) onToggle(e.shiftKey); else onOpen(); }}
    >
      {/* deal */}
      <span className="so-who">
        <span className="so-av-wrap">
          <span className="so-av">{title.slice(0, 1).toUpperCase()}</span>
          {onToggle && <BulkCheck on={selected} onToggle={(e) => onToggle(e.shiftKey)} label={`Select ${title}`} />}
        </span>
        <span className="so-who-t">
          <span className="so-name">
            <b>{title}{handedOver && <span className="so-handed" title="You handed this deal over — you see it as it was then">Handed over</span>}</b>
            {/* Active is the default, so only the exceptions get a pill. */}
            {tracking.status !== "active" && <span className={`so-status is-${tracking.status}`}>{statusText(tracking.status)}</span>}
          </span>
          <span className="so-meta">
            <span className={`so-co ${company ? "" : "is-none"}`} title={company ? `Company: ${company}` : "No company"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M8 8h3M8 12h3M8 16h3M3 21h18" /></svg>
              {company ?? "No company"}
            </span>
          </span>
        </span>
      </span>

      {cols.map((c) => {
        switch (c.key) {
          case "stage": return (
      <span key="stage" className="so-stage" title={`${pct}% through the pipeline`}>
        <span className="so-stage-top">
          <b>{stage}</b>
          <em>{pct}%</em>
        </span>
        <span className="so-track" aria-hidden="true">
          {(phases.length > 0 ? phases : [{ id: "none" } as Phase]).map((ph, i) => (
            <i key={ph.id} className={i < curIdx ? "is-done" : i === curIdx ? "is-cur" : ""} />
          ))}
        </span>
      </span>
          );
          case "product": return (
      <span key="product" className="so-tags">
        {product ? <span className="so-tag">{product}</span> : <span className="so-tag is-empty">No product</span>}
      </span>
          );
          case "value": return (
      <span key="value" className="so-value">
        <b className={revenue && revenue > 0 ? "" : "is-none"}>{revenue && revenue > 0 ? `${revenue.toLocaleString("de-DE")} €` : "No value yet"}</b>
        {(tracking.status === "won" || tracking.status === "lost") && tracking.close_date ? (
          <small className={`is-closed is-${tracking.status}`} title="Close date">
            {`${tracking.status === "won" ? "Won" : "Lost"} ${new Date(tracking.close_date).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" })}`}
          </small>
        ) : (
          <small className={closeDate ? "" : "is-none"} title="Expected close date">
            {closeDate ? `Expected ${new Date(closeDate).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" })}` : "No expected close date"}
          </small>
        )}
      </span>
          );
          case "prob": return (
      <span key="prob" className="so-chance" title={probLabel ? `Close probability (${probLabel})` : undefined}>
        {closeProb == null ? (
          <b className="is-none">—</b>
        ) : (
          <b>{closeProb}<i>%</i></b>
        )}
      </span>
          );
          default: {
            const v = cell?.(c.key);
            return <span key={c.key} className={`so-cell ${c.right ? "is-r" : ""} ${v ? "" : "is-none"}`} title={typeof v === "string" ? v : undefined}>{v || "—"}</span>;
          }
        }
      })}

      <span className="so-go" aria-hidden="true"><SoIcon d={SO_ICON.arrow} w={2.2} /></span>

      {/* More about the deal: unfolds on hover / keyboard focus, so the list stays calm. */}
      <span className="so-x" aria-hidden="true">
        <span className="so-x-in">
          <span className="so-xi"><i>Owner</i><b className={ownerName ? "" : "is-none"}>{ownerName ? <><SoIcon d={SO_ICON.star} fill />{ownerName}</> : "No owner"}</b></span>
          <span className="so-xi"><i>Pipeline</i><b>{pipeline || "—"}</b></span>
          <span className="so-xi"><i>Step</i><b>{curIdx >= 0 && phases.length > 0 ? `${curIdx + 1} of ${phases.length}` : "Not started"}</b></span>
          <span className="so-xi"><i>Product</i><b className={product ? "" : "is-none"}>{product ?? "None yet"}</b></span>
          <span className="so-xi"><i>People</i><b>{contactCount} contact{contactCount === 1 ? "" : "s"}{teamCount ? ` · ${teamCount} on the team` : ""}</b></span>
          {(tracking.rep_close_prob != null || tracking.mgr_close_prob != null) && (
            <span className="so-xi"><i>Estimates</i><b>{tracking.rep_close_prob != null ? `Sales ${tracking.rep_close_prob}%` : "Sales —"} · {tracking.mgr_close_prob != null ? `Mgmt ${tracking.mgr_close_prob}%` : "Mgmt —"}</b></span>
          )}
          <span className="so-xi"><i>Started</i><b>{started}</b></span>
          {closeProb != null && (
            <span className="so-xi is-bar"><i>Close chance</i><span className="so-chance-bar" aria-hidden="true"><i /></span></span>
          )}
        </span>
      </span>
    </button>
  );
}

// ============================ Kanban view ============================
function KanbanView({ kanbanPipe, phaseByPipe, trackings, potentialTotals, trackTitle, companyName, onOpen, onMove, selected, selecting = false, onToggle, cardDetail }: {
  kanbanPipe: string;
  /** What a card unfolds on hover (product, owner, close date, chance…). */
  cardDetail?: (t: Tracking) => ReactNode;
  /** Multi-select: ticked cards, and a click picks instead of opening while any is ticked. */
  selected?: (id: string) => boolean; selecting?: boolean; onToggle?: (id: string, range: boolean) => void;
  phaseByPipe: Record<string, Phase[]>;
  trackings: Tracking[];
  potentialTotals: Record<string, number>;
  trackTitle: (t: Tracking) => string;
  companyName: (id: string | null) => string | null;
  onOpen: (id: string) => void;
  onMove: (trackingId: string, phaseId: string, phases: Phase[]) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overPhase, setOverPhase] = useState<string | null>(null);
  const phases = phaseByPipe[kanbanPipe] ?? [];
  // Long columns draw their first cards; the rest come in on demand (a board of thousands stays quick).
  const COL_STEP = 40;
  const [caps, setCaps] = useState<Record<string, number>>({});
  useEffect(() => { setCaps({}); }, [trackings, kanbanPipe]);

  // `trackings` is the parent's already-filtered list (its `mine`, narrowed by
  // the search and filter bar), so the board must read from the prop rather
  // than a variable that only exists in the parent scope.
  const boardTrackings = useMemo(
    () => trackings.filter((t) => t.pipeline_id === kanbanPipe),
    [trackings, kanbanPipe],
  );
  const byPhase = useMemo(() => {
    const map: Record<string, Tracking[]> = {};
    phases.forEach((p) => { map[p.id] = []; });
    boardTrackings.forEach((t) => { if (t.current_phase_id && map[t.current_phase_id]) map[t.current_phase_id].push(t); });
    return map;
  }, [phases, boardTrackings]);
  // Total potential revenue of the deals in each phase.
  const revByPhase = useMemo(() => {
    const map: Record<string, number> = {};
    phases.forEach((p) => { map[p.id] = (byPhase[p.id] ?? []).reduce((sum, t) => sum + (potentialTotals[t.id!] ?? 0), 0); });
    return map;
  }, [phases, byPhase, potentialTotals]);
  const fmtRev = (n: number) => n >= 1000 ? `${(n / 1000).toLocaleString("de-DE", { maximumFractionDigits: n >= 10000 ? 0 : 1 })}k €` : `${Math.round(n)} €`;

  const drop = (phaseId: string) => {
    if (dragId) onMove(dragId, phaseId, phases);
    setDragId(null); setOverPhase(null);
  };

  if (!kanbanPipe) {
    return (
      <div className="so-empty">
        <span className="so-empty-art"><SoIcon d={SO_ICON.board} w={1.6} /></span>
        <p>Pick a pipeline in the filter above to see its board.</p>
      </div>
    );
  }
  if (phases.length === 0) {
    return (
      <div className="so-empty">
        <span className="so-empty-art"><SoIcon d={SO_ICON.board} w={1.6} /></span>
        <p>This pipeline has no visible phases.</p>
      </div>
    );
  }

  return (
    <div className="sl-kanban">
      <div className="sl-kcols">
        {phases.map((p, pi) => {
          const cards = byPhase[p.id] ?? [];
          return (
            <div
              key={p.id}
              className={`so-kcol ${overPhase === p.id ? "is-over" : ""} ${p.sales_outcome ? `is-${p.sales_outcome}` : ""}`}
              style={soVars({ "--i": Math.min(pi, 10) })}
              onDragOver={(e) => { e.preventDefault(); setOverPhase(p.id); }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setOverPhase(null); }}
              onDrop={() => drop(p.id)}
            >
              <div className="so-kcol-h">
                <span className="so-kcol-name">
                  {p.sales_outcome === "win" && <span className="so-kcol-mark" aria-hidden="true"><SoIcon d={SO_ICON.star} fill /></span>}
                  {p.sales_outcome === "loss" && <span className="so-kcol-mark" aria-hidden="true"><SoIcon d="M6 6l12 12M18 6L6 18" w={2.6} /></span>}
                  <b>{p.name}</b>
                  <span className="so-kcol-count">{cards.length.toLocaleString("de-DE")}</span>
                </span>
                <span className="so-kcol-rev">
                  {(revByPhase[p.id] ?? 0) > 0 ? <>{fmtRev(revByPhase[p.id])} <small>potential</small></> : <small>No potential revenue</small>}
                </span>
              </div>
              <div className="so-kcol-body">
                {cards.length === 0 ? (
                  <div className="so-kcol-empty">Drop a deal here</div>
                ) : cards.slice(0, caps[p.id] ?? COL_STEP).map((t, ci) => {
                  const title = trackTitle(t);
                  const rev = potentialTotals[t.id!] ?? 0;
                  return (
                    <div
                      key={t.id}
                      className={`so-kcard is-${t.status} ${dragId === t.id ? "is-dragging" : ""} ${selected?.(t.id) ? "is-sel" : ""} ${selecting ? "is-selecting" : ""}`}
                      data-spot=""
                      style={soVars({ "--h": soHue(title), "--i": Math.min(ci, 8) + pi })}
                      draggable
                      onDragStart={() => setDragId(t.id)}
                      onDragEnd={() => { setDragId(null); setOverPhase(null); }}
                      onClick={(e) => { if (onToggle && (selecting || e.shiftKey || e.metaKey || e.ctrlKey)) onToggle(t.id, e.shiftKey); else onOpen(t.id); }}
                    >
                      <span className="so-av-wrap">
                        <span className="so-av">{title.slice(0, 1).toUpperCase()}</span>
                        {onToggle && <BulkCheck on={!!selected?.(t.id)} onToggle={(e) => onToggle(t.id, e.shiftKey)} label={`Select ${title}`} />}
                      </span>
                      <span className="so-kcard-t">
                        <b>{title}</b>
                        <small>{companyName(t.company_id) ? (t.deal_name?.trim() ? companyName(t.company_id) : "Company") : "Contact"}</small>
                      </span>
                      <span className="so-kcard-side">
                        <span className={`so-status is-${t.status}`}>{statusText(t.status)}</span>
                        {rev > 0 && <span className="so-kcard-rev">{fmtRev(rev)}</span>}
                      </span>
                      {cardDetail && <span className="so-x" aria-hidden="true"><span className="so-x-in">{cardDetail(t)}</span></span>}
                    </div>
                  );
                })}
                {cards.length > (caps[p.id] ?? COL_STEP) && (
                  <button type="button" className="so-kmore"
                    onClick={() => setCaps((c) => ({ ...c, [p.id]: (c[p.id] ?? COL_STEP) + COL_STEP * 2 }))}>
                    Show more <small>{(cards.length - (caps[p.id] ?? COL_STEP)).toLocaleString("de-DE")} left</small>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

