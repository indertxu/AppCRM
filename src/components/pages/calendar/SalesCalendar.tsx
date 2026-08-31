/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import {
  loadSalesMeetings, loadMyDeals, createSalesMeeting, deleteSalesMeeting, updateSalesMeeting,
  loadSalesBlocks, createSalesBlock, deleteSalesBlock, loadMyLinks,
  dealsForCompany, contactsOfCompany, loadMeetingDetail, saveMeetingEdit,
  type SalesBlock,
  type SalesMeeting, type MeetingKind,
} from "./salesCalendarApi";
import InvitesTray from "./InvitesTray";
import CalendarSettingsModal from "./CalendarSettingsModal";
import { loadMyInvites, inviteToEntry, busyAt, type InviteCard } from "./invitesApi";
import "./SalesCalendar.css";

const DOW = ["MON", "TUE", "WED", "THU", "FRI"];
const KINDS: { id: MeetingKind; label: string; icon: string }[] = [
  { id: "teams", label: "Teams", icon: "M15 10l4.5-2.6v9.2L15 14M4 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" },
  { id: "phone", label: "Phone", icon: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" },
  { id: "in_person", label: "In person", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" },
];

const startOfWeek = (d: Date) => {
  const x = new Date(d);
  const day = x.getDay();
  x.setDate(x.getDate() - (day === 0 ? 6 : day - 1));
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const sameDay = (a: Date, b: Date) => isoOf(a) === isoOf(b);
const fmtHour = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
const lasts = (mins: number) =>
  mins < 60 ? `${mins}m` : mins % 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins / 60}h`;

const hhmm = (d: Date) => {
  // A bad date used to print NaN:NaN straight onto the calendar.
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Minutes a meeting lasts, never NaN and never zero. */
const durOf = (m: { duration_min?: number | null }) => {
  const n = Number(m?.duration_min);
  return Number.isFinite(n) && n > 0 ? n : 60;
};

/** Fallback until the configured hours arrive. */
const DEFAULT_START = 8 * 60;
const DEFAULT_END = 20 * 60;

interface DayHours {
  weekday: number;
  visible_from: number; visible_to: number;
  work_from: number; work_to: number;
  lunch_from: number | null; lunch_to: number | null;
  closed: boolean;
  remote: boolean;
}

/** A dropdown that matches the app instead of the browser's own. */
function Picker({ value, options, onChange, placeholder }: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const current = options.find((o) => o.id === value);
  return (
    <div className="sc-pick" ref={ref}>
      <button type="button" className={`sc-pick-btn ${open ? "is-open" : ""}`} onClick={() => setOpen((v) => !v)}>
        <span>{current?.label ?? placeholder ?? "Choose"}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      {open && (
        <div className="sc-pick-pop" role="listbox">
          {options.length === 0 && <p className="sc-pick-empty">Nothing to pick</p>}
          {options.map((o, i) => (
            <button key={o.id} type="button" role="option" aria-selected={o.id === value}
              className={`sc-pick-opt ${o.id === value ? "is-on" : ""}`}
              style={{ animationDelay: `${i * 18}ms` }}
              onClick={() => { onChange(o.id); setOpen(false); }}>
              {o.label}
              {o.id === value && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Picking people the way a mail client does: those already chosen sit as chips,
 * and a search field drops a short list underneath. Beats two long lists cut
 * off at the top and bottom fighting for room.
 */
function PeoplePicker({ options, value, onChange, placeholder }: {
  options: { id: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ(""); }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const chosen = options.filter((o) => value.includes(o.id));
  const needle = q.trim().toLowerCase();
  const rest = options.filter((o) => !value.includes(o.id) && (!needle || o.label.toLowerCase().includes(needle)));

  return (
    <div className="pp" ref={ref}>
      <div className={`pp-box ${open ? "is-open" : ""}`} onClick={() => setOpen(true)}>
        {chosen.map((c) => (
          <span className="pp-chip" key={c.id}>
            <i>{c.label.charAt(0).toUpperCase()}</i>
            {c.label.split(" · ")[0]}
            <button type="button" onClick={(e) => { e.stopPropagation(); onChange(value.filter((v) => v !== c.id)); }}
              aria-label={`Remove ${c.label}`}>×</button>
          </span>
        ))}
        <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={chosen.length ? "" : placeholder} />
      </div>

      {open && rest.length > 0 && (
        <div className="pp-pop">
          {rest.slice(0, 6).map((o, i) => (
            <button key={o.id} type="button" className="pp-opt"
              style={{ animationDelay: `${i * 18}ms` }}
              onClick={() => { onChange([...value, o.id]); setQ(""); }}>
              <i>{o.label.charAt(0).toUpperCase()}</i>
              <span>{o.label}</span>
            </button>
          ))}
          {rest.length > 6 && <p className="pp-more">{rest.length - 6} more — keep typing</p>}
        </div>
      )}
    </div>
  );
}

/**
 * A time you can type or pick.
 *
 * Two boxes, hours and minutes: typing two digits moves you on to the next
 * without reaching for the mouse, and each box also drops a list for when it
 * is quicker to choose than to type.
 */
function TimeBox({ mins, onChange, hours }: {
  mins: number;
  onChange: (m: number) => void;
  hours: number[];
}) {
  const [open, setOpen] = useState<"h" | "m" | null>(null);
  const [draft, setDraft] = useState<{ part: "h" | "m"; text: string } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const minRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(null); } };
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const h = Math.floor(mins / 60);
  const m = mins % 60;
  // The list offers the configured hours, but any hour of the day can be
  // typed: clamping to the grid turned 20:30 into 06:30.

  const shown = (part: "h" | "m") =>
    draft?.part === part ? draft.text : String(part === "h" ? h : m).padStart(2, "0");

  /**
   * Digits are collected here rather than read back off the input: setting the
   * value moves the caret to the front, so the second keystroke landed before
   * the first and 20 came out as 02.
   */
  const press = (part: "h" | "m", key: string) => {
    // Read through the updater: the handler closes over the draft from the
    // render it was made in, so the second keystroke saw an empty one and 20
    // collapsed back to 0.
    setDraft((cur) => {
      const sofar = cur?.part === part ? cur.text : "";
      const digits = (sofar + key).slice(-2);
      if (digits.length < 2) return { part, text: digits };

      const n = Number(digits);
      if (part === "h") {
        onChange(Math.min(23, n) * 60 + m);
        // Two digits in and the minutes are what you want next.
        window.setTimeout(() => { minRef.current?.focus(); minRef.current?.select(); }, 0);
      } else {
        onChange(h * 60 + Math.min(59, n));
      }
      return null;
    });
  };

  /** Whatever half-typed value is left when the box loses focus. */
  const settle = (part: "h" | "m") => {
    if (draft?.part !== part) return;
    const n = Number(draft.text);
    if (draft.text && !Number.isNaN(n)) {
      if (part === "h") onChange(Math.min(23, n) * 60 + m);
      else onChange(h * 60 + Math.min(59, n));
    }
    setDraft(null);
  };

  return (
    <div className="tb" ref={ref}>
      <div className="tb-part">
        <input className="tb-in" inputMode="numeric" maxLength={2}
          value={shown("h")}
          onFocus={(e) => { e.target.select(); setOpen("h"); }}
          onKeyDown={(e) => {
            if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press("h", e.key); }
            else if (e.key === "Backspace") { e.preventDefault(); setDraft({ part: "h", text: "" }); }
          }}
          onChange={() => {}}
          onBlur={() => settle("h")}
          aria-label="Hour" />
        {open === "h" && (
          <div className="tb-pop">
            {Array.from({ length: 24 }, (_, x) => x).map((x) => (
              <button key={x} type="button"
                className={`${x === h ? "is-on" : ""} ${hours.includes(x) ? "" : "is-off"}`}
                onClick={() => { onChange(x * 60 + m); setOpen(null); }}>
                {String(x).padStart(2, "0")}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="tb-colon">:</span>

      <div className="tb-part">
        <input className="tb-in" inputMode="numeric" maxLength={2} ref={minRef}
          value={shown("m")}
          onFocus={(e) => { e.target.select(); setOpen("m"); }}
          onKeyDown={(e) => {
            if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press("m", e.key); }
            else if (e.key === "Backspace") { e.preventDefault(); setDraft({ part: "m", text: "" }); }
          }}
          onChange={() => {}}
          onBlur={() => settle("m")}
          aria-label="Minutes" />
        {open === "m" && (
          <div className="tb-pop">
            {[0, 15, 30, 45].map((x) => (
              <button key={x} type="button" className={x === m ? "is-on" : ""}
                onClick={() => { onChange(h * 60 + x); setOpen(null); }}>
                {String(x).padStart(2, "0")}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SalesCalendar() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const myId = session?.user?.id ?? "";

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));

  /**
   * Other people's weeks, laid over your own. Same rules as the consultancy
   * calendar: anyone can look someone up, and how much of it they read depends
   * on where they sit.
   */
  const [alsoView, setAlsoView] = useState<string[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string; role: string; department: string }[]>([]);
  const [canSeeDetail, setCanSeeDetail] = useState(false);
  const [detailDept, setDetailDept] = useState<string | null>(null);
  const [whoOpen, setWhoOpen] = useState(false);
  const whoRef = useRef<HTMLDivElement | null>(null);

  const seenIds = useMemo(() => [myId, ...alsoView].filter(Boolean), [myId, alsoView]);
  const seenKey = seenIds.join(",");
  const viewingOther = alsoView.length > 0;
  const OVERLAY = ["#12b57f", "#5b8def", "#d98324", "#a259d9"];
  const colourOf = (uid: string) => OVERLAY[Math.max(0, seenIds.indexOf(uid))] ?? OVERLAY[0];
  const nameOf = (uid: string) => people.find((p) => p.id === uid)?.name ?? "";
  const toggleView = (uid: string) => {
    if (uid === myId) return;
    setAlsoView((xs) => xs.includes(uid) ? xs.filter((x) => x !== uid)
      : xs.length >= 3 ? xs : [...xs, uid]);
  };

  /** Yours reads in full; someone else's only where you are allowed. */
  const opaque = (uid: string) => {
    if (uid === myId) return false;
    if (canSeeDetail && !detailDept) return false;
    if (canSeeDetail && detailDept) {
      return (people.find((x) => x.id === uid)?.department ?? "") !== detailDept;
    }
    return true;
  };

  useEffect(() => {
    if (!myId) return;
    (async () => {
      const { data: me } = await supabase.from("profiles")
        .select("role, department, is_superadmin").eq("id", myId).maybeSingle();
      const r = (me as any)?.role ?? "";
      const boss = (me as any)?.is_superadmin === true || r === "boss";
      const manager = ["consultancy_manager", "sales_manager", "customer_success_manager"].includes(r);
      setCanSeeDetail(boss || manager);
      if (manager && !boss) setDetailDept((me as any)?.department ?? null);

      const { data } = await supabase.from("profiles")
        .select("id, first_name, last_name, username, email, role, department");
      setPeople(((data ?? []) as any[]).map((x) => ({
        id: x.id,
        name: [x.first_name, x.last_name].filter(Boolean).join(" ") || x.username || x.email || "Unnamed",
        role: x.role ?? "", department: x.department ?? "",
      })).sort((a, b) => a.name.localeCompare(b.name)));
    })();
  }, [myId]);

  useEffect(() => {
    if (!whoOpen) return;
    const onClick = (e: MouseEvent) => {
      if (whoRef.current && !whoRef.current.contains(e.target as Node)) setWhoOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setWhoOpen(false); };
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [whoOpen]);
  const [meetings, setMeetings] = useState<SalesMeeting[]>([]);
  const [deals, setDeals] = useState<{ id: string; label: string; phase_id: string | null }[]>([]);
  const [blocks, setBlocks] = useState<SalesBlock[]>([]);
  /** Invitations waiting on this person, whatever kind of event they are. */
  const [invites, setInvites] = useState<InviteCard[]>([]);
  const [trayOpen, setTrayOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!trayOpen) return;
    const onClick = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setTrayOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTrayOpen(false); };
    const id = window.setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [trayOpen]);
  const [showSettings, setShowSettings] = useState(false);
  const [vacAllowance, setVacAllowance] = useState(22);
  useEffect(() => {
    supabase.from("tenant_settings").select("vacation_allowance").maybeSingle()
      .then(({ data }) => { if (data) setVacAllowance(Number((data as any).vacation_allowance) || 22); })
      .catch(() => {});
  }, []);
  const [links, setLinks] = useState<{ companies: { id: string; label: string }[]; contacts: { id: string; label: string }[] }>({ companies: [], contacts: [] });
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<{ day: Date; hour: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; grab: number } | null>(null);
  const [editing, setEditing] = useState<SalesMeeting | null>(null);
  /** Which block is one click away from being removed. */
  const [killing, setKilling] = useState<string | null>(null);

  /**
   * The same working hours the consultancy calendar uses: whatever is set for
   * this person, their department, or the company, in that order.
   */
  const [hoursByDay, setHoursByDay] = useState<Record<number, DayHours>>({});
  useEffect(() => {
    if (!myId) return;
    (async () => {
      const { data: prof } = await supabase.from("profiles")
        .select("department").eq("id", myId).maybeSingle();
      const dept = (prof as any)?.department ?? null;
      const { data } = await supabase.from("calendar_hours").select("*");
      const all = (data ?? []) as any[];
      const pick = (wd: number) =>
        all.find((r) => r.weekday === wd && r.scope === "user" && r.scope_ref === myId)
        ?? (dept ? all.find((r) => r.weekday === wd && r.scope === "department" && r.scope_ref === dept) : undefined)
        ?? all.find((r) => r.weekday === wd && r.scope === "company");
      const out: Record<number, DayHours> = {};
      for (let wd = 0; wd < 7; wd++) { const r = pick(wd); if (r) out[wd] = r as DayHours; }
      setHoursByDay(out);
    })();
  }, [myId]);

  const { DAY_START, DAY_END, SPAN, HOURS } = useMemo(() => {
    const open = Object.values(hoursByDay).filter((d) => !d.closed);
    const from = open.length ? Math.min(...open.map((d) => d.visible_from)) : DEFAULT_START;
    const to = open.length ? Math.max(...open.map((d) => d.visible_to)) : DEFAULT_END;
    const s = Math.floor(from / 60) * 60;
    const e = Math.ceil(to / 60) * 60;
    const hrs: number[] = [];
    for (let h = s / 60; h < e / 60; h++) hrs.push(h);
    return { DAY_START: s, DAY_END: e, SPAN: Math.max(60, e - s), HOURS: hrs };
  }, [hoursByDay]);
  const colRefs = useRef<Record<string, HTMLDivElement | null>>({});

  /** Dropping a meeting on a new slot moves it; the deal keeps it either way. */
  useEffect(() => {
    if (!drag) return;
    const up = () => setDrag(null);
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, [drag]);

  const dropOn = async (day: Date, clientY: number) => {
    if (!drag) return;
    const el = colRefs.current[isoOf(day)];
    if (!el) return;
    const box = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - box.top) / box.height));
    const mins = Math.round((DAY_START + ratio * SPAN - drag.grab) / 15) * 15;
    const at = new Date(day);
    at.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    setDrag(null);
    await updateSalesMeeting(drag.id, { meet_at: at.toISOString() });
    load();
  };

  const days = useMemo(() => Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const today = new Date();

  const load = async () => {
    if (!myId) return;
    setLoading(true);
    const [ms, ds, bs, lk] = await Promise.all([
      loadSalesMeetings(seenIds, isoOf(weekStart), isoOf(addDays(weekStart, 6))).catch(() => []),
      loadMyDeals([myId]).catch(() => []),
      loadSalesBlocks(seenIds, isoOf(weekStart), isoOf(addDays(weekStart, 6))).catch(() => []),
      loadMyLinks(myId).catch(() => ({ companies: [], contacts: [] })),
    ]);
    setMeetings(ms);
    setDeals(ds);
    setBlocks(bs);
    setLinks(lk);
    loadMyInvites(myId).then(setInvites).catch(() => {});
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [seenKey, weekStart.getTime()]);

  /**
   * Meetings that overlap share the width instead of covering each other.
   * Each one gets a lane; the lane count is however many run at once.
   */
  /** Everything on a day, meetings and blocks together, each in its own lane. */
  const dayLanes = (d: Date) => {
    const many = seenIds.length > 1;
    const raw = [
      ...meetings.filter((m) => sameDay(new Date(m.meet_at), d)).map((m) => {
        const at = new Date(m.meet_at);
        const from = at.getHours() * 60 + at.getMinutes();
        return { id: m.id, uid: m.assignee_id ?? myId, from, to: from + durOf(m), m, b: null as any };
      }),
      ...blocks.filter((b) => b.entry_date === isoOf(d))
        .map((b) => ({ id: b.id, uid: b.user_id ?? myId, from: b.start_min, to: b.end_min, m: null as any, b })),
    ].sort((a, b2) => a.from - b2.from || a.to - b2.to);

    if (many) {
      // One column per person who has something today, and their own clashes
      // merged into a single Busy block.
      const present = seenIds.filter((uid) => raw.some((x) => x.uid === uid));
      const slice = 100 / Math.max(1, present.length);
      const out: any[] = [];
      present.forEach((uid, col) => {
        const mine = raw.filter((x) => x.uid === uid);
        let run: any[] = [];
        const flush = () => {
          if (!run.length) return;
          out.push({
            ...run[0],
            from: Math.min(...run.map((r) => r.from)),
            to: Math.max(...run.map((r) => r.to)),
            left: col * slice, width: slice, lane: 0, merged: run.length,
          });
          run = [];
        };
        mine.forEach((x) => {
          if (run.length && x.from < Math.max(...run.map((r) => r.to))) run.push(x);
          else { flush(); run = [x]; }
        });
        flush();
      });
      return out;
    }

    const items = raw;
    const free: number[] = [];
    const placed = items.map((x) => {
      let lane = free.findIndex((end) => end <= x.from);
      if (lane === -1) { lane = free.length; free.push(x.to); } else { free[lane] = x.to; }
      return { ...x, lane };
    });
    return placed.map((x, _i, all) => {
      const lanes = all.filter((o) => o.from < x.to && o.to > x.from)
                       .reduce((n, o) => Math.max(n, o.lane + 1), 1);
      return { ...x, lanes, left: (x.lane / lanes) * 100, width: 100 / lanes, merged: 1 };
    });
  };
  const dayBlocks = (d: Date) => dayLanes(d).filter((x: any) => x.b);

  const weekCount = meetings.length;
  const byKind = KINDS.map((k) => ({ ...k, n: meetings.filter((m) => m.kind === k.id).length }));

  return (
    <div className="sc">
      <header className="sc-bar">
        <div className="sc-bar-left">
          <button className="sc-home" onClick={() => navigate("/home")} aria-label="Back">‹</button>
          <h1 className="sc-title">Calendar</h1>
          <span className="sc-badge">Sales</span>

          {people.length > 1 && (
            <div className="cal-who" ref={whoRef}>
              <button type="button" className={`cal-who-btn ${whoOpen ? "is-open" : ""}`}
                onClick={() => setWhoOpen((v) => !v)} aria-expanded={whoOpen}>
                <span className="cal-who-stack">
                  {seenIds.slice(0, 4).map((uid, i) => (
                    <i key={uid} style={{ background: colourOf(uid), zIndex: 4 - i }}>
                      {(uid === myId ? "You" : nameOf(uid) || "?").slice(0, 1).toUpperCase()}
                    </i>
                  ))}
                </span>
                <span className="cal-who-txt">
                  <b>{alsoView.length === 0 ? "My calendar" : `You + ${alsoView.length}`}</b>
                  {viewingOther && <em>{alsoView.length + 1} calendars</em>}
                </span>
                <svg className="cal-who-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
              </button>

              {whoOpen && (
                <div className="cal-who-pop" role="listbox" aria-multiselectable="true">
                  <p className="cal-who-hint">Lay up to three colleagues over your week</p>
                  {people.map((pp, i) => {
                    const on = seenIds.includes(pp.id);
                    const full = !on && alsoView.length >= 3 && pp.id !== myId;
                    return (
                      <button key={pp.id} type="button" role="option" aria-selected={on}
                        className={`cal-who-opt ${on ? "is-on" : ""} ${full ? "is-full" : ""}`}
                        style={{ animationDelay: `${i * 22}ms` }}
                        disabled={full}
                        onClick={() => toggleView(pp.id)}>
                        <span className="cal-who-opt-av"
                          style={on ? { background: colourOf(pp.id), color: "#fff" } : undefined}>
                          {(pp.name || "?").slice(0, 1).toUpperCase()}
                        </span>
                        <span className="cal-who-opt-txt">
                          <b>{pp.id === myId ? `${pp.name} (you)` : pp.name}</b>
                          <em>{pp.id === myId ? "always shown" : pp.role.replace(/_/g, " ")}</em>
                        </span>
                        {on && (
                          <svg className="cal-who-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="sc-week-bar">
          <span className="sc-wk-main">
            <b>{weekCount}</b>
            <span>{weekCount === 1 ? "meeting" : "meetings"} this week</span>
          </span>
          <span className="sc-wk-kinds">
            {byKind.filter((k) => k.n > 0).map((k) => (
              <span key={k.id} className={`sc-wk-kind is-${k.id}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={k.icon} /></svg>
                {k.n}
              </span>
            ))}
          </span>
        </div>

        <div className="sc-nav">
          <button onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">‹</button>
          <button className="sc-nav-label" onClick={() => setWeekStart(startOfWeek(new Date()))}>
            {weekStart.toLocaleDateString(undefined, { day: "numeric", month: "short" })}
            {" – "}
            {addDays(weekStart, 4).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
          </button>
          <button onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">›</button>

          <div className="cal-bell-wrap" ref={bellRef}>
          <button className="cal-bell" onClick={() => setTrayOpen((v) => !v)}
            aria-label={`${invites.length} invitations`} title="Invitations">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>
            {invites.length > 0 && <span className="cal-bell-dot">{invites.length}</span>}
          </button>
          {trayOpen && (
            <InvitesTray invites={invites} userId={myId}
              unit={() => "d"}
              onChanged={() => { load(); }}
              onClose={() => setTrayOpen(false)} />
          )}
        </div>

          <button className="sc-gear" onClick={() => setShowSettings(true)}
            aria-label="Calendar settings" title="Calendar settings">⚙</button>
        </div>
      </header>

      <div className="sc-grid" style={{ ["--sc-h" as string]: `${HOURS.length * 62}px` }}>
        <div className="sc-corner" />

        <div className="sc-head-days">
          {days.map((d, i) => (
            <div className={`sc-head-day ${sameDay(d, today) ? "is-today" : ""}`} key={isoOf(d)}>
              <span className="sc-dow">
                {DOW[i]}
                {hoursByDay[d.getDay()]?.remote && (
                  <svg className="sc-home-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>
                  </svg>
                )}
              </span>
              <span className="sc-date">{d.getDate()}</span>
            </div>
          ))}
        </div>

        <div className="sc-times">
          {HOURS.map((h) => (
            <div className="sc-time" key={h}>
              <span>{fmtHour(h)}</span>
            </div>
          ))}
        </div>

        <div className="sc-days">
          {days.map((d) => (
            <div className={`sc-col ${sameDay(d, today) ? "is-today" : ""} ${drag ? "is-dropping" : ""} ${hoursByDay[d.getDay()]?.remote ? "is-remote" : ""}`}
              key={isoOf(d)}
              ref={(el) => { colRefs.current[isoOf(d)] = el; }}
              onMouseUp={(e) => dropOn(d, e.clientY)}>
              {(() => {
                const hd = hoursByDay[d.getDay()];
                if (!hd) return null;
                const pc = (m: number) => ((m - DAY_START) / SPAN) * 100;
                if (hd.closed) return <span className="sc-off is-closed" style={{ top: 0, height: "100%" }} />;
                return (
                  <>
                    {hd.work_from > DAY_START && (
                      <span className="sc-off" style={{ top: 0, height: `${pc(hd.work_from)}%` }} />
                    )}
                    {hd.work_to < DAY_END && (
                      <span className="sc-off" style={{ top: `${pc(hd.work_to)}%`, height: `${100 - pc(hd.work_to)}%` }} />
                    )}
                    {hd.lunch_from != null && hd.lunch_to != null && (
                      <span className="sc-lunch"
                        style={{ top: `${pc(hd.lunch_from)}%`, height: `${pc(hd.lunch_to) - pc(hd.lunch_from)}%` }} />
                    )}
                  </>
                );
              })()}

              {HOURS.map((h) => (
                <button className="sc-slot" key={h}
                  onClick={() => setDraft({ day: d, hour: h })}
                  aria-label={`Book a meeting at ${fmtHour(h)}`} />
              ))}

              {dayBlocks(d).map(({ b, left, width, merged }: any) => {
                const top = ((b.start_min - DAY_START) / SPAN) * 100;
                const h = ((b.end_min - b.start_min) / SPAN) * 100;
                return (
                  <div className={`sc-ev ${b.invite_id ? "is-invited" : "is-work"} ${opaque(b.user_id ?? myId) || merged > 1 ? "is-opaque" : ""}`} key={b.id}
                    style={{
                      top: `${Math.max(0, top)}%`, height: `${Math.max(3.5, h)}%`,
                      left: `calc(${left}% + 3px)`,
                      width: `calc(${width}% - 6px)`,
                      zIndex: 1,
                      ...(viewingOther ? {
                        borderLeftColor: colourOf(b.user_id ?? myId),
                        background: `color-mix(in srgb, ${colourOf(b.user_id ?? myId)} 14%, #fff)`,
                      } : null),
                    }}
                    title={opaque(b.user_id ?? myId) || merged > 1
                      ? `${nameOf(b.user_id ?? myId)} · busy`
                      : (b.notes ?? b.title)}>
                    <span className="sc-ev-top">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
                      <b>{merged > 1 ? `Busy · ${merged}` : opaque(b.user_id ?? myId) ? "Busy" : (b.title || (b.invite_id ? "Invited" : "Work"))}</b>
                      <em>{String(Math.floor(b.start_min / 60)).padStart(2, "0")}:{String(b.start_min % 60).padStart(2, "0")}</em>
                    </span>
                    {(b.company_name || b.contact_name || b.notes) && (
                      <span className="sc-ev-title">
                        {b.company_name ?? b.contact_name ?? b.notes}
                      </span>
                    )}
                    {!opaque(b.user_id ?? myId) && merged === 1 && (
                    <span className="sc-ev-acts">
                      <button className={`sc-ev-del ${killing === b.id ? "is-armed" : ""}`}
                        title={killing === b.id ? "Click again to remove" : "Remove"}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (killing !== b.id) {
                            setKilling(b.id);
                            window.setTimeout(() => setKilling((k) => (k === b.id ? null : k)), 3000);
                            return;
                          }
                          setKilling(null);
                          deleteSalesBlock(b.id).then(load);
                        }}
                        aria-label="Remove">
                        {killing === b.id ? "Sure?" : (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
                        )}
                      </button>
                    </span>
                    )}
                  </div>
                );
              })}

              {dayLanes(d).filter((x: any) => x.m).map(({ m, left, width, merged }: any) => {
                const at = new Date(m.meet_at);
                const mins = at.getHours() * 60 + at.getMinutes();
                const top = ((mins - DAY_START) / SPAN) * 100;
                const kind = KINDS.find((k) => k.id === m.kind) ?? KINDS[2];
                return (
                  <div className={`sc-ev is-${m.kind} ${m.status === "won" ? "is-won" : m.status === "lost" ? "is-lost" : ""} ${opaque(m.assignee_id ?? myId) || merged > 1 ? "is-opaque" : ""}`}
                    key={m.id}
                    style={{
                      top: `${Math.max(0, top)}%`,
                      height: `${Math.max(3.5, (durOf(m) / SPAN) * 100)}%`,
                      left: `calc(${left}% + 3px)`,
                      width: `calc(${width}% - 6px)`,
                      zIndex: 2,
                      ...(viewingOther ? {
                        borderLeftColor: colourOf(m.assignee_id ?? myId),
                        background: `color-mix(in srgb, ${colourOf(m.assignee_id ?? myId)} 14%, #fff)`,
                      } : null),
                    }}
                    onMouseDown={(e) => {
                      if ((e.target as HTMLElement).closest(".sc-ev-acts")) return;
                      if (opaque(m.assignee_id ?? myId) || merged > 1) return;
                      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const grabbed = ((e.clientY - box.top) / box.height) * durOf(m);
                      setDrag({ id: m.id, grab: grabbed });
                    }}
                    onClick={(e) => {
                      // A drag should not also open the editor.
                      if (drag) { e.preventDefault(); return; }
                      if (opaque(m.assignee_id ?? myId) || merged > 1) return;
                      setEditing(m);
                    }}
                    title={opaque(m.assignee_id ?? myId) || merged > 1
                      ? `${nameOf(m.assignee_id ?? myId)} · busy`
                      : [m.company_name, m.title, m.notes].filter(Boolean).join(" · ")}>
                    <span className="sc-ev-top">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={kind.icon} /></svg>
                      <b>{merged > 1 ? `Busy · ${merged}` : opaque(m.assignee_id ?? myId) ? "Busy" : m.company_name}</b>
                      <em>{hhmm(at)}–{hhmm(new Date(at.getTime() + durOf(m) * 60000))}</em>
                    </span>
                    {merged === 1 && !opaque(m.assignee_id ?? myId) && <span className="sc-ev-title">{m.title}</span>}
                    {merged === 1 && !opaque(m.assignee_id ?? myId) && m.notes && <span className="sc-ev-note">{m.notes}</span>}
                    {!opaque(m.assignee_id ?? myId) && merged === 1 && (
                    <span className="sc-ev-acts">
                      <button title="Edit"
                        onClick={(e) => { e.stopPropagation(); setEditing(m); }}
                        aria-label="Edit meeting">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                      </button>
                      {m.tracking_id && (
                        <button title="Open the deal"
                          onClick={(e) => { e.stopPropagation(); navigate(`/sales?tracking=${m.tracking_id}`); }}
                          aria-label="Open the deal">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>
                        </button>
                      )}
                      <button className={`sc-ev-del ${killing === m.id ? "is-armed" : ""}`}
                        title={killing === m.id ? "Click again to remove" : "Remove"}
                        onClick={(e) => {
                          e.stopPropagation();
                          // Two taps to delete: the first arms it, the second does it.
                          if (killing !== m.id) {
                            setKilling(m.id);
                            window.setTimeout(() => setKilling((k) => (k === m.id ? null : k)), 3000);
                            return;
                          }
                          setKilling(null);
                          deleteSalesMeeting(m.id).then(load);
                        }}
                        aria-label="Remove meeting">
                        {killing === m.id ? "Sure?" : (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
                        )}
                      </button>
                    </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {loading && <p className="sc-loading">Loading…</p>}

      {showSettings && (
        // A rep only gets the time-off tab; targets, cutoffs and work types
        // belong to delivery, so they go in empty and stay hidden by role.
        <CalendarSettingsModal
          types={[]}
          setTypes={() => {}}
          targets={{ minPerDay: 0, minPerWeek: 0, minPerMonth: 0, highPerDay: 0, highPerWeek: 0, highPerMonth: 0 }}
          setTargets={() => {}}
          hideTargets
          vacationAllowance={vacAllowance}
          onClose={() => setShowSettings(false)}
        />
      )}

      {(draft || editing) && (
        <NewMeeting
          edit={editing}
          day={editing ? new Date(`${editing.meet_at.slice(0, 10)}T00:00:00`) : draft!.day}
          hour={editing ? Math.floor(new Date(editing.meet_at).getHours()) : draft!.hour}
          deals={deals}
          userId={myId}
          hours={HOURS}
          links={links}
          onClose={() => { setDraft(null); setEditing(null); }}
          onSaved={() => { setDraft(null); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function NewMeeting({ day, hour, deals, userId, hours, links, edit, onClose, onSaved }: {
  day: Date; hour: number; hours: number[];
  /** When set, the modal edits that meeting instead of creating one. */
  edit?: SalesMeeting | null;
  deals: { id: string; label: string; phase_id: string | null }[];
  links: { companies: { id: string; label: string }[]; contacts: { id: string; label: string }[] };
  userId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  /** A rep's week is meetings and the work around them, so the modal does both. */
  const [mode, setMode] = useState<"meeting" | "work">("meeting");
  /** A meeting is with a company, or with loose contacts. */
  const [withWhat, setWithWhat] = useState<"company" | "contacts">("company");
  const [companyId, setCompanyId] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [coContacts, setCoContacts] = useState<{ id: string; label: string }[]>([]);
  const [coDeals, setCoDeals] = useState<{ id: string; label: string; phase_id: string | null }[]>([]);
  const [dealId, setDealId] = useState("");

  // Picking a company brings its people and any open deals it has.
  useEffect(() => {
    if (!companyId) { setCoContacts([]); setCoDeals([]); setDealId(""); return; }
    (async () => {
      const [cs, ds] = await Promise.all([
        contactsOfCompany(companyId).catch(() => []),
        dealsForCompany(companyId).catch(() => []),
      ]);
      setCoContacts(cs);
      setCoDeals(ds);
      setDealId(ds[0]?.id ?? "");
      setPeople([]);
    })();
  }, [companyId]);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<MeetingKind>("teams");
  const [startMin, setStartMin] = useState(hour * 60);
  const [endMin, setEndMin] = useState(hour * 60 + 60);
  const [note, setNote] = useState("");
  /** Colleagues summoned to this, on either kind of event. */
  const [summon, setSummon] = useState<string[]>([]);
  const [mateQ, setMateQ] = useState("");
  const [mates, setMates] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    supabase.from("profiles").select("id, first_name, last_name, username, email")
      .then(({ data }) => {
        setMates(((data ?? []) as any[])
          .filter((p) => p.id !== userId)
          .map((p) => ({
            id: p.id,
            label: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.username || p.email || "Unnamed",
          }))
          .sort((a, b) => a.label.localeCompare(b.label)));
      });
  }, [userId]);

  /** Who is already booked while this event runs. */
  const [busy2, setBusy2] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!mates.length) return;
    const at = new Date(day);
    busyAt(mates.map((m) => m.id), isoOf(at), startMin, endMin, edit?.id)
      .then(setBusy2).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mates, day, startMin, endMin]);
  const [linkKind, setLinkKind] = useState<"none" | "company" | "contact">("none");
  const [linkId, setLinkId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!edit);

  // Reopening a meeting fills the form with what it already says.
  useEffect(() => {
    if (!edit) return;
    loadMeetingDetail(edit.id).then((d) => {
      if (!d) { setLoaded(true); return; }
      setTitle(d.title);
      setKind(d.meeting_kind);
      setStartMin(d.start_min);
      setEndMin(d.end_min);
      setNote(d.notes ?? "");
      setPeople(d.contact_ids);
      setSummon(d.summoned_ids);
      if (d.company_id) { setWithWhat("company"); setCompanyId(d.company_id); }
      else setWithWhat("contacts");
      setDealId(d.tracking_id ?? "");
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);


  // Moving the start carries the end along, so it can never end before it starts.
  const setStart = (v: number) => {
    const span = endMin - startMin;
    setStartMin(v);
    setEndMin(v + Math.max(15, span));
  };

  /** Invite whoever was summoned to the event just created. */
  const sendInvites = async (entryId: string) => {
    if (!summon.length) return null;
    return inviteToEntry(entryId, userId, summon.map((s) => ({ id: s, billable: 0 })), "sales");
  };

  const save = async () => {
    if (!title.trim()) { setErr(mode === "meeting" ? "Give the meeting a title." : "Give the block a title."); return; }
    setBusy(true); setErr(null);

    if (edit) {
      const at = new Date(day);
      const e = await saveMeetingEdit({
        id: edit.id, organiser_id: userId,
        tracking_id: dealId || null,
        phase_id: coDeals.find((d) => d.id === dealId)?.phase_id ?? null,
        company_id: withWhat === "company" ? companyId : null,
        title: title.trim(),
        entry_date: isoOf(at),
        date_key: `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`,
        start_min: startMin, end_min: endMin,
        meeting_kind: kind, notes: note.trim() || null,
        contact_ids: people, summoned_ids: summon,
      });
      setBusy(false);
      if (e) { setErr(e); return; }
      onSaved();
      return;
    }

    if (mode === "meeting") {
      if (withWhat === "company" && !companyId) { setBusy(false); setErr("Pick a company."); return; }
      if (withWhat === "contacts" && people.length === 0) { setBusy(false); setErr("Pick at least one contact."); return; }
      const at = new Date(day);
      at.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      const deal = coDeals.find((d) => d.id === dealId);
      const res = await createSalesMeeting({
        tracking_id: dealId || null,
        phase_id: deal?.phase_id ?? null,
        company_id: withWhat === "company" ? companyId : null,
        title: title.trim(), meet_at: at.toISOString(), duration_min: Math.max(15, endMin - startMin),
        kind, assignee_id: userId, contact_ids: people,
      });
      setBusy(false);
      if (res.error) { setErr(res.error); return; }
      if (res.id) {
        const iErr = await sendInvites(res.id);
        if (iErr) { setErr(`Meeting saved, but the invitations failed: ${iErr}`); return; }
      }
    } else {
      const res = await createSalesBlock({
        user_id: userId, title: title.trim(),
        date_key: `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`,
        entry_date: isoOf(day), start_min: startMin, end_min: endMin,
        notes: note.trim() || null,
        company_id: linkKind === "company" ? linkId || null : null,
        contact_id: linkKind === "contact" ? linkId || null : null,
      });
      setBusy(false);
      if (res.error) { setErr(res.error); return; }
      if (res.id) {
        const iErr = await sendInvites(res.id);
        if (iErr) { setErr(`Block saved, but the invitations failed: ${iErr}`); return; }
      }
    }
    onSaved();
  };

  const linkOptions = linkKind === "company" ? links.companies : links.contacts;

  // Whoever is already summoned stays on top, so they never scroll out of view.
  const shownMates = useMemo(() => {
    const needle = mateQ.trim().toLowerCase();
    const list = needle ? mates.filter((m) => m.label.toLowerCase().includes(needle)) : mates;
    return [...list].sort((a, b) =>
      Number(summon.includes(b.id)) - Number(summon.includes(a.id)) || a.label.localeCompare(b.label));
  }, [mates, mateQ, summon]);

  return (
    <div className="sc-backdrop" onMouseDown={onClose}>
      <div className="sc-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sc-modal-head">
          <div>
            <span className="sc-eyebrow">{edit ? "Edit meeting" : mode === "meeting" ? "New meeting" : "Block time"}</span>
            <h2 className="sc-modal-title">
              {day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
            </h2>
          </div>
          <button className="sc-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {!edit && <div className="sc-modes" data-mode={mode}>
          <button type="button" className={mode === "meeting" ? "is-on" : ""} onClick={() => setMode("meeting")}>
            Meeting with a client
          </button>
          <button type="button" className={mode === "work" ? "is-on" : ""} onClick={() => setMode("work")}>
            Own work
          </button>
        </div>}

        <div className="sc-cols">
          <section className="sc-card">
            <h3 className="sc-card-head">{mode === "meeting" ? "The meeting" : "The work"}</h3>
          <div className="sc-col-l">
            <div className="sc-f">
              <label>{mode === "meeting" ? "What is it about" : "What are you doing"}</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder={mode === "meeting" ? "e.g. Proposal walkthrough" : "e.g. Prospecting calls"} autoFocus />
            </div>

            {mode === "meeting" ? (
              <>
                <div className="sc-f">
                  <label>Who with</label>
                  <div className="sc-linkseg sc-seg2">
                    <button type="button" className={withWhat === "company" ? "is-on" : ""}
                      onClick={() => { setWithWhat("company"); setPeople([]); }}>A company</button>
                    <button type="button" className={withWhat === "contacts" ? "is-on" : ""}
                      onClick={() => { setWithWhat("contacts"); setCompanyId(""); setPeople([]); }}>Contacts only</button>
                  </div>
                </div>

                {withWhat === "company" ? (
                  <>
                    <div className="sc-f">
                      <label>Company</label>
                      <Picker value={companyId} onChange={setCompanyId}
                        placeholder={links.companies.length ? "Pick a company" : "No company assigned to you"}
                        options={links.companies} />
                    </div>

                    {coDeals.length > 1 && (
                      <div className="sc-f">
                        <label>Add it to which deal</label>
                        <Picker value={dealId} onChange={setDealId}
                          options={[...coDeals, { id: "", label: "Keep it off the deals" }]} />
                      </div>
                    )}
                    {coDeals.length === 1 && (
                      <p className="sc-hint">
                        Goes on the <b>{coDeals[0].label}</b> deal, so it shows in the tracker too.
                      </p>
                    )}
                    {companyId && coDeals.length === 0 && (
                      <p className="sc-hint">No open deal here, so this meeting stands on its own.</p>
                    )}

                    {coContacts.length > 0 && (
                      <div className="sc-f">
                        <label>Who is coming <em>optional</em></label>
                        <PeoplePicker options={coContacts} value={people} onChange={setPeople}
                          placeholder="Search their people…" />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="sc-f">
                    <label>Contacts <em>pick one or more</em></label>
                    <PeoplePicker options={links.contacts} value={people} onChange={setPeople}
                      placeholder="Search your contacts…" />
                  </div>
                )}

                <div className="sc-f">
                  <label>How</label>
                  <div className="sc-kinds">
                    {KINDS.map((k) => (
                      <button key={k.id} type="button"
                        className={`sc-kind ${kind === k.id ? "is-on" : ""}`}
                        onClick={() => setKind(k.id)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={k.icon} /></svg>
                        {k.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="sc-f">
                  <label>Link it to someone (optional)</label>
                  <div className="sc-linkrow">
                    <div className="sc-linkseg">
                      {(["none", "company", "contact"] as const).map((k) => (
                        <button key={k} type="button" className={linkKind === k ? "is-on" : ""}
                          onClick={() => { setLinkKind(k); setLinkId(""); }}>
                          {k === "none" ? "Nobody" : k === "company" ? "Company" : "Contact"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {linkKind !== "none" && (
                    <Picker value={linkId} onChange={(v) => { setLinkId(v); if (linkKind === "company") setCompanyId(v); }}
                      placeholder={linkOptions.length ? `Pick a ${linkKind}` : `No ${linkKind} assigned to you`}
                      options={linkOptions} />
                  )}

                  {linkKind === "company" && linkId && coContacts.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <PeoplePicker options={coContacts} value={people} onChange={setPeople}
                        placeholder="Search their people…" />
                    </div>
                  )}
                </div>

                <div className="sc-f">
                  <label>How</label>
                  <div className="sc-kinds">
                    {KINDS.map((k) => (
                      <button key={k.id} type="button"
                        className={`sc-kind ${kind === k.id ? "is-on" : ""}`}
                        onClick={() => setKind(k.id)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={k.icon} /></svg>
                        {k.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="sc-f">
                  <label>Notes (optional)</label>
                  <textarea className="sc-note" rows={3} value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What this time is for" />
                </div>
              </>
            )}

            <div className="sc-when">
              <span className="sc-when-head">When</span>

              {/* Start and end pick the same way: a time, not a time and a
                  duration in two different shapes. */}
              <div className="sc-when-row">
                <span>Starts</span>
                <TimeBox mins={startMin} onChange={setStart} hours={hours} />
              </div>

              <div className="sc-when-row sc-when-end">
                <span>Ends</span>
                <TimeBox mins={endMin}
                  onChange={(v) => setEndMin(Math.max(startMin + 15, v))}
                  hours={hours} />
              </div>

              <div className="sc-when-out">
                <i>{lasts(endMin - startMin)}</i>
              </div>
            </div>
          </div>
          </section>

          <section className="sc-card sc-card-team">
            <h3 className="sc-card-head">Summon colleagues</h3>
          <div className="sc-col-r">

            <div className="sc-team-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
              <input value={mateQ} onChange={(e) => setMateQ(e.target.value)} placeholder="Search the team…" />
              {mateQ && <button type="button" onClick={() => setMateQ("")} aria-label="Clear">×</button>}
            </div>

            <div className="sc-team">
              {shownMates.length === 0 && <p className="sc-hint">Nobody matches that.</p>}
              {shownMates.map((c) => (
                <button key={c.id} type="button"
                  className={`sc-mate ${summon.includes(c.id) ? "is-on" : ""}`}
                  onClick={() => setSummon((xs) => xs.includes(c.id) ? xs.filter((x) => x !== c.id) : [...xs, c.id])}>
                  <i>{c.label.charAt(0).toUpperCase()}</i>
                  <span>{c.label}</span>
                  <b className={`sc-free ${busy2.has(c.id) ? "is-busy" : ""}`}>
                    {busy2.has(c.id) ? "Busy" : "Free"}
                  </b>
                  <em>{summon.includes(c.id) ? "✓" : "+"}</em>
                </button>
              ))}
            </div>
            {summon.length > 0 && (
              <p className="sc-hint">{summon.length} {summon.length === 1 ? "person gets" : "people get"} an invitation.</p>
            )}
          </div>
          </section>
        </div>

        {err && <p className="sc-err">{err}</p>}

        <div className="sc-actions">
          <button className="sc-cancel" onClick={onClose}>Cancel</button>
          <button className="sc-save" onClick={save} disabled={busy || !loaded}>
            {busy ? "Saving…" : edit ? "Save changes" : mode === "meeting" ? "Book meeting" : "Block time"}
          </button>
        </div>
      </div>
    </div>
  );
}