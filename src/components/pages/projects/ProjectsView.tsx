import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type MouseEvent as RMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { Client, Project, ProjectType, ClientRole, Blueprint } from "../clients/clientsTypes";
import { projectValue, legacyRoleMap, resolvedLinesOf, roleNameOf, roleColor, roleCounts } from "../clients/clientsTypes";
import Select from "../../framework/Select";
import { supabase } from "../../api/supabase";

export type Usage = Record<string, { done: number; booked: number }>;
export type ProjectsViewMode = "list" | "canvas";

interface Props {
  clients: Client[];
  projects: Project[];
  projectTypes: ProjectType[];
  usage: Usage;
  /** Every role, to name and colour each project's role lines. */
  roles: ClientRole[];
  onOpenProject: (c: Client, p: Project) => void;
  onReopen: (p: Project) => void;
  onClose_: (p: Project) => void;
  /** List of cards or the phase canvas (blueprints). */
  view?: ProjectsViewMode;
  /** The services' phase blueprints (order of the canvas columns). */
  blueprints?: Blueprint[];
}

type Sort = "recent" | "value" | "days" | "progress" | "left";

export default function ProjectsView({
  clients, projects, projectTypes, usage, roles, onOpenProject, onReopen, onClose_, view = "list", blueprints = [],
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const activity = useProjectActivity(projects);
  const [q, setQ] = useState("");
  const [fClient, setFClient] = useState("");
  const [fType, setFType] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fConsultant, setFConsultant] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  /** Rate unit per service: a project reads in hours or days as its service says. */
  const [units, setUnits] = useState<Record<string, "hour" | "day">>({});
  useEffect(() => {
    supabase.from("services").select("id, rate_unit").then(({ data }) => {
      const out: Record<string, "hour" | "day"> = {};
      (data ?? []).forEach((r: any) => { out[r.id] = r.rate_unit === "hour" ? "hour" : "day"; });
      setUnits(out);
    });
  }, []);
  const unitOf = (p: Project) => (units[p.projectTypeId] === "hour" ? "h" : "d");

  // Names for the consultant filter — TeamMember.name is often empty, so resolve
  // ids to names from the people list.
  const [people, setPeople] = useState<Record<string, string>>({});
  useEffect(() => {
    supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(({ data }: any) => {
      const out: Record<string, string> = {};
      ((data?.users ?? []) as any[]).forEach((u) => {
        out[u.id] = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—";
      });
      setPeople((cur) => ({ ...cur, ...out }));
    }).catch(() => {});
    // Also from the profiles (names of people who logged time but aren't listed above)
    supabase.from("profiles").select("id, first_name, last_name, email").then(({ data }: any) => {
      const out: Record<string, string> = {};
      ((data ?? []) as any[]).forEach((u) => { out[u.id] = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || ""; });
      setPeople((cur) => ({ ...out, ...cur }));
    });
  }, []);
  const personName = (id: string, fallback?: string) => people[id] || (fallback && fallback !== "—" ? fallback : "") || "Unknown";

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "—";
  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";

  const legacy = useMemo(() => legacyRoleMap(roles), [roles]);
  /** The project's roles with what was sold and what is done / booked on each.
   *  A role with time logged but not sold on the project shows too (0 sold). */
  const roleRowsOf = (p: Project) => {
    const lines = resolvedLinesOf(p, legacy);
    const rows = lines.map((l) => ({ roleId: l.roleId, signed: l.days, done: 0, booked: 0 }));
    const prefix = `${p.id}|`;
    for (const [k, u] of Object.entries(usage)) {
      if (!k.startsWith(prefix)) continue;
      const roleId = k.slice(prefix.length);
      let r = rows.find((x) => x.roleId === roleId);
      if (!r) { r = { roleId, signed: 0, done: 0, booked: 0 }; rows.push(r); }
      r.done += u.done; r.booked += u.booked;
    }
    return rows;
  };
  const totalSigned = (p: Project) => roleRowsOf(p).reduce((s, r) => s + r.signed, 0);
  const totalUsed = (p: Project) => roleRowsOf(p).reduce((s, r) => s + r.done, 0);
  const totalBooked = (p: Project) => roleRowsOf(p).reduce((s, r) => s + r.booked, 0);
  const progressOf = (p: Project) => {
    const t = totalSigned(p);
    return t > 0 ? (totalUsed(p) / t) * 100 : 0;
  };
  const leftOf = (p: Project) => totalSigned(p) - totalUsed(p) - totalBooked(p);

  // People who appear on at least one project's team, for the consultant filter.
  const consultantOptions = useMemo(() => {
    const byId = new Map<string, string>();
    projects.forEach((p) => (p.team ?? []).forEach((m) => {
      if (m.userId && !byId.has(m.userId)) byId.set(m.userId, personName(m.userId, m.name));
    }));
    return Array.from(byId, ([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, people]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = projects.filter((p) => {
      if (fClient && p.clientId !== fClient) return false;
      if (fType && p.projectTypeId !== fType) return false;
      if (fStatus === "open" && p.status === "closed") return false;
      if (fStatus === "closed" && p.status !== "closed") return false;
      if (fStatus === "over" && leftOf(p) >= 0) return false;
      if (fStatus === "complete" && progressOf(p) < 100) return false;
      if (fConsultant && !(p.team ?? []).some((m) => m.userId === fConsultant)) return false;
      if (!needle) return true;
      return (
        clientName(p.clientId).toLowerCase().includes(needle) ||
        typeName(p.projectTypeId).toLowerCase().includes(needle) ||
        (p.legalName ?? "").toLowerCase().includes(needle) ||
        (p.vatNumber ?? "").toLowerCase().includes(needle)
      );
    });

    return list.sort((a, b) => {
      if (sort === "value") return projectValue(b) - projectValue(a);
      if (sort === "days") return totalSigned(b) - totalSigned(a);
      if (sort === "progress") return progressOf(b) - progressOf(a);
      if (sort === "left") return leftOf(a) - leftOf(b);
      const s = (a.status === "closed" ? 1 : 0) - (b.status === "closed" ? 1 : 0);
      if (s !== 0) return s;
      return (b.kickoffDate || "").localeCompare(a.kickoffDate || "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, usage, q, fClient, fType, fStatus, fConsultant, sort, clients, projectTypes]);

  const sumValue = shown.reduce((s, p) => s + projectValue(p), 0);
  // Days and hours are different units, so they are counted apart.
  const signedSplit = shown.reduce((acc, p) => {
    const k = units[p.projectTypeId] === "hour" ? "hours" : "days";
    acc[k] += totalSigned(p);
    return acc;
  }, { days: 0, hours: 0 });
  const sumDays = shown.reduce((s, p) => s + totalSigned(p), 0);
  const sumBilled = shown.reduce((s, p) => s + totalUsed(p), 0);

  // Uses sumBilled, so it has to come after it.
  const pctDone = sumDays > 0 ? Math.round((sumBilled / sumDays) * 100) : 0;

  const clearAll = () => { setQ(""); setFClient(""); setFType(""); setFStatus(""); setFConsultant(""); setSort("recent"); };
  const anyFilter = !!(q || fClient || fType || fStatus || fConsultant || sort !== "recent");

  return (
    <>
<div className="pv-bar">
        <div className="pv-search">
          <span className="pv-search-ico" aria-hidden="true">⌕</span>
          <input
            className="pv-search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search client, service, VAT…"
          />
          {q && <button className="pv-search-x" onClick={() => setQ("")} aria-label="Clear">×</button>}
        </div>

        <div className="pv-filter">
          <Select
            value={fClient}
            onChange={setFClient}
            options={[{ value: "", label: "All clients" }, ...clients.map((c) => ({ value: c.id, label: c.name }))]}
            placeholder="All clients"
          />
        </div>
        <div className="pv-filter">
          <Select
            value={fType}
            onChange={setFType}
            options={[{ value: "", label: "All services" }, ...projectTypes.map((t) => ({ value: t.id, label: t.name }))]}
            placeholder="All services"
          />
        </div>
        <div className="pv-filter">
          <Select
            value={fStatus}
            onChange={setFStatus}
            options={[
              { value: "", label: "Any status" },
              { value: "open", label: "Open" },
              { value: "closed", label: "Finalized" },
              { value: "complete", label: "Fully delivered" },
              { value: "over", label: "Over budget" },
            ]}
            placeholder="Any status"
          />
        </div>
        <div className="pv-filter">
          <Select
            value={fConsultant}
            onChange={setFConsultant}
            options={[{ value: "", label: "All consultants" }, ...consultantOptions]}
            placeholder="All consultants"
          />
        </div>
        <div className="pv-filter">
          <Select
            value={sort}
            onChange={(v) => setSort(v as Sort)}
            options={[
              { value: "recent", label: "Most recent" },
              { value: "value", label: "Highest value" },
              { value: "days", label: "Most days" },
              { value: "progress", label: "Most delivered" },
              { value: "left", label: "Least days left" },
            ]}
          />
        </div>

        {anyFilter && <button className="pv-clear" onClick={clearAll}>Clear</button>}
      </div>

      <div className="cl-kpis">
        <div className="cl-kpi">
          <span className="cl-kpi-k">Projects</span>
          <b className="cl-kpi-v">{shown.length}</b>
          <span className="cl-kpi-sub">{shown.filter((p) => p.status !== "closed").length} still open</span>
        </div>
        <div className="cl-kpi">
          <span className="cl-kpi-k">Signed</span>
          <b className="cl-kpi-v">
            {signedSplit.days.toLocaleString()}<em>d</em>
            {signedSplit.hours > 0 && <><span className="cl-kpi-plus">/</span>{signedSplit.hours.toLocaleString()}<em>h</em></>}
          </b>
          <span className="cl-kpi-sub">committed to deliver</span>
        </div>
        <div className="cl-kpi">
          <span className="cl-kpi-k">Delivered</span>
          <b className="cl-kpi-v">{pctDone}<em>%</em></b>
          <span className="cl-kpi-meter"><i style={{ width: `${pctDone}%` }} /></span>
        </div>
        <div className="cl-kpi cl-kpi-money">
          <span className="cl-kpi-k">Contract value</span>
          <b className="cl-kpi-v">{Math.round(sumValue).toLocaleString()}<em>€</em></b>
          <span className="cl-kpi-sub">across {shown.length} project{shown.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="cl-hint">No projects match those filters.</p>
      ) : view === "canvas" ? (
        <ProjectCanvas projects={shown} activity={activity} blueprints={blueprints} projectTypes={projectTypes}
          clientName={clientName} typeName={typeName} personName={personName} progressOf={progressOf} onOpen={(p) => setOpenId(p.id)} />
      ) : (
        <div className="pv-scroll">
        <div className="pv-list">
          <div className="pv-hrow">
            <span>Project</span>
            <span>Dates</span>
            <span>Roles · done / sold</span>
            <span className="pv-right">Value</span>
            <span />
          </div>

          {shown.map((p) => {
            const closed = p.status === "closed";
            return (
              <div className={`pv-row is-clickable ${closed ? "is-closed" : ""}`} key={p.id} role="button" tabIndex={0}
                style={{ ["--i" as any]: Math.min(shown.indexOf(p), 14) } as CSSProperties}
                onClick={(e) => { if ((e.target as HTMLElement).closest("button, a, input")) return; setOpenId(p.id); }}
                onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) setOpenId(p.id); }}>
                <div className="pv-cell pv-cell-id">
                  <span className="pv-client">{clientName(p.clientId)}</span>
                  <span className="pv-type">
                    {typeName(p.projectTypeId)}
                    <i className={`pv-dot-status ${closed ? "is-closed" : ""}`} />
                    {closed ? "closed" : "open"}
                  </span>
                </div>

                <div className="pv-cell pv-cell-dates">
                  <span><em>Kick</em>{p.kickoffDate || "—"}</span>
                  <span><em>End</em>{p.endDate || "—"}</span>
                </div>

                <div className="pv-cell pv-cell-roles">
                  {(() => {
                    const rows = roleRowsOf(p);
                    if (!rows.length) return <span className="pv-none">No roles sold</span>;
                    return rows.map((r) => {
                      const left = +(r.signed - r.done - r.booked).toFixed(2);
                      const pct = (n: number) => (r.signed > 0 ? Math.min(100, (n / r.signed) * 100) : n > 0 ? 100 : 0);
                      const at = roles.findIndex((x) => x.id === r.roleId);
                      const counts = roleCounts(r.roleId, roles);
                      return (
                        <div className={`pv-role ${counts ? "" : "is-nocount"}`} key={r.roleId} style={{ ["--c" as any]: roleColor(roles[at], at < 0 ? 0 : at) }}
                          title={counts ? undefined : "Doesn't count for the consultant's billing"}>
                          <span className="pv-role-nm"><i />{roleNameOf(r.roleId, roles)}</span>
                          <div className="pv-track">
                            <div className="pv-fill" style={{ width: `${pct(r.done + r.booked)}%` }} />
                            <div className="pv-fill is-done" style={{ width: `${pct(r.done)}%` }} />
                          </div>
                          <span className="pv-figs">
                            <b>{+r.done.toFixed(2)}</b>/{r.signed}{unitOf(p)}
                            <i className={left < 0 ? "is-over" : ""}>
                              {left < 0 ? `${Math.abs(left).toFixed(2)}${unitOf(p)} over` : `${left.toFixed(2)}${unitOf(p)} left`}
                            </i>
                          </span>
                        </div>
                      );
                    });
                  })()}
                </div>

                <div className="pv-cell pv-right pv-cell-value">
                  {Math.round(projectValue(p)).toLocaleString()} €
                </div>

                <div className="pv-cell pv-cell-act">
                  <button
                    className="pv-act"
                    title="Edit project"
                    onClick={() => {
                      const c = clients.find((x) => x.id === p.clientId);
                      if (c) onOpenProject(c, p);
                    }}
                  >Edit</button>
                  {closed ? (
                    <button className="pv-act is-primary" onClick={() => onReopen(p)}>Reopen</button>
                  ) : (
                    <button className="pv-act" onClick={() => onClose_(p)}>Close</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        </div>
      )}

      {(() => {
        const p = openId ? projects.find((x) => x.id === openId) : null;
        if (!p) return null;
        const c = clients.find((x) => x.id === p.clientId);
        return (
          <ProjectDrawer project={p} client={c} serviceName={typeName(p.projectTypeId)} unit={unitOf(p)}
            blueprintName={(() => { const pt = projectTypes.find((t) => t.id === p.projectTypeId); return pt?.blueprintId ? blueprints.find((b) => b.id === pt.blueprintId)?.name : undefined; })()}
            roleRows={roleRowsOf(p)} roles={roles} activity={activity} personName={personName}
            onClose={() => setOpenId(null)}
            onEdit={c ? () => { setOpenId(null); onOpenProject(c, p); } : undefined}
            onReopen={() => onReopen(p)} onCloseProject={() => onClose_(p)} />
        );
      })()}
    </>
  );
}
/* ===================================================================== */
/*  Activity: the time logged on every project (phases, people, dates)   */
/* ===================================================================== */
export interface ProjectEntry {
  id: string; projectId: string; phaseId: string; taskIds: string; date: string;
  status: string; billable: number; userId: string; notes: string; roleId: string; line: string;
  startMin: number; endMin: number;
}
export interface ProjectBill { id: string; projectId: string; period: string; net: number; amount: number; days: number; createdAt: string }
/** An invoice as Management › Billing tracks it (invoices table): sent → paid. */
export interface ProjectInvoice { id: string; projectId: string; period: string; net: number; amount: number; days: number; sentDate: string; dueDate: string; paidDate: string; status: string }
export interface ProjectActivity {
  ready: boolean;
  byProject: Map<string, ProjectEntry[]>;
  bills: Map<string, ProjectBill[]>;
  invoices: Map<string, ProjectInvoice[]>;
}
const todayIso = () => new Date().toISOString().slice(0, 10);
/** An entry that already happened (confirmed, or a planned one in the past) — it says where the work is. */
const isDone = (e: ProjectEntry) => e.status === "confirmed";
const happened = (e: ProjectEntry) => e.status !== "cancelled" && (isDone(e) || e.date <= todayIso());

/** Every calendar entry on a project (read once, paged) and the bills drawn from them. */
function useProjectActivity(projects: Project[]): ProjectActivity {
  const [state, setState] = useState<ProjectActivity>({ ready: false, byProject: new Map(), bills: new Map(), invoices: new Map() });
  const key = projects.length;
  useEffect(() => {
    if (!projects.length) return;
    let alive = true;
    (async () => {
      const rows: any[] = [];
      for (let from = 0; from < 50000; from += 1000) {
        const { data, error } = await supabase.from("calendar_entries")
          .select("id, project_id, phase_id, task_ids, entry_date, date_key, status, billable, user_id, notes, role_id, billing_line, start_min, end_min")
          .not("project_id", "is", null).order("entry_date", { ascending: false }).range(from, from + 999);
        if (error || !data) break;
        rows.push(...data);
        if (data.length < 1000) break;
      }
      const byProject = new Map<string, ProjectEntry[]>();
      rows.forEach((r) => {
        if (!r.project_id || r.status === "cancelled") return;
        const e: ProjectEntry = {
          id: r.id, projectId: r.project_id, phaseId: r.phase_id ?? "", taskIds: r.task_ids ?? "",
          date: String(r.entry_date ?? "").slice(0, 10), status: r.status || "planned", billable: Number(r.billable) || 0,
          userId: r.user_id ?? "", notes: r.notes ?? "", roleId: r.role_id ?? "", line: r.billing_line ?? "consultor",
          startMin: Number(r.start_min) || 0, endMin: Number(r.end_min) || 0,
        };
        (byProject.get(e.projectId) ?? byProject.set(e.projectId, []).get(e.projectId)!).push(e);
      });
      byProject.forEach((l) => l.sort((a, b) => b.date.localeCompare(a.date) || b.startMin - a.startMin));
      const bills = new Map<string, ProjectBill[]>();
      const { data: snaps } = await supabase.from("invoice_snapshots").select("id, project_id, period, net, amount, days, created_at");
      ((snaps ?? []) as any[]).forEach((r) => {
        if (!r.project_id) return;
        const b: ProjectBill = { id: r.id, projectId: r.project_id, period: r.period ?? "", net: Number(r.net) || 0, amount: Number(r.amount) || 0, days: Number(r.days) || 0, createdAt: r.created_at ?? "" };
        (bills.get(b.projectId) ?? bills.set(b.projectId, []).get(b.projectId)!).push(b);
      });
      bills.forEach((l) => l.sort((a, b) => b.period.localeCompare(a.period)));
      // the invoice phase each bill is in (Management › Billing: sent / paid), read-only
      const invoices = new Map<string, ProjectInvoice[]>();
      const { data: inv } = await supabase.from("invoices").select("*");
      ((inv ?? []) as any[]).forEach((r) => {
        if (!r.project_id) return;
        const i: ProjectInvoice = {
          id: r.id, projectId: r.project_id, period: r.period ?? "", net: Number(r.net) || 0, amount: Number(r.amount) || 0, days: Number(r.days) || 0,
          sentDate: r.sent_date ?? "", dueDate: r.due_date ?? "", paidDate: r.paid_date ?? "", status: r.status ?? "sent",
        };
        (invoices.get(i.projectId) ?? invoices.set(i.projectId, []).get(i.projectId)!).push(i);
      });
      invoices.forEach((l) => l.sort((a, b) => b.period.localeCompare(a.period)));
      if (alive) setState({ ready: true, byProject, bills, invoices });
    })().catch(() => { if (alive) setState((s) => ({ ...s, ready: true })); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** Where a project stands on its phases: done / booked per phase, the phase it's in, last activity. */
function phaseState(p: Project, entries: ProjectEntry[]) {
  const phases = (p.phases ?? []).map((ph) => ({ id: ph.id, name: ph.name, planned: Number(ph.days) || 0, done: 0, booked: 0, last: "" }));
  let unphased = 0;
  entries.forEach((e) => {
    const ph = phases.find((x) => x.id === e.phaseId);
    if (!ph) { if (isDone(e)) unphased += e.billable; return; }
    if (isDone(e)) ph.done += e.billable; else ph.booked += e.billable;
    if (happened(e) && e.date > ph.last) ph.last = e.date;
  });
  const lastEntry = entries.find(happened) ?? null;
  const lastPhased = entries.find((e) => happened(e) && phases.some((x) => x.id === e.phaseId)) ?? null;
  let current = lastPhased ? phases.findIndex((x) => x.id === lastPhased.phaseId) : -1;
  if (current < 0) current = phases.findIndex((x) => x.done < x.planned);
  if (current < 0 && phases.length) current = phases.length - 1;
  const started = entries.some(happened);
  return { phases, current, lastDate: lastEntry?.date ?? "", started, unphased };
}
const daysAgo = (iso: string) => (iso ? Math.round((Date.parse(todayIso()) - Date.parse(iso)) / 86400000) : null);
const agoText = (iso: string) => {
  const d = daysAgo(iso);
  if (d == null) return "No activity yet";
  if (d <= 0) return d < 0 ? `Booked ${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "Today";
  if (d === 1) return "Yesterday";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  return `${Math.round(d / 30)} months ago`;
};
const STALE_DAYS = 14;
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));
/** Weekly activity (last 8 weeks) for a spark line. */
function weeklySpark(entries: ProjectEntry[]): number[] {
  const out = new Array(8).fill(0);
  const t = Date.parse(todayIso());
  entries.forEach((e) => {
    if (!happened(e)) return;
    const w = Math.floor((t - Date.parse(e.date)) / (7 * 86400000));
    if (w >= 0 && w < 8) out[7 - w] += e.billable;
  });
  return out;
}

/* ===================================================================== */
/*  Loading scene                                                         */
/* ===================================================================== */
/** The page's loading scene: a building-blocks mark that assembles itself, over shimmering skeleton cards. */
export function ProjectsLoader() {
  return (
    <div className="pjl" role="status" aria-live="polite">
      <div className="pjl-mark" aria-hidden="true">
        <svg viewBox="0 0 120 120">
          <g className="pjl-cube">
            <path className="pjl-top" d="M60 18 96 38 60 58 24 38z" />
            <path className="pjl-left" d="M24 38 60 58v42L24 80z" />
            <path className="pjl-right" d="M96 38 60 58v42l36-20z" />
          </g>
          <path className="pjl-path" d="M33 72l11-9 9 6 12-14" />
          <g className="pjl-bars"><rect x="70" y="72" width="5" height="12" rx="1.5" /><rect x="78" y="66" width="5" height="18" rx="1.5" /><rect x="86" y="60" width="5" height="24" rx="1.5" /></g>
        </svg>
        <span className="pjl-ring" />
      </div>
      <div className="pjl-txt"><b>Loading projects</b><span>Reading phases, people and the time logged…</span></div>
      <div className="pjl-skel">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="pjl-row" style={{ ["--i" as any]: i } as CSSProperties}>
            <i className="is-a" /><i className="is-b" /><i className="is-c" /><i className="is-d" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===================================================================== */
/*  Canvas: where every project stands on its blueprint                  */
/* ===================================================================== */
function ProjectCanvas({ projects, activity, blueprints, projectTypes, clientName, typeName, personName, progressOf, onOpen }: {
  projects: Project[]; activity: ProjectActivity; blueprints: Blueprint[]; projectTypes: ProjectType[];
  clientName: (id: string) => string; typeName: (id: string) => string; personName: (id: string, fb?: string) => string;
  progressOf: (p: Project) => number; onOpen: (p: Project) => void;
}) {
  // One lane per service: its blueprint's phases are the columns (or the phases its projects carry).
  const lanes = useMemo(() => {
    const bySvc = new Map<string, Project[]>();
    projects.forEach((p) => { const k = p.projectTypeId || "-"; (bySvc.get(k) ?? bySvc.set(k, []).get(k)!).push(p); });
    return Array.from(bySvc, ([svc, list]) => {
      const pt = projectTypes.find((t) => t.id === svc);
      const bp = pt?.blueprintId ? blueprints.find((b) => b.id === pt.blueprintId) : undefined;
      const names: string[] = [];
      (bp?.phases ?? []).forEach((ph) => { if (!names.includes(ph.name)) names.push(ph.name); });
      list.forEach((p) => (p.phases ?? []).forEach((ph) => { if (!names.includes(ph.name)) names.push(ph.name); }));
      const cols: { key: string; name: string; items: { p: Project; st: ReturnType<typeof phaseState> }[] }[] =
        names.map((n) => ({ key: n, name: n, items: [] }));
      const none = { key: "__none", name: "No phases yet", items: [] as { p: Project; st: ReturnType<typeof phaseState> }[] };
      const done = { key: "__done", name: "Finished", items: [] as { p: Project; st: ReturnType<typeof phaseState> }[] };
      list.forEach((p) => {
        const st = phaseState(p, activity.byProject.get(p.id) ?? []);
        if (p.status === "closed") { done.items.push({ p, st }); return; }
        const cur = st.phases[st.current];
        const col = cur ? cols.find((c) => c.name === cur.name) : undefined;
        (col ?? none).items.push({ p, st });
      });
      const all = [...cols, ...(none.items.length ? [none] : []), done];
      return { svc, name: svc === "-" ? "No service" : typeName(svc), blueprint: bp?.name ?? null, count: list.length, cols: all };
    }).sort((a, b) => b.count - a.count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, activity, blueprints, projectTypes]);

  // Drag the background to pan sideways
  const panRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const onDown = (e: RMouseEvent) => {
    if ((e.target as HTMLElement).closest(".pjc-card, button")) return;
    const el = panRef.current; if (!el) return;
    drag.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    el.classList.add("is-panning");
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current, el = panRef.current; if (!d || !el) return;
      el.scrollLeft = d.sl - (e.clientX - d.x); el.scrollTop = d.st - (e.clientY - d.y);
    };
    const up = () => { drag.current = null; panRef.current?.classList.remove("is-panning"); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  return (
    <div className="pjc" ref={panRef} onMouseDown={onDown}>
      {!activity.ready && <div className="pjc-wait"><span className="pjc-spin" />Reading the time logged…</div>}
      {lanes.map((lane, li) => (
        <section key={lane.svc} className="pjc-lane" style={{ ["--li" as any]: li } as CSSProperties}>
          <header className="pjc-lane-h">
            <span className="pjc-lane-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2.8l8.6 4.6v9.2L12 21.2l-8.6-4.6V7.4z" /><path d="M3.4 7.4L12 12l8.6-4.6M12 12v9.2" /></svg></span>
            <b>{lane.name}</b>
            {lane.blueprint && <span className="pjc-lane-bp">Blueprint · {lane.blueprint}</span>}
            <em>{lane.count} project{lane.count === 1 ? "" : "s"}</em>
          </header>
          <div className="pjc-cols">
            {lane.cols.map((col, ci) => (
              <div key={col.key} className={`pjc-col ${col.key === "__done" ? "is-done" : col.key === "__none" ? "is-none" : ""}`}>
                <div className="pjc-col-h">
                  {col.key.startsWith("__") ? <span className="pjc-step is-flag">{col.key === "__done" ? "✓" : "–"}</span> : <span className="pjc-step">{ci + 1}</span>}
                  <span className="pjc-col-nm" title={col.name}>{col.name}</span>
                  <span className="pjc-col-n">{col.items.length}</span>
                </div>
                <div className="pjc-col-body">
                  {col.items.length === 0 && <span className="pjc-empty">—</span>}
                  {col.items.map(({ p, st }, k) => {
                    const ph = st.phases[st.current];
                    const phPct = ph && ph.planned > 0 ? Math.min(100, (ph.done / ph.planned) * 100) : 0;
                    const ago = daysAgo(st.lastDate);
                    const stale = p.status !== "closed" && st.started && ago != null && ago > STALE_DAYS;
                    const spark = weeklySpark(activity.byProject.get(p.id) ?? []);
                    const max = Math.max(...spark, 0.01);
                    const team = Array.from(new Set((p.team ?? []).map((m) => m.userId).filter(Boolean)));
                    return (
                      <button type="button" key={p.id} className={`pjc-card ${stale ? "is-stale" : ""} ${!st.started && p.status !== "closed" ? "is-new" : ""}`}
                        style={{ ["--k" as any]: k } as CSSProperties} onClick={() => onOpen(p)}>
                        <span className="pjc-card-top">
                          <b title={clientName(p.clientId)}>{clientName(p.clientId)}</b>
                          <i className="pjc-pct">{Math.round(progressOf(p))}%</i>
                        </span>
                        {ph && col.key !== "__done" && (
                          <span className="pjc-ph">
                            <span className="pjc-ph-bar"><i style={{ width: `${phPct}%` }} /></span>
                            <span className="pjc-ph-t">{num(+ph.done.toFixed(2))}/{num(ph.planned)}d in this phase</span>
                          </span>
                        )}
                        <span className="pjc-spark" aria-hidden="true">
                          {spark.map((v, i) => <i key={i} style={{ height: `${Math.max(8, (v / max) * 100)}%`, opacity: v ? 1 : 0.35 }} />)}
                        </span>
                        <span className="pjc-card-foot">
                          <span className={`pjc-ago ${stale ? "is-stale" : ""}`}>
                            {!st.started && p.status !== "closed" ? "Not started" : stale ? `Quiet for ${ago} days` : agoText(st.lastDate)}
                          </span>
                          <span className="pjc-avs">
                            {team.slice(0, 3).map((u) => <i key={u} title={personName(u)}>{initialsOf(personName(u))}</i>)}
                            {team.length > 3 && <i className="is-more">+{team.length - 3}</i>}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ===================================================================== */
/*  The project popup                                                     */
/* ===================================================================== */
type RoleRow = { roleId: string; signed: number; done: number; booked: number };
const SEC_ICON: Record<string, ReactNode> = {
  overview: <path d="M4 13h4v7H4zM10 8h4v12h-4zM16 4h4v16h-4z" />,
  phases: <><path d="M4 6h16M4 12h10M4 18h6" /><circle cx="19" cy="12" r="2" /><circle cx="15" cy="18" r="2" /></>,
  team: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><circle cx="17.5" cy="9" r="2.4" /><path d="M16 14.2a4.8 4.8 0 0 1 4.5 4.8" /></>,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  billing: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  details: <><circle cx="12" cy="12" r="9" /><path d="M12 8v.01M11 12h1v5h1" /></>,
};
const Ico = ({ d }: { d: ReactNode }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;

/** A timeline that shows its first 10 rows and scrolls inside for the rest (fades at the edges while there's more). */
function ActivityList({ title, total, upcoming, children }: { title: string; total: number; upcoming?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState({ top: false, bottom: total > 10 });
  const onScroll = () => {
    const el = ref.current; if (!el) return;
    setEdge({ top: el.scrollTop > 4, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 4 });
  };
  useEffect(onScroll, [total]);
  return (
    <div className={`pjd-al ${total > 10 ? "is-scroll" : ""} ${edge.top ? "has-top" : ""} ${edge.bottom ? "has-bottom" : ""}`}>
      <div className="pjd-tl-k">{title}<em>{total}</em></div>
      <ul ref={ref} className={`pjd-tl ${upcoming ? "is-next" : ""}`} onScroll={onScroll}>{children}</ul>
      {total > 10 && edge.bottom && <span className="pjd-al-more">{total - 10} more · scroll</span>}
    </div>
  );
}

function ProjectDrawer({ project: p, client, serviceName, blueprintName, unit, roleRows, roles, activity, personName, onClose, onEdit, onReopen, onCloseProject }: {
  project: Project; client?: Client; serviceName: string; blueprintName?: string; unit: string; roleRows: RoleRow[]; roles: ClientRole[];
  activity: ProjectActivity; personName: (id: string, fb?: string) => string;
  onClose: () => void; onEdit?: () => void; onReopen: () => void; onCloseProject: () => void;
}) {
  const navigate = useNavigate();
  const entries = activity.byProject.get(p.id) ?? [];
  const st = phaseState(p, entries);
  const bills = activity.bills.get(p.id) ?? [];
  const closed = p.status === "closed";
  const sold = roleRows.reduce((s, r) => s + r.signed, 0);
  const done = roleRows.reduce((s, r) => s + r.done, 0);
  const booked = roleRows.reduce((s, r) => s + r.booked, 0);
  const left = sold - done - booked;
  const pct = sold > 0 ? Math.min(100, (done / sold) * 100) : 0;
  const value = projectValue(p);
  const doneValue = sold > 0 ? (value * done) / sold : 0;
  const [sec, setSec] = useState("overview");
  const [askClose, setAskClose] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const SECS = [
    { id: "overview", label: "Overview" },
    { id: "phases", label: "Phases", n: st.phases.length },
    { id: "team", label: "Team", n: new Set([...(p.team ?? []).map((m) => m.userId), ...entries.map((e) => e.userId)].filter(Boolean)).size },
    { id: "activity", label: "Recent activity", n: entries.filter(happened).length },
    { id: "billing", label: "Billing", n: new Set([...bills.map((b) => b.period), ...(activity.invoices.get(p.id) ?? []).map((i) => i.period)]).size },
    { id: "details", label: "Details & contacts" },
  ];
  // Esc closes; the section in view lights up in the menu
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const lockSpy = useRef(0);
  useEffect(() => {
    const el = bodyRef.current; if (!el) return;
    const onScroll = () => {
      if (Date.now() < lockSpy.current) return;
      const secs = Array.from(el.querySelectorAll<HTMLElement>("[data-sec]"));
      const top = el.getBoundingClientRect().top + 90;
      let curId = secs[0]?.dataset.sec ?? "overview";
      secs.forEach((s) => { if (s.getBoundingClientRect().top <= top) curId = s.dataset.sec!; });
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) curId = secs[secs.length - 1]?.dataset.sec ?? curId;
      setSec(curId);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const go = (id: string) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-sec="${id}"]`);
    // the menu jumps to the section at once; the scroll spy waits for the smooth scroll to land
    setSec(id); lockSpy.current = Date.now() + 900;
    if (el && bodyRef.current) bodyRef.current.scrollTo({ top: el.offsetTop - 18, behavior: "smooth" });
  };
  const roleIdx = (id: string) => roles.findIndex((r) => r.id === id);
  // people: team members and anyone who logged time
  const people = useMemo(() => {
    const m = new Map<string, { id: string; done: number; booked: number; last: string; onTeam: boolean }>();
    (p.team ?? []).forEach((t) => { if (t.userId) m.set(t.userId, { id: t.userId, done: 0, booked: 0, last: "", onTeam: true }); });
    entries.forEach((e) => {
      if (!e.userId) return;
      const r = m.get(e.userId) ?? { id: e.userId, done: 0, booked: 0, last: "", onTeam: false };
      if (isDone(e)) r.done += e.billable; else r.booked += e.billable;
      if (happened(e) && e.date > r.last) r.last = e.date;
      m.set(e.userId, r);
    });
    return Array.from(m.values()).sort((a, b) => b.done - a.done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, entries.length]);
  const phaseName = (id: string) => p.phases?.find((x) => x.id === id)?.name ?? "";
  // the latest 10 in view, the rest in the list's own scroll
  const recentAll = entries.filter(happened);
  const upcomingAll = entries.filter((e) => !happened(e)).reverse();
  const invs = activity.invoices.get(p.id) ?? [];
  const invNet = (i: ProjectInvoice) => (i.net > 0 || i.amount === 0 ? i.net : i.amount);
  const today = todayIso();
  // every billed period, whether it only has a bill snapshot or already an invoice (invoice amount wins)
  const periods = Array.from(new Set([...invs.map((i) => i.period), ...bills.map((b) => b.period)])).sort((x, y) => y.localeCompare(x));
  const billedTotal = periods.reduce((s, per) => { const i = invs.find((x) => x.period === per); return s + (i ? invNet(i) : bills.find((x) => x.period === per)?.net ?? 0); }, 0);
  const paidInv = invs.filter((i) => i.status === "paid");
  const awaitInv = invs.filter((i) => i.status !== "paid");
  const overdueInv = awaitInv.filter((i) => i.dueDate && i.dueDate < today);
  const paidTotal = paidInv.reduce((s, i) => s + invNet(i), 0);
  const awaitTotal = awaitInv.reduce((s, i) => s + invNet(i), 0);
  const overdueTotal = overdueInv.reduce((s, i) => s + invNet(i), 0);
  // bills not invoiced yet: billed periods with no invoice row
  const toInvoice = bills.filter((b) => !invs.some((i) => i.period === b.period));
  const toInvoiceTotal = toInvoice.reduce((s, b) => s + b.net, 0);
  const moneyBase = Math.max(value, billedTotal, paidTotal + awaitTotal + toInvoiceTotal, 1);
  const eur = (n: number) => `${Math.round(n).toLocaleString()} €`;
  const time = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const ago = daysAgo(st.lastDate);
  const stale = !closed && st.started && ago != null && ago > STALE_DAYS;

  return createPortal(
    <div className="pjd-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pjd" role="dialog" aria-modal="true" aria-label={`${client?.name ?? "Project"} · ${serviceName}`}>
        <header className="pjd-hero">
          <div className="pjd-hero-l">
            <span className="pjd-av">{initialsOf(client?.name ?? "?")}</span>
            <div className="pjd-hero-t">
              <span className="pjd-eyebrow">Implementation · {serviceName}</span>
              <h2>{client?.name ?? "Project"}</h2>
              <div className="pjd-chips">
                <span className={`pjd-chip ${closed ? "is-closed" : "is-open"}`}><i />{closed ? "Finished" : "In progress"}</span>
                {st.phases[st.current] && !closed && <span className="pjd-chip">Phase {st.current + 1}/{st.phases.length} · {st.phases[st.current].name}</span>}
                <span className={`pjd-chip ${stale ? "is-warn" : ""}`}>{stale ? `Quiet for ${ago} days` : agoText(st.lastDate)}</span>
                {client && <button type="button" className="pjd-chip is-link" onClick={() => { onClose(); navigate(`/clients?client=${client.id}`); }}>Open client →</button>}
              </div>
            </div>
          </div>
          <div className="pjd-hero-r">
            <div className="pjd-ring" style={{ ["--p" as any]: pct } as CSSProperties}><b>{Math.round(pct)}<i>%</i></b><span>delivered</span></div>
            <button type="button" className="pjd-x" onClick={onClose} aria-label="Close"><Ico d={<path d="M6 6l12 12M18 6L6 18" />} /></button>
          </div>
        </header>

        <div className="pjd-main">
          <nav className="pjd-nav" aria-label="Sections">
            <span className="pjd-nav-k">Project</span>
            {SECS.map((x) => (
              <button type="button" key={x.id} className={`pjd-nav-i ${sec === x.id ? "is-on" : ""}`} onClick={() => go(x.id)}>
                <span className="pjd-nav-ico"><Ico d={SEC_ICON[x.id]} /></span>
                <span>{x.label}</span>
                {x.n ? <em>{x.n}</em> : null}
              </button>
            ))}
            <div className="pjd-nav-foot">
              {onEdit && <button type="button" className="pjd-btn" onClick={onEdit}><Ico d={<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />} />Edit project</button>}
              {closed ? (
                <button type="button" className="pjd-btn is-primary" onClick={onReopen}>Reopen</button>
              ) : askClose ? (
                <span className="pjd-ask">Close it? <button type="button" className="is-yes" onClick={() => { setAskClose(false); onCloseProject(); }}>Yes</button><button type="button" onClick={() => setAskClose(false)}>No</button></span>
              ) : (
                <button type="button" className="pjd-btn" onClick={() => setAskClose(true)}>Close project</button>
              )}
            </div>
          </nav>

          <div className="pjd-body" ref={bodyRef}>
            {/* ---- Overview ---- */}
            <section className="pjd-sec" data-sec="overview">
              <div className="pjd-kpis">
                <div className="pjd-kpi"><span>Sold</span><b>{num(sold)}<i>{unit}</i></b><em>{Math.round(value).toLocaleString()} €</em></div>
                <div className="pjd-kpi is-done"><span>Done</span><b>{num(+done.toFixed(2))}<i>{unit}</i></b><em>{Math.round(doneValue).toLocaleString()} € delivered</em></div>
                <div className="pjd-kpi is-booked"><span>Booked</span><b>{num(+booked.toFixed(2))}<i>{unit}</i></b><em>planned ahead</em></div>
                <div className={`pjd-kpi ${left < 0 ? "is-over" : ""}`}><span>{left < 0 ? "Over" : "Left"}</span><b>{num(+Math.abs(left).toFixed(2))}<i>{unit}</i></b><em>{left < 0 ? "beyond what was sold" : "still to plan"}</em></div>
              </div>
              <div className="pjd-meter" aria-hidden="true">
                <i className="is-done" style={{ width: `${sold > 0 ? Math.min(100, (done / sold) * 100) : 0}%` }} />
                <i className="is-booked" style={{ width: `${sold > 0 ? Math.min(100 - Math.min(100, (done / sold) * 100), (booked / sold) * 100) : 0}%` }} />
              </div>
              <div className="pjd-roles">
                {roleRows.length === 0 && <p className="pjd-empty">No roles sold on this project.</p>}
                {roleRows.map((r) => {
                  const i = roleIdx(r.roleId);
                  const w = (n: number) => (r.signed > 0 ? Math.min(100, (n / r.signed) * 100) : n > 0 ? 100 : 0);
                  return (
                    <div key={r.roleId} className="pjd-role" style={{ ["--c" as any]: roleColor(roles[i], i < 0 ? 0 : i) } as CSSProperties}>
                      <span className="pjd-role-nm"><i />{roleNameOf(r.roleId, roles)}</span>
                      <span className="pjd-track"><i className="is-b" style={{ width: `${w(r.done + r.booked)}%` }} /><i style={{ width: `${w(r.done)}%` }} /></span>
                      <span className="pjd-role-f"><b>{num(+r.done.toFixed(2))}</b> / {num(r.signed)}{unit}{r.booked ? <em> +{num(+r.booked.toFixed(2))} booked</em> : null}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* ---- Phases ---- */}
            <section className="pjd-sec" data-sec="phases">
              <h3 className="pjd-h"><span className="pjd-h-ico"><Ico d={SEC_ICON.phases} /></span>Phases<em>{st.phases.length ? "From the service's blueprint · progress from the time logged" : ""}</em></h3>
              {st.phases.length === 0 ? <p className="pjd-empty">This project has no phases. Edit it to apply its service's blueprint.</p> : (
                <ol className="pjd-steps">
                  {st.phases.map((ph, i) => {
                    const w = ph.planned > 0 ? Math.min(100, (ph.done / ph.planned) * 100) : ph.done > 0 ? 100 : 0;
                    const state = closed || (ph.planned > 0 && ph.done >= ph.planned) ? "is-done" : i === st.current ? "is-now" : i < st.current ? "is-past" : "is-next";
                    const tasks = p.phases?.find((x) => x.id === ph.id)?.tasks ?? [];
                    return (
                      <li key={ph.id} className={`pjd-step ${state}`} style={{ ["--i" as any]: i } as CSSProperties}>
                        <span className="pjd-step-dot">{state === "is-done" ? "✓" : i + 1}</span>
                        <div className="pjd-step-b">
                          <div className="pjd-step-top">
                            <b>{ph.name}</b>
                            {state === "is-now" && <span className="pjd-now">Now</span>}
                            <span className="pjd-step-f">{num(+ph.done.toFixed(2))}/{num(ph.planned)}{unit}{ph.booked ? ` · +${num(+ph.booked.toFixed(2))} booked` : ""}</span>
                          </div>
                          <span className="pjd-step-bar"><i style={{ width: `${w}%` }} /></span>
                          <span className="pjd-step-sub">{ph.last ? `Last worked ${fmtDate(ph.last)}` : "Not worked yet"}{tasks.length ? ` · ${tasks.map((t) => t.name).join(" · ")}` : ""}</span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              {st.unphased > 0 && <p className="pjd-note">{num(+st.unphased.toFixed(2))}{unit} logged without a phase.</p>}
            </section>

            {/* ---- Team ---- */}
            <section className="pjd-sec" data-sec="team">
              <h3 className="pjd-h"><span className="pjd-h-ico"><Ico d={SEC_ICON.team} /></span>Team</h3>
              {people.length === 0 ? <p className="pjd-empty">Nobody on the team yet.</p> : (
                <ul className="pjd-people">
                  {people.map((u) => (
                    <li key={u.id}>
                      <span className="pjd-pav">{initialsOf(personName(u.id))}</span>
                      <span className="pjd-pp"><b>{personName(u.id)}</b><em>{u.onTeam ? "On the team" : "Logged time"}{u.last ? ` · last ${fmtDate(u.last)}` : ""}</em></span>
                      <span className="pjd-pf"><b>{num(+u.done.toFixed(2))}{unit}</b><em>{u.booked ? `+${num(+u.booked.toFixed(2))}${unit} booked` : "done"}</em></span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ---- Activity ---- */}
            <section className="pjd-sec" data-sec="activity">
              <h3 className="pjd-h"><span className="pjd-h-ico"><Ico d={SEC_ICON.activity} /></span>Recent activity{!activity.ready && <em>Loading…</em>}</h3>
              {activity.ready && recentAll.length === 0 && upcomingAll.length === 0 && <p className="pjd-empty">No time logged on this project yet.</p>}
              {upcomingAll.length > 0 && (
                <ActivityList title="Coming up" total={upcomingAll.length} upcoming>
                  {upcomingAll.map((e) => (
                    <li key={e.id}><span className="pjd-tl-d">{fmtDate(e.date)}</span><span className="pjd-tl-b"><b>{personName(e.userId)}</b>{phaseName(e.phaseId) && <i>{phaseName(e.phaseId)}</i>}{e.notes && <em>{e.notes}</em>}</span><span className="pjd-tl-t">{time(e.startMin)}–{time(e.endMin)} · {num(e.billable)}{unit}</span></li>
                  ))}
                </ActivityList>
              )}
              {recentAll.length > 0 && (
                <ActivityList title="Latest" total={recentAll.length}>
                  {recentAll.map((e) => (
                    <li key={e.id} className={isDone(e) ? "is-done" : ""}>
                      <span className="pjd-tl-d">{fmtDate(e.date)}</span>
                      <span className="pjd-tl-b"><b>{personName(e.userId)}</b>{phaseName(e.phaseId) && <i>{phaseName(e.phaseId)}</i>}{e.notes && <em>{e.notes}</em>}</span>
                      <span className="pjd-tl-t">{num(e.billable)}{unit} · {isDone(e) ? "confirmed" : "not confirmed"}</span>
                    </li>
                  ))}
                </ActivityList>
              )}
            </section>

            {/* ---- Billing ---- */}
            <section className="pjd-sec" data-sec="billing">
              <h3 className="pjd-h"><span className="pjd-h-ico"><Ico d={SEC_ICON.billing} /></span>Billing<em>From Management › Billing · updates as invoices are sent and paid</em></h3>
              <div className="pjd-money">
                <div className="pjd-mk is-value"><span>Contract value</span><b>{eur(value)}</b><em>{p.paymentDays ? `Pay in ${p.paymentDays} days` : "No payment terms"}</em></div>
                <div className="pjd-mk is-billed"><span><i />Billed so far</span><b>{eur(billedTotal)}</b><em>{periods.length} period{periods.length === 1 ? "" : "s"}{toInvoice.length ? ` · ${toInvoice.length} not invoiced yet` : ""}</em></div>
                <div className="pjd-mk is-await"><span><i />Awaiting payment</span><b>{eur(awaitTotal)}</b><em>{awaitInv.length ? `${awaitInv.length} invoice${awaitInv.length === 1 ? "" : "s"}${overdueInv.length ? ` · ${overdueInv.length} overdue` : ""}` : "Nothing pending"}</em></div>
                <div className="pjd-mk is-paid"><span><i />Already paid</span><b>{eur(paidTotal)}</b><em>{paidInv.length ? `${paidInv.length} invoice${paidInv.length === 1 ? "" : "s"}` : "Nothing paid yet"}</em></div>
              </div>
              <div className="pjd-mbar" aria-hidden="true">
                <i className="is-paid" style={{ width: `${(paidTotal / moneyBase) * 100}%` }} />
                <i className="is-await" style={{ width: `${((awaitTotal - overdueTotal) / moneyBase) * 100}%` }} />
                <i className="is-overdue" style={{ width: `${(overdueTotal / moneyBase) * 100}%` }} />
                <i className="is-toinv" style={{ width: `${(toInvoiceTotal / moneyBase) * 100}%` }} />
              </div>
              <div className="pjd-mlegend">
                <span className="is-paid"><i />Paid</span>
                <span className="is-await"><i />Awaiting</span>
                {overdueTotal > 0 && <span className="is-overdue"><i />Overdue {eur(overdueTotal)}</span>}
                {toInvoiceTotal > 0 && <span className="is-toinv"><i />Billed, not invoiced</span>}
                <span className="is-rest"><i />Still to bill {eur(Math.max(0, value - billedTotal))}</span>
              </div>
              {bills.length === 0 && invs.length === 0 ? <p className="pjd-empty">Nothing billed yet.</p> : (
                <div className="pjd-inv">
                  <div className="pjd-inv-h"><span>Period</span><span>Days</span><span>Sent</span><span>Due / paid</span><span>Status</span><span className="is-r">Amount</span></div>
                  {periods.map((per) => {
                    const i = invs.find((x) => x.period === per);
                    const b = bills.find((x) => x.period === per);
                    const st = !i ? "toinvoice" : i.status === "paid" ? "paid" : i.dueDate && i.dueDate < today ? "overdue" : "awaiting";
                    const label = st === "paid" ? "Paid" : st === "overdue" ? "Overdue" : st === "awaiting" ? "Awaiting payment" : "Not invoiced";
                    return (
                      <div key={per || i?.id || b?.id} className={`pjd-inv-r is-${st}`}>
                        <b>{per || "—"}</b>
                        <span>{num(+((i?.days || b?.days) ?? 0).toFixed(2))}{unit}</span>
                        <span>{i?.sentDate ? fmtDate(i.sentDate) : "—"}</span>
                        <span>{st === "paid" ? fmtDate(i!.paidDate) : i?.dueDate ? fmtDate(i.dueDate) : "—"}</span>
                        <span><em className={`pjd-st is-${st}`}><i />{label}</em></span>
                        <span className="is-r"><b>{eur(i ? invNet(i) : b?.net ?? 0)}</b></span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ---- Details ---- */}
            <section className="pjd-sec" data-sec="details">
              <h3 className="pjd-h"><span className="pjd-h-ico"><Ico d={SEC_ICON.details} /></span>Details &amp; contacts</h3>
              <div className="pjd-det">
                <div className="pjd-det-card">
                  <span className="pjd-det-k">Timeline</span>
                  <div className="pjd-det-tl">
                    <div><i /><span>Signed</span><b>{fmtDate(p.signingDate)}</b></div>
                    <div><i /><span>Kick-off</span><b>{fmtDate(p.kickoffDate)}</b></div>
                    <div className={p.endDate ? "" : "is-open"}><i /><span>{closed ? "Finished" : "End"}</span><b>{p.endDate ? fmtDate(p.endDate) : "Open-ended"}</b></div>
                  </div>
                </div>
                <div className="pjd-det-card">
                  <span className="pjd-det-k">Billing entity</span>
                  <dl className="pjd-det-dl">
                    <div><dt>Legal name</dt><dd>{p.legalName || client?.name || "—"}</dd></div>
                    <div><dt>VAT</dt><dd>{p.vatNumber || "—"}</dd></div>
                    <div><dt>Address</dt><dd>{[p.address?.street, p.address?.number, p.address?.postalCode, p.address?.city].filter(Boolean).join(" ") || "—"}</dd></div>
                    <div><dt>Tax</dt><dd>{p.taxed ? `${p.taxRate}% VAT` : "Not taxed"}</dd></div>
                    <div><dt>Payment terms</dt><dd>{p.paymentDays ? `${p.paymentDays} days` : "—"}</dd></div>
                  </dl>
                </div>
                <div className="pjd-det-card">
                  <span className="pjd-det-k">Delivery</span>
                  <dl className="pjd-det-dl">
                    <div><dt>Service</dt><dd>{serviceName || "—"}</dd></div>
                    <div><dt>Blueprint</dt><dd>{blueprintName || "—"}</dd></div>
                    <div><dt>Owners</dt><dd className="pjd-det-own">{(p.team ?? []).length ? (p.team ?? []).map((t) => (
                      <span key={t.id || t.userId} title={t.role}><i>{initialsOf(personName(t.userId, t.name))}</i>{personName(t.userId, t.name)}</span>
                    )) : "—"}</dd></div>
                  </dl>
                </div>
              </div>
              <span className="pjd-det-k is-out">Contacts <em>{(p.contacts ?? []).length}</em></span>
              {(p.contacts ?? []).length === 0 ? <p className="pjd-empty">No contacts on this project. Edit it to add who the client's people are.</p> : (
                <div className="pjd-cards">
                  {(p.contacts ?? []).map((k) => (
                    <div key={k.id ?? k.name} className="pjd-card">
                      <span className="pjd-card-av">{initialsOf(k.name ?? "")}</span>
                      <div className="pjd-card-t">
                        <b>{k.name || "—"}</b>
                        <em>{k.position || "Contact"}{k.billing ? <span className="pjd-card-tag">Billing</span> : null}</em>
                      </div>
                      <div className="pjd-card-a">
                        {k.email && <a href={`mailto:${k.email}`} title={k.email} aria-label={`Email ${k.name}`}><Ico d={<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>} /></a>}
                        {k.phone && <a href={`tel:${k.phone.replace(/\s+/g, "")}`} title={k.phone} aria-label={`Call ${k.name}`}><Ico d={<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />} /></a>}
                      </div>
                      {(k.email || k.phone) && <span className="pjd-card-sub">{[k.email, k.phone].filter(Boolean).join(" · ")}</span>}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
