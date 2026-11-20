/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home · "whose figures" — each card picks its own: just you, your department, everyone, or the
 * people you choose. A small chevron in the card's head (it shows on hover) opens the choice; the
 * card then shows its numbers for those people, as far as the person's own access reaches.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../../api/supabase";
import { useInactiveIds } from "../../../framework/peopleStatus";
import "./WhoPick.css";
import { PicOr } from "../../../framework/avatars";

export type WhoMode = "me" | "dept" | "all" | "people";
export interface Who { mode: WhoMode; people?: string[] }
export const WHO_PREF = "homeWho";
export const readWho = (v: any): Who => {
  const m = v?.mode;
  if (m === "me" || m === "dept" || m === "all") return { mode: m };
  if (m === "people" && Array.isArray(v.people) && v.people.length) return { mode: "people", people: v.people.filter((x: unknown) => typeof x === "string") };
  return { mode: "all" };
};

interface Person { id: string; name: string; department: string | null }
const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((x) => x[0]).join("").slice(0, 2).toUpperCase() || "?";
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Resolves each card's choice to people: null = everyone, undefined = still reading (the department).
 * One read of the department for every card that asks for it.
 */
export function useWhoResolver(me: string | null, department: string | null, needDept: boolean): (w: Who | undefined) => string[] | null | undefined {
  const [dept, setDept] = useState<string[] | null>(null);
  useEffect(() => {
    if (!needDept || !department || dept) return;
    let alive = true;
    Promise.resolve(supabase.from("profiles").select("id").eq("department", department).range(0, 9999) as any)
      .then((r: any) => { if (alive) setDept(((r?.data ?? []) as any[]).map((x) => String(x.id))); }, () => { if (alive) setDept([]); });
    return () => { alive = false; };
  }, [needDept, department, dept]);
  return useMemo(() => (w: Who | undefined) => {
    if (!me) return undefined;
    const m = w?.mode ?? "all";
    if (m === "me") return [me];
    if (m === "people") return w?.people?.length ? w.people : [me];
    if (m === "dept") return department ? (dept === null ? undefined : Array.from(new Set([me, ...dept]))) : [me];
    return null;
  }, [me, department, dept]);
}
/** A choice as a stable key (to group the cards that show the same people). */
export const whoKeyOf = (ids: string[] | null | undefined) => (ids === undefined ? "…" : ids === null ? "*" : [...ids].sort().join(","));

/** The people a choice stands for (null = everyone). */
export function useWhoIds(who: Who, me: string | null, department: string | null): string[] | null | undefined {
  const [dept, setDept] = useState<string[] | null>(null);
  useEffect(() => {
    if (who.mode !== "dept" || !department) { setDept(null); return; }
    let alive = true;
    Promise.resolve(supabase.from("profiles").select("id").eq("department", department).range(0, 9999) as any)
      .then((r: any) => { if (alive) setDept(((r?.data ?? []) as any[]).map((x) => String(x.id))); }, () => { if (alive) setDept([]); });
    return () => { alive = false; };
  }, [who.mode, department]);
  return useMemo(() => {
    if (!me) return undefined;
    if (who.mode === "me") return [me];
    if (who.mode === "people") return who.people?.length ? who.people : [me];
    if (who.mode === "dept") return department ? (dept === null ? undefined : Array.from(new Set([me, ...dept]))) : [me];
    return null;
  }, [who, me, department, dept]);
}

