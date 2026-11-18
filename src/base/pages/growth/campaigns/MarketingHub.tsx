/* eslint-disable @typescript-eslint/no-explicit-any */
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../../../components/api/supabase";
import { PageLoader } from "../../../../components/framework/PageCube";
import SalesMultiFilter from "../../sales/sales/SalesMultiFilter";
import DatePicker from "../../../framework/DatePicker";
import TimePicker from "../../../framework/TimePicker";
import { useBackToClose } from "../../../framework/useBackToClose";
import { useCloseGuard } from "../../../framework/Dock";
import { downloadBlob, tableToCsv, tableToXlsx, type ExportCell } from "../../../framework/exportFile";
import { inPeriod, PERIODS } from "../../reports/reportsEngine";
import { listTrackingFields, type TrackingField } from "../../sales/extras/trackingFieldsApi";
import { listTrackings, loadAllTrackingOwners, loadAllTrackingEmployees, loadPotentialTotals, type Tracking } from "../../sales/sales/salesApi";
import { listPipelines } from "../../settings/pipelineApi";
import { loadProducts } from "../../settings/catalogApi";
import {
  listCompanyFields, listContactFields, loadRelationshipSets, listEmployees, loadContactAssignees, loadCompanyAssignees, pagedAll,
  type Company, type Contact, type ContactField, type CompanyField, type RelationshipSets,
} from "../../companies/companiesApi";
import { buildCatalog, contactMatches, condReady, cellOf, formatOf, OPS, DEFAULT_OP, NO_VALUE, type XF, type Ctx, type Cond, type Src, type Root, type LastTouch } from "./exportCatalog";
import { listImportBatches, batchLabel } from "./importBatches";
import Select from "../../../framework/Select";
import LinkPopover, { captureLinkTarget, placeLink, type LinkTarget } from "../../../framework/LinkPopover";
import { sendOutlookMail, outlookMailStatus, type OutlookMail, type OutlookMailResult } from "../../../../components/api/outlookSync";
import { sendFromAccount, publishPostNow, myConnections, NO_CONNECTIONS, linkPreview, type MyConnections, type PostMention, type LinkPreview, type LiPage } from "../../../../components/api/marketingHub";
import { MentionArea, PostRich } from "./PostMentions";
import { loadDealPhaseIndex, type PhaseHit } from "../../../api/dealPhaseIndex";
import { BRANDS } from "./brandIcons";
import { useNavigate } from "react-router-dom";
import ActionsMenu, { type ActionItem } from "../../../framework/ActionsMenu";
import "./MarketingHub.css";
import "./MarketingOverview.css";
import "./AudiencesModern.css";
import "./MarketingCalendar.css";
import { HomeBoard, compactAll, firstFit, newId, COLS, GAP, type BoardItem, type BoardKit } from "../../homepage/HomePage";
import { loadPrefs, savePref } from "../../companies/companiesApi";
import { KpiStrip, type FigDef } from "./kpiStrip";
import FormsTab from "./forms/MarketingForms";
import MkWorkflows, { type WfWorld } from "./workflows/MkWorkflows";
import { emailBlock, type MkForm } from "./forms/formsKit";
import { NumInput } from "../../../framework/NumInput";

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
  companyFields: CompanyField[]; dealFields: TrackingField[]; rel: RelationshipSets | null; people: Record<string, string>; former?: string[];
  contactAssignees: Record<string, string[]>; companyAssignees: Record<string, string[]>;
  owners: Record<string, string>; team: Record<string, string[]>; dealProducts: Record<string, string[]>;
  dealTotals: Record<string, number>; phaseHistory: Record<string, string[]>;
  /** When each deal entered each phase (SQL 148): "Deal · Entered phase … since …". */
  phaseEntered?: Record<string, PhaseHit[]>;
  imports: Record<string, string>;
};
export async function loadExportWorld(): Promise<{ trackings: Tracking[]; extra: ExportExtra }> {
  const rows = (q: any) => q.then((r: any) => r.data ?? [], () => []);
  const [t, pl, ph, pr, cf, rs, emp, ca, coa, own, tm, totals, tp, ev, ib, df, pix] = await Promise.all([
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
    loadDealPhaseIndex().catch(() => null),
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
      former: (emp as any[]).filter((e) => e.former).map((e) => e.id),
      imports: Object.fromEntries((ib as any[]).map((b) => [b.id, batchLabel(b, people)])),
      contactAssignees: ca as Record<string, string[]>, companyAssignees: coa as Record<string, string[]>,
      owners: own as Record<string, string>, team: tm as Record<string, string[]>,
      dealProducts: group(tp as any[], "tracking_id", "product_id"),
      dealTotals: totals as Record<string, number>,
      // the whole history (one call, not capped at a page of rows) when it came; the plain rows otherwise
      phaseHistory: pix ? Object.fromEntries([...pix.deal].map(([id, hits]) => [id, [...new Set(hits.map((h) => h.p))]])) : group(ev as any[], "tracking_id", "phase_id"),
      phaseEntered: pix ? Object.fromEntries(pix.deal) : {},
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
    people: extra.people, former: extra.former, pipelines: extra.pipelines, phases: extra.phases, products: extra.products,
    clientCompanyIds: extra.rel?.clientCompanyIds ?? new Set(), clientContactIds: extra.rel?.clientContactIds ?? new Set(),
    contactAssignees: extra.contactAssignees, companyAssignees: extra.companyAssignees, owners: extra.owners, team: extra.team,
    dealProducts: extra.dealProducts, dealTotals: extra.dealTotals, phaseHistory: extra.phaseHistory, phaseEntered: extra.phaseEntered, dealsByCompany, shownIds, imports: extra.imports, root,
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
                              {f.kind === "phase" ? (
                                <PhaseCondVal c={c} f={f} onPatch={(p) => patchCond(c.id, p)} />
                              ) : f.kind === "enum" ? (
                                <SalesMultiFilter values={c.vals} onChange={(v) => patchCond(c.id, { vals: v })} placeholder="Choose…" searchFrom={8} options={f.options ?? []} />
                              ) : f.kind === "date" && c.op === "period" ? (
                                <SalesMultiFilter single values={[c.a]} onChange={(v) => v[0] && patchCond(c.id, { a: v[0] })} placeholder="Period" searchFrom={99}
                                  options={PERIODS.filter((p) => p.key !== "all" && p.key !== "custom").map((p) => ({ value: p.key, label: `${p.group} · ${p.label}` }))} />
                              ) : f.kind === "date" ? (
                                <div className="cx-two"><DatePicker value={c.a} onChange={(d) => patchCond(c.id, { a: d })} placeholder="From" /><span>–</span><DatePicker value={c.b} onChange={(d) => patchCond(c.id, { b: d })} placeholder="To" /></div>
                              ) : c.op === "between" ? (
                                <div className="cx-two"><NumInput type="number" value={c.a} onChange={(e) => patchCond(c.id, { a: e.target.value })} placeholder="From" /><span>–</span><NumInput type="number" value={c.b} onChange={(e) => patchCond(c.id, { b: e.target.value })} placeholder="To" /></div>
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
  /** the Gmail / Outlook account (Settings › Integrations) it's sent from; null = your own Outlook connection (SQL 144) */
  sender_account?: string | null;
}
/** One e-mail: through the connected account the campaign names, else your Outlook connection. */
const sendMailVia = (account: string | null | undefined, m: OutlookMail): Promise<OutlookMailResult & { pace?: number }> => (account ? sendFromAccount(account, m) : sendOutlookMail(m));
/** What "another address" needs, per kind of mailbox. */
const fromNote = (kind?: string) => kind === "gmail" ? "Add it first in Gmail › Settings › Accounts › “Send mail as” and confirm the e-mail Google sends."
  : kind === "ionos" ? "IONOS only sends as this mailbox or one of its aliases (IONOS › Email › Aliases)."
  : "In Microsoft 365, your user needs “Send as” on that mailbox.";
interface MkSend {
  id: string; campaign_id: string; contact_id: string | null; email: string; name: string | null; merge: Record<string, string>;
  status: "queued" | "claimed" | "sent" | "failed" | "skipped"; error: string | null; sent_at: string | null; claimed_at: string | null;
  opened_at?: string | null; open_count?: number; clicked_at?: string | null; click_count?: number; last_click_url?: string | null;
  replied_at?: string | null; bounced_at?: string | null; unsubscribed_at?: string | null;
}
interface MkUnsub { id: string; email: string; reason: string | null; source: string; created_at: string }
/** An e-mail kept to start campaigns from (109_mk_templates.sql). */
interface MkTemplate { id: string; name: string; subject: string; preheader: string | null; body_html: string; used_count: number; created_by: string | null; created_at: string; updated_at: string }
const NEEDS_TPL = "E-mail templates need 109_mk_templates.sql in Supabase.";
const tplMissing = (m: string) => /mk_templates|relation|schema cache|does not exist/i.test(m);
async function loadMkTemplates(): Promise<{ rows: MkTemplate[]; missing: boolean }> {
  const { data, error } = await supabase.from("mk_templates").select("*").order("updated_at", { ascending: false });
  if (error) return { rows: [], missing: tplMissing(error.message) };
  return { rows: (data ?? []) as MkTemplate[], missing: false };
}
async function saveMkTemplate(t: Partial<MkTemplate>): Promise<{ row: MkTemplate | null; error: string | null }> {
  const row = { name: t.name?.trim() || "Untitled template", subject: t.subject ?? "", preheader: t.preheader ?? null, body_html: t.body_html ?? "", updated_at: new Date().toISOString() };
  const res = t.id ? await supabase.from("mk_templates").update(row).eq("id", t.id).select("*").single() : await supabase.from("mk_templates").insert(row).select("*").single();
  return { row: (res.data as any) ?? null, error: res.error ? (tplMissing(res.error.message) ? NEEDS_TPL : res.error.message) : null };
}
async function deleteMkTemplate(id: string): Promise<string | null> {
  const { error } = await supabase.from("mk_templates").delete().eq("id", id);
  return error?.message ?? null;
}
/** The template a new campaign starts from (set by "Use" in Templates, taken by the composer once). */
let pendingTpl: MkTemplate | null = null;
/** the audience a new campaign starts with (Forms › Actions › Follow up by e-mail) */
let pendingList: string | null = null;
const takePendingTpl = () => { const t = pendingTpl; pendingTpl = null; if (t?.id) void supabase.from("mk_templates").update({ used_count: (t.used_count ?? 0) + 1 }).eq("id", t.id); return t; };
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
/* {{fields}} shown as chips in the editors (the e-mail itself keeps {{first_name}}) */
const MERGE_LABEL: Record<string, string> = { ...Object.fromEntries(MERGE_FIELDS.map((m) => [m.key, m.label])), unsubscribe_url: "Unsubscribe link", unsubscribe_email: "Unsubscribe e-mail" };
const mkChip = (k: string) => `<span class="mk-fld" contenteditable="false" data-f="${k}">${MERGE_LABEL[k] ?? k}</span>`;
// only in the text: a {{field}} inside a tag (a form link's href) stays as it is
const mkToChips = (h: string) => String(h ?? "").replace(/(<[^>]*>)|\{\{\s*([a-z_]+)\s*\}\}/gi, (m, tag, k) => (tag ? tag : MERGE_LABEL[String(k).toLowerCase()] ? mkChip(String(k).toLowerCase()) : m));
const mkFromChips = (h: string) => String(h ?? "").replace(/<span[^>]*data-f="([a-z_]+)"[^>]*>[\s\S]*?<\/span>/gi, "{{$1}}").replace(/\u200b/g, "");
const mkEsc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A field chip at the caret inside `root` (or at the end of its last paragraph), the caret after it. */
function mkInsertChip(root: HTMLElement, k: string) {
  const sel = window.getSelection();
  let r: Range;
  if (sel && sel.rangeCount && root.contains(sel.getRangeAt(0).commonAncestorContainer)) r = sel.getRangeAt(0);
  else { root.focus(); r = document.createRange(); r.selectNodeContents((root.lastElementChild as HTMLElement | null) && /^(P|DIV|LI|H[1-6])$/.test(root.lastElementChild!.tagName) ? root.lastElementChild! : root); r.collapse(false); }
  r.deleteContents();
  const tmp = document.createElement("span");
  tmp.innerHTML = mkChip(k);
  const chip = tmp.firstChild as Node;
  const after = document.createTextNode("\u200b");
  r.insertNode(after);
  r.insertNode(chip);
  r.setStartAfter(after); r.collapse(true);
  sel?.removeAllRanges(); sel?.addRange(r);
}
/** a one-line chip editor's text back to plain text with {{fields}} */
const mkLineText = (h: string) => mkFromChips(h).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** Text with {{fields}} as chips (lists, cards). */
function ChipText({ text, empty }: { text: string; empty?: string }) {
  if (!text) return <>{empty ?? ""}</>;
  const parts = String(text).split(/(\{\{\s*[a-z_]+\s*\}\})/gi);
  return <>{parts.map((p, i) => { const k = /^\{\{\s*([a-z_]+)\s*\}\}$/i.exec(p)?.[1]?.toLowerCase(); return k && MERGE_LABEL[k] ? <span key={i} className="mk-fld">{MERGE_LABEL[k]}</span> : <span key={i}>{p}</span>; })}</>;
}
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
/** Word / Outlook-pasted markup Exchange can choke on ("UnknownError"): <o:p>, namespaced tags, conditional comments, Mso classes. */
const cleanMailHtml = (h: string) => h
  .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")
  .replace(/<\/?[a-z]+:[a-z0-9]+\b[^>]*>/gi, "")
  .replace(/\s+class="Mso[^"]*"/gi, "")
  .replace(/<p>\s*<\/p>/gi, "")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
/** Microsoft's own hiccups (worth one more try a little later). */
const isTransientMail = (e: string | null) => !!e && /UnknownError|ServiceUnavailable|InternalServer|ServerBusy|TimeoutExpired|MailboxStoreUnavailable|\b50[0-4]\b|Microsoft server error/i.test(e);
/** A send error in words people can act on. */
const mailErrText = (e: string | null | undefined) => {
  if (!e) return "Failed";
  if (isTransientMail(e)) return "Microsoft server error — press Retry";
  if (/Connect Outlook/i.test(e)) return "Outlook wasn't connected";
  const m = /"message":"([^"]+)"/.exec(e);
  return m ? m[1] : e.replace(/^Graph error:\s*/, "").slice(0, 120);
};
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
  return { subject: mergeText(c.subject, vals, false).replace(/\s+/g, " ").trim(), html: emailHtml(cleanMailHtml(pre + mergeText(tpl, vals, true) + pixel)) };
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
interface PostResult { url?: string; impressions?: number; likes?: number; comments?: number; shares?: number; clicks?: number;
  /** published by itself (marketing-hub, LinkedIn): when, or why it couldn't */
  auto_at?: string | null; auto_error?: string | null; urn?: string }
interface MkPost {
  id: string; title: string | null; body: string; variants: Record<string, { text?: string }>; networks: Net[];
  media: { url: string; kind: "image" | "video"; alt?: string }[]; link_url: string | null; status: PostStatus;
  scheduled_at: string | null; published_at: string | null; results: Record<string, PostResult>; series: string | null;
  source: string; ai_brief?: string | null; created_at: string; updated_at: string;
  /** { linkedin: <connected account id> } — publishes by itself at its time (SQL 144) */
  auto_accounts?: Record<string, string>;
  /** "@name" in the text tagged on LinkedIn (SQL 146) */
  mentions?: PostMention[];
  /** the link's own card: title, picture… (SQL 146) */
  link_preview?: LinkPreview | null;
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
/** The CRM the marketing tools read (every contact, company, deal…): kept for a few minutes, so coming back to Marketing is instant. */
let mkWorldCache: { at: number; p: Promise<MkWorld> } | null = null;
const MK_WORLD_TTL = 5 * 60_000;
function marketingWorld(fresh = false): Promise<MkWorld> {
  if (!fresh && mkWorldCache && Date.now() - mkWorldCache.at < MK_WORLD_TTL) return mkWorldCache.p;
  const p = loadMarketingWorld();
  mkWorldCache = { at: Date.now(), p };
  p.catch(() => { mkWorldCache = null; });
  return p;
}
/** When we were last in touch with everyone: read after the rest (only some list rules and columns need it). */
const mkTouchCache = new WeakMap<MkWorld, Promise<LastTouch | undefined>>();
function marketingTouch(w: MkWorld): Promise<LastTouch | undefined> {
  if (w.touch) return Promise.resolve(w.touch);
  if (!mkTouchCache.has(w)) mkTouchCache.set(w, loadLastTouch(w.contacts, w.trackings).catch(() => undefined));
  return mkTouchCache.get(w)!;
}
async function loadMarketingWorld(): Promise<MkWorld> {
  const [ct, links, cos, cf, w] = await Promise.all([
    mkAll<any>("contacts"), mkAll<any>("company_contacts", "contact_id, company_id"), mkAll<any>("companies"),
    listContactFields().catch(() => [] as ContactField[]), loadExportWorld(),
  ]);
  const by: Record<string, string[]> = {};
  links.rows.forEach((l: any) => { (by[l.contact_id] ??= []).push(l.company_id); });
  const contacts = ct.rows.map((r: any) => ({ ...r, companyIds: by[r.id] ?? [] })) as Contact[];
  return {
    contacts,
    companies: (cos.rows as Company[]).sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""))),
    contactFields: cf, trackings: w.trackings, extra: w.extra,
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
  return useMemo(() => makeMkEngine(w), [w]);
}
/** The list engine for a CRM world (the same rules run on the server: 155_mk_list_engine.sql). */
function makeMkEngine(w: MkWorld | null) {
  {
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
      people: x.people, former: x.former, pipelines: x.pipelines, phases: x.phases, products: x.products,
      clientCompanyIds: x.rel?.clientCompanyIds ?? new Set(), clientContactIds: x.rel?.clientContactIds ?? new Set(),
      contactAssignees: x.contactAssignees, companyAssignees: x.companyAssignees, owners: x.owners, team: x.team,
      dealProducts: x.dealProducts, dealTotals: x.dealTotals, phaseHistory: x.phaseHistory, phaseEntered: x.phaseEntered, dealsByCompany, imports: x.imports, root,
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
  }
}
type MkEngine = NonNullable<ReturnType<typeof makeMkEngine>>;

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

/** The page's tabs: an icon each, the label of the open one (and of the one under the pointer) slides out; the green pill follows. */
function MkTabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; ico: React.ReactNode; label: string; count?: number }[]; onChange: (v: T) => void }) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [ink, setInk] = useState<{ x: number; w: number } | null>(null);
  const measure = () => {
    const el = wrap.current?.querySelector<HTMLElement>(`[data-v="${CSS.escape(value)}"]`);
    if (el) setInk((cur) => (cur && cur.x === el.offsetLeft && cur.w === el.offsetWidth ? cur : { x: el.offsetLeft, w: el.offsetWidth }));
  };
  useLayoutEffect(() => { measure(); });
  useEffect(() => {
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    if (ro && wrap.current) { ro.observe(wrap.current); wrap.current.querySelectorAll("button").forEach((b) => ro.observe(b)); }
    return () => ro?.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={wrap} className="mkt" role="tablist" aria-label="Marketing">
      {ink && <i className="mkt-ink" style={{ transform: `translateX(${ink.x}px)`, width: ink.w }} />}
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" data-v={o.value} aria-selected={value === o.value} aria-label={o.label} title={o.label}
          className={`mkt-tab ${value === o.value ? "is-on" : ""}`} onClick={() => onChange(o.value)}>
          {o.ico}<span className="mkt-l"><span>{o.label}</span></span>{o.count != null && <em>{o.count}</em>}
        </button>
      ))}
    </div>
  );
}

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
type MhTab = "overview" | "email" | "social" | "calendar" | "audiences" | "forms";
/** what Marketing's other tabs know of the forms (Overview, the e-mail composer) */
type MkFormLite = Pick<MkForm, "id" | "name" | "token" | "status" | "response_count" | "last_response_at" | "settings" | "fields">;
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

/**
 * BASE: this is Enterprise's Marketing page (pages/contacts/ContactExport.tsx), copied as it is; Base's Growth page shows it.
 * One Base addition: `only="calendar"` — the Calendar page's marketing view: just the calendar tab, no header; its tools go
 * into the Calendar's own bar (`barSlot`) and the Calendar's Week | Month switch, arrows and week picker drive it (`calNav`).
 */
