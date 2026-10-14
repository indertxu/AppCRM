/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Importing deals (trackings) from another CRM's Excel / CSV export.
 *
 * Everything here is pure (no React) so it can be tested on its own:
 *   - what each column can be mapped to, and the automatic guesses
 *   - matching a file value to one of our options (pipeline, phase, status,
 *     product, loss reason, choice-list field, person)
 *   - the plan: for every row, the company / contact it links to (found or
 *     created), the pipeline + phase + status, who owns it, and what's wrong
 *   - running the import
 */
import { supabase } from "../../../api/supabase";
import { cellText, normHeader, parseBool, parseDate, parseNumber, type SheetCell } from "../../../framework/spreadsheetImport";
import type { Company, Contact } from "../../companies/companiesApi";
import { saveCompany, saveContact } from "../../companies/companiesApi";
import type { Pipeline, Phase } from "../../settings/pipelineApi";
import type { Product } from "../../settings/catalogApi";
import type { LossReason, Tracking } from "../sales/salesApi";
import { addLossReason } from "../sales/salesApi";
import type { TrackingField } from "./trackingFieldsApi";
import { addTrackingField, updateTrackingField, listTrackingFields } from "./trackingFieldsApi";
import { orderPhases, resolveDealRole, rolesFor, type SalesRole } from "./salesRolesApi";

/* ═══════════════════════════ targets ═══════════════════════════ */

export type FieldType = TrackingField["type"];
export interface NewField { tmp: string; label: string; type: FieldType; options: string[] }
export interface Person { id: string; name: string; email?: string | null; role?: string }
export interface Column { i: number; letter: string; header: string; values: SheetCell[]; filled: number; samples: SheetCell[] }

export interface BaseTarget { key: string; label: string; group: "Company" | "Contact" | "Deal"; hint?: string }
export const BASE_TARGETS: BaseTarget[] = [
  { key: "company.name", label: "Company name", group: "Company", hint: "Found in your companies, or created" },
  { key: "company.vat", label: "Company VAT / tax ID", group: "Company", hint: "Helps find the right company" },
  { key: "company.website", label: "Company website", group: "Company" },
  { key: "contact.full_name", label: "Contact full name", group: "Contact", hint: "Found by email or name, or created" },
  { key: "contact.first_name", label: "Contact first name", group: "Contact" },
  { key: "contact.last_name", label: "Contact last name", group: "Contact" },
  { key: "contact.email", label: "Contact email", group: "Contact" },
  { key: "contact.phone", label: "Contact phone", group: "Contact" },
  { key: "contact.position", label: "Contact position", group: "Contact" },
  { key: "deal.title", label: "Title (kept as a note)", group: "Deal" },
  { key: "deal.pipeline", label: "Pipeline", group: "Deal" },
  { key: "deal.phase", label: "Phase", group: "Deal" },
  { key: "deal.status", label: "Status (open / won / lost)", group: "Deal" },
  { key: "deal.value", label: "Value / amount (€)", group: "Deal" },
  { key: "deal.product", label: "Product", group: "Deal" },
  { key: "deal.close_date", label: "Expected close date", group: "Deal" },
  { key: "deal.probability", label: "Close probability (%)", group: "Deal" },
  { key: "deal.created", label: "Created on", group: "Deal" },
  { key: "deal.loss_reason", label: "Lost reason", group: "Deal" },
  { key: "deal.notes", label: "Notes", group: "Deal" },
];
/** Targets whose file values are matched one by one to our options. */
export const VALUE_TARGETS = new Set(["deal.pipeline", "deal.phase", "deal.status", "deal.product", "deal.loss_reason"]);
/** Targets more than one column may use (their values are joined). */
const MULTI_OK = new Set(["deal.notes", "deal.title"]);

