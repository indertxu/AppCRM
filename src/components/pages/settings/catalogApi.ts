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
  calculator?: Calculator | null;
}
// ---- Calculator (optional, one per product or service) ----
export type CalcVarType = "per_unit" | "per_block" | "fixed" | "percent";
export interface CalcVariable {
  id?: string;
  name: string;
  unit_label?: string | null;
  var_type: CalcVarType;
  amount: number;
  block_size: number;
  included: number;
  default_value: number;
  round_mode: "up" | "down";
  sort: number;
}
export interface Calculator {
  id?: string;
  owner_type: "product" | "service";
  owner_id?: string;
  name: string;
  include_base: boolean;
  /**
   * What the calculator produces. Products price themselves, so they compute
   * money. Services already price themselves through their role rates, so what
   * they need computed is the length of the engagement in their own rate unit.
   */
  output_kind: "price" | "quantity";
  /** Starting point for quantity calculators (days or hours before variables). */
  base_amount: number;
  variables: CalcVariable[];
}

export const emptyCalculator = (owner_type: "product" | "service"): Calculator => ({
  owner_type,
  name: owner_type === "service" ? "Duration calculator" : "Price calculator",
  include_base: true,
  output_kind: owner_type === "service" ? "quantity" : "price",
  base_amount: 0,
  variables: [],
});

export const emptyCalcVariable = (sort: number): CalcVariable => ({
  name: "", unit_label: "", var_type: "per_unit",
  amount: 0, block_size: 25, included: 0, default_value: 0, round_mode: "up", sort,
});

/**
 * Run a calculator.
 *
 * per_unit  -> amount for every unit above `included`
 * per_block -> amount for every `block_size` units above `included`,
 *              counting started blocks by default (round_mode 'up')
 * fixed     -> amount once, if the variable is switched on (value not 0)
 * percent   -> amount % of the base price
 *
 * Percentages always apply to the base price, never to the running subtotal,
 * so the order of the variables can never change the result.
 */
export interface CalcDiscount { mode: "none" | "percent" | "amount"; value: number; }
export interface CalcRow { key: string; label: string; detail: string; amount: number; discount: number; net: number; }

/** Key used for the base price row, so it can carry a discount like any variable. */
export const BASE_KEY = "__base";

export function discountOf(amount: number, d?: CalcDiscount | null): number {
  if (!d || d.mode === "none") return 0;
  const v = Number(d.value) || 0;
  const raw = d.mode === "percent" ? amount * (v / 100) : v;
  return Math.min(Math.max(raw, 0), Math.max(amount, 0));
}

/**
 * Same maths as calcTotal, but returns every step so it can be shown as a
 * receipt, and lets each step carry its own discount.
 */
export function calcBreakdown(
  calc: Calculator,
  values: Record<string, number>,
  basePrice: number,
  discounts: Record<string, CalcDiscount> = {},
): { rows: CalcRow[]; gross: number; discount: number; total: number } {
  const rows: CalcRow[] = [];
  const push = (key: string, label: string, detail: string, amount: number) => {
    const discount = discountOf(amount, discounts[key]);
    rows.push({ key, label, detail, amount, discount, net: amount - discount });
  };
  let total = calc.include_base ? basePrice : 0;
  if (calc.include_base) push(BASE_KEY, "Base", "", basePrice);
  for (const v of calc.variables) {
    const key = v.id ?? String(v.sort);
    const raw = values[key];
    const val = raw == null ? Number(v.default_value) || 0 : Number(raw) || 0;
    const amt = Number(v.amount) || 0;
    const unit = v.unit_label || "units";
    let add = 0;
    let detail = "";
    if (v.var_type === "fixed") {
      if (!val) continue;
      add = amt;
      detail = "once";
    } else if (v.var_type === "percent") {
      add = basePrice * (amt / 100);
      detail = `${amt}% of base`;
    } else {
      const inc = Number(v.included) || 0;
      const billable = Math.max(0, val - inc);
      if (billable <= 0) continue;
      if (v.var_type === "per_unit") {
        add = billable * amt;
        detail = inc ? `${val} - ${inc} incl. = ${billable} ${unit} x ${amt}` : `${billable} ${unit} x ${amt}`;
      } else {
        const size = Number(v.block_size) || 1;
        const blocks = v.round_mode === "down" ? Math.floor(billable / size) : Math.ceil(billable / size);
        if (blocks <= 0) continue;
        add = blocks * amt;
        detail = `${billable} ${unit} = ${blocks} x ${size} block${blocks === 1 ? "" : "s"} x ${amt}`;
      }
    }
    total += add;
    push(key, v.name || "Variable", detail, add);
  }
  const gross = rows.reduce((s, r) => s + r.amount, 0);
  const discount = rows.reduce((s, r) => s + r.discount, 0);
  return { rows, gross, discount, total: gross - discount };
}

