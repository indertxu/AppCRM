/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

export interface Pipeline { id: string; name: string; description?: string | null; source_blueprint_id?: string | null; is_sales?: boolean; sort_order?: number | null; folder_id?: string | null; created_at?: string; }

/** A folder of pipelines (Settings → Pipelines); folders can sit inside folders. */
export interface PipelineFolder { id: string; name: string; parent_id: string | null; sort_order?: number | null; created_at?: string; }

/** The company's order (Settings → Pipelines), then oldest first for any not placed yet. */
/** Why a save didn't stick: the database said no, or it changed nothing (no permission). */
const NO_RIGHTS = "Not saved: the database didn't accept the change for your user (no rights to edit pipelines). Ask an admin.";
function wrote(r: { error: { message: string } | null; data: unknown[] | null }, expect = 1): string | null {
  if (r.error) return r.error.message;
  return (r.data ?? []).length < expect ? NO_RIGHTS : null;
}

// ---- Folders ----
/** null when the folders table isn't there yet (56_pipeline_folders.sql not run). */
export async function listFolders(): Promise<PipelineFolder[] | null> {
  const { data, error } = await supabase.from("pipeline_folders").select("id, name, parent_id, sort_order, created_at").order("created_at");
  if (error) return null;
  return (data ?? []) as PipelineFolder[];
}
export async function createFolder(name: string, parentId: string | null): Promise<PipelineFolder | string> {
  const { data, error } = await supabase.from("pipeline_folders").insert({ name, parent_id: parentId }).select().single();
  if (error) return /pipeline_folders/.test(error.message) ? "Run 56_pipeline_folders.sql in Supabase once to use folders." : error.message;
  return data as PipelineFolder;
}
/** Every folder top-down with its full name ("Sales › Upsell"), for grouping pipelines in lists. */
export function folderPaths(folders: PipelineFolder[]): { id: string; path: string }[] {
  const ids = new Set(folders.map((f) => f.id));
  const parentOf = (f: PipelineFolder) => (f.parent_id && ids.has(f.parent_id) && f.parent_id !== f.id ? f.parent_id : null);
  const kids = (parent: string | null) => folders.filter((f) => parentOf(f) === parent)
    .sort((a, b) => ((a.sort_order ?? 1e9) - (b.sort_order ?? 1e9)) || a.name.localeCompare(b.name));
  const out: { id: string; path: string }[] = [];
  const walk = (parent: string | null, prefix: string, depth: number) => {
    if (depth > 64) return;
    for (const f of kids(parent)) {
      const path = prefix ? `${prefix} › ${f.name || "Folder"}` : (f.name || "Folder");
      out.push({ id: f.id, path });
      walk(f.id, path, depth + 1);
    }
  };
  walk(null, "", 0);
  return out;
}
export async function renameFolder(id: string, name: string): Promise<string | null> {
  return wrote(await supabase.from("pipeline_folders").update({ name }).eq("id", id).select("id"));
}
export async function moveFolder(id: string, parentId: string | null): Promise<string | null> {
  return wrote(await supabase.from("pipeline_folders").update({ parent_id: parentId }).eq("id", id).select("id"));
}
/** Its sub-folders go with it; the pipelines inside move to the top level (the database does both). */
export async function deleteFolder(id: string): Promise<string | null> {
  return wrote(await supabase.from("pipeline_folders").delete().eq("id", id).select("id"));
}
export async function setPipelineFolder(id: string, folderId: string | null): Promise<string | null> {
  return wrote(await supabase.from("pipelines").update({ folder_id: folderId }).eq("id", id).select("id"));
}

export function sortPipelines<T extends { sort_order?: number | null; created_at?: string }>(ps: T[]): T[] {
  return [...ps].sort((a, b) => {
    const x = a.sort_order ?? Number.MAX_SAFE_INTEGER, y = b.sort_order ?? Number.MAX_SAFE_INTEGER;
    return x !== y ? x - y : String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
  });
}

