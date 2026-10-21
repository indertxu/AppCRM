/* eslint-disable @typescript-eslint/no-explicit-any */
import NewClientForm from "../clients/NewClientForm";
import { useClientsData } from "../clients/useClientsData";
import { useState } from "react";
import ProjectsView, { type ProjectsViewMode } from "./ProjectsView";
import { PageLoader } from "../../framework/AppLayout";
import "../clients/ClientsPage.css";
import "./ProjectsPage.css";

/**
 * Projects — its own page and sidebar entry, but built on the same data and
 * flows as Clients (via useClientsData), so nothing is duplicated. It renders
 * the projects table and the project editor; creating a brand-new client lives
 * on the Clients page.
 */
export default function ProjectsPage() {
  const {
    clients, projects, projectTypes, roles, blueprints, lineUsage, loaded,
    editing, setEditing, handoffId, soldSummary,
    saveClientProject, setProjectStatus,
  } = useClientsData();

  const [view, setView] = useState<ProjectsViewMode>(() => {
    try { return (localStorage.getItem("projects.view") as ProjectsViewMode) || "list"; } catch { return "list"; }
  });
  const pick = (v: ProjectsViewMode) => { setView(v); try { localStorage.setItem("projects.view", v); } catch { /* private mode */ } };

  return (
    <div className={`cl pj-page is-${view}`}>
      <header className="cl-bar">
        <div className="cl-bar-left">
          <h1 className="cl-title">Projects</h1>
        </div>
        <div className="pj-views" role="tablist" aria-label="View">
          <span className="pj-views-ink" style={{ transform: view === "canvas" ? "translateX(100%)" : "none" }} />
          <button type="button" role="tab" aria-selected={view === "list"} className={view === "list" ? "is-on" : ""} onClick={() => pick("list")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>List
          </button>
          <button type="button" role="tab" aria-selected={view === "canvas"} className={view === "canvas" ? "is-on" : ""} onClick={() => pick("canvas")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="9.5" y="4" width="5" height="10" rx="1.5" /><rect x="16" y="4" width="5" height="13" rx="1.5" /></svg>Canvas
          </button>
        </div>
      </header>

      {!loaded ? <PageLoader label="Loading projects…" /> : (
      <div className="pj-in">
      <ProjectsView
        clients={clients}
        projects={projects}
        projectTypes={projectTypes}
        usage={lineUsage}
        roles={roles}
        onOpenProject={(c, p) => setEditing({ client: c, project: p })}
        onReopen={(p) => setProjectStatus(p, "open", null)}
        onClose_={(p) => {
          const d = prompt("End date (YYYY-MM-DD):", new Date().toISOString().slice(0, 10));
          if (d) setProjectStatus(p, "closed", d);
        }}
        view={view}
        blueprints={blueprints}
      />
      </div>
      )}

      {editing && (
        <NewClientForm
          key={editing.project?.id ?? editing.client?.id}
          client={editing.client}
          project={editing.project}
          onSave={saveClientProject}
          onClose={() => setEditing(null)}
          roles={roles}
          projectTypes={projectTypes}
          blueprints={blueprints}
          soldFrom={handoffId ? soldSummary : null}
        />
      )}
    </div>
  );
}