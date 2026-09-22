import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import "./Select.css";

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}

export default function Select({ value, onChange, options, placeholder = "Select…", disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number; maxWidth: number; drop: boolean }>({
    top: 0, left: 0, minWidth: 0, maxWidth: 0, drop: true,
  });
  const btnRef = useRef<HTMLButtonElement>(null);

  const current = options.find((o) => o.value === value);

  const toggle = () => {
    if (disabled) return;
    if (open) return setOpen(false);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const spaceBelow = window.innerHeight - r.bottom;
      const listH = Math.min(options.length * 40 + 8, 260);
      const drop = spaceBelow > listH + 8 || spaceBelow > r.top;
      // The menu is at least as wide as the trigger, but may grow to fit a long
      // option. It never runs past the right edge of the window (min 12px gap).
      setPos({
        top: drop ? r.bottom + 6 : r.top - listH - 6,
        left: r.left,
        minWidth: r.width,
        maxWidth: Math.max(r.width, window.innerWidth - r.left - 12),
        drop,
      });
    }
    setOpen(true);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sel-trigger ${current ? "" : "is-empty"} ${open ? "is-open" : ""}`}
        onClick={toggle}
        disabled={disabled}
      >
        <span>{current?.label ?? placeholder}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open &&
        createPortal(
          <>
            <div className="sel-layer" onMouseDown={() => setOpen(false)} />
            <div
              className="sel-pop"
              style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth, maxWidth: pos.maxWidth }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`sel-option ${o.value === value ? "is-sel" : ""}`}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                >
                  <span>{o.label}</span>
                  {o.value === value && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </>
  );
}