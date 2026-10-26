/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Page access: which pages of the side menu each person can open, and which
 * panels inside Settings and Management they get.
 *
 * Pages: Settings → Organization → Page access lists, per page, the departments
 * that can open it (page_departments). A page without a list follows the
 * earlier rules, set per subject:
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
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { supabase } from "../api/supabase";
import SuperAdminBubble, { getRolePreview } from "./SuperAdmin";

export type PageKey =
  | "home" | "tickets" | "calendar" | "contacts" | "companies" | "clients"
  | "projects" | "sales" | "management" | "settings" | "marketing" | "success";

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
  { key: "tickets", path: "/tickets", label: "Tickets", hint: "Team tickets and tasks" },
  { key: "calendar", path: "/calendar", label: "Calendar", hint: "Time logging and meetings" },
  { key: "contacts", path: "/contacts", label: "Contacts", hint: "People at companies" },
  { key: "companies", path: "/companies", label: "Companies", hint: "Accounts and prospects" },
  { key: "sales", path: "/sales", label: "Sales", hint: "Pipelines and deals", inside: "Sales → Actions → Sales roles → Adjust settings" },
  { key: "clients", path: "/clients", label: "Clients", hint: "Clients and contracts" },
  { key: "projects", path: "/projects", label: "Projects", hint: "Delivery projects" },
  { key: "management", path: "/management", label: "Management", hint: "Team, backlog, billing, bonus" },
  { key: "marketing", path: "/marketing", label: "Marketing", hint: "Lists and e-mail campaigns" },
  { key: "success", path: "/success", label: "Customer success", hint: "Retention, health, renewals and upsells" },
  { key: "settings", path: "/settings", label: "Settings", hint: "Personal and company settings", locked: true },
];
export const PAGE_KEYS = PAGES.map((p) => p.key);

/* ─────────────── departments (Settings → Organization) ───────────────
   Departments are the company's own: any name, colour and mark, as many as it
   wants. A person belongs to one (profiles.department = its key). The key is
   fixed when the department is made, so renaming one never breaks a link. */
