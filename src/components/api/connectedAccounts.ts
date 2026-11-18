/* =====================================================================
   SHARED (Enterprise copy of src/base/api/connectedAccounts.ts, 2026-11-16 —
   Base may import this one instead and drop its own) · Connected accounts — several Gmail / Google Calendar / Outlook
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
import { supabase } from "./supabase";

export type Provider = "google" | "microsoft" | "meta" | "linkedin" | "mailrelay" | "smtp";
export type Service = "mail" | "calendar" | "facebook" | "instagram" | "ads" | "linkedin" | "linkedin_pages" | "mailrelay" | "whatsapp" | "gads" | "analytics";
export interface ConnectedAccount {
  id: string; provider: Provider; email: string; display_name: string | null;
  services: Service[]; status: "active" | "error"; last_error: string | null; connected_at: string; updated_at?: string;
  /** SMTP mailboxes (IONOS Mail…): the server they send through (SQL 145). */
  settings?: { host?: string; port?: number; label?: string } | null;
}

/* The apps' public client IDs (they travel in every sign-in link, nothing secret). The .env / Vercel VITE_* values win;
   these keep the sign-in buttons working where the hosting has none set — the live site (nextcrm.atebiz.com) didn't
   have the LinkedIn / Google / Meta ones, so "Connect" was greyed out for everyone there but worked on localhost. */
const PUBLIC_IDS = {
  ms: "efb6a9c4-1d9c-4192-bc9c-d0b46848dcf4",
  google: "620562558886-h40cg4l7uhr81rc31ltd31d0r9jrcsce.apps.googleusercontent.com",
  meta: "2696998234085906",
  metaConfig: "39905481842431249",
  linkedin: "78iabwdaeutbyt",
  /** "Next Pages": the second LinkedIn app, only for the Community Management API (company pages) */
  linkedinPages: "77fcs0r0hs2h7k",
};
const env = (k: string) => String((import.meta.env as Record<string, unknown>)[k] ?? "").trim();
export const GOOGLE_CLIENT_ID = env("VITE_GOOGLE_CLIENT_ID") || PUBLIC_IDS.google;
const MS_CLIENT_ID = env("VITE_MS_CLIENT_ID") || PUBLIC_IDS.ms;
/** Meta app (developers.facebook.com). With "Facebook Login for Business" also set VITE_META_CONFIG_ID (a login configuration replaces the scope list). */
export const META_APP_ID = env("VITE_META_APP_ID") || PUBLIC_IDS.meta;
const META_CONFIG_ID = env("VITE_META_CONFIG_ID") || PUBLIC_IDS.metaConfig;
/** LinkedIn app (linkedin.com/developers). Company pages need the Community Management API: when LinkedIn
 *  approves it, set VITE_LINKEDIN_PAGES=1 (and VITE_LINKEDIN_PAGES_CLIENT_ID if it lives in a second app). */
export const LINKEDIN_CLIENT_ID = env("VITE_LINKEDIN_CLIENT_ID") || PUBLIC_IDS.linkedin;
const LINKEDIN_PAGES_CLIENT_ID = env("VITE_LINKEDIN_PAGES_CLIENT_ID") || PUBLIC_IDS.linkedinPages;
/** Company pages sign in through their own LinkedIn app: LinkedIn doesn't let the Community Management API share
 *  an app with "Sign In with LinkedIn" (OpenID), so that sign-in asks for r_basicprofile instead of openid. */
export const LINKEDIN_PAGES_APP = !!LINKEDIN_PAGES_CLIENT_ID;
export const LINKEDIN_PAGES = (import.meta.env.VITE_LINKEDIN_PAGES as string | undefined) === "1";
const REDIRECT_URI = `${window.location.origin}/settings`;
const STATE_PREFIX = "acc.";
const CHANNEL = "next-connected-accounts";
const RETURN_KEY = "acc_oauth_return";

