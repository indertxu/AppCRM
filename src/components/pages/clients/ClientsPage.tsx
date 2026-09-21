/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import NewClientForm from "./NewClientForm";
import ClientWorkspace from "./ClientWorkspace";
import ProjectsView from "./ProjectsView";
import Select from "../../framework/Select";
import { markHandoffConverted } from "../sales/salesApi";
import { roleSeesAll } from "../companies/companiesApi";
import "./ClientsPage.css";

export interface Contact {
  id: string;
  name: string;
  position: string;
  email: string;
  phone: string;
  billing: boolean;
}
export interface Address {
  street: string; number: string; details: string;
  postalCode: string; city: string; country: string;
}
export interface Phase {
  id: string;
  name: string;
  days: number;
  tasks: { id: string; name: string }[];
}
export interface TeamMember {
  id: string;
  role: string;
  userId: string;
  name: string;
}

/** Client identity only — shared by all its projects. */
export interface Client {
  id: string;
  name: string;
}

/** One engagement for a client. */
export interface Project {
  id: string;
  clientId: string;
  legalName: string;
  vatNumber: string;
  address: Address;
  contacts: Contact[];
  projectTypeId: string;
  kickoffDate: string;
  signingDate: string;
  consultorDays: number;
  connectorDays: number;
  pricePerDay: number;
  supervisionDays: number;
  supervisionPrice: number;
  taxed: boolean;
  taxRate: number;
  paymentDays: number;
  discountMode: "none" | "rate" | "total" | "percent";
  discountValue: number;
  supervisionDiscountMode: "none" | "rate" | "percent";
  supervisionDiscountValue: number;
phases: Phase[];
  team: TeamMember[];
  status: string;
  endDate: string;
}

/**
 * What used to be a "project type" is now a service from the catalogue.
 * The field names are kept so the rest of the app keeps compiling, but the
 * data comes from `services` and is stored in `projects.service_id`.
 */
export interface ProjectType { id: string; name: string; blueprintId?: string | null; }
export interface BlueprintTask { id: string; name: string; percent: number; }
export interface BlueprintPhase { id: string; name: string; percent: number; tasks: BlueprintTask[]; }
export interface Blueprint { id: string; name: string; projectTypeId: string; phases: BlueprintPhase[]; }
export interface ClientRole { id: string; name: string; userIds: string[]; isSupervision: boolean; }

export const emptyAddress: Address = {
  street: "", number: "", details: "", postalCode: "", city: "", country: "",
};

/**
 * The per-day consultancy rate after discount.
 * - rate:    a fixed € amount knocked off the day price
 * - percent: a % knocked off the day price (900 @ 20% → 720)
 * - none/total: full price (total discounts the whole invoice, not the day)
 */
export function effectiveRate(pricePerDay: number, mode: string, value: number): number {
  if (mode === "rate") return Math.max(0, pricePerDay - value);
  if (mode === "percent") return Math.max(0, pricePerDay * (1 - value / 100));
  return pricePerDay;
}

/**
 * Supervision day rate after ITS OWN discount (independent from consultancy).
 * - rate:    a fixed € amount off the supervision day price
 * - percent: a % off the supervision day price
 * - none:    full supervision price
 */
export function effectiveSupervisionRate(supervisionPrice: number, mode: string, value: number): number {
  if (mode === "rate") return Math.max(0, supervisionPrice - value);
  if (mode === "percent") return Math.max(0, supervisionPrice * (1 - value / 100));
  return supervisionPrice;
}

export function projectValue(p: Project): number {
  const totalConsult = p.consultorDays + p.connectorDays;
  const rate = effectiveRate(p.pricePerDay, p.discountMode, p.discountValue);
  const supRate = effectiveSupervisionRate(p.supervisionPrice, p.supervisionDiscountMode, p.supervisionDiscountValue);
  const gross = totalConsult * rate + p.supervisionDays * supRate;
  return p.discountMode === "total" ? Math.max(0, gross - p.discountValue) : gross;
}

