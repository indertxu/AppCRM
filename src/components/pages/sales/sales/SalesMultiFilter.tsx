import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./SalesMultiFilter.css";

export interface SmfOption { value: string; label: string; /** Optional heading the option is listed under. */ group?: string; /** Optional small text after the label. */ hint?: string; /** Optional accent: "status" | "muted". */ tone?: string }

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
export interface PopPos { top: number; left: number; width: number; maxH: number; up: boolean }

/**
 * Where a popover fits on screen: under its trigger when there is room, above it
 * when there is room there instead, otherwise on the roomier side with the
 * popover scrolling inside. Always kept inside the window, horizontally too.
 */
export function fitPopover(
  r: DOMRect, natural: number, width: number,
  opts: { gap?: number; margin?: number; cap?: number; align?: "left" | "right" | "center" } = {},
): PopPos {
  const gap = opts.gap ?? 6, m = opts.margin ?? 12;
  const vw = window.innerWidth, vh = window.innerHeight;
  const h = Math.min(natural, opts.cap ?? Infinity);
  const below = vh - r.bottom - gap - m;
  const above = r.top - gap - m;
  let up = false, maxH = h;
  if (h <= below) up = false;
  else if (h <= above) up = true;
  else { up = above > below + 40; maxH = Math.max(140, up ? above : below); }
  const shown = Math.min(h, maxH);
  const top = up ? Math.max(m, r.top - gap - shown) : Math.min(r.bottom + gap, vh - m - shown);
  const w = Math.min(width, vw - m * 2);
  const want = opts.align === "right" ? r.right - w : opts.align === "center" ? r.left + r.width / 2 - w / 2 : r.left;
  return { top, left: Math.max(m, Math.min(want, vw - w - m)), width: w, maxH: shown, up };
}

export default function SalesMultiFilter({ values, onChange, options, placeholder, noun, searchFrom = 7, single = false }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<PopPos | null>(null);
  const trigRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => new Set(values), [values]);
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? options.filter((o) => `${o.label} ${o.group ?? ""}`.toLowerCase().includes(n)) : options;
  }, [options, q]);

  const place = () => {
    const r = trigRef.current?.getBoundingClientRect();
    if (!r) return;
    // Measure the menu at its full height, then put it where it fits.
    const el = menuRef.current;
    let natural = 360;
    if (el) { const prev = el.style.maxHeight; el.style.maxHeight = "none"; natural = el.offsetHeight; el.style.maxHeight = prev; }
    const next = fitPopover(r, natural, Math.max(r.width, 230), { cap: 420 });
    setPos((cur) => (cur && cur.top === next.top && cur.left === next.left && cur.width === next.width && cur.maxH === next.maxH && cur.up === next.up ? cur : next));
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once the menu is on screen (and whenever its content changes size), place it again from its real height.
  useLayoutEffect(() => { if (open && pos) place(); }, [open, !!pos, shown.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
          className={`smf-menu ${pos.up ? "is-up" : ""}`}
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
            {shown.map((o, k) => {
              const on = selected.has(o.value);
              const head = o.group && o.group !== shown[k - 1]?.group ? o.group : null;
              return (
                <div key={o.value} className="smf-row">
                  {head && <div className="smf-group">{head}</div>}
                  <button type="button" className={`smf-opt ${on ? "is-on" : ""} ${single ? "is-radio" : ""} ${o.tone ? `is-${o.tone}` : ""}`} onClick={() => toggle(o.value)} role="option" aria-selected={on}>
                    <span className="smf-box">
                      {on && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
                    </span>
                    <span className="smf-opt-label">{o.label}</span>
                    {o.hint && <span className="smf-opt-hint">{o.hint}</span>}
                  </button>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}