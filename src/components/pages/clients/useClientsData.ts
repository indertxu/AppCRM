/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import { markHandoffConverted } from "../sales/salesApi";
import { roleSeesAll } from "../companies/companiesApi";
import {
  emptyAddress,
  type Client, type Project, type ProjectType, type Blueprint, type ClientRole,
} from "./clientsTypes";

/**
 * Everything the Clients and Projects pages share: the data (clients, projects,
 * services, blueprints, roles, usage, units), the sales handoff flow, and the
 * save / delete / status mutations. Both pages call this so neither owns a copy.
 */
export function useClientsData() {
  const { session, role } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectTypes, setProjectTypes] = useState<ProjectType[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [roles, setRoles] = useState<ClientRole[]>([]);
  const [usage, setUsage] = useState<Record<string, { planned: number; done: number }>>({});
  const [lineUsage, setLineUsage] = useState<Record<string, { done: number; booked: number }>>({});
  const [units, setUnits] = useState<Record<string, "hour" | "day">>({});

  const [showForm, setShowForm] = useState(false);
  const [detailClient, setDetailClient] = useState<Client | null>(null);
  const [editing, setEditing] = useState<{ client: Client | null; project: Project | null } | null>(null);

  // Sales handoff (a sold deal arriving through the router).
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [pendingCompanyId, setPendingCompanyId] = useState<string | null>(null);
  const [soldSummary, setSoldSummary] = useState<any | null>(null);
  const [pendingHandoff, setPendingHandoff] = useState<any | null>(null);

  useEffect(() => {
    supabase.from("services").select("id, rate_unit").then(({ data }) => {
      const out: Record<string, "hour" | "day"> = {};
      (data ?? []).forEach((r: any) => { out[r.id] = r.rate_unit === "hour" ? "hour" : "day"; });
      setUnits(out);
    });
  }, []);

  /**
   * A handoff arrives through the router. Park it first, then build the form
   * once the catalogue has loaded — clearing navigation state before the
   * services were ready is what stopped the service from being pre-selected.
   */
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
    const all: any[] = h.services ?? [];
    const svcs = all.filter((x: any) => x.kind !== "product");
    const days = svcs.reduce((s, x) => s + (Number(x.days) || 0), 0);
    const money = svcs.reduce((s, x) => s + (Number(x.price) || 0), 0);

    const soldLabels = svcs.map((x: any) => String(x.label ?? "").trim().toLowerCase());
    const dest = String(h.destPipelineName ?? "").toLowerCase();
    const pt = projectTypes.find((x) => soldLabels.includes(x.name.trim().toLowerCase()))
      ?? projectTypes.find((x) => {
        const n = x.name.toLowerCase();
        return n.length > 3 && (dest.includes(n) || n.includes(dest));
      })
      ?? projectTypes.find((x) => {
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
    const visibleProjects = seesAll
      ? allProjects
      : allProjects.filter((p: any) => (p.team ?? []).some((m: any) => m.userId === myId));
    setProjects(visibleProjects);
    const allowedClients = new Set(visibleProjects.map((p: any) => p.clientId));

    const { data: cls } = await supabase.from("clients").select("*").order("name");
    setClients((cls ?? [])
      .map((r: any) => ({ id: r.id, name: r.name ?? "" }))
      .filter((c: any) => seesAll || allowedClients.has(c.id)));

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

  const deleteProject = async (id: string) => {
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) { alert(`Could not delete: ${error.message}`); return; }
    await loadAll();
  };

  const setProjectStatus = async (p: Project, status: string, endDate: string | null) => {
    const { error } = await supabase.from("projects").update({ status, end_date: endDate }).eq("id", p.id);
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
      kickoffDate: "", signingDate: "",
      consultorDays: 0, connectorDays: 0, pricePerDay: 0,
      supervisionDays: 0, supervisionPrice: 0,
      taxed: false, taxRate: 0, paymentDays: 0,
      discountMode: "none", discountValue: 0,
      supervisionDiscountMode: "none", supervisionDiscountValue: 0,
      phases: [], team: [], status: "open", endDate: "",
    };
    setEditing({ client: c, project: blank });
  };

  return {
    // data
    clients, projects, projectTypes, blueprints, roles, usage, lineUsage, units,
    // ui state
    showForm, setShowForm, detailClient, setDetailClient, editing, setEditing,
    // handoff
    handoffId, soldSummary,
    // actions
    loadAll, saveClientProject, deleteProject, setProjectStatus, openNewProject,
  };
}

export type ClientsData = ReturnType<typeof useClientsData>;