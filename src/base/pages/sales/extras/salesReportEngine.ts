/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../../../components/api/supabase";
import type { Company, Contact } from "../../companies/companiesApi";
import type { Tracking } from "../sales/salesApi";
import type { TrackingField } from "./trackingFieldsApi";

/**
 * Data engine behind the in-app Sales report builder.
 * Same model as the Export builder — every candidate row is a (deal, contact?,
 * company?) triple, fields are discovered from the data (incl. `custom`), and
 * conditions can mix deal / contact / company fields — plus computed deal
 * fields (weighted revenue, owner, days to close…) and chart aggregation.
 */

export type Kind = "text" | "number" | "money" | "percent" | "date" | "enum";
export type Group = "deal" | "contact" | "company" | "client" | "project" | "contract" | "agreement" | "invoice" | "ticket";
export type RowMode = "deals" | "contacts" | "companies";
export type Source = "deal" | "company" | "both";
export type ProbSource = "phase" | "rep" | "mgr" | "avg";

export interface Row { deal: Tracking; contact: Contact | null; company: Company | null }
export interface Field {
  key: string; group: Group; label: string; kind: Kind; options?: string[]; sum?: boolean; get: (r: Row) => any;
  /** Multiple-choice fields: the picked values, so "is any of" matches any of them. */
  list?: (r: Row) => string[];
  /** Values that mean "dropped out" (a lost phase): a funnel shows them apart, not as a step. */
  lost?: string[];
}
export interface Cond { id: string; field: string; op: string; a: string; b: string; vals: string[] }

export const GROUP_LABEL: Record<Group, string> = { deal: "Deal", contact: "Contact", company: "Company", client: "Client", project: "Project", contract: "Signed product", agreement: "Contract", invoice: "Invoice", ticket: "Ticket / task" };
export const STATUS_LABEL: Record<string, string> = { active: "Active", won: "Won", lost: "Lost", paused: "Hold" };

export const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export const uid = () => Math.random().toString(36).slice(2, 10);
/** The day of a date / timestamp ("2026-03-04…"); anything else is no date. */
export const isoDay = (v: any): string | null => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 864e5);

/* ─────────────── relative time periods ─────────────── */

export type PeriodKey =
  | "all" | "past" | "future" | "today"
  | "this_week" | "last_week" | "next_week"
  | "this_month" | "last_month" | "next_month"
  | "this_quarter" | "last_quarter" | "next_quarter"
  | "this_year" | "last_year" | "next_year" | "ytd"
  | "last_30" | "last_90" | "next_30" | "next_90" | "custom";
export const PERIODS: { key: PeriodKey; label: string; group: string }[] = [
  { key: "all", label: "All time", group: "Any" },
  { key: "this_month", label: "This month", group: "Months" }, { key: "next_month", label: "Next month", group: "Months" }, { key: "last_month", label: "Last month", group: "Months" },
  { key: "this_quarter", label: "This quarter", group: "Quarters" }, { key: "next_quarter", label: "Next quarter", group: "Quarters" }, { key: "last_quarter", label: "Last quarter", group: "Quarters" },
  { key: "this_year", label: "This year", group: "Years" }, { key: "next_year", label: "Next year", group: "Years" }, { key: "last_year", label: "Last year", group: "Years" }, { key: "ytd", label: "Year to date", group: "Years" },
  { key: "this_week", label: "This week", group: "Weeks" }, { key: "next_week", label: "Next week", group: "Weeks" }, { key: "last_week", label: "Last week", group: "Weeks" },
  { key: "next_30", label: "Next 30 days", group: "Rolling" }, { key: "next_90", label: "Next 90 days", group: "Rolling" }, { key: "last_30", label: "Last 30 days", group: "Rolling" }, { key: "last_90", label: "Last 90 days", group: "Rolling" },
  { key: "today", label: "Today", group: "Rolling" }, { key: "past", label: "Before today (overdue)", group: "Open-ended" }, { key: "future", label: "From today on", group: "Open-ended" },
  { key: "custom", label: "Custom dates", group: "Custom" },
];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ─────────────── the report's period (a parameter) ───────────────
   One period per report ("This year", "Q3", two dates…). The figures that depend on a
   period — ARR in the period, revenue in the period, what happened in it (new, renewed…) —
   and any rule set to "the report's period" read it, so changing it re-runs the whole report. */
export interface ReportPeriod { key: string; from?: string | null; to?: string | null }
export const DEFAULT_REPORT_PERIOD: ReportPeriod = { key: "this_year" };
let PARAM: ReportPeriod = DEFAULT_REPORT_PERIOD;
/** Set by the Reports page before it reads any row. */
export const setReportPeriod = (p?: ReportPeriod | null) => { PARAM = p?.key && p.key !== "report" ? p : DEFAULT_REPORT_PERIOD; };
export const reportPeriodNow = () => PARAM;
/** The report's period as [from, to] (null = open on that side). */
export const reportRange = (): [string | null, string | null] => resolvePeriod(PARAM.key, PARAM.from, PARAM.to);
/**
 * [from, to] inclusive ISO dates for a period, computed against TODAY — so a
 * saved report on "This quarter" always shows the current quarter. null = open side.
 */
export function resolvePeriod(key: string, from?: string | null, to?: string | null): [string | null, string | null] {
  const n = new Date(); const y = n.getFullYear(), m = n.getMonth(), d = n.getDate();
  const q = Math.floor(m / 3) * 3;
  const wd = (n.getDay() + 6) % 7; // Monday = 0
  const day = (off: number) => iso(new Date(y, m, d + off));
  switch (key) {
    case "today": return [day(0), day(0)];
    case "past": return [null, day(-1)];
    case "future": return [day(0), null];
    case "this_week": return [day(-wd), day(6 - wd)];
    case "last_week": return [day(-wd - 7), day(-wd - 1)];
    case "next_week": return [day(7 - wd), day(13 - wd)];
    case "this_month": return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
    case "last_month": return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case "next_month": return [iso(new Date(y, m + 1, 1)), iso(new Date(y, m + 2, 0))];
    case "this_quarter": return [iso(new Date(y, q, 1)), iso(new Date(y, q + 3, 0))];
    case "last_quarter": return [iso(new Date(y, q - 3, 1)), iso(new Date(y, q, 0))];
    case "next_quarter": return [iso(new Date(y, q + 3, 1)), iso(new Date(y, q + 6, 0))];
    case "this_year": return [`${y}-01-01`, `${y}-12-31`];
    case "last_year": return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case "next_year": return [`${y + 1}-01-01`, `${y + 1}-12-31`];
    case "ytd": return [`${y}-01-01`, day(0)];
    case "last_30": return [day(-30), day(0)];
    case "last_90": return [day(-90), day(0)];
    case "next_30": return [day(0), day(30)];
    case "next_90": return [day(0), day(90)];
    case "custom": return [from || null, to || null];
    case "report": return reportRange();
    default: return [null, null];
  }
}
export const inPeriod = (date: string | null | undefined, key: string, from?: string | null, to?: string | null) => {
  if (key === "all") return true;
  if (!date) return false;
  const v = String(date).slice(0, 10);
  const [lo, hi] = resolvePeriod(key, from, to);
  return (!lo || v >= lo) && (!hi || v <= hi);
};
export const periodLabel = (key: string) => (key === "report" ? "The report's period" : PERIODS.find((p) => p.key === key)?.label ?? key);
export const prettyRange = (key: string, from?: string | null, to?: string | null) => {
  const [lo, hi] = resolvePeriod(key, from, to);
  const f = (x: string) => { const [yy, mm, dd] = x.split("-").map(Number); return new Date(yy, mm - 1, dd).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };
  if (!lo && !hi) return "any date";
  if (lo && hi) return lo === hi ? f(lo) : `${f(lo)} – ${f(hi)}`;
  return lo ? `from ${f(lo)}` : `until ${f(hi!)}`;
};

/* ─────────────── numbers & conditions ─────────────── */

/** Accepts 15000 · 15.000 · 15,000 · 15.000,50 · 15000,5 · "15 000 €". */
export function parseNum(raw: string): number | null {
  let s = (raw ?? "").replace(/[€%\s]/g, "");
  if (!s) return null;
  if (s.includes(".") && s.includes(",")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const OPS: Record<Kind, { value: string; label: string }[]> = {
  text: [{ value: "in", label: "is any of" }, { value: "not_in", label: "is none of" }, { value: "contains", label: "contains" }, { value: "not_contains", label: "doesn't contain" }, { value: "is_set", label: "is filled" }, { value: "is_empty", label: "is empty" }],
  enum: [{ value: "in", label: "is any of" }, { value: "not_in", label: "is none of" }, { value: "is_set", label: "is filled" }, { value: "is_empty", label: "is empty" }],
  number: [], money: [], percent: [],
  date: [{ value: "in_period", label: "is in period" }, { value: "before", label: "before" }, { value: "on_or_before", label: "on or before" }, { value: "after", label: "after" }, { value: "on_or_after", label: "on or after" }, { value: "between", label: "between" }, { value: "is_set", label: "is filled" }, { value: "is_empty", label: "is empty" }],
};
OPS.number = OPS.money = OPS.percent = [
  { value: "gt", label: "greater than" }, { value: "gte", label: "at least" }, { value: "lt", label: "less than" }, { value: "lte", label: "at most" },
  { value: "eq", label: "equals" }, { value: "between", label: "between" }, { value: "is_set", label: "is filled" }, { value: "is_empty", label: "is empty" },
];
export const DEFAULT_OP: Record<Kind, string> = { text: "contains", enum: "in", number: "gte", money: "between", percent: "gt", date: "in_period" };
export const NO_VALUE = new Set(["is_set", "is_empty"]);

export function condComplete(c: Cond, f: Field | undefined): boolean {
  if (!f) return false;
  if (NO_VALUE.has(c.op)) return true;
  if (f.kind === "enum" || (f.kind === "text" && (c.op === "in" || c.op === "not_in"))) return c.vals.length > 0;
  if (f.kind === "date") return c.op === "in_period" ? !!c.a && c.a !== "all" : c.op === "between" ? !!c.a && !!c.b : !!c.a;
  if (f.kind === "text") return c.a.trim() !== "";
  return c.op === "between" ? parseNum(c.a) != null && parseNum(c.b) != null : parseNum(c.a) != null;
}

export function condTest(c: Cond, f: Field, r: Row): boolean {
  const v = f.get(r);
  const empty = v == null || v === "";
  if (c.op === "is_empty") return empty;
  if (c.op === "is_set") return !empty;
  if (f.kind === "enum" && f.list) { const hit = f.list(r).some((x) => c.vals.includes(x)); return c.op === "in" ? hit : !hit; }
  if (f.kind === "enum" || (f.kind === "text" && (c.op === "in" || c.op === "not_in"))) { const s = empty ? "" : String(v); return c.op === "in" ? c.vals.includes(s) : !c.vals.includes(s); }
  if (f.kind === "text") { const has = !empty && norm(String(v)).includes(norm(c.a.trim())); return c.op === "contains" ? has : !has; }
  if (empty) return false;
  if (f.kind === "date") {
    const d = String(v).slice(0, 10);
    if (c.op === "in_period") return inPeriod(d, c.a);
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
  // short repeated texts behave like categories (country, industry…) — chartable
  const distinct = new Set(nn.map(String));
  if (nn.every((v) => typeof v === "string") && distinct.size <= 24 && distinct.size < nn.length) return { kind: "enum", options: [...distinct].sort() };
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
    key: `${group}.${k}`, group, label: humanize(k), ...guessKind(plain.get(k)!), get: (r: Row) => cleanVal(pick(r)?.[k]),
  }));
  for (const k of [...custom.keys()].sort()) out.push({
    key: `${group}.custom.${k}`, group, label: labels[k] ?? humanize(k), ...guessKind(custom.get(k)!), get: (r: Row) => cleanVal(pick(r)?.custom?.[k]),
  });
  return out;
}

/* ─────────────── custom field definitions (contact_fields / company_fields) ─────────────── */

export interface CustomDef { id: string; label: string; type: string; options: string[]; sort: number }
/** Definitions per table, filled by loadFieldLabels — so every field a company defines is reportable, even before anyone fills it. */
const DEFS: Record<string, CustomDef[]> = {};
const DEF_TABLE: Partial<Record<Group, string>> = { contact: "contact_fields", company: "company_fields" };
export const customDefs = (group: Group): CustomDef[] => DEFS[DEF_TABLE[group] ?? ""] ?? [];

