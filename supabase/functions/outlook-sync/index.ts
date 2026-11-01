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
//   Customer success follow-ups (88_cs_followups.sql):
//   cs_run   — enrol clients in the active sequences and send what is due (your company)
//   cs_test  — one blueprint, filled in for a client, sent to yourself
//   cs_attachment_preview — an attachment as one client gets it (its fields filled in)
//   cs_mail_scan — read the company's Outlook mailboxes: e-mails from / to clients become contacts
//   (hourly, with the x-cs-cron header: every company, both of the above)
//
// Secrets required (supabase secrets set ...):
//   MS_CLIENT_ID, MS_CLIENT_SECRET
//   CRON_SECRET (only for the scheduled mail_sync_all)
//
// Uses the caller's Supabase JWT to identify the user; never trusts a user_id from the body.

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

/* =====================================================================
   Customer success: automatic e-mail follow-ups (88_cs_followups.sql)
   Sequences send e-mail blueprints to the clients they apply to, step by
   step, from each client's owner's Outlook (or whoever set them up).
   ===================================================================== */
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
  const spots = (Array.isArray(a?.spots) ? a.spots : []) as any[];
  if (!isPdf || (!fields.length && !spots.length)) return { name, type, bytes: raw };
  try {
    const doc = await PDFDocument.load(raw, { ignoreEncryption: true });
    const latin = (v: string) => v.replace(/[^\x20-\x7e\u00a0-\u00ff]/g, "");
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
    return { name, type: "application/pdf", bytes: await doc.save() };
  } catch {
    return { name, type, bytes: raw };   // a PDF we can't open goes as it is
  }
}

/** Sends one message from a user's Outlook (with attachments from the cs-files bucket, made for the client when vars are given). */
async function csSend(userId: string, to: string[], subject: string, html: string, attachments: any[], vars?: Record<string, string>): Promise<string | null> {
  const { data: tokRow } = await admin.from("outlook_tokens").select("scopes").eq("user_id", userId).maybeSingle();
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
  const message = { subject, body: { contentType: "HTML", content: html }, toRecipients: to.map((e) => ({ emailAddress: { address: e } })), attachments: files };
  const res = await graph(token, "/me/sendMail", "POST", { message, saveToSentItems: true });
  if (res.status === 429) return "throttled";
  if (!res.ok) return `Outlook said: ${(await res.text()).slice(0, 300)}`;
  return null;
}

