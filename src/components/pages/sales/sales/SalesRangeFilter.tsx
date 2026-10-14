import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../../framework/DatePicker";
import "./SalesRangeFilter.css";

/** null = that side is open. Same min and max = an exact value. */
export interface SalesRanges {
  probMin: number | null; probMax: number | null;
  dateFrom: string | null; dateTo: string | null;
  revMin: number | null; revMax: number | null;
}
export const EMPTY_RANGES: SalesRanges = { probMin: null, probMax: null, dateFrom: null, dateTo: null, revMin: null, revMax: null };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtDate = (s: string) => {
  const d = new Date(`${s}T00:00:00`);
  return isNaN(+d) ? s : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const fmtEur = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/** How many of the three ranges are active. */
export const activeRangeCount = (r: SalesRanges) =>
  [r.probMin !== null || r.probMax !== null, !!(r.dateFrom || r.dateTo), r.revMin !== null || r.revMax !== null].filter(Boolean).length;

function describe(r: SalesRanges): string[] {
  const out: string[] = [];
  const span = (a: string | null, b: string | null, unit = "") =>
    a !== null && b !== null ? (a === b ? `${a}${unit}` : `${a}–${b}${unit}`) : a !== null ? `≥ ${a}${unit}` : `≤ ${b}${unit}`;
  if (r.probMin !== null || r.probMax !== null) out.push(`Prob ${span(r.probMin?.toString() ?? null, r.probMax?.toString() ?? null, "%")}`);
  if (r.dateFrom || r.dateTo) out.push(`Close ${span(r.dateFrom ? fmtDate(r.dateFrom) : null, r.dateTo ? fmtDate(r.dateTo) : null)}`);
  if (r.revMin !== null || r.revMax !== null) out.push(`Rev ${span(r.revMin !== null ? fmtEur(r.revMin) : null, r.revMax !== null ? fmtEur(r.revMax) : null, " €")}`);
  return out;
}

function NumBox({ value, onChange, placeholder, suffix, max }: {
  value: number | null; onChange: (v: number | null) => void; placeholder: string; suffix: string; max?: number;
}) {
  return (
    <label className="srf-num">
      <input
        type="number" inputMode="decimal" min={0} max={max} placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => {
          if (e.target.value === "") return onChange(null);
          const n = Number(e.target.value);
          if (!isNaN(n)) onChange(max !== undefined ? Math.min(max, Math.max(0, n)) : Math.max(0, n));
        }}
      />
      <em>{suffix}</em>
    </label>
  );
}

function datePresets(): { label: string; from: string; to: string }[] {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) * 3;
  return [
    { label: "This month", from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)) },
    { label: "Next 30 days", from: iso(now), to: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30)) },
    { label: "This quarter", from: iso(new Date(now.getFullYear(), q, 1)), to: iso(new Date(now.getFullYear(), q + 3, 0)) },
    { label: "Overdue", from: "", to: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)) },
  ];
}

export type RangeKind = "prob" | "rev" | "close";

/** Is the range for one column active? */
export const rangeActive = (r: SalesRanges, k: RangeKind) =>
  k === "prob" ? r.probMin !== null || r.probMax !== null
  : k === "rev" ? r.revMin !== null || r.revMax !== null
  : !!(r.dateFrom || r.dateTo);

/** The same ranges with one column's range removed. */
export const clearRange = (r: SalesRanges, k: RangeKind): SalesRanges =>
  k === "prob" ? { ...r, probMin: null, probMax: null }
  : k === "rev" ? { ...r, revMin: null, revMax: null }
  : { ...r, dateFrom: null, dateTo: null };

/**
 * A single-column range popover, anchored to a list column header (3rd click
 * on the header). Edits the same ranges as the "Any range" pill, live.
 */
export function HeaderRangePopover({ kind, anchor, value, onChange, onClose, probLabel }: {
  kind: RangeKind; anchor: DOMRect; value: SalesRanges;
  onChange: (v: SalesRanges) => void; onClose: () => void; probLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<SalesRanges>) => onChange({ ...value, ...patch });
  const w = 320;
  const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - w / 2, window.innerWidth - w - 8));
  const top = Math.min(anchor.bottom + 8, window.innerHeight - 260);

  useEffect(() => {
    const off = (e: MouseEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest?.(".dp-layer, .dp-pop, [data-head-range]")) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".dp-pop")) onClose(); };
    window.addEventListener("mousedown", off, true);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", onClose);
    return () => { window.removeEventListener("mousedown", off, true); window.removeEventListener("keydown", esc); window.removeEventListener("resize", onClose); };
  }, [onClose]);

  const title = kind === "prob" ? "Close chance" : kind === "rev" ? "Potential" : "Close date";
  const sub = kind === "prob" ? probLabel : kind === "rev" ? "Potential value" : "Expected close";
  return createPortal(
    <div ref={ref} className="srf-panel srf-head-pop" style={{ top, left, width: w }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`${title} range`}>
      <span className="srf-head-arrow" style={{ left: Math.max(18, Math.min(w - 18, anchor.left + anchor.width / 2 - left)) }} />
      <section className="srf-sec">
        <header><b>{title} range</b><span>{sub}</span>
          {rangeActive(value, kind) && <button onClick={() => onChange(clearRange(value, kind))}>Clear</button>}</header>
        {kind === "close" ? (
          <>
            <div className="srf-row srf-dates">
              <DatePicker value={value.dateFrom ?? ""} onChange={(d) => set({ dateFrom: d || null })} placeholder="From" />
              <i>–</i>
              <DatePicker value={value.dateTo ?? ""} onChange={(d) => set({ dateTo: d || null })} placeholder="To" />
            </div>
            <div className="srf-presets">
              {datePresets().map((p) => {
                const on = (value.dateFrom ?? "") === p.from && (value.dateTo ?? "") === p.to;
                return <button key={p.label} className={on ? "is-on" : ""} onClick={() => set({ dateFrom: p.from || null, dateTo: p.to || null })}>{p.label}</button>;
              })}
            </div>
          </>
        ) : (
          <div className="srf-row">
            {kind === "prob" ? (
              <>
                <NumBox value={value.probMin} onChange={(v) => set({ probMin: v })} placeholder="From" suffix="%" max={100} />
                <i>–</i>
                <NumBox value={value.probMax} onChange={(v) => set({ probMax: v })} placeholder="To" suffix="%" max={100} />
              </>
            ) : (
              <>
                <NumBox value={value.revMin} onChange={(v) => set({ revMin: v })} placeholder="From" suffix="€" />
                <i>–</i>
                <NumBox value={value.revMax} onChange={(v) => set({ revMax: v })} placeholder="To" suffix="€" />
              </>
            )}
          </div>
        )}
      </section>
      <footer className="srf-foot">
        <span>Same value twice = exact. One side empty = at least / at most. Click the header again to reset.</span>
        <button onClick={onClose}>Done</button>
      </footer>
    </div>,
    document.body,
  );
}

