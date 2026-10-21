/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Importing deals (trackings) from another CRM's Excel / CSV export.
 *
 * Everything here is pure (no React) so it can be tested on its own:
 *   - what each column can be mapped to (every company, contact and deal
 *     field, custom fields of all three, and "reached phase X on this date"),
 *     and the automatic guesses
 *   - matching a file value to one of our options (pipeline, phase, status,
 *     product, loss reason, choice-list field, person)
 *   - the plan: for every row, the company / contact it links to (found,
 *     similar or created), the pipeline + phase + status + phase dates, who
 *     owns it, whether its company becomes a client, and what's wrong
 *   - running the import
 */
import { supabase } from "../../../api/supabase";
import { cellText, normHeader, parseBool, parseDate, parseNumber, type SheetCell } from "../../../framework/spreadsheetImport";
import type { Company, CompanyField, Contact, ContactField } from "../../companies/companiesApi";
import {
  saveCompany, saveContact, addCompanyField, addContactField, updateCompanyField, updateContactField, listCompanyFields, listContactFields,
} from "../../companies/companiesApi";
import type { Pipeline, Phase } from "../../settings/pipelineApi";
import type { Product } from "../../settings/catalogApi";
import type { LossReason, Tracking } from "../sales/salesApi";
import { addLossReason, saveClientProducts, loadClientIndex, matchClient, adoptClient } from "../sales/salesApi";
import type { TrackingField } from "./trackingFieldsApi";
import { addTrackingField, updateTrackingField, listTrackingFields } from "./trackingFieldsApi";
import { orderPhases, resolveDealRole, rolesFor, type SalesRole } from "./salesRolesApi";

/* ═══════════════════════════ targets ═══════════════════════════ */

export type FieldType = TrackingField["type"];
export type Entity = "deal" | "company" | "contact";
/** A custom field the import creates (on deals, companies or contacts). */
export interface NewField { tmp: string; entity: Entity; label: string; type: FieldType; options: string[] }
/** Any custom field, existing or new. */
export interface FieldDef { label: string; type: FieldType; options: string[]; required?: boolean; entity: Entity }
export interface Person { id: string; name: string; email?: string | null; role?: string }
export interface Column { i: number; letter: string; header: string; values: SheetCell[]; filled: number; samples: SheetCell[] }

export interface BaseTarget { key: string; label: string; group: "Company" | "Contact" | "Deal"; hint?: string }
export const BASE_TARGETS: BaseTarget[] = [
  { key: "company.name", label: "Company name (common)", group: "Company", hint: "How people call it, e.g. Genesal. A legal form (S.L., S.A., GmbH…) is moved to Legal name" },
  { key: "company.legal_name", label: "Legal name (razón social)", group: "Company", hint: "Razón social, as on invoices, e.g. Genesal Energy, S.L." },
  { key: "company.vat_number", label: "VAT / tax ID", group: "Company", hint: "The surest way to find the company" },
  { key: "company.reg_number", label: "Registration number", group: "Company" },
  { key: "company.website", label: "Website", group: "Company" },
  { key: "company.phone", label: "Company phone", group: "Company" },
  { key: "company.email", label: "Company email", group: "Company" },
  { key: "company.street", label: "Street / address", group: "Company" },
  { key: "company.addr_number", label: "Street number", group: "Company" },
  { key: "company.addr_details", label: "Address details", group: "Company" },
  { key: "company.postal_code", label: "Postal code", group: "Company" },
  { key: "company.city", label: "City", group: "Company" },
  { key: "company.province", label: "Province / state", group: "Company" },
  { key: "company.country", label: "Country", group: "Company" },
  { key: "company.notes", label: "Company notes", group: "Company" },
  { key: "contact.full_name", label: "Contact full name", group: "Contact", hint: "Found by email, phone or name, or created" },
  { key: "contact.first_name", label: "First name", group: "Contact" },
  { key: "contact.last_name", label: "Last name", group: "Contact" },
  { key: "contact.email", label: "Contact email", group: "Contact" },
  { key: "contact.phone", label: "Contact phone", group: "Contact" },
  { key: "contact.position", label: "Position / job title", group: "Contact" },
  { key: "contact.is_billing", label: "Billing contact (yes / no)", group: "Contact" },
  { key: "contact.notes", label: "Contact notes", group: "Contact" },
  { key: "deal.title", label: "Deal title", group: "Deal", hint: "The name at the top of the deal" },
  { key: "deal.pipeline", label: "Pipeline", group: "Deal" },
  { key: "deal.phase", label: "Phase", group: "Deal" },
  { key: "deal.status", label: "Status (open / won / lost)", group: "Deal" },
  { key: "deal.value", label: "Value / amount (€)", group: "Deal" },
  { key: "deal.product", label: "Product", group: "Deal" },
  { key: "deal.expected_close", label: "Expected close date", group: "Deal" },
  { key: "deal.close_date", label: "Close date", group: "Deal", hint: "Won on that date — the company becomes a client" },
  { key: "deal.probability", label: "Close probability (%)", group: "Deal" },
  { key: "deal.created", label: "Created on", group: "Deal" },
  { key: "deal.loss_reason", label: "Lost reason", group: "Deal" },
  { key: "deal.notes", label: "Deal notes", group: "Deal" },
];
export const COMPANY_COLS = ["name", "legal_name", "vat_number", "reg_number", "website", "phone", "email", "notes", "street", "addr_number", "addr_details", "postal_code", "city", "province", "country"] as const;
/** Targets whose file values are matched one by one to our options. */
export const VALUE_TARGETS = new Set(["deal.pipeline", "deal.phase", "deal.status", "deal.product", "deal.loss_reason"]);
/** Targets more than one column may use (their values are joined). */
/** Fields that take several columns as they are (joined), never merged by priority. */
export const MULTI_OK = new Set(["deal.notes", "deal.title", "company.notes", "contact.notes"]);
/** "phase_at:<phase id>": the column says the deal reached that phase, and when. */
export const PHASE_AT = "phase_at:";
export const isPhaseAt = (t: string) => t.startsWith(PHASE_AT);

const SYN: Record<string, string[]> = {
  "company.name": ["company", "company name", "empresa", "nombre empresa", "nombre de la empresa", "compania", "organization", "organisation", "organizacion", "account", "account name", "cliente", "client", "customer", "bedrijf", "bedrijfsnaam", "firma", "unternehmen", "lead company", "organization name"],
  "company.legal_name": ["legal name", "razon social", "nombre fiscal", "denominacion social", "company legal name", "nombre legal", "statutaire naam", "raison sociale", "registered name", "official name", "nombre registrado", "legal entity", "entidad legal"],
  "company.vat_number": ["vat", "vat number", "cif", "nif", "cif nif", "nif cif", "tax id", "btw", "btw nummer", "company vat", "vat id", "ust id", "numero fiscal"],
  "company.reg_number": ["registration number", "reg number", "company number", "kvk", "kvk nummer", "numero de registro", "registro mercantil", "handelsregister", "chamber of commerce"],
  "company.website": ["website", "web", "url", "domain", "company website", "sitio web", "pagina web", "company domain", "dominio"],
  "company.phone": ["company phone", "telefono empresa", "telefono de la empresa", "organization phone", "centralita", "phone company", "main phone", "office phone"],
  "company.email": ["company email", "email empresa", "correo empresa", "organization email", "general email", "email de la empresa", "info email"],
  "company.street": ["address", "street", "direccion", "calle", "domicilio", "adres", "straat", "address line 1", "billing street", "street address", "direccion postal", "company address"],
  "company.addr_number": ["street number", "numero calle", "huisnummer", "address number", "house number", "no calle"],
  "company.addr_details": ["address line 2", "address details", "address 2", "piso", "puerta", "piso puerta", "toevoeging", "detalles direccion"],
  "company.postal_code": ["postal code", "zip", "zip code", "postcode", "codigo postal", "cp", "c p", "post code", "billing postal code"],
  "company.city": ["city", "ciudad", "localidad", "town", "poblacion", "plaats", "stad", "municipio", "billing city"],
  "company.province": ["province", "provincia", "region", "comunidad", "county", "state province", "comunidad autonoma", "billing state"],
  "company.country": ["country", "pais", "land", "country code", "billing country"],
  "company.notes": ["company notes", "notas empresa", "organization notes", "notas de la empresa", "company description"],
  "contact.full_name": ["contact", "contact name", "contact person", "contacto", "persona de contacto", "nombre contacto", "nombre del contacto", "person", "contactpersoon", "ansprechpartner", "customer contact", "lead", "primary contact"],
  "contact.first_name": ["first name", "firstname", "contact first name", "nombre", "voornaam", "vorname", "given name"],
  "contact.last_name": ["last name", "lastname", "surname", "contact last name", "apellido", "apellidos", "achternaam", "nachname", "family name"],
  "contact.email": ["email", "e mail", "mail", "contact email", "correo", "correo electronico", "email contacto", "email address"],
  "contact.phone": ["phone", "telephone", "tel", "telefono", "mobile", "movil", "contact phone", "mobile phone", "telefono contacto", "telefono movil", "phone number"],
  "contact.position": ["position", "job title", "function", "cargo", "puesto", "functie", "title contact", "role"],
  "contact.is_billing": ["billing contact", "contacto facturacion", "contacto de facturacion", "is billing", "facturacion contacto", "invoice contact"],
  "contact.notes": ["contact notes", "notas contacto", "notas del contacto", "person notes"],
  "deal.title": ["title", "deal", "deal name", "deal title", "subject", "name", "titulo", "asunto", "oportunidad", "opportunity", "opportunity name", "onderwerp", "nombre del deal", "nombre de la oportunidad", "nombre oportunidad", "nombre del negocio", "negocio", "titulo del deal"],
  "deal.pipeline": ["pipeline", "pipeline name", "embudo", "funnel", "sales pipeline", "deal pipeline"],
  "deal.phase": ["phase", "stage", "deal phase", "deal stage", "fase", "etapa", "estado del deal", "fase actual", "current phase", "pipeline stage", "sales stage"],
  "deal.status": ["status", "estado", "state", "deal status", "result", "resultado", "outcome"],
  "deal.value": ["value", "amount", "deal value", "total", "importe", "valor", "precio", "price", "revenue", "estimated value", "waarde", "bedrag", "budget", "presupuesto"],
  "deal.product": ["product", "producto", "products", "service", "servicio", "productos"],
  "deal.expected_close": ["close date", "expected close date", "estimated closing date", "expected closing date", "closing date", "fecha de cierre", "fecha cierre", "fecha prevista", "fecha de cierre prevista", "fecha prevista de cierre", "expected closing", "deadline", "estimated close date", "forecast close date"],
  "deal.close_date": ["closed date", "closed on", "close time", "won time", "won date", "won on", "date won", "actual close date", "fecha ganado", "fecha de ganado", "fecha de firma", "fecha firma", "signed date", "signed on", "signing date", "fecha de cierre real", "fecha cierre real", "closed at", "fecha cerrado", "fecha de cierre efectiva"],
  "deal.probability": ["probability", "probabilidad", "chance", "win probability", "kans", "close probability", "%"],
  "deal.created": ["created", "created at", "created on", "creation date", "date created", "fecha de creacion", "fecha creacion", "fecha alta", "fecha de alta", "alta", "aangemaakt", "start date", "add time", "deal created"],
  "deal.loss_reason": ["lost reason", "loss reason", "reason lost", "motivo de perdida", "motivo perdida", "razon de perdida", "lost reason description"],
  "deal.notes": ["notes", "note", "notas", "comments", "comentarios", "description", "descripcion", "observaciones", "summary"],
  "__owner": ["owner", "responsible", "responsable", "deal owner", "sales rep", "comercial", "assigned to", "asignado a", "user", "usuario", "verantwoordelijke", "account manager", "vendedor"],
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LEGAL = /\b(s\s?l\s?u?|s\s?a\s?u?|s\s?l\s?l|s\s?c|s\s?coop|ltd|limited|llc|inc|corp|corporation|gmbh|ag|bv|nv|sarl|sas|srl|spa|plc|co|bvba|vof|cb|slp|aie)\b/g;
/** Company matching key: no accents/punctuation/legal suffix ("Acme, S.L." = "ACME"). */
export const nameKey = (s: string | null | undefined) => normHeader((s ?? "").replace(/\./g, "")).replace(LEGAL, " ").replace(/\s+/g, " ").trim();
/* ===========================================================================
   Tidy names and addresses — shared by every importer and the data clean-up
   =========================================================================== */
/** A legal form at the end of a company name: ", S.L.", " S.A.U.", " GmbH", " B.V."… */
const LEGAL_TAIL = /[\s,]+(?:s\.?\s?l\.?\s?u\.?|s\.?\s?l\.?\s?l\.?|s\.?\s?l\.?\s?p\.?|s\.?\s?l\.?|s\.?\s?a\.?\s?u\.?|s\.?\s?a\.?|s\.?\s?coop\.?(?:\s?and\.?)?|s\.?\s?c\.?|c\.?\s?b\.?|a\.?\s?i\.?\s?e\.?|ltd\.?|limited|llc|l\.?\s?l\.?\s?c\.?|inc\.?|corp\.?|corporation|gmbh|ag|b\.?\s?v\.?|n\.?\s?v\.?|bvba|vof|sarl|sas|s\.?\s?r\.?\s?l\.?|s\.?\s?p\.?\s?a\.?|plc|lda\.?)\s*\.?$/i;
export const hasLegalForm = (s: string | null | undefined) => !!s && LEGAL_TAIL.test(s.trim());
const SMALL_WORDS = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "i", "en", "of", "and", "the", "van", "der", "den", "und", "et", "da", "do", "dos"]);
/** "GENESAL ENERGY, S.L." → "Genesal Energy" (keeps casing unless the whole name is in capitals). */
export function commonCompanyName(s: string): string {
  let out = s.trim();
  for (let i = 0; i < 3 && LEGAL_TAIL.test(out); i++) out = out.replace(LEGAL_TAIL, "").trim();
  out = out.replace(/[\s,.;-]+$/, "").trim() || s.trim();
  const letters = out.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length > 3 && letters === letters.toUpperCase()) {
    out = out.split(/(\s+)/).map((w, i) => {
      if (/^\s+$/.test(w)) return w;
      const lw = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lw)) return lw;
      if (w.replace(/[^A-Za-zÀ-ÿ]/g, "").length <= 3) return w; // BBVA-style acronyms stay
      return lw.charAt(0).toUpperCase() + lw.slice(1);
    }).join("");
  }
  return out;
}
/**
 * The common name is what people call the company ("Genesal"); the legal name
 * is the one on invoices ("Genesal Energy, S.L."). A name with a legal form and
 * no legal name moves there and keeps a clean common name.
 */
