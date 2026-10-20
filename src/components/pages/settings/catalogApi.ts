/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

export interface TierDuration { id?: string; months: number; discount_pct: number; sort: number; }
export interface ProductTier { id?: string; name: string; price: number; sort: number; durations: TierDuration[]; }
export interface Product {
  id?: string;
  name: string;
  /** A product kind from your list (Settings › Catalog), e.g. "SaaS", "Physical". */
  kind: string;
  billing: "one_time" | "recurring";
  billing_period?: "monthly" | "yearly"; // only meaningful when recurring
  description?: string | null;
  active?: boolean;
  /** Offered when building proposals (13_proposal_decks.sql; missing = yes). */
  in_proposals?: boolean;
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
  /** Legacy: the time was supervision. Replaced by role_id (migrated to the supervision role). */
  is_supervision?: boolean | null;
  /** Services: the role this variable's time is billed as (empty = the service's main role). */
  role_id?: string | null;
  /** Loaded only: the service's price for role_id (what the row bills at when rate is empty). */
  role_rate?: number | null;
  /** Services: rate per day/hour for this variable's time (empty = the line's rate). */
  rate?: number | null;
}
export interface Calculator {
  id?: string;
  owner_type: "product" | "service";
  owner_id?: string;
  name: string;
  include_base: boolean;
  output_kind: "price" | "quantity";
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
export interface CalcDiscount { mode: "none" | "percent" | "amount"; value: number; }
export interface CalcRow { key: string; label: string; detail: string; amount: number; discount: number; net: number; }
export const BASE_KEY = "__base";
export function discountOf(amount: number, d?: CalcDiscount | null): number {
  if (!d || d.mode === "none") return 0;
  const v = Number(d.value) || 0;
  const raw = d.mode === "percent" ? amount * (v / 100) : v;
  return Math.min(Math.max(raw, 0), Math.max(amount, 0));
}
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
    // Duration calculators: the time of a row can be set by hand on the deal
    // (e.g. the supervision days), stored as "<key>@days" in the values.
    const ov = values[`${key}@days`];
    if (calc.output_kind === "quantity" && ov != null) {
      add = Math.max(0, Number(ov) || 0);
      detail = `set to ${add}`;
    }
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

export interface ServiceRole {
  id?: string; role_id: string; price: number; sort: number;
  /** The service's main role: where time goes when nothing else says which role. */
  is_main?: boolean;
}
export interface Service {
  id?: string;
  name: string;
  rate_unit: "hour" | "day";
  /** Smallest amount that can be booked against this service, in rate_unit. */
  min_unit?: number;
  blueprint_id?: string | null;
  description?: string | null;
  active?: boolean;
  /** Offered when building proposals (13_proposal_decks.sql; missing = yes). */
  in_proposals?: boolean;
  roles: ServiceRole[];
  calculator?: Calculator | null;
}

// ---- Calculators: load + save (shared by products and services) ----
async function loadCalculatorsFor(ownerType: "product" | "service"): Promise<Record<string, Calculator>> {
  // Both at once: the variables don't need the calculator ids first (the table is small).
  const [{ data: calcs }, { data: vars }] = await Promise.all([
    supabase.from("calculators").select("*").eq("owner_type", ownerType),
    supabase.from("calculator_variables").select("*").order("sort").range(0, 99999),
  ]);
  return calculatorsFromRows(calcs ?? [], vars ?? []);
}

/** Calculators by owner id, from rows already read (variables in their sort order). */
export function calculatorsFromRows(calcRows: any[], varRows: any[], ownerType?: "product" | "service"): Record<string, Calculator> {
  const varsByCalc: Record<string, CalcVariable[]> = {};
  varRows.forEach((v: any) => { (varsByCalc[v.calculator_id] ??= []).push(v); });
  const out: Record<string, Calculator> = {};
  calcRows.forEach((c: any) => { if (!ownerType || c.owner_type === ownerType) out[c.owner_id] = { ...c, variables: varsByCalc[c.id] ?? [] }; });
  return out;
}

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
      is_supervision: v.role_id ? false : !!v.is_supervision, role_id: v.role_id || null,
      rate: v.rate == null || (v.rate as any) === "" ? null : Number(v.rate),
    }));
    let { error } = await supabase.from("calculator_variables").insert(rows);
    // Before 09_roles_migration.sql the role column doesn't exist: save the rest.
    if (error && /role_id/i.test(error.message)) {
      ({ error } = await supabase.from("calculator_variables").insert(rows.map(({ role_id: _r, ...r }) => r)));
      if (!error && calc.variables.some((v) => v.role_id)) return "Saved, but the role of each row needs 09_roles_migration.sql in Supabase.";
    }
    if (error) return error.message;
  }
  return null;
}

// ---- Load everything (products with nested tiers+durations, services with tiers) ----
export async function loadProducts(): Promise<Product[]> {
  // One round trip: products, tiers, durations and calculators together.
  const [{ data: prods }, { data: tiers }, { data: durs }, calcs] = await Promise.all([
    supabase.from("products").select("*").order("created_at"),
    supabase.from("product_tiers").select("*").order("sort").range(0, 99999),
    supabase.from("product_tier_durations").select("*").order("sort").range(0, 99999),
    loadCalculatorsFor("product"),
  ]);
  return productsFromRows(prods ?? [], tiers ?? [], durs ?? [], calcs);
}

