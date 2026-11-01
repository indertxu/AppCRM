/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import { markHandoffConverted, createTracking } from "../sales/sales/salesApi";
import { roleSeesAll, saveCompany, saveContact } from "../companies/companiesApi";
import {
  emptyAddress, mapClientRole, sortRoles, parseRoleLines, legacyRoleMap, resolveRoleKey, legacyColumnsOf,
  type Client, type Project, type ProjectType, type Blueprint, type ClientRole, type RoleLine, parseHolds, holdsAfter, projectStatusOf, type HoldPeriod,
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
    holdPeriods: parseHolds(r.hold_periods),
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

  /** Writes status changes; when the database has no hold dates yet (58 not run) it saves the rest and says so once. */
  const holdsWarned = useRef(false);
  const writeProject = async (id: string, row: Record<string, unknown>) => {
    let res = await supabase.from("projects").update(row).eq("id", id).select("id");
    if (res.error && "hold_periods" in row && /hold_periods|column|schema cache/i.test(res.error.message)) {
      const { hold_periods: _skip, ...rest } = row; void _skip;
      res = Object.keys(rest).length ? await supabase.from("projects").update(rest).eq("id", id).select("id") : { data: [{ id }], error: null } as any;
      if (!res.error && !holdsWarned.current) {
        holdsWarned.current = true;
        alert("The hold dates weren't kept: run sql/58_project_hold_dates.sql in Supabase.");
      }
    }
    return res;
  };

  /** Open / on hold / closed. The list changes at once; the database follows (put back if it refuses).
   *  Going on hold opens a pause today; leaving it closes the pause (on the end date when closing). */
  const setProjectStatus = async (p: Project, status: string, endDate: string | null): Promise<boolean> => {
    const before = projects.find((x) => x.id === p.id);
    const today = new Date().toISOString().slice(0, 10);
    const from = projectStatusOf(before?.status ?? p.status), to = projectStatusOf(status);
    const holds = holdsAfter(before?.holdPeriods ?? p.holdPeriods, from, to, to === "closed" && endDate ? endDate : today);
    const holdsChanged = JSON.stringify(holds) !== JSON.stringify(before?.holdPeriods ?? p.holdPeriods ?? []);
    setProjects((cur) => cur.map((x) => (x.id === p.id ? { ...x, status, endDate: endDate ?? "", holdPeriods: holds } : x)));
    const { data, error } = await writeProject(p.id, { status, end_date: endDate, ...(holdsChanged ? { hold_periods: holds } : {}) });
    if (error || !data?.length) {
      if (before) setProjects((cur) => cur.map((x) => (x.id === p.id ? before : x)));
      const msg = error?.message ?? "you can't change this project";
      alert(/check constraint|violates/i.test(msg) && status === "on_hold"
        ? "On hold isn't allowed by the database yet. Run sql/57_project_on_hold.sql in Supabase, then try again."
        : `Could not update project: ${msg}`);
      return false;
    }
    return true;
  };
  /** The pauses as edited by hand in the project panel. */
  const setProjectHolds = async (p: Project, holds: HoldPeriod[]): Promise<boolean> => {
    const before = projects.find((x) => x.id === p.id);
    const clean = parseHolds(holds);
    setProjects((cur) => cur.map((x) => (x.id === p.id ? { ...x, holdPeriods: clean } : x)));
    const { data, error } = await supabase.from("projects").update({ hold_periods: clean }).eq("id", p.id).select("id");
    if (error || !data?.length) {
      if (before) setProjects((cur) => cur.map((x) => (x.id === p.id ? before : x)));
      alert(error && /hold_periods|column|schema cache/i.test(error.message)
        ? "Run sql/58_project_hold_dates.sql in Supabase to keep the hold dates."
        : `Could not save the hold dates: ${error?.message ?? "you can't change this project"}`);
      return false;
    }
    return true;
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
    clients, projects, projectTypes, blueprints, roles, usage, lineUsage, units, loaded, setProjectHolds,
    // ui state
    showForm, setShowForm, detailClient, setDetailClient, editing, setEditing,
    // handoff
    handoffId, soldSummary,
    // actions
    loadAll, saveClientProject, deleteProject, setProjectStatus, openNewProject,
  };
}

export type ClientsData = ReturnType<typeof useClientsData>;
/* ============================================================================
   Customer success (17_customer_success.sql): owners, cadence, health,
   upsells, QBRs, ARR base, revenue movements, automatic follow-ups.
   Every call tolerates the tables not being there yet (returns NEEDS_CS).
   ============================================================================ */
export const NEEDS_CS = "Run 17_customer_success.sql in Supabase to turn on customer success.";
const csMissing = (e: { message?: string } | null | undefined) => !!e && /relation|does not exist|schema cache|column/i.test(e.message ?? "");
const csErr = (e: { message?: string } | null | undefined) => (!e ? null : csMissing(e) ? NEEDS_CS : e.message ?? "Not saved.");

