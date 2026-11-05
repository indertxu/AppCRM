/* eslint-disable @typescript-eslint/no-explicit-any */
/* =====================================================================
   BASE · services for the simple catalog (Settings › Products & Services).
   A service = a name, its steps and how it bills (src/base/sql/102_base_service_billing.sql):
     services.billing  upfront | by_step | monthly | hourly | daily
     services.price    the fixed price, the monthly fee or the rate
     steps             phase_blueprints.phases of the service's blueprint (services.blueprint_id) —
                       the same template Enterprise uses for project phases, so it reads them too.
   Saving only writes these fields (and rate_unit, kept in step with hourly / daily); whatever
   Enterprise keeps on a service (roles & their prices, calculator, description…) is left alone.
   ===================================================================== */
import { supabase } from "../../../components/api/supabase";

export type ServiceBilling = "upfront" | "by_step" | "monthly" | "hourly" | "daily";
export interface ServiceStep { id: string; name: string; percent: number; tasks?: any[] }
export interface BaseService {
  id?: string;
  name: string;
  billing: ServiceBilling;
  price: number;
  steps: ServiceStep[];
  blueprintId?: string | null;
}

export const BILLING: { v: ServiceBilling; label: string; hint: string; priceLabel: string; unit: string }[] = [
  { v: "upfront", label: "Upfront", hint: "One fixed price, billed before the work starts.", priceLabel: "Total price", unit: "billed upfront" },
  { v: "by_step", label: "By step", hint: "One fixed price, billed as each step is done.", priceLabel: "Total price", unit: "billed by step" },
  { v: "monthly", label: "Monthly", hint: "A monthly fee while the service runs.", priceLabel: "Monthly fee", unit: "/ month" },
  { v: "hourly", label: "Per hour", hint: "Billed by the hours worked.", priceLabel: "Rate", unit: "/ hour" },
  { v: "daily", label: "Per day", hint: "Billed by the days worked.", priceLabel: "Rate", unit: "/ day" },
];
export const billingOf = (b: ServiceBilling) => BILLING.find((x) => x.v === b) ?? BILLING[3];

export const newStep = (name = ""): ServiceStep => ({ id: crypto.randomUUID(), name, percent: 0, tasks: [] });
/** Even split that always adds up to 100 (the last step takes the rounding). */
export function evenPercents(steps: ServiceStep[]): ServiceStep[] {
  if (!steps.length) return steps;
  const each = Math.floor((100 / steps.length) * 10) / 10;
  return steps.map((s, i) => ({ ...s, percent: i === steps.length - 1 ? Math.round((100 - each * (steps.length - 1)) * 10) / 10 : each }));
}

export async function loadBaseServices(): Promise<BaseService[]> {
  const { data: svcs, error } = await supabase.from("services").select("*").order("created_at");
  if (error) throw error;
  const ids = [...new Set((svcs ?? []).map((s: any) => s.blueprint_id).filter(Boolean))];
  const { data: bps } = ids.length ? await supabase.from("phase_blueprints").select("id, phases").in("id", ids) : { data: [] as any[] };
  const phasesOf = new Map((bps ?? []).map((b: any) => [b.id, (b.phases ?? []) as any[]]));
  return (svcs ?? []).map((s: any) => ({
    id: s.id,
    name: s.name ?? "",
    billing: (s.billing as ServiceBilling) ?? (s.rate_unit === "day" ? "daily" : "hourly"),
    price: Number(s.price) || 0,
    blueprintId: s.blueprint_id ?? null,
    steps: (phasesOf.get(s.blueprint_id) ?? []).map((p: any) => ({ id: p.id ?? crypto.randomUUID(), name: p.name ?? "", percent: Number(p.percent) || 0, tasks: p.tasks ?? [] })),
  }));
}

/** Saves the service and its steps; returns the saved service or an error message. */
export async function saveBaseService(s: BaseService): Promise<BaseService | string> {
  const row = { name: s.name.trim(), billing: s.billing, price: Number(s.price) || 0, rate_unit: s.billing === "daily" ? "day" : "hour" };
  let id = s.id;
  if (id) {
    const { error } = await supabase.from("services").update(row).eq("id", id);
    if (error) return error.message;
  } else {
    const { data, error } = await supabase.from("services").insert({ ...row, active: true }).select("id").single();
    if (error) return error.message;
    id = (data as any).id as string;
  }
  // the steps: the service's own blueprint (a blueprint shared with other services gets a copy, so they don't change)
  const phases = s.steps.map((st) => ({ id: st.id, name: st.name.trim(), percent: Number(st.percent) || 0, tasks: st.tasks ?? [] }));
  let bpId = s.blueprintId ?? null;
  if (bpId) {
    const { count } = await supabase.from("services").select("id", { count: "exact", head: true }).eq("blueprint_id", bpId);
    if ((count ?? 0) > 1) bpId = null;
  }
  if (bpId) {
    const { error } = await supabase.from("phase_blueprints").update({ name: row.name, phases, service_id: id }).eq("id", bpId);
    if (error) return error.message;
  } else if (phases.length) {
    const { data, error } = await supabase.from("phase_blueprints").insert({ name: row.name, phases, service_id: id }).select("id").single();
    if (error) return error.message;
    bpId = (data as any).id as string;
    const { error: e2 } = await supabase.from("services").update({ blueprint_id: bpId }).eq("id", id);
    if (e2) return e2.message;
  }
  return { ...s, id, name: row.name, blueprintId: bpId, steps: phases };
}

export async function deleteBaseService(s: BaseService): Promise<string | null> {
  if (!s.id) return null;
  const { error } = await supabase.from("services").delete().eq("id", s.id);
  if (error) return /foreign|violates|referenc/i.test(error.message) ? "It's used on clients or projects, so it can't be deleted." : error.message;
  // its own steps go with it (a blueprint other services still use stays)
  if (s.blueprintId) {
    const { count } = await supabase.from("services").select("id", { count: "exact", head: true }).eq("blueprint_id", s.blueprintId);
    if (!count) await supabase.from("phase_blueprints").delete().eq("id", s.blueprintId);
  }
  return null;
}
