/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import { PageLoader } from "../../framework/AppLayout";
import SalesMultiFilter from "../sales/sales/SalesMultiFilter";
import DatePicker from "../../framework/DatePicker";
import { useBackToClose } from "../../framework/useBackToClose";
import { useCloseGuard } from "../../framework/Dock";
import { downloadBlob, tableToCsv, tableToXlsx, type ExportCell } from "../../framework/exportFile";
import { inPeriod, PERIODS } from "../sales/extras/salesReportEngine";
import { listTrackingFields, type TrackingField } from "../sales/extras/trackingFieldsApi";
import { listTrackings, loadAllTrackingOwners, loadAllTrackingEmployees, loadPotentialTotals, type Tracking } from "../sales/sales/salesApi";
import { listPipelines } from "../settings/pipelineApi";
import { loadProducts } from "../settings/catalogApi";
import {
  listCompanyFields, listContactFields, loadRelationshipSets, listEmployees, loadContactAssignees, loadCompanyAssignees, pagedAll,
  type Company, type Contact, type ContactField, type CompanyField, type RelationshipSets,
} from "../companies/companiesApi";
import { buildCatalog, contactMatches, condReady, cellOf, formatOf, OPS, DEFAULT_OP, NO_VALUE, type XF, type Ctx, type Cond, type Src, type Root } from "./exportCatalog";
import { listImportBatches, batchLabel } from "./importBatches";
import Select from "../../framework/Select";
import { sendOutlookMail, type OutlookMail, type OutlookMailResult } from "../../api/outlookSync";
import "./ContactExport.css";

type RowMode = "contact" | "company" | "deal";
interface XRow { ctx: Ctx; key: string }
const SRC_LABEL: Record<Src, string> = { contact: "Contact", company: "Company", deal: "Deal" };
const uid = () => Math.random().toString(36).slice(2, 9);
const norm = (s: any) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const fullName = (c: Contact) => [c.first_name, c.last_name].filter(Boolean).join(" ");
const fmtN = (n: number) => n.toLocaleString("es-ES");

/* ═══════════════════════════ shared loader ═══════════════════════════ */
/** Everything around contacts and companies that conditions can look at (deals, owners, fields…). Used by the exports and Marketing. */
export type ExportExtra = {
  pipelines: Record<string, string>; phases: Record<string, { name: string; pipeline: string }>; products: Record<string, string>;
  companyFields: CompanyField[]; dealFields: TrackingField[]; rel: RelationshipSets | null; people: Record<string, string>;
  contactAssignees: Record<string, string[]>; companyAssignees: Record<string, string[]>;
  owners: Record<string, string>; team: Record<string, string[]>; dealProducts: Record<string, string[]>;
  dealTotals: Record<string, number>; phaseHistory: Record<string, string[]>;
  imports: Record<string, string>;
};
export async function loadExportWorld(): Promise<{ trackings: Tracking[]; extra: ExportExtra }> {
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
  return {
    trackings: t as Tracking[],
    extra: {
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
    },
  };
}

/* ═══════════════════════════ component ═══════════════════════════ */

type Step = "who" | "rows" | "columns" | "download";
const stepsFor = (noun: string): { key: Step; label: string; hint: string }[] => [
  { key: "who", label: "Who", hint: `Choose the ${noun}` },
  { key: "rows", label: "Rows", hint: "What each row is" },
  { key: "columns", label: "Columns", hint: "What to include" },
  { key: "download", label: "Download", hint: "Check and export" },
];

/**
 * Contacts → Export, and Companies → Export (`root="company"`): the same four
 * steps, with each row a contact or a company. Conditions and columns can look
 * at the record itself, at its companies / contacts and at its deals.
 */
