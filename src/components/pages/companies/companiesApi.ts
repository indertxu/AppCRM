/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";
import { applyRolePreview } from "../../framework/SuperAdmin";

export interface Company {
  id?: string;
  name: string;
  legal_name?: string | null;
  vat_number?: string | null;
  reg_number?: string | null;
  website?: string | null;
  /** The company's LinkedIn page (linkedin.com/company/…). */
  linkedin?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  street?: string | null;
  addr_number?: string | null;
  addr_details?: string | null;
  postal_code?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  custom?: Record<string, any>;
  // phones: "phone" is the mobile; each one can carry an extension
  phone_ext?: string | null;
  landline?: string | null;
  landline_ext?: string | null;
  /** One of the sectors (DEFAULT_SECTORS or one you added). */
  sector?: string | null;
  /** Where the company came from (web, event, partner…), one of your Source list (crm_options). */
  source?: string | null;
  /** What the company is to us: system keys ("sales", "client") plus your own labels ("Partner"…). CRM is implied. */
  relationship?: string[];
  /** Who to send invoices to — free: a name, an email, a phone… */
  billing?: Billing;
  /** The company above this one in its group. */
  parent_id?: string | null;
  // stamped by the database
  created_at?: string | null;
  created_by?: string | null;
}

export interface Billing { name?: string; email?: string; phone?: string; phone_ext?: string; notes?: string }

export interface CompanyField {
  id: string;
  label: string;
  type: "text" | "number" | "date" | "boolean" | "select";
  required: boolean;
  options: string[];
  sort: number;
}

export interface Contact {
  id?: string;
  first_name: string;
  last_name?: string | null;
  position?: string | null;
  email?: string | null;
  phone?: string | null;
  is_billing?: boolean;
  notes?: string | null;
  custom?: Record<string, any>;   // values for custom contact fields, keyed by field id
  companyIds: string[]; // companies this contact belongs to
  // built-in address, language and LinkedIn (country = ISO code "ES", language = ISO code "es")
  street?: string | null;
  addr_number?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
  language?: string | null;
  linkedin?: string | null;
  province?: string | null;
  phone_ext?: string | null;
  landline?: string | null;
  landline_ext?: string | null;
}

export interface ContactField {
  id: string;
  label: string;
  type: "text" | "number" | "date" | "boolean" | "select";
  required: boolean;
  options: string[];
  sort: number;
}

export interface Employee { id: string; name: string; email: string; role: string }

/**
 * The signed-in user's id, read from the local session. (auth.getUser() asks
 * the auth server and holds supabase-js's auth lock for that whole trip, so
 * every query started meanwhile waits behind it. Row security still checks
 * the token on the server, so the local id is enough here.)
 */
export async function sessionUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data?.session?.user?.id ?? null;
}

/** The signed-in user's role, used to gate pages and record visibility. */
export async function myProfile(): Promise<{ id: string; role: string; is_superadmin: boolean } | null> {
  const uid = await sessionUserId();
  if (!uid) return null;
  const { data } = await supabase.from("profiles").select("id, role, is_superadmin").eq("id", uid).maybeSingle();
  // A superadmin previewing a security level gets that level here (Superadmin bubble).
  return data ? applyRolePreview(data as any) : null;
}

/** Boss and sales managers see everything; sales only what they are assigned. */
export const isSalesLead = (p: { role?: string; is_superadmin?: boolean } | null) =>
  !!p && (p.is_superadmin || p.role === "boss" || p.role === "sales_manager");
export const canOpenSales = (p: { role?: string; is_superadmin?: boolean } | null) =>
  !!p && (p.is_superadmin || p.role === "boss" || p.role === "sales_manager" || p.role === "sales");

export const SEES_ALL_ROLES = ["boss", "consultancy_manager", "customer_success_manager"] as const;

export const roleSeesAll = (role?: string | null, isSuperadmin = false): boolean =>
  isSuperadmin || SEES_ALL_ROLES.includes((role ?? "") as (typeof SEES_ALL_ROLES)[number]);

