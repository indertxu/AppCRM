/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

/**
 * Invitations, for anything that takes up time.
 *
 * Every event lives in calendar_entries now — delivery work, own work, sales
 * meetings — so one invite table covers all of them. The organiser books their
 * own event and names who should be there, deciding what each of them bills
 * for attending. Until someone accepts, the invite shows on their calendar in
 * its own style; on accepting, it becomes a real entry of the same kind, so it
 * counts towards their targets like anything else they log.
 */
export interface EntryInvite {
  id: string;
  entry_id: string;
  organiser_id: string;
  invitee_id: string;
  billable: number;
  billing_line: string;
  status: "pending" | "accepted" | "declined";
  message: string | null;
  created_at: string;
}

/** What an invitee needs to show the invite without opening anything else. */
export interface InviteCard extends EntryInvite {
  organiser_name: string;
  kind: string;
  title: string | null;
  date_key: string;
  entry_date: string;
  start_min: number;
  end_min: number;
  work_type_id: string | null;
  project_id: string | null;
  client_id: string | null;
  company_id: string | null;
  tracking_id: string | null;
  meeting_kind: string | null;
  notes: string | null;
  /** Shown on the card so the invitee knows what they are being pulled into. */
  company_name?: string;
}

/** Send one invite per person, all pointing at the organiser's entry. */
export async function inviteToEntry(
  entryId: string,
  organiserId: string,
  people: { id: string; billable: number }[],
  line: string,
  message?: string,
): Promise<string | null> {
  if (!people.length) return null;
  const { error } = await supabase.from("entry_invites").insert(
    people.map((p) => ({
      entry_id: entryId,
      organiser_id: organiserId,
      invitee_id: p.id,
      billable: p.billable,
      billing_line: line,
      message: message ?? null,
    })),
  );
  return error?.message ?? null;
}

/** Everything waiting for this person to answer, with the meeting details. */
export async function loadMyInvites(userId: string): Promise<InviteCard[]> {
  // Two plain queries instead of an embedded join: the join silently dropped
  // every invite whose entry belongs to someone else.
  const { data: inv } = await supabase
    .from("entry_invites").select("*")
    .eq("invitee_id", userId).eq("status", "pending");

  const rows = (inv ?? []) as any[];
  if (!rows.length) return [];

  const { data: ents } = await supabase
    .from("calendar_entries")
    .select("id, kind, title, date_key, entry_date, start_min, end_min, work_type_id, project_id, client_id, company_id, tracking_id, meeting_kind, notes")
    .in("id", rows.map((r) => r.entry_id));
  const byId: Record<string, any> = {};
  ((ents ?? []) as any[]).forEach((e) => { byId[e.id] = e; });

  const { data: profs } = await supabase
    .from("profiles").select("id, first_name, last_name, username, email")
    .in("id", Array.from(new Set(rows.map((r) => r.organiser_id))));
  const nameById: Record<string, string> = {};
  (profs ?? []).forEach((p: any) => {
    nameById[p.id] = [p.first_name, p.last_name].filter(Boolean).join(" ") || p.username || p.email || "A colleague";
  });

  const coIds = Array.from(new Set(Object.values(byId).map((e: any) => e.company_id).filter(Boolean)));
  const { data: cos } = coIds.length
    ? await supabase.from("companies").select("id, name").in("id", coIds)
    : { data: [] as any[] };
  const coName: Record<string, string> = {};
  (cos ?? []).forEach((c: any) => { coName[c.id] = c.name; });

  return rows.filter((r) => byId[r.entry_id]).map((r) => {
    const e = byId[r.entry_id];
    return {
      ...r,
      organiser_name: nameById[r.organiser_id] ?? "A colleague",
      kind: e.kind ?? "work",
      title: e.title,
      date_key: e.date_key,
      entry_date: e.entry_date,
      start_min: e.start_min,
      end_min: e.end_min,
      work_type_id: e.work_type_id,
      project_id: e.project_id,
      client_id: e.client_id,
      company_id: e.company_id,
      tracking_id: e.tracking_id,
      meeting_kind: e.meeting_kind,
      notes: e.notes,
      company_name: e.company_id ? coName[e.company_id] : undefined,
    };
  });
}

