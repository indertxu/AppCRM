// Superadmin-only Edge Function: manage tenants (companies) and their users.
// Actions: list_tenants, create_tenant, update_tenant, toggle_tenant,
//          list_users, create_user, delete_user, set_password,
//          sync_costs (real costs from the providers' APIs → platform_cost_* tables)
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

/* =====================================================================
   sync_costs — what the platform really costs, from each provider's API.
   Keys live as Edge Function secrets (Supabase → Edge Functions → Secrets):
     SB_MANAGEMENT_TOKEN        personal access token (supabase.com/dashboard/account/tokens)
                                (Supabase reserves the SUPABASE_ prefix; SUPABASE-MANAGEMENT_TOKEN also works)
     ANTHROPIC_ADMIN_KEY        Admin API key, sk-ant-admin… (console.anthropic.com → Settings → Admin keys)
       ANTHROPIC_WORKSPACE_ID   optional: only this workspace's costs
     VERCEL_TOKEN               access token (vercel.com/account/tokens)
       VERCEL_TEAM_ID           optional: the team that owns the project
       VERCEL_PROJECT           optional: only this project's charges (plus team-wide ones)
     RESEND_API_KEY             full-access key (Resend has no billing API: sends are counted)
   ===================================================================== */
type Source = { provider: string; status: "ok" | "error" | "missing"; message: string; monthly: Record<string, unknown> };
type CostRow = { day: string; provider: string; item: string; amount_usd: number; quantity?: number | null; unit?: string | null };
const PROJECT_REF = Deno.env.get("SUPABASE_PROJECT_REF") ?? new URL(Deno.env.get("SUPABASE_URL")!).hostname.split(".")[0];
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d; };
const getJson = async (url: string, headers: Record<string, string>) => {
  const r = await fetch(url, { headers });
  const t = await r.text();
  if (!r.ok) throw new Error(`${new URL(url).host}${new URL(url).pathname} → ${r.status} ${t.slice(0, 180)}`);
  return t ? JSON.parse(t) : null;
};

/** Supabase list prices that the API doesn't return (the plan fee itself) */
const PLAN_PRICE: Record<string, number> = { free: 0, pro: 25, team: 599 };
const COMPUTE_CREDITS: Record<string, number> = { pro: 10, team: 10 };
/** an add-on variant's monthly price, whatever shape the API gives it in */
const monthlyOf = (v: any): number => {
  if (!v) return 0;
  const p = v.price;
  const amount = typeof p === "number" ? p : Number(p?.amount ?? v.price_amount ?? 0) || 0;
  const interval = String((typeof p === "object" && p ? p.interval : v.price_interval) ?? "monthly");
  return /hour/i.test(interval) ? amount * 730 : amount;
};

async function syncSupabase(): Promise<{ src: Source; rows: CostRow[] }> {
  const tok = Deno.env.get("SB_MANAGEMENT_TOKEN") ?? Deno.env.get("SUPABASE-MANAGEMENT_TOKEN") ?? Deno.env.get("MANAGEMENT_TOKEN") ?? Deno.env.get("SUPABASE_MANAGEMENT_TOKEN");
  const base = { provider: "supabase", monthly: {} };
  if (!tok) return { src: { ...base, status: "missing", message: "Add the SB_MANAGEMENT_TOKEN secret (a personal access token)." }, rows: [] };
  const H = { Authorization: `Bearer ${tok}` };
  const api = (path: string) => getJson(`https://api.supabase.com${path}`, H);
  const me = await api(`/v1/projects/${PROJECT_REF}`);
  const orgKey = me.organization_slug ?? me.organization_id;
  // the plan lives on the organization; a token without organization access can still read the projects
  let org: any = null, planNote = "";
  try { org = await api(`/v1/organizations/${orgKey}`); } catch (e) {
    planNote = /403|forbidden/i.test(String((e as Error).message)) ? "the token can't read the organization, so the plan is assumed Pro" : `organization: ${String((e as Error).message).slice(0, 100)}`;
  }
  const plan = String(org?.plan ?? org?.billing?.plan ?? (planNote ? "pro" : "")).toLowerCase();
  const all = ((await api(`/v1/projects`)) ?? []) as any[];
  const inOrg = all.filter((p) => p.organization_id === me.organization_id || (p.organization_slug && p.organization_slug === me.organization_slug));
  const live = inOrg.filter((p) => !/PAUSED|INACTIVE|REMOVED|GOING_DOWN/i.test(String(p.status ?? "")));
  const projects: { ref: string; name: string; compute: string; computeUsd: number; addonsUsd: number; note?: string }[] = [];
  for (const p of live) {
    const ref = p.ref ?? p.id;
    let compute = "", computeUsd = 0, addonsUsd = 0, note: string | undefined;
    try {
      const a = await api(`/v1/projects/${ref}/billing/addons`);
      for (const s of (a?.selected_addons ?? []) as any[]) {
        const m = monthlyOf(s.variant);
        if (/compute/i.test(String(s.type))) { computeUsd += m; compute = s.variant?.name ?? s.variant?.id ?? "compute"; }
        else addonsUsd += m;
      }
    } catch (e) { note = String((e as Error).message).slice(0, 120); }
    // no compute add-on listed = the default Micro instance
    if (!compute) { compute = "Micro (default)"; computeUsd = 0.01344 * 730; }
    projects.push({ ref, name: p.name, compute, computeUsd, addonsUsd, note });
  }
  const planUsd = PLAN_PRICE[plan] ?? 0;
  const credits = COMPUTE_CREDITS[plan] ?? 0;
  const computeTotal = projects.reduce((a, p) => a + p.computeUsd + p.addonsUsd, 0);
  const orgTotal = planUsd + Math.max(0, computeTotal - credits);
  const mine = projects.find((p) => p.ref === PROJECT_REF);
  const mineCompute = mine ? mine.computeUsd + mine.addonsUsd : 0;
  // this app's share: an even slice of the plan + its own compute, less its slice of the credits
  const thisProject = (live.length ? planUsd / live.length : planUsd) + Math.max(0, mineCompute - (computeTotal ? credits * (mineCompute / computeTotal) : 0));
  return {
    src: { ...base, status: "ok", message: `${plan || "unknown"} plan · ${live.length} active project${live.length === 1 ? "" : "s"} in the organization${planNote ? ` (${planNote})` : ""}${projects.some((x) => x.note) ? ` · compute add-ons not readable for ${projects.filter((x) => x.note).length} project(s), assumed Micro: ${projects.find((x) => x.note)?.note}` : ""}`,
      monthly: { plan, plan_assumed: !!planNote, plan_usd: planUsd, credits_usd: credits, projects, org_total_usd: orgTotal, this_project_usd: thisProject, org_name: org?.name ?? null } },
    rows: [],
  };
}

