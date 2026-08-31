/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import { recordChanges, loadHistoryUpTo, loadWeekNotes, loadChangeWeeks, reconstruct, todayISO, mondayOf, type HistoryEvent } from "./orgHistory";
import { LEVELS, type NewUserPayload } from "./NewUserModal";
import NewUserModal from "./NewUserModal";
import "./Organization.css";

// The 7 fixed departments, each with its own colour + glyph.
export const DEPARTMENTS = [
  { key: "consultancy", label: "Consultancy", color: "#12b57f", icon: "◆" },
  { key: "human_resources", label: "Human Resources", color: "#e0798c", icon: "♥" },
  { key: "marketing", label: "Marketing", color: "#e0a13c", icon: "◈" },
  { key: "sales", label: "Sales", color: "#3c9ae0", icon: "▲" },
  { key: "customer_success", label: "Customer Success", color: "#9b6fd0", icon: "★" },
  { key: "it", label: "IT", color: "#4a5568", icon: "❖" },
  { key: "management", label: "Management", color: "#0a6f4d", icon: "◉" },
] as const;
const deptOf = (k: string | null) => DEPARTMENTS.find((d) => d.key === k);
const deptLabel = (k: string | null) => deptOf(k)?.label ?? k ?? "—";
const deptColor = (k: string | null) => deptOf(k)?.color ?? "#5a7d6d";
const deptIcon = (k: string | null) => deptOf(k)?.icon ?? "•";
const roleLabel = (id: string | null) => LEVELS.find((l) => l.id === id)?.label ?? id ?? "—";

interface Dept {
  id: string;
  dept_key: string;
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
}