export function splitCompanyNames(name: string | null | undefined, legal: string | null | undefined): { name: string; legal: string | null } {
  const n = (name ?? "").trim(), l = (legal ?? "").trim();
  if (n && !l && hasLegalForm(n)) return { name: commonCompanyName(n), legal: n };
  if (!n && l) return { name: commonCompanyName(l), legal: l };
  if (n && l && hasLegalForm(n) && nameKey(n) === nameKey(l)) return { name: commonCompanyName(n), legal: l };
  return { name: n, legal: l || null };
}

/** First names that often come second in a compound one (José María, María José…). */
const FIRST_NAMES = new Set(["maria", "jose", "luis", "carmen", "antonio", "juan", "angel", "manuel", "jesus", "pilar", "isabel", "francisco", "javier", "miguel", "ignacio", "teresa", "rosa", "elena", "ana", "victoria", "dolores", "luisa", "carlos", "pedro", "pablo", "fernando", "eugenia", "cristina", "angeles", "mercedes", "jaime", "andres", "ramon", "alberto", "enrique", "esther", "paz", "sol", "mar", "del", "de", "la", "los", "lluis", "josep", "joan", "jordi", "pau", "montserrat", "nuria", "laura", "marta", "eva", "alejandro", "david", "daniel", "felipe", "rafael", "vicente", "emilio", "ricardo", "eduardo", "gabriel", "agustin", "tomas", "martin", "lucia", "paula", "sofia", "ines", "beatriz", "belen", "raquel", "elisa", "eugenio", "gloria", "consuelo", "inmaculada", "concepcion", "asuncion", "amparo", "rocio", "lourdes", "begona", "guadalupe", "fatima", "jacinto", "ignasi", "xavier", "enric", "oriol", "albert", "marc", "anna", "mireia", "gemma", "clara", "ainhoa", "iker", "unai", "mikel", "jon", "ander", "aitor"]);
const foldName = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
/**
 * A first name that also carries the surname ("Ana García" / "García") loses
 * the repeated part. Returns null when nothing needs changing.
 */
export function dedupePersonName(first: string | null | undefined, last: string | null | undefined): { first: string; last: string | null; sure: boolean } | null {
  const f = (first ?? "").trim().replace(/\s+/g, " "), l = (last ?? "").trim().replace(/\s+/g, " ");
  if (!f || !l) return null;
  const fw = f.split(" "), lw = l.split(" ");
  const ff = foldName(f), fl = foldName(l);
  if (ff === fl) return null;
  // the whole surname at the end of the first name: "Ana García López" / "García López"
  if (fw.length > lw.length && ff.endsWith(" " + fl)) return { first: fw.slice(0, fw.length - lw.length).join(" "), last: l, sure: true };
  // the first name written again at the start of the surname: "Ana" / "Ana García"
  if (lw.length > fw.length && fl.startsWith(ff + " ")) {
    // "Rolando Pampillo" / "Rolando Pampillo González": the full name is in the
    // surname field, so the first name is its first word (asks for a look).
    if (fw.length >= 2 && fw.slice(1).some((w) => !FIRST_NAMES.has(foldName(w)))) return { first: fw[0], last: lw.slice(1).join(" "), sure: false };
    return { first: f, last: lw.slice(fw.length).join(" "), sure: true };
  }
  // part of the surname repeated: "Ana García" / "García López"
  for (let k = Math.min(fw.length - 1, lw.length); k >= 1; k--) {
    // "Pablo Serrano" / "Serrano Ruiz" is the usual case; "José María" / "María
    // López" could be a compound first name, so those ask for a look first.
    if (foldName(fw.slice(-k).join(" ")) === foldName(lw.slice(0, k).join(" "))) {
      return { first: fw.slice(0, fw.length - k).join(" "), last: l, sure: !FIRST_NAMES.has(foldName(fw[fw.length - k])) };
    }
  }
  return null;
}

/**
 * "Calle Mayor 12", "C/ Alcalá, nº 45, 3º B", "Avda. Diagonal 640-642" → street,
 * number and the rest. A number inside the name ("Calle 5 de Mayo") is left
 * alone. Returns null when the street has no number to take out.
 */
