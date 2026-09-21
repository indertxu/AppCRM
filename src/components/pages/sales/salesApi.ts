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
  rep_close_prob?: number | null;
  mgr_close_prob?: number | null;
  rep_close_date?: string | null;
  mgr_close_date?: string | null;
  loss_reason?: string | null;
  loss_details?: string | null;
  contactIds: string[];
}

export interface TrackNote { id: string; phase_id: string | null; body: string; created_at: string; }
export interface TrackTask { id: string; phase_id: string | null; title: string; done: boolean; due_at?: string | null; created_at?: string; }
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
  version_group?: string | null; version_active?: boolean;
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

// ============================================================================
// Paste into src/components/pages/sales/salesApi.ts, next to the existing
// loadTrackingEmployees / addTrackingEmployee / removeTrackingEmployee block.
//
// These went missing when the meetings work replaced the file. They are what
// TrackingDetail ("Who is on this deal") and SalesPage (filtering deals for
// reps) import.
// ============================================================================

/** Who is on each tracking, for the whole list at once. */
export async function loadAllTrackingEmployees(): Promise<Record<string, string[]>> {
  const { data } = await supabase.from("tracking_employees").select("tracking_id, profile_id");
  const out: Record<string, string[]> = {};
  (data ?? []).forEach((r: any) => { (out[r.tracking_id] ??= []).push(r.profile_id); });
  return out;
}

/** Replace the whole team of a tracking in one go. */
export async function setTrackingEmployees(trackingId: string, profileIds: string[]) {
  await supabase.from("tracking_employees").delete().eq("tracking_id", trackingId);
  if (profileIds.length) {
    await supabase.from("tracking_employees")
      .insert(profileIds.map((p) => ({ tracking_id: trackingId, profile_id: p })));
  }
}

// ---- Products on a tracking (many per tracking) ----
export interface TrackingProduct extends RevenueLineFields {
  id: string; tracking_id: string; product_id: string | null;
  version_group?: string | null; version_active?: boolean;
}

export type TermPatch = {
  price?: number; quantity?: number; recurring?: boolean;
  period?: "monthly" | "yearly"; term_years?: number;
  tier_id?: string | null; role_id?: string | null;
  calc_values?: Record<string, number>;
  calc_discounts?: Record<string, CalcDiscount>;
  calc_rates?: Record<string, number>;
  discount_mode?: "none" | "percent" | "amount"; discount_value?: number;
  billing_contact_name?: string | null; billing_contact_email?: string | null;
  contact_ids?: string[];
};

/**
 * Round a quantity up to the next multiple of the service's smallest billable
 * unit. The calculator can land anywhere - 20.1 days, 39.9 hours - but only
 * multiples of the minimum can actually be sold, and that rounded figure is
 * what management receives and what the project is built from.
 */
export function billableQty(raw: number, minUnit?: number | null): number {
  const q = Number(raw) || 0;
  const m = Number(minUnit) || 0;
  if (m <= 0) return q;
  return +(Math.ceil(q / m) * m).toFixed(4);
}

export interface LineBreakdown {
  rows: CalcRow[];
  /** What the calculator produced, before rounding to the billable unit. */
  rawQty: number;
  /** The quantity actually charged: rawQty rounded up to the minimum unit. */
  qty: number;
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
export function lineBreakdown(l: RevenueLineFields, calculator?: Calculator | null, catalogBase?: number, minUnit?: number | null): LineBreakdown {
  const u = unitBreakdown(l, calculator, catalogBase);
  const unitPrice = u.net;
  const rawQty = l.quantity == null ? 1 : Number(l.quantity) || 0;
  const qty = billableQty(rawQty, minUnit);
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
    // Charged on the rounded quantity, so the money always matches the days
    // that reach the project.
    mult = qty;
    multiplierLabel = qty === 1 ? "" : `x ${qty}`;
  }
  const total = unitPrice * mult;
  return {
    rows: u.rows, rawQty, qty, unitGross: u.gross, unitDiscount: u.discount, unitPrice,
    multiplierLabel, gross: u.gross * mult, discount: u.discount * mult, total,
  };
}

