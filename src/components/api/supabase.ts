import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase environment variables. Check your .env file."
  );
}

/**
 * "Keep me signed in" — and one session per tab.
 *
 * Each tab keeps its own session (sessionStorage; memory when the browser
 * blocks it), so two tabs can be signed in as two different people at the
 * same time: signing in, switching or signing out in one never touches the
 * other. With "Keep me signed in" the session is also remembered in
 * localStorage: that copy only starts a NEW tab (and survives restarting the
 * browser), and it is shared by the tabs of the SAME person, so their token
 * refreshes don't fight. A tab never overwrites or removes someone else's
 * remembered session.
 *
 * The client's storage key carries a per-page-load tag, so supabase-js's
 * cross-tab channel ("signed in / signed out in another tab") and its refresh
 * lock stay inside this tab; the storage below drops the tag, so what is saved
 * keeps the usual key (sessions saved before this change still work).
 */
const REMEMBER_KEY = "np-remember";
const memory = new Map<string, string>();
const tab = {
  get: (k: string): string | null => { try { return sessionStorage.getItem(k) ?? memory.get(k) ?? null; } catch { return memory.get(k) ?? null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { memory.set(k, v); } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } memory.delete(k); },
};
const shared = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const remembered = () => shared.get(REMEMBER_KEY) === "true";

const PROJECT_REF = (() => { try { return new URL(supabaseUrl).hostname.split(".")[0]; } catch { return "app"; } })();
/** The key sessions are saved under (supabase-js's default for this project). */
const AUTH_KEY = `sb-${PROJECT_REF}-auth-token`;
/** This page load's tag: keeps supabase-js's cross-tab channel and lock to this tab. */
const TAB_TAG = `.tab-${Math.random().toString(36).slice(2, 10)}`;
const canon = (key: string) => key.replace(TAB_TAG, "");

/** Whose session a stored value is (null when it isn't one). */
const userOf = (raw: string | null): string | null => {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw.startsWith("base64-") ? atob(raw.slice(7)) : raw);
    return j?.user?.id ?? j?.currentSession?.user?.id ?? null;
  } catch { return null; }
};
/** The session itself (not the sign-in code verifier or the cached user). */
const isSession = (key: string) => key === AUTH_KEY;

const smartStorage = {
  getItem: (rawKey: string): string | null => {
    const key = canon(rawKey);
    const mine = tab.get(key);
    const kept = shared.get(key);
    if (!isSession(key)) return mine ?? kept;
    if (mine == null) return kept;                          // a new tab: start from the remembered session
    // the same person in both: the shared copy has the freshest token among their tabs
    return kept != null && userOf(kept) === userOf(mine) ? kept : mine;
  },
  setItem: (rawKey: string, value: string): void => {
    const key = canon(rawKey);
    tab.set(key, value);
    // the sign-in code verifier also goes to localStorage: a reset / magic link opens in a new tab
    if (!isSession(key)) { if (key.endsWith("-code-verifier") || remembered()) shared.set(key, value); return; }
    if (!remembered()) return;
    const kept = shared.get(key);
    // remember it only when nobody else is remembered, or it's the same person
    if (kept == null || userOf(kept) === userOf(value)) shared.set(key, value);
  },
  removeItem: (rawKey: string): void => {
    const key = canon(rawKey);
    const mine = tab.get(key);
    tab.del(key);
    const kept = shared.get(key);
    if (kept == null) return;
    // never someone else's remembered session
    if (!isSession(key) || mine == null || userOf(kept) === userOf(mine)) shared.del(key);
  },
};

/** The page you were on when the app sent you to sign in: you go back there after. */
export const RETURN_TO_KEY = "np-return-to";
export function rememberReturnTo(path: string) {
  if (!path || path.startsWith("/login") || path === "/" || path.startsWith("/__")) return;
  try { sessionStorage.setItem(RETURN_TO_KEY, path); } catch { /* ignore */ }
}
export function takeReturnTo(): string | null {
  try { const v = sessionStorage.getItem(RETURN_TO_KEY); sessionStorage.removeItem(RETURN_TO_KEY); return v; } catch { return null; }
}

