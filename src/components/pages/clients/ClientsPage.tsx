/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useMemo } from "react";
import { supabase } from "../../api/supabase";
import NewClientForm from "./NewClientForm";
import ClientWorkspace from "./ClientWorkspace";
import Select from "../../framework/Select";
import { useClientsData } from "./useClientsData";
import { projectValue, type Client, type Project, type ProjectType } from "./clientsTypes";
import "./ClientsPage.css";

// Re-export shared types & helpers from their new home so existing imports
// elsewhere (e.g. ./ClientsPage) keep working unchanged.
export * from "./clientsTypes";

function ClientList({
  clients, projects, projectTypes, onNew, onOpen, onDelete, usage, units,
}: {
  clients: Client[];
  projects: Project[];
  projectTypes: ProjectType[];
  onNew: () => void;
  onOpen: (c: Client) => void;
  onDelete?: (c: Client, projectCount: number) => void;
  usage: Record<string, { planned: number; done: number }>;
  units: Record<string, "hour" | "day">;
}) {
  const [q, setQ] = useState("");
  const [fType, setFType] = useState("");
  const [fConsultant, setFConsultant] = useState("");
  const [sort, setSort] = useState("recent");

  // Resolve team member ids → names for the consultant filter.
  const [people, setPeople] = useState<Record<string, string>>({});
  useEffect(() => {
    supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(({ data }: any) => {
      const out: Record<string, string> = {};
      ((data?.users ?? []) as any[]).forEach((u) => {
        out[u.id] = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—";
      });
      setPeople(out);
    }).catch(() => {});
  }, []);
  const personName = (id: string, fb?: string) => people[id] || (fb && fb !== "—" ? fb : "") || "Unknown";

  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";
  const projOf = (c: Client) => projects.filter((p) => p.clientId === c.id);
  const clientValue = (c: Client) => projOf(c).reduce((s, p) => s + projectValue(p), 0);

  // Filter options derived from the data.
  const typeOptions = useMemo(() => {
    const ids = new Set<string>();
    projects.forEach((p) => { if (p.projectTypeId) ids.add(p.projectTypeId); });
    return Array.from(ids).map((id) => ({ value: id, label: typeName(id) })).sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, projectTypes]);
  const consultantOptions = useMemo(() => {
    const byId = new Map<string, string>();
    projects.forEach((p) => (p.team ?? []).forEach((m) => {
      if (m.userId && !byId.has(m.userId)) byId.set(m.userId, personName(m.userId, m.name));
    }));
    return Array.from(byId, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, people]);

  const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const shownClients = useMemo(() => {
    const needle = norm(q.trim());
    const list = clients.filter((c) => {
      const mine = projOf(c);
      if (fType && !mine.some((p) => p.projectTypeId === fType)) return false;
      if (fConsultant && !mine.some((p) => (p.team ?? []).some((m) => m.userId === fConsultant))) return false;
      if (needle) {
        const hay = norm([c.name, ...mine.map((p) => typeName(p.projectTypeId))].join(" "));
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    return list.sort((a, b) => {
      if (sort === "value") return clientValue(b) - clientValue(a);
      if (sort === "projects") return projOf(b).length - projOf(a).length;
      if (sort === "name") return a.name.localeCompare(b.name);
      return 0; // recent = keep incoming order
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, projects, q, fType, fConsultant, sort, people, projectTypes]);

  const anyFilter = !!(q || fType || fConsultant || sort !== "recent");
  const clearAll = () => { setQ(""); setFType(""); setFConsultant(""); setSort("recent"); };

  if (clients.length === 0) {
    return (
      <div className="cl-empty">
        <div className="cl-empty-badge" aria-hidden="true" />
        <h2>No clients yet</h2>
        <p>Create your first engagement to get started.</p>
        <button className="cl-primary" onClick={onNew}>+ New client</button>
      </div>
    );
  }

  // Days and hours are different units, so they are counted apart rather than
  // added into one meaningless figure. Reflects the active filters.
  const shownProjectIds = new Set(shownClients.flatMap((c) => projOf(c).map((p) => p.id)));
  const totals = shownClients.reduce((acc, c) => {
    const mine = projOf(c);
    acc.projects += mine.length;
    acc.value += mine.reduce((s, p) => s + projectValue(p), 0);
    mine.forEach((p) => {
      const signed = p.consultorDays + p.connectorDays + p.supervisionDays;
      if (units[p.projectTypeId] === "hour") acc.hours += signed; else acc.days += signed;
    });
    return acc;
  }, { projects: 0, value: 0, days: 0, hours: 0 });

  const signedAll = totals.days + totals.hours;
  // Usage keys look like "<projectId>|<line>", so only count usage of shown projects.
  const doneAll = Object.entries(usage).reduce((s, [k, u]) => {
    const pid = k.split("|")[0];
    return shownProjectIds.has(pid) ? s + u.done : s;
  }, 0);
  const deliveredPct = signedAll > 0 ? Math.round((doneAll / signedAll) * 100) : 0;

  return (
    <>
      <div className="pv-bar">
        <div className="pv-search">
          <span className="pv-search-ico" aria-hidden="true">⌕</span>
          <input className="pv-search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client, service…" />
          {q && <button className="pv-search-x" onClick={() => setQ("")} aria-label="Clear">×</button>}
        </div>
        <div className="pv-filter">
          <Select value={fType} onChange={setFType} placeholder="All services"
            options={[{ value: "", label: "All services" }, ...typeOptions]} />
        </div>
        <div className="pv-filter">
          <Select value={fConsultant} onChange={setFConsultant} placeholder="All consultants"
            options={[{ value: "", label: "All consultants" }, ...consultantOptions]} />
        </div>
        <div className="pv-filter">
          <Select value={sort} onChange={setSort}
            options={[
              { value: "recent", label: "Most recent" },
              { value: "value", label: "Highest value" },
              { value: "projects", label: "Most projects" },
              { value: "name", label: "Name A–Z" },
            ]} />
        </div>
        {anyFilter && <button className="pv-clear" onClick={clearAll}>Clear</button>}
      </div>

      <div className="cl-kpis">
        <div className="cl-kpi">
          <span className="cl-kpi-k">Clients</span>
          <b className="cl-kpi-v">{shownClients.length}</b>
          <span className="cl-kpi-sub">{totals.projects} projects running</span>
        </div>

        <div className="cl-kpi">
          <span className="cl-kpi-k">Signed</span>
          <b className="cl-kpi-v">
            {totals.days.toLocaleString()}<em>d</em>
            {totals.hours > 0 && <><span className="cl-kpi-plus">/</span>{totals.hours.toLocaleString()}<em>h</em></>}
          </b>
          <span className="cl-kpi-sub">committed to deliver</span>
        </div>

        <div className="cl-kpi">
          <span className="cl-kpi-k">Delivered</span>
          <b className="cl-kpi-v">{deliveredPct}<em>%</em></b>
          <span className="cl-kpi-meter"><i style={{ width: `${deliveredPct}%` }} /></span>
        </div>

        <div className="cl-kpi cl-kpi-money">
          <span className="cl-kpi-k">Contract value</span>
          <b className="cl-kpi-v">{Math.round(totals.value).toLocaleString()}<em>€</em></b>
          <span className="cl-kpi-sub">
            {totals.days + totals.hours > 0
              ? `${Math.round(totals.value / (totals.days + totals.hours / 8))} € per day`
              : "—"}
          </span>
        </div>
      </div>

      <div className="cl-scroll">
        {shownClients.length === 0 ? (
          <p className="cl-hint">No clients match those filters.</p>
        ) : (
        <div className="cl-list">
          {shownClients.map((c) => {
            const mine = projects.filter((p) => p.clientId === c.id);
            const total = mine.reduce((s, p) => s + projectValue(p), 0);
            const typeNames = [...new Set(
              mine.map((p) => projectTypes.find((t) => t.id === p.projectTypeId)?.name).filter(Boolean)
            )] as string[];
            const last = mine[mine.length - 1];
            const signed = mine.reduce((s, p) => s + p.consultorDays + p.connectorDays + p.supervisionDays, 0);
            const used = mine.reduce((s, p) => s + (usage[p.id]?.done ?? 0), 0);
            const pct = signed > 0 ? Math.min(100, Math.round((used / signed) * 100)) : 0;
            return (
              <div className="cl-row" key={c.id} role="button" tabIndex={0}
                onClick={() => onOpen(c)}
                onKeyDown={(e) => { if (e.key === "Enter") onOpen(c); }}>
                <span className="cl-row-glow" aria-hidden="true" />

                <span className="cl-c cl-c-name">
                  <span className="cl-av">{(c.name || "?").slice(0, 1).toUpperCase()}</span>
                  <span className="cl-name-txt">
                    <b>{c.name}</b>
                    <em>{typeNames.length > 0 ? typeNames.join(" · ") : "No service"}</em>
                  </span>
                </span>

                <span className="cl-c cl-c-meta">
                  <i className="cl-tag">{mine.length} {mine.length === 1 ? "project" : "projects"}</i>
                  {last?.address?.city && <i className="cl-tag cl-tag-soft">{last.address.city}</i>}
                  {(last?.contacts?.length ?? 0) > 0 && (
                    <i className="cl-tag cl-tag-soft">{last?.contacts?.length} contacts</i>
                  )}
                </span>

                <span className="cl-c cl-c-prog">
                  <span className="cl-pbar"><span className="cl-pbar-fill" style={{ width: `${pct}%` }} /></span>
                  <em>{pct}% delivered</em>
                </span>

                <span className="cl-c cl-r cl-total">
                  <b>{total > 0 ? `${Math.round(total).toLocaleString()} €` : "—"}</b>
                  <em>{signed > 0 ? `${signed.toFixed(2)} days signed` : "no days yet"}</em>
                </span>

                <span className="cl-c cl-c-go">
                  {onDelete && (
                    <button className="cl-row-del" aria-label={`Delete ${c.name}`} title="Delete client"
                      onClick={(e) => { e.stopPropagation(); onDelete(c, mine.length); }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
                    </button>
                  )}
                  <svg className="cl-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
                </span>
              </div>
            );
          })}
        </div>
        )}
      </div>
    </>
  );
}

export default function ClientsPage() {
  const d = useClientsData();
  const {
    clients, projects, projectTypes, roles, blueprints, usage, units,
    showForm, setShowForm, detailClient, setDetailClient, editing, setEditing,
    handoffId, soldSummary, loadAll,
    saveClientProject, deleteProject, openNewProject,
  } = d;

  // Deleting a client cascades to its projects, so the confirmation is sized to
  // the damage. This flow is clients-only, so it lives here, not in the hook.
  const [deleteTarget, setDeleteTarget] = useState<{ client: Client; count: number } | null>(null);
  const [deleteTyped, setDeleteTyped] = useState("");
  const [deleteImpact, setDeleteImpact] = useState<{ invoices: number; entries: number } | null>(null);

  const askDeleteClient = async (c: Client, count: number) => {
    setDeleteTyped("");
    setDeleteImpact(null);
    setDeleteTarget({ client: c, count });
    const { data: ps } = await supabase.from("projects").select("id").eq("client_id", c.id);
    const ids = (ps ?? []).map((x: any) => x.id);
    if (!ids.length) { setDeleteImpact({ invoices: 0, entries: 0 }); return; }
    const inv = await supabase.from("invoices").select("id", { count: "exact", head: true }).in("project_id", ids);
    const ent = await supabase.from("calendar_entries").select("id", { count: "exact", head: true }).in("project_id", ids);
    setDeleteImpact({ invoices: inv.count ?? 0, entries: ent.count ?? 0 });
  };

  const doDeleteClient = async () => {
    if (!deleteTarget) return;
    const { error } = await supabase.from("clients").delete().eq("id", deleteTarget.client.id);
    if (error) { alert(`Could not delete client: ${error.message}`); return; }
    setDeleteTarget(null);
    setDetailClient((cur) => (cur && cur.id === deleteTarget.client.id ? null : cur));
    await loadAll();
  };

  return (
    <div className="cl">
      <header className="cl-bar">
        <div className="cl-bar-left">
          <h1 className="cl-title">Clients</h1>
        </div>
        <div className="cl-actions">
          <button className="cl-primary" onClick={() => setShowForm(true)}>+ New client</button>
        </div>
      </header>

      <ClientList
        clients={clients}
        projects={projects}
        projectTypes={projectTypes}
        onNew={() => setShowForm(true)}
        onOpen={(c) => setDetailClient(c)}
        onDelete={askDeleteClient}
        usage={usage}
        units={units}
      />

      {detailClient && (
        <ClientWorkspace
          client={detailClient}
          projects={projects.filter((p) => p.clientId === detailClient.id)}
          projectTypes={projectTypes}
          usage={usage}
          onOpenProject={(p) => setEditing({ client: detailClient, project: p })}
          onNewProject={() => openNewProject(detailClient)}
          onDeleteProject={deleteProject}
          onClose={() => setDetailClient(null)}
        />
      )}

      {showForm && (
        <NewClientForm
          onSave={saveClientProject}
          onClose={() => setShowForm(false)}
          roles={roles}
          projectTypes={projectTypes}
          blueprints={blueprints}
        />
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

      {deleteTarget && (
        <div className="cl-del-backdrop" onMouseDown={() => setDeleteTarget(null)}>
          <div className="cl-del" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="cl-del-title">Delete {deleteTarget.client.name}?</h3>
            {deleteTarget.count === 0 ? (
              <p className="cl-del-text">This client has no projects. Deleting it cannot be undone.</p>
            ) : (
              <>
                <p className="cl-del-text">
                  This permanently deletes <b>{deleteTarget.count} project{deleteTarget.count === 1 ? "" : "s"}</b>
                  {deleteImpact === null ? " and everything invoiced against them"
                    : deleteImpact.invoices > 0
                      ? <> and <b>{deleteImpact.invoices} invoice{deleteImpact.invoices === 1 ? "" : "s"}</b></>
                      : " (no invoices yet)"}. This cannot be undone.
                </p>
                {deleteImpact !== null && deleteImpact.entries > 0 && (
                  <p className="cl-del-note">
                    {deleteImpact.entries} logged calendar {deleteImpact.entries === 1 ? "entry" : "entries"} will be
                    kept but left without a project, so they stop counting towards backlog and bonus.
                  </p>
                )}
                <label className="cl-del-confirm">
                  <span>Type <b>{deleteTarget.client.name}</b> to confirm</span>
                  <input value={deleteTyped} autoFocus onChange={(e) => setDeleteTyped(e.target.value)} />
                </label>
              </>
            )}
            <div className="cl-del-actions">
              <button className="cl-del-cancel" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="cl-del-go"
                disabled={deleteTarget.count > 0 && deleteTyped.trim() !== deleteTarget.client.name}
                onClick={doDeleteClient}>Delete client</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}