/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import SalesMultiFilter from "../sales/SalesMultiFilter";
import DealRolePicker from "./DealRolePicker";
import { useBackToClose } from "../../../framework/useBackToClose";
import { readSpreadsheet, colLetter, cellText, normHeader, parseNumber, type Workbook } from "../../../framework/spreadsheetImport";
import { listCompanies, listContacts, type Company, type Contact } from "../../companies/companiesApi";
import type { Pipeline, Phase } from "../../settings/pipelineApi";
import type { Product } from "../../settings/catalogApi";
import { listLossReasons, type LossReason, type Tracking } from "../sales/salesApi";
import { listTrackingFields, type TrackingField } from "./trackingFieldsApi";
import type { SalesRole } from "./salesRolesApi";
import {
  BASE_TARGETS, VALUE_TARGETS, STATUS_LABEL, EMAIL_RE,
  guessTarget, guessType, guessOwnerColumn, distinctValues, choiceFor, matchPerson, buildPlan, mapProblem, peopleWithSeveralRoles,
  runImport, sortedPipelines, phasesOf,
  type Column, type Ctx, type ImportState, type NewField, type Person, type Rule, type FieldType, type PlanRow, type RunResult,
} from "./dealImportEngine";
import "./DealImport.css";

const TYPE_LABEL: Record<FieldType, string> = { text: "Text", number: "Number", date: "Date", boolean: "Yes / No", select: "Choice list" };
const uid = () => Math.random().toString(36).slice(2, 9);
const fmtN = (n: number) => n.toLocaleString("es-ES");
const eur = (n: number) => `${Math.round(n).toLocaleString("es-ES")} €`;
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

type Step = "file" | "map" | "people" | "review" | "run" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "file", label: "File" }, { key: "map", label: "Columns" }, { key: "people", label: "People" }, { key: "review", label: "Review" }, { key: "done", label: "Import" },
];

