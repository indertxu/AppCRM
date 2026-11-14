import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { FCond, FField, FOpt, FSort, FView } from "../pages/companies/CompaniesPage";
import DatePicker from "./DatePicker";
import { NumInput } from "./NumInput";
import "./ColumnHead.css";

/**
 * A list's column header that opens a small menu, like a spreadsheet's:
 *   · sort the list by the column (A → Z, smallest first, newest first… and back), and
 *   · filter it right there — tick the values to keep (stages, pipelines, owners…), a min / max for
 *     figures, a period or a from / to for dates, "contains" for text.
 *
 * It works on the list's view (FView: the same filters and sort as the Filters panel), so what you pick
 * in a header shows as a chip, combines with the rest and is saved with a view. A column can filter on
 * several fields (a "value · close date" column has both) and a page with its own sort codes passes
 * `sorts` instead of using the view's sort.
 */

export interface ColSortOpt { id: string; label: string; dir: "asc" | "desc"; group?: string }
export interface ColumnHeadProps {
  label: ReactNode;
  /** The column's name in words (the menu's title), when the label isn't plain text. */
  name?: string;
  view: FView;
  onView: (v: FView) => void;
  /** What the column filters on (and sorts by: the first, unless sortKey says otherwise). */
  fields?: (FField<any> | undefined | null)[];
  /** The view's sort key for this column; null: the column doesn't sort through the view. */
  sortKey?: string | null;
  /** The page's own sort choices (replace the view's sort for this column). */
  sorts?: { options: ColSortOpt[]; active: string | null; onPick: (id: string | null) => void };
  className?: string;
  title?: string;
  /** The list's rows (when they are all loaded): the menu counts each value and hides "No value" when none lacks one. */
  rows?: readonly any[];
}

/** The operators a header can show and set, per kind of field (other filters on the field stay in the Filters panel). */
const HEAD_OPS: Record<string, string[]> = {
  select: ["in", "nin", "has", "empty"],
  multi: ["any", "has", "empty"],
  number: ["between", "gt", "lt", "eq", "has", "empty"],
  date: ["between", "before", "after", "last7", "last30", "last90", "this_month", "this_year", "next30", "has", "empty"],
  text: ["contains", "has", "empty"],
  boolean: ["yes", "no"],
};
const SORT_WORDS: Record<string, [string, string]> = {
  number: ["Smallest first", "Largest first"],
  date: ["Oldest first", "Newest first"],
  boolean: ["No first", "Yes first"],
};
const DATE_PRESETS: { op: string; label: string }[] = [
  { op: "last7", label: "Last 7 days" }, { op: "last30", label: "Last 30 days" }, { op: "last90", label: "Last 90 days" },
  { op: "this_month", label: "This month" }, { op: "this_year", label: "This year" }, { op: "next30", label: "Next 30 days" },
];
const norm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const uid = () => Math.random().toString(36).slice(2, 8);
/** Is this condition doing anything yet? */
const live = (c: FCond | undefined) => {
  if (!c) return false;
  if (["in", "nin", "any"].includes(c.op)) return !!c.values?.length;
  if (c.op === "between") return !!(c.min || c.max);
  if (["gt", "lt", "eq", "before", "after"].includes(c.op)) return !!c.min;
  if (c.op === "contains") return !!(c.text ?? "").trim();
  return true;
};
/** The condition a header shows for a field: the first one on it the header knows how to show. */
const condOf = (view: FView, f: FField<any>) => view.conds.find((c) => c.field === f.key && (HEAD_OPS[f.type] ?? []).includes(c.op));

