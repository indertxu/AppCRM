/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Settings → Organization → Page access.
 *
 * One line per page: the departments that can open it, and — next to it — the
 * people from other departments who may open it too. Bosses and superadmins
 * always open every page; Home and Settings are open to everyone.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import { PageLoader } from "../../framework/AppLayout";
import {
  PAGES, EVERYONE, loadDepartments, loadPageDepartments, savePageDepartments, deptListOpens, usePageAccess, SECURITY_LEVEL_EVENT,
  PAGE_SCOPES, loadScopeRules, saveScopeRules, type DataScope, type ScopeRules,
  loadPageRules, savePageRules, pageRuleKey, type PageRules,
  type Department, type PageKey, useSecurityLevels, levelBase,
  loadCalendarView, saveCalendarView, calendarViewFor, canSeeCalendar, seesCalendarDetail, calViewFallback, isManagerLevel,
  type CalViewRules, type CalViewRule, type CalSee, type CalDetail,
} from "../../framework/pageAccess";
import Select from "../../framework/Select";
import { AREAS, HIDEABLE } from "../management/mgmtAccess";
import "./PageAccessModal.css";

const svg = (children: ReactNode, w = 1.9) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
/* ─────────────── page icons (same as the side menu) ─────────────── */
const PAGE_ICON: Record<PageKey, ReactNode> = {
  home: svg(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></>),
  tickets: svg(<><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z" /><path d="M14 5v12" strokeDasharray="2 2" /></>),
  calendar: svg(<><rect x="3" y="4.5" width="18" height="16" rx="3" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /></>),
  contacts: svg(<><rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="10" r="2.6" /><path d="M8 17a4 4 0 0 1 8 0M4 7h2M4 12h1.5M4 17h2" /></>),
  companies: svg(<><rect x="4" y="3" width="10" height="18" rx="1.5" /><path d="M14 8h6v13H4M7.5 7h3M7.5 11h3M7.5 15h3" /></>),
  clients: svg(<><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><circle cx="17.5" cy="9" r="2.4" /><path d="M16 14.2a4.8 4.8 0 0 1 4.5 4.8" /></>),
  projects: svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M8 13h8M8 16h5" /></>),
  sales: svg(<><path d="M3 3v18h18" /><path d="M7 14l3-3 3 2 5-6" /></>),
  management: svg(<><rect x="3" y="3" width="8" height="7" rx="1.6" /><rect x="13" y="3" width="8" height="4.5" rx="1.6" /><rect x="13" y="10.5" width="8" height="10.5" rx="1.6" /><rect x="3" y="13" width="8" height="8" rx="1.6" /></>),
  success: svg(<><path d="M12 20.5s-7.5-4.4-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.8-7.5 10.2-7.5 10.2z" /><path d="M8.5 12.2h2l1.2-2.2 1.6 4 1.2-1.8h1.5" /></>),
  marketing: svg(<><path d="M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1z" /><path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10" /></>),
  reports: svg(<><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><path d="M8 16v-4M12 16V8M16 16v-6" /></>),
  settings: svg(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>),
};
const LOCK = svg(<><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>);
const CHECK = svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, 2.6);
const GLOBE = svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>);
const WARN = svg(<><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></>, 2);
const CARET = <svg className="pa4-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>;

