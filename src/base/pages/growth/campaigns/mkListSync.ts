/* =====================================================================
   Marketing › Workflows › "Joins a list" with a DYNAMIC list.
   Dynamic lists are worked out on the server (155_mk_list_engine.sql: the list engine in SQL):
   every 5 minutes pg_cron reads each dynamic list that starts an active workflow and starts it
   for whoever came in. The app only asks for one list right away — when a workflow with a
   dynamic list is switched on, or such a list is saved — so nobody waits for the next round.
   ===================================================================== */
import { supabase } from "../../../../components/api/supabase";

export interface SyncResult { lists: number; cameIn: number; started: number }

/** listId: that list now (only if an active workflow starts with it) · without: nothing (the server does it every 5 minutes) */
export async function syncDynamicLists(opts: { force?: boolean; listId?: string | null } = {}): Promise<SyncResult | null> {
  if (!opts.listId) return null;
  try {
    const { data, error } = await supabase.rpc("mk_dyn_sync_now", { p_list: opts.listId });
    if (error || (data as any)?.error || (data as any)?.skipped) return null;
    return { lists: 1, cameIn: Number((data as any)?.came_in) || 0, started: Number((data as any)?.started) || 0 };
  } catch {
    return null;
  }
}

/** The app's own result for a saved dynamic list, checked against the server's (differences kept in mk_list_parity). */
export function checkListOnServer(listId: string, ids: string[]): void {
  void Promise.resolve(supabase.rpc("mk_list_check", { p_list: listId, p_app: ids })).then(({ data }: any) => {
    if (data && (Number(data.only_app) || Number(data.only_server))) {
      console.warn("[lists] the server works this list out differently", listId, data);
    }
  }).catch(() => {});
}
