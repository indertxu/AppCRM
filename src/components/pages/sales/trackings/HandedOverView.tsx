/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../../api/supabase";
import { useBackToClose } from "../../../framework/useBackToClose";
import { loadPipeline, type Phase } from "../../settings/pipelineApi";
import type { Company, Contact } from "../../companies/companiesApi";
import { loadNotes, loadTasks, type Tracking, type TrackNote, type TrackTask } from "../sales/salesApi";
import { orderPhases, type TrackingHandover } from "../extras/salesRolesApi";
import { displayValue, type TrackingField } from "../extras/trackingFieldsApi";
import { MentionText } from "../../../framework/MentionInput";
import "./Handover.css";

/**
 * A deal this person handed over: read-only, exactly as it was at the handover.
 * Nothing added afterwards (notes, tasks, meetings, documents, phase moves,
 * new values) is shown.
 */
export default function HandedOverView({ tracking, handover, companies, contacts, employees, trackingFields = [], onBack }: {
  tracking: Tracking; handover: TrackingHandover;
  companies: Company[]; contacts: Contact[]; employees: { id: string; name: string }[];
  trackingFields?: TrackingField[];
  onBack: () => void;
}) {
  useBackToClose(`sales-deal-${tracking.id}`, onBack);
  const at = handover.created_at;
  const snap = handover.snapshot ?? ({} as any);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [notes, setNotes] = useState<TrackNote[]>([]);
  const [tasks, setTasks] = useState<TrackTask[]>([]);
  const [meetings, setMeetings] = useState<{ id: string; title: string; when: string }[]>([]);
  const [files, setFiles] = useState<{ id: string; name: string; storage_path: string; created_at: string }[]>([]);

  useEffect(() => {
    if (tracking.pipeline_id) loadPipeline(tracking.pipeline_id).then(({ phases }) => setPhases(orderPhases(phases))).catch(() => {});
    const before = (d?: string | null) => !!d && d <= at;
    loadNotes(tracking.id).then((n) => setNotes(n.filter((x) => before(x.created_at)))).catch(() => {});
    loadTasks(tracking.id).then((t) => setTasks(t.filter((x) => before(x.created_at)))).catch(() => {});
    supabase.from("calendar_entries").select("id, title, entry_date, start_min, created_at").eq("tracking_id", tracking.id).eq("kind", "meeting")
      .then(({ data, error }: any) => {
        if (error) return;
        setMeetings(((data ?? []) as any[]).filter((m) => (m.created_at ? m.created_at <= at : m.entry_date <= at.slice(0, 10)))
          .map((m) => ({ id: m.id, title: m.title ?? "Meeting", when: `${m.entry_date} ${String(Math.floor((m.start_min ?? 0) / 60)).padStart(2, "0")}:${String((m.start_min ?? 0) % 60).padStart(2, "0")}` })));
      });
    supabase.from("tracking_files").select("id, name, storage_path, created_at").eq("tracking_id", tracking.id)
      .then(({ data }: any) => setFiles(((data ?? []) as any[]).filter((f) => before(f.created_at))));
  }, [tracking.id, tracking.pipeline_id, at]);

  const company = companies.find((c) => c.id === tracking.company_id);
  const contactName = (id: string) => { const c = contacts.find((x) => x.id === id); return c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "Contact"; };
  const title = company?.name || (tracking.contactIds[0] ? contactName(tracking.contactIds[0]) : "Untitled");
  const toName = employees.find((e) => e.id === handover.to_profile)?.name ?? "a colleague";
  const when = new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const curIdx = phases.findIndex((p) => p.id === snap.phase_id);
  const shown = useMemo(() => phases.filter((p) => !p.sales_outcome), [phases]);
  const eur = (n: number) => `${Math.round(n || 0).toLocaleString("es-ES")} €`;
  const fmtDay = (d?: string | null) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
  const open = async (f: { storage_path: string }) => {
    const { data } = await supabase.storage.from("tracking-files").createSignedUrl(f.storage_path, 60);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  };

  return (
    <div className="sl sl-detail hov-frozen">
      <header className="sl-head sl-d-head">
        <button className="sl-back" onClick={onBack} aria-label="Back">‹</button>
        <span className="sl-d-avatar">{title.slice(0, 1).toUpperCase()}</span>
        <div className="sl-d-id">
          <h1 className="sl-title">{title}</h1>
          <div className="sl-d-metaline">
            <span className="sl-d-badge hov-badge">Handed over</span>
            <span className="sl-d-sub">to {toName} · {when}{handover.role_name ? ` · ${handover.role_name}` : ""}</span>
          </div>
        </div>
      </header>

      <div className="sl-scroll">
        <div className="hov-banner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          <span>You handed this deal over to <b>{toName}</b> on {when}. This is how it looked then — anything added afterwards isn't shown, and it can't be edited.</span>
        </div>

        <div className="sl-pipe sl-pipe-active hov-pipe">
          <div className="sl-pipe-body">
            <div className="sl-flow">
              {shown.map((p, i) => {
                const state = curIdx < 0 ? "future" : i < curIdx ? "done" : i === curIdx ? "cur" : "future";
                return (
                  <div key={p.id} className="sl-flow-item">
                    {i > 0 && <div className={`sl-flow-bar ${i <= curIdx ? "is-on" : ""}`} />}
                    <span className={`sl-flow-node is-${state}`}>
                      <span className="sl-flow-num">{state === "done" ? "✓" : i + 1}</span>
                      <span className="sl-flow-text"><span className="sl-flow-name">{p.name}</span></span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="sl-work hov-work">
          <section className="sl-panel">
            <h3 className="sl-panel-title">At the handover</h3>
            <dl className="hov-facts">
              <div><dt>Potential revenue</dt><dd>{eur(snap.total)}</dd></div>
              <div><dt>Sales estimate</dt><dd>{snap.rep_close_prob == null ? "—" : `${snap.rep_close_prob}%`} · {fmtDay(snap.rep_close_date)}</dd></div>
              <div><dt>Management estimate</dt><dd>{snap.mgr_close_prob == null ? "—" : `${snap.mgr_close_prob}%`} · {fmtDay(snap.mgr_close_date)}</dd></div>
              {trackingFields.map((f) => {
                const v = displayValue(f, snap.custom?.[f.id]);
                return v ? <div key={f.id}><dt>{f.label}</dt><dd>{v}</dd></div> : null;
              })}
            </dl>
          </section>

          <section className="sl-panel">
            <h3 className="sl-panel-title">Notes<span>{notes.length}</span></h3>
            {notes.length === 0 ? <p className="hov-empty">No notes before the handover.</p> : (
              <ul className="hov-items">{notes.map((n) => <li key={n.id}><p><MentionText text={n.body} /></p><small>{fmtDay(n.created_at)}</small></li>)}</ul>
            )}
          </section>

          <section className="sl-panel">
            <h3 className="sl-panel-title">Tasks & meetings<span>{tasks.length + meetings.length}</span></h3>
            {tasks.length + meetings.length === 0 ? <p className="hov-empty">Nothing planned before the handover.</p> : (
              <ul className="hov-items">
                {tasks.map((t) => <li key={t.id}><p><MentionText text={t.title} /></p><small>Task{t.due_at ? ` · due ${fmtDay(t.due_at)}` : ""}</small></li>)}
                {meetings.map((m) => <li key={m.id}><p><MentionText text={m.title} /></p><small>Meeting · {fmtDay(m.when)} {m.when.slice(11)}</small></li>)}
              </ul>
            )}
          </section>

          <section className="sl-panel">
            <h3 className="sl-panel-title">Documents<span>{files.length}</span></h3>
            {files.length === 0 ? <p className="hov-empty">No documents before the handover.</p> : (
              <ul className="hov-items">{files.map((f) => <li key={f.id}><button className="hov-file" onClick={() => open(f)}>{f.name}</button><small>{fmtDay(f.created_at)}</small></li>)}</ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
