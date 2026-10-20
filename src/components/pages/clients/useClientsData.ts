/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import { markHandoffConverted } from "../sales/sales/salesApi";
import { roleSeesAll, saveCompany, saveContact } from "../companies/companiesApi";
import {
  emptyAddress, mapClientRole, sortRoles, parseRoleLines, legacyRoleMap, resolveRoleKey, legacyColumnsOf,
  type Client, type Project, type ProjectType, type Blueprint, type ClientRole, type RoleLine,
} from "./clientsTypes";

const crmKey = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim()
  .replace(/\s(s\s?l\s?u?|s\s?a\s?u?|slp|sll|sccl|scp|cb|ab|gmbh|ltd|llc|inc|bv|srl|spa|sas|sarl|plc|ag|nv)$/, "").trim();
const vatKey = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * A client is also a company in the CRM, and the people on its projects are
 * contacts there. Finds (or creates) the company, links the client to it, and
 * adds any project contact that is not in Contacts yet, linked to that company.
 * Never blocks saving the client: problems are only logged.
 */
async function syncClientToCrm(clientId: string, clientName: string, p: Project, knownCompanyId: string | null) {
  try {
    let coId = knownCompanyId;
    if (!coId) {
      const { data: cl } = await supabase.from("clients").select("company_id").eq("id", clientId).maybeSingle();
      coId = (cl as any)?.company_id ?? null;
    }
    if (!coId) {
      const { data: cos } = await supabase.from("companies").select("id, name, legal_name, vat_number");
      const list = (cos ?? []) as any[];
      const vat = vatKey(p.vatNumber);
      const names = [crmKey(clientName), crmKey(p.legalName)].filter(Boolean);
      const hit = (vat && list.find((c) => vatKey(c.vat_number) === vat))
        || list.find((c) => names.includes(crmKey(c.name)) || (c.legal_name && names.includes(crmKey(c.legal_name))));
      if (hit) coId = hit.id;
      else {
        const a: any = p.address ?? {};
        const co: any = {
          name: clientName.trim(), legal_name: p.legalName?.trim() || null, vat_number: p.vatNumber?.trim() || null,
          street: a.street || null, addr_number: a.number || null, addr_details: a.details || null,
          postal_code: a.postalCode || null, city: a.city || null, country: a.country || null,
          relationship: ["client"],
        };
        const err = await saveCompany(co);
        if (err) { console.warn("Client → company:", err); return; }
        coId = co.id ?? null;
      }
      if (coId) await supabase.from("clients").update({ company_id: coId }).eq("id", clientId);
    }
    if (!coId) return;
    // Fill what the company is missing from the project (never overwrite).
    const { data: cur } = await supabase.from("companies").select("legal_name, vat_number").eq("id", coId).maybeSingle();
    const fill: any = {};
    if (!(cur as any)?.legal_name && p.legalName?.trim()) fill.legal_name = p.legalName.trim();
    if (!(cur as any)?.vat_number && p.vatNumber?.trim()) fill.vat_number = p.vatNumber.trim();
    if (Object.keys(fill).length) await supabase.from("companies").update(fill).eq("id", coId);

    const people = (p.contacts ?? []).filter((ct) => (ct.name ?? "").trim() || (ct.email ?? "").trim());
    if (!people.length) return;
    const { data: all } = await supabase.from("contacts").select("id, first_name, last_name, email");
    const { data: links } = await supabase.from("company_contacts").select("contact_id").eq("company_id", coId);
    const linked = new Set(((links ?? []) as any[]).map((l) => l.contact_id));
    const rows = (all ?? []) as any[];
    for (const ct of people) {
      const email = (ct.email ?? "").trim().toLowerCase();
      const full = crmKey(ct.name);
      const hit = (email && rows.find((r) => (r.email ?? "").trim().toLowerCase() === email))
        || rows.find((r) => linked.has(r.id) && crmKey(`${r.first_name ?? ""} ${r.last_name ?? ""}`) === full);
      if (hit) {
        if (!linked.has(hit.id)) { await supabase.from("company_contacts").insert({ company_id: coId, contact_id: hit.id }); linked.add(hit.id); }
        continue;
      }
      const parts = (ct.name ?? "").trim().split(/\s+/);
      const first = parts.shift() || email.split("@")[0] || "Contact";
      const nc: any = {
        first_name: first, last_name: parts.join(" ") || null, email: ct.email?.trim() || null,
        phone: ct.phone?.trim() || null, position: ct.position?.trim() || null, is_billing: !!ct.billing,
        companyIds: [coId],
      };
      const err = await saveContact(nc);
      if (err) console.warn("Client contact → contacts:", err);
      else { rows.push({ id: nc.id, first_name: nc.first_name, last_name: nc.last_name, email: nc.email }); linked.add(nc.id); }
    }
  } catch (e) {
    console.warn("Could not sync client to CRM:", e);
  }
}

