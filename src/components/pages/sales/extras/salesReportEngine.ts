/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../../api/supabase";
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
export type Group = "deal" | "contact" | "company";
export type RowMode = "deals" | "contacts" | "companies";
export type Source = "deal" | "company" | "both";
export type ProbSource = "phase" | "rep" | "mgr" | "avg";

export interface Row { deal: Tracking; contact: Contact | null; company: Company | null }
export interface Field {
  key: string; group: Group; label: string; kind: Kind; options?: string[]; sum?: boolean; get: (r: Row) => any;
  /** Multiple-choice fields: the picked values, so "is any of" matches any of them. */
  list?: (r: Row) => string[];
}
export interface Cond { id: string; field: string; op: string; a: string; b: string; vals: string[] }

export const GROUP_LABEL: Record<Group, string> = { deal: "Deal", contact: "Contact", company: "Company" };
export const STATUS_LABEL: Record<string, string> = { active: "Active", won: "Won", lost: "Lost", paused: "Hold" };

export const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export const uid = () => Math.random().toString(36).slice(2, 10);
export const isoDay = (v: any): string | null => (v ? String(v).slice(0, 10) : null);
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
export const periodLabel = (key: string) => PERIODS.find((p) => p.key === key)?.label ?? key;
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
  text: [{ value: "contains", label: "contains" }, { value: "not_contains", label: "doesn't contain" }, { value: "is_set", label: "is filled" }, { value: "is_empty", label: "is empty" }],
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
  if (f.kind === "enum") return c.vals.length > 0;
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
  if (f.kind === "enum") { const s = empty ? "" : String(v); return c.op === "in" ? c.vals.includes(s) : !c.vals.includes(s); }
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

/** One report / export field for a custom field definition, typed by its definition. */
export function customDefField(group: Group, d: CustomDef, pick: (r: Row) => any): Field {
  const key = `${group}.custom.${d.id}`;
  const raw = (r: Row) => pick(r)?.custom?.[d.id];
  switch (d.type) {
    case "boolean": return { key, group, label: d.label, kind: "enum", options: ["Yes", "No"], get: (r) => { const v = raw(r); return v === true || v === "true" ? "Yes" : v === false || v === "false" ? "No" : null; } };
    case "select": return { key, group, label: d.label, kind: "enum", options: d.options, get: (r) => { const v = raw(r); return v == null || v === "" ? null : Array.isArray(v) ? v.join(", ") : String(v); } };
    case "multiselect": return {
      key, group, label: d.label, kind: "enum", options: d.options,
      get: (r) => { const l = asList(raw(r)); return l.length ? l.join(", ") : null; },
      list: (r) => asList(raw(r)),
    };
    case "number": return { key, group, label: d.label, kind: "number", get: (r) => { const v = raw(r); const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; } };
    case "date": return { key, group, label: d.label, kind: "date", get: (r) => isoDay(raw(r)) };
    default: return { key, group, label: d.label, kind: "text", get: (r) => { const v = raw(r); return v == null || v === "" ? null : Array.isArray(v) ? v.join(", ") : String(v); } };
  }
}

/**
 * Swap the data-guessed custom fields of a group for the defined ones: every
 * definition (in the order set in Settings, typed properly — multiple choice
 * included) plus any leftover key found in the data that has no definition.
 */
export function withCustomDefs<F extends Field>(fields: F[], group: Group, pick: (r: Row) => any): F[] {
  const defs = [...customDefs(group)].sort((a, b) => a.sort - b.sort);
  if (!defs.length) return fields;
  const defined = new Set(defs.map((d) => `${group}.custom.${d.id}`));
  const pre = `${group}.custom.`;
  const plain = fields.filter((f) => !f.key.startsWith(pre));
  const leftovers = fields.filter((f) => f.key.startsWith(pre) && !defined.has(f.key));
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
    { key: "deal.phase", group: "deal", label: "Phase", kind: "enum", options: ctx.phaseNames, get: (r) => { const n = ctx.phaseName(r.deal); return n === "—" ? null : n; } },
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
export function dealCustomFields(defs: TrackingField[]): Field[] {
  return defs.map((d): Field => {
    const raw = (r: Row) => (r.deal as any).custom?.[d.id];
    if ((d.type as string) === "multiselect") return { ...customDefField("deal", { id: d.id, label: d.label, type: "multiselect", options: d.options, sort: d.sort }, (r) => r.deal), key: `deal.custom.${d.id}` };
    if (d.type === "boolean") return { key: `deal.custom.${d.id}`, group: "deal", label: d.label, kind: "enum", options: ["Yes", "No"], get: (r) => { const v = raw(r); return v === true ? "Yes" : v === false ? "No" : null; } };
    if (d.type === "select") return { key: `deal.custom.${d.id}`, group: "deal", label: d.label, kind: "enum", options: d.options, get: (r) => { const v = raw(r); return v == null || v === "" ? null : String(v); } };
    if (d.type === "number") return { key: `deal.custom.${d.id}`, group: "deal", label: d.label, kind: "number", get: (r) => { const v = raw(r); const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; } };
    if (d.type === "date") return { key: `deal.custom.${d.id}`, group: "deal", label: d.label, kind: "date", get: (r) => isoDay(raw(r)) };
    return { key: `deal.custom.${d.id}`, group: "deal", label: d.label, kind: "text", get: (r) => { const v = raw(r); return v == null || v === "" ? null : String(v); } };
  });
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
export const fmtMoney = (n: number) => `${Math.round(n).toLocaleString("es-ES")} €`;
export const fmtDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };
export function showCell(f: Field, c: Cell): string {
  if (c == null) return "";
  if (typeof c === "object") return fmtDate(c.date);
  if (typeof c === "number") return f.kind === "money" ? fmtMoney(c) : f.kind === "percent" ? `${Math.round(c)}%` : c.toLocaleString("es-ES");
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
export interface Agg { labels: string[]; keys: string[]; series: Series[]; measure: Measure }

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