export default function ContactExport({ contacts, companies, contactFields, shownIds, onClose, root = "contact" }: {
  /** The contacts this person may see (already filtered by access). */
  contacts: Contact[];
  /** The companies this person may see. */
  companies: Company[];
  contactFields: ContactField[];
  /** Records currently listed on the page (search + filters), for "start from what I see". */
  shownIds?: string[];
  onClose: () => void;
  /** What each row is: a contact (Contacts page) or a company (Companies page). */
  root?: Root;
}) {
  const isCo = root === "company";
  const noun = isCo ? "companies" : "contacts", one = isCo ? "company" : "contact";
  const STEPS = stepsFor(noun);
  const nameOf = (r: any) => (isCo ? r.name ?? "" : fullName(r));
  const [step, setStep] = useState<Step>("who");
  const [trackings, setTrackings] = useState<Tracking[]>([]);
  const [extra, setExtra] = useState<ExportExtra | null>(null);
  const [loading, setLoading] = useState(true);
  const [conds, setConds] = useState<Cond[]>([]);
  const [match, setMatch] = useState<"all" | "any">("all");
  const [dealScope, setDealScope] = useState<"direct" | "company">("direct");
  const [same, setSame] = useState({ company: true, deal: true, contact: true });
  const [rowMode, setRowMode] = useState<RowMode>(root);
  const [cols, setCols] = useState<string[]>([]);
  const [colQ, setColQ] = useState("");
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [fileName, setFileName] = useState(`${root === "company" ? "companies" : "contacts"}-${new Date().toISOString().slice(0, 10)}`);
  const [done, setDone] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  // Conditions set or steps gone through: Esc / backdrop / × / Cancel / Back ask first (not once downloaded).
  const guard = useCloseGuard({ dirty: (step !== "who" || conds.length > 0) && !downloaded, onClose, what: "export" });
  useBackToClose(root === "company" ? "company-export" : "contact-export", onClose, true, guard.holdBack);

  useEffect(() => {
    loadExportWorld().then(({ trackings: t, extra: x }) => { setTrackings(t); setExtra(x); setLoading(false); });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !guard.asking && !document.querySelector(".sel-pop, .smf-menu, .dp-pop")) guard.requestClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [guard.requestClose, guard.asking]);

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
  const contactsByCompany = useMemo(() => {
    const m = new Map<string, Contact[]>();
    contacts.forEach((c) => c.companyIds.forEach((id) => { const a = m.get(id) ?? []; a.push(c); m.set(id, a); }));
    return m;
  }, [contacts]);
  const ctxOf = (r: any): Ctx => {
    if (isCo) {
      // a company: its contacts, and its deals (also its contacts' deals, if chosen)
      const cts = contactsByCompany.get(r.id as string) ?? [];
      const direct = dealsByCompany[r.id as string] ?? [];
      const deals = dealScope === "company" ? [...new Map([...direct, ...cts.flatMap((ct) => dealsByContact.get(ct.id as string) ?? [])].map((d) => [d.id, d])).values()] : direct;
      return { c: r, cos: [r], cts, deals };
    }
    const c = r as Contact;
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
    dealProducts: extra.dealProducts, dealTotals: extra.dealTotals, phaseHistory: extra.phaseHistory, dealsByCompany, shownIds, imports: extra.imports, root,
  }) : []), [extra, contacts, companies, trackings, contactFields, dealsByCompany, shownIds, root]);
  const fieldBy = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  /* ---- who matches ---- */
  const ready = conds.filter((c) => condReady(fieldBy.get(c.field), c));
  const records: any[] = isCo ? companies : contacts;
  const matched = useMemo(() => {
    const active = ready.map((c) => ({ f: fieldBy.get(c.field)!, c }));
    if (!active.length) return records;
    return records.filter((r) => contactMatches(ctxOf(r), active, match, same, inPeriod));
  }, [records, conds, match, same, fieldBy, dealScope, dealsByContact, contactsByCompany]); // eslint-disable-line react-hooks/exhaustive-deps

  const addCond = (field = "", preset?: Partial<Cond>) => {
    const f = fieldBy.get(field);
    setConds((cs) => [...cs, { id: uid(), field, op: f ? DEFAULT_OP[f.kind] : "", vals: [], a: f?.kind === "date" ? "this_year" : "", b: "", ...preset }]);
  };
  const patchCond = (id: string, patch: Partial<Cond>) => setConds((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const q1 = (field: string, op: string) => () => setConds([{ id: uid(), field, op, vals: [], a: "", b: "" }]);
  const quick = isCo ? [
    { k: "all", label: "All companies", apply: () => setConds([]) },
    { k: "clients", label: "Clients", apply: q1("company:@client", "yes") },
    { k: "open", label: "With an open deal", apply: q1("deal:@open", "yes") },
    { k: "nodeal", label: "Never in a deal", apply: q1("deal:@has", "no") },
    { k: "nocontact", label: "Without contacts", apply: q1("contact:@has", "no") },
    ...(shownIds ? [{ k: "screen", label: `On screen now (${shownIds.length})`, apply: q1("company:@onscreen", "yes") }] : []),
  ] : [
    { k: "all", label: "All contacts", apply: () => setConds([]) },
    { k: "open", label: "In an open deal", apply: q1("deal:@open", "yes") },
    { k: "clients", label: "At client companies", apply: q1("company:@client", "yes") },
    { k: "nocompany", label: "Without a company", apply: q1("company:@has", "no") },
    ...(shownIds ? [{ k: "screen", label: `On screen now (${shownIds.length})`, apply: q1("contact:@onscreen", "yes") }] : []),
  ];

  /* ---- columns: every field of the catalogue can be a column ---- */
  const columns = useMemo(() => fields.filter((f) => !f.noColumn), [fields]);
  const colBy = fieldBy;
  const presetBasic = (isCo
    ? ["company:@which", "company:vat_number", "company:city", "company:country", "company:@ncontacts", "contact:@name"]
    : ["contact:@name", "contact:position", "contact:email", "contact:phone", "company:@which"]).filter((k) => fieldBy.has(k));
  useEffect(() => { if (!cols.length && columns.length) setCols(presetBasic); }, [columns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- rows: per record, or per record × company / contact / deal (each row then looks at that one) ---- */
  const rows = useMemo<XRow[]>(() => {
    const out: XRow[] = [];
    matched.forEach((r) => {
      const x = ctxOf(r);
      if (rowMode === "company" && !isCo && x.cos.length) x.cos.forEach((co) => out.push({ ctx: { ...x, cos: [co] }, key: `${r.id}|${co.id}` }));
      else if (rowMode === "contact" && isCo && x.cts?.length) x.cts.forEach((ct) => out.push({ ctx: { ...x, cts: [ct] }, key: `${r.id}|${ct.id}` }));
      else if (rowMode === "deal" && x.deals.length) x.deals.forEach((d) => out.push({ ctx: { ...x, deals: [d] }, key: `${r.id}|${d.id}` }));
      else out.push({ ctx: x, key: String(r.id) });
    });
    return out;
  }, [matched, rowMode, dealScope, dealsByContact, contactsByCompany]); // eslint-disable-line react-hooks/exhaustive-deps
  const table = useMemo(() => {
    const chosen = cols.map((k) => colBy.get(k)).filter(Boolean) as XF[];
    return {
      columns: chosen.map((f) => ({ label: f.src === root ? f.label : f.label.startsWith(SRC_LABEL[f.src]) ? f.label : `${SRC_LABEL[f.src]} · ${f.label}`, format: formatOf(f) })),
      rows: rows.map((r) => chosen.map((f) => cellOf(f, r.ctx) as ExportCell)),
    };
  }, [cols, colBy, rows]);
  const show = (v: ExportCell) => (v == null ? "" : typeof v === "object" ? v.date.split("-").reverse().join("/") : typeof v === "number" ? v.toLocaleString("es-ES") : v);

  const doExport = () => {
    const base = (fileName.trim() || noun).replace(/[\\/:*?"<>|]+/g, "-").replace(/\.(xlsx|csv)$/i, "");
    const blob = format === "xlsx" ? tableToXlsx(table, isCo ? "Companies" : "Contacts") : tableToCsv(table);
    downloadBlob(blob, `${base}.${format}`);
    setDone(true); setDownloaded(true); window.setTimeout(() => setDone(false), 2600);
  };

  /* ---- step navigation ---- */
  const idx = STEPS.findIndex((s) => s.key === step);
  const problem = step === "who" ? (matched.length ? null : `No ${one} matches these conditions.`) : step === "columns" ? (cols.length ? null : "Choose at least one column.") : null;
  const usesDeals = ready.some((c) => c.field.startsWith("deal:")) || cols.some((k) => k.startsWith("deal:")) || rowMode === "deal";
  const usesSame = (src: Src) => ready.filter((c) => c.field.startsWith(`${src}:`) && fieldBy.get(c.field)?.perEntity).length > 1;
  const animatedCount = useCount(matched.length);

  const order: Src[] = isCo ? ["company", "contact", "deal"] : ["contact", "company", "deal"];
  const fieldOptions = order.flatMap((src) => fields.filter((f) => f.src === src).map((f) => ({ value: f.key, label: `${SRC_LABEL[src]} · ${f.label}${f.auto ? " · auto" : ""}` })));
  const groups: { src: Src; title: string; hint: string }[] = isCo ? [
    { src: "company", title: "Company", hint: "Its own details and custom fields" },
    { src: "contact", title: "Contacts", hint: "From the people who work there (several are joined with “;”)" },
    { src: "deal", title: "Deals", hint: "From its deals" },
  ] : [
    { src: "contact", title: "Contact", hint: "Their own details and custom fields" },
    { src: "company", title: "Company", hint: "From the companies they belong to (several are joined with “;”)" },
    { src: "deal", title: "Deals", hint: "From the deals they’re in" },
  ];
  const nq = norm(colQ);

  return createPortal(
    <div className="cx-backdrop" {...guard.backdrop}>
      <div className="cx" role="dialog" aria-modal="true" aria-label={`Export ${noun}`}>
        <header className="cx-head">
          <div className="cx-head-txt"><span className="cx-eyebrow">Export</span><h2>{isCo ? "Companies" : "Contacts"}</h2></div>
          <nav className="cx-steps">
            {STEPS.map((s, i) => (
              <button key={s.key} className={`cx-step ${i === idx ? "is-on" : ""} ${i < idx ? "is-done" : ""}`} onClick={() => i <= idx && setStep(s.key)} disabled={i > idx}>
                <span className="cx-step-bar"><i /></span>
                <span className="cx-step-row"><b>{i < idx ? "✓" : i + 1}</b><span>{s.label}<em>{s.hint}</em></span></span>
              </button>
            ))}
          </nav>
          <button className="cx-x" onClick={guard.requestClose} aria-label="Close">×</button>
        </header>

        <div className="cx-body">
          <div className="cx-pane" key={step}>
            {/* ===== 1. WHO ===== */}
            {step === "who" && (
              <>
                <Explain n={1} title={`Which ${noun} do you want?`} text={isCo
                  ? "Start from all of them, or add conditions. Conditions can look at the company, at the people who work there and at its deals — for example “Deal · Phase is Demo” or “Contact · Language is English”."
                  : "Start from everyone, or add conditions. Conditions can look at the contact, at the companies they belong to and at the deals they’re in — for example “Deal · Phase is Demo” or “Company · City is Madrid”."} />
                <div className="cx-quick">
                  {quick.map((q) => <button key={q.k} onClick={q.apply}>{q.label}</button>)}
                </div>
                <div className="cx-who">
                  <div className="cx-conds">
                    {conds.length > 1 && (
                      <div className="cx-match">Show {noun} that match
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
                      {order.map((src) => (
                        <button key={src} className={`is-${src}`} onClick={() => addCond(fields.find((f) => f.src === src)?.key ?? "")}>
                          + {SRC_LABEL[src].toLowerCase()}
                        </button>
                      ))}
                    </div>
                    {match === "all" && (usesSame("company") || usesSame("deal") || usesSame("contact")) && (
                      <div className="cx-scope is-same">
                        {usesSame("contact") && (
                          <label className="cx-switch"><input type="checkbox" checked={same.contact} onChange={(e) => setSame((v) => ({ ...v, contact: e.target.checked }))} /><i />
                            Contact conditions must all be true <b>for the same contact</b></label>
                        )}
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
                        <span>Deals that count for a {one}</span>
                        <div className="cx-seg">
                          <button className={dealScope === "direct" ? "is-on" : ""} onClick={() => setDealScope("direct")}>{isCo ? "The company’s own deals" : "Deals they’re added to"}</button>
                          <button className={dealScope === "company" ? "is-on" : ""} onClick={() => setDealScope("company")}>{isCo ? "Also deals of its contacts" : "Also their company’s deals"}</button>
                        </div>
                      </div>
                    )}
                  </div>
                  <aside className="cx-count">
                    <span className="cx-k">Matching {noun}</span>
                    <b>{loading ? "…" : fmtN(Math.round(animatedCount))}</b>
                    <em>of {fmtN(records.length)} you can see</em>
                    <div className="cx-faces">
                      {matched.slice(0, 7).map((r, i) => <i key={r.id} style={{ ["--h" as string]: hue(nameOf(r)), ["--j" as string]: i } as CSSProperties} title={nameOf(r)}>{initials(nameOf(r))}</i>)}
                      {matched.length > 7 && <i className="is-more">+{matched.length - 7}</i>}
                    </div>
                    <ul>{matched.slice(0, 4).map((r) => <li key={r.id}>{nameOf(r)}<span>{isCo
                      ? [r.city, ((n: number) => `${n} ${n === 1 ? "contact" : "contacts"}`)((contactsByCompany.get(r.id) ?? []).length)].filter(Boolean).join(" · ")
                      : r.companyIds.map((id: string) => companyById.get(id)?.name).filter(Boolean).join(", ")}</span></li>)}</ul>
                  </aside>
                </div>
              </>
            )}

            {/* ===== 2. ROWS ===== */}
            {step === "rows" && (
              <>
                <Explain n={2} title="What should each row of the file be?" text={isCo
                  ? "Most of the time one row per company is what you want. You can also get one row for each of its contacts — a mailing list with the company's data — or one for each of its deals."
                  : "Most of the time one row per contact is what you want. If a contact belongs to several companies or is in several deals, you can also get one row for each of them."} />
                <div className="cx-modes">
                  {((isCo ? [
                    ["company", "One row per company", "Contacts and deals are listed together in their columns, separated with “;”.", `${fmtN(matched.length)} rows`],
                    ["contact", "One row per company and contact", "A company with three contacts appears three times — a mailing list with the company’s data.", `${fmtN(matched.reduce((s, r) => s + Math.max(1, (contactsByCompany.get(r.id) ?? []).length), 0))} rows`],
                    ["deal", "One row per company and deal", "A company with two deals appears twice, each with that deal’s phase and value.", `${fmtN(matched.reduce((n, r) => n + Math.max(1, ctxOf(r).deals.length), 0))} rows`],
                  ] : [
                    ["contact", "One row per contact", "Companies and deals are listed together in their columns, separated with “;”.", `${fmtN(matched.length)} rows`],
                    ["company", "One row per contact and company", "A contact at two companies appears twice — handy to group by company.", `${fmtN(matched.reduce((s, c) => s + Math.max(1, c.companyIds.length), 0))} rows`],
                    ["deal", "One row per contact and deal", "A contact in three deals appears three times, each with that deal’s phase and value.", `${fmtN(matched.reduce((n, c) => n + Math.max(1, ctxOf(c).deals.length), 0))} rows`],
                  ]) as [RowMode, string, string, string][]).map(([k, t, d, n], i) => (
                    <button key={k} className={`cx-mode ${rowMode === k ? "is-on" : ""}`} onClick={() => setRowMode(k)} style={{ ["--i" as string]: i } as CSSProperties}>
                      <span className="cx-mode-art" aria-hidden="true">
                        {Array.from({ length: k === root ? 3 : 4 }, (_, j) => <i key={j} className={k !== root && j > 0 && j < 3 ? "is-dup" : ""} />)}
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
                <Explain n={3} title="Which columns do you want in the file?" text={isCo
                  ? "Tick the information you need. Contact columns come from the people at each company and deal columns from its deals. Put them in the order you like on the right."
                  : "Tick the information you need. Company columns come from the contact’s companies and deal columns from their deals. Put them in the order you like on the right."} />
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
                    <div><b>{fmtN(matched.length)}</b><span>{noun}</span></div>
                    <div><b>{fmtN(rows.length)}</b><span>rows · {rowMode === root ? `one per ${one}` : `one per ${one} and ${rowMode}`}</span></div>
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
          <span className={`cx-foot-note ${problem ? "is-warn" : ""}`}>{problem ?? (step === "who" ? `${fmtN(matched.length)} ${noun} selected` : step === "rows" ? `${fmtN(rows.length)} rows` : step === "columns" ? `${cols.length} columns chosen` : "Ready")}</span>
          <div className="cx-foot-actions">
            {idx > 0 ? <button className="cx-btn is-ghost" onClick={() => setStep(STEPS[idx - 1].key)}>Back</button> : <button className="cx-btn is-ghost" onClick={guard.requestClose}>Cancel</button>}
            {step !== "download" && <button className="cx-btn is-primary" disabled={!!problem || loading} onClick={() => setStep(STEPS[idx + 1].key)}>Next: {STEPS[idx + 1].label} →</button>}
            {step === "download" && <button className="cx-btn is-ghost" onClick={guard.requestClose}>Close</button>}
          </div>
        </footer>
      </div>
      {guard.prompt}
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

/* ═══════════════════════════════════════════════════════════════════════
   MARKETING — saved lists of companies / contacts and e-mail campaigns
   (20_marketing.sql). Lists reuse the export conditions: any field of the
   contact, its companies and its deals, custom fields included. Campaigns
   are sent from the browser through a mail provider (Outlook / Microsoft 365
   for now), slowly enough to stay inside Exchange's limits.
   ═══════════════════════════════════════════════════════════════════════ */

type MkEntity = "contacts" | "companies";
interface MkGroup { id: string; match: "all" | "any"; conds: Cond[] }
interface MkDef { groups: MkGroup[]; groupsMatch: "any" | "all"; dealScope: "direct" | "company"; who: "all" | "one" }
interface MkList {
  id: string; name: string; description?: string | null; entity: MkEntity; kind: "dynamic" | "static";
  definition: MkDef; member_count?: number | null; created_at: string; updated_at: string;
}
type MkStatus = "draft" | "scheduled" | "sending" | "paused" | "sent" | "cancelled";
interface MkCampaign {
  id: string; name: string; list_id: string | null; from_mailbox: string | null; reply_to: string | null;
  subject: string; body_html: string; status: MkStatus; scheduled_at: string | null; started_at: string | null; finished_at: string | null;
  stats: { total?: number; sent?: number; failed?: number; skipped?: number; queued?: number }; created_at: string; updated_at: string; created_by?: string | null;
}
interface MkSend {
  id: string; campaign_id: string; contact_id: string | null; email: string; name: string | null; merge: Record<string, string>;
  status: "queued" | "claimed" | "sent" | "failed" | "skipped"; error: string | null; sent_at: string | null; claimed_at: string | null;
}
interface MkUnsub { id: string; email: string; reason: string | null; source: string; created_at: string }
type RecState = "ok" | "no_email" | "invalid" | "opted_out" | "duplicate";
interface Recipient { key: string; contactId: string | null; name: string; email: string; company: string; state: RecState; merge: Record<string, string> }

const MK_MISSING = /relation|does not exist|schema cache|Could not find the table/i;
const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/i;
const emptyDef = (): MkDef => ({ groups: [{ id: uid(), match: "all", conds: [] }], groupsMatch: "any", dealScope: "direct", who: "all" });
const STATE_LABEL: Record<RecState, string> = { ok: "Will receive it", no_email: "No e-mail", invalid: "Invalid e-mail", opted_out: "Unsubscribed", duplicate: "Same e-mail twice" };
const STATUS_LABEL: Record<MkStatus, string> = { draft: "Draft", scheduled: "Scheduled", sending: "Sending", paused: "Paused", sent: "Sent", cancelled: "Cancelled" };
const MERGE_FIELDS: { key: string; label: string }[] = [
  { key: "first_name", label: "First name" }, { key: "last_name", label: "Surname" }, { key: "full_name", label: "Full name" },
  { key: "company", label: "Company" }, { key: "position", label: "Position" }, { key: "city", label: "City" }, { key: "email", label: "E-mail" },
];
const FOOTER_DEFAULT = "Recibes este correo porque mantienes una relación profesional con nosotros. Si no deseas recibir más comunicaciones, <a href=\"mailto:{{unsubscribe_email}}?subject=BAJA\">date de baja aquí</a> o responde con la palabra BAJA.";
const FOOT_A = "<!--mk-footer-->", FOOT_B = "<!--/mk-footer-->";
const splitBody = (html: string) => {
  const a = html.indexOf(FOOT_A), b = html.indexOf(FOOT_B);
  if (a < 0 || b < a) return { body: html, footer: FOOTER_DEFAULT };
  return { body: html.slice(0, a), footer: html.slice(a + FOOT_A.length, b).replace(/^<p[^>]*>|<\/p>$/g, "") };
};
const joinBody = (body: string, footer: string) =>
  `${body}${FOOT_A}<p style="margin-top:28px;padding-top:12px;border-top:1px solid #e3e8e5;font-size:11.5px;color:#8a9893">${footer}</p>${FOOT_B}`;
const escHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** {{first_name}} → the recipient's value (escaped in HTML). Unknown fields come out empty. */
const mergeText = (tpl: string, vals: Record<string, string>, html: boolean) =>
  tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k: string) => { const v = vals[k.toLowerCase()] ?? ""; return html ? escHtml(v) : v; });
const emailHtml = (inner: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1b1f1b;max-width:640px">${inner}</div>`;
const fmtWhen = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

/* ---------- the sender layer: one provider today, another (SendGrid, Brevo, Azure ECS…) can be plugged in later ---------- */
export interface MailProvider { id: string; label: string; perMinute: number; perDay: number; send: (m: OutlookMail) => Promise<OutlookMailResult> }
export const MAIL_PROVIDERS: Record<string, MailProvider> = {
  outlook: { id: "outlook", label: "Outlook · Microsoft 365", perMinute: 30, perDay: 10000, send: sendOutlookMail },
};
const PROVIDER = MAIL_PROVIDERS.outlook;
const isThrottle = (e: string | null) => !!e && /429|throttl|too many|rate limit|MailboxConcurrency|ApplicationThrottled/i.test(e);

/* ---------- data ---------- */
async function mkAll<T = any>(table: string, cols = "*", filter?: (q: any) => any): Promise<{ rows: T[]; missing: boolean }> {
  try {
    const rows = await pagedAll<T>((count) => {
      let q = supabase.from(table).select(cols, count ? { count: "exact" } : undefined);
      if (filter) q = filter(q);
      return q.order("id");
    }, true);
    return { rows, missing: false };
  } catch (e: any) {
    return { rows: [], missing: MK_MISSING.test(String(e?.message ?? e)) };
  }
}
interface MkWorld { contacts: Contact[]; companies: Company[]; contactFields: ContactField[]; trackings: Tracking[]; extra: ExportExtra }
async function loadMarketingWorld(): Promise<MkWorld> {
  const [ct, links, cos, cf, w] = await Promise.all([
    mkAll<any>("contacts"), mkAll<any>("company_contacts", "contact_id, company_id"), mkAll<any>("companies"),
    listContactFields().catch(() => [] as ContactField[]), loadExportWorld(),
  ]);
  const by: Record<string, string[]> = {};
  links.rows.forEach((l: any) => { (by[l.contact_id] ??= []).push(l.company_id); });
  return {
    contacts: ct.rows.map((r: any) => ({ ...r, companyIds: by[r.id] ?? [] })) as Contact[],
    companies: (cos.rows as Company[]).sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""))),
    contactFields: cf, trackings: w.trackings, extra: w.extra,
  };
}

/** Lookups + the field catalogue for one kind of row (contacts or companies). */
function useMkEngine(w: MkWorld | null) {
  return useMemo(() => {
    if (!w) return null;
    const companyById = new Map(w.companies.map((c) => [c.id as string, c]));
    const dealsByContact = new Map<string, Tracking[]>();
    w.trackings.forEach((t) => t.contactIds.forEach((cid) => { const a = dealsByContact.get(cid) ?? []; a.push(t); dealsByContact.set(cid, a); }));
    const dealsByCompany: Record<string, Tracking[]> = {};
    w.trackings.forEach((t) => { if (t.company_id) (dealsByCompany[t.company_id] ??= []).push(t); });
    const contactsByCompany = new Map<string, Contact[]>();
    w.contacts.forEach((c) => c.companyIds.forEach((id) => { const a = contactsByCompany.get(id) ?? []; a.push(c); contactsByCompany.set(id, a); }));
    const x = w.extra;
    const catalog = (root: Root) => buildCatalog({
      contacts: w.contacts, companies: w.companies, deals: w.trackings, contactFields: w.contactFields as any, companyFields: x.companyFields as any, dealFields: x.dealFields as any,
      people: x.people, pipelines: x.pipelines, phases: x.phases, products: x.products,
      clientCompanyIds: x.rel?.clientCompanyIds ?? new Set(), clientContactIds: x.rel?.clientContactIds ?? new Set(),
      contactAssignees: x.contactAssignees, companyAssignees: x.companyAssignees, owners: x.owners, team: x.team,
      dealProducts: x.dealProducts, dealTotals: x.dealTotals, phaseHistory: x.phaseHistory, dealsByCompany, imports: x.imports, root,
    });
    const fields = { contact: catalog("contact"), company: catalog("company") };
    const fieldBy = { contact: new Map(fields.contact.map((f) => [f.key, f])), company: new Map(fields.company.map((f) => [f.key, f])) };
    const ctxOf = (root: Root, r: any, scope: "direct" | "company"): Ctx => {
      if (root === "company") {
        const cts = contactsByCompany.get(r.id as string) ?? [];
        const direct = dealsByCompany[r.id as string] ?? [];
        const deals = scope === "company" ? [...new Map([...direct, ...cts.flatMap((ct) => dealsByContact.get(ct.id as string) ?? [])].map((d) => [d.id, d])).values()] : direct;
        return { c: r, cos: [r], cts, deals };
      }
      const c = r as Contact;
      const cos = c.companyIds.map((id) => companyById.get(id)).filter(Boolean) as Company[];
      const direct = dealsByContact.get(c.id as string) ?? [];
      const deals = scope === "company" ? [...new Map([...direct, ...cos.flatMap((co) => dealsByCompany[co.id as string] ?? [])].map((d) => [d.id, d])).values()] : direct;
      return { c, cos, deals };
    };
    /** The records a dynamic list picks: groups joined with OR (or AND), conditions inside a group with its own all / any. */
    const evaluate = (entity: MkEntity, def: MkDef): any[] => {
      const root: Root = entity === "companies" ? "company" : "contact";
      const records: any[] = entity === "companies" ? w.companies : w.contacts;
      const groups = def.groups.map((g) => ({ g, active: g.conds.filter((c) => condReady(fieldBy[root].get(c.field), c)).map((c) => ({ f: fieldBy[root].get(c.field)!, c })) }))
        .filter((x) => x.active.length);
      if (!groups.length) return records;
      const same = { company: true, deal: true, contact: true };
      return records.filter((r) => {
        const ctx = ctxOf(root, r, def.dealScope);
        const hits = groups.map((x) => contactMatches(ctx, x.active, x.g.match, same, inPeriod));
        return def.groupsMatch === "all" ? hits.every(Boolean) : hits.some(Boolean);
      });
    };
    /** Who gets the e-mail: the contacts themselves, or the contacts of the companies (all, or one per company). */
    const recipients = (entity: MkEntity, rows: any[], who: "all" | "one", optOut: Set<string>): Recipient[] => {
      const people: { c: Contact; co: Company | null }[] = [];
      if (entity === "contacts") rows.forEach((c: Contact) => people.push({ c, co: companyById.get(c.companyIds[0]) ?? null }));
      else rows.forEach((co: Company) => {
        const cts = contactsByCompany.get(co.id as string) ?? [];
        if (who === "one") {
          const pick = cts.find((c) => c.is_billing && EMAIL_RE.test(String(c.email ?? "").trim())) ?? cts.find((c) => EMAIL_RE.test(String(c.email ?? "").trim())) ?? cts[0];
          if (pick) people.push({ c: pick, co });
        } else cts.forEach((c) => people.push({ c, co }));
      });
      const seen = new Set<string>();
      return people.map(({ c, co }) => {
        const email = String(c.email ?? "").trim();
        const low = email.toLowerCase();
        const name = fullName(c) || email;
        const state: RecState = !email ? "no_email" : !EMAIL_RE.test(email) ? "invalid"
          : ((c as any).marketing_opt_out || optOut.has(low)) ? "opted_out" : seen.has(low) ? "duplicate" : "ok";
        if (state === "ok") seen.add(low);
        const coName = co?.name ?? "";
        return {
          key: `${c.id}|${co?.id ?? ""}`, contactId: (c.id as string) ?? null, name, email, company: coName, state,
          merge: {
            first_name: c.first_name ?? "", last_name: c.last_name ?? "", full_name: fullName(c), email,
            company: coName, position: c.position ?? "", city: c.city ?? (co as any)?.city ?? "",
          },
        };
      });
    };
    return { fields, fieldBy, evaluate, recipients, companyById, contactsByCompany };
  }, [w]);
}
type MkEngine = NonNullable<ReturnType<typeof useMkEngine>>;

/** The records of a saved list right now (dynamic: its conditions; static: its members). */
function listRecords(eng: MkEngine, w: MkWorld, l: Pick<MkList, "entity" | "kind" | "definition">, members: Map<string, string[]>, id?: string): any[] {
  if (l.kind === "static") {
    const ids = new Set(members.get(id ?? "") ?? []);
    return (l.entity === "companies" ? w.companies : w.contacts).filter((r: any) => ids.has(r.id));
  }
  return eng.evaluate(l.entity, l.definition ?? emptyDef());
}

/* ---------- a two-step button for anything that can't be undone ---------- */
function MkConfirm({ label, ask = "Sure?", yes = "Yes", onYes, className = "", disabled }: { label: React.ReactNode; ask?: string; yes?: string; onYes: () => void; className?: string; disabled?: boolean }) {
  const [on, setOn] = useState(false);
  if (!on) return <button className={`mk-btn ${className}`} disabled={disabled} onClick={() => setOn(true)}>{label}</button>;
  return (
    <span className="mk-ask">{ask}
      <button className="mk-btn is-danger is-sm" onClick={() => { setOn(false); onYes(); }}>{yes}</button>
      <button className="mk-btn is-ghost is-sm" autoFocus onClick={() => setOn(false)}>Keep</button>
    </span>
  );
}

const MkIco = {
  list: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h12M8 12h12M8 18h12" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></svg>,
  send: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></svg>,
  stop: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg>,
  people: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><circle cx="17.5" cy="9" r="2.4" /><path d="M16 14.2a4.8 4.8 0 0 1 4.5 4.8" /></svg>,
  building: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="10" height="18" rx="1.5" /><path d="M14 8h6v13H4M7.5 7h3M7.5 11h3M7.5 15h3" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  pause: <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2" /><rect x="14" y="5" width="4" height="14" rx="1.2" /></svg>,
  play: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8z" /></svg>,
  dl: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>,
  mail: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></svg>,
  megaphone: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1z" /><path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10" /></svg>,
  db: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" /><path d="M4.5 5.5v6.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V5.5M4.5 12v6.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V12" /></svg>,
  copy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>,
  arrow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9.5 12l2 2 3.5-3.5" /></svg>,
  user: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.6" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>,
};

/** A segmented control whose white "ink" slides to the chosen option. */
function MkSeg<T extends string>({ value, options, onChange, dark = false, size = "md" }: {
  value: T; options: { value: T; label: React.ReactNode; count?: number }[]; onChange: (v: T) => void; dark?: boolean; size?: "sm" | "md";
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [ink, setInk] = useState<{ x: number; w: number } | null>(null);
  const measure = () => {
    const el = wrap.current?.querySelector<HTMLElement>(`[data-v="${CSS.escape(value)}"]`);
    if (el) setInk({ x: el.offsetLeft, w: el.offsetWidth });
  };
  useEffect(() => { measure(); }, [value, options.map((o) => `${o.value}${o.count ?? ""}`).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    if (ro && wrap.current) ro.observe(wrap.current);
    return () => ro?.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={wrap} className={`mk-seg ${dark ? "is-dark" : ""} is-${size}`} role="tablist">
      {ink && <i className="mk-seg-ink" style={{ transform: `translateX(${ink.x}px)`, width: ink.w }} />}
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" data-v={o.value} aria-selected={value === o.value} className={value === o.value ? "is-on" : ""} onClick={() => onChange(o.value)}>
          {o.label}{o.count != null && <em>{o.count}</em>}
        </button>
      ))}
    </div>
  );
}

/* ═══════════════════════════ the page ═══════════════════════════ */
export function MarketingPage() {
  const [w, setW] = useState<MkWorld | null>(null);
  const eng = useMkEngine(w);
  const [tab, setTab] = useState<"lists" | "campaigns" | "unsubs">("lists");
  const [missing, setMissing] = useState(false);
  const [lists, setLists] = useState<MkList[]>([]);
  const [members, setMembers] = useState<Map<string, string[]>>(new Map());
  const [campaigns, setCampaigns] = useState<MkCampaign[]>([]);
  const [unsubs, setUnsubs] = useState<MkUnsub[]>([]);
  const [me, setMe] = useState<{ id: string | null; email: string }>({ id: null, email: "" });
  const heroRef = useRef<HTMLElement | null>(null);

  const reloadMk = async () => {
    const [l, m, c, u] = await Promise.all([
      mkAll<MkList>("marketing_lists", "*", (q) => q.order("updated_at", { ascending: false })),
      mkAll<any>("marketing_list_members", "list_id, contact_id, company_id"),
      mkAll<MkCampaign>("marketing_campaigns", "*", (q) => q.order("created_at", { ascending: false })),
      mkAll<MkUnsub>("marketing_unsubscribes", "*", (q) => q.order("created_at", { ascending: false })),
    ]);
    setMissing(l.missing || c.missing);
    setLists(l.rows.map((x) => ({ ...x, definition: { ...emptyDef(), ...(x.definition ?? {}) } })));
    const mm = new Map<string, string[]>();
    m.rows.forEach((r: any) => { const a = mm.get(r.list_id) ?? []; a.push(r.contact_id ?? r.company_id); mm.set(r.list_id, a); });
    setMembers(mm);
    setCampaigns(c.rows.map((x) => ({ ...x, stats: x.stats ?? {} })));
    setUnsubs(u.rows);
  };
  useEffect(() => {
    loadMarketingWorld().then(setW).catch(() => setW({ contacts: [], companies: [], contactFields: [], trackings: [], extra: {} as any }));
    void reloadMk();
    supabase.auth.getUser().then(({ data }: any) => setMe({ id: data?.user?.id ?? null, email: data?.user?.email ?? "" }));
  }, []);

  const optOut = useMemo(() => new Set(unsubs.map((u) => u.email.toLowerCase())), [unsubs]);
  const reachable = useMemo(() => {
    if (!w) return 0;
    const seen = new Set<string>();
    w.contacts.forEach((c: any) => { const e = String(c.email ?? "").trim().toLowerCase(); if (EMAIL_RE.test(e) && !c.marketing_opt_out && !optOut.has(e)) seen.add(e); });
    return seen.size;
  }, [w, optOut]);
  const sentCount = campaigns.filter((c) => c.status === "sent").length;
  const last = campaigns.find((c) => c.status === "sent" || c.status === "sending" || c.status === "paused");
  const runner = useCampaignRunner({ campaigns, eng, w, lists, members, optOut, me, onChange: reloadMk });

  const fhMove = (e: React.PointerEvent<HTMLElement>) => {
    const el = heroRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`); el.style.setProperty("--my", `${e.clientY - r.top}px`); el.style.setProperty("--mon", "1");
  };
  const n = useCount(reachable);

  const [copied, setCopied] = useState(false);
  const copySql = () => { try { void navigator.clipboard?.writeText("20_marketing.sql"); } catch { /* clipboard blocked */ } setCopied(true); window.setTimeout(() => setCopied(false), 1600); };
  const kpis: { ico: React.ReactNode; k: string; v: React.ReactNode; sub: string; tone?: string; title?: string }[] = [
    { ico: MkIco.list, k: "Saved lists", v: lists.length, sub: `${lists.filter((l) => l.kind === "dynamic").length} dynamic · ${lists.filter((l) => l.kind === "static").length} fixed` },
    { ico: MkIco.people, k: "Reachable contacts", v: w ? fmtN(Math.round(n)) : "…", sub: "valid e-mail · not unsubscribed", tone: "mint" },
    { ico: MkIco.send, k: "Campaigns sent", v: sentCount, sub: `${campaigns.filter((c) => c.status === "draft").length} drafts · ${campaigns.filter((c) => c.status === "scheduled").length} scheduled` },
    last
      ? { ico: MkIco.mail, k: "Last campaign", v: last.name, title: last.name, sub: `${fmtN(last.stats.sent ?? 0)} sent · ${fmtN(last.stats.failed ?? 0)} failed · ${STATUS_LABEL[last.status]}`, tone: "name" }
      : { ico: MkIco.mail, k: "Last campaign", v: "—", sub: "nothing sent yet" },
  ];

  return (
    <div className="mk">
      <header className="mk-hero" ref={heroRef} onPointerMove={fhMove} onPointerLeave={() => heroRef.current?.style.setProperty("--mon", "0")}>
        <i className="mk-hero-orb" aria-hidden="true" />
        <div className="mk-hero-top">
          <div className="mk-hero-id">
            <span className="mk-hero-badge">{MkIco.megaphone}</span>
            <div>
              <span className="mk-eyebrow">Marketing</span>
              <h1 className="mk-title">Lists &amp; campaigns</h1>
              <p className="mk-sub">Pick companies or contacts by anything you store about them, and e-mail them from your department's mailbox.</p>
            </div>
          </div>
        </div>
        <div className="mk-kpis">
          {kpis.map((x, i) => (
            <div key={x.k} className={`mk-kpi ${x.tone ? `is-${x.tone}` : ""}`} style={{ ["--i" as string]: i } as CSSProperties}>
              <span className="mk-kpi-ico">{x.ico}</span>
              <span className="mk-kpi-k">{x.k}</span>
              <b title={x.title}>{x.v}</b>
              <em>{x.sub}</em>
            </div>
          ))}
        </div>
        <div className="mk-hero-foot">
          <MkSeg dark value={tab} onChange={setTab}
            options={[{ value: "lists", label: <>{MkIco.list}Lists</>, count: lists.length }, { value: "campaigns", label: <>{MkIco.send}Campaigns</>, count: campaigns.length }, { value: "unsubs", label: <>{MkIco.shield}Unsubscribes</>, count: unsubs.length }]} />
          {runner.running && <span className="mk-live-chip"><i className="mk-pulse" />Sending now</span>}
          <span className="mk-grow" />
          <span className="mk-prov" title={`Sent one by one through ${PROVIDER.label}`}>
            <i />{PROVIDER.label}<em>{PROVIDER.perMinute}/min · {fmtN(PROVIDER.perDay)}/day</em>
          </span>
        </div>
      </header>

      {missing && (
        <div className="mk-setup">
          <span className="mk-setup-ico">{MkIco.db}</span>
          <div className="mk-setup-txt">
            <b>One step to switch Marketing on</b>
            <p>Run <code>20_marketing.sql</code> in Supabase (SQL editor) to save lists, send campaigns and keep the unsubscribe list. Until then you can try the list builder below — nothing gets saved.</p>
          </div>
          <button className="mk-btn is-light" onClick={copySql}>{copied ? <>{MkIco.check}Copied</> : <>{MkIco.copy}Copy file name</>}</button>
        </div>
      )}
      {runner.banner && <div className={`mk-banner ${runner.banner.tone === "warn" ? "is-warn" : "is-live"}`}>{runner.banner.tone !== "warn" && <i className="mk-pulse" />}{runner.banner.text}</div>}

      <main className="mk-body" key={tab}>
        {!w || !eng ? <MkLoading /> : tab === "lists" ? (
          <ListsTab w={w} eng={eng} lists={lists} members={members} optOut={optOut} missing={missing} onChange={reloadMk} />
        ) : tab === "campaigns" ? (
          <CampaignsTab w={w} eng={eng} lists={lists} members={members} optOut={optOut} campaigns={campaigns} me={me} missing={missing} runner={runner} onChange={reloadMk} onGoLists={() => setTab("lists")} />
        ) : (
          <UnsubsTab unsubs={unsubs} w={w} missing={missing} onChange={reloadMk} />
        )}
      </main>
    </div>
  );
}

function MkLoading() {
  return <PageLoader label="Reading your companies, contacts and deals" />;
}

/* ═══════════════════════════ Lists ═══════════════════════════ */
function ListsTab({ w, eng, lists, members, optOut, missing, onChange }: {
  w: MkWorld; eng: MkEngine; lists: MkList[]; members: Map<string, string[]>; optOut: Set<string>; missing: boolean; onChange: () => Promise<void>;
}) {
  const [sel, setSel] = useState<string | "new" | null>(lists[0]?.id ?? "new");
  useEffect(() => { if (sel && sel !== "new" && !lists.some((l) => l.id === sel)) setSel(lists[0]?.id ?? "new"); }, [lists, sel]);
  const cur = lists.find((l) => l.id === sel) ?? null;
  const sizes = useMemo(() => new Map(lists.map((l) => [l.id, listRecords(eng, w, l, members, l.id).length])), [lists, eng, w, members]);
  const [q, setQ] = useState("");
  const shownLists = lists.filter((l) => !q.trim() || norm(`${l.name} ${l.description ?? ""}`).includes(norm(q)));
  return (
    <div className="mk-lists">
      <aside className="mk-side">
        <div className="mk-side-h">
          <b>Your lists</b><em>{lists.length}</em>
        </div>
        <button className={`mk-newlist ${sel === "new" ? "is-on" : ""}`} onClick={() => setSel("new")}><span>{MkIco.plus}</span>New list</button>
        {lists.length > 4 && (
          <label className="mk-search">{MkIco.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a list" /></label>
        )}
        <div className="mk-side-list">
          {shownLists.map((l, i) => {
            const size = sizes.get(l.id);
            return (
              <button key={l.id} className={`mk-lcard ${sel === l.id ? "is-on" : ""}`} onClick={() => setSel(l.id)} style={{ ["--i" as string]: i } as CSSProperties}>
                <span className={`mk-lcard-ico is-${l.entity}`}>{l.entity === "companies" ? MkIco.building : MkIco.people}</span>
                <span className="mk-lcard-txt"><b>{l.name}</b><em><i className={`mk-dot is-${l.kind}`} />{l.kind === "dynamic" ? "Dynamic" : "Fixed"} · {l.entity}</em></span>
                {size != null && <span className="mk-lcard-n">{fmtN(size)}</span>}
              </button>
            );
          })}
          {!!lists.length && !shownLists.length && <p className="mk-muted">No list matches “{q}”.</p>}
        </div>
        {!lists.length && (
          <div className="mk-side-empty">
            <span className="mk-side-empty-art"><i /><i /><i /></span>
            <b>No saved lists yet</b>
            <p>Build one on the right — pick who's in with conditions — and save it to reuse in campaigns.</p>
          </div>
        )}
      </aside>
      <ListEditor key={sel ?? "none"} w={w} eng={eng} list={cur} members={members} optOut={optOut} missing={missing}
        onSaved={async (id) => { await onChange(); setSel(id); }} onDeleted={async () => { await onChange(); setSel("new"); }} />
    </div>
  );
}

function ListEditor({ w, eng, list, members, optOut, missing, onSaved, onDeleted }: {
  w: MkWorld; eng: MkEngine; list: MkList | null; members: Map<string, string[]>; optOut: Set<string>; missing: boolean;
  onSaved: (id: string) => Promise<void>; onDeleted: () => Promise<void>;
}) {
  const [name, setName] = useState(list?.name ?? "");
  const [desc, setDesc] = useState(list?.description ?? "");
  const [entity, setEntity] = useState<MkEntity>(list?.entity ?? "contacts");
  const [def, setDef] = useState<MkDef>(list?.definition ?? emptyDef());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [showState, setShowState] = useState<RecState | "all">("all");
  const isStatic = list?.kind === "static";
  const root: Root = entity === "companies" ? "company" : "contact";
  const fields = eng.fields[root];
  const fieldBy = eng.fieldBy[root];

  const records = useMemo(() => (list && isStatic ? listRecords(eng, w, list, members, list.id) : eng.evaluate(entity, def)),
    [eng, w, list, isStatic, members, entity, def]);
  const recs = useMemo(() => eng.recipients(entity, records, def.who, optOut), [eng, entity, records, def.who, optOut]);
  const counts = useMemo(() => { const o: Record<RecState, number> = { ok: 0, no_email: 0, invalid: 0, opted_out: 0, duplicate: 0 }; recs.forEach((r) => { o[r.state]++; }); return o; }, [recs]);
  const shown = recs.filter((r) => showState === "all" || r.state === showState);
  const nOk = useCount(counts.ok);

  const setGroup = (gid: string, patch: Partial<MkGroup>) => setDef((d) => ({ ...d, groups: d.groups.map((g) => (g.id === gid ? { ...g, ...patch } : g)) }));
  const addCond = (gid: string, src: Src) => {
    const f = fields.find((x) => x.src === src);
    setDef((d) => ({ ...d, groups: d.groups.map((g) => (g.id === gid ? { ...g, conds: [...g.conds, { id: uid(), field: f?.key ?? "", op: f ? DEFAULT_OP[f.kind] : "", vals: [], a: f?.kind === "date" ? "this_year" : "", b: "" }] } : g)) }));
  };
  const patchCond = (gid: string, cid: string, patch: Partial<Cond>) =>
    setDef((d) => ({ ...d, groups: d.groups.map((g) => (g.id === gid ? { ...g, conds: g.conds.map((c) => (c.id === cid ? { ...c, ...patch } : c)) } : g)) }));
  const dropCond = (gid: string, cid: string) =>
    setDef((d) => ({ ...d, groups: d.groups.map((g) => (g.id === gid ? { ...g, conds: g.conds.filter((c) => c.id !== cid) } : g)) }));
  const order: Src[] = root === "company" ? ["company", "contact", "deal"] : ["contact", "company", "deal"];
  const fieldOptions = order.flatMap((src) => fields.filter((f) => f.src === src).map((f) => ({ value: f.key, label: `${SRC_LABEL[src]} · ${f.label}` })));

  const save = async (kind: "dynamic" | "static") => {
    const nm = name.trim();
    if (!nm) { setMsg({ tone: "err", text: "Give the list a name." }); return; }
    setBusy(true); setMsg(null);
    const row = { name: nm, description: desc.trim() || null, entity, kind, definition: def, member_count: records.length, updated_at: new Date().toISOString() };
    let id = list && list.kind === kind ? list.id : null;
    if (id) {
      const { error } = await supabase.from("marketing_lists").update(row).eq("id", id);
      if (error) { setBusy(false); setMsg({ tone: "err", text: error.message }); return; }
    } else {
      const { data, error } = await supabase.from("marketing_lists").insert(row).select("id").single();
      if (error || !data) { setBusy(false); setMsg({ tone: "err", text: error?.message ?? "Could not save." }); return; }
      id = (data as any).id as string;
    }
    if (kind === "static" && id && !(list && list.kind === "static")) {
      // a fixed list keeps the records it has now
      const rows = records.map((r: any) => (entity === "companies" ? { list_id: id, company_id: r.id } : { list_id: id, contact_id: r.id }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase.from("marketing_list_members").insert(rows.slice(i, i + 500));
        if (error) { setBusy(false); setMsg({ tone: "err", text: error.message }); return; }
      }
    }
    setBusy(false);
    setMsg({ tone: "ok", text: kind === "static" ? `Saved as a fixed list of ${fmtN(records.length)} ${entity}.` : "Saved. The list updates itself as your data changes." });
    await onSaved(id!);
  };
  const removeMember = async (rid: string) => {
    if (!list) return;
    const col = entity === "companies" ? "company_id" : "contact_id";
    await supabase.from("marketing_list_members").delete().eq("list_id", list.id).eq(col, rid);
    await onSaved(list.id);
  };
  const del = async () => {
    if (!list) return;
    const { error } = await supabase.from("marketing_lists").delete().eq("id", list.id);
    if (error) { setMsg({ tone: "err", text: error.message }); return; }
    await onDeleted();
  };
  const exportCsv = () => {
    const t = {
      columns: [{ label: "Name" }, { label: "E-mail" }, { label: "Company" }, { label: "Position" }, { label: "Status" }],
      rows: recs.map((r) => [r.name, r.email, r.company, r.merge.position, STATE_LABEL[r.state]] as ExportCell[]),
    };
    downloadBlob(tableToCsv(t), `${(name.trim() || "list").replace(/[\\/:*?"<>|]+/g, "-")}.csv`);
  };

  return (
    <section className="mk-editor">
      <div className="mk-card mk-ed-head">
        <span className={`mk-ed-ico is-${entity}`}>{entity === "companies" ? MkIco.building : MkIco.people}</span>
        <div className="mk-ed-name">
          <input className="mk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this list, e.g. CFOs at client companies" />
          <input className="mk-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What it's for (optional)" />
        </div>
        <div className="mk-ed-kind">
          {list ? <span className={`mk-chip is-${list.kind}`}>{list.kind === "dynamic" ? "Dynamic · updates itself" : "Fixed · same people"}</span> : <span className="mk-chip is-new">New list</span>}
          {!isStatic && (
            <MkSeg size="sm" value={entity} onChange={(v) => { if (v !== entity) { setEntity(v); setDef(emptyDef()); } }}
              options={[{ value: "contacts", label: <>{MkIco.user}Contacts</> }, { value: "companies", label: <>{MkIco.building}Companies</> }]} />
          )}
        </div>
        <div className="mk-ed-actions">
          {msg && <span className={`mk-msg is-${msg.tone}`}>{msg.text}</span>}
          <span className="mk-grow" />
          {list && <MkConfirm label="Delete list" className="is-ghost is-danger-text" ask="Delete this list?" yes="Delete" onYes={() => void del()} />}
          <button className="mk-btn is-ghost" onClick={exportCsv} disabled={!recs.length}>{MkIco.dl}Export CSV</button>
          {!isStatic && <button className="mk-btn is-ghost" disabled={busy || missing} onClick={() => void save("static")} title="Keep exactly these people, even if their data changes">Save as fixed list</button>}
          <button className="mk-btn is-primary" disabled={busy || missing} onClick={() => void save(isStatic ? "static" : "dynamic")}>{busy ? "Saving…" : list ? "Save changes" : "Save list"}</button>
        </div>
      </div>

      <div className="mk-ed-grid">
        <div className="mk-ed-main">
          {isStatic ? (
            <div className="mk-card">
              <div className="mk-card-h"><b>Members</b><span className="mk-pill">{fmtN(records.length)}</span><em>A fixed list keeps the same {entity}. Remove anyone you don't want.</em></div>
              <div className="mk-members">
                {records.slice(0, 300).map((r: any) => (
                  <div className="mk-member" key={r.id}>
                    <i style={{ ["--h" as string]: hue(entity === "companies" ? r.name ?? "" : fullName(r)) } as CSSProperties}>{initials(entity === "companies" ? r.name ?? "" : fullName(r))}</i>
                    <span><b>{entity === "companies" ? r.name : fullName(r)}</b><em>{entity === "companies" ? r.city ?? "" : r.email ?? "no e-mail"}</em></span>
                    <MkConfirm label="×" className="is-icon" ask="Remove?" yes="Remove" onYes={() => void removeMember(r.id)} />
                  </div>
                ))}
                {records.length > 300 && <p className="mk-muted">…and {fmtN(records.length - 300)} more.</p>}
              </div>
            </div>
          ) : (
            <>
              {def.groups.map((g, gi) => (
                <div key={g.id}>
                  {gi > 0 && (
                    <div className="mk-or">
                      <MkSeg size="sm" value={def.groupsMatch} onChange={(v) => setDef((d) => ({ ...d, groupsMatch: v }))}
                        options={[{ value: "any", label: "OR" }, { value: "all", label: "AND" }]} />
                    </div>
                  )}
                  <div className="mk-card mk-group" style={{ ["--i" as string]: gi } as CSSProperties}>
                    <div className="mk-group-h">
                      <span className="mk-group-n">{gi + 1}</span>
                      <b>{gi === 0 ? "Who's in" : def.groupsMatch === "any" ? "…or also" : "…and also"}</b>
                      <em>{g.conds.length ? `${g.conds.length} condition${g.conds.length === 1 ? "" : "s"}` : "no conditions"}</em>
                      {g.conds.length > 1 && (
                        <span className="cx-match">match
                          <div className="cx-seg"><button className={g.match === "all" ? "is-on" : ""} onClick={() => setGroup(g.id, { match: "all" })}>all</button><button className={g.match === "any" ? "is-on" : ""} onClick={() => setGroup(g.id, { match: "any" })}>any</button></div>
                          of these
                        </span>
                      )}
                      {def.groups.length > 1 && <button className="cx-cond-x" onClick={() => setDef((d) => ({ ...d, groups: d.groups.filter((x) => x.id !== g.id) }))} aria-label="Remove group">×</button>}
                    </div>
                    <div className="cx-conds">
                      {!g.conds.length && <p className="mk-group-empty">{gi === 0 ? <>No conditions yet — <b>every {entity === "companies" ? "company" : "contact"}</b> is in. Narrow it down below.</> : "Add a condition to this group."}</p>}
                      {g.conds.map((c, i) => (
                        <MkCondRow key={c.id} c={c} i={i} f={fieldBy.get(c.field)} fieldBy={fieldBy} fieldOptions={fieldOptions}
                          onPatch={(p) => patchCond(g.id, c.id, p)} onDrop={() => dropCond(g.id, c.id)} />
                      ))}
                      <div className="cx-add">
                        <span>Add a condition about</span>
                        {order.map((src) => <button key={src} className={`is-${src}`} onClick={() => addCond(g.id, src)}>+ {SRC_LABEL[src].toLowerCase()}</button>)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <div className="mk-ed-tools">
                <button className="mk-btn is-ghost" onClick={() => setDef((d) => ({ ...d, groups: [...d.groups, { id: uid(), match: "all", conds: [] }] }))}>{MkIco.plus}Add a group ({def.groupsMatch === "all" ? "AND" : "OR"})</button>
                <div className="cx-scope">
                  <span>Deals that count</span>
                  <div className="cx-seg">
                    <button className={def.dealScope === "direct" ? "is-on" : ""} onClick={() => setDef((d) => ({ ...d, dealScope: "direct" }))}>{entity === "companies" ? "The company's deals" : "Deals they're on"}</button>
                    <button className={def.dealScope === "company" ? "is-on" : ""} onClick={() => setDef((d) => ({ ...d, dealScope: "company" }))}>{entity === "companies" ? "Also its contacts' deals" : "Also their company's deals"}</button>
                  </div>
                </div>
              </div>
            </>
          )}
          {entity === "companies" && (
            <div className="mk-card mk-who">
              <b>Who gets the e-mail at each company</b>
              <div className="cx-seg">
                <button className={def.who === "all" ? "is-on" : ""} onClick={() => setDef((d) => ({ ...d, who: "all" }))}>All its contacts</button>
                <button className={def.who === "one" ? "is-on" : ""} onClick={() => setDef((d) => ({ ...d, who: "one" }))}>One per company</button>
              </div>
              <em>{def.who === "one" ? "The billing contact when it has an e-mail, otherwise the first contact with one." : "Everyone who works there with a valid e-mail."}</em>
            </div>
          )}
        </div>

        <aside className="mk-ed-side">
          <div className="mk-card mk-count">
            <div className="mk-count-top">
              <span className="mk-k">Will receive it</span>
              {!isStatic && <span className="mk-live"><i className="mk-pulse" />Live</span>}
            </div>
            <b className="mk-count-n">{fmtN(Math.round(nOk))}</b>
            <em>{fmtN(records.length)} {entity} match{records.length === 1 ? "es" : ""} · {fmtN(recs.length)} people checked</em>
            <div className="mk-stack" aria-hidden="true">
              {(["ok", "no_email", "invalid", "opted_out", "duplicate"] as RecState[]).filter((k) => counts[k]).map((k) => (
                <i key={k} className={`is-${k}`} style={{ flexGrow: counts[k] }} />
              ))}
            </div>
            <div className="mk-bars">
              {(["ok", "no_email", "invalid", "opted_out", "duplicate"] as RecState[]).map((k) => (
                <button key={k} className={`mk-bar is-${k} ${showState === k ? "is-on" : ""}`} onClick={() => setShowState(showState === k ? "all" : k)} disabled={!counts[k]}>
                  <i className="mk-bar-dot" /><span>{STATE_LABEL[k]}</span><b>{fmtN(counts[k])}</b>
                  <small>{recs.length ? Math.round((counts[k] / recs.length) * 100) : 0}%</small>
                </button>
              ))}
            </div>
          </div>
          <div className="mk-card mk-preview">
            <div className="mk-card-h"><b>{showState === "all" ? "Preview" : STATE_LABEL[showState]}</b><span className="mk-pill">{fmtN(shown.length)}</span>{showState !== "all" && <button className="mk-linkbtn" onClick={() => setShowState("all")}>Show everyone</button>}</div>
            <div className="mk-plist">
              {shown.slice(0, 60).map((r, i) => (
                <div className={`mk-prow is-${r.state}`} key={r.key} style={{ ["--i" as string]: Math.min(i, 12) } as CSSProperties}>
                  <i style={{ ["--h" as string]: hue(r.name) } as CSSProperties}>{initials(r.name)}</i>
                  <span><b>{r.name}</b><em>{r.email || "no e-mail"}{r.company ? ` · ${r.company}` : ""}</em></span>
                  <small className={`mk-st is-${r.state}`}>{r.state === "ok" ? "OK" : STATE_LABEL[r.state]}</small>
                </div>
              ))}
              {!shown.length && <div className="mk-empty-sm">{MkIco.people}<span>{records.length ? "Nobody in this group." : "Nobody matches these conditions yet."}</span></div>}
              {shown.length > 60 && <p className="mk-muted">…and {fmtN(shown.length - 60)} more (export to see everyone).</p>}
            </div>
          </div>
        </aside>
      </div>

    </section>
  );
}

/** One condition row (same look as the exports). */
function MkCondRow({ c, i, f, fieldBy, fieldOptions, onPatch, onDrop }: {
  c: Cond; i: number; f: XF | undefined; fieldBy: Map<string, XF>; fieldOptions: { value: string; label: string }[];
  onPatch: (p: Partial<Cond>) => void; onDrop: () => void;
}) {
  return (
    <div className={`cx-cond ${f ? `is-${f.src}` : ""} ${f && !condReady(f, c) ? "is-incomplete" : ""}`} style={{ ["--i" as string]: i } as CSSProperties}>
      <span className="cx-cond-src">{f ? SRC_LABEL[f.src] : "?"}</span>
      <div className="cx-cond-field">
        <SalesMultiFilter single values={c.field ? [c.field] : []} placeholder="Choose what to look at…" searchFrom={6} options={fieldOptions}
          onChange={(v) => { const nf = fieldBy.get(v[0]); if (nf) onPatch({ field: nf.key, op: DEFAULT_OP[nf.kind], vals: [], a: nf.kind === "date" ? "this_year" : "", b: "" }); }} />
      </div>
      {f && (
        <div className="cx-cond-op">
          <SalesMultiFilter single values={[c.op]} placeholder="How" searchFrom={99} options={OPS[f.kind]} onChange={(v) => v[0] && onPatch({ op: v[0] })} />
        </div>
      )}
      {f && !NO_VALUE.has(c.op) && (
        <div className="cx-cond-val">
          {f.kind === "enum" ? (
            <SalesMultiFilter values={c.vals} onChange={(v) => onPatch({ vals: v })} placeholder="Choose…" searchFrom={8} options={f.options ?? []} />
          ) : f.kind === "date" && c.op === "period" ? (
            <SalesMultiFilter single values={[c.a]} onChange={(v) => v[0] && onPatch({ a: v[0] })} placeholder="Period" searchFrom={99}
              options={PERIODS.filter((p) => p.key !== "all" && p.key !== "custom").map((p) => ({ value: p.key, label: `${p.group} · ${p.label}` }))} />
          ) : f.kind === "date" ? (
            <div className="cx-two"><DatePicker value={c.a} onChange={(d) => onPatch({ a: d })} placeholder="From" /><span>–</span><DatePicker value={c.b} onChange={(d) => onPatch({ b: d })} placeholder="To" /></div>
          ) : c.op === "between" ? (
            <div className="cx-two"><input type="number" value={c.a} onChange={(e) => onPatch({ a: e.target.value })} placeholder="From" /><span>–</span><input type="number" value={c.b} onChange={(e) => onPatch({ b: e.target.value })} placeholder="To" /></div>
          ) : (
            <input className="cx-input" type={f.kind === "number" ? "number" : "text"} value={c.a} onChange={(e) => onPatch({ a: e.target.value })} placeholder={f.kind === "number" ? "Number" : "Text"} />
          )}
        </div>
      )}
      <button className="cx-cond-x" onClick={onDrop} aria-label="Remove condition">×</button>
    </div>
  );
}

/* ═══════════════════════════ the sender (runs in this tab) ═══════════════════════════ */
type Runner = {
  running: string | null; banner: { tone: "live" | "warn"; text: string } | null;
  start: (c: MkCampaign) => Promise<string | null>; pause: (c: MkCampaign) => Promise<void>; resume: (c: MkCampaign) => Promise<void>;
};
/** Turns a campaign's recipients into queued rows (and the ones who won't get it into skipped rows, with the reason). */
async function queueCampaign(c: MkCampaign, recs: Recipient[]): Promise<string | null> {
  const rows = recs.map((r) => ({
    campaign_id: c.id, contact_id: r.contactId, email: r.email || "(none)", name: r.name, merge: r.merge,
    status: r.state === "ok" ? "queued" : "skipped", error: r.state === "ok" ? null : STATE_LABEL[r.state],
  }));
  // one row per address: skipped people without an e-mail get a unique placeholder so the unique index holds
  const seen = new Set<string>();
  const uniq = rows.filter((r) => { const k = r.email.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((r, i) => (r.email === "(none)" ? { ...r, email: `(none-${i})` } : r));
  for (let i = 0; i < uniq.length; i += 500) {
    const { error } = await supabase.from("marketing_sends").insert(uniq.slice(i, i + 500));
    if (error && !/duplicate|unique/i.test(error.message)) return error.message;
  }
  const ok = recs.filter((r) => r.state === "ok").length;
  await supabase.from("marketing_campaigns").update({
    status: "sending", started_at: new Date().toISOString(),
    stats: { total: ok, queued: ok, sent: 0, failed: 0, skipped: uniq.length - ok }, updated_at: new Date().toISOString(),
  }).eq("id", c.id);
  return null;
}
async function refreshStats(cid: string) {
  const { rows } = await mkAll<{ status: string }>("marketing_sends", "status", (q) => q.eq("campaign_id", cid));
  const s = { total: 0, queued: 0, sent: 0, failed: 0, skipped: 0 } as Record<string, number>;
  rows.forEach((r) => { if (r.status === "skipped") s.skipped++; else { s.total++; s[r.status === "claimed" ? "queued" : r.status] = (s[r.status === "claimed" ? "queued" : r.status] ?? 0) + 1; } });
  await supabase.from("marketing_campaigns").update({ stats: s, updated_at: new Date().toISOString() }).eq("id", cid);
  return s;
}
function useCampaignRunner({ campaigns, eng, w, lists, members, optOut, me, onChange }: {
  campaigns: MkCampaign[]; eng: MkEngine | null; w: MkWorld | null; lists: MkList[]; members: Map<string, string[]>; optOut: Set<string>;
  me: { id: string | null; email: string }; onChange: () => Promise<void>;
}): Runner {
  const [running, setRunning] = useState<string | null>(null);
  const [banner, setBanner] = useState<Runner["banner"]>(null);
  const live = useRef({ campaigns, eng, w, lists, members, optOut, me, onChange });
  live.current = { campaigns, eng, w, lists, members, optOut, me, onChange };
  const busy = useRef(false);
  const sentToday = useRef<number | null>(null);
  const waitUntil = useRef(0);

  const recipientsFor = (c: MkCampaign): Recipient[] | null => {
    const { eng: e, w: ww, lists: ls, members: mm, optOut: oo } = live.current;
    const l = ls.find((x) => x.id === c.list_id);
    if (!e || !ww || !l) return null;
    return e.recipients(l.entity, listRecords(e, ww, l, mm, l.id), l.definition?.who ?? "all", oo);
  };

  const step = async () => {
    if (busy.current) return;
    const { campaigns: cs, me: m } = live.current;
    if (!m.id) return;
    if (Date.now() < waitUntil.current) return;
    busy.current = true;
    try {
      // a scheduled campaign whose time has come starts now (needs the recipients, so only once the data is loaded)
      const due = cs.find((c) => c.status === "scheduled" && c.scheduled_at && new Date(c.scheduled_at).getTime() <= Date.now());
      if (due) {
        const recs = recipientsFor(due);
        if (recs) { await queueCampaign(due, recs); await live.current.onChange(); }
        return;
      }
      const c = cs.find((x) => x.status === "sending");
      if (!c) { setRunning(null); setBanner(null); return; }
      setRunning(c.id);
      // the day's allowance of the mailbox (Exchange: 10,000 recipients a day) — keep a margin
      if (sentToday.current == null) {
        const since = new Date(); since.setHours(0, 0, 0, 0);
        const { rows } = await mkAll<any>("marketing_sends", "id", (q) => q.eq("status", "sent").eq("claimed_by", m.id).gte("sent_at", since.toISOString()));
        sentToday.current = rows.length;
      }
      if (sentToday.current >= PROVIDER.perDay * 0.95) {
        setBanner({ tone: "warn", text: `Daily sending limit reached for your mailbox (${fmtN(PROVIDER.perDay)} recipients a day). “${c.name}” carries on tomorrow.` });
        waitUntil.current = Date.now() + 30 * 60 * 1000; return;
      }
      // rows somebody claimed but never finished (tab closed mid-send) go back to the queue
      await supabase.from("marketing_sends").update({ status: "queued", claimed_by: null, claimed_at: null })
        .eq("campaign_id", c.id).eq("status", "claimed").lt("claimed_at", new Date(Date.now() - 3 * 60 * 1000).toISOString());
      const { data: next } = await supabase.from("marketing_sends").select("*").eq("campaign_id", c.id).eq("status", "queued").order("created_at").limit(1);
      const row = ((next ?? []) as MkSend[])[0];
      if (!row) {
        const { data: open } = await supabase.from("marketing_sends").select("id").eq("campaign_id", c.id).eq("status", "claimed").limit(1);
        if (!(open ?? []).length) {
          const s = await refreshStats(c.id);
          await supabase.from("marketing_campaigns").update({ status: "sent", finished_at: new Date().toISOString(), stats: s }).eq("id", c.id);
          setBanner({ tone: "live", text: `“${c.name}” is sent: ${fmtN(s.sent)} delivered to the mail server, ${fmtN(s.failed)} failed.` });
          await live.current.onChange();
        }
        return;
      }
      // claim it, so another open tab doesn't send it too
      const { data: claimed } = await supabase.from("marketing_sends").update({ status: "claimed", claimed_by: m.id, claimed_at: new Date().toISOString() })
        .eq("id", row.id).eq("status", "queued").select("id");
      if (!(claimed ?? []).length) return;
      const footerMail = c.from_mailbox || m.email;
      const vals = { ...row.merge, unsubscribe_email: footerMail ?? "" };
      const res = await PROVIDER.send({
        to: [row.email], subject: mergeText(c.subject, vals, false), html: emailHtml(mergeText(c.body_html, vals, true)),
        from: c.from_mailbox || null, replyTo: c.reply_to || null, ref: `campaign:${c.id}`,
      });
      if (res.ok) {
        sentToday.current = (sentToday.current ?? 0) + 1;
        await supabase.from("marketing_sends").update({ status: "sent", sent_at: new Date().toISOString(), message_id: res.messageId ?? null, error: null }).eq("id", row.id);
      } else if (res.needsMailPermission) {
        // nothing will go out until Outlook is connected with mail: stop and say so
        await supabase.from("marketing_sends").update({ status: "queued", claimed_by: null, claimed_at: null }).eq("id", row.id);
        await supabase.from("marketing_campaigns").update({ status: "paused" }).eq("id", c.id);
        setBanner({ tone: "warn", text: "Your Outlook connection can't send mail yet. Connect Outlook again “with mail” (Calendar settings), then resume the campaign." });
        await live.current.onChange();
        return;
      } else if (res.retryAfter || isThrottle(res.error)) {
        await supabase.from("marketing_sends").update({ status: "queued", claimed_by: null, claimed_at: null }).eq("id", row.id);
        const secs = res.retryAfter || 60;
        waitUntil.current = Date.now() + secs * 1000;
        setBanner({ tone: "warn", text: `The mail server asked us to slow down — waiting ${secs} s before the next e-mail.` });
        return;
      } else {
        await supabase.from("marketing_sends").update({ status: "failed", error: res.error ?? "Failed" }).eq("id", row.id);
      }
      const done = (c.stats.sent ?? 0) + (c.stats.failed ?? 0) + 1;
      setBanner({ tone: "live", text: `Sending “${c.name}” — ${fmtN(Math.min(done, c.stats.total ?? done))} of ${fmtN(c.stats.total ?? 0)}. Keep this tab open; it sends about ${PROVIDER.perMinute} e-mails a minute.` });
      if (done % 10 === 0) { await refreshStats(c.id); await live.current.onChange(); }
    } finally { busy.current = false; }
  };

  useEffect(() => {
    const t = window.setInterval(() => { void step(); }, Math.ceil(60000 / PROVIDER.perMinute) + 100);
    return () => window.clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    running, banner,
    start: async (c) => {
      const recs = recipientsFor(c);
      if (!recs) return "The list of this campaign can't be read.";
      if (!recs.some((r) => r.state === "ok")) return "Nobody on this list can receive it.";
      const e = await queueCampaign(c, recs);
      await live.current.onChange();
      return e;
    },
    pause: async (c) => { await supabase.from("marketing_campaigns").update({ status: "paused" }).eq("id", c.id); await refreshStats(c.id); await live.current.onChange(); },
    resume: async (c) => { await supabase.from("marketing_campaigns").update({ status: "sending", finished_at: null }).eq("id", c.id); await live.current.onChange(); },
  };
}

/* ═══════════════════════════ Campaigns ═══════════════════════════ */
function CampaignsTab({ w, eng, lists, members, optOut, campaigns, me, missing, runner, onChange, onGoLists }: {
  w: MkWorld; eng: MkEngine; lists: MkList[]; members: Map<string, string[]>; optOut: Set<string>; campaigns: MkCampaign[];
  me: { id: string | null; email: string }; missing: boolean; runner: Runner; onChange: () => Promise<void>; onGoLists: () => void;
}) {
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [st, setSt] = useState<"all" | "active" | "draft" | "done">("all");
  const cur = campaigns.find((c) => c.id === open) ?? null;
  if (open === "new" || (cur && (cur.status === "draft" || cur.status === "scheduled"))) {
    return <Composer key={open ?? "new"} w={w} eng={eng} lists={lists} members={members} optOut={optOut} campaign={cur} me={me} missing={missing} runner={runner}
      onBack={() => setOpen(null)} onSaved={async (id) => { await onChange(); setOpen(id); }} />;
  }
  if (cur) return <CampaignProgress key={cur.id} c={cur} lists={lists} runner={runner} onBack={() => setOpen(null)} onChange={onChange}
    onDuplicate={async () => {
      const { data } = await supabase.from("marketing_campaigns").insert({ name: `${cur.name} (copy)`, list_id: cur.list_id, from_mailbox: cur.from_mailbox, reply_to: cur.reply_to, subject: cur.subject, body_html: cur.body_html, status: "draft" }).select("id").single();
      await onChange(); if (data) setOpen((data as any).id);
    }} />;
  const group = (c: MkCampaign) => (c.status === "sending" || c.status === "paused" || c.status === "scheduled" ? "active" : c.status === "draft" ? "draft" : "done");
  const nBy = (g: string) => campaigns.filter((c) => group(c) === g).length;
  const shown = campaigns.filter((c) => st === "all" || group(c) === st);
  if (!campaigns.length) {
    return (
      <div className="mk-empty">
        <div className="mk-empty-art" aria-hidden="true"><span className="is-a">{MkIco.mail}</span><span className="is-b">{MkIco.send}</span><span className="is-c">{MkIco.people}</span></div>
        <h3>Your first campaign is a few clicks away</h3>
        <p>{lists.length ? "Pick one of your lists, write the e-mail with merge fields, send yourself a test and go." : "Start by saving a list of the people you want to reach — then write the e-mail here."}</p>
        <div className="mk-empty-acts">
          {lists.length
            ? <button className="mk-btn is-primary is-big" onClick={() => setOpen("new")} disabled={missing}>{MkIco.plus}New campaign</button>
            : <button className="mk-btn is-primary is-big" onClick={onGoLists}>{MkIco.list}Build a list first</button>}
        </div>
        <ol className="mk-steps">
          <li><i>1</i>Choose a list</li><li><i>2</i>Write &amp; preview</li><li><i>3</i>Send a test</li><li><i>4</i>Send or schedule</li>
        </ol>
      </div>
    );
  }
  return (
    <div className="mk-camps-wrap">
      <div className="mk-camps-bar">
        <MkSeg size="sm" value={st} onChange={setSt}
          options={[{ value: "all", label: "All", count: campaigns.length }, { value: "active", label: "In progress", count: nBy("active") }, { value: "draft", label: "Drafts", count: nBy("draft") }, { value: "done", label: "Finished", count: nBy("done") }]} />
        <span className="mk-grow" />
        <button className="mk-btn is-primary" onClick={() => setOpen("new")} disabled={missing}>{MkIco.plus}New campaign</button>
      </div>
      <div className="mk-camps">
        {shown.map((c, i) => {
          const s = c.stats ?? {};
          const total = s.total ?? 0, done = (s.sent ?? 0) + (s.failed ?? 0);
          const l = lists.find((x) => x.id === c.list_id);
          return (
            <button key={c.id} className={`mk-camp is-${c.status}`} onClick={() => setOpen(c.id)} style={{ ["--i" as string]: i } as CSSProperties}>
              <div className="mk-camp-top">
                <span className={`mk-status is-${c.status}`}>{c.status === "sending" && runner.running === c.id && <i className="mk-pulse" />}{STATUS_LABEL[c.status]}</span>
                <em>{MkIco.clock}{fmtWhen(c.finished_at ?? c.started_at ?? c.scheduled_at ?? c.updated_at)}</em>
              </div>
              <b className="mk-camp-name">{c.name}</b>
              <span className="mk-camp-sub">{c.subject || "No subject yet"}</span>
              <span className="mk-camp-list">{MkIco.list}<span>{l?.name ?? "No list"}</span>{c.from_mailbox && <em>· {c.from_mailbox}</em>}</span>
              <span className="mk-camp-foot">
                {total > 0 ? (
                  <span className="mk-camp-prog">
                    <span className="mk-camp-track"><i className="is-sent" style={{ width: `${((s.sent ?? 0) / total) * 100}%` }} /><i className="is-failed" style={{ width: `${((s.failed ?? 0) / total) * 100}%` }} /></span>
                    <em><b>{fmtN(s.sent ?? 0)}</b> sent{s.failed ? <> · <b className="is-bad">{fmtN(s.failed)}</b> failed</> : ""} of {fmtN(total)}<span>{Math.round((done / total) * 100)}%</span></em>
                  </span>
                ) : (
                  <span className="mk-camp-hint">{c.status === "scheduled" ? `Starts ${fmtWhen(c.scheduled_at)}` : "Not sent yet — open to finish it"}{MkIco.arrow}</span>
                )}
              </span>
            </button>
          );
        })}
        {!shown.length && <div className="mk-empty-sm is-wide">{MkIco.send}<span>No campaigns here.</span></div>}
      </div>
    </div>
  );
}

function Composer({ w, eng, lists, members, optOut, campaign, me, missing, runner, onBack, onSaved }: {
  w: MkWorld; eng: MkEngine; lists: MkList[]; members: Map<string, string[]>; optOut: Set<string>; campaign: MkCampaign | null;
  me: { id: string | null; email: string }; missing: boolean; runner: Runner; onBack: () => void; onSaved: (id: string) => Promise<void>;
}) {
  const init = splitBody(campaign?.body_html ?? "<p>Hola {{first_name}},</p><p></p><p>Un saludo,</p>");
  const [name, setName] = useState(campaign?.name ?? "");
  const [listId, setListId] = useState(campaign?.list_id ?? lists[0]?.id ?? "");
  const [from, setFrom] = useState(campaign?.from_mailbox ?? "");
  const [replyTo, setReplyTo] = useState(campaign?.reply_to ?? "");
  const [subject, setSubject] = useState(campaign?.subject ?? "");
  const [body, setBody] = useState(init.body);
  const [footer, setFooter] = useState(init.footer);
  const [htmlMode, setHtmlMode] = useState(false);
  const [pi, setPi] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [when, setWhen] = useState<{ d: string; t: string }>(() => {
    const at = campaign?.scheduled_at ? new Date(campaign.scheduled_at) : null;
    return at ? { d: at.toISOString().slice(0, 10), t: at.toTimeString().slice(0, 5) } : { d: "", t: "09:00" };
  });
  const [confirmSend, setConfirmSend] = useState(false);
  const editRef = useRef<HTMLDivElement | null>(null);
  const subjRef = useRef<HTMLInputElement | null>(null);
  const lastFocus = useRef<"body" | "subject">("body");
  useEffect(() => { if (editRef.current && !htmlMode && editRef.current.innerHTML !== body) editRef.current.innerHTML = body; }, [htmlMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = lists.find((l) => l.id === listId) ?? null;
  const recs = useMemo(() => (list ? eng.recipients(list.entity, listRecords(eng, w, list, members, list.id), list.definition?.who ?? "all", optOut) : []), [eng, w, list, members, optOut]);
  const ok = recs.filter((r) => r.state === "ok");
  const sample = ok[Math.min(pi, Math.max(0, ok.length - 1))];
  const fullBody = joinBody(body, footer);
  const vals = { ...(sample?.merge ?? { first_name: "Laura", last_name: "Gil", full_name: "Laura Gil", company: "Acme Iberia", position: "CFO", city: "Madrid", email: "laura@example.com" }), unsubscribe_email: from || me.email };
  const previewDoc = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:22px;background:#fff}a{color:#0a6f4d}</style></head><body>${emailHtml(mergeText(fullBody, vals, true))}</body></html>`;
  const mailboxes = useMemo(() => [...new Set([me.email, ...lists.length ? [] : [], ...[] as string[]].filter(Boolean))], [me.email, lists.length]);

  const exec = (cmd: string, arg?: string) => { editRef.current?.focus(); document.execCommand(cmd, false, arg); setBody(editRef.current?.innerHTML ?? ""); };
  const insertField = (k: string) => {
    const tok = `{{${k}}}`;
    if (lastFocus.current === "subject" && subjRef.current) {
      const el = subjRef.current; const a = el.selectionStart ?? subject.length, b = el.selectionEnd ?? a;
      setSubject(subject.slice(0, a) + tok + subject.slice(b));
      window.setTimeout(() => { el.focus(); el.setSelectionRange(a + tok.length, a + tok.length); }, 0);
    } else if (htmlMode) setBody((x) => x + tok);
    else exec("insertText", tok);
  };
  const [linkAsk, setLinkAsk] = useState<string | null>(null);

  const persist = async (patch: Partial<MkCampaign> = {}): Promise<string | null> => {
    const nm = name.trim() || subject.trim() || "Untitled campaign";
    const row = { name: nm, list_id: listId || null, from_mailbox: from.trim() || null, reply_to: replyTo.trim() || null, subject, body_html: fullBody, updated_at: new Date().toISOString(), ...patch };
    if (campaign) {
      const { error } = await supabase.from("marketing_campaigns").update(row).eq("id", campaign.id);
      if (error) { setMsg({ tone: "err", text: error.message }); return null; }
      return campaign.id;
    }
    const { data, error } = await supabase.from("marketing_campaigns").insert({ status: "draft", ...row }).select("*").single();
    if (error || !data) { setMsg({ tone: "err", text: error?.message ?? "Could not save." }); return null; }
    return (data as any).id as string;
  };
  const problem = !listId ? "Choose a list." : !subject.trim() ? "Write a subject." : !body.replace(/<[^>]+>/g, "").trim() ? "Write the e-mail." : !ok.length ? "Nobody on this list can receive it." : null;

  const testSend = async () => {
    if (!me.email) { setMsg({ tone: "err", text: "Your user has no e-mail to send the test to." }); return; }
    setBusy("test"); setMsg(null);
    const res = await PROVIDER.send({ to: [me.email], subject: `[Test] ${mergeText(subject, vals, false)}`, html: emailHtml(mergeText(fullBody, vals, true)), from: from.trim() || null, replyTo: replyTo.trim() || null, ref: "campaign:test" });
    setBusy(null);
    setMsg(res.ok ? { tone: "ok", text: `Test sent to ${me.email} as ${sample?.name ?? "a sample contact"}.` } : { tone: "err", text: `The test didn't go out: ${res.error}` });
  };
  const saveDraft = async () => { setBusy("save"); const id = await persist({ status: "draft", scheduled_at: null }); setBusy(null); if (id) { setMsg({ tone: "ok", text: "Draft saved." }); await onSaved(id); } };
  const schedule = async () => {
    if (!when.d) { setMsg({ tone: "err", text: "Pick a date." }); return; }
    const at = new Date(`${when.d}T${when.t || "09:00"}:00`);
    if (at.getTime() < Date.now()) { setMsg({ tone: "err", text: "That time has already passed." }); return; }
    setBusy("schedule"); const id = await persist({ status: "scheduled", scheduled_at: at.toISOString() }); setBusy(null);
    if (id) { setMsg({ tone: "ok", text: `Scheduled for ${fmtWhen(at.toISOString())}. It starts then if Marketing is open in a browser tab.` }); await onSaved(id); }
  };
  const sendNow = async () => {
    setBusy("send"); setConfirmSend(false);
    const id = await persist({ status: "draft" });
    if (!id) { setBusy(null); return; }
    const e = await runner.start({ ...(campaign ?? ({} as MkCampaign)), id, list_id: listId, name, subject, body_html: fullBody, from_mailbox: from || null, reply_to: replyTo || null, status: "draft", stats: {} } as MkCampaign);
    setBusy(null);
    if (e) setMsg({ tone: "err", text: e }); else await onSaved(id);
  };

  return (
    <section className="mk-compose">
      <div className="mk-card mk-cmp-head">
        <button className="mk-back" onClick={onBack} aria-label="Back to campaigns">{MkIco.back}</button>
        <div className="mk-cmp-title">
          <span className="mk-k">{campaign ? "Campaign" : "New campaign"}</span>
          <input className="mk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name (only you see it)" />
        </div>
        {campaign?.status === "scheduled" ? <span className="mk-status is-scheduled">Scheduled · {fmtWhen(campaign.scheduled_at)}</span> : <span className="mk-status is-draft">Draft</span>}
      </div>
      <div className="mk-cmp-grid">
        <div className="mk-cmp-main">
          <div className="mk-card mk-fields">
            <div className="mk-card-h"><b>Envelope</b><em>Who it goes to and who it comes from</em></div>
            <label className="mk-f"><span>To</span>
              <div className="mk-f-sel">
                <Select value={listId} onChange={setListId} placeholder="Choose a list…" options={lists.map((l) => ({ value: l.id, label: l.name, hint: `${l.entity} · ${l.kind === "dynamic" ? "dynamic" : "fixed"}` }))} />
                <em>{list ? `${fmtN(ok.length)} people will receive it${recs.length - ok.length ? ` · ${fmtN(recs.length - ok.length)} left out (no e-mail, unsubscribed…)` : ""}` : "Save a list first in Lists."}</em>
              </div>
            </label>
            <label className="mk-f"><span>From</span>
              <div className="mk-f-sel">
                <input className="mk-input" list="mk-mailboxes" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={me.email ? `Your mailbox (${me.email}) — or a department one, e.g. marketing@…` : "Department mailbox, e.g. marketing@…"} />
                <datalist id="mk-mailboxes">{mailboxes.map((m) => <option key={m} value={m} />)}</datalist>
                <em>A shared mailbox needs “Send as” for your user in Microsoft 365.</em>
              </div>
            </label>
            <label className="mk-f"><span>Reply-to</span><input className="mk-input" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="Optional — where replies should go" /></label>
            <label className="mk-f"><span>Subject</span><input ref={subjRef} className="mk-input is-subject" value={subject} onFocus={() => { lastFocus.current = "subject"; }} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. {{first_name}}, novedades para {{company}}" /></label>
          </div>
          <div className="mk-card mk-editorbox">
            <div className="mk-card-h"><b>Message</b><em>Merge fields are filled in for each person</em></div>
            <div className="mk-tool">
              {!htmlMode && (
                <>
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec("bold")} title="Bold"><b>B</b></button>
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec("italic")} title="Italic"><i>I</i></button>
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec("underline")} title="Underline"><u>U</u></button>
                  <span className="mk-tool-sep" />
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec("formatBlock", "h2")} title="Heading">H</button>
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec("formatBlock", "p")} title="Paragraph">¶</button>
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec("insertUnorderedList")} title="Bullets">•</button>
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => exec("insertOrderedList")} title="Numbers">1.</button>
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => setLinkAsk("https://")} title="Link">🔗</button>
                  {linkAsk != null && (
                    <span className="mk-linkask">
                      <input autoFocus value={linkAsk} onChange={(e) => setLinkAsk(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { exec("createLink", linkAsk); setLinkAsk(null); } if (e.key === "Escape") setLinkAsk(null); }} />
                      <button onMouseDown={(e) => e.preventDefault()} onClick={() => { exec("createLink", linkAsk); setLinkAsk(null); }}>Add</button>
                    </span>
                  )}
                  <span className="mk-tool-sep" />
                </>
              )}
              <span className="mk-merge">
                <em>Insert</em>
                {MERGE_FIELDS.map((m) => <button key={m.key} onMouseDown={(e) => e.preventDefault()} onClick={() => insertField(m.key)}>{m.label}</button>)}
              </span>
              <span className="mk-grow" />
              <button className={`mk-html ${htmlMode ? "is-on" : ""}`} onClick={() => { if (!htmlMode) setBody(editRef.current?.innerHTML ?? body); setHtmlMode(!htmlMode); }}>{"</>"} HTML</button>
            </div>
            {htmlMode ? (
              <textarea className="mk-src" value={body} onChange={(e) => setBody(e.target.value)} onFocus={() => { lastFocus.current = "body"; }} spellCheck={false} />
            ) : (
              <div ref={editRef} className="mk-rich" contentEditable suppressContentEditableWarning onFocus={() => { lastFocus.current = "body"; }}
                onInput={(e) => setBody((e.target as HTMLDivElement).innerHTML)} />
            )}
            <div className="mk-footbox">
              <span>Unsubscribe line <em>added at the bottom of every e-mail (required by law)</em></span>
              <textarea value={footer} onChange={(e) => setFooter(e.target.value)} rows={2} />
              {!/\{\{\s*unsubscribe_email\s*\}\}|mailto:|baja/i.test(footer) && <em className="mk-warn-t">Keep a way to unsubscribe (a mailto link or “reply BAJA”).</em>}
            </div>
          </div>
        </div>

        <aside className="mk-cmp-side">
          <div className="mk-card mk-pv">
            <div className="mk-pv-h">
              <b>Live preview</b>
              {ok.length > 0 && (
                <span className="mk-pv-nav">
                  <button onClick={() => setPi((x) => Math.max(0, x - 1))} disabled={pi <= 0}>‹</button>
                  <em title={sample?.email}>{sample?.name ?? ""}<small>{Math.min(pi, ok.length - 1) + 1} / {fmtN(ok.length)}</small></em>
                  <button onClick={() => setPi((x) => Math.min(ok.length - 1, x + 1))} disabled={pi >= ok.length - 1}>›</button>
                </span>
              )}
            </div>
            <div className="mk-pv-mail">
              <div className="mk-pv-chrome" aria-hidden="true"><i /><i /><i /><span>Inbox</span></div>
              <div className="mk-pv-meta">
                <b>{mergeText(subject, vals, false) || "No subject"}</b>
                <span><em>From</em>{from || me.email || "you"}</span>
                <span><em>To</em>{sample ? `${sample.name} <${sample.email}>` : "—"}</span>
              </div>
              <iframe title="E-mail preview" sandbox="" srcDoc={previewDoc} />
            </div>
          </div>
          <div className="mk-card mk-send">
            <div className="mk-send-sum">
              <span><b>{fmtN(ok.length)}</b><em>recipients</em></span>
              <span><b>~{ok.length ? Math.max(1, Math.ceil(ok.length / PROVIDER.perMinute)) : 0} min</b><em>at {PROVIDER.perMinute}/min</em></span>
            </div>
            {msg && <span className={`mk-msg is-${msg.tone}`}>{msg.text}</span>}
            {problem && <span className="mk-msg is-hint">{problem}</span>}
            <div className="mk-send-row">
              <button className="mk-btn is-ghost" disabled={!!busy || missing} onClick={() => void saveDraft()}>{busy === "save" ? "Saving…" : "Save draft"}</button>
              <button className="mk-btn is-ghost" disabled={!!busy || !subject.trim()} onClick={() => void testSend()}>{busy === "test" ? "Sending test…" : "Send me a test"}</button>
            </div>
            <div className="mk-sched">
              <span>Schedule</span>
              <DatePicker value={when.d} onChange={(d) => setWhen((x) => ({ ...x, d }))} placeholder="Date" />
              <input type="time" value={when.t} onChange={(e) => setWhen((x) => ({ ...x, t: e.target.value }))} />
              <button className="mk-btn is-ghost" disabled={!!busy || !!problem || missing} onClick={() => void schedule()}>{busy === "schedule" ? "…" : "Schedule"}</button>
            </div>
            {confirmSend ? (
              <div className="mk-really">
                <b>Send to {fmtN(ok.length)} people now?</b>
                <em>About {Math.max(1, Math.ceil(ok.length / PROVIDER.perMinute))} min at {PROVIDER.perMinute} e-mails a minute — keep this tab open. You can pause any time.</em>
                <div><button className="mk-btn is-ghost" autoFocus onClick={() => setConfirmSend(false)}>Not yet</button><button className="mk-btn is-primary" onClick={() => void sendNow()}>{MkIco.send}Send now</button></div>
              </div>
            ) : (
              <button className="mk-btn is-primary is-big" disabled={!!busy || !!problem || missing} onClick={() => setConfirmSend(true)}>{busy === "send" ? "Starting…" : <>{MkIco.send}Send to {fmtN(ok.length)} people</>}</button>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function CampaignProgress({ c, lists, runner, onBack, onChange, onDuplicate }: {
  c: MkCampaign; lists: MkList[]; runner: Runner; onBack: () => void; onChange: () => Promise<void>; onDuplicate: () => Promise<void>;
}) {
  const [sends, setSends] = useState<MkSend[]>([]);
  const [filter, setFilter] = useState<MkSend["status"] | "all">("all");
  const [q, setQ] = useState("");
  const load = async () => { const { rows } = await mkAll<MkSend>("marketing_sends", "*", (qq) => qq.eq("campaign_id", c.id).order("created_at")); setSends(rows); };
  useEffect(() => { void load(); const t = window.setInterval(() => { if (c.status === "sending") void load(); }, 5000); return () => window.clearInterval(t); }, [c.id, c.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const cnt = useMemo(() => { const o: Record<string, number> = { queued: 0, claimed: 0, sent: 0, failed: 0, skipped: 0 }; sends.forEach((s) => { o[s.status] = (o[s.status] ?? 0) + 1; }); return o; }, [sends]);
  const total = cnt.queued + cnt.claimed + cnt.sent + cnt.failed;
  const pct = total ? (cnt.sent + cnt.failed) / total : 0;
  const nq = norm(q);
  const shown = sends.filter((s) => (filter === "all" || s.status === filter) && (!nq || norm(`${s.name} ${s.email}`).includes(nq)));
  const l = lists.find((x) => x.id === c.list_id);
  const retry = async () => {
    await supabase.from("marketing_sends").update({ status: "queued", error: null, claimed_by: null, claimed_at: null }).eq("campaign_id", c.id).eq("status", "failed");
    await runner.resume(c); await load();
  };
  const cancel = async () => {
    await supabase.from("marketing_sends").update({ status: "skipped", error: "Cancelled" }).eq("campaign_id", c.id).eq("status", "queued");
    await supabase.from("marketing_campaigns").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", c.id);
    await refreshStats(c.id); await onChange(); await load();
  };
  return (
    <section className="mk-progress">
      <div className="mk-card mk-pg-head">
        <button className="mk-back" onClick={onBack} aria-label="Back to campaigns">{MkIco.back}</button>
        <div className="mk-pg-title">
          <span className={`mk-status is-${c.status}`}>{c.status === "sending" && runner.running === c.id && <i className="mk-pulse" />}{STATUS_LABEL[c.status]}</span>
          <h2>{c.name}</h2>
          <em><b>{c.subject}</b></em>
          <span className="mk-pg-meta"><span>{MkIco.list}{l?.name ?? "no list"}</span>{c.from_mailbox && <span>{MkIco.mail}{c.from_mailbox}</span>}<span>{MkIco.clock}started {fmtWhen(c.started_at)}{c.finished_at ? ` · finished ${fmtWhen(c.finished_at)}` : ""}</span></span>
        </div>
        <div className="mk-pg-acts">
          {c.status === "sending" && <button className="mk-btn is-ghost" onClick={() => void runner.pause(c)}>{MkIco.pause}Pause</button>}
          {c.status === "paused" && <button className="mk-btn is-primary" onClick={() => void runner.resume(c)}>{MkIco.play}Resume</button>}
          {cnt.failed > 0 && c.status !== "sending" && <button className="mk-btn is-ghost" onClick={() => void retry()}>Retry {fmtN(cnt.failed)} failed</button>}
          {(c.status === "sending" || c.status === "paused") && <MkConfirm label={<>{MkIco.stop}Cancel</>} className="is-ghost" ask="Stop for good?" yes="Cancel campaign" onYes={() => void cancel()} />}
          <button className="mk-btn is-ghost" onClick={() => void onDuplicate()}>Duplicate</button>
        </div>
      </div>
      <div className="mk-card mk-pg-stats">
        <div className="mk-ring" style={{ ["--p" as string]: pct } as CSSProperties}><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="42" /><circle className="is-on" cx="50" cy="50" r="42" pathLength={100} style={{ strokeDasharray: `${pct * 100} 100` }} /></svg><b>{Math.round(pct * 100)}%</b><em>done</em></div>
        {([["sent", "Sent"], ["queued", "Waiting"], ["failed", "Failed"], ["skipped", "Left out"]] as const).map(([k, lb]) => (
          <button key={k} className={`mk-pg-stat is-${k} ${filter === k ? "is-on" : ""}`} onClick={() => setFilter(filter === k ? "all" : k)}>
            <i /><b>{fmtN(k === "queued" ? cnt.queued + cnt.claimed : cnt[k])}</b><span>{lb}</span>
          </button>
        ))}
        <p className="mk-pg-note">“Sent” means the mail server accepted it. Bounces and replies arrive in the sending mailbox.</p>
      </div>
      <div className="mk-card mk-pg-list">
        <div className="mk-pg-tools"><label className="mk-search">{MkIco.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a person or e-mail…" /></label>{filter !== "all" && <button className="mk-linkbtn" onClick={() => setFilter("all")}>Show all</button>}<em>{fmtN(shown.length)} of {fmtN(sends.length)}</em></div>
        <div className="mk-thead"><span>Recipient</span><span>Status</span></div>
        <div className="mk-pg-rows">
          {shown.slice(0, 400).map((s) => (
            <div key={s.id} className={`mk-pg-row is-${s.status}`}>
              <i style={{ ["--h" as string]: hue(s.name ?? s.email) } as CSSProperties}>{initials(s.name ?? s.email)}</i>
              <span><b>{s.name || s.email}</b><em>{s.email.startsWith("(none") ? "no e-mail" : s.email}</em></span>
              <small className={`mk-st is-${s.status}`}>{s.status === "claimed" ? "Sending…" : s.status === "queued" ? "Waiting" : s.status === "sent" ? `Sent ${fmtWhen(s.sent_at)}` : s.status === "skipped" ? s.error ?? "Left out" : "Failed"}</small>
              {s.status === "failed" && s.error && <em className="mk-pg-err" title={s.error}>{s.error}</em>}
            </div>
          ))}
          {!shown.length && <div className="mk-empty-sm">{MkIco.mail}<span>{sends.length ? "Nothing matches." : "No e-mails queued for this campaign."}</span></div>}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════ Unsubscribes ═══════════════════════════ */
function UnsubsTab({ unsubs, w, missing, onChange }: { unsubs: MkUnsub[]; w: MkWorld; missing: boolean; onChange: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [bulk, setBulk] = useState("");
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const have = useMemo(() => new Set(unsubs.map((u) => u.email.toLowerCase())), [unsubs]);
  const contactBy = useMemo(() => { const m = new Map<string, Contact>(); w.contacts.forEach((c) => { const e = String(c.email ?? "").trim().toLowerCase(); if (e) m.set(e, c); }); return m; }, [w.contacts]);
  const add = async (list: string[], source: "manual" | "import", why: string | null) => {
    const clean = [...new Set(list.map((x) => x.trim().toLowerCase()).filter((x) => EMAIL_RE.test(x) && !have.has(x)))];
    if (!clean.length) { setMsg({ tone: "err", text: "No new valid e-mail addresses." }); return; }
    for (let i = 0; i < clean.length; i += 500) {
      const { error } = await supabase.from("marketing_unsubscribes").insert(clean.slice(i, i + 500).map((e) => ({ email: e, reason: why, source })));
      if (error && !/duplicate|unique/i.test(error.message)) { setMsg({ tone: "err", text: error.message }); return; }
    }
    // the matching contacts are marked too (their consent is withdrawn)
    const ids = clean.map((e) => contactBy.get(e)?.id).filter(Boolean) as string[];
    for (let i = 0; i < ids.length; i += 200) await supabase.from("contacts").update({ marketing_opt_out: true }).in("id", ids.slice(i, i + 200));
    setMsg({ tone: "ok", text: `${fmtN(clean.length)} address${clean.length === 1 ? "" : "es"} won't get campaigns any more.` });
    setEmail(""); setReason(""); setBulk("");
    await onChange();
  };
  const remove = async (u: MkUnsub) => {
    await supabase.from("marketing_unsubscribes").delete().eq("id", u.id);
    const c = contactBy.get(u.email.toLowerCase());
    if (c?.id) await supabase.from("contacts").update({ marketing_opt_out: false }).eq("id", c.id);
    await onChange();
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    setBulk((text.match(/[^\s@,;<>"']+@[^\s@,;<>"']+\.[a-z]{2,}/gi) ?? []).join("\n"));
  };
  const nq = norm(q);
  const shown = unsubs.filter((u) => !nq || norm(`${u.email} ${u.reason ?? ""}`).includes(nq));
  return (
    <div className="mk-unsubs">
      <div className="mk-unsub-add">
        <div className="mk-card">
          <div className="mk-card-h"><span className="mk-card-ico">{MkIco.shield}</span><b>Add an address</b><em>Someone asked to stop receiving campaigns (by reply, phone…)</em></div>
          <div className="mk-unsub-form">
            <input className="cx-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            <input className="cx-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" />
            <button className="mk-btn is-primary" disabled={missing || !email.trim()} onClick={() => void add([email], "manual", reason.trim() || null)}>Add</button>
          </div>
        </div>
        <div className="mk-card">
          <div className="mk-card-h"><span className="mk-card-ico">{MkIco.dl}</span><b>Import many</b><em>Paste addresses or load a CSV / text file — every e-mail found in it is added</em></div>
          <textarea className="mk-bulk" value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={"one@company.com\nother@company.com"} rows={4} />
          <div className="mk-unsub-form">
            <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            <button className="mk-btn is-ghost" onClick={() => fileRef.current?.click()}>Load a file…</button>
            <span className="mk-grow" />
            <button className="mk-btn is-primary" disabled={missing || !bulk.trim()} onClick={() => void add(bulk.split(/[\s,;]+/), "import", "Imported")}>Import {fmtN((bulk.match(/@/g) ?? []).length)}</button>
          </div>
        </div>
        {msg && <span className={`mk-msg is-${msg.tone}`}>{msg.text}</span>}
      </div>
      <div className="mk-card mk-unsub-list">
        <div className="mk-pg-tools"><b className="mk-pg-tt">Unsubscribed</b><span className="mk-pill">{fmtN(unsubs.length)}</span><span className="mk-grow" /><label className="mk-search">{MkIco.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search e-mail or reason…" /></label></div>
        <div className="mk-thead"><span>Address</span><span /></div>
        <div className="mk-pg-rows">
          {shown.map((u) => {
            const c = contactBy.get(u.email.toLowerCase());
            return (
              <div key={u.id} className="mk-pg-row">
                <i style={{ ["--h" as string]: hue(u.email) } as CSSProperties}>{initials(c ? fullName(c) : u.email)}</i>
                <span><b>{u.email}</b><em>{c ? fullName(c) : "not in your contacts"}{u.reason ? ` · ${u.reason}` : ""} · {u.source} · {fmtWhen(u.created_at)}</em></span>
                <MkConfirm label="×" className="is-icon" ask="Allow campaigns again?" yes="Remove" onYes={() => void remove(u)} />
              </div>
            );
          })}
          {!shown.length && <div className="mk-empty-sm">{MkIco.shield}<span>{q ? "Nobody matches that search." : "Nobody has unsubscribed yet — addresses added here never get campaigns."}</span></div>}
        </div>
      </div>
    </div>
  );
}