/** Products with their tiers, durations and calculators, from rows already read. */
export function productsFromRows(prods: any[], tiers: any[], durs: any[], calcs: Record<string, Calculator>): Product[] {
  const durByTier: Record<string, TierDuration[]> = {};
  durs.forEach((d: any) => { (durByTier[d.tier_id] ??= []).push(d); });
  const tiersByProduct: Record<string, ProductTier[]> = {};
  tiers.forEach((t: any) => {
    (tiersByProduct[t.product_id] ??= []).push({ ...t, durations: durByTier[t.id] ?? [] });
  });
  return prods.map((p: any) => ({ ...p, tiers: tiersByProduct[p.id] ?? [], calculator: calcs[p.id] ?? null }));
}

export async function loadServices(): Promise<Service[]> {
  const [{ data: svcs }, { data: roles }, calcs] = await Promise.all([
    supabase.from("services").select("*").order("created_at"),
    supabase.from("service_roles").select("*").order("sort").range(0, 99999),
    loadCalculatorsFor("service"),
  ]);
  return servicesFromRows(svcs ?? [], roles ?? [], calcs);
}

/** Services with their roles and calculators, from rows already read. */
export function servicesFromRows(svcs: any[], roles: any[], calcs: Record<string, Calculator>): Service[] {
  const rolesBySvc: Record<string, ServiceRole[]> = {};
  roles.forEach((r: any) => { (rolesBySvc[r.service_id] ??= []).push({ id: r.id, role_id: r.role_id, price: r.price, sort: r.sort, is_main: !!r.is_main }); });
  return svcs.map((s: any) => {
    const roles = rolesBySvc[s.id] ?? [];
    const calc = calcs[s.id] ?? null;
    // A row billed as one of the service's roles bills at that role's price unless it has its own rate.
    const calculator = calc ? {
      ...calc,
      variables: calc.variables.map((v) => {
        const r = v.role_id ? roles.find((x) => x.role_id === v.role_id) : undefined;
        return r ? { ...v, role_rate: Number(r.price) || 0 } : v;
      }),
    } : null;
    return { ...s, roles, calculator };
  });
}

/** Writes a product / service row; before 13_proposal_decks.sql there is no in_proposals column, so it retries without it. */
async function writeRow(table: "products" | "services", id: string | undefined, row: Record<string, any>): Promise<{ id?: string; error: string | null }> {
  const go = async (r: Record<string, any>) => id
    ? await supabase.from(table).update(r).eq("id", id).then(({ error }) => ({ id, error }))
    : await supabase.from(table).insert(r).select("id").single().then(({ data, error }) => ({ id: (data as any)?.id as string | undefined, error }));
  let res = await go(row);
  if (res.error && "in_proposals" in row && /in_proposals/i.test(res.error.message)) {
    const { in_proposals: _skip, ...rest } = row; void _skip;
    res = await go(rest);
  }
  return { id: res.id, error: res.error?.message ?? null };
}

// ---- Save a product (upsert product, then replace its tiers + durations) ----
export async function saveProduct(p: Product): Promise<string | null> {
  // upsert product row
  const base = { name: p.name, kind: p.kind, billing: p.billing, billing_period: p.billing_period ?? "monthly", description: p.description ?? null, active: p.active ?? true, in_proposals: p.in_proposals !== false };
  const w = await writeRow("products", p.id, base);
  if (w.error) return w.error;
  const productId = w.id;
  if (!productId) return "Could not save the product.";
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
  const base = {
    name: s.name,
    rate_unit: s.rate_unit,
    // Falls back to the usual step for the unit, so a service saved before this
    // field existed still gets a sensible value.
    min_unit: s.min_unit ?? (s.rate_unit === "hour" ? 0.5 : 0.25),
    blueprint_id: s.blueprint_id ?? null,
    description: s.description ?? null,
    active: s.active ?? true,
    in_proposals: s.in_proposals !== false,
  };
  const w = await writeRow("services", s.id, base);
  if (w.error) return w.error;
  const serviceId = w.id;
  if (!serviceId) return "Could not save the service.";
  await supabase.from("service_roles").delete().eq("service_id", serviceId);
  // exactly one main role: the starred one, else the first
  const kept = s.roles.filter((r) => r.role_id);
  const mainAt = Math.max(0, kept.findIndex((r) => r.is_main));
  for (let i = 0; i < kept.length; i++) {
    const r = kept[i];
    const { error } = await supabase.from("service_roles")
      .insert({ service_id: serviceId, role_id: r.role_id, price: r.price, sort: i, is_main: i === mainAt });
    if (error) return error.message;
  }
  return await saveCalculatorFor("service", serviceId!, s.calculator);
}

export async function deleteService(id: string): Promise<string | null> {
  const { error } = await supabase.from("services").delete().eq("id", id);
  return error?.message ?? null;
}