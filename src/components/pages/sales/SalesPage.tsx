/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Select from "../../framework/Select";
import { supabase } from "../../api/supabase";
import { listCompanies, listContacts, type Company, type Contact } from "../companies/companiesApi";
import { listPipelines, loadPipeline, type Pipeline, type Phase } from "../settings/pipelineApi";
import { loadProducts, type Product } from "../settings/catalogApi";
import { listTrackings, createTracking, setTrackingPhase, setTrackingStatus, stampPhaseEntry, clearPhaseEventsAfter, type Tracking } from "./salesApi";
import TrackingDetail from "./TrackingDetail";
import "../companies/CompaniesPage.css";
import "./SalesPage.css";

export interface Employee { id: string; name: string }

const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export default function SalesPage() {
  const navigate = useNavigate();
  const [trackings, setTrackings] = useState<Tracking[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [phaseByPipe, setPhaseByPipe] = useState<Record<string, Phase[]>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<"list" | "kanban">("list");
  const [viewMenu, setViewMenu] = useState(false);

  const [q, setQ] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fPipeline, setFPipeline] = useState("");
  const [fProduct, setFProduct] = useState("");
  const [fCompany, setFCompany] = useState("");
  const [fPhase, setFPhase] = useState("");
  const [sort, setSort] = useState("recent");

  const reload = async () => setTrackings(await listTrackings().catch(() => []));
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
  const trackTitle = (t: Tracking) => companyName(t.company_id) || (t.contactIds[0] ? contactName(t.contactIds[0]) : "Untitled");

  const allPhaseNames = useMemo(() => {
    const s = new Set<string>();
    Object.values(phaseByPipe).forEach((ph) => ph.forEach((p) => s.add(p.name)));
    return Array.from(s);
  }, [phaseByPipe]);

  const shown = useMemo(() => {
    const n = norm(q.trim());
    let list = trackings.filter((t) => {
      if (fStatus && t.status !== fStatus) return false;
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
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackings, q, fStatus, fPipeline, fProduct, fCompany, fPhase, sort, companies, contacts, pipelines, products, phaseByPipe]);

  const metrics = useMemo(() => {
    const active = trackings.filter((t) => t.status === "active").length;
    const won = trackings.filter((t) => t.status === "won").length;
    const lost = trackings.filter((t) => t.status === "lost").length;
    const rate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0;
    return { total: trackings.length, active, won, lost, rate };
  }, [trackings]);

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
        <button className="sl-new" onClick={() => setCreating(true)}>+ New tracking</button>
      </header>

      <div className="sl-metrics">
        <div className="sl-metric sl-m-total">
          <span className="sl-metric-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M8 4v16"/></svg></span>
          <span className="sl-metric-txt"><b>{metrics.total}</b><span>total</span></span>
        </div>
        <div className="sl-metric sl-m-active">
          <span className="sl-metric-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7z"/></svg></span>
          <span className="sl-metric-txt"><b>{metrics.active}</b><span>active</span></span>
        </div>
        <div className="sl-metric sl-m-won">
          <span className="sl-metric-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg></span>
          <span className="sl-metric-txt"><b>{metrics.won}</b><span>won</span></span>
        </div>
        <div className="sl-metric sl-m-lost">
          <span className="sl-metric-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg></span>
          <span className="sl-metric-txt"><b>{metrics.lost}</b><span>lost</span></span>
        </div>
        <div className="sl-metric sl-m-rate">
          <span className="sl-metric-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8M17 7h4v4"/></svg></span>
          <span className="sl-metric-txt"><b>{metrics.rate}%</b><span>win rate</span></span>
        </div>
      </div>

      <div className="sl-filters">
        <div className="sl-search">
          <span className="sl-search-ico">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />
          {q && <button onClick={() => setQ("")}>×</button>}
        </div>
        <Select value={fStatus} onChange={setFStatus} placeholder="Any status"
          options={[{ value: "", label: "Any status" }, { value: "active", label: "Active" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }, { value: "paused", label: "Paused" }]} />
        <Select value={fPipeline} onChange={setFPipeline} placeholder="All pipelines"
          options={[{ value: "", label: "All pipelines" }, ...pipelines.map((p) => ({ value: p.id, label: p.name }))]} />
        <Select value={fProduct} onChange={setFProduct} placeholder="All products"
          options={[{ value: "", label: "All products" }, ...products.map((p) => ({ value: p.id!, label: p.name }))]} />
        <Select value={fCompany} onChange={setFCompany} placeholder="All companies"
          options={[{ value: "", label: "All companies" }, ...companies.map((c) => ({ value: c.id!, label: c.name }))]} />
        <Select value={fPhase} onChange={setFPhase} placeholder="Any stage"
          options={[{ value: "", label: "Any stage" }, ...allPhaseNames.map((p) => ({ value: p, label: p }))]} />
        <Select value={sort} onChange={setSort} placeholder="Sort"
          options={[{ value: "recent", label: "Most recent" }, { value: "oldest", label: "Oldest" }, { value: "az", label: "A-Z" }]} />
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
          <div className="sl-lrow sl-lhead">
            <span>Client</span><span>Pipeline</span><span>Stage</span><span>Product</span><span>Started</span><span>Progress</span><span>Status</span>
          </div>
          <div className="sl-list">
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
                onOpen={() => setOpenId(t.id)}
              />
            ))}
          </div>
        </div>
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

