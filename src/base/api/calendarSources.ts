/* =====================================================================
   BASE · Which calendars your Calendar shows (Settings › Integrations).
   Per person, kept with the profile (profiles.prefs.calendarSources):
     google / microsoft — the whole provider on or off
     hidden             — single accounts turned off ("<provider>:<account id or 'primary'>")
   The Calendar reads it with useCalendarSources(); a change in Settings
   reaches an open Calendar at once (window event).
   ===================================================================== */
import { useEffect, useState } from "react";
import { loadPrefs, savePref } from "../pages/companies/companiesApi";

export interface CalendarSources { google: boolean; microsoft: boolean; hidden: string[] }
export const CAL_SOURCES_DEFAULT: CalendarSources = { google: true, microsoft: true, hidden: [] };
const KEY = "calendarSources";
const EVENT = "next:calendar-sources";

const clean = (v: any): CalendarSources => ({
  google: v?.google !== false,
  microsoft: v?.microsoft !== false,
  hidden: Array.isArray(v?.hidden) ? v.hidden.filter((x: unknown) => typeof x === "string") : [],
});

export async function loadCalendarSources(): Promise<CalendarSources> {
  try { return clean((await loadPrefs())[KEY]); } catch { return CAL_SOURCES_DEFAULT; }
}
export async function saveCalendarSources(s: CalendarSources) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: s }));
  await savePref(KEY, s);
}
/** Is this account's calendar shown? */
export const calendarShown = (s: CalendarSources, provider: "google" | "microsoft", accountId: string) =>
  s[provider] && !s.hidden.includes(`${provider}:${accountId}`);

export function useCalendarSources(): CalendarSources {
  const [s, setS] = useState<CalendarSources>(CAL_SOURCES_DEFAULT);
  useEffect(() => {
    let alive = true;
    loadCalendarSources().then((x) => { if (alive) setS(x); });
    const on = (e: Event) => setS(clean((e as CustomEvent).detail));
    window.addEventListener(EVENT, on);
    return () => { alive = false; window.removeEventListener(EVENT, on); };
  }, []);
  return s;
}
