import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./MultiSelect.css";

export interface MultiOption { value: string; label: string }

interface Props {
  values: string[];
  onChange: (values: string[]) => void;
  options: MultiOption[];
  /** Shown when nothing is selected (= no filter). */
  placeholder: string;
  /** Word for the selection count, e.g. "stages" -> "3 stages". */
  noun?: string;
  /** Show a search box once there are more options than this. */
  searchFrom?: number;
}

/**
 * Multi-select dropdown. Uses the same `sel-trigger` classes as the
 * single Select so existing filter-bar styling applies unchanged.
 * The menu is portalled to <body> so no overflow/transform ancestor clips it.
 */
export default function MultiSelect({ values, onChange, options, placeholder, noun, searchFrom = 7 }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null);
  const trigRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => new Set(values), [values]);
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? options.filter((o) => o.label.toLowerCase().includes(n)) : options;
  }, [options, q]);

  const place = () => {
    const r = trigRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 230);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 220 && above > below;
    const maxH = Math.max(160, Math.min(360, up ? above : below));
    setPos({ top: up ? r.top - 6 - maxH : r.bottom + 6, left, width, maxH });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || trigRef.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigRef.current?.focus(); } };
    // scrolling inside the menu itself must not move (or re-measure) it: that threw the list back to the top
    const re = (e?: Event) => { if (e && menuRef.current?.contains(e.target as Node)) return; place(); };
    window.addEventListener("mousedown", off, true);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", re);
    window.addEventListener("scroll", re, true);
    return () => {
      window.removeEventListener("mousedown", off, true);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("resize", re);
      window.removeEventListener("scroll", re, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!open) setQ(""); }, [open]);

  const toggle = (v: string) => onChange(selected.has(v) ? values.filter((x) => x !== v) : [...values, v]);

  const label = values.length === 0
    ? placeholder
    : values.length === 1
      ? labelOf(values[0])
      : noun ? `${values.length} ${noun}` : `${labelOf(values[0])} +${values.length - 1}`;

  return (
    <div className="msel">
      <button
        ref={trigRef}
        type="button"
        className={`sel-trigger msel-trigger ${values.length === 0 ? "is-empty" : "is-set"} ${open ? "is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={values.length > 1 ? values.map(labelOf).join(", ") : undefined}
      >
        <span className="msel-label">{label}</span>
        {values.length > 1 && <span className="msel-count">{values.length}</span>}
        {values.length > 0 ? (
          <span
            className="msel-clear"
            role="button"
            aria-label="Clear"
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
          >×</span>
        ) : (
          <svg className="msel-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        )}
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="msel-menu"
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }}
          onMouseDown={(e) => e.stopPropagation()}
          role="listbox"
          aria-multiselectable="true"
        >
          {options.length > searchFrom && (
            <input className="msel-search" autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          <div className="msel-actions">
            <button type="button" onClick={() => onChange(Array.from(new Set([...values, ...shown.map((o) => o.value)])))}>Select all</button>
            <button type="button" onClick={() => onChange([])} disabled={!values.length}>Clear</button>
          </div>
          <div className="msel-list">
            {shown.length === 0 && <div className="msel-empty">No matches</div>}
            {shown.map((o) => {
              const on = selected.has(o.value);
              return (
                <button type="button" key={o.value} className={`msel-opt ${on ? "is-on" : ""}`} onClick={() => toggle(o.value)} role="option" aria-selected={on}>
                  <span className="msel-box">
                    {on && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
                  </span>
                  <span className="msel-opt-label">{o.label}</span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}