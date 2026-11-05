import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Select from "../../../framework/Select";
import { useBackToClose } from "../../../framework/useBackToClose";
import SalesMultiFilter from "../sales/SalesMultiFilter";
import type { Pipeline, Phase } from "../../settings/pipelineApi";
import {
  loadSalesRoles, saveSalesRole, deleteSalesRole, orderPhases, ROLE_COLORS,
  saveVisibility,
  type SalesRole, type RoleScope, type DealScope, type TrackingHandover,
} from "./salesRolesApi";
import { resolvePerms, saveAccessRules, ruleKey, isLockedPerson, type RuleMap, type AccessPerson, type EffectivePerms } from "./salesAccess";
import DealTransfers from "./DealTransfers";
import AccessStudio from "./AccessStudio";
import type { Tracking } from "../sales/salesApi";
import "./SalesRoles.css";

type Draft = Omit<SalesRole, "id"> & { id: string | null };
const blank = (sort: number): Draft => ({ id: null, name: "", color: ROLE_COLORS[sort % ROLE_COLORS.length], members: [], scopes: [], sort });

const jobLabel = (r?: string) => (r ? r.split("_").map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ") : "");
/** Where a job role sits in "Who sees what". */
const jobGroup = (r?: string): number => {
  const x = (r ?? "").toLowerCase();
  if (x === "boss" || (x.endsWith("_manager") && (x.includes("sales") || x.includes("marketing")))) return 0;
  if (x.includes("sales")) return 1;
  if (x.includes("marketing")) return 2;
  return 3;
};
const GROUP_NAME = ["Management", "Sales", "Marketing", "Others with access"];

/**
 * Sales roles (Actions → Sales roles), in two tabs:
 *  - Roles: a group of people and, per pipeline, how far into it they see and
 *    who takes the deal over after that.
 *  - Who sees what: per person, every deal or only the deals they're on.
 * Only bosses, sales managers and marketing managers can change them.
 */
type TransferData = Omit<Parameters<typeof DealTransfers>[0], "canEdit" | "meId" | "roles" | "pipelines" | "phaseByPipe">;

/** Everything "Who sees what" and the access settings page need. */
export interface AccessData {
  rules: RuleMap;
  missing: boolean;
  onRulesChanged: (rules: RuleMap) => void;
  trackings: Tracking[];
  owners: Record<string, string>;
  teams: Record<string, string[]>;
  events: Record<string, string[]>;
  handovers: TrackingHandover[];
}

export default function SalesRolesModal({ canEdit, employees, pipelines, phaseByPipe, access, meId = null, transfer, onClose, onChanged, inline = false }: {
  canEdit: boolean;
  /** Render as a plain block (Settings › Deals page) instead of a drawer. */
  inline?: boolean;
  employees: { id: string; name: string; role?: string; is_superadmin?: boolean }[];
  pipelines: Pipeline[];
  phaseByPipe: Record<string, Phase[]>;
  /** Access rules (Who sees what) and the deals, for the settings page. */
  access?: AccessData;
  meId?: string | null;
  /** The deals and who is on them (Transfers tab). */
  transfer?: TransferData;
  onClose: () => void;
  onChanged: (roles: SalesRole[]) => void;
}) {
  useBackToClose("sales-roles", onClose, !inline);
  const [tab, setTab] = useState<"roles" | "access" | "transfers">("roles");
  const [rules, setRules] = useState<RuleMap>(access?.rules ?? {});
  const visMissing = !access;
  const rulesTableMissing = !!access?.missing;
  const [visBusy, setVisBusy] = useState<string | null>(null);
  const [studio, setStudio] = useState(false);
  const [visQ, setVisQ] = useState("");
  const [roles, setRoles] = useState<SalesRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    const r = await loadSalesRoles();
    setRoles(r.roles); setMissing(r.missing); setLoading(false); onChanged(r.roles);
  };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (access) setRules(access.rules); }, [access?.rules]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- who sees what ---------- */
  const rolesOf = (id: string) => roles.filter((r) => r.members.includes(id));
  const personOf = (e: { id: string; name: string; role?: string; is_superadmin?: boolean }): AccessPerson => ({ id: e.id, name: e.name, role: e.role ?? "", is_superadmin: e.is_superadmin });
  const permsOf = (e: { id: string; name: string; role?: string; is_superadmin?: boolean }): EffectivePerms => resolvePerms(personOf(e), { rules, roles, pipelines, phaseByPipe });
  const accessPeople = useMemo(() => {
    const n = visQ.trim().toLowerCase();
    return employees
      .filter((e) => jobGroup(e.role) < 3 || roles.some((r) => r.members.includes(e.id)) || !!rules[ruleKey("user", e.id)] || permsOf(e).canOpen)
      .filter((e) => !n || e.name.toLowerCase().includes(n))
      .sort((a, b) => jobGroup(a.role) - jobGroup(b.role) || a.name.localeCompare(b.name));
  }, [employees, roles, rules, visQ]); // eslint-disable-line react-hooks/exhaustive-deps
  /** How far this person sees, in words. */
  const reachOf = (p: EffectivePerms): string => {
    if (!p.canOpen) return "No access to Deals";
    const list = Object.entries(p.pipelines);
    if (list.every(([, x]) => x.access && !x.maxPhaseId)) return "Every pipeline, every phase";
    const on = list.filter(([, x]) => x.access);
    if (!on.length) return "No pipelines";
    return on.map(([pid, x]) => `${pipeName(pid)} ${x.maxPhaseId ? `up to ${phaseName(pid, x.maxPhaseId)}` : "(every phase)"}`).join(" · ");
  };
  const setScopeFor = async (id: string, scope: DealScope | null) => {
    if (!access) return;
    const k = ruleKey("user", id);
    const prev = rules;
    const mine = { ...(rules[k] ?? {}) };
    if (scope) mine.scope = scope; else delete mine.scope;
    const next = { ...rules };
    if (Object.keys(mine).length) next[k] = mine; else delete next[k];
    setRules(next); setVisBusy(id); setErr(null);
    const e = rulesTableMissing ? await saveVisibility(id, scope) : await saveAccessRules(next, prev);
    setVisBusy(null);
    if (e) { setRules(prev); setErr(e); return; }
    access.onRulesChanged(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".smf-menu, .dp-pop, .hov-backdrop, .acs-backdrop")) return;
      if (draft) setDraft(null); else if (!inline) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, onClose, inline]);

  const name = (id: string | null) => employees.find((e) => e.id === id)?.name ?? "—";
  const phasesOf = (pid: string) => orderPhases(phaseByPipe[pid] ?? []).filter((p) => !p.sales_outcome);
  const phaseName = (pid: string, id: string | null) => (id ? phasesOf(pid).find((p) => p.id === id)?.name ?? "—" : "every phase");
  const pipeName = (pid: string) => pipelines.find((p) => p.id === pid)?.name ?? "Pipeline";
  const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

  /* ---------- editing ---------- */
  const scopeOf = (pid: string) => draft?.scopes.find((s) => s.pipeline_id === pid) ?? null;
  const setScope = (pid: string, patch: Partial<RoleScope> | null) => setDraft((d) => {
    if (!d) return d;
    const others = d.scopes.filter((s) => s.pipeline_id !== pid);
    if (patch === null) return { ...d, scopes: others };
    const cur = d.scopes.find((s) => s.pipeline_id === pid) ?? { pipeline_id: pid, max_phase_id: null, handover_to: null };
    const next = { ...cur, ...patch };
    if (!next.max_phase_id) next.handover_to = null;            // seeing every phase = nothing to hand over
    return { ...d, scopes: [...others, next].sort((a, b) => pipelines.findIndex((p) => p.id === a.pipeline_id) - pipelines.findIndex((p) => p.id === b.pipeline_id)) };
  });
  const problems = useMemo(() => {
    if (!draft) return [];
    const out: string[] = [];
    if (!draft.name.trim()) out.push("Give the role a name.");
    else if (roles.some((r) => r.id !== draft.id && r.name.trim().toLowerCase() === draft.name.trim().toLowerCase())) out.push("There's already a role with that name.");
    if (!draft.scopes.length) out.push("Pick at least one pipeline the role can see.");
    draft.scopes.forEach((s) => { if (s.handover_to && draft.members.includes(s.handover_to)) out.push(`${pipeName(s.pipeline_id)}: the handover goes to someone in this same role.`); });
    return out;
  }, [draft, roles]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!draft || problems.length) return;
    setBusy(true); setErr(null);
    const r = await saveSalesRole(draft);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setDraft(null); await refresh();
  };
  const remove = async () => {
    if (!draft?.id || !window.confirm(`Delete the role “${draft.name}”? Its people lose its pipeline limits; whether they see all deals or only theirs follows Who sees what.`)) return;
    setBusy(true);
    const e = await deleteSalesRole(draft.id);
    setBusy(false);
    if (e) { setErr(e); return; }
    setDraft(null); await refresh();
  };
  const memberOptions = employees.map((e) => ({ value: e.id, label: e.name }));

  const panel = (
      <div className={`dw srl${inline ? " is-inline" : ""}`} onMouseDown={(e) => e.stopPropagation()} role={inline ? undefined : "dialog"} aria-modal={inline ? undefined : true} aria-label="Sales roles">
        {(!inline || draft) && <div className="dw-head">
          <div>
            <span className="dw-eyebrow">{draft ? (draft.id ? "Edit role" : "New role") : "Configure"}</span>
            <h2 className="dw-title">{draft ? (draft.name.trim() || "Untitled role") : "Sales roles"}</h2>
          </div>
          <button className="dw-x" onClick={draft ? () => setDraft(null) : onClose} aria-label={draft ? "Back to roles" : "Close"}>{draft ? "‹" : "×"}</button>
        </div>}

        {!draft && (
          <div className="srl-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "roles"} className={tab === "roles" ? "is-on" : ""} onClick={() => setTab("roles")}>
              Roles<span>{roles.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "access"} className={tab === "access" ? "is-on" : ""} onClick={() => setTab("access")}>
              Who sees what
            </button>
            {transfer && (
              <button type="button" role="tab" aria-selected={tab === "transfers"} className={tab === "transfers" ? "is-on" : ""} onClick={() => setTab("transfers")}>
                Transfers
              </button>
            )}
          </div>
        )}

        {!draft && tab === "transfers" && transfer ? (
          <div className="dw-body">
            <DealTransfers canEdit={canEdit} meId={meId} roles={roles} pipelines={pipelines} phaseByPipe={phaseByPipe} {...transfer} />
          </div>
        ) : !draft && tab === "access" ? (
          <div className="dw-body">
            <button type="button" className="srl-studio" onClick={() => setStudio(true)}>
              <span className="srl-studio-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></svg></span>
              <span className="srl-studio-txt"><b>Adjust settings</b><small>Pipelines and phases, views, new deals, reports, export, import… by person, sales role or job role.</small></span>
              <svg className="srl-studio-go" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
            </button>
            <p className="srl-intro">
              Quick view: who sees <b>every deal</b> and who sees <b>only the deals they're on</b>, and how far into each pipeline.
            </p>
            {rulesTableMissing && <p className="srl-note">Access settings need a new table — run <code>empower_sales_access.sql</code> in Supabase once.</p>}
            {!canEdit && <p className="srl-note is-soft">Only people with “Sales roles & access” can change this.</p>}
            {accessPeople.length > 8 || visQ ? (
              <input className="srl-search" value={visQ} onChange={(e) => setVisQ(e.target.value)} placeholder="Search people…" aria-label="Search people" />
            ) : null}
            {accessPeople.length === 0 ? <p className="dw-empty-hint">{visQ ? "Nobody matches." : "No sales or marketing people yet."}</p> : (
              <div className="srl-acc">
                {accessPeople.map((e, i) => {
                  const pm = permsOf(e);
                  const sc = pm.scope.value;
                  const locked = isLockedPerson(personOf(e));
                  const custom = !locked && rules[ruleKey("user", e.id)]?.scope !== undefined;
                  const rs = rolesOf(e.id);
                  const head = i === 0 || jobGroup(accessPeople[i - 1].role) !== jobGroup(e.role);
                  return (
                    <div key={e.id} className="srl-acc-item">
                      {head && <p className="srl-acc-group">{GROUP_NAME[jobGroup(e.role)]}</p>}
                      <div className={`srl-acc-row ${visBusy === e.id ? "is-busy" : ""}`} style={{ ["--c" as string]: rs[0]?.color || "#9fb5ab", ["--i" as string]: i } as CSSProperties}>
                        <span className="srl-acc-av">{initials(e.name)}</span>
                        <div className="srl-acc-who">
                          <b>{e.name}{e.id === meId && <em>you</em>}</b>
                          <span className="srl-acc-meta">
                            {jobLabel(e.role) && <span className="srl-acc-job">{jobLabel(e.role)}</span>}
                            {rs.map((r) => <span key={r.id} className="srl-acc-role" style={{ ["--c" as string]: r.color || "#1fb98a" } as CSSProperties}>{r.name}</span>)}
                          </span>
                          <small>{reachOf(pm)}</small>
                        </div>
                        <div className="srl-acc-ctl">
                          {locked ? (
                            <span className="srl-acc-lock" title="The boss always sees every deal">Always all deals</span>
                          ) : (
                            <div className="srl-seg" role="radiogroup" aria-label={`What ${e.name} sees`}>
                              {(["all", "own"] as const).map((v) => (
                                <button key={v} type="button" role="radio" aria-checked={sc === v} className={sc === v ? "is-on" : ""}
                                  disabled={!canEdit || visMissing || visBusy === e.id} onClick={() => sc !== v || !custom ? setScopeFor(e.id, v) : undefined}>
                                  {v === "all" ? "All deals" : "Only theirs"}
                                </button>
                              ))}
                            </div>
                          )}
                          {!locked && (custom ? (
                            canEdit ? <button type="button" className="srl-acc-reset" onClick={() => setScopeFor(e.id, null)} disabled={visBusy === e.id}>Reset to default</button>
                              : <span className="srl-acc-def">Set by hand</span>
                          ) : <span className="srl-acc-def">{pm.scope.source.kind === "default" ? "Default" : `From ${pm.scope.source.label}`}</span>)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="srl-foot-note">Defaults: bosses, sales managers and people with a sales role see all deals; everyone else sees the deals they're on. Everything else is in <b>Adjust settings</b>.</p>
            {err && <p className="dw-err">{err}</p>}
          </div>
        ) : !draft ? (
          <div className="dw-body">
            <p className="srl-intro">
              A role decides <b>which pipelines</b> its people see and <b>up to which phase</b>. When a deal moves past that phase it
              disappears for them, and if you choose someone to take over, the deal is <b>handed over</b> to that person after a double confirmation.
              Whether they see every deal or only theirs is set in <b>Who sees what</b>.
            </p>
            {missing && <p className="srl-note">Sales roles need two new tables — run <code>empower_sales_roles.sql</code> in Supabase once.</p>}
            {!canEdit && !missing && <p className="srl-note is-soft">Only bosses, sales managers and marketing managers can change roles.</p>}

            {loading ? <p className="dw-empty-hint">Loading…</p> : roles.length === 0 ? (
              <div className="srl-empty">
                <span className="srl-empty-art" aria-hidden="true"><i /><i /><i /></span>
                <p>No roles yet.</p>
                <small>Without roles, everyone keeps seeing the deals they're on.</small>
              </div>
            ) : (
              <div className="srl-list">
                {roles.map((r, i) => (
                  <button key={r.id} type="button" className="srl-card" style={{ ["--c" as string]: r.color || ROLE_COLORS[i % ROLE_COLORS.length], ["--i" as string]: i } as CSSProperties}
                    onClick={() => canEdit && setDraft({ ...r })} disabled={!canEdit}>
                    <span className="srl-card-top">
                      <span className="srl-dot" />
                      <b>{r.name}</b>
                      <span className="srl-avs">
                        {r.members.slice(0, 5).map((m) => <i key={m} title={name(m)}>{initials(name(m))}</i>)}
                        {r.members.length > 5 && <i className="is-more">+{r.members.length - 5}</i>}
                        {r.members.length === 0 && <em>nobody yet</em>}
                      </span>
                    </span>
                    <span className="srl-scopes">
                      {r.scopes.map((s) => (
                        <span key={s.pipeline_id} className="srl-scope">
                          <b>{pipeName(s.pipeline_id)}</b>
                          <span>up to {phaseName(s.pipeline_id, s.max_phase_id)}</span>
                          {s.handover_to && <span className="srl-to">→ {name(s.handover_to)}</span>}
                        </span>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {canEdit && !missing && (
              <button className="dw-save srl-new" onClick={() => setDraft(blank(roles.length))}>+ New role</button>
            )}
          </div>
        ) : (
          <div className="dw-body">
            <div className="dw-sec">
              <p className="dw-sec-title">Role</p>
              <div className="dw-grid">
                <div className="dw-f dw-col2"><label>Name</label>
                  <input value={draft.name} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Marketing, SDR, Account executive" />
                </div>
                <div className="dw-f dw-col2"><label>Colour</label>
                  <div className="srl-colors">
                    {ROLE_COLORS.map((c) => (
                      <button key={c} type="button" className={draft.color === c ? "is-on" : ""} style={{ ["--c" as string]: c } as CSSProperties}
                        onClick={() => setDraft({ ...draft, color: c })} aria-label={`Colour ${c}`} />
                    ))}
                  </div>
                </div>
                <div className="dw-f dw-col2"><label>People in this role</label>
                  <SalesMultiFilter values={draft.members} onChange={(v) => setDraft({ ...draft, members: v })} options={memberOptions}
                    placeholder="Pick people…" noun="people" searchFrom={6} />
                  {draft.members.length > 0 && (
                    <div className="srl-chips">
                      {draft.members.map((m) => (
                        <span key={m}>{name(m)}<button type="button" onClick={() => setDraft({ ...draft, members: draft.members.filter((x) => x !== m) })} aria-label={`Remove ${name(m)}`}>×</button></span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="dw-sec">
              <p className="dw-sec-title">What it sees</p>
              {pipelines.length === 0 && <p className="dw-empty-hint">There are no sales pipelines yet.</p>}
              <div className="srl-pipes">
                {pipelines.map((p) => {
                  const sc = scopeOf(p.id);
                  const phs = phasesOf(p.id);
                  return (
                    <div key={p.id} className={`srl-pipe ${sc ? "is-on" : ""}`}>
                      <div className="srl-pipe-head">
                        <button type="button" role="switch" aria-checked={!!sc} className={`dw-switch ${sc ? "on" : ""}`}
                          onClick={() => setScope(p.id, sc ? null : {})}><span className="dw-switch-knob" /></button>
                        <b>{p.name}</b>
                        <span>{sc ? (sc.max_phase_id ? `up to ${phaseName(p.id, sc.max_phase_id)}` : "every phase") : "can't see it"}</span>
                      </div>
                      {sc && (
                        <div className="srl-pipe-body">
                          <div className="srl-ladder" aria-hidden="true">
                            {phs.map((ph, i) => {
                              const lim = sc.max_phase_id ? phs.findIndex((x) => x.id === sc.max_phase_id) : phs.length - 1;
                              return <i key={ph.id} className={i <= lim ? "is-in" : ""} title={ph.name}><span>{ph.name}</span></i>;
                            })}
                          </div>
                          <div className="dw-grid">
                            <div className="dw-f"><label>Sees deals up to</label>
                              <Select value={sc.max_phase_id ?? ""} onChange={(v) => setScope(p.id, { max_phase_id: v || null })}
                                options={[{ value: "", label: "Every phase" }, ...phs.map((ph) => ({ value: ph.id, label: ph.name }))]} />
                            </div>
                            <div className="dw-f"><label>{sc.max_phase_id ? `After ${phaseName(p.id, sc.max_phase_id)}, hand over to` : "Hand over to"}</label>
                              <Select value={sc.handover_to ?? ""} onChange={(v) => setScope(p.id, { handover_to: v || null })} disabled={!sc.max_phase_id}
                                options={[{ value: "", label: sc.max_phase_id ? "Nobody (it just disappears)" : "Pick a last phase first" }, ...employees.filter((e) => !draft.members.includes(e.id)).map((e) => ({ value: e.id, label: e.name }))]} />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {problems.length > 0 && <ul className="srl-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            {err && <p className="dw-err">{err}</p>}
          </div>
        )}

        {draft && (
          <div className="dw-foot">
            {draft.id && <button className="srl-del" onClick={remove} disabled={busy}>Delete role</button>}
            <div className="dw-foot-right">
              <button className="dw-cancel" onClick={() => setDraft(null)}>Cancel</button>
              <button className="dw-save" onClick={save} disabled={busy || problems.length > 0}>{busy ? "Saving…" : draft.id ? "Save role" : "Create role"}</button>
            </div>
          </div>
        )}
        {studio && access && (
          <AccessStudio
            people={employees.map(personOf)} roles={roles} pipelines={pipelines} phaseByPipe={phaseByPipe}
            rules={rules} rulesMissing={rulesTableMissing}
            trackings={access.trackings} owners={access.owners} teams={access.teams} events={access.events} handovers={access.handovers}
            canEdit={canEdit} meId={meId}
            onClose={() => setStudio(false)}
            onSaved={(r, rs) => { setRules(r); access.onRulesChanged(r); setRoles(rs); onChanged(rs); }}
          />
        )}
      </div>
  );
  if (inline) return panel;
  return (
    <div className="dw-backdrop srl-backdrop" onMouseDown={onClose}>
      {panel}
    </div>
  );
}