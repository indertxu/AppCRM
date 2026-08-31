/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { supabase } from "../../api/supabase";
import { loadAttendees, declineInvite, type Attendee } from "./invitesApi";
import "./SharedBookingView.css";

/**
 * What an invitee sees when they open a booking somebody else organised.
 *
 * Read-only on purpose: only the person who arranged it can change what it is,
 * when it runs or who is on it. This just lays out everything they need to
 * know before turning up.
 */
interface Props {
  entryId: string;
  /** The invite this entry came from, used to reach the original. */
  inviteId: string | null;
  /** Called after pulling out, so the week can drop the booking. */
  onLeft?: () => void;
  onClose: () => void;
}

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const lasts = (m: number) =>
  m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;

interface Detail {
  title: string | null;
  entry_date: string;
  start_min: number;
  end_min: number;
  billable: number;
  billing_line: string;
  notes: string | null;
  work_type: { name: string; color: string } | null;
  client_name: string | null;
  company_name: string | null;
  project_name: string | null;
  phase_name: string | null;
  task_names: string[];
  organiser: string | null;
}

export default function SharedBookingView({ entryId, inviteId, onLeft, onClose }: Props) {
  const [d, setD] = useState<Detail | null>(null);
  const [who, setWho] = useState<Attendee[]>([]);
  const [loading, setLoading] = useState(true);
  /** Pulling out: two clicks, since it removes the booking from the week. */
  const [arming, setArming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    (async () => {
      const { data: e } = await supabase.from("calendar_entries")
        .select("title, entry_date, start_min, end_min, billable, billing_line, notes, work_type_id, client_id, company_id, project_id, phase_id, task_ids")
        .eq("id", entryId).maybeSingle();
      if (!e) { setLoading(false); return; }
      const row = e as any;

      // Each name comes from its own table; missing ones simply do not show.
      const [wt, cl, co, pj] = await Promise.all([
        row.work_type_id
          ? supabase.from("work_types").select("name, color").eq("id", row.work_type_id).maybeSingle()
          : Promise.resolve({ data: null }),
        row.client_id
          ? supabase.from("clients").select("name").eq("id", row.client_id).maybeSingle()
          : Promise.resolve({ data: null }),
        row.company_id
          ? supabase.from("companies").select("name").eq("id", row.company_id).maybeSingle()
          : Promise.resolve({ data: null }),
        row.project_id
          ? supabase.from("projects").select("service_id, phases").eq("id", row.project_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      let projectName: string | null = null;
      let phaseName: string | null = null;
      let taskNames: string[] = [];
      const proj = (pj as any)?.data;
      if (proj) {
        if (proj.service_id) {
          const { data: svc } = await supabase.from("services")
            .select("name").eq("id", proj.service_id).maybeSingle();
          projectName = (svc as any)?.name ?? null;
        }
        const phases = (proj.phases ?? []) as any[];
        const phase = phases.find((p) => p.id === row.phase_id);
        phaseName = phase?.name ?? null;
        const wanted = String(row.task_ids ?? "").split(",").filter(Boolean);
        taskNames = (phase?.tasks ?? [])
          .filter((t: any) => wanted.includes(t.id))
          .map((t: any) => t.name);
      }

      // Who else is on it, and who put it together.
      const att = await loadAttendees([{ id: entryId, inviteId }]).catch(() => ({}));
      setWho(att[entryId] ?? []);

      let organiser: string | null = null;
      if (inviteId) {
        const { data: inv } = await supabase.from("entry_invites")
          .select("organiser_id").eq("id", inviteId).maybeSingle();
        const oid = (inv as any)?.organiser_id;
        if (oid) {
          const { data: p } = await supabase.from("profiles")
            .select("first_name, last_name, username, email").eq("id", oid).maybeSingle();
          const pr = p as any;
          organiser = pr
            ? [pr.first_name, pr.last_name].filter(Boolean).join(" ") || pr.username || pr.email
            : null;
        }
      }

      setD({
        title: row.title,
        entry_date: row.entry_date,
        start_min: row.start_min,
        end_min: row.end_min,
        billable: Number(row.billable) || 0,
        billing_line: row.billing_line,
        notes: row.notes,
        work_type: (wt as any)?.data ?? null,
        client_name: (cl as any)?.data?.name ?? null,
        company_name: (co as any)?.data?.name ?? null,
        project_name: projectName,
        phase_name: phaseName,
        task_names: taskNames,
        organiser,
      });
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, inviteId]);

  const day = d
    ? new Date(`${d.entry_date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long", day: "numeric", month: "long",
      })
    : "";

  return (
    <div className="sb-backdrop" onMouseDown={onClose}>
      <div className="sb-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sb-head">
          <div>
            <span className="sb-eyebrow">
              {d?.organiser ? `Arranged by ${d.organiser}` : "Shared booking"}
            </span>
            <h2 className="sb-title">{d?.title || "Booked time"}</h2>
          </div>
          <button className="sb-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {loading ? (
          <p className="sb-loading">Loading…</p>
        ) : !d ? (
          <p className="sb-loading">That booking is no longer there.</p>
        ) : (
          <>
            <div className="sb-when">
              <span className="sb-when-day">{day}</span>
              <span className="sb-when-time">
                <b>{hhmm(d.start_min)}</b>
                <i>→</i>
                <b>{hhmm(d.end_min)}</b>
                <em>{lasts(d.end_min - d.start_min)}</em>
              </span>
            </div>

            <dl className="sb-facts">
              {d.work_type && (
                <div className="sb-fact">
                  <dt>Type of work</dt>
                  <dd>
                    <i className="sb-dot" style={{ background: d.work_type.color }} />
                    {d.work_type.name}
                  </dd>
                </div>
              )}
              {(d.client_name || d.company_name) && (
                <div className="sb-fact">
                  <dt>{d.client_name ? "Client" : "Company"}</dt>
                  <dd>{d.client_name ?? d.company_name}</dd>
                </div>
              )}
              {d.project_name && (
                <div className="sb-fact">
                  <dt>Project</dt>
                  <dd>{d.project_name}</dd>
                </div>
              )}
              {d.phase_name && (
                <div className="sb-fact">
                  <dt>Phase</dt>
                  <dd>{d.phase_name}</dd>
                </div>
              )}
              {d.billable > 0 && (
                <div className="sb-fact">
                  <dt>Billed as</dt>
                  <dd className="sb-billable">{d.billable}</dd>
                </div>
              )}
            </dl>

            {d.task_names.length > 0 && (
              <div className="sb-block">
                <p className="sb-block-head">Tasks</p>
                <ul className="sb-tasks">
                  {d.task_names.map((t) => (
                    <li key={t}><i /> {t}</li>
                  ))}
                </ul>
              </div>
            )}

            {who.length > 0 && (
              <div className="sb-block">
                <p className="sb-block-head">Who is on it</p>
                <div className="sb-people">
                  {who.map((a) => (
                    <span className={`sb-person is-${a.status}`} key={a.invitee_id}>
                      <i>{a.name.charAt(0).toUpperCase()}</i>
                      {a.name}
                      <u>{a.status === "accepted" ? "in" : a.status === "declined" ? "out" : "waiting"}</u>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {d.notes && (
              <div className="sb-block">
                <p className="sb-block-head">Notes</p>
                <p className="sb-notes">{d.notes}</p>
              </div>
            )}

            {err && <p className="sb-err">{err}</p>}

            <div className="sb-foot">
              <span>Only whoever arranged this can change it.</span>
              {inviteId && (
                <button className={`sb-leave ${arming ? "is-armed" : ""}`}
                  disabled={leaving}
                  onClick={async () => {
                    if (!arming) {
                      setArming(true);
                      window.setTimeout(() => setArming(false), 4000);
                      return;
                    }
                    setLeaving(true); setErr(null);
                    const e = await declineInvite(inviteId);
                    setLeaving(false);
                    if (e) { setErr(e); setArming(false); return; }
                    onLeft?.();
                    onClose();
                  }}>
                  {leaving ? "Removing…" : arming ? "Yes, take me off it" : "Can't make it"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}