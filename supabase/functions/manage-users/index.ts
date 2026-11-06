import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

/* =====================================================================
   CRM import API  —  /functions/v1/manage-users/api/crm/...   (111_crm_import_api.sql)
   Keys with scope 'crm' (Settings › APIs). access 'form' may only POST /crm/leads
   (safe in a website form); 'write' may also POST /crm/companies and /crm/contacts.
     GET  /crm/fields      the fields it fills (standard + your own), and the form shortcuts
     POST /crm/leads       { first_name, last_name, email, company, …, employees, entities, erps, interests }
                           finds or creates the company (by name, then by e-mail domain) and the contact
                           (by e-mail), links them, fills the fields, notes the request
     POST /crm/companies   one company       POST /crm/contacts   one contact (optionally with "company")
   ===================================================================== */
const FREE_MAIL = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|gmx|proton|protonmail|yandex|mail|zoho|terra|telefonica)\./i;
/** form shortcuts → your own fields (created the first time they're used) */
const SHORTCUTS: Record<string, { on: "company" | "contact"; label: string; type: "select" | "multiselect" }> = {
  employees: { on: "company", label: "Employees", type: "select" },
  entities: { on: "company", label: "Legal entities", type: "select" },
  erps: { on: "company", label: "ERPs", type: "multiselect" },
  interests: { on: "contact", label: "Interested in", type: "multiselect" },
};
const STD_COMPANY = ["name", "legal_name", "vat_number", "website", "phone", "email", "street", "addr_number", "postal_code", "city", "province", "country", "sector", "linkedin"];
const STD_CONTACT = ["first_name", "last_name", "email", "phone", "position", "city", "country", "language", "linkedin"];
const clean = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : String(v).split(/\s*[;,]\s*/)).map((x) => String(x).trim()).filter(Boolean);

