/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import SalesMultiFilter from "./SalesMultiFilter";
import SalesRangeFilter, { EMPTY_RANGES, activeRangeCount, HeaderRangePopover, rangeActive, clearRange, type SalesRanges, type RangeKind } from "./SalesRangeFilter";
import SalesForecast, { type ForecastKpis } from "./SalesForecast";
import { supabase } from "../../../api/supabase";
import { listCompanies, listContacts, myProfile, type Company, type Contact } from "../../companies/companiesApi";
import { listPipelines, loadPipeline, loadPhasesByPipeline, type Pipeline, type Phase } from "../../settings/pipelineApi";
import { loadProducts, loadServices, type Product } from "../../settings/catalogApi";
import { listTrackings, loadTrackingTeams, setTrackingPhase, setTrackingStatus, stampPhaseEntry, clearPhaseEventsAfter, trackingPct, loadPotentialTotals, type Tracking } from "./salesApi";
import TrackingDetail from "../trackings/TrackingDetail";
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

/** A status card in the dark band. Clicking it filters the list, as before. */
function SoKpi({
  index, tone, icon, label, value, sub, share, dial, on, onClick, title, unit,
}: {
  index: number; tone: string; icon: string; label: string; value: number; sub: string;
  share?: number | null; dial?: number | null; on: boolean; onClick: () => void; title?: string;
  /** e.g. "€" for money figures */
  unit?: string;
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
          <b className="so-kpi-val"><SoCount value={value} />{dial != null && <em>%</em>}{unit && <em className="so-kpi-unit">{unit}</em>}</b>
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
  // First load: the page stays behind the loading screen until everything the list needs is in
  // (deals, who I am and what I may see, companies, people, pipelines and their phases) — all
  // fetched in a single round of parallel requests and applied in one render.
  const [booted, setBooted] = useState(false);
  /** The frosted loading layer stays until its fade-out has finished. */
  const [bootGone, setBootGone] = useState(false);
  const [rawTotals, setPotentialTotals] = useState<Record<string, number>>({});
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
  const [reporting, setReporting] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  /** Sales roles (who sees which pipelines, up to which phase) and the handovers they caused. */
  const [salesRoles, setSalesRoles] = useState<SalesRole[]>([]);
  const [rolesReady, setRolesReady] = useState(false);
  /** Access settings (Sales roles → Who sees what → Adjust settings). */
  const [accessRules, setAccessRules] = useState<RuleMap>({});
  const [accessMissing, setAccessMissing] = useState(false);
  const [handovers, setHandovers] = useState<TrackingHandover[]>([]);
  const [phaseEvents, setPhaseEvents] = useState<Record<string, string[]>>({});
  const [pendingHandover, setPendingHandover] = useState<{ plan: HandoverPlan; t: Tracking; phaseId: string; phases: Phase[] } | null>(null);
  /** Custom deal fields (Actions → Deal fields). */
  const [trackingFields, setTrackingFields] = useState<TrackingField[]>([]);
  const [view, setView] = useState<"list" | "kanban" | "forecast">("list");
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

  /** Deals and everything hanging off them — every request at once. */
  const fetchDeals = () => {
    const cat = catalog();
    const deals = listTrackings().catch(() => [] as Tracking[]);
    return Promise.all([
      deals,
      // Totals reuse the deals and the catalog above instead of reading them again.
      loadPotentialTotals({ trackings: deals, products: cat.products, services: cat.services }).catch(() => ({} as Record<string, number>)),
      loadTrackingTeams().catch(() => ({ members: {} as Record<string, string[]>, owners: {} as Record<string, string> })),
      loadSalesRoles().catch(() => ({ roles: [] as SalesRole[], missing: true })),
      loadHandovers().catch(() => [] as TrackingHandover[]),
      loadAllPhaseEvents().catch(() => ({} as Record<string, string[]>)),
      loadAccessRules().catch(() => ({ rules: {} as RuleMap, missing: true })),
    ]);
  };
  const applyDeals = ([ts, pt, team, r, h, ev, acc]: Awaited<ReturnType<typeof fetchDeals>>) => {
    setTrackings(ts); setPotentialTotals(pt); setTrackAssignees(team.members); setTrackOwners(team.owners);
    setSalesRoles(r.roles); setHandovers(h); setPhaseEvents(ev); setAccessRules(acc.rules); setAccessMissing(acc.missing);
    setRolesReady(true);
  };
  const reload = async () => { applyDeals(await fetchDeals()); };

  useEffect(() => {
    let alive = true;
    const cat = catalog();
    cat.products.then((ps) => { if (alive) setProducts(ps); });

    // People: names straight from profiles (one quick query, part of the first round), then the
    // full user list from manage-users when it answers — it's an Edge Function and can be slow
    // to wake up, so the page never waits for it.
    const profiles = Promise.resolve(
      supabase.from("profiles").select("id, first_name, last_name, email, role, is_superadmin"),
    ).then(({ data }: any) => (data ?? []) as any[]).catch(() => [] as any[]);
    const fromProfiles = (rows: any[]): Employee[] => rows.map((p) => ({
      id: p.id,
      name: [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || p.email || "—",
      role: p.role ?? "", email: p.email ?? "", is_superadmin: !!p.is_superadmin,
    }));

    Promise.all([
      fetchDeals(),
      myProfile().catch(() => null),
      listCompanies().catch(() => [] as Company[]),
      listPipelines().catch(() => [] as Pipeline[]),
      loadPhasesByPipeline().catch(() => ({} as Record<string, Phase[]>)),
      profiles,
    ]).then(([deals, meRow, cos, ps, phases, profs]) => {
      if (!alive) return;
      const sales = ps.filter((p) => p.is_sales);
      applyDeals(deals);
      setMe(meRow);
      setCompanies(cos);
      setPipelines(sales);
      setPhaseByPipe(Object.fromEntries(sales.map((p) => [p.id, (phases[p.id] ?? []).filter((ph) => ph.sales_visible !== false)])));
      setEmployees((cur) => (cur.length ? cur : fromProfiles(profs)));
      setBooted(true);
    });

    // Not needed for the first paint: they fill in while you look at the list.
    listContacts().then((cs) => { if (alive) setContacts(cs); }).catch(() => {});
    listTrackingFields().then((fs) => { if (alive) setTrackingFields(fs); }).catch(() => {});
    supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(async ({ data }: any) => {
      const users = (data?.users ?? []) as any[];
      if (!alive || !users.length) return;
      const byId = new Map<string, any>((await profiles).map((x) => [x.id, x]));
      setEmployees(users.map((u: any) => {
        const p = byId.get(u.id);
        const profName = p ? [p.first_name, p.last_name].filter(Boolean).join(" ").trim() : "";
        return {
          id: u.id, name: u.full_name || profName || u.email || "—",
          role: p?.role || u.role || "", email: u.email ?? p?.email ?? "", is_superadmin: !!p?.is_superadmin,
        };
      }));
    }).catch(() => {});
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  const potentialTotals = useMemo(() => {
    if (!frozenById.size) return rawTotals;
    const out = { ...rawTotals };
    frozenById.forEach((h, id) => { out[id] = Number(h.snapshot?.total) || 0; });
    return out;
  }, [rawTotals, frozenById]);
  const visiblePipelines = useMemo(() => (access.pipelines ? pipelines.filter((p) => access.pipelines!.has(p.id)) : pipelines), [pipelines, access]);

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
      if (fStatus.length && !fStatus.includes(t.status)) return false;
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
      if (!n) return true;
      return [trackTitle(t), companyName(t.company_id) ?? "", pipelineName(t.pipeline_id), productName(t.product_id) ?? "", ...t.contactIds.map(contactName)]
        .some((v) => norm(v).includes(n));
    });
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
  }, [mine, q, fStatus, fPipeline, fProduct, fCompany, fPhase, fOwner, fMember, fRanges, sort, probView, companies, contacts, pipelines, products, phaseByPipe, potentialTotals, trackAssignees, trackOwners, me]);

  // Clicking the KPI card that is already active clears the filter again.
  // Status cards combine: Active + Won shows both; clicking an active card removes it.
  const toggleStatus = (s: string) => setFStatus((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const closedOn = fStatus.length === 2 && fStatus.includes("won") && fStatus.includes("lost");

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
  const moveTrackingToPhase = async (trackingId: string, phaseId: string, pipelinePhases: Phase[], skipHandover = false) => {
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
  };

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

  if (openId) {
    const t = mine.find((x) => x.id === openId);
    const frozen = t ? frozenById.get(t.id) : undefined;
    if (t && frozen) return <HandedOverView tracking={t} handover={frozen} companies={companies} contacts={contacts} employees={employees} trackingFields={trackingFields} onBack={() => { setOpenId(null); reload(); }} />;
    if (t) return <TrackingDetail tracking={t} companies={companies} contacts={contacts} products={products} employees={employees} trackingFields={trackingFields} salesRoles={salesRoles} onBack={() => { setOpenId(null); reload(); }} />;
  }


  const ready = booted;

  // Who can open Sales at all: anyone with at least one view (Who sees what → Adjust settings).
  // (While loading, the page itself renders under a frosted layer — see SalesBoot.)
  if (me && rolesReady && perms && !perms.canOpen) {
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
          ...(createLevel !== "none" ? [{ key: "new", group: "Create", label: "New tracking", hint: "Start following a client", icon: AM_ICON.plus, primary: true, tone: "green" as const, shortcut: "N", onSelect: () => setCreating(true) }] : []),
          ...(canReports ? [{ key: "reports", group: "Analyse", label: "Reports", hint: "Lists, boards, forecasts and charts", icon: <SoIcon d={SO_ICON.report} w={1.9} />, tone: "blue" as const, shortcut: "R", onSelect: () => setReporting(true) }] : []),
          ...(exportLevel !== "none" ? [{ key: "export", group: "Analyse", label: "Export", hint: exportLevel === "all" ? "Every deal, contact or company to Excel" : "The deals you can see, to Excel", icon: AM_ICON.export, tone: "violet" as const, shortcut: "E", onSelect: () => setExporting(true) }] : []),
          ...(canImport ? [{ key: "import", group: "Analyse", label: "Import deals", hint: "From another CRM's Excel or CSV", icon: AM_ICON.import, tone: "violet" as const, shortcut: "I", onSelect: () => setImporting(true) }] : []),
          ...(canFields ? [{ key: "fields", group: "Setup", label: "Deal fields", hint: trackingFields.length ? `${trackingFields.length} custom ${trackingFields.length === 1 ? "field" : "fields"} on every tracking` : "Add your own fields to every tracking", icon: AM_ICON.fields, tone: "amber" as const, shortcut: "F", onSelect: () => setFieldsOpen(true) }] : []),
          ...(canManage ? [
            { key: "roles", group: "Setup", label: "Sales roles", hint: salesRoles.length ? `${salesRoles.length} ${salesRoles.length === 1 ? "role" : "roles"} · who sees which deals` : "Who sees which pipelines, and handovers", icon: <SoIcon d={SO_ICON.roles} w={1.9} />, tone: "slate" as const, shortcut: "O", onSelect: () => setRolesOpen(true) },
          ] : []),
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
            sub={fcKpi?.overdueCount ? `${Math.round(fcKpi.overdueValue).toLocaleString("es-ES")} € past its close date` : "nothing late"}
            share={fcKpi && fcKpi.openCount ? fcKpi.overdueCount / fcKpi.openCount : 0}
            on={false} onClick={() => {}} title="Open deals whose expected close date has passed" />
        </div>
      ) : (
      /* Status cards: each one filters the list, clicking it again clears it. */
      <div className="so-kpis" key="status-kpis">
        <SoKpi index={0} tone="total" icon={SO_ICON.total} label="Total deals" value={metrics.total}
          sub={`${metrics.active} still open`} on={fStatus.length === 0} onClick={() => setFStatus([])} title="Show every deal" />
        <SoKpi index={1} tone="active" icon={SO_ICON.active} label="Active" value={metrics.active}
          sub={metrics.total ? `${Math.round((metrics.active / metrics.total) * 100)}% of all deals` : "No deals yet"}
          share={metrics.total ? metrics.active / metrics.total : 0}
          on={fStatus.includes("active")} onClick={() => toggleStatus("active")} />
        <SoKpi index={2} tone="won" icon={SO_ICON.won} label="Won" value={metrics.won}
          sub={metrics.total ? `${Math.round((metrics.won / metrics.total) * 100)}% of all deals` : "No deals yet"}
          share={metrics.total ? metrics.won / metrics.total : 0}
          on={fStatus.includes("won")} onClick={() => toggleStatus("won")} />
        <SoKpi index={3} tone="rate" icon={SO_ICON.rate} label="Win rate" value={metrics.rate} dial={metrics.rate}
          sub={metrics.won + metrics.lost > 0 ? `${metrics.won} won of ${metrics.won + metrics.lost} closed` : "Nothing closed yet"}
          on={closedOn} onClick={() => setFStatus(closedOn ? [] : ["won", "lost"])} title="Show closed deals (won and lost)" />
      </div>
      )}

      <section className="so-sheet">
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
          <SalesMultiFilter single values={[sort]} onChange={(v) => v[0] && setSort(v[0])} placeholder="Sort" searchFrom={99}
            options={[{ value: "recent", label: "Most recent" }, { value: "oldest", label: "Oldest" }, { value: "az", label: "A-Z" }, { value: "za", label: "Z-A" }, { value: "stage_lo", label: "Stage: early → late" }, { value: "stage_hi", label: "Stage: late → early" }, { value: "prod_az", label: "Product: A-Z" }, { value: "prod_za", label: "Product: Z-A" }, { value: "prob_hi", label: "Probability: high → low" }, { value: "prob_lo", label: "Probability: low → high" }, { value: "close_soon", label: "Close date: soonest first" }, { value: "close_late", label: "Close date: latest first" }, { value: "rev_hi", label: "Revenue: high → low" }, { value: "rev_lo", label: "Revenue: low → high" }]} />
          </div>
          <button type="button" className="so-farrow is-r" onClick={() => nudgeTrack(1)} aria-label="Scroll filters right" disabled={!fEdge.r}>
            <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
          </button>
          </div>
          {anyFilter && <button className="sl-clear" onClick={clearAll}>Clear</button>}
          <span className="so-count"><b>{shown.length}</b> {shown.length === 1 ? "deal" : "deals"}</span>
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
              ownerName={(t) => (trackOwners[t.id] ? employees.find((e) => e.id === trackOwners[t.id])?.name ?? null : null)}
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
            onMove={moveTrackingToPhase}
          />
        ) : shown.length === 0 && ready ? (
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
            <div className="so-thead">
              <span>{headBtn("deal", "Deal")}</span>
              <span>{headBtn("stage", "Stage")}</span>
              <span>{headBtn("product", "Product and owner")}</span>
              <span className="is-r so-th-pair">{headBtn("rev", "Potential")}<i>and</i>{headBtn("close", "close")}</span>
              <span className="is-r">{headBtn("prob", probView === "phase" ? "Close chance" : probView === "rep" ? "Sales estimate" : probView === "mgr" ? "Mgmt estimate" : "Avg. estimate")}</span>
              <span />
            </div>
            {headPop && (
              <HeaderRangePopover
                kind={headPop.kind} anchor={headPop.rect} value={fRanges} onChange={setFRanges}
                onClose={() => setHeadPop(null)}
                probLabel={probView === "rep" ? "Sales estimate" : probView === "mgr" ? "Management estimate" : probView === "avg" ? "Average estimate" : "Phase probability"} />
            )}
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
                  handedOver={frozenById.has(t.id)}
                  onOpen={() => setOpenId(t.id)}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {exporting && (
        <ExportModal
          deals={exportDeals}
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
          onClose={() => setExporting(false)}
        />
      )}
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
      {importing && (
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
      )}
      {rolesOpen && (
        <SalesRolesModal
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
          onClose={() => setRolesOpen(false)}
        />
      )}
      {fieldsOpen && (
        <TrackingFieldsModal
          canEdit={canFields}
          onChanged={setTrackingFields}
          onClose={() => setFieldsOpen(false)}
        />
      )}
      {!bootGone && <SalesBoot leaving={ready} onGone={() => setBootGone(true)} />}
    </div>
  );
}

