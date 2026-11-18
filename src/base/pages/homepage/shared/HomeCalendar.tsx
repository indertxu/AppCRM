/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home · shared column · YOUR CALENDAR
 *
 * Everyone gets it, whatever their department:
 *   - the next five days THIS PERSON works, each with a bar that fills with how
 *     much of their real time that day is booked;
 *   - or the whole month at a glance (switch at the top), each day tinted by
 *     how busy it is;
 *   - and below, what's coming up — or what's on the day you click.
 *
 * "Real time" is what Settings → Calendar says for this person, same rules as
 * the Calendar page: their own hours › their department's › the company's, per
 * weekday, minus lunch; a closed weekday is 0. Company holidays and their own
 * vacation days are 0 too and show as days off. Only when nothing at all is set
 * up does it fall back to Mon–Fri × the billing hours per day.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../../components/api/supabase";
import "./HomeShared.css";
import { mentionsToPlain } from "../../../framework/MentionInput";
import { useOutlookEvents, outlookOnDay, outlookNotLogged } from "../../../api/outlookSync";

type View = "days" | "month";
interface Item {
  id: string;
  date: string;          // YYYY-MM-DD
  start: number;         // minutes after midnight
  end: number;
  kind: "meeting" | "work" | "outlook";
  meetingKind: "teams" | "phone" | "in_person" | null;
  title: string;
  sub: string | null;
  color: string;
  href: string;
  allDay?: boolean;
  /** entries: the Outlook event they came from / were put in (not shown twice) */
  olIds?: (string | null)[];
}
const OUTLOOK_COLOR = "#8796a1";

const pad = (n: number) => String(n).padStart(2, "0");
/** Local YYYY-MM-DD (toISOString would shift the day near midnight). */
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const hours = (min: number) => { const h = min / 60; return h === 0 ? "0h" : `${+h.toFixed(1)}h`; };
const plain = (t: string | null | undefined) => mentionsToPlain(t ?? "").replace(/\s+/g, " ").trim();
const MEETING_COLOR = { teams: "#5b6ee1", phone: "#e0a43c", in_person: "#12b57f" } as const;
const MEETING_LABEL = { teams: "Teams", phone: "Call", in_person: "In person" } as const;

/**
 * The next five days this person normally works, from today. Weekdays they
 * never work (closed in their hours, or the weekend when nothing is set up) are
 * skipped; holidays and vacation stay in, shown as days off, so the week reads
 * the way it really is.
 */
function nextWorkingDays(from: Date, works: (wd: number) => boolean, n = 5): Date[] {
  const out: Date[] = [];
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let d = start, guard = 0; out.length < n && guard < 60; d = addDays(d, 1), guard++) {
    if (works(d.getDay())) out.push(d);
  }
  return out;
}
/** Monday-first weeks covering the month. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const end = addDays(last, 6 - ((last.getDay() + 6) % 7));
  const out: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

interface DayHours { weekday: number; work_from: number; work_to: number; lunch_from: number | null; lunch_to: number | null; closed: boolean }
type Hours = Record<number, DayHours>;          // by JS weekday (0 = Sunday)
interface Off { label: string; kind: "holiday" | "vacation" | "closed" }

/** Minutes of work in a day: working window minus whatever part of lunch falls inside it. */
function workMinutes(h: DayHours): number {
  if (h.closed) return 0;
  const from = Number(h.work_from), to = Number(h.work_to);
  if (!(to > from)) return 0;
  let lunch = 0;
  if (h.lunch_from != null && h.lunch_to != null) {
    lunch = Math.max(0, Math.min(to, Number(h.lunch_to)) - Math.max(from, Number(h.lunch_from)));
  }
  return to - from - lunch;
}

/** Same pick as the Calendar page: the person's own row › their department's › the company's. */
function resolveHours(rows: any[], userId: string, dept: string | null): Hours {
  const out: Hours = {};
  for (let wd = 0; wd < 7; wd++) {
    const r = rows.find((x) => x.weekday === wd && x.scope === "user" && x.scope_ref === userId)
      ?? (dept ? rows.find((x) => x.weekday === wd && x.scope === "department" && x.scope_ref === dept) : undefined)
      ?? rows.find((x) => x.weekday === wd && x.scope === "company");
    if (r) out[wd] = { weekday: wd, work_from: Number(r.work_from), work_to: Number(r.work_to), lunch_from: r.lunch_from, lunch_to: r.lunch_to, closed: !!r.closed };
  }
  return out;
}

