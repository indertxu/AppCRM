import { useSyncExternalStore } from "react";

/* =====================================================================
   "As of" — Clients and Contracts can be looked at as they stood on any
   day: every value worked out from contracts (running or not, which
   contract year, what it bills, renewals, states) reads the clock here
   instead of the real one. null = today, the normal case.
   ===================================================================== */

let asOf: string | null = null;
const subs = new Set<() => void>();
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The day being looked at (YYYY-MM-DD), or null for today. */
export const getAsOf = () => asOf;
/** "Now" for the figures: noon of the chosen day, else the real now. */
export const nowMs = () => (asOf ? +new Date(`${asOf}T12:00:00`) : Date.now());
/** "Today" for the figures, as YYYY-MM-DD. */
export const todayIso = () => asOf ?? localToday();
export function setAsOf(d: string | null) {
  const next = d && d !== localToday() ? d.slice(0, 10) : null;
  if (next === asOf) return;
  asOf = next;
  subs.forEach((f) => f());
}
/** Re-renders when the day changes; returns it (null = today). */
export function useAsOf(): string | null {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => asOf, () => asOf);
}
