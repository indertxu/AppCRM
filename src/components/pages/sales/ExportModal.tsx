/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Select from "../../framework/Select";
import { supabase } from "../../api/supabase";
import type { Company, Contact } from "../companies/companiesApi";
import type { Tracking } from "./salesApi";
import { downloadBlob, tableToCsv, tableToXlsx, type ExportCell, type ExportColumn } from "../../framework/exportFile";
import "./ExportModal.css";

/**
 * Export builder for the Sales overview.
 *
 * Every candidate row is a (deal, contact?, company?) triple:
 *  - "deals"     → one row per deal
 *  - "contacts"  → one row per contact of each deal (deal's contacts, the deal
 *                  company's contacts, or both); optionally merged per contact
 *  - "companies" → one row per deal company; optionally merged per company
 * Conditions are evaluated on those triples, so they can mix deal, contact and
 * company fields. Contact / company fields are discovered from the loaded data
 * (including `custom` jsonb), so new columns show up without code changes.
 */

type Kind = "text" | "number" | "money" | "percent" | "date" | "enum";
type Group = "deal" | "contact" | "company";
type RowMode = "deals" | "contacts" | "companies";
type Source = "deal" | "company" | "both";

interface Row { deal: Tracking; contact: Contact | null; company: Company | null }
interface Field { key: string; group: Group; label: string; kind: Kind; options?: string[]; sum?: boolean; get: (r: Row) => any }
interface Cond { id: string; field: string; op: string; a: string; b: string; vals: string[] }

export interface ExportHelpers {
  pipelineName: (id: string | null) => string;
  productName: (id: string | null) => string | null;
  phaseName: (t: Tracking) => string;
  phaseProbOf: (t: Tracking) => number | null;
  closeDateOf: (t: Tracking) => string | null;
}

interface Props {
  deals: Tracking[];
  contacts: Contact[];
  companies: Company[];
  employees: { id: string; name: string }[];
  trackAssignees: Record<string, string[]>;
  potentialTotals: Record<string, number>;
  pipelineNames: string[];
  productNames: string[];
  phaseNames: string[];
  helpers: ExportHelpers;
  onClose: () => void;
}

/* ─────────────── helpers ─────────────── */

const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const uid = () => Math.random().toString(36).slice(2, 10);
const isoDay = (v: any): string | null => (v ? String(v).slice(0, 10) : null);
const GROUP_LABEL: Record<Group, string> = { deal: "Deal", contact: "Contact", company: "Company" };
const STATUS_LABEL: Record<string, string> = { active: "Active", won: "Won", lost: "Lost", paused: "Paused" };

