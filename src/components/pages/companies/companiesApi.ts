/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";
import { applyRolePreview } from "../../framework/SuperAdmin";
import { useEffect, useSyncExternalStore } from "react";
import { setRequiredKeys, requiredKeys, subscribeRequired, requiredVersion, type ReqScope } from "../contacts/contactProfile";

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
  /** "multiselect" = several options at once (stored as a list). */
  type: "text" | "number" | "date" | "boolean" | "select" | "multiselect";
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
  /** More email addresses besides the main one (15_contacts_fields.sql). */
  emails?: string[] | null;
}

export interface ContactField {
  id: string;
  label: string;
  /** "multiselect" = several options at once (stored as a list). */
  type: "text" | "number" | "date" | "boolean" | "select" | "multiselect";
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
  const data = await readAll<any>("company_assignees", "company_id, profile_id", ["company_id", "profile_id"]).catch(() => []);
  const out: Record<string, string[]> = {};
  data.forEach((r: any) => { (out[r.company_id] ??= []).push(r.profile_id); });
  return out;
}
export async function setCompanyAssignees(companyId: string, profileIds: string[]) {
  await supabase.from("company_assignees").delete().eq("company_id", companyId);
  if (profileIds.length) {
    await supabase.from("company_assignees").insert(profileIds.map((p) => ({ company_id: companyId, profile_id: p })));
  }
}
export async function loadContactAssignees(): Promise<Record<string, string[]>> {
  const data = await readAll<any>("contact_assignees", "contact_id, profile_id", ["contact_id", "profile_id"]).catch(() => []);
  const out: Record<string, string[]> = {};
  data.forEach((r: any) => { (out[r.contact_id] ??= []).push(r.profile_id); });
  return out;
}
export async function setContactAssignees(contactId: string, profileIds: string[]) {
  await supabase.from("contact_assignees").delete().eq("contact_id", contactId);
  if (profileIds.length) {
    await supabase.from("contact_assignees").insert(profileIds.map((p) => ({ contact_id: contactId, profile_id: p })));
  }
}

// ---- Companies ----
/**
 * Every row of a table. The API hands back at most 1000 rows per call, so a
 * plain select silently drops the rest (a contact linked past row 1000 looked
 * unlinked on its company). Pages through until the end.
 */
/**
 * Requests already on their way are shared: two parts of the screen asking for
 * the same full list at the same moment get one read, not two.
 */
const inFlight = new Map<string, Promise<any>>();
function shared<T>(key: string, run: () => Promise<T>): Promise<T> {
  // each caller gets its own copy of the list (sorting one never moves the other)
  const copy = (v: any) => (Array.isArray(v) ? [...v] : v && typeof v === "object" ? { ...v } : v) as T;
  const cur = inFlight.get(key);
  if (cur) return (cur as Promise<T>).then(copy);
  const p = run().finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p.then(copy);
}

async function readAll<T = any>(table: string, cols: string, orders: string[]): Promise<T[]> {
  return pagedAll<T>((count) => {
    let q = supabase.from(table).select(cols, count ? { count: "exact" } : undefined);
    // a stable order (ending in a unique key) so pages never overlap or skip
    orders.forEach((o) => { q = q.order(o); });
    return q;
  }, true);
}

/**
 * Every row of a query, fast: the first page also brings the row count, then
 * every other page is asked for at the same time (6 at once) instead of one
 * after the other — 10,000 rows take two round trips instead of ten.
 * `build(count)` returns a fresh query with a stable order; when `count` is
 * true it must ask for the exact count (select(cols, { count: "exact" })).
 * `strict`: an error on the first page is thrown (otherwise: what was read).
 */