export default function SalesRangeFilter({ value, onChange, probLabel }: {
  value: SalesRanges;
  onChange: (v: SalesRanges) => void;
  /** Which probability is being filtered (follows the Probability selector). */
  probLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const n = activeRangeCount(value);
  const set = (patch: Partial<SalesRanges>) => onChange({ ...value, ...patch });

  const place = () => {
    const r = trigRef.current?.getBoundingClientRect();
    if (!r) return;
    const w = 340;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      const t = e.target as Element;
      if (panelRef.current?.contains(t) || trigRef.current?.contains(t)) return;
      if (t.closest?.(".dp-layer, .dp-pop")) return; // the date picker's calendar lives in its own portal
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".dp-pop")) return; // let the calendar close first
      setOpen(false);
    };
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

  const presets = datePresets();
  const parts = describe(value);
  const label = n === 0 ? "Any range" : n === 1 ? parts[0] : `${n} ranges`;

  return (
    <div className="srf">
      <button
        ref={trigRef} type="button"
        className={`srf-trigger ${n ? "is-set" : ""} ${open ? "is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={n > 1 ? parts.join(" · ") : undefined}
        aria-haspopup="dialog" aria-expanded={open}
      >
        <svg className="srf-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
        <span className="srf-label">{label}</span>
        {n > 1 && <span className="srf-count">{n}</span>}
        {n > 0
          ? <span className="srf-clear" role="button" aria-label="Clear ranges" onClick={(e) => { e.stopPropagation(); onChange(EMPTY_RANGES); }}>×</span>
          : <svg className="srf-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>}
      </button>

      {open && pos && createPortal(
        <div ref={panelRef} className="srf-panel" style={{ top: pos.top, left: pos.left }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Range filters">
          <section className="srf-sec">
            <header><b>Probability</b><span>{probLabel}</span>
              {(value.probMin !== null || value.probMax !== null) && <button onClick={() => set({ probMin: null, probMax: null })}>Clear</button>}</header>
            <div className="srf-row">
              <NumBox value={value.probMin} onChange={(v) => set({ probMin: v })} placeholder="From" suffix="%" max={100} />
              <i>–</i>
              <NumBox value={value.probMax} onChange={(v) => set({ probMax: v })} placeholder="To" suffix="%" max={100} />
            </div>
          </section>

          <section className="srf-sec">
            <header><b>Close date</b><span>Expected close</span>
              {(value.dateFrom || value.dateTo) && <button onClick={() => set({ dateFrom: null, dateTo: null })}>Clear</button>}</header>
            <div className="srf-row srf-dates">
              <DatePicker value={value.dateFrom ?? ""} onChange={(d) => set({ dateFrom: d || null })} placeholder="From" />
              <i>–</i>
              <DatePicker value={value.dateTo ?? ""} onChange={(d) => set({ dateTo: d || null })} placeholder="To" />
            </div>
            <div className="srf-presets">
              {presets.map((p) => {
                const on = (value.dateFrom ?? "") === p.from && (value.dateTo ?? "") === p.to;
                return <button key={p.label} className={on ? "is-on" : ""} onClick={() => set({ dateFrom: p.from || null, dateTo: p.to || null })}>{p.label}</button>;
              })}
            </div>
          </section>

          <section className="srf-sec">
            <header><b>Revenue</b><span>Potential value</span>
              {(value.revMin !== null || value.revMax !== null) && <button onClick={() => set({ revMin: null, revMax: null })}>Clear</button>}</header>
            <div className="srf-row">
              <NumBox value={value.revMin} onChange={(v) => set({ revMin: v })} placeholder="From" suffix="€" />
              <i>–</i>
              <NumBox value={value.revMax} onChange={(v) => set({ revMax: v })} placeholder="To" suffix="€" />
            </div>
          </section>

          <footer className="srf-foot">
            <span>Same value in both boxes = exact match. Leave one empty for “at least / at most”.</span>
            <button onClick={() => onChange(EMPTY_RANGES)} disabled={n === 0}>Clear all</button>
          </footer>
        </div>,
        document.body,
      )}
    </div>
  );
}