/** Accepts 15000 · 15.000 · 15,000 · 15.000,50 · 15000,5 · "15 000 €". */
function parseNum(raw: string): number | null {
  let s = (raw ?? "").replace(/[€%\s]/g, "");
  if (!s) return null;
  if (s.includes(".") && s.includes(",")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const OPS: Record<Kind, { value: string; label: string }[]> = {
  text: [{ value: "contains", label: "contains" }, { value: "not_contains", label: "doesn't contain" }, { value: "is_set", label: "is filled" }, { value: "is_empty", label: "is empty" }],
  enum: [{ value: "in", label: "is any of" }, { value: "not_in", label: "is none of" }, { value: "is_set", label: "is filled" }, { value: "is_empty", label: "is empty" }],
  number: [], money: [], percent: [],
  date: [{ value: "before", label: "before" }, { value: "on_or_before", label: "on or before" }, { value: "after", label: "after" }, { value: "on_or_after", label: "on or after" }, { value: "between", label: "between" }, { value: "is_set", label: "is filled" }, { value: "is_empty", label: "is empty" }],
};
OPS.number = OPS.money = OPS.percent = [
  { value: "gt", label: "greater than" }, { value: "gte", label: "at least" }, { value: "lt", label: "less than" }, { value: "lte", label: "at most" },
  { value: "eq", label: "equals" }, { value: "between", label: "between" }, { value: "is_set", label: "is filled" }, { value: "is_empty", label: "is empty" },
];
const DEFAULT_OP: Record<Kind, string> = { text: "contains", enum: "in", number: "gte", money: "between", percent: "gt", date: "before" };
const NO_VALUE = new Set(["is_set", "is_empty"]);

function condComplete(c: Cond, f: Field | undefined): boolean {
  if (!f) return false;
  if (NO_VALUE.has(c.op)) return true;
  if (f.kind === "enum") return c.vals.length > 0;
  if (f.kind === "date") return c.op === "between" ? !!c.a && !!c.b : !!c.a;
  if (f.kind === "text") return c.a.trim() !== "";
  return c.op === "between" ? parseNum(c.a) != null && parseNum(c.b) != null : parseNum(c.a) != null;
}

function condTest(c: Cond, f: Field, r: Row): boolean {
  const v = f.get(r);
  const empty = v == null || v === "";
  if (c.op === "is_empty") return empty;
  if (c.op === "is_set") return !empty;
  if (f.kind === "enum") { const s = empty ? "" : String(v); return c.op === "in" ? c.vals.includes(s) : !c.vals.includes(s); }
  if (f.kind === "text") {
    const has = !empty && norm(String(v)).includes(norm(c.a.trim()));
    return c.op === "contains" ? has : !has;
  }
  if (empty) return false;
  if (f.kind === "date") {
    const d = String(v).slice(0, 10);
    switch (c.op) {
      case "before": return d < c.a;
      case "on_or_before": return d <= c.a;
      case "after": return d > c.a;
      case "on_or_after": return d >= c.a;
      case "between": { const [lo, hi] = c.a <= c.b ? [c.a, c.b] : [c.b, c.a]; return d >= lo && d <= hi; }
    }
    return true;
  }
  const n = Number(v), a = parseNum(c.a) as number, b = parseNum(c.b) as number;
  switch (c.op) {
    case "gt": return n > a;
    case "gte": return n >= a;
    case "lt": return n < a;
    case "lte": return n <= a;
    case "eq": return n === a;
    case "between": return n >= Math.min(a, b) && n <= Math.max(a, b);
  }
  return true;
}

/* ─────────────── field discovery for contacts / companies ─────────────── */

const SKIP = new Set(["id", "tenant_id", "custom", "prefs", "contactIds"]);
const KNOWN: Record<string, string> = {
  first_name: "First name", last_name: "Last name", name: "Name", email: "Email", phone: "Phone", mobile: "Mobile",
  job_title: "Job title", position: "Position", title: "Title", linkedin: "LinkedIn", website: "Website", web: "Website",
  vat: "VAT", tax_id: "Tax ID", city: "City", country: "Country", address: "Address", industry: "Industry",
  notes: "Notes", created_at: "Created", updated_at: "Updated",
};
const PRIORITY = ["name", "first_name", "last_name", "email", "phone", "mobile", "job_title", "position", "title"];
const humanize = (k: string) => KNOWN[k] ?? k.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function cleanVal(v: any) {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.join(", ");
  return v;
}
function guessKind(vals: any[]): { kind: Kind; options?: string[] } {
  const nn = vals.filter((v) => v != null && v !== "");
  if (!nn.length) return { kind: "text" };
  if (nn.every((v) => typeof v === "boolean")) return { kind: "enum", options: ["Yes", "No"] };
  if (nn.every((v) => typeof v === "number")) return { kind: "number" };
  if (nn.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v))) return { kind: "date" };
  return { kind: "text" };
}

