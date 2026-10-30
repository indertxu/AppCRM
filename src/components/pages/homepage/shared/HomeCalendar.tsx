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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../api/supabase";
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
const plain = (t: string) => mentionsToPlain(t).replace(/\s+/g, " ").trim();
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
            title: plain(r.title) || "Meeting",
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
          title: plain(r.title) || client || type?.name || "Work",
          sub: plain(r.title) ? client ?? type?.name ?? null : client ? type?.name ?? null : null,
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
  const fiveFree = Math.max(0, fiveCap - fiveBooked);
  const fivePct = fiveCap > 0 ? (fiveBooked / fiveCap) * 100 : fiveBooked > 0 ? 100 : 0;
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

  return (
    <section className="hs-card hs-cal" aria-label="Your calendar">
      <header className="hs-head">
        <div className="hs-titles">
          <span className="hs-eyebrow">Your calendar</span>
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
        <div className="hs-days" key="days">
          {days.map((d, i) => {
            const iso = isoDay(d);
            const min = bookedMin(iso);
            const cap = capOn(iso);
            const off = ready ? offOn(iso) : null;
            const pct = cap > 0 ? Math.min(100, (min / cap) * 100) : min > 0 ? 100 : 0;
            const n = (byDay.get(iso) ?? []).length;
            const nOl = (byDay.get(iso) ?? []).filter((it) => it.kind === "outlook").length;
            const free = cap - min;
            const tip = (off
              ? `${off.label}${min ? ` · ${hours(min)} booked anyway` : ""}`
              : `${hours(min)} booked of ${hours(cap)} available · ${n - nOl} ${n - nOl === 1 ? "item" : "items"}`) + (nOl ? ` · ${nOl} in Outlook` : "");
            return (
              <button key={iso} className={`hs-day ${loadClass(min, cap)} ${off ? `is-off is-${off.kind}` : ""} ${iso === todayIso ? "is-today" : ""} ${sel === iso ? "is-sel" : ""} ${n ? "has-items" : ""}`}
                style={{ ["--i" as string]: i, ["--p" as string]: ready ? pct : 0 } as React.CSSProperties}
                onClick={() => toggleDay(iso)} title={tip}>
                <span className="hs-day-dow">{iso === todayIso ? "Today" : d.toLocaleDateString("en-GB", { weekday: "short" })}</span>
                <span className="hs-day-num">{d.getDate()}</span>
                <span className="hs-day-bar" aria-hidden="true">
                  <i style={{ height: ready ? `${pct}%` : "0%" }} />
                </span>
                {off ? (
                  <>
                    <span className="hs-day-h">{min ? hours(min) : "—"}</span>
                    <span className="hs-day-n hs-day-off">{off.kind === "holiday" ? "Holiday" : off.label}</span>
                  </>
                ) : (
                  <>
                    <span className="hs-day-h">{ready ? <>{hours(min)}<small>/{hours(cap)}</small></> : "·"}</span>
                    <span className="hs-day-n">{!ready ? "" : free > 0 ? `${hours(free)} free` : free === 0 ? "full" : `+${hours(-free)} over`}</span>
                  </>
                )}
                {/* what's booked that day — revealed on hover (consultancy home) */}
                <span className="hs-day-peek" aria-hidden="true">
                  {n === 0 ? <em className="hs-peek-none">{off ? off.label : "Nothing booked"}</em> : (byDay.get(iso) ?? []).slice(0, 3).map((it) => (
                    <span key={it.id} className={`hs-peek-it ${it.kind === "outlook" ? "is-ol" : ""}`} style={{ ["--c" as string]: it.color } as React.CSSProperties}>
                      <b>{it.allDay ? "All day" : hhmm(it.start)}</b><span>{it.title}</span>
                    </span>
                  ))}
                  {n > 3 && <em className="hs-peek-more">+{n - 3} more</em>}
                </span>
              </button>
            );
          })}
          <div className="hs-days-sum">
            <span><b>{hours(fiveBooked)}</b> booked of {ready ? hours(fiveCap) : "…"} · <b className="hs-free">{ready ? hours(fiveFree) : "…"}</b> free</span>
            <span className="hs-days-track"><i style={{ width: `${ready ? Math.min(100, fivePct) : 0}%` }} /></span>
            <span className="hs-days-pct">{ready ? `${Math.round(fivePct)}%` : ""}</span>
          </div>
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
    </section>
  );
}