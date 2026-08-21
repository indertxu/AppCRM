/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

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
export interface TrackMeeting { id: string; phase_id: string | null; title: string; meet_at: string | null; }
export interface PhaseEvent { id: string; phase_id: string | null; entered_at: string; }
export interface PotentialService { id: string; service_id: string | null; label: string | null; price: number; }
export interface Assignee { id: string; item_type: string; item_id: string; kind: "employee" | "contact"; employee_id: string | null; contact_id: string | null; }

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

// ---- Trackings ----
export async function listTrackings(): Promise<Tracking[]> {
  const { data: rows } = await supabase.from("trackings").select("*").order("created_at", { ascending: false });
  const { data: links } = await supabase.from("tracking_contacts").select("tracking_id,contact_id");
  const byTracking: Record<string, string[]> = {};
  (links ?? []).forEach((l: any) => { (byTracking[l.tracking_id] ??= []).push(l.contact_id); });
  return (rows ?? []).map((r: any) => ({ ...r, contactIds: byTracking[r.id] ?? [] }));
}

export async function createTracking(input: {
  company_id: string | null; pipeline_id: string; product_id: string | null;
  current_phase_id: string | null; contactIds: string[];
}): Promise<string | null> {
  const { data, error } = await supabase.from("trackings").insert({
    company_id: input.company_id, pipeline_id: input.pipeline_id,
    product_id: input.product_id, current_phase_id: input.current_phase_id, status: "active",
  }).select("id").single();
  if (error) return null;
  const id = data.id as string;
  if (input.contactIds.length) {
    await supabase.from("tracking_contacts").insert(input.contactIds.map((cid) => ({ tracking_id: id, contact_id: cid })));
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
export async function addMeeting(trackingId: string, phaseId: string | null, title: string, meetAt: string | null): Promise<TrackMeeting | null> {
  const { data } = await supabase.from("tracking_meetings").insert({ tracking_id: trackingId, phase_id: phaseId, title, meet_at: meetAt }).select().single();
  return (data as any) ?? null;
}
export async function deleteMeeting(id: string) {
  await supabase.from("tracking_meetings").delete().eq("id", id);
}
export async function updateMeeting(id: string, patch: { title?: string; meet_at?: string | null }) {
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
export interface HandoffService { label: string; price: number; }
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
  created_at: string;
  converted_at: string | null;
}

// Create one handoff row per destination pipeline.
export async function createHandoffs(input: {
  tracking_id: string;
  company_id: string | null;
  company_name: string | null;
  product_id: string | null;
  destinations: { id: string; name: string }[];
  services: HandoffService[];
  potential_value: number;
}): Promise<number> {
  const rows = input.destinations.map((d) => ({
    tracking_id: input.tracking_id,
    company_id: input.company_id,
    company_name: input.company_name,
    product_id: input.product_id,
    dest_pipeline_id: d.id,
    dest_pipeline_name: d.name,
    services: input.services,
    potential_value: Math.round(input.potential_value),
    status: "pending",
  }));
  if (!rows.length) return 0;
  const { error } = await supabase.from("handoffs").insert(rows);
  return error ? 0 : rows.length;
}

export async function listHandoffs(status = "pending"): Promise<Handoff[]> {
  const { data } = await supabase.from("handoffs").select("*").eq("status", status).order("created_at", { ascending: false });
  return (data ?? []) as Handoff[];
}

export async function markHandoffConverted(id: string, clientId: string) {
  await supabase.from("handoffs").update({ status: "converted", created_client_id: clientId, converted_at: new Date().toISOString() }).eq("id", id);
}
export async function dismissHandoff(id: string) {
  await supabase.from("handoffs").update({ status: "dismissed" }).eq("id", id);
}