function discover(rows: any[], group: Group, pick: (r: Row) => any, labels: Record<string, string>): Field[] {
  const plain = new Map<string, any[]>(), custom = new Map<string, any[]>();
  const push = (m: Map<string, any[]>, k: string, v: any) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(v); };
  for (const r of rows) {
    for (const [k, v] of Object.entries(r ?? {})) {
      if (SKIP.has(k) || k.endsWith("_id")) continue;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) continue;
      push(plain, k, v);
    }
    const cu = (r as any)?.custom;
    if (cu && typeof cu === "object") for (const [k, v] of Object.entries(cu)) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) continue;
      push(custom, k, v);
    }
  }
  const rank = (k: string) => { const i = PRIORITY.indexOf(k); return i >= 0 ? i : k.endsWith("_at") ? 900 : 100; };
  const out: Field[] = [...plain.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((k) => ({
    key: `${group}.${k}`, group, label: humanize(k), ...guessKind(plain.get(k)!),
    get: (r: Row) => cleanVal(pick(r)?.[k]),
  }));
  for (const k of [...custom.keys()].sort()) out.push({
    key: `${group}.custom.${k}`, group, label: labels[k] ?? humanize(k), ...guessKind(custom.get(k)!),
    get: (r: Row) => cleanVal(pick(r)?.custom?.[k]),
  });
  return out;
}

async function loadFieldLabels(table: string): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.from(table).select("*");
    const map: Record<string, string> = {};
    (data ?? []).forEach((f: any) => {
      const label = f.label ?? f.name ?? f.title;
      if (!label) return;
      [f.key, f.id, f.slug, f.name].filter(Boolean).forEach((k: string) => { map[k] = label; });
    });
    return map;
  } catch { return {}; }
}

/* ─────────────── formatting ─────────────── */

const fmtMoney = (n: number) => `${n.toLocaleString("es-ES", { maximumFractionDigits: 2 })} €`;
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
function toCell(f: Field, v: any): ExportCell {
  if (v == null || v === "") return null;
  if (f.kind === "date") { const d = isoDay(v); return d ? { date: d } : null; }
  if (f.kind === "money" || f.kind === "number" || f.kind === "percent") { const n = Number(v); return Number.isFinite(n) ? n : String(v); }
  return String(v);
}
function showCell(f: Field, c: ExportCell): string {
  if (c == null) return "";
  if (typeof c === "object") return fmtDate(c.date);
  if (typeof c === "number") return f.kind === "money" ? fmtMoney(c) : f.kind === "percent" ? `${c}%` : c.toLocaleString("es-ES");
  return c;
}
const exportFormat = (k: Kind): ExportColumn["format"] => (k === "money" ? "money" : k === "date" ? "date" : k === "percent" ? "percent" : k === "number" ? "number" : "text");

/* ─────────────── last config survives closing the modal ─────────────── */

interface Config { mode: RowMode; source: Source; merge: boolean; match: "all" | "any"; conds: Cond[]; cols: string[]; format: "xlsx" | "csv"; touchedCols: boolean }
let lastConfig: Config | null = null;

const DEFAULT_COLS: Record<RowMode, string[]> = {
  deals: ["deal.company", "deal.phase", "deal.revenue", "deal.close", "deal.mgr_prob"],
  contacts: ["contact.name", "contact.email", "contact.phone", "contact.company"],
  companies: ["company.name", "deal.count", "deal.revenue"],
};

/* ─────────────── component ─────────────── */

