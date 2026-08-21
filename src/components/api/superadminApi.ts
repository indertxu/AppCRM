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
}

export const listTenants = () => call("list_tenants").then((r) => (r.tenants ?? []) as Tenant[]);
export const createTenant = (name: string, maxUsers: number) => call("create_tenant", { name, maxUsers });
export const toggleTenant = (tenantId: string, active: boolean) => call("toggle_tenant", { tenantId, active });
export const updateTenant = (tenantId: string, patch: { name?: string; maxUsers?: number }) =>
  call("update_tenant", { tenantId, ...patch });
export const listUsers = (tenantId: string) => call("list_users", { tenantId }).then((r) => (r.users ?? []) as TenantUser[]);
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