const NODE_W = 180;
const DEPT_H = 64;
const USER_H = 58;

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
    const { data: existing } = await supabase.from("org_departments").select("*");
    let deptRows = (existing ?? []) as Dept[];
    const haveKeys = new Set(deptRows.map((d) => d.dept_key));
    const missing = DEPARTMENTS.filter((d) => !haveKeys.has(d.key));
    if (missing.length) {
      await supabase.from("org_departments").insert(missing.map((d) => ({ dept_key: d.key })));
      const { data: refetched } = await supabase.from("org_departments").select("*");
      deptRows = (refetched ?? []) as Dept[];
    }
    setDepts(deptRows);

    const { data: profs } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, email, role, department, manager_id, org_x, org_y, org_placed, phone, national_id, social_security, address, start_date, bank_iban, salary");
    setUsers(((profs ?? []) as any[]).map((p) => ({
      id: p.id,
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      role: p.role, department: p.department, manager_id: p.manager_id,
      org_x: p.org_x ?? 0, org_y: p.org_y ?? 0, org_placed: !!p.org_placed,
      phone: p.phone, national_id: p.national_id, social_security: p.social_security, address: p.address,
      start_date: p.start_date, bank_iban: p.bank_iban, salary: p.salary,
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
    setDepts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    const { error } = await supabase.from("org_departments").update(patch).eq("id", id);
    if (error) { console.error("[org] saveDept failed:", error.message, patch); return; }
    await recordChanges("dept", id, patch as any, todayISO(), deptLabel(row?.dept_key ?? null), resolveNote);
    refreshChangeWeeks();
  };
  const [saveError, setSaveError] = useState<string | null>(null);

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
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const over = (e: DragEvent) => { e.preventDefault(); };
    const drop = (e: DragEvent) => { onCanvasDropRef.current(e); };
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

  // ---- Derived ----
  // When time-traveling, overlay reconstructed past values onto the rows.
  // The overlay carries past *content* (department, manager, role, salary…),
  // but NOT canvas position — position is a single live value, it doesn't time-travel.
  const viewDepts = pastOverlay
    ? depts.map((d) => { const o = { ...(pastOverlay.depts[d.id] ?? {}) }; delete o.pos_x; delete o.pos_y; return { ...d, ...o }; })
    : depts;
  const viewUsers = pastOverlay
    ? users.map((u) => { const o = { ...(pastOverlay.users[u.id] ?? {}) }; delete o.org_x; delete o.org_y; return { ...u, ...o }; })
    : users;

  const placedDepts = viewDepts.filter((d) => d.placed);
  const paletteDepts = viewDepts.filter((d) => !d.placed);
  const unassignedUsers = viewUsers.filter((u) => !u.department);
  const peopleFiltered = viewUsers.filter((u) => {
    if (!showAllPeople && u.department) return false; // only unassigned unless "show all"
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (nameOf(u).toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q));
  });
  const deptUsers = openDept ? viewUsers.filter((u) => u.department === openDept && u.org_placed) : [];

  const selDept = selDeptId ? viewDepts.find((d) => d.id === selDeptId) ?? null : null;
  const selUser = selUserId ? viewUsers.find((u) => u.id === selUserId) ?? null : null;

  // ---- Lines ----
  const centerDept = (d: Dept) => ({ x: d.pos_x + NODE_W / 2, y: d.pos_y + DEPT_H / 2 });
  const centerUser = (u: OrgUser) => ({ x: u.org_x + NODE_W / 2, y: u.org_y + USER_H / 2 });
  const lines: { x1: number; y1: number; x2: number; y2: number; kind: string }[] = [];
  if (!openDept) {
    placedDepts.forEach((d) => {
      if (d.parent_id) {
        const parent = placedDepts.find((p) => p.id === d.parent_id);
        if (parent) { const a = centerDept(parent), b = centerDept(d); lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, kind: "dept" }); }
      }
    });
  } else {
    deptUsers.forEach((u) => {
      if (u.manager_id) {
        const m = deptUsers.find((x) => x.id === u.manager_id);
        if (m) { const a = centerUser(m), b = centerUser(u); lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, kind: "user" }); }
      }
    });
  }

  const openDeptRow = openDept ? depts.find((d) => d.dept_key === openDept) ?? null : null;
  const railWide = !!(selUser || (openDept && !selDept));

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

  return (
    <div className={`org ${railWide ? "is-wide" : ""}`}>
      {saveError && <div className="org-save-err" role="alert">{saveError}</div>}
      {/* time bar lives in the page header (in line with the title) via portal */}
      {toolbarReady && toolbarRef?.current ? createPortal(timebar, toolbarRef.current) : null}
      <div className="org-canvas-wrap">
        {isPast && (
          <div className="org-past-pill">
            <span className="org-past-dot" />
            Viewing {mondayOf(viewDate).slice(0, 10)} · changes here correct the past
          </div>
        )}

        {/* breadcrumb when inside a department */}
        {openDept && (
          <div className="org-crumb">
            <button onClick={() => { setOpenDept(null); setSelUserId(null); setSelDeptId(null); }}>‹ All departments</button>
            <span className="org-crumb-here" style={{ color: deptColor(openDept) }}>
              {deptIcon(openDept)} {deptLabel(openDept)}
            </span>
          </div>
        )}

        <div
          className="org-canvas"
          ref={canvasRef}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onClick={(e) => { if (e.target === e.currentTarget) { setSelDeptId(null); setSelUserId(null); } }}
        >
          {loading && <div className="org-loading">Loading…</div>}

          <div
            ref={trashRef}
            className={`org-trash ${drag.current ? "is-visible" : ""} ${overTrash ? "is-over" : ""}`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
            </svg>
            <span>Drop to remove</span>
          </div>

          {/* zoom controls */}
          <div className="org-zoom">
            <button onClick={() => setZoom((z) => Math.min(2, z * 1.15))} aria-label="Zoom in">+</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.max(0.4, z * 0.87))} aria-label="Zoom out">−</button>
            <button className="org-zoom-reset" onClick={() => { setZoom(1); setViewX(0); setViewY(0); }} aria-label="Reset view">⤢</button>
          </div>

          {/* summary legend, fills the empty lower-left */}
          {!openDept && (
            <div className="org-legend">
              <div className="org-legend-row">
                <span className="org-legend-num">{placedDepts.length}</span>
                <span className="org-legend-lbl">departments<br/>on the map</span>
              </div>
              <div className="org-legend-div" />
              <div className="org-legend-row">
                <span className="org-legend-num">{viewUsers.filter((u) => u.department).length}</span>
                <span className="org-legend-lbl">people<br/>assigned</span>
              </div>
            </div>
          )}

          {/* transformed world: everything pans and zooms together */}
          <div
            className="org-world"
            style={{ transform: `translate(${viewX}px, ${viewY}px) scale(${zoom})` }}
          >
            <svg className="org-lines">
              {lines.map((l, i) => (
                <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className={`org-line is-${l.kind}`} />
              ))}
            </svg>

            {/* COMPANY VIEW — departments only. Short click = enter, drag = move. */}
            {!openDept && placedDepts.map((d) => (
              <div
                key={d.id}
                className={`org-node org-dept ${selDeptId === d.id ? "is-sel" : ""}`}
                style={{ left: d.pos_x, top: d.pos_y, width: NODE_W, background: `linear-gradient(150deg, ${deptColor(d.dept_key)}, ${deptColor(d.dept_key)}cc)` }}
                onPointerDown={(e) => startDrag("dept", d.id, e)}
              >
                <span className="org-dept-top">
                  <span className="org-dept-icon">{deptIcon(d.dept_key)}</span>
                  <span className="org-dept-badge">Dept</span>
                  <span className="org-dept-count">{countIn(d.dept_key)}</span>
                </span>
                <span className="org-dept-name">{deptLabel(d.dept_key)}</span>
              </div>
            ))}

            {/* DEPARTMENT VIEW — users of this department */}
            {openDept && deptUsers.map((u) => (
              <div
                key={u.id}
                className={`org-node org-user ${selUserId === u.id ? "is-sel" : ""}`}
                style={{ left: u.org_x, top: u.org_y, width: NODE_W }}
                onPointerDown={(e) => startDrag("user", u.id, e)}
              >
                <span className="org-user-av">{initials(u)}</span>
                <span className="org-user-main">
                  <span className="org-user-name">{nameOf(u)}</span>
                  <span className="org-user-sub">{roleLabel(effectiveRole(u))}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* RIGHT RAIL */}
      <aside className="org-rail">
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
          />
        ) : selDept ? (
          <div className="org-info">
            <div className="org-info-head">
              <span className="org-eyebrow">Department</span>
              <button className="org-info-close" onClick={() => setSelDeptId(null)}>×</button>
            </div>
            <h3 className="org-info-title" style={{ color: deptColor(selDept.dept_key) }}>
              {deptIcon(selDept.dept_key)} {deptLabel(selDept.dept_key)}
            </h3>
            <button className="org-enter-btn" onClick={() => { setOpenDept(selDept.dept_key); setSelDeptId(null); }}>
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
                Remove from chart
              </button>
            )}
          </div>
        ) : openDept && openDeptRow ? (
          <div className="org-info">
            <div className="org-info-head">
              <span className="org-eyebrow" style={{ color: deptColor(openDept) }}>{deptIcon(openDept)} {deptLabel(openDept)}</span>
              {canManage && <button className="org-add-user" onClick={() => setShowCreate(true)}>+ New user</button>}
            </div>
            <div className="org-dept-tabs">
              <button className={deptTab === "settings" ? "is-on" : ""} onClick={() => setDeptTab("settings")}>Settings</button>
              <button className={deptTab === "people" ? "is-on" : ""} onClick={() => setDeptTab("people")}>People <i>{countIn(openDept)}</i></button>
            </div>

            {deptTab === "settings" ? (
              <>
                <div className="org-field">
                  <label>Led by department</label>
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
              </>
            ) : (
              <>
                <p className="org-palette-subhint">Drag people onto the map. Drop one on another to set who they report to.</p>
                <div className="org-palette-list">
                  {viewUsers.filter((u) => u.department === openDept).length === 0
                    ? <p className="org-empty-note">No one in this department yet.</p>
                    : viewUsers.filter((u) => u.department === openDept).map((u) => (
                      <div key={u.id}
                        className={`org-chip org-chip-user ${u.org_placed ? "is-placed" : ""}`}
                        draggable={canManage && !u.org_placed}
                        onDragStart={(e) => e.dataTransfer.setData("text/plain", `user:${u.id}`)}
                        onClick={() => { setSelUserId(u.id); }}>
                        <span className="org-chip-av">{initials(u)}</span>
                        <span className="org-chip-user-main">
                          <span>{nameOf(u)}</span>
                          <span className="org-chip-sub">{u.org_placed ? "On the map" : "Drag onto the map"}</span>
                        </span>
                      </div>
                    ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="org-palette">
            <div className="org-palette-head">
              <span className="org-eyebrow">Organization</span>
              {canManage && <button className="org-add-user" onClick={() => setShowCreate(true)}>+ New user</button>}
            </div>
                <div className="org-toggle">
                  <button className={companyTab === "depts" ? "is-on" : ""} onClick={() => setCompanyTab("depts")}>
                    Departments <i>{paletteDepts.length}</i>
                  </button>
                  <button className={companyTab === "people" ? "is-on" : ""} onClick={() => setCompanyTab("people")}>
                    People <i>{viewUsers.length}</i>
                  </button>
                </div>

                {companyTab === "depts" ? (
                  <>
                    <p className="org-palette-subhint">Drag departments onto the map. Click one to open its team.</p>
                    <div className="org-palette-list">
                      {paletteDepts.length === 0 ? <p className="org-empty-note">All departments placed.</p> : paletteDepts.map((d) => (
                        <div key={d.id} className="org-chip org-chip-dept"
                          style={{ borderLeft: `4px solid ${deptColor(d.dept_key)}` }}
                          draggable={canManage}
                          onDragStart={(e) => e.dataTransfer.setData("text/plain", `dept:${d.id}`)}>
                          <span className="org-chip-ico" style={{ background: deptColor(d.dept_key) }}>{deptIcon(d.dept_key)}</span>
                          {deptLabel(d.dept_key)}
                          <span className="org-chip-count">{countIn(d.dept_key)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="org-search">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
                      </svg>
                      <input placeholder="Search people…" value={search} onChange={(e) => setSearch(e.target.value)} />
                      {search && <button onClick={() => setSearch("")} aria-label="Clear">×</button>}
                    </div>
                    <label className="org-showall">
                      <input type="checkbox" checked={showAllPeople} onChange={(e) => setShowAllPeople(e.target.checked)} />
                      <span>Show people already assigned</span>
                    </label>
                    <p className="org-palette-subhint">Click a person to see their details. Drag one onto a department to assign them.</p>
                    <div className="org-palette-list">
                      {peopleFiltered.length === 0 ? <p className="org-empty-note">No matches.</p> : peopleFiltered.map((u) => (
                        <div key={u.id} className="org-chip org-chip-user"
                          draggable={canManage}
                          onDragStart={(e) => e.dataTransfer.setData("text/plain", `user:${u.id}`)}
                          onClick={() => { setSelUserId(u.id); setSelDeptId(null); }}>
                          <span className="org-chip-av">{initials(u)}</span>
                          <span className="org-chip-user-main">
                            <span>{nameOf(u)}</span>
                            <span className="org-chip-sub">{u.department ? deptLabel(u.department) : "Unassigned"}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
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
}: {
  user: OrgUser; depts: Dept[]; users: OrgUser[];
  canManage: boolean; canSeeSensitive: boolean;
  nameOf: (u: OrgUser) => string; initials: (u: OrgUser) => string;
  effectiveRole: (u: OrgUser) => string | null;
  onSave: (id: string, patch: Partial<OrgUser>) => void;
  onClose: () => void;
  onDelete: (id: string, name: string) => void;
}) {
  // local editable copy for text fields (saved on blur)
  const [form, setForm] = useState(user);
  useEffect(() => { setForm(user); }, [user]);
  const set = (patch: Partial<OrgUser>) => setForm((f) => ({ ...f, ...patch }));
  const commit = (patch: Partial<OrgUser>) => onSave(user.id, patch);
  const deptRoleDefault = depts.find((d) => d.dept_key === user.department)?.security_role ?? null;

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
          options={[{ value: "", label: "— None —" }, ...DEPARTMENTS.map((d) => ({ value: d.key, label: d.label }))]} />
      </div>
      <div className="org-field">
        <label>Reports to</label>
        <Select value={form.manager_id ?? ""} disabled={!canManage}
          onChange={(v) => commit({ manager_id: v || null })}
          placeholder="— No one —"
          options={[{ value: "", label: "— No one —" },
            ...users.filter((u) => u.id !== user.id).map((u) => ({ value: u.id, label: nameOf(u) }))]} />
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
        <button className="org-delete-user" onClick={() => onDelete(user.id, nameOf(user))}>
          Delete this user permanently
        </button>
      )}
    </div>
  );
}