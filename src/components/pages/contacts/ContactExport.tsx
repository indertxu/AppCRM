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
import { buildCatalog, contactMatches, condReady, cellOf, formatOf, OPS, DEFAULT_OP, NO_VALUE, type XF, type Ctx, type Cond, type Src, type Root, type LastTouch } from "./exportCatalog";
import { listImportBatches, batchLabel } from "./importBatches";
import Select from "../../framework/Select";
import { sendOutlookMail, type OutlookMail, type OutlookMailResult } from "../../api/outlookSync";
import ActionsMenu, { type ActionItem } from "../../framework/ActionsMenu";
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
  preheader?: string | null; track_opens?: boolean; track_clicks?: boolean; ai_brief?: string | null; tags?: string[];
}
interface MkSend {
  id: string; campaign_id: string; contact_id: string | null; email: string; name: string | null; merge: Record<string, string>;
  status: "queued" | "claimed" | "sent" | "failed" | "skipped"; error: string | null; sent_at: string | null; claimed_at: string | null;
  opened_at?: string | null; open_count?: number; clicked_at?: string | null; click_count?: number; last_click_url?: string | null;
  replied_at?: string | null; bounced_at?: string | null; unsubscribed_at?: string | null;
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
const FOOTER_DEFAULT = "Recibes este correo porque mantienes una relación profesional con nosotros. Si no deseas recibir más comunicaciones, <a href=\"{{unsubscribe_url}}\">date de baja aquí</a> o responde con la palabra BAJA.";
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

/* ---------- tracking: public links served by the edge function manage-users (64_marketing_hub.sql) ---------- */
const FN_URL = `${String((import.meta as any).env?.VITE_SUPABASE_URL ?? "").replace(/\/$/, "")}/functions/v1/manage-users`;
let trackPing: Promise<boolean> | null = null;
/** True once the tracking links answer (manage-users deployed with the marketing routes). */
function trackingReady(): Promise<boolean> {
  trackPing ??= fetch(`${FN_URL}?mk=ping`).then((r) => (r.ok ? r.json() : null)).then((j) => !!j?.mk).catch(() => false);
  return trackPing;
}
function useTrackingReady() {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => { let alive = true; void trackingReady().then((v) => { if (alive) setOk(v); }); return () => { alive = false; }; }, []);
  return ok;
}
const trackUrl = (kind: "o" | "c" | "u", sendId: string, u?: string) => `${FN_URL}?mk=${kind}&s=${sendId}${u ? `&u=${encodeURIComponent(u)}` : ""}`;
/** The e-mail one person gets: merge fields filled in, links tracked, the open pixel and the preview line. */
function buildMail(c: Pick<MkCampaign, "subject" | "body_html"> & Partial<Pick<MkCampaign, "preheader" | "track_opens" | "track_clicks">>,
  row: { id: string; merge: Record<string, string> }, o: { tracking: boolean; from: string }) {
  const unsub = o.tracking ? trackUrl("u", row.id) : `mailto:${o.from}?subject=BAJA`;
  const vals = { ...row.merge, unsubscribe_email: o.from, unsubscribe_url: unsub };
  let tpl = c.body_html;
  if (o.tracking && c.track_clicks !== false) {
    tpl = tpl.replace(/(<a\b[^>]*?\bhref=")([^"]+)(")/gi, (m, a: string, href: string, z: string) => {
      const raw = href.replace(/&amp;/g, "&");
      if (!/^https?:\/\//i.test(raw) || raw.includes("{{") || raw.startsWith(FN_URL)) return m;
      return a + escHtml(trackUrl("c", row.id, raw)) + z;
    });
  }
  const pre = c.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${escHtml(mergeText(c.preheader, vals, false))}</div>` : "";
  const pixel = o.tracking && c.track_opens !== false ? `<img src="${trackUrl("o", row.id)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none">` : "";
  return { subject: mergeText(c.subject, vals, false), html: emailHtml(pre + mergeText(tpl, vals, true) + pixel) };
}
/** Saves a campaign; before 64_marketing_hub.sql the newer columns are left out. */
const NEW_CAMPAIGN_COLS = ["preheader", "track_opens", "track_clicks", "ai_brief", "tags"];
async function saveCampaignRow(row: Record<string, unknown>, id?: string | null): Promise<{ id: string | null; error: string | null }> {
  const go = async (r: Record<string, unknown>) => (id
    ? supabase.from("marketing_campaigns").update(r).eq("id", id).select("id").maybeSingle()
    : supabase.from("marketing_campaigns").insert({ status: "draft", ...r }).select("id").single());
  let res: any = await go(row);
  if (res.error && /column|schema cache/i.test(res.error.message)) {
    const r2 = { ...row }; NEW_CAMPAIGN_COLS.forEach((k) => delete r2[k]);
    res = await go(r2);
  }
  if (res.error) return { id: null, error: res.error.message };
  return { id: id ?? (res.data as any)?.id ?? null, error: null };
}

/* ---------- AI writer (edge function proposal-ai, action marketing_write) ---------- */
type AiResult<T> = { ok: true; data: T } | { ok: false; error: string };
async function aiWrite<T = any>(body: Record<string, unknown>): Promise<AiResult<T>> {
  try {
    const { data, error } = await supabase.functions.invoke("proposal-ai", { body: { action: "marketing_write", ...body } });
    if (error) {
      let msg = error.message;
      try { const j = await (error as any).context?.json?.(); if (j?.error === "no_key") return { ok: false, error: "AI isn't set up yet: add the ANTHROPIC_API_KEY secret in Supabase." }; msg = j?.error ?? j?.message ?? msg; } catch { /* keep the message */ }
      return { ok: false, error: /not found|404|failed to send|fetch/i.test(msg) ? "AI isn't available yet: deploy the proposal-ai function." : msg };
    }
    if ((data as any)?.error) return { ok: false, error: String((data as any).error) };
    return { ok: true, data: data as T };
  } catch (e: any) { return { ok: false, error: e?.message ?? "AI unavailable." }; }
}
const AI_TONES = [
  { value: "professional and warm", label: "Professional & warm" }, { value: "direct and concise", label: "Direct & concise" },
  { value: "friendly and close", label: "Friendly" }, { value: "expert and insightful", label: "Expert" }, { value: "enthusiastic", label: "Enthusiastic" },
];
const AI_LANGS = [{ value: "es", label: "Spanish" }, { value: "en", label: "English" }, { value: "ca", label: "Catalan" }];

/* ---------- social networks ---------- */
type Net = "linkedin" | "instagram" | "facebook" | "x" | "tiktok" | "threads" | "youtube";
const NETS: Record<Net, { label: string; short: string; color: string; limit: number; share?: (text: string, link: string) => string; home: string }> = {
  linkedin: { label: "LinkedIn", short: "in", color: "#0a66c2", limit: 3000, home: "https://www.linkedin.com/feed/", share: (t) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(t)}` },
  instagram: { label: "Instagram", short: "IG", color: "#d62976", limit: 2200, home: "https://www.instagram.com/" },
  facebook: { label: "Facebook", short: "f", color: "#1877f2", limit: 63206, home: "https://www.facebook.com/", share: (_t, l) => (l ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(l)}` : "https://www.facebook.com/") },
  x: { label: "X", short: "X", color: "#14171a", limit: 280, home: "https://x.com/", share: (t) => `https://x.com/intent/post?text=${encodeURIComponent(t)}` },
  tiktok: { label: "TikTok", short: "TT", color: "#ee1d52", limit: 2200, home: "https://www.tiktok.com/upload" },
  threads: { label: "Threads", short: "@", color: "#3d3d3d", limit: 500, home: "https://www.threads.net/", share: (t) => `https://www.threads.net/intent/post?text=${encodeURIComponent(t)}` },
  youtube: { label: "YouTube", short: "YT", color: "#e62117", limit: 5000, home: "https://studio.youtube.com/" },
};
const NET_KEYS = Object.keys(NETS) as Net[];
type PostStatus = "idea" | "draft" | "scheduled" | "published" | "failed" | "cancelled";
const POST_STATUS: Record<PostStatus, string> = { idea: "Idea", draft: "Draft", scheduled: "Scheduled", published: "Published", failed: "Failed", cancelled: "Cancelled" };
interface PostResult { url?: string; impressions?: number; likes?: number; comments?: number; shares?: number; clicks?: number }
interface MkPost {
  id: string; title: string | null; body: string; variants: Record<string, { text?: string }>; networks: Net[];
  media: { url: string; kind: "image" | "video"; alt?: string }[]; link_url: string | null; status: PostStatus;
  scheduled_at: string | null; published_at: string | null; results: Record<string, PostResult>; series: string | null;
  source: string; ai_brief?: string | null; created_at: string; updated_at: string;
}
interface MkAccount { id: string; network: Net; name: string; handle: string | null; kind: string; status: string }
const postText = (p: Pick<MkPost, "body" | "variants">, n: Net) => (p.variants?.[n]?.text ?? "").trim() || p.body;
const postWhen = (p: MkPost) => p.status === "published" ? p.published_at ?? p.scheduled_at : p.scheduled_at;
const isDue = (p: MkPost) => p.status === "scheduled" && !!p.scheduled_at && new Date(p.scheduled_at).getTime() <= Date.now();
const blankPost = (at?: string | null): MkPost => ({
  id: "", title: "", body: "", variants: {}, networks: ["linkedin"], media: [], link_url: null, status: at ? "scheduled" : "draft",
  scheduled_at: at ?? null, published_at: null, results: {}, series: null, source: "manual", created_at: "", updated_at: "",
});
async function savePostRow(p: Partial<MkPost>, id?: string | null): Promise<{ id: string | null; error: string | null }> {
  const row: Record<string, unknown> = { ...p, updated_at: new Date().toISOString() };
  delete row.id; delete row.created_at;
  const res: any = id
    ? await supabase.from("marketing_posts").update(row).eq("id", id).select("id").maybeSingle()
    : await supabase.from("marketing_posts").insert(row).select("id").single();
  if (res.error) return { id: null, error: MK_MISSING.test(res.error.message) ? "Run 64_marketing_hub.sql in Supabase to save posts." : res.error.message };
  return { id: id ?? (res.data as any)?.id ?? null, error: null };
}
/** Local date + time → ISO. */
const atISO = (d: string, t: string) => new Date(`${d}T${t || "09:00"}:00`).toISOString();
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hhmm = (iso: string | null | undefined) => (iso ? new Date(iso).toTimeString().slice(0, 5) : "");
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const fmtPct = (a: number, b: number) => (b > 0 ? `${pct(a, b).toLocaleString("es-ES")}%` : "—");

/** A small CSV reader: quotes, commas or semicolons, line breaks inside quotes. */
function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : (first.includes("\t") ? "\t" : ",");
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** The network mark: its colour and a short label. */
function NetBadge({ n, size = "md", off = false }: { n: Net; size?: "sm" | "md" | "lg"; off?: boolean }) {
  const m = NETS[n];
  return <i className={`mkh-net is-${size} ${off ? "is-off" : ""}`} style={{ ["--n" as string]: m.color } as CSSProperties} title={m.label} aria-label={m.label}>{m.short}</i>;
}

/* ---------- data ---------- */
async function mkAll<T = any>(table: string, cols = "*", filter?: (q: any) => any, orderBy: string[] = ["id"]): Promise<{ rows: T[]; missing: boolean }> {
  try {
    const rows = await pagedAll<T>((count) => {
      let q = supabase.from(table).select(cols, count ? { count: "exact" } : undefined);
      if (filter) q = filter(q);
      orderBy.forEach((o) => { q = q.order(o); });
      return q;
    }, true);
    return { rows, missing: false };
  } catch (e: any) {
    return { rows: [], missing: MK_MISSING.test(String(e?.message ?? e)) };
  }
}
interface MkWorld { contacts: Contact[]; companies: Company[]; contactFields: ContactField[]; trackings: Tracking[]; extra: ExportExtra; touch?: LastTouch }
async function loadMarketingWorld(): Promise<MkWorld> {
  const [ct, links, cos, cf, w] = await Promise.all([
    mkAll<any>("contacts"), mkAll<any>("company_contacts", "contact_id, company_id"), mkAll<any>("companies"),
    listContactFields().catch(() => [] as ContactField[]), loadExportWorld(),
  ]);
  const by: Record<string, string[]> = {};
  links.rows.forEach((l: any) => { (by[l.contact_id] ??= []).push(l.company_id); });
  const contacts = ct.rows.map((r: any) => ({ ...r, companyIds: by[r.id] ?? [] })) as Contact[];
  const touch = await loadLastTouch(contacts, w.trackings).catch(() => undefined);
  return {
    contacts,
    companies: (cos.rows as Company[]).sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""))),
    contactFields: cf, trackings: w.trackings, extra: w.extra, touch,
  };
}

/**
 * When we were last in touch with each contact and company — whatever recorded it:
 *  • meetings (calendar): with the contact, with the company, or on one of its deals
 *  • calendar blocks linked to a contact or a company (a call, a follow-up…)
 *  • e-mails in the synced mailboxes, sent to or received from the contact
 *  • contacts logged on a client (Clients → Last contacted), matched by the person's name
 * Only what already happened counts. Campaign e-mails are kept apart (Last campaign e-mail).
 */
