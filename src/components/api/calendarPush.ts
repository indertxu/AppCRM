/* =====================================================================
   Every entry you log also lands in your Google calendars (Enterprise; the idea and the
   google_event_ids column come from Base, src/base/api/calendarPush.ts + SQL 150).
   - Outlook: the existing sync (syncCalendarEntry → edge function "outlook-sync").
   - Google: each Google account with Calendar on (Settings › Integrations) that
     Settings › Calendar › My calendars shows; its primary calendar, written straight to
     the Calendar API with the account's token (scope calendar.events). The event id per
     account is kept in calendar_entries.google_event_ids, so an edit updates that event
     and a delete removes it.
   One calendar invites the people (and holds the call), never two:
     · "Google Meet" → the first Google calendar: a Meet link, attendees, Google e-mails them
       (sendUpdates=all); Outlook only keeps the time (outlookSync.ts).
     · "Teams" → Outlook, as before; the Google copy is just the time.
     · call / in person → Outlook when it's connected, else the first Google calendar.
   Like Outlook, only entries still to come invite anyone. The events carry
   extendedProperties.private.nextEntry = the entry id, so the Calendar doesn't draw them
   a second time next to the entry (googleCalendar.ts).
   ===================================================================== */
import { supabase } from "./supabase";
import { entryInvite, syncCalendarEntry, deleteEntryFromOutlook, outlookStatus, type OutlookSyncResult } from "./outlookSync";
import { googleCalendarAccounts, type GoogleCalAccount } from "./googleCalendar";
import { accountToken } from "./connectedAccounts";
import { loadCalendarSources, calendarShown } from "./calendarSources";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
type Ids = Record<string, string>;
const idsOf = (v: unknown): Ids => (v && typeof v === "object" && !Array.isArray(v) ? (v as Ids) : {});

/** The Google accounts an entry goes to: Calendar on, and shown in My calendars. */
export async function googleTargets(): Promise<GoogleCalAccount[]> {
  const [accs, src] = await Promise.all([googleCalendarAccounts().catch(() => [] as GoogleCalAccount[]), loadCalendarSources()]);
  return accs.filter((a) => calendarShown(src, "google", a.id));
}

let olKnown: { at: number; on: Promise<boolean> } | null = null;
/** Whether your Outlook is connected (asked once a minute at most). */
function outlookOn(): Promise<boolean> {
  if (olKnown && Date.now() - olKnown.at < 60_000) return olKnown.on;
  olKnown = { at: Date.now(), on: outlookStatus().catch(() => false) };
  return olKnown.on;
}