export function splitStreetNumber(street: string | null | undefined): { street: string; number: string; details: string | null } | null {
  const s = (street ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  const NUM = String.raw`(?:n[º°o]\.?\s*|num\.?\s*|nº\s*|no\.?\s*)?(\d{1,5}\s?[A-Za-z]?(?:\s?[-/]\s?\d{1,5}\s?[A-Za-z]?)?|s\/?n)`;
  const FLOOR = String.raw`(?:\d+\s*[ºª°o]|bajo|bj|entlo|entresuelo|principal|pral|planta|piso|puerta|pta|local|esc|escalera|izq|izda|dcha|dch|ático|atico|oficina|of|bloque|portal|nave|km)`;
  const tries: RegExp[] = [
    new RegExp(`^(.+?\\D)[,\\s]+${NUM}$`, "i"),                       // … 12
    new RegExp(`^(.+?\\D),\\s*${NUM}\\s*[,\\-]\\s*(.+)$`, "i"),           // …, 12, 3º B
    new RegExp(`^(.+?\\D)\\s+${NUM}[,\\s]+(${FLOOR}.*)$`, "i"),         // … 12 3º B / … 12 bajo
  ];
  for (const re of tries) {
    const m = s.match(re);
    if (!m) continue;
    const st = m[1].replace(/[,\s]+$/, "").trim();
    if (st.length < 3 || /^\d+$/.test(st)) continue;
    // "Polígono Sur, nave 3", "Carretera N-II km 5": that number isn't the street number
    if (/(?:^|[\s,])(?:nave|local|km|kilometro|kilómetro|portal|bloque|puerta|piso|planta|parcela|oficina|edificio|módulo|modulo|n|nº)\.?$/i.test(st)) continue;
    return { street: st, number: m[2].replace(/\s+/g, "").toUpperCase().replace("S/N", "s/n").replace(/^SN$/, "s/n"), details: m[3]?.trim() || null };
  }
  return null;
}

export const vatKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[\s.\-/]/g, "").replace(/^(ES|BE|NL|FR|DE|PT|IT|LU|AT)(?=[A-Z0-9]\d{6,})/, "");
const personKey = (s: string | null | undefined) => normHeader(s ?? "");
const phoneKey = (s: string | null | undefined) => { const d = (s ?? "").replace(/\D/g, ""); return d.length >= 7 ? d.slice(-9) : ""; };
const FREE_MAIL = new Set(["gmail", "googlemail", "hotmail", "outlook", "live", "msn", "yahoo", "icloud", "me", "aol", "gmx", "protonmail", "proton", "telefonica", "movistar", "yandex", "zoho", "mail", "orange", "vodafone", "ono", "terra", "wanadoo", "free", "hey"]);
/** "https://www.acme.es/x" or "ana@acme.es" → "acme" (null for free mail). */
export function domainKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const host = (s.includes("@") ? s.split("@")[1] : s.replace(/^https?:\/\//i, "").split(/[/?#]/)[0]).replace(/^www\./i, "").toLowerCase();
  const first = host.split(".")[0];
  return first && !FREE_MAIL.has(first) ? first : null;
}

/** Words that don't tell two companies apart ("Grupo Acme" ≈ "Acme"). */
const FUZZ_STOP = new Set(["grupo", "group", "the", "holding", "holdings", "international", "internacional", "sociedad", "compania", "company", "y", "and", "de", "del", "la", "el", "los", "las", "en", "of", "spain", "espana", "iberia", "europe", "solutions", "soluciones", "services", "servicios"]);
const fuzzTokens = (s: string | null | undefined) => nameKey(s).split(" ").filter((w) => w && !FUZZ_STOP.has(w));
function bigrams(s: string) { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; }
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a), B = bigrams(b); let hit = 0;
  A.forEach((n, g) => { hit += Math.min(n, B.get(g) ?? 0); });
  return (2 * hit) / (a.length - 1 + b.length - 1);
}
/* The closest CRM name, fast with thousands of companies: an index of each name's letter pairs. */
interface FuzzItem { c: Company; toks: string[]; compact: string; nb: number }
interface FuzzIndex { items: FuzzItem[]; post: Map<string, number[]>; cache: Map<string, { c: Company; s: number } | null> }
const FUZZ_INDEX = new WeakMap<Company[], FuzzIndex>();
const pairsOf = (s: string) => { const out = new Set<string>(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out; };
function fuzzIndex(companies: Company[]): FuzzIndex {
  let idx = FUZZ_INDEX.get(companies);
  if (idx) return idx;
  idx = { items: [], post: new Map(), cache: new Map() };
  for (const c of companies) for (const n of [c.name, c.legal_name]) {
    if (!n) continue;
    const toks = fuzzTokens(n), compact = toks.join("");
    if (compact.length < 2) continue;
    const pairs = pairsOf(compact);
    const k = idx.items.push({ c, toks, compact, nb: pairs.size }) - 1;
    pairs.forEach((g) => { const l = idx!.post.get(g); if (l) l.push(k); else idx!.post.set(g, [k]); });
  }
  FUZZ_INDEX.set(companies, idx);
  return idx;
}
export function closestCompany(companies: Company[], name: string): { c: Company; s: number } | null {
  const idx = fuzzIndex(companies);
  if (idx.cache.has(name)) return idx.cache.get(name)!;
  const toks = fuzzTokens(name), compact = toks.join("");
  let best: { c: Company; s: number } | null = null;
  if (compact.length >= 2) {
    const pairs = pairsOf(compact);
    const hits = new Map<number, number>();
    pairs.forEach((g) => idx.post.get(g)?.forEach((k) => hits.set(k, (hits.get(k) ?? 0) + 1)));
    hits.forEach((h, k) => {
      const it = idx.items[k];
      let sc = it.compact === compact ? 0.97 : (2 * h) / (pairs.size + it.nb);
      if (sc < 0.84) {
        const [sm, lg] = toks.length <= it.toks.length ? [toks, it.toks] : [it.toks, toks];
        if (sm.join("").length >= 4 && sm.every((w) => lg.includes(w))) sc = 0.84;
      }
      if (sc > (best?.s ?? 0)) best = { c: it.c, s: sc };
    });
  }
  idx.cache.set(name, best);
  return best;
}
/** 0…1: how alike two company names are, past spelling, suffixes and filler words. */
export function companySimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = fuzzTokens(a), tb = fuzzTokens(b);
  if (!ta.length || !tb.length) return 0;
  const ca = ta.join(""), cb = tb.join("");
  if (ca === cb) return 0.97;
  const [s, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const contained = s.join("").length >= 4 && s.every((w) => l.includes(w)) ? 0.84 : 0;
  return Math.max(dice(ca, cb), contained);
}

/** A cell as a date, strictly ("1" or "x" are not dates). */
export function asDate(c: SheetCell): string | null {
  if (c == null || c === "") return null;
  if (typeof c === "object" || typeof c === "number") return parseDate(c);
  if (typeof c !== "string") return null;
  const s = c.trim();
  return /\d/.test(s) && /[-/.\s]/.test(s) && s.length >= 6 ? parseDate(s) : null;
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
  if (vals.length && vals.every((v) => EMAIL_RE.test(v))) return /empresa|company|organi[sz]ation|general|info/.test(h) ? "company.email" : "contact.email";
  // otherwise the longest known phrase inside the header wins ("Nombre de la oportunidad" → title, not first name)
  let best: { k: string; len: number } | null = null;
  for (const k of keys) for (const syn of SYN[k]) if (syn.length > 4 && h.includes(syn) && (!best || syn.length > best.len)) best = { k, len: syn.length };
  return best?.k ?? null;
}

/** A dated column named after one of your phases ("Fecha SQL", "Proposal date") → reached that phase. */
export function guessPhaseAt(ctx: Pick<Ctx, "pipelines" | "phaseByPipe">, header: string, samples: SheetCell[], prefer?: string): string | null {
  const h = normHeader(header);
  const filled = samples.filter((s) => s != null && s !== "");
  // mostly dates ("x" or "yes" in a few rows still say the phase was reached)
  if (!h || !filled.length || filled.filter((s) => asDate(s)).length < Math.max(1, filled.length * 0.6)) return null;
  let best: { id: string; len: number } | null = null;
  for (const p of sortedPipelines(ctx as Ctx, prefer)) for (const ph of phasesOf(ctx as Ctx, p.id)) {
    const k = normHeader(ph.name);
    if (k.length >= 2 && (` ${h} `).includes(` ${k} `) && (!best || k.length > best.len)) best = { id: ph.id, len: k.length };
  }
  return best ? `${PHASE_AT}${best.id}` : null;
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
  if (vals.every((v) => typeof v === "object" || (typeof v === "string" && asDate(v)))) return { type: "date", options: [] };
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
  companyFields: CompanyField[];
  contactFields: ContactField[];
  people: Person[];
  roles: SalesRole[];
  companies: Company[];
  contacts: Contact[];
  trackings: Tracking[];
  /** Company ids that already are clients in management. */
  clientCompanies: string[];
}

/** Companies that already are clients in management (so a won deal doesn't create them twice). */
export async function listClientCompanyIds(): Promise<string[]> {
  const { data } = await supabase.from("clients").select("company_id");
  return [...new Set(((data ?? []) as any[]).map((r) => r.company_id).filter(Boolean))];
}

/**
 * What happens to a company / contact that's already in the CRM:
 *   fill    → only its empty fields take the file's values
 *   replace → every field the file has a value for is overwritten (empty cells never erase anything)
 *   keep    → nothing changes; it's only linked to its deals
 */
export type ExistingMode = "fill" | "replace" | "keep";
export const EXISTING_LABEL: Record<ExistingMode, string> = { fill: "Fill empty fields only", replace: "Replace with the file's data", keep: "Keep the CRM data" };
export interface FieldChange { key: string; label: string; from: string; to: string }
export interface RecordDiff { fill: FieldChange[]; change: FieldChange[] }
const shown = (v: any) => (typeof v === "boolean" ? (v ? "Yes" : "No") : String(v ?? ""));
/** The file's values against a CRM record: which empty fields it fills, which filled ones it changes. */
export function diffRecord(crm: any, file: Record<string, any>, custom: Record<string, any>, labelOf: (k: string, custom: boolean) => string): RecordDiff {
  const out: RecordDiff = { fill: [], change: [] };
  const empty = (k: string, v: any) => v == null || (typeof v === "string" && !v.trim()) || (k === "is_billing" && v === false);
  const eq = (k: string, a: any, b: any) => (k === "vat_number" ? vatKey(a) === vatKey(b) : normHeader(shown(a)) === normHeader(shown(b)));
  const check = (k: string, cur: any, v: any, isCustom: boolean) => {
    if (v == null || v === "" || (k === "is_billing" && v !== true)) return;
    const item = { key: isCustom ? `custom.${k}` : k, label: labelOf(k, isCustom), from: shown(cur), to: shown(v) };
    if (empty(k, cur)) out.fill.push(item); else if (!eq(k, cur, v)) out.change.push(item);
  };
  for (const [k, v] of Object.entries(file)) check(k, crm?.[k], v, false);
  for (const [k, v] of Object.entries(custom)) check(k, crm?.custom?.[k], v, true);
  return out;
}
/** The update a CRM record gets for a mode (null = nothing to write). */
export function patchFor(mode: ExistingMode, crm: any, d: RecordDiff, file: Record<string, any>, custom: Record<string, any>): Record<string, any> | null {
  if (mode === "keep") return null;
  const items = mode === "replace" ? [...d.fill, ...d.change] : d.fill;
  if (!items.length) return null;
  const patch: Record<string, any> = {};
  const merged: Record<string, any> = { ...(crm.custom ?? {}) };
  let customChanged = false;
  for (const it of items) {
    if (it.key.startsWith("custom.")) { merged[it.key.slice(7)] = custom[it.key.slice(7)]; customChanged = true; }
    else patch[it.key] = file[it.key];
  }
  if (customChanged) patch.custom = merged;
  return patch;
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
  /** For rows with no product (empty, or a value sent to "default"). "" = none. */
  defaultProduct: string;
  rules: Rule[];
  /** person → the role they play on the imported deals (when they have several) */
  personRole: Record<string, string>;
  /** file company key → "create" | "skip" | "crm:<id>" */
  companyChoice: Record<string, string>;
  /** file contact key → "create" | "skip" | "crm:<id>" */
  contactChoice: Record<string, string>;
  /** row index → pipeline chosen by hand in the review */
  pipeOverride: Record<number, string>;
  createContacts: boolean;
  /**
   * A deal of the file is already in the CRM (same company — or contact — and pipeline,
   * and the same title when both have one): skip it, update it with the file's data,
   * or create it again anyway.
   */
  dupMode: "skip" | "update" | "import";
  /** Stamp the phases before the current one as passed (keeps reports and roles right). */
  markPassed: boolean;
  /** Companies already in the CRM: fill their empty fields, replace their data with the file's, or keep them as they are. */
  coExisting: ExistingMode;
  /** Same for contacts already in the CRM. */
  ctExisting: ExistingMode;
  /** Link contacts found in the CRM to the deal's company when they aren't yet. */
  linkContacts: boolean;
  /** Won deals with a close date turn their company into a client. */
  makeClients: boolean;
}

export const emptyState = (): ImportState => ({
  mapping: {}, newFields: [], valueMaps: {}, defaultPipeline: "", defaultProduct: "", rules: [], personRole: {},
  companyChoice: {}, contactChoice: {}, pipeOverride: {}, createContacts: true, dupMode: "skip", markPassed: true,
  coExisting: "fill", ctExisting: "fill", linkContacts: true, makeClients: true,
});

/** Any option a caller didn't pass takes its default (never crashes on a missing map). */
const withDefaults = (s: Partial<ImportState>): ImportState => {
  const d = emptyState();
  const out: any = { ...d };
  for (const [k, v] of Object.entries(s)) if (v !== undefined && v !== null) out[k] = v;
  return out as ImportState;
};

/* ═══════════════════════════ fields ═══════════════════════════ */

/** The custom field a target writes to: deal (custom:), company (cocustom:), contact (ctcustom:) or new (new:). */
export function defOf(ctx: Pick<Ctx, "fields" | "companyFields" | "contactFields">, state: Pick<ImportState, "newFields">, t: string): FieldDef | null {
  const pick = (list: { id: string; label: string; type: string; options: string[]; required?: boolean }[], id: string, entity: Entity) => {
    const f = list.find((x) => x.id === id);
    // a multiple-choice company / contact field imports like a dropdown (one value per row)
    return f ? { label: f.label, type: (f.type === "multiselect" ? "select" : f.type) as FieldType, options: f.options ?? [], required: !!f.required, entity } : null;
  };
  if (t.startsWith("custom:")) return pick(ctx.fields, t.slice(7), "deal");
  if (t.startsWith("cocustom:")) return pick(ctx.companyFields ?? [], t.slice(9), "company");
  if (t.startsWith("ctcustom:")) return pick(ctx.contactFields ?? [], t.slice(9), "contact");
  if (t.startsWith("new:")) { const n = state.newFields.find((x) => x.tmp === t.slice(4)); return n ? { label: n.label, type: n.type, options: n.options, entity: n.entity } : null; }
  return null;
}
export const ENTITY_LABEL: Record<Entity, string> = { deal: "Deal", company: "Company", contact: "Contact" };

/** Does each value of this column need matching to an option? */
export const hasValueStep = (ctx: Ctx, state: ImportState, t: string) => VALUE_TARGETS.has(t) || defOf(ctx, state, t)?.type === "select";

/* ═══════════════════════════ matching values ═══════════════════════════ */

const STATUS_SYN: Record<string, string[]> = {
  won: ["won", "win", "ganado", "ganada", "gewonnen", "closed won", "cerrado ganado", "accepted", "aceptado", "signed", "firmado", "success", "exito", "gagne", "cliente"],
  lost: ["lost", "loss", "perdido", "perdida", "verloren", "closed lost", "cerrado perdido", "refused", "rechazado", "declined", "cancelled", "cancelado", "perdu", "descartado"],
  paused: ["hold", "on hold", "paused", "pausado", "en pausa", "parado", "frozen", "waiting", "en espera"],
  active: ["open", "active", "abierto", "abierta", "activo", "activa", "in progress", "en curso", "new", "nuevo", "lopend", "offen", "pending", "pendiente"],
};
export const STATUS_LABEL: Record<string, string> = { active: "Active", won: "Won", lost: "Lost", paused: "Hold" };

export const sortedPipelines = (ctx: Pick<Ctx, "pipelines">, first?: string) =>
  [...ctx.pipelines].sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : 0));
