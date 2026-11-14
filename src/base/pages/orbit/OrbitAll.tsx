/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react";
import {
  contactsList, companiesList, listContacts, listCompanies, loadPrefs, savePref,
  type Contact, type Company, type ServerView,
} from "../companies/companiesApi";
import {
  StatusPills, CompanyLogo, ColumnsEditor, FilterBar, FilterChips, applyView, emptyView, useStoredView, useSavedViews,
  type FField, type FView,
} from "../companies/CompaniesPage";
import { ColumnHead } from "../../framework/ColumnHead";
import { PROFILE_FIELDS } from "../contacts/contactProfile";
import ActionsMenu, { AM_ICON } from "../../framework/ActionsMenu";
import { PageLoader } from "../../framework/AppLayout";
import OrbitSwitch from "./OrbitSwitch";
import type { OrbitKind } from "./orbitTypes";
import "../clients/ClientsPage.css";
import "../companies/CompaniesPage.css";
import "../contacts/ContactsPage.css";
import "./Orbit.css";

/**
 * BASE · Orbit › All: contacts and companies in one list, A to Z.
 * Each side is read from the database a block at a time (contacts_list / companies_list,
 * the same functions as the two lists, so visibility rules are the same) and the two are
 * merged by name; a row is only shown once both sides have been read past it.
 */

