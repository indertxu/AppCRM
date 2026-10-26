/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, useCallback } from "react";
import { PageLoader } from "../../framework/AppLayout";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import { recordChanges, loadHistoryUpTo, loadWeekNotes, loadChangeWeeks, reconstruct, todayISO, mondayOf, type HistoryEvent } from "./orgHistory";
import { LEVELS, type NewUserPayload } from "./NewUserModal";
import NewUserModal from "./NewUserModal";
import { DEFAULT_DEPARTMENTS, DEPT_COLORS, deptFromRow, departmentsChanged, newDeptKey, deptName, type Department } from "../../framework/pageAccess";
import "./Organization.css";

/** The departments a company starts with (it can rename, add and remove them here). */
export const DEPARTMENTS = DEFAULT_DEPARTMENTS;
/** The loaded departments by key: name, colour and mark (kept in step with `depts`). */
let META = new Map<string, Department>();
const deptOf = (k: string | null) => (k ? META.get(k) : undefined);
const deptLabel = (k: string | null) => deptOf(k)?.name ?? (k ? deptName(k) : "—");
const deptColor = (k: string | null) => deptOf(k)?.color ?? "#5a7d6d";
const metaOf = (rows: Dept[]) => rows.map((r, i) => deptFromRow(r, i));
const roleLabel = (id: string | null) => LEVELS.find((l) => l.id === id)?.label ?? id ?? "—";

interface Dept {
  id: string;
  dept_key: string;
  /** Name, colour, mark and order (61_custom_departments.sql). */
  name?: string | null;
  color?: string | null;
  icon?: string | null;
  sort?: number | null;
  parent_id: string | null;
  security_role: string | null;
  pos_x: number;
  pos_y: number;
  placed: boolean;
}
interface OrgUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  role: string | null;
  department: string | null;
  manager_id: string | null;
  org_x: number;
  org_y: number;
  org_placed: boolean;
  // employee fields
  phone: string | null;
  national_id: string | null;
  social_security: string | null;
  address: string | null;
  start_date: string | null;
  bank_iban: string | null;
  salary: number | null;
  // employment: false once laid off; hidden from the map/lists from their last day on
  active: boolean;
  deactivated_at: string | null;
  deactivation_reason: string | null;
}

const NODE_W = 180;
const DEPT_H = 80;
const USER_H = 58;
const cssv = (o: Record<string, string | number>) => o as React.CSSProperties;
/** A number that counts up to its value (and glides when it changes). */
function useCount(target: number, ms = 700) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const a = from.current, b = target;
    if (a === b) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { from.current = b; setV(b); return; }
    const t0 = performance.now(); let raf = 0;
    const step = (t: number) => { const k = Math.min(1, (t - t0) / ms); const x = a + (b - a) * (1 - Math.pow(1 - k, 3)); from.current = x; setV(x); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return Math.round(v);
}
function Count({ n }: { n: number }) { return <>{useCount(n)}</>; }
/** A soft curve from a leader's box to a member's box (bottom → top, or top → bottom when the member sits above). */
function curve(ax: number, ay: number, ah: number, bx: number, by: number, bh: number) {
  const down = by >= ay;
  const y1 = down ? ay + ah : ay, y2 = down ? by : by + bh;
  const my = (y1 + y2) / 2;
  return `M ${ax} ${y1} C ${ax} ${my}, ${bx} ${my}, ${bx} ${y2}`;
}

type Drag =
  | { kind: "dept" | "user"; id: string; dx: number; dy: number; startX: number; startY: number; moved: boolean; canMove: boolean }
  | null;

interface Props {
  canManage: boolean;
  canSeeSensitive?: boolean;
  backRef?: React.MutableRefObject<(() => boolean) | null>; // returns true if it handled an internal back
  toolbarRef?: React.MutableRefObject<HTMLDivElement | null>; // header slot for the time bar
}

