/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";
import type { Phase } from "../settings/pipelineApi";
import { calcBreakdown, discountOf, BASE_KEY, type Calculator, type CalcRow, type CalcDiscount } from "../settings/catalogApi";

export interface Tracking {
  id: string;
  company_id: string | null;
  pipeline_id: string | null;
  product_id: string | null;
  current_phase_id: string | null;
  status: string;
  created_at?: string;
  product_price?: number | null;
  contactIds: string[];
}

export interface TrackNote { id: string; phase_id: string | null; body: string; created_at: string; }
export interface TrackTask { id: string; phase_id: string | null; title: string; done: boolean; }
export type MeetingKind = "teams" | "phone" | "in_person";
export interface TrackMeeting { id: string; phase_id: string | null; title: string; meet_at: string | null; kind?: MeetingKind; }
export interface PhaseEvent { id: string; phase_id: string | null; entered_at: string; }
export interface RevenueLineFields {
  price: number;
  quantity?: number | null;
  recurring?: boolean;
  period?: "monthly" | "yearly" | string | null;
  term_years?: number | null;
  tier_id?: string | null;
  role_id?: string | null;
  calc_values?: Record<string, number> | null;
  calc_discounts?: Record<string, CalcDiscount> | null;
  calc_rates?: Record<string, number> | null;
  discount_mode?: "none" | "percent" | "amount" | string | null;
  discount_value?: number | null;
}

export interface PotentialService extends RevenueLineFields {
  id: string; service_id: string | null; label: string | null;
}

/**
 * Value a revenue line contributes to "total if won".
 *
 * Recurring (products whose catalogue entry says so) -> the price normalised
 * to a year (monthly prices x12) multiplied by the contract term in years.
 *
 * Everything else -> price x quantity. For services the price is the rate
 * (per hour or per day, as set in the catalogue) and the quantity is how much
 * of it we expect to sell on this deal, so the line is a real amount rather
 * than a bare fee.
 */

export interface Assignee { id: string; item_type: string; item_id: string; kind: "employee" | "contact"; employee_id: string | null; contact_id: string | null; }

/**
 * Adaptive progress %, shared by the overview list and the tracking detail
 * so the two can never drift apart again.
 *
 *   first normal phase -> 0%
 *   win phase          -> 100%
 *   loss phase         -> 0%
 *
 * When the pipeline has a win phase, 100% is reserved for it, so the last
 * normal phase lands short of the finish line (e.g. 83%). When it has none,
 * the last normal phase IS the finish line and reaches 100%.
 *
 * `phases` must be the sales-visible phases of the tracking's own pipeline,
 * in order. Relies on the builder rule of at most one win and one loss phase.
 */
export function trackingPct(phases: Phase[], currentPhaseId: string | null): number {
  if (!phases.length) return 0;
  const cur = phases.find((p) => p.id === currentPhaseId);
  if (cur?.sales_outcome === "win") return 100;
  if (cur?.sales_outcome === "loss") return 0;
  const normalPhases = phases.filter((p) => !p.sales_outcome);
  const normalIdx = normalPhases.findIndex((p) => p.id === currentPhaseId);
  if (normalIdx < 0 || normalPhases.length === 0) return 0;
  const hasWin = phases.some((p) => p.sales_outcome === "win");
  const steps = hasWin ? normalPhases.length : normalPhases.length - 1;
  if (steps <= 0) return 0;
  return Math.round((normalIdx / steps) * 100);
}

// ---- Phase entry dates ----
export async function loadPhaseEvents(trackingId: string): Promise<PhaseEvent[]> {
  const { data } = await supabase.from("tracking_phase_events").select("*").eq("tracking_id", trackingId).order("entered_at");
  return (data ?? []) as PhaseEvent[];
}
// Stamp entry into a phase (only the first time it's entered).
export async function stampPhaseEntry(trackingId: string, phaseId: string): Promise<PhaseEvent | null> {
  const { data: existing } = await supabase.from("tracking_phase_events")
    .select("id").eq("tracking_id", trackingId).eq("phase_id", phaseId).maybeSingle();
  if (existing) return null;
  const { data } = await supabase.from("tracking_phase_events")
    .insert({ tracking_id: trackingId, phase_id: phaseId }).select().single();
  return (data as any) ?? null;
}