function TrackingRow({ tracking, title, company, contactCount, pipeline, phases, product, revenue, ownerName, closeDate, closeProbOverride, probLabel, onOpen, index = 0, handedOver = false }: {
  tracking: Tracking; title: string; company: string | null; contactCount: number; handedOver?: boolean;
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
            <b>{title}{handedOver && <span className="so-handed" title="You handed this deal over — you see it as it was then">Handed over</span>}</b>
            {/* Active is the default, so only the exceptions get a pill. */}
            {tracking.status !== "active" && <span className={`so-status is-${tracking.status}`}>{statusText(tracking.status)}</span>}
          </span>
          <span className="so-meta">
            <span>{company ? (tracking.deal_name?.trim() ? company : "Company") : "Contact"}</span>
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
                        <small>{companyName(t.company_id) ? (t.deal_name?.trim() ? companyName(t.company_id) : "Company") : "Contact"}</small>
                      </span>
                      <span className="so-kcard-side">
                        <span className={`so-status is-${t.status}`}>{statusText(t.status)}</span>
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

/**
 * First load of Sales. The page renders straight away underneath a frosted,
 * see-through layer; a small glass card shows a deal travelling through the
 * phases. When everything is in, the blur melts away and the page comes into
 * focus with its data. On a quick load the card never appears — only the blur.
 */
function SalesBoot({ leaving, onGone }: { leaving: boolean; onGone: () => void }) {
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(onGone, 620);
    return () => window.clearTimeout(t);
  }, [leaving]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`sb${leaving ? " is-leaving" : ""}`} role="status" aria-live="polite" aria-busy={!leaving}
      aria-label={leaving ? "Pipeline loaded" : "Loading your pipeline"}>
      <div className="sb-card">
        <div className="sb-pipe" aria-hidden="true">
          <span className="sb-track"><i className="sb-fill" /></span>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="sb-node" style={{ ["--i" as string]: i } as CSSProperties}><i /></span>
          ))}
          <span className="sb-deal"><i /></span>
        </div>
        <span className="sb-title">Loading your pipeline</span>
        <span className="sb-sub">Deals · phases · forecast</span>
      </div>
    </div>
  );
}