export default function WhoPick({ value, onChange, me, department, deptName, reach, variant = "pill", className = "" }: {
  value: Who; onChange: (w: Who) => void; me: string; department: string | null; deptName: string | null;
  /** Whose figures this person may see at most: null = everyone, else these people. */
  reach: string[] | null;
  /** "chip": just a small chevron (in a card's head, shown on hover) */
  variant?: "pill" | "chip";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [q, setQ] = useState("");
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<string[]>(value.people ?? []);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const inactive = useInactiveIds();

  useEffect(() => {
    if (!open || people) return;
    Promise.resolve(supabase.from("profiles").select("id, first_name, last_name, email, department").range(0, 9999) as any).then((r: any) => {
      setPeople(((r?.data ?? []) as any[]).map((p) => ({ id: String(p.id), name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "—", department: p.department ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name)));
    }, () => setPeople([]));
  }, [open, people]);
  useEffect(() => {
    if (!open) return;
    const place = () => { const r = btn.current?.getBoundingClientRect(); if (r) setAt({ top: r.bottom + 10, right: Math.max(12, window.innerWidth - r.right) }); };
    place();
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("resize", place); document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  useEffect(() => { if (open) { setPicking(value.mode === "people"); setPick(value.people ?? []); setQ(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const canAll = reach === null;
  const pool = (people ?? []).filter((p) => !inactive.has(p.id) && (reach === null || reach.includes(p.id)));
  const label = value.mode === "me" ? "Just you" : value.mode === "dept" ? (deptName ? deptName : "Your department")
    : value.mode === "people" ? `${value.people?.length ?? 0} ${value.people?.length === 1 ? "person" : "people"}` : "Everyone";
  const set = (w: Who) => { onChange(w); setOpen(false); };
  const shown = q.trim() ? pool.filter((p) => norm(p.name).includes(norm(q.trim()))) : pool;
  const opt = (k: WhoMode, title: string, sub: string, on: () => void) => (
    <button type="button" role="menuitemradio" aria-checked={value.mode === k && (k !== "people" || !picking)} className={`wp-opt ${value.mode === k ? "is-on" : ""}`} onClick={on}>
      <i className="wp-radio" aria-hidden="true" />
      <span><b>{title}</b><small>{sub}</small></span>
    </button>
  );

  return (
    <>
      {variant === "chip" ? (
        <button ref={btn} type="button" className={`wc-btn ${open ? "is-open" : ""} ${value.mode !== "all" ? "is-narrow" : ""} ${className}`}
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} onPointerDown={(e) => e.stopPropagation()}
          aria-haspopup="menu" aria-expanded={open} aria-label={`Whose figures: ${label}`} title={`Whose figures: ${label}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      ) : (
      <button ref={btn} type="button" className={`wp-btn ${open ? "is-open" : ""} ${value.mode !== "all" ? "is-narrow" : ""}`} onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu" aria-expanded={open} title="Whose figures the cards show">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" />
        </svg>
        <span>{label}</span>
        <svg className="wp-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      )}
      {open && at && createPortal(
        <div ref={pop} className="wp-pop" role="menu" style={{ top: at.top, right: at.right }} onClick={(e) => e.stopPropagation()}>
          <span className="wp-h">{variant === "chip" ? "This card shows" : "Whose figures"}</span>
          {opt("me", "Just you", "Your backlog, your bills, your deals", () => set({ mode: "me" }))}
          {department && opt("dept", deptName ? `Your department · ${deptName}` : "Your department", "Everyone in it", () => set({ mode: "dept" }))}
          {canAll && opt("all", "Everyone", "The whole company", () => set({ mode: "all" }))}
          {opt("people", "Choose people…", value.mode === "people" ? `${value.people?.length ?? 0} chosen` : "Pick who to add up", () => setPicking(true))}
          {picking && (
            <div className="wp-pick">
              <input className="wp-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone…" autoFocus />
              <div className="wp-list">
                {!people ? <span className="wp-empty">Loading…</span> : shown.length === 0 ? <span className="wp-empty">Nobody by that name.</span> : shown.map((p) => {
                  const on = pick.includes(p.id);
                  return (
                    <button type="button" key={p.id} className={`wp-person ${on ? "is-on" : ""}`} onClick={() => setPick((x) => (on ? x.filter((y) => y !== p.id) : [...x, p.id]))}>
                      <i className="wp-av" aria-hidden="true"><PicOr id={p.id}>{initials(p.name)}</PicOr></i>
                      <span className="wp-name">{p.name}{p.id === me ? <em> · you</em> : null}</span>
                      <i className="wp-check" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
              <div className="wp-foot">
                <span>{pick.length ? `${pick.length} chosen` : "Nobody chosen yet"}</span>
                <button type="button" className="wp-done" disabled={!pick.length} onClick={() => set({ mode: "people", people: pick })}>Show them</button>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
