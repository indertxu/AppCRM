import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, KeyRound, Trash2, Plus, RefreshCw, Pencil, Check, X, Power, Search, Wand2, ArrowRight, LayoutGrid, Feather, Copy } from "lucide-react";
import { supabase } from "../../api/supabase";
import {
  deleteUser, toggleTenant, updateTenant, setTenantPlan, PLAN_LABEL, type TenantPlan, loadDashboard, loadTenantDetail, loadCosts, computeCosts, userCosts, withDefaults, aiCost,
  fmtBytes, fmtNum, fmtDur, fmtMoney, fmtAgo, pageLabel, dayList,
  type Dashboard, type TenantDetail, type TenantUserRow, type CostsData,
} from "../../api/superadminApi";
import {
  Shell, Period, Card, Kpi, Note, Empty, TimeChart, HBars, Heat, Legend, Donut, Th, useDays, colorOf, Modal, useConfirm, PersonCell, RolePicker,
  initials, personName, ROLE_LABELS, allocLabel, type Tab, type Series,
} from "./SuperAdminHome";
import "./SuperAdmin.css";
import { passwordProblem, PASSWORD_HINT } from "../../login/LoginPage";
import { NewLoginModal, PwRules, makePw } from "./SuperAdminCreate";

type CTab = "overview" | "users" | "usage" | "data" | "costs";
const CTABS: { key: CTab; label: string }[] = [
  { key: "overview", label: "Overview" }, { key: "users", label: "Users" }, { key: "usage", label: "Usage" },
  { key: "data", label: "Data" }, { key: "costs", label: "Costs" },
];