/** Everything a tenant's sequences need, read once. */
async function csTenantData(tenant: string) {
  const [cl, ow, he, tp, pr] = await Promise.all([
    admin.from("clients").select("id, name, legal_name, contacts, cs_priority, project_type_id, tenant_id").eq("tenant_id", tenant),
    admin.from("client_cs_owners").select("client_id, profile_id, is_primary").eq("tenant_id", tenant),
    admin.from("client_health").select("client_id, status").eq("tenant_id", tenant),
    admin.from("cs_email_templates").select("*").eq("tenant_id", tenant),
    admin.from("profiles").select("id, first_name, last_name, email").eq("tenant_id", tenant),
  ]);
  const clients = (cl.data ?? []) as any[];
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

/** Enrols the clients each active sequence applies to and sends what is due. One tenant, or all (the scheduler). */
async function csRun(tenantOnly: string | null, budget = 60): Promise<Record<string, unknown>> {
  const stats = { enrolled: 0, sent: 0, failed: 0, skipped: 0, finished: 0, errors: [] as string[] };
  let q = admin.from("cs_sequences").select("*").eq("active", true);
  if (tenantOnly) q = q.eq("tenant_id", tenantOnly);
  const { data: seqs, error } = await q;
  if (error) return { error: /relation|does not exist/i.test(error.message) ? "Run 88_cs_followups.sql" : error.message };
  const tenants = [...new Set(((seqs ?? []) as any[]).map((s) => s.tenant_id).filter(Boolean))] as string[];
  const now = Date.now();
  for (const tenant of tenants) {
    const d = await csTenantData(tenant);
    for (const seq of ((seqs ?? []) as any[]).filter((s) => s.tenant_id === tenant)) {
      const steps = (Array.isArray(seq.steps) ? seq.steps : []).filter((x: any) => x?.template_id);
      if (!steps.length) continue;
      const { data: runRows } = await admin.from("cs_sequence_runs").select("*").eq("sequence_id", seq.id);
      const runs = (runRows ?? []) as any[];
      const has = new Set(runs.map((r) => r.client_id));
      const waitOf = (i: number) => Math.max(0, Number(steps[i]?.wait_days) || 0) * CS_DAY;
      const firstAt = (c: any): number | null => {
        if (seq.start_mode !== "before_renewal") return now + waitOf(0);
        const ren = d.renewalOf(c.id);
        if (!ren) return null;
        return Math.max(now, ren.getTime() - (Number(seq.start_days) || 0) * CS_DAY) + waitOf(0);
      };
      // who comes in
      for (const c of d.clients) {
        if (has.has(c.id) || !csMatches(seq.audience, c, d.health)) continue;
        const at = firstAt(c);
        if (at == null) continue;
        const { data: row, error: e } = await admin.from("cs_sequence_runs").insert({ tenant_id: tenant, sequence_id: seq.id, client_id: c.id, step: 0, status: "active", next_at: new Date(at).toISOString() }).select("*").single();
        if (!e && row) { stats.enrolled += 1; runs.push(row); }
      }
      // who no longer fits leaves (unless someone put them in by hand)
      for (const r of runs) {
        const c = d.clients.find((x) => x.id === r.client_id);
        if (r.id && r.status === "active" && !r.manual && c && !csMatches(seq.audience, c, d.health)) {
          await admin.from("cs_sequence_runs").update({ status: "done" }).eq("id", r.id); r.status = "done"; stats.finished += 1;
        }
      }
      // what is due
      const due = runs.filter((r) => r.id && r.status === "active" && r.next_at && new Date(r.next_at).getTime() <= now);
      for (const r of due) {
        if (budget <= 0) break;
        const c = d.clients.find((x) => x.id === r.client_id);
        if (!c) continue;
        const stepIx = Math.min(Math.max(0, Number(r.step) || 0), steps.length - 1);
        const t0 = d.templates[steps[stepIx].template_id];
        const t = t0 ? csVersionOf(t0, c, d) : t0;
        const sender = seq.sender === "owner" ? (d.owner[c.id] ?? seq.created_by) : seq.created_by;
        const to = csRecipients(c, seq.recipients, r.to_emails);
        const base: Record<string, unknown> = { tenant_id: tenant, sequence_id: seq.id, run_id: r.id, client_id: c.id, template_id: t?.id ?? null, step: stepIx, sent_by: sender, variant: t?._variant ?? null };
        let skip: string | null = null;
        if (!t) skip = "The e-mail blueprint of this step was deleted.";
        else if (!to.length) skip = "No e-mail address for this client (add a contact with an e-mail).";
        else if (!sender) skip = "Nobody to send it from (no owner).";
        let sentNow = 0, failedNow = 0, throttled = false;
        if (skip) {
          await admin.from("cs_email_log").insert({ ...base, to_emails: to, subject: t?.subject ?? null, status: "skipped", error: skip });
          stats.skipped += 1;
        } else {
          // each person gets their own e-mail, with their own name; whoever already got this step (an earlier, interrupted run) is not sent it again
          const { data: done } = await admin.from("cs_email_log").select("to_emails").eq("run_id", r.id).eq("step", stepIx).eq("status", "sent").gte("sent_at", r.next_at);
          const already = new Set(((done ?? []) as any[]).flatMap((x) => (x.to_emails ?? []).map((e: string) => lc(e))));
          const cts = (Array.isArray(c.contacts) ? c.contacts : []) as any[];
          for (const email of to) {
            if (already.has(lc(email))) { sentNow += 1; continue; }
            if (budget <= 0) { throttled = true; break; }
            const person = cts.find((x) => lc(x?.email) === lc(email)) ?? { email, name: "" };
            const vars = csVars(c, d, sender, person);
            const subject = csFill(t.subject, vars, false);
            budget -= 1;
            const err = await csSend(sender, [email], subject, csFill(csHtmlOf(t), vars, true), t.attachments ?? [], vars);
            if (err === "throttled") { throttled = true; break; }
            await admin.from("cs_email_log").insert({ ...base, to_emails: [email], subject, status: err ? "failed" : "sent", error: err });
            if (err) { failedNow += 1; stats.failed += 1; stats.errors.push(`${c.name} · ${email}: ${err}`); } else { sentNow += 1; stats.sent += 1; }
          }
        }
        // Outlook busy (or out of time this round): left as it is, the rest go out on the next hourly run
        // (next_at stays put, so the people who already got it are recognised and skipped)
        if (throttled) continue;
        // nobody got it: try again tomorrow
        if (!skip && !sentNow && failedNow) { await admin.from("cs_sequence_runs").update({ next_at: new Date(now + CS_DAY).toISOString() }).eq("id", r.id); continue; }
        if (!skip && sentNow && seq.log_contact) await admin.from("client_contacts_log").insert({ tenant_id: tenant, client_id: c.id, contacted_at: new Date().toISOString(), channel: "email", direction: "out", source: "auto", reason: `Automatic e-mail · ${t.name}${to.length > 1 ? ` (${to.length} people)` : ""}`, logged_by: sender });
        // on to the next step (or round again, or done)
        const nextIx = stepIx + 1;
        const patch: Record<string, unknown> = { last_sent_at: skip ? r.last_sent_at ?? null : new Date().toISOString() };
        if (nextIx < steps.length) Object.assign(patch, { step: nextIx, next_at: new Date(now + Math.max(waitOf(nextIx), 3600_000)).toISOString() });
        else if (seq.repeat) {
          // round again: after the gap the sequence sets (start_days), then step 1's own wait
          let at = now + Math.max(1, Number(seq.start_days) || 30) * CS_DAY + waitOf(0);
          if (seq.start_mode === "before_renewal") { const ren = d.renewalOf(c.id, now + ((Number(seq.start_days) || 0) + 1) * CS_DAY); at = ren ? ren.getTime() - (Number(seq.start_days) || 0) * CS_DAY + waitOf(0) : now + 365 * CS_DAY; }
          Object.assign(patch, { step: 0, cycle: (Number(r.cycle) || 0) + 1, next_at: new Date(at).toISOString() });
        } else { Object.assign(patch, { status: "done", next_at: null }); stats.finished += 1; }
        await admin.from("cs_sequence_runs").update(patch).eq("id", r.id);
      }
    }
  }
  return stats;
}

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
  const err = await csSend(userId, [to], subject, csFill(csHtmlOf(tv), vars, true), (t as any).attachments ?? [], vars);
  await admin.from("cs_email_log").insert({ tenant_id: tenant, client_id: c.id || null, template_id: (t as any).id, to_emails: [to], subject, status: err ? "failed" : "test", error: err, sent_by: userId, variant: tv._variant ?? null });
  return err ? json({ error: err === "throttled" ? "Outlook is busy — try again in a minute." : err }, 400) : json({ ok: true, to });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Customer-success follow-ups, hourly (pg_cron + pg_net): the key only the database and this function know
    const csKey = req.headers.get("x-cs-cron");
    if (csKey) {
      const { data: k } = await admin.from("cs_cron_key").select("key").eq("id", 1).maybeSingle();
      if (!k || (k as any).key !== csKey) return json({ error: "Forbidden" }, 403);
      const t0 = Date.now();
      const sent = await csRun(null, 120);
      const mail = await csMailScanAll(null, 20, t0 + 100_000).catch((e) => ({ error: String(e) }));
      return json({ ...sent, mail });
    }
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

    // Customer success: send what is due now for your company / a blueprint to yourself
    if (action === "cs_run") {
      const { data: prof } = await admin.from("profiles").select("tenant_id").eq("id", userId).maybeSingle();
      if (!(prof as any)?.tenant_id) return json({ error: "No company." }, 400);
      return json(await csRun((prof as any).tenant_id, 60));
    }
    if (action === "cs_test") return await csTest(userId, p);
    if (action === "cs_attachment_preview") {
      const { data: prof } = await admin.from("profiles").select("tenant_id").eq("id", userId).maybeSingle();
      const tenant = (prof as any)?.tenant_id;
      const a = p.attachment ?? {};
      if (!tenant || !String(a.path ?? "").startsWith(`${tenant}/`)) return json({ error: "Not your file." }, 403);
      const { data: file, error: fe } = await admin.storage.from("cs-files").download(a.path);
      if (fe || !file) return json({ error: "The file is missing." }, 404);
      const d = await csTenantData(tenant);
      const c = d.clients.find((x) => x.id === p.clientId) ?? d.clients[0] ?? { id: "", name: "Your client", contacts: [] };
      const f = await csPersonalize(a, await file.arrayBuffer(), csVars(c, d, userId));
      return json({ name: f.name, contentType: f.type, contentBytes: csB64(f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer) });
    }
    // Customer success: read the company's Outlook mailboxes now (the e-mails with clients become contacts)
    if (action === "cs_mail_scan") {
      const { data: prof } = await admin.from("profiles").select("tenant_id").eq("id", userId).maybeSingle();
      if (!(prof as any)?.tenant_id) return json({ error: "No company." }, 400);
      return json(await csMailScanAll((prof as any).tenant_id, 12, Date.now() + 45_000));
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