export type CsHealthStatus = "green" | "amber" | "red";
export const CS_REASONS: { key: string; label: string; tone: CsHealthStatus }[] = [
  { key: "healthy", label: "Healthy client", tone: "green" },
  { key: "champion_left", label: "Champion left", tone: "red" },
  { key: "low_usage", label: "Low usage", tone: "amber" },
  { key: "billing_issue", label: "Billing issue", tone: "amber" },
  { key: "unhappy", label: "Unhappy with the service", tone: "red" },
  { key: "competitor", label: "Talking to a competitor", tone: "red" },
  { key: "budget_cut", label: "Budget cut", tone: "amber" },
  { key: "merger", label: "Merger / reorganisation", tone: "amber" },
  { key: "other", label: "Other", tone: "amber" },
];
export const UPSELL_STATUSES: { key: CsUpsell["status"]; label: string }[] = [
  { key: "idea", label: "Idea" }, { key: "planned", label: "Planned" }, { key: "contacted", label: "Contacted" },
  { key: "proposal", label: "Proposal" }, { key: "won", label: "Won" }, { key: "lost", label: "Lost" },
];
export const SPICED = [
  { key: "s", label: "Situation" }, { key: "p", label: "Pain" }, { key: "i", label: "Impact" },
  { key: "c", label: "Critical event" }, { key: "e", label: "Decision criteria" }, { key: "d", label: "Decision process" },
] as const;

export interface CsOwner { id: string; client_id: string; profile_id: string; is_primary: boolean }
export interface CsHealth { client_id: string; status: CsHealthStatus; reason: string | null; note: string | null; updated_at: string; updated_by: string | null }
export interface CsUpsell {
  id: string; client_id: string; kind: "product" | "tier" | "service" | "other";
  product_id: string | null; tier_id: string | null; service_id: string | null;
  title: string; est_value: number; ideal_contact_date: string | null;
  status: "idea" | "planned" | "contacted" | "proposal" | "won" | "lost";
  owner_id: string | null; notes: string | null; deal_id: string | null; won_at: string | null;
  created_at: string; updated_at: string;
}
export interface CsQbr { id: string; client_id: string; meeting_date: string; spiced: Record<string, boolean>; status: "planned" | "done" | "cancelled"; notes: string | null; owner_id: string | null }
export interface ArrSnapshot { id: string; year: number; initial_arr: number; by_client: Record<string, number>; taken_at: string }
export interface RevenueEvent { id: string; client_id: string | null; event_date: string; kind: "expansion" | "contraction" | "churn"; amount: number; reason: string | null; upsell_id: string | null }
export type CsPriority = "high" | "medium" | "low";
export const CS_PRIORITIES: { key: CsPriority; label: string; days: number }[] = [
  { key: "high", label: "High", days: 14 }, { key: "medium", label: "Medium", days: 30 }, { key: "low", label: "Low", days: 60 },
];
export interface CsSettings { id: string | null; default_cadence_days: number; auto_tasks: boolean; priority_cadence: Record<CsPriority, number> }
export interface CsData {
  ready: boolean;
  owners: CsOwner[]; health: CsHealth[]; upsells: CsUpsell[]; qbrs: CsQbr[];
  snapshots: ArrSnapshot[]; events: RevenueEvent[]; settings: CsSettings;
  /** Each client's own cadence (days), when it has one. */
  cadence: Record<string, number>;
  /** Each client's contact priority, when it has one. */
  priority: Record<string, CsPriority>;
}
const num = (v: unknown) => Number(v) || 0;
const defaultPriCadence = (): Record<CsPriority, number> => ({ high: 14, medium: 30, low: 60 });

export async function loadCsData(): Promise<CsData> {
  const empty: CsData = { ready: false, owners: [], health: [], upsells: [], qbrs: [], snapshots: [], events: [], settings: { id: null, default_cadence_days: 30, auto_tasks: true, priority_cadence: defaultPriCadence() }, cadence: {}, priority: {} };
  const [ow, he, up, qb, sn, ev, st, cl] = await Promise.all([
    supabase.from("client_cs_owners").select("id, client_id, profile_id, is_primary"),
    supabase.from("client_health").select("client_id, status, reason, note, updated_at, updated_by"),
    supabase.from("client_upsells").select("*").order("created_at", { ascending: false }),
    supabase.from("qbr_meetings").select("*").order("meeting_date"),
    supabase.from("arr_snapshots").select("*").order("year"),
    supabase.from("cs_revenue_events").select("*").order("event_date", { ascending: false }),
    supabase.from("cs_settings").select("*").limit(1).maybeSingle(),
    supabase.from("clients").select("id, contact_cadence_days, cs_priority"),
  ]);
  if (ow.error && csMissing(ow.error)) return empty;
  const cadence: Record<string, number> = {};
  const priority: Record<string, CsPriority> = {};
  // before 88_cs_followups.sql there is no priority column: read the cadences alone
  const clRows = cl.error ? (((await supabase.from("clients").select("id, contact_cadence_days")).data ?? []) as any[]) : ((cl.data ?? []) as any[]);
  clRows.forEach((r) => { if (r.contact_cadence_days) cadence[r.id] = Number(r.contact_cadence_days); if (r.cs_priority) priority[r.id] = r.cs_priority; });
  const s: any = st.data;
  return {
    ready: true,
    owners: (ow.data ?? []) as CsOwner[],
    health: (he.data ?? []) as CsHealth[],
    upsells: ((up.data ?? []) as any[]).map((u) => ({ ...u, est_value: num(u.est_value) })) as CsUpsell[],
    qbrs: ((qb.data ?? []) as any[]).map((q) => ({ ...q, spiced: q.spiced ?? {} })) as CsQbr[],
    snapshots: ((sn.data ?? []) as any[]).map((x) => ({ ...x, initial_arr: num(x.initial_arr), by_client: x.by_client ?? {} })) as ArrSnapshot[],
    events: ((ev.data ?? []) as any[]).map((x) => ({ ...x, amount: num(x.amount) })) as RevenueEvent[],
    settings: s ? { id: s.id, default_cadence_days: Number(s.default_cadence_days) || 30, auto_tasks: s.auto_tasks !== false, priority_cadence: { ...defaultPriCadence(), ...(s.priority_cadence ?? {}) } } : empty.settings,
    cadence, priority,
  };
}

