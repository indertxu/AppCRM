/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Page access: which pages of the side menu each person can open, and which
 * panels inside Settings and Management they get.
 *
 * Rules are set per subject (Settings → Organization → Page access):
 *   Person  ›  Security role  ›  Department  ›  Everyone  ›  built-in default
 * The first level that says something about a page or panel wins. Bosses and
 * superadmins always get everything; Home and Settings always open, and so do
 * the personal panels in Settings (Interface, Your account), so nobody can
 * lock themselves out.
 *
 * The signed-in user's result is computed by the database (my_pages()), so it
 * can't drift from what's stored; if that function isn't installed yet, the
 * same rules are resolved here from the tables.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { supabase } from "../api/supabase";
import SuperAdminBubble, { getRolePreview } from "./SuperAdmin";

export type PageKey =
  | "home" | "calendar" | "contacts" | "companies" | "clients"
  | "projects" | "sales" | "management" | "settings";

export interface PageDef {
  key: PageKey;
  path: string;
  label: string;
  hint: string;
  /** Always open to everyone — can't be switched off (avoids lock-outs). */
  locked?: boolean;
  /** Where the finer, inside-the-page settings live. */
  inside?: string;
}

export const PAGES: PageDef[] = [
  { key: "home", path: "/home", label: "Home", hint: "Landing page", locked: true },
  { key: "calendar", path: "/calendar", label: "Calendar", hint: "Time logging and meetings" },
  { key: "contacts", path: "/contacts", label: "Contacts", hint: "People at companies" },
  { key: "companies", path: "/companies", label: "Companies", hint: "Accounts and prospects" },
  { key: "sales", path: "/sales", label: "Sales", hint: "Pipelines and deals", inside: "Sales → Actions → Sales roles → Adjust settings" },
  { key: "clients", path: "/clients", label: "Clients", hint: "Clients and contracts" },
  { key: "projects", path: "/projects", label: "Projects", hint: "Delivery projects" },
  { key: "management", path: "/management", label: "Management", hint: "Team, backlog, billing, bonus" },
  { key: "settings", path: "/settings", label: "Settings", hint: "Personal and company settings", locked: true },
];
export const PAGE_KEYS = PAGES.map((p) => p.key);

/* ─────────────── panels inside a page ─────────────── */
/** none = hidden · own = only their own data · all = everything. */
export type Level = "none" | "own" | "all";
export interface PanelDef {
  /** `${page}.${id}` — the key stored in the rules. */
  key: string;
  page: PageKey;
  id: string;
  label: string;
  hint: string;
  /** What can be chosen. Two levels = hidden / open. */
  levels: Level[];
  /** Always open (personal settings). */
  locked?: boolean;
}
const panel = (page: PageKey, id: string, label: string, hint: string, levels: Level[] = ["none", "all"], locked?: boolean): PanelDef =>
  ({ key: `${page}.${id}`, page, id, label, hint, levels, locked });
export const PANELS: PanelDef[] = [
  panel("settings", "organization", "Organization", "People, departments & structure"),
  panel("settings", "catalog", "Products & Services", "Catalog, pricing & blueprints"),
  panel("settings", "pipelines", "Client Pipelines", "The phases a client goes through"),
  panel("settings", "proposal", "Proposal template", "Brand, copy & terms for proposals"),
  panel("settings", "interface", "Interface", "Toolbar & layout", ["all"], true),
  panel("settings", "account", "Your account", "Password & details", ["all"], true),
  panel("management", "team", "Team", "Consultant cards, KPIs, connectors", ["none", "own", "all"]),
  panel("management", "backlog", "Backlog", "Remaining sold days per project", ["none", "own", "all"]),
  panel("management", "billing", "Billing", "Bills and invoices per project", ["none", "own", "all"]),
  panel("management", "bonus", "Bonus", "Bonus per consultant", ["none", "own", "all"]),
  panel("management", "incoming", "Incoming", "Handoffs from sales"),
  panel("management", "saved_days", "Saved days bank", "Days banked from billing trims", ["none", "own", "all"]),
  panel("management", "settings", "Targets & settings", "The gear: targets, capacity, bonus rules"),
  panel("management", "security", "Security", "Can change who sees Management's panels"),
];
export const panelsOf = (page: PageKey) => PANELS.filter((p) => p.page === page);
export const panelDef = (key: string) => PANELS.find((p) => p.key === key);
export const isPanelKey = (key: string) => key.includes(".");