/**
 * Save the order of the pipelines for the whole company: everyone sees the
 * list (here, in Sales, in filters) in this order. Needs the sort_order
 * column (pipelines_order.sql); without it the order isn't kept.
 */
export async function savePipelineOrder(ids: string[]): Promise<string | null> {
  for (let i = 0; i < ids.length; i++) {
    const r = await supabase.from("pipelines").update({ sort_order: i }).eq("id", ids[i]).select("id");
    if (r.error) return /sort_order/.test(r.error.message) ? "Run pipelines_order.sql in Supabase once so the order can be saved." : r.error.message;
    if (!(r.data ?? []).length) return NO_RIGHTS;
  }
  return null;
}

/**
 * Move deals to another pipeline. Each keeps its phase when the new pipeline
 * has one with the same name; won and lost deals land on its win/loss phase;
 * anything else starts at its first phase. Notes, tasks and meetings filed
 * under the old phase follow the deal.
 */
export async function moveDealsToPipeline(dealIds: string[], toPipelineId: string): Promise<string | null> {
  if (!dealIds.length) return null;
  const { data: deals, error: dErr } = await supabase.from("trackings").select("id, status, current_phase_id, pipeline_id").in("id", dealIds);
  if (dErr) return dErr.message;
  const { phases } = await loadPipeline(toPipelineId);
  const visible = phases.filter((p) => p.sales_visible !== false);
  const first = visible.find((p) => !p.sales_outcome) ?? visible[0] ?? phases[0] ?? null;
  const win = visible.find((p) => p.sales_outcome === "win"), loss = visible.find((p) => p.sales_outcome === "loss");
  const fromPipes = Array.from(new Set(((deals ?? []) as any[]).map((d) => d.pipeline_id).filter(Boolean)));
  const { data: oldPhases } = fromPipes.length
    ? await supabase.from("pipeline_phases").select("id, name, pipeline_id").in("pipeline_id", fromPipes)
    : { data: [] as any[] };
  const oldName = new Map(((oldPhases ?? []) as any[]).map((p) => [p.id, p.name as string]));
  const norm = (x: string) => x.trim().toLowerCase();
  for (const d of (deals ?? []) as any[]) {
    if (d.pipeline_id === toPipelineId) continue;
    const was = d.current_phase_id ? oldName.get(d.current_phase_id) : undefined;
    const target = (was && phases.find((p) => norm(p.name) === norm(was)))
      || (d.status === "won" ? win : d.status === "lost" ? loss : undefined) || first;
    const { error } = await supabase.from("trackings").update({ pipeline_id: toPipelineId, current_phase_id: target?.id ?? null }).eq("id", d.id);
    if (error) return `Couldn't move a deal: ${error.message}`;
    const oldIds = ((oldPhases ?? []) as any[]).filter((p) => p.pipeline_id === d.pipeline_id).map((p) => p.id);
    if (oldIds.length) {
      const to = target?.id ?? null;
      await supabase.from("tracking_notes").update({ phase_id: to }).eq("tracking_id", d.id).in("phase_id", oldIds);
      await supabase.from("tracking_tasks").update({ phase_id: to }).eq("tracking_id", d.id).in("phase_id", oldIds);
      await supabase.from("calendar_entries").update({ phase_id_ref: to }).eq("tracking_id", d.id).in("phase_id_ref", oldIds);
      await supabase.from("tracking_phase_events").delete().eq("tracking_id", d.id).in("phase_id", oldIds);
    }
    if (target) await supabase.from("tracking_phase_events").insert({ tracking_id: d.id, phase_id: target.id });
  }
  return null;
}
export interface Phase {
  id: string; pipeline_id: string; name: string;
  pos_x: number; pos_y: number; color?: string | null;
  handover_to?: string | null;
  source_phase_key?: string | null;
  sales_visible?: boolean;
  sales_outcome?: "win" | "loss" | null;
  close_probability?: number | null;
  deptKeys: string[];
  items: { type: "product" | "service"; id: string }[];
}
export interface PipelineLink { id: string; from_phase: string; to_phase: string; }

