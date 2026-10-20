// Frontend helper for one-way Outlook sync. Lives in src/api/ alongside supabase.ts.
import { supabase } from "./supabase";

const CLIENT_ID = import.meta.env.VITE_MS_CLIENT_ID as string;
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const SCOPES = "Calendars.ReadWrite offline_access User.Read";
const REDIRECT_URI = `${window.location.origin}/settings`; // must match Azure redirect URIs

// --- PKCE helpers (required for SPA registrations) ---
function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomVerifier(): string {
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  return base64url(arr);
}
async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Call the outlook-sync Edge Function with the user's session token.
 *  Always resolves to an object; on an HTTP error it carries `error` and `httpStatus`. */
async function call(action: string, payload: object = {}): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/outlook-sync`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      },
      body: JSON.stringify({ action, ...payload }),
    },
  );
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    body = body && typeof body === "object" ? body : {};
    body.httpStatus = res.status;
    if (!body.error) body.error = body.message || body.msg || `HTTP ${res.status}`;
  }
  return body;
}

/* ─────────────── connecting ───────────────
   Microsoft's sign-in opens in a small POPUP window. When Microsoft sends that
   popup back to /settings?code=…&state=…, the popup hands the code to this
   window and closes itself. This window never reloads, so you stay signed in and
   the code is used within a second (Microsoft codes expire quickly).

   Why not a full-page redirect: on the way back, Supabase also reads "?code=" from
   the URL (it uses the same name for its own sign-ins), fails with Microsoft's code
   and signs you out — the code then expires while you log in again
   (AADSTS70008). A full-page redirect is only used if the browser blocks popups,
   and even then the code is taken out of the URL before Supabase sees it. */
const PENDING_KEY = "ms_oauth_pending";
const ERROR_KEY = "ms_oauth_error";
const RETURN_KEY = "ms_oauth_return";       // popup → main window (storage event fallback)
const CHANNEL = "next-ms-outlook";
const POPUP_PREFIX = "popup.";              // state of popup sign-ins starts with this
/** Fired on window when a connection attempt finishes: detail = { connected, error? }. */
export const OUTLOOK_CONNECTION_EVENT = "next:outlook-connection";
const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
const OAUTH_PARAMS = ["code", "state", "session_state", "error", "error_description", "error_uri", "client_info", "iss"];

/* Runs the moment the app loads (in the popup, or in this window after a redirect). */
(function captureMicrosoftReturn() {
  try {
    const url = new URL(window.location.href);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    if (!state || (!code && !err)) return;
    const isPopupReturn = state.startsWith(POPUP_PREFIX);
    const expected = ss.get("ms_oauth_state");
    if (!isPopupReturn && (!expected || state !== expected)) return; // not ours (e.g. a Supabase sign-in)
    const error = err ? url.searchParams.get("error_description") || err : null;
    // Take it out of the URL before Supabase or any route sees it.
    OAUTH_PARAMS.forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    if (isPopupReturn) {
      // We are the popup: give the code to the main window and close.
      const msg = { type: "ms-outlook-return", code, state, error, at: Date.now() };
      try { const bc = new BroadcastChannel(CHANNEL); bc.postMessage(msg); bc.close(); } catch { /* old browser */ }
      try { window.opener?.postMessage(msg, window.location.origin); } catch { /* opener gone */ }
      try { localStorage.setItem(RETURN_KEY, JSON.stringify(msg)); } catch { /* ignore */ }
      try { document.title = "Outlook connected"; } catch { /* ignore */ }
      setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 150);
      return;
    }
    // Same-window return (popup was blocked): keep the code for this tab.
    if (code) ss.set(PENDING_KEY, JSON.stringify({ code, verifier: ss.get("ms_pkce_verifier") ?? "" }));
    else if (error) ss.set(ERROR_KEY, error);
    ss.del("ms_oauth_state");
  } catch { /* never break start-up */ }
})();

/** Why the last connection attempt failed (null if it didn't). */
export const outlookConnectError = (): string | null => ss.get(ERROR_KEY);

/**
 * Connect Outlook: opens Microsoft's sign-in in a popup and finishes the
 * connection here. Resolves when it's done (true = connected). Falls back to a
 * full-page redirect if the browser blocks the popup.
 */
export async function connectOutlook(): Promise<boolean> {
  ss.del(ERROR_KEY);
  ss.del(PENDING_KEY);
  // A leftover "<…>-code-verifier" from an earlier Supabase sign-in is what makes
  // Supabase grab Microsoft's code. You're signed in already, so it can go.
  try { Object.keys(localStorage).filter((k) => k.endsWith("-code-verifier")).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  try { localStorage.removeItem(RETURN_KEY); } catch { /* ignore */ }

  const verifier = randomVerifier();
  const challenge = await challengeOf(verifier);
  const authUrl = (state: string) => `${AUTH_URL}?${new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    response_mode: "query",
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  })}`;

  const state = POPUP_PREFIX + crypto.randomUUID();
  const w = 520, h = 680;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
  const popup = window.open(authUrl(state), "ms-outlook-connect", `popup=yes,width=${w},height=${h},left=${left},top=${top}`);

  if (!popup) {
    // Popups blocked: full-page redirect (the code is still taken out of the URL on the way back).
    const plain = crypto.randomUUID();
    ss.set("ms_oauth_state", plain);
    ss.set("ms_pkce_verifier", verifier);
    window.location.href = authUrl(plain);
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let done = false;
    let bc: BroadcastChannel | null = null;
    const finish = async (msg: any) => {
      if (done || !msg || msg.type !== "ms-outlook-return" || msg.state !== state) return;
      done = true; cleanup();
      try { popup.close(); } catch { /* ignore */ }
      if (msg.error || !msg.code) {
        const error = String(msg.error || "Microsoft didn't return a code.");
        ss.set(ERROR_KEY, error);
        window.dispatchEvent(new CustomEvent(OUTLOOK_CONNECTION_EVENT, { detail: { connected: false, error } }));
        resolve(false); return;
      }
      ss.set(PENDING_KEY, JSON.stringify({ code: msg.code, verifier }));
      resolve(await completeOutlookConnect());
    };
    const onMessage = (e: MessageEvent) => { if (e.origin === window.location.origin) void finish(e.data); };
    const onStorage = (e: StorageEvent) => { if (e.key === RETURN_KEY && e.newValue) { try { void finish(JSON.parse(e.newValue)); } catch { /* ignore */ } } };
    try { bc = new BroadcastChannel(CHANNEL); bc.onmessage = (e) => void finish(e.data); } catch { bc = null; }
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    // The user closed the popup without finishing.
    const poll = window.setInterval(() => {
      let closed = false;
      try { closed = popup.closed; } catch { closed = false; }
      if (closed && !done) {
        window.setTimeout(() => {
          if (done) return;
          try { const raw = localStorage.getItem(RETURN_KEY); if (raw) { void finish(JSON.parse(raw)); return; } } catch { /* ignore */ }
          done = true; cleanup(); resolve(false);
        }, 800);
        window.clearInterval(poll);
      }
    }, 500);
    function cleanup() {
      window.clearInterval(poll);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
      try { bc?.close(); } catch { /* ignore */ }
      try { localStorage.removeItem(RETURN_KEY); } catch { /* ignore */ }
    }
  });
}

/**
 * Finish connecting after coming back from Microsoft. Safe to call any time
 * (Settings calls it on load; it also runs by itself once you're signed in).
 * Returns true if a connection was completed now.
 */
let inflight: Promise<boolean> | null = null;
export async function completeOutlookConnect(): Promise<boolean> {
  if (inflight) return inflight;
  const raw = ss.get(PENDING_KEY);
  if (!raw) return false;
  inflight = (async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return false; // keep it until you've signed in
    let pending: { code: string; verifier: string };
    try { pending = JSON.parse(raw); } catch { ss.del(PENDING_KEY); return false; }
    ss.del(PENDING_KEY); // a Microsoft code works only once
    let r: any;
    try { r = await call("connect", { code: pending.code, redirectUri: REDIRECT_URI, codeVerifier: pending.verifier }); }
    catch (e) { r = { error: (e as Error)?.message ?? String(e) }; }
    ss.del("ms_pkce_verifier");
    const connected = !!r?.connected;
    let error = connected ? null : String(r?.error?.message ?? r?.error_description ?? r?.error ?? "Microsoft didn't accept the connection.");
    if (error && /AADSTS70008|AADSTS54005|expired|already redeemed/i.test(error)) {
      error = "Microsoft's sign-in code expired before it could be used. Click Connect Outlook again — it now finishes straight away.";
    }
    if (connected) ss.del(ERROR_KEY); else { ss.set(ERROR_KEY, error!); console.warn("[outlook] connect failed:", r); }
    window.dispatchEvent(new CustomEvent(OUTLOOK_CONNECTION_EVENT, { detail: { connected, error } }));
    return connected;
  })().finally(() => { inflight = null; });
  return inflight;
}
// If you had to sign in again on the way back, finish as soon as you are.
supabase.auth.onAuthStateChange?.((_event: string, session: unknown) => {
  if (session && ss.get(PENDING_KEY)) setTimeout(() => { void completeOutlookConnect(); }, 0);
});

export async function outlookStatus(): Promise<boolean> {
  const r = await call("status");
  return !!r.connected;
}
export async function disconnectOutlook(): Promise<void> {
  await call("disconnect");
}

export interface OutlookEntryPayload {
  outlookEventId?: string | null;
  date: string;         // 'YYYY-MM-DD'
  startMin: number;
  endMin: number;
  workType?: string;
  client?: string;
  project?: string;
  phase?: string;
  tasks?: string;
  notes?: string;
  timeZone?: string;
  /* A meeting booked on a Sales deal (kind "meeting"): */
  kind?: "meeting";
  deal?: string;
  meetingType?: string;
  /** "Description of work": what was written on the meeting. */
  description?: string;
  /** People to invite (Outlook emails them the invitation). */
  attendees?: { email: string; name?: string }[];
  /** Ask Outlook for a Teams link. */
  online?: boolean;
  location?: string;
  /** Event title. Older callers leave it out and the function builds one. */
  subject?: string;
  /** Rows of the details table in the event body, in order. */
  details?: [string, string][];
  /** A meeting deleted in Outlook gets a new event instead of being reported gone. */
  recreate?: boolean;
}

export interface OutlookSyncResult {
  ok: boolean;
  /** Event id to store (the existing one if nothing changed). */
  eventId: string | null;
  /** Outlook isn't connected for this user. */
  skipped?: boolean;
  /** What went wrong, in words, when ok is false. */
  error?: string;
  /** Meetings: how many people got an invitation. */
  invited?: number;
  /** Meetings: Teams link (if one was created). */
  joinUrl?: string | null;
  /** Meetings: a Teams link was asked for but this account can't create one. */
  teamsSkipped?: boolean;
  /** Meetings: the event was deleted (or cancelled) in Outlook. */
  gone?: boolean;
}
const errText = (e: unknown) =>
  typeof e === "string" ? e : (e as any)?.message ?? (e as any)?.error?.message ?? (e ? JSON.stringify(e).slice(0, 300) : "Unknown error");

/** Create or update the Outlook event for an entry, and say what happened. */
export async function syncEntryToOutlookDetailed(p: OutlookEntryPayload): Promise<OutlookSyncResult> {
  try {
    const r = await call("upsert", p);
    if (r?.gone) return { ok: false, gone: true, eventId: null, error: "This meeting was deleted in Outlook." };
    if (r?.skipped) return { ok: false, skipped: true, eventId: p.outlookEventId ?? null, error: "Outlook isn't connected for your user — Settings → Interface → Connect Outlook." };
    if (r?.outlookEventId) return { ok: true, eventId: r.outlookEventId, invited: r.invited, joinUrl: r.joinUrl ?? null, teamsSkipped: !!r.teamsSkipped };
    if (r?.httpStatus === 404) return { ok: false, eventId: p.outlookEventId ?? null, error: "The outlook-sync function isn't deployed in Supabase (Edge Functions)." };
    if (r?.httpStatus === 401) return { ok: false, eventId: p.outlookEventId ?? null, error: "Supabase rejected the call (401). Sign out and in again." };
    return { ok: false, eventId: p.outlookEventId ?? null, error: r?.error ? errText(r.error) : `Unexpected answer from outlook-sync: ${JSON.stringify(r).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, eventId: p.outlookEventId ?? null, error: `Couldn't reach outlook-sync: ${errText(e)}` };
  }
}