const BLOCK = 60;
const COLL = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const norm = (s: string | null | undefined) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const fullName = (c: Contact) => [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed";
const fmt = (n: number) => n.toLocaleString("en-GB");
const day = (x?: string | null) => (x ? new Date(x).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

type Side<T> = { rows: T[]; total: number; done: boolean };
type Row =
  | { kind: "contact"; id: string; name: string; c: Contact }
  | { kind: "company"; id: string; name: string; co: Company };
type Srv = { __status?: string[]; __pipes?: string[]; __types?: string[]; __from?: Record<string, string[]>; __coNames?: Record<string, string>; __parentName?: string | null };
const srv = (x: object) => x as Srv;
const rec = (r: Row) => (r.kind === "contact" ? r.c : r.co) as any;

/* ---------- the columns you can show (Name is always first); each remembers its own width ---------- */
type ColKey = "kind" | "detail" | "email" | "phone" | "city" | "country" | "address" | "linkedin" | "created_at";
const COLS: Record<ColKey, { label: string; w: string; min: number }> = {
  kind: { label: "Kind", w: "minmax(112px, 0.5fr)", min: 112 },
  detail: { label: "Position · Company", w: "minmax(180px, 1.5fr)", min: 180 },
  email: { label: "Email", w: "minmax(190px, 1.3fr)", min: 190 },
  phone: { label: "Phone", w: "minmax(130px, 0.9fr)", min: 130 },
  city: { label: "City", w: "minmax(110px, 0.8fr)", min: 110 },
  country: { label: "Country", w: "minmax(110px, 0.8fr)", min: 110 },
  address: { label: "Address", w: "minmax(220px, 1.6fr)", min: 220 },
  linkedin: { label: "LinkedIn", w: "minmax(160px, 1fr)", min: 160 },
  created_at: { label: "Added", w: "minmax(112px, 0.7fr)", min: 112 },
};
const COL_KEYS = Object.keys(COLS) as ColKey[];
const DEFAULT_COLS: ColKey[] = ["kind", "detail", "email", "phone", "city"];
const AVAILABLE = COL_KEYS.map((k) => ({ key: k, label: COLS[k].label }));
const NAME_COL = { w: "minmax(290px, 2.1fr)", min: 290 };

/** What a row shows in a column (also what the header filters on when the list is read here). */
const cellOf = (r: Row, k: ColKey): string => {
  const x = rec(r);
  switch (k) {
    case "kind": return r.kind;
    case "detail": {
      const s = srv(x);
      return r.kind === "contact"
        ? [r.c.position, Object.values(s.__coNames ?? {}).join(", ")].filter(Boolean).join(" · ")
        : [r.co.sector, s.__parentName ? `part of ${s.__parentName}` : null].filter(Boolean).join(" · ");
    }
    case "email": return x.email ?? "";
    case "phone": return x.phone || x.landline || "";
    case "city": return (x.city ?? "").trim();
    case "country": return (x.country ?? "").trim();
    case "address": return [[x.street, x.addr_number].filter(Boolean).join(" "), [x.postal_code, x.city].filter(Boolean).join(" "), x.country].filter(Boolean).join(", ");
    case "linkedin": return x.linkedin ?? "";
    case "created_at": return x.created_at ?? "";
  }
};

/** The header filters: the same keys on both sides, so the database filters contacts and companies alike. */
const FIELDS: FField<Row>[] = [
  { key: "name", label: "Name", group: "Record", type: "text", get: (r) => r.name },
  { key: "kind", label: "Kind", group: "Record", type: "select", get: (r) => r.kind, options: () => [{ value: "contact", label: "Contact" }, { value: "company", label: "Company" }] },
  { key: "email", label: "Email", group: "Contact details", type: "text", get: (r) => cellOf(r, "email") },
  { key: "phone", label: "Phone", group: "Contact details", type: "text", get: (r) => cellOf(r, "phone") },
  { key: "city", label: "City", group: "Address", type: "text", get: (r) => cellOf(r, "city") },
  { key: "country", label: "Country", group: "Address", type: "text", get: (r) => cellOf(r, "country") },
  { key: "address", label: "Address", group: "Address", type: "text", get: (r) => cellOf(r, "address") },
  { key: "linkedin", label: "LinkedIn", group: "Contact details", type: "text", get: (r) => cellOf(r, "linkedin") },
  { key: "created_at", label: "Added", group: "Record", type: "date", get: (r) => cellOf(r, "created_at") || null },
];
const FIELD = new Map(FIELDS.map((f) => [f.key, f]));
const START_VIEW: FView = emptyView([{ key: "name", dir: "asc" }]);
/** Which sides the Kind filter keeps. */
const sidesOf = (view: FView) => {
  const c = view.conds.find((x) => x.field === "kind");
  if (!c) return { contact: true, company: true };
  const vals = c.values ?? [];
  const keep = (k: string) => (c.op === "in" ? !vals.length || vals.includes(k) : c.op === "nin" ? !vals.includes(k) : c.op !== "empty");
  return { contact: keep("contact"), company: keep("company") };
};

export default function OrbitAll({ onNew, onOpen, refresh }: {
  onNew: (kind: OrbitKind) => void;
  onOpen: (kind: OrbitKind, id: string) => void;
  /** Goes up after a save in a panel: the list is read again. */
  refresh: number;
}) {
  const [q, setQ] = useState("");
  const [view, storeView] = useStoredView("next.orbit.all.view", START_VIEW);
  /** All is read in name order (A → Z or Z → A): other sorts don't apply here. */
  const setView = (v: FView) => storeView({ ...v, sort: v.sort.filter((x) => x.key === "name").slice(0, 1) });
  const [cols, setCols] = useState<ColKey[]>(DEFAULT_COLS);
  const [showCols, setShowCols] = useState(false);
  const [savedViews, setSavedViews] = useSavedViews("orbitAllViews");
  const [filtersTick, setFiltersTick] = useState(0);
  /** Everything there is (no filter, no search): the "x of y" of the chips. */
  const allTotal = useRef<number | null>(null);
  const [ct, setCt] = useState<Side<Contact> | null>(null);
  const [co, setCo] = useState<Side<Company> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const gen = useRef(0);
  const busy = useRef({ ct: false, co: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  // "Address complete" follows the required fields of Settings (same as the Contacts list)
  const ctx = useMemo(() => ({ required: PROFILE_FIELDS.filter((f) => f.required).map((f) => f.key) }), []);

  // the columns are yours (kept with your profile, like the Contacts and Companies lists)
  useEffect(() => {
    loadPrefs().then((p) => { if (Array.isArray(p.orbitAllColumns)) setCols(p.orbitAllColumns.filter((k: string): k is ColKey => k in COLS)); }).catch(() => {});
  }, []);
  const saveCols = (next: string[]) => { const c = next.filter((k): k is ColKey => k in COLS); setCols(c); savePref("orbitAllColumns", c).catch(() => {}); };

  // ---- what the database is asked: the header filters (Kind picks the sides) and A → Z or Z → A ----
  const dir: 1 | -1 = view.sort[0]?.key === "name" && view.sort[0]?.dir === "desc" ? -1 : 1;
  const cmp = (a: string, b: string) => dir * COLL.compare(a, b);
  const sides = sidesOf(view);
  const sview = useMemo<ServerView>(() => ({
    match: view.match,
    conds: view.conds.filter((c) => c.field !== "kind" && FIELD.has(c.field)).map((c) => ({ ...c, type: FIELD.get(c.field)!.type })),
    sort: [{ key: "name", dir: dir === 1 ? "asc" : "desc", type: "text" }],
  }), [view, dir]);
  const key = JSON.stringify([sview, sides]);
  const cur = useRef({ sview, q, sides });
  cur.current = { sview, q, sides };
  const NONE = { rows: [], total: 0, done: true };

  /** Databases without the list functions: everything read here, filtered, searched and sorted in the page. */
  const loadLocal = async (g: number) => {
    const [cts, cos] = await Promise.all([listContacts(), listCompanies()]);
    if (g !== gen.current) return;
    const s = norm(cur.current.q.trim());
    const hitC = (c: Contact) => !s || [fullName(c), c.email, c.position, c.city].some((v) => norm(v).includes(s));
    const hitO = (x: Company) => !s || [x.name, x.legal_name, x.email, x.vat_number, x.city].some((v) => norm(v).includes(s));
    const A = applyView<Row>(cts.filter(hitC).map((c) => ({ kind: "contact", id: c.id as string, name: fullName(c), c })), FIELDS, view);
    const B = applyView<Row>(cos.filter(hitO).map((x) => ({ kind: "company", id: x.id as string, name: x.name || "Unnamed", co: x })), FIELDS, view);
    const a = A.map((r) => (r as Extract<Row, { kind: "contact" }>).c);
    const b = B.map((r) => (r as Extract<Row, { kind: "company" }>).co);
    setCt({ rows: a, total: a.length, done: true });
    setCo({ rows: b, total: b.length, done: true });
    setErr(null);
  };

  // a new search, filter or sort (or a save in a panel) starts again from the top
  useEffect(() => {
    const g = ++gen.current;
    busy.current = { ct: false, co: false };
    const t = window.setTimeout(async () => {
      try {
        const { sview: v, sides: sd } = cur.current;
        const [a, b] = await Promise.all([
          sd.contact ? contactsList(v, q, 0, BLOCK, ctx) : Promise.resolve(NONE as Side<Contact>),
          sd.company ? companiesList(v, q, 0, BLOCK) : Promise.resolve(NONE as Side<Company>),
        ]);
        if (g !== gen.current) return;
        if (!a || !b) { await loadLocal(g); return; }
        setCt({ rows: a.rows, total: a.total, done: a.rows.length >= a.total });
        setCo({ rows: b.rows, total: b.total, done: b.rows.length >= b.total });
        if (!q.trim() && !cur.current.sview.conds.length && sd.contact && sd.company) allTotal.current = a.total + b.total;
        setErr(null);
        if (!refresh || q) scrollRef.current?.scrollTo({ top: 0 });
      } catch (e) {
        if (g === gen.current) setErr(String((e as any)?.message ?? e));
      }
    }, g === 1 ? 0 : 200);
    return () => window.clearTimeout(t);
  }, [q, refresh, retry, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // both sides merged by name; cut where the side with more to read stops (the next block may sort in before)
  const rows = useMemo<Row[]>(() => {
    if (!ct || !co) return [];
    const A: Row[] = ct.rows.map((c) => ({ kind: "contact", id: c.id as string, name: fullName(c), c }));
    const B: Row[] = co.rows.map((x) => ({ kind: "company", id: x.id as string, name: x.name || "Unnamed", co: x }));
    const out: Row[] = [];
    let i = 0, j = 0;
    while (i < A.length || j < B.length) {
      if (j >= B.length || (i < A.length && cmp(A[i].name, B[j].name) <= 0)) out.push(A[i++]);
      else out.push(B[j++]);
    }
    const lims = [ct.done ? null : A[A.length - 1]?.name, co.done ? null : B[B.length - 1]?.name].filter((x): x is string => x != null);
    if (!lims.length) return out;
    const lim = lims.reduce((m, x) => (cmp(x, m) < 0 ? x : m));
    const cut = out.findIndex((r) => cmp(r.name, lim) > 0);
    return cut < 0 ? out : out.slice(0, cut);
  }, [ct, co, dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = !!ct && !!co && (!ct.done || !co.done);

  /** The next block of whichever side stops first (the one holding the list back). */
  const loadMore = () => {
    if (!ct || !co || !more) return;
    const lastA = ct.done ? null : fullName(ct.rows[ct.rows.length - 1]);
    const lastB = co.done ? null : co.rows[co.rows.length - 1]?.name ?? "";
    const side: "ct" | "co" = lastA == null ? "co" : lastB == null ? "ct" : cmp(lastA, lastB) <= 0 ? "ct" : "co";
    if (busy.current[side]) return;
    busy.current[side] = true;
    const g = gen.current;
    const { sview: v, q: qq } = cur.current;
    if (side === "ct") {
      const from = ct.rows.length;
      contactsList(v, qq, from, BLOCK, ctx).then((r) => {
        if (!r || g !== gen.current) return;
        setCt((c) => (c && c.rows.length === from ? { rows: [...c.rows, ...r.rows], total: r.total, done: !r.rows.length || from + r.rows.length >= r.total } : c));
      }).catch(() => {}).finally(() => { if (g === gen.current) busy.current.ct = false; });
    } else {
      const from = co.rows.length;
      companiesList(v, qq, from, BLOCK).then((r) => {
        if (!r || g !== gen.current) return;
        setCo((c) => (c && c.rows.length === from ? { rows: [...c.rows, ...r.rows], total: r.total, done: !r.rows.length || from + r.rows.length >= r.total } : c));
      }).catch(() => {}).finally(() => { if (g === gen.current) busy.current.co = false; });
    }
  };
  // keep the screen filled: a short merged list asks for the next block straight away
  useEffect(() => { if (more && rows.length < 40) loadMore(); }, [rows.length, more, ct, co]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.classList.toggle("is-scrolled-x", el.scrollLeft > 4);
    el.classList.toggle("is-scrolled-y", el.scrollTop > 2);
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 1400) loadMore();
  };

  const dash = <span className="ct-lmuted">—</span>;
  const total = (ct?.total ?? 0) + (co?.total ?? 0);
  const filtered = view.conds.length > 0;
  const grid = [NAME_COL.w, ...cols.map((k) => COLS[k].w)].join(" ");
  const rowMin = NAME_COL.min + cols.reduce((n, k) => n + COLS[k].min, 0) + 20 * cols.length + 40;
  const cell = (r: Row, k: ColKey): ReactNode => {
    if (k === "kind") return <span className={`ob-kind is-${r.kind}`}>{r.kind === "contact" ? "Contact" : "Company"}</span>;
    const v = cellOf(r, k);
    if (!v) return dash;
    if (k === "email") return <span className="ct-lemail">{v}</span>;
    if (k === "created_at") return <span className="ob-cell">{day(v)}</span>;
    if (k === "linkedin") return <span className="ob-cell">{v.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "")}</span>;
    return <span className="ob-cell">{v}</span>;
  };

  return (
    <div className="ct ob">
      <header className="ct-head">
        <OrbitSwitch on="all" />
        <div className="ct-search">
          <span className="ct-search-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg></span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts and companies…" aria-label="Search contacts and companies" />
          {q && <button onClick={() => setQ("")} aria-label="Clear search">×</button>}
        </div>
        <FilterBar fields={FIELDS} view={view} onView={setView} total={allTotal.current ?? total} shown={total} noun={["record", "records"]}
          saved={savedViews} onSaved={setSavedViews} openSignal={filtersTick} />
        {ct && co && (
          <span className="ct-kpi ob-kpi">
            <b>{fmt(ct.total)}</b>{ct.total === 1 ? "contact" : "contacts"}
            <i aria-hidden="true" />
            <b>{fmt(co.total)}</b>{co.total === 1 ? "company" : "companies"}
          </span>
        )}
        <ActionsMenu items={[
          { key: "new", group: "Create", label: "New contact", hint: "Add a person — or switch to a company in the panel", icon: AM_ICON.plus, primary: true, tone: "blue", shortcut: "N", quick: "contact", onSelect: () => onNew("contact") },
          { key: "newco", group: "Create", label: "New company", hint: "Add an account or a prospect", icon: AM_ICON.plus, tone: "violet", shortcut: "O", quick: "company", onSelect: () => onNew("company") },
          { key: "fields", group: "Setup", label: "Columns", hint: "What the list shows, and in which order", icon: AM_ICON.fields, tone: "amber", shortcut: "F", onSelect: () => setShowCols(true) },
        ]} />
      </header>

      <FilterChips fields={FIELDS} view={view} onView={setView} onEdit={() => setFiltersTick((x) => x + 1)} shown={total} total={allTotal.current ?? total} noun={["record", "records"]} />

      {err && <p className="cl-hint is-error">{err} <button type="button" className="ct-retry" onClick={() => setRetry((x) => x + 1)}>Try again</button></p>}
      {!ct || !co ? (err ? null : <PageLoader label="Loading contacts and companies…" fill={false} />) : (
        <div ref={scrollRef} className="ct-scroll is-xscroll" style={{ ["--row-min" as string]: `${rowMin}px` } as CSSProperties} onScroll={onScroll}>
          <div className="ct-lhead-wrap">
            <div className="ct-lrow ct-lhead" style={{ gridTemplateColumns: grid }}>
              <span className="ct-lid-head ch-cell"><ColumnHead label="Name" view={view} onView={setView} fields={[FIELD.get("name")]} sortKey="name" /></span>
              {cols.map((k) => (
                <span key={k} className="ch-cell">
                  {FIELD.has(k)
                    ? <ColumnHead label={COLS[k].label} view={view} onView={setView} fields={[FIELD.get(k)]} sortKey={null} className="is-nosort" />
                    : <span className="ob-hlabel">{COLS[k].label}</span>}
                </span>
              ))}
            </div>
          </div>
          {rows.length === 0 && !more ? (
            <div className="ob-empty">
              <p className="cl-hint">{q.trim() || filtered ? "Nothing matches — try another search or clear a filter." : total === 0 ? "Nothing here yet. Add your first contact or company." : "Nothing to show."}</p>
              {!q.trim() && !filtered && total === 0 && (
                <div className="ob-empty-actions">
                  <button type="button" className="ob-empty-btn is-contact" onClick={() => onNew("contact")}>New contact</button>
                  <button type="button" className="ob-empty-btn is-company" onClick={() => onNew("company")}>New company</button>
                </div>
              )}
            </div>
          ) : (
            <div className="ct-list">
              {rows.map((r) => {
                const s = srv(rec(r));
                const status = s.__status ? { client: s.__status.includes("client"), sales: s.__status.includes("sales"), pipelines: s.__pipes ?? [] } : null;
                const tags = s.__types ?? Object.keys(s.__from ?? {});
                return (
                  <button key={`${r.kind}:${r.id}`} type="button" className={`ct-lrow ob-row is-${r.kind}`} style={{ gridTemplateColumns: grid }} onClick={() => onOpen(r.kind, r.id)}>
                    <span className="ct-lcell ct-lid">
                      <span className="ct-av-wrap">
                        {r.kind === "contact"
                          ? <span className="ct-avatar">{r.name.slice(0, 1).toUpperCase()}</span>
                          : <CompanyLogo name={r.name} website={r.co.website} className="co-avatar" />}
                      </span>
                      <span className="ct-lname">{r.name}</span>
                      {status && <span className="ob-pills"><StatusPills status={status} tags={tags} from={s.__from} /></span>}
                    </span>
                    {cols.map((k) => <span key={k} className="ct-lcell">{cell(r, k)}</span>)}
                  </button>
                );
              })}
              {more && <div className="ob-more" aria-hidden="true"><span /><span /><span /></div>}
            </div>
          )}
        </div>
      )}

      {showCols && <ColumnsDrawer columns={cols} onColumns={saveCols} onClose={() => setShowCols(false)} />}
    </div>
  );
}

/** The list's columns (Name first, then as many as you like, drag to reorder) — the same editor as Contacts and Companies. */
function ColumnsDrawer({ columns, onColumns, onClose }: { columns: string[]; onColumns: (next: string[]) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dw-backdrop" onMouseDown={onClose}>
      <div className="dw dw-narrow" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dw-head">
          <div>
            <span className="dw-eyebrow">Configure</span>
            <h2 className="dw-title">All · list columns</h2>
          </div>
          <button className="dw-x" onClick={onClose}>×</button>
        </div>
        <div className="dw-body">
          <div className="dw-sec">
            <p className="dw-sec-title">Overview columns</p>
            <ColumnsEditor availableColumns={AVAILABLE} columns={columns} onColumns={onColumns} />
          </div>
        </div>
        <div className="dw-foot">
          <div className="dw-foot-right">
            <button className="dw-save" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