/** Who was invited to a given entry, for the organiser's own view. */
export async function loadEntryInvites(entryId: string): Promise<EntryInvite[]> {
  const { data } = await supabase.from("entry_invites").select("*").eq("entry_id", entryId);
  return (data ?? []) as EntryInvite[];
}

/**
 * Accepting turns the invite into a real entry on the invitee's calendar,
 * carrying the billable the organiser decided. The entry points back at the
 * invite, so declining later removes it cleanly.
 */
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export async function acceptInvite(
  inv: InviteCard,
  userId: string,
  /** The invitee's own choice of work type, so the time lands in the right
   *  bucket rather than inheriting whatever the organiser used. */
  workTypeId?: string | null,
): Promise<string | null> {
  // The accepted entry mirrors the organiser's: same kind, same deal, same
  // company, so it reads the same on both calendars.
  const { data: created, error } = await supabase.from("calendar_entries").insert({
    user_id: userId,
    kind: inv.kind ?? "work",
    title: inv.title,
    date_key: inv.date_key,
    entry_date: inv.entry_date,
    start_min: inv.start_min,
    end_min: inv.end_min,
    work_type_id: workTypeId ?? inv.work_type_id,
    project_id: inv.project_id,
    client_id: inv.client_id,
    company_id: inv.company_id,
    tracking_id: inv.tracking_id,
    meeting_kind: inv.meeting_kind,
    billable: inv.billable,
    billing_line: inv.billing_line,
    // Confirmed means the work happened; something still ahead is planned.
    status: inv.entry_date <= todayIso() ? "confirmed" : "planned",
    notes: inv.notes,
    invite_id: inv.id,
  }).select("id").single();
  if (error) return error.message;

  const { error: uErr } = await supabase.from("entry_invites")
    .update({ status: "accepted", responded_at: new Date().toISOString(), seen_by_organiser: false })
    .eq("id", inv.id);
  if (uErr) {
    // Roll the entry back rather than leave a booking with no invite behind it.
    await supabase.from("calendar_entries").delete().eq("id", created.id);
    return uErr.message;
  }
  return null;
}

export async function declineInvite(inviteId: string): Promise<string | null> {
  // Any entry created from a previous acceptance goes with it, and the reply
  // goes back to unseen so pulling out after saying yes reaches the organiser.
  await supabase.from("calendar_entries").delete().eq("invite_id", inviteId);
  const { error } = await supabase.from("entry_invites")
    .update({ status: "declined", responded_at: new Date().toISOString(), seen_by_organiser: false })
    .eq("id", inviteId);
  return error?.message ?? null;
}

/** The invite behind an entry, so an invitee can pull out from the calendar. */
export async function inviteOfEntry(entryId: string): Promise<string | null> {
  const { data } = await supabase.from("calendar_entries")
    .select("invite_id").eq("id", entryId).maybeSingle();
  return (data as any)?.invite_id ?? null;
}

/** The organiser withdrawing an invite they sent. */
export async function cancelInvite(inviteId: string): Promise<string | null> {
  const { error } = await supabase.from("entry_invites").delete().eq("id", inviteId);
  return error?.message ?? null;
}


/**
 * What the invitee already has booked while an invitation runs.
 *
 * Informative, never blocking: sometimes you accept anyway and move the other
 * thing, so the tray says what the clash is and leaves the choice alone.
 */
export interface Clash {
  id: string;
  title: string | null;
  start_min: number;
  end_min: number;
  kind: string;
}

export async function findClashes(
  userId: string,
  invites: { id: string; entry_date: string; start_min: number; end_min: number }[],
): Promise<Record<string, Clash[]>> {
  if (!invites.length) return {};
  const dates = Array.from(new Set(invites.map((i) => i.entry_date)));
  const { data } = await supabase
    .from("calendar_entries")
    .select("id, title, entry_date, start_min, end_min, kind, work_type_id")
    .eq("user_id", userId)
    .in("entry_date", dates)
    .neq("status", "cancelled");

  const mine = (data ?? []) as any[];
  const out: Record<string, Clash[]> = {};
  invites.forEach((inv) => {
    out[inv.id] = mine
      .filter((e) =>
        e.entry_date === inv.entry_date
        && e.start_min < inv.end_min && e.end_min > inv.start_min)
      .map((e) => ({
        id: e.id, title: e.title, start_min: e.start_min, end_min: e.end_min, kind: e.kind ?? "work",
      }));
  });
  return out;
}


