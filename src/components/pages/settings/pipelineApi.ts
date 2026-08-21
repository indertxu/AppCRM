/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

export interface Pipeline { id: string; name: string; description?: string | null; source_blueprint_id?: string | null; is_sales?: boolean; }
export interface Phase {
  id: string; pipeline_id: string; name: string;
  pos_x: number; pos_y: number; color?: string | null;
  handover_to?: string | null;
  source_phase_key?: string | null;
  sales_visible?: boolean;
  sales_outcome?: "win" | "loss" | null;
  deptKeys: string[];
  items: { type: "product" | "service"; id: string }[];
}
export interface PipelineLink { id: string; from_phase: string; to_phase: string; }

export async function listPipelines(): Promise<Pipeline[]> {
  const { data } = await supabase.from("pipelines").select("*").order("created_at");
  return (data ?? []) as Pipeline[];
}

export async function createPipeline(name: string): Promise<Pipeline | null> {
  const { data, error } = await supabase.from("pipelines").insert({ name }).select().single();
  if (error) return null;
  return data as Pipeline;
}

export async function renamePipeline(id: string, name: string) {
  await supabase.from("pipelines").update({ name }).eq("id", id);
}
export async function setPipelineSales(id: string, isSales: boolean) {
  await supabase.from("pipelines").update({ is_sales: isSales }).eq("id", id);
}
export async function deletePipeline(id: string) {
  await supabase.from("pipelines").delete().eq("id", id);
}

export async function loadPipeline(pipelineId: string): Promise<{ phases: Phase[]; links: PipelineLink[] }> {
  const { data: phaseRows } = await supabase.from("pipeline_phases").select("*").eq("pipeline_id", pipelineId).order("created_at");
  const { data: linkRows } = await supabase.from("pipeline_links").select("*").eq("pipeline_id", pipelineId);
  const { data: deptRows } = await supabase.from("pipeline_phase_departments").select("*");
  const { data: itemRows } = await supabase.from("pipeline_phase_items").select("*");

  const deptByPhase: Record<string, string[]> = {};
  (deptRows ?? []).forEach((d: any) => { (deptByPhase[d.phase_id] ??= []).push(d.dept_key); });
  const itemsByPhase: Record<string, { type: "product" | "service"; id: string }[]> = {};
  (itemRows ?? []).forEach((i: any) => { (itemsByPhase[i.phase_id] ??= []).push({ type: i.item_type, id: i.item_id }); });

  const phases: Phase[] = (phaseRows ?? []).map((p: any) => ({
    id: p.id, pipeline_id: p.pipeline_id, name: p.name, pos_x: p.pos_x, pos_y: p.pos_y, color: p.color,
    handover_to: p.handover_to ?? null,
    source_phase_key: p.source_phase_key ?? null,
    sales_visible: p.sales_visible ?? true,
    sales_outcome: p.sales_outcome ?? null,
    deptKeys: deptByPhase[p.id] ?? [],
    items: itemsByPhase[p.id] ?? [],
  }));
  const links = (linkRows ?? []) as PipelineLink[];
  return { phases, links };
}

// ---- Phase CRUD ----
export async function addPhase(pipelineId: string, x: number, y: number, sourcePhaseKey?: string): Promise<Phase | null> {
  const { data, error } = await supabase.from("pipeline_phases")
    .insert({ pipeline_id: pipelineId, name: "New phase", pos_x: Math.round(x), pos_y: Math.round(y), source_phase_key: sourcePhaseKey ?? null })
    .select().single();
  if (error) return null;
  return { ...(data as any), deptKeys: [], items: [] };
}
export async function updatePhase(id: string, patch: Partial<{ name: string; pos_x: number; pos_y: number; color: string | null; handover_to: string | null; sales_visible: boolean; sales_outcome: string | null }>) {
  const clean: any = { ...patch };
  if (clean.pos_x != null) clean.pos_x = Math.round(clean.pos_x);
  if (clean.pos_y != null) clean.pos_y = Math.round(clean.pos_y);
  const { error } = await supabase.from("pipeline_phases").update(clean).eq("id", id);
  if (error) console.error("updatePhase failed:", error.message, clean);
  return error?.message ?? null;
}
export async function deletePhase(id: string) {
  await supabase.from("pipeline_phases").delete().eq("id", id);
}

// ---- Links ----
export async function addLink(pipelineId: string, from: string, to: string): Promise<PipelineLink | null> {
  if (from === to) return null;
  const { data, error } = await supabase.from("pipeline_links")
    .insert({ pipeline_id: pipelineId, from_phase: from, to_phase: to }).select().single();
  if (error) return null;
  return data as PipelineLink;
}
export async function removeLink(id: string) {
  await supabase.from("pipeline_links").delete().eq("id", id);
}

// ---- Phase departments (replace set) ----
export async function setPhaseDepartments(phaseId: string, deptKeys: string[]) {
  await supabase.from("pipeline_phase_departments").delete().eq("phase_id", phaseId);
  if (deptKeys.length)
    await supabase.from("pipeline_phase_departments").insert(deptKeys.map((k) => ({ phase_id: phaseId, dept_key: k })));
}

// ---- Phase items (replace set) ----
export async function setPhaseItems(phaseId: string, items: { type: "product" | "service"; id: string }[]) {
  await supabase.from("pipeline_phase_items").delete().eq("phase_id", phaseId);
  if (items.length)
    await supabase.from("pipeline_phase_items").insert(items.map((it) => ({ phase_id: phaseId, item_type: it.type, item_id: it.id })));
}

// ---- Blueprint sync ----
export async function setPipelineSource(pipelineId: string, blueprintId: string) {
  await supabase.from("pipelines").update({ source_blueprint_id: blueprintId }).eq("id", pipelineId);
}

// Pipelines generated from a given blueprint (for the "this affects N pipelines" notice).
export async function pipelinesFromBlueprint(blueprintId: string): Promise<Pipeline[]> {
  const { data } = await supabase.from("pipelines").select("*").eq("source_blueprint_id", blueprintId);
  return (data ?? []) as Pipeline[];
}

// Sync a pipeline's phases to its source blueprint: ADD phases for new blueprint
// phases, REMOVE phases whose blueprint phase no longer exists. Leaves existing
// phases (and their departments/items) untouched. Returns {added, removed}.
export async function syncPipelineToBlueprint(
  pipelineId: string,
  blueprintPhases: { id: string; name: string }[],
): Promise<{ added: number; removed: number }> {
  const { data: phaseRows } = await supabase.from("pipeline_phases").select("*").eq("pipeline_id", pipelineId);
  const existing = (phaseRows ?? []) as any[];
  const bpIds = new Set(blueprintPhases.map((p) => p.id));
  const haveKeys = new Set(existing.map((p) => p.source_phase_key).filter(Boolean));

  // Remove phases whose source blueprint phase is gone (only ones that came from the blueprint).
  const toRemove = existing.filter((p) => p.source_phase_key && !bpIds.has(p.source_phase_key));
  for (const p of toRemove) await supabase.from("pipeline_phases").delete().eq("id", p.id);

  // Add phases for blueprint phases we don't have yet.
  const toAdd = blueprintPhases.filter((bp) => !haveKeys.has(bp.id));
  let x = 60 + existing.length * (280);
  for (const bp of toAdd) {
    await supabase.from("pipeline_phases").insert({
      pipeline_id: pipelineId, name: bp.name || "New phase",
      pos_x: Math.round(x), pos_y: 120, source_phase_key: bp.id,
    });
    x += 280;
  }
  return { added: toAdd.length, removed: toRemove.length };
}