export const phasesOf = (ctx: Pick<Ctx, "phaseByPipe">, pid: string | null | undefined) => (pid ? orderPhases(ctx.phaseByPipe[pid] ?? []) : []);

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

const optionMatch = (options: string[], raw: string) => {
  const n = normHeader(raw);
  return options.find((o) => normHeader(o) === n) ?? options.find((o) => { const k = normHeader(o); return k.length >= 3 && n.length >= 3 && (k.startsWith(n) || n.startsWith(k)); }) ?? null;
};

/** The automatic choice for one file value of a value target (null = needs a decision). */
export function autoChoice(ctx: Ctx, target: string, raw: string, state: Pick<ImportState, "defaultPipeline" | "newFields">): string | null {
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
  const def = defOf(ctx, state, target);
  if (def?.type === "select") return optionMatch(def.options, raw);
  return null;
}
/** What to do with a value nobody decided and that matched nothing. */
export function fallbackChoice(target: string): string {
  if (target === "deal.pipeline") return "__default";
  if (target === "deal.phase") return "__first";
  if (target === "deal.status") return "active";
  if (target === "deal.product") return "__default";
  if (target === "deal.loss_reason") return "__details";
  return "__new"; // choice-list field: add it as a new option
}
/** A choice picked earlier that no longer exists (an option renamed or removed) is ignored. */
function stillValid(ctx: Ctx, state: ImportState, target: string, choice: string): boolean {
  if (choice.startsWith("__")) return true;
  const def = defOf(ctx, state, target);
  if (def?.type === "select") return def.options.includes(choice);
  if (target === "deal.pipeline") return ctx.pipelines.some((p) => p.id === choice);
  if (target === "deal.product") return ctx.products.some((p) => p.id === choice);
  return true;
}
export function choiceFor(ctx: Ctx, state: ImportState, target: string, raw: string): { choice: string; auto: boolean; matched: boolean } {
  const picked = state.valueMaps[target]?.[normHeader(raw)];
  if (picked && stillValid(ctx, state, target, picked)) return { choice: picked, auto: false, matched: true };
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

export type CompanyFoundBy = "vat" | "name" | "legal" | "domain" | "similar";
export interface CompanyName {
  key: string; name: string;
  /** Everything the file says about it (first value seen per field). */
  data: Partial<Record<(typeof COMPANY_COLS)[number], string>>;
  custom: Record<string, any>;
  count: number;
  /** "crm:<id>" when it's already in the CRM. */
  found: string | null; foundBy?: CompanyFoundBy; score?: number;
  /** A CRM company that looks like it but wasn't linked on its own. */
  suggest?: { id: string; name: string; score: number; why: string } | null;
  /** What happens: "crm:<id>" | "new:<key>" | null (no company). */
  ref: string | null;
  isClient: boolean;
  /** When it's linked to a CRM company: what the file would fill / change there. */
  diff?: RecordDiff | null;
}
export type ContactFoundBy = "email" | "phone" | "name";
export interface ContactName {
  key: string; first_name: string; last_name: string | null; email: string | null; phone: string | null; position: string | null;
  notes: string | null; is_billing: boolean | null; custom: Record<string, any>;
  count: number;
  found: string | null; foundBy?: ContactFoundBy;
  /** The company of its deals ("crm:" / "new:" / null). */
  companyRef: string | null; companyLabel: string | null;
  /** How it relates to that company: linked already, will be linked, or no company. */
  link: "linked" | "link" | "none";
  ref: string | null;
  /** When it's linked to a CRM contact: what the file would fill / change there. */
  diff?: RecordDiff | null;
}
/** Kept for the run: the contacts that get created. */
export type NewContact = ContactName;

export interface PlanRow {
  idx: number;
  status: "new" | "update" | "dup" | "error";
  reason?: string;
  /** The deal already in the CRM this row is (skipped, or updated). */
  dupOf: string | null;
  issues: string[];
  companyRef: string | null; companyLabel: string | null; companyKey: string | null;
  contactRef: string | null; contactLabel: string | null; contactKey: string | null;
  pipelineId: string | null; pipeOverridden: boolean; phaseId: string | null; reachedPhaseId: string | null; dealStatus: string;
  /** Phase id → the day it was entered (ISO), for every phase stamped. */
  phaseDates: Record<string, string>;
  value: number | null; productId: string | null; productDefaulted: boolean;
  owner: string | null; team: string[]; dealRoles: Record<string, string>;
  expectedClose: string | null; closedOn: string | null; probability: number | null; created: string | null;
  /** Its company becomes a client (won with a close date). */
  becomesClient: boolean;
  title: string | null; notes: string[]; lossReason: string | null; lossDetails: string | null; newLossReason: boolean;
  custom: Record<string, any>;
}
export interface Plan {
  rows: PlanRow[];
  companies: CompanyName[];
  contacts: ContactName[];
  /** The contacts that will be created. */
  newContacts: ContactName[];
  counts: {
    new: number; update: number; dup: number; error: number; warn: number; coNew: number; coFound: number; coSimilar: number; ctNew: number; ctFound: number; ctLink: number;
    noOwner: number; clients: number; won: number;
    /** Companies / contacts in the CRM the import touches, and how many of their fields it would fill or change. */
    coExisting: number; coFill: number; coChange: number; ctExisting: number; ctFill: number; ctChange: number;
  };
}

interface Parsed {
  get: Record<string, string[]>; cells: Record<string, SheetCell>;
  custom: Record<string, any>; coCustom: Record<string, any>; ctCustom: Record<string, any>;
  hits: { phaseId: string; date: string | null; raw: string }[];
  issues: string[];
}

/** A deal title as compared for duplicates (case, accents, spaces and punctuation don't count). */
const titleKey = (s: string | null | undefined) => normHeader((s ?? "").slice(0, 200));
const minDay = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort()[0] ?? null;
const maxDay = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort().reverse()[0] ?? null;

export function buildPlan(ctx: Ctx, columns: Column[], rows: SheetCell[][], state: ImportState): Plan {
  state = withDefaults(state);
  void columns;
  const today = new Date().toISOString().slice(0, 10);
  const phaseById = new Map(Object.values(ctx.phaseByPipe).flat().map((p) => [p.id, p]));

  /* ---- indexes of what's in the CRM ---- */
  const coByVat = new Map<string, Company>(), coByName = new Map<string, Company>(), coByDomain = new Map<string, Company>();
  ctx.companies.forEach((c) => {
    const v = vatKey(c.vat_number); if (v && !coByVat.has(v)) coByVat.set(v, c);
    [c.name, c.legal_name].forEach((n) => { const k = nameKey(n); if (k && !coByName.has(k)) coByName.set(k, c); });
    [c.website, c.email].forEach((x) => { const d = domainKey(x); if (d && !coByDomain.has(d)) coByDomain.set(d, c); });
  });
  const ctByEmail = new Map<string, Contact>(), ctByName = new Map<string, Contact[]>(), ctByPhone = new Map<string, Contact[]>();
  ctx.contacts.forEach((c) => {
    if (c.email) ctByEmail.set(c.email.trim().toLowerCase(), c);
    const k = personKey([c.first_name, c.last_name].filter(Boolean).join(" "));
    if (k) ctByName.set(k, [...(ctByName.get(k) ?? []), c]);
    const p = phoneKey(c.phone); if (p) ctByPhone.set(p, [...(ctByPhone.get(p) ?? []), c]);
  });
  const clients = new Set(ctx.clientCompanies ?? []);
  // deals already in the CRM, by who they're for and their pipeline (newest first)
  const dealsByKey = new Map<string, Tracking[]>();
  const addDeal = (k: string, t: Tracking) => dealsByKey.set(k, [...(dealsByKey.get(k) ?? []), t]);
  ctx.trackings.forEach((t) => {
    if (t.company_id) addDeal(`co:${t.company_id}|${t.pipeline_id ?? ""}`, t);
    else (t.contactIds ?? []).forEach((c) => addDeal(`ct:${c}|${t.pipeline_id ?? ""}`, t));
  });
  /** The same deal twice in the file: who + pipeline + title (or product) → first row. */
  const seenInFile = new Map<string, number>();

  /* ---- 1) read every row ---- */
  const parsed: Parsed[] = rows.map((r) => {
    const p: Parsed = { get: {}, cells: {}, custom: {}, coCustom: {}, ctCustom: {}, hits: [], issues: [] };
    for (const [colS, t] of Object.entries(state.mapping)) {
      if (!t) continue;
      const cell = r[+colS] ?? null;
      if (cell == null || cell === "") continue;
      const txt = cellText(cell).trim();
      if (!txt) continue;
      if (isPhaseAt(t)) {
        const ph = phaseById.get(t.slice(PHASE_AT.length));
        if (!ph) continue;
        const d = asDate(cell);
        if (!d && parseBool(cell) === false) continue; // "No" / "0" → didn't reach it
        if (!d) p.issues.push(`${ph.name}: “${txt}” isn't a date — counted as reached, without its date`);
        p.hits.push({ phaseId: ph.id, date: d, raw: txt });
        continue;
      }
      const def = defOf(ctx, state, t);
      if (def) {
        const bucket = def.entity === "company" ? p.coCustom : def.entity === "contact" ? p.ctCustom : p.custom;
        if (def.type === "number") { const n = parseNumber(cell); if (n != null) bucket[t] = n; else p.issues.push(`${def.label}: “${txt}” isn't a number`); }
        else if (def.type === "date") { const d = asDate(cell) ?? parseDate(cell); if (d) bucket[t] = d; else p.issues.push(`${def.label}: “${txt}” isn't a date`); }
        else if (def.type === "boolean") { const b = parseBool(cell); if (b != null) bucket[t] = b; else p.issues.push(`${def.label}: “${txt}” isn't yes/no`); }
        else if (def.type === "select") { const ch = choiceFor(ctx, state, t, txt).choice; if (ch === "__new") bucket[t] = txt; else if (ch !== "__empty") bucket[t] = ch; }
        else bucket[t] = txt;
        continue;
      }
      (p.get[t] ??= []).push(txt);
      if (!(t in p.cells)) p.cells[t] = cell;
    }
    return p;
  });
  const oneOf = (p: Parsed, k: string) => p.get[k]?.[0] ?? null;

  /* ---- 2) the companies in the file ---- */
  const companies = new Map<string, CompanyName>();
  const keyByVat = new Map<string, string>(), keyByName = new Map<string, string>();
  const rowCoKey: (string | null)[] = parsed.map((p) => {
    const name = oneOf(p, "company.name"), legal = oneOf(p, "company.legal_name"), vat = oneOf(p, "company.vat_number");
    if (!name && !legal && !vat) return null;
    const vk = vatKey(vat), nk = nameKey(name ?? legal), lk = nameKey(legal);
    // the same company written two ways in the file (one row with the VAT, one without) is one company
    const key = (vk && keyByVat.get(vk)) || (nk && keyByName.get(nk)) || (lk && keyByName.get(lk)) || nk || lk || `vat:${vk}`;
    if (vk && !keyByVat.has(vk)) keyByVat.set(vk, key);
    if (nk && !keyByName.has(nk)) keyByName.set(nk, key);
    if (lk && !keyByName.has(lk)) keyByName.set(lk, key);
    const e = companies.get(key) ?? { key, name: name || legal || vat || "", data: {}, custom: {}, count: 0, found: null, ref: null, isClient: false };
    e.count++;
    if (!e.name || (e.name === vat && (name || legal))) e.name = name || legal || e.name;
    for (const col of COMPANY_COLS) { const v = oneOf(p, `company.${col}`); if (v && !e.data[col]) e.data[col] = col === "vat_number" ? v.toUpperCase().replace(/[\s.\-/]/g, "") : v; }
    if (e.data.street && !e.data.addr_number) {
      const sp = splitStreetNumber(e.data.street);
      if (sp) { e.data.street = sp.street; e.data.addr_number = sp.number; if (sp.details && !e.data.addr_details) e.data.addr_details = sp.details; }
    }
    if (!e.data.name) e.data.name = e.name;
    for (const [k, v] of Object.entries(p.coCustom)) if (!(k in e.custom)) e.custom[k] = v;
    companies.set(key, e);
    return key;
  });
  // contact email domains of each company's rows: a last hint
  const mailDomains = new Map<string, Set<string>>();
  parsed.forEach((p, i) => { const k = rowCoKey[i]; const d = domainKey(oneOf(p, "contact.email")); if (k && d) { const s = mailDomains.get(k) ?? new Set<string>(); s.add(d); mailDomains.set(k, s); } });
  companies.forEach((e) => {
    const vk = vatKey(e.data.vat_number);
    let hit: Company | undefined, by: CompanyFoundBy | undefined, score: number | undefined;
    if (vk && coByVat.get(vk)) { hit = coByVat.get(vk); by = "vat"; }
    else if (nameKey(e.name) && coByName.get(nameKey(e.name))) { hit = coByName.get(nameKey(e.name)); by = "name"; }
    else if (e.data.legal_name && coByName.get(nameKey(e.data.legal_name))) { hit = coByName.get(nameKey(e.data.legal_name)); by = "legal"; }
    else {
      const doms = [domainKey(e.data.website), domainKey(e.data.email)].filter(Boolean) as string[];
      const dHit = doms.map((d) => coByDomain.get(d)).find(Boolean);
      if (dHit) { hit = dHit; by = "domain"; }
    }
    // spelled differently: the closest name in the CRM
    let best: { c: Company; s: number } | null = null;
    if (!hit) {
      best = closestCompany(ctx.companies, e.name);
      if (e.data.legal_name) { const l = closestCompany(ctx.companies, e.data.legal_name); if (l && l.s > (best?.s ?? 0)) best = l; }
      // the contacts' email domain is the company's website → it's the one
      const md = [...(mailDomains.get(e.key) ?? [])].map((d) => coByDomain.get(d)).find(Boolean);
      if (md && companySimilarity(e.name, md.name) >= 0.5) { hit = md; by = "domain"; }
      else if (best && best.s >= 0.9) { hit = best.c; by = "similar"; score = best.s; }
    }
    // a VAT in both that doesn't match means it's another company, whatever the name says
    if (hit && by !== "vat" && vk && vatKey(hit.vat_number) && vatKey(hit.vat_number) !== vk) {
      e.suggest = { id: hit.id!, name: hit.name, score: 0.6, why: "same name, different VAT" };
      hit = undefined; by = undefined;
    }
    if (hit) { e.found = `crm:${hit.id}`; e.foundBy = by; e.score = score; e.isClient = clients.has(hit.id!); }
    else if (!e.suggest && best && best.s >= 0.72) e.suggest = { id: best.c.id!, name: best.c.name, score: best.s, why: `${Math.round(best.s * 100)}% alike` };
    const ch = state.companyChoice[e.key];
    if (ch === "skip") e.ref = null;
    else if (ch && ch.startsWith("crm:")) e.ref = ch;
    else if (ch === "create") e.ref = `new:${e.key}`;
    else e.ref = e.found ?? `new:${e.key}`;
    if (e.ref?.startsWith("crm:")) e.isClient = clients.has(e.ref.slice(4));
  });
  const coLabel = (ref: string | null, fallback: string) => (!ref ? null : ref.startsWith("crm:") ? ctx.companies.find((c) => c.id === ref.slice(4))?.name ?? fallback : fallback);

  /* ---- 3) each row's company (or one found from the contact's email domain) ---- */
  const rowCo = parsed.map((p, i) => {
    const k = rowCoKey[i];
    if (k) { const e = companies.get(k)!; return { ref: e.ref, label: coLabel(e.ref, e.name), key: k }; }
    const d = domainKey(oneOf(p, "contact.email"));
    const hit = d ? coByDomain.get(d) : undefined;
    if (hit) { p.issues.push(`Company found from the email domain: ${hit.name}`); return { ref: `crm:${hit.id}`, label: hit.name, key: null }; }
    return { ref: null as string | null, label: null as string | null, key: null as string | null };
  });

  /* ---- 4) the contacts in the file ---- */
  const contacts = new Map<string, ContactName>();
  const rowCtKey: (string | null)[] = parsed.map((p, i) => {
    let first = oneOf(p, "contact.first_name"), last = oneOf(p, "contact.last_name");
    const full = oneOf(p, "contact.full_name");
    if (full && !first) {
      // "García, Ana" → Ana García
      const f = full.includes(",") ? full.split(",").map((x) => x.trim()).reverse().join(" ") : full;
      const parts = f.split(/\s+/); first = parts[0]; if (!last && parts.length > 1) last = parts.slice(1).join(" ");
    }
    { const dd = dedupePersonName(first, last); if (dd) { first = dd.first; last = dd.last ?? last; } }
    const rawEmail = (oneOf(p, "contact.email") ?? "").trim().toLowerCase() || null;
    const email = rawEmail && EMAIL_RE.test(rawEmail) ? rawEmail : null;
    if (rawEmail && !email) p.issues.push(`“${rawEmail}” isn't a valid email`);
    if (!first && email) {
      const local = email.split("@")[0].split(/[._-]+/).filter(Boolean);
      if (local[0] && local.length > 1) { first = local[0][0].toUpperCase() + local[0].slice(1); last = local.slice(1).map((x) => x[0].toUpperCase() + x.slice(1)).join(" "); }
    }
    const phone = oneOf(p, "contact.phone");
    if (!first && !email) return null;
    const nameK = personKey([first, last].filter(Boolean).join(" "));
    const coRef = rowCo[i].ref;
    const key = email ? `e:${email}` : `n:${nameK}|${coRef ?? ""}`;
    const e = contacts.get(key) ?? {
      key, first_name: first || email!.split("@")[0], last_name: last, email, phone, position: oneOf(p, "contact.position"),
      notes: p.get["contact.notes"]?.join("\n\n") ?? null, is_billing: oneOf(p, "contact.is_billing") != null ? parseBool(oneOf(p, "contact.is_billing")) : null,
      custom: {}, count: 0, found: null, companyRef: coRef, companyLabel: rowCo[i].label, link: "none" as const, ref: null,
    };
    e.count++;
    if (!e.phone && phone) e.phone = phone;
    if (!e.position) e.position = oneOf(p, "contact.position");
    if (!e.last_name && last) e.last_name = last;
    if (!e.companyRef && coRef) { e.companyRef = coRef; e.companyLabel = rowCo[i].label; }
    for (const [k, v] of Object.entries(p.ctCustom)) if (!(k in e.custom)) e.custom[k] = v;
    contacts.set(key, e);
    return key;
  });
  contacts.forEach((e) => {
    const coId = e.companyRef?.startsWith("crm:") ? e.companyRef.slice(4) : null;
    const nameK = personKey([e.first_name, e.last_name].filter(Boolean).join(" "));
    let hit: Contact | undefined, by: ContactFoundBy | undefined;
    if (e.email && ctByEmail.get(e.email)) { hit = ctByEmail.get(e.email); by = "email"; }
    if (!hit && phoneKey(e.phone)) {
      const same = (ctByPhone.get(phoneKey(e.phone)) ?? []).filter((c) => !nameK || personKey([c.first_name, c.last_name].filter(Boolean).join(" ")).split(" ")[0] === nameK.split(" ")[0]);
      if (same.length === 1) { hit = same[0]; by = "phone"; }
    }
    if (!hit && nameK) {
      const same = ctByName.get(nameK) ?? [];
      // the same name at the same company, or the only one with that name (and no other company)
      hit = (coId ? same.find((c) => c.companyIds.includes(coId)) : undefined)
        ?? (same.length === 1 && !e.email && (!coId || !same[0].companyIds.length || !e.companyRef) ? same[0] : undefined);
      if (hit) by = "name";
    }
    if (hit) { e.found = `crm:${hit.id}`; e.foundBy = by; }
    const ch = state.contactChoice[e.key];
    if (ch === "skip") e.ref = null;
    else if (ch && ch.startsWith("crm:")) e.ref = ch;
    else if (ch === "create") e.ref = `new:${e.key}`;
    else e.ref = e.found ?? (state.createContacts ? `new:${e.key}` : null);
    const crm = e.ref?.startsWith("crm:") ? ctx.contacts.find((c) => c.id === e.ref!.slice(4)) : null;
    e.link = !e.companyRef ? "none" : crm && coId && crm.companyIds.includes(coId) ? "linked" : "link";
  });
  const ctLabel = (e: ContactName) => {
    if (e.ref?.startsWith("crm:")) { const c = ctx.contacts.find((x) => x.id === e.ref!.slice(4)); if (c) return [c.first_name, c.last_name].filter(Boolean).join(" "); }
    return [e.first_name, e.last_name].filter(Boolean).join(" ");
  };

  /* ---- 5) the deals ---- */
  const owners = state.rules.filter((r) => r.as === "owner");
  const teams = state.rules.filter((r) => r.as === "team");
  const firstPhase = (pid: string | null) => phasesOf(ctx, pid).find((p) => !p.sales_outcome) ?? phasesOf(ctx, pid)[0] ?? null;

  const planRows: PlanRow[] = parsed.map((p, idx) => {
    const r = rows[idx];
    const issues = p.issues;
    const one = (k: string) => oneOf(p, k);
    const { ref: companyRef, label: companyLabel, key: companyKey } = rowCo[idx];
    const ctKey = rowCtKey[idx];
    const ct = ctKey ? contacts.get(ctKey)! : null;
    const contactRef = ct?.ref ?? null;
    const contactLabel = ct && contactRef ? ctLabel(ct) : null;

    /* pipeline, phase, status */
    const pipeRaw = one("deal.pipeline"), phaseRaw = one("deal.phase"), statusRaw = one("deal.status");
    let pipelineId: string | null = null;
    if (pipeRaw) { const ch = choiceFor(ctx, state, "deal.pipeline", pipeRaw).choice; if (ch !== "__default") pipelineId = ch; }
    let phaseTarget: Phase | null = null;
    if (phaseRaw) {
      const ch = choiceFor(ctx, state, "deal.phase", phaseRaw).choice;
      if (ch !== "__first") phaseTarget = phaseById.get(ch) ?? null;
    }
    // a dated phase names its pipeline too
    const firstHit = p.hits.map((h) => phaseById.get(h.phaseId)).find(Boolean);
    if (!pipelineId) pipelineId = phaseTarget?.pipeline_id ?? firstHit?.pipeline_id ?? (state.defaultPipeline || null);
    const ov = state.pipeOverride[idx];
    const pipeOverridden = !!ov && ov !== pipelineId && ctx.pipelines.some((x) => x.id === ov);
    if (pipeOverridden) pipelineId = ov;
    const ord = phasesOf(ctx, pipelineId);
    const pos = (ph: Phase | null | undefined) => (ph ? ord.findIndex((x) => x.id === ph.id) : -1);
    const inPipe = (ph: Phase) => (ph.pipeline_id === pipelineId ? ph : ord.find((x) => normHeader(x.name) === normHeader(ph.name)) ?? (ph.sales_outcome ? ord.find((x) => x.sales_outcome === ph.sales_outcome) : undefined) ?? null);
    const pipeLabel = ctx.pipelines.find((x) => x.id === pipelineId)?.name ?? "this pipeline";

    let phase: Phase | null = null;
    if (phaseTarget) {
      phase = inPipe(phaseTarget);
      if (!phase) issues.push(`Phase “${phaseRaw}” isn't in ${pipeLabel} — starts at the first phase`);
    }
    // the dated phases (reached on that day)
    const dated = new Map<string, string | null>();
    p.hits.forEach((h) => {
      const src = phaseById.get(h.phaseId)!;
      const ph = inPipe(src);
      if (!ph) { issues.push(`“${src.name}” isn't in ${pipeLabel} — its date is left out`); return; }
      if (!dated.has(ph.id) || (h.date && !dated.get(ph.id))) dated.set(ph.id, h.date);
    });
    const datedPhases = [...dated.keys()].map((id) => ord.find((x) => x.id === id)!).filter(Boolean);
    const furthest = datedPhases.filter((x) => !x.sales_outcome).sort((a, b) => pos(b) - pos(a))[0] ?? null;
    if (furthest && (!phase || (!phase.sales_outcome && pos(furthest) > pos(phase)))) phase = furthest;
    if (!phase) phase = firstPhase(pipelineId);

    let dealStatus = statusRaw ? choiceFor(ctx, state, "deal.status", statusRaw).choice : "active";
    if (datedPhases.some((x) => x.sales_outcome === "win")) dealStatus = "won";
    else if (datedPhases.some((x) => x.sales_outcome === "loss") && dealStatus !== "won") dealStatus = "lost";
    if (phase?.sales_outcome === "win") dealStatus = "won";
    if (phase?.sales_outcome === "loss") dealStatus = "lost";

    /* dates */
    const dateOf = (k: string, label: string) => {
      if (!p.get[k]) return null;
      const d = asDate(p.cells[k]) ?? parseDate(p.cells[k]);
      if (!d) issues.push(`${label} “${one(k)}” isn't a date`);
      return d;
    };
    const expectedClose = dateOf("deal.expected_close", "Expected close date");
    const closedOn = dateOf("deal.close_date", "Close date");
    const createdRaw = dateOf("deal.created", "Created");
    // a close date means it was won (unless the file says it was lost)
    if (closedOn && dealStatus !== "lost") dealStatus = "won";

    let reached: Phase | null = phase && !phase.sales_outcome ? phase : null;
    if (furthest && (!reached || pos(furthest) > pos(reached))) reached = furthest;
    if (dealStatus === "won" && phase?.sales_outcome !== "win") { const w = ord.find((x) => x.sales_outcome === "win"); if (w) phase = w; }
    if (dealStatus === "lost" && phase?.sales_outcome !== "loss") { const l = ord.find((x) => x.sales_outcome === "loss"); if (l) phase = l; }
    // a won deal went through every phase; a lost one stopped where the file says
    if (phase?.sales_outcome === "win") reached = [...ord].reverse().find((x) => !x.sales_outcome) ?? reached;
    if (!reached && phase?.sales_outcome === "loss") reached = firstPhase(pipelineId);

    /* the day each phase was entered */
    const datedDays = [...dated.values()].filter((x): x is string => !!x);
    const created = createdRaw ?? minDay(datedDays);
    const base = created ?? closedOn ?? today;
    const phaseDates: Record<string, string> = {};
    const rIdx = pos(reached);
    const stamped = new Set<string>();
    if (rIdx >= 0) ord.slice(state.markPassed ? 0 : rIdx, rIdx + 1).forEach((x) => { if (!x.sales_outcome) stamped.add(x.id); });
    datedPhases.forEach((x) => { if (!x.sales_outcome && (rIdx < 0 || pos(x) <= rIdx)) stamped.add(x.id); });
    const seq = ord.filter((x) => stamped.has(x.id));
    let prev: string | null = null;
    seq.forEach((x, k) => {
      const own = dated.get(x.id) ?? null;
      if (own) { phaseDates[x.id] = own; prev = own; return; }
      const next = seq.slice(k + 1).map((y) => dated.get(y.id)).find(Boolean) ?? null;
      let d = next && next < base ? next : base;
      if (prev && d < prev) d = prev;
      phaseDates[x.id] = d; prev = d;
    });
    if (phase?.sales_outcome) phaseDates[phase.id] = (phase.sales_outcome === "win" ? closedOn : null) ?? dated.get(phase.id) ?? closedOn ?? maxDay([base, ...Object.values(phaseDates)]) ?? base;
    else if (phase && !phaseDates[phase.id]) phaseDates[phase.id] = dated.get(phase.id) ?? base;

    /* value, product */
    let value: number | null = null;
    if (p.get["deal.value"]) { const n = parseNumber(p.cells["deal.value"]); if (n != null) value = Math.round(n * 100) / 100; else issues.push(`Value “${one("deal.value")}” isn't a number`); }
    let productId: string | null = null, productDefaulted = false;
    const prodRaw = one("deal.product");
    const ch = prodRaw ? choiceFor(ctx, state, "deal.product", prodRaw).choice : "__default";
    if (ch === "__default") { productId = state.defaultProduct || null; productDefaulted = !!productId; }
    else if (ch !== "__none") productId = ch;

    let probability: number | null = null;
    if (p.get["deal.probability"]) {
      let n = parseNumber(p.cells["deal.probability"]);
      if (n != null && n > 0 && n < 1 && !String(one("deal.probability")).includes("%")) n = n * 100;
      if (n != null && n >= 0 && n <= 100) probability = Math.round(n); else issues.push(`Probability “${one("deal.probability")}” isn't 0–100`);
    }
    let lossReason: string | null = null, lossDetails: string | null = null, newLossReason = false;
    if (one("deal.loss_reason")) {
      const raw = one("deal.loss_reason")!;
      const lc = choiceFor(ctx, state, "deal.loss_reason", raw).choice;
      if (lc === "__details") lossDetails = raw;
      else if (lc === "__new") { lossReason = raw; newLossReason = true; }
      else lossReason = lc;
    }

    /* people */
    const personFor = (rule: Rule) => {
      const raw = rule.col != null ? cellText(r[rule.col] ?? null).trim() : "";
      const k = normHeader(raw);
      const v = k ? (rule.map[k] ?? matchPerson(ctx.people, raw) ?? rule.fallback) : rule.fallback;
      return v && ctx.people.some((x) => x.id === v) ? v : null;
    };
    let owner: string | null = null;
    for (const rule of owners) { owner = personFor(rule); if (owner) break; }
    const team = Array.from(new Set([...(owner ? [owner] : []), ...teams.map(personFor).filter((x): x is string => !!x)]));
    const dealRoles: Record<string, string> = {};
    team.forEach((pid) => { const role = resolveDealRole(ctx.roles, pid, pipelineId, state.personRole[pid]); if (role) dealRoles[pid] = role.id; });

    /* status of the row */
    let status: PlanRow["status"] = "new"; let reason: string | undefined; let dupOf: string | null = null;
    if (!companyRef && !contactRef) { status = "error"; reason = companyKey || ctKey ? "Company and contact are both skipped" : "No company or contact"; }
    else if (!pipelineId || !ord.length) { status = "error"; reason = pipelineId ? "This pipeline has no phases" : "No pipeline"; }
    else {
      const title = titleKey(p.get["deal.title"]?.join(" · "));
      const fileKey = `${companyRef ? `co:${companyRef}` : `ct:${contactRef}`}|${pipelineId}|${title || `p:${productId ?? ""}`}`;
      if (seenInFile.has(fileKey)) {
        // the same deal twice in this file: only the first one counts
        status = "dup"; reason = "Same deal as an earlier row of the file";
      } else {
        seenInFile.set(fileKey, idx);
        const crmWho = companyRef?.startsWith("crm:") ? `co:${companyRef.slice(4)}` : !companyRef && contactRef?.startsWith("crm:") ? `ct:${contactRef.slice(4)}` : null;
        const theirs = crmWho ? dealsByKey.get(`${crmWho}|${pipelineId}`) ?? [] : [];
        if (theirs.length) {
          const same = title ? theirs.find((t) => titleKey(t.deal_name) === title) : undefined;
          // a title different from every (named) deal already there → another deal: an upsell, a renewal…
          const another = !!title && !same && theirs.every((t) => !!titleKey(t.deal_name));
          if (another) {
            issues.push(`${theirs.length === 1 ? "Another deal" : `${theirs.length} other deals`} of this ${companyRef ? "company" : "contact"} ${theirs.length === 1 ? "is" : "are"} already in this pipeline — imported as a different deal (its title is different)`);
          } else {
            dupOf = (same ?? theirs[0]).id;
            status = state.dupMode === "import" ? "new" : state.dupMode === "update" ? "update" : "dup";
            reason = same ? "Already in the CRM — same company, pipeline and title" : "Already has a deal in this pipeline";
          }
        }
      }
    }
    if (status === "new") {
      const missing = ctx.fields.filter((f) => f.required).filter((f) => { const v = p.custom[`custom:${f.id}`]; return v == null || v === "" || (f.type === "boolean" && v === false); });
      if (missing.length) { status = "error"; reason = `Required: ${missing.map((f) => f.label).join(", ")}`; }
    }
    const coIsClient = companyRef?.startsWith("crm:") ? clients.has(companyRef.slice(4)) : false;
    const becomesClient = status === "new" && state.makeClients && dealStatus === "won" && !!closedOn && !!companyRef && !coIsClient;
    if (dealStatus === "won" && closedOn && !companyRef) issues.push("Won with a close date, but without a company it can't become a client");
    return {
      idx, status, reason, dupOf, issues, companyRef, companyLabel, companyKey, contactRef, contactLabel, contactKey: ctKey,
      pipelineId, pipeOverridden, phaseId: phase?.id ?? null, reachedPhaseId: reached?.id ?? null, dealStatus, phaseDates,
      value, productId, productDefaulted, owner, team, dealRoles, expectedClose, closedOn, probability, created, becomesClient,
      title: p.get["deal.title"]?.join(" · ") ?? null, notes: p.get["deal.notes"] ?? [], lossReason, lossDetails, newLossReason, custom: p.custom,
    };
  });

  /* ---- 6) what the file would fill / change in the CRM records it links to ---- */
  const fieldLabel = (entity: "company" | "contact") => (k: string, isCustom: boolean) => {
    if (!isCustom) return BASE_TARGETS.find((b) => b.key === `${entity}.${k}`)?.label ?? k;
    if (k.startsWith("new:")) return state.newFields.find((n) => `new:${n.tmp}` === k)?.label ?? "New field";
    return ((entity === "company" ? ctx.companyFields : ctx.contactFields) ?? []).find((f) => f.id === k)?.label ?? k;
  };
  const planCustom = (c: Record<string, any>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k.startsWith("new:") ? k : k.slice(k.indexOf(":") + 1), v]));
  companies.forEach((e) => {
    const crm = e.ref?.startsWith("crm:") ? ctx.companies.find((c) => c.id === e.ref!.slice(4)) : null;
    if (!crm) { e.diff = null; return; }
    const { name: _n, ...file } = e.data; // eslint-disable-line @typescript-eslint/no-unused-vars
    e.diff = diffRecord(crm, file, planCustom(e.custom), fieldLabel("company"));
  });
  contacts.forEach((e) => {
    const crm = e.ref?.startsWith("crm:") ? ctx.contacts.find((c) => c.id === e.ref!.slice(4)) : null;
    if (!crm) { e.diff = null; return; }
    e.diff = diffRecord(crm, contactFile(e), planCustom(e.custom), fieldLabel("contact"));
  });

  const ok = planRows.filter((x) => x.status === "new");
  const usedCo = new Set(ok.map((x) => x.companyRef));
  const usedCt = new Set(ok.map((x) => x.contactRef));
  const companyList = [...companies.values()].sort((a, b) => (a.found ? 1 : 0) - (b.found ? 1 : 0) || (a.suggest ? 0 : 1) - (b.suggest ? 0 : 1) || b.count - a.count);
  const contactList = [...contacts.values()].sort((a, b) => (a.found ? 1 : 0) - (b.found ? 1 : 0) || b.count - a.count);
  const nc = contactList.filter((c) => c.ref === `new:${c.key}` && usedCt.has(c.ref));
  return {
    rows: planRows, companies: companyList, contacts: contactList, newContacts: nc,
    counts: {
      new: ok.length, update: planRows.filter((x) => x.status === "update").length, dup: planRows.filter((x) => x.status === "dup").length, error: planRows.filter((x) => x.status === "error").length,
      warn: ok.filter((x) => x.issues.length).length,
      coNew: [...usedCo].filter((x) => x?.startsWith("new:")).length,
      coFound: [...usedCo].filter((x) => x?.startsWith("crm:")).length,
      coSimilar: companyList.filter((c) => c.foundBy === "similar" && usedCo.has(c.ref)).length,
      ctNew: nc.length, ctFound: [...usedCt].filter((x) => x?.startsWith("crm:")).length,
      ctLink: contactList.filter((c) => c.link === "link" && c.ref && usedCt.has(c.ref) && (state.linkContacts || c.ref.startsWith("new:"))).length,
      noOwner: ok.filter((x) => !x.owner).length,
      clients: new Set(ok.filter((x) => x.becomesClient).map((x) => x.companyRef)).size,
      won: ok.filter((x) => x.dealStatus === "won").length,
      ...(() => {
        const co = companyList.filter((c) => c.diff && usedCo.has(c.ref)), ct = contactList.filter((c) => c.diff && usedCt.has(c.ref));
        const sum = (xs: { diff?: RecordDiff | null }[], k: "fill" | "change") => xs.reduce((n, x) => n + (x.diff?.[k].length ?? 0), 0);
        return { coExisting: co.length, coFill: sum(co, "fill"), coChange: sum(co, "change"), ctExisting: ct.length, ctFill: sum(ct, "fill"), ctChange: sum(ct, "change") };
      })(),
    },
  };
}