export function MarketingPage({ only = null, barSlot = null, calNav = null }: {
  only?: "calendar" | null; barSlot?: HTMLElement | null; calNav?: MkCalNav | null;
} = {}) {
  const [w, setW] = useState<MkWorld | null>(null);
  const eng = useMkEngine(w);
  const [tab, setTabRaw] = useState<MhTab>(() => { if (only) return only; try { const t = sessionStorage.getItem("mk-tab"); return (["overview", "email", "social", "calendar", "audiences", "forms"].includes(t ?? "") ? t : "overview") as MhTab; } catch { return "overview"; } });
  const setTab = (t: MhTab) => { if (only) return; setTabRaw(t); try { sessionStorage.setItem("mk-tab", t); } catch { /* private mode */ } };
  const [missing, setMissing] = useState(false);
  const [hubMissing, setHubMissing] = useState(false);
  const [lists, setLists] = useState<MkList[]>([]);
  const [members, setMembers] = useState<Map<string, string[]>>(new Map());
  const [campaigns, setCampaigns] = useState<MkCampaign[]>([]);
  const [unsubs, setUnsubs] = useState<MkUnsub[]>([]);
  const [posts, setPosts] = useState<MkPost[]>([]);
  const [accounts, setAccounts] = useState<MkAccount[]>([]);
  const [agg, setAgg] = useState<{ by: Map<string, CampAgg>; tracked: boolean }>({ by: new Map(), tracked: true });
  const [forms, setForms] = useState<MkFormLite[]>([]);
  const [conn, setConn] = useState<MyConnections>(NO_CONNECTIONS);
  const [outlookMail, setOutlookMail] = useState<string | null>(null);
  useEffect(() => {
    myConnections().then(setConn).catch(() => setConn({ ...NO_CONNECTIONS, loaded: true }));
    outlookMailStatus().then((st) => setOutlookMail(st.connected && st.mail ? st.email : null)).catch(() => {});
  }, []);
  const navigate = useNavigate();
  const [me, setMe] = useState<{ id: string | null; email: string; company: string }>({ id: null, email: "", company: "" });
  // what is open: a campaign (id or "new"), a post (editor), a dialog
  const [camp, setCamp] = useState<{ id: string | "new"; brief?: string } | null>(null);
  const [post, setPost] = useState<MkPost | null>(null);
  const [dialog, setDialog] = useState<null | { k: "ai"; brief?: string } | { k: "import" } | { k: "publish"; p: MkPost }>(null);
  const [toast, setToast] = useState<string | null>(null);
  const tracking = useTrackingReady();
  /** the marketing tables themselves (campaigns, lists, posts…) are read: the page shows; the CRM behind it follows */
  const [mkReady, setMkReady] = useState(false);
  /** customizing the Overview (its cards, where they sit and how big) */
  const [ovEdit, setOvEdit] = useState(false);
  const [ownBar, setBar] = useState<HTMLElement | null>(null);
  const bar = only && barSlot ? barSlot : ownBar;
  const [colsTick, setColsTick] = useState(0);
  /** Workflows (SQL 149): opened from the Overview, next to the tabs */
  const [flows, setFlowsRaw] = useState(() => { if (only) return false; try { return sessionStorage.getItem("mk-flows") === "1"; } catch { return false; } });
  const setFlows = (v: boolean) => { setFlowsRaw(v); try { if (v) sessionStorage.setItem("mk-flows", "1"); else sessionStorage.removeItem("mk-flows"); } catch { /* private mode */ } };
  const [flowsOn, setFlowsOn] = useState(0);

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
    // forms (135_mk_forms.sql): light, for Overview and the composer; the Forms tab reads its own
    void supabase.from("mk_workflows").select("id", { count: "exact", head: true }).eq("status", "active").then(({ count }: any) => setFlowsOn(count ?? 0), () => {});
    void supabase.from("mk_forms").select("id, name, token, status, response_count, last_response_at, settings, fields").order("updated_at", { ascending: false })
      .then(({ data }: any) => setForms(((data ?? []) as any[]).map((f) => ({ ...f, fields: f.fields ?? [], settings: f.settings ?? {} }))));
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
    setMkReady(true);
  };
  useEffect(() => {
    let alive = true;
    marketingWorld().then((w0) => {
      if (!alive) return;
      setW(w0);
      // last contact dates come after, and the world is refreshed in the background when it's a few minutes old
      marketingTouch(w0).then((touch) => { if (alive && touch) setW((cur) => (cur === w0 ? { ...w0, touch } : cur)); });
    }).catch(() => { if (alive) setW({ contacts: [], companies: [], contactFields: [], trackings: [], extra: {} as any }); });
    void reloadMk();
    supabase.auth.getUser().then(async ({ data }: any) => {
      const id = data?.user?.id ?? null;
      let company = "";
      try { const t = await supabase.from("proposal_templates").select("brand").eq("is_default", true).maybeSingle(); company = (t.data as any)?.brand?.company ?? ""; } catch { /* optional */ }
      setMe({ id, email: data?.user?.email ?? "", company });
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 3200); return () => window.clearTimeout(t); }, [toast]);

  const optOut = useMemo(() => new Set(unsubs.map((u) => u.email.toLowerCase())), [unsubs]);
  const runner = useCampaignRunner({ campaigns, eng, w, lists, members, optOut, me, onChange: reloadMk });
  const due = posts.filter(isDue);
  const go = (t: MhTab) => { setCamp(null); setTab(t); setOvEdit(false); setFlows(false); };
  const newPostAt = (d?: string) => setPost(blankPost(d ? atISO(d, "09:00") : null));
  // opened from the Calendar's marketing view (pages/calendar/CalendarMarketing.tsx): a campaign, a post, a new post on a day
  // or a new e-mail campaign — and back to the calendar once it's closed
  const [deep] = useState<{ kind: "email" | "post" | "new" | "new-email" | "ai"; id?: string; day?: string; nets?: string[]; back?: string } | null>(() => {
    if (only) return null; // BASE: links are for the Growth page, not the Calendar's marketing view
    try { const v = sessionStorage.getItem("mk-open"); sessionStorage.removeItem("mk-open"); return v ? JSON.parse(v) : null; } catch { return null; }
  });
  const deepDone = useRef(false);
  const deepSeen = useRef(false);
  useEffect(() => {
    if (!deep || deepDone.current) return;
    const day = deep.day && /^\d{4}-\d{2}-\d{2}$/.test(deep.day) ? deep.day : undefined;
    if (deep.kind === "email" && deep.id) { deepDone.current = true; setTab("email"); setCamp({ id: deep.id }); return; }
    if (deep.kind === "new-email") { deepDone.current = true; setTab("email"); setCamp({ id: "new" }); return; }
    if (deep.kind === "ai") { deepDone.current = true; setTab("calendar"); setDialog({ k: "ai" }); return; }
    if (deep.kind === "new") {
      deepDone.current = true; setTab("calendar");
      const nets = Array.isArray(deep.nets) ? deep.nets.filter((n): n is Net => n in NETS) : null;
      setPost({ ...blankPost(day ? atISO(day, "09:00") : null), ...(nets ? { networks: nets } : {}) });
      return;
    }
    if (deep.kind === "post" && mkReady) {
      deepDone.current = true;
      const p = posts.find((x) => x.id === deep.id);
      setTab("calendar");
      if (p) setPost(p); else setToast("That post isn't there any more.");
    }
  }, [deep, mkReady, posts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!deep?.back || !deepDone.current) return;
    if (post || camp || dialog) { deepSeen.current = true; return; }
    if (deepSeen.current && /^\/[\w/-]*$/.test(deep.back)) { deepSeen.current = false; navigate(deep.back); }
  }, [post, camp, dialog]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx: HubCtx = {
    w: w!, eng: eng!, lists, members, optOut, campaigns, unsubs, posts, accounts, agg, me, missing, hubMissing, tracking, runner, forms, bar, colsTick,
    conn, outlookMail, connect: () => navigate("/settings", { state: { settingsView: "integrations" } }),
    reload: reloadMk, openCampaign: (id, brief) => { if (only) { setCamp({ id, brief }); return; } setTab("email"); setCamp({ id, brief }); }, openPost: (p) => setPost(p), newPostAt,
    openAi: (brief) => setDialog({ k: "ai", brief }), openImport: () => setDialog({ k: "import" }), publish: (p) => setDialog({ k: "publish", p }), go, toast: setToast,
    calNav,
  };
  const wfWorld: WfWorld = {
    campaigns, posts, forms, lists, accounts: conn.mail, outlookMail, meId: me.id, toast: setToast,
    nets: NET_KEYS.map((k) => ({ key: k, label: NETS[k].label, color: NETS[k].color })),
    onTemplates: () => { try { sessionStorage.setItem("mk-email-view", "templates"); } catch { /* private mode */ } go("email"); },
    onConnect: ctx.connect,
  };
  const openFlows = () => { if (tab !== "overview") go("overview"); setOvEdit(false); setFlows(true); };

  return (
    <div className={`mk mkh mk-mod ${only ? `is-only is-only-${only}` : ""}`}>
      {!(only && barSlot) && <header className="mkh-bar">
        <div className="mkh-bar-id">
          <span className="mkh-bar-ico">{MkIco.megaphone}</span>
          <h1>Marketing</h1>
        </div>
        <MkTabs value={tab} onChange={go}
          options={[
            { value: "overview", ico: MhIco.grid, label: "Overview" },
            { value: "email", ico: MkIco.mail, label: "E-mail", count: campaigns.length || undefined },
            { value: "social", ico: MhIco.social, label: "Social", count: posts.length || undefined },
            { value: "calendar", ico: MhIco.cal, label: "Calendar" },
            { value: "audiences", ico: MkIco.people, label: "Audiences", count: lists.length || undefined },
            { value: "forms", ico: MhIco.form, label: "Forms", count: forms.length || undefined },
          ]} />
        {tab === "overview" && (
          <button type="button" className={`mkh-wf ${flows ? "is-on" : ""}`} onClick={() => (flows ? setFlows(false) : openFlows())} aria-pressed={flows}
            title={flows ? "Back to the overview" : "Workflows: steps that start by themselves after an e-mail, a post or a form"}>
            {MhIco.flow}<span className="mkx-lbl">Workflows</span>{flowsOn > 0 && <em title={`${flowsOn} switched on`}>{flowsOn}</em>}
          </button>
        )}
        <div className={`mkh-tools ${(tab === "email" && !camp) || tab === "social" || tab === "audiences" || tab === "calendar" || tab === "forms" ? "is-on" : ""}`} ref={setBar} />
        {runner.running && <button className="mkh-live" onClick={() => { const c = campaigns.find((x) => x.id === runner.running); if (c) ctx.openCampaign(c.id); }}><i className="mk-pulse" />Sending</button>}
        {due.length > 0 && <button className="mkh-due" onClick={() => go("social")} title={`${due.length} ready to publish`}>{MhIco.bell}{due.length}<span className="mkx-lbl"> ready to publish</span></button>}
        <ActionsMenu items={([
          ["mail", MkIco.mail, "E-mail campaign", "Write it, pick a list, track who opens", "green", "M", () => ctx.openCampaign("new")],
          ["post", MhIco.social, "Social post", "LinkedIn, Instagram, X… with previews", "blue", "S", () => newPostAt()],
          ["ai", MhIco.spark, "Plan posts with AI", "A series of posts from one brief", "violet", "A", () => ctx.openAi()],
          ["import", MhIco.upload, "Import posts", "A CSV with dates, networks and texts", "amber", "I", () => ctx.openImport()],
          ["list", MkIco.list, "Audience list", "Who to reach, by any field", "slate", "L", () => go("audiences")],
          ["form", MhIco.form, "Form", "Questions that fill your contacts", "blue", "F", () => go("forms")],
          ["flow", MhIco.flow, "Workflow", "Follow-ups that start after an e-mail, a post or a form", "green", "W", openFlows],
        ] as [string, React.ReactNode, string, string, ActionItem["tone"], string, () => void][]).map(([key, icon, label, hint, tone, shortcut, onSelect]) => ({ key, group: "Marketing", icon, label, hint, tone, shortcut, onSelect } as ActionItem)).concat(tab === "overview" && mkReady && !flows ? [{
          key: "customize", group: "Overview", icon: MhIco.sliders, label: ovEdit ? "Stop customizing" : "Customize the overview", hint: "Choose its cards, move them and resize them", tone: "slate", shortcut: "C", onSelect: () => setOvEdit((v) => !v),
        }] : tab === "email" && !camp && campaigns.length ? [{
          key: "columns", group: "E-mail", icon: MhIco.cols, label: "Columns of the list", hint: "Choose what each campaign shows, and in what order", tone: "slate", shortcut: "C", onSelect: () => setColsTick((n) => n + 1),
        }] : [])} />
      </header>}

      {(missing || hubMissing) && <MhSetup missing={missing} hubMissing={hubMissing} />}
      {runner.banner && <div className={`mk-banner ${runner.banner.tone === "warn" ? "is-warn" : "is-live"}`}>{runner.banner.tone !== "warn" && <i className="mk-pulse" />}{runner.banner.text}</div>}

      {/* the bar stays; each tab keeps its own tools still and scrolls only its content (the composer and a report scroll as a whole) */}
      <main className="mkh-body is-fixed" key={`${tab}${camp ? `:${camp.id}` : ""}${flows && tab === "overview" ? ":flows" : ""}`}>
        {/* campaigns, posts and the calendar show as soon as their own tables are read; lists and the composer wait for the CRM */}
        {tab === "forms" ? <FormsTab lists={lists} toast={setToast} bar={bar} onListsChanged={reloadMk}
          onCampaign={(listId) => { pendingList = listId; ctx.openCampaign("new"); }} onEmail={(f) => {
            pendingTpl = { id: "", name: f.name, subject: f.settings.title || f.name, preheader: f.settings.intro ?? null, body_html: `<p>Hi {{first_name}},</p><p></p>${emailBlock(f)}<p>Best regards,</p>`, used_count: 0, created_by: null, created_at: "", updated_at: "" };
            ctx.openCampaign("new");
          }} />
          : !mkReady ? <MkLoading /> : tab === "overview" ? (flows ? <MkWorkflows w={wfWorld} onBack={() => { setFlows(false); void reloadMk(); }} /> : <Overview x={ctx} editing={ovEdit} onEditing={setOvEdit} />)
          : tab === "email" ? (camp ? (!w || !eng ? <MkLoading /> : <CampaignView x={ctx} id={camp.id} brief={camp.brief} onBack={() => setCamp(null)} onOpen={(id) => setCamp({ id })} />) : <EmailTab x={ctx} />)
          : tab === "social" ? <SocialTab x={ctx} />
          : tab === "calendar" ? (camp ? (!w || !eng ? <MkLoading /> : <CampaignView x={ctx} id={camp.id} brief={camp.brief} onBack={() => setCamp(null)} onOpen={(id) => setCamp({ id })} />) : <CalendarTab x={ctx} />)
          : !w || !eng ? <MkLoading /> : <AudiencesTab x={ctx} />}
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
  missing: boolean; hubMissing: boolean; tracking: boolean | null; runner: Runner; forms: MkFormLite[];
  /** the page bar's slot, right of the tabs: a tab puts its own tools there */
  bar: HTMLElement | null;
  /** bumped by Actions › "Columns": the E-mail list opens its column chooser */
  colsTick: number;
  /** your accounts from Settings › Integrations (mail to send from, LinkedIn to publish on) + your Outlook connection's address */
  conn: MyConnections; outlookMail: string | null;
  /** Settings › Integrations */
  connect: () => void;
  reload: () => Promise<void>; openCampaign: (id: string | "new", brief?: string) => void; openPost: (p: MkPost) => void; newPostAt: (d?: string) => void;
  openAi: (brief?: string) => void; openImport: () => void; publish: (p: MkPost) => void; go: (t: MhTab) => void; toast: (s: string) => void;
  /** BASE: inside the Calendar page, its own Week | Month switch, arrows and week picker drive this calendar */
  calNav?: MkCalNav | null;
}
export type MkCalNav = { view: "month" | "week"; anchor: Date; dir: 1 | -1; onWeek: (d: Date) => void };

const MhIco = {
  flow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.6" /><circle cx="18" cy="18" r="2.6" /><path d="M6 8.6V12a3 3 0 0 0 3 3h6.4M18 15.4V9a3 3 0 0 0-3-3h-6.4" /></svg>,
  form: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 8h8M8 12h8M8 16h4" /></svg>,
  tpl: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><path d="M3.5 9h17M9 9v11.5" /></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>,
  save: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M7 3v5h8V3M7 21v-7h10v7" /></svg>,
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
  grid: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></svg>,
  cols: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16M15 4v16" /></svg>,
  sliders: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2.2" /><circle cx="10" cy="17" r="2.2" /></svg>,
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
/* ═══════════════════════════ Overview: a board of cards each person arranges ═══════════════════════════ */
type MoKey =
  | "k.reach" | "k.sent" | "k.open" | "k.click" | "k.reply" | "k.bounce" | "k.unsub" | "k.views" | "k.engage" | "k.answers" | "k.planned" | "k.lists"
  | "agenda" | "campaigns" | "funnel" | "trend" | "todo" | "ai" | "nets" | "posts" | "audiences" | "forms" | "drafts" | "week" | "quick" | "optouts";
type MoGroup = "Figures" | "E-mail" | "Social" | "Audiences & forms" | "Plan & act";
interface MoDef { title: string; hint: string; group: MoGroup; tone: string; def: [number, number]; min: [number, number]; fig?: boolean; ico: () => React.ReactNode }
const MO_TONE: Record<string, string> = { green: "#0c9a6a", blue: "#2f6fd6", violet: "#7c4fd8", amber: "#c27a12", rose: "#d14a6a", slate: "#4a6b5e", teal: "#0f8f8a", ink: "#0b241a" };
const MO: Record<MoKey, MoDef> = {
  "k.reach": { title: "Can be e-mailed", hint: "Contacts with an e-mail who haven't opted out", group: "Figures", tone: "green", def: [4, 4], min: [3, 3], fig: true, ico: () => MkIco.people },
  "k.sent": { title: "E-mails delivered", hint: "Last 90 days, with the weeks as bars", group: "Figures", tone: "slate", def: [4, 4], min: [3, 3], fig: true, ico: () => MkIco.send },
  "k.open": { title: "Open rate", hint: "Opened ÷ delivered, last 90 days", group: "Figures", tone: "green", def: [4, 4], min: [3, 3], fig: true, ico: () => MhIco.eye },
  "k.click": { title: "Click rate", hint: "Clicked ÷ delivered, last 90 days", group: "Figures", tone: "blue", def: [4, 4], min: [3, 3], fig: true, ico: () => MhIco.click },
  "k.reply": { title: "Replies", hint: "People who answered a campaign, last 90 days", group: "Figures", tone: "teal", def: [4, 4], min: [3, 3], fig: true, ico: () => MhIco.reply },
  "k.bounce": { title: "Bounce rate", hint: "Addresses that didn't take the e-mail", group: "Figures", tone: "rose", def: [4, 4], min: [3, 3], fig: true, ico: () => MhIco.bounce },
  "k.unsub": { title: "Opted out", hint: "Everyone who unsubscribed, and the last 30 days", group: "Figures", tone: "amber", def: [4, 4], min: [3, 3], fig: true, ico: () => MhIco.x },
  "k.views": { title: "Social views", hint: "Impressions of your published posts", group: "Figures", tone: "violet", def: [4, 4], min: [3, 3], fig: true, ico: () => MhIco.social },
  "k.engage": { title: "Engagement", hint: "Likes, comments and shares ÷ views", group: "Figures", tone: "violet", def: [4, 4], min: [3, 3], fig: true, ico: () => MhIco.spark },
  "k.answers": { title: "Form answers", hint: "Answers to all your forms", group: "Figures", tone: "amber", def: [4, 4], min: [3, 3], fig: true, ico: () => MhIco.form },
  "k.planned": { title: "Planned", hint: "Posts and e-mails in the next 14 days", group: "Figures", tone: "blue", def: [4, 4], min: [3, 3], fig: true, ico: () => MhIco.cal },
  "k.lists": { title: "Audiences", hint: "Your lists and the people in them", group: "Figures", tone: "slate", def: [4, 4], min: [3, 3], fig: true, ico: () => MkIco.list },
  agenda: { title: "Coming up", hint: "The next two weeks, day by day", group: "Plan & act", tone: "green", def: [8, 14], min: [6, 6], ico: () => MhIco.cal },
  campaigns: { title: "Last campaigns", hint: "Open and click rate of each send", group: "E-mail", tone: "green", def: [8, 8], min: [6, 5], ico: () => MkIco.mail },
  funnel: { title: "E-mail funnel", hint: "Delivered → opened → clicked → replied", group: "E-mail", tone: "teal", def: [8, 8], min: [5, 6], ico: () => MkIco.send },
  trend: { title: "Sends by week", hint: "Delivered and opened, the last 12 weeks", group: "E-mail", tone: "blue", def: [12, 7], min: [6, 5], ico: () => MkIco.mail },
  todo: { title: "Needs you", hint: "Posts to publish, sends running, drafts", group: "Plan & act", tone: "amber", def: [7, 9], min: [5, 5], ico: () => MhIco.bell },
  ai: { title: "Write with AI", hint: "An e-mail or a series of posts from one line", group: "Plan & act", tone: "violet", def: [7, 7], min: [5, 6], ico: () => MhIco.spark },
  nets: { title: "Social, by network", hint: "Views, published and scheduled per network", group: "Social", tone: "violet", def: [8, 8], min: [5, 5], ico: () => MhIco.social },
  posts: { title: "Best posts", hint: "Your published posts with the most views", group: "Social", tone: "rose", def: [8, 8], min: [5, 5], ico: () => MhIco.image },
  audiences: { title: "Biggest audiences", hint: "Your lists by the people in them", group: "Audiences & forms", tone: "slate", def: [8, 8], min: [5, 5], ico: () => MkIco.people },
  forms: { title: "Forms", hint: "Live forms, answers and the last one in", group: "Audiences & forms", tone: "amber", def: [8, 7], min: [5, 5], ico: () => MhIco.form },
  drafts: { title: "Drafts", hint: "E-mails and posts you haven't finished", group: "Plan & act", tone: "slate", def: [8, 7], min: [5, 5], ico: () => MhIco.edit },
  week: { title: "This week", hint: "Seven days at a glance", group: "Plan & act", tone: "blue", def: [16, 5], min: [8, 4], ico: () => MhIco.cal },
  quick: { title: "Quick actions", hint: "Start an e-mail, a post, a list or a form", group: "Plan & act", tone: "ink", def: [8, 7], min: [5, 5], ico: () => MkIco.plus },
  optouts: { title: "Latest opt-outs", hint: "Who unsubscribed lately, and why", group: "Audiences & forms", tone: "rose", def: [8, 7], min: [5, 5], ico: () => MhIco.x },
};
const MO_KEYS = Object.keys(MO) as MoKey[];
const MO_GROUPS: MoGroup[] = ["Figures", "E-mail", "Social", "Audiences & forms", "Plan & act"];
const MO_PREF = "mkOverview";
/** The overview never scrolls: the board is this many rows, and the rows share the height of the screen. */
const MO_ROWS = 18;
const moFits = (items: BoardItem[]) => items.every((i) => i.y + i.h <= MO_ROWS);
interface MoBoard { v: 1; items: BoardItem[] }
const moItem = (key: MoKey, x: number, y: number, w: number, h: number): BoardItem => ({ id: newId(), key, x, y, w, h });
function moDefault(): MoBoard {
  return { v: 1, items: compactAll([
    moItem("k.reach", 0, 0, 4, 4), moItem("k.sent", 4, 0, 4, 4), moItem("k.open", 8, 0, 4, 4), moItem("k.click", 12, 0, 4, 4), moItem("k.views", 16, 0, 4, 4), moItem("k.answers", 20, 0, 4, 4),
    moItem("agenda", 0, 4, 8, 14), moItem("campaigns", 8, 4, 9, 7), moItem("funnel", 8, 11, 9, 7), moItem("todo", 17, 4, 7, 8), moItem("ai", 17, 12, 7, 6),
  ]) };
}
function readMoBoard(v: any): MoBoard | null {
  if (!v || v.v !== 1 || !Array.isArray(v.items)) return null;
  const items: BoardItem[] = v.items
    .filter((i: any, n: number, all: any[]) => i && MO[i.key as MoKey] && all.findIndex((x: any) => x?.key === i.key) === n)
    .map((i: any) => {
      const d = MO[i.key as MoKey];
      const w = Math.max(d.min[0], Math.min(COLS, Math.round(Number(i.w) || d.def[0])));
      const h = Math.max(d.min[1], Math.min(60, Math.round(Number(i.h) || d.def[1])));
      return { id: typeof i.id === "string" ? i.id : newId(), key: i.key, x: Math.max(0, Math.min(COLS - w, Math.round(Number(i.x) || 0))), y: Math.max(0, Math.round(Number(i.y) || 0)), w, h };
    });
  const kept = compactAll(items).filter((i) => i.y + i.h <= MO_ROWS);
  return kept.length ? { v: 1, items: kept } : null;
}
const MO_KIT: BoardKit = {
  screenRows: MO_ROWS,
  min: (k) => MO[k as MoKey]?.min ?? [3, 3],
  title: (k) => MO[k as MoKey]?.title ?? k,
  icon: (k) => MO[k as MoKey]?.ico() ?? null,
  color: (k) => MO_TONE[MO[k as MoKey]?.tone ?? "green"],
  shown: (it) => it.key,
  fig: () => false,
  link: () => false,
  look: (it, pxW, pxH) => (MO[it.key as MoKey]?.fig ? (pxW < 190 || pxH < 120 ? "Compact" : "Figure") : pxW < 380 ? "Slim" : pxW >= 760 ? "Wide" : "Standard"),
  cls: (it, pxW, pxH) => ["mo-cell", MO[it.key as MoKey]?.fig ? "is-mofig" : "", pxW < 200 ? "mo-xs" : "", pxH < 300 ? "mo-short" : "", it.y + it.h > MO_ROWS ? "is-out" : ""].filter(Boolean).join(" "),
  snug: () => false,
  presets: (k) => {
    const d = MO[k as MoKey];
    if (!d) return [];
    if (d.fig) return [{ label: "Small", w: 3, h: 3 }, { label: "Standard", w: 4, h: 4 }, { label: "Wide", w: 6, h: 4 }, { label: "Large", w: 8, h: 5 }];
    return [
      { label: "Small", w: d.min[0], h: d.min[1] }, { label: "Standard", w: d.def[0], h: d.def[1] },
      { label: "Large", w: Math.min(COLS, d.def[0] + 4), h: d.def[1] + 4 }, { label: "Full width", w: COLS, h: d.def[1] },
    ].filter((p, i, all) => all.findIndex((q) => q.w === p.w && q.h === p.h) === i);
  },
  stackH: (it) => (MO[it.key as MoKey]?.fig ? 136 : Math.max(280, Math.min(640, it.h * 34))),
};
const moArrow = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
/** A ring that fills to a share (0–1). */
function MoRing({ v, tone }: { v: number; tone: string }) {
  const r = 22, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, v));
  return (
    <svg className="mo-ring" viewBox="0 0 56 56" aria-hidden="true" style={{ ["--c" as string]: tone } as CSSProperties}>
      <circle cx="28" cy="28" r={r} className="mo-ring-bg" />
      <circle cx="28" cy="28" r={r} className="mo-ring-fg" strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 28 28)" />
    </svg>
  );
}
/** Small bars (a few weeks), the last one strongest. */
function MoSpark({ vals, tone }: { vals: number[]; tone: string }) {
  const max = Math.max(1, ...vals);
  return (
    <span className="mo-spark" aria-hidden="true" style={{ ["--c" as string]: tone } as CSSProperties}>
      {vals.map((v, i) => <i key={i} style={{ height: `${Math.max(6, (v / max) * 100)}%`, opacity: 0.35 + (0.65 * (i + 1)) / vals.length }} />)}
    </span>
  );
}

