/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useEffect, useMemo, useState } from "react";
import type { Client, Project, ProjectType } from "./ClientsPage";
import { projectValue } from "./ClientsPage";
import { supabase } from "../../api/supabase";
import ClientDirectory from "./ClientDirectory";
import MentionInput, { type MentionPerson } from "../../framework/MentionInput";
import "../../framework/MentionInput.css";
import "./ClientWorkspace.css";

interface Props {
  client: Client;
  projects: Project[];
  projectTypes: ProjectType[];
  usage: Record<string, { planned: number; done: number }>;
  onOpenProject: (p: Project) => void;
  onNewProject: () => void;
  onDeleteProject: (id: string) => void;
  onClose: () => void;
}

type Tab = "info" | "projects" | "docs";

interface Note { id: string; body: string; mentions: string[]; author_id: string | null; created_at: string; }
interface ContactLog { id: string; contacted_at: string; channel: string | null; contact_name: string | null; reason: string | null; logged_by: string | null; }
interface TrackFile { id: string; name: string; note: string | null; mime: string | null; storage_path: string; created_at: string; }

const eur = (n: number) => Math.round(n).toLocaleString();

/** Render a note body, turning "@[name](id)" tokens into green mention pills. */
function renderNoteBody(body: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /@\[([^\]]+)\]\((?:employee|contact):[0-9a-f-]+\)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(body))) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push(<span className="cw-mention-pill" key={i++}>{m[1]}</span>);
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts.length ? parts : body;
}
const d2 = (n: number) => (+n.toFixed(2)).toLocaleString();
const ago = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