/** Create or update the Outlook event for an entry. Returns the event id to store. */
export async function syncEntryToOutlook(p: OutlookEntryPayload): Promise<string | null> {
  const r = await syncEntryToOutlookDetailed(p);
  if (!r.ok && !r.skipped) console.warn("[outlook] sync failed:", r.error);
  return r.eventId; // never block saving on a sync failure
}

/**
 * Delete the Outlook event for an entry (best-effort). With the entry id, a
 * deal meeting is removed from its organiser's Outlook even when a teammate
 * deletes it — call this BEFORE deleting the row, so the function can read it.
 */
export async function deleteEntryFromOutlook(outlookEventId?: string | null, entryId?: string | null): Promise<void> {
  if (!outlookEventId) return;
  try { await call("delete", { outlookEventId, ...(entryId ? { entryId } : {}) }); } catch { /* ignore */ }
}

/**
 * Deal meetings that were deleted or cancelled in Outlook. The function has
 * already removed them from the CRM; this returns their ids so the page can
 * drop them too. Any problem (not deployed yet, Microsoft down…) → [] and
 * nothing changes.
 */
export async function meetingsGoneFromOutlook(entryIds: string[]): Promise<string[]> {
  if (!entryIds.length) return [];
  try {
    const r = await call("check", { entryIds });
    return Array.isArray(r?.gone) ? (r.gone as string[]) : [];
  } catch {
    return [];
  }
}

