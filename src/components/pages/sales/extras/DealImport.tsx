/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import SalesMultiFilter from "../sales/SalesMultiFilter";
import DealRolePicker from "./DealRolePicker";
import { useBackToClose } from "../../../framework/useBackToClose";
import { readSpreadsheet, colLetter, cellText, normHeader, parseNumber, type Sheet, type Workbook } from "../../../framework/spreadsheetImport";
import { listCompanies, listContacts, listCompanyFields, listContactFields, type Company, type CompanyField, type Contact, type ContactField } from "../../companies/companiesApi";
import type { Pipeline, Phase } from "../../settings/pipelineApi";
import type { Product } from "../../settings/catalogApi";
import { listLossReasons, type LossReason, type Tracking } from "../sales/salesApi";
import { listTrackingFields, type TrackingField } from "./trackingFieldsApi";
import type { SalesRole } from "./salesRolesApi";
import {
  BASE_TARGETS, VALUE_TARGETS, STATUS_LABEL, EMAIL_RE, PHASE_AT, ENTITY_LABEL,
  guessTarget, guessPhaseAt, guessType, canonicalOptions, guessOwnerColumn, distinctValues, choiceFor, matchPerson, buildPlan, mapProblem, peopleWithSeveralRoles,
  runImport, sortedPipelines, phasesOf, defOf, hasValueStep, isPhaseAt, targetLabelOf, emptyState, emptyResult, listClientCompanyIds, EXISTING_LABEL,
  type Column, type Ctx, type Entity, type ExistingMode, type RecordDiff, type ImportState, type Plan, type NewField, type Person, type Rule, type FieldType, type PlanRow, type RunResult, type CompanyName, type ContactName,
} from "./dealImportEngine";
import "./DealImport.css";

const TYPE_LABEL: Record<FieldType, string> = { text: "Text", number: "Number", date: "Date", boolean: "Yes / No", select: "Choice list" };
const uid = () => Math.random().toString(36).slice(2, 9);
const fmtN = (n: number) => n.toLocaleString("de-DE");
const eur = (n: number) => `${Math.round(n).toLocaleString("de-DE")} €`;
const day = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" }) : "");
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

type Step = "file" | "map" | "people" | "review" | "run" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "file", label: "File" }, { key: "map", label: "Columns" }, { key: "people", label: "People" }, { key: "review", label: "Review" }, { key: "done", label: "Import" },
];
export type Tone = "none" | "co" | "ct" | "deal" | "phase" | "field" | "new" | "create";
export interface TOpt { value: string; label: string; group: string; tone: Tone; hint?: string }

/**
 * Actions → Import deals. Deals from another CRM (Teamleader, HubSpot, a
 * spreadsheet…): map the columns to every company, contact and deal field (or
 * to "reached phase X on this date"), match each value to ours, decide who
 * gets each deal, check the companies and contacts it finds or creates, move
 * deals between pipelines one by one, review, import.
 */