async function handleCrm(admin: any, tenant: string, key: any, m: string, seg: string[], req: Request): Promise<Response> {
  const what = seg[1] ?? "";
  const cfg = (key.settings ?? {}) as {
    source?: string; tags?: string[]; assign_to?: string[]; origins?: string[];
    /** a form built in Settings › APIs: what each of its fields is sent as and where it lands
     *  to = contact.<column> | company.<column> | contact.custom.<field id> | company.custom.<field id> | note */
    fields?: { name: string; label?: string; to?: string; required?: boolean }[];
  };
  const loadFields = async () => {
    const [co, ct] = await Promise.all([
      admin.from("company_fields").select("id, label, type, options, sort").eq("tenant_id", tenant).order("sort"),
      admin.from("contact_fields").select("id, label, type, options, sort").eq("tenant_id", tenant).order("sort"),
    ]);
    return { company: (co.data ?? []) as any[], contact: (ct.data ?? []) as any[] };
  };
  if (m === "GET" && what === "fields") {
    const f = await loadFields();
    const out = (xs: any[]) => xs.map((x) => ({ id: x.id, label: x.label, type: x.type, options: Array.isArray(x.options) ? x.options : [] }));
    return json({
      standard: { company: STD_COMPANY, contact: STD_CONTACT },
      custom: { company: out(f.company), contact: out(f.contact) },
      shortcuts: Object.fromEntries(Object.entries(SHORTCUTS).map(([k, v]) => [k, { goes_to: v.on, field: v.label, type: v.type }])),
    });
  }
  if (m !== "POST" || !["leads", "companies", "contacts"].includes(what)) return json({ error: "Unknown endpoint. See Settings › APIs." }, 404);
  if (key.access === "form" && what !== "leads") return json({ error: "A website form key may only add leads (POST /crm/leads)." }, 403);
  const origin = req.headers.get("origin");
  if (origin && Array.isArray(cfg.origins) && cfg.origins.length && !cfg.origins.some((o) => o && origin.toLowerCase().startsWith(String(o).toLowerCase().replace(/\/+$/, "")))) {
    return json({ error: "This key doesn't accept requests from this website." }, 403);
  }
  const ct = req.headers.get("content-type") ?? "";
  let b: Record<string, any> = ct.includes("application/json") ? await req.json().catch(() => ({}))
    : Object.fromEntries([...(await req.formData().catch(() => new FormData())).entries()].map(([k, v]) => [k, String(v)]));
  // a hidden "honeypot" field a person never fills: bots get an OK and nothing is saved
  if (clean(b._hp) || clean(b.website_url)) return json({ ok: true }, 201);

  // a form built in Settings › APIs: its own field names → the fields they fill
  const mapped = what === "leads" && Array.isArray(cfg.fields) && cfg.fields.length > 0;
  const answers: string[] = [];
  if (mapped) {
    const nb: Record<string, any> = { company_fields: {}, contact_fields: {}, company_details: {}, request_type: b.request_type, page: b.page, utm: b.utm, source: b.source, message: "" };
    const missing: string[] = [];
    for (const f of cfg.fields!) {
      const raw = b[f.name];
      const label = clean(f.label) || f.name;
      if (raw == null || (Array.isArray(raw) ? !raw.length : !clean(raw))) { if (f.required) missing.push(label); continue; }
      const val = Array.isArray(raw) ? raw.map(clean).filter(Boolean) : clean(raw);
      const text = Array.isArray(val) ? val.join(", ") : String(val);
      const to = String(f.to ?? "note");
      if (to.startsWith("contact.custom.")) { nb.contact_fields[to.slice(15)] = val; answers.push(`${label}: ${text}`); }
      else if (to.startsWith("company.custom.")) { nb.company_fields[to.slice(15)] = val; answers.push(`${label}: ${text}`); }
      else if (to === "company.name") nb.company = text;
      else if (to.startsWith("company.")) nb.company_details[to.slice(8)] = text;
      else if (to.startsWith("contact.")) nb[to.slice(8)] = text;
      else nb.message = [nb.message, `${label}: ${text}`].filter(Boolean).join(" · ");
    }
    if (missing.length) return json({ error: `Fill in: ${missing.join(", ")}.`, missing }, 400);
    b = nb;
  }

  const fields = await loadFields();
  /** your own field by label (or id); a shortcut's field is made the first time; new choices are added to its options */
  const fieldFor = async (on: "company" | "contact", labelOrId: string, type: string | null, vals: string[]) => {
    const table = on === "company" ? "company_fields" : "contact_fields";
    const xs = fields[on];
    let f = xs.find((x) => x.id === labelOrId || String(x.label).trim().toLowerCase() === labelOrId.trim().toLowerCase());
    if (!f) {
      if (!type) return null;
      const { data } = await admin.from(table).insert({ tenant_id: tenant, label: labelOrId, type, required: false, options: vals, sort: xs.length }).select("id, label, type, options, sort").single();
      if (!data) return null;
      xs.push(data); f = data;
    } else if ((f.type === "select" || f.type === "multiselect") && vals.length) {
      const opts: string[] = Array.isArray(f.options) ? f.options : [];
      const add = vals.filter((v) => !opts.some((o) => o.toLowerCase() === v.toLowerCase()));
      if (add.length) { f.options = [...opts, ...add]; await admin.from(table).update({ options: f.options }).eq("id", f.id); }
    }
    return f;
  };
  /** { fieldId: value } from shortcuts and from company_fields / contact_fields (by label or id) */
  const customFor = async (on: "company" | "contact", src: Record<string, any>, given: Record<string, any> | undefined) => {
    const out: Record<string, any> = {};
    const put = async (label: string, type: string | null, raw: unknown) => {
      const known = fields[on].find((x) => x.id === label || String(x.label).trim().toLowerCase() === label.trim().toLowerCase());
      const multi = (type ?? known?.type) === "multiselect" || Array.isArray(raw);
      const vals = multi ? listOf(raw) : [clean(raw)].filter(Boolean);
      if (!vals.length) return;
      const f = await fieldFor(on, label, type, vals);
      if (!f) return;
      out[f.id] = f.type === "multiselect" ? vals : f.type === "number" ? Number(vals[0]) : f.type === "boolean" ? /^(1|true|yes|s[ií])$/i.test(vals[0]) : vals.join(", ");
    };
    for (const [k, sc] of Object.entries(SHORTCUTS)) if (sc.on === on && src[k] != null) await put(sc.label, sc.type, src[k]);
    for (const [label, v] of Object.entries(given ?? {})) await put(label, null, v);
    return out;
  };
  const mergeCustom = (old: Record<string, any> | null, add: Record<string, any>, kinds: any[]) => {
    const res = { ...(old ?? {}) };
    for (const [id, v] of Object.entries(add)) {
      const f = kinds.find((x) => x.id === id);
      res[id] = f?.type === "multiselect" ? [...new Set([...listOf(res[id]), ...listOf(v)])] : v;
    }
    return res;
  };
  const today = new Date().toISOString().slice(0, 16).replace("T", " ");
  const source = clean(b.source) || clean(cfg.source) || "Inbound / Website";
  const tags: string[] = [...new Set([...listOf(cfg.tags), ...listOf(b.tags)])];
  const assign: string[] = listOf(cfg.assign_to);

  // ---- the company
  let company: { id: string; created: boolean } | null = null;
  const coSrc: Record<string, any> = what === "companies" ? b
    : mapped ? { ...b.company_details, name: b.company }
    : { ...(b.company_details ?? {}), ...b, name: b.company ?? b.company_name ?? b.name_company };
  const coName = clean(what === "companies" ? b.name : coSrc.name);
  const email = clean(b.email).toLowerCase();
  const domain = clean(coSrc.website).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase()
    || (email.includes("@") && !FREE_MAIL.test(email.split("@")[1]) ? email.split("@")[1] : "");
  // a form of your own may leave the company out; the old fixed form and /companies need it
  if (what === "companies" || coName || (what === "leads" && !mapped)) {
    if (!coName) return json({ error: "Add the company name (\"company\")." }, 400);
    const coCustom = await customFor("company", what === "companies" ? b : { ...b, ...(b.company_details ?? {}) }, b.company_fields);
    let { data: found } = await admin.from("companies").select("id, name, website, custom, source, relationship, sector, city, country, phone")
      .eq("tenant_id", tenant).ilike("name", coName.replace(/[%_]/g, "\\$&")).limit(1).maybeSingle();
    if (!found && domain) ({ data: found } = await admin.from("companies").select("id, name, website, custom, source, relationship, sector, city, country, phone")
      .eq("tenant_id", tenant).ilike("website", `%${domain.replace(/[%_]/g, "\\$&")}%`).limit(1).maybeSingle());
    if (found) {
      const patch: Record<string, unknown> = { custom: mergeCustom(found.custom, coCustom, fields.company) };
      for (const k of STD_COMPANY) if (k !== "name" && clean(coSrc[k]) && !clean((found as any)[k])) patch[k] = clean(coSrc[k]);
      if (!found.website && domain) patch.website = `https://${domain}`;
      if (!found.source) patch.source = source;
      if (tags.length) patch.relationship = [...new Set([...(Array.isArray(found.relationship) ? found.relationship : []), ...tags])];
      const up = await admin.from("companies").update(patch).eq("id", found.id);
      if (up.error) return json({ error: up.error.message }, 400);
      company = { id: found.id, created: false };
    } else {
      const row: Record<string, unknown> = { tenant_id: tenant, name: coName, source, custom: coCustom, relationship: tags };
      for (const k of STD_COMPANY) if (k !== "name" && clean(coSrc[k])) row[k] = clean(coSrc[k]);
      if (!row.website && domain) row.website = `https://${domain}`;
      if (key.created_by) row.created_by = key.created_by;
      const { data, error } = await admin.from("companies").insert(row).select("id").single();
      if (error) return json({ error: error.message }, 400);
      company = { id: data.id, created: true };
    }
    for (const p of assign) {
      const { data: has } = await admin.from("company_assignees").select("id").eq("company_id", company.id).eq("profile_id", p).limit(1);
      if (!has?.length) await admin.from("company_assignees").insert({ tenant_id: tenant, company_id: company.id, profile_id: p });
    }
    // the source shows in Settings › Companies › Sources
    const { data: srcOpt } = await admin.from("crm_options").select("id").eq("tenant_id", tenant).eq("kind", "source").ilike("label", source).limit(1);
    if (!srcOpt?.length) await admin.from("crm_options").insert({ tenant_id: tenant, kind: "source", label: source, sort: 999 });
  }
  if (what === "companies") return json({ ok: true, company }, company?.created ? 201 : 200);

  // ---- the contact
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Add a valid \"email\"." }, 400);
  const ctCustom = await customFor("contact", b, b.contact_fields);
  const summary = [
    clean(b.message) && (mapped ? clean(b.message).slice(0, 1200) : `"${clean(b.message).slice(0, 600)}"`),
    ...answers,
    ...Object.entries(SHORTCUTS).filter(([k]) => b[k] != null && listOf(b[k]).length).map(([k, sc]) => `${sc.label}: ${listOf(b[k]).join(", ")}`),
    clean(b.page) && `Page: ${clean(b.page)}`,
    b.utm && typeof b.utm === "object" && `UTM: ${Object.entries(b.utm).map(([k, v]) => `${k}=${v}`).join(" ")}`,
  ].filter(Boolean).join(" · ");
  const note = `[${today}] ${clean(b.request_type) || (what === "leads" ? "Web request" : "API import")} (${key.name})${summary ? ` — ${summary}` : ""}`;
  let contact: { id: string; created: boolean };
  const { data: had } = await admin.from("contacts").select("id, first_name, last_name, phone, position, city, country, language, linkedin, custom, notes")
    .eq("tenant_id", tenant).ilike("email", email.replace(/[%_]/g, "\\$&")).limit(1).maybeSingle();
  if (had) {
    const patch: Record<string, unknown> = { custom: mergeCustom(had.custom, ctCustom, fields.contact), notes: [had.notes, note].filter(Boolean).join("\n") };
    for (const k of STD_CONTACT) if (k !== "email" && clean(b[k]) && !clean((had as any)[k])) patch[k] = clean(b[k]);
    const up = await admin.from("contacts").update(patch).eq("id", had.id);
    if (up.error) return json({ error: up.error.message }, 400);
    contact = { id: had.id, created: false };
  } else {
    const row: Record<string, unknown> = { tenant_id: tenant, email, custom: ctCustom, notes: note };
    for (const k of STD_CONTACT) if (k !== "email" && clean(b[k])) row[k] = clean(b[k]);
    if (!row.first_name) row.first_name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const { data, error } = await admin.from("contacts").insert(row).select("id").single();
    if (error) return json({ error: error.message }, 400);
    contact = { id: data.id, created: true };
  }
  for (const p of assign) {
    const { data: has } = await admin.from("contact_assignees").select("id").eq("contact_id", contact.id).eq("profile_id", p).limit(1);
    if (!has?.length) await admin.from("contact_assignees").insert({ tenant_id: tenant, contact_id: contact.id, profile_id: p });
  }
  if (company) {
    const { data: link } = await admin.from("company_contacts").select("id").eq("company_id", company.id).eq("contact_id", contact.id).limit(1);
    if (!link?.length) await admin.from("company_contacts").insert({ tenant_id: tenant, company_id: company.id, contact_id: contact.id, role_at_company: clean(b.position) || null });
  }
  return json({ ok: true, company, contact }, contact.created || company?.created ? 201 : 200);
}