/** Who looks after a client: the whole list (the primary one first). */
export async function setClientOwners(clientId: string, profileIds: string[], primaryId: string | null): Promise<string | null> {
  const { data: cur, error } = await supabase.from("client_cs_owners").select("id, profile_id").eq("client_id", clientId);
  if (error) return csErr(error);
  const had = new Map(((cur ?? []) as any[]).map((r) => [r.profile_id as string, r.id as string]));
  const drop = [...had.keys()].filter((p) => !profileIds.includes(p));
  if (drop.length) { const { error: e } = await supabase.from("client_cs_owners").delete().eq("client_id", clientId).in("profile_id", drop); if (e) return csErr(e); }
  const add = profileIds.filter((p) => !had.has(p));
  if (add.length) { const { error: e } = await supabase.from("client_cs_owners").insert(add.map((p) => ({ client_id: clientId, profile_id: p, is_primary: p === primaryId }))); if (e) return csErr(e); }
  // one primary at most
  if (profileIds.length) {
    const prim = primaryId && profileIds.includes(primaryId) ? primaryId : profileIds[0];
    await supabase.from("client_cs_owners").update({ is_primary: false }).eq("client_id", clientId).neq("profile_id", prim);
    await supabase.from("client_cs_owners").update({ is_primary: true }).eq("client_id", clientId).eq("profile_id", prim);
  }
  return null;
}

export async function saveClientHealth(clientId: string, h: { status: CsHealthStatus; reason: string | null; note: string | null }): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser();
  const row = { client_id: clientId, status: h.status, reason: h.reason, note: h.note, updated_at: new Date().toISOString(), updated_by: auth.user?.id ?? null };
  const { error } = await supabase.from("client_health").upsert(row, { onConflict: "client_id" });
  return csErr(error);
}

export async function saveUpsell(u: Partial<CsUpsell> & { client_id: string; title: string }): Promise<{ upsell: CsUpsell | null; error: string | null }> {
  const row: any = {
    client_id: u.client_id, kind: u.kind ?? "product", product_id: u.product_id ?? null, tier_id: u.tier_id ?? null, service_id: u.service_id ?? null,
    title: u.title.trim(), est_value: num(u.est_value), ideal_contact_date: u.ideal_contact_date || null, status: u.status ?? "idea",
    owner_id: u.owner_id ?? null, notes: u.notes?.trim() || null, deal_id: u.deal_id ?? null,
    won_at: u.status === "won" ? (u.won_at ?? new Date().toISOString().slice(0, 10)) : null,
    updated_at: new Date().toISOString(),
  };
  const res = u.id
    ? await supabase.from("client_upsells").update(row).eq("id", u.id).select().single()
    : await supabase.from("client_upsells").insert(row).select().single();
  if (res.error || !res.data) return { upsell: null, error: csErr(res.error) ?? "Not saved." };
  const saved = { ...(res.data as any), est_value: num((res.data as any).est_value) } as CsUpsell;
  // a won upsell is expansion revenue (one movement per upsell, kept in step)
  if (saved.status === "won") {
    const { data: ex } = await supabase.from("cs_revenue_events").select("id").eq("upsell_id", saved.id).maybeSingle();
    const ev = { client_id: saved.client_id, kind: "expansion", amount: saved.est_value, event_date: saved.won_at ?? new Date().toISOString().slice(0, 10), reason: `Upsell: ${saved.title}`, upsell_id: saved.id };
    if (ex) await supabase.from("cs_revenue_events").update(ev).eq("id", (ex as any).id);
    else await supabase.from("cs_revenue_events").insert(ev);
  } else {
    await supabase.from("cs_revenue_events").delete().eq("upsell_id", saved.id);
  }
  return { upsell: saved, error: null };
}
export async function deleteUpsell(id: string): Promise<string | null> {
  const { error } = await supabase.from("client_upsells").delete().eq("id", id);
  return csErr(error);
}

export async function saveQbr(q: Partial<CsQbr> & { client_id: string; meeting_date: string }): Promise<{ qbr: CsQbr | null; error: string | null }> {
  const row: any = { client_id: q.client_id, meeting_date: q.meeting_date, spiced: q.spiced ?? {}, status: q.status ?? "planned", notes: q.notes ?? null, owner_id: q.owner_id ?? null };
  const res = q.id ? await supabase.from("qbr_meetings").update(row).eq("id", q.id).select().single() : await supabase.from("qbr_meetings").insert(row).select().single();
  if (res.error || !res.data) return { qbr: null, error: csErr(res.error) ?? "Not saved." };
  return { qbr: { ...(res.data as any), spiced: (res.data as any).spiced ?? {} } as CsQbr, error: null };
}
export async function deleteQbr(id: string): Promise<string | null> {
  const { error } = await supabase.from("qbr_meetings").delete().eq("id", id);
  return csErr(error);
}