export async function listPipelines(): Promise<Pipeline[]> {
  const { data } = await supabase.from("pipelines").select("*").order("created_at");
  return sortPipelines((data ?? []) as Pipeline[]);
}

export async function createPipeline(name: string, folderId?: string | null): Promise<Pipeline | null> {
  const { data, error } = await supabase.from("pipelines").insert(folderId ? { name, folder_id: folderId } : { name }).select().single();
  if (error) return null;
  return data as Pipeline;
}

export async function renamePipeline(id: string, name: string): Promise<string | null> {
  return wrote(await supabase.from("pipelines").update({ name }).eq("id", id).select("id"));
}
export async function setPipelineSales(id: string, isSales: boolean) {
  await supabase.from("pipelines").update({ is_sales: isSales }).eq("id", id);
}
export async function deletePipeline(id: string) {
  await supabase.from("pipelines").delete().eq("id", id);
}

/** What depends on a pipeline — shown before deleting it. */
export interface PipelineUsage {
  phases: number;
  deals: { id: string; status: string; current_phase_id: string | null }[];
  /** Phases of OTHER pipelines that hand clients over to this one. */
  handoversIn: { phaseId: string; phaseName: string; pipelineName: string }[];
  /** Sales handoffs still waiting to be converted into this pipeline. */
  pendingHandoffs: number;
}
export async function pipelineUsage(id: string): Promise<PipelineUsage> {
  const [ph, tr, hin, hof, pipes] = await Promise.all([
    supabase.from("pipeline_phases").select("id").eq("pipeline_id", id),
    supabase.from("trackings").select("id, status, current_phase_id").eq("pipeline_id", id).range(0, 99999),
    supabase.from("pipeline_phases").select("id, name, pipeline_id").eq("handover_to", id),
    supabase.from("handoffs").select("id").eq("dest_pipeline_id", id).eq("status", "pending"),
    supabase.from("pipelines").select("id, name"),
  ]);
  const pname = new Map(((pipes.data ?? []) as any[]).map((p) => [p.id, p.name]));
  return {
    phases: (ph.data ?? []).length,
    deals: ((tr.data ?? []) as any[]).map((t) => ({ id: t.id, status: t.status, current_phase_id: t.current_phase_id ?? null })),
    handoversIn: ((hin.data ?? []) as any[]).filter((x) => x.pipeline_id !== id).map((x) => ({ phaseId: x.id, phaseName: x.name, pipelineName: pname.get(x.pipeline_id) ?? "Pipeline" })),
    pendingHandoffs: hof.error ? 0 : (hof.data ?? []).length,
  };
}

/**
 * Delete a pipeline without leaving anything pointing at it:
 *  - its deals are moved to another pipeline (same-named phase, else the first
 *    one) or kept without a pipeline — never deleted with it;
 *  - phases of other pipelines stop handing over to it;
 *  - pending sales handoffs into it lose their destination (they can be re-routed).
 * Then the pipeline goes (its phases, links, departments and items with it).
 */
