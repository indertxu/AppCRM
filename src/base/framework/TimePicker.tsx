import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./DatePicker.css"; // the time picker shares the date picker's stylesheet

/**
 * Time picker: a field like the date picker, opening a small panel with an
 * hours column, a minutes column, a few quick times and a box to type it in.
 * Value is "HH:MM" (24h).
 */
interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Minute step in the minutes column (default 5). */
  step?: number;
  placeholder?: string;
  /** Quick picks shown at the bottom. */
  quick?: string[];
  className?: string;
  ariaLabel?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const split = (v: string): [number, number] | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v ?? "");
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? [h, mi] : null;
};
/** "930", "9:30", "09.30", "9h30", "21" → "HH:MM" (null if it isn't a time). */
export function parseTime(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  let h: number, m: number;
  const sep = /^(\d{1,2})[:.,h](\d{1,2})?$/.exec(s);
  if (sep) { h = Number(sep[1]); m = Number(sep[2] ?? 0); }
  else if (/^\d{1,4}$/.test(s)) {
    if (s.length <= 2) { h = Number(s); m = 0; }
    else { h = Number(s.slice(0, s.length - 2)); m = Number(s.slice(-2)); }
  } else return null;
  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

const clockIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" />
  </svg>
);

export default function TimePicker({ value, onChange, step = 5, placeholder = "Time", quick = ["09:00", "11:00", "13:00", "16:00"], className = "", ariaLabel = "Time" }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 });
  const [typed, setTyped] = useState("");
  const [bad, setBad] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const hoursRef = useRef<HTMLDivElement>(null);
  const minsRef = useRef<HTMLDivElement>(null);
  const cur = split(value);
  const minutes = Array.from({ length: Math.ceil(60 / step) }, (_, i) => i * step);
  // the current minute might not be on the grid (e.g. 10:07) — show it anyway
  if (cur && !minutes.includes(cur[1])) { minutes.push(cur[1]); minutes.sort((a, b) => a - b); }

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 248, H = 340;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
    const below = window.innerHeight - r.bottom;
    setPos(below < H + 12 && r.top > below ? { bottom: window.innerHeight - r.top + 6, left } : { top: r.bottom + 6, left });
  };
  const show = () => { place(); setTyped(value || ""); setBad(false); setOpen(true); };

  // Bring the chosen hour/minute into the middle of their columns.
  useLayoutEffect(() => {
    if (!open) return;
    const center = (box: HTMLDivElement | null) => {
      const on = box?.querySelector<HTMLElement>(".is-on");
      if (box && on) box.scrollTop = on.offsetTop - box.clientHeight / 2 + on.clientHeight / 2;
    };
    center(hoursRef.current); center(minsRef.current);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btnRef.current?.focus(); } };
    const onScroll = () => place();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", onScroll); };
  }, [open]);

  const pick = (h: number | null, m: number | null) => {
    const base = cur ?? [9, 0];
    const next = `${pad(h ?? base[0])}:${pad(m ?? base[1])}`;
    onChange(next);
    setTyped(next);
  };
  const commitTyped = () => {
    const t = parseTime(typed);
    if (!t) { setBad(!!typed.trim()); return false; }
    setBad(false); onChange(t); setTyped(t); return true;
  };

  return (
    <>
      <button ref={btnRef} type="button" className={`tp-trigger ${value ? "" : "is-empty"} ${open ? "is-open" : ""} ${className}`}
        onClick={() => (open ? setOpen(false) : show())} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel}>
        {clockIcon}<span>{value || placeholder}</span>
      </button>
      {open && createPortal(
        <>
          <div className="tp-layer" onMouseDown={() => setOpen(false)} />
          <div className="tp-pop" style={pos} role="dialog" aria-label={ariaLabel}>
            <div className="tp-head">
              <input className={`tp-type ${bad ? "is-bad" : ""}`} value={typed} autoFocus inputMode="numeric" aria-label="Type a time"
                placeholder="hh:mm"
                onChange={(e) => { setTyped(e.target.value); setBad(false); }}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (commitTyped()) setOpen(false); } }}
                onBlur={() => { if (typed !== value) commitTyped(); }} />
              <span className="tp-head-hint">{bad ? "Try 9:30 or 1430" : "Type it, or pick below"}</span>
            </div>
            <div className="tp-cols">
              <div className="tp-col">
                <span className="tp-col-h">Hour</span>
                <div className="tp-list" ref={hoursRef}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <button key={h} type="button" className={`tp-opt ${cur?.[0] === h ? "is-on" : ""} ${h < 7 || h > 20 ? "is-off-hours" : ""}`} onClick={() => pick(h, null)}>{pad(h)}</button>
                  ))}
                </div>
              </div>
              <span className="tp-colon" aria-hidden="true">:</span>
              <div className="tp-col">
                <span className="tp-col-h">Min</span>
                <div className="tp-list" ref={minsRef}>
                  {minutes.map((m) => (
                    <button key={m} type="button" className={`tp-opt ${cur?.[1] === m ? "is-on" : ""}`} onClick={() => pick(null, m)}>{pad(m)}</button>
                  ))}
                </div>
              </div>
            </div>
            {quick.length > 0 && (
              <div className="tp-quick">
                {quick.map((q) => (
                  <button key={q} type="button" className={value === q ? "is-on" : ""} onClick={() => { onChange(q); setTyped(q); setOpen(false); }}>{q}</button>
                ))}
              </div>
            )}
            <button type="button" className="tp-done" onClick={() => { if (typed !== value) commitTyped(); setOpen(false); }}>Done</button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}