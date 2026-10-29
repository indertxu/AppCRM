// Supabase Edge Function: one-way calendar sync to Outlook (Microsoft Graph).
// Actions:
//   connect  — exchange an OAuth auth code for tokens, store them for the user
//   status   — is the user connected?
//   disconnect
//   upsert   — create or update the Outlook event for a calendar entry
//              (subject, a details table, attendees that Outlook invites,
//              a Teams link when asked, location)
//   delete   — remove the Outlook event for a calendar entry (with entryId:
//              from the organiser's Outlook, whoever deletes it)
//   check    — which of these deal meetings were deleted/cancelled in Outlook
//
//   Ticket desk e-mail (needs the mail permissions, asked when you connect "with mail"):
//   mail_status   — connected? with mail? which address?
//   mail_sync     — read new mail of the desk's mailboxes (your inbox if you monitor it,
//                   and shared / department ones), thread replies into their tickets,
//                   apply the mail rules, keep the rest in the desk's Inbox
//   mail_sync_all — the same for everyone (scheduled; needs the x-cron-secret header)
//   mail_send     — send an e-mail (from you or a shared mailbox you may send as);
//                   when ref is "ticket:<id>" it is kept on that ticket's thread
//   mail_attachment — the bytes of one attachment of a received e-mail
//
// Secrets required (supabase secrets set ...):
//   MS_CLIENT_ID, MS_CLIENT_SECRET
//   CRON_SECRET (only for the scheduled mail_sync_all)
//
// Uses the caller's Supabase JWT to identify the user; never trusts a user_id from the body.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