export async function deletePipelineSafely(id: string, opts: { moveDealsTo: string | null }): Promise<string | null> {
  const usage = await pipelineUsage(id);
  const { data: oldPhases } = await supabase.from("pipeline_phases").select("id, name").eq("pipeline_id", id);
  const oldIds = ((oldPhases ?? []) as any[]).map((p) => p.id);
  const oldName = new Map(((oldPhases ?? []) as any[]).map((p) => [p.id, p.name as string]));
  // notes, tasks and meetings filed under an old phase follow the deal (or lose the phase)
  const repoint = async (dealId: string, phaseId: string | null) => {
    if (!oldIds.length) return;
    await supabase.from("tracking_notes").update({ phase_id: phaseId }).eq("tracking_id", dealId).in("phase_id", oldIds);
    await supabase.from("tracking_tasks").update({ phase_id: phaseId }).eq("tracking_id", dealId).in("phase_id", oldIds);
    await supabase.from("calendar_entries").update({ phase_id_ref: phaseId }).eq("tracking_id", dealId).in("phase_id_ref", oldIds);
  };

  if (usage.deals.length) {
    if (opts.moveDealsTo) {
      const { phases } = await loadPipeline(opts.moveDealsTo);
      const visible = phases.filter((p) => p.sales_visible !== false);
      const first = visible.find((p) => !p.sales_outcome) ?? visible[0] ?? phases[0] ?? null;
      const win = visible.find((p) => p.sales_outcome === "win"), loss = visible.find((p) => p.sales_outcome === "loss");
      const norm = (s: string) => s.trim().toLowerCase();
      for (const d of usage.deals) {
        const was = d.current_phase_id ? oldName.get(d.current_phase_id) : undefined;
        const target = (was && phases.find((p) => norm(p.name) === norm(was)))
          || (d.status === "won" ? win : d.status === "lost" ? loss : undefined) || first;
        const { error } = await supabase.from("trackings").update({ pipeline_id: opts.moveDealsTo, current_phase_id: target?.id ?? null }).eq("id", d.id);
        if (error) return `Couldn't move a deal: ${error.message}`;
        await repoint(d.id, target?.id ?? null);
        if (oldIds.length) await supabase.from("tracking_phase_events").delete().eq("tracking_id", d.id).in("phase_id", oldIds);
        if (target) await supabase.from("tracking_phase_events").insert({ tracking_id: d.id, phase_id: target.id });
      }
    } else {
      const { error } = await supabase.from("trackings").update({ pipeline_id: null, current_phase_id: null }).eq("pipeline_id", id);
      if (error) return `Couldn't detach its deals: ${error.message}`;
      for (const d of usage.deals) {
        await repoint(d.id, null);
        if (oldIds.length) await supabase.from("tracking_phase_events").delete().eq("tracking_id", d.id).in("phase_id", oldIds);
      }
    }
  }
  if (usage.handoversIn.length) await supabase.from("pipeline_phases").update({ handover_to: null }).eq("handover_to", id);
  if (usage.pendingHandoffs) await supabase.from("handoffs").update({ dest_pipeline_id: null }).eq("dest_pipeline_id", id).eq("status", "pending");

  const { error } = await supabase.from("pipelines").delete().eq("id", id);
  if (error) return error.message;
  return null;
}

/**
 * Put phases in FLOW order instead of creation order, so a phase added later
 * (e.g. an "Opportunity" step between existing phases) shows up where it sits
 * in the pipeline — on the board, the opportunity bar, the deal detail and the
 * progress %.
 *   1. Follow the arrows (topological order). Ties — parallel branches, or
 *      phases with no arrows yet — go left-to-right by their canvas position.
 *   2. Outcome phases always close the list: Won, then Lost.
 *   3. Anything left (a loop in the arrows) is appended by canvas position.
 */
export function orderPhases(phases: Phase[], links: PipelineLink[]): Phase[] {
  const byPos = (a: Phase, b: Phase) => (a.pos_x - b.pos_x) || (a.pos_y - b.pos_y);
  const normal = phases.filter((p) => !p.sales_outcome);
  const ids = new Set(normal.map((p) => p.id));
  const indeg: Record<string, number> = {};
  const next: Record<string, string[]> = {};
  normal.forEach((p) => { indeg[p.id] = 0; next[p.id] = []; });
  links.forEach((l) => {
    if (!ids.has(l.from_phase) || !ids.has(l.to_phase)) return; // links into Won/Lost don't affect the order
    next[l.from_phase].push(l.to_phase);
    indeg[l.to_phase] += 1;
  });
  const byId = Object.fromEntries(normal.map((p) => [p.id, p]));
  const queue = normal.filter((p) => indeg[p.id] === 0).sort(byPos);
  const out: Phase[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    out.push(cur);
    next[cur.id].map((id) => byId[id]).sort(byPos).forEach((n) => {
      indeg[n.id] -= 1;
      if (indeg[n.id] === 0) { queue.push(n); queue.sort(byPos); }
    });
  }
  const placed = new Set(out.map((p) => p.id));
  const rest = normal.filter((p) => !placed.has(p.id)).sort(byPos);
  const win = phases.filter((p) => p.sales_outcome === "win").sort(byPos);
  const loss = phases.filter((p) => p.sales_outcome === "loss").sort(byPos);
  return [...out, ...rest, ...win, ...loss];
}

