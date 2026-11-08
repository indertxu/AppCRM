/* =====================================================================
   BASE · Settings › Organization — step by step, in panels side by side.
     1 · Departments — your own (any name); each gets a colour on its own
     2 · Its people  — who is in it; add a new person or move someone in;
                       which pages the department opens
     3 · The person  — name, wage, bank account; security level, department,
                       manager; pages opened for them by name
   On the right, a light chart: the company (departments and their people),
   or the department picked (who reports to whom). Clicking it picks too.
   Security levels are made for you: Boss, and for every department
   "<Department>" and "<Department> manager". Built-in roles nobody uses
   aren't listed.
   Same tables as the Enterprise map: org_departments, profiles,
   security_levels, page_departments (dept_keys + user_ids).
   ===================================================================== */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { supabase } from "../../../components/api/supabase";
import Select from "../../framework/Select";
import NewUserModal, { type NewUserPayload } from "./NewUserModal";
import {
  DEPT_COLORS, BUILTIN_LEVELS, deptFromRow, departmentsChanged, newDeptKey, useSecurityLevels, levelBase, loadSecurityLevels, securityLevelsChanged,
  newLevelKey, BASE_HINT, SECURITY_LEVEL_EVENT, PAGES, EVERYONE, loadPageDepartments, savePageDepartments, type PageKey, type SecurityLevel,
} from "../../framework/pageAccess";
import "./OrgSteps.css";

interface DeptRow { id: string; dept_key: string; name?: string | null; color?: string | null; icon?: string | null; sort?: number | null; security_role: string | null }
interface Person {
  id: string; first_name: string | null; last_name: string | null; email: string | null; role: string | null;
  security_level: string | null; department: string | null; manager_id: string | null; active: boolean;
  salary: number | null; bank_iban: string | null; phone: string | null;
}
const nameOf = (u: Person) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "—";
const initials = (u: Person) => (nameOf(u).split(/\s+/).map((w) => w[0]).join("").slice(0, 2) || "?").toUpperCase();
const NONE = "__none";
/** The Base app's pages someone can be given (Home and Settings are always open), with their Base names. */
const BASE_PAGES: Partial<Record<PageKey, string>> = { tickets: "Tasks", calendar: "Calendar", contacts: "Orbit", sales: "Deals", marketing: "Growth · Marketing", success: "Growth · Customers", management: "Billing" };
const OPENABLE = PAGES.filter((p) => !p.locked && BASE_PAGES[p.key]).map((p) => ({ ...p, label: BASE_PAGES[p.key]! }));
const managerName = (dept: string) => `${dept} manager`;
/** What a department's two levels work like: its built-in roles when it has them, else a team member / a team manager. */
const basesFor = (deptKey: string) => {
  const own = BUILTIN_LEVELS.filter((b) => b.dept === deptKey && b.key !== "boss");
  return { member: own.find((b) => !/manager/.test(b.key))?.key ?? "consultant", manager: own.find((b) => /manager/.test(b.key))?.key ?? "consultancy_manager" };
};

const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  plus: "M12 5v14M5 12h14",
  chev: "M9 6l6 6-6 6",
  x: "M18 6L6 18M6 6l12 12",
  people: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z",
  layers: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  check: "M20 6L9 17l-5-5",
  move: "M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  tree: "M12 3v6M5 15v-3h14v3M5 15v2M19 15v2M12 9v6",
  crown: "M3 18h18M4 16l2-9 5 4 1-6 1 6 5-4 2 9z",
};

interface Props { canManage: boolean; onBack?: () => void; corner?: ReactNode }

