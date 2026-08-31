/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

/**
 * The sales calendar.
 *
 * A rep does not log billable work against projects: what fills their week are
 * the meetings booked on their deals. Everything that takes up time lives in
 * calendar_entries — delivery work, own work, meetings — so invitations,
 * reminders and anything the calendar grows later are built once rather than
 * once per table. A meeting created here shows up on the deal, and one booked
 * from the deal shows up here.
 */
export type MeetingKind = "teams" | "phone" | "in_person";

export interface SalesMeeting {
  id: string;
  tracking_id: string | null;
  phase_id: string | null;
  company_id: string | null;
  title: string;
  meet_at: string;
  duration_min: number;
  kind: MeetingKind;
  assignee_id: string | null;
  notes: string | null;
  /** Filled in from the deal, for showing without a second lookup. */
  company_name: string;
  pipeline_name: string;
  status: string;
}

/** Meetings for these people, within a date range. */
export async function loadSalesMeetings(
  userIds: string[],
  fromIso: string,
  toIso: string,
): Promise<SalesMeeting[]> {
  if (!userIds.length) return [];
  const { data } = await supabase
    .from("calendar_entries")
    .select("id, tracking_id, phase_id_ref, company_id, title, entry_date, date_key, start_min, end_min, meeting_kind, notes, user_id")
    .in("user_id", userIds)
    .eq("kind", "meeting")
    .gte("entry_date", fromIso)
    .lte("entry_date", toIso)
    .order("start_min");

  // Everything on a calendar is an entry now, so a meeting is one too: same
  // table, same invitations, same everything the calendar grows later.
  const rows = ((data ?? []) as any[]).map((r) => ({
    ...r,
    phase_id: r.phase_id_ref,
    assignee_id: r.user_id,
    kind: r.meeting_kind ?? "in_person",
    meet_at: `${r.entry_date}T${String(Math.floor(r.start_min / 60)).padStart(2, "0")}:${String(r.start_min % 60).padStart(2, "0")}:00`,
    duration_min: Math.max(15, r.end_min - r.start_min),
  }));
  if (!rows.length) return [];

  // The deal gives the company and the pipeline, which is what you actually
  // want to read on a calendar block.
  const trackIds = Array.from(new Set(rows.map((r) => r.tracking_id).filter(Boolean)));
  // Meetings with no deal carry their own company.
  const looseCos = rows.map((r) => r.company_id).filter(Boolean);
  const { data: trks } = await supabase
    .from("trackings").select("id, company_id, pipeline_id, status").in("id", trackIds);
  const companyIds = Array.from(new Set([...((trks ?? []).map((t: any) => t.company_id)), ...looseCos].filter(Boolean)));
  const pipeIds = Array.from(new Set((trks ?? []).map((t: any) => t.pipeline_id).filter(Boolean)));

  const { data: cos } = companyIds.length
    ? await supabase.from("companies").select("id, name").in("id", companyIds)
    : { data: [] as any[] };
  const { data: pipes } = pipeIds.length
    ? await supabase.from("pipelines").select("id, name").in("id", pipeIds)
    : { data: [] as any[] };

  const coName: Record<string, string> = {};
  (cos ?? []).forEach((c: any) => { coName[c.id] = c.name; });
  const pipeName: Record<string, string> = {};
  (pipes ?? []).forEach((p: any) => { pipeName[p.id] = p.name; });
  const byTrack: Record<string, any> = {};
  (trks ?? []).forEach((t: any) => { byTrack[t.id] = t; });

  return rows.map((r) => {
    const t = byTrack[r.tracking_id];
    return {
      ...r,
      duration_min: Number(r.duration_min) || 60,
      kind: (r.kind ?? "in_person") as MeetingKind,
      company_name: r.company_id
        ? (coName[r.company_id] ?? "Unknown company")
        : t?.company_id ? (coName[t.company_id] ?? "Unknown company") : "Meeting",
      pipeline_name: t?.pipeline_id ? (pipeName[t.pipeline_id] ?? "") : "",
      status: t?.status ?? "active",
    };
  });
}

