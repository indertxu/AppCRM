/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

export interface Company {
  id?: string;
  name: string;
  legal_name?: string | null;
  vat_number?: string | null;
  reg_number?: string | null;
  website?: string | null;
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
  companyIds: string[]; // companies this contact belongs to
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
  };
  if (c.id) {
    const { error } = await supabase.from("companies").update(row).eq("id", c.id);
    return error?.message ?? null;
  }
  const { error } = await supabase.from("companies").insert(row);
  return error?.message ?? null;
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
  };
  let contactId = c.id;
  if (contactId) {
    const { error } = await supabase.from("contacts").update(row).eq("id", contactId);
    if (error) return error.message;
  } else {
    const { data, error } = await supabase.from("contacts").insert(row).select("id").single();
    if (error) return error.message;
    contactId = data.id;
  }
  // replace the company links
  await supabase.from("company_contacts").delete().eq("contact_id", contactId);
  if (c.companyIds.length) {
    const { error } = await supabase.from("company_contacts")
      .insert(c.companyIds.map((cid) => ({ company_id: cid, contact_id: contactId })));
    if (error) return error.message;
  }
  return null;
}

export async function deleteContact(id: string): Promise<string | null> {
  const { error } = await supabase.from("contacts").delete().eq("id", id);
  return error?.message ?? null;
}