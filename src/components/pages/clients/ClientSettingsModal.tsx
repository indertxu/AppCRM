import { useEffect, useState } from "react";
import Select from "../../framework/Select";
import { supabase } from "../../api/supabase";
import type {
  ProjectType, Blueprint, BlueprintPhase, ClientRole,
} from "./ClientsPage";

const uid = () => crypto.randomUUID();
const Chevron = ({ dir }: { dir: "right" | "up" }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {dir === "right" ? <path d="M9 6l6 6-6 6" /> : <path d="M6 15l6-6 6 6" />}
  </svg>
);

interface Props {
  projectTypes: ProjectType[];
  setProjectTypes: React.Dispatch<React.SetStateAction<ProjectType[]>>;
  blueprints: Blueprint[];
  setBlueprints: React.Dispatch<React.SetStateAction<Blueprint[]>>;
  roles: ClientRole[];
  setRoles: React.Dispatch<React.SetStateAction<ClientRole[]>>;
  onClose: () => void;
}

export default function ClientSettingsModal({
  projectTypes, setProjectTypes, blueprints, setBlueprints, roles, setRoles, onClose,
}: Props) {
  const [tab, setTab] = useState<"types" | "blueprints" | "roles">("types");
  const [newType, setNewType] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [openRoleId, setOpenRoleId] = useState<string | null>(null);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(({ data }) => {
      type U = { id: string; first_name?: string | null; last_name?: string | null; username?: string | null; email?: string | null };
      setUsers(((data?.users ?? []) as U[]).map((u) => ({
        id: u.id,
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—",
      })));
    });
  }, []);

  const userName = (id: string) => users.find((u) => u.id === id)?.name ?? "—";

  // Project types
  const addType = () => {
    if (!newType.trim()) return;
    setProjectTypes((t) => [...t, { id: uid(), name: newType.trim() }]);
    setNewType("");
  };
  const renameType = (id: string, name: string) =>
    setProjectTypes((t) => t.map((x) => (x.id === id ? { ...x, name } : x)));
  const removeType = (id: string) => setProjectTypes((t) => t.filter((x) => x.id !== id));

  // Roles
  const addRole = () => {
    const id = uid();
setRoles((r) => [...r, { id, name: "", userIds: [], isSupervision: false }]);
    setOpenRoleId(id);
  };
  const patchRole = (id: string, patch: Partial<ClientRole>) =>
    setRoles((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeRole = (id: string) => {
    setRoles((r) => r.filter((x) => x.id !== id));
    if (openRoleId === id) setOpenRoleId(null);
  };
  const addPerson = (roleId: string, userId: string) =>
    setRoles((r) => r.map((x) => x.id !== roleId || x.userIds.includes(userId) ? x
      : { ...x, userIds: [...x.userIds, userId] }));
  const removePerson = (roleId: string, userId: string) =>
    setRoles((r) => r.map((x) => x.id !== roleId ? x
      : { ...x, userIds: x.userIds.filter((u) => u !== userId) }));

  // Blueprints
  const addBlueprint = () => {
    const id = uid();
    setBlueprints((b) => [...b, { id, name: "", projectTypeId: "", phases: [] }]);
    setOpenId(id);
  };
  const patchBp = (bpId: string, patch: Partial<Blueprint>) =>
    setBlueprints((b) => b.map((x) => (x.id === bpId ? { ...x, ...patch } : x)));
  const removeBp = (bpId: string) => {
    setBlueprints((b) => b.filter((x) => x.id !== bpId));
    if (openId === bpId) setOpenId(null);
  };
  const addPhase = (bpId: string) =>
    setBlueprints((b) => b.map((x) => x.id !== bpId ? x
      : { ...x, phases: [...x.phases, { id: uid(), name: "", percent: 0, tasks: [] }] }));
  const patchPhase = (bpId: string, phId: string, patch: Partial<BlueprintPhase>) =>
    setBlueprints((b) => b.map((x) => x.id !== bpId ? x
      : { ...x, phases: x.phases.map((p) => (p.id === phId ? { ...p, ...patch } : p)) }));
  const removePhase = (bpId: string, phId: string) =>
    setBlueprints((b) => b.map((x) => x.id !== bpId ? x
      : { ...x, phases: x.phases.filter((p) => p.id !== phId) }));
  const addTask = (bpId: string, phId: string) =>
    setBlueprints((b) => b.map((x) => x.id !== bpId ? x
      : { ...x, phases: x.phases.map((p) => p.id !== phId ? p
        : { ...p, tasks: [...p.tasks, { id: uid(), name: "", percent: 0 }] }) }));
  const patchTask = (bpId: string, phId: string, tId: string, name: string) =>
    setBlueprints((b) => b.map((x) => x.id !== bpId ? x
      : { ...x, phases: x.phases.map((p) => p.id !== phId ? p
        : { ...p, tasks: p.tasks.map((t) => (t.id === tId ? { ...t, name } : t)) }) }));
  const removeTask = (bpId: string, phId: string, tId: string) =>
    setBlueprints((b) => b.map((x) => x.id !== bpId ? x
      : { ...x, phases: x.phases.map((p) => p.id !== phId ? p
        : { ...p, tasks: p.tasks.filter((t) => t.id !== tId) }) }));

  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name;

  return (
    <div className="cs-backdrop" onMouseDown={onClose}>
      <div className="cs-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="cs-head">
          <div>
            <span className="cs-eyebrow">Client settings</span>
            <h2 className="cs-title">Projects, blueprints & roles</h2>
          </div>
          <button className="su-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="cs-tabs">
          <button className={`cl-tab ${tab === "types" ? "is-active" : ""}`} onClick={() => setTab("types")}>Project types</button>
          <button className={`cl-tab ${tab === "blueprints" ? "is-active" : ""}`} onClick={() => setTab("blueprints")}>Phase blueprints</button>
          <button className={`cl-tab ${tab === "roles" ? "is-active" : ""}`} onClick={() => setTab("roles")}>Roles</button>
        </div>

        <div className="cs-body">
          {tab === "types" && (
            <div className="cs-types">
              <div className="cs-add-row">
                <input className="cl-input" placeholder="e.g. Consolidation" value={newType}
                  onChange={(e) => setNewType(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addType()} />
                <button className="cl-primary" onClick={addType}>Add</button>
              </div>
              {projectTypes.length === 0 && <p className="cl-hint">No project types yet.</p>}
              <div className="cs-type-list">
                {projectTypes.map((t) => (
                  <div className="cs-type" key={t.id}>
                    <input className="cl-input" value={t.name} onChange={(e) => renameType(t.id, e.target.value)} />
                    <button className="cl-remove" onClick={() => removeType(t.id)} aria-label="Remove">×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "roles" && (
            <div className="cs-roles">
              <button className="cl-add cs-add-bp" onClick={addRole}>+ New role</button>
              {roles.length === 0 && <p className="cl-hint">No roles yet.</p>}
              {roles.map((role) => {
                if (openRoleId !== role.id) {
                  return (
                    <button className="cs-bp-row" key={role.id} onClick={() => setOpenRoleId(role.id)}>
                      <div className="cs-bp-row-main">
                        <span className="cs-bp-row-name">{role.name || "Untitled role"}</span>
                        <span className="cs-bp-row-type">{role.userIds.length} {role.userIds.length === 1 ? "person" : "people"}</span>
                      </div>
                      <Chevron dir="right" />
                    </button>
                  );
                }
                const unassigned = users.filter((u) => !role.userIds.includes(u.id));
                return (
                  <div className="cs-bp" key={role.id}>
                    <button className="cs-bp-bar" onClick={() => setOpenRoleId(null)}>
                      <span>{role.name || "Untitled role"}</span>
                      <Chevron dir="up" />
                    </button>
                    <div className="cs-role-head">
                      <input className="cl-input" placeholder="Role name (e.g. Main consultor)" value={role.name}
                        onChange={(e) => patchRole(role.id, { name: e.target.value })} />
                      <button className="cl-remove" onClick={() => removeRole(role.id)} aria-label="Remove role">×</button>
                    </div>
<div className="ncm-tax-row" style={{ marginBottom: 12 }}>
                      <span className="ncm-tax-label">Paid at supervision rate</span>
                      <button type="button" role="switch" aria-checked={role.isSupervision}
                        className={`ncm-switch ${role.isSupervision ? "on" : ""}`}
                        onClick={() => patchRole(role.id, { isSupervision: !role.isSupervision })}>
                        <span className="ncm-switch-knob" />
                      </button>
                    </div>

                    <div className="cs-chips">
                      {role.userIds.length === 0 && <span className="cl-hint">No people assigned.</span>}
                      {role.userIds.map((uidv) => (
                        <span className="cs-chip" key={uidv}>
                          {userName(uidv)}
                          <button onClick={() => removePerson(role.id, uidv)} aria-label="Remove person">×</button>
                        </span>
                      ))}
                    </div>
                    <div className="cs-role-add">
                      <Select value="" onChange={(v) => v && addPerson(role.id, v)}
                        options={unassigned.map((u) => ({ value: u.id, label: u.name }))} placeholder="+ Assign person" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === "blueprints" && (
            <div className="cs-blueprints">
              <button className="cl-add cs-add-bp" onClick={addBlueprint}>+ New blueprint</button>
              {blueprints.length === 0 && <p className="cl-hint">No blueprints yet.</p>}

              {blueprints.map((bp) => {
                const phaseTotal = bp.phases.reduce((s, p) => s + (Number(p.percent) || 0), 0);

                if (openId !== bp.id) {
                  return (
                    <button className="cs-bp-row" key={bp.id} onClick={() => setOpenId(bp.id)}>
                      <div className="cs-bp-row-main">
                        <span className="cs-bp-row-name">{bp.name || "Untitled blueprint"}</span>
                        <span className="cs-bp-row-type">{typeName(bp.projectTypeId) ?? "No project type"}</span>
                      </div>
                      <span className={`cs-total ${phaseTotal === 100 ? "ok" : ""}`}>{phaseTotal}%</span>
                      <Chevron dir="right" />
                    </button>
                  );
                }

                return (
                  <div className="cs-bp" key={bp.id}>
                    <button className="cs-bp-bar" onClick={() => setOpenId(null)}>
                      <span>{bp.name || "Untitled blueprint"}</span>
                      <Chevron dir="up" />
                    </button>

                    <div className="cs-bp-top">
                      <div className="cs-field cs-field-grow">
                        <label>Blueprint name</label>
                        <input className="cl-input" placeholder="e.g. Standard consolidation" value={bp.name} onChange={(e) => patchBp(bp.id, { name: e.target.value })} />
                      </div>
                      <div className="cs-field cs-field-type">
                        <label>Project type</label>
                        <Select value={bp.projectTypeId} onChange={(v) => patchBp(bp.id, { projectTypeId: v })}
                          options={projectTypes.map((t) => ({ value: t.id, label: t.name }))} placeholder="Link to project" />
                      </div>
                      <button className="cl-remove cs-bp-del" onClick={() => removeBp(bp.id)} aria-label="Remove blueprint">×</button>
                    </div>

                    <div className="cs-phases-head">
                      <span className="cs-label">Phases</span>
                      <span className={`cs-total ${phaseTotal === 100 ? "ok" : ""}`}>{phaseTotal}% / 100</span>
                    </div>

                    {bp.phases.length === 0 && <p className="cl-hint cs-empty">No phases yet — add the first one below.</p>}

                    {bp.phases.map((ph, i) => (
                      <div className="cs-phase" key={ph.id}>
                        <div className="cs-phase-head">
                          <span className="cs-phase-num">{i + 1}</span>
                          <input className="cl-input cs-phase-name" placeholder="Phase name" value={ph.name} onChange={(e) => patchPhase(bp.id, ph.id, { name: e.target.value })} />
                          <div className="cs-pct-wrap">
                            <input type="number" min="0" max="100" className="cl-input cs-pct" value={ph.percent} onChange={(e) => patchPhase(bp.id, ph.id, { percent: Number(e.target.value) || 0 })} />
                            <span className="cs-pct-sign">%</span>
                          </div>
                          <button className="cl-remove" onClick={() => removePhase(bp.id, ph.id)} aria-label="Remove phase">×</button>
                        </div>
                        <div className="cs-tasks">
                          {ph.tasks.map((t) => (
                            <div className="cs-task" key={t.id}>
                              <span className="cs-task-dot" />
                              <input className="cl-input" placeholder="Task name" value={t.name} onChange={(e) => patchTask(bp.id, ph.id, t.id, e.target.value)} />
                              <button className="cl-remove" onClick={() => removeTask(bp.id, ph.id, t.id)} aria-label="Remove task">×</button>
                            </div>
                          ))}
                          <div className="cs-task-foot">
                            <button className="cl-add" onClick={() => addTask(bp.id, ph.id)}>+ Add task</button>
                          </div>
                        </div>
                      </div>
                    ))}
                    <button className="cl-add cs-add-phase" onClick={() => addPhase(bp.id)}>+ Add phase</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="cs-foot">
          {tab === "blueprints" && openId ? (
            <button className="cl-primary" onClick={() => setOpenId(null)}>Done editing</button>
          ) : tab === "roles" && openRoleId ? (
            <button className="cl-primary" onClick={() => setOpenRoleId(null)}>Done editing</button>
          ) : (
            <button className="cl-primary" onClick={onClose}>Done</button>
          )}
        </div>
      </div>
    </div>
  );
}