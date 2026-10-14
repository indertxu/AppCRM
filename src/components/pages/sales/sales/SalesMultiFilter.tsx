import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./SalesMultiFilter.css";

export interface SmfOption { value: string; label: string }

interface Props {
  values: string[];
  onChange: (values: string[]) => void;
  options: SmfOption[];
  /** Shown when nothing is selected (= no filter). */
  placeholder: string;
  /** Word for the selection count, e.g. "stages" -> "3 stages". */
  noun?: string;
  /** Show a search box once there are more options than this. */
  searchFrom?: number;
  /** Pick exactly one option (a view setting, not a filter): radio list, closes on pick, no clear. */
  single?: boolean;
}

/**
 * Multi-select filter for the Sales page. Self-contained (own class names),
 * so it can never collide with the shared Select or another MultiSelect.
 * The menu is portalled to <body> so no overflow/transform ancestor clips it.
 */
export default function SalesMultiFilter({ values, onChange, options, placeholder, noun, searchFrom = 7, single = false }: Props) {
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
    const re = () => place();
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

  const toggle = (v: string) => {
    if (single) { onChange([v]); setOpen(false); return; }
    onChange(selected.has(v) ? values.filter((x) => x !== v) : [...values, v]);
  };

  const label = single
    ? (values[0] ? labelOf(values[0]) : placeholder)
    : values.length === 0
    ? placeholder
    : values.length === 1
      ? labelOf(values[0])
      : noun ? `${values.length} ${noun}` : `${labelOf(values[0])} +${values.length - 1}`;

  return (
    <div className="smf">
      <button
        ref={trigRef}
        type="button"
        className={`smf-trigger ${single ? "is-single" : values.length === 0 ? "is-empty" : "is-set"} ${open ? "is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={values.length > 1 ? values.map(labelOf).join(", ") : undefined}
      >
        <span className="smf-label">{label}</span>
        {!single && values.length > 1 && <span className="smf-count">{values.length}</span>}
        {!single && values.length > 0 ? (
          <span
            className="smf-clear"
            role="button"
            aria-label="Clear"
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
          >×</span>
        ) : (
          <svg className="smf-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        )}
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="smf-menu"
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }}
          onMouseDown={(e) => e.stopPropagation()}
          role="listbox"
          aria-multiselectable={!single}
        >
          {options.length > searchFrom && (
            <input className="smf-search" autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          {!single && <div className="smf-actions">
            <button type="button" onClick={() => onChange(Array.from(new Set([...values, ...shown.map((o) => o.value)])))}>Select all</button>
            <button type="button" onClick={() => onChange([])} disabled={!values.length}>Clear</button>
          </div>}
          <div className="smf-list">
            {shown.length === 0 && <div className="smf-empty">No matches</div>}
            {shown.map((o) => {
              const on = selected.has(o.value);
              return (
                <button type="button" key={o.value} className={`smf-opt ${on ? "is-on" : ""} ${single ? "is-radio" : ""}`} onClick={() => toggle(o.value)} role="option" aria-selected={on}>
                  <span className="smf-box">
                    {on && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
                  </span>
                  <span className="smf-opt-label">{o.label}</span>
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