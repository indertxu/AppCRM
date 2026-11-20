/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The building blocks of the spreadsheet importers (Contacts › Import):
 * the column → field picker, a new custom field, "existing record" choices,
 * the difference note, the sheet viewer, the error report and the column
 * tools.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  colLetter, cellText, normHeader, applyColRules, mergeValues, RULE_LABEL, MERGE_LABEL,
  type Sheet, type SheetCell, type ColRule, type ColRuleOp, type ImportPrep, type MergeMode, type MergeRule,
} from "../../framework/spreadsheetImport";
import { canonicalOptions, guessType, EXISTING_LABEL, type Column, type Entity, type ExistingMode, type RecordDiff, type NewField, type FieldType } from "./importCore";
import "./importKit.css";
import Select from "../../framework/Select";
import SalesMultiFilter from "../../framework/MultiFilter";

const TYPE_LABEL: Record<FieldType, string> = { text: "Text", number: "Number", date: "Date", boolean: "Yes / No", select: "Choice list" };
const fmtN = (n: number) => n.toLocaleString("de-DE");
const ENTITY_LABEL: Record<Entity, string> = { company: "Company", contact: "Contact" };

export type Tone = "none" | "co" | "ct" | "deal" | "phase" | "field" | "new" | "create";
export interface TOpt { value: string; label: string; group: string; tone: Tone; hint?: string }

function explain(reason: string): { title: string; hint: string } {
  const r = reason.toLowerCase();
  if (r.startsWith("company “")) return { title: "A company couldn't be created", hint: "Usually a duplicate VAT or a value the database refuses. Fix it in the file and import that row again." };
  if (r.startsWith("contact “")) return { title: "A contact couldn't be created", hint: "Usually a duplicate email or an invalid value. Fix it in the file and import that row again." };
  if (/duplicate key|already exists|unique/.test(r)) return { title: "Already exists", hint: "Something with the same key is already in the CRM." };
  if (/permission|row-level security|not allowed|42501/.test(r)) return { title: "Not allowed", hint: "Your role can't create this — ask a manager to run the import." };
  if (/invalid input|syntax|out of range|violates/.test(r)) return { title: "A value the database refuses", hint: "Check dates, numbers and choice values in this row." };
  return { title: "Other problem", hint: "The message below comes straight from the database." };
}