export interface Department { id: string; key: string; name: string; color: string; icon: string; sort: number }
/** The departments a new company starts with (and the look of the original seven). */
export const DEFAULT_DEPARTMENTS: { key: string; label: string; color: string; icon: string }[] = [
  { key: "consultancy", label: "Consultancy", color: "#12b57f", icon: "◆" },
  { key: "human_resources", label: "Human Resources", color: "#e0798c", icon: "♥" },
  { key: "marketing", label: "Marketing", color: "#e0a13c", icon: "◈" },
  { key: "sales", label: "Sales", color: "#3c9ae0", icon: "▲" },
  { key: "customer_success", label: "Customer Success", color: "#9b6fd0", icon: "★" },
  { key: "it", label: "IT", color: "#4a5568", icon: "❖" },
  { key: "management", label: "Management", color: "#0a6f4d", icon: "◉" },
];
export const DEPT_COLORS = ["#12b57f", "#0a6f4d", "#3c9ae0", "#2f6fd6", "#9b6fd0", "#e0798c", "#d9534f", "#e0a13c", "#c98a1b", "#1aa3a3", "#4a5568", "#7a8b99"];
const prettyKey = (k: string) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
/** A stored department row as a Department (rows from before 61_custom_departments.sql have only a key). */
export function deptFromRow(r: any, i = 0): Department {
  const key = String(r.dept_key ?? "");
  const def = DEFAULT_DEPARTMENTS.find((d) => d.key === key);
  const n = DEFAULT_DEPARTMENTS.findIndex((d) => d.key === key);
  return {
    id: String(r.id ?? key), key,
    name: String(r.name ?? "").trim() || def?.label || prettyKey(key),
    color: r.color || def?.color || DEPT_COLORS[i % DEPT_COLORS.length],
    icon: r.icon || def?.icon || "●",
    sort: Number.isFinite(Number(r.sort)) && r.sort != null ? Number(r.sort) : n >= 0 ? n : 100 + i,
  };
}
let deptCache: Department[] | null = null;
let deptLoading: Promise<Department[]> | null = null;
/** Fire after departments are added, renamed or removed: every list re-reads them. */
export const DEPARTMENTS_EVENT = "next:departments-changed";
/** The company's departments, in their order. */
export async function loadDepartments(force = false): Promise<Department[]> {
  if (deptCache && !force) return deptCache;
  if (deptLoading && !force) return deptLoading;
  deptLoading = (async () => {
    const { data, error } = await supabase.from("org_departments").select("*");
    const rows = error ? [] : ((data ?? []) as any[]);
    const list = rows.map((r, i) => deptFromRow(r, i)).filter((d) => d.key).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    deptCache = list;
    deptLoading = null;
    return list;
  })();
  return deptLoading;
}
/** Tell the app the departments changed (pass the new list when you have it). */
export function departmentsChanged(list?: Department[]) {
  if (list) deptCache = list.slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  else deptCache = null;
  window.dispatchEvent(new CustomEvent(DEPARTMENTS_EVENT));
}
/** A department's name from its key (what's loaded; the key made readable until then). */
export function deptName(key: string | null | undefined): string {
  if (!key) return "";
  return deptCache?.find((d) => d.key === key)?.name ?? DEFAULT_DEPARTMENTS.find((d) => d.key === key)?.label ?? prettyKey(key);
}
export function deptInfo(key: string | null | undefined): Department | null {
  if (!key) return null;
  return deptCache?.find((d) => d.key === key) ?? null;
}
/** The departments, kept up to date (null while the first read runs). */
export function useDepartments(): Department[] | null {
  const [list, setList] = useState<Department[] | null>(deptCache);
  useEffect(() => {
    let alive = true;
    const read = (force: boolean) => { loadDepartments(force).then((l) => { if (alive) setList(l); }).catch(() => {}); };
    read(false);
    const on = () => read(!deptCache);
    window.addEventListener(DEPARTMENTS_EVENT, on);
    return () => { alive = false; window.removeEventListener(DEPARTMENTS_EVENT, on); };
  }, []);
  return list;
}
/** A key for a new department, from its name ("Finance & Legal" → "finance_legal"), never one already taken. */
export function newDeptKey(name: string, taken: string[]): string {
  const base = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "department";
  let k = base, n = 2;
  while (taken.includes(k)) k = `${base}_${n++}`;
  return k;
}

/* ─────────────── which departments open each page (61_custom_departments.sql) ───────────────
   A page with a list opens to the people of those departments only ("*" = everyone).
   A page without one keeps the earlier rules (security role defaults, people, roles).
   Bosses and superadmins always open everything; Home and Settings are always open. */