export async function listEmployees(): Promise<Employee[]> {
  const { data } = await supabase.from("profiles").select("id, first_name, last_name, username, email, role");
  return (data ?? []).map((r: any) => ({
    id: r.id,
    name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.username || r.email || "Unnamed",
    email: r.email ?? "",
    role: r.role ?? "",
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Who can see what ----
export async function loadCompanyAssignees(): Promise<Record<string, string[]>> {
  const { data } = await supabase.from("company_assignees").select("company_id, profile_id");
  const out: Record<string, string[]> = {};
  (data ?? []).forEach((r: any) => { (out[r.company_id] ??= []).push(r.profile_id); });
  return out;
}
export async function setCompanyAssignees(companyId: string, profileIds: string[]) {
  await supabase.from("company_assignees").delete().eq("company_id", companyId);
  if (profileIds.length) {
    await supabase.from("company_assignees").insert(profileIds.map((p) => ({ company_id: companyId, profile_id: p })));
  }
}
export async function loadContactAssignees(): Promise<Record<string, string[]>> {
  const { data } = await supabase.from("contact_assignees").select("contact_id, profile_id");
  const out: Record<string, string[]> = {};
  (data ?? []).forEach((r: any) => { (out[r.contact_id] ??= []).push(r.profile_id); });
  return out;
}
export async function setContactAssignees(contactId: string, profileIds: string[]) {
  await supabase.from("contact_assignees").delete().eq("contact_id", contactId);
  if (profileIds.length) {
    await supabase.from("contact_assignees").insert(profileIds.map((p) => ({ contact_id: contactId, profile_id: p })));
  }
}

// ---- Companies ----
export async function listCompanies(): Promise<Company[]> {
  const { data } = await supabase.from("companies").select("*").order("name");
  return (data ?? []) as Company[];
}

export async function saveCompany(c: Company): Promise<string | null> {
  const row = {
    name: c.name, legal_name: c.legal_name ?? null, vat_number: c.vat_number ?? null,
    reg_number: c.reg_number ?? null, website: c.website ?? null, phone: c.phone ?? null,
    email: c.email ?? null, notes: c.notes ?? null,
    street: c.street ?? null, addr_number: c.addr_number ?? null, addr_details: c.addr_details ?? null,
    postal_code: c.postal_code ?? null, city: c.city ?? null, province: c.province ?? null, country: c.country ?? null,
    custom: c.custom ?? {},
  };
  // added by the CRM upgrade (crm_upgrade.sql) — only sent when the object carries them
  const extra = pickNew(c, ["phone_ext", "landline", "landline_ext", "sector", "source", "relationship", "billing", "parent_id", "linkedin"]);
  const write = async (r: Record<string, any>) => {
    if (c.id) return { error: (await supabase.from("companies").update(r).eq("id", c.id)).error, id: c.id };
    // Created by an import? Send the batch; the database stamps who and when (and created_by).
    const batch = (c as any).import_batch_id;
    const { data, error } = await supabase.from("companies").insert(batch ? { ...r, import_batch_id: batch } : r).select("id").single();
    return { error, id: data?.id as string | undefined };
  };
  let res = await write({ ...row, ...extra });
  // the database hasn't been upgraded yet: save what it knows
  if (res.error && Object.keys(extra).length && missingColumn(res.error.message)) res = await write(row);
  if (res.error) return friendlyDbError(res.error.message);
  if (!c.id) (c as any).id = res.id;
  return null;
}

/** The fields of `obj` among `keys` that are set (undefined = leave the column alone). */
function pickNew(obj: any, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  keys.forEach((k) => { if (obj[k] !== undefined) out[k] = typeof obj[k] === "string" ? obj[k].trim() || null : obj[k]; });
  return out;
}
const missingColumn = (m: string) => /column .* does not exist|could not find the .* column|schema cache/i.test(m);
const friendlyDbError = (m: string) =>
  /above itself in the group|own parent company/i.test(m) ? "That company is already below this one in the group — it can't also be above it." : m;

/** Put a company under another one in its group (null = top of its own group). */
export async function setCompanyParent(id: string, parentId: string | null): Promise<string | null> {
  const { error } = await supabase.from("companies").update({ parent_id: parentId }).eq("id", id);
  return error ? friendlyDbError(error.message) : null;
}

export async function deleteCompany(id: string): Promise<string | null> {
  const { error } = await supabase.from("companies").delete().eq("id", id);
  return error?.message ?? null;
}

// How many contacts each company has (for list badges).
export async function companyContactCounts(): Promise<Record<string, number>> {
  const { data } = await supabase.from("company_contacts").select("company_id");
  const out: Record<string, number> = {};
  (data ?? []).forEach((r: any) => { out[r.company_id] = (out[r.company_id] ?? 0) + 1; });
  return out;
}

// ---- Contacts ----
export async function listContacts(): Promise<Contact[]> {
  const { data: rows } = await supabase.from("contacts").select("*").order("first_name");
  const { data: links } = await supabase.from("company_contacts").select("contact_id,company_id");
  const byContact: Record<string, string[]> = {};
  (links ?? []).forEach((l: any) => { (byContact[l.contact_id] ??= []).push(l.company_id); });
  return (rows ?? []).map((r: any) => ({ ...r, companyIds: byContact[r.id] ?? [] }));
}

export async function saveContact(c: Contact): Promise<string | null> {
  const row = {
    first_name: c.first_name, last_name: c.last_name ?? null, position: c.position ?? null,
    email: c.email ?? null, phone: c.phone ?? null, is_billing: c.is_billing ?? false, notes: c.notes ?? null,
    street: c.street ?? null, addr_number: c.addr_number ?? null, postal_code: c.postal_code ?? null,
    city: c.city ?? null, country: c.country ?? null, language: c.language ?? null, linkedin: c.linkedin ?? null,
    custom: c.custom ?? {},
  };
  const extra = pickNew(c, ["province", "phone_ext", "landline", "landline_ext"]);
  let contactId = c.id;
  const write = async (r: Record<string, any>) => {
    if (contactId) return (await supabase.from("contacts").update(r).eq("id", contactId)).error;
    // Created by an import? Send the batch; the database stamps who and when.
    const batch = (c as any).import_batch_id;
    const { data, error } = await supabase.from("contacts").insert(batch ? { ...r, import_batch_id: batch } : r).select("id").single();
    if (!error) { contactId = data.id; (c as any).id = contactId; }
    return error;
  };
  let error = await write({ ...row, ...extra });
  if (error && Object.keys(extra).length && missingColumn(error.message)) error = await write(row);
  if (error) return error.message;
  // company links: only add and remove what changed (so the history shows real moves)
  const { data: cur } = await supabase.from("company_contacts").select("company_id").eq("contact_id", contactId);
  const had = new Set((cur ?? []).map((r: any) => r.company_id as string));
  const want = new Set(c.companyIds);
  const drop = [...had].filter((id) => !want.has(id));
  const add = [...want].filter((id) => !had.has(id));
  if (drop.length) await supabase.from("company_contacts").delete().eq("contact_id", contactId).in("company_id", drop);
  if (add.length) {
    const { error: lErr } = await supabase.from("company_contacts").insert(add.map((cid) => ({ company_id: cid, contact_id: contactId })));
    if (lErr) return lErr.message;
  }
  return null;
}

export async function deleteContact(id: string): Promise<string | null> {
  const { error } = await supabase.from("contacts").delete().eq("id", id);
  return error?.message ?? null;
}
// ---- Custom contact fields ----
export async function listContactFields(): Promise<ContactField[]> {
  const { data } = await supabase.from("contact_fields").select("*").order("sort").order("created_at");
  return (data ?? []).map((r: any) => ({
    id: r.id, label: r.label, type: r.type, required: !!r.required,
    options: Array.isArray(r.options) ? r.options : [], sort: r.sort ?? 0,
  }));
}
export async function addContactField(input: { label: string; type: ContactField["type"]; required: boolean; options: string[]; sort: number }): Promise<ContactField | null> {
  const { data } = await supabase.from("contact_fields")
    .insert({ label: input.label, type: input.type, required: input.required, options: input.options, sort: input.sort })
    .select().single();
  if (!data) return null;
  return { id: data.id, label: data.label, type: data.type, required: !!data.required, options: data.options ?? [], sort: data.sort ?? 0 };
}
export async function updateContactField(id: string, patch: Partial<{ label: string; type: string; required: boolean; options: string[]; sort: number }>) {
  const { error } = await supabase.from("contact_fields").update(patch).eq("id", id);
  return error?.message ?? null;
}
export async function deleteContactField(id: string) {
  await supabase.from("contact_fields").delete().eq("id", id);
}

// ---- Per-user UI preferences (jsonb bag on profiles) ----
export async function loadPrefs(): Promise<Record<string, any>> {
  const uid = await sessionUserId();
  if (!uid) return {};
  const { data } = await supabase.from("profiles").select("prefs").eq("id", uid).maybeSingle();
  return (data?.prefs as Record<string, any>) ?? {};
}
export async function savePref(key: string, value: any) {
  const uid = await sessionUserId();
  if (!uid) return;
  const { data } = await supabase.from("profiles").select("prefs").eq("id", uid).maybeSingle();
  const prefs = { ...((data?.prefs as Record<string, any>) ?? {}), [key]: value };
  await supabase.from("profiles").update({ prefs }).eq("id", uid);
}
// ---- Custom company fields ----
export async function listCompanyFields(): Promise<CompanyField[]> {
  const { data } = await supabase.from("company_fields").select("*").order("sort").order("created_at");
  return (data ?? []).map((r: any) => ({
    id: r.id, label: r.label, type: r.type, required: !!r.required,
    options: Array.isArray(r.options) ? r.options : [], sort: r.sort ?? 0,
  }));
}
export async function addCompanyField(input: { label: string; type: CompanyField["type"]; required: boolean; options: string[]; sort: number }): Promise<CompanyField | null> {
  const { data } = await supabase.from("company_fields")
    .insert({ label: input.label, type: input.type, required: input.required, options: input.options, sort: input.sort })
    .select().single();
  if (!data) return null;
  return { id: data.id, label: data.label, type: data.type, required: !!data.required, options: data.options ?? [], sort: data.sort ?? 0 };
}
export async function updateCompanyField(id: string, patch: Partial<{ label: string; type: string; required: boolean; options: string[]; sort: number }>) {
  const { error } = await supabase.from("company_fields").update(patch).eq("id", id);
  return error?.message ?? null;
}
export async function deleteCompanyField(id: string) {
  await supabase.from("company_fields").delete().eq("id", id);
}

// ---- Commercial activity for a contact (re-added) ----
export interface ContactDeal {
  id: string;
  status: string;
  productName: string | null;
  value: number;
  link: "direct" | "company";
  companyName: string | null;
  created_at?: string;
}
export async function loadContactActivity(contactId: string, companyIds: string[]): Promise<ContactDeal[]> {
  const { data: tc } = await supabase.from("tracking_contacts").select("tracking_id").eq("contact_id", contactId);
  const directIds = new Set((tc ?? []).map((r: any) => r.tracking_id));
  const orParts: string[] = [];
  if (directIds.size) orParts.push(`id.in.(${Array.from(directIds).join(",")})`);
  if (companyIds.length) orParts.push(`company_id.in.(${companyIds.join(",")})`);
  if (!orParts.length) return [];
  const { data: rows } = await supabase.from("trackings").select("*").or(orParts.join(","));
  const trackings = (rows ?? []) as any[];
  const productIds = Array.from(new Set(trackings.map((t) => t.product_id).filter(Boolean)));
  const prodName: Record<string, string> = {};
  if (productIds.length) {
    const { data: prods } = await supabase.from("products").select("id,name").in("id", productIds);
    (prods ?? []).forEach((p: any) => { prodName[p.id] = p.name; });
  }
  const compName: Record<string, string> = {};
  if (companyIds.length) {
    const { data: comps } = await supabase.from("companies").select("id,name").in("id", companyIds);
    (comps ?? []).forEach((c: any) => { compName[c.id] = c.name; });
  }
  return trackings.map((t) => ({
    id: t.id, status: t.status,
    productName: t.product_id ? (prodName[t.product_id] ?? null) : null,
    value: Number(t.product_price) || 0,
    link: directIds.has(t.id) ? "direct" : "company",
    companyName: t.company_id ? (compName[t.company_id] ?? null) : null,
    created_at: t.created_at,
  })) as ContactDeal[];
}


// ---- Relationship status (client / in sales) for companies & contacts ----
//
// A company is a CLIENT if it appears in the `clients` table (clients.company_id),
// and IN SALES if it is in any deal (trackings.company_id). A contact has the
// same status as its companies (a deal or a client for the company counts for
// everyone who works there), plus its own: deals it is on (tracking_contacts)
// and clients that list it (clients.contacts). So both pages always agree.

export interface RelationshipSets {
  clientCompanyIds: Set<string>;
  clientContactIds: Set<string>;
  trackingCompanyIds: Set<string>;
  trackingContactIds: Set<string>;
  /** Pipeline names of the deals each company / contact is directly on. */
  pipesByCompany: Record<string, string[]>;
  pipesByContact: Record<string, string[]>;
  /** Companies with a won deal: a won deal is no longer "in the sales pipeline". */
  wonCompanyIds: Set<string>;
}

/** Load, in a few queries, everything needed to tag companies & contacts. */
export async function loadRelationshipSets(): Promise<RelationshipSets> {
  const clientCompanyIds = new Set<string>();
  const clientContactIds = new Set<string>();
  const trackingCompanyIds = new Set<string>();
  const trackingContactIds = new Set<string>();
  const pipesByCompany: Record<string, string[]> = {};
  const pipesByContact: Record<string, string[]> = {};

  // Read every row in pages: the API returns at most 1000 rows per call, and
  // a missing row would wrongly show a company/contact as "No sales tracking".
  const all = async (table: string, cols: string): Promise<any[]> => {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from(table).select(cols).range(from, from + 999);
      if (error || !data) break;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  };
  const [clientsRows, trackRows, tcRows, pipeRows, phaseRows] = await Promise.all([
    all("clients", "company_id, contacts"),
    all("trackings", "id, company_id, pipeline_id, status, current_phase_id"),
    all("tracking_contacts", "contact_id, tracking_id"),
    all("pipelines", "id, name"),
    all("pipeline_phases", "id, sales_outcome"),
  ]);
  // A won deal (status, or sitting in the pipeline's win phase) is closed: it no longer counts as "in sales".
  const winPhase = new Set(phaseRows.filter((p: any) => p.sales_outcome === "win").map((p: any) => p.id));
  const isWon = (r: any) => r.status === "won" || (!!r.current_phase_id && winPhase.has(r.current_phase_id));
  const wonDeal = new Set<string>();
  const wonCompanyIds = new Set<string>();
  const pipeName: Record<string, string> = {};
  pipeRows.forEach((p: any) => { pipeName[p.id] = p.name; });
  const pipeOfDeal: Record<string, string> = {};
  const addPipe = (map: Record<string, string[]>, id: string, name?: string) => {
    const list = (map[id] ??= []);
    if (name && !list.includes(name)) list.push(name);
  };

  clientsRows.forEach((r: any) => {
    if (r.company_id) clientCompanyIds.add(r.company_id);
    // `contacts` may be a jsonb array of ids, or of objects; the CRM contact is `sourceId` (or `contact_id`)
    const list = Array.isArray(r.contacts) ? r.contacts : [];
    list.forEach((x: any) => {
      const id = typeof x === "string" ? x : x?.sourceId ?? x?.contact_id;
      if (id) clientContactIds.add(String(id));
    });
  });
  trackRows.forEach((r: any) => {
    const name = r.pipeline_id ? pipeName[r.pipeline_id] : undefined;
    if (name) pipeOfDeal[r.id] = name;
    if (isWon(r)) { wonDeal.add(r.id); if (r.company_id) wonCompanyIds.add(r.company_id); return; }
    if (r.company_id) { trackingCompanyIds.add(r.company_id); addPipe(pipesByCompany, r.company_id, name); }
  });
  tcRows.forEach((r: any) => {
    if (!r.contact_id || wonDeal.has(r.tracking_id)) return;
    trackingContactIds.add(r.contact_id);
    addPipe(pipesByContact, r.contact_id, pipeOfDeal[r.tracking_id]);
  });

  return { clientCompanyIds, clientContactIds, trackingCompanyIds, trackingContactIds, pipesByCompany, pipesByContact, wonCompanyIds };
}

/** Where a company or contact stands: client, and the pipelines it is in sales in. */
export interface RelStatus { client: boolean; sales: boolean; pipelines: string[] }
const NO_STATUS: RelStatus = { client: false, sales: false, pipelines: [] };

export function companyStatus(c: { id?: string; relationship?: string[] }, rel: RelationshipSets | null): RelStatus {
  const tags = c.relationship ?? [];
  if (!c.id) return { ...NO_STATUS, client: tags.includes("client"), sales: tags.includes("sales") };
  const pipelines = rel?.pipesByCompany[c.id] ?? [];
  return {
    client: !!rel?.clientCompanyIds.has(c.id) || tags.includes("client"),
    // the "sales" tag stays on the company after its deal is won: an open deal decides
    sales: !!rel?.trackingCompanyIds.has(c.id) || (tags.includes("sales") && !rel?.wonCompanyIds.has(c.id)),
    pipelines,
  };
}
/** A contact counts as client / in sales when it is so itself, or through any of its companies. */
export function contactStatus(ct: { id?: string; companyIds: string[] }, rel: RelationshipSets | null, companies: Company[] = []): RelStatus {
  if (!rel) return NO_STATUS;
  const own = ct.id ? { client: rel.clientContactIds.has(ct.id), sales: rel.trackingContactIds.has(ct.id), pipelines: rel.pipesByContact[ct.id] ?? [] } : NO_STATUS;
  const out: RelStatus = { client: own.client, sales: own.sales, pipelines: [...own.pipelines] };
  ct.companyIds.forEach((id) => {
    const co = companies.find((x) => x.id === id) ?? { id };
    const s = companyStatus(co, rel);
    out.client ||= s.client;
    out.sales ||= s.sales;
    s.pipelines.forEach((p) => { if (!out.pipelines.includes(p)) out.pipelines.push(p); });
  });
  return out;
}

// ---- What a company is to us (relationship types) ----
/** Built-in types. CRM = every company; "sales" and "client" are switched on by the database when it happens. */
export const REL_SYSTEM: { key: string; label: string; hint: string }[] = [
  { key: "crm", label: "CRM", hint: "Every company in the CRM" },
  { key: "sales", label: "In sales", hint: "Switched on when it enters a sales pipeline" },
  { key: "client", label: "Client", hint: "Switched on when it becomes a client" },
];
export const relLabel = (key: string) => REL_SYSTEM.find((r) => r.key === key)?.label ?? key;

// ---- Sectors ----
/** The sectors every company can pick from; you can add your own (crm_options). Keywords (es / en) let us guess one. */
export const DEFAULT_SECTORS: { label: string; words: string[] }[] = [
  { label: "Agriculture & food", words: ["agri", "agro", "food", "aliment", "bodega", "vino", "wine", "olive", "aceite", "granja", "farm", "fruta", "carnic", "lacteo", "panader", "bebida", "beverage", "cerveza"] },
  { label: "Automotive", words: ["automo", "motor ", "cars ", "coche", "vehicul", "concesionario", "taller", "recambio"] },
  { label: "Banking & finance", words: ["bank", "banco", "banca", "financ", "capital", "invest", "inversion", "credit", "credito", "fintech", "asset", "fondo", "patrimonio", "wealth"] },
  { label: "Construction & real estate", words: ["construc", "inmobiliar", "real estate", "promotor", "property", "obras", "arquitect", "architect", "reforma", "building", "edifica", "vivienda"] },
  { label: "Consulting & professional services", words: ["consult", "asesor", "advisory", "auditor", "audit", "gestoria", "contabil", "accounting", "servicios profesionales", "partners"] },
  { label: "Education", words: ["educa", "school", "escuela", "colegio", "universi", "academ", "formacion", "training", "instituto", "learning"] },
  { label: "Energy & utilities", words: ["energ", "solar", "electric", "power", "renovable", "renewable", "petrol", "oil", "gas ", "agua", "water", "eolic", "utilities"] },
  { label: "Healthcare & pharma", words: ["health", "salud", "clinic", "hospital", "medic", "pharma", "farma", "dental", "laborator", "biotech", "sanitar", "veterinar"] },
  { label: "Hospitality & tourism", words: ["hotel", "hostel", "turism", "touris", "travel", "viaje", "restaur", "catering", "hospitality", "resort", "camping"] },
  { label: "Industrial & manufacturing", words: ["industri", "manufact", "fabric", "metal", "steel", "acero", "maquinaria", "machinery", "plastic", "quimic", "chemical", "packaging", "envase"] },
  { label: "Insurance", words: ["insur", "seguro", "aseguradora", "mutua", "reaseguro"] },
  { label: "IT & software", words: ["software", "tech", "tecnolog", "informatic", "digital", "cloud", "saas", "data", "sistemas", "systems", "solutions", "apps", "ciberseg", "cyber", "web ", "robot"] },
  { label: "Legal", words: ["legal", "abogad", "law", "lawyer", "juridic", "notari", "bufete", "attorney"] },
  { label: "Logistics & transport", words: ["logist", "transport", "shipping", "freight", "mensajer", "courier", "almacen", "warehouse", "cargo", "naviera", "fleet"] },
  { label: "Marketing & media", words: ["marketing", "media", "publicidad", "advert", "agencia", "agency", "comunicacion", "design", "diseno", "studio", "estudio", "prensa", "editorial", "radio", "tv"] },
  { label: "Public sector", words: ["ayuntamiento", "gobierno", "government", "ministerio", "diputacion", "consejeria", "public", "municipal", "generalitat", "junta de"] },
  { label: "Retail & e-commerce", words: ["retail", "tienda", "shop", "store", "comercio", "ecommerce", "e-commerce", "moda online", "distribuc", "supermerc", "market"] },
  { label: "Telecommunications", words: ["telecom", "telefon", "fibra", "fiber", "network", "redes", "movil", "mobile", "internet"] },
  { label: "Textile & fashion", words: ["textil", "textile", "fashion", "moda", "ropa", "clothing", "calzado", "shoes", "apparel"] },
  { label: "Non-profit", words: ["fundacion", "foundation", "asociacion", "association", "ong", "ngo", "charity", "non-profit", "sin animo"] },
  { label: "Other", words: [] },
];
const sNorm = (s: unknown) => ` ${String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** A keyword ending in a space must be a whole word; otherwise it is a word start ("tecnolog" → "tecnología"). */
const wordHit = (text: string, w: string) => { const k = sNorm(w); return w.endsWith(" ") ? text.includes(k) : text.includes(k.slice(0, -1)); };

/** Our best guess at a company's sector from its name, legal name, website and notes ("" when nothing fits). */
export function guessSector(c: Partial<Company>): string {
  const text = sNorm([c.name, c.legal_name, (c.website ?? "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\.[a-z.]+(\/.*)?$/i, ""), c.notes].filter(Boolean).join(" "));
  let best = "", score = 0;
  for (const s of DEFAULT_SECTORS) {
    const hits = s.words.reduce((n, w) => n + (wordHit(text, w) ? 1 : 0), 0);
    if (hits > score) { best = s.label; score = hits; }
  }
  return best;
}
/** A sector written any way ("software", "Tecnología", "IT") → one of `options` ("" when it can't tell). */
export function matchSector(raw: unknown, options: string[]): string {
  const n = sNorm(raw).trim();
  if (!n) return "";
  const exact = options.find((o) => sNorm(o).trim() === n);
  if (exact) return exact;
  const part = options.find((o) => { const on = sNorm(o).trim(); return on.length > 3 && (on.includes(n) || n.includes(on)); });
  if (part) return part;
  // by keyword: the default sector whose words appear, if it is among the options
  let best = "", score = 0;
  for (const s of DEFAULT_SECTORS) {
    if (!options.includes(s.label)) continue;
    const hits = s.words.reduce((k, w) => k + (wordHit(` ${n} `, w) ? 1 : 0), 0);
    if (hits > score) { best = s.label; score = hits; }
  }
  return best;
}

// ---- Your own option lists (sectors, relationship types) ----
export interface CrmOption { id: string; kind: "sector" | "relationship" | "source" | "product_kind"; label: string; sort: number }
export async function listCrmOptions(): Promise<CrmOption[]> {
  const { data, error } = await supabase.from("crm_options").select("id, kind, label, sort").order("sort").order("label");
  if (error) return [];
  return (data ?? []) as CrmOption[];
}
export async function addCrmOption(kind: CrmOption["kind"], label: string, sort = 0): Promise<string | null> {
  const { error } = await supabase.from("crm_options").insert({ kind, label: label.trim(), sort });
  return error ? (/duplicate|unique/i.test(error.message) ? null : error.message) : null;
}
export async function deleteCrmOption(id: string): Promise<string | null> {
  const { error } = await supabase.from("crm_options").delete().eq("id", id);
  return error?.message ?? null;
}
/** Every sector to choose from: the defaults, then yours. */
export const sectorOptions = (opts: CrmOption[]) => {
  const out = DEFAULT_SECTORS.map((s) => s.label).filter((l) => l !== "Other");
  opts.filter((o) => o.kind === "sector").forEach((o) => { if (!out.includes(o.label)) out.push(o.label); });
  return [...out, "Other"];
};
/** Every source a company can have (your list, in its order). */
export const sourceOptions = (opts: CrmOption[]) => opts.filter((o) => o.kind === "source").map((o) => o.label);
/** A source written any way ("WEB", "web site") → the one on your list, else as written. */
export const matchSource = (v: string, opts: string[]) => {
  const k = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return opts.find((o) => k(o) === k(v)) ?? v.trim();
};
/** Every relationship type: the built-in ones, then yours. */
export const relationshipOptions = (opts: CrmOption[]) => [
  ...REL_SYSTEM.map((r) => ({ key: r.key, label: r.label, system: true })),
  ...opts.filter((o) => o.kind === "relationship" && !REL_SYSTEM.some((r) => r.key === o.label)).map((o) => ({ key: o.label, label: o.label, system: false })),
];

/** Every product kind (your list; SaaS / Physical when there is none yet). */
export const productKindOptions = (opts: CrmOption[]) => {
  const own = opts.filter((o) => o.kind === "product_kind").map((o) => o.label);
  return own.length ? own : ["SaaS", "Physical"];
};

// ---- Partners: companies whose relationship type is "Partner" ----
export const isPartnerTag = (tag: string) => /partner/i.test(tag);
export const isPartner = (c: { relationship?: string[] }) => (c.relationship ?? []).some(isPartnerTag);
export const partnerCompanies = (companies: Company[]) => companies.filter(isPartner).sort((a, b) => a.name.localeCompare(b.name));

/** A partner's cut: a % of the line or a fixed amount. item null = any product / service of that partner. */
export interface PartnerRate { id: string; partner_id: string; item_type: "product" | "service" | null; item_id: string | null; mode: "percent" | "amount"; value: number }
export async function listPartnerRates(): Promise<PartnerRate[]> {
  const { data, error } = await supabase.from("partner_rates").select("id, partner_id, item_type, item_id, mode, value");
  if (error) return [];
  return (data ?? []).map((r: any) => ({ ...r, value: Number(r.value) || 0 })) as PartnerRate[];
}
export async function savePartnerRate(r: Omit<PartnerRate, "id"> & { id?: string }): Promise<string | null> {
  const row = { partner_id: r.partner_id, item_type: r.item_type, item_id: r.item_id, mode: r.mode, value: r.value };
  const { error } = r.id ? await supabase.from("partner_rates").update(row).eq("id", r.id) : await supabase.from("partner_rates").insert(row);
  return error?.message ?? null;
}
export async function deletePartnerRate(id: string): Promise<string | null> {
  const { error } = await supabase.from("partner_rates").delete().eq("id", id);
  return error?.message ?? null;
}
/** The default cut of a partner on a product / service: its own rate, else the partner's general one, else none. */
export function partnerDefault(rates: PartnerRate[], partnerId: string, itemType: "product" | "service", itemId: string | null): { mode: "percent" | "amount"; value: number } | null {
  const own = itemId ? rates.find((r) => r.partner_id === partnerId && r.item_type === itemType && r.item_id === itemId) : undefined;
  const gen = rates.find((r) => r.partner_id === partnerId && !r.item_type && !r.item_id);
  const r = own ?? gen;
  return r ? { mode: r.mode, value: r.value } : null;
}
/** What the partner takes from a line worth `gross`. */
export function partnerCut(gross: number, mode: string | null | undefined, value: number | null | undefined): number {
  const v = Number(value) || 0;
  if (!v || !gross) return 0;
  return mode === "amount" ? Math.min(v, gross) : Math.round(gross * Math.min(v, 100)) / 100;
}

/** A dropdown option renamed in Settings: the records that had the old value get the new one. */
export async function renameCustomValue(table: "companies" | "contacts", fieldId: string, from: string, to: string): Promise<string | null> {
  if (!from || from === to) return null;
  const { data, error } = await supabase.from(table).select("id, custom").eq(`custom->>${fieldId}`, from);
  if (error) return error.message;
  for (const r of (data ?? []) as any[]) {
    const { error: e } = await supabase.from(table).update({ custom: { ...(r.custom ?? {}), [fieldId]: to } }).eq("id", r.id);
    if (e) return e.message;
  }
  return null;
}

// ---- History (written by the database: crm_history) ----
export interface HistoryEntry { id: string; at: string; actor: string | null; action: string; detail: Record<string, any> }
export async function loadHistory(entity: "company" | "contact", id: string): Promise<HistoryEntry[] | null> {
  const { data, error } = await supabase.from("crm_history").select("id, at, actor, action, detail")
    .eq("entity", entity).eq("entity_id", id).order("at", { ascending: false }).range(0, 499);
  if (error) return null; // not set up yet
  return (data ?? []) as HistoryEntry[];
}

// ---- Groups ----
/** Ids of every company below `id` in its group (children, grandchildren…). */
export function descendantsOf(id: string, companies: Company[]): Set<string> {
  const out = new Set<string>();
  const walk = (p: string) => companies.forEach((c) => { if (c.parent_id === p && c.id && !out.has(c.id)) { out.add(c.id); walk(c.id); } });
  walk(id);
  return out;
}
/** The company at the top of `id`'s group. */
export function groupRootOf(id: string, companies: Company[]): string {
  const seen = new Set<string>();
  let cur = id;
  for (;;) {
    const p = companies.find((c) => c.id === cur)?.parent_id;
    if (!p || seen.has(p)) return cur;
    seen.add(cur); cur = p;
  }
}