export function FailReport({ failed, sheet, hasHeader, onDownload, describe, explainFn }: {
  failed: { row: number; reason: string }[]; plan?: null; rowOffset: number; sheet: Sheet | null; hasHeader: boolean; onDownload: () => void;
  /** The importer's own name / details for a row. */
  describe?: (row: number) => { name: string | null; sub: string | null; issues: string[] } | null;
  /** The importer's own reading of its errors (falls back to the generic one). */
  explainFn?: (reason: string) => { title: string; hint: string } | null;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, { title: string; hint: string; items: { row: number; reason: string }[] }>();
    failed.forEach((f) => { const e = explainFn?.(f.reason) ?? explain(f.reason); const g = m.get(e.title) ?? { ...e, items: [] }; g.items.push(f); m.set(e.title, g); });
    return [...m.values()].sort((a, b) => b.items.length - a.items.length);
  }, [failed]);
  const [pick, setPick] = useState<string>("all");
  const [openRow, setOpenRow] = useState<number | null>(null);
  const shown = pick === "all" ? groups : groups.filter((g) => g.title === pick);
  const header = sheet && hasHeader ? (sheet.rows[0] ?? []).map((c) => cellText(c)) : [];
  return (
    <section className="di-fail" aria-label="What wasn't imported">
      <header className="di-fail-h">
        <span className="di-fail-ico">!</span>
        <div>
          <b>{fmtN(failed.length)} {failed.length === 1 ? "thing wasn't" : "things weren't"} imported</b>
          <span>Everything else went in. Fix these in the file and import just those rows again.</span>
        </div>
        <button className="di-btn is-ghost" onClick={onDownload}>
          <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>Download (CSV)
        </button>
      </header>
      {groups.length > 1 && (
        <div className="rv-chips">
          <button className={pick === "all" ? "is-on" : ""} onClick={() => setPick("all")}>All <i>{failed.length}</i></button>
          {groups.map((g) => <button key={g.title} className={pick === g.title ? "is-on" : ""} onClick={() => setPick(g.title)}>{g.title} <i>{g.items.length}</i></button>)}
        </div>
      )}
      <div className="di-fail-groups">
        {shown.map((g, gi) => (
          <div key={g.title} className="di-fail-g" style={{ ["--j" as string]: gi } as CSSProperties}>
            <div className="di-fail-gh"><b>{g.title}</b><i>{g.items.length}</i><span>{g.hint}</span></div>
            <div className="di-fail-list">
              {g.items.slice(0, 200).map((f, i) => {
                const own = f.row && describe ? describe(f.row) : null;
                const name = own ? own.name : (f.reason.match(/“([^”]+)”/)?.[1] ?? null);
                const sub = own ? own.sub : null;
                const also = own?.issues ?? [];
                const raw = f.row && sheet ? sheet.rows[f.row - 1] ?? [] : [];
                const isOpen = openRow === i + gi * 1000;
                return (
                  <div key={i} className={`di-fail-r ${isOpen ? "is-open" : ""}`}>
                    <button className="di-fail-rb" onClick={() => setOpenRow(isOpen ? null : i + gi * 1000)} disabled={!raw.length} aria-expanded={isOpen}>
                      <span className="di-fail-n">{f.row ? `Row ${f.row}` : "—"}</span>
                      <span className="di-fail-who"><b>{name || "Unnamed row"}</b>{sub && <small>{sub}</small>}</span>
                      <span className="di-fail-why" title={f.reason}>{f.reason}</span>
                      {raw.length > 0 && <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>}
                    </button>
                    {isOpen && raw.length > 0 && (
                      <div className="di-fail-cells">
                        {raw.map((c, ci) => cellText(c).trim() ? (
                          <span key={ci}><em>{header[ci] || colLetter(ci)}</em>{cellText(c)}</span>
                        ) : null)}
                        {also.length > 0 && <p>Also noticed: {also.join(" · ")}</p>}
                      </div>
                    )}
                  </div>
                );
              })}
              {g.items.length > 200 && <p className="di-muted di-pad">+{g.items.length - 200} more in the CSV.</p>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Grouped, searchable picker for what a column becomes. */
export function TargetPicker({ value, options, used, onChange }: { value: string; options: TOpt[]; used: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null);
  const trig = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value) ?? options[0];
  const place = () => {
    const r = trig.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 340);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < 300 && above > below;
    const maxH = Math.max(220, Math.min(480, up ? above : below));
    setPos({ top: up ? r.top - 6 - maxH : r.bottom + 6, left, width, maxH });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { const t = e.target as Node; if (!menu.current?.contains(t) && !trig.current?.contains(t)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); trig.current?.focus(); } };
    // scrolling inside the menu itself must not move it (the list jumped back to the top)
    const re = (e?: Event) => { if (e && menu.current?.contains(e.target as Node)) return; place(); };
    document.addEventListener("mousedown", off, true); window.addEventListener("keydown", esc, true);
    window.addEventListener("resize", re); window.addEventListener("scroll", re, true);
    return () => { document.removeEventListener("mousedown", off, true); window.removeEventListener("keydown", esc, true); window.removeEventListener("resize", re); window.removeEventListener("scroll", re, true); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = normHeader(q);
  const list = n ? options.filter((o) => normHeader(`${o.label} ${o.group} ${o.hint ?? ""}`).includes(n)) : options;
  const groups: { g: string; items: TOpt[] }[] = [];
  list.forEach((o) => { const last = groups[groups.length - 1]; if (last && last.g === o.group) last.items.push(o); else groups.push({ g: o.group, items: [o] }); });
  const choose = (v: string) => { onChange(v); setOpen(false); setQ(""); };
  const takenTimes = (v: string) => used.filter((x) => x === v).length;
  return (
    <>
      <button ref={trig} type="button" className={`di-tp is-${cur.tone} ${open ? "is-open" : ""}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        {cur.tone !== "none" && cur.group && <em>{cur.group.startsWith("Phase reached") ? "Phase" : cur.group.replace(/^Your /, "").replace(/ fields$/, " field")}</em>}
        <b>{cur.label}</b>
        <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && pos && createPortal(
        <div ref={menu} className="di-tp-menu" style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }} role="listbox" onMouseDown={(e) => e.stopPropagation()}>
          <div className="di-tp-search">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields, phases…" onKeyDown={(e) => { if (e.key === "Enter" && list[0]) choose(list[0].value); }} />
          </div>
          <div className="di-tp-list">
            {groups.map(({ g, items }) => (
              <div key={g || "_"} className="di-tp-group">
                {g && <span className="di-tp-gh">{g}</span>}
                {items.map((o) => {
                  const taken = o.value !== value && !o.value.startsWith("__") && takenTimes(o.value) > 0 && !["deal.notes", "deal.title", "company.notes", "contact.notes"].includes(o.value);
                  return (
                    <button key={o.value} type="button" role="option" aria-selected={o.value === value} className={`di-tp-opt is-${o.tone} ${o.value === value ? "is-on" : ""} ${taken ? "is-taken" : ""}`} onClick={() => choose(o.value)}>
                      <i />
                      <span><b>{o.label}</b>{(o.hint || taken) && <small>{taken ? "Also used by another column — you'll choose which one wins" : o.hint}</small>}</span>
                      {o.value === value && <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
                    </button>
                  );
                })}
              </div>
            ))}
            {!groups.length && <p className="di-tp-empty">Nothing matches “{q}”.</p>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** A field the import creates: its name, type and — for choice lists — its options. */
export function NewFieldEditor({ nf, column, onPatch, onRemove, onOptionsChanged, entities }: {
  nf: NewField; column: Column; onPatch: (p: Partial<NewField>) => void; onRemove: () => void; onOptionsChanged: () => void;
  /** Records the field can be created on — with more than one, the tag becomes a switch. */
  entities?: Entity[];
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");
  const fromColumn = nf.type === "select" ? canonicalOptions(column.values) : [];
  const add = () => {
    const v = draft.trim();
    if (!v || nf.options.some((o) => normHeader(o) === normHeader(v))) { setDraft(""); return; }
    onPatch({ options: [...nf.options, v] }); setDraft(""); onOptionsChanged();
  };
  const rename = (i: number) => {
    const v = editVal.trim();
    if (v && !nf.options.some((o, k) => k !== i && normHeader(o) === normHeader(v))) onPatch({ options: nf.options.map((o, k) => (k === i ? v : o)) });
    setEditing(null);
  };
  return (
    <div className={`di-newfield is-${nf.entity}`}>
      <div className="di-newfield-top">
        {entities && entities.length > 1 ? (
          <div className="di-seg is-mini" role="radiogroup" aria-label="Create the field on">
            {entities.map((e) => <button key={e} type="button" role="radio" aria-checked={nf.entity === e} className={nf.entity === e ? "is-on" : ""} onClick={() => onPatch({ entity: e })}>New {ENTITY_LABEL[e].toLowerCase()} field</button>)}
          </div>
        ) : <span className="di-tag">New {ENTITY_LABEL[nf.entity].toLowerCase()} field</span>}
        <input value={nf.label} onChange={(e) => onPatch({ label: e.target.value })} aria-label="New field name" placeholder="Field name" />
        <SalesMultiFilter single values={[nf.type]} onChange={(v) => v[0] && onPatch({ type: v[0] as FieldType, options: v[0] === "select" ? (nf.options.length ? nf.options : guessType(column.values).options) : [] })}
          options={(Object.keys(TYPE_LABEL) as FieldType[]).map((x) => ({ value: x, label: TYPE_LABEL[x] }))} placeholder="Type" />
        <button className="di-newfield-x" onClick={onRemove} aria-label="Don't create this field">×</button>
      </div>
      {nf.type === "select" && (
        <div className="di-opted">
          <div className="di-opted-h">
            <b>Options</b><span>{nf.options.length}</span>
            <div className="di-opted-acts">
              <button onClick={() => { onPatch({ options: fromColumn }); onOptionsChanged(); }} title="One option per different value of the column">Take them from the column ({fromColumn.length})</button>
              <button onClick={() => { const merged = [...nf.options, ...fromColumn.filter((o) => !nf.options.some((x) => normHeader(x) === normHeader(o)))]; onPatch({ options: merged }); onOptionsChanged(); }}>Add the missing ones</button>
              {nf.options.length > 0 && <button className="is-danger" onClick={() => onPatch({ options: [] })}>Start from scratch</button>}
            </div>
          </div>
          <div className="di-chips">
            {nf.options.map((o, i) => editing === i ? (
              <input key={`e${i}`} className="di-chip-edit" autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)} onBlur={() => rename(i)}
                onKeyDown={(e) => { if (e.key === "Enter") rename(i); if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } }} />
            ) : (
              <span key={o} className="di-chip" style={{ ["--j" as string]: Math.min(i, 16) } as CSSProperties}>
                <button className="di-chip-l" onClick={() => { setEditing(i); setEditVal(o); }} title="Rename">{o}</button>
                <button className="di-chip-x" onClick={() => onPatch({ options: nf.options.filter((_, k) => k !== i) })} aria-label={`Remove ${o}`}>×</button>
              </span>
            ))}
            <span className="di-chip-add">
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="+ Your own option" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
              {draft.trim() && <button onClick={add}>Add</button>}
            </span>
          </div>
          <p className="di-opted-note">Below, send each value of the column to one of these — or add it as an option of its own.</p>
        </div>
      )}
    </div>
  );
}

/** Which fields of each kind the mapping fills. */
export function ExistingChoice({ label, n, fill, change, value, onChange, keepText }: { label: string; n: number; fill: number; change: number; value: ExistingMode; onChange: (v: ExistingMode) => void; keepText?: string }) {
  const effect: Record<ExistingMode, string> = {
    fill: fill ? `${fmtN(fill)} empty ${fill === 1 ? "field gets" : "fields get"} the file's value` : "No empty fields to fill",
    replace: fill + change ? `${fmtN(fill + change)} ${fill + change === 1 ? "field takes" : "fields take"} the file's value${change ? ` (${fmtN(change)} overwritten)` : ""}` : "Nothing would change",
    keep: keepText ?? "Nothing changes — they're only linked to the deals",
  };
  return (
    <div className="rv-ask-row">
      <span className="rv-ask-l"><b>{label}</b><small>{fmtN(n)} in the CRM</small></span>
      <div className="rv-ask-opts" role="radiogroup" aria-label={`${label} already in the CRM`}>
        {(["fill", "replace", "keep"] as ExistingMode[]).map((m) => (
          <button key={m} role="radio" aria-checked={value === m} className={`rv-ask-opt ${value === m ? "is-on" : ""} ${m === "replace" ? "is-strong" : ""}`} onClick={() => onChange(m)}>
            <i />
            <span><b>{EXISTING_LABEL[m]}{m === "fill" && <em>recommended</em>}</b><small>{effect[m]}</small></span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** "2 to fill · 1 different", with the fields on hover. */
export function DiffNote({ diff, mode }: { diff: RecordDiff | null | undefined; mode: ExistingMode }) {
  if (!diff || (!diff.fill.length && !diff.change.length)) return <span className="rv-diff is-none">Same data as the CRM</span>;
  const applies = (k: "fill" | "change") => mode === "replace" || (mode === "fill" && k === "fill");
  return (
    <span className="rv-diff" tabIndex={0}>
      {diff.fill.length > 0 && <span className={applies("fill") ? "is-on" : "is-off"}>{diff.fill.length} to fill</span>}
      {diff.change.length > 0 && <span className={applies("change") ? "is-warn" : "is-off"}>{diff.change.length} different</span>}
      <span className="rv-diff-pop" role="tooltip">
        {[...diff.fill.map((f) => ({ ...f, k: "fill" as const })), ...diff.change.map((f) => ({ ...f, k: "change" as const }))].slice(0, 12).map((f) => (
          <span key={f.key} className={applies(f.k) ? "" : "is-off"}><b>{f.label}</b><s>{f.from || "empty"}</s><i>→</i><em>{f.to}</em></span>
        ))}
        <small>{mode === "keep" ? "Kept as in the CRM" : mode === "fill" ? "Only the empty ones are filled" : "All of these take the file's value"}</small>
      </span>
    </span>
  );
}

const ROW_H = 32;
/** Every row and column of the file, like a spreadsheet (only the visible rows are drawn). */
export function SheetViewer({ sheet, name, hasHeader, mapping, labelOf, canJump, onJump, onClose }: {
  sheet: Sheet; name: string; hasHeader: boolean; mapping: Record<number, string>;
  labelOf: (t: string) => { label: string; tone: Tone }; canJump: boolean; onJump: (col: number) => void; onClose: () => void;
}) {
  const width = useMemo(() => Math.max(1, ...sheet.rows.map((r) => r.length)), [sheet]);
  const body = useMemo(() => sheet.rows.map((r, i) => ({ r, n: i + 1 })).slice(hasHeader ? 1 : 0), [sheet, hasHeader]);
  const [q, setQ] = useState("");
  const [onlyMapped, setOnlyMapped] = useState(false);
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const cols = useMemo(() => Array.from({ length: width }, (_, i) => i).filter((i) => !onlyMapped || mapping[i]), [width, onlyMapped, mapping]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? body.filter((x) => x.r.some((c) => cellText(c).toLowerCase().includes(n))) : body;
  }, [body, q]);
  const widths = useMemo(() => Array.from({ length: width }, (_, i) => {
    let m = hasHeader ? cellText(sheet.rows[0]?.[i] ?? null).length + 2 : 4;
    for (const x of body.slice(0, 300)) m = Math.max(m, cellText(x.r[i] ?? null).length);
    return Math.round(Math.max(96, Math.min(340, m * 7.3 + 26)));
  }), [sheet, body, width, hasHeader]);
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [vh, setVh] = useState(700);
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    const ro = new ResizeObserver(() => setVh(el.clientHeight));
    ro.observe(el); setVh(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); setTop(0); }, [q, onlyMapped]);
  const start = Math.max(0, Math.floor(top / ROW_H) - 10);
  const end = Math.min(shown.length, start + Math.ceil(vh / ROW_H) + 24);
  const total = 58 + cols.reduce((s, i) => s + widths[i], 0);
  const needle = q.trim().toLowerCase();
  const mappedN = Object.values(mapping).filter(Boolean).length;
  return (
    <div className="di-sv" role="dialog" aria-label="The whole sheet">
      <div className="di-sv-h">
        <span className="di-sv-ico"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9.5h18M3 15h18M9 4v16M15 4v16" /></svg></span>
        <div className="di-sv-t"><b title={name}>{name}</b><small>{fmtN(body.length)} rows × {width} columns{q ? ` · ${fmtN(shown.length)} match` : ""}</small></div>
        <label className="di-search">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the sheet…" />
          {q && <button onClick={() => setQ("")} aria-label="Clear">×</button>}
        </label>
        <label className="di-check"><input type="checkbox" checked={onlyMapped} onChange={(e) => setOnlyMapped(e.target.checked)} /><span />Only mapped columns ({mappedN})</label>
        <button className="di-x" onClick={onClose} aria-label="Close the sheet">×</button>
      </div>
      <div className="di-sv-scroll" ref={scroller} onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)}>
        <table style={{ width: total }} onMouseLeave={() => setHoverCol(null)}>
          <colgroup><col style={{ width: 58 }} />{cols.map((i) => <col key={i} style={{ width: widths[i] }} />)}</colgroup>
          <thead>
            <tr className="is-letters">
              <th className="is-corner" />
              {cols.map((i) => {
                const t = mapping[i];
                const lab = t ? labelOf(t) : null;
                return (
                  <th key={i} className={`${t ? "is-mapped" : ""} ${hoverCol === i ? "is-hover" : ""} ${canJump ? "can-jump" : ""}`} onMouseEnter={() => setHoverCol(i)}
                    onClick={() => canJump && onJump(i)} title={canJump ? "Go to this column's mapping" : undefined}>
                    <span className="di-sv-letter">{colLetter(i)}</span>
                    {lab ? <span className={`di-sv-to is-${lab.tone}`}>{lab.label}</span> : <span className="di-sv-to is-off">not imported</span>}
                  </th>
                );
              })}
            </tr>
            {hasHeader && (
              <tr className="is-names">
                <th className="is-corner is-n">1</th>
                {cols.map((i) => <th key={i} className={hoverCol === i ? "is-hover" : ""} onMouseEnter={() => setHoverCol(i)} title={cellText(sheet.rows[0]?.[i] ?? null)}>{cellText(sheet.rows[0]?.[i] ?? null)}</th>)}
              </tr>
            )}
          </thead>
          <tbody>
            {start > 0 && <tr className="di-sv-pad" style={{ height: start * ROW_H }}><td colSpan={cols.length + 1} /></tr>}
            {shown.slice(start, end).map((x) => (
              <tr key={x.n}>
                <th className="di-sv-n">{x.n}</th>
                {cols.map((i) => {
                  const v = cellText(x.r[i] ?? null);
                  const hit = needle && v.toLowerCase().includes(needle);
                  return <td key={i} className={`${hit ? "is-hit" : ""} ${hoverCol === i ? "is-hover" : ""} ${typeof x.r[i] === "number" ? "is-num" : ""}`} title={v.length > 24 ? v : undefined} onMouseEnter={() => setHoverCol(i)}>{v}</td>;
                })}
              </tr>
            ))}
            {end < shown.length && <tr className="di-sv-pad" style={{ height: (shown.length - end) * ROW_H }}><td colSpan={cols.length + 1} /></tr>}
          </tbody>
        </table>
        {shown.length === 0 && <p className="di-muted di-pad">No row has “{q}”.</p>}
      </div>
    </div>
  );
}

/* ═══════════════════════════ cleaning & merging columns (shared by every importer) ═══════════════════════════ */

/** A column's values recomputed from rows that were cleaned / merged. */
export function columnsFromRows(columns: Column[], rows: SheetCell[][]): Column[] {
  return columns.map((c) => {
    const values = rows.map((r) => r[c.i] ?? null);
    const filled = values.filter((v) => v != null && v !== "");
    return { ...c, values, filled: filled.length, samples: filled.slice(0, 3) };
  });
}

const RULE_OPS: ColRuleOp[] = ["dropWords", "keepWords", "dropLastWords", "keepLastWords", "removeCol", "before", "after", "replace", "case"];
const ruleUid = () => Math.random().toString(36).slice(2, 9);

/**
 * Under a mapped column: rules that clean its values, and — when several columns go to
 * the same field — which one wins when they both have data.
 */
export function ColumnTools({ col, columns, rows, prep, onPrep, target, targetLabel, group }: {
  col: Column; columns: Column[]; rows: SheetCell[][]; prep: ImportPrep; onPrep: (p: ImportPrep) => void;
  target: string; targetLabel: string;
  /** The columns feeding this field, in priority order (null = only this one). */
  group: number[] | null;
}) {
  const rules = prep.rules[col.i] ?? [];
  const [openRules, setOpenRules] = useState(false);
  const merge = group ? prep.merges[target] ?? { order: group, mode: "first" as MergeMode, sep: " " } : null;
  const primary = group ? group[0] === col.i : false;
  const [openMerge, setOpenMerge] = useState(!prep.merges[target]);
  const letter = (i: number) => columns.find((c) => c.i === i)?.letter ?? "?";
  const header = (i: number) => columns.find((c) => c.i === i)?.header ?? "";

  const setRules = (rs: ColRule[]) => onPrep({ ...prep, rules: { ...prep.rules, [col.i]: rs } });
  const patchRule = (id: string, p: Partial<ColRule>) => setRules(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const addRule = (op: ColRuleOp) => {
    const other = group?.find((c) => c !== col.i) ?? columns.find((c) => c.i !== col.i)?.i;
    setRules([...rules, { id: ruleUid(), op, n: 1, col: op === "removeCol" ? other : undefined, text: op === "before" || op === "after" ? "," : "", with: "", to: "title" }]);
    setOpenRules(true);
  };
  const setMerge = (p: Partial<MergeRule>) => onPrep({ ...prep, merges: { ...prep.merges, [target]: { ...merge!, order: group!, ...p } } });
  const move = (i: number, d: -1 | 1) => {
    const o = [...group!]; const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    setMerge({ order: o });
  };

  // previews
  const clean = (r: SheetCell[], c: number) => applyColRules(cellText(r[c] ?? null), prep.rules[c], r);
  const rulePreview = useMemo(() => {
    if (!rules.length) return [];
    const out: { from: string; to: string }[] = [];
    for (const r of rows) {
      const from = cellText(r[col.i] ?? null).trim();
      if (!from) continue;
      out.push({ from, to: applyColRules(from, rules, r) });
      if (out.length >= 5) break;
    }
    return out;
  }, [rules, rows, col.i]);
  const changed = useMemo(() => (rules.length ? rows.filter((r) => { const v = cellText(r[col.i] ?? null).trim(); return v && applyColRules(v, rules, r) !== v; }).length : 0), [rules, rows, col.i]);
  const mergeInfo = useMemo(() => {
    if (!group || !primary || !merge) return null;
    let both = 0, conflict = 0;
    const sample: { vals: string[]; out: string }[] = [];
    for (const r of rows) {
      const vals = group.map((c) => clean(r, c));
      const filled = vals.filter(Boolean);
      if (filled.length < 2) continue;
      both++;
      if (new Set(filled.map((v) => normHeader(v))).size > 1) {
        conflict++;
        if (sample.length < 5) sample.push({ vals, out: mergeValues(vals, merge) });
      }
    }
    return { both, conflict, sample };
  }, [group, primary, merge, rows, prep.rules]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="di-tools">
      <div className="di-tools-bar">
        <button className={`di-tool ${rules.length ? "is-on" : ""}`} onClick={() => setOpenRules((o) => !o)} aria-expanded={openRules}>
          <svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
          {rules.length ? `${rules.length} ${rules.length === 1 ? "rule" : "rules"} on the values · ${changed} changed` : "Clean the values"}
        </button>
        {group && primary && (
          <button className="di-tool is-merge" onClick={() => setOpenMerge((o) => !o)}>
            <svg viewBox="0 0 24 24"><path d="M8 3v5a4 4 0 0 0 4 4h0a4 4 0 0 1 4 4v5M16 3v5a4 4 0 0 1-4 4" /></svg>
            {group.length} columns → “{targetLabel}” · {MERGE_LABEL[merge!.mode].toLowerCase()}
          </button>
        )}
        {group && !primary && (
          <span className="di-tool-note">Merged into “{targetLabel}” — priority {group.indexOf(col.i) + 1} of {group.length}; the merge is set on column {letter(group[0])}</span>
        )}
      </div>

      {openRules && (
        <div className="di-rules">
          {rules.map((r, k) => (
            <div key={r.id} className="di-rulerow" style={{ ["--j" as string]: k } as CSSProperties}>
              <em>{k + 1}</em>
              <Select size="sm" value={r.op} onChange={(v) => patchRule(r.id, { op: v as ColRuleOp })}
                options={RULE_OPS.map((op) => ({ value: op, label: RULE_LABEL[op] }))} />
              {(r.op === "dropWords" || r.op === "keepWords" || r.op === "dropLastWords" || r.op === "keepLastWords") && (
                <label className="di-rulep"><input type="number" min={1} max={20} value={r.n ?? 1} onChange={(e) => patchRule(r.id, { n: Math.max(1, +e.target.value || 1) })} /><span>{(r.n ?? 1) === 1 ? "word" : "words"}</span></label>
              )}
              {r.op === "removeCol" && (
                <Select size="sm" value={r.col != null ? String(r.col) : ""} onChange={(v) => patchRule(r.id, { col: +v })} placeholder="Which column?"
                  options={columns.filter((c) => c.i !== col.i).map((c) => ({ value: String(c.i), label: `${c.letter} · ${c.header}` }))} />
              )}
              {(r.op === "before" || r.op === "after") && (
                <>
                  <input className="di-rulet" value={r.text ?? ""} placeholder="e.g. ,  or  -" onChange={(e) => patchRule(r.id, { text: e.target.value })} />
                  <Select size="sm" value={r.last ? "last" : "first"} onChange={(v) => patchRule(r.id, { last: v === "last" })}
                    options={[{ value: "first", label: "first time it appears" }, { value: "last", label: "last time it appears" }]} />
                </>
              )}
              {r.op === "replace" && (
                <>
                  <input className="di-rulet" value={r.text ?? ""} placeholder="find" onChange={(e) => patchRule(r.id, { text: e.target.value })} />
                  <span className="di-rulex">→</span>
                  <input className="di-rulet" value={r.with ?? ""} placeholder="replace with (empty = remove)" onChange={(e) => patchRule(r.id, { with: e.target.value })} />
                </>
              )}
              {r.op === "case" && (
                <Select size="sm" value={r.to ?? "title"} onChange={(v) => patchRule(r.id, { to: v as ColRule["to"] })}
                  options={[{ value: "title", label: "Title Case" }, { value: "upper", label: "UPPERCASE" }, { value: "lower", label: "lowercase" }]} />
              )}
              <button className="di-rulex is-del" onClick={() => setRules(rules.filter((x) => x.id !== r.id))} aria-label="Remove rule">×</button>
            </div>
          ))}
          <div className="di-rules-foot">
            <Select size="sm" className="is-add" value="" placeholder="+ Add a rule…" onChange={(v) => v && addRule(v as ColRuleOp)}
              options={RULE_OPS.map((op) => ({ value: op, label: RULE_LABEL[op] }))} />
            <span>Applied in order, before the value is imported.</span>
          </div>
          {rulePreview.length > 0 && (
            <div className="di-prev">
              {rulePreview.map((p, i) => (
                <div key={i}><s title={p.from}>{p.from}</s><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg><b title={p.to}>{p.to || <i>empty</i>}</b></div>
              ))}
            </div>
          )}
        </div>
      )}

      {group && primary && openMerge && merge && (
        <div className="di-merge">
          <div className="di-merge-order">
            <span className="di-merge-h">Priority</span>
            {group.map((c, i) => (
              <div key={c} className="di-merge-col" style={{ ["--j" as string]: i } as CSSProperties}>
                <em>{i + 1}</em><b>{letter(c)}</b><span title={header(c)}>{header(c)}</span>
                <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="Higher priority">↑</button>
                <button disabled={i === group.length - 1} onClick={() => move(i, 1)} aria-label="Lower priority">↓</button>
              </div>
            ))}
          </div>
          <div className="di-merge-mode">
            <span className="di-merge-h">When several have data</span>
            <div className="di-merge-modes">
              {(Object.keys(MERGE_LABEL) as MergeMode[]).map((m) => (
                <button key={m} className={merge.mode === m ? "is-on" : ""} onClick={() => setMerge({ mode: m })}>{MERGE_LABEL[m]}</button>
              ))}
            </div>
            {merge.mode === "join" && (
              <label className="di-merge-sep">Separator <input value={merge.sep} onChange={(e) => setMerge({ sep: e.target.value })} placeholder="space" /></label>
            )}
            {mergeInfo && (
              <p className="di-merge-stat">
                {mergeInfo.both ? <>{fmtN(mergeInfo.both)} {mergeInfo.both === 1 ? "row has" : "rows have"} data in more than one · <b>{fmtN(mergeInfo.conflict)} with different values</b></> : "No row has data in more than one — each row takes the one it has."}
              </p>
            )}
          </div>
          {mergeInfo && mergeInfo.sample.length > 0 && (
            <div className="di-prev is-merge">
              {mergeInfo.sample.map((s, i) => (
                <div key={i}>{s.vals.map((v, j) => <s key={j} title={v}>{letter(group[j])}: {v || "—"}</s>)}<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg><b title={s.out}>{s.out}</b></div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