const asList = (v: any): string[] =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : v == null || v === "" ? [] : String(v).split(/\s*[,;|]\s*/).filter(Boolean);

/**
 * Imports often keep several picks of a one-choice field in one text ("Gestión, Segmentos",
 * "0. Potential Client,1. Konsolidator Iberia Customer") — and those combinations even end up
 * in the field's options. A value is split into its parts when every part is a value of the
 * field on its own (an option, or a part of one), so "is any of Segmentos" finds it and a
 * chart counts it under each part. A real option with a comma ("Sage Spain, S.L.") stays whole.
 */
function splitter(options: string[]): (v: string) => string[] {
  const parts = (x: string) => x.split(/\s*,\s*/).map((y) => y.trim()).filter(Boolean);
  const suffix = /^(s\.?\s?l\.?|s\.?\s?a\.?|s\.?\s?l\.?\s?u\.?|inc\.?|ltd\.?|llc|gmbh|lda\.?|plc|bv|ag)$/i;
  const known = new Set<string>();
  options.forEach((o) => { known.add(norm(o)); parts(o).forEach((x) => known.add(norm(x))); });
  return (v: string) => {
    if (!v.includes(",")) return [v];
    const ps = parts(v);
    return ps.length > 1 && ps.every((x) => x.length >= 2 && !suffix.test(x) && known.has(norm(x))) ? ps : [v];
  };
}

/** One report / export field for a custom field definition, typed by its definition. */
export function customDefField(group: Group, d: CustomDef, pick: (r: Row) => any): Field {
  const key = `${group}.custom.${d.id}`;
  const raw = (r: Row) => pick(r)?.custom?.[d.id];
  switch (d.type) {
    case "boolean": return { key, group, label: d.label, kind: "enum", options: ["Yes", "No"], get: (r) => { const v = raw(r); return v === true || v === "true" ? "Yes" : v === false || v === "false" ? "No" : null; } };
    // one choice — but some old records hold a list: each of its values counts (options can contain commas, so a text isn't split)
    case "select": {
      const split = splitter(d.options);
      const vals = (r: Row): string[] => { const v = raw(r); const l = Array.isArray(v) ? v.filter((x) => x != null && x !== "" && typeof x !== "object").map(String) : v == null || v === "" || typeof v === "object" ? [] : [String(v)]; return [...new Set(l.flatMap(split))]; };
      return { key, group, label: d.label, kind: "enum", options: [...new Set(d.options.flatMap(split))], get: (r) => { const l = vals(r); return l.length ? l.join(", ") : null; }, list: vals };
    }
    case "multiselect": return {
      key, group, label: d.label, kind: "enum", options: d.options,
      get: (r) => { const l = asList(raw(r)); return l.length ? l.join(", ") : null; },
      list: (r) => asList(raw(r)),
    };
    case "number": return { key, group, label: d.label, kind: "number", get: (r) => { const v = raw(r); const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; } };
    case "date": return { key, group, label: d.label, kind: "date", get: (r) => isoDay(raw(r)) };
    default: return { key, group, label: d.label, kind: "text", get: (r) => { const v = raw(r); return v == null || v === "" ? null : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? null : String(v); } };
  }
}

/**
 * Swap the data-guessed custom fields of a group for the defined ones: every
 * definition (in the order set in Settings, typed properly — multiple choice
 * included) plus any leftover key found in the data that has no definition.
 */
export function withCustomDefs<F extends Field>(fields: F[], group: Group, pick: (r: Row) => any): F[] {
  const defs = [...customDefs(group)].sort((a, b) => a.sort - b.sort);
  // a key that is only a code (a field deleted in Settings) means nothing to anyone: left out
  const gone = (f: F) => f.key.startsWith(`${group}.custom.`) && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(f.key.slice(group.length + 8));
  if (!defs.length) return fields.filter((f) => !gone(f));
  const defined = new Set(defs.map((d) => `${group}.custom.${d.id}`));
  const pre = `${group}.custom.`;
  const plain = fields.filter((f) => !f.key.startsWith(pre));
  const leftovers = fields.filter((f) => f.key.startsWith(pre) && !defined.has(f.key) && !gone(f));
  return [...plain, ...(defs.map((d) => customDefField(group, d, pick)) as F[]), ...leftovers];
}

export async function loadFieldLabels(table: string): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.from(table).select("*");
    DEFS[table] = (data ?? []).filter((f: any) => f.id && (f.label ?? f.name)).map((f: any) => ({
      id: String(f.id), label: String(f.label ?? f.name), type: String(f.type ?? "text"),
      options: Array.isArray(f.options) ? f.options.map(String) : [], sort: Number(f.sort ?? 0),
    }));
    const map: Record<string, string> = {};
    (data ?? []).forEach((f: any) => {
      const label = f.label ?? f.name ?? f.title;
      if (!label) return;
      [f.key, f.id, f.slug, f.name].filter(Boolean).forEach((k: string) => { map[k] = label; });
    });
    return map;
  } catch { return {}; }
}

/* ─────────────── the field catalogue ─────────────── */

export interface EngineCtx {
  contacts: Contact[];
  companies: Company[];
  employees: { id: string; name: string }[];
  trackAssignees: Record<string, string[]>;
  trackOwners: Record<string, string>;
  potentialTotals: Record<string, number>;
  pipelineNames: string[];
  productNames: string[];
  phaseNames: string[];
  /** Names of the phases where a deal is lost. */
  lostPhases?: string[];
  contactLabels: Record<string, string>;
  companyLabels: Record<string, string>;
  /** Custom deal fields (Sales → Actions → Deal fields). */
  dealFields?: TrackingField[];
  pipelineName: (id: string | null) => string;
  productName: (id: string | null) => string | null;
  phaseName: (t: Tracking) => string;
  phaseProbOf: (t: Tracking) => number | null;
  closeDateOf: (t: Tracking) => string | null;
  /** Pipeline progress 0–100, used when no probability is set. */
  progressOf: (t: Tracking) => number | null;
  probSource: ProbSource;
}

/** The probability a report works with (chosen source, falling back to pipeline progress). */
export function probFor(ctx: EngineCtx, t: Tracking): { p: number | null; estimated: boolean } {
  if (t.status === "won") return { p: 100, estimated: false };
  if (t.status === "lost") return { p: 0, estimated: false };
  const ph = ctx.phaseProbOf(t), rep = (t as any).rep_close_prob ?? null, mgr = (t as any).mgr_close_prob ?? null;
  let p: number | null = null;
  if (ctx.probSource === "phase") p = ph;
  else if (ctx.probSource === "rep") p = rep;
  else if (ctx.probSource === "mgr") p = mgr;
  else { const v = [ph, rep, mgr].filter((x): x is number => x != null); p = v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; }
  if (p != null) return { p, estimated: false };
  const fb = ctx.progressOf(t);
  return { p: fb, estimated: fb != null };
}

export function companyLinker(companies: Company[]) {
  const byId = new Map(companies.map((c) => [c.id as string, c]));
  const byName = new Map(companies.map((c: any) => [norm(c.name ?? ""), c.id as string]));
  const pick = (v: any): { id: string | null; name: string | null } | null => {
    if (v == null || v === "") return null;
    if (Array.isArray(v)) { for (const x of v) { const r = pick(x); if (r) return r; } return null; }
    if (typeof v === "object") return pick(v.id ?? v.company_id ?? v.name);
    const sv = String(v);
    if (byId.has(sv)) return { id: sv, name: null };
    const idByName = byName.get(norm(sv));
    if (idByName) return { id: idByName, name: null };
    return /^[0-9a-f-]{36}$/i.test(sv) ? null : { id: null, name: sv };
  };
  const ofContact = (c: any): { id: string | null; name: string | null } | null => {
    if (!c) return null;
    const keys = Object.keys(c).filter((k) => /compan/i.test(k)).sort((a, b) => (/_?id$/i.test(b) ? 1 : 0) - (/_?id$/i.test(a) ? 1 : 0));
    for (const k of keys) { const r = pick(c[k]); if (r) return r; }
    return null;
  };
  return { byId, ofContact };
}

export function buildFields(ctx: EngineCtx): Field[] {
  const { byId: companyById, ofContact } = companyLinker(ctx.companies);
  const empName = new Map(ctx.employees.map((e) => [e.id, e.name]));
  const rev = (t: Tracking) => ctx.potentialTotals[t.id as string] ?? null;
  const today = todayIso();
  const deal: Field[] = [
    { key: "deal.company", group: "deal", label: "Company", kind: "text", get: (r) => (r.deal.company_id ? (companyById.get(r.deal.company_id) as any)?.name ?? null : null) },
    { key: "deal.status", group: "deal", label: "Status", kind: "enum", options: Object.values(STATUS_LABEL), get: (r) => STATUS_LABEL[r.deal.status as string] ?? r.deal.status },
    { key: "deal.pipeline", group: "deal", label: "Pipeline", kind: "enum", options: ctx.pipelineNames, get: (r) => ctx.pipelineName(r.deal.pipeline_id) },
    { key: "deal.phase", group: "deal", label: "Phase", kind: "enum", options: ctx.phaseNames, lost: ctx.lostPhases, get: (r) => { const n = ctx.phaseName(r.deal); return n === "—" ? null : n; } },
    { key: "deal.product", group: "deal", label: "Product", kind: "enum", options: ctx.productNames, get: (r) => ctx.productName(r.deal.product_id) },
    { key: "deal.owner", group: "deal", label: "Owner", kind: "enum", options: ctx.employees.map((e) => e.name), get: (r) => empName.get(ctx.trackOwners[r.deal.id as string] ?? "") ?? null },
    { key: "deal.revenue", group: "deal", label: "Potential revenue", kind: "money", sum: true, get: (r) => rev(r.deal) },
    { key: "deal.weighted", group: "deal", label: "Weighted revenue", kind: "money", sum: true, get: (r) => { const v = rev(r.deal); const { p } = probFor(ctx, r.deal); return v == null || p == null ? null : Math.round(v * p) / 100; } },
    { key: "deal.prob", group: "deal", label: "Close probability (report)", kind: "percent", get: (r) => probFor(ctx, r.deal).p },
    { key: "deal.phase_prob", group: "deal", label: "Phase probability", kind: "percent", get: (r) => ctx.phaseProbOf(r.deal) },
    { key: "deal.rep_prob", group: "deal", label: "Sales close probability", kind: "percent", get: (r) => (r.deal as any).rep_close_prob ?? null },
    { key: "deal.mgr_prob", group: "deal", label: "Management close probability", kind: "percent", get: (r) => (r.deal as any).mgr_close_prob ?? null },
    { key: "deal.progress", group: "deal", label: "Pipeline progress", kind: "percent", get: (r) => ctx.progressOf(r.deal) },
    { key: "deal.close", group: "deal", label: "Expected close date", kind: "date", get: (r) => isoDay(ctx.closeDateOf(r.deal)) },
    { key: "deal.rep_close_date", group: "deal", label: "Expected close · sales", kind: "date", get: (r) => isoDay((r.deal as any).rep_close_date) },
    { key: "deal.mgr_close_date", group: "deal", label: "Expected close · management", kind: "date", get: (r) => isoDay((r.deal as any).mgr_close_date) },
    { key: "deal.close_date", group: "deal", label: "Close date", kind: "date", get: (r) => isoDay((r.deal as any).close_date) },
    { key: "deal.days_to_close", group: "deal", label: "Days to close", kind: "number", get: (r) => { const d = isoDay(ctx.closeDateOf(r.deal)); return d && r.deal.status !== "won" && r.deal.status !== "lost" ? daysBetween(today, d) : null; } },
    { key: "deal.overdue", group: "deal", label: "Overdue", kind: "enum", options: ["Yes", "No"], get: (r) => { const d = isoDay(ctx.closeDateOf(r.deal)); return r.deal.status === "won" || r.deal.status === "lost" ? null : d ? (d < today ? "Yes" : "No") : null; } },
    { key: "deal.age", group: "deal", label: "Deal age (days)", kind: "number", get: (r) => { const d = isoDay(r.deal.created_at); return d ? daysBetween(d, today) : null; } },
    { key: "deal.team", group: "deal", label: "Sales team", kind: "text", get: (r) => (ctx.trackAssignees[r.deal.id as string] ?? []).map((id) => empName.get(id) ?? "").filter(Boolean).join(", ") || null },
    { key: "deal.contacts", group: "deal", label: "Contacts on deal", kind: "number", get: (r) => r.deal.contactIds.length },
    { key: "deal.count", group: "deal", label: "Number of deals", kind: "number", sum: true, get: () => 1 },
    { key: "deal.created", group: "deal", label: "Deal created", kind: "date", get: (r) => isoDay(r.deal.created_at) },
    ...dealCustomFields(ctx.dealFields ?? []),
  ];
  const contact: Field[] = [
    { key: "contact.name", group: "contact", label: "Full name", kind: "text", get: (r) => (r.contact ? [(r.contact as any).first_name, (r.contact as any).last_name].filter(Boolean).join(" ") || null : null) },
    ...withCustomDefs(discover(ctx.contacts, "contact", (r) => r.contact, ctx.contactLabels).filter((f) => !/compan/i.test(f.key) || f.key.startsWith("contact.custom.")), "contact", (r) => r.contact),
    { key: "contact.company", group: "contact", label: "Company", kind: "text", get: (r) => { const cc = ofContact(r.contact); return cc ? (cc.id ? (companyById.get(cc.id) as any)?.name ?? null : cc.name) : null; } },
  ];
  const company = withCustomDefs(discover(ctx.companies, "company", (r) => r.company, ctx.companyLabels), "company", (r) => r.company);
  return [...deal, ...contact, ...company];
}

