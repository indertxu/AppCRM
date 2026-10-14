/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Sales access: who can do and see what in Sales.
 *
 * Settings live in rules, one per subject:
 *   Person  ›  Sales role  ›  Job role  ›  Everyone  ›  built-in default
 * The first level that sets something wins. When someone is in several sales
 * roles, the most generous of those roles counts. The boss (and superadmins)
 * always have everything — nobody can lock them out.
 *
 * Which pipelines a sales role sees, and up to which phase, is the role's own
 * scope (sales_roles.scopes) — the same thing the Roles tab edits, so there is
 * one source of truth and handovers keep working.
 */
import { supabase } from "../../../api/supabase";
import type { Phase, Pipeline } from "../../settings/pipelineApi";
import type { Tracking } from "../sales/salesApi";
import { dealPhaseIndex, orderPhases, type Access, type DealScope, type SalesRole, type TrackingHandover } from "./salesRolesApi";

export type CreateLevel = "none" | "self" | "team" | "anyone";
export type ExportLevel = "none" | "visible" | "all";
export type ViewKey = "list" | "board" | "forecast";
export interface PipeRule { access: boolean; max_phase_id: string | null }
export interface AccessSettings {
  scope?: DealScope;
  pipelines?: Record<string, PipeRule>;
  views?: Partial<Record<ViewKey, boolean>>;
  create?: CreateLevel;
  reports?: boolean;
  export?: ExportLevel;
  import?: boolean;
  fields?: boolean;
  manage?: boolean;
}
export type SubjectType = "everyone" | "job" | "sales_role" | "user";
export interface AccessRule { subject_type: SubjectType; subject_id: string; settings: AccessSettings }
export const ruleKey = (t: SubjectType, id: string) => `${t}:${id}`;
export type RuleMap = Record<string, AccessSettings>;

export interface AccessPerson { id: string; name: string; role?: string | null; is_superadmin?: boolean }

/* ─────────────── labels ─────────────── */
export const CREATE_LABEL: Record<CreateLevel, string> = { none: "No", self: "Only for themselves", team: "With their team", anyone: "For anyone" };
export const CREATE_HINT: Record<CreateLevel, string> = {
  none: "Can't start deals",
  self: "They're the owner; can't add others",
  team: "They're on it; can add people and pick the owner",
  anyone: "Can start deals for others, without themselves",
};
export const EXPORT_LABEL: Record<ExportLevel, string> = { none: "No", visible: "What they can see", all: "Everything" };
export const VIEW_LABEL: Record<ViewKey, string> = { list: "List", board: "Board", forecast: "Forecast" };
export const jobLabel = (r?: string | null) => (r ? r.split("_").map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ") : "No job role");

/* ─────────────── data ─────────────── */

/**
 * The rules. `legacy` per-person scopes (the older sales_visibility table) are
 * folded in where a person has no scope of their own yet.
 */
export async function loadAccessRules(): Promise<{ rules: RuleMap; missing: boolean }> {
  const out: RuleMap = {};
  // Both tables at once (one round trip instead of two).
  const [{ data, error }, legacy] = await Promise.all([
    supabase.from("sales_access_rules").select("subject_type, subject_id, settings"),
    supabase.from("sales_visibility").select("profile_id, scope"),
  ]);
  (data ?? []).forEach((r: any) => { out[ruleKey(r.subject_type, String(r.subject_id))] = (r.settings ?? {}) as AccessSettings; });
  ((legacy as any).data ?? []).forEach((r: any) => {
    if (r.scope !== "all" && r.scope !== "own") return;
    const k = ruleKey("user", r.profile_id);
    if (!out[k]?.scope) out[k] = { ...(out[k] ?? {}), scope: r.scope };
  });
  return { rules: out, missing: !!error };
}

const clean = (s: AccessSettings): AccessSettings => {
  const o: any = {};
  Object.entries(s).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (typeof v === "object" && !Object.keys(v).length) return;
    o[k] = v;
  });
  return o;
};
export const isEmptySettings = (s: AccessSettings | undefined) => !s || !Object.keys(clean(s)).length;