/** Writes (or drops) a field's header condition into the view; header filters always combine with "and". */
function withCond(view: FView, f: FField<any>, next: Omit<FCond, "id" | "field"> | null): FView {
  const cur = condOf(view, f);
  let conds: FCond[];
  if (!next) conds = cur ? view.conds.filter((c) => c !== cur) : view.conds;
  else if (cur) conds = view.conds.map((c) => (c === cur ? { id: c.id, field: f.key, ...next } : c));
  else conds = [...view.conds, { id: `h:${f.key}:${uid()}`, field: f.key, ...next }];
  return { ...view, match: next && view.match === "any" && conds.length > 1 ? "all" : view.match, conds };
}

const Arrow = ({ dir }: { dir: "asc" | "desc" }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">{dir === "asc" ? <path d="M12 19V5M6 11l6-6 6 6" /> : <path d="M12 5v14M6 13l6 6 6-6" />}</svg>
);
const Funnel = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" /></svg>;
const Tick = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;

export function ColumnHead({ label, name, view, onView, fields: fieldsIn, sortKey, sorts, className, title, rows }: ColumnHeadProps) {
  const fields = (fieldsIn ?? []).filter(Boolean) as FField<any>[];
  const sKey = sortKey === undefined ? fields[0]?.key ?? null : sortKey;
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  // where the column stands: sorted (which way, in which place) and filtered
  const sIdx = sKey ? view.sort.findIndex((s) => s.key === sKey) : -1;
  const own = sorts ? sorts.options.find((o) => o.id === sorts.active) : undefined;
  const dir: "asc" | "desc" | null = sorts ? own?.dir ?? null : sIdx >= 0 ? view.sort[sIdx].dir : null;
  const filtered = fields.some((f) => view.conds.some((c) => c.field === f.key && live(c)));
  const word = name ?? (typeof label === "string" ? label : fields[0]?.label ?? "");

  return (
    <>
      <button ref={btn} type="button"
        className={`fx-sort ch-trig ${dir ? `is-${dir}` : ""} ${filtered ? "is-filt" : ""} ${open ? "is-open" : ""} ${className ?? ""}`}
        title={title ?? `${word}: sort or filter`} aria-haspopup="dialog" aria-expanded={open}
        aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onMouseDown={(e) => e.stopPropagation()}>
        <span>{label}</span>
        <i aria-hidden="true">
          {filtered && <em className="ch-funnel"><Funnel /></em>}
          <svg viewBox="0 0 12 16"><path className="fx-up" d="M6 1l4 5H2z" /><path className="fx-down" d="M6 15l4-5H2z" /></svg>
          {sIdx >= 0 && view.sort.length > 1 && !sorts && <b>{sIdx + 1}</b>}
        </i>
      </button>
      {open && <ColumnMenu anchor={btn} word={word} view={view} onView={onView} fields={fields} sKey={sKey} sorts={sorts} rows={rows} onClose={() => setOpen(false)} />}
    </>
  );
}

