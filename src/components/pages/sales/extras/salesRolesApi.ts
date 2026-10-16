/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../../api/supabase";
import type { Phase } from "../../settings/pipelineApi";
import { setTrackingOwner, allRows, type Tracking } from "../sales/salesApi";

/**
 * Sales roles decide who sees which deals.
 *
 *  - A role has people, and for each pipeline it can see, the LAST phase it
 *    sees (null = every phase). A deal past that phase disappears for the role.
 *  - Optionally, per pipeline, who takes the deal over when it moves past that
 *    phase (handover_to). The move asks for a double confirmation, the new
 *    person becomes owner, and the people who lose it stay on the deal but only
 *    see it as it was at that moment (a snapshot stored with the handover).
 *
 * On top of that, each person has a deal visibility (Sales roles → Who sees
 * what): "all" deals or only "own" (the deals they're on). The role still
 * decides how far: which pipelines and up to which phase.
 *
 * Defaults when nothing is set: bosses, sales managers and anyone with a role
 * see all deals (within the role); everyone else sees the deals they're on.
 * Roles never limit bosses and sales managers.
 */

export interface RoleScope { pipeline_id: string; max_phase_id: string | null; handover_to: string | null }
export interface SalesRole {
  id: string; name: string; color: string | null; members: string[]; scopes: RoleScope[]; sort: number;
}
export interface HandoverSnapshot {
  phase_id: string | null; status: string; total: number;
  rep_close_prob: number | null; mgr_close_prob: number | null;
  rep_close_date: string | null; mgr_close_date: string | null;
  custom: Record<string, any>;
}
export interface TrackingHandover {
  id: string; tracking_id: string; role_id: string | null; role_name: string | null;
  from_ids: string[]; to_profile: string | null; from_phase_id: string | null; to_phase_id: string | null;
  snapshot: HandoverSnapshot; created_at: string; created_by: string;
}

/** Which deals a person sees: every deal, or only the ones they're on. */
export type DealScope = "all" | "own";

export const ROLE_COLORS = ["#1fb98a", "#3c9ae0", "#e0a43c", "#8b6fd6", "#e0574b", "#2bb3c0", "#c46a9a", "#5b8f3e"];

export const roleFrom = (r: any): SalesRole => ({
  id: r.id, name: r.name ?? "", color: r.color ?? null, sort: r.sort ?? 0,
  members: Array.isArray(r.members) ? r.members : [],
  scopes: (Array.isArray(r.scopes) ? r.scopes : []).map((s: any) => ({
    pipeline_id: String(s.pipeline_id), max_phase_id: s.max_phase_id ?? null, handover_to: s.handover_to ?? null,
  })),
});

/* ─────────────── data ─────────────── */

export async function loadSalesRoles(): Promise<{ roles: SalesRole[]; missing: boolean }> {
  const { data, error } = await supabase.from("sales_roles").select("*").order("sort").order("created_at");
  if (error) return { roles: [], missing: true };
  return { roles: (data ?? []).map(roleFrom), missing: false };
}

export async function saveSalesRole(r: Omit<SalesRole, "id"> & { id?: string | null }): Promise<{ id: string | null; error: string | null }> {
  const row = { name: r.name.trim(), color: r.color, members: r.members, scopes: r.scopes, sort: r.sort, updated_at: new Date().toISOString() };
  const res = r.id
    ? await supabase.from("sales_roles").update(row).eq("id", r.id).select("id").single()
    : await supabase.from("sales_roles").insert(row).select("id").single();
  if (res.error) return { id: null, error: res.error.message };
  return { id: (res.data as any)?.id ?? r.id ?? null, error: null };
}

export async function deleteSalesRole(id: string): Promise<string | null> {
  const { error } = await supabase.from("sales_roles").delete().eq("id", id);
  return error?.message ?? null;
}

export async function loadHandovers(): Promise<TrackingHandover[]> {
  // Every page, the later ones in parallel (see allRows).
  const rows = await allRows(() => supabase.from("tracking_handovers").select("*").order("created_at").order("id"));
  return handoversFromRows(rows);
}
export const handoversFromRows = (rows: any[]): TrackingHandover[] =>
  rows.map((h) => ({ ...h, from_ids: h.from_ids ?? [], snapshot: h.snapshot ?? {} })) as TrackingHandover[];

