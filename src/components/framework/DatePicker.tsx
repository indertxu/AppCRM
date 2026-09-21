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

export default function DatePicker({ value, onChange, placeholder = "Select date", weekMode = false, maxDate, hideTrigger = false, open: openProp, onOpenChange, anchorRef }: Props) {
  const selected = parseISO(value);
  const [openState, setOpenState] = useState(false);
  const open = openProp !== undefined ? openProp : openState;
  const setOpen = (v: boolean) => { onOpenChange ? onOpenChange(v) : setOpenState(v); };
  const [view, setView] = useState<Date>(selected ?? new Date());
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const positionFrom = (el: HTMLElement | null) => {
    const r = el?.getBoundingClientRect();
    if (r) {
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < 340 && r.top > spaceBelow; // not enough room below → open upward
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 276));
      if (openUp) {
        // anchor the popup's BOTTOM just above the field, so it hugs the field
        setPos({ bottom: window.innerHeight - r.top + 6, left });
      } else {
        setPos({ top: r.bottom + 6, left });
      }
    }
    setView(selected ?? new Date());
  };
  const openPicker = () => { positionFrom(btnRef.current); setOpen(true); };

  // When controlled-open becomes true, position from the external anchor.
  useEffect(() => {
    if (openProp && anchorRef?.current) positionFrom(anchorRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openProp]);

  const y = view.getFullYear();
  const m = view.getMonth();
  const firstOffset = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = new Date();
  const cells: (number | null)[] = [
    ...Array(firstOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const isSel = (d: number) =>
    selected && selected.getFullYear() === y && selected.getMonth() === m && selected.getDate() === d;
  const isToday = (d: number) =>
    today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;

  // Week-mode: is this day in the same week as the selected date?
  const selMonday = selected ? mondayOf(selected) : null;
  const inSelWeek = (d: number) => {
    if (!weekMode || !selMonday) return false;
    const cur = mondayOf(new Date(y, m, d));
    return cur.getTime() === selMonday.getTime();
  };
  const [hoverWeek, setHoverWeek] = useState<number | null>(null);
  const inHoverWeek = (d: number) => {
    if (!weekMode || hoverWeek === null) return false;
    return mondayOf(new Date(y, m, d)).getTime() === mondayOf(new Date(y, m, hoverWeek)).getTime();
  };
  const maxD = maxDate ? parseISO(maxDate) : null;
  const isDisabled = (d: number) => !!(maxD && new Date(y, m, d) > maxD);

  const pick = (d: number) => {
    if (isDisabled(d)) return;
    const chosen = weekMode ? mondayOf(new Date(y, m, d)) : new Date(y, m, d);
    onChange(toISO(chosen));
    setOpen(false);
  };

  const label = selected
    ? `${selected.getDate()} ${MONTHS_SHORT[selected.getMonth()]} ${selected.getFullYear()}`
    : placeholder;

  return (
    <>
      {!hideTrigger && (
      <button
        ref={btnRef}
        type="button"
        className={`dp-trigger ${selected ? "" : "is-empty"}`}
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
            <div className="dp-pop" style={{ top: pos.top, bottom: pos.bottom, left: pos.left }} onMouseDown={(e) => e.stopPropagation()}>
              <div className="dp-head">
                <button type="button" className="dp-nav" onClick={() => setView(new Date(y, m - 1, 1))}>‹</button>
                <span className="dp-month">{MONTHS[m]} {y}</span>
                <button type="button" className="dp-nav" onClick={() => setView(new Date(y, m + 1, 1))}>›</button>
              </div>
              <div className="dp-grid dp-wd">
                {WD.map((d) => <span key={d} className="dp-wd-cell">{d}</span>)}
              </div>
              <div className="dp-grid">
                {cells.map((d, i) =>
                  d === null ? (
                    <span key={i} className="dp-cell dp-empty" />
                  ) : (
                    <button
                      key={i}
                      type="button"
                      className={`dp-cell ${isSel(d) ? "is-sel" : ""} ${isToday(d) ? "is-today" : ""} ${inSelWeek(d) ? "in-week" : ""} ${inHoverWeek(d) ? "hover-week" : ""} ${isDisabled(d) ? "is-disabled" : ""}`}
                      disabled={isDisabled(d)}
                      onMouseEnter={() => weekMode && setHoverWeek(d)}
                      onMouseLeave={() => weekMode && setHoverWeek(null)}
                      onClick={() => pick(d)}
                    >
                      {d}
                    </button>
                  )
                )}
              </div>
            </div>
          </>,
          document.body
        )}
    </>
  );
}