const SCOPES: Record<Exclude<Provider, "mailrelay" | "smtp">, Partial<Record<Service, string>>> = {
  google: {
    mail: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    calendar: "https://www.googleapis.com/auth/calendar.events",
    gads: "https://www.googleapis.com/auth/adwords",
    analytics: "https://www.googleapis.com/auth/analytics.readonly",
  },
  microsoft: {
    mail: "Mail.Read Mail.Send",
    calendar: "Calendars.ReadWrite",
  },
  meta: {
    facebook: "pages_show_list pages_read_engagement pages_manage_posts pages_read_user_content read_insights",
    instagram: "pages_show_list pages_read_engagement instagram_basic instagram_content_publish instagram_manage_insights instagram_manage_comments",
    ads: "ads_read leads_retrieval pages_manage_ads business_management",
    whatsapp: "whatsapp_business_management whatsapp_business_messaging business_management",
  },
  linkedin: {
    linkedin: "w_member_social",
    linkedin_pages: "rw_organization_admin r_organization_social w_organization_social",
  },
};
const BASE_SCOPES: Record<Exclude<Provider, "mailrelay" | "smtp">, string> = { google: "openid email profile", microsoft: "offline_access User.Read", meta: "public_profile email", linkedin: "openid profile email" };
const AUTH_URL: Record<Exclude<Provider, "mailrelay" | "smtp">, string> = {
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  meta: "https://www.facebook.com/v26.0/dialog/oauth",
  linkedin: "https://www.linkedin.com/oauth/v2/authorization",
};
export const providerReady = (p: Provider) => (p === "mailrelay" || p === "smtp" ? true : p === "google" ? !!GOOGLE_CLIENT_ID : p === "meta" ? !!META_APP_ID : p === "linkedin" ? !!LINKEDIN_CLIENT_ID : !!MS_CLIENT_ID);

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
    // this window only hands the code back and closes: it must not renew the shared sign-in session too
    try { void supabase.auth.stopAutoRefresh(); } catch { /* ignore */ }
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error_description") || url.searchParams.get("error");
    ["code", "state", "scope", "authuser", "prompt", "hd", "session_state", "error", "error_description", "error_uri", "client_info", "iss"]
      .forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(window.history.state, "", url.pathname + url.search + (url.hash === "#_=_" ? "" : url.hash)); // Facebook adds "#_=_"
    const msg = { type: "acc-return", code, state, error: err, at: Date.now() };
    try { const bc = new BroadcastChannel(CHANNEL); bc.postMessage(msg); bc.close(); } catch { /* old browser */ }
    try { window.opener?.postMessage(msg, window.location.origin); } catch { /* opener gone */ }
    try { localStorage.setItem(RETURN_KEY, JSON.stringify(msg)); } catch { /* ignore */ }
    setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 150);
  } catch { /* never break start-up */ }
})();

/* ---------- edge function ---------- */
/** Enterprise Calendar: of these entries of yours, the ones whose Outlook / Google event was deleted there —
 *  the server has deleted them in Next too (and their events in your other calendars). */
export async function entriesGoneOutside(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const r = await call("entries_gone", { ids }).catch(() => null);
  return Array.isArray(r?.gone) ? (r.gone as string[]) : [];
}

async function call(action: string, payload: object = {}, retried = false, fn = "connected-accounts"): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: "Your session ended — reload the page and sign in again." };
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch { return { error: "The connection service isn't reachable yet.", missing: true }; }
  const text = await res.text();
  let body: any; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 200) }; }
  if (res.status === 404) return { error: "The connection service isn't installed yet.", missing: true };
  if (res.status === 401) {
    // the session's access token went stale (e.g. renewed in another tab): renew once and retry
    if (!retried) { const { error } = await supabase.auth.refreshSession(); if (!error) return call(action, payload, true, fn); }
    return { error: "Your session ended — reload the page and sign in again." };
  }
  if (!res.ok && !body?.error) body = { ...(body ?? {}), error: `HTTP ${res.status}` };
  return body;
}

/** Accounts you connected (newest last). Empty when SQL 119 isn't applied yet. */
export async function listAccounts(): Promise<{ accounts: ConnectedAccount[]; needsSql: boolean }> {
  const { data, error } = await supabase.from("connected_accounts")
    .select("id, provider, email, display_name, services, status, last_error, connected_at, updated_at, settings").order("connected_at");
  if (error && /settings/.test(error.message)) {          // SQL 145 not applied yet
    const r = await supabase.from("connected_accounts").select("id, provider, email, display_name, services, status, last_error, connected_at, updated_at").order("connected_at");
    return { accounts: (r.data ?? []) as ConnectedAccount[], needsSql: false };
  }
  if (error) return { accounts: [], needsSql: /connected_accounts|relation|schema cache/i.test(error.message) };
  return { accounts: (data ?? []) as ConnectedAccount[], needsSql: false };
}

