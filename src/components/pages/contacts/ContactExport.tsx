/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import SalesMultiFilter from "../sales/sales/SalesMultiFilter";
import DatePicker from "../../framework/DatePicker";
import { useBackToClose } from "../../framework/useBackToClose";
import { downloadBlob, tableToCsv, tableToXlsx, type ExportCell } from "../../framework/exportFile";
import { inPeriod, PERIODS } from "../sales/extras/salesReportEngine";
import { listTrackingFields, type TrackingField } from "../sales/extras/trackingFieldsApi";
import { listTrackings, loadAllTrackingOwners, loadAllTrackingEmployees, loadPotentialTotals, type Tracking } from "../sales/sales/salesApi";
import { listPipelines } from "../settings/pipelineApi";
import { loadProducts } from "../settings/catalogApi";
import {
  listCompanyFields, loadRelationshipSets, listEmployees, loadContactAssignees, loadCompanyAssignees,
  type Company, type Contact, type ContactField, type CompanyField, type RelationshipSets,
} from "../companies/companiesApi";
import { buildCatalog, contactMatches, condReady, cellOf, formatOf, OPS, DEFAULT_OP, NO_VALUE, type XF, type Ctx, type Cond, type Src } from "./exportCatalog";
import { listImportBatches, batchLabel } from "./importBatches";
import "./ContactExport.css";

type RowMode = "contact" | "company" | "deal";
interface XRow { ctx: Ctx; key: string }
const SRC_LABEL: Record<Src, string> = { contact: "Contact", company: "Company", deal: "Deal" };
const uid = () => Math.random().toString(36).slice(2, 9);
const norm = (s: any) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const fullName = (c: Contact) => [c.first_name, c.last_name].filter(Boolean).join(" ");
const fmtN = (n: number) => n.toLocaleString("es-ES");

/* ═══════════════════════════ component ═══════════════════════════ */

type Step = "who" | "rows" | "columns" | "download";
const STEPS: { key: Step; label: string; hint: string }[] = [
  { key: "who", label: "Who", hint: "Choose the contacts" },
  { key: "rows", label: "Rows", hint: "What each row is" },
  { key: "columns", label: "Columns", hint: "What to include" },
  { key: "download", label: "Download", hint: "Check and export" },
];

