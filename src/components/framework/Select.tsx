import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import "./Select.css";

export interface SelectOption {
  value: string;
  label: string;
  /** A second, quieter line (or a note at the right in the compact size). */
  hint?: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** "sm": a compact trigger for toolbars, filter rows and table cells. */
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
  /** Show a search box (on by default from 10 options). */
  searchable?: boolean;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * The app's dropdown: a themed trigger and a floating list (never the browser's own menu).
 * Keyboard: ↑ ↓ to move, Enter to pick, Esc to close, type to search when the list is long.
 */
export default function Select({ value, onChange, options, placeholder = "Select…", disabled, size = "md", className, searchable, ...rest }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number; maxWidth: number; maxH: number }>({ top: 0, left: 0, minWidth: 0, maxWidth: 0, maxH: 260 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value);
  const withSearch = searchable ?? options.length >= 10;
  const shown = q ? options.filter((o) => fold(`${o.label} ${o.hint ?? ""}`).includes(fold(q))) : options;

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const want = Math.min(shown.length * (size === "sm" ? 34 : 40) + (withSearch ? 50 : 0) + 12, 320);
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const drop = below >= want || below >= above;
    const maxH = Math.max(140, Math.min(320, drop ? below - 6 : above - 6));
    // at least as wide as the trigger; may grow for long options, never past the window edge
    setPos({
      top: drop ? r.bottom + 6 : Math.max(8, r.top - Math.min(want, maxH) - 6),
      left: r.left,
      minWidth: Math.max(r.width, size === "sm" ? 160 : 150),
      maxWidth: Math.max(r.width, window.innerWidth - r.left - 12),
      maxH,
    });
  };
  const openMenu = () => {
    if (disabled) return;
    setQ("");
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    place();
    setOpen(true);
  };
  const pick = (o: SelectOption) => { if (o.disabled) return; onChange(o.value); setOpen(false); btnRef.current?.focus(); };

  // follow the trigger when the page or a panel scrolls
  useEffect(() => {
    if (!open) return;
    const onMove = (e: Event) => { if (!listRef.current?.contains(e.target as Node)) place(); };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => { window.removeEventListener("scroll", onMove, true); window.removeEventListener("resize", onMove); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openMenu(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[hi]) pick(shown[hi]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); btnRef.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sel-trigger ${size === "sm" ? "is-sm" : ""} ${current ? "" : "is-empty"} ${open ? "is-open" : ""} ${className ?? ""}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKey}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={rest["aria-label"]}
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
              ref={listRef}
              className={`sel-pop ${size === "sm" ? "is-sm" : ""}`}
              role="listbox"
              style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth, maxWidth: pos.maxWidth, maxHeight: pos.maxH }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {withSearch && (
                <div className="sel-search">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                  <input autoFocus value={q} placeholder="Search…" onChange={(e) => { setQ(e.target.value); setHi(0); }} onKeyDown={onKey} />
                </div>
              )}
              {shown.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  data-i={i}
                  role="option"
                  aria-selected={o.value === value}
                  disabled={o.disabled}
                  className={`sel-option ${o.value === value ? "is-sel" : ""} ${i === hi ? "is-hi" : ""}`}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(o)}
                >
                  <span>{o.label}{o.hint && <small>{o.hint}</small>}</span>
                  {o.value === value && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  )}
                </button>
              ))}
              {!shown.length && <p className="sel-none">No matches</p>}
            </div>
          </>,
          document.body
        )}
    </>
  );
}