/** Every phase each deal has entered (used to place won / lost deals). */
export async function loadAllPhaseEvents(): Promise<Record<string, string[]>> {
  // A fixed order, so parallel pages never skip or repeat a row (rows that tie are identical anyway).
  const rows = await allRows(() => supabase.from("tracking_phase_events").select("tracking_id, phase_id").order("tracking_id").order("phase_id"));
  return phaseEventsFromRows(rows);
}
export function phaseEventsFromRows(rows: any[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  rows.forEach((r: any) => { if (r.tracking_id && r.phase_id) (out[r.tracking_id] ??= []).push(r.phase_id); });
  return out;
}

/* ─────────────── who sees what ─────────────── */

/** Explicit per-person settings (profile id → scope). People not listed use the default. */
export async function loadVisibility(): Promise<{ map: Record<string, DealScope>; missing: boolean }> {
  const { data, error } = await supabase.from("sales_visibility").select("profile_id, scope");
  if (error) return { map: {}, missing: true };
  const map: Record<string, DealScope> = {};
  (data ?? []).forEach((r: any) => { if (r.scope === "all" || r.scope === "own") map[r.profile_id] = r.scope; });
  return { map, missing: false };
}

/** Set one person's scope; null goes back to the default. */
export async function saveVisibility(profileId: string, scope: DealScope | null): Promise<string | null> {
  if (scope === null) {
    const { error } = await supabase.from("sales_visibility").delete().eq("profile_id", profileId);
    return error?.message ?? null;
  }
  const { error } = await supabase.from("sales_visibility")
    .upsert({ profile_id: profileId, scope, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,profile_id" });
  return error?.message ?? null;
}

/** Bosses (and superadmins) always see every deal: nobody can lock them out. */
export const alwaysSeesAll = (p: { role?: string | null; is_superadmin?: boolean } | null | undefined) =>
  !!p && (!!p.is_superadmin || (p.role ?? "").toLowerCase() === "boss");

/** What a person sees when nobody has set it. */
export function defaultScope(opts: { lead: boolean; inRole: boolean }): DealScope {
  return opts.lead || opts.inRole ? "all" : "own";
}

/** The scope that applies to a person: their setting, or the default. */
export function effectiveScope(opts: { id: string; role?: string | null; is_superadmin?: boolean; lead: boolean; roles: SalesRole[]; visibility: Record<string, DealScope> }): DealScope {
  if (alwaysSeesAll(opts)) return "all";
  return opts.visibility[opts.id] ?? defaultScope({ lead: opts.lead, inRole: opts.roles.some((r) => r.members.includes(opts.id)) });
}

/* ─────────────── the role each person plays on a deal ─────────────── */

/**
 * A person's roles, and the ones that fit a pipeline (have it in their scopes).
 * With no pipeline yet, every role fits.
 */
export function rolesFor(roles: SalesRole[], personId: string, pipelineId?: string | null): { all: SalesRole[]; fit: SalesRole[] } {
  const all = [...roles].filter((r) => r.members.includes(personId)).sort((a, b) => a.sort - b.sort);
  const fit = pipelineId ? all.filter((r) => r.scopes.some((s) => s.pipeline_id === pipelineId)) : all;
  return { all, fit };
}

/** The role a person plays on a deal: the one chosen (if it still fits), else their only fitting role. */
export function resolveDealRole(roles: SalesRole[], personId: string, pipelineId: string | null | undefined, chosen?: string | null): SalesRole | null {
  const { fit } = rolesFor(roles, personId, pipelineId);
  return fit.find((r) => r.id === chosen) ?? (fit.length === 1 ? fit[0] : null);
}

/** Save which role each person plays on a deal. */
export async function saveDealRoles(trackingId: string, dealRoles: Record<string, string>): Promise<string | null> {
  const { error } = await supabase.from("trackings").update({ deal_roles: dealRoles }).eq("id", trackingId);
  return error?.message ?? null;
}

/* ─────────────── phases & access ─────────────── */

/** Sales-visible phases in display order: normal phases as configured, then Won, then Lost. */
export function orderPhases(phases: Phase[]): Phase[] {
  const rank = (p: Phase) => (p.sales_outcome === "loss" ? 2 : p.sales_outcome === "win" ? 1 : 0);
  return phases.filter((p) => p.sales_visible !== false).map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
}

/**
 * Where a deal is in its pipeline, as an index into orderPhases(). A won or
 * lost deal counts at the furthest normal phase it reached, so a lead lost
 * early stays with the team that was working it.
 */
export function dealPhaseIndex(t: Pick<Tracking, "current_phase_id">, ordered: Phase[], entered: string[] = []): number {
  const idx = ordered.findIndex((p) => p.id === t.current_phase_id);
  const cur = ordered[idx];
  if (idx >= 0 && !cur.sales_outcome) return idx;
  let best = -1;
  entered.forEach((id) => { const i = ordered.findIndex((p) => p.id === id && !p.sales_outcome); if (i > best) best = i; });
  return best >= 0 ? best : 0;
}

const maxIndex = (ordered: Phase[], maxPhaseId: string | null) => {
  if (!maxPhaseId) return Infinity;
  const i = ordered.findIndex((p) => p.id === maxPhaseId);
  return i < 0 ? Infinity : i;
};

export type DealView = { mode: "full" } | { mode: "frozen"; handover: TrackingHandover } | null;
export interface Access {
  /** True when roles decide what this person sees. */
  restricted: boolean;
  myRoles: SalesRole[];
  /** Pipelines this person may see (null = all). */
  pipelines: Set<string> | null;
  view: (t: Tracking) => DealView;
}

/**
 * What one person may see: their scope (all deals / only theirs) and, from
 * their roles, which pipelines and up to which phase.
 */
export function buildAccess(opts: {
  me: string | null; lead: boolean; roles: SalesRole[];
  phaseByPipe: Record<string, Phase[]>; events: Record<string, string[]>; handovers: TrackingHandover[];
  /** "all" or "own" (see effectiveScope). Defaults to the old rule. */
  scope?: DealScope;
  /** Is this person on the deal (owner or team)? */
  onDeal?: (t: Tracking) => boolean;
}): Access {
  const { me, lead, roles, phaseByPipe, events, handovers } = opts;
  const myRoles = me && !lead ? roles.filter((r) => r.members.includes(me)) : [];
  const scope: DealScope = opts.scope ?? defaultScope({ lead, inRole: myRoles.length > 0 });
  const onDeal = opts.onDeal ?? (() => false);
  const lastHandoverFor = new Map<string, TrackingHandover>();
  handovers.forEach((h) => { if (me && h.from_ids.includes(me)) lastHandoverFor.set(h.tracking_id, h); });
  if (!myRoles.length) {
    if (scope === "all") return { restricted: false, myRoles: [], pipelines: null, view: () => ({ mode: "full" }) };
    // Only their own deals, in every pipeline.
    return {
      restricted: true, myRoles: [], pipelines: null,
      view: (t) => (onDeal(t) ? { mode: "full" } : null),
    };
  }
  // widest reach across all my roles, per pipeline
  const reach = new Map<string, number>();
  myRoles.forEach((r) => r.scopes.forEach((s) => {
    const ord = orderPhases(phaseByPipe[s.pipeline_id] ?? []);
    reach.set(s.pipeline_id, Math.max(reach.get(s.pipeline_id) ?? -1, maxIndex(ord, s.max_phase_id)));
  }));
  // On a deal where I play one specific role, that role's reach applies there.
  const limitOn = (t: Tracking): number | undefined => {
    if (!t.pipeline_id) return undefined;
    const rid = me ? t.deal_roles?.[me] : undefined;
    const role = rid ? myRoles.find((r) => r.id === rid) : undefined;
    const sc = role?.scopes.find((s) => s.pipeline_id === t.pipeline_id);
    if (sc && onDeal(t)) return maxIndex(orderPhases(phaseByPipe[t.pipeline_id] ?? []), sc.max_phase_id);
    return reach.get(t.pipeline_id);
  };
  return {
    restricted: true, myRoles, pipelines: new Set(reach.keys()),
    view: (t) => {
      const lim = limitOn(t);
      const raw = t.pipeline_id ? phaseByPipe[t.pipeline_id] : undefined;
      // (phases not loaded yet: show nothing rather than too much)
      if (lim != null && raw) {
        const ord = orderPhases(raw);
        if (!ord.length || dealPhaseIndex(t, ord, events[t.id]) <= lim) return scope === "all" || onDeal(t) ? { mode: "full" } : null;
      }
      const h = lastHandoverFor.get(t.id);
      return h ? { mode: "frozen", handover: h } : null;
    },
  };
}

/** The deal exactly as the people who handed it over last saw it. */
export function frozenCopy(t: Tracking, h: TrackingHandover): Tracking {
  const s = h.snapshot ?? ({} as HandoverSnapshot);
  return {
    ...t,
    current_phase_id: s.phase_id ?? t.current_phase_id, status: s.status ?? t.status,
    rep_close_prob: s.rep_close_prob ?? null, mgr_close_prob: s.mgr_close_prob ?? null,
    rep_close_date: s.rep_close_date ?? null, mgr_close_date: s.mgr_close_date ?? null,
    custom: s.custom ?? {},
  };
}

/* ─────────────── handover ─────────────── */

export interface HandoverPlan {
  role: SalesRole; scope: RoleScope; toProfile: string; fromIds: string[];
  fromPhase: Phase | null; toPhase: Phase; lastPhase: Phase | null;
}

/**
 * Does moving this deal from one phase to another hand it over? It does when
 * the move goes past the last phase a role sees, the role names someone to take
 * over in that pipeline, and the deal's owner (or, with no owner, someone on
 * the deal) is in that role. Moves to Won / Lost never hand over.
 */
export function planHandover(opts: {
  roles: SalesRole[]; pipelineId: string | null; phases: Phase[];
  fromPhaseId: string | null; toPhaseId: string; owner: string | null; team: string[];
  /** The role each person plays on this deal: someone playing another role doesn't count for this one. */
  dealRoles?: Record<string, string> | null;
}): HandoverPlan | null {
  const { roles, pipelineId, fromPhaseId, toPhaseId, owner, team } = opts;
  const dealRoles = opts.dealRoles ?? {};
  const plays = (id: string, role: SalesRole) => {
    if (!role.members.includes(id)) return false;
    const chosen = dealRoles[id];
    const stillValid = !!chosen && roles.some((r) => r.id === chosen && r.members.includes(id));
    return !stillValid || chosen === role.id;
  };
  if (!pipelineId) return null;
  const ord = orderPhases(opts.phases);
  const toIdx = ord.findIndex((p) => p.id === toPhaseId);
  const fromIdx = Math.max(0, ord.findIndex((p) => p.id === fromPhaseId));
  const toPhase = ord[toIdx];
  if (toIdx < 0 || !toPhase || toPhase.sales_outcome || toIdx <= fromIdx) return null;
  const holders = owner ? [owner] : team;
  for (const role of [...roles].sort((a, b) => a.sort - b.sort)) {
    const scope = role.scopes.find((s) => s.pipeline_id === pipelineId);
    if (!scope?.max_phase_id || !scope.handover_to) continue;
    const lim = maxIndex(ord, scope.max_phase_id);
    if (!(fromIdx <= lim && lim < toIdx)) continue;
    if (!holders.some((id) => plays(id, role))) continue;
    if (owner === scope.handover_to) continue;
    const fromIds = Array.from(new Set([...(owner ? [owner] : []), ...team].filter((id) => plays(id, role) && id !== scope.handover_to)));
    return { role, scope, toProfile: scope.handover_to, fromIds, fromPhase: ord[fromIdx] ?? null, toPhase, lastPhase: ord[lim] ?? null };
  }
  return null;
}

/** Make the new person the owner and keep the record (with the snapshot). */
export async function performHandover(trackingId: string, plan: HandoverPlan, snapshot: HandoverSnapshot): Promise<string | null> {
  await setTrackingOwner(trackingId, plan.toProfile);
  const { error } = await supabase.from("tracking_handovers").insert({
    tracking_id: trackingId, role_id: plan.role.id, role_name: plan.role.name,
    from_ids: plan.fromIds, to_profile: plan.toProfile,
    from_phase_id: plan.fromPhase?.id ?? null, to_phase_id: plan.toPhase.id, snapshot,
  });
  return error?.message ?? null;
}