// ---- Attached employees ----
export async function loadTrackingEmployees(trackingId: string): Promise<string[]> {
  const { data } = await supabase.from("tracking_employees").select("profile_id").eq("tracking_id", trackingId);
  return (data ?? []).map((r: any) => r.profile_id);
}
export async function addTrackingEmployee(trackingId: string, profileId: string) {
  await supabase.from("tracking_employees").insert({ tracking_id: trackingId, profile_id: profileId });
}
export async function removeTrackingEmployee(trackingId: string, profileId: string) {
  await supabase.from("tracking_employees").delete().eq("tracking_id", trackingId).eq("profile_id", profileId);
}

// ---- Products on a tracking (many per tracking) ----
export interface TrackingProduct extends RevenueLineFields {
  id: string; tracking_id: string; product_id: string | null;
}

export type TermPatch = {
  price?: number; quantity?: number; recurring?: boolean;
  period?: "monthly" | "yearly"; term_years?: number;
  tier_id?: string | null; role_id?: string | null;
  calc_values?: Record<string, number>;
  calc_discounts?: Record<string, CalcDiscount>;
  calc_rates?: Record<string, number>;
  discount_mode?: "none" | "percent" | "amount"; discount_value?: number;
};

export interface LineBreakdown {
  rows: CalcRow[];
  unitGross: number;
  unitDiscount: number;
  unitPrice: number;
  multiplierLabel: string;
  gross: number;
  discount: number;
  total: number;
}

/**
 * How the unit price is built up, row by row.
 *
 * With a price calculator the rows come from it. Without one there is a single
 * "Base price" row. Either way every row can carry its own discount, so the
 * product price and each variable can be discounted independently.
 */
export function unitBreakdown(l: RevenueLineFields, calculator?: Calculator | null, catalogBase?: number): { rows: CalcRow[]; gross: number; discount: number; net: number } {
  const discounts = l.calc_discounts ?? {};
  const rates = l.calc_rates ?? {};

  if (calculator && calculator.output_kind === "quantity") {
    // Each variable contributes time, and each block of time can be billed at
    // its own rate, so a row is "N days x rate" rather than one flat rate for
    // the whole engagement.
    const baseRate = Number(l.price) || 0;
    const timeRows = calcBreakdown(calculator, l.calc_values ?? {}, Number(calculator.base_amount) || 0);
    const rows: CalcRow[] = timeRows.rows.map((r) => {
      const rate = rates[r.key] == null ? baseRate : Number(rates[r.key]) || 0;
      const amount = r.amount * rate;
      const discount = discountOf(amount, discounts[r.key]);
      const detail = `${r.detail ? r.detail + " = " : ""}${r.amount} x ${rate}`;
      return { key: r.key, label: r.label, detail, amount, discount, net: amount - discount };
    });
    const gross = rows.reduce((s, r) => s + r.amount, 0);
    const discount = rows.reduce((s, r) => s + r.discount, 0);
    return { rows, gross, discount, net: gross - discount };
  }

  if (calculator) {
    const base = catalogBase == null ? Number(l.price) || 0 : catalogBase;
    const bd = calcBreakdown(calculator, l.calc_values ?? {}, base, discounts);
    return { rows: bd.rows, gross: bd.gross, discount: bd.discount, net: bd.total };
  }
  // No price calculator: one base row, discounted on its own.
  const amount = Number(l.price) || 0;
  const legacy: CalcDiscount | undefined = discounts[BASE_KEY]
    ?? (l.discount_mode && l.discount_mode !== "none"
      ? { mode: l.discount_mode as "percent" | "amount", value: Number(l.discount_value) || 0 }
      : undefined);
  const discount = discountOf(amount, legacy);
  return {
    rows: [{ key: BASE_KEY, label: "Base price", detail: "", amount, discount, net: amount - discount }],
    gross: amount, discount, net: amount - discount,
  };
}

/**
 * Turn a stored revenue line into the numbers shown on screen.
 *
 * (unit price rows - their discounts)  x  multiplier  =  total
 *
 * The multiplier is the contract term for recurring lines and the quantity
 * (days, hours, licences) for everything else, so a monthly line and a yearly
 * one can be compared without lying about either.
 */
export function lineBreakdown(l: RevenueLineFields, calculator?: Calculator | null, catalogBase?: number): LineBreakdown {
  const u = unitBreakdown(l, calculator, catalogBase);
  const unitPrice = u.net;
  let mult: number;
  let multiplierLabel: string;
  if (l.recurring) {
    const perYear = l.period === "monthly" ? 12 : 1;
    const years = l.term_years == null ? 1 : Number(l.term_years) || 0;
    mult = perYear * years;
    multiplierLabel = l.period === "monthly"
      ? `x 12 months x ${years} ${years === 1 ? "year" : "years"}`
      : `x ${years} ${years === 1 ? "year" : "years"}`;
  } else if (calculator?.output_kind === "quantity") {
    // The rows already include their own time, so there is nothing left to
    // multiply by.
    mult = 1;
    multiplierLabel = "";
  } else {
    const qty = l.quantity == null ? 1 : Number(l.quantity) || 0;
    mult = qty;
    multiplierLabel = qty === 1 ? "" : `x ${qty}`;
  }
  const total = unitPrice * mult;
  return {
    rows: u.rows, unitGross: u.gross, unitDiscount: u.discount, unitPrice,
    multiplierLabel, gross: u.gross * mult, discount: u.discount * mult, total,
  };
}

