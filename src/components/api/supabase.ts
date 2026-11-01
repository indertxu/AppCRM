import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase environment variables. Check your .env file."
  );
}

/**
 * "Keep me signed in" support.
 *
 * When the remember flag is set, the session is written to localStorage, so it
 * survives refreshes and browser restarts. When it isn't set, the session lives
 * in this tab's sessionStorage: a refresh (F5) keeps you signed in and on the
 * same page, and closing the tab / browser signs you out.
 * (Memory is the fallback when the browser blocks sessionStorage.)
 */
const REMEMBER_KEY = "np-remember";
const memory = new Map<string, string>();
const tab = {
  get: (k: string): string | null => { try { return sessionStorage.getItem(k); } catch { return memory.get(k) ?? null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { memory.set(k, v); } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } memory.delete(k); },
};

const smartStorage = {
  getItem: (key: string): string | null => {
    const persisted = localStorage.getItem(key);
    if (persisted !== null) return persisted;
    return tab.get(key) ?? (memory.has(key) ? (memory.get(key) as string) : null);
  },
  setItem: (key: string, value: string): void => {
    if (localStorage.getItem(REMEMBER_KEY) === "true") {
      localStorage.setItem(key, value);
    } else {
      tab.set(key, value);
    }
  },
  removeItem: (key: string): void => {
    localStorage.removeItem(key);
    tab.del(key);
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