/** Freezes the ARR a year starts with (the base for NRR and churn). */
export async function freezeArr(year: number, total: number, byClient: Record<string, number>): Promise<string | null> {
  const { data: ex } = await supabase.from("arr_snapshots").select("id").eq("year", year).maybeSingle();
  const row = { year, initial_arr: Math.round(total * 100) / 100, by_client: byClient, taken_at: new Date().toISOString() };
  const { error } = ex ? await supabase.from("arr_snapshots").update(row).eq("id", (ex as any).id) : await supabase.from("arr_snapshots").insert(row);
  return csErr(error);
}

export async function addRevenueEvent(e: Omit<RevenueEvent, "id" | "upsell_id">): Promise<string | null> {
  const { error } = await supabase.from("cs_revenue_events").insert({ ...e, amount: Math.abs(num(e.amount)) });
  return csErr(error);
}
export async function deleteRevenueEvent(id: string): Promise<string | null> {
  const { error } = await supabase.from("cs_revenue_events").delete().eq("id", id);
  return csErr(error);
}

export async function saveCsSettings(s: CsSettings): Promise<string | null> {
  const pc = Object.fromEntries(Object.entries(s.priority_cadence ?? {}).map(([k, v]) => [k, Math.max(1, Math.round(Number(v) || 1))]));
  const row: any = { default_cadence_days: Math.max(1, Math.round(s.default_cadence_days)), auto_tasks: s.auto_tasks, priority_cadence: pc, updated_at: new Date().toISOString() };
  let { error } = s.id ? await supabase.from("cs_settings").update(row).eq("id", s.id) : await supabase.from("cs_settings").insert(row);
  if (error && /priority_cadence/i.test(error.message)) {   // before 88_cs_followups.sql
    delete row.priority_cadence;
    ({ error } = s.id ? await supabase.from("cs_settings").update(row).eq("id", s.id) : await supabase.from("cs_settings").insert(row));
  }
  return csErr(error);
}
/** How often a client should hear from us: its own cadence, else its priority's, else the default. */
export const cadenceOf = (cs: CsData | null, clientId: string) =>
  cs?.cadence[clientId] ?? (cs?.priority[clientId] ? cs.settings.priority_cadence[cs.priority[clientId]] : undefined) ?? cs?.settings.default_cadence_days ?? 30;
export async function setClientPriority(clientId: string, p: CsPriority | null): Promise<string | null> {
  const { error } = await supabase.from("clients").update({ cs_priority: p }).eq("id", clientId);
  return error ? (/cs_priority/i.test(error.message) ? NEEDS_AUTO : error.message) : null;
}