export function lineTotal(l: RevenueLineFields, calculator?: Calculator | null, catalogBase?: number): number {
  return lineBreakdown(l, calculator, catalogBase).total;
}
/**
 * Columns each revenue table actually has. The line calculator is shared by
 * products and services, so it can offer a key the other table lacks - sending
 * it would make PostgREST reject the whole update, silently losing every other
 * field in the same patch.
 */
const SHARED_COLS = [
  "price", "quantity", "recurring", "period", "term_years",
  "calc_values", "calc_discounts", "calc_rates", "discount_mode", "discount_value",
] as const;
const PRODUCT_COLS = [...SHARED_COLS, "tier_id"] as const;
const SERVICE_COLS = [...SHARED_COLS, "role_id"] as const;

function pick(patch: TermPatch, cols: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of cols) {
    if (k in patch) out[k] = (patch as Record<string, unknown>)[k];
  }
  return out;
}

export async function updateTrackingProduct(id: string, trackingId: string, patch: TermPatch): Promise<string | null> {
  const { error } = await supabase.from("tracking_products").update(pick(patch, PRODUCT_COLS)).eq("id", id);
  if (error) { console.error("updateTrackingProduct failed:", error.message, patch); return error.message; }
  await syncLegacyProduct(trackingId);
  return null;
}

export async function updatePotentialServiceTerm(id: string, patch: TermPatch): Promise<string | null> {
  const { error } = await supabase.from("tracking_potential_services").update(pick(patch, SERVICE_COLS)).eq("id", id);
  if (error) { console.error("updatePotentialServiceTerm failed:", error.message, patch); return error.message; }
  return null;
}

export async function loadTrackingProducts(trackingId: string): Promise<TrackingProduct[]> {
  const { data } = await supabase.from("tracking_products").select("*").eq("tracking_id", trackingId).order("created_at");
  return (data ?? []) as TrackingProduct[];
}

/**
 * Keep the legacy single-product columns on `trackings` pointing at the first
 * product. The overview filters, the kanban and the handoff payload still read
 * them, so they must not go stale while both models coexist.
 */
async function syncLegacyProduct(trackingId: string) {
  const rows = await loadTrackingProducts(trackingId);
  const first = rows[0];
  await supabase.from("trackings")
    .update({ product_id: first?.product_id ?? null, product_price: first?.price ?? null })
    .eq("id", trackingId);
}

export async function addTrackingProduct(
  trackingId: string, productId: string, price: number,
  term?: { recurring: boolean; period: "monthly" | "yearly"; term_years: number },
): Promise<TrackingProduct | null> {
  const { data } = await supabase.from("tracking_products")
    .insert({
      tracking_id: trackingId, product_id: productId, price,
      recurring: term?.recurring ?? false,
      period: term?.period ?? "yearly",
      term_years: term?.term_years ?? 1,
    }).select().single();
  await syncLegacyProduct(trackingId);
  return (data as any) ?? null;
}

export async function updateTrackingProductPrice(id: string, trackingId: string, price: number) {
  await supabase.from("tracking_products").update({ price }).eq("id", id);
  await syncLegacyProduct(trackingId);
}

export async function removeTrackingProduct(id: string, trackingId: string) {
  await supabase.from("tracking_products").delete().eq("id", id);
  await syncLegacyProduct(trackingId);
}

// ---- Trackings ----
export async function listTrackings(): Promise<Tracking[]> {
  const { data: rows } = await supabase.from("trackings").select("*").order("created_at", { ascending: false });
  const { data: links } = await supabase.from("tracking_contacts").select("tracking_id,contact_id");
  const byTracking: Record<string, string[]> = {};
  (links ?? []).forEach((l: any) => { (byTracking[l.tracking_id] ??= []).push(l.contact_id); });
  return (rows ?? []).map((r: any) => ({ ...r, contactIds: byTracking[r.id] ?? [] }));
}

