/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import {
  AREAS, KNOWN_ROLES, LEVEL_LABEL, LEVEL_SHORT, areaDef, isAdminRole,
  loadRules, roleLabel, type Area, type Level,
} from "./mgmtAccess";
import {
  asLevel, loadPageRules, pageRuleKey, resolvePanel, savePageRules, SECURITY_LEVEL_EVENT,
  type AccessPerson, type PageRules, type PageSourceKind,
} from "../../framework/pageAccess";
import { useInactiveIds } from "../../framework/peopleStatus";
import "./MgmtSecurityModal.css";

interface Props {
  people: Record<string, string>;
  onClose: () => void;
  /** Called after a successful save so the page can re-resolve access. */
  onSaved: () => void;
  /** Render inside another container (Management settings → Security tab)
      instead of as its own full-screen modal. */
  embedded?: boolean;
}

/** role = the person's security level (their own, else their department's). */
interface Person { id: string; name: string; role: string; department: string | null; isSuper: boolean; jobTitle: string }
type View = "roles" | "people" | "overview";
const k = (type: "role" | "user", id: string, area: Area) => `${type}|${id}|${area}`;
/* Rules live with the rest of page access (page_access_rules, keys "management.<area>"),
   so department and everyone rules set in Settings → Organization → Page access count too. */
const mk = (area: Area) => `management.${area}`;
const asPerson = (p: Person): AccessPerson => ({ id: p.id, level: p.role || null, department: p.department, isSuper: p.isSuper });
const FROM: Record<PageSourceKind, string> = { boss: "full access", locked: "always", user: "exception", role: "role rule", dept: "department", everyone: "everyone", default: "default" };
/** The rules with one subject's setting for one area taken out. */
const without = (rules: PageRules, type: "role" | "user", id: string, area: Area): PageRules => {
  const key = pageRuleKey(type, id);
  if (!rules[key] || rules[key]![mk(area)] === undefined) return rules;
  const m = { ...rules[key] }; delete m[mk(area)];
  return { ...rules, [key]: m };
};
/** Apply the draft (null = remove) to the stored rules. */
const applyDraft = (base: PageRules, draft: Map<string, Level | null>): PageRules => {
  const out: PageRules = { ...base };
  draft.forEach((lvl, key) => {
    const [type, id, area] = key.split("|") as ["role" | "user", string, Area];
    const sk = pageRuleKey(type, id);
    const m = { ...(out[sk] ?? {}) };
    if (lvl === null) delete m[mk(area)]; else m[mk(area)] = lvl;
    if (Object.keys(m).length) out[sk] = m; else delete out[sk];
  });
  return out;
};

/* ---------- small popover rendered in a portal so tables never clip it ---------- */
function LevelMenu({ anchor, area, value, inheritLabel, onPick, onClose }: {
  anchor: DOMRect; area: Area; value: Level | null; inheritLabel: string;
  onPick: (l: Level | null) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("mousedown", off, true);
    window.addEventListener("keydown", esc, true);
    return () => { window.removeEventListener("mousedown", off, true); window.removeEventListener("keydown", esc, true); };
  }, [onClose]);
  const top = Math.min(anchor.bottom + 6, window.innerHeight - 220);
  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - 95), window.innerWidth - 198);
  return createPortal(
    <div ref={ref} className="msec-menu" style={{ top, left }} onMouseDown={(e) => e.stopPropagation()}>
      <button className={`msec-mi ${value === null ? "is-on" : ""}`} onClick={() => onPick(null)}>
        <span className="msec-dot is-inherit" />{inheritLabel}
      </button>
      {areaDef(area).levels.map((l) => (
        <button key={l} className={`msec-mi ${value === l ? "is-on" : ""}`} onClick={() => onPick(l)}>
          <span className={`msec-dot is-${l}`} />{LEVEL_LABEL[l]}
        </button>
      ))}
    </div>,
    document.body,
  );
}

function Pill({ level, ghost, onClick, locked }: { level: Level; ghost?: boolean; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; locked?: boolean }) {
  return (
    <button type="button" className={`msec-pill is-${level} ${ghost ? "is-ghost" : ""} ${locked ? "is-locked" : ""}`} onClick={onClick} disabled={locked}>
      {LEVEL_SHORT[level]}
    </button>
  );
}

