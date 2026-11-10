/* =====================================================================
   BASE · Connected accounts — several Gmail / Google Calendar / Outlook
   accounts per person (Settings › Integrations).

   Sign-in opens in a POPUP (like outlookSync.ts). Google / Microsoft send the
   popup back to /settings?code=…&state=acc.<provider>.<nonce>; the code below
   catches that the moment the module loads, hands the code to the main window
   and closes the popup. The main window then asks the edge function
   "connected-accounts" to swap the code for tokens (the client secret lives
   only there) and to store the account (table connected_accounts, SQL 119).

   Needs:
     VITE_GOOGLE_CLIENT_ID  — Google Cloud › OAuth client (Web), redirect URIs
                              https://<app>/settings and http://localhost:5174/settings
     VITE_MS_CLIENT_ID      — already set (the Outlook app registration)
     edge function connected-accounts (+ secrets GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
   ===================================================================== */
import { supabase } from "../../components/api/supabase";

export type Provider = "google" | "microsoft";
export type Service = "mail" | "calendar";
export interface ConnectedAccount {
  id: string; provider: Provider; email: string; display_name: string | null;
  services: Service[]; status: "active" | "error"; last_error: string | null; connected_at: string; updated_at?: string;
}

export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";
const MS_CLIENT_ID = (import.meta.env.VITE_MS_CLIENT_ID as string | undefined) ?? "";
const REDIRECT_URI = `${window.location.origin}/settings`;
const STATE_PREFIX = "acc.";
const CHANNEL = "next-connected-accounts";
const RETURN_KEY = "acc_oauth_return";

const SCOPES: Record<Provider, Record<Service, string>> = {
  google: {
    mail: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    calendar: "https://www.googleapis.com/auth/calendar.events",
  },
  microsoft: {
    mail: "Mail.Read Mail.Send",
    calendar: "Calendars.ReadWrite",
  },
};
const BASE_SCOPES: Record<Provider, string> = { google: "openid email profile", microsoft: "offline_access User.Read" };
const AUTH_URL: Record<Provider, string> = {
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
};
export const providerReady = (p: Provider) => (p === "google" ? !!GOOGLE_CLIENT_ID : !!MS_CLIENT_ID);

/* ---------- PKCE ---------- */
const b64url = (bytes: Uint8Array) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const rnd = (n = 32) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); };
const challengeOf = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

/* ---------- the popup's side: runs as soon as this module loads ---------- */
(function catchReturn() {
  try {
    const url = new URL(window.location.href);
    const state = url.searchParams.get("state") ?? "";
    if (!state.startsWith(STATE_PREFIX)) return;                       // not ours (Outlook's own, Supabase…)
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error_description") || url.searchParams.get("error");
    ["code", "state", "scope", "authuser", "prompt", "hd", "session_state", "error", "error_description", "error_uri", "client_info", "iss"]
      .forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    const msg = { type: "acc-return", code, state, error: err, at: Date.now() };
    try { const bc = new BroadcastChannel(CHANNEL); bc.postMessage(msg); bc.close(); } catch { /* old browser */ }
    try { window.opener?.postMessage(msg, window.location.origin); } catch { /* opener gone */ }
    try { localStorage.setItem(RETURN_KEY, JSON.stringify(msg)); } catch { /* ignore */ }
    setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 150);
  } catch { /* never break start-up */ }
})();

/* ---------- edge function ---------- */
async function call(action: string, payload: object = {}): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/connected-accounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch { return { error: "The connection service isn't reachable yet.", missing: true }; }
  const text = await res.text();
  let body: any; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 200) }; }
  if (res.status === 404) return { error: "The connection service isn't installed yet.", missing: true };
  if (!res.ok && !body?.error) body = { ...(body ?? {}), error: `HTTP ${res.status}` };
  return body;
}

/** Accounts you connected (newest last). Empty when SQL 119 isn't applied yet. */
export async function listAccounts(): Promise<{ accounts: ConnectedAccount[]; needsSql: boolean }> {
  const { data, error } = await supabase.from("connected_accounts")
    .select("id, provider, email, display_name, services, status, last_error, connected_at, updated_at").order("connected_at");
  if (error) return { accounts: [], needsSql: /connected_accounts|relation|schema cache/i.test(error.message) };
  return { accounts: (data ?? []) as ConnectedAccount[], needsSql: false };
}

export async function removeAccount(id: string): Promise<string | null> {
  const r = await call("disconnect", { id });             // also revokes the token at Google / Microsoft
  if (!r?.error) return null;
  if (r.missing) {                                         // no edge function yet: drop our row at least
    const { error } = await supabase.from("connected_accounts").delete().eq("id", id);
    return error?.message ?? null;
  }
  return r.error;
}

/**
 * Add an account: the provider's sign-in opens in a popup (pick any account —
 * "select_account" so a second Gmail / Outlook can be chosen). Resolves with the
 * stored account, or an error message.
 */