/** Shape a phase row (with its departments and linked items). */
function phaseFrom(p: any, deptByPhase: Record<string, string[]>, itemsByPhase: Record<string, { type: "product" | "service"; id: string }[]>): Phase {
  return {
    id: p.id, pipeline_id: p.pipeline_id, name: p.name, pos_x: p.pos_x, pos_y: p.pos_y, color: p.color,
    handover_to: p.handover_to ?? null,
    source_phase_key: p.source_phase_key ?? null,
    sales_visible: p.sales_visible ?? true,
    sales_outcome: p.sales_outcome ?? null,
    close_probability: p.close_probability ?? null,
    deptKeys: deptByPhase[p.id] ?? [],
    items: itemsByPhase[p.id] ?? [],
  };
}

/**
 * Phases, arrows, departments and items — all four queries at once (they used
 * to run one after another: four round trips before a phase could show).
 * Without a pipeline id it loads every pipeline in the same single trip.
 */
async function loadPhaseRows(pipelineId?: string) {
  const ph = supabase.from("pipeline_phases").select("*");
  const ln = supabase.from("pipeline_links").select("*");
  const [{ data: phaseRows }, { data: linkRows }, { data: deptRows }, { data: itemRows }] = await Promise.all([
    (pipelineId ? ph.eq("pipeline_id", pipelineId) : ph).order("created_at").range(0, 9999),
    (pipelineId ? ln.eq("pipeline_id", pipelineId) : ln).range(0, 9999),
    supabase.from("pipeline_phase_departments").select("*").range(0, 9999),
    supabase.from("pipeline_phase_items").select("*").range(0, 9999),
  ]);
  return shapePhaseRows(phaseRows ?? [], linkRows ?? [], deptRows ?? [], itemRows ?? []);
}

/** Phase rows (with their departments and items) and arrows, shaped — from whatever read them. */
function shapePhaseRows(phaseRows: any[], linkRows: any[], deptRows: any[], itemRows: any[]) {
  const deptByPhase: Record<string, string[]> = {};
  deptRows.forEach((d: any) => { (deptByPhase[d.phase_id] ??= []).push(d.dept_key); });
  const itemsByPhase: Record<string, { type: "product" | "service"; id: string }[]> = {};
  itemRows.forEach((i: any) => { (itemsByPhase[i.phase_id] ??= []).push({ type: i.item_type, id: i.item_id }); });
  const phases: Phase[] = phaseRows.map((p: any) => phaseFrom(p, deptByPhase, itemsByPhase));
  return { phases, links: linkRows as PipelineLink[] };
}

/** Every pipeline's phases in flow order, from rows already read (Sales reads them in one call). */
export function phasesByPipelineFromRows(phaseRows: any[], linkRows: any[], deptRows: any[], itemRows: any[]): Record<string, Phase[]> {
  return groupPhases(shapePhaseRows(phaseRows, linkRows, deptRows, itemRows));
}

function groupPhases({ phases, links }: { phases: Phase[]; links: PipelineLink[] }): Record<string, Phase[]> {
  const phasesBy: Record<string, Phase[]> = {};
  const linksBy: Record<string, PipelineLink[]> = {};
  phases.forEach((p) => { (phasesBy[p.pipeline_id] ??= []).push(p); });
  links.forEach((l: any) => { (linksBy[l.pipeline_id] ??= []).push(l); });
  const out: Record<string, Phase[]> = {};
  Object.keys(phasesBy).forEach((id) => { out[id] = orderPhases(phasesBy[id], linksBy[id] ?? []); });
  return out;
}

export async function loadPipeline(pipelineId: string): Promise<{ phases: Phase[]; links: PipelineLink[] }> {
  const { phases, links } = await loadPhaseRows(pipelineId);
  return { phases: orderPhases(phases, links), links };
}

