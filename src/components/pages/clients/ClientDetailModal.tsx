import { useEffect, useState } from "react";
import type { Client, Project, ProjectType } from "./ClientsPage";
import { projectValue } from "./ClientsPage";

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

export default function ClientDetailModal({
client, projects, projectTypes, usage, onOpenProject, onNewProject, onDeleteProject, onClose,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";

  const totals = projects.reduce(
    (acc, p) => {
      const signed = p.consultorDays + p.connectorDays + p.supervisionDays;
      const u = usage[p.id] ?? { planned: 0, done: 0 };
      acc.signed += signed;
      acc.done += u.done;
      acc.booked += u.planned;
      acc.value += projectValue(p);
      return acc;
    },
    { signed: 0, done: 0, booked: 0, value: 0 }
  );
  const left = +(totals.signed - totals.done - totals.booked).toFixed(2);

  return (
    <div className="cd-backdrop" onMouseDown={onClose}>
      <div className="cd-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="cd-head">
          <div>
<h2 className="cd-title">{client.name}</h2>
            <p className="cd-legal">{projects.length} project{projects.length === 1 ? "" : "s"}</p>
          </div>

<div className="cd-totals">
            <span className="cd-t"><b>{totals.signed.toFixed(2)}</b>signed</span>
            <span className="cd-sep" />
            <span className="cd-t"><b>{totals.done.toFixed(2)}</b>used</span>
            <span className="cd-sep" />
            <span className="cd-t"><b>{totals.booked.toFixed(2)}</b>booked</span>
            <span className="cd-sep" />
            <span className={`cd-t ${left < 0 ? "is-over" : ""}`}><b>{left.toFixed(2)}</b>left</span>
            <span className="cd-t-value">{totals.value.toLocaleString()}</span>
          </div>
<div className="cd-head-actions">
            <button className="ncm-x" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

<div className="cd-body">
          <div className="cd-section-head">
            <h3 className="cd-h3">Projects</h3>
            <button className="cl-primary" onClick={onNewProject}>+ New project</button>
          </div>

          {projects.length === 0 ? (
            <p className="cl-hint">No projects yet for this client.</p>
          ) : (
            <div className="cd-projects">
              {projects.map((p) => {
                const days = p.consultorDays + p.connectorDays + p.supervisionDays;
                return (
                  <div className="cd-project" key={p.id}>
                    <button className="cd-project-main" onClick={() => onOpenProject(p)}>
<div className="cd-project-top">
                        <span className="cd-project-type">{typeName(p.projectTypeId)}</span>
                        <span className="cl-chip cl-status">{p.status || "open"}</span>
                      </div>
                      <div className="cd-project-meta">
                        <span><em>Kick-off</em>{p.kickoffDate || "—"}</span>
                        <span><em>Signed</em>{p.signingDate || "—"}</span>
                        <span><em>Signed days</em>{days}d</span>
                        <span><em>Phases</em>{p.phases?.length ?? 0}</span>
                      </div>

                      {(() => {
                        const u = usage[p.id] ?? { planned: 0, done: 0 };
                        const booked = u.planned + u.done;
                        const left = +(days - booked).toFixed(2);
                        const pct = (n: number) => (days > 0 ? Math.min(100, (n / days) * 100) : 0);
                        return (
                          <div className="cd-usage">
                            <div className="cd-usage-track">
                              <div className="cd-usage-fill" style={{ width: `${pct(booked)}%` }} />
                              <div className="cd-usage-fill is-done" style={{ width: `${pct(u.done)}%` }} />
                            </div>
<div className="cd-usage-legend">
                              <span><i className="u-done" />{u.done.toFixed(2)} used</span>
                              <span><i className="u-plan" />{u.planned.toFixed(2)} booked</span>
                              <span className={left < 0 ? "is-over" : ""}>
                                {left < 0 ? `${Math.abs(left).toFixed(2)} over` : `${left.toFixed(2)} left`}
                              </span>
                            </div>
                          </div>
                        );
                      })()}
                      <div className="cd-project-foot">
                        <span>{p.team?.length ?? 0} team</span>
                        <span className="cl-value">{projectValue(p).toLocaleString()}</span>
                      </div>
                    </button>
                    <button
                      className="cd-project-del"
                      onClick={() => setConfirmDelete(p.id)}
                      aria-label="Delete project"
                    >×</button>

                    {confirmDelete === p.id && (
                      <div className="cd-confirm" onMouseDown={(e) => e.stopPropagation()}>
                        <p className="cd-confirm-text">Delete this project?<span>This can’t be undone.</span></p>
                        <div className="cd-confirm-actions">
                          <button className="cd-confirm-cancel" onClick={() => setConfirmDelete(null)}>Cancel</button>
                          <button
                            className="cd-confirm-del"
                            onClick={() => { onDeleteProject(p.id); setConfirmDelete(null); }}
                          >Delete</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}