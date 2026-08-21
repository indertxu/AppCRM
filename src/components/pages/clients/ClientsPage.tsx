/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect } from "react";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import NewClientForm from "./NewClientForm";
import ClientSettingsModal from "./ClientSettingsModal";
import ClientDetailModal from "./ClientDetailModal";
import ProjectsView from "./ProjectsView";
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

export interface ProjectType { id: string; name: string; }
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
  clients, projects, projectTypes, onNew, onOpen,
}: {
  clients: Client[];
  projects: Project[];
  projectTypes: ProjectType[];
  onNew: () => void;
  onOpen: (c: Client) => void;
}) {
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

  return (
    <div className="cl-grid">
      {clients.map((c) => {
        const mine = projects.filter((p) => p.clientId === c.id);
        const total = mine.reduce((s, p) => s + projectValue(p), 0);
        const typeNames = [...new Set(
          mine.map((p) => projectTypes.find((t) => t.id === p.projectTypeId)?.name).filter(Boolean)
        )] as string[];
        return (
          <div className="cl-card cl-card-click" key={c.id} onClick={() => onOpen(c)}>
            <div className="cl-card-top">
              <h3>{c.name}</h3>
              <span className="cl-chip cl-status">Open</span>
            </div>
            <dl className="cl-meta">
              <div><dt>Projects</dt><dd>{mine.length}</dd></div>
<div><dt>City</dt><dd>{mine[mine.length - 1]?.address?.city || "—"}</dd></div>
              <div><dt>Contacts</dt><dd>{mine[mine.length - 1]?.contacts?.length ?? 0}</dd></div>
              <div><dt>VAT</dt><dd>{mine[mine.length - 1]?.vatNumber || "—"}</dd></div>
            </dl>
            <div className="cl-card-foot">
              <span>{typeNames.length > 0 ? typeNames.join(" · ") : "No project type"}</span>
              {total > 0 && <span className="cl-value">{total.toLocaleString()} total</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ClientsPage() {
  const { session, role } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectTypes, setProjectTypes] = useState<ProjectType[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [roles, setRoles] = useState<ClientRole[]>([]);

const [detailClient, setDetailClient] = useState<Client | null>(null);
const [usage, setUsage] = useState<Record<string, { planned: number; done: number }>>({});
  const [lineUsage, setLineUsage] = useState<Record<string, { done: number; booked: number }>>({});
  const [tab, setTab] = useState<"clients" | "projects">("clients");
  const [editing, setEditing] = useState<{ client: Client | null; project: Project | null } | null>(null);

  const mapProject = (r: any): Project => ({
id: r.id,
    clientId: r.client_id,
    legalName: r.legal_name ?? "",
    vatNumber: r.vat_number ?? "",
    address: r.address ?? { ...emptyAddress },
    contacts: r.contacts ?? [],
    projectTypeId: r.project_type_id ?? "",
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
    const { data: pts } = await supabase.from("project_types").select("*").order("name");
    setProjectTypes((pts ?? []).map((r: any) => ({ id: r.id, name: r.name })));

    const { data: bps } = await supabase.from("phase_blueprints").select("*");
    setBlueprints((bps ?? []).map((r: any) => ({
      id: r.id, name: r.name ?? "", projectTypeId: r.project_type_id ?? "", phases: r.phases ?? [],
    })));

    const { data: rls } = await supabase.from("client_roles").select("*");
  setRoles((rls ?? []).map((r: any) => ({
      id: r.id, name: r.name ?? "", userIds: r.user_ids ?? [], isSupervision: !!r.is_supervision,
    })));

    const seesAll = role === "boss" || role === "consultancy_manager" || role === "customer_success";
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

    const { data: ce } = await supabase
      .from("calendar_entries")
.select("id, project_id, billable, status, billing_line");
    const { data: ea } = await supabase.from("entry_actuals").select("entry_id, actual_billable");
    const actualMap: Record<string, number> = Object.fromEntries(
      ((ea ?? []) as any[]).map((r) => [r.entry_id as string, Number(r.actual_billable) || 0])
    );
    const agg: Record<string, { planned: number; done: number }> = {};
    const byLine: Record<string, { done: number; booked: number }> = {};
    ((ce ?? []) as any[]).forEach((r) => {
      const pid = r.project_id as string | null;
      if (!pid || r.status === "cancelled") return;
      const v = actualMap[r.id as string] ?? (Number(r.billable) || 0);
      const ln = (r.billing_line as string) || "consultor";
      if (ln === "closure") return;

      if (!agg[pid]) agg[pid] = { planned: 0, done: 0 };
      if (r.status === "confirmed") agg[pid].done += v;
      else agg[pid].planned += v;

      const k = `${pid}|${ln}`;
      if (!byLine[k]) byLine[k] = { done: 0, booked: 0 };
      if (r.status === "confirmed") byLine[k].done += v;
      else byLine[k].booked += v;
    });
    setUsage(agg);
    setLineUsage(byLine);
  };

  useEffect(() => { loadAll(); }, []);

  const syncSettings = async () => {
    const { data: exT } = await supabase.from("project_types").select("id");
    const keepT = new Set(projectTypes.map((t) => t.id));
    const delT = (exT ?? []).filter((r: any) => !keepT.has(r.id)).map((r: any) => r.id);
    if (delT.length) await supabase.from("project_types").delete().in("id", delT);
    if (projectTypes.length)
      await supabase.from("project_types").upsert(projectTypes.map((t) => ({ id: t.id, name: t.name })));

    const { data: exB } = await supabase.from("phase_blueprints").select("id");
    const keepB = new Set(blueprints.map((b) => b.id));
    const delB = (exB ?? []).filter((r: any) => !keepB.has(r.id)).map((r: any) => r.id);
    if (delB.length) await supabase.from("phase_blueprints").delete().in("id", delB);
    if (blueprints.length)
      await supabase.from("phase_blueprints").upsert(blueprints.map((b) => ({
        id: b.id, name: b.name, project_type_id: b.projectTypeId || null, phases: b.phases,
      })));

    const { data: exR } = await supabase.from("client_roles").select("id");
    const keepR = new Set(roles.map((r) => r.id));
    const delR = (exR ?? []).filter((r: any) => !keepR.has(r.id)).map((r: any) => r.id);
    if (delR.length) await supabase.from("client_roles").delete().in("id", delR);
    if (roles.length)
await supabase.from("client_roles").upsert(roles.map((r) => ({
        id: r.id, name: r.name, user_ids: r.userIds, is_supervision: r.isSupervision,
      })));
  };

  const closeSettings = async () => {
    await syncSettings();
    setShowSettings(false);
  };

  /** Saves a client row and one project row. */
  const saveClientProject = async (c: Client, p: Project) => {
const { error: cErr } = await supabase.from("clients").upsert({ id: c.id, name: c.name });
    if (cErr) { alert(`Could not save client: ${cErr.message}`); return; }

    const { error: pErr } = await supabase.from("projects").upsert({
id: p.id,
      client_id: c.id,
      legal_name: p.legalName || null,
      vat_number: p.vatNumber || null,
      address: p.address,
      contacts: p.contacts,
      project_type_id: p.projectTypeId || null,
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

    await loadAll();
    setShowForm(false);
    setEditing(null);
    setDetailClient((d) => (d && d.id === c.id ? c : d));
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
        <div>
          <h1 className="cl-title">Clients</h1>
          <p className="cl-sub">Manage engagements and their teams</p>
        </div>
        <div className="cl-actions">
          <button className="cl-ghost cl-icon-btn" onClick={() => setShowSettings(true)} aria-label="Client settings" title="Client settings">
            <span style={{ fontSize: 18, lineHeight: 1 }}>⚙</span>
          </button>
          <button className="cl-primary" onClick={() => setShowForm(true)}>+ New client</button>
        </div>
      </header>

{tab === "clients" && (
        <div className="cl-tabbar" data-tab={tab}>
          <span className="cl-tab-slider" />
          <button className={tab === "clients" ? "is-on" : ""} onClick={() => setTab("clients")}>Clients</button>
          <button className={tab === "projects" ? "is-on" : ""} onClick={() => setTab("projects")}>Projects</button>
        </div>
      )}
      {tab === "clients" ? (
        <ClientList
          clients={clients}
          projects={projects}
          projectTypes={projectTypes}
          onNew={() => setShowForm(true)}
          onOpen={(c) => setDetailClient(c)}
        />
      ) : (
<ProjectsView
          tabs={
            <div className="cl-tabbar" data-tab={tab}>
              <span className="cl-tab-slider" />
              <button className={tab === "clients" ? "is-on" : ""} onClick={() => setTab("clients")}>Clients</button>
              <button className={tab === "projects" ? "is-on" : ""} onClick={() => setTab("projects")}>Projects</button>
            </div>
          }
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
        <ClientDetailModal
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
          onClose={() => setEditing(null)}
          roles={roles}
          projectTypes={projectTypes}
          blueprints={blueprints}
        />
      )}

      {showSettings && (
        <ClientSettingsModal
          projectTypes={projectTypes}
          setProjectTypes={setProjectTypes}
          blueprints={blueprints}
          setBlueprints={setBlueprints}
          roles={roles}
          setRoles={setRoles}
          onClose={closeSettings}
        />
      )}
    </div>
  );
}