export type PageDeptMap = Partial<Record<PageKey, string[]>>;
/** People let in on a page on top of its departments (62_page_access_people.sql). */
export type PageUserMap = Partial<Record<PageKey, string[]>>;
export const EVERYONE = "*";
export async function loadPageDepartments(): Promise<{ map: PageDeptMap; users: PageUserMap; missing: boolean; usersMissing: boolean }> {
  let usersMissing = false;
  let res: any = await supabase.from("page_departments").select("page, dept_keys, user_ids");
  if (res.error && /user_ids/i.test(res.error.message)) { usersMissing = true; res = await supabase.from("page_departments").select("page, dept_keys"); }
  if (res.error) return { map: {}, users: {}, missing: true, usersMissing: true };
  const map: PageDeptMap = {}, users: PageUserMap = {};
  ((res.data ?? []) as any[]).forEach((r) => {
    if (!PAGE_KEYS.includes(r.page)) return;
    map[r.page as PageKey] = Array.isArray(r.dept_keys) ? r.dept_keys.map(String) : [];
    if (Array.isArray(r.user_ids) && r.user_ids.length) users[r.page as PageKey] = r.user_ids.map(String);
  });
  return { map, users, missing: false, usersMissing };
}
/** Save the pages that changed: their departments and people, or null to go back to the earlier rules. */
export async function savePageDepartments(changes: Partial<Record<PageKey, { depts: string[]; users: string[] } | null>>): Promise<string | null> {
  for (const [page, v] of Object.entries(changes) as [PageKey, { depts: string[]; users: string[] } | null][]) {
    let res: any;
    if (v == null) res = await supabase.from("page_departments").delete().eq("page", page);
    else {
      const row: Record<string, any> = { page, dept_keys: v.depts, user_ids: v.users, updated_at: new Date().toISOString() };
      res = await supabase.from("page_departments").upsert(row, { onConflict: "tenant_id,page" });
      if (res.error && /user_ids/i.test(res.error.message)) {
        if (v.users.length) return "Run 62_page_access_people.sql in Supabase to let people in by name.";
        delete row.user_ids;
        res = await supabase.from("page_departments").upsert(row, { onConflict: "tenant_id,page" });
      }
    }
    if (res.error) return /page_departments|schema cache|does not exist/i.test(res.error.message) ? "Run 61_custom_departments.sql in Supabase first." : res.error.message;
  }
  return null;
}
/** May someone of this department open a page with this list? */
export const deptListOpens = (keys: string[], department: string | null | undefined) => keys.includes(EVERYONE) || (!!department && keys.includes(department));
/** Lay the department lists (and the people let in by name) over the result of the other rules. */
export function applyPageDepartments(pages: Record<PageKey, PageResult>, map: PageDeptMap, p: { department: string | null; isFull: boolean; userId?: string | null }, users: PageUserMap = {}): Record<PageKey, PageResult> {
  if (p.isFull) return pages;
  const out = { ...pages };
  (Object.keys(map) as PageKey[]).forEach((k) => {
    if (PAGES.find((x) => x.key === k)?.locked) return;
    const byName = !!p.userId && !!users[k]?.includes(p.userId);
    out[k] = { allowed: byName || deptListOpens(map[k] ?? [], p.department), source: byName ? "user" : "dept" };
  });
  return out;
}

/* ─────────────── how much of a page's data people see (63_page_data_scopes.sql) ───────────────
   Set in Settings › <page> › Security. Per page: a default for everyone who can open it,
   then by department, then by security role (a Sales manager inside Sales), then by person —
   the most specific wins. Bosses and superadmins always see everything. Each page offers the
   levels that make sense for it. */
export type DataScope = "all" | "department" | "mine" | "assigned" | "created";
/** Who a panel inside the page is hidden from (departments, security roles, people). */
export interface PanelHide { depts?: string[]; roles?: string[]; users?: string[] }
export interface ScopeRules { default: DataScope; depts: Record<string, DataScope>; roles: Record<string, DataScope>; users: Record<string, DataScope>; panels?: Record<string, PanelHide> }
export interface ScopeDef { what: string; levels: DataScope[]; label: Partial<Record<DataScope, string>>; hint: Partial<Record<DataScope, string>> }
const scopeDef = (what: string, levels: DataScope[], label: Partial<Record<DataScope, string>> = {}, hint: Partial<Record<DataScope, string>> = {}): ScopeDef =>
  ({ what, levels, label: { all: "Everything", department: "Their department's", ...label }, hint: { all: `Every ${what.replace(/s$/, "")} in the company`, department: `What anyone in their department has`, ...hint } });