/* ─────────────── built-in defaults (how the app behaved before) ─────────────── */
const SALES_TEAM = ["boss", "sales", "sales_manager", "marketing_manager"];
const MANAGER_ROLES = ["boss", "consultancy_manager", "sales_manager", "customer_success", "it_manager", "marketing_manager", "hr_manager"];
const DEFAULTS: Record<PageKey, "all" | string[]> = {
  home: "all", calendar: "all", projects: "all", settings: "all",
  contacts: SALES_TEAM, companies: SALES_TEAM, sales: SALES_TEAM,
  clients: ["boss"],
  management: MANAGER_ROLES,
};
export const defaultAllowed = (page: PageKey, level: string | null | undefined) => {
  const d = DEFAULTS[page];
  return d === "all" || (!!level && d.includes(level.toLowerCase()));
};
/** Keep in sync with access_default() in empower_page_access_v3.sql. */
export function defaultPanelLevel(key: string, level: string | null | undefined): Level {
  const lvl = (level ?? "").toLowerCase();
  const def = panelDef(key);
  if (!def) return "none";
  if (def.locked) return "all";
  if (def.page === "settings") return MANAGER_ROLES.includes(lvl) ? "all" : "none";
  if (key === "management.security") return "none";
  if (key === "management.saved_days") return lvl === "consultancy_manager" ? "all" : "own";
  return "all";
}

/* ─────────────── rules ─────────────── */
export type PageSubject = "everyone" | "role" | "dept" | "user";
/** One subject's settings. Pages: true (open) / false (hidden). Panels: "none" | "own" | "all". Missing = inherit. */
export type PageMap = Partial<Record<string, boolean | Level>>;
export type PageRules = Record<string, PageMap>; // key: `${type}:${id}`
export const pageRuleKey = (t: PageSubject, id: string) => `${t}:${id}`;

/**
 * All rules. Until the SQL is run (missing = true), the older per-security-role
 * table (page_access) is read instead, so nothing set before is lost.
 */
export async function loadPageRules(): Promise<{ rules: PageRules; missing: boolean }> {
  const out: PageRules = {};
  const { data, error } = await supabase.from("page_access_rules").select("subject_type, subject_id, pages");
  if (!error) {
    ((data ?? []) as any[]).forEach((r) => { out[pageRuleKey(r.subject_type, String(r.subject_id))] = (r.pages ?? {}) as PageMap; });
    return { rules: out, missing: false };
  }
  const legacy = await supabase.from("page_access").select("role, page, allowed").range(0, 99999);
  (((legacy as any).data ?? []) as any[]).forEach((r) => {
    const k = pageRuleKey("role", String(r.role).toLowerCase());
    (out[k] ?? (out[k] = {}))[r.page] = !!r.allowed;
  });
  return { rules: out, missing: true };
}