export function calcTotal(calc: Calculator, values: Record<string, number>, basePrice: number): number {
  let total = calc.include_base ? basePrice : 0;
  for (const v of calc.variables) {
    const key = v.id ?? String(v.sort);
    const raw = values[key];
    const val = raw == null ? Number(v.default_value) || 0 : Number(raw) || 0;
    if (v.var_type === "fixed") {
      if (val) total += Number(v.amount) || 0;
    } else if (v.var_type === "percent") {
      total += basePrice * ((Number(v.amount) || 0) / 100);
    } else {
      const billable = Math.max(0, val - (Number(v.included) || 0));
      if (v.var_type === "per_unit") {
        total += billable * (Number(v.amount) || 0);
      } else {
        const size = Number(v.block_size) || 1;
        const blocks = v.round_mode === "down" ? Math.floor(billable / size) : Math.ceil(billable / size);
        total += blocks * (Number(v.amount) || 0);
      }
    }
  }
  return total;
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
  calculator?: Calculator | null;
}

// ---- Calculators: load + save (shared by products and services) ----
async function loadCalculatorsFor(ownerType: "product" | "service"): Promise<Record<string, Calculator>> {
  const { data: calcs } = await supabase.from("calculators").select("*").eq("owner_type", ownerType);
  const ids = (calcs ?? []).map((c: any) => c.id);
  const { data: vars } = ids.length
    ? await supabase.from("calculator_variables").select("*").in("calculator_id", ids).order("sort")
    : { data: [] as any[] };
  const varsByCalc: Record<string, CalcVariable[]> = {};
  (vars ?? []).forEach((v: any) => { (varsByCalc[v.calculator_id] ??= []).push(v); });
  const out: Record<string, Calculator> = {};
  (calcs ?? []).forEach((c: any) => { out[c.owner_id] = { ...c, variables: varsByCalc[c.id] ?? [] }; });
  return out;
}

// Upsert the calculator and replace its variables. A null calculator deletes it.
async function saveCalculatorFor(ownerType: "product" | "service", ownerId: string, calc: Calculator | null | undefined): Promise<string | null> {
  if (!calc) {
    await supabase.from("calculators").delete().eq("owner_type", ownerType).eq("owner_id", ownerId);
    return null;
  }
  const { data: existing } = await supabase.from("calculators")
    .select("id").eq("owner_type", ownerType).eq("owner_id", ownerId).maybeSingle();
  let calcId = existing?.id as string | undefined;
  const base = {
    name: calc.name || "Price calculator",
    include_base: calc.include_base ?? true,
    output_kind: calc.output_kind ?? "price",
    base_amount: calc.base_amount ?? 0,
  };
  if (calcId) {
    const { error } = await supabase.from("calculators").update(base).eq("id", calcId);
    if (error) return error.message;
  } else {
    const { data, error } = await supabase.from("calculators")
      .insert({ ...base, owner_type: ownerType, owner_id: ownerId }).select("id").single();
    if (error) return error.message;
    calcId = data.id;
  }
  await supabase.from("calculator_variables").delete().eq("calculator_id", calcId);
  if (calc.variables.length) {
    const rows = calc.variables.map((v, i) => ({
      calculator_id: calcId, name: v.name || "", unit_label: v.unit_label || null,
      var_type: v.var_type, amount: v.amount || 0, block_size: v.block_size || 1,
      included: v.included || 0, default_value: v.default_value || 0,
      round_mode: v.round_mode || "up", sort: i,
    }));
    const { error } = await supabase.from("calculator_variables").insert(rows);
    if (error) return error.message;
  }
  return null;
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
  const calcs = await loadCalculatorsFor("product");
  return (prods ?? []).map((p: any) => ({ ...p, tiers: tiersByProduct[p.id] ?? [], calculator: calcs[p.id] ?? null }));
}

export async function loadServices(): Promise<Service[]> {
  const { data: svcs } = await supabase.from("services").select("*").order("created_at");
  const { data: roles } = await supabase.from("service_roles").select("*").order("sort");
  const rolesBySvc: Record<string, ServiceRole[]> = {};
  (roles ?? []).forEach((r: any) => { (rolesBySvc[r.service_id] ??= []).push({ id: r.id, role_id: r.role_id, price: r.price, sort: r.sort }); });
  const calcs = await loadCalculatorsFor("service");
  return (svcs ?? []).map((s: any) => ({ ...s, roles: rolesBySvc[s.id] ?? [], calculator: calcs[s.id] ?? null }));
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
  return await saveCalculatorFor("product", productId!, p.calculator);
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
  return await saveCalculatorFor("service", serviceId!, s.calculator);
}

export async function deleteService(id: string): Promise<string | null> {
  const { error } = await supabase.from("services").delete().eq("id", id);
  return error?.message ?? null;
}