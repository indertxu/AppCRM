import { useState, useRef } from "react";
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
}

export default function DatePicker({ value, onChange, placeholder = "Select date" }: Props) {
  const selected = parseISO(value);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(selected ?? new Date());
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const openPicker = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const below = r.bottom + 6;
      const wouldOverflow = below + 320 > window.innerHeight;
      setPos({
        top: wouldOverflow ? r.top - 326 : below,
        left: Math.min(r.left, window.innerWidth - 276),
      });
    }
    setView(selected ?? new Date());
    setOpen(true);
  };

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

  const label = selected
    ? `${selected.getDate()} ${MONTHS_SHORT[selected.getMonth()]} ${selected.getFullYear()}`
    : placeholder;

  return (
    <>
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

      {open &&
        createPortal(
          <>
            <div className="dp-layer" onMouseDown={() => setOpen(false)} />
            <div className="dp-pop" style={{ top: pos.top, left: pos.left }} onMouseDown={(e) => e.stopPropagation()}>
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
                      className={`dp-cell ${isSel(d) ? "is-sel" : ""} ${isToday(d) ? "is-today" : ""}`}
                      onClick={() => { onChange(toISO(new Date(y, m, d))); setOpen(false); }}
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