/**
 * Actions → Import deals. Deals from another CRM (Teamleader, HubSpot, a
 * spreadsheet…): map the columns, match each value to ours (phases, pipelines,
 * status, products, choice fields), decide who gets each deal from any column,
 * link or create the companies and contacts, review, import.
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
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lossReasons, setLossReasons] = useState<LossReason[]>([]);
  useEffect(() => {
    listTrackingFields().then(setFields).catch(() => {});
    listCompanies().then(setCompanies).catch(() => {});
    listContacts().then(setContacts).catch(() => {});
    listLossReasons().then(setLossReasons).catch(() => {});
  }, []);

  /* ─────────────── the file ─────────────── */
  const [fileName, setFileName] = useState("");
  const [wb, setWb] = useState<Workbook | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [hasHeader, setHasHeader] = useState(true);
  const [loading, setLoading] = useState(false);
  const [fileErr, setFileErr] = useState<string | null>(null);
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

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFileErr(null); setLoading(true); touched.current = false;
    try {
      const book = await readSpreadsheet(f);
      const best = book.sheets.reduce((bi, s, i) => (s.rows.length > book.sheets[bi].rows.length ? i : bi), 0);
      const first = book.sheets[best].rows;
      const looksHeader = !!first[0] && first[0].every((c) => c == null || (typeof c === "string" && !EMAIL_RE.test(c) && parseNumber(c) == null));
      setWb(book); setSheetIdx(best); setHasHeader(looksHeader); setFileName(f.name);
      setNewFields([]); setValueMaps({}); setRules([]); setCompanyChoice({});
      if (!first.length) setFileErr("This sheet is empty.");
    } catch (e: any) { setFileErr(e?.message ?? "Couldn't read this file."); setWb(null); }
    setLoading(false);
  };
  const clearFile = () => { setWb(null); setFileName(""); setMapping({}); setNewFields([]); setValueMaps({}); setRules([]); setFileErr(null); touched.current = false; };

  /* ─────────────── mapping state ─────────────── */
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [newFields, setNewFields] = useState<NewField[]>([]);
  const [valueMaps, setValueMaps] = useState<Record<string, Record<string, string>>>({});
  const [defaultPipeline, setDefaultPipeline] = useState("");
  const [rules, setRules] = useState<Rule[]>([]);
  const [personRole, setPersonRole] = useState<Record<string, string>>({});
  const [companyChoice, setCompanyChoice] = useState<Record<string, string>>({});
  const [createContacts, setCreateContacts] = useState(true);
  const [dupMode, setDupMode] = useState<"skip" | "import">("skip");
  const [markPassed, setMarkPassed] = useState(true);
  const [openValues, setOpenValues] = useState<Record<number, boolean>>({});
  const touched = useRef(false);
  const rulesTouched = useRef(false);

  useEffect(() => { if (!defaultPipeline && pipelines.length) setDefaultPipeline(pipelines[0].id); }, [pipelines, defaultPipeline]);

  // automatic mapping, until the person changes something
  useEffect(() => {
    if (!sheet || touched.current) return;
    const m: Record<number, string> = {};
    const used = new Set<string>();
    for (const c of columns) {
      const f = fields.find((x) => normHeader(x.label) === normHeader(c.header));
      if (f && !used.has(`custom:${f.id}`)) { m[c.i] = `custom:${f.id}`; used.add(m[c.i]); continue; }
      const g = guessTarget(c.header, c.samples);
      if (g && (!used.has(g) || g === "deal.notes")) { m[c.i] = g; used.add(g); continue; }
      m[c.i] = "";
    }
    if (Object.values(m).includes("contact.first_name")) for (const k of Object.keys(m)) if (m[+k] === "contact.full_name") m[+k] = "";
    setMapping(m);
    if (!rulesTouched.current) {
      const oc = guessOwnerColumn(columns);
      setRules(oc != null ? [{ id: uid(), col: oc, as: "owner", map: {}, fallback: "" }] : []);
    }
  }, [sheet, hasHeader, columns, fields]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTarget = (col: number, v: string) => {
    touched.current = true;
    if (v === "__create") {
      const c = columns.find((x) => x.i === col)!;
      const g = guessType(c.values);
      let label = c.header.trim() || `Field ${c.letter}`;
      if (fields.some((f) => normHeader(f.label) === normHeader(label)) || newFields.some((n) => normHeader(n.label) === normHeader(label))) label = `${label} (imported)`;
      const nf: NewField = { tmp: uid(), label, type: g.type, options: g.options };
      setNewFields((xs) => [...xs, nf]);
      setMapping((m) => ({ ...m, [col]: `new:${nf.tmp}` }));
      return;
    }
    setMapping((m) => ({ ...m, [col]: v === "__none" ? "" : v }));
    if (VALUE_TARGETS.has(v) || v.startsWith("custom:")) setOpenValues((o) => ({ ...o, [col]: true }));
  };
  const patchNew = (tmp: string, patch: Partial<NewField>) => setNewFields((xs) => xs.map((n) => (n.tmp === tmp ? { ...n, ...patch } : n)));
  const removeNew = (tmp: string) => { setNewFields((xs) => xs.filter((n) => n.tmp !== tmp)); setMapping((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === `new:${tmp}` ? "" : v]))); };
  const setValueChoice = (target: string, key: string, choice: string) => setValueMaps((vm) => ({ ...vm, [target]: { ...(vm[target] ?? {}), [key]: choice } }));

  const ctx: Ctx = useMemo(() => ({ pipelines, phaseByPipe, products, lossReasons, fields, people, roles, companies, contacts, trackings }),
    [pipelines, phaseByPipe, products, lossReasons, fields, people, roles, companies, contacts, trackings]);
  const state: ImportState = { mapping, newFields, valueMaps, defaultPipeline, rules, personRole, companyChoice, createContacts, dupMode, markPassed };
  const mapIssue = mapProblem(ctx, state);
  const planNeeded = step === "people" || step === "review" || step === "run";
  const plan = useMemo(() => (planNeeded ? buildPlan(ctx, columns, rows, state) : null),
    [planNeeded, ctx, columns, rows, mapping, newFields, valueMaps, defaultPipeline, rules, personRole, companyChoice, createContacts, dupMode, markPassed]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─────────────── labels ─────────────── */
  const personName = (id: string | null | undefined) => people.find((p) => p.id === id)?.name ?? "—";
  const pipeName = (id: string | null) => pipelines.find((p) => p.id === id)?.name ?? "—";
  const phaseById = useMemo(() => new Map(Object.values(phaseByPipe).flat().map((p) => [p.id, p])), [phaseByPipe]);
  const fieldOf = (t: string): TrackingField | NewField | null =>
    t.startsWith("custom:") ? fields.find((f) => f.id === t.slice(7)) ?? null : t.startsWith("new:") ? newFields.find((n) => n.tmp === t.slice(4)) ?? null : null;
  const targetLabel = (t: string) => BASE_TARGETS.find((b) => b.key === t)?.label ?? fieldOf(t)?.label ?? t;

  const targetOptions = useMemo(() => [
    { value: "__none", label: "Don't import" },
    ...BASE_TARGETS.map((b) => ({ value: b.key, label: `${b.group} · ${b.label}` })),
    ...fields.map((f) => ({ value: `custom:${f.id}`, label: `Deal field · ${f.label} (${TYPE_LABEL[f.type] ?? f.type})` })),
    ...newFields.map((n) => ({ value: `new:${n.tmp}`, label: `New deal field · ${n.label} (${TYPE_LABEL[n.type]})` })),
    { value: "__create", label: "+ Create a new deal field from this column…" },
  ], [fields, newFields]);

  /** What each value of a column can become. */
  const valueOptions = (target: string, raw: string): { value: string; label: string }[] => {
    if (target === "deal.pipeline") return [...pipelines.map((p) => ({ value: p.id, label: p.name })), { value: "__default", label: `Default pipeline (${pipeName(defaultPipeline)})` }];
    if (target === "deal.phase") return [
      ...sortedPipelines(ctx, defaultPipeline).flatMap((p) => phasesOf(ctx, p.id).map((ph) => ({ value: ph.id, label: `${ph.name}${ph.sales_outcome && !/won|lost|ganad|perdid/i.test(ph.name) ? (ph.sales_outcome === "win" ? " (won)" : " (lost)") : ""} · ${p.name}` }))),
      { value: "__first", label: "First phase of the deal's pipeline" },
    ];
    if (target === "deal.status") return Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }));
    if (target === "deal.product") return [...products.map((p) => ({ value: p.id!, label: p.name })), { value: "__none", label: "No product" }];
    if (target === "deal.loss_reason") return [...lossReasons.map((r) => ({ value: r.label, label: r.label })), { value: "__new", label: `+ Add “${raw}” as a lost reason` }, { value: "__details", label: "Keep it as details" }];
    const f = fieldOf(target) as TrackingField | null;
    return [...(f?.options ?? []).map((o) => ({ value: o, label: o })), { value: "__new", label: `+ Add “${raw}” as a new option` }, { value: "__empty", label: "Leave empty" }];
  };
  const hasValueStep = (t: string) => VALUE_TARGETS.has(t) || (t.startsWith("custom:") && (fieldOf(t) as TrackingField | null)?.type === "select");

  /* ─────────────── people rules ─────────────── */
  const peopleOptions = useMemo(() => [{ value: "__nobody", label: "Nobody" }, ...people.map((p) => ({ value: p.id, label: p.id === meId ? `${p.name} (you)` : p.name }))], [people, meId]);
  const patchRule = (id: string, patch: Partial<Rule>) => { rulesTouched.current = true; setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r))); };
  const addRule = (as: Rule["as"], col: number | null = null) => { rulesTouched.current = true; setRules((rs) => [...rs, { id: uid(), col, as, map: {}, fallback: "" }]); };
  const removeRule = (id: string) => { rulesTouched.current = true; setRules((rs) => rs.filter((r) => r.id !== id)); };
  const multiRole = plan ? peopleWithSeveralRoles(ctx, plan) : [];

  /* ─────────────── run ─────────────── */
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: "" });
  const [result, setResult] = useState<RunResult | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const run = async () => {
    if (!plan) return;
    setStep("run"); setRunErr(null);
    try {
      const r = await runImport(ctx, state, columns, plan, fileName, rowOffset, setProgress);
      setResult(r);
    } catch (e: any) { setRunErr(e?.message ?? "The import stopped unexpectedly."); setResult({ created: 0, failed: [], coCreated: 0, ctCreated: 0, newFields: 0, batchId: null }); }
    setStep("done");
    onDone();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && step !== "run" && !document.querySelector(".smf-menu")) onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose, step]);

  /* ─────────────── downloads ─────────────── */
  const download = (name: string, lines: string[][]) => {
    const esc = (s: string) => (/[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const blob = new Blob(["﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const template = () => download("deals-template.csv", [[
    "Company", "Company VAT", "Contact name", "Contact email", "Contact phone", "Title", "Pipeline", "Phase", "Status", "Value", "Product",
    "Expected close date", "Probability", "Created on", "Owner", "Lost reason", "Notes", ...fields.map((f) => f.label),
  ]]);
  const downloadErrors = () => {
    if (!result || !sheet) return;
    download(`${fileName.replace(/\.[^.]+$/, "")}-import-errors.csv`, [["Row", "Problem", ...(hasHeader ? sheet.rows[0].map(cellText) : columns.map((c) => c.header))],
      ...result.failed.map((f) => [f.row ? String(f.row) : "—", f.reason, ...(f.row ? (sheet.rows[f.row - 1] ?? []).map(cellText) : [])])]);
  };

  /* ─────────────── review filters ─────────────── */
  const [tab, setTab] = useState<"all" | "new" | "warn" | "dup" | "error">("all");
  const [coFilter, setCoFilter] = useState<"missing" | "all">("missing");
  const shown = (plan?.rows ?? []).filter((r) => tab === "all" || (tab === "warn" ? r.status === "new" && r.issues.length > 0 : r.status === tab)).slice(0, 300);

  const stepIdx = step === "run" ? 4 : STEPS.findIndex((s) => s.key === step);
  const usedTargets = Object.values(mapping).filter(Boolean);

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
          <button className="di-x" onClick={onClose} disabled={step === "run"} aria-label="Close">×</button>
        </header>

        <div className="di-body" key={step}>
          {/* ═════ 1. FILE ═════ */}
          {step === "file" && (
            <div className="di-file">
              <div className="di-file-intro">
                <h3>Bring your deals over</h3>
                <p>Export the deals from your old CRM (Teamleader, HubSpot, Pipedrive, a spreadsheet…) as Excel or CSV. Next you'll match its columns and values to yours — phases, pipelines, owners — and we'll find or create the companies and contacts.</p>
                <ul className="di-file-points">
                  <li><b>Phases & values</b>“SQL 8” there can be “SQL 2” here</li>
                  <li><b>Owners</b>from any column, value by value</li>
                  <li><b>Companies & contacts</b>found by name, VAT or email — or created</li>
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
                        <tbody>{rows.slice(0, 3).map((r, ri) => <tr key={ri}>{columns.slice(0, 6).map((c) => <td key={c.i}>{cellText(r[c.i] ?? null)}</td>)}</tr>)}</tbody></table>
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
                {columns.map((c, k) => {
                  const t = mapping[c.i] ?? "";
                  const nf = t.startsWith("new:") ? (fieldOf(t) as NewField) : null;
                  const valued = !!t && hasValueStep(t);
                  const dist = valued ? distinctValues(c.values) : [];
                  const decisions = dist.map((d) => ({ ...d, ...choiceFor(ctx, state, t, d.text) }));
                  const open = decisions.filter((d) => !d.matched).length;
                  const expanded = valued && (openValues[c.i] ?? open > 0);
                  return (
                    <div key={c.i} className={`di-map ${t ? "is-mapped" : ""} ${open ? "has-open" : ""} ${!t && rules.some((r) => r.col === c.i) ? "is-people" : ""}`} style={{ ["--i" as string]: Math.min(k, 14) } as CSSProperties}>
                      <div className="di-map-row">
                        <span className="di-col"><em>{c.letter}</em><span><b title={c.header}>{c.header}</b><small>{c.filled} filled</small></span></span>
                        <span className="di-samples">{c.samples.length ? c.samples.map((x, i) => <span key={i} title={cellText(x)}>{cellText(x)}</span>) : <i>empty</i>}</span>
                        <svg className="di-arrow" viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                        <div className="di-target">
                          <SalesMultiFilter single values={[t || "__none"]} onChange={(v) => v[0] && setTarget(c.i, v[0])} options={targetOptions} placeholder="Choose" searchFrom={8} />
                          {rules.some((r) => r.col === c.i) && <span className="di-used">Gives the {rules.find((r) => r.col === c.i)!.as === "owner" ? "owner" : "people"} · next step</span>}
                        </div>
                      </div>
                      {nf && (
                        <div className="di-newfield">
                          <span className="di-tag">New deal field</span>
                          <input value={nf.label} onChange={(e) => patchNew(nf.tmp, { label: e.target.value })} aria-label="New field name" />
                          <SalesMultiFilter single values={[nf.type]} onChange={(v) => v[0] && patchNew(nf.tmp, { type: v[0] as FieldType, options: v[0] === "select" ? guessType(c.values).options : [] })}
                            options={(Object.keys(TYPE_LABEL) as FieldType[]).map((x) => ({ value: x, label: TYPE_LABEL[x] }))} placeholder="Type" />
                          <button onClick={() => removeNew(nf.tmp)} aria-label="Don't create this field">×</button>
                          {nf.type === "select" && <small>{nf.options.length} options: {nf.options.slice(0, 6).join(", ")}{nf.options.length > 6 ? "…" : ""}</small>}
                        </div>
                      )}
                      {valued && dist.length > 0 && (
                        <div className={`di-values ${expanded ? "is-open" : ""}`}>
                          <button className="di-values-h" onClick={() => setOpenValues((o) => ({ ...o, [c.i]: !expanded }))} aria-expanded={expanded}>
                            <b>Match the values to {t === "deal.phase" ? "your phases" : t === "deal.pipeline" ? "your pipelines" : t === "deal.status" ? "a status" : t === "deal.product" ? "your products" : t === "deal.loss_reason" ? "your lost reasons" : `“${targetLabel(t)}”`}</b>
                            <span className={open ? "is-warn" : "is-ok"}>{open ? `${open} to check` : "all matched"} · {dist.length} {dist.length === 1 ? "value" : "values"}</span>
                            <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
                          </button>
                          {expanded && (
                            <div className="di-values-grid">
                              {decisions.slice(0, 80).map((d, j) => (
                                <div key={d.key} className={`di-val ${d.matched ? (d.auto ? "is-auto" : "is-set") : "is-open"}`} style={{ ["--j" as string]: Math.min(j, 20) } as CSSProperties}>
                                  <span className="di-val-from"><b title={d.text}>{d.text}</b><small>{d.count}×</small></span>
                                  <svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                                  <SalesMultiFilter single values={[d.choice]} onChange={(x) => x[0] && setValueChoice(t, d.key, x[0])} placeholder="Choose" searchFrom={9} options={valueOptions(t, d.text)} />
                                  <i className="di-val-tag">{d.matched ? (d.auto ? "auto" : "set") : "check"}</i>
                                </div>
                              ))}
                              {decisions.length > 80 && <p className="di-muted">+{decisions.length - 80} more values — they go to “{valueOptions(t, "").find((o) => o.value === decisions[80].choice)?.label ?? "default"}” unless matched.</p>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <aside className="di-side">
                <h4>Pipeline</h4>
                <p className="di-side-p">{usedTargets.includes("deal.pipeline") || usedTargets.includes("deal.phase") ? "For rows whose pipeline or phase doesn't say:" : "Every deal goes into:"}</p>
                <SalesMultiFilter single values={[defaultPipeline]} onChange={(v) => v[0] && setDefaultPipeline(v[0])} options={pipelines.map((p) => ({ value: p.id, label: p.name }))} placeholder="Pipeline" />
                <h4>What the deals get</h4>
                <ul className="di-checks">
                  {([
                    ["Company", ["company.name", "company.vat"]], ["Contact", ["contact.full_name", "contact.first_name", "contact.email"]],
                    ["Phase", ["deal.phase"]], ["Status", ["deal.status", "deal.phase"]], ["Value", ["deal.value"]], ["Product", ["deal.product"]],
                    ["Close date", ["deal.close_date"]], ["Probability", ["deal.probability"]], ["Created on", ["deal.created"]], ["Notes", ["deal.notes", "deal.title"]],
                  ] as [string, string[]][]).map(([l, ks]) => { const on = ks.some((k) => usedTargets.includes(k)); return <li key={l} className={on ? "is-on" : ""}><i>{on ? "✓" : ""}</i>{l}</li>; })}
                  {fields.map((f) => { const on = usedTargets.includes(`custom:${f.id}`); return <li key={f.id} className={on ? "is-on" : ""}><i>{on ? "✓" : ""}</i>{f.label}{f.required && !on && <em>required</em>}</li>; })}
                </ul>
                {newFields.length > 0 && <><h4>Will be created</h4><ul className="di-checks">{newFields.map((n) => <li key={n.tmp} className="is-new"><i>+</i>{n.label || "Untitled"}<em>{TYPE_LABEL[n.type]}</em></li>)}</ul></>}
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
              {rules.length === 0 && (
                <div className="di-empty">
                  <p>No rules yet — imported deals would have <b>no owner</b>.</p>
                  <div>
                    <button className="di-btn is-primary" onClick={() => addRule("owner", guessOwnerColumn(columns) ?? columns[0]?.i ?? null)}>Owner from a column</button>
                    {meId && <button className="di-btn is-ghost" onClick={() => { rulesTouched.current = true; setRules([{ id: uid(), col: null, as: "owner", map: {}, fallback: meId }]); }}>Make me the owner of all</button>}
                  </div>
                </div>
              )}
              <div className="di-rules">
                {rules.map((rule, ri) => {
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
              {rules.length > 0 && (
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
                      <DealRolePicker roles={m.roles} value={personRole[m.id] ?? null} personName={personName(m.id)} onChange={(rid) => setPersonRole((p) => ({ ...p, [m.id]: rid }))} />
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
          {step === "review" && plan && (
            <div className="di-review">
              <div className="di-tiles">
                <div className="is-new"><b>{fmtN(plan.counts.new)}</b>deals to import</div>
                <div className="is-co"><b>{fmtN(plan.counts.coNew)}</b>new companies<small>{fmtN(plan.counts.coFound)} found</small></div>
                <div className="is-ct"><b>{fmtN(plan.counts.ctNew)}</b>new contacts<small>{fmtN(plan.counts.ctFound)} found</small></div>
                <div className="is-dup"><b>{fmtN(plan.counts.dup)}</b>already in the CRM</div>
                <div className="is-error"><b>{fmtN(plan.counts.error)}</b>with errors</div>
              </div>
              <div className="di-opts">
                <div className="di-opt"><label>Deals already in the CRM (same company and pipeline)</label>
                  <div className="di-seg"><button className={dupMode === "skip" ? "is-on" : ""} onClick={() => setDupMode("skip")}>Skip them</button><button className={dupMode === "import" ? "is-on" : ""} onClick={() => setDupMode("import")}>Import anyway</button></div>
                </div>
                <label className="di-check"><input type="checkbox" checked={createContacts} onChange={(e) => setCreateContacts(e.target.checked)} /><span />Create contacts that aren't in the CRM</label>
                <label className="di-check"><input type="checkbox" checked={markPassed} onChange={(e) => setMarkPassed(e.target.checked)} /><span />Mark the earlier phases as passed (reports and roles see where each deal got to)</label>
              </div>

              {plan.companies.length > 0 && (
                <section className="di-sec">
                  <div className="di-sec-h">
                    <h3>Companies</h3>
                    <span className="di-legend"><i className="is-crm" />In the CRM <b>{plan.companies.filter((c) => c.found).length}</b><i className="is-none" />Not found <b>{plan.companies.filter((c) => !c.found).length}</b></span>
                    <div className="di-seg is-small"><button className={coFilter === "missing" ? "is-on" : ""} onClick={() => setCoFilter("missing")}>Not found</button><button className={coFilter === "all" ? "is-on" : ""} onClick={() => setCoFilter("all")}>All</button></div>
                  </div>
                  <div className="di-links">
                    {plan.companies.filter((c) => coFilter === "all" || !c.found).slice(0, 200).map((c, i) => {
                      const ch = companyChoice[c.key] ?? (c.found ?? "create");
                      return (
                        <div key={c.key} className={`di-link is-${c.found ? "crm" : "none"}`} style={{ ["--j" as string]: Math.min(i, 20) } as CSSProperties}>
                          <span className="di-link-dot" />
                          <span className="di-link-name"><b>{c.name}</b><small>{c.count} {c.count === 1 ? "deal" : "deals"} · {c.found ? `found by ${c.foundBy === "vat" ? "VAT" : "name"}${companies.find((x) => `crm:${x.id}` === c.found)?.name !== c.name ? ` as ${companies.find((x) => `crm:${x.id}` === c.found)?.name}` : ""}` : "not in the CRM"}</small></span>
                          <SalesMultiFilter single values={[ch]} placeholder="Choose" searchFrom={8} onChange={(v) => v[0] && setCompanyChoice((m) => ({ ...m, [c.key]: v[0] }))}
                            options={[
                              ...(c.found ? [{ value: c.found, label: `✓ ${companies.find((x) => `crm:${x.id}` === c.found)?.name ?? c.name}` }] : [{ value: "create", label: `+ Create “${c.name}”` }]),
                              { value: "skip", label: "No company (contact only)" },
                              ...companies.filter((x) => `crm:${x.id}` !== c.found).map((x) => ({ value: `crm:${x.id}`, label: `Link to ${x.name}` })),
                            ]} />
                        </div>
                      );
                    })}
                    {plan.companies.filter((c) => coFilter === "all" || !c.found).length === 0 && <p className="di-muted">Every company is already in the CRM.</p>}
                  </div>
                </section>
              )}

              <section className="di-sec">
                <div className="di-sec-h">
                  <h3>Deals</h3>
                  <div className="di-seg is-tabs">
                    {([["all", "All", plan.rows.length], ["new", "To import", plan.counts.new], ["warn", "Warnings", plan.counts.warn], ["dup", "Already there", plan.counts.dup], ["error", "Errors", plan.counts.error]] as const).map(([k, l, n]) => (
                      <button key={k} className={`${tab === k ? "is-on" : ""} ${(k === "error" || k === "warn") && n ? "is-warn" : ""}`} onClick={() => setTab(k)}>{l}<i>{n}</i></button>
                    ))}
                  </div>
                </div>
                <div className="di-table">
                  <div className="di-tr is-head"><span>Row</span><span>Deal</span><span>Pipeline · phase</span><span>Owner</span><span>Value</span><span>Result</span></div>
                  {shown.map((r) => <DealRow key={r.idx} r={r} offset={rowOffset} pipeName={pipeName} phaseById={phaseById} personName={personName} />)}
                  {shown.length === 0 && <p className="di-muted di-pad">Nothing here.</p>}
                </div>
              </section>
            </div>
          )}

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
                    <div className="is-co"><b>{fmtN(result.coCreated)}</b>companies created</div>
                    <div className="is-ct"><b>{fmtN(result.ctCreated)}</b>contacts created</div>
                    <div className="is-error"><b>{fmtN(result.failed.length)}</b>not imported</div>
                  </div>
                  {result.newFields > 0 && <p>Also created {result.newFields} new deal {result.newFields === 1 ? "field" : "fields"}.</p>}
                  {runErr && <p className="di-err">{runErr}</p>}
                  {result.failed.length > 0 && (
                    <div className="di-failed">
                      {result.failed.slice(0, 8).map((f, i) => <span key={i}><b>{f.row ? `Row ${f.row}` : "—"}</b>{f.reason}</span>)}
                      {result.failed.length > 8 && <span><b>…</b>{result.failed.length - 8} more in the report</span>}
                      <button className="di-linkbtn" onClick={downloadErrors}>Download the error report (CSV)</button>
                    </div>
                  )}
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
              {step === "review" && plan && `${fmtN(plan.counts.new)} deals will be created${plan.counts.coNew ? `, with ${fmtN(plan.counts.coNew)} new companies` : ""}${plan.counts.ctNew ? ` and ${fmtN(plan.counts.ctNew)} new contacts` : ""}.`}
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
      {!wb && <button className="di-linkbtn" onClick={onTemplate}>Download a template with your deal fields</button>}
    </section>
  );
}

function DealRow({ r, offset, pipeName, phaseById, personName }: {
  r: PlanRow; offset: number; pipeName: (id: string | null) => string; phaseById: Map<string, Phase>; personName: (id: string | null) => string;
}) {
  const ph = r.phaseId ? phaseById.get(r.phaseId) : undefined;
  const reached = r.reachedPhaseId && r.reachedPhaseId !== r.phaseId ? phaseById.get(r.reachedPhaseId) : undefined;
  const refTag = (ref: string | null) => (ref?.startsWith("new:") ? <em className="is-new">new</em> : ref ? <em>found</em> : null);
  return (
    <div className={`di-tr is-${r.status} ${r.status === "new" && r.issues.length ? "has-warn" : ""}`}>
      <span className="di-rn">{r.idx + offset}</span>
      <span className="di-deal">
        <b>{r.companyLabel ?? r.contactLabel ?? "—"}{refTag(r.companyRef ?? r.contactRef)}</b>
        {r.companyLabel && r.contactLabel && <small>{r.contactLabel}{refTag(r.contactRef)}</small>}
        {r.title && <small className="di-title">{r.title}</small>}
      </span>
      <span className="di-where">
        <b>{pipeName(r.pipelineId)}</b>
        <small>{ph?.name ?? "—"}{reached ? ` · reached ${reached.name}` : ""}</small>
        <i className={`di-st is-${r.dealStatus}`}>{STATUS_LABEL[r.dealStatus] ?? r.dealStatus}</i>
      </span>
      <span className="di-owner">{r.owner ? <><span className="di-av">{initials(personName(r.owner))}</span>{personName(r.owner)}{r.team.length > 1 && <small>+{r.team.length - 1}</small>}</> : <span className="di-muted">No owner</span>}</span>
      <span className="di-val-n">{r.value != null ? eur(r.value) : "—"}</span>
      <span className="di-res">
        <span className={`di-pill is-${r.status}`}>{r.status === "new" ? "Import" : r.status === "dup" ? "Skip" : "Error"}</span>
        {(r.reason || r.issues.length > 0) && <small title={[r.reason, ...r.issues].filter(Boolean).join("\n")}>{r.reason ?? r.issues[0]}</small>}
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