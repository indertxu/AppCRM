/* eslint-disable @typescript-eslint/no-explicit-any */
import NewClientForm from "../clients/NewClientForm";
import { useClientsData } from "../clients/useClientsData";
import ProjectsView from "./ProjectsView";
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
    clients, projects, projectTypes, roles, blueprints, lineUsage,
    editing, setEditing, handoffId, soldSummary,
    saveClientProject, setProjectStatus,
  } = useClientsData();

  return (
    <div className="cl">
      <header className="cl-bar">
        <div className="cl-bar-left">
          <h1 className="cl-title">Projects</h1>
        </div>
      </header>

      <ProjectsView
        clients={clients}
        projects={projects}
        projectTypes={projectTypes}
        usage={lineUsage}
        onOpenProject={(c, p) => setEditing({ client: c, project: p })}
        onReopen={(p) => setProjectStatus(p, "open", null)}
        onClose_={(p) => {
          const d = prompt("End date (YYYY-MM-DD):", new Date().toISOString().slice(0, 10));
          if (d) setProjectStatus(p, "closed", d);
        }}
      />

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