/* =====================================================================
   BASE · Every entry you log also lands in your own calendars.
   - Outlook: the existing sync (edge function "outlook-sync"), unchanged.
   - Google: each Google account with Calendar on (Settings › Integrations)
     that Settings › Calendar › My calendars shows, its primary calendar,
     written straight to the Calendar API with the account's token (scope
     calendar.events). The event id per account is kept in
     calendar_entries.google_event_ids (SQL 150), so an edit updates that
     event and a delete removes it.
   Entries logged from an Outlook / Google event (outlook_source_id) are
   already in a calendar and are left alone. The events carry
   extendedProperties.private.nextEntry = the entry id, which is how the
   Calendar knows not to draw them a second time next to the entry.
   ===================================================================== */
import { supabase } from "../../components/api/supabase";
import { syncCalendarEntry, deleteEntryFromOutlook, type OutlookSyncResult } from "./outlookSync";
import { googleCalendarAccounts, type GoogleCalAccount } from "./googleCalendar";
import { accountToken } from "./connectedAccounts";
import { loadCalendarSources, calendarShown } from "./calendarSources";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const KIND_LABEL: Record<string, string> = {
  client_work: "Client work", client_nonbillable: "Client work (not billed)", shipment: "Shipment", internal: "Something else", meeting: "Meeting",
};
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
type Ids = Record<string, string>;
const idsOf = (v: unknown): Ids => (v && typeof v === "object" && !Array.isArray(v) ? (v as Ids) : {});

/** The Google accounts an entry goes to: Calendar on, and shown in My calendars. */
async function googleTargets(): Promise<GoogleCalAccount[]> {
  const [accs, src] = await Promise.all([googleCalendarAccounts().catch(() => [] as GoogleCalAccount[]), loadCalendarSources()]);
  return accs.filter((a) => calendarShown(src, "google", a.id));
}

/** The Google event for an entry row: same title as in Next, the details in the description. */
async function eventFor(e: any) {
  const [cl, inv] = await Promise.all([
    e.client_id ? supabase.from("clients").select("name").eq("id", e.client_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("entry_invites").select("invitee_id, status").eq("entry_id", e.id),
  ]);
  const client = ((cl as any).data?.name as string) ?? "";
  const who = (((inv as any).data ?? []) as any[]).filter((i) => i.status !== "declined").map((i) => i.invitee_id);
  const { data: profs } = who.length ? await supabase.from("profiles").select("first_name, last_name, username, email").in("id", who) : { data: [] as any[] };
  const team = ((profs ?? []) as any[]).map((p) => [p.first_name, p.last_name].filter(Boolean).join(" ") || p.username || p.email).filter(Boolean);
  const name = (e.name || e.title || "") as string;
  const label = KIND_LABEL[e.kind] ?? "Work";
  const summary = [e.status === "cancelled" ? "Cancelled:" : "", [client, name || label].filter((x, i, a) => x && a.indexOf(x) === i).join(" · ")].filter(Boolean).join(" ");
  const end = Number(e.end_min) > Number(e.start_min) ? Number(e.end_min) : Number(e.start_min) + 30;
  const lines = [
    e.notes ? String(e.notes) : "",
    "",
    `${label}${client ? ` · ${client}` : ""}`,
    e.kind === "client_work" && Number(e.billable) > 0 ? `Billable: ${Number(e.billable)} h` : "",
    team.length ? `With: ${team.join(", ")}` : "",
    "Logged in Next",
  ].filter((x, i) => x || i === 1).join("\n").trim();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    summary,
    description: lines,
    start: { dateTime: `${e.entry_date}T${hm(Number(e.start_min) || 0)}:00`, timeZone: tz },
    end: { dateTime: `${e.entry_date}T${hm(end)}:00`, timeZone: tz },
    // shipments are a moment, not busy time
    transparency: e.kind === "shipment" ? "transparent" : "opaque",
    extendedProperties: { private: { nextEntry: String(e.id) } },
    reminders: { useDefault: true },
  };
}

/** Puts (or updates) this entry in your Google calendars. Quiet: a failure only warns in the console. */
export async function pushEntryToGoogle(entryId: string): Promise<void> {
  try {
    const [{ data: auth }, { data: row }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from("calendar_entries").select("*").eq("id", entryId).maybeSingle(),
    ]);
    const e = row as any;
    if (!e || !auth?.user || e.user_id !== auth.user.id || e.outlook_source_id) return;
    const targets = await googleTargets();
    if (!targets.length) return;
    const ids: Ids = { ...idsOf(e.google_event_ids) };
    const body = JSON.stringify(await eventFor(e));
    let changed = false;
    for (const a of targets) {
      try {
        const headers = { Authorization: `Bearer ${await accountToken(a.id)}`, "Content-Type": "application/json" };
        let res: Response | null = null;
        if (ids[a.id]) {
          res = await fetch(`${API}/${encodeURIComponent(ids[a.id])}`, { method: "PATCH", headers, body });
          if (res.status === 404 || res.status === 410) res = null; // gone from Google: make it again
        }
        if (!res) res = await fetch(API, { method: "POST", headers, body });
        const j = await res.json().catch(() => ({} as any));
        if (!res.ok) { console.warn("[google] entry", entryId, "not synced:", j?.error?.message ?? res.status); continue; }
        if (j.id && j.id !== ids[a.id]) { ids[a.id] = j.id; changed = true; }
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

/** Removes those events from Google (best effort; an account that's gone is skipped). */
export async function removeGoogleEvents(maps: Ids[]): Promise<void> {
  const tokens: Record<string, string | null> = {};
  for (const m of maps) {
    for (const [acc, ev] of Object.entries(m)) {
      try {
        if (!(acc in tokens)) tokens[acc] = await accountToken(acc).catch(() => null);
        const tok = tokens[acc];
        if (!tok) continue;
        await fetch(`${API}/${encodeURIComponent(ev)}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } });
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