/** One company: its people (with e-mail and last sign-in), what they use, what it stores and what it costs. */
export default function SuperAdminClient() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (CTABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "overview") as CTab;
  const setTab = (t: CTab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const [days, setDays] = useDays();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [det, setDet] = useState<TenantDetail | null>(null);
  const [costsData, setCostsData] = useState<CostsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = async () => {
    setLoading(true); setErr("");
    try {
      const [a, b, k] = await Promise.all([loadDashboard(days), loadTenantDetail(id, days), loadCosts(days).catch(() => null)]);
      setDash(a); setDet(b); setCostsData(k);
    } catch (e) { setErr((e as Error).message); }
    setLoading(false);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id, days]);

  const costs = useMemo(() => withDefaults(dash?.settings), [dash]);
  const model = useMemo(() => (dash ? computeCosts(dash, costs, costsData) : null), [dash, costs, costsData]);
  const tc = model?.byId.get(id);
  const dt = dash?.tenants.find((t) => t.id === id);
  const people = useMemo(() => (det?.users ?? []).filter((u) => !u.is_superadmin), [det]);
  const uCost = useMemo(() => userCosts(tc, people, det?.ai ?? []), [tc, people, det]);
  const tIndex = dash ? Math.max(0, dash.tenants.findIndex((t) => t.id === id)) : 0;

  const goConsole = (t: Tab) => navigate(t === "overview" ? "/superadmin" : `/superadmin?tab=${t}`);

  // name / limit / on-off
  const [editName, setEditName] = useState<string | null>(null);
  const saveName = async () => {
    if (!det?.tenant || editName == null || !editName.trim()) { setEditName(null); return; }
    const r = await updateTenant(det.tenant.id, { name: editName.trim() });
    if (r?.error) setErr(r.error); else setDet({ ...det, tenant: { ...det.tenant, name: editName.trim() } });
    setEditName(null);
  };
  const changeLimit = async (delta: number) => {
    if (!det?.tenant) return;
    const next = Math.max(people.length, det.tenant.max_users + delta);
    if (next === det.tenant.max_users) return;
    setDet({ ...det, tenant: { ...det.tenant, max_users: next } });
    const r = await updateTenant(det.tenant.id, { maxUsers: next });
    if (r?.error) { setErr(r.error); void load(); }
  };
  const [ask, askEl] = useConfirm();
  const [planBusy, setPlanBusy] = useState(false);
  const changePlan = async (plan: TenantPlan) => {
    if (!det?.tenant || (det.tenant.plan ?? "enterprise") === plan) return;
    const from = (det.tenant.plan ?? "enterprise") as TenantPlan;
    const ok = await ask({
      kicker: "Change the app", title: `Move ${det.tenant.name} to ${PLAN_LABEL[plan]}?`, ok: `Move to ${PLAN_LABEL[plan]}`, tone: plan === "base" ? "base" : undefined,
      icon: plan === "base" ? <Feather size={19} strokeWidth={1.9} /> : <LayoutGrid size={19} strokeWidth={1.9} />,
      body: (
        <div className="sa-ask-plan">
          <div className="sa-ask-flow">
            <span className={`sa-plan-chip is-${from}`}>{PLAN_LABEL[from]}</span>
            <ArrowRight size={16} strokeWidth={2.2} />
            <span className={`sa-plan-chip is-${plan}`}>{PLAN_LABEL[plan]}</span>
          </div>
          <ul className="sa-ask-list">
            <li>Its people get the {plan === "base" ? "simple Base app (home, tasks, calendar, people, clients)" : "full Enterprise app"} the next time they open it.</li>
            <li>Nothing is deleted: you can switch back at any time.</li>
          </ul>
        </div>
      ),
    });
    if (!ok) return;
    setPlanBusy(true);
    const e = await setTenantPlan(det.tenant.id, plan);
    setPlanBusy(false);
    if (e) { setErr(e); return; }
    setDet({ ...det, tenant: { ...det.tenant, plan } });
  };
  const toggle = async () => {
    if (!det?.tenant) return;
    const on = !det.tenant.active;
    if (!on && !(await ask({
      kicker: "Disable company", title: `Disable ${det.tenant.name}?`, ok: "Disable", tone: "danger", icon: <Power size={19} strokeWidth={2} />,
      body: <ul className="sa-ask-list"><li>Its people can't sign in to the app until you enable it again.</li><li>Its data stays exactly as it is.</li></ul>,
    }))) return;
    await toggleTenant(det.tenant.id, on);
    setDet({ ...det, tenant: { ...det.tenant, active: on } });
  };

  const t = det?.tenant;
  return (
    <Shell tab="companies" onTab={goConsole} scrollKey={tab} ready={!!det || !!err}>
      {err && <div className="sa-alert"><b>Something went wrong.</b> {err}</div>}
      {!det || !dash || !model ? (
        loading ? <div className="sa-loading"><span className="sa-spinner" /> Loading the company…</div> : <Empty>Company not found.</Empty>
      ) : !t ? <Empty>Company not found.</Empty> : (
        <div className={`sa-view ${loading ? "is-busy" : ""}`}>
          <header className="sa-hero is-co" style={{ ["--co" as string]: colorOf(tIndex) }}>
            <i className="sa-hero-glow" aria-hidden="true" />
            <div className="sa-hero-main">
              <span className="sa-hero-av">{initials(t.name)}</span>
              <div className="sa-hero-id">
                <button className="sa-hero-crumb" onClick={() => navigate("/superadmin?tab=companies")}><ChevronLeft size={13} strokeWidth={2.6} /> Companies</button>
                {editName != null ? (
                  <span className="sa-rename">
                    <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveName(); if (e.key === "Escape") setEditName(null); }} aria-label="Company name" />
                    <button className="sa-icon" onClick={() => void saveName()} aria-label="Save name"><Check size={16} /></button>
                    <button className="sa-icon" onClick={() => setEditName(null)} aria-label="Cancel"><X size={16} /></button>
                  </span>
                ) : (
                  <h1 className="sa-hero-name">
                    <span>{t.name}</span>
                    <button className="sa-hero-edit" onClick={() => setEditName(t.name)} aria-label="Rename" title="Rename"><Pencil size={14} /></button>
                  </h1>
                )}
                <div className="sa-hero-meta">
                  <span className={`sa-hero-state ${t.active ? "is-on" : "is-off"}`}><i />{t.active ? "Active" : "Disabled"}</span>
                  <span className="sa-plan-sw" role="radiogroup" aria-label="App">
                    {(["enterprise", "base"] as TenantPlan[]).map((p) => (
                      <button key={p} type="button" role="radio" aria-checked={(t.plan ?? "enterprise") === p} disabled={planBusy}
                        className={(t.plan ?? "enterprise") === p ? `is-on is-${p}` : ""} onClick={() => void changePlan(p)}
                        title={p === "base" ? "The simple app: home, tasks, calendar, people & companies, clients" : "The full app"}>{PLAN_LABEL[p]}</button>
                    ))}
                  </span>
                  <span className="sa-hero-fact"><b>{people.length}</b>/{t.max_users} seats</span>
                  <span className="sa-hero-fact is-since">Since <b>{new Date(t.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</b></span>
                  <span className="sa-hero-fact">Last seen <b>{fmtAgo(dt?.last_seen ?? null).toLowerCase()}</b></span>
                </div>
              </div>
              <div className="sa-hero-tools">
                <Period days={days} setDays={setDays} />
                <button className="sa-btn" onClick={() => void load()} disabled={loading} title="Reload"><RefreshCw size={15} className={loading ? "sa-spin" : ""} /> <span>Refresh</span></button>
                <button className={`sa-btn ${t.active ? "is-danger" : "is-primary"}`} onClick={() => void toggle()}><Power size={15} /> <span>{t.active ? "Disable" : "Enable"}</span></button>
              </div>
            </div>
            <nav className="sa-hero-tabs" role="tablist">
              {CTABS.map((x) => (
                <button key={x.key} role="tab" aria-selected={tab === x.key} className={tab === x.key ? "is-on" : ""} onClick={() => setTab(x.key)}>
                  {x.label}{x.key === "users" && <i>{people.length}</i>}
                </button>
              ))}
            </nav>
          </header>

          {tab === "overview" && dt && tc && (
            <CoOverview det={det} dash={dash} dt={dt} tc={tc} cur={costs.currency} color={colorOf(tIndex)} people={people} uCost={uCost} onLimit={changeLimit} onTab={setTab} />
          )}
          {tab === "users" && <CoUsers det={det} people={people} uCost={uCost} cur={costs.currency} maxUsers={t.max_users} color={colorOf(tIndex)} onChanged={() => void load()} onLimit={changeLimit} />}
          {tab === "usage" && <CoUsage det={det} people={people} />}
          {tab === "data" && <CoData det={det} />}
          {tab === "costs" && tc && (
            <CoCosts det={det} tc={tc} model={model} cur={costs.currency} alloc={allocLabel(costs.allocation)} people={people} uCost={uCost} aiPrice={aiCost} />
          )}
        </div>
      )}
      {askEl}
    </Shell>
  );
}

