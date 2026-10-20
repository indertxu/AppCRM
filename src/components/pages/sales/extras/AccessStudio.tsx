/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackToClose } from "../../../framework/useBackToClose";
import type { Phase, Pipeline } from "../../settings/pipelineApi";
import type { Tracking } from "../sales/salesApi";
import { orderPhases, saveSalesRole, ROLE_COLORS, type RoleScope, type SalesRole, type TrackingHandover } from "./salesRolesApi";
import {
  resolvePerms, accessFromPerms, saveAccessRules, ruleKey, jobLabel, isLockedPerson, isEmptySettings,
  CREATE_LABEL, CREATE_HINT, EXPORT_LABEL,
  type AccessPerson, type AccessSettings, type RuleMap, type SubjectType, type Source, type PipeRule, type EffectivePerms,
} from "./salesAccess";
import "./AccessStudio.css";
import Select from "../../../framework/Select";

const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const KNOWN_JOBS = ["boss", "sales_manager", "sales", "marketing_manager", "marketing"];

interface Subject { type: SubjectType; id: string; name: string; sub: string; color?: string; locked?: boolean; people: AccessPerson[] }

/** One setting the page edits (everything except pipelines). */
interface FieldDef<T = any> {
  id: string; section: "deals" | "views" | "actions"; label: string; hint: string;
  options: { v: T; label: string; hint?: string }[];
  get: (s: AccessSettings) => T | undefined;
  set: (s: AccessSettings, v: T | undefined) => AccessSettings;
  eff: (p: EffectivePerms) => { value: T; source: Source };
  icon?: ReactNode;
}
const bool = (on = "On", off = "Off") => [{ v: true, label: on }, { v: false, label: off }];
const setTop = (k: keyof AccessSettings) => (s: AccessSettings, v: any) => { const n: any = { ...s }; if (v === undefined) delete n[k]; else n[k] = v; return n; };
const setView = (k: "list" | "board" | "forecast") => (s: AccessSettings, v: any) => {
  const views = { ...(s.views ?? {}) } as any; if (v === undefined) delete views[k]; else views[k] = v;
  const n: any = { ...s, views }; if (!Object.keys(views).length) delete n.views; return n;
};
const I = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const FIELDS: FieldDef[] = [
  { id: "scope", section: "deals", label: "Which deals", hint: "Every deal in the pipelines below, or only the ones they're on (owner or team).",
    options: [{ v: "all", label: "All deals" }, { v: "own", label: "Only theirs" }], get: (s) => s.scope, set: setTop("scope"), eff: (p) => p.scope },
  { id: "views.list", section: "views", label: "List", hint: "The deals table", options: bool(), get: (s) => s.views?.list, set: setView("list"), eff: (p) => p.views.list, icon: I("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01") },
  { id: "views.board", section: "views", label: "Board", hint: "Drag deals between phases", options: bool(), get: (s) => s.views?.board, set: setView("board"), eff: (p) => p.views.board, icon: I("M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v7h-4z") },
  { id: "views.forecast", section: "views", label: "Forecast", hint: "Revenue by month and weighted pipeline", options: bool(), get: (s) => s.views?.forecast, set: setView("forecast"), eff: (p) => p.views.forecast, icon: I("M3 3v18h18M7 15l4-4 3 3 5-6") },
  { id: "create", section: "actions", label: "New deal", hint: "Open deals — and for whom.",
    options: (["none", "self", "team", "anyone"] as const).map((v) => ({ v, label: CREATE_LABEL[v], hint: CREATE_HINT[v] })), get: (s) => s.create, set: setTop("create"), eff: (p) => p.create, icon: I("M12 5v14M5 12h14") },
  { id: "reports", section: "actions", label: "Reports", hint: "Lists, boards, forecasts and charts — always on what they can see.", options: bool(), get: (s) => s.reports, set: setTop("reports"), eff: (p) => p.reports, icon: I("M4 20V10M10 20V4M16 20v-7M22 20H2") },
  { id: "export", section: "actions", label: "Export", hint: "Deals, contacts or companies to Excel.",
    options: (["none", "visible", "all"] as const).map((v) => ({ v, label: EXPORT_LABEL[v] })), get: (s) => s.export, set: setTop("export"), eff: (p) => p.export, icon: I("M12 15V3M7 8l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2") },
  { id: "import", section: "actions", label: "Import deals", hint: "From another CRM's Excel or CSV.", options: bool(), get: (s) => s.import, set: setTop("import"), eff: (p) => p.import, icon: I("M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2") },
  { id: "fields", section: "actions", label: "Deal fields", hint: "Add, rename and reorder the custom fields of every deal.", options: bool(), get: (s) => s.fields, set: setTop("fields"), eff: (p) => p.fields, icon: I("M4 6h16M4 12h10M4 18h7M17 15l2 2 3-4") },
  { id: "manage", section: "actions", label: "Sales roles & access", hint: "Roles, who sees what, transfers — and this page.", options: bool(), get: (s) => s.manage, set: setTop("manage"), eff: (p) => p.manage, icon: I("M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z") },
];
const fmtValue = (f: FieldDef, v: any) => f.options.find((o) => o.v === v)?.label ?? String(v);