/* ---------- automatic e-mail follow-ups (88_cs_followups.sql) ---------- */
export const NEEDS_AUTO = "Automatic e-mails need 88_cs_followups.sql in Supabase.";
export interface CsAttachment {
  path: string; name: string; size: number; type: string;
  /** filled in for each client when it goes out: "text" (HTML, TXT… with {{fields}} in it) or "pdf" */
  kind?: "pdf" | "text" | "other";
  /** a PDF's form fields → the field that fills each ("" leaves it as it is) */
  fields?: Record<string, string>;
  /** {{fields}} written in a PDF's text: where each one is (points, from the bottom left of its page) */
  spots?: CsSpot[];
  /** the {{fields}} found in the file */
  tags?: string[];
}
/** where a {{field}} is written in a PDF: the line of text it is in (its start, width and text) and its place in it */
export interface CsSpot { page: number; x: number; y: number; w: number; size: number; key: string; text?: string; at?: number; len?: number }
const TEXT_EXT = /\.(html?|txt|csv|md|xml|json|svg)$/i;
/** Plain names a PDF form field may have for a field of ours (client, nombre_cliente, Company…). */
const FIELD_ALIAS: [RegExp, string][] = [
  [/^(client|clientname|cliente|nombrecliente|company|companyname|empresa|nombreempresa|customer|account)$/, "client"],
  [/^(legalname|razonsocial|legal)$/, "legal_name"],
  [/^(firstname|nombre|name|contactfirstname)$/, "first_name"],
  [/^(contactname|fullname|contact|contacto|nombrecompleto)$/, "contact_name"],
  [/^(owner|ownername|sender|sendername|comercial|consultor)$/, "owner_name"],
  [/^(owneremail|senderemail)$/, "owner_email"],
  [/^(renewaldate|renewal|fecharenovacion|renovacion)$/, "renewal_date"],
  [/^(today|date|fecha|hoy)$/, "today"],
  [/^(year|ano|anio)$/, "year"],
];
const fieldFor = (name: string): string => {
  const raw = String(name ?? "").toLowerCase();
  const tag = /\{\{\s*([a-z_]+)\s*\}\}/.exec(raw)?.[1];
  if (tag && CS_TAGS.some((t) => t.key === tag)) return tag;
  const n = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
  if (CS_TAGS.some((t) => t.key.replace(/_/g, "") === n)) return CS_TAGS.find((t) => t.key.replace(/_/g, "") === n)!.key;
  return FIELD_ALIAS.find(([re]) => re.test(n))?.[1] ?? "";
};
/** What in a file can be filled in for each client: {{fields}} in a text file, a PDF's form fields and the {{fields}} written in it. */
export async function inspectCsFile(f: Blob, name: string, type: string): Promise<Pick<CsAttachment, "kind" | "fields" | "spots" | "tags">> {
  const isPdf = /pdf/i.test(type) || /\.pdf$/i.test(name);
  const isText = !isPdf && (/^text\//i.test(type) || TEXT_EXT.test(name));
  const found = (txt: string) => [...new Set([...txt.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase()))];
  try {
    if (isText) return { kind: "text", tags: found(await f.text()) };
    if (!isPdf) return { kind: "other" };
    const pdfjs: any = await import("pdfjs-dist");
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      const w: any = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = w.default ?? w;
    }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()), isEvalSupported: false }).promise;
    const fields: Record<string, string> = {};
    try {
      const objs = (await doc.getFieldObjects()) ?? {};
      Object.entries(objs).forEach(([nm, xs]: [string, any]) => { if ((xs as any[]).some((o) => o?.type === "text" || o?.type === "textfield" || o?.fieldType === "Tx" || !o?.type)) fields[nm] = fieldFor(nm); });
    } catch { /* no form */ }
    const spots: CsSpot[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, 30); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      for (const it of tc.items as any[]) {
        const str = String(it.str ?? "");
        if (!str.includes("{{")) continue;
        const [, , c, d, e, fy] = it.transform as number[];
        const size = Math.hypot(c, d) || Number(it.height) || 10;
        for (const m of str.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) {
          const k = m[1].toLowerCase();
          if (!CS_TAGS.some((t) => t.key === k)) continue;
          spots.push({ page: p - 1, x: e, y: fy, w: Number(it.width) || 0, size, key: k, text: str, at: m.index ?? 0, len: m[0].length });
        }
      }
    }
    try { await doc.destroy(); } catch { /* ignore */ }
    return { kind: "pdf", fields, spots, tags: [...new Set([...Object.values(fields).filter(Boolean), ...spots.map((x) => x.key)])] };
  } catch {
    return { kind: isPdf ? "pdf" : "other" };
  }
}
/** The file as one client gets it (fields filled in), to open and check. */
export async function previewCsAttachment(a: CsAttachment, clientId: string | null): Promise<{ blob: Blob | null; name?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke("outlook-sync", { body: { action: "cs_attachment_preview", attachment: a, clientId } });
  if (error) {
    let msg = error.message;
    try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep the message */ }
    return { blob: null, error: /unknown action/i.test(msg) ? "The e-mail sender needs updating (outlook-sync)." : msg };
  }
  const bin = atob(String((data as any)?.contentBytes ?? ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { blob: new Blob([bytes], { type: (data as any)?.contentType || a.type || "application/octet-stream" }), name: (data as any)?.name };
}
export interface CsDesign { accent?: string; brand?: string; title?: string; button_label?: string; button_url?: string; signoff?: string; footer?: string }
export interface CsTemplate { id: string; name: string; subject: string; body_html: string; html: string; design: CsDesign; attachments: CsAttachment[]; variants?: CsVariant[]; created_by?: string | null; created_at?: string; updated_at?: string }
/** Another version of a blueprint (its own subject and text, same look and files) for the clients it names. */
export interface CsVariant { id: string; name: string; subject: string; body_html: string; html: string; audience: CsVariantAudience }
export interface CsVariantAudience { clients?: string[]; owners?: string[]; priorities?: string[]; health?: string[] }
/** Does a version apply to a client? Picked clients, else every rule set must hold (a version with no rule applies to nobody). */
export function csVariantFits(a: CsVariantAudience | undefined, c: { id: string; owners: string[]; priority: string | null; health: string | null }): boolean {
  const x = a ?? {};
  if (x.clients?.length) return x.clients.includes(c.id);
  const rules = [x.owners, x.priorities, x.health].filter((r) => r?.length);
  if (!rules.length) return false;
  if (x.owners?.length && !c.owners.some((o) => x.owners!.includes(o))) return false;
  if (x.priorities?.length && !x.priorities.includes(c.priority ?? "none")) return false;
  if (x.health?.length && !x.health.includes(c.health ?? "none")) return false;
  return true;
}
/** The version of a blueprint a client gets (null: the main one). */
export function csVariantFor(t: Pick<CsTemplate, "variants"> | null | undefined, c: { id: string; owners: string[]; priority: string | null; health: string | null }): CsVariant | null {
  return (t?.variants ?? []).find((v) => csVariantFits(v.audience, c)) ?? null;
}
export interface CsStep { id: string; template_id: string; wait_days: number }
export interface CsAudience { priorities?: string[]; types?: string[]; health?: string[]; clients?: string[]; exclude?: string[] }
export interface CsSequence {
  id: string; name: string; active: boolean; audience: CsAudience; steps: CsStep[];
  start_mode: "now" | "before_renewal"; start_days: number; repeat: boolean;
  recipients: "main" | "all" | "billing"; sender: "owner" | "me"; log_contact: boolean;
  created_by?: string | null; created_at?: string;
}
export interface CsRun { id: string; sequence_id: string; client_id: string; step: number; status: "active" | "paused" | "done" | "excluded"; next_at: string | null; cycle: number; last_sent_at: string | null; to_emails: string[] | null; manual: boolean }
export interface CsMailLog { id: string; sequence_id: string | null; run_id: string | null; client_id: string | null; template_id: string | null; step: number | null; to_emails: string[] | null; subject: string | null; status: "sent" | "failed" | "skipped" | "test"; error: string | null; sent_by: string | null; sent_at: string }
export interface CsAuto { ready: boolean; templates: CsTemplate[]; sequences: CsSequence[]; runs: CsRun[]; log: CsMailLog[] }

export async function loadCsAuto(): Promise<CsAuto> {
  const [t, s, r, l] = await Promise.all([
    supabase.from("cs_email_templates").select("*").order("created_at"),
    supabase.from("cs_sequences").select("*").order("created_at"),
    supabase.from("cs_sequence_runs").select("*"),
    supabase.from("cs_email_log").select("*").order("sent_at", { ascending: false }).limit(300),
  ]);
  if (t.error) return { ready: false, templates: [], sequences: [], runs: [], log: [] };
  return {
    ready: true,
    templates: ((t.data ?? []) as any[]).map((x) => ({ ...x, design: x.design ?? {}, attachments: Array.isArray(x.attachments) ? x.attachments : [] })),
    sequences: ((s.data ?? []) as any[]).map((x) => ({ ...x, audience: x.audience ?? {}, steps: Array.isArray(x.steps) ? x.steps : [] })),
    runs: (r.data ?? []) as CsRun[],
    log: (l.data ?? []) as CsMailLog[],
  };
}
export async function saveCsTemplate(t: Partial<CsTemplate>): Promise<{ row: CsTemplate | null; error: string | null }> {
  const row: Record<string, unknown> = { name: t.name?.trim() || "Untitled e-mail", subject: t.subject ?? "", body_html: t.body_html ?? "", html: t.html ?? "", design: t.design ?? {}, attachments: t.attachments ?? [], variants: t.variants ?? [], updated_at: new Date().toISOString() };
  const go = () => (t.id ? supabase.from("cs_email_templates").update(row).eq("id", t.id).select("*").single() : supabase.from("cs_email_templates").insert(row).select("*").single());
  let res = await go();
  if (res.error && /variants/i.test(res.error.message)) {   // before 90_cs_blueprint_versions.sql
    if ((t.variants ?? []).length) return { row: null, error: "Run 90_cs_blueprint_versions.sql to keep versions." };
    delete row.variants; res = await go();
  }
  return { row: (res.data as any) ?? null, error: res.error ? (csMissing(res.error) ? NEEDS_AUTO : res.error.message) : null };
}
export async function deleteCsTemplate(id: string): Promise<string | null> {
  const { error } = await supabase.from("cs_email_templates").delete().eq("id", id);
  return error?.message ?? null;
}
export async function saveCsSequence(q: Partial<CsSequence>): Promise<{ row: CsSequence | null; error: string | null }> {
  const row = {
    name: q.name?.trim() || "Untitled follow-up", active: !!q.active, audience: q.audience ?? {}, steps: q.steps ?? [],
    start_mode: q.start_mode ?? "now", start_days: Math.max(0, Math.round(Number(q.start_days) || 0)), repeat: !!q.repeat,
    recipients: q.recipients ?? "main", sender: q.sender ?? "owner", log_contact: q.log_contact !== false, updated_at: new Date().toISOString(),
  };
  const res = q.id ? await supabase.from("cs_sequences").update(row).eq("id", q.id).select("*").single() : await supabase.from("cs_sequences").insert(row).select("*").single();
  return { row: (res.data as any) ?? null, error: res.error ? (csMissing(res.error) ? NEEDS_AUTO : res.error.message) : null };
}
export async function deleteCsSequence(id: string): Promise<string | null> {
  const { error } = await supabase.from("cs_sequences").delete().eq("id", id);
  return error?.message ?? null;
}
/** One client in one sequence: pause, resume, leave out, put in by hand, its own recipients, send it now. */
export async function setCsRun(sequenceId: string, clientId: string, patch: Partial<CsRun>): Promise<{ row: CsRun | null; error: string | null }> {
  const { data: cur } = await supabase.from("cs_sequence_runs").select("*").eq("sequence_id", sequenceId).eq("client_id", clientId).maybeSingle();
  const res = cur
    ? await supabase.from("cs_sequence_runs").update(patch).eq("id", (cur as any).id).select("*").single()
    : await supabase.from("cs_sequence_runs").insert({ sequence_id: sequenceId, client_id: clientId, step: 0, status: "active", next_at: new Date().toISOString(), ...patch }).select("*").single();
  return { row: (res.data as any) ?? null, error: res.error?.message ?? null };
}
/** The company's folder in the attachments bucket. */
async function csTenantId(): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;
  const { data } = await supabase.from("profiles").select("tenant_id").eq("id", auth.user.id).maybeSingle();
  return (data as any)?.tenant_id ?? null;
}
export async function uploadCsFile(f: File): Promise<{ file: CsAttachment | null; error: string | null }> {
  if (f.size > 3_000_000) return { file: null, error: `${f.name} is over 3 MB — e-mails can't carry it.` };
  const tenant = await csTenantId();
  if (!tenant) return { file: null, error: "No company to file it under." };
  const path = `${tenant}/${Date.now().toString(36)}-${f.name.replace(/[^\w.\- ]+/g, "_")}`;
  const { error } = await supabase.storage.from("cs-files").upload(path, f, { contentType: f.type || undefined });
  if (error) return { file: null, error: /bucket|not found/i.test(error.message) ? NEEDS_AUTO : error.message };
  const info = await inspectCsFile(f, f.name, f.type || "");
  return { file: { path, name: f.name, size: f.size, type: f.type || "application/octet-stream", ...info }, error: null };
}
export async function removeCsFile(path: string) { await supabase.storage.from("cs-files").remove([path]); }
/** Sends what is due now (your company) — the same as the hourly run. */
export async function runCsSequences(): Promise<{ sent?: number; enrolled?: number; failed?: number; skipped?: number; error?: string }> {
  const { data, error } = await supabase.functions.invoke("outlook-sync", { body: { action: "cs_run" } });
  if (error) return { error: error.message };
  return (data ?? {}) as any;
}
/** A blueprint filled in for a client, to your own inbox. */
export async function testCsTemplate(templateId: string, clientId: string | null): Promise<{ to?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke("outlook-sync", { body: { action: "cs_test", templateId, clientId } });
  if (error) {
    let msg = error.message;
    try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* the plain message */ }
    return { error: msg };
  }
  return (data ?? {}) as any;
}