type DT = Dashboard["tenants"][number];
type TC = NonNullable<ReturnType<typeof computeCosts>["byId"] extends Map<string, infer V> ? V : never>;

function CoOverview({ det, dash, dt, tc, cur, color, people, uCost, onLimit, onTab }: {
  det: TenantDetail; dash: Dashboard; dt: DT; tc: TC; cur: string; color: string; people: TenantUserRow[];
  uCost: Map<string, number>; onLimit: (d: number) => void; onTab: (t: CTab) => void;
}) {
  const days = dayList(det.since, det.days);
  const hasTime = det.daily.some((r) => r.seconds > 0);
  const series: Series[] = [{
    key: "a", label: hasTime ? "Time in app" : "Data changes", color,
    values: days.map((day) => hasTime ? det.daily.filter((r) => r.day === day).reduce((a, r) => a + r.seconds, 0) : det.changes_daily.filter((r) => r.day === day).reduce((a, r) => a + r.changes, 0)),
  }];
  const live = people.filter((u) => u.active);
  const seatPct = det.tenant ? people.length / Math.max(1, det.tenant.max_users) : 0;
  const top = [...people].sort((a, b) => (hasTime ? b.seconds - a.seconds : b.changes - a.changes)).slice(0, 6);
  const platformShare = dash.db_bytes ? dt.db_bytes / dash.db_bytes : 0;
  return (
    <>
      {!hasTime && <Note>Time in the app is measured from this release on. Until then, activity shows the data changes people made.</Note>}
      <div className="sa-kpis">
        <div className="sa-kpi">
          <span className="sa-kpi-k">Seats</span>
          <span className="sa-seat-edit">
            <button onClick={() => onLimit(-1)} disabled={!det.tenant || det.tenant.max_users <= people.length} aria-label="Fewer seats">−</button>
            <b className="sa-kpi-v">{people.length}<small>/{det.tenant?.max_users}</small></b>
            <button onClick={() => onLimit(1)} aria-label="More seats">+</button>
          </span>
          <span className="sa-meter"><i style={{ width: `${Math.min(100, seatPct * 100)}%` }} /></span>
          <span className="sa-kpi-s">{live.length} active · {people.length - live.length} deactivated</span>
        </div>
        <Kpi label="Active people" value={hasTime ? dt.active_users : dt.signed_in_30d} sub={hasTime ? `used the app in ${det.days} days` : "signed in, last 30 days"} />
        <Kpi label={hasTime ? "Time in app" : "Data changes"} value={hasTime ? fmtDur(dt.seconds) : fmtNum(dt.changes)} sub={hasTime ? `${fmtNum(dt.visits)} page visits` : `in ${det.days} days`} />
        <Kpi label="Data stored" value={fmtBytes(dt.db_bytes + dt.file_bytes)} sub={`${fmtNum(dt.db_rows)} rows · ${fmtNum(dt.file_count)} files · ${Math.round(platformShare * 100)}% of the DB`} />
        <Kpi label="Cost per month" value={fmtMoney(tc.total, cur)} sub={`${fmtMoney(tc.perUser, cur)} per user`} />
        <Kpi label={tc.margin != null ? "Margin" : "Revenue"} value={tc.margin != null ? fmtMoney(tc.margin, cur) : "—"}
          sub={tc.revenue != null ? `${Math.round((tc.margin! / tc.revenue) * 100)}% of ${fmtMoney(tc.revenue, cur)}` : "Set it in Cost sources"} tone={tc.margin != null && tc.margin < 0 ? "bad" : undefined} />
      </div>
      <div className="sa-row sa-row-wide">
        <Card title={hasTime ? "Time in the app" : "Data changes"} sub="Per day">
          <TimeChart days={days} series={series} fmt={hasTime ? fmtDur : fmtNum} />
        </Card>
        <Card title="Most active people" right={<button className="sa-link" onClick={() => onTab("users")}>All users</button>}>
          <HBars fmt={hasTime ? fmtDur : fmtNum} rows={top.map((u) => ({ key: u.id, label: personName(u), sub: `${fmtMoney(uCost.get(u.id) ?? 0, cur)} / mo`, value: hasTime ? u.seconds : u.changes, color }))} />
        </Card>
      </div>
      <div className="sa-row">
        <Card title="Pages they use" right={<button className="sa-link" onClick={() => onTab("usage")}>Usage</button>}>
          {det.pages.length
            ? <HBars fmt={fmtDur} rows={det.pages.slice(0, 8).map((p) => ({ key: p.page, label: pageLabel(p.page), sub: `${p.users} people · ${fmtNum(p.visits)} visits`, value: p.seconds, color }))} />
            : <Empty>Appears as soon as they use the app with this version.</Empty>}
        </Card>
        <Card title="What they store" right={<button className="sa-link" onClick={() => onTab("data")}>Data</button>}>
          <HBars fmt={fmtBytes} rows={det.tables.slice(0, 8).map((x) => ({ key: x.name, label: <code>{x.name}</code>, sub: `${fmtNum(x.rows)} rows`, value: x.bytes, color: "#3b82f6" }))} />
        </Card>
      </div>
    </>
  );
}

