/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../../api/supabase";
import { syncEntryToOutlookDetailed, deleteEntryFromOutlook, meetingsGoneFromOutlook } from "../../../api/outlookSync";
import type { Phase } from "../../settings/pipelineApi";
import { calcBreakdown, discountOf, BASE_KEY, type Calculator, type CalcRow, type CalcDiscount } from "../../settings/catalogApi";

/**
 * Signed-in user id from the local session. Not auth.getUser(): that asks the
 * auth server while holding supabase-js's auth lock, and every query started in
 * the meantime waits behind it.
 */
async function myUser(): Promise<{ id: string; email: string | null } | null> {
  const { data } = await supabase.auth.getSession();
  const u = data?.session?.user;
  return u?.id ? { id: u.id, email: u.email ?? null } : null;
}
const myId = async () => (await myUser())?.id ?? null;

/**
 * Every row of a list, past Supabase's 1,000-row page. The first page is one
 * request as always; when it comes back full, the next pages are asked for in
 * parallel batches that double each time (2, 4, 8…), so 50,000 rows take about
 * six rounds instead of fifty requests one after the other.
 */
export async function allRows(query: () => any, page = 1000): Promise<any[]> {
  const get = async (n: number): Promise<any[] | null> => {
    const { data, error } = await query().range(n * page, n * page + page - 1);
    return error || !data ? null : data;
  };
  const first = await get(0);
  if (!first) return [];
  const out: any[] = [...first];
  if (first.length < page) return out;
  for (let next = 1, batch = 2; ; batch = Math.min(batch * 2, 16)) {
    const pages = await Promise.all(Array.from({ length: batch }, (_, i) => get(next + i)));
    next += batch;
    let done = false;
    for (const rows of pages) {
      if (!rows) { done = true; break; }
      out.push(...rows);
      if (rows.length < page) { done = true; break; }
    }
    if (done) return out;
  }
}

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
  /** Expected close dates (the rep's and management's estimates). */
  rep_close_date?: string | null;
  mgr_close_date?: string | null;
  /** The day it was actually closed (won or lost) — empower_close_date.sql. */
  close_date?: string | null;
  loss_reason?: string | null;
  loss_details?: string | null;
  /** Custom deal fields, keyed by tracking_fields.id. */
  custom?: Record<string, any> | null;
  /** Which sales role each person plays on this deal (profile id → sales_roles.id). */
  deal_roles?: Record<string, string> | null;
  /** Custom name for the deal (empty = shown with the client's name). */
  deal_name?: string | null;
  contactIds: string[];
}

export interface TrackNote {
  id: string; phase_id: string | null; body: string; created_at: string;
  /** Who wrote it (empower_tasks_v2.sql adds the column; older notes have none). */
  created_by?: string | null;
}
export interface TrackTask {
  id: string; phase_id: string | null;
  /** The task's name (may carry @mentions). */
  title: string;
  /** Details under the name (optional; may carry @mentions). */
  description?: string | null;
  done: boolean; due_at?: string | null; created_at?: string;
  /** Who made it — only they can delete it. Null on tasks from before empower_tasks_v2.sql. */
  created_by?: string | null;
  // To-do v2 (empower_tasks_v2.sql). Filled with defaults when the columns aren't there yet.
  priority?: TaskPriority; kind?: TaskKind; status?: TaskStatus; progress?: number;
  /** A process's steps; ticking them moves its %. */
  checklist?: TaskStep[];
  /** The predefined task / process it was made from. */
  template_id?: string | null;
  /** When the "quick → process" rule turned it into a process. */
  promoted_at?: string | null;
}
export interface TaskStep { id: string; text: string; done: boolean }
export const newStepId = () => Math.random().toString(36).slice(2, 10);
export type MeetingKind = "teams" | "phone" | "in_person";
export interface TrackMeeting {
  id: string; phase_id: string | null; title: string; meet_at: string | null; kind?: MeetingKind;
  /** When it ends, same day ("YYYY-MM-DDTHH:MM:00"). Older meetings without one last an hour. */
  end_at?: string | null;
  /** Outlook: the event id once it's in the organiser's Outlook. */
  outlook_event_id?: string | null;
  /** Booked by the signed-in user (only their own Outlook can receive it). */
  mine?: boolean;
  /** Last sync attempt failed / was skipped — why (not stored). */
  outlook_error?: string | null;
  outlook_syncing?: boolean;
}
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

/** The owner profile id for one tracking, or null. */
export async function loadTrackingOwner(trackingId: string): Promise<string | null> {
  const { data } = await supabase.from("tracking_employees")
    .select("profile_id").eq("tracking_id", trackingId).eq("is_owner", true).maybeSingle();
  return (data as any)?.profile_id ?? null;
}

/**
 * Set (or clear) the owner of a deal. The owner must be one of the people on the
 * deal; if they aren't yet, they're added. Passing null clears the owner.
 * Done in two steps because the partial unique index forbids two owners at once:
 * clear the old owner first, then set the new one.
 */
export async function setTrackingOwner(trackingId: string, profileId: string | null) {
  await supabase.from("tracking_employees").update({ is_owner: false })
    .eq("tracking_id", trackingId).eq("is_owner", true);
  if (!profileId) return;
  const { data } = await supabase.from("tracking_employees")
    .select("profile_id").eq("tracking_id", trackingId).eq("profile_id", profileId).maybeSingle();
  if (data) {
    await supabase.from("tracking_employees").update({ is_owner: true })
      .eq("tracking_id", trackingId).eq("profile_id", profileId);
  } else {
    await supabase.from("tracking_employees").insert({ tracking_id: trackingId, profile_id: profileId, is_owner: true });
  }
}
export async function addTrackingEmployee(trackingId: string, profileId: string) {
  await supabase.from("tracking_employees").insert({ tracking_id: trackingId, profile_id: profileId });
}
export async function removeTrackingEmployee(trackingId: string, profileId: string) {
  await supabase.from("tracking_employees").delete().eq("tracking_id", trackingId).eq("profile_id", profileId);
}

/**
 * Who is on each deal and who owns it, from ONE read of tracking_employees
 * (the list used to read the same table twice).
 */