/** Save the subjects that changed (an empty one is removed). */
export async function savePageRules(next: PageRules, prev: PageRules): Promise<string | null> {
  const keys = new Set([...Object.keys(next), ...Object.keys(prev)]);
  for (const k of keys) {
    const a = next[k] ?? {}, b = prev[k] ?? {};
    if (JSON.stringify(sortObj(a)) === JSON.stringify(sortObj(b))) continue;
    const [subject_type, ...rest] = k.split(":");
    const subject_id = rest.join(":");
    if (!Object.keys(a).length) {
      const { error } = await supabase.from("page_access_rules").delete().eq("subject_type", subject_type).eq("subject_id", subject_id);
      if (error) return error.message;
    } else {
      const { error } = await supabase.from("page_access_rules")
        .upsert({ subject_type, subject_id, pages: a, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,subject_type,subject_id" });
      if (error) return error.message;
    }
  }
  return null;
}
const sortObj = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/* ─────────────── resolving ─────────────── */
export interface AccessPerson { id: string; level: string | null; department: string | null; isSuper?: boolean }
export type PageSourceKind = "boss" | "locked" | "user" | "role" | "dept" | "everyone" | "default";
export interface PageResult { allowed: boolean; source: PageSourceKind }
export interface PanelResult { level: Level; source: PageSourceKind }

/** Is the person's own role a "can't be limited" one? */
export const isFullAccess = (p: Pick<AccessPerson, "level" | "isSuper">) => !!p.isSuper || (p.level ?? "").toLowerCase() === "boss";

const steps = (p: AccessPerson, rules: PageRules): [PageSourceKind, PageMap | undefined][] => {
  const level = (p.level ?? "").toLowerCase();
  return [
    ["user", rules[pageRuleKey("user", p.id)]],
    ["role", level ? rules[pageRuleKey("role", level)] : undefined],
    ["dept", p.department ? rules[pageRuleKey("dept", p.department)] : undefined],
    ["everyone", rules[pageRuleKey("everyone", "*")]],
  ];
};
/** A stored value as a level (pages store true/false). */
export const asLevel = (v: boolean | Level | undefined): Level | undefined =>
  v === undefined ? undefined : v === true ? "all" : v === false ? "none" : v;
/** "own" where only hidden/open exist means open. */
export const clampLevel = (def: PanelDef | undefined, l: Level): Level =>
  !def || def.levels.includes(l) ? l : l === "own" ? "all" : l;

export function resolvePage(page: PageKey, p: AccessPerson, rules: PageRules): PageResult {
  if (isFullAccess(p)) return { allowed: true, source: "boss" };
  if (PAGES.find((x) => x.key === page)?.locked) return { allowed: true, source: "locked" };
  for (const [src, m] of steps(p, rules)) { const v = m?.[page]; if (v !== undefined) return { allowed: v === true || v === "all" || v === "own", source: src }; }
  return { allowed: defaultAllowed(page, p.level), source: "default" };
}
export function resolvePanel(key: string, p: AccessPerson, rules: PageRules): PanelResult {
  const def = panelDef(key);
  if (isFullAccess(p)) return { level: "all", source: "boss" };
  if (def?.locked) return { level: "all", source: "locked" };
  for (const [src, m] of steps(p, rules)) { const v = asLevel(m?.[key]); if (v !== undefined) return { level: clampLevel(def, v), source: src }; }
  return { level: defaultPanelLevel(key, p.level), source: "default" };
}
/** Pages and panels with one shape: a level ("all" = open). */
export function resolveAny(key: string, p: AccessPerson, rules: PageRules): PanelResult {
  if (isPanelKey(key)) return resolvePanel(key, p, rules);
  const r = resolvePage(key as PageKey, p, rules);
  return { level: r.allowed ? "all" : "none", source: r.source };
}
export function resolveAllPages(p: AccessPerson, rules: PageRules): Record<PageKey, PageResult> {
  return Object.fromEntries(PAGES.map((x) => [x.key, resolvePage(x.key, p, rules)])) as Record<PageKey, PageResult>;
}
export function resolveAllPanels(p: AccessPerson, rules: PageRules): Record<string, PanelResult> {
  return Object.fromEntries(PANELS.map((x) => [x.key, resolvePanel(x.key, p, rules)]));
}

/**
 * The signed-in user's SECURITY LEVEL, read live — the person's own security
 * role, else their department's — plus their department and superadmin flag.
 */
export async function loadMySecurityLevel(): Promise<{ id: string | null; level: string | null; department: string | null; isSuper: boolean }> {
  // Local session, not auth.getUser(): that one asks the auth server while holding
  // supabase-js's auth lock, so every query on the page waits behind it.
  const { data: auth } = await supabase.auth.getSession();
  const uid = auth?.session?.user?.id;
  if (!uid) return { id: null, level: null, department: null, isSuper: false };
  const { data: p } = await supabase.from("profiles").select("role, department, is_superadmin").eq("id", uid).maybeSingle();
  let level = ((p as any)?.role ?? "").toString().toLowerCase() || null;
  const department = (p as any)?.department ?? null;
  if (!level && department) {
    const { data: d } = await supabase.from("org_departments").select("security_role").eq("dept_key", department).maybeSingle();
    level = ((d as any)?.security_role ?? "").toString().toLowerCase() || null;
  }
  return { id: uid, level, department, isSuper: (p as any)?.is_superadmin === true };
}

/** Fire after changing someone's security level or page access so the app re-reads it. */
export const SECURITY_LEVEL_EVENT = "next:security-level-changed";

/* ─────────────── provider ─────────────── */
interface State {
  userId: string | null;
  level: string | null;
  isSuper: boolean;
  pages: Record<PageKey, PageResult>;
  panels: Record<string, PanelResult>;
}
interface Ctx {
  ready: boolean;
  userId: string | null;
  level: string | null;
  isSuper: boolean;
  /** This user's result for every page. */
  pages: Record<PageKey, PageResult> | null;
  /** This user's result for every panel inside Settings / Management. */
  panels: Record<string, PanelResult> | null;
  canSee: (p: PageKey) => boolean;
  /** Level for a panel, e.g. panel("management.billing") → "own". */
  panel: (key: string) => Level;
  /** Panel isn't hidden. */
  canPanel: (key: string) => boolean;
  reload: () => Promise<void>;
}
const PageAccessCtx = createContext<Ctx>({
  ready: false, userId: null, level: null, isSuper: false, pages: null, panels: null,
  canSee: () => false, panel: () => "none", canPanel: () => false, reload: async () => {},
});

export function PageAccessProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State | null>(null);

  const reload = useCallback(async () => {
    // Preferred: the database works it out for the signed-in user.
    const { data, error } = await supabase.rpc("my_pages");
    const rows = (!error && Array.isArray(data) ? data : []) as { page: string; allowed: boolean; level?: Level | null; source: PageSourceKind; security_level: string | null; is_superadmin: boolean }[];
    // A superadmin previewing another security level: resolve that level here instead.
    const { data: sess } = await supabase.auth.getSession();
    const previewing = !!getRolePreview(sess?.session?.user?.id ?? "-");
    if (!previewing && rows.length && rows.some((r) => isPanelKey(r.page))) {
      const pages = Object.fromEntries(PAGES.map((p) => {
        const r = rows.find((x) => x.page === p.key);
        return [p.key, r ? { allowed: !!r.allowed, source: r.source } : { allowed: !!p.locked, source: "default" as const }];
      })) as Record<PageKey, PageResult>;
      const panels = Object.fromEntries(PANELS.map((p) => {
        const r = rows.find((x) => x.page === p.key);
        return [p.key, r ? { level: (r.level ?? (r.allowed ? "all" : "none")) as Level, source: r.source } : { level: p.locked ? "all" as const : "none" as const, source: "default" as const }];
      }));
      const { data: auth } = await supabase.auth.getSession();
      setState({ userId: auth?.session?.user?.id ?? null, level: (rows[0].security_level ?? "").toLowerCase() || null, isSuper: !!rows[0].is_superadmin, pages, panels });
      return;
    }
    // Not installed (or an older version): resolve the same rules here.
    if (error) console.warn("[page-access] my_pages() unavailable, resolving in the browser:", error.message);
    const [{ rules }, real] = await Promise.all([loadPageRules(), loadMySecurityLevel()]);
    if (!real.id) { setState(null); return; }
    const pv = getRolePreview(real.id);
    const me = pv ? { ...real, level: pv.role, department: pv.department ?? real.department, isSuper: false } : real;
    const person = { id: real.id, level: me.level, department: me.department, isSuper: me.isSuper };
    setState({ userId: real.id, level: me.level, isSuper: me.isSuper, pages: resolveAllPages(person, rules), panels: resolveAllPanels(person, rules) });
  }, []);

  useEffect(() => { reload(); }, [reload]);
  // Pick up changes made elsewhere (Organization, Page access, another tab) and sign-in changes.
  useEffect(() => {
    const again = () => { reload(); };
    const onVis = () => { if (document.visibilityState === "visible") reload(); };
    window.addEventListener(SECURITY_LEVEL_EVENT, again);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", onVis);
    // Not on INITIAL_SESSION (the mount already loads) nor on hourly token refreshes;
    // and outside the auth callback, as supabase-js asks.
    const sub = supabase.auth.onAuthStateChange?.((event: string) => {
      if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      setTimeout(() => { reload(); }, 0);
    });
    return () => {
      window.removeEventListener(SECURITY_LEVEL_EVENT, again);
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", onVis);
      sub?.data?.subscription?.unsubscribe?.();
    };
  }, [reload]);

  const ready = state !== null;
  const canSee = useCallback((p: PageKey) => !!state?.pages[p]?.allowed, [state]);
  const panelLevel = useCallback((k: string): Level => state?.panels[k]?.level ?? "none", [state]);
  const canPanel = useCallback((k: string) => (state?.panels[k]?.level ?? "none") !== "none", [state]);
  const value = useMemo<Ctx>(() => ({
    ready, userId: state?.userId ?? null, level: state?.level ?? null, isSuper: !!state?.isSuper,
    pages: state?.pages ?? null, panels: state?.panels ?? null, canSee, panel: panelLevel, canPanel, reload,
  }), [ready, state, canSee, panelLevel, canPanel, reload]);
  return (
    <PageAccessCtx.Provider value={value}>
      {children}
      <SuperAdminBubble />
    </PageAccessCtx.Provider>
  );
}

export const usePageAccess = () => useContext(PageAccessCtx);

/** Route guard: renders the page if this person may open it, else Home. */
export function PageRoute({ page }: { page: PageKey }) {
  const { ready, canSee } = usePageAccess();
  if (!ready) return null;
  if (!canSee(page)) return <Navigate to="/home" replace />;
  return <Outlet />;
}