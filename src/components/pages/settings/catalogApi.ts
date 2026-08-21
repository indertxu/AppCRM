/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

export interface TierDuration { id?: string; months: number; discount_pct: number; sort: number; }
export interface ProductTier { id?: string; name: string; price: number; sort: number; durations: TierDuration[]; }
export interface Product {
  id?: string;
  name: string;
  kind: "physical" | "saas";
  billing: "one_time" | "recurring";
  billing_period?: "monthly" | "yearly"; // only meaningful when recurring
  description?: string | null;
  active?: boolean;
  tiers: ProductTier[];
}
export interface ServiceRole { id?: string; role_id: string; price: number; sort: number; }
export interface Service {
  id?: string;
  name: string;
  rate_unit: "hour" | "day";
  blueprint_id?: string | null;
  description?: string | null;
  active?: boolean;
  roles: ServiceRole[];
}

// ---- Load everything (products with nested tiers+durations, services with tiers) ----
export async function loadProducts(): Promise<Product[]> {
  const { data: prods } = await supabase.from("products").select("*").order("created_at");
  const { data: tiers } = await supabase.from("product_tiers").select("*").order("sort");
  const { data: durs } = await supabase.from("product_tier_durations").select("*").order("sort");
  const durByTier: Record<string, TierDuration[]> = {};
  (durs ?? []).forEach((d: any) => { (durByTier[d.tier_id] ??= []).push(d); });
  const tiersByProduct: Record<string, ProductTier[]> = {};
  (tiers ?? []).forEach((t: any) => {
    (tiersByProduct[t.product_id] ??= []).push({ ...t, durations: durByTier[t.id] ?? [] });
  });
  return (prods ?? []).map((p: any) => ({ ...p, tiers: tiersByProduct[p.id] ?? [] }));
}

export async function loadServices(): Promise<Service[]> {
  const { data: svcs } = await supabase.from("services").select("*").order("created_at");
  const { data: roles } = await supabase.from("service_roles").select("*").order("sort");
  const rolesBySvc: Record<string, ServiceRole[]> = {};
  (roles ?? []).forEach((r: any) => { (rolesBySvc[r.service_id] ??= []).push({ id: r.id, role_id: r.role_id, price: r.price, sort: r.sort }); });
  return (svcs ?? []).map((s: any) => ({ ...s, roles: rolesBySvc[s.id] ?? [] }));
}

// ---- Save a product (upsert product, then replace its tiers + durations) ----
export async function saveProduct(p: Product): Promise<string | null> {
  // upsert product row
  const base = { name: p.name, kind: p.kind, billing: p.billing, billing_period: p.billing_period ?? "monthly", description: p.description ?? null, active: p.active ?? true };
  let productId = p.id;
  if (productId) {
    const { error } = await supabase.from("products").update(base).eq("id", productId);
    if (error) return error.message;
  } else {
    const { data, error } = await supabase.from("products").insert(base).select("id").single();
    if (error) return error.message;
    productId = data.id;
  }
  // wipe & rewrite tiers (simplest correct approach for a small editor)
  await supabase.from("product_tiers").delete().eq("product_id", productId);
  for (let i = 0; i < p.tiers.length; i++) {
    const t = p.tiers[i];
    const { data: tierRow, error: tErr } = await supabase.from("product_tiers")
      .insert({ product_id: productId, name: t.name, price: t.price, sort: i })
      .select("id").single();
    if (tErr) return tErr.message;
    if (p.billing === "recurring" && t.durations.length) {
      const rows = t.durations.map((d, j) => ({
        tier_id: tierRow.id, months: d.months, discount_pct: d.discount_pct, sort: j,
      }));
      const { error: dErr } = await supabase.from("product_tier_durations").insert(rows);
      if (dErr) return dErr.message;
    }
  }
  return null;
}

export async function deleteProduct(id: string): Promise<string | null> {
  const { error } = await supabase.from("products").delete().eq("id", id);
  return error?.message ?? null;
}

// ---- Save a service (upsert service, then replace its tiers) ----
export async function saveService(s: Service): Promise<string | null> {
  const base = { name: s.name, rate_unit: s.rate_unit, blueprint_id: s.blueprint_id ?? null, description: s.description ?? null, active: s.active ?? true };
  let serviceId = s.id;
  if (serviceId) {
    const { error } = await supabase.from("services").update(base).eq("id", serviceId);
    if (error) return error.message;
  } else {
    const { data, error } = await supabase.from("services").insert(base).select("id").single();
    if (error) return error.message;
    serviceId = data.id;
  }
  await supabase.from("service_roles").delete().eq("service_id", serviceId);
  for (let i = 0; i < s.roles.length; i++) {
    const r = s.roles[i];
    if (!r.role_id) continue;
    const { error } = await supabase.from("service_roles")
      .insert({ service_id: serviceId, role_id: r.role_id, price: r.price, sort: i });
    if (error) return error.message;
  }
  return null;
}

export async function deleteService(id: string): Promise<string | null> {
  const { error } = await supabase.from("services").delete().eq("id", id);
  return error?.message ?? null;
}