export default function Organization({ canManage, canSeeSensitive = false, backRef, toolbarRef }: Props) {
  const [depts, setDepts] = useState<Dept[]>([]);
  /** Departments in their order, with the name / colour / mark lookups kept in step. */
  const setDeptRows = (rows: Dept[]) => {
    const meta = metaOf(rows);
    META = new Map(meta.map((m) => [m.key, m]));
    const order = new Map(meta.map((m) => [m.key, m.sort]));
    setDepts(rows.slice().sort((a, b) => (order.get(a.dept_key) ?? 0) - (order.get(b.dept_key) ?? 0) || deptLabel(a.dept_key).localeCompare(deptLabel(b.dept_key))));
    departmentsChanged(meta);
  };
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [companyTab, setCompanyTab] = useState<"depts" | "people">("depts");
  const [search, setSearch] = useState("");
  const [showAllPeople, setShowAllPeople] = useState(false);
  const [deptTab, setDeptTab] = useState<"settings" | "people">("people");

  // ---- Time travel ----
  const [viewDate, setViewDate] = useState<string>(todayISO()); // the date we're viewing
  const [changeWeeks, setChangeWeeks] = useState<string[]>([]);  // weeks (Mondays) with changes
  const [weekNotes, setWeekNotes] = useState<HistoryEvent[]>([]); // notes for the selected week
  const [pickerOpen, setPickerOpen] = useState(false);
  const [toolbarReady, setToolbarReady] = useState(false);
  useEffect(() => { if (toolbarRef?.current) setToolbarReady(true); }, [toolbarRef]);
  const [notesOpen, setNotesOpen] = useState(false);
  const isPast = viewDate < todayISO();
  const [overTrash, setOverTrash] = useState(false);

  // view: null = company (departments), or a dept_key = inside that department
  const [openDept, setOpenDept] = useState<string | null>(null);
  // selection inside a view
  const [selDeptId, setSelDeptId] = useState<string | null>(null);
  const [selUserId, setSelUserId] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  // Did the press start on empty canvas? Only then may the following click clear
  // the selection. (Pressing a card captures the pointer on the canvas, so its
  // click lands on the canvas too — which used to close the panel it had just opened.)
  const downOnEmpty = useRef(false);
  const weekBtnRef = useRef<HTMLButtonElement>(null);
  const trashRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag>(null);
  const [, force] = useState(0);

  // pan + zoom of the canvas world
  const [viewX, setViewX] = useState(0);
  const [viewY, setViewY] = useState(0);
  const [zoom, setZoom] = useState(1);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);

  // ---- Load ----
  const load = useCallback(async () => {
    setLoading(true);
    const { data: existing, error: deptErr } = await supabase.from("org_departments").select("*");
    let deptRows = (existing ?? []) as Dept[];
    // A brand-new company starts with the usual departments; after that they're the company's own
    // (a department removed here stays removed).
    if (!deptErr && !deptRows.length) {
      const seed = DEFAULT_DEPARTMENTS.map((d, i) => ({ dept_key: d.key, name: d.label, color: d.color, sort: i }));
      let ins = await supabase.from("org_departments").insert(seed);
      if (ins.error) ins = await supabase.from("org_departments").insert(seed.map((d) => ({ dept_key: d.dept_key })));
      const { data: refetched } = await supabase.from("org_departments").select("*");
      deptRows = (refetched ?? []) as Dept[];
    }
    setDeptRows(deptRows);

    const COLS = "id, first_name, last_name, email, role, department, manager_id, org_x, org_y, org_placed, phone, national_id, social_security, address, start_date, bank_iban, salary";
    let { data: profs, error: profErr } = await supabase.from("profiles").select(`${COLS}, active, deactivated_at, deactivation_reason`);
    if (profErr) ({ data: profs } = await supabase.from("profiles").select(COLS)); // employment columns not created yet
    setUsers(((profs ?? []) as any[]).map((p) => ({
      id: p.id,
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      role: p.role, department: p.department, manager_id: p.manager_id,
      org_x: p.org_x ?? 0, org_y: p.org_y ?? 0, org_placed: !!p.org_placed,
      phone: p.phone, national_id: p.national_id, social_security: p.social_security, address: p.address,
      start_date: p.start_date, bank_iban: p.bank_iban, salary: p.salary,
      active: p.active !== false, deactivated_at: p.deactivated_at ?? null, deactivation_reason: p.deactivation_reason ?? null,
    })));
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Expose an "internal back" to the parent's big arrow: if we're inside a
  // department or have a panel open, close that first and report handled.
  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => {
      if (selUserId) { setSelUserId(null); return true; }
      if (selDeptId) { setSelDeptId(null); return true; }
      if (openDept) { setOpenDept(null); return true; }
      return false;
    };
    return () => { if (backRef) backRef.current = null; };
  }, [backRef, selUserId, selDeptId, openDept]);

  // ---- Persistence (also records history at the effective date being viewed) ----
  // Turn raw field values into readable text for the change notes.
  const resolveNote = (field: string, value: any): string => {
    if (value === null || value === "" || value === undefined) {
      if (field === "placed") return "removed";
      return "cleared";
    }
    switch (field) {
      case "department": return deptLabel(String(value));
      case "manager_id": { const m = users.find((u) => u.id === value); return m ? nameOf(m) : "someone"; }
      case "parent_id": { const d = depts.find((x) => x.id === value); return d ? deptLabel(d.dept_key) : "another department"; }
      case "role":
      case "security_role": return roleLabel(String(value));
      case "salary": return `€${Number(value).toLocaleString("es-ES")}`;
      case "placed": return value ? "added" : "removed";
      case "active": return value ? "back at work" : "laid off";
      default: return String(value);
    }
  };
  const saveDept = async (id: string, patch: Partial<Dept>) => {
    const row = depts.find((d) => d.id === id);
    if (isPast) {
      // Past edit: only record history at the viewed date. Do NOT touch the live row.
      await recordChanges("dept", id, patch as any, viewDate, deptLabel(row?.dept_key ?? null), resolveNote);
      setPastOverlay((o) => o ? { ...o, depts: { ...o.depts, [id]: { ...(o.depts[id] ?? {}), ...patch } } } : o);
      refreshChangeWeeks();
      return;
    }
    // Present edit: update the live row + record history at today.
    const looks = "name" in patch || "color" in patch || "sort" in patch;
    const prevName = deptLabel(row?.dept_key ?? null);
    if (looks) setDeptRows(depts.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    else setDepts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    const { error } = await supabase.from("org_departments").update(patch).eq("id", id);
    if (error) {
      console.error("[org] saveDept failed:", error.message, patch);
      if (looks && row) setDeptRows(depts.map((d) => (d.id === id ? row : d)));
      setSaveError(/name|color|sort|schema cache/i.test(error.message) && looks
        ? "Run 61_custom_departments.sql in Supabase to name and colour departments." : `Could not save: ${error.message}`);
      window.setTimeout(() => setSaveError(null), 6000);
      return;
    }
    if ("name" in patch) { await recordChanges("dept", id, { name: patch.name } as any, todayISO(), prevName, resolveNote); refreshChangeWeeks(); return; }
    if (looks) return;
    await recordChanges("dept", id, patch as any, todayISO(), deptLabel(row?.dept_key ?? null), resolveNote);
    refreshChangeWeeks();
  };
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Add a department: its key comes from the name and never changes (renaming keeps every link). */
  const createDept = async (name: string): Promise<string | null> => {
    const clean = name.trim();
    if (!clean) return "Give the department a name.";
    if (depts.some((d) => deptLabel(d.dept_key).toLowerCase() === clean.toLowerCase())) return "There is already a department with that name.";
    const key = newDeptKey(clean, depts.map((d) => d.dept_key));
    const used = new Set(depts.map((d) => deptColor(d.dept_key)));
    const color = DEPT_COLORS.find((c) => !used.has(c)) ?? DEPT_COLORS[depts.length % DEPT_COLORS.length];
    const sort = Math.max(-1, ...metaOf(depts).map((m) => m.sort)) + 1;
    const { data, error } = await supabase.from("org_departments").insert({ dept_key: key, name: clean, color, sort }).select("*").single();
    if (error) return /name|color|sort|schema cache/i.test(error.message) ? "Run 61_custom_departments.sql in Supabase first, then try again." : error.message;
    setDeptRows([...depts, data as Dept]);
    return null;
  };
  /** Remove a department: its people are left without one, the departments it led go to the top level. */
  const deleteDept = async (d: Dept): Promise<string | null> => {
    const members = users.filter((u) => u.department === d.dept_key);
    if (members.length) {
      const { error } = await supabase.from("profiles").update({ department: null }).eq("department", d.dept_key);
      if (error) return `Could not move its people out: ${error.message}`;
      for (const u of members) await recordChanges("user", u.id, { department: null } as any, todayISO(), nameOf(u), resolveNote).catch(() => {});
    }
    const kids = depts.filter((x) => x.parent_id === d.id);
    if (kids.length) await supabase.from("org_departments").update({ parent_id: null }).in("id", kids.map((k) => k.id));
    const { data, error } = await supabase.from("org_departments").delete().eq("id", d.id).select("id");
    if (error || !(data ?? []).length) return error ? error.message : "You don't have permission to remove departments.";
    setUsers((us) => us.map((u) => (u.department === d.dept_key ? { ...u, department: null } : u)));
    setDeptRows(depts.filter((x) => x.id !== d.id).map((x) => (x.parent_id === d.id ? { ...x, parent_id: null } : x)));
    if (openDept === d.dept_key) setOpenDept(null);
    setSelDeptId(null);
    refreshChangeWeeks();
    return null;
  };

  const saveUser = async (id: string, patch: Partial<OrgUser>) => {
    const row = users.find((u) => u.id === id);
    if (isPast) {
      await recordChanges("user", id, patch as any, viewDate, row ? nameOf(row) : "User", resolveNote);
      setPastOverlay((o) => o ? { ...o, users: { ...o.users, [id]: { ...(o.users[id] ?? {}), ...patch } } } : o);
      refreshChangeWeeks();
      return;
    }
    // Keep what it was, so a rejected write can be put back rather than left
    // looking saved until the page is reloaded.
    const before = row ? Object.fromEntries(
      Object.keys(patch).map((k) => [k, (row as any)[k]]),
    ) as Partial<OrgUser> : null;

    setUsers((us) => us.map((u) => (u.id === id ? { ...u, ...patch } : u)));
    const { error } = await supabase.from("profiles").update(patch).eq("id", id);
    if (error) {
      console.error("[org] saveUser failed:", error.message, patch);
      if (before) setUsers((us) => us.map((u) => (u.id === id ? { ...u, ...before } : u)));
      setSaveError(error.message.includes("profiles_role_check")
        ? "That security role is not one the system accepts yet."
        : `Could not save: ${error.message}`);
      window.setTimeout(() => setSaveError(null), 5000);
      return;
    }
    await recordChanges("user", id, patch as any, todayISO(), row ? nameOf(row) : "User", resolveNote);
    refreshChangeWeeks();
  };
  const deleteUser = async (id: string, name: string) => {
    if (!confirm(`Delete ${name} permanently? This removes their account and cannot be undone.`)) return;
    const { data, error } = await supabase.functions.invoke("manage-users", { body: { action: "delete", id } });
    if (error || data?.error) { alert("Could not delete: " + (data?.error ?? error?.message ?? "unknown")); return; }
    setSelUserId(null);
    setUsers((us) => us.filter((u) => u.id !== id));
  };

  // ---- History loading ----
  const shiftWeek = (delta: number) => {
    const d = new Date(viewDate + "T00:00:00");
    d.setDate(d.getDate() + delta * 7);
    const iso = d.toISOString().slice(0, 10);
    // don't go past the current week
    setViewDate(iso > todayISO() ? todayISO() : iso);
  };
  const refreshChangeWeeks = async () => { setChangeWeeks(await loadChangeWeeks().catch(() => [])); };

  // ---- Employment: lay off / reactivate ----
  /** Lays someone off as of `lastDay`: blocks sign-in, moves their direct reports to their
      own manager, records it in the history (so past weeks still show them), and hides them
      from the map, people lists and every picker in the app. Returns an error message or null. */
  const layOff = async (id: string, lastDay: string, reason: string): Promise<string | null> => {
    const row = users.find((u) => u.id === id);
    if (!row) return "Employee not found.";
    const { error } = await supabase.rpc("set_employee_active", { p_user: id, p_active: false, p_date: lastDay, p_reason: reason || null });
    if (error) return /set_employee_active|does not exist|schema cache/i.test(error.message)
      ? "Run empower_employee_active.sql in Supabase first, then try again." : error.message;
    const newManager = row.manager_id ?? null;
    const reports = users.filter((u) => u.manager_id === id && u.active);
    for (const r of reports) {
      await supabase.from("profiles").update({ manager_id: newManager }).eq("id", r.id);
      await recordChanges("user", r.id, { manager_id: newManager }, lastDay, nameOf(r), resolveNote);
    }
    await recordChanges("user", id, { active: false }, lastDay, nameOf(row), resolveNote);
    setUsers((us) => us.map((u) =>
      u.id === id ? { ...u, active: false, deactivated_at: lastDay, deactivation_reason: reason || null }
      : reports.some((r) => r.id === u.id) ? { ...u, manager_id: newManager } : u));
    refreshChangeWeeks();
    return null;
  };
  const reactivate = async (id: string): Promise<string | null> => {
    const row = users.find((u) => u.id === id);
    if (!row) return "Employee not found.";
    const { error } = await supabase.rpc("set_employee_active", { p_user: id, p_active: true, p_date: todayISO(), p_reason: null });
    if (error) return error.message;
    await recordChanges("user", id, { active: true }, todayISO(), nameOf(row), resolveNote);
    setUsers((us) => us.map((u) => (u.id === id ? { ...u, active: true, deactivated_at: null, deactivation_reason: null } : u)));
    refreshChangeWeeks();
    return null;
  };
  useEffect(() => { refreshChangeWeeks(); }, []);
  // load the notes for the week of the currently viewed date
  useEffect(() => {
    loadWeekNotes(mondayOf(viewDate)).then(setWeekNotes).catch(() => setWeekNotes([]));
  }, [viewDate]);

  // When viewing a past date, overlay the reconstructed values onto the live rows.
  const [pastOverlay, setPastOverlay] = useState<{ users: Record<string, any>; depts: Record<string, any> } | null>(null);
  useEffect(() => {
    if (!isPast) { setPastOverlay(null); return; }
    let active = true;
    loadHistoryUpTo(viewDate).then((events) => {
      if (active) setPastOverlay(reconstruct(events));
    }).catch(() => setPastOverlay(null));
    return () => { active = false; };
  }, [viewDate, isPast]);

  const nameOf = (u: OrgUser) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "—";
  const initials = (u: OrgUser) =>
    ((u.first_name?.[0] ?? u.email?.[0] ?? "?") + (u.last_name?.[0] ?? "")).toUpperCase();
  const effectiveRole = (u: OrgUser) => {
    if (u.role) return u.role;
    const d = viewDepts.find((x) => x.dept_key === u.department);
    return d?.security_role ?? null;
  };
  const countIn = (deptKey: string) => viewUsers.filter((u) => u.department === deptKey).length;

  // ---- Canvas coords ----
  // screen → world coordinates (undo pan + zoom)
  const toCanvas = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - viewX) / zoom, y: (clientY - r.top - viewY) / zoom };
  };

  // ---- Drag nodes ----
  const startDrag = (kind: "dept" | "user", id: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    downOnEmpty.current = false;
    const p = toCanvas(e.clientX, e.clientY);
    let nx = 0, ny = 0;
    if (kind === "dept") { const d = depts.find((x) => x.id === id)!; nx = d.pos_x; ny = d.pos_y; }
    else { const u = users.find((x) => x.id === id)!; nx = u.org_x; ny = u.org_y; }
    // canManage gates *moving*; a short click still selects/opens even for viewers.
    drag.current = { kind, id, dx: p.x - nx, dy: p.y - ny, startX: e.clientX, startY: e.clientY, moved: false, canMove: canManage };
    canvasRef.current?.setPointerCapture(e.pointerId);
    force((n) => n + 1);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.canMove) return; // viewers can't drag; pointer-up will just select
    if (Math.abs(e.clientX - d.startX) > 4 || Math.abs(e.clientY - d.startY) > 4) d.moved = true;
    const tz = trashRef.current?.getBoundingClientRect();
    setOverTrash(!!tz && e.clientX >= tz.left && e.clientX <= tz.right && e.clientY >= tz.top && e.clientY <= tz.bottom);
    const p = toCanvas(e.clientX, e.clientY);
    const x = Math.round(Math.max(0, p.x - d.dx));
    const y = Math.round(Math.max(0, p.y - d.dy));
    // Position is always live (never time-traveled), so update the real rows.
    if (d.kind === "dept") setDepts((ds) => ds.map((dd) => (dd.id === d.id ? { ...dd, pos_x: x, pos_y: y } : dd)));
    else setUsers((us) => us.map((u) => (u.id === d.id ? { ...u, org_x: x, org_y: y } : u)));
  };
  const onPointerUp = async () => {
    const d = drag.current;
    drag.current = null;
    const wasTrash = overTrash;
    setOverTrash(false);
    if (!d) return;

    // Short click (no real movement) → select / enter, don't treat as a move.
    if (!d.moved) {
      if (d.kind === "dept") { setOpenDept(depts.find((x) => x.id === d.id)?.dept_key ?? null); setSelDeptId(null); setSelUserId(null); }
      else { setSelUserId(d.id); setSelDeptId(null); }
      return;
    }

    if (wasTrash) {
      if (d.kind === "dept") { await saveDept(d.id, { placed: false, parent_id: null }); if (selDeptId === d.id) setSelDeptId(null); }
      else { await saveUser(d.id, { org_placed: false, manager_id: null }); if (selUserId === d.id) setSelUserId(null); }
      return;
    }
    if (d.kind === "dept") {
      const node = depts.find((x) => x.id === d.id);
      if (node) {
        // position always persists live (no history); relationship respects time
        await savePosition("dept", node.id, { pos_x: node.pos_x, pos_y: node.pos_y });
        const over = placedDepts.find((o) => o.id !== node.id && hitDept(node.pos_x, node.pos_y, o));
        if (over && over.id !== node.parent_id) await saveDept(node.id, { parent_id: over.id });
      }
    } else {
      const node = users.find((x) => x.id === d.id);
      if (node) {
        await savePosition("user", node.id, { org_x: node.org_x, org_y: node.org_y });
        const overUser = deptUsers.find((o) => o.id !== node.id && hitUser(node.org_x, node.org_y, o));
        if (overUser) await saveUser(node.id, { manager_id: overUser.id });
      }
    }
  };
  // Persist only canvas position — always to the live row, never history.
  const savePosition = async (kind: "dept" | "user", id: string, pos: Record<string, number>) => {
    if (kind === "dept") {
      setDepts((ds) => ds.map((d) => (d.id === id ? { ...d, ...pos } : d)));
      await supabase.from("org_departments").update(pos).eq("id", id);
    } else {
      setUsers((us) => us.map((u) => (u.id === id ? { ...u, ...pos } : u)));
      await supabase.from("profiles").update(pos).eq("id", id);
    }
  };
  const hitDept = (px: number, py: number, o: Dept) =>
    px + NODE_W / 2 > o.pos_x && px + NODE_W / 2 < o.pos_x + NODE_W && py + 20 > o.pos_y && py + 20 < o.pos_y + DEPT_H;
  const hitUser = (px: number, py: number, o: OrgUser) =>
    px + NODE_W / 2 > o.org_x && px + NODE_W / 2 < o.org_x + NODE_W && py + 20 > o.org_y && py + 20 < o.org_y + USER_H;

  // ---- Pan (drag background) ----
  const startPan = (e: React.PointerEvent) => {
    downOnEmpty.current = !(e.target as HTMLElement).closest(".org-node");
    // Pan when pressing empty space — not when pressing a node (which starts a drag).
    if ((e.target as HTMLElement).closest(".org-node")) return;
    pan.current = { sx: e.clientX, sy: e.clientY, vx: viewX, vy: viewY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const movePan = (e: React.PointerEvent) => {
    onPointerMove(e); // keep node dragging working
    if (!pan.current) return;
    setViewX(pan.current.vx + (e.clientX - pan.current.sx));
    setViewY(pan.current.vy + (e.clientY - pan.current.sy));
  };
  const endPan = (e: React.PointerEvent) => {
    onPointerUp();
    pan.current = null;
  };
  // ---- Zoom (Ctrl + wheel) ----
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // only zoom with Ctrl/Cmd held
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setZoom((z) => {
        const nz = Math.min(2, Math.max(0.4, z * (e.deltaY < 0 ? 1.1 : 0.9)));
        // keep the point under the cursor stable
        setViewX((vx) => mx - ((mx - vx) / z) * nz);
        setViewY((vy) => my - ((my - vy) / z) * nz);
        return nz;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom]);

  // ---- Drop from palette. Native listeners in capture phase so the drop fires
  // no matter which child element (svg, nodes, trash) is under the cursor. ----
  const onCanvasDropRef = useRef<(e: DragEvent) => void>(() => {});
  const onCanvasOverRef = useRef<(e: DragEvent) => void>(() => {});
  /** What's being dragged in from the side panel ("dept" / "user"), and the department it would land on. */
  const dragKind = useRef<"dept" | "user" | null>(null);
  const [dropDeptId, setDropDeptId] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const over = (e: DragEvent) => { e.preventDefault(); onCanvasOverRef.current(e); };
    const drop = (e: DragEvent) => { setDropDeptId(null); setDropping(false); onCanvasDropRef.current(e); };
    const leave = (e: DragEvent) => { if (!el.contains(e.relatedTarget as Node)) { setDropDeptId(null); setDropping(false); } };
    el.addEventListener("dragleave", leave);
    el.addEventListener("dragover", over);
    el.addEventListener("drop", drop);
    return () => { el.removeEventListener("dragover", over); el.removeEventListener("drop", drop); };
  }, []);

  const onCanvasDrop = async (e: DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer?.getData("text/plain");
    if (!raw) return;
    const [kind, id] = raw.split(":");
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = (e.clientX - rect.left - viewX) / zoom;
    const py = (e.clientY - rect.top - viewY) / zoom;
    const x = Math.round(Math.max(0, px - NODE_W / 2));
    const y = Math.round(Math.max(0, py - 24));
    if (kind === "dept" && !openDept) { await saveDept(id, { placed: true, pos_x: x, pos_y: y }); return; }
    if (kind === "user") {
      if (openDept) {
        await saveUser(id, { org_placed: true, org_x: x, org_y: y, department: openDept });
      } else {
        const target = placedDepts.find((o) =>
          px >= o.pos_x - 10 && px <= o.pos_x + NODE_W + 10 &&
          py >= o.pos_y - 10 && py <= o.pos_y + DEPT_H + 10
        );
        if (target) await saveUser(id, { department: target.dept_key });
        else alert("Drop the person on top of a department box to assign them.");
      }
    }
  };
  // keep the ref pointing at the latest closure (so it sees current openDept/placedDepts)
  onCanvasDropRef.current = onCanvasDrop as unknown as (e: DragEvent) => void;
  onCanvasOverRef.current = (e: DragEvent) => {
    if (!dropping) setDropping(true);
    if (openDept || dragKind.current !== "user") { if (dropDeptId) setDropDeptId(null); return; }
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = (e.clientX - rect.left - viewX) / zoom, py = (e.clientY - rect.top - viewY) / zoom;
    const t = placedDepts.find((o) => px >= o.pos_x - 10 && px <= o.pos_x + NODE_W + 10 && py >= o.pos_y - 10 && py <= o.pos_y + DEPT_H + 10);
    if ((t?.id ?? null) !== dropDeptId) setDropDeptId(t?.id ?? null);
  };

  // ---- Derived ----
  // When time-traveling, overlay reconstructed past values onto the rows.
  // The overlay carries past *content* (department, manager, role, salary…),
  // but NOT canvas position — position is a single live value, it doesn't time-travel.
  const viewDepts = pastOverlay
    ? depts.map((d) => { const o = { ...(pastOverlay.depts[d.id] ?? {}) }; delete o.pos_x; delete o.pos_y; return { ...d, ...o }; })
    : depts;
  const viewUsersAll = pastOverlay
    ? users.map((u) => { const o = { ...(pastOverlay.users[u.id] ?? {}) }; delete o.org_x; delete o.org_y; delete o.active; return { ...u, ...o }; })
    : users;
  /** Working here on the viewed date? Former employees still appear on weeks before their last day. */
  const workedOn = (u: OrgUser) => u.active || (!!u.deactivated_at && viewDate < u.deactivated_at);
  const viewUsers = viewUsersAll.filter(workedOn);
  const formerUsers = users.filter((u) => !u.active).sort((a, b) => (b.deactivated_at ?? "").localeCompare(a.deactivated_at ?? ""));

  const placedDepts = viewDepts.filter((d) => d.placed);
  const unassignedUsers = viewUsers.filter((u) => !u.department);
  const peopleFiltered = viewUsers.filter((u) => {
    if (!showAllPeople && u.department) return false; // only unassigned unless "show all"
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (nameOf(u).toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q));
  });
  const deptUsers = openDept ? viewUsers.filter((u) => u.department === openDept && u.org_placed) : [];

  const selDept = selDeptId ? viewDepts.find((d) => d.id === selDeptId) ?? null : null;
  const selUser = selUserId ? viewUsersAll.find((u) => u.id === selUserId) ?? null : null;

  // ---- Links: who leads whom, as soft curves in the leader's colour ----
  const links: { key: string; d: string; c: string }[] = [];
  if (!openDept) {
    placedDepts.forEach((d) => {
      const p = d.parent_id ? placedDepts.find((x) => x.id === d.parent_id) : null;
      if (p) links.push({ key: d.id, c: deptColor(p.dept_key), d: curve(p.pos_x + NODE_W / 2, p.pos_y, DEPT_H, d.pos_x + NODE_W / 2, d.pos_y, DEPT_H) });
    });
  } else {
    deptUsers.forEach((u) => {
      const m = u.manager_id ? deptUsers.find((x) => x.id === u.manager_id) : null;
      if (m) links.push({ key: u.id, c: deptColor(openDept), d: curve(m.org_x + NODE_W / 2, m.org_y, USER_H, u.org_x + NODE_W / 2, u.org_y, USER_H) });
    });
  }
  const membersOf = (key: string) => viewUsers.filter((u) => u.department === key);
  const reportsOf = (id: string) => viewUsers.filter((u) => u.manager_id === id).length;

  const openDeptRow = openDept ? depts.find((d) => d.dept_key === openDept) ?? null : null;
  const railWide = !!(selUser || (openDept && !selDept));
  const railColor = selUser ? deptColor(selUser.department) : openDept ? deptColor(openDept) : "#12b57f";

  // ---- Camera: glide to a view, fit everything on screen ----
  const [glide, setGlide] = useState(false);
  const glideT = useRef(0);
  const glideTo = (z: number, x: number, y: number) => {
    setGlide(true); setZoom(z); setViewX(x); setViewY(y);
    window.clearTimeout(glideT.current);
    glideT.current = window.setTimeout(() => setGlide(false), 520);
  };
  const zoomBy = (f: number) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const nz = Math.min(2, Math.max(0.4, zoom * f));
    const cx = r.width / 2, cy = r.height / 2;
    glideTo(nz, cx - ((cx - viewX) / zoom) * nz, cy - ((cy - viewY) / zoom) * nz);
  };
  const fitView = () => {
    const r = canvasRef.current?.getBoundingClientRect();
    const boxes = openDept ? deptUsers.map((u) => [u.org_x, u.org_y, NODE_W, USER_H]) : placedDepts.map((d) => [d.pos_x, d.pos_y, NODE_W, DEPT_H]);
    if (!r || !boxes.length) { glideTo(1, 0, 0); return; }
    const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
    const x1 = Math.max(...boxes.map((b) => b[0] + b[2])), y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
    const padX = 80, padTop = 90, padBottom = 110;
    const z = Math.min(1.1, Math.max(0.4, Math.min((r.width - padX * 2) / Math.max(1, x1 - x0), (r.height - padTop - padBottom) / Math.max(1, y1 - y0))));
    glideTo(z, (r.width - (x1 - x0) * z) / 2 - x0 * z, padTop + (r.height - padTop - padBottom - (y1 - y0) * z) / 2 - y0 * z);
  };
  // Opening a department (or the first load) frames what's on the map.
  const fitKey = `${openDept ?? "company"}|${loading ? 0 : 1}`;
  const lastFit = useRef("");
  useEffect(() => {
    if (loading || lastFit.current === fitKey) return;
    lastFit.current = fitKey;
    const id = requestAnimationFrame(() => fitView());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  const goCompany = () => { setOpenDept(null); setSelUserId(null); setSelDeptId(null); };
  const openDepartment = (key: string, tab: "people" | "settings" = "people") => { setOpenDept(key); setDeptTab(tab); setSelDeptId(null); setSelUserId(null); };
  const stack = (people: OrgUser[], max = 3) => (
    <span className="org-avstack">
      {people.slice(0, max).map((u, i) => <i key={u.id} style={cssv({ "--j": i })} title={nameOf(u)}>{initials(u)}</i>)}
      {people.length > max && <i className="is-more">+{people.length - max}</i>}
    </span>
  );

  const timebar = (
    <div className="org-timebar">
      <button
        className={`org-notes-btn ${weekNotes.length ? "has-changes" : ""}`}
        onClick={() => setNotesOpen((v) => !v)}
        title="Changes this week"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" />
        </svg>
        {weekNotes.length > 0 && <span className="org-notes-count">{weekNotes.length}</span>}
      </button>

      {isPast && (
        <button className="org-today-btn" onClick={() => setViewDate(todayISO())}>Today</button>
      )}

      <div className="org-weekstep">
        <button className="org-week-arrow" onClick={() => shiftWeek(-1)} aria-label="Previous week">‹</button>
        <button ref={weekBtnRef} className="org-week-label" onClick={() => setPickerOpen((v) => !v)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" />
          </svg>
          <span>{isPast ? `Week of ${mondayOf(viewDate).slice(5)}` : "This week"}</span>
        </button>
        <button className="org-week-arrow" onClick={() => shiftWeek(1)} disabled={mondayOf(viewDate) >= mondayOf(todayISO())} aria-label="Next week">›</button>
      </div>

      <DatePicker
        value={viewDate}
        onChange={(d) => { setViewDate(d); setPickerOpen(false); }}
        weekMode
        maxDate={todayISO()}
        hideTrigger
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        anchorRef={weekBtnRef}
      />

      {notesOpen && (
        <div className="org-notes-pop">
          <div className="org-notes-head">
            <span>Changes · week of {mondayOf(viewDate).slice(5)}</span>
            <button onClick={() => setNotesOpen(false)}>×</button>
          </div>
          {weekNotes.length === 0 ? (
            <p className="org-notes-empty">No changes this week.</p>
          ) : (
            <div className="org-notes-list">
              {weekNotes.map((n) => (
                <div className="org-note" key={n.id}>
                  <span className="org-note-date">{n.effective_date.slice(5)}</span>
                  <span className="org-note-text">{n.note}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const unassignedCount = viewUsers.filter((u) => !u.department).length;
  return (
    <div className={`org ${railWide ? "is-wide" : ""}`}>
      {saveError && <div className="org-save-err" role="alert">{saveError}</div>}
      {/* time bar lives in the page header (in line with the title) via portal */}
      {toolbarReady && toolbarRef?.current ? createPortal(timebar, toolbarRef.current) : null}
      <div className={`org-canvas-wrap ${openDept ? "is-dept" : ""} ${dropping ? "is-dropping" : ""}`} style={cssv({ "--c": openDept ? deptColor(openDept) : "#12b57f" })}>
        {isPast && (
          <div className="org-past-pill">
            <span className="org-past-dot" />
            Viewing {mondayOf(viewDate).slice(0, 10)} · changes here correct the past
          </div>
        )}

        {/* where you are */}
        <div className="org-crumb" key={openDept ?? "company"}>
          {openDept ? (
            <>
              <button className="org-crumb-back" onClick={goCompany} aria-label="All departments">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
                Company
              </button>
              <span className="org-crumb-sep">/</span>
              <span className="org-crumb-here"><i style={cssv({ "--c": deptColor(openDept) })} />{deptLabel(openDept)}<em>{countIn(openDept)} {countIn(openDept) === 1 ? "person" : "people"}</em></span>
            </>
          ) : (
            <span className="org-crumb-here"><i className="is-company" />Company map<em>{placedDepts.length} department{placedDepts.length === 1 ? "" : "s"}</em></span>
          )}
        </div>

        <div
          className={`org-canvas ${drag.current?.moved ? "is-dragging" : ""}`}
          ref={canvasRef}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onClick={(e) => { if (e.target === e.currentTarget && downOnEmpty.current) { setSelDeptId(null); setSelUserId(null); } }}
        >
          <div className="org-grid" aria-hidden="true" style={cssv({ backgroundPosition: `${viewX}px ${viewY}px`, backgroundSize: `${26 * zoom}px ${26 * zoom}px` })} />
          <div className="org-aurora" aria-hidden="true" />
          {loading && <div className="org-loading"><PageLoader fill={false} size={96} tone="dark" label="Loading the organization" /></div>}

          <div
            ref={trashRef}
            className={`org-trash ${drag.current?.moved ? "is-visible" : ""} ${overTrash ? "is-over" : ""}`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
            </svg>
            <span>{openDept ? "Drop to take off the map" : "Drop to take off the map"}</span>
          </div>

          {/* nothing on the map yet */}
          {!loading && (openDept ? deptUsers.length === 0 : placedDepts.length === 0) && (
            <div className="org-empty">
              <span className="org-empty-ring"><i /><i /></span>
              <b>{openDept ? `Build ${deptLabel(openDept)}'s team` : "Start your company map"}</b>
              <span>{openDept
                ? (countIn(openDept) ? "Drag its people here from the panel on the right. Drop one on another to set who they report to." : "Nobody is in this department yet — add people from the panel on the right.")
                : "Drag departments here from the panel on the right. Drop one on another to show who leads it."}</span>
            </div>
          )}

          {/* camera */}
          <div className="org-zoom">
            <button onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" title="Zoom out">−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => zoomBy(1.2)} aria-label="Zoom in" title="Zoom in">+</button>
            <i />
            <button className="org-zoom-fit" onClick={fitView} aria-label="Fit to screen" title="Fit everything on screen">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" /></svg>
            </button>
          </div>

          {/* figures */}
          {!openDept ? (
            <div className="org-legend">
              <span><b><Count n={placedDepts.length} /></b><small>on the map</small></span>
              <span><b><Count n={viewUsers.length - unassignedCount} /></b><small>in a department</small></span>
              <span className={unassignedCount ? "is-warn" : ""}><b><Count n={unassignedCount} /></b><small>without a department</small></span>
            </div>
          ) : (
            <div className="org-legend">
              <span><b><Count n={countIn(openDept)} /></b><small>people</small></span>
              <span><b><Count n={deptUsers.length} /></b><small>on the map</small></span>
              <span><b><Count n={deptUsers.filter((u) => u.manager_id && deptUsers.some((m) => m.id === u.manager_id)).length} /></b><small>reporting lines</small></span>
            </div>
          )}
          {!isPast && <div className="org-hint" aria-hidden="true">Drag to move · drop on another to link · Ctrl + scroll to zoom</div>}

          {/* transformed world: everything pans and zooms together */}
          <div
            key={openDept ?? "company"}
            className={`org-world ${glide ? "is-glide" : ""}`}
            style={{ transform: `translate(${viewX}px, ${viewY}px) scale(${zoom})` }}
          >
            <svg className="org-lines">
              {links.map((l) => (
                <g key={l.key} style={cssv({ "--c": l.c })}>
                  <path d={l.d} className="org-link" />
                  <path d={l.d} className="org-link-flow" />
                </g>
              ))}
            </svg>

            {/* COMPANY VIEW — departments. Short click = open, drag = move, drop on another = led by it. */}
            {!openDept && placedDepts.map((d, i) => {
              const ms = membersOf(d.dept_key);
              const lead = d.parent_id ? placedDepts.find((x) => x.id === d.parent_id) : null;
              return (
                <div
                  key={d.id}
                  className={`org-node org-dept ${selDeptId === d.id ? "is-sel" : ""} ${dropDeptId === d.id ? "is-drop" : ""} ${drag.current?.id === d.id && drag.current?.moved ? "is-lifted" : ""}`}
                  style={{ left: d.pos_x, top: d.pos_y, width: NODE_W, height: DEPT_H, ...cssv({ "--c": deptColor(d.dept_key), "--i": i }) }}
                  onPointerDown={(e) => startDrag("dept", d.id, e)}
                >
                  <span className="org-dept-top">
                    <span className="org-dept-name">{deptLabel(d.dept_key)}</span>
                    <span className="org-dept-go" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                    </span>
                  </span>
                  <span className="org-dept-foot">
                    {ms.length ? stack(ms) : <span className="org-dept-none">No one yet</span>}
                    <span className="org-dept-count">{ms.length}<small>{ms.length === 1 ? " person" : " people"}</small></span>
                  </span>
                  {lead && <span className="org-dept-lead" style={cssv({ "--lc": deptColor(lead.dept_key) })}>under {deptLabel(lead.dept_key)}</span>}
                  {dropDeptId === d.id && <span className="org-dept-dropnote">Drop to add here</span>}
                </div>
              );
            })}

            {/* DEPARTMENT VIEW — its people */}
            {openDept && deptUsers.map((u, i) => {
              const n = reportsOf(u.id);
              return (
                <div
                  key={u.id}
                  className={`org-node org-user ${selUserId === u.id ? "is-sel" : ""} ${drag.current?.id === u.id && drag.current?.moved ? "is-lifted" : ""}`}
                  style={{ left: u.org_x, top: u.org_y, width: NODE_W, height: USER_H, ...cssv({ "--c": deptColor(openDept), "--i": i }) }}
                  onPointerDown={(e) => startDrag("user", u.id, e)}
                >
                  <span className="org-user-av">{initials(u)}</span>
                  <span className="org-user-main">
                    <span className="org-user-name">{nameOf(u)}</span>
                    <span className="org-user-sub">{roleLabel(effectiveRole(u))}</span>
                  </span>
                  {n > 0 && <span className="org-user-rep" title={`${n} report${n === 1 ? "s" : ""} to them`}>{n}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* RIGHT RAIL */}
      <aside className="org-rail" style={cssv({ "--c": railColor })}>
        {selUser ? (
          <UserPanel
            key={selUser.id}
            user={selUser}
            depts={depts}
            users={users}
            canManage={canManage}
            canSeeSensitive={canSeeSensitive}
            nameOf={nameOf}
            initials={initials}
            effectiveRole={effectiveRole}
            onSave={saveUser}
            onClose={() => setSelUserId(null)}
            onDelete={deleteUser}
            onLayOff={layOff}
            onReactivate={reactivate}
            reportsCount={users.filter((u) => u.manager_id === selUser.id && u.active).length}
          />
        ) : selDept ? (
          <div className="org-info" style={cssv({ "--c": deptColor(selDept.dept_key) })}>
            <div className="org-info-head">
              <span className="org-eyebrow">Department</span>
              <button className="org-info-close" onClick={() => setSelDeptId(null)}>×</button>
            </div>
            <h3 className="org-info-title">{deptLabel(selDept.dept_key)}</h3>
            <button className="org-enter-btn" onClick={() => openDepartment(selDept.dept_key)}>
              Open team ({countIn(selDept.dept_key)}) →
            </button>
            <div className="org-field">
              <label>Led by department</label>
              <Select
                value={selDept.parent_id ?? ""}
                disabled={!canManage}
                onChange={(v) => saveDept(selDept.id, { parent_id: v || null })}
                placeholder="— None (top level) —"
                options={[{ value: "", label: "— None (top level) —" },
                  ...placedDepts.filter((d) => d.id !== selDept.id).map((d) => ({ value: d.id, label: deptLabel(d.dept_key) }))]}
              />
            </div>
            <div className="org-field">
              <label>Default security role</label>
              <Select
                value={selDept.security_role ?? ""}
                disabled={!canManage}
                onChange={(v) => saveDept(selDept.id, { security_role: v || null })}
                placeholder="— None —"
                options={[{ value: "", label: "— None —" }, ...LEVELS.map((l) => ({ value: l.id, label: l.label }))]}
              />
              <span className="org-field-note">Members inherit this role unless they have their own.</span>
            </div>
            {canManage && selDept.placed && (
              <button className="org-remove" onClick={() => { saveDept(selDept.id, { placed: false, parent_id: null }); setSelDeptId(null); }}>
                Take off the map
              </button>
            )}
          </div>
        ) : openDept && openDeptRow ? (
          <div className="org-info org-dinfo" key={`d-${openDept}`}>
            <div className="org-dhero">
              <div className="org-dhero-top">
                <button className="org-dhero-back" onClick={goCompany}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
                  All departments
                </button>
                {canManage && <button className="org-dhero-add" onClick={() => setShowCreate(true)}>+ New user</button>}
              </div>
              <span className="org-eyebrow">Department</span>
              <h3>{deptLabel(openDept)}</h3>
              <div className="org-dhero-stats">
                <span><b><Count n={countIn(openDept)} /></b>people</span>
                <span><b><Count n={deptUsers.length} /></b>on the map</span>
                <span><b>{(() => { const p = openDeptRow.parent_id ? depts.find((x) => x.id === openDeptRow.parent_id) : null; return p ? deptLabel(p.dept_key) : "Top level"; })()}</b>reports to</span>
              </div>
            </div>
            <div className="org-seg" style={cssv({ "--k": deptTab === "people" ? 0 : 1 })}>
              <span className="org-seg-pill" aria-hidden="true" />
              <button className={deptTab === "people" ? "is-on" : ""} onClick={() => setDeptTab("people")}>People <i>{countIn(openDept)}</i></button>
              <button className={deptTab === "settings" ? "is-on" : ""} onClick={() => setDeptTab("settings")}>Settings</button>
            </div>

            {deptTab === "settings" ? (
              <div className="org-pane" key="settings">
                <DeptLook key={openDeptRow.id} canManage={canManage && !isPast}
                  name={deptLabel(openDeptRow.dept_key)} color={deptColor(openDeptRow.dept_key)}
                  taken={depts.filter((d) => d.id !== openDeptRow.id).map((d) => deptLabel(d.dept_key).toLowerCase())}
                  onSave={(patch) => saveDept(openDeptRow.id, patch)} />
                <div className="org-field">
                  <label>Reports to department</label>
                  <Select
                    value={openDeptRow.parent_id ?? ""}
                    disabled={!canManage}
                    onChange={(v) => saveDept(openDeptRow.id, { parent_id: v || null })}
                    placeholder="— None (top level) —"
                    options={[{ value: "", label: "— None (top level) —" },
                      ...placedDepts.filter((d) => d.id !== openDeptRow.id).map((d) => ({ value: d.id, label: deptLabel(d.dept_key) }))]}
                  />
                </div>
                <div className="org-field">
                  <label>Default security role</label>
                  <Select
                    value={openDeptRow.security_role ?? ""}
                    disabled={!canManage}
                    onChange={(v) => saveDept(openDeptRow.id, { security_role: v || null })}
                    placeholder="— None —"
                    options={[{ value: "", label: "— None —" }, ...LEVELS.map((l) => ({ value: l.id, label: l.label }))]}
                  />
                  <span className="org-field-note">Members inherit this role unless they have their own.</span>
                </div>
                {canManage && openDeptRow.placed && !isPast && (
                  <button className="org-remove" onClick={() => { saveDept(openDeptRow.id, { placed: false, parent_id: null }); goCompany(); }}>Take off the company map</button>
                )}
                {canManage && !isPast && (
                  <DeptDelete key={`del-${openDeptRow.id}`} name={deptLabel(openDeptRow.dept_key)} members={countIn(openDeptRow.dept_key)}
                    onDelete={() => deleteDept(openDeptRow)} />
                )}
              </div>
            ) : (
              <div className="org-pane" key="people">
                <p className="org-palette-subhint">Drag people onto the map. Drop one on another to set who they report to.</p>
                <div className="org-palette-list">
                  {membersOf(openDept).length === 0
                    ? <p className="org-empty-note">No one in this department yet. Open a person from <b>Company › People</b> and choose this department, or create a new user.</p>
                    : membersOf(openDept).map((u, i) => (
                      <div key={u.id}
                        className={`org-prow ${u.org_placed ? "is-placed" : "is-loose"} ${selUserId === u.id ? "is-sel" : ""}`}
                        style={cssv({ "--c": deptColor(openDept), "--i": i })}
                        draggable={canManage && !u.org_placed}
                        onDragStart={(e) => { dragKind.current = "user"; e.dataTransfer.setData("text/plain", `user:${u.id}`); }}
                        onDragEnd={() => { dragKind.current = null; }}
                        onClick={() => { setSelUserId(u.id); }}>
                        <span className="org-av">{initials(u)}</span>
                        <span className="org-prow-main">
                          <b>{nameOf(u)}</b>
                          <small>{roleLabel(effectiveRole(u))}</small>
                        </span>
                        <span className={`org-prow-state ${u.org_placed ? "is-on" : ""}`}>{u.org_placed ? "On the map" : "Drag in"}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="org-palette" key="company">
            <div className="org-rail-head">
              <div>
                <span className="org-eyebrow">Organization</span>
                <h3>Your company</h3>
              </div>
              {canManage && <button className="org-add-user" onClick={() => setShowCreate(true)}>+ New user</button>}
            </div>
            <div className="org-seg" style={cssv({ "--k": companyTab === "depts" ? 0 : 1 })}>
              <span className="org-seg-pill" aria-hidden="true" />
              <button className={companyTab === "depts" ? "is-on" : ""} onClick={() => setCompanyTab("depts")}>Departments <i>{viewDepts.length}</i></button>
              <button className={companyTab === "people" ? "is-on" : ""} onClick={() => setCompanyTab("people")}>People <i>{viewUsers.length}</i></button>
            </div>

            {companyTab === "depts" ? (
              <div className="org-pane" key="depts">
                {canManage && !isPast && <NewDept onCreate={createDept} />}
                <div className="org-palette-list">
                  {viewDepts.length === 0 ? <p className="org-empty-note">No departments yet — add the first one above.</p> : viewDepts.map((d, i) => {
                    const ms = membersOf(d.dept_key);
                    return (
                      <div key={d.id} className={`org-dcard ${d.placed ? "is-placed" : "is-loose"}`}
                        style={cssv({ "--c": deptColor(d.dept_key), "--i": i })}
                        draggable={canManage && !d.placed && !isPast}
                        onDragStart={(e) => { dragKind.current = "dept"; e.dataTransfer.setData("text/plain", `dept:${d.id}`); }}
                        onDragEnd={() => { dragKind.current = null; }}
                        onClick={() => openDepartment(d.dept_key)}>
                        <span className="org-dcard-main">
                          <b>{deptLabel(d.dept_key)}</b>
                          <small>{d.placed ? "On the map" : canManage ? "Drag onto the map" : "Not on the map"}</small>
                        </span>
                        {ms.length > 0 && stack(ms, 3)}
                        <span className="org-dcard-n">{ms.length}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="org-pane" key="people">
                <div className="org-search">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
                  </svg>
                  <input placeholder="Search people…" value={search} onChange={(e) => setSearch(e.target.value)} />
                  {search && <button onClick={() => setSearch("")} aria-label="Clear">×</button>}
                </div>
                <div className="org-filter" style={cssv({ "--k": showAllPeople ? 1 : 0 })}>
                  <span className="org-seg-pill" aria-hidden="true" />
                  <button className={!showAllPeople ? "is-on" : ""} onClick={() => setShowAllPeople(false)}>No department <i>{unassignedCount}</i></button>
                  <button className={showAllPeople ? "is-on" : ""} onClick={() => setShowAllPeople(true)}>Everyone</button>
                </div>
                <p className="org-palette-subhint">Click someone for their details. Drag them onto a department on the map to move them there.</p>
                <div className="org-palette-list">
                  {peopleFiltered.length === 0 ? <p className="org-empty-note">{showAllPeople || search ? "No matches." : "Everyone has a department."}</p> : peopleFiltered.map((u, i) => (
                    <div key={u.id} className={`org-prow ${selUserId === u.id ? "is-sel" : ""}`}
                      style={cssv({ "--c": u.department ? deptColor(u.department) : "#9fb5ab", "--i": Math.min(i, 20) })}
                      draggable={canManage && !isPast}
                      onDragStart={(e) => { dragKind.current = "user"; e.dataTransfer.setData("text/plain", `user:${u.id}`); }}
                      onDragEnd={() => { dragKind.current = null; setDropDeptId(null); }}
                      onClick={() => { setSelUserId(u.id); setSelDeptId(null); }}>
                      <span className="org-av">{initials(u)}</span>
                      <span className="org-prow-main">
                        <b>{nameOf(u)}</b>
                        <small>{roleLabel(effectiveRole(u))}</small>
                      </span>
                      <span className={`org-dpill ${u.department ? "" : "is-none"}`}>{u.department ? deptLabel(u.department) : "No department"}</span>
                    </div>
                  ))}
                </div>
                {formerUsers.length > 0 && (
                  <details className="org-former-list">
                    <summary>Former employees <i>{formerUsers.length}</i></summary>
                    <div className="org-palette-list">
                      {formerUsers.filter((u) => !search.trim() || nameOf(u).toLowerCase().includes(search.trim().toLowerCase())).map((u) => (
                        <div key={u.id} className={`org-prow is-former ${selUserId === u.id ? "is-sel" : ""}`}
                          onClick={() => { setSelUserId(u.id); setSelDeptId(null); }}>
                          <span className="org-av">{initials(u)}</span>
                          <span className="org-prow-main">
                            <b>{nameOf(u)}</b>
                            <small>Left {u.deactivated_at ? new Date(`${u.deactivated_at}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : ""}</small>
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        )}
      </aside>

      {showCreate && (
        <NewUserModal
          allowedLevels={LEVELS.map((l) => l.id)}
          onCreate={async (payload: NewUserPayload) => {
            const { data, error } = await supabase.functions.invoke("manage-users", { body: { action: "create", user: payload } });
            if (error) {
              // functions.invoke hides the body on non-2xx; dig it out for the real message.
              let detail = error.message ?? "Could not create user.";
              try {
                const ctx = (error as any).context;
                if (ctx && typeof ctx.json === "function") { const b = await ctx.json(); if (b?.error) detail = b.error; }
              } catch { /* ignore */ }
              return detail;
            }
            if (data?.error) return data.error as string;
            await load();
            return null;
          }}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

// ---- User info / edit panel ----
function UserPanel({
  user, depts, users, canManage, canSeeSensitive, nameOf, initials, effectiveRole, onSave, onClose, onDelete,
  onLayOff, onReactivate, reportsCount,
}: {
  user: OrgUser; depts: Dept[]; users: OrgUser[];
  canManage: boolean; canSeeSensitive: boolean;
  nameOf: (u: OrgUser) => string; initials: (u: OrgUser) => string;
  effectiveRole: (u: OrgUser) => string | null;
  onSave: (id: string, patch: Partial<OrgUser>) => void;
  onClose: () => void;
  onDelete: (id: string, name: string) => void;
  onLayOff: (id: string, lastDay: string, reason: string) => Promise<string | null>;
  onReactivate: (id: string) => Promise<string | null>;
  reportsCount: number;
}) {
  // local editable copy for text fields (saved on blur)
  const [form, setForm] = useState(user);
  useEffect(() => { setForm(user); }, [user]);
  const set = (patch: Partial<OrgUser>) => setForm((f) => ({ ...f, ...patch }));
  const commit = (patch: Partial<OrgUser>) => onSave(user.id, patch);
  const deptRoleDefault = depts.find((d) => d.dept_key === user.department)?.security_role ?? null;
  // lay off flow
  const [layoff, setLayoff] = useState(false);
  const [lastDay, setLastDay] = useState(todayISO());
  const [reason, setReason] = useState("Dismissal");
  const [reasonNote, setReasonNote] = useState("");
  const [empBusy, setEmpBusy] = useState(false);
  const [empErr, setEmpErr] = useState<string | null>(null);
  /**
   * Work in their calendar that was never confirmed (planned, not cancelled,
   * not a meeting). After the last day it's removed when they're laid off;
   * up to the last day we ask: confirm it as worked, or remove it.
   */
  const [unconfirmed, setUnconfirmed] = useState<{ date: string }[] | null>(null);
  const [beforeAction, setBeforeAction] = useState<"remove" | "confirm" | "keep">("remove");
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleDone, setSettleDone] = useState<string | null>(null);
  const [settleAsk, setSettleAsk] = useState<"remove" | "confirm" | null>(null);
  const loadUnconfirmed = useCallback(async () => {
    const { data, error } = await supabase.from("calendar_entries").select("id, entry_date, status, kind").eq("user_id", user.id);
    if (error) { setUnconfirmed([]); return; }
    setUnconfirmed(((data ?? []) as any[])
      .filter((r) => r.status !== "confirmed" && r.status !== "cancelled" && r.kind !== "meeting")
      .map((r) => ({ date: String(r.entry_date ?? "").slice(0, 10) })));
  }, [user.id]);
  useEffect(() => { setUnconfirmed(null); setSettleDone(null); setSettleAsk(null); if (layoff || !user.active) void loadUnconfirmed(); }, [layoff, user.active, user.id, loadUnconfirmed]);
  const daysOf = (rows: { date: string }[]) => new Set(rows.map((r) => r.date)).size;
  const plannedAfterRows = (unconfirmed ?? []).filter((r) => r.date > lastDay);
  const plannedBeforeRows = (unconfirmed ?? []).filter((r) => r.date <= lastDay);
  const plannedAfter = unconfirmed ? { entries: plannedAfterRows.length, days: daysOf(plannedAfterRows) } : null;
  const settle = async (action: "remove" | "confirm"): Promise<string | null> => {
    const { data, error } = await supabase.rpc("settle_unconfirmed_work", { p_user: user.id, p_action: action });
    if (error) return /settle_unconfirmed_work|does not exist|schema cache/i.test(error.message) ? "Run empower_layoff_planned.sql in Supabase first, then try again." : error.message;
    const n = Number(data) || 0;
    setSettleDone(action === "remove" ? `${n} planned ${n === 1 ? "entry" : "entries"} removed.` : `${n} ${n === 1 ? "entry" : "entries"} confirmed as worked.`);
    return null;
  };
  const settleNow = async (action: "remove" | "confirm") => {
    setSettleBusy(true); setEmpErr(null);
    const e = await settle(action);
    setSettleBusy(false); setSettleAsk(null);
    if (e) setEmpErr(e); else await loadUnconfirmed();
  };
  const manager = users.find((u) => u.id === user.manager_id) ?? null;
  const prettyDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const confirmLayOff = async () => {
    setEmpBusy(true); setEmpErr(null);
    const e = await onLayOff(user.id, lastDay, [reason, reasonNote.trim()].filter(Boolean).join(" — "));
    if (e) { setEmpBusy(false); setEmpErr(e); return; }
    // Days up to the last day that were never confirmed: what was picked above.
    if (plannedBeforeRows.length && beforeAction !== "keep") {
      const e2 = await settle(beforeAction);
      if (e2) setEmpErr(e2);
    }
    setEmpBusy(false);
    setLayoff(false);
  };
  const doReactivate = async () => {
    setEmpBusy(true); setEmpErr(null);
    const e = await onReactivate(user.id);
    setEmpBusy(false);
    if (e) setEmpErr(e);
  };

  return (
    <div className="org-info">
      <div className="org-info-head">
        <span className="org-eyebrow">Person</span>
        <button className="org-info-close" onClick={onClose}>×</button>
      </div>
      <div className="org-info-person">
        <span className="org-user-av lg">{initials(user)}</span>
        <h3 className="org-info-title">{nameOf(user)}</h3>
        <span className="org-info-email">{roleLabel(effectiveRole(user))}</span>
      </div>
      {!user.active && (
        <div className="org-former">
          <b>Former employee</b>
          <span>Last day {user.deactivated_at ? prettyDay(user.deactivated_at) : "—"}{user.deactivation_reason ? ` · ${user.deactivation_reason}` : ""}</span>
          <em>Hidden from the map and the people lists. Their past work keeps their name.</em>
        </div>
      )}
      {!user.active && (unconfirmed?.length || settleDone) ? (
        <div className={`org-unconf is-former ${settleDone && !unconfirmed?.length ? "is-done" : ""}`}>
          {unconfirmed && unconfirmed.length > 0 ? (
            <>
              <b>{unconfirmed.length} planned {unconfirmed.length === 1 ? "entry" : "entries"} never confirmed</b>
              <span>
                {daysOf(unconfirmed)} {daysOf(unconfirmed) === 1 ? "day" : "days"}, {prettyDay(unconfirmed.map((r) => r.date).sort()[0])} – {prettyDay(unconfirmed.map((r) => r.date).sort().at(-1)!)}.
                {" "}They still count as planned in Management.
              </span>
              {settleAsk ? (
                <div className="org-unconf-ask">
                  <span>{settleAsk === "remove" ? "Remove them for good?" : "Count them as worked days?"}</span>
                  <button className="org-layoff-cancel" onClick={() => setSettleAsk(null)} disabled={settleBusy}>Cancel</button>
                  <button className={settleAsk === "remove" ? "org-layoff-go" : "org-unconf-confirm"} onClick={() => settleNow(settleAsk)} disabled={settleBusy}>
                    {settleBusy ? "…" : settleAsk === "remove" ? "Remove" : "Confirm"}
                  </button>
                </div>
              ) : (
                <div className="org-unconf-btns">
                  <button className="org-unconf-remove" onClick={() => setSettleAsk("remove")}>Remove them</button>
                  <button className="org-unconf-confirm" onClick={() => setSettleAsk("confirm")}>Confirm as worked</button>
                </div>
              )}
            </>
          ) : <span className="org-unconf-ok">✓ {settleDone}</span>}
        </div>
      ) : null}

      <span className="org-section-label">Identity</span>
      <div className="org-field-row">
        <div className="org-field">
          <label>First name</label>
          <input value={form.first_name ?? ""} disabled={!canManage}
            onChange={(e) => set({ first_name: e.target.value })}
            onBlur={() => commit({ first_name: form.first_name })} />
        </div>
        <div className="org-field">
          <label>Last name</label>
          <input value={form.last_name ?? ""} disabled={!canManage}
            onChange={(e) => set({ last_name: e.target.value })}
            onBlur={() => commit({ last_name: form.last_name })} />
        </div>
      </div>
      <div className="org-field">
        <label>Email</label>
        <input value={form.email ?? ""} disabled={!canManage}
          onChange={(e) => set({ email: e.target.value })}
          onBlur={() => commit({ email: form.email })} />
      </div>
      <div className="org-field-row">
        <div className="org-field">
          <label>Phone</label>
          <input value={form.phone ?? ""} disabled={!canManage}
            onChange={(e) => set({ phone: e.target.value })}
            onBlur={() => commit({ phone: form.phone })} />
        </div>
        <div className="org-field">
          <label>National ID (DNI)</label>
          <input value={form.national_id ?? ""} disabled={!canManage}
            onChange={(e) => set({ national_id: e.target.value })}
            onBlur={() => commit({ national_id: form.national_id })} />
        </div>
      </div>
      <div className="org-field">
        <label>Social security number</label>
        <input value={form.social_security ?? ""} disabled={!canManage}
          onChange={(e) => set({ social_security: e.target.value })}
          onBlur={() => commit({ social_security: form.social_security })} />
      </div>
      <div className="org-field">
        <label>Address</label>
        <input value={form.address ?? ""} disabled={!canManage}
          onChange={(e) => set({ address: e.target.value })}
          onBlur={() => commit({ address: form.address })} />
      </div>
      <div className="org-field">
        <label>Start date</label>
        {canManage ? (
          <DatePicker value={form.start_date ?? ""}
            onChange={(v) => { set({ start_date: v || null }); commit({ start_date: v || null }); }} />
        ) : (
          <input value={form.start_date ?? ""} disabled readOnly />
        )}
      </div>

      <span className="org-section-label">Structure</span>
      <div className="org-field">
        <label>Department</label>
        <Select value={form.department ?? ""} disabled={!canManage}
          onChange={(v) => commit({ department: v || null })}
          placeholder="— None —"
          options={[{ value: "", label: "— None —" }, ...depts.map((d) => ({ value: d.dept_key, label: deptLabel(d.dept_key) }))]} />
      </div>
      <div className="org-field">
        <label>Reports to</label>
        <Select value={form.manager_id ?? ""} disabled={!canManage}
          onChange={(v) => commit({ manager_id: v || null })}
          placeholder="— No one —"
          options={[{ value: "", label: "— No one —" },
            ...users.filter((u) => u.id !== user.id && (u.active || u.id === user.manager_id)).map((u) => ({ value: u.id, label: nameOf(u) + (u.active ? "" : " (former)") }))]} />
      </div>
      <div className="org-field">
        <label>Security role</label>
        <Select value={form.role ?? ""} disabled={!canManage}
          onChange={(v) => commit({ role: v || null })}
          placeholder={`— Inherit (${roleLabel(deptRoleDefault)}) —`}
          options={[{ value: "", label: `— Inherit from department (${roleLabel(deptRoleDefault)}) —` },
            ...LEVELS.map((l) => ({ value: l.id, label: l.label }))]} />
        <span className="org-field-note">Effective role: <b>{roleLabel(effectiveRole(user))}</b></span>
      </div>

      {canSeeSensitive && (
        <>
          <span className="org-section-label org-sensitive-label">Sensitive · managers only</span>
          <div className="org-field">
            <label>Salary (€ / year)</label>
            <input type="text" inputMode="numeric"
              value={form.salary != null ? form.salary.toLocaleString("es-ES") : ""}
              disabled={!canManage}
              onChange={(e) => {
                const digits = e.target.value.replace(/[^\d]/g, "");
                set({ salary: digits === "" ? null : Number(digits) });
              }}
              onBlur={() => commit({ salary: form.salary })}
              placeholder="0" />
          </div>
          <div className="org-field">
            <label>Bank account (IBAN)</label>
            <input value={form.bank_iban ?? ""} disabled={!canManage}
              onChange={(e) => set({ bank_iban: e.target.value })}
              onBlur={() => commit({ bank_iban: form.bank_iban })} />
          </div>
        </>
      )}

      {canManage && (
        <div className="org-emp">
          <span className="org-section-label">Employment</span>
          {user.active ? (
            !layoff ? (
              <button className="org-layoff-btn" onClick={() => { setLayoff(true); setEmpErr(null); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM17 8l5 5M22 8l-5 5" /></svg>
                Lay off {user.first_name || nameOf(user)}…
              </button>
            ) : (
              <div className="org-layoff">
                <h4>Lay off {nameOf(user)}</h4>
                <label>Last working day</label>
                <div className="org-layoff-date">
                  <DatePicker value={lastDay} onChange={(d) => setLastDay(d || todayISO())} maxDate={todayISO()} placeholder="Last working day" />
                </div>
                <label>Reason</label>
                <div className="org-layoff-reasons">
                  {["Dismissal", "Resignation", "End of contract", "Retirement", "Other"].map((r) => (
                    <button key={r} className={reason === r ? "is-on" : ""} onClick={() => setReason(r)}>{r}</button>
                  ))}
                </div>
                <input value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder="Note (optional)" />
                <ul className="org-layoff-what">
                  <li>Can't sign in any more — logged out of every device right away.</li>
                  <li>Disappears from the map and the people lists from {prettyDay(lastDay)}; earlier weeks still show them.</li>
                  <li>Their deals, hours, notes and history are kept, with their name.</li>
                  <li className={plannedAfter?.entries ? "is-warn" : ""}>
                    {plannedAfter?.entries
                      ? <><b>{plannedAfter.entries} planned {plannedAfter.entries === 1 ? "entry" : "entries"} on {plannedAfter.days} {plannedAfter.days === 1 ? "day" : "days"}</b> after {prettyDay(lastDay)} {plannedAfter.entries === 1 ? "is" : "are"} removed — {plannedAfter.entries === 1 ? "it stops" : "they stop"} counting in Management, the backlog and forecasts. Confirmed hours stay.</>
                      : <>Anything still planned for them after {prettyDay(lastDay)} is removed; confirmed hours stay.</>}
                  </li>
                  {reportsCount > 0 && <li><b>{reportsCount} {reportsCount === 1 ? "person reports" : "people report"} to them</b> — they'll report to {manager ? nameOf(manager) : "no one"} instead.</li>}
                </ul>
                {plannedBeforeRows.length > 0 && (
                  <div className="org-unconf">
                    <b>{plannedBeforeRows.length} planned {plannedBeforeRows.length === 1 ? "entry" : "entries"} up to {prettyDay(lastDay)} {plannedBeforeRows.length === 1 ? "was" : "were"} never confirmed</b>
                    <span>{daysOf(plannedBeforeRows)} {daysOf(plannedBeforeRows) === 1 ? "day" : "days"}, {prettyDay(plannedBeforeRows.map((r) => r.date).sort()[0])} – {prettyDay(plannedBeforeRows.map((r) => r.date).sort().at(-1)!)}. What should happen to them?</span>
                    <div className="org-unconf-opts" role="radiogroup">
                      {([["remove", "Remove them", "They didn't happen"], ["confirm", "Confirm as worked", "Count them as real"], ["keep", "Leave as planned", "Decide later"]] as const).map(([v, l, h]) => (
                        <button key={v} role="radio" aria-checked={beforeAction === v} className={beforeAction === v ? "is-on" : ""} onClick={() => setBeforeAction(v)}>
                          <i /><span><b>{l}</b><small>{h}</small></span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {empErr && <p className="org-emp-err">{empErr}</p>}
                <div className="org-layoff-actions">
                  <button className="org-layoff-cancel" onClick={() => setLayoff(false)} disabled={empBusy}>Cancel</button>
                  <button className="org-layoff-go" onClick={confirmLayOff} disabled={empBusy}>{empBusy ? "Laying off…" : `Lay off ${user.first_name || "them"}`}</button>
                </div>
              </div>
            )
          ) : (
            <>
              <button className="org-reactivate-btn" onClick={doReactivate} disabled={empBusy}>{empBusy ? "Reactivating…" : `Reactivate ${user.first_name || nameOf(user)}`}</button>
              <p className="org-emp-hint">Lets them sign in again and puts them back in lists and pickers.</p>
              {empErr && <p className="org-emp-err">{empErr}</p>}
            </>
          )}
        </div>
      )}

      {canManage && (
        <button className="org-delete-user" onClick={() => onDelete(user.id, nameOf(user))}>
          Delete this user permanently
        </button>
      )}
    </div>
  );
}
/* ---- Departments: a new one, its name / colour / mark, removing it ---- */
function NewDept({ onCreate }: { onCreate: (name: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    const e = await onCreate(name);
    setBusy(false);
    if (e) { setErr(e); return; }
    setName(""); setOpen(false);
  };
  if (!open) return <button className="org-newdept-btn" onClick={() => setOpen(true)}><span>+</span>New department</button>;
  return (
    <div className="org-newdept">
      <input autoFocus value={name} placeholder="Department name, e.g. Finance" maxLength={60}
        onChange={(e) => { setName(e.target.value); setErr(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") void go(); if (e.key === "Escape") { setOpen(false); setName(""); setErr(null); } }} />
      <div className="org-newdept-act">
        <button className="org-ghost" onClick={() => { setOpen(false); setName(""); setErr(null); }}>Cancel</button>
        <button className="org-add-user" disabled={busy || !name.trim()} onClick={() => void go()}>{busy ? "Adding…" : "Add"}</button>
      </div>
      {err && <p className="org-newdept-err">{err}</p>}
    </div>
  );
}

function DeptLook({ name, color, taken, canManage, onSave }: {
  name: string; color: string; taken: string[]; canManage: boolean;
  onSave: (patch: Partial<Dept>) => void;
}) {
  const [draft, setDraft] = useState(name);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setDraft(name); }, [name]);
  const commit = () => {
    const v = draft.trim();
    if (!v) { setDraft(name); setErr(null); return; }
    if (v === name) { setErr(null); return; }
    if (taken.includes(v.toLowerCase())) { setErr("Another department already has that name."); return; }
    setErr(null);
    onSave({ name: v });
  };
  return (
    <div className="org-look">
      <div className="org-field">
        <label>Name</label>
        <div className="org-look-name" style={cssv({ "--c": color })}>
          <i />
          <input value={draft} disabled={!canManage} maxLength={60}
            onChange={(e) => { setDraft(e.target.value); setErr(null); }}
            onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); if (e.key === "Escape") { setDraft(name); setErr(null); } }} />
        </div>
        {err && <span className="org-newdept-err">{err}</span>}
      </div>
      <div className="org-field">
        <label>Colour</label>
        <div className="org-swatches">
          {DEPT_COLORS.map((c, i) => (
            <button key={c} className={c.toLowerCase() === color.toLowerCase() ? "is-on" : ""} style={cssv({ background: c, "--i": i })} disabled={!canManage}
              aria-label={`Colour ${c}`} onClick={() => onSave({ color: c })} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DeptDelete({ name, members, onDelete }: { name: string; members: number; onDelete: () => Promise<string | null> }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ask) return <button className="org-remove is-danger" onClick={() => { setAsk(true); setErr(null); }}>Delete department</button>;
  return (
    <div className="org-del-ask" role="alertdialog" aria-label={`Delete ${name}`}>
      <b>Delete {name}?</b>
      <span>{members ? `Its ${members} ${members === 1 ? "person stays" : "people stay"} in the company without a department — you can move them to another one.` : "Nobody is in it."} Pages it could open won't list it any more.</span>
      {err && <span className="org-newdept-err">{err}</span>}
      <div className="org-newdept-act">
        <button className="org-ghost" disabled={busy} onClick={() => setAsk(false)}>Keep it</button>
        <button className="org-del-yes" disabled={busy} onClick={async () => { setBusy(true); const e = await onDelete(); setBusy(false); if (e) setErr(e); }}>{busy ? "Deleting…" : "Delete"}</button>
      </div>
    </div>
  );
}