export async function createTracking(input: {
  company_id: string | null; pipeline_id: string;
  products: { id: string; price: number }[];
  current_phase_id: string | null; contactIds: string[];
}): Promise<string | null> {
  const { data, error } = await supabase.from("trackings").insert({
    company_id: input.company_id, pipeline_id: input.pipeline_id,
    // Legacy columns mirror the first product until they are retired.
    product_id: input.products[0]?.id ?? null,
    product_price: input.products[0]?.price ?? null,
    current_phase_id: input.current_phase_id, status: "active",
  }).select("id").single();
  if (error) return null;
  const id = data.id as string;
  if (input.contactIds.length) {
    await supabase.from("tracking_contacts").insert(input.contactIds.map((cid) => ({ tracking_id: id, contact_id: cid })));
  }
  if (input.products.length) {
    await supabase.from("tracking_products").insert(
      input.products.map((p) => ({ tracking_id: id, product_id: p.id, price: p.price })),
    );
  }
  return id;
}

export async function setTrackingPhase(id: string, phaseId: string) {
  await supabase.from("trackings").update({ current_phase_id: phaseId }).eq("id", id);
}
export async function setTrackingStatus(id: string, status: string) {
  await supabase.from("trackings").update({ status }).eq("id", id);
}
export async function deleteTracking(id: string) {
  await supabase.from("trackings").delete().eq("id", id);
}

// ---- Notes ----
export async function loadNotes(trackingId: string): Promise<TrackNote[]> {
  const { data } = await supabase.from("tracking_notes").select("*").eq("tracking_id", trackingId).order("created_at");
  return (data ?? []) as TrackNote[];
}
export async function addNote(trackingId: string, phaseId: string | null, body: string): Promise<TrackNote | null> {
  const { data } = await supabase.from("tracking_notes").insert({ tracking_id: trackingId, phase_id: phaseId, body }).select().single();
  return (data as any) ?? null;
}
export async function updateNote(id: string, body: string) {
  await supabase.from("tracking_notes").update({ body }).eq("id", id);
}
export async function deleteNote(id: string) {
  await supabase.from("tracking_notes").delete().eq("id", id);
}

// ---- Tasks ----
export async function loadTasks(trackingId: string): Promise<TrackTask[]> {
  const { data } = await supabase.from("tracking_tasks").select("*").eq("tracking_id", trackingId).order("created_at");
  return (data ?? []) as TrackTask[];
}
export async function addTask(trackingId: string, phaseId: string | null, title: string): Promise<TrackTask | null> {
  const { data } = await supabase.from("tracking_tasks").insert({ tracking_id: trackingId, phase_id: phaseId, title }).select().single();
  return (data as any) ?? null;
}
export async function toggleTask(id: string, done: boolean) {
  await supabase.from("tracking_tasks").update({ done }).eq("id", id);
}
export async function updateTask(id: string, title: string) {
  await supabase.from("tracking_tasks").update({ title }).eq("id", id);
}
export async function deleteTask(id: string) {
  await supabase.from("tracking_tasks").delete().eq("id", id);
}

// ---- Meetings ----
export async function loadMeetings(trackingId: string): Promise<TrackMeeting[]> {
  const { data } = await supabase.from("tracking_meetings").select("*").eq("tracking_id", trackingId).order("meet_at");
  return (data ?? []) as TrackMeeting[];
}
export async function addMeeting(trackingId: string, phaseId: string | null, title: string, meetAt: string | null, kind: MeetingKind = "in_person"): Promise<TrackMeeting | null> {
  const { data } = await supabase.from("tracking_meetings").insert({ tracking_id: trackingId, phase_id: phaseId, title, meet_at: meetAt, kind }).select().single();
  return (data as any) ?? null;
}
export async function deleteMeeting(id: string) {
  await supabase.from("tracking_meetings").delete().eq("id", id);
}
export async function updateMeeting(id: string, patch: { title?: string; meet_at?: string | null; kind?: MeetingKind }) {
  await supabase.from("tracking_meetings").update(patch).eq("id", id);
}
// ---- Revenue potential ----
export async function setProductPrice(trackingId: string, price: number | null) {
  await supabase.from("trackings").update({ product_price: price }).eq("id", trackingId);
}
export async function loadPotentialServices(trackingId: string): Promise<PotentialService[]> {
  const { data } = await supabase.from("tracking_potential_services").select("*").eq("tracking_id", trackingId).order("created_at");
  return (data ?? []) as PotentialService[];
}
export async function addPotentialService(trackingId: string, serviceId: string | null, label: string | null, price: number): Promise<PotentialService | null> {
  const { data } = await supabase.from("tracking_potential_services")
    .insert({ tracking_id: trackingId, service_id: serviceId, label, price }).select().single();
  return (data as any) ?? null;
}
export async function updatePotentialService(id: string, price: number) {
  await supabase.from("tracking_potential_services").update({ price }).eq("id", id);
}
export async function deletePotentialService(id: string) {
  await supabase.from("tracking_potential_services").delete().eq("id", id);
}