function ColumnMenu({ anchor, word, view, onView, fields: allFields, sKey, sorts, rows, onClose }: {
  anchor: React.RefObject<HTMLButtonElement | null>; word: string; view: FView; onView: (v: FView) => void;
  fields: FField<any>[]; sKey: string | null; sorts?: ColumnHeadProps["sorts"]; rows?: readonly any[]; onClose: () => void;
}) {
  // a list of values with nothing in it has nothing to offer (unless it already filters)
  const fields = useMemo(() => allFields.filter((f) => !(f.type === "select" || f.type === "multi") || (f.options?.() ?? []).length > 0 || view.conds.some((c) => c.field === f.key)), [allFields]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ left: -9999, top: 0 });
  const [keep, setKeep] = useState(false);
  // the latest view, so quick successive edits (typing) don't undo each other
  const vref = useRef(view);
  vref.current = view;
  const put = (v: FView) => { vref.current = v; onView(v); };

  const place = () => {
    const a = anchor.current, el = box.current;
    if (!a || !el) return;
    const r = a.getBoundingClientRect();
    const w = el.offsetWidth, h = el.scrollHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(10, Math.min(left, vw - w - 10));
    const below = vh - r.bottom - 14, above = r.top - 14;
    const down = below >= Math.min(h, 360) || below >= above;
    const maxH = Math.max(220, down ? below : above);
    const next: CSSProperties = { left: Math.round(left), top: down ? Math.round(r.bottom + 6) : undefined, bottom: down ? undefined : Math.round(vh - r.top + 6), maxHeight: Math.round(maxH) };
    setPos((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  };
  // placed under its header on each render (the menu grows as values are picked), without looping
  useLayoutEffect(place); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const out = (e: MouseEvent) => {
      const t = e.target as Element;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      if (t.closest?.(".dp-pop, .dp-layer, .sel-pop, .sel-layer")) return; // a date picker opened from the menu
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const re = () => place();
    document.addEventListener("mousedown", out, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", re);
    window.addEventListener("scroll", re, true);
    return () => {
      document.removeEventListener("mousedown", out, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", re);
      window.removeEventListener("scroll", re, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- sorting ----
  const sortField = fields.find((f) => f.key === sKey);
  const words = SORT_WORDS[sortField?.type ?? ""] ?? ["A → Z", "Z → A"];
  // (a page's own sort codes, "~…", don't combine with a column's)
  const others = view.sort.filter((s) => s.key !== sKey && !s.key.startsWith("~"));
  const cur = sKey ? view.sort.find((s) => s.key === sKey) : undefined;
  const pickSort = (dir: "asc" | "desc") => {
    if (!sKey) return;
    const v = vref.current;
    if (cur?.dir === dir) { put({ ...v, sort: v.sort.filter((s) => s.key !== sKey) }); return; }
    const me: FSort = { key: sKey, dir };
    put({ ...v, sort: keep ? (cur ? v.sort.map((s) => (s.key === sKey ? me : s)) : [...others, me]) : [me] });
  };
  const sortOpts: ColSortOpt[] = sorts ? sorts.options : sKey ? [{ id: "asc", label: words[0], dir: "asc" }, { id: "desc", label: words[1], dir: "desc" }] : [];
  const activeSort = sorts ? sorts.active : cur?.dir ?? null;
  const groups = [...new Set(sortOpts.map((o) => o.group ?? ""))];

  const anything = !!activeSort || fields.some((f) => view.conds.some((c) => c.field === f.key && (HEAD_OPS[f.type] ?? []).includes(c.op)));
  const clearAll = () => {
    let v = vref.current;
    fields.forEach((f) => { while (condOf(v, f)) v = withCond(v, f, null); });
    if (!sorts && sKey) v = { ...v, sort: v.sort.filter((s) => s.key !== sKey) };
    put(v);
    if (sorts && sorts.active) sorts.onPick(null);
  };

  return createPortal(
    <div ref={box} className="ch-menu" style={pos} role="dialog" aria-label={`${word}: sort and filter`} onMouseDown={(e) => e.stopPropagation()}>
      <div className="ch-head">
        <b>{word}</b>
        {anything && <button type="button" className="ch-reset" onClick={clearAll}>Reset column</button>}
      </div>
      {sortOpts.length > 0 && (
        <div className="ch-sec">
          <span className="ch-lbl">Sort</span>
          {groups.map((g) => (
            <div key={g} className="ch-sorts">
              {g && <em>{g}</em>}
              {sortOpts.filter((o) => (o.group ?? "") === g).map((o) => {
                const on = activeSort === o.id || (!sorts && activeSort === o.dir);
                return (
                  <button key={o.id} type="button" className={`ch-sortbtn ${on ? "is-on" : ""}`}
                    onClick={() => (sorts ? sorts.onPick(on ? null : o.id) : pickSort(o.dir))}>
                    <Arrow dir={o.dir} />{o.label}
                  </button>
                );
              })}
            </div>
          ))}
          {!sorts && sKey && others.length > 0 && (
            <label className="ch-keep">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              <span>Keep the current sort and sort by this next</span>
            </label>
          )}
        </div>
      )}
      {fields.map((f) => (
        <div key={f.key} className="ch-sec">
          <span className="ch-lbl">{fields.length > 1 ? f.label : "Show"}</span>
          <FieldFilter f={f} view={view} rows={rows} put={(next) => put(withCond(vref.current, f, next))} />
        </div>
      ))}
      <div className="ch-foot"><button type="button" onClick={onClose}>Done</button></div>
    </div>,
    document.body,
  );
}

type Put = (next: Omit<FCond, "id" | "field"> | null) => void;

function FieldFilter({ f, view, put, rows }: { f: FField<any>; view: FView; put: Put; rows?: readonly any[] }) {
  const c = condOf(view, f);
  if (f.type === "select" || f.type === "multi") return <ValueFilter f={f} c={c} put={put} rows={rows} />;
  if (f.type === "number") return <NumberFilter c={c} put={put} f={f} rows={rows} />;
  if (f.type === "date") return <DateFilter c={c} put={put} />;
  if (f.type === "boolean") {
    const v = c?.op ?? "";
    return (
      <div className="ch-seg">
        {[["", "All"], ["yes", "Yes"], ["no", "No"]].map(([k, l]) => (
          <button key={k} type="button" className={v === k ? "is-on" : ""} onClick={() => put(k ? { op: k } : null)}>{l}</button>
        ))}
      </div>
    );
  }
  return <TextFilter c={c} put={put} />;
}

/** Tick what to keep (everything ticked = no filter). */
function ValueFilter({ f, c, put, rows }: { f: FField<any>; c: FCond | undefined; put: Put; rows?: readonly any[] }) {
  const opts = useMemo<FOpt[]>(() => f.options?.() ?? [], [f]);
  /** How many rows have each value, and how many have none (when the rows are at hand). */
  const counts = useMemo(() => {
    if (!rows) return null;
    const m = new Map<string, number>();
    let blank = 0;
    rows.forEach((r) => {
      const v = f.get(r);
      const list = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
      if (!list.length) blank++;
      list.forEach((x: unknown) => { const k = String(x); m.set(k, (m.get(k) ?? 0) + 1); });
    });
    return { m, blank };
  }, [rows, f]);
  const [q, setQ] = useState("");
  const all = opts.map((o) => o.value);
  const vals = c?.values ?? [];
  // what's ticked
  const on = useMemo(() => {
    if (!c) return new Set(all);
    if (c.op === "in" || c.op === "any") return new Set(vals);
    if (c.op === "nin") return new Set(all.filter((v) => !vals.includes(v)));
    if (c.op === "has") return new Set(all);
    return new Set<string>();
  }, [c, opts]); // eslint-disable-line react-hooks/exhaustive-deps
  const blankOn = !c || c.op === "empty" || c.op === "nin";
  const multi = f.type === "multi";
  /** Writes the ticked set back as the shortest condition. */
  const write = (set: Set<string>, blank = blankOn) => {
    if (set.size === all.length) { put(blank ? null : { op: "has" }); return; }
    if (!set.size) { put(blank ? { op: "empty" } : { op: multi ? "any" : "in", values: [] }); return; }
    // "is none of" the unticked ones keeps the rows with no value; "is any of" the ticked ones drops them
    if (!multi && blank) { put({ op: "nin", values: all.filter((v) => !set.has(v)) }); return; }
    put({ op: multi ? "any" : "in", values: all.filter((v) => set.has(v)) });
  };
  const toggle = (v: string) => { const s = new Set(on); if (s.has(v)) s.delete(v); else s.add(v); write(s); };
  const n = norm(q);
  const list = n ? opts.filter((o) => norm(o.label).includes(n)) : opts;
  const allOn = on.size === all.length && blankOn;
  const someOn = on.size > 0 || (blankOn && !!c);
  if (!opts.length) return <p className="ch-none">Nothing to pick from yet.</p>;
  return (
    <div className="ch-vals">
      {opts.length > 6 && (
        <div className="ch-q">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${opts.length}…`} />
          {q && <button type="button" onClick={() => setQ("")} aria-label="Clear the search">×</button>}
        </div>
      )}
      <div className="ch-list">
        {n ? (
          list.length > 0 && (
            <button type="button" className="ch-row is-all" onClick={() => write(new Set(list.map((o) => o.value)), false)}>
              <i className="is-dot" /><span>Only these {list.length}</span>
            </button>
          )
        ) : (
          <button type="button" className={`ch-row is-all ${allOn ? "is-on" : someOn ? "is-part" : ""}`} onClick={() => write(allOn ? new Set() : new Set(all), !allOn)}>
            <i>{allOn ? <Tick /> : someOn ? <b /> : null}</i><span>Select all</span>
          </button>
        )}
        {list.slice(0, 300).map((o) => {
          const is = on.has(o.value);
          return (
            <button key={o.value} type="button" className={`ch-row ${is ? "is-on" : ""}`} onClick={() => toggle(o.value)} title={o.label}>
              <i>{is && <Tick />}</i><span>{o.label}</span>
              {counts && <small className={counts.m.get(o.value) ? "" : "is-zero"}>{(counts.m.get(o.value) ?? 0).toLocaleString("en-GB")}</small>}
            </button>
          );
        })}
        {list.length > 300 && <p className="ch-more">{list.length - 300} more — search to find them</p>}
        {!n && (!counts || counts.blank > 0 || !blankOn) && (
          <button type="button" className={`ch-row is-blank ${blankOn ? "is-on" : ""}`} onClick={() => write(on, !blankOn)}>
            <i>{blankOn && <Tick />}</i><span>No value</span>
            {counts && <small>{counts.blank.toLocaleString("en-GB")}</small>}
          </button>
        )}
        {n && !list.length && <p className="ch-more">Nothing matches “{q}”</p>}
        {!n && !on.size && !blankOn && <p className="ch-more">Tick what to show</p>}
      </div>
    </div>
  );
}

/** Typing waits a moment before it filters (a list on the server reloads on each change). */
function useLater<T>(value: T, apply: (v: T) => void, ms = 320) {
  const [v, setV] = useState(value);
  const typed = useRef(false);
  const outside = JSON.stringify(value);
  // a change from elsewhere (Reset column, a chip removed) shows here, unless something typed is on its way
  useEffect(() => { if (!typed.current) setV(value); }, [outside]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!typed.current) return;
    const t = window.setTimeout(() => { typed.current = false; apply(v); }, ms);
    return () => window.clearTimeout(t);
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (x: T) => { typed.current = true; setV(x); };
  /** Shows a value without filtering by it (the buttons beside the box set the filter themselves). */
  const show = (x: T) => { typed.current = false; setV(x); };
  return [v, set, show] as const;
}

function NumberFilter({ c, put, f, rows }: { c: FCond | undefined; put: Put; f: FField<any>; rows?: readonly any[] }) {
  /** The lowest and highest figure in the list, as the boxes' hints. */
  const span = useMemo(() => {
    if (!rows) return null;
    let lo = Infinity, hi = -Infinity;
    rows.forEach((r) => { const v = f.get(r); if (v == null || v === "" || Number.isNaN(Number(v))) return; const x = Number(v); if (x < lo) lo = x; if (x > hi) hi = x; });
    return lo <= hi ? { lo, hi } : null;
  }, [rows, f]);
  const fmt = (x: number) => String(+x.toFixed(2));
  const range = !c || ["between", "gt", "lt", "eq"].includes(c.op);
  const init = { min: c?.op === "lt" ? "" : c?.min ?? "", max: c?.op === "between" ? c?.max ?? "" : c?.op === "lt" ? c?.min ?? "" : c?.op === "eq" ? c?.min ?? "" : "" };
  const [mm, setMm, showMm] = useLater(init, (v) => put(v.min || v.max ? { op: "between", min: v.min, max: v.max } : null));
  return (
    <div className="ch-num">
      <div className="ch-range">
        <label><span>Min</span><NumInput inputMode="decimal" value={range ? mm.min : ""} placeholder={span ? fmt(span.lo) : "Any"} onChange={(e) => setMm({ ...mm, min: e.target.value })} /></label>
        <em>to</em>
        <label><span>Max</span><NumInput inputMode="decimal" value={range ? mm.max : ""} placeholder={span ? fmt(span.hi) : "Any"} onChange={(e) => setMm({ ...mm, max: e.target.value })} /></label>
      </div>
      <div className="ch-seg is-sm">
        <button type="button" className={c?.op === "has" ? "is-on" : ""} onClick={() => { showMm({ min: "", max: "" }); put(c?.op === "has" ? null : { op: "has" }); }}>Has a value</button>
        <button type="button" className={c?.op === "empty" ? "is-on" : ""} onClick={() => { showMm({ min: "", max: "" }); put(c?.op === "empty" ? null : { op: "empty" }); }}>Empty</button>
      </div>
    </div>
  );
}

function DateFilter({ c, put }: { c: FCond | undefined; put: Put }) {
  const op = c?.op ?? "";
  const from = op === "between" || op === "after" ? c?.min ?? "" : "";
  const to = op === "between" ? c?.max ?? "" : op === "before" ? c?.min ?? "" : "";
  const setRange = (a: string, b: string) => put(a || b ? { op: "between", min: a || undefined, max: b || undefined } : null);
  return (
    <div className="ch-date">
      <div className="ch-chips">
        {DATE_PRESETS.map((p) => (
          <button key={p.op} type="button" className={op === p.op ? "is-on" : ""} onClick={() => put(op === p.op ? null : { op: p.op })}>{p.label}</button>
        ))}
      </div>
      <div className="ch-range is-date">
        <label><span>From</span><DatePicker value={from} onChange={(d) => setRange(d, to)} placeholder="Any day" />{from && <button type="button" className="ch-x" onClick={() => setRange("", to)} aria-label="Clear">×</button>}</label>
        <label><span>To</span><DatePicker value={to} onChange={(d) => setRange(from, d)} placeholder="Any day" />{to && <button type="button" className="ch-x" onClick={() => setRange(from, "")} aria-label="Clear">×</button>}</label>
      </div>
      <div className="ch-seg is-sm">
        <button type="button" className={op === "has" ? "is-on" : ""} onClick={() => put(op === "has" ? null : { op: "has" })}>Has a date</button>
        <button type="button" className={op === "empty" ? "is-on" : ""} onClick={() => put(op === "empty" ? null : { op: "empty" })}>No date</button>
      </div>
    </div>
  );
}

function TextFilter({ c, put }: { c: FCond | undefined; put: Put }) {
  const [t, setT, showT] = useLater(c?.op === "contains" ? c.text ?? "" : "", (v) => put(v.trim() ? { op: "contains", text: v } : null));
  return (
    <div className="ch-text">
      <div className="ch-q">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
        <input autoFocus value={t} onChange={(e) => setT(e.target.value)} placeholder="Contains…" />
        {t && <button type="button" onClick={() => setT("")} aria-label="Clear">×</button>}
      </div>
      <div className="ch-seg is-sm">
        <button type="button" className={c?.op === "has" ? "is-on" : ""} onClick={() => { showT(""); put(c?.op === "has" ? null : { op: "has" }); }}>Has a value</button>
        <button type="button" className={c?.op === "empty" ? "is-on" : ""} onClick={() => { showT(""); put(c?.op === "empty" ? null : { op: "empty" }); }}>Empty</button>
      </div>
    </div>
  );
}

export default ColumnHead;