function ClientList({
  clients, projects, projectTypes, onNew, onOpen, onDelete, usage, units,
}: {
  clients: Client[];
  projects: Project[];
  projectTypes: ProjectType[];
  onNew: () => void;
  onOpen: (c: Client) => void;
  onDelete?: (c: Client, projectCount: number) => void;
  usage: Record<string, { planned: number; done: number }>;
  units: Record<string, "hour" | "day">;
}) {
  const [q, setQ] = useState("");
  const [fType, setFType] = useState("");
  const [fConsultant, setFConsultant] = useState("");
  const [sort, setSort] = useState("recent");

  // Resolve team member ids → names for the consultant filter.
  const [people, setPeople] = useState<Record<string, string>>({});
  useEffect(() => {
    supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(({ data }: any) => {
      const out: Record<string, string> = {};
      ((data?.users ?? []) as any[]).forEach((u) => {
        out[u.id] = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—";
      });
      setPeople(out);
    }).catch(() => {});
  }, []);
  const personName = (id: string, fb?: string) => people[id] || (fb && fb !== "—" ? fb : "") || "Unknown";

  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";
  const projOf = (c: Client) => projects.filter((p) => p.clientId === c.id);
  const clientValue = (c: Client) => projOf(c).reduce((s, p) => s + projectValue(p), 0);

  // Filter options derived from the data.
  const typeOptions = useMemo(() => {
    const ids = new Set<string>();
    projects.forEach((p) => { if (p.projectTypeId) ids.add(p.projectTypeId); });
    return Array.from(ids).map((id) => ({ value: id, label: typeName(id) })).sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, projectTypes]);
  const consultantOptions = useMemo(() => {
    const byId = new Map<string, string>();
    projects.forEach((p) => (p.team ?? []).forEach((m) => {
      if (m.userId && !byId.has(m.userId)) byId.set(m.userId, personName(m.userId, m.name));
    }));
    return Array.from(byId, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, people]);

  const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const shownClients = useMemo(() => {
    const needle = norm(q.trim());
    const list = clients.filter((c) => {
      const mine = projOf(c);
      if (fType && !mine.some((p) => p.projectTypeId === fType)) return false;
      if (fConsultant && !mine.some((p) => (p.team ?? []).some((m) => m.userId === fConsultant))) return false;
      if (needle) {
        const hay = norm([c.name, ...mine.map((p) => typeName(p.projectTypeId))].join(" "));
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    return list.sort((a, b) => {
      if (sort === "value") return clientValue(b) - clientValue(a);
      if (sort === "projects") return projOf(b).length - projOf(a).length;
      if (sort === "name") return a.name.localeCompare(b.name);
      return 0; // recent = keep incoming order
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, projects, q, fType, fConsultant, sort, people, projectTypes]);

  const anyFilter = !!(q || fType || fConsultant || sort !== "recent");
  const clearAll = () => { setQ(""); setFType(""); setFConsultant(""); setSort("recent"); };

  if (clients.length === 0) {
    return (
      <div className="cl-empty">
        <div className="cl-empty-badge" aria-hidden="true" />
        <h2>No clients yet</h2>
        <p>Create your first engagement to get started.</p>
        <button className="cl-primary" onClick={onNew}>+ New client</button>
      </div>
    );
  }

  // Days and hours are different units, so they are counted apart rather than
  // added into one meaningless figure. Reflects the active filters.
  const shownProjectIds = new Set(shownClients.flatMap((c) => projOf(c).map((p) => p.id)));
  const totals = shownClients.reduce((acc, c) => {
    const mine = projOf(c);
    acc.projects += mine.length;
    acc.value += mine.reduce((s, p) => s + projectValue(p), 0);
    mine.forEach((p) => {
      const signed = p.consultorDays + p.connectorDays + p.supervisionDays;
      if (units[p.projectTypeId] === "hour") acc.hours += signed; else acc.days += signed;
    });
    return acc;
  }, { projects: 0, value: 0, days: 0, hours: 0 });

  const signedAll = totals.days + totals.hours;
  // Usage keys look like "<projectId>|<line>", so only count usage of shown projects.
  const doneAll = Object.entries(usage).reduce((s, [k, u]) => {
    const pid = k.split("|")[0];
    return shownProjectIds.has(pid) ? s + u.done : s;
  }, 0);
  const deliveredPct = signedAll > 0 ? Math.round((doneAll / signedAll) * 100) : 0;

  return (
    <>
      <div className="pv-bar">
        <div className="pv-search">
          <span className="pv-search-ico" aria-hidden="true">⌕</span>
          <input className="pv-search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client, service…" />
          {q && <button className="pv-search-x" onClick={() => setQ("")} aria-label="Clear">×</button>}
        </div>
        <div className="pv-filter">
          <Select value={fType} onChange={setFType} placeholder="All services"
            options={[{ value: "", label: "All services" }, ...typeOptions]} />
        </div>
        <div className="pv-filter">
          <Select value={fConsultant} onChange={setFConsultant} placeholder="All consultants"
            options={[{ value: "", label: "All consultants" }, ...consultantOptions]} />
        </div>
        <div className="pv-filter">
          <Select value={sort} onChange={setSort}
            options={[
              { value: "recent", label: "Most recent" },
              { value: "value", label: "Highest value" },
              { value: "projects", label: "Most projects" },
              { value: "name", label: "Name A–Z" },
            ]} />
        </div>
        {anyFilter && <button className="pv-clear" onClick={clearAll}>Clear</button>}
      </div>

      <div className="cl-kpis">
        <div className="cl-kpi">
          <span className="cl-kpi-k">Clients</span>
          <b className="cl-kpi-v">{shownClients.length}</b>
          <span className="cl-kpi-sub">{totals.projects} projects running</span>
        </div>

        <div className="cl-kpi">
          <span className="cl-kpi-k">Signed</span>
          <b className="cl-kpi-v">
            {totals.days.toLocaleString()}<em>d</em>
            {totals.hours > 0 && <><span className="cl-kpi-plus">/</span>{totals.hours.toLocaleString()}<em>h</em></>}
          </b>
          <span className="cl-kpi-sub">committed to deliver</span>
        </div>

        <div className="cl-kpi">
          <span className="cl-kpi-k">Delivered</span>
          <b className="cl-kpi-v">{deliveredPct}<em>%</em></b>
          <span className="cl-kpi-meter"><i style={{ width: `${deliveredPct}%` }} /></span>
        </div>

        <div className="cl-kpi cl-kpi-money">
          <span className="cl-kpi-k">Contract value</span>
          <b className="cl-kpi-v">{Math.round(totals.value).toLocaleString()}<em>€</em></b>
          <span className="cl-kpi-sub">
            {totals.days + totals.hours > 0
              ? `${Math.round(totals.value / (totals.days + totals.hours / 8))} € per day`
              : "—"}
          </span>
        </div>
      </div>

      <div className="cl-scroll">
        {shownClients.length === 0 ? (
          <p className="cl-hint">No clients match those filters.</p>
        ) : (
        <div className="cl-list">
          {shownClients.map((c) => {
            const mine = projects.filter((p) => p.clientId === c.id);
            const total = mine.reduce((s, p) => s + projectValue(p), 0);
            const typeNames = [...new Set(
              mine.map((p) => projectTypes.find((t) => t.id === p.projectTypeId)?.name).filter(Boolean)
            )] as string[];
            const last = mine[mine.length - 1];
            const signed = mine.reduce((s, p) => s + p.consultorDays + p.connectorDays + p.supervisionDays, 0);
            const used = mine.reduce((s, p) => s + (usage[p.id]?.done ?? 0), 0);
            const pct = signed > 0 ? Math.min(100, Math.round((used / signed) * 100)) : 0;
            return (
              <div className="cl-row" key={c.id} role="button" tabIndex={0}
                onClick={() => onOpen(c)}
                onKeyDown={(e) => { if (e.key === "Enter") onOpen(c); }}>
                <span className="cl-row-glow" aria-hidden="true" />

                <span className="cl-c cl-c-name">
                  <span className="cl-av">{(c.name || "?").slice(0, 1).toUpperCase()}</span>
                  <span className="cl-name-txt">
                    <b>{c.name}</b>
                    <em>{typeNames.length > 0 ? typeNames.join(" · ") : "No service"}</em>
                  </span>
                </span>

                <span className="cl-c cl-c-meta">
                  <i className="cl-tag">{mine.length} {mine.length === 1 ? "project" : "projects"}</i>
                  {last?.address?.city && <i className="cl-tag cl-tag-soft">{last.address.city}</i>}
                  {(last?.contacts?.length ?? 0) > 0 && (
                    <i className="cl-tag cl-tag-soft">{last?.contacts?.length} contacts</i>
                  )}
                </span>

                <span className="cl-c cl-c-prog">
                  <span className="cl-pbar"><span className="cl-pbar-fill" style={{ width: `${pct}%` }} /></span>
                  <em>{pct}% delivered</em>
                </span>

                <span className="cl-c cl-r cl-total">
                  <b>{total > 0 ? `${Math.round(total).toLocaleString()} €` : "—"}</b>
                  <em>{signed > 0 ? `${signed.toFixed(2)} days signed` : "no days yet"}</em>
                </span>

                <span className="cl-c cl-c-go">
                  {onDelete && (
                    <button className="cl-row-del" aria-label={`Delete ${c.name}`} title="Delete client"
                      onClick={(e) => { e.stopPropagation(); onDelete(c, mine.length); }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
                    </button>
                  )}
                  <svg className="cl-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
                </span>
              </div>
            );
          })}
        </div>
        )}
      </div>
    </>
  );
}

export default function ClientsPage() {
  const { session, role } = useAuth();
  const [showForm, setShowForm] = useState(false);

  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectTypes, setProjectTypes] = useState<ProjectType[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [roles, setRoles] = useState<ClientRole[]>([]);

const [detailClient, setDetailClient] = useState<Client | null>(null);
const [usage, setUsage] = useState<Record<string, { planned: number; done: number }>>({});
  /** Rate unit per service, so signed figures never mix hours with days. */
  const [units, setUnits] = useState<Record<string, "hour" | "day">>({});
  useEffect(() => {
    supabase.from("services").select("id, rate_unit").then(({ data }) => {
      const out: Record<string, "hour" | "day"> = {};
      (data ?? []).forEach((r: any) => { out[r.id] = r.rate_unit === "hour" ? "hour" : "day"; });
      setUnits(out);
    });
  }, []);
  const [lineUsage, setLineUsage] = useState<Record<string, { done: number; booked: number }>>({});
  const [tab, setTab] = useState<"clients" | "projects">("clients");
  const [editing, setEditing] = useState<{ client: Client | null; project: Project | null } | null>(null);
  // A deal handed over from sales: opens the form pre-filled instead of blank.
  const location = useLocation();
  const navigate = useNavigate();
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [pendingCompanyId, setPendingCompanyId] = useState<string | null>(null);
  const [soldSummary, setSoldSummary] = useState<any | null>(null);

  /**
   * A handoff arrives through the router. Park it first, then build the form
   * once the catalogue has loaded - clearing the navigation state before the
   * services were ready is what stopped the service from being pre-selected.
   */
  const [pendingHandoff, setPendingHandoff] = useState<any | null>(null);

  useEffect(() => {
    const h = (location.state as any)?.handoff;
    if (!h) return;
    setPendingHandoff(h);
    setSoldSummary({
      company: h.clientName, pipeline: h.destPipelineName,
      services: h.services ?? [], total: h.potentialValue ?? 0,
    });
    setHandoffId(h.handoffId ?? null);
    setPendingCompanyId(h.companyId ?? null);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  useEffect(() => {
    const h = pendingHandoff;
    if (!h || projectTypes.length === 0) return;
    const co = h.company ?? {};
    // Only the service lines drive days and rate: a licence has no days and
    // would skew the price per day.
    const all: any[] = h.services ?? [];
    const svcs = all.filter((x: any) => x.kind !== "product");
    const days = svcs.reduce((s, x) => s + (Number(x.days) || 0), 0);
    const money = svcs.reduce((s, x) => s + (Number(x.price) || 0), 0);

    // Match the service by what sales actually sold, then by the destination
    // pipeline name as a fallback.
    const soldLabels = svcs.map((x: any) => String(x.label ?? "").trim().toLowerCase());
    const dest = String(h.destPipelineName ?? "").toLowerCase();
    const pt = projectTypes.find((x) => soldLabels.includes(x.name.trim().toLowerCase()))
      ?? projectTypes.find((x) => {
        const n = x.name.toLowerCase();
        return n.length > 3 && (dest.includes(n) || n.includes(dest));
      })
      ?? projectTypes.find((x) => {
        // Last resort: share a significant word, e.g. "Consolidation".
        const words = x.name.toLowerCase().split(/\s+/).filter((w) => w.length > 5);
        return words.some((w) => dest.includes(w) || soldLabels.some((l) => l.includes(w)));
      });

    const bp = pt?.blueprintId ? blueprints.find((b) => b.id === pt.blueprintId) : undefined;
    const bpPhases = (bp?.phases ?? []).map((ph: any) => ({
      id: crypto.randomUUID(),
      name: ph.name,
      days: Math.round((days * (Number(ph.percent) || 0)) / 100 * 100) / 100,
      tasks: (ph.tasks ?? []).map((tk: any) => ({ id: crypto.randomUUID(), name: tk.name })),
    }));

    setEditing({
      client: { id: h.clientId ?? crypto.randomUUID(), name: h.clientName ?? "New client" },
      project: {
        id: crypto.randomUUID(),
        clientId: h.clientId ?? "",
        legalName: co.legal_name ?? "",
        vatNumber: co.vat_number ?? "",
        address: {
          street: co.street ?? "", number: co.addr_number ?? "", details: co.addr_details ?? "",
          postalCode: co.postal_code ?? "", city: co.city ?? "", country: co.country ?? "",
        },
        contacts: (h.contacts ?? []).map((c: any) => ({
          id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" "),
          position: c.position ?? "", email: c.email ?? "", phone: c.phone ?? "",
          billing: !!c.is_billing,
        })),
        projectTypeId: pt?.id ?? "",
        kickoffDate: "", signingDate: "",
        consultorDays: days,
        connectorDays: 0,
        pricePerDay: days > 0 ? Math.round(money / days) : 0,
        supervisionDays: 0, supervisionPrice: 0,
        taxed: false, taxRate: 0, paymentDays: 0,
        discountMode: "none", discountValue: 0,
        supervisionDiscountMode: "none", supervisionDiscountValue: 0,
        phases: bpPhases, team: [], status: "open", endDate: "",
      },
    });
    setPendingHandoff(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHandoff, projectTypes, blueprints]);

  const mapProject = (r: any): Project => ({
id: r.id,
    clientId: r.client_id,
    legalName: r.legal_name ?? "",
    vatNumber: r.vat_number ?? "",
    address: r.address ?? { ...emptyAddress },
    contacts: r.contacts ?? [],
    projectTypeId: r.service_id ?? r.project_type_id ?? "",
    kickoffDate: r.kickoff_date ?? "",
    signingDate: r.signing_date ?? "",
    consultorDays: Number(r.consultor_days) || 0,
    connectorDays: Number(r.connector_days) || 0,
    pricePerDay: Number(r.price_per_day) || 0,
    supervisionDays: Number(r.supervision_days) || 0,
    supervisionPrice: Number(r.supervision_price) || 0,
    taxed: !!r.taxed,
    taxRate: Number(r.tax_rate) || 0,
    paymentDays: Number(r.payment_days) || 0,
    discountMode: (r.discount_mode ?? "none") as "none" | "rate" | "total",
    discountValue: Number(r.discount_value) || 0,
    supervisionDiscountMode: (r.supervision_discount_mode ?? "none") as "none" | "rate" | "percent",
    supervisionDiscountValue: Number(r.supervision_discount_value) || 0,
    phases: r.phases ?? [],
    team: r.team ?? [],
status: r.status ?? "open",
    endDate: r.end_date ?? "",
  });

  const loadAll = async () => {
    const { data: pts } = await supabase.from("services").select("id,name,blueprint_id,active").order("name");
    setProjectTypes((pts ?? []).filter((r: any) => r.active !== false)
      .map((r: any) => ({ id: r.id, name: r.name, blueprintId: r.blueprint_id ?? null })));

    const { data: bps } = await supabase.from("phase_blueprints").select("*");
    setBlueprints((bps ?? []).map((r: any) => ({
      id: r.id, name: r.name ?? "", projectTypeId: r.service_id ?? r.project_type_id ?? "", phases: r.phases ?? [],
    })));

    const { data: rls } = await supabase.from("client_roles").select("*");
  setRoles((rls ?? []).map((r: any) => ({
      id: r.id, name: r.name ?? "", userIds: r.user_ids ?? [], isSupervision: !!r.is_supervision,
    })));

const seesAll = roleSeesAll(role);
    const myId = session?.user?.id ?? "";

    const { data: pjs } = await supabase.from("projects").select("*").order("created_at");
    const allProjects = (pjs ?? []).map(mapProject);
    // A consultant only sees projects they're assigned to (on the team).
    const visibleProjects = seesAll
      ? allProjects
      : allProjects.filter((p: any) => (p.team ?? []).some((m: any) => m.userId === myId));
    setProjects(visibleProjects);
    const allowedClients = new Set(visibleProjects.map((p: any) => p.clientId));

    const { data: cls } = await supabase.from("clients").select("*").order("name");
    setClients((cls ?? [])
      .map((r: any) => ({ id: r.id, name: r.name ?? "" }))
      .filter((c: any) => seesAll || allowedClients.has(c.id)));

    // Usage comes pre-aggregated from the project_usage view. Fetching raw
    // calendar_entries here used to silently truncate at PostgREST's 1000-row
    // cap, which made most clients read 0% delivered.
    const { data: pu, error: puErr } = await supabase
      .from("project_usage")
      .select("project_id, billing_line, done, booked");
    if (puErr) console.error("project_usage load failed", puErr);

    const agg: Record<string, { planned: number; done: number }> = {};
    const byLine: Record<string, { done: number; booked: number }> = {};
    ((pu ?? []) as any[]).forEach((r) => {
      const pid = r.project_id as string | null;
      if (!pid) return;
      const done = Number(r.done) || 0;
      const booked = Number(r.booked) || 0;
      const ln = (r.billing_line as string) || "consultor";

      if (!agg[pid]) agg[pid] = { planned: 0, done: 0 };
      agg[pid].done += done;
      agg[pid].planned += booked;

      const k = `${pid}|${ln}`;
      if (!byLine[k]) byLine[k] = { done: 0, booked: 0 };
      byLine[k].done += done;
      byLine[k].booked += booked;
    });
    setUsage(agg);
    setLineUsage(byLine);
  };

  useEffect(() => { loadAll(); }, []);

  /** Saves a client row and one project row. */
  const saveClientProject = async (c: Client, p: Project) => {
const companyId = (location.state as any)?.handoff?.companyId ?? pendingCompanyId;
    const clientRow: any = { id: c.id, name: c.name };
    if (companyId) clientRow.company_id = companyId;
    const { error: cErr } = await supabase.from("clients").upsert(clientRow);
    if (cErr) { alert(`Could not save client: ${cErr.message}`); return; }

    const { error: pErr } = await supabase.from("projects").upsert({
id: p.id,
      client_id: c.id,
      legal_name: p.legalName || null,
      vat_number: p.vatNumber || null,
      address: p.address,
      contacts: p.contacts,
      service_id: p.projectTypeId || null,
      kickoff_date: p.kickoffDate || null,
      signing_date: p.signingDate || null,
      consultor_days: p.consultorDays,
      connector_days: p.connectorDays,
      price_per_day: p.pricePerDay,
      supervision_days: p.supervisionDays,
      supervision_price: p.supervisionPrice,
      taxed: p.taxed,
      tax_rate: p.taxRate,
      payment_days: p.paymentDays,
      discount_mode: p.discountMode,
      discount_value: p.discountValue,
      supervision_discount_mode: p.supervisionDiscountMode,
      supervision_discount_value: p.supervisionDiscountValue,
      phases: p.phases,
      team: p.team,
status: p.status || "open",
      end_date: p.endDate || null,
    });
    if (pErr) { alert(`Could not save project: ${pErr.message}`); return; }

    // Close the loop with sales: the deal is no longer waiting in Incoming.
    if (handoffId) {
      await markHandoffConverted(handoffId, c.id, p.id).catch(() => {});
      setHandoffId(null);
      setPendingCompanyId(null);
    }

    await loadAll();
    setShowForm(false);
    setEditing(null);
    setDetailClient((d) => (d && d.id === c.id ? c : d));
  };

  /**
   * Deleting a client cascades to its projects in the database, so the
   * confirmation is sized to the damage: a plain confirm when there is nothing
   * to lose, and typing the client name when there are projects behind it.
   */
  const [deleteTarget, setDeleteTarget] = useState<{ client: Client; count: number } | null>(null);
  const [deleteTyped, setDeleteTyped] = useState("");
  const [deleteImpact, setDeleteImpact] = useState<{ invoices: number; entries: number } | null>(null);

  const askDeleteClient = async (c: Client, count: number) => {
    setDeleteTyped("");
    setDeleteImpact(null);
    setDeleteTarget({ client: c, count });
    // Count what goes with it before asking, so the warning is specific.
    const { data: ps } = await supabase.from("projects").select("id").eq("client_id", c.id);
    const ids = (ps ?? []).map((x: any) => x.id);
    if (!ids.length) { setDeleteImpact({ invoices: 0, entries: 0 }); return; }
    const inv = await supabase.from("invoices").select("id", { count: "exact", head: true }).in("project_id", ids);
    const ent = await supabase.from("calendar_entries").select("id", { count: "exact", head: true }).in("project_id", ids);
    setDeleteImpact({ invoices: inv.count ?? 0, entries: ent.count ?? 0 });
  };

  const doDeleteClient = async () => {
    if (!deleteTarget) return;
    const { error } = await supabase.from("clients").delete().eq("id", deleteTarget.client.id);
    if (error) { alert(`Could not delete client: ${error.message}`); return; }
    setDeleteTarget(null);
    setDetailClient((d) => (d && d.id === deleteTarget.client.id ? null : d));
    await loadAll();
  };

  const deleteProject = async (id: string) => {
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) { alert(`Could not delete: ${error.message}`); return; }
    await loadAll();
  };

const setProjectStatus = async (p: Project, status: string, endDate: string | null) => {
    const { error } = await supabase
      .from("projects")
      .update({ status, end_date: endDate })
      .eq("id", p.id);
    if (error) { alert(`Could not update project: ${error.message}`); return; }
    await loadAll();
  };

  const openNewProject = (c: Client) => {
    const mine = projects.filter((p) => p.clientId === c.id);
    const last = mine[mine.length - 1];
    const blank: Project = {
      id: crypto.randomUUID(),
clientId: c.id,
      legalName: last?.legalName ?? "",
      vatNumber: last?.vatNumber ?? "",
      address: last?.address ?? { ...emptyAddress },
      contacts: last?.contacts ?? [],
      projectTypeId: "",
      kickoffDate: "",
      signingDate: "",
consultorDays: 0,
      connectorDays: 0,
      pricePerDay: 0,
      supervisionDays: 0,
      supervisionPrice: 0,
      taxed: false,
      taxRate: 0,
      paymentDays: 0,
      discountMode: "none",
      discountValue: 0,
      supervisionDiscountMode: "none",
      supervisionDiscountValue: 0,
      phases: [],
      team: [],
status: "open",
      endDate: "",
    };
    setEditing({ client: c, project: blank });
  };

  return (
    <div className="cl">
      <header className="cl-bar">
        <div className="cl-bar-left">
          <h1 className="cl-title">Clients</h1>
          <div className="cl-tabbar" data-tab={tab}>
            <span className="cl-tab-slider" />
            <button className={tab === "clients" ? "is-on" : ""} onClick={() => setTab("clients")}>Clients</button>
            <button className={tab === "projects" ? "is-on" : ""} onClick={() => setTab("projects")}>Projects</button>
          </div>
        </div>
        <div className="cl-actions">
          <button className="cl-primary" onClick={() => setShowForm(true)}>+ New client</button>
        </div>
      </header>

      {tab === "clients" ? (
        <ClientList
          clients={clients}
          projects={projects}
          projectTypes={projectTypes}
          onNew={() => setShowForm(true)}
          onOpen={(c) => setDetailClient(c)}
          onDelete={askDeleteClient}
          usage={usage}
          units={units}
        />
      ) : (
<ProjectsView
          clients={clients}
          projects={projects}
          projectTypes={projectTypes}
          usage={lineUsage}
          onOpenProject={(c, p) => setEditing({ client: c, project: p })}
          onReopen={(p) => setProjectStatus(p, "open", null)}
          onClose_={(p) => {
            const d = prompt("End date (YYYY-MM-DD):", new Date().toISOString().slice(0, 10));
            if (d) setProjectStatus(p, "closed", d);
          }}
        />
      )}

      {detailClient && (
        <ClientWorkspace
          client={detailClient}
          projects={projects.filter((p) => p.clientId === detailClient.id)}
projectTypes={projectTypes}
          usage={usage}
          onOpenProject={(p) => setEditing({ client: detailClient, project: p })}
          onNewProject={() => openNewProject(detailClient)}
          onDeleteProject={deleteProject}
          onClose={() => setDetailClient(null)}
        />
      )}

      {showForm && (
        <NewClientForm
          onSave={saveClientProject}
          onClose={() => setShowForm(false)}
          roles={roles}
          projectTypes={projectTypes}
          blueprints={blueprints}
        />
      )}

      {editing && (
        <NewClientForm
          key={editing.project?.id ?? editing.client?.id}
          client={editing.client}
          project={editing.project}
          onSave={saveClientProject}
          onClose={() => { setEditing(null); setPendingHandoff(null); }}
          roles={roles}
          projectTypes={projectTypes}
          blueprints={blueprints}
          soldFrom={handoffId ? soldSummary : null}
        />
      )}

      {deleteTarget && (
        <div className="cl-del-backdrop" onMouseDown={() => setDeleteTarget(null)}>
          <div className="cl-del" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="cl-del-title">Delete {deleteTarget.client.name}?</h3>
            {deleteTarget.count === 0 ? (
              <p className="cl-del-text">This client has no projects. Deleting it cannot be undone.</p>
            ) : (
              <>
                <p className="cl-del-text">
                  This permanently deletes <b>{deleteTarget.count} project{deleteTarget.count === 1 ? "" : "s"}</b>
                  {deleteImpact === null ? " and everything invoiced against them"
                    : deleteImpact.invoices > 0
                      ? <> and <b>{deleteImpact.invoices} invoice{deleteImpact.invoices === 1 ? "" : "s"}</b></>
                      : " (no invoices yet)"}. This cannot be undone.
                </p>
                {deleteImpact !== null && deleteImpact.entries > 0 && (
                  <p className="cl-del-note">
                    {deleteImpact.entries} logged calendar {deleteImpact.entries === 1 ? "entry" : "entries"} will be
                    kept but left without a project, so they stop counting towards backlog and bonus.
                  </p>
                )}
                <label className="cl-del-confirm">
                  <span>Type <b>{deleteTarget.client.name}</b> to confirm</span>
                  <input value={deleteTyped} autoFocus onChange={(e) => setDeleteTyped(e.target.value)} />
                </label>
              </>
            )}
            <div className="cl-del-actions">
              <button className="cl-del-cancel" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="cl-del-go"
                disabled={deleteTarget.count > 0 && deleteTyped.trim() !== deleteTarget.client.name}
                onClick={doDeleteClient}>Delete client</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}