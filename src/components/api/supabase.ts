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
 * only in memory, so any refresh (F5) clears it and the user must log in again.
 */
const REMEMBER_KEY = "np-remember";
const memory = new Map<string, string>();

const smartStorage = {
  getItem: (key: string): string | null => {
    const persisted = localStorage.getItem(key);
    if (persisted !== null) return persisted;
    return memory.has(key) ? (memory.get(key) as string) : null;
  },
  setItem: (key: string, value: string): void => {
    if (localStorage.getItem(REMEMBER_KEY) === "true") {
      localStorage.setItem(key, value);
    } else {
      memory.set(key, value);
    }
  },
  removeItem: (key: string): void => {
    localStorage.removeItem(key);
    memory.delete(key);
  },
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: smartStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});

/** Set the remember-me preference. Call this right before signing in. */
export function setRememberMe(remember: boolean): void {
  if (remember) {
    localStorage.setItem(REMEMBER_KEY, "true");
  } else {
    localStorage.removeItem(REMEMBER_KEY);
  }
}