type USort = "name" | "role" | "signin" | "time" | "changes" | "requests" | "ai" | "cost";
function CoUsers({ det, people, uCost, cur, maxUsers, color, onChanged, onLimit }: {
  det: TenantDetail; people: TenantUserRow[]; uCost: Map<string, number>; cur: string; maxUsers: number; color: string; onChanged: () => void; onLimit: (d: number) => void;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: USort; dir: 1 | -1 }>({ key: "signin", dir: -1 });
  const [adding, setAdding] = useState(false);
  const [pwFor, setPwFor] = useState<TenantUserRow | null>(null);
  const [pw, setPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState("");
  const [pwDone, setPwDone] = useState(false);
  const hasTime = people.some((u) => u.seconds > 0);
  const atLimit = people.length >= maxUsers;
  const [ask, askEl] = useConfirm();
  const [copied, setCopied] = useState(false);
  const copy = (v: string) => { void navigator.clipboard?.writeText(v).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }, () => undefined); };

  const removeUser = async (u: TenantUserRow) => {
    const ok = await ask({
      kicker: "Delete login", title: `Delete ${personName(u)}?`, ok: "Delete login", tone: "danger", icon: <Trash2 size={19} strokeWidth={1.9} />,
      body: <ul className="sa-ask-list"><li>Their login is removed for good{u.email ? <> (<b>{u.email}</b>)</> : null}.</li><li>To keep their name on past work, deactivate them in the company's Settings instead.</li></ul>,
    });
    if (!ok) return;
    await deleteUser(u.id);
    onChanged();
  };
  /** Passwords live in auth.users, which only the service role can write: through the edge function. */
  const savePassword = async () => {
    if (!pwFor) return;
    const weak = passwordProblem(pw.trim());
    if (weak) { setPwErr(weak); return; }
    setPwBusy(true); setPwErr("");
    const { data, error } = await supabase.functions.invoke("manage-tenants", { body: { action: "set_password", userId: pwFor.id, password: pw.trim() } });
    setPwBusy(false);
    if (error || (data && data.error)) { setPwErr(error?.message ?? data.error); return; }
    setPwDone(true);
  };
  const randomPw = () => setPw(makePw());

  const ql = q.trim().toLowerCase();
  const rows = people.filter((u) => !ql || `${personName(u)} ${u.email ?? ""} ${u.role ?? ""} ${u.department ?? ""}`.toLowerCase().includes(ql));
  const val = (u: TenantUserRow): number | string => {
    switch (sort.key) {
      case "name": return personName(u).toLowerCase();
      case "role": return (u.role ?? "").toLowerCase();
      case "signin": return u.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : 0;
      case "time": return u.seconds;
      case "changes": return u.changes;
      case "requests": return u.requests;
      case "ai": return u.ai_in + u.ai_out;
      case "cost": return uCost.get(u.id) ?? 0;
    }
  };
  rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });

  return (
    <>
      <Card
        title={<span className="sa-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" /></span>}
        right={<>
          <span className="sa-count">{people.length} of {maxUsers} seats</span>
          {atLimit
            ? <button className="sa-btn" onClick={() => onLimit(1)}><Plus size={15} /> <span>Add a seat</span></button>
            : <button className="sa-btn is-primary" onClick={() => setAdding(true)}><Plus size={15} /> <span>Add user</span></button>}
        </>}
      >
        <div className="sa-tablewrap">
          <table className="sa-table">
            <thead><tr>
              <Th k="name" sort={sort} setSort={setSort}>Person</Th>
              <Th k="role" sort={sort} setSort={setSort}>Role</Th>
              <Th k="signin" sort={sort} setSort={setSort} num>Last sign-in</Th>
              {hasTime && <Th k="time" sort={sort} setSort={setSort} num>Time in app</Th>}
              <Th k="changes" sort={sort} setSort={setSort} num>Changes</Th>
              <Th k="requests" sort={sort} setSort={setSort} num wide>Requests</Th>
              <Th k="ai" sort={sort} setSort={setSort} num>AI tokens</Th>
              <Th k="cost" sort={sort} setSort={setSort} num>Cost / mo</Th>
              <th className="is-act" />
            </tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className={u.active ? "" : "is-off"}>
                  <td><PersonCell u={u} color={color} /></td>
                  <td className="is-dim"><RolePicker userId={u.id} tenantId={det.tenant?.id ?? ""} role={u.role} dept={u.department} disabled={!det.tenant} onChanged={() => onChanged()} /></td>
                  <td className="is-num is-dim">{fmtAgo(u.last_sign_in_at)}<small>since {u.created_at ? new Date(u.created_at).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "—"}</small></td>
                  {hasTime && <td className="is-num">{fmtDur(u.seconds)}{u.top_page && <small>mostly {pageLabel(u.top_page)}</small>}</td>}
                  <td className="is-num">{fmtNum(u.changes)}</td>
                  <td className="is-num is-wide">{fmtNum(u.requests)}<small>{fmtBytes(u.bytes)}</small></td>
                  <td className="is-num">{fmtNum(u.ai_in + u.ai_out)}</td>
                  <td className="is-num"><b>{fmtMoney(uCost.get(u.id) ?? 0, cur)}</b></td>
                  <td className="is-act">
                    <button className="sa-icon" onClick={() => { setPwFor(u); setPw(""); setPwErr(""); setPwDone(false); }} title="Set a new password" aria-label="Set a new password"><KeyRound size={15} /></button>
                    <button className="sa-icon is-danger" onClick={() => void removeUser(u)} title="Delete login" aria-label="Delete login"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty>{people.length ? "Nobody matches." : "No users yet."}</Empty>}
        </div>
      </Card>

      {adding && !atLimit && det.tenant && (
        <NewLoginModal
          companies={[{ id: det.tenant.id, name: det.tenant.name, users: people.length, max: maxUsers, plan: det.tenant.plan === "base" ? "base" : "enterprise", color, active: det.tenant.active }]}
          onClose={() => setAdding(false)}
          onCreated={() => { setAdding(false); onChanged(); }} />
      )}

      {pwFor && (
        <Modal icon={<KeyRound size={19} strokeWidth={1.9} />} kicker={pwDone ? "Password changed" : "New password"} title={personName(pwFor)}
          sub={pwDone ? "Give it to them through a channel you trust: it can't be read back later." : pwFor.email ?? undefined} width={460}
          onClose={() => setPwFor(null)}
          foot={pwDone ? (
            <>
              <span className="sa-modal-note">They aren't signed out and no e-mail is sent.</span>
              <div className="sa-modal-actions"><button className="sa-confirm" onClick={() => setPwFor(null)}>Done</button></div>
            </>
          ) : (
            <>
              <span className="sa-modal-note">They can also reset it from the sign-in page.</span>
              <div className="sa-modal-actions">
                <button className="sa-cancel" onClick={() => setPwFor(null)}>Cancel</button>
                <button className="sa-confirm" onClick={() => void savePassword()} disabled={pwBusy || !!passwordProblem(pw.trim())}>{pwBusy ? "Saving…" : "Set password"}</button>
              </div>
            </>
          )}>
          {pwDone ? (
            <button type="button" className="sa-pw-done" onClick={() => copy(pw)} title="Copy">
              <span>{pw}</span><i>{copied ? <><Check size={13} strokeWidth={2.6} /> Copied</> : <><Copy size={13} strokeWidth={2.2} /> Copy</>}</i>
            </button>
          ) : (
            <form className="sa-mform" onSubmit={(e) => { e.preventDefault(); void savePassword(); }}>
              <label className="sa-mf"><span>New password</span>
                <span className="sa-mf-row">
                  <input value={pw} onChange={(e) => { setPw(e.target.value); setPwErr(""); }} placeholder="8+ letters, numbers, symbol" title={PASSWORD_HINT} autoFocus autoComplete="new-password" spellCheck={false} />
                  <button type="button" className="sa-mf-btn" onClick={randomPw}><Wand2 size={14} strokeWidth={2} /> Generate</button>
                </span>
                <PwRules pw={pw} />
              </label>
              {pwErr && <p className="sa-error">{pwErr}</p>}
              <button type="submit" hidden />
            </form>
          )}
        </Modal>
      )}
      {askEl}
    </>
  );
}