interface Person { id: string; name: string; department: string | null; full: boolean }
/** null = not set up yet (the current rules apply). */
type Rule = { depts: string[]; users: string[] } | null;
type Draft = Partial<Record<PageKey, Rule>>;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const sameRule = (a: Rule | undefined, b: Rule | undefined) => (a == null || b == null ? (a ?? null) === (b ?? null) : sameSet(a.depts, b.depts) && sameSet(a.users, b.users));
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const fold = (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export default function PageAccessModal({ onClose }: { onClose: () => void }) {
  const { reload } = usePageAccess();
  const [loading, setLoading] = useState(true);
  const [depts, setDepts] = useState<Department[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [base, setBase] = useState<Draft>({});
  const [draft, setDraft] = useState<Draft>({});
  const [missing, setMissing] = useState(false);
  const [usersMissing, setUsersMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pages = PAGES.filter((p) => !p.locked);
  const locked = PAGES.filter((p) => p.locked);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [ds, pd, profs] = await Promise.all([
        loadDepartments(true),
        loadPageDepartments(),
        supabase.from("profiles").select("*").range(0, 99999),
      ]);
      if (!alive) return;
      setDepts(ds);
      const d: Draft = {};
      (Object.keys(pd.map) as PageKey[]).forEach((k) => { d[k] = { depts: pd.map[k] ?? [], users: pd.users[k] ?? [] }; });
      setBase(d); setDraft(d); setMissing(pd.missing); setUsersMissing(pd.usersMissing);
      setPeople(((profs.data ?? []) as any[]).filter((p) => p.active !== false).map((p) => ({
        id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || p.email || "—",
        department: p.department ?? null, full: p.is_superadmin === true || String(p.role ?? "").toLowerCase() === "boss",
      })).sort((a, b) => a.name.localeCompare(b.name)));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const ruleOf = (k: PageKey): Rule => draft[k] ?? null;
  const setRule = (k: PageKey, r: Rule) => {
    setSaved(false); setErr(null);
    setDraft((d) => { const n = { ...d }; if (r == null) delete n[k]; else n[k] = r; return n; });
  };
  const changed = pages.filter((p) => !sameRule(ruleOf(p.key), base[p.key] ?? null));
  const deptCount = useMemo(() => {
    const m = new Map<string, number>();
    people.forEach((p) => { if (p.department) m.set(p.department, (m.get(p.department) ?? 0) + 1); });
    return m;
  }, [people]);
  const deptOf = (k: string | null) => depts.find((d) => d.key === k);
  const others = people.filter((p) => !p.full);

  const save = async () => {
    if (!changed.length || busy) return;
    setBusy(true); setErr(null);
    // a person whose department is now on the list doesn't need to be named any more
    const out = Object.fromEntries(changed.map((p) => {
      const r = ruleOf(p.key);
      if (!r) return [p.key, null];
      const users = r.depts.includes(EVERYONE) ? [] : r.users.filter((id) => !deptListOpens(r.depts, people.find((x) => x.id === id)?.department));
      return [p.key, { depts: r.depts, users }];
    })) as Partial<Record<PageKey, Rule>>;
    const e = await savePageDepartments(out);
    setBusy(false);
    if (e) { setErr(e); return; }
    const next = { ...draft };
    (Object.keys(out) as PageKey[]).forEach((k) => { if (out[k]) next[k] = out[k]; });
    setDraft(next); setBase(next); setSaved(true);
    window.dispatchEvent(new CustomEvent(SECURITY_LEVEL_EVENT));
    await reload();
  };

  return createPortal(
    <div className="pa2-backdrop" onMouseDown={onClose}>
      <div className="pa2 pa4" role="dialog" aria-modal="true" aria-label="Page access" onMouseDown={(e) => e.stopPropagation()}>
        <header className="pa2-head">
          <span className="pa2-head-ico">{svg(<><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>)}</span>
          <div>
            <h2>Page access</h2>
            <p>For each page: the departments that can open it, and anyone else you want to let in.</p>
          </div>
          <button className="pa2-x" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="pa4-notes">
          <span>{LOCK}<b>Bosses</b> and superadmins always open every page.</span>
          <span>{LOCK}<b>{locked.map((p) => p.label).join(" and ")}</b> are open to everyone.</span>
        </div>
        {missing && <p className="pa2-warn">{WARN}<span>Run <b>61_custom_departments.sql</b> in Supabase to save page access.</span></p>}
        {!missing && usersMissing && <p className="pa2-warn">{WARN}<span>Run <b>62_page_access_people.sql</b> in Supabase to let people in by name.</span></p>}

        {loading ? <div className="pa2-loading"><PageLoader fill={false} size={86} label="Loading page access" /></div> : !depts.length ? (
          <div className="pa2-empty"><b>No departments yet</b><span>Create your departments in Organization first, then come back to choose who opens each page.</span></div>
        ) : (
          <div className="pa4-body">
            <div className="pa4-cols" aria-hidden="true"><span>Page</span><span>Departments that can open it</span><span>Also let in</span></div>
            {pages.map((pg, i) => {
              const r = ruleOf(pg.key);
              const all = !!r?.depts.includes(EVERYONE);
              const dirty = changed.some((x) => x.key === pg.key);
              const n = r ? people.filter((p) => p.full || deptListOpens(r.depts, p.department) || r.users.includes(p.id)).length : null;
              const status = r == null ? "Not set yet — the current rules apply"
                : all ? `Everyone · ${n} people`
                : n === people.filter((p) => p.full).length ? "Only bosses and superadmins"
                : `${n} ${n === 1 ? "person" : "people"} can open it`;
              const exceptions = others.filter((p) => !r || !deptListOpens(r.depts, p.department) || r.users.includes(p.id));
              return (
                <section key={pg.key} className={`pa4-row ${dirty ? "is-dirty" : ""} ${r == null ? "is-unset" : ""}`} style={{ "--i": i } as CSSProperties}>
                  <div className="pa4-page">
                    <span className="pa4-page-ico">{PAGE_ICON[pg.key]}</span>
                    <span className="pa4-page-id">
                      <b>{pg.label}{dirty && <i className="pa4-dirty" title="Changed — not saved yet" />}</b>
                      <small>{status}</small>
                    </span>
                  </div>
                  <Multi
                    label={`Departments that can open ${pg.label}`}
                    everyone={{ on: all, label: "Everyone", sub: "every signed-in person" }}
                    options={depts.map((d) => ({ value: d.key, label: d.name, color: d.color, sub: `${deptCount.get(d.key) ?? 0}` }))}
                    value={all ? [] : (r?.depts ?? [])}
                    placeholder={r == null ? "Not set yet" : "No department"}
                    search="Search departments…"
                    onChange={(v, everyone) => setRule(pg.key, { depts: everyone ? [EVERYONE] : v, users: everyone ? [] : r?.users ?? [] })}
                    onClear={() => setRule(pg.key, r && r.users.length ? { depts: [], users: r.users } : null)}
                    clearLabel={r && r.users.length ? "No department" : "Not set"}
                  />
                  <Multi
                    label={`People also let into ${pg.label}`}
                    people
                    disabled={all}
                    options={exceptions.map((p) => ({ value: p.id, label: p.name, color: deptOf(p.department)?.color ?? "#9fb5ab", sub: deptOf(p.department)?.name ?? "No department" }))}
                    value={r?.users ?? []}
                    placeholder={all ? "Everyone is already in" : "Nobody else"}
                    search="Search people…"
                    onChange={(v) => setRule(pg.key, { depts: r?.depts ?? [], users: v })}
                    onClear={() => setRule(pg.key, r && (r.depts.length || !r.users.length) ? { depts: r.depts, users: [] } : null)}
                    clearLabel="Nobody"
                  />
                </section>
              );
            })}
          </div>
        )}

        <footer className="pa2-foot">
          <span className={`pa2-foot-msg ${err ? "is-err" : saved ? "is-ok" : ""}`}>
            {err ?? (saved ? "Saved — everyone's side menu is updated." : changed.length ? `${changed.length} page${changed.length === 1 ? "" : "s"} changed — not saved yet` : "No changes")}
          </span>
          <button className="pa2-btn is-ghost" onClick={() => { setDraft(base); setErr(null); setSaved(false); }} disabled={!changed.length || busy}>Undo changes</button>
          <button className="pa2-btn is-primary" onClick={() => void save()} disabled={!changed.length || busy || missing}>{busy ? "Saving…" : "Save"}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/* ─────────────── a searchable multi-select dropdown ─────────────── */
interface Opt { value: string; label: string; color?: string; sub?: string; group?: string }
function Multi({ label, options, value, onChange, onClear, clearLabel, placeholder, search, everyone, people = false, disabled = false }: {
  label: string; options: Opt[]; value: string[]; onChange: (v: string[], everyone: boolean) => void; onClear: () => void; clearLabel: string;
  placeholder: string; search: string; everyone?: { on: boolean; label: string; sub: string }; people?: boolean; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); setQ(""); return; }
    const place = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.max(320, r.width);
      const below = window.innerHeight - r.bottom, up = below < 400 && r.top > below;
      setPos({ left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)), top: up ? r.top - 8 : r.bottom + 8, width, up });
    };
    place();
    // capture phase: the dialog stops clicks from bubbling, so listen before it does
    const onDown = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  const all = !!everyone?.on;
  const chosen = value.map((v) => options.find((o) => o.value === v)).filter(Boolean) as Opt[];
  const shown = options.filter((o) => !q.trim() || fold(`${o.label} ${o.sub ?? ""}`).includes(fold(q.trim())));
  const toggle = (v: string) => {
    if (all) { onChange(options.map((o) => o.value).filter((x) => x !== v), false); return; }
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v], false);
  };
  return (
    <>
      <button ref={trigger} type="button" className={`pa4-dd ${open ? "is-open" : ""} ${disabled ? "is-off" : ""}`} aria-label={label} aria-haspopup="listbox" aria-expanded={open}
        disabled={disabled} onClick={() => setOpen((v) => !v)}>
        <span className="pa4-dd-val">
          {all ? <span className="pa4-pill is-all"><i>{GLOBE}</i>{everyone!.label}</span>
            : chosen.length ? <>
              {chosen.slice(0, 2).map((o) => {
                const person = people || o.group === "People";
                return (
                  <span key={o.value} className={`pa4-pill ${person ? "is-person" : ""}`} style={{ "--c": o.color ?? "#0a6f4d" } as CSSProperties}>
                    {person ? <i className="pa4-av">{initials(o.label)}</i> : <i />}{person ? o.label.split(" ")[0] : o.label}
                  </span>
                );
              })}
              {chosen.length > 2 && <span className="pa4-more">+{chosen.length - 2}</span>}
            </> : <span className="pa4-ph">{placeholder}</span>}
        </span>
        {CARET}
      </button>
      {open && pos && createPortal(
        <div ref={pop} className={`pa4-pop ${pos.up ? "is-up" : ""}`} role="listbox" aria-multiselectable="true" aria-label={label}
          style={{ left: pos.left, top: pos.top, width: pos.width }} onMouseDown={(e) => e.stopPropagation()}>
          <label className="pa4-pop-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={search} />
          </label>
          {everyone && !q.trim() && (
            <button type="button" role="option" aria-selected={all} className={`pa4-opt is-all ${all ? "is-on" : ""}`} onClick={() => onChange([], !all)}>
              <span className="pa4-box">{CHECK}</span><span className="pa4-opt-ico">{GLOBE}</span><b>{everyone.label}</b><em>{everyone.sub}</em>
            </button>
          )}
          <div className="pa4-opts">
            {shown.length === 0 ? <p className="pa4-empty">{q.trim() ? `Nothing matches “${q}”.` : people ? "Everyone else is already in through their department." : "Nothing to choose."}</p> : shown.map((o, i) => {
              const on = all || value.includes(o.value);
              const person = people || o.group === "People";
              const head = o.group && o.group !== shown[i - 1]?.group ? <span key={`g-${o.group}`} className="pa4-group">{o.group}</span> : null;
              return [head,
                <button type="button" key={o.value} role="option" aria-selected={on} className={`pa4-opt ${on ? "is-on" : ""} ${all ? "is-implied" : ""}`}
                  style={{ "--c": o.color ?? "#0a6f4d", "--i": Math.min(i, 20) } as CSSProperties} onClick={() => toggle(o.value)}>
                  <span className="pa4-box">{CHECK}</span>
                  {person ? <span className="pa4-av">{initials(o.label)}</span> : <span className="pa4-dot" />}
                  <b>{o.label}</b><em>{o.sub}</em>
                </button>];
            })}
          </div>
          <div className="pa4-pop-foot">
            <span>{all ? "Everyone" : `${value.length} selected`}</span>
            <button type="button" onClick={() => { onClear(); }}>{clearLabel}</button>
            <button type="button" className="is-done" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/* =====================================================================
   Settings › <page> › Security: how much of the page's data people see.
   A default for everyone who can open the page, then by department and by
   person. Bosses and superadmins always see everything.
   ===================================================================== */
export function PageSecurity({ page }: { page: PageKey }) {
  const def = PAGE_SCOPES[page];
  const { level, isSuper } = usePageAccess();
  const canEdit = isSuper || levelBase(level) === "boss";
  // the company's security levels (a level that works like Boss can't be limited)
  const LEVELS = useSecurityLevels().filter((l) => l.base !== "boss").map((l) => ({ id: l.key, label: l.name }));
  const [depts, setDepts] = useState<Department[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [access, setAccess] = useState<{ depts: string[]; users: string[] } | null>(null);
  const [rules, setRules] = useState<ScopeRules | null>(null);
  const [missing, setMissing] = useState(false);
  /** Each person's security role: their own, else their department's. */
  const [roleOf, setRoleOf] = useState<Record<string, string | null>>({});
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const savedT = useRef(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [ds, pd, sc, profs, od] = await Promise.all([
        loadDepartments(true), loadPageDepartments(), loadScopeRules(page), supabase.from("profiles").select("*").range(0, 99999),
        supabase.from("org_departments").select("dept_key, security_role"),
      ]);
      if (!alive) return;
      const deptRole = new Map(((od.data ?? []) as any[]).map((d) => [d.dept_key, String(d.security_role ?? "").toLowerCase() || null]));
      setRoleOf(Object.fromEntries(((profs.data ?? []) as any[]).map((p) => [p.id, String(p.security_level ?? p.role ?? "").toLowerCase() || (p.department ? deptRole.get(p.department) ?? null : null)])));
      setDepts(ds);
      setAccess(page in pd.map ? { depts: pd.map[page] ?? [], users: pd.users[page] ?? [] } : null);
      setRules(sc.rules); setMissing(sc.missing);
      setPeople(((profs.data ?? []) as any[]).filter((p) => p.active !== false).map((p) => ({
        id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || p.email || "—",
        department: p.department ?? null, full: p.is_superadmin === true || String(p.role ?? "").toLowerCase() === "boss",
      })).sort((a, b) => a.name.localeCompare(b.name)));
    })();
    return () => { alive = false; };
  }, [page]);

  if (!def) return null;
  if (!rules) return <p className="psec-loading">Loading…</p>;
  const label = (v: DataScope) => def.label[v] ?? v;
  const opts = (withDefault: string | null) => [
    ...(withDefault ? [{ value: "", label: withDefault }] : []),
    ...def.levels.map((v) => ({ value: v, label: label(v), hint: def.hint[v] })),
  ];
  const commit = async (next: ScopeRules) => {
    setRules(next); setState("saving"); setErr(null);
    const e = await saveScopeRules(page, next);
    if (e) { setState("error"); setErr(e); return; }
    setState("saved");
    window.clearTimeout(savedT.current);
    savedT.current = window.setTimeout(() => setState("idle"), 1800);
  };
  const setDept = (k: string, v: DataScope | "") => { const depts2 = { ...rules.depts }; if (v) depts2[k] = v; else delete depts2[k]; void commit({ ...rules, depts: depts2 }); };
  const setRole = (k: string, v: DataScope | "") => { const roles = { ...(rules.roles ?? {}) }; if (v) roles[k] = v; else delete roles[k]; void commit({ ...rules, roles }); };
  const setUser = (id: string, v: DataScope | "" | null) => { const users = { ...rules.users }; if (v) users[id] = v; else delete users[id]; void commit({ ...rules, users }); };
  const opens = (d: Department) => !access || deptListOpens(access.depts, d.key);
  const count = (k: string) => people.filter((p) => p.department === k && !p.full).length;
  const named = Object.keys(rules.users).map((id) => people.find((p) => p.id === id)).filter(Boolean) as Person[];
  const addable = people.filter((p) => !p.full && !(p.id in rules.users));
  const deptOf = (k: string | null) => depts.find((d) => d.key === k);
  const effective = (p: Person): DataScope => (rules.users[p.id] ?? (roleOf[p.id] && rules.roles?.[roleOf[p.id]!]) ?? (p.department && rules.depts[p.department]) ?? rules.default) as DataScope;
  /** People who can open the page (bosses and superadmins aside). */
  const inPage = people.filter((p) => !p.full && (!access || deptListOpens(access.depts, p.department) || access.users.includes(p.id)));
  const roleCount = (k: string) => inPage.filter((p) => roleOf[p.id] === k).length;
  // the roles worth listing: the ones someone who can open the page has, plus any already set
  const roleRows = LEVELS.filter((l) => l.id !== "boss" && (roleCount(l.id) > 0 || !!rules.roles?.[l.id]));
  const pageLabel = PAGES.find((x) => x.key === page)?.label ?? page;

  /* panels inside the page, hidden from departments / security roles / people */
  const panelDefs = PAGE_PANELS[page] ?? [];
  const hideOpts: Opt[] = [
    ...depts.filter(opens).map((d) => ({ value: `d:${d.key}`, label: d.name, color: d.color, sub: `${count(d.key)} ${count(d.key) === 1 ? "person" : "people"}`, group: "Departments" })),
    ...LEVELS.filter((l) => l.id !== "boss" && roleCount(l.id) > 0).map((l) => ({ value: `r:${l.id}`, label: l.label, color: "#0a6f4d", sub: `${roleCount(l.id)} with this role`, group: "Security roles" })),
    ...inPage.map((p) => ({ value: `u:${p.id}`, label: p.name, color: deptOf(p.department)?.color ?? "#9fb5ab", sub: deptOf(p.department)?.name ?? "No department", group: "People" })),
  ];
  const hiddenOf = (k: string) => {
    const h = rules.panels?.[k] ?? {};
    return [...(h.depts ?? []).map((x) => `d:${x}`), ...(h.roles ?? []).map((x) => `r:${x}`), ...(h.users ?? []).map((x) => `u:${x}`)];
  };
  const setHidden = (k: string, v: string[]) => {
    const pick = (pre: string) => v.filter((x) => x.startsWith(pre)).map((x) => x.slice(2));
    const h = { depts: pick("d:"), roles: pick("r:"), users: pick("u:") };
    const panels = { ...(rules.panels ?? {}) };
    if (h.depts.length || h.roles.length || h.users.length) panels[k] = h; else delete panels[k];
    void commit({ ...rules, panels });
  };
  /** How many people who open the page don't get this panel. */
  const hiddenCount = (k: string) => {
    const h = rules.panels?.[k];
    if (!h) return 0;
    return inPage.filter((p) => h.users?.includes(p.id) || (!!roleOf[p.id] && h.roles?.includes(roleOf[p.id]!)) || (!!p.department && h.depts?.includes(p.department))).length;
  };

  return (
    <div className={`psec ${canEdit ? "" : "is-ro"}`}>
      <div className="psec-lead">
        <span className="psec-shield">{svg(<><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>)}</span>
        <p>Choose how much of <b>{pageLabel}</b> people see once they can open it. <b>Bosses</b> and superadmins always see everything. The most specific setting wins: a person, then their security role, then their department, then the default.</p>
        <span className={`psec-state is-${state}`} aria-live="polite">{state === "saving" ? "Saving…" : state === "saved" ? <>{CHECK}Saved</> : state === "error" ? "Not saved" : ""}</span>
      </div>
      {missing && <p className="pa2-warn">{WARN}<span>Run <b>63_page_data_scopes.sql</b> in Supabase to save these settings.</span></p>}
      {err && !missing && <p className="pa2-warn">{WARN}<span>{err}</span></p>}
      {!canEdit && <p className="psec-note">Only a Boss or a superadmin can change this.</p>}

      <div className="psec-default">
        <div>
          <b>Everyone who can open {pageLabel}</b>
          <small>{def.hint[rules.default] ?? ""}</small>
        </div>
        <div className="psec-pick"><Select value={rules.default} disabled={!canEdit} onChange={(v) => v && void commit({ ...rules, default: v as DataScope })} options={opts(null)} /></div>
      </div>

      <div className="psec-group">
        <div className="psec-group-h"><b>By department</b><small>Overrides the default</small></div>
        {depts.length === 0 ? <p className="psec-empty">No departments yet — create them in Organization.</p> : depts.filter(opens).map((d, i) => {
          const can = opens(d);
          const v = rules.depts[d.key] ?? "";
          return (
            <div key={d.key} className={`psec-row ${can ? "" : "is-off"} ${v ? "is-set" : ""}`} style={{ "--c": d.color, "--i": Math.min(i, 20) } as CSSProperties}>
              <span className="psec-dot" />
              <span className="psec-row-id"><b>{d.name}</b><small>{can ? `${count(d.key)} ${count(d.key) === 1 ? "person" : "people"}` : "Can't open this page"}</small></span>
              <div className="psec-pick"><Select value={v} disabled={!canEdit || !can} onChange={(x) => setDept(d.key, (x ?? "") as DataScope | "")} options={opts("Same as default")} /></div>
            </div>
          );
        })}
      </div>

      {depts.some((d) => !opens(d)) && (
        <p className="psec-closed">{LOCK}<span><b>Can't open {pageLabel}:</b> {depts.filter((d) => !opens(d)).map((d) => d.name).join(", ")} — change it in Page access.</span></p>
      )}

      <div className="psec-group">
        <div className="psec-group-h"><b>By security role</b><small>Overrides the department — e.g. a Sales manager sees everything while the rest of Sales sees only their own</small></div>
        {roleRows.length === 0 ? <p className="psec-empty">Nobody who can open {pageLabel} has a security role yet.</p> : roleRows.map((l, i) => {
          const v = rules.roles?.[l.id] ?? "";
          const n = roleCount(l.id);
          const where = Array.from(new Set(inPage.filter((p) => roleOf[p.id] === l.id).map((p) => deptOf(p.department)?.name).filter(Boolean))) as string[];
          return (
            <div key={l.id} className={`psec-row is-role ${v ? "is-set" : ""}`} style={{ "--c": "#0a6f4d", "--i": i } as CSSProperties}>
              <span className="psec-role">{svg(<><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /></>)}</span>
              <span className="psec-row-id"><b>{l.label}</b><small>{n ? `${n} ${n === 1 ? "person" : "people"}${where.length ? ` in ${where.join(", ")}` : ""}` : "Nobody with this role can open the page"}</small></span>
              <div className="psec-pick"><Select value={v} disabled={!canEdit} onChange={(x) => setRole(l.id, (x ?? "") as DataScope | "")} options={opts("Same as their department")} /></div>
            </div>
          );
        })}
      </div>

      <div className="psec-group">
        <div className="psec-group-h"><b>People</b><small>Override everything above</small></div>
        {named.length === 0 && <p className="psec-empty">Nobody has their own setting.</p>}
        {named.map((p, i) => {
          const d = deptOf(p.department);
          return (
            <div key={p.id} className="psec-row is-set" style={{ "--c": d?.color ?? "#9fb5ab", "--i": i } as CSSProperties}>
              <span className="psec-av">{initials(p.name)}</span>
              <span className="psec-row-id"><b>{p.name}</b><small>{d?.name ?? "No department"}</small></span>
              <div className="psec-pick"><Select value={rules.users[p.id]} disabled={!canEdit} onChange={(x) => x && setUser(p.id, x as DataScope)} options={opts(null)} /></div>
              {canEdit && <button className="psec-x" onClick={() => setUser(p.id, null)} aria-label={`Remove ${p.name}'s own setting`} title="Remove — they follow their department again">×</button>}
            </div>
          );
        })}
        {canEdit && addable.length > 0 && (
          <div className="psec-add">
            <Select value="" placeholder="+ Give someone their own setting" onChange={(id) => { if (!id) return; const p = people.find((x) => x.id === id); setUser(id, p ? (effective(p) === "all" ? def.levels[def.levels.length - 1] : "all") : "all"); }}
              options={addable.map((p) => ({ value: p.id, label: p.name, hint: deptOf(p.department)?.name ?? "No department" }))} />
          </div>
        )}
      </div>

      {panelDefs.length > 0 && (
        <div className="psec-panels">
          <div className="psec-panels-h">
            <span className="psec-panels-ico">{svg(<><rect x="3" y="3" width="8" height="7" rx="1.6" /><rect x="13" y="3" width="8" height="4.5" rx="1.6" /><rect x="13" y="10.5" width="8" height="10.5" rx="1.6" /><rect x="3" y="13" width="8" height="8" rx="1.6" /></>)}</span>
            <div><b>Panels</b><small>Everyone who opens {pageLabel} sees every panel. Hide one from a department, a security role or a person.</small></div>
          </div>
          {panelDefs.map((d, i) => {
            const n = hiddenCount(d.key);
            const v = hiddenOf(d.key);
            return (
              <div key={d.key} className={`psec-prow ${v.length ? "is-hidden" : ""}`} style={{ "--i": i } as CSSProperties}>
                <span className={`psec-eye ${v.length ? "is-off" : ""}`}>{v.length
                  ? svg(<><path d="M3 3l18 18" /><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.7 3.2M6.5 7.6C4.3 9.1 3 12 3 12s4 6 9 6a8.6 8.6 0 0 0 4-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>)
                  : svg(<><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="2.6" /></>)}</span>
                <span className="psec-row-id"><b>{d.label}</b><small>{v.length ? `Hidden from ${n} ${n === 1 ? "person" : "people"}` : d.hint}</small></span>
                <div className="psec-hide">
                  <Multi label={`Hide ${d.label} from`} options={hideOpts} value={v} disabled={!canEdit}
                    onChange={(next) => setHidden(d.key, next)} onClear={() => setHidden(d.key, [])} clearLabel="Show to everyone"
                    placeholder="Everyone sees it" search="Find a department, role or person…" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Panels inside a page that Security can hide (keys match each page's own access areas). */
const PAGE_PANELS: Partial<Record<PageKey, { key: string; label: string; hint: string }[]>> = {
  management: AREAS.filter((a) => HIDEABLE.includes(a.key)).map((a) => ({ key: a.key, label: a.label, hint: a.hint })),
};

/** The "Security" section of a page's settings (Bosses and superadmins only), shaped for SettingsShell. */
export function useSecuritySection(page: PageKey) {
  const { level, isSuper, ready } = usePageAccess();
  if (!ready || !(isSuper || level === "boss") || !PAGE_SCOPES[page]) return null;
  return {
    k: "security", label: "Security", icon: "shield", tone: "slate" as const, title: "Security",
    hint: `How much of ${PAGES.find((x) => x.key === page)?.label ?? "this page"} people see: everything, their department's, or only their own`,
    body: <PageSecurity page={page} />,
  };
}

/* =====================================================================
   Who can open one settings panel (e.g. Settings › Calendar), edited where
   it lives: by security role, by department, and people by name.
   Stored as panel rules (page_access_rules). Bosses and superadmins always can.
   ===================================================================== */
const DEFAULT_MANAGERS = ["consultancy_manager", "customer_success", "sales_manager", "it_manager", "marketing_manager", "hr_manager"];
export function PanelAccess({ panelKey, what }: { panelKey: string; what: string }) {
  const { reload, level, isSuper } = usePageAccess();
  const canEdit = isSuper || levelBase(level) === "boss";
  const LEVELS = useSecurityLevels().filter((l) => l.base !== "boss").map((l) => ({ id: l.key, label: l.name }));
  const [rules, setRules] = useState<PageRules | null>(null);
  const [missing, setMissing] = useState(false);
  const [depts, setDepts] = useState<Department[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string; role: string; department: string | null; full: boolean }[]>([]);
  const [draft, setDraft] = useState<{ everyone: boolean; roles: string[]; depts: string[]; users: string[] } | null>(null);
  const [base, setBase] = useState<typeof draft>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    (async () => {
      const [r, ds, profs] = await Promise.all([loadPageRules(), loadDepartments(true), supabase.from("profiles").select("*").range(0, 99999)]);
      setRules(r.rules); setMissing(r.missing); setDepts(ds);
      setPeople(((profs.data ?? []) as any[]).filter((p) => p.active !== false).map((p) => ({
        id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || p.email || "—",
        role: String(p.role ?? "").toLowerCase(), department: p.department ?? null, full: p.is_superadmin === true || String(p.role ?? "").toLowerCase() === "boss",
      })).sort((a, b) => a.name.localeCompare(b.name)));
      const set = Object.values(r.rules).some((m) => m && panelKey in m);
      const pick = (type: string) => Object.entries(r.rules).filter(([k, m]) => k.startsWith(`${type}:`) && (m?.[panelKey] === "all" || m?.[panelKey] === true)).map(([k]) => k.slice(type.length + 1));
      const d = set
        ? { everyone: pick("everyone").length > 0, roles: pick("role"), depts: pick("dept"), users: pick("user") }
        : { everyone: false, roles: DEFAULT_MANAGERS, depts: [], users: [] };
      setDraft(d); setBase(d);
    })().catch(() => setRules({}));
  }, [panelKey]);
  const isSet = !!rules && Object.values(rules).some((m) => m && panelKey in m);
  const dirty = !!draft && !!base && JSON.stringify(draft) !== JSON.stringify(base);
  const opens = (p: { id: string; role: string; department: string | null; full: boolean }) =>
    !!draft && (p.full || draft.everyone || draft.users.includes(p.id) || draft.roles.includes(p.role) || (!!p.department && draft.depts.includes(p.department)));
  const inside = people.filter(opens);
  const save = async () => {
    if (!draft || !rules || busy) return;
    setBusy(true); setMsg(null);
    const next: PageRules = {};
    Object.entries(rules).forEach(([k, m]) => { const c = { ...(m ?? {}) }; delete c[panelKey]; next[k] = c; });
    const put = (k: string, v: "all" | "none") => { next[k] = { ...(next[k] ?? {}), [panelKey]: v }; };
    put(pageRuleKey("everyone", "*"), draft.everyone ? "all" : "none");
    if (!draft.everyone) {
      draft.roles.forEach((r) => put(pageRuleKey("role", r), "all"));
      draft.depts.forEach((d) => put(pageRuleKey("dept", d), "all"));
      draft.users.forEach((u) => put(pageRuleKey("user", u), "all"));
    }
    const e = await savePageRules(next, rules);
    setBusy(false);
    if (e) { setMsg({ ok: false, text: e }); return; }
    setRules(next); setBase(draft); setMsg({ ok: true, text: "Saved" });
    window.dispatchEvent(new CustomEvent(SECURITY_LEVEL_EVENT));
    await reload();
  };
  if (!draft) return <div className="pxa-skel" />;
  const deptName = (k: string | null) => depts.find((d) => d.key === k)?.name ?? "No department";
  return (
    <div className="pxa">
      <p className="pxa-lead">{LOCK}<span>Who can open <b>{what}</b>. <b>Bosses</b> and superadmins always can.{!isSet && " Not set yet: Boss and the managers can, as until now."}</span></p>
      {missing && <p className="pa2-warn">{WARN}<span>Run <b>62_page_access_people.sql</b> in Supabase to save who can open it.</span></p>}
      <div className="pxa-rows">
        <div className="pxa-row">
          <span className="pxa-k"><b>Security roles</b><em>Everyone with one of these roles</em></span>
          <Multi label="Security roles" options={LEVELS.filter((l) => l.id !== "boss").map((l) => ({ value: l.id, label: l.label }))}
            everyone={{ on: draft.everyone, label: "Everyone", sub: "every signed-in person" }}
            value={draft.everyone ? [] : draft.roles} placeholder="No role" search="Search roles…" disabled={!canEdit}
            onChange={(v, all) => setDraft({ ...draft, everyone: all, roles: all ? [] : v })}
            onClear={() => setDraft({ ...draft, everyone: false, roles: [] })} clearLabel="None" />
        </div>
        <div className="pxa-row">
          <span className="pxa-k"><b>Departments</b><em>Everyone in these departments</em></span>
          <Multi label="Departments" options={depts.map((d) => ({ value: d.key, label: d.name, color: d.color, sub: `${people.filter((p) => p.department === d.key).length}` }))}
            value={draft.depts} placeholder={draft.everyone ? "Everyone is in" : "No department"} search="Search departments…" disabled={!canEdit || draft.everyone}
            onChange={(v) => setDraft({ ...draft, depts: v })} onClear={() => setDraft({ ...draft, depts: [] })} clearLabel="None" />
        </div>
        <div className="pxa-row">
          <span className="pxa-k"><b>People</b><em>Also these people, by name</em></span>
          <Multi label="People" people options={people.filter((p) => !p.full).map((p) => ({ value: p.id, label: p.name, color: depts.find((d) => d.key === p.department)?.color ?? "#9fb5ab", sub: deptName(p.department) }))}
            value={draft.users} placeholder={draft.everyone ? "Everyone is in" : "Nobody else"} search="Search people…" disabled={!canEdit || draft.everyone}
            onChange={(v) => setDraft({ ...draft, users: v })} onClear={() => setDraft({ ...draft, users: [] })} clearLabel="Nobody" />
        </div>
      </div>
      <div className="pxa-foot">
        <span className="pxa-who">
          <span className="pxa-avs">{inside.slice(0, 6).map((p) => <i key={p.id} title={p.name}>{initials(p.name)}</i>)}{inside.length > 6 && <em>+{inside.length - 6}</em>}</span>
          <span><b>{inside.length}</b> {inside.length === 1 ? "person" : "people"} can open it</span>
        </span>
        {msg && <span className={`pxa-msg ${msg.ok ? "is-ok" : "is-err"}`}>{msg.text}</span>}
        {canEdit ? (
          <>
            <button type="button" className="pa2-btn is-ghost" disabled={!dirty || busy} onClick={() => { setDraft(base); setMsg(null); }}>Undo</button>
            <button type="button" className="pa2-btn is-primary" disabled={!dirty || busy || missing} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
          </>
        ) : <span className="pxa-msg">Only the Boss level can change this.</span>}
      </div>
    </div>
  );
}


/* =====================================================================
   Settings › Calendar › Who sees whose calendar: for everyone, then by security
   role, by department and by person — which calendars they can lay over theirs,
   and whether they read the entries or only see when people are busy.
   ===================================================================== */
const CAL_SEE: { value: CalSee; label: string; hint: string }[] = [
  { value: "all", label: "Everyone's calendar", hint: "Anyone in the company" },
  { value: "department", label: "Their department", hint: "Everyone in their department, managers included" },
  { value: "team", label: "Their department, not the managers", hint: "Colleagues of their department; not the managers' calendars" },
  { value: "own", label: "Only their own", hint: "Nobody else's calendar" },
];
const CAL_DETAIL: { value: CalDetail; label: string; hint: string }[] = [
  { value: "full", label: "Every detail", hint: "What each entry is, the client, the project and the notes" },
  { value: "department", label: "Details for their department", hint: "Their department in full; only busy times for everyone else" },
  { value: "busy", label: "Only busy times", hint: "When people are busy — enough to find a free slot" },
];
export function CalendarVisibility() {
  const { level, isSuper } = usePageAccess();
  const canEdit = isSuper || levelBase(level) === "boss";
  const LEVELS = useSecurityLevels().filter((l) => l.base !== "boss");
  const [rules, setRules] = useState<CalViewRules | null>(null);
  const [missing, setMissing] = useState(false);
  const [depts, setDepts] = useState<Department[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string; role: string; department: string | null; full: boolean }[]>([]);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [probe, setProbe] = useState("");
  const savedT = useRef(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [r, ds, profs] = await Promise.all([loadCalendarView(), loadDepartments(true), supabase.from("profiles").select("*").range(0, 99999)]);
      if (!alive) return;
      setRules(r.rules); setMissing(r.missing); setDepts(ds);
      setPeople(((profs.data ?? []) as any[]).filter((p) => p.active !== false).map((p) => ({
        id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || p.email || "—",
        role: String(p.security_level ?? p.role ?? "").toLowerCase(), department: p.department ?? null,
        full: p.is_superadmin === true || String(p.role ?? "").toLowerCase() === "boss",
      })).sort((a, b) => a.name.localeCompare(b.name)));
    })();
    return () => { alive = false; };
  }, []);
  if (!rules) return <div className="pxa-skel" />;

  const commit = async (next: CalViewRules) => {
    setRules(next); setState("saving"); setErr(null);
    const e = await saveCalendarView(next);
    if (e) { setState("error"); setErr(e); return; }
    setState("saved");
    window.clearTimeout(savedT.current);
    savedT.current = window.setTimeout(() => setState("idle"), 1800);
  };
  type Bucket = "roles" | "depts" | "users";
  const setIn = (bucket: Bucket, key: string, v: CalViewRule | null) => {
    const m = { ...rules[bucket] };
    if (v) m[key] = v; else delete m[key];
    void commit({ ...rules, [bucket]: m });
  };
  const deptOf = (k: string | null) => depts.find((d) => d.key === k);
  const others = people.filter((p) => !p.full);
  const roleCount = (k: string) => others.filter((p) => p.role === k).length;
  const roleRows = LEVELS.filter((l) => roleCount(l.key) > 0 || !!rules.roles[l.key]);
  const deptRows = depts.filter((d) => others.some((p) => p.department === d.key) || !!rules.depts[d.key]);
  const named = Object.keys(rules.users).map((id) => people.find((p) => p.id === id)).filter(Boolean) as typeof people;
  const addable = others.filter((p) => !(p.id in rules.users));
  const everyone = rules.everyone;
  const ruleOf = (p: (typeof people)[number]) => calendarViewFor(rules, { userId: p.id, department: p.department, role: p.role, isFull: p.full });

  /** The two pickers of a row; `inherit` is what it falls back to when left on "Same as …". */
  const pickers = ({ value, inherit, inheritLabel, onChange }: { value: CalViewRule | null; inherit: CalViewRule; inheritLabel: string | null; onChange: (v: CalViewRule | null) => void }) => {
    const v = value ?? inherit;
    const seeOpts = [...(inheritLabel ? [{ value: "", label: inheritLabel, hint: CAL_SEE.find((o) => o.value === inherit.see)?.label }] : []), ...CAL_SEE];
    const detOpts = [...(inheritLabel ? [{ value: "", label: inheritLabel, hint: CAL_DETAIL.find((o) => o.value === inherit.detail)?.label }] : []), ...CAL_DETAIL];
    return (
      <>
        <div className="cvv-pick"><Select value={value ? value.see : inheritLabel ? "" : v.see} disabled={!canEdit} options={seeOpts}
          onChange={(x) => onChange(!x && inheritLabel ? (value && value.detail !== inherit.detail ? { see: inherit.see, detail: value.detail } : null) : { see: (x || v.see) as CalSee, detail: v.detail })} /></div>
        <div className="cvv-pick"><Select value={value ? value.detail : inheritLabel ? "" : v.detail} disabled={!canEdit} options={detOpts}
          onChange={(x) => onChange(!x && inheritLabel ? (value && value.see !== inherit.see ? { see: value.see, detail: inherit.detail } : null) : { see: v.see, detail: (x || v.detail) as CalDetail })} /></div>
      </>
    );
  };
  const base = everyone ?? { see: "all" as CalSee, detail: "busy" as CalDetail };
  const roleInherit = (key: string) => everyone ?? calViewFallback(key);

  // "Check someone": whose calendars they can open, and how much they read
  const who = people.find((p) => p.id === probe) ?? null;
  const whoRule = who ? ruleOf(who) : null;
  const whoSees = who && whoRule ? people.filter((o) => o.id !== who.id && canSeeCalendar(whoRule, { userId: who.id, department: who.department }, o)) : [];
  const whoReads = who && whoRule ? whoSees.filter((o) => seesCalendarDetail(whoRule, { userId: who.id, department: who.department }, o)).length : 0;

  return (
    <div className={`cvv ${canEdit ? "" : "is-ro"}`}>
      <div className="psec-lead">
        <span className="psec-shield">{svg(<><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="2.6" /></>)}</span>
        <p>Whose calendars people can lay over their own in <b>Calendar</b>, and whether they read the entries or only see when others are busy. <b>Bosses</b> and superadmins see everything. The most specific setting wins: a person, then their security role, then their department, then everyone.</p>
        <span className={`psec-state is-${state}`} aria-live="polite">{state === "saving" ? "Saving…" : state === "saved" ? <>{CHECK}Saved</> : state === "error" ? "Not saved" : ""}</span>
      </div>
      {missing && <p className="pa2-warn">{WARN}<span>Run <b>63_page_data_scopes.sql</b> in Supabase to save these settings.</span></p>}
      {err && !missing && <p className="pa2-warn">{WARN}<span>{err}</span></p>}
      {!canEdit && <p className="psec-note">Only a Boss or a superadmin can change this.</p>}

      <div className="cvv-cols" aria-hidden="true"><span /><span>Can open</span><span>Reads</span></div>
      <div className="cvv-row is-all">
        <span className="cvv-ico">{GLOBE}</span>
        <span className="psec-row-id"><b>Everyone</b><small>{everyone ? "Unless a role, a department or a person says otherwise" : "Not set: everyone finds anyone's free slots; managers read their department"}</small></span>
        {pickers({ value: everyone, inherit: base, inheritLabel: null, onChange: (v) => void commit({ ...rules, everyone: v }) })}
      </div>

      <div className="psec-group">
        <div className="psec-group-h"><b>By security role</b><small>E.g. the Consultancy manager sees the department in full; consultants see each other but not the manager</small></div>
        {roleRows.length === 0 ? <p className="psec-empty">Nobody has a security role yet.</p> : roleRows.map((l, i) => {
          const n = roleCount(l.key);
          return (
            <div key={l.key} className={`cvv-row ${rules.roles[l.key] ? "is-set" : ""}`} style={{ "--i": i } as CSSProperties}>
              <span className={`cvv-ico ${isManagerLevel(l.key) ? "is-mgr" : ""}`}>{svg(<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />)}</span>
              <span className="psec-row-id"><b>{l.name}</b><small>{n} {n === 1 ? "person" : "people"}{isManagerLevel(l.key) ? " · counts as a manager" : ""}</small></span>
              {pickers({ value: rules.roles[l.key] ?? null, inherit: roleInherit(l.key), inheritLabel: "Same as everyone", onChange: (v) => setIn("roles", l.key, v) })}
            </div>
          );
        })}
      </div>

      <div className="psec-group">
        <div className="psec-group-h"><b>By department</b><small>For people whose security role has no setting</small></div>
        {deptRows.length === 0 ? <p className="psec-empty">No departments yet — create them in Organization.</p> : deptRows.map((d, i) => (
          <div key={d.key} className={`cvv-row ${rules.depts[d.key] ? "is-set" : ""}`} style={{ "--c": d.color, "--i": i } as CSSProperties}>
            <span className="psec-dot" />
            <span className="psec-row-id"><b>{d.name}</b><small>{others.filter((p) => p.department === d.key).length} people</small></span>
            {pickers({ value: rules.depts[d.key] ?? null, inherit: everyone ?? { see: "all", detail: "busy" }, inheritLabel: "Same as everyone", onChange: (v) => setIn("depts", d.key, v) })}
          </div>
        ))}
      </div>

      <div className="psec-group">
        <div className="psec-group-h"><b>People</b><small>Override everything above</small></div>
        {named.length === 0 && <p className="psec-empty">Nobody has their own setting.</p>}
        {named.map((p, i) => {
          const d = deptOf(p.department);
          const { users: _drop, ...rest } = rules; void _drop;
          const inherit = calendarViewFor({ ...rest, users: {} }, { userId: p.id, department: p.department, role: p.role, isFull: false });
          return (
            <div key={p.id} className="cvv-row is-set" style={{ "--c": d?.color ?? "#9fb5ab", "--i": i } as CSSProperties}>
              <span className="psec-av">{initials(p.name)}</span>
              <span className="psec-row-id"><b>{p.name}</b><small>{d?.name ?? "No department"}</small></span>
              {pickers({ value: rules.users[p.id] ?? null, inherit: inherit, inheritLabel: "Same as their role", onChange: (v) => setIn("users", p.id, v) })}
              {canEdit && <button className="psec-x" onClick={() => setIn("users", p.id, null)} aria-label={`Remove ${p.name}'s own setting`} title="Remove — they follow their role again">×</button>}
            </div>
          );
        })}
        {canEdit && addable.length > 0 && (
          <div className="psec-add">
            <Select value="" placeholder="+ Give someone their own setting" searchable
              onChange={(id) => { const p = people.find((x) => x.id === id); if (p) setIn("users", p.id, ruleOf(p)); }}
              options={addable.map((p) => ({ value: p.id, label: p.name, hint: deptOf(p.department)?.name ?? "No department" }))} />
          </div>
        )}
      </div>

      <div className="cvv-probe">
        <div className="cvv-probe-h">
          <b>Check someone</b>
          <div className="cvv-probe-pick"><Select value={probe} placeholder="Pick a person…" searchable onChange={setProbe}
            options={people.map((p) => ({ value: p.id, label: p.name, hint: deptOf(p.department)?.name ?? "No department" }))} /></div>
        </div>
        {who && whoRule && (
          <div className="cvv-probe-r">
            <p><b>{who.name.split(" ")[0]}</b> {who.full ? "sees every calendar in full (Boss / superadmin)." : whoSees.length === 0 ? "only sees their own calendar." : <>can open <b>{whoSees.length}</b> {whoSees.length === 1 ? "calendar" : "calendars"} and reads <b>{whoReads === whoSees.length ? "all of them" : whoReads === 0 ? "none" : `${whoReads}`}</b>{whoReads > 0 && whoReads < whoSees.length ? " in full" : ""}{whoReads === 0 ? " in full — only busy times" : ""}.</>}</p>
            {whoSees.length > 0 && (
              <div className="cvv-avs">
                {whoSees.slice(0, 18).map((o) => {
                  const reads = seesCalendarDetail(whoRule, { userId: who.id, department: who.department }, o);
                  return <i key={o.id} className={reads ? "is-reads" : ""} title={`${o.name}${reads ? " · reads it" : " · busy times"}`} style={{ "--c": deptOf(o.department)?.color ?? "#9fb5ab" } as CSSProperties}>{initials(o.name)}</i>;
                })}
                {whoSees.length > 18 && <em>+{whoSees.length - 18}</em>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