export default function ExportModal(p: Props) {
  const { deals, contacts, companies, employees, trackAssignees, potentialTotals, helpers } = p;

  const [mode, setMode] = useState<RowMode>(lastConfig?.mode ?? "contacts");
  const [source, setSource] = useState<Source>(lastConfig?.source ?? "both");
  const [merge, setMerge] = useState(lastConfig?.merge ?? true);
  const [match, setMatch] = useState<"all" | "any">(lastConfig?.match ?? "all");
  const [conds, setConds] = useState<Cond[]>(lastConfig?.conds ?? []);
  const [cols, setCols] = useState<string[]>(lastConfig?.cols ?? DEFAULT_COLS.contacts);
  const [touchedCols, setTouchedCols] = useState(lastConfig?.touchedCols ?? false);
  const [format, setFormat] = useState<"xlsx" | "csv">(lastConfig?.format ?? "xlsx");
  const [fileName, setFileName] = useState(`sales-export-${new Date().toISOString().slice(0, 10)}`);
  const [colQ, setColQ] = useState("");
  const [contactLabels, setContactLabels] = useState<Record<string, string>>({});
  const [companyLabels, setCompanyLabels] = useState<Record<string, string>>({});
  const dragKey = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  useEffect(() => { lastConfig = { mode, source, merge, match, conds, cols, format, touchedCols }; }, [mode, source, merge, match, conds, cols, format, touchedCols]);
  useEffect(() => {
    loadFieldLabels("contact_fields").then(setContactLabels);
    loadFieldLabels("company_fields").then(setCompanyLabels);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const companyById = useMemo(() => new Map(companies.map((c) => [c.id as string, c])), [companies]);
  /**
   * A contact's own company, however the link is stored on the contact:
   * company_id, companyId, company (id, name or object), company_ids / companies
   * (arrays). Returns the company id when it matches a known company, otherwise
   * a plain company name if that's all the contact has.
   */
  const contactCompany = useMemo(() => {
    const byName = new Map(companies.map((c: any) => [norm(c.name ?? ""), c.id as string]));
    const pick = (v: any): { id: string | null; name: string | null } | null => {
      if (v == null || v === "") return null;
      if (Array.isArray(v)) { for (const x of v) { const r = pick(x); if (r) return r; } return null; }
      if (typeof v === "object") return pick(v.id ?? v.company_id ?? v.name);
      const sv = String(v);
      if (companyById.has(sv)) return { id: sv, name: null };
      const idByName = byName.get(norm(sv));
      if (idByName) return { id: idByName, name: null };
      return /^[0-9a-f-]{36}$/i.test(sv) ? null : { id: null, name: sv };
    };
    return (c: any): { id: string | null; name: string | null } | null => {
      if (!c) return null;
      const keys = Object.keys(c).filter((k) => /compan/i.test(k))
        .sort((a, b) => (/_?id$/i.test(b) ? 1 : 0) - (/_?id$/i.test(a) ? 1 : 0));
      for (const k of keys) { const r = pick(c[k]); if (r) return r; }
      return null;
    };
  }, [companies, companyById]);
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id as string, c])), [contacts]);
  const contactsByCompany = useMemo(() => {
    const m = new Map<string, Contact[]>();
    contacts.forEach((c: any) => {
      const id = contactCompany(c)?.id;
      if (id) { if (!m.has(id)) m.set(id, []); m.get(id)!.push(c); }
    });
    return m;
  }, [contacts, contactCompany]);
  const empName = useMemo(() => new Map(employees.map((e) => [e.id, e.name])), [employees]);

  /* all fields, by group */
  const fields = useMemo<Field[]>(() => {
    const deal: Field[] = [
      { key: "deal.company", group: "deal", label: "Company", kind: "text", get: (r) => (r.deal.company_id ? (companyById.get(r.deal.company_id) as any)?.name ?? null : null) },
      { key: "deal.status", group: "deal", label: "Status", kind: "enum", options: Object.values(STATUS_LABEL), get: (r) => STATUS_LABEL[r.deal.status as string] ?? r.deal.status },
      { key: "deal.pipeline", group: "deal", label: "Pipeline", kind: "enum", options: p.pipelineNames, get: (r) => helpers.pipelineName(r.deal.pipeline_id) },
      { key: "deal.phase", group: "deal", label: "Phase", kind: "enum", options: p.phaseNames, get: (r) => { const n = helpers.phaseName(r.deal); return n === "—" ? null : n; } },
      { key: "deal.product", group: "deal", label: "Product", kind: "enum", options: p.productNames, get: (r) => helpers.productName(r.deal.product_id) },
      { key: "deal.revenue", group: "deal", label: "Potential revenue", kind: "money", sum: true, get: (r) => potentialTotals[r.deal.id as string] ?? null },
      { key: "deal.close", group: "deal", label: "Est. close date", kind: "date", get: (r) => isoDay(helpers.closeDateOf(r.deal)) },
      { key: "deal.rep_close_date", group: "deal", label: "Sales close date", kind: "date", get: (r) => isoDay(r.deal.rep_close_date) },
      { key: "deal.mgr_close_date", group: "deal", label: "Management close date", kind: "date", get: (r) => isoDay(r.deal.mgr_close_date) },
      { key: "deal.phase_prob", group: "deal", label: "Phase probability", kind: "percent", get: (r) => helpers.phaseProbOf(r.deal) },
      { key: "deal.rep_prob", group: "deal", label: "Sales close probability", kind: "percent", get: (r) => r.deal.rep_close_prob ?? null },
      { key: "deal.mgr_prob", group: "deal", label: "Management close probability", kind: "percent", get: (r) => r.deal.mgr_close_prob ?? null },
      { key: "deal.team", group: "deal", label: "Sales team", kind: "text", get: (r) => (trackAssignees[r.deal.id as string] ?? []).map((id) => empName.get(id) ?? "").filter(Boolean).join(", ") || null },
      { key: "deal.contacts", group: "deal", label: "Contacts on deal", kind: "number", get: (r) => r.deal.contactIds.length },
      { key: "deal.count", group: "deal", label: "Number of deals", kind: "number", sum: true, get: () => 1 },
      { key: "deal.created", group: "deal", label: "Deal created", kind: "date", get: (r) => isoDay(r.deal.created_at) },
    ];
    const contact: Field[] = [
      { key: "contact.name", group: "contact", label: "Full name", kind: "text", get: (r) => (r.contact ? [(r.contact as any).first_name, (r.contact as any).last_name].filter(Boolean).join(" ") || null : null) },
      ...discover(contacts, "contact", (r) => r.contact, contactLabels).filter((f) => !/compan/i.test(f.key)),
      { key: "contact.company", group: "contact", label: "Company", kind: "text", get: (r) => { const cc = contactCompany(r.contact); return cc ? (cc.id ? (companyById.get(cc.id) as any)?.name ?? null : cc.name) : null; } },
    ];
    const company = discover(companies, "company", (r) => r.company, companyLabels);
    return [...deal, ...contact, ...company];
  }, [companies, contacts, companyById, contactCompany, contactLabels, companyLabels, employees, empName, trackAssignees, potentialTotals, helpers, p.pipelineNames, p.phaseNames, p.productNames]);

  const available = useMemo(() => fields.filter((f) => (mode === "contacts" ? true : f.group !== "contact")), [fields, mode]);
  const fieldByKey = useMemo(() => new Map(available.map((f) => [f.key, f])), [available]);

  /* switching row type: drop contact columns/conditions that no longer apply, refresh defaults if untouched */
  const changeMode = (m: RowMode) => {
    setMode(m);
    if (!touchedCols) setCols(DEFAULT_COLS[m]);
    else if (m !== "contacts") setCols((cs) => cs.filter((k) => !k.startsWith("contact.")));
    if (m !== "contacts") setConds((cs) => cs.filter((c) => !c.field.startsWith("contact.")));
  };

  /* rows */
  const baseRows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const t of deals) {
      const company = t.company_id ? companyById.get(t.company_id) ?? null : null;
      if (mode === "deals") out.push({ deal: t, contact: null, company });
      else if (mode === "companies") { if (company) out.push({ deal: t, contact: null, company }); }
      else {
        const ids = new Set<string>();
        if (source !== "company") t.contactIds.forEach((id) => ids.add(id));
        if (source !== "deal" && t.company_id) (contactsByCompany.get(t.company_id) ?? []).forEach((c) => ids.add(c.id as string));
        ids.forEach((id) => { const c = contactById.get(id); if (c) out.push({ deal: t, contact: c, company }); });
      }
    }
    return out;
  }, [deals, mode, source, companyById, contactById, contactsByCompany]);

  const activeConds = conds.filter((c) => condComplete(c, fieldByKey.get(c.field)));
  const matched = useMemo(() => {
    if (!activeConds.length) return baseRows;
    return baseRows.filter((r) => {
      const res = activeConds.map((c) => condTest(c, fieldByKey.get(c.field)!, r));
      return match === "all" ? res.every(Boolean) : res.some(Boolean);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRows, conds, match, fieldByKey]);

  const colFields = cols.map((k) => fieldByKey.get(k)).filter((f): f is Field => !!f);

  const table = useMemo(() => {
    const columns: ExportColumn[] = colFields.map((f) => ({ label: f.kind === "percent" ? `${f.label} (%)` : f.label, format: exportFormat(f.kind) }));
    const doMerge = mode !== "deals" && merge;
    const groups = new Map<string, Row[]>();
    matched.forEach((r, i) => {
      const k = !doMerge ? String(i) : mode === "contacts" ? (r.contact?.id as string) : (r.company?.id as string);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    });
    const rows: ExportCell[][] = [];
    groups.forEach((rs) => {
      rows.push(colFields.map((f) => {
        if (rs.length === 1) return toCell(f, f.get(rs[0]));
        if (f.sum) {
          // Merged rows: add up revenue / deal count, counting each deal once.
          const seen = new Set<string>();
          let total = 0, any = false;
          rs.forEach((r) => { const id = r.deal.id as string; if (seen.has(id)) return; seen.add(id); const n = Number(f.get(r)); if (Number.isFinite(n) && f.get(r) != null) { total += n; any = true; } });
          return any ? total : null;
        }
        const cells = rs.map((r) => toCell(f, f.get(r))).filter((c) => c != null);
        const distinct = new Map<string, ExportCell>();
        cells.forEach((c) => distinct.set(typeof c === "object" ? (c as any).date : String(c), c));
        if (distinct.size <= 1) return [...distinct.values()][0] ?? null;
        return [...distinct.values()].map((c) => showCell(f, c)).join("; ");
      }));
    });
    return { columns, rows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matched, cols, fieldByKey, mode, merge]);

  const dealCount = useMemo(() => new Set(matched.map((r) => r.deal.id)).size, [matched]);

  /* conditions editing */
  const addCond = () => {
    const f = available.find((x) => x.key === "deal.phase") ?? available[0];
    setConds((cs) => [...cs, { id: uid(), field: f.key, op: DEFAULT_OP[f.kind], a: "", b: "", vals: [] }]);
  };
  const patchCond = (id: string, patch: Partial<Cond>) => setConds((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const changeField = (id: string, key: string) => {
    const f = fieldByKey.get(key);
    if (f) patchCond(id, { field: key, op: DEFAULT_OP[f.kind], a: "", b: "", vals: [] });
  };

  /* columns editing */
  const toggleCol = (k: string) => { setTouchedCols(true); setCols((cs) => (cs.includes(k) ? cs.filter((x) => x !== k) : [...cs, k])); };
  const dropOn = (target: string) => {
    const from = dragKey.current;
    dragKey.current = null; setDragOver(null);
    if (!from || from === target) return;
    setTouchedCols(true);
    setCols((cs) => { const next = cs.filter((x) => x !== from); next.splice(next.indexOf(target), 0, from); return next; });
  };

  const doExport = () => {
    if (!table.columns.length || !table.rows.length) return;
    const base = (fileName.trim() || "sales-export").replace(/[\\/:*?"<>|]+/g, "-").replace(/\.(xlsx|csv)$/i, "");
    const blob = format === "xlsx" ? tableToXlsx(table, "Export") : tableToCsv(table);
    downloadBlob(blob, `${base}.${format}`);
  };

  const fieldOptions = available.map((f) => ({ value: f.key, label: `${GROUP_LABEL[f.group]} · ${f.label}` }));
  const colGroups: Group[] = mode === "contacts" ? ["contact", "deal", "company"] : ["deal", "company"];
  const nq = norm(colQ.trim());

  return createPortal(
    <div className="xp-backdrop">
      <div className="xp" role="dialog" aria-label="Export">
        <header className="xp-head">
          <div>
            <h2 className="xp-title">Export</h2>
            <p className="xp-sub">Pick what each row is, narrow it down, choose the columns.</p>
          </div>
          <button className="xp-x" onClick={p.onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <div className="xp-body">
          <div className="xp-grid">
            {/* ── left: rows + conditions ── */}
            <div className="xp-col">
              <section className="xp-sec">
                <h3 className="xp-h">Each row is</h3>
                <div className="xp-seg">
                  {(["contacts", "deals", "companies"] as RowMode[]).map((m) => (
                    <button key={m} className={mode === m ? "is-on" : ""} onClick={() => changeMode(m)}>
                      {m === "contacts" ? "A contact" : m === "deals" ? "A deal" : "A company"}
                    </button>
                  ))}
                </div>
                {mode === "contacts" && (
                  <div className="xp-sub-opts">
                    <span className="xp-lbl">Contacts from</span>
                    <div className="xp-seg xp-seg-sm">
                      <button className={source === "deal" ? "is-on" : ""} onClick={() => setSource("deal")}>The deal</button>
                      <button className={source === "company" ? "is-on" : ""} onClick={() => setSource("company")}>The deal's company</button>
                      <button className={source === "both" ? "is-on" : ""} onClick={() => setSource("both")}>Both</button>
                    </div>
                  </div>
                )}
                {mode !== "deals" && (
                  <label className="xp-check">
                    <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />
                    <span className="xp-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg></span>
                    One row per {mode === "contacts" ? "contact" : "company"}, even if it's in several deals
                  </label>
                )}
              </section>

              <section className="xp-sec">
                <div className="xp-h-row">
                  <h3 className="xp-h">Conditions</h3>
                  {conds.length > 1 && (
                    <div className="xp-seg xp-seg-sm">
                      <button className={match === "all" ? "is-on" : ""} onClick={() => setMatch("all")}>Match all</button>
                      <button className={match === "any" ? "is-on" : ""} onClick={() => setMatch("any")}>Match any</button>
                    </div>
                  )}
                </div>
                {conds.length === 0 && <p className="xp-empty">No conditions — every deal you can see is included.</p>}
                <div className="xp-conds">
                  {conds.map((c) => {
                    const f = fieldByKey.get(c.field);
                    if (!f) return null;
                    const ok = condComplete(c, f);
                    const needsVal = !NO_VALUE.has(c.op);
                    const inputType = f.kind === "date" ? "date" : "text";
                    const ph = f.kind === "money" ? "€" : f.kind === "percent" ? "%" : f.kind === "text" ? "Text" : "";
                    return (
                      <div key={c.id} className={`xp-cond ${ok ? "" : "is-incomplete"}`}>
                        <div className="xp-cond-line">
                          <div className="xp-sel xp-sel-field"><Select value={c.field} onChange={(v) => changeField(c.id, v)} options={fieldOptions} placeholder="Field" /></div>
                          <div className="xp-sel xp-sel-op"><Select value={c.op} onChange={(v) => patchCond(c.id, { op: v })} options={OPS[f.kind]} placeholder="Condition" /></div>
                          {needsVal && f.kind !== "enum" && (
                            <div className="xp-vals">
                              <input className="xp-in" type={inputType} inputMode={f.kind === "text" || f.kind === "date" ? undefined : "decimal"}
                                value={c.a} placeholder={ph} onChange={(e) => patchCond(c.id, { a: e.target.value })} />
                              {c.op === "between" && <>
                                <span className="xp-and">and</span>
                                <input className="xp-in" type={inputType} inputMode={f.kind === "date" ? undefined : "decimal"}
                                  value={c.b} placeholder={ph} onChange={(e) => patchCond(c.id, { b: e.target.value })} />
                              </>}
                            </div>
                          )}
                          <button className="xp-del" onClick={() => setConds((cs) => cs.filter((x) => x.id !== c.id))} aria-label="Remove condition">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                          </button>
                        </div>
                        {needsVal && f.kind === "enum" && (
                          <div className="xp-chips">
                            {(f.options ?? []).length === 0 && <span className="xp-empty">No values available.</span>}
                            {(f.options ?? []).map((o) => {
                              const on = c.vals.includes(o);
                              return (
                                <button key={o} className={`xp-chip ${on ? "is-on" : ""}`}
                                  onClick={() => patchCond(c.id, { vals: on ? c.vals.filter((x) => x !== o) : [...c.vals, o] })}>{o}</button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button className="xp-add" onClick={addCond}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  Add condition
                </button>
              </section>
            </div>

            {/* ── right: columns ── */}
            <div className="xp-col">
              <section className="xp-sec">
                <div className="xp-h-row">
                  <h3 className="xp-h">Columns <span className="xp-count">{colFields.length}</span></h3>
                  {colFields.length > 0 && <button className="xp-link" onClick={() => { setTouchedCols(true); setCols([]); }}>Clear</button>}
                </div>
                <div className="xp-picked">
                  {colFields.length === 0 && <span className="xp-empty">Pick at least one column below.</span>}
                  {colFields.map((f) => (
                    <span key={f.key} draggable
                      className={`xp-pill ${dragOver === f.key ? "is-over" : ""}`}
                      onDragStart={() => { dragKey.current = f.key; }}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(f.key); }}
                      onDragLeave={() => setDragOver((d) => (d === f.key ? null : d))}
                      onDrop={() => dropOn(f.key)}
                      onDragEnd={() => { dragKey.current = null; setDragOver(null); }}>
                      <svg className="xp-grip" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
                      <em>{GROUP_LABEL[f.group]}</em>{f.label}
                      <button onClick={() => toggleCol(f.key)} aria-label={`Remove ${f.label}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                      </button>
                    </span>
                  ))}
                </div>
                <div className="xp-colsearch">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                  <input value={colQ} onChange={(e) => setColQ(e.target.value)} placeholder="Find a field…" />
                </div>
                <div className="xp-fieldlist">
                  {colGroups.map((g) => {
                    const fs = available.filter((f) => f.group === g && (!nq || norm(f.label).includes(nq)));
                    if (!fs.length) return null;
                    return (
                      <div key={g} className="xp-fgroup">
                        <div className="xp-fgroup-h">{g === "company" && mode === "contacts" ? "Company (of the deal)" : GROUP_LABEL[g]}</div>
                        <div className="xp-chips">
                          {fs.map((f) => (
                            <button key={f.key} className={`xp-chip ${cols.includes(f.key) ? "is-on" : ""}`} onClick={() => toggleCol(f.key)}>{f.label}</button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>

          {/* ── preview ── */}
          <section className="xp-sec xp-prev-sec">
            <div className="xp-h-row">
              <h3 className="xp-h">Preview</h3>
              <span className="xp-meta"><b>{table.rows.length}</b> {table.rows.length === 1 ? "row" : "rows"} · from {dealCount} {dealCount === 1 ? "deal" : "deals"}</span>
            </div>
            {colFields.length === 0 ? <p className="xp-empty">Choose columns to see a preview.</p>
              : table.rows.length === 0 ? <p className="xp-empty">Nothing matches these conditions.</p>
              : (
                <div className="xp-table-wrap">
                  <table className="xp-table">
                    <thead><tr>{table.columns.map((c, i) => <th key={i}>{c.label}</th>)}</tr></thead>
                    <tbody>
                      {table.rows.slice(0, 8).map((r, ri) => (
                        <tr key={ri}>{r.map((c, ci) => <td key={ci} className={typeof c === "number" ? "is-num" : ""}>{showCell(colFields[ci], c)}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                  {table.rows.length > 8 && <div className="xp-more">+ {table.rows.length - 8} more</div>}
                </div>
              )}
          </section>
        </div>

        <footer className="xp-foot">
          <div className="xp-seg xp-seg-sm">
            <button className={format === "xlsx" ? "is-on" : ""} onClick={() => setFormat("xlsx")}>Excel</button>
            <button className={format === "csv" ? "is-on" : ""} onClick={() => setFormat("csv")}>CSV</button>
          </div>
          <div className="xp-fname">
            <input value={fileName} onChange={(e) => setFileName(e.target.value)} aria-label="File name" />
            <span>.{format}</span>
          </div>
          <button className="xp-cancel" onClick={p.onClose}>Cancel</button>
          <button className="xp-go" disabled={!colFields.length || !table.rows.length} onClick={doExport}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            Export {table.rows.length > 0 ? table.rows.length : ""} {table.rows.length === 1 ? "row" : "rows"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}