export default function MgmtSecurityModal({ people, onClose, onSaved, embedded = false }: Props) {
  const [view, setView] = useState<View>("roles");
  const [loading, setLoading] = useState(true);
  const [allPersons, setPersons] = useState<Person[]>([]);
  const inactive = useInactiveIds();
  const persons = useMemo(() => allPersons.filter((x) => !inactive.has(x.id)), [allPersons, inactive]);
  const [orig, setOrig] = useState<PageRules>({});
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState<Map<string, Level | null>>(new Map()); // null = remove rule
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ rect: DOMRect; type: "role" | "user"; id: string; area: Area; inheritLabel: string } | null>(null);
  const [q, setQ] = useState("");
  const [selPerson, setSelPerson] = useState<string | null>(null);

  useEffect(() => {
    if (embedded) return; // the host modal owns Escape and scroll locking
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !menu) onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose, menu, embedded]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [pa, { data: profs }, { data: depts }] = await Promise.all([
        loadPageRules(),
        supabase.from("profiles").select("*").range(0, 99999),
        supabase.from("org_departments").select("dept_key, security_role"),
      ]);
      let base = pa.rules;
      if (pa.missing) {
        // empower_page_access_v3.sql not run yet: show the older rules (read-only until it is)
        base = { ...base };
        (await loadRules()).forEach((r) => {
          const sk = pageRuleKey(r.subject_type, r.subject_type === "role" ? r.subject_id.toLowerCase() : r.subject_id);
          base[sk] = { ...(base[sk] ?? {}), [mk(r.area)]: r.level };
        });
      }
      setOrig(base); setMissing(pa.missing);
      const deptRole = new Map(((depts ?? []) as any[]).map((d) => [d.dept_key, (d.security_role ?? "").toLowerCase()]));
      setPersons(((profs ?? []) as any[]).map((p) => ({
        id: p.id,
        name: people[p.id] ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || "—"),
        role: (p.role ?? "").toLowerCase() || (p.department ? deptRole.get(p.department) ?? "" : ""),
        department: p.department ?? null,
        isSuper: p.is_superadmin === true, jobTitle: p.job_title ?? "",
      })).sort((a, b) => a.name.localeCompare(b.name)));
      setLoading(false);
    })();
  }, [people]);

  /* ---- effective rules = orig with the draft applied ---- */
  const rules = useMemo<PageRules>(() => applyDraft(orig, draft), [orig, draft]);
  const ruleOf = (type: "role" | "user", id: string, area: Area): Level | null =>
    asLevel(rules[pageRuleKey(type, id)]?.[mk(area)]) ?? null;
  const origOf = (type: "role" | "user", id: string, area: Area): Level | null =>
    asLevel(orig[pageRuleKey(type, id)]?.[mk(area)]) ?? null;
  /** What a role gets in an area when it has no rule of its own. */
  const roleInherit = (role: string, area: Area) =>
    resolvePanel(mk(area), { id: "__probe", level: role, department: null }, without(rules, "role", role, area));
  /** What a person gets in an area without their own exception. */
  const personInherit = (p: Person, area: Area) => resolvePanel(mk(area), asPerson(p), without(rules, "user", p.id, area));
  const effective = (p: Person, area: Area) => resolvePanel(mk(area), asPerson(p), rules);

  const setRule = (type: "role" | "user", id: string, area: Area, lvl: Level | null) =>
    setDraft((d) => {
      const n = new Map(d);
      const key = k(type, id, area);
      const was = origOf(type, id, area);
      if (lvl === was) n.delete(key); else n.set(key, lvl);
      return n;
    });

  const roles = useMemo(() => {
    const set = new Set(KNOWN_ROLES);
    persons.forEach((p) => p.role && set.add(p.role));
    return [...set].map((r) => ({ key: r, count: persons.filter((p) => p.role === r).length }))
      .sort((a, b) => (a.key === "boss" ? -1 : b.key === "boss" ? 1 : b.count - a.count || a.key.localeCompare(b.key)));
  }, [persons]);

  const exceptionsOf = (uid: string) => AREAS.filter((a) => ruleOf("user", uid, a.key) !== null).length;
  const shownPersons = persons.filter((p) =>
    !q.trim() || `${p.name} ${p.role} ${p.jobTitle}`.toLowerCase().includes(q.trim().toLowerCase()));
  const sel = persons.find((p) => p.id === selPerson) ?? null;

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>, type: "role" | "user", id: string, area: Area, inheritLabel: string) =>
    setMenu({ rect: e.currentTarget.getBoundingClientRect(), type, id, area, inheritLabel });

  const save = async () => {
    if (!draft.size) return;
    if (missing) { setError("Run empower_page_access_v3.sql in Supabase first, then save again."); return; }
    setSaving(true); setError(null);
    const e = await savePageRules(applyDraft(orig, draft), orig);
    if (e) {
      setError(/row-level security|Only the Boss/.test(e) ? "You don't have permission to change Management security." : e);
      setSaving(false); return;
    }
    const fresh = await loadPageRules();
    setOrig(fresh.rules);
    setDraft(new Map());
    setSaving(false);
    window.dispatchEvent(new Event(SECURITY_LEVEL_EVENT));
    onSaved();
  };

  const viewSwitch = (
    <div className="msec-views">
      {(["roles", "people", "overview"] as View[]).map((v) => (
        <button key={v} className={view === v ? "is-on" : ""} onClick={() => setView(v)}>
          {v === "roles" ? "By role" : v === "people" ? "By person" : "Effective access"}
        </button>
      ))}
    </div>
  );

  const inner = (
    <>
        {embedded ? (
          <div className="msec-toolbar">
            <span className="msec-sub">Who can see what in Management · by role, with per-person exceptions</span>
            {viewSwitch}
          </div>
        ) : (
        <header className="msec-head">
          <div className="msec-head-main">
            <span className="msec-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>
            </span>
            <div>
              <h2 className="msec-title">Security</h2>
              <span className="msec-sub">Who can see what in Management · by role, with per-person exceptions</span>
            </div>
          </div>
          {viewSwitch}
          <button className="msec-x" onClick={onClose} aria-label="Close">×</button>
        </header>
        )}

        <div className="msec-legend">
          <span><i className="msec-dot is-all" />Everyone — sees all data</span>
          <span><i className="msec-dot is-own" />Only own — sees only their own data</span>
          <span><i className="msec-dot is-none" />No access — hidden</span>
          <span className="msec-legend-note">Boss and superadmins always have full access.</span>
        </div>

        <div className="msec-body">
          {loading ? <p className="msec-empty">Loading…</p> : view === "roles" ? (
            /* ================= BY ROLE ================= */
            <div className="msec-matrix-wrap">
              <table className="msec-matrix">
                <thead>
                  <tr>
                    <th className="msec-th-role">Role</th>
                    {AREAS.map((a) => <th key={a.key} title={a.hint}><span>{a.label}</span></th>)}
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => {
                    const admin = isAdminRole(r.key, false);
                    return (
                      <tr key={r.key} className={admin ? "is-admin" : ""}>
                        <td className="msec-td-role">
                          <b>{roleLabel(r.key)}</b>
                          <span>{r.count} {r.count === 1 ? "person" : "people"}</span>
                        </td>
                        {AREAS.map((a) => {
                          if (admin) return <td key={a.key}><Pill level="all" locked /></td>;
                          const rule = ruleOf("role", r.key, a.key);
                          const inh = roleInherit(r.key, a.key);
                          const dflt = inh.level;
                          const changed = draft.has(k("role", r.key, a.key));
                          return (
                            <td key={a.key} className={changed ? "is-dirty" : ""}>
                              <Pill level={rule ?? dflt} ghost={rule === null}
                                onClick={(e) => openMenu(e, "role", r.key, a.key, `${inh.source === "everyone" ? "Everyone" : "Default"} (${LEVEL_SHORT[dflt]})`)} />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="msec-foot-hint">Faded = inherited (built-in default, or the Everyone rule in Page access). Solid = a rule you set. Click any cell to change it.</p>
            </div>
          ) : view === "people" ? (
            /* ================= BY PERSON ================= */
            <div className="msec-people">
              <aside className="msec-plist">
                <input className="msec-search" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="msec-plist-scroll">
                  {shownPersons.map((p) => {
                    const ex = exceptionsOf(p.id);
                    return (
                      <button key={p.id} className={`msec-prow ${selPerson === p.id ? "is-on" : ""}`} onClick={() => setSelPerson(p.id)}>
                        <span className="msec-av">{(p.name || "?").charAt(0).toUpperCase()}</span>
                        <span className="msec-prow-txt"><b>{p.name}</b><span>{roleLabel(p.role)}{p.isSuper ? " · superadmin" : ""}</span></span>
                        {ex > 0 && <span className="msec-badge">{ex} {ex === 1 ? "exception" : "exceptions"}</span>}
                      </button>
                    );
                  })}
                </div>
              </aside>
              <section className="msec-pdetail">
                {!sel ? (
                  <p className="msec-empty">Pick a person to set exceptions that override their role.</p>
                ) : isAdminRole(sel.role, sel.isSuper) ? (
                  <div className="msec-locked">
                    <h3>{sel.name}</h3>
                    <p>{sel.isSuper ? "Superadmin" : "Boss"} — always has full access to every part of Management. This can't be restricted, so nobody gets locked out.</p>
                  </div>
                ) : (
                  <>
                    <div className="msec-pd-head">
                      <span className="msec-av is-lg">{(sel.name || "?").charAt(0).toUpperCase()}</span>
                      <div><h3>{sel.name}</h3><span>{roleLabel(sel.role)}{sel.jobTitle ? ` · ${sel.jobTitle}` : ""}</span></div>
                    </div>
                    <div className="msec-pd-rows">
                      <div className="msec-pd-row is-head"><span>Area</span><span>Inherited</span><span>Exception</span><span>Result</span></div>
                      {AREAS.map((a) => {
                        const own = ruleOf("user", sel.id, a.key);
                        const inh = personInherit(sel, a.key);
                        const inherited = inh.level;
                        const eff = effective(sel, a.key).level;
                        const dirty = draft.has(k("user", sel.id, a.key));
                        return (
                          <div className={`msec-pd-row ${dirty ? "is-dirty" : ""}`} key={a.key}>
                            <span className="msec-pd-area"><b>{a.label}</b><em>{a.hint}</em></span>
                            <span className="msec-pd-from"><Pill level={inherited} ghost /> <em>{FROM[inh.source]}</em></span>
                            <span className="msec-seg">
                              <button className={own === null ? "is-on" : ""} onClick={() => setRule("user", sel.id, a.key, null)}>Inherit</button>
                              {a.levels.map((l) => (
                                <button key={l} className={`is-${l} ${own === l ? "is-on" : ""}`} onClick={() => setRule("user", sel.id, a.key, l)}>{LEVEL_SHORT[l]}</button>
                              ))}
                            </span>
                            <span className="msec-pd-eff"><Pill level={eff} locked />{own !== null && <i className="msec-flag">exception</i>}</span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>
            </div>
          ) : (
            /* ================= EFFECTIVE ACCESS ================= */
            <div className="msec-matrix-wrap">
              <table className="msec-matrix is-overview">
                <thead>
                  <tr>
                    <th className="msec-th-role">Person</th>
                    {AREAS.map((a) => <th key={a.key} title={a.hint}><span>{a.label}</span></th>)}
                  </tr>
                </thead>
                <tbody>
                  {persons.map((p) => (
                    <tr key={p.id}>
                      <td className="msec-td-role"><b>{p.name}</b><span>{roleLabel(p.role)}</span></td>
                      {AREAS.map((a) => {
                        const res = effective(p, a.key);
                        return (
                          <td key={a.key}>
                            <span className={`msec-eff is-${res.level}`} title={`From: ${FROM[res.source]}`}>
                              {LEVEL_SHORT[res.level]}{res.source === "user" && <sup>•</sup>}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="msec-foot-hint">• = personal exception. Hover a cell to see where the access comes from (role, department, everyone or default — the last two can also be set in Settings → Organization → Page access).</p>
            </div>
          )}
        </div>

        <footer className="msec-foot">
          <span className={`msec-foot-note ${error ? "is-error" : ""}`}>
            {error ? error : missing ? "Read-only until empower_page_access_v3.sql is run in Supabase" : draft.size ? `${draft.size} unsaved ${draft.size === 1 ? "change" : "changes"}` : "All changes saved"}
          </span>
          <div className="msec-foot-actions">
            <button className="msec-btn is-ghost" disabled={!draft.size || saving} onClick={() => setDraft(new Map())}>Discard</button>
            <button className="msec-btn is-primary" disabled={!draft.size || saving} onClick={save}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </footer>

      {menu && (
        <LevelMenu
          anchor={menu.rect} area={menu.area}
          value={ruleOf(menu.type, menu.id, menu.area)}
          inheritLabel={menu.inheritLabel}
          onPick={(l) => { setRule(menu.type, menu.id, menu.area, l); setMenu(null); }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );

  if (embedded) return <div className="msec is-embedded">{inner}</div>;
  return createPortal(
    <div className="msec-backdrop" onMouseDown={onClose}>
      <div className="msec" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Management security">
        {inner}
      </div>
    </div>,
    document.body,
  );
}