/* ---------- the e-mail itself: a styled, table-based layout every mail client shows the same ---------- */
export const CS_TAGS: { key: string; label: string; sample: string }[] = [
  { key: "first_name", label: "Contact's first name", sample: "Laura" },
  { key: "contact_name", label: "Contact's full name", sample: "Laura Gil" },
  { key: "client", label: "Client", sample: "Acme Iberia" },
  { key: "legal_name", label: "Legal name", sample: "Acme Iberia, S.L." },
  { key: "owner_name", label: "Sender's name", sample: "Inder Boedhoe" },
  { key: "owner_first_name", label: "Sender's first name", sample: "Inder" },
  { key: "owner_email", label: "Sender's e-mail", sample: "inder@company.com" },
  { key: "renewal_date", label: "Next renewal date", sample: "15 March 2027" },
  { key: "days_to_renewal", label: "Days to renewal", sample: "120" },
  { key: "today", label: "Today", sample: "1 November 2026" },
  { key: "year", label: "This year", sample: "2026" },
];
const escH = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** Fills {{tags}} (values escaped in HTML). */
export const fillCsTags = (text: string, vars: Record<string, string>, html: boolean) =>
  String(text ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => { const v = vars[String(k).toLowerCase()] ?? ""; return html ? escH(v).replace(/\n/g, "<br>") : v; });