/** Name of what a column goes to. */
export function targetLabelOf(ctx: Ctx, state: ImportState, t: string): string {
  const b = BASE_TARGETS.find((x) => x.key === t);
  if (b) return b.label;
  if (isPhaseAt(t)) { const ph = Object.values(ctx.phaseByPipe).flat().find((p) => p.id === t.slice(PHASE_AT.length)); return `Reached “${ph?.name ?? "?"}”`; }
  return defOf(ctx, state, t)?.label ?? t;
}

/** Problems that stop the mapping step. */
export function mapProblem(ctx: Ctx, state: ImportState): string | null {
  state = withDefaults(state);
  const used = Object.values(state.mapping).filter(Boolean);
  if (!used.length) return "Map at least one column.";
  const hasWho = used.some((t) => ["company.name", "company.legal_name", "company.vat_number", "contact.full_name", "contact.first_name", "contact.email"].includes(t));
  if (!hasWho) return "Map the company name or a contact (name or email) — every deal needs one.";
  if (!used.includes("deal.pipeline") && !used.includes("deal.phase") && !used.some(isPhaseAt) && !state.defaultPipeline) return "Choose the pipeline the deals go into.";
  const dup = used.find((t, i) => used.indexOf(t) !== i && !MULTI_OK.has(t));
  if (dup) return `“${targetLabelOf(ctx, state, dup)}” is mapped from two columns.`;
  const listOf = (e: Entity) => (e === "deal" ? ctx.fields : e === "company" ? ctx.companyFields ?? [] : ctx.contactFields ?? []) as { label: string }[];
  const bad = state.newFields.find((n) => Object.values(state.mapping).includes(`new:${n.tmp}`)
    && (!n.label.trim() || listOf(n.entity).some((f) => normHeader(f.label) === normHeader(n.label)) || state.newFields.some((o) => o.tmp !== n.tmp && o.entity === n.entity && normHeader(o.label) === normHeader(n.label))));
  if (bad) return `New ${ENTITY_LABEL[bad.entity].toLowerCase()} field “${bad.label || "untitled"}” needs a unique name.`;
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

export interface RunResult {
  created: number; updated: number; failed: { row: number; reason: string }[];
  coCreated: number; ctCreated: number; coUpdated: number; ctUpdated: number; ctLinked: number;
  clientsCreated: number; newFields: number; batchId: string | null;
}
export const emptyResult = (): RunResult => ({ created: 0, updated: 0, failed: [], coCreated: 0, ctCreated: 0, coUpdated: 0, ctUpdated: 0, ctLinked: 0, clientsCreated: 0, newFields: 0, batchId: null });

async function startBatch(entity: "deal" | "company" | "contact", fileName: string): Promise<string | null> {
  const { data, error } = await supabase.from("import_batches").insert({ entity, file_name: fileName || null }).select("id").single();
  return error ? null : (data as any)?.id ?? null;
}
async function finishBatch(id: string | null, created: number, updated = 0) {
  if (id) await supabase.from("import_batches").update({ rows_created: created, rows_updated: updated }).eq("id", id);
}

/** Insert a deal; if an optional column isn't in the database yet, try again without it. */
async function insertDeal(row: Record<string, any>): Promise<{ id: string | null; error: string | null; dropped: string[] }> {
  const optional = ["import_batch_id", "deal_roles", "custom", "created_at", "close_date", "deal_name"];
  let r = { ...row };
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    const { data, error } = await supabase.from("trackings").insert(r).select("id").single();
    if (!error) return { id: (data as any)?.id ?? null, error: null, dropped };
    const col = optional.find((c) => c in r && error.message?.includes(c));
    if (!col) return { id: null, error: error.message, dropped };
    const { [col]: _drop, ...rest } = r; r = rest; dropped.push(col); // eslint-disable-line @typescript-eslint/no-unused-vars
  }
  return { id: null, error: "Couldn't create the deal", dropped };
}