function TrackingRow({ tracking, title, company, contactCount, pipeline, phases, product, onOpen }: {
  tracking: Tracking; title: string; company: string | null; contactCount: number;
  pipeline: string; phases: Phase[]; product: string | null; onOpen: () => void;
}) {
  const curIdx = phases.findIndex((p) => p.id === tracking.current_phase_id);
  const pct = phases.length ? Math.round(((curIdx + 1) / phases.length) * 100) : 0;
  const stage = curIdx >= 0 ? phases[curIdx]?.name ?? "-" : "Not started";
  const started = tracking.created_at ? new Date(tracking.created_at).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" }) : "-";

  return (
    <button className="sl-lrow" onClick={onOpen}>
      <span className="sl-lcell sl-lclient">
        <span className="sl-lavatar">{title.slice(0, 1).toUpperCase()}</span>
        <span className="sl-lclient-text">
          <span className="sl-lname">{title}</span>
          <span className="sl-lsub">{company ? "Company" : "Contact"}{contactCount > 0 && ` \u00b7 ${contactCount} contact${contactCount !== 1 ? "s" : ""}`}</span>
        </span>
      </span>
      <span className="sl-lcell"><span className="sl-tag sl-tag-pipe">{pipeline}</span></span>
      <span className="sl-lcell sl-lstage">{stage}</span>
      <span className="sl-lcell">{product ? <span className="sl-tag sl-tag-prod">{product}</span> : <span className="sl-lmuted">-</span>}</span>
      <span className="sl-lcell sl-lmuted">{started}</span>
      <span className="sl-lcell sl-lprog">
        <span className="sl-lprog-track"><span className={`sl-lprog-fill sl-lprog-${tracking.status}`} style={{ width: `${pct}%` }} /></span>
        <span className="sl-lprog-pct">{pct}%</span>
      </span>
      <span className="sl-lcell"><span className={`sl-status sl-status-${tracking.status}`}>{tracking.status}</span></span>
    </button>
  );
}

function NewTracking({ companies, contacts, pipelines, products, onClose, onCreated }: {
  companies: Company[]; contacts: Contact[]; pipelines: Pipeline[]; products: Product[];
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const [companyId, setCompanyId] = useState("");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [pipelineId, setPipelineId] = useState("");
  const [productId, setProductId] = useState("");
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

  const create = async () => {
    if (!pipelineId) { setErr("Pick a pipeline."); return; }
    if (!companyId && contactIds.length === 0) { setErr("Pick a company or at least one contact."); return; }
    setBusy(true); setErr(null);
    const { phases } = await loadPipeline(pipelineId).catch(() => ({ phases: [] as Phase[] }));
    const firstPhase = phases.filter((p) => p.sales_visible !== false)[0]?.id ?? phases[0]?.id ?? null;
    const id = await createTracking({
      company_id: companyId || null, pipeline_id: pipelineId,
      product_id: productId || null, current_phase_id: firstPhase, contactIds,
    });
    setBusy(false);
    if (!id) { setErr("Could not create the tracking."); return; }
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
              <Select value={companyId} onChange={setCompanyId} placeholder="- No company -"
                options={[{ value: "", label: "- No company -" }, ...companies.map((c) => ({ value: c.id!, label: c.name }))]} />
            </div>
            <label className="dw-f-label">Contacts</label>
            <div className="dw-chips">
              {contactIds.map((id) => (
                <span key={id} className="dw-chip">{contactName(id)}<button onClick={() => setContactIds((xs) => xs.filter((x) => x !== id))}>×</button></span>
              ))}
            </div>
            {availableContacts.length > 0 && (
              <Select value="" onChange={(v) => v && setContactIds((xs) => [...xs, v])} placeholder="+ Add a contact"
                options={availableContacts.map((c) => ({ value: c.id!, label: [c.first_name, c.last_name].filter(Boolean).join(" ") }))} />
            )}
          </div>
          <div className="dw-sec">
            <p className="dw-sec-title">Pipeline</p>
            <Select value={pipelineId} onChange={setPipelineId} placeholder="Pick a pipeline"
              options={pipelines.map((p) => ({ value: p.id, label: p.name }))} />
          </div>
          <div className="dw-sec">
            <p className="dw-sec-title">Product</p>
            <Select value={productId} onChange={setProductId} placeholder="- No product -"
              options={[{ value: "", label: "- No product -" }, ...products.map((p) => ({ value: p.id!, label: p.name }))]} />
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

  const boardTrackings = useMemo(() => trackings.filter((t) => t.pipeline_id === kanbanPipe), [trackings, kanbanPipe]);
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
                    className={`sl-kcard ${dragId === t.id ? "is-dragging" : ""}`}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => { setDragId(null); setOverPhase(null); }}
                    onClick={() => onOpen(t.id)}
                  >
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