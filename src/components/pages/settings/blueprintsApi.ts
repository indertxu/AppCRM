/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

export interface BlueprintTask { id: string; name: string; percent: number; }
export interface BlueprintPhase { id: string; name: string; percent: number; tasks: BlueprintTask[]; }
export interface Blueprint { id: string; name: string; projectTypeId: string; phases: BlueprintPhase[]; }
export interface ProjectType { id: string; name: string; }
export interface ClientRole { id: string; name: string; userIds: string[]; isSupervision: boolean; }

export async function loadBlueprintData(): Promise<{
  projectTypes: ProjectType[]; blueprints: Blueprint[]; roles: ClientRole[];
}> {
  const { data: pts } = await supabase.from("project_types").select("*").order("name");
  const projectTypes = (pts ?? []).map((r: any) => ({ id: r.id, name: r.name }));

  const { data: bps } = await supabase.from("phase_blueprints").select("*");
  const blueprints = (bps ?? []).map((r: any) => ({
    id: r.id, name: r.name ?? "", projectTypeId: r.project_type_id ?? "", phases: r.phases ?? [],
  }));

  const { data: rls } = await supabase.from("client_roles").select("*");
  const roles = (rls ?? []).map((r: any) => ({
    id: r.id, name: r.name ?? "", userIds: r.user_ids ?? [], isSupervision: !!r.is_supervision,
  }));

  return { projectTypes, blueprints, roles };
}

// Full sync: mirrors the (already working) logic from ClientsPage so both places
// stay consistent — delete rows that were removed, upsert the rest.
export async function saveBlueprintData(
  projectTypes: ProjectType[], blueprints: Blueprint[], roles: ClientRole[],
): Promise<void> {
  const { data: exT } = await supabase.from("project_types").select("id");
  const keepT = new Set(projectTypes.map((t) => t.id));
  const delT = (exT ?? []).filter((r: any) => !keepT.has(r.id)).map((r: any) => r.id);
  if (delT.length) await supabase.from("project_types").delete().in("id", delT);
  if (projectTypes.length)
    await supabase.from("project_types").upsert(projectTypes.map((t) => ({ id: t.id, name: t.name })));

  const { data: exB } = await supabase.from("phase_blueprints").select("id");
  const keepB = new Set(blueprints.map((b) => b.id));
  const delB = (exB ?? []).filter((r: any) => !keepB.has(r.id)).map((r: any) => r.id);
  if (delB.length) await supabase.from("phase_blueprints").delete().in("id", delB);
  if (blueprints.length)
    await supabase.from("phase_blueprints").upsert(blueprints.map((b) => ({
      id: b.id, name: b.name, project_type_id: b.projectTypeId || null, phases: b.phases,
    })));

  const { data: exR } = await supabase.from("client_roles").select("id");
  const keepR = new Set(roles.map((r) => r.id));
  const delR = (exR ?? []).filter((r: any) => !keepR.has(r.id)).map((r: any) => r.id);
  if (delR.length) await supabase.from("client_roles").delete().in("id", delR);
  if (roles.length)
    await supabase.from("client_roles").upsert(roles.map((r) => ({
      id: r.id, name: r.name, user_ids: r.userIds, is_supervision: r.isSupervision,
    })));
}