/* =====================================================================
   Client files API  —  /functions/v1/manage-users/api/...
   Auth: header  x-api-key: fck_...   (keys made in Settings → Client page)
   Read keys list and download; write keys also upload, replace, rename,
   move and delete files and folders. Scoped to the key's workspace and,
   when the key lists clients, to those clients only.
   ===================================================================== */
const BUCKET = "client-files";
const sha256 = async (t: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
const safeName = (n: string) => n.replace(/[^\w.\-]+/g, "_");
/** Content-Disposition for any file name: an ASCII fallback plus the real name (RFC 6266 / 5987) —
 *  a header can't carry "∙" or "–" as is (that threw, so the download answered 500). */
const disposition = (n: string, kind = "attachment") => {
  const name = String(n ?? "file").replace(/[\r\n]+/g, " ");
  const ascii = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "").trim() || "file";
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
};

async function handleApi(req: Request, route: string): Promise<Response> {
  const admin = createClient(URL, SERVICE);
  const raw = req.headers.get("x-api-key") ?? (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!raw || !raw.startsWith("fck_")) return json({ error: "Missing API key (x-api-key header)." }, 401);
  const { data: key } = await admin.from("client_api_keys").select("*").eq("key_hash", await sha256(raw)).maybeSingle();
  if (!key || key.revoked_at) return json({ error: "Invalid or revoked API key." }, 401);
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) return json({ error: "This API key has expired." }, 401);
  admin.from("client_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id).then(() => {});

  // the key's workspace; keys made before the tenant trigger was on take their maker's
  let tenant = (key.tenant_id as string | null) ?? null;
  if (!tenant && key.created_by) {
    const { data: maker } = await admin.from("profiles").select("tenant_id").eq("id", key.created_by).maybeSingle();
    tenant = (maker as any)?.tenant_id ?? null;
    if (tenant) admin.from("client_api_keys").update({ tenant_id: tenant }).eq("id", key.id).then(() => {});
  }
  if (!tenant) return json({ error: "This API key isn't tied to a workspace. Run 74_client_api_keys.sql in Supabase, or make a new key in Settings › Client page." }, 409);
  const canWrite = key.access === "write";
  const allowed: string[] | null = Array.isArray(key.client_ids) && key.client_ids.length ? key.client_ids.map(String) : null;
  const m = req.method.toUpperCase();
  const url = new globalThis.URL(req.url);
  const seg = route.split("/").filter(Boolean).map(decodeURIComponent);
  // companies & contacts (111_crm_import_api.sql): their own keys
  const scope = (key.scope as string | null) ?? "files";
  if (seg[0] === "crm" || scope === "crm") {
    if (scope !== "crm" || seg[0] !== "crm") return json({ error: scope === "crm" ? "This key is for companies & contacts (/crm/…)." : "This key is for client documents. Make a companies & contacts key in Settings › APIs." }, 403);
    return await handleCrm(admin, tenant, key, m, seg, req);
  }
  if (m !== "GET" && !canWrite) return json({ error: "This API key is read-only." }, 403);

  // inserts carry tenant_id when the table has it
  const ins = async (table: string, row: Record<string, unknown>) => {
    let r = await admin.from(table).insert({ ...row, tenant_id: tenant }).select().single();
    if (r.error && /tenant_id/i.test(r.error.message)) r = await admin.from(table).insert(row).select().single();
    return r;
  };

  // GET /clients
  if (seg[0] === "clients" && seg.length === 1 && m === "GET") {
    let q = admin.from("clients").select("id, name").eq("tenant_id", tenant).order("name");
    if (allowed) q = q.in("id", allowed);
    const { data, error } = await q;
    if (error) return json({ error: error.message }, 400);
    return json({ clients: data });
  }
  if (seg[0] !== "clients" || !seg[1]) return json({ error: "Unknown endpoint. See Settings → Client page → API." }, 404);

  const cid = seg[1];
  if (allowed && !allowed.includes(cid)) return json({ error: "This key has no access to that client." }, 403);
  const { data: client } = await admin.from("clients").select("id, name, tenant_id").eq("id", cid).maybeSingle();
  if (!client || String(client.tenant_id) !== String(tenant)) return json({ error: "Client not found." }, 404);

  const { data: fRows } = await admin.from("client_folders").select("id, parent_id, name, sort").eq("client_id", cid);
  const folders = (fRows ?? []) as { id: string; parent_id: string | null; name: string; sort: number }[];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (id: string | null): string => {
    const parts: string[] = []; let cur = id ? byId.get(id) : undefined; let guard = 0;
    while (cur && guard++ < 50) { parts.unshift(cur.name); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
    return parts.join("/");
  };
  // folder by id, or by "A/B/C" path (created when create = true)
  const resolveFolder = async (idOrPath: string | null, create: boolean): Promise<string | null | false> => {
    if (!idOrPath) return null;
    if (byId.has(idOrPath)) return idOrPath;
    let parent: string | null = null;
    for (const name of idOrPath.split("/").map((x) => x.trim()).filter(Boolean)) {
      const hit = folders.find((f) => f.parent_id === parent && f.name.trim().toLowerCase() === name.toLowerCase());
      if (hit) { parent = hit.id; continue; }
      if (!create) return false;
      const sort = folders.filter((f) => f.parent_id === parent).length;
      const { data, error } = await ins("client_folders", { client_id: cid, parent_id: parent, name, sort });
      if (error || !data) return false;
      folders.push(data); byId.set(data.id, data); parent = data.id;
    }
    return parent;
  };
  const fileOut = (f: any) => ({
    id: f.id, name: f.name, folder_id: f.folder_id, folder: pathOf(f.folder_id), mime: f.mime, size: f.size_bytes, note: f.note, created_at: f.created_at,
  });
  const getFile = async (id: string) => {
    const { data } = await admin.from("client_files").select("*").eq("id", id).eq("client_id", cid).maybeSingle();
    return data as any;
  };

  // GET /clients/:id/tree
  if (seg[2] === "tree" && m === "GET") {
    const { data: files } = await admin.from("client_files").select("*").eq("client_id", cid).order("created_at", { ascending: false });
    return json({
      client: { id: client.id, name: client.name },
      folders: folders.map((f) => ({ id: f.id, parent_id: f.parent_id, name: f.name, path: pathOf(f.id) })),
      files: (files ?? []).map(fileOut),
    });
  }

  // /clients/:id/files[/:fileId[/content]]
  if (seg[2] === "files") {
    const fid = seg[3];
    if (!fid && m === "GET") {
      const target = await resolveFolder(url.searchParams.get("folder"), false);
      if (target === false) return json({ error: "Folder not found." }, 404);
      let q = admin.from("client_files").select("*").eq("client_id", cid);
      if (url.searchParams.has("folder")) q = target ? q.eq("folder_id", target) : q.is("folder_id", null);
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 400);
      return json({ files: (data ?? []).map(fileOut) });
    }
    if (!fid && m === "POST") {
      const name = url.searchParams.get("name") ?? "";
      if (!name.trim()) return json({ error: "Add ?name=file.pdf" }, 400);
      const folder = await resolveFolder(url.searchParams.get("folder"), true);
      if (folder === false) return json({ error: "Could not find or create the folder." }, 400);
      const body = new Uint8Array(await req.arrayBuffer());
      if (!body.length) return json({ error: "Send the file bytes as the request body." }, 400);
      const mime = req.headers.get("content-type") || "application/octet-stream";
      const path = `${tenant}/${cid}/${crypto.randomUUID()}_${safeName(name)}`;
      const up = await admin.storage.from(BUCKET).upload(path, body, { contentType: mime });
      if (up.error) return json({ error: up.error.message }, 400);
      const { data, error } = await ins("client_files", {
        client_id: cid, folder_id: folder, storage_path: path, name: name.trim(), mime, size_bytes: body.length, note: url.searchParams.get("note"),
      });
      if (error) { await admin.storage.from(BUCKET).remove([path]); return json({ error: error.message }, 400); }
      return json({ file: fileOut(data) }, 201);
    }
    if (!fid) return json({ error: "Method not allowed." }, 405);
    const f = await getFile(fid);
    if (!f) return json({ error: "File not found." }, 404);

    if (m === "GET" && seg[4] === "content") {
      const dl = await admin.storage.from(BUCKET).download(f.storage_path);
      if (dl.error || !dl.data) return json({ error: dl.error?.message ?? "Could not read the file." }, 400);
      return new Response(dl.data, { headers: { ...cors, "Content-Type": f.mime || "application/octet-stream",
        "Content-Disposition": disposition(f.name) } });
    }
    if (m === "GET") {
      const s = await admin.storage.from(BUCKET).createSignedUrl(f.storage_path, 600, { download: f.name });
      if (url.searchParams.get("redirect") === "1" && s.data?.signedUrl) return Response.redirect(s.data.signedUrl, 302);
      return json({ file: fileOut(f), download_url: s.data?.signedUrl ?? null, expires_in: 600 });
    }
    if (m === "PUT") {
      const body = new Uint8Array(await req.arrayBuffer());
      if (!body.length) return json({ error: "Send the new file bytes as the request body." }, 400);
      const mime = req.headers.get("content-type") || f.mime || "application/octet-stream";
      const path = `${tenant}/${cid}/${crypto.randomUUID()}_${safeName(f.name)}`;
      const up = await admin.storage.from(BUCKET).upload(path, body, { contentType: mime });
      if (up.error) return json({ error: up.error.message }, 400);
      const { data, error } = await admin.from("client_files").update({ storage_path: path, mime, size_bytes: body.length }).eq("id", f.id).select().single();
      if (error) { await admin.storage.from(BUCKET).remove([path]); return json({ error: error.message }, 400); }
      await admin.storage.from(BUCKET).remove([f.storage_path]);
      return json({ file: fileOut(data) });
    }
    if (m === "PATCH") {
      const b = await req.json().catch(() => ({}));
      const patch: Record<string, unknown> = {};
      if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
      if (typeof b.note === "string" || b.note === null) patch.note = b.note;
      if ("folder" in b || "folder_id" in b) {
        const to = await resolveFolder(b.folder_id ?? b.folder ?? null, true);
        if (to === false) return json({ error: "Could not find or create the folder." }, 400);
        patch.folder_id = to;
      }
      if (!Object.keys(patch).length) return json({ error: "Nothing to change (name, note, folder or folder_id)." }, 400);
      const { data, error } = await admin.from("client_files").update(patch).eq("id", f.id).select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ file: fileOut(data) });
    }
    if (m === "DELETE") {
      await admin.storage.from(BUCKET).remove([f.storage_path]);
      const { error } = await admin.from("client_files").delete().eq("id", f.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    return json({ error: "Method not allowed." }, 405);
  }

  // /clients/:id/folders[/:folderId]
  if (seg[2] === "folders") {
    const fo = seg[3];
    if (!fo && m === "GET") return json({ folders: folders.map((f) => ({ id: f.id, parent_id: f.parent_id, name: f.name, path: pathOf(f.id) })) });
    if (!fo && m === "POST") {
      const b = await req.json().catch(() => ({}));
      const parent = b.parent_id ?? b.parent ?? null;
      const base = await resolveFolder(parent, true);
      if (base === false) return json({ error: "Parent folder not found." }, 400);
      const full = [pathOf(base), String(b.name ?? b.path ?? "")].filter(Boolean).join("/");
      if (!String(b.name ?? b.path ?? "").trim()) return json({ error: "Add a name." }, 400);
      const id = await resolveFolder(full, true);
      if (!id) return json({ error: "Could not create the folder." }, 400);
      return json({ folder: { id, path: pathOf(id) } }, 201);
    }
    if (!fo) return json({ error: "Method not allowed." }, 405);
    const target = byId.get(fo);
    if (!target) return json({ error: "Folder not found." }, 404);
    if (m === "PATCH") {
      const b = await req.json().catch(() => ({}));
      const patch: Record<string, unknown> = {};
      if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
      if ("parent_id" in b || "parent" in b) {
        const to = await resolveFolder(b.parent_id ?? b.parent ?? null, true);
        if (to === false) return json({ error: "Parent folder not found." }, 400);
        let cur = to ? byId.get(to) : undefined;
        while (cur) { if (cur.id === fo) return json({ error: "A folder can't go inside itself." }, 400); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
        patch.parent_id = to;
      }
      if (!Object.keys(patch).length) return json({ error: "Nothing to change (name, parent or parent_id)." }, 400);
      const { error } = await admin.from("client_folders").update(patch).eq("id", fo);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (m === "DELETE") {
      const all = new Set([fo]); let grew = true;
      while (grew) { grew = false; folders.forEach((f) => { if (f.parent_id && all.has(f.parent_id) && !all.has(f.id)) { all.add(f.id); grew = true; } }); }
      const { data: inside } = await admin.from("client_files").select("id, storage_path").eq("client_id", cid).in("folder_id", [...all]);
      const paths = (inside ?? []).map((x: any) => x.storage_path);
      if (paths.length) await admin.storage.from(BUCKET).remove(paths);
      await admin.from("client_files").delete().eq("client_id", cid).in("folder_id", [...all]);
      const { error } = await admin.from("client_folders").delete().eq("id", fo);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, removed_files: paths.length });
    }
    return json({ error: "Method not allowed." }, 405);
  }
  return json({ error: "Unknown endpoint. See Settings → Client page → API." }, 404);
}