/* ===========================================================================
   Replies to what you organised
   ---------------------------------------------------------------------------
   The organiser needs to know who turned them down, so answered invites come
   back through the same bell rather than a second notification system.
   =========================================================================== */

export interface InviteReply {
  id: string;
  invitee_name: string;
  status: "accepted" | "declined";
  responded_at: string;
  entry_title: string | null;
  entry_date: string;
  start_min: number;
  seen: boolean;
}

/** Answers on events this person organised, newest first. */
export async function loadMyReplies(userId: string): Promise<InviteReply[]> {
  const { data } = await supabase
    .from("entry_invites")
    .select("id, invitee_id, status, responded_at, seen_by_organiser, entry_id")
    .eq("organiser_id", userId)
    .neq("status", "pending")
    .order("responded_at", { ascending: false })
    .limit(20);

  const rows = (data ?? []) as any[];
  if (!rows.length) return [];

  const [{ data: profs }, { data: ents }] = await Promise.all([
    supabase.from("profiles").select("id, first_name, last_name, username, email")
      .in("id", Array.from(new Set(rows.map((r) => r.invitee_id)))),
    supabase.from("calendar_entries").select("id, title, entry_date, start_min")
      .in("id", Array.from(new Set(rows.map((r) => r.entry_id)))),
  ]);

  const nameById: Record<string, string> = {};
  (profs ?? []).forEach((p: any) => {
    nameById[p.id] = [p.first_name, p.last_name].filter(Boolean).join(" ") || p.username || p.email || "A colleague";
  });
  const entById: Record<string, any> = {};
  (ents ?? []).forEach((e: any) => { entById[e.id] = e; });

  return rows.filter((r) => entById[r.entry_id]).map((r) => ({
    id: r.id,
    invitee_name: nameById[r.invitee_id] ?? "A colleague",
    status: r.status,
    responded_at: r.responded_at,
    entry_title: entById[r.entry_id].title,
    entry_date: entById[r.entry_id].entry_date,
    start_min: entById[r.entry_id].start_min,
    seen: r.seen_by_organiser === true,
  }));
}

export async function markRepliesSeen(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await supabase.from("entry_invites").update({ seen_by_organiser: true }).in("id", ids);
}

/** Who is on an event and where each of them stands. */
export interface Attendee {
  invitee_id: string;
  name: string;
  status: "pending" | "accepted" | "declined";
}

/**
 * Who is on each entry, keyed by entry id.
 *
 * Works from either end: the organiser's entry is found by its own id, and an
 * invitee's accepted entry by the invite it came from, so a shared booking
 * looks shared on everyone's calendar rather than only the organiser's.
 */
