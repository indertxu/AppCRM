// Frontend helper for one-way Outlook sync. Lives in src/api/ alongside supabase.ts.
import { supabase } from "./supabase";

const CLIENT_ID = import.meta.env.VITE_MS_CLIENT_ID as string;
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const SCOPES = "Calendars.ReadWrite offline_access User.Read";
const REDIRECT_URI = `${window.location.origin}/settings`; // must match Azure redirect URIs

// --- PKCE helpers (required for SPA registrations) ---
function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomVerifier(): string {
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  return base64url(arr);
}
async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Call the outlook-sync Edge Function with the user's session token. */
async function call(action: string, payload: Record<string, unknown> = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/outlook-sync`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      },
      body: JSON.stringify({ action, ...payload }),
    },
  );
  return res.json();
}

/** Start the Microsoft consent flow with PKCE. Redirects the browser to Microsoft. */
export async function connectOutlook() {
  const state = crypto.randomUUID();
  const verifier = randomVerifier();
  const challenge = await challengeOf(verifier);
  sessionStorage.setItem("ms_oauth_state", state);
  sessionStorage.setItem("ms_pkce_verifier", verifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    response_mode: "query",
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  window.location.href = `${AUTH_URL}?${params}`;
}

/**
 * On returning from Microsoft, the URL has ?code=...&state=...
 * Call this on the settings page load to finish connecting.
 */
export async function completeOutlookConnect(): Promise<boolean> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return false;
  const expected = sessionStorage.getItem("ms_oauth_state");
  if (state !== expected) return false;
  const verifier = sessionStorage.getItem("ms_pkce_verifier") ?? "";
  const r = await call("connect", { code, redirectUri: REDIRECT_URI, codeVerifier: verifier });
  // clean the code out of the URL
  window.history.replaceState({}, "", REDIRECT_URI);
  sessionStorage.removeItem("ms_oauth_state");
  sessionStorage.removeItem("ms_pkce_verifier");
  return !!r.connected;
}

export async function outlookStatus(): Promise<boolean> {
  const r = await call("status");
  return !!r.connected;
}
export async function disconnectOutlook(): Promise<void> {
  await call("disconnect");
}

export interface OutlookEntryPayload {
  outlookEventId?: string | null;
  date: string;         // 'YYYY-MM-DD'
  startMin: number;
  endMin: number;
  workType?: string;
  client?: string;
  project?: string;
  phase?: string;
  tasks?: string;
  notes?: string;
  timeZone?: string;
}

/** Create or update the Outlook event for an entry. Returns the event id to store. */
export async function syncEntryToOutlook(p: OutlookEntryPayload): Promise<string | null> {
  try {
    const r = await call("upsert", p);
    if (r.skipped) return p.outlookEventId ?? null; // not connected → no-op
    return r.outlookEventId ?? null;
  } catch {
    return p.outlookEventId ?? null; // never block saving on a sync failure
  }
}

/** Delete the Outlook event for an entry (best-effort). */
export async function deleteEntryFromOutlook(outlookEventId?: string | null): Promise<void> {
  if (!outlookEventId) return;
  try { await call("delete", { outlookEventId }); } catch { /* ignore */ }
}