export async function loadTrackingTeams(): Promise<{ members: Record<string, string[]>; owners: Record<string, string> }> {
  const rows = await allRows(() => supabase.from("tracking_employees").select("tracking_id, profile_id, is_owner").order("tracking_id").order("profile_id"));
  return teamsFromRows(rows);
}
export function teamsFromRows(rows: any[]): { members: Record<string, string[]>; owners: Record<string, string> } {
  const members: Record<string, string[]> = {};
  const owners: Record<string, string> = {};
  rows.forEach((r: any) => {
    (members[r.tracking_id] ??= []).push(r.profile_id);
    if (r.is_owner) owners[r.tracking_id] = r.profile_id;
  });
  return { members, owners };
}

/** Who is on each tracking, for the whole list at once. */
export async function loadAllTrackingEmployees(): Promise<Record<string, string[]>> {
  return (await loadTrackingTeams()).members;
}

/** The owner (responsable comercial) of each tracking, if one is set. */
export async function loadAllTrackingOwners(): Promise<Record<string, string>> {
  return (await loadTrackingTeams()).owners;
}

/** Replace the whole team of a tracking in one go, keeping the owner flag for
 *  anyone who stays on the team. */
export async function setTrackingEmployees(trackingId: string, profileIds: string[]) {
  const { data: prev } = await supabase.from("tracking_employees")
    .select("profile_id").eq("tracking_id", trackingId).eq("is_owner", true).maybeSingle();
  const owner = (prev as any)?.profile_id as string | undefined;
  await supabase.from("tracking_employees").delete().eq("tracking_id", trackingId);
  if (profileIds.length) {
    await supabase.from("tracking_employees")
      .insert(profileIds.map((p) => ({ tracking_id: trackingId, profile_id: p, is_owner: owner === p })));
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
  // Deals and their contacts together (they used to load one after the other),
  // and every page of them — not just the first 1,000.
  const [rows, links] = await Promise.all([
    allRows(() => supabase.from("trackings").select("*").order("created_at", { ascending: false }).order("id")),
    allRows(() => supabase.from("tracking_contacts").select("tracking_id,contact_id").order("tracking_id").order("contact_id")),
  ]);
  return trackingsFromRows(rows, links);
}
/** Deals with their contact ids, from rows already read. */
export function trackingsFromRows(rows: any[], links: any[]): Tracking[] {
  const byTracking: Record<string, string[]> = {};
  links.forEach((l: any) => { (byTracking[l.tracking_id] ??= []).push(l.contact_id); });
  return rows.map((r: any) => ({ ...r, contactIds: byTracking[r.id] ?? [] }));
}

export async function createTracking(input: {
  company_id: string | null; pipeline_id: string;
  products: { id: string; price: number }[];
  current_phase_id: string | null; contactIds: string[];
  /** Custom deal field values (only sent when there are some). */
  custom?: Record<string, any>;
  /** The sales role each person plays on this deal (only sent when there are some). */
  deal_roles?: Record<string, string>;
  /** Custom deal name (empty = shown with the client's name). */
  deal_name?: string | null;
}): Promise<string | null> {
  const dealName = (input.deal_name ?? "").replace(/\s+/g, " ").trim();
  const { data, error } = await supabase.from("trackings").insert({
    ...(dealName ? { deal_name: dealName } : {}),
    ...(input.custom && Object.keys(input.custom).length ? { custom: input.custom } : {}),
    ...(input.deal_roles && Object.keys(input.deal_roles).length ? { deal_roles: input.deal_roles } : {}),
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
  return ((data ?? []) as any[]).map(normTask) as TrackTask[];
}
export interface TaskExtras { description?: string | null; priority?: TaskPriority; kind?: TaskKind; checklist?: TaskStep[]; template_id?: string | null }
export async function addTask(trackingId: string, phaseId: string | null, title: string, dueAt?: string | null, extras?: TaskExtras): Promise<TrackTask | null> {
  const base = { tracking_id: trackingId, phase_id: phaseId, title, due_at: dueAt ?? null };
  const more: Record<string, unknown> = {};
  if (extras?.description?.trim()) more.description = extras.description.trim();
  if (extras?.priority && extras.priority !== "normal") more.priority = extras.priority;
  if (extras?.kind && extras.kind !== "quick") more.kind = extras.kind;
  if (extras?.checklist?.length) more.checklist = extras.checklist;
  if (extras?.template_id) more.template_id = extras.template_id;
  let { data, error } = await supabase.from("tracking_tasks").insert({ ...base, ...more }).select().single();
  // Before empower_tasks_v2.sql the new columns don't exist: still save the task itself.
  if (error && Object.keys(more).length && /column/i.test(error.message ?? "")) {
    ({ data, error } = await supabase.from("tracking_tasks").insert(base).select().single());
  }
  return data ? (normTask(data) as TrackTask) : null;
}
export async function toggleTask(id: string, done: boolean) {
  await supabase.from("tracking_tasks").update({ done }).eq("id", id);
}
export async function updateTask(id: string, patch: { title?: string; description?: string | null; due_at?: string | null }) {
  await supabase.from("tracking_tasks").update(patch).eq("id", id);
}
/** Only whoever created a task may delete it (the database checks too). Returns the error text, if any. */
export async function deleteTask(id: string): Promise<string | null> {
  const { error } = await supabase.from("tracking_tasks").delete().eq("id", id);
  if (!error) return null;
  return /created this task/i.test(error.message ?? "") ? "Only the person who created this task can delete it." : error.message;
}
/** Can this person delete the task? Its creator can; old tasks with no creator recorded, anyone. */
export const canDeleteTask = (t: { created_by?: string | null }, me: string | null | undefined) => !t.created_by || (!!me && t.created_by === me);

/* ============================ To-do (home) ============================
 * Tasks come in two kinds: QUICK ones (tick and forget) and PROCESSES (longer
 * work with a status, a % done and progress notes). Each has a priority.
 * A task can belong to a deal, or be personal (no deal, made from Home).
 * The extra columns come from empower_tasks_v2.sql; before it's run, every
 * task reads as a quick, normal-priority one.
 */
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskKind = "quick" | "process";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export const TASK_PRIORITIES: TaskPriority[] = ["urgent", "high", "normal", "low"];
export const TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];

/** A task on someone's to-do list, with the deal it belongs to (if any). */
export interface MyTask extends TrackTask {
  tracking_id: string | null;
  /** Deal name (or the client's name when the deal has none); null for a personal task. */
  deal: string | null;
  company: string | null;
  /** Someone tagged me on it (vs. one on a deal I own, or one I made for myself). */
  assigned: boolean;
  priority: TaskPriority;
  kind: TaskKind;
  status: TaskStatus;
  progress: number;
  updated_at?: string | null;
  completed_at?: string | null;
  /** The latest progress note, if any. */
  lastNote?: { body: string; at: string; author: string | null } | null;
}
const normTask = (t: any) => ({
  ...t,
  done: !!t.done || t.status === "done",
  priority: (["low", "normal", "high", "urgent"].includes(t.priority) ? t.priority : "normal") as TaskPriority,
  kind: (t.kind === "process" ? "process" : "quick") as TaskKind,
  status: (TASK_STATUSES.includes(t.status) ? t.status : t.done ? "done" : "todo") as TaskStatus,
  progress: Math.max(0, Math.min(100, Number(t.progress) || (t.done ? 100 : 0))),
  checklist: (Array.isArray(t.checklist) ? t.checklist : [])
    .filter((x: any) => x && typeof x.text === "string")
    .map((x: any) => ({ id: String(x.id ?? newStepId()), text: x.text, done: !!x.done })) as TaskStep[],
});

/* ============================ Task settings & predefined tasks ============================ */
export interface TaskSettings { auto_process_on: boolean; auto_process_days: number }
export const DEFAULT_TASK_SETTINGS: TaskSettings = { auto_process_on: false, auto_process_days: 7 };
let settingsCache: { at: number; value: TaskSettings } | null = null;
export async function loadTaskSettings(fresh = false): Promise<TaskSettings> {
  if (!fresh && settingsCache && Date.now() - settingsCache.at < 60_000) return settingsCache.value;
  const { data, error } = await supabase.from("task_settings").select("auto_process_on, auto_process_days").maybeSingle();
  const value = error || !data ? DEFAULT_TASK_SETTINGS : {
    auto_process_on: !!(data as any).auto_process_on,
    auto_process_days: Math.max(1, Number((data as any).auto_process_days) || 7),
  };
  settingsCache = { at: Date.now(), value };
  return value;
}
export async function saveTaskSettings(v: TaskSettings): Promise<string | null> {
  const { error } = await supabase.from("task_settings").upsert({ ...v, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
  if (!error) settingsCache = { at: Date.now(), value: v };
  return error ? (/relation|does not exist/i.test(error.message) ? "Run empower_tasks_v2.sql in Supabase first." : error.message) : null;
}

/**
 * The "quick → process" rule: a quick task still open after N days becomes a
 * process (it gets a status, a % and progress notes). Applied when tasks are
 * loaded; returns the rows as they are now.
 */
async function autoPromote(rows: any[]): Promise<any[]> {
  const st = await loadTaskSettings().catch(() => DEFAULT_TASK_SETTINGS);
  if (!st.auto_process_on) return rows;
  const cutoff = Date.now() - st.auto_process_days * 86400000;
  const stale = rows.filter((t) => t.kind === "quick" && !t.done && t.status !== "done" && !t.promoted_at
    && t.created_at && new Date(t.created_at).getTime() < cutoff);
  if (!stale.length) return rows;
  const at = new Date().toISOString();
  const { error } = await supabase.from("tracking_tasks").update({ kind: "process", promoted_at: at }).in("id", stale.map((t) => t.id));
  if (error) return rows;
  const ids = new Set(stale.map((t) => t.id));
  return rows.map((t) => (ids.has(t.id) ? { ...t, kind: "process", promoted_at: at } : t));
}

export interface TaskTemplate {
  id: string; kind: TaskKind; title: string; description: string | null; priority: TaskPriority;
  /** Deadline: this many days after it's created (null = none), at due_time. */
  due_in_days: number | null; due_time: string;
  /** Steps of a predefined process. */
  checklist: string[];
  sort: number;
}
export async function loadTaskTemplates(): Promise<TaskTemplate[]> {
  const { data, error } = await supabase.from("task_templates").select("*").order("sort").order("created_at");
  if (error) return [];
  return ((data ?? []) as any[]).map((t) => ({
    id: t.id, kind: t.kind === "process" ? "process" : "quick", title: t.title ?? "", description: t.description ?? null,
    priority: (["low", "normal", "high", "urgent"].includes(t.priority) ? t.priority : "normal") as TaskPriority,
    due_in_days: t.due_in_days == null ? null : Number(t.due_in_days), due_time: t.due_time || "18:00",
    checklist: Array.isArray(t.checklist) ? t.checklist.map((x: any) => String(typeof x === "string" ? x : x?.text ?? "")).filter(Boolean) : [],
    sort: Number(t.sort) || 0,
  }));
}
export async function saveTaskTemplate(t: Omit<TaskTemplate, "id"> & { id?: string }): Promise<{ template: TaskTemplate | null; error: string | null }> {
  const row = {
    kind: t.kind, title: t.title.trim(), description: t.description?.trim() || null, priority: t.priority,
    due_in_days: t.due_in_days, due_time: t.due_time || "18:00", checklist: t.checklist.map((x) => x.trim()).filter(Boolean), sort: t.sort,
  };
  const q = t.id ? supabase.from("task_templates").update(row).eq("id", t.id) : supabase.from("task_templates").insert(row);
  const { data, error } = await q.select().single();
  if (error || !data) return { template: null, error: error ? (/relation|does not exist/i.test(error.message) ? "Run empower_tasks_v2.sql in Supabase first." : /row-level|policy/i.test(error.message) ? "Only the boss and managers can change predefined tasks." : error.message) : "not saved" };
  return { template: { ...row, id: (data as any).id ?? t.id ?? "" } as TaskTemplate, error: null };
}
export async function deleteTaskTemplate(id: string): Promise<string | null> {
  const { error } = await supabase.from("task_templates").delete().eq("id", id);
  return error ? error.message : null;
}
/** What a new task gets from a predefined one: name, description, priority, kind, deadline and steps. */
export function fromTemplate(t: TaskTemplate, now = new Date()) {
  let due_at: string | null = null;
  if (t.due_in_days != null) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + t.due_in_days);
    due_at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${t.due_time || "18:00"}:00`;
  }
  return {
    title: t.title, description: t.description ?? "", priority: t.priority, kind: t.kind, due_at, template_id: t.id,
    checklist: t.checklist.map((text) => ({ id: newStepId(), text, done: false })) as TaskStep[],
  };
}

/**
 * My to-do: tasks I'm tagged on, untagged tasks on deals I own (the owner's
 * to do), and the personal ones I made. Latest progress note included.
 */
export async function loadMyTasks(): Promise<MyTask[]> {
  const uid = await myId();
  if (!uid) return [];
  const [{ data: mine }, { data: owned }, personal] = await Promise.all([
    supabase.from("tracking_assignees").select("item_id").eq("item_type", "task").eq("kind", "employee").eq("employee_id", uid),
    supabase.from("tracking_employees").select("tracking_id").eq("profile_id", uid).eq("is_owner", true),
    // personal tasks I made (no deal) — empty until the SQL adds created_by
    Promise.resolve(supabase.from("tracking_tasks").select("*").is("tracking_id", null).eq("created_by", uid))
      .then((r: any) => (r?.error ? [] : (r?.data ?? []))).catch(() => [] as any[]),
  ]);
  const taggedIds = [...new Set(((mine ?? []) as any[]).map((r) => r.item_id))];
  const ownedDeals = [...new Set(((owned ?? []) as any[]).map((r) => r.tracking_id))];
  const [tagged, onMyDeals] = await Promise.all([
    taggedIds.length ? allRows(() => supabase.from("tracking_tasks").select("*").in("id", taggedIds).order("id")) : Promise.resolve([] as any[]),
    ownedDeals.length ? allRows(() => supabase.from("tracking_tasks").select("*").in("tracking_id", ownedDeals).order("id")) : Promise.resolve([] as any[]),
  ]);
  const taggedSet = new Set(taggedIds);
  const others = onMyDeals.filter((t: any) => !taggedSet.has(t.id));
  const mineOnly = (personal as any[]).filter((t) => !t.tracking_id && !taggedSet.has(t.id));
  let all = [...tagged, ...others, ...mineOnly];
  if (!all.length) return [];
  all = await autoPromote(all);
  const byId = new Map(all.map((t: any) => [t.id, t]));
  const fresh = (xs: any[]) => xs.map((t) => byId.get(t.id) ?? t);
  // Of the tasks on my deals, the ones already given to someone else aren't mine.
  const dealIds = [...new Set(all.map((t: any) => t.tracking_id).filter(Boolean))];
  const [{ data: given }, { data: deals }, notes] = await Promise.all([
    others.length
      ? supabase.from("tracking_assignees").select("item_id").eq("item_type", "task").eq("kind", "employee").in("item_id", others.map((t: any) => t.id))
      : Promise.resolve({ data: [] as any[] }),
    dealIds.length ? supabase.from("trackings").select("id, deal_name, company_id").in("id", dealIds) : Promise.resolve({ data: [] as any[] }),
    Promise.resolve(supabase.from("tracking_task_updates").select("task_id, body, created_at, author_id").in("task_id", all.map((t: any) => t.id)).order("created_at", { ascending: false }))
      .then((r: any) => (r?.error ? [] : (r?.data ?? []))).catch(() => [] as any[]),
  ]);
  const givenSet = new Set(((given ?? []) as any[]).map((r) => r.item_id));
  const companyIds = [...new Set(((deals ?? []) as any[]).map((d) => d.company_id).filter(Boolean))];
  const { data: cos } = companyIds.length
    ? await supabase.from("companies").select("id, name").in("id", companyIds)
    : { data: [] as any[] };
  const coName = new Map<string, string>(((cos ?? []) as any[]).map((c) => [c.id, c.name]));
  const dealById = new Map<string, any>(((deals ?? []) as any[]).map((d) => [d.id, d]));
  const lastNote = new Map<string, any>();
  (notes as any[]).forEach((n) => { if (n.body && !lastNote.has(n.task_id)) lastNote.set(n.task_id, n); });
  const shape = (t: any, assigned: boolean): MyTask => {
    const d = t.tracking_id ? dealById.get(t.tracking_id) : null;
    const company = d?.company_id ? coName.get(d.company_id) ?? null : null;
    const n = lastNote.get(t.id);
    return {
      ...normTask(t), assigned, company,
      deal: t.tracking_id ? ((d?.deal_name ?? "").trim() || company || "Deal") : null,
      lastNote: n ? { body: n.body, at: n.created_at, author: n.author_id ?? null } : null,
    };
  };
  return [
    ...fresh(tagged).map((t: any) => shape(t, true)),
    ...fresh(others).filter((t: any) => !givenSet.has(t.id)).map((t: any) => shape(t, false)),
    ...fresh(mineOnly).map((t: any) => shape(t, false)),
  ];
}

/** A task I made and gave to someone else (tagged them), to follow how it's going. */
export interface DelegatedTask extends MyTask {
  /** The people it was given to (not me). */
  assignees: { id: string; name: string }[];
}
/**
 * Tasks I created and tagged someone else on — on a deal or personal — with
 * who has them, their status / % and the latest progress note.
 */
export async function loadDelegatedTasks(): Promise<DelegatedTask[]> {
  const uid = await myId();
  if (!uid) return [];
  const mine = await allRows(() => supabase.from("tracking_tasks").select("*").eq("created_by", uid).order("id")).then(autoPromote).catch(() => [] as any[]);
  if (!mine.length) return [];
  const { data: tags } = await supabase.from("tracking_assignees").select("item_id, employee_id")
    .eq("item_type", "task").eq("kind", "employee").in("item_id", mine.map((t: any) => t.id));
  const byTask = new Map<string, string[]>();
  ((tags ?? []) as any[]).forEach((a) => {
    if (!a.employee_id || a.employee_id === uid) return;
    const l = byTask.get(a.item_id) ?? []; if (!l.includes(a.employee_id)) l.push(a.employee_id); byTask.set(a.item_id, l);
  });
  const given = mine.filter((t: any) => byTask.has(t.id));
  if (!given.length) return [];
  const people = [...new Set([...byTask.values()].flat())];
  const dealIds = [...new Set(given.map((t: any) => t.tracking_id).filter(Boolean))] as string[];
  const [{ data: profs }, { data: deals }, notes] = await Promise.all([
    supabase.from("profiles").select("id, first_name, last_name, email").in("id", people),
    dealIds.length ? supabase.from("trackings").select("id, deal_name, company_id").in("id", dealIds) : Promise.resolve({ data: [] as any[] }),
    Promise.resolve(supabase.from("tracking_task_updates").select("task_id, body, created_at, author_id").in("task_id", given.map((t: any) => t.id)).order("created_at", { ascending: false }))
      .then((r: any) => (r?.error ? [] : (r?.data ?? []))).catch(() => [] as any[]),
  ]);
  const companyIds = [...new Set(((deals ?? []) as any[]).map((d) => d.company_id).filter(Boolean))];
  const { data: cos } = companyIds.length ? await supabase.from("companies").select("id, name").in("id", companyIds) : { data: [] as any[] };
  const coName = new Map<string, string>(((cos ?? []) as any[]).map((c) => [c.id, c.name]));
  const dealById = new Map<string, any>(((deals ?? []) as any[]).map((d) => [d.id, d]));
  const nameOf = new Map<string, string>(((profs ?? []) as any[]).map((p) => [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || (p.email ?? "").split("@")[0] || "Someone"]));
  const lastNote = new Map<string, any>();
  (notes as any[]).forEach((n) => { if (n.body && !lastNote.has(n.task_id)) lastNote.set(n.task_id, n); });
  return given.map((t: any) => {
    const d = t.tracking_id ? dealById.get(t.tracking_id) : null;
    const company = d?.company_id ? coName.get(d.company_id) ?? null : null;
    const n = lastNote.get(t.id);
    return {
      ...normTask(t), assigned: false, company,
      deal: t.tracking_id ? ((d?.deal_name ?? "").trim() || company || "Deal") : null,
      lastNote: n ? { body: n.body, at: n.created_at, author: n.author_id ?? null } : null,
      assignees: (byTask.get(t.id) ?? []).map((id) => ({ id, name: nameOf.get(id) ?? "Someone" })),
    } as DelegatedTask;
  });
}

/** A personal task from Home (no deal). Returns the error text, or the new task. */
export async function addPersonalTask(input: { title: string; description?: string | null; kind: TaskKind; priority: TaskPriority; due_at?: string | null; checklist?: TaskStep[]; template_id?: string | null }): Promise<{ task: MyTask | null; error: string | null }> {
  const { data, error } = await supabase.from("tracking_tasks").insert({
    tracking_id: null, phase_id: null, title: input.title, due_at: input.due_at ?? null,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.checklist?.length ? { checklist: input.checklist } : {}),
    ...(input.template_id ? { template_id: input.template_id } : {}),
    kind: input.kind, priority: input.priority, status: "todo", progress: 0,
  }).select().single();
  if (error || !data) {
    const msg = error?.message ?? "not saved";
    return { task: null, error: /column|tracking_id|null value/i.test(msg) ? "Run empower_tasks_v2.sql in Supabase first (it adds priority, processes and personal tasks)." : msg };
  }
  return { task: { ...normTask(data), assigned: false, deal: null, company: null, lastNote: null } as MyTask, error: null };
}

/** Change a task's priority, kind, status, % or due date. */
export async function updateTaskMeta(id: string, patch: Partial<Pick<MyTask, "priority" | "kind" | "status" | "progress" | "due_at" | "title" | "description" | "checklist">>): Promise<string | null> {
  const { error } = await supabase.from("tracking_tasks").update(patch).eq("id", id);
  if (!error) return null;
  if (/created this task/i.test(error.message)) return "Only the person who created this task can change its deadline.";
  return /column/i.test(error.message) ? "Run empower_tasks_v2.sql in Supabase first." : error.message;
}

export interface TaskUpdate { id: string; task_id: string; author_id: string | null; body: string | null; status: TaskStatus | null; progress: number | null; created_at: string }
/** The progress notes of a task, newest first. */
export async function loadTaskUpdates(taskId: string): Promise<TaskUpdate[]> {
  const { data, error } = await supabase.from("tracking_task_updates").select("*").eq("task_id", taskId).order("created_at", { ascending: false });
  return error ? [] : ((data ?? []) as TaskUpdate[]);
}
/** A progress note — with the status and % at that moment (and they're applied to the task). */
export async function addTaskUpdate(taskId: string, u: { body: string; status: TaskStatus; progress: number }): Promise<{ update: TaskUpdate | null; error: string | null }> {
  const err = await updateTaskMeta(taskId, { status: u.status, progress: u.status === "done" ? 100 : u.progress });
  if (err) return { update: null, error: err };
  const body = u.body.trim();
  if (!body) return { update: null, error: null };
  const me = await myId();
  const { data, error } = await supabase.from("tracking_task_updates")
    .insert({ task_id: taskId, author_id: me, body, status: u.status, progress: u.status === "done" ? 100 : u.progress }).select().single();
  if (error || !data) return { update: null, error: error ? error.message : "not saved" };
  // The row as saved; author / time filled in if the reply left them out.
  const row = data as TaskUpdate;
  return { update: { ...row, author_id: row.author_id ?? me, created_at: row.created_at ?? new Date().toISOString() }, error: null };
}

// ---- Meetings ----
const hhmm = (min: number) => `${String(Math.floor(Math.min(min, 1439) / 60)).padStart(2, "0")}:${String(Math.min(min, 1439) % 60).padStart(2, "0")}`;
/** Minutes after midnight of an end time; falls back to start + 1 h, and never past the end of the day. */
function endMinOf(startMin: number, endAt?: string | null): number {
  const m = endAt ? /T(\d{2}):(\d{2})/.exec(endAt) : null;
  const end = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  return Number.isFinite(end) && end > startMin ? Math.min(end, 1439) : Math.min(startMin + 60, 1439);
}
/**
 * Meetings live in calendar_entries with everyone else's time, so a meeting
 * booked from the sales calendar shows up on the deal and the other way round.
 */
export async function loadMeetings(trackingId: string): Promise<TrackMeeting[]> {
  const [{ data }, u] = await Promise.all([
    supabase.from("calendar_entries")
      .select("id, phase_id_ref, title, entry_date, start_min, end_min, meeting_kind, user_id, outlook_event_id")
      .eq("tracking_id", trackingId).eq("kind", "meeting")
      .order("entry_date").order("start_min"),
    myId(),
  ]);
  const me = u ?? null;
  return ((data ?? []) as any[]).map((r) => ({
    outlook_event_id: r.outlook_event_id ?? null,
    mine: !!me && r.user_id === me,
    id: r.id,
    phase_id: r.phase_id_ref,
    title: r.title,
    meet_at: `${r.entry_date}T${hhmm(r.start_min)}:00`,
    end_at: `${r.entry_date}T${hhmm(r.end_min != null && r.end_min > r.start_min ? r.end_min : r.start_min + 60)}:00`,
    kind: (r.meeting_kind ?? "in_person") as MeetingKind,
  }));
}
/* ---- Outlook: meetings booked on a deal also land in the organiser's Outlook ----
   Uses the same one-way sync as the Calendar page (Edge Function outlook-sync).
   Does nothing if that person hasn't connected Outlook in Settings → Interface,
   and never blocks saving the meeting. */
const MEETING_KIND_LABEL: Record<MeetingKind, string> = { teams: "Teams meeting", phone: "Phone call", in_person: "In-person meeting" };
const plainText = (t: string) => t.replace(/@\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
export type MeetingOutlookResult = {
  ok: boolean; eventId: string | null; error?: string; skipped?: boolean; notMine?: boolean;
  /** Deleted in Outlook → removed from the deal too. */
  gone?: boolean;
  /** How many people were invited · Teams link · Teams asked for but not available on this account. */
  invited?: number; joinUrl?: string | null; teamsSkipped?: boolean;
};

/** Rename a deal. Empty = show it with the client's name again. */
export async function setDealName(trackingId: string, name: string): Promise<string | null> {
  const v = name.replace(/\s+/g, " ").trim();
  const { error } = await supabase.from("trackings").update({ deal_name: v || null }).eq("id", trackingId);
  return error ? error.message : null;
}

/** People @mentioned in a meeting, with their email: "@[Name](employee:<id>)" / "(contact:<id>)". */
async function mentionedAttendees(text: string, skipEmail?: string | null): Promise<{ email: string; name: string }[]> {
  const found = [...(text ?? "").matchAll(/@\[([^\]]+)\]\(([^)]+)\)/g)].map((m) => ({ name: m[1], id: m[2] }));
  if (!found.length) return [];
  const empIds = found.filter((f) => !f.id.startsWith("contact:")).map((f) => f.id.replace(/^employee:/, ""));
  const conIds = found.filter((f) => f.id.startsWith("contact:")).map((f) => f.id.slice(8));
  const [emps, cons] = await Promise.all([
    empIds.length ? supabase.from("profiles").select("id, email, first_name, last_name").in("id", empIds) : Promise.resolve({ data: [] }),
    conIds.length ? supabase.from("contacts").select("id, email, first_name, last_name").in("id", conIds) : Promise.resolve({ data: [] }),
  ]);
  const nameOf = (r: any, fallback: string) => [r.first_name, r.last_name].filter(Boolean).join(" ") || fallback;
  const out: { email: string; name: string }[] = [];
  const add = (rows: any[], ids: string[]) => ids.forEach((id) => {
    const r = rows.find((x) => x.id === id);
    const email = (r?.email ?? "").trim();
    if (!email || (skipEmail && email.toLowerCase() === skipEmail.toLowerCase())) return;
    if (out.some((o) => o.email.toLowerCase() === email.toLowerCase())) return;
    out.push({ email, name: nameOf(r, found.find((f) => f.id.endsWith(id))?.name ?? email) });
  });
  add(((emps as any).data ?? []) as any[], empIds);
  add(((cons as any).data ?? []) as any[], conIds);
  return out;
}
/** Fired on window after every sync attempt: detail = { id, result }. */
export const MEETING_OUTLOOK_EVENT = "next:meeting-outlook";
/** Put a deal meeting into the organiser's Outlook (create or update). */
export async function syncMeetingToOutlook(entryId: string): Promise<MeetingOutlookResult> {
  let result: MeetingOutlookResult;
  try {
    const [me, { data: e, error: qErr }] = await Promise.all([
      myUser(),
      supabase.from("calendar_entries")
        .select("id, user_id, title, entry_date, start_min, end_min, meeting_kind, company_id, tracking_id, outlook_event_id")
        .eq("id", entryId).maybeSingle(),
    ]);
    const row = e as any;
    if (qErr || !row) result = { ok: false, eventId: null, error: `Couldn't read the meeting: ${qErr?.message ?? "not found"}` };
    // Only the organiser's own Outlook (the sync writes to the signed-in user's calendar).
    else if (!me || row.user_id !== me.id) result = { ok: false, eventId: row.outlook_event_id ?? null, notMine: true, error: "Booked by someone else — it goes to their Outlook." };
    else {
      const [{ data: co }, { data: trk }, attendees] = await Promise.all([
        row.company_id ? supabase.from("companies").select("name").eq("id", row.company_id).maybeSingle() : Promise.resolve({ data: null }),
        row.tracking_id ? supabase.from("trackings").select("deal_name").eq("id", row.tracking_id).maybeSingle() : Promise.resolve({ data: null }),
        mentionedAttendees(row.title ?? "", me.email),
      ]);
      const kind = (row.meeting_kind ?? "in_person") as MeetingKind;
      const description = plainText(row.title ?? "") || MEETING_KIND_LABEL[kind];
      const company = ((co as any)?.name as string) ?? "";
      const deal = (((trk as any)?.deal_name as string) ?? "").trim() || company;
      const r = await syncEntryToOutlookDetailed({
        outlookEventId: row.outlook_event_id ?? null,
        date: row.entry_date,
        startMin: row.start_min,
        endMin: row.end_min ?? row.start_min + 60,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        kind: "meeting",
        client: company,
        deal,
        meetingType: MEETING_KIND_LABEL[kind],
        description,
        attendees,
        online: kind === "teams",
        // read by an older outlook-sync that doesn't know "meeting" yet
        workType: description,
        project: deal && deal !== company ? deal : "",
        notes: description,
      });
      // Deleted in Outlook while you were editing it here: it goes from the deal too.
      if (r.gone) await supabase.from("calendar_entries").delete().eq("id", entryId);
      if (r.ok && r.eventId && r.eventId !== row.outlook_event_id) {
        const { error: uErr } = await supabase.from("calendar_entries").update({ outlook_event_id: r.eventId }).eq("id", entryId);
        if (uErr) console.warn("[outlook] event created but its id couldn't be saved:", uErr.message);
      }
      result = r;
    }
  } catch (err: any) {
    result = { ok: false, eventId: null, error: err?.message ?? String(err) };
  }
  if (!result.ok && !result.notMine && !result.gone) console.warn("[outlook] meeting", entryId, "not synced:", result.error);
  window.dispatchEvent(new CustomEvent(MEETING_OUTLOOK_EVENT, { detail: { id: entryId, result } }));
  return result;
}

export async function addMeeting(trackingId: string, phaseId: string | null, title: string, meetAt: string | null, kind: MeetingKind = "in_person", endAt?: string | null): Promise<TrackMeeting | null> {
  const at = meetAt ? new Date(meetAt) : new Date();
  const startMin = at.getHours() * 60 + at.getMinutes();
  const endMin = endMinOf(startMin, endAt);
  const [uid, { data: trk }] = await Promise.all([
    myId(),
    supabase.from("trackings").select("company_id").eq("id", trackingId).maybeSingle(),
  ]);
  const { data } = await supabase.from("calendar_entries").insert({
    user_id: uid,
    kind: "meeting",
    tracking_id: trackingId,
    phase_id_ref: phaseId,
    company_id: (trk as any)?.company_id ?? null,
    title,
    date_key: `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`,
    entry_date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`,
    start_min: startMin,
    end_min: endMin,
    meeting_kind: kind,
    billable: 0,
    billing_line: "sales",
    status: "confirmed",
  }).select("id").single();
  if (!data) return null;
  void syncMeetingToOutlook(data.id);
  const day = meetAt ? meetAt.slice(0, 10) : null;
  return { id: data.id, phase_id: phaseId, title, meet_at: meetAt, end_at: day ? `${day}T${hhmm(endMin)}:00` : null, kind, mine: true, outlook_event_id: null, outlook_syncing: true };
}
/**
 * Delete a meeting here and in Outlook — the organiser's Outlook, even when a
 * teammate deletes it. Outlook goes first (the function reads the row to know
 * whose calendar it is in), but never holds the delete back for long.
 */
export async function deleteMeeting(id: string) {
  const { data: e } = await supabase.from("calendar_entries").select("outlook_event_id").eq("id", id).maybeSingle();
  const eventId = (e as any)?.outlook_event_id ?? null;
  if (eventId) {
    await Promise.race([
      deleteEntryFromOutlook(eventId, id),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  }
  await supabase.from("calendar_entries").delete().eq("id", id);
}

/**
 * Meetings of a deal that were deleted or cancelled in Outlook — removed from
 * the CRM as well; returns their ids. Asks at most every 20 s per deal.
 */
const lastOutlookCheck = new Map<string, number>();
export async function syncDeletedMeetingsFromOutlook(trackingId: string, meetings: { id: string; outlook_event_id?: string | null }[]): Promise<string[]> {
  const ids = meetings.filter((m) => !!m.outlook_event_id).map((m) => m.id);
  if (!ids.length) return [];
  const now = Date.now();
  if (now - (lastOutlookCheck.get(trackingId) ?? 0) < 20_000) return [];
  lastOutlookCheck.set(trackingId, now);
  return meetingsGoneFromOutlook(ids);
}
export async function updateMeeting(id: string, patch: { title?: string; meet_at?: string | null; end_at?: string | null; kind?: MeetingKind }) {
  const row: Record<string, unknown> = {};
  if (patch.title != null) row.title = patch.title;
  if (patch.kind != null) row.meeting_kind = patch.kind;
  if (patch.meet_at) {
    const at = new Date(patch.meet_at);
    const startMin = at.getHours() * 60 + at.getMinutes();
    row.date_key = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
    row.entry_date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    row.start_min = startMin;
    row.end_min = endMinOf(startMin, patch.end_at);
  }
  await supabase.from("calendar_entries").update(row).eq("id", id);
  void syncMeetingToOutlook(id);
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
/** The day the deal was actually closed (won or lost). Expected dates are setDealCloseDate. */
export async function setDealClosedOn(trackingId: string, value: string | null): Promise<string | null> {
  const { error } = await supabase.from("trackings").update({ close_date: value || null }).eq("id", trackingId);
  return error?.message ?? null;
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

export async function listCatalogProducts(): Promise<import("../../settings/catalogApi").Product[]> {
  const { loadProducts } = await import("../../settings/catalogApi");
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
/**
 * Potential revenue per tracking — computed EXACTLY like the deal detail's
 * "Total if won": every active product and service line through lineTotal(),
 * i.e. with its calculator, tier price, quantity/days, recurring term,
 * discounts and the service's minimum billable unit.
 *
 * (It used to add the legacy trackings.product_price to each service's unit
 * price, so a 950 €/day × 15 days service counted as 950 € and every list,
 * board and forecast figure came out wrong.)
 */
export async function loadPotentialTotals(pre?: {
  /** Deals already loaded (skips re-reading trackings). */
  trackings?: Promise<{ id: string; product_price?: number | null }[]> | { id: string; product_price?: number | null }[];
  /** Catalog already being loaded by the page (skips loading it twice). */
  products?: Promise<any[]> | any[];
  services?: Promise<any[]> | any[];
}): Promise<Record<string, number>> {
  const { loadProducts, loadServices } = await import("../../settings/catalogApi");
  const [trRows, tpRows, svcRows, products, services] = await Promise.all([
    pre?.trackings ?? allRows(() => supabase.from("trackings").select("id, product_price").order("id")),
    allRows(() => supabase.from("tracking_products").select("*").order("id")),
    allRows(() => supabase.from("tracking_potential_services").select("*").order("id")),
    Promise.resolve(pre?.products ?? loadProducts()).catch(() => [] as any[]),
    Promise.resolve(pre?.services ?? loadServices()).catch(() => [] as any[]),
  ]);
  return potentialTotalsFromRows(trRows as any[], tpRows, svcRows, products as any[], services as any[]);
}

/** Potential revenue per deal from rows already read (deals, product and service lines, catalog). */
export function potentialTotalsFromRows(trRows: any[], tpRows: any[], svcRows: any[], products: any[], services: any[]): Record<string, number> {
  const tr = { data: trRows }, tp = { data: tpRows }, svc = { data: svcRows };
  const prodById = new Map<string, any>((products as any[]).map((p) => [p.id, p]));
  const svcById = new Map<string, any>((services as any[]).map((x) => [x.id, x]));
  const isActive = (r: any) => r.version_active !== false; // versioned lines: only the active one counts
  const totals: Record<string, number> = {};
  const withLines = new Set<string>();

  ((tp.data ?? []) as any[]).filter(isActive).forEach((l) => {
    if (!l.tracking_id) return;
    withLines.add(l.tracking_id);
    const prod = prodById.get(l.product_id);
    const base = prod?.tiers?.find((x: any) => x.id === l.tier_id)?.price;
    totals[l.tracking_id] = (totals[l.tracking_id] ?? 0) + lineTotal(l, (prod?.calculator ?? null) as Calculator | null, base);
  });
  ((svc.data ?? []) as any[]).filter(isActive).forEach((l) => {
    if (!l.tracking_id) return;
    const sv = svcById.get(l.service_id);
    const minUnit = sv?.min_unit ?? (sv?.rate_unit === "hour" ? 0.5 : 0.25);
    totals[l.tracking_id] = (totals[l.tracking_id] ?? 0) + lineTotal(l, (sv?.calculator ?? null) as Calculator | null, undefined, minUnit);
  });
  // Very old deals with no product lines yet: keep their single legacy price.
  ((tr.data ?? []) as any[]).forEach((t) => {
    if (!withLines.has(t.id) && Number(t.product_price)) totals[t.id] = (totals[t.id] ?? 0) + Number(t.product_price);
  });
  Object.keys(totals).forEach((k) => { totals[k] = Math.round(totals[k] * 100) / 100; });
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

/* ============================ Sales: everything in one call ============================
   The Sales page needs ~25 reads to open (deals, their lines, teams, roles, access rules,
   pipelines and phases, people, catalog…). The database function sales_boot()
   (empower_sales_boot.sql) returns them all in ONE request, under the same row security
   as the separate reads. Without that function this returns null and the page reads them
   one by one as before. */
export interface SalesBootRows {
  trackings: Tracking[];
  totals: Record<string, number>;
  teams: { members: Record<string, string[]>; owners: Record<string, string> };
  roles: { roles: import("../extras/salesRolesApi").SalesRole[]; missing: boolean };
  handovers: import("../extras/salesRolesApi").TrackingHandover[];
  phaseEvents: Record<string, string[]>;
  access: { rules: import("../extras/salesAccess").RuleMap; missing: boolean };
  me: { id: string; role: string; is_superadmin: boolean } | null;
  /** Only the companies behind the deals. */
  companies: any[];
  pipelines: any[];
  phasesByPipeline: Record<string, any[]>;
  profiles: any[];
  products: any[];
  services: any[];
}
/** null = not known yet, false = the database has no sales_boot() (don't ask again this visit). */
let salesBootAvailable: boolean | null = null;
export async function loadSalesBoot(): Promise<SalesBootRows | null> {
  if (salesBootAvailable === false) return null;
  const { data, error } = await supabase.rpc("sales_boot");
  if (error || !data || typeof data !== "object") {
    // Missing function (or not reachable): fall back for the rest of this visit.
    salesBootAvailable = false;
    if (error) console.info("[sales] sales_boot() not available, reading table by table:", error.message ?? error);
    return null;
  }
  salesBootAvailable = true;
  const d: any = data;
  const arr = (k: string): any[] => (Array.isArray(d[k]) ? d[k] : []);
  const [{ productsFromRows, servicesFromRows, calculatorsFromRows }, { phasesByPipelineFromRows }, rolesApi, { accessRulesFromRows }, { applyRolePreview }] = await Promise.all([
    import("../../settings/catalogApi"), import("../../settings/pipelineApi"), import("../extras/salesRolesApi"),
    import("../extras/salesAccess"), import("../../../framework/SuperAdmin"),
  ]);
  const calcRows = arr("calculators"), varRows = arr("calculator_variables");
  const products = productsFromRows(arr("products"), arr("product_tiers"), arr("product_tier_durations"), calculatorsFromRows(calcRows, varRows, "product"));
  const services = servicesFromRows(arr("services"), arr("service_roles"), calculatorsFromRows(calcRows, varRows, "service"));
  const trackings = trackingsFromRows(arr("trackings"), arr("tracking_contacts"));
  return {
    trackings,
    totals: potentialTotalsFromRows(trackings, arr("tracking_products"), arr("tracking_potential_services"), products, services),
    teams: teamsFromRows(arr("tracking_employees")),
    roles: { roles: arr("sales_roles").map(rolesApi.roleFrom), missing: !Array.isArray(d.sales_roles) },
    handovers: rolesApi.handoversFromRows(arr("tracking_handovers")),
    phaseEvents: rolesApi.phaseEventsFromRows(arr("tracking_phase_events")),
    access: { rules: accessRulesFromRows(arr("sales_access_rules"), arr("sales_visibility")), missing: !Array.isArray(d.sales_access_rules) },
    me: d.me ? applyRolePreview(d.me) : null,
    companies: arr("companies"),
    pipelines: arr("pipelines"),
    phasesByPipeline: phasesByPipelineFromRows(arr("pipeline_phases"), arr("pipeline_links"), arr("pipeline_phase_departments"), arr("pipeline_phase_items")),
    profiles: arr("profiles"),
    products, services,
  };
}