export default function ClientWorkspace({
  client, projects, projectTypes, usage, onOpenProject, onNewProject, onDeleteProject, onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>("info");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [units, setUnits] = useState<Record<string, "hour" | "day">>({});
  const [people, setPeople] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [contactLog, setContactLog] = useState<ContactLog[]>([]);
  const [trackFiles, setTrackFiles] = useState<TrackFile[]>([]);
  const [lastMeeting, setLastMeeting] = useState<{ at: string; title: string } | null>(null);
  const [lastCalendar, setLastCalendar] = useState<{ at: string; who: string; why: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [svc, prof, cl] = await Promise.all([
        supabase.from("services").select("id, rate_unit"),
        supabase.from("profiles").select("id, first_name, last_name"),
        supabase.from("clients").select("tenant_id, company_id").eq("id", client.id).maybeSingle(),
      ]);
      if (!alive) return;
      const u: Record<string, "hour" | "day"> = {};
      (svc.data ?? []).forEach((r: any) => { u[r.id] = r.rate_unit === "hour" ? "hour" : "day"; });
      setUnits(u);
      const pp: Record<string, string> = {};
      (prof.data ?? []).forEach((r: any) => { pp[r.id] = [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown"; });
      setPeople(pp);
      const tid = (cl.data as any)?.tenant_id ?? null;
      setTenantId(tid);

      // notes + contact log
      const [nt, lg] = await Promise.all([
        supabase.from("client_notes").select("*").eq("client_id", client.id).order("created_at", { ascending: false }),
        supabase.from("client_contacts_log").select("*").eq("client_id", client.id).order("contacted_at", { ascending: false }),
      ]);
      if (!alive) return;
      setNotes((nt.data ?? []) as Note[]);
      setContactLog((lg.data ?? []) as ContactLog[]);

      // Work / meetings the consultants actually did with this client, from the
      // calendar. A confirmed entry on this client's project IS real contact,
      // so it must count toward "last contacted".
      const { data: ce } = await supabase
        .from("calendar_entries")
        .select("entry_date, user_id, title, notes, kind, work_type_id")
        .eq("client_id", client.id)
        .eq("status", "confirmed")
        .lte("entry_date", new Date().toISOString().slice(0, 10))
        .order("entry_date", { ascending: false })
        .limit(1);
      if (alive && ce && ce[0]) {
        const e = ce[0] as any;
        setLastCalendar({
          at: `${e.entry_date}T12:00:00`,
          who: pp[e.user_id] ?? "A consultant",
          why: e.title || e.notes?.slice(0, 60) || (e.kind === "meeting" ? "Client meeting" : "On-site work"),
        });
      }

      // files attached in the sales tracking of this client's company
      const companyId = (cl.data as any)?.company_id;
      if (companyId) {
        const { data: trk } = await supabase.from("trackings").select("id").eq("company_id", companyId);
        const ids = (trk ?? []).map((t: any) => t.id);
        if (ids.length) {
          const { data: tf } = await supabase.from("tracking_files").select("id, name, note, mime, storage_path, created_at").in("tracking_id", ids);
          if (alive) setTrackFiles((tf ?? []) as TrackFile[]);
          // last meeting from those trackings
          const { data: mt } = await supabase.from("tracking_meetings").select("title, meet_at").in("tracking_id", ids).not("meet_at", "is", null).order("meet_at", { ascending: false }).limit(1);
          if (alive && mt && mt[0]) setLastMeeting({ at: (mt[0] as any).meet_at, title: (mt[0] as any).title });
        }
      }
    })();
    return () => { alive = false; };
  }, [client.id]);

  const unitOf = (p: Project) => (units[p.projectTypeId] === "hour" ? "h" : "d");

  // People available to @-mention: the team, formatted for MentionInput.
  const mentionPeople: MentionPerson[] = useMemo(
    () => Object.entries(people).map(([id, name]) => ({ id: `employee:${id}`, name, kind: "employee" as const })),
    [people]);

  // KPI totals
  const totals = useMemo(() => projects.reduce((acc, p) => {
    const signed = p.consultorDays + p.connectorDays + p.supervisionDays;
    const u = usage[p.id] ?? { planned: 0, done: 0 };
    acc.signed += signed; acc.done += u.done; acc.booked += u.planned; acc.value += projectValue(p);
    return acc;
  }, { signed: 0, done: 0, booked: 0, value: 0 }), [projects, usage]);
  const left = +(totals.signed - totals.done - totals.booked).toFixed(2);
  const donePct = totals.signed > 0 ? Math.min(100, (totals.done / totals.signed) * 100) : 0;

  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";
  const info = projects[0]; // client-level info lives on its projects

  // last contacted = most recent of manual log, tracking meeting, or note
  const lastContact = useMemo(() => {
    const candidates: { at: string; who: string; why: string; kind: string }[] = [];
    contactLog.forEach((l) => candidates.push({ at: l.contacted_at, who: l.contact_name || (l.logged_by ? people[l.logged_by] : "") || "—", why: l.reason || l.channel || "Contact logged", kind: l.channel || "log" }));
    if (lastMeeting) candidates.push({ at: lastMeeting.at, who: "Sales", why: lastMeeting.title || "Meeting", kind: "meeting" });
    if (lastCalendar) candidates.push({ at: lastCalendar.at, who: lastCalendar.who, why: lastCalendar.why, kind: "delivery" });
    notes.slice(0, 1).forEach((n) => candidates.push({ at: n.created_at, who: n.author_id ? people[n.author_id] : "—", why: n.body.slice(0, 60), kind: "note" }));
    candidates.sort((a, b) => b.at.localeCompare(a.at));
    return candidates[0] ?? null;
  }, [contactLog, lastMeeting, lastCalendar, notes, people]);

  const addNote = async () => {
    const body = noteDraft.trim();
    if (!body) return;
    // MentionInput serializes tags as "@[name](employee:<uuid>)". Pull the uuids.
    const mentions = Array.from(body.matchAll(/@\[[^\]]+\]\(employee:([0-9a-f-]+)\)/g)).map((m) => m[1]);
    const { data: me } = await supabase.auth.getUser();
    const authorId = me?.user?.id ?? null;
    // Make sure this author appears with a name even if the profiles map was
    // missing them (e.g. name fields empty): seed the people map from the row.
    if (authorId && !people[authorId]) {
      const { data: prof } = await supabase.from("profiles").select("first_name, last_name, email").eq("id", authorId).maybeSingle();
      const nm = prof ? ([(prof as any).first_name, (prof as any).last_name].filter(Boolean).join(" ") || (prof as any).email || me?.user?.email) : me?.user?.email;
      if (nm) setPeople((pp) => ({ ...pp, [authorId]: nm }));
    }
    const { data, error } = await supabase.from("client_notes").insert({
      client_id: client.id, body, mentions, author_id: authorId,
    }).select().single();
    if (!error && data) { setNotes((xs) => [data as Note, ...xs]); setNoteDraft(""); }
  };

  const staleDays = lastContact ? Math.floor((Date.now() - new Date(lastContact.at).getTime()) / 86400000) : null;
  const staleClass = staleDays == null ? "" : staleDays > 60 ? "is-stale-bad" : staleDays > 30 ? "is-stale-warn" : "is-stale-ok";

  const ARC = 169.65;

  return (
    <div className="cw-backdrop" onMouseDown={onClose}>
      <div className="cw" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {/* header + KPI strip */}
        <header className="cw-head">
          <span className="cw-head-glow" aria-hidden="true" />
          <button className="cw-x" onClick={onClose} aria-label="Close">×</button>

          <div className="cw-head-row">
            <div className="cw-id">
              <span className="cw-av">{client.name.charAt(0).toUpperCase()}</span>
              <div>
                <h2 className="cw-name">{client.name}</h2>
                <span className="cw-sub">{projects.length} project{projects.length === 1 ? "" : "s"}{info?.address?.city ? ` · ${info.address.city}` : ""}</span>
              </div>
            </div>

            <div className="cw-kpis">
              <div className="cw-kpi cw-kpi-gauge">
                <div className="cw-ring">
                  <svg viewBox="0 0 140 82" aria-hidden="true">
                    <path className="cw-arc-bg" d="M16 70 A54 54 0 0 1 124 70" pathLength={ARC} />
                    <path className="cw-arc-fill" d="M16 70 A54 54 0 0 1 124 70" pathLength={ARC}
                      style={{ strokeDasharray: `${(ARC * donePct / 100).toFixed(2)} ${ARC}` }} />
                  </svg>
                  <span className="cw-ring-mid"><b>{Math.round(donePct)}</b><i>% used</i></span>
                </div>
                <div className="cw-kpi-side">
                  <span className="cw-kpi-k">Signed</span>
                  <b className="cw-kpi-v">{d2(totals.signed)}</b>
                </div>
              </div>
              <div className="cw-kpi"><span className="cw-kpi-k">Used</span><b className="cw-kpi-v">{d2(totals.done)}</b></div>
              <div className="cw-kpi"><span className="cw-kpi-k">Booked</span><b className="cw-kpi-v">{d2(totals.booked)}</b></div>
              <div className="cw-kpi"><span className="cw-kpi-k">Left</span><b className={`cw-kpi-v ${left < 0 ? "is-over" : "is-neon"}`}>{d2(left)}</b></div>
              <div className="cw-kpi"><span className="cw-kpi-k">Value</span><b className="cw-kpi-v is-neon">{eur(totals.value)}<em>€</em></b></div>
            </div>
          </div>

          <nav className="cw-tabs">
            <button className={tab === "info" ? "is-on" : ""} onClick={() => setTab("info")}>Client info</button>
            <button className={tab === "projects" ? "is-on" : ""} onClick={() => setTab("projects")}>Projects <i>{projects.length}</i></button>
            <button className={tab === "docs" ? "is-on" : ""} onClick={() => setTab("docs")}>Docs</button>
          </nav>
        </header>

        <div className="cw-body">
          {/* ---- CLIENT INFO ---- */}
          {tab === "info" && (
            <div className="cw-info">
              <section className="cw-card">
                <h3>Company</h3>
                <dl className="cw-facts">
                  <div><dt>Legal name</dt><dd>{info?.legalName || "—"}</dd></div>
                  <div><dt>VAT</dt><dd>{info?.vatNumber || "—"}</dd></div>
                  <div><dt>Kick-off</dt><dd>{info?.kickoffDate || "—"}</dd></div>
                  <div><dt>Signed</dt><dd>{info?.signingDate || "—"}</dd></div>
                </dl>
              </section>
              <section className="cw-card">
                <h3>Address</h3>
                <dl className="cw-facts">
                  <div><dt>Street</dt><dd>{info?.address?.street || "—"}</dd></div>
                  <div><dt>City</dt><dd>{info?.address?.city || "—"}</dd></div>
                  <div><dt>Postal</dt><dd>{info?.address?.postalCode || "—"}</dd></div>
                  <div><dt>Country</dt><dd>{info?.address?.country || "—"}</dd></div>
                </dl>
              </section>
              <section className="cw-card cw-card-contacts">
                <h3>Contacts</h3>
                {(info?.contacts?.length ?? 0) === 0 ? <p className="cw-hint">No contacts on file.</p> : (
                  <div className="cw-contacts">
                    {info!.contacts.map((c: any, i: number) => (
                      <div className="cw-contact" key={i}>
                        <span className="cw-contact-av">{(c.name || "?").charAt(0).toUpperCase()}</span>
                        <span className="cw-contact-txt"><b>{c.name || "Unnamed"}</b>{c.email && <em>{c.email}</em>}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* last contacted */}
              <section className={`cw-card cw-lastcontact ${staleClass}`}>
                <h3>Last contacted</h3>
                {!lastContact ? (
                  <p className="cw-hint">No recorded contact yet.</p>
                ) : (
                  <div className="cw-lc">
                    <div className="cw-lc-when">
                      <b>{ago(lastContact.at)}</b>
                      <span>{new Date(lastContact.at).toLocaleDateString()}</span>
                    </div>
                    <div className="cw-lc-detail">
                      <span className="cw-lc-kind">{lastContact.kind}</span>
                      <p><b>{lastContact.who}</b> — {lastContact.why}</p>
                    </div>
                    {staleDays != null && staleDays > 30 && (
                      <span className="cw-lc-flag">{staleDays > 60 ? "Neglected" : "Getting quiet"}</span>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ---- PROJECTS ---- */}
          {tab === "projects" && (
            <div className="cw-projects">
              <div className="cw-projects-head">
                <h3>Projects</h3>
                <button className="cw-btn-primary" onClick={onNewProject}>+ New project</button>
              </div>
              {projects.length === 0 ? <p className="cw-hint">No projects yet.</p> : (
                <div className="cw-proj-list">
                  {projects.map((p) => {
                    const days = p.consultorDays + p.connectorDays + p.supervisionDays;
                    const u = usage[p.id] ?? { planned: 0, done: 0 };
                    const booked = u.planned + u.done;
                    const pl = +(days - booked).toFixed(2);
                    const pct = (n: number) => (days > 0 ? Math.min(100, (n / days) * 100) : 0);
                    const usedPct = Math.round(pct(u.done));
                    return (
                      <div className="cw-prow" key={p.id}>
                        <button className="cw-prow-main" onClick={() => onOpenProject(p)}>
                          <div className="cw-prow-id">
                            <span className="cw-prow-type">{typeName(p.projectTypeId)}</span>
                            <span className="cw-prow-dates">
                              <span><em>Kick-off</em>{p.kickoffDate || "—"}</span>
                              <span><em>End</em>{p.endDate || "—"}</span>
                            </span>
                          </div>

                          <div className="cw-prow-prog">
                            <div className="cw-prow-bar">
                              <span className="cw-prow-fill" style={{ width: `${pct(booked)}%` }} />
                              <span className="cw-prow-fill is-done" style={{ width: `${pct(u.done)}%` }} />
                            </div>
                            <div className="cw-prow-figs">
                              <span><b>{u.done.toFixed(2)}{unitOf(p)}</b> used</span>
                              <span><b>{u.planned.toFixed(2)}{unitOf(p)}</b> booked</span>
                              <span>of <b>{days}{unitOf(p)}</b> signed</span>
                              <span className={pl < 0 ? "is-over" : ""}>{pl < 0 ? `${Math.abs(pl).toFixed(2)} over` : `${pl.toFixed(2)} left`}</span>
                            </div>
                          </div>

                          <div className="cw-prow-pct">
                            <b>{usedPct}<i>%</i></b>
                            <span>delivered</span>
                          </div>

                          <div className="cw-prow-side">
                            <span className={`cw-chip ${p.status === "closed" ? "is-closed" : ""}`}>{p.status || "open"}</span>
                            <span className="cw-prow-val">{Math.round(projectValue(p)).toLocaleString()} €</span>
                          </div>
                        </button>
                        <button className="cw-proj-del" onClick={() => onDeleteProject(p.id)} aria-label="Delete">×</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ---- DOCS ---- */}
          {tab === "docs" && (
            <div className="cw-docs">
              <div className="cw-docs-left">
                {/* notes */}
                <section className="cw-card">
                  <h3>Notes</h3>
                  <div className="cw-note-add">
                    <MentionInput
                      value={noteDraft}
                      onChange={setNoteDraft}
                      people={mentionPeople}
                      placeholder="Write a note… type @ to tag someone"
                      multiline
                      className="cw-mention"
                    />
                    <button className="cw-btn-primary" disabled={!noteDraft.trim()} onClick={addNote}>Add note</button>
                  </div>
                  <div className="cw-notes">
                    {notes.length === 0 ? <p className="cw-hint">No notes yet.</p> : notes.map((n) => (
                      <div className="cw-note" key={n.id}>
                        <span className="cw-note-av">{(people[n.author_id ?? ""] ?? "?").charAt(0).toUpperCase()}</span>
                        <div className="cw-note-body">
                          <p>{renderNoteBody(n.body)}</p>
                          <span className="cw-note-meta">{people[n.author_id ?? ""] ?? "Unknown"} · {ago(n.created_at)}
                            {n.mentions.length > 0 && <em> · tagged {n.mentions.map((m) => people[m]).filter(Boolean).join(", ")}</em>}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {/* files from the sale's tracking */}
                <section className="cw-card">
                  <h3>From the sale <span className="cw-card-sub">attached during the sales tracking</span></h3>
                  {trackFiles.length === 0 ? <p className="cw-hint">No files were attached during the sale.</p> : (
                    <div className="cw-trackfiles">
                      {trackFiles.map((f) => (
                        <div className={`cw-tf ${f.note ? "has-note" : ""}`} key={f.id} title={f.note ?? ""}>
                          <span className="cw-tf-kind">{(f.name.split(".").pop() ?? "•").slice(0, 3).toUpperCase()}</span>
                          <span className="cw-tf-name">{f.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              {/* the directory — the centerpiece */}
              <div className="cw-docs-right">
                <h3 className="cw-dir-title">Client directory</h3>
                <ClientDirectory clientId={client.id} tenantId={tenantId} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}