export default function OrgSteps({ canManage, onBack, corner }: Props) {
  const levels = useSecurityLevels();
  const [depts, setDepts] = useState<DeptRow[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [pageMap, setPageMap] = useState<{ depts: Partial<Record<PageKey, string[]>>; users: Partial<Record<PageKey, string[]>> }>({ depts: {}, users: {} });
  const [loading, setLoading] = useState(true);
  const [dept, setDept] = useState<string | null>(null);       // dept_key, or NONE (people without one)
  const [personId, setPersonId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const flash = (m: string) => { setErr(m); window.setTimeout(() => setErr(null), 6000); };

  const metaOf = (rows: DeptRow[]) => rows.map((r, i) => deptFromRow(r, i));
  const setDeptRows = (rows: DeptRow[]) => {
    const meta = metaOf(rows);
    const order = new Map(meta.map((m) => [m.key, m.sort]));
    setDepts(rows.slice().sort((a, b) => (order.get(a.dept_key) ?? 0) - (order.get(b.dept_key) ?? 0)));
    departmentsChanged(meta);
  };
  const meta = useMemo(() => new Map(metaOf(depts).map((m) => [m.key, m])), [depts]); // eslint-disable-line react-hooks/exhaustive-deps
  const deptName = (k: string | null) => (k ? meta.get(k)?.name ?? k : "No department");
  const deptColor = (k: string | null) => (k ? meta.get(k)?.color ?? "#5a7d6d" : "#9aa7a0");

  const load = useCallback(async () => {
    setLoading(true);
    // departments are 100% your own: a new company starts with none
    const { data: rows } = await supabase.from("org_departments").select("*");
    setDeptRows((rows ?? []) as DeptRow[]);
    let res: any = await supabase.from("profiles").select("id, first_name, last_name, email, role, security_level, department, manager_id, active, salary, bank_iban, phone");
    if (res.error) res = await supabase.from("profiles").select("id, first_name, last_name, email, role, department, manager_id");
    setPeople(((res.data ?? []) as any[]).map((p) => ({ ...p, security_level: p.security_level ?? null, active: p.active !== false, salary: p.salary ?? null, bank_iban: p.bank_iban ?? null, phone: p.phone ?? null })).filter((p) => p.active));
    const pd = await loadPageDepartments();
    setPageMap({ depts: pd.map, users: pd.users });
    setLoading(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  /* ---------------- security levels: Boss + two per department, made for you ---------------- */
  const pairOf = useCallback((key: string, name: string, ls: SecurityLevel[] = levels) => ({
    member: ls.find((l) => l.dept === key && l.name.toLowerCase() === name.toLowerCase()),
    manager: ls.find((l) => l.dept === key && l.name.toLowerCase() === managerName(name).toLowerCase()),
  }), [levels]);
  const ensuring = useRef(false);
  const ensureLevels = useCallback(async (rows: DeptRow[]) => {
    if (!canManage || ensuring.current) return;
    ensuring.current = true;
    try {
      const all = await loadSecurityLevels(true);
      const taken = all.map((l) => l.key);
      let sort = Math.max(0, ...all.filter((l) => l.sort < 900).map((l) => l.sort)) + 1;
      const add: any[] = [];
      rows.forEach((d) => {
        const name = (d.name ?? "").trim() || deptFromRow(d).name; // from the row: the name lookup may not be ready yet
        const p = pairOf(d.dept_key, name, all);
        const b = basesFor(d.dept_key);
        if (!p.member) { const k = newLevelKey(name, taken); taken.push(k); add.push({ level_key: k, name, dept_key: d.dept_key, base_role: b.member, sort: sort++ }); }
        if (!p.manager) { const k = newLevelKey(managerName(name), taken); taken.push(k); add.push({ level_key: k, name: managerName(name), dept_key: d.dept_key, base_role: b.manager, sort: sort++ }); }
      });
      if (!all.some((l) => l.key === "boss" && !l.id.startsWith("builtin:"))) add.push({ level_key: "boss", name: "Boss", dept_key: null, base_role: "boss", sort: 0, built_in: true });
      if (add.length) {
        const { error } = await supabase.from("security_levels").insert(add);
        if (error && !/duplicate/i.test(error.message)) flash(`Could not make the security levels: ${error.message}`);
        securityLevelsChanged(await loadSecurityLevels(true));
      }
    } finally { ensuring.current = false; }
  }, [canManage, pairOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const deptKeys = depts.map((d) => `${d.dept_key}:${d.name ?? ""}`).join("|");
  useEffect(() => { if (!loading && depts.length) void ensureLevels(depts); }, [loading, deptKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The levels listed: Boss, the departments' own, and any other one someone is on. */
  const deptLevels = useMemo(() => {
    const m = new Map<string, { member?: SecurityLevel; manager?: SecurityLevel }>();
    depts.forEach((d) => m.set(d.dept_key, pairOf(d.dept_key, (d.name ?? "").trim() || deptFromRow(d).name)));
    return m;
  }, [depts, pairOf]);
  const pairKeys = useMemo(() => new Set([...deptLevels.values()].flatMap((p) => [p.member?.key, p.manager?.key]).filter(Boolean) as string[]), [deptLevels]);
  const shownLevels = useMemo(() => {
    const used = new Set(people.map((p) => p.security_level ?? p.role).filter(Boolean) as string[]);
    return levels.filter((l) => l.key === "boss" || pairKeys.has(l.key) || used.has(l.key));
  }, [levels, people, pairKeys]);
  const isManagerLevel = (k: string | null | undefined) => !!k && [...deptLevels.values()].some((p) => p.manager?.key === k);

  /* ---------------- departments ---------------- */
  const createDept = async (name: string): Promise<string | null> => {
    const clean = name.trim();
    if (!clean) return "Give it a name.";
    if (depts.some((d) => deptName(d.dept_key).toLowerCase() === clean.toLowerCase())) return "There is already one with that name.";
    const key = newDeptKey(clean, depts.map((d) => d.dept_key));
    const used = new Set(depts.map((d) => deptColor(d.dept_key)));
    const color = DEPT_COLORS.find((c) => !used.has(c)) ?? DEPT_COLORS[depts.length % DEPT_COLORS.length];
    const sort = Math.max(-1, ...metaOf(depts).map((m) => m.sort)) + 1;
    const { data, error } = await supabase.from("org_departments").insert({ dept_key: key, name: clean, color, sort }).select("*").single();
    if (error) return error.message;
    setDeptRows([...depts, data as DeptRow]);
    setDept(key); setPersonId(null);
    return null;
  };
  const renameDept = async (row: DeptRow, name: string) => {
    const old = deptName(row.dept_key);
    const p = pairOf(row.dept_key, old);
    setDeptRows(depts.map((d) => (d.id === row.id ? { ...d, name } : d)));
    const { error } = await supabase.from("org_departments").update({ name }).eq("id", row.id);
    if (error) { setDeptRows(depts); flash(`Could not save: ${error.message}`); return; }
    // its levels follow the name
    const ups = [p.member && { id: p.member.id, name }, p.manager && { id: p.manager.id, name: managerName(name) }].filter(Boolean) as { id: string; name: string }[];
    for (const u of ups) if (!u.id.startsWith("builtin:")) await supabase.from("security_levels").update({ name: u.name }).eq("id", u.id);
    if (ups.length) securityLevelsChanged(await loadSecurityLevels(true));
  };
  const deleteDept = async (row: DeptRow) => {
    const n = people.filter((p) => p.department === row.dept_key).length;
    if (!confirm(`Remove ${deptName(row.dept_key)}?${n ? ` Its ${n} ${n === 1 ? "person stays" : "people stay"}, without a department.` : ""}`)) return;
    if (n) {
      const { error } = await supabase.from("profiles").update({ department: null }).eq("department", row.dept_key);
      if (error) { flash(error.message); return; }
    }
    const { data, error } = await supabase.from("org_departments").delete().eq("id", row.id).select("id");
    if (error || !(data ?? []).length) { flash(error?.message ?? "You can't remove departments."); return; }
    setPeople((ps) => ps.map((p) => (p.department === row.dept_key ? { ...p, department: null } : p)));
    setDeptRows(depts.filter((d) => d.id !== row.id));
    setDept(null); setPersonId(null);
  };

  /* ---------------- people ---------------- */
  const savePerson = async (id: string, patch: Partial<Person>) => {
    const before = people.find((p) => p.id === id);
    setPeople((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    let { error } = await supabase.from("profiles").update(patch).eq("id", id);
    if (error && "security_level" in patch && /security_level/i.test(error.message)) {
      const rest: any = { ...patch }; delete rest.security_level;
      ({ error } = await supabase.from("profiles").update(rest).eq("id", id));
    }
    if (error) { if (before) setPeople((ps) => ps.map((p) => (p.id === id ? before : p))); flash(`Could not save: ${error.message}`); return; }
    if ("security_level" in patch || "role" in patch) window.dispatchEvent(new CustomEvent(SECURITY_LEVEL_EVENT));
  };
  /** Moving someone to a department puts them on its level (manager stays manager). */
  const moveTo = (p: Person, key: string | null) => {
    const patch: Partial<Person> = { department: key };
    if (key) {
      const was = levels.find((l) => l.key === (p.security_level ?? p.role));
      const pr = pairOf(key, deptName(key));
      const target = was?.key === "boss" ? null : /manager/i.test(was?.name ?? "") ? pr.manager : pr.member;
      if (target) { patch.security_level = target.key; patch.role = levelBase(target.key) ?? target.base; }
      const boss = managerOf(key);
      if (boss && boss.id !== p.id && target && !isManagerLevel(target.key)) patch.manager_id = boss.id;
    }
    void savePerson(p.id, patch);
  };
  /** A department's manager: everyone else in it reports to them. */
  const setLevel = async (p: Person, k: string) => {
    await savePerson(p.id, { security_level: k, role: levelBase(k) ?? "consultant" });
    if (!p.department || !isManagerLevel(k)) return;
    const team = people.filter((x) => x.id !== p.id && x.department === p.department && !isManagerLevel(x.security_level ?? x.role));
    if (!team.length) return;
    setPeople((ps) => ps.map((x) => (team.some((t) => t.id === x.id) ? { ...x, manager_id: p.id } : x)));
    const { error } = await supabase.from("profiles").update({ manager_id: p.id }).in("id", team.map((t) => t.id));
    if (error) flash(`Could not set who reports to ${nameOf(p)}: ${error.message}`);
  };
  const managerOf = (key: string | null) => (key ? people.find((x) => x.department === key && isManagerLevel(x.security_level ?? x.role)) : undefined);
  const removePerson = async (p: Person) => {
    if (!confirm(`Delete ${nameOf(p)} permanently? This removes their account and cannot be undone.`)) return;
    const { data, error } = await supabase.functions.invoke("manage-users", { body: { action: "delete", id: p.id } });
    if (error || data?.error) { flash("Could not delete: " + (data?.error ?? error?.message ?? "unknown")); return; }
    setPeople((ps) => ps.filter((x) => x.id !== p.id)); setPersonId(null);
  };

  /* ---------------- pages ---------------- */
  /** A page with no list keeps the earlier (level) rules. */
  const deptOpens = (page: PageKey, k: string | null) => {
    const list = pageMap.depts[page];
    if (!list) return null;
    return list.includes(EVERYONE) || (!!k && list.includes(k));
  };
  const setDeptPage = async (page: PageKey, k: string, on: boolean) => {
    const cur = pageMap.depts[page] ?? depts.map((d) => d.dept_key);
    const base = cur.includes(EVERYONE) ? depts.map((d) => d.dept_key) : cur;
    const next = on ? [...new Set([...base, k])] : base.filter((x) => x !== k);
    const prev = pageMap;
    setPageMap((m) => ({ ...m, depts: { ...m.depts, [page]: next } }));
    const e = await savePageDepartments({ [page]: { depts: next, users: pageMap.users[page] ?? [] } });
    if (e) { setPageMap(prev); flash(e); }
  };
  const setUserPage = async (page: PageKey, uid: string, on: boolean) => {
    const cur = pageMap.users[page] ?? [];
    const next = on ? [...new Set([...cur, uid])] : cur.filter((x) => x !== uid);
    const deptsNow = pageMap.depts[page] ?? depts.map((d) => d.dept_key);
    const prev = pageMap;
    setPageMap((m) => ({ depts: { ...m.depts, [page]: deptsNow }, users: { ...m.users, [page]: next } }));
    const e = await savePageDepartments({ [page]: { depts: deptsNow, users: next } });
    if (e) { setPageMap(prev); flash(e); }
  };

  const deptRow = dept && dept !== NONE ? depts.find((d) => d.dept_key === dept) ?? null : null;
  const inDept = (k: string) => people.filter((p) => (k === NONE ? !p.department || !meta.has(p.department) : p.department === k)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const members = dept ? inDept(dept) : [];
  const person = personId ? people.find((p) => p.id === personId) ?? null : null;
  const noDept = people.filter((p) => !p.department || !meta.has(p.department)).length;
  const step = person ? 3 : dept ? 2 : 1;
  const levelOf = (p: Person) => levels.find((l) => l.key === (p.security_level ?? p.role));
  const pick = (k: string | null, pid: string | null = null) => { setDept(k); setPersonId(pid); };
  // the chart always fits its box (shrinks, never scrolls sideways)
  const mapRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const box = mapRef.current; if (!box) return;
    const fit = () => {
      const oc = box.querySelector<HTMLElement>(".oc"); if (!oc) return;
      oc.style.transform = "none";
      const w = oc.scrollWidth, avail = box.clientWidth - 32;
      const k = w > avail ? Math.max(0.35, avail / w) : 1;
      oc.style.transform = k < 1 ? `scale(${k})` : "none";
      oc.style.marginBottom = k < 1 ? `${-(1 - k) * oc.scrollHeight}px` : "0";
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(box);
    const mo = new MutationObserver(() => requestAnimationFrame(fit)); mo.observe(box, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [loading]);

  if (loading) return <div className="os-loading"><span /><span /><span /></div>;
  const stepCard = (n: number, t: string, s: string) => (
    <div className={`os-step ${step > n ? "is-done" : ""} ${step === n ? "is-on" : ""}`}>
      <i>{step > n ? <Ico d={I.check} s={13} /> : n}</i><span><b>{t}</b><small>{s}</small></span>
    </div>
  );
  return (
    <div className="os">
      {err && <p className="os-err">{err}</p>}
      <div className="os-track">
        {/* ---------- 1 · departments ---------- */}
        <div className="os-col is-1">
          {stepCard(1, "Departments", "Make your own")}
          <section className="os-panel is-fixed">
            <header className="os-ph">
              {onBack && <button type="button" className="os-back" onClick={onBack} aria-label="Back to Settings"><Ico d="M15 18l-6-6 6-6" s={16} /></button>}
              <div><b>Departments</b><small>{depts.length} · any name you like</small></div>
              {corner}
            </header>
            <div className="os-list is-scroll">
              {depts.length === 0 && <p className="os-empty">No departments yet. Start with the first one — e.g. Sales, Operations, Finance.</p>}
              {depts.map((d, i) => {
                const n = people.filter((p) => p.department === d.dept_key).length;
                return (
                  <button key={d.id} type="button" className={`os-item ${dept === d.dept_key ? "is-on" : ""}`} style={{ ["--c" as string]: deptColor(d.dept_key), ["--i" as string]: i }}
                    onClick={() => pick(d.dept_key)}>
                    <span className="os-dot" /><span className="os-item-t"><b>{deptName(d.dept_key)}</b><small>{n} {n === 1 ? "person" : "people"}</small></span><Ico d={I.chev} s={15} />
                  </button>
                );
              })}
              {noDept > 0 && (
                <button type="button" className={`os-item is-none ${dept === NONE ? "is-on" : ""}`} style={{ ["--c" as string]: "#9aa7a0" }} onClick={() => pick(NONE)}>
                  <span className="os-dot" /><span className="os-item-t"><b>No department</b><small>{noDept} {noDept === 1 ? "person" : "people"}</small></span><Ico d={I.chev} s={15} />
                </button>
              )}
            </div>
            {canManage && <NewLine placeholder="New department, e.g. Sales" button="Add" onAdd={createDept} />}
          </section>
        </div>

        {/* ---------- 2 · people in the department ---------- */}
        <div className="os-col is-2">
          {stepCard(2, "People", "Who's in each one")}
          {dept ? (
            <section className="os-panel is-fixed" key={`d-${dept}`} style={{ ["--c" as string]: deptColor(deptRow?.dept_key ?? null) }}>
              <header className="os-ph is-dept">
                <span className="os-ph-ico"><Ico d={I.people} /></span>
                {deptRow && canManage ? (
                  <input className="os-title-in" key={deptRow.name ?? ""} defaultValue={deptName(deptRow.dept_key)} aria-label="Department name"
                    onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== deptName(deptRow.dept_key)) void renameDept(deptRow, v); else e.target.value = deptName(deptRow.dept_key); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                ) : <div><b>{deptName(deptRow?.dept_key ?? null)}</b></div>}
                <button type="button" className="os-x" onClick={() => pick(null)} aria-label="Close"><Ico d={I.x} s={15} /></button>
              </header>

              <div className="os-sub"><b>People</b><span>{members.length}</span></div>
              <div className="os-list is-scroll">
                {members.length === 0 && <p className="os-empty">Nobody here yet.</p>}
                {members.map((p, i) => (
                  <button key={p.id} type="button" className={`os-item is-person ${personId === p.id ? "is-on" : ""}`} style={{ ["--i" as string]: i }} onClick={() => setPersonId(p.id)}>
                    <span className="os-av" style={{ background: deptColor(p.department) }}>{initials(p)}</span>
                    <span className="os-item-t"><b>{nameOf(p)}</b><small>{levelOf(p)?.name ?? "No level yet"}</small></span>
                    <Ico d={I.chev} s={15} />
                  </button>
                ))}
              </div>
              <div className="os-foot">
                {canManage && (
                  <div className="os-addrow">
                    <button type="button" className="os-add" onClick={() => setShowNew(true)}><i><Ico d={I.plus} s={14} /></i>New person</button>
                    {dept !== NONE && (
                      <div className="os-add is-move">
                        <i><Ico d={I.move} s={14} /></i>
                        <Select size="sm" value="" placeholder="Move in" searchable aria-label="Move someone into this department"
                          options={people.filter((p) => p.department !== dept).map((p) => ({ value: p.id, label: nameOf(p), hint: p.department && meta.has(p.department) ? deptName(p.department) : "No department" }))}
                          onChange={(v) => { const p = people.find((x) => x.id === v); if (p) { moveTo(p, dept); setPersonId(v); } }} />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {deptRow && (
                <div className="os-card">
                  <div className="os-card-h"><b>Pages it opens</b><small>Everyone in {deptName(deptRow.dept_key)}</small></div>
                  <div className="os-chips">
                    {OPENABLE.map((pg) => {
                      const on = deptOpens(pg.key, deptRow.dept_key) !== false;
                      return (
                        <button key={pg.key} type="button" className={`os-chip ${on ? "is-on" : ""}`} disabled={!canManage} aria-pressed={on}
                          title={pg.hint} onClick={() => void setDeptPage(pg.key, deptRow.dept_key, !on)}>
                          <i>{on ? <Ico d={I.check} s={11} /> : <Ico d={I.plus} s={11} />}</i>{pg.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="os-card-h is-2"><b>Its levels</b><small>Made for you</small></div>
                  <div className="os-lvpair">
                    {(() => { const p = pairOf(deptRow.dept_key, deptName(deptRow.dept_key)); return [p.member, p.manager].map((l, i) => (
                      <span key={i} className={i ? "is-mgr" : ""}><Ico d={i ? I.crown : I.user} s={13} />{l?.name ?? (i ? managerName(deptName(deptRow.dept_key)) : deptName(deptRow.dept_key))}</span>
                    )); })()}
                  </div>
                </div>
              )}
              {deptRow && canManage && <button type="button" className="os-danger" onClick={() => void deleteDept(deptRow)}><Ico d={I.trash} s={14} />Remove department</button>}
            </section>
          ) : (
            <section className="os-panel is-ghost"><span className="os-ghost-ico"><Ico d={I.people} s={22} /></span><b>Pick a department</b><small>to see and add its people</small></section>
          )}
        </div>

        {/* ---------- 3 · the person ---------- */}
        <div className="os-col is-3">
          {stepCard(3, "Security", "What each person can do")}
          {person ? (
            <section className="os-panel" key={`p-${person.id}`}>
              <header className="os-ph is-person">
                <span className="os-av is-big" style={{ background: deptColor(person.department) }}>{initials(person)}</span>
                <div><b>{nameOf(person)}</b><small>{person.email ?? ""}</small></div>
                <button type="button" className="os-x" onClick={() => setPersonId(null)} aria-label="Close"><Ico d={I.x} s={15} /></button>
              </header>

              <div className="os-card">
                <div className="os-card-h"><b>About them</b></div>
                <div className="os-fields">
                  <Field label="First name" value={person.first_name ?? ""} disabled={!canManage} onSave={(v) => void savePerson(person.id, { first_name: v || null })} />
                  <Field label="Last name" value={person.last_name ?? ""} disabled={!canManage} onSave={(v) => void savePerson(person.id, { last_name: v || null })} />
                  <Field label="Yearly wage" value={person.salary == null ? "" : String(person.salary)} suffix="€" num disabled={!canManage}
                    onSave={(v) => void savePerson(person.id, { salary: v === "" ? null : Number(v.replace(",", ".")) || 0 })} />
                  <Field label="Phone" value={person.phone ?? ""} disabled={!canManage} onSave={(v) => void savePerson(person.id, { phone: v || null })} />
                  <Field label="Bank account (IBAN) they're paid to" wide value={person.bank_iban ?? ""} placeholder="ES00 0000 0000 0000 0000 0000" disabled={!canManage}
                    onSave={(v) => void savePerson(person.id, { bank_iban: v.replace(/\s+/g, " ").trim().toUpperCase() || null })} />
                </div>
              </div>

              <div className="os-card">
                <div className="os-card-h"><b>Security level</b><small>What they can do</small></div>
                <LevelCards levels={shownLevels} mine={person.department ? [deptLevels.get(person.department)?.member, deptLevels.get(person.department)?.manager] : []}
                  value={person.security_level ?? person.role} disabled={!canManage} onPick={(k) => void setLevel(person, k)} />
              </div>

              <div className="os-card">
                <div className="os-card-h"><b>Place in the team</b></div>
                <div className="os-fields">
                  <label><span>Department</span>
                    <Select size="sm" value={person.department && meta.has(person.department) ? person.department : ""} disabled={!canManage} aria-label="Department"
                      options={[{ value: "", label: "No department" }, ...depts.map((d) => ({ value: d.dept_key, label: deptName(d.dept_key) }))]}
                      onChange={(v) => { moveTo(person, v || null); setDept(v || NONE); }} />
                  </label>
                  <label><span>Reports to</span>
                    <Select size="sm" value={person.manager_id ?? ""} disabled={!canManage} searchable aria-label="Manager"
                      options={[{ value: "", label: "Nobody" }, ...people.filter((p) => p.id !== person.id).map((p) => ({ value: p.id, label: nameOf(p), hint: p.department ? deptName(p.department) : undefined }))]}
                      onChange={(v) => void savePerson(person.id, { manager_id: v || null })} />
                  </label>
                </div>
              </div>

              <div className="os-card">
                <div className="os-card-h"><b>Pages</b><small>Their department's, plus any just for them</small></div>
                <div className="os-chips">
                  {OPENABLE.map((pg) => {
                    const viaDept = deptOpens(pg.key, person.department);
                    const byName = !!pageMap.users[pg.key]?.includes(person.id);
                    const locked = viaDept !== false;
                    const on = locked || byName;
                    return (
                      <button key={pg.key} type="button" className={`os-chip ${on ? "is-on" : ""} ${locked ? "is-locked" : ""} ${byName && !locked ? "is-own" : ""}`}
                        disabled={!canManage || locked} aria-pressed={on}
                        title={locked ? (viaDept === null ? "Open by their security level" : `Open through ${deptName(person.department)}`) : byName ? "Opened just for them — click to close" : "Open it just for them"}
                        onClick={() => void setUserPage(pg.key, person.id, !byName)}>
                        <i>{on ? <Ico d={I.check} s={11} /> : <Ico d={I.plus} s={11} />}</i>{pg.label}
                        {locked ? <em>{viaDept === null ? "level" : "dept"}</em> : byName ? <em>just them</em> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
              {canManage && <button type="button" className="os-danger" onClick={() => void removePerson(person)}><Ico d={I.trash} s={14} />Delete account</button>}
            </section>
          ) : (
            <section className="os-panel is-ghost"><span className="os-ghost-ico"><Ico d={I.shield} s={22} /></span><b>Pick a person</b><small>to set their details, security level and pages</small></section>
          )}
        </div>

        {/* ---------- the chart ---------- */}
        <div className="os-col is-map">
          <div className="os-step is-map"><i><Ico d={I.tree} s={14} /></i><span><b>{dept && dept !== NONE ? deptName(dept) : "Your company"}</b><small>{dept && dept !== NONE ? "Who reports to whom" : "Departments and their people"}</small></span>
            {dept && <button type="button" onClick={() => pick(null)}>Whole company</button>}
          </div>
          <section className="os-map" ref={mapRef}>
            {dept && dept !== NONE
              ? <DeptChart people={inDept(dept)} all={people} color={deptColor(dept)} name={deptName(dept)} levelName={(p) => levelOf(p)?.name ?? ""} sel={personId} onPick={(id) => setPersonId(id)} />
              : <CompanyChart depts={depts} people={people} deptName={deptName} deptColor={deptColor} sel={dept} onPick={(k) => pick(k)} onPerson={(p) => pick(p.department && meta.has(p.department) ? p.department : NONE, p.id)} />}
          </section>
        </div>
      </div>

      {showNew && (
        <NewUserModal
          allowedLevels={shownLevels.map((l) => l.key)}
          onCreate={async (payload: NewUserPayload) => {
            const { data, error } = await supabase.functions.invoke("manage-users", { body: { action: "create", user: payload } });
            if (error) {
              let detail = error.message ?? "Could not create the person.";
              try { const ctx = (error as any).context; if (ctx && typeof ctx.json === "function") { const b = await ctx.json(); if (b?.error) detail = b.error; } } catch { /* ignore */ }
              return detail;
            }
            if (data?.error) return data.error as string;
            // put them in the open department, on its level
            if (dept && dept !== NONE) {
              const { data: row } = await supabase.from("profiles").select("id").eq("email", payload.email).maybeSingle();
              const id = (row as any)?.id ?? data?.user?.id ?? data?.id;
              const lv = pairOf(dept, deptName(dept)).member;
              if (id) await supabase.from("profiles").update({ department: dept, ...(lv ? { security_level: lv.key, role: lv.base } : {}) }).eq("id", id);
            }
            await load();
            return null;
          }}
          onClose={() => setShowNew(false)}
        />
      )}
    </div>
  );
}

/* ---------------- the light chart (left to right) ---------------- */
function CompanyChart({ depts, people, deptName, deptColor, sel, onPick }: {
  depts: DeptRow[]; people: Person[]; deptName: (k: string | null) => string; deptColor: (k: string | null) => string;
  sel: string | null; onPick: (k: string) => void; onPerson?: (p: Person) => void;
}) {
  return (
    <div className="oc">
      <div className="ht-node">
        <div className="oc-root"><span className="oc-co"><Ico d={I.crown} s={14} /></span><span className="oc-root-t"><b>Company</b><small>{people.length} people</small></span></div>
        {depts.length > 0 && (
          <ul className="ht-kids">
            {depts.map((d, i) => {
              const n = people.filter((p) => p.department === d.dept_key).length;
              return (
                <li key={d.id} style={{ ["--c" as string]: deptColor(d.dept_key), ["--i" as string]: i }}>
                  <button type="button" className={`oc-dept ${sel === d.dept_key ? "is-on" : ""}`} onClick={() => onPick(d.dept_key)}>
                    <b>{deptName(d.dept_key)}</b><em>{n}</em>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {!depts.length && <p className="oc-empty">Your departments will show up here.</p>}
    </div>
  );
}

function DeptChart({ people, all, color, name, levelName, sel, onPick }: {
  people: Person[]; all: Person[]; color: string; name: string; levelName: (p: Person) => string; sel: string | null; onPick: (id: string) => void;
}) {
  const ids = new Set(people.map((p) => p.id));
  const kids = (id: string) => people.filter((p) => p.manager_id === id);
  const roots = people.filter((p) => !p.manager_id || !ids.has(p.manager_id));
  const above = (p: Person) => (p.manager_id && !ids.has(p.manager_id) ? all.find((x) => x.id === p.manager_id) : undefined);
  const Node = ({ p, d }: { p: Person; d: number }): ReactElement => {
    const ks = kids(p.id);
    return (
      <li style={{ ["--i" as string]: d }}>
        <div className="ht-node">
          <button type="button" className={`oc-card ${sel === p.id ? "is-on" : ""}`} onClick={() => onPick(p.id)}>
            <span className="oc-card-t"><b>{nameOf(p)}</b><small>{levelName(p)}{above(p) ? ` · reports to ${nameOf(above(p)!)}` : ""}</small></span>
          </button>
          {ks.length > 0 && <ul className="ht-kids">{ks.map((k) => <Node key={k.id} p={k} d={d + 1} />)}</ul>}
        </div>
      </li>
    );
  };
  return (
    <div className="oc is-dept" style={{ ["--c" as string]: color }}>
      <div className="ht-node">
        <div className="oc-root"><span className="oc-co"><Ico d={I.people} s={14} /></span><span className="oc-root-t"><b>{name}</b><small>{people.length} {people.length === 1 ? "person" : "people"}</small></span></div>
        {people.length > 0 && <ul className="ht-kids">{roots.map((p) => <Node key={p.id} p={p} d={0} />)}</ul>}
      </div>
      {!people.length && <p className="oc-empty">Nobody in {name} yet.</p>}
      {people.length > 1 && roots.length === people.length && <p className="oc-hint">Make someone “{name} manager” and the rest report to them.</p>}
    </div>
  );
}

/* ---------------- bits ---------------- */
/** The levels as cards: their department's two and Boss; the others behind a toggle that opens and closes. */
function LevelCards({ levels, mine, value, disabled, onPick }: { levels: SecurityLevel[]; mine: (SecurityLevel | undefined)[]; value: string | null; disabled: boolean; onPick: (k: string) => void }) {
  const [all, setAll] = useState(false);
  const own = mine.filter(Boolean) as SecurityLevel[];
  const top = [...own, ...levels.filter((l) => l.key === value && !own.some((o) => o.key === l.key)), ...levels.filter((l) => l.key === "boss" && l.key !== value)];
  const rest = levels.filter((l) => !top.some((t) => t.key === l.key));
  const card = (l: SecurityLevel) => (
    <button key={l.key} type="button" disabled={disabled} className={`os-level ${value === l.key ? "is-on" : ""}`} onClick={() => onPick(l.key)}>
      <i>{value === l.key ? <Ico d={I.check} s={12} /> : null}</i>
      <span><b>{l.name}</b><small>{l.key === "boss" ? "Leads the company — everything" : /manager/i.test(l.name) && own.some((o) => o.key === l.key) ? "Leads the department — everyone in it reports to them" : BASE_HINT[l.base] ?? ""}</small></span>
    </button>
  );
  return (
    <div className="os-levels">
      {top.map(card)}
      {all && rest.map(card)}
      {rest.length > 0 && <button type="button" className="os-more" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Other departments' levels (${rest.length})`}</button>}
    </div>
  );
}

function Field({ label, value, onSave, disabled, wide, num, suffix, placeholder }: {
  label: string; value: string; onSave: (v: string) => void; disabled?: boolean; wide?: boolean; num?: boolean; suffix?: string; placeholder?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className={wide ? "is-wide" : ""}><span>{label}</span>
      <span className="os-in">
        <input value={v} disabled={disabled} inputMode={num ? "decimal" : undefined} placeholder={placeholder}
          onChange={(e) => setV(num ? e.target.value.replace(/[^\d.,]/g, "") : e.target.value)}
          onBlur={() => { if (v.trim() !== value) onSave(v.trim()); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        {suffix && <i>{suffix}</i>}
      </span>
    </label>
  );
}

function NewLine({ placeholder, button, onAdd }: { placeholder: string; button: string; onAdd: (v: string) => Promise<string | null> }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { setBusy(true); const e = await onAdd(v); setBusy(false); if (e) setErr(e); else { setV(""); setErr(null); } };
  return (
    <div className="os-new">
      <div className="os-new-row">
        <input value={v} placeholder={placeholder} onChange={(e) => { setV(e.target.value); setErr(null); }} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
        <button type="button" className={`os-btn is-primary os-new-go ${v.trim() ? "is-shown" : ""}`} disabled={busy || !v.trim()} tabIndex={v.trim() ? 0 : -1}
          aria-hidden={!v.trim()} onClick={() => void go()}><Ico d={I.plus} s={14} />{button}</button>
      </div>
      {err && <small className="os-new-hint is-err">{err}</small>}
    </div>
  );
}
