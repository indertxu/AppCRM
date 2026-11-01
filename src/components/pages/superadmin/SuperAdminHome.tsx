import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  LayoutDashboard, Building2, Users, Wallet, Activity, Database, Plug, LogOut, RefreshCw, CheckCircle2, AlertTriangle, CircleDashed,
  Plus, Search, Info, ArrowUpRight,
} from "lucide-react";
import { supabase } from "../../api/supabase";
import {
  loadDashboard, loadTenantDetail, refreshUsage, saveCostSettings, computeCosts, userCosts, withDefaults, aiCost,
  loadCosts, syncCosts, costsStale, SUPABASE_UNITS,
  fmtBytes, fmtNum, fmtDur, fmtMoney, fmtAgo, pageLabel, dayList,
  type Dashboard, type CostSettings, type CostModel, type TenantUserRow, type Allocation, type CostsData, type CostSource, type Provider, type CostOrigin,
} from "../../api/superadminApi";
import SuperAdminCreate from "./SuperAdminCreate";
import "./SuperAdmin.css";

/* =====================================================================
   The platform console (superadmin): companies, users, usage, data and
   what it all costs. Everything comes from two database calls
   (sa_dashboard / sa_tenant) — see sql/86_platform_admin.sql.
   The shell, charts and small parts are exported for the company page.
   ===================================================================== */

export const TENANT_COLORS = ["#12b57f", "#3b82f6", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#84cc16"];
export const colorOf = (i: number) => TENANT_COLORS[i % TENANT_COLORS.length];

export type Tab = "overview" | "companies" | "users" | "costs" | "usage" | "data" | "settings";
const NAV: { key: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "companies", label: "Companies", icon: Building2 },
  { key: "users", label: "Users", icon: Users },
  { key: "costs", label: "Costs", icon: Wallet },
  { key: "usage", label: "Usage", icon: Activity },
  { key: "data", label: "Data & storage", icon: Database },
  { key: "settings", label: "Cost sources", icon: Plug },
];

/** the period every number covers (remembered per browser) */
export function useDays(): [number, (d: number) => void] {
  const [days, setDaysState] = useState<number>(() => {
    try { const v = Number(localStorage.getItem("sa-days")); return [7, 30, 90].includes(v) ? v : 30; } catch { return 30; }
  });
  const setDays = (d: number) => { setDaysState(d); try { localStorage.setItem("sa-days", String(d)); } catch { /* ignore */ } };
  return [days, setDays];
}

/* ---------- layout ---------- */
export function Shell({ tab, onTab, children, scrollKey }: { tab: Tab | null; onTab: (t: Tab) => void; children: ReactNode; scrollKey?: string }) {
  const main = useRef<HTMLElement>(null);
  // a new view starts at the top
  useEffect(() => { main.current?.scrollTo({ top: 0 }); }, [scrollKey]);
  return (
    <div className="sa">
      <aside className="sa-side">
        <div className="sa-brand">
          <span className="sa-brand-mark" aria-hidden="true">N</span>
          <span className="sa-brand-txt"><b>Next</b><i>Platform console</i></span>
        </div>
        <nav className="sa-nav">
          {NAV.map((n) => {
            const I = n.icon;
            return (
              <button key={n.key} className={`sa-nav-item ${tab === n.key ? "is-on" : ""}`} onClick={() => onTab(n.key)} aria-label={n.label}>
                <I size={17} strokeWidth={1.9} /> <span>{n.label}</span>
              </button>
            );
          })}
        </nav>
        <button className="sa-nav-item sa-nav-out" onClick={() => supabase.auth.signOut()} aria-label="Sign out">
          <LogOut size={17} strokeWidth={1.9} /> <span>Sign out</span>
        </button>
      </aside>
      <main className="sa-main" ref={main}>{children}</main>
    </div>
  );
}

export function Head({ kicker, title, sub, right }: { kicker: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <header className="sa-head">
      <div className="sa-head-l">
        <span className="sa-kicker">{kicker}</span>
        <h1 className="sa-h1">{title}</h1>
        {sub && <p className="sa-sub">{sub}</p>}
      </div>
      {right && <div className="sa-head-r">{right}</div>}
    </header>
  );
}

export function Period({ days, setDays }: { days: number; setDays: (d: number) => void }) {
  return (
    <div className="sa-seg" role="group" aria-label="Period">
      {[7, 30, 90].map((d) => (
        <button key={d} className={days === d ? "is-on" : ""} onClick={() => setDays(d)}>{d}d</button>
      ))}
    </div>
  );
}