/** Save the rules that changed (empty ones are removed). */
export async function saveAccessRules(next: RuleMap, prev: RuleMap): Promise<string | null> {
  const keys = new Set([...Object.keys(next), ...Object.keys(prev)]);
  for (const k of keys) {
    const a = clean(next[k] ?? {}), b = clean(prev[k] ?? {});
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const [subject_type, ...rest] = k.split(":");
    const subject_id = rest.join(":");
    if (!Object.keys(a).length) {
      const { error } = await supabase.from("sales_access_rules").delete().eq("subject_type", subject_type).eq("subject_id", subject_id);
      if (error) return error.message;
      if (subject_type === "user") await supabase.from("sales_visibility").delete().eq("profile_id", subject_id);
    } else {
      const { error } = await supabase.from("sales_access_rules")
        .upsert({ subject_type, subject_id, settings: a, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,subject_type,subject_id" });
      if (error) return error.message;
      if (subject_type === "user" && !a.scope) await supabase.from("sales_visibility").delete().eq("profile_id", subject_id);
    }
  }
  return null;
}

/* ─────────────── resolving ─────────────── */

export type SourceKind = "boss" | "user" | "sales_role" | "job" | "everyone" | "default";
export interface Source { kind: SourceKind; label: string }
export interface Eff<T> { value: T; source: Source }
export interface EffPipe { access: boolean; maxPhaseId: string | null; viaSalesRoles: boolean; source: Source }
export interface EffectivePerms {
  locked: boolean;
  scope: Eff<DealScope>;
  pipelines: Record<string, EffPipe>;
  views: Record<ViewKey, Eff<boolean>>;
  create: Eff<CreateLevel>;
  reports: Eff<boolean>;
  export: Eff<ExportLevel>;
  import: Eff<boolean>;
  fields: Eff<boolean>;
  manage: Eff<boolean>;
  /** Can open Sales at all (at least one view). */
  canOpen: boolean;
}

const LEADS = new Set(["boss", "sales_manager"]);
const CONFIG = new Set(["boss", "sales_manager", "marketing_manager"]);
/** Job roles that use Sales out of the box (anyone else needs a sales role or a setting). */
export const isSalesyJob = (r?: string | null) => { const x = (r ?? "").toLowerCase(); return x === "boss" || x === "marketing_manager" || x.includes("sales"); };
export const isLockedPerson = (p: Pick<AccessPerson, "role" | "is_superadmin">) => !!p.is_superadmin || (p.role ?? "").toLowerCase() === "boss";

/** Built-in behaviour when nothing is set anywhere (how Sales worked before these settings). */
export function builtInDefault(job: string | null | undefined, inSalesRole: boolean): Required<Omit<AccessSettings, "pipelines">> {
  const j = (job ?? "").toLowerCase();
  const lead = LEADS.has(j), salesy = isSalesyJob(j) || inSalesRole, config = CONFIG.has(j);
  return {
    scope: lead || inSalesRole ? "all" : "own",
    views: { list: salesy, board: salesy, forecast: salesy },
    create: lead ? "anyone" : salesy ? "team" : "none",
    reports: salesy,
    export: lead ? "all" : salesy ? "visible" : "none",
    import: config, fields: config, manage: config,
  };
}

const RANK: Record<string, Record<string, number>> = {
  scope: { own: 0, all: 1 },
  create: { none: 0, self: 1, team: 2, anyone: 3 },
  export: { none: 0, visible: 1, all: 2 },
};
const more = (key: string, a: any, b: any) => {
  if (typeof a === "boolean") return a || b;
  const r = RANK[key];
  return r && r[b] > r[a] ? b : a;
};

/**
 * One person's effective access, with where each value comes from.
 * `rules` are the saved (or draft) rules; `roles` the sales roles (their scopes
 * give the pipelines of their members).
 */
export function resolvePerms(person: AccessPerson, ctx: { rules: RuleMap; roles: SalesRole[]; pipelines: Pipeline[]; phaseByPipe: Record<string, Phase[]> }): EffectivePerms {
  const job = (person.role ?? "").toLowerCase();
  const myRoles = ctx.roles.filter((r) => r.members.includes(person.id)).sort((a, b) => a.sort - b.sort);
  const def = builtInDefault(job, myRoles.length > 0);
  const locked = isLockedPerson(person);
  const BOSS: Source = { kind: "boss", label: person.is_superadmin ? "Superadmin" : "Boss" };
  const u = ctx.rules[ruleKey("user", person.id)];
  const roleRules = myRoles.map((r) => ({ r, s: ctx.rules[ruleKey("sales_role", r.id)] })).filter((x) => !!x.s);
  const j = job ? ctx.rules[ruleKey("job", job)] : undefined;
  const e = ctx.rules[ruleKey("everyone", "*")];

  /** First level that sets `get`, the sales-role level merged most-generously. */
  const pick = <T,>(key: string, get: (s: AccessSettings) => T | undefined, fallback: T): Eff<T> => {
    if (u) { const v = get(u); if (v !== undefined) return { value: v, source: { kind: "user", label: "This person" } }; }
    let best: T | undefined; let src: Source | null = null;
    roleRules.forEach(({ r, s }) => {
      const v = get(s!);
      if (v === undefined) return;
      if (best === undefined) { best = v; src = { kind: "sales_role", label: r.name }; }
      else { const m = more(key, best, v); if (m !== best) { best = m; src = { kind: "sales_role", label: r.name }; } }
    });
    if (best !== undefined && src) return { value: best, source: src };
    if (j) { const v = get(j); if (v !== undefined) return { value: v, source: { kind: "job", label: jobLabel(job) } }; }
    if (e) { const v = get(e); if (v !== undefined) return { value: v, source: { kind: "everyone", label: "Everyone" } }; }
    return { value: fallback, source: { kind: "default", label: "Default" } };
  };

  const all = <T,>(v: T): Eff<T> => ({ value: v, source: BOSS });
  if (locked) {
    const pipes: Record<string, EffPipe> = {};
    ctx.pipelines.forEach((p) => { pipes[p.id] = { access: true, maxPhaseId: null, viaSalesRoles: false, source: BOSS }; });
    return {
      locked: true, scope: all("all" as DealScope), pipelines: pipes,
      views: { list: all(true), board: all(true), forecast: all(true) },
      create: all("anyone" as CreateLevel), reports: all(true), export: all("all" as ExportLevel), import: all(true), fields: all(true), manage: all(true), canOpen: true,
    };
  }

  const scope = pick<DealScope>("scope", (s) => s.scope, def.scope);
  const views = {
    list: pick<boolean>("views", (s) => s.views?.list, !!def.views.list),
    board: pick<boolean>("views", (s) => s.views?.board, !!def.views.board),
    forecast: pick<boolean>("views", (s) => s.views?.forecast, !!def.views.forecast),
  };

  // pipelines: person › their sales roles' scopes › job role › everyone › all of it
  const pipelines: Record<string, EffPipe> = {};
  ctx.pipelines.forEach((p) => {
    const ord = orderPhases(ctx.phaseByPipe[p.id] ?? []).filter((x) => !x.sales_outcome);
    const ur = u?.pipelines?.[p.id];
    if (ur) { pipelines[p.id] = { access: ur.access, maxPhaseId: ur.max_phase_id, viaSalesRoles: false, source: { kind: "user", label: "This person" } }; return; }
    if (myRoles.length) {
      let best: { idx: number; id: string | null; role: string } | null = null;
      myRoles.forEach((r) => r.scopes.filter((s) => s.pipeline_id === p.id).forEach((s) => {
        const idx = s.max_phase_id ? ord.findIndex((x) => x.id === s.max_phase_id) : Infinity;
        const i = idx < 0 ? Infinity : idx;
        if (!best || i > best.idx) best = { idx: i, id: i === Infinity ? null : s.max_phase_id, role: r.name };
      }));
      const b = best as { idx: number; id: string | null; role: string } | null;
      pipelines[p.id] = b
        ? { access: true, maxPhaseId: b.id, viaSalesRoles: true, source: { kind: "sales_role", label: b.role } }
        : { access: false, maxPhaseId: null, viaSalesRoles: true, source: { kind: "sales_role", label: myRoles.length === 1 ? myRoles[0].name : "Their sales roles" } };
      return;
    }
    const jr = j?.pipelines?.[p.id];
    if (jr) { pipelines[p.id] = { access: jr.access, maxPhaseId: jr.max_phase_id, viaSalesRoles: false, source: { kind: "job", label: jobLabel(job) } }; return; }
    const er = e?.pipelines?.[p.id];
    if (er) { pipelines[p.id] = { access: er.access, maxPhaseId: er.max_phase_id, viaSalesRoles: false, source: { kind: "everyone", label: "Everyone" } }; return; }
    pipelines[p.id] = { access: true, maxPhaseId: null, viaSalesRoles: false, source: { kind: "default", label: "Default" } };
  });

  const canOpen = views.list.value || views.board.value || views.forecast.value;
  return {
    locked: false, scope, pipelines, views,
    create: pick<CreateLevel>("create", (s) => s.create, def.create),
    reports: pick<boolean>("reports", (s) => s.reports, def.reports),
    export: pick<ExportLevel>("export", (s) => s.export, def.export),
    import: pick<boolean>("import", (s) => s.import, def.import),
    fields: pick<boolean>("fields", (s) => s.fields, def.fields),
    manage: pick<boolean>("manage", (s) => s.manage, def.manage),
    canOpen,
  };
}

/**
 * The deals a person may see, from their effective access. Same contract as
 * buildAccess (restricted / pipelines / view), so the page doesn't change.
 */
export function accessFromPerms(opts: {
  me: string | null; perms: EffectivePerms; roles: SalesRole[]; phaseByPipe: Record<string, Phase[]>;
  events: Record<string, string[]>; handovers: TrackingHandover[]; onDeal: (t: Tracking) => boolean;
}): Access {
  const { me, perms, roles, phaseByPipe, events, handovers, onDeal } = opts;
  const myRoles = me ? roles.filter((r) => r.members.includes(me)) : [];
  const pipes = Object.entries(perms.pipelines);
  const fullPipes = pipes.every(([, p]) => p.access && !p.maxPhaseId);
  if (perms.locked || (perms.scope.value === "all" && fullPipes)) return { restricted: false, myRoles, pipelines: null, view: () => ({ mode: "full" }) };
  const lastHandoverFor = new Map<string, TrackingHandover>();
  handovers.forEach((h) => { if (me && h.from_ids.includes(me)) lastHandoverFor.set(h.tracking_id, h); });
  const idxOf = (pid: string, phaseId: string | null) => {
    if (!phaseId) return Infinity;
    const i = orderPhases(phaseByPipe[pid] ?? []).findIndex((p) => p.id === phaseId);
    return i < 0 ? Infinity : i;
  };
  return {
    restricted: true, myRoles,
    pipelines: fullPipes ? null : new Set(pipes.filter(([, p]) => p.access).map(([id]) => id)),
    view: (t) => {
      const ep = t.pipeline_id ? perms.pipelines[t.pipeline_id] : undefined;
      let inReach = true;
      if (ep) {
        if (!ep.access) inReach = false;
        else {
          let lim = idxOf(t.pipeline_id!, ep.maxPhaseId);
          // on a deal where they play one specific sales role, that role's reach applies
          if (ep.viaSalesRoles && me && onDeal(t)) {
            const rid = t.deal_roles?.[me];
            const role = rid ? myRoles.find((r) => r.id === rid) : undefined;
            const sc = role?.scopes.find((s) => s.pipeline_id === t.pipeline_id);
            if (sc) lim = idxOf(t.pipeline_id!, sc.max_phase_id);
          }
          if (lim !== Infinity) {
            const raw = phaseByPipe[t.pipeline_id!];
            if (!raw) inReach = false; // phases not loaded yet: show nothing rather than too much
            else { const ord = orderPhases(raw); inReach = !ord.length || dealPhaseIndex(t, ord, events[t.id]) <= lim; }
          }
        }
      }
      if (inReach && (perms.scope.value === "all" || onDeal(t))) return { mode: "full" };
      const h = lastHandoverFor.get(t.id);
      return h ? { mode: "frozen", handover: h } : null;
    },
  };
}