function CoUsage({ det, people }: { det: TenantDetail; people: TenantUserRow[] }) {
  const days = dayList(det.since, det.days);
  const hasTime = det.daily.some((r) => r.seconds > 0);
  const daySeries = (k: "users" | "requests"): Series[] => [{ key: k, label: k === "users" ? "People" : "Requests", color: k === "users" ? "#12b57f" : "#3b82f6", values: days.map((day) => det.daily.filter((r) => r.day === day).reduce((a, r) => a + r[k], 0)) }];
  const changeSeries: Series[] = [{ key: "c", label: "Changes", color: "#f59e0b", values: days.map((day) => det.changes_daily.filter((r) => r.day === day).reduce((a, r) => a + r.changes, 0)) }];
  const up = new Map(det.user_pages.map((r) => [`${r.user_id}|${r.page}`, r.seconds]));
  const activePeople = people.filter((u) => det.user_pages.some((r) => r.user_id === u.id));
  const ent = det.changes.reduce<Record<string, number>>((a, r) => { a[`${r.entity} ${r.action}`] = (a[`${r.entity} ${r.action}`] ?? 0) + r.n; return a; }, {});
  return (
    <>
      {!hasTime && <Note>Page time, requests and transfer are recorded from this release on.</Note>}
      <div className="sa-row">
        <Card title="People using the app" sub="Per day"><TimeChart days={days} series={daySeries("users")} fmt={fmtNum} /></Card>
        <Card title="Data changes" sub="Records created, edited, imported"><TimeChart days={days} series={changeSeries} fmt={fmtNum} /></Card>
      </div>
      <div className="sa-row sa-row-wide">
        <Card title="Pages">
          <div className="sa-tablewrap">
            <table className="sa-table">
              <thead><tr><th>Page</th><th className="is-num">Time</th><th className="is-num">Visits</th><th className="is-num">People</th><th className="is-num">Requests</th><th className="is-num">Transfer</th></tr></thead>
              <tbody>{det.pages.map((p) => (
                <tr key={p.page}><td><b>{pageLabel(p.page)}</b></td><td className="is-num">{fmtDur(p.seconds)}</td><td className="is-num">{fmtNum(p.visits)}</td><td className="is-num">{p.users}</td><td className="is-num">{fmtNum(p.requests)}</td><td className="is-num">{fmtBytes(p.bytes)}</td></tr>
              ))}</tbody>
            </table>
            {!det.pages.length && <Empty>No page visits recorded yet.</Empty>}
          </div>
        </Card>
        <Card title="What changed" sub={`Last ${det.days} days`}>
          <HBars fmt={fmtNum} rows={Object.entries(ent).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ key: k, label: k.replace(/_/g, " "), value: v, color: "#f59e0b" }))} />
        </Card>
      </div>
      <Card title="Who uses what" sub="Time per person and page">
        <Heat rows={activePeople.map((u) => ({ key: u.id, label: personName(u) }))} cols={det.pages.map((p) => ({ key: p.page, label: pageLabel(p.page) }))}
          value={(u, p) => up.get(`${u}|${p}`) ?? 0} fmt={fmtDur} />
      </Card>
      {det.ai.length > 0 && (
        <Card title="AI">
          <table className="sa-table is-plain">
            <thead><tr><th>Feature</th><th>Model</th><th className="is-num">Calls</th><th className="is-num">Input</th><th className="is-num">Output</th></tr></thead>
            <tbody>{det.ai.map((r, i) => <tr key={i}><td>{r.feature.replace(/_/g, " ")}</td><td className="is-dim">{r.model}</td><td className="is-num">{r.calls}</td><td className="is-num">{fmtNum(r.tin)}</td><td className="is-num">{fmtNum(r.tout)}</td></tr>)}</tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function CoData({ det }: { det: TenantDetail }) {
  const db = det.tables.reduce((a, t) => a + t.bytes, 0);
  const files = det.files.reduce((a, f) => a + f.bytes, 0);
  const rows = det.tables.reduce((a, t) => a + t.rows, 0);
  const backups = det.tables.filter((t) => /bk|backup|dupes/i.test(t.name));
  const histDays = det.storage_history.map((r) => r.day);
  return (
    <>
      <div className="sa-kpis is-4">
        <Kpi label="Database" value={fmtBytes(db)} sub={`${fmtNum(rows)} rows in ${det.tables.length} tables`} />
        <Kpi label="Files" value={fmtBytes(files)} sub={`${fmtNum(det.files.reduce((a, f) => a + f.count, 0))} files`} />
        <Kpi label="Backups" value={fmtBytes(backups.reduce((a, t) => a + t.bytes, 0))} sub={`${backups.length} backup tables from data fixes`} tone={backups.length ? "warn" : undefined} />
        <Kpi label="Measured" value={det.snapshot_day ? new Date(det.snapshot_day).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"} sub="Daily snapshot, 03:15 UTC" />
      </div>
      <div className="sa-row sa-row-wide">
        <Card title="Tables" sub="Their share of each table on disk (data + indexes)">
          <HBars fmt={fmtBytes} rows={det.tables.map((t) => ({ key: t.name, label: <code>{t.name}</code>, sub: `${fmtNum(t.rows)} rows`, value: t.bytes, color: /bk|backup|dupes/i.test(t.name) ? "#f59e0b" : "#3b82f6" }))} />
        </Card>
        <Card title="Files" sub="By storage bucket">
          {det.files.length ? (
            <div className="sa-donut-wrap is-col">
              <Donut parts={det.files.map((f, i) => ({ key: f.bucket, label: f.bucket, value: f.bytes, color: ["#8b5cf6", "#3b82f6", "#12b57f", "#f59e0b"][i % 4] }))} center={fmtBytes(files)} sub="in files" />
              <Legend items={det.files.map((f, i) => ({ key: f.bucket, label: `${f.bucket} · ${f.count}`, color: ["#8b5cf6", "#3b82f6", "#12b57f", "#f59e0b"][i % 4], value: fmtBytes(f.bytes) }))} />
            </div>
          ) : <Empty>No files.</Empty>}
        </Card>
      </div>
      <Card title="Storage over time">
        <TimeChart days={histDays.length ? histDays : [new Date().toISOString().slice(0, 10)]} fmt={fmtBytes}
          series={[{ key: "db", label: "Database", color: "#3b82f6", values: det.storage_history.map((r) => r.db_bytes ?? 0) }, { key: "f", label: "Files", color: "#8b5cf6", values: det.storage_history.map((r) => r.file_bytes ?? 0) }]} height={150} />
        {histDays.length < 3 && <Note>One point per night: the trend fills in day by day.</Note>}
      </Card>
    </>
  );
}

function CoCosts({ det, tc, model, cur, alloc, people, uCost, aiPrice }: {
  det: TenantDetail; tc: TC; model: ReturnType<typeof computeCosts>; cur: string; alloc: string; people: TenantUserRow[];
  uCost: Map<string, number>; aiPrice: (model: string, tin: number, tout: number) => number;
}) {
  const parts = [
    { key: "fixed", label: "Share of fixed costs", value: tc.fixed, color: "#12b57f" },
    { key: "db", label: "Database over quota", value: tc.db, color: "#3b82f6" },
    { key: "files", label: "Files over quota", value: tc.files, color: "#6366f1" },
    { key: "egress", label: "Transfer & users over quota", value: tc.egress + tc.mau, color: "#8b5cf6" },
    { key: "ai", label: "AI", value: tc.ai, color: "#f43f5e" },
  ];
  const sec = det.pages.reduce((a, p) => a + p.seconds, 0);
  const base = tc.total - tc.ai;
  const users = [...people].sort((a, b) => (uCost.get(b.id) ?? 0) - (uCost.get(a.id) ?? 0));
  const maxU = Math.max(...users.map((u) => uCost.get(u.id) ?? 0), 0);
  return (
    <>
      <div className="sa-kpis is-4">
        <Kpi label="Per month" value={fmtMoney(tc.total, cur)} sub={`${Math.round((tc.total / Math.max(0.0001, model.total)) * 100)}% of the platform's ${fmtMoney(model.total, cur)}`} />
        <Kpi label="Per user" value={fmtMoney(tc.perUser, cur)} sub="Active users" />
        <Kpi label="Revenue" value={tc.revenue != null ? fmtMoney(tc.revenue, cur) : "—"} sub={tc.revenue != null ? "per month" : "Set it in Cost sources"} />
        <Kpi label="Margin" value={tc.margin != null ? fmtMoney(tc.margin, cur) : "—"} sub={tc.margin != null && tc.revenue ? `${Math.round((tc.margin / tc.revenue) * 100)}%` : "—"} tone={tc.margin != null && tc.margin < 0 ? "bad" : undefined} />
      </div>
      <div className="sa-row">
        <Card title="What makes up the cost" sub={`Fixed costs split by ${alloc.toLowerCase()} · this company's key: ${Math.round(tc.weight * 100)}%`}>
          <div className="sa-donut-wrap">
            <Donut parts={parts.filter((p) => p.value > 0.004)} center={fmtMoney(tc.total, cur)} sub="per month" />
            <Legend items={parts.map((p) => ({ key: p.key, label: p.label, color: p.color, value: fmtMoney(p.value, cur) }))} />
          </div>
        </Card>
        <Card title="Cost per page" sub="Without AI, spread by time spent">
          {sec ? <HBars fmt={(v) => fmtMoney(v, cur)} rows={det.pages.map((p) => ({ key: p.page, label: pageLabel(p.page), sub: fmtDur(p.seconds), value: base * (p.seconds / sec), color: "#12b57f" }))} />
            : <Empty>Needs time-in-app data, which starts with this release.</Empty>}
        </Card>
      </div>
      <Card title="Cost per user" sub="Share of the company's cost by activity, plus their own AI">
        <HBars fmt={(v) => fmtMoney(v, cur)} max={maxU} rows={users.map((u) => ({ key: u.id, label: personName(u), sub: u.active ? (ROLE_LABELS[u.role ?? ""] ?? u.role ?? "") : "Deactivated", value: uCost.get(u.id) ?? 0, color: u.active ? "#12b57f" : "#b7c9c1" }))} />
      </Card>
      {det.ai.length > 0 && (
        <Card title="AI spend">
          <table className="sa-table is-plain">
            <thead><tr><th>Feature</th><th>Model</th><th className="is-num">Calls</th><th className="is-num">Tokens</th><th className="is-num">Cost ({det.days}d)</th></tr></thead>
            <tbody>{det.ai.map((r, i) => <tr key={i}><td>{r.feature.replace(/_/g, " ")}</td><td className="is-dim">{r.model}</td><td className="is-num">{r.calls}</td><td className="is-num">{fmtNum(r.tin + r.tout)}</td><td className="is-num">{fmtMoney(aiPrice(r.model, r.tin, r.tout), cur)}</td></tr>)}</tbody>
          </table>
        </Card>
      )}
    </>
  );
}

