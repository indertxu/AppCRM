import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hourColRef = useRef<HTMLDivElement>(null);
  const minColRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean }>({ top: 0, left: 0, up: false });

  const [h, m] = value ? value.split(":").map((x) => parseInt(x, 10)) : [NaN, NaN];
  const hasVal = !Number.isNaN(h) && !Number.isNaN(m);

  // Free-typing field state (kept separate so partial input doesn't break value).
  const [typed, setTyped] = useState("");
  useEffect(() => { setTyped(hasVal ? `${pad(h)}:${pad(m)}` : ""); }, [value, open]);

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep);

  const openPicker = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const popH = 320;
      const spaceBelow = window.innerHeight - r.bottom;
      const up = spaceBelow < popH && r.top > spaceBelow;
      setPos({ top: up ? r.top - 6 : r.bottom + 6, left: Math.min(r.left, window.innerWidth - 256), up });
    }
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

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

  // Parse a free-typed "H:M" / "HHMM" / "HH:MM" into a valid time.
  const commitTyped = (raw: string) => {
    const digits = raw.replace(/[^\d]/g, "");
    if (digits.length === 0) return;
    let nh: number, nm: number;
    if (digits.length <= 2) { nh = parseInt(digits, 10); nm = 0; }
    else { nh = parseInt(digits.slice(0, digits.length - 2), 10); nm = parseInt(digits.slice(-2), 10); }
    if (Number.isNaN(nh)) nh = 0;
    if (Number.isNaN(nm)) nm = 0;
    nh = Math.max(0, Math.min(23, nh));
    nm = Math.max(0, Math.min(59, nm));
    onChange(`${pad(nh)}:${pad(nm)}`);
  };

  return (
    <div className="tp" ref={wrapRef}>
      <button ref={btnRef} type="button" className={`tp-trigger ${hasVal ? "has-val" : ""}`} onClick={openPicker}>
        <svg className="tp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
        <span className="tp-val">{hasVal ? `${pad(h)}:${pad(m)}` : placeholder}</span>
        <svg className="tp-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>

      {open && createPortal(
        <div ref={popRef} className="tp-pop"
          style={{ position: "fixed", left: pos.left, top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined }}
          onMouseDown={(e) => e.stopPropagation()}>

          {/* type-in field */}
          <div className="tp-typewrap">
            <input
              className="tp-type"
              value={typed}
              onChange={(e) => {
                // Keep digits only, cap at 4, and auto-insert ":" after the 2nd.
                const digits = e.target.value.replace(/[^\d]/g, "").slice(0, 4);
                setTyped(digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") { commitTyped(typed); setOpen(false); } }}
              onBlur={() => commitTyped(typed)}
              placeholder="HH:MM"
              inputMode="numeric"
              maxLength={5}
              autoFocus
            />
            <span className="tp-type-hint">Type or pick below</span>
          </div>

          <div className="tp-cols">
            <div className="tp-col" ref={hourColRef}>
              <span className="tp-col-h">Hour</span>
              <div className="tp-scroll">
                {hours.map((hh) => (
                  <button key={hh} type="button" className={`tp-opt ${hh === h ? "is-sel" : ""}`} onClick={() => setHour(hh)}>{pad(hh)}</button>
                ))}
              </div>
            </div>
            <div className="tp-colsep" />
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
              <button key={q} type="button" className={`tp-quick-btn ${value === q ? "is-on" : ""}`} onClick={() => { onChange(q); setOpen(false); }}>{q}</button>
            ))}
            <button type="button" className="tp-done" onClick={() => { commitTyped(typed); setOpen(false); }}>Done</button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}