function Overview({ x, editing, onEditing }: { x: HubCtx; editing: boolean; onEditing: (on: boolean) => void }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime(), t14 = t0 + 14 * 864e5;
  type Item = { key: string; when: Date; kind: "post" | "email"; title: string; sub: string; nets: Net[]; status: string; due: boolean; open: () => void };
  const items: Item[] = [
    ...x.posts.filter((p) => postWhen(p) && p.status !== "cancelled").map((p) => ({ key: p.id, when: new Date(postWhen(p)!), kind: "post" as const, title: p.title || p.body.slice(0, 60) || "Untitled post", sub: p.body.replace(/\s+/g, " ").slice(0, 90), nets: p.networks, status: p.status, due: isDue(p), open: () => x.openPost(p) })),
    ...x.campaigns.filter((c) => c.scheduled_at || c.started_at).map((c) => ({ key: c.id, when: new Date(c.status === "scheduled" ? c.scheduled_at! : c.started_at ?? c.scheduled_at!), kind: "email" as const, title: c.name, sub: mkLineText(c.subject), nets: [] as Net[], status: c.status, due: false, open: () => x.openCampaign(c.id) })),
  ];
  const agenda = items.filter((it) => it.when.getTime() >= t0 && it.when.getTime() < t14).sort((a, b) => a.when.getTime() - b.when.getTime());
  const days = new Map<string, Item[]>();
  agenda.forEach((it) => { const k = dayKey(it.when); const a = days.get(k) ?? []; a.push(it); days.set(k, a); });
  const dayName = (k: string) => {
    const d = new Date(`${k}T00:00:00`); const diff = Math.round((d.getTime() - t0) / 864e5);
    return { main: diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : d.toLocaleDateString("en-GB", { weekday: "long" }), sub: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) };
  };

  // e-mail: the last 90 days, and week by week (12 weeks)
  const since = Date.now() - 90 * 864e5;
  const recent = x.campaigns.filter((c) => c.started_at && new Date(c.started_at).getTime() >= since);
  const tot = recent.reduce((a, c) => { const g = x.agg.by.get(c.id) ?? blankAgg(); (Object.keys(a) as (keyof CampAgg)[]).forEach((k) => { a[k] += g[k]; }); return a; }, blankAgg());
  const lastSent = x.campaigns.filter((c) => c.started_at && (x.agg.by.get(c.id)?.sent ?? 0) > 0).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, 6);
  const wk0 = (() => { const d = new Date(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); })();
  const weeks = Array.from({ length: 12 }, (_, i) => ({ start: wk0 - (11 - i) * 7 * 864e5, sent: 0, opened: 0, clicked: 0 }));
  x.campaigns.forEach((c) => {
    if (!c.started_at) return;
    const t = new Date(c.started_at).getTime();
    const w = weeks.find((k) => t >= k.start && t < k.start + 7 * 864e5);
    const g = x.agg.by.get(c.id);
    if (w && g) { w.sent += g.sent; w.opened += g.opened; w.clicked += g.clicked; }
  });
  // social
  const pubs = x.posts.filter((p) => p.status === "published");
  const postImp = (p: MkPost) => Object.values(p.results ?? {}).reduce((s, r) => s + (r.impressions ?? 0), 0);
  const postReact = (p: MkPost) => Object.values(p.results ?? {}).reduce((s, r) => s + (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0), 0);
  const eng = pubs.reduce((a, p) => ({ imp: a.imp + postImp(p), react: a.react + postReact(p) }), { imp: 0, react: 0 });
  const viewWeeks = weeks.map((w) => pubs.filter((p) => { const t = new Date(postWhen(p) ?? 0).getTime(); return t >= w.start && t < w.start + 7 * 864e5; }).reduce((s, p) => s + postImp(p), 0));
  const perNet = NET_KEYS.map((n) => {
    const ps = x.posts.filter((p) => p.networks.includes(n) && p.status !== "cancelled");
    const imp = ps.reduce((s, p) => s + (p.results?.[n]?.impressions ?? 0), 0);
    return { n, sched: ps.filter((p) => p.status === "scheduled").length, pub: ps.filter((p) => p.status === "published").length, imp };
  }).filter((r) => r.sched + r.pub > 0);
  const maxImp = Math.max(1, ...perNet.map((r) => r.imp));
  const best = [...pubs].sort((a, b) => postImp(b) - postImp(a)).slice(0, 6);
  const reachable = useMemo(() => {
    const seen = new Set<string>();
    (x.w?.contacts ?? []).forEach((c: any) => { const e = String(c.email ?? "").trim().toLowerCase(); if (EMAIL_RE.test(e) && !c.marketing_opt_out && !x.optOut.has(e)) seen.add(e); });
    return seen.size;
  }, [x.w, x.optOut]);
  const answers = x.forms.reduce((s, f) => s + (f.response_count || 0), 0);
  const liveForms = x.forms.filter((f) => f.status === "live").length;
  const listSize = (l: MkList) => x.members.get(l.id)?.length || l.member_count || 0;
  const bigLists = [...x.lists].sort((a, b) => listSize(b) - listSize(a)).slice(0, 6);
  const inLists = x.lists.reduce((s, l) => s + listSize(l), 0);
  const unsub30 = x.unsubs.filter((u) => Date.now() - new Date(u.created_at).getTime() < 30 * 864e5).length;
  const drafts = [
    ...x.campaigns.filter((c) => c.status === "draft").map((c) => ({ key: `c${c.id}`, kind: "email" as const, title: c.name || "Untitled e-mail", when: c.updated_at, go: () => x.openCampaign(c.id) })),
    ...x.posts.filter((p) => p.status === "draft" || p.status === "idea").map((p) => ({ key: `p${p.id}`, kind: "post" as const, title: p.title || p.body.slice(0, 60) || "Untitled post", when: p.updated_at, go: () => x.openPost(p), nets: p.networks })),
  ].sort((a, b) => String(b.when).localeCompare(String(a.when)));
  const week7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(t0 + i * 864e5); const k = dayKey(d); return { k, d, its: days.get(k) ?? [] }; });

  // what needs a hand now
  type Todo = { key: string; tone: string; ico: React.ReactNode; title: string; sub: string; act: string; go: () => void };
  const todos: Todo[] = [
    ...x.posts.filter(isDue).slice(0, 3).map((p) => ({ key: `due${p.id}`, tone: "amber", ico: MhIco.bell, title: p.title || p.body.slice(0, 50) || "A post", sub: `Ready to publish · ${p.networks.map((n) => NETS[n].label).join(", ")}`, act: "Publish", go: () => x.publish(p) })),
    ...x.campaigns.filter((c) => c.status === "sending" || c.status === "paused").map((c) => ({ key: `run${c.id}`, tone: "green", ico: MkIco.send, title: c.name, sub: c.status === "paused" ? "Paused — waiting to go on" : "Sending now", act: "Open", go: () => x.openCampaign(c.id) })),
    ...x.campaigns.filter((c) => c.status === "scheduled" && c.scheduled_at && new Date(c.scheduled_at).getTime() < Date.now() + 7 * 864e5).map((c) => ({ key: `sch${c.id}`, tone: "violet", ico: MhIco.cal, title: c.name, sub: `Goes out ${fmtWhen(c.scheduled_at)}`, act: "Check", go: () => x.openCampaign(c.id) })),
    ...x.forms.filter((f) => f.last_response_at && Date.now() - new Date(f.last_response_at).getTime() < 3 * 864e5).slice(0, 2).map((f) => ({ key: `fm${f.id}`, tone: "blue", ico: MhIco.form, title: f.name, sub: `New answers · ${fmtN(f.response_count)} in all`, act: "See", go: () => x.go("forms") })),
    ...x.campaigns.filter((c) => c.status === "draft").slice(0, 3).map((c) => ({ key: `dr${c.id}`, tone: "slate", ico: MhIco.edit, title: c.name, sub: `E-mail draft · edited ${fmtWhen(c.updated_at)}`, act: "Finish", go: () => x.openCampaign(c.id) })),
    ...x.posts.filter((p) => p.status === "failed").slice(0, 2).map((p) => ({ key: `fl${p.id}`, tone: "red", ico: MhIco.bounce, title: p.title || "A post", sub: "Didn't publish", act: "Fix", go: () => x.openPost(p) })),
  ];
  const [brief, setBrief] = useState("");

  /* ---- the board: saved with the person; while customizing, a draft ---- */
  const [board, setBoard] = useState<MoBoard | null>(null);
  const [draft, setDraft] = useState<MoBoard | null>(null);
  const [lib, setLib] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [preview, setPreview] = useState<BoardItem[] | null>(null);
  const [noRoom, setNoRoom] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadPrefs().catch(() => ({} as Record<string, any>)).then((p) => { if (alive) setBoard(readMoBoard(p?.[MO_PREF]) ?? moDefault()); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (editing && board && !draft) setDraft({ ...board, items: compactAll(board.items) });
    if (!editing && draft) { setDraft(null); setLib(false); setPreview(null); }
  }, [editing, board]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = draft ?? board;
  const shown = live?.items ?? [];
  const finish = (save: boolean) => {
    if (save && draft && !moFits(draft.items)) { warn("Some cards are below the end of your screen — make room for them first"); return; }
    if (save && draft) { setBoard(draft); savePref(MO_PREF, draft).catch(() => {}); }
    setDraft(null); setLib(false); setPreview(null); onEditing(false);
  };
  const warn = (msg: string) => { setNoRoom(msg); window.setTimeout(() => setNoRoom((m) => (m === msg ? null : m)), 3200); };
  /** While adjusting, cards may go below the end of the screen (they're marked); Done asks to make room first. */
  const change = (next: BoardItem[]) => setDraft((d) => (d ? { ...d, items: next } : d));
  const overflow = !!draft && !moFits(draft.items);
  const addCard = (key: MoKey) => {
    if (!draft) return;
    const d = MO[key];
    const sizes: [number, number][] = [d.def, [d.def[0], d.min[1]], [d.min[0], d.def[1]], d.min];
    const put = (w: number, h: number, below: boolean) => {
      const at = firstFit(draft.items, w, h);
      const it: BoardItem = { id: newId(), key, x: at.x, y: at.y, w, h };
      setDraft({ ...draft, items: [...draft.items, it] });
      setFlash(it.id);
      window.setTimeout(() => setFlash((f) => (f === it.id ? null : f)), 1600);
      window.setTimeout(() => document.querySelector(`.mo-board .hb-card[data-id="${it.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 80);
      if (below) warn(`“${d.title}” went below the end of your screen — make room for it`);
    };
    for (const [w, h] of sizes) if (firstFit(draft.items, w, h).y + h <= MO_ROWS) return put(w, h, false);
    put(d.def[0], d.def[1], true);
  };
  const removeKey = (key: string) => setDraft((d) => (d ? { ...d, items: d.items.filter((i) => i.key !== key) } : d));
  useEffect(() => {
    if (!editing) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".hb-sizes") && !lib) finish(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [editing, lib]); // eslint-disable-line react-hooks/exhaustive-deps
  /* the rows share the height of the screen (measured while not customizing, so the cards don't jump) */
  const fitRef = useRef<HTMLDivElement>(null);
  const [availH, setAvailH] = useState(0);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useLayoutEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const m = () => { if (!editingRef.current) setAvailH(el.clientHeight); };
    m();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(m) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const step = availH ? Math.max(24, (availH - 8 + GAP) / MO_ROWS) : 36;
  const [els, setEls] = useState<Record<string, HTMLElement>>({});
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const slotRef = (id: string) => {
    let f = refs.current.get(id);
    if (!f) {
      f = (el: HTMLElement | null) => setEls((m) => {
        if (el) return m[id] === el ? m : { ...m, [id]: el };
        if (!(id in m)) return m;
        const next = { ...m }; delete next[id]; return next;
      });
      refs.current.set(id, f);
    }
    return f;
  };
  /** The first figures on the board are the dark and the green ones (as on Clients), the rest white. */
  const figRank = new Map((preview ?? shown).filter((i) => MO[i.key as MoKey]?.fig).sort((a, b) => a.y - b.y || a.x - b.x).map((i, n) => [i.key, n]));

  /* ---- the cards ---- */
  const tone = (k: MoKey) => MO_TONE[MO[k].tone];
  const fig = (k: MoKey, v: React.ReactNode, sub: React.ReactNode, go: () => void, viz?: React.ReactNode) => {
    const r = figRank.get(k) ?? 9;
    return (
      <button type="button" className={`mo-card mo-fig ${r === 0 ? "is-pine" : r === 1 ? "is-green" : r === 2 ? "is-lime" : ""}`} onClick={editing ? undefined : go}>
        <span className="mo-fig-h"><span className="mo-fig-k">{MO[k].title}</span><i>{MO[k].ico()}</i></span>
        <span className="mo-fig-row"><b className="mo-fig-v">{v}</b>{viz}</span>
        <em className="mo-fig-s">{sub}</em>
      </button>
    );
  };
  const panel = (k: MoKey, sub: React.ReactNode, body: React.ReactNode, link?: { label: string; go: () => void }, extra = "") => (
    <section className={`mo-card mo-panel ${extra}`} style={{ ["--c" as string]: tone(k) } as CSSProperties}>
      <header className="mo-h">
        <span className="mo-h-ico">{MO[k].ico()}</span>
        <span className="mo-h-t"><b>{MO[k].title}</b>{sub ? <em>{sub}</em> : null}</span>
        {link && <button type="button" className="mo-h-go" onClick={link.go} title={link.label}><span>{link.label}</span>{moArrow}</button>}
      </header>
      <div className="mo-b">{body}</div>
    </section>
  );
  const empty = (txt: string, act?: React.ReactNode) => <div className="mo-empty"><p>{txt}</p>{act}</div>;
  const rate = (a: number, b: number) => (b ? a / b : 0);
  const card = (k: MoKey): React.ReactNode => {
    switch (k) {
      case "k.reach": return fig(k, x.w ? fmtN(reachable) : "…", `${x.lists.length} list${x.lists.length === 1 ? "" : "s"} · ${fmtN(x.unsubs.length)} opted out`, () => x.go("audiences"));
      case "k.sent": return fig(k, fmtN(tot.sent), `${recent.length} campaign${recent.length === 1 ? "" : "s"} · 90 days`, () => x.go("email"), <MoSpark vals={weeks.map((w) => w.sent)} tone={tone(k)} />);
      case "k.open": return fig(k, tot.sent ? fmtPct(tot.opened, tot.sent) : "—", tot.sent ? `${fmtN(tot.opened)} opened` : "No sends yet", () => x.go("email"), <MoRing v={rate(tot.opened, tot.sent)} tone={tone(k)} />);
      case "k.click": return fig(k, tot.sent ? fmtPct(tot.clicked, tot.sent) : "—", tot.sent ? `${fmtN(tot.clicked)} clicked` : "No sends yet", () => x.go("email"), <MoRing v={rate(tot.clicked, tot.sent)} tone={tone(k)} />);
      case "k.reply": return fig(k, fmtN(tot.replied), tot.sent ? `${fmtPct(tot.replied, tot.sent)} of delivered` : "No sends yet", () => x.go("email"));
      case "k.bounce": return fig(k, tot.sent ? fmtPct(tot.bounced, tot.sent) : "—", tot.sent ? `${fmtN(tot.bounced)} bounced · 90 days` : "No sends yet", () => x.go("email"), <MoRing v={rate(tot.bounced, tot.sent)} tone={tone(k)} />);
      case "k.unsub": return fig(k, fmtN(x.unsubs.length), `${fmtN(unsub30)} in the last 30 days`, () => x.go("audiences"));
      case "k.views": return fig(k, fmtN(eng.imp), `${fmtN(eng.react)} reactions · ${pubs.length} post${pubs.length === 1 ? "" : "s"}`, () => x.go("social"), <MoSpark vals={viewWeeks} tone={tone(k)} />);
      case "k.engage": return fig(k, eng.imp ? fmtPct(eng.react, eng.imp) : "—", eng.imp ? `${fmtN(eng.react)} likes, comments, shares` : "No views yet", () => x.go("social"), <MoRing v={Math.min(1, rate(eng.react, eng.imp) * 5)} tone={tone(k)} />);
      case "k.answers": return fig(k, fmtN(answers), x.forms.length ? `${liveForms} live form${liveForms === 1 ? "" : "s"}` : "No forms yet", () => x.go("forms"));
      case "k.planned": return fig(k, fmtN(agenda.length), agenda.length ? `${agenda.filter((a) => a.kind === "post").length} posts · ${agenda.filter((a) => a.kind === "email").length} e-mails` : "Nothing planned yet", () => x.go("calendar"));
      case "k.lists": return fig(k, fmtN(x.lists.length), `${fmtN(inLists)} people in them`, () => x.go("audiences"));
      case "agenda": return panel(k, agenda.length ? `${agenda.length} in the next two weeks` : "Nothing planned in the next two weeks", agenda.length ? (
        <div className="mo-agenda">
          {[...days.entries()].map(([dk, its]) => {
            const dn = dayName(dk);
            return (
              <div key={dk} className="mo-day">
                <span className="mo-day-h"><b>{dn.main}</b><em>{dn.sub}</em><button type="button" onClick={() => x.newPostAt(dk)} aria-label="Plan a post this day" title="Plan a post this day">{MkIco.plus}</button></span>
                {its.map((it) => (
                  <button type="button" key={it.key} className={`mo-ev is-${it.kind} ${it.due ? "is-due" : ""}`} onClick={it.open}
                    style={{ ["--n" as string]: it.kind === "email" ? "#12b57f" : NETS[it.nets[0] ?? "linkedin"].color } as CSSProperties}>
                    <span className="mo-ev-t">{hhmm(it.when.toISOString())}</span>
                    <span className="mo-ev-x"><b>{it.title}</b><em>{it.kind === "email" ? "E-mail" : it.nets.map((n) => NETS[n].label).join(" · ")}</em></span>
                    <span className="mo-ev-m">{it.kind === "email" ? <i className="mo-mail">{MkIco.mail}</i> : it.nets.slice(0, 3).map((n) => <NetBadge key={n} n={n} size="sm" />)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : empty("Your next two weeks are free.", <div className="mo-acts"><button type="button" className="mo-btn" onClick={() => x.newPostAt()}>{MkIco.plus}Post</button><button type="button" className="mo-btn" onClick={() => x.openCampaign("new")} disabled={x.missing}>{MkIco.mail}E-mail</button></div>), { label: "Calendar", go: () => x.go("calendar") });
      case "campaigns": return panel(k, "Open and click rate", lastSent.length ? (
        <div className="mo-camps">
          {lastSent.map((c) => {
            const g = x.agg.by.get(c.id) ?? blankAgg();
            return (
              <button type="button" key={c.id} className="mo-camp" onClick={() => x.openCampaign(c.id)}>
                <span className="mo-camp-h"><b>{c.name}</b><em>{fmtN(g.sent)} sent · {fmtDay(c.started_at)}</em></span>
                <span className="mo-bar is-open" title="Opened"><i style={{ width: `${rate(g.opened, g.sent) * 100}%` }} /><b>{fmtPct(g.opened, g.sent)}</b></span>
                <span className="mo-bar is-click" title="Clicked"><i style={{ width: `${rate(g.clicked, g.sent) * 100}%` }} /><b>{fmtPct(g.clicked, g.sent)}</b></span>
              </button>
            );
          })}
          <div className="mo-legend"><span className="is-open">Opened</span><span className="is-click">Clicked</span></div>
        </div>
      ) : empty("Once a campaign goes out, you'll see who opens and clicks here.", <button type="button" className="mo-btn is-main" onClick={() => x.openCampaign("new")} disabled={x.missing}>{MkIco.plus}New e-mail</button>), { label: "E-mail", go: () => x.go("email") });
      case "funnel": {
        const steps = [{ l: "Delivered", v: tot.sent }, { l: "Opened", v: tot.opened }, { l: "Clicked", v: tot.clicked }, { l: "Replied", v: tot.replied }];
        return panel(k, "Last 90 days", tot.sent ? (
          <div className="mo-funnel">
            {steps.map((s, i) => (
              <div key={s.l} className="mo-fn" style={{ ["--w" as string]: `${Math.max(4, rate(s.v, tot.sent) * 100)}%`, ["--i" as string]: i } as CSSProperties}>
                <span className="mo-fn-l"><b>{s.l}</b><em>{i ? fmtPct(s.v, tot.sent) : "100%"}</em></span>
                <span className="mo-fn-bar"><i /></span>
                <b className="mo-fn-v">{fmtN(s.v)}</b>
              </div>
            ))}
          </div>
        ) : empty("Send a campaign to see how many open, click and reply."), { label: "E-mail", go: () => x.go("email") });
      }
      case "trend": {
        const max = Math.max(1, ...weeks.map((w) => w.sent));
        return panel(k, tot.sent ? `${fmtN(tot.sent)} delivered · ${fmtPct(tot.opened, tot.sent)} opened` : "No sends in the last weeks", (
          <div className="mo-trend">
            <div className="mo-trend-bars">
              {weeks.map((w, i) => (
                <span key={i} className="mo-tw" title={`${new Date(w.start).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}: ${fmtN(w.sent)} delivered, ${fmtN(w.opened)} opened`}>
                  <i className="is-sent" style={{ height: `${(w.sent / max) * 100}%` }}><i className="is-open" style={{ height: `${w.sent ? (w.opened / w.sent) * 100 : 0}%` }} /></i>
                  <em>{i % 2 === 1 || weeks.length < 8 ? new Date(w.start).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}</em>
                </span>
              ))}
            </div>
            <div className="mo-legend"><span className="is-sent">Delivered</span><span className="is-open">Opened</span></div>
          </div>
        ), { label: "E-mail", go: () => x.go("email") });
      }
      case "todo": return panel(k, todos.length ? `${todos.length} waiting on you` : "All clear", todos.length ? (
        <div className="mo-todo">
          {todos.map((t) => (
            <div key={t.key} className={`mo-td is-${t.tone}`}>
              <i>{t.ico}</i>
              <span><b>{t.title}</b><em>{t.sub}</em></span>
              <button type="button" className="mo-btn is-sm" onClick={t.go}>{t.act}</button>
            </div>
          ))}
        </div>
      ) : <div className="mo-empty is-done"><i>{MkIco.check}</i><p>Nothing waiting on you.</p></div>);
      case "ai": return panel(k, "From one line to a draft", (
        <div className="mo-ai">
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What do you want to tell people? e.g. Invite CFOs to a 30-minute demo of our new Power BI reports." />
          <div className="mo-acts">
            <button type="button" className="mo-btn" disabled={!brief.trim() || x.missing} onClick={() => x.openCampaign("new", brief.trim())}>{MkIco.mail}An e-mail</button>
            <button type="button" className="mo-btn is-main" disabled={!brief.trim()} onClick={() => x.openAi(brief.trim())}>{MhIco.social}A series of posts</button>
          </div>
        </div>
      ), undefined, "is-ai");
      case "nets": return panel(k, `${x.posts.filter((p) => p.status === "scheduled").length} scheduled`, perNet.length ? (
        <div className="mo-nets">
          {perNet.map((r) => (
            <div key={r.n} className="mo-net" style={{ ["--n" as string]: NETS[r.n].color } as CSSProperties}>
              <NetBadge n={r.n} size="sm" />
              <span className="mo-net-t"><b>{NETS[r.n].label}</b><em>{r.pub} out · {r.sched} next</em></span>
              <span className="mo-net-bar"><i style={{ width: `${(r.imp / maxImp) * 100}%` }} /></span>
              <b className="mo-net-v">{r.imp ? fmtN(r.imp) : "—"}</b>
            </div>
          ))}
        </div>
      ) : empty("No posts yet. Plan a few with AI or import them.", <button type="button" className="mo-btn" onClick={() => x.openAi()}>{MhIco.spark}Plan with AI</button>), { label: "Social", go: () => x.go("social") });
      case "posts": return panel(k, pubs.length ? `${pubs.length} published` : "Nothing published yet", best.length ? (
        <div className="mo-list">
          {best.map((p, i) => (
            <button type="button" key={p.id} className="mo-li" onClick={() => x.openPost(p)}>
              <span className="mo-rank">{i + 1}</span>
              <span className="mo-li-t"><b>{p.title || p.body.slice(0, 60)}</b><em>{fmtDay(postWhen(p))} · {p.networks.map((n) => NETS[n].label).join(", ")}</em></span>
              <span className="mo-li-v"><b>{fmtN(postImp(p))}</b><em>{fmtN(postReact(p))} reactions</em></span>
            </button>
          ))}
        </div>
      ) : empty("When posts go out, the ones people saw most show here."), { label: "Social", go: () => x.go("social") });
      case "audiences": {
        const max = Math.max(1, ...bigLists.map(listSize));
        return panel(k, `${x.lists.length} list${x.lists.length === 1 ? "" : "s"} · ${fmtN(inLists)} people`, bigLists.length ? (
          <div className="mo-list">
            {bigLists.map((l) => (
              <button type="button" key={l.id} className="mo-li is-bar" onClick={() => x.go("audiences")} style={{ ["--w" as string]: `${(listSize(l) / max) * 100}%` } as CSSProperties}>
                <span className="mo-li-ico">{l.entity === "companies" ? MkIco.list : MkIco.people}</span>
                <span className="mo-li-t"><b>{l.name}</b><em>{l.kind === "dynamic" ? "Updates itself" : "Fixed list"}</em></span>
                <span className="mo-li-v"><b>{fmtN(listSize(l))}</b></span>
              </button>
            ))}
          </div>
        ) : empty("Make a list of who to reach — by any field.", <button type="button" className="mo-btn" onClick={() => x.go("audiences")}>{MkIco.plus}New list</button>), { label: "Audiences", go: () => x.go("audiences") });
      }
      case "forms": return panel(k, x.forms.length ? `${liveForms} live · ${fmtN(answers)} answers` : "No forms yet", x.forms.length ? (
        <div className="mo-list">
          {x.forms.slice(0, 6).map((f) => (
            <button type="button" key={f.id} className="mo-li" onClick={() => x.go("forms")}>
              <span className={`mo-dot is-${f.status === "live" ? "live" : "off"}`} />
              <span className="mo-li-t"><b>{f.name}</b><em>{f.last_response_at ? `Last answer ${fmtWhen(f.last_response_at)}` : f.status === "live" ? "No answers yet" : "Not live"}</em></span>
              <span className="mo-li-v"><b>{fmtN(f.response_count || 0)}</b><em>answers</em></span>
            </button>
          ))}
        </div>
      ) : empty("Questions that fill your contacts — share a link or put it in an e-mail.", <button type="button" className="mo-btn" onClick={() => x.go("forms")}>{MkIco.plus}New form</button>), { label: "Forms", go: () => x.go("forms") });
      case "drafts": return panel(k, drafts.length ? `${drafts.length} unfinished` : "Nothing half-done", drafts.length ? (
        <div className="mo-list">
          {drafts.slice(0, 8).map((d) => (
            <button type="button" key={d.key} className="mo-li" onClick={d.go}>
              <span className={`mo-li-ico is-${d.kind}`}>{d.kind === "email" ? MkIco.mail : MhIco.social}</span>
              <span className="mo-li-t"><b>{d.title}</b><em>{d.kind === "email" ? "E-mail" : "Post"} · edited {fmtWhen(d.when)}</em></span>
              <span className="mo-li-go">{moArrow}</span>
            </button>
          ))}
        </div>
      ) : <div className="mo-empty is-done"><i>{MkIco.check}</i><p>No drafts waiting.</p></div>);
      case "week": return panel(k, `${week7.reduce((s, d) => s + d.its.length, 0)} planned`, (
        <div className="mo-week">
          {week7.map((d, i) => (
            <button type="button" key={d.k} className={`mo-wd ${i === 0 ? "is-today" : ""} ${d.its.length ? "has" : ""}`} onClick={() => (d.its[0] ? d.its[0].open() : x.newPostAt(d.k))}
              title={d.its.length ? d.its.map((it) => `${hhmm(it.when.toISOString())} ${it.title}`).join("\n") : "Plan a post this day"}>
              <span className="mo-wd-h"><b>{i === 0 ? "Today" : d.d.toLocaleDateString("en-GB", { weekday: "short" })}</b><em>{d.d.getDate()}</em></span>
              <span className="mo-wd-dots">{d.its.slice(0, 4).map((it) => <i key={it.key} style={{ background: it.kind === "email" ? "#12b57f" : NETS[it.nets[0] ?? "linkedin"].color }} />)}{d.its.length > 4 && <small>+{d.its.length - 4}</small>}</span>
              <span className="mo-wd-n">{d.its.length ? `${d.its.length} planned` : "Free"}</span>
            </button>
          ))}
        </div>
      ), { label: "Calendar", go: () => x.go("calendar") }, "is-week");
      case "quick": return panel(k, "Start something new", (
        <div className="mo-quick">
          {([
            [MkIco.mail, "E-mail", "green", () => x.openCampaign("new"), x.missing], [MhIco.social, "Post", "blue", () => x.newPostAt(), false], [MhIco.spark, "Plan with AI", "violet", () => x.openAi(), false],
            [MkIco.list, "List", "slate", () => x.go("audiences"), false], [MhIco.form, "Form", "amber", () => x.go("forms"), false], [MhIco.upload, "Import posts", "teal", () => x.openImport(), false],
          ] as [React.ReactNode, string, string, () => void, boolean][]).map(([ico, l, t, go, off]) => (
            <button type="button" key={l} className="mo-q" style={{ ["--c" as string]: MO_TONE[t] } as CSSProperties} onClick={go} disabled={off}><i>{ico}</i><span>{l}</span></button>
          ))}
        </div>
      ));
      case "optouts": return panel(k, `${fmtN(unsub30)} in the last 30 days`, x.unsubs.length ? (
        <div className="mo-list">
          {x.unsubs.slice(0, 8).map((u) => (
            <div key={u.id} className="mo-li is-static">
              <span className="mo-li-ico is-out">{MhIco.x}</span>
              <span className="mo-li-t"><b>{u.email}</b><em>{u.reason || (u.source === "link" ? "Used the unsubscribe link" : u.source)}</em></span>
              <span className="mo-li-v"><em>{fmtDay(u.created_at)}</em></span>
            </div>
          ))}
        </div>
      ) : <div className="mo-empty is-done"><i>{MkIco.check}</i><p>Nobody has opted out.</p></div>, { label: "Audiences", go: () => x.go("audiences") });
    }
  };

  return (
    <div className="mkx-page">
      <div ref={fitRef} className={`mkx-scroll is-ov mo-scroll ${editing ? "is-editing" : ""}`}>
        {live ? (
          <div className="mo">
            <HomeBoard kit={MO_KIT} className="mo-board" items={shown} editing={editing} step={step} slotRef={slotRef} flash={flash}
              onOpen={() => {}} onPreview={setPreview} onChange={change} onRemove={(id) => setDraft((d) => (d ? { ...d, items: d.items.filter((i) => i.id !== id) } : d))} />
            {(preview ?? shown).map((it) => {
              const el = els[it.id];
              if (!el || !MO[it.key as MoKey]) return null;
              return createPortal(card(it.key as MoKey), el, it.id);
            })}
            {!editing && shown.length === 0 && (
              <div className="mo-blank"><b>Your overview is empty</b><p>Add the cards you want to see here.</p><button type="button" className="mo-btn is-main" onClick={() => { onEditing(true); setLib(true); }}>{MkIco.plus}Add cards</button></div>
            )}
          </div>
        ) : <MkLoading />}
      </div>

      {editing && draft && createPortal(
        <div className="hb-dock mo-dock" role="toolbar" aria-label="Adjust your overview">
          <span className="hb-dock-t">
            <b>Adjusting your overview</b>
            <small className={noRoom || overflow ? "is-warn" : ""}>{noRoom ?? (overflow ? "Below the dashed line is off the screen — make room before Done" : "Drag a card to move it · pull its edge to resize · it all fits one screen")}</small>
          </span>
          <button type="button" className="hb-dock-add" onClick={() => setLib((v) => !v)} aria-expanded={lib}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            Add cards
          </button>
          <span className="hb-dock-sep" />
          <button type="button" className="hb-dock-btn" onClick={() => setDraft({ v: 1, items: moDefault().items })} title="Back to the overview everyone starts with">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" /></svg>
            Reset
          </button>
          <button type="button" className="hb-dock-btn" onClick={() => finish(false)}>Cancel</button>
          <button type="button" className={`hb-dock-done ${overflow ? "is-off" : ""}`} onClick={() => finish(true)} aria-disabled={overflow}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            Done
          </button>
        </div>,
        document.body,
      )}
      {editing && draft && lib && <MoLibrary onBoard={new Set(draft.items.map((i) => i.key))} onAdd={addCard} onRemove={removeKey} onClose={() => setLib(false)} />}
    </div>
  );
}

/** The cards you can put on the overview — the same library as the home page's. */
function MoLibrary({ onBoard, onAdd, onRemove, onClose }: { onBoard: Set<string>; onAdd: (k: MoKey) => void; onRemove: (k: MoKey) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "cards" | "figs">("all");
  const [grp, setGrp] = useState<MoGroup | "all">("all");
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const f = q.trim().toLowerCase();
  const list = MO_KEYS.filter((k) => (grp === "all" || MO[k].group === grp) && (kind === "all" || (kind === "figs" ? MO[k].fig : !MO[k].fig))
    && (!f || `${MO[k].title} ${MO[k].hint} ${MO[k].group}`.toLowerCase().includes(f)));
  const color = (g: MoGroup) => MO_TONE[g === "Figures" ? "ink" : g === "E-mail" ? "green" : g === "Social" ? "violet" : g === "Audiences & forms" ? "amber" : "blue"];
  return createPortal(
    <aside className="hb-lib mo-lib" role="dialog" aria-label="Add to your overview">
      <header className="hb-lib-h">
        <div>
          <b>Add to your overview</b>
          <span>Everything fits one screen: make room by resizing or taking a card off.</span>
        </div>
        <button type="button" className="hb-lib-x" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <label className="hb-lib-q">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cards and figures" />
      </label>
      <div className="hb-lib-kind" role="tablist">
        {(["all", "cards", "figs"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "is-on" : ""} onClick={() => setKind(k)}>{k === "all" ? "Everything" : k === "cards" ? "Cards" : "Figures"}</button>
        ))}
      </div>
      <nav className="hb-lib-depts">
        <button type="button" className={grp === "all" ? "is-on" : ""} onClick={() => setGrp("all")}>All <i>{MO_KEYS.length}</i></button>
        {MO_GROUPS.map((g) => (
          <button key={g} type="button" className={grp === g ? "is-on" : ""} onClick={() => setGrp(g)} style={{ ["--c" as string]: color(g) } as CSSProperties}>
            <em />{g} <i>{MO_KEYS.filter((k) => MO[k].group === g).length}</i>
          </button>
        ))}
      </nav>
      <div className="hb-lib-list">
        {list.length === 0 && <p className="hb-lib-none">Nothing matches “{q}”.</p>}
        {MO_GROUPS.map((g) => {
          const mine = list.filter((k) => MO[k].group === g);
          if (!mine.length) return null;
          return (
            <section key={g} className="hb-lib-sec" style={{ ["--c" as string]: color(g) } as CSSProperties}>
              <h3><em />{g}</h3>
              {mine.map((k) => {
                const on = onBoard.has(k);
                return (
                  <div key={k} className={`hb-lib-it ${on ? "is-in" : ""}`}>
                    <span className={`hb-lib-pic ${MO[k].fig ? "is-fig" : ""}`}>{MO[k].ico()}</span>
                    <span className="hb-lib-txt">
                      <b>{MO[k].title}</b>
                      <small>{MO[k].hint}</small>
                      {on && <span className="hb-lib-where">On the overview</span>}
                    </span>
                    <span className="hb-lib-acts">
                      {on
                        ? <button type="button" className="is-rm" onClick={() => onRemove(k)} title="Take it off the overview">Remove</button>
                        : <button type="button" className="is-add" onClick={() => onAdd(k)} title="Add it to the overview">+ Add</button>}
                    </span>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      <footer className="hb-lib-f">Your overview is yours: everyone arranges their own.</footer>
    </aside>,
    document.body,
  );
}
const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");

/* ═══════════════════════════ E-mail ═══════════════════════════ */
type EmGroup = "all" | "active" | "draft" | "done";
type EmCol = "audience" | "status" | "sent" | "opened" | "clicked" | "replies" | "bounced" | "unsub" | "failed" | "when" | "created" | "from" | "progress";
type EmRow = { c: MkCampaign; g: CampAgg; sent: number; list: MkList | undefined };
const EM_COLS: Record<EmCol, { label: string; hint: string; w: string; num?: boolean; key: (r: EmRow) => number | string }> = {
  audience: { label: "Audience", hint: "The list it goes to", w: "minmax(0, 1.2fr)", key: (r) => r.list?.name ?? "" },
  status: { label: "Status", hint: "Draft, scheduled, sending, sent…", w: "minmax(132px, 0.95fr)", key: (r) => r.c.status },
  sent: { label: "Sent", hint: "Delivered to the mail server", w: "76px", num: true, key: (r) => r.sent },
  opened: { label: "Opened", hint: "Open rate, with a bar", w: "minmax(104px, 0.75fr)", key: (r) => (r.sent ? r.g.opened / r.sent : -1) },
  clicked: { label: "Clicked", hint: "Click rate, with a bar", w: "minmax(104px, 0.75fr)", key: (r) => (r.sent ? r.g.clicked / r.sent : -1) },
  replies: { label: "Replies", hint: "People who answered", w: "76px", num: true, key: (r) => r.g.replied },
  bounced: { label: "Bounced", hint: "Addresses that didn't take it", w: "80px", num: true, key: (r) => r.g.bounced },
  unsub: { label: "Opted out", hint: "Unsubscribed from this e-mail", w: "84px", num: true, key: (r) => r.g.unsub },
  failed: { label: "Failed", hint: "Couldn't be sent", w: "70px", num: true, key: (r) => r.g.failed },
  when: { label: "When", hint: "Sent, scheduled or last edited", w: "minmax(118px, 0.8fr)", key: (r) => r.c.started_at ?? r.c.scheduled_at ?? r.c.updated_at ?? "" },
  created: { label: "Created", hint: "When the campaign was made", w: "minmax(104px, 0.7fr)", key: (r) => r.c.created_at ?? "" },
  from: { label: "From", hint: "The mailbox it's sent from", w: "minmax(0, 1fr)", key: (r) => r.c.from_mailbox ?? "" },
  progress: { label: "Progress", hint: "How much of the list has been sent", w: "minmax(110px, 0.8fr)", key: (r) => (r.g.total ? (r.g.sent + r.g.failed) / r.g.total : 0) },
};
const EM_KEYS = Object.keys(EM_COLS) as EmCol[];
const EM_DEFAULT: EmCol[] = ["audience", "status", "sent", "opened", "clicked", "replies"];
const EM_COL_PREF = "mkEmailCols";
type EmLay = "list" | "cards";
const EM_LAY_PREF = "mkEmailLayout";
const EM_KPI_PREF = "mkEmailKpis";
const emIco = {
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z", mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
  click: "M9 9l11 4-4.6 1.6L13.8 19zM5 3v3M3 5h3", reply: "M10 7 4 12l6 5M4 12h10a6 6 0 0 1 6 6v1", out: "M18 6 6 18M6 6l12 12",
  bounce: "M3 5h18v14H3zM4 7l8 6 8-6", draft: "M4 20h4L19 9l-4-4L4 16z", run: "M13 2 3 14h9l-1 8 10-12h-9l1-8z", cal: "M3 4.5h18v16H3zM3 9h18M8 2.5v4M16 2.5v4",
  best: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z", list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
};
type EmCtx = { campaigns: MkCampaign[]; agg: Map<string, CampAgg>; lists: MkList[]; unsubs: MkUnsub[] };
const emSum = (c: EmCtx, xs = c.campaigns) => xs.reduce((a, k) => { const g = c.agg.get(k.id) ?? blankAgg(); (Object.keys(a) as (keyof CampAgg)[]).forEach((q) => { a[q] += g[q]; }); return a; }, blankAgg());
const emPct = (a: number, b: number) => (b > 0 ? (Math.round((a / b) * 1000) / 10).toLocaleString("es-ES") : "—");
const EM_KPIS: FigDef<EmCtx>[] = [
  { key: "sent", label: "Campaigns sent", ico: emIco.send, calc: (c) => {
    const n = c.campaigns.filter((k) => k.status === "sent").length, act = c.campaigns.filter((k) => ["sending", "paused", "scheduled"].includes(k.status)).length, dr = c.campaigns.filter((k) => k.status === "draft").length;
    return { v: String(n), sub: `${act} in progress · ${dr} draft${dr === 1 ? "" : "s"}` };
  } },
  { key: "delivered", label: "Delivered", ico: emIco.mail, calc: (c) => { const a = emSum(c); return { v: String(a.sent), sub: a.failed ? `${fmtN(a.failed)} failed` : "none failed", bar: a.total ? (a.sent / a.total) * 100 : null }; } },
  { key: "open", label: "Open rate", ico: emIco.eye, calc: (c) => { const a = emSum(c); return { v: emPct(a.opened, a.sent), unit: a.sent ? "%" : undefined, sub: `${fmtN(a.opened)} people opened`, bar: a.sent ? (a.opened / a.sent) * 100 : 0 }; } },
  { key: "click", label: "Click rate", ico: emIco.click, calc: (c) => { const a = emSum(c); return { v: emPct(a.clicked, a.sent), unit: a.sent ? "%" : undefined, sub: `${fmtN(a.clicked)} people clicked`, bar: a.sent ? (a.clicked / a.sent) * 100 : 0 }; } },
  { key: "replies", label: "Replies", ico: emIco.reply, calc: (c) => { const a = emSum(c); return { v: String(a.replied), sub: a.sent ? `${emPct(a.replied, a.sent)}% of delivered` : "No sends yet" }; } },
  { key: "unsub", label: "Unsubscribed", ico: emIco.out, calc: (c) => { const a = emSum(c); return { v: String(a.unsub), sub: a.sent ? `${emPct(a.unsub, a.sent)}% of delivered` : "—" }; } },
  { key: "bounce", label: "Bounce rate", ico: emIco.bounce, calc: (c) => { const a = emSum(c); return { v: emPct(a.bounced, a.sent), unit: a.sent ? "%" : undefined, sub: `${fmtN(a.bounced)} bounced`, bar: a.sent ? (a.bounced / a.sent) * 100 : 0 }; } },
  { key: "ctor", label: "Click-to-open", ico: emIco.click, calc: (c) => { const a = emSum(c); return { v: emPct(a.clicked, a.opened), unit: a.opened ? "%" : undefined, sub: "of those who opened, clicked", bar: a.opened ? (a.clicked / a.opened) * 100 : 0 }; } },
  { key: "active", label: "In progress", ico: emIco.run, calc: (c) => { const xs = c.campaigns.filter((k) => k.status === "sending" || k.status === "paused"); return { v: String(xs.length), sub: xs.length ? xs.map((k) => k.name).slice(0, 2).join(", ") : "Nothing sending now" }; } },
  { key: "scheduled", label: "Scheduled", ico: emIco.cal, calc: (c) => {
    const xs = c.campaigns.filter((k) => k.status === "scheduled" && k.scheduled_at).sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
    return { v: String(xs.length), sub: xs[0] ? `next ${fmtWhen(xs[0].scheduled_at)}` : "Nothing scheduled" };
  } },
  { key: "drafts", label: "Drafts", ico: emIco.draft, calc: (c) => { const xs = c.campaigns.filter((k) => k.status === "draft"); return { v: String(xs.length), sub: xs.length ? `last edited ${fmtWhen(xs.map((k) => k.updated_at).sort().pop())}` : "No drafts" }; } },
  { key: "d30", label: "Delivered · 30 days", ico: emIco.mail, calc: (c) => {
    const xs = c.campaigns.filter((k) => k.started_at && Date.now() - new Date(k.started_at).getTime() < 30 * 864e5), a = emSum(c, xs);
    return { v: String(a.sent), sub: `${xs.length} campaign${xs.length === 1 ? "" : "s"} · ${emPct(a.opened, a.sent)}% opened` };
  } },
  { key: "best", label: "Best open rate", ico: emIco.best, calc: (c) => {
    const xs = c.campaigns.map((k) => ({ k, g: c.agg.get(k.id) ?? blankAgg() })).filter((r) => r.g.sent >= 10).sort((a, b) => b.g.opened / b.g.sent - a.g.opened / a.g.sent);
    return xs[0] ? { v: emPct(xs[0].g.opened, xs[0].g.sent), unit: "%", sub: xs[0].k.name, bar: (xs[0].g.opened / xs[0].g.sent) * 100 } : { v: "—", sub: "Needs a send of 10 or more" };
  } },
  { key: "lists", label: "Audience lists", ico: emIco.list, calc: (c) => ({ v: String(c.lists.length), sub: `${fmtN(c.unsubs.length)} people opted out in all` }) },
];

/** The column chooser: tick what you see, drag to put it in order (remembered for you). */
function EmColumns({ cols, onChange, onClose, at }: { cols: EmCol[]; onChange: (c: EmCol[]) => void; onClose: () => void; at: DOMRect }) {
  const [drag, setDrag] = useState<EmCol | null>(null);
  const order = [...cols, ...EM_KEYS.filter((k) => !cols.includes(k))];
  const move = (from: EmCol, to: EmCol) => {
    if (from === to || !cols.includes(from) || !cols.includes(to)) return;
    const next = cols.filter((k) => k !== from);
    next.splice(next.indexOf(to) + (cols.indexOf(from) < cols.indexOf(to) ? 1 : 0), 0, from);
    onChange(next);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const W = 320;
  return createPortal(
    <>
      <div className="em-scrim" onMouseDown={onClose} />
      <div className="em-cols" role="dialog" aria-label="Columns" style={{ top: Math.min(at.bottom + 8, window.innerHeight - 520), left: Math.max(12, Math.min(at.right - W, window.innerWidth - W - 12)), width: W }}>
        <header><b>Columns</b><small>Tick what you see · drag to put them in order</small></header>
        <div className="em-cols-fixed"><i>{MkIco.check}</i><span>Campaign</span><em>always first</em></div>
        <div className="em-cols-list">
          {order.map((k) => {
            const on = cols.includes(k);
            return (
              <div key={k} className={`em-col ${on ? "is-on" : ""} ${drag === k ? "is-drag" : ""}`} draggable={on}
                onDragStart={(e) => { setDrag(k); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", k); }}
                onDragOver={(e) => { if (drag && on) { e.preventDefault(); move(drag, k); } }}
                onDragEnd={() => setDrag(null)}>
                <span className="em-col-grip" aria-hidden="true">{on ? MhIco.grip : null}</span>
                <button type="button" className="em-col-tick" onClick={() => onChange(on ? cols.filter((c) => c !== k) : [...cols, k])} aria-pressed={on}>
                  <i>{on && MkIco.check}</i>
                  <span><b>{EM_COLS[k].label}</b><small>{EM_COLS[k].hint}</small></span>
                </button>
              </div>
            );
          })}
        </div>
        <footer><span>{cols.length} shown</span><button type="button" onClick={() => onChange(EM_DEFAULT)}>Back to the default</button></footer>
      </div>
    </>,
    document.body,
  );
}

function EmailTab({ x }: { x: HubCtx }) {
  const [st, setSt] = useState<EmGroup>("all");
  const [q, setQ] = useState("");
  /** campaigns, or the saved e-mail templates */
  const [view, setViewRaw] = useState<"campaigns" | "templates">(() => { try { return sessionStorage.getItem("mk-email-view") === "templates" ? "templates" : "campaigns"; } catch { return "campaigns"; } });
  const setView = (v: "campaigns" | "templates") => { setViewRaw(v); setQ(""); try { sessionStorage.setItem("mk-email-view", v); } catch { /* private mode */ } };
  const [tpls, setTpls] = useState<MkTemplate[] | null>(null);
  const [tplMiss, setTplMiss] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [cols, setColsRaw] = useState<EmCol[]>(EM_DEFAULT);
  const [colPick, setColPick] = useState<DOMRect | null>(null);
  const [sort, setSort] = useState<{ k: EmCol | "name"; dir: 1 | -1 } | null>(null);
  /** campaigns and templates as a list or as cards (each user's choice) */
  const [lay, setLayRaw] = useState<EmLay>("list");
  const setLay = (v: EmLay) => { setLayRaw(v); savePref(EM_LAY_PREF, v).catch(() => {}); };
  /** a template open on its own (Templates › Edit / New template) */
  const [tplEdit, setTplEdit] = useState<MkTemplate | "new" | null>(null);
  useEffect(() => { loadMkTemplates().then((r) => { setTpls(r.rows); setTplMiss(r.missing); }); }, []);
  const tick0 = useRef(x.colsTick);
  useEffect(() => {
    if (x.colsTick === tick0.current) return;
    tick0.current = x.colsTick;
    const b = document.querySelector(".mkh-bar .am-btn")?.getBoundingClientRect();
    setColPick(b ?? new DOMRect(window.innerWidth - 40, 70, 0, 0));
  }, [x.colsTick]);
  useEffect(() => {
    loadPrefs().then((p) => {
      const v = (p as Record<string, unknown>)[EM_COL_PREF];
      if (Array.isArray(v)) { const xs = v.filter((k): k is EmCol => typeof k === "string" && k in EM_COLS); if (xs.length) setColsRaw(xs); }
      const l = (p as Record<string, unknown>)[EM_LAY_PREF];
      if (l === "cards" || l === "list") setLayRaw(l);
    }).catch(() => {});
  }, []);
  const setCols = (next: EmCol[]) => { const clean = next.filter((k, i, a) => k in EM_COLS && a.indexOf(k) === i); setColsRaw(clean); savePref(EM_COL_PREF, clean).catch(() => {}); };
  const group = (c: MkCampaign): EmGroup => (c.status === "sending" || c.status === "paused" || c.status === "scheduled" ? "active" : c.status === "draft" ? "draft" : "done");
  const nBy = (g: EmGroup) => (g === "all" ? x.campaigns.length : x.campaigns.filter((c) => group(c) === g).length);
  const nq = norm(q);

  // the tools sit in the page's bar, next to the tabs
  const tools = (
    <div className="em-tools">
      <MkSeg size="sm" value={view} onChange={setView}
        options={[{ value: "campaigns", label: "Campaigns", count: x.campaigns.length }, { value: "templates", label: "Templates", count: tpls?.length ?? 0 }]} />
      {view === "campaigns" && (
        <div className="em-status">
          <Select size="sm" value={st} onChange={(v) => setSt((v || "all") as EmGroup)}
            options={([["all", "All"], ["active", "In progress"], ["draft", "Drafts"], ["done", "Sent"]] as [EmGroup, string][]).map(([v, l]) => ({ value: v, label: `${l} · ${nBy(v)}` }))} />
        </div>
      )}
      <label className={`em-search ${q ? "has-q" : ""}`}>{MkIco.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder={view === "templates" ? "Find a template" : "Find a campaign"} />{q && <button type="button" onClick={() => setQ("")} aria-label="Clear">{MhIco.x}</button>}</label>
      <div className="em-lay" role="tablist" aria-label="Show as">
        <button type="button" role="tab" aria-selected={lay === "list"} className={lay === "list" ? "is-on" : ""} onClick={() => setLay("list")} title="As a list">{CpIco.rows}</button>
        <button type="button" role="tab" aria-selected={lay === "cards"} className={lay === "cards" ? "is-on" : ""} onClick={() => setLay("cards")} title="As cards">{CpIco.cards}</button>
      </div>
      {view === "templates"
        ? <button type="button" className="em-new" onClick={() => setTplEdit("new")} disabled={tplMiss} title="New template">{MkIco.plus}<span>New template</span></button>
        : <button type="button" className="em-new" onClick={() => x.openCampaign("new")} disabled={x.missing} title="New e-mail">{MkIco.plus}<span>New e-mail</span></button>}
    </div>
  );
  const portal = x.bar ? createPortal(tools, x.bar) : null;

  if (tplEdit) {
    return <Composer key={tplEdit === "new" ? "new" : tplEdit.id} x={x} campaign={null} tplEdit={tplEdit} onBack={() => setTplEdit(null)} onSaved={() => {}}
      onTplSaved={(t) => { setTpls((xs) => [t, ...(xs ?? []).filter((y) => y.id !== t.id)]); setTplEdit(null); }} />;
  }
  if (view === "templates") return <div className="mkx-page em">{portal}<TemplatesView x={x} tpls={tpls} setTpls={setTpls} missing={tplMiss} seg={null} q={q} lay={lay} onEdit={setTplEdit} /></div>;
  const rows: EmRow[] = x.campaigns.map((c) => { const g = x.agg.by.get(c.id) ?? blankAgg(); return { c, g, sent: g.sent || c.stats.sent || 0, list: x.lists.find((y) => y.id === c.list_id) }; });
  const shown = rows.filter((r) => (st === "all" || group(r.c) === st) && (!nq || norm(`${r.c.name} ${r.c.subject}`).includes(nq)));
  if (sort) {
    const key = sort.k === "name" ? (r: EmRow) => r.c.name.toLowerCase() : EM_COLS[sort.k].key;
    shown.sort((a, b) => { const p = key(a), q2 = key(b); return (p < q2 ? -1 : p > q2 ? 1 : 0) * sort.dir; });
  }
  const rename = async (c: MkCampaign, nm: string) => { const r = await saveCampaignRow({ name: nm }, c.id); if (r.error) { x.toast(r.error); return false; } await x.reload(); x.toast("Renamed"); return true; };
  const duplicate = async (c: MkCampaign) => {
    setBusy(c.id);
    const r = await saveCampaignRow({ name: `${c.name} (copy)`, list_id: c.list_id, from_mailbox: c.from_mailbox, reply_to: c.reply_to, subject: c.subject, preheader: c.preheader ?? null, body_html: c.body_html, track_opens: c.track_opens ?? true, track_clicks: c.track_clicks ?? true });
    setBusy(null);
    if (r.error) x.toast(r.error); else { await x.reload(); x.toast("Copied — the copy is a draft"); }
  };
  const remove = async (c: MkCampaign) => {
    const { error } = await supabase.from("marketing_campaigns").delete().eq("id", c.id).eq("status", "draft");
    if (error) x.toast(error.message); else { await x.reload(); x.toast("Draft deleted"); }
  };
  if (!x.campaigns.length) {
    return (
      <div className="mkx-page">
        {portal}
        <div className="mkx-scroll">
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
        </div>
      </div>
    );
  }
  const grid = ["minmax(220px, 2.4fr)", ...cols.map((k) => EM_COLS[k].w), "84px"].join(" ");
  const head = (k: EmCol | "name", label: string, num?: boolean) => {
    const on = sort?.k === k;
    return (
      <button type="button" key={k} className={`em-th ${num ? "is-num" : ""} ${on ? "is-on" : ""}`}
        onClick={() => setSort(on ? (sort!.dir === 1 ? { k, dir: -1 } : null) : { k, dir: num || k === "opened" || k === "clicked" || k === "progress" ? -1 : 1 })}
        title={on ? (sort!.dir === 1 ? "Sorted A → Z / smallest first — click to flip" : "Sorted Z → A / largest first — click to clear") : "Sort by this column"}>
        <span>{label}</span><i className={on ? (sort!.dir === 1 ? "is-up" : "is-down") : ""}>{MkIco.arrow}</i>
      </button>
    );
  };
  const cell = (k: EmCol, r: EmRow): React.ReactNode => {
    const { c, g, sent: sentish } = r;
    switch (k) {
      case "audience": return <span className="em-aud">{r.list ? <><i>{r.list.entity === "companies" ? MkIco.building : MkIco.people}</i><span>{r.list.name}</span></> : <em>No list</em>}</span>;
      case "status": return (
        <span className="em-st">
          <span className={`em-pill is-${c.status}`}>{(c.status === "sending" && x.runner.running === c.id) && <i className="mk-pulse" />}{STATUS_LABEL[c.status]}</span>
          {(c.status === "sending" || c.status === "paused") && <i className="em-mini"><i style={{ width: `${(r.g.total ? (g.sent + g.failed) / g.total : 0) * 100}%` }} /></i>}
        </span>
      );
      case "sent": return <b className="em-n">{sentish ? fmtN(sentish) : "—"}</b>;
      case "opened": case "clicked": {
        const n = k === "opened" ? g.opened : g.clicked;
        return <span className={`em-rate is-${k} ${sentish ? "" : "is-none"}`}><i><i style={{ width: `${sentish ? (n / sentish) * 100 : 0}%` }} /></i><b>{sentish ? fmtPct(n, sentish) : "—"}</b></span>;
      }
      case "replies": return <b className="em-n">{g.replied ? fmtN(g.replied) : "—"}</b>;
      case "bounced": return <b className="em-n">{g.bounced ? fmtN(g.bounced) : "—"}</b>;
      case "unsub": return <b className="em-n">{g.unsub ? fmtN(g.unsub) : "—"}</b>;
      case "failed": return <b className="em-n">{g.failed ? fmtN(g.failed) : "—"}</b>;
      case "when": return <span className="em-when"><b>{c.status === "scheduled" ? fmtWhen(c.scheduled_at) : c.status === "draft" ? fmtWhen(c.updated_at) : fmtWhen(c.finished_at ?? c.started_at)}</b><em>{c.status === "scheduled" ? "goes out" : c.status === "draft" ? "edited" : c.status === "sent" ? "sent" : "started"}</em></span>;
      case "created": return <span className="em-when"><b>{fmtDay(c.created_at)}</b></span>;
      case "from": return <span className="em-from">{c.from_mailbox || <em>Default mailbox</em>}</span>;
      case "progress": { const p = g.total ? (g.sent + g.failed) / g.total : c.status === "sent" ? 1 : 0; return <span className="em-rate is-prog"><i><i style={{ width: `${p * 100}%` }} /></i><b>{Math.round(p * 100)}%</b></span>; }
    }
  };
  return (
    <div className="mkx-page em">
      {portal}
      <KpiStrip className="em-kpis" defs={EM_KPIS} ctx={{ campaigns: x.campaigns, agg: x.agg.by, lists: x.lists, unsubs: x.unsubs }} prefKey={EM_KPI_PREF} defaults={["sent", "delivered", "open", "click", "replies", "unsub"]} />
      {lay === "cards" ? (
        <div className="em-cards">
          {shown.map((r, i) => {
            const c = r.c, g = r.g;
            const done = c.status === "sent" || c.status === "sending" || c.status === "paused" || c.status === "cancelled";
            return (
              <article key={c.id} role="button" tabIndex={0} className={`em-card is-${c.status}`} style={{ ["--i" as string]: Math.min(i, 14) } as CSSProperties}
                onClick={() => x.openCampaign(c.id)} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) x.openCampaign(c.id); }}>
                <div className="em-card-art">
                  <MailThumb subject={c.subject} body={c.body_html} preheader={c.preheader} />
                  <span className={`em-pill is-${c.status}`}>{(c.status === "sending" && x.runner.running === c.id) && <i className="mk-pulse" />}{STATUS_LABEL[c.status]}</span>
                  <span className="em-card-acts" onClick={(e) => e.stopPropagation()}>
                    <button className="em-ico" title="Make a copy" disabled={busy === c.id} onClick={() => void duplicate(c)}>{MkIco.copy}</button>
                    {c.status === "draft" && <MkConfirm className="em-ico" label={MhIco.trash} ask="Delete draft?" yes="Delete" onYes={() => void remove(c)} />}
                  </span>
                </div>
                <div className="em-card-b">
                  <span onClick={(e) => e.stopPropagation()}><MkRename tag="b" name={c.name} onSave={(nm) => rename(c, nm)} /></span>
                  <em><ChipText text={c.subject} empty="No subject yet" /></em>
                </div>
                <div className="em-card-f">
                  <span className="em-aud">{r.list ? <><i>{r.list.entity === "companies" ? MkIco.building : MkIco.people}</i><span>{r.list.name}</span></> : <em>No list</em>}</span>
                  <span className="em-card-when">{c.status === "scheduled" ? <>{MhIco.cal}{fmtWhen(c.scheduled_at)}</> : c.status === "draft" ? <>{MhIco.edit}{fmtWhen(c.updated_at)}</> : <>{MkIco.send}{fmtWhen(c.finished_at ?? c.started_at)}</>}</span>
                </div>
                {done && (
                  <div className="em-card-figs">
                    <span><b>{r.sent ? fmtN(r.sent) : "—"}</b><em>sent</em></span>
                    <span className="is-open"><b>{r.sent ? fmtPct(g.opened, r.sent) : "—"}</b><em>opened</em></span>
                    <span><b>{r.sent ? fmtPct(g.clicked, r.sent) : "—"}</b><em>clicked</em></span>
                    <span><b>{g.replied ? fmtN(g.replied) : "—"}</b><em>replies</em></span>
                  </div>
                )}
              </article>
            );
          })}
          {!shown.length && <div className="em-none">{MkIco.mail}<span>{q ? `Nothing matches “${q}”.` : "No campaigns here."}</span></div>}
        </div>
      ) : (
      <div className="em-list" style={{ ["--em-grid" as string]: grid } as CSSProperties}>
        <div className="em-head em-row">
          {head("name", "Campaign")}
          {cols.map((k) => head(k, EM_COLS[k].label, EM_COLS[k].num))}
          <span className="em-th-end" />
        </div>
        <div className="em-body">
          {shown.map((r, i) => {
            const c = r.c;
            return (
              <div key={c.id} role="button" tabIndex={0} className={`em-row em-tr is-${c.status}`} style={{ ["--i" as string]: Math.min(i, 14) } as CSSProperties}
                onClick={() => x.openCampaign(c.id)} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) x.openCampaign(c.id); }}>
                <span className="em-name">
                  <i className={`em-ava is-${c.status}`}>{c.status === "draft" ? MhIco.edit : c.status === "scheduled" ? MhIco.cal : c.status === "sending" || c.status === "paused" ? MkIco.send : MkIco.mail}</i>
                  <span><MkRename tag="b" name={c.name} onSave={(nm) => rename(c, nm)} /><em><ChipText text={c.subject} empty="No subject yet" /></em></span>
                </span>
                {cols.map((k) => <span key={k} className={`em-td is-${k} ${EM_COLS[k].num ? "is-num" : ""}`}>{cell(k, r)}</span>)}
                <span className="em-acts" onClick={(e) => e.stopPropagation()}>
                  <button className="em-ico" title="Make a copy" disabled={busy === c.id} onClick={() => void duplicate(c)}>{MkIco.copy}</button>
                  {c.status === "draft" && <MkConfirm className="em-ico" label={MhIco.trash} ask="Delete draft?" yes="Delete" onYes={() => void remove(c)} />}
                  <i className="em-go">{moArrow}</i>
                </span>
              </div>
            );
          })}
          {!shown.length && <div className="em-none">{MkIco.mail}<span>{q ? `Nothing matches “${q}”.` : "No campaigns here."}</span></div>}
        </div>
      </div>
      )}
      {colPick && <EmColumns cols={cols} onChange={setCols} onClose={() => setColPick(null)} at={colPick} />}
    </div>
  );
}

/** Marketing › E-mail › Templates: the e-mails kept to start campaigns from — as cards or as a list. */
function TemplatesView({ x, tpls, setTpls, missing, seg, q: qIn, lay = "cards", onEdit }: {
  x: HubCtx; tpls: MkTemplate[] | null; setTpls: (f: (xs: MkTemplate[] | null) => MkTemplate[] | null) => void; missing: boolean; seg: React.ReactNode; q?: string;
  lay?: EmLay; onEdit?: (t: MkTemplate | "new") => void;
}) {
  const [q0, setQ] = useState("");
  /** with the page's bar holding the search (qIn), the view has no toolbar of its own */
  const q = qIn ?? q0;
  const [ren, setRen] = useState<{ id: string; name: string } | null>(null);
  const [peek, setPeek] = useState<MkTemplate | null>(null);
  const nq = norm(q);
  const shown = (tpls ?? []).filter((t) => !nq || norm(`${t.name} ${t.subject}`).includes(nq));
  const use = (t: MkTemplate) => { pendingTpl = t; x.openCampaign("new"); };
  const rename = async () => {
    if (!ren) return;
    const t = (tpls ?? []).find((y) => y.id === ren.id);
    if (!t || !ren.name.trim() || ren.name.trim() === t.name) { setRen(null); return; }
    const r = await saveMkTemplate({ ...t, name: ren.name });
    setRen(null);
    if (r.error || !r.row) { x.toast(r.error ?? "Not saved"); return; }
    setTpls((xs) => (xs ?? []).map((y) => (y.id === r.row!.id ? r.row! : y)));
  };
  const drop = async (t: MkTemplate) => {
    const e = await deleteMkTemplate(t.id);
    if (e) { x.toast(e); return; }
    setTpls((xs) => (xs ?? []).filter((y) => y.id !== t.id));
    x.toast(`“${t.name}” deleted`);
  };
  const nameOf = (t: MkTemplate) => (ren?.id === t.id
    ? <input className="mk-input mkt-ren" autoFocus value={ren.name} onChange={(e) => setRen({ id: t.id, name: e.target.value })} onBlur={() => void rename()} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void rename(); if (e.key === "Escape") setRen(null); }} aria-label="Template name" />
    : <b className="mkt-name" title={t.name}>{t.name}</b>);
  const icons = (t: MkTemplate, preview = true) => (
    <>
      <button className="em-ico" title="Rename" aria-label="Rename" onClick={() => setRen({ id: t.id, name: t.name })}>{MhIco.edit}</button>
      <MkConfirm className="em-ico" label={MhIco.trash} ask={`Delete “${t.name}”?`} yes="Delete" onYes={() => void drop(t)} />
      {preview && <button className="em-ico" title="Preview" aria-label="Preview" onClick={() => setPeek(t)}>{MhIco.eye}</button>}
    </>
  );
  const acts = (t: MkTemplate, withIcons = true) => (
    <span className="mtp-acts" onClick={(e) => e.stopPropagation()}>
      {withIcons && icons(t)}
      {onEdit && <button className="mtp-btn" onClick={() => onEdit(t)} title="Change the template">{MhIco.edit}<span>Edit</span></button>}
      <button className="mtp-btn is-go" onClick={() => use(t)} disabled={x.missing} title="Start a campaign from it">{MkIco.send}<span>Use</span></button>
    </span>
  );
  return (
    <div className="mkh-email mtp">
      {qIn === undefined && (
        <div className="mkh-toolbar">
          {seg}
          <label className="mk-search">{MkIco.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a template" /></label>
          <span className="mk-grow" />
          <button className="mk-btn is-primary" onClick={() => x.openCampaign("new")} disabled={x.missing}>{MkIco.plus}New e-mail</button>
        </div>
      )}
      {tpls == null ? <MkLoading /> : missing ? (
        <div className="mk-empty-sm is-wide">{MhIco.tpl}<span>{NEEDS_TPL}</span></div>
      ) : !tpls.length ? (
        <div className="mk-empty">
          <div className="mk-empty-art" aria-hidden="true"><span className="is-a">{MhIco.tpl}</span><span className="is-b">{MkIco.mail}</span><span className="is-c">{MkIco.copy}</span></div>
          <h3>No templates yet</h3>
          <p>Write one here, or keep a campaign's e-mail with <b>Templates › Save as template</b> while you write it. The subject, preview line, text and footer are kept to start the next campaigns from.</p>
          <div className="mk-empty-acts">{onEdit && <button className="mk-btn is-primary is-big" onClick={() => onEdit("new")}>{MkIco.plus}New template</button>}</div>
        </div>
      ) : lay === "list" ? (
        <div className="mtp-list">
          <div className="mtp-row mtp-head"><span>Template</span><span>Preview line</span><span>Used</span><span>Edited</span><span /></div>
          <div className="mtp-body">
            {shown.map((t, i) => (
              <div key={t.id} role="button" tabIndex={0} className="mtp-row mtp-tr" style={{ "--i": Math.min(i, 14) } as CSSProperties} onClick={() => setPeek(t)}
                onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) setPeek(t); }}>
                <span className="mtp-name"><i className="mtp-ava">{MhIco.tpl}</i><span>{nameOf(t)}<em><ChipText text={t.subject} empty="No subject" /></em></span></span>
                <span className="mtp-pre">{t.preheader || <em>—</em>}</span>
                <span className="mtp-used"><b>{t.used_count ? `${fmtN(t.used_count)}×` : "—"}</b></span>
                <span className="mtp-when">{fmtWhen(t.updated_at)}</span>
                {acts(t)}
              </div>
            ))}
            {!shown.length && <div className="em-none">{MhIco.tpl}<span>No template matches “{q}”.</span></div>}
          </div>
        </div>
      ) : (
        <div className="mtp-grid">
          {onEdit && !nq && (
            <button className="mtp-card mtp-new" onClick={() => onEdit("new")}>
              <span className="mtp-new-ico">{MkIco.plus}</span><b>New template</b><em>Write an e-mail to start campaigns from</em>
            </button>
          )}
          {shown.map((t, i) => (
            <article key={t.id} className="mtp-card" style={{ "--i": Math.min(i, 12) } as CSSProperties}>
              <div className="mtp-art-wrap">
                <button className="mtp-art" onClick={() => setPeek(t)} aria-label={`Preview ${t.name}`}>
                  <MailThumb subject={t.subject} body={t.body_html} preheader={t.preheader} />
                  {t.used_count > 0 && <span className="mtp-used-pill">{MkIco.send}Used {fmtN(t.used_count)}×</span>}
                </button>
                <span className="mtp-icons" onClick={(e) => e.stopPropagation()}>{icons(t, false)}</span>
              </div>
              <div className="mtp-b">
                {nameOf(t)}
                <em><ChipText text={t.subject} empty="No subject" /></em>
              </div>
              <div className="mtp-f"><span className="mtp-when" title="Edited">{fmtWhen(t.updated_at)}</span>{acts(t, false)}</div>
            </article>
          ))}
          {!shown.length && <div className="em-none">{MhIco.tpl}<span>No template matches “{q}”.</span></div>}
        </div>
      )}
      {peek && <TemplatePeek x={x} t={peek} onClose={() => setPeek(null)} onUse={() => { const t = peek; setPeek(null); use(t); }} onEdit={onEdit ? () => { const t = peek; setPeek(null); onEdit(t); } : undefined} />}
    </div>
  );
}

/** A template, big: the e-mail on the left (desktop / phone), what it is and what to do with it on the right. */
function TemplatePeek({ x, t, onClose, onUse, onEdit }: { x: HubCtx; t: MkTemplate; onClose: () => void; onUse: () => void; onEdit?: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const from = x.outlookMail || x.me.email || "you@company.com";
  const doc = useMemo(() => mailDoc(buildMail({ subject: t.subject, body_html: t.body_html, preheader: t.preheader ?? "", track_opens: false, track_clicks: false }, { id: "preview", merge: DEMO_MERGE }, { tracking: false, from }).html), [t, from]);
  return createPortal(
    <div className="mkh-modal-bg mtp-peek-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mtp-peek" role="dialog" aria-modal="true" aria-label={t.name}>
        <div className="mtp-peek-pv">
          <MailPreview doc={doc} subject={mergeText(t.subject, DEMO_MERGE, false)} preheader={t.preheader ? mergeText(t.preheader, DEMO_MERGE, false) : ""} from={from} to="Laura Gil <laura@example.com>"
            nav={<span className="mst-pv-nav is-demo"><em><b>Laura Gil</b><small>sample contact</small></em></span>} />
        </div>
        <aside className="mtp-peek-side">
          <div className="mtp-peek-top"><span className="mtp-peek-ico">{MhIco.tpl}</span><em>E-mail template</em><button className="mtp-peek-x" onClick={onClose} aria-label="Close">{MhIco.x}</button></div>
          <h2 title={t.name}>{t.name}</h2>
          <dl className="mtp-peek-facts">
            <div><dt>Subject</dt><dd><ChipText text={t.subject} empty="No subject" /></dd></div>
            <div><dt>Preview line</dt><dd>{t.preheader || <em>None</em>}</dd></div>
            <div className="is-half"><dt>Used</dt><dd><b>{t.used_count ? `${fmtN(t.used_count)}×` : "Not yet"}</b></dd></div>
            <div className="is-half"><dt>Edited</dt><dd>{fmtWhen(t.updated_at)}</dd></div>
          </dl>
          <span className="mk-grow" />
          <button className="mtp-peek-go" onClick={onUse} disabled={x.missing}>{MkIco.send}Use this template</button>
          {onEdit && <button className="mtp-peek-alt" onClick={onEdit}>{MhIco.edit}Edit the template</button>}
        </aside>
      </div>
    </div>,
    document.body,
  );
}

/** A connected app's mark (Settings › Integrations logos). */
const MARKS: Record<string, { c: string; t: string }> = { ionos: { c: "#003d8f", t: "IO" } };
function BrandMark({ k, s: size = 34 }: { k: string; s?: number }) {
  const b = BRANDS[k], m = MARKS[k];
  return (
    <span className="mst-brand" style={{ ["--c" as string]: b?.hex ?? m?.c ?? "#5a7d6d", width: size, height: size, fontSize: m ? size * 0.34 : undefined } as CSSProperties}>
      {b ? <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} aria-label={b.title} role="img"><path d={b.path} fill="currentColor" /></svg> : m?.t ?? k.slice(0, 2)}
    </span>
  );
}

/* ═══════════ the e-mail studio: popovers, a phone / desktop preview, thumbnails ═══════════ */
type CpPop = null | "fields" | "form" | "tpl" | "ai" | "foot";
const CpIco = {
  braces: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" /></svg>,
  bullets: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" fill="currentColor" /><circle cx="4.5" cy="12" r="1" fill="currentColor" /><circle cx="4.5" cy="18" r="1" fill="currentColor" /></svg>,
  numbers: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M3.6 14.2c.3-.7 1-1.1 1.7-1 1.4.2 1.4 1.8.3 2.6L3.5 17.5H6" /></svg>,
  desktop: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>,
  phone: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></svg>,
  rows: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="4.5" width="17" height="4" rx="2" /><rect x="3.5" y="10" width="17" height="4" rx="2" /><rect x="3.5" y="15.5" width="17" height="4" rx="2" /></svg>,
  cards: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" /><rect x="13" y="3.5" width="7.5" height="7.5" rx="2" /><rect x="3.5" y="13" width="7.5" height="7.5" rx="2" /><rect x="13" y="13" width="7.5" height="7.5" rx="2" /></svg>,
};
const DEMO_MERGE: Record<string, string> = { first_name: "Laura", last_name: "Gil", full_name: "Laura Gil", company: "Acme Iberia", position: "CFO", city: "Madrid", email: "laura@example.com" };

/** A small floating panel under (or over) its button; closes on a click outside or Esc. Dropdowns opened inside it don't close it. */
function MkPop({ onClose, className = "", children }: { onClose: () => void; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || ref.current?.contains(t) || ref.current?.parentElement?.contains(t) || t.closest(".sel-pop, .sel-layer, .dp-pop, .dp-layer, .tp-pop, .tp-layer, [role='dialog']")) return;
      close.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, []);
  return <div ref={ref} className={className} role="group">{children}</div>;
}

const mailDoc = (html: string, pad = 22) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}body{padding:${pad}px;background:#fff}a{color:#0a6f4d}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;

/** The e-mail as people will see it: the inbox line, then the opened e-mail — on a desktop or on a phone. */
function MailPreview({ doc, subject, preheader, from, to, nav }: { doc: string; subject: string; preheader: string; from: string; to: string; nav?: React.ReactNode }) {
  const [dev, setDevRaw] = useState<"desktop" | "phone">(() => { try { return localStorage.getItem("mk-pv-dev") === "phone" ? "phone" : "desktop"; } catch { return "desktop"; } });
  const setDev = (d: "desktop" | "phone") => { setDevRaw(d); try { localStorage.setItem("mk-pv-dev", d); } catch { /* private mode */ } };
  return (
    <div className={`mst-pv is-${dev}`}>
      <div className="mst-pv-h">
        <b>Preview</b>
        {nav}
        <span className="mk-grow" />
        <div className="mst-dev" role="tablist" aria-label="Preview on">
          <button role="tab" aria-selected={dev === "desktop"} className={dev === "desktop" ? "is-on" : ""} onClick={() => setDev("desktop")} title="Desktop">{CpIco.desktop}</button>
          <button role="tab" aria-selected={dev === "phone"} className={dev === "phone" ? "is-on" : ""} onClick={() => setDev("phone")} title="Phone">{CpIco.phone}</button>
        </div>
      </div>
      <div className="mst-pv-stage">
        <div className="mst-pv-dev">
          <div className="mst-pv-inbox">
            <span className="mst-pv-av">{initials(from)}</span>
            <span className="mst-pv-inbox-t"><b>{from}</b><span><strong>{subject || "No subject"}</strong>{preheader && <em> — {preheader}</em>}</span></span>
            <time>now</time>
          </div>
          <div className="mst-pv-mail">
            <div className="mst-pv-meta"><b>{subject || "No subject"}</b><span><em>To</em>{to}</span></div>
            <iframe title="E-mail preview" sandbox="" srcDoc={doc} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A campaign's or a template's e-mail, small: what the card shows. */
function MailThumb({ subject, body, preheader }: { subject: string; body: string; preheader?: string | null }) {
  const doc = useMemo(() => mailDoc(buildMail({ subject, body_html: body || "<p style=\"color:#9aa6a1\">No text yet</p>", preheader: preheader ?? "", track_opens: false, track_clicks: false }, { id: "thumb", merge: DEMO_MERGE }, { tracking: false, from: "you@company.com" }).html, 26), [subject, body, preheader]);
  return <span className="mk-thumb" aria-hidden="true"><iframe title="" tabIndex={-1} sandbox="" srcDoc={doc} loading="lazy" /></span>;
}

function CampaignView({ x, id, brief, onBack, onOpen }: { x: HubCtx; id: string | "new"; brief?: string; onBack: () => void; onOpen: (id: string) => void }) {
  const c = id === "new" ? null : x.campaigns.find((y) => y.id === id) ?? null;
  if (id !== "new" && !c) return <MkLoading />;
  if (!c || c.status === "draft" || c.status === "scheduled") return <Composer x={x} campaign={c} brief={brief} onBack={onBack} onSaved={onOpen} />;
  return <CampaignReport x={x} c={c} onBack={onBack} onOpen={onOpen} />;
}

function Composer({ x, campaign, brief, onBack, onSaved, tplEdit, onTplSaved }: {
  x: HubCtx; campaign: MkCampaign | null; brief?: string; onBack: () => void; onSaved: (id: string) => void;
  /** a template edited on its own (Templates › Edit / New template): no audience, no sending */
  tplEdit?: MkTemplate | "new"; onTplSaved?: (t: MkTemplate) => void;
}) {
  const { w, eng, lists, members, optOut, me, runner } = x;
  const isTpl = !!tplEdit;
  // a new campaign started from a template (Templates › Use), or the template being edited
  const [tpl0] = useState<MkTemplate | null>(() => (tplEdit ? (tplEdit === "new" ? null : tplEdit) : campaign ? null : takePendingTpl()));
  /** the toolbar's open popover */
  const [pop, setPop] = useState<CpPop>(null);
  const init = splitBody(campaign?.body_html ?? tpl0?.body_html ?? "<p>Hola {{first_name}},</p><p></p><p>Un saludo,</p>");
  const [step, setStep] = useState<0 | 1 | 2>(isTpl ? 1 : campaign?.list_id ? 1 : brief ? 1 : 0);
  const [name, setName] = useState(campaign?.name ?? tpl0?.name ?? "");
  const [listId, setListId] = useState(() => campaign?.list_id ?? pendingList ?? "");
  useEffect(() => { pendingList = null; }, []);
  const [from, setFrom] = useState(campaign?.from_mailbox ?? "");
  /** the connected account it's sent from ("" = your Outlook connection) */
  const [sender, setSender] = useState(campaign?.sender_account ?? "");
  /** "Another address": a Send-as / alias address of the chosen mailbox */
  const [otherFrom, setOtherFrom] = useState(!!campaign?.from_mailbox);
  const [replyTo, setReplyTo] = useState(campaign?.reply_to ?? "");
  const [subject, setSubject] = useState(campaign?.subject ?? tpl0?.subject ?? "");
  const [preheader, setPreheader] = useState(campaign?.preheader ?? tpl0?.preheader ?? "");
  /* templates: start from one, or keep this e-mail as one */
  const [tpls, setTpls] = useState<MkTemplate[]>([]);
  const [tplMiss, setTplMiss] = useState(false);
  useEffect(() => { loadMkTemplates().then((r) => { setTpls(r.rows); setTplMiss(r.missing); }); }, []);
  const [tplSave, setTplSave] = useState<{ name: string; replace: string } | null>(null);
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
  const [ai, setAi] = useState({ open: false, brief: brief ?? campaign?.ai_brief ?? "", tone: AI_TONES[0].value, lang: "es", cta: "", link: "", busy: false, err: "", alts: [] as string[] });
  const [editorKey, setEditorKey] = useState(0);
  const editRef = useRef<HTMLDivElement | null>(null);
  const subjRef = useRef<HTMLDivElement | null>(null);
  const lastFocus = useRef<"body" | "subject">("body");
  useEffect(() => { if (editRef.current && !htmlMode && mkFromChips(editRef.current.innerHTML) !== body) editRef.current.innerHTML = mkToChips(body); }, [htmlMode, editorKey, step]); // eslint-disable-line react-hooks/exhaustive-deps
  // the subject line shows its {{fields}} as chips too
  useEffect(() => { const el = subjRef.current; if (el && mkLineText(el.innerHTML) !== subject) el.innerHTML = mkToChips(mkEsc(subject)); }, [subject, step]);

  const sizes = useMemo(() => new Map(lists.map((l) => [l.id, eng.recipients(l.entity, listRecords(eng, w, l, members, l.id), l.definition?.who ?? "all", optOut)])), [lists, eng, w, members, optOut]);
  const list = lists.find((l) => l.id === listId) ?? null;
  const recs = list ? sizes.get(list.id) ?? [] : [];
  const ok = recs.filter((r) => r.state === "ok");
  const sample = ok[Math.min(pi, Math.max(0, ok.length - 1))];
  const fullBody = joinBody(body, footer);
  const senderAcct = x.conn.mail.find((a) => a.id === sender) ?? null;
  /** the mailbox that sends: the chosen connected account, else your Outlook connection */
  const baseAddr = senderAcct?.email ?? x.outlookMail ?? me.email;
  const fromAddr = (otherFrom && from.trim()) || baseAddr;
  const demo = { first_name: "Laura", last_name: "Gil", full_name: "Laura Gil", company: "Acme Iberia", position: "CFO", city: "Madrid", email: "laura@example.com" };
  const prev = buildMail({ subject, body_html: fullBody, preheader, track_opens: false, track_clicks: false }, { id: "preview", merge: sample?.merge ?? demo }, { tracking: false, from: fromAddr || "you@company.com" });
  const previewDoc = mailDoc(prev.html);

  const exec = (cmd: string, arg?: string) => { editRef.current?.focus(); document.execCommand(cmd, false, arg); setBody(mkFromChips(editRef.current?.innerHTML ?? "")); };
  const insertField = (k: string) => {
    const tok = `{{${k}}}`;
    if (lastFocus.current === "subject" && subjRef.current) {
      const el = subjRef.current;
      mkInsertChip(el, k);
      setSubject(mkLineText(el.innerHTML));
    } else if (htmlMode) setBody((v) => v + tok);
    else if (editRef.current) { mkInsertChip(editRef.current, k); setBody(mkFromChips(editRef.current.innerHTML)); }
  };
  /** a link: on the selected text, or (nothing selected) the address itself / a text you write */
  const [linkAt, setLinkAt] = useState<LinkTarget | null>(null);

  const row = () => ({
    name: name.trim() || subject.trim() || "Untitled campaign", list_id: listId || null, from_mailbox: otherFrom ? from.trim() || null : null, sender_account: sender || null, reply_to: replyTo.trim() || null,
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

  // a brief from elsewhere (Overview, a campaign's "Follow up"): the AI popover opens on the message step
  useEffect(() => { if (brief) setPop("ai"); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const runAi = async (improve: boolean): Promise<boolean> => {
    if (!ai.brief.trim() && !improve) { setAi((a) => ({ ...a, err: "Say what the e-mail is about." })); return false; }
    setAi((a) => ({ ...a, busy: true, err: "" }));
    const r = await aiWrite<{ email: { subject: string; subjects_alt?: string[]; preheader?: string; body_html: string } }>({
      kind: "email", brief: ai.brief, tone: ai.tone, lang: ai.lang, cta: ai.cta, link: ai.link, company: me.company,
      audience: list ? `${list.name}${list.description ? ` — ${list.description}` : ""}` : "", fields: MERGE_FIELDS.map((m) => m.key),
      current: improve ? `Subject: ${subject}\n\n${body}` : undefined,
    });
    if (!r.ok) { setAi((a) => ({ ...a, busy: false, err: r.error })); return false; }
    const e = r.data.email;
    if (!e?.body_html) { setAi((a) => ({ ...a, busy: false, err: "The AI gave no e-mail — try again." })); return false; }
    setSubject(e.subject ?? subject); setPreheader(e.preheader ?? ""); setBody(e.body_html ?? body);
    setHtmlMode(false); setEditorKey((k) => k + 1);
    setAi((a) => ({ ...a, busy: false, alts: (e.subjects_alt ?? []).filter(Boolean) }));
    if (!name.trim()) setName(e.subject ?? "");
    return true;
  };
  /** this e-mail (subject, preview line, text and footer) into a template — new, or over one that exists */
  const keepAsTemplate = async () => {
    if (!tplSave) return;
    const nm = tplSave.name.trim();
    if (!nm) return;
    setBusy("tpl");
    const r = await saveMkTemplate({ id: tplSave.replace || undefined, name: nm, subject, preheader, body_html: fullBody });
    setBusy(null);
    if (r.error || !r.row) { setMsg({ tone: "err", text: r.error ?? "Not saved." }); return; }
    setTpls((xs) => [r.row!, ...xs.filter((t) => t.id !== r.row!.id)]);
    setTplSave(null); setPop(null);
    x.toast(tplSave.replace ? `Template “${r.row.name}” updated` : `Saved as the template “${r.row.name}”`);
  };
  /** Templates › Edit: the template itself is saved (name, subject, preview line, text and footer) */
  const saveTplMode = async () => {
    setBusy("save"); setMsg(null);
    const r = await saveMkTemplate({ id: tpl0?.id, name: name.trim() || subject.trim() || "Untitled template", subject, preheader, body_html: fullBody });
    setBusy(null);
    if (r.error || !r.row) { setMsg({ tone: "err", text: r.error ?? "Not saved." }); return; }
    x.toast(tpl0 ? "Template saved" : `Template “${r.row.name}” created`);
    onTplSaved?.(r.row);
  };
  /** a template's subject, preview line and text into this e-mail */
  const applyTemplate = (id: string) => {
    const t = tpls.find((y) => y.id === id);
    if (!t) return;
    if (textOf(body).length > 30 && !window.confirm(`Replace what you've written with the template “${t.name}”?`)) return;
    const sb = splitBody(t.body_html);
    setSubject(t.subject); setPreheader(t.preheader ?? ""); setBody(sb.body); setFooter(sb.footer);
    setHtmlMode(false); setEditorKey((k) => k + 1);
    if (!name.trim()) setName(t.name);
    void supabase.from("mk_templates").update({ used_count: (t.used_count ?? 0) + 1 }).eq("id", t.id);
    x.toast(`Started from “${t.name}”`);
  };
  const testSend = async () => {
    if (!me.email) { setMsg({ tone: "err", text: "Your user has no e-mail to send the test to." }); return; }
    setBusy("test"); setMsg(null);
    const m = buildMail({ subject: `[Test] ${subject}`, body_html: fullBody, preheader }, { id: "test", merge: sample?.merge ?? demo }, { tracking: false, from: fromAddr });
    const res = await sendMailVia(sender || null, { to: [me.email], subject: m.subject, html: m.html, from: otherFrom ? from.trim() || null : null, replyTo: replyTo.trim() || null, ref: "campaign:test" });
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
  const stepDone = (i: number) => (i === 0 ? !!list : i === 1 ? !!subject.trim() && !!textOf(body) : false);
  const footOk = /\{\{\s*unsubscribe_(url|email)\s*\}\}|mailto:|baja/i.test(footer);
  const tg = (k: CpPop) => setPop((p) => (p === k ? null : k));
  const words = textOf(body).split(/\s+/).filter(Boolean).length;
  const minutes = ok.length ? Math.max(1, Math.ceil(ok.length / PROVIDER.perMinute)) : 0;
  const okOf = (l: MkList) => (sizes.get(l.id) ?? []).filter((y) => y.state === "ok").length;
  const quick = (() => { const q = lists.slice(0, 6); if (list && !q.includes(list)) q[q.length - 1] = list; return q; })();
  const noDown = (e: React.MouseEvent) => e.preventDefault();
  const liveForms = x.forms.filter((f) => f.status === "live");
  const openTpl = () => { if (pop !== "tpl") setTplSave({ name: name.trim() || subject.trim() || "New template", replace: "" }); tg("tpl"); };
  const pvTo = sample ? `${sample.name} <${sample.email}>` : "Laura Gil <laura@example.com>";
  const pvNav = !isTpl && ok.length > 0 ? (
    <span className="mst-pv-nav">
      <button onClick={() => setPi((v) => Math.max(0, v - 1))} disabled={pi <= 0} aria-label="Previous person">‹</button>
      <em title={sample?.email}><b>{sample?.name ?? ""}</b><small>{Math.min(pi, ok.length - 1) + 1} / {fmtN(ok.length)}</small></em>
      <button onClick={() => setPi((v) => Math.min(ok.length - 1, v + 1))} disabled={pi >= ok.length - 1} aria-label="Next person">›</button>
    </span>
  ) : <span className="mst-pv-nav is-demo"><em><b>Laura Gil</b><small>sample contact</small></em></span>;

  return (
    <section className={`mkh-cmp mst ${isTpl ? "is-tpl" : ""}`}>
      <header className="mst-head">
        <button className="mst-back" onClick={onBack} aria-label={isTpl ? "Back to templates" : "Back to campaigns"} title={isTpl ? "Back to templates" : "Back to campaigns"}>{MkIco.back}</button>
        <span className={`mst-kind ${isTpl ? "is-tpl" : ""}`}>{isTpl ? MhIco.tpl : MkIco.mail}</span>
        <div className="mst-title">
          <em>{isTpl ? (tpl0 ? "E-mail template" : "New template") : campaign?.status === "scheduled" ? `Scheduled · ${fmtWhen(campaign.scheduled_at)}` : campaign ? "Draft" : "New campaign"}</em>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={isTpl ? "Name this template" : "Name this campaign"} aria-label={isTpl ? "Template name" : "Campaign name"} title={isTpl ? "Template name" : "Only your team sees the campaign's name"} />
        </div>
        {!isTpl && (
          <ol className="mst-steps">
            {STEPS.map((s, i) => (
              <li key={s}>
                <button className={`${step === i ? "is-on" : ""} ${stepDone(i) ? "is-done" : ""}`} onClick={() => setStep(i as 0 | 1 | 2)} aria-current={step === i ? "step" : undefined}>
                  <i>{stepDone(i) && step !== i ? MkIco.check : i + 1}</i><span>{s}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        <button className="mst-save" disabled={!!busy || x.missing || (isTpl && tplMiss)} onClick={() => void (isTpl ? saveTplMode() : saveDraft())}>
          {MhIco.save}<span>{busy === "save" ? "Saving…" : isTpl ? "Save template" : "Save draft"}</span>
        </button>
      </header>

      <div className="mst-grid">
        <div className="mst-main">
          {step === 0 && (
            <>
              <div className="mst-card mst-aud">
                <div className="mst-h">
                  <i className="mst-h-ico">{MkIco.people}</i>
                  <div><b>Who gets it</b><em>Pick one of your lists</em></div>
                  <span className="mk-grow" />
                  {lists.length > quick.length && (
                    <div className="mst-more"><Select size="sm" searchable value={quick.some((l) => l.id === listId) ? "" : listId} placeholder={`All ${lists.length} lists…`} onChange={(v) => v && setListId(v)}
                      options={lists.map((l) => ({ value: l.id, label: l.name, hint: `${fmtN(okOf(l))} people` }))} /></div>
                  )}
                  <button className="mst-chip" onClick={() => x.go("audiences")}>{MkIco.plus}New list</button>
                </div>
                {!lists.length ? (
                  <div className="mst-empty">{MkIco.list}<span>You have no lists yet. Build one in Audiences — by any field of your contacts, their companies or their deals.</span></div>
                ) : (
                  <div className="mst-lists">
                    {quick.map((l) => (
                      <button key={l.id} className={`mst-list ${listId === l.id ? "is-on" : ""}`} onClick={() => setListId(l.id)} aria-pressed={listId === l.id}>
                        <span className="mst-list-ico">{l.entity === "companies" ? MkIco.building : MkIco.people}</span>
                        <span className="mst-list-t"><b title={l.name}>{l.name}</b><em>{l.kind === "dynamic" ? "Updates itself" : "Fixed people"}</em></span>
                        <span className="mst-list-n"><b>{fmtN(okOf(l))}</b><em>people</em></span>
                        <i className="mst-tick">{MkIco.check}</i>
                      </button>
                    ))}
                  </div>
                )}
                {list && (
                  <div className="mst-reach">
                    <b>{fmtN(ok.length)}</b>
                    <span><span>people on <strong>{list.name}</strong> will get it</span>{recs.length - ok.length > 0 && <em>{fmtN(recs.length - ok.length)} left out: no e-mail, a wrong address, unsubscribed or the same address twice</em>}</span>
                    {ok.length > 0 && (
                      <span className="mst-faces" aria-hidden="true">
                        {ok.slice(0, 5).map((r) => <i key={r.key} style={{ ["--h" as string]: hue(r.name || r.email) } as CSSProperties} title={r.name}>{initials(r.name || r.email)}</i>)}
                        {ok.length > 5 && <i className="is-more">+{fmtN(ok.length - 5)}</i>}
                      </span>
                    )}
                  </div>
                )}
                {!list && lists.length > 0 && <div className="mst-reach is-empty"><i>{MkIco.people}</i><span><span>Pick a list above</span><em>You'll see here how many people get the e-mail, and who's left out.</em></span></div>}
              </div>
              <div className="mst-card mst-sender">
                <div className="mst-h">
                  <i className="mst-h-ico">{MkIco.user}</i>
                  <div><b>Who sends it</b><em>One of your connected mailboxes</em></div>
                  <span className="mk-grow" />
                  <button className={`mst-chip ${otherFrom ? "is-on" : ""}`} onClick={() => setOtherFrom((v) => !v)} aria-pressed={otherFrom} title="Send as a shared mailbox or an alias of the chosen mailbox">@ Another address</button>
                  <button className="mst-chip" onClick={x.connect} title="Settings › Integrations">{MkIco.plus}Connect a mailbox</button>
                </div>
                <div className="mst-senders" role="radiogroup" aria-label="Send from">
                  <button role="radio" aria-checked={!sender} className={`mst-sender-c ${!sender ? "is-on" : ""}`} onClick={() => setSender("")}>
                    <BrandMark k="outlook" />
                    <span><b>Your Outlook</b><em>{x.outlookMail ?? (me.email ? `${me.email} · connect with mail` : "Not connected")}</em></span>
                    <i className="mst-tick">{MkIco.check}</i>
                  </button>
                  {x.conn.mail.map((a) => (
                    <button key={a.id} role="radio" aria-checked={sender === a.id} className={`mst-sender-c ${sender === a.id ? "is-on" : ""} ${a.status === "error" ? "is-err" : ""}`} onClick={() => setSender(a.id)} title={a.status === "error" ? a.last_error ?? "Needs signing in again" : a.email}>
                      <BrandMark k={a.kind} />
                      <span><b>{a.kind === "gmail" ? "Gmail" : a.kind === "ionos" ? "IONOS" : "Outlook"}{a.display_name ? ` · ${a.display_name}` : ""}</b><em>{a.status === "error" ? (a.kind === "ionos" ? "Check the password in Integrations" : "Sign in again in Integrations") : a.email}</em></span>
                      <i className="mst-tick">{MkIco.check}</i>
                    </button>
                  ))}
                </div>
                <div className="mst-fields">
                  {otherFrom && (
                    <label className="mst-f"><span>From address</span><input className="mst-in" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={senderAcct?.kind === "gmail" ? "An alias verified in Gmail" : senderAcct?.kind === "ionos" ? "An alias of this IONOS mailbox" : "A mailbox you may “Send as”"} autoFocus
                      title={fromNote(senderAcct?.kind)} />
                      <small className="mst-f-note">{fromNote(senderAcct?.kind)} Send yourself a test before the campaign.</small></label>
                  )}
                  <label className="mst-f"><span>Reply-to</span><input className="mst-in" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="Optional — where replies should go" /></label>
                </div>
              </div>
              <div className="mst-foot"><span className="mk-grow" /><button className="mst-next" disabled={!list} onClick={() => setStep(1)}>Continue to the message{MkIco.arrow}</button></div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="mst-card mst-msg lnkp-anchor">
                <div className="mst-env">
                  <label className="mst-f mst-subj"><span>Subject</span>
                    <div className="mst-line">
                      <div ref={subjRef} className="mst-in mk-line" contentEditable suppressContentEditableWarning role="textbox" aria-label="Subject"
                        data-ph="e.g. First name, your November close in half the time" onFocus={() => { lastFocus.current = "subject"; }}
                        onInput={(e) => setSubject(mkLineText((e.target as HTMLDivElement).innerHTML))}
                        onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                        onPaste={(e) => { e.preventDefault(); document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " ")); }} />
                      <em className={subject.length > 70 ? "is-warn" : ""} title="Characters — under 70 reads whole on phones">{subject.length}</em>
                    </div>
                  </label>
                  <label className="mst-f mst-pre"><span>Preview line</span><input className="mst-in" value={preheader} onChange={(e) => setPreheader(e.target.value)} placeholder="The grey text after the subject (optional)" /></label>
                </div>
                {ai.alts.length > 0 && (
                  <div className="mst-alts"><em>{MhIco.spark}Other subjects</em>{ai.alts.map((s) => <button key={s} onClick={() => setSubject(s)}><ChipText text={s} /></button>)}<button className="mst-alts-x" onClick={() => setAi((a) => ({ ...a, alts: [] }))} aria-label="Hide">{MhIco.x}</button></div>
                )}
                <div className="mst-tool">
                  {!htmlMode && (
                    <div className="mst-fmt">
                      <button onMouseDown={noDown} onClick={() => exec("bold")} title="Bold"><b>B</b></button>
                      <button onMouseDown={noDown} onClick={() => exec("italic")} title="Italic"><i>I</i></button>
                      <button onMouseDown={noDown} onClick={() => exec("underline")} title="Underline"><u>U</u></button>
                      <span />
                      <button onMouseDown={noDown} onClick={() => exec("formatBlock", "h2")} title="Heading">H</button>
                      <button onMouseDown={noDown} onClick={() => exec("formatBlock", "p")} title="Paragraph">¶</button>
                      <button onMouseDown={noDown} onClick={() => exec("insertUnorderedList")} title="Bullets">{CpIco.bullets}</button>
                      <button onMouseDown={noDown} onClick={() => exec("insertOrderedList")} title="Numbers">{CpIco.numbers}</button>
                      <button onMouseDown={noDown} className={linkAt ? "is-on" : ""} onClick={() => setLinkAt(linkAt ? null : captureLinkTarget(editRef.current))} title="Link — select text first to link it">{MhIco.link}</button>
                    </div>
                  )}
                  <div className="mst-pa">
                    <button className={`mst-tb ${pop === "fields" ? "is-on" : ""}`} onMouseDown={noDown} onClick={() => tg("fields")} title="Put the person's name, company… in the text or the subject">{CpIco.braces}<span>Personalize</span></button>
                    {pop === "fields" && (
                      <MkPop className="mst-pop mst-pop-fields" onClose={() => setPop(null)}>
                        <em className="mst-pop-k">Insert where the cursor is</em>
                        <div className="mst-chips">{MERGE_FIELDS.map((m) => <button key={m.key} onMouseDown={noDown} onClick={() => { insertField(m.key); setPop(null); }}><span className="mk-fld">{m.label}</span></button>)}</div>
                      </MkPop>
                    )}
                  </div>
                  {!htmlMode && liveForms.length > 0 && (
                    <div className="mst-pa">
                      <button className={`mst-tb ${pop === "form" ? "is-on" : ""}`} onMouseDown={noDown} onClick={() => tg("form")} title="Put one of your live forms in the e-mail">{MhIco.form}<span>Form</span></button>
                      {pop === "form" && (
                        <MkPop className="mst-pop mst-pop-form" onClose={() => setPop(null)}>
                          <em className="mst-pop-k">Live forms</em>
                          {liveForms.map((f) => (
                            <button key={f.id} className="mst-pop-row" onMouseDown={noDown} onClick={() => { exec("insertHTML", emailBlock(f as MkForm)); setPop(null); }}>
                              <i>{MhIco.form}</i><b>{f.settings.title || f.name}</b><small>{fmtN(f.response_count)} answers</small>
                            </button>
                          ))}
                        </MkPop>
                      )}
                    </div>
                  )}
                  <span className="mk-grow" />
                  {!isTpl && (
                    <div className="mst-pa is-bar">
                      <button className={`mst-tb ${pop === "tpl" ? "is-on" : ""}`} onClick={openTpl} title="Start from a template, or keep this e-mail as one">{MhIco.tpl}<span>Templates</span></button>
                      {pop === "tpl" && (
                        <MkPop className="mst-pop mst-pop-tpl is-right" onClose={() => setPop(null)}>
                          <div className="mst-pop-col">
                          <em className="mst-pop-k">Start from a template</em>
                          {tplMiss ? <p className="mst-pop-none">{NEEDS_TPL}</p> : !tpls.length ? <p className="mst-pop-none">No templates yet — save this e-mail as the first one below.</p> : (
                            <div className="mst-tpls">
                              {tpls.slice(0, 4).map((t) => (
                                <button key={t.id} onClick={() => { setPop(null); applyTemplate(t.id); }}>
                                  <i>{MhIco.tpl}</i><span><b>{t.name}</b><small><ChipText text={t.subject} empty="No subject" /></small></span>
                                </button>
                              ))}
                            </div>
                          )}
                          {tpls.length > 4 && <Select size="sm" searchable value="" placeholder={`All ${tpls.length} templates…`} onChange={(v) => { if (v) { setPop(null); applyTemplate(v); } }} options={tpls.map((t) => ({ value: t.id, label: t.name, hint: t.subject || undefined }))} />}
                          </div>
                          {!tplMiss && tplSave && (
                            <div className="mst-pop-col is-keep">
                              <em className="mst-pop-k">Keep this e-mail as a template</em>
                              <p className="mst-pop-none">The subject, the preview line, the text and the unsubscribe line — to start other campaigns from.</p>
                              <input className="mst-in" value={tplSave.name} onChange={(e) => setTplSave((v) => v && { ...v, name: e.target.value })} placeholder="Template name"
                                onKeyDown={(e) => { if (e.key === "Enter") void keepAsTemplate(); }} />
                              {tpls.length > 0 && (
                                <Select size="sm" value={tplSave.replace} onChange={(v) => setTplSave((s0) => s0 && { ...s0, replace: v ?? "", name: v ? tpls.find((t) => t.id === v)?.name ?? s0.name : s0.name })}
                                  options={[{ value: "", label: "As a new template" }, ...tpls.map((t) => ({ value: t.id, label: `Replace “${t.name}”` }))]} />
                              )}
                              <span className="mk-grow" />
                              <button className="mst-pop-go" disabled={busy === "tpl" || !tplSave.name.trim() || (!subject.trim() && !textOf(body))} onClick={() => void keepAsTemplate()}>{MhIco.save}{busy === "tpl" ? "Saving…" : tplSave.replace ? "Replace the template" : "Save as template"}</button>
                            </div>
                          )}
                        </MkPop>
                      )}
                    </div>
                  )}
                  <button className={`mst-tb is-code ${htmlMode ? "is-on" : ""}`} onClick={() => { if (!htmlMode) setBody(mkFromChips(editRef.current?.innerHTML ?? "") || body); setHtmlMode(!htmlMode); setLinkAt(null); }} title="Edit the HTML">{"</>"}</button>
                  <div className="mst-pa is-bar">
                    <button className={`mst-ai-btn ${pop === "ai" ? "is-on" : ""}`} onClick={() => tg("ai")}>{MhIco.spark}<span>Write with AI</span></button>
                    {pop === "ai" && (
                      <MkPop className="mst-pop mst-pop-ai is-right" onClose={() => { if (!ai.busy) setPop(null); }}>
                        <div className="mst-ai-h"><i>{MhIco.spark}</i><span><b>Write with AI</b><em>A few lines — AI drafts the subject, the preview line and the text</em></span></div>
                        <textarea autoFocus value={ai.brief} onChange={(e) => setAi((a) => ({ ...a, brief: e.target.value }))} rows={3} placeholder="What's it about, and what should people do after reading it?" />
                        <em className="mst-pop-k">Tone</em>
                        <div className="mst-pills">{AI_TONES.map((t) => <button key={t.value} className={ai.tone === t.value ? "is-on" : ""} onClick={() => setAi((a) => ({ ...a, tone: t.value }))}>{t.label}</button>)}</div>
                        <em className="mst-pop-k">Language</em>
                        <div className="mst-pills">{AI_LANGS.map((t) => <button key={t.value} className={ai.lang === t.value ? "is-on" : ""} onClick={() => setAi((a) => ({ ...a, lang: t.value }))}>{t.label}</button>)}</div>
                        <div className="mst-ai-2">
                          <input className="mst-in" value={ai.cta} onChange={(e) => setAi((a) => ({ ...a, cta: e.target.value }))} placeholder="Call to action, e.g. book a demo" />
                          <input className="mst-in" value={ai.link} onChange={(e) => setAi((a) => ({ ...a, link: e.target.value }))} placeholder="Link (optional)" />
                        </div>
                        {ai.err && <span className="mst-err">{ai.err}</span>}
                        <div className="mst-ai-acts">
                          {textOf(body).length > 30 && <button className="mst-pop-alt" disabled={ai.busy} onClick={() => void runAi(true).then((done) => { if (done) setPop(null); })}>Improve my draft</button>}
                          <button className="mst-pop-go" disabled={ai.busy} onClick={() => void runAi(false).then((done) => { if (done) setPop(null); })}>{ai.busy ? <><i className="mkh-spin" />Writing…</> : <>{MhIco.spark}Write it</>}</button>
                        </div>
                      </MkPop>
                    )}
                  </div>
                </div>
                {linkAt && !htmlMode && <LinkPopover className="is-under-bar" selected={linkAt.text} onClose={() => setLinkAt(null)}
                  onAdd={(u, txt) => { if (editRef.current) { placeLink(editRef.current, linkAt, u, txt); setBody(mkFromChips(editRef.current.innerHTML)); } setLinkAt(null); }} />}
                <div className="mst-editor">
                  {htmlMode ? (
                    <textarea className="mst-src" value={body} onChange={(e) => setBody(e.target.value)} onFocus={() => { lastFocus.current = "body"; }} spellCheck={false} aria-label="HTML" />
                  ) : (
                    <div key={editorKey} ref={editRef} className="mk-rich mst-rich" contentEditable suppressContentEditableWarning onFocus={() => { lastFocus.current = "body"; }}
                      onInput={(e) => setBody(mkFromChips((e.target as HTMLDivElement).innerHTML))} aria-label="Message" role="textbox" aria-multiline="true" />
                  )}
                </div>
                <div className="mst-unsub">
                  <i className={footOk ? "is-ok" : "is-no"}>{footOk ? MkIco.check : "!"}</i>
                  <span className="mst-unsub-t"><b>Unsubscribe line</b><em>{footOk ? textOf(footer) : "Keep a way to unsubscribe: the {{unsubscribe_url}} link or “reply BAJA”."}</em></span>
                  <div className="mst-pa">
                    <button className={`mst-tb ${pop === "foot" ? "is-on" : ""}`} onClick={() => tg("foot")}>{MhIco.edit}<span>Edit</span></button>
                    {pop === "foot" && (
                      <MkPop className="mst-pop mst-pop-foot is-right is-up" onClose={() => setPop(null)}>
                        <em className="mst-pop-k">At the bottom of every e-mail — required by law</em>
                        <textarea autoFocus value={footer} onChange={(e) => setFooter(e.target.value)} rows={4} />
                        <div className="mst-ai-acts"><button className="mst-pop-alt" onClick={() => setFooter(FOOTER_DEFAULT)}>Default text</button><button className="mst-pop-go" onClick={() => setPop(null)}>{MkIco.check}Done</button></div>
                      </MkPop>
                    )}
                  </div>
                </div>
              </div>
              <div className="mst-foot">
                {!isTpl && <button className="mst-prev" onClick={() => setStep(0)}>{MkIco.back}Audience</button>}
                {msg && <span className={`mst-msg-t is-${msg.tone}`}>{msg.text}</span>}
                <span className="mk-grow" />
                <span className="mst-meta">{fmtN(words)} words</span>
                {isTpl
                  ? <button className="mst-next" disabled={!!busy || tplMiss} onClick={() => void saveTplMode()}>{MhIco.save}{busy === "save" ? "Saving…" : "Save template"}</button>
                  : <button className="mst-next" onClick={() => setStep(2)}>Review{MkIco.arrow}</button>}
              </div>
            </>
          )}

          {step === 2 && (
            <div className="mst-review">
              <div className="mst-card mst-checks-card">
                <div className="mst-h">
                  <i className="mst-h-ico">{MkIco.shield}</i>
                  <div><b>Before it goes out</b><em>{problem ? "Something to fix first" : "Everything's ready"}</em></div>
                </div>
                <ul className="mst-checks">
                  {checks.map((k) => (
                    <li key={k.t} className={k.ok ? "is-ok" : k.soft ? "is-soft" : "is-no"}>
                      <i>{k.ok ? MkIco.check : "!"}</i><span>{k.t}</span>
                      {!k.ok && k.step !== 2 && <button onClick={() => setStep(k.step)}>Fix</button>}
                    </li>
                  ))}
                </ul>
                <div className="mst-trk">
                  <span className="mst-trk-t"><b>Tracking</b>
                    {x.tracking === false ? <em className="is-warn">Off until the manage-users function is deployed with the marketing links.</em>
                      : !x.agg.tracked ? <em className="is-warn">Run 64_marketing_hub.sql to record opens and clicks.</em>
                      : <em>Per person. Replies and bounces come from the synced mailbox.</em>}
                  </span>
                  <button className={`mst-toggle ${trackOpens ? "is-on" : ""}`} onClick={() => setTrackOpens((v) => !v)} aria-pressed={trackOpens}><i />{MhIco.eye}Opens</button>
                  <button className={`mst-toggle ${trackClicks ? "is-on" : ""}`} onClick={() => setTrackClicks((v) => !v)} aria-pressed={trackClicks}><i />{MhIco.click}Link clicks</button>
                </div>
              </div>
              <div className="mst-card mst-send">
                <div className="mst-send-figs">
                  <span><b>{fmtN(ok.length)}</b><em>recipients</em></span>
                  <span><b>~{minutes} min</b><em>at {PROVIDER.perMinute} a minute</em></span>
                </div>
                <div className="mst-send-facts">
                  <div className="mst-send-from"><i>{MkIco.people}</i><span><em>To</em><b title={list?.name}>{list?.name ?? "No list yet"}</b></span></div>
                  <div className="mst-send-from"><i>{MkIco.user}</i><span><em>From</em><b title={fromAddr}>{fromAddr || "—"}</b></span></div>
                  <div className="mst-send-from is-wide"><i>{MkIco.mail}</i><span><em>Subject</em><b><ChipText text={subject} empty="No subject yet" /></b></span></div>
                </div>
                <button className={`mst-test ${tested ? "is-done" : ""}`} disabled={!!busy || !subject.trim()} onClick={() => void testSend()}>
                  {tested ? MkIco.check : MkIco.mail}{busy === "test" ? "Sending test…" : tested ? "Test sent — send another" : "Send me a test"}
                </button>
                <div className="mst-sched">
                  <em>Or schedule it</em>
                  <div className="mst-sched-row">
                    <DatePicker value={when.d} onChange={(d) => setWhen((v) => ({ ...v, d }))} placeholder="Date" />
                    <div className="mst-time"><TimePicker value={when.t} onChange={(t) => setWhen((v) => ({ ...v, t }))} step={15} ariaLabel="Time" /></div>
                    <button className="mst-sched-go" disabled={!!busy || !!problem || x.missing || !when.d} onClick={() => void schedule()}>{busy === "schedule" ? "…" : <>{MhIco.cal}Schedule</>}</button>
                  </div>
                </div>
                {msg && <span className={`mst-msg-t is-${msg.tone}`}>{msg.text}</span>}
                <span className="mk-grow" />
                {confirmSend ? (
                  <div className="mst-really">
                    <b>Send to {fmtN(ok.length)} people now?</b>
                    <em>About {minutes} min — keep Marketing open in a tab while it sends. You can pause any time.</em>
                    <div><button className="mst-pop-alt" autoFocus onClick={() => setConfirmSend(false)}>Not yet</button><button className="mst-go is-sm" onClick={() => void sendNow()}>{MkIco.send}Send now</button></div>
                  </div>
                ) : (
                  <button className="mst-go" disabled={!!busy || !!problem || x.missing} onClick={() => setConfirmSend(true)}>{busy === "send" ? "Starting…" : <>{MkIco.send}Send to {fmtN(ok.length)} people</>}</button>
                )}
              </div>
            </div>
          )}
        </div>

        <aside className="mst-side">
          <MailPreview doc={previewDoc} subject={prev.subject} preheader={preheader ? mergeText(preheader, sample?.merge ?? demo, false) : ""} from={fromAddr || "You"} to={pvTo} nav={pvNav} />
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
/** A name you can change in place: the title, a pencil, Enter to keep it, Esc to leave it. */
function MkRename({ name, onSave, tag = "h2" }: { name: string; onSave: (name: string) => Promise<boolean>; tag?: "h2" | "b" }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const nm = (edit ?? "").trim();
    if (!nm || nm === name) { setEdit(null); return; }
    setBusy(true);
    const ok = await onSave(nm);
    setBusy(false);
    if (ok) setEdit(null);
  };
  if (edit != null) return (
    <span className={`mk-rename is-on is-${tag}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <input autoFocus value={edit} disabled={busy} onChange={(e) => setEdit(e.target.value)} onFocus={(e) => e.currentTarget.select()} aria-label="Name"
        onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEdit(null); }} onBlur={() => void save()} maxLength={160} />
    </span>
  );
  const T = tag;
  return (
    <span className={`mk-rename is-${tag}`}>
      <T>{name}</T>
      <button type="button" className="mk-rename-pen" onClick={(e) => { e.stopPropagation(); setEdit(name); }} title="Rename" aria-label="Rename">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
      </button>
    </span>
  );
}

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
    <section className="mkh-rep er">
      <header className="er-hero">
        <button className="er-back" onClick={onBack} aria-label="Back to campaigns" title="Back to campaigns">{MkIco.back}</button>
        <span className="er-ico">{MkIco.mail}</span>
        <div className="er-id">
          <span className="er-eyebrow">
            <span className={`er-st is-${c.status}`}>{STATUS_LABEL[c.status]}</span>
            <span>E-mail campaign</span>
          </span>
          <MkRename name={c.name} onSave={async (nm) => { const r = await saveCampaignRow({ name: nm }, c.id); if (r.error) { x.toast(r.error); return false; } await x.reload(); x.toast("Renamed"); return true; }} />
          <p className="er-subj"><ChipText text={c.subject} empty="No subject" /></p>
        </div>
        <div className="er-facts">
          <span className="er-fact" title="Audience"><i>{l?.entity === "companies" ? MkIco.building : MkIco.people}</i><span><small>Audience</small><b>{l?.name ?? "No list"}</b></span></span>
          <span className="er-fact" title="From"><i>{MkIco.user}</i><span><small>From</small><b>{c.from_mailbox || "Default mailbox"}</b></span></span>
          <span className="er-fact" title={c.finished_at ? `Sent ${fmtWhen(c.started_at)} → ${fmtWhen(c.finished_at)}` : `Started ${fmtWhen(c.started_at)}`}><i>{MkIco.clock}</i><span><small>{c.finished_at ? "Sent" : "Started"}</small><b>{fmtWhen(c.started_at)}</b></span></span>
        </div>
        <div className="er-acts">
          {c.status === "sending" && <button className="er-btn is-ico" onClick={() => void runner.pause(c)} title="Pause">{MkIco.pause}<span>Pause</span></button>}
          {c.status === "paused" && <button className="er-btn is-lime" onClick={() => void runner.resume(c)}>{MkIco.play}<span>Resume</span></button>}
          {n.failed > 0 && c.status !== "sending" && <button className="er-btn is-ico" onClick={() => void retry()} title={`Retry ${fmtN(n.failed)} failed`}>{MhIco.upload}<span>Retry {fmtN(n.failed)} failed</span></button>}
          {(c.status === "sending" || c.status === "paused") && <MkConfirm className="er-btn is-ico" label={<>{MkIco.stop}<span>Cancel</span></>} ask="Stop for good?" yes="Cancel campaign" onYes={() => void cancel()} />}
          {c.status === "sent" && x.agg.tracked && n.sent - n.opened > 0 && <button className="er-btn is-ico is-lime" disabled={!!busy} onClick={() => void duplicate(true)} title="A fixed list of who didn't open, and a copy of this e-mail to send them">{MhIco.reply}<span>{busy === "follow" ? "…" : `Follow up ${fmtN(n.sent - n.opened)} who didn't open`}</span></button>}
          <button className="er-btn is-ico" disabled={!!busy} onClick={() => void duplicate(false)} title="Duplicate">{MkIco.copy}<span>Duplicate</span></button>
        </div>
        {(c.status === "sending" || c.status === "paused") && (
          <div className="er-prog"><i style={{ width: `${prog * 100}%` }} /><span>{fmtN(n.sent + n.failed)} of {fmtN(n.total)} sent{n.waiting ? ` · ${fmtN(n.waiting)} waiting` : ""}</span></div>
        )}
      </header>
      <div className="er-kpis">
        {stats.map((s, i) => {
          const pctv = s.k === "all" ? (n.total ? delivered / n.total : 0) : delivered ? s.v / delivered : 0;
          return (
            <button key={s.label} className={`er-kpi is-${s.tone} ${filter === s.k && s.k !== "all" ? "is-on" : ""}`} style={{ ["--i" as string]: i } as CSSProperties}
              onClick={() => setFilter(filter === s.k ? "all" : s.k)} title={s.k === "all" ? "Show everyone" : `Show who ${s.label.toLowerCase()}`}>
              <span className="er-kpi-h"><span>{s.label}</span><i>{s.ico}</i></span>
              <b>{s.rate && s.k !== "all" ? s.rate : fmtN(s.v)}</b>
              <em>{s.k === "all" ? (s.rate ? `${s.rate} of ${fmtN(n.total)}` : "") : s.rate ? `${fmtN(s.v)} people` : "people"}{s.hint ? ` · ${s.hint}` : ""}</em>
              <span className="er-kpi-bar"><i style={{ width: `${Math.min(100, pctv * 100)}%` }} /></span>
            </button>
          );
        })}
      </div>
      {!x.agg.tracked && <p className="mkh-fine is-box">Opens, clicks, replies and bounces show here after running 64_marketing_hub.sql — e-mails sent before that aren't tracked.</p>}
      <div className="mkh-rep-grid">
        <div className="mkh-panel mkh-rep-chart">
          <div className="er-h"><span className="er-h-ico">{MhIco.eye}</span><span className="er-h-t"><b>When people opened it</b><em>{opens.length ? `${fmtN(opens.length)} opens · the first day by 3 hours, then by day` : "No opens recorded yet"}</em></span></div>
          <div className="mkh-bars" role="img" aria-label="Opens over time">
            {buckets.map((v, i) => <span key={i} className="mkh-bar-col" title={`${bLabel(i)}: ${v}`}><i style={{ height: `${(v / bMax) * 100}%` }} /><em>{i % 2 === 0 ? bLabel(i) : ""}</em></span>)}
          </div>
        </div>
        <div className="mkh-panel mkh-rep-links">
          <div className="er-h"><span className="er-h-ico">{MhIco.link}</span><span className="er-h-t"><b>Links clicked</b><em>{links.length ? "People who clicked each link" : "Clicks show here"}</em></span></div>
          {links.length ? links.map((k, i) => (
            <a key={k.u} className="mkh-link er-link" href={k.u} target="_blank" rel="noreferrer" style={{ ["--w" as string]: `${(k.n / links[0].n) * 100}%` } as CSSProperties}><i>{i + 1}</i><span>{k.u.replace(/^https?:\/\/(www\.)?/, "")}</span><b>{fmtN(k.n)}</b></a>
          )) : <p className="mkh-fine">{c.track_clicks === false ? "Link tracking was off for this campaign." : "Nobody has clicked a link yet."}</p>}
        </div>
      </div>
      <div className="mkh-panel mkh-rcp">
        <div className="mkh-rcp-tools">
          <div className="er-h"><span className="er-h-ico">{MkIco.people}</span><span className="er-h-t"><b>Recipients</b><em>{fmtN(shown.length)} shown</em></span></div>
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
                {s.status === "failed" && <span className="mkh-tag is-fail" title={s.error ?? ""}>{mailErrText(s.error)}</span>}
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
/** Marketing › Social: a two-week board of what goes out (or cards for drafts / published), the tools in the page bar. */
function SocialTab({ x }: { x: HubCtx }) {
  type SView = "upcoming" | "drafts" | "published" | "all";
  const [view, setView] = useState<SView>("upcoming");
  const [net, setNet] = useState<Net | "all">("all");
  const [q, setQ] = useState("");
  const [acct, setAcct] = useState(false);
  /** the board's first day: Monday of this week, moved by whole weeks */
  const [wk, setWk] = useState(0);
  const nq = norm(q);
  const inView = (p: MkPost, v: SView = view) => v === "all" ? p.status !== "cancelled"
    : v === "upcoming" ? p.status === "scheduled"
    : v === "drafts" ? p.status === "draft" || p.status === "idea" || p.status === "failed"
    : p.status === "published";
  const match = (p: MkPost) => (net === "all" || p.networks.includes(net)) && (!nq || norm(`${p.title} ${p.body} ${p.series ?? ""}`).includes(nq));
  const shown = x.posts.filter((p) => inView(p) && match(p))
    .sort((a, b) => {
      const ta = postWhen(a) ? new Date(postWhen(a)!).getTime() : Infinity, tb = postWhen(b) ? new Date(postWhen(b)!).getTime() : Infinity;
      return view === "published" ? tb - ta : ta - tb;
    });
  const cnt = (v: SView) => x.posts.filter((p) => inView(p, v)).length;
  const due = x.posts.filter(isDue);
  const usedNets = NET_KEYS.filter((n) => x.posts.some((p) => p.networks.includes(n)));
  const ideas = x.posts.filter((p) => !p.scheduled_at && (p.status === "draft" || p.status === "idea"));
  const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0);
  const stats = usedNets.map((n) => {
    const ps = x.posts.filter((p) => p.networks.includes(n));
    const r = ps.map((p) => p.results?.[n]).filter(Boolean) as PostResult[];
    return { n, next: ps.filter((p) => p.status === "scheduled").length, month: ps.filter((p) => p.status === "published" && p.published_at && new Date(p.published_at) >= m0).length,
      imp: r.reduce((s0, v) => s0 + (v.impressions ?? 0), 0), react: r.reduce((s0, v) => s0 + (v.likes ?? 0) + (v.comments ?? 0) + (v.shares ?? 0), 0) };
  });
  const li = x.conn.linkedin[0] ?? null;

  const tools = (
    <div className="em-tools msc-tools">
      <div className="msc-sel"><Select size="sm" value={view} onChange={(v) => v && setView(v as SView)} aria-label="Show"
        options={[{ value: "upcoming", label: `Scheduled · ${cnt("upcoming")}` }, { value: "drafts", label: `Drafts & ideas · ${cnt("drafts")}` }, { value: "published", label: `Published · ${cnt("published")}` }, { value: "all", label: `All · ${cnt("all")}` }]} /></div>
      {usedNets.length > 1 && (
        <div className="msc-sel is-net"><Select size="sm" value={net} onChange={(v) => setNet((v || "all") as Net | "all")} aria-label="Network"
          options={[{ value: "all", label: "All networks" }, ...usedNets.map((n) => ({ value: n, label: NETS[n].label }))]} /></div>
      )}
      <label className={`em-search ${q ? "has-q" : ""}`}>{MkIco.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a post" />{q && <button type="button" onClick={() => setQ("")} aria-label="Clear">{MhIco.x}</button>}</label>
      <button type="button" className="msc-ico" onClick={x.openImport} title="Import posts from a spreadsheet" aria-label="Import posts">{MhIco.upload}</button>
      <button type="button" className="msc-ai" onClick={() => x.openAi()} title="Plan a series of posts with AI">{MhIco.spark}<span>Plan with AI</span></button>
      <button type="button" className="em-new" onClick={() => x.newPostAt()} title="New post">{MkIco.plus}<span>New post</span></button>
    </div>
  );
  const portal = x.bar ? createPortal(tools, x.bar) : null;

  if (x.hubMissing && !x.posts.length) {
    return <div className="mkx-page">{portal}<div className="mkx-scroll"><div className="mk-empty"><div className="mk-empty-art" aria-hidden="true"><span className="is-a">{MhIco.social}</span><span className="is-b">{MhIco.cal}</span><span className="is-c">{MhIco.spark}</span></div><h3>Social posts need one SQL file</h3><p>Run <code>64_marketing_hub.sql</code> in Supabase to plan, schedule and track posts for LinkedIn, Instagram, X and the rest.</p></div></div></div>;
  }

  /* the board: two weeks, Monday first */
  const start = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + wk * 7); return d; })();
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const today = dayKey(new Date());
  const boardPosts = x.posts.filter((p) => p.status !== "cancelled" && match(p) && postWhen(p));
  const byDay = new Map<string, MkPost[]>();
  boardPosts.forEach((p) => { const k = dayKey(new Date(postWhen(p)!)); const a = byDay.get(k) ?? []; a.push(p); byDay.set(k, a); });
  byDay.forEach((a) => a.sort((m, n) => new Date(postWhen(m)!).getTime() - new Date(postWhen(n)!).getTime()));
  const range = `${days[0].toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${days[13].toLocaleDateString("en-GB", { day: "numeric", month: "short", year: days[0].getFullYear() !== days[13].getFullYear() ? "numeric" : undefined })}`;
  const inRange = boardPosts.filter((p) => { const t = new Date(postWhen(p)!).getTime(); return t >= days[0].getTime() && t < days[13].getTime() + 864e5; }).length;
  const auto = (p: MkPost) => !!p.auto_accounts?.linkedin && p.networks.includes("linkedin");
  const chip = (p: MkPost) => {
    const liDone = !!p.results?.linkedin?.url && p.status !== "published";
    return (
      <button key={p.id} className={`msc-chip is-${p.status} ${isDue(p) ? "is-due" : ""}`} style={{ ["--n" as string]: NETS[p.networks[0] ?? "linkedin"].color } as CSSProperties} onClick={() => x.openPost(p)}
        title={`${hhmm(postWhen(p))} · ${p.networks.map((n) => NETS[n].label).join(", ")} · ${isDue(p) ? "Ready to publish" : POST_STATUS[p.status]}${auto(p) && p.status === "scheduled" ? " · LinkedIn publishes by itself" : ""}`}>
        <span className="msc-chip-t"><b>{hhmm(postWhen(p))}</b><span className="msc-chip-n">{p.networks.slice(0, 3).map((n) => <NetBadge key={n} n={n} size="sm" />)}{p.networks.length > 3 && <em>+{p.networks.length - 3}</em>}</span>
          {auto(p) && p.status === "scheduled" && <i className="msc-auto" aria-label="Publishes by itself">{MhIco.spark}</i>}
          {(isDue(p) || p.status === "failed" || liDone) && <i className={`msc-dot ${p.status === "failed" ? "is-fail" : liDone ? "is-half" : ""}`} />}</span>
        <span className="msc-chip-x">{p.title || p.body.split("\n")[0] || "Untitled post"}</span>
      </button>
    );
  };

  return (
    <div className="mkx-page msc">
      {portal}
      {due.length > 0 && (
        <div className="msc-due">
          <span className="msc-due-ico">{MhIco.bell}</span>
          <b>{due.length === 1 ? "1 post is ready to publish" : `${due.length} posts are ready to publish`}</b>
          <em>{li ? "LinkedIn goes out by itself; for the other networks the text is copied and the network opens." : "The text is copied and the network opens — or connect LinkedIn to publish it by itself."}</em>
          <span className="mk-grow" />
          {due.slice(0, 3).map((p) => <button key={p.id} className="msc-due-b" onClick={() => x.publish(p)}>{p.networks.slice(0, 2).map((n) => <NetBadge key={n} n={n} size="sm" />)}<span>{(p.title || p.body).slice(0, 26)}</span></button>)}
        </div>
      )}
      <div className="msc-split">
        <section className="msc-main">
          {view === "upcoming" ? (
            <div className="msc-board">
              <div className="msc-board-h">
                <button className="msc-nav" onClick={() => setWk((v) => v - 2)} aria-label="Two weeks back">‹</button>
                <button className={`msc-today ${wk === 0 ? "is-on" : ""}`} onClick={() => setWk(0)}>Today</button>
                <button className="msc-nav" onClick={() => setWk((v) => v + 2)} aria-label="Two weeks on">›</button>
                <b>{range}</b><em>{inRange === 1 ? "1 post" : `${inRange} posts`}</em>
                <span className="mk-grow" />
                <span className="msc-legend"><i className="msc-dot" />Ready<i className="msc-dot is-fail" />Failed{li && <><i className="msc-auto">{MhIco.spark}</i>Publishes by itself</>}</span>
              </div>
              <div className="msc-week msc-wd">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d}>{d}</span>)}</div>
              <div className="msc-grid">
                {days.map((d) => {
                  const k = dayKey(d), ps = byDay.get(k) ?? [], past = k < today;
                  return (
                    <div key={k} className={`msc-day ${k === today ? "is-today" : ""} ${past ? "is-past" : ""} ${d.getDate() === 1 ? "is-first" : ""} ${(d.getDay() + 6) % 7 >= 5 ? "is-we" : ""}`}>
                      <div className="msc-day-h"><b>{d.getDate()}</b>{d.getDate() === 1 || d.getTime() === days[0].getTime() ? <em>{d.toLocaleDateString("en-GB", { month: "short" })}</em> : null}
                        {!past && <button className="msc-add" onClick={() => x.newPostAt(k)} aria-label={`New post on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`}>{MkIco.plus}</button>}</div>
                      <div className="msc-day-b">{ps.map(chip)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : !shown.length ? (
            <div className="mk-empty">
              <div className="mk-empty-art" aria-hidden="true"><span className="is-a">{MhIco.social}</span><span className="is-b">{MhIco.spark}</span><span className="is-c">{MhIco.cal}</span></div>
              <h3>{x.posts.length ? "Nothing here" : "Plan your first posts"}</h3>
              <p>{x.posts.length ? "Try another view or network." : "Write one, let AI plan a series from a short brief, or import a spreadsheet of posts with their dates."}</p>
              {!x.posts.length && <div className="mk-empty-acts"><button className="mk-btn is-big" onClick={x.openImport}>{MhIco.upload}Import a CSV</button><button className="mk-btn is-primary is-big" onClick={() => x.openAi()}>{MhIco.spark}Plan with AI</button></div>}
            </div>
          ) : (
            <div className="msc-cards">
              {shown.map((p, i) => {
                const r = Object.values(p.results ?? {});
                const reach = r.reduce((s0, v) => s0 + (v.impressions ?? 0), 0), react = r.reduce((s0, v) => s0 + (v.likes ?? 0) + (v.comments ?? 0) + (v.shares ?? 0), 0);
                return (
                  <article key={p.id} className={`msc-card is-${p.status}`} style={{ ["--n" as string]: NETS[p.networks[0] ?? "linkedin"].color, ["--i" as string]: Math.min(i, 14) } as CSSProperties} onClick={() => x.openPost(p)} role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) x.openPost(p); }}>
                    <div className="msc-card-h">
                      <span className="msc-chip-n">{p.networks.map((n) => <NetBadge key={n} n={n} size="sm" />)}</span>
                      <span className={`mkh-st is-${p.status}`}>{isDue(p) ? "Ready" : POST_STATUS[p.status]}</span>
                      <span className="mk-grow" />
                      <time>{postWhen(p) ? fmtWhen(postWhen(p)) : "No date"}</time>
                    </div>
                    <div className="msc-card-b">
                      <span><b>{p.title || p.body.split("\n")[0].slice(0, 80) || "Untitled post"}</b><em>{p.body.replace(/\s+/g, " ").slice(0, 220)}</em></span>
                      {p.media[0] ? (p.media[0].kind === "video" ? <video className="msc-card-img" src={p.media[0].url} muted /> : <img className="msc-card-img" src={p.media[0].url} alt="" />)
                        : p.link_url && p.link_preview?.image ? <img className="msc-card-img" src={p.link_preview.image} alt="" /> : null}
                    </div>
                    <div className="msc-card-f">
                      {p.series && <small className="mkh-series">{p.series}</small>}
                      {p.source === "ai" && <small className="mks-tag">AI draft</small>}
                      <span className="mk-grow" />
                      {p.status === "published"
                        ? (reach || react ? <span className="msc-figs"><b>{fmtN(reach)}</b> views · <b>{fmtN(react)}</b> reactions</span> : <span className="msc-figs is-none">No results yet</span>)
                        : <button className="msc-pub" onClick={(e) => { e.stopPropagation(); x.publish(p); }}>{MkIco.send}Publish</button>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <aside className="msc-side">
          <section className="msc-side-c">
            <header><b>Channels</b><span className="mk-grow" /><button className="msc-link" onClick={() => setAcct(true)}>Manage</button></header>
            {x.conn.linkedin.map((a) => (
              <div key={a.id} className="msc-acct is-live"><BrandMark k="linkedin" s={32} /><span><b>{a.display_name || "LinkedIn"}</b><em>{a.status === "error" ? "Sign in again in Integrations" : "Publishes by itself"}</em></span><i className={`msc-live ${a.status === "error" ? "is-err" : ""}`} /></div>
            ))}
            {x.accounts.map((a0) => <div key={a0.id} className="msc-acct"><NetBadge n={a0.network} size="md" /><span><b>{a0.name}</b><em>{a0.handle || "Publish by hand"}</em></span></div>)}
            {!x.conn.linkedin.length && <button className="msc-connect" onClick={x.connect}><BrandMark k="linkedin" s={28} /><span><b>Connect LinkedIn</b><em>Posts go out by themselves</em></span>{MkIco.arrow}</button>}
          </section>
          <section className="msc-side-c">
            <header><b>This month</b></header>
            {stats.length ? stats.map((r) => (
              <div key={r.n} className="msc-stat"><NetBadge n={r.n} size="sm" /><b>{NETS[r.n].label}</b><span><em>{r.month}</em> out · <em>{r.next}</em> next</span></div>
            )) : <p className="mkh-fine">No posts yet.</p>}
          </section>
          <section className="msc-side-c is-grow">
            <header><b>Ideas without a date</b><em>{ideas.length}</em></header>
            <div className="msc-ideas">
              {ideas.map((p) => (
                <button key={p.id} className="msc-idea" onClick={() => x.openPost(p)}>
                  <span className="msc-chip-n">{p.networks.slice(0, 2).map((n) => <NetBadge key={n} n={n} size="sm" />)}</span>
                  <b>{p.title || p.body.slice(0, 40) || "Untitled"}</b>
                </button>
              ))}
              {!ideas.length && <p className="mkh-fine">Every draft has a date.</p>}
            </div>
          </section>
        </aside>
      </div>
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
  // a new LinkedIn post publishes by itself when LinkedIn is connected
  // …as the company page when you can post as one
  const [p, setP] = useState<MkPost>(() => {
    if (post.id || !x.conn.linkedin[0] || !post.networks.includes("linkedin")) return post;
    const pg = (x.conn.liPages ?? [])[0];
    return { ...post, auto_accounts: pg ? { linkedin: pg.accountId, linkedin_as: pg.orgId } : { linkedin: x.conn.linkedin[0].id } };
  });
  const [tab, setTab] = useState<Net | "main">("main");
  const [pv, setPv] = useState<Net>(post.networks[0] ?? "linkedin");
  // the right column: the preview or the calendar can take all of it (and the column grows wider)
  const [big, setBigRaw] = useState<"" | "pv" | "cal">("");
  const sideRef = useRef<HTMLDivElement | null>(null);
  const flip = useRef<number[] | null>(null);
  const setBig = (v: "" | "pv" | "cal") => {
    const el = sideRef.current;
    if (el) flip.current = [...el.children].map((c) => c.getBoundingClientRect().height);
    setBigRaw(v);
  };
  useLayoutEffect(() => {
    const el = sideRef.current, old = flip.current;
    flip.current = null;
    if (!el || !old || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    [...el.children].forEach((c, i) => {
      const h = c.getBoundingClientRect().height;
      if (old[i] == null || Math.abs(h - old[i]) <= 1) return;
      const card = c as HTMLElement;
      card.style.overflow = "hidden"; // the content doesn't spill over the other card while it glides
      const run = card.animate([{ height: `${old[i]}px` }, { height: `${h}px` }], { duration: 460, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      run.onfinish = run.oncancel = () => { card.style.overflow = ""; };
    });
  }, [big]);
  const [when, setWhen] = useState<{ d: string; t: string }>(() => (post.scheduled_at ? { d: dayKey(new Date(post.scheduled_at)), t: hhmm(post.scheduled_at) } : { d: "", t: "09:00" }));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [ai, setAi] = useState<{ open: boolean; brief: string; busy: boolean }>({ open: false, brief: post.ai_brief ?? "", busy: false });
  const fileRef = useRef<HTMLInputElement | null>(null);
  const set = (patch: Partial<MkPost>) => setP((v) => ({ ...v, ...patch }));
  const pRef = useRef(p); pRef.current = p;
  // the link's own card (title, picture), as LinkedIn will show it
  const [lp, setLp] = useState<{ state: "idle" | "busy" | "err"; error?: string }>({ state: "idle" });
  useEffect(() => {
    const src = (p.link_url ?? "").trim();
    if (!src || !/^(https?:\/\/)?[\w-]+(\.[\w-]+)+/i.test(src)) { if (p.link_preview) set({ link_preview: null }); setLp({ state: "idle" }); return; }
    if (p.link_preview?.src === src) { setLp({ state: "idle" }); return; }
    setLp({ state: "busy" });
    const h = window.setTimeout(() => {
      void linkPreview(src).then((r) => {
        if ((pRef.current.link_url ?? "").trim() !== src) return;
        if ("error" in r) { setLp({ state: "err", error: r.error }); set({ link_preview: null }); }
        else { setLp({ state: "idle" }); set({ link_preview: r }); }
      });
    }, 650);
    return () => window.clearTimeout(h);
  }, [p.link_url]); // eslint-disable-line react-hooks/exhaustive-deps
  const allText = [p.body, ...Object.values(p.variants ?? {}).map((v) => v?.text ?? "")].join("\n");
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
    // only the tags still in the text
    rest.mentions = (p.mentions ?? []).filter((m) => allText.includes(`@${m.name}`));
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

  const liAcct = x.conn.linkedin.find((a) => a.id === p.auto_accounts?.linkedin) ?? x.conn.linkedin[0] ?? null;
  const autoLi = p.networks.includes("linkedin") && !!p.auto_accounts?.linkedin;
  const setAutoLi = (on: boolean) => set({ auto_accounts: on && liAcct ? { ...(p.auto_accounts ?? {}), linkedin: liAcct.id } : Object.fromEntries(Object.entries(p.auto_accounts ?? {}).filter(([k]) => k !== "linkedin")) });
  const [pop, setPop] = useState<null | "ai">(null);
  const others = x.posts.filter((y) => y.id !== p.id && y.status !== "cancelled" && postWhen(y));
  const liRes = p.results?.linkedin;
  // who the post comes from on LinkedIn: you, or a company page you administer
  const liPages = (x.conn.liPages ?? []);
  const liPage = liPages.find((g) => g.orgId === p.auto_accounts?.linkedin_as) ?? null;
  const setLiAs = (g: LiPage | null) => set({ auto_accounts: {
    ...Object.fromEntries(Object.entries(p.auto_accounts ?? {}).filter(([k]) => k !== "linkedin_as")),
    ...(g ? { linkedin: g.accountId, linkedin_as: g.orgId } : liAcct ? { linkedin: p.auto_accounts?.linkedin ?? liAcct.id } : {}),
  } });
  const [asHelp, setAsHelp] = useState(false);

  return createPortal(
    <div className="mkh-drawer-bg pe-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pe" role="dialog" aria-modal="true" aria-label="Post">
        <header className="pe-head">
          <button className="mst-back" onClick={onClose} aria-label="Close" title="Close">{MhIco.x}</button>
          <span className="mst-kind">{MhIco.social}</span>
          <div className="mst-title">
            <em>{!p.id ? "New post" : isDue(p) ? "Ready to publish" : POST_STATUS[p.status]}{p.scheduled_at && p.status !== "published" ? ` · ${fmtWhen(when.d ? atISO(when.d, when.t) : p.scheduled_at)}` : ""}</em>
            <input value={p.title ?? ""} onChange={(e) => set({ title: e.target.value })} placeholder="Name this post (only your team sees it)" aria-label="Post name" />
          </div>
          <div className="pe-nets" role="group" aria-label="Where">
            {NET_KEYS.map((n) => (
              <button key={n} className={`pe-net ${p.networks.includes(n) ? "is-on" : ""}`} style={{ ["--n" as string]: NETS[n].color } as CSSProperties} onClick={() => toggleNet(n)} aria-pressed={p.networks.includes(n)} title={NETS[n].label}>
                <NetBadge n={n} size="sm" off={!p.networks.includes(n)} /><span>{NETS[n].label}</span>
              </button>
            ))}
          </div>
        </header>

        <div className={`pe-grid ${big ? `is-big is-big-${big}` : ""}`}>
          <div className="pe-main">
            <div className="mst-card pe-text">
              <div className="pe-tabs">
                <button className={tab === "main" ? "is-on" : ""} onClick={() => setTab("main")}>Text for all</button>
                {p.networks.map((n) => <button key={n} className={tab === n ? "is-on" : ""} onClick={() => { setTab(n); setPv(n); }}><NetBadge n={n} size="sm" />{NETS[n].label}{p.variants?.[n]?.text?.trim() ? <i className="mkh-dot" title="Own text" /> : null}</button>)}
                <span className="mk-grow" />
                <div className="mst-pa">
                  <button className={`mst-ai-btn ${pop === "ai" ? "is-on" : ""}`} onClick={() => setPop((v) => (v === "ai" ? null : "ai"))}>{MhIco.spark}<span>Write with AI</span></button>
                  {pop === "ai" && (
                    <MkPop className="mst-pop mst-pop-ai is-right" onClose={() => { if (!ai.busy) setPop(null); }}>
                      <div className="mst-ai-h"><i>{MhIco.spark}</i><span><b>Write with AI</b><em>One post, adapted to each network you picked</em></span></div>
                      <textarea autoFocus rows={3} value={ai.brief} onChange={(e) => setAi((a) => ({ ...a, brief: e.target.value }))} placeholder="What's the post about? Leave it empty to improve the text you wrote." />
                      <div className="mst-ai-acts"><button className="mst-pop-go" disabled={ai.busy} onClick={() => void runAi().then(() => setPop(null))}>{ai.busy ? <><i className="mkh-spin" />Writing…</> : <>{MhIco.spark}{p.body.trim() && !ai.brief.trim() ? "Improve it" : "Write it"}</>}</button></div>
                    </MkPop>
                  )}
                </div>
              </div>
              <MentionArea value={curText} onChange={setText} mentions={p.mentions ?? []} onMentions={(m) => set({ mentions: m })} allText={allText}
                enabled={p.networks.includes("linkedin") && (tab === "main" || tab === "linkedin")}
                placeholder={tab === "main" ? `Write the post. Line breaks and emojis are kept.${p.networks.includes("linkedin") ? " Type @ to tag a company or a colleague on LinkedIn." : ""}` : `Own text for ${NETS[tab].label} — leave empty to use the text for all.`} />
              <div className="pe-text-f">
                {over.length > 0 ? <span className="pe-warn">Too long for {over.map((n) => NETS[n].label).join(", ")} — give it its own shorter text.</span>
                  : tab !== "main" && p.variants?.[tab]?.text ? <button className="msc-link" onClick={() => setText("")}>Use the text for all</button> : null}
                <span className="mk-grow" />
                <em className={(tab === "main" ? p.body : postText(p, tab)).length > strict ? "is-over" : ""}>{(tab === "main" ? p.body : postText(p, tab as Net)).length.toLocaleString("es-ES")} / {strict.toLocaleString("es-ES")}</em>
              </div>
            </div>
            <div className="mst-card pe-media">
              <div className="pe-thumbs">
                {p.media.map((m, i) => (
                  <span key={m.url + i} className="mkh-thumb">{m.kind === "video" ? <video src={m.url} muted /> : <img src={m.url} alt={m.alt ?? ""} />}<button onClick={() => set({ media: p.media.filter((_, j) => j !== i) })} aria-label="Remove">{MhIco.x}</button></span>
                ))}
                <button className="pe-up" onClick={() => fileRef.current?.click()} disabled={busy === "upload"} title="Upload a picture or a video">{busy === "upload" ? <i className="mkh-spin" /> : MhIco.image}</button>
                <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={(e) => void addFile(e.target.files?.[0])} />
              </div>
              <div className="pe-links">
                <label className="pe-in">{MhIco.image}<input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="…or paste a picture link"
                  onKeyDown={(e) => { if (e.key === "Enter" && /^https?:\/\//.test(mediaUrl)) { set({ media: [...p.media, { url: mediaUrl, kind: "image" }] }); setMediaUrl(""); } }} />
                  {/^https?:\/\//.test(mediaUrl) && <button onClick={() => { set({ media: [...p.media, { url: mediaUrl, kind: "image" }] }); setMediaUrl(""); }}>Add</button>}</label>
                <label className={`pe-in ${lp.state === "err" ? "is-err" : ""}`} title={lp.state === "err" ? lp.error : p.link_preview?.title ?? undefined}>{MhIco.link}<input value={p.link_url ?? ""} onChange={(e) => set({ link_url: e.target.value || null })} placeholder="Link to share (optional)" />
                  {lp.state === "busy" ? <i className="mkh-spin pe-in-st" /> : p.link_preview ? <span className="pe-in-ok" title={p.link_preview.title ?? "Preview ready"}>{p.link_preview.image ? <img src={p.link_preview.image} alt="" /> : MhIco.link}</span> : lp.state === "err" ? <em className="pe-in-err">No preview</em> : null}</label>
              </div>
              {needsImg && <span className="pe-warn">Instagram, TikTok and YouTube need a picture or a video.</span>}
            </div>
            {p.status === "published" && (
              <div className="mst-card pe-results">
                <b className="pe-k">Results</b>
                {p.networks.map((n) => (
                  <div key={n} className="mkh-res-row">
                    <NetBadge n={n} />
                    <input className="mk-input is-url" value={p.results?.[n]?.url ?? ""} onChange={(e) => res(n, "url", e.target.value)} placeholder="Post link" />
                    {(["impressions", "likes", "comments", "shares", "clicks"] as const).map((k) => (
                      <label key={k}><em>{k}</em><NumInput type="number" min={0} value={p.results?.[n]?.[k] ?? ""} onChange={(e) => res(n, k, e.target.value)} /></label>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pe-side" ref={sideRef}>
            <div className={`mst-card pe-when ${big === "pv" ? "is-folded" : ""}`}>
              {big === "pv" ? (
                <button type="button" className="pe-fold" onClick={() => setBig("")} title="Show the calendar again">
                  <b className="pe-k">When</b>
                  <span className="pe-fold-t">{when.d ? `${new Date(`${when.d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · ${when.t}` : "No date yet"}</span>
                  <span className="mk-grow" />
                  <i className="pe-grow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg></i>
                </button>
              ) : <>
              <div className="pe-when-h"><b className="pe-k">When</b><span className="mk-grow" />{when.d && <button className="msc-link" onClick={() => { setWhen({ d: "", t: "09:00" }); set({ scheduled_at: null }); }}>No date</button>}
                <button type="button" className={`pe-grow ${big === "cal" ? "is-on" : ""}`} onClick={() => setBig(big === "cal" ? "" : "cal")} title={big === "cal" ? "Back to normal" : "Bigger calendar"} aria-label={big === "cal" ? "Back to normal" : "Bigger calendar"}>{big === "cal" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>}</button>
              </div>
              <PostCal value={when.d} onPick={(d) => setWhen((v) => ({ ...v, d }))} posts={others} big={big === "cal"} />
              <div className="pe-when-row">
                <div className="pe-time"><TimePicker value={when.t} onChange={(t) => setWhen((v) => ({ ...v, t }))} step={15} ariaLabel="Time" /></div>
                <input className="mst-in pe-series" value={p.series ?? ""} onChange={(e) => set({ series: e.target.value || null })} placeholder="Series, e.g. Q4 launch" />
              </div>
              {p.networks.includes("linkedin") && (
                liAcct ? (
                  <button className={`pe-auto ${autoLi ? "is-on" : ""}`} onClick={() => setAutoLi(!autoLi)} aria-pressed={autoLi}>
                    <BrandMark k="linkedin" s={30} />
                    <span><b>{autoLi ? "Publishes by itself on LinkedIn" : "Publish on LinkedIn by hand"}</b><em>{liRes?.auto_at ? `Published ${fmtWhen(liRes.auto_at)}` : liRes?.auto_error ? `Didn't go out: ${liRes.auto_error}` : `As ${liPage ? liPage.name : liAcct.display_name || liAcct.email}`}</em></span>
                    <i className="pe-sw" />
                  </button>
                ) : (
                  <button className="pe-auto is-connect" onClick={x.connect}><BrandMark k="linkedin" s={30} /><span><b>Connect LinkedIn</b><em>…and the post goes out by itself</em></span>{MkIco.arrow}</button>
                )
              )}
              {p.networks.includes("linkedin") && liAcct && (
                <div className="pe-as">
                  <span className="pe-as-k">Post as</span>
                  <div className="pe-as-opts" role="radiogroup" aria-label="Post as">
                    <button type="button" role="radio" aria-checked={!liPage} className={`pe-as-o ${!liPage ? "is-on" : ""}`} onClick={() => setLiAs(null)} title={liAcct.display_name || liAcct.email}>
                      <span className="pe-as-av is-me">{initials(liAcct.display_name || liAcct.email || "Y")}</span><span className="pe-as-t"><b>{liAcct.display_name || liAcct.email}</b><em>You</em></span>
                    </button>
                    {liPages.map((g) => (
                      <button key={`${g.accountId}:${g.orgId}`} type="button" role="radio" aria-checked={liPage === g} className={`pe-as-o ${liPage === g ? "is-on" : ""}`} onClick={() => setLiAs(g)} title={g.name}>
                        <span className="pe-as-av is-org">{g.picture ? <img src={g.picture} alt="" /> : MkIco.building}</span><span className="pe-as-t"><b>{g.name}</b><em>Company page</em></span>
                      </button>
                    ))}
                    {!liPages.length && (
                      <button type="button" className={`pe-as-o is-add ${asHelp ? "is-open" : ""}`} onClick={() => setAsHelp((v) => !v)} aria-expanded={asHelp}>
                        <span className="pe-as-av is-org">{MkIco.building}</span><span className="pe-as-t"><b>Company page</b><em>Not set up yet</em></span>
                      </button>
                    )}
                  </div>
                  {!liPages.length && asHelp && (
                    <p className="pe-as-help">
                      LinkedIn only lets apps post as a company page once it approves them for its <b>Community Management API</b>. When it does, connect the company pages in Settings › Integrations › LinkedIn and they show up here.
                      <button type="button" className="msc-link" onClick={x.connect}>Open Integrations {MkIco.arrow}</button>
                    </p>
                  )}
                </div>
              )}
              </>}
            </div>
            <div className={`mst-card pe-pv ${big === "cal" ? "is-folded" : ""}`}>
              <div className="pe-pv-tabs">{p.networks.map((n) => <button key={n} className={pv === n ? "is-on" : ""} onClick={() => { setPv(n); if (big === "cal") setBig(""); }} title={NETS[n].label}><NetBadge n={n} size="sm" off={pv !== n} /></button>)}<span className="mk-grow" /><em>Preview</em>
                <button type="button" className={`pe-grow ${big === "pv" ? "is-on" : ""}`} onClick={() => setBig(big === "pv" ? "" : "pv")} title={big === "pv" ? "Back to normal" : big === "cal" ? "Show the preview again" : "Bigger preview"} aria-label={big === "pv" ? "Back to normal" : "Bigger preview"}>{big ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>}</button>
              </div>
              {big !== "cal" && <div className="pe-pv-b">{p.networks.length ? <SocialPreview n={pv} text={pvText} media={p.media} link={p.link_url} card={p.link_preview ?? null} mentions={p.mentions} name={pv === "linkedin" && liPage ? liPage.name : pv === "linkedin" && liAcct ? (liAcct.display_name || liAcct.email) : acct(pv)?.name ?? x.me.company ?? "Your page"} /> : <p className="mkh-fine">Choose a network to see the preview.</p>}</div>}
            </div>
          </div>
        </div>

        <footer className="pe-foot">
          {p.id && <MkConfirm label={<>{MhIco.trash}Delete</>} className="pe-del" ask="Delete this post?" yes="Delete" onYes={() => void del()} />}
          {err && <span className="mst-msg-t is-err">{err}</span>}
          <span className="mk-grow" />
          {(p.status === "idea" || p.status === "draft" || !p.id) && (
            <div className="pe-stat" title="Saved as"><Select size="sm" value={p.status === "idea" ? "idea" : "draft"} onChange={(v) => set({ status: v as PostStatus })}
              options={[{ value: "idea", label: "Save as idea" }, { value: "draft", label: "Save as draft" }]} /></div>
          )}
          <button className="mst-prev" disabled={!!busy} onClick={() => void save(p.status === "scheduled" ? (when.d ? "scheduled" : "draft") : p.status).then((id) => { if (id) onClose(); })}>{MhIco.save}{busy && busy !== "scheduled" && busy !== "upload" ? "Saving…" : "Save"}</button>
          {p.status !== "published" && <button className="mst-prev" disabled={!!busy} onClick={() => void save().then((id) => { if (id) { onClose(); x.publish({ ...p, id }); } })}>{MkIco.send}Publish now</button>}
          {p.status !== "published" && <button className="mst-next" disabled={!!busy || !when.d} onClick={() => void save("scheduled").then((id) => { if (id) onClose(); })} title={when.d ? "" : "Pick a day first"}>{MhIco.cal}{autoLi ? "Schedule · goes out by itself" : "Schedule"}</button>}
          {p.status === "published" && <button className="mst-next" disabled={!!busy} onClick={() => void save("published").then((id) => { if (id) onClose(); })}>{MkIco.check}Save results</button>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** A month to pick the post's day: each day shows the posts already planned (dots) and lists them on hover. */
function PostCal({ value, onPick, posts, big = false }: { value: string; onPick: (d: string) => void; posts: MkPost[]; big?: boolean }) {
  const [m, setM] = useState(() => { const d = value ? new Date(`${value}T00:00:00`) : new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const start = new Date(m); start.setDate(1 - ((m.getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const by = new Map<string, MkPost[]>();
  posts.forEach((p) => { const k = dayKey(new Date(postWhen(p)!)); const a = by.get(k) ?? []; a.push(p); by.set(k, a); });
  by.forEach((a) => a.sort((x0, y0) => new Date(postWhen(x0)!).getTime() - new Date(postWhen(y0)!).getTime()));
  const today = dayKey(new Date());
  const rows = cells[35].getMonth() !== m.getMonth() ? 5 : 6;
  return (
    <div className={`pc ${big ? "is-big" : ""}`}>
      <div className="pc-h">
        <button onClick={() => setM(new Date(m.getFullYear(), m.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
        <b>{m.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</b>
        <button onClick={() => setM(new Date(m.getFullYear(), m.getMonth() + 1, 1))} aria-label="Next month">›</button>
      </div>
      <div className="pc-wd">{["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="pc-g">
        {cells.slice(0, rows * 7).map((d, i) => {
          const k = dayKey(d), ps = by.get(k) ?? [], out = d.getMonth() !== m.getMonth();
          return (
            <button key={k} className={`pc-d ${out ? "is-out" : ""} ${k === value ? "is-on" : ""} ${k === today ? "is-today" : ""} ${k < today ? "is-past" : ""} ${ps.length ? "has-posts" : ""} ${i % 7 >= 5 ? "pc-edge" : ""}`}
              onClick={() => onPick(k)} aria-label={`${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}${ps.length ? ` — ${ps.length} planned` : ""}`}>
              <span>{d.getDate()}</span>
              {ps.length > 0 && !big && <i className="pc-dots">{ps.slice(0, 3).map((p) => <i key={p.id} style={{ background: NETS[p.networks[0] ?? "linkedin"].color }} />)}</i>}
              {ps.length > 0 && big && (
                <span className="pc-evs">
                  {ps.slice(0, 1).map((p) => <span key={p.id} className="pc-ev" style={{ ["--c" as string]: NETS[p.networks[0] ?? "linkedin"].color } as CSSProperties}><em>{hhmm(postWhen(p))}</em><span>{p.title || p.body.slice(0, 40) || "Untitled"}</span></span>)}
                  {ps.length > 1 && <small>+{ps.length - 1} more</small>}
                </span>
              )}
              {ps.length > 0 && (
                <span className="pc-tip" role="tooltip">
                  <b>{ps.length === 1 ? "1 post planned" : `${ps.length} posts planned`}</b>
                  {ps.slice(0, 5).map((p) => (
                    <span key={p.id} className="pc-tip-r"><em>{hhmm(postWhen(p))}</em>{p.networks.map((n) => NETS[n].label).join(", ")}<small>{p.title || p.body.slice(0, 40) || "Untitled"}</small></span>
                  ))}
                  {ps.length > 5 && <small>+{ps.length - 5} more</small>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** How the post looks on each network (a neutral sketch of the feed, not the network's own design). */
function SocialPreview({ n, text, media, link, name, card, mentions }: { n: Net; text: string; media: MkPost["media"]; link: string | null; name: string; card?: LinkPreview | null; mentions?: PostMention[] }) {
  const [more, setMore] = useState(false);
  const cut = n === "linkedin" ? 210 : n === "instagram" ? 125 : n === "facebook" ? 480 : 99999;
  const shown = more || text.length <= cut ? text : `${text.slice(0, cut).trimEnd()}…`;
  const img = media[0];
  const body = (
    <p className="mkh-spv-text">{n === "linkedin" ? <PostRich text={shown} mentions={mentions} /> : shown}{!more && text.length > cut && <button onClick={() => setMore(true)}>{n === "instagram" ? "more" : "…see more"}</button>}</p>
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
          {!img && link && (card?.image || card?.title ? (
            <div className={`mkh-spv-card ${card.image ? "" : "is-noimg"}`}>
              {card.image && <img src={card.image} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />}
              <span><b>{card.title || link.replace(/^https?:\/\//, "")}</b><em>{card.site || link.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</em></span>
            </div>
          ) : <div className="mkh-spv-link"><span>{link.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</span><b>{link.replace(/^https?:\/\//, "")}</b></div>)}
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
  /** LinkedIn connected (Settings › Integrations): it publishes from here, no copying */
  const liLive = x.conn.linkedin.length > 0;
  const [li, setLi] = useState<{ busy: boolean; err: string | null; url: string | null }>(() => ({ busy: false, err: null, url: p.results?.linkedin?.auto_at ? p.results.linkedin.url ?? null : null }));
  const liNow = async () => {
    setLi({ busy: true, err: null, url: null });
    const r = await publishPostNow(p.id);
    if (!r.ok) { setLi({ busy: false, err: r.error ?? "Couldn't publish.", url: null }); return; }
    setLi({ busy: false, err: null, url: r.url ?? null });
    setDone((d) => ({ ...d, linkedin: true })); setUrls((u) => ({ ...u, linkedin: r.url ?? u.linkedin ?? "" }));
    await x.reload();
    if (p.networks.every((n) => n === "linkedin")) { x.toast("Published on LinkedIn"); onClose(); }
  };
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
    <MhModal title="Publish" sub={liLive && p.networks.every((n) => n === "linkedin") ? <>LinkedIn publishes it straight away from here.</> : <>{liLive && p.networks.includes("linkedin") ? "LinkedIn goes out from here. " : ""}For the other networks the text is copied and the network opens with it — paste, add the picture if any and post. Then mark it as published.</>} onClose={onClose}
      foot={<><span className="mk-grow" /><button className="mk-btn" onClick={onClose}>Later</button><button className="mk-btn is-primary" disabled={busy} onClick={() => void finish()}>{MkIco.check}Mark as published</button></>}>
      <div className="mkh-pub">
        {p.networks.map((n) => n === "linkedin" && liLive ? (
          <div key={n} className={`mkh-pub-row is-live ${li.url ? "is-done" : ""}`}>
            <NetBadge n={n} size="lg" />
            <span className="mkh-pub-t"><b>LinkedIn</b><em>{li.url ? "Published" : li.err ? li.err : `Goes out now on ${x.conn.linkedin[0].display_name || "your profile"}`}</em></span>
            {li.url
              ? <a className="mk-btn is-sm" href={li.url} target="_blank" rel="noreferrer">{MhIco.ext}See the post</a>
              : <button className="mk-btn is-sm is-primary" disabled={li.busy} onClick={() => void liNow()}>{li.busy ? <><i className="mkh-spin" />Publishing…</> : <>{MkIco.send}Publish on LinkedIn</>}</button>}
          </div>
        ) : (
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
/** "New ▾" in the page's bar: a social post, a LinkedIn post or an e-mail campaign. */
function MkNewMenu({ x, at }: { x: HubCtx; at?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  const when = at ? atISO(at, "09:00") : null;
  const items: [React.ReactNode, string, string, () => void][] = [
    [<i className="mkn-ico is-post">{MhIco.social}</i>, "Social post", "Choose the networks: Instagram, X, Facebook…", () => x.openPost({ ...blankPost(when), networks: [] })],
    [<i className="mkn-ico is-li"><NetBadge n="linkedin" size="sm" /></i>, "LinkedIn post", x.conn.linkedin[0] ? "Goes out by itself on LinkedIn" : "Only on LinkedIn", () => x.openPost({ ...blankPost(when), networks: ["linkedin"] })],
    [<i className="mkn-ico is-mail">{MkIco.mail}</i>, "E-mail campaign", "Write it, pick a list, track who opens", () => x.openCampaign("new")],
    // BASE: in the Calendar's marketing view the side column may be folded away — AI planning stays one click away
    ...(x.calNav ? [[<i className="mkn-ico is-ai">{MhIco.spark}</i>, "Plan posts with AI", "A series of posts from one idea", () => x.openAi()] as [React.ReactNode, string, string, () => void]] : []),
  ];
  return (
    <div className="mkn" ref={ref}>
      <button type="button" className={`em-new mkn-btn ${open ? "is-open" : ""}`} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="New post or e-mail">
        {MkIco.plus}<span>New</span>
        <svg className="mkn-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="mkn-menu" role="menu">
          {items.map(([ico, label, hint, go]) => (
            <button key={label} type="button" role="menuitem" className="mkn-item" onClick={() => { setOpen(false); go(); }}>
              {ico}<span><b>{label}</b><em>{hint}</em></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One planned post or e-mail as a card (the week and a day's pop-up). */
function MkcCard({ it, time, st, wide = false, ...rest }: {
  it: { key: string; label: string; kind: "email" | "post"; nets: Net[]; status: string; img?: string; sub?: string };
  time: string; st: string; wide?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`mkc-card is-${it.kind} is-${it.status} ${it.img ? "has-img" : ""} ${wide ? "is-wide" : ""}`} title={it.label} {...rest}>
      {it.img && <span className="mkc-card-img"><img src={it.img} alt="" loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }} /></span>}
      <span className="mkc-card-top">
        <span className="mkc-card-ico">{it.kind === "email" ? <i className="mkc-card-mail">{MkIco.mail}</i> : <NetBadge n={it.nets[0] ?? "linkedin"} size="sm" />}</span>
        <em className="mkc-card-time">{time}</em>
        {it.nets.length > 1 && <span className="mkc-card-nets">{it.nets.slice(1).map((nn) => <NetBadge key={nn} n={nn} size="sm" />)}</span>}
        {wide && <small className={`mkc-st is-${it.status}`}><i />{st}</small>}
      </span>
      <b className="mkc-card-title">{it.label}</b>
      {it.sub && <span className="mkc-card-sub">{it.sub}</span>}
      {!wide && <small className={`mkc-st is-${it.status}`}><i />{st}</small>}
    </button>
  );
}

function CalendarTab({ x }: { x: HubCtx }) {
  const nav = x.calNav ?? null;
  const [viewOwn, setViewRaw] = useState<"month" | "week">(() => { try { return localStorage.getItem("mk-cal-view") === "week" ? "week" : "month"; } catch { return "month"; } });
  const setView = (v: "month" | "week") => { setViewRaw(v); try { localStorage.setItem("mk-cal-view", v); } catch { /* */ } };
  const [anchorOwn, setAnchor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); });
  // BASE: in the Calendar page its own controls lead (same switch, arrows and picker as the work calendar)
  const view = nav ? nav.view : viewOwn;
  const anchor = nav ? nav.anchor : anchorOwn;
  const [show, setShow] = useState<{ email: boolean; nets: Set<Net> }>({ email: true, nets: new Set(NET_KEYS) });
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const monday = (d: Date) => { const m = new Date(d.getFullYear(), d.getMonth(), d.getDate()); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m; };
  const now = new Date();
  const month = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = view === "week" ? monday(anchor) : monday(month);
  const n = view === "week" ? 7 : 42;
  const all = Array.from({ length: n }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const cells = view === "month" && all[35].getMonth() !== month.getMonth() ? all.slice(0, 35) : all;
  const rows = cells.length / 7;
  const todayK = dayKey(now);
  const isCurrent = view === "week" ? dayKey(monday(now)) === dayKey(start) : now.getFullYear() === month.getFullYear() && now.getMonth() === month.getMonth();
  const step = (dir: number) => setAnchor(view === "week" ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + dir * 7) : new Date(month.getFullYear(), month.getMonth() + dir, 1));
  const end = cells[cells.length - 1];
  const title = view === "month" ? month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })
    : start.getMonth() === end.getMonth() ? `${start.getDate()} – ${end.getDate()} ${end.toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`
    : `${start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
  type It = { key: string; t: number; label: string; kind: "email" | "post"; color: string; nets: Net[]; status: string; open: () => void; post?: MkPost; img?: string; sub?: string };
  const byDay = useMemo(() => {
    const m = new Map<string, It[]>();
    const push = (d: Date, it: It) => { const k = dayKey(d); const a = m.get(k) ?? []; a.push(it); m.set(k, a); };
    if (show.email) x.campaigns.forEach((c) => {
      const at = c.status === "scheduled" ? c.scheduled_at : c.started_at;
      const list = x.lists.find((l) => l.id === c.list_id);
      if (at) push(new Date(at), { key: c.id, t: new Date(at).getTime(), label: c.name, kind: "email", color: "#12b57f", nets: [], status: c.status, open: () => x.openCampaign(c.id), sub: list ? `To ${list.name}` : "E-mail" });
    });
    x.posts.forEach((p) => {
      const at = postWhen(p); if (!at || p.status === "cancelled" || !p.networks.some((n) => show.nets.has(n))) return;
      const img = p.media.find((md) => md.kind === "image")?.url ?? p.link_preview?.image ?? undefined;
      push(new Date(at), { key: p.id, t: new Date(at).getTime(), label: p.title || p.body.slice(0, 60) || "Post", kind: "post", color: NETS[p.networks[0] ?? "linkedin"].color, nets: p.networks, status: isDue(p) ? "due" : p.status, open: () => x.openPost(p), post: p, img, sub: p.title && p.body ? p.body.replace(/\s+/g, " ").slice(0, 90) : p.networks.map((nn) => NETS[nn].label).join(", ") });
    });
    m.forEach((a) => a.sort((p, q) => p.t - q.t));
    return m;
  }, [x.campaigns, x.posts, x.lists, show]); // eslint-disable-line react-hooks/exhaustive-deps
  // a day of the month opens into a pop-up with everything on it (it grows out of the cell)
  const [dayPop, setDayPop] = useState<{ k: string; from: DOMRect } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const calRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setDayPop(null); }, [view, anchor]);
  useEffect(() => {
    if (!dayPop) return;
    const down = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setDayPop(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setDayPop(null); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [dayPop]);
  const [popPos, setPopPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = popRef.current, cal = calRef.current;
    if (!dayPop || !el || !cal) { setPopPos(null); return; }
    const box = cal.getBoundingClientRect(), f = dayPop.from;
    const width = Math.min(360, box.width - 24);
    const h = el.offsetHeight;
    let left = f.left - box.left + f.width / 2 - width / 2;
    left = Math.max(12, Math.min(left, box.width - width - 12));
    let top = f.top - box.top - 8;
    top = Math.max(12, Math.min(top, box.height - h - 12));
    setPopPos({ left, top, width });
    // grow out of the cell: start at the cell's box, end at the pop-up's
    const sx = f.width / width, sy = Math.min(1, f.height / Math.max(h, 1));
    const dx = f.left - box.left - left, dy = f.top - box.top - top;
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.4, borderRadius: "0px" }, { transform: "none", opacity: 1, borderRadius: "24px" }], { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    }
  }, [dayPop]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = async (postId: string, k: string) => {
    const p = x.posts.find((y) => y.id === postId); if (!p) return;
    const t = p.scheduled_at ? hhmm(p.scheduled_at) : "09:00";
    const r = await savePostRow({ scheduled_at: atISO(k, t), status: p.status === "published" ? "published" : p.status === "idea" || p.status === "draft" ? p.status : "scheduled" }, p.id);
    if (r.error) x.toast(r.error); else { await x.reload(); x.toast(`Moved to ${new Date(`${k}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`); }
  };
  const used = NET_KEYS.filter((n) => x.posts.some((p) => p.networks.includes(n)));
  const unplanned = x.posts.filter((p) => !p.scheduled_at && (p.status === "draft" || p.status === "idea"));
  const inPeriod = view === "week" ? cells : cells.filter((d) => d.getMonth() === month.getMonth());
  const periodItems = inPeriod.reduce((s0, d) => s0 + (byDay.get(dayKey(d))?.length ?? 0), 0);
  // what's coming: the next planned posts and e-mails from now on
  const next = useMemo(() => {
    const t0 = Date.now(); const out: It[] = [];
    [...byDay.values()].forEach((a) => a.forEach((it) => { if (it.t >= t0 - 3600e3 && it.status !== "published" && it.status !== "sent") out.push(it); }));
    return out.sort((p, q) => p.t - q.t).slice(0, 8);
  }, [byDay]);
  const evTime = (t: number) => new Date(t).toTimeString().slice(0, 5);
  const STL: Record<string, string> = { due: "Ready now", scheduled: "Scheduled", draft: "Draft", idea: "Idea", published: "Published", failed: "Failed", sent: "Sent", sending: "Sending", paused: "Paused" };

  const tools = nav ? (
    <div className="em-tools mkc-tools is-led"><MkNewMenu x={x} /></div>
  ) : (
    <div className="em-tools mkc-tools">
      <div className="mkc-date">
        <button type="button" onClick={() => step(-1)} aria-label={view === "week" ? "Previous week" : "Previous month"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg></button>
        <b>{title}</b>
        <button type="button" onClick={() => step(1)} aria-label={view === "week" ? "Next week" : "Next month"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg></button>
      </div>
      {!isCurrent && <button type="button" className="mkc-today" onClick={() => setAnchor(new Date(now.getFullYear(), now.getMonth(), now.getDate()))}>Today</button>}
      <MkSeg size="sm" value={view} onChange={setView} options={[{ value: "month", label: "Month" }, { value: "week", label: "Week" }]} />
      <MkNewMenu x={x} />
    </div>
  );

  const dropProps = (k: string) => ({
    onDragOver: (e: React.DragEvent) => { if (drag) { e.preventDefault(); setOver(k); } },
    onDragLeave: () => setOver((o) => (o === k ? null : o)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); const id = drag; setDrag(null); setOver(null); if (id) void move(id, k); },
  });
  const evProps = (it: It) => ({
    onClick: it.open, draggable: it.kind === "post",
    onDragStart: (e: React.DragEvent) => { setDrag(it.key); e.dataTransfer.effectAllowed = "move"; },
    onDragEnd: () => { setDrag(null); setOver(null); },
    style: { ["--n" as string]: it.color } as CSSProperties,
  });

  return (
    <div className="mkx-page mkc-page">
      {x.bar ? createPortal(tools, x.bar) : null}
      <div className="mkx-split is-cal">
        <div className={`mkc is-${view}`} ref={calRef}>
          {dayPop && (() => {
            const d = new Date(`${dayPop.k}T00:00:00`);
            const its = byDay.get(dayPop.k) ?? [];
            const past = dayPop.k < todayK;
            return (
              <div className="mkc-pop" ref={popRef} role="dialog" aria-label={d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
                style={popPos ? { left: popPos.left, top: popPos.top, width: popPos.width } : { left: 0, top: 0, width: 360, visibility: "hidden" }}>
                <header className="mkc-pop-h">
                  <span className={`mkc-pop-day ${dayPop.k === todayK ? "is-today" : ""}`}><b>{d.getDate()}</b><em>{d.toLocaleDateString("en-GB", { month: "short" })}</em></span>
                  <span className="mkc-pop-t"><b>{d.toLocaleDateString("en-GB", { weekday: "long" })}</b><em>{its.length ? `${its.length} planned` : "Nothing planned"}</em></span>
                  <button type="button" className="mkc-pop-x" onClick={() => setDayPop(null)} aria-label="Close">{MhIco.x}</button>
                </header>
                <div className="mkc-pop-list">
                  {its.map((it) => <MkcCard key={it.key} it={it} time={evTime(it.t)} st={STL[it.status] ?? it.status} wide {...evProps(it)} />)}
                  {!its.length && <p className="mkc-pop-empty">{past ? "Nothing went out this day." : "A free day — plan something."}</p>}
                </div>
                {!past && (
                  <footer className="mkc-pop-f">
                    <button type="button" className="mkc-pop-add" onClick={() => { setDayPop(null); x.newPostAt(dayPop.k); }}>{MkIco.plus}Add a post</button>
                    <button type="button" className="mkc-pop-week" onClick={() => { if (nav) { nav.onWeek(d); return; } setView("week"); setAnchor(d); }}>See the week</button>
                  </footer>
                )}
              </div>
            );
          })()}
          <div className="mkc-top">
            <span className="mkc-count"><b>{periodItems}</b> {view === "week" ? "planned this week" : "planned this month"}</span>
            <span className="mk-grow" />
            <div className="mkc-filters" role="group" aria-label="Show">
              <button className={show.email ? "is-on" : ""} onClick={() => setShow((s0) => ({ ...s0, email: !s0.email }))} aria-pressed={show.email}><i className="mkh-chip-mail">{MkIco.mail}</i>E-mail</button>
              {used.map((nn) => <button key={nn} className={show.nets.has(nn) ? "is-on" : ""} aria-pressed={show.nets.has(nn)} onClick={() => setShow((s0) => { const ns = new Set(s0.nets); if (ns.has(nn)) ns.delete(nn); else ns.add(nn); return { ...s0, nets: ns }; })}><NetBadge n={nn} size="sm" off={!show.nets.has(nn)} />{NETS[nn].label}</button>)}
            </div>
          </div>
          <div className="mkc-dow" key={`d-${view}-${dayKey(start)}`}>{cells.slice(0, 7).map((d, i) => {
            const k = dayKey(d);
            return view === "week"
              ? <span key={i} className={`${i > 4 ? "is-we" : ""} ${k === todayK ? "is-today" : ""}`}><em>{d.toLocaleDateString("en-GB", { weekday: "short" })}</em><b>{d.getDate()}</b></span>
              : <span key={i} className={i > 4 ? "is-we" : ""}>{d.toLocaleDateString("en-GB", { weekday: "short" })}</span>;
          })}</div>
          <div key={`g-${view}-${dayKey(start)}`} className={`mkc-grid mkc-in is-${view} ${(nav?.dir ?? 1) === 1 ? "is-next" : "is-prev"}`} style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
            {cells.map((d) => {
              const k = dayKey(d);
              const its = byDay.get(k) ?? [];
              const inM = view === "week" || d.getMonth() === month.getMonth();
              const we = d.getDay() === 0 || d.getDay() === 6;
              const cap = view === "week" ? 99 : rows > 5 ? 2 : 3;
              return (
                <div key={k} className={`mkc-cell ${inM ? "" : "is-out"} ${k === todayK ? "is-today" : ""} ${over === k ? "is-over" : ""} ${k < todayK ? "is-past" : ""} ${we ? "is-we" : ""} ${dayPop?.k === k ? "is-open" : ""}`} {...dropProps(k)}
                  onClick={view === "month" ? (e) => { if ((e.target as HTMLElement).closest("button")) return; setDayPop(dayPop?.k === k ? null : { k, from: (e.currentTarget as HTMLElement).getBoundingClientRect() }); } : undefined}>
                  {view === "month" && <span className="mkc-h"><b>{d.getDate()}</b><button className="mkc-add" onClick={() => x.newPostAt(k)} aria-label="New post this day" title="New post this day">{MkIco.plus}</button></span>}
                  <div className="mkc-items">
                    {its.slice(0, cap).map((it) => view === "week" ? (
                      <MkcCard key={it.key} it={it} time={evTime(it.t)} st={STL[it.status] ?? it.status} {...evProps(it)} />
                    ) : (
                      <button key={it.key} className={`mkc-ev is-${it.kind} is-${it.status}`} {...evProps(it)} title={`${evTime(it.t)} · ${it.label}`}>
                        <i className="mkc-dot" /><em>{evTime(it.t)}</em><span>{it.label}</span>
                        {it.kind === "email" ? <i className="mkh-chip-mail">{MkIco.mail}</i> : it.nets.length > 1 ? <small>+{it.nets.length - 1}</small> : null}
                      </button>
                    ))}
                    {its.length > cap && <button className="mkc-more" onClick={(e) => setDayPop({ k, from: ((e.currentTarget as HTMLElement).closest(".mkc-cell") as HTMLElement).getBoundingClientRect() })} title="See the whole day">+{its.length - cap} more</button>}
                    {view === "week" && <button className="mkc-add-w" onClick={() => x.newPostAt(k)}>{MkIco.plus}<span>Add a post</span></button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <aside className="mkx-side mkc-side">
          <section className="mkx-side-card mkc-next">
            <header><h3>Up next</h3><em>{next.length}</em></header>
            {next.length ? (
              <div className="mkc-next-list">
                {next.map((it) => {
                  const d = new Date(it.t);
                  return (
                    <button key={it.key} className={`mkc-nx is-${it.status}`} onClick={it.open} style={{ ["--n" as string]: it.color } as CSSProperties}>
                      <span className="mkc-nx-d"><b>{d.getDate()}</b><em>{d.toLocaleDateString("en-GB", { month: "short" })}</em></span>
                      <span className="mkc-nx-t"><b>{it.label}</b><em>{d.toLocaleDateString("en-GB", { weekday: "short" })} · {evTime(it.t)} · {it.kind === "email" ? "E-mail" : it.nets.map((nn) => NETS[nn].label).join(", ")}</em></span>
                      {it.status === "due" && <small className="mkc-st is-due">Ready now</small>}
                    </button>
                  );
                })}
              </div>
            ) : <p className="mkh-fine">Nothing planned from now on.</p>}
          </section>
          <section className="mkx-side-card is-fill mkc-ideas">
            <header><h3>Not planned yet</h3><em>{unplanned.length}</em></header>
            <p className="mkh-fine">Drag a draft or an idea onto a day. Posts move the same way; their time stays.</p>
            <div className="mkc-unpl">
              {unplanned.map((p) => (
                <button key={p.id} className="mks-idea is-drag" draggable onDragStart={(e) => { setDrag(p.id); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDrag(null); setOver(null); }} onClick={() => x.openPost(p)}
                  style={{ ["--n" as string]: NETS[p.networks[0] ?? "linkedin"].color } as CSSProperties}>
                  <i className="mkh-grip">{MhIco.grip}</i>
                  <span><b>{p.title || p.body.slice(0, 40) || "Untitled"}</b><em>{p.networks.map((nn) => NETS[nn].label).join(", ")}</em></span>
                  <span className={`mkh-st is-${p.status}`}>{POST_STATUS[p.status]}</span>
                </button>
              ))}
              {!unplanned.length && <button className="mk-btn is-sm mkc-ai" onClick={() => x.openAi()}>{MhIco.spark}Plan posts with AI</button>}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

/* ═══════════════════════════ Audiences ═══════════════════════════ */
function AudiencesTab({ x }: { x: HubCtx }) {
  const [sub, setSub] = useState<"lists" | "unsubs">("lists");
  const [sel, setSel] = useState<string | "new" | null>(x.lists[0]?.id ?? "new");
  const [q, setQ] = useState("");
  const [uq, setUq] = useState("");
  const val = sub === "lists" ? q : uq;
  const setVal = sub === "lists" ? setQ : setUq;
  // the switch, the search and "New list" sit in the page's bar, right of the tabs
  const tools = (
    <div className="em-tools mka-tools">
      <span className="mka-seg" title={sub === "lists" ? "Who you reach: contacts or companies by any field — the list updates itself or stays fixed." : "Addresses that never get campaigns. People who click “unsubscribe” land here by themselves."}>
        <MkSeg size="sm" value={sub} onChange={setSub} options={[{ value: "lists", label: <>{MkIco.list}Lists</>, count: x.lists.length }, { value: "unsubs", label: <>{MkIco.shield}Do not contact</>, count: x.unsubs.length }]} />
      </span>
      <label className={`em-search ${val ? "has-q" : ""}`}>{MkIco.search}<input value={val} onChange={(e) => setVal(e.target.value)} placeholder={sub === "lists" ? "Find a list" : "Find an address or reason"} />{val && <button type="button" onClick={() => setVal("")} aria-label="Clear">{MhIco.x}</button>}</label>
      {sub === "lists" && <button type="button" className="em-new" onClick={() => setSel("new")} title="New list">{MkIco.plus}<span>New list</span></button>}
    </div>
  );
  return (
    <div className="mkx-page mka">
      {x.bar ? createPortal(tools, x.bar) : null}
      <div className={`mka-body ${sub === "lists" ? "is-lists" : "is-unsubs"}`}>
        {sub === "lists"
          ? <ListsTab w={x.w} eng={x.eng} lists={x.lists} members={x.members} optOut={x.optOut} missing={x.missing} onChange={x.reload} sel={sel} setSel={setSel} q={q} />
          : <UnsubsTab unsubs={x.unsubs} w={x.w} missing={x.missing} onChange={x.reload} q={uq} />}
      </div>
    </div>
  );
}

function MkLoading() {
  return <PageLoader label="Reading your companies, contacts and deals" />;
}

/* ═══════════════════════════ Lists ═══════════════════════════ */
/** Counts of the lists already worked out, per engine (a new engine = new data = counted again). */
const LIST_SIZES = new WeakMap<object, Map<string, number>>();

function ListsTab({ w, eng, lists, members, optOut, missing, onChange, sel, setSel, q }: {
  w: MkWorld; eng: MkEngine; lists: MkList[]; members: Map<string, string[]>; optOut: Set<string>; missing: boolean; onChange: () => Promise<void>;
  sel: string | "new" | null; setSel: (v: string | "new" | null) => void; q: string;
}) {
  useEffect(() => { if (sel && sel !== "new" && !lists.some((l) => l.id === sel)) setSel(lists[0]?.id ?? "new"); }, [lists, sel]);
  const cur = lists.find((l) => l.id === sel) ?? null;
  // the side list's counts: from the cache at once, the rest one list at a time after the panel is on screen (the tab opens straight away)
  const [sizes, setSizes] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    let cache = LIST_SIZES.get(eng); if (!cache) { cache = new Map(); LIST_SIZES.set(eng, cache); }
    const c = cache;
    const keyOf = (l: MkList) => `${l.id}|${l.updated_at}|${l.kind === "static" ? members.get(l.id)?.length ?? 0 : ""}`;
    const known = new Map<string, number>(); const todo: MkList[] = [];
    lists.forEach((l) => { const v = c.get(keyOf(l)); if (v != null) known.set(l.id, v); else todo.push(l); });
    setSizes(known);
    let alive = true, i = 0, t = 0;
    // in slices of ~12 ms, so the page keeps answering while 30 000 contacts are checked list after list
    const step = () => {
      if (!alive || i >= todo.length) return;
      const t0 = performance.now(), got: [string, number][] = [];
      while (i < todo.length && (got.length === 0 || performance.now() - t0 < 12)) {
        const l = todo[i++]; const nn = listRecords(eng, w, l, members, l.id).length;
        c.set(keyOf(l), nn); got.push([l.id, nn]);
      }
      setSizes((m) => { const n2 = new Map(m); got.forEach(([id, nn]) => n2.set(id, nn)); return n2; });
      t = window.setTimeout(step, 0);
    };
    t = window.setTimeout(step, 80);
    return () => { alive = false; clearTimeout(t); };
  }, [lists, eng, w, members]);
  const shownLists = lists.filter((l) => !q.trim() || norm(`${l.name} ${l.description ?? ""}`).includes(norm(q)));
  return (
    <div className="mk-lists">
      <aside className="mk-side">
        <div className="mk-side-h">
          <b>Your lists</b><em>{lists.length}</em>
        </div>
        <div className="mk-side-list">
          {sel === "new" && (
            <button className="mk-lcard is-on is-draft" onClick={() => setSel("new")}>
              <span className="mk-lcard-ico is-new">{MkIco.plus}</span>
              <span className="mk-lcard-txt"><b>New list</b><em>Not saved yet</em></span>
            </button>
          )}
          {shownLists.map((l, i) => {
            const size = sizes.get(l.id) ?? (l.member_count != null ? l.member_count : undefined);
            const fresh = sizes.has(l.id);
            return (
              <button key={l.id} className={`mk-lcard ${sel === l.id ? "is-on" : ""}`} onClick={() => setSel(l.id)} style={{ ["--i" as string]: i } as CSSProperties}>
                <span className={`mk-lcard-ico is-${l.entity}`}>{l.entity === "companies" ? MkIco.building : MkIco.people}</span>
                <span className="mk-lcard-txt"><b>{l.name}</b><em><i className={`mk-dot is-${l.kind}`} />{l.kind === "dynamic" ? "Dynamic" : "Fixed"} · {l.entity}</em></span>
                <span className={`mk-lcard-n ${fresh ? "" : "is-wait"}`} title={fresh ? undefined : "Counting…"}>{size == null ? "…" : fmtN(size)}</span>
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
  useEffect(() => { if (msg?.tone !== "ok") return; const t = window.setTimeout(() => setMsg(null), 5000); return () => clearTimeout(t); }, [msg]);
  const isStatic = list?.kind === "static";
  const root: Root = entity === "companies" ? "company" : "contact";
  const fields = eng.fields[root];
  const fieldBy = eng.fieldBy[root];

  // conditions are evaluated in the background: the panel shows at once and stays smooth while you edit
  const evalIn = useMemo(() => ({ entity, def }), [entity, def]);
  const evalD = useDeferredValue(evalIn, null as typeof evalIn | null);
  const pending = !isStatic && !evalD;
  const counting = !isStatic && evalD !== evalIn;
  const evEntity = isStatic ? entity : evalD?.entity ?? entity;
  const records = useMemo(() => (list && isStatic ? listRecords(eng, w, list, members, list.id) : evalD ? eng.evaluate(evalD.entity, evalD.def) : []),
    [eng, w, list, isStatic, members, evalD]);
  const recs = useMemo(() => eng.recipients(evEntity, records, (isStatic ? def : evalD?.def ?? def).who, optOut), [eng, evEntity, records, isStatic, def, evalD, optOut]);
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
    // a dynamic list: the server's own reading of it is checked against this one (any difference is kept),
    // and if it starts a workflow, whoever its new rules bring in starts it now
    if (kind === "dynamic" && id) {
      const listId = id;
      void import("./mkListSync").then((m) => { m.checkListOnServer(listId, records.map((r: any) => String(r.id))); void m.syncDynamicLists({ listId }); }).catch(() => {});
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
          <input className="mk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this list" title={name || "Name this list, e.g. CFOs at client companies"} />
          <input className="mk-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What it's for (optional)" title={desc || undefined} />
          {msg && <span className={`mk-msg is-${msg.tone}`} key={msg.text}>{msg.text}</span>}
        </div>
        <div className="mk-ed-kind">
          {list ? <span className={`mk-chip is-${list.kind}`} title={list.kind === "dynamic" ? "Updates itself as your data changes" : "Keeps the same people, even if their data changes"}>{list.kind === "dynamic" ? "Dynamic" : "Fixed"}</span> : <span className="mk-chip is-new">New</span>}
        </div>
        <div className="mk-ed-actions">
          {list && <span className="mka-del" title="Delete list"><MkConfirm label={<>{MhIco.trash}<span className="mka-sr">Delete list</span></>} className="is-ghost is-danger-text" ask="Delete this list?" yes="Delete" onYes={() => void del()} /></span>}
          <button className="mk-btn is-ghost mka-ico" onClick={exportCsv} disabled={!recs.length} title="Export CSV" aria-label="Export CSV">{MkIco.dl}</button>
          {!isStatic && <button className="mk-btn is-ghost" disabled={busy || missing} onClick={() => void save("static")} title="Keep exactly these people, even if their data changes">Save as fixed</button>}
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
                      {gi === 0 && (
                        <MkSeg size="sm" value={entity} onChange={(v) => { if (v !== entity) { setEntity(v); setDef(emptyDef()); } }}
                          options={[{ value: "contacts", label: <>{MkIco.user}Contacts</> }, { value: "companies", label: <>{MkIco.building}Companies</> }]} />
                      )}
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
          <div className={`mk-card mk-count ${counting ? "is-counting" : ""}`}>
            <div className="mk-count-top">
              <span className="mk-k">Will receive it</span>
              {!isStatic && <span className="mk-live"><i className="mk-pulse" />Live</span>}
            </div>
            <b className="mk-count-n">{pending ? "…" : fmtN(Math.round(nOk))}</b>
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

/** "Deal · Entered phase": which phases, and the day(s) when the operator needs them. */
function PhaseCondVal({ c, f, onPatch }: { c: Cond; f: XF; onPatch: (p: Partial<Cond>) => void }) {
  return (
    <div className="cx-phase">
      <SalesMultiFilter values={c.vals} onChange={(v) => onPatch({ vals: v })} placeholder="Which phases…" searchFrom={8} options={f.options ?? []} />
      {(c.op === "p_since" || c.op === "p_before") && <DatePicker value={c.a} onChange={(d) => onPatch({ a: d })} placeholder={c.op === "p_since" ? "Since…" : "Before…"} />}
      {c.op === "p_between" && <div className="cx-two"><DatePicker value={c.a} onChange={(d) => onPatch({ a: d })} placeholder="From" /><span>–</span><DatePicker value={c.b} onChange={(d) => onPatch({ b: d })} placeholder="To" /></div>}
    </div>
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
          {f.kind === "phase" ? (
            <PhaseCondVal c={c} f={f} onPatch={onPatch} />
          ) : f.kind === "enum" ? (
            <SalesMultiFilter values={c.vals} onChange={(v) => onPatch({ vals: v })} placeholder="Choose…" searchFrom={8} options={f.options ?? []} />
          ) : f.kind === "date" && c.op === "period" ? (
            <SalesMultiFilter single values={[c.a]} onChange={(v) => v[0] && onPatch({ a: v[0] })} placeholder="Period" searchFrom={99}
              options={PERIODS.filter((p) => p.key !== "all" && p.key !== "custom").map((p) => ({ value: p.key, label: `${p.group} · ${p.label}` }))} />
          ) : f.kind === "date" ? (
            <div className="cx-two"><DatePicker value={c.a} onChange={(d) => onPatch({ a: d })} placeholder="From" /><span>–</span><DatePicker value={c.b} onChange={(d) => onPatch({ b: d })} placeholder="To" /></div>
          ) : c.op === "between" ? (
            <div className="cx-two"><NumInput type="number" value={c.a} onChange={(e) => onPatch({ a: e.target.value })} placeholder="From" /><span>–</span><NumInput type="number" value={c.b} onChange={(e) => onPatch({ b: e.target.value })} placeholder="To" /></div>
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
      const res = await sendMailVia(c.sender_account, {
        to: [row.email], subject: mail.subject, html: mail.html,
        from: c.from_mailbox || null, replyTo: c.reply_to || null, ref: `campaign:${c.id}`,
      });
      if (res.ok) {
        sentToday.current = (sentToday.current ?? 0) + 1;
        if (res.pace) waitUntil.current = Date.now() + res.pace * 1000;          // IONOS: 500 e-mails an hour
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
      } else if (isTransientMail(res.error) && !/^Retried/.test(String(row.error ?? ""))) {
        // a Microsoft server error: back in the queue once, a little later
        await supabase.from("marketing_sends").update({ status: "queued", claimed_by: null, claimed_at: null, error: `Retried after: ${String(res.error).slice(0, 300)}` }).eq("id", row.id);
        waitUntil.current = Date.now() + 20_000;
        setBanner({ tone: "warn", text: "Outlook answered with a server error — trying that e-mail again in 20 s." });
        return;
      } else {
        await supabase.from("marketing_sends").update({ status: "failed", error: res.error ?? "Failed" }).eq("id", row.id);
      }
      const done = (c.stats.sent ?? 0) + (c.stats.failed ?? 0) + 1;
      setBanner({ tone: "live", text: `Sending “${c.name}” — ${fmtN(Math.min(done, c.stats.total ?? done))} of ${fmtN(c.stats.total ?? 0)}. Keep this tab open; it sends about ${res.pace ? Math.round(60 / res.pace) : PROVIDER.perMinute} e-mails a minute.` });
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
function UnsubsTab({ unsubs, w, missing, onChange, q }: { unsubs: MkUnsub[]; w: MkWorld; missing: boolean; onChange: () => Promise<void>; q: string }) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [bulk, setBulk] = useState("");
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
        <div className="mk-pg-tools"><b className="mk-pg-tt">Unsubscribed</b><span className="mk-pill">{fmtN(q ? shown.length : unsubs.length)}</span>{q && <em className="mka-of">of {fmtN(unsubs.length)}</em>}</div>
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
