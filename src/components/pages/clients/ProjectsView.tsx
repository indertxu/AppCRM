import { useEffect, useMemo, useState } from "react";
import type { Client, Project, ProjectType } from "./ClientsPage";
import { projectValue } from "./ClientsPage";
import Select from "../../framework/Select";
import { supabase } from "../../api/supabase";

export type Usage = Record<string, { done: number; booked: number }>;

interface Props {
  clients: Client[];
  projects: Project[];
  projectTypes: ProjectType[];
  usage: Usage;
  onOpenProject: (c: Client, p: Project) => void;
  onReopen: (p: Project) => void;
  onClose_: (p: Project) => void;
}

const LINES: { key: string; label: string }[] = [
  { key: "consultor", label: "Consultancy" },
  { key: "connector", label: "Connector" },
];

type Sort = "recent" | "value" | "days" | "progress" | "left";

export default function ProjectsView({
  clients, projects, projectTypes, usage, onOpenProject, onReopen, onClose_,
}: Props) {
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
      setPeople(out);
    }).catch(() => {});
  }, []);
  const personName = (id: string, fallback?: string) => people[id] || (fallback && fallback !== "—" ? fallback : "") || "Unknown";

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "—";
  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";

  const signedOf = (p: Project, line: string) =>
    line === "connector" ? p.connectorDays : p.consultorDays + p.supervisionDays;
  const totalSigned = (p: Project) => p.consultorDays + p.connectorDays + p.supervisionDays;

  /**
   * The consultancy column is signed as consultorDays + supervisionDays, so its
   * usage has to include the supervision line too. Reading only `|consultor`
   * left every supervision day counted in the denominator and never in the
   * numerator, so supervision always looked 0% delivered.
   */
  const usageOf = (p: Project, line: string) => {
    const keys = line === "connector"
      ? [`${p.id}|connector`]
      : [`${p.id}|consultor`, `${p.id}|supervision`];
    return keys.reduce(
      (acc, k) => {
        const u = usage[k];
        if (u) { acc.done += u.done; acc.booked += u.booked; }
        return acc;
      },
      { done: 0, booked: 0 }
    );
  };

  const totalUsed = (p: Project) =>
    LINES.reduce((s, ln) => s + usageOf(p, ln.key).done, 0);
  const totalBooked = (p: Project) =>
    LINES.reduce((s, ln) => s + usageOf(p, ln.key).booked, 0);
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
      ) : (
        <div className="pv-scroll">
        <div className="pv-list">
          <div className="pv-hrow">
            <span>Project</span>
            <span>Dates</span>
            <span>Consultancy</span>
            <span>Connector</span>
            <span className="pv-right">Value</span>
            <span />
          </div>

          {shown.map((p) => {
            const closed = p.status === "closed";
            return (
              <div className={`pv-row ${closed ? "is-closed" : ""}`} key={p.id}>
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

                {LINES.map((ln) => {
                  const signed = signedOf(p, ln.key);
                  const u = usageOf(p, ln.key);
                  const left = +(signed - u.done - u.booked).toFixed(2);
                  const pct = (n: number) => (signed > 0 ? Math.min(100, (n / signed) * 100) : 0);
                  return (
                    <div className="pv-cell pv-cell-line" key={ln.key}>
                      {signed === 0 && u.done === 0 && u.booked === 0 ? (
                        <span className="pv-none">—</span>
                      ) : (
                        <>
                          <div className="pv-track">
                            <div className="pv-fill" style={{ width: `${pct(u.done + u.booked)}%` }} />
                            <div className="pv-fill is-done" style={{ width: `${pct(u.done)}%` }} />
                          </div>
                          <span className="pv-figs">
                            <b>{u.done.toFixed(2)}</b>/{signed}{unitOf(p)}
                            <i className={left < 0 ? "is-over" : ""}>
                              {left < 0 ? `${Math.abs(left).toFixed(2)}${unitOf(p)} over` : `${left.toFixed(2)}${unitOf(p)} left`}
                            </i>
                          </span>
                        </>
                      )}
                    </div>
                  );
                })}

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
    </>
  );
}