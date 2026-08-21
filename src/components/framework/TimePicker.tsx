import { useEffect, useRef, useState } from "react";
import "./TimePicker.css";

interface Props {
  value: string;                      // "HH:MM" 24h, or ""
  onChange: (hhmm: string) => void;
  placeholder?: string;
  minuteStep?: number;                // default 5
}

const pad = (n: number) => String(n).padStart(2, "0");

export default function TimePicker({ value, onChange, placeholder = "Select time", minuteStep = 5 }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hourColRef = useRef<HTMLDivElement>(null);
  const minColRef = useRef<HTMLDivElement>(null);

  const [h, m] = value ? value.split(":").map((x) => parseInt(x, 10)) : [NaN, NaN];
  const hasVal = !Number.isNaN(h) && !Number.isNaN(m);

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Scroll the selected hour/minute into view when opening.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      hourColRef.current?.querySelector(".tp-opt.is-sel")?.scrollIntoView({ block: "center" });
      minColRef.current?.querySelector(".tp-opt.is-sel")?.scrollIntoView({ block: "center" });
    });
  }, [open]);

  const pick = (nh: number, nm: number) => onChange(`${pad(nh)}:${pad(nm)}`);
  const setHour = (nh: number) => pick(nh, Number.isNaN(m) ? 0 : m);
  const setMin = (nm: number) => pick(Number.isNaN(h) ? 0 : h, nm);

  return (
    <div className="tp" ref={wrapRef}>
      <button type="button" className={`tp-trigger ${hasVal ? "has-val" : ""}`} onClick={() => setOpen((v) => !v)}>
        <svg className="tp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
        <span className="tp-val">{hasVal ? `${pad(h)}:${pad(m)}` : placeholder}</span>
        <svg className="tp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>

      {open && (
        <div className="tp-pop">
          <div className="tp-cols">
            <div className="tp-col" ref={hourColRef}>
              <span className="tp-col-h">Hour</span>
              <div className="tp-scroll">
                {hours.map((hh) => (
                  <button key={hh} type="button" className={`tp-opt ${hh === h ? "is-sel" : ""}`} onClick={() => setHour(hh)}>{pad(hh)}</button>
                ))}
              </div>
            </div>
            <div className="tp-col" ref={minColRef}>
              <span className="tp-col-h">Min</span>
              <div className="tp-scroll">
                {minutes.map((mm) => (
                  <button key={mm} type="button" className={`tp-opt ${mm === m ? "is-sel" : ""}`} onClick={() => setMin(mm)}>{pad(mm)}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="tp-quick">
            {["09:00", "12:00", "15:00", "17:30"].map((q) => (
              <button key={q} type="button" className="tp-quick-btn" onClick={() => { onChange(q); setOpen(false); }}>{q}</button>
            ))}
            <button type="button" className="tp-done" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}