/** Every pipeline's phases, in order, keyed by pipeline id — one round trip for all of them. */
export async function loadPhasesByPipeline(): Promise<Record<string, Phase[]>> {
  return groupPhases(await loadPhaseRows());
}

// ---- Phase CRUD ----
export async function addPhase(pipelineId: string, x: number, y: number, sourcePhaseKey?: string): Promise<Phase | null> {
  const { data, error } = await supabase.from("pipeline_phases")
    .insert({ pipeline_id: pipelineId, name: "New phase", pos_x: Math.round(x), pos_y: Math.round(y), source_phase_key: sourcePhaseKey ?? null })
    .select().single();
  if (error) return null;
  return { ...(data as any), deptKeys: [], items: [] };
}
export async function updatePhase(id: string, patch: Partial<{ name: string; pos_x: number; pos_y: number; color: string | null; handover_to: string | null; sales_visible: boolean; sales_outcome: string | null; close_probability: number | null }>) {
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

// ---- The editor's draft: everything is kept on screen until Save ----
export interface PipelineDraft {
  name: string; isSales: boolean; folderId: string | null; source: string | null;
  phases: Phase[]; links: PipelineLink[];
}
const PHASE_FIELDS = ["name", "pos_x", "pos_y", "color", "handover_to", "sales_visible", "sales_outcome", "close_probability", "source_phase_key"] as const;
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const setKey = (xs: string[]) => [...xs].sort().join("|");
const itemKey = (xs: { type: string; id: string }[]) => xs.map((i) => `${i.type}:${i.id}`).sort().join("|");

/** What Save has to write to turn `base` (as loaded) into `draft` (as on screen). */
export function diffDraft(base: PipelineDraft, draft: PipelineDraft) {
  const pipe: Record<string, unknown> = {};
  if (draft.name.trim() !== base.name) pipe.name = draft.name.trim() || base.name;
  if (draft.isSales !== base.isSales) pipe.is_sales = draft.isSales;
  if (!same(draft.folderId, base.folderId)) pipe.folder_id = draft.folderId;
  if (!same(draft.source, base.source)) pipe.source_blueprint_id = draft.source;
  const before = new Map(base.phases.map((p) => [p.id, p]));
  const now = new Map(draft.phases.map((p) => [p.id, p]));
  const added = draft.phases.filter((p) => !before.has(p.id));
  const removed = base.phases.filter((p) => !now.has(p.id)).map((p) => p.id);
  const changed: { id: string; patch: Record<string, unknown> }[] = [];
  const depts: string[] = [], items: string[] = [];
  draft.phases.forEach((p) => {
    const o = before.get(p.id);
    if (!o) { if (p.deptKeys.length) depts.push(p.id); if (p.items.length) items.push(p.id); return; }
    const patch: Record<string, unknown> = {};
    PHASE_FIELDS.forEach((k) => { if (!same((p as any)[k], (o as any)[k])) patch[k] = (p as any)[k] ?? null; });
    if (Object.keys(patch).length) changed.push({ id: p.id, patch });
    if (setKey(p.deptKeys) !== setKey(o.deptKeys)) depts.push(p.id);
    if (itemKey(p.items) !== itemKey(o.items)) items.push(p.id);
  });
  const linkKey = (l: PipelineLink) => `${l.from_phase}>${l.to_phase}`;
  const baseLinks = new Set(base.links.map(linkKey)), draftLinks = new Set(draft.links.map(linkKey));
  const addLinks = draft.links.filter((l) => !baseLinks.has(linkKey(l)));
  const delLinks = base.links.filter((l) => !draftLinks.has(linkKey(l))).map((l) => l.id);
  // a phase moved, renamed and recoloured is one change for the person, not three
  const touched = new Set([...added.map((p) => p.id), ...removed, ...changed.map((c) => c.id), ...depts, ...items]);
  const count = Object.keys(pipe).length + touched.size + addLinks.length + delLinks.length;
  return { pipe, added, removed, changed, depts, items, addLinks, delLinks, count };
}

/**
 * Write the draft. Every write is checked: an error, or a write that changed
 * nothing (your user can't edit pipelines), stops and says why — nothing is
 * silently lost. Returns null when everything was saved.
 */
export async function savePipelineDraft(pipelineId: string, base: PipelineDraft, draft: PipelineDraft): Promise<string | null> {
  const d = diffDraft(base, draft);
  let e: string | null;
  if (Object.keys(d.pipe).length) {
    e = wrote(await supabase.from("pipelines").update(d.pipe).eq("id", pipelineId).select("id"));
    if (e) return /folder_id/.test(e) ? "Run 56_pipeline_folders.sql in Supabase once to use folders." : e;
  }
  // links first off, so a removed phase doesn't leave its arrows behind
  if (d.delLinks.length) {
    e = wrote(await supabase.from("pipeline_links").delete().in("id", d.delLinks).select("id"), d.delLinks.length);
    if (e) return e;
  }
  if (d.removed.length) {
    const r = await supabase.from("pipeline_phases").delete().in("id", d.removed).select("id");
    if ((r.error as any)?.code === "23503") {
      const names = base.phases.filter((p) => d.removed.includes(p.id)).map((p) => `"${p.name}"`).join(", ");
      return `Can't delete ${names}: deals (or their notes, tasks or meetings) are still in it. Move them to another phase first.`;
    }
    e = wrote(r, d.removed.length);
    if (e) return e;
  }
  // a Win / Loss taken off one phase before it's put on another
  const order = [...d.changed].sort((a, b) => Number(a.patch.sales_outcome !== null) - Number(b.patch.sales_outcome !== null));
  for (const c of order) {
    const patch = { ...c.patch };
    if (patch.pos_x != null) patch.pos_x = Math.round(patch.pos_x as number);
    if (patch.pos_y != null) patch.pos_y = Math.round(patch.pos_y as number);
    e = wrote(await supabase.from("pipeline_phases").update(patch).eq("id", c.id).select("id"));
    if (e) return e;
  }
  if (d.added.length) {
    const rows = d.added.map((p) => {
      const r: Record<string, unknown> = { id: p.id, pipeline_id: pipelineId, name: p.name || "New phase", pos_x: Math.round(p.pos_x), pos_y: Math.round(p.pos_y) };
      if (p.source_phase_key) r.source_phase_key = p.source_phase_key;
      if (p.color) r.color = p.color;
      if (p.handover_to) r.handover_to = p.handover_to;
      if (p.sales_visible === false) r.sales_visible = false;
      if (p.sales_outcome) r.sales_outcome = p.sales_outcome;
      if (p.close_probability != null) r.close_probability = p.close_probability;
      return r;
    });
    e = wrote(await supabase.from("pipeline_phases").insert(rows).select("id"), rows.length);
    if (e) return e;
  }
  if (d.addLinks.length) {
    const rows = d.addLinks.map((l) => ({ id: l.id, pipeline_id: pipelineId, from_phase: l.from_phase, to_phase: l.to_phase }));
    e = wrote(await supabase.from("pipeline_links").insert(rows).select("id"), rows.length);
    if (e) return e;
  }
  const byId = new Map(draft.phases.map((p) => [p.id, p]));
  for (const id of d.depts) {
    const p = byId.get(id)!;
    const del = await supabase.from("pipeline_phase_departments").delete().eq("phase_id", id);
    if (del.error) return del.error.message;
    if (p.deptKeys.length) {
      e = wrote(await supabase.from("pipeline_phase_departments").insert(p.deptKeys.map((k) => ({ phase_id: id, dept_key: k }))).select("phase_id"), p.deptKeys.length);
      if (e) return e;
    }
  }
  for (const id of d.items) {
    const p = byId.get(id)!;
    const del = await supabase.from("pipeline_phase_items").delete().eq("phase_id", id);
    if (del.error) return del.error.message;
    if (p.items.length) {
      e = wrote(await supabase.from("pipeline_phase_items").insert(p.items.map((it) => ({ phase_id: id, item_type: it.type, item_id: it.id }))).select("phase_id"), p.items.length);
      if (e) return e;
    }
  }
  return null;
}
