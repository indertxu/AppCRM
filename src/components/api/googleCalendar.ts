/* =====================================================================
   Google Calendar events for the Calendar (copied from Base, src/base/api/googleCalendar.ts) — read straight from Google
   with each account's access token (edge function "connected-accounts" →
   action "token"; the refresh token never leaves the server).
   Every connected Google account with "calendar" (Settings › Integrations)
   that Settings › Calendar › My calendars shows; its primary calendar.
   Events come in Outlook's shape (OutlookEvent, src: "google") so the
   Calendar draws both the same way, each in its own colour.
   ===================================================================== */
import { useCallback, useEffect, useState } from "react";
import { accountToken, listAccounts } from "./connectedAccounts";
import { callLinkIn, type OutlookEvent } from "./outlookSync";

export interface GoogleCalAccount { id: string; email: string }
/** Your Google accounts with Calendar on. */
export async function googleCalendarAccounts(): Promise<GoogleCalAccount[]> {
  const r = await listAccounts();
  return r.accounts.filter((a) => a.provider === "google" && a.services.includes("calendar") && a.status !== "error").map((a) => ({ id: a.id, email: a.email }));
}

const cache = new Map<string, { at: number; p: Promise<OutlookEvent[]> }>();
const TTL = 3 * 60000;
const toEvent = (g: any, email: string): OutlookEvent | null => {
  if (!g?.id || g.status === "cancelled") return null;
  const allDay = !!g.start?.date;
  const start = allDay ? `${g.start.date}T00:00:00.000Z` : g.start?.dateTime;
  const end = allDay ? `${g.end?.date ?? g.start.date}T00:00:00.000Z` : g.end?.dateTime;
  if (!start || !end) return null;
  // the Meet link; else any video entry point (Zoom, Teams add-ons); else a call link written in the place or the description
  const join = g.hangoutLink || g.conferenceData?.entryPoints?.find((x: any) => x.entryPointType === "video")?.uri
    || callLinkIn(g.location, g.description) || null;
  const me = (g.attendees ?? []).find((a: any) => a.self);
  if (me?.responseStatus === "declined") return null;
  return {
    id: `g:${g.id}`, subject: g.summary || "(no title)", start: new Date(start).toISOString(), end: new Date(end).toISOString(), allDay,
    showAs: g.transparency === "transparent" ? "free" : me?.responseStatus === "tentative" ? "tentative" : "busy",
    location: g.location ?? null, organizer: g.organizer?.displayName || g.organizer?.email || null, isOrganizer: !!g.organizer?.self,
    online: !!join, joinUrl: join, webLink: g.htmlLink ?? null, preview: String(g.description ?? "").replace(/<[^>]+>/g, " ").slice(0, 280),
    attendees: (g.attendees ?? []).length, private: g.visibility === "private", recurring: !!g.recurringEventId, src: "google", account: email,
  };
};
/** One account's primary calendar between two instants (cached a few minutes). */
function fetchAccount(acc: GoogleCalAccount, from: Date, to: Date, fresh: boolean): Promise<OutlookEvent[]> {
  const key = `${acc.id}|${from.toISOString()}|${to.toISOString()}`;
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < TTL) return hit.p;
  const p = (async () => {
    const token = await accountToken(acc.id);
    const out: OutlookEvent[] = [];
    let page: string | undefined;
    for (let i = 0; i < 8; i++) {
      const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      if (page) q.set("pageToken", page);
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error?.message ?? `Google Calendar ${res.status}`);
      (j.items ?? []).forEach((g: any) => { const e = toEvent(g, acc.email); if (e) out.push(e); });
      page = j.nextPageToken;
      if (!page) break;
    }
    return out;
  })();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

export interface GoogleEventsResult { events: OutlookEvent[]; loading: boolean; error?: string; accounts: GoogleCalAccount[] | null; reload: () => void }
/** The events of the Google accounts in `accountIds` (null: every one) between `from` and `to`. */
export function useGoogleEvents(from: Date, to: Date, enabled: boolean, hidden: string[] = []): GoogleEventsResult {
  const [accounts, setAccounts] = useState<GoogleCalAccount[] | null>(null);
  const [st, setSt] = useState<{ events: OutlookEvent[]; loading: boolean; error?: string }>({ events: [], loading: false });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => { cache.clear(); setTick((t) => t + 1); }, []);
  useEffect(() => { googleCalendarAccounts().then(setAccounts).catch(() => setAccounts([])); }, [tick]);
  const fromKey = from.getTime(), toKey = to.getTime(), hideKey = hidden.join("|");
  useEffect(() => {
    if (!enabled || !accounts) { setSt((s) => ({ ...s, loading: false })); return; }
    const use = accounts.filter((a) => !hidden.includes(`google:${a.id}`));
    if (!use.length) { setSt({ events: [], loading: false }); return; }
    let alive = true;
    setSt((s) => ({ ...s, loading: true }));
    Promise.allSettled(use.map((a) => fetchAccount(a, new Date(fromKey), new Date(toKey), tick > 0))).then((rs) => {
      if (!alive) return;
      const events = rs.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      const bad = rs.map((r, i) => (r.status === "rejected" ? `${use[i].email}: ${String((r.reason as Error)?.message ?? r.reason)}` : "")).filter(Boolean);
      setSt({ events, loading: false, error: bad.length ? bad.join(" · ") : undefined });
    });
    return () => { alive = false; };
  }, [enabled, accounts, fromKey, toKey, hideKey, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...st, accounts, reload };
}
