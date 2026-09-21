/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import Select from "../../framework/Select";
import { supabase } from "../../api/supabase";
import { listCompanies, listContacts, type Company, type Contact } from "../companies/companiesApi";
import { listPipelines, loadPipeline, type Pipeline, type Phase } from "../settings/pipelineApi";
import { loadProducts, type Product } from "../settings/catalogApi";
import { listTrackings, loadAllTrackingEmployees, setTrackingEmployees, createTracking, setTrackingPhase, setTrackingStatus, stampPhaseEntry, clearPhaseEventsAfter, trackingPct, loadPotentialTotals, type Tracking } from "./salesApi";
import TrackingDetail from "./TrackingDetail";
import ExportModal from "./ExportModal";
import "../companies/CompaniesPage.css";
import { myProfile, isSalesLead, canOpenSales } from "../companies/companiesApi";
import "./SalesPage.css";

export interface Employee { id: string; name: string }

const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

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
  const [viewMenu, setViewMenu] = useState(false);

  const [q, setQ] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fPipeline, setFPipeline] = useState("");
  const [fProduct, setFProduct] = useState("");
  const [fCompany, setFCompany] = useState("");
  const [fPhase, setFPhase] = useState("");
  const [sort, setSort] = useState("recent");
  const [probView, setProbView] = useState<"phase" | "rep" | "mgr" | "avg">("phase");

  const reload = async () => {
    setTrackings(await listTrackings().catch(() => []));
    loadPotentialTotals().then(setPotentialTotals).catch(() => {});
    setTrackAssignees(await loadAllTrackingEmployees().catch(() => ({})));
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
  }, [mine, q, fStatus, fPipeline, fProduct, fCompany, fPhase, sort, probView, companies, contacts, pipelines, products, phaseByPipe, potentialTotals, trackAssignees, me]);

  // Clicking the KPI card that is already active clears the filter again.
  const toggleStatus = (s: string) => setFStatus((cur) => (cur === s ? "" : s));

  const anyFilter = q || fStatus || fPipeline || fProduct || fCompany || fPhase || sort !== "recent";
  const clearAll = () => { setQ(""); setFStatus(""); setFPipeline(""); setFProduct(""); setFCompany(""); setFPhase(""); setSort("recent"); };

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
      <div className="sl">
        <header className="sl-head">
          <button className="sl-back" onClick={() => navigate("/home")} aria-label="Back">‹</button>
          <h1 className="sl-title">Sales</h1>
        </header>
        <p className="sl-hint">This page is only available to the sales team.</p>
      </div>
    );
  }

  return (
    <div className="sl">
      <header className="sl-head">
        <button className="sl-back" onClick={() => navigate("/home")} aria-label="Back">‹</button>
        <h1 className="sl-title">Sales Tracking</h1>
        <div className="sl-viewwrap" style={{ marginLeft: "auto" }}>
          <button className="sl-viewbtn" onClick={() => setViewMenu((v) => !v)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              {view === "list"
                ? <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                : <><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="10" rx="1" /><rect x="17" y="4" width="5" height="13" rx="1" /></>}
            </svg>
            {view === "list" ? "List view" : "Board view"}
            <svg className="sl-view-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {viewMenu && (
            <>
              <div className="sl-view-layer" onMouseDown={() => setViewMenu(false)} />
              <div className="sl-view-pop">
                <button className={view === "list" ? "is-on" : ""} onMouseDown={() => { setView("list"); setViewMenu(false); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                  General list
                </button>
                <button className={view === "kanban" ? "is-on" : ""} onMouseDown={() => { setView("kanban"); setViewMenu(false); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="10" rx="1" /><rect x="17" y="4" width="5" height="13" rx="1" /></svg>
                  Board by phase
                </button>
              </div>
            </>
          )}
        </div>
        <button className="sl-export-btn" disabled={!me} onClick={() => setExporting(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
          Export
        </button>
        <button className="sl-new" onClick={() => setCreating(true)}>+ New tracking</button>
      </header>

      <div className="sl-metrics">
        <button type="button" className={`sl-metric sl-m-total ${fStatus === "" ? "is-on" : ""}`}
          onClick={() => setFStatus("")} aria-pressed={fStatus === ""}>
          <span className="sl-metric-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M8 4v16"/></svg></span>
          <span className="sl-metric-txt"><b>{metrics.total}</b><span>total</span></span>
        </button>
        <button type="button" className={`sl-metric sl-m-active ${fStatus === "active" ? "is-on" : ""}`}
          onClick={() => toggleStatus("active")} aria-pressed={fStatus === "active"}>
          <span className="sl-metric-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7z"/></svg></span>
          <span className="sl-metric-txt"><b>{metrics.active}</b><span>active</span></span>
        </button>
        <button type="button" className={`sl-metric sl-m-won ${fStatus === "won" ? "is-on" : ""}`}
          onClick={() => toggleStatus("won")} aria-pressed={fStatus === "won"}>
          <span className="sl-metric-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg></span>
          <span className="sl-metric-txt"><b>{metrics.won}</b><span>won</span></span>
        </button>
        <button type="button" className={`sl-metric sl-m-lost ${fStatus === "lost" ? "is-on" : ""}`}
          onClick={() => toggleStatus("lost")} aria-pressed={fStatus === "lost"}>
          <span className="sl-metric-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg></span>
          <span className="sl-metric-txt"><b>{metrics.lost}</b><span>lost</span></span>
        </button>
        <button type="button" className={`sl-metric sl-m-rate ${fStatus === "closed" ? "is-on" : ""}`}
          onClick={() => toggleStatus("closed")} aria-pressed={fStatus === "closed"}
          title="Show closed deals (won and lost)">
          <span className="sl-metric-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8M17 7h4v4"/></svg></span>
          <span className="sl-metric-txt"><b>{metrics.rate}%</b><span>win rate</span></span>
        </button>
      </div>

      <div className="sl-filters">
        <div className="sl-search">
          <span className="sl-search-ico">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />
          {q && <button onClick={() => setQ("")}>×</button>}
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
        <Select value={sort} onChange={setSort} placeholder="Sort"
          options={[{ value: "recent", label: "Most recent" }, { value: "oldest", label: "Oldest" }, { value: "az", label: "A-Z" }, { value: "prob_hi", label: "Probability: high → low" }, { value: "prob_lo", label: "Probability: low → high" }, { value: "close_soon", label: "Close date: soonest first" }, { value: "close_late", label: "Close date: latest first" }, { value: "rev_hi", label: "Revenue: high → low" }, { value: "rev_lo", label: "Revenue: low → high" }]} />
        {anyFilter && <button className="sl-clear" onClick={clearAll}>Clear</button>}
      </div>

      {view === "kanban" ? (
        <KanbanView
          kanbanPipe={fPipeline}
          phaseByPipe={phaseByPipe}
          trackings={shown}
          trackTitle={trackTitle}
          companyName={companyName}
          onOpen={(id) => setOpenId(id)}
          onMove={moveTrackingToPhase}
        />
      ) : shown.length === 0 ? (
        <div className="sl-empty">
          <div className="sl-empty-art">◇</div>
          <p>{trackings.length === 0 ? "No trackings yet." : "No trackings match those filters."}</p>
          {trackings.length === 0 && <button className="sl-new" onClick={() => setCreating(true)}>Start your first tracking</button>}
        </div>
      ) : (
        <div className="sl-scroll">
          <div className="dc-list">
            {shown.map((t) => (
              <TrackingRow
                key={t.id}
                tracking={t}
                title={trackTitle(t)}
                company={companyName(t.company_id)}
                contactCount={t.contactIds.length}
                pipeline={pipelineName(t.pipeline_id)}
                phases={phaseByPipe[t.pipeline_id ?? ""] ?? []}
                product={productName(t.product_id)}
                revenue={potentialTotals[t.id!] ?? 0}
                closeDate={closeDateOf(t)}
                closeProbOverride={shownProbOf(t)}
                probLabel={probView === "phase" ? "close" : probView === "rep" ? "sales" : probView === "mgr" ? "mgmt" : "avg"}
                onOpen={() => setOpenId(t.id)}
              />
            ))}
          </div>
        </div>
      )}

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

function TrackingRow({ tracking, title, company, contactCount, pipeline, phases, product, revenue, closeDate, closeProbOverride, probLabel, onOpen }: {
  tracking: Tracking; title: string; company: string | null; contactCount: number;
  pipeline: string; phases: Phase[]; product: string | null; revenue?: number; closeDate?: string | null;
  closeProbOverride?: number | null; probLabel?: string; onOpen: () => void;
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

  return (
    <button className={`dc dc-${tracking.status} dc-${probTone}`} onClick={onOpen}>
      {/* left rail: big progress number */}
      <div className="dc-rail">
        <span className="dc-rail-pct">{pct}<i>%</i></span>
        <span className="dc-rail-lbl">progress</span>
        <span className="dc-rail-bar"><span className="dc-rail-fill" style={{ height: `${pct}%` }} /></span>
      </div>

      {/* body */}
      <div className="dc-body">
        <div className="dc-head">
          <span className="dc-avatar">{title.slice(0, 1).toUpperCase()}</span>
          <div className="dc-headtxt">
            <span className="dc-name">{title}</span>
            <span className="dc-meta">{company ? "Company" : "Contact"}{contactCount > 0 && ` \u00b7 ${contactCount} contact${contactCount !== 1 ? "s" : ""}`} · {pipeline}</span>
          </div>
          <span className={`dc-status dc-status-${tracking.status}`}>{tracking.status}</span>
        </div>

        <div className="dc-footer">
          <span className="dc-stage">
            <span className="dc-stage-dot" />
            {stage}
          </span>
          {product && <span className="dc-prod">{product}</span>}
          <span className="dc-date">{started}</span>
        </div>
      </div>

      {/* potential revenue */}
      <div className="dc-rev">
        <span className="dc-rev-val">{revenue && revenue > 0 ? `${revenue.toLocaleString("es-ES")} €` : "—"}</span>
        <span className="dc-rev-lbl">potential</span>
      </div>

      {/* expected close date */}
      <div className="dc-close-col">
        {closeDate ? (
          <>
            <span className="dc-close-lbl">Est. close</span>
            <span className="dc-close-val">{new Date(closeDate).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" })}</span>
          </>
        ) : (
          <>
            <span className="dc-close-lbl">Est. close</span>
            <span className="dc-close-none">—</span>
          </>
        )}
      </div>

      {/* right: close probability ring */}
      <div className="dc-ring-wrap">
        {closeProb == null ? (
          <span className="dc-ring-empty">—</span>
        ) : (
          <span className="dc-ring-inner">
            <svg className="dc-ring" viewBox="0 0 40 40" aria-hidden="true">
              <circle className="dc-ring-bg" cx="20" cy="20" r="16" />
              <circle className="dc-ring-fg" cx="20" cy="20" r="16"
                style={{ strokeDasharray: `${(closeProb / 100) * 100.5} 100.5` }} />
            </svg>
            <span className="dc-ring-val"><b>{closeProb}<i>%</i></b></span>
          </span>
        )}
        <span className="dc-ring-lbl">{probLabel ?? "close"}</span>
      </div>
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
function KanbanView({ kanbanPipe, phaseByPipe, trackings, trackTitle, companyName, onOpen, onMove }: {
  kanbanPipe: string;
  phaseByPipe: Record<string, Phase[]>;
  trackings: Tracking[];
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

  const drop = (phaseId: string) => {
    if (dragId) onMove(dragId, phaseId, phases);
    setDragId(null); setOverPhase(null);
  };

  if (!kanbanPipe) {
    return <div className="sl-empty"><div className="sl-empty-art">▦</div><p>Pick a pipeline in the filter above to see its board.</p></div>;
  }
  if (phases.length === 0) {
    return <div className="sl-empty"><div className="sl-empty-art">▦</div><p>This pipeline has no visible phases.</p></div>;
  }

  return (
    <div className="sl-kanban">
      <div className="sl-kcols">
        {phases.map((p) => (
          <div
            key={p.id}
            className={`sl-kcol ${overPhase === p.id ? "is-over" : ""} ${p.sales_outcome ? `sl-kcol-${p.sales_outcome}` : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOverPhase(p.id); }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setOverPhase(null); }}
            onDrop={() => drop(p.id)}
          >
            <div className="sl-kcol-head">
              <span className="sl-kcol-name">
                {p.sales_outcome === "win" ? "★ " : p.sales_outcome === "loss" ? "✕ " : ""}{p.name}
              </span>
              <span className="sl-kcol-count">{byPhase[p.id]?.length ?? 0}</span>
            </div>
            <div className="sl-kcol-body">
              {(byPhase[p.id] ?? []).length === 0 ? (
                <div className="sl-kcol-empty">Drop here</div>
              ) : (byPhase[p.id] ?? []).map((t) => {
                const title = trackTitle(t);
                return (
                  <div
                    key={t.id}
                    className={`sl-kcard sl-kcard-${t.status} ${dragId === t.id ? "is-dragging" : ""}`}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => { setDragId(null); setOverPhase(null); }}
                    onClick={() => onOpen(t.id)}
                  >
                    <span className="sl-kcard-accent" aria-hidden="true" />
                    <span className="sl-kcard-avatar">{title.slice(0, 1).toUpperCase()}</span>
                    <span className="sl-kcard-id">
                      <span className="sl-kcard-name">{title}</span>
                      <span className="sl-kcard-sub">{companyName(t.company_id) ? "Company" : "Contact"}</span>
                    </span>
                    <span className={`sl-status sl-status-${t.status}`}>{t.status}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}