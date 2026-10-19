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
// Secrets required (supabase secrets set ...):
//   MS_CLIENT_ID, MS_CLIENT_SECRET
//
// Uses the caller's Supabase JWT to identify the user; never trusts a user_id from the body.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MS_CLIENT_ID = Deno.env.get("MS_CLIENT_ID")!;
const MS_CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET")!;
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";

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

async function exchangeCode(code: string, redirectUri: string, codeVerifier: string) {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: "Calendars.ReadWrite offline_access User.Read",
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

async function refresh(refreshToken: string) {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "Calendars.ReadWrite offline_access User.Read",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return await res.json();
}

// Return a valid access token for the user, refreshing if it's about to expire.
async function accessTokenFor(userId: string): Promise<string | null> {
  const { data } = await admin.from("outlook_tokens").select("*").eq("user_id", userId).maybeSingle();
  if (!data) return null;
  const expiresAt = new Date(data.expires_at).getTime();
  if (Date.now() < expiresAt - 60_000) return data.access_token;
  // refresh
  const tok = await refresh(data.refresh_token);
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const userId = await userFromRequest(req);
    if (!userId) return json({ error: "Not authenticated" }, 401);
    const { action, ...p } = await req.json();

    if (action === "connect") {
      const tok = await exchangeCode(p.code, p.redirectUri, p.codeVerifier ?? "");
      const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();
      await admin.from("outlook_tokens").upsert({
        user_id: userId,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: expiresAt,
        connected_at: new Date().toISOString(),
      });
      return json({ connected: true });
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