export async function loadAttendees(
  entries: { id: string; inviteId?: string | null }[],
): Promise<Record<string, Attendee[]>> {
  if (!entries.length) return {};
  const ownIds = entries.map((e) => e.id);
  const fromInvites = entries.map((e) => e.inviteId).filter(Boolean) as string[];

  // An invitee's entry points at the invite, which points at the original.
  let originOf: Record<string, string> = {};
  if (fromInvites.length) {
    const { data: inv } = await supabase.from("entry_invites")
      .select("id, entry_id").in("id", fromInvites);
    ((inv ?? []) as any[]).forEach((i) => { originOf[i.id] = i.entry_id; });
  }
  const lookIn = Array.from(new Set([...ownIds, ...Object.values(originOf)]));

  const { data } = await supabase.from("entry_invites")
    .select("entry_id, organiser_id, invitee_id, status").in("entry_id", lookIn);
  const rows = (data ?? []) as any[];
  if (!rows.length) return {};

  const { data: profs } = await supabase.from("profiles")
    .select("id, first_name, last_name, username, email")
    .in("id", Array.from(new Set([
      ...rows.map((r) => r.invitee_id),
      ...rows.map((r) => r.organiser_id),
    ].filter(Boolean))));
  const nameById: Record<string, string> = {};
  (profs ?? []).forEach((p: any) => {
    nameById[p.id] = [p.first_name, p.last_name].filter(Boolean).join(" ") || p.username || p.email || "?";
  });

  const byOrigin: Record<string, Attendee[]> = {};
  const organiserOf: Record<string, string> = {};
  rows.forEach((r) => {
    organiserOf[r.entry_id] = r.organiser_id;
    (byOrigin[r.entry_id] ??= []).push({
      invitee_id: r.invitee_id,
      name: nameById[r.invitee_id] ?? "?",
      status: r.status,
    });
  });

  // Map it back onto the entries that were asked about.
  const out: Record<string, Attendee[]> = {};
  entries.forEach((e) => {
    const origin = e.inviteId ? originOf[e.inviteId] : e.id;
    const who = origin ? byOrigin[origin] : undefined;
    if (!who?.length) return;
    // The organiser is part of the group too, and is always there.
    const org = organiserOf[origin!];
    out[e.id] = org
      ? [{ invitee_id: org, name: nameById[org] ?? "?", status: "accepted" as const }, ...who]
      : who;
  });
  return out;
}


/**
 * Who is free at a given time, for the organiser to see before summoning.
 *
 * Just busy or not: what the other person has on is their business, so the
 * picker says "busy" and nothing more.
 */
export async function busyAt(
  userIds: string[],
  entryDate: string,
  startMin: number,
  endMin: number,
  ignoreEntryId?: string,
): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const { data } = await supabase
    .from("calendar_entries")
    .select("id, user_id, start_min, end_min")
    .in("user_id", userIds)
    .eq("entry_date", entryDate)
    .neq("status", "cancelled");

  const busy = new Set<string>();
  ((data ?? []) as any[]).forEach((e) => {
    if (ignoreEntryId && e.id === ignoreEntryId) return;
    if (e.start_min < endMin && e.end_min > startMin) busy.add(e.user_id);
  });
  return busy;
}


/**
 * Bring an entry's invitations in line with who is on it now.
 *
 * Someone dropped loses their invitation, and the entry it put on their
 * calendar if they had accepted. Someone added gets a fresh one. Whoever stays
 * is left alone, so nobody is asked twice about the same booking.
 */
export async function syncInvites(
  entryId: string,
  organiserId: string,
  people: { id: string; billable: number }[],
  line: string,
  message?: string,
): Promise<string | null> {
  const { data } = await supabase.from("entry_invites")
    .select("id, invitee_id, status").eq("entry_id", entryId);
  const existing = (data ?? []) as any[];
  const wanted = people.map((p) => p.id);

  for (const gone of existing.filter((i) => !wanted.includes(i.invitee_id))) {
    await supabase.from("calendar_entries").delete().eq("invite_id", gone.id);
    await supabase.from("entry_invites").delete().eq("id", gone.id);
  }

  // Someone who turned it down still has a row, so asking again means
  // reviving theirs rather than inserting a second one that would clash.
  const again = existing.filter((i) => i.status === "declined" && people.some((p) => p.id === i.invitee_id));
  for (const a of again) {
    const { error } = await supabase.from("entry_invites")
      .update({
        status: "pending", responded_at: null, seen_by_organiser: true,
        billable: people.find((p) => p.id === a.invitee_id)?.billable ?? 0,
        billing_line: line, message: message ?? null,
      })
      .eq("id", a.id);
    if (error) return error.message;
  }

  const known = existing.map((i) => i.invitee_id);
  const added = people.filter((p) => !known.includes(p.id));
  if (added.length) {
    const { error } = await supabase.from("entry_invites").insert(
      added.map((p) => ({
        entry_id: entryId, organiser_id: organiserId, invitee_id: p.id,
        billable: p.billable, billing_line: line, message: message ?? null,
      })),
    );
    if (error) return error.message;
  }
  return null;
}