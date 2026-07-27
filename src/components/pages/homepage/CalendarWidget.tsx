import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import "./CalendarWidget.css";

interface Entry {
  dateKey: string;
  startMin: number;
  endMin: number;
  type: string;
  billable: number;
  clientId: string;
  status: string;
}

const DOW = ["M", "T", "W", "T", "F"];

function startOfWeek(input: Date): Date {
  const d = new Date(input);
  const day = d.getDay();
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  d.setHours(0, 0, 0, 0);
  return d;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const period = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${period}`;
}

export default function CalendarWidget() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [clientNames, setClientNames] = useState<Record<string, string>>({});
  const [colors, setColors] = useState<Record<string, string>>({});
  const [clientTypes, setClientTypes] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState({ minPerDay: 0.5, minPerWeek: 3 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
     const { data: u0 } = await supabase.auth.getUser();
      const { data: ce } = await supabase
        .from("calendar_entries")
        .select("*")
        .eq("user_id", u0?.user?.id ?? "");
      setEntries(((ce ?? []) as Record<string, unknown>[]).map((r) => ({
        dateKey: r.date_key as string,
        startMin: Number(r.start_min) || 0,
        endMin: Number(r.end_min) || 0,
        type: (r.work_type_id as string) ?? "",
        billable: Number(r.billable) || 0,
        clientId: (r.client_id as string) ?? "",
status: (r.status as string) || "planned",
        line: (r.billing_line as string) || "consultor",
      })));

      const { data: cl } = await supabase.from("clients").select("id, name");
      setClientNames(Object.fromEntries(((cl ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name])));

      const { data: wt } = await supabase.from("work_types").select("id, client_related, color");
      const list = (wt ?? []) as { id: string; client_related: boolean; color: string | null }[];
      setClientTypes(new Set(list.filter((t) => t.client_related).map((t) => t.id)));
      setColors(Object.fromEntries(list.map((t) => [t.id, t.color ?? "#12b57f"])));

      const { data: tg } = await supabase.from("calendar_targets").select("*").eq("id", "default").maybeSingle();
      if (tg) setTargets({
        minPerDay: Number(tg.min_per_day) || 0,
        minPerWeek: Number(tg.min_per_week) || 0,
      });

      setLoading(false);
    })();
  }, []);

  const today = new Date();
  const weekStart = startOfWeek(today);
  const weekDays = Array.from({ length: 5 }, (_, i) => addDays(weekStart, i));
  const weekKeys = new Set(weekDays.map(dateKey));

const billable = (list: Entry[]) =>
    list.filter((e) => clientTypes.has(e.type) && e.status !== "cancelled" && e.line !== "connector")
        .reduce((s, e) => s + e.billable, 0);
  const confirmed = (list: Entry[]) =>
    list.filter((e) => clientTypes.has(e.type) && e.status === "confirmed" && e.line !== "connector")
        .reduce((s, e) => s + e.billable, 0);

  const weekEntries = entries.filter((e) => weekKeys.has(e.dateKey));
  const planned = billable(weekEntries);
  const done = confirmed(weekEntries);
  const pct = targets.minPerWeek > 0 ? Math.min(100, (planned / targets.minPerWeek) * 100) : 0;
  const donePct = targets.minPerWeek > 0 ? Math.min(100, (done / targets.minPerWeek) * 100) : 0;

  const todayEntries = entries
    .filter((e) => e.dateKey === dateKey(today) && e.status !== "cancelled")
    .sort((a, b) => a.startMin - b.startMin);

  const dayGoal = targets.minPerDay || 1;
  const peak = Math.max(dayGoal, ...weekDays.map((d) => billable(entries.filter((e) => e.dateKey === dateKey(d)))));

  return (
    <aside className="cw">
      <div className="cw-head">
        <span className="cw-eyebrow">Calendar</span>
        <button className="cw-open" onClick={() => navigate("/calendar")}>Open →</button>
      </div>

      {/* Week bars */}
      <div className="cw-week">
        {weekDays.map((d) => {
          const list = entries.filter((e) => e.dateKey === dateKey(d));
          const p = billable(list);
          const c = confirmed(list);
          const isToday = sameDay(d, today);
          return (
            <div className={`cw-day ${isToday ? "is-today" : ""}`} key={d.toISOString()}>
              <div className="cw-day-col">
                <div className="cw-day-bar" style={{ height: `${(p / peak) * 100}%` }}>
                  <div className="cw-day-done" style={{ height: `${p > 0 ? (c / p) * 100 : 0}%` }} />
                </div>
                <div className="cw-day-goal" style={{ bottom: `${(dayGoal / peak) * 100}%` }} />
              </div>
              <span className="cw-day-val">{p > 0 ? p.toFixed(2).replace(/\.00$/, "") : "–"}</span>
              <span className="cw-day-dow">{DOW[d.getDay() - 1] ?? ""}</span>
            </div>
          );
        })}
      </div>

      {/* Weekly total */}
      <div className="cw-figure">
        <strong className={planned < targets.minPerWeek ? "is-under" : ""}>{planned.toFixed(2)}</strong>
        <em>/ {targets.minPerWeek} days this week</em>
      </div>
      <div className="cw-track">
        <div className="cw-fill" style={{ width: `${pct}%` }} />
        <div className="cw-fill is-done" style={{ width: `${donePct}%` }} />
      </div>
      <div className="cw-legend">
        <span><i className="cw-dot-done" />{done.toFixed(2)} completed</span>
        <span><i className="cw-dot-plan" />{(planned - done).toFixed(2)} planned</span>
      </div>

      <div className="cw-sep" />

      {/* Today */}
      <span className="cw-today-label">
        Today · {todayEntries.length} booking{todayEntries.length === 1 ? "" : "s"}
      </span>
      <div className="cw-list">
        {loading ? (
          <span className="cw-empty">Loading…</span>
        ) : todayEntries.length === 0 ? (
          <span className="cw-empty">Nothing scheduled.</span>
        ) : (
          todayEntries.map((e, i) => (
            <div className={`cw-item is-${e.status}`} key={i}>
              <span className="cw-item-dot" style={{ background: colors[e.type] ?? "#12b57f" }} />
              <span className="cw-item-text">
                <span className="cw-item-name">
                  {e.clientId ? clientNames[e.clientId] ?? "—" : "Internal"}
                </span>
                <span className="cw-item-time">{fmtTime(e.startMin)} – {fmtTime(e.endMin)}</span>
              </span>
              <span className="cw-item-bill">{e.billable}d</span>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}