export default function AccessStudio({ people, roles: initialRoles, pipelines, phaseByPipe, rules: initialRules, rulesMissing, trackings, owners, teams, events, handovers, canEdit, meId, onClose, onSaved }: {
  people: AccessPerson[];
  roles: SalesRole[];
  pipelines: Pipeline[];
  phaseByPipe: Record<string, Phase[]>;
  rules: RuleMap;
  rulesMissing: boolean;
  trackings: Tracking[];
  owners: Record<string, string>;
  teams: Record<string, string[]>;
  events: Record<string, string[]>;
  handovers: TrackingHandover[];
  canEdit: boolean;
  meId: string | null;
  onClose: () => void;
  onSaved: (rules: RuleMap, roles: SalesRole[]) => void;
}) {
  const [draft, setDraft] = useState<RuleMap>(initialRules);
  const [base, setBase] = useState<RuleMap>(initialRules);
  const [roles, setRoles] = useState<SalesRole[]>(initialRoles);
  const [baseRoles, setBaseRoles] = useState<SalesRole[]>(initialRoles);
  const [sel, setSel] = useState<string>("everyone:*");
  const [q, setQ] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // on narrower screens the result opens on demand, over the settings
  const [showPreview, setShowPreview] = useState(() => typeof window === "undefined" || window.innerWidth >= 1180);

  /* ─────────────── subjects ─────────────── */
  const subjects = useMemo(() => {
    const jobs = Array.from(new Set([...KNOWN_JOBS, ...people.map((p) => (p.role ?? "").toLowerCase()).filter(Boolean)]));
    const job: Subject[] = jobs.map((j): Subject => ({ type: "job", id: j, name: jobLabel(j), sub: "", locked: j === "boss", people: people.filter((p) => (p.role ?? "").toLowerCase() === j) }))
      .filter((s) => s.people.length || KNOWN_JOBS.includes(s.id))
      .map((s) => ({ ...s, sub: `${s.people.length} ${s.people.length === 1 ? "person" : "people"}` }));
    const sr: Subject[] = roles.map((r, i) => ({ type: "sales_role", id: r.id, name: r.name, color: r.color || ROLE_COLORS[i % ROLE_COLORS.length], sub: `${r.members.length} ${r.members.length === 1 ? "person" : "people"}`, people: people.filter((p) => r.members.includes(p.id)) }));
    const ppl: Subject[] = [...people].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ type: "user", id: p.id, name: p.name, sub: jobLabel(p.role), locked: isLockedPerson(p), people: [p] }));
    return { everyone: { type: "everyone", id: "*", name: "Everyone", sub: "The starting point for all", people } as Subject, job, sr, ppl };
  }, [people, roles]);
  const allSubjects = [subjects.everyone, ...subjects.job, ...subjects.sr, ...subjects.ppl];
  const subject = allSubjects.find((s) => ruleKey(s.type, s.id) === sel) ?? subjects.everyone;
  const key = ruleKey(subject.type, subject.id);
  const own = draft[key] ?? {};
  const overrides = (s: Subject) => {
    const n = Object.values(FIELDS).filter((f) => f.get(draft[ruleKey(s.type, s.id)] ?? {}) !== undefined).length + Object.keys(draft[ruleKey(s.type, s.id)]?.pipelines ?? {}).length;
    return n;
  };

  /* ─────────────── edits ─────────────── */
  const patch = (fn: (s: AccessSettings) => AccessSettings) => { setSaved(false); setDraft((d) => { const n = fn(d[key] ?? {}); const out = { ...d }; if (isEmptySettings(n)) delete out[key]; else out[key] = n; return out; }); };
  const setPipe = (pid: string, v: PipeRule | undefined) => patch((s) => {
    const pipes = { ...(s.pipelines ?? {}) }; if (v === undefined) delete pipes[pid]; else pipes[pid] = v;
    const n: AccessSettings = { ...s, pipelines: pipes }; if (!Object.keys(pipes).length) delete n.pipelines; return n;
  });
  const setRoleScope = (roleId: string, pid: string, sc: Partial<RoleScope> | null) => {
    setSaved(false);
    setRoles((rs) => rs.map((r) => {
      if (r.id !== roleId) return r;
      const others = r.scopes.filter((s) => s.pipeline_id !== pid);
      if (sc === null) return { ...r, scopes: others };
      const cur = r.scopes.find((s) => s.pipeline_id === pid) ?? { pipeline_id: pid, max_phase_id: null, handover_to: null };
      const next = { ...cur, ...sc };
      if (!next.max_phase_id) next.handover_to = null;
      return { ...r, scopes: [...others, next] };
    }));
  };
  const resetSubject = () => patch(() => ({}));

  /* ─────────────── what a setting falls back to ─────────────── */
  const probes = (s: Subject): AccessPerson[] => {
    if (s.type === "user") return s.people;
    if (s.type === "sales_role") return s.people.length ? s.people : [{ id: "__probe", name: "", role: "sales" }];
    if (s.type === "job") return [{ id: "__probe", name: "", role: s.id }];
    return subjects.job.filter((j) => !j.locked).map((j) => ({ id: "__probe", name: "", role: j.id }));
  };
  const ctxWith = (rules: RuleMap) => ({ rules, roles, pipelines, phaseByPipe });
  const inherited = (f: FieldDef): { text: string; source?: Source } => {
    const without = { ...draft, [key]: f.set(own, undefined) };
    const vals = probes(subject).filter((p) => !isLockedPerson(p)).map((p) => f.eff(resolvePerms(p, ctxWith(without))));
    if (!vals.length) return { text: "—" };
    const distinct = Array.from(new Set(vals.map((v) => JSON.stringify(v.value))));
    if (distinct.length === 1) return { text: fmtValue(f, vals[0].value), source: vals[0].source };
    return { text: "Depends on the person" };
  };
  const inheritedPipe = (pid: string): { text: string; source?: Source } => {
    const without = { ...draft, [key]: (() => { const s = { ...own }; if (s.pipelines) { const pp = { ...s.pipelines }; delete pp[pid]; s.pipelines = pp; } return s; })() };
    const vals = probes(subject).filter((p) => !isLockedPerson(p)).map((p) => resolvePerms(p, ctxWith(without)).pipelines[pid]).filter(Boolean);
    if (!vals.length) return { text: "—" };
    const txt = (v: { access: boolean; maxPhaseId: string | null }) => (!v.access ? "No access" : v.maxPhaseId ? `Up to ${phaseName(pid, v.maxPhaseId)}` : "Every phase");
    const distinct = Array.from(new Set(vals.map(txt)));
    return distinct.length === 1 ? { text: distinct[0], source: vals[0].source } : { text: "Depends on the person" };
  };
  const phasesOf = (pid: string) => orderPhases(phaseByPipe[pid] ?? []).filter((p) => !p.sales_outcome);
  const phaseName = (pid: string, id: string | null) => phasesOf(pid).find((p) => p.id === id)?.name ?? "a phase";

  /* ─────────────── preview ─────────────── */
  const previewPeople = subject.type === "everyone" ? people : subject.people;
  const previewPerson = people.find((p) => p.id === previewId && previewPeople.some((x) => x.id === p.id)) ?? previewPeople.find((p) => !isLockedPerson(p)) ?? previewPeople[0] ?? null;
  const perms = previewPerson ? resolvePerms(previewPerson, ctxWith(draft)) : null;
  const seen = useMemo(() => {
    if (!perms || !previewPerson) return null;
    const me = previewPerson.id;
    const acc = accessFromPerms({ me, perms, roles, phaseByPipe, events, handovers, onDeal: (t) => owners[t.id] === me || (teams[t.id] ?? []).includes(me) });
    const n = acc.restricted ? trackings.filter((t) => acc.view(t)?.mode === "full").length : trackings.length;
    return { n, total: trackings.length };
  }, [perms, previewPerson, roles, phaseByPipe, events, handovers, owners, teams, trackings]);

  /* ─────────────── saving ─────────────── */
  const changedRoles = roles.filter((r) => JSON.stringify(r.scopes) !== JSON.stringify(baseRoles.find((b) => b.id === r.id)?.scopes));
  const changedRules = Array.from(new Set([...Object.keys(draft), ...Object.keys(base)])).filter((k) => JSON.stringify(draft[k] ?? {}) !== JSON.stringify(base[k] ?? {}));
  const dirty = changedRoles.length + changedRules.length;
  const save = async () => {
    setBusy(true); setErr(null);
    let e: string | null = null;
    if (changedRules.length) e = await saveAccessRules(draft, base);
    for (const r of changedRoles) { if (e) break; const res = await saveSalesRole(r); e = res.error; }
    setBusy(false);
    if (e) { setErr(e); return; }
    setBase(draft); setBaseRoles(roles); setSaved(true);
    onSaved(draft, roles);
  };
  const discard = () => { setDraft(base); setRoles(baseRoles); setErr(null); };
  const close = () => { if (dirty && !window.confirm("Close without saving your changes?")) return; onClose(); };
  useBackToClose("sales-access", close);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = !canEdit || !!subject.locked;
  const ruleBlocked = rulesMissing && subject.type !== "sales_role";

  /* ─────────────── render helpers ─────────────── */
  const SourceChip = ({ s }: { s?: Source }) => (s ? <i className={`acs-src is-${s.kind}`}>{s.kind === "user" ? "Person" : s.kind === "sales_role" ? s.label : s.kind === "job" ? s.label : s.label}</i> : null);
  const choice = (f: FieldDef) => {
    const v = f.get(own);
    const inh = inherited(f);
    const disabled = readOnly || ruleBlocked;
    return (
      <div className={`acs-choice ${f.options.length > 2 ? "is-wide" : ""}`} role="radiogroup" aria-label={f.label}>
        <button role="radio" aria-checked={v === undefined} className={`is-inherit ${v === undefined ? "is-on" : ""}`} disabled={disabled} onClick={() => patch((s) => f.set(s, undefined))}
          title={inh.source ? `From ${inh.source.label}` : undefined}>
          <span>{subject.type === "everyone" ? "Default" : "Inherit"}</span><small>{inh.text}</small>
        </button>
        {f.options.map((o) => (
          <button key={String(o.v)} role="radio" aria-checked={v === o.v} title={o.hint} className={`${v === o.v ? "is-on" : ""} ${o.v === false || o.v === "none" ? "is-neg" : ""}`} disabled={disabled}
            onClick={() => patch((s) => f.set(s, o.v))}>
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    );
  };
  const filteredGroup = (list: Subject[]) => { const n = q.trim().toLowerCase(); return n ? list.filter((s) => s.name.toLowerCase().includes(n)) : list; };
  const SubjectBtn = ({ s, i }: { s: Subject; i: number }) => {
    const k = ruleKey(s.type, s.id);
    const n = s.type === "sales_role" ? overrides(s) + (roles.find((r) => r.id === s.id)?.scopes.length ? 0 : 0) : overrides(s);
    const changed = changedRules.includes(k) || (s.type === "sales_role" && changedRoles.some((r) => r.id === s.id));
    return (
      <button className={`acs-subj ${k === sel ? "is-on" : ""}`} onClick={() => { setSel(k); setPreviewId(null); }} style={{ ["--c" as string]: s.color ?? "#9fb5ab", ["--i" as string]: Math.min(i, 14) } as CSSProperties}>
        <span className={`acs-subj-ico is-${s.type}`}>{s.type === "user" ? initials(s.name) : s.type === "everyone" ? "∗" : s.type === "sales_role" ? "" : initials(s.name)}</span>
        <span className="acs-subj-txt"><b>{s.name}</b><small>{s.locked ? "Always everything" : s.sub}</small></span>
        {changed ? <em className="acs-dot is-changed" title="Unsaved changes" /> : n > 0 ? <em className="acs-count" title={`${n} settings of its own`}>{n}</em> : null}
      </button>
    );
  };

  const typeLabel = subject.type === "everyone" ? "Everyone" : subject.type === "job" ? "Job role" : subject.type === "sales_role" ? "Sales role" : "Person";
  const affects = subject.type === "everyone" ? people.length : subject.people.length;

  return createPortal(
    <div className="acs-backdrop" onMouseDown={close}>
      <div className="acs" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Sales access">
        <header className="acs-head">
          <button className="acs-back" onClick={close} aria-label="Back">‹</button>
          <div className="acs-head-txt">
            <span className="acs-eyebrow">Sales · Who sees what</span>
            <h2>Access settings</h2>
          </div>
          <ol className="acs-order" aria-label="Order of priority">
            <li>Person</li><li>Sales role</li><li>Job role</li><li>Everyone</li>
          </ol>
          <div className="acs-head-actions">
            {saved && !dirty && <span className="acs-saved">Saved</span>}
            {dirty > 0 && <span className="acs-dirty">{dirty} unsaved {dirty === 1 ? "change" : "changes"}</span>}
            <button className="acs-btn is-ghost" onClick={discard} disabled={!dirty || busy}>Discard</button>
            <button className="acs-btn is-primary" onClick={save} disabled={!dirty || busy || !canEdit}>{busy ? "Saving…" : "Save changes"}</button>
          </div>
        </header>
        {(rulesMissing || err || !canEdit) && (
          <div className="acs-banners">
            {rulesMissing && <p className="acs-banner">These settings need a new table — run <code>empower_sales_access.sql</code> in Supabase once. Until then only sales-role pipelines can be saved.</p>}
            {!canEdit && <p className="acs-banner is-soft">You can look around, but only people with “Sales roles & access” can change these settings.</p>}
            {err && <p className="acs-banner is-err">{err}</p>}
          </div>
        )}

        <div className={`acs-body ${showPreview ? "" : "no-preview"}`}>
          {/* ─────────── who ─────────── */}
          <nav className="acs-nav">
            <input className="acs-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people and roles…" aria-label="Search" />
            <div className="acs-nav-scroll">
              {!q && <SubjectBtn s={subjects.everyone} i={0} />}
              {filteredGroup(subjects.sr).length > 0 && <p className="acs-group">Sales roles</p>}
              {filteredGroup(subjects.sr).map((s, i) => <SubjectBtn key={s.id} s={s} i={i + 1} />)}
              {filteredGroup(subjects.job).length > 0 && <p className="acs-group">Job roles</p>}
              {filteredGroup(subjects.job).map((s, i) => <SubjectBtn key={s.id} s={s} i={i + 2} />)}
              {filteredGroup(subjects.ppl).length > 0 && <p className="acs-group">People</p>}
              {filteredGroup(subjects.ppl).map((s, i) => <SubjectBtn key={s.id} s={s} i={i + 4} />)}
            </div>
          </nav>

          {/* ─────────── settings ─────────── */}
          <main className="acs-main" key={sel}>
            <section className="acs-hero" style={{ ["--c" as string]: subject.color ?? "#12b57f" } as CSSProperties}>
              <span className={`acs-hero-ico is-${subject.type}`}>{subject.type === "everyone" ? "∗" : initials(subject.name)}</span>
              <div>
                <span className="acs-hero-type">{typeLabel}</span>
                <h3>{subject.name}</h3>
                <p>
                  {subject.locked ? "Always has full access to Deals — this can't be limited, so nobody gets locked out."
                    : subject.type === "everyone" ? "What everyone gets unless their job role, sales role or own settings say otherwise."
                    : subject.type === "user" ? "Settings just for this person. Anything on “Inherit” comes from their sales role, job role or Everyone."
                    : `Applies to ${affects} ${affects === 1 ? "person" : "people"}. Anything on “Inherit” comes from ${subject.type === "sales_role" ? "their job role or Everyone" : "Everyone"}.`}
                </p>
                {subject.type !== "user" && subject.type !== "everyone" && subject.people.length > 0 && (
                  <span className="acs-hero-avs">{subject.people.slice(0, 8).map((p) => <i key={p.id} title={p.name}>{initials(p.name)}</i>)}{subject.people.length > 8 && <i className="is-more">+{subject.people.length - 8}</i>}</span>
                )}
              </div>
              {!readOnly && !ruleBlocked && overrides(subject) > 0 && <button className="acs-reset" onClick={resetSubject}>Reset all to inherit</button>}
            </section>

            {subject.locked ? (
              <div className="acs-locked">
                <span>{I("M6 10V7a6 6 0 0 1 12 0v3M5 10h14v11H5z")}</span>
                <p>Bosses (and superadmins) see every pipeline and every deal, and can use every action.</p>
              </div>
            ) : (
              <>
                {/* deals */}
                <section className="acs-card">
                  <header><h4>Deals</h4><p>Which deals they see inside the pipelines they have.</p></header>
                  {FIELDS.filter((f) => f.section === "deals").map((f) => (
                    <div key={f.id} className="acs-row"><div className="acs-row-txt"><b>{f.label}</b><small>{f.hint}</small></div>{choice(f)}</div>
                  ))}
                </section>

                {/* pipelines */}
                <section className="acs-card">
                  <header>
                    <h4>Pipelines</h4>
                    <p>{subject.type === "sales_role" ? "What this sales role sees: the pipelines and the last phase. Past it, deals disappear for them (and are handed over, if the role says so)." : "Which pipelines they can open, and up to which phase."}</p>
                  </header>
                  {(subject.type === "job" || subject.type === "everyone") && (() => {
                    const inRole = subject.people.filter((p) => roles.some((r) => r.members.includes(p.id)) && !isLockedPerson(p));
                    return inRole.length > 0 ? <p className="acs-note">{inRole.length} of {subject.people.length} {subject.people.length === 1 ? "person is" : "people are"} in a sales role — their pipelines come from it, not from here.</p> : null;
                  })()}
                  {subject.type === "user" && Object.values(roles).some((r) => r.members.includes(subject.id)) && !own.pipelines && (
                    <p className="acs-note">This person's sales {roles.filter((r) => r.members.includes(subject.id)).length === 1 ? "role decides" : "roles decide"} their pipelines. Set one here to override it just for them.</p>
                  )}
                  <div className="acs-pipes">
                    {pipelines.map((p) => {
                      const phs = phasesOf(p.id);
                      if (subject.type === "sales_role") {
                        const role = roles.find((r) => r.id === subject.id)!;
                        const sc = role.scopes.find((s) => s.pipeline_id === p.id) ?? null;
                        const lim = sc ? (sc.max_phase_id ? phs.findIndex((x) => x.id === sc.max_phase_id) : phs.length - 1) : -1;
                        return (
                          <div key={p.id} className={`acs-pipe ${sc ? "is-on" : "is-off"}`}>
                            <div className="acs-pipe-h">
                              <b>{p.name}</b>
                              <div className="acs-choice is-sm">
                                <button className={sc ? "is-on" : ""} disabled={!canEdit} onClick={() => !sc && setRoleScope(role.id, p.id, {})}><span>Sees it</span></button>
                                <button className={`is-neg ${!sc ? "is-on" : ""}`} disabled={!canEdit} onClick={() => sc && setRoleScope(role.id, p.id, null)}><span>No access</span></button>
                              </div>
                            </div>
                            {sc && <Ladder phases={phs} lim={lim} disabled={!canEdit} onPick={(id) => setRoleScope(role.id, p.id, { max_phase_id: id })} />}
                            {sc?.handover_to && <small className="acs-pipe-foot">Then handed over to {people.find((x) => x.id === sc.handover_to)?.name ?? "someone"} · change it in the Roles tab</small>}
                          </div>
                        );
                      }
                      const pr = own.pipelines?.[p.id];
                      const inh = inheritedPipe(p.id);
                      const lim = pr ? (pr.max_phase_id ? phs.findIndex((x) => x.id === pr.max_phase_id) : phs.length - 1) : -1;
                      const disabled = readOnly || ruleBlocked;
                      return (
                        <div key={p.id} className={`acs-pipe ${pr ? (pr.access ? "is-on" : "is-off") : "is-inherit"}`}>
                          <div className="acs-pipe-h">
                            <b>{p.name}</b>
                            <div className="acs-choice is-sm">
                              <button className={`is-inherit ${!pr ? "is-on" : ""}`} disabled={disabled} onClick={() => setPipe(p.id, undefined)} title={inh.source ? `From ${inh.source.label}` : undefined}>
                                <span>{subject.type === "everyone" ? "Default" : "Inherit"}</span><small>{inh.text}</small>
                              </button>
                              <button className={pr?.access ? "is-on" : ""} disabled={disabled} onClick={() => setPipe(p.id, { access: true, max_phase_id: pr?.access ? pr.max_phase_id : null })}><span>Sees it</span></button>
                              <button className={`is-neg ${pr && !pr.access ? "is-on" : ""}`} disabled={disabled} onClick={() => setPipe(p.id, { access: false, max_phase_id: null })}><span>No access</span></button>
                            </div>
                          </div>
                          {pr?.access && <Ladder phases={phs} lim={lim} disabled={disabled} onPick={(id) => setPipe(p.id, { access: true, max_phase_id: id })} />}
                        </div>
                      );
                    })}
                    {pipelines.length === 0 && <p className="acs-note">There are no sales pipelines yet.</p>}
                  </div>
                </section>

                {/* views */}
                <section className="acs-card">
                  <header><h4>Views</h4><p>Which ways of looking at the deals they get. With none, Sales is closed to them.</p></header>
                  <div className="acs-views">
                    {FIELDS.filter((f) => f.section === "views").map((f) => (
                      <div key={f.id} className="acs-view">
                        <span className="acs-view-ico">{f.icon}</span>
                        <b>{f.label}</b><small>{f.hint}</small>
                        {choice(f)}
                      </div>
                    ))}
                  </div>
                </section>

                {/* actions */}
                <section className="acs-card">
                  <header><h4>Actions</h4><p>What they can do from the Actions menu.</p></header>
                  {FIELDS.filter((f) => f.section === "actions").map((f) => (
                    <div key={f.id} className="acs-row">
                      <span className="acs-row-ico">{f.icon}</span>
                      <div className="acs-row-txt"><b>{f.label}</b><small>{f.id === "create" && f.get(own) ? CREATE_HINT[f.get(own) as keyof typeof CREATE_HINT] : f.hint}</small></div>
                      {choice(f)}
                    </div>
                  ))}
                </section>
              </>
            )}
          </main>

          {/* ─────────── preview ─────────── */}
          {showPreview && (
            <aside className="acs-preview">
              <div className="acs-preview-h">
                <h4>Result</h4>
                <button className="acs-x" onClick={() => setShowPreview(false)} aria-label="Hide the result">×</button>
              </div>
              {previewPeople.length === 0 || !previewPerson || !perms ? <p className="acs-note">Nobody has this yet.</p> : (
                <>
                  <div className="acs-select"><Select size="sm" aria-label="Preview as" value={previewPerson.id} onChange={setPreviewId} options={previewPeople.map((p) => ({ value: p.id, label: p.name }))} /></div>
                  {!perms.canOpen ? (
                    <div className="acs-big is-off"><b>No access</b><small>Sales is closed to {previewPerson.name.split(" ")[0]}</small></div>
                  ) : seen && (
                    <div className="acs-big"><b>{seen.n}</b><small>of {seen.total} deals visible right now</small><span className="acs-big-bar"><i style={{ width: `${seen.total ? (seen.n / seen.total) * 100 : 0}%` }} /></span></div>
                  )}
                  <dl className="acs-res">
                    <div><dt>Deals</dt><dd>{perms.scope.value === "all" ? "All deals" : "Only theirs"}<SourceChip s={perms.scope.source} /></dd></div>
                    {pipelines.map((p) => { const ep = perms.pipelines[p.id]; return ep ? <div key={p.id}><dt>{p.name}</dt><dd className={ep.access ? "" : "is-off"}>{!ep.access ? "No access" : ep.maxPhaseId ? `Up to ${phaseName(p.id, ep.maxPhaseId)}` : "Every phase"}<SourceChip s={ep.source} /></dd></div> : null; })}
                    <div><dt>Views</dt><dd className="acs-res-views">{(["list", "board", "forecast"] as const).map((v) => <span key={v} className={perms.views[v].value ? "is-on" : ""} title={perms.views[v].source.label}>{v === "list" ? "List" : v === "board" ? "Board" : "Forecast"}</span>)}</dd></div>
                    <div><dt>New deal</dt><dd className={perms.create.value === "none" ? "is-off" : ""}>{CREATE_LABEL[perms.create.value]}<SourceChip s={perms.create.source} /></dd></div>
                    <div><dt>Reports</dt><dd className={perms.reports.value ? "" : "is-off"}>{perms.reports.value ? "Yes" : "No"}<SourceChip s={perms.reports.source} /></dd></div>
                    <div><dt>Export</dt><dd className={perms.export.value === "none" ? "is-off" : ""}>{EXPORT_LABEL[perms.export.value]}<SourceChip s={perms.export.source} /></dd></div>
                    <div><dt>Import deals</dt><dd className={perms.import.value ? "" : "is-off"}>{perms.import.value ? "Yes" : "No"}<SourceChip s={perms.import.source} /></dd></div>
                    <div><dt>Deal fields</dt><dd className={perms.fields.value ? "" : "is-off"}>{perms.fields.value ? "Yes" : "No"}<SourceChip s={perms.fields.source} /></dd></div>
                    <div><dt>Roles & access</dt><dd className={perms.manage.value ? "" : "is-off"}>{perms.manage.value ? "Yes" : "No"}<SourceChip s={perms.manage.source} /></dd></div>
                  </dl>
                  {previewPerson.id === meId && !perms.manage.value && <p className="acs-banner is-err">Careful: you'd lose access to these settings.</p>}
                </>
              )}
            </aside>
          )}
          {!showPreview && <button className="acs-preview-open" onClick={() => setShowPreview(true)}>Show result</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Phases as steps: click one to make it the last phase they see. */
function Ladder({ phases, lim, disabled, onPick }: { phases: Phase[]; lim: number; disabled: boolean; onPick: (phaseId: string | null) => void }) {
  if (!phases.length) return null;
  return (
    <div className="acs-ladder">
      {phases.map((ph, i) => (
        <button key={ph.id} className={i <= lim ? "is-in" : ""} disabled={disabled} onClick={() => onPick(i === phases.length - 1 ? null : ph.id)} title={i === phases.length - 1 ? "Every phase" : `Up to ${ph.name}`}>
          <span>{ph.name}</span>
        </button>
      ))}
      <small>{lim >= phases.length - 1 ? "Every phase" : `Up to ${phases[lim]?.name ?? "—"}`}</small>
    </div>
  );
}