/** Fired with today's load and the five-day totals once the calendar has its data. */
export const CAL_SUMMARY_EVENT = "home:calendar-summary";
export interface CalSummary { todayMin: number; todayCap: number; fiveBooked: number; fiveCap: number; next: { date: string; time: string; title: string; today: boolean } | null }

const VIEW_KEY = "home.calendar.view";
const readView = (): View => { try { return localStorage.getItem(VIEW_KEY) === "month" ? "month" : "days"; } catch { return "days"; } };

export default function HomeCalendar({ userId, hoursPerDay }: { userId: string; hoursPerDay: number }) {
  const nav = useNavigate();
  const today = useMemo(() => new Date(), []);
  const todayIso = isoDay(today);
  const [view, setView] = useState<View>(readView);
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [sel, setSel] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [hrs, setHrs] = useState<Hours | null>(null);        // null = still loading
  const [holidays, setHolidays] = useState<Map<string, string>>(new Map());
  const [vacation, setVacation] = useState<Set<string>>(new Set());

  const fallbackMin = Math.max(1, hoursPerDay || 8) * 60;
  const hasHours = !!hrs && Object.keys(hrs).length > 0;
  /** Normal minutes of work on a weekday (before holidays / vacation). */
  const weekdayMin = useCallback((wd: number) => {
    if (hasHours) return hrs![wd] ? workMinutes(hrs![wd]) : 0;
    return wd === 0 || wd === 6 ? 0 : fallbackMin;
  }, [hrs, hasHours, fallbackMin]);
  /** Why a day has no time in it, if it hasn't. */
  const offOn = useCallback((iso: string): Off | null => {
    const h = holidays.get(iso);
    if (h != null) return { kind: "holiday", label: h || "Holiday" };
    if (vacation.has(iso)) return { kind: "vacation", label: "Vacation" };
    if (weekdayMin(fromIso(iso).getDay()) === 0) return { kind: "closed", label: "Day off" };
    return null;
  }, [holidays, vacation, weekdayMin]);
  /** Real minutes available that day. */
  const capOn = useCallback((iso: string) => (offOn(iso) ? 0 : weekdayMin(fromIso(iso).getDay())), [offOn, weekdayMin]);

  const days = useMemo(() => {
    const works = (wd: number) => weekdayMin(wd) > 0;
    // If someone has every weekday closed, still show Mon–Fri rather than nothing.
    return [0, 1, 2, 3, 4, 5, 6].some(works) ? nextWorkingDays(today, works) : nextWorkingDays(today, (wd) => wd !== 0 && wd !== 6);
  }, [today, weekdayMin]);
  const grid = useMemo(() => monthGrid(month), [month]);

  // This person's working hours (Settings → Calendar). Doesn't depend on dates.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data: prof }, { data: rows }] = await Promise.all([
        supabase.from("profiles").select("department").eq("id", userId).maybeSingle(),
        supabase.from("calendar_hours").select("*"),
      ]);
      if (!alive) return;
      setHrs(resolveHours((rows ?? []) as any[], userId, (prof as any)?.department ?? null));
    })().catch(() => { if (alive) setHrs({}); });
    return () => { alive = false; };
  }, [userId]);

  const pickView = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };

  // One read for everything on screen: the month shown, and the weeks ahead.
  useEffect(() => {
    let alive = true;
    const from = [isoDay(grid[0]), todayIso].sort()[0];
    const to = [isoDay(grid[grid.length - 1]), isoDay(addDays(today, 40))].sort()[1];
    (async () => {
      const [{ data }, hol, vac] = await Promise.all([
        supabase.from("calendar_entries")
          .select("*")
          .eq("user_id", userId).gte("entry_date", from).lte("entry_date", to)
          .neq("status", "cancelled").order("entry_date").order("start_min").range(0, 4999),
        supabase.from("holidays").select("holiday_date, name").gte("holiday_date", from).lte("holiday_date", to),
        supabase.from("vacations").select("vacation_date").eq("user_id", userId).gte("vacation_date", from).lte("vacation_date", to),
      ]);
      if (!alive) return;
      setHolidays(new Map(((hol?.data ?? []) as any[]).map((h) => [String(h.holiday_date).slice(0, 10), h.name ?? ""])));
      setVacation(new Set(((vac?.data ?? []) as any[]).map((v) => String(v.vacation_date).slice(0, 10))));
      const rows = (data ?? []) as any[];
      const ids = (k: string) => [...new Set(rows.map((r) => r[k]).filter(Boolean))] as string[];
      const [cl, co, wt] = await Promise.all([
        ids("client_id").length ? supabase.from("clients").select("id, name").in("id", ids("client_id")) : Promise.resolve({ data: [] }),
        ids("company_id").length ? supabase.from("companies").select("id, name").in("id", ids("company_id")) : Promise.resolve({ data: [] }),
        ids("work_type_id").length ? supabase.from("work_types").select("id, name, color").in("id", ids("work_type_id")) : Promise.resolve({ data: [] }),
      ]);
      if (!alive) return;
      const name = (res: any) => new Map<string, any>(((res?.data ?? []) as any[]).map((x) => [x.id, x]));
      const clients = name(cl), companies = name(co), types = name(wt);
      setItems(rows.map((r) => {
        const start = Number(r.start_min) || 0;
        const end = Number(r.end_min) > start ? Number(r.end_min) : start + 60;
        if (r.kind === "meeting") {
          const mk = (r.meeting_kind ?? "in_person") as keyof typeof MEETING_COLOR;
          return {
            id: r.id, date: r.entry_date, start, end, kind: "meeting", meetingKind: mk,
            title: plain(r.name) || plain(r.title) || "Meeting",
            sub: companies.get(r.company_id)?.name ?? clients.get(r.client_id)?.name ?? null,
            color: MEETING_COLOR[mk] ?? MEETING_COLOR.in_person,
            href: r.tracking_id ? `/sales?tracking=${r.tracking_id}` : "/calendar",
            olIds: [r.outlook_event_id ?? null, r.outlook_source_id ?? null],
          } as Item;
        }
        const client = clients.get(r.client_id)?.name ?? null;
        const type = types.get(r.work_type_id);
        return {
          id: r.id, date: r.entry_date, start, end, kind: "work", meetingKind: null,
          title: plain(r.name) || plain(r.title) || client || type?.name || "Work",
          sub: plain(r.name) || plain(r.title) ? client ?? type?.name ?? null : client ? type?.name ?? null : null,
          color: type?.color || "#0a6f4d",
          href: "/calendar",
          olIds: [r.outlook_event_id ?? null, r.outlook_source_id ?? null],
        } as Item;
      }));
      setLoading(false);
    })().catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [userId, grid, today, todayIso]);

  // your Outlook (read only): shown in the list and on hover, not counted as booked time
  const olFrom = useMemo(() => fromIso([isoDay(grid[0]), todayIso].sort()[0]), [grid, todayIso]);
  const olTo = useMemo(() => addDays(fromIso([isoDay(grid[grid.length - 1]), isoDay(addDays(today, 40))].sort()[1]), 1), [grid, today]);
  const ol = useOutlookEvents(olFrom, olTo, !!userId);
  const olItems = useMemo<Item[]>(() => {
    const shown = outlookNotLogged(ol.events, items.map((it) => ({ date: fromIso(it.date), startMin: it.start, endMin: it.end, outlookEventId: it.olIds?.[0], outlookSourceId: it.olIds?.[1] })));
    const out: Item[] = [];
    shown.forEach((ev) => {
      const first = new Date(ev.start);
      for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate()), k = 0; k < 14 && d < olTo; d = addDays(d, 1), k++) {
        const on = outlookOnDay(ev, d);
        if (!on) { if (k > 0) break; continue; }
        const date = isoDay(d);
        out.push({
          id: `ol:${ev.id}:${date}`, date, start: on === "allday" ? -1 : on.startMin, end: on === "allday" ? -1 : on.endMin,
          kind: "outlook", meetingKind: null, title: ev.subject, sub: ["Outlook", ev.location, ev.isOrganizer ? null : ev.organizer].filter(Boolean).join(" · "),
          color: OUTLOOK_COLOR, href: `/calendar?outlook=${encodeURIComponent(ev.id)}&d=${date}`, allDay: on === "allday",
        });
      }
    });
    return out;
  }, [ol.events, items, olTo]);
  const allItems = useMemo(() => [...items, ...olItems].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start), [items, olItems]);
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    allItems.forEach((it) => { const l = m.get(it.date); if (l) l.push(it); else m.set(it.date, [it]); });
    return m;
  }, [allItems]);
  const bookedMin = (iso: string) => (byDay.get(iso) ?? []).reduce((s, it) => s + (it.kind === "outlook" ? 0 : Math.max(0, it.end - it.start)), 0);

  // Five-day summary: booked against the time this person really has.
  const fiveBooked = days.reduce((s, d) => s + bookedMin(isoDay(d)), 0);
  const fiveCap = days.reduce((s, d) => s + capOn(isoDay(d)), 0);
  const ready = !loading && hrs !== null;

  // Tell the page what today looks like (the consultancy hero shows it as its first figure).
  const todayMinV = bookedMin(todayIso);
  const todayCapV = capOn(todayIso);
  useEffect(() => {
    if (!ready) return;
    const now = new Date();
    const nowM = now.getHours() * 60 + now.getMinutes();
    const nextIt = allItems.find((it) => !it.allDay && (it.date > todayIso || (it.date === todayIso && it.end > nowM))) ?? null;
    try {
      window.dispatchEvent(new CustomEvent(CAL_SUMMARY_EVENT, { detail: {
        todayMin: todayMinV, todayCap: todayCapV, fiveBooked, fiveCap,
        next: nextIt ? { date: nextIt.date, time: hhmm(nextIt.start), title: nextIt.title, today: nextIt.date === todayIso } : null,
      } as CalSummary }));
    } catch { /* old browsers */ }
  }, [ready, todayMinV, todayCapV, fiveBooked, fiveCap, allItems, todayIso]);

  // What the list shows: the clicked day, or what's coming up from now on.
  const nowMin = today.getHours() * 60 + today.getMinutes();
  const list = useMemo(() => {
    if (sel) return [{ date: sel, items: byDay.get(sel) ?? [] }];
    const upcoming = allItems.filter((it) => it.date > todayIso || (it.date === todayIso && (it.allDay || it.end > nowMin))).slice(0, 6);
    const groups: { date: string; items: Item[] }[] = [];
    upcoming.forEach((it) => { const g = groups.find((x) => x.date === it.date); if (g) g.items.push(it); else groups.push({ date: it.date, items: [it] }); });
    return groups;
  }, [sel, byDay, allItems, todayIso, nowMin]);

  const dayName = (iso: string) => {
    const diff = Math.round((fromIso(iso).getTime() - fromIso(todayIso).getTime()) / 86400000);
    const rest = fromIso(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    if (diff === 0) return `Today · ${rest}`;
    if (diff === 1) return `Tomorrow · ${rest}`;
    return fromIso(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
  };
  const loadClass = (min: number, cap: number) =>
    cap <= 0 ? (min > 0 ? "is-over" : "") : min > cap ? "is-over" : min >= cap * 0.75 ? "is-full" : min > 0 ? "is-some" : "";
  const toggleDay = (iso: string) => setSel((cur) => (cur === iso ? null : iso));

  // The day preview: one floating card that glides from day to day while the pointer moves along the strip.
  const [peek, setPeek] = useState<{ iso: string; r: DOMRect; lo: number } | null>(null);
  const peekT = useRef<number | null>(null);
  const showPeek = (iso: string, el: HTMLElement) => {
    if (peekT.current) window.clearTimeout(peekT.current);
    const r = el.getBoundingClientRect();
    const lo = Math.max(12, (el.closest(".hs-cal")?.getBoundingClientRect().left ?? 12) - 6);  // never over the side menu
    if (peek) setPeek({ iso, r, lo });                                         // already open: glide over at once
    else peekT.current = window.setTimeout(() => setPeek({ iso, r, lo }), 180); // a short pause before it first shows
  };
  const hidePeek = (now = false) => {
    if (peekT.current) window.clearTimeout(peekT.current);
    if (now) setPeek(null); else peekT.current = window.setTimeout(() => setPeek(null), 140);
  };
  useEffect(() => {
    if (!peek) return;
    const off = () => setPeek(null);
    window.addEventListener("scroll", off, true); window.addEventListener("resize", off);
    return () => { window.removeEventListener("scroll", off, true); window.removeEventListener("resize", off); };
  }, [peek]);
  useEffect(() => () => { if (peekT.current) window.clearTimeout(peekT.current); }, []);

  return (
    <section className="hs-card hs-cal" aria-label="Your calendar">
      {/* one line: the icon, the title, the switch — no eyebrow, no booked / free summary */}
      <header className="hs-head hs-cal-head">
        <div className="hs-titles">
          <h2 className="hs-title">
            {view === "days" ? "Next 5 working days" : month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
          </h2>
        </div>
        <div className="hs-seg" role="tablist" aria-label="Calendar view" data-i={view === "days" ? 0 : 1}>
          <i className="hs-seg-pill" aria-hidden="true" />
          <button role="tab" aria-selected={view === "days"} onClick={() => pickView("days")}>5 days</button>
          <button role="tab" aria-selected={view === "month"} onClick={() => pickView("month")}>Month</button>
        </div>
      </header>

      {view === "days" ? (
        <div className="hs-days hs-wk" key="days">
          {(() => {
            const si = sel ? days.findIndex((d) => isoDay(d) === sel) : -1;
            return (
              <div className={`hs-wk-strip ${si >= 0 ? "has-sel" : ""}`} style={{ ["--si" as string]: Math.max(0, si), ["--n" as string]: days.length } as React.CSSProperties}>
                <i className="hs-wk-pill" aria-hidden="true" />
                {days.map((d, i) => {
                  const iso = isoDay(d);
                  const min = bookedMin(iso);
                  const cap = capOn(iso);
                  const off = ready ? offOn(iso) : null;
                  const pct = cap > 0 ? Math.min(100, (min / cap) * 100) : min > 0 ? 100 : 0;
                  const items = byDay.get(iso) ?? [];
                  const n = items.length;
                  const nOl = items.filter((it) => it.kind === "outlook").length;
                  const free = cap - min;
                  const tip = (off
                    ? `${off.label}${min ? ` · ${hours(min)} booked anyway` : ""}`
                    : `${hours(min)} booked of ${hours(cap)} available · ${n - nOl} ${n - nOl === 1 ? "item" : "items"}`) + (nOl ? ` · ${nOl} in Outlook` : "");
                  return (
                    <button key={iso} type="button" aria-pressed={sel === iso} aria-label={`${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}: ${tip}`}
                      className={`hs-wk-day ${loadClass(min, cap)} ${off ? `is-off is-${off.kind}` : ""} ${iso === todayIso ? "is-today" : ""} ${sel === iso ? "is-sel" : ""} ${i === 0 ? "is-first" : ""} ${i === days.length - 1 ? "is-last" : ""} ${!ready || off || pct === 0 ? "is-empty" : ""}`}
                      style={{ ["--i" as string]: i, ["--p" as string]: ready && !off ? pct : 0 } as React.CSSProperties}
                      onClick={() => { toggleDay(iso); hidePeek(true); }}
                      onMouseEnter={(e) => showPeek(iso, e.currentTarget)} onMouseLeave={() => hidePeek()}
                      onFocus={(e) => showPeek(iso, e.currentTarget)} onBlur={() => hidePeek(true)}>
                      <span className="hs-wk-clip" aria-hidden="true"><i className="hs-wk-fill" /></span>
                      <span className="hs-wk-top">
                        <span className="hs-wk-dow">{iso === todayIso ? "Today" : d.toLocaleDateString("en-GB", { weekday: "short" })}</span>
                        {n > 0 && <span className="hs-wk-n">{n}</span>}
                      </span>
                      <span className="hs-wk-num">{d.getDate()}</span>
                      {off ? (
                        <span className="hs-wk-off">{off.kind === "holiday" ? "Holiday" : off.label}</span>
                      ) : (
                        <span className="hs-wk-h">
                          {ready ? <><b>{hours(min)}</b><small>/{hours(cap)}</small></> : <small>·</small>}
                          {ready && free < 0 && <em>+{hours(-free)}</em>}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="hs-month" key="month">
          <div className="hs-month-nav">
            <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
            <button className="hs-month-today" onClick={() => { setMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setSel(todayIso); }}>Today</button>
            <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">›</button>
          </div>
          <div className="hs-month-grid">
            {["M", "T", "W", "T", "F", "S", "S"].map((w, i) => <span key={i} className="hs-month-dow">{w}</span>)}
            {grid.map((d, i) => {
              const iso = isoDay(d);
              const min = bookedMin(iso);
              const cap = capOn(iso);
              const off = ready ? offOn(iso) : null;
              const out = d.getMonth() !== month.getMonth();
              const load = cap > 0 ? Math.min(1, min / cap) : min > 0 ? 1 : 0;
              const tip = off
                ? `${off.label}${min ? ` · ${hours(min)} booked` : ""}`
                : `${min ? `${hours(min)} booked` : "Nothing booked"} of ${hours(cap)} available`;
              return (
                <button key={iso} style={{ ["--i" as string]: i, ["--load" as string]: load } as React.CSSProperties}
                  className={`hs-mday ${loadClass(min, cap)} ${out ? "is-out" : ""} ${off ? `is-off is-${off.kind}` : ""} ${iso === todayIso ? "is-today" : ""} ${sel === iso ? "is-sel" : ""}`}
                  onClick={() => toggleDay(iso)} title={tip}>
                  <span>{d.getDate()}</span>
                  {min > 0 && <i aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          <div className="hs-month-key" aria-hidden="true">
            <span><i className="k1" />Some time</span><span><i className="k2" />Busy</span><span><i className="k3" />Overbooked</span><span><i className="k4" />Off</span>
          </div>
        </div>
      )}

      {/* the month view has no "Coming up": only the day you click shows below it */}
      {(view === "days" || sel) && <div className="hs-agenda">
        <div className="hs-agenda-head">
          <span>{sel ? dayName(sel) : "Coming up"}</span>
          {sel
            ? <button className="hs-chip-x" onClick={() => setSel(null)}>Show what's next ×</button>
            : <button className="hs-link" onClick={() => nav("/calendar")}>Open calendar →</button>}
        </div>
        {sel && ready && offOn(sel) && (
          <p className={`hs-offnote is-${offOn(sel)!.kind}`}>{offOn(sel)!.kind === "closed" ? "You don't work this day." : offOn(sel)!.label}</p>
        )}
        {loading ? (
          <div className="hs-skel" />
        ) : list.every((g) => g.items.length === 0) ? (
          <p className="hs-empty">{sel ? (offOn(sel) ? "Nothing booked." : `Nothing booked — ${hours(capOn(sel))} free.`) : "Nothing booked in the next weeks."}</p>
        ) : (
          <div className={`hs-agenda-list ${sel ? "is-day" : ""}`} key={sel ?? "next"}>
            {list.map((g) => (
              <div className="hs-agenda-day" key={g.date}>
                {!sel && <span className="hs-agenda-date">{dayName(g.date)}</span>}
                {g.items.map((it, i) => (
                  <button key={it.id} className={`hs-ev is-${it.kind}`} style={{ ["--c" as string]: it.color, ["--i" as string]: i } as React.CSSProperties}
                    onClick={() => nav(it.href)}>
                    <span className="hs-ev-time">{it.allDay ? <><b>All</b><small>day</small></> : <><b>{hhmm(it.start)}</b><small>{hhmm(it.end)}</small></>}</span>
                    <span className="hs-ev-body">
                      <b>{it.title}</b>
                      {it.sub && <small>{it.sub}</small>}
                    </span>
                    <span className="hs-ev-tag">{it.kind === "outlook" ? "Outlook" : it.meetingKind ? MEETING_LABEL[it.meetingKind] : "Work"}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>}
      {peek && view === "days" && (() => {
        const iso = peek.iso;
        const its = byDay.get(iso) ?? [];
        const min = bookedMin(iso), cap = capOn(iso);
        const off = ready ? offOn(iso) : null;
        return createPortal(
          <DayPeek key="peek" r={peek.r} lo={peek.lo} iso={iso} todayIso={todayIso} items={its} min={min} cap={cap} off={off} ready={ready} />,
          document.body,
        );
      })()}
    </section>
  );
}

const KIND_ICON: Record<string, string> = {
  teams: "M15 10l5-3v10l-5-3M3 7h12v10H3z",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z",
  in_person: "M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z M12 10m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0",
  work: "M3 7h18v13H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  outlook: "M3 5h18v14H3zM3 7l9 6 9-6",
};
/** The floating card over the 5-day strip: the day, how full it is, and what's in it. */
function DayPeek({ r, lo, iso, todayIso, items, min, cap, off, ready }: {
  r: DOMRect; lo: number; iso: string; todayIso: string; items: Item[]; min: number; cap: number; off: Off | null; ready: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ax: number; up: boolean } | null>(null);
  // it glides between days only once it has been placed the first time (no flight in from off-screen)
  const [glide, setGlide] = useState(false);
  useEffect(() => { if (!pos || glide) return; const f = requestAnimationFrame(() => setGlide(true)); return () => cancelAnimationFrame(f); }, [pos, glide]);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    const cx = r.left + r.width / 2;
    const left = Math.max(lo, Math.min(vw - w - 12, cx - w / 2));
    const up = r.bottom + 12 + h > vh - 12 && r.top - 12 - h > 12;
    setPos({ left, top: up ? r.top - 12 - h : r.bottom + 12, ax: Math.max(22, Math.min(w - 22, cx - left)), up });
  }, [r, lo, iso, items.length]);
  const d = fromIso(iso);
  const pct = cap > 0 ? Math.min(100, (min / cap) * 100) : min > 0 ? 100 : 0;
  const over = cap > 0 ? min > cap : min > 0;
  const shown = items.slice(0, 5);
  const rel = iso === todayIso ? "Today" : d.toLocaleDateString("en-GB", { weekday: "long" });
  return (
    <div ref={ref} className={`hcp ${pos ? "is-in" : ""} ${glide ? "is-glide" : ""} ${pos?.up ? "is-up" : ""}`} role="tooltip"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, ["--ax" as string]: `${pos?.ax ?? 0}px` } as React.CSSProperties}>
      <i className="hcp-arrow" aria-hidden="true" />
      <div className="hcp-in" key={iso}>
        <header className="hcp-h">
          <span className="hcp-date"><b>{d.getDate()}</b><em>{d.toLocaleDateString("en-GB", { month: "short" })}</em></span>
          <span className="hcp-day"><b>{rel}</b><em>{off ? off.label : !ready ? "…" : cap > 0 ? `${hours(min)} of ${hours(cap)} booked` : `${hours(min)} booked`}</em></span>
          {!off && ready && <span className={`hcp-free ${over ? "is-over" : min >= cap * 0.75 ? "is-full" : ""}`}>{over ? `+${hours(min - cap)}` : `${hours(Math.max(0, cap - min))} free`}</span>}
        </header>
        {!off && ready && <span className={`hcp-bar ${over ? "is-over" : ""}`}><i style={{ width: `${pct}%` }} /></span>}
        {shown.length === 0 ? (
          <p className="hcp-none">
            <span aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={off ? "M12 3v2M12 19v2M5 12H3M21 12h-2M7 7 5.5 5.5M18.5 18.5 17 17M7 17l-1.5 1.5M18.5 5.5 17 7M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" : "M5 13l4 4L19 7"} /></svg></span>
            {off ? off.label : "Nothing booked yet"}
          </p>
        ) : (
          <ul className="hcp-list">
            {shown.map((it, i) => {
              const k = it.kind === "outlook" ? "outlook" : it.meetingKind ?? "work";
              return (
                <li key={it.id} className={`hcp-it is-${it.kind}`} style={{ ["--c" as string]: it.color, ["--i" as string]: i } as React.CSSProperties}>
                  <span className="hcp-t">{it.allDay ? <b>All day</b> : <><b>{hhmm(it.start)}</b><small>{hhmm(it.end)}</small></>}</span>
                  <span className="hcp-b"><b>{it.title}</b>{it.sub && <small>{it.sub}</small>}</span>
                  <span className="hcp-k" title={it.kind === "outlook" ? "Outlook" : it.meetingKind ? MEETING_LABEL[it.meetingKind] : "Work"}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={KIND_ICON[k]} /></svg>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <footer className="hcp-f">
          {items.length > shown.length ? <span>+{items.length - shown.length} more</span> : <span />}
          <em>Click the day to see it all</em>
        </footer>
      </div>
    </div>
  );
}