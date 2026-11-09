// Supabase Edge Function: cs-engine — Customer success e-mail sequences (moved here from outlook-sync).
//   cs_run        — enrol clients in the active sequences and move them along (your company)
//   cs_test       — one blueprint, filled in for a client, sent to yourself (from a team mailbox when asked)
//   cs_campaign   — a one-time campaign: takes in the clients it applies to now and starts it ({ confirm: <its id> })
//   cs_attachment_preview — an attachment as one client gets it
//   cs_mail_scan  — read the company's mailboxes (people's and team ones): e-mails with clients become contacts
//   cs_box_check  — can a team mailbox be read (to see replies)?
//   GET ?t=o|c    — e-mail tracking: the open picture and the tracked links (public)
//   hourly, with the x-cs-cron header (114_cs_flows.sql): every company, all of the above
// Sequences are trees (114_cs_flows.sql): e-mails, waits that branch on replied / opened / not opened, tasks.
// Uses the Outlook connections (outlook_tokens) of the people who send. Secrets: MS_CLIENT_ID, MS_CLIENT_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

const MS_CLIENT_ID = Deno.env.get("MS_CLIENT_ID")!;
const MS_CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET")!;
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";
/** What every connection has; mail is added when the user connects "with mail". */
const BASE_SCOPE = "Calendars.ReadWrite offline_access User.Read";
/** Least privilege: read and send only (no changing or deleting mail). Older connections may hold ReadWrite. */
const MAIL_SCOPES = ["Mail.Read", "Mail.Send", "Mail.Read.Shared", "Mail.Send.Shared"];
/** "https://graph.microsoft.com/Mail.Send offline_access …" → "Mail.Send offline_access …" */
const normScopes = (s: unknown) => String(s ?? "").split(/\s+/).filter(Boolean)
  .map((x) => x.replace(/^https:\/\/graph\.microsoft\.com\//i, "")).join(" ");
const hasMail = (scopes: string | null | undefined) => /(^|\s)Mail\.Send(\s|$)/i.test(scopes ?? "") && /(^|\s)Mail\.Read/i.test(scopes ?? "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Admin client (service role) to read/write outlook_tokens regardless of RLS,
// but we always scope by the authenticated user id we derive from the JWT.
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function userFromRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}


async function refresh(refreshToken: string, scope = BASE_SCOPE) {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    // refresh asks for what this connection was given (asking for more fails)
    scope,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return await res.json();
}

/** The scope string to refresh a stored connection with. */
function scopeOfRow(row: any): string {
  const sc = normScopes(row?.scopes);
  if (!sc) return BASE_SCOPE;
  const parts = new Set(sc.split(" ").filter((x) => !/^(openid|profile|email)$/i.test(x)));
  parts.add("offline_access");
  return [...parts].join(" ");
}

// Return a valid access token for the user, refreshing if it's about to expire.
async function accessTokenFor(userId: string): Promise<string | null> {
  const { data } = await admin.from("outlook_tokens").select("*").eq("user_id", userId).maybeSingle();
  if (!data) return null;
  const expiresAt = new Date(data.expires_at).getTime();
  if (Date.now() < expiresAt - 60_000) return data.access_token;
  // refresh
  const tok = await refresh(data.refresh_token, scopeOfRow(data));
  const newExpiry = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();
  await admin.from("outlook_tokens").update({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? data.refresh_token,
    expires_at: newExpiry,
  }).eq("user_id", userId);
  return tok.access_token;
}
const graph = (token: string, path: string, method = "GET", body?: unknown) =>
  fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: 'outlook.timezone="UTC"' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

const CS_DAY = 86400000;
const csAddYears = (d0: Date, y: number) => { const d = new Date(d0); d.setFullYear(d.getFullYear() + Math.floor(y)); d.setMonth(d.getMonth() + Math.round((y % 1) * 12)); return d; };
/** A signed product's next renewal after `after`: its own term, else its deal's contract, else (recurring) its yearly anniversary. */
function csRenewal(l: any, ct: any, after = Date.now()): Date | null {
  if (!l || (l.status && !/active|signed|live/i.test(String(l.status)))) return null;
  const start = l.start_date || l.signing_date || ct?.contractStart || ct?.signDate;
  if (!start) return null;
  const own = Number(l.term_years) || 0, deal = Number(ct?.termYears) || 0;
  const y = own || deal || (l.recurring ? 1 : 0);
  if (!y) return null;
  const auto = own ? !!l.auto_renew : deal ? !!ct?.autoRenew : true;   // an anniversary rolls on
  const step = Number(l.renew_years) || Number(ct?.renewYears) || y;
  let end = csAddYears(new Date(start), y);
  for (let n = 0; auto && end.getTime() < after && n < 80; n++) end = csAddYears(end, step);
  return end.getTime() >= after ? end : null;
}
const csEsc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const csFill = (text: string, vars: Record<string, string>, html: boolean) =>
  String(text ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => { const v = vars[String(k).toLowerCase()] ?? ""; return html ? csEsc(v).replace(/\n/g, "<br>") : v; });
const csFmtDate = (d: Date | null) => (d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "");

/** Who a client's e-mail goes to: the run's own list, else the sequence's choice among the client's contacts. */
function csRecipients(c: any, mode: string, override: string[] | null): string[] {
  if (override?.length) return override.filter(Boolean);
  const cts = (Array.isArray(c.contacts) ? c.contacts : []).filter((x: any) => x?.email && /@/.test(String(x.email)));
  const main = cts.find((x: any) => !x.billing) ?? cts[0];
  if (mode === "all") return [...new Set(cts.map((x: any) => String(x.email).trim()))] as string[];
  if (mode === "billing") { const b = cts.filter((x: any) => x.billing); return (b.length ? b : main ? [main] : []).map((x: any) => String(x.email).trim()); }
  return main ? [String(main.email).trim()] : [];
}
function csMatches(aud: any, c: any, health: Record<string, string>): boolean {
  const a = aud ?? {};
  if (Array.isArray(a.exclude) && a.exclude.includes(c.id)) return false;
  if (Array.isArray(a.clients) && a.clients.length) return a.clients.includes(c.id);
  if (Array.isArray(a.priorities) && a.priorities.length && !a.priorities.includes(c.cs_priority ?? "none")) return false;
  if (Array.isArray(a.types) && a.types.length && !a.types.includes(c.project_type_id)) return false;
  if (Array.isArray(a.health) && a.health.length && !a.health.includes(health[c.id] ?? "none")) return false;
  return true;
}
const csB64 = (buf: ArrayBuffer) => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

/** An attachment made for one client: {{fields}} filled in a text file (HTML, TXT…), a PDF's form fields
 *  filled and its written {{fields}} replaced; the file name too. */
const CS_TEXT = /\.(html?|txt|csv|md|xml|json|svg)$/i;
async function csPersonalize(a: any, buf: ArrayBuffer, vars: Record<string, string>): Promise<{ name: string; type: string; bytes: Uint8Array }> {
  const name = csFill(String(a?.name ?? "file"), vars, false).replace(/[\\/:*?"<>|]+/g, "-");
  const type = String(a?.type || "application/octet-stream");
  const raw = new Uint8Array(buf);
  const isPdf = /pdf/i.test(type) || /\.pdf$/i.test(String(a?.name));
  if (!isPdf && (/^text\//i.test(type) || CS_TEXT.test(String(a?.name)))) {
    const txt = new TextDecoder().decode(raw);
    if (!/\{\{\s*[a-z_]+\s*\}\}/i.test(txt)) return { name, type, bytes: raw };
    const html = /html|xml|svg/i.test(type) || /\.(html?|xml|svg)$/i.test(String(a?.name));
    return { name, type, bytes: new TextEncoder().encode(csFill(txt, vars, html)) };
  }
  const fields = Object.entries((a?.fields ?? {}) as Record<string, string>).filter(([, k]) => !!k);
  const edits = (Array.isArray(a?.edits) ? a.edits : []) as any[];
  // a {{field}} on a line changed in the editor is filled in with that line
  const under = (s: any) => edits.some((e) => e?.orig != null && Number(e.page) === Number(s.page) && Math.abs(Number(e.y) - Number(s.y)) < 0.6 && Number(s.x) >= Number(e.x) - 0.6 && Number(s.x) <= Number(e.x) + Math.max(1, Number(e.w) || 0));
  const spots = ((Array.isArray(a?.spots) ? a.spots : []) as any[]).filter((s) => !under(s));
  if (!isPdf || (!fields.length && !spots.length && !edits.length)) return { name, type, bytes: raw };
  try {
    const doc = await PDFDocument.load(raw, { ignoreEncryption: true });
    const latin = (v: string) => v.replace(/[^\x20-\x7e\xa0-\xff]/g, "");
    // a line written again goes over its own background (an image of it with the text taken out, made in the editor),
    // in the colour it had; without one, over a white patch, in near-black
    const ink = (c: any) => (Array.isArray(c) && c.length === 3 ? rgb(...(c.map((v: any) => Math.min(1, Math.max(0, Number(v) || 0))) as [number, number, number])) : rgb(0.08, 0.1, 0.09));
    const patches = new Map<string, any>();
    const drawPatch = async (page: any, pt: any): Promise<boolean> => {
      const src = String(pt?.img ?? "");
      if (!src.startsWith("data:image/")) return false;
      try {
        if (!patches.has(src)) {
          const bin = atob(src.slice(src.indexOf(",") + 1));
          const u = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          patches.set(src, /^data:image\/jpe?g/i.test(src) ? await doc.embedJpg(u) : await doc.embedPng(u));
        }
        page.drawImage(patches.get(src), { x: Number(pt.x) || 0, y: Number(pt.y) || 0, width: Number(pt.w) || 0, height: Number(pt.h) || 0 });
        return true;
      } catch { return false; }
    };
    if (fields.length) {
      const form = doc.getForm();
      let any = false;
      for (const [fname, key] of fields) {
        try { form.getTextField(fname).setText(latin(vars[key] ?? "")); any = true; } catch { /* not a text field */ }
      }
      if (any) { try { form.flatten(); } catch { /* keep it fillable */ } }
    }
    if (spots.length) {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      // one line of text at a time: from its first field to its end, the line is written again with the fields filled in
      const lines = new Map<string, any[]>();
      for (const sp of spots) { const k = `${sp.page}|${sp.x}|${sp.y}|${sp.text ?? sp.key}`; lines.set(k, [...(lines.get(k) ?? []), sp]); }
      for (const group of lines.values()) {
        const sp = group.sort((p1, p2) => (Number(p1.at) || 0) - (Number(p2.at) || 0))[0];
        const page = doc.getPages()[Number(sp.page) || 0];
        if (!page) continue;
        const size = Math.max(4, Number(sp.size) || 10), y = Number(sp.y) || 0;
        let x = Number(sp.x) || 0, w = Number(sp.w) || size * 4, out = latin(vars[sp.key] ?? "");
        if (typeof sp.text === "string" && sp.text && sp.patch && await drawPatch(page, sp.patch)) {
          // the whole line goes over its own background, in its own colour
          page.drawText(latin(csFill(sp.text, vars, false)), { x, y, size, font, color: ink(sp.color) });
          continue;
        }
        if (typeof sp.text === "string" && sp.text) {
          // where the first field starts (Helvetica's widths, scaled to the line's real width) and the rest of the line, filled in
          const lineW = Number(sp.w) || font.widthOfTextAtSize(latin(sp.text), size);
          const k = lineW / Math.max(1, font.widthOfTextAtSize(latin(sp.text), size));
          const at = Number(sp.at) || 0;
          x = (Number(sp.x) || 0) + font.widthOfTextAtSize(latin(sp.text.slice(0, at)), size) * k;
          w = (Number(sp.x) || 0) + lineW - x;
          out = latin(csFill(sp.text.slice(at), vars, false));
        }
        page.drawRectangle({ x: x - 1, y: y - size * 0.28, width: w + 2, height: size * 1.2, color: rgb(1, 1, 1) });
        page.drawText(out, { x, y, size, font, color: rgb(0.08, 0.1, 0.09) });
      }
    }
    if (edits.length) {
      // the text changed in the editor: a line written again over a white patch, or new text on the page
      const fonts = new Map<string, any>();
      const fontOf = async (fam: string, bold: boolean) => {
        const k = `${fam}|${bold}`;
        if (!fonts.has(k)) {
          const f = fam === "serif" ? (bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman)
            : fam === "mono" ? (bold ? StandardFonts.CourierBold : StandardFonts.Courier)
            : (bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
          fonts.set(k, await doc.embedFont(f));
        }
        return fonts.get(k);
      };
      const pages = doc.getPages();
      for (const e of edits) {
        const page = pages[Number(e?.page) || 0];
        if (!page) continue;
        const size = Math.max(4, Number(e.size) || 11), x = Number(e.x) || 0, y = Number(e.y) || 0;
        const font = await fontOf(String(e.font ?? "sans"), !!e.bold);
        const lines = csFill(String(e.text ?? ""), vars, false).split(/\r?\n/).map(latin);
        const step = size * 1.25;
        if (e.orig != null && !(await drawPatch(page, e.patch))) {
          const wide = Math.max(Number(e.w) || 0, ...lines.map((l) => font.widthOfTextAtSize(l, size)));
          page.drawRectangle({ x: x - 1, y: y - size * 0.28 - (lines.length - 1) * step, width: wide + 2, height: size * 1.2 + (lines.length - 1) * step, color: rgb(1, 1, 1) });
        }
        lines.forEach((l, i) => { if (l) page.drawText(l, { x, y: y - i * step, size, font, color: ink(e.color) }); });
      }
    }
    return { name, type: "application/pdf", bytes: await doc.save() };
  } catch {
    return { name, type, bytes: raw };   // a PDF we can't open goes as it is
  }
}

/** Sends one message from a user's Outlook (with attachments from the cs-files bucket, made for the client when vars are given). */
async function csSend(userId: string, to: string[], subject: string, html: string, attachments: any[], vars?: Record<string, string>, from?: string | null): Promise<string | null> {
  const { data: tokRow } = await admin.from("outlook_tokens").select("scopes, account_email").eq("user_id", userId).maybeSingle();
  if (!tokRow) return "Their Outlook isn't connected (Settings › Interface).";
  if (!hasMail((tokRow as any).scopes)) return "Their Outlook is connected without mail — connect it again with mail.";
  const token = await accessTokenFor(userId).catch(() => null);
  if (!token) return "Their Outlook connection expired — connect it again.";
  const files: any[] = [];
  let total = 0;
  for (const a of attachments ?? []) {
    if (!a?.path) continue;
    const { data, error } = await admin.storage.from("cs-files").download(a.path);
    if (error || !data) return `Attachment "${a.name}" is missing.`;
    const buf = await data.arrayBuffer();
    const f = vars ? await csPersonalize(a, buf, vars) : { name: a.name ?? "file", type: a.type || "application/octet-stream", bytes: new Uint8Array(buf) };
    total += f.bytes.byteLength;
    if (total > 3_000_000) return "The attachments add up to more than 3 MB.";
    files.push({ "@odata.type": "#microsoft.graph.fileAttachment", name: f.name, contentType: f.type, contentBytes: csB64(f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer) });
  }
  const message: Record<string, unknown> = { subject, body: { contentType: "HTML", content: html }, toRecipients: to.map((e) => ({ emailAddress: { address: e } })), attachments: files };
  // a team (shared) mailbox (108_cs_campaigns.sql): sent from it with this person's connection — they need "Send as" on it
  const own = lc((tokRow as any).account_email);
  const box = lc(from);
  if (box && box !== own) {
    message.from = { emailAddress: { address: box } };
    let res = await graph(token, `/users/${encodeURIComponent(box)}/sendMail`, "POST", { message, saveToSentItems: true });
    if (res.status === 429) return "throttled";
    if (!res.ok && (res.status === 403 || res.status === 404 || res.status === 400)) {
      // without access to the mailbox itself, "Send as" still lets their own mailbox send it as the team one
      const again = await graph(token, "/me/sendMail", "POST", { message, saveToSentItems: true });
      if (again.status === 429) return "throttled";
      if (again.ok) return null;
      const why = (await again.text()).slice(0, 200);
      return /SendAs|ErrorSendAsDenied|not authorized|AccessDenied|403/i.test(why) || again.status === 403
        ? `${(tokRow as any).account_email ?? "This person"} may not send as ${box}. In Microsoft 365 (Exchange admin center › Mailboxes › ${box} › Delegation) give them "Send as" — and "Read and manage" to keep a copy in its Sent Items.`
        : `Outlook said: ${why}`;
    }
    if (!res.ok) return `Outlook said: ${(await res.text()).slice(0, 300)}`;
    return null;
  }
  const res = await graph(token, "/me/sendMail", "POST", { message, saveToSentItems: true });
  if (res.status === 429) return "throttled";
  if (!res.ok) return `Outlook said: ${(await res.text()).slice(0, 300)}`;
  return null;
}

/** Everything a tenant's sequences need, read once. */
async function csTenantData(tenant: string) {
  const [cl, ow, he, tp, pr] = await Promise.all([
    admin.from("clients").select("id, name, legal_name, contacts, cs_priority, project_type_id, tenant_id, company_id").eq("tenant_id", tenant),
    admin.from("client_cs_owners").select("client_id, profile_id, is_primary").eq("tenant_id", tenant),
    admin.from("client_health").select("client_id, status").eq("tenant_id", tenant),
    admin.from("cs_email_templates").select("*").eq("tenant_id", tenant),
    admin.from("profiles").select("id, first_name, last_name, email").eq("tenant_id", tenant),
  ]);
  const clients = (cl.data ?? []) as any[];
  // the people of each client's company (Companies › Contacts) count as its contacts too, after its own list
  const coIds = [...new Set(clients.map((c) => c.company_id).filter(Boolean))] as string[];
  const coPeople = new Map<string, any[]>();
  for (let i = 0; i < coIds.length; i += 150) {
    const { data: links } = await admin.from("company_contacts").select("company_id, contact_id").in("company_id", coIds.slice(i, i + 150));
    const ls = (links ?? []) as any[];
    const cids = [...new Set(ls.map((l) => l.contact_id))];
    const ppl = new Map<string, any>();
    for (let j = 0; j < cids.length; j += 200) {
      const { data: cts } = await admin.from("contacts").select("id, first_name, last_name, email, is_billing").in("id", cids.slice(j, j + 200)).not("email", "is", null);
      ((cts ?? []) as any[]).forEach((k) => { if (/@/.test(String(k.email ?? ""))) ppl.set(k.id, k); });
    }
    ls.forEach((l) => { const k = ppl.get(l.contact_id); if (k) coPeople.set(l.company_id, [...(coPeople.get(l.company_id) ?? []), { name: [k.first_name, k.last_name].filter(Boolean).join(" "), email: String(k.email).trim(), billing: !!k.is_billing }]); });
  }
  clients.forEach((c) => {
    const own = (Array.isArray(c.contacts) ? c.contacts : []) as any[];
    const seen = new Set(own.map((x) => lc(x?.email)).filter(Boolean));
    const more = (c.company_id ? coPeople.get(c.company_id) ?? [] : []).filter((x) => { const e = lc(x.email); if (seen.has(e)) return false; seen.add(e); return true; });
    if (more.length) c.contacts = [...own, ...more];
  });
  const ids = clients.map((c) => c.id);
  const lines: any[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await admin.from("client_products").select("client_id, tracking_id, status, recurring, start_date, signing_date, term_years, auto_renew, renew_years").in("client_id", ids.slice(i, i + 150));
    lines.push(...((data ?? []) as any[]));
  }
  const tids = [...new Set(lines.map((l) => l.tracking_id).filter(Boolean))];
  const terms: Record<string, any> = {};
  for (let i = 0; i < tids.length; i += 150) {
    const { data } = await admin.from("trackings").select("id, contract_terms").in("id", tids.slice(i, i + 150));
    ((data ?? []) as any[]).forEach((t) => { if (t.contract_terms) terms[t.id] = t.contract_terms; });
  }
  const owner: Record<string, string> = {};
  const owners: Record<string, string[]> = {};
  ((ow.data ?? []) as any[]).sort((a, b) => Number(a.is_primary) - Number(b.is_primary)).forEach((o) => { owner[o.client_id] = o.profile_id; owners[o.client_id] = [...(owners[o.client_id] ?? []), o.profile_id]; });
  const health: Record<string, string> = {};
  ((he.data ?? []) as any[]).forEach((h) => { health[h.client_id] = h.status; });
  const people: Record<string, any> = {};
  ((pr.data ?? []) as any[]).forEach((p) => { people[p.id] = p; });
  const templates: Record<string, any> = {};
  ((tp.data ?? []) as any[]).forEach((t) => { templates[t.id] = t; });
  const renewalOf = (clientId: string, after = Date.now()) => lines.filter((l) => l.client_id === clientId)
    .map((l) => csRenewal(l, l.tracking_id ? terms[l.tracking_id] : null, after)).filter(Boolean)
    .sort((a, b) => a!.getTime() - b!.getTime())[0] ?? null;
  return { clients, owner, owners, health, people, templates, renewalOf };
}
type CsTenant = Awaited<ReturnType<typeof csTenantData>>;

/** The version of a blueprint a client gets (90_cs_blueprint_versions.sql): the first one that applies, else the main one. */
function csVerFits(a: any, c: any, d: CsTenant): boolean {
  const x = a ?? {};
  if (Array.isArray(x.clients) && x.clients.length) return x.clients.includes(c.id);
  const has = (r: unknown) => Array.isArray(r) && r.length > 0;
  if (!has(x.owners) && !has(x.priorities) && !has(x.health)) return false;
  if (has(x.owners) && !(d.owners[c.id] ?? []).some((o: string) => x.owners.includes(o))) return false;
  if (has(x.priorities) && !x.priorities.includes(c.cs_priority ?? "none")) return false;
  if (has(x.health) && !x.health.includes(d.health[c.id] ?? "none")) return false;
  return true;
}
function csVersionOf(t: any, c: any, d: CsTenant): any {
  const v = (Array.isArray(t?.variants) ? t.variants : []).find((x: any) => csVerFits(x?.audience, c, d));
  return v ? { ...t, subject: v.subject || t.subject, body_html: v.body_html ?? t.body_html, html: v.html || "", _variant: v.name || "Version" } : t;
}

/** Names always start with a capital letter ("laura gil" → "Laura Gil"). */
const csCap = (x: unknown) => String(x ?? "").trim().replace(/(^|[\s\-'’])(\p{L})/gu, (_, a, b) => a + b.toLocaleUpperCase());
function csVars(c: any, d: CsTenant, senderId: string | null, person?: { name?: string; email?: string } | null): Record<string, string> {
  const cts = (Array.isArray(c.contacts) ? c.contacts : []).filter((x: any) => x?.email);
  const main = person ?? cts.find((x: any) => !x.billing) ?? cts[0];
  const p = senderId ? d.people[senderId] : null;
  const ren = d.renewalOf(c.id);
  return {
    client: c.name ?? "", legal_name: c.legal_name || c.name || "",
    contact_name: csCap(main?.name), first_name: csCap(String(main?.name ?? "").trim().split(/\s+/)[0]) || "there",
    owner_name: p ? csCap([p.first_name, p.last_name].filter(Boolean).join(" ")) : "", owner_first_name: csCap(p?.first_name), owner_email: p?.email ?? "",
    renewal_date: csFmtDate(ren), days_to_renewal: ren ? String(Math.max(0, Math.ceil((ren.getTime() - Date.now()) / CS_DAY))) : "",
    today: csFmtDate(new Date()), year: String(new Date().getFullYear()),
  };
}
const csHtmlOf = (t: any) => String(t.html || "") || `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#0e1a15">${t.body_html ?? ""}</div>`;

/* =====================================================================
   Customer success: contacts read from Outlook (89_contact_direction.sql)
   Every e-mail from someone at a client is a contact from them ("in"); every
   e-mail we send them, a contact from us ("out"). People are matched on the
   client's contacts' addresses, or on the client's own e-mail domain (only when
   that domain belongs to one client, never a public one, never ours).
   ===================================================================== */
const CS_PUBLIC = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|web|zoho|yandex|telefonica|movistar|orange|vodafone|terra|ono|t-online|libero|free|laposte|wanadoo|qq|163)\./i;
const CS_ROBOT = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|automated|system)([+._-]|@)/i;
const csDom = (e: unknown) => lc(e).split("@")[1] ?? "";
const CS_BACKFILL_DAYS = 365;

/** Every address we know at each client (its own list and its company's contacts), and our own domains. */
async function csAddressBook(tenant: string) {
  const [cl, pr, tk] = await Promise.all([
    admin.from("clients").select("id, company_id, contacts").eq("tenant_id", tenant),
    admin.from("profiles").select("id, email").eq("tenant_id", tenant),
    admin.from("outlook_tokens").select("user_id, account_email"),
  ]);
  const clients = (cl.data ?? []) as any[];
  const byEmail = new Map<string, { client: string; name: string }[]>();
  const add = (email: unknown, client: string, name: string) => {
    const e = lc(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return;
    const xs = byEmail.get(e) ?? [];
    if (!xs.some((x) => x.client === client)) xs.push({ client, name });
    byEmail.set(e, xs);
  };
  clients.forEach((c) => (Array.isArray(c.contacts) ? c.contacts : []).forEach((x: any) => add(x?.email, c.id, String(x?.name ?? ""))));
  const clientsOfCo = new Map<string, string[]>();
  clients.forEach((c) => { if (c.company_id) clientsOfCo.set(c.company_id, [...(clientsOfCo.get(c.company_id) ?? []), c.id]); });
  const coIds = [...clientsOfCo.keys()];
  for (let i = 0; i < coIds.length; i += 100) {
    const { data: links } = await admin.from("company_contacts").select("company_id, contact_id").in("company_id", coIds.slice(i, i + 100));
    const ls = (links ?? []) as any[];
    const ids = [...new Set(ls.map((l) => l.contact_id))];
    const people = new Map<string, any>();
    for (let j = 0; j < ids.length; j += 200) {
      const { data: cts } = await admin.from("contacts").select("id, first_name, last_name, email").in("id", ids.slice(j, j + 200)).not("email", "is", null);
      ((cts ?? []) as any[]).forEach((k) => people.set(k.id, k));
    }
    ls.forEach((l) => { const k = people.get(l.contact_id); if (k) (clientsOfCo.get(l.company_id) ?? []).forEach((cid) => add(k.email, cid, [k.first_name, k.last_name].filter(Boolean).join(" "))); });
  }
  const mine = new Set(((pr.data ?? []) as any[]).map((p) => p.id));
  const own = new Set([...((pr.data ?? []) as any[]).map((p) => csDom(p.email)), ...((tk.data ?? []) as any[]).filter((t) => mine.has(t.user_id)).map((t) => csDom(t.account_email))].filter(Boolean));
  const domClients = new Map<string, Set<string>>();
  byEmail.forEach((xs, e) => {
    const d = csDom(e);
    if (!d || CS_PUBLIC.test(d) || own.has(d)) return;
    const set = domClients.get(d) ?? new Set<string>();
    xs.forEach((x) => set.add(x.client));
    domClients.set(d, set);
  });
  const match = (email: unknown): { client: string; name: string }[] => {
    const e = lc(email), d = csDom(e);
    if (!d || own.has(d) || CS_ROBOT.test(e)) return [];
    const exact = byEmail.get(e);
    if (exact?.length) return exact;
    const set = domClients.get(d);
    return set && set.size === 1 ? [{ client: [...set][0], name: "" }] : [];
  };
  return { match, own, people: mine };
}
type CsBook = Awaited<ReturnType<typeof csAddressBook>>;

/** An app-only Graph token for a whole Microsoft organisation: works once an admin there has given the app
 *  the "Mail.Read" application permission (admin consent). Then everyone's mailbox counts, connected or not. */
const csAppTokens = new Map<string, string | null>();
async function csAppToken(domain: string): Promise<string | null> {
  if (!domain) return null;
  if (csAppTokens.has(domain)) return csAppTokens.get(domain)!;
  let tok: string | null = null;
  try {
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(domain)}/oauth2/v2.0/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
    });
    if (res.ok) {
      const j = await res.json();
      // only useful when the organisation granted mail reading to the app
      const roles: string[] = (() => { try { return JSON.parse(atob(String(j.access_token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).roles ?? []; } catch { return []; } })();
      if (roles.some((r) => /^Mail\.(Read|ReadBasic|ReadWrite)(\.All)?$/i.test(r))) tok = j.access_token;
    }
  } catch { /* no organisation access */ }
  csAppTokens.set(domain, tok);
  return tok;
}

/** Reads one person's mailbox from where it was left (a year back the first time) and logs the client e-mails.
 *  Their own Outlook connection (with mail) if they made one, else the organisation's access. */
async function csMailScan(who: { id: string; email: string | null }, tenant: string, book: CsBook, maxPages: number, deadline: number): Promise<{ scanned: number; logged: number; more: boolean; error: string | null; skipped?: string; via?: string }> {
  const out = { scanned: 0, logged: 0, more: false, error: null as string | null };
  const userId = who.id;
  const { data: tokRow } = await admin.from("outlook_tokens").select("scopes, account_email").eq("user_id", userId).maybeSingle();
  let token: string | null = null, base = "/me", via = "own";
  let me = lc((tokRow as any)?.account_email || who.email);
  if (tokRow && hasMail((tokRow as any).scopes)) token = await accessTokenFor(userId).catch(() => null);
  if (!token && who.email) {
    const app = await csAppToken(csDom(who.email));
    if (app) { token = app; base = `/users/${encodeURIComponent(lc(who.email))}`; via = "team"; me = lc(who.email); }
  }
  if (!token) return { ...out, skipped: "no_mail" };
  const { data: st } = await admin.from("cs_mail_sync").select("*").eq("user_id", userId).maybeSingle();
  const after: string = new Date((st as any)?.read_after ?? Date.now() - CS_BACKFILL_DAYS * CS_DAY).toISOString();
  const sel = "from,toRecipients,ccRecipients,subject,receivedDateTime,sentDateTime,internetMessageId,isDraft";
  let url: string | null = `${GRAPH}${base}/messages?$select=${sel}&$filter=${encodeURIComponent(`receivedDateTime ge ${after}`)}&$orderby=receivedDateTime%20asc&$top=200`;
  let newest = after;
  const found = new Map<string, Record<string, unknown>>();
  for (let p = 0; url && p < maxPages && Date.now() < deadline; p++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } });
    if (res.status === 429) { out.error = "Outlook is busy, it carries on later"; break; }
    if (res.status === 404 && via === "team") return { ...out, skipped: "no_mailbox", via };   // no mailbox at this address
    if (!res.ok) { out.error = `Outlook said: ${(await res.text()).slice(0, 200)}`; break; }
    const j = await res.json();
    for (const m of (j.value ?? []) as any[]) {
      out.scanned += 1;
      if (m.receivedDateTime) { const t = new Date(m.receivedDateTime).toISOString(); if (t > newest) newest = t; }
      if (m.isDraft || !m.internetMessageId) continue;
      const from = lc(m.from?.emailAddress?.address);
      const ours = from === me || book.own.has(csDom(from));
      const at = (ours ? m.sentDateTime : m.receivedDateTime) || m.receivedDateTime;
      const subject = String(m.subject ?? "").trim().slice(0, 300) || "(no subject)";
      const put = (client: string, direction: "in" | "out", email: string, name: string) => {
        const k = `${client}|${m.internetMessageId}`;
        if (!found.has(k)) found.set(k, { tenant_id: tenant, client_id: client, contacted_at: at, channel: "email", direction, source: "email", reason: subject, contact_name: csCap(name) || null, contact_email: email || null, external_id: m.internetMessageId, logged_by: userId });
      };
      if (!ours) book.match(from).forEach((x) => put(x.client, "in", from, m.from?.emailAddress?.name || x.name));
      else {
        for (const r of [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])]) {
          const e = lc(r?.emailAddress?.address);
          book.match(e).forEach((x) => put(x.client, "out", e, r?.emailAddress?.name || x.name));
        }
      }
    }
    url = j["@odata.nextLink"] ?? null;
  }
  out.more = !!url && !out.error;
  // an automatic follow-up is already logged when it goes out: its copy in Sent Items is not logged again
  let rows = [...found.values()];
  if (rows.some((r) => r.direction === "out")) {
    const { data: autos } = await admin.from("client_contacts_log").select("client_id, contacted_at").eq("tenant_id", tenant).eq("source", "auto").gte("contacted_at", after);
    const near = ((autos ?? []) as any[]).map((a) => [a.client_id, new Date(a.contacted_at).getTime()] as const);
    rows = rows.filter((r) => r.direction !== "out" || !near.some(([cid, t]) => cid === r.client_id && Math.abs(t - new Date(String(r.contacted_at)).getTime()) < 15 * 60_000));
  }
  let saved = true;
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await admin.from("client_contacts_log").upsert(rows.slice(i, i + 200), { onConflict: "client_id,external_id", ignoreDuplicates: true }).select("id");
    if (error) { out.error = /direction|source|external_id|contact_email/i.test(error.message) ? "Run 89_contact_direction.sql" : error.message; saved = false; break; }
    out.logged += (data ?? []).length;
  }
  await admin.from("cs_mail_sync").upsert({
    user_id: userId, tenant_id: tenant, read_after: saved ? newest : after,
    scanned: (Number((st as any)?.scanned) || 0) + out.scanned, logged: (Number((st as any)?.logged) || 0) + out.logged,
    done_backfill: !!(st as any)?.done_backfill || (!out.more && saved), last_run_at: new Date().toISOString(), last_error: out.error,
  });
  return { ...out, via };
}

/** The whole team of one company (or of every company using Outlook: the scheduler), until the time runs out.
 *  Each person's mailbox is read through their own connection, or the organisation's when an admin allowed it. */
async function csMailScanAll(tenantOnly: string | null, maxPages: number, deadline: number) {
  const total = { scanned: 0, logged: 0, more: false, mailboxes: 0, errors: [] as string[], read: [] as string[], unread: [] as string[], team: false };
  const { data: toks } = await admin.from("outlook_tokens").select("user_id");
  const linked = new Set(((toks ?? []) as any[]).map((t) => t.user_id));
  let q = admin.from("profiles").select("id, tenant_id, first_name, last_name, email, active");
  if (tenantOnly) q = q.eq("tenant_id", tenantOnly);
  const { data: profs } = await q;
  const byTenant = new Map<string, any[]>();
  ((profs ?? []) as any[]).forEach((p) => { if (p.tenant_id && p.active !== false) byTenant.set(p.tenant_id, [...(byTenant.get(p.tenant_id) ?? []), p]); });
  for (const [tenant, ps] of byTenant) {
    if (!ps.some((p) => linked.has(p.id))) continue;   // a company that doesn't use Outlook here
    if (Date.now() > deadline) { total.more = true; break; }
    const book = await csAddressBook(tenant);
    for (const p of ps) {
      const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "Someone";
      if (Date.now() > deadline) { total.more = true; break; }
      const r = await csMailScan({ id: p.id, email: p.email ?? null }, tenant, book, maxPages, deadline).catch((e) => ({ scanned: 0, logged: 0, more: true, error: String(e), skipped: undefined, via: undefined }));
      if (r.skipped) { total.unread.push(name); continue; }
      total.mailboxes += 1; total.read.push(name); total.scanned += r.scanned; total.logged += r.logged; total.more = total.more || r.more;
      if (r.via === "team") total.team = true;
      if (r.error) total.errors.push(`${p.first_name ?? "Someone"}: ${r.error}`);
    }
  }
  return total;
}

/** A blueprint, filled in for one client, to your own inbox. */
async function csTest(userId: string, p: any): Promise<Response> {
  const { data: prof } = await admin.from("profiles").select("tenant_id, email").eq("id", userId).maybeSingle();
  const tenant = (prof as any)?.tenant_id;
  if (!tenant) return json({ error: "No company." }, 400);
  const { data: t } = await admin.from("cs_email_templates").select("*").eq("id", p.templateId).eq("tenant_id", tenant).maybeSingle();
  if (!t) return json({ error: "Save the blueprint first." }, 400);
  const d = await csTenantData(tenant);
  const c = d.clients.find((x) => x.id === p.clientId) ?? d.clients[0] ?? { id: "", name: "Your client", contacts: [] };
  const { data: tok } = await admin.from("outlook_tokens").select("account_email").eq("user_id", userId).maybeSingle();
  const to = String((tok as any)?.account_email || (prof as any)?.email || "");
  if (!to) return json({ error: "No address of yours to send it to." }, 400);
  const vars = csVars(c, d, userId);
  const tv = c.id ? csVersionOf(t, c, d) : t;
  const subject = `[Test] ${csFill(tv.subject, vars, false)}`;
  const from = String(p.from ?? "").trim() || null;
  const err = await csSend(userId, [to], subject, csFill(csHtmlOf(tv), vars, true), (t as any).attachments ?? [], vars, from);
  await admin.from("cs_email_log").insert({ tenant_id: tenant, client_id: c.id || null, template_id: (t as any).id, to_emails: [to], subject, status: err ? "failed" : "test", error: err, sent_by: userId, variant: tv._variant ?? null });
  return err ? json({ error: err === "throttled" ? "Outlook is busy — try again in a minute." : err }, 400) : json({ ok: true, to, from });
}

/* =====================================================================
   E-mail tracking (114_cs_flows.sql) — public, no login:
     GET ?t=o&l=<log id>            the 1×1 picture: the e-mail was opened (its pictures loaded)
     GET ?t=c&l=<log id>&u=<url>    a tracked link: counted, then on to the address (only one that is in that e-mail)
   ===================================================================== */
const CS_FN = `${Deno.env.get("SUPABASE_URL")}/functions/v1/cs-engine`;
const CS_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
const CS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const csUnesc = (s: string) => s.replace(/&amp;/g, "&").replace(/&#38;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** The e-mail as it goes out: its links pass through us (so a click is known) and a 1×1 picture tells us it was opened. */
function csTrack(html: string, logId: string): { html: string; links: string[] } {
  const links = new Set<string>();
  let out = html.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (_m, pre, q, raw) => {
    const url = csUnesc(raw);
    if (/[?&]t=c&l=/.test(url) && url.startsWith(CS_FN)) return `${pre}${q}${raw}${q}`;
    links.add(url);
    return `${pre}${q}${CS_FN}?t=c&amp;l=${logId}&amp;u=${encodeURIComponent(url)}${q}`;
  });
  const pixel = `<img src="${CS_FN}?t=o&amp;l=${logId}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0" />`;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : out + pixel;
  return { html: out, links: [...links] };
}

async function csHandleTrack(u: globalThis.URL): Promise<Response> {
  const kind = u.searchParams.get("t");
  const log = u.searchParams.get("l") ?? "";
  const ok = CS_UUID.test(log);
  if (kind === "o") {
    if (ok) await admin.rpc("cs_track", { p_log: log, p_kind: "open", p_url: null }).then(() => {}, () => {});
    return new Response(CS_GIF, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, private", Pragma: "no-cache" } });
  }
  if (kind === "c") {
    const target = u.searchParams.get("u") ?? "";
    if (ok && /^https?:\/\//i.test(target)) {
      const { data } = await admin.rpc("cs_track", { p_log: log, p_kind: "click", p_url: target });
      if ((data as any)?.ok) return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
    }
    return new Response(`<!doctype html><meta charset="utf-8"><title>Link not available</title><p style="font-family:Arial,sans-serif;margin:40px">This link is no longer available.</p>`,
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  return json({ error: "Unknown" }, 404);
}

/** One e-mail to one person, logged first (its id goes in the tracking), then sent. "throttled": nothing kept, try later. */
async function csSendLogged(base: Record<string, unknown>, sender: string, email: string, subject: string, html: string, atts: any[], vars: Record<string, string>, fromBox: string | null): Promise<{ err: string | null; logId: string | null }> {
  const { data: row, error } = await admin.from("cs_email_log").insert({ ...base, to_emails: [email], subject, status: "sent", from_address: fromBox }).select("id").single();
  if (error || !row) {
    // before 114_cs_flows.sql: no tracking columns — sent untracked, logged after
    const err = await csSend(sender, [email], subject, html, atts, vars, fromBox);
    if (err === "throttled") return { err, logId: null };
    const { node: _n, from_address: _f, ...old } = base as any;
    await admin.from("cs_email_log").insert({ ...old, to_emails: [email], subject, status: err ? "failed" : "sent", error: err });
    return { err, logId: null };
  }
  const t = csTrack(html, (row as any).id);
  await admin.from("cs_email_log").update({ links: t.links }).eq("id", (row as any).id);
  const err = await csSend(sender, [email], subject, t.html, atts, vars, fromBox);
  if (err === "throttled") { await admin.from("cs_email_log").delete().eq("id", (row as any).id); return { err, logId: null }; }
  if (err) await admin.from("cs_email_log").update({ status: "failed", error: err }).eq("id", (row as any).id);
  return { err, logId: (row as any).id };
}

/* =====================================================================
   Sequences as a tree (cs_sequences.flow, 114_cs_flows.sql)
     email   { template_id, wait_days }          sent wait_days after the step before (0: right away)
     branch  { days, paths: { replied, opened, none } }
             waits up to `days` for the e-mail before it: a reply takes "replied" as soon as it's seen;
             at the end, "opened" (opened or clicked, no reply) or "none" (not opened)
     task    { title, notes, assign: owners | primary | sender | <profile id>, due_days, wait_days }
     stop    ends there
   A branch's path, once done, carries on with the steps after the branch.
   Where a client is: run.node, a pointer like "2" or "2/opened/0".
   A sequence without a flow (the old straight list) is read as e-mails one after another.
   ===================================================================== */
type CsNode = { id?: string; type: "email" | "branch" | "task" | "stop"; template_id?: string; wait_days?: number; days?: number;
  paths?: { replied?: CsNode[]; opened?: CsNode[]; none?: CsNode[] }; title?: string; notes?: string; assign?: string; due_days?: number };
const CS_LANES = ["replied", "opened", "none"] as const;
function csFlowOf(seq: any): CsNode[] {
  const f = seq?.flow;
  const nodes = Array.isArray(f) ? f : Array.isArray(f?.nodes) ? f.nodes : null;
  if (nodes && nodes.length) return nodes as CsNode[];
  return (Array.isArray(seq?.steps) ? seq.steps : []).filter((s: any) => s?.template_id).map((s: any) => ({ type: "email", template_id: s.template_id, wait_days: Number(s.wait_days) || 0 }));
}
function csNodeAt(root: CsNode[], ptr: string | null): CsNode | null {
  if (!ptr) return null;
  const parts = ptr.split("/");
  let list: CsNode[] | undefined = root;
  let node: CsNode | null = null;
  for (let k = 0; k < parts.length; k += 2) {
    node = list?.[Number(parts[k])] ?? null;
    if (!node) return null;
    if (k + 1 < parts.length) list = node.paths?.[parts[k + 1] as "replied"] ?? [];
  }
  return node;
}
/** the step after this one: the next in its list, else the one after the branch it sits in */
function csNextPtr(root: CsNode[], ptr: string): string | null {
  const parts = ptr.split("/");
  const last = Number(parts[parts.length - 1]) + 1;
  const sib = [...parts.slice(0, -1), String(last)].join("/");
  if (csNodeAt(root, sib)) return sib;
  if (parts.length < 3) return null;
  return csNextPtr(root, parts.slice(0, -2).join("/"));
}
function csLanePtr(root: CsNode[], ptr: string, lane: string): string | null {
  const n = csNodeAt(root, ptr);
  return (n?.paths?.[lane as "replied"] ?? []).length ? `${ptr}/${lane}/0` : csNextPtr(root, ptr);
}
const csDelayOf = (n: CsNode | null) => (n && (n.type === "email" || n.type === "task") ? Math.max(0, Number(n.wait_days) || 0) * CS_DAY : 0);
const csEvent = (row: Record<string, unknown>) => admin.from("cs_run_events").insert(row).then(() => {}, () => {});

/** Enrols the clients each active sequence applies to and moves each one along its steps. One tenant, or all (the scheduler). */
async function csRun(tenantOnly: string | null, budget = 60, seqOnly: string | null = null, deadline = 0): Promise<Record<string, unknown>> {
  const stats = { enrolled: 0, sent: 0, failed: 0, skipped: 0, finished: 0, tasks: 0, branched: 0, errors: [] as string[] };
  let q = admin.from("cs_sequences").select("*").eq("active", true);
  if (tenantOnly) q = q.eq("tenant_id", tenantOnly);
  if (seqOnly) q = q.eq("id", seqOnly);
  const { data: seqs, error } = await q;
  if (error) return { error: /relation|does not exist/i.test(error.message) ? "Run 88_cs_followups.sql" : error.message };
  const tenants = [...new Set(((seqs ?? []) as any[]).map((s) => s.tenant_id).filter(Boolean))] as string[];
  const now = Date.now();
  for (const tenant of tenants) {
    await admin.rpc("cs_mark_replies", { p_tenant: tenant }).then(() => {}, () => {});
    const d = await csTenantData(tenant);
    let lastOf: Map<string, { all: number; human: number }> | null = null;
    const lastContacts = async () => {
      if (lastOf) return lastOf;
      lastOf = new Map();
      const { data: lc, error: le } = await admin.rpc("cs_last_contacts", { p_tenant: tenant });
      if (le) { stats.errors.push(/function|does not exist/i.test(le.message) ? "Run 91_cs_quiet_rule.sql" : le.message); return null; }
      ((lc ?? []) as any[]).forEach((x) => lastOf!.set(x.client_id, { all: x.last_at ? new Date(x.last_at).getTime() : 0, human: x.last_human_at ? new Date(x.last_human_at).getTime() : 0 }));
      return lastOf;
    };
    for (const seq of ((seqs ?? []) as any[]).filter((s) => s.tenant_id === tenant)) {
      const campaign = seq.kind === "campaign";
      const flow = csFlowOf(seq);
      if (!flow.length) continue;
      const quietDays = campaign ? 0 : Math.max(0, Number(seq.audience?.quiet_days) || 0);
      const quietStop = quietDays > 0 && seq.audience?.quiet_stop !== false;
      const last = quietDays ? await lastContacts() : null;
      if (quietDays && !last) continue;
      const quiet = (c: any) => !quietDays || (now - (last!.get(c.id)?.all ?? 0)) >= quietDays * CS_DAY;
      const { data: runRows } = await admin.from("cs_sequence_runs").select("*").eq("sequence_id", seq.id);
      const runs = (runRows ?? []) as any[];
      const has = new Set(runs.map((r) => r.client_id));
      const firstAt = (c: any): number | null => {
        if (seq.start_mode !== "before_renewal") return now + csDelayOf(flow[0]);
        const ren = d.renewalOf(c.id);
        if (!ren) return null;
        return Math.max(now, ren.getTime() - (Number(seq.start_days) || 0) * CS_DAY) + csDelayOf(flow[0]);
      };
      for (const c of campaign ? [] : d.clients) {
        if (has.has(c.id) || !csMatches(seq.audience, c, d.health) || !quiet(c)) continue;
        const at = firstAt(c);
        if (at == null) continue;
        let ins = await admin.from("cs_sequence_runs").insert({ tenant_id: tenant, sequence_id: seq.id, client_id: c.id, step: 0, node: "0", status: "active", next_at: new Date(at).toISOString() }).select("*").single();
        if (ins.error && /node/i.test(ins.error.message)) ins = await admin.from("cs_sequence_runs").insert({ tenant_id: tenant, sequence_id: seq.id, client_id: c.id, step: 0, status: "active", next_at: new Date(at).toISOString() }).select("*").single();
        if (!ins.error && ins.data) { stats.enrolled += 1; runs.push(ins.data); }
      }
      if (quietDays) {
        for (const r of runs) {
          const c = d.clients.find((x) => x.id === r.client_id);
          if (!r.id || !c) continue;
          const began = new Date(r.started_at ?? r.created_at ?? 0).getTime();
          if (quietStop && r.status === "active" && (last!.get(c.id)?.human ?? 0) > began) {
            await admin.from("cs_sequence_runs").update({ status: "done", next_at: null }).eq("id", r.id); r.status = "done"; stats.finished += 1;
            continue;
          }
          const lastSent = r.last_sent_at ? new Date(r.last_sent_at).getTime() : 0;
          if (seq.repeat && r.status === "done" && csMatches(seq.audience, c, d.health) && quiet(c) && now - lastSent >= quietDays * CS_DAY) {
            const at = firstAt(c);
            if (at == null) continue;
            const patch = { status: "active", step: 0, node: "0", wait_until: null, cycle: (Number(r.cycle) || 0) + 1, started_at: new Date(now).toISOString(), next_at: new Date(at).toISOString() };
            const { error: ue } = await admin.from("cs_sequence_runs").update(patch).eq("id", r.id);
            if (!ue) { Object.assign(r, patch); stats.enrolled += 1; }
          }
        }
      }
      for (const r of runs) {
        const c = d.clients.find((x) => x.id === r.client_id);
        if (!campaign && r.id && r.status === "active" && !r.manual && c && !csMatches(seq.audience, c, d.health)) {
          await admin.from("cs_sequence_runs").update({ status: "done" }).eq("id", r.id); r.status = "done"; stats.finished += 1;
        }
      }
      const due = runs.filter((r) => r.id && r.status === "active" && r.next_at && new Date(r.next_at).getTime() <= now);
      for (const r of due) {
        if (budget <= 0 || (deadline && Date.now() > deadline)) break;
        const c = d.clients.find((x) => x.id === r.client_id);
        if (!c) continue;
        const left = await csAdvance(seq, flow, r, c, d, tenant, stats, { budget, deadline, now });
        budget = left;
      }
    }
  }
  return stats;
}

/** Moves one client along: does the step it's on, then the next ones that are due right away; stops at a wait. */
async function csAdvance(seq: any, flow: CsNode[], r: any, c: any, d: CsTenant, tenant: string, stats: any, lim: { budget: number; deadline: number; now: number }): Promise<number> {
  let budget = lim.budget;
  let ptr: string | null = r.node ?? String(Math.max(0, Number(r.step) || 0));
  let lastLog: string | null = r.last_log_id ?? null;
  let waitUntil: string | null = r.wait_until ?? null;
  let sentAny = false;
  const ev = (node: string | null, kind: string, detail: Record<string, unknown> = {}) => csEvent({ tenant_id: tenant, run_id: r.id, sequence_id: seq.id, client_id: c.id, node, kind, detail });
  const save = async (patch: Record<string, unknown>) => {
    const full: Record<string, unknown> = { ...patch, last_log_id: lastLog, ...(sentAny ? { last_sent_at: new Date().toISOString() } : {}) };
    let up = await admin.from("cs_sequence_runs").update(full).eq("id", r.id);
    if (up.error && /node|wait_until|last_log_id/i.test(up.error.message)) {
      const { node: _a, wait_until: _b, last_log_id: _c, ...old } = full as any;
      up = await admin.from("cs_sequence_runs").update(old).eq("id", r.id);
    }
  };
  /** the end: round again (repeat), wait for the next quiet spell, or done */
  const finish = async () => {
    await ev(ptr, "end");
    if (seq.repeat && !(Number(seq.audience?.quiet_days) > 0) && seq.kind !== "campaign") {
      let at = Date.now() + Math.max(1, Number(seq.start_days) || 30) * CS_DAY + csDelayOf(flow[0]);
      if (seq.start_mode === "before_renewal") { const ren = d.renewalOf(c.id, Date.now() + ((Number(seq.start_days) || 0) + 1) * CS_DAY); at = ren ? ren.getTime() - (Number(seq.start_days) || 0) * CS_DAY + csDelayOf(flow[0]) : Date.now() + 365 * CS_DAY; }
      await save({ step: 0, node: "0", wait_until: null, cycle: (Number(r.cycle) || 0) + 1, next_at: new Date(at).toISOString() });
    } else { await save({ status: "done", next_at: null, wait_until: null }); stats.finished += 1; }
  };
  /** on to `next`: due now (keep going) or later (save and stop) */
  const go = async (next: string | null, minGap = 0): Promise<boolean> => {
    if (!next) { await finish(); return false; }
    const n = csNodeAt(flow, next);
    const wait = Math.max(csDelayOf(n), minGap);
    ptr = next; waitUntil = null;
    if (wait > 0) { await save({ node: next, step: Number(next.split("/")[0]) || 0, wait_until: null, next_at: new Date(Date.now() + wait).toISOString() }); return false; }
    return true;
  };
  for (let guard = 0; guard < 16; guard++) {
    const n = csNodeAt(flow, ptr);
    if (!n) { await finish(); return budget; }
    if (n.type === "stop") { await finish(); return budget; }

    if (n.type === "email") {
      const t0 = n.template_id ? d.templates[n.template_id] : null;
      const t = t0 ? csVersionOf(t0, c, d) : t0;
      const me0 = seq.kind === "campaign" ? (seq.launched_by ?? seq.created_by) : seq.created_by;
      const sender = seq.sender === "owner" ? (d.owner[c.id] ?? me0) : me0;
      const fromBox = String(seq.from_address ?? "").trim() || null;
      // addresses switched off in the editor (audience.exclude_emails) never get it
      const offMail = new Set(((seq.audience?.exclude_emails ?? []) as string[]).map((e) => lc(e)));
      const to = csRecipients(c, seq.recipients, r.to_emails).filter((e) => !offMail.has(lc(e)));
      const base: Record<string, unknown> = { tenant_id: tenant, sequence_id: seq.id, run_id: r.id, client_id: c.id, template_id: t?.id ?? null, step: Number(ptr!.split("/")[0]) || 0, node: ptr, sent_by: sender, variant: t?._variant ?? null };
      let skip: string | null = null;
      if (!t) skip = "The e-mail blueprint of this step was deleted.";
      else if (!to.length) skip = offMail.size && csRecipients(c, seq.recipients, r.to_emails).length ? "Everyone at this client was left out of it." : "No e-mail address for this client (add a contact with an e-mail).";
      else if (!sender) skip = "Nobody to send it from (no owner).";
      let sentNow = 0, failedNow = 0, throttled = false;
      if (skip) {
        const { node: _n, ...b2 } = base as any;
        const ins = await admin.from("cs_email_log").insert({ ...base, to_emails: to, subject: t?.subject ?? null, status: "skipped", error: skip });
        if (ins.error) await admin.from("cs_email_log").insert({ ...b2, to_emails: to, subject: t?.subject ?? null, status: "skipped", error: skip });
        stats.skipped += 1;
      } else {
        // whoever already got this step (an interrupted run) is not sent it again
        const { data: done } = await admin.from("cs_email_log").select("id, to_emails").eq("run_id", r.id).eq("node", ptr).eq("status", "sent").gte("sent_at", r.next_at ?? new Date(0).toISOString());
        const already = new Set(((done ?? []) as any[]).flatMap((x) => (x.to_emails ?? []).map((e: string) => lc(e))));
        if ((done ?? []).length) lastLog = (done as any[])[0].id;
        const cts = (Array.isArray(c.contacts) ? c.contacts : []) as any[];
        for (const email of to) {
          if (already.has(lc(email))) { sentNow += 1; continue; }
          if (budget <= 0 || (lim.deadline && Date.now() > lim.deadline)) { throttled = true; break; }
          const person = cts.find((x) => lc(x?.email) === lc(email)) ?? { email, name: "" };
          const vars = csVars(c, d, sender, person);
          const subject = csFill(t.subject, vars, false);
          budget -= 1;
          const res = await csSendLogged(base, sender!, email, subject, csFill(csHtmlOf(t), vars, true), t.attachments ?? [], vars, fromBox);
          if (res.err === "throttled") { throttled = true; break; }
          if (res.err) { failedNow += 1; stats.failed += 1; stats.errors.push(`${c.name} · ${email}: ${res.err}`); }
          else { sentNow += 1; stats.sent += 1; sentAny = true; if (res.logId) lastLog = res.logId; }
        }
      }
      if (throttled) { if (sentAny) await save({ node: ptr }); return budget; }   // the rest on the next run (next_at stays)
      if (!skip && !sentNow && failedNow) { await save({ node: ptr, next_at: new Date(Date.now() + CS_DAY).toISOString() }); return budget; }
      if (!skip && sentNow && seq.log_contact) await admin.from("client_contacts_log").insert({ tenant_id: tenant, client_id: c.id, contacted_at: new Date().toISOString(), channel: "email", direction: "out", source: "auto", reason: `Automatic e-mail · ${t.name}${to.length > 1 ? ` (${to.length} people)` : ""}`, logged_by: sender });
      await ev(ptr, "email", { template: t?.name ?? null, sent: sentNow, failed: failedNow, skipped: skip });
      // two e-mails in a row are at least an hour apart
      const next = csNextPtr(flow, ptr!);
      const nn = csNodeAt(flow, next);
      if (!(await go(next, nn?.type === "email" ? 3600_000 : 0))) return budget;
      continue;
    }

    if (n.type === "task") {
      const who = new Set<string>();
      const a = String(n.assign ?? "owners");
      if (a === "owners") (d.owners[c.id] ?? []).forEach((x: string) => who.add(x));
      else if (a === "primary") { if (d.owner[c.id]) who.add(d.owner[c.id]); }
      else if (a === "sender") { const s = seq.launched_by ?? seq.created_by; if (s) who.add(s); }
      else if (CS_UUID.test(a)) who.add(a);
      if (!who.size) { const s = seq.launched_by ?? seq.created_by; if (s) who.add(s); }
      const vars = csVars(c, d, [...who][0] ?? null);
      const title = csFill(String(n.title || "Follow up with {{client}}"), vars, false).slice(0, 300);
      const lg = lastLog ? (await admin.from("cs_email_log").select("subject, opened_at, clicked_at, replied_at").eq("id", lastLog).maybeSingle()).data as any : null;
      const what = lg ? (lg.replied_at ? "replied to" : lg.clicked_at ? "clicked a link in" : lg.opened_at ? "opened" : "hasn't opened") : null;
      const desc = [csFill(String(n.notes ?? ""), vars, false), `From the customer success sequence "${seq.name}"${lg && what ? ` — ${c.name} ${what} "${lg.subject ?? "the e-mail"}"` : ""}.`].filter(Boolean).join("\n\n");
      const due = new Date(Date.now() + Math.max(0, Number(n.due_days) || 0) * CS_DAY).toISOString();
      let made = 0;
      for (const p of who) {
        const { error: te } = await admin.from("tracking_tasks").insert({ tenant_id: tenant, tracking_id: null, title, description: desc, kind: "quick", priority: "normal", status: "todo", progress: 0, due_at: due, client_id: c.id, assignee_id: p, source: "manual", external_ref: `cs-seq:${seq.id}:${r.id}:${ptr}`, created_by: p });
        if (!te) made += 1; else stats.errors.push(`${c.name} · task: ${te.message}`);
      }
      stats.tasks += made;
      await ev(ptr, "task", { title, people: [...who], made });
      if (!(await go(csNextPtr(flow, ptr!)))) return budget;
      continue;
    }

    if (n.type === "branch") {
      const days = Math.max(0, Number(n.days) || 0);
      // just got here: start waiting for the e-mail before it
      if (!waitUntil || r.node !== ptr) {
        waitUntil = new Date(Date.now() + days * CS_DAY).toISOString();
        r.node = ptr;
      }
      let lane: string | null = null;
      let seen = { replied: false, opened: false, clicked: false };
      if (lastLog) {
        const { data: one } = await admin.from("cs_email_log").select("node, run_id").eq("id", lastLog).maybeSingle();
        const { data: all } = await admin.from("cs_email_log").select("opened_at, clicked_at, replied_at").eq("run_id", (one as any)?.run_id ?? r.id).eq("node", (one as any)?.node ?? "").eq("status", "sent");
        ((all ?? []) as any[]).forEach((x) => { if (x.replied_at) seen.replied = true; if (x.opened_at) seen.opened = true; if (x.clicked_at) seen.clicked = true; });
      }
      if (seen.replied) lane = "replied";
      else if (Date.now() >= new Date(waitUntil).getTime()) lane = seen.opened || seen.clicked ? "opened" : "none";
      if (!lane) {
        // check again in an hour (a reply is followed straight away), at the latest at the deadline
        const nextCheck = Math.min(new Date(waitUntil).getTime(), Date.now() + 3600_000);
        await save({ node: ptr, wait_until: waitUntil, next_at: new Date(Math.max(nextCheck, Date.now() + 5 * 60_000)).toISOString() });
        return budget;
      }
      stats.branched += 1;
      await ev(ptr, "branch", { lane, ...seen });
      if (!(await go(csLanePtr(flow, ptr!, lane)))) return budget;
      continue;
    }
    await finish(); return budget;
  }
  await save({ node: ptr, wait_until: waitUntil });
  return budget;
}

/** A one-time campaign: the clients it applies to right now are taken in and its first steps go out;
 *  the follow-ups and branches carry on by themselves (hourly). */
async function csCampaign(userId: string, p: any): Promise<Response> {
  const { data: prof } = await admin.from("profiles").select("tenant_id").eq("id", userId).maybeSingle();
  const tenant = (prof as any)?.tenant_id;
  if (!tenant) return json({ error: "No company." }, 400);
  const { data: seq, error } = await admin.from("cs_sequences").select("*").eq("id", p.sequenceId).eq("tenant_id", tenant).maybeSingle();
  if (error) return json({ error: /kind|launched|column/i.test(error.message) ? "Run 108_cs_campaigns.sql in Supabase." : error.message }, 400);
  if (!seq) return json({ error: "Save the campaign first." }, 400);
  if ((seq as any).kind !== "campaign") return json({ error: "That's a sequence, not a one-time campaign." }, 400);
  if ((seq as any).launched_at) return json({ error: "This campaign was already sent — copy it to send it again." }, 400);
  if (p.confirm !== (seq as any).id) return json({ error: "Confirm the sending first." }, 400);
  if (!csFlowOf(seq).length) return json({ error: "Add its first e-mail." }, 400);
  const d = await csTenantData(tenant);
  const now = new Date().toISOString();
  const { error: ue } = await admin.from("cs_sequences").update({ launched_at: now, launched_by: userId, active: true, updated_at: now }).eq("id", (seq as any).id).is("launched_at", null);
  if (ue) return json({ error: ue.message }, 400);
  let enrolled = 0;
  const rows = d.clients.filter((c) => csMatches((seq as any).audience, c, d.health))
    .map((c) => ({ tenant_id: tenant, sequence_id: (seq as any).id, client_id: c.id, step: 0, node: "0", status: "active", next_at: now, started_at: now }));
  for (let i = 0; i < rows.length; i += 200) {
    const up = { onConflict: "sequence_id,client_id", ignoreDuplicates: true };
    let ins = await admin.from("cs_sequence_runs").upsert(rows.slice(i, i + 200), up);
    if (ins.error && /started_at|node/i.test(ins.error.message)) ins = await admin.from("cs_sequence_runs").upsert(rows.slice(i, i + 200).map(({ started_at: _s, node: _n, ...r }) => r), up);
    if (ins.error) return json({ error: ins.error.message }, 400);
    enrolled += Math.min(200, rows.length - i);
  }
  const stats = await csRun(tenant, 400, (seq as any).id, Date.now() + 110_000);
  const { count } = await admin.from("cs_sequence_runs").select("id", { count: "exact", head: true }).eq("sequence_id", (seq as any).id).eq("status", "active");
  return json({ ...stats, enrolled, waiting: count ?? 0, launched_at: now });
}

/* =====================================================================
   Team mailboxes (e.g. a Microsoft 365 shared mailbox like CS Iberia): read so that a client's
   reply to an e-mail sent from it is seen. Through the organisation's access (Mail.Read for the app),
   or the Outlook connection of someone of the company with "Full Access" on that mailbox.
   ===================================================================== */
async function csTeamBoxes(tenant: string): Promise<string[]> {
  const [s, b] = await Promise.all([
    admin.from("cs_sequences").select("from_address").eq("tenant_id", tenant).not("from_address", "is", null),
    admin.from("ticket_mailboxes").select("address, kind, active").eq("tenant_id", tenant),
  ]);
  const xs = [...((s.data ?? []) as any[]).map((x) => x.from_address), ...((b.data ?? []) as any[]).filter((x) => x.kind !== "personal" && x.active !== false).map((x) => x.address)];
  return [...new Set(xs.map((x) => lc(x)).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
}
async function csBoxToken(address: string, tenant: string): Promise<{ token: string; via: string } | null> {
  const app = await csAppToken(csDom(address));
  if (app) return { token: app, via: "organisation" };
  const { data: ps } = await admin.from("profiles").select("id").eq("tenant_id", tenant);
  const ids = ((ps ?? []) as any[]).map((p) => p.id);
  const { data: toks } = await admin.from("outlook_tokens").select("user_id, scopes, account_email").in("user_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  for (const t of (toks ?? []) as any[]) {
    if (!/Mail\.Read\.Shared/i.test(String(t.scopes ?? ""))) continue;
    const tok = await accessTokenFor(t.user_id).catch(() => null);
    if (!tok) continue;
    const res = await fetch(`${GRAPH}/users/${encodeURIComponent(address)}/messages?$top=1&$select=id`, { headers: { Authorization: `Bearer ${tok}` } });
    if (res.ok) return { token: tok, via: t.account_email ?? "someone" };
  }
  return null;
}
async function csMailboxScan(address: string, tenant: string, book: CsBook, maxPages: number, deadline: number) {
  const out = { address, scanned: 0, logged: 0, more: false, error: null as string | null, via: null as string | null };
  const access = await csBoxToken(address, tenant);
  const { data: st } = await admin.from("cs_mailbox_sync").select("*").eq("address", address).maybeSingle();
  if (!access) {
    out.error = `Can't read ${address}: give the person who sends from it "Full Access" on it in Microsoft 365, and have them connect Outlook with mail again.`;
    await admin.from("cs_mailbox_sync").upsert({ address, tenant_id: tenant, last_run_at: new Date().toISOString(), last_error: out.error, read_after: (st as any)?.read_after ?? null });
    return out;
  }
  out.via = access.via;
  const after = new Date((st as any)?.read_after ?? Date.now() - 30 * CS_DAY).toISOString();
  const sel = "from,toRecipients,ccRecipients,subject,receivedDateTime,sentDateTime,internetMessageId,isDraft";
  let url: string | null = `${GRAPH}/users/${encodeURIComponent(address)}/messages?$select=${sel}&$filter=${encodeURIComponent(`receivedDateTime ge ${after}`)}&$orderby=receivedDateTime%20asc&$top=200`;
  let newest = after;
  const found = new Map<string, Record<string, unknown>>();
  for (let p = 0; url && p < maxPages && Date.now() < deadline; p++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${access.token}`, Prefer: 'outlook.timezone="UTC"' } });
    if (res.status === 429) { out.error = "Outlook is busy, it carries on later"; break; }
    if (!res.ok) { out.error = `Outlook said: ${(await res.text()).slice(0, 200)}`; break; }
    const j = await res.json();
    for (const m of (j.value ?? []) as any[]) {
      out.scanned += 1;
      if (m.receivedDateTime) { const t = new Date(m.receivedDateTime).toISOString(); if (t > newest) newest = t; }
      if (m.isDraft || !m.internetMessageId) continue;
      const from = lc(m.from?.emailAddress?.address);
      if (from === address || book.own.has(csDom(from))) continue;   // what we send is logged when it goes out
      const subject = String(m.subject ?? "").trim().slice(0, 300) || "(no subject)";
      book.match(from).forEach((x) => {
        const k = `${x.client}|${m.internetMessageId}`;
        if (!found.has(k)) found.set(k, { tenant_id: tenant, client_id: x.client, contacted_at: m.receivedDateTime, channel: "email", direction: "in", source: "email", reason: subject, contact_name: csCap(m.from?.emailAddress?.name || x.name) || null, contact_email: from || null, external_id: m.internetMessageId, logged_by: null });
      });
    }
    url = j["@odata.nextLink"] ?? null;
  }
  out.more = !!url && !out.error;
  const rows = [...found.values()];
  let saved = true;
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await admin.from("client_contacts_log").upsert(rows.slice(i, i + 200), { onConflict: "client_id,external_id", ignoreDuplicates: true }).select("id");
    if (error) { out.error = error.message; saved = false; break; }
    out.logged += (data ?? []).length;
  }
  await admin.from("cs_mailbox_sync").upsert({ address, tenant_id: tenant, read_after: saved ? newest : after, scanned: (Number((st as any)?.scanned) || 0) + out.scanned,
    logged: (Number((st as any)?.logged) || 0) + out.logged, last_run_at: new Date().toISOString(), last_error: out.error, via: out.via });
  return out;
}
async function csTeamScanAll(tenantOnly: string | null, maxPages: number, deadline: number) {
  const out: any[] = [];
  let tenants: string[] = [];
  if (tenantOnly) tenants = [tenantOnly];
  else {
    const { data } = await admin.from("cs_sequences").select("tenant_id").eq("active", true);
    tenants = [...new Set(((data ?? []) as any[]).map((x) => x.tenant_id).filter(Boolean))];
  }
  for (const t of tenants) {
    const boxes = await csTeamBoxes(t);
    if (!boxes.length) continue;
    const book = await csAddressBook(t);
    for (const b of boxes) {
      if (Date.now() > deadline) break;
      out.push(await csMailboxScan(b, t, book, maxPages, deadline).catch((e) => ({ address: b, error: String(e) })));
    }
  }
  return out;
}

Deno.serve(async (req) => {
  const u0 = new globalThis.URL(req.url);
  if (req.method === "GET" && u0.searchParams.has("t")) {
    try { return await csHandleTrack(u0); } catch { return new Response(CS_GIF, { headers: { "Content-Type": "image/gif" } }); }
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // hourly (pg_cron + pg_net, 114_cs_flows.sql): every company — read the mailboxes (replies), then move the sequences on
    const csKey = req.headers.get("x-cs-cron");
    if (csKey) {
      const { data: k } = await admin.from("cs_cron_key").select("key").eq("id", 1).maybeSingle();
      if (!k || (k as any).key !== csKey) return json({ error: "Forbidden" }, 403);
      const t0 = Date.now();
      const team = await csTeamScanAll(null, 10, t0 + 35_000).catch((e) => ({ error: String(e) }));
      const mail = await csMailScanAll(null, 15, t0 + 60_000).catch((e) => ({ error: String(e) }));
      const sent = await csRun(null, 120, null, t0 + 140_000);
      return json({ ...sent, mail, team });
    }
    const userId = await userFromRequest(req);
    if (!userId) return json({ error: "Not authenticated" }, 401);
    const { action, ...p } = await req.json();
    const tenantOf = async () => ((await admin.from("profiles").select("tenant_id").eq("id", userId).maybeSingle()).data as any)?.tenant_id ?? null;
    if (action === "cs_run") {
      const tenant = await tenantOf();
      if (!tenant) return json({ error: "No company." }, 400);
      const team = await csTeamScanAll(tenant, 4, Date.now() + 20_000).catch(() => []);
      return json({ ...(await csRun(tenant, 60, null, Date.now() + 90_000)), team });
    }
    if (action === "cs_test") return await csTest(userId, p);
    if (action === "cs_campaign") return await csCampaign(userId, p);
    if (action === "cs_attachment_preview") {
      const tenant = await tenantOf();
      const a = p.attachment ?? {};
      if (!tenant || !String(a.path ?? "").startsWith(`${tenant}/`)) return json({ error: "Not your file." }, 403);
      const { data: file, error: fe } = await admin.storage.from("cs-files").download(a.path);
      if (fe || !file) return json({ error: "The file is missing." }, 404);
      const d = await csTenantData(tenant);
      const c = d.clients.find((x) => x.id === p.clientId) ?? d.clients[0] ?? { id: "", name: "Your client", contacts: [] };
      const f = await csPersonalize(a, await file.arrayBuffer(), csVars(c, d, userId));
      return json({ name: f.name, contentType: f.type, contentBytes: csB64(f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer) });
    }
    if (action === "cs_mail_scan") {
      const tenant = await tenantOf();
      if (!tenant) return json({ error: "No company." }, 400);
      const team = await csTeamScanAll(tenant, 6, Date.now() + 20_000).catch(() => []);
      return json({ ...(await csMailScanAll(tenant, 12, Date.now() + 45_000)), team });
    }
    /** can the team mailbox be read (for replies)? */
    if (action === "cs_box_check") {
      const tenant = await tenantOf();
      const address = lc(p.address);
      if (!tenant || !address) return json({ error: "No mailbox." }, 400);
      const a = await csBoxToken(address, tenant);
      return json({ readable: !!a, via: a?.via ?? null });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