async function exchangeCode(code: string, redirectUri: string, codeVerifier: string, scope = BASE_SCOPE) {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope,
    code_verifier: codeVerifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return await res.json();
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

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Build the Outlook event from the entry payload. New callers send a subject
// and a list of [label, value] details; older ones send the loose fields.
function buildEvent(p: any) {
  const rows: [string, string][] = Array.isArray(p.details) && p.details.length
    ? p.details.filter((d: any) => Array.isArray(d) && d[1])
    : ([
        ["Meeting", p.meetingType], ["Deal", p.deal], ["Type of work", p.workType], ["Client", p.client],
        ["Project", p.project], ["Phase", p.phase], ["Tasks", p.tasks],
      ].filter(([, v]) => !!v) as [string, string][]);
  const text = String(p.description ?? p.notes ?? "").trim();
  const html =
    `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0b241a">` +
    (rows.length
      ? `<table style="border-collapse:collapse;margin:0 0 12px">` +
        rows.map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#5a7d6d;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0;font-weight:600">${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("") +
        `</table>`
      : "") +
    (text ? `<p style="margin:0 0 12px;white-space:pre-wrap">${esc(text)}</p>` : "") +
    `<p style="margin:12px 0 0;color:#8a9a93;font-size:12px">Synced from the CRM calendar</p></div>`;
  const subject = p.subject
    || (p.kind === "meeting" ? [p.client, p.description].filter(Boolean).join(" · ") : "")
    || [p.client, p.project].filter(Boolean).join(" · ") || p.workType || "Work";
  const event: Record<string, unknown> = {
    subject,
    body: { contentType: "HTML", content: html },
    start: { dateTime: `${p.date}T${hhmm(p.startMin)}:00`, timeZone: p.timeZone || "Europe/Madrid" },
    end: { dateTime: `${p.date}T${hhmm(p.endMin)}:00`, timeZone: p.timeZone || "Europe/Madrid" },
  };
  if (p.location) event.location = { displayName: String(p.location) };
  if (Array.isArray(p.attendees)) {
    const seen = new Set<string>();
    event.attendees = p.attendees
      .filter((a: any) => a?.email && !seen.has(a.email.toLowerCase()) && seen.add(a.email.toLowerCase()))
      .map((a: any) => ({ emailAddress: { address: a.email, name: a.name || a.email }, type: "required" }));
  }
  if (p.online) { event.isOnlineMeeting = true; event.onlineMeetingProvider = "teamsForBusiness"; }
  return event;
}

const graph = (token: string, path: string, method = "GET", body?: unknown) =>
  fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: 'outlook.timezone="UTC"' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Whose Outlook an entry lives in: the organiser of the row, else the caller. */
async function ownerOf(entryId: string | undefined, fallback: string): Promise<string> {
  if (!entryId) return fallback;
  const { data } = await admin.from("calendar_entries").select("user_id").eq("id", entryId).maybeSingle();
  return (data as any)?.user_id ?? fallback;
}

/* =====================================================================
   Ticket desk e-mail
   ===================================================================== */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
/** A database client acting as the caller (row rules and the tenant triggers apply as for them). */
function userClient(req: Request) {
  return createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
}
// deno-lint-ignore no-explicit-any
type Db = any;

/** "/me" for the user's own inbox, "/users/{address}" for a shared one. */
async function mailboxBase(mailboxId: string | null | undefined, userId: string): Promise<string> {
  if (!mailboxId) return "/me";
  const { data } = await admin.from("ticket_mailboxes").select("kind, address, owner_id").eq("id", mailboxId).maybeSingle();
  if (!data || ((data as any).kind === "personal" && (data as any).owner_id === userId)) return "/me";
  return `/users/${encodeURIComponent((data as any).address)}`;
}

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const addr = (r: any) => ({ name: r?.emailAddress?.name ?? "", email: lc(r?.emailAddress?.address) });
const stripHtml = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const REF_RE = /\[T-(\d{3,})\]/i;

interface Rule {
  id: string; name: string; sort: number; active: boolean; conditions: any; action: "create" | "append" | "ignore" | "file";
  target_ticket_id: string | null; set_fields: any; hits: number;
  scope?: "desk" | "client" | null;   // client: the mail belongs in that client's Emails (72_mail_routing.sql)
  owner_id?: string | null;           // someone's own rule: runs first, on their own inbox only
}

/** Does an incoming message match a rule? */
function ruleMatches(rule: Rule, m: any, ctx: { contactIds: string[]; companyIds: string[]; mailbox: string }): boolean {
  const c = rule.conditions ?? {};
  const tests: boolean[] = [];
  const from = lc(m.from?.email);
  const fromAll = `${lc(m.from?.name)} ${from}`;
  if (c.from_contains) tests.push(fromAll.includes(lc(c.from_contains)));
  if (Array.isArray(c.from_emails) && c.from_emails.length) tests.push(c.from_emails.map(lc).some((e: string) => e && (from === e || (e.startsWith("@") && from.endsWith(e)))));
  if (Array.isArray(c.from_contact_ids) && c.from_contact_ids.length) tests.push(ctx.contactIds.some((id) => c.from_contact_ids.includes(id)));
  if (c.from_company_id) tests.push(ctx.companyIds.includes(c.from_company_id));
  if (c.mailbox) {
    const to = [...(m.to ?? []), ...(m.cc ?? [])].map((x: any) => x.email);
    tests.push(to.includes(lc(c.mailbox)) || lc(ctx.mailbox) === lc(c.mailbox));
  }
  if (c.subject_contains) tests.push(lc(m.subject).includes(lc(c.subject_contains)));
  if (c.subject_regex) { try { tests.push(new RegExp(c.subject_regex, "i").test(m.subject ?? "")); } catch { tests.push(false); } }
  if (c.body_contains) tests.push(lc(m.text).includes(lc(c.body_contains)));
  if (!tests.length) return false;            // a rule without conditions never fires
  return c.match === "any" ? tests.some(Boolean) : tests.every(Boolean);
}

/** Read new mail for one user: their monitored inbox and the shared mailboxes they read. */
async function syncMailFor(userId: string, db: Db | null): Promise<Record<string, unknown>> {
  const { data: tokRow } = await admin.from("outlook_tokens").select("*").eq("user_id", userId).maybeSingle();
  if (!tokRow) return { skipped: "not_connected" };
  if (!hasMail((tokRow as any).scopes)) return { skipped: "no_mail_permission" };
  const token = await accessTokenFor(userId);
  if (!token) return { skipped: "not_connected" };
  const { data: prof } = await admin.from("profiles").select("tenant_id").eq("id", userId).maybeSingle();
  const tenant = (prof as any)?.tenant_id ?? null;
  const write: Db = db ?? (admin as unknown as Db);
  const withTenant = (row: Record<string, unknown>) => (db ? row : { ...row, tenant_id: tenant });

  const { data: boxes, error: boxErr } = await admin.from("ticket_mailboxes").select("*")
    .eq("tenant_id", tenant).eq("active", true);
  if (boxErr) return { error: /relation|does not exist/i.test(boxErr.message) ? "Run 19_ticket_mail.sql" : boxErr.message };
  const mine = ((boxes ?? []) as any[]).filter((b) => (b.kind === "personal" ? b.owner_id === userId : !b.owner_id || b.owner_id === userId));
  if (!mine.length) return { synced: 0, note: "No mailbox to read: add one in the desk's Mail settings." };

  const { data: ruleRows } = await admin.from("ticket_mail_rules").select("*").eq("tenant_id", tenant).eq("active", true).order("sort");
  const rules = (ruleRows ?? []) as Rule[];
  const stats = { read: 0, stored: 0, threaded: 0, created: 0, ignored: 0, filed: 0, inbox: 0, errors: [] as string[] };

  for (const box of mine) {
    const base = box.kind === "personal" ? "/me" : `/users/${encodeURIComponent(box.address)}`;
    const select = "subject,from,toRecipients,ccRecipients,receivedDateTime,conversationId,internetMessageId,bodyPreview,body,hasAttachments";
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    let url: string | null = box.delta_link
      || `${GRAPH}${base}/mailFolders/inbox/messages/delta?$select=${select}&$filter=receivedDateTime+ge+${since}`;
    let pages = 0, nextSaved: string | null = null;
    try {
      while (url && pages < 10) {
        pages += 1;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'odata.maxpagesize=50, outlook.body-content-type="html"' } });
        if (res.status === 410) { url = null; nextSaved = null; await admin.from("ticket_mailboxes").update({ delta_link: null }).eq("id", box.id); break; }   // sync state expired: start over next time
        if (res.status === 429) { stats.errors.push(`${box.address}: throttled, retry after ${res.headers.get("Retry-After") ?? "?"}s`); break; }
        if (!res.ok) { const t = await res.text(); stats.errors.push(`${box.address}: ${t.slice(0, 200)}`); await admin.from("ticket_mailboxes").update({ last_error: t.slice(0, 500) }).eq("id", box.id); url = null; break; }
        const page = await res.json();
        for (const g of (page.value ?? []) as any[]) {
          if (g["@removed"]) continue;
          stats.read += 1;
          await handleIncoming(g, box, base, token, tenant, userId, rules, write, withTenant, stats);
        }
        if (page["@odata.deltaLink"]) { nextSaved = page["@odata.deltaLink"]; url = null; }
        else { url = page["@odata.nextLink"] ?? null; nextSaved = url; }
      }
      await admin.from("ticket_mailboxes").update({ delta_link: nextSaved ?? box.delta_link, last_sync_at: new Date().toISOString(), last_error: null }).eq("id", box.id);
    } catch (e) {
      stats.errors.push(`${box.address}: ${String(e)}`);
    }
  }
  return stats;
}