/**
 * One report field per custom deal field. Dropdowns and yes/no become
 * categories (so they can group a board, split a chart or filter by value),
 * numbers / dates keep their own operators. Keys use the field id, so a saved
 * report keeps working after the field is renamed.
 */
export function dealCustomFields(defs: TrackingField[]): (Field & { group: "deal" })[] {
  // the same typing as the other custom fields (a stray list, "true" as text, an object… never break a report)
  return defs.map((d): Field & { group: "deal" } => ({ ...customDefField("deal", { id: d.id, label: d.label, type: d.type as string, options: d.options ?? [], sort: d.sort }, (r) => r.deal), key: `deal.custom.${d.id}`, group: "deal" }));
}

/* ─────────────── rows ─────────────── */

export function buildRows(deals: Tracking[], mode: RowMode, source: Source, contacts: Contact[], companies: Company[]): Row[] {
  const { byId: companyById, ofContact } = companyLinker(companies);
  const contactById = new Map(contacts.map((c) => [c.id as string, c]));
  const byCompany = new Map<string, Contact[]>();
  contacts.forEach((c: any) => { const id = ofContact(c)?.id; if (id) { if (!byCompany.has(id)) byCompany.set(id, []); byCompany.get(id)!.push(c); } });
  const out: Row[] = [];
  for (const t of deals) {
    const company = t.company_id ? companyById.get(t.company_id) ?? null : null;
    if (mode === "deals") out.push({ deal: t, contact: null, company });
    else if (mode === "companies") { if (company) out.push({ deal: t, contact: null, company }); }
    else {
      const ids = new Set<string>();
      if (source !== "company") t.contactIds.forEach((id) => ids.add(id));
      if (source !== "deal" && t.company_id) (byCompany.get(t.company_id) ?? []).forEach((c) => ids.add(c.id as string));
      ids.forEach((id) => { const c = contactById.get(id); if (c) out.push({ deal: t, contact: c, company }); });
    }
  }
  return out;
}

export function applyConds(rows: Row[], conds: Cond[], match: "all" | "any", fieldByKey: Map<string, Field>): Row[] {
  const active = conds.filter((c) => condComplete(c, fieldByKey.get(c.field)));
  if (!active.length) return rows;
  return rows.filter((r) => {
    const res = active.map((c) => condTest(c, fieldByKey.get(c.field)!, r));
    return match === "all" ? res.every(Boolean) : res.some(Boolean);
  });
}

/* ─────────────── table (same merge rules as the export) ─────────────── */

export type Cell = string | number | { date: string } | null;
export function toCell(f: Field, v: any): Cell {
  if (v == null || v === "") return null;
  if (f.kind === "date") { const d = isoDay(v); return d ? { date: d } : null; }
  if (f.kind === "money" || f.kind === "number" || f.kind === "percent") { const n = Number(v); return Number.isFinite(n) ? n : String(v); }
  return String(v);
}
export const fmtMoney = (n: number) => `${Math.round(n).toLocaleString("en-US")} €`;
export const fmtDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };
export function showCell(f: Field, c: Cell): string {
  if (c == null) return "";
  if (typeof c === "object") return fmtDate(c.date);
  if (typeof c === "number") return f.kind === "money" ? fmtMoney(c) : f.kind === "percent" ? `${Math.round(c)}%` : c.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return c;
}
export function sortValue(c: Cell): string | number | null {
  if (c == null) return null;
  if (typeof c === "object") return c.date;
  return typeof c === "number" ? c : norm(c);
}

export interface TableRow { cells: Cell[]; dealIds: string[]; key: string }
export function buildTable(rows: Row[], colFields: Field[], mode: RowMode, merge: boolean): TableRow[] {
  const doMerge = mode !== "deals" && merge;
  const groups = new Map<string, Row[]>();
  rows.forEach((r, i) => {
    const k = !doMerge ? `${r.deal.id}|${r.contact?.id ?? ""}|${i}` : mode === "contacts" ? (r.contact?.id as string) : (r.company?.id as string);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  });
  const out: TableRow[] = [];
  groups.forEach((rs, key) => {
    const cells = colFields.map((f) => {
      if (rs.length === 1) return toCell(f, f.get(rs[0]));
      if (f.sum) {
        const seen = new Set<string>(); let total = 0, any = false;
        rs.forEach((r) => { const id = r.deal.id as string; if (seen.has(id)) return; seen.add(id); const v = f.get(r); const n = Number(v); if (v != null && Number.isFinite(n)) { total += n; any = true; } });
        return any ? total : null;
      }
      const distinct = new Map<string, Cell>();
      rs.map((r) => toCell(f, f.get(r))).filter((c) => c != null).forEach((c) => distinct.set(typeof c === "object" ? (c as any).date : String(c), c));
      if (distinct.size <= 1) return [...distinct.values()][0] ?? null;
      return [...distinct.values()].map((c) => showCell(f, c)).join("; ");
    });
    out.push({ cells, dealIds: [...new Set(rs.map((r) => r.deal.id as string))], key });
  });
  return out;
}

/* ─────────────── chart aggregation (deal level: each deal counted once) ─────────────── */

export type Measure = "count" | "revenue" | "weighted" | "avgprob";
export const MEASURE_LABEL: Record<Measure, string> = { count: "Number of deals", revenue: "Potential revenue", weighted: "Weighted revenue", avgprob: "Average probability" };
export type TimeGrain = "week" | "month" | "quarter";

export interface Series { name: string; values: number[] }
export interface Agg { labels: string[]; keys: string[]; series: Series[]; measure: Measure; lost?: string[] }

