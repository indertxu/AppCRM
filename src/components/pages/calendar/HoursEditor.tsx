/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../api/supabase";
import "./HoursEditor.css";

export interface DayHours {
  weekday: number;
  visible_from: number;
  visible_to: number;
  work_from: number;
  work_to: number;
  lunch_from: number | null;
  lunch_to: number | null;
  closed: boolean;
  /** Worked from home rather than the office. */
  remote: boolean;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first

const SNAP = 15;
const HARD_FROM = 0;        // the editor can reach midnight to midnight
const HARD_TO = 24 * 60;

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

const empty = (weekday: number): DayHours => ({
  weekday, visible_from: 480, visible_to: 1200, work_from: 540, work_to: 1080,
  lunch_from: 840, lunch_to: 900, closed: weekday === 0 || weekday === 6, remote: false,
});

type Band = "visible" | "work" | "lunch";
type Edge = "from" | "to";

export default function HoursEditor() {
  const [rows, setRows] = useState<DayHours[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ day: number; band: Band; edge: Edge } | null>(null);
  const colRefs = useRef<Record<number, HTMLDivElement | null>>({});

  /**
   * Hours are set for the company, and a department or a person can then differ from
   * that. A scope with no rows of its own simply follows the company, so most
   * of the org needs configuring once.
   */
  const [scope, setScope] = useState<"company" | "department" | "user">("company");
  const [scopeRef, setScopeRef] = useState<string | null>(null);
  const [hasOwn, setHasOwn] = useState(false);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [pickOpen, setPickOpen] = useState(false);
  const pickRef = useRef<HTMLDivElement | null>(null);
  const currentLabel = scope === "department"
    ? (scopeRef ?? "")
    : (people.find((p) => p.id === scopeRef)?.name ?? "");

  useEffect(() => {
    if (!pickOpen) return;
    const onClick = (e: MouseEvent) => {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) setPickOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setPickOpen(false); } };
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pickOpen]);

  useEffect(() => {
    supabase.from("profiles").select("id, first_name, last_name, username, email, department")
      .then(({ data }) => {
        const rs = (data ?? []) as any[];
        setPeople(rs.map((r) => ({
          id: r.id,
          name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.username || r.email || "Unnamed",
        })).sort((a, b) => a.name.localeCompare(b.name)));
        setDepartments(Array.from(new Set(rs.map((r) => r.department).filter(Boolean))).sort());
      });
  }, []);

  const loadScope = async (sc: string, ref: string | null) => {
    const { data } = await supabase.from("calendar_hours").select("*")
      .eq("scope", sc).eq("scope_ref", ref ?? "");
    const own = (data ?? []) as any[];
    setHasOwn(own.length > 0);
    if (own.length > 0) {
      const byDay: Record<number, DayHours> = {};
      own.forEach((r) => { byDay[r.weekday] = r; });
      setRows(ORDER.map((d) => byDay[d] ?? empty(d)));
      return;
    }
    // Nothing of its own: start from the company hours.
    const { data: base } = await supabase.from("calendar_hours").select("*")
      .eq("scope", "company").eq("scope_ref", "");
    const byDay: Record<number, DayHours> = {};
    ((base ?? []) as any[]).forEach((r) => { byDay[r.weekday] = r; });
    setRows(ORDER.map((d) => byDay[d] ?? empty(d)));
  };

  useEffect(() => { loadScope("company", null); }, []);

  // Loading is driven by the click, not by an effect watching the state it
  // would itself set, which is what triggered the cascading renders.
  const pickScope = (sc: "company" | "department" | "user", ref: string | null) => {
    const r = sc === "company" ? null : ref;
    setScope(sc); setScopeRef(r);
    setDirty(false); setSavedAt(null);
    loadScope(sc, r);
  };

  /** Freezing the window here is what stops the dragged edge running away. */
  const startDrag = (day: number, band: Band, edge: Edge) => {
    const open2 = rows.filter((r) => !r.closed);
    const l = open2.length ? Math.min(...open2.map((r) => r.visible_from)) : 480;
    const h = open2.length ? Math.max(...open2.map((r) => r.visible_to)) : 1200;
    setHeld({
      from: Math.max(HARD_FROM, Math.floor((l - 120) / 60) * 60),
      to: Math.min(HARD_TO, Math.ceil((h + 120) / 60) * 60),
    });
    setDrag({ day, band, edge });
  };

  const resetScope = async () => {
    await supabase.from("calendar_hours").delete()
      .eq("scope", scope).eq("scope_ref", scopeRef ?? "");
    setHasOwn(false);
    loadScope(scope, scopeRef);
  };

  const dayOf = (weekday: number) => rows.find((r) => r.weekday === weekday);
  const patch = (weekday: number, p: Partial<DayHours>) => {
    setRows((xs) => xs.map((r) => (r.weekday === weekday ? { ...r, ...p } : r)));
    setDirty(true); setSavedAt(null);
  };

  /** Turn a pointer position inside a day column into a time, snapped. */
  const [held, setHeld] = useState<{ from: number; to: number } | null>(null);
  const timeAt = (weekday: number, clientY: number, from: number, to: number) => {
    const el = colRefs.current[weekday];
    if (!el) return from;
    const box = el.getBoundingClientRect();
    const ratio = clamp((clientY - box.top) / box.height, 0, 1);
    return snap(from + ratio * (to - from));
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const d = dayOf(drag.day);
      if (!d) return;
      const t = timeAt(drag.day, e.clientY, GRID_FROM, GRID_TO);
      if (drag.band === "visible") {
        if (drag.edge === "from") {
          const v = clamp(Math.min(t, d.visible_to - 120), 0, 1200);
          patch(d.weekday, { visible_from: v, work_from: Math.max(d.work_from, v) });
        } else {
          const v = clamp(Math.max(t, d.visible_from + 120), 240, 1440);
          patch(d.weekday, { visible_to: v, work_to: Math.min(d.work_to, v) });
        }
      } else if (drag.band === "work") {
        if (drag.edge === "from") patch(d.weekday, { work_from: clamp(Math.min(t, d.work_to - 30), d.visible_from, d.visible_to) });
        else patch(d.weekday, { work_to: clamp(Math.max(t, d.work_from + 30), d.visible_from, d.visible_to) });
      } else {
        if (d.lunch_from == null || d.lunch_to == null) return;
        const lf = d.lunch_from, lt = d.lunch_to;
        if (drag.edge === "from") patch(d.weekday, { lunch_from: clamp(Math.min(t, lt - 30), d.work_from, d.work_to) });
        else patch(d.weekday, { lunch_to: clamp(Math.max(t, lf + 30), d.work_from, d.work_to) });
      }
    };
    const up = () => { setDrag(null); setHeld(null); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, rows]);

  /** The weekday most people configure first, copied over the rest. */
  const copyToAll = (from: number) => {
    const src = dayOf(from);
    if (!src) return;
    setRows((xs) => xs.map((r) => (r.closed || r.weekday === from ? r : {
      ...r,
      visible_from: src.visible_from, visible_to: src.visible_to,
      work_from: src.work_from, work_to: src.work_to,
      lunch_from: src.lunch_from, lunch_to: src.lunch_to, remote: src.remote,
    })));
    setDirty(true); setSavedAt(null);
  };

  const save = async () => {
    setSaving(true);
    const res = await supabase.from("calendar_hours").upsert(
      rows.map((r) => ({
        weekday: r.weekday, scope, scope_ref: scopeRef ?? "",
        visible_from: r.visible_from, visible_to: r.visible_to,
        work_from: r.work_from, work_to: r.work_to,
        lunch_from: r.lunch_from, lunch_to: r.lunch_to, closed: r.closed, remote: r.remote,
      })),
      { onConflict: "tenant_id,scope,scope_ref,weekday" },
    ).select();
    if (res.error) { setSaving(false); setErr(res.error.message); return; }
    setSaving(false); setDirty(false); setSavedAt(Date.now()); setHasOwn(true);
  };

  // The editor's own window follows what is configured, with an hour of slack
  // either side, so any start and finish can be dragged to.
  const open_ = rows.filter((r) => !r.closed);
  const lo = open_.length ? Math.min(...open_.map((r) => r.visible_from)) : 480;
  const hi = open_.length ? Math.max(...open_.map((r) => r.visible_to)) : 1200;
  // Two hours of slack either side, so both edges can always be dragged
  // further out without the window jumping to midnight.
  // Held still while dragging: recomputing the window from the value being
  // dragged makes the edge run away from the cursor, which is how days ended
  // up 00:00-24:00. It is state, not a ref, so the render stays pure.
  const liveFrom = Math.max(HARD_FROM, Math.floor((lo - 120) / 60) * 60);
  const liveTo = Math.min(HARD_TO, Math.ceil((hi + 120) / 60) * 60);
  const GRID_FROM = held ? held.from : liveFrom;
  const GRID_TO = held ? held.to : liveTo;
  const pct = (m: number) => ((m - GRID_FROM) / (GRID_TO - GRID_FROM)) * 100;
  const hours: number[] = [];
  const stepH = GRID_TO - GRID_FROM > 720 ? 120 : 60;
  for (let h = Math.ceil(GRID_FROM / stepH) * stepH; h <= GRID_TO; h += stepH) hours.push(h);

  /** Worked minutes for a day, lunch taken out. */
  const minsOf = (d: DayHours) => {
    if (d.closed) return 0;
    const base = d.work_to - d.work_from;
    const lunch = d.lunch_from != null && d.lunch_to != null ? d.lunch_to - d.lunch_from : 0;
    return Math.max(0, base - lunch);
  };
  const fmtH = (m: number) => {
    const h = Math.floor(m / 60), mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
  };

  return (
    <div className="hz">
      <div className="hz-top">
        <div className="hz-scope">
          <div className="hz-scope-seg">
            <button className={scope === "company" ? "is-on" : ""} onClick={() => pickScope("company", null)}>Company</button>
            <button className={scope === "department" ? "is-on" : ""} onClick={() => pickScope("department", departments[0] ?? null)}>Department</button>
            <button className={scope === "user" ? "is-on" : ""} onClick={() => pickScope("user", people[0]?.id ?? null)}>Person</button>
          </div>

          {scope !== "company" && (
            <div className="hz-pick" ref={pickRef}>
              <button type="button" className={`hz-pick-btn ${pickOpen ? "is-open" : ""}`}
                onClick={() => setPickOpen((v) => !v)}>
                <span className="hz-pick-av">{(currentLabel || "?").slice(0, 1).toUpperCase()}</span>
                <span className="hz-pick-txt">{currentLabel || (scope === "department" ? "Pick a department" : "Pick a person")}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
              </button>

              {pickOpen && (
                <div className="hz-pick-pop" role="listbox">
                  {(scope === "department"
                    ? departments.map((d) => ({ id: d, name: d }))
                    : people
                  ).map((o, i) => (
                    <button key={o.id} type="button" role="option" aria-selected={o.id === scopeRef}
                      className={`hz-pick-opt ${o.id === scopeRef ? "is-on" : ""}`}
                      style={{ animationDelay: `${i * 20}ms` }}
                      onClick={() => { pickScope(scope, o.id); setPickOpen(false); }}>
                      <span className="hz-pick-av">{(o.name || "?").slice(0, 1).toUpperCase()}</span>
                      <span>{o.name}</span>
                      {o.id === scopeRef && (
                        <svg className="hz-pick-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                      )}
                    </button>
                  ))}
                  {(scope === "department" ? departments : people).length === 0 && (
                    <p className="hz-pick-empty">
                      {scope === "department" ? "No departments set on any profile yet." : "No people yet."}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {scope !== "company" && !hasOwn && (
            <span className="hz-scope-note">Following the company hours — change any day to set its own</span>
          )}
          {scope !== "company" && hasOwn && (
            <button className="hz-scope-reset" onClick={resetScope}>Back to company hours</button>
          )}
        </div>
        <button className="hz-save" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : savedAt ? "Saved ✓" : "Save hours"}
        </button>
      </div>

      {err && <p className="hz-err">{err}</p>}

      <div className="hz-legend">
        <span><i className="is-visible" />Shown on the calendar</span>
        <span><i className="is-work" />Working hours</span>
        <span><i className="is-lunch" />Lunch</span>
        <span><i className="is-remote" />From home</span>
      </div>

      <div className="hz-grid">
        <div className="hz-scale">
          {hours.map((h) => (
            <span key={h} style={{ top: `${pct(h)}%` }}>{hhmm(h)}</span>
          ))}
        </div>

        {ORDER.map((wd) => {
          const d = dayOf(wd);
          if (!d) return null;
          const lf = d.lunch_from ?? 840, lt = d.lunch_to ?? 900;
          return (
            <div className={`hz-day ${d.closed ? "is-closed" : ""} ${d.remote ? "is-remote" : ""}`} key={wd}>
              <div className="hz-day-head">
                <b>{SHORT[wd]}</b>
                <span className="hz-head-btns">
                  {!d.closed && (
                    <button className={`hz-home ${d.remote ? "is-on" : ""}`}
                      onClick={() => patch(wd, { remote: !d.remote })}
                      title={d.remote ? "Worked from home — click for office" : "In the office — click for home"}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>
                    </button>
                  )}
                  <button className={`hz-toggle ${d.closed ? "" : "is-on"}`}
                    onClick={() => patch(wd, { closed: !d.closed })}
                    title={d.closed ? "Closed — click to open" : "Open — click to close"}>
                    <span />
                  </button>
                </span>
              </div>

              <div className="hz-col" ref={(el) => { colRefs.current[wd] = el; }}>
                {hours.map((h) => <span className="hz-line" key={h} style={{ top: `${pct(h)}%` }} />)}

                {d.closed ? (
                  <span className="hz-closed">Closed</span>
                ) : (
                  <>
                    <div className="hz-band is-visible"
                      style={{ top: `${pct(d.visible_from)}%`, height: `${pct(d.visible_to) - pct(d.visible_from)}%` }}>
                      <span className="hz-h is-top" onMouseDown={() => startDrag(wd, "visible", "from")} />
                      <span className="hz-h is-bot" onMouseDown={() => startDrag(wd, "visible", "to")} />
                    </div>

                    <div className="hz-band is-work"
                      style={{ top: `${pct(d.work_from)}%`, height: `${pct(d.work_to) - pct(d.work_from)}%` }}>
                      <span className="hz-time is-top">{hhmm(d.work_from)}</span>
                      <span className="hz-h is-top" onMouseDown={() => startDrag(wd, "work", "from")} />
                      <span className="hz-h is-bot" onMouseDown={() => startDrag(wd, "work", "to")} />
                      <span className="hz-time is-bot">{hhmm(d.work_to)}</span>
                    </div>

                    {d.lunch_from != null && d.lunch_to != null && (
                      <div className="hz-band is-lunch"
                        style={{ top: `${pct(lf)}%`, height: `${pct(lt) - pct(lf)}%` }}>
                        <span className="hz-h is-top" onMouseDown={() => startDrag(wd, "lunch", "from")} />
                        <span className="hz-h is-bot" onMouseDown={() => startDrag(wd, "lunch", "to")} />
                        <button className="hz-nolunch" title="Remove lunch break"
                          onClick={() => patch(wd, { lunch_from: null, lunch_to: null })}>×</button>
                      </div>
                    )}
                  </>
                )}
              </div>

              {!d.closed && (
                <div className="hz-foot">
                  <b className="hz-total">{fmtH(minsOf(d))}</b>
                  <div className="hz-foot-btns">
                    {d.lunch_from == null && (
                      <button className="hz-copy" onClick={() => patch(wd, { lunch_from: 840, lunch_to: 900 })}
                        title="Add a lunch break">+ Lunch</button>
                    )}
                    <button className="hz-copy" onClick={() => copyToAll(wd)} title={`Copy ${DAYS[wd]} to every open day`}>
                      Copy
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}