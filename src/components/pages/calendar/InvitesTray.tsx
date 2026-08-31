/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { acceptInvite, declineInvite, findClashes, loadMyReplies, markRepliesSeen,
  type InviteCard, type Clash, type InviteReply } from "./invitesApi";
import "./InvitesTray.css";

const hhmm = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const period = h < 12 ? "AM" : "PM";
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${period}`;
};

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

const dayLabel = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};

interface Props {
  invites: InviteCard[];
  userId: string;
  unit: (projectId: string | null) => "h" | "d";
  /** When given, the invitee picks which of these the accepted time counts as. */
  workTypes?: { id: string; name: string; color: string }[];
  onChanged: () => void;
  onClose: () => void;
}

export default function InvitesTray({ invites, userId, unit, workTypes, onChanged, onClose }: Props) {
  /** Work type chosen per invite, before accepting. */
  const [types, setTypes] = useState<Record<string, string>>({});
  /** What the invitee already has booked at the same time. */
  const [clashes, setClashes] = useState<Record<string, Clash[]>>({});
  /** Answers to what this person organised, so a decline does not go unseen. */
  const [replies, setReplies] = useState<InviteReply[]>([]);
  useEffect(() => {
    if (!userId) return;
    loadMyReplies(userId).then((rs) => {
      setReplies(rs);
      const unseen = rs.filter((r) => !r.seen).map((r) => r.id);
      if (unseen.length) markRepliesSeen(unseen).catch(() => {});
    }).catch(() => {});
  }, [userId]);
  useEffect(() => {
    if (!invites.length || !userId) return;
    findClashes(userId, invites.map((i) => ({
      id: i.id, entry_date: i.entry_date, start_min: i.start_min, end_min: i.end_min,
    }))).then(setClashes).catch(() => {});
  }, [invites, userId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const answer = async (inv: InviteCard, accept: boolean) => {
    setBusy(inv.id); setErr(null);
    const e = accept
      ? await acceptInvite(
          inv, userId,
          // Only override when the organiser left it open and we asked.
          inv.work_type_id ? null : (types[inv.id] ?? workTypes?.[0]?.id ?? null),
        )
      : await declineInvite(inv.id);
    setBusy(null);
    if (e) { setErr(e); return; }
    onChanged();
  };

  return (
    <div className="iv-pop" role="dialog" aria-label="Meeting invitations">
      <div className="iv-head">
        <span className="iv-eyebrow">Invitations</span>
        <h3 className="iv-title">
          {invites.length === 0 ? "Nothing waiting" : `${invites.length} waiting for you`}
        </h3>
      </div>

      {err && <p className="iv-err">{err}</p>}

      <div className="iv-list">
        {invites.map((inv) => (
          <article className="iv-card" key={inv.id}>
            <div className="iv-when">
              <b>{dayLabel(inv.entry_date)}</b>
              <span>{hhmm(inv.start_min)} – {hhmm(inv.end_min)}</span>
            </div>

            <p className="iv-from">
              <i>{(inv.organiser_name || "?").slice(0, 1).toUpperCase()}</i>
              <span><b>{inv.organiser_name}</b> wants you there</span>
            </p>

            {inv.message && <p className="iv-msg">{inv.message}</p>}

            {(clashes[inv.id]?.length ?? 0) > 0 ? (
              <div className="iv-clash">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h0M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
                <span>
                  <b>You are busy then</b>
                  {clashes[inv.id].map((c) => (
                    <em key={c.id}>{hhmm(c.start_min)}–{hhmm(c.end_min)} · {c.title || (c.kind === "meeting" ? "A meeting" : "Booked work")}</em>
                  ))}
                </span>
              </div>
            ) : (
              <p className="iv-free">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                Nothing else booked then
              </p>
            )}

            <p className="iv-bill">
              {inv.billable > 0
                ? <>Billed to the client as <b>{inv.billable}{unit(inv.project_id)}</b> of your time</>
                : <>Not billable — logged as attendance only</>}
            </p>

            {/* Only asked when the organiser left it open: an invitation from
                another consultant already carries the type of work. */}
            {workTypes && workTypes.length > 0 && !inv.work_type_id && (
              <div className="iv-types">
                <span>Log it as</span>
                <div className="iv-type-row">
                  {workTypes.map((w) => {
                    const on = (types[inv.id] ?? workTypes[0].id) === w.id;
                    return (
                      <button key={w.id} type="button" className={`iv-type ${on ? "is-on" : ""}`}
                        onClick={() => setTypes((m) => ({ ...m, [inv.id]: w.id }))}
                        title={w.name}>
                        <i style={{ background: w.color }} />
                        {w.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="iv-actions">
              <button className="iv-no" disabled={busy === inv.id} onClick={() => answer(inv, false)}>
                Decline
              </button>
              <button className="iv-yes" disabled={busy === inv.id} onClick={() => answer(inv, true)}>
                {busy === inv.id ? "…" : "Accept"}
              </button>
            </div>
          </article>
        ))}
      </div>

      {replies.length > 0 && (
        <div className="iv-replies">
          <p className="iv-replies-head">Replies to yours</p>
          {replies.slice(0, 6).map((r) => (
            <div className={`iv-reply is-${r.status} ${r.seen ? "" : "is-new"}`} key={r.id}>
              <i>{r.invitee_name.charAt(0).toUpperCase()}</i>
              <span>
                <b>{r.invitee_name}</b> {r.status === "accepted" ? "is coming to" : "turned down"}
                {" "}<em>{r.entry_title || "your booking"}</em>
              </span>
              <u>{fmtDay(r.entry_date)}</u>
            </div>
          ))}
        </div>
      )}

      <button className="iv-dismiss" onClick={onClose}>Close</button>
    </div>
  );
}