/**
 * Requests that never reach the server ("TypeError: Failed to fetch": the
 * connection dropped, the laptop woke up, a blocker stopped it) are tried again
 * when it's safe to: reads, updates and deletes (doing them twice changes
 * nothing). Inserts aren't repeated (that could add a row twice). When it still
 * fails, the message says what couldn't be reached instead of a bare
 * "Failed to fetch", and the request is logged in the console as [network].
 */
const RETRY_WAIT = [400, 1200];
const whatOf = (url: string, method: string) => {
  try {
    const u = new URL(url);
    const m = /\/(rest|functions|storage|auth)\/v1\/(.+)$/.exec(u.pathname);
    const thing = m ? (m[1] === "rest" ? m[2].replace(/^rpc\//, "") : `${m[1]} ${m[2]}`) : u.pathname;
    const verb = method === "GET" || method === "HEAD" ? "reading" : method === "DELETE" ? "deleting from" : method === "POST" ? (m && m[2].startsWith("rpc/") ? "asking" : "adding to") : "saving";
    return `${verb} ${thing.replace(/_/g, " ")}`;
  } catch { return "talking to the server"; }
};
export const netFailures: { at: string; method: string; url: string }[] = [];

/**
 * Usage meter: requests and bytes this tab exchanged with Supabase. The app layout
 * reads it per page visit and writes it to platform_page_visits (the superadmin's
 * cost panel). Bytes: the response size (Content-Length, or the body itself) plus
 * what was sent.
 */
export const usageMeter = { requests: 0, bytes: 0 };
const METER_SKIP = /\/rest\/v1\/platform_page_visits/;
function meter(url: string, init: RequestInit | undefined, res: Response) {
  if (METER_SKIP.test(url)) return;
  usageMeter.requests++;
  if (typeof init?.body === "string") usageMeter.bytes += init.body.length;
  const len = Number(res.headers.get("content-length"));
  if (len > 0) { usageMeter.bytes += len; return; }
  if (!res.body || res.status === 204 || res.status === 304) return;
  try { res.clone().blob().then((b) => { usageMeter.bytes += b.size; }, () => { /* ignore */ }); } catch { /* ignore */ }
}
async function sturdyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  // reads of tables are already retried by supabase-js itself; here: updates, deletes and the other reads
  const rest = /\/rest\/v1\//.test(url);
  const safe = method === "PATCH" || method === "PUT" || method === "DELETE" || (!rest && (method === "GET" || method === "HEAD"));
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(input, init);
      meter(url, init, res);
      return res;
    } catch (e) {
      const aborted = (e as any)?.name === "AbortError" || init?.signal?.aborted;
      if (aborted) throw e;
      if (safe && i < RETRY_WAIT.length) { await new Promise((r) => setTimeout(r, RETRY_WAIT[i])); continue; }
      netFailures.push({ at: new Date().toISOString(), method, url: url.split("?")[0] });
      if (netFailures.length > 20) netFailures.shift();
      console.error("[network] couldn't reach the server:", method, url.split("?")[0], e);
      // shown as "Connection problem: …" (supabase-js prints the error's name first)
      const err = new TypeError(`couldn't reach the server while ${whatOf(url, method)}. Check the connection (or a browser blocker / VPN) and try again.`);
      err.name = "Connection problem";
      throw err;
    }
  }
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: smartStorage,
    storageKey: AUTH_KEY + TAB_TAG,
    persistSession: true,
    autoRefreshToken: true,
  },
  global: { fetch: sturdyFetch },
});

/** Set the remember-me preference. Call this right before signing in. */
export function setRememberMe(remember: boolean): void {
  if (remember) {
    localStorage.setItem(REMEMBER_KEY, "true");
  } else {
    localStorage.removeItem(REMEMBER_KEY);
  }
}