export async function addAccount(provider: Provider, services: Service[], opts: { loginHint?: string } = {}): Promise<{ account?: ConnectedAccount; error?: string }> {
  if (!providerReady(provider)) return { error: provider === "google" ? "Google sign-in isn't set up for this app yet." : "Microsoft sign-in isn't set up for this app yet." };
  const verifier = rnd(48);
  const state = `${STATE_PREFIX}${provider}.${rnd(12)}`;
  const scope = [BASE_SCOPES[provider], ...services.map((s) => SCOPES[provider][s])].join(" ");
  const q = new URLSearchParams({
    client_id: provider === "google" ? GOOGLE_CLIENT_ID : MS_CLIENT_ID,
    response_type: "code", redirect_uri: REDIRECT_URI, scope, state,
    code_challenge: await challengeOf(verifier), code_challenge_method: "S256",
    // a known address (turning on one more Google app for it) skips the account picker
    prompt: opts.loginHint ? "consent" : provider === "google" ? "select_account consent" : "select_account",
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    ...(provider === "google" ? { access_type: "offline", include_granted_scopes: "true" } : { response_mode: "query" }),
  });
  try { localStorage.removeItem(RETURN_KEY); } catch { /* ignore */ }
  // A leftover "<…>-code-verifier" from an earlier Supabase sign-in would make Supabase grab this code too.
  try { Object.keys(localStorage).filter((k) => k.endsWith("-code-verifier")).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  const w = 520, h = 680;
  const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2), top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
  const popup = window.open(`${AUTH_URL[provider]}?${q}`, "next-connect-account", `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  if (!popup) return { error: "Your browser blocked the sign-in window. Allow pop-ups for this site and try again." };

  const back = await new Promise<{ code: string | null; error: string | null } | null>((resolve) => {
    let done = false;
    const finish = (v: { code: string | null; error: string | null } | null) => {
      if (done) return; done = true;
      window.removeEventListener("message", onMsg); window.removeEventListener("storage", onStore);
      try { bc?.close(); } catch { /* ignore */ } clearInterval(timer);
      resolve(v);
    };
    const take = (m: any) => { if (m?.type === "acc-return" && m.state === state) finish({ code: m.code ?? null, error: m.error ?? null }); };
    const onMsg = (e: MessageEvent) => { if (e.origin === window.location.origin) take(e.data); };
    const onStore = (e: StorageEvent) => { if (e.key === RETURN_KEY && e.newValue) { try { take(JSON.parse(e.newValue)); } catch { /* ignore */ } } };
    let bc: BroadcastChannel | null = null;
    try { bc = new BroadcastChannel(CHANNEL); bc.onmessage = (e) => take(e.data); } catch { /* old browser */ }
    window.addEventListener("message", onMsg); window.addEventListener("storage", onStore);
    const timer = window.setInterval(() => {
      let closed = false; try { closed = popup.closed; } catch { closed = false; }
      if (closed) setTimeout(() => finish(null), 600);       // a last message may still be on its way
    }, 500);
  });
  if (!back) return { error: "The sign-in window was closed." };
  if (back.error || !back.code) return { error: back.error || "The sign-in didn't finish." };
  const r = await call("connect", { provider, code: back.code, codeVerifier: verifier, redirectUri: REDIRECT_URI, services });
  if (r?.error) return { error: r.error };
  return { account: r.account as ConnectedAccount };
}

/** Refresh one account's access now: marks it working / needing sign-in again. */
export async function checkAccount(id: string): Promise<{ status: "active" | "error"; error?: string }> {
  const r = await call("check", { id });
  if (r?.missing) return { status: "error", error: r.error };
  return { status: r?.status === "active" ? "active" : "error", error: r?.error };
}

export interface OutlookFacts { email: string | null; connectedAt: string | null; lastRefresh: string | null; scopes: string | null }
/** When you connected your first Outlook (SQL 120 — the tokens themselves stay hidden). */
export async function myOutlookConnection(): Promise<OutlookFacts | null> {
  const { data, error } = await supabase.rpc("my_outlook_connection");
  const row = !error && Array.isArray(data) ? (data[0] as any) : null;
  if (!row) return null;
  return { email: row.account_email ?? null, connectedAt: row.connected_at ?? null, lastRefresh: row.last_refresh ?? null, scopes: row.scopes ?? null };
}

/** Last time the app read mail from each address (customer-success scan and the ticket desk), lower-case address → ISO time. */
export async function lastMailReads(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const keep = (addr: unknown, at: unknown) => {
    const a = String(addr ?? "").toLowerCase(), t = String(at ?? "");
    if (a && t && (!out[a] || out[a] < t)) out[a] = t;
  };
  const [cs, tm] = await Promise.all([
    supabase.from("cs_mailbox_sync").select("address, last_run_at"),
    supabase.from("ticket_mailboxes").select("address, last_sync_at"),
  ]);
  for (const r of (cs.data ?? []) as any[]) keep(r.address, r.last_run_at);
  for (const r of (tm.data ?? []) as any[]) keep(r.address, r.last_sync_at);
  return out;
}