/** Puts (or updates) this entry in your Google calendars. Quiet: a failure only warns in the console. */
export async function pushEntryToGoogle(entryId: string): Promise<{ meetUrl: string | null }> {
  const out = { meetUrl: null as string | null };
  try {
    const [{ data: auth }, { data: row }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from("calendar_entries").select("*").eq("id", entryId).maybeSingle(),
    ]);
    const e = row as any;
    const me = auth?.user;
    if (!e || !me || e.user_id !== me.id || e.outlook_source_id || e.split_of) return out;
    const all = await googleTargets();
    // the Google calendars picked for this entry (SQL 152; null = all); one left out loses the event it had
    const pick: string[] | null = Array.isArray(e.calendars?.google) ? e.calendars.google : null;
    const targets = pick ? all.filter((a) => pick.includes(a.id)) : all;
    const had: Ids = { ...idsOf(e.google_event_ids) };
    const drop = Object.keys(had).filter((acc) => !targets.some((t) => t.id === acc));
    if (drop.length) {
      await removeGoogleEvents([Object.fromEntries(drop.map((acc) => [acc, had[acc]]))]);
      const keep = Object.fromEntries(Object.entries(had).filter(([acc]) => !drop.includes(acc)));
      await supabase.from("calendar_entries").update({ google_event_ids: keep }).eq("id", entryId);
      e.google_event_ids = keep;
    }
    if (!targets.length) return out;
    const inv = await entryInvite(e, me);
    const kind = String(e.meeting_kind ?? "");
    // which of my Google calendars sends the invites (index into targets), or none
    const olOn = e.calendars?.outlook !== false && (await outlookOn());
    const organiser = kind === "meet" ? 0 : kind === "teams" ? (olOn ? -1 : 0) : olOn ? -1 : 0;
    const end = Number(e.end_min) > Number(e.start_min) ? Number(e.end_min) : Number(e.start_min) + 30;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const description = [
      inv.notes,
      inv.details.map(([k, v]) => `${k}: ${v.replace(/\n/g, ", ")}`).join("\n"),
      kind === "teams" ? "The Teams link is in the Outlook invite." : "",
      "Logged in Next",
    ].filter(Boolean).join("\n\n");
    const ids: Ids = { ...idsOf(e.google_event_ids) };
    let changed = false;
    for (const [i, a] of targets.entries()) {
      const lead = i === organiser;
      const mine = new Set(targets.map((t) => t.email.toLowerCase()));
      const people = lead ? inv.attendees.filter((x) => x.email && !mine.has(x.email.toLowerCase())) : [];
      const body: Record<string, unknown> = {
        summary: inv.subject,
        description,
        location: inv.location ?? (kind === "phone" ? "Phone call" : ""),
        start: { dateTime: `${e.entry_date}T${hm(Number(e.start_min) || 0)}:00`, timeZone: tz },
        end: { dateTime: `${e.entry_date}T${hm(end)}:00`, timeZone: tz },
        transparency: e.kind === "shipment" ? "transparent" : "opaque",
        extendedProperties: { private: { nextEntry: String(e.id) } },
        reminders: { useDefault: true },
        attendees: people.map((x) => ({ email: x.email, displayName: x.name || undefined })),
        guestsCanModify: false,
        // the call: a Meet on the calendar that invites; a Meet the same entry already had is kept (same request id)
        conferenceData: lead && kind === "meet"
          ? { createRequest: { requestId: `next-${e.id}`, conferenceSolutionKey: { type: "hangoutsMeet" } } }
          : null,
      };
      const q = `conferenceDataVersion=1&sendUpdates=${people.length ? "all" : "none"}`;
      try {
        const headers = { Authorization: `Bearer ${await accountToken(a.id)}`, "Content-Type": "application/json" };
        let res: Response | null = null;
        if (ids[a.id]) {
          res = await fetch(`${API}/${encodeURIComponent(ids[a.id])}?${q}`, { method: "PATCH", headers, body: JSON.stringify(body) });
          if (res.status === 404 || res.status === 410) res = null; // gone from Google: make it again
        }
        if (!res) res = await fetch(`${API}?${q}`, { method: "POST", headers, body: JSON.stringify(body) });
        const j = await res.json().catch(() => ({} as any));
        if (!res.ok) { console.warn("[google] entry", entryId, "not synced:", j?.error?.message ?? res.status); continue; }
        if (j.id && j.id !== ids[a.id]) { ids[a.id] = j.id; changed = true; }
        if (lead && j.hangoutLink) out.meetUrl = j.hangoutLink;
      } catch (err: any) {
        console.warn("[google] entry", entryId, "not synced:", err?.message ?? err);
      }
    }
    if (changed) {
      const { error } = await supabase.from("calendar_entries").update({ google_event_ids: ids }).eq("id", entryId);
      if (error) console.warn("[google] couldn't keep the event id (src/base/sql/150_entry_google_events.sql):", error.message);
    }
  } catch (err: any) {
    console.warn("[google] entry", entryId, "not synced:", err?.message ?? err);
  }
  return out;
}

/** The Google events of these entries — read before the rows are deleted. */
export async function googleEventsOf(entryIds: string[]): Promise<Ids[]> {
  if (!entryIds.length) return [];
  const out: Ids[] = [];
  for (let i = 0; i < entryIds.length; i += 200) {
    const { data } = await supabase.from("calendar_entries").select("google_event_ids").in("id", entryIds.slice(i, i + 200));
    ((data ?? []) as any[]).forEach((r) => { const m = idsOf(r.google_event_ids); if (Object.keys(m).length) out.push(m); });
  }
  return out;
}

/** Removes those events from Google (best effort; an account that's gone is skipped). Invited people are told. */
export async function removeGoogleEvents(maps: Ids[]): Promise<void> {
  const tokens: Record<string, string | null> = {};
  for (const m of maps) {
    for (const [acc, ev] of Object.entries(m)) {
      try {
        if (!(acc in tokens)) tokens[acc] = await accountToken(acc).catch(() => null);
        const tok = tokens[acc];
        if (!tok) continue;
        await fetch(`${API}/${encodeURIComponent(ev)}?sendUpdates=all`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } });
      } catch { /* best effort */ }
    }
  }
}

/** Outlook (as before) and Google, together. Returns Outlook's result, which the Calendar reads. */
export async function syncEntryEverywhere(entryId: string): Promise<OutlookSyncResult> {
  const [o] = await Promise.all([syncCalendarEntry(entryId), pushEntryToGoogle(entryId)]);
  return o;
}

/** Before deleting one entry: its Outlook and Google events go too. Call it while the row still exists. */
export async function unsyncEntryEverywhere(entryId: string): Promise<void> {
  const { data } = await supabase.from("calendar_entries").select("outlook_event_id, google_event_ids").eq("id", entryId).maybeSingle();
  const r = data as any;
  await Promise.race([
    Promise.all([
      r?.outlook_event_id ? deleteEntryFromOutlook(r.outlook_event_id, entryId).catch(() => {}) : Promise.resolve(),
      removeGoogleEvents([idsOf(r?.google_event_ids)]),
    ]),
    new Promise((ok) => setTimeout(ok, 8000)),
  ]);
}

/** Whether the "Google Meet" choice makes sense: you have a Google calendar the entries go to. */
export async function canGoogleMeet(): Promise<boolean> {
  return (await googleTargets().catch(() => [])).length > 0;
}
