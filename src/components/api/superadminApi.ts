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