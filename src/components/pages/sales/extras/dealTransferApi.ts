/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../../api/supabase";
import type { Tracking } from "../sales/salesApi";
import { resolveDealRole, type SalesRole } from "./salesRolesApi";

/**
 * Transfers (Actions → Sales roles → Transfers): move someone's deals to a
 * colleague in one go — when they leave, change team or go on leave.
 * On every deal the new person takes their place: owner if they owned it,
 * on the team otherwise, with the sales role they play.
 */
export interface TransferOptions {
  from: string;
  to: string;
  /** "all" = every deal they're on · "owned" = only the ones they own */
  scope: "all" | "owned";
  /** "open" = active and on hold · "all" = won and lost too */
  which: "open" | "all";
  /** Keep the previous person on the deals (as a team member). */
  keepFrom: boolean;
  /** Leave a note on each deal saying who moved it. */
  note: boolean;
}
export interface TransferItem { t: Tracking; wasOwner: boolean; toAlreadyOn: boolean }

export const isOpen = (t: Pick<Tracking, "status">) => t.status !== "won" && t.status !== "lost";

/** Which deals would move. */
export function planTransfer(trackings: Tracking[], owners: Record<string, string>, teams: Record<string, string[]>, o: Pick<TransferOptions, "from" | "to" | "scope" | "which">): TransferItem[] {
  if (!o.from || !o.to || o.from === o.to) return [];
  return trackings
    .filter((t) => (o.which === "all" || isOpen(t)))
    .filter((t) => (o.scope === "owned" ? owners[t.id] === o.from : owners[t.id] === o.from || (teams[t.id] ?? []).includes(o.from)))
    .map((t) => ({ t, wasOwner: owners[t.id] === o.from, toAlreadyOn: owners[t.id] === o.to || (teams[t.id] ?? []).includes(o.to) }));
}

/** How many deals each person is on (open / all), to show next to their name. */
export function dealCounts(trackings: Tracking[], owners: Record<string, string>, teams: Record<string, string[]>) {
  const out: Record<string, { open: number; all: number; owned: number }> = {};
  trackings.forEach((t) => {
    const people = new Set([...(teams[t.id] ?? []), ...(owners[t.id] ? [owners[t.id]] : [])]);
    people.forEach((p) => {
      const c = (out[p] ??= { open: 0, all: 0, owned: 0 });
      c.all++; if (isOpen(t)) c.open++; if (owners[t.id] === p) c.owned++;
    });
  });
  return out;
}

/** Move the deals. Returns the ids that failed (with why). */
export async function runTransfer(items: TransferItem[], o: TransferOptions, ctx: { roles: SalesRole[]; names: { from: string; to: string; by: string } },
  onProgress: (done: number) => void): Promise<{ moved: number; failed: { id: string; reason: string }[] }> {
  const failed: { id: string; reason: string }[] = [];
  let moved = 0, done = 0, cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const it = items[cursor++];
      const id = it.t.id;
      try {
        const te = supabase.from("tracking_employees");
        // the owner flag first (only one owner at a time), then the people
        if (it.wasOwner) {
          const r = await supabase.from("tracking_employees").update({ is_owner: false }).eq("tracking_id", id).eq("profile_id", o.from);
          if (r.error) throw r.error;
        }
        if (!o.keepFrom) {
          const r = await supabase.from("tracking_employees").delete().eq("tracking_id", id).eq("profile_id", o.from);
          if (r.error) throw r.error;
        }
        if (it.toAlreadyOn) {
          if (it.wasOwner) {
            const r = await supabase.from("tracking_employees").update({ is_owner: true }).eq("tracking_id", id).eq("profile_id", o.to);
            if (r.error) throw r.error;
          }
        } else {
          const r = await te.insert({ tracking_id: id, profile_id: o.to, is_owner: it.wasOwner });
          if (r.error) throw r.error;
        }
        // the sales role they played on this deal goes with them (when the new person has it, or only one that fits)
        const roles = it.t.deal_roles ?? {};
        if (roles[o.from] || !o.keepFrom) {
          const next: Record<string, string> = { ...roles };
          const role = resolveDealRole(ctx.roles, o.to, it.t.pipeline_id, roles[o.from] ?? roles[o.to]);
          if (role) next[o.to] = role.id;
          if (!o.keepFrom) delete next[o.from];
          if (JSON.stringify(next) !== JSON.stringify(roles)) await supabase.from("trackings").update({ deal_roles: next }).eq("id", id);
        }
        if (o.note) {
          await supabase.from("tracking_notes").insert({
            tracking_id: id, phase_id: it.t.current_phase_id,
            body: `Transferred from ${ctx.names.from} to ${ctx.names.to}${it.wasOwner ? " (owner)" : ""} by ${ctx.names.by}.`,
          });
        }
        moved++;
      } catch (e: any) {
        failed.push({ id, reason: e?.message ?? "Failed" });
      } finally {
        onProgress(++done);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length || 1) }, worker));
  return { moved, failed };
}