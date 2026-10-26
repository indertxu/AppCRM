/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Management access — which panels of Management each person gets.
 *
 * Set in Settings → Organization → Page access (card "Management"), or from
 * Management → ⚙ → Security. Stored with the rest of page access
 * (page_access_rules, keys "management.<area>") and resolved the same way:
 *   Person › Security role › Department › Everyone › built-in default
 * Boss / superadmin always get everything.
 *
 * The API is the same as before, so ManagementPage doesn't change.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../api/supabase";
import { defaultPanelLevel, useDataScope, usePageAccess, type DataScope } from "../../framework/pageAccess";

export type Level = "none" | "own" | "all";
export type Area =
  | "team" | "backlog" | "billing" | "bonus"
  | "incoming" | "department" | "saved_days" | "settings" | "security";

export interface AreaDef {
  key: Area;
  label: string;
  hint: string;
  /** Levels that make sense for this area (binary areas have no "own"). */
  levels: Level[];
  group: "tab" | "tool";
}

export const AREAS: AreaDef[] = [
  { key: "team", label: "Team", hint: "Consultant cards, KPIs, connectors", levels: ["none", "own", "all"], group: "tab" },
  { key: "backlog", label: "Backlog", hint: "Remaining sold days per project", levels: ["none", "own", "all"], group: "tab" },
  { key: "billing", label: "Billing", hint: "Bills and invoices per project", levels: ["none", "own", "all"], group: "tab" },
  { key: "bonus", label: "Bonus", hint: "Bonus per consultant", levels: ["none", "own", "all"], group: "tab" },
  { key: "incoming", label: "Incoming", hint: "Handoffs from sales", levels: ["none", "all"], group: "tab" },
  { key: "department", label: "Department", hint: "The department's folders, files, links and notes", levels: ["none", "all"], group: "tab" },
  { key: "saved_days", label: "Saved days bank", hint: "Days banked from billing trims", levels: ["none", "own", "all"], group: "tool" },
  { key: "settings", label: "Targets & settings", hint: "The gear: targets, capacity, bonus rules", levels: ["none", "all"], group: "tool" },
  { key: "security", label: "Security", hint: "Edit these access rules", levels: ["none", "all"], group: "tool" },
];
export const AREA_KEYS = AREAS.map((a) => a.key);
export const areaDef = (k: Area) => AREAS.find((a) => a.key === k)!;

export const LEVEL_LABEL: Record<Level, string> = { none: "No access", own: "Only own", all: "Everyone" };
export const LEVEL_SHORT: Record<Level, string> = { none: "None", own: "Own", all: "All" };

export const KNOWN_ROLES = [
  "boss", "consultancy_manager", "sales_manager", "customer_success",
  "it_manager", "marketing_manager", "hr_manager", "sales", "consultant",
];
export const roleLabel = (r: string) =>
  r ? r.split("_").map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ") : "No role";

/** Roles that can never be restricted (protects against locking everyone out). */
export const isAdminRole = (role: string | null | undefined, isSuper: boolean) =>
  isSuper || (role ?? "").toLowerCase() === "boss";

/** Built-in behaviour when no rule exists — matches how the page worked before. */
export function defaultLevel(area: Area, role: string): Level {
  return defaultPanelLevel(`management.${area}`, role);
}

/** Older rule shape (table mgmt_access) — kept for anything that still imports it. */
export interface Rule {
  id?: string;
  subject_type: "role" | "user";
  subject_id: string;
  area: Area;
  level: Level;
}

/** Clamp a level to what the area supports ("own" on a binary area -> "all"). */
export const clampLevel = (area: Area, l: Level): Level =>
  areaDef(area).levels.includes(l) ? l : l === "own" ? "all" : l;