export async function pagedAll<T = any>(build: (count?: boolean) => any, strict = false, page = 1000): Promise<T[]> {
  const first = await build(true).range(0, page - 1);
  if (first.error) { if (strict) throw first.error; return []; }
  const out: T[] = [...((first.data ?? []) as T[])];
  if (out.length < page) return out;
  const get = async (n: number): Promise<T[] | null> => {
    const { data, error } = await build(false).range(n * page, n * page + page - 1);
    return error || !data ? null : (data as T[]);
  };
  const total: number | null = typeof first.count === "number" ? first.count : null;
  if (total != null) {
    const idx = Array.from({ length: Math.max(0, Math.ceil(total / page) - 1) }, (_, i) => i + 1);
    const results: (T[] | null)[] = new Array(idx.length).fill(null);
    let k = 0;
    await Promise.all(Array.from({ length: Math.min(6, idx.length) }, async () => {
      while (k < idx.length) { const i = k++; results[i] = await get(idx[i]); }
    }));
    if (results.every(Boolean)) {
      results.forEach((r) => out.push(...(r as T[])));
      // rows added while reading: pick up anything past the counted end
      for (let n = idx.length + 1; ; n++) {
        if (out.length < (n) * page) break;
        const r = await get(n);
        if (!r || !r.length) break;
        out.push(...r);
        if (r.length < page) break;
      }
      return out;
    }
    out.length = 0; out.push(...((first.data ?? []) as T[]));
  }
  // no count (or a page failed): page after page
  for (let n = 1; ; n++) {
    const r = await get(n);
    if (!r) break;
    out.push(...r);
    if (r.length < page) break;
  }
  return out;
}

export function listCompanies(): ReturnType<typeof listCompaniesRaw> { return shared("listCompanies", listCompaniesRaw); }
async function listCompaniesRaw(): Promise<Company[]> {
  const [rows, own] = await Promise.all([
    readAll<Company>("companies", "*", ["name", "id"]),
    supabase.from("crm_options").select("label").eq("kind", "relationship").then((r) => (r.error ? null : (r.data ?? []).map((x: any) => String(x.label))), () => null),
  ]);
  return own ? rows.map((c) => liveTypes(c, own)) : rows;
}

/**
 * A company's types without the ones taken off the list in Settings: a type
 * you remove disappears everywhere at once (companies, contacts, filters),
 * even on records still carrying the old name.
 */
