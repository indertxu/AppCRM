// Supabase Edge Function: outlook-meeting — removing a CRM meeting from Outlook properly.
// Actions:
//   delete — a meeting I organise with people invited is CANCELLED (they get the
//            cancellation, it leaves my calendar); anything else is deleted. Then any
//            copy left in my mailbox with the same meeting id (e.g. a "Canceled: …"
//            item the cancellation drops when my own address was also invited) is
//            removed too — right away and again once the cancellation has arrived.
//            With entryId it works in the organiser's Outlook (the row's user_id),
//            even when a teammate deletes it.
//   me     — the addresses of my Outlook mailbox (so I'm never invited to my own meeting)
// Uses the tokens outlook-sync stores (outlook_tokens). Secrets: MS_CLIENT_ID, MS_CLIENT_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MS_CLIENT_ID = Deno.env.get("MS_CLIENT_ID")!;
const MS_CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET")!;
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";
const BASE_SCOPE = "Calendars.ReadWrite offline_access User.Read";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function userFromRequest(req: Request): Promise<string | null> {
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error || !data.user ? null : data.user.id;
}

const normScopes = (s: unknown) => String(s ?? "").split(/\s+/).filter(Boolean).map((x) => x.replace(/^https:\/\/graph\.microsoft\.com\//i, "")).join(" ");
function scopeOfRow(row: any): string {
  const sc = normScopes(row?.scopes);
  if (!sc) return BASE_SCOPE;
  const parts = new Set(sc.split(" ").filter((x) => !/^(openid|profile|email)$/i.test(x)));
  parts.add("offline_access");
  return [...parts].join(" ");
}
async function accessTokenFor(userId: string): Promise<string | null> {
  const { data } = await admin.from("outlook_tokens").select("*").eq("user_id", userId).maybeSingle();
  if (!data) return null;
  if (Date.now() < new Date(data.expires_at).getTime() - 60_000) return data.access_token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: data.refresh_token, scope: scopeOfRow(data) }),
  });
  if (!res.ok) return null;
  const tok = await res.json();
  await admin.from("outlook_tokens").update({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? data.refresh_token,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
  }).eq("user_id", userId);
  return tok.access_token;
}
const graph = (token: string, path: string, method = "GET", body?: unknown) =>
  fetch(`${GRAPH}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function ownerOf(entryId: string | undefined, fallback: string): Promise<string> {
  if (!entryId) return fallback;
  const { data } = await admin.from("calendar_entries").select("user_id").eq("id", entryId).maybeSingle();
  return (data as any)?.user_id ?? fallback;
}

async function myAddresses(token: string): Promise<string[]> {
  const out = new Set<string>();
  let r = await graph(token, `/me?$select=mail,userPrincipalName,otherMails,proxyAddresses`);
  if (!r.ok) r = await graph(token, `/me?$select=mail,userPrincipalName`);
  if (r.ok) {
    const me = await r.json();
    [me?.mail, me?.userPrincipalName, ...(me?.otherMails ?? []), ...((me?.proxyAddresses ?? []) as string[]).map((x) => String(x).replace(/^smtp:/i, ""))]
      .filter(Boolean).forEach((a: string) => out.add(String(a).toLowerCase()));
  }
  return [...out];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const userId = await userFromRequest(req);
    if (!userId) return json({ error: "Not authenticated" }, 401);
    const { action, ...p } = await req.json();

    if (action === "me") {
      const token = await accessTokenFor(userId);
      if (!token) return json({ connected: false, addresses: [] });
      return json({ connected: true, addresses: await myAddresses(token) });
    }

    if (action === "delete") {
      if (!p.outlookEventId) return json({ skipped: true });
      const token = await accessTokenFor(await ownerOf(p.entryId, userId));
      if (!token) return json({ skipped: true });
      const id = encodeURIComponent(p.outlookEventId);
      const info = await graph(token, `/me/events/${id}?$select=id,iCalUId,isOrganizer,attendees,isCancelled`);
      let ical: string | null = null;
      let how = "gone";
      if (info.ok) {
        const ev = await info.json();
        ical = ev?.iCalUId ?? null;
        const invited = Array.isArray(ev?.attendees) && ev.attendees.length > 0;
        if (invited && ev?.isOrganizer !== false && !ev?.isCancelled) {
          const c = await graph(token, `/me/events/${id}/cancel`, "POST", { comment: "This meeting was cancelled." });
          if (c.ok) how = "cancelled";
        }
        if (how !== "cancelled") {
          const d = await graph(token, `/me/events/${id}`, "DELETE");
          how = d.ok || d.status === 404 ? "deleted" : `error ${d.status}`;
        }
      }
      if (ical) {
        const sweep = async () => {
          for (const wait of [0, 3000, 8000, 15000]) {
            if (wait) await new Promise((r) => setTimeout(r, wait));
            const q = await graph(token, `/me/events?$filter=${encodeURIComponent(`iCalUId eq '${ical!.replace(/'/g, "''")}'`)}&$select=id`);
            if (!q.ok) return;
            for (const e of (((await q.json())?.value ?? []) as { id: string }[])) await graph(token, `/me/events/${encodeURIComponent(e.id)}`, "DELETE");
          }
        };
        const bg = (globalThis as any).EdgeRuntime;
        if (bg?.waitUntil) bg.waitUntil(sweep().catch(() => {}));
        else await sweep().catch(() => {});
      }
      return json({ deleted: how === "deleted" || how === "cancelled" || how === "gone", how });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