/** Keeps the body to plain formatting (no scripts, styles or event handlers). */
export const cleanCsBody = (h: string) => String(h ?? "")
  .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, "")
  .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
  .replace(/javascript:/gi, "");
export function renderCsEmail(t: { body_html: string; design: CsDesign }): string {
  const d = t.design ?? {};
  const accent = /^#[0-9a-f]{3,8}$/i.test(d.accent ?? "") ? d.accent! : "#0a6f4d";
  const font = "font-family:'Segoe UI',Helvetica,Arial,sans-serif";
  const btn = d.button_label && d.button_url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr><td style="background:${accent};border-radius:10px"><a href="${escH(d.button_url)}" style="display:inline-block;padding:13px 24px;${font};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px">${escH(d.button_label)}</a></td></tr></table>`
    : "";
  const sign = d.signoff ? `<p style="margin:22px 0 0;${font};font-size:15px;line-height:1.6;color:#1d2b25">${escH(d.signoff).replace(/\n/g, "<br>")}</p>` : "";
  const head = d.title || d.brand
    ? `<tr><td style="background:${accent};padding:30px 36px 28px">${d.brand ? `<div style="${font};font-size:12px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#ffffff;opacity:.82">${escH(d.brand)}</div>` : ""}${d.title ? `<div style="${font};font-size:25px;line-height:1.25;font-weight:800;color:#ffffff;margin-top:${d.brand ? 8 : 0}px">${escH(d.title)}</div>` : ""}</td></tr>`
    : `<tr><td style="background:${accent};height:6px;line-height:6px;font-size:0">&nbsp;</td></tr>`;
  const foot = d.footer ? `<tr><td style="padding:16px 36px 20px;background:#f6f9f7;border-top:1px solid #e6eeea;${font};font-size:12px;line-height:1.5;color:#7b8a84">${escH(d.footer).replace(/\n/g, "<br>")}</td></tr>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#eef3f0">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f0"><tr><td align="center" style="padding:30px 12px">`
    + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e1e9e5">`
    + head
    + `<tr><td style="padding:30px 36px 32px;${font};font-size:15px;line-height:1.65;color:#1d2b25">${cleanCsBody(t.body_html)}${btn}${sign}</td></tr>`
    + foot
    + `</table></td></tr></table></body></html>`;
}
export async function setClientCadence(clientId: string, days: number | null): Promise<string | null> {
  const { error } = await supabase.from("clients").update({ contact_cadence_days: days && days > 0 ? Math.round(days) : null }).eq("id", clientId);
  return csErr(error);
}