/* =====================================================================
   Marketing tracking — public links inside campaign e-mails (no login):
     GET ?mk=o&s=<send id>              the open pixel (1×1 gif)
     GET ?mk=c&s=<send id>&u=<url>      a tracked link → records, then redirects
     GET ?mk=u&s=<send id>              the unsubscribe page
     GET ?mk=ping                       lets the app check tracking is deployed
   Writes through public.mk_track() (64_marketing_hub.sql). A click only
   redirects to an address that is really in that campaign's e-mail.
   ===================================================================== */
const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const page = (title: string, text: string) => new Response(
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f7f5;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#0b241a}
.c{max-width:440px;margin:24px;padding:36px 32px;border-radius:22px;background:#fff;box-shadow:0 20px 60px -30px rgba(10,111,77,.45);text-align:center}
.i{width:56px;height:56px;margin:0 auto 16px;border-radius:18px;display:grid;place-items:center;background:linear-gradient(140deg,#19c48a,#0a6f4d);color:#fff;font-size:26px}
h1{margin:0 0 8px;font-size:22px}p{margin:0;color:#5a7d6d;line-height:1.55;font-size:15px}</style></head>
<body><div class="c"><div class="i">✓</div><h1>${title}</h1><p>${text}</p></div></body></html>`,
  { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
async function handleTracking(req: Request, u: globalThis.URL): Promise<Response> {
  const mk = u.searchParams.get("mk");
  if (mk === "ping") return json({ mk: true });
  const send = u.searchParams.get("s") ?? "";
  const ua = req.headers.get("user-agent") ?? "";
  const admin = createClient(URL, SERVICE);
  const ok = UUID_RE.test(send);
  if (mk === "o") {
    if (ok) await admin.rpc("mk_track", { p_send: send, p_kind: "open", p_url: null, p_ua: ua }).then(() => {}, () => {});
    return new Response(GIF, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, private", Pragma: "no-cache" } });
  }
  if (mk === "c") {
    const target = u.searchParams.get("u") ?? "";
    if (ok && /^https?:\/\//i.test(target)) {
      const { data } = await admin.rpc("mk_track", { p_send: send, p_kind: "click", p_url: target, p_ua: ua });
      if ((data as any)?.ok) return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
    }
    return page("Link not available", "This link is no longer available.");
  }
  if (mk === "u") {
    // the confirmation button posts back here, so link scanners in mail servers don't unsubscribe people by themselves
    if (req.method === "POST" && ok) {
      await admin.rpc("mk_track", { p_send: send, p_kind: "unsubscribe", p_url: null, p_ua: ua });
      return page("Te has dado de baja", "No recibirás más comunicaciones de este tipo. Si ha sido un error, responde a cualquiera de nuestros correos.");
    }
    if (!ok) return page("Enlace no válido", "Este enlace de baja no es válido.");
    return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Darse de baja</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f7f5;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#0b241a}
.c{max-width:440px;margin:24px;padding:36px 32px;border-radius:22px;background:#fff;box-shadow:0 20px 60px -30px rgba(10,111,77,.45);text-align:center}
h1{margin:0 0 8px;font-size:22px}p{margin:0 0 22px;color:#5a7d6d;line-height:1.55;font-size:15px}
button{border:0;border-radius:12px;padding:13px 22px;font-size:15px;font-weight:600;color:#fff;background:#0a6f4d;cursor:pointer}</style></head>
<body><form class="c" method="post"><h1>¿Darte de baja?</h1><p>Dejarás de recibir nuestras comunicaciones comerciales por correo.</p><button type="submit">Sí, darme de baja</button></form></body></html>`,
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return json({ error: "Unknown" }, 404);
}

Deno.serve(async (req) => {
  {
    const u0 = new globalThis.URL(req.url);
    if (u0.searchParams.has("mk") && (req.method === "GET" || req.method === "POST")) {
      try { return await handleTracking(req, u0); } catch { return req.method === "GET" && u0.searchParams.get("mk") === "o" ? new Response(GIF, { headers: { "Content-Type": "image/gif" } }) : json({ error: "tracking failed" }, 500); }
    }
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const apiMatch = new globalThis.URL(req.url).pathname.match(/\/api(\/.*)?$/);
  if (apiMatch) {
    try { return await handleApi(req, apiMatch[1] ?? "/"); }
    catch (e) { return json({ error: String(e) }, 500); }
  }
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