async function handleIncoming(g: any, box: any, base: string, token: string, tenant: string | null, userId: string, rules: Rule[],
  db: Db, withTenant: (r: Record<string, unknown>) => Record<string, unknown>, stats: any) {
  const msgId = g.internetMessageId ?? null;
  if (msgId) {
    const { data: seen } = await admin.from("ticket_mail_messages").select("id").eq("tenant_id", tenant).eq("internet_message_id", msgId).maybeSingle();
    if (seen) return;
  }
  const html = String(g.body?.content ?? "").slice(0, 200_000);
  const m = {
    from: addr(g.from), to: (g.toRecipients ?? []).map(addr), cc: (g.ccRecipients ?? []).map(addr),
    subject: g.subject ?? "", text: stripHtml(html) || g.bodyPreview || "",
  };
  // our own outgoing mail coming back (a shared mailbox in copy): skip
  if (box.address && m.from.email === lc(box.address) && box.kind === "shared") return;

  // who sent it, in the CRM
  const { data: cts } = await admin.from("contacts").select("id").eq("tenant_id", tenant).ilike("email", m.from.email || "-");
  const contactIds = ((cts ?? []) as any[]).map((c) => c.id);
  let companyIds: string[] = [];
  if (contactIds.length) {
    const { data: links } = await admin.from("company_contacts").select("company_id").in("contact_id", contactIds);
    companyIds = [...new Set(((links ?? []) as any[]).map((l) => l.company_id))];
  }

  // 1) a reply to a ticket: "[T-1042]" in the subject, or the same Outlook conversation
  let ticketId: string | null = null;
  const ref = REF_RE.exec(m.subject);
  if (ref) {
    const { data: t } = await admin.from("tracking_tasks").select("id, merged_into").eq("tenant_id", tenant).eq("ticket_no", Number(ref[1])).maybeSingle();
    if (t) ticketId = (t as any).merged_into ?? (t as any).id;
  }
  if (!ticketId && g.conversationId) {
    const { data: prev } = await admin.from("ticket_mail_messages").select("ticket_id").eq("tenant_id", tenant)
      .eq("conversation_id", g.conversationId).not("ticket_id", "is", null).order("received_at", { ascending: false }).limit(1).maybeSingle();
    if (prev) ticketId = (prev as any).ticket_id;
  }

  // 2) the rules: the owner's own rules first (on their own inbox), then the desk's, and the client rules apart
  const ctx = { contactIds, companyIds, mailbox: box.address };
  const own = box.kind === "personal" && box.owner_id
    ? rules.filter((r) => r.owner_id === box.owner_id && (r.scope ?? "desk") === "desk") : [];
  const team = rules.filter((r) => !r.owner_id && (r.scope ?? "desk") === "desk");
  const clientRule = rules.find((r) => !r.owner_id && r.scope === "client" && ruleMatches(r, m, ctx)) ?? null;
  let rule: Rule | null = null;
  if (!ticketId) rule = own.find((r) => ruleMatches(r, m, ctx)) ?? team.find((r) => ruleMatches(r, m, ctx)) ?? null;
  // a client rule set to "open a ticket" works as a desk rule when no desk rule took the mail
  if (!ticketId && !rule && clientRule?.action === "create") rule = clientRule;

  // which client it belongs to
  let ticketClient: string | null = null;
  if (ticketId) {
    const { data: tc } = await admin.from("tracking_tasks").select("client_id").eq("id", ticketId).maybeSingle();
    ticketClient = (tc as any)?.client_id ?? null;
  }
  let clientId: string | null = clientRule?.set_fields?.client_id || rule?.set_fields?.client_id || ticketClient || null;
  if (!clientId && companyIds.length) {
    const { data: cl } = await admin.from("clients").select("id").eq("tenant_id", tenant).in("company_id", companyIds).limit(1).maybeSingle();
    clientId = (cl as any)?.id ?? null;
  }
  if (rule && rule.action === "create" && clientId && !rule.set_fields?.client_id) rule = { ...rule, set_fields: { ...(rule.set_fields ?? {}), client_id: clientId } };

  let status: "new" | "assigned" | "ignored" | "filed" = "new";
  if (ticketId) { status = "assigned"; stats.threaded += 1; }
  else if (rule?.action === "ignore" && !clientRule) { status = "ignored"; stats.ignored += 1; }
  else if (!rule || rule.action === "ignore" || rule.action === "file") {
    if (clientRule && clientId) { status = "filed"; stats.filed = (stats.filed ?? 0) + 1; }
    else if (rule?.action === "ignore") { status = "ignored"; stats.ignored += 1; }
  }
  else if (rule?.action === "append" && rule.target_ticket_id) { ticketId = rule.target_ticket_id; status = "assigned"; stats.threaded += 1; }
  else if (rule?.action === "create") {
    const f = rule.set_fields ?? {};
    const row: Record<string, unknown> = withTenant({
      title: (m.subject || "(no subject)").slice(0, 300), description: m.text.slice(0, 4000),
      kind: "quick", priority: ["low", "normal", "high", "urgent"].includes(f.priority) ? f.priority : "normal",
      status: "todo", progress: 0, stage: "new", source: "email",
      ticket_type: f.type || null, assignee_id: f.assignee_id || (rule.owner_id ?? null), team: f.team || null,
      tags: Array.isArray(f.tags) ? f.tags : [],
      requester_name: m.from.name || null, requester_email: m.from.email || null, requester_contact_id: contactIds[0] ?? null,
      company_id: f.company_id || companyIds[0] || null, client_id: f.client_id || null,
      created_by: userId,
    });
    const { data: t, error } = await db.from("tracking_tasks").insert(row).select("id").single();
    if (error) stats.errors.push(`ticket from "${m.subject}": ${error.message}`);
    else { ticketId = (t as any).id; status = "assigned"; stats.created += 1; }
  }
  const hit = (r: Rule) => admin.from("ticket_mail_rules").update({ hits: (r.hits ?? 0) + 1, last_hit_at: new Date().toISOString() }).eq("id", r.id);
  if (rule) await hit(rule);
  if (clientRule && clientRule.id !== rule?.id) await hit(clientRule);

  // a personal inbox only keeps what concerns the desk or a client rule (unless told to keep everything)
  if (status === "new" && box.kind === "personal" && !box.store_all) return;
  if (status === "new") stats.inbox += 1;

  // attachments (names only; the bytes are fetched on demand)
  let attachments: any[] = [];
  if (g.hasAttachments) {
    try {
      const ar = await graph(token, `${base}/messages/${g.id}/attachments?$select=id,name,size,contentType,isInline`);
      if (ar.ok) attachments = (((await ar.json()).value ?? []) as any[]).filter((a) => !a.isInline).map((a) => ({ id: a.id, name: a.name, size: a.size, contentType: a.contentType }));
    } catch { /* names are a nicety */ }
  }
  const msgRow: Record<string, unknown> = {
    mailbox_id: box.id, direction: "in", graph_id: g.id, internet_message_id: msgId, conversation_id: g.conversationId ?? null,
    from_name: m.from.name || null, from_email: m.from.email || null, to_recipients: m.to, cc_recipients: m.cc,
    subject: m.subject, snippet: (g.bodyPreview ?? m.text).slice(0, 400), body_html: html,
    received_at: g.receivedDateTime ?? new Date().toISOString(), has_attachments: !!g.hasAttachments, attachments,
    ticket_id: ticketId, rule_id: rule?.id ?? clientRule?.id ?? null, status,
    client_id: clientId, contact_id: contactIds[0] ?? null,
  };
  let { error: insErr } = await db.from("ticket_mail_messages").insert(withTenant(msgRow));
  if (insErr && /client_id|contact_id|status_check|check constraint/i.test(insErr.message)) {
    // 72_mail_routing.sql not run yet: store it the old way
    const { client_id: _c, contact_id: _k, ...old } = msgRow;
    ({ error: insErr } = await db.from("ticket_mail_messages").insert(withTenant({ ...old, status: status === "filed" ? "new" : status })));
  }
  if (insErr && !/duplicate|unique/i.test(insErr.message)) { stats.errors.push(`store "${m.subject}": ${insErr.message}`); return; }
  stats.stored += 1;

  // the requester wrote back: a waiting / resolved ticket comes back to the desk
  if (ticketId && status === "assigned" && !(rule?.action === "create")) {
    const { data: t } = await admin.from("tracking_tasks").select("stage, requester_email").eq("id", ticketId).maybeSingle();
    const patch: Record<string, unknown> = {};
    if (t && ["waiting", "resolved"].includes((t as any).stage)) patch.stage = "open";
    if (t && !(t as any).requester_email && m.from.email) { patch.requester_email = m.from.email; patch.requester_name = m.from.name || null; }
    if (Object.keys(patch).length) await db.from("tracking_tasks").update(patch).eq("id", ticketId);
  }
}

