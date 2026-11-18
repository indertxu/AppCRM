/* =====================================================================
   Marketing › Workflows › "Joins a list" with a DYNAMIC list (154_mk_workflow_dynamic_lists.sql).
   A dynamic list is rules, worked out in the app (ContactExport.tsx, MkEngine): every 15
   minutes one browser of the company (mk_dyn_lease) reads the dynamic lists that start an
   active workflow and hands who's in each one to mk_sync_dynamic_list — the database starts
   the workflows for everyone who just came in (and again for someone who comes back).
   Run from AppLayout (people who see the whole CRM), and right away when a workflow with a
   dynamic list is switched on or a dynamic list is saved.
   ===================================================================== */
import { supabase } from "../../api/supabase";

let running: Promise<SyncResult | null> | null = null;
export interface SyncResult { lists: number; cameIn: number; started: number }

/** force: no 15-minute wait (switching a workflow on, saving a list) · listId: only that list */
export function syncDynamicLists(opts: { force?: boolean; listId?: string | null } = {}): Promise<SyncResult | null> {
  if (running) return opts.force ? running.then(() => syncDynamicLists(opts)) : running;
  running = (async () => {
    try {
      const { data: wfs, error } = await supabase.from("mk_workflows").select("trigger").eq("status", "active");
      if (error) return null;
      let ids = [...new Set(((wfs ?? []) as any[]).map((w) => w?.trigger).filter((t) => t?.kind === "list" && t.list_id).map((t) => String(t.list_id)))];
      if (opts.listId) ids = ids.filter((x) => x === opts.listId);
      if (!ids.length) return null;
      const { data: lists } = await supabase.from("marketing_lists").select("id, entity, kind, definition").in("id", ids).eq("kind", "dynamic");
      if (!lists?.length) return null;
      if (!opts.force) {
        const { data: ok, error: le } = await supabase.rpc("mk_dyn_lease", { p_minutes: 15 });
        if (le || ok !== true) return null;
      }
      const { mkDynamicListPeople } = await import("./ContactExport");
      const people = await mkDynamicListPeople(lists as any[]);
      if (!people) return null;
      const res: SyncResult = { lists: 0, cameIn: 0, started: 0 };
      for (const l of lists as any[]) {
        const { data, error: e2 } = await supabase.rpc("mk_sync_dynamic_list", { p_list: l.id, p_contacts: people.get(l.id) ?? [] });
        if (e2 || (data as any)?.error) continue;
        res.lists++; res.cameIn += Number((data as any)?.came_in) || 0; res.started += Number((data as any)?.started) || 0;
      }
      return res;
    } catch {
      return null;
    } finally {
      window.setTimeout(() => { running = null; }, 0);
    }
  })();
  return running;
}