function liveTypes(c: Company, own: string[]): Company {
  const list = c.relationship;
  if (!Array.isArray(list) || !list.length) return c;
  const ok = new Set([...REL_SYSTEM.map((r) => r.key), ...own].map((x) => x.toLowerCase()));
  const kept = list.filter((t) => ok.has(String(t).toLowerCase()));
  return kept.length === list.length ? c : { ...c, relationship: kept };
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
export function companyContactCounts(): ReturnType<typeof companyContactCountsRaw> { return shared("companyContactCounts", companyContactCountsRaw); }
async function companyContactCountsRaw(): Promise<Record<string, number>> {
  // counted in the database when 38_contacts_paging.sql is in (one small reply instead of every link)
  const fast = await companyContactCountsFast().catch(() => null);
  if (fast) return fast;
  const data = await readAll<any>("company_contacts", "company_id, contact_id", ["company_id", "contact_id"]);
  const out: Record<string, number> = {};
  data.forEach((r: any) => { out[r.company_id] = (out[r.company_id] ?? 0) + 1; });
  return out;
}

// ---- Contacts ----
export function listContacts(): ReturnType<typeof listContactsRaw> { return shared("listContacts", listContactsRaw); }
async function listContactsRaw(): Promise<Contact[]> {
  // every contact and every link, in pages (past 1000 rows a plain select drops the rest)
  const [rows, links] = await Promise.all([
    readAll<any>("contacts", "*", ["first_name", "id"]),
    readAll<any>("company_contacts", "contact_id, company_id", ["contact_id", "company_id"]),
  ]);
  const byContact: Record<string, string[]> = {};
  links.forEach((l: any) => { const list = (byContact[l.contact_id] ??= []); if (!list.includes(l.company_id)) list.push(l.company_id); });
  return rows.map((r: any) => ({ ...r, companyIds: byContact[r.id] ?? [] }));
}

/**
 * The first page of the contacts list straight from the database (38_contacts_paging.sql),
 * shown while the full list is still loading: the page paints in well under a second even
 * with tens of thousands of contacts. null when the function isn't installed yet.
 * Rows carry `__coNames` (company id → name) and `__types` (CRM, client, sales, own types).
 */
let pagingMissing = false;
export async function contactsPage(opts: { search?: string; sort?: "name" | "created_at"; dir?: "asc" | "desc"; offset?: number; limit?: number }): Promise<{ rows: Contact[]; total: number } | null> {
  if (pagingMissing) return null;
  const { data, error } = await supabase.rpc("contacts_page", {
    p_search: (opts.search ?? "").trim() || null, p_filters: {}, p_sort: opts.sort ?? "name", p_dir: opts.dir ?? "asc",
    p_offset: opts.offset ?? 0, p_limit: opts.limit ?? 80,
  });
  if (error || !data) {
    if (error && /42883|PGRST202|could not find the function|does not exist/i.test(`${(error as any).code ?? ""} ${error.message ?? ""}`)) pagingMissing = true;
    return null;
  }
  const list = Array.isArray(data) ? data : [];
  const total = list.length ? Number((list[0] as any).total ?? list.length) : 0;
  const rows: Contact[] = list.map((r: any) => {
    const row = r.contact ?? r.row ?? r;
    const ids: string[] = (r.company_ids ?? []).map(String);
    const names: string[] = r.company_names ?? [];
    return { ...row, companyIds: ids, __coNames: Object.fromEntries(ids.map((id, i) => [id, names[i] ?? ""])), __types: r.types ?? [] } as Contact;
  });
  return { rows, total };
}

/** Contacts per company, counted by the database (38); null when the function isn't there. */
export async function companyContactCountsFast(): Promise<Record<string, number> | null> {
  const { data, error } = await supabase.rpc("company_contact_counts");
  if (error || !Array.isArray(data)) return null;
  const out: Record<string, number> = {};
  data.forEach((r: any) => { if (r.company_id) out[r.company_id] = Number(r.n ?? r.count ?? 0); });
  return out;
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
  if (c.emails !== undefined) extra.emails = (c.emails ?? []).map((x) => x.trim()).filter(Boolean);
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

/** Link one contact to one company (only that link: nothing else on the contact is rewritten). */
export async function linkContactToCompany(contactId: string, companyId: string): Promise<string | null> {
  const { error } = await supabase.from("company_contacts").insert({ company_id: companyId, contact_id: contactId });
  return error && !/duplicate|unique/i.test(error.message) ? error.message : null;
}
/** Take one contact off one company (the contact and its other companies stay). */
export async function unlinkContactFromCompany(contactId: string, companyId: string): Promise<string | null> {
  const { error } = await supabase.from("company_contacts").delete().eq("contact_id", contactId).eq("company_id", companyId);
  return error?.message ?? null;
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


// ---- Deals of a company / a contact (drawers) ----
export interface DealRef {
  id: string; name: string; status: string; pipeline: string | null; phase: string | null;
  companyId: string | null; companyName: string | null; created_at: string | null; won: boolean;
  /** For a contact: on the deal itself, or only through one of their companies. */
  via?: "direct" | "company";
}
async function dealRefs(rows: any[]): Promise<DealRef[]> {
  if (!rows.length) return [];
  const pipeIds = Array.from(new Set(rows.map((r) => r.pipeline_id).filter(Boolean)));
  const phaseIds = Array.from(new Set(rows.map((r) => r.current_phase_id).filter(Boolean)));
  const coIds = Array.from(new Set(rows.map((r) => r.company_id).filter(Boolean)));
  const [pipes, phases, cos] = await Promise.all([
    pipeIds.length ? supabase.from("pipelines").select("id, name").in("id", pipeIds) : Promise.resolve({ data: [] as any[] }),
    phaseIds.length ? supabase.from("pipeline_phases").select("id, name, sales_outcome").in("id", phaseIds) : Promise.resolve({ data: [] as any[] }),
    coIds.length ? supabase.from("companies").select("id, name").in("id", coIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  const pn = new Map(((pipes as any).data ?? []).map((p: any) => [p.id, p.name as string]));
  const ph = new Map(((phases as any).data ?? []).map((p: any) => [p.id, p]));
  const cn = new Map(((cos as any).data ?? []).map((c: any) => [c.id, c.name as string]));
  return rows.map((r) => {
    const phase: any = r.current_phase_id ? ph.get(r.current_phase_id) : null;
    const companyName = r.company_id ? cn.get(r.company_id) ?? null : null;
    return {
      id: r.id, name: (r.deal_name ?? "").trim() || companyName || "Deal", status: r.status ?? "active",
      pipeline: r.pipeline_id ? pn.get(r.pipeline_id) ?? null : null, phase: phase?.name ?? null,
      companyId: r.company_id ?? null, companyName, created_at: r.created_at ?? null,
      won: r.status === "won" || phase?.sales_outcome === "win",
    } as DealRef;
  }).sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}
const DEAL_COLS = "id, deal_name, status, pipeline_id, current_phase_id, company_id, created_at";
/** Every deal of a company. */
export async function listCompanyDeals(companyId: string): Promise<DealRef[]> {
  const { data, error } = await supabase.from("trackings").select(DEAL_COLS).eq("company_id", companyId);
  if (error) return [];
  return dealRefs(data ?? []);
}
/** A contact's deals: the ones they are on, then (marked "company") their companies' other deals. */
export async function listContactDeals(contactId: string, companyIds: string[]): Promise<DealRef[]> {
  const { data: tc } = await supabase.from("tracking_contacts").select("tracking_id").eq("contact_id", contactId);
  const direct = new Set((tc ?? []).map((r: any) => r.tracking_id as string));
  const parts: string[] = [];
  if (direct.size) parts.push(`id.in.(${Array.from(direct).join(",")})`);
  if (companyIds.length) parts.push(`company_id.in.(${companyIds.join(",")})`);
  if (!parts.length) return [];
  const { data, error } = await supabase.from("trackings").select(DEAL_COLS).or(parts.join(","));
  if (error) return [];
  return (await dealRefs(data ?? [])).map((d) => ({ ...d, via: direct.has(d.id) ? "direct" : "company" }));
}
/** Every deal (to put a contact on one). */
export async function listAllDeals(): Promise<DealRef[]> {
  const out = await pagedAll<any>((count) => supabase.from("trackings").select(DEAL_COLS, count ? { count: "exact" } : undefined).order("id"));
  return dealRefs(out);
}
/** Put a contact on deals / take them off (tracking_contacts). */
export async function setContactDeals(contactId: string, add: string[], remove: string[]): Promise<string | null> {
  if (remove.length) {
    const { error } = await supabase.from("tracking_contacts").delete().eq("contact_id", contactId).in("tracking_id", remove);
    if (error) return error.message;
  }
  if (add.length) {
    const { error } = await supabase.from("tracking_contacts").insert(add.map((t) => ({ tracking_id: t, contact_id: contactId })));
    if (error && !/duplicate|unique/i.test(error.message)) return error.message;
  }
  return null;
}

/** Languages a contact can speak with you (ISO code → name), the ones sales asked for first. */
export const CONTACT_LANGUAGES: { code: string; name: string }[] = [
  { code: "es", name: "Spanish" }, { code: "en", name: "English" }, { code: "pt", name: "Portuguese" },
  { code: "fr", name: "French" }, { code: "de", name: "German" }, { code: "it", name: "Italian" },
];

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
  // (ordered by every column read, so pages never overlap or skip)
  const all = (table: string, cols: string): Promise<any[]> => pagedAll<any>((count) => {
    let q = supabase.from(table).select(cols, count ? { count: "exact" } : undefined);
    cols.split(",").map((c) => c.trim()).filter((c) => /^[a-z_]+$/.test(c) && c !== "contacts").forEach((c) => { q = q.order(c); });
    return q;
  });
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

/** One id → company Map per companies list (lists are replaced, never mutated, so a WeakMap keyed on the array is safe). */
const coIndex = new WeakMap<Company[], Map<string, Company>>();

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
  // a Map per companies list (built once): a find() per link made 25k contacts × 5k companies freeze the page
  let byId = coIndex.get(companies);
  if (!byId) { byId = new Map(companies.map((x) => [x.id as string, x])); coIndex.set(companies, byId); }
  ct.companyIds.forEach((id) => {
    const co = byId!.get(id) ?? { id };
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
/** How many companies use one of your types, sectors or sources (0 for product kinds). */
export async function crmOptionUses(opt: CrmOption): Promise<number> {
  if (opt.kind === "relationship") {
    const rows = await readAll<any>("companies", "id, relationship", ["id"]).catch(() => []);
    return rows.filter((r) => Array.isArray(r.relationship) && r.relationship.includes(opt.label)).length;
  }
  if (opt.kind === "sector" || opt.kind === "source") {
    if (opt.kind === "sector" && DEFAULT_SECTORS.some((d) => d.label === opt.label)) return 0;
    const { count } = await supabase.from("companies").select("id", { count: "exact", head: true }).eq(opt.kind, opt.label);
    return count ?? 0;
  }
  return 0;
}
/**
 * Take one of your list entries off the list AND off every company that has
 * it: a removed type leaves the companies' type lists, a removed sector or
 * source empties that field. Product kinds stay on the products.
 */
export async function removeCrmOption(opt: CrmOption): Promise<string | null> {
  if (opt.kind === "relationship") {
    const rows = await readAll<any>("companies", "id, relationship", ["id"]).catch(() => []);
    for (const r of rows) {
      const list: string[] = Array.isArray(r.relationship) ? r.relationship : [];
      if (!list.includes(opt.label)) continue;
      const { error: e } = await supabase.from("companies").update({ relationship: list.filter((x) => x !== opt.label) }).eq("id", r.id);
      if (e) return e.message;
    }
  } else if ((opt.kind === "sector" && !DEFAULT_SECTORS.some((d) => d.label === opt.label)) || opt.kind === "source") {
    const { error: e } = await supabase.from("companies").update({ [opt.kind]: null }).eq(opt.kind, opt.label);
    if (e) return e.message;
  }
  return deleteCrmOption(opt.id);
}
/**
 * Rename one of your own list entries (a type, sector, source or product kind)
 * and carry the new name to every record that uses it, so nothing is left
 * pointing at the old name.
 */
export async function renameCrmOption(opt: CrmOption, to: string): Promise<string | null> {
  const next = to.trim();
  const from = opt.label;
  if (!next || next === from) return null;
  const { error } = await supabase.from("crm_options").update({ label: next }).eq("id", opt.id);
  if (error) return /duplicate|unique/i.test(error.message) ? `“${next}” is already on the list.` : error.message;
  if (opt.kind === "relationship") {
    // companies keep their types as a list of names
    const rows = await readAll<any>("companies", "id, relationship", ["id"]).catch(() => []);
    for (const r of rows) {
      const list: string[] = Array.isArray(r.relationship) ? r.relationship : [];
      if (!list.includes(from)) continue;
      const { error: e } = await supabase.from("companies").update({ relationship: [...new Set(list.map((x) => (x === from ? next : x)))] }).eq("id", r.id);
      if (e) return e.message;
    }
  } else if (opt.kind === "sector" || opt.kind === "source") {
    const { error: e } = await supabase.from("companies").update({ [opt.kind]: next }).eq(opt.kind, from);
    if (e) return e.message;
  } else if (opt.kind === "product_kind") {
    const { error: e } = await supabase.from("products").update({ kind: next }).eq("kind", from);
    if (e && !/column .* does not exist/i.test(e.message)) return e.message;
  }
  return null;
}

/**
 * The types a contact gets from the companies it works for (CRM, Client,
 * In sales and your own, e.g. Partner), with the companies each one comes from.
 * Worked out live from the links, never stored on the contact.
 */
export function inheritedCompanyTags(ct: { companyIds: string[] }, companies: Company[], rel: RelationshipSets | null): { tag: string; from: string[] }[] {
  const out = new Map<string, string[]>();
  const add = (tag: string, name: string) => { const l = out.get(tag) ?? []; if (!l.includes(name)) l.push(name); out.set(tag, l); };
  let byId = coIndex.get(companies);
  if (!byId) { byId = new Map(companies.map((x) => [x.id as string, x])); coIndex.set(companies, byId); }
  ct.companyIds.forEach((id) => {
    const co = byId!.get(id);
    if (!co) return;
    const s = companyStatus(co, rel);
    add("crm", co.name);
    if (s.client) add("client", co.name);
    if (s.sales) add("sales", co.name);
    (co.relationship ?? []).forEach((t) => { if (t !== "crm" && t !== "client" && t !== "sales") add(t, co.name); });
  });
  return [...out.entries()].map(([tag, from]) => ({ tag, from }));
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
  // single choice: the value is the text; multiple choice: the value is a list that contains it
  const [one, many] = await Promise.all([
    supabase.from(table).select("id, custom").eq(`custom->>${fieldId}`, from),
    supabase.from(table).select("id, custom").contains("custom", { [fieldId]: [from] }),
  ]);
  if (one.error) return one.error.message;
  const rows = new Map<string, any>();
  [...(one.data ?? []), ...(many.error ? [] : many.data ?? [])].forEach((r: any) => rows.set(r.id, r));
  for (const r of rows.values()) {
    const cur = (r.custom ?? {})[fieldId];
    const next = Array.isArray(cur) ? [...new Set(cur.map((x: any) => (x === from ? to : x)))] : to;
    const { error: e } = await supabase.from(table).update({ custom: { ...(r.custom ?? {}), [fieldId]: next } }).eq("id", r.id);
    if (e) return e.message;
  }
  return null;
}

/** A custom value as a list (multiple-choice fields; also reads older single text values). */
export const customList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.trim() !== "")
    : v == null || v === "" ? [] : String(v).split(/\s*[;,]\s*/).filter(Boolean);

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

// ---- Which built-in company / contact fields are mandatory (Settings › … page › Required fields) ----
// Kept in crm_options as kind "required_field": one row per required key ("contact:email"), plus a
// marker row ("contact:*") once the team has saved its own choice — until then the defaults apply.
const REQ_KIND = "required_field";
let reqLoad: Promise<void> | null = null;
/** Loads the team's choice into the shared store (once per session unless `force`). */
export function loadRequiredFields(force = false): Promise<void> {
  if (reqLoad && !force) return reqLoad;
  reqLoad = (async () => {
    const { data, error } = await supabase.from("crm_options").select("label").eq("kind", REQ_KIND);
    if (error) return;
    const labels = ((data ?? []) as { label: string }[]).map((r) => String(r.label));
    (["company", "contact"] as ReqScope[]).forEach((scope) => {
      if (!labels.includes(`${scope}:*`)) return;
      setRequiredKeys(scope, labels.filter((l) => l.startsWith(`${scope}:`) && l !== `${scope}:*`).map((l) => l.slice(scope.length + 1)));
    });
  })();
  return reqLoad;
}
/** Turns one built-in field required on/off for every company or contact. Returns an error message or null. */
export async function setFixedRequired(scope: ReqScope, key: string, on: boolean): Promise<string | null> {
  const before = new Set(requiredKeys(scope));
  const next = new Set(before);
  if (on) next.add(key); else next.delete(key);
  setRequiredKeys(scope, next); // instant in the UI; rolled back below if it can't be saved
  const fail = (m: string) => {
    setRequiredKeys(scope, before);
    return /check constraint|crm_options_kind|violates/i.test(m) ? "Run 23_required_fields.sql in Supabase to save which fields are required." : m;
  };
  // the marker says "the team chose" — written first so a half-saved change never falls back to the defaults
  const { data: mk } = await supabase.from("crm_options").select("id").eq("kind", REQ_KIND).eq("label", `${scope}:*`).limit(1);
  if (!mk?.length) {
    // first change: write down the defaults, then the marker
    for (const label of [...[...before].map((k) => `${scope}:${k}`), `${scope}:*`]) {
      const { error } = await supabase.from("crm_options").insert({ kind: REQ_KIND, label, sort: 0 });
      if (error && !/duplicate|unique/i.test(error.message)) return fail(error.message);
    }
  }
  if (on) {
    const { error } = await supabase.from("crm_options").insert({ kind: REQ_KIND, label: `${scope}:${key}`, sort: 0 });
    if (error && !/duplicate|unique/i.test(error.message)) return fail(error.message);
  } else {
    const { error } = await supabase.from("crm_options").delete().eq("kind", REQ_KIND).eq("label", `${scope}:${key}`);
    if (error) return fail(error.message);
  }
  return null;
}
/** Re-renders when the required fields change, and loads them the first time. Returns a number that changes with them. */
export function useRequiredFields(): number {
  useEffect(() => { void loadRequiredFields(); }, []);
  return useSyncExternalStore(subscribeRequired, requiredVersion, requiredVersion);
}