/** Send an e-mail as the user (or from a shared mailbox they may send as). */
async function sendMail(userId: string, p: any, db: Db): Promise<Response> {
  const { data: tokRow } = await admin.from("outlook_tokens").select("*").eq("user_id", userId).maybeSingle();
  if (!tokRow) return json({ error: "Connect Outlook first (Settings › Interface)." }, 400);
  if (!hasMail((tokRow as any).scopes)) return json({ error: "mail_scope_missing" }, 400);
  const token = await accessTokenFor(userId);
  if (!token) return json({ error: "Connect Outlook first." }, 400);
  const list = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((e) => String(e).trim()).filter(Boolean)
    .map((e) => ({ emailAddress: { address: e } }));
  const to = list(p.to);
  if (!to.length) return json({ error: "No recipient." }, 400);
  const own = lc((tokRow as any).account_email);
  const from = lc(p.from);
  const shared = !!from && from !== own;
  const message: Record<string, unknown> = {
    subject: String(p.subject ?? ""),
    body: { contentType: "HTML", content: String(p.html ?? "") },
    toRecipients: to, ccRecipients: list(p.cc), bccRecipients: list(p.bcc),
  };
  if (p.replyTo) message.replyTo = list([p.replyTo]);
  if (shared) message.from = { emailAddress: { address: from } };

  // Draft then send, so the message id is known (the thread stays linked) — only with write access;
  // with read + send only, a plain send (kept in Sent Items).
  const base = shared ? `/users/${encodeURIComponent(from)}` : "/me";
  const canDraft = /(^|\s)Mail\.ReadWrite/i.test((tokRow as any).scopes ?? "");
  const draft = canDraft ? await graph(token, `${base}/messages`, "POST", message) : new Response(null, { status: 403 });
  let info: any = null;
  if (draft.ok) {
    info = await draft.json();
    const sent = await graph(token, `${base}/messages/${info.id}/send`, "POST");
    if (sent.status === 429) return json({ error: "throttled", retryAfter: Number(sent.headers.get("Retry-After") ?? 30) }, 429);
    if (!sent.ok) return json({ error: `Graph error: ${await sent.text()}` }, 502);
  } else if (draft.status === 429) {
    return json({ error: "throttled", retryAfter: Number(draft.headers.get("Retry-After") ?? 30) }, 429);
  } else {
    // No draft rights on the shared mailbox: plain send (no message id).
    const target = shared ? `/users/${encodeURIComponent(from)}/sendMail` : "/me/sendMail";
    let res = await graph(token, target, "POST", { message, saveToSentItems: true });
    if (!res.ok && shared) res = await graph(token, "/me/sendMail", "POST", { message, saveToSentItems: true });   // "send as" from your own mailbox
    if (res.status === 429) return json({ error: "throttled", retryAfter: Number(res.headers.get("Retry-After") ?? 30) }, 429);
    if (!res.ok) return json({ error: `Graph error: ${await res.text()}` }, 502);
  }

  const ref = String(p.ref ?? "");
  if (ref.startsWith("ticket:")) {
    const ticketId = ref.slice(7);
    const { data: box } = from ? await admin.from("ticket_mailboxes").select("id").ilike("address", from).limit(1).maybeSingle() : { data: null };
    const { data: tk } = await admin.from("tracking_tasks").select("client_id").eq("id", ticketId).maybeSingle();
    const outRow: Record<string, unknown> = {
      mailbox_id: (box as any)?.id ?? null, direction: "out", graph_id: info?.id ?? null,
      internet_message_id: info?.internetMessageId ?? null, conversation_id: info?.conversationId ?? null,
      from_name: null, from_email: from || own || null,
      to_recipients: to.map((x) => ({ name: "", email: x.emailAddress.address })),
      cc_recipients: list(p.cc).map((x) => ({ name: "", email: x.emailAddress.address })),
      subject: message.subject, snippet: stripHtml(String(p.html ?? "")).slice(0, 400), body_html: String(p.html ?? "").slice(0, 200_000),
      received_at: new Date().toISOString(), ticket_id: ticketId, status: "assigned", sent_by: userId,
      client_id: (tk as any)?.client_id ?? null,
    };
    const { error: outErr } = await db.from("ticket_mail_messages").insert(outRow);
    if (outErr && /client_id/i.test(outErr.message)) { const { client_id: _c, ...old } = outRow; await db.from("ticket_mail_messages").insert(old); }
  }
  return json({ ok: true, messageId: info?.internetMessageId ?? info?.id ?? null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Scheduled run (pg_cron + pg_net): every connected mailbox, no user session.
    const cron = req.headers.get("x-cron-secret");
    if (cron) {
      if (!Deno.env.get("CRON_SECRET") || cron !== Deno.env.get("CRON_SECRET")) return json({ error: "Forbidden" }, 403);
      const { action } = await req.json().catch(() => ({ action: "" }));
      if (action !== "mail_sync_all") return json({ error: "Unknown action" }, 400);
      const { data: rows } = await admin.from("outlook_tokens").select("user_id, scopes");
      const out: Record<string, unknown> = {};
      for (const r of (rows ?? []) as any[]) {
        if (!hasMail(r.scopes)) continue;
        try { out[r.user_id] = await syncMailFor(r.user_id, null); } catch (e) { out[r.user_id] = { error: String(e) }; }
      }
      return json({ ok: true, users: out });
    }
    const userId = await userFromRequest(req);
    if (!userId) return json({ error: "Not authenticated" }, 401);
    const { action, ...p } = await req.json();

    if (action === "connect") {
      const asked = p.withMail ? `${BASE_SCOPE} ${MAIL_SCOPES.join(" ")}` : BASE_SCOPE;
      const tok = await exchangeCode(p.code, p.redirectUri, p.codeVerifier ?? "", asked);
      const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();
      const scopes = normScopes(tok.scope) || asked;
      let email: string | null = null;
      try {
        const me = await graph(tok.access_token, "/me?$select=mail,userPrincipalName");
        if (me.ok) { const j = await me.json(); email = j.mail || j.userPrincipalName || null; }
      } catch { /* the address is a nicety */ }
      const row: Record<string, unknown> = {
        user_id: userId,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: expiresAt,
        connected_at: new Date().toISOString(),
        scopes, account_email: email,
      };
      let up = await admin.from("outlook_tokens").upsert(row);
      if (up.error && /scopes|account_email|column/i.test(up.error.message)) {
        // before 19_ticket_mail.sql
        delete row.scopes; delete row.account_email;
        up = await admin.from("outlook_tokens").upsert(row);
      }
      return json({ connected: true, mail: hasMail(scopes), email });
    }

    if (action === "mail_status") {
      const { data } = await admin.from("outlook_tokens").select("*").eq("user_id", userId).maybeSingle();
      return json({ connected: !!data, mail: hasMail((data as any)?.scopes), email: (data as any)?.account_email ?? null, needsSql: !!data && !("scopes" in (data as any)) });
    }

    if (action === "mail_sync") {
      const r = await syncMailFor(userId, userClient(req));
      return json(r);
    }

    if (action === "mail_send") {
      return await sendMail(userId, p, userClient(req));
    }

    if (action === "mail_attachment") {
      const token = await accessTokenFor(userId);
      if (!token) return json({ error: "not_connected" }, 400);
      const { data: msg } = await userClient(req).from("ticket_mail_messages").select("graph_id, mailbox_id").eq("id", p.messageId).maybeSingle();
      if (!msg?.graph_id) return json({ error: "Message not found" }, 404);
      const base = await mailboxBase(msg.mailbox_id, userId);
      const res = await graph(token, `${base}/messages/${msg.graph_id}/attachments/${p.attachmentId}`);
      if (!res.ok) return json({ error: `Graph error: ${await res.text()}` }, 502);
      const a = await res.json();
      if ((a.size ?? 0) > 6_000_000) return json({ error: "Attachment too large to download here (over 6 MB)." }, 413);
      return json({ name: a.name, contentType: a.contentType, contentBytes: a.contentBytes });
    }

    if (action === "status") {
      const { data } = await admin.from("outlook_tokens").select("connected_at").eq("user_id", userId).maybeSingle();
      return json({ connected: !!data });
    }

    if (action === "disconnect") {
      await admin.from("outlook_tokens").delete().eq("user_id", userId);
      return json({ connected: false });
    }

    if (action === "upsert") {
      const token = await accessTokenFor(userId);
      if (!token) return json({ skipped: "not_connected" });
      let event = buildEvent(p);
      const send = async (ev: Record<string, unknown>) => {
        if (p.outlookEventId) {
          const r = await graph(token, `/me/events/${p.outlookEventId}`, "PATCH", ev);
          if (r.status !== 404) return r;
          // Deleted in Outlook. A deal meeting goes from the CRM too; any other
          // entry simply gets a fresh event.
          if (p.kind === "meeting" && !p.recreate) return null;
        }
        return graph(token, `/me/events`, "POST", ev);
      };
      let res = await send(event);
      if (!res) return json({ gone: true });
      let teamsSkipped = false;
      if (!res.ok && p.online) {
        // Personal accounts (and some tenants) can't create Teams meetings:
        // keep the event, drop the link.
        const { isOnlineMeeting: _a, onlineMeetingProvider: _b, ...plain } = event;
        event = plain;
        teamsSkipped = true;
        res = await send(event);
        if (!res) return json({ gone: true });
      }
      if (!res.ok) return json({ error: `Graph error: ${await res.text()}` }, 502);
      const ev = await res.json();
      return json({
        outlookEventId: ev.id,
        invited: Array.isArray(event.attendees) ? (event.attendees as unknown[]).length : 0,
        joinUrl: ev.onlineMeeting?.joinUrl ?? null,
        teamsSkipped,
      });
    }

    // What's in the user's own Outlook calendar between two moments (read only). Events the CRM put
    // there itself are left out (the page already shows those entries); cancelled and declined ones too.
    if (action === "events") {
      const token = await accessTokenFor(userId);
      if (!token) return json({ connected: false, events: [] });
      const from = new Date(String(p.from ?? "")), to = new Date(String(p.to ?? ""));
      if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return json({ error: "Bad range" }, 400);
      if (to.getTime() - from.getTime() > 120 * 86400000) return json({ error: "Range too long (120 days max)" }, 400);
      const sel = "id,subject,start,end,isAllDay,showAs,location,organizer,isOrganizer,isOnlineMeeting,onlineMeeting,webLink,isCancelled,bodyPreview,attendees,responseStatus,sensitivity,type";
      let url: string | null = `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}&$select=${sel}&$orderby=start/dateTime&$top=250`;
      const events: Record<string, unknown>[] = [];
      for (let page = 0; url && page < 6; page++) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' } });
        if (res.status === 429) return json({ error: "throttled", retryAfter: Number(res.headers.get("Retry-After") ?? 30), events }, 429);
        if (!res.ok) return json({ error: `Graph error: ${(await res.text()).slice(0, 300)}` }, 502);
        const j = await res.json();
        for (const e of (j.value ?? []) as any[]) {
          if (e.isCancelled) continue;
          if (e.responseStatus?.response === "declined") continue;
          if (/Synced from the CRM calendar/i.test(e.bodyPreview ?? "")) continue;
          const utc = (x: any) => (x?.dateTime ? `${String(x.dateTime).replace(/\.\d+$/, "").replace(/Z$/, "")}Z` : null);
          events.push({
            id: e.id, subject: e.subject || "(no title)", start: utc(e.start), end: utc(e.end), allDay: !!e.isAllDay,
            showAs: e.showAs ?? "busy", location: e.location?.displayName || null,
            organizer: e.organizer?.emailAddress?.name || e.organizer?.emailAddress?.address || null, isOrganizer: !!e.isOrganizer,
            online: !!e.isOnlineMeeting, joinUrl: e.onlineMeeting?.joinUrl ?? null, webLink: e.webLink ?? null,
            preview: String(e.bodyPreview ?? "").replace(/\s+/g, " ").trim().slice(0, 280),
            attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
            private: e.sensitivity && e.sensitivity !== "normal", recurring: e.type === "occurrence" || e.type === "exception",
          });
        }
        url = j["@odata.nextLink"] ?? null;
      }
      return json({ connected: true, events });
    }

    if (action === "delete") {
      if (!p.outlookEventId) return json({ skipped: true });
      const owner = await ownerOf(p.entryId, userId);
      const token = await accessTokenFor(owner);
      if (!token) return json({ skipped: true });
      await graph(token, `/me/events/${p.outlookEventId}`, "DELETE");
      return json({ deleted: true });
    }

    if (action === "check") {
      const ids: string[] = Array.isArray(p.entryIds) ? p.entryIds.slice(0, 100) : [];
      if (!ids.length) return json({ gone: [] });
      const { data: rows } = await admin.from("calendar_entries")
        .select("id, user_id, outlook_event_id, kind").in("id", ids);
      const gone: string[] = [];
      const tokens = new Map<string, string | null>();
      for (const r of (rows ?? []) as any[]) {
        if (!r.outlook_event_id || r.kind !== "meeting") continue;
        if (!tokens.has(r.user_id)) tokens.set(r.user_id, await accessTokenFor(r.user_id).catch(() => null));
        const token = tokens.get(r.user_id);
        if (!token) continue;
        const res = await graph(token, `/me/events/${r.outlook_event_id}?$select=id,isCancelled`);
        let isGone = res.status === 404;
        if (res.ok) isGone = !!(await res.json())?.isCancelled;
        if (isGone) {
          await admin.from("calendar_entries").delete().eq("id", r.id);
          gone.push(r.id);
        }
      }
      return json({ gone });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