/** Older resolver (person › role › default) — the app now uses Page access. */
export function resolveLevel(
  area: Area, userId: string | null, role: string, isSuper: boolean, rules: Rule[],
): { level: Level; source: "admin" | "user" | "role" | "default" } {
  if (isAdminRole(role, isSuper)) return { level: "all", source: "admin" };
  const u = userId ? rules.find((x) => x.subject_type === "user" && x.subject_id === userId && x.area === area) : undefined;
  if (u) return { level: clampLevel(area, u.level), source: "user" };
  const r = rules.find((x) => x.subject_type === "role" && x.subject_id === (role ?? "").toLowerCase() && x.area === area);
  if (r) return { level: clampLevel(area, r.level), source: "role" };
  return { level: clampLevel(area, defaultLevel(area, role)), source: "default" };
}

/** Older rules table, read-only. */
export async function loadRules(): Promise<Rule[]> {
  const { data, error } = await supabase.from("mgmt_access").select("id, subject_type, subject_id, area, level").range(0, 99999);
  if (error) return [];
  return (data ?? []) as Rule[];
}

/** Panels that can be hidden from Settings › Management › Security. */
export const HIDEABLE: Area[] = ["team", "backlog", "billing", "bonus", "incoming", "department", "saved_days", "settings"];

/**
 * Current user's access across every Management area.
 * Three layers, the strictest wins:
 *   1. the panel level from Page access (none / own / all),
 *   2. panels hidden in Settings › Management › Security,
 *   3. the data scope there ("Only their own" / "Their department").
 * `team` = the people whose figures this person may see (null = everyone).
 */
export function useMgmtAccess() {
  const pa = usePageAccess();
  const ds = useDataScope("management");
  const scope: DataScope = ds.ready ? ds.scope : "all";
  const [deptIds, setDeptIds] = useState<string[] | null>(null);
  useEffect(() => {
    if (scope !== "department" || !pa.department) { setDeptIds(null); return; }
    let alive = true;
    supabase.from("profiles").select("id").eq("department", pa.department).range(0, 9999)
      .then(({ data }) => { if (alive) setDeptIds(((data ?? []) as any[]).map((r) => String(r.id))); });
    return () => { alive = false; };
  }, [scope, pa.department]);

  const limited = scope === "mine" || scope === "department";
  const team = useMemo<string[] | null>(() => {
    if (!limited) return null;
    const me = pa.userId ? [pa.userId] : [];
    if (scope === "department" && pa.department) return Array.from(new Set([...me, ...(deptIds ?? [])]));
    return me;
  }, [limited, scope, pa.userId, pa.department, deptIds]);

  const level = useCallback(
    (area: Area): Level => {
      if (!pa.ready || !ds.ready) return "none";
      let l = clampLevel(area, pa.panel(`management.${area}`));
      if (l !== "none" && HIDEABLE.includes(area) && ds.hidden(area)) l = "none";
      if (l === "all" && limited && areaDef(area).levels.includes("own")) l = "own";
      // the gear (targets, capacity, bonus rules) is team-wide: not for someone limited to their own figures
      if (limited && area === "settings") l = "none";
      return l;
    },
    [pa, ds, limited],
  );
  const deptWaiting = scope === "department" && !!pa.department && deptIds === null;
  return useMemo(() => ({
    ready: pa.ready && ds.ready && !deptWaiting,
    userId: pa.userId,
    role: pa.level ?? "",
    isSuper: pa.isSuper,
    rules: [] as Rule[],
    level,
    /** "mine" | "department" | "all" — what an "own" panel is limited to. */
    scope,
    /** People whose figures an "own" panel shows (just me unless scoped to the department). */
    team: team ?? (pa.userId ? [pa.userId] : []),
    /** Whether a person's figures are visible in a panel at this level. */
    sees: (lv: Level, uid: string) => lv === "all" || (team ?? (pa.userId ? [pa.userId] : [])).includes(uid),
    isAdmin: isAdminRole(pa.level, pa.isSuper),
    reload: pa.reload,
  }), [pa, ds.ready, deptWaiting, level, scope, team]);
}
