import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../../framework/DatePicker";
import { fitPopover, type PopPos } from "./SalesMultiFilter";
import "./SalesRangeFilter.css";

/** null = that side is open. Same min and max = an exact value. */
export interface SalesRanges {
  probMin: number | null; probMax: number | null;
  dateFrom: string | null; dateTo: string | null;
  revMin: number | null; revMax: number | null;
  /** When the deal was created (optional: older saved filters don't have it). */
  createdFrom?: string | null; createdTo?: string | null;
  /** When the deal was actually closed, won or lost (its close date). */
  closedFrom?: string | null; closedTo?: string | null;
}
export const EMPTY_RANGES: SalesRanges = { probMin: null, probMax: null, dateFrom: null, dateTo: null, revMin: null, revMax: null, createdFrom: null, createdTo: null, closedFrom: null, closedTo: null };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtDate = (s: string) => {
  const d = new Date(`${s}T00:00:00`);
  return isNaN(+d) ? s : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const fmtEur = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/** How many of the ranges are active. */
export const activeRangeCount = (r: SalesRanges) =>
  [r.probMin !== null || r.probMax !== null, !!(r.dateFrom || r.dateTo), r.revMin !== null || r.revMax !== null, !!(r.createdFrom || r.createdTo), !!(r.closedFrom || r.closedTo)].filter(Boolean).length;

function describe(r: SalesRanges): string[] {
  const out: string[] = [];
  const span = (a: string | null, b: string | null, unit = "") =>
    a !== null && b !== null ? (a === b ? `${a}${unit}` : `${a}–${b}${unit}`) : a !== null ? `≥ ${a}${unit}` : `≤ ${b}${unit}`;
  if (r.probMin !== null || r.probMax !== null) out.push(`Prob ${span(r.probMin?.toString() ?? null, r.probMax?.toString() ?? null, "%")}`);
  if (r.dateFrom || r.dateTo) out.push(`Close ${span(r.dateFrom ? fmtDate(r.dateFrom) : null, r.dateTo ? fmtDate(r.dateTo) : null)}`);
  if (r.revMin !== null || r.revMax !== null) out.push(`Rev ${span(r.revMin !== null ? fmtEur(r.revMin) : null, r.revMax !== null ? fmtEur(r.revMax) : null, " €")}`);
  if (r.createdFrom || r.createdTo) out.push(`Created ${span(r.createdFrom ? fmtDate(r.createdFrom) : null, r.createdTo ? fmtDate(r.createdTo) : null)}`);
  if (r.closedFrom || r.closedTo) out.push(`Closed ${span(r.closedFrom ? fmtDate(r.closedFrom) : null, r.closedTo ? fmtDate(r.closedTo) : null)}`);
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

/** Ranges for when a deal was created or closed: looking back, not ahead. */
function createdPresets(): { label: string; from: string; to: string }[] {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) * 3;
  return [
    { label: "This month", from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)) },
    { label: "Last 30 days", from: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)), to: iso(now) },
    { label: "This quarter", from: iso(new Date(now.getFullYear(), q, 1)), to: iso(new Date(now.getFullYear(), q + 3, 0)) },
    { label: "This year", from: iso(new Date(now.getFullYear(), 0, 1)), to: iso(new Date(now.getFullYear(), 11, 31)) },
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
  // Placed from its real height: under the header when it fits, above it otherwise.
  const [pos, setPos] = useState<PopPos>(() => fitPopover(anchor, 260, 320, { gap: 10, align: "center" }));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = el.style.maxHeight; el.style.maxHeight = "none";
    const natural = el.offsetHeight; el.style.maxHeight = prev;
    const next = fitPopover(anchor, natural, 320, { gap: 10, align: "center" });
    setPos((cur) => (cur.top === next.top && cur.left === next.left && cur.maxH === next.maxH && cur.up === next.up ? cur : next));
  }, [anchor, kind, value.dateFrom, value.dateTo]); // eslint-disable-line react-hooks/exhaustive-deps
  const { top, left, width: w } = pos;

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

  const title = kind === "prob" ? "Close chance" : kind === "rev" ? "Potential" : "Expected close";
  const sub = kind === "prob" ? probLabel : kind === "rev" ? "Potential value" : "Expected close";
  return createPortal(
    <div ref={ref} className={`srf-panel srf-head-pop ${pos.up ? "is-up" : ""}`} style={{ top, left, width: w, maxHeight: pos.maxH }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`${title} range`}>
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

const SRF_ICON = {
  pct: "M19 5L5 19M7.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM16.5 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  eur: "M17 6.5A6.5 6.5 0 1 0 17 17.5M4 10.5h9M4 13.5h8",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  plus: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4M12 13v5M9.5 15.5h5",
  check: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4M9 15l2 2 4-4",
};

/** One range in the panel: icon, title, what it measures, its fields; tinted while it's in use. */
function RangeSec({ tone, icon, title, sub, active, onClear, children }: {
  tone: string; icon: string; title: string; sub: string; active: boolean; onClear: () => void; children: ReactNode;
}) {
  return (
    <section className={`srf-sec tone-${tone} ${active ? "is-set" : ""}`}>
      <header>
        <span className="srf-sec-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg>
        </span>
        <span className="srf-sec-t"><b>{title}</b><span>{sub}</span></span>
        {active && <button type="button" onClick={onClear}>Clear</button>}
      </header>
      {children}
    </section>
  );
}

export default function SalesRangeFilter({ value, onChange, probLabel }: {
  value: SalesRanges;
  onChange: (v: SalesRanges) => void;
  /** Which probability is being filtered (follows the Probability selector). */
  probLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopPos | null>(null);
  const trigRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const n = activeRangeCount(value);
  const set = (patch: Partial<SalesRanges>) => onChange({ ...value, ...patch });

  /** Two columns (numbers · dates) when the window is wide enough, one otherwise. */
  const panelW = () => (window.innerWidth >= 820 ? 760 : 360);
  const place = () => {
    const r = trigRef.current?.getBoundingClientRect();
    if (!r) return;
    const el = panelRef.current;
    let natural = 420;
    if (el) { const prev = el.style.maxHeight; el.style.maxHeight = "none"; natural = el.offsetHeight; el.style.maxHeight = prev; }
    const next = fitPopover(r, natural, panelW(), { align: "right" });
    setPos((cur) => (cur && cur.top === next.top && cur.left === next.left && cur.width === next.width && cur.maxH === next.maxH && cur.up === next.up ? cur : next));
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (open && pos) place(); }, [open, !!pos]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // scrolling inside the panel itself must not move (or re-measure) it
    const re = (e?: Event) => { if (e && panelRef.current?.contains(e.target as Node)) return; place(); };
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
  /** The three date ranges share one shape: fields, then four quick picks. */
  type DateRange = { k: string; tone: string; icon: string; title: string; sub: string; from: string | null; to: string | null;
    put: (a: string | null, b: string | null) => void; presets: { label: string; from: string; to: string }[] };
  const dates: DateRange[] = [
    { k: "exp", tone: "amber", icon: SRF_ICON.flag, title: "Expected close", sub: "Sales or management estimate", from: value.dateFrom ?? null, to: value.dateTo ?? null,
      put: (a: string | null, b: string | null) => set({ dateFrom: a, dateTo: b }), presets },
    { k: "cre", tone: "blue", icon: SRF_ICON.plus, title: "Created on", sub: "When the deal was opened", from: value.createdFrom ?? null, to: value.createdTo ?? null,
      put: (a: string | null, b: string | null) => set({ createdFrom: a, createdTo: b }), presets: createdPresets() },
    { k: "cls", tone: "violet", icon: SRF_ICON.check, title: "Close date", sub: "When it was won or lost", from: value.closedFrom ?? null, to: value.closedTo ?? null,
      put: (a: string | null, b: string | null) => set({ closedFrom: a, closedTo: b }), presets: createdPresets() },
  ];
  const dateSec = (d: DateRange) => (
    <RangeSec key={d.k} tone={d.tone} icon={d.icon} title={d.title} sub={d.sub} active={!!(d.from || d.to)} onClear={() => d.put(null, null)}>
      <div className="srf-row srf-dates">
        <DatePicker value={d.from ?? ""} onChange={(x) => d.put(x || null, d.to)} placeholder="From" />
        <i>–</i>
        <DatePicker value={d.to ?? ""} onChange={(x) => d.put(d.from, x || null)} placeholder="To" />
      </div>
      <div className="srf-presets">
        {d.presets.map((p) => {
          const on = (d.from ?? "") === p.from && (d.to ?? "") === p.to;
          return <button type="button" key={p.label} className={on ? "is-on" : ""} onClick={() => (on ? d.put(null, null) : d.put(p.from || null, p.to || null))}>{p.label}</button>;
        })}
      </div>
    </RangeSec>
  );
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
        <div ref={panelRef} className={`srf-panel srf-main ${pos.width >= 600 ? "is-wide" : ""} ${pos.up ? "is-up" : ""}`}
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Range filters">
          <header className="srf-top">
            <span className="srf-top-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
            </span>
            <span className="srf-top-t"><b>Ranges</b><span>{n === 0 ? "All of them apply together" : `${n} active · all apply together`}</span></span>
            <button type="button" className="srf-top-clear" onClick={() => onChange(EMPTY_RANGES)} disabled={n === 0}>Clear all</button>
          </header>

          <div className="srf-cols">
            <div className="srf-col">
              <RangeSec tone="mint" icon={SRF_ICON.pct} title="Probability" sub={probLabel}
                active={value.probMin !== null || value.probMax !== null} onClear={() => set({ probMin: null, probMax: null })}>
                <div className="srf-row">
                  <NumBox value={value.probMin} onChange={(v) => set({ probMin: v })} placeholder="From" suffix="%" max={100} />
                  <i>–</i>
                  <NumBox value={value.probMax} onChange={(v) => set({ probMax: v })} placeholder="To" suffix="%" max={100} />
                </div>
              </RangeSec>
              <RangeSec tone="teal" icon={SRF_ICON.eur} title="Revenue" sub="Potential value"
                active={value.revMin !== null || value.revMax !== null} onClear={() => set({ revMin: null, revMax: null })}>
                <div className="srf-row">
                  <NumBox value={value.revMin} onChange={(v) => set({ revMin: v })} placeholder="From" suffix="€" />
                  <i>–</i>
                  <NumBox value={value.revMax} onChange={(v) => set({ revMax: v })} placeholder="To" suffix="€" />
                </div>
              </RangeSec>
              {dateSec(dates[1])}
            </div>

            <div className="srf-col">
              {dateSec(dates[0])}
              {dateSec(dates[2])}
              <p className="srf-tip">
                <b>Tip</b> Same value in both boxes = an exact match. Leave one empty for “at least” or “at most”.
              </p>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}