async function syncAnthropic(): Promise<{ src: Source; rows: CostRow[] }> {
  const key = Deno.env.get("ANTHROPIC_ADMIN_KEY");
  const ws = Deno.env.get("ANTHROPIC_WORKSPACE_ID") ?? "";
  const base = { provider: "anthropic", monthly: {} };
  if (!key) return { src: { ...base, status: "missing", message: "Add the ANTHROPIC_ADMIN_KEY secret (an Admin API key, sk-ant-admin…)." }, rows: [] };
  const H = { "x-api-key": key, "anthropic-version": "2023-06-01", "User-Agent": "NextManagement/1.0" };
  const acc = new Map<string, number>();
  let page: string | null = null, guard = 0;
  do {
    const u = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    u.searchParams.set("starting_at", daysAgo(30).toISOString());
    u.searchParams.set("ending_at", daysAgo(-1).toISOString());
    u.searchParams.append("group_by[]", "description");
    if (ws) u.searchParams.append("group_by[]", "workspace_id");
    u.searchParams.set("limit", "31");
    if (page) u.searchParams.set("page", page);
    const r = await getJson(u.toString(), H);
    for (const b of (r?.data ?? []) as any[]) {
      const day = String(b.starting_at ?? "").slice(0, 10);
      for (const x of (b.results ?? []) as any[]) {
        if (ws && x.workspace_id && x.workspace_id !== ws) continue;
        const usd = (Number(x.amount) || 0) / 100; // decimal string, in cents
        const item = String(x.model ?? x.description ?? x.cost_type ?? "Claude");
        acc.set(`${day}|${item}`, (acc.get(`${day}|${item}`) ?? 0) + usd);
      }
    }
    page = r?.has_more ? r.next_page : null;
  } while (page && ++guard < 10);
  const rows: CostRow[] = [...acc].map(([k, v]) => { const [day, item] = k.split("|"); return { day, provider: "anthropic", item, amount_usd: v }; });
  const total = rows.reduce((a, r) => a + r.amount_usd, 0);
  return { src: { ...base, status: "ok", message: `${rows.length ? `$${total.toFixed(2)} in the last 31 days` : "No Claude costs in the last 31 days"}${ws ? " (one workspace)" : " (whole organization)"}`, monthly: { last31_usd: total } }, rows };
}