// ---- Item assignees (multiple employees + contacts per item) ----
export async function loadAssignees(trackingId: string, itemIds: string[]): Promise<Record<string, Assignee[]>> {
  if (!itemIds.length) return {};
  const { data } = await supabase.from("tracking_assignees").select("*").in("item_id", itemIds);
  const out: Record<string, Assignee[]> = {};
  (data ?? []).forEach((a: any) => { (out[a.item_id] ??= []).push(a); });
  return out;
}
export async function addAssignee(itemType: string, itemId: string, kind: "employee" | "contact", refId: string): Promise<Assignee | null> {
  const row: any = { item_type: itemType, item_id: itemId, kind };
  if (kind === "employee") row.employee_id = refId; else row.contact_id = refId;
  const { data } = await supabase.from("tracking_assignees").insert(row).select().single();
  return (data as any) ?? null;
}
export async function removeAssignee(id: string) {
  await supabase.from("tracking_assignees").delete().eq("id", id);
}

// Remove phase-entry stamps for phases beyond the given one (when going back).
export async function clearPhaseEventsAfter(trackingId: string, keepPhaseIds: string[]) {
  const { data } = await supabase.from("tracking_phase_events").select("id,phase_id").eq("tracking_id", trackingId);
  const toDelete = (data ?? []).filter((e: any) => e.phase_id && !keepPhaseIds.includes(e.phase_id)).map((e: any) => e.id);
  if (toDelete.length) await supabase.from("tracking_phase_events").delete().in("id", toDelete);
  return toDelete;
}
// ---- Handoffs (sent from sales to management) ----
export interface HandoffService {
  label: string;
  kind?: "product" | "service";
  price: number;
  /** Before and after the discount, already multiplied by term or quantity. */
  gross?: number;
  discount?: number;
  /** How the price was built up, so management can see the variables. */
  rows?: { label: string; detail: string; amount: number; discount: number; days?: number; rate?: number }[];
  /** Days or hours sold, so management can prefill the project without guessing. */
  days?: number;
  /** Rate per day/hour behind that price. */
  rate?: number;
}
export interface Handoff {
  id: string;
  tracking_id: string | null;
  company_id: string | null;
  company_name: string | null;
  product_id: string | null;
  dest_pipeline_id: string | null;
  dest_pipeline_name: string | null;
  services: HandoffService[];
  potential_value: number;
  status: string;
  created_client_id: string | null;
  created_project_id: string | null;
  created_at: string;
  converted_at: string | null;
}

// Create one handoff row per destination pipeline.
export async function createHandoffs(input: {
  tracking_id: string;
  company_id: string | null;
  company_name: string | null;
  product_id: string | null;
  /** Each destination carries only what belongs to it. */
  destinations: { id: string; name: string; services: HandoffService[]; potential_value: number }[];
}): Promise<number> {
  const rows = input.destinations.map((d) => ({
    tracking_id: input.tracking_id,
    company_id: input.company_id,
    company_name: input.company_name,
    product_id: input.product_id,
    dest_pipeline_id: d.id,
    dest_pipeline_name: d.name,
    services: d.services,
    potential_value: Math.round(d.potential_value),
    status: "pending",
  }));
  if (!rows.length) return 0;
  const { error } = await supabase.from("handoffs").insert(rows);
  return error ? 0 : rows.length;
}

/** Every handoff ever created for this deal, whatever its state. */
export async function loadTrackingHandoffs(trackingId: string): Promise<Handoff[]> {
  const { data } = await supabase.from("handoffs").select("*").eq("tracking_id", trackingId).order("created_at");
  return (data ?? []) as Handoff[];
}

export async function listHandoffs(status = "pending"): Promise<Handoff[]> {
  const { data } = await supabase.from("handoffs").select("*").eq("status", status).order("created_at", { ascending: false });
  return (data ?? []) as Handoff[];
}

export async function markHandoffConverted(id: string, clientId: string, projectId?: string) {
  await supabase.from("handoffs").update({
    status: "converted",
    created_client_id: clientId,
    created_project_id: projectId ?? null,
    converted_at: new Date().toISOString(),
  }).eq("id", id);
}
export async function dismissHandoff(id: string) {
  await supabase.from("handoffs").update({ status: "dismissed" }).eq("id", id);
}