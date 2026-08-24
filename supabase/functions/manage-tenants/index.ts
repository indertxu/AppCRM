// Superadmin-only Edge Function: manage tenants (companies) and their users.
// Actions: list_tenants, create_tenant, update_tenant, toggle_tenant,
//          list_users, create_user, delete_user, set_password
//
// Uses the service role key to create auth users. Verifies the caller is a superadmin
// before doing anything.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Roles allowed by the profiles_role_check constraint. Anything outside this
// set (including an empty string) must fall back to the default.
const VALID_ROLES = [
  "consultant", "consultancy_manager", "customer_success",
  "customer_success_manager", "sales", "sales_manager", "boss",
];
const safeRole = (r: unknown) =>
  typeof r === "string" && VALID_ROLES.includes(r.trim()) ? r.trim() : "consultant";

async function callerIsSuperadmin(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!token) return false;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return false;
  const { data: prof } = await admin.from("profiles").select("is_superadmin").eq("id", data.user.id).maybeSingle();
  return !!prof?.is_superadmin;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!(await callerIsSuperadmin(req))) return json({ error: "Not authorized" }, 403);
    const { action, ...p } = await req.json();

    if (action === "list_tenants") {
      const { data: tenants } = await admin.from("tenants").select("*").order("created_at", { ascending: false });
      const { data: profs } = await admin.from("profiles").select("tenant_id");
      const counts: Record<string, number> = {};
      ((profs ?? []) as any[]).forEach((r) => { if (r.tenant_id) counts[r.tenant_id] = (counts[r.tenant_id] ?? 0) + 1; });
      return json({ tenants: (tenants ?? []).map((t: any) => ({ ...t, user_count: counts[t.id] ?? 0 })) });
    }

    if (action === "create_tenant") {
      const { name, maxUsers } = p;
      if (!name) return json({ error: "Name required" }, 400);
      const { data, error } = await admin.from("tenants").insert({ name, max_users: maxUsers ?? 5 }).select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ tenant: data });
    }

    if (action === "toggle_tenant") {
      const { tenantId, active } = p;
      const { error } = await admin.from("tenants").update({ active }).eq("id", tenantId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "update_tenant") {
      const { tenantId, name, maxUsers } = p;
      const patch: Record<string, unknown> = {};
      if (typeof name === "string" && name.trim()) patch.name = name.trim();
      if (typeof maxUsers === "number") {
        const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
        if (count != null && maxUsers < count)
          return json({ error: `Can't set the limit below the current ${count} users.` }, 400);
        patch.max_users = maxUsers;
      }
      if (Object.keys(patch).length === 0) return json({ error: "Nothing to update" }, 400);
      const { error } = await admin.from("tenants").update(patch).eq("id", tenantId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "list_users") {
      const { tenantId } = p;
      const { data } = await admin.from("profiles").select("id, role, job_title, is_superadmin").eq("tenant_id", tenantId);
      const profs = (data ?? []) as any[];
      const emailById: Record<string, string> = {};
      let page = 1;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data: list } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        const users = list?.users ?? [];
        users.forEach((u: any) => { emailById[u.id] = u.email ?? ""; });
        if (users.length < 200) break;
        page++;
        if (page > 25) break;
      }
      const withEmail = profs.map((u) => ({ ...u, email: emailById[u.id] ?? "" }));
      return json({ users: withEmail });
    }

    if (action === "create_user") {
      const { tenantId, email, password, role, jobTitle } = p;
      if (!tenantId || !email || !password) return json({ error: "tenantId, email and password required" }, 400);
      // enforce max_users
      const { data: tenant } = await admin.from("tenants").select("max_users").eq("id", tenantId).maybeSingle();
      const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
      if (tenant && count != null && count >= tenant.max_users)
        return json({ error: `User limit reached (${tenant.max_users}).` }, 400);
      // create the auth user (the on_auth_user_created trigger seeds a profile row)
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (cErr || !created.user) return json({ error: cErr?.message ?? "Could not create user" }, 400);
      // create/update their profile with tenant + role.
      // safeRole() guards against empty string / invalid values that would violate
      // the profiles_role_check constraint.
      const { error: pErr } = await admin.from("profiles").upsert({
        id: created.user.id,
        tenant_id: tenantId,
        role: safeRole(role),
        job_title: typeof jobTitle === "string" ? jobTitle : "",
        is_superadmin: false,
      });
      if (pErr) return json({ error: pErr.message }, 400);
      return json({ user: { id: created.user.id, email, role: safeRole(role) } });
    }

    if (action === "delete_user") {
      const { userId } = p;
      await admin.auth.admin.deleteUser(userId);
      await admin.from("profiles").delete().eq("id", userId);
      return json({ ok: true });
    }

    // Hard-reset one user's password. The caller is already known to be a
    // superadmin (checked above), so the only extra guard needed is refusing to
    // touch another superadmin's login.
    if (action === "set_password") {
      const { userId, password } = p;
      if (!userId || !password) return json({ error: "userId and password are required" }, 400);
      if (String(password).length < 6) return json({ error: "Password must be at least 6 characters" }, 400);

      const { data: target } = await admin
        .from("profiles").select("is_superadmin").eq("id", userId).maybeSingle();
      if (target?.is_superadmin) {
        return json({ error: "Cannot change a superadmin password from here" }, 403);
      }

      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});