export default function DealImport({ pipelines, phaseByPipe, products, people, roles, trackings, meId, onClose, onDone }: {
  pipelines: Pipeline[];
  phaseByPipe: Record<string, Phase[]>;
  products: Product[];
  people: Person[];
  roles: SalesRole[];
  /** Every deal (not only the visible ones), to spot deals that already exist. */
  trackings: Tracking[];
  meId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  useBackToClose("deal-import", onClose);
  const [step, setStep] = useState<Step>("file");
  const [fields, setFields] = useState<TrackingField[]>([]);
  const [companyFields, setCompanyFields] = useState<CompanyField[]>([]);
  const [contactFields, setContactFields] = useState<ContactField[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lossReasons, setLossReasons] = useState<LossReason[]>([]);
  const [clientCompanies, setClientCompanies] = useState<string[]>([]);
  useEffect(() => {
    listTrackingFields().then(setFields).catch(() => {});
    listCompanyFields().then(setCompanyFields).catch(() => {});
    listContactFields().then(setContactFields).catch(() => {});
    listCompanies().then(setCompanies).catch(() => {});
    listContacts().then(setContacts).catch(() => {});
    listLossReasons().then(setLossReasons).catch(() => {});
    listClientCompanyIds().then(setClientCompanies).catch(() => {});
  }, []);

  /* ─────────────── the file ─────────────── */
  const [fileName, setFileName] = useState("");
  const [wb, setWb] = useState<Workbook | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [hasHeader, setHasHeader] = useState(true);
  const [loading, setLoading] = useState(false);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [viewer, setViewer] = useState(false);
  const sheet = wb?.sheets[sheetIdx] ?? null;
  const rows = useMemo(() => (sheet ? (hasHeader ? sheet.rows.slice(1) : sheet.rows) : []).filter((r) => r.some((c) => c != null && c !== "")), [sheet, hasHeader]);
  const columns: Column[] = useMemo(() => {
    if (!sheet) return [];
    const width = Math.max(0, ...sheet.rows.map((r) => r.length));
    return Array.from({ length: width }, (_, i) => {
      const header = hasHeader ? cellText(sheet.rows[0]?.[i] ?? null) : "";
      const values = rows.map((r) => r[i] ?? null);
      const filled = values.filter((v) => v != null && v !== "");
      return { i, letter: colLetter(i), header: header || `Column ${colLetter(i)}`, values, filled: filled.length, samples: filled.slice(0, 3) };
    }).filter((c) => c.filled > 0 || c.header !== `Column ${c.letter}`);
  }, [sheet, hasHeader, rows]);
  const rowOffset = hasHeader ? 2 : 1;

  /* ─────────────── import state ─────────────── */
  const [st, setSt] = useState<ImportState>(() => emptyState());
  const patch = (p: Partial<ImportState>) => setSt((s) => ({ ...s, ...p }));
  const [openValues, setOpenValues] = useState<Record<number, boolean>>({});
  const touched = useRef(false);
  const rulesTouched = useRef(false);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFileErr(null); setLoading(true); touched.current = false; rulesTouched.current = false;
    try {
      const book = await readSpreadsheet(f);
      const best = book.sheets.reduce((bi, s, i) => (s.rows.length > book.sheets[bi].rows.length ? i : bi), 0);
      const first = book.sheets[best].rows;
      const looksHeader = !!first[0] && first[0].every((c) => c == null || (typeof c === "string" && !EMAIL_RE.test(c) && parseNumber(c) == null));
      setWb(book); setSheetIdx(best); setHasHeader(looksHeader); setFileName(f.name);
      setSt((s) => ({ ...s, mapping: {}, newFields: [], valueMaps: {}, rules: [], companyChoice: {}, contactChoice: {}, pipeOverride: {} }));
      if (!first.length) setFileErr("This sheet is empty.");
    } catch (e: any) { setFileErr(e?.message ?? "Couldn't read this file."); setWb(null); }
    setLoading(false);
  };
  const clearFile = () => {
    setWb(null); setFileName(""); setFileErr(null); touched.current = false;
    setSt((s) => ({ ...s, mapping: {}, newFields: [], valueMaps: {}, rules: [], companyChoice: {}, contactChoice: {}, pipeOverride: {} }));
  };

  useEffect(() => { if (!st.defaultPipeline && pipelines.length) patch({ defaultPipeline: pipelines[0].id }); }, [pipelines, st.defaultPipeline]); // eslint-disable-line react-hooks/exhaustive-deps

  // automatic mapping, until the person changes something
  useEffect(() => {
    if (!sheet || touched.current) return;
    const m: Record<number, string> = {};
    const used = new Set<string>();
    const free = (t: string) => !used.has(t) || t === "deal.notes";
    for (const c of columns) {
      const h = normHeader(c.header);
      const own = [
        ...fields.map((f) => ({ f, t: `custom:${f.id}` })), ...companyFields.map((f) => ({ f, t: `cocustom:${f.id}` })), ...contactFields.map((f) => ({ f, t: `ctcustom:${f.id}` })),
      ].find((x) => normHeader(x.f.label) === h && !used.has(x.t));
      const g = own?.t ?? guessTarget(c.header, c.samples) ?? guessPhaseAt({ pipelines, phaseByPipe }, c.header, c.samples, st.defaultPipeline || pipelines[0]?.id);
      if (g && free(g)) { m[c.i] = g; used.add(g); continue; }
      m[c.i] = "";
    }
    if (Object.values(m).includes("contact.first_name")) for (const k of Object.keys(m)) if (m[+k] === "contact.full_name") m[+k] = "";
    const nextRules = rulesTouched.current ? null : (() => { const oc = guessOwnerColumn(columns); return oc != null ? [{ id: uid(), col: oc, as: "owner" as const, map: {}, fallback: "" }] : []; })();
    setSt((s) => ({ ...s, mapping: m, ...(nextRules ? { rules: nextRules } : {}) }));
  }, [sheet, hasHeader, columns, fields, companyFields, contactFields, pipelines, phaseByPipe]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx: Ctx = useMemo(() => ({ pipelines, phaseByPipe, products, lossReasons, fields, companyFields, contactFields, people, roles, companies, contacts, trackings, clientCompanies }),
    [pipelines, phaseByPipe, products, lossReasons, fields, companyFields, contactFields, people, roles, companies, contacts, trackings, clientCompanies]);

  const setTarget = (col: number, v: string) => {
    touched.current = true;
    if (v.startsWith("__create:")) {
      const entity = v.slice(9) as Entity;
      const c = columns.find((x) => x.i === col)!;
      const g = guessType(c.values);
      const existing = (entity === "deal" ? fields : entity === "company" ? companyFields : contactFields) as { label: string }[];
      let label = c.header.trim() || `Field ${c.letter}`;
      if (existing.some((f) => normHeader(f.label) === normHeader(label)) || st.newFields.some((n) => n.entity === entity && normHeader(n.label) === normHeader(label))) label = `${label} (imported)`;
      const nf: NewField = { tmp: uid(), entity, label, type: g.type, options: g.options };
      setSt((s) => ({ ...s, newFields: [...s.newFields.filter((n) => s.mapping[col] !== `new:${n.tmp}`), nf], mapping: { ...s.mapping, [col]: `new:${nf.tmp}` } }));
      if (g.type === "select") setOpenValues((o) => ({ ...o, [col]: true }));
      return;
    }
    setSt((s) => {
      const prev = s.mapping[col];
      // a new field this column created goes away with it
      const newFields = prev?.startsWith("new:") && prev !== v ? s.newFields.filter((n) => `new:${n.tmp}` !== prev) : s.newFields;
      return { ...s, newFields, mapping: { ...s.mapping, [col]: v === "__none" ? "" : v } };
    });
    if (VALUE_TARGETS.has(v) || /^(custom|cocustom|ctcustom):/.test(v)) setOpenValues((o) => ({ ...o, [col]: true }));
  };
  const patchNew = (tmp: string, p: Partial<NewField>) => setSt((s) => ({ ...s, newFields: s.newFields.map((n) => (n.tmp === tmp ? { ...n, ...p } : n)) }));
  const removeNew = (tmp: string) => setSt((s) => ({
    ...s, newFields: s.newFields.filter((n) => n.tmp !== tmp),
    mapping: Object.fromEntries(Object.entries(s.mapping).map(([k, v]) => [k, v === `new:${tmp}` ? "" : v])),
  }));
  /** The side panel picks the column a target comes from (only one column can feed it). */
  const setSourceColumn = (target: string, col: number | null) => {
    touched.current = true;
    setSt((s) => {
      const mapping: Record<number, string> = {};
      for (const [k, v] of Object.entries(s.mapping)) mapping[+k] = v === target ? "" : v;
      if (col != null) mapping[col] = target;
      return { ...s, mapping };
    });
    if (col != null) setOpenValues((o) => ({ ...o, [col]: true }));
  };
  const setValueChoice = (target: string, key: string, choice: string) => setSt((s) => ({ ...s, valueMaps: { ...s.valueMaps, [target]: { ...(s.valueMaps[target] ?? {}), [key]: choice } } }));

  const mapIssue = mapProblem(ctx, st);
  const planNeeded = step === "people" || step === "review" || step === "run";
  const plan = useMemo(() => (planNeeded ? buildPlan(ctx, columns, rows, st) : null), [planNeeded, ctx, columns, rows, st]);

  /* ─────────────── labels ─────────────── */
  const personName = (id: string | null | undefined) => people.find((p) => p.id === id)?.name ?? "—";
  const pipeName = (id: string | null) => pipelines.find((p) => p.id === id)?.name ?? "—";
  const productName = (id: string | null) => products.find((p) => p.id === id)?.name ?? "—";
  const phaseById = useMemo(() => new Map(Object.values(phaseByPipe).flat().map((p) => [p.id, p])), [phaseByPipe]);
  const targetLabel = (t: string) => targetLabelOf(ctx, st, t);

  /** Everything a column can go to, grouped. */
  const targetOptions: TOpt[] = useMemo(() => {
    const out: TOpt[] = [{ value: "__none", label: "Don't import", group: "", tone: "none" }];
    BASE_TARGETS.forEach((b) => out.push({ value: b.key, label: b.label, group: b.group, tone: b.group === "Company" ? "co" : b.group === "Contact" ? "ct" : "deal", hint: b.hint }));
    sortedPipelines(ctx, st.defaultPipeline).forEach((p) => phasesOf(ctx, p.id).forEach((ph) => out.push({
      value: `${PHASE_AT}${ph.id}`, label: `Reached ${ph.name}${ph.sales_outcome ? (ph.sales_outcome === "win" ? " (won)" : " (lost)") : ""}`,
      group: `Phase reached · ${p.name}`, tone: "phase", hint: "Has a value → the deal got here, on that date",
    })));
    fields.forEach((f) => out.push({ value: `custom:${f.id}`, label: f.label, group: "Your deal fields", tone: "field", hint: TYPE_LABEL[f.type] }));
    companyFields.forEach((f) => out.push({ value: `cocustom:${f.id}`, label: f.label, group: "Your company fields", tone: "field", hint: TYPE_LABEL[f.type] }));
    contactFields.forEach((f) => out.push({ value: `ctcustom:${f.id}`, label: f.label, group: "Your contact fields", tone: "field", hint: TYPE_LABEL[f.type] }));
    st.newFields.forEach((n) => out.push({ value: `new:${n.tmp}`, label: n.label || "Untitled", group: "New fields", tone: "new", hint: `${ENTITY_LABEL[n.entity]} · ${TYPE_LABEL[n.type]}` }));
    (["deal", "company", "contact"] as Entity[]).forEach((e) => out.push({ value: `__create:${e}`, label: `New ${ENTITY_LABEL[e].toLowerCase()} field from this column`, group: "Create", tone: "create" }));
    return out;
  }, [ctx, st.defaultPipeline, fields, companyFields, contactFields, st.newFields]);

  /** What each value of a column can become. */
  const valueOptions = (target: string, raw: string): { value: string; label: string }[] => {
    if (target === "deal.pipeline") return [...pipelines.map((p) => ({ value: p.id, label: p.name })), { value: "__default", label: `Default pipeline (${pipeName(st.defaultPipeline)})` }];
    if (target === "deal.phase") return [
      ...sortedPipelines(ctx, st.defaultPipeline).flatMap((p) => phasesOf(ctx, p.id).map((ph) => ({ value: ph.id, label: `${ph.name}${ph.sales_outcome && !/won|lost|ganad|perdid/i.test(ph.name) ? (ph.sales_outcome === "win" ? " (won)" : " (lost)") : ""} · ${p.name}` }))),
      { value: "__first", label: "First phase of the deal's pipeline" },
    ];
    if (target === "deal.status") return Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }));
    if (target === "deal.product") return [...products.map((p) => ({ value: p.id!, label: p.name })), { value: "__default", label: st.defaultProduct ? `Default product (${productName(st.defaultProduct)})` : "Default product (none set)" }, { value: "__none", label: "No product" }];
    if (target === "deal.loss_reason") return [...lossReasons.map((r) => ({ value: r.label, label: r.label })), { value: "__new", label: `+ Add “${raw}” as a lost reason` }, { value: "__details", label: "Keep it as details" }];
    const f = defOf(ctx, st, target);
    return [...(f?.options ?? []).map((o) => ({ value: o, label: o })), { value: "__new", label: `+ Add “${raw}” as a new option` }, { value: "__empty", label: "Leave empty" }];
  };

  /* ─────────────── people rules ─────────────── */
  const peopleOptions = useMemo(() => [{ value: "__nobody", label: "Nobody" }, ...people.map((p) => ({ value: p.id, label: p.id === meId ? `${p.name} (you)` : p.name }))], [people, meId]);
  const patchRule = (id: string, p: Partial<Rule>) => { rulesTouched.current = true; setSt((s) => ({ ...s, rules: s.rules.map((r) => (r.id === id ? { ...r, ...p } : r)) })); };
  const addRule = (as: Rule["as"], col: number | null = null) => { rulesTouched.current = true; setSt((s) => ({ ...s, rules: [...s.rules, { id: uid(), col, as, map: {}, fallback: "" }] })); };
  const removeRule = (id: string) => { rulesTouched.current = true; setSt((s) => ({ ...s, rules: s.rules.filter((r) => r.id !== id) })); };
  const multiRole = plan ? peopleWithSeveralRoles(ctx, plan) : [];

  /* ─────────────── run ─────────────── */
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: "" });
  const [result, setResult] = useState<RunResult | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [ranPlan, setRanPlan] = useState<Plan | null>(null);
  const run = async () => {
    if (!plan) return;
    setRanPlan(plan);
    setStep("run"); setRunErr(null);
    try {
      const r = await runImport(ctx, st, columns, plan, fileName, rowOffset, setProgress);
      setResult(r);
    } catch (e: any) { setRunErr(e?.message ?? "The import stopped unexpectedly."); setResult(emptyResult()); }
    setStep("done");
    onDone();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || step === "run" || document.querySelector(".smf-menu, .di-tp-menu")) return;
      if (viewer) { setViewer(false); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose, step, viewer]);

  /* ─────────────── downloads ─────────────── */
  const download = (name: string, lines: string[][]) => {
    const esc = (s: string) => (/[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const blob = new Blob(["﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const template = () => download("deals-template.csv", [[
    "Company", "Legal name", "Company VAT", "Website", "Street", "Postal code", "City", "Country",
    "Contact name", "Contact email", "Contact phone", "Position",
    "Title", "Pipeline", "Phase", "Status", "Value", "Product", "Expected close date", "Close date", "Probability", "Created on", "Owner", "Lost reason", "Notes",
    ...fields.map((f) => f.label), ...companyFields.map((f) => f.label), ...contactFields.map((f) => f.label),
  ]]);
  const downloadErrors = () => {
    if (!result || !sheet) return;
    download(`${fileName.replace(/\.[^.]+$/, "")}-import-errors.csv`, [["Row", "Problem", ...(hasHeader ? sheet.rows[0].map(cellText) : columns.map((c) => c.header))],
      ...result.failed.map((f) => [f.row ? String(f.row) : "—", f.reason, ...(f.row ? (sheet.rows[f.row - 1] ?? []).map(cellText) : [])])]);
  };

  /* ─────────────── map step filters ─────────────── */
  const [colQ, setColQ] = useState("");
  const [colFilter, setColFilter] = useState<"all" | "mapped" | "unmapped" | "check">("all");
  const [flashCol, setFlashCol] = useState<number | null>(null);
  const jumpToColumn = (i: number) => {
    setViewer(false);
    if (step !== "map") return;
    setColQ(""); setColFilter("all"); setFlashCol(i);
    setTimeout(() => document.getElementById(`di-col-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    setTimeout(() => setFlashCol(null), 1800);
  };

  /* ─────────────── review filters ─────────────── */
  const [tab, setTab] = useState<"all" | "new" | "warn" | "dup" | "error" | "client" | "moved">("all");
  const [rvTab, setRvTab] = useState<"deals" | "companies" | "contacts" | "options">("deals");
  const [coFilter, setCoFilter] = useState<"check" | "new" | "found" | "all">("all");
  const [ctFilter, setCtFilter] = useState<"new" | "found" | "all">("all");
  const [dq, setDq] = useState("");
  const [limit, setLimit] = useState(200);
  const filtered = (plan?.rows ?? []).filter((r) => {
    if (tab === "warn" ? !(r.status === "new" && r.issues.length > 0) : tab === "client" ? !r.becomesClient : tab === "moved" ? !r.pipeOverridden : tab !== "all" && r.status !== tab) return false;
    if (!dq.trim()) return true;
    const n = normHeader(dq);
    return normHeader([r.title, r.companyLabel, r.contactLabel].filter(Boolean).join(" ")).includes(n);
  });
  const shown = filtered.slice(0, limit);
  const contactOptions = useMemo(() => contacts.map((c) => ({ value: `crm:${c.id}`, label: `Link to ${[c.first_name, c.last_name].filter(Boolean).join(" ")}${c.email ? ` · ${c.email}` : ""}` })), [contacts]);
  const companyOptions = useMemo(() => companies.map((c) => ({ value: `crm:${c.id}`, label: `Link to ${c.name}` })), [companies]);
  const pipeOptions = useMemo(() => pipelines.map((p) => ({ value: p.id, label: p.name })), [pipelines]);
  const setOverride = (idxs: number[], pid: string | null) => setSt((s) => {
    const o = { ...s.pipeOverride };
    idxs.forEach((i) => { if (pid) o[i] = pid; else delete o[i]; });
    return { ...s, pipeOverride: o };
  });

  const stepIdx = step === "run" ? 4 : STEPS.findIndex((s) => s.key === step);
  const usedTargets = Object.values(st.mapping).filter(Boolean);

  /* ═══════════════════════════ render ═══════════════════════════ */
  return createPortal(
    <div className="di-backdrop" onMouseDown={() => step !== "run" && onClose()}>
      <div className="di" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Import deals">
        <header className="di-head">
          <div className="di-head-txt">
            <span className="di-eyebrow">Import</span>
            <h2>Deals{fileName && <small>{fileName}</small>}</h2>
          </div>
          <ol className="di-steps" style={{ ["--k" as string]: stepIdx, ["--n" as string]: STEPS.length } as CSSProperties}>
            <span className="di-steps-bar"><i /></span>
            {STEPS.map((s, i) => <li key={s.key} className={i < stepIdx ? "is-done" : i === stepIdx ? "is-on" : ""}><b>{i < stepIdx ? "✓" : i + 1}</b><span>{s.label}</span></li>)}
          </ol>
          <div className="di-head-actions">
            {sheet && step !== "run" && step !== "done" && (
              <button className="di-sheetbtn" onClick={() => setViewer(true)} title="See every row and column of the file">
                <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9.5h18M3 15h18M9 4v16M15 4v16" /></svg>
                <span>Sheet</span>
              </button>
            )}
            <button className="di-x" onClick={onClose} disabled={step === "run"} aria-label="Close">×</button>
          </div>
        </header>

        <div className={`di-body is-${step}`} key={step}>
          {/* ═════ 1. FILE ═════ */}
          {step === "file" && (
            <div className="di-file">
              <div className="di-file-intro">
                <h3>Bring your deals over</h3>
                <p>Export the deals from your old CRM (Teamleader, HubSpot, Pipedrive, a spreadsheet…) as Excel or CSV. Next you'll match its columns to every company, contact and deal field — and to the phases each deal went through, with their dates.</p>
                <ul className="di-file-points">
                  <li><b>Phases, dates & values</b>“SQL 8” there can be “SQL 2” here — and a date column can say when it got there</li>
                  <li><b>Owners</b>from any column, value by value</li>
                  <li><b>Companies & contacts</b>found by VAT, name, website or email — even spelled differently — or created with all their data</li>
                  <li><b>Won with a close date</b>its company becomes a client</li>
                </ul>
              </div>
              <DropZone wb={wb} fileName={fileName} loading={loading} err={fileErr} onPick={pick} onClear={clearFile} onTemplate={template}>
                {wb && sheet && (
                  <>
                    <div className="di-stats">
                      <span><b>{fmtN(rows.length)}</b>deals</span>
                      <span><b>{columns.length}</b>columns</span>
                      <span><b>{usedTargets.length}</b>recognised</span>
                    </div>
                    {wb.sheets.length > 1 && (
                      <div className="di-sheets">
                        <span>Sheet with the deals</span>
                        <div>{wb.sheets.map((sh, i) => <button key={sh.name + i} className={i === sheetIdx ? "is-on" : ""} onClick={() => { touched.current = false; setSheetIdx(i); }}>{sh.name}<em>{Math.max(0, sh.rows.length - 1)}</em></button>)}</div>
                      </div>
                    )}
                    <label className="di-check"><input type="checkbox" checked={hasHeader} onChange={(e) => { touched.current = false; setHasHeader(e.target.checked); }} /><span />First row has the column names</label>
                    <div className="di-peek">
                      <table><thead><tr>{columns.slice(0, 6).map((c) => <th key={c.i}>{c.header}</th>)}</tr></thead>
                        <tbody>{rows.slice(0, 4).map((r, ri) => <tr key={ri}>{columns.slice(0, 6).map((c) => <td key={c.i}>{cellText(r[c.i] ?? null)}</td>)}</tr>)}</tbody></table>
                      <button className="di-peek-open" onClick={() => setViewer(true)}>
                        <svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
                        View the whole sheet · {fmtN(rows.length)} rows × {columns.length} columns
                      </button>
                    </div>
                  </>
                )}
              </DropZone>
            </div>
          )}

          {/* ═════ 2. COLUMNS ═════ */}
          {step === "map" && (
            <div className="di-mapgrid">
              <div className="di-maplist">
                <div className="di-maptools">
                  <label className="di-search">
                    <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
                    <input value={colQ} onChange={(e) => setColQ(e.target.value)} placeholder="Find a column…" />
                  </label>
                  <div className="di-seg is-small">
                    {([["all", "All", columns.length], ["mapped", "Mapped", columns.filter((c) => st.mapping[c.i]).length], ["unmapped", "Not imported", columns.filter((c) => !st.mapping[c.i]).length],
                      ["check", "To check", columns.filter((c) => { const t = st.mapping[c.i]; return t && hasValueStep(ctx, st, t) && distinctValues(c.values).some((d) => !choiceFor(ctx, st, t, d.text).matched); }).length]] as const).map(([k, l, n]) => (
                      <button key={k} className={`${colFilter === k ? "is-on" : ""} ${k === "check" && n ? "is-warn" : ""}`} onClick={() => setColFilter(k)}>{l}<i>{n}</i></button>
                    ))}
                  </div>
                </div>
                {columns.map((c, k) => {
                  const t = st.mapping[c.i] ?? "";
                  const nf = t.startsWith("new:") ? st.newFields.find((n) => `new:${n.tmp}` === t) ?? null : null;
                  const valued = !!t && hasValueStep(ctx, st, t);
                  const dist = valued ? distinctValues(c.values) : [];
                  const decisions = dist.map((d) => ({ ...d, ...choiceFor(ctx, st, t, d.text) }));
                  const open = decisions.filter((d) => !d.matched).length;
                  if (colQ.trim() && !normHeader(`${c.header} ${c.letter} ${t ? targetLabel(t) : ""}`).includes(normHeader(colQ))) return null;
                  if (colFilter === "mapped" && !t) return null;
                  if (colFilter === "unmapped" && t) return null;
                  if (colFilter === "check" && !open) return null;
                  const expanded = valued && (openValues[c.i] ?? open > 0);
                  const tone = targetOptions.find((o) => o.value === t)?.tone ?? "none";
                  const phase = isPhaseAt(t) ? phaseById.get(t.slice(PHASE_AT.length)) : null;
                  const people = st.rules.find((r) => r.col === c.i);
                  return (
                    <div key={c.i} id={`di-col-${c.i}`} className={`di-map is-t-${tone} ${t ? "is-mapped" : ""} ${open ? "has-open" : ""} ${!t && people ? "is-people" : ""} ${flashCol === c.i ? "is-flash" : ""}`} style={{ ["--i" as string]: Math.min(k, 14) } as CSSProperties}>
                      <div className="di-map-row">
                        <span className="di-col"><em>{c.letter}</em><span><b title={c.header}>{c.header}</b><small>{c.filled} of {rows.length} filled</small></span></span>
                        <span className="di-samples">{c.samples.length ? c.samples.map((x, i) => <span key={i} title={cellText(x)}>{cellText(x)}</span>) : <i>empty</i>}</span>
                        <svg className="di-arrow" viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                        <div className="di-target">
                          <TargetPicker value={t || "__none"} options={targetOptions} used={usedTargets} onChange={(v) => setTarget(c.i, v)} />
                          {people && <span className="di-used">Gives the {people.as === "owner" ? "owner" : "people"} · next step</span>}
                        </div>
                      </div>
                      {phase && (
                        <div className="di-hintbar is-phase">
                          <i>⟶</i>
                          <span>Has a value → the deal reached <b>{phase.name}</b> in {pipeName(phase.pipeline_id)}{phase.sales_outcome ? <> — so it's <b>{phase.sales_outcome === "win" ? "won" : "lost"}</b></> : ""}, and the date in the cell is the day it got there. With several of these, the furthest one sets the phase.</span>
                        </div>
                      )}
                      {t === "deal.close_date" && (
                        <div className="di-hintbar is-client">
                          <i>★</i>
                          <span>A date here means it was <b>won</b> that day (unless the status says lost) — and its company <b>becomes a client</b>{st.makeClients ? "" : " (turned off in the review)"}.</span>
                        </div>
                      )}
                      {nf && (
                        <NewFieldEditor nf={nf} column={c} onPatch={(p) => patchNew(nf.tmp, p)} onRemove={() => removeNew(nf.tmp)}
                          onOptionsChanged={() => setOpenValues((o) => ({ ...o, [c.i]: true }))} />
                      )}
                      {valued && dist.length > 0 && (
                        <div className={`di-values ${expanded ? "is-open" : ""}`}>
                          <button className="di-values-h" onClick={() => setOpenValues((o) => ({ ...o, [c.i]: !expanded }))} aria-expanded={expanded}>
                            <b>{nf ? "Each value of the column → one of your options" : <>Match the values to {t === "deal.phase" ? "your phases" : t === "deal.pipeline" ? "your pipelines" : t === "deal.status" ? "a status" : t === "deal.product" ? "your products" : t === "deal.loss_reason" ? "your lost reasons" : `“${targetLabel(t)}”`}</>}</b>
                            <span className={open ? "is-warn" : "is-ok"}>{open ? `${open} to check` : "all matched"} · {dist.length} {dist.length === 1 ? "value" : "values"}</span>
                            <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
                          </button>
                          {expanded && (
                            <div className="di-values-grid">
                              {decisions.slice(0, 120).map((d, j) => (
                                <div key={d.key} className={`di-val ${d.matched ? (d.auto ? "is-auto" : "is-set") : "is-open"}`} style={{ ["--j" as string]: Math.min(j, 20) } as CSSProperties}>
                                  <span className="di-val-from"><b title={d.text}>{d.text}</b><small>{d.count}×</small></span>
                                  <svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                                  <SalesMultiFilter single values={[d.choice]} onChange={(x) => x[0] && setValueChoice(t, d.key, x[0])} placeholder="Choose" searchFrom={9} options={valueOptions(t, d.text)} />
                                  <i className="di-val-tag">{d.matched ? (d.auto ? "auto" : "set") : d.choice === "__new" ? "new" : "check"}</i>
                                </div>
                              ))}
                              {decisions.length > 120 && <p className="di-muted">+{decisions.length - 120} more values — they go to “{valueOptions(t, "").find((o) => o.value === decisions[120].choice)?.label ?? "default"}” unless matched.</p>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <aside className="di-side">
                <SideSource title="Pipeline" target="deal.pipeline" noun="pipeline" columns={columns} mapping={st.mapping} ctx={ctx} st={st}
                  guess={(c) => /pipeline|embudo|funnel|tipo|type|linea|line|unidad|division|segment/i.test(normHeader(c.header))}
                  onColumn={(col) => setSourceColumn("deal.pipeline", col)} onValue={(key, v) => setValueChoice("deal.pipeline", key, v)} valueOptions={(raw) => valueOptions("deal.pipeline", raw)}
                  defaultValue={st.defaultPipeline} defaultOptions={pipeOptions} onDefault={(v) => patch({ defaultPipeline: v })}
                  allLabel="Every deal goes into" restLabel={usedTargets.includes("deal.phase") || usedTargets.some(isPhaseAt) ? "No value (and the phase doesn't say)" : "No value or not matched"} />
                <SideSource title="Product" target="deal.product" noun="product" columns={columns} mapping={st.mapping} ctx={ctx} st={st}
                  guess={(c) => /product|servicio|service|plan|licen/i.test(normHeader(c.header))}
                  onColumn={(col) => setSourceColumn("deal.product", col)} onValue={(key, v) => setValueChoice("deal.product", key, v)} valueOptions={(raw) => valueOptions("deal.product", raw)}
                  defaultValue={st.defaultProduct || "__none"} onDefault={(v) => patch({ defaultProduct: v === "__none" ? "" : v })}
                  defaultOptions={[{ value: "__none", label: "No product" }, ...products.filter((p) => p.active !== false).map((p) => ({ value: p.id!, label: p.name }))]}
                  allLabel="Every deal gets" restLabel="No value or sent to “default”" />
                <h4>What the deals get</h4>
                <CoverageList used={usedTargets} ctx={ctx} st={st} />
                {st.newFields.length > 0 && (
                  <>
                    <h4>Will be created</h4>
                    <ul className="di-checks">{st.newFields.map((n) => <li key={n.tmp} className="is-new"><i>+</i>{n.label || "Untitled"}<em>{ENTITY_LABEL[n.entity]} · {TYPE_LABEL[n.type]}</em></li>)}</ul>
                  </>
                )}
                <p className="di-side-p di-side-note">Owners come next — from any column you like.</p>
              </aside>
            </div>
          )}

          {/* ═════ 3. PEOPLE ═════ */}
          {step === "people" && plan && (
            <div className="di-people">
              <div className="di-people-intro">
                <h3>Who gets each deal?</h3>
                <p>Pick any column — the owner in your old CRM, a region, the deal type… — and say who each value is here. The first <b>owner</b> rule that gives someone wins; <b>on the deal</b> rules add people to the team.</p>
              </div>
              {st.rules.length === 0 && (
                <div className="di-empty">
                  <p>No rules yet — imported deals would have <b>no owner</b>.</p>
                  <div>
                    <button className="di-btn is-primary" onClick={() => addRule("owner", guessOwnerColumn(columns) ?? columns[0]?.i ?? null)}>Owner from a column</button>
                    {meId && <button className="di-btn is-ghost" onClick={() => { rulesTouched.current = true; patch({ rules: [{ id: uid(), col: null, as: "owner", map: {}, fallback: meId }] }); }}>Make me the owner of all</button>}
                  </div>
                </div>
              )}
              <div className="di-rules">
                {st.rules.map((rule, ri) => {
                  const col = columns.find((c) => c.i === rule.col) ?? null;
                  const dist = col ? distinctValues(col.values) : [];
                  const empties = col ? col.values.filter((v) => !cellText(v).trim()).length : rows.length;
                  return (
                    <section key={rule.id} className={`di-rule is-${rule.as}`} style={{ ["--i" as string]: ri } as CSSProperties}>
                      <header>
                        <span className="di-rule-n">{ri + 1}</span>
                        <div className="di-seg" role="radiogroup" aria-label="Assign as">
                          <button role="radio" aria-checked={rule.as === "owner"} className={rule.as === "owner" ? "is-on" : ""} onClick={() => patchRule(rule.id, { as: "owner" })}>Owner</button>
                          <button role="radio" aria-checked={rule.as === "team"} className={rule.as === "team" ? "is-on" : ""} onClick={() => patchRule(rule.id, { as: "team" })}>On the deal</button>
                        </div>
                        <span className="di-rule-from">from</span>
                        <div className="di-rule-col">
                          <SalesMultiFilter single values={[rule.col == null ? "__all" : String(rule.col)]} placeholder="Column" searchFrom={8}
                            onChange={(v) => v[0] && patchRule(rule.id, { col: v[0] === "__all" ? null : Number(v[0]), map: {} })}
                            options={[{ value: "__all", label: "Every deal (no column)" }, ...columns.map((c) => ({ value: String(c.i), label: `${c.letter} · ${c.header}` }))]} />
                        </div>
                        <button className="di-rule-x" onClick={() => removeRule(rule.id)} aria-label="Remove rule">×</button>
                      </header>
                      {col && (
                        <div className="di-pgrid">
                          {dist.slice(0, 60).map((d) => {
                            const set = rule.map[d.key];
                            const auto = set === undefined ? matchPerson(people, d.text) : null;
                            const v = set ?? auto ?? "";
                            return (
                              <div key={d.key} className={`di-pval ${v ? (set !== undefined ? "is-set" : "is-auto") : "is-none"}`}>
                                <span className="di-val-from"><b title={d.text}>{d.text}</b><small>{d.count}×</small></span>
                                <svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                                <SalesMultiFilter single values={[v || "__nobody"]} placeholder="Person" searchFrom={8} options={peopleOptions}
                                  onChange={(x) => x[0] && patchRule(rule.id, { map: { ...rule.map, [d.key]: x[0] === "__nobody" ? "" : x[0] } })} />
                                {v ? <span className="di-av" title={personName(v)}>{initials(personName(v))}</span> : <span className="di-av is-none">–</span>}
                              </div>
                            );
                          })}
                          {dist.length > 60 && <p className="di-muted">+{dist.length - 60} more values use “anything else”.</p>}
                        </div>
                      )}
                      <footer>
                        <span>{col ? `Anything else${empties ? ` (and the ${empties} empty)` : ""}` : "Every deal"} →</span>
                        <SalesMultiFilter single values={[rule.fallback || "__nobody"]} placeholder="Person" searchFrom={8} options={peopleOptions}
                          onChange={(x) => x[0] && patchRule(rule.id, { fallback: x[0] === "__nobody" ? "" : x[0] })} />
                      </footer>
                    </section>
                  );
                })}
              </div>
              {st.rules.length > 0 && (
                <div className="di-rule-add">
                  <button onClick={() => addRule("owner", null)}>+ Owner rule</button>
                  <button onClick={() => addRule("team", null)}>+ Add people to the deal</button>
                </div>
              )}
              {multiRole.length > 0 && (
                <section className="di-roles">
                  <h4>Role on these deals</h4>
                  <p>These people have several sales roles that fit the imported deals. Pick the one they play — it decides how far they see each deal and its handover.</p>
                  {multiRole.map((m) => (
                    <div key={m.id} className="di-role-row">
                      <span className="di-av">{initials(personName(m.id))}</span>
                      <b>{personName(m.id)}</b>
                      <DealRolePicker roles={m.roles} value={st.personRole[m.id] ?? null} personName={personName(m.id)} onChange={(rid) => setSt((s) => ({ ...s, personRole: { ...s.personRole, [m.id]: rid } }))} />
                    </div>
                  ))}
                </section>
              )}
              <div className="di-people-sum">
                <PeopleSummary rows={plan.rows.filter((r) => r.status !== "error")} personName={personName} />
              </div>
            </div>
          )}

          {/* ═════ 4. REVIEW ═════ */}
          {step === "review" && plan && (() => {
            const usedCo = new Set(plan.rows.filter((r) => r.status === "new" && r.companyKey).map((r) => r.companyKey!));
            const usedCt = new Set(plan.rows.filter((r) => r.status === "new" && r.contactKey).map((r) => r.contactKey!));
            const coCheck = plan.companies.filter((c) => usedCo.has(c.key) && (c.foundBy === "similar" || (!!c.suggest && !!c.ref?.startsWith("new:")))).length;
            const c = plan.counts;
            const facts: [string, number, string?][] = [
              ["won", c.won], ["new companies", c.coNew], ["companies in the CRM", c.coFound], ["new contacts", c.ctNew], ["contacts in the CRM", c.ctFound], ["become clients", c.clients, "is-gold"],
              ["skipped · already there", c.dup, "is-muted"], ["with errors", c.error, "is-red"],
            ];
            return (
              <div className="rv">
                <div className="rv-top">
                  <div className="rv-hero"><b>{fmtN(c.new)}</b><span>{c.new === 1 ? "deal" : "deals"} ready to import</span></div>
                  <ul className="rv-facts">
                    {facts.filter(([, n]) => n > 0).map(([l, n, cls]) => <li key={l} className={cls ?? ""}><b>{fmtN(n)}</b>{l}</li>)}
                  </ul>
                </div>

                {(c.coExisting > 0 || c.ctExisting > 0) && (
                  <section className="rv-ask">
                    <div className="rv-ask-h">
                      <span className="rv-ask-ico">?</span>
                      <div>
                        <b>{[c.coExisting ? `${fmtN(c.coExisting)} ${c.coExisting === 1 ? "company" : "companies"}` : null, c.ctExisting ? `${fmtN(c.ctExisting)} ${c.ctExisting === 1 ? "contact" : "contacts"}` : null].filter(Boolean).join(" and ")} {c.coExisting + c.ctExisting === 1 ? "is" : "are"} already in your CRM.</b>
                        <span>What should the file do with their data? Empty cells in the file never erase anything.</span>
                      </div>
                    </div>
                    {c.coExisting > 0 && <ExistingChoice label="Companies" n={c.coExisting} fill={c.coFill} change={c.coChange} value={st.coExisting} onChange={(v) => patch({ coExisting: v })} />}
                    {c.ctExisting > 0 && <ExistingChoice label="Contacts" n={c.ctExisting} fill={c.ctFill} change={c.ctChange} value={st.ctExisting} onChange={(v) => patch({ ctExisting: v })} />}
                  </section>
                )}

                <nav className="rv-tabs" role="tablist">
                  {([
                    ["deals", "Deals", plan.rows.length, c.error ? `${c.error} ${c.error === 1 ? "error" : "errors"}` : c.warn ? `${c.warn} ${c.warn === 1 ? "warning" : "warnings"}` : null],
                    ["companies", "Companies", plan.companies.length, coCheck ? `${coCheck} to check` : null],
                    ["contacts", "Contacts", plan.contacts.length, null],
                    ["options", "Options", null, null],
                  ] as const).map(([k, l, n, flag]) => (
                    <button key={k} role="tab" aria-selected={rvTab === k} className={rvTab === k ? "is-on" : ""} onClick={() => setRvTab(k)}>
                      {l}{n != null && <i>{fmtN(n)}</i>}{flag && <em>{flag}</em>}
                    </button>
                  ))}
                </nav>

                <div className="rv-panel" key={rvTab}>
                  {rvTab === "deals" && (
                    <>
                      <div className="rv-tools">
                        <label className="di-search is-small">
                          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
                          <input value={dq} onChange={(e) => { setDq(e.target.value); setLimit(200); }} placeholder="Find a deal, company or contact…" />
                        </label>
                        <div className="rv-chips">
                          {([["all", "All", plan.rows.length], ["new", "To import", c.new], ["client", "Become clients", plan.rows.filter((r) => r.becomesClient).length], ["moved", "Moved", plan.rows.filter((r) => r.pipeOverridden).length], ["warn", "Warnings", c.warn], ["dup", "Already there", c.dup], ["error", "Errors", c.error]] as const)
                            .filter(([k, , n]) => k === "all" || k === "new" || n > 0).map(([k, l, n]) => (
                              <button key={k} className={`${tab === k ? "is-on" : ""} ${(k === "error" || k === "warn") && n ? "is-warn" : ""}`} onClick={() => { setTab(k); setLimit(200); }}>{l} <i>{fmtN(n)}</i></button>
                            ))}
                        </div>
                        <div className="rv-move">
                          <span>Move these {fmtN(filtered.length)} to</span>
                          <div className="rv-move-pick">
                            <SalesMultiFilter single values={["__pick"]} placeholder="Pipeline" options={[{ value: "__pick", label: "a pipeline…" }, ...pipeOptions]}
                              onChange={(v) => v[0] && v[0] !== "__pick" && setOverride(filtered.map((r) => r.idx), v[0])} />
                          </div>
                          {Object.keys(st.pipeOverride).length > 0 && <button className="di-linkbtn" onClick={() => patch({ pipeOverride: {} })}>Undo moves ({Object.keys(st.pipeOverride).length})</button>}
                        </div>
                      </div>
                      <div className="di-table">
                        <div className="di-tr is-head"><span>Row</span><span>Deal</span><span>Pipeline</span><span>Phase</span><span>Owner</span><span>Value</span><span>Result</span></div>
                        {shown.map((r) => (
                          <DealRow key={r.idx} r={r} offset={rowOffset} phaseById={phaseById} personName={personName} productName={productName} pipeOptions={pipeOptions}
                            onPipe={(pid) => setOverride([r.idx], pid)} onReset={() => setOverride([r.idx], null)} />
                        ))}
                        {shown.length === 0 && <p className="di-muted di-pad">Nothing here.</p>}
                        {filtered.length > shown.length && <button className="di-more" onClick={() => setLimit((l) => l + 300)}>Show {fmtN(Math.min(300, filtered.length - shown.length))} more of {fmtN(filtered.length - shown.length)}</button>}
                      </div>
                    </>
                  )}
                  {rvTab === "companies" && (
                    <CompaniesSection list={plan.companies} used={usedCo} filter={coFilter} setFilter={setCoFilter} companies={companies} companyOptions={companyOptions} mode={st.coExisting}
                      choice={st.companyChoice} onChoose={(key, v) => setSt((s) => ({ ...s, companyChoice: { ...s.companyChoice, [key]: v } }))} />
                  )}
                  {rvTab === "contacts" && (
                    <ContactsSection list={plan.contacts} used={usedCt} filter={ctFilter} setFilter={setCtFilter} contactOptions={contactOptions} createContacts={st.createContacts} linkContacts={st.linkContacts} mode={st.ctExisting}
                      onChoose={(key, v) => setSt((s) => ({ ...s, contactChoice: { ...s.contactChoice, [key]: v } }))} />
                  )}
                  {rvTab === "options" && (
                    <div className="rv-options">
                      <div className="rv-opt">
                        <div><b>Deals already in the CRM</b><span>Same company and pipeline as a deal you already have.</span></div>
                        <div className="di-seg is-small"><button className={st.dupMode === "skip" ? "is-on" : ""} onClick={() => patch({ dupMode: "skip" })}>Skip them</button><button className={st.dupMode === "import" ? "is-on" : ""} onClick={() => patch({ dupMode: "import" })}>Import anyway</button></div>
                      </div>
                      {([
                        ["createContacts", "Create contacts that aren't in the CRM", "Otherwise those deals keep only their company."],
                        ["linkContacts", "Link found contacts to their deal's company", "A contact already in the CRM joins the company of its deal if it isn't there yet."],
                        ["markPassed", "Mark the earlier phases as passed", "Reports and sales roles see how far each deal got."],
                        ["makeClients", "Won with a close date → the company becomes a client", "Creates the client with its contacts and the deal's product, signed on the close date."],
                      ] as const).map(([k, l, d]) => (
                        <label key={k} className="rv-opt is-toggle">
                          <div><b>{l}</b><span>{d}</span></div>
                          <span className={`rv-switch ${st[k] ? "is-on" : ""}`}><input type="checkbox" checked={st[k]} onChange={(e) => patch({ [k]: e.target.checked } as Partial<ImportState>)} /><i /></span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ═════ 5. RUN / DONE ═════ */}
          {(step === "run" || step === "done") && (
            <div className="di-run">
              {step === "run" ? (
                <>
                  <div className="di-ring" style={{ ["--p" as string]: progress.total ? progress.done / progress.total : 0 } as CSSProperties}>
                    <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" pathLength={100} /><circle cx="60" cy="60" r="52" pathLength={100} className="is-fg" /></svg>
                    <b>{progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%</b>
                  </div>
                  <h3>{progress.phase || "Importing…"}</h3>
                  <p>{fmtN(progress.done)} of {fmtN(progress.total)} · keep this window open</p>
                </>
              ) : result && (
                <>
                  <span className={`di-done-ico ${result.failed.length || runErr ? "is-partial" : ""}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
                  <h3>{result.failed.length || runErr ? "Imported with some problems" : "Import complete"}</h3>
                  <div className="di-tiles is-final">
                    <div className="is-new"><b>{fmtN(result.created)}</b>deals created</div>
                    <div className="is-co"><b>{fmtN(result.coCreated)}</b>companies created{result.coUpdated > 0 && <small>{fmtN(result.coUpdated)} filled in</small>}</div>
                    <div className="is-ct"><b>{fmtN(result.ctCreated)}</b>contacts created{(result.ctUpdated > 0 || result.ctLinked > 0) && <small>{fmtN(result.ctUpdated)} filled in · {fmtN(result.ctLinked)} linked</small>}</div>
                    <div className="is-client"><b>{fmtN(result.clientsCreated)}</b>new clients</div>
                    <div className="is-error"><b>{fmtN(result.failed.length)}</b>not imported</div>
                  </div>
                  {result.newFields > 0 && <p>Also created {result.newFields} new {result.newFields === 1 ? "field" : "fields"}.</p>}
                  {runErr && <p className="di-err">{runErr}</p>}
                  {result.failed.length > 0 && (
                    <FailReport failed={result.failed} plan={ranPlan} rowOffset={rowOffset} sheet={sheet} hasHeader={hasHeader} onDownload={downloadErrors} />
                  )}
                  {!!ranPlan?.counts.dup && <p className="di-muted">{fmtN(ranPlan.counts.dup)} {ranPlan.counts.dup === 1 ? "deal was" : "deals were"} skipped because {ranPlan.counts.dup === 1 ? "it was" : "they were"} already in the CRM.</p>}
                </>
              )}
            </div>
          )}
        </div>

        {step !== "run" && (
          <footer className="di-foot">
            <span className={`di-foot-note ${step === "map" && mapIssue ? "is-warn" : ""}`}>
              {step === "file" && (wb ? `${fmtN(rows.length)} deals ready to map` : "Nothing changes until the last step.")}
              {step === "map" && (mapIssue ?? "Looks good — next, who gets each deal.")}
              {step === "people" && plan && (plan.counts.noOwner ? `${fmtN(plan.counts.noOwner)} of ${fmtN(plan.counts.new)} deals have no owner yet.` : `Every deal has an owner.`)}
              {step === "review" && plan && `${fmtN(plan.counts.new)} deals will be created${plan.counts.coNew ? `, with ${fmtN(plan.counts.coNew)} new companies` : ""}${plan.counts.ctNew ? ` and ${fmtN(plan.counts.ctNew)} new contacts` : ""}${plan.counts.clients && st.makeClients ? ` · ${fmtN(plan.counts.clients)} companies become clients` : ""}.`}
            </span>
            <div className="di-foot-actions">
              {step === "map" && <button className="di-btn is-ghost" onClick={() => setStep("file")}>Back</button>}
              {step === "people" && <button className="di-btn is-ghost" onClick={() => setStep("map")}>Back</button>}
              {step === "review" && <button className="di-btn is-ghost" onClick={() => setStep("people")}>Back</button>}
              {step === "done" ? <button className="di-btn is-primary" onClick={onClose}>Done</button> : <button className="di-btn is-ghost" onClick={onClose}>Cancel</button>}
              {step === "file" && <button className="di-btn is-primary" disabled={!wb || !rows.length} onClick={() => setStep("map")}>Map columns →</button>}
              {step === "map" && <button className="di-btn is-primary" disabled={!!mapIssue} onClick={() => setStep("people")}>People →</button>}
              {step === "people" && <button className="di-btn is-primary" onClick={() => { setTab(plan?.counts.error ? "error" : "all"); setStep("review"); }}>Review →</button>}
              {step === "review" && plan && <button className="di-btn is-primary" disabled={!plan.counts.new} onClick={run}>Import {fmtN(plan.counts.new)} {plan.counts.new === 1 ? "deal" : "deals"}</button>}
            </div>
          </footer>
        )}

        {viewer && sheet && (
          <SheetViewer sheet={sheet} name={wb && wb.sheets.length > 1 ? sheet.name : fileName} hasHeader={hasHeader} mapping={st.mapping}
            labelOf={(t) => ({ label: targetLabel(t), tone: targetOptions.find((o) => o.value === t)?.tone ?? "deal" })}
            canJump={step === "map"} onJump={jumpToColumn} onClose={() => setViewer(false)} />
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ═══════════════════════════ pieces ═══════════════════════════ */

function DropZone({ wb, fileName, loading, err, onPick, onClear, onTemplate, children }: {
  wb: Workbook | null; fileName: string; loading: boolean; err: string | null;
  onPick: (f: File | undefined) => void; onClear: () => void; onTemplate: () => void; children?: ReactNode;
}) {
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); onPick(e.dataTransfer.files?.[0]); };
  return (
    <section className={`di-drop ${wb ? "has-file" : ""}`}>
      {!wb ? (
        <div className={`di-zone ${drag ? "is-drag" : ""}`} role="button" tabIndex={0}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
          onClick={() => ref.current?.click()} onKeyDown={(e) => e.key === "Enter" && ref.current?.click()}>
          <input ref={ref} type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt,.xls" hidden onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = ""; }} />
          <span className="di-zone-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg></span>
          <b>{loading ? "Reading…" : "Drop the deals file here"}</b>
          <span>or click to choose · .xlsx .csv .tsv</span>
        </div>
      ) : (
        <div className="di-loaded">
          <div className="di-loaded-h">
            <span className="di-file-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg></span>
            <b title={fileName}>{fileName}</b>
            <button onClick={onClear}>Change file</button>
          </div>
          {children}
        </div>
      )}
      {err && <p className="di-err">{err}</p>}
      {!wb && <button className="di-linkbtn" onClick={onTemplate}>Download a template with your fields</button>}
    </section>
  );
}

/**
 * Side panel: where a deal's pipeline (or product) comes from — the same for
 * every deal, or a column of the file with each of its values sent to one of
 * yours (and a default for empty / unmatched rows).
 */
function SideSource({ title, target, noun, columns, mapping, ctx, st, guess, onColumn, onValue, valueOptions, defaultValue, defaultOptions, onDefault, allLabel, restLabel }: {
  title: string; target: string; noun: string; columns: Column[]; mapping: Record<number, string>; ctx: Ctx; st: ImportState;
  guess: (c: Column) => boolean; onColumn: (col: number | null) => void; onValue: (key: string, v: string) => void;
  valueOptions: (raw: string) => { value: string; label: string }[];
  defaultValue: string; defaultOptions: { value: string; label: string }[]; onDefault: (v: string) => void; allLabel: string; restLabel: string;
}) {
  const mappedCol = columns.find((c) => mapping[c.i] === target) ?? null;
  const [wantsColumn, setWantsColumn] = useState(false);
  const mode = mappedCol || wantsColumn ? "column" : "all";
  const dist = mappedCol ? distinctValues(mappedCol.values) : [];
  const rows = dist.map((d) => ({ ...d, ...choiceFor(ctx, st, target, d.text) }));
  const open = rows.filter((r) => !r.matched).length;
  const empty = mappedCol ? mappedCol.values.filter((v) => !cellText(v).trim()).length : 0;
  const pickMode = (m: "all" | "column") => {
    if (m === "all") { setWantsColumn(false); if (mappedCol) onColumn(null); return; }
    setWantsColumn(true);
    if (!mappedCol) { const g = columns.find((c) => !mapping[c.i] && guess(c)); if (g) onColumn(g.i); }
  };
  return (
    <section className={`di-src is-${mode}`}>
      <div className="di-src-h">
        <h4>{title}</h4>
        <div className="di-seg is-mini" role="radiogroup" aria-label={`${title} source`}>
          <button role="radio" aria-checked={mode === "all"} className={mode === "all" ? "is-on" : ""} onClick={() => pickMode("all")}>Same for all</button>
          <button role="radio" aria-checked={mode === "column"} className={mode === "column" ? "is-on" : ""} onClick={() => pickMode("column")}>From a column</button>
        </div>
      </div>
      {mode === "column" && (
        <div className="di-src-col">
          <span className="di-side-p">Column with the {noun}</span>
          <SalesMultiFilter single values={mappedCol ? [String(mappedCol.i)] : []} placeholder="Choose a column" searchFrom={8}
            onChange={(v) => v[0] && onColumn(Number(v[0]))}
            options={columns.map((c) => ({ value: String(c.i), label: `${c.letter} · ${c.header}${mapping[c.i] && mapping[c.i] !== target ? " (in use)" : ""}` }))} />
          {mappedCol && (
            <>
              <div className="di-src-vh"><span>Value in the file</span><span>Goes to</span>{open > 0 && <em>{open} to check</em>}</div>
              <div className="di-src-vals">
                {rows.slice(0, 40).map((r, j) => (
                  <div key={r.key} className={`di-src-v ${r.matched ? "" : "is-open"}`} style={{ ["--j" as string]: Math.min(j, 16) } as CSSProperties}>
                    <span title={r.text}><b>{r.text}</b><small>{r.count}×</small></span>
                    <SalesMultiFilter single values={[r.choice]} placeholder="Choose" searchFrom={8} options={valueOptions(r.text)} onChange={(v) => v[0] && onValue(r.key, v[0])} />
                  </div>
                ))}
                {rows.length > 40 && <p className="di-muted">+{rows.length - 40} more — match them on the column's card.</p>}
                {!rows.length && <p className="di-muted">This column is empty.</p>}
              </div>
            </>
          )}
        </div>
      )}
      <div className="di-src-def">
        <span className="di-side-p">{mode === "all" ? `${allLabel}:` : `${restLabel}${empty ? ` · ${empty} empty` : ""}:`}</span>
        <SalesMultiFilter single values={[defaultValue]} onChange={(v) => v[0] && onDefault(v[0])} options={defaultOptions} placeholder={title} searchFrom={8} />
      </div>
    </section>
  );
}

/* ═══════════════════════════ what failed ═══════════════════════════ */

/** A plain-language reading of an error, and what to do about it. */
function explain(reason: string): { title: string; hint: string } {
  const r = reason.toLowerCase();
  if (r.startsWith("no company or contact")) return { title: "No company or contact", hint: "The row has neither a company name nor a contact. Fill one in the file, or map the column that has it." };
  if (r.includes("both skipped")) return { title: "Company and contact skipped", hint: "You chose “No company” and no contact for this row in the review — give it one of the two." };
  if (r.startsWith("required:")) return { title: "A required deal field is empty", hint: "Map a column to that field, or make it optional in Sales → Deal fields." };
  if (r.startsWith("no pipeline")) return { title: "No pipeline", hint: "Choose a default pipeline, or map the column that says it." };
  if (r.includes("no phases")) return { title: "The pipeline has no phases", hint: "Add phases to that pipeline in Settings → Client pipelines, then import again." };
  if (r.includes("couldn't be created")) return { title: "Its company or contact couldn't be created", hint: "Look at the company / contact errors in this list — the deal depends on them." };
  if (r.startsWith("company “")) return { title: "A company couldn't be created", hint: "Usually a duplicate VAT or a value the database refuses. Fix it in the file and import that row again." };
  if (r.startsWith("contact “")) return { title: "A contact couldn't be created", hint: "Usually a duplicate email or an invalid value. Fix it in the file and import that row again." };
  if (r.startsWith("client “")) return { title: "A client couldn't be created", hint: "The deal was imported; create the client from the deal (Won → handoff) instead." };
  if (/duplicate key|already exists|unique/.test(r)) return { title: "Already exists", hint: "Something with the same key is already in the CRM." };
  if (/permission|row-level security|not allowed|42501/.test(r)) return { title: "Not allowed", hint: "Your role can't create this — ask a manager to run the import." };
  if (/invalid input|syntax|out of range|violates/.test(r)) return { title: "A value the database refuses", hint: "Check dates, numbers and choice values in this row." };
  return { title: "Other problem", hint: "The message below comes straight from the database." };
}

export function FailReport({ failed, plan, rowOffset, sheet, hasHeader, onDownload, describe, explainFn }: {
  failed: { row: number; reason: string }[]; plan: Plan | null; rowOffset: number; sheet: Sheet | null; hasHeader: boolean; onDownload: () => void;
  /** Another importer's own name / details for a row (instead of the deal plan). */
  describe?: (row: number) => { name: string | null; sub: string | null; issues: string[] } | null;
  /** Another importer's own reading of its errors (falls back to the deal one). */
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
  const rowOf = (n: number) => plan?.rows.find((r) => r.idx + rowOffset === n) ?? null;
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
                const pr = f.row && !describe ? rowOf(f.row) : null;
                const own = f.row && describe ? describe(f.row) : null;
                const name = own ? own.name : pr ? (pr.title ?? pr.companyLabel ?? pr.contactLabel) : (f.reason.match(/“([^”]+)”/)?.[1] ?? null);
                const sub = own ? own.sub : pr ? [pr.title ? pr.companyLabel : null, pr.contactLabel].filter(Boolean).join(" · ") : null;
                const also = own?.issues ?? pr?.issues ?? [];
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
    const re = () => place();
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
                      <span><b>{o.label}</b>{(o.hint || taken) && <small>{taken ? "Already used by another column" : o.hint}</small>}</span>
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
  const fromColumn = canonicalOptions(column.values);
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
function CoverageList({ used, ctx, st }: { used: string[]; ctx: Ctx; st: ImportState }) {
  const groups: { title: string; items: [string, string[]][] }[] = [
    { title: "Company", items: [["Name / VAT", ["company.name", "company.legal_name", "company.vat_number"]], ["Website · phone · email", ["company.website", "company.phone", "company.email"]], ["Address", ["company.street", "company.postal_code", "company.city", "company.province", "company.country"]]] },
    { title: "Contact", items: [["Name", ["contact.full_name", "contact.first_name"]], ["Email · phone", ["contact.email", "contact.phone"]], ["Position", ["contact.position"]]] },
    { title: "Deal", items: [["Title", ["deal.title"]], ["Phase", ["deal.phase"]], ["Phase dates", used.filter(isPhaseAt)], ["Status", ["deal.status", "deal.phase"]], ["Value", ["deal.value"]], ["Product", ["deal.product"]],
      ["Expected close date", ["deal.expected_close"]], ["Close date → client", ["deal.close_date"]], ["Probability", ["deal.probability"]], ["Created on", ["deal.created"]], ["Notes", ["deal.notes"]]] },
  ];
  const phaseN = used.filter(isPhaseAt).length;
  return (
    <div className="di-cover">
      {groups.map((g) => (
        <div key={g.title}>
          <span className="di-cover-h">{g.title}</span>
          <ul className="di-checks">
            {g.items.map(([l, ks]) => {
              const on = ks.some((k) => used.includes(k)) || (l === "Product" && !!st.defaultProduct);
              return <li key={l} className={on ? "is-on" : ""}><i>{on ? "✓" : ""}</i>{l}{l === "Phase dates" && phaseN > 0 && <em className="is-n">{phaseN}</em>}</li>;
            })}
          </ul>
        </div>
      ))}
      {ctx.fields.some((f) => f.required) && (
        <ul className="di-checks">
          {ctx.fields.filter((f) => f.required).map((f) => { const on = used.includes(`custom:${f.id}`); return <li key={f.id} className={on ? "is-on" : ""}><i>{on ? "✓" : ""}</i>{f.label}{!on && <em>required</em>}</li>; })}
        </ul>
      )}
    </div>
  );
}


/** The question for records already in the CRM: fill / replace / keep. */
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

const FOUND_SHORT: Record<string, string> = { vat: "VAT", name: "name", legal: "legal name", domain: "web domain", similar: "similar name", email: "email", phone: "phone" };

function CompaniesSection({ list, used, filter, setFilter, companies, companyOptions, choice, mode, onChoose }: {
  list: CompanyName[]; used: Set<string>; filter: "check" | "new" | "found" | "all"; setFilter: (f: "check" | "new" | "found" | "all") => void; companies: Company[]; companyOptions: { value: string; label: string }[];
  choice: Record<string, string>; mode: ExistingMode; onChoose: (key: string, v: string) => void;
}) {
  const [q, setQ] = useState("");
  const nameOf = (ref: string | null) => companies.find((x) => `crm:${x.id}` === ref)?.name;
  const toCheck = (c: CompanyName) => c.foundBy === "similar" || (!!c.suggest && !!c.ref?.startsWith("new:"));
  const n = { all: list.length, check: list.filter(toCheck).length, new: list.filter((c) => c.ref?.startsWith("new:")).length, found: list.filter((c) => c.ref?.startsWith("crm:")).length };
  const shown = list.filter((c) => (filter === "all" || (filter === "check" ? toCheck(c) : filter === "new" ? c.ref?.startsWith("new:") : c.ref?.startsWith("crm:")))
    && (!q.trim() || normHeader(`${c.name} ${c.data.vat_number ?? ""} ${c.data.city ?? ""}`).includes(normHeader(q))));
  return (
    <>
      <div className="rv-tools">
        <label className="di-search is-small">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a company…" />
        </label>
        <div className="rv-chips">
          {([["all", "All"], ["check", "To check"], ["new", "New"], ["found", "In the CRM"]] as const).filter(([k]) => k === "all" || n[k] > 0).map(([k, l]) => (
            <button key={k} className={`${filter === k ? "is-on" : ""} ${k === "check" ? "is-warn" : ""}`} onClick={() => setFilter(k)}>{l} <i>{n[k]}</i></button>
          ))}
        </div>
      </div>
      <div className="rv-list">
        {shown.slice(0, 400).map((c, i) => {
          const ch = choice[c.key] ?? (!c.ref ? "skip" : c.ref.startsWith("new:") ? "create" : c.ref);
          const unused = !used.has(c.key);
          const linked = nameOf(c.ref);
          const kind = !c.ref ? "skip" : c.ref.startsWith("new:") ? "new" : c.foundBy === "similar" && c.ref === c.found ? "similar" : "crm";
          return (
            <div key={c.key} className={`rv-row is-${kind} ${unused ? "is-unused" : ""}`} style={{ ["--j" as string]: Math.min(i, 24) } as CSSProperties}>
              <span className="rv-row-main">
                <b title={c.name}>{c.name}</b>
                <small>
                  <em className={`rv-tag is-${kind}`}>{kind === "new" ? "New" : kind === "skip" ? "No company" : kind === "similar" ? "Similar name" : "In the CRM"}</em>
                  {c.ref?.startsWith("crm:")
                    ? <>{c.ref === c.found ? `by ${FOUND_SHORT[c.foundBy ?? "name"]}` : "picked by hand"}{linked && normHeader(linked) !== normHeader(c.name) ? <> · as <b>{linked}</b></> : null}{c.score ? ` · ${Math.round(c.score * 100)}%` : ""}</>
                    : [c.data.vat_number, c.data.city, c.data.website].filter(Boolean).join(" · ")}
                  <span className="rv-n">{c.count} {c.count === 1 ? "deal" : "deals"}</span>
                  {c.isClient && <span className="rv-n is-gold">client</span>}
                </small>
              </span>
              <span className="rv-row-mid">
                {unused ? <span className="rv-diff is-none">Only on deals that won't be imported</span>
                  : c.suggest && c.ref?.startsWith("new:") ? (
                    <button className="rv-suggest" onClick={() => onChoose(c.key, `crm:${c.suggest!.id}`)} title={c.suggest.why}>
                      Looks like <b>{c.suggest.name}</b><span>{c.suggest.why}</span><i>Link</i>
                    </button>
                  ) : c.ref?.startsWith("crm:") ? <DiffNote diff={c.diff} mode={mode} /> : null}
              </span>
              <SalesMultiFilter single values={[ch]} placeholder="Choose" searchFrom={8} onChange={(v) => v[0] && onChoose(c.key, v[0])}
                options={[
                  ...(c.found ? [{ value: c.found, label: `✓ ${nameOf(c.found) ?? c.name}` }] : []),
                  { value: "create", label: `+ Create “${c.name}”` },
                  { value: "skip", label: "No company (contact only)" },
                  ...companyOptions.filter((o) => o.value !== c.found),
                ]} />
            </div>
          );
        })}
        {shown.length === 0 && <p className="di-muted di-pad">Nothing here.</p>}
      </div>
    </>
  );
}

function ContactsSection({ list, used, filter, setFilter, contactOptions, createContacts, linkContacts, mode, onChoose }: {
  list: ContactName[]; used: Set<string>; filter: "new" | "found" | "all"; setFilter: (f: "new" | "found" | "all") => void; contactOptions: { value: string; label: string }[];
  createContacts: boolean; linkContacts: boolean; mode: ExistingMode; onChoose: (key: string, v: string) => void;
}) {
  const [q, setQ] = useState("");
  const n = { all: list.length, new: list.filter((c) => !c.found).length, found: list.filter((c) => c.found).length };
  const shown = list.filter((c) => (filter === "all" || (filter === "new" ? !c.found : !!c.found))
    && (!q.trim() || normHeader(`${c.first_name} ${c.last_name ?? ""} ${c.email ?? ""} ${c.companyLabel ?? ""}`).includes(normHeader(q))));
  return (
    <>
      <div className="rv-tools">
        <label className="di-search is-small">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a contact…" />
        </label>
        <div className="rv-chips">
          {([["all", "All"], ["new", "New"], ["found", "In the CRM"]] as const).map(([k, l]) => <button key={k} className={filter === k ? "is-on" : ""} onClick={() => setFilter(k)}>{l} <i>{n[k]}</i></button>)}
        </div>
        {!createContacts && <span className="rv-tools-note">New contacts are off (Options)</span>}
      </div>
      <div className="rv-list">
        {shown.slice(0, 400).map((c, i) => {
          const ch = c.ref ? (c.ref.startsWith("new:") ? "create" : c.ref) : "skip";
          const full = [c.first_name, c.last_name].filter(Boolean).join(" ");
          const kind = !c.ref ? "skip" : c.ref.startsWith("new:") ? "new" : "crm";
          const unused = !used.has(c.key);
          const rel = !c.ref || !c.companyLabel ? null : c.link === "linked" ? { cls: "is-ok", txt: `Already at ${c.companyLabel}` }
            : c.ref.startsWith("new:") || linkContacts ? { cls: "is-link", txt: `Joins ${c.companyLabel}` } : { cls: "is-off", txt: `Not linked to ${c.companyLabel}` };
          return (
            <div key={c.key} className={`rv-row is-${kind} ${unused ? "is-unused" : ""}`} style={{ ["--j" as string]: Math.min(i, 24) } as CSSProperties}>
              <span className="rv-row-main">
                <b title={full}>{full}</b>
                <small>
                  <em className={`rv-tag is-${kind}`}>{kind === "new" ? "New" : kind === "skip" ? "Skipped" : "In the CRM"}</em>
                  {c.found ? `by ${FOUND_SHORT[c.foundBy ?? "email"]} · ` : ""}{[c.email, c.phone, c.position].filter(Boolean).join(" · ") || "no email or phone"}
                  <span className="rv-n">{c.count} {c.count === 1 ? "deal" : "deals"}</span>
                </small>
              </span>
              <span className="rv-row-mid">
                {unused ? <span className="rv-diff is-none">Only on deals that won't be imported</span> : (
                  <>
                    {rel && <span className={`rv-rel ${rel.cls}`}>{rel.txt}</span>}
                    {c.ref?.startsWith("crm:") && <DiffNote diff={c.diff} mode={mode} />}
                  </>
                )}
              </span>
              <SalesMultiFilter single values={[ch]} placeholder="Choose" searchFrom={8} onChange={(v) => v[0] && onChoose(c.key, v[0])}
                options={[
                  ...(c.found ? [{ value: c.found, label: `✓ ${contactOptions.find((o) => o.value === c.found)?.label.replace(/^Link to /, "") ?? full}` }] : []),
                  { value: "create", label: `+ Create “${full}”` },
                  { value: "skip", label: "No contact on these deals" },
                  ...contactOptions.filter((o) => o.value !== c.found),
                ]} />
            </div>
          );
        })}
        {shown.length === 0 && <p className="di-muted di-pad">Nothing here.</p>}
      </div>
    </>
  );
}

function DealRow({ r, offset, phaseById, personName, productName, pipeOptions, onPipe, onReset }: {
  r: PlanRow; offset: number; phaseById: Map<string, Phase>; personName: (id: string | null) => string; productName: (id: string | null) => string;
  pipeOptions: { value: string; label: string }[]; onPipe: (pid: string) => void; onReset: () => void;
}) {
  const ph = r.phaseId ? phaseById.get(r.phaseId) : undefined;
  const reached = r.reachedPhaseId && r.reachedPhaseId !== r.phaseId ? phaseById.get(r.reachedPhaseId) : undefined;
  const refTag = (ref: string | null) => (ref?.startsWith("new:") ? <em className="is-new">new</em> : ref ? <em>found</em> : null);
  const head = r.title ?? r.companyLabel ?? r.contactLabel ?? "—";
  const dates = Object.values(r.phaseDates);
  return (
    <div className={`di-tr is-${r.status} ${r.status === "new" && r.issues.length ? "has-warn" : ""} ${r.pipeOverridden ? "is-moved" : ""}`}>
      <span className="di-rn">{r.idx + offset}</span>
      <span className="di-deal">
        <b title={head}>{head}{r.becomesClient && <em className="is-client">→ client</em>}</b>
        {(r.title ? r.companyLabel : r.companyLabel && r.contactLabel) && <small>{r.title ? r.companyLabel : r.contactLabel}{refTag(r.companyRef)}</small>}
        {r.title && r.contactLabel && <small className="di-sub">{r.contactLabel}{refTag(r.contactRef)}</small>}
        {!r.title && r.contactLabel && !r.companyLabel && <small>{refTag(r.contactRef)}</small>}
      </span>
      <span className="di-pipe">
        <SalesMultiFilter single values={r.pipelineId ? [r.pipelineId] : []} placeholder="Pick a pipeline" options={pipeOptions} onChange={(v) => v[0] && onPipe(v[0])} />
        {r.pipeOverridden && <button className="di-moved" onClick={onReset} title="Back to the pipeline from the file">moved · undo</button>}
      </span>
      <span className="di-where">
        <b>{ph?.name ?? "—"}{normHeader(ph?.name ?? "") !== normHeader(STATUS_LABEL[r.dealStatus] ?? "") && <i className={`di-st is-${r.dealStatus}`}>{STATUS_LABEL[r.dealStatus] ?? r.dealStatus}</i>}</b>
        <small>
          {reached ? `reached ${reached.name}` : ""}
          {r.closedOn ? `${reached ? " · " : ""}closed ${day(r.closedOn)}` : r.expectedClose ? `${reached ? " · " : ""}expected ${day(r.expectedClose)}` : ""}
          {!reached && !r.closedOn && !r.expectedClose && dates.length > 1 ? `${dates.length} phase dates` : ""}
        </small>
      </span>
      <span className="di-owner">{r.owner ? <><span className="di-av">{initials(personName(r.owner))}</span>{personName(r.owner)}{r.team.length > 1 && <small>+{r.team.length - 1}</small>}</> : <span className="di-muted">No owner</span>}</span>
      <span className="di-val-n">
        {r.value != null ? eur(r.value) : "—"}
        {r.productId && <small className={r.productDefaulted ? "is-default" : ""} title={r.productDefaulted ? "Default product" : undefined}>{productName(r.productId)}</small>}
      </span>
      <span className="di-res">
        <span className={`di-pill is-${r.status}`}>{r.status === "new" ? "Import" : r.status === "dup" ? "Skip" : "Error"}</span>
        {(r.reason || r.issues.length > 0) && <small title={[r.reason, ...r.issues].filter(Boolean).join("\n")}>{r.reason ?? r.issues[0]}{r.issues.length > 1 && !r.reason ? ` (+${r.issues.length - 1})` : ""}</small>}
      </span>
    </div>
  );
}

function PeopleSummary({ rows, personName }: { rows: PlanRow[]; personName: (id: string | null) => string }) {
  const counts = new Map<string, number>();
  rows.forEach((r) => counts.set(r.owner ?? "", (counts.get(r.owner ?? "") ?? 0) + 1));
  const list = [...counts.entries()].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || b[1] - a[1]);
  const max = Math.max(1, ...list.map((x) => x[1]));
  return (
    <>
      <h4>Owners after the import</h4>
      <div className="di-bars">
        {list.map(([id, n], i) => (
          <div key={id || "none"} className={`di-bar ${id ? "" : "is-none"}`} style={{ ["--w" as string]: n / max, ["--i" as string]: i } as CSSProperties}>
            <span className="di-bar-name">{id ? personName(id) : "No owner"}</span>
            <span className="di-bar-track"><i /></span>
            <b>{fmtN(n)}</b>
          </div>
        ))}
      </div>
    </>
  );
}

/* ═══════════════════════════ the whole sheet ═══════════════════════════ */

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