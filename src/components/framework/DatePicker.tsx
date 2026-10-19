import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import "./DatePicker.css";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WD = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseISO(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

interface Props {
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  weekMode?: boolean;              // highlight whole week, return Monday
  maxDate?: string;                // disable days after this (e.g. today)
  hideTrigger?: boolean;           // don't render the built-in button
  open?: boolean;                  // controlled open (with hideTrigger)
  onOpenChange?: (open: boolean) => void;
  anchorRef?: React.RefObject<HTMLElement | null>; // where to position when controlled
}

function mondayOf(d: Date): Date {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const POP_W = 312;
const POP_H = 404;

export default function DatePicker({ value, onChange, placeholder = "Select date", weekMode = false, maxDate, hideTrigger = false, open: openProp, onOpenChange, anchorRef }: Props) {
  const selected = parseISO(value);
  const [openState, setOpenState] = useState(false);
  const open = openProp !== undefined ? openProp : openState;
  const setOpen = (v: boolean) => { onOpenChange ? onOpenChange(v) : setOpenState(v); };
  const [view, setView] = useState<Date>(selected ?? new Date());
  /** days → pick a day; months → pick a month of the year; years → pick a year. */
  const [mode, setMode] = useState<"days" | "months" | "years">("days");
  const [dir, setDir] = useState<1 | -1>(1);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const positionFrom = (el: HTMLElement | null) => {
    const r = el?.getBoundingClientRect();
    if (r) {
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < POP_H + 12 && r.top > spaceBelow; // not enough room below → open upward
      const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
      if (openUp) setPos({ bottom: window.innerHeight - r.top + 8, left });
      else setPos({ top: r.bottom + 8, left });
    }
    setView(selected ?? new Date());
    setMode("days");
  };
  const openPicker = () => { positionFrom(btnRef.current); setOpen(true); };

  // When controlled-open becomes true, position from the external anchor.
  useEffect(() => {
    if (openProp && anchorRef?.current) positionFrom(anchorRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openProp]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); if (mode !== "days") setMode("days"); else setOpen(false); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  const y = view.getFullYear();
  const m = view.getMonth();
  const today = new Date();
  const maxD = maxDate ? parseISO(maxDate) : null;
  const sameDay = (a: Date | null, b: Date) => !!a && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const isDisabled = (d: Date) => !!(maxD && d > maxD);

  // Six full weeks, Monday first, with the neighbouring months' days filled in.
  const start = mondayOf(new Date(y, m, 1));
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + w * 7 + i); return d;
  }));
  const selMonday = selected ? mondayOf(selected).getTime() : null;
  const [hoverWeek, setHoverWeek] = useState<number | null>(null);

  const shift = (n: 1 | -1) => {
    setDir(n);
    if (mode === "days") setView(new Date(y, m + n, 1));
    else if (mode === "months") setView(new Date(y + n, m, 1));
    else setView(new Date(y + n * 12, m, 1));
  };
  const pick = (d: Date) => {
    if (isDisabled(d)) return;
    const chosen = weekMode ? mondayOf(d) : d;
    onChange(toISO(chosen));
    setOpen(false);
  };
  const goToday = () => {
    if (isDisabled(today)) return;
    pick(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  };

  const label = selected
    ? `${selected.getDate()} ${MONTHS_SHORT[selected.getMonth()]} ${selected.getFullYear()}`
    : placeholder;
  const yearStart = y - (y % 12);
  const viewKey = `${mode}-${mode === "years" ? yearStart : y}-${mode === "days" ? m : ""}`;

  return (
    <>
      {!hideTrigger && (
      <button
        ref={btnRef}
        type="button"
        className={`dp-trigger ${selected ? "" : "is-empty"} ${open ? "is-open" : ""}`}
        onClick={openPicker}
      >
       <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <rect x="3" y="4.5" width="18" height="16" rx="3" />
          <path d="M3 9h18M8 2.5v4M16 2.5v4" />
        </svg>
        <span>{label}</span>
      </button>
      )}

      {open &&
        createPortal(
          <>
            <div className="dp-layer" onMouseDown={() => setOpen(false)} />
            <div className={`dp-pop ${pos.bottom !== undefined ? "is-up" : ""}`} style={{ top: pos.top, bottom: pos.bottom, left: pos.left }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Pick a date">
              <div className="dp-top">
                <span className="dp-top-k">{weekMode ? "Week of" : selected ? "Selected" : "Pick a date"}</span>
                <b className="dp-top-v" key={value}>
                  {selected
                    ? weekMode
                      ? `${mondayOf(selected).getDate()} ${MONTHS_SHORT[mondayOf(selected).getMonth()]} – ${(() => { const e = mondayOf(selected); e.setDate(e.getDate() + 6); return `${e.getDate()} ${MONTHS_SHORT[e.getMonth()]}`; })()}`
                      : `${DAY_NAMES[selected.getDay()].slice(0, 3)}, ${selected.getDate()} ${MONTHS_SHORT[selected.getMonth()]} ${selected.getFullYear()}`
                    : "—"}
                </b>
              </div>

              <div className="dp-head">
                <button type="button" className="dp-nav" onClick={() => shift(-1)} aria-label="Previous">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <div className="dp-title" key={viewKey}>
                  {mode === "years" ? (
                    <button type="button" className="dp-title-btn" onClick={() => setMode("days")}>{yearStart} – {yearStart + 11}</button>
                  ) : (
                    <>
                      {mode === "days" && <button type="button" className="dp-title-btn" onClick={() => setMode("months")}>{MONTHS[m]}</button>}
                      <button type="button" className="dp-title-btn is-year" onClick={() => setMode(mode === "months" ? "years" : "years")}>{y}</button>
                    </>
                  )}
                </div>
                <button type="button" className="dp-nav" onClick={() => shift(1)} aria-label="Next">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              </div>

              <div className={`dp-body ${dir === 1 ? "is-next" : "is-prev"}`} key={viewKey}>
                {mode === "days" && (
                  <>
                    <div className="dp-wd">{WD.map((d, i) => <span key={d} className={i > 4 ? "is-we" : ""}>{d.slice(0, 1)}</span>)}</div>
                    <div className="dp-weeks" onMouseLeave={() => setHoverWeek(null)}>
                      {weeks.map((wk) => {
                        const mon = mondayOf(wk[0]).getTime();
                        return (
                          <div key={mon} className={`dp-week ${weekMode ? "is-weekmode" : ""} ${weekMode && selMonday === mon ? "is-sel" : ""} ${weekMode && hoverWeek === mon ? "is-hover" : ""}`}
                            onMouseEnter={() => weekMode && setHoverWeek(mon)}>
                            {wk.map((d) => {
                              const out = d.getMonth() !== m;
                              const dis = isDisabled(d);
                              const sel = !weekMode && sameDay(selected, d);
                              return (
                                <button key={d.toISOString()} type="button" disabled={dis}
                                  className={`dp-cell ${out ? "is-out" : ""} ${sel ? "is-sel" : ""} ${sameDay(today, d) ? "is-today" : ""} ${d.getDay() === 0 || d.getDay() === 6 ? "is-we" : ""} ${dis ? "is-disabled" : ""}`}
                                  onClick={() => pick(d)}>
                                  {d.getDate()}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
                {mode === "months" && (
                  <div className="dp-big">
                    {MONTHS_SHORT.map((mn, i) => (
                      <button key={mn} type="button"
                        className={`dp-big-cell ${selected && selected.getFullYear() === y && selected.getMonth() === i ? "is-sel" : ""} ${today.getFullYear() === y && today.getMonth() === i ? "is-today" : ""}`}
                        onClick={() => { setDir(1); setView(new Date(y, i, 1)); setMode("days"); }}>
                        {mn}
                      </button>
                    ))}
                  </div>
                )}
                {mode === "years" && (
                  <div className="dp-big">
                    {Array.from({ length: 12 }, (_, i) => yearStart + i).map((yr) => (
                      <button key={yr} type="button"
                        className={`dp-big-cell ${selected && selected.getFullYear() === yr ? "is-sel" : ""} ${today.getFullYear() === yr ? "is-today" : ""}`}
                        onClick={() => { setDir(1); setView(new Date(yr, m, 1)); setMode("months"); }}>
                        {yr}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="dp-foot">
                <button type="button" className="dp-today" onClick={goToday} disabled={isDisabled(today)}>
                  {weekMode ? "This week" : "Today"}
                </button>
                {selected && (mode !== "days" || selected.getMonth() !== m || selected.getFullYear() !== y) && (
                  <button type="button" className="dp-jump" onClick={() => { setDir(selected < view ? -1 : 1); setView(new Date(selected.getFullYear(), selected.getMonth(), 1)); setMode("days"); }}>
                    Back to selected
                  </button>
                )}
              </div>
            </div>
          </>,
          document.body
        )}
    </>
  );
}