/** A fresh access token of one of your accounts (Google / Microsoft / Meta / LinkedIn) — for reading its data straight from the browser. */
export async function accountToken(id: string): Promise<string> {
  const r = await call("token", { id });
  if (!r?.access_token) throw new Error(r?.error ?? "No token");
  return r.access_token as string;
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
export async function addAccount(provider: Provider, services: Service[], opts: { loginHint?: string } = {}): Promise<{ account?: ConnectedAccount; assets?: { pages?: number; instagram?: number; ad_accounts?: number; error?: string } | null; error?: string }> {
  if (provider === "mailrelay") return { error: "Mailrelay connects with an API key." };
  if (provider === "smtp") return { error: "IONOS Mail connects with the mailbox's address and password." };
  if (!providerReady(provider)) return { error: `${provider === "google" ? "Google" : provider === "meta" ? "Meta" : provider === "linkedin" ? "LinkedIn" : "Microsoft"} sign-in isn't set up for this app yet.` };
  const verifier = rnd(48);
  const state = `${STATE_PREFIX}${provider}.${rnd(12)}`;
  const pagesApp = provider === "linkedin" && services.includes("linkedin_pages") && LINKEDIN_PAGES_APP;
  const scopeList = Array.from(new Set([pagesApp ? "r_basicprofile" : BASE_SCOPES[provider], ...services.map((s) => SCOPES[provider][s] ?? "")].join(" ").split(" ").filter(Boolean)));
  const q = provider === "meta" ? new URLSearchParams({
    // Facebook Login: no PKCE, comma-separated scopes — or a login configuration (Facebook Login for Business)
    client_id: META_APP_ID, response_type: "code", redirect_uri: REDIRECT_URI, state,
    ...(META_CONFIG_ID ? { config_id: META_CONFIG_ID } : { scope: scopeList.join(",") }),
    ...(opts.loginHint ? { auth_type: "rerequest" } : {}),
  }) : provider === "linkedin" ? new URLSearchParams({
    // LinkedIn (web apps): no PKCE, space-separated scopes; the code is swapped with the client secret on the server
    client_id: pagesApp ? LINKEDIN_PAGES_CLIENT_ID : LINKEDIN_CLIENT_ID,
    response_type: "code", redirect_uri: REDIRECT_URI, state, scope: scopeList.join(" "),
  }) : new URLSearchParams({
    client_id: provider === "google" ? GOOGLE_CLIENT_ID : MS_CLIENT_ID,
    response_type: "code", redirect_uri: REDIRECT_URI, scope: scopeList.join(" "), state,
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
    // LinkedIn, Microsoft and Google pages cut the link to this window (Cross-Origin-Opener-Policy): from then on
    // `popup.closed` reads true although the sign-in is still open. So "closed" only counts once this window has
    // the focus back for a moment (the person closed the popup, or came back without finishing); the code itself
    // still arrives by BroadcastChannel / storage whenever they finish. Ten minutes at most.
    const opened = Date.now();
    let back = 0;
    const timer = window.setInterval(() => {
      let closed = false; try { closed = popup.closed; } catch { closed = false; }
      if (Date.now() - opened > 10 * 60_000) { finish(null); return; }
      if (!closed) { back = 0; return; }
      back = document.hasFocus() ? back + 1 : 0;
      if (back >= 4) finish(null);                           // 2 s back here with the popup gone or cut off
    }, 500);
  });
  if (!back) return { error: "The sign-in window was closed before it finished. Try again — if it keeps happening, allow pop-ups for this site and sign in to LinkedIn / Google / Microsoft in that window." };
  if (back.error || !back.code) return { error: back.error || "The sign-in didn't finish." };
  const r = await call("connect", { provider, code: back.code, codeVerifier: verifier, redirectUri: REDIRECT_URI, services });
  if (r?.error) return { error: r.error };
  return { account: r.account as ConnectedAccount, assets: r.assets ?? null };
}

/** Refresh one account's access now: marks it working / needing sign-in again. SMTP mailboxes sign in again (marketing-hub). */
export async function checkAccount(id: string, provider?: Provider): Promise<{ status: "active" | "error"; error?: string }> {
  const r = provider === "smtp" ? await call("smtp_check", { id }, false, "marketing-hub") : await call("check", { id });
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

/* ---------- Meta: what a login reaches ---------- */
export interface ConnectedAsset {
  id: string; account_id: string; kind: "facebook_page" | "instagram" | "ad_account" | "linkedin_org" | "mailrelay_group" | "whatsapp_number" | "gads_customer" | "ga_property"; external_id: string;
  name: string | null; username: string | null; picture_url: string | null; extra: Record<string, any>; updated_at: string;
}
/** Facebook pages, Instagram accounts and ad accounts of your Meta logins (SQL 123). */
export async function listAssets(): Promise<ConnectedAsset[]> {
  const { data, error } = await supabase.from("connected_assets").select("id, account_id, kind, external_id, name, username, picture_url, extra, updated_at").order("name");
  return error ? [] : ((data ?? []) as ConnectedAsset[]);
}
/** Re-read a Meta login's pages / Instagram accounts / ad accounts, or a LinkedIn login's company pages. */
export async function syncAssets(id: string, what?: "gads" | "analytics"): Promise<{ error?: string }> {
  const r = await call("assets_sync", { id, what });
  return r?.error ? { error: r.error } : r?.assets?.error ? { error: r.assets.error } : {};
}

/* ---------- Mailrelay: an API key, not a sign-in ---------- */
/**
 * Connect a Mailrelay account (e-mail marketing) with its address
 * (yourcompany.ipzmarketing.com — "yourcompany" alone works too) and an API key
 * from Mailrelay › Settings › API keys. The edge function checks the key and keeps
 * it on the server (it never comes back to the browser); the account's groups are read.
 */
export async function connectMailrelay(account: string, apiKey: string): Promise<{ account?: ConnectedAccount; assets?: { groups?: number; error?: string } | null; error?: string }> {
  const r = await call("connect_key", { provider: "mailrelay", account, apiKey });
  if (r?.error) return { error: r.error };
  return { account: r.account as ConnectedAccount, assets: r.assets ?? null };
}

/* ---------- IONOS Mail (or any SMTP mailbox): address + password ---------- */
/** Servers IONOS gives its mailboxes (smtp.ionos.es for Spain…). Empty host = try them all. */
export const IONOS_SMTP_HOSTS = ["smtp.ionos.es", "smtp.ionos.com", "smtp.ionos.de", "smtp.ionos.co.uk", "smtp.ionos.fr", "smtp.ionos.it", "smtp.ionos.mx"];
/**
 * Connect an IONOS mailbox: the edge function "marketing-hub" signs in to its SMTP server once
 * (port 465, TLS) and keeps the password on the server (connected_account_tokens — it never comes back here).
 * The mailbox then sends e-mails and campaigns like a connected Gmail / Outlook (SQL 145).
 */
export async function connectSmtp(m: { email: string; password: string; name?: string; host?: string; port?: number }): Promise<{ account?: ConnectedAccount; error?: string }> {
  const r = await call("smtp_connect", { email: m.email, password: m.password, name: m.name ?? null, host: m.host || null, port: m.port ?? 465 }, false, "marketing-hub");
  if (r?.error) return { error: r.missing ? "The marketing service isn't installed yet." : r.error };
  return { account: r.account as ConnectedAccount };
}

/* ---------- WhatsApp Business (Cloud API, through the Meta login) ---------- */
export interface WhatsAppMessage {
  id: string; asset_id: string | null; phone_number_id: string; direction: "in" | "out"; contact_phone: string; contact_name: string | null;
  type: string; body: string | null; status: string | null; error: string | null; created_at: string;
}
/** Send from one of your WhatsApp numbers. Free text only reaches someone who wrote to you in the last 24 h;
 *  to start a conversation use an approved template (Meta gives every account "hello_world"). */
export async function sendWhatsApp(assetId: string, to: string, msg: { text?: string; template?: string; lang?: string }): Promise<{ error?: string }> {
  const r = await call("wa_send", { assetId, to, ...msg });
  return r?.error ? { error: r.error } : {};
}
/** Latest WhatsApp messages of your numbers (SQL 127), newest first. */
export async function listWhatsAppMessages(limit = 40): Promise<WhatsAppMessage[]> {
  const { data, error } = await supabase.from("whatsapp_messages")
    .select("id, asset_id, phone_number_id, direction, contact_phone, contact_name, type, body, status, error, created_at")
    .order("created_at", { ascending: false }).limit(limit);
  return error ? [] : ((data ?? []) as WhatsAppMessage[]);
}
/** Add a WhatsApp Business account to a Meta login by its ID (Meta's test account isn't owned by your business). */
export async function addWhatsAppAccount(accountId: string, wabaId: string): Promise<{ numbers?: number; error?: string }> {
  const r = await call("wa_add", { id: accountId, wabaId });
  return r?.error ? { error: r.error } : { numbers: r?.numbers ?? 0 };
}
/** Connect WhatsApp with a system-user token of your business (it stays on the server). */
export async function connectWhatsAppToken(token: string, wabaId: string): Promise<{ numbers?: number; error?: string }> {
  const r = await call("wa_token", { token, wabaId });
  return r?.error ? { error: r.error } : { numbers: r?.numbers ?? 0 };
}
