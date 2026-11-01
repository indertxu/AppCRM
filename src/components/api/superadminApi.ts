import { supabase } from "./supabase";

async function call(action: string, payload: Record<string, unknown> = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  let res: Response;
  try {
    res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-tenants`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        },
        body: JSON.stringify({ action, ...payload }),
      },
    );
  } catch (e: any) {
    return { error: `Network error: ${e?.message ?? "could not reach the server"}` };
  }

  // Read the body as text first so we never crash on empty / non-JSON responses.
  const raw = await res.text();
  let body: any = {};
  if (raw) { try { body = JSON.parse(raw); } catch { body = { error: raw }; } }

  if (!res.ok) {
    // Surface whatever the function returned, or a status-based fallback.
    const msg = body?.error || body?.message || body?.msg || raw || `Request failed (HTTP ${res.status})`;
    return { error: typeof msg === "string" ? msg : JSON.stringify(msg) };
  }
  // Even on 200, an error field may be present.
  if (body?.error && typeof body.error !== "string") body.error = JSON.stringify(body.error);
  return body;
}

export interface Tenant {
  id: string;
  name: string;
  max_users: number;
  active: boolean;
  user_count: number;
  created_at: string;
}
export interface TenantUser {
  id: string;
  email: string;
  role: string;
  job_title: string;
  first_name?: string | null;
  last_name?: string | null;
}

export const listTenants = () => call("list_tenants").then((r) => (r.tenants ?? []) as Tenant[]);
export const createTenant = (name: string, maxUsers: number) => call("create_tenant", { name, maxUsers });
export const toggleTenant = (tenantId: string, active: boolean) => call("toggle_tenant", { tenantId, active });
export const updateTenant = (tenantId: string, patch: { name?: string; maxUsers?: number }) =>
  call("update_tenant", { tenantId, ...patch });
/** A company's users, with their names and e-mails: from the function, else 81_superadmin_user_names.sql,
 *  else straight from the profiles (what the superadmin's own access lets it read). */
export async function listUsers(tenantId: string): Promise<TenantUser[]> {
  const r = await call("list_users", { tenantId });
  const users = (r.users ?? []) as TenantUser[];
  if (!users.length || users.every((u) => (u.first_name || u.last_name) && u.email)) return users;
  type Row = { id: string; first_name?: string | null; last_name?: string | null; email?: string | null };
  let rows: Row[] = [];
  const { data, error } = await supabase.rpc("superadmin_user_names", { p_tenant: tenantId });
  if (!error && Array.isArray(data)) rows = data as Row[];
  else {
    const ids = users.map((u) => u.id);
    let res: any = await supabase.from("profiles").select("id, first_name, last_name, email").in("id", ids);
    if (res.error) res = await supabase.from("profiles").select("id, first_name, last_name").in("id", ids);
    rows = (res.data ?? []) as Row[];
  }
  const by = new Map(rows.map((n) => [n.id, n]));
  return users.map((u) => {
    const n = by.get(u.id);
    return { ...u, email: u.email || n?.email || "", first_name: u.first_name || n?.first_name || null, last_name: u.last_name || n?.last_name || null };
  });
}

export const createUser = (tenantId: string, email: string, password: string, role: string, jobTitle: string) =>
  call("create_user", { tenantId, email, password, role, jobTitle });
export const deleteUser = (userId: string) => call("delete_user", { userId });

/** Is the currently logged-in user a superadmin? */
export async function checkSuperadmin(): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from("profiles").select("is_superadmin").eq("id", user.id).maybeSingle();
  return !!data?.is_superadmin;
}

/* =====================================================================
   The console's data: two RPCs (sql/86_platform_admin.sql) instead of the
   function paging through every auth user, plus the cost model.
   ===================================================================== */

export interface DashTenant {
  id: string; name: string; active: boolean; max_users: number; created_at: string;
  users: number; deactivated: number; signed_in_30d: number; active_users: number; last_seen: string | null;
  visits: number; seconds: number; requests: number; bytes: number;
  db_rows: number; db_bytes: number; file_count: number; file_bytes: number;
  ai_calls: number; ai_in: number; ai_out: number; changes: number;
}
export interface DayRow { day: string; tenant_id?: string; visits: number; seconds: number; requests: number; bytes: number; users: number }
export interface ChangeDay { day: string; tenant_id?: string; changes: number; users: number }
export interface PageRow { tenant_id?: string; page: string; visits: number; seconds: number; requests: number; bytes: number; users: number }
export interface AiRow { tenant_id?: string; model: string; feature: string; calls: number; tin: number; tout: number }
export interface StorageDay { day: string; tenant_id?: string; db_bytes: number | null; file_bytes: number | null }
export interface Dashboard {
  generated_at: string; days: number; since: string; snapshot_day: string | null;
  db_bytes: number; file_bytes: number; file_count: number; auth_users: number; mau: number;
  settings: Partial<CostSettings>;
  tenants: DashTenant[];
  unassigned: { db_rows: number; db_bytes: number; file_count: number; file_bytes: number } | null;
  daily: DayRow[]; changes_daily: ChangeDay[]; pages: PageRow[]; ai: AiRow[];
  storage_history: StorageDay[]; tables_top: { name: string; rows: number; bytes: number }[];
}
export interface TenantUserRow {
  id: string; email: string | null; first_name: string | null; last_name: string | null;
  role: string | null; job_title: string | null; department: string | null;
  active: boolean; is_superadmin: boolean; created_at: string | null; last_sign_in_at: string | null; confirmed: boolean;
  visits: number; seconds: number; requests: number; bytes: number; last_seen: string | null; top_page: string | null;
  ai_calls: number; ai_in: number; ai_out: number; changes: number;
}
export interface TenantDetail {
  tenant: Tenant | null; days: number; since: string; snapshot_day: string | null;
  users: TenantUserRow[]; pages: PageRow[]; user_pages: { user_id: string; page: string; seconds: number; visits: number }[];
  daily: DayRow[]; changes: { entity: string; action: string; n: number; users: number }[]; changes_daily: ChangeDay[];
  tables: { name: string; rows: number; bytes: number }[]; files: { bucket: string; count: number; bytes: number }[];
  storage_history: StorageDay[]; ai: AiRow[];
}

const rpcOrThrow = async <T,>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(/function .* does not exist|Could not find the function/i.test(error.message)
    ? "The console's database functions aren't installed yet (run sql/86_platform_admin.sql)." : error.message);
  return data as T;
};
export const loadDashboard = (days: number) => rpcOrThrow<Dashboard>("sa_dashboard", { p_days: days });
export const loadTenantDetail = (id: string, days: number) => rpcOrThrow<TenantDetail>("sa_tenant", { p_tenant: id, p_days: days });
export const refreshUsage = () => rpcOrThrow<{ tables: number; day: string; ms: number }>("sa_refresh_usage", {});
export async function saveCostSettings(c: CostSettings): Promise<string | null> {
  const { error } = await supabase.from("platform_settings").upsert({ id: 1, costs: c, updated_at: new Date().toISOString() });
  return error ? error.message : null;
}

/* ---------- real costs, from the providers' APIs (sql/87_platform_costs.sql) ---------- */
export type Provider = "supabase" | "anthropic" | "vercel" | "resend";
export interface CostSource { provider: Provider; status: "ok" | "error" | "missing"; message: string | null; synced_at: string | null; monthly: Record<string, any> }
export interface CostDay { day: string; provider: Provider; item: string; amount_usd: number; quantity: number | null; unit: string | null }
export interface CostsData { since: string; sources: CostSource[]; daily: CostDay[] }
export const loadCosts = (days: number) => rpcOrThrow<CostsData>("sa_costs", { p_days: days });
/** asks every provider for its real numbers (manage-tenants → sync_costs) */
export const syncCosts = () => call("sync_costs").then((r) => { if (r?.error) throw new Error(r.error); return (r.sources ?? []) as CostSource[]; });
/** stale after 6 hours: the console refreshes it by itself */
export const costsStale = (k: CostsData | null) => !k || !k.sources.length || k.sources.some((s) => !s.synced_at || Date.now() - new Date(s.synced_at).getTime() > 6 * 3600e3);

/* ---------- the cost model ---------- */
export type Allocation = "usage" | "storage" | "activity" | "seats" | "equal";
/** the only thing not in any API: what each company pays you (optional), and how shared costs are split */
export interface CostSettings { currency: string; allocation: Allocation; revenue: Record<string, number> }
export const DEFAULT_COSTS: CostSettings = { currency: "$", allocation: "usage", revenue: {} };
export const withDefaults = (s: Partial<CostSettings> | null | undefined): CostSettings => ({
  currency: "$",
  allocation: (["usage", "storage", "activity", "seats", "equal"] as Allocation[]).includes(s?.allocation as Allocation) ? (s!.allocation as Allocation) : "usage",
  revenue: { ...(s?.revenue ?? {}) },
});

/** Supabase's published usage prices (Pro / Team): applied to what the database measures */
export const SUPABASE_UNITS = { db_included_gb: 8, db_gb: 0.125, file_included_gb: 100, file_gb: 0.021, egress_included_gb: 250, egress_gb: 0.09, mau_included: 100000, mau: 0.00325 };
/** Claude list prices per million tokens, only used until the Anthropic Cost API is connected */
const AI_LIST: { prefix: string; input: number; output: number }[] = [
  { prefix: "claude-sonnet", input: 2, output: 10 }, { prefix: "claude-haiku", input: 0.1, output: 0.5 }, { prefix: "claude-opus", input: 5, output: 25 },
];
export const aiCost = (model: string, tin: number, tout: number) => {
  const p = AI_LIST.find((x) => model.startsWith(x.prefix)) ?? AI_LIST[0];
  return (tin * p.input + tout * p.output) / 1e6;
};

const GB = 1024 ** 3;
export type CostOrigin = "live" | "measured" | "estimate" | "missing";
export interface CostLine { key: string; label: string; amount: number; kind: "fixed" | "usage" | "ai"; detail: string; origin: CostOrigin; provider?: Provider }
export interface TenantCost {
  id: string; name: string; weight: number;
  fixed: number; db: number; files: number; egress: number; mau: number; ai: number; total: number;
  revenue: number | null; margin: number | null; perUser: number;
}
export interface CostModel {
  monthFactor: number; lines: CostLine[]; total: number; fixed: number; usage: number; ai: number;
  tenants: TenantCost[]; byId: Map<string, TenantCost>;
  egressMonthBytes: number; activityBasis: "time" | "changes" | "seats"; missing: Provider[];
}

const share = (vals: Map<string, number>) => {
  const sum = [...vals.values()].reduce((a, b) => a + b, 0);
  const out = new Map<string, number>();
  vals.forEach((v, k) => out.set(k, sum > 0 ? v / sum : 0));
  return out;
};

/**
 * One month of running the platform. Every amount comes from somewhere real:
 *  - live: the provider's own API (Supabase plan + compute, Anthropic costs, Vercel charges, Resend sends);
 *  - measured: what the database measures (size, files, users, transfer) at Supabase's published prices;
 *  - estimate: only while a provider isn't connected (list prices).
 * Shared costs are split between companies by the chosen key; AI by who used it.
 */
export function computeCosts(d: Dashboard, c: CostSettings, k: CostsData | null): CostModel {
  const monthFactor = 30 / Math.max(1, d.days);
  const T = d.tenants;
  const ids = T.map((t) => t.id);
  const src = (p: Provider) => k?.sources.find((s) => s.provider === p && s.status === "ok") ?? null;
  const daily = (p: Provider) => (k?.daily ?? []).filter((r) => r.provider === p).reduce((a, r) => a + Number(r.amount_usd || 0), 0);
  const missing = (["supabase", "anthropic", "vercel", "resend"] as Provider[]).filter((p) => !src(p));
  const U = SUPABASE_UNITS;

  // Supabase
  const sb = src("supabase");
  const plan = String(sb?.monthly?.plan ?? "pro");
  const free = plan === "free";
  const sbAmount = sb ? Number(sb.monthly.this_project_usd) || 0 : 25;
  const projects = (sb?.monthly?.projects ?? []) as { ref: string; name: string; compute: string }[];
  const ref = (() => { try { return new URL(import.meta.env.VITE_SUPABASE_URL as string).hostname.split(".")[0]; } catch { return ""; } })();
  const me = projects.find((p) => p.ref === ref) ?? null;
  const dbGb = d.db_bytes / GB, fileGb = d.file_bytes / GB;
  const egressMonthBytes = T.reduce((a, t) => a + t.bytes, 0) * monthFactor;
  const egressGb = egressMonthBytes / GB;
  const dbOver = free ? 0 : Math.max(0, dbGb - U.db_included_gb) * U.db_gb;
  const fileOver = free ? 0 : Math.max(0, fileGb - U.file_included_gb) * U.file_gb;
  const egressOver = free ? 0 : Math.max(0, egressGb - U.egress_included_gb) * U.egress_gb;
  const mauOver = free ? 0 : Math.max(0, d.mau - U.mau_included) * U.mau;

  // AI: Anthropic's real bill when connected, else the logged tokens at list price
  const tokensBy = new Map<string, number>();
  let tokenCost = 0;
  d.ai.forEach((r) => {
    tokenCost += aiCost(r.model, r.tin, r.tout);
    if (r.tenant_id) tokensBy.set(r.tenant_id, (tokensBy.get(r.tenant_id) ?? 0) + r.tin + r.tout);
  });
  const an = src("anthropic");
  const aiTotal = an ? daily("anthropic") * monthFactor : tokenCost * monthFactor;

  const ve = src("vercel");
  const hosting = ve ? daily("vercel") * monthFactor : 0;
  const re = src("resend");
  const email = re ? Number(re.monthly.this_app_usd) || 0 : 0;

  const fmtGb = (g: number) => `${g < 1 ? (g * 1024).toFixed(0) + " MB" : g.toFixed(2) + " GB"}`;
  const lines: CostLine[] = [
    { key: "supabase", label: "Supabase plan & compute", amount: sbAmount, kind: "fixed", provider: "supabase", origin: sb ? "live" : "estimate",
      detail: sb ? `${plan} plan · ${projects.length} project${projects.length === 1 ? "" : "s"} in the org · this one on ${me?.compute ?? "its compute"}` : "Pro list price until the Supabase API is connected" },
    { key: "db", label: "Database over quota", amount: dbOver, kind: "usage", origin: "measured", detail: `${fmtGb(dbGb)} of ${U.db_included_gb} GB included` },
    { key: "files", label: "File storage over quota", amount: fileOver, kind: "usage", origin: "measured", detail: `${fmtGb(fileGb)} of ${U.file_included_gb} GB included` },
    { key: "egress", label: "Data transfer over quota", amount: egressOver, kind: "usage", origin: "measured", detail: `${fmtGb(egressGb)} / month of ${U.egress_included_gb} GB` },
    { key: "mau", label: "Monthly users over quota", amount: mauOver, kind: "usage", origin: "measured", detail: `${d.mau} of ${U.mau_included.toLocaleString()} included` },
    { key: "hosting", label: "Hosting (Vercel)", amount: hosting, kind: "fixed", provider: "vercel", origin: ve ? "live" : "missing", detail: ve ? (ve.message ?? "Vercel billing API") : "Not connected" },
    { key: "email", label: "E-mail (Resend)", amount: email, kind: "fixed", provider: "resend", origin: re ? "live" : "missing",
      detail: re ? `${re.monthly.ours_30d ?? 0} of ${re.monthly.emails_30d ?? 0} sends are this app's · plan ${c.currency}${re.monthly.plan_usd ?? 0}` : "Not connected" },
    { key: "ai", label: "AI (Claude)", amount: aiTotal, kind: "ai", provider: "anthropic", origin: an ? "live" : d.ai.length ? "estimate" : "missing",
      detail: an ? `Anthropic Cost API · ${an.message ?? ""}` : `${d.ai.reduce((a, r) => a + r.calls, 0)} logged calls at list price` },
  ];
  const fixed = sbAmount + hosting + email;
  const usage = dbOver + fileOver + egressOver + mauOver;

  // the keys
  const storageW = share(new Map(T.map((t) => [t.id, t.db_bytes + t.file_bytes])));
  const hasTime = T.some((t) => t.seconds > 0);
  const hasChanges = T.some((t) => t.changes > 0);
  const activityBasis: CostModel["activityBasis"] = hasTime ? "time" : hasChanges ? "changes" : "seats";
  const activityW = share(new Map(T.map((t) => [t.id, hasTime ? t.seconds : hasChanges ? t.changes : t.users])));
  const seatsW = share(new Map(T.map((t) => [t.id, t.users])));
  const equalW = new Map(ids.map((id) => [id, ids.length ? 1 / ids.length : 0]));
  const keyW = c.allocation === "storage" ? storageW : c.allocation === "activity" ? activityW
    : c.allocation === "seats" ? seatsW : c.allocation === "equal" ? equalW
    : new Map(ids.map((id) => [id, 0.5 * (storageW.get(id) ?? 0) + 0.5 * (activityW.get(id) ?? 0)]));
  const dbW = share(new Map(T.map((t) => [t.id, t.db_bytes])));
  const fileW = share(new Map(T.map((t) => [t.id, t.file_bytes])));
  const egressW = hasTime ? share(new Map(T.map((t) => [t.id, t.bytes]))) : keyW;
  const aiW = tokensBy.size ? share(new Map(ids.map((id) => [id, tokensBy.get(id) ?? 0]))) : keyW;

  const tenants: TenantCost[] = T.map((t) => {
    const f = fixed * (keyW.get(t.id) ?? 0);
    const db = dbOver * (dbW.get(t.id) ?? 0);
    const files = fileOver * (fileW.get(t.id) ?? 0);
    const egress = egressOver * (egressW.get(t.id) ?? 0);
    const mau = mauOver * (seatsW.get(t.id) ?? 0);
    const ai = aiTotal * (aiW.get(t.id) ?? 0);
    const total = f + db + files + egress + mau + ai;
    const rev = c.revenue[t.id];
    const revenue = typeof rev === "number" && rev > 0 ? rev : null;
    const people = Math.max(1, t.users - t.deactivated);
    return { id: t.id, name: t.name, weight: keyW.get(t.id) ?? 0, fixed: f, db, files, egress, mau, ai, total,
      revenue, margin: revenue == null ? null : revenue - total, perUser: total / people };
  });
  const total = fixed + usage + aiTotal;
  return { monthFactor, lines, total, fixed, usage, ai: aiTotal, tenants, byId: new Map(tenants.map((t) => [t.id, t])), egressMonthBytes, activityBasis, missing };
}