/** A file contact's own fields, as the contacts table names them. */
const contactFile = (c: ContactName): Record<string, any> => ({ last_name: c.last_name, email: c.email, phone: c.phone, position: c.position, notes: c.notes, ...(c.is_billing ? { is_billing: true } : {}) });

export async function runImport(ctx: Ctx, state: ImportState, columns: Column[], plan: Plan, fileName: string, rowOffset: number,
  onProgress: (p: { done: number; total: number; phase: string }) => void): Promise<RunResult> {
  state = withDefaults(state);
  const res = emptyResult();
  const failed = res.failed;
  const todo = plan.rows.filter((r) => r.status === "new");

  /* 1) new fields (deal, company, contact), and new options on existing choice lists */
  const tmpIds = new Map<string, string>();
  const usedNew = state.newFields.filter((n) => Object.values(state.mapping).includes(`new:${n.tmp}`));
  // options a column adds ("+ add as a new option")
  const extraOptions = (t: string, base: string[]) => {
    const add: string[] = [];
    for (const [colS, tt] of Object.entries(state.mapping)) {
      if (tt !== t) continue;
      columns.find((c) => c.i === +colS)?.values.forEach((v) => {
        const txt = cellText(v).trim();
        if (txt && choiceFor(ctx, state, t, txt).choice === "__new" && ![...base, ...add].some((o) => normHeader(o) === normHeader(txt))) add.push(txt);
      });
    }
    return add;
  };
  if (usedNew.length) {
    onProgress({ done: 0, total: usedNew.length, phase: "Creating fields…" });
    const sortBase = { deal: ctx.fields.length, company: (ctx.companyFields ?? []).length, contact: (ctx.contactFields ?? []).length };
    for (const [k, n] of usedNew.entries()) {
      const options = n.type === "select" ? [...n.options, ...extraOptions(`new:${n.tmp}`, n.options)] : [];
      const input = { label: n.label.trim(), type: n.type, required: false, options, sort: sortBase[n.entity] + k };
      try {
        if (n.entity === "deal") { const { field } = await addTrackingField(input as any); if (field?.id) tmpIds.set(n.tmp, field.id); }
        else if (n.entity === "company") { const f = await addCompanyField(input as any); if (f?.id) tmpIds.set(n.tmp, f.id); }
        else { const f = await addContactField(input as any); if (f?.id) tmpIds.set(n.tmp, f.id); }
      } catch { /* looked up below */ }
      if (tmpIds.has(n.tmp)) res.newFields++;
      onProgress({ done: k + 1, total: usedNew.length, phase: "Creating fields…" });
    }
    const missing = usedNew.filter((n) => !tmpIds.has(n.tmp));
    if (missing.length) {
      const [fd, fc, ft] = await Promise.all([
        listTrackingFields().catch(() => [] as TrackingField[]), listCompanyFields().catch(() => [] as CompanyField[]), listContactFields().catch(() => [] as ContactField[]),
      ]);
      missing.forEach((n) => {
        const list = (n.entity === "deal" ? fd : n.entity === "company" ? fc : ft) as { id: string; label: string }[];
        const f = [...list].reverse().find((x) => normHeader(x.label) === normHeader(n.label));
        if (f) { tmpIds.set(n.tmp, f.id); res.newFields++; }
      });
    }
  }
  for (const t of new Set(Object.values(state.mapping))) {
    if (!/^(custom|cocustom|ctcustom):/.test(t)) continue;
    const def = defOf(ctx, state, t);
    if (!def || def.type !== "select") continue;
    const add = extraOptions(t, def.options);
    if (!add.length) continue;
    const id = t.slice(t.indexOf(":") + 1);
    if (def.entity === "deal") await updateTrackingField(id, { options: [...def.options, ...add] });
    else if (def.entity === "company") await updateCompanyField(id, { options: [...def.options, ...add] });
    else await updateContactField(id, { options: [...def.options, ...add] });
  }
  const resolveCustom = (custom: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(custom)) { const id = k.startsWith("new:") ? tmpIds.get(k.slice(4)) : k.slice(k.indexOf(":") + 1); if (id) out[id] = v; }
    return out;
  };
  /* new lost reasons */
  const newReasons = [...new Set(todo.filter((r) => r.newLossReason && r.lossReason).map((r) => r.lossReason!))];
  for (const [k, label] of newReasons.entries()) await addLossReason(label, ctx.lossReasons.length + k).catch(() => null);

  /* 2) companies: create the new ones, fill the empty fields of the found ones */
  const coIds = new Map<string, string>();
  const usedCoRefs = new Set(todo.map((r) => r.companyRef).filter(Boolean) as string[]);
  const coTodo = plan.companies.filter((c) => usedCoRefs.has(`new:${c.key}`));
  let coBatchP: Promise<string | null> | null = null;
  if (coTodo.length) {
    onProgress({ done: 0, total: coTodo.length, phase: "Creating companies…" });
    let k = 0;
    for (const c of coTodo) {
      const nm = splitCompanyNames(c.name, c.data.legal_name);
      const row: any = { ...c.data, name: nm.name, legal_name: nm.legal, custom: resolveCustom(c.custom), import_batch_id: await (coBatchP ??= startBatch("company", `${fileName} (deals import)`)) };
      const e = await saveCompany(row as Company).catch((x: any) => x?.message ?? "Failed");
      if (!e && row.id) { coIds.set(c.key, row.id); res.coCreated++; } else failed.push({ row: 0, reason: `Company “${c.name}”: ${e}` });
      onProgress({ done: ++k, total: coTodo.length, phase: "Creating companies…" });
    }
  }
  if (state.coExisting !== "keep") {
    const found = plan.companies.filter((c) => c.ref?.startsWith("crm:") && usedCoRefs.has(c.ref));
    for (const c of found) {
      const crm = ctx.companies.find((x) => x.id === c.ref!.slice(4));
      if (!crm) continue;
      const { name: _n, ...file } = c.data; // eslint-disable-line @typescript-eslint/no-unused-vars
      const cust = resolveCustom(c.custom);
      const patch = patchFor(state.coExisting, crm, diffRecord(crm, file, cust, (k) => k), file, cust);
      if (!patch) continue;
      const { error } = await supabase.from("companies").update(patch).eq("id", crm.id!);
      if (!error) res.coUpdated++;
    }
  }
  const coId = (ref: string | null) => (!ref ? null : ref.startsWith("crm:") ? ref.slice(4) : coIds.get(ref.slice(4)) ?? null);

  /* 3) contacts: create, fill, link to the deal's company */
  const ctIds = new Map<string, string>();
  let ctBatchP: Promise<string | null> | null = null;
  const usedCtRefs = new Set(todo.map((r) => r.contactRef).filter(Boolean) as string[]);
  if (plan.newContacts.length) {
    onProgress({ done: 0, total: plan.newContacts.length, phase: "Creating contacts…" });
    let k = 0;
    for (const c of plan.newContacts) {
      const cid = coId(c.companyRef);
      const row: any = {
        first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone, position: c.position, is_billing: !!c.is_billing, notes: c.notes,
        custom: resolveCustom(c.custom), companyIds: cid ? [cid] : [], import_batch_id: await (ctBatchP ??= startBatch("contact", `${fileName} (deals import)`)),
      };
      const e = await saveContact(row as Contact).catch((x: any) => x?.message ?? "Failed");
      if (!e && row.id) { ctIds.set(c.key, row.id); res.ctCreated++; } else failed.push({ row: 0, reason: `Contact “${c.first_name}”: ${e}` });
      onProgress({ done: ++k, total: plan.newContacts.length, phase: "Creating contacts…" });
    }
  }
  const foundCts = plan.contacts.filter((c) => c.ref?.startsWith("crm:") && usedCtRefs.has(c.ref));
  for (const c of foundCts) {
    const crm = ctx.contacts.find((x) => x.id === c.ref!.slice(4));
    if (!crm) continue;
    if (state.ctExisting !== "keep") {
      const file = contactFile(c);
      const cust = resolveCustom(c.custom);
      const patch = patchFor(state.ctExisting, crm, diffRecord(crm, file, cust, (k) => k), file, cust);
      if (patch) { const { error } = await supabase.from("contacts").update(patch).eq("id", crm.id!); if (!error) res.ctUpdated++; }
    }
    const cid = coId(c.companyRef);
    if (state.linkContacts && cid && !crm.companyIds.includes(cid)) {
      const { error } = await supabase.from("company_contacts").insert({ company_id: cid, contact_id: crm.id });
      if (!error) { res.ctLinked++; crm.companyIds = [...crm.companyIds, cid]; }
    }
  }
  const ctId = (ref: string | null) => (!ref ? null : ref.startsWith("crm:") ? ref.slice(4) : ctIds.get(ref.slice(4)) ?? null);

  /* 4) deals, 4 at a time */
  const batchId = todo.length ? await startBatch("deal", fileName) : null;
  res.batchId = batchId;
  onProgress({ done: 0, total: todo.length, phase: "Importing deals…" });
  const dealIdOf = new Map<number, string>();
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
          rep_close_prob: r.probability, rep_close_date: r.expectedClose,
          loss_reason: r.lossReason, loss_details: r.lossDetails,
          custom: resolveCustom(r.custom),
          ...(r.title ? { deal_name: r.title.replace(/\s+/g, " ").trim().slice(0, 200) } : {}),
          ...(r.closedOn ? { close_date: r.closedOn } : {}),
          ...(Object.keys(r.dealRoles).length ? { deal_roles: r.dealRoles } : {}),
          ...(r.created ? { created_at: `${r.created}T09:00:00Z` } : {}),
          ...(batchId ? { import_batch_id: batchId } : {}),
        };
        const { id, error, dropped } = await insertDeal(row);
        if (!id) { failed.push({ row: r.idx + rowOffset, reason: error ?? "Couldn't create the deal" }); continue; }
        dealIdOf.set(r.idx, id);
        const jobs: PromiseLike<any>[] = [];
        if (contact_id) jobs.push(supabase.from("tracking_contacts").insert({ tracking_id: id, contact_id }));
        if (r.productId) jobs.push(supabase.from("tracking_products").insert({ tracking_id: id, product_id: r.productId, price: price ?? 0 }));
        if (r.team.length) jobs.push(supabase.from("tracking_employees").insert(r.team.map((p) => ({ tracking_id: id, profile_id: p, is_owner: p === r.owner }))));
        const events = Object.entries(r.phaseDates).map(([phase_id, day]) => ({ tracking_id: id, phase_id, entered_at: `${day}T09:00:00Z` }));
        if (events.length) jobs.push(supabase.from("tracking_phase_events").insert(events));
        // the title lives on the deal; if the database has no deal_name yet, keep it as a note
        const body = [dropped.includes("deal_name") && r.title ? `Imported deal: ${r.title}` : null, ...r.notes].filter(Boolean).join("\n\n");
        if (body) jobs.push(supabase.from("tracking_notes").insert({ tracking_id: id, phase_id: r.phaseId, body }));
        await Promise.all(jobs);
        res.created++;
      } catch (e: any) {
        failed.push({ row: r.idx + rowOffset, reason: e?.message ?? "Failed" });
      } finally {
        done++; onProgress({ done, total: todo.length, phase: "Importing deals…" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length || 1) }, worker));

  /* 4b) deals already in the CRM, updated with the file's data (only what the file maps) */
  const upd = plan.rows.filter((r) => r.status === "update" && r.dupOf);
  if (upd.length) {
    const mapped = new Set(Object.values(state.mapping).filter(Boolean));
    const has = (t: string) => mapped.has(t);
    const phaseMapped = has("deal.phase") || has("deal.status") || [...mapped].some(isPhaseAt);
    const byId = new Map(ctx.trackings.map((t) => [t.id, t]));
    let k = 0;
    onProgress({ done: 0, total: upd.length, phase: "Updating deals already in the CRM…" });
    for (const r of upd) {
      const cur: any = byId.get(r.dupOf!) ?? {};
      const product = r.productId ? ctx.products.find((p) => p.id === r.productId) : null;
      const price = r.value ?? product?.tiers?.[0]?.price ?? null;
      const cust = resolveCustom(r.custom);
      const patch: Record<string, any> = {
        ...(phaseMapped && r.phaseId ? { current_phase_id: r.phaseId, status: r.dealStatus } : {}),
        ...(has("deal.product") && r.productId ? { product_id: r.productId } : {}),
        ...((has("deal.value") || has("deal.product")) && price != null ? { product_price: price } : {}),
        ...(has("deal.probability") && r.probability != null ? { rep_close_prob: r.probability } : {}),
        ...(has("deal.expected_close") && r.expectedClose ? { rep_close_date: r.expectedClose } : {}),
        ...(has("deal.loss_reason") && r.lossReason ? { loss_reason: r.lossReason } : {}),
        ...(has("deal.loss_reason") && r.lossDetails ? { loss_details: r.lossDetails } : {}),
        ...(r.closedOn ? { close_date: r.closedOn } : {}),
        ...(r.title ? { deal_name: r.title.replace(/\s+/g, " ").trim().slice(0, 200) } : {}),
        ...(Object.keys(cust).length ? { custom: { ...(cur.custom ?? {}), ...cust } } : {}),
      };
      if (Object.keys(patch).length) {
        const { error } = await supabase.from("trackings").update(patch).eq("id", r.dupOf!);
        if (error) failed.push({ row: r.idx + rowOffset, reason: `Deal not updated — ${error.message}` }); else res.updated++;
      }
      onProgress({ done: ++k, total: upd.length, phase: "Updating deals already in the CRM…" });
    }
  }

  /* 5) won with a close date → the company becomes a client */
  const clientRows = todo.filter((r) => r.becomesClient && dealIdOf.has(r.idx));
  const byCompany = new Map<string, PlanRow[]>();
  clientRows.forEach((r) => { const id = coId(r.companyRef); if (id) byCompany.set(id, [...(byCompany.get(id) ?? []), r]); });
  if (byCompany.size) {
    onProgress({ done: 0, total: byCompany.size, phase: "Creating clients…" });
    // Existing clients: same company, else same name (legal forms ignored) or same VAT — never a duplicate.
    const known = await loadClientIndex();
    let k = 0;
    for (const [companyId, dRows] of byCompany) {
      k++;
      const crm = ctx.companies.find((c) => c.id === companyId);
      const fileCo = plan.companies.find((c) => coId(c.ref) === companyId);
      const pick = (col: (typeof COMPANY_COLS)[number]) => ((crm as any)?.[col] || fileCo?.data[col] || "") as string;
      const same = matchClient(known, { companyId, name: crm?.name ?? fileCo?.name ?? null, vat: pick("vat_number") || null });
      if (same) {
        await adoptClient(same, { companyId, legal_name: pick("legal_name") || null, vat_number: pick("vat_number") || null }).catch(() => {});
        if (!same.company_id) same.company_id = companyId;
        onProgress({ done: k, total: byCompany.size, phase: "Creating clients…" }); continue;
      }
      const cts = [
        ...ctx.contacts.filter((c) => c.companyIds.includes(companyId)),
        ...plan.newContacts.filter((c) => coId(c.companyRef) === companyId && ctIds.has(c.key)).map((c) => ({ ...c, id: ctIds.get(c.key) })),
      ];
      const uid = () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
      const clientRow = {
        name: crm?.name ?? fileCo?.name ?? "Client", legal_name: pick("legal_name") || null, vat_number: pick("vat_number") || null,
        address: { street: pick("street"), number: pick("addr_number"), details: pick("addr_details"), postalCode: pick("postal_code"), city: pick("city"), country: pick("country") },
        contacts: cts.map((c: any) => ({ id: uid(), sourceId: c.id ?? null, name: [c.first_name, c.last_name].filter(Boolean).join(" "), position: c.position ?? "", email: c.email ?? "", phone: c.phone ?? "", billing: !!c.is_billing })),
        company_id: companyId,
      };
      const { data, error } = await supabase.from("clients").insert(clientRow).select("id").single();
      if (error || !(data as any)?.id) { failed.push({ row: 0, reason: `Client “${clientRow.name}”: ${error?.message ?? "couldn't be created"}` }); continue; }
      known.push({ id: (data as any).id, name: clientRow.name, company_id: companyId, vat_number: clientRow.vat_number });
      res.clientsCreated++;
      // the products of its won deals, signed on the close date
      for (const r of dRows) {
        const product = r.productId ? ctx.products.find((p) => p.id === r.productId) : null;
        if (!product) continue;
        await saveClientProducts((data as any).id, dealIdOf.get(r.idx)!, [{
          productId: product.id!, price: r.value ?? product.tiers?.[0]?.price ?? 0, quantity: 1,
          recurring: product.billing === "recurring", period: product.billing === "recurring" ? product.billing_period ?? "yearly" : null,
          termYears: null, discountMode: null, discountValue: null, signingDate: r.closedOn!,
        }]).catch(() => null);
      }
      onProgress({ done: k, total: byCompany.size, phase: "Creating clients…" });
    }
  }

  await finishBatch(batchId, res.created);
  if (coBatchP) await finishBatch(await coBatchP, res.coCreated, res.coUpdated);
  if (ctBatchP) await finishBatch(await ctBatchP, res.ctCreated, res.ctUpdated);
  plan.rows.filter((r) => r.status === "error").forEach((r) => failed.push({ row: r.idx + rowOffset, reason: r.reason ?? "Error" }));
  failed.sort((a, b) => a.row - b.row);
  return res;
}