export function Card({ title, sub, right, children, className = "" }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`sa-card ${className}`}>
      {(title || right) && (
        <div className="sa-card-h">
          <div className="sa-card-ht">{title && <h2>{title}</h2>}{sub && <p>{sub}</p>}</div>
          {right && <div className="sa-card-hr">{right}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, meter, tone }: { label: string; value: ReactNode; sub?: ReactNode; meter?: number; tone?: "warn" | "bad" }) {
  return (
    <div className={`sa-kpi ${tone ? `is-${tone}` : ""}`}>
      <span className="sa-kpi-k">{label}</span>
      <b className="sa-kpi-v">{value}</b>
      {meter != null && (
        <span className="sa-meter" aria-hidden="true"><i style={{ width: `${Math.max(1.5, Math.min(100, meter * 100))}%` }} /></span>
      )}
      {sub && <span className="sa-kpi-s">{sub}</span>}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="sa-note"><Info size={14} strokeWidth={2} /> <span>{children}</span></p>;
}
export const Empty = ({ children }: { children: ReactNode }) => <p className="sa-empty">{children}</p>;

/* ---------- charts ---------- */
export interface Series { key: string; label: string; color: string; values: number[] }
/** Stacked columns per day, with a hover read-out. Outliers are clipped (marked ↑) so one bulk day doesn't flatten the rest. */
export function TimeChart({ days, series, fmt, height = 190 }: { days: string[]; series: Series[]; fmt: (v: number) => string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = days.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const sorted = [...totals].filter((v) => v > 0).sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0;
  const max0 = Math.max(...totals, 0);
  const cap = sorted.length >= 5 && max0 > p90 * 4 ? p90 * 1.6 : max0;
  const max = cap || 1;
  const step = days.length > 45 ? 14 : days.length > 14 ? 7 : 1;
  const any = totals.some((v) => v > 0);
  return (
    <div className="sa-tc" style={{ height }} onMouseLeave={() => setHover(null)}>
      <div className="sa-tc-grid" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="sa-tc-cols">
        {days.map((d, i) => {
          const clipped = totals[i] > max;
          return (
            <div key={d} className={`sa-tc-col ${hover === i ? "is-hover" : ""}`} onMouseEnter={() => setHover(i)}>
              <div className="sa-tc-stack">
                {series.map((s) => {
                  const v = s.values[i] ?? 0;
                  if (!v) return null;
                  const h = (Math.min(v, totals[i] > max ? v * (max / totals[i]) : v) / max) * 100;
                  return <span key={s.key} style={{ height: `${h}%`, background: s.color }} />;
                })}
                {clipped && <em className="sa-tc-clip">↑</em>}
              </div>
              {i % step === 0 && <span className="sa-tc-x">{new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>}
            </div>
          );
        })}
      </div>
      {!any && <div className="sa-tc-none">No data in this period yet</div>}
      {hover != null && any && (
        <div className={`sa-tc-tip ${hover > days.length * 0.6 ? "is-left" : ""}`} style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}>
          <b>{new Date(days[hover]).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</b>
          {series.filter((s) => s.values[hover]).map((s) => (
            <span key={s.key}><i style={{ background: s.color }} />{s.label}<em>{fmt(s.values[hover])}</em></span>
          ))}
          {series.length > 1 && <span className="is-total">Total<em>{fmt(totals[hover])}</em></span>}
        </div>
      )}
    </div>
  );
}

export interface BarRow { key: string; label: ReactNode; value: number; color?: string; sub?: ReactNode; parts?: { value: number; color: string }[] }
export function HBars({ rows, fmt, max: max0 }: { rows: BarRow[]; fmt: (v: number) => string; max?: number }) {
  const max = max0 ?? Math.max(...rows.map((r) => r.value), 0) ?? 1;
  if (!rows.length) return <Empty>Nothing to show yet.</Empty>;
  return (
    <div className="sa-hb">
      {rows.map((r) => (
        <div key={r.key} className="sa-hb-row">
          <span className="sa-hb-l">{r.label}{r.sub && <small>{r.sub}</small>}</span>
          <span className="sa-hb-track">
            {r.parts
              ? r.parts.map((p, i) => <i key={i} style={{ width: `${max ? (p.value / max) * 100 : 0}%`, background: p.color }} />)
              : <i style={{ width: `${max ? Math.max(r.value > 0 ? 0.6 : 0, (r.value / max) * 100) : 0}%`, background: r.color }} />}
          </span>
          <span className="sa-hb-v">{fmt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function Donut({ parts, center, sub }: { parts: { key: string; label: string; value: number; color: string }[]; center: ReactNode; sub?: ReactNode }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const R = 52, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="sa-donut">
      <svg viewBox="0 0 140 140" aria-hidden="true">
        <circle cx="70" cy="70" r={R} fill="none" stroke="rgba(18,181,127,0.1)" strokeWidth="16" />
        {total > 0 && parts.map((p) => {
          const len = (p.value / total) * C;
          const el = <circle key={p.key} cx="70" cy="70" r={R} fill="none" stroke={p.color} strokeWidth="16"
            strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`} strokeDashoffset={-acc} transform="rotate(-90 70 70)" />;
          acc += len;
          return el;
        })}
      </svg>
      <div className="sa-donut-c"><b>{center}</b>{sub && <span>{sub}</span>}</div>
    </div>
  );
}

export function Legend({ items }: { items: { key: string; label: ReactNode; color: string; value?: ReactNode }[] }) {
  return (
    <ul className="sa-legend">
      {items.map((i) => <li key={i.key}><i style={{ background: i.color }} /><span>{i.label}</span>{i.value != null && <em>{i.value}</em>}</li>)}
    </ul>
  );
}

/** rows × columns of intensity (e.g. pages × companies) */
export function Heat({ rows, cols, value, fmt }: { rows: { key: string; label: ReactNode }[]; cols: { key: string; label: ReactNode }[]; value: (r: string, c: string) => number; fmt: (v: number) => string }) {
  const vals = rows.flatMap((r) => cols.map((c) => value(r.key, c.key)));
  const max = Math.max(...vals, 0) || 1;
  if (!rows.length || !cols.length) return <Empty>Nothing measured yet.</Empty>;
  return (
    <div className="sa-heat" style={{ gridTemplateColumns: `minmax(120px, 1.2fr) repeat(${cols.length}, minmax(64px, 1fr))` }}>
      <span />
      {cols.map((c) => <span key={c.key} className="sa-heat-ch">{c.label}</span>)}
      {rows.map((r) => (
        <div key={r.key} className="sa-heat-row" style={{ display: "contents" }}>
          <span className="sa-heat-rh">{r.label}</span>
          {cols.map((c) => {
            const v = value(r.key, c.key);
            const a = v > 0 ? 0.12 + 0.78 * Math.sqrt(v / max) : 0;
            return <span key={c.key} className="sa-heat-cell" style={{ background: v > 0 ? `rgba(18,181,127,${a})` : undefined, color: a > 0.55 ? "#fff" : undefined }} title={fmt(v)}>{v > 0 ? fmt(v) : "–"}</span>;
          })}
        </div>
      ))}
    </div>
  );
}

/** a sortable table head cell */
export function Th<K extends string>({ k, sort, setSort, children, num, wide }: { k: K; sort: { key: K; dir: 1 | -1 }; setSort: (s: { key: K; dir: 1 | -1 }) => void; children: ReactNode; num?: boolean; wide?: boolean }) {
  const on = sort.key === k;
  return (
    <th className={`${num ? "is-num" : ""} ${on ? "is-sorted" : ""} ${wide ? "is-wide" : ""}`}>
      <button onClick={() => setSort({ key: k, dir: on ? (sort.dir === 1 ? -1 : 1) : num ? -1 : 1 })}>
        {children}{on && <i>{sort.dir === 1 ? "↑" : "↓"}</i>}
      </button>
    </th>
  );
}

export const initials = (name: string) => name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
export const personName = (u: { first_name: string | null; last_name: string | null; email: string | null }) =>
  [u.first_name, u.last_name].map((x) => (x ?? "").trim()).filter(Boolean).join(" ") || u.email || "No name yet";
export const ROLE_LABELS: Record<string, string> = {
  boss: "Boss / Owner", consultancy_manager: "Consultancy manager", customer_success: "Customer success",
  customer_success_manager: "CS manager", sales_manager: "Sales manager", sales: "Sales", consultant: "Consultant",
};

/** time per day by company, falling back to data changes until page time has been measured */
export function activitySeries(d: Dashboard, metric: "time" | "requests" | "changes" | "users", days: string[], only?: string): Series[] {
  const tenants = d.tenants.filter((t) => !only || t.id === only);
  return tenants.map((t, i) => {
    const values = days.map((day) => {
      if (metric === "changes") return d.changes_daily.filter((r) => r.day === day && r.tenant_id === t.id).reduce((a, r) => a + r.changes, 0);
      const rows = d.daily.filter((r) => r.day === day && r.tenant_id === t.id);
      return rows.reduce((a, r) => a + (metric === "time" ? r.seconds : metric === "requests" ? r.requests : r.users), 0);
    });
    return { key: t.id, label: t.name, color: colorOf(d.tenants.indexOf(t) >= 0 ? d.tenants.indexOf(t) : i), values };
  });
}

/* =====================================================================
   The console
   ===================================================================== */
export default function SuperAdminHome() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (NAV.some((n) => n.key === params.get("tab")) ? params.get("tab") : "overview") as Tab;
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const [days, setDays] = useDays();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [snapBusy, setSnapBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [people, setPeople] = useState<(TenantUserRow & { tenant_id: string; tenant: string })[] | null>(null);

  const [costsData, setCostsData] = useState<CostsData | null>(null);
  const [syncing, setSyncing] = useState(false);
  const load = async () => {
    setLoading(true); setErr("");
    try {
      const [a, b] = await Promise.all([loadDashboard(days), loadCosts(days).catch(() => null)]);
      setDash(a); setCostsData(b);
    } catch (e) { setErr((e as Error).message); }
    setLoading(false);
  };
  /** ask every provider for its real numbers, then reload them */
  const sync = async () => {
    setSyncing(true);
    try { await syncCosts(); setCostsData(await loadCosts(days)); } catch (e) { setErr(`Couldn't refresh the costs: ${(e as Error).message}`); }
    setSyncing(false);
  };
  // the providers' numbers are refreshed by themselves when they're older than 6 hours
  const autoSynced = useRef(false);
  useEffect(() => {
    if (autoSynced.current || !dash || !costsStale(costsData)) return;
    autoSynced.current = true;
    void sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dash, costsData]);
  useEffect(() => { void load(); setPeople(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [days]);

  // everyone, from every company (the Users and Costs tabs): one call per company, in parallel
  useEffect(() => {
    if (!dash || people || (tab !== "users" && tab !== "costs")) return;
    let alive = true;
    Promise.all(dash.tenants.map((t) => loadTenantDetail(t.id, days).then((r) => r.users.map((u) => ({ ...u, tenant_id: t.id, tenant: t.name })), () => [])))
      .then((lists) => { if (alive) setPeople(lists.flat().filter((u) => !u.is_superadmin)); });
    return () => { alive = false; };
  }, [dash, tab, days, people]);

  const costs = useMemo(() => withDefaults(dash?.settings), [dash]);
  const model = useMemo(() => (dash ? computeCosts(dash, costs, costsData) : null), [dash, costs, costsData]);

  const snapshot = async () => {
    setSnapBusy(true);
    try { await refreshUsage(); await load(); } catch (e) { setErr((e as Error).message); }
    setSnapBusy(false);
  };

  const saveSettings = async (c: CostSettings) => {
    const e = await saveCostSettings(c);
    if (!e && dash) setDash({ ...dash, settings: c });
    return e;
  };

  const tools = (
    <>
      <Period days={days} setDays={setDays} />
      <button className="sa-btn" onClick={() => void load()} disabled={loading} title="Reload">
        <RefreshCw size={15} strokeWidth={2} className={loading ? "sa-spin" : ""} /> <span>Refresh</span>
      </button>
    </>
  );

  return (
    <Shell tab={tab} onTab={setTab} scrollKey={tab}>
      {err && <div className="sa-alert"><b>Couldn't load the console.</b> {err}</div>}
      {!dash ? (
        <div className="sa-loading"><span className="sa-spinner" /> Loading the platform…</div>
      ) : (
        <div className={`sa-view ${loading ? "is-busy" : ""}`} key={tab}>
          {tab === "overview" && model && <Overview d={dash} m={model} c={costs} tools={tools} onTenant={(id) => navigate(`/superadmin/company/${id}`)} onSources={() => setTab("settings")} />}
          {tab === "companies" && model && (
            <Companies d={dash} m={model} c={costs} tools={tools} onOpen={(id) => navigate(`/superadmin/company/${id}`)} onNew={() => setShowCreate(true)} />
          )}
          {tab === "users" && model && <AllUsers d={dash} m={model} c={costs} people={people} tools={tools} onOpen={(id) => navigate(`/superadmin/company/${id}?tab=users`)} />}
          {tab === "costs" && model && <Costs d={dash} m={model} c={costs} people={people} tools={tools} onSave={saveSettings} />}
          {tab === "usage" && model && <Usage d={dash} c={costs} tools={tools} />}
          {tab === "data" && <DataView d={dash} tools={tools} onSnapshot={snapshot} busy={snapBusy} />}
          {tab === "settings" && <SourcesView d={dash} c={costs} k={costsData} m={model} syncing={syncing} onSync={() => void sync()} onSave={saveSettings} />}
        </div>
      )}
      {showCreate && <SuperAdminCreate onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void load(); }} />}
    </Shell>
  );
}

/* ---------- overview ---------- */
const COST_COLORS: Record<string, string> = {
  supabase: "#12b57f", compute: "#10b981", db: "#3b82f6", files: "#6366f1", egress: "#8b5cf6", mau: "#ec4899",
  hosting: "#f59e0b", email: "#f97316", ai: "#f43f5e",
};
const costColor = (k: string) => COST_COLORS[k] ?? "#84cc16";

function measuredSince(d: Dashboard) {
  const first = d.daily.length ? d.daily[0].day : null;
  return first;
}

function Overview({ d, m, c, tools, onTenant, onSources }: { d: Dashboard; m: CostModel; c: CostSettings; tools: ReactNode; onTenant: (id: string) => void; onSources: () => void }) {
  const days = dayList(d.since, d.days);
  const hasTime = d.daily.some((r) => r.seconds > 0);
  const [metric, setMetric] = useState<"time" | "changes" | "requests">(hasTime ? "time" : "changes");
  const series = activitySeries(d, metric, days);
  const fmtM = metric === "time" ? fmtDur : fmtNum;
  const active = d.tenants.filter((t) => t.active).length;
  const people = d.tenants.reduce((a, t) => a + t.users - t.deactivated, 0);
  const usedApp = d.tenants.reduce((a, t) => a + t.active_users, 0);
  const revenue = m.tenants.reduce((a, t) => a + (t.revenue ?? 0), 0);
  const parts = m.lines.filter((l) => l.amount > 0.004).map((l) => ({ key: l.key, label: l.label, value: l.amount, color: costColor(l.key) }));
  const pages = Object.entries(d.pages.reduce<Record<string, number>>((a, p) => { a[p.page] = (a[p.page] ?? 0) + p.seconds; return a; }, {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  const since = measuredSince(d);
  return (
    <>
      <Head kicker="Platform console" title="Overview" sub={`Last ${d.days} days · storage as of ${d.snapshot_day ? new Date(d.snapshot_day).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}`} right={tools} />
      {m.missing.length > 0 && (
        <div className="sa-connect">
          <AlertTriangle size={16} strokeWidth={2} />
          <span><b>{m.missing.map((p) => PROVIDERS[p].name).join(", ")}</b> {m.missing.length === 1 ? "isn't" : "aren't"} connected yet, so {m.missing.length === 1 ? "its cost is" : "their costs are"} {m.missing.includes("supabase") || m.missing.includes("anthropic") ? "estimated from list prices" : "missing"}.</span>
          <button className="sa-btn" onClick={onSources}><Plug size={14} /> <span>Connect</span></button>
        </div>
      )}
      {!hasTime && <Note>Time in the app, requests and data transfer are measured from this release on{since ? ` (first data ${since})` : ""}. Until there is some, activity shows the data changes people made, and costs are split by those.</Note>}
      <div className="sa-kpis">
        <Kpi label="Monthly cost" value={fmtMoney(m.total, c.currency)} sub={`${fmtMoney(m.fixed, c.currency)} fixed · ${fmtMoney(m.usage, c.currency)} usage · ${fmtMoney(m.ai, c.currency)} AI`} />
        {revenue > 0
          ? <Kpi label="Monthly margin" value={fmtMoney(revenue - m.total, c.currency)} sub={`${Math.round(((revenue - m.total) / revenue) * 100)}% of ${fmtMoney(revenue, c.currency)} revenue`} tone={revenue - m.total < 0 ? "bad" : undefined} />
          : <Kpi label="Cost per user" value={fmtMoney(people ? m.total / people : 0, c.currency)} sub={`${people} active users`} />}
        <Kpi label="Companies" value={`${active}`} sub={`${d.tenants.length - active} disabled · ${d.tenants.length} in total`} />
        <Kpi label="Users" value={fmtNum(people)} sub={`${d.mau} signed in last 30 days${hasTime ? ` · ${usedApp} used the app` : ""}`} />
        <Kpi label="Database" value={fmtBytes(d.db_bytes)} meter={d.db_bytes / (SUPABASE_UNITS.db_included_gb * 1024 ** 3)} sub={`of ${SUPABASE_UNITS.db_included_gb} GB included`} tone={d.db_bytes > SUPABASE_UNITS.db_included_gb * 1024 ** 3 * 0.85 ? "warn" : undefined} />
        <Kpi label="Files" value={fmtBytes(d.file_bytes)} meter={d.file_bytes / (SUPABASE_UNITS.file_included_gb * 1024 ** 3)} sub={`${fmtNum(d.file_count)} files · ${SUPABASE_UNITS.file_included_gb} GB included`} />
      </div>

      <div className="sa-row sa-row-wide">
        <Card title="Activity by company" sub={metric === "time" ? "Time actively using the app, per day" : metric === "requests" ? "Requests to the server, per day" : "Records created, edited or imported, per day"}
          right={<div className="sa-seg is-sm">{(["time", "requests", "changes"] as const).map((k) => <button key={k} className={metric === k ? "is-on" : ""} onClick={() => setMetric(k)}>{k === "time" ? "Time" : k === "requests" ? "Requests" : "Changes"}</button>)}</div>}>
          <TimeChart days={days} series={series} fmt={fmtM} />
          <Legend items={series.map((s) => ({ key: s.key, label: s.label, color: s.color, value: fmtM(s.values.reduce((a, b) => a + b, 0)) }))} />
        </Card>
        <Card title="Where the money goes" sub="Monthly run-rate">
          <div className="sa-donut-wrap">
            <Donut parts={parts} center={fmtMoney(m.total, c.currency)} sub="per month" />
            <Legend items={parts.map((p) => ({ key: p.key, label: p.label, color: p.color, value: fmtMoney(p.value, c.currency) }))} />
          </div>
        </Card>
      </div>

      <div className="sa-row">
        <Card title="Cost by company" sub={`Fixed costs split by ${allocLabel(c.allocation).toLowerCase()}`}>
          <HBars fmt={(v) => fmtMoney(v, c.currency)} rows={[...m.tenants].sort((a, b) => b.total - a.total).map((t) => ({
            key: t.id, value: t.total,
            label: <button className="sa-link" onClick={() => onTenant(t.id)}>{t.name}</button>,
            sub: t.margin != null ? `${fmtMoney(t.margin, c.currency)} margin` : `${fmtMoney(t.perUser, c.currency)} / user`,
            parts: [{ value: t.fixed, color: "#12b57f" }, { value: t.db + t.files + t.egress + t.mau, color: "#3b82f6" }, { value: t.ai, color: "#f43f5e" }],
          }))} />
          <Legend items={[{ key: "f", label: "Fixed share", color: "#12b57f" }, { key: "u", label: "Usage", color: "#3b82f6" }, { key: "a", label: "AI", color: "#f43f5e" }]} />
        </Card>
        <Card title="Data stored by company" sub="Database rows + files">
          <HBars fmt={fmtBytes} rows={[...d.tenants].sort((a, b) => (b.db_bytes + b.file_bytes) - (a.db_bytes + a.file_bytes)).map((t) => ({
            key: t.id, value: t.db_bytes + t.file_bytes,
            label: <button className="sa-link" onClick={() => onTenant(t.id)}>{t.name}</button>,
            sub: `${fmtNum(t.db_rows)} rows · ${fmtNum(t.file_count)} files`,
            parts: [{ value: t.db_bytes, color: "#3b82f6" }, { value: t.file_bytes, color: "#8b5cf6" }],
          }))} />
          <Legend items={[{ key: "d", label: "Database", color: "#3b82f6" }, { key: "f", label: "Files", color: "#8b5cf6" }]} />
        </Card>
      </div>

      <div className="sa-row">
        <Card title="Most used pages" sub="Active time, all companies">
          {pages.length
            ? <HBars fmt={fmtDur} rows={pages.map(([p, v]) => ({ key: p, label: pageLabel(p), value: v, color: "#12b57f" }))} />
            : <Empty>Page time appears here as soon as people use the app with this version.</Empty>}
        </Card>
        <Card title="Biggest tables" sub="Whole platform, on disk (data + indexes)">
          <HBars fmt={fmtBytes} rows={d.tables_top.slice(0, 8).map((t) => ({ key: t.name, label: <code>{t.name}</code>, sub: `${fmtNum(t.rows)} rows`, value: t.bytes, color: "#3b82f6" }))} />
        </Card>
      </div>
    </>
  );
}

export const allocLabel = (a: Allocation) => ({ usage: "Usage (½ storage, ½ activity)", storage: "Storage", activity: "Activity", seats: "Seats", equal: "Equally" }[a]);

/* ---------- companies ---------- */
type CoSort = "name" | "users" | "active" | "seen" | "storage" | "time" | "requests" | "ai" | "cost" | "margin";
function Companies({ d, m, c, tools, onOpen, onNew }: { d: Dashboard; m: CostModel; c: CostSettings; tools: ReactNode; onOpen: (id: string) => void; onNew: () => void }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: CoSort; dir: 1 | -1 }>({ key: "cost", dir: -1 });
  const hasTime = d.tenants.some((t) => t.seconds > 0);
  const rows = d.tenants.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase())).map((t) => ({ t, k: m.byId.get(t.id)! }));
  const val = (r: (typeof rows)[number]): number | string => {
    switch (sort.key) {
      case "name": return r.t.name.toLowerCase();
      case "users": return r.t.users;
      case "active": return hasTime ? r.t.active_users : r.t.signed_in_30d;
      case "seen": return r.t.last_seen ? new Date(r.t.last_seen).getTime() : 0;
      case "storage": return r.t.db_bytes + r.t.file_bytes;
      case "time": return hasTime ? r.t.seconds : r.t.changes;
      case "requests": return r.t.requests;
      case "ai": return r.t.ai_in + r.t.ai_out;
      case "cost": return r.k.total;
      case "margin": return r.k.margin ?? -Infinity;
    }
  };
  rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  return (
    <>
      <Head kicker="Platform console" title="Companies" sub={`${d.tenants.length} companies · last ${d.days} days`}
        right={<>{tools}<button className="sa-btn is-primary" onClick={onNew}><Plus size={16} strokeWidth={2.2} /> <span>New company</span></button></>} />
      <Card title={<span className="sa-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies" /></span>}>
        <div className="sa-tablewrap">
          <table className="sa-table">
            <thead><tr>
              <Th k="name" sort={sort} setSort={setSort}>Company</Th>
              <Th k="users" sort={sort} setSort={setSort} num>Seats</Th>
              <Th k="active" sort={sort} setSort={setSort} num>{hasTime ? "Active" : "Signed in"}</Th>
              <Th k="seen" sort={sort} setSort={setSort} num>Last seen</Th>
              <Th k="storage" sort={sort} setSort={setSort} num>Data stored</Th>
              <Th k="time" sort={sort} setSort={setSort} num>{hasTime ? "Time in app" : "Changes"}</Th>
              <Th k="requests" sort={sort} setSort={setSort} num>Requests</Th>
              <Th k="ai" sort={sort} setSort={setSort} num>AI tokens</Th>
              <Th k="cost" sort={sort} setSort={setSort} num>Cost / mo</Th>
              <Th k="margin" sort={sort} setSort={setSort} num>Margin</Th>
            </tr></thead>
            <tbody>
              {rows.map(({ t, k }, i) => (
                <tr key={t.id} className="is-click" onClick={() => onOpen(t.id)}>
                  <td>
                    <span className="sa-co">
                      <span className="sa-co-av" style={{ background: colorOf(d.tenants.indexOf(t) >= 0 ? d.tenants.indexOf(t) : i) }}>{initials(t.name)}</span>
                      <span className="sa-co-t"><b>{t.name}</b><small className={t.active ? "is-on" : "is-off"}>{t.active ? "Active" : "Disabled"}</small></span>
                    </span>
                  </td>
                  <td className="is-num">
                    <span className="sa-seats"><b>{t.users}</b>/{t.max_users}</span>
                    <span className="sa-meter is-sm"><i style={{ width: `${Math.min(100, (t.users / Math.max(1, t.max_users)) * 100)}%` }} /></span>
                  </td>
                  <td className="is-num">{hasTime ? t.active_users : t.signed_in_30d}</td>
                  <td className="is-num is-dim">{fmtAgo(t.last_seen)}</td>
                  <td className="is-num">{fmtBytes(t.db_bytes + t.file_bytes)}<small>{fmtNum(t.db_rows)} rows</small></td>
                  <td className="is-num">{hasTime ? fmtDur(t.seconds) : fmtNum(t.changes)}</td>
                  <td className="is-num">{fmtNum(t.requests)}<small>{fmtBytes(t.bytes)}</small></td>
                  <td className="is-num">{fmtNum(t.ai_in + t.ai_out)}</td>
                  <td className="is-num"><b>{fmtMoney(k.total, c.currency)}</b><small>{fmtMoney(k.perUser, c.currency)} / user</small></td>
                  <td className={`is-num ${k.margin != null && k.margin < 0 ? "is-bad" : ""}`}>{k.margin == null ? <span className="is-dim">—</span> : fmtMoney(k.margin, c.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty>No company matches.</Empty>}
        </div>
      </Card>
    </>
  );
}

/* ---------- users (every company) ---------- */
type UsSort = "name" | "company" | "role" | "signin" | "time" | "changes" | "requests" | "ai" | "cost";
function AllUsers({ d, m, c, people, tools, onOpen }: { d: Dashboard; m: CostModel; c: CostSettings; people: (TenantUserRow & { tenant_id: string; tenant: string })[] | null; tools: ReactNode; onOpen: (tenantId: string) => void }) {
  const [q, setQ] = useState("");
  const [co, setCo] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "off">("active");
  const [sort, setSort] = useState<{ key: UsSort; dir: 1 | -1 }>({ key: "cost", dir: -1 });
  const costBy = useMemo(() => {
    const out = new Map<string, number>();
    if (!people) return out;
    d.tenants.forEach((t) => userCosts(m.byId.get(t.id), people.filter((u) => u.tenant_id === t.id), d.ai.filter((a) => a.tenant_id === t.id)).forEach((v, k) => out.set(k, v)));
    return out;
  }, [people, d, m]);
  if (!people) return (<><Head kicker="Platform console" title="Users" right={tools} /><div className="sa-loading"><span className="sa-spinner" /> Loading everyone…</div></>);
  const hasTime = people.some((u) => u.seconds > 0);
  const ql = q.trim().toLowerCase();
  const rows = people.filter((u) => (!co || u.tenant_id === co) && (status === "all" || (status === "active" ? u.active : !u.active))
    && (!ql || `${personName(u)} ${u.email ?? ""} ${u.tenant} ${u.role ?? ""}`.toLowerCase().includes(ql)));
  const val = (u: (typeof rows)[number]): number | string => {
    switch (sort.key) {
      case "name": return personName(u).toLowerCase();
      case "company": return u.tenant.toLowerCase();
      case "role": return (u.role ?? "").toLowerCase();
      case "signin": return u.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : 0;
      case "time": return u.seconds;
      case "changes": return u.changes;
      case "requests": return u.requests;
      case "ai": return u.ai_in + u.ai_out;
      case "cost": return costBy.get(u.id) ?? 0;
    }
  };
  rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  return (
    <>
      <Head kicker="Platform console" title="Users" sub={`${people.filter((u) => u.active).length} active · ${people.filter((u) => !u.active).length} deactivated · every company`} right={tools} />
      <Card title={
        <span className="sa-filters">
          <span className="sa-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, e-mail, role" /></span>
          <select className="sa-select" value={co} onChange={(e) => setCo(e.target.value)}>
            <option value="">All companies</option>
            {d.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="sa-seg is-sm">{(["active", "off", "all"] as const).map((s) => <button key={s} className={status === s ? "is-on" : ""} onClick={() => setStatus(s)}>{s === "active" ? "Active" : s === "off" ? "Deactivated" : "All"}</button>)}</div>
        </span>
      } right={<span className="sa-count">{rows.length} shown</span>}>
        <div className="sa-tablewrap">
          <table className="sa-table">
            <thead><tr>
              <Th k="name" sort={sort} setSort={setSort}>Person</Th>
              <Th k="company" sort={sort} setSort={setSort}>Company</Th>
              <Th k="role" sort={sort} setSort={setSort} wide>Role</Th>
              <Th k="signin" sort={sort} setSort={setSort} num>Last sign-in</Th>
              {hasTime && <Th k="time" sort={sort} setSort={setSort} num>Time in app</Th>}
              <Th k="changes" sort={sort} setSort={setSort} num>Changes</Th>
              <Th k="requests" sort={sort} setSort={setSort} num wide>Requests</Th>
              <Th k="ai" sort={sort} setSort={setSort} num>AI tokens</Th>
              <Th k="cost" sort={sort} setSort={setSort} num>Cost / mo</Th>
            </tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className={`is-click ${u.active ? "" : "is-off"}`} onClick={() => onOpen(u.tenant_id)}>
                  <td><span className="sa-co"><span className="sa-co-av is-round">{initials(personName(u))}</span><span className="sa-co-t"><b>{personName(u)}</b><small>{u.email}</small></span></span></td>
                  <td>{u.tenant}</td>
                  <td className="is-dim is-wide">{u.role ? (ROLE_LABELS[u.role] ?? u.role) : "—"}{!u.active && <span className="sa-tag is-off">Deactivated</span>}</td>
                  <td className="is-num is-dim">{fmtAgo(u.last_sign_in_at)}</td>
                  {hasTime && <td className="is-num">{fmtDur(u.seconds)}{u.top_page && <small>mostly {pageLabel(u.top_page)}</small>}</td>}
                  <td className="is-num">{fmtNum(u.changes)}</td>
                  <td className="is-num is-wide">{fmtNum(u.requests)}</td>
                  <td className="is-num">{fmtNum(u.ai_in + u.ai_out)}</td>
                  <td className="is-num"><b>{fmtMoney(costBy.get(u.id) ?? 0, c.currency)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty>Nobody matches.</Empty>}
        </div>
      </Card>
    </>
  );
}

/* ---------- costs ---------- */
function Costs({ d, m, c, people, tools, onSave }: { d: Dashboard; m: CostModel; c: CostSettings; people: (TenantUserRow & { tenant_id: string; tenant: string })[] | null; tools: ReactNode; onSave: (c: CostSettings) => Promise<string | null> }) {
  const [alloc, setAlloc] = useState<Allocation>(c.allocation);
  useEffect(() => { setAlloc(c.allocation); }, [c.allocation]);
  const changeAlloc = (a: Allocation) => { setAlloc(a); void onSave({ ...c, allocation: a }); };
  const totalRev = m.tenants.reduce((a, t) => a + (t.revenue ?? 0), 0);
  // what each page costs: a company's non-AI cost spread over its pages by time
  const pageCost = new Map<string, number>();
  d.tenants.forEach((t) => {
    const tc = m.byId.get(t.id);
    const rows = d.pages.filter((p) => p.tenant_id === t.id);
    const sec = rows.reduce((a, p) => a + p.seconds, 0);
    if (!tc || !sec) return;
    rows.forEach((p) => pageCost.set(`${t.id}|${p.page}`, (tc.total - tc.ai) * (p.seconds / sec)));
  });
  const pagesAll = [...new Set(d.pages.map((p) => p.page))].sort((a, b) =>
    d.pages.filter((p) => p.page === b).reduce((s, p) => s + p.seconds, 0) - d.pages.filter((p) => p.page === a).reduce((s, p) => s + p.seconds, 0));
  const topUsers = useMemo(() => {
    if (!people) return [];
    const out: { u: TenantUserRow & { tenant: string }; v: number }[] = [];
    d.tenants.forEach((t) => userCosts(m.byId.get(t.id), people.filter((u) => u.tenant_id === t.id), d.ai.filter((a) => a.tenant_id === t.id))
      .forEach((v, id) => { const u = people.find((p) => p.id === id); if (u) out.push({ u, v }); }));
    return out.sort((a, b) => b.v - a.v).slice(0, 10);
  }, [people, d, m]);
  const lines = m.lines.filter((l) => l.amount > 0 || ["supabase", "db", "files", "egress", "ai"].includes(l.key));
  return (
    <>
      <Head kicker="Platform console" title="Costs" sub={`Monthly run-rate, from the last ${d.days} days`} right={tools} />
      <div className="sa-kpis is-4">
        <Kpi label="Total per month" value={fmtMoney(m.total, c.currency)} sub={`${fmtMoney(m.total * 12, c.currency, 0)} a year`} />
        <Kpi label="Fixed" value={fmtMoney(m.fixed, c.currency)} sub="Plan, compute, hosting, e-mail" />
        <Kpi label="Usage" value={fmtMoney(m.usage, c.currency)} sub="Above the plan's quotas" />
        <Kpi label="AI" value={fmtMoney(m.ai, c.currency)} sub={`${fmtNum(d.ai.reduce((a, r) => a + r.tin + r.tout, 0))} tokens in ${d.days} days`} />
      </div>
      <div className="sa-row sa-row-wide">
        <Card title="Cost lines" sub="Where each number comes from">
          <table className="sa-table is-plain">
            <thead><tr><th>Item</th><th>Source</th><th>Basis</th><th className="is-num">Per month</th><th className="is-num">Share</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td><span className="sa-dot" style={{ background: costColor(l.key) }} />{l.label}</td>
                  <td><Origin o={l.origin} /></td>
                  <td className="is-dim">{l.detail}</td>
                  <td className="is-num"><b>{fmtMoney(l.amount, c.currency)}</b></td>
                  <td className="is-num is-dim">{m.total ? Math.round((l.amount / m.total) * 100) : 0}%</td>
                </tr>
              ))}
              <tr className="is-total"><td>Total</td><td /><td /><td className="is-num"><b>{fmtMoney(m.total, c.currency)}</b></td><td className="is-num">100%</td></tr>
            </tbody>
          </table>
        </Card>
        <Card title="How fixed costs are split" sub="Between companies">
          <div className="sa-alloc">
            {(["usage", "storage", "activity", "seats", "equal"] as Allocation[]).map((a) => (
              <label key={a} className={`sa-radio ${alloc === a ? "is-on" : ""}`}>
                <input type="radio" name="alloc" checked={alloc === a} onChange={() => changeAlloc(a)} />
                <span><b>{allocLabel(a)}</b><small>{{
                  usage: "Half by data stored, half by activity. The fairest default.",
                  storage: "By database rows and files each company keeps.",
                  activity: m.activityBasis === "time" ? "By time spent in the app." : "By data changes (time in the app isn't measured yet).",
                  seats: "By number of users.", equal: "The same for every company.",
                }[a]}</small></span>
              </label>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Cost per company" sub={totalRev > 0 ? "With revenue and margin" : "Add each company's monthly revenue in Cost sources to see margins"}>
        <div className="sa-tablewrap">
          <table className="sa-table">
            <thead><tr><th>Company</th><th className="is-num">Split key</th><th className="is-num">Fixed share</th><th className="is-num">Database</th><th className="is-num">Files</th><th className="is-num">Transfer</th><th className="is-num">AI</th><th className="is-num">Total</th><th className="is-num">Per user</th><th className="is-num">Revenue</th><th className="is-num">Margin</th></tr></thead>
            <tbody>
              {[...m.tenants].sort((a, b) => b.total - a.total).map((t) => (
                <tr key={t.id}>
                  <td><b>{t.name}</b></td>
                  <td className="is-num is-dim">{Math.round(t.weight * 100)}%</td>
                  <td className="is-num">{fmtMoney(t.fixed, c.currency)}</td>
                  <td className="is-num">{fmtMoney(t.db, c.currency)}</td>
                  <td className="is-num">{fmtMoney(t.files, c.currency)}</td>
                  <td className="is-num">{fmtMoney(t.egress + t.mau, c.currency)}</td>
                  <td className="is-num">{fmtMoney(t.ai, c.currency)}</td>
                  <td className="is-num"><b>{fmtMoney(t.total, c.currency)}</b></td>
                  <td className="is-num">{fmtMoney(t.perUser, c.currency)}</td>
                  <td className="is-num">{t.revenue == null ? <span className="is-dim">—</span> : fmtMoney(t.revenue, c.currency)}</td>
                  <td className={`is-num ${t.margin != null && t.margin < 0 ? "is-bad" : t.margin != null ? "is-good" : ""}`}>{t.margin == null ? <span className="is-dim">—</span> : `${fmtMoney(t.margin, c.currency)} · ${Math.round((t.margin / (t.revenue || 1)) * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="sa-row">
        <Card title="Cost per page" sub="Each company's cost (without AI), spread over its pages by time spent">
          {pageCost.size ? (
            <Heat rows={pagesAll.map((p) => ({ key: p, label: pageLabel(p) }))} cols={d.tenants.filter((t) => d.pages.some((p) => p.tenant_id === t.id)).map((t) => ({ key: t.id, label: t.name }))}
              value={(p, t) => pageCost.get(`${t}|${p}`) ?? 0} fmt={(v) => fmtMoney(v, c.currency)} />
          ) : <Empty>Needs time-in-app data, which starts with this release.</Empty>}
        </Card>
        <Card title="Most expensive users" sub="Their share of the company's cost, plus their own AI">
          {!people ? <div className="sa-loading is-sm"><span className="sa-spinner" /> Loading…</div> : (
            <HBars fmt={(v) => fmtMoney(v, c.currency)} rows={topUsers.map(({ u, v }) => ({ key: u.id, label: personName(u), sub: u.tenant, value: v, color: "#12b57f" }))} />
          )}
        </Card>
      </div>
    </>
  );
}

/* ---------- usage ---------- */
function Usage({ d, c, tools }: { d: Dashboard; c: CostSettings; tools: ReactNode }) {
  const days = dayList(d.since, d.days);
  const hasTime = d.daily.some((r) => r.seconds > 0);
  const usersSeries = activitySeries(d, "users", days);
  const byPage = Object.values(d.pages.reduce<Record<string, { page: string; visits: number; seconds: number; requests: number; bytes: number; users: number }>>((a, p) => {
    const r = (a[p.page] ??= { page: p.page, visits: 0, seconds: 0, requests: 0, bytes: 0, users: 0 });
    r.visits += p.visits; r.seconds += p.seconds; r.requests += p.requests; r.bytes += p.bytes; r.users += p.users;
    return a;
  }, {})).sort((a, b) => b.seconds - a.seconds);
  const pageTenant = new Map(d.pages.map((p) => [`${p.page}|${p.tenant_id}`, p.seconds]));
  const aiRows = d.ai.map((r) => ({ ...r, cost: aiCost(r.model, r.tin, r.tout), tenant: d.tenants.find((t) => t.id === r.tenant_id)?.name ?? "—" }));
  return (
    <>
      <Head kicker="Platform console" title="Usage" sub={`What people do in the app · last ${d.days} days`} right={tools} />
      {!hasTime && <Note>Page time, requests and transfer start being recorded with this release, as people use the app.</Note>}
      <div className="sa-row sa-row-wide">
        <Card title="People using the app" sub="Distinct users per day, by company">
          <TimeChart days={days} series={usersSeries} fmt={fmtNum} />
          <Legend items={usersSeries.map((s) => ({ key: s.key, label: s.label, color: s.color }))} />
        </Card>
        <Card title="Data changes" sub="Records created, edited, imported">
          <TimeChart days={days} series={activitySeries(d, "changes", days)} fmt={fmtNum} />
        </Card>
      </div>
      <Card title="Pages" sub="All companies">
        <div className="sa-tablewrap">
          <table className="sa-table">
            <thead><tr><th>Page</th><th className="is-num">Time</th><th className="is-num">Visits</th><th className="is-num">Avg. visit</th><th className="is-num">Requests</th><th className="is-num">Transfer</th><th className="is-num">Requests / visit</th></tr></thead>
            <tbody>
              {byPage.map((p) => (
                <tr key={p.page}>
                  <td><b>{pageLabel(p.page)}</b></td>
                  <td className="is-num">{fmtDur(p.seconds)}</td>
                  <td className="is-num">{fmtNum(p.visits)}</td>
                  <td className="is-num">{fmtDur(p.visits ? p.seconds / p.visits : 0)}</td>
                  <td className="is-num">{fmtNum(p.requests)}</td>
                  <td className="is-num">{fmtBytes(p.bytes)}</td>
                  <td className="is-num">{p.visits ? (p.requests / p.visits).toFixed(1) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!byPage.length && <Empty>No page visits recorded yet.</Empty>}
        </div>
      </Card>
      <div className="sa-row">
        <Card title="Time per page and company">
          <Heat rows={byPage.map((p) => ({ key: p.page, label: pageLabel(p.page) }))} cols={d.tenants.filter((t) => d.pages.some((p) => p.tenant_id === t.id)).map((t) => ({ key: t.id, label: t.name }))}
            value={(p, t) => pageTenant.get(`${p}|${t}`) ?? 0} fmt={fmtDur} />
        </Card>
        <Card title="AI" sub="Calls to Claude, by company and feature">
          {aiRows.length ? (
            <table className="sa-table is-plain">
              <thead><tr><th>Company</th><th>Feature · model</th><th className="is-num">Calls</th><th className="is-num">Tokens</th><th className="is-num">Cost</th></tr></thead>
              <tbody>{aiRows.map((r, i) => (
                <tr key={i}><td>{r.tenant}</td><td className="is-dim">{r.feature.replace(/_/g, " ")} · {r.model}</td><td className="is-num">{r.calls}</td><td className="is-num">{fmtNum(r.tin + r.tout)}</td><td className="is-num">{fmtMoney(r.cost, c.currency)}</td></tr>
              ))}</tbody>
            </table>
          ) : <Empty>No AI calls in this period. Every call (proposal templates, contract reading, marketing writer) is logged from now on.</Empty>}
        </Card>
      </div>
    </>
  );
}

/* ---------- data & storage ---------- */
function DataView({ d, tools, onSnapshot, busy }: { d: Dashboard; tools: ReactNode; onSnapshot: () => void; busy: boolean }) {
  const allocated = d.tenants.reduce((a, t) => a + t.db_bytes, 0);
  const shared = d.unassigned?.db_bytes ?? 0;
  const system = Math.max(0, d.db_bytes - allocated - shared);
  const histDays = [...new Set(d.storage_history.map((r) => r.day))].sort();
  const histSeries: Series[] = d.tenants.map((t, i) => ({
    key: t.id, label: t.name, color: colorOf(i),
    values: histDays.map((day) => d.storage_history.filter((r) => r.day === day && r.tenant_id === t.id).reduce((a, r) => a + (r.db_bytes ?? 0) + (r.file_bytes ?? 0), 0)),
  }));
  return (
    <>
      <Head kicker="Platform console" title="Data & storage" sub={`Snapshot of ${d.snapshot_day ?? "—"} · taken every night at 03:15 UTC`}
        right={<>{tools}<button className="sa-btn is-primary" onClick={onSnapshot} disabled={busy}><RefreshCw size={15} strokeWidth={2.2} className={busy ? "sa-spin" : ""} /> <span>{busy ? "Measuring…" : "Measure now"}</span></button></>} />
      <div className="sa-kpis is-4">
        <Kpi label="Database" value={fmtBytes(d.db_bytes)} sub="Whole database on disk" />
        <Kpi label="Companies' data" value={fmtBytes(allocated)} sub={`${Math.round((allocated / Math.max(1, d.db_bytes)) * 100)}% of the database`} />
        <Kpi label="Shared & backups" value={fmtBytes(shared)} sub="Tables without a company (backups, catalogues)" />
        <Kpi label="System" value={fmtBytes(system)} sub="Auth, storage index, Postgres itself" />
      </div>
      <div className="sa-row sa-row-wide">
        <Card title="Storage over time" sub="Database + files per company (one point per daily snapshot)">
          <TimeChart days={histDays.length ? histDays : [d.snapshot_day ?? new Date().toISOString().slice(0, 10)]} series={histSeries} fmt={fmtBytes} />
          <Legend items={histSeries.map((s) => ({ key: s.key, label: s.label, color: s.color }))} />
        </Card>
        <Card title="By company">
          <HBars fmt={fmtBytes} rows={[...d.tenants].sort((a, b) => (b.db_bytes + b.file_bytes) - (a.db_bytes + a.file_bytes)).map((t) => ({
            key: t.id, label: t.name, sub: `${fmtNum(t.db_rows)} rows · ${fmtNum(t.file_count)} files`, value: t.db_bytes + t.file_bytes,
            parts: [{ value: t.db_bytes, color: "#3b82f6" }, { value: t.file_bytes, color: "#8b5cf6" }],
          }))} />
          <Legend items={[{ key: "d", label: "Database", color: "#3b82f6" }, { key: "f", label: "Files", color: "#8b5cf6" }]} />
        </Card>
      </div>
      <Card title="Biggest tables" sub="All companies together · open a company for its own tables">
        <HBars fmt={fmtBytes} rows={d.tables_top.map((t) => ({ key: t.name, label: <code>{t.name}</code>, sub: `${fmtNum(t.rows)} rows`, value: t.bytes, color: /bk|backup|dupes/i.test(t.name) ? "#f59e0b" : "#3b82f6" }))} />
        {d.tables_top.some((t) => /bk|backup|dupes/i.test(t.name)) && <Note>Yellow tables are backups from data fixes. They still take disk space and could be dropped once they're no longer needed.</Note>}
      </Card>
    </>
  );
}

/* ---------- cost sources ---------- */
export const PROVIDERS: Record<Provider, { name: string; what: string; secrets: { key: string; note: string }[]; where: string; url: string }> = {
  supabase: {
    name: "Supabase", what: "Plan, every project in the organization and its compute add-on, with their prices",
    secrets: [{ key: "SB_MANAGEMENT_TOKEN", note: "a personal access token (names can't start with SUPABASE_)" }],
    where: "supabase.com → Account → Access tokens", url: "https://supabase.com/dashboard/account/tokens",
  },
  anthropic: {
    name: "Anthropic", what: "What Claude really cost, per day and model (Cost API)",
    secrets: [{ key: "ANTHROPIC_ADMIN_KEY", note: "an Admin key, sk-ant-admin…" }, { key: "ANTHROPIC_WORKSPACE_ID", note: "optional: only one workspace" }],
    where: "console.anthropic.com → Settings → Admin keys", url: "https://console.anthropic.com/settings/admin-keys",
  },
  vercel: {
    name: "Vercel", what: "Hosting charges, per day and service (billing API)",
    secrets: [{ key: "VERCEL_TOKEN", note: "an access token" }, { key: "VERCEL_TEAM_ID", note: "if the project is in a team" }, { key: "VERCEL_PROJECT", note: "optional: only this project" }],
    where: "vercel.com → Account settings → Tokens", url: "https://vercel.com/account/tokens",
  },
  resend: {
    name: "Resend", what: "E-mails sent by this app (Resend has no billing API: the plan follows the volume)",
    secrets: [{ key: "RESEND_API_KEY", note: "a full-access key" }],
    where: "resend.com → API Keys", url: "https://resend.com/api-keys",
  },
};
const ORIGIN_LABEL: Record<CostOrigin, string> = { live: "Live API", measured: "Measured", estimate: "Estimate", missing: "Not connected" };
export const Origin = ({ o }: { o: CostOrigin }) => <span className={`sa-origin is-${o}`}>{ORIGIN_LABEL[o]}</span>;

function SourcesView({ d, c, k, m, syncing, onSync, onSave }: { d: Dashboard; c: CostSettings; k: CostsData | null; m: CostModel | null; syncing: boolean; onSync: () => void; onSave: (c: CostSettings) => Promise<string | null> }) {
  const [rev, setRev] = useState<Record<string, number>>(c.revenue);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRev(c.revenue); }, [c.revenue]);
  const dirty = JSON.stringify(rev) !== JSON.stringify(c.revenue);
  const saveRev = async () => {
    setBusy(true);
    const e = await onSave({ ...c, revenue: rev });
    setBusy(false);
    setMsg(e ? { ok: false, t: e } : { ok: true, t: "Saved." });
  };
  const byP = (p: Provider): CostSource | undefined => k?.sources.find((s) => s.provider === p);
  const lastSync = k?.sources.map((s) => s.synced_at).filter(Boolean).sort().pop() ?? null;
  const ref = (() => { try { return new URL(import.meta.env.VITE_SUPABASE_URL as string).hostname.split(".")[0]; } catch { return ""; } })();
  return (
    <>
      <Head kicker="Platform console" title="Cost sources" sub={`Every cost comes from the provider's own API or from the database. Last refreshed ${fmtAgo(lastSync).toLowerCase()}, then every 6 hours.`}
        right={<button className="sa-btn is-primary" onClick={onSync} disabled={syncing}><RefreshCw size={15} strokeWidth={2.2} className={syncing ? "sa-spin" : ""} /> <span>{syncing ? "Asking the providers…" : "Refresh now"}</span></button>} />
      <div className="sa-sources">
        {(Object.keys(PROVIDERS) as Provider[]).map((p) => {
          const info = PROVIDERS[p];
          const src = byP(p);
          const st = src?.status ?? "missing";
          const line = m?.lines.find((l) => l.provider === p);
          return (
            <section key={p} className={`sa-card sa-source is-${st}`}>
              <div className="sa-source-h">
                <span className="sa-source-name">{info.name}</span>
                <span className={`sa-pill is-${st}`}>
                  {st === "ok" ? <CheckCircle2 size={13} /> : st === "error" ? <AlertTriangle size={13} /> : <CircleDashed size={13} />}
                  {st === "ok" ? "Connected" : st === "error" ? "Error" : "Not connected"}
                </span>
              </div>
              <p className="sa-source-what">{info.what}</p>
              {line && st === "ok" && <div className="sa-source-amt"><b>{fmtMoney(line.amount, c.currency)}</b><span>per month for this app</span></div>}
              {src?.message && <p className={`sa-source-msg ${st === "error" ? "is-bad" : ""}`}>{src.message}</p>}
              {p === "supabase" && st === "ok" && Array.isArray(src?.monthly?.projects) && (
                <table className="sa-table is-plain is-mini">
                  <thead><tr><th>Project</th><th>Compute</th><th className="is-num">Per month</th></tr></thead>
                  <tbody>{(src!.monthly.projects as { ref: string; name: string; compute: string; computeUsd: number; addonsUsd: number }[]).map((x) => (
                    <tr key={x.ref}><td>{x.name}{x.ref === ref && <span className="sa-tag is-on">this app</span>}</td><td className="is-dim">{x.compute}</td><td className="is-num">{fmtMoney(x.computeUsd + x.addonsUsd, c.currency)}</td></tr>
                  ))}</tbody>
                </table>
              )}
              {p === "supabase" && st === "ok" && (
                <p className="sa-source-msg">Organization: {fmtMoney(Number(src!.monthly.org_total_usd) || 0, c.currency)}/month ({String(src!.monthly.plan)} plan {fmtMoney(Number(src!.monthly.plan_usd) || 0, c.currency)}, less {fmtMoney(Number(src!.monthly.credits_usd) || 0, c.currency)} compute credits).</p>
              )}
              {st !== "ok" && (
                <div className="sa-source-how">
                  <span>To connect: in <b>Supabase → Edge Functions → Secrets</b>, add</span>
                  <ul>{info.secrets.map((x) => <li key={x.key}><code>{x.key}</code> {x.note}</li>)}</ul>
                  <a href={info.url} target="_blank" rel="noreferrer">Get it at {info.where} <ArrowUpRight size={12} /></a>
                  <span className="sa-source-then">Then press <b>Refresh now</b>.</span>
                </div>
              )}
              {src?.synced_at && <span className="sa-source-at">Checked {fmtAgo(src.synced_at).toLowerCase()}</span>}
            </section>
          );
        })}
        <section className="sa-card sa-source is-ok">
          <div className="sa-source-h"><span className="sa-source-name">Your database</span><span className="sa-pill is-ok"><CheckCircle2 size={13} /> Built in</span></div>
          <p className="sa-source-what">Size of every company's data and files, users, page time, requests and transfer: measured inside the app and the database.</p>
          <div className="sa-source-amt"><b>{fmtBytes(d.db_bytes + d.file_bytes)}</b><span>stored · {d.mau} monthly users</span></div>
          <span className="sa-source-at">Storage measured {d.snapshot_day ?? "—"} · nightly at 03:15 UTC</span>
        </section>
      </div>

      <Card title="Revenue per company" sub="Optional. What each company pays you per month, the one figure no API has, used for margins"
        right={<button className="sa-btn is-primary" onClick={() => void saveRev()} disabled={!dirty || busy}>{busy ? "Saving…" : "Save"}</button>}>
        {msg && <div className={`sa-alert ${msg.ok ? "is-ok" : ""}`}>{msg.t}</div>}
        <div className="sa-form is-3">
          {d.tenants.map((t) => (
            <label key={t.id} className="sa-nf">
              <span>{t.name}</span>
              <span className="sa-nf-in"><i>{c.currency}</i><input type="number" min={0} value={rev[t.id] ?? 0} onChange={(e) => { setRev({ ...rev, [t.id]: Number(e.target.value) }); setMsg(null); }} /><i>/ month</i></span>
              <small>{t.users} users</small>
            </label>
          ))}
        </div>
      </Card>
    </>
  );
}
