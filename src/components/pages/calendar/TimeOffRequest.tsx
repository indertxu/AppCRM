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
  status: "pending" | "approved" | "declined";
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

export default function TimeOffRequestPanel({ allowance }: { allowance: number }) {
  const [mine, setMine] = useState<TimeOffRequest[]>([]);
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
    const { data } = await supabase.from("timeoff_requests").select("*")
      .eq("user_id", uid).order("from_date", { ascending: false });
    setMine((data ?? []) as TimeOffRequest[]);
  };
  useEffect(() => { load(); }, []);

  const days = half && from && from === to ? 0.5 : workingDays(from, to);
  const taken = mine.filter((r) => r.status === "approved" && r.kind === "vacation")
                    .reduce((s, r) => s + Number(r.days || 0), 0);
  const pending = mine.filter((r) => r.status === "pending" && r.kind === "vacation")
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
          <span>Allowance</span>
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
            <span className={`to-row-status is-${r.status}`}>{r.status}</span>
            {r.status === "pending" && (
              <button className="to-row-x" onClick={() => withdraw(r.id)} title="Withdraw">×</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}