/** A company's monthly cost split over its people: AI where they used it, the rest by time in the app (or edits, or evenly). */
export function userCosts(tc: TenantCost | undefined, users: TenantUserRow[], ai: AiRow[] = []) {
  const out = new Map<string, number>();
  if (!tc) return out;
  const people = users.filter((u) => !u.is_superadmin);
  const base = tc.total - tc.ai;
  const hasTime = people.some((u) => u.seconds > 0);
  const hasChanges = people.some((u) => u.changes > 0);
  const weight = (u: TenantUserRow) => hasTime ? u.seconds : hasChanges ? u.changes : (u.active ? 1 : 0);
  const sum = people.reduce((a, u) => a + weight(u), 0) || 1;
  // a user's own AI: their tokens at the company's average price per token
  const tokens = ai.reduce((a, r) => a + r.tin + r.tout, 0);
  const aiRate = tokens > 0 ? tc.ai / tokens : 0;
  people.forEach((u) => out.set(u.id, base * (weight(u) / sum) + (u.ai_in + u.ai_out) * aiRate));
  return out;
}

/* ---------- formatting ---------- */
export const fmtBytes = (b: number) => {
  if (!b || b < 1) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const v = b / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};
export const fmtNum = (n: number) => {
  if (!isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return Math.round(n).toLocaleString("en-US");
};
export const fmtDur = (sec: number) => {
  if (!sec) return "0m";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h >= 100) return `${fmtNum(h)}h`;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${Math.max(1, m)}m`;
};
export const fmtMoney = (v: number, cur = "$", digits?: number) => {
  const d = digits ?? (Math.abs(v) < 10 ? 2 : 0);
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${v < 0 ? "−" : ""}${cur}${s}`;
};
export const fmtAgo = (iso: string | null | undefined) => {
  if (!iso) return "Never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "Just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
export const PAGE_LABELS: Record<string, string> = {
  home: "Home", sales: "Deals", companies: "Companies", contacts: "Contacts", clients: "Clients", projects: "Projects",
  success: "Customer success", marketing: "Marketing", calendar: "Calendar", tickets: "Tickets", management: "Management",
  settings: "Settings", reports: "Reports",
};
export const pageLabel = (p: string) => PAGE_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
/** every day from `since` to today, as YYYY-MM-DD */
export const dayList = (since: string, days: number) => {
  const out: string[] = [];
  const d0 = new Date(since);
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate() + i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};