/* ===========================================================================
   Any calendar entry → its organiser's Outlook
   ---------------------------------------------------------------------------
   Reads the entry and everything it points at (type of work, client, project,
   phase and tasks, company, deal, contacts, summoned colleagues) and puts it
   in the event: a clear subject, a details table, the notes, and the people
   as attendees so Outlook invites them. Only events still to come invite
   anyone: logging yesterday's work must not email a meeting request.
   Colleagues summoned are always attendees; for a sales meeting the contacts
   picked under "Who with" are too. Client contacts on delivery work are
   listed in the body, not invited.
   =========================================================================== */
const KIND_LABEL: Record<string, string> = { teams: "Teams meeting", phone: "Phone call", in_person: "In person" };
const LINE_LABEL: Record<string, string> = { consultor: "Consultancy", supervision: "Project management", connector: "Connector", closure: "Project closure", sales: "Sales" };
const fullName = (r: any) => [r?.first_name, r?.last_name].filter(Boolean).join(" ") || r?.username || r?.email || "";

export async function syncCalendarEntry(entryId: string): Promise<OutlookSyncResult> {
  try {
    const [{ data: auth }, { data: row }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from("calendar_entries").select("*").eq("id", entryId).maybeSingle(),
    ]);
    const e = row as any;
    const me = auth?.user;
    if (!e || !me) return { ok: false, eventId: null, error: "Entry not found" };
    // The function writes to the signed-in user's own calendar.
    if (e.user_id !== me.id) return { ok: false, skipped: true, eventId: e.outlook_event_id ?? null };

    const ids = (v: unknown) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const isMeeting = e.kind === "meeting";
    const ownLine = e.billing_line === "closure" || e.billing_line === "sales";
    const [wt, cl, pj, co, trk, inv, mc, ct, rl] = await Promise.all([
      e.work_type_id ? supabase.from("work_types").select("name").eq("id", e.work_type_id).maybeSingle() : Promise.resolve({ data: null }),
      e.client_id ? supabase.from("clients").select("name").eq("id", e.client_id).maybeSingle() : Promise.resolve({ data: null }),
      e.project_id ? supabase.from("projects").select("*").eq("id", e.project_id).maybeSingle() : Promise.resolve({ data: null }),
      e.company_id ? supabase.from("companies").select("name").eq("id", e.company_id).maybeSingle() : Promise.resolve({ data: null }),
      e.tracking_id ? supabase.from("trackings").select("deal_name, company_id").eq("id", e.tracking_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from("entry_invites").select("invitee_id, status").eq("entry_id", entryId),
      isMeeting ? supabase.from("meeting_contacts").select("contact_id").eq("meeting_id", entryId) : Promise.resolve({ data: [] }),
      e.contact_id ? supabase.from("contacts").select("id, first_name, last_name, email").eq("id", e.contact_id).maybeSingle() : Promise.resolve({ data: null }),
      // The role the time is logged on (a catalogue role); old entries only have their line.
      e.role_id && !ownLine ? supabase.from("client_roles").select("name").eq("id", e.role_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const roleLabel = ((rl as any).data?.name as string) || LINE_LABEL[e.billing_line] || "";
    const project = (pj as any).data;
    let service = "";
    if (project?.service_id || project?.project_type_id) {
      const { data: sv } = await supabase.from("services").select("name").eq("id", project.service_id ?? project.project_type_id).maybeSingle();
      service = (sv as any)?.name ?? "";
    }
    const projectName = project ? (project.name || [service || "Project", project.kickoff_date].filter(Boolean).join(" · ")) : "";
    const phases: any[] = Array.isArray(project?.phases) ? project.phases : [];
    const phaseName = phases.find((p) => p.id === e.phase_id)?.name ?? "";
    const taskSet = new Set(ids(e.task_ids));
    const tasks = phases.flatMap((p) => (p.tasks ?? []).filter((t: any) => taskSet.has(t.id)).map((t: any) => `${t.name}${p.name ? ` (${p.name})` : ""}`));
    const clientContacts = (Array.isArray(project?.contacts) ? project.contacts : []).filter((c: any) => ids(e.attendees).includes(c.id));

    let companyName = ((co as any).data?.name as string) ?? "";
    const dealName = ((trk as any).data?.deal_name as string) ?? "";
    if (!companyName && (trk as any).data?.company_id) {
      const { data: c2 } = await supabase.from("companies").select("name").eq("id", (trk as any).data.company_id).maybeSingle();
      companyName = (c2 as any)?.name ?? "";
    }

    // People: summoned colleagues, and for a meeting the contacts it is with.
    const invitedIds = (((inv as any).data ?? []) as any[]).filter((i) => i.status !== "declined").map((i) => i.invitee_id);
    const contactIds = (((mc as any).data ?? []) as any[]).map((m) => m.contact_id);
    const [{ data: profs }, { data: cons }] = await Promise.all([
      invitedIds.length ? supabase.from("profiles").select("id, first_name, last_name, username, email").in("id", invitedIds) : Promise.resolve({ data: [] }),
      contactIds.length ? supabase.from("contacts").select("id, first_name, last_name, email").in("id", contactIds) : Promise.resolve({ data: [] }),
    ]);
    const colleagues = ((profs ?? []) as any[]).filter((r) => r.id !== me.id).map((r) => ({ email: r.email as string, name: fullName(r) }));
    const contacts = ((cons ?? []) as any[]).map((r) => ({ email: r.email as string, name: fullName(r) }));
    const linkedContact = (ct as any).data ? { email: (ct as any).data.email, name: fullName((ct as any).data) } : null;

    const end = new Date(`${e.entry_date}T${String(Math.floor(e.end_min / 60)).padStart(2, "0")}:${String(e.end_min % 60).padStart(2, "0")}:00`);
    const upcoming = end.getTime() > Date.now();
    const attendees = upcoming
      ? [
          ...colleagues,
          ...(isMeeting ? contacts : []),
          // Client people picked on a consultancy entry are invited too.
          ...clientContacts.map((c: any) => ({ email: String(c.email ?? "").trim(), name: c.name || c.email })),
        ].filter((a) => a.email && a.email.toLowerCase() !== (me.email ?? "").toLowerCase())
      : [];

    const wtName = ((wt as any).data?.name as string) ?? "";
    const clientName = ((cl as any).data?.name as string) ?? "";
    const how = KIND_LABEL[e.meeting_kind ?? ""] ?? "";
    const unit = e.billing_line === "sales" ? "" : `${Number(e.billable) || 0}`;
    const details: [string, string][] = isMeeting
      ? [
          ["Meeting", how],
          ["Company", companyName],
          ["Deal", dealName && dealName !== companyName ? dealName : ""],
          ["With", contacts.map((c) => c.name).join(", ")],
          ["Team", colleagues.map((c) => c.name).join(", ")],
        ]
      : [
          ["Type of work", wtName],
          ["How", how],
          ["Client", clientName || companyName],
          ["Project", projectName],
          ["Phase", phaseName],
          ["Tasks", tasks.join("\n")],
          ["Role", roleLabel],
          ["Billable", e.client_id && unit !== "0" ? unit : ""],
          ["Client people", clientContacts.map((c: any) => c.name).filter(Boolean).join(", ")],
          ["Contact", linkedContact?.name ?? ""],
          ["Team", colleagues.map((c) => c.name).join(", ")],
          ["Status", e.billing_line === "sales" ? "" : e.status === "confirmed" ? "Took place" : e.status === "cancelled" ? "Did not take place" : ""],
        ];
    const subject = isMeeting
      ? [companyName || contacts[0]?.name, e.title].filter(Boolean).join(" · ") || "Meeting"
      : [e.status === "cancelled" ? "Cancelled:" : "", [clientName || companyName, e.title || wtName || "Work"].filter(Boolean).join(" · ")].filter(Boolean).join(" ");

    const r = await syncEntryToOutlookDetailed({
      outlookEventId: e.outlook_event_id ?? null,
      date: e.entry_date,
      startMin: e.start_min,
      endMin: e.end_min,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      kind: isMeeting ? "meeting" : undefined,
      recreate: true,
      subject,
      details: details.filter(([, v]) => !!v),
      description: (e.notes ?? "") as string,
      notes: (e.notes ?? "") as string,
      attendees,
      online: e.meeting_kind === "teams",
      location: e.meeting_kind === "in_person" ? (companyName || clientName || undefined) : undefined,
      // older outlook-sync reads these
      workType: wtName, client: clientName || companyName, project: projectName, phase: phaseName, tasks: tasks.join(", "),
    });
    if (r.ok && r.eventId && r.eventId !== e.outlook_event_id) {
      await supabase.from("calendar_entries").update({ outlook_event_id: r.eventId }).eq("id", entryId);
    }
    if (!r.ok && !r.skipped) console.warn("[outlook] entry", entryId, "not synced:", r.error);
    return r;
  } catch (err: any) {
    return { ok: false, eventId: null, error: err?.message ?? String(err) };
  }
}

/** Remove an entry's Outlook event, reading its id first. Call before deleting the row. */
export async function unsyncCalendarEntry(entryId: string): Promise<void> {
  const { data } = await supabase.from("calendar_entries").select("outlook_event_id").eq("id", entryId).maybeSingle();
  const ev = (data as any)?.outlook_event_id ?? null;
  if (ev) await Promise.race([deleteEntryFromOutlook(ev, entryId), new Promise((r) => setTimeout(r, 8000))]);
}
