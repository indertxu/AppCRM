// Supabase Edge Function: one-way calendar sync to Outlook (Microsoft Graph).
// Actions:
//   connect  — exchange an OAuth auth code for tokens, store them for the user
//   status   — is the user connected?
//   disconnect
//   upsert   — create or update the Outlook event for a calendar entry
//   delete   — remove the Outlook event for a calendar entry
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

// Build the Outlook event body from the entry payload.
function buildEvent(p: any) {
  const lines: string[] = [];
  if (p.workType) lines.push(`Type of work: ${p.workType}`);
  if (p.client) lines.push(`Client: ${p.client}`);
  if (p.project) lines.push(`Project: ${p.project}`);
  if (p.phase) lines.push(`Phase: ${p.phase}`);
  if (p.tasks) lines.push(`Tasks: ${p.tasks}`);
  if (p.notes) lines.push("", p.notes);
  const startISO = `${p.date}T${String(Math.floor(p.startMin / 60)).padStart(2, "0")}:${String(p.startMin % 60).padStart(2, "0")}:00`;
  const endISO = `${p.date}T${String(Math.floor(p.endMin / 60)).padStart(2, "0")}:${String(p.endMin % 60).padStart(2, "0")}:00`;
  const title = [p.client, p.project].filter(Boolean).join(" · ") || p.workType || "Work";
  return {
    subject: title,
    body: { contentType: "text", content: lines.join("\n") },
    start: { dateTime: startISO, timeZone: p.timeZone || "Europe/Madrid" },
    end: { dateTime: endISO, timeZone: p.timeZone || "Europe/Madrid" },
  };
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
      const event = buildEvent(p);
      const existingId = p.outlookEventId;
      let res: Response;
      if (existingId) {
        res = await fetch(`${GRAPH}/me/events/${existingId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(event),
        });
        if (res.status === 404) {
          // event was deleted in Outlook — create a fresh one
          res = await fetch(`${GRAPH}/me/events`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(event),
          });
        }
      } else {
        res = await fetch(`${GRAPH}/me/events`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(event),
        });
      }
      if (!res.ok) return json({ error: `Graph error: ${await res.text()}` }, 502);
      const ev = await res.json();
      return json({ outlookEventId: ev.id });
    }

    if (action === "delete") {
      const token = await accessTokenFor(userId);
      if (!token || !p.outlookEventId) return json({ skipped: true });
      await fetch(`${GRAPH}/me/events/${p.outlookEventId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      return json({ deleted: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});