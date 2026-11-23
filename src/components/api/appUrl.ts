/**
 * The address a link in an e-mail should open: the live site. When the mail is sent from a local copy of the app
 * (localhost while developing) the browser's own origin would be "http://localhost:5173" — useless to whoever
 * receives it — so the live address is used instead. VITE_PUBLIC_URL (Vercel / .env) wins if it is set.
 */
export const LIVE_URL = "https://nextcrm.atebiz.com";
export function publicOrigin(): string {
  const env = String((import.meta as any).env?.VITE_PUBLIC_URL ?? "").trim();
  if (env) return env.replace(/\/+$/, "");
  if (typeof window === "undefined") return LIVE_URL;
  const h = window.location.hostname;
  return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)$/.test(h) || h.endsWith(".local") ? LIVE_URL : window.location.origin;
}
