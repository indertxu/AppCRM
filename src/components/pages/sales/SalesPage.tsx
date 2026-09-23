/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import Select from "../../framework/Select";
import { supabase } from "../../api/supabase";
import { listCompanies, listContacts, type Company, type Contact } from "../companies/companiesApi";
import { listPipelines, loadPipeline, type Pipeline, type Phase } from "../settings/pipelineApi";
import { loadProducts, type Product } from "../settings/catalogApi";
import { listTrackings, loadAllTrackingEmployees, loadAllTrackingOwners, setTrackingEmployees, createTracking, setTrackingPhase, setTrackingStatus, stampPhaseEntry, clearPhaseEventsAfter, trackingPct, loadPotentialTotals, type Tracking } from "./salesApi";
import TrackingDetail from "./TrackingDetail";
import ExportModal from "./ExportModal";
import "../companies/CompaniesPage.css";
import { myProfile, isSalesLead, canOpenSales } from "../companies/companiesApi";
import "./SalesPage.css";

export interface Employee { id: string; name: string }

const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/* ===================================================================
   Overview building blocks (presentation only). Same visual language as
   Management's Team tab and the consultant modal.
   =================================================================== */
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
  return <>{Math.round(useSoCount(value)).toLocaleString()}</>;
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
  export: "M12 4v11M7 10l5 5 5-5M5 20h14",
  arrow: "M5 12h14M13 6l6 6-6 6",
  star: "M12 2l3 6.5 7 .6-5.3 4.6 1.6 6.9L12 17.8 5.7 20.6l1.6-6.9L2 9.1l7-.6z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  empty: "M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4",
};
function SoIcon({ d, w = 2, fill = false }: { d: string; w?: number; fill?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const SO_ARC = "M16 70 A54 54 0 0 1 124 70";

/** A status card in the dark band. Clicking it filters the list, as before. */
function SoKpi({
  index, tone, icon, label, value, sub, share, dial, on, onClick, title,
}: {
  index: number; tone: string; icon: string; label: string; value: number; sub: string;
  share?: number | null; dial?: number | null; on: boolean; onClick: () => void; title?: string;
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
          <b className="so-kpi-val"><SoCount value={value} />{dial != null && <em>%</em>}</b>
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

export default function SalesPage() {
  const navigate = useNavigate();
  const [trackings, setTrackings] = useState<Tracking[]>([]);
  const [potentialTotals, setPotentialTotals] = useState<Record<string, number>>({});
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [trackAssignees, setTrackAssignees] = useState<Record<string, string[]>>({});
  const [trackOwners, setTrackOwners] = useState<Record<string, string>>({});
  const [me, setMe] = useState<{ id: string; role: string; is_superadmin: boolean } | null>(null);
  const [phaseByPipe, setPhaseByPipe] = useState<Record<string, Phase[]>>({});
  const [openId, setOpenId] = useState<string | null>(null);

  /** Arriving from the sales calendar with ?tracking=… opens that deal. */
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("tracking");
    if (id) setOpenId(id);
  }, []);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [view, setView] = useState<"list" | "kanban">("list");
  // Board view needs a pipeline; if none is picked when switching to it, pick
  // the first sales pipeline (or the first available) so the board isn't empty.
  useEffect(() => {
    if (view === "kanban" && !fPipeline && pipelines.length > 0) {
      const firstSales = pipelines.find((p) => (p as any).is_sales) ?? pipelines[0];
      setFPipeline(firstSales.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, pipelines]);

  const [q, setQ] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fPipeline, setFPipeline] = useState("");
  const [fProduct, setFProduct] = useState("");
  const [fCompany, setFCompany] = useState("");
  const [fPhase, setFPhase] = useState("");
  const [fOwner, setFOwner] = useState("");
  const [fMember, setFMember] = useState("");
  const [sort, setSort] = useState("recent");
  const [probView, setProbView] = useState<"phase" | "rep" | "mgr" | "avg">("phase");

  const reload = async () => {
    setTrackings(await listTrackings().catch(() => []));
    loadPotentialTotals().then(setPotentialTotals).catch(() => {});
    setTrackAssignees(await loadAllTrackingEmployees().catch(() => ({})));
    setTrackOwners(await loadAllTrackingOwners().catch(() => ({})));
  };
  useEffect(() => { myProfile().then(setMe).catch(() => {}); }, []);

  useEffect(() => {
    reload();
    listCompanies().then(setCompanies).catch(() => {});
    listContacts().then(setContacts).catch(() => {});
    listPipelines().then((ps) => setPipelines(ps.filter((p) => p.is_sales))).catch(() => {});
    loadProducts().then(setProducts).catch(() => {});
    supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(({ data }: any) => {
      setEmployees((data?.users ?? []).map((u: any) => ({ id: u.id, name: u.full_name || u.email || "—" })));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    pipelines.forEach((p) => {
      if (!phaseByPipe[p.id]) {
        loadPipeline(p.id).then(({ phases }) => setPhaseByPipe((prev) => ({ ...prev, [p.id]: phases.filter((ph) => ph.sales_visible !== false) }))).catch(() => {});
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelines]);

  const companyName = (id: string | null) => companies.find((c) => c.id === id)?.name ?? null;
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
  const trackTitle = (t: Tracking) => companyName(t.company_id) || (t.contactIds[0] ? contactName(t.contactIds[0]) : "Untitled");

  // People offered in the owner / "on deal" filters: sales-team roles, plus
  // anyone already set as an owner or member (so nobody disappears from the
  // filter just because their role changed).
  const salesPeople = useMemo(() => {
    const SALES = new Set(["sales", "sales_manager", "boss"]);
    const involved = new Set<string>(Object.values(trackOwners));
    Object.values(trackAssignees).forEach((ids) => ids.forEach((id) => involved.add(id)));
    return employees
      .filter((e) => SALES.has(e.role) || involved.has(e.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [employees, trackOwners, trackAssignees]);

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
  const mine = useMemo(() => {
    // Until we know who's looking, show nothing (not everything).
    if (!me) return [];
    if (isSalesLead(me)) return trackings;
    return trackings.filter((t) => (trackAssignees[t.id] ?? []).includes(me.id));
  }, [trackings, trackAssignees, me]);

  const metrics = useMemo(() => {
    const active = mine.filter((t) => t.status === "active").length;
    const won = mine.filter((t) => t.status === "won").length;
    const lost = mine.filter((t) => t.status === "lost").length;
    const rate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0;
    return { total: mine.length, active, won, lost, rate };
  }, [mine]);

  /** Only the companies behind the deals this person can see. */
  const myCompanies = useMemo(() => {
    const ids = new Set(mine.map((t) => t.company_id).filter(Boolean));
    return companies.filter((c) => ids.has(c.id!));
  }, [mine, companies]);

  const shown = useMemo(() => {
    const n = norm(q.trim());
    let list = mine.filter((t) => {
      if (fStatus === "closed") { if (t.status !== "won" && t.status !== "lost") return false; }
      else if (fStatus && t.status !== fStatus) return false;
      if (fPipeline && t.pipeline_id !== fPipeline) return false;
      if (fProduct && t.product_id !== fProduct) return false;
      if (fCompany && t.company_id !== fCompany) return false;
      if (fPhase && phaseName(t) !== fPhase) return false;
      if (fOwner && trackOwners[t.id] !== fOwner) return false;
      if (fMember && !(trackAssignees[t.id] ?? []).includes(fMember)) return false;
      if (!n) return true;
      return [trackTitle(t), pipelineName(t.pipeline_id), productName(t.product_id) ?? "", ...t.contactIds.map(contactName)]
        .some((v) => norm(v).includes(n));
    });
    list = [...list].sort((a, b) => {
      if (sort === "az") return trackTitle(a).localeCompare(trackTitle(b));
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
  }, [mine, q, fStatus, fPipeline, fProduct, fCompany, fPhase, fOwner, fMember, sort, probView, companies, contacts, pipelines, products, phaseByPipe, potentialTotals, trackAssignees, trackOwners, me]);

  // Clicking the KPI card that is already active clears the filter again.
  const toggleStatus = (s: string) => setFStatus((cur) => (cur === s ? "" : s));

  const anyFilter = q || fStatus || fPipeline || fProduct || fCompany || fPhase || fOwner || fMember || sort !== "recent";
  const clearAll = () => { setQ(""); setFStatus(""); setFPipeline(""); setFProduct(""); setFCompany(""); setFPhase(""); setFOwner(""); setFMember(""); setSort("recent"); };

  // Move a tracking to a phase (drag in kanban). Mirrors the detail logic.
  const moveTrackingToPhase = async (trackingId: string, phaseId: string, pipelinePhases: Phase[]) => {
    const t = trackings.find((x) => x.id === trackingId);
    if (!t || t.current_phase_id === phaseId) return;
    const newIdx = pipelinePhases.findIndex((p) => p.id === phaseId);
    const keepIds = pipelinePhases.slice(0, newIdx + 1).map((p) => p.id);
    const ph = pipelinePhases.find((p) => p.id === phaseId);
    const nextStatus = ph?.sales_outcome === "win" ? "won" : ph?.sales_outcome === "loss" ? "lost" : "active";
    setTrackings((xs) => xs.map((x) => x.id === trackingId ? { ...x, current_phase_id: phaseId, status: nextStatus } : x));
    await setTrackingPhase(trackingId, phaseId);
    await stampPhaseEntry(trackingId, phaseId);
    await clearPhaseEventsAfter(trackingId, keepIds);
    await setTrackingStatus(trackingId, nextStatus);
  };

  if (openId) {
    const t = trackings.find((x) => x.id === openId);
    if (t) return <TrackingDetail tracking={t} companies={companies} contacts={contacts} products={products} employees={employees} onBack={() => { setOpenId(null); reload(); }} />;
  }


  if (me && !canOpenSales(me)) {
    return (
      <div className="sl sl-ov">
        <header className="sl-head">
          <button className="sl-back" onClick={() => navigate("/home")} aria-label="Back">‹</button>
          <h1 className="sl-title">Sales</h1>
        </header>
        <section className="so-sheet">
          <div className="so-empty">
            <span className="so-empty-art"><SoIcon d={SO_ICON.empty} w={1.6} /></span>
            <p>This page is only available to the sales team.</p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="sl sl-ov" onPointerMove={soSpotlight}>
      <header className="sl-head">
        <button className="sl-back" onClick={() => navigate("/home")} aria-label="Back">‹</button>
        <h1 className="sl-title">Sales Tracking</h1>
        <div className="so-views" data-view={view} role="tablist" aria-label="View">
          <span className="so-views-pill" aria-hidden="true" />
          <button type="button" role="tab" aria-selected={view === "list"} className={view === "list" ? "is-on" : ""} onClick={() => setView("list")}>
            <SoIcon d={SO_ICON.list} w={1.9} />List
          </button>
          <button type="button" role="tab" aria-selected={view === "kanban"} className={view === "kanban" ? "is-on" : ""} onClick={() => setView("kanban")}>
            <SoIcon d={SO_ICON.board} w={1.9} />Board
          </button>
        </div>
        <button className="sl-export-btn" disabled={!me} onClick={() => setExporting(true)}>
          <SoIcon d={SO_ICON.export} w={1.9} />
          Export
        </button>
        <button className="sl-new" onClick={() => setCreating(true)}>+ New tracking</button>
      </header>

      {/* Status cards: each one filters the list, clicking it again clears it. */}
      <div className="so-kpis">
        <SoKpi index={0} tone="total" icon={SO_ICON.total} label="Total deals" value={metrics.total}
          sub={`${metrics.active} still open`} on={fStatus === ""} onClick={() => setFStatus("")} title="Show every deal" />
        <SoKpi index={1} tone="active" icon={SO_ICON.active} label="Active" value={metrics.active}
          sub={metrics.total ? `${Math.round((metrics.active / metrics.total) * 100)}% of all deals` : "No deals yet"}
          share={metrics.total ? metrics.active / metrics.total : 0}
          on={fStatus === "active"} onClick={() => toggleStatus("active")} />
        <SoKpi index={2} tone="won" icon={SO_ICON.won} label="Won" value={metrics.won}
          sub={metrics.total ? `${Math.round((metrics.won / metrics.total) * 100)}% of all deals` : "No deals yet"}
          share={metrics.total ? metrics.won / metrics.total : 0}
          on={fStatus === "won"} onClick={() => toggleStatus("won")} />
        <SoKpi index={3} tone="lost" icon={SO_ICON.lost} label="Lost" value={metrics.lost}
          sub={metrics.total ? `${Math.round((metrics.lost / metrics.total) * 100)}% of all deals` : "No deals yet"}
          share={metrics.total ? metrics.lost / metrics.total : 0}
          on={fStatus === "lost"} onClick={() => toggleStatus("lost")} />
        <SoKpi index={4} tone="rate" icon={SO_ICON.rate} label="Win rate" value={metrics.rate} dial={metrics.rate}
          sub={metrics.won + metrics.lost > 0 ? `${metrics.won} won of ${metrics.won + metrics.lost} closed` : "Nothing closed yet"}
          on={fStatus === "closed"} onClick={() => toggleStatus("closed")} title="Show closed deals (won and lost)" />
      </div>

      <section className="so-sheet">
        <div className="sl-filters">
          <div className="sl-search">
            <span className="sl-search-ico"><SoIcon d={SO_ICON.search} w={2.1} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />
            {q && <button onClick={() => setQ("")} aria-label="Clear search">×</button>}
          </div>
          <Select value={fStatus} onChange={setFStatus} placeholder="Any status"
            options={[{ value: "", label: "Any status" }, { value: "active", label: "Active" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }, { value: "paused", label: "Paused" }, { value: "closed", label: "Closed (won + lost)" }]} />
          <Select value={fPipeline} onChange={setFPipeline} placeholder="All pipelines"
            options={[{ value: "", label: "All pipelines" }, ...pipelines.map((p) => ({ value: p.id, label: p.name }))]} />
          <Select value={fProduct} onChange={setFProduct} placeholder="All products"
            options={[{ value: "", label: "All products" }, ...products.map((p) => ({ value: p.id!, label: p.name }))]} />
          <Select value={probView} onChange={(v) => setProbView(v as typeof probView)} placeholder="Probability"
            options={[
              { value: "phase", label: "Phase probability" },
              { value: "rep", label: "Sales estimate" },
              { value: "mgr", label: "Management estimate" },
              { value: "avg", label: "Average of all" },
            ]} />
          <Select value={fPhase} onChange={setFPhase} placeholder="Any stage"
            options={[{ value: "", label: "Any stage" }, ...allPhaseNames.map((p) => ({ value: p, label: p }))]} />
          <Select value={fOwner} onChange={setFOwner} placeholder="Any owner"
            options={[{ value: "", label: "Any owner" }, ...salesPeople.map((e) => ({ value: e.id, label: e.name }))]} />
          <Select value={fMember} onChange={setFMember} placeholder="Anyone on deal"
            options={[{ value: "", label: "Anyone on deal" }, ...salesPeople.map((e) => ({ value: e.id, label: e.name }))]} />
          <Select value={sort} onChange={setSort} placeholder="Sort"
            options={[{ value: "recent", label: "Most recent" }, { value: "oldest", label: "Oldest" }, { value: "az", label: "A-Z" }, { value: "prob_hi", label: "Probability: high → low" }, { value: "prob_lo", label: "Probability: low → high" }, { value: "close_soon", label: "Close date: soonest first" }, { value: "close_late", label: "Close date: latest first" }, { value: "rev_hi", label: "Revenue: high → low" }, { value: "rev_lo", label: "Revenue: low → high" }]} />
          {anyFilter && <button className="sl-clear" onClick={clearAll}>Clear</button>}
          <span className="so-count"><b>{shown.length}</b> {shown.length === 1 ? "deal" : "deals"}</span>
        </div>

        {view === "kanban" ? (
          <KanbanView
            kanbanPipe={fPipeline}
            phaseByPipe={phaseByPipe}
            trackings={shown}
            potentialTotals={potentialTotals}
            trackTitle={trackTitle}
            companyName={companyName}
            onOpen={(id) => setOpenId(id)}
            onMove={moveTrackingToPhase}
          />
        ) : shown.length === 0 ? (
          <div className="so-empty">
            <span className="so-empty-art"><SoIcon d={SO_ICON.empty} w={1.6} /></span>
            <p>{trackings.length === 0 ? "No trackings yet. Start one to follow a client through your pipeline." : "No trackings match those filters."}</p>
            {trackings.length === 0
              ? <button className="sl-new" onClick={() => setCreating(true)}>Start your first tracking</button>
              : anyFilter && <button className="sl-clear" onClick={clearAll}>Clear filters</button>}
          </div>
        ) : (
          <div className="sl-scroll">
            {/* One header for the whole list, so rows don't repeat a label under every figure. */}
            <div className="so-thead" aria-hidden="true">
              <span>Deal</span>
              <span>Stage</span>
              <span>Product and owner</span>
              <span className="is-r">Potential and close</span>
              <span className="is-r">{probView === "phase" ? "Close chance" : probView === "rep" ? "Sales estimate" : probView === "mgr" ? "Mgmt estimate" : "Avg. estimate"}</span>
              <span />
            </div>
            <div className="so-list">
              {shown.map((t, i) => (
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
                  ownerName={trackOwners[t.id] ? (employees.find((e) => e.id === trackOwners[t.id])?.name ?? null) : null}
                  closeDate={closeDateOf(t)}
                  closeProbOverride={shownProbOf(t)}
                  probLabel={probView === "phase" ? "close" : probView === "rep" ? "sales" : probView === "mgr" ? "mgmt" : "avg"}
                  onOpen={() => setOpenId(t.id)}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {exporting && (
        <ExportModal
          deals={mine}
          contacts={contacts}
          companies={companies}
          employees={employees}
          trackAssignees={trackAssignees}
          potentialTotals={potentialTotals}
          pipelineNames={pipelines.map((p) => p.name)}
          productNames={products.map((p) => p.name)}
          phaseNames={allPhaseNames}
          helpers={{ pipelineName, productName, phaseName, phaseProbOf, closeDateOf }}
          onClose={() => setExporting(false)}
        />
      )}
      {creating && (
        <NewTracking
          companies={companies} contacts={contacts} pipelines={pipelines} products={products}
          onClose={() => setCreating(false)}
          onCreated={async (id) => { setCreating(false); await reload(); setOpenId(id); }}
        />
      )}
    </div>
  );
}

function TrackingRow({ tracking, title, company, contactCount, pipeline, phases, product, revenue, ownerName, closeDate, closeProbOverride, probLabel, onOpen, index = 0 }: {
  tracking: Tracking; title: string; company: string | null; contactCount: number;
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

  return (
    <button
      className={`so-row is-${tracking.status} prob-${probTone}`}
      data-spot=""
      style={soVars({ "--i": Math.min(index, 14), "--h": soHue(title), "--cp": `${cp}%` })}
      onClick={onOpen}
    >
      {/* deal */}
      <span className="so-who">
        <span className="so-av">{title.slice(0, 1).toUpperCase()}</span>
        <span className="so-who-t">
          <span className="so-name">
            <b>{title}</b>
            {/* Active is the default, so only the exceptions get a pill. */}
            {tracking.status !== "active" && <span className={`so-status is-${tracking.status}`}>{tracking.status}</span>}
          </span>
          <span className="so-meta">
            <span>{company ? "Company" : "Contact"}</span>
            {contactCount > 0 && <span>{contactCount} contact{contactCount !== 1 ? "s" : ""}</span>}
            <span>{pipeline}</span>
          </span>
        </span>
      </span>

      {/* stage: one track, one segment per phase */}
      <span className="so-stage" title={`${pct}% through the pipeline`}>
        <span className="so-stage-top">
          <b>{stage}</b>
          <small>{curIdx >= 0 && phases.length > 0 ? `Step ${curIdx + 1} of ${phases.length}` : "Not started"}</small>
          <em>{pct}%</em>
        </span>
        <span className="so-track" aria-hidden="true">
          {(phases.length > 0 ? phases : [{ id: "none" } as Phase]).map((ph, i) => (
            <i key={ph.id} className={i < curIdx ? "is-done" : i === curIdx ? "is-cur" : ""} />
          ))}
        </span>
      </span>

      {/* product and owner */}
      <span className="so-tags">
        {product ? <span className="so-tag">{product}</span> : <span className="so-tag is-empty">No product</span>}
        <span className="so-sub">
          {ownerName && (
            <span className="so-owner" title={`Owner: ${ownerName}`}>
              <SoIcon d={SO_ICON.star} fill />
              {ownerName}
            </span>
          )}
          <span>Started {started}</span>
        </span>
      </span>

      {/* potential revenue + expected close */}
      <span className="so-value">
        <b className={revenue && revenue > 0 ? "" : "is-none"}>{revenue && revenue > 0 ? `${revenue.toLocaleString("es-ES")} €` : "No value yet"}</b>
        <small className={closeDate ? "" : "is-none"}>
          {closeDate ? `Closes ${new Date(closeDate).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" })}` : "No close date"}
        </small>
      </span>

      {/* close probability */}
      <span className="so-chance" title={probLabel ? `Close probability (${probLabel})` : undefined}>
        {closeProb == null ? (
          <b className="is-none">—</b>
        ) : (
          <b>{closeProb}<i>%</i></b>
        )}
        <span className="so-chance-bar" aria-hidden="true"><i /></span>
      </span>

      <span className="so-go" aria-hidden="true"><SoIcon d={SO_ICON.arrow} w={2.2} /></span>
    </button>
  );
}

/**
 * Type-to-filter dropdown. Same job as framework/Select but the trigger is a
 * real text input that narrows the options as you type.
 *
 * The list is rendered through a portal with position:fixed because the drawer
 * body (.dw-body) scrolls with overflow-y:auto and would clip it otherwise.
 */
function Combo({ value, onChange, options, placeholder, clearOnSelect = false, emptyText = "No matches" }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  clearOnSelect?: boolean;
  emptyText?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number; maxH: number; up: boolean } | null>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const n = norm(query.trim());
    if (!n) return options;
    return options.filter((o) => norm(o.label).includes(n));
  }, [options, query]);

  const place = () => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 14;
    const above = r.top - 14;
    const up = below < 190 && above > below;
    setBox({
      left: r.left, width: r.width, up,
      top: up ? r.top - 6 : r.bottom + 6,
      maxH: Math.max(150, Math.min(300, up ? above : below)),
    });
  };

  useEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => { window.removeEventListener("scroll", onMove, true); window.removeEventListener("resize", onMove); };
  }, [open]);

  useEffect(() => { setHi(0); }, [query, open]);

  const close = () => { setOpen(false); setQuery(""); };
  const commit = (v: string) => { onChange(v); close(); };

  const onKey = (e: any) => {
    if (e.key === "Escape") {
      // Don't let Escape bubble to the drawer, which would close the whole modal.
      if (open) { e.stopPropagation(); close(); }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setQuery(""); setOpen(true); return; }
      setHi((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); const o = filtered[hi]; if (o) commit(o.value); }
  };

  return (
    <div className="cbo" ref={wrapRef}>
      <input
        className={`cbo-input ${open ? "is-open" : ""}`}
        value={open ? query : selected?.label ?? ""}
        placeholder={open ? selected?.label || placeholder || "Type to search…" : placeholder}
        onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { if (!open) { setQuery(""); setOpen(true); } }}
        onKeyDown={onKey}
      />
      <svg className="cbo-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
      {open && box && createPortal(
        <>
          <div className="cbo-layer" onMouseDown={close} />
          <div
            className="cbo-pop"
            style={{
              left: box.left, width: box.width, maxHeight: box.maxH,
              ...(box.up ? { bottom: window.innerHeight - box.top } : { top: box.top }),
            }}
          >
            {filtered.length === 0 ? (
              <div className="cbo-empty">{emptyText}</div>
            ) : filtered.map((o, i) => (
              <button
                key={o.value || "__blank"}
                type="button"
                className={`cbo-option ${i === hi ? "is-hi" : ""} ${!clearOnSelect && o.value === value ? "is-sel" : ""}`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => { e.preventDefault(); commit(o.value); }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

function NewTracking({ companies, contacts, pipelines, products, onClose, onCreated }: {
  companies: Company[]; contacts: Contact[]; pipelines: Pipeline[]; products: Product[];
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const [companyId, setCompanyId] = useState("");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [pipelineId, setPipelineId] = useState("");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const contactName = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "-";
  };
  const availableContacts = contacts.filter((c) => !contactIds.includes(c.id!));
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? "-";
  const availableProducts = products.filter((p) => !productIds.includes(p.id!));

  const create = async () => {
    if (!pipelineId) { setErr("Pick a pipeline."); return; }
    if (!companyId && contactIds.length === 0) { setErr("Pick a company or at least one contact."); return; }
    setBusy(true); setErr(null);
    const { phases } = await loadPipeline(pipelineId).catch(() => ({ phases: [] as Phase[] }));
    const firstPhase = phases.filter((p) => p.sales_visible !== false)[0]?.id ?? phases[0]?.id ?? null;
    const id = await createTracking({
      company_id: companyId || null, pipeline_id: pipelineId,
      // Seed each product with its first tier price so Potential revenue
      // is not empty the moment the tracking opens.
      products: productIds.map((pid) => ({
        id: pid,
        price: products.find((p) => p.id === pid)?.tiers?.[0]?.price ?? 0,
      })),
      current_phase_id: firstPhase, contactIds,
    });
    setBusy(false);
    if (!id) { setErr("Could not create the tracking."); return; }
    // Whoever opens a deal is on it, or a sales rep would lose sight of their
    // own tracking the moment it is created.
    const mine = await myProfile().catch(() => null);
    if (mine) await setTrackingEmployees(id, [mine.id]).catch(() => {});
    onCreated(id);
  };

  return (
    <div className="dw-backdrop" onMouseDown={onClose}>
      <div className="dw" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dw-head">
          <div>
            <span className="dw-eyebrow">New tracking</span>
            <h2 className="dw-title">Start following a client</h2>
          </div>
          <button className="dw-x" onClick={onClose}>×</button>
        </div>
        <div className="dw-body">
          <div className="dw-sec">
            <p className="dw-sec-title">Who</p>
            <div className="dw-f dw-col2" style={{ marginBottom: 12 }}>
              <label>Company</label>
              <Combo value={companyId} onChange={setCompanyId} placeholder="Type to search companies…"
                emptyText="No company matches"
                options={[{ value: "", label: "- No company -" }, ...companies.map((c) => ({ value: c.id!, label: c.name }))]} />
            </div>
            <label className="dw-f-label">Contacts</label>
            <div className="dw-chips">
              {contactIds.map((id) => (
                <span key={id} className="dw-chip">{contactName(id)}<button onClick={() => setContactIds((xs) => xs.filter((x) => x !== id))}>×</button></span>
              ))}
            </div>
            {availableContacts.length > 0 && (
              <Combo value="" clearOnSelect onChange={(v) => v && setContactIds((xs) => [...xs, v])}
                placeholder="Type to search contacts…" emptyText="No contact matches"
                options={availableContacts.map((c) => ({ value: c.id!, label: [c.first_name, c.last_name].filter(Boolean).join(" ") }))} />
            )}
          </div>
          <div className="dw-sec">
            <p className="dw-sec-title">Pipeline</p>
            <Combo value={pipelineId} onChange={setPipelineId} placeholder="Type to search pipelines…"
              emptyText="No pipeline matches"
              options={pipelines.map((p) => ({ value: p.id, label: p.name }))} />
          </div>
          <div className="dw-sec">
            <p className="dw-sec-title">Products</p>
            <div className="dw-chips">
              {productIds.map((id) => (
                <span key={id} className="dw-chip">{productName(id)}
                  <button onClick={() => setProductIds((xs) => xs.filter((x) => x !== id))} aria-label="Remove">×</button>
                </span>
              ))}
            </div>
            {productIds.length === 0 && <p className="dw-empty-hint">No products yet (optional). Add as many as the deal covers.</p>}
            {availableProducts.length > 0 && (
              <Combo value="" clearOnSelect onChange={(v) => v && setProductIds((xs) => [...xs, v])}
                placeholder="Type to search products…" emptyText="No product matches"
                options={availableProducts.map((p) => ({ value: p.id!, label: p.name }))} />
            )}
          </div>
          {err && <p className="dw-err">{err}</p>}
        </div>
        <div className="dw-foot">
          <div className="dw-foot-right">
            <button className="dw-cancel" onClick={onClose}>Cancel</button>
            <button className="dw-save" onClick={create} disabled={busy}>{busy ? "Creating..." : "Start tracking"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
// ============================ Kanban view ============================
function KanbanView({ kanbanPipe, phaseByPipe, trackings, potentialTotals, trackTitle, companyName, onOpen, onMove }: {
  kanbanPipe: string;
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
  const fmtRev = (n: number) => n >= 1000 ? `${(n / 1000).toLocaleString("es-ES", { maximumFractionDigits: n >= 10000 ? 0 : 1 })}k €` : `${Math.round(n)} €`;

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
                  <span className="so-kcol-count">{cards.length}</span>
                </span>
                <span className="so-kcol-rev">
                  {(revByPhase[p.id] ?? 0) > 0 ? <>{fmtRev(revByPhase[p.id])} <small>potential</small></> : <small>No potential revenue</small>}
                </span>
              </div>
              <div className="so-kcol-body">
                {cards.length === 0 ? (
                  <div className="so-kcol-empty">Drop a deal here</div>
                ) : cards.map((t, ci) => {
                  const title = trackTitle(t);
                  const rev = potentialTotals[t.id!] ?? 0;
                  return (
                    <div
                      key={t.id}
                      className={`so-kcard is-${t.status} ${dragId === t.id ? "is-dragging" : ""}`}
                      data-spot=""
                      style={soVars({ "--h": soHue(title), "--i": Math.min(ci, 8) + pi })}
                      draggable
                      onDragStart={() => setDragId(t.id)}
                      onDragEnd={() => { setDragId(null); setOverPhase(null); }}
                      onClick={() => onOpen(t.id)}
                    >
                      <span className="so-av">{title.slice(0, 1).toUpperCase()}</span>
                      <span className="so-kcard-t">
                        <b>{title}</b>
                        <small>{companyName(t.company_id) ? "Company" : "Contact"}</small>
                      </span>
                      <span className="so-kcard-side">
                        <span className={`so-status is-${t.status}`}>{t.status}</span>
                        {rev > 0 && <span className="so-kcard-rev">{fmtRev(rev)}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}