const monthKey = (iso: string) => iso.slice(0, 7);
const quarterKey = (iso: string) => `${iso.slice(0, 4)}-Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;
const weekKey = (iso: string) => { const d = new Date(`${iso}T00:00:00`); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export function timeLabel(key: string, grain: TimeGrain) {
  if (grain === "quarter") return `${key.slice(5)} ${key.slice(2, 4)}`;
  if (grain === "month") { const [y, m] = key.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" }); }
  const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * Group deals by a dimension and compute a measure.
 * dim: a field key, or "time:week" / "time:month" / "time:quarter" (bucketed by dateOf).
 * split: optional second field → one series per value (stacked charts).
 */
export function aggregate(opts: {
  deals: Row[]; dim: string; measure: Measure; split?: string | null; fieldByKey: Map<string, Field>;
  revenueOf: (t: Tracking) => number; weightedOf: (t: Tracking) => number; probOf: (t: Tracking) => number | null;
  dateOf: (t: Tracking) => string | null; order?: (f: Field) => string[] | undefined; limit?: number; cumulative?: boolean;
}): Agg {
  const { deals, dim, measure, split, fieldByKey, revenueOf, weightedOf, probOf, dateOf } = opts;
  const isTime = dim.startsWith("time:");
  const grain = (isTime ? dim.slice(5) : "month") as TimeGrain;
  const dimF = isTime ? null : fieldByKey.get(dim);
  const splitF = split ? fieldByKey.get(split) ?? null : null;
  const keyOf = (r: Row): string | null => {
    if (isTime) { const d = isoDay(dateOf(r.deal)); return d ? (grain === "week" ? weekKey(d) : grain === "quarter" ? quarterKey(d) : monthKey(d)) : null; }
    const v = dimF?.get(r); return v == null || v === "" ? "—" : String(v);
  };
  const seen = new Set<string>();
  const uniq = deals.filter((r) => { const id = r.deal.id as string; if (seen.has(id)) return false; seen.add(id); return true; });
  const buckets = new Map<string, Map<string, Row[]>>();
  const splitVals = new Set<string>();
  for (const r of uniq) {
    const k = keyOf(r); if (k == null) continue;
    const s = splitF ? (splitF.get(r) == null || splitF.get(r) === "" ? "—" : String(splitF.get(r))) : "_";
    splitVals.add(s);
    if (!buckets.has(k)) buckets.set(k, new Map());
    const m = buckets.get(k)!; if (!m.has(s)) m.set(s, []); m.get(s)!.push(r);
  }
  const measureOf = (rs: Row[]) => {
    if (!rs.length) return 0;
    if (measure === "count") return rs.length;
    if (measure === "revenue") return rs.reduce((a, r) => a + revenueOf(r.deal), 0);
    if (measure === "weighted") return rs.reduce((a, r) => a + weightedOf(r.deal), 0);
    const ps = rs.map((r) => probOf(r.deal)).filter((p): p is number => p != null);
    return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
  };
  let keys = [...buckets.keys()];
  if (isTime) keys.sort();
  else {
    const known = dimF ? opts.order?.(dimF) ?? dimF.options : undefined;
    const total = (k: string) => [...buckets.get(k)!.values()].reduce((a, rs) => a + measureOf(rs), 0);
    keys.sort((a, b) => {
      if (a === "—") return 1; if (b === "—") return -1;
      if (known?.length) { const ia = known.indexOf(a), ib = known.indexOf(b); if (ia >= 0 && ib >= 0) return ia - ib; if (ia >= 0) return -1; if (ib >= 0) return 1; }
      return total(b) - total(a);
    });
    const limit = opts.limit ?? 12;
    if (keys.length > limit && !known?.length) {
      const keep = keys.slice(0, limit - 1), rest = keys.slice(limit - 1);
      const other = new Map<string, Row[]>();
      rest.forEach((k) => buckets.get(k)!.forEach((rs, s) => { if (!other.has(s)) other.set(s, []); other.get(s)!.push(...rs); }));
      buckets.set("Other", other); keys = [...keep, "Other"];
    }
  }
  const sNames = splitF ? [...splitVals].sort((a, b) => (a === "—" ? 1 : b === "—" ? -1 : a.localeCompare(b))) : ["_"];
  const series: Series[] = sNames.map((s) => {
    let run = 0;
    return {
      name: s === "_" ? MEASURE_LABEL[measure] : s,
      values: keys.map((k) => { const v = measureOf(buckets.get(k)!.get(s) ?? []); if (opts.cumulative) { run += v; return run; } return v; }),
    };
  });
  return { labels: keys.map((k) => (isTime ? timeLabel(k, grain) : k)), keys, series, measure };
}
/* ═════════════════════════════════════════════════════════════════════════════
   The CRM report engine (the Reports page)
   Any part of the CRM can be the subject of a report — deals, companies,
   contacts, clients, projects, signed products, invoices, tickets — and each
   row carries the records linked to it, so a report can show and filter on the
   fields of all of them: every column of every table (found in the data), every
   custom field (as defined in Settings), and computed figures.
   ═════════════════════════════════════════════════════════════════════════════ */

export type EntityKey = Group;
/** One report row: the record the report is about, and the ones linked to it. */
export type CrmRow = Partial<Record<EntityKey, any>>;
export interface Entity { key: EntityKey; label: string; plural: string; hint: string; icon: string; tone: string; related: EntityKey[] }
export const ENTITIES: Entity[] = [
  { key: "deal", label: "Deal", plural: "Deals", hint: "Pipelines, phases, values and probabilities", icon: "M3 17l6-6 4 4 8-8M15 7h6v6", tone: "#1fb98a", related: ["company", "contact", "client"] },
  { key: "agreement", label: "Contract", plural: "Contracts", hint: "Signed contracts: dates, term, renewals, licence and services value", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 15c1.5-1.5 2.5-1.5 3 0s1.5 1.5 3 0 2-1 3 0", tone: "#5b6cc4", related: ["deal", "company", "client"] },
  { key: "company", label: "Company", plural: "Companies", hint: "Accounts, types, sectors and their custom fields", icon: "M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1", tone: "#3a7fc2", related: ["client"] },
  { key: "contact", label: "Contact", plural: "Contacts", hint: "People, where they work and their custom fields", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75", tone: "#7458c6", related: ["company"] },
  { key: "client", label: "Client", plural: "Clients", hint: "Clients with their projects, recurring and signed value", icon: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", tone: "#0f8f62", related: ["company"] },
  { key: "project", label: "Project", plural: "Projects", hint: "Service projects: value, days, status and dates", icon: "M3 7h18v13H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", tone: "#c98a22", related: ["client", "company"] },
  { key: "contract", label: "Signed product", plural: "Signed products", hint: "Subscriptions and one-offs: terms, renewals, ARR in any period", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5", tone: "#12928e", related: ["client", "company", "deal"] },
  { key: "invoice", label: "Invoice", plural: "Invoices", hint: "What was billed, sent, paid and late", icon: "M4 2h16v20l-3-2-3 2-3-2-3 2-3-2-1 .7zM8 7h8M8 11h8M8 15h5", tone: "#e0574b", related: ["project", "client", "company"] },
  { key: "ticket", label: "Ticket or task", plural: "Tickets & tasks", hint: "Tickets and tasks: stage, priority, who has them, response", icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11", tone: "#d4a017", related: ["client", "company", "deal", "contact"] },
];
export const entityOf = (k: EntityKey) => ENTITIES.find((e) => e.key === k)!;

/* ---- filters: rules and groups of rules, as deep as you like ---- */
export interface CondGroup { id: string; match: "all" | "any" | "none"; items: (Cond | CondGroup)[] }
export const isGroup = (x: Cond | CondGroup): x is CondGroup => Array.isArray((x as CondGroup).items);
export const emptyTree = (): CondGroup => ({ id: uid(), match: "all", items: [] });
/** Does a row pass a group (rules not filled in yet are skipped)? */
export function testTree(g: CondGroup, r: any, fieldByKey: Map<string, Field>): boolean {
  const res: boolean[] = [];
  for (const it of g.items) {
    if (isGroup(it)) { if (countRules(it)) res.push(testTree(it, r, fieldByKey)); continue; }
    const f = fieldByKey.get(it.field);
    if (!condComplete(it, f)) continue;
    res.push(condTest(it, f!, r));
  }
  if (!res.length) return true;
  return g.match === "all" ? res.every(Boolean) : g.match === "any" ? res.some(Boolean) : !res.some(Boolean);
}
export const countRules = (g: CondGroup): number => g.items.reduce((n, it) => n + (isGroup(it) ? countRules(it) : it.field ? 1 : 0), 0);

/* ---- the data, read once per visit and only what a report needs ---- */
async function readAllRows(table: string, cols = "*"): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; from < 500000; from += 1000) {
    // a steady order, or the pages overlap and rows go missing past the first thousand
    const { data, error } = await supabase.from(table).select(cols).order("id").range(from, from + 999);
    if (error) { if (!out.length) throw error; break; }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
export interface CrmData {
  deal?: Tracking[]; company?: Company[]; contact?: Contact[]; client?: any[]; project?: any[]; contract?: any[]; invoice?: any[]; ticket?: any[];
  /** Signed contracts: the deals' contract terms, one per deal that has them. */
  agreement?: any[];
  /** Deal helpers (pipelines, phases, totals, teams…). */
  dealCtx?: EngineCtx;
  employees: { id: string; name: string }[];
  products: { id: string; name: string }[];
  services: { id: string; name: string }[];
  relTags: string[];
}
const cache: Partial<Record<string, Promise<any>>> = {};
const once = <T,>(k: string, f: () => Promise<T>): Promise<T> => (cache[k] ??= f().catch((e) => { delete cache[k]; throw e; })) as Promise<T>;
/** Forget what was read (the "Refresh data" button). */
export const forgetCrmData = () => { Object.keys(cache).forEach((k) => delete cache[k]); };

/** Everything a report on `source` needs: the source, the records linked to it, and the custom field definitions. */
export async function loadCrmData(source: EntityKey, onStep?: (what: string) => void, extra: EntityKey[] = []): Promise<CrmData> {
  const need = new Set<EntityKey>(partsOf(source, extra));
  // a contract is a deal's signed terms: read with the deals
  if (need.has("agreement")) need.add("deal");
  // links need their own targets to resolve (a project's company goes through its client…)
  if (need.has("company") && source !== "company") need.add("client");
  const api = await import("../../companies/companiesApi");
  const step = <T,>(what: string, p: Promise<T>) => { onStep?.(what); return p; };
  const [employees, products, services, opts] = await Promise.all([
    once("employees", () => api.listEmployees().then((es) => es.map((e: any) => ({ id: e.id, name: e.name })))).catch(() => []),
    once("products", () => readAllRows("products", "id, name")).catch(() => []),
    once("services", () => readAllRows("services", "id, name")).catch(() => []),
    once("crm_options", () => api.listCrmOptions()).catch(() => []),
    once("defs", () => Promise.all([loadFieldLabels("contact_fields"), loadFieldLabels("company_fields")])).catch(() => null),
  ]);
  const data: CrmData = { employees, products, services, relTags: (opts as any[]).filter((o) => o.kind === "relationship").map((o) => o.label) };
  const jobs: Promise<void>[] = [];
  if (need.has("company")) jobs.push(step("companies", once("company", () => api.listCompanies())).then((r) => { data.company = r; }));
  if (need.has("contact")) jobs.push(step("contacts", once("contact", () => api.listContacts())).then((r) => { data.contact = r; }));
  if (need.has("client")) jobs.push(step("clients", once("client", () => readAllRows("clients"))).then((r) => { data.client = r; }));
  if (need.has("project")) jobs.push(step("projects", once("project", () => readAllRows("projects"))).then((r) => { data.project = r; }));
  if (need.has("contract")) jobs.push(step("signed products", once("contract", () => readAllRows("client_products"))).then((r) => { data.contract = r; }));
  if (need.has("invoice")) jobs.push(step("invoices", once("invoice", () => readAllRows("invoices"))).then((r) => { data.invoice = r; }));
  // tickets (conversations) and tasks (work) both: "Ticket or task" tells them apart
  if (need.has("ticket")) jobs.push(step("tickets and tasks", once("ticket", () => readAllRows("tracking_tasks"))).then((r) => { data.ticket = r.filter((t: any) => !t.merged_into); }));
  if (need.has("deal")) jobs.push(step("deals", once("deal", () => loadDealBundle(employees))).then((b) => { data.deal = b.deals; data.dealCtx = b.ctx; }));
  await Promise.all(jobs);
  if (need.has("agreement")) {
    data.agreement = (data.deal ?? []).filter((t: any) => t.contract_terms && typeof t.contract_terms === "object" && !Array.isArray(t.contract_terms))
      .map((t: any) => ({ ...t.contract_terms, id: t.id, tracking_id: t.id, company_id: t.company_id ?? null, deal_name: t.deal_name ?? null, deal_status: t.status ?? null, owner_id: t.owner_id ?? null }));
  }
  // the deal fields also need the contacts and companies they link to
  if (data.dealCtx) data.dealCtx = { ...data.dealCtx, contacts: data.contact ?? [], companies: data.company ?? [] };
  return data;
}

async function loadDealBundle(employees: { id: string; name: string }[]): Promise<{ deals: Tracking[]; ctx: EngineCtx }> {
  const sales = await import("../sales/salesApi");
  const pipes = await import("../../settings/pipelineApi");
  const { listTrackingFields } = await import("./trackingFieldsApi");
  const { loadProducts, loadServices } = await import("../../settings/catalogApi");
  const trackings = sales.listTrackings();
  const lines = Promise.all([readAllRows("tracking_products", "id, tracking_id, product_id, version_active").catch(() => []), readAllRows("tracking_potential_services", "id, tracking_id, service_id, label, version_active").catch(() => [])]);
  const [deals, totals, team, pipelines, phaseBy, fields, prods, [tps, tss], svcs] = await Promise.all([
    trackings,
    sales.loadPotentialTotals({ trackings, products: loadProducts().catch(() => []), services: loadServices().catch(() => []) }).catch(() => ({} as Record<string, number>)),
    sales.loadTrackingTeams().catch(() => ({ members: {} as Record<string, string[]>, owners: {} as Record<string, string> })),
    pipes.listPipelines().catch(() => []),
    pipes.loadPhasesByPipeline().catch(() => ({} as Record<string, any[]>)),
    listTrackingFields().catch(() => []),
    loadProducts().catch(() => [] as any[]),
    lines,
    loadServices().catch(() => [] as any[]),
  ]);
  const pipeName = new Map(pipelines.map((p) => [p.id, p.name]));
  // every product and service on each deal (the active version of each line)
  const prodN = new Map((prods as any[]).map((p) => [String(p.id), p.name as string]));
  const svcN = new Map((svcs as any[]).map((p) => [String(p.id), p.name as string]));
  const onDeal = new Map<string, { products: string[]; services: string[] }>();
  const slot = (id: string) => { let x = onDeal.get(id); if (!x) onDeal.set(id, (x = { products: [], services: [] })); return x; };
  (tps as any[]).filter((l) => l.version_active !== false && l.tracking_id).forEach((l) => { const n = prodN.get(String(l.product_id)); if (n) slot(String(l.tracking_id)).products.push(n); });
  (tss as any[]).filter((l) => l.version_active !== false && l.tracking_id).forEach((l) => { const n = (l.label as string)?.trim() || svcN.get(String(l.service_id)); if (n) slot(String(l.tracking_id)).services.push(n); });
  deals.forEach((t: any) => { const x = onDeal.get(String(t.id)); t.__products = x ? [...new Set(x.products)] : []; t.__services = x ? [...new Set(x.services)] : []; });
  const prodName = new Map((prods as any[]).map((p) => [p.id, p.name]));
  const phase = (t: Tracking) => (phaseBy[t.pipeline_id ?? ""] ?? []).find((ph: any) => ph.id === t.current_phase_id);
  const phaseNames = [...new Set(Object.values(phaseBy).flat().map((ph: any) => ph.name as string))];
  const lostPhases = [...new Set(Object.values(phaseBy).flat().filter((ph: any) => ph.sales_outcome === "loss").map((ph: any) => ph.name as string))];
  const ctx: EngineCtx = {
    contacts: [], companies: [], employees, trackAssignees: team.members, trackOwners: team.owners, potentialTotals: totals,
    pipelineNames: pipelines.map((p) => p.name), productNames: (prods as any[]).map((p) => p.name), phaseNames, lostPhases,
    contactLabels: {}, companyLabels: {}, dealFields: fields,
    pipelineName: (id) => (id ? pipeName.get(id) : undefined) ?? "—",
    productName: (id) => (id ? prodName.get(id) ?? null : null),
    phaseName: (t) => phase(t)?.name ?? "—",
    phaseProbOf: (t) => { if (t.status === "won") return 100; if (t.status === "lost") return 0; const ph: any = phase(t); if (!ph) return null; if (ph.sales_outcome === "win") return 100; if (ph.sales_outcome === "loss") return 0; return ph.close_probability ?? null; },
    closeDateOf: (t) => t.mgr_close_date || t.rep_close_date || null,
    progressOf: (t) => sales.trackingPct(phaseBy[t.pipeline_id ?? ""] ?? [], t.current_phase_id),
    probSource: "phase",
  };
  return { deals, ctx };
}

/* ---- rows: the subject and what it links to ---- */
/**
 * How the parts of the CRM link to each other. `many` = one record has several of the other
 * (a company's deals); otherwise it has at most one (a deal's company).
 */
interface Link { from: EntityKey; to: EntityKey; many: boolean; get: (rec: any, ix: Index) => any; all?: true }
interface Index { [k: string]: Map<string, any> }
const LINKS: Link[] = [
  { from: "deal", to: "company", many: false, get: (t, ix) => (t.company_id ? ix.company.get(String(t.company_id)) : null) },
  { from: "deal", to: "contact", many: false, get: (t, ix) => (t.contactIds?.[0] ? ix.contact.get(String(t.contactIds[0])) : null) },
  { from: "deal", to: "client", many: false, get: (t, ix) => (t.company_id ? ix.clientByCompany.get(String(t.company_id)) : null) },
  { from: "deal", to: "contract", many: true, get: (t, ix) => ix.contractsByDeal.get(String(t.id)) },
  { from: "deal", to: "ticket", many: true, get: (t, ix) => ix.ticketsByDeal.get(String(t.id)) },
  { from: "company", to: "client", many: false, get: (c, ix) => ix.clientByCompany.get(String(c.id)) },
  { from: "company", to: "deal", many: true, get: (c, ix) => ix.dealsByCompany.get(String(c.id)) },
  { from: "company", to: "contact", many: true, get: (c, ix) => ix.contactsByCompany.get(String(c.id)) },
  { from: "company", to: "ticket", many: true, get: (c, ix) => ix.ticketsByCompany.get(String(c.id)) },
  { from: "contact", to: "company", many: false, get: (c, ix) => (c.companyIds?.[0] ? ix.company.get(String(c.companyIds[0])) : null) },
  { from: "contact", to: "deal", many: true, get: (c, ix) => ix.dealsByContact.get(String(c.id)) },
  { from: "contact", to: "ticket", many: true, get: (c, ix) => ix.ticketsByContact.get(String(c.id)) },
  { from: "client", to: "company", many: false, get: (c, ix) => (c.company_id ? ix.company.get(String(c.company_id)) : null) },
  { from: "client", to: "project", many: true, get: (c, ix) => ix.projectsByClient.get(String(c.id)) },
  { from: "client", to: "contract", many: true, get: (c, ix) => ix.contractsByClient.get(String(c.id)) },
  { from: "client", to: "ticket", many: true, get: (c, ix) => ix.ticketsByClient.get(String(c.id)) },
  { from: "project", to: "client", many: false, get: (p, ix) => ix.client.get(String(p.client_id)) },
  { from: "project", to: "invoice", many: true, get: (p, ix) => ix.invoicesByProject.get(String(p.id)) },
  { from: "contract", to: "client", many: false, get: (l, ix) => ix.client.get(String(l.client_id)) },
  { from: "contract", to: "deal", many: false, get: (l, ix) => (l.tracking_id ? ix.deal.get(String(l.tracking_id)) : null) },
  { from: "invoice", to: "project", many: false, get: (i, ix) => ix.project.get(String(i.project_id)) },
  { from: "ticket", to: "client", many: false, get: (t, ix) => (t.client_id ? ix.client.get(String(t.client_id)) : null) },
  { from: "ticket", to: "company", many: false, get: (t, ix) => (t.company_id ? ix.company.get(String(t.company_id)) : t.client_id ? (() => { const c = ix.client.get(String(t.client_id)); return c?.company_id ? ix.company.get(String(c.company_id)) : null; })() : null) },
  { from: "ticket", to: "deal", many: false, get: (t, ix) => (t.tracking_id ? ix.deal.get(String(t.tracking_id)) : null) },
  // contracts: a deal's signed terms
  { from: "agreement", to: "deal", many: false, get: (a, ix) => ix.deal.get(String(a.id)) },
  { from: "agreement", to: "company", many: false, get: (a, ix) => (a.company_id ? ix.company.get(String(a.company_id)) : null) },
  { from: "agreement", to: "client", many: false, get: (a, ix) => (a.company_id ? ix.clientByCompany.get(String(a.company_id)) : null) },
  { from: "deal", to: "agreement", many: false, get: (t, ix) => ix.agreement.get(String(t.id)) ?? null },
  { from: "company", to: "agreement", many: true, get: (c, ix) => ix.agreementsByCompany.get(String(c.id)) },
  { from: "client", to: "agreement", many: true, get: (c, ix) => (c.company_id ? ix.agreementsByCompany.get(String(c.company_id)) : undefined) },
  // picked on purpose, a deal's contacts are all of them (and a contact's companies) — not only the first that comes along
  { from: "deal", to: "contact", many: true, all: true, get: (t, ix) => (t.contactIds ?? []).map((id: any) => ix.contact.get(String(id))).filter(Boolean) },
  { from: "contact", to: "company", many: true, all: true, get: (c, ix) => (c.companyIds ?? []).map((id: any) => ix.company.get(String(id))).filter(Boolean) },
  { from: "ticket", to: "contact", many: false, get: (t, ix) => (t.requester_contact_id ? ix.contact.get(String(t.requester_contact_id)) : null) },
];
/**
 * How each part reaches the report's subject: the shortest way, going through single links
 * first (a project's company is its client's company) and only then through lists.
 */
export function linkPlan(source: EntityKey, extra: EntityKey[] = []): { to: EntityKey; via: Link }[] {
  const want = new Set<EntityKey>([...entityOf(source).related, ...extra].filter((k) => k !== source));
  const cost = new Map<EntityKey, number>([[source, 0]]), via = new Map<EntityKey, Link>();
  const todo: EntityKey[] = [source];
  while (todo.length) {
    todo.sort((a, b) => cost.get(a)! - cost.get(b)!);
    const at = todo.shift()!;
    for (const l of LINKS.filter((x) => x.from === at && !x.all)) {
      const c = cost.get(at)! + (l.many ? 100 : 1);
      if (c < (cost.get(l.to) ?? Infinity)) { cost.set(l.to, c); via.set(l.to, l); todo.push(l.to); }
    }
  }
  extra.forEach((k) => { const all = LINKS.find((l) => l.all && l.from === source && l.to === k); if (all && via.get(k)?.from === source) { via.set(k, all); cost.set(k, 100); } });
  // every part on the way to a wanted one comes along
  const keep = new Set<EntityKey>();
  want.forEach((k) => { let at: EntityKey | undefined = k; while (at && at !== source && !keep.has(at)) { keep.add(at); at = via.get(at)?.from; } });
  // a part comes after the one it is reached through
  const depth = (k: EntityKey) => { let n = 0, at: EntityKey | undefined = k; while (at && at !== source && n < 20) { at = via.get(at)?.from; n++; } return n; };
  return [...keep].filter((k) => via.has(k)).sort((a, b) => depth(a) - depth(b) || cost.get(a)! - cost.get(b)!).map((k) => ({ to: k, via: via.get(k)! }));
}
/** Every part a report reads: its subject, what comes along, what was added and what links them. */
export const partsOf = (source: EntityKey, extra: EntityKey[] = []): EntityKey[] => [source, ...linkPlan(source, extra).map((p) => p.to)];
/** Does adding `k` give a row per linked record (a company's deals) rather than one? */
export const isListLink = (source: EntityKey, k: EntityKey) => linkPlan(source, [k]).some((p) => p.via.many);
/** The most rows a report builds (lists inside lists can multiply fast). */
export const ROW_CAP = 200000;
export function buildCrmRows(source: EntityKey, d: CrmData, extra: EntityKey[] = []): CrmRow[] {
  const by = (xs?: any[]) => new Map((xs ?? []).map((x) => [String(x.id), x]));
  const multi = (xs: any[] | undefined, keys: (x: any) => any[]) => { const m = new Map<string, any[]>(); (xs ?? []).forEach((x) => keys(x).forEach((k) => { if (k == null || k === "") return; const id = String(k); const l = m.get(id); if (l) l.push(x); else m.set(id, [x]); })); return m; };
  const ix: Index = {
    company: by(d.company), contact: by(d.contact), client: by(d.client), project: by(d.project), deal: by(d.deal), agreement: by(d.agreement),
    agreementsByCompany: multi(d.agreement, (a) => [a.company_id]),
    clientByCompany: new Map((d.client ?? []).filter((c) => c.company_id).map((c) => [String(c.company_id), c])),
    dealsByCompany: multi(d.deal, (t) => [t.company_id]), dealsByContact: multi(d.deal, (t) => t.contactIds ?? []),
    contactsByCompany: multi(d.contact, (c) => c.companyIds ?? []),
    projectsByClient: multi(d.project, (p) => [p.client_id]), invoicesByProject: multi(d.invoice, (i) => [i.project_id]),
    contractsByClient: multi(d.contract, (l) => [l.client_id]), contractsByDeal: multi(d.contract, (l) => [l.tracking_id]),
    ticketsByClient: multi(d.ticket, (t) => [t.client_id]), ticketsByCompany: multi(d.ticket, (t) => [t.company_id]),
    ticketsByDeal: multi(d.ticket, (t) => [t.tracking_id]), ticketsByContact: multi(d.ticket, (t) => [t.requester_contact_id]),
  };
  let rows: CrmRow[] = ((d as any)[source] ?? []).map((x: any) => ({ [source]: x }));
  for (const { to, via } of linkPlan(source, extra)) {
    if (!via.many) { rows.forEach((r) => { const from = r[via.from]; r[to] = from ? via.get(from, ix) ?? null : null; }); continue; }
    const next: CrmRow[] = [];
    for (const r of rows) {
      const from = r[via.from];
      const list: any[] = from ? via.get(from, ix) ?? [] : [];
      if (!list.length) next.push({ ...r, [to]: null });
      else for (const x of list) { next.push({ ...r, [to]: x }); if (next.length >= ROW_CAP) break; }
      if (next.length >= ROW_CAP) break;
    }
    rows = next;
  }
  return rows;
}

/* ---- fields of every part of the CRM ---- */
const MONEYISH = /(price|amount|net|value|revenue|fee|total|billing|rate|cost|budget)/i;
/** Columns found in the data, with money-looking numbers shown as money. */
function discovered(rows: any[], g: EntityKey, skip: RegExp | null = null): Field[] {
  // lists of records (a project's phases, contacts, team…) aren't a value to show or filter on
  const nested = new Set<string>();
  rows.slice(0, 400).forEach((r) => Object.entries(r ?? {}).forEach(([k, v]) => { if (Array.isArray(v) && v.some((x) => x && typeof x === "object")) nested.add(`${g}.${k}`); }));
  return discover(rows, g, (r) => (r as any)[g], {}).filter((f) => (!skip || !skip.test(f.key)) && !nested.has(f.key))
    .map((f) => (f.kind === "number" && MONEYISH.test(f.key) ? { ...f, kind: "money" as Kind, sum: true } : f.kind === "number" ? { ...f, sum: true } : f));
}
/** A field reads nothing when its record isn't linked to the row. */
const guard = (fs: Field[], g: EntityKey): Field[] => fs.map((f) => ({ ...f, get: (r: any) => (r?.[g] ? f.get(r) : null), list: f.list ? (r: any) => (r?.[g] ? f.list!(r) : []) : undefined }));
const ymd = (v: any) => isoDay(v);
/** The built-in company types by their names (as Companies shows them). */
const REL_NAMES: [string, string][] = [["crm", "CRM"], ["sales", "In sales"], ["client", "Client"]];
const relName = (k: any) => REL_NAMES.find((x) => x[0] === String(k).toLowerCase())?.[1] ?? String(k);
const yn = (b: boolean | null | undefined) => (b == null ? null : b ? "Yes" : "No");

/* ---- contracts in a period: what happened to them in it, and what they bring in it ---- */
const addYearsIso = (isoD: string, y: number) => {
  const dt = new Date(`${isoD}T12:00:00`);
  dt.setFullYear(dt.getFullYear() + Math.floor(y));
  dt.setMonth(dt.getMonth() + Math.round((y % 1) * 12));
  return isoDay(dt.toISOString())!;
};
const addDaysIso = (isoD: string, n: number) => { const dt = new Date(`${isoD}T12:00:00`); dt.setDate(dt.getDate() + n); return isoDay(dt.toISOString())!; };
const atNoon = (isoD: string) => new Date(`${isoD}T12:00:00`).getTime();
/** What happened to a contract in the report's period, in the order a row is told apart. */
export const PERIOD_STATUS = ["New", "Renewal", "Auto-renews", "Up for renewal", "Ended · renewed", "Ended", "Running", "Not running", "Stopped"] as const;
export const PERIOD_STATUS_HINT: Record<string, string> = {
  New: "Signed in the period (it may start later)",
  Renewal: "Signed in the period as the renewal of an earlier contract",
  "Auto-renews": "Renews by itself in the period",
  "Up for renewal": "Its term ends in the period and it hasn't been renewed yet",
  "Ended · renewed": "Ended in the period; its renewal is a new contract",
  Ended: "Ended in the period and wasn't renewed",
  Running: "Signed before and still running all through the period",
  "Not running": "Not running at any point of the period",
  Stopped: "Taken off the client (not active)",
};
/**
 * A contract's term in a period: when it starts, its renewal dates (the end of its term, and each
 * renewal after that when it renews by itself) and the days of the period it runs.
 */
interface TermShape { start: string | null; years: number; step: number; auto: boolean }
function termEndsUntil(t: TermShape, until: string): string[] {
  if (!t.start || !t.years) return [];
  const out: string[] = [];
  let e = addYearsIso(t.start, t.years);
  out.push(e);
  while (t.auto && e <= until && out.length < 80) { e = addYearsIso(e, t.step || t.years); out.push(e); }
  return out;
}
/** The days of [lo, hi] a contract runs: from its start to the end of its term (open when it renews by itself or has no term). */
function runWindow(t: TermShape, lo: string | null, hi: string | null): [string, string] | null {
  if (!t.start) return null;
  const today = todayIso();
  const top = hi ?? (lo && lo > today ? lo : today);
  const end = !t.years || t.auto ? null : addDaysIso(addYearsIso(t.start, t.years), -1);
  const a = lo && lo > t.start ? lo : t.start;
  const b = end && end < top ? end : top;
  return a <= b ? [a, b] : null;
}

export async function buildCrmFields(source: EntityKey, d: CrmData, extra: EntityKey[] = []): Promise<Field[]> {
  const cw = await import("../../clients/ClientWorkspace");
  const ct = await import("../../clients/clientsTypes");
  const sales = await import("../sales/salesApi");
  const prodName = new Map(d.products.map((p) => [String(p.id), p.name]));
  const svcName = new Map(d.services.map((p) => [String(p.id), p.name]));
  const empName = new Map(d.employees.map((e) => [e.id, e.name]));
  const today = todayIso();
  const groups = partsOf(source, extra);
  const out: Field[] = [];
  const count = (g: EntityKey): Field => ({ key: `${g}.__count`, group: g, label: `Number of ${entityOf(g).plural.toLowerCase()}`, kind: "number", sum: true, get: () => 1 });
  // client figures, from its signed products and projects
  const linesByClient = new Map<string, any[]>(); (d.contract ?? []).forEach((l) => { const k = String(l.client_id); linesByClient.set(k, [...(linesByClient.get(k) ?? []), l]); });
  const projByClient = new Map<string, any[]>(); (d.project ?? []).forEach((p) => { const k = String(p.client_id); projByClient.set(k, [...(projByClient.get(k) ?? []), p]); });
  // a project's value from its row, read the way the Clients page reads it
  const pv = (p: any) => {
    try {
      return ct.projectValue({
        roleLines: ct.parseRoleLines(p.role_lines), consultorDays: Number(p.consultor_days) || 0, connectorDays: Number(p.connector_days) || 0,
        supervisionDays: Number(p.supervision_days) || 0, pricePerDay: Number(p.price_per_day) || 0, supervisionPrice: Number(p.supervision_price) || 0,
        discountMode: p.discount_mode ?? "none", discountValue: Number(p.discount_value) || 0,
        supervisionDiscountMode: p.supervision_discount_mode ?? "none", supervisionDiscountValue: Number(p.supervision_discount_value) || 0,
      } as any);
    } catch { return Number(p.price_per_day ?? 0) * Number(p.consultor_days ?? 0); }
  };
  /* signed products in the report's period (worked out once per line and period) */
  const allLines = d.contract ?? [];
  const renewalDeals = new Set(allLines.map((l) => l.renewal_tracking_id).filter(Boolean).map(String));
  const linesByDeal = new Map<string, any[]>(); allLines.forEach((l) => { if (l.tracking_id) { const k = String(l.tracking_id); linesByDeal.set(k, [...(linesByDeal.get(k) ?? []), l]); } });
  const dealById = new Map((d.deal ?? []).map((t: any) => [String(t.id), t]));
  /** A line signed as the renewal of an older one: its deal is that line's renewal deal (or sits in a renewal pipeline). */
  const isRenewalLine = (l: any) => {
    if (!l.tracking_id) return false;
    if (renewalDeals.has(String(l.tracking_id))) return true;
    const t: any = dealById.get(String(l.tracking_id));
    return !!t && !!d.dealCtx && /renew/i.test(d.dealCtx.pipelineName(t.pipeline_id ?? null) ?? "");
  };
  /** An older line whose renewal was signed (a newer line on its renewal deal). */
  const wasRenewed = (l: any) => !!l.renewal_tracking_id && (linesByDeal.get(String(l.renewal_tracking_id)) ?? []).some((x) => x.id !== l.id);
  const shape = (l: any): TermShape | null => (l ? { start: ymd(l.start_date) ?? ymd(l.signing_date), years: Number(l.term_years) || 0, step: Number(l.renew_years) || Number(l.term_years) || 0, auto: !!l.auto_renew } : null);
  /** What a recurring line bills a year on `day` (its contract year's price; an auto-renewing one keeps its last year's). */
  const annualOn = (l: any, day: string) => {
    let at = atNoon(day);
    const tm = cw.termOf(l);
    if (l.auto_renew && tm && at >= tm.end.getTime()) at = tm.end.getTime() - 864e5;
    return cw.lineAnnual(l, at);
  };
  const periodMemo = new Map<string, { status: string; date: string | null; renewal: string | null; runs: boolean; arr: number; revenue: number }>();
  const inPeriodOf = (l: any) => {
    const [lo, hi] = resolvePeriod(PARAM.key, PARAM.from, PARAM.to);
    const mk = `${l.id}|${lo}|${hi}`;
    const hit = periodMemo.get(mk);
    if (hit) return hit;
    const t = shape(l)!;
    const inR = (x: string | null) => !!x && (!lo || x >= lo) && (!hi || x <= hi);
    const active = cw.isActive(l);
    const win = active ? runWindow(l.recurring ? t : { ...t, years: 0 }, lo, hi) : null;
    const runs = !!win && (l.recurring || inR(t.start));
    const renewal = t.years ? termEndsUntil(t, hi ?? addYearsIso(todayIso(), 5)).find(inR) ?? null : null;
    // new / renewal: closed (signed) in the period — it may start later
    const signed = ymd(l.signing_date) ?? t.start;
    let status: string;
    if (!active) status = "Stopped";
    else if (inR(signed)) status = isRenewalLine(l) ? "Renewal" : "New";
    else if (renewal && t.auto) status = "Auto-renews";
    else if (renewal) status = wasRenewed(l) ? "Ended · renewed" : renewal > todayIso() ? "Up for renewal" : "Ended";
    else status = runs && l.recurring ? "Running" : "Not running";
    // ARR: what it bills a year on the last day of the period it runs; revenue: each part of the period at its year's price
    let arr = 0, revenue = 0;
    if (win && l.recurring) {
      arr = annualOn(l, win[1]);
      const cuts = [win[0]];
      if (t.start) for (let k = 1; k < 80; k++) { const a = addYearsIso(t.start, k); if (a > win[1]) break; if (a > win[0]) cuts.push(a); }
      cuts.push(addDaysIso(win[1], 1));
      for (let i = 0; i < cuts.length - 1; i++) revenue += (annualOn(l, cuts[i]) * daysBetween(cuts[i], cuts[i + 1])) / 365;
    }
    if (active && !l.recurring && inR(t.start)) revenue += cw.lineOneTime(l);
    else if (active && l.recurring && inR(t.start)) revenue += Number(l.one_time_fee) || 0;
    const out = { status, date: inR(signed) ? signed : renewal, renewal: inR(signed) && isRenewalLine(l) ? signed : renewal, runs, arr: Math.round(arr * 100) / 100, revenue: Math.round(revenue * 100) / 100 };
    periodMemo.set(mk, out);
    return out;
  };
  for (const g of groups) {
    let fs: Field[] = [];
    if (g === "deal" && d.dealCtx) {
      fs = buildFields({ ...d.dealCtx, contacts: [], companies: d.company ?? [] }).filter((f) => f.group === "deal");
      fs.unshift({ key: "deal.name", group: "deal", label: "Deal name", kind: "text", get: (r: any) => r.deal?.deal_name?.trim() || (r.company?.name ?? null) });
      // every product and service on the deal (not only the first one)
      fs.push(
        { key: "deal.products_all", group: "deal", label: "Products on the deal", kind: "enum", options: d.products.map((x) => x.name), get: (r: any) => (r.deal?.__products ?? []).join(", ") || null, list: (r: any) => r.deal?.__products ?? [] },
        { key: "deal.services_all", group: "deal", label: "Services on the deal", kind: "enum", options: d.services.map((x) => x.name), get: (r: any) => (r.deal?.__services ?? []).join(", ") || null, list: (r: any) => r.deal?.__services ?? [] },
        { key: "deal.has_contract", group: "deal", label: "Has a signed contract", kind: "enum", options: ["Yes", "No"], get: (r: any) => (r.deal ? yn(!!(r.deal.contract_terms && typeof r.deal.contract_terms === "object")) : null) },
      );
    } else if (g === "company") {
      fs = [
        { key: "company.name", group: g, label: "Name", kind: "text", get: (r: any) => r.company?.name ?? null },
        { key: "company.types", group: g, label: "Type", kind: "enum", options: [...REL_NAMES.map((x) => x[1]), ...d.relTags], get: (r: any) => (r.company?.relationship ?? []).map(relName).join(", ") || null, list: (r: any) => (r.company?.relationship ?? []).map(relName) },
        { key: "company.country_name", group: g, label: "Country", kind: "enum", get: (r: any) => (r.company?.country ? countryName(r.company.country) : null) },
        { key: "company.is_client", group: g, label: "Is a client", kind: "enum", options: ["Yes", "No"], get: (r: any) => yn(!!r.client) },
        ...withCustomDefs(discovered(d.company ?? [], "company", /^company\.(name|relationship|country)$/), "company", (r) => (r as any).company),
      ];
    } else if (g === "contact") {
      fs = [
        { key: "contact.name", group: g, label: "Full name", kind: "text", get: (r: any) => (r.contact ? [r.contact.first_name, r.contact.last_name].filter(Boolean).join(" ") || null : null) },
        { key: "contact.country_name", group: g, label: "Country", kind: "enum", get: (r: any) => (r.contact?.country ? countryName(r.contact.country) : null) },
        { key: "contact.companies", group: g, label: "Companies they're at", kind: "number", get: (r: any) => r.contact?.companyIds?.length ?? 0 },
        ...withCustomDefs(discovered(d.contact ?? [], "contact", /compan|^contact\.country$/i), "contact", (r) => (r as any).contact),
      ];
    } else if (g === "client") {
      fs = [
        { key: "client.name", group: g, label: "Client", kind: "text", get: (r: any) => r.client?.name ?? null },
        { key: "client.projects", group: g, label: "Projects", kind: "number", sum: true, get: (r: any) => (projByClient.get(String(r.client?.id)) ?? []).length },
        { key: "client.projects_value", group: g, label: "Projects value", kind: "money", sum: true, get: (r: any) => (projByClient.get(String(r.client?.id)) ?? []).reduce((t, p) => t + pv(p), 0) },
        { key: "client.recurring", group: g, label: "Recurring today (per year)", kind: "money", sum: true, get: (r: any) => (linesByClient.get(String(r.client?.id)) ?? []).filter(cw.isActive).reduce((t, l) => t + cw.lineAnnual(l), 0) },
        { key: "client.contract_value", group: g, label: "Signed products value", kind: "money", sum: true, get: (r: any) => (linesByClient.get(String(r.client?.id)) ?? []).filter(cw.isActive).reduce((t, l) => t + cw.lineContractValue(l), 0) },
        { key: "client.products", group: g, label: "Signed products", kind: "number", sum: true, get: (r: any) => (linesByClient.get(String(r.client?.id)) ?? []).length },
        { key: "client.next_renewal", group: g, label: "Next renewal", kind: "date", get: (r: any) => { const ts = (linesByClient.get(String(r.client?.id)) ?? []).filter(cw.isActive).map(cw.termOf).filter((t): t is NonNullable<ReturnType<typeof cw.termOf>> => !!t && t.left >= 0).sort((a, b) => a.end.getTime() - b.end.getTime()); return ts[0] ? ymd(ts[0].end.toISOString()) : null; } },
        ...discovered(d.client ?? [], "client", /^client\.name$/),
      ];
    } else if (g === "project") {
      fs = [
        { key: "project.name", group: g, label: "Project", kind: "text", get: (r: any) => r.project?.name || r.project?.legal_name || null },
        { key: "project.type", group: g, label: "Service", kind: "enum", options: d.services.map((x) => x.name), get: (r: any) => svcName.get(String(r.project?.service_id ?? r.project?.project_type_id ?? "")) ?? null },
        { key: "project.status_label", group: g, label: "Status", kind: "enum", options: Object.values(ct.PROJECT_STATUS_LABEL), get: (r: any) => (r.project ? ct.PROJECT_STATUS_LABEL[ct.projectStatusOf(r.project.status)] : null) },
        { key: "project.value", group: g, label: "Project value", kind: "money", sum: true, get: (r: any) => (r.project ? pv(r.project) : null) },
        { key: "project.team_size", group: g, label: "People on it", kind: "number", get: (r: any) => (Array.isArray(r.project?.team) ? r.project.team.length : null) },
        { key: "project.country_name", group: g, label: "Country", kind: "enum", get: (r: any) => (r.project?.address?.country ? countryName(r.project.address.country) : null) },
        ...discovered(d.project ?? [], "project", /^project\.(name|status)$/),
      ];
    } else if (g === "contract") {
      fs = [
        { key: "contract.product", group: g, label: "Product", kind: "enum", options: d.products.map((x) => x.name), get: (r: any) => prodName.get(String(r.contract?.product_id)) ?? null },
        { key: "contract.kind", group: g, label: "Kind", kind: "enum", options: ["Subscription", "One-off"], get: (r: any) => (r.contract ? (r.contract.recurring ? "Subscription" : "One-off") : null) },
        { key: "contract.annual_now", group: g, label: "Recurring today (per year)", kind: "money", sum: true, get: (r: any) => (r.contract ? cw.lineAnnual(r.contract) : null) },
        { key: "contract.value", group: g, label: "Contract value", kind: "money", sum: true, get: (r: any) => (r.contract ? cw.lineContractValue(r.contract) : null) },
        { key: "contract.one_time", group: g, label: "One-time amount", kind: "money", sum: true, get: (r: any) => (r.contract ? cw.lineOneTime(r.contract) : null) },
        { key: "contract.end", group: g, label: "Ends", kind: "date", get: (r: any) => { const e = r.contract ? sales.lineEnd(r.contract) : null; return e ? ymd(new Date(e).toISOString()) : null; } },
        { key: "contract.running", group: g, label: "Running today", kind: "enum", options: ["Yes", "No"], get: (r: any) => (r.contract ? yn(cw.lineAnnual(r.contract) > 0 || (!r.contract.recurring && cw.isActive(r.contract))) : null) },
        { key: "contract.days_left", group: g, label: "Days to the end", kind: "number", get: (r: any) => { const e = r.contract ? sales.lineEnd(r.contract) : null; return e ? daysBetween(today, ymd(new Date(e).toISOString())!) : null; } },
        { key: "contract.signed", group: g, label: "Signed on", kind: "date", get: (r: any) => ymd(r.contract?.signing_date) ?? ymd(r.contract?.start_date) },
        { key: "contract.starts", group: g, label: "Starts", kind: "date", get: (r: any) => ymd(r.contract?.start_date) ?? ymd(r.contract?.signing_date) },
        { key: "contract.renews_auto", group: g, label: "Renews by itself", kind: "enum", options: ["Yes", "No"], get: (r: any) => (r.contract ? yn(!!r.contract.auto_renew) : null) },
        { key: "contract.next_renewal", group: g, label: "Next renewal", kind: "date", get: (r: any) => { const t = shape(r.contract); if (!t) return null; return termEndsUntil(t, addYearsIso(today, 1)).find((e) => e >= today) ?? null; } },
        // the report's period
        { key: "contract.period_status", group: g, label: "In the period", kind: "enum", options: [...PERIOD_STATUS], get: (r: any) => (r.contract ? inPeriodOf(r.contract).status : null) },
        { key: "contract.period_date", group: g, label: "Signed or renews in the period", kind: "date", get: (r: any) => (r.contract ? inPeriodOf(r.contract).date : null) },
        { key: "contract.renewal_in_period", group: g, label: "Renewal date in the period", kind: "date", get: (r: any) => (r.contract ? inPeriodOf(r.contract).renewal : null) },
        { key: "contract.runs_in_period", group: g, label: "Runs in the period", kind: "enum", options: ["Yes", "No"], get: (r: any) => (r.contract ? yn(inPeriodOf(r.contract).runs) : null) },
        { key: "contract.arr_period", group: g, label: "ARR in the period", kind: "money", sum: true, get: (r: any) => (r.contract ? inPeriodOf(r.contract).arr : null) },
        { key: "contract.arr_first", group: g, label: "First-year ARR (as signed)", kind: "money", sum: true, get: (r: any) => { const l = r.contract; if (!l?.recurring) return l ? 0 : null; const st = ymd(l.start_date) ?? ymd(l.signing_date); return st ? Math.round(cw.lineAnnual(l, atNoon(st)) * 100) / 100 : null; } },
        { key: "contract.revenue_period", group: g, label: "Revenue in the period", kind: "money", sum: true, get: (r: any) => (r.contract ? inPeriodOf(r.contract).revenue : null) },
        ...discovered(d.contract ?? [], "contract"),
      ];
    } else if (g === "agreement") {
      const FREQ: Record<string, string> = { upfront: "Upfront", annually: "Yearly", semiannually: "Every 6 months", quarterly: "Quarterly", monthly: "Monthly", on_delivery: "On delivery" };
      const freq = (v: any) => (v ? FREQ[String(v)] ?? String(v) : null);
      const num = (v: any) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
      const endOf = (a: any) => {
        const st = ymd(a?.contractStart) ?? ymd(a?.signDate); const y = num(a?.termYears);
        if (!st || !y) return null;
        const dt = new Date(`${st}T12:00:00`); dt.setMonth(dt.getMonth() + Math.round(y * 12)); dt.setDate(dt.getDate() - 1);
        return dt.toISOString().slice(0, 10);
      };
      const lines = (a: any, kind: "product" | "service") => (Array.isArray(a?.lines) ? a.lines : []).filter((l: any) => l?.kind === kind).map((l: any) => String(l.name ?? "").trim()).filter(Boolean);
      const A = (r: any) => r.agreement;
      const agShape = (a: any): TermShape | null => (a ? { start: ymd(a.contractStart) ?? ymd(a.signDate), years: num(a.termYears) ?? 0, step: num(a.renewYears) ?? num(a.termYears) ?? 0, auto: !!a.autoRenew } : null);
      /** A contract in the report's period: what happened in it, and its licences' yearly value there (from its year-by-year schedule). */
      const agPeriod = (a: any) => {
        const [lo, hi] = resolvePeriod(PARAM.key, PARAM.from, PARAM.to);
        const t = agShape(a)!;
        const inR = (x: string | null) => !!x && (!lo || x >= lo) && (!hi || x <= hi);
        const renewal = t.years ? termEndsUntil(t, hi ?? addYearsIso(today, 5)).find(inR) ?? null : null;
        const win = runWindow(t, lo, hi);
        const status = a.deal_status && a.deal_status !== "won" ? "Not running" : inR(t.start) ? "New" : renewal && t.auto ? "Auto-renews" : renewal ? (renewal > today ? "Up for renewal" : "Ended") : win ? "Running" : "Not running";
        const sch: any[] = Array.isArray(a.schedule) ? a.schedule : [];
        let arr = 0;
        if (win && sch.length && t.start) {
          const yi = Math.max(0, Math.floor(daysBetween(t.start, win[1]) / 365.25));
          arr = Number(sch[Math.min(yi, sch.length - 1)]?.license) || 0;
        }
        return { status, date: inR(t.start) ? t.start : renewal, renewal, arr };
      };
      const owners = d.dealCtx?.trackOwners ?? {};
      fs = [
        { key: "agreement.ref", group: g, label: "Contract ref.", kind: "text", get: (r: any) => A(r)?.contractRef || null },
        { key: "agreement.deal", group: g, label: "Deal", kind: "text", get: (r: any) => A(r)?.deal_name?.trim() || r.company?.name || null },
        { key: "agreement.customer", group: g, label: "Customer (legal name)", kind: "text", get: (r: any) => A(r)?.customer?.legalName || A(r)?.customer?.name || r.company?.legal_name || r.company?.name || null },
        { key: "agreement.vat", group: g, label: "Customer VAT", kind: "text", get: (r: any) => A(r)?.customer?.vat || null },
        { key: "agreement.country", group: g, label: "Customer country", kind: "enum", get: (r: any) => (A(r)?.customer?.country ? countryName(A(r).customer.country) : null) },
        { key: "agreement.owner", group: g, label: "Owner", kind: "enum", options: d.employees.map((e) => e.name), get: (r: any) => empName.get(owners[String(A(r)?.id)] ?? "") ?? null },
        { key: "agreement.signed", group: g, label: "Signed on", kind: "date", get: (r: any) => ymd(A(r)?.signDate) },
        { key: "agreement.start", group: g, label: "Starts", kind: "date", get: (r: any) => ymd(A(r)?.contractStart) },
        { key: "agreement.end", group: g, label: "Ends", kind: "date", get: (r: any) => endOf(A(r)) },
        { key: "agreement.term", group: g, label: "Term (years)", kind: "number", get: (r: any) => num(A(r)?.termYears) },
        { key: "agreement.running", group: g, label: "Running today", kind: "enum", options: ["Yes", "No"], get: (r: any) => { const a = A(r); if (!a) return null; const st = ymd(a.contractStart) ?? ymd(a.signDate); const e = endOf(a); return yn(!!st && st <= today && (!e || e >= today || !!a.autoRenew)); } },
        { key: "agreement.days_left", group: g, label: "Days to the end", kind: "number", get: (r: any) => { const e = endOf(A(r)); return e ? daysBetween(today, e) : null; } },
        { key: "agreement.auto_renew", group: g, label: "Renews by itself", kind: "enum", options: ["Yes", "No"], get: (r: any) => (A(r) ? yn(!!A(r).autoRenew) : null) },
        { key: "agreement.renew_years", group: g, label: "Renews for (years)", kind: "number", get: (r: any) => num(A(r)?.renewYears) },
        { key: "agreement.locked_years", group: g, label: "Can't be ended for (years)", kind: "number", get: (r: any) => num(A(r)?.nonTerminableYears) },
        { key: "agreement.total", group: g, label: "Contract total", kind: "money", sum: true, get: (r: any) => num(A(r)?.total) },
        { key: "agreement.year1", group: g, label: "First year", kind: "money", sum: true, get: (r: any) => num(Array.isArray(A(r)?.schedule) ? A(r).schedule[0]?.total : null) },
        { key: "agreement.per_year", group: g, label: "Per year (average)", kind: "money", sum: true, get: (r: any) => { const t = num(A(r)?.total), y = num(A(r)?.termYears); return t != null && y ? t / y : null; } },
        { key: "agreement.licence", group: g, label: "Licences (after discount)", kind: "money", sum: true, get: (r: any) => num(A(r)?.license?.final) },
        { key: "agreement.licence_list", group: g, label: "Licences (list price)", kind: "money", sum: true, get: (r: any) => num(A(r)?.license?.list) },
        { key: "agreement.licence_discount", group: g, label: "Licence discount", kind: "money", sum: true, get: (r: any) => num(A(r)?.license?.discount) },
        { key: "agreement.licence_y1", group: g, label: "Licences, first year", kind: "money", sum: true, get: (r: any) => num(A(r)?.license?.firstYear) },
        { key: "agreement.services", group: g, label: "Services (after discount)", kind: "money", sum: true, get: (r: any) => num(A(r)?.services?.final) },
        { key: "agreement.services_list", group: g, label: "Services (list price)", kind: "money", sum: true, get: (r: any) => num(A(r)?.services?.list) },
        { key: "agreement.services_discount", group: g, label: "Services discount", kind: "money", sum: true, get: (r: any) => num(A(r)?.services?.discount) },
        { key: "agreement.products", group: g, label: "Products in it", kind: "enum", options: d.products.map((x) => x.name), get: (r: any) => lines(A(r), "product").join(", ") || null, list: (r: any) => lines(A(r), "product") },
        { key: "agreement.service_names", group: g, label: "Services in it", kind: "enum", options: d.services.map((x) => x.name), get: (r: any) => lines(A(r), "service").join(", ") || null, list: (r: any) => lines(A(r), "service") },
        { key: "agreement.lines", group: g, label: "Lines", kind: "number", sum: true, get: (r: any) => (Array.isArray(A(r)?.lines) ? A(r).lines.length : null) },
        // the report's period
        { key: "agreement.period_status", group: g, label: "In the period", kind: "enum", options: [...PERIOD_STATUS], get: (r: any) => (A(r) ? agPeriod(A(r)).status : null) },
        { key: "agreement.period_date", group: g, label: "Signed or renews in the period", kind: "date", get: (r: any) => (A(r) ? agPeriod(A(r)).date : null) },
        { key: "agreement.renewal_in_period", group: g, label: "Renewal date in the period", kind: "date", get: (r: any) => (A(r) ? agPeriod(A(r)).renewal : null) },
        { key: "agreement.next_renewal", group: g, label: "Next renewal", kind: "date", get: (r: any) => { const t = agShape(A(r)); return t ? termEndsUntil(t, addYearsIso(today, 1)).find((e) => e >= today) ?? null : null; } },
        { key: "agreement.arr_period", group: g, label: "ARR in the period (licences)", kind: "money", sum: true, get: (r: any) => (A(r) ? agPeriod(A(r)).arr : null) },
        { key: "agreement.billing", group: g, label: "Licences billed", kind: "enum", options: Object.values(FREQ), get: (r: any) => freq(A(r)?.billingFrequency) },
        { key: "agreement.services_billing", group: g, label: "Services billed", kind: "enum", options: Object.values(FREQ), get: (r: any) => freq(A(r)?.servicesFrequency) },
        { key: "agreement.pay_days", group: g, label: "Payment terms (days)", kind: "number", get: (r: any) => num(A(r)?.paymentTermsDays) },
        { key: "agreement.currency", group: g, label: "Currency", kind: "enum", get: (r: any) => A(r)?.currency || null },
        { key: "agreement.contact", group: g, label: "Customer contact", kind: "text", get: (r: any) => A(r)?.contactPerson?.name || null },
        { key: "agreement.contact_email", group: g, label: "Customer contact e-mail", kind: "text", get: (r: any) => A(r)?.contactPerson?.email || null },
        { key: "agreement.contact_phone", group: g, label: "Customer contact phone", kind: "text", get: (r: any) => A(r)?.contactPerson?.phone || null },
        { key: "agreement.admin", group: g, label: "Admin user", kind: "text", get: (r: any) => A(r)?.adminUser?.name || A(r)?.adminUser?.email || null },
        { key: "agreement.document", group: g, label: "Signed document attached", kind: "enum", options: ["Yes", "No"], get: (r: any) => (A(r) ? yn(!!A(r).documentFileId) : null) },
        { key: "agreement.esign", group: g, label: "Signed with", kind: "enum", get: (r: any) => A(r)?.esignProvider || null },
        { key: "agreement.deal_status", group: g, label: "Deal status", kind: "enum", options: Object.values(STATUS_LABEL), get: (r: any) => (A(r)?.deal_status ? STATUS_LABEL[A(r).deal_status] ?? A(r).deal_status : null) },
      ];
    } else if (g === "invoice") {
      fs = [
        { key: "invoice.status_label", group: g, label: "Status", kind: "enum", options: ["Sent", "Paid", "Overdue"], get: (r: any) => { const i = r.invoice; if (!i) return null; if (i.status === "paid") return "Paid"; return i.due_date && String(i.due_date).slice(0, 10) < today ? "Overdue" : "Sent"; } },
        { key: "invoice.days_late", group: g, label: "Days late", kind: "number", get: (r: any) => { const i = r.invoice; if (!i?.due_date) return null; const end = i.status === "paid" ? ymd(i.paid_date) ?? today : today; const n = daysBetween(String(i.due_date).slice(0, 10), end); return n > 0 ? n : 0; } },
        { key: "invoice.vat", group: g, label: "VAT amount", kind: "money", sum: true, get: (r: any) => (r.invoice ? (Number(r.invoice.amount) || 0) - (Number(r.invoice.net) || 0) : null) },
        ...discovered(d.invoice ?? [], "invoice", /^invoice\.status$/),
      ];
    } else if (g === "ticket") {
      const STAGE: Record<string, string> = { new: "New", open: "Open", in_progress: "In progress", waiting: "Waiting", resolved: "Resolved", closed: "Closed" };
      fs = [
        { key: "ticket.title", group: g, label: "Title", kind: "text", get: (r: any) => r.ticket?.title ?? null },
        { key: "ticket.what", group: g, label: "Ticket or task", kind: "enum", options: ["Ticket", "Task"], get: (r: any) => { const t = r.ticket; if (!t) return null; const isTicket = t.category ? t.category === "ticket" : !!(t.requester_email || t.requester_name || ["email", "phone", "portal", "message"].includes(t.source)); return isTicket ? "Ticket" : "Task"; } },
        { key: "ticket.deal", group: g, label: "On a deal", kind: "enum", options: ["Yes", "No"], get: (r: any) => (r.ticket ? yn(!!r.ticket.tracking_id) : null) },
        { key: "ticket.stage_label", group: g, label: "Stage", kind: "enum", options: Object.values(STAGE), get: (r: any) => (r.ticket ? STAGE[r.ticket.stage] ?? (r.ticket.done ? "Resolved" : "Open") : null) },
        { key: "ticket.priority_label", group: g, label: "Priority", kind: "enum", options: ["Urgent", "High", "Normal", "Low"], get: (r: any) => (r.ticket?.priority ? String(r.ticket.priority).replace(/^\w/, (c: string) => c.toUpperCase()) : null) },
        { key: "ticket.assignee", group: g, label: "Assignee", kind: "enum", options: d.employees.map((e) => e.name), get: (r: any) => empName.get(r.ticket?.assignee_id ?? "") ?? null },
        { key: "ticket.open", group: g, label: "Open", kind: "enum", options: ["Yes", "No"], get: (r: any) => (r.ticket ? yn(!["resolved", "closed"].includes(r.ticket.stage) && !r.ticket.done) : null) },
        { key: "ticket.age", group: g, label: "Age (days)", kind: "number", get: (r: any) => { const c = ymd(r.ticket?.created_at); return c ? daysBetween(c, ymd(r.ticket.resolved_at ?? r.ticket.completed_at) ?? today) : null; } },
        { key: "ticket.first_response_h", group: g, label: "First response (hours)", kind: "number", get: (r: any) => { const t = r.ticket; if (!t?.first_response_at || !t.created_at) return null; return Math.round((new Date(t.first_response_at).getTime() - new Date(t.created_at).getTime()) / 36e5 * 10) / 10; } },
        ...discovered(d.ticket ?? [], "ticket", /^ticket\.(title|stage|priority|checklist|description|category|merged_into|external_ref|share_client|template_id|promoted_at)$/),
      ];
    }
    // deals already have theirs ("Number of deals")
    if (g !== "deal") fs.push(count(g));
    out.push(...guard(fs.filter((f, i, all) => all.findIndex((x) => x.key === f.key) === i), g));
  }
  return out;
}
const countryName = (v: any) => { const s = String(v ?? "").trim(); try { if (/^[A-Z]{2}$/i.test(s)) return new Intl.DisplayNames(["en"], { type: "region" }).of(s.toUpperCase()) ?? s; } catch { /* keep */ } return s || null; };

/* ---- charts on any field ---- */
export type CrmFn = "count" | "sum" | "avg" | "min" | "max";
export const FN_LABEL: Record<CrmFn, string> = { count: "Count", sum: "Sum", avg: "Average", min: "Lowest", max: "Highest" };
/**
 * Group rows by a field (or a date field by week / month / quarter / year) and compute a figure:
 * how many, or the sum / average / lowest / highest of a numeric field. `split` makes one series per value.
 */
export function aggregateCrm(opts: {
  rows: any[]; dim: string; fn: CrmFn; value?: string | null; split?: string | null; fieldByKey: Map<string, Field>; cumulative?: boolean; limit?: number;
  /** How the bars are ordered: auto (a list's own order, else biggest first), biggest / smallest first, or A → Z. Time always runs in order. */
  order?: "auto" | "high" | "low" | "az";
  /** Past the limit, the rest add up as "Other" (default); false: they are left out (a "top 10"). */
  other?: boolean;
}): Agg {
  const { rows, dim, value, split, fieldByKey } = opts;
  const tm = /^time:(week|month|quarter|year):(.+)$/.exec(dim);
  const dimF = tm ? fieldByKey.get(tm[2]) : fieldByKey.get(dim);
  const valF = value ? fieldByKey.get(value) : undefined;
  const splitF = split ? fieldByKey.get(split) : undefined;
  const keyOf = (r: any): string[] => {
    if (tm) { const d = isoDay(dimF?.get(r)); if (!d) return []; const g = tm[1]; return [g === "year" ? d.slice(0, 4) : g === "week" ? weekKey(d) : g === "quarter" ? quarterKey(d) : monthKey(d)]; }
    if (dimF?.list) { const l = dimF.list(r); return l.length ? l : ["—"]; }
    const v = dimF?.get(r); return [v == null || v === "" ? "—" : String(v)];
  };
  const buckets = new Map<string, Map<string, any[]>>();
  const sv = new Set<string>();
  rows.forEach((r) => {
    const s = splitF ? (() => { const v = splitF.get(r); return v == null || v === "" ? "—" : String(v); })() : "_";
    sv.add(s);
    keyOf(r).forEach((k) => { if (!buckets.has(k)) buckets.set(k, new Map()); const m = buckets.get(k)!; if (!m.has(s)) m.set(s, []); m.get(s)!.push(r); });
  });
  // percentages don't add up: their "sum" is their average
  const fn = opts.fn === "sum" && valF?.kind === "percent" ? "avg" : opts.fn;
  const calc = (rs: any[]) => {
    if (fn === "count" || !valF) return rs.length;
    const ns = rs.map((r) => Number(valF.get(r))).filter((n) => Number.isFinite(n));
    if (!ns.length) return 0;
    if (fn === "sum") return ns.reduce((a, b) => a + b, 0);
    if (fn === "avg") return ns.reduce((a, b) => a + b, 0) / ns.length;
    return fn === "min" ? Math.min(...ns) : Math.max(...ns);
  };
  let keys = [...buckets.keys()];
  const total = (k: string) => [...buckets.get(k)!.values()].reduce((a, rs) => a + calc(rs), 0);
  if (tm) keys.sort();
  else {
    const known = dimF?.options;
    const order = opts.order ?? "auto";
    const tot = new Map(keys.map((k) => [k, total(k)]));
    keys.sort((a, b) => {
      if (a === "—") return 1; if (b === "—") return -1;
      if (order === "high") return tot.get(b)! - tot.get(a)!;
      if (order === "low") return tot.get(a)! - tot.get(b)!;
      if (order === "az") return a.localeCompare(b, undefined, { numeric: true });
      if (known?.length) { const ia = known.indexOf(a), ib = known.indexOf(b); if (ia >= 0 && ib >= 0) return ia - ib; }
      return tot.get(b)! - tot.get(a)!;
    });
    const limit = opts.limit ?? 14;
    if (keys.length > limit && opts.other === false) keys = keys.filter((k) => k !== "—").slice(0, limit);
    else if (keys.length > limit) {
      const keep = keys.slice(0, limit - 1), rest = keys.slice(limit - 1);
      const other = new Map<string, any[]>();
      rest.forEach((k) => buckets.get(k)!.forEach((rs, s) => { if (!other.has(s)) other.set(s, []); other.get(s)!.push(...rs); }));
      buckets.set("Other", other); keys = [...keep, "Other"];
    }
  }
  const names = splitF ? [...sv].sort((a, b) => (a === "—" ? 1 : b === "—" ? -1 : a.localeCompare(b))) : ["_"];
  // figures are formatted like the field they come from
  const measure: Measure = fn === "count" || !valF ? "count" : valF.kind === "money" ? "revenue" : valF.kind === "percent" ? "avgprob" : "count";
  const series: Series[] = names.map((s) => { let run = 0; return { name: s === "_" ? (fn === "count" || !valF ? "Count" : `${FN_LABEL[fn]} of ${valF.label}`) : s, values: keys.map((k) => { const v = calc(buckets.get(k)!.get(s) ?? []); if (opts.cumulative) { run += v; return run; } return v; }) }; });
  const g = (tm?.[1] ?? "month") as TimeGrain | "year";
  return { labels: keys.map((k) => (tm ? (g === "year" ? k : timeLabel(k, g as TimeGrain)) : k)), keys, series, measure, lost: tm ? undefined : dimF?.lost };
}