export const PAGE_SCOPES: Partial<Record<PageKey, ScopeDef>> = {
  tickets: scopeDef("tickets", ["all", "department", "mine", "assigned", "created"],
    { mine: "Assigned to or opened by them", assigned: "Only assigned to them", created: "Only opened by them" },
    { department: "Tickets assigned to or opened by anyone in their department", mine: "Their own tickets and the ones they opened for others" }),
  calendar: scopeDef("calendars", ["all", "department", "mine"], { mine: "Only their own" },
    { all: "Everyone's calendar and logged time", department: "The calendars of their department", mine: "Only their own calendar and time" }),
  projects: scopeDef("projects", ["all", "department", "assigned"], { assigned: "Only projects they're on" },
    { department: "Projects someone of their department is on", assigned: "Projects where they're in the team" }),
  success: scopeDef("clients", ["all", "department", "assigned"], { assigned: "Only clients they look after" },
    { department: "Clients looked after by their department", assigned: "Clients where they are an owner" }),
  marketing: scopeDef("lists and campaigns", ["all", "department", "created"], { created: "Only what they made" },
    { all: "Every list and campaign", department: "Lists and campaigns made by their department", created: "Lists and campaigns they made" }),
  sales: scopeDef("deals", ["all", "department", "mine", "assigned", "created"],
    { mine: "Owned by, on, or created by them", assigned: "Only deals they own or are on", created: "Only deals they created" },
    { department: "Deals owned by or shared with their department", mine: "Their deals and the ones they created" }),
  companies: scopeDef("companies", ["all", "department", "mine"], { mine: "Owned or created by them" },
    { department: "Companies owned or created by their department", mine: "Companies they own or created" }),
  contacts: scopeDef("contacts", ["all", "department", "mine"], { mine: "Owned or created by them" },
    { department: "Contacts owned or created by their department", mine: "Contacts they own or created" }),
  clients: scopeDef("clients", ["all", "department", "assigned"], { assigned: "Only their clients" },
    { department: "Clients their department works on or looks after", assigned: "Clients they work on or look after" }),
  management: scopeDef("team figures", ["all", "department", "mine"], { mine: "Only their own" },
    { all: "Backlog, billing and bonus of everyone", department: "The figures of their department", mine: "Only their own figures" }),
};
export const DEFAULT_SCOPE_RULES: ScopeRules = { default: "all", depts: {}, roles: {}, users: {} };
export async function loadScopeRules(page: PageKey): Promise<{ rules: ScopeRules; missing: boolean }> {
  const { data, error } = await supabase.from("page_data_scopes").select("rules").eq("page", page).maybeSingle();
  if (error) return { rules: { ...DEFAULT_SCOPE_RULES }, missing: true };
  const r = ((data as any)?.rules ?? {}) as Partial<ScopeRules>;
  return { rules: { default: (r.default as DataScope) ?? "all", depts: r.depts ?? {}, roles: r.roles ?? {}, users: r.users ?? {}, panels: r.panels ?? {} }, missing: false };
}
export async function saveScopeRules(page: PageKey, rules: ScopeRules): Promise<string | null> {
  const { error } = await supabase.from("page_data_scopes").upsert({ page, rules, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,page" });
  if (error) return /page_data_scopes|schema cache|does not exist/i.test(error.message) ? "Run 63_page_data_scopes.sql in Supabase to save this." : error.message;
  scopeCache.delete(page);
  window.dispatchEvent(new CustomEvent(SCOPES_EVENT, { detail: page }));
  return null;
}
/** The level that applies to someone: person › security role › department › default (bosses and superadmins: everything). */
export function scopeFor(rules: ScopeRules, p: { userId: string | null; department: string | null; role?: string | null; isFull: boolean }, def?: ScopeDef): DataScope {
  if (p.isFull) return "all";
  const role = (p.role ?? "").toLowerCase();
  const v = (p.userId && rules.users[p.userId]) || (role && rules.roles?.[role]) || (p.department && rules.depts[p.department]) || rules.default || "all";
  return def && !def.levels.includes(v) ? "all" : v;
}
/** Whether a panel of the page is hidden from someone (bosses and superadmins: never). */
export function panelHiddenFor(rules: ScopeRules, panel: string, p: { userId: string | null; department: string | null; role?: string | null; isFull: boolean }): boolean {
  if (p.isFull) return false;
  const h = rules.panels?.[panel];
  if (!h) return false;
  const role = (p.role ?? "").toLowerCase();
  return (!!p.userId && !!h.users?.includes(p.userId)) || (!!role && !!h.roles?.includes(role)) || (!!p.department && !!h.depts?.includes(p.department));
}
const scopeCache = new Map<PageKey, Promise<{ rules: ScopeRules; missing: boolean }>>();
export const SCOPES_EVENT = "next:data-scopes-changed";
/** How much of this page's data the signed-in person sees ("all" until the rules are read). */
export function useDataScope(page: PageKey): { scope: DataScope; ready: boolean; hidden: (panel: string) => boolean } {
  const { ready, userId, department, level, isSuper } = usePageAccess();
  const [rules, setRules] = useState<ScopeRules | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => {
      if (!scopeCache.has(page)) scopeCache.set(page, loadScopeRules(page));
      scopeCache.get(page)!.then((r) => { if (alive) setRules(r.rules); });
    };
    read();
    const on = (e: Event) => { if ((e as CustomEvent).detail === page) read(); };
    window.addEventListener(SCOPES_EVENT, on);
    return () => { alive = false; window.removeEventListener(SCOPES_EVENT, on); };
  }, [page]);
  if (!ready || !rules) return { scope: "all", ready: false, hidden: () => false };
  const me = { userId, department, role: level, isFull: isSuper || level === "boss" };
  return { scope: scopeFor(rules, me, PAGE_SCOPES[page]), ready: true, hidden: (panel: string) => panelHiddenFor(rules, panel, me) };
}

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
  home: "all", tickets: "all", calendar: "all", projects: "all", settings: "all",
  contacts: SALES_TEAM, companies: SALES_TEAM, sales: SALES_TEAM,
  clients: ["boss"],
  management: MANAGER_ROLES,
  marketing: ["boss", "marketing_manager", "sales_manager"],
  success: ["boss", "customer_success", "consultancy_manager", "sales_manager"],
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
  department?: string | null;
  level: string | null;
  isSuper: boolean;
  pages: Record<PageKey, PageResult>;
  panels: Record<string, PanelResult>;
}
interface Ctx {
  ready: boolean;
  userId: string | null;
  /** The signed-in person's department (key). */
  department: string | null;
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
  ready: false, userId: null, department: null, level: null, isSuper: false, pages: null, panels: null,
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
        // a page the database doesn't know yet (added after its rules were installed): the built-in default
        return [p.key, r ? { allowed: !!r.allowed, source: r.source } : { allowed: !!p.locked || !!rows[0].is_superadmin || defaultAllowed(p.key, rows[0].security_level), source: "default" as const }];
      })) as Record<PageKey, PageResult>;
      const panels = Object.fromEntries(PANELS.map((p) => {
        const r = rows.find((x) => x.page === p.key);
        return [p.key, r ? { level: (r.level ?? (r.allowed ? "all" : "none")) as Level, source: r.source } : { level: p.locked ? "all" as const : "none" as const, source: "default" as const }];
      }));
      const [{ data: auth }, me, pd] = await Promise.all([supabase.auth.getSession(), loadMySecurityLevel(), loadPageDepartments()]);
      const lvl = (rows[0].security_level ?? "").toLowerCase() || null;
      const full = !!rows[0].is_superadmin || lvl === "boss";
      setState({ userId: auth?.session?.user?.id ?? null, department: me.department, level: lvl, isSuper: !!rows[0].is_superadmin, pages: applyPageDepartments(pages, pd.map, { department: me.department, isFull: full, userId: me.id }, pd.users), panels });
      return;
    }
    // Not installed (or an older version): resolve the same rules here.
    if (error) console.warn("[page-access] my_pages() unavailable, resolving in the browser:", error.message);
    const [{ rules }, real, pd] = await Promise.all([loadPageRules(), loadMySecurityLevel(), loadPageDepartments()]);
    if (!real.id) { setState(null); return; }
    const pv = getRolePreview(real.id);
    const me = pv ? { ...real, level: pv.role, department: pv.department ?? real.department, isSuper: false } : real;
    const person = { id: real.id, level: me.level, department: me.department, isSuper: me.isSuper };
    setState({ userId: real.id, department: me.department, level: me.level, isSuper: me.isSuper, pages: applyPageDepartments(resolveAllPages(person, rules), pd.map, { department: me.department, isFull: isFullAccess(person), userId: real.id }, pd.users), panels: resolveAllPanels(person, rules) });
  }, []);

  useEffect(() => { reload(); loadDepartments().catch(() => {}); }, [reload]);
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
    ready, userId: state?.userId ?? null, department: state?.department ?? null, level: state?.level ?? null, isSuper: !!state?.isSuper,
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
/* =====================================================================
   Deep links into a page's sub-sections ("management/billing/sent").
   goToSection(navigate, "/management", "billing/sent") opens the page and asks
   each level to switch: ManagementPage reads part 0 ("billing"), BillingPanel
   part 1 ("sent"). A page that isn't on screen yet reads the request when it
   mounts (it stays readable for a few seconds); a page already on screen gets
   it through an event.
   Clicking the sidebar item of the page you're already on resets it to its
   overview: NAV_RESET_EVENT, and AppLayout remounts the page.
   ===================================================================== */