/**
 * Role lines for a project arriving from a sales handoff: the roles sales
 * priced (services[].roles), else every day on the service's main role.
 */
function handoffLines(svcs: any[], pt: ProjectType | undefined, days: number, money: number): RoleLine[] {
  const out: RoleLine[] = [];
  for (const s of svcs) {
    for (const r of (Array.isArray(s.roles) ? s.roles : []) as any[]) {
      if (!r?.roleId) continue;
      const same = out.find((x) => x.roleId === r.roleId);
      if (same) { same.days += Number(r.days) || 0; continue; }
      out.push({ roleId: String(r.roleId), days: Number(r.days) || 0, rate: Number(r.rate) || 0, discountMode: "none", discountValue: 0 });
    }
  }
  if (out.length) return out;
  const main = pt?.roles?.find((r) => r.isMain) ?? pt?.roles?.[0];
  return main ? [{ roleId: main.roleId, days, rate: days > 0 ? Math.round(money / days) : main.price, discountMode: "none", discountValue: 0 }] : [];
}

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
  /** True once the first load finished (the page shows its loading scene until then). */
  const [loaded, setLoaded] = useState(false);

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
        roleLines: handoffLines(svcs, pt, days, money),
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
    roleLines: parseRoleLines(r.role_lines),
    phases: r.phases ?? [],
    team: r.team ?? [],
    status: r.status ?? "open",
    endDate: r.end_date ?? "",
  });

  /**
   * Everything in one go, then one update: fetching in parallel and setting the
   * state together means the page draws once with all its numbers, instead of
   * appearing and then changing as each query lands.
   */
  const loadAll = async () => {
    const seesAll = roleSeesAll(role);
    const myId = session?.user?.id ?? "";
    const [{ data: pts }, { data: bps }, { data: rls }, { data: pjs }, { data: cls }, { data: pu, error: puErr }, { data: srs }] = await Promise.all([
      supabase.from("services").select("id,name,blueprint_id,active").order("name"),
      supabase.from("phase_blueprints").select("*"),
      supabase.from("client_roles").select("*"),
      supabase.from("projects").select("*").order("created_at"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("project_role_usage").select("project_id, role_key, done, booked"),
      supabase.from("service_roles").select("service_id, role_id, price, is_main, sort"),
    ]);
    if (puErr) console.error("project_role_usage load failed", puErr);
    const roleList = sortRoles(((rls ?? []) as any[]).map(mapClientRole));
    const legacy = legacyRoleMap(roleList);

    const allProjects = (pjs ?? []).map(mapProject);
    const visibleProjects = seesAll
      ? allProjects
      : allProjects.filter((p: any) => (p.team ?? []).some((m: any) => m.userId === myId));
    const allowedClients = new Set(visibleProjects.map((p: any) => p.clientId));

    const agg: Record<string, { planned: number; done: number }> = {};
    const byLine: Record<string, { done: number; booked: number }> = {};
    ((pu ?? []) as any[]).forEach((r) => {
      const pid = r.project_id as string | null;
      if (!pid) return;
      const done = Number(r.done) || 0;
      const booked = Number(r.booked) || 0;
      const ln = resolveRoleKey((r.role_key as string) || "consultor", legacy);
      if (!agg[pid]) agg[pid] = { planned: 0, done: 0 };
      agg[pid].done += done;
      agg[pid].planned += booked;
      const k = `${pid}|${ln}`;
      if (!byLine[k]) byLine[k] = { done: 0, booked: 0 };
      byLine[k].done += done;
      byLine[k].booked += booked;
    });

    const svcRoles = ((srs ?? []) as any[]).sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
    setProjectTypes((pts ?? []).filter((r: any) => r.active !== false)
      .map((r: any) => ({
        id: r.id, name: r.name, blueprintId: r.blueprint_id ?? null,
        roles: svcRoles.filter((x) => x.service_id === r.id && x.role_id)
          .map((x) => ({ roleId: x.role_id as string, price: Number(x.price) || 0, isMain: !!x.is_main })),
      })));
    setBlueprints((bps ?? []).map((r: any) => ({
      id: r.id, name: r.name ?? "", projectTypeId: r.service_id ?? r.project_type_id ?? "", phases: r.phases ?? [],
    })));
    setRoles(roleList);
    setProjects(visibleProjects);
    setClients((cls ?? [])
      .map((r: any) => ({ id: r.id, name: r.name ?? "" }))
      .filter((c: any) => seesAll || allowedClients.has(c.id)));
    setUsage(agg);
    setLineUsage(byLine);
    setLoaded(true);
  };

  useEffect(() => { loadAll().catch(() => {}).finally(() => setLoaded(true)); }, []);

  /** Saves a client row and one project row. */
  const saveClientProject = async (c0: Client, p0: Project) => {
    const companyId = (location.state as any)?.handoff?.companyId ?? pendingCompanyId;
    // A NEW client that already exists (same CRM company, or the same name — e.g. loaded for
    // consultancy before it was won in sales) gets the project instead of a second client.
    let c = c0, p = p0;
    const { data: own } = await supabase.from("clients").select("id").eq("id", c0.id).maybeSingle();
    if (!own) {
      const { data: all } = await supabase.from("clients").select("id, name, company_id");
      const list = (all ?? []) as any[];
      const twin = (companyId && list.find((x) => x.company_id === companyId))
        || list.find((x) => crmKey(x.name) && crmKey(x.name) === crmKey(c0.name) && (!companyId || !x.company_id || x.company_id === companyId));
      if (twin) { c = { ...c0, id: twin.id, name: twin.name || c0.name }; p = { ...p0, clientId: twin.id }; }
    }
    const isTwin = c.id !== c0.id;
    const clientRow: any = { id: c.id, name: c.name };
    if (companyId) clientRow.company_id = companyId;
    const { error: cErr } = isTwin
      // the existing client keeps its name; it only learns its company when it had none
      ? (companyId ? await supabase.from("clients").update({ company_id: companyId }).eq("id", c.id).is("company_id", null) : { error: null })
      : await supabase.from("clients").upsert(clientRow);
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
      ...(p.roleLines.length ? legacyColumnsOf(p.roleLines, roles) : {
        consultor_days: p.consultorDays, connector_days: p.connectorDays, price_per_day: p.pricePerDay,
        supervision_days: p.supervisionDays, supervision_price: p.supervisionPrice,
        supervision_discount_mode: p.supervisionDiscountMode, supervision_discount_value: p.supervisionDiscountValue,
      }),
      role_lines: p.roleLines,
      taxed: p.taxed,
      tax_rate: p.taxRate,
      payment_days: p.paymentDays,
      // per-role discounts live on the lines; only a "total" discount stays here
      discount_mode: !p.roleLines.length || p.discountMode === "total" ? p.discountMode : "none",
      discount_value: !p.roleLines.length || p.discountMode === "total" ? p.discountValue : 0,
      phases: p.phases,
      team: p.team,
      status: p.status || "open",
      end_date: p.endDate || null,
    });
    if (pErr) { alert(`Could not save project: ${pErr.message}`); return; }

    // Also in Companies and Contacts.
    await syncClientToCrm(c.id, c.name, p, companyId ?? null);

    if (handoffId) {
      await markHandoffConverted(handoffId, c.id, p.id).catch(() => {});
      setHandoffId(null);
      setPendingCompanyId(null);
    }

    await loadAll();
    setShowForm(false);
    setEditing(null);
    setDetailClient((d) => (d && (d.id === c.id || d.id === c0.id) ? c : d));
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
      roleLines: [],
      phases: [], team: [], status: "open", endDate: "",
    };
    setEditing({ client: c, project: blank });
  };

  return {
    // data
    clients, projects, projectTypes, blueprints, roles, usage, lineUsage, units, loaded,
    // ui state
    showForm, setShowForm, detailClient, setDetailClient, editing, setEditing,
    // handoff
    handoffId, soldSummary,
    // actions
    loadAll, saveClientProject, deleteProject, setProjectStatus, openNewProject,
  };
}

export type ClientsData = ReturnType<typeof useClientsData>;