/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from "react";
import {
  contactsList, companiesList, listContacts, listCompanies,
  type Contact, type Company, type ServerView,
} from "../companies/companiesApi";
import { StatusPills, CompanyLogo } from "../companies/CompaniesPage";
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
const VIEW: ServerView = { match: "all", conds: [], sort: [{ key: "name", dir: "asc", type: "text" }] };
const COLL = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const norm = (s: string | null | undefined) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const fullName = (c: Contact) => [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed";
const fmt = (n: number) => n.toLocaleString("en-GB");

type Side<T> = { rows: T[]; total: number; done: boolean };
type Row =
  | { kind: "contact"; id: string; name: string; c: Contact }
  | { kind: "company"; id: string; name: string; co: Company };
type Srv = { __status?: string[]; __pipes?: string[]; __types?: string[]; __from?: Record<string, string[]>; __coNames?: Record<string, string>; __parentName?: string | null };
const srv = (x: object) => x as Srv;

const GRID = "minmax(290px, 2.1fr) minmax(104px, 0.5fr) minmax(180px, 1.5fr) minmax(170px, 1.3fr) minmax(124px, 0.9fr) minmax(110px, 0.8fr)";
const ROW_MIN = 290 + 104 + 180 + 170 + 124 + 110 + 20 * 5 + 40;

export default function OrbitAll({ onNew, onOpen, refresh }: {
  onNew: (kind: OrbitKind) => void;
  onOpen: (kind: OrbitKind, id: string) => void;
  /** Goes up after a save in a panel: the list is read again. */
  refresh: number;
}) {
  const [q, setQ] = useState("");
  const [ct, setCt] = useState<Side<Contact> | null>(null);
  const [co, setCo] = useState<Side<Company> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const gen = useRef(0);
  const busy = useRef({ ct: false, co: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  // "Address complete" follows the required fields of Settings (same as the Contacts list)
  const ctx = useMemo(() => ({ required: PROFILE_FIELDS.filter((f) => f.required).map((f) => f.key) }), []);

  /** Databases without the list functions: everything read here, searched and sorted in the page. */
  const loadLocal = async (g: number, search: string) => {
    const [cts, cos] = await Promise.all([listContacts(), listCompanies()]);
    if (g !== gen.current) return;
    const s = norm(search.trim());
    const hitC = (c: Contact) => !s || [fullName(c), c.email, c.position, c.city].some((v) => norm(v).includes(s));
    const hitO = (x: Company) => !s || [x.name, x.legal_name, x.email, x.vat_number, x.city].some((v) => norm(v).includes(s));
    const a = cts.filter(hitC).sort((x, y) => COLL.compare(fullName(x), fullName(y)));
    const b = cos.filter(hitO).sort((x, y) => COLL.compare(x.name ?? "", y.name ?? ""));
    setCt({ rows: a, total: a.length, done: true });
    setCo({ rows: b, total: b.length, done: true });
    setErr(null);
  };

  // a new search (or a save in a panel) starts again from A
  useEffect(() => {
    const g = ++gen.current;
    busy.current = { ct: false, co: false };
    const t = window.setTimeout(async () => {
      try {
        const [a, b] = await Promise.all([contactsList(VIEW, q, 0, BLOCK, ctx), companiesList(VIEW, q, 0, BLOCK)]);
        if (g !== gen.current) return;
        if (!a || !b) { await loadLocal(g, q); return; }
        setCt({ rows: a.rows, total: a.total, done: a.rows.length >= a.total });
        setCo({ rows: b.rows, total: b.total, done: b.rows.length >= b.total });
        setErr(null);
        if (!refresh || q) scrollRef.current?.scrollTo({ top: 0 });
      } catch (e) {
        if (g === gen.current) setErr(String((e as any)?.message ?? e));
      }
    }, g === 1 ? 0 : 200);
    return () => window.clearTimeout(t);
  }, [q, refresh, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  // both sides merged by name; cut where the side with more to read stops (the next block may sort in before)
  const rows = useMemo<Row[]>(() => {
    if (!ct || !co) return [];
    const A: Row[] = ct.rows.map((c) => ({ kind: "contact", id: c.id as string, name: fullName(c), c }));
    const B: Row[] = co.rows.map((x) => ({ kind: "company", id: x.id as string, name: x.name || "Unnamed", co: x }));
    const out: Row[] = [];
    let i = 0, j = 0;
    while (i < A.length || j < B.length) {
      if (j >= B.length || (i < A.length && COLL.compare(A[i].name, B[j].name) <= 0)) out.push(A[i++]);
      else out.push(B[j++]);
    }
    const lims = [ct.done ? null : A[A.length - 1]?.name, co.done ? null : B[B.length - 1]?.name].filter((x): x is string => x != null);
    if (!lims.length) return out;
    const lim = lims.reduce((m, x) => (COLL.compare(x, m) < 0 ? x : m));
    const cut = out.findIndex((r) => COLL.compare(r.name, lim) > 0);
    return cut < 0 ? out : out.slice(0, cut);
  }, [ct, co]);
  const more = !!ct && !!co && (!ct.done || !co.done);

  /** The next block of whichever side stops first (the one holding the list back). */
  const loadMore = () => {
    if (!ct || !co || !more) return;
    const lastA = ct.done ? null : fullName(ct.rows[ct.rows.length - 1]);
    const lastB = co.done ? null : co.rows[co.rows.length - 1]?.name ?? "";
    const side: "ct" | "co" = lastA == null ? "co" : lastB == null ? "ct" : COLL.compare(lastA, lastB) <= 0 ? "ct" : "co";
    if (busy.current[side]) return;
    busy.current[side] = true;
    const g = gen.current;
    if (side === "ct") {
      const from = ct.rows.length;
      contactsList(VIEW, q, from, BLOCK, ctx).then((r) => {
        if (!r || g !== gen.current) return;
        setCt((cur) => (cur && cur.rows.length === from ? { rows: [...cur.rows, ...r.rows], total: r.total, done: !r.rows.length || from + r.rows.length >= r.total } : cur));
      }).catch(() => {}).finally(() => { if (g === gen.current) busy.current.ct = false; });
    } else {
      const from = co.rows.length;
      companiesList(VIEW, q, from, BLOCK).then((r) => {
        if (!r || g !== gen.current) return;
        setCo((cur) => (cur && cur.rows.length === from ? { rows: [...cur.rows, ...r.rows], total: r.total, done: !r.rows.length || from + r.rows.length >= r.total } : cur));
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

  return (
    <div className="ct ob">
      <header className="ct-head">
        <OrbitSwitch on="all" />
        <div className="ct-search">
          <span className="ct-search-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg></span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts and companies…" aria-label="Search contacts and companies" />
          {q && <button onClick={() => setQ("")} aria-label="Clear search">×</button>}
        </div>
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
        ]} />
      </header>

      {err && <p className="cl-hint is-error">{err} <button type="button" className="ct-retry" onClick={() => setRetry((x) => x + 1)}>Try again</button></p>}
      {!ct || !co ? (err ? null : <PageLoader label="Loading contacts and companies…" fill={false} />) : rows.length === 0 && !more ? (
        <div className="ob-empty">
          <p className="cl-hint">{q.trim() ? `Nothing matches “${q.trim()}”.` : total === 0 ? "Nothing here yet. Add your first contact or company." : "Nothing to show."}</p>
          {!q.trim() && total === 0 && (
            <div className="ob-empty-actions">
              <button type="button" className="ob-empty-btn is-contact" onClick={() => onNew("contact")}>New contact</button>
              <button type="button" className="ob-empty-btn is-company" onClick={() => onNew("company")}>New company</button>
            </div>
          )}
        </div>
      ) : (
        <div ref={scrollRef} className="ct-scroll is-xscroll" style={{ ["--row-min" as string]: `${ROW_MIN}px` } as CSSProperties} onScroll={onScroll}>
          <div className="ct-lhead-wrap">
            <div className="ct-lrow ct-lhead" style={{ gridTemplateColumns: GRID }}>
              <span className="ct-lid-head"><span>Name</span></span>
              <span>Kind</span>
              <span>Position · Company</span>
              <span>Email</span>
              <span>Phone</span>
              <span>City</span>
            </div>
          </div>
          <div className="ct-list">
            {rows.map((r) => {
              const s = srv(r.kind === "contact" ? r.c : r.co);
              const status = s.__status ? { client: s.__status.includes("client"), sales: s.__status.includes("sales"), pipelines: s.__pipes ?? [] } : null;
              const tags = s.__types ?? Object.keys(s.__from ?? {});
              const detail = r.kind === "contact"
                ? [r.c.position, Object.values(s.__coNames ?? {}).join(", ")].filter(Boolean).join(" · ")
                : [r.co.sector, s.__parentName ? `part of ${s.__parentName}` : null].filter(Boolean).join(" · ");
              const email = r.kind === "contact" ? r.c.email : r.co.email;
              const phone = r.kind === "contact" ? r.c.phone || (r.c as any).landline : r.co.phone;
              const city = r.kind === "contact" ? r.c.city : r.co.city;
              return (
                <button key={`${r.kind}:${r.id}`} type="button" className={`ct-lrow ob-row is-${r.kind}`} style={{ gridTemplateColumns: GRID }} onClick={() => onOpen(r.kind, r.id)}>
                  <span className="ct-lcell ct-lid">
                    <span className="ct-av-wrap">
                      {r.kind === "contact"
                        ? <span className="ct-avatar">{r.name.slice(0, 1).toUpperCase()}</span>
                        : <CompanyLogo name={r.name} website={r.co.website} className="co-avatar" />}
                    </span>
                    <span className="ct-lname">{r.name}</span>
                    {status && <span className="ob-pills"><StatusPills status={status} tags={tags} from={s.__from} /></span>}
                  </span>
                  <span className="ct-lcell"><span className={`ob-kind is-${r.kind}`}>{r.kind === "contact" ? "Contact" : "Company"}</span></span>
                  <span className="ct-lcell ob-cell">{detail || dash}</span>
                  <span className="ct-lcell">{email ? <span className="ct-lemail">{email}</span> : dash}</span>
                  <span className="ct-lcell ob-cell">{phone || dash}</span>
                  <span className="ct-lcell ob-cell">{city || dash}</span>
                </button>
              );
            })}
            {more && <div className="ob-more" aria-hidden="true"><span /><span /><span /></div>}
          </div>
        </div>
      )}
    </div>
  );
}