async function loadLastTouch(contacts: Contact[], deals: Tracking[]): Promise<LastTouch> {
  const now = Date.now() + 60_000;
  const contact: Record<string, string> = {}, company: Record<string, string> = {}, campaign: Record<string, string> = {};
  const contactHow: Record<string, string> = {}, companyHow: Record<string, string> = {};
  const put = (m: Record<string, string>, hm: Record<string, string>, id: string | null | undefined, at: string | null | undefined, how: string) => {
    if (!id || !at) return;
    const t = new Date(at).getTime();
    if (!Number.isFinite(t) || t > now) return;
    const iso = new Date(t).toISOString();
    if (!m[id] || iso > m[id]) { m[id] = iso; hm[id] = how; }
  };
  const touchContact = (id: string | null | undefined, at: string | null | undefined, how: string) => {
    put(contact, contactHow, id, at, how);
    const c = id ? byId.get(id) : null;
    (c?.companyIds ?? []).forEach((co) => put(company, companyHow, co, at, how));
  };
  const byId = new Map(contacts.map((c) => [c.id as string, c]));
  const byMail = new Map<string, string>();
  contacts.forEach((c) => { const e = String(c.email ?? "").trim().toLowerCase(); if (e && !byMail.has(e)) byMail.set(e, c.id as string); });
  const byName = new Map<string, string[]>();
  contacts.forEach((c) => { const n = norm(fullName(c)); if (n) byName.set(n, [...(byName.get(n) ?? []), c.id as string]); });
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const hm = (min: any) => { const n = Number(min) || 0; return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`; };
  const safe = async <T,>(p: Promise<{ rows: T[] }>) => (await p.catch(() => ({ rows: [] as T[] }))).rows;

  const [ce, mc, mail, log, cl, ms] = await Promise.all([
    safe(mkAll<any>("calendar_entries", "id, kind, entry_date, start_min, company_id, contact_id, tracking_id", (q) => q.or("company_id.not.is.null,contact_id.not.is.null,tracking_id.not.is.null"))),
    safe(mkAll<any>("meeting_contacts", "meeting_id, contact_id", undefined, ["meeting_id", "contact_id"])),
    safe(mkAll<any>("ticket_mail_messages", "direction, from_email, to_recipients, received_at")),
    safe(mkAll<any>("client_contacts_log", "client_id, contacted_at, contact_name, channel")),
    safe(mkAll<any>("clients", "id, company_id")),
    safe(mkAll<any>("marketing_sends", "contact_id, sent_at, status", (q) => q.eq("status", "sent"))),
  ]);

  // calendar: meetings and linked blocks
  const atOf = new Map<string, string>();
  ce.forEach((e: any) => {
    if (!e.entry_date) return;
    const at = `${e.entry_date}T${hm(e.start_min)}:00`;
    atOf.set(e.id, at);
    const how = e.kind === "meeting" ? "meeting" : "call / follow-up";
    if (e.contact_id) touchContact(e.contact_id, at, how);
    if (e.company_id) put(company, companyHow, e.company_id, at, how);
    const d = e.tracking_id ? dealById.get(e.tracking_id) : null;
    if (d && e.kind === "meeting") put(company, companyHow, d.company_id, at, "meeting");
  });
  mc.forEach((m: any) => touchContact(m.contact_id, atOf.get(m.meeting_id), "meeting"));

  // e-mails in the synced mailboxes
  mail.forEach((m: any) => {
    if (m.direction === "in") { const id = byMail.get(String(m.from_email ?? "").trim().toLowerCase()); touchContact(id, m.received_at, "e-mail"); return; }
    (Array.isArray(m.to_recipients) ? m.to_recipients : []).forEach((r: any) => { const id = byMail.get(String(r?.email ?? r ?? "").trim().toLowerCase()); touchContact(id, m.received_at, "e-mail"); });
  });

  // contacts logged on a client
  const clientCo = new Map(cl.map((c: any) => [c.id, c.company_id]));
  log.forEach((l: any) => {
    const co = clientCo.get(l.client_id);
    const how = String(l.channel ?? "").toLowerCase() || "logged contact";
    if (co) put(company, companyHow, co, l.contacted_at, how);
    const ids = byName.get(norm(l.contact_name)) ?? [];
    // the person with that name at that company (or the only one with that name)
    const pick = ids.find((id) => !co || (byId.get(id)?.companyIds ?? []).includes(co)) ?? (ids.length === 1 ? ids[0] : null);
    if (pick) put(contact, contactHow, pick, l.contacted_at, how);
  });

  // campaign e-mails (kept apart)
  ms.forEach((s: any) => { if (s.contact_id && s.sent_at && (!campaign[s.contact_id] || s.sent_at > campaign[s.contact_id])) campaign[s.contact_id] = s.sent_at; });
  return { contact, company, campaign, contactHow, companyHow };
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
      lastTouch: w.touch,
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
type MhTab = "overview" | "email" | "social" | "calendar" | "audiences";
interface CampAgg { total: number; sent: number; failed: number; opened: number; clicked: number; replied: number; bounced: number; unsub: number }
const blankAgg = (): CampAgg => ({ total: 0, sent: 0, failed: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, unsub: 0 });
/** One line per recipient, light: what each campaign got (opens, clicks…). Before 64_marketing_hub.sql only the status. */
async function loadSendAgg(): Promise<{ by: Map<string, CampAgg>; tracked: boolean }> {
  let tracked = true;
  let r = await mkAll<any>("marketing_sends", "campaign_id, status, opened_at, clicked_at, replied_at, bounced_at, unsubscribed_at");
  if (!r.rows.length) {
    const probe = await supabase.from("marketing_sends").select("opened_at").limit(1);
    if (probe.error) { tracked = false; r = await mkAll<any>("marketing_sends", "campaign_id, status"); }
  }
  const by = new Map<string, CampAgg>();
  r.rows.forEach((s: any) => {
    if (s.status === "skipped") return;
    const a = by.get(s.campaign_id) ?? blankAgg();
    a.total++;
    if (s.status === "sent") a.sent++;
    if (s.status === "failed") a.failed++;
    if (s.opened_at) a.opened++;
    if (s.clicked_at) a.clicked++;
    if (s.replied_at) a.replied++;
    if (s.bounced_at) a.bounced++;
    if (s.unsubscribed_at) a.unsub++;
    by.set(s.campaign_id, a);
  });
  return { by, tracked };
}

export function MarketingPage() {
  const [w, setW] = useState<MkWorld | null>(null);
  const eng = useMkEngine(w);
  const [tab, setTab] = useState<MhTab>("overview");
  const [missing, setMissing] = useState(false);
  const [hubMissing, setHubMissing] = useState(false);
  const [lists, setLists] = useState<MkList[]>([]);
  const [members, setMembers] = useState<Map<string, string[]>>(new Map());
  const [campaigns, setCampaigns] = useState<MkCampaign[]>([]);
  const [unsubs, setUnsubs] = useState<MkUnsub[]>([]);
  const [posts, setPosts] = useState<MkPost[]>([]);
  const [accounts, setAccounts] = useState<MkAccount[]>([]);
  const [agg, setAgg] = useState<{ by: Map<string, CampAgg>; tracked: boolean }>({ by: new Map(), tracked: true });
  const [me, setMe] = useState<{ id: string | null; email: string; company: string }>({ id: null, email: "", company: "" });
  // what is open: a campaign (id or "new"), a post (editor), a dialog
  const [camp, setCamp] = useState<{ id: string | "new"; brief?: string } | null>(null);
  const [post, setPost] = useState<MkPost | null>(null);
  const [dialog, setDialog] = useState<null | { k: "ai"; brief?: string } | { k: "import" } | { k: "publish"; p: MkPost }>(null);
  const [toast, setToast] = useState<string | null>(null);
  const tracking = useTrackingReady();

  const reloadMk = async () => {
    const [l, m, c, u, p, a, g] = await Promise.all([
      mkAll<MkList>("marketing_lists", "*", (q) => q.order("updated_at", { ascending: false })),
      mkAll<any>("marketing_list_members", "list_id, contact_id, company_id"),
      mkAll<MkCampaign>("marketing_campaigns", "*", (q) => q.order("created_at", { ascending: false })),
      mkAll<MkUnsub>("marketing_unsubscribes", "*", (q) => q.order("created_at", { ascending: false })),
      mkAll<MkPost>("marketing_posts", "*", (q) => q.order("scheduled_at", { ascending: true, nullsFirst: false })),
      mkAll<MkAccount>("marketing_social_accounts", "*", (q) => q.order("created_at")),
      loadSendAgg(),
    ]);
    setMissing(l.missing || c.missing);
    setHubMissing(p.missing || !g.tracked);
    setLists(l.rows.map((x) => ({ ...x, definition: { ...emptyDef(), ...(x.definition ?? {}) } })));
    const mm = new Map<string, string[]>();
    m.rows.forEach((r: any) => { const arr = mm.get(r.list_id) ?? []; arr.push(r.contact_id ?? r.company_id); mm.set(r.list_id, arr); });
    setMembers(mm);
    setCampaigns(c.rows.map((x) => ({ ...x, stats: x.stats ?? {} })));
    setUnsubs(u.rows);
    setPosts(p.rows.map((x) => ({ ...x, variants: x.variants ?? {}, networks: (x.networks ?? []) as Net[], media: x.media ?? [], results: x.results ?? {} })));
    setAccounts(a.rows);
    setAgg(g);
  };
  useEffect(() => {
    loadMarketingWorld().then(setW).catch(() => setW({ contacts: [], companies: [], contactFields: [], trackings: [], extra: {} as any }));
    void reloadMk();
    supabase.auth.getUser().then(async ({ data }: any) => {
      const id = data?.user?.id ?? null;
      let company = "";
      try { const t = await supabase.from("proposal_templates").select("brand").eq("is_default", true).maybeSingle(); company = (t.data as any)?.brand?.company ?? ""; } catch { /* optional */ }
      setMe({ id, email: data?.user?.email ?? "", company });
    });
  }, []);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 3200); return () => window.clearTimeout(t); }, [toast]);

  const optOut = useMemo(() => new Set(unsubs.map((u) => u.email.toLowerCase())), [unsubs]);
  const runner = useCampaignRunner({ campaigns, eng, w, lists, members, optOut, me, onChange: reloadMk });
  const due = posts.filter(isDue);
  const go = (t: MhTab) => { setCamp(null); setTab(t); };
  const newPostAt = (d?: string) => setPost(blankPost(d ? atISO(d, "09:00") : null));
  const ctx: HubCtx = {
    w: w!, eng: eng!, lists, members, optOut, campaigns, unsubs, posts, accounts, agg, me, missing, hubMissing, tracking, runner,
    reload: reloadMk, openCampaign: (id, brief) => { setTab("email"); setCamp({ id, brief }); }, openPost: (p) => setPost(p), newPostAt,
    openAi: (brief) => setDialog({ k: "ai", brief }), openImport: () => setDialog({ k: "import" }), publish: (p) => setDialog({ k: "publish", p }), go, toast: setToast,
  };

  return (
    <div className="mk mkh">
      <header className="mkh-bar">
        <div className="mkh-bar-id">
          <span className="mkh-bar-ico">{MkIco.megaphone}</span>
          <h1>Marketing</h1>
        </div>
        <MkSeg dark value={tab} onChange={go}
          options={[
            { value: "overview", label: "Overview" },
            { value: "email", label: <>{MkIco.mail}E-mail</>, count: campaigns.length || undefined },
            { value: "social", label: <>{MhIco.social}Social</>, count: posts.length || undefined },
            { value: "calendar", label: <>{MhIco.cal}Calendar</> },
            { value: "audiences", label: <>{MkIco.people}Audiences</>, count: lists.length || undefined },
          ]} />
        <span className="mk-grow" />
        {runner.running && <button className="mkh-live" onClick={() => { const c = campaigns.find((x) => x.id === runner.running); if (c) ctx.openCampaign(c.id); }}><i className="mk-pulse" />Sending</button>}
        {due.length > 0 && <button className="mkh-due" onClick={() => go("social")}>{MhIco.bell}{due.length} ready to publish</button>}
        <ActionsMenu items={([
          ["mail", MkIco.mail, "E-mail campaign", "Write it, pick a list, track who opens", "green", "M", () => ctx.openCampaign("new")],
          ["post", MhIco.social, "Social post", "LinkedIn, Instagram, X… with previews", "blue", "S", () => newPostAt()],
          ["ai", MhIco.spark, "Plan posts with AI", "A series of posts from one brief", "violet", "A", () => ctx.openAi()],
          ["import", MhIco.upload, "Import posts", "A CSV with dates, networks and texts", "amber", "I", () => ctx.openImport()],
          ["list", MkIco.list, "Audience list", "Who to reach, by any field", "slate", "L", () => go("audiences")],
        ] as [string, React.ReactNode, string, string, ActionItem["tone"], string, () => void][]).map(([key, icon, label, hint, tone, shortcut, onSelect]) => ({ key, group: "Marketing", icon, label, hint, tone, shortcut, onSelect }))} />
      </header>

      {(missing || hubMissing) && <MhSetup missing={missing} hubMissing={hubMissing} />}
      {runner.banner && <div className={`mk-banner ${runner.banner.tone === "warn" ? "is-warn" : "is-live"}`}>{runner.banner.tone !== "warn" && <i className="mk-pulse" />}{runner.banner.text}</div>}

      <main className="mkh-body" key={`${tab}${camp ? `:${camp.id}` : ""}`}>
        {!w || !eng ? <MkLoading /> : tab === "overview" ? <Overview x={ctx} />
          : tab === "email" ? (camp ? <CampaignView x={ctx} id={camp.id} brief={camp.brief} onBack={() => setCamp(null)} onOpen={(id) => setCamp({ id })} /> : <EmailTab x={ctx} />)
          : tab === "social" ? <SocialTab x={ctx} />
          : tab === "calendar" ? <CalendarTab x={ctx} />
          : <AudiencesTab x={ctx} />}
      </main>

      {post && w && <PostEditor x={ctx} post={post} onClose={() => setPost(null)} />}
      {dialog?.k === "ai" && <AiSeries x={ctx} brief={dialog.brief} onClose={() => setDialog(null)} />}
      {dialog?.k === "import" && <ImportPosts x={ctx} onClose={() => setDialog(null)} />}
      {dialog?.k === "publish" && <PublishDialog x={ctx} p={dialog.p} onClose={() => setDialog(null)} />}
      {toast && <div className="mkh-toast" role="status">{MkIco.check}{toast}</div>}
    </div>
  );
}

interface HubCtx {
  w: MkWorld; eng: MkEngine; lists: MkList[]; members: Map<string, string[]>; optOut: Set<string>; campaigns: MkCampaign[]; unsubs: MkUnsub[];
  posts: MkPost[]; accounts: MkAccount[]; agg: { by: Map<string, CampAgg>; tracked: boolean }; me: { id: string | null; email: string; company: string };
  missing: boolean; hubMissing: boolean; tracking: boolean | null; runner: Runner;
  reload: () => Promise<void>; openCampaign: (id: string | "new", brief?: string) => void; openPost: (p: MkPost) => void; newPostAt: (d?: string) => void;
  openAi: (brief?: string) => void; openImport: () => void; publish: (p: MkPost) => void; go: (t: MhTab) => void; toast: (s: string) => void;
}

const MhIco = {
  social: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="12" r="2.6" /><circle cx="18" cy="6" r="2.6" /><circle cx="18" cy="18" r="2.6" /><path d="M8.3 10.8l7.4-3.6M8.3 13.2l7.4 3.6" /></svg>,
  cal: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="3" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /></svg>,
  spark: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>,
  upload: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>,
  bell: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 21h4" /></svg>,
  eye: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></svg>,
  click: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M9 9l11 4-4.6 1.6L13.8 19z" /><path d="M5 3v3M3 5h3M9 3.5L8 5.5M3.5 9l2-1" /></svg>,
  reply: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M10 7L4 12l6 5" /><path d="M4 12h10a6 6 0 0 1 6 6v1" /></svg>,
  bounce: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6M15 15l4 4M19 15l-4 4" /></svg>,
  edit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>,
  image: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5-5-9 9" /></svg>,
  link: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></svg>,
  ext: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  grip: <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="7" r="1.4" /><circle cx="15" cy="7" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="17" r="1.4" /><circle cx="15" cy="17" r="1.4" /></svg>,
};

function MhSetup({ missing, hubMissing }: { missing: boolean; hubMissing: boolean }) {
  return (
    <div className="mk-setup">
      <span className="mk-setup-ico">{MkIco.db}</span>
      <div className="mk-setup-txt">
        <b>{missing ? "Two SQL files switch Marketing on" : "One SQL file switches the new Marketing on"}</b>
        <p>Run {missing && <><code>20_marketing.sql</code> and then </>}<code>64_marketing_hub.sql</code> in Supabase (SQL editor) for {missing ? "lists, campaigns, " : ""}social posts and open / click tracking. {hubMissing && !missing && "E-mail campaigns keep working meanwhile."}</p>
      </div>
    </div>
  );
}

/** A centred dialog over the page. */
function MhModal({ title, sub, onClose, children, foot, wide = false, cls = "" }: { title: React.ReactNode; sub?: React.ReactNode; onClose: () => void; children: React.ReactNode; foot?: React.ReactNode; wide?: boolean; cls?: string }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return createPortal(
    <div className="mkh-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`mkh-modal ${wide ? "is-wide" : ""} ${cls}`} role="dialog" aria-modal="true">
        <header className="mkh-modal-h">
          <div><h2>{title}</h2>{sub && <p>{sub}</p>}</div>
          <button className="mkh-x" onClick={onClose} aria-label="Close">{MhIco.x}</button>
        </header>
        <div className="mkh-modal-body">{children}</div>
        {foot && <footer className="mkh-modal-f">{foot}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* ═══════════════════════════ Overview ═══════════════════════════ */
function Overview({ x }: { x: HubCtx }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() + i); return d; });
  type Item = { key: string; when: Date; kind: "post" | "email"; title: string; nets: Net[]; status: string; open: () => void };
  const items: Item[] = [
    ...x.posts.filter((p) => postWhen(p) && p.status !== "cancelled").map((p) => ({ key: p.id, when: new Date(postWhen(p)!), kind: "post" as const, title: p.title || p.body.slice(0, 60) || "Untitled post", nets: p.networks, status: p.status, open: () => x.openPost(p) })),
    ...x.campaigns.filter((c) => c.scheduled_at || c.started_at).map((c) => ({ key: c.id, when: new Date(c.status === "scheduled" ? c.scheduled_at! : c.started_at ?? c.scheduled_at!), kind: "email" as const, title: c.name, nets: [] as Net[], status: c.status, open: () => x.openCampaign(c.id) })),
  ];
  const byDay = new Map<string, Item[]>();
  items.forEach((it) => { const k = dayKey(it.when); const a = byDay.get(k) ?? []; a.push(it); byDay.set(k, a); });
  byDay.forEach((a) => a.sort((p, q) => p.when.getTime() - q.when.getTime()));
  const upcoming = days.reduce((s, d) => s + (byDay.get(dayKey(d))?.length ?? 0), 0);

  // e-mail: the last 90 days
  const since = Date.now() - 90 * 864e5;
  const recent = x.campaigns.filter((c) => c.started_at && new Date(c.started_at).getTime() >= since);
  const tot = recent.reduce((a, c) => { const g = x.agg.by.get(c.id) ?? blankAgg(); (Object.keys(a) as (keyof CampAgg)[]).forEach((k) => { a[k] += g[k]; }); return a; }, blankAgg());
  const funnel = [
    { k: "Sent", v: tot.sent, ico: MkIco.send, of: tot.sent },
    { k: "Opened", v: tot.opened, ico: MhIco.eye, of: tot.sent },
    { k: "Clicked", v: tot.clicked, ico: MhIco.click, of: tot.sent },
    { k: "Replied", v: tot.replied, ico: MhIco.reply, of: tot.sent },
  ];
  // social: this month
  const m0 = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const pub = x.posts.filter((p) => p.status === "published" && p.published_at && new Date(p.published_at).getTime() >= m0);
  const eng = x.posts.filter((p) => p.status === "published").reduce((a, p) => { Object.values(p.results ?? {}).forEach((r) => { a.imp += r.impressions ?? 0; a.react += (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0); a.clk += r.clicks ?? 0; }); return a; }, { imp: 0, react: 0, clk: 0 });
  const perNet = NET_KEYS.map((n) => ({ n, v: x.posts.filter((p) => p.networks.includes(n) && p.status !== "cancelled").length })).filter((r) => r.v > 0);
  const maxNet = Math.max(1, ...perNet.map((r) => r.v));
  const reachable = useMemo(() => {
    const seen = new Set<string>();
    x.w.contacts.forEach((c: any) => { const e = String(c.email ?? "").trim().toLowerCase(); if (EMAIL_RE.test(e) && !c.marketing_opt_out && !x.optOut.has(e)) seen.add(e); });
    return seen.size;
  }, [x.w, x.optOut]);
  const [brief, setBrief] = useState("");
  const recentAll = [
    ...x.campaigns.map((c) => ({ key: `c${c.id}`, at: c.updated_at, kind: "email" as const, name: c.name, sub: c.subject, status: STATUS_LABEL[c.status], st: c.status, open: () => x.openCampaign(c.id), nets: [] as Net[] })),
    ...x.posts.map((p) => ({ key: `p${p.id}`, at: p.updated_at, kind: "post" as const, name: p.title || p.body.slice(0, 50) || "Untitled post", sub: p.body.slice(0, 90), status: POST_STATUS[p.status], st: p.status, open: () => x.openPost(p), nets: p.networks })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);

  return (
    <div className="mkh-ov">
      <section className="mkh-lane-card">
        <div className="mkh-sec-h">
          <h2>Coming up</h2>
          <em>{upcoming ? `${upcoming} planned in the next two weeks` : "Nothing planned in the next two weeks"}</em>
          <span className="mk-grow" />
          <button className="mk-linkbtn" onClick={() => x.go("calendar")}>Open the calendar</button>
        </div>
        <div className="mkh-lane" role="list">
          {days.map((d, i) => {
            const k = dayKey(d);
            const its = byDay.get(k) ?? [];
            const we = d.getDay() === 0 || d.getDay() === 6;
            return (
              <div key={k} role="listitem" className={`mkh-day ${i === 0 ? "is-today" : ""} ${we ? "is-we" : ""} ${its.length ? "has" : ""}`}>
                <span className="mkh-day-h"><em>{d.toLocaleDateString("en-GB", { weekday: "short" })}</em><b>{d.getDate()}</b></span>
                <div className="mkh-day-items">
                  {its.slice(0, 4).map((it) => (
                    <button key={it.key} className={`mkh-chip is-${it.kind} is-${it.status}`} onClick={it.open} title={it.title}
                      style={{ ["--n" as string]: it.kind === "email" ? "#12b57f" : NETS[it.nets[0] ?? "linkedin"].color } as CSSProperties}>
                      <span className="mkh-chip-t">{hhmm(it.when.toISOString())}</span>
                      <span className="mkh-chip-n">{it.title}</span>
                      <span className="mkh-chip-m">{it.kind === "email" ? <i className="mkh-chip-mail">{MkIco.mail}</i> : <>{it.nets.slice(0, 2).map((n) => <NetBadge key={n} n={n} size="sm" />)}{it.nets.length > 2 && <small>+{it.nets.length - 2}</small>}</>}</span>
                    </button>
                  ))}
                  {its.length > 4 && <button className="mkh-more" onClick={() => x.go("calendar")}>+{its.length - 4} more</button>}
                </div>
                <button className="mkh-day-add" onClick={() => x.newPostAt(k)} aria-label={`New post on ${d.toLocaleDateString("en-GB")}`}>{MkIco.plus}</button>
              </div>
            );
          })}
        </div>
      </section>

      <div className="mkh-ov-grid">
        <section className="mkh-panel mkh-funnel">
          <div className="mkh-sec-h"><h2>E-mail, last 90 days</h2><em>{recent.length} campaign{recent.length === 1 ? "" : "s"}</em><span className="mk-grow" /><button className="mk-linkbtn" onClick={() => x.go("email")}>All campaigns</button></div>
          {tot.sent === 0 ? (
            <div className="mkh-empty-in">
              <p>No campaigns sent recently. Opens, clicks and replies of each person show up here once one goes out.</p>
              <button className="mk-btn is-primary" onClick={() => x.openCampaign("new")} disabled={x.missing}>{MkIco.plus}New e-mail</button>
            </div>
          ) : (
            <>
              <div className="mkh-fun">
                {funnel.map((f, i) => (
                  <div key={f.k} className={`mkh-fun-step is-${i}`} style={{ ["--w" as string]: `${f.of ? Math.max(6, (f.v / f.of) * 100) : 0}%` } as CSSProperties}>
                    <span className="mkh-fun-ico">{f.ico}</span>
                    <span className="mkh-fun-k">{f.k}</span>
                    <b>{fmtN(f.v)}</b>
                    <em>{i === 0 ? "delivered to the server" : fmtPct(f.v, f.of)}</em>
                    <i className="mkh-fun-bar"><i /></i>
                  </div>
                ))}
              </div>
              <p className="mkh-fine">{tot.bounced ? `${fmtN(tot.bounced)} bounced · ` : ""}{tot.unsub ? `${fmtN(tot.unsub)} unsubscribed · ` : ""}{x.agg.tracked ? "Opens count when the pictures of the e-mail load; some mail apps block them, so the real figure is higher." : "Run 64_marketing_hub.sql to see opens, clicks and replies."}</p>
            </>
          )}
        </section>

        <section className="mkh-panel mkh-studio">
          <div className="mkh-studio-h"><span className="mkh-studio-ico">{MhIco.spark}</span><div><h2>Write with AI</h2><em>Say what you want to tell people — get an e-mail or a series of posts to review.</em></div></div>
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4}
            placeholder="e.g. We've launched consolidated reporting in Power BI. Invite CFOs to a 30-minute demo in November; link to the sign-up page." />
          <div className="mkh-studio-acts">
            <button className="mk-btn" disabled={!brief.trim() || x.missing} onClick={() => x.openCampaign("new", brief.trim())}>{MkIco.mail}Write an e-mail</button>
            <button className="mk-btn is-primary" disabled={!brief.trim()} onClick={() => x.openAi(brief.trim())}>{MhIco.social}Plan posts</button>
          </div>
        </section>

        <section className="mkh-panel mkh-soc">
          <div className="mkh-sec-h"><h2>Social</h2><em>{pub.length} published this month</em><span className="mk-grow" /><button className="mk-linkbtn" onClick={() => x.go("social")}>All posts</button></div>
          <div className="mkh-soc-nums">
            <span><b>{fmtN(x.posts.filter((p) => p.status === "scheduled").length)}</b><em>scheduled</em></span>
            <span><b>{fmtN(x.posts.filter((p) => p.status === "draft" || p.status === "idea").length)}</b><em>drafts &amp; ideas</em></span>
            <span><b>{fmtN(eng.imp)}</b><em>impressions</em></span>
            <span><b>{fmtN(eng.react)}</b><em>reactions</em></span>
          </div>
          {perNet.length ? (
            <div className="mkh-soc-bars">
              {perNet.map((r) => (
                <div key={r.n} className="mkh-soc-bar" style={{ ["--n" as string]: NETS[r.n].color, ["--w" as string]: `${(r.v / maxNet) * 100}%` } as CSSProperties}>
                  <NetBadge n={r.n} size="sm" /><span>{NETS[r.n].label}</span><i><i /></i><b>{r.v}</b>
                </div>
              ))}
            </div>
          ) : <p className="mkh-fine">No posts yet. Plan a few with AI or import them from a spreadsheet.</p>}
        </section>

        <section className="mkh-panel mkh-aud">
          <div className="mkh-sec-h"><h2>Audience</h2><span className="mk-grow" /><button className="mk-linkbtn" onClick={() => x.go("audiences")}>Lists</button></div>
          <div className="mkh-aud-big"><b>{fmtN(reachable)}</b><em>contacts you can e-mail — valid address and not unsubscribed</em></div>
          <div className="mkh-aud-row"><span><b>{x.lists.length}</b> saved list{x.lists.length === 1 ? "" : "s"}</span><span><b>{x.unsubs.length}</b> do not contact</span></div>
        </section>

        <section className="mkh-panel mkh-recent">
          <div className="mkh-sec-h"><h2>Recently worked on</h2></div>
          {recentAll.length ? recentAll.map((r) => (
            <button key={r.key} className="mkh-rrow" onClick={r.open}>
              <span className={`mkh-rrow-ico is-${r.kind}`}>{r.kind === "email" ? MkIco.mail : MhIco.social}</span>
              <span className="mkh-rrow-t"><b>{r.name}</b><em>{r.sub || "—"}</em></span>
              {r.nets.length > 0 && <span className="mkh-nets">{r.nets.map((n) => <NetBadge key={n} n={n} size="sm" />)}</span>}
              <span className={`mkh-st is-${r.st}`}>{r.status}</span>
            </button>
          )) : <p className="mkh-fine">Nothing yet — start with Create.</p>}
        </section>
      </div>
    </div>
  );
}

/* ═══════════════════════════ E-mail ═══════════════════════════ */
function EmailTab({ x }: { x: HubCtx }) {
  const [st, setSt] = useState<"all" | "active" | "draft" | "done">("all");
  const [q, setQ] = useState("");
  const group = (c: MkCampaign) => (c.status === "sending" || c.status === "paused" || c.status === "scheduled" ? "active" : c.status === "draft" ? "draft" : "done");
  const nBy = (g: string) => x.campaigns.filter((c) => group(c) === g).length;
  const nq = norm(q);
  const shown = x.campaigns.filter((c) => (st === "all" || group(c) === st) && (!nq || norm(`${c.name} ${c.subject}`).includes(nq)));
  if (!x.campaigns.length) {
    return (
      <div className="mk-empty">
        <div className="mk-empty-art" aria-hidden="true"><span className="is-a">{MkIco.mail}</span><span className="is-b">{MhIco.eye}</span><span className="is-c">{MhIco.reply}</span></div>
        <h3>Send your first campaign</h3>
        <p>{x.lists.length ? "Pick a list, write the e-mail (or let AI draft it), send yourself a test and go. You'll see who opens, clicks and replies." : "First save a list of the people you want to reach, then write the e-mail here."}</p>
        <div className="mk-empty-acts">
          {x.lists.length
            ? <button className="mk-btn is-primary is-big" onClick={() => x.openCampaign("new")} disabled={x.missing}>{MkIco.plus}New e-mail</button>
            : <button className="mk-btn is-primary is-big" onClick={() => x.go("audiences")}>{MkIco.list}Build a list</button>}
        </div>
      </div>
    );
  }
  return (
    <div className="mkh-email">
      <div className="mkh-toolbar">
        <MkSeg size="sm" value={st} onChange={setSt}
          options={[{ value: "all", label: "All", count: x.campaigns.length }, { value: "active", label: "In progress", count: nBy("active") }, { value: "draft", label: "Drafts", count: nBy("draft") }, { value: "done", label: "Sent", count: nBy("done") }]} />
        <label className="mk-search">{MkIco.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a campaign" /></label>
        <span className="mk-grow" />
        <button className="mk-btn is-primary" onClick={() => x.openCampaign("new")} disabled={x.missing}>{MkIco.plus}New e-mail</button>
      </div>
      <div className="mkh-table">
        <div className="mkh-thead mkh-erow">
          <span>Campaign</span><span>Audience</span><span>Status</span><span className="is-num">Sent</span><span className="is-num">Opened</span><span className="is-num">Clicked</span><span className="is-num">Replied</span>
        </div>
        {shown.map((c) => {
          const g = x.agg.by.get(c.id) ?? blankAgg();
          const l = x.lists.find((y) => y.id === c.list_id);
          const sentish = g.sent || c.stats.sent || 0;
          const prog = g.total ? (g.sent + g.failed) / g.total : 0;
          return (
            <button key={c.id} className={`mkh-erow mkh-tr is-${c.status}`} onClick={() => x.openCampaign(c.id)}>
              <span className="mkh-erow-name"><b>{c.name}</b><em>{c.subject || "No subject yet"}</em></span>
              <span className="mkh-erow-aud">{l ? <>{l.entity === "companies" ? MkIco.building : MkIco.people}{l.name}</> : <em>No list</em>}</span>
              <span className="mkh-erow-st">
                <span className={`mk-status is-${c.status}`}>{c.status === "sending" && x.runner.running === c.id && <i className="mk-pulse" />}{STATUS_LABEL[c.status]}</span>
                <em>{c.status === "scheduled" ? fmtWhen(c.scheduled_at) : c.status === "draft" ? `edited ${fmtWhen(c.updated_at)}` : fmtWhen(c.finished_at ?? c.started_at)}</em>
                {(c.status === "sending" || c.status === "paused") && <i className="mkh-mini"><i style={{ width: `${prog * 100}%` }} /></i>}
              </span>
              <span className="is-num"><b>{sentish ? fmtN(sentish) : "—"}</b></span>
              <span className="is-num"><b>{sentish ? fmtPct(g.opened, sentish) : "—"}</b>{g.opened > 0 && <em>{fmtN(g.opened)}</em>}</span>
              <span className="is-num"><b>{sentish ? fmtPct(g.clicked, sentish) : "—"}</b>{g.clicked > 0 && <em>{fmtN(g.clicked)}</em>}</span>
              <span className="is-num"><b>{g.replied ? fmtN(g.replied) : "—"}</b></span>
            </button>
          );
        })}
        {!shown.length && <div className="mk-empty-sm is-wide">{MkIco.mail}<span>No campaigns here.</span></div>}
      </div>
    </div>
  );
}

function CampaignView({ x, id, brief, onBack, onOpen }: { x: HubCtx; id: string | "new"; brief?: string; onBack: () => void; onOpen: (id: string) => void }) {
  const c = id === "new" ? null : x.campaigns.find((y) => y.id === id) ?? null;
  if (id !== "new" && !c) return <MkLoading />;
  if (!c || c.status === "draft" || c.status === "scheduled") return <Composer x={x} campaign={c} brief={brief} onBack={onBack} onSaved={onOpen} />;
  return <CampaignReport x={x} c={c} onBack={onBack} onOpen={onOpen} />;
}

function Composer({ x, campaign, brief, onBack, onSaved }: { x: HubCtx; campaign: MkCampaign | null; brief?: string; onBack: () => void; onSaved: (id: string) => void }) {
  const { w, eng, lists, members, optOut, me, runner } = x;
  const init = splitBody(campaign?.body_html ?? "<p>Hola {{first_name}},</p><p></p><p>Un saludo,</p>");
  const [step, setStep] = useState<0 | 1 | 2>(campaign?.list_id ? 1 : brief ? 1 : 0);
  const [name, setName] = useState(campaign?.name ?? "");
  const [listId, setListId] = useState(campaign?.list_id ?? "");
  const [from, setFrom] = useState(campaign?.from_mailbox ?? "");
  const [replyTo, setReplyTo] = useState(campaign?.reply_to ?? "");
  const [subject, setSubject] = useState(campaign?.subject ?? "");
  const [preheader, setPreheader] = useState(campaign?.preheader ?? "");
  const [body, setBody] = useState(init.body);
  const [footer, setFooter] = useState(init.footer);
  const [trackOpens, setTrackOpens] = useState(campaign?.track_opens ?? true);
  const [trackClicks, setTrackClicks] = useState(campaign?.track_clicks ?? true);
  const [htmlMode, setHtmlMode] = useState(false);
  const [pi, setPi] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [tested, setTested] = useState(false);
  const [when, setWhen] = useState<{ d: string; t: string }>(() => {
    const at = campaign?.scheduled_at ? new Date(campaign.scheduled_at) : null;
    return at ? { d: dayKey(at), t: at.toTimeString().slice(0, 5) } : { d: "", t: "09:00" };
  });
  const [confirmSend, setConfirmSend] = useState(false);
  const [ai, setAi] = useState({ open: !!brief, brief: brief ?? campaign?.ai_brief ?? "", tone: AI_TONES[0].value, lang: "es", cta: "", link: "", busy: false, err: "", alts: [] as string[] });
  const [editorKey, setEditorKey] = useState(0);
  const editRef = useRef<HTMLDivElement | null>(null);
  const subjRef = useRef<HTMLInputElement | null>(null);
  const lastFocus = useRef<"body" | "subject">("body");
  useEffect(() => { if (editRef.current && !htmlMode && editRef.current.innerHTML !== body) editRef.current.innerHTML = body; }, [htmlMode, editorKey, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const sizes = useMemo(() => new Map(lists.map((l) => [l.id, eng.recipients(l.entity, listRecords(eng, w, l, members, l.id), l.definition?.who ?? "all", optOut)])), [lists, eng, w, members, optOut]);
  const list = lists.find((l) => l.id === listId) ?? null;
  const recs = list ? sizes.get(list.id) ?? [] : [];
  const ok = recs.filter((r) => r.state === "ok");
  const sample = ok[Math.min(pi, Math.max(0, ok.length - 1))];
  const fullBody = joinBody(body, footer);
  const fromAddr = from.trim() || me.email;
  const demo = { first_name: "Laura", last_name: "Gil", full_name: "Laura Gil", company: "Acme Iberia", position: "CFO", city: "Madrid", email: "laura@example.com" };
  const prev = buildMail({ subject, body_html: fullBody, preheader, track_opens: false, track_clicks: false }, { id: "preview", merge: sample?.merge ?? demo }, { tracking: false, from: fromAddr || "you@company.com" });
  const previewDoc = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:22px;background:#fff}a{color:#0a6f4d}</style></head><body>${prev.html}</body></html>`;

  const exec = (cmd: string, arg?: string) => { editRef.current?.focus(); document.execCommand(cmd, false, arg); setBody(editRef.current?.innerHTML ?? ""); };
  const insertField = (k: string) => {
    const tok = `{{${k}}}`;
    if (lastFocus.current === "subject" && subjRef.current) {
      const el = subjRef.current; const a = el.selectionStart ?? subject.length, b = el.selectionEnd ?? a;
      setSubject(subject.slice(0, a) + tok + subject.slice(b));
      window.setTimeout(() => { el.focus(); el.setSelectionRange(a + tok.length, a + tok.length); }, 0);
    } else if (htmlMode) setBody((v) => v + tok);
    else exec("insertText", tok);
  };
  const [linkAsk, setLinkAsk] = useState<string | null>(null);

  const row = () => ({
    name: name.trim() || subject.trim() || "Untitled campaign", list_id: listId || null, from_mailbox: from.trim() || null, reply_to: replyTo.trim() || null,
    subject, preheader: preheader.trim() || null, body_html: fullBody, track_opens: trackOpens, track_clicks: trackClicks, ai_brief: ai.brief.trim() || null,
    updated_at: new Date().toISOString(),
  });
  const persist = async (patch: Record<string, unknown> = {}): Promise<string | null> => {
    const r = await saveCampaignRow({ ...row(), ...patch }, campaign?.id);
    if (r.error) { setMsg({ tone: "err", text: r.error }); return null; }
    return r.id;
  };
  const textOf = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim();
  const checks = [
    { ok: !!list, t: list ? `${fmtN(ok.length)} people on “${list.name}” will get it` : "Choose who gets it", step: 0 as const },
    { ok: !!subject.trim(), t: subject.trim() ? "Subject written" : "Write a subject", step: 1 as const },
    { ok: !!textOf(body), t: textOf(body) ? "Message written" : "Write the message", step: 1 as const },
    { ok: /\{\{\s*unsubscribe_(url|email)\s*\}\}|mailto:|baja/i.test(footer), t: "Unsubscribe link at the bottom", step: 1 as const },
    { ok: tested, t: tested ? "Test sent to you" : "Send yourself a test (recommended)", step: 2 as const, soft: true },
  ];
  const problem = checks.find((k) => !k.ok && !k.soft);

  const runAi = async (improve: boolean) => {
    if (!ai.brief.trim() && !improve) { setAi((a) => ({ ...a, err: "Say what the e-mail is about." })); return; }
    setAi((a) => ({ ...a, busy: true, err: "" }));
    const r = await aiWrite<{ email: { subject: string; subjects_alt?: string[]; preheader?: string; body_html: string } }>({
      kind: "email", brief: ai.brief, tone: ai.tone, lang: ai.lang, cta: ai.cta, link: ai.link, company: me.company,
      audience: list ? `${list.name}${list.description ? ` — ${list.description}` : ""}` : "", fields: MERGE_FIELDS.map((m) => m.key),
      current: improve ? `Subject: ${subject}\n\n${body}` : undefined,
    });
    if (!r.ok) { setAi((a) => ({ ...a, busy: false, err: r.error })); return; }
    const e = r.data.email;
    if (!e?.body_html) { setAi((a) => ({ ...a, busy: false, err: "The AI gave no e-mail — try again." })); return; }
    setSubject(e.subject ?? subject); setPreheader(e.preheader ?? ""); setBody(e.body_html ?? body);
    setHtmlMode(false); setEditorKey((k) => k + 1);
    setAi((a) => ({ ...a, busy: false, alts: (e.subjects_alt ?? []).filter(Boolean) }));
    if (!name.trim()) setName(e.subject ?? "");
  };
  const testSend = async () => {
    if (!me.email) { setMsg({ tone: "err", text: "Your user has no e-mail to send the test to." }); return; }
    setBusy("test"); setMsg(null);
    const m = buildMail({ subject: `[Test] ${subject}`, body_html: fullBody, preheader }, { id: "test", merge: sample?.merge ?? demo }, { tracking: false, from: fromAddr });
    const res = await PROVIDER.send({ to: [me.email], subject: m.subject, html: m.html, from: from.trim() || null, replyTo: replyTo.trim() || null, ref: "campaign:test" });
    setBusy(null);
    if (res.ok) setTested(true);
    setMsg(res.ok ? { tone: "ok", text: `Test sent to ${me.email} as ${sample?.name ?? "a sample contact"}.` } : { tone: "err", text: `The test didn't go out: ${res.error}` });
  };
  const saveDraft = async () => { setBusy("save"); const id = await persist({ status: "draft", scheduled_at: null }); setBusy(null); if (id) { x.toast("Draft saved"); await x.reload(); onSaved(id); } };
  const schedule = async () => {
    if (!when.d) { setMsg({ tone: "err", text: "Pick a date." }); return; }
    const at = new Date(`${when.d}T${when.t || "09:00"}:00`);
    if (at.getTime() < Date.now()) { setMsg({ tone: "err", text: "That time has already passed." }); return; }
    setBusy("schedule"); const id = await persist({ status: "scheduled", scheduled_at: at.toISOString() }); setBusy(null);
    if (id) { x.toast(`Scheduled for ${fmtWhen(at.toISOString())}`); await x.reload(); onSaved(id); }
  };
  const sendNow = async () => {
    setBusy("send"); setConfirmSend(false);
    const id = await persist({ status: "draft" });
    if (!id) { setBusy(null); return; }
    const e = await runner.start({ ...(campaign ?? ({} as MkCampaign)), ...row(), id, status: "draft", stats: {} } as MkCampaign);
    setBusy(null);
    if (e) setMsg({ tone: "err", text: e }); else { await x.reload(); onSaved(id); }
  };

  const STEPS = ["Audience", "Message", "Review & send"];
  return (
    <section className="mkh-cmp">
      <div className="mkh-cmp-head">
        <button className="mk-back" onClick={onBack} aria-label="Back to campaigns">{MkIco.back}</button>
        <input className="mkh-cmp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this campaign (only your team sees it)" />
        {campaign?.status === "scheduled" ? <span className="mk-status is-scheduled">Scheduled · {fmtWhen(campaign.scheduled_at)}</span> : <span className="mk-status is-draft">Draft</span>}
        <span className="mk-grow" />
        <button className="mk-btn" disabled={!!busy || x.missing} onClick={() => void saveDraft()}>{busy === "save" ? "Saving…" : "Save draft"}</button>
      </div>
      <ol className="mkh-steps">
        {STEPS.map((s, i) => {
          const done = i === 0 ? !!list : i === 1 ? !!subject.trim() && !!textOf(body) : false;
          return (
            <li key={s}><button className={`${step === i ? "is-on" : ""} ${done ? "is-done" : ""}`} onClick={() => setStep(i as 0 | 1 | 2)}>
              <i>{done && step !== i ? MkIco.check : i + 1}</i><span>{s}</span>
            </button></li>
          );
        })}
      </ol>

      <div className="mkh-cmp-grid">
        <div className="mkh-cmp-main">
          {step === 0 && (
            <div className="mkh-panel">
              <div className="mkh-sec-h"><h2>Who gets it</h2><em>Pick one of your lists</em><span className="mk-grow" /><button className="mk-linkbtn" onClick={() => x.go("audiences")}>Build a new list</button></div>
              {!lists.length && <p className="mkh-fine">You have no lists yet. Build one in Audiences — by any field of your contacts, their companies or their deals.</p>}
              <div className="mkh-lpick">
                {lists.map((l) => {
                  const r = sizes.get(l.id) ?? [];
                  const n = r.filter((y) => y.state === "ok").length;
                  return (
                    <button key={l.id} className={`mkh-lopt ${listId === l.id ? "is-on" : ""}`} onClick={() => setListId(l.id)}>
                      <span className={`mk-lcard-ico is-${l.entity}`}>{l.entity === "companies" ? MkIco.building : MkIco.people}</span>
                      <span className="mkh-lopt-t"><b>{l.name}</b><em>{l.kind === "dynamic" ? "Updates itself" : "Fixed people"} · {l.entity}</em></span>
                      <span className="mkh-lopt-n"><b>{fmtN(n)}</b><em>can receive it</em></span>
                      <i className="mkh-radio" />
                    </button>
                  );
                })}
              </div>
              {list && recs.length - ok.length > 0 && <p className="mkh-fine">{fmtN(recs.length - ok.length)} left out: no e-mail, a wrong address, unsubscribed or the same address twice.</p>}
              <div className="mkh-next"><span className="mk-grow" /><button className="mk-btn is-primary" disabled={!list} onClick={() => setStep(1)}>Continue to the message{MkIco.arrow}</button></div>
            </div>
          )}

          {step === 1 && (
            <>
              <div className={`mkh-ai ${ai.open ? "is-open" : ""}`}>
                <button className="mkh-ai-h" onClick={() => setAi((a) => ({ ...a, open: !a.open }))} aria-expanded={ai.open}>
                  <span className="mkh-ai-ico">{MhIco.spark}</span><b>Write with AI</b><em>Describe it in a few lines — AI drafts the subject, the preview line and the text</em>
                  <i className="mkh-caret" />
                </button>
                {ai.open && (
                  <div className="mkh-ai-body">
                    <textarea value={ai.brief} onChange={(e) => setAi((a) => ({ ...a, brief: e.target.value }))} rows={3} placeholder="What's it about, and what should people do after reading it?" />
                    <div className="mkh-ai-opts">
                      <Select value={ai.tone} onChange={(v) => setAi((a) => ({ ...a, tone: v }))} options={AI_TONES} />
                      <Select value={ai.lang} onChange={(v) => setAi((a) => ({ ...a, lang: v }))} options={AI_LANGS} />
                      <input className="mk-input" value={ai.cta} onChange={(e) => setAi((a) => ({ ...a, cta: e.target.value }))} placeholder="Call to action, e.g. book a demo" />
                      <input className="mk-input" value={ai.link} onChange={(e) => setAi((a) => ({ ...a, link: e.target.value }))} placeholder="Link (optional)" />
                    </div>
                    <div className="mkh-ai-acts">
                      {ai.err && <span className="mk-msg is-err">{ai.err}</span>}
                      <span className="mk-grow" />
                      {textOf(body).length > 30 && <button className="mk-btn" disabled={ai.busy} onClick={() => void runAi(true)}>Improve my draft</button>}
                      <button className="mk-btn is-primary" disabled={ai.busy} onClick={() => void runAi(false)}>{ai.busy ? <><i className="mkh-spin" />Writing…</> : <>{MhIco.spark}Write it</>}</button>
                    </div>
                  </div>
                )}
              </div>

              <div className="mkh-panel mkh-env">
                <label className="mk-f"><span>Subject</span>
                  <div className="mkh-subj">
                    <input ref={subjRef} className="mk-input is-subject" value={subject} onFocus={() => { lastFocus.current = "subject"; }} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. {{first_name}}, your November close in half the time" />
                    <em className={subject.length > 70 ? "is-warn" : ""}>{subject.length}</em>
                  </div>
                </label>
                {ai.alts.length > 0 && (
                  <div className="mkh-alts"><em>Other subjects</em>{ai.alts.map((s) => <button key={s} onClick={() => setSubject(s)}>{s}</button>)}</div>
                )}
                <label className="mk-f"><span>Preview line</span><input className="mk-input" value={preheader} onChange={(e) => setPreheader(e.target.value)} placeholder="The grey text after the subject in the inbox (optional)" /></label>
                <details className="mkh-sender">
                  <summary>From <b>{fromAddr || "your mailbox"}</b>{replyTo ? <> · replies to <b>{replyTo}</b></> : ""}</summary>
                  <label className="mk-f"><span>From</span><input className="mk-input" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={me.email ? `Your mailbox (${me.email}) — or a department one, e.g. marketing@…` : "marketing@…"} /></label>
                  <label className="mk-f"><span>Reply-to</span><input className="mk-input" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="Optional — where replies should go" /></label>
                  <p className="mkh-fine">A shared mailbox needs “Send as” for your user in Microsoft 365.</p>
                </details>
              </div>

              <div className="mkh-panel mk-editorbox">
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
                      <button onMouseDown={(e) => e.preventDefault()} onClick={() => setLinkAsk("https://")} title="Link">{MhIco.link}</button>
                      {linkAsk != null && (
                        <span className="mk-linkask">
                          <input autoFocus value={linkAsk} onChange={(e) => setLinkAsk(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { exec("createLink", linkAsk); setLinkAsk(null); } if (e.key === "Escape") setLinkAsk(null); }} />
                          <button onMouseDown={(e) => e.preventDefault()} onClick={() => { exec("createLink", linkAsk); setLinkAsk(null); }}>Add</button>
                        </span>
                      )}
                      <span className="mk-tool-sep" />
                    </>
                  )}
                  <span className="mk-merge"><em>Insert</em>{MERGE_FIELDS.map((m) => <button key={m.key} onMouseDown={(e) => e.preventDefault()} onClick={() => insertField(m.key)}>{m.label}</button>)}</span>
                  <span className="mk-grow" />
                  <button className={`mk-html ${htmlMode ? "is-on" : ""}`} onClick={() => { if (!htmlMode) setBody(editRef.current?.innerHTML ?? body); setHtmlMode(!htmlMode); }}>{"</>"} HTML</button>
                </div>
                {htmlMode ? (
                  <textarea className="mk-src" value={body} onChange={(e) => setBody(e.target.value)} onFocus={() => { lastFocus.current = "body"; }} spellCheck={false} />
                ) : (
                  <div key={editorKey} ref={editRef} className="mk-rich" contentEditable suppressContentEditableWarning onFocus={() => { lastFocus.current = "body"; }}
                    onInput={(e) => setBody((e.target as HTMLDivElement).innerHTML)} />
                )}
                <div className="mk-footbox">
                  <span>Unsubscribe line <em>at the bottom of every e-mail, required by law</em></span>
                  <textarea value={footer} onChange={(e) => setFooter(e.target.value)} rows={2} />
                  {!/\{\{\s*unsubscribe_(url|email)\s*\}\}|mailto:|baja/i.test(footer) && <em className="mk-warn-t">Keep a way to unsubscribe: the {"{{unsubscribe_url}}"} link or “reply BAJA”.</em>}
                </div>
              </div>
              <div className="mkh-next"><button className="mk-btn" onClick={() => setStep(0)}>{MkIco.back}Audience</button><span className="mk-grow" /><button className="mk-btn is-primary" onClick={() => setStep(2)}>Review{MkIco.arrow}</button></div>
            </>
          )}

          {step === 2 && (
            <div className="mkh-panel mkh-review">
              <div className="mkh-sec-h"><h2>Before it goes out</h2></div>
              <ul className="mkh-checks">
                {checks.map((k) => (
                  <li key={k.t} className={k.ok ? "is-ok" : k.soft ? "is-soft" : "is-no"}>
                    <i>{k.ok ? MkIco.check : "!"}</i><span>{k.t}</span>
                    {!k.ok && k.step !== 2 && <button className="mk-linkbtn" onClick={() => setStep(k.step)}>Fix</button>}
                  </li>
                ))}
              </ul>
              <div className="mkh-trk">
                <div className="mkh-trk-h"><b>Tracking</b>
                  {x.tracking === false ? <em className="is-warn">Off until the manage-users function is deployed with the marketing links (see the notes).</em>
                    : !x.agg.tracked ? <em className="is-warn">Run 64_marketing_hub.sql to record opens and clicks.</em>
                    : <em>Opens, clicks and unsubscribes are recorded for each person. Replies and bounces are read from the synced mailbox.</em>}
                </div>
                <label className="cx-switch"><input type="checkbox" checked={trackOpens} onChange={(e) => setTrackOpens(e.target.checked)} /><i />Opens</label>
                <label className="cx-switch"><input type="checkbox" checked={trackClicks} onChange={(e) => setTrackClicks(e.target.checked)} /><i />Link clicks</label>
              </div>
              <div className="mkh-sendbox">
                <div className="mkh-sendbox-sum">
                  <span><b>{fmtN(ok.length)}</b><em>recipients</em></span>
                  <span><b>~{ok.length ? Math.max(1, Math.ceil(ok.length / PROVIDER.perMinute)) : 0} min</b><em>at {PROVIDER.perMinute} a minute</em></span>
                  <span><b>{fromAddr || "—"}</b><em>from</em></span>
                </div>
                {msg && <span className={`mk-msg is-${msg.tone}`}>{msg.text}</span>}
                <div className="mkh-sendbox-row">
                  <button className="mk-btn" disabled={!!busy || !subject.trim()} onClick={() => void testSend()}>{busy === "test" ? "Sending test…" : "Send me a test"}</button>
                  <span className="mk-grow" />
                  <div className="mk-sched">
                    <DatePicker value={when.d} onChange={(d) => setWhen((v) => ({ ...v, d }))} placeholder="Date" />
                    <input type="time" value={when.t} onChange={(e) => setWhen((v) => ({ ...v, t: e.target.value }))} />
                    <button className="mk-btn" disabled={!!busy || !!problem || x.missing} onClick={() => void schedule()}>{busy === "schedule" ? "…" : "Schedule"}</button>
                  </div>
                </div>
                {confirmSend ? (
                  <div className="mk-really">
                    <b>Send to {fmtN(ok.length)} people now?</b>
                    <em>About {Math.max(1, Math.ceil(ok.length / PROVIDER.perMinute))} min — keep Marketing open in a tab while it sends. You can pause any time.</em>
                    <div><button className="mk-btn is-ghost" autoFocus onClick={() => setConfirmSend(false)}>Not yet</button><button className="mk-btn is-primary" onClick={() => void sendNow()}>{MkIco.send}Send now</button></div>
                  </div>
                ) : (
                  <button className="mk-btn is-primary is-big" disabled={!!busy || !!problem || x.missing} onClick={() => setConfirmSend(true)}>{busy === "send" ? "Starting…" : <>{MkIco.send}Send to {fmtN(ok.length)} people</>}</button>
                )}
              </div>
            </div>
          )}
        </div>

        <aside className="mkh-cmp-side">
          <div className="mk-card mk-pv">
            <div className="mk-pv-h">
              <b>Preview</b>
              {ok.length > 0 && (
                <span className="mk-pv-nav">
                  <button onClick={() => setPi((v) => Math.max(0, v - 1))} disabled={pi <= 0}>‹</button>
                  <em title={sample?.email}>{sample?.name ?? ""}<small>{Math.min(pi, ok.length - 1) + 1} / {fmtN(ok.length)}</small></em>
                  <button onClick={() => setPi((v) => Math.min(ok.length - 1, v + 1))} disabled={pi >= ok.length - 1}>›</button>
                </span>
              )}
            </div>
            <div className="mkh-inbox" aria-hidden="true">
              <span className="mkh-inbox-av">{initials(fromAddr || "Y")}</span>
              <span className="mkh-inbox-t"><b>{fromAddr || "You"}</b><span><strong>{prev.subject || "No subject"}</strong> {preheader && <em>— {mergeText(preheader, sample?.merge ?? demo, false)}</em>}</span></span>
            </div>
            <div className="mk-pv-mail">
              <div className="mk-pv-meta">
                <b>{prev.subject || "No subject"}</b>
                <span><em>To</em>{sample ? `${sample.name} <${sample.email}>` : "Laura Gil <laura@example.com>"}</span>
              </div>
              <iframe title="E-mail preview" sandbox="" srcDoc={previewDoc} />
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

/** Replies and bounces: read from the synced mailbox (ticket_mail_messages) and written on the sends. */
async function detectRepliesAndBounces(c: MkCampaign, sends: MkSend[]): Promise<number> {
  if (!c.started_at) return 0;
  const sent = sends.filter((s) => s.status === "sent" && !s.email.startsWith("(none"));
  if (!sent.length) return 0;
  const byMail = new Map(sent.map((s) => [s.email.toLowerCase(), s]));
  const updates: { id: string; patch: Record<string, string> }[] = [];
  const emails = [...byMail.keys()];
  for (let i = 0; i < emails.length; i += 150) {
    const { data, error } = await supabase.from("ticket_mail_messages").select("from_email, received_at").eq("direction", "in").gte("received_at", c.started_at).in("from_email", emails.slice(i, i + 150)).limit(2000);
    if (error) return 0;
    (data ?? []).forEach((m: any) => {
      const s = byMail.get(String(m.from_email ?? "").toLowerCase());
      if (s && !s.replied_at && (!s.sent_at || m.received_at >= s.sent_at)) { s.replied_at = m.received_at; updates.push({ id: s.id, patch: { replied_at: m.received_at } }); }
    });
  }
  const { data: nd } = await supabase.from("ticket_mail_messages").select("subject, snippet, body_html, received_at").eq("direction", "in").gte("received_at", c.started_at)
    .or("subject.ilike.%undeliverable%,subject.ilike.%no se puede entregar%,subject.ilike.%delivery status notification%,subject.ilike.%mail delivery failed%,subject.ilike.%returned mail%,subject.ilike.%no entregado%").limit(500);
  (nd ?? []).forEach((m: any) => {
    const txt = `${m.snippet ?? ""} ${m.body_html ?? ""}`.toLowerCase();
    byMail.forEach((s, e) => { if (!s.bounced_at && txt.includes(e)) { s.bounced_at = m.received_at; updates.push({ id: s.id, patch: { bounced_at: m.received_at } }); } });
  });
  for (const u of updates) await supabase.from("marketing_sends").update(u.patch).eq("id", u.id);
  return updates.length;
}

type RFilter = "all" | "opened" | "not_opened" | "clicked" | "replied" | "bounced" | "unsub" | "failed" | "waiting" | "skipped";
function CampaignReport({ x, c, onBack, onOpen }: { x: HubCtx; c: MkCampaign; onBack: () => void; onOpen: (id: string) => void }) {
  const { runner } = x;
  const [sends, setSends] = useState<MkSend[]>([]);
  const [events, setEvents] = useState<{ kind: string; url: string | null; created_at: string; send_id: string }[]>([]);
  const [filter, setFilter] = useState<RFilter>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    const [s, e] = await Promise.all([
      mkAll<MkSend>("marketing_sends", "*", (qq) => qq.eq("campaign_id", c.id).order("created_at")),
      mkAll<any>("marketing_events", "kind, url, created_at, send_id", (qq) => qq.eq("campaign_id", c.id)),
    ]);
    setSends(s.rows); setEvents(e.rows);
    return s.rows;
  };
  useEffect(() => {
    void load().then(async (rows) => { if (x.agg.tracked && c.status !== "sending") { const n = await detectRepliesAndBounces(c, rows); if (n) { await load(); await x.reload(); } } });
    const t = window.setInterval(() => { void load(); }, c.status === "sending" ? 5000 : 30000);
    return () => window.clearInterval(t);
  }, [c.id, c.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const real = sends.filter((s) => s.status !== "skipped");
  const sent = sends.filter((s) => s.status === "sent");
  const n = {
    total: real.length, sent: sent.length, waiting: sends.filter((s) => s.status === "queued" || s.status === "claimed").length,
    failed: sends.filter((s) => s.status === "failed").length, skipped: sends.filter((s) => s.status === "skipped").length,
    opened: sent.filter((s) => s.opened_at).length, clicked: sent.filter((s) => s.clicked_at).length, replied: sent.filter((s) => s.replied_at).length,
    bounced: sent.filter((s) => s.bounced_at).length, unsub: sent.filter((s) => s.unsubscribed_at).length,
  };
  const delivered = Math.max(0, n.sent - n.bounced);
  const prog = n.total ? (n.sent + n.failed) / n.total : 0;
  const l = x.lists.find((y) => y.id === c.list_id);
  const nq = norm(q);
  const match = (s: MkSend) => {
    switch (filter) {
      case "opened": return !!s.opened_at; case "not_opened": return s.status === "sent" && !s.opened_at && !s.bounced_at;
      case "clicked": return !!s.clicked_at; case "replied": return !!s.replied_at; case "bounced": return !!s.bounced_at; case "unsub": return !!s.unsubscribed_at;
      case "failed": return s.status === "failed"; case "waiting": return s.status === "queued" || s.status === "claimed"; case "skipped": return s.status === "skipped";
      default: return true;
    }
  };
  const shown = sends.filter((s) => match(s) && (!nq || norm(`${s.name} ${s.email}`).includes(nq)));
  // opens over time: per hour the first day, then per day
  const opens = events.filter((e) => e.kind === "open");
  const t0 = c.started_at ? new Date(c.started_at).getTime() : 0;
  const buckets = Array.from({ length: 14 }, () => 0);
  const bucketOf = (t: number) => { const h = (t - t0) / 36e5; return h < 0 ? -1 : h < 24 ? Math.floor(h / 3) : Math.min(13, 8 + Math.floor((h - 24) / 24)); };
  opens.forEach((e) => { const b = bucketOf(new Date(e.created_at).getTime()); if (b >= 0) buckets[b]++; });
  const bMax = Math.max(1, ...buckets);
  const bLabel = (i: number) => (i < 8 ? `${i * 3}h` : `day ${i - 6}`);
  const links = useMemo(() => {
    const m = new Map<string, Set<string>>();
    events.filter((e) => e.kind === "click" && e.url).forEach((e) => { const s = m.get(e.url!) ?? new Set(); s.add(e.send_id); m.set(e.url!, s); });
    return [...m.entries()].map(([u, s]) => ({ u, n: s.size })).sort((a, b) => b.n - a.n).slice(0, 6);
  }, [events]);

  const retry = async () => {
    await supabase.from("marketing_sends").update({ status: "queued", error: null, claimed_by: null, claimed_at: null }).eq("campaign_id", c.id).eq("status", "failed");
    await runner.resume(c); await load();
  };
  const cancel = async () => {
    await supabase.from("marketing_sends").update({ status: "skipped", error: "Cancelled" }).eq("campaign_id", c.id).eq("status", "queued");
    await supabase.from("marketing_campaigns").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", c.id);
    await refreshStats(c.id); await x.reload(); await load();
  };
  const duplicate = async (followUp: boolean) => {
    setBusy(followUp ? "follow" : "dup");
    let listId = c.list_id;
    if (followUp) {
      const who = sent.filter((s) => !s.opened_at && !s.bounced_at && !s.unsubscribed_at && s.contact_id);
      const { data, error } = await supabase.from("marketing_lists").insert({ name: `${c.name} — didn't open`, description: `People who didn't open “${c.name}”`, entity: "contacts", kind: "static", definition: emptyDef(), member_count: who.length }).select("id").single();
      if (error || !data) { setBusy(null); x.toast(error?.message ?? "Could not make the list"); return; }
      listId = (data as any).id;
      const rows = who.map((s) => ({ list_id: listId, contact_id: s.contact_id }));
      for (let i = 0; i < rows.length; i += 500) await supabase.from("marketing_list_members").insert(rows.slice(i, i + 500));
    }
    const r = await saveCampaignRow({ name: followUp ? `${c.name} — follow-up` : `${c.name} (copy)`, list_id: listId, from_mailbox: c.from_mailbox, reply_to: c.reply_to, subject: followUp ? `Re: ${c.subject}` : c.subject, preheader: c.preheader ?? null, body_html: c.body_html, track_opens: c.track_opens ?? true, track_clicks: c.track_clicks ?? true });
    setBusy(null);
    await x.reload();
    if (r.id) { x.toast(followUp ? "Follow-up ready: a list of who didn't open, and a copy of the e-mail" : "Copy made"); onOpen(r.id); }
  };
  const stats: { k: RFilter; label: string; v: number; rate?: string; ico: React.ReactNode; tone: string; hint?: string }[] = [
    { k: "all", label: "Delivered", v: delivered, rate: n.total ? fmtPct(delivered, n.total) : undefined, ico: MkIco.send, tone: "ink" },
    { k: "opened", label: "Opened", v: n.opened, rate: fmtPct(n.opened, delivered), ico: MhIco.eye, tone: "jade" },
    { k: "clicked", label: "Clicked", v: n.clicked, rate: fmtPct(n.clicked, delivered), ico: MhIco.click, tone: "blue", hint: n.opened ? `${fmtPct(n.clicked, n.opened)} of who opened` : undefined },
    { k: "replied", label: "Replied", v: n.replied, rate: fmtPct(n.replied, delivered), ico: MhIco.reply, tone: "violet" },
    { k: "bounced", label: "Bounced", v: n.bounced, ico: MhIco.bounce, tone: "amber" },
    { k: "unsub", label: "Unsubscribed", v: n.unsub, ico: MkIco.shield, tone: "red" },
  ];
  return (
    <section className="mkh-rep">
      <div className="mkh-rep-head">
        <button className="mk-back" onClick={onBack} aria-label="Back to campaigns">{MkIco.back}</button>
        <div className="mkh-rep-title">
          <span className={`mk-status is-${c.status}`}>{c.status === "sending" && runner.running === c.id && <i className="mk-pulse" />}{STATUS_LABEL[c.status]}</span>
          <h2>{c.name}</h2>
          <p><b>{c.subject}</b></p>
          <span className="mk-pg-meta"><span>{MkIco.list}{l?.name ?? "no list"}</span>{c.from_mailbox && <span>{MkIco.mail}{c.from_mailbox}</span>}<span>{MkIco.clock}{fmtWhen(c.started_at)}{c.finished_at ? ` → ${fmtWhen(c.finished_at)}` : ""}</span></span>
        </div>
        <div className="mk-pg-acts">
          {c.status === "sending" && <button className="mk-btn" onClick={() => void runner.pause(c)}>{MkIco.pause}Pause</button>}
          {c.status === "paused" && <button className="mk-btn is-primary" onClick={() => void runner.resume(c)}>{MkIco.play}Resume</button>}
          {n.failed > 0 && c.status !== "sending" && <button className="mk-btn" onClick={() => void retry()}>Retry {fmtN(n.failed)} failed</button>}
          {(c.status === "sending" || c.status === "paused") && <MkConfirm label={<>{MkIco.stop}Cancel</>} ask="Stop for good?" yes="Cancel campaign" onYes={() => void cancel()} />}
          {c.status === "sent" && x.agg.tracked && n.sent - n.opened > 0 && <button className="mk-btn" disabled={!!busy} onClick={() => void duplicate(true)} title="A fixed list of who didn't open, and a copy of this e-mail to send them">{busy === "follow" ? "…" : `Follow up ${fmtN(n.sent - n.opened)} who didn't open`}</button>}
          <button className="mk-btn" disabled={!!busy} onClick={() => void duplicate(false)}>{MkIco.copy}Duplicate</button>
        </div>
      </div>
      {(c.status === "sending" || c.status === "paused") && (
        <div className="mkh-rep-prog"><i style={{ width: `${prog * 100}%` }} /><span>{fmtN(n.sent + n.failed)} of {fmtN(n.total)} sent{n.waiting ? ` · ${fmtN(n.waiting)} waiting` : ""}</span></div>
      )}
      <div className="mkh-rep-kpis">
        {stats.map((s) => (
          <button key={s.label} className={`mkh-kpi is-${s.tone} ${filter === s.k && s.k !== "all" ? "is-on" : ""}`} onClick={() => setFilter(filter === s.k ? "all" : s.k)}>
            <span className="mkh-kpi-ico">{s.ico}</span>
            <span className="mkh-kpi-k">{s.label}</span>
            <b>{s.rate && s.k !== "all" ? s.rate : fmtN(s.v)}</b>
            <em>{s.k === "all" ? (s.rate ? `${s.rate} of ${fmtN(n.total)}` : "") : s.rate ? `${fmtN(s.v)} people` : "people"}{s.hint ? ` · ${s.hint}` : ""}</em>
          </button>
        ))}
      </div>
      {!x.agg.tracked && <p className="mkh-fine is-box">Opens, clicks, replies and bounces show here after running 64_marketing_hub.sql — e-mails sent before that aren't tracked.</p>}
      <div className="mkh-rep-grid">
        <div className="mkh-panel mkh-rep-chart">
          <div className="mkh-sec-h"><h2>When people opened it</h2><em>{opens.length ? `${fmtN(opens.length)} opens` : "No opens recorded yet"}</em></div>
          <div className="mkh-bars" role="img" aria-label="Opens over time">
            {buckets.map((v, i) => <span key={i} className="mkh-bar-col" title={`${bLabel(i)}: ${v}`}><i style={{ height: `${(v / bMax) * 100}%` }} /><em>{i % 2 === 0 ? bLabel(i) : ""}</em></span>)}
          </div>
        </div>
        <div className="mkh-panel mkh-rep-links">
          <div className="mkh-sec-h"><h2>Links clicked</h2></div>
          {links.length ? links.map((k) => (
            <a key={k.u} className="mkh-link" href={k.u} target="_blank" rel="noreferrer"><span>{k.u.replace(/^https?:\/\/(www\.)?/, "")}</span><b>{fmtN(k.n)}</b></a>
          )) : <p className="mkh-fine">{c.track_clicks === false ? "Link tracking was off for this campaign." : "Nobody has clicked a link yet."}</p>}
        </div>
      </div>
      <div className="mkh-panel mkh-rcp">
        <div className="mkh-rcp-tools">
          <h2>Recipients</h2>
          <div className="mkh-filters">
            {([["all", "Everyone", sends.length], ["opened", "Opened", n.opened], ["not_opened", "Didn't open", Math.max(0, n.sent - n.opened - n.bounced)], ["clicked", "Clicked", n.clicked], ["replied", "Replied", n.replied], ["bounced", "Bounced", n.bounced], ["unsub", "Unsubscribed", n.unsub], ["failed", "Failed", n.failed], ["waiting", "Waiting", n.waiting], ["skipped", "Left out", n.skipped]] as [RFilter, string, number][])
              .filter(([k, , v]) => k === "all" || v > 0 || k === filter)
              .map(([k, lb, v]) => <button key={k} className={filter === k ? "is-on" : ""} onClick={() => setFilter(k)}>{lb}<em>{fmtN(v)}</em></button>)}
          </div>
          <span className="mk-grow" />
          <label className="mk-search">{MkIco.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" /></label>
        </div>
        <div className="mkh-rcp-rows">
          {shown.slice(0, 500).map((s) => (
            <div key={s.id} className={`mkh-rcp-row is-${s.status}`}>
              <i className="mkh-av" style={{ ["--h" as string]: hue(s.name ?? s.email) } as CSSProperties}>{initials(s.name ?? s.email)}</i>
              <span className="mkh-rcp-who"><b>{s.name || s.email}</b><em>{s.email.startsWith("(none") ? "no e-mail" : s.email}</em></span>
              <span className="mkh-rcp-tags">
                {s.status === "sent" && !s.bounced_at && <span className="mkh-tag is-sent">Delivered</span>}
                {s.opened_at && <span className="mkh-tag is-open" title={`First ${fmtWhen(s.opened_at)}`}>{MhIco.eye}Opened{(s.open_count ?? 0) > 1 ? ` ×${s.open_count}` : ""}</span>}
                {s.clicked_at && <span className="mkh-tag is-click" title={s.last_click_url ?? ""}>{MhIco.click}Clicked{(s.click_count ?? 0) > 1 ? ` ×${s.click_count}` : ""}</span>}
                {s.replied_at && <span className="mkh-tag is-reply">{MhIco.reply}Replied</span>}
                {s.bounced_at && <span className="mkh-tag is-bounce">{MhIco.bounce}Bounced</span>}
                {s.unsubscribed_at && <span className="mkh-tag is-unsub">Unsubscribed</span>}
                {s.status === "failed" && <span className="mkh-tag is-fail" title={s.error ?? ""}>Failed{s.error ? `: ${s.error}` : ""}</span>}
                {(s.status === "queued" || s.status === "claimed") && <span className="mkh-tag">{s.status === "claimed" ? "Sending…" : "Waiting"}</span>}
                {s.status === "skipped" && <span className="mkh-tag is-skip">{s.error ?? "Left out"}</span>}
              </span>
              <span className="mkh-rcp-when">{fmtWhen(s.replied_at ?? s.clicked_at ?? s.opened_at ?? s.sent_at)}</span>
            </div>
          ))}
          {!shown.length && <div className="mk-empty-sm">{MkIco.mail}<span>{sends.length ? "Nobody here." : "No e-mails queued for this campaign."}</span></div>}
          {shown.length > 500 && <p className="mk-muted">…and {fmtN(shown.length - 500)} more.</p>}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════ Social ═══════════════════════════ */
function SocialTab({ x }: { x: HubCtx }) {
  const [view, setView] = useState<"upcoming" | "drafts" | "published" | "all">(x.posts.some(isDue) ? "upcoming" : "upcoming");
  const [net, setNet] = useState<Net | "all">("all");
  const [q, setQ] = useState("");
  const [acct, setAcct] = useState(false);
  const nq = norm(q);
  const inView = (p: MkPost) => view === "all" ? p.status !== "cancelled"
    : view === "upcoming" ? p.status === "scheduled"
    : view === "drafts" ? p.status === "draft" || p.status === "idea" || p.status === "failed"
    : p.status === "published";
  const shown = x.posts.filter((p) => inView(p) && (net === "all" || p.networks.includes(net)) && (!nq || norm(`${p.title} ${p.body} ${p.series ?? ""}`).includes(nq)))
    .sort((a, b) => {
      const ta = postWhen(a) ? new Date(postWhen(a)!).getTime() : Infinity, tb = postWhen(b) ? new Date(postWhen(b)!).getTime() : Infinity;
      return view === "published" ? tb - ta : ta - tb;
    });
  const groups = new Map<string, MkPost[]>();
  shown.forEach((p) => { const w0 = postWhen(p); const k = w0 ? dayKey(new Date(w0)) : "none"; const a = groups.get(k) ?? []; a.push(p); groups.set(k, a); });
  const due = x.posts.filter(isDue);
  const cnt = (v: typeof view) => x.posts.filter((p) => (v === "all" ? p.status !== "cancelled" : v === "upcoming" ? p.status === "scheduled" : v === "drafts" ? ["draft", "idea", "failed"].includes(p.status) : p.status === "published")).length;
  const dayLabel = (k: string) => {
    if (k === "none") return "No date";
    const d = new Date(`${k}T00:00:00`); const t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - t.getTime()) / 864e5);
    const base = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    return diff === 0 ? `Today — ${base}` : diff === 1 ? `Tomorrow — ${base}` : diff === -1 ? `Yesterday — ${base}` : base;
  };
  if (x.hubMissing && !x.posts.length) {
    return <div className="mk-empty"><div className="mk-empty-art" aria-hidden="true"><span className="is-a">{MhIco.social}</span><span className="is-b">{MhIco.cal}</span><span className="is-c">{MhIco.spark}</span></div><h3>Social posts need one SQL file</h3><p>Run <code>64_marketing_hub.sql</code> in Supabase to plan, schedule and track posts for LinkedIn, Instagram, X and the rest.</p></div>;
  }
  return (
    <div className="mkh-social">
      <div className="mkh-toolbar">
        <MkSeg size="sm" value={view} onChange={setView}
          options={[{ value: "upcoming", label: "Scheduled", count: cnt("upcoming") }, { value: "drafts", label: "Drafts & ideas", count: cnt("drafts") }, { value: "published", label: "Published", count: cnt("published") }, { value: "all", label: "All", count: cnt("all") }]} />
        <div className="mkh-netpick">
          <button className={net === "all" ? "is-on" : ""} onClick={() => setNet("all")}>All networks</button>
          {NET_KEYS.filter((n) => x.posts.some((p) => p.networks.includes(n))).map((n) => <button key={n} className={net === n ? "is-on" : ""} onClick={() => setNet(net === n ? "all" : n)}><NetBadge n={n} size="sm" />{NETS[n].label}</button>)}
        </div>
        <label className="mk-search">{MkIco.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a post" /></label>
        <span className="mk-grow" />
        <button className="mk-btn" onClick={() => setAcct(true)}>Channels{x.accounts.length ? <em className="mkh-cnt">{x.accounts.length}</em> : null}</button>
        <button className="mk-btn" onClick={x.openImport}>{MhIco.upload}Import</button>
        <button className="mk-btn" onClick={() => x.openAi()}>{MhIco.spark}Plan with AI</button>
        <button className="mk-btn is-primary" onClick={() => x.newPostAt()}>{MkIco.plus}New post</button>
      </div>
      {due.length > 0 && (
        <div className="mkh-due-bar">
          <span className="mkh-due-ico">{MhIco.bell}</span>
          <div><b>{due.length === 1 ? "1 post is ready to publish" : `${due.length} posts are ready to publish`}</b><em>Their time has come. Publish them in one click each — the text is copied and the network opens.</em></div>
          <span className="mk-grow" />
          {due.slice(0, 3).map((p) => <button key={p.id} className="mk-btn is-sm" onClick={() => x.publish(p)}>{p.networks.slice(0, 2).map((n) => <NetBadge key={n} n={n} size="sm" />)}{(p.title || p.body).slice(0, 24)}</button>)}
        </div>
      )}
      {!shown.length ? (
        <div className="mk-empty">
          <div className="mk-empty-art" aria-hidden="true"><span className="is-a">{MhIco.social}</span><span className="is-b">{MhIco.spark}</span><span className="is-c">{MhIco.cal}</span></div>
          <h3>{x.posts.length ? "Nothing here" : "Plan your first posts"}</h3>
          <p>{x.posts.length ? "Try another tab or network." : "Write one, let AI plan a series from a short brief, or import a spreadsheet of posts with their dates."}</p>
          {!x.posts.length && <div className="mk-empty-acts"><button className="mk-btn is-big" onClick={x.openImport}>{MhIco.upload}Import a CSV</button><button className="mk-btn is-primary is-big" onClick={() => x.openAi()}>{MhIco.spark}Plan with AI</button></div>}
        </div>
      ) : (
        <div className="mkh-feed">
          {[...groups.entries()].map(([k, ps]) => (
            <section key={k} className="mkh-feed-day">
              <h3>{dayLabel(k)}</h3>
              {ps.map((p) => {
                const r = Object.values(p.results ?? {});
                const reach = r.reduce((s, v) => s + (v.impressions ?? 0), 0), react = r.reduce((s, v) => s + (v.likes ?? 0) + (v.comments ?? 0) + (v.shares ?? 0), 0);
                return (
                  <div key={p.id} className={`mkh-post is-${p.status} ${isDue(p) ? "is-due" : ""}`} style={{ ["--n" as string]: NETS[p.networks[0] ?? "linkedin"].color } as CSSProperties}>
                    <button className="mkh-post-main" onClick={() => x.openPost(p)}>
                      <span className="mkh-post-time">{postWhen(p) ? hhmm(postWhen(p)) : "—"}</span>
                      <span className="mkh-post-nets">{p.networks.map((n) => <NetBadge key={n} n={n} />)}</span>
                      <span className="mkh-post-txt"><b>{p.title || p.body.split("\n")[0].slice(0, 80) || "Untitled post"}</b><em>{p.body.replace(/\s+/g, " ").slice(0, 160)}</em>
                        {p.series && <small className="mkh-series">{p.series}</small>}</span>
                      {p.media[0] && <img className="mkh-post-img" src={p.media[0].url} alt="" />}
                    </button>
                    <span className="mkh-post-side">
                      <span className={`mkh-st is-${p.status}`}>{isDue(p) ? "Ready" : POST_STATUS[p.status]}</span>
                      {p.status === "published" && (reach || react) ? <em>{fmtN(reach)} views · {fmtN(react)} reactions</em> : p.source !== "manual" ? <em>{p.source === "ai" ? "AI draft" : "Imported"}</em> : null}
                      {(p.status === "scheduled" || p.status === "draft") && <button className="mk-btn is-sm" onClick={() => x.publish(p)}>Publish</button>}
                    </span>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
      {acct && <ChannelsDialog x={x} onClose={() => setAcct(false)} />}
    </div>
  );
}

function ChannelsDialog({ x, onClose }: { x: HubCtx; onClose: () => void }) {
  const [n, setN] = useState<Net>("linkedin");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [err, setErr] = useState("");
  const add = async () => {
    if (!name.trim()) { setErr("Give it a name."); return; }
    const { error } = await supabase.from("marketing_social_accounts").insert({ network: n, name: name.trim(), handle: handle.trim() || null, status: "manual" });
    if (error) { setErr(MK_MISSING.test(error.message) ? "Run 64_marketing_hub.sql first." : error.message); return; }
    setName(""); setHandle(""); setErr(""); await x.reload();
  };
  const del = async (a: MkAccount) => { await supabase.from("marketing_social_accounts").delete().eq("id", a.id); await x.reload(); };
  return (
    <MhModal title="Channels" sub="The pages and profiles you post to. Publishing opens the network with the text ready; automatic publishing plugs in here once each network's API access is set up." onClose={onClose}>
      <div className="mkh-acc-list">
        {x.accounts.map((a) => (
          <div key={a.id} className="mkh-acc"><NetBadge n={a.network} size="lg" /><span><b>{a.name}</b><em>{NETS[a.network]?.label}{a.handle ? ` · ${a.handle}` : ""}</em></span><span className="mkh-st is-draft">{a.status === "connected" ? "Connected" : "Publish by hand"}</span><MkConfirm label="×" className="is-icon" ask="Remove?" yes="Remove" onYes={() => void del(a)} /></div>
        ))}
        {!x.accounts.length && <p className="mkh-fine">No channels yet. Add your company page on LinkedIn, your Instagram account…</p>}
      </div>
      <div className="mkh-acc-add">
        <div className="mkh-netrow">{NET_KEYS.map((k) => <button key={k} className={`mkh-netbtn ${n === k ? "is-on" : ""}`} style={{ ["--n" as string]: NETS[k].color } as CSSProperties} onClick={() => setN(k)}><NetBadge n={k} size="sm" />{NETS[k].label}</button>)}</div>
        <div className="mkh-acc-form">
          <input className="mk-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Empower — company page" />
          <input className="mk-input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@handle or page link (optional)" />
          <button className="mk-btn is-primary" onClick={() => void add()}>Add</button>
        </div>
        {err && <span className="mk-msg is-err">{err}</span>}
      </div>
    </MhModal>
  );
}

/** Uploads a picture to the "brand" bucket and returns its public address. */
async function uploadMedia(f: File): Promise<{ url: string } | { error: string }> {
  const path = `marketing/${Date.now()}-${f.name.replace(/[^\w.\-]+/g, "_")}`;
  const { error } = await supabase.storage.from("brand").upload(path, f, { upsert: false, contentType: f.type || undefined });
  if (error) return { error: /bucket|not found/i.test(error.message) ? "Pictures need the storage bucket “brand” (31_doc_assets_bucket.sql) — or paste a picture link instead." : error.message };
  const { data } = supabase.storage.from("brand").getPublicUrl(path);
  return { url: data.publicUrl };
}

function PostEditor({ x, post, onClose }: { x: HubCtx; post: MkPost; onClose: () => void }) {
  const [p, setP] = useState<MkPost>(post);
  const [tab, setTab] = useState<Net | "main">("main");
  const [pv, setPv] = useState<Net>(post.networks[0] ?? "linkedin");
  const [when, setWhen] = useState<{ d: string; t: string }>(() => (post.scheduled_at ? { d: dayKey(new Date(post.scheduled_at)), t: hhmm(post.scheduled_at) } : { d: "", t: "09:00" }));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [ai, setAi] = useState<{ open: boolean; brief: string; busy: boolean }>({ open: false, brief: post.ai_brief ?? "", busy: false });
  const fileRef = useRef<HTMLInputElement | null>(null);
  const set = (patch: Partial<MkPost>) => setP((v) => ({ ...v, ...patch }));
  useEffect(() => { if (!p.networks.includes(pv) && p.networks[0]) setPv(p.networks[0]); if (tab !== "main" && !p.networks.includes(tab)) setTab("main"); }, [p.networks]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleNet = (n: Net) => set({ networks: p.networks.includes(n) ? p.networks.filter((y) => y !== n) : [...p.networks, n] });
  const curText = tab === "main" ? p.body : p.variants?.[tab]?.text ?? "";
  const setText = (v: string) => (tab === "main" ? set({ body: v }) : set({ variants: { ...p.variants, [tab]: { ...(p.variants?.[tab] ?? {}), text: v } } }));
  const limitOf = (n: Net) => NETS[n].limit;
  const over = p.networks.filter((n) => postText(p, n).length > limitOf(n));
  const strict = tab === "main" ? Math.min(...p.networks.map(limitOf), 99999) : limitOf(tab);
  const needsImg = p.networks.some((n) => n === "instagram" || n === "tiktok" || n === "youtube") && !p.media.length;
  const save = async (status?: PostStatus, extra: Partial<MkPost> = {}) => {
    if (!p.body.trim() && !Object.values(p.variants).some((v) => v.text?.trim())) { setErr("Write the post first."); return null; }
    if (!p.networks.length) { setErr("Choose at least one network."); return null; }
    const st = status ?? p.status;
    let scheduled_at = p.scheduled_at;
    if (when.d) scheduled_at = atISO(when.d, when.t);
    if (st === "scheduled" && !scheduled_at) { setErr("Pick the day and time it goes out."); return null; }
    setBusy(st); setErr("");
    const { id: _id, created_at: _c, updated_at: _u, ...rest } = p;
    const r = await savePostRow({ ...rest, status: st, scheduled_at, ai_brief: ai.brief.trim() || p.ai_brief || null, ...extra }, p.id || null);
    setBusy(null);
    if (r.error) { setErr(r.error); return null; }
    await x.reload();
    x.toast(st === "scheduled" ? `Scheduled for ${fmtWhen(scheduled_at)}` : st === "published" ? "Marked as published" : "Saved");
    return r.id;
  };
  const del = async () => { if (p.id) await supabase.from("marketing_posts").delete().eq("id", p.id); await x.reload(); onClose(); };
  const addFile = async (f?: File) => {
    if (!f) return;
    setBusy("upload"); const r = await uploadMedia(f); setBusy(null);
    if ("error" in r) { setErr(r.error); return; }
    set({ media: [...p.media, { url: r.url, kind: f.type.startsWith("video") ? "video" : "image" }] });
  };
  const runAi = async () => {
    if (!ai.brief.trim() && !p.body.trim()) return;
    setAi((a) => ({ ...a, busy: true })); setErr("");
    const r = await aiWrite<{ posts: { title: string; body: string; variants?: Record<string, string>; hashtags?: string[] }[] }>({
      kind: "posts", count: 1, brief: ai.brief.trim() || `Improve this post:\n${p.body}`, networks: p.networks, company: x.me.company, lang: "es", link: p.link_url ?? "",
    });
    setAi((a) => ({ ...a, busy: false }));
    if (!r.ok) { setErr(r.error); return; }
    const g = r.data.posts?.[0];
    if (!g) { setErr("The AI gave no post."); return; }
    const variants: MkPost["variants"] = {};
    Object.entries(g.variants ?? {}).forEach(([k, v]) => { if (NETS[k as Net]) variants[k] = { text: v }; });
    set({ title: p.title || g.title, body: g.body, variants, source: p.source === "manual" && !p.id ? "ai" : p.source });
  };
  const res = (n: Net, k: keyof PostResult, v: string) => set({ results: { ...p.results, [n]: { ...(p.results?.[n] ?? {}), [k]: k === "url" ? v : v === "" ? undefined : Number(v) } } });
  const acct = (n: Net) => x.accounts.find((a) => a.network === n);
  const pvText = postText(p, pv);

  return createPortal(
    <div className="mkh-drawer-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mkh-drawer" role="dialog" aria-modal="true" aria-label="Post">
        <header className="mkh-drawer-h">
          <input className="mkh-cmp-name" value={p.title ?? ""} onChange={(e) => set({ title: e.target.value })} placeholder="Name this post (only your team sees it)" />
          <span className={`mkh-st is-${p.status}`}>{isDue(p) ? "Ready to publish" : POST_STATUS[p.status]}</span>
          <button className="mkh-x" onClick={onClose} aria-label="Close">{MhIco.x}</button>
        </header>
        <div className="mkh-drawer-body">
          <div className="mkh-pe-main">
            <div className="mkh-pe-sec">
              <span className="mkh-lbl">Where</span>
              <div className="mkh-netrow">
                {NET_KEYS.map((n) => (
                  <button key={n} className={`mkh-netbtn ${p.networks.includes(n) ? "is-on" : ""}`} style={{ ["--n" as string]: NETS[n].color } as CSSProperties} onClick={() => toggleNet(n)} aria-pressed={p.networks.includes(n)}>
                    <NetBadge n={n} size="sm" off={!p.networks.includes(n)} />{NETS[n].label}
                  </button>
                ))}
              </div>
            </div>

            <div className={`mkh-ai is-mini ${ai.open ? "is-open" : ""}`}>
              <button className="mkh-ai-h" onClick={() => setAi((a) => ({ ...a, open: !a.open }))} aria-expanded={ai.open}><span className="mkh-ai-ico">{MhIco.spark}</span><b>Write with AI</b><em>One post, adapted to each network</em><i className="mkh-caret" /></button>
              {ai.open && (
                <div className="mkh-ai-body">
                  <textarea rows={2} value={ai.brief} onChange={(e) => setAi((a) => ({ ...a, brief: e.target.value }))} placeholder="What's the post about? Leave empty to improve the text below." />
                  <div className="mkh-ai-acts"><span className="mk-grow" /><button className="mk-btn is-primary" disabled={ai.busy} onClick={() => void runAi()}>{ai.busy ? <><i className="mkh-spin" />Writing…</> : <>{MhIco.spark}{p.body.trim() && !ai.brief.trim() ? "Improve it" : "Write it"}</>}</button></div>
                </div>
              )}
            </div>

            <div className="mkh-pe-sec">
              <div className="mkh-vtabs">
                <button className={tab === "main" ? "is-on" : ""} onClick={() => setTab("main")}>Text for all</button>
                {p.networks.map((n) => <button key={n} className={tab === n ? "is-on" : ""} onClick={() => { setTab(n); setPv(n); }}><NetBadge n={n} size="sm" />{NETS[n].label}{p.variants?.[n]?.text?.trim() ? <i className="mkh-dot" title="Own text" /> : null}</button>)}
              </div>
              <div className="mkh-textbox">
                <textarea value={curText} onChange={(e) => setText(e.target.value)} rows={10}
                  placeholder={tab === "main" ? "Write the post. Line breaks and emojis are kept." : `Own text for ${NETS[tab].label} — leave empty to use the text for all.`} />
                <div className="mkh-textbox-f">
                  {tab !== "main" && p.variants?.[tab]?.text && <button className="mk-linkbtn" onClick={() => setText("")}>Use the text for all</button>}
                  <span className="mk-grow" />
                  <em className={(tab === "main" ? p.body : postText(p, tab)).length > strict ? "is-over" : ""}>{(tab === "main" ? p.body : postText(p, tab as Net)).length.toLocaleString("es-ES")} / {strict.toLocaleString("es-ES")}</em>
                </div>
              </div>
              {over.length > 0 && <p className="mkh-warn">Too long for {over.map((n) => NETS[n].label).join(", ")} — give it its own shorter text.</p>}
            </div>

            <div className="mkh-pe-sec">
              <span className="mkh-lbl">Pictures &amp; link</span>
              <div className="mkh-media">
                {p.media.map((m, i) => (
                  <span key={m.url + i} className="mkh-thumb">{m.kind === "video" ? <video src={m.url} muted /> : <img src={m.url} alt={m.alt ?? ""} />}<button onClick={() => set({ media: p.media.filter((_, j) => j !== i) })} aria-label="Remove">{MhIco.x}</button></span>
                ))}
                <button className="mkh-thumb is-add" onClick={() => fileRef.current?.click()} disabled={busy === "upload"}>{busy === "upload" ? <i className="mkh-spin" /> : MhIco.image}<em>Upload</em></button>
                <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={(e) => void addFile(e.target.files?.[0])} />
                <div className="mkh-media-url">
                  <input className="mk-input" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="…or paste a picture link" onKeyDown={(e) => { if (e.key === "Enter" && /^https?:\/\//.test(mediaUrl)) { set({ media: [...p.media, { url: mediaUrl, kind: "image" }] }); setMediaUrl(""); } }} />
                  <button className="mk-btn is-sm" disabled={!/^https?:\/\//.test(mediaUrl)} onClick={() => { set({ media: [...p.media, { url: mediaUrl, kind: "image" }] }); setMediaUrl(""); }}>Add</button>
                </div>
              </div>
              {needsImg && <p className="mkh-warn">Instagram, TikTok and YouTube need a picture or a video.</p>}
              <label className="mkh-linkin">{MhIco.link}<input value={p.link_url ?? ""} onChange={(e) => set({ link_url: e.target.value || null })} placeholder="Link to share (optional)" /></label>
            </div>

            <div className="mkh-pe-sec mkh-pe-when">
              <span className="mkh-lbl">When</span>
              <div className="mkh-when-row">
                <div className="mkh-dp"><DatePicker value={when.d} onChange={(d) => setWhen((v) => ({ ...v, d }))} placeholder="Day" /></div>
                <input type="time" value={when.t} onChange={(e) => setWhen((v) => ({ ...v, t: e.target.value }))} />
                {when.d && <button className="mk-linkbtn" onClick={() => { setWhen({ d: "", t: "09:00" }); set({ scheduled_at: null }); }}>No date</button>}
              </div>
              <input className="mk-input mkh-series-in" value={p.series ?? ""} onChange={(e) => set({ series: e.target.value || null })} placeholder="Series or campaign (optional), e.g. Q4 launch" />
            </div>

            {p.status === "published" && (
              <div className="mkh-pe-sec">
                <span className="mkh-lbl">Results</span>
                <div className="mkh-results">
                  {p.networks.map((n) => (
                    <div key={n} className="mkh-res-row">
                      <NetBadge n={n} />
                      <input className="mk-input is-url" value={p.results?.[n]?.url ?? ""} onChange={(e) => res(n, "url", e.target.value)} placeholder="Post link" />
                      {(["impressions", "likes", "comments", "shares", "clicks"] as const).map((k) => (
                        <label key={k}><em>{k}</em><input type="number" min={0} value={p.results?.[n]?.[k] ?? ""} onChange={(e) => res(n, k, e.target.value)} /></label>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <aside className="mkh-pe-side">
            <div className="mkh-pv-tabs">{p.networks.map((n) => <button key={n} className={pv === n ? "is-on" : ""} onClick={() => setPv(n)}><NetBadge n={n} size="sm" />{NETS[n].label}</button>)}</div>
            {p.networks.length ? <SocialPreview n={pv} text={pvText} media={p.media} link={p.link_url} name={acct(pv)?.name ?? x.me.company ?? "Your page"} /> : <p className="mkh-fine">Choose a network to see the preview.</p>}
          </aside>
        </div>
        <footer className="mkh-drawer-f">
          {err && <span className="mk-msg is-err">{err}</span>}
          {p.id && <MkConfirm label="Delete" className="is-ghost is-danger-text" ask="Delete this post?" yes="Delete" onYes={() => void del()} />}
          <span className="mk-grow" />
          {(p.status === "idea" || p.status === "draft" || !p.id) && (
            <div className="mkh-statsel" title="Saved as"><Select value={p.status === "idea" ? "idea" : "draft"} onChange={(v) => set({ status: v as PostStatus })}
              options={[{ value: "idea", label: "Save as idea" }, { value: "draft", label: "Save as draft" }]} /></div>
          )}
          <button className="mk-btn" disabled={!!busy} onClick={() => void save(p.status === "scheduled" ? (when.d ? "scheduled" : "draft") : p.status).then((id) => { if (id) onClose(); })}>{busy && busy !== "scheduled" && busy !== "upload" ? "Saving…" : "Save"}</button>
          {p.status !== "published" && <button className="mk-btn" disabled={!!busy} onClick={() => void save().then((id) => { if (id) { onClose(); x.publish({ ...p, id }); } })}>Publish now</button>}
          {p.status !== "published" && <button className="mk-btn is-primary" disabled={!!busy || !when.d} onClick={() => void save("scheduled").then((id) => { if (id) onClose(); })} title={when.d ? "" : "Pick a day first"}>{MhIco.cal}Schedule</button>}
          {p.status === "published" && <button className="mk-btn is-primary" disabled={!!busy} onClick={() => void save("published").then((id) => { if (id) onClose(); })}>Save results</button>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** How the post looks on each network (a neutral sketch of the feed, not the network's own design). */
function SocialPreview({ n, text, media, link, name }: { n: Net; text: string; media: MkPost["media"]; link: string | null; name: string }) {
  const [more, setMore] = useState(false);
  const cut = n === "linkedin" ? 210 : n === "instagram" ? 125 : n === "facebook" ? 480 : 99999;
  const shown = more || text.length <= cut ? text : `${text.slice(0, cut).trimEnd()}…`;
  const img = media[0];
  const body = (
    <p className="mkh-spv-text">{shown}{!more && text.length > cut && <button onClick={() => setMore(true)}>{n === "instagram" ? "more" : "…see more"}</button>}</p>
  );
  return (
    <div className={`mkh-spv is-${n}`} style={{ ["--n" as string]: NETS[n].color } as CSSProperties}>
      <div className="mkh-spv-top">
        <span className="mkh-spv-av">{initials(name || "Y")}</span>
        <span className="mkh-spv-id"><b>{name || "Your page"}</b><em>{n === "x" || n === "threads" ? `@${(name || "you").toLowerCase().replace(/[^a-z0-9]+/g, "")}` : n === "instagram" ? "" : "Now"}</em></span>
        <NetBadge n={n} size="sm" />
      </div>
      {n === "instagram" || n === "tiktok" ? (
        <>
          <div className={`mkh-spv-media is-square ${img ? "" : "is-empty"}`}>{img ? (img.kind === "video" ? <video src={img.url} muted /> : <img src={img.url} alt="" />) : <span>{MhIco.image}Picture needed</span>}</div>
          <div className="mkh-spv-acts"><i /><i /><i /></div>
          <p className="mkh-spv-text"><b>{(name || "you").toLowerCase().replace(/\s+/g, "")}</b> {shown.replace(/\n/g, " ")}{!more && text.length > cut && <button onClick={() => setMore(true)}>more</button>}</p>
        </>
      ) : (
        <>
          {body}
          {img && <div className="mkh-spv-media">{img.kind === "video" ? <video src={img.url} muted /> : <img src={img.url} alt="" />}</div>}
          {!img && link && <div className="mkh-spv-link"><span>{link.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</span><b>{link.replace(/^https?:\/\//, "")}</b></div>}
          <div className="mkh-spv-acts is-row"><i /><i /><i /><i /></div>
        </>
      )}
      <span className="mkh-spv-count">{text.length.toLocaleString("es-ES")} / {NETS[n].limit.toLocaleString("es-ES")} characters</span>
    </div>
  );
}

function PublishDialog({ x, p, onClose }: { x: HubCtx; p: MkPost; onClose: () => void }) {
  const [urls, setUrls] = useState<Record<string, string>>(() => Object.fromEntries(p.networks.map((n) => [n, p.results?.[n]?.url ?? ""])));
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (n: Net) => {
    const text = postText(p, n) + (p.link_url && !postText(p, n).includes(p.link_url) && n !== "facebook" ? `\n\n${p.link_url}` : "");
    try { await navigator.clipboard?.writeText(text); setCopied(n); } catch { /* clipboard blocked */ }
    const u = NETS[n].share ? NETS[n].share!(text, p.link_url ?? "") : NETS[n].home;
    window.open(u, "_blank", "noopener");
    setDone((d) => ({ ...d, [n]: true }));
  };
  const finish = async () => {
    setBusy(true);
    const results = { ...p.results };
    p.networks.forEach((n) => { results[n] = { ...(results[n] ?? {}), url: urls[n] || results[n]?.url }; });
    const r = await savePostRow({ status: "published", published_at: new Date().toISOString(), results }, p.id);
    setBusy(false);
    if (r.error) { x.toast(r.error); return; }
    await x.reload(); x.toast("Marked as published"); onClose();
  };
  return (
    <MhModal title="Publish" sub={<>For each network: the text is copied and the network opens with it — paste, add the picture if any and post. Then mark it as published.</>} onClose={onClose}
      foot={<><span className="mk-grow" /><button className="mk-btn" onClick={onClose}>Later</button><button className="mk-btn is-primary" disabled={busy} onClick={() => void finish()}>{MkIco.check}Mark as published</button></>}>
      <div className="mkh-pub">
        {p.networks.map((n) => (
          <div key={n} className={`mkh-pub-row ${done[n] ? "is-done" : ""}`}>
            <NetBadge n={n} size="lg" />
            <span className="mkh-pub-t"><b>{NETS[n].label}</b><em>{postText(p, n).length} characters{p.media.length ? ` · ${p.media.length} picture${p.media.length > 1 ? "s" : ""} to add` : ""}{copied === n ? " · text copied" : ""}</em></span>
            <button className="mk-btn is-sm" onClick={() => void go(n)}>{MhIco.ext}{done[n] ? "Open again" : `Copy & open ${NETS[n].label}`}</button>
            <input className="mk-input" value={urls[n] ?? ""} onChange={(e) => setUrls((u) => ({ ...u, [n]: e.target.value }))} placeholder="Paste the post link (optional)" />
          </div>
        ))}
        {p.media.length > 0 && <div className="mkh-pub-media">{p.media.map((m, i) => <a key={i} href={m.url} target="_blank" rel="noreferrer" download><img src={m.url} alt="" /></a>)}<em>Open a picture to save it, then add it to the post.</em></div>}
      </div>
    </MhModal>
  );
}

function AiSeries({ x, brief: brief0, onClose }: { x: HubCtx; brief?: string; onClose: () => void }) {
  const mon = (() => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d; })();
  const plus = (d: Date, n: number) => { const y = new Date(d); y.setDate(y.getDate() + n); return y; };
  const [brief, setBrief] = useState(brief0 ?? "");
  const [nets, setNets] = useState<Net[]>(["linkedin"]);
  const [count, setCount] = useState(6);
  const [from, setFrom] = useState(dayKey(mon));
  const [to, setTo] = useState(dayKey(plus(mon, 27)));
  const [tone, setTone] = useState("professional, human, insightful");
  const [lang, setLang] = useState("es");
  const [link, setLink] = useState("");
  const [series, setSeries] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  type G = { title: string; body: string; variants: Record<string, string>; hashtags?: string[]; date: string; time: string; image_idea?: string; keep: boolean };
  const [out, setOut] = useState<G[] | null>(null);
  const [schedule, setSchedule] = useState(true);
  const run = async () => {
    if (!brief.trim()) { setErr("Write what the posts should talk about."); return; }
    setBusy(true); setErr("");
    const r = await aiWrite<{ posts: Omit<G, "keep">[] }>({ kind: "posts", brief, networks: nets, count, from, to, tone, lang, link, company: x.me.company });
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    const got = (r.data.posts ?? []).filter((g) => g && typeof g.body === "string");
    if (!got.length) { setErr("The AI gave no posts — try a more specific brief."); return; }
    setOut(got.map((g) => ({ ...g, variants: g.variants ?? {}, keep: true })));
  };
  const add = async () => {
    if (!out) return;
    setBusy(true);
    const rows = out.filter((g) => g.keep).map((g) => {
      const variants: MkPost["variants"] = {};
      nets.forEach((n) => { if (g.variants?.[n]) variants[n] = { text: g.variants[n] }; });
      const okDate = /^\d{4}-\d{2}-\d{2}$/.test(g.date);
      return { title: g.title, body: g.body + (g.hashtags?.length && !/#\w/.test(g.body) ? `\n\n${g.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}` : ""), variants, networks: nets, media: [], link_url: link || null,
        status: schedule && okDate ? "scheduled" : "draft", scheduled_at: okDate ? atISO(g.date, /^\d{2}:\d{2}$/.test(g.time) ? g.time : "09:00") : null,
        series: series.trim() || null, ai_brief: [brief, g.image_idea ? `Picture: ${g.image_idea}` : ""].filter(Boolean).join("\n"), source: "ai" };
    });
    const { error } = await supabase.from("marketing_posts").insert(rows);
    setBusy(false);
    if (error) { setErr(MK_MISSING.test(error.message) ? "Run 64_marketing_hub.sql in Supabase to save posts." : error.message); return; }
    await x.reload(); x.toast(`${rows.length} post${rows.length === 1 ? "" : "s"} added`); x.go("social"); onClose();
  };
  const kept = out?.filter((g) => g.keep).length ?? 0;
  return (
    <MhModal wide title={<>{MhIco.spark}Plan posts with AI</>} sub="One brief, a series of posts adapted to each network and spread over the dates you choose. You review them before anything is saved." onClose={onClose}
      foot={out ? <><button className="mk-btn" onClick={() => setOut(null)}>{MkIco.back}Change the brief</button><span className="mk-grow" /><label className="cx-switch"><input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} /><i />Schedule them on their dates</label><button className="mk-btn is-primary" disabled={busy || !kept} onClick={() => void add()}>Add {kept} post{kept === 1 ? "" : "s"}</button></>
        : <><span className="mk-grow" />{err && <span className="mk-msg is-err">{err}</span>}<button className="mk-btn is-primary" disabled={busy || !nets.length} onClick={() => void run()}>{busy ? <><i className="mkh-spin" />Writing {count} posts…</> : <>{MhIco.spark}Write {count} posts</>}</button></>}>
      {!out ? (
        <div className="mkh-aiform">
          <label className="mkh-fld is-wide"><span>What should they talk about?</span><textarea rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="e.g. Our month-end close service: why finance teams lose days on Excel, a customer-agnostic tip per week, and an invitation to our webinar on 20 November." /></label>
          <div className="mkh-fld is-wide"><span>Networks</span><div className="mkh-netrow">{NET_KEYS.map((n) => <button key={n} className={`mkh-netbtn ${nets.includes(n) ? "is-on" : ""}`} style={{ ["--n" as string]: NETS[n].color } as CSSProperties} onClick={() => setNets((v) => (v.includes(n) ? v.filter((y) => y !== n) : [...v, n]))}><NetBadge n={n} size="sm" off={!nets.includes(n)} />{NETS[n].label}</button>)}</div></div>
          <label className="mkh-fld"><span>How many</span><div className="mkh-range"><input type="range" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} /><b>{count}</b></div></label>
          <div className="mkh-fld"><span>Between</span><div className="mkh-two"><DatePicker value={from} onChange={setFrom} /><em>and</em><DatePicker value={to} onChange={setTo} /></div></div>
          <div className="mkh-fld"><span>Tone</span><Select value={tone} onChange={setTone} options={[{ value: "professional, human, insightful", label: "Professional & human" }, ...AI_TONES]} /></div>
          <div className="mkh-fld"><span>Language</span><Select value={lang} onChange={setLang} options={AI_LANGS} /></div>
          <label className="mkh-fld"><span>Link to promote</span><input className="mk-input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://… (optional)" /></label>
          <label className="mkh-fld"><span>Series name</span><input className="mk-input" value={series} onChange={(e) => setSeries(e.target.value)} placeholder="e.g. Close faster — Q4" /></label>
        </div>
      ) : (
        <div className="mkh-aiout">
          {err && <span className="mk-msg is-err">{err}</span>}
          {out.map((g, i) => (
            <div key={i} className={`mkh-gen ${g.keep ? "" : "is-off"}`}>
              <label className="mkh-gen-keep"><input type="checkbox" checked={g.keep} onChange={(e) => setOut((o) => o!.map((y, j) => (j === i ? { ...y, keep: e.target.checked } : y)))} /></label>
              <div className="mkh-gen-when"><b>{/^\d{4}-\d{2}-\d{2}$/.test(g.date) ? new Date(`${g.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "No date"}</b><em>{g.time}</em></div>
              <div className="mkh-gen-txt">
                <input className="mkh-gen-title" value={g.title} onChange={(e) => setOut((o) => o!.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))} />
                <textarea rows={4} value={g.body} onChange={(e) => setOut((o) => o!.map((y, j) => (j === i ? { ...y, body: e.target.value } : y)))} />
                <span className="mkh-gen-meta">{nets.map((n) => <span key={n} title={g.variants?.[n] ?? ""}><NetBadge n={n} size="sm" />{(g.variants?.[n] ?? g.body).length} ch.</span>)}{g.image_idea && <em>{MhIco.image}{g.image_idea}</em>}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </MhModal>
  );
}

function ImportPosts({ x, onClose }: { x: HubCtx; onClose: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [asSched, setAsSched] = useState(true);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const grid = useMemo(() => (text.trim() ? parseCsv(text) : []), [text]);
  const head = (grid[0] ?? []).map((h) => norm(h));
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const ci = { date: col("date", "fecha", "day", "dia"), time: col("time", "hora"), nets: col("network", "red", "channel", "canal", "platform"), text: col("text", "texto", "body", "copy", "post", "contenido"), title: col("title", "titulo", "name", "nombre"), img: col("image", "imagen", "media", "picture", "foto"), link: col("link", "url", "enlace"), series: col("series", "serie", "campaign", "campana") };
  const netOf = (s: string): Net[] => s.split(/[,;/|+]+/).map((y) => norm(y)).map((y) => (y.startsWith("link") || y === "li" || y === "in" ? "linkedin" : y.startsWith("insta") || y === "ig" ? "instagram" : y.startsWith("face") || y === "fb" ? "facebook" : y === "x" || y.startsWith("twit") ? "x" : y.startsWith("tik") ? "tiktok" : y.startsWith("thread") ? "threads" : y.startsWith("you") || y === "yt" ? "youtube" : null)).filter(Boolean) as Net[];
  const toDate = (s: string) => { const t = s.trim(); let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`; m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/); if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; return ""; };
  const rows = grid.slice(1).map((r, i) => {
    const g = (k: keyof typeof ci) => (ci[k] >= 0 ? String(r[ci[k]] ?? "").trim() : "");
    const date = toDate(g("date")); const time = /^\d{1,2}:\d{2}/.test(g("time")) ? g("time").slice(0, 5).padStart(5, "0") : "09:00";
    const nets = ci.nets >= 0 ? netOf(g("nets")) : (["linkedin"] as Net[]);
    const problems = [!g("text") && "no text", !nets.length && "no network", g("date") && !date && "date not understood"].filter(Boolean) as string[];
    return { i, date, time, nets, text: g("text"), title: g("title"), img: g("img"), link: g("link"), series: g("series"), problems };
  });
  const good = rows.filter((r) => !r.problems.length);
  const doImport = async () => {
    setBusy(true); setErr("");
    const payload = good.map((r) => ({ title: r.title || null, body: r.text, variants: {}, networks: r.nets, media: /^https?:\/\//.test(r.img) ? [{ url: r.img, kind: "image" }] : [], link_url: r.link || null,
      status: asSched && r.date ? "scheduled" : "draft", scheduled_at: r.date ? atISO(r.date, r.time) : null, series: r.series || null, source: "import" }));
    for (let i = 0; i < payload.length; i += 200) {
      const { error } = await supabase.from("marketing_posts").insert(payload.slice(i, i + 200));
      if (error) { setBusy(false); setErr(MK_MISSING.test(error.message) ? "Run 64_marketing_hub.sql in Supabase to save posts." : error.message); return; }
    }
    setBusy(false); await x.reload(); x.toast(`${payload.length} posts imported`); x.go("social"); onClose();
  };
  const sample = "date,time,networks,title,text,image,link\n2026-11-03,09:00,linkedin+x,Close faster,\"Month-end in 3 days instead of 8: what changes…\",,https://example.com\n2026-11-05,13:00,instagram,Behind the scenes,\"A day with our consulting team ☕\",https://example.com/photo.jpg,";
  return (
    <MhModal wide title={<>{MhIco.upload}Import posts</>} sub="A spreadsheet saved as CSV: one row per post. Columns are found by name — date, time, networks, title, text, image, link, series." onClose={onClose}
      foot={<><button className="mk-btn" onClick={() => downloadBlob(new Blob([sample], { type: "text/csv" }), "posts-template.csv")}>{MkIco.dl}Template</button><span className="mk-grow" />{err && <span className="mk-msg is-err">{err}</span>}<label className="cx-switch"><input type="checkbox" checked={asSched} onChange={(e) => setAsSched(e.target.checked)} /><i />Schedule rows with a date</label><button className="mk-btn is-primary" disabled={busy || !good.length} onClick={() => void doImport()}>Import {good.length} post{good.length === 1 ? "" : "s"}</button></>}>
      {!grid.length ? (
        <div className="mkh-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void f.text().then(setText); }}>
          <span className="mkh-drop-ico">{MhIco.upload}</span>
          <b>Drop a CSV here</b>
          <em>or</em>
          <button className="mk-btn" onClick={() => fileRef.current?.click()}>Choose a file</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(setText); }} />
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="…or paste the rows here" />
        </div>
      ) : (
        <div className="mkh-imp">
          <div className="mkh-imp-h"><b>{fmtN(rows.length)} rows</b><em>{good.length} ready{rows.length - good.length ? ` · ${rows.length - good.length} with problems (left out)` : ""}</em><span className="mk-grow" /><button className="mk-linkbtn" onClick={() => setText("")}>Use another file</button></div>
          {ci.text < 0 && <p className="mkh-warn">No “text” column found — name the column with the post text “text”.</p>}
          <div className="mkh-imp-rows">
            {rows.slice(0, 200).map((r) => (
              <div key={r.i} className={`mkh-imp-row ${r.problems.length ? "is-bad" : ""}`}>
                <span className="mkh-imp-when">{r.date ? new Date(`${r.date}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "No date"}<em>{r.date ? r.time : ""}</em></span>
                <span className="mkh-nets">{r.nets.map((n) => <NetBadge key={n} n={n} size="sm" />)}</span>
                <span className="mkh-imp-txt"><b>{r.title || r.text.split("\n")[0].slice(0, 60)}</b><em>{r.text.slice(0, 120)}</em></span>
                {r.problems.length ? <span className="mkh-tag is-fail">{r.problems.join(", ")}</span> : r.img ? <span className="mkh-tag">{MhIco.image}picture</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </MhModal>
  );
}

/* ═══════════════════════════ Calendar ═══════════════════════════ */
function CalendarTab({ x }: { x: HubCtx }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [show, setShow] = useState<{ email: boolean; nets: Set<Net> }>({ email: true, nets: new Set(NET_KEYS) });
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const first = new Date(month); const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const todayK = dayKey(new Date());
  type It = { key: string; t: number; label: string; kind: "email" | "post"; color: string; nets: Net[]; status: string; open: () => void; post?: MkPost };
  const byDay = useMemo(() => {
    const m = new Map<string, It[]>();
    const push = (d: Date, it: It) => { const k = dayKey(d); const a = m.get(k) ?? []; a.push(it); m.set(k, a); };
    if (show.email) x.campaigns.forEach((c) => { const at = c.status === "scheduled" ? c.scheduled_at : c.started_at; if (at) push(new Date(at), { key: c.id, t: new Date(at).getTime(), label: c.name, kind: "email", color: "#12b57f", nets: [], status: c.status, open: () => x.openCampaign(c.id) }); });
    x.posts.forEach((p) => { const at = postWhen(p); if (!at || p.status === "cancelled" || !p.networks.some((n) => show.nets.has(n))) return; push(new Date(at), { key: p.id, t: new Date(at).getTime(), label: p.title || p.body.slice(0, 40) || "Post", kind: "post", color: NETS[p.networks[0] ?? "linkedin"].color, nets: p.networks, status: isDue(p) ? "due" : p.status, open: () => x.openPost(p), post: p }); });
    m.forEach((a) => a.sort((p, q) => p.t - q.t));
    return m;
  }, [x.campaigns, x.posts, show]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = async (postId: string, k: string) => {
    const p = x.posts.find((y) => y.id === postId); if (!p) return;
    const t = p.scheduled_at ? hhmm(p.scheduled_at) : "09:00";
    const r = await savePostRow({ scheduled_at: atISO(k, t), status: p.status === "published" ? "published" : p.status === "idea" || p.status === "draft" ? p.status : "scheduled" }, p.id);
    if (r.error) x.toast(r.error); else { await x.reload(); x.toast(`Moved to ${new Date(`${k}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`); }
  };
  const used = NET_KEYS.filter((n) => x.posts.some((p) => p.networks.includes(n)));
  const unplanned = x.posts.filter((p) => !p.scheduled_at && (p.status === "draft" || p.status === "idea"));
  return (
    <div className="mkh-cal-wrap">
      <div className="mkh-cal">
        <div className="mkh-toolbar">
          <button className="mk-btn is-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
          <h2 className="mkh-cal-title">{month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h2>
          <button className="mk-btn is-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">›</button>
          <button className="mk-btn is-sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
          <span className="mk-grow" />
          <div className="mkh-netpick">
            <button className={show.email ? "is-on" : ""} onClick={() => setShow((s) => ({ ...s, email: !s.email }))}><i className="mkh-chip-mail">{MkIco.mail}</i>E-mail</button>
            {used.map((n) => <button key={n} className={show.nets.has(n) ? "is-on" : ""} onClick={() => setShow((s) => { const ns = new Set(s.nets); if (ns.has(n)) ns.delete(n); else ns.add(n); return { ...s, nets: ns }; })}><NetBadge n={n} size="sm" off={!show.nets.has(n)} />{NETS[n].label}</button>)}
          </div>
        </div>
        <div className="mkh-cal-grid">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d} className="mkh-cal-dow">{d}</span>)}
          {cells.map((d) => {
            const k = dayKey(d);
            const its = byDay.get(k) ?? [];
            const inM = d.getMonth() === month.getMonth();
            return (
              <div key={k} className={`mkh-cell ${inM ? "" : "is-out"} ${k === todayK ? "is-today" : ""} ${over === k ? "is-over" : ""} ${k < todayK ? "is-past" : ""}`}
                onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(k); } }} onDragLeave={() => setOver((o) => (o === k ? null : o))}
                onDrop={(e) => { e.preventDefault(); const id = drag; setDrag(null); setOver(null); if (id) void move(id, k); }}>
                <span className="mkh-cell-h"><b>{d.getDate()}</b><button className="mkh-cell-add" onClick={() => x.newPostAt(k)} aria-label="New post this day">{MkIco.plus}</button></span>
                <div className="mkh-cell-items">
                  {its.slice(0, 4).map((it) => (
                    <button key={it.key} className={`mkh-ev is-${it.kind} is-${it.status}`} style={{ ["--n" as string]: it.color } as CSSProperties} onClick={it.open}
                      draggable={it.kind === "post"} onDragStart={(e) => { setDrag(it.key); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDrag(null); setOver(null); }} title={it.label}>
                      <em>{new Date(it.t).toTimeString().slice(0, 5)}</em><span>{it.label}</span>
                      {it.kind === "email" ? <i className="mkh-chip-mail">{MkIco.mail}</i> : it.nets.length > 1 ? <small>+{it.nets.length - 1}</small> : null}
                    </button>
                  ))}
                  {its.length > 4 && <span className="mkh-ev-more">+{its.length - 4} more</span>}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mkh-fine">Drag a post to another day to move it — its time stays the same.</p>
      </div>
      <aside className="mkh-panel mkh-unpl">
        <div className="mkh-sec-h"><h2>Not planned yet</h2><em>{unplanned.length}</em></div>
        <p className="mkh-fine">Drafts and ideas without a date. Drag one onto a day.</p>
        {unplanned.map((p) => (
          <button key={p.id} className="mkh-unpl-item" draggable onDragStart={(e) => { setDrag(p.id); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDrag(null); setOver(null); }} onClick={() => x.openPost(p)}>
            <i className="mkh-grip">{MhIco.grip}</i>
            <span><b>{p.title || p.body.slice(0, 40) || "Untitled"}</b><em>{p.networks.map((n) => NETS[n].label).join(", ")}</em></span>
            <span className={`mkh-st is-${p.status}`}>{POST_STATUS[p.status]}</span>
          </button>
        ))}
        {!unplanned.length && <button className="mk-btn is-sm" onClick={() => x.openAi()}>{MhIco.spark}Plan posts with AI</button>}
      </aside>
    </div>
  );
}

/* ═══════════════════════════ Audiences ═══════════════════════════ */
function AudiencesTab({ x }: { x: HubCtx }) {
  const [sub, setSub] = useState<"lists" | "unsubs">("lists");
  return (
    <div className="mkh-aud-wrap">
      <div className="mkh-toolbar">
        <MkSeg size="sm" value={sub} onChange={setSub} options={[{ value: "lists", label: <>{MkIco.list}Lists</>, count: x.lists.length }, { value: "unsubs", label: <>{MkIco.shield}Do not contact</>, count: x.unsubs.length }]} />
        <em className="mkh-fine">{sub === "lists" ? "Who you reach: pick contacts or companies by any field — the list can update itself or stay fixed." : "Addresses that never get campaigns. People who click “unsubscribe” land here by themselves."}</em>
      </div>
      {sub === "lists"
        ? <ListsTab w={x.w} eng={x.eng} lists={x.lists} members={x.members} optOut={x.optOut} missing={x.missing} onChange={x.reload} />
        : <UnsubsTab unsubs={x.unsubs} w={x.w} missing={x.missing} onChange={x.reload} />}
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
      const mail = buildMail(c, row, { tracking: await trackingReady(), from: footerMail ?? "" });
      const res = await PROVIDER.send({
        to: [row.email], subject: mail.subject, html: mail.html,
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
