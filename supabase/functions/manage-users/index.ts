import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const admin = createClient(URL, SERVICE);
    const asUser = createClient(URL, ANON, { global: { headers: { Authorization: authHeader } } });

    const { data: u } = await asUser.auth.getUser();
    if (!u?.user) return json({ error: "Unauthorized" }, 401);
    const { data: caller } = await admin.from("profiles").select("role, department, tenant_id").eq("id", u.user.id).single();
    if (!caller) return json({ error: "No profile" }, 403);

    const isBoss = caller.role === "boss";
    const MANAGER_ROLES = ["consultancy_manager", "sales_manager", "customer_success", "customer_success_manager", "it_manager", "marketing_manager", "hr_manager"];
    const isManager = MANAGER_ROLES.includes(caller.role);

    const canTouch = async (targetId: string) => {
      if (isBoss) return true;
      if (!isManager) return false;
      const { data: t } = await admin.from("profiles").select("department").eq("id", targetId).single();
      return t?.department === caller.department;
    };

    const body = await req.json();

    if (body.action === "list") {
      let q = admin.from("profiles").select(
"id, first_name, last_name, email, phone, role, job_title, department, username, start_date, birthday, yearly_wage, social_security, bank_account"
      );
      // ALWAYS scope to the caller's tenant, otherwise a boss would see every
      // company's people across the whole platform (cross-tenant leak).
      if (caller.tenant_id) q = q.eq("tenant_id", caller.tenant_id);
      if (isBoss) { /* all within the tenant */ }
      else if (isManager) q = q.eq("department", caller.department);
      else q = q.eq("id", u.user.id);
      const { data, error } = await q.order("first_name");
      if (error) return json({ error: error.message }, 400);
      return json({ users: data });
    }

    if (body.action === "create") {
      const p = body.user;
      // Managers can only create people for their own department; the boss anyone.
      // (Role/department assignment now happens in the Organization map, so we don't
      //  derive them here anymore.)
      if (!isBoss && !isManager) return json({ error: "You can't create users." }, 403);

      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email: p.email, password: p.password, email_confirm: true,
        user_metadata: { username: p.username },
      });
      if (cErr || !created?.user) return json({ error: "createUser: " + (cErr?.message ?? "unknown") }, 400);

      // Managers: new hires land in the manager's department by default.
      const department = isManager ? caller.department : null;

      const { error: uErr } = await admin.from("profiles").update({
        first_name: p.first_name, last_name: p.last_name, phone: p.phone, email: p.email,
        yearly_wage: p.yearly_wage, start_date: p.start_date || null, birthday: p.birthday || null,
        job_title: p.job_title, department, username: p.username,
        social_security: p.social_security, bank_account: p.bank_account,
        tenant_id: caller.tenant_id,
      }).eq("id", created.user.id);
      if (uErr) return json({ error: "profileUpdate: " + uErr.message }, 400);
      return json({ ok: true, id: created.user.id });
    }

    if (body.action === "update") {
      if (!(await canTouch(body.id))) return json({ error: "Not allowed." }, 403);
      const f = body.fields ?? {};
      const patch: Record<string, unknown> = {
        first_name: f.first_name, last_name: f.last_name, phone: f.phone, email: f.email,
        yearly_wage: f.yearly_wage, start_date: f.start_date || null, birthday: f.birthday || null,
   job_title: f.job_title,
        social_security: f.social_security, bank_account: f.bank_account,
      };
      if (isBoss && f.role) { patch.role = f.role; }
      const { error } = await admin.from("profiles").update(patch).eq("id", body.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (body.action === "reset_password") {
      if (!(await canTouch(body.id))) return json({ error: "Not allowed." }, 403);
      if (!body.password || body.password.length < 6) return json({ error: "Password too short." }, 400);
      const { error } = await admin.auth.admin.updateUserById(body.id, { password: body.password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (body.action === "delete") {
      if (!(await canTouch(body.id))) return json({ error: "Not allowed." }, 403);
      // remove auth user, then profile row
      await admin.auth.admin.deleteUser(body.id).catch(() => {});
      const { error } = await admin.from("profiles").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});