const SYN: Record<string, string[]> = {
  "company.name": ["company", "company name", "empresa", "nombre empresa", "compania", "organization", "organisation", "organizacion", "account", "account name", "cliente", "client", "customer", "razon social", "bedrijf", "firma", "unternehmen", "lead company"],
  "company.vat": ["vat", "vat number", "cif", "nif", "cif nif", "tax id", "btw", "btw nummer", "company vat"],
  "company.website": ["website", "web", "url", "domain", "company website", "sitio web"],
  "contact.full_name": ["contact", "contact name", "contact person", "contacto", "persona de contacto", "nombre contacto", "person", "contactpersoon", "ansprechpartner", "customer contact", "lead"],
  "contact.first_name": ["first name", "firstname", "contact first name", "nombre", "voornaam", "vorname"],
  "contact.last_name": ["last name", "lastname", "surname", "contact last name", "apellido", "apellidos", "achternaam", "nachname"],
  "contact.email": ["email", "e mail", "mail", "contact email", "correo", "correo electronico"],
  "contact.phone": ["phone", "telephone", "tel", "telefono", "mobile", "movil", "contact phone"],
  "contact.position": ["position", "job title", "function", "cargo", "puesto", "functie"],
  "deal.title": ["title", "deal", "deal name", "deal title", "subject", "name", "titulo", "asunto", "oportunidad", "opportunity", "opportunity name", "onderwerp", "nombre del deal", "nombre de la oportunidad", "nombre oportunidad", "nombre del negocio", "negocio"],
  "deal.pipeline": ["pipeline", "pipeline name", "embudo", "funnel", "sales pipeline", "deal pipeline"],
  "deal.phase": ["phase", "stage", "deal phase", "deal stage", "fase", "etapa", "estado del deal", "fase actual", "current phase", "pipeline stage", "sales stage"],
  "deal.status": ["status", "estado", "state", "deal status", "result", "resultado", "outcome"],
  "deal.value": ["value", "amount", "deal value", "total", "importe", "valor", "precio", "price", "revenue", "estimated value", "waarde", "bedrag", "budget", "presupuesto"],
  "deal.product": ["product", "producto", "products", "service", "servicio", "productos"],
  "deal.close_date": ["close date", "expected close date", "estimated closing date", "closing date", "fecha de cierre", "fecha cierre", "fecha prevista", "expected closing", "deadline"],
  "deal.probability": ["probability", "probabilidad", "chance", "win probability", "kans", "close probability", "%"],
  "deal.created": ["created", "created at", "created on", "creation date", "date created", "fecha de creacion", "fecha creacion", "fecha alta", "fecha de alta", "alta", "aangemaakt", "start date", "add time", "deal created"],
  "deal.loss_reason": ["lost reason", "loss reason", "reason lost", "motivo de perdida", "motivo perdida", "razon de perdida", "lost reason description"],
  "deal.notes": ["notes", "note", "notas", "comments", "comentarios", "description", "descripcion", "observaciones", "summary"],
  "__owner": ["owner", "responsible", "responsable", "deal owner", "sales rep", "comercial", "assigned to", "asignado a", "user", "usuario", "verantwoordelijke", "account manager", "vendedor"],
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LEGAL = /\b(s\s?l\s?u?|s\s?a\s?u?|s\s?l\s?l|ltd|limited|llc|inc|corp|gmbh|ag|bv|nv|sarl|sas|srl|spa|plc|co|bvba|vof)\b/g;
/** Company matching key: no accents/punctuation/legal suffix ("Acme, S.L." = "ACME"). */
export const nameKey = (s: string | null | undefined) => normHeader((s ?? "").replace(/\./g, "")).replace(LEGAL, " ").replace(/\s+/g, " ").trim();
export const vatKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[\s.\-/]/g, "").replace(/^(ES|BE|NL|FR|DE|PT|IT)(?=[A-Z0-9]\d{6,})/, "");
const personKey = (s: string | null | undefined) => normHeader(s ?? "");
const FREE_MAIL = new Set(["gmail", "googlemail", "hotmail", "outlook", "live", "msn", "yahoo", "icloud", "me", "aol", "gmx", "protonmail", "proton", "telefonica", "movistar", "yandex", "zoho", "mail"]);
/** "https://www.acme.es/x" or "ana@acme.es" → "acme" (null for free mail). */
export function domainKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const host = (s.includes("@") ? s.split("@")[1] : s.replace(/^https?:\/\//i, "").split(/[/?#]/)[0]).replace(/^www\./i, "").toLowerCase();
  const first = host.split(".")[0];
  return first && !FREE_MAIL.has(first) ? first : null;
}

export function guessTarget(header: string, samples: SheetCell[]): string | null {
  const h = normHeader(header);
  if (!h) return null;
  // the old CRM's own record id ("ID Oportunidad", "Deal ID") isn't anything here
  if (/^(id|n|no|num|numero|ref)( |$)|( |^)id$/.test(h)) return null;
  const keys = Object.keys(SYN).filter((k) => !k.startsWith("__"));
  for (const k of keys) if (SYN[k].includes(h)) return k;
  // what the values look like beats a word in the header ("Email contacto")
  const vals = samples.map(cellText).filter(Boolean);
  if (vals.length && vals.every((v) => EMAIL_RE.test(v))) return "contact.email";
  // otherwise the longest known phrase inside the header wins ("Nombre de la oportunidad" → title, not first name)
  let best: { k: string; len: number } | null = null;
  for (const k of keys) for (const syn of SYN[k]) if (syn.length > 4 && h.includes(syn) && (!best || syn.length > best.len)) best = { k, len: syn.length };
  return best?.k ?? null;
}

/** One option per value ignoring case/accents, written the nicest way seen. */
export function canonicalOptions(values: SheetCell[]): string[] {
  const groups = new Map<string, Map<string, number>>();
  values.map((v) => cellText(v).trim()).filter(Boolean).forEach((t) => {
    const k = normHeader(t);
    const g = groups.get(k) ?? new Map<string, number>(); g.set(t, (g.get(t) ?? 0) + 1); groups.set(k, g);
  });
  const score = (t: string) => (/^[A-ZÁÉÍÓÚÑ]/.test(t) ? 4 : 0) + (/[áéíóúñ]/i.test(t) ? 2 : 0);
  return [...groups.values()].map((g) => [...g.entries()].sort((a, b) => score(b[0]) - score(a[0]) || b[1] - a[1])[0][0]).sort((a, b) => a.localeCompare(b));
}
export function guessType(values: SheetCell[]): { type: FieldType; options: string[] } {
  const vals = values.filter((v) => v != null && v !== "");
  if (!vals.length) return { type: "text", options: [] };
  if (vals.every((v) => typeof v === "object" || (typeof v === "string" && parseDate(v) && /\d/.test(v) && /[-/.]/.test(v)))) return { type: "date", options: [] };
  if (vals.filter((v) => parseBool(v) != null).length >= Math.max(2, vals.length * 0.9) && vals.some((v) => typeof v !== "number")) return { type: "boolean", options: [] };
  if (vals.every((v) => parseNumber(v) != null)) return { type: "number", options: [] };
  const opts = canonicalOptions(vals);
  if (opts.length <= 15 && (opts.length <= 6 || opts.length < vals.length * 0.75) && opts.every((d) => d.length <= 40)) return { type: "select", options: opts };
  return { type: "text", options: [] };
}

/** Distinct values of a column (first spelling seen), with how often each appears. */
export function distinctValues(values: SheetCell[]): { key: string; text: string; count: number }[] {
  const m = new Map<string, { key: string; text: string; count: number }>();
  values.forEach((v) => {
    const t = cellText(v).trim();
    if (!t) return;
    const k = normHeader(t);
    const e = m.get(k) ?? { key: k, text: t, count: 0 };
    e.count++; m.set(k, e);
  });
  return [...m.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

/* ═══════════════════════════ context ═══════════════════════════ */

export interface Ctx {
  pipelines: Pipeline[];
  phaseByPipe: Record<string, Phase[]>;
  products: Product[];
  lossReasons: LossReason[];
  fields: TrackingField[];
  people: Person[];
  roles: SalesRole[];
  companies: Company[];
  contacts: Contact[];
  trackings: Tracking[];
}

/** Assign people from a column: each file value → a person. */
export interface Rule { id: string; col: number | null; as: "owner" | "team"; map: Record<string, string>; fallback: string }

export interface ImportState {
  mapping: Record<number, string>;
  newFields: NewField[];
  /** target → normalized file value → choice */
  valueMaps: Record<string, Record<string, string>>;
  /** For rows with no pipeline (nor a phase that names one). */
  defaultPipeline: string;
  rules: Rule[];
  /** person → the role they play on the imported deals (when they have several) */
  personRole: Record<string, string>;
  /** unknown company key → "create" | "skip" | "crm:<id>" */
  companyChoice: Record<string, string>;
  createContacts: boolean;
  /** A deal for the same company in the same pipeline is already in the CRM. */
  dupMode: "skip" | "import";
  /** Stamp the phases before the current one as passed (keeps reports and roles right). */
  markPassed: boolean;
}

/* ═══════════════════════════ matching values ═══════════════════════════ */

const STATUS_SYN: Record<string, string[]> = {
  won: ["won", "win", "ganado", "ganada", "gewonnen", "closed won", "cerrado ganado", "accepted", "aceptado", "signed", "firmado", "success", "exito", "gagne"],
  lost: ["lost", "loss", "perdido", "perdida", "verloren", "closed lost", "cerrado perdido", "refused", "rechazado", "declined", "cancelled", "cancelado", "perdu"],
  paused: ["hold", "on hold", "paused", "pausado", "en pausa", "parado", "frozen", "waiting", "en espera"],
  active: ["open", "active", "abierto", "abierta", "activo", "activa", "in progress", "en curso", "new", "nuevo", "lopend", "offen", "pending", "pendiente"],
};
export const STATUS_LABEL: Record<string, string> = { active: "Active", won: "Won", lost: "Lost", paused: "Hold" };

export const sortedPipelines = (ctx: Ctx, first?: string) =>
  [...ctx.pipelines].sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : 0));
export const phasesOf = (ctx: Ctx, pid: string | null | undefined) => (pid ? orderPhases(ctx.phaseByPipe[pid] ?? []) : []);

/** The phase a value names, preferring a pipeline. */
function matchPhase(ctx: Ctx, raw: string, prefer: string | null): string | null {
  const n = normHeader(raw);
  if (!n) return null;
  const pipes = sortedPipelines(ctx, prefer ?? undefined);
  for (const p of pipes) { const ph = phasesOf(ctx, p.id).find((x) => normHeader(x.name) === n); if (ph) return ph.id; }
  // "won" / "lost" → the outcome phase
  const st = Object.entries(STATUS_SYN).find(([, syn]) => syn.includes(n))?.[0];
  if (st === "won" || st === "lost") {
    for (const p of pipes) { const ph = phasesOf(ctx, p.id).find((x) => x.sales_outcome === (st === "won" ? "win" : "loss")); if (ph) return ph.id; }
  }
  for (const p of pipes) {
    const ph = phasesOf(ctx, p.id).find((x) => { const k = normHeader(x.name); return k.length >= 3 && n.length >= 3 && (k.startsWith(n) || n.startsWith(k)); });
    if (ph) return ph.id;
  }
  // "SQL 8" vs "SQL 2": same words, different number → leave it to the person
  return null;
}

/** The automatic choice for one file value of a value target (null = needs a decision). */
export function autoChoice(ctx: Ctx, target: string, raw: string, state: Pick<ImportState, "defaultPipeline">): string | null {
  const n = normHeader(raw);
  if (!n) return null;
  if (target === "deal.pipeline") return ctx.pipelines.find((p) => normHeader(p.name) === n)?.id
    ?? ctx.pipelines.find((p) => { const k = normHeader(p.name); return k.length >= 3 && (k.includes(n) || n.includes(k)); })?.id ?? null;
  if (target === "deal.phase") return matchPhase(ctx, raw, state.defaultPipeline || null);
  if (target === "deal.status") return Object.entries(STATUS_SYN).find(([, syn]) => syn.includes(n))?.[0]
    ?? Object.entries(STATUS_SYN).find(([, syn]) => syn.some((s) => s.length > 3 && n.includes(s)))?.[0] ?? null;
  if (target === "deal.product") return ctx.products.find((p) => normHeader(p.name) === n)?.id
    ?? ctx.products.find((p) => { const k = normHeader(p.name); return k.length >= 3 && (k.startsWith(n) || n.startsWith(k)); })?.id ?? null;
  if (target === "deal.loss_reason") return ctx.lossReasons.find((r) => normHeader(r.label) === n)?.label ?? null;
  if (target.startsWith("custom:")) {
    const f = ctx.fields.find((x) => x.id === target.slice(7));
    if (!f || f.type !== "select") return null;
    return f.options.find((o) => normHeader(o) === n) ?? f.options.find((o) => { const k = normHeader(o); return k.length >= 3 && (k.startsWith(n) || n.startsWith(k)); }) ?? null;
  }
  return null;
}
/** What to do with a value nobody decided and that matched nothing. */
export function fallbackChoice(target: string): string {
  if (target === "deal.pipeline") return "__default";
  if (target === "deal.phase") return "__first";
  if (target === "deal.status") return "active";
  if (target === "deal.product") return "__none";
  if (target === "deal.loss_reason") return "__details";
  return "__new"; // choice-list field: add it as a new option
}
export function choiceFor(ctx: Ctx, state: ImportState, target: string, raw: string): { choice: string; auto: boolean; matched: boolean } {
  const picked = state.valueMaps[target]?.[normHeader(raw)];
  if (picked) return { choice: picked, auto: false, matched: true };
  const a = autoChoice(ctx, target, raw, state);
  return a ? { choice: a, auto: true, matched: true } : { choice: fallbackChoice(target), auto: true, matched: false };
}

/** A person a file value names: full name, email, or a unique first name. */
export function matchPerson(people: Person[], raw: string): string | null {
  const n = personKey(raw);
  if (!n) return null;
  const byName = people.find((p) => personKey(p.name) === n);
  if (byName) return byName.id;
  const lower = raw.trim().toLowerCase();
  const byMail = people.find((p) => p.email && (p.email.toLowerCase() === lower || p.email.toLowerCase().split("@")[0] === lower.split("@")[0]));
  if (byMail && (lower.includes("@") || lower.includes("."))) return byMail.id;
  // "Antonio" or "A. García" or "García, Antonio"
  const words = n.split(" ").filter((w) => w.length > 1);
  const hits = people.filter((p) => { const pk = personKey(p.name).split(" "); return words.length > 0 && words.every((w) => pk.includes(w)); });
  if (hits.length === 1) return hits[0].id;
  const first = people.filter((p) => personKey(p.name).split(" ")[0] === n);
  return first.length === 1 ? first[0].id : null;
}
export function guessOwnerColumn(columns: Column[]): number | null {
  for (const c of columns) { const h = normHeader(c.header); if (SYN.__owner.includes(h)) return c.i; }
  for (const c of columns) { const h = normHeader(c.header); if (SYN.__owner.some((s) => s.length > 4 && h.includes(s))) return c.i; }
  return null;
}

/* ═══════════════════════════ the plan ═══════════════════════════ */

export interface CompanyName { key: string; name: string; vat?: string; website?: string; count: number; found: string | null; foundBy?: "vat" | "name" | "domain" }
export interface NewContact { key: string; first_name: string; last_name: string | null; email: string | null; phone: string | null; position: string | null; companyRef: string | null; count: number }

export interface PlanRow {
  idx: number;
  status: "new" | "dup" | "error";
  reason?: string;
  issues: string[];
  companyRef: string | null; companyLabel: string | null;
  contactRef: string | null; contactLabel: string | null;
  pipelineId: string | null; phaseId: string | null; reachedPhaseId: string | null; dealStatus: string;
  value: number | null; productId: string | null;
  owner: string | null; team: string[]; dealRoles: Record<string, string>;
  closeDate: string | null; probability: number | null; created: string | null;
  title: string | null; notes: string[]; lossReason: string | null; lossDetails: string | null; newLossReason: boolean;
  custom: Record<string, any>;
}
export interface Plan {
  rows: PlanRow[];
  companies: CompanyName[];
  newContacts: NewContact[];
  counts: { new: number; dup: number; error: number; warn: number; coNew: number; coFound: number; ctNew: number; ctFound: number; noOwner: number };
}

const defOf = (ctx: Ctx, state: ImportState, t: string): (TrackingField | NewField) | null =>
  t.startsWith("custom:") ? ctx.fields.find((f) => f.id === t.slice(7)) ?? null : t.startsWith("new:") ? state.newFields.find((n) => n.tmp === t.slice(4)) ?? null : null;

export function buildPlan(ctx: Ctx, columns: Column[], rows: SheetCell[][], state: ImportState): Plan {
  /* ---- indexes of what's in the CRM ---- */
  const coByVat = new Map<string, Company>(), coByName = new Map<string, Company>(), coByDomain = new Map<string, Company>();
  ctx.companies.forEach((c) => {
    const v = vatKey(c.vat_number); if (v && !coByVat.has(v)) coByVat.set(v, c);
    [c.name, c.legal_name].forEach((n) => { const k = nameKey(n); if (k && !coByName.has(k)) coByName.set(k, c); });
    const d = domainKey(c.website) ?? domainKey(c.email); if (d && !coByDomain.has(d)) coByDomain.set(d, c);
  });
  const ctByEmail = new Map<string, Contact>(), ctByName = new Map<string, Contact[]>();
  ctx.contacts.forEach((c) => {
    if (c.email) ctByEmail.set(c.email.trim().toLowerCase(), c);
    const k = personKey([c.first_name, c.last_name].filter(Boolean).join(" "));
    if (k) ctByName.set(k, [...(ctByName.get(k) ?? []), c]);
  });
  const existingDeals = new Set(ctx.trackings.map((t) => `${t.company_id ?? ""}|${t.pipeline_id ?? ""}`));
  const existingContactDeals = new Set(ctx.trackings.flatMap((t) => (t.company_id ? [] : t.contactIds.map((c) => `${c}|${t.pipeline_id ?? ""}`))));

  const companyNames = new Map<string, CompanyName>();
  const newContacts = new Map<string, NewContact>();
  // a rule without a column gives everyone the same person ("fallback")
  const owners = state.rules.filter((r) => r.as === "owner");
  const teams = state.rules.filter((r) => r.as === "team");
  const firstPhase = (pid: string | null) => phasesOf(ctx, pid).find((p) => !p.sales_outcome) ?? phasesOf(ctx, pid)[0] ?? null;

  const planRows: PlanRow[] = rows.map((r, idx) => {
    const issues: string[] = [];
    const get: Record<string, string[]> = {};
    const cells: Record<string, SheetCell> = {};
    const custom: Record<string, any> = {};
    for (const [colS, t] of Object.entries(state.mapping)) {
      if (!t) continue;
      const cell = r[+colS] ?? null;
      if (cell == null || cell === "") continue;
      const txt = cellText(cell).trim();
      if (!txt) continue;
      const def = defOf(ctx, state, t);
      if (def) {
        if (def.type === "number") { const n = parseNumber(cell); if (n != null) custom[t] = n; else issues.push(`${def.label}: “${txt}” isn't a number`); }
        else if (def.type === "date") { const d = parseDate(cell); if (d) custom[t] = d; else issues.push(`${def.label}: “${txt}” isn't a date`); }
        else if (def.type === "boolean") { const b = parseBool(cell); if (b != null) custom[t] = b; else issues.push(`${def.label}: “${txt}” isn't yes/no`); }
        else if (def.type === "select" && t.startsWith("custom:")) { const ch = choiceFor(ctx, state, t, txt).choice; if (ch === "__new") custom[t] = txt; else if (ch !== "__empty") custom[t] = ch; }
        else custom[t] = def.type === "select" ? (def.options.find((o) => normHeader(o) === normHeader(txt)) ?? txt) : txt;
        continue;
      }
      (get[t] ??= []).push(txt);
      if (!(t in cells)) cells[t] = cell;
    }
    const one = (k: string) => get[k]?.[0] ?? null;

    /* ---- company ---- */
    let companyRef: string | null = null, companyLabel: string | null = null;
    const coName = one("company.name"), vat = one("company.vat"), web = one("company.website");
    const email = (one("contact.email") ?? "").toLowerCase() || null;
    if (coName || vat) {
      const vk = vatKey(vat), nk = nameKey(coName ?? "");
      const hit = (vk && coByVat.get(vk)) || (nk && coByName.get(nk)) || undefined;
      const key = nk || `vat:${vk}`;
      const e = companyNames.get(key) ?? { key, name: coName || vat || "", vat: vat ?? undefined, website: web ?? undefined, count: 0, found: hit ? `crm:${hit.id}` : null, foundBy: hit ? (vk && coByVat.get(vk) ? "vat" : "name") as "vat" | "name" : undefined };
      e.count++; if (!e.vat && vat) e.vat = vat; if (!e.website && web) e.website = web;
      companyNames.set(key, e);
      const ch = state.companyChoice[key];
      if (hit) companyRef = ch && ch !== "create" && ch !== "skip" ? ch : ch === "skip" ? null : `crm:${hit.id}`;
      else companyRef = !ch || ch === "create" ? `new:${key}` : ch === "skip" ? null : ch;
      companyLabel = companyRef ? (companyRef.startsWith("crm:") ? ctx.companies.find((c) => c.id === companyRef!.slice(4))?.name ?? e.name : e.name) : null;
    } else if (email && domainKey(email)) {
      const hit = coByDomain.get(domainKey(email)!);
      if (hit) { companyRef = `crm:${hit.id}`; companyLabel = hit.name; issues.push(`Company found from the email domain: ${hit.name}`); }
    }

    /* ---- contact ---- */
    let contactRef: string | null = null, contactLabel: string | null = null;
    let first = one("contact.first_name"), last = one("contact.last_name");
    const full = one("contact.full_name");
    if (full && !first) { const parts = full.split(/\s+/); first = parts[0]; if (!last && parts.length > 1) last = parts.slice(1).join(" "); }
    const validEmail = email && EMAIL_RE.test(email) ? email : null;
    if (email && !validEmail) issues.push(`“${email}” isn't a valid email`);
    if (!first && validEmail) {
      const local = validEmail.split("@")[0].split(/[._-]+/).filter(Boolean);
      if (local[0] && local.length > 1) { first = local[0][0].toUpperCase() + local[0].slice(1); last = local.slice(1).map((x) => x[0].toUpperCase() + x.slice(1)).join(" "); }
    }
    if (first || validEmail) {
      const nameK = personKey([first, last].filter(Boolean).join(" "));
      let hit = validEmail ? ctByEmail.get(validEmail) : undefined;
      if (!hit && nameK) {
        const same = ctByName.get(nameK) ?? [];
        const coId = companyRef?.startsWith("crm:") ? companyRef.slice(4) : null;
        hit = (coId ? same.find((c) => c.companyIds.includes(coId)) : undefined) ?? (same.length === 1 && (!coId || !same[0].companyIds.length) ? same[0] : undefined);
      }
      if (hit) { contactRef = `crm:${hit.id}`; contactLabel = [hit.first_name, hit.last_name].filter(Boolean).join(" "); }
      else if (state.createContacts && (first || validEmail)) {
        const key = validEmail ? `e:${validEmail}` : `n:${nameK}|${companyRef ?? ""}`;
        const e = newContacts.get(key) ?? { key, first_name: first || validEmail!.split("@")[0], last_name: last, email: validEmail, phone: one("contact.phone"), position: one("contact.position"), companyRef, count: 0 };
        e.count++; newContacts.set(key, e);
        contactRef = `new:${key}`; contactLabel = [e.first_name, e.last_name].filter(Boolean).join(" ");
      }
    }

    /* ---- pipeline, phase, status ---- */
    const pipeRaw = one("deal.pipeline"), phaseRaw = one("deal.phase"), statusRaw = one("deal.status");
    let pipelineId: string | null = null;
    if (pipeRaw) { const ch = choiceFor(ctx, state, "deal.pipeline", pipeRaw).choice; if (ch !== "__default") pipelineId = ch; }
    let phaseTarget: Phase | null = null;
    if (phaseRaw) {
      const ch = choiceFor(ctx, state, "deal.phase", phaseRaw).choice;
      if (ch !== "__first") phaseTarget = Object.values(ctx.phaseByPipe).flat().find((p) => p.id === ch) ?? null;
    }
    if (!pipelineId) pipelineId = phaseTarget?.pipeline_id ?? (state.defaultPipeline || null);
    const ord = phasesOf(ctx, pipelineId);
    let phase: Phase | null = null;
    if (phaseTarget) {
      phase = phaseTarget.pipeline_id === pipelineId ? phaseTarget : ord.find((p) => normHeader(p.name) === normHeader(phaseTarget!.name)) ?? null;
      if (!phase) issues.push(`Phase “${phaseRaw}” isn't in ${ctx.pipelines.find((p) => p.id === pipelineId)?.name ?? "this pipeline"} — starts at the first phase`);
    }
    if (!phase) phase = firstPhase(pipelineId);
    let dealStatus = statusRaw ? choiceFor(ctx, state, "deal.status", statusRaw).choice : "active";
    if (phase?.sales_outcome === "win") dealStatus = "won";
    if (phase?.sales_outcome === "loss") dealStatus = "lost";
    let reached: Phase | null = phase && !phase.sales_outcome ? phase : null;
    if (dealStatus === "won" && phase?.sales_outcome !== "win") { const w = ord.find((p) => p.sales_outcome === "win"); if (w) phase = w; }
    if (dealStatus === "lost" && phase?.sales_outcome !== "loss") { const l = ord.find((p) => p.sales_outcome === "loss"); if (l) phase = l; }
    // a won deal went through every phase; a lost one stopped where the file says
    if (phase?.sales_outcome === "win") reached = [...ord].reverse().find((p) => !p.sales_outcome) ?? reached;
    if (!reached && phase?.sales_outcome === "loss") reached = firstPhase(pipelineId);

    /* ---- value, product, dates ---- */
    let value: number | null = null;
    if (get["deal.value"]) { const n = parseNumber(cells["deal.value"]); if (n != null) value = Math.round(n * 100) / 100; else issues.push(`Value “${one("deal.value")}” isn't a number`); }
    let productId: string | null = null;
    if (one("deal.product")) { const ch = choiceFor(ctx, state, "deal.product", one("deal.product")!).choice; if (ch !== "__none") productId = ch; }
    let closeDate: string | null = null;
    if (get["deal.close_date"]) { closeDate = parseDate(cells["deal.close_date"]); if (!closeDate) issues.push(`Close date “${one("deal.close_date")}” isn't a date`); }
    let created: string | null = null;
    if (get["deal.created"]) { created = parseDate(cells["deal.created"]); if (!created) issues.push(`Created “${one("deal.created")}” isn't a date`); }
    let probability: number | null = null;
    if (get["deal.probability"]) {
      let n = parseNumber(cells["deal.probability"]);
      if (n != null && n > 0 && n < 1 && !String(one("deal.probability")).includes("%")) n = n * 100;
      if (n != null && n >= 0 && n <= 100) probability = Math.round(n); else issues.push(`Probability “${one("deal.probability")}” isn't 0–100`);
    }
    let lossReason: string | null = null, lossDetails: string | null = null, newLossReason = false;
    if (one("deal.loss_reason")) {
      const raw = one("deal.loss_reason")!;
      const ch = choiceFor(ctx, state, "deal.loss_reason", raw).choice;
      if (ch === "__details") lossDetails = raw;
      else if (ch === "__new") { lossReason = raw; newLossReason = true; }
      else lossReason = ch;
    }

    /* ---- people ---- */
    const personFor = (rule: Rule) => {
      const raw = rule.col != null ? cellText(r[rule.col] ?? null).trim() : "";
      const k = normHeader(raw);
      const v = k ? (rule.map[k] ?? matchPerson(ctx.people, raw) ?? rule.fallback) : rule.fallback;
      return v && ctx.people.some((p) => p.id === v) ? v : null;
    };
    let owner: string | null = null;
    for (const rule of owners) { owner = personFor(rule); if (owner) break; }
    const team = Array.from(new Set([...(owner ? [owner] : []), ...teams.map(personFor).filter((x): x is string => !!x)]));
    const dealRoles: Record<string, string> = {};
    team.forEach((pid) => { const role = resolveDealRole(ctx.roles, pid, pipelineId, state.personRole[pid]); if (role) dealRoles[pid] = role.id; });

    /* ---- status of the row ---- */
    let status: PlanRow["status"] = "new"; let reason: string | undefined;
    if (!companyRef && !contactRef) { status = "error"; reason = coName || first || email ? "Company and contact are both skipped" : "No company or contact"; }
    else if (!pipelineId || !ord.length) { status = "error"; reason = pipelineId ? "This pipeline has no phases" : "No pipeline"; }
    else if (companyRef?.startsWith("crm:") ? existingDeals.has(`${companyRef.slice(4)}|${pipelineId}`) : (!companyRef && contactRef?.startsWith("crm:") && existingContactDeals.has(`${contactRef.slice(4)}|${pipelineId}`))) {
      status = state.dupMode === "skip" ? "dup" : "new"; reason = "Already has a deal in this pipeline";
    }
    if (status === "new") {
      const missing = ctx.fields.filter((f) => f.required).filter((f) => { const v = custom[`custom:${f.id}`]; return v == null || v === "" || (f.type === "boolean" && v === false); });
      if (missing.length) { status = "error"; reason = `Required: ${missing.map((f) => f.label).join(", ")}`; }
    }
    return {
      idx, status, reason, issues, companyRef, companyLabel, contactRef, contactLabel,
      pipelineId, phaseId: phase?.id ?? null, reachedPhaseId: reached?.id ?? null, dealStatus,
      value, productId, owner, team, dealRoles, closeDate, probability, created,
      title: get["deal.title"]?.join(" · ") ?? null, notes: get["deal.notes"] ?? [], lossReason, lossDetails, newLossReason, custom,
    };
  });

  // a contact created for an unknown company that is skipped later stays without company
  const companies = [...companyNames.values()].sort((a, b) => (a.found ? 1 : 0) - (b.found ? 1 : 0) || b.count - a.count);
  const used = new Set(planRows.filter((p) => p.status === "new").map((p) => p.contactRef));
  const nc = [...newContacts.values()].filter((c) => used.has(`new:${c.key}`));
  const ok = planRows.filter((p) => p.status === "new");
  return {
    rows: planRows, companies, newContacts: nc,
    counts: {
      new: ok.length, dup: planRows.filter((p) => p.status === "dup").length, error: planRows.filter((p) => p.status === "error").length,
      warn: ok.filter((p) => p.issues.length).length,
      coNew: new Set(ok.map((p) => p.companyRef).filter((x) => x?.startsWith("new:"))).size,
      coFound: new Set(ok.map((p) => p.companyRef).filter((x) => x?.startsWith("crm:"))).size,
      ctNew: nc.length, ctFound: new Set(ok.map((p) => p.contactRef).filter((x) => x?.startsWith("crm:"))).size,
      noOwner: ok.filter((p) => !p.owner).length,
    },
  };
}

/** Problems that stop the mapping step. */
export function mapProblem(ctx: Ctx, state: ImportState): string | null {
  const used = Object.values(state.mapping).filter(Boolean);
  if (!used.length) return "Map at least one column.";
  const hasWho = used.some((t) => ["company.name", "company.vat", "contact.full_name", "contact.first_name", "contact.email"].includes(t));
  if (!hasWho) return "Map the company name or a contact (name or email) — every deal needs one.";
  if (!used.includes("deal.pipeline") && !used.includes("deal.phase") && !state.defaultPipeline) return "Choose the pipeline the deals go into.";
  const dup = used.find((t, i) => used.indexOf(t) !== i && !MULTI_OK.has(t));
  if (dup) return `“${BASE_TARGETS.find((b) => b.key === dup)?.label ?? defOf(ctx, state, dup)?.label ?? dup}” is mapped from two columns.`;
  const bad = state.newFields.find((n) => !n.label.trim() || ctx.fields.some((f) => normHeader(f.label) === normHeader(n.label)) || state.newFields.some((o) => o.tmp !== n.tmp && normHeader(o.label) === normHeader(n.label)));
  if (bad) return `New field “${bad.label || "untitled"}” needs a unique name.`;
  return null;
}

/** People on imported deals who have several roles that fit their deals' pipelines. */
export function peopleWithSeveralRoles(ctx: Ctx, plan: Plan): { id: string; roles: SalesRole[] }[] {
  const pipesOf = new Map<string, Set<string>>();
  plan.rows.filter((r) => r.status === "new").forEach((r) => r.team.forEach((p) => { const s = pipesOf.get(p) ?? new Set<string>(); if (r.pipelineId) s.add(r.pipelineId); pipesOf.set(p, s); }));
  const out: { id: string; roles: SalesRole[] }[] = [];
  pipesOf.forEach((pipes, id) => {
    const all = rolesFor(ctx.roles, id).all.filter((role) => [...pipes].some((pid) => role.scopes.some((s) => s.pipeline_id === pid)));
    if (all.length > 1) out.push({ id, roles: all });
  });
  return out;
}

/* ═══════════════════════════ running it ═══════════════════════════ */

export interface RunResult { created: number; failed: { row: number; reason: string }[]; coCreated: number; ctCreated: number; newFields: number; batchId: string | null }

async function startBatch(entity: "deal" | "company" | "contact", fileName: string): Promise<string | null> {
  const { data, error } = await supabase.from("import_batches").insert({ entity, file_name: fileName || null }).select("id").single();
  return error ? null : (data as any)?.id ?? null;
}
async function finishBatch(id: string | null, created: number) {
  if (id) await supabase.from("import_batches").update({ rows_created: created, rows_updated: 0 }).eq("id", id);
}

/** Insert a deal; if an optional column isn't in the database yet, try again without it. */
async function insertDeal(row: Record<string, any>): Promise<{ id: string | null; error: string | null }> {
  const optional = ["import_batch_id", "deal_roles", "custom", "created_at"];
  let r = { ...row };
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await supabase.from("trackings").insert(r).select("id").single();
    if (!error) return { id: (data as any)?.id ?? null, error: null };
    const col = optional.find((c) => c in r && error.message?.includes(c));
    if (!col) return { id: null, error: error.message };
    const { [col]: _drop, ...rest } = r; r = rest; // eslint-disable-line @typescript-eslint/no-unused-vars
  }
  return { id: null, error: "Couldn't create the deal" };
}