/** Open deals a rep can book a meeting on, newest first. */
export async function loadMyDeals(userIds: string[]): Promise<
  { id: string; label: string; company_id: string | null; phase_id: string | null }[]
> {
  if (!userIds.length) return [];
  const { data: links } = await supabase
    .from("tracking_employees").select("tracking_id").in("profile_id", userIds);
  const ids = Array.from(new Set((links ?? []).map((l: any) => l.tracking_id)));

  // Someone with no deals assigned still needs to see the company's open ones.
  const q = supabase.from("trackings")
    .select("id, company_id, current_phase_id, status")
    .neq("status", "lost")
    .order("created_at", { ascending: false });
  const { data: trks } = ids.length ? await q.in("id", ids) : await q.limit(60);

  const rows = (trks ?? []) as any[];
  const companyIds = Array.from(new Set(rows.map((r) => r.company_id).filter(Boolean)));
  const { data: cos } = companyIds.length
    ? await supabase.from("companies").select("id, name").in("id", companyIds)
    : { data: [] as any[] };
  const coName: Record<string, string> = {};
  (cos ?? []).forEach((c: any) => { coName[c.id] = c.name; });

  // Deals on a loose contact have no company, so they take the contact's name
  // instead of all showing up as "No company".
  const noCo = rows.filter((r) => !r.company_id).map((r) => r.id);
  const byTrack: Record<string, string> = {};
  if (noCo.length) {
    const { data: tc } = await supabase.from("tracking_contacts")
      .select("tracking_id, contact_id").in("tracking_id", noCo);
    const ctIds = Array.from(new Set((tc ?? []).map((x: any) => x.contact_id)));
    const { data: cts } = ctIds.length
      ? await supabase.from("contacts").select("id, first_name, last_name").in("id", ctIds)
      : { data: [] as any[] };
    const ctName: Record<string, string> = {};
    (cts ?? []).forEach((c: any) => {
      ctName[c.id] = [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact";
    });
    (tc ?? []).forEach((x: any) => {
      if (!byTrack[x.tracking_id]) byTrack[x.tracking_id] = ctName[x.contact_id] ?? "Contact";
    });
  }

  return rows.map((r) => ({
    id: r.id,
    label: r.company_id
      ? (coName[r.company_id] ?? "Unknown company")
      : (byTrack[r.id] ?? "Deal with no company"),
    company_id: r.company_id,
    phase_id: r.current_phase_id,
  }));
}

/**
 * A meeting does not need a deal. When the company has open ones the rep picks
 * which it belongs to and it shows up on that deal too; when it does not, the
 * meeting simply stands on its own with its company and attendees.
 */
export async function createSalesMeeting(input: {
  tracking_id: string | null;
  phase_id: string | null;
  company_id: string | null;
  title: string;
  meet_at: string;
  duration_min: number;
  kind: MeetingKind;
  assignee_id: string;
  contact_ids?: string[];
}): Promise<{ id: string | null; error: string | null }> {
  const { contact_ids, meet_at, duration_min, phase_id, assignee_id, kind, ...rest } = input;
  const at = new Date(meet_at);
  const startMin = at.getHours() * 60 + at.getMinutes();
  const { data, error } = await supabase.from("calendar_entries").insert({
    ...rest,
    user_id: assignee_id,
    kind: "meeting",
    meeting_kind: kind,
    phase_id_ref: phase_id,
    date_key: `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`,
    entry_date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`,
    start_min: startMin,
    end_min: startMin + duration_min,
    billable: 0,
    billing_line: "sales",
    status: "confirmed",
  }).select("id").single();
  if (error) return { id: null, error: error.message };

  if (contact_ids?.length) {
    const { error: cErr } = await supabase.from("meeting_contacts")
      .insert(contact_ids.map((c) => ({ meeting_id: data.id, contact_id: c })));
    if (cErr) return { id: data.id, error: cErr.message };
  }
  return { id: data.id, error: null };
}

/** Open deals for a company, so the rep can say which one a meeting belongs to. */
export async function dealsForCompany(companyId: string): Promise<
  { id: string; label: string; phase_id: string | null }[]
> {
  const { data } = await supabase.from("trackings")
    .select("id, current_phase_id, created_at, pipeline_id, status")
    .eq("company_id", companyId)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as any[];
  if (!rows.length) return [];
  const pipeIds = Array.from(new Set(rows.map((r) => r.pipeline_id).filter(Boolean)));
  const { data: pipes } = pipeIds.length
    ? await supabase.from("pipelines").select("id, name").in("id", pipeIds)
    : { data: [] as any[] };
  const pipeName: Record<string, string> = {};
  (pipes ?? []).forEach((p: any) => { pipeName[p.id] = p.name; });

  return rows.map((r) => ({
    id: r.id,
    label: pipeName[r.pipeline_id] ?? "Deal",
    phase_id: r.current_phase_id,
  }));
}

/** Contacts attached to a company, for picking who is coming. */
export async function contactsOfCompany(companyId: string): Promise<{ id: string; label: string }[]> {
  const { data: links } = await supabase.from("company_contacts")
    .select("contact_id").eq("company_id", companyId);
  const ids = (links ?? []).map((l: any) => l.contact_id);
  if (!ids.length) return [];
  const { data } = await supabase.from("contacts")
    .select("id, first_name, last_name, position").in("id", ids);
  return (data ?? []).map((c: any) => ({
    id: c.id,
    label: [[c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact", c.position]
      .filter(Boolean).join(" · "),
  })).sort((a, b) => a.label.localeCompare(b.label));
}

export async function updateSalesMeeting(
  id: string,
  patch: { title?: string; meet_at?: string; duration_min?: number; kind?: MeetingKind },
): Promise<string | null> {
  const row: Record<string, unknown> = {};
  if (patch.title != null) row.title = patch.title;
  if (patch.kind != null) row.meeting_kind = patch.kind;
  if (patch.meet_at) {
    const at = new Date(patch.meet_at);
    const startMin = at.getHours() * 60 + at.getMinutes();
    row.date_key = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
    row.entry_date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    row.start_min = startMin;
    // Keep the length unless a new one comes with it.
    const { data: cur } = await supabase.from("calendar_entries")
      .select("start_min, end_min").eq("id", id).maybeSingle();
    const span = patch.duration_min ?? (cur ? (cur as any).end_min - (cur as any).start_min : 60);
    row.end_min = startMin + span;
  }
  const { error } = await supabase.from("calendar_entries").update(row).eq("id", id);
  return error?.message ?? null;
}

export async function deleteSalesMeeting(id: string): Promise<string | null> {
  const { error } = await supabase.from("calendar_entries").delete().eq("id", id);
  return error?.message ?? null;
}


/* ===========================================================================
   Work blocks
   ---------------------------------------------------------------------------
   Not every hour of a rep's week is a meeting: prep, admin, prospecting. Those
   go into calendar_entries like any other logged work, on their own billing
   line so the delivery panels never count them, and they can optionally point
   at one of the rep's own companies or contacts.
   =========================================================================== */

export interface SalesBlock {
  id: string;
  user_id: string;
  title: string;
  /** Set when this came from someone else's invitation. */
  invite_id?: string | null;
  date_key: string;
  entry_date: string;
  start_min: number;
  end_min: number;
  notes: string | null;
  company_id: string | null;
  contact_id: string | null;
  company_name?: string;
  contact_name?: string;
}

export async function loadSalesBlocks(
  userIds: string | string[],
  fromIso: string,
  toIso: string,
): Promise<SalesBlock[]> {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (!ids.length) return [];
  const { data } = await supabase
    .from("calendar_entries")
    .select("id, user_id, title, date_key, entry_date, start_min, end_min, notes, company_id, contact_id, invite_id, kind")
    .in("user_id", ids)
    // Everything that is not a meeting: own work, accepted invitations and
    // delivery time, so a consultant's week shows up as busy too.
    .neq("kind", "meeting")
    .gte("entry_date", fromIso)
    .lte("entry_date", toIso)
    .order("start_min");

  const rows = (data ?? []) as any[];
  if (!rows.length) return [];

  const coIds = Array.from(new Set(rows.map((r) => r.company_id).filter(Boolean)));
  const ctIds = Array.from(new Set(rows.map((r) => r.contact_id).filter(Boolean)));
  const { data: cos } = coIds.length
    ? await supabase.from("companies").select("id, name").in("id", coIds)
    : { data: [] as any[] };
  const { data: cts } = ctIds.length
    ? await supabase.from("contacts").select("id, first_name, last_name").in("id", ctIds)
    : { data: [] as any[] };

  const coName: Record<string, string> = {};
  (cos ?? []).forEach((c: any) => { coName[c.id] = c.name; });
  const ctName: Record<string, string> = {};
  (cts ?? []).forEach((c: any) => {
    ctName[c.id] = [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact";
  });

  return rows.map((r) => ({
    ...r,
    company_name: r.company_id ? coName[r.company_id] : undefined,
    contact_name: r.contact_id ? ctName[r.contact_id] : undefined,
  }));
}

export async function createSalesBlock(input: {
  user_id: string;
  title: string;
  date_key: string;
  entry_date: string;
  start_min: number;
  end_min: number;
  notes: string | null;
  company_id: string | null;
  contact_id: string | null;
}): Promise<string | null> {
  const { error } = await supabase.from("calendar_entries").insert({
    ...input,
    kind: "work",
    billing_line: "sales",
    billable: 0,
    status: "confirmed",
  }).select("id").single();
  return { id: data?.id ?? null, error: error?.message ?? null };
}

export async function updateSalesBlock(
  id: string,
  patch: { start_min?: number; end_min?: number; date_key?: string; entry_date?: string },
): Promise<string | null> {
  const { error } = await supabase.from("calendar_entries").update(patch).eq("id", id);
  return error?.message ?? null;
}

export async function deleteSalesBlock(id: string): Promise<string | null> {
  const { error } = await supabase.from("calendar_entries").delete().eq("id", id);
  return error?.message ?? null;
}

/** The companies and contacts this rep is allowed to attach. */
export async function loadMyLinks(userId: string): Promise<{
  companies: { id: string; label: string }[];
  contacts: { id: string; label: string }[];
}> {
  const [{ data: cAss }, { data: kAss }] = await Promise.all([
    supabase.from("company_assignees").select("company_id").eq("profile_id", userId),
    supabase.from("contact_assignees").select("contact_id").eq("profile_id", userId),
  ]);
  const coIds = (cAss ?? []).map((r: any) => r.company_id);
  const ctIds = (kAss ?? []).map((r: any) => r.contact_id);

  const { data: cos } = coIds.length
    ? await supabase.from("companies").select("id, name").in("id", coIds).order("name")
    : { data: [] as any[] };
  const { data: cts } = ctIds.length
    ? await supabase.from("contacts").select("id, first_name, last_name").in("id", ctIds)
    : { data: [] as any[] };

  return {
    companies: (cos ?? []).map((c: any) => ({ id: c.id, label: c.name })),
    contacts: (cts ?? []).map((c: any) => ({
      id: c.id,
      label: [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact",
    })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}


/* ===========================================================================
   Editing an event
   ---------------------------------------------------------------------------
   Everything can change, including who is on it. Attendees are a plain swap.
   Summoned colleagues are not: someone who already accepted has an entry on
   their own calendar, so dropping them has to take that with it, and adding
   someone means a fresh invitation they can still decline.
   =========================================================================== */

export interface MeetingDetail {
  id: string;
  tracking_id: string | null;
  phase_id: string | null;
  company_id: string | null;
  title: string;
  entry_date: string;
  start_min: number;
  end_min: number;
  meeting_kind: MeetingKind;
  notes: string | null;
  contact_ids: string[];
  summoned_ids: string[];
}

/** Everything needed to reopen a meeting in the editor. */
export async function loadMeetingDetail(id: string): Promise<MeetingDetail | null> {
  const { data: e } = await supabase.from("calendar_entries")
    .select("id, tracking_id, phase_id_ref, company_id, title, entry_date, start_min, end_min, meeting_kind, notes")
    .eq("id", id).maybeSingle();
  if (!e) return null;

  const [{ data: cts }, { data: inv }] = await Promise.all([
    supabase.from("meeting_contacts").select("contact_id").eq("meeting_id", id),
    supabase.from("entry_invites").select("invitee_id").eq("entry_id", id).neq("status", "declined"),
  ]);

  const row = e as any;
  return {
    id: row.id,
    tracking_id: row.tracking_id,
    phase_id: row.phase_id_ref,
    company_id: row.company_id,
    title: row.title ?? "",
    entry_date: row.entry_date,
    start_min: row.start_min,
    end_min: row.end_min,
    meeting_kind: (row.meeting_kind ?? "in_person") as MeetingKind,
    notes: row.notes,
    contact_ids: ((cts ?? []) as any[]).map((c) => c.contact_id),
    summoned_ids: ((inv ?? []) as any[]).map((i) => i.invitee_id),
  };
}

export async function saveMeetingEdit(input: {
  id: string;
  organiser_id: string;
  tracking_id: string | null;
  phase_id: string | null;
  company_id: string | null;
  title: string;
  entry_date: string;
  date_key: string;
  start_min: number;
  end_min: number;
  meeting_kind: MeetingKind;
  notes: string | null;
  contact_ids: string[];
  summoned_ids: string[];
}): Promise<string | null> {
  const { id, organiser_id, contact_ids, summoned_ids, phase_id, meeting_kind, ...row } = input;

  const { error } = await supabase.from("calendar_entries")
    .update({ ...row, phase_id_ref: phase_id, meeting_kind }).eq("id", id);
  if (error) return error.message;

  // Attendees: swap the lot, they carry no state of their own.
  await supabase.from("meeting_contacts").delete().eq("meeting_id", id);
  if (contact_ids.length) {
    const { error: cErr } = await supabase.from("meeting_contacts")
      .insert(contact_ids.map((c) => ({ meeting_id: id, contact_id: c })));
    if (cErr) return cErr.message;
  }

  // Invitations: only the difference, so nobody is re-invited to something
  // they already said yes to.
  const { data: cur } = await supabase.from("entry_invites")
    .select("id, invitee_id, status").eq("entry_id", id);
  const existing = (cur ?? []) as any[];

  const dropped = existing.filter((i) => !summoned_ids.includes(i.invitee_id));
  for (const d of dropped) {
    // An accepted invite left an entry on their calendar; it goes with it.
    await supabase.from("calendar_entries").delete().eq("invite_id", d.id);
    await supabase.from("entry_invites").delete().eq("id", d.id);
  }

  // Someone who turned it down still has a row, so asking them again means
  // reviving theirs rather than inserting a second one that would clash.
  const again = existing.filter((i) => i.status === "declined" && summoned_ids.includes(i.invitee_id));
  for (const a of again) {
    const { error: rErr } = await supabase.from("entry_invites")
      .update({ status: "pending", responded_at: null, seen_by_organiser: true })
      .eq("id", a.id);
    if (rErr) return rErr.message;
  }

  const known = existing.map((i) => i.invitee_id);
  const added = summoned_ids.filter((s) => !known.includes(s));
  if (added.length) {
    const { error: iErr } = await supabase.from("entry_invites").insert(
      added.map((s) => ({ entry_id: id, organiser_id, invitee_id: s, billable: 0, billing_line: "sales" })),
    );
    if (iErr) return iErr.message;
  }

  // Whoever stays and had already accepted keeps their entry, but the times
  // may have moved, so it follows the organiser's.
  const kept = existing.filter((i) => i.status === "accepted" && summoned_ids.includes(i.invitee_id));
  for (const k of kept) {
    await supabase.from("calendar_entries")
      .update({ entry_date: row.entry_date, date_key: row.date_key, start_min: row.start_min, end_min: row.end_min, title: row.title })
      .eq("invite_id", k.id);
  }
  return null;
}