async function syncVercel(): Promise<{ src: Source; rows: CostRow[] }> {
  const tok = Deno.env.get("VERCEL_TOKEN");
  const team = Deno.env.get("VERCEL_TEAM_ID") ?? "";
  const project = Deno.env.get("VERCEL_PROJECT") ?? "";
  const base = { provider: "vercel", monthly: {} };
  if (!tok) return { src: { ...base, status: "missing", message: "Add the VERCEL_TOKEN secret (and VERCEL_TEAM_ID if the project is in a team)." }, rows: [] };
  const u = new URL("https://api.vercel.com/v1/billing/charges");
  u.searchParams.set("from", daysAgo(30).toISOString());
  u.searchParams.set("to", daysAgo(-1).toISOString());
  if (team) u.searchParams.set("teamId", team);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`api.vercel.com/v1/billing/charges → ${r.status} ${t.slice(0, 180)}`);
  const acc = new Map<string, { usd: number; qty: number; unit: string }>();
  for (const line of t.split("\n")) {
    if (!line.trim()) continue;
    let c: any; try { c = JSON.parse(line); } catch { continue; }
    const proj = c.Tags?.ProjectName ?? "";
    if (project && proj && proj !== project) continue;
    const day = String(c.ChargePeriodStart ?? "").slice(0, 10);
    const item = `${c.ServiceName ?? "Vercel"}${proj ? ` · ${proj}` : ""}`;
    const k = `${day}|${item}`;
    const cur = acc.get(k) ?? { usd: 0, qty: 0, unit: String(c.ConsumedUnit ?? "") };
    cur.usd += Number(c.BilledCost) || 0; cur.qty += Number(c.ConsumedQuantity) || 0;
    acc.set(k, cur);
  }
  const rows: CostRow[] = [...acc].map(([k, v]) => { const [day, item] = k.split("|"); return { day, provider: "vercel", item, amount_usd: v.usd, quantity: v.qty, unit: v.unit || null }; });
  const total = rows.reduce((a, r) => a + r.amount_usd, 0);
  return { src: { ...base, status: "ok", message: `$${total.toFixed(2)} billed in the last 31 days${project ? ` (${project})` : ""}`, monthly: { last31_usd: total } }, rows };
}

async function syncResend(): Promise<{ src: Source; rows: CostRow[] }> {
  const key = Deno.env.get("RESEND_API_KEY");
  const base = { provider: "resend", monthly: {} };
  if (!key) return { src: { ...base, status: "missing", message: "Add the RESEND_API_KEY secret (a full-access key)." }, rows: [] };
  const H = { Authorization: `Bearer ${key}` };
  const since = daysAgo(30).getTime();
  const perDay = new Map<string, { all: number; ours: number }>();
  let after = "", total = 0, ours = 0, pages = 0, more = true;
  while (more && pages < 50) {
    const r = await getJson(`https://api.resend.com/emails?limit=100${after ? `&after=${after}` : ""}`, H);
    const list = (r?.data ?? []) as any[];
    pages++;
    for (const e of list) {
      const at = new Date(e.created_at).getTime();
      if (at < since) { more = false; break; }
      const mine = /next/i.test(String(e.from ?? "")) || /reset your password/i.test(String(e.subject ?? ""));
      total++; if (mine) ours++;
      const day = isoDay(new Date(at));
      const d = perDay.get(day) ?? { all: 0, ours: 0 };
      d.all++; if (mine) d.ours++;
      perDay.set(day, d);
    }
    more = more && !!r?.has_more && list.length > 0;
    after = list.length ? list[list.length - 1].id : "";
  }
  // Resend's plans by monthly volume (no billing API): Free ≤3k, Pro ≤50k, then ≤100k, then Scale
  const tier = total <= 3000 ? 0 : total <= 50000 ? 20 : total <= 100000 ? 35 : 90;
  const thisApp = total ? tier * (ours / total) : 0;
  const rows: CostRow[] = [...perDay].map(([day, v]) => ({ day, provider: "resend", item: "E-mails sent", amount_usd: 0, quantity: v.ours, unit: "emails" }));
  return { src: { ...base, status: "ok", message: `${ours} of ${total} e-mails in 30 days are this app's`, monthly: { emails_30d: total, ours_30d: ours, plan_usd: tier, this_app_usd: thisApp } }, rows };
}

async function syncCosts() {
  const runs: [string, () => Promise<{ src: Source; rows: CostRow[] }>][] = [
    ["supabase", syncSupabase], ["anthropic", syncAnthropic], ["vercel", syncVercel], ["resend", syncResend],
  ];
  const out: Source[] = [];
  for (const [provider, fn] of runs) {
    let res: { src: Source; rows: CostRow[] };
    try { res = await fn(); } catch (e) {
      res = { src: { provider, status: "error", message: String((e as Error).message ?? e).slice(0, 400), monthly: {} }, rows: [] };
    }
    const now = new Date().toISOString();
    if (res.src.status === "ok") {
      // replace the window this provider just reported
      await admin.from("platform_cost_daily").delete().eq("provider", provider).gte("day", isoDay(daysAgo(31)));
      if (res.rows.length) await admin.from("platform_cost_daily").upsert(res.rows);
    }
    await admin.from("platform_cost_sources").upsert({ provider, status: res.src.status, message: res.src.message, monthly: res.src.monthly, synced_at: now });
    out.push(res.src);
  }
  return out;
}

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
      const { data } = await admin.from("profiles").select("id, role, job_title, is_superadmin, first_name, last_name").eq("tenant_id", tenantId);
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

    if (action === "sync_costs") {
      return json({ sources: await syncCosts() });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});