export default function ContactExport({ contacts, companies, contactFields, shownIds, onClose }: {
  /** The contacts this person may see (already filtered by access). */
  contacts: Contact[];
  companies: Company[];
  contactFields: ContactField[];
  /** Contacts currently listed on the page (search + filters), for "start from what I see". */
  shownIds?: string[];
  onClose: () => void;
}) {
  useBackToClose("contact-export", onClose);
  const [step, setStep] = useState<Step>("who");
  const [trackings, setTrackings] = useState<Tracking[]>([]);
  const [extra, setExtra] = useState<{
    pipelines: Record<string, string>; phases: Record<string, { name: string; pipeline: string }>; products: Record<string, string>;
    companyFields: CompanyField[]; dealFields: TrackingField[]; rel: RelationshipSets | null; people: Record<string, string>;
    contactAssignees: Record<string, string[]>; companyAssignees: Record<string, string[]>;
    owners: Record<string, string>; team: Record<string, string[]>; dealProducts: Record<string, string[]>;
    dealTotals: Record<string, number>; phaseHistory: Record<string, string[]>;
    imports: Record<string, string>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [conds, setConds] = useState<Cond[]>([]);
  const [match, setMatch] = useState<"all" | "any">("all");
  const [dealScope, setDealScope] = useState<"direct" | "company">("direct");
  const [same, setSame] = useState({ company: true, deal: true });
  const [rowMode, setRowMode] = useState<RowMode>("contact");
  const [cols, setCols] = useState<string[]>([]);
  const [colQ, setColQ] = useState("");
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [fileName, setFileName] = useState(`contacts-${new Date().toISOString().slice(0, 10)}`);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      const rows = (q: any) => q.then((r: any) => r.data ?? [], () => []);
      const [t, pl, ph, pr, cf, rs, emp, ca, coa, own, tm, totals, tp, ev, ib, df] = await Promise.all([
        listTrackings().catch(() => []),
        listPipelines().catch(() => []),
        rows(supabase.from("pipeline_phases").select("id, name, pipeline_id").range(0, 99999)),
        loadProducts().catch(() => []),
        listCompanyFields().catch(() => []),
        loadRelationshipSets().catch(() => null),
        listEmployees().catch(() => []),
        loadContactAssignees().catch(() => ({})),
        loadCompanyAssignees().catch(() => ({})),
        loadAllTrackingOwners().catch(() => ({})),
        loadAllTrackingEmployees().catch(() => ({})),
        loadPotentialTotals().catch(() => ({})),
        rows(supabase.from("tracking_products").select("tracking_id, product_id").range(0, 99999)),
        rows(supabase.from("tracking_phase_events").select("tracking_id, phase_id").range(0, 99999)),
        listImportBatches().catch(() => []),
        listTrackingFields().catch(() => []),
      ]);
      const people = Object.fromEntries((emp as any[]).map((e) => [e.id, e.name]));
      const pipelines = Object.fromEntries((pl as any[]).map((p) => [p.id, p.name]));
      const group = (list: any[], k: string, v: string) => { const o: Record<string, string[]> = {}; list.forEach((r) => { if (r[k] && r[v]) (o[r[k]] ??= []).push(r[v]); }); return o; };
      setTrackings(t as Tracking[]);
      setExtra({
        pipelines,
        phases: Object.fromEntries((ph as any[]).map((p) => [p.id, { name: p.name, pipeline: pipelines[p.pipeline_id] ?? "" }])),
        products: Object.fromEntries((pr as any[]).map((p) => [p.id, p.name])),
        companyFields: cf as CompanyField[], dealFields: df as TrackingField[], rel: rs,
        people,
        imports: Object.fromEntries((ib as any[]).map((b) => [b.id, batchLabel(b, people)])),
        contactAssignees: ca as Record<string, string[]>, companyAssignees: coa as Record<string, string[]>,
        owners: own as Record<string, string>, team: tm as Record<string, string[]>,
        dealProducts: group(tp as any[], "tracking_id", "product_id"),
        dealTotals: totals as Record<string, number>,
        phaseHistory: group(ev as any[], "tracking_id", "phase_id"),
      });
      setLoading(false);
    })();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".smf-menu, .dp-pop")) onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  /* ---- lookups ---- */
  const companyById = useMemo(() => new Map(companies.map((c) => [c.id as string, c])), [companies]);
  const dealsByContact = useMemo(() => {
    const m = new Map<string, Tracking[]>();
    trackings.forEach((t) => t.contactIds.forEach((cid) => { const a = m.get(cid) ?? []; a.push(t); m.set(cid, a); }));
    return m;
  }, [trackings]);
  const dealsByCompany = useMemo(() => {
    const m: Record<string, Tracking[]> = {};
    trackings.forEach((t) => { if (t.company_id) (m[t.company_id] ??= []).push(t); });
    return m;
  }, [trackings]);
  const ctxOf = (c: Contact): Ctx => {
    const cos = c.companyIds.map((id) => companyById.get(id)).filter(Boolean) as Company[];
    const direct = dealsByContact.get(c.id as string) ?? [];
    const deals = dealScope === "company" ? [...new Map([...direct, ...cos.flatMap((co) => dealsByCompany[co.id as string] ?? [])].map((d) => [d.id, d])).values()] : direct;
    return { c, cos, deals };
  };

  /* ---- the catalogue: every column, custom field and relationship, discovered from the data ---- */
  const fields = useMemo<XF[]>(() => (extra ? buildCatalog({
    contacts, companies, deals: trackings, contactFields: contactFields as any, companyFields: extra.companyFields as any, dealFields: extra.dealFields as any,
    people: extra.people, pipelines: extra.pipelines, phases: extra.phases, products: extra.products,
    clientCompanyIds: extra.rel?.clientCompanyIds ?? new Set(), clientContactIds: extra.rel?.clientContactIds ?? new Set(),
    contactAssignees: extra.contactAssignees, companyAssignees: extra.companyAssignees, owners: extra.owners, team: extra.team,
    dealProducts: extra.dealProducts, dealTotals: extra.dealTotals, phaseHistory: extra.phaseHistory, dealsByCompany, shownIds, imports: extra.imports,
  }) : []), [extra, contacts, companies, trackings, contactFields, dealsByCompany, shownIds]);
  const fieldBy = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  /* ---- who matches ---- */
  const ready = conds.filter((c) => condReady(fieldBy.get(c.field), c));
  const matched = useMemo(() => {
    const active = ready.map((c) => ({ f: fieldBy.get(c.field)!, c }));
    if (!active.length) return contacts;
    return contacts.filter((c) => contactMatches(ctxOf(c), active, match, same, inPeriod));
  }, [contacts, conds, match, same, fieldBy, dealScope, dealsByContact]); // eslint-disable-line react-hooks/exhaustive-deps

  const addCond = (field = "", preset?: Partial<Cond>) => {
    const f = fieldBy.get(field);
    setConds((cs) => [...cs, { id: uid(), field, op: f ? DEFAULT_OP[f.kind] : "", vals: [], a: f?.kind === "date" ? "this_year" : "", b: "", ...preset }]);
  };
  const patchCond = (id: string, patch: Partial<Cond>) => setConds((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const quick = [
    { k: "all", label: "All contacts", apply: () => setConds([]) },
    { k: "open", label: "In an open deal", apply: () => setConds([{ id: uid(), field: "deal:@open", op: "yes", vals: [], a: "", b: "" }]) },
    { k: "clients", label: "At client companies", apply: () => setConds([{ id: uid(), field: "company:@client", op: "yes", vals: [], a: "", b: "" }]) },
    { k: "nocompany", label: "Without a company", apply: () => setConds([{ id: uid(), field: "company:@has", op: "no", vals: [], a: "", b: "" }]) },
    ...(shownIds ? [{ k: "screen", label: `On screen now (${shownIds.length})`, apply: () => setConds([{ id: uid(), field: "contact:@onscreen", op: "yes", vals: [], a: "", b: "" }]) }] : []),
  ];

  /* ---- columns: every field of the catalogue can be a column ---- */
  const columns = useMemo(() => fields.filter((f) => !f.noColumn), [fields]);
  const colBy = fieldBy;
  const presetBasic = ["contact:@name", "contact:position", "contact:email", "contact:phone", "company:@which"].filter((k) => fieldBy.has(k));
  useEffect(() => { if (!cols.length && columns.length) setCols(presetBasic); }, [columns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- rows: per contact, or per contact × company / deal (each row then looks at that one) ---- */
  const rows = useMemo<XRow[]>(() => {
    const out: XRow[] = [];
    matched.forEach((c) => {
      const x = ctxOf(c);
      if (rowMode === "company" && x.cos.length) x.cos.forEach((co) => out.push({ ctx: { ...x, cos: [co] }, key: `${c.id}|${co.id}` }));
      else if (rowMode === "deal" && x.deals.length) x.deals.forEach((d) => out.push({ ctx: { ...x, deals: [d] }, key: `${c.id}|${d.id}` }));
      else out.push({ ctx: x, key: String(c.id) });
    });
    return out;
  }, [matched, rowMode, dealScope, dealsByContact]); // eslint-disable-line react-hooks/exhaustive-deps
  const table = useMemo(() => {
    const chosen = cols.map((k) => colBy.get(k)).filter(Boolean) as XF[];
    return {
      columns: chosen.map((f) => ({ label: f.src === "contact" ? f.label : f.label.startsWith(SRC_LABEL[f.src]) ? f.label : `${SRC_LABEL[f.src]} · ${f.label}`, format: formatOf(f) })),
      rows: rows.map((r) => chosen.map((f) => cellOf(f, r.ctx) as ExportCell)),
    };
  }, [cols, colBy, rows]);
  const show = (v: ExportCell) => (v == null ? "" : typeof v === "object" ? v.date.split("-").reverse().join("/") : typeof v === "number" ? v.toLocaleString("es-ES") : v);

  const doExport = () => {
    const base = (fileName.trim() || "contacts").replace(/[\\/:*?"<>|]+/g, "-").replace(/\.(xlsx|csv)$/i, "");
    const blob = format === "xlsx" ? tableToXlsx(table, "Contacts") : tableToCsv(table);
    downloadBlob(blob, `${base}.${format}`);
    setDone(true); window.setTimeout(() => setDone(false), 2600);
  };

  /* ---- step navigation ---- */
  const idx = STEPS.findIndex((s) => s.key === step);
  const problem = step === "who" ? (matched.length ? null : "No contact matches these conditions.") : step === "columns" ? (cols.length ? null : "Choose at least one column.") : null;
  const usesDeals = ready.some((c) => c.field.startsWith("deal:")) || cols.some((k) => k.startsWith("deal:")) || rowMode === "deal";
  const usesSame = (src: Src) => ready.filter((c) => c.field.startsWith(`${src}:`) && fieldBy.get(c.field)?.perEntity).length > 1;
  const animatedCount = useCount(matched.length);

  const fieldOptions = (["contact", "company", "deal"] as Src[]).flatMap((src) => fields.filter((f) => f.src === src).map((f) => ({ value: f.key, label: `${SRC_LABEL[src]} · ${f.label}${f.auto ? " · auto" : ""}` })));
  const groups: { src: Src; title: string; hint: string }[] = [
    { src: "contact", title: "Contact", hint: "Their own details and custom fields" },
    { src: "company", title: "Company", hint: "From the companies they belong to (several are joined with “;”)" },
    { src: "deal", title: "Deals", hint: "From the deals they’re in" },
  ];
  const nq = norm(colQ);

  return createPortal(
    <div className="cx-backdrop" onMouseDown={onClose}>
      <div className="cx" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Export contacts">
        <header className="cx-head">
          <div className="cx-head-txt"><span className="cx-eyebrow">Export</span><h2>Contacts</h2></div>
          <nav className="cx-steps">
            {STEPS.map((s, i) => (
              <button key={s.key} className={`cx-step ${i === idx ? "is-on" : ""} ${i < idx ? "is-done" : ""}`} onClick={() => i <= idx && setStep(s.key)} disabled={i > idx}>
                <span className="cx-step-bar"><i /></span>
                <span className="cx-step-row"><b>{i < idx ? "✓" : i + 1}</b><span>{s.label}<em>{s.hint}</em></span></span>
              </button>
            ))}
          </nav>
          <button className="cx-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="cx-body">
          <div className="cx-pane" key={step}>
            {/* ===== 1. WHO ===== */}
            {step === "who" && (
              <>
                <Explain n={1} title="Which contacts do you want?" text="Start from everyone, or add conditions. Conditions can look at the contact, at the companies they belong to and at the deals they’re in — for example “Deal · Phase is Demo” or “Company · City is Madrid”." />
                <div className="cx-quick">
                  {quick.map((q) => <button key={q.k} onClick={q.apply}>{q.label}</button>)}
                </div>
                <div className="cx-who">
                  <div className="cx-conds">
                    {conds.length > 1 && (
                      <div className="cx-match">Show contacts that match
                        <div className="cx-seg"><button className={match === "all" ? "is-on" : ""} onClick={() => setMatch("all")}>all</button><button className={match === "any" ? "is-on" : ""} onClick={() => setMatch("any")}>any</button></div>
                        of these conditions
                      </div>
                    )}
                    {conds.map((c, i) => {
                      const f = fieldBy.get(c.field);
                      return (
                        <div className={`cx-cond ${f ? `is-${f.src}` : ""} ${f && !condReady(f, c) ? "is-incomplete" : ""}`} key={c.id} style={{ ["--i" as string]: i } as CSSProperties}>
                          <span className="cx-cond-src">{f ? SRC_LABEL[f.src] : "?"}</span>
                          <div className="cx-cond-field">
                            <SalesMultiFilter single values={c.field ? [c.field] : []} placeholder="Choose what to look at…" searchFrom={6} options={fieldOptions}
                              onChange={(v) => { const nf = fieldBy.get(v[0]); if (nf) patchCond(c.id, { field: nf.key, op: DEFAULT_OP[nf.kind], vals: [], a: nf.kind === "date" ? "this_year" : "", b: "" }); }} />
                          </div>
                          {f && (
                            <div className="cx-cond-op">
                              <SalesMultiFilter single values={[c.op]} placeholder="How" searchFrom={99} options={OPS[f.kind]} onChange={(v) => v[0] && patchCond(c.id, { op: v[0] })} />
                            </div>
                          )}
                          {f && !NO_VALUE.has(c.op) && (
                            <div className="cx-cond-val">
                              {f.kind === "enum" ? (
                                <SalesMultiFilter values={c.vals} onChange={(v) => patchCond(c.id, { vals: v })} placeholder="Choose…" searchFrom={8} options={f.options ?? []} />
                              ) : f.kind === "date" && c.op === "period" ? (
                                <SalesMultiFilter single values={[c.a]} onChange={(v) => v[0] && patchCond(c.id, { a: v[0] })} placeholder="Period" searchFrom={99}
                                  options={PERIODS.filter((p) => p.key !== "all" && p.key !== "custom").map((p) => ({ value: p.key, label: `${p.group} · ${p.label}` }))} />
                              ) : f.kind === "date" ? (
                                <div className="cx-two"><DatePicker value={c.a} onChange={(d) => patchCond(c.id, { a: d })} placeholder="From" /><span>–</span><DatePicker value={c.b} onChange={(d) => patchCond(c.id, { b: d })} placeholder="To" /></div>
                              ) : c.op === "between" ? (
                                <div className="cx-two"><input type="number" value={c.a} onChange={(e) => patchCond(c.id, { a: e.target.value })} placeholder="From" /><span>–</span><input type="number" value={c.b} onChange={(e) => patchCond(c.id, { b: e.target.value })} placeholder="To" /></div>
                              ) : (
                                <input className="cx-input" type={f.kind === "number" ? "number" : "text"} value={c.a} onChange={(e) => patchCond(c.id, { a: e.target.value })} placeholder={f.kind === "number" ? "Number" : "Text"} />
                              )}
                            </div>
                          )}
                          <button className="cx-cond-x" onClick={() => setConds((cs) => cs.filter((x) => x.id !== c.id))} aria-label="Remove condition">×</button>
                        </div>
                      );
                    })}
                    <div className="cx-add">
                      <span>Add a condition about</span>
                      {(["contact", "company", "deal"] as Src[]).map((src) => (
                        <button key={src} className={`is-${src}`} onClick={() => addCond(fields.find((f) => f.src === src)?.key ?? "")}>
                          + {SRC_LABEL[src].toLowerCase()}
                        </button>
                      ))}
                    </div>
                    {match === "all" && (usesSame("company") || usesSame("deal")) && (
                      <div className="cx-scope is-same">
                        {usesSame("company") && (
                          <label className="cx-switch"><input type="checkbox" checked={same.company} onChange={(e) => setSame((v) => ({ ...v, company: e.target.checked }))} /><i />
                            Company conditions must all be true <b>for the same company</b></label>
                        )}
                        {usesSame("deal") && (
                          <label className="cx-switch"><input type="checkbox" checked={same.deal} onChange={(e) => setSame((v) => ({ ...v, deal: e.target.checked }))} /><i />
                            Deal conditions must all be true <b>in the same deal</b></label>
                        )}
                      </div>
                    )}
                    {usesDeals && (
                      <div className="cx-scope">
                        <span>Deals that count for a contact</span>
                        <div className="cx-seg">
                          <button className={dealScope === "direct" ? "is-on" : ""} onClick={() => setDealScope("direct")}>Deals they’re added to</button>
                          <button className={dealScope === "company" ? "is-on" : ""} onClick={() => setDealScope("company")}>Also their company’s deals</button>
                        </div>
                      </div>
                    )}
                  </div>
                  <aside className="cx-count">
                    <span className="cx-k">Matching contacts</span>
                    <b>{loading ? "…" : fmtN(Math.round(animatedCount))}</b>
                    <em>of {fmtN(contacts.length)} you can see</em>
                    <div className="cx-faces">
                      {matched.slice(0, 7).map((c, i) => <i key={c.id} style={{ ["--h" as string]: hue(fullName(c)), ["--j" as string]: i } as CSSProperties} title={fullName(c)}>{initials(fullName(c))}</i>)}
                      {matched.length > 7 && <i className="is-more">+{matched.length - 7}</i>}
                    </div>
                    <ul>{matched.slice(0, 4).map((c) => <li key={c.id}>{fullName(c)}<span>{c.companyIds.map((id) => companyById.get(id)?.name).filter(Boolean).join(", ")}</span></li>)}</ul>
                  </aside>
                </div>
              </>
            )}

            {/* ===== 2. ROWS ===== */}
            {step === "rows" && (
              <>
                <Explain n={2} title="What should each row of the file be?" text="Most of the time one row per contact is what you want. If a contact belongs to several companies or is in several deals, you can also get one row for each of them." />
                <div className="cx-modes">
                  {([
                    ["contact", "One row per contact", "Companies and deals are listed together in their columns, separated with “;”.", `${fmtN(matched.length)} rows`],
                    ["company", "One row per contact and company", "A contact at two companies appears twice — handy to group by company.", `${fmtN(matched.reduce((s, c) => s + Math.max(1, c.companyIds.length), 0))} rows`],
                    ["deal", "One row per contact and deal", "A contact in three deals appears three times, each with that deal’s phase and value.", `${fmtN(matched.reduce((n, c) => n + Math.max(1, ctxOf(c).deals.length), 0))} rows`],
                  ] as [RowMode, string, string, string][]).map(([k, t, d, n], i) => (
                    <button key={k} className={`cx-mode ${rowMode === k ? "is-on" : ""}`} onClick={() => setRowMode(k)} style={{ ["--i" as string]: i } as CSSProperties}>
                      <span className="cx-mode-art" aria-hidden="true">
                        {Array.from({ length: k === "contact" ? 3 : 4 }, (_, j) => <i key={j} className={k !== "contact" && j > 0 && j < 3 ? "is-dup" : ""} />)}
                      </span>
                      <b>{t}</b><em>{d}</em><span className="cx-mode-n">{n}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* ===== 3. COLUMNS ===== */}
            {step === "columns" && (
              <>
                <Explain n={3} title="Which columns do you want in the file?" text="Tick the information you need. Company columns come from the contact’s companies and deal columns from their deals. Put them in the order you like on the right." />
                <div className="cx-cols">
                  <div className="cx-avail">
                    <div className="cx-avail-top">
                      <input className="cx-input" value={colQ} onChange={(e) => setColQ(e.target.value)} placeholder="Search a column…" />
                      <button onClick={() => setCols(presetBasic)}>Basic</button>
                      <button onClick={() => setCols(columns.map((c) => c.key))}>Everything</button>
                    </div>
                    {groups.map((g) => {
                      const list = columns.filter((c) => c.src === g.src && (!nq || norm(c.label).includes(nq)));
                      if (!list.length) return null;
                      return (
                        <div className={`cx-group is-${g.src}`} key={g.src}>
                          <div className="cx-group-h"><b>{g.title}</b><em>{g.hint}</em></div>
                          <div className="cx-chips">
                            {list.map((c) => {
                              const on = cols.includes(c.key);
                              return <button key={c.key} className={on ? "is-on" : ""} onClick={() => setCols((cs) => (on ? cs.filter((k) => k !== c.key) : [...cs, c.key]))} title={c.auto ? "Found automatically in your data" : undefined}><i>{on ? "✓" : "+"}</i>{c.label}{c.auto && <em className="cx-auto">auto</em>}</button>;
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="cx-order">
                    <div className="cx-order-h"><b>Your file</b><em>{cols.length} {cols.length === 1 ? "column" : "columns"}, left to right</em></div>
                    {cols.map((k, i) => {
                      const c = colBy.get(k); if (!c) return null;
                      return (
                        <div className={`cx-ocol is-${c.src}`} key={k}>
                          <span className="cx-ocol-n">{i + 1}</span>
                          <span className="cx-ocol-l">{c.label}<em>{SRC_LABEL[c.src]}</em></span>
                          <button onClick={() => setCols((cs) => { const n = [...cs]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })} disabled={i === 0} aria-label="Move up">↑</button>
                          <button onClick={() => setCols((cs) => { const n = [...cs]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })} disabled={i === cols.length - 1} aria-label="Move down">↓</button>
                          <button onClick={() => setCols((cs) => cs.filter((x) => x !== k))} aria-label="Remove">×</button>
                        </div>
                      );
                    })}
                    {!cols.length && <p className="cx-muted">Nothing chosen yet.</p>}
                  </div>
                </div>
              </>
            )}

            {/* ===== 4. DOWNLOAD ===== */}
            {step === "download" && (
              <>
                <Explain n={4} title="Check it and download" text="This is exactly what the file will contain. Pick Excel or CSV, name it and download." />
                <div className="cx-final">
                  <div className="cx-summary">
                    <div><b>{fmtN(matched.length)}</b><span>contacts</span></div>
                    <div><b>{fmtN(rows.length)}</b><span>rows · {rowMode === "contact" ? "one per contact" : rowMode === "company" ? "one per contact and company" : "one per contact and deal"}</span></div>
                    <div><b>{cols.length}</b><span>columns</span></div>
                  </div>
                  <div className="cx-preview">
                    <table>
                      <thead><tr>{table.columns.map((c, i) => <th key={i}>{c.label}</th>)}</tr></thead>
                      <tbody>{table.rows.slice(0, 15).map((r, i) => <tr key={i} style={{ ["--i" as string]: i } as CSSProperties}>{r.map((v, j) => <td key={j}>{show(v)}</td>)}</tr>)}</tbody>
                    </table>
                    {rows.length > 15 && <p className="cx-muted">…and {fmtN(rows.length - 15)} more rows in the file.</p>}
                  </div>
                  <div className="cx-out">
                    <div className="cx-seg is-big">
                      <button className={format === "xlsx" ? "is-on" : ""} onClick={() => setFormat("xlsx")}>Excel (.xlsx)</button>
                      <button className={format === "csv" ? "is-on" : ""} onClick={() => setFormat("csv")}>CSV</button>
                    </div>
                    <label className="cx-fname"><input value={fileName} onChange={(e) => setFileName(e.target.value)} aria-label="File name" /><span>.{format}</span></label>
                    <button className={`cx-download ${done ? "is-done" : ""}`} onClick={doExport} disabled={!rows.length || !cols.length}>
                      {done
                        ? <><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>Downloaded</>
                        : <><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>Download {fmtN(rows.length)} rows</>}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <footer className="cx-foot">
          <span className={`cx-foot-note ${problem ? "is-warn" : ""}`}>{problem ?? (step === "who" ? `${fmtN(matched.length)} contacts selected` : step === "rows" ? `${fmtN(rows.length)} rows` : step === "columns" ? `${cols.length} columns chosen` : "Ready")}</span>
          <div className="cx-foot-actions">
            {idx > 0 ? <button className="cx-btn is-ghost" onClick={() => setStep(STEPS[idx - 1].key)}>Back</button> : <button className="cx-btn is-ghost" onClick={onClose}>Cancel</button>}
            {step !== "download" && <button className="cx-btn is-primary" disabled={!!problem || loading} onClick={() => setStep(STEPS[idx + 1].key)}>Next: {STEPS[idx + 1].label} →</button>}
            {step === "download" && <button className="cx-btn is-ghost" onClick={onClose}>Close</button>}
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/* ═══════════════════════════ small pieces ═══════════════════════════ */

function Explain({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <div className="cx-explain">
      <span className="cx-explain-n">{n}</span>
      <div><h3>{title}</h3><p>{text}</p></div>
    </div>
  );
}
const hue = (s: string) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
const initials = (n: string) => n.split(" ").filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
function useCount(target: number) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current, t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 500);
      const cur = start + (target - start) * (1 - Math.pow(1 - p, 3));
      from.current = cur; setV(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}