export async function runImport(ctx: Ctx, state: ImportState, columns: Column[], plan: Plan, fileName: string, rowOffset: number,
  onProgress: (p: { done: number; total: number; phase: string }) => void): Promise<RunResult> {
  const failed: { row: number; reason: string }[] = [];
  let created = 0, coCreated = 0, ctCreated = 0, newFieldCount = 0;
  const todo = plan.rows.filter((r) => r.status === "new");

  /* 1) new deal fields, and new options on existing choice lists */
  const tmpIds = new Map<string, string>();
  const usedNew = state.newFields.filter((n) => Object.values(state.mapping).includes(`new:${n.tmp}`));
  if (usedNew.length) {
    onProgress({ done: 0, total: usedNew.length, phase: "Creating deal fields…" });
    for (const [k, n] of usedNew.entries()) {
      const { field } = await addTrackingField({ label: n.label.trim(), type: n.type, required: false, options: n.type === "select" ? n.options : [], sort: ctx.fields.length + k } as any);
      if (field?.id) { tmpIds.set(n.tmp, field.id); newFieldCount++; }
    }
    if (tmpIds.size < usedNew.length) {
      const fresh = await listTrackingFields().catch(() => [] as TrackingField[]);
      usedNew.forEach((n) => { if (!tmpIds.has(n.tmp)) { const f = [...fresh].reverse().find((x) => normHeader(x.label) === normHeader(n.label)); if (f) tmpIds.set(n.tmp, f.id); } });
    }
  }
  for (const [colS, t] of Object.entries(state.mapping)) {
    if (!t.startsWith("custom:")) continue;
    const def = ctx.fields.find((f) => f.id === t.slice(7));
    if (!def || def.type !== "select") continue;
    const add = new Set<string>();
    columns.find((c) => c.i === +colS)?.values.forEach((v) => {
      const txt = cellText(v).trim();
      if (txt && choiceFor(ctx, state, t, txt).choice === "__new" && !def.options.some((o) => normHeader(o) === normHeader(txt))) add.add(txt);
    });
    if (add.size) await updateTrackingField(def.id, { options: [...def.options, ...add] });
  }
  const resolveCustom = (custom: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(custom)) { const id = k.startsWith("custom:") ? k.slice(7) : tmpIds.get(k.slice(4)); if (id) out[id] = v; }
    return out;
  };
  /* new lost reasons */
  const newReasons = [...new Set(todo.filter((r) => r.newLossReason && r.lossReason).map((r) => r.lossReason!))];
  for (const [k, label] of newReasons.entries()) await addLossReason(label, ctx.lossReasons.length + k).catch(() => null);

  /* 2) companies */
  const coIds = new Map<string, string>();
  const coTodo = plan.companies.filter((c) => todo.some((r) => r.companyRef === `new:${c.key}`));
  let coBatchP: Promise<string | null> | null = null;
  if (coTodo.length) {
    onProgress({ done: 0, total: coTodo.length, phase: "Creating companies…" });
    let k = 0;
    for (const c of coTodo) {
      const row: any = { name: c.name, vat_number: c.vat ? c.vat.toUpperCase().replace(/[\s.\-/]/g, "") : null, website: c.website ?? null, import_batch_id: await (coBatchP ??= startBatch("company", `${fileName} (deals import)`)) };
      const e = await saveCompany(row as Company).catch((x: any) => x?.message ?? "Failed");
      if (!e && row.id) { coIds.set(c.key, row.id); coCreated++; } else failed.push({ row: 0, reason: `Company “${c.name}”: ${e}` });
      onProgress({ done: ++k, total: coTodo.length, phase: "Creating companies…" });
    }
  }
  const coId = (ref: string | null) => (!ref ? null : ref.startsWith("crm:") ? ref.slice(4) : coIds.get(ref.slice(4)) ?? null);

  /* 3) contacts */
  const ctIds = new Map<string, string>();
  let ctBatchP: Promise<string | null> | null = null;
  if (plan.newContacts.length) {
    onProgress({ done: 0, total: plan.newContacts.length, phase: "Creating contacts…" });
    let k = 0;
    for (const c of plan.newContacts) {
      const cid = coId(c.companyRef);
      const row: any = { first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone, position: c.position, is_billing: false, notes: null, custom: {}, companyIds: cid ? [cid] : [], import_batch_id: await (ctBatchP ??= startBatch("contact", `${fileName} (deals import)`)) };
      const e = await saveContact(row as Contact).catch((x: any) => x?.message ?? "Failed");
      if (!e && row.id) { ctIds.set(c.key, row.id); ctCreated++; } else failed.push({ row: 0, reason: `Contact “${c.first_name}”: ${e}` });
      onProgress({ done: ++k, total: plan.newContacts.length, phase: "Creating contacts…" });
    }
  }
  const ctId = (ref: string | null) => (!ref ? null : ref.startsWith("crm:") ? ref.slice(4) : ctIds.get(ref.slice(4)) ?? null);

  /* 4) deals, 4 at a time */
  const batchId = todo.length ? await startBatch("deal", fileName) : null;
  onProgress({ done: 0, total: todo.length, phase: "Importing deals…" });
  let cursor = 0, done = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const r = todo[cursor++];
      try {
        const company_id = coId(r.companyRef), contact_id = ctId(r.contactRef);
        if (!company_id && !contact_id) { failed.push({ row: r.idx + rowOffset, reason: "Its company / contact couldn't be created" }); continue; }
        const product = r.productId ? ctx.products.find((p) => p.id === r.productId) : null;
        const price = r.value ?? product?.tiers?.[0]?.price ?? null;
        const row: Record<string, any> = {
          company_id, pipeline_id: r.pipelineId, current_phase_id: r.phaseId, status: r.dealStatus,
          product_id: r.productId, product_price: price,
          rep_close_prob: r.probability, rep_close_date: r.closeDate,
          loss_reason: r.lossReason, loss_details: r.lossDetails,
          custom: resolveCustom(r.custom),
          ...(Object.keys(r.dealRoles).length ? { deal_roles: r.dealRoles } : {}),
          ...(r.created ? { created_at: `${r.created}T09:00:00Z` } : {}),
          ...(batchId ? { import_batch_id: batchId } : {}),
        };
        const { id, error } = await insertDeal(row);
        if (!id) { failed.push({ row: r.idx + rowOffset, reason: error ?? "Couldn't create the deal" }); continue; }
        const when = r.created ? `${r.created}T09:00:00Z` : new Date().toISOString();
        const jobs: PromiseLike<any>[] = [];
        if (contact_id) jobs.push(supabase.from("tracking_contacts").insert({ tracking_id: id, contact_id }));
        if (r.productId) jobs.push(supabase.from("tracking_products").insert({ tracking_id: id, product_id: r.productId, price: price ?? 0 }));
        if (r.team.length) jobs.push(supabase.from("tracking_employees").insert(r.team.map((p) => ({ tracking_id: id, profile_id: p, is_owner: p === r.owner }))));
        // phases entered: the earlier ones (if asked), the one it reached, and won / lost
        const ord = phasesOf(ctx, r.pipelineId);
        const reachedIdx = ord.findIndex((p) => p.id === r.reachedPhaseId);
        const entered = new Set<string>();
        if (reachedIdx >= 0) ord.slice(state.markPassed ? 0 : reachedIdx, reachedIdx + 1).forEach((p) => { if (!p.sales_outcome) entered.add(p.id); });
        if (r.phaseId) entered.add(r.phaseId);
        if (entered.size) jobs.push(supabase.from("tracking_phase_events").insert([...entered].map((phase_id) => ({ tracking_id: id, phase_id, entered_at: when }))));
        const body = [r.title ? `Imported deal: ${r.title}` : null, ...r.notes].filter(Boolean).join("\n\n");
        if (body) jobs.push(supabase.from("tracking_notes").insert({ tracking_id: id, phase_id: r.phaseId, body }));
        await Promise.all(jobs);
        created++;
      } catch (e: any) {
        failed.push({ row: r.idx + rowOffset, reason: e?.message ?? "Failed" });
      } finally {
        done++; onProgress({ done, total: todo.length, phase: "Importing deals…" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length || 1) }, worker));
  await finishBatch(batchId, created);
  if (coBatchP) await finishBatch(await coBatchP, coCreated);
  if (ctBatchP) await finishBatch(await ctBatchP, ctCreated);
  plan.rows.filter((r) => r.status === "error").forEach((r) => failed.push({ row: r.idx + rowOffset, reason: r.reason ?? "Error" }));
  failed.sort((a, b) => a.row - b.row);
  return { created, failed, coCreated, ctCreated, newFields: newFieldCount, batchId };
}