export const NAV_SECTION_EVENT = "next:nav-section";
export const NAV_RESET_EVENT = "next:nav-reset";
let pendingSection: { path: string; parts: string[]; at: number } | null = null;
const SECTION_TTL = 4000;

export function goToSection(navigate: (to: string, opts?: { replace?: boolean; state?: unknown }) => void, path: string, section?: string | null) {
  const parts = (section ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  pendingSection = parts.length ? { path, parts, at: Date.now() } : null;
  navigate(path, parts.length ? { state: { navSection: parts.join("/"), navAt: Date.now() } } : undefined);
  if (parts.length) window.setTimeout(() => window.dispatchEvent(new CustomEvent(NAV_SECTION_EVENT, { detail: { path, parts } })), 0);
}
/** The part of a pending deep link meant for `level` of `path` (or null). */
export function pendingSectionPart(path: string, level: number, parentPart?: string): string | null {
  const p = pendingSection;
  if (!p || p.path !== path || Date.now() - p.at > SECTION_TTL) return null;
  if (parentPart !== undefined && p.parts[level - 1] !== parentPart) return null;
  return p.parts[level] ?? null;
}
export function clearPendingSection() { pendingSection = null; }

/* =====================================================================
   Leaving a screen with unsaved work (e.g. the pipeline editor).
   The screen registers a hold while it has changes; the sidebar, the account
   menu and the search run their navigation through guardedLeave(), so the
   screen can ask first ("Save / Discard / Keep editing") and then let it go.
   ===================================================================== */
type LeaveHold = (go: () => void) => boolean;
let leaveHold: LeaveHold | null = null;
/** While set, `hold(go)` returns true when it takes over (it asks, and calls go() if the person leaves). */
export function setLeaveGuard(hold: LeaveHold | null) { leaveHold = hold; }
/** Run `go` now — unless a screen with unsaved work wants to ask first. */
export function guardedLeave(go: () => void) {
  if (leaveHold && leaveHold(go)) return;
  go();
}

/**
 * Switch a page (or a panel inside it) to the requested sub-section.
 *   level 0 = the page's own tabs/views; level 1 = a panel inside the tab given as `parentPart`.
 * `apply` returns nothing; unknown values should be ignored by the caller.
 */
export function useNavSection(path: string, level: number, apply: (part: string) => void, parentPart?: string) {
  const ref = useRef(apply);
  ref.current = apply;
  useEffect(() => {
    const now = pendingSectionPart(path, level, parentPart);
    if (now) ref.current(now);
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ path: string; parts: string[] }>).detail;
      if (!d || d.path !== path) return;
      if (parentPart !== undefined && d.parts[level - 1] !== parentPart) return;
      const part = d.parts[level];
      if (part) ref.current(part);
    };
    window.addEventListener(NAV_SECTION_EVENT, on);
    return () => window.removeEventListener(NAV_SECTION_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, level, parentPart]);
}