/** Logs a contact with a client (the same log the client popup keeps). */
export async function logClientContact(clientId: string, l: { channel: string; reason?: string | null; who?: string | null; direction?: "in" | "out" }): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser();
  const row: Record<string, unknown> = { client_id: clientId, contacted_at: new Date().toISOString(), channel: l.channel, contact_name: l.who?.trim() || null, reason: l.reason?.trim() || null, logged_by: auth.user?.id ?? null, direction: l.direction ?? "out" };
  let { error } = await supabase.from("client_contacts_log").insert(row);
  if (error && /direction/i.test(error.message)) { delete row.direction; ({ error } = await supabase.from("client_contacts_log").insert(row)); }   // before 89_contact_direction.sql
  return error?.message ?? null;
}

/* ---------- contacts read from Outlook (89_contact_direction.sql) ---------- */
export interface CsMailSync { user_id: string; read_after: string | null; scanned: number; logged: number; done_backfill: boolean; last_run_at: string | null; last_error: string | null }
export async function loadCsMailSync(): Promise<CsMailSync[]> {
  const { data, error } = await supabase.from("cs_mail_sync").select("*");
  return error ? [] : ((data ?? []) as CsMailSync[]);
}
/** Reads the company's Outlook mailboxes once (as far as it gets in about 45 seconds). */
export async function scanCsMail(): Promise<{ scanned: number; logged: number; more: boolean; mailboxes: number; errors: string[]; read?: string[]; unread?: string[]; team?: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("outlook-sync", { body: { action: "cs_mail_scan" } });
  if (error) {
    let msg = error.message;
    try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep the message */ }
    return { scanned: 0, logged: 0, more: false, mailboxes: 0, errors: [], error: msg };
  }
  return { scanned: 0, logged: 0, more: false, mailboxes: 0, errors: [], ...(data ?? {}) };
}

/** A follow-up for a client, as a ticket on someone's desk (falls back to the client's own tasks before 14_tickets.sql). */
export async function createClientFollowUp(clientId: string, title: string, assigneeId: string | null, ref?: string): Promise<string | null> {
  const due = new Date(Date.now() + 2 * 864e5).toISOString();
  const { data: auth } = await supabase.auth.getUser();
  const me = auth.user?.id ?? null;
  const full = { tracking_id: null, title, kind: "quick", priority: "high", status: "todo", progress: 0, due_at: due, client_id: clientId, assignee_id: assigneeId, external_ref: ref ?? null, source: "manual", stage: "new" };
  const { error } = await supabase.from("tracking_tasks").insert(full);
  if (!error) return null;
  if (!csMissing(error)) return error.message;
  const { error: e2 } = await supabase.from("client_tasks").insert({ client_id: clientId, title, due_at: due, priority: "high", status: "todo", done: false, created_by: me });
  return e2?.message ?? null;
}

/** Runs the automatic follow-ups now (the database function; idempotent). Number created, or null when it isn't installed. */
export async function generateContactTasks(): Promise<number | null> {
  const { data, error } = await supabase.rpc("cs_generate_contact_tasks");
  if (error) return null;
  return Number(data) || 0;
}

/** Turns an upsell into a deal in the first sales pipeline (its first phase), linked back to the upsell. */
export async function convertUpsellToDeal(u: CsUpsell, clientName: string): Promise<{ dealId: string | null; error: string | null }> {
  const { data: cl } = await supabase.from("clients").select("company_id").eq("id", u.client_id).maybeSingle();
  const { data: pipes } = await supabase.from("pipelines").select("id, is_sales, sort_order, created_at").order("created_at");
  const ps = ((pipes ?? []) as any[]).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const pipe = ps.find((p) => p.is_sales) ?? ps[0];
  if (!pipe) return { dealId: null, error: "There is no sales pipeline yet." };
  const { data: phases } = await supabase.from("pipeline_phases").select("id, pos_x, sales_outcome").eq("pipeline_id", pipe.id);
  const first = ((phases ?? []) as any[]).filter((p) => !p.sales_outcome).sort((a, b) => (a.pos_x ?? 0) - (b.pos_x ?? 0))[0];
  const dealId = await createTracking({
    company_id: (cl as any)?.company_id ?? null, pipeline_id: pipe.id,
    products: u.product_id ? [{ id: u.product_id, price: u.est_value }] : [],
    current_phase_id: first?.id ?? null, contactIds: [],
    deal_name: `${clientName} · ${u.title}`,
  });
  if (!dealId) return { dealId: null, error: "Could not create the deal." };
  const { error } = await supabase.from("client_upsells").update({ deal_id: dealId, status: u.status === "idea" || u.status === "planned" ? "proposal" : u.status }).eq("id", u.id);
  return { dealId, error: csErr(error) };
}