export function lineTotal(l: RevenueLineFields, calculator?: Calculator | null, catalogBase?: number, minUnit?: number | null): number {
  return lineBreakdown(l, calculator, catalogBase, minUnit).total;
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
const SERVICE_COLS = [...SHARED_COLS, "role_id", "billing_contact_name", "billing_contact_email", "contact_ids"] as const;

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
  versionGroup?: string | null,
): Promise<TrackingProduct | null> {
  const { data } = await supabase.from("tracking_products")
    .insert({
      tracking_id: trackingId, product_id: productId, price,
      version_group: versionGroup ?? crypto.randomUUID(), version_active: true,
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
export async function addTask(trackingId: string, phaseId: string | null, title: string, dueAt?: string | null): Promise<TrackTask | null> {
  const { data } = await supabase.from("tracking_tasks").insert({ tracking_id: trackingId, phase_id: phaseId, title, due_at: dueAt ?? null }).select().single();
  return (data as any) ?? null;
}
export async function toggleTask(id: string, done: boolean) {
  await supabase.from("tracking_tasks").update({ done }).eq("id", id);
}
export async function updateTask(id: string, patch: { title?: string; due_at?: string | null }) {
  await supabase.from("tracking_tasks").update(patch).eq("id", id);
}
export async function deleteTask(id: string) {
  await supabase.from("tracking_tasks").delete().eq("id", id);
}

// ---- Meetings ----
/**
 * Meetings live in calendar_entries with everyone else's time, so a meeting
 * booked from the sales calendar shows up on the deal and the other way round.
 */
export async function loadMeetings(trackingId: string): Promise<TrackMeeting[]> {
  const { data } = await supabase.from("calendar_entries")
    .select("id, phase_id_ref, title, entry_date, start_min, meeting_kind")
    .eq("tracking_id", trackingId).eq("kind", "meeting")
    .order("entry_date").order("start_min");
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    phase_id: r.phase_id_ref,
    title: r.title,
    meet_at: `${r.entry_date}T${String(Math.floor(r.start_min / 60)).padStart(2, "0")}:${String(r.start_min % 60).padStart(2, "0")}:00`,
    kind: (r.meeting_kind ?? "in_person") as MeetingKind,
  }));
}
export async function addMeeting(trackingId: string, phaseId: string | null, title: string, meetAt: string | null, kind: MeetingKind = "in_person"): Promise<TrackMeeting | null> {
  const at = meetAt ? new Date(meetAt) : new Date();
  const startMin = at.getHours() * 60 + at.getMinutes();
  const { data: u } = await supabase.auth.getUser();
  const { data: trk } = await supabase.from("trackings")
    .select("company_id").eq("id", trackingId).maybeSingle();
  const { data } = await supabase.from("calendar_entries").insert({
    user_id: u?.user?.id,
    kind: "meeting",
    tracking_id: trackingId,
    phase_id_ref: phaseId,
    company_id: (trk as any)?.company_id ?? null,
    title,
    date_key: `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`,
    entry_date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`,
    start_min: startMin,
    end_min: startMin + 60,
    meeting_kind: kind,
    billable: 0,
    billing_line: "sales",
    status: "confirmed",
  }).select("id").single();
  if (!data) return null;
  return { id: data.id, phase_id: phaseId, title, meet_at: meetAt, kind };
}
export async function deleteMeeting(id: string) {
  await supabase.from("calendar_entries").delete().eq("id", id);
}
export async function updateMeeting(id: string, patch: { title?: string; meet_at?: string | null; kind?: MeetingKind }) {
  const row: Record<string, unknown> = {};
  if (patch.title != null) row.title = patch.title;
  if (patch.kind != null) row.meeting_kind = patch.kind;
  if (patch.meet_at) {
    const at = new Date(patch.meet_at);
    const startMin = at.getHours() * 60 + at.getMinutes();
    row.date_key = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
    row.entry_date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    row.start_min = startMin;
    row.end_min = startMin + 60;
  }
  await supabase.from("calendar_entries").update(row).eq("id", id);
}
// ---- Revenue potential ----
export async function setDealCloseProb(trackingId: string, which: "rep" | "mgr", value: number | null) {
  const col = which === "rep" ? "rep_close_prob" : "mgr_close_prob";
  await supabase.from("trackings").update({ [col]: value }).eq("id", trackingId);
}
export async function setDealCloseDate(trackingId: string, which: "rep" | "mgr", value: string | null) {
  const col = which === "rep" ? "rep_close_date" : "mgr_close_date";
  await supabase.from("trackings").update({ [col]: value || null }).eq("id", trackingId);
}
export async function setLossReason(trackingId: string, reason: string | null, details?: string | null) {
  await supabase.from("trackings").update({ loss_reason: reason || null, loss_details: details ?? null }).eq("id", trackingId);
}
export interface LossReason { id: string; label: string; sort: number; }
export async function listLossReasons(): Promise<LossReason[]> {
  const { data } = await supabase.from("loss_reasons").select("*").order("sort").order("created_at");
  return (data ?? []).map((r: any) => ({ id: r.id, label: r.label, sort: r.sort ?? 0 }));
}
export async function addLossReason(label: string, sort: number): Promise<LossReason | null> {
  const { data } = await supabase.from("loss_reasons").insert({ label, sort }).select().single();
  return data ? { id: data.id, label: data.label, sort: data.sort ?? 0 } : null;
}
export async function updateLossReason(id: string, label: string) {
  await supabase.from("loss_reasons").update({ label }).eq("id", id);
}
export async function deleteLossReason(id: string) {
  await supabase.from("loss_reasons").delete().eq("id", id);
}

export async function setProductPrice(trackingId: string, price: number | null) {
  await supabase.from("trackings").update({ product_price: price }).eq("id", trackingId);
}
export async function loadPotentialServices(trackingId: string): Promise<PotentialService[]> {
  const { data } = await supabase.from("tracking_potential_services").select("*").eq("tracking_id", trackingId).order("created_at");
  return (data ?? []) as PotentialService[];
}
export async function addPotentialService(trackingId: string, serviceId: string | null, label: string | null, price: number, versionGroup?: string | null): Promise<PotentialService | null> {
  const { data } = await supabase.from("tracking_potential_services")
    .insert({ tracking_id: trackingId, service_id: serviceId, label, price, version_group: versionGroup ?? crypto.randomUUID(), version_active: true }).select().single();
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

// Does management already have a client for this sales company?
// Management stores clients keyed by company_id; if none exists, sales must
// create it (with legal info) before the handoff can build a project.
export async function clientExistsForCompany(companyId: string | null): Promise<boolean> {
  if (!companyId) return false;
  const { data } = await supabase.from("clients").select("id").eq("company_id", companyId).limit(1);
  return (data?.length ?? 0) > 0;
}

// Build the prefill for the client-creation form from everything we already
// know about the company and its contacts, so sales only fills the gaps.
// New contacts added on a project (no sourceId) are also created on the
// company, so the company grows too. Existing ones (with sourceId) are left
// alone; removing a contact from the project never removes it from the company.
export async function syncNewContactsToCompany(companyId: string, contacts: { id?: string; sourceId?: string | null; name: string; position: string; email: string; phone: string; billing: boolean }[]): Promise<{ localId: string; id: string }[]> {
  const created: { localId: string; id: string }[] = [];
  const fresh = contacts.filter((c) => !c.sourceId && c.name.trim());
  for (const c of fresh) {
    const parts = c.name.trim().split(/\s+/);
    const first_name = parts.shift() ?? c.name;
    const last_name = parts.join(" ") || null;
    const { data, error } = await supabase.from("contacts")
      .insert({ first_name, last_name, position: c.position || null, email: c.email || null, phone: c.phone || null, is_billing: c.billing ?? false })
      .select("id").single();
    if (error || !data) continue;
    await supabase.from("company_contacts").insert({ company_id: companyId, contact_id: data.id });
    created.push({ localId: c.id ?? "", id: data.id });
  }
  return created;
}

// Per-DEAL contacts (scoped to one tracking, not shared across the client's
// other deals). Read the linked ids, and replace the whole set on save.
export async function loadTrackingContactIds(trackingId: string): Promise<string[]> {
  const { data } = await supabase.from("tracking_contacts").select("contact_id").eq("tracking_id", trackingId).range(0, 99999);
  return (data ?? []).map((r: any) => r.contact_id);
}
export async function setTrackingContacts(trackingId: string, contactIds: string[]): Promise<string | null> {
  const del = await supabase.from("tracking_contacts").delete().eq("tracking_id", trackingId);
  if (del.error) return del.error.message;
  const clean = Array.from(new Set(contactIds.filter(Boolean)));
  if (clean.length) {
    const { error } = await supabase.from("tracking_contacts").insert(clean.map((cid) => ({ tracking_id: trackingId, contact_id: cid })));
    if (error) return error.message;
  }
  return null;
}

export async function buildClientPrefill(companyId: string, trackingId?: string): Promise<{
  name: string;
  legalName: string;
  vatNumber: string;
  address: { street: string; number: string; details: string; postalCode: string; city: string; country: string };
  contacts: { id: string; sourceId: string | null; name: string; position: string; email: string; phone: string; billing: boolean }[];
  products: { key: string; productId: string; name: string; price: number; quantity: number; recurring: boolean; period: string | null; termYears: number | null; discountMode: string | null; discountValue: number | null; tierId: string | null; calcValues: Record<string, number>; calcDiscounts: Record<string, any>; calcRates: Record<string, number>; signingDate: string; fromTracking: boolean }[];
} | null> {
  const { data: co } = await supabase.from("companies").select("*").eq("id", companyId).maybeSingle();
  if (!co) return null;
  const c: any = co;
  // contacts linked to this company
  const { data: links } = await supabase.from("company_contacts").select("contact_id").eq("company_id", companyId);
  const ids = (links ?? []).map((l: any) => l.contact_id);
  let contacts: any[] = [];
  if (ids.length) {
    const { data: rows } = await supabase.from("contacts").select("*").in("id", ids);
    contacts = rows ?? [];
  }
  const uid = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()));
  const today = new Date().toISOString().slice(0, 10);

  // products already on the deal, priced with their discounts
  let products: any[] = [];
  if (trackingId) {
    const { data: tp } = await supabase.from("tracking_products").select("*").eq("tracking_id", trackingId).order("created_at");
    const pids = Array.from(new Set((tp ?? []).map((r: any) => r.product_id).filter(Boolean)));
    const nameById: Record<string, string> = {};
    if (pids.length) {
      const { data: prods } = await supabase.from("products").select("id, name").in("id", pids);
      (prods ?? []).forEach((p: any) => { nameById[p.id] = p.name; });
    }
    products = (tp ?? []).map((r: any) => ({
      key: uid(), productId: r.product_id, name: nameById[r.product_id] ?? "Product",
      price: Number(r.price) || 0, quantity: Number(r.quantity) || 1,
      recurring: !!r.recurring, period: r.period ?? null, termYears: r.term_years ?? null,
      discountMode: r.discount_mode ?? null, discountValue: r.discount_value ?? null,
      // raw calculator fields, so the editable calculator opens with the deal's numbers
      tierId: r.tier_id ?? null,
      calcValues: r.calc_values ?? {},
      calcDiscounts: r.calc_discounts ?? {},
      calcRates: r.calc_rates ?? {},
      signingDate: today, fromTracking: true,
    }));
  }

  return {
    name: c.name ?? "",
    legalName: c.legal_name ?? "",
    vatNumber: c.vat_number ?? "",
    address: {
      street: c.street ?? "",
      number: c.addr_number ?? "",
      details: c.addr_details ?? "",
      postalCode: c.postal_code ?? "",
      city: c.city ?? "",
      country: c.country ?? "",
    },
    contacts: contacts.map((ct: any) => ({
      id: uid(),
      sourceId: ct.id ?? null,
      name: [ct.first_name, ct.last_name].filter(Boolean).join(" "),
      position: ct.position ?? "",
      email: ct.email ?? "",
      phone: ct.phone ?? "",
      billing: ct.is_billing ?? false,
    })),
    products,
  };
}

// Full catalogue of active products (with calculator + tiers) for the picker
// and the in-form calculator. Uses the same loader the settings editor uses.
// --- Scenario C: existing client buys NEW products ---------------------
// The client already exists. Return its stored record (id + legal/address/
// contacts as we hold them) so the attach form can revise it and we can
// append new product contracts to the SAME client.
export async function loadClientByCompany(companyId: string | null): Promise<{
  id: string;
  name: string; legalName: string; vatNumber: string;
  address: { street: string; number: string; details: string; postalCode: string; city: string; country: string };
  contacts: { id: string; name: string; position: string; email: string; phone: string; billing: boolean; sourceId?: string | null }[];
  paymentDays: number | null;
} | null> {
  if (!companyId) return null;
  const { data } = await supabase.from("clients").select("*").eq("company_id", companyId).order("created_at").limit(1);
  const row: any = data?.[0];
  if (!row) return null;
  const uid = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()));
  const a = row.address ?? {};
  const cs = Array.isArray(row.contacts) ? row.contacts : [];
  return {
    id: row.id,
    name: row.name ?? "",
    legalName: row.legal_name ?? "",
    vatNumber: row.vat_number ?? "",
    address: {
      street: a.street ?? "", number: a.number ?? "", details: a.details ?? "",
      postalCode: a.postalCode ?? a.postal_code ?? "", city: a.city ?? "", country: a.country ?? "",
    },
    contacts: cs.map((ct: any) => ({
      id: ct.id ?? uid(),
      name: ct.name ?? [ct.first_name, ct.last_name].filter(Boolean).join(" "),
      position: ct.position ?? "", email: ct.email ?? "", phone: ct.phone ?? "",
      billing: ct.billing ?? ct.is_billing ?? false,
      sourceId: ct.sourceId ?? null,
    })),
    paymentDays: row.payment_days ?? null,
  };
}

// Build the attach-form prefill for scenario C: client details come from the
// stored CLIENT record (so sales revises what's on file), while the products
// are the NEW ones on this deal — carried with their full calculator state so
// the modern calculator opens on the deal's numbers.
export async function buildAttachPrefill(companyId: string, trackingId: string): Promise<{
  clientId: string;
  prefill: {
    name: string; legalName: string; vatNumber: string;
    address: { street: string; number: string; details: string; postalCode: string; city: string; country: string };
    contacts: { id: string; name: string; position: string; email: string; phone: string; billing: boolean; sourceId?: string | null }[];
    products: any[];
  };
} | null> {
  const client = await loadClientByCompany(companyId);
  if (!client) return null;
  const uid = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()));
  const today = new Date().toISOString().slice(0, 10);

  const { data: tp } = await supabase.from("tracking_products").select("*").eq("tracking_id", trackingId).order("created_at");
  const pids = Array.from(new Set((tp ?? []).map((r: any) => r.product_id).filter(Boolean)));
  const nameById: Record<string, string> = {};
  if (pids.length) {
    const { data: prods } = await supabase.from("products").select("id, name").in("id", pids);
    (prods ?? []).forEach((p: any) => { nameById[p.id] = p.name; });
  }
  const products = (tp ?? []).map((r: any) => ({
    key: uid(), productId: r.product_id, name: nameById[r.product_id] ?? "Product",
    price: Number(r.price) || 0, quantity: Number(r.quantity) || 1,
    recurring: !!r.recurring, period: r.period ?? null, termYears: r.term_years ?? null,
    discountMode: r.discount_mode ?? null, discountValue: r.discount_value ?? null,
    tierId: r.tier_id ?? null, calcValues: r.calc_values ?? {},
    calcDiscounts: r.calc_discounts ?? {}, calcRates: r.calc_rates ?? {},
    signingDate: today, fromTracking: true,
  }));

  return {
    clientId: client.id,
    prefill: {
      name: client.name, legalName: client.legalName, vatNumber: client.vatNumber,
      address: client.address, contacts: client.contacts, products,
    },
  };
}

export async function listCatalogProducts(): Promise<import("../settings/catalogApi").Product[]> {
  const { loadProducts } = await import("../settings/catalogApi");
  const all = await loadProducts();
  return all.filter((p) => p.active !== false);
}

// True once this deal's products have already been written to client_products
// (i.e. the client + products were created for THIS tracking). Used to avoid
// re-opening the create/attach flow when only the services still need sending.
export async function hasClientProductsForTracking(trackingId: string): Promise<boolean> {
  const { data } = await supabase.from("client_products").select("id").eq("tracking_id", trackingId).limit(1);
  return !!(data && data.length);
}

// Save the product contracts a client signed (one row per product).
export async function saveClientProducts(clientId: string, trackingId: string | null, products: {
  productId: string; price: number; quantity: number; recurring: boolean; period: string | null;
  termYears: number | null; discountMode: string | null; discountValue: number | null; signingDate: string;
  startDate?: string; oneTimeFee?: number; nonTerminableYears?: number | null; autoRenew?: boolean;
  renewYears?: number | null; annualIncreasePct?: number | null; paymentTermsDays?: number | null;
  contractRef?: string; externalRef?: string;
  billingContactName?: string | null; billingContactEmail?: string | null;
}[]): Promise<string | null> {
  if (!products.length) return null;
  const rows = products.map((p) => ({
    client_id: clientId, product_id: p.productId, tracking_id: trackingId,
    signing_date: p.signingDate || null,
    start_date: p.startDate || p.signingDate || null,
    price: p.price, quantity: p.quantity, recurring: p.recurring,
    period: p.period, term_years: p.termYears,
    discount_mode: p.discountMode, discount_value: p.discountValue,
    one_time_fee: p.oneTimeFee ?? 0,
    non_terminable_years: p.nonTerminableYears ?? null,
    auto_renew: p.autoRenew ?? false,
    renew_years: p.renewYears ?? null,
    annual_increase_pct: p.annualIncreasePct ?? null,
    payment_terms_days: p.paymentTermsDays ?? null,
    contract_ref: p.contractRef || null,
    external_ref: p.externalRef || null,
    billing_contact_name: p.billingContactName ?? null,
    billing_contact_email: p.billingContactEmail ?? null,
    status: "active",
  }));
  const { error } = await supabase.from("client_products").insert(rows);
  return error?.message ?? null;
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
// ---- Potential revenue per tracking, for the overview cards ----
// product_price (on the tracking) + sum of its potential services' price.
// One pass over all potential services, so it's a single query for every card.
export async function loadPotentialTotals(): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  const { data: tr } = await supabase.from("trackings").select("id, product_price");
  (tr ?? []).forEach((t: any) => { totals[t.id] = Number(t.product_price) || 0; });
  const { data: svc } = await supabase.from("tracking_potential_services").select("tracking_id, price");
  (svc ?? []).forEach((s: any) => {
    if (s.tracking_id) totals[s.tracking_id] = (totals[s.tracking_id] ?? 0) + (Number(s.price) || 0);
  });
  return totals;
}

// ============================ Per-line versioning ============================
// A version group holds all versions of one conceptual line. Exactly one is
// active; the active one shows and counts toward the total.

/** Make a different version of a group active (products or services). */
export async function setLineVersionActive(table: "tracking_products" | "tracking_potential_services", versionGroup: string, activeId: string) {
  await supabase.from(table).update({ version_active: false }).eq("version_group", versionGroup);
  await supabase.from(table).update({ version_active: true }).eq("id", activeId);
}

/** Add a new version to a product line's group — a copy of `sourceId`, or empty. */
export async function addProductVersion(sourceId: string, copy: boolean): Promise<TrackingProduct | null> {
  const { data: src } = await supabase.from("tracking_products").select("*").eq("id", sourceId).single();
  if (!src) return null;
  await supabase.from("tracking_products").update({ version_active: false }).eq("version_group", src.version_group);
  const base: any = { tracking_id: src.tracking_id, product_id: src.product_id, version_group: src.version_group, version_active: true };
  if (copy) {
    const { id, created_at, version_active, ...rest } = src as any;
    Object.assign(base, rest);
  } else {
    base.price = 0; base.recurring = src.recurring; base.period = src.period; base.term_years = 1;
  }
  const { data } = await supabase.from("tracking_products").insert(base).select().single();
  return (data as any) ?? null;
}

/** Add a new version to a service line's group — a copy of `sourceId`, or empty. */
export async function addServiceVersion(sourceId: string, copy: boolean): Promise<PotentialService | null> {
  const { data: src } = await supabase.from("tracking_potential_services").select("*").eq("id", sourceId).single();
  if (!src) return null;
  await supabase.from("tracking_potential_services").update({ version_active: false }).eq("version_group", src.version_group);
  const base: any = { tracking_id: src.tracking_id, service_id: src.service_id, label: src.label, version_group: src.version_group, version_active: true };
  if (copy) {
    const { id, created_at, version_active, ...rest } = src as any;
    Object.assign(base, rest);
  } else {
    base.price = 0;
  }
  const { data } = await supabase.from("tracking_potential_services").insert(base).select().single();
  return (data as any) ?? null;
}

// ============================ Phase blueprints (for proposals) ============================
export interface BlueprintPhase { id: string; name: string; percent: number; tasks: { id?: string; name: string; percent?: number }[] }
export interface PhaseBlueprint { id: string; name: string; service_id: string | null; phases: BlueprintPhase[] }

/** Blueprints for a set of services, keyed by service_id. Prefers the blueprint
 *  whose service_id matches; the service's own blueprint_id is the fallback. */
export async function loadBlueprintsForServices(serviceIds: string[]): Promise<Record<string, PhaseBlueprint>> {
  const out: Record<string, PhaseBlueprint> = {};
  if (serviceIds.length === 0) return out;
  const { data: bps } = await supabase.from("phase_blueprints").select("id,name,service_id,phases");
  const list = (bps ?? []) as PhaseBlueprint[];
  // by service_id
  serviceIds.forEach((sid) => { const b = list.find((x) => x.service_id === sid); if (b) out[sid] = b; });
  // fallback via services.blueprint_id
  const missing = serviceIds.filter((sid) => !out[sid]);
  if (missing.length) {
    const { data: svc } = await supabase.from("services").select("id,blueprint_id").in("id", missing);
    (svc ?? []).forEach((s: any) => { if (s.blueprint_id) { const b = list.find((x) => x.id === s.blueprint_id); if (b) out[s.id] = b; } });
  }
  return out;
}