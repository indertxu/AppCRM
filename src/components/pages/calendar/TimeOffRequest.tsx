/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { supabase } from "../../api/supabase";
import DatePicker from "../../framework/DatePicker";
import "./TimeOffRequest.css";

export interface TimeOffRequest {
  id: string;
  user_id: string;
  kind: string;
  from_date: string;
  to_date: string;
  half_day: boolean;
  days: number;
  note: string | null;
  status: "pending" | "approved" | "declined" | "cancelled";
  decision_note: string | null;
  created_at: string;
}

const KINDS = [
  { id: "vacation", label: "Holiday", icon: "M8 2v3M16 2v3M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" },
  { id: "sick", label: "Sick leave", icon: "M12 8v8M8 12h8M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" },
  { id: "personal", label: "Personal", icon: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" },
];

/** Working days between two dates, weekends excluded. */
function workingDays(from: string, to: string): number {
  if (!from || !to) return 0;
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  if (b < a) return 0;
  let n = 0;
  for (const d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  }
  return n;
}

const fmt = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const STATUS_LABEL: Record<string, string> = { pending: "Awaiting approval", approved: "Approved", declined: "Declined", cancelled: "Cancelled" };

export default function TimeOffRequestPanel({ allowance: companyAllowance }: { allowance: number }) {
  const [mine, setMine] = useState<TimeOffRequest[]>([]);
  /** This person's own allowance for the year (Settings › Calendar), else the company's. */
  const [own, setOwn] = useState<number | null>(null);
  const year = new Date().getFullYear();
  const allowance = own ?? companyAllowance;
  const [kind, setKind] = useState("vacation");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [half, setHalf] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const load = async () => {
    const { data: u } = await supabase.auth.getUser();
    const uid = u?.user?.id;
    if (!uid) return;
    const [{ data }, al] = await Promise.all([
      supabase.from("timeoff_requests").select("*").eq("user_id", uid).order("from_date", { ascending: false }),
      supabase.from("timeoff_allowances").select("days").eq("user_id", uid).eq("year", year).maybeSingle(),
    ]);
    setMine((data ?? []) as TimeOffRequest[]);
    setOwn(!al.error && al.data ? Number((al.data as any).days) : null);
  };
  useEffect(() => { load(); }, []);

  const days = half && from && from === to ? 0.5 : workingDays(from, to);
  const inYear = (r: TimeOffRequest) => r.from_date.slice(0, 4) === String(year);
  const taken = mine.filter((r) => r.status === "approved" && r.kind === "vacation" && inYear(r))
                    .reduce((s, r) => s + Number(r.days || 0), 0);
  const pending = mine.filter((r) => r.status === "pending" && r.kind === "vacation" && inYear(r))
                      .reduce((s, r) => s + Number(r.days || 0), 0);
  const left = Math.max(0, allowance - taken - pending);

  const send = async () => {
    if (!from) { setErr("Pick a start date."); return; }
    if (days <= 0) { setErr("That range has no working days in it."); return; }
    setBusy(true); setErr(null);
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("timeoff_requests").insert({
      user_id: u?.user?.id, kind, from_date: from, to_date: to || from,
      half_day: half, days, note: note.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setFrom(""); setTo(""); setHalf(false); setNote("");
    setSent(true);
    window.setTimeout(() => setSent(false), 2600);
    load();
  };

  const withdraw = async (id: string) => {
    await supabase.from("timeoff_requests").delete().eq("id", id).eq("status", "pending");
    load();
  };

  return (
    <div className="to">
      <div className="to-sums">
        <div className="to-sum">
          <span>Allowance {year}</span>
          <b>{allowance}<em>d</em></b>
        </div>
        <div className="to-sum">
          <span>Taken</span>
          <b>{taken}<em>d</em></b>
        </div>
        <div className="to-sum">
          <span>Awaiting approval</span>
          <b>{pending}<em>d</em></b>
        </div>
        <div className="to-sum is-left">
          <span>Left</span>
          <b>{left}<em>d</em></b>
        </div>
      </div>

      <div className="to-form">
        <div className="to-kinds">
          {KINDS.map((k) => (
            <button key={k.id} type="button"
              className={`to-kind ${kind === k.id ? "is-on" : ""}`}
              onClick={() => setKind(k.id)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d={k.icon} />
              </svg>
              {k.label}
            </button>
          ))}
        </div>

        <div className="to-range">
          <div className="to-field">
            <label>From</label>
            <DatePicker value={from} onChange={(v) => { setFrom(v); if (!to || to < v) setTo(v); }} placeholder="Start" />
          </div>
          <span className="to-arrow" aria-hidden="true">→</span>
          <div className="to-field">
            <label>To</label>
            <DatePicker value={to} onChange={setTo} placeholder="End" />
          </div>

          <div className="to-count">
            <b>{days === 0 ? "—" : days}</b>
            <span>{days === 1 ? "day" : "days"}</span>
          </div>
        </div>

        {from && from === to && (
          <label className="to-half">
            <input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} />
            Half day only
          </label>
        )}

        <input className="to-note" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Anything your manager should know (optional)" />

        {err && <p className="to-err">{err}</p>}

        <button className={`to-send ${sent ? "is-sent" : ""}`} onClick={send} disabled={busy || days <= 0}>
          {sent ? "Sent for approval ✓" : busy ? "Sending…" : "Request time off"}
        </button>
      </div>

      <div className="to-list">
        <p className="to-list-head">Your requests</p>
        {mine.length === 0 ? (
          <p className="to-empty">Nothing requested yet.</p>
        ) : mine.map((r) => (
          <div className={`to-row is-${r.status}`} key={r.id}>
            <span className="to-row-dates">
              <b>{fmt(r.from_date)}</b>
              {r.to_date !== r.from_date && <em>→ {fmt(r.to_date)}</em>}
            </span>
            <span className="to-row-days">{r.days}{r.days === 1 ? " day" : " days"}</span>
            <span className="to-row-kind">{KINDS.find((k) => k.id === r.kind)?.label ?? r.kind}</span>
            <span className={`to-row-status is-${r.status}`} title={r.decision_note ?? undefined}>{STATUS_LABEL[r.status] ?? r.status}</span>
            {r.status === "pending" && (
              <button className="to-row-x" onClick={() => withdraw(r.id)} title="Withdraw">×</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
/* =====================================================================
   Settings › Calendar: approvals, allowances and public holidays
   (68_time_off.sql). Managers decide; everyone asks from the calendar.
   ===================================================================== */
export const TIMEOFF_SQL = "Run 68_time_off.sql in Supabase to approve, decline and cancel time off and to give each person their own days.";
export const TIMEOFF_EVENT = "timeoff-changed";
interface Person { id: string; name: string; dept: string | null }
const initialsOf = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
const TONES = ["#12b57f", "#3f7fd8", "#d98324", "#8b5cf6", "#d6457a", "#0f9fb3", "#6b8e23"];
const toneOf = (id: string) => TONES[[...id].reduce((s, c) => s + c.charCodeAt(0), 0) % TONES.length];
const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const agoOf = (iso: string) => {
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 864e5);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
async function loadPeople(): Promise<Person[]> {
  const { data } = await supabase.from("profiles").select("id, first_name, last_name, email, department");
  return ((data ?? []) as any[]).map((p) => ({ id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "Someone", dept: p.department ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
/** Every request of the company (managers, through 68_time_off.sql); before it, only what the database lets you read. */
async function loadAllRequests(): Promise<{ rows: TimeOffRequest[]; missing: boolean }> {
  const r = await supabase.rpc("timeoff_list", { p_from: null });
  if (!r.error) return { rows: ((r.data ?? []) as any[]).map((x) => (typeof x === "string" ? JSON.parse(x) : x)) as TimeOffRequest[], missing: false };
  const { data } = await supabase.from("timeoff_requests").select("*").order("from_date", { ascending: false });
  return { rows: (data ?? []) as TimeOffRequest[], missing: true };
}
function PersonAv({ p, size = 30 }: { p: Person | undefined; size?: number }) {
  const name = p?.name ?? "?";
  return <span className="toa-av" style={{ width: size, height: size, fontSize: size * 0.38, background: toneOf(p?.id ?? name) }}>{initialsOf(name)}</span>;
}

/** Approve, decline or cancel time off. */
export function TimeOffApprovals() {
  const [rows, setRows] = useState<TimeOffRequest[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<"pending" | "upcoming" | "history">("pending");
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ id: string; status: "declined" | "cancelled"; note: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const load = async () => {
    const [r, p] = await Promise.all([loadAllRequests(), loadPeople()]);
    setRows(r.rows); setMissing(r.missing); setPeople(p);
  };
  useEffect(() => { void load(); }, []);
  const person = (id: string) => people.find((p) => p.id === id);
  const decide = async (id: string, status: "approved" | "declined" | "cancelled", note?: string) => {
    setBusy(id); setErr(null);
    const { data, error } = await supabase.rpc("timeoff_decide", { p_id: id, p_status: status, p_note: note ?? null });
    setBusy(null);
    if (error) { setErr(/timeoff_decide|function/i.test(error.message) ? TIMEOFF_SQL : error.message); return; }
    if (data) { setErr(String(data)); }
    setAsk(null);
    window.dispatchEvent(new Event(TIMEOFF_EVENT));
    void load();
  };
  const all = rows ?? [];
  const groups = {
    pending: all.filter((r) => r.status === "pending").sort((a, b) => a.from_date.localeCompare(b.from_date)),
    upcoming: all.filter((r) => r.status === "approved" && r.to_date >= today).sort((a, b) => a.from_date.localeCompare(b.from_date)),
    history: all.filter((r) => !(r.status === "pending" || (r.status === "approved" && r.to_date >= today))),
  };
  const shown = groups[tab];
  return (
    <div className="toa">
      {missing && <p className="toa-note">{TIMEOFF_SQL}</p>}
      <div className="toa-tabs" role="tablist">
        {([["pending", "To decide"], ["upcoming", "Approved, coming up"], ["history", "History"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "is-on" : ""} onClick={() => setTab(k)}>
            {l}<i className={k === "pending" && groups.pending.length ? "is-hot" : ""}>{groups[k].length}</i>
          </button>
        ))}
      </div>
      {err && <p className="toa-err">{err}</p>}
      {!rows ? <div className="cws-embed-skel" /> : !shown.length ? (
        <p className="toa-empty">{tab === "pending" ? "Nothing waiting for a decision." : tab === "upcoming" ? "No approved time off coming up." : "No past requests yet."}</p>
      ) : (
        <div className="toa-list">
          {shown.map((r) => {
            const p = person(r.user_id);
            const asking = ask?.id === r.id;
            return (
              <div key={r.id} className={`toa-row is-${r.status}`}>
                <PersonAv p={p} />
                <div className="toa-main">
                  <span className="toa-who"><b>{p?.name ?? "Someone"}</b>{p?.dept && <em>{p.dept}</em>}</span>
                  <span className="toa-what">
                    <span className={`toa-kind is-${r.kind}`}>{KINDS.find((k) => k.id === r.kind)?.label ?? r.kind}</span>
                    <b>{shortDate(r.from_date)}{r.to_date !== r.from_date ? ` → ${shortDate(r.to_date)}` : ""}</b>
                    <span>{r.half_day ? "half a day" : `${r.days} ${Number(r.days) === 1 ? "day" : "days"}`}</span>
                    <span className="toa-ago">asked {agoOf(r.created_at)}</span>
                  </span>
                  {r.note && <span className="toa-note-q">“{r.note}”</span>}
                  {r.decision_note && tab === "history" && <span className="toa-dec">{r.status === "cancelled" ? "Cancelled" : "Decision"}: {r.decision_note}</span>}
                  {asking && (
                    <div className="toa-ask">
                      <input autoFocus value={ask.note} onChange={(e) => setAsk({ ...ask, note: e.target.value })} placeholder={ask.status === "declined" ? "Why not? (optional, they'll see it)" : "Why is it cancelled? (optional, they'll see it)"}
                        onKeyDown={(e) => { if (e.key === "Enter") void decide(r.id, ask.status, ask.note); if (e.key === "Escape") setAsk(null); }} />
                      <button type="button" className="toa-btn" onClick={() => setAsk(null)}>Back</button>
                      <button type="button" className="toa-btn is-bad" disabled={busy === r.id} onClick={() => void decide(r.id, ask.status, ask.note)}>{ask.status === "declined" ? "Decline" : "Cancel it"}</button>
                    </div>
                  )}
                </div>
                {!asking && (
                  <div className="toa-acts">
                    {r.status === "pending" ? (
                      <>
                        <button type="button" className="toa-btn" disabled={busy === r.id} onClick={() => setAsk({ id: r.id, status: "declined", note: "" })}>Decline</button>
                        <button type="button" className="toa-btn is-ok" disabled={busy === r.id} onClick={() => void decide(r.id, "approved")}>Approve</button>
                      </>
                    ) : r.status === "approved" && r.to_date >= today ? (
                      <button type="button" className="toa-btn" disabled={busy === r.id} onClick={() => setAsk({ id: r.id, status: "cancelled", note: "" })}>Cancel</button>
                    ) : <span className={`to-row-status is-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** How many vacation days each person has, per year (and the company's default). */
export function TimeOffAllowances() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [def, setDef] = useState<number | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [own, setOwn] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reqs, setReqs] = useState<TimeOffRequest[]>([]);
  const [missing, setMissing] = useState(false);
  const [q, setQ] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const [bs, p, r] = await Promise.all([
        supabase.from("billing_settings").select("vacation_days_per_year").eq("id", "default").maybeSingle(),
        loadPeople(), loadAllRequests(),
      ]);
      setDef(Number((bs.data as any)?.vacation_days_per_year ?? 22));
      setPeople(p); setReqs(r.rows);
    })().catch(() => setDef(22));
    const on = () => { void loadAllRequests().then((r) => setReqs(r.rows)); };
    window.addEventListener(TIMEOFF_EVENT, on);
    return () => window.removeEventListener(TIMEOFF_EVENT, on);
  }, []);
  useEffect(() => {
    supabase.from("timeoff_allowances").select("user_id, days").eq("year", year).then(({ data, error }) => {
      if (error) { setMissing(true); setOwn({}); return; }
      setMissing(false);
      setOwn(Object.fromEntries(((data ?? []) as any[]).map((a) => [a.user_id, Number(a.days)])));
      setDraft({});
    });
  }, [year]);
  const saveDef = async (n: number) => {
    setDef(n);
    const { error } = await supabase.from("billing_settings").upsert({ id: "default", vacation_days_per_year: n });
    setErr(error ? error.message : null);
  };
  const saveOwn = async (uid: string) => {
    const raw = draft[uid];
    if (raw === undefined) return;
    const v = raw.trim() === "" ? null : Math.max(0, Number(raw.replace(",", ".")));
    if (v !== null && Number.isNaN(v)) return;
    const res = v === null
      ? await supabase.from("timeoff_allowances").delete().eq("user_id", uid).eq("year", year)
      : await supabase.from("timeoff_allowances").upsert({ user_id: uid, year, days: v }, { onConflict: "user_id,year" });
    if (res.error) { setErr(/timeoff_allowances/.test(res.error.message) ? TIMEOFF_SQL : res.error.message); return; }
    setErr(null);
    setOwn((o) => { const n = { ...o }; if (v === null) delete n[uid]; else n[uid] = v; return n; });
    setDraft((d) => { const n = { ...d }; delete n[uid]; return n; });
    setSavedId(uid); window.setTimeout(() => setSavedId((s) => (s === uid ? null : s)), 1400);
  };
  const used = (uid: string, status: string) => reqs.filter((r) => r.user_id === uid && r.kind === "vacation" && r.status === status && r.from_date.slice(0, 4) === String(year))
    .reduce((s, r) => s + Number(r.days || 0), 0);
  const f = q.trim().toLowerCase();
  const shown = people.filter((p) => !f || `${p.name} ${p.dept ?? ""}`.toLowerCase().includes(f));
  return (
    <div className="toa">
      {missing && <p className="toa-note">{TIMEOFF_SQL}</p>}
      {err && <p className="toa-err">{err}</p>}
      <div className="toa-def">
        <div><b>Company default</b><span>Vacation days a year for anyone without their own number below.</span></div>
        <div className="toa-step">
          <button type="button" onClick={() => def !== null && void saveDef(Math.max(0, def - 1))} aria-label="One day less">−</button>
          <span><b>{def ?? "—"}</b><i>days</i></span>
          <button type="button" onClick={() => def !== null && void saveDef(def + 1)} aria-label="One day more">+</button>
        </div>
      </div>
      <div className="toa-bar">
        <div className="toa-year">
          <button type="button" onClick={() => setYear((y) => y - 1)} aria-label="Previous year">‹</button>
          <b>{year}</b>
          <button type="button" onClick={() => setYear((y) => y + 1)} aria-label="Next year">›</button>
        </div>
        <input className="toa-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone…" />
      </div>
      <div className="toa-table">
        <div className="toa-th"><span>Person</span><span>Days in {year}</span><span>Taken</span><span>Waiting</span><span>Left</span></div>
        {shown.map((p) => {
          const has = p.id in own;
          const days = has ? own[p.id] : def ?? 0;
          const taken = used(p.id, "approved"), waiting = used(p.id, "pending");
          const left = days - taken - waiting;
          return (
            <div key={p.id} className="toa-tr">
              <span className="toa-person"><PersonAv p={p} size={26} /><span><b>{p.name}</b>{p.dept && <em>{p.dept}</em>}</span></span>
              <span className="toa-days">
                <input inputMode="decimal" value={draft[p.id] ?? (has ? String(own[p.id]) : "")} placeholder={String(def ?? "")} aria-label={`${p.name}'s vacation days in ${year}`}
                  onChange={(e) => setDraft((d) => ({ ...d, [p.id]: e.target.value }))} onBlur={() => void saveOwn(p.id)}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                {savedId === p.id ? <em className="is-saved">Saved</em> : !has && <em>default</em>}
              </span>
              <span className="toa-num">{taken}</span>
              <span className="toa-num">{waiting || "—"}</span>
              <span className={`toa-num toa-left ${left < 0 ? "is-over" : left <= 3 ? "is-low" : ""}`}>{left}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The company's public holidays, a year at a time. */
export function PublicHolidays() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState<{ date: string; name: string }[] | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = async () => {
    const { data, error } = await supabase.from("holidays").select("holiday_date, name");
    if (error) { setErr(error.message); setRows([]); return; }
    setRows(((data ?? []) as any[]).map((h) => ({ date: String(h.holiday_date).slice(0, 10), name: h.name ?? "" })).sort((a, b) => a.date.localeCompare(b.date)));
  };
  useEffect(() => { void load(); }, []);
  const span = (a: string, b: string) => {
    const out: string[] = [];
    if (!a) return out;
    for (let d = new Date(`${a}T00:00:00`); d <= new Date(`${(b && b >= a ? b : a)}T00:00:00`); d.setDate(d.getDate() + 1))
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    return out;
  };
  const add = async () => {
    const days = span(from, to);
    if (!days.length) return;
    const { error } = await supabase.from("holidays").upsert(days.map((d) => ({ holiday_date: d, name: name.trim() })), { onConflict: "holiday_date" });
    if (error) { setErr(error.message); return; }
    setErr(null); setFrom(""); setTo(""); setName("");
    if (days[0].slice(0, 4) !== String(year)) setYear(Number(days[0].slice(0, 4)));
    void load();
  };
  const remove = async (iso: string) => {
    setRows((r) => r?.filter((x) => x.date !== iso) ?? r);
    const { error } = await supabase.from("holidays").delete().eq("holiday_date", iso);
    if (error) { setErr(error.message); void load(); }
  };
  const inYear = (rows ?? []).filter((h) => h.date.startsWith(String(year)));
  const count = span(from, to).length;
  return (
    <div className="toa">
      {err && <p className="toa-err">{err}</p>}
      <div className="toa-hadd">
        <div className="toa-pick"><DatePicker value={from} onChange={(v) => { setFrom(v); if (!to || to < v) setTo(v); }} placeholder="Day" /></div>
        <span className="toa-arrow">→</span>
        <div className="toa-pick"><DatePicker value={to} onChange={setTo} placeholder="Until (optional)" /></div>
        <input className="toa-q" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Christmas" onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <button type="button" className="toa-btn is-ok" disabled={!from} onClick={() => void add()}>{count > 1 ? `Add ${count} days` : "Add"}</button>
      </div>
      <div className="toa-bar">
        <div className="toa-year">
          <button type="button" onClick={() => setYear((y) => y - 1)} aria-label="Previous year">‹</button>
          <b>{year}</b>
          <button type="button" onClick={() => setYear((y) => y + 1)} aria-label="Next year">›</button>
        </div>
        <span className="toa-sub">{inYear.length} {inYear.length === 1 ? "day" : "days"} off for everyone</span>
      </div>
      {!rows ? <div className="cws-embed-skel" /> : !inYear.length ? <p className="toa-empty">No public holidays in {year} yet.</p> : (
        <div className="toa-hlist">
          {inYear.map((h) => {
            const d = new Date(`${h.date}T00:00:00`);
            return (
              <div key={h.date} className={`toa-hol ${d.getDay() === 0 || d.getDay() === 6 ? "is-weekend" : ""}`}>
                <span className="toa-hol-d"><b>{d.getDate()}</b><em>{d.toLocaleDateString("en-GB", { month: "short" })}</em></span>
                <span className="toa-hol-n"><b>{h.name || "Holiday"}</b><em>{d.toLocaleDateString("en-GB", { weekday: "long" })}</em></span>
                <button type="button" className="toa-x" onClick={() => void remove(h.date)} aria-label={`Remove ${h.date}`} title="Remove">×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
