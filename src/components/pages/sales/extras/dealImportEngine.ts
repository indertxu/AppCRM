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
  companyRow, contactRow, missingColumn, isPartner, isPartnerTag, listCrmOptions, addCrmOption, addCompanyField, addContactField, updateCompanyField, updateContactField, listCompanyFields, listContactFields,
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
  { key: "deal.partner", label: "Partner (company)", group: "Deal", hint: "The partner that brings the deal: found in your companies (or created as a partner) and set on the deal's product line" },
  { key: "deal.partner_cut", label: "Partner margin (% or amount)", group: "Deal", hint: "“30%” is a share of the line; a number over 100 is a fixed amount" },
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
  "contact.email": ["email", "e mail", "mail", "contact email", "correo", "correo electronico", "email contacto", "email address", "email de contacto", "correo de contacto", "e mail de contacto", "email del contacto", "contact e mail"],
  "contact.phone": ["phone", "telephone", "tel", "telefono", "mobile", "movil", "contact phone", "mobile phone", "telefono contacto", "telefono movil", "phone number"],
  "contact.position": ["position", "job title", "function", "cargo", "puesto", "functie", "title contact", "role"],
  "contact.is_billing": ["billing contact", "contacto facturacion", "contacto de facturacion", "is billing", "facturacion contacto", "invoice contact"],
  "contact.notes": ["contact notes", "notas contacto", "notas del contacto", "person notes"],
  "deal.title": ["title", "deal", "deal name", "deal title", "subject", "name", "titulo", "asunto", "oportunidad", "opportunity", "opportunity name", "onderwerp", "nombre del deal", "nombre de la oportunidad", "nombre oportunidad", "nombre del negocio", "negocio", "titulo del deal"],
  "deal.pipeline": ["pipeline", "pipeline name", "embudo", "funnel", "sales pipeline", "deal pipeline"],
  "deal.phase": ["phase", "stage", "deal phase", "deal stage", "fase", "etapa", "estado del deal", "fase actual", "current phase", "pipeline stage", "sales stage"],
  "deal.status": ["status", "estado", "state", "deal status", "result", "resultado", "outcome"],
  "deal.value": ["value", "amount", "deal value", "total", "importe", "valor", "precio", "price", "revenue", "estimated value", "waarde", "bedrag", "budget", "presupuesto", "cantidad", "cantidad iva excl", "cantidad sin iva", "importe sin iva", "importe iva excl", "base imponible", "amount excl vat", "amount excl tax", "net amount", "importe neto", "valor neto", "deal amount", "opportunity amount"],
  "deal.product": ["product", "producto", "products", "service", "servicio", "productos"],
  "deal.expected_close": ["close date", "expected close date", "estimated closing date", "expected closing date", "closing date", "fecha de cierre", "fecha cierre", "fecha prevista", "fecha de cierre prevista", "fecha prevista de cierre", "expected closing", "deadline", "estimated close date", "forecast close date"],
  "deal.close_date": ["closed date", "closed on", "close time", "won time", "won date", "won on", "date won", "actual close date", "fecha ganado", "fecha de ganado", "fecha de firma", "fecha firma", "signed date", "signed on", "signing date", "fecha de cierre real", "fecha cierre real", "closed at", "fecha cerrado", "fecha de cierre efectiva"],
  "deal.probability": ["probability", "probabilidad", "chance", "win probability", "kans", "close probability", "%"],
  "deal.created": ["created", "created at", "created on", "creation date", "date created", "fecha de creacion", "fecha creacion", "fecha alta", "fecha de alta", "alta", "aangemaakt", "start date", "add time", "deal created", "date added", "added", "added on", "fecha en la que se anadio", "fecha anadido", "fecha de entrada", "se anadio"],
  "deal.loss_reason": ["lost reason", "loss reason", "reason lost", "motivo de perdida", "motivo perdida", "razon de perdida", "lost reason description"],
  "deal.notes": ["notes", "note", "notas", "comments", "comentarios", "description", "descripcion", "observaciones", "summary"],
  "deal.partner": ["partner", "partner name", "nombre partner", "nombre del partner", "partner company", "socio", "distribuidor", "reseller", "canal", "channel partner"],
  "deal.partner_cut": ["partner margin", "margen partner", "margen del partner", "partner commission", "comision partner", "comision del partner", "partner cut", "partner share", "partner fee"],
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
/* The closest CRM name, fast with tens of thousands of companies.
   Only the names that can score ≥ 0.72 are looked at: a Dice score of 0.72 needs at least
   56% of the name's letter pairs in common, so a candidate always shares one of its rarest
   pairs ("prefix filter"); names one is a word-subset of the other come from a word index. */
interface FuzzItem { c: Company; toks: string[]; compact: string; nb: number; pairs: Set<string> }
interface FuzzIndex { items: FuzzItem[]; post: Map<string, number[]>; byTok: Map<string, number[]>; byRareTok: Map<string, number[]>; cache: Map<string, { c: Company; s: number } | null> }
const FUZZ_INDEX = new WeakMap<Company[], FuzzIndex>();
const pairsOf = (s: string) => { const out = new Set<string>(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out; };
const FUZZ_MIN = 0.72;
function fuzzIndex(companies: Company[]): FuzzIndex {
  const idx = FUZZ_INDEX.get(companies);
  if (idx) return idx;
  const ix = newFuzz();
  companies.forEach((c) => addFuzz(ix, c));
  return endFuzz(ix, companies);
}
/** The search index of a long company list made in slices (`pause` gives the page its turn), ready for closestCompany. */
export async function prepareCompanySearch(companies: Company[], pause: () => Promise<void>): Promise<void> {
  if (FUZZ_INDEX.has(companies)) return;
  const pending = FUZZ_BUILDING.get(companies);
  if (pending) return pending;
  const job = (async () => {
    const ix = newFuzz();
    let t = performance.now();
    const turn = async () => { if (performance.now() - t > 20) { await pause(); t = performance.now(); } };
    for (let i = 0; i < companies.length; i++) { addFuzz(ix, companies[i]); if (i % 200 === 199) await turn(); }
    let k = 0;
    for (const l of ix.post.values()) { if (l.length > 1) l.sort((a, b) => ix.items[a].nb - ix.items[b].nb); if (++k % 200 === 0) await turn(); }
    for (let i = 0; i < ix.items.length; i++) { fileRare(ix, i); if (i % 500 === 499) await turn(); }
    FUZZ_INDEX.set(companies, ix);
  })();
  FUZZ_BUILDING.set(companies, job);
  try { await job; } finally { FUZZ_BUILDING.delete(companies); }
}
const FUZZ_BUILDING = new WeakMap<Company[], Promise<void>>();
const newFuzz = (): FuzzIndex => ({ items: [], post: new Map(), byTok: new Map(), byRareTok: new Map(), cache: new Map() });
function addFuzz(ix: FuzzIndex, c: Company) {
  for (const n of [c.name, c.legal_name]) {
    if (!n) continue;
    const toks = fuzzTokens(n), compact = toks.join("");
    if (compact.length < 2) continue;
    const pairs = pairsOf(compact);
    const k = ix.items.push({ c, toks, compact, nb: pairs.size, pairs }) - 1;
    pairs.forEach((g) => { const l = ix.post.get(g); if (l) l.push(k); else ix.post.set(g, [k]); });
    new Set(toks).forEach((t) => { const l = ix.byTok.get(t); if (l) l.push(k); else ix.byTok.set(t, [k]); });
  }
}
function endFuzz(ix: FuzzIndex, companies: Company[]): FuzzIndex {
  // pair lists sorted by name size: a search only walks the sizes that can reach 0.72
  ix.post.forEach((l) => l.sort((a, b) => ix.items[a].nb - ix.items[b].nb));
  // each name filed once more under its rarest word (finds the names whose words are all in the query)
  ix.items.forEach((_, k) => fileRare(ix, k));
  FUZZ_INDEX.set(companies, ix);
  return ix;
}
function fileRare(ix: FuzzIndex, k: number) {
  const it = ix.items[k];
  const rare = it.toks.reduce((a, b) => ((ix.byTok.get(b)?.length ?? 0) < (ix.byTok.get(a)?.length ?? 0) ? b : a), it.toks[0]);
  if (!rare) return;
  const l = ix.byRareTok.get(rare); if (l) l.push(k); else ix.byRareTok.set(rare, [k]);
}
export function closestCompany(companies: Company[], name: string): { c: Company; s: number } | null {
  const idx = fuzzIndex(companies);
  if (idx.cache.has(name)) return idx.cache.get(name)!;
  const toks = fuzzTokens(name), compact = toks.join("");
  let best = null as { c: Company; s: number } | null;
  if (compact.length >= 2) {
    const pairs = [...pairsOf(compact)];
    const need = Math.max(1, Math.ceil((FUZZ_MIN / (2 - FUZZ_MIN)) * pairs.length));
    const ratio = FUZZ_MIN / (2 - FUZZ_MIN); // a Dice ≥ 0.72 needs sizes within this ratio of each other
    const consider = (it: FuzzItem, sc: number) => { if (sc > (best?.s ?? 0)) best = { c: it.c, s: sc }; };
    // 1) letter pairs: count the pairs shared with every name of a size that can reach 0.72 (lists are sorted by size)
    const lo = ratio * pairs.length, hi = pairs.length / ratio;
    const hits = new Map<number, number>();
    for (const g of pairs) {
      const l = idx.post.get(g);
      if (!l) continue;
      let a = 0, b = l.length;
      while (a < b) { const m = (a + b) >> 1; if (idx.items[l[m]].nb < lo) a = m + 1; else b = m; }
      for (let i = a; i < l.length; i++) {
        const k = l[i];
        if (idx.items[k].nb > hi) break;
        hits.set(k, (hits.get(k) ?? 0) + 1);
      }
    }
    hits.forEach((h, k) => {
      if (h < need) return;
      const it = idx.items[k];
      consider(it, it.compact === compact ? 0.97 : (2 * h) / (pairs.length + it.nb));
    });
    // 2) one name's words all in the other's ("Grupo Acme Iberia" ⊇ "Acme"): 0.84
    if (toks.length && (best?.s ?? 0) < 0.84) {
      const cand = new Set<number>();
      const rare = toks.reduce((a, b) => ((idx.byTok.get(b)?.length ?? 0) < (idx.byTok.get(a)?.length ?? 0) ? b : a), toks[0]);
      idx.byTok.get(rare)?.forEach((k) => cand.add(k));
      new Set(toks).forEach((t) => idx.byRareTok.get(t)?.forEach((k) => cand.add(k)));
      cand.forEach((k) => {
        const it = idx.items[k];
        const [sm, lg] = toks.length <= it.toks.length ? [toks, it.toks] : [it.toks, toks];
        if (sm.join("").length >= 4 && sm.every((w) => lg.includes(w))) consider(it, it.compact === compact ? 0.97 : 0.84);
      });
    }
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

/** Words before a colon that say whose field a column is ("Cliente: Ciudad", "Contacto: Móvil"). */
const COMPANY_PREFIX = new Set(["cliente", "client", "customer", "company", "empresa", "compania", "organizacion", "organization", "organisation", "account", "cuenta", "bedrijf", "firma", "unternehmen", "org"]);
const CONTACT_PREFIX = new Set(["contacto", "contact", "persona", "person", "contactpersoon", "ansprechpartner", "persona de contacto", "contact person"]);
/** More words a column can use once its prefix says it's about the company / the contact. */
const SCOPED_SYN: Record<string, string[]> = {
  "company.name": ["nombre", "name", "nombre comercial", "trade name"],
  "company.addr_number": ["numero", "number", "no", "num", "nr", "n"],
  "company.phone": ["telefono", "phone", "tel", "telephone", "telefono fijo", "landline", "centralita"],
  "company.email": ["email", "e mail", "mail", "correo", "correo electronico"],
  "company.website": ["web", "website", "url", "sitio web", "pagina web", "dominio", "domain"],
  "company.notes": ["notas", "notes", "descripcion", "description", "observaciones"],
  "contact.full_name": ["nombre", "name", "nombre completo", "full name"],
  "contact.phone": ["movil", "mobile", "telefono movil", "mobile phone", "cell"],
  "contact.notes": ["notas", "notes", "observaciones"],
};
const prefixOf = (header: string): { entity: Entity | null; rest: string } => {
  const m = header.match(/^\s*([^:]{2,30}):\s*(.+)$/);
  if (!m) return { entity: null, rest: header };
  const p = normHeader(m[1]);
  return { entity: COMPANY_PREFIX.has(p) ? "company" : CONTACT_PREFIX.has(p) ? "contact" : null, rest: m[2] };
};
/** Whose field a column most likely is, by its header ("Cliente: Móvil" → company). */
export const headerEntity = (header: string): Entity => prefixOf(header).entity ?? "deal";
/** "01. ¿Consolidan?", "4.- Arranque", "¿Tienen presupuesto?": a questionnaire column — matched only by its exact words. */
const isQuestion = (header: string) => /[?¿]/.test(header) || /^\s*\d{1,3}\s*[.)\-]/.test(header);
/** A header without its leading numbering ("01 consolidan" → "consolidan"). */
export const headerCore = (header: string) => normHeader(header).replace(/^(\d+\s+)+/, "").trim();

export function guessTarget(header: string, samples: SheetCell[]): string | null {
  const h = normHeader(header);
  if (!h) return null;
  // the old CRM's own record id ("ID Oportunidad", "Deal ID") isn't anything here
  if (/^(id|n|no|num|numero|ref)( |$)|( |^)id$/.test(h)) return null;
  const keys = Object.keys(SYN).filter((k) => !k.startsWith("__"));
  // "Cliente: Email", "Cliente: Teléfono": a field of the company (never the contact's), and the reverse
  const pre = prefixOf(header);
  if (pre.entity) {
    const r = normHeader(pre.rest);
    const mine = keys.filter((k) => k.startsWith(`${pre.entity}.`));
    for (const k of mine) if (SYN[k].includes(r) || SCOPED_SYN[k]?.includes(r)) return k;
    let best: { k: string; len: number } | null = null;
    for (const k of mine) for (const syn of [...SYN[k], ...(SCOPED_SYN[k] ?? [])]) if (syn.length > 4 && r.includes(syn) && (!best || syn.length > best.len)) best = { k, len: syn.length };
    return best?.k ?? null;
  }
  for (const k of keys) if (SYN[k].includes(h)) return k;
  // a questionnaire column ("01. ¿Tienen presupuesto?") is only what its exact words say — never "budget" because it mentions it
  if (isQuestion(header)) { const core = headerCore(header); return keys.find((k) => SYN[k].includes(core)) ?? null; }
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

/** Pure answers about one column's values, kept while the column is the same (screens ask again on every draw). */
const CANON = new WeakMap<SheetCell[], string[]>();
const DISTINCT = new WeakMap<SheetCell[], { key: string; text: string; count: number }[]>();
/** One option per value ignoring case/accents, written the nicest way seen. */
export function canonicalOptions(values: SheetCell[]): string[] {
  let out = CANON.get(values);
  if (!out) { out = canonicalOptionsOf(values); CANON.set(values, out); }
  return [...out];
}
function canonicalOptionsOf(values: SheetCell[]): string[] {
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
  // phone numbers ("+34 917 37 90 97", "0034…", "600 123 456") read as numbers but aren't amounts
  const phoneLike = (v: SheetCell) => typeof v === "string" && (/^\s*(\+|00\d)/.test(v) || /\d+[\s-]\d+[\s-]\d+/.test(v.trim()));
  if (vals.every((v) => parseNumber(v) != null) && !vals.some(phoneLike)) return { type: "number", options: [] };
  const opts = canonicalOptions(values);
  // a few values, or a longer list that repeats a lot (49 sources over 7,000 rows) → a choice list
  if (opts.every((d) => d.length <= 60) && ((opts.length <= 15 && (opts.length <= 6 || opts.length < vals.length * 0.75)) || (opts.length <= 60 && opts.length * 10 <= vals.length))) return { type: "select", options: opts };
  return { type: "text", options: [] };
}

/** Distinct values of a column (first spelling seen), with how often each appears. */
export function distinctValues(values: SheetCell[]): { key: string; text: string; count: number }[] {
  let out = DISTINCT.get(values);
  if (!out) { out = distinctValuesOf(values); DISTINCT.set(values, out); }
  return out.map((d) => ({ ...d }));
}
function distinctValuesOf(values: SheetCell[]): { key: string; text: string; count: number }[] {
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
  /**
   * Phase for deals whose phase value was sent to a status (On hold…): "" = the
   * furthest phase the file says they reached, else the pipeline's first phase;
   * or a phase id (matched by name in other pipelines).
   */
  heldPhase: string;
}

export const emptyState = (): ImportState => ({
  mapping: {}, newFields: [], valueMaps: {}, defaultPipeline: "", defaultProduct: "", rules: [], personRole: {},
  companyChoice: {}, contactChoice: {}, pipeOverride: {}, createContacts: true, dupMode: "skip", markPassed: true,
  coExisting: "fill", ctExisting: "fill", linkContacts: true, makeClients: true, heldPhase: "",
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
/** A phase value sent to a deal status instead of a phase: "__status:paused" | "__status:lost" | "__status:won". */
export const PHASE_STATUS = "__status:";
export const isPhaseStatus = (c: string | null | undefined) => !!c && c.startsWith(PHASE_STATUS);
const statusSynOf = (n: string) => Object.entries(STATUS_SYN).find(([, syn]) => syn.includes(n))?.[0] ?? null;

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
  if (target === "deal.phase") {
    const ph = matchPhase(ctx, raw, state.defaultPipeline || null);
    if (ph) return ph;
    // "On hold" / "Paused" aren't phases: they're a status of the deal
    const st = statusSynOf(n);
    if (st === "paused" || st === "won" || st === "lost") return `${PHASE_STATUS}${st}`;
    return null;
  }
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
  for (const c of columns) { const h = normHeader(c.header); if (!isQuestion(c.header) && SYN.__owner.some((s) => s.length > 4 && h.includes(s))) return c.i; }
  return null;
}
/** Columns naming more people on the deal (SDR, team…): each becomes a "team member" rule. */
const TEAM_RE = /^(sdrs?|bdrs?|sdr bdr|pre ?sales|preventa|team|equipo|team members?|miembros( del equipo)?|colaboradore?s?|collaborators?|co ?owners?|participantes|participants|sales assistant|asistente comercial|account executive|ae|setter|closer|teleoperador|telemarketing)$/;
export function guessTeamColumns(columns: Column[], people: Person[], exclude: (number | null)[] = []): number[] {
  return columns.filter((c) => !exclude.includes(c.i) && TEAM_RE.test(headerCore(c.header)) && (!people.length
    // its values are your people (at least one of them, and most of the rows)
    || (() => {
      const vals = distinctValues(c.values);
      const hit = vals.filter((v) => matchPerson(people, v.text));
      return hit.length > 0 && hit.reduce((n, v) => n + v.count, 0) >= vals.reduce((n, v) => n + v.count, 0) * 0.5;
    })())).map((c) => c.i);
}

/**
 * The automatic mapping of a file: every column to a field of ours, to "reached phase X",
 * to a new custom field (on the deal, or on the company / contact when its header says so:
 * "Cliente: Móvil"), or to nothing; plus who owns the deals and who's on them.
 */
export async function autoMap(ctx: Pick<Ctx, "fields" | "companyFields" | "contactFields" | "pipelines" | "phaseByPipe" | "people">, columns: Column[], opt: {
  defaultPipeline?: string; createFields: boolean; makeId: () => string; fallbackOwner?: string;
  /** Gives the page its turn now and then (a wide file is looked at column by column). */
  pause?: () => Promise<void>;
}): Promise<{ mapping: Record<number, string>; newFields: NewField[]; rules: Rule[] }> {
  let t0 = performance.now();
  const turn = async () => { if (opt.pause && performance.now() - t0 > 20) { await opt.pause(); t0 = performance.now(); } };
  const mapping: Record<number, string> = {};
  const newFields: NewField[] = [];
  const used = new Set<string>();
  const free = (t: string) => !used.has(t) || (MULTI_OK.has(t) && t !== "deal.title");
  const owner = guessOwnerColumn(columns);
  const team = guessTeamColumns(columns, ctx.people ?? [], [owner]);
  const own = [
    ...ctx.fields.map((f) => ({ f, t: `custom:${f.id}` })), ...(ctx.companyFields ?? []).map((f) => ({ f, t: `cocustom:${f.id}` })), ...(ctx.contactFields ?? []).map((f) => ({ f, t: `ctcustom:${f.id}` })),
  ];
  const later: Column[] = [];
  for (const c of columns) {
    await turn();
    mapping[c.i] = "";
    if (c.i === owner || team.includes(c.i)) continue;
    const h = normHeader(c.header), core = headerCore(c.header);
    // one of your own fields, by its name ("01. ¿Consolidan?" = "¿Consolidan?")
    const mine = own.find((x) => !used.has(x.t) && (normHeader(x.f.label) === h || (!!core && headerCore(x.f.label) === core)));
    const g = mine?.t ?? guessTarget(c.header, c.samples) ?? guessPhaseAt(ctx, c.header, c.samples, opt.defaultPipeline || ctx.pipelines[0]?.id);
    if (g && free(g)) { mapping[c.i] = g; used.add(g); continue; }
    later.push(c);
  }
  // a full name and a first name: the first name (with the last name) is the better one
  if (Object.values(mapping).includes("contact.first_name")) for (const k of Object.keys(mapping)) if (mapping[+k] === "contact.full_name") mapping[+k] = "";
  // everything else with data → a new field of the right type
  if (opt.createFields) for (const c of later) {
    if (!c.filled) continue;
    await turn();
    const entity = headerEntity(c.header);
    const list = (entity === "deal" ? ctx.fields : entity === "company" ? ctx.companyFields ?? [] : ctx.contactFields ?? []) as { label: string }[];
    let label = c.header.trim() || `Field ${c.letter}`;
    const taken = (l: string) => list.some((f) => normHeader(f.label) === normHeader(l)) || newFields.some((n) => n.entity === entity && normHeader(n.label) === normHeader(l));
    if (taken(label)) label = `${label} (imported)`;
    for (let k = 2; taken(label); k++) label = `${c.header.trim()} (${k})`;
    const g = guessType(c.values);
    // a phone-like column is text even with few values
    const type = /tel|phone|movil|mobile|fax/.test(normHeader(c.header)) ? "text" : g.type;
    const nf: NewField = { tmp: opt.makeId(), entity, label, type, options: type === "select" ? g.options : [] };
    newFields.push(nf); mapping[c.i] = `new:${nf.tmp}`;
  }
  const rules: Rule[] = [
    ...(owner != null ? [{ id: opt.makeId(), col: owner, as: "owner" as const, map: {}, fallback: opt.fallbackOwner ?? "" }] : []),
    ...team.map((col) => ({ id: opt.makeId(), col, as: "team" as const, map: {}, fallback: "" })),
  ];
  return { mapping, newFields, rules };
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
  /** The first row of the file that names it (for the error report). */
  firstRow: number;
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
  firstRow: number;
}
/** A partner the file names: a company of the CRM, one of the file's companies, or a new partner company. */
export interface PartnerName {
  key: string; name: string; count: number;
  /** "crm:<id>" | "new:<file company key>" | "pnew:<key>" */
  ref: string;
  /** Already marked as a partner in the CRM. */
  tagged: boolean;
  foundBy?: CompanyFoundBy;
  firstRow: number;
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
  /** The partner of the deal (set on its product line) and its cut. */
  partnerRef: string | null; partnerLabel: string | null; partnerMode: "percent" | "amount" | null; partnerValue: number | null;
}
export interface Plan {
  rows: PlanRow[];
  companies: CompanyName[];
  contacts: ContactName[];
  /** The contacts that will be created. */
  newContacts: ContactName[];
  partners: PartnerName[];
  counts: {
    new: number; update: number; dup: number; error: number; warn: number; coNew: number; coFound: number; coSimilar: number; ctNew: number; ctFound: number; ctLink: number;
    noOwner: number; clients: number; won: number; lost: number; held: number;
    /** Companies / contacts in the CRM the import touches, and how many of their fields it would fill or change. */
    coExisting: number; coFill: number; coChange: number; ctExisting: number; ctFill: number; ctChange: number;
    /** Deals with a partner; new partner companies; partners that can't be set (the deal has no product line). */
    partner: number; partnerNew: number; partnerNoProduct: number;
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

/** Stopped by the person — what was saved stays. */
export class Cancelled extends Error { constructor() { super("Import stopped"); } }
/** Gives the page its turn (not throttled in a background tab, unlike setTimeout). */
export const breathe = () => new Promise<void>((r) => {
  if (typeof MessageChannel === "undefined") { setTimeout(r, 0); return; }
  const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0);
});
export type PlanStep = (done: number, total: number, label: string) => void;
/** Counts a long loop and hands the page back every ~25 ms, so nothing ever freezes. */
export function pacer(onStep?: PlanStep, stop?: () => boolean) {
  let t = performance.now();
  return (label: string, total: number) => {
    let done = 0;
    onStep?.(0, total, label);
    return async () => {
      done++;
      if (performance.now() - t < 25) return;
      onStep?.(done, total, label);
      await breathe();
      if (stop?.()) throw new Cancelled();
      t = performance.now();
    };
  };
}

/** What a phase list of one pipeline answers, worked out once per plan. */
interface PipeInfo { ord: Phase[]; pos: Map<string, number>; byName: Map<string, Phase>; win: Phase | null; loss: Phase | null; first: Phase | null; lastOpen: Phase | null }

/**
 * Everything the import will do, worked out ahead (nothing is written). A big file is
 * read in small slices (`onStep` tells how far it got; `stop` ends it early), so the page
 * never freezes.
 */
export async function buildPlan(ctx: Ctx, columns: Column[], rows: SheetCell[][], state: ImportState, onStep?: PlanStep, stop?: () => boolean): Promise<Plan> {
  state = withDefaults(state);
  void columns;
  const pace = pacer(onStep, stop);
  const today = new Date().toISOString().slice(0, 10);
  const phaseById = new Map(Object.values(ctx.phaseByPipe).flat().map((p) => [p.id, p]));
  // the "spelled differently" search over every CRM company, made in slices
  await prepareCompanySearch(ctx.companies, async () => { onStep?.(0, 0, "Reading your companies"); await breathe(); if (stop?.()) throw new Cancelled(); });

  /* ---- indexes of what's in the CRM ---- */
  const coById = new Map<string, Company>(), coByVat = new Map<string, Company>(), coByName = new Map<string, Company>(), coByDomain = new Map<string, Company>();
  let tick = pace("Reading your companies", ctx.companies.length);
  for (const c of ctx.companies) {
    coById.set(c.id as string, c);
    const v = vatKey(c.vat_number); if (v && !coByVat.has(v)) coByVat.set(v, c);
    [c.name, c.legal_name].forEach((n) => { const k = nameKey(n); if (k && !coByName.has(k)) coByName.set(k, c); });
    [c.website, c.email].forEach((x) => { const d = domainKey(x); if (d && !coByDomain.has(d)) coByDomain.set(d, c); });
    await tick();
  }
  const ctById = new Map<string, Contact>(), ctByEmail = new Map<string, Contact>(), ctByName = new Map<string, Contact[]>(), ctByPhone = new Map<string, Contact[]>();
  const ctNameKey = (c: Contact) => personKey([c.first_name, c.last_name].filter(Boolean).join(" "));
  tick = pace("Reading your contacts", ctx.contacts.length);
  for (const c of ctx.contacts) {
    ctById.set(c.id as string, c);
    if (c.email) ctByEmail.set(c.email.trim().toLowerCase(), c);
    const k = ctNameKey(c);
    if (k) { const l = ctByName.get(k); if (l) l.push(c); else ctByName.set(k, [c]); }
    const p = phoneKey(c.phone); if (p) { const l = ctByPhone.get(p); if (l) l.push(c); else ctByPhone.set(p, [c]); }
    await tick();
  }
  const clients = new Set(ctx.clientCompanies ?? []);
  // deals already in the CRM, by who they're for and their pipeline (newest first)
  const dealsByKey = new Map<string, Tracking[]>();
  const addDeal = (k: string, t: Tracking) => { const l = dealsByKey.get(k); if (l) l.push(t); else dealsByKey.set(k, [t]); };
  ctx.trackings.forEach((t) => {
    if (t.company_id) addDeal(`co:${t.company_id}|${t.pipeline_id ?? ""}`, t);
    else (t.contactIds ?? []).forEach((c) => addDeal(`ct:${c}|${t.pipeline_id ?? ""}`, t));
  });
  /** The same deal twice in the file: who + pipeline + title (or product) + the day it was created → first row. */
  const seenInFile = new Map<string, number>();
  /** CRM deals already paired with a row of the file (each one is the match of one row at most). */
  const takenCrm = new Set<string>();
  const dayOf = (t: Tracking) => String((t as any).created_at ?? "").slice(0, 10);

  /* ---- what's worked out once and asked for row after row ---- */
  const choiceCache = new Map<string, string>();
  const choice = (t: string, raw: string) => {
    const k = `${t}\u0001${normHeader(raw)}`;
    let v = choiceCache.get(k);
    if (v === undefined) { v = choiceFor(ctx, state, t, raw).choice; choiceCache.set(k, v); }
    return v;
  };
  const pipeCache = new Map<string, PipeInfo>();
  const pipeInfo = (pid: string | null): PipeInfo => {
    const k = pid ?? "";
    let info = pipeCache.get(k);
    if (!info) {
      const ord = phasesOf(ctx, pid);
      const byName = new Map<string, Phase>();
      ord.forEach((x) => { const n = normHeader(x.name); if (!byName.has(n)) byName.set(n, x); });
      info = {
        ord, pos: new Map(ord.map((x, i) => [x.id, i])), byName,
        win: ord.find((x) => x.sales_outcome === "win") ?? null, loss: ord.find((x) => x.sales_outcome === "loss") ?? null,
        first: ord.find((p) => !p.sales_outcome) ?? ord[0] ?? null, lastOpen: [...ord].reverse().find((x) => !x.sales_outcome) ?? null,
      };
      pipeCache.set(k, info);
    }
    return info;
  };
  const colDefs = Object.entries(state.mapping).filter(([, t]) => !!t).map(([c, t]) => ({
    col: +c, t, ph: isPhaseAt(t) ? phaseById.get(t.slice(PHASE_AT.length)) ?? null : null, def: isPhaseAt(t) ? null : defOf(ctx, state, t),
  }));
  const required = ctx.fields.filter((f) => f.required);

  /* ---- 1) read every row ---- */
  const parsed: Parsed[] = [];
  tick = pace("Reading the rows", rows.length);
  for (const r of rows) {
    const p: Parsed = { get: {}, cells: {}, custom: {}, coCustom: {}, ctCustom: {}, hits: [], issues: [] };
    for (const { col, t, ph, def } of colDefs) {
      const cell = r[col] ?? null;
      if (cell == null || cell === "") continue;
      const txt = cellText(cell).trim();
      if (!txt) continue;
      if (isPhaseAt(t)) {
        if (!ph) continue;
        const d = asDate(cell);
        if (!d && parseBool(cell) === false) continue; // "No" / "0" → didn't reach it
        if (!d) p.issues.push(`${ph.name}: “${txt}” isn't a date — counted as reached, without its date`);
        p.hits.push({ phaseId: ph.id, date: d, raw: txt });
        continue;
      }
      if (def) {
        const bucket = def.entity === "company" ? p.coCustom : def.entity === "contact" ? p.ctCustom : p.custom;
        if (def.type === "number") { const n = parseNumber(cell); if (n != null) bucket[t] = n; else p.issues.push(`${def.label}: “${txt}” isn't a number`); }
        else if (def.type === "date") { const d = asDate(cell) ?? parseDate(cell); if (d) bucket[t] = d; else p.issues.push(`${def.label}: “${txt}” isn't a date`); }
        else if (def.type === "boolean") { const b = parseBool(cell); if (b != null) bucket[t] = b; else p.issues.push(`${def.label}: “${txt}” isn't yes/no`); }
        else if (def.type === "select") { const ch = choice(t, txt); if (ch === "__new") bucket[t] = txt; else if (ch !== "__empty") bucket[t] = ch; }
        else bucket[t] = txt;
        continue;
      }
      (p.get[t] ??= []).push(txt);
      if (!(t in p.cells)) p.cells[t] = cell;
    }
    parsed.push(p);
    await tick();
  }
  const oneOf = (p: Parsed, k: string) => p.get[k]?.[0] ?? null;

  /* ---- 2) the companies in the file ---- */
  const companies = new Map<string, CompanyName>();
  const keyByVat = new Map<string, string>(), keyByName = new Map<string, string>();
  const rowCoKey: (string | null)[] = [];
  tick = pace("Finding the companies", parsed.length);
  for (const [i, p] of parsed.entries()) {
    await tick();
    const name = oneOf(p, "company.name"), legal = oneOf(p, "company.legal_name"), vat = oneOf(p, "company.vat_number");
    if (!name && !legal && !vat) { rowCoKey.push(null); continue; }
    const vk = vatKey(vat), nk = nameKey(name ?? legal), lk = nameKey(legal);
    // the same company written two ways in the file (one row with the VAT, one without) is one company
    const key = (vk && keyByVat.get(vk)) || (nk && keyByName.get(nk)) || (lk && keyByName.get(lk)) || nk || lk || `vat:${vk}`;
    if (vk && !keyByVat.has(vk)) keyByVat.set(vk, key);
    if (nk && !keyByName.has(nk)) keyByName.set(nk, key);
    if (lk && !keyByName.has(lk)) keyByName.set(lk, key);
    const e = companies.get(key) ?? { key, name: name || legal || vat || "", data: {}, custom: {}, count: 0, found: null, ref: null, isClient: false, firstRow: i };
    e.count++;
    if (!e.name || (e.name === vat && (name || legal))) e.name = name || legal || e.name;
    for (const col of COMPANY_COLS) { const v = oneOf(p, `company.${col}`); if (v && !e.data[col]) e.data[col] = col === "vat_number" ? v.toUpperCase().replace(/[\s.\-/]/g, "") : v; }
    if (e.data.street && !e.data.addr_number) {
      const sp = splitStreetNumber(e.data.street);
      if (sp) { e.data.street = sp.street; e.data.addr_number = sp.number; if (sp.details && !e.data.addr_details) e.data.addr_details = sp.details; }
    }
    // a Spanish postal code read as a number lost its leading zero (08001 → 8001)
    if (e.data.postal_code && /^\d{4}$/.test(e.data.postal_code) && /^(es|esp|espana|spain)$/.test(normHeader(e.data.country ?? "es"))) e.data.postal_code = `0${e.data.postal_code}`;
    if (!e.data.name) e.data.name = e.name;
    for (const [k, v] of Object.entries(p.coCustom)) if (!(k in e.custom)) e.custom[k] = v;
    companies.set(key, e);
    rowCoKey.push(key);
  }
  // contact email domains of each company's rows: a last hint
  const mailDomains = new Map<string, Set<string>>();
  parsed.forEach((p, i) => { const k = rowCoKey[i]; const d = domainKey(oneOf(p, "contact.email")); if (k && d) { const s = mailDomains.get(k) ?? new Set<string>(); s.add(d); mailDomains.set(k, s); } });
  tick = pace("Matching the companies to your CRM", companies.size);
  for (const e of companies.values()) {
    await tick();
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
  }
  const coLabel = (ref: string | null, fallback: string) => (!ref ? null : ref.startsWith("crm:") ? coById.get(ref.slice(4))?.name ?? fallback : fallback);

  /* ---- 2b) partners: a CRM company (by VAT or name, even spelled a bit differently), a company of this file, or a new partner ---- */
  const partners = new Map<string, PartnerName>();
  const rowPartner: (string | null)[] = parsed.map((p, i) => {
    const raw = oneOf(p, "deal.partner");
    const nk = raw ? nameKey(raw) || normHeader(raw) : "";
    if (!raw || !nk) return null;
    let e = partners.get(nk);
    if (!e) {
      let hit: Company | undefined, by: CompanyFoundBy | undefined;
      const vk = vatKey(raw);
      if (vk && /\d{6,}/.test(vk) && coByVat.get(vk)) { hit = coByVat.get(vk); by = "vat"; }
      else if (coByName.get(nk)) { hit = coByName.get(nk); by = "name"; }
      else { const b = closestCompany(ctx.companies, raw); if (b && b.s >= 0.9) { hit = b.c; by = "similar"; } }
      const fileCo = hit ? undefined : companies.get(keyByName.get(nk) ?? nk);
      const ref = hit ? `crm:${hit.id}` : fileCo?.ref ?? `pnew:${nk}`;
      const crm = ref.startsWith("crm:") ? coById.get(ref.slice(4)) : undefined;
      e = { key: nk, name: crm?.name ?? fileCo?.name ?? raw.trim(), count: 0, ref, tagged: crm ? isPartner(crm) : false, foundBy: by, firstRow: i };
      partners.set(nk, e);
    }
    e.count++;
    return nk;
  });

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
  const rowCtKey: (string | null)[] = [];
  tick = pace("Finding the contacts", parsed.length);
  for (const [i, p] of parsed.entries()) {
    await tick();
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
    if (!first && !email) { rowCtKey.push(null); continue; }
    const nameK = personKey([first, last].filter(Boolean).join(" "));
    const coRef = rowCo[i].ref;
    const key = email ? `e:${email}` : `n:${nameK}|${coRef ?? ""}`;
    const e = contacts.get(key) ?? {
      key, first_name: first || email!.split("@")[0], last_name: last, email, phone, position: oneOf(p, "contact.position"),
      notes: p.get["contact.notes"]?.join("\n\n") ?? null, is_billing: oneOf(p, "contact.is_billing") != null ? parseBool(oneOf(p, "contact.is_billing")) : null,
      custom: {}, count: 0, found: null, companyRef: coRef, companyLabel: rowCo[i].label, link: "none" as const, ref: null, firstRow: i,
    };
    e.count++;
    if (!e.phone && phone) e.phone = phone;
    if (!e.position) e.position = oneOf(p, "contact.position");
    if (!e.last_name && last) e.last_name = last;
    if (!e.companyRef && coRef) { e.companyRef = coRef; e.companyLabel = rowCo[i].label; }
    for (const [k, v] of Object.entries(p.ctCustom)) if (!(k in e.custom)) e.custom[k] = v;
    contacts.set(key, e);
    rowCtKey.push(key);
  }
  tick = pace("Matching the contacts to your CRM", contacts.size);
  for (const e of contacts.values()) {
    await tick();
    const coId = e.companyRef?.startsWith("crm:") ? e.companyRef.slice(4) : null;
    const nameK = personKey([e.first_name, e.last_name].filter(Boolean).join(" "));
    let hit: Contact | undefined, by: ContactFoundBy | undefined;
    if (e.email && ctByEmail.get(e.email)) { hit = ctByEmail.get(e.email); by = "email"; }
    if (!hit && phoneKey(e.phone)) {
      const same = (ctByPhone.get(phoneKey(e.phone)) ?? []).filter((c) => !nameK || ctNameKey(c).split(" ")[0] === nameK.split(" ")[0]);
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
    const crm = e.ref?.startsWith("crm:") ? ctById.get(e.ref.slice(4)) : null;
    e.link = !e.companyRef ? "none" : crm && coId && crm.companyIds.includes(coId) ? "linked" : "link";
  }
  const ctLabel = (e: ContactName) => {
    if (e.ref?.startsWith("crm:")) { const c = ctById.get(e.ref.slice(4)); if (c) return [c.first_name, c.last_name].filter(Boolean).join(" "); }
    return [e.first_name, e.last_name].filter(Boolean).join(" ");
  };

  /* ---- 5) the deals ---- */
  const owners = state.rules.filter((r) => r.as === "owner");
  const teams = state.rules.filter((r) => r.as === "team");
  const peopleIds = new Set(ctx.people.map((x) => x.id));
  const personCache = new Map<string, string | null>();
  const personFor = (rule: Rule, r: SheetCell[]) => {
    const raw = rule.col != null ? cellText(r[rule.col] ?? null).trim() : "";
    const k = normHeader(raw);
    const ck = `${rule.id}\u0001${k}`;
    if (personCache.has(ck)) return personCache.get(ck)!;
    const v = k ? (rule.map[k] ?? matchPerson(ctx.people, raw) ?? rule.fallback) : rule.fallback;
    const out = v && peopleIds.has(v) ? v : null;
    personCache.set(ck, out);
    return out;
  };

  const planRows: PlanRow[] = [];
  tick = pace("Checking every deal", parsed.length);
  for (const [idx, p] of parsed.entries()) {
    await tick();
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
    if (pipeRaw) { const ch = choice("deal.pipeline", pipeRaw); if (ch !== "__default") pipelineId = ch; }
    let phaseTarget: Phase | null = null;
    /** The phase value said a status (On hold, Lost, Won) instead of a phase. */
    let phaseStatus: string | null = null;
    if (phaseRaw) {
      const ch = choice("deal.phase", phaseRaw);
      if (isPhaseStatus(ch)) phaseStatus = ch.slice(PHASE_STATUS.length);
      else if (ch !== "__first") phaseTarget = phaseById.get(ch) ?? null;
    }
    // a dated phase names its pipeline too
    const firstHit = p.hits.map((h) => phaseById.get(h.phaseId)).find(Boolean);
    if (!pipelineId) pipelineId = phaseTarget?.pipeline_id ?? firstHit?.pipeline_id ?? (state.defaultPipeline || null);
    const ov = state.pipeOverride[idx];
    const pipeOverridden = !!ov && ov !== pipelineId && ctx.pipelines.some((x) => x.id === ov);
    if (pipeOverridden) pipelineId = ov;
    const info = pipeInfo(pipelineId);
    const ord = info.ord;
    const pos = (ph: Phase | null | undefined) => (ph ? info.pos.get(ph.id) ?? -1 : -1);
    const inPipe = (ph: Phase) => (ph.pipeline_id === pipelineId ? ph : info.byName.get(normHeader(ph.name)) ?? (ph.sales_outcome ? (ph.sales_outcome === "win" ? info.win : info.loss) : null) ?? null);
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
    const datedPhases = [...dated.keys()].map((id) => ord[info.pos.get(id) ?? -1]).filter(Boolean);
    const furthest = datedPhases.filter((x) => !x.sales_outcome).sort((a, b) => pos(b) - pos(a))[0] ?? null;
    if (furthest && (!phase || (!phase.sales_outcome && pos(furthest) > pos(phase)))) phase = furthest;
    // held deals: the phase chosen for them (unless the file's dates already say how far they got)
    if (!phase && phaseStatus === "paused" && state.heldPhase) {
      const hp = phaseById.get(state.heldPhase);
      phase = hp ? inPipe(hp) : null;
    }
    if (!phase) phase = info.first;

    let dealStatus = statusRaw ? choice("deal.status", statusRaw) : "active";
    // the phase column said a status: it counts unless a status column says otherwise
    if (phaseStatus && (!statusRaw || dealStatus === "active")) dealStatus = phaseStatus;
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
    if (dealStatus === "won" && phase?.sales_outcome !== "win" && info.win) phase = info.win;
    if (dealStatus === "lost" && phase?.sales_outcome !== "loss" && info.loss) phase = info.loss;
    // a won deal went through every phase; a lost one stopped where the file says
    if (phase?.sales_outcome === "win") reached = info.lastOpen ?? reached;
    if (!reached && phase?.sales_outcome === "loss") reached = info.first;

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
    const ch = prodRaw ? choice("deal.product", prodRaw) : "__default";
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
      const lc = choice("deal.loss_reason", raw);
      if (lc === "__details") lossDetails = raw;
      else if (lc === "__new") { lossReason = raw; newLossReason = true; }
      else lossReason = lc;
    }

    /* partner, and its cut */
    const pk = rowPartner[idx];
    const partner = pk ? partners.get(pk)! : null;
    let partnerMode: PlanRow["partnerMode"] = null, partnerValue: number | null = null;
    const cutRaw = one("deal.partner_cut");
    if (partner && cutRaw) {
      const n = parseNumber(p.cells["deal.partner_cut"]);
      if (n == null || n < 0) issues.push(`Partner margin “${cutRaw}” isn't a % or an amount`);
      else if (cutRaw.includes("%") || n <= 100) { partnerMode = "percent"; partnerValue = n > 0 && n < 1 && !cutRaw.includes("%") ? Math.round(n * 10000) / 100 : n; }
      else { partnerMode = "amount"; partnerValue = n; }
    }
    if (partner && !productId) issues.push(`Partner “${partner.name}” isn't saved: the deal has no product line (choose a default product)`);

    /* people */
    let owner: string | null = null;
    for (const rule of owners) { owner = personFor(rule, r); if (owner) break; }
    const team = Array.from(new Set([...(owner ? [owner] : []), ...teams.map((rule) => personFor(rule, r)).filter((x): x is string => !!x)]));
    const dealRoles: Record<string, string> = {};
    team.forEach((pid) => { const role = resolveDealRole(ctx.roles, pid, pipelineId, state.personRole[pid]); if (role) dealRoles[pid] = role.id; });

    /* status of the row */
    let status: PlanRow["status"] = "new"; let reason: string | undefined; let dupOf: string | null = null;
    const titleText = p.get["deal.title"]?.join(" · ") ?? null;
    if (!companyRef && !contactRef) { status = "error"; reason = companyKey || ctKey ? "Company and contact are both skipped" : "No company or contact"; }
    else if (!pipelineId || !ord.length) { status = "error"; reason = pipelineId ? "This pipeline has no phases" : "No pipeline"; }
    else {
      const title = titleKey(titleText);
      // the day it was created is part of what a deal is: "Renewal" in 2021 and in 2023 are two deals
      const fileKey = `${companyRef ? `co:${companyRef}` : `ct:${contactRef}`}|${pipelineId}|${title || `p:${productId ?? ""}`}|${created ?? ""}`;
      if (seenInFile.has(fileKey)) {
        // the same deal twice in this file: only the first one counts
        status = "dup"; reason = "Same deal as an earlier row of the file";
      } else {
        seenInFile.set(fileKey, idx);
        const crmWho = companyRef?.startsWith("crm:") ? `co:${companyRef.slice(4)}` : !companyRef && contactRef?.startsWith("crm:") ? `ct:${contactRef.slice(4)}` : null;
        const theirs = crmWho ? dealsByKey.get(`${crmWho}|${pipelineId}`) ?? [] : [];
        if (theirs.length) {
          // each CRM deal is the match of one row at most, the one created the same day first
          const free = theirs.filter((t) => !takenCrm.has(t.id));
          const sameDay = (t: Tracking) => !!created && dayOf(t) === created;
          let hit: Tracking | undefined; let why = "";
          if (title) {
            const sameTitle = free.filter((t) => titleKey(t.deal_name) === title);
            hit = sameTitle.find(sameDay) ?? sameTitle[0];
            if (hit) why = "Already in the CRM — same company, pipeline and title";
            else if (!theirs.some((t) => titleKey(t.deal_name) === title)) {
              // no deal there has this title: an untitled one may be this deal
              const untitled = free.filter((t) => !titleKey(t.deal_name));
              hit = untitled.find(sameDay) ?? untitled[0];
              if (hit) why = "Already has a deal in this pipeline (without a title)";
              else issues.push(`${theirs.length === 1 ? "Another deal" : `${theirs.length} other deals`} of this ${companyRef ? "company" : "contact"} ${theirs.length === 1 ? "is" : "are"} already in this pipeline — imported as a different deal (its title is different)`);
            } else issues.push("A deal with this title is already in the CRM, matched to another row of the file — imported as one more");
          } else {
            hit = free.find(sameDay) ?? free.find((t) => !titleKey(t.deal_name)) ?? free[0];
            if (hit) why = "Already has a deal in this pipeline";
          }
          if (hit) {
            takenCrm.add(hit.id);
            dupOf = hit.id;
            status = state.dupMode === "import" ? "new" : state.dupMode === "update" ? "update" : "dup";
            reason = why;
          }
        }
      }
    }
    if (status === "new" && required.length) {
      const missing = required.filter((f) => { const v = p.custom[`custom:${f.id}`]; return v == null || v === "" || (f.type === "boolean" && v === false); });
      if (missing.length) { status = "error"; reason = `Required: ${missing.map((f) => f.label).join(", ")}`; }
    }
    const coIsClient = companyRef?.startsWith("crm:") ? clients.has(companyRef.slice(4)) : false;
    const becomesClient = status === "new" && state.makeClients && dealStatus === "won" && !!closedOn && !!companyRef && !coIsClient;
    if (dealStatus === "won" && closedOn && !companyRef) issues.push("Won with a close date, but without a company it can't become a client");
    planRows.push({
      idx, status, reason, dupOf, issues, companyRef, companyLabel, companyKey, contactRef, contactLabel, contactKey: ctKey,
      pipelineId, pipeOverridden, phaseId: phase?.id ?? null, reachedPhaseId: reached?.id ?? null, dealStatus, phaseDates,
      value, productId, productDefaulted, owner, team, dealRoles, expectedClose, closedOn, probability, created, becomesClient,
      title: titleText, notes: p.get["deal.notes"] ?? [], lossReason, lossDetails, newLossReason, custom: p.custom,
      partnerRef: partner?.ref ?? null, partnerLabel: partner?.name ?? null, partnerMode, partnerValue,
    });
  }

  /* ---- 6) what the file would fill / change in the CRM records it links to ---- */
  const fieldLabel = (entity: "company" | "contact") => (k: string, isCustom: boolean) => {
    if (!isCustom) return BASE_TARGETS.find((b) => b.key === `${entity}.${k}`)?.label ?? k;
    if (k.startsWith("new:")) return state.newFields.find((n) => `new:${n.tmp}` === k)?.label ?? "New field";
    return ((entity === "company" ? ctx.companyFields : ctx.contactFields) ?? []).find((f) => f.id === k)?.label ?? k;
  };
  const planCustom = (c: Record<string, any>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k.startsWith("new:") ? k : k.slice(k.indexOf(":") + 1), v]));
  tick = pace("Comparing with your CRM", companies.size + contacts.size);
  for (const e of companies.values()) {
    await tick();
    const crm = e.ref?.startsWith("crm:") ? coById.get(e.ref.slice(4)) : null;
    if (!crm) { e.diff = null; continue; }
    const { name: _n, ...file } = e.data; // eslint-disable-line @typescript-eslint/no-unused-vars
    e.diff = diffRecord(crm, file, planCustom(e.custom), fieldLabel("company"));
  }
  for (const e of contacts.values()) {
    await tick();
    const crm = e.ref?.startsWith("crm:") ? ctById.get(e.ref.slice(4)) : null;
    if (!crm) { e.diff = null; continue; }
    e.diff = diffRecord(crm, contactFile(e), planCustom(e.custom), fieldLabel("contact"));
  }

  const ok = planRows.filter((x) => x.status === "new");
  const usedCo = new Set(ok.map((x) => x.companyRef));
  const usedCt = new Set(ok.map((x) => x.contactRef));
  const companyList = [...companies.values()].sort((a, b) => (a.found ? 1 : 0) - (b.found ? 1 : 0) || (a.suggest ? 0 : 1) - (b.suggest ? 0 : 1) || b.count - a.count);
  const contactList = [...contacts.values()].sort((a, b) => (a.found ? 1 : 0) - (b.found ? 1 : 0) || b.count - a.count);
  const nc = contactList.filter((c) => c.ref === `new:${c.key}` && usedCt.has(c.ref));
  const withPartner = ok.filter((x) => x.partnerRef);
  return {
    rows: planRows, companies: companyList, contacts: contactList, newContacts: nc, partners: [...partners.values()].sort((a, b) => b.count - a.count),
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
      lost: ok.filter((x) => x.dealStatus === "lost").length,
      held: ok.filter((x) => x.dealStatus === "paused").length,
      ...(() => {
        const co = companyList.filter((c) => c.diff && usedCo.has(c.ref)), ct = contactList.filter((c) => c.diff && usedCt.has(c.ref));
        const sum = (xs: { diff?: RecordDiff | null }[], k: "fill" | "change") => xs.reduce((n, x) => n + (x.diff?.[k].length ?? 0), 0);
        return { coExisting: co.length, coFill: sum(co, "fill"), coChange: sum(co, "change"), ctExisting: ct.length, ctFill: sum(ct, "fill"), ctChange: sum(ct, "change") };
      })(),
      partner: withPartner.length,
      partnerNew: new Set(withPartner.filter((x) => x.partnerRef!.startsWith("pnew:")).map((x) => x.partnerRef)).size,
      partnerNoProduct: withPartner.filter((x) => !x.productId).length,
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
  /** Deals saved with their partner. */
  partners: number;
  /** Stopped before the end (what was saved stays; importing the same file again carries on). */
  cancelled: boolean;
  /** What the database couldn't take (a column it doesn't have yet…). */
  notes: string[];
}
export const emptyResult = (): RunResult => ({ created: 0, updated: 0, failed: [], coCreated: 0, ctCreated: 0, coUpdated: 0, ctUpdated: 0, ctLinked: 0, clientsCreated: 0, newFields: 0, batchId: null, partners: 0, cancelled: false, notes: [] });

/** How far the import got: the current step, its count, and a connection problem it's waiting on. */
export interface Progress { done: number; total: number; phase: string; step: number; steps: number; t0: number; problem?: string | null }
/** Pause / resume / stop, shared by the import and its screen. */
export interface RunCtl { paused: boolean; cancelled: boolean }

async function startBatch(entity: "deal" | "company" | "contact", fileName: string): Promise<string | null> {
  const { data, error } = await supabase.from("import_batches").insert({ entity, file_name: fileName || null }).select("id").single();
  return error ? null : (data as any)?.id ?? null;
}
async function finishBatch(id: string | null, created: number, updated = 0) {
  if (id) await supabase.from("import_batches").update({ rows_created: created, rows_updated: updated }).eq("id", id);
}

/* ─────────── writing in bulk ─────────── */

const BATCH = 500;
const chunk = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^ (Math.random() * 16) >> (+c / 4)).toString(16)));
type Res = { error: any; status?: number; data?: any };
const errText = (e: any) => String(e?.message ?? e ?? "Failed");
/** A hiccup worth trying again (no connection, timeout, server busy) — not a problem with the data. */
function transient(r: Res): boolean {
  if (!r.error) return false;
  const code = String(r.error.code ?? ""), st = r.status ?? 0;
  if (/^(08|53|57)/.test(code) || /failed to fetch|network|timeout|timed out|load failed|aborted|ECONN|gateway|unavailable/i.test(errText(r.error))) return true;
  return st >= 502 || st === 429 || st === 408 || (!code && (st === 0 || st === 500));
}
/** The row was saved by an earlier try whose answer got lost (same id). */
const alreadyThere = (e: any) => String(e?.code ?? "") === "23505" && /_pkey/i.test(errText(e));
const friendly = (m: string) => (/row-level security|42501|permission denied/i.test(m) ? "You don't have permission to change this record." : m);
/** Runs `fn` over the items, n at a time. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
/** The optional column a "column … does not exist" error names (it's left out and the write tried again). */
const namedColumn = (msg: string, cols: string[]) => cols.find((c) => new RegExp(`["'\\s.]${c}["'\\s]`).test(` ${msg} `));

/**
 * The writer of one import run: every request goes through `send` (paused / stopped from the
 * screen, tried again after a hiccup, and — when the connection stays down — paused until
 * the person presses Retry). `finishing` requests complete what was started even after Stop
 * (a deal's contacts and phases are written with it).
 */
function makeWriter(ctl: RunCtl, onProblem: (m: string | null) => void) {
  const gate = async (finishing = false) => {
    while (ctl.paused && !ctl.cancelled) await sleep(200);
    if (ctl.cancelled && !finishing) throw new Cancelled();
  };
  const send = async (fn: () => PromiseLike<Res>, finishing = false): Promise<Res> => {
    for (let attempt = 0; ; attempt++) {
      await gate(finishing);
      let r: Res;
      try { r = await fn(); } catch (e: any) { r = { error: { message: errText(e) }, status: 0 }; }
      if (!transient(r)) { if (attempt) onProblem(null); return r; }
      if (attempt < 3) { await sleep([1000, 3000, 8000][attempt]); continue; }
      if (ctl.cancelled) return r; // stopped: don't wait for Retry
      ctl.paused = true;
      onProblem(`No answer from the database (${errText(r.error)}).`);
      attempt = -1;
    }
  };
  /** Saves new rows 500 per request. Ids are made here, so a retried request never doubles a row; a batch the database refuses is sent row by row to find the bad ones. */
  const insertMany = async (table: string, items: { row: Record<string, any>; extra: Record<string, any> }[], noExtra: { on: boolean },
    onRow: (i: number, err: string | null) => void, onBatch: (n: number) => void) => {
    const body = (it: { row: Record<string, any>; extra: Record<string, any> }) => (noExtra.on ? it.row : { ...it.row, ...it.extra });
    for (const part of chunk(items.map((_, i) => i), BATCH)) {
      const ins = () => send(() => supabase.from(table).insert(part.map((i) => body(items[i])), { defaultToNull: false }) as any);
      let r = await ins();
      // the database hasn't had the CRM upgrade: save what it knows
      if (r.error && !noExtra.on && missingColumn(errText(r.error))) { noExtra.on = true; r = await ins(); }
      if (!r.error) part.forEach((i) => onRow(i, null));
      else {
        await pool(part, 6, async (i) => {
          let x = await send(() => supabase.from(table).insert(body(items[i])) as any);
          if (x.error && !noExtra.on && missingColumn(errText(x.error))) { noExtra.on = true; x = await send(() => supabase.from(table).insert(body(items[i])) as any); }
          onRow(i, !x.error || alreadyThere(x.error) ? null : friendly(errText(x.error)));
        });
      }
      onBatch(part.length);
    }
  };
  /** Changes rows already in the CRM: 200 per request with import_update_rows (SQL 40 / 41), 6 at a time without it. */
  const rpcOk: Record<string, boolean> = {};
  const updateMany = async (table: "companies" | "contacts" | "trackings", items: { id: string; set: Record<string, any>; addRel?: string[]; rel?: string[] }[],
    onRow: (i: number, err: string | null) => void, onBatch: (n: number) => void) => {
    for (const part of chunk(items.map((_, i) => i), 200)) {
      if (rpcOk[table] !== false) {
        const r = await send(() => supabase.rpc("import_update_rows", { p_table: table, p_rows: part.map((i) => ({ id: items[i].id, set: items[i].set, add_relationship: items[i].addRel ?? [] })) }) as any);
        if (!r.error) {
          const bad = new Map<string, string>(((r.data?.errors ?? []) as any[]).map((e) => [String(e.id), String(e.error)]));
          part.forEach((i) => onRow(i, bad.has(items[i].id) ? friendly(bad.get(items[i].id)!) : null));
          onBatch(part.length);
          continue;
        }
        // not installed, or an older version that doesn't take this table: one by one
        rpcOk[table] = false;
      }
      await pool(part, 6, async (i) => {
        const it = items[i];
        let set = { ...it.set, ...(it.addRel?.length && it.rel ? { relationship: it.rel } : {}) };
        if (!Object.keys(set).length) { onRow(i, null); return; }
        let x = await send(() => supabase.from(table).update(set).eq("id", it.id) as any);
        if (x.error && missingColumn(errText(x.error))) {
          set = Object.fromEntries(Object.entries(set).filter(([k]) => !UPGRADE_COLS.has(k)));
          x = Object.keys(set).length ? await send(() => supabase.from(table).update(set).eq("id", it.id) as any) : { error: null };
        }
        onRow(i, x.error ? friendly(errText(x.error)) : null);
      });
      onBatch(part.length);
    }
  };
  /** Links contacts to companies, 1000 links per request (a link that's already there is skipped). */
  const linkMany = async (links: { company_id: string; contact_id: string }[], onBatch?: (n: number) => void) => {
    const failed = new Set<string>();
    for (const rows of chunk(links, 1000)) {
      const w = await send(() => supabase.from("company_contacts").insert(rows) as any);
      if (w.error) await pool(rows, 6, async (row) => {
        const x = await send(() => supabase.from("company_contacts").insert(row) as any);
        if (x.error && !/duplicate|unique|23505/i.test(`${x.error.code ?? ""} ${errText(x.error)}`)) failed.add(row.contact_id);
      });
      onBatch?.(rows.length);
    }
    return failed;
  };
  return { send, gate, insertMany, updateMany, linkMany };
}
/** Columns added by the CRM upgrade: left out when the database doesn't have them yet. */
const UPGRADE_COLS = new Set(["phone_ext", "landline", "landline_ext", "sector", "source", "relationship", "billing", "parent_id", "linkedin", "province", "emails"]);
/** Deal columns added by later upgrades: a database without one still gets the deal. */
const DEAL_OPTIONAL = ["import_batch_id", "deal_roles", "custom", "created_at", "close_date", "deal_name"];
const PARTNER_COLS = ["partner_id", "partner_mode", "partner_value"];

/** A file contact's own fields, as the contacts table names them. */
const contactFile = (c: ContactName): Record<string, any> => ({ last_name: c.last_name, email: c.email, phone: c.phone, position: c.position, notes: c.notes, ...(c.is_billing ? { is_billing: true } : {}) });

/** One deal and everything that hangs from it, ready to save. */
interface DealWrite {
  r: PlanRow; row: Record<string, any>;
  contacts: Record<string, any>[]; products: Record<string, any>[]; employees: Record<string, any>[]; events: Record<string, any>[]; notes: Record<string, any>[];
}

export async function runImport(ctx: Ctx, state: ImportState, columns: Column[], plan: Plan, fileName: string, rowOffset: number,
  onProgress: (p: Progress) => void, ctl: RunCtl = { paused: false, cancelled: false }): Promise<RunResult> {
  state = withDefaults(state);
  const res = emptyResult();
  const failed = res.failed;
  const todo = plan.rows.filter((r) => r.status === "new");
  const upd = plan.rows.filter((r) => r.status === "update" && r.dupOf);
  const crmCo = new Map(ctx.companies.map((c) => [c.id as string, c]));
  const crmCt = new Map(ctx.contacts.map((c) => [c.id as string, c]));
  const products = new Map(ctx.products.map((p) => [p.id as string, p]));
  const note = (m: string) => { if (!res.notes.includes(m)) res.notes.push(m); };

  /* what there is to do, step by step (only the steps with work count) */
  const usedCoRefs = new Set(todo.map((r) => r.companyRef).filter(Boolean) as string[]);
  const usedCtRefs = new Set(todo.map((r) => r.contactRef).filter(Boolean) as string[]);
  const coTodo = plan.companies.filter((c) => usedCoRefs.has(`new:${c.key}`));
  const usedPartners = new Set(todo.map((r) => r.partnerRef).filter(Boolean) as string[]);
  const partnerNew = plan.partners.filter((p) => p.ref.startsWith("pnew:") && usedPartners.has(p.ref));
  const partnerCrm = plan.partners.filter((p) => p.ref.startsWith("crm:") && !p.tagged && usedPartners.has(p.ref) && crmCo.has(p.ref.slice(4)));
  const coFound = state.coExisting === "keep" ? [] : plan.companies.filter((c) => c.ref?.startsWith("crm:") && usedCoRefs.has(c.ref) && crmCo.has(c.ref.slice(4)));
  const ctFound = plan.contacts.filter((c) => c.ref?.startsWith("crm:") && usedCtRefs.has(c.ref) && crmCt.has(c.ref.slice(4)));
  const labels = ["Preparing fields and lists", (coTodo.length || partnerNew.length) && "Creating companies", (coFound.length || partnerCrm.length) && "Updating companies",
    plan.newContacts.length && "Creating contacts", ctFound.length && "Updating contacts", todo.length && "Importing deals", upd.length && "Updating deals already in the CRM",
    todo.some((r) => r.becomesClient) && "Creating clients"].filter(Boolean) as string[];
  let cur: Progress = { done: 0, total: 0, phase: labels[0], step: 1, steps: labels.length, t0: Date.now(), problem: null };
  const begin = (label: string, total: number) => { cur = { done: 0, total, phase: label, step: labels.indexOf(label) + 1, steps: labels.length, t0: Date.now(), problem: cur.problem }; onProgress(cur); };
  const advance = (n: number) => { cur = { ...cur, done: Math.min(cur.total, cur.done + n) }; onProgress(cur); };
  const w = makeWriter(ctl, (m) => { cur = { ...cur, problem: m }; onProgress(cur); });
  const tick = pacer(undefined, () => ctl.cancelled)("", 0);

  let coBatchId: string | null = null, ctBatchId: string | null = null, batchId: string | null = null;
  const dealIdOf = new Map<number, string>();
  const coIds = new Map<string, string>(), ctIds = new Map<string, string>();
  const coId = (ref: string | null) => (!ref ? null : ref.startsWith("crm:") ? ref.slice(4) : ref.startsWith("pnew:") ? coIds.get(ref) ?? null : coIds.get(ref.slice(4)) ?? null);
  const ctId = (ref: string | null) => (!ref ? null : ref.startsWith("crm:") ? ref.slice(4) : ctIds.get(ref.slice(4)) ?? null);
  try {
    /* 1) new fields (deal, company, contact), and new options on existing choice lists */
    const tmpIds = new Map<string, string>();
    const usedNew = state.newFields.filter((n) => Object.values(state.mapping).includes(`new:${n.tmp}`));
    // options a column adds ("+ add as a new option")
    const extraOptions = (t: string, base: string[]) => {
      const add: string[] = [];
      for (const [colS, tt] of Object.entries(state.mapping)) {
        if (tt !== t) continue;
        const col = columns.find((c) => c.i === +colS);
        if (col) distinctValues(col.values).forEach(({ text }) => {
          if (choiceFor(ctx, state, t, text).choice === "__new" && ![...base, ...add].some((o) => normHeader(o) === normHeader(text))) add.push(text);
        });
      }
      return add;
    };
    const optionFields = [...new Set(Object.values(state.mapping))].filter((t) => /^(custom|cocustom|ctcustom):/.test(t) && defOf(ctx, state, t)?.type === "select");
    const newReasons = [...new Set(todo.filter((r) => r.newLossReason && r.lossReason).map((r) => r.lossReason!))];
    const partnerTagNeeded = partnerNew.length + partnerCrm.length > 0 || coTodo.some((c) => usedPartners.has(`new:${c.key}`));
    begin(labels[0], usedNew.length + optionFields.length + newReasons.length + (partnerTagNeeded ? 1 : 0));
    const sortBase = { deal: ctx.fields.length, company: (ctx.companyFields ?? []).length, contact: (ctx.contactFields ?? []).length };
    // a field with that name made by an earlier run of this import (stopped, or run again) is used, never made twice
    const [haveD, haveC, haveT] = usedNew.length ? await Promise.all([
      listTrackingFields().catch(() => ctx.fields), listCompanyFields().catch(() => ctx.companyFields ?? []), listContactFields().catch(() => ctx.contactFields ?? []),
    ]) : [[], [], []];
    for (const [k, n] of usedNew.entries()) {
      await w.gate();
      const options = n.type === "select" ? [...n.options, ...extraOptions(`new:${n.tmp}`, n.options)] : [];
      const input = { label: n.label.trim(), type: n.type, required: false, options, sort: sortBase[n.entity] + k };
      const have = ((n.entity === "deal" ? haveD : n.entity === "company" ? haveC : haveT) as { id: string; label: string; type: string; options?: string[] }[])
        .find((f) => normHeader(f.label) === normHeader(input.label));
      if (have) {
        tmpIds.set(n.tmp, have.id);
        const add = options.filter((o) => !(have.options ?? []).some((x) => normHeader(x) === normHeader(o)));
        if (add.length && (have.type === "select" || have.type === "multiselect")) {
          const opts = [...(have.options ?? []), ...add];
          if (n.entity === "deal") await updateTrackingField(have.id, { options: opts }).catch(() => null);
          else if (n.entity === "company") await updateCompanyField(have.id, { options: opts }).catch(() => null);
          else await updateContactField(have.id, { options: opts }).catch(() => null);
        }
        advance(1);
        continue;
      }
      try {
        if (n.entity === "deal") { const { field } = await addTrackingField(input as any); if (field?.id) tmpIds.set(n.tmp, field.id); }
        else if (n.entity === "company") { const f = await addCompanyField(input as any); if (f?.id) tmpIds.set(n.tmp, f.id); }
        else { const f = await addContactField(input as any); if (f?.id) tmpIds.set(n.tmp, f.id); }
      } catch { /* looked up below */ }
      if (tmpIds.has(n.tmp)) res.newFields++;
      advance(1);
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
        else failed.push({ row: 0, reason: `Field “${n.label}” couldn't be created — its column wasn't imported` });
      });
    }
    for (const t of optionFields) {
      await w.gate();
      const def = defOf(ctx, state, t)!;
      const add = extraOptions(t, def.options);
      const id = t.slice(t.indexOf(":") + 1);
      if (add.length) {
        if (def.entity === "deal") await updateTrackingField(id, { options: [...def.options, ...add] });
        else if (def.entity === "company") await updateCompanyField(id, { options: [...def.options, ...add] });
        else await updateContactField(id, { options: [...def.options, ...add] });
      }
      advance(1);
    }
    const resolveCustom = (custom: Record<string, any>) => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(custom)) { const id = k.startsWith("new:") ? tmpIds.get(k.slice(4)) : k.slice(k.indexOf(":") + 1); if (id) out[id] = v; }
      return out;
    };
    /* new lost reasons */
    for (const [k, label] of newReasons.entries()) { await w.gate(); await addLossReason(label, ctx.lossReasons.length + k).catch(() => null); advance(1); }
    /* the company type partners get (one of your types with "partner" in its name, else "Partner", added to your list) */
    let partnerTag = "Partner";
    if (partnerTagNeeded) {
      await w.gate();
      const opts = await listCrmOptions().catch(() => []);
      const rel = opts.filter((o) => o.kind === "relationship");
      const o = rel.find((x) => normHeader(x.label) === "partner") ?? rel.find((x) => isPartnerTag(x.label));
      if (o) partnerTag = o.label; else await addCrmOption("relationship", "Partner", rel.length).catch(() => null);
      advance(1);
    }

    /* 2) companies: the new ones (and new partners), 500 per request */
    if (coTodo.length || partnerNew.length) {
      begin("Creating companies", coTodo.length + partnerNew.length);
      coBatchId = await startBatch("company", `${fileName} (deals import)`);
      const items: { row: Record<string, any>; extra: Record<string, any>; key: string; label: string; firstRow: number }[] = [];
      for (const c of coTodo) {
        const nm = splitCompanyNames(c.name, c.data.legal_name);
        const isP = usedPartners.has(`new:${c.key}`);
        const { row, extra } = companyRow({ ...c.data, name: nm.name, legal_name: nm.legal, custom: resolveCustom(c.custom), ...(isP ? { relationship: [partnerTag] } : {}) } as any);
        items.push({ row: { ...row, id: newId(), ...(coBatchId ? { import_batch_id: coBatchId } : {}) }, extra, key: c.key, label: c.name, firstRow: c.firstRow });
        await tick();
      }
      for (const p of partnerNew) {
        const nm = splitCompanyNames(p.name, null);
        const { row, extra } = companyRow({ name: nm.name, legal_name: nm.legal, custom: {}, relationship: [partnerTag] } as any);
        items.push({ row: { ...row, id: newId(), ...(coBatchId ? { import_batch_id: coBatchId } : {}) }, extra, key: p.ref, label: p.name, firstRow: p.firstRow });
      }
      await w.insertMany("companies", items, { on: false }, (i, err) => {
        const it = items[i];
        if (!err) { coIds.set(it.key, it.row.id); res.coCreated++; }
        else failed.push({ row: it.firstRow + rowOffset, reason: `Company “${it.label}”: ${err}` });
      }, advance);
    }

    /* 3) companies already in the CRM: the fields the file fills, and the partner type — one write each */
    if (coFound.length || partnerCrm.length) {
      const byId = new Map<string, { id: string; set: Record<string, any>; addRel: string[]; rel: string[]; label: string; firstRow: number; n: number }>();
      for (const c of coFound) {
        const crm = crmCo.get(c.ref!.slice(4))!;
        const { name: _n, ...file } = c.data; // eslint-disable-line @typescript-eslint/no-unused-vars
        const cust = resolveCustom(c.custom);
        const patch = patchFor(state.coExisting, crm, diffRecord(crm, file, cust, (k) => k), file, cust);
        if (!patch) { await tick(); continue; }
        // two names of the file can be the same CRM company: one write with what both bring (the first one wins a field)
        const prev = byId.get(crm.id!);
        if (prev) { prev.set = { ...patch, ...prev.set, ...(prev.set.custom && patch.custom ? { custom: { ...patch.custom, ...prev.set.custom } } : {}) }; prev.n++; }
        else byId.set(crm.id!, { id: crm.id!, set: patch, addRel: [], rel: crm.relationship ?? [], label: c.name, firstRow: c.firstRow, n: 1 });
        await tick();
      }
      for (const p of partnerCrm) {
        const crm = crmCo.get(p.ref.slice(4))!;
        const e = byId.get(crm.id!) ?? { id: crm.id!, set: {}, addRel: [], rel: crm.relationship ?? [], label: crm.name, firstRow: p.firstRow, n: 0 };
        e.addRel = [partnerTag]; e.rel = [...new Set([...e.rel, partnerTag])];
        byId.set(crm.id!, e);
      }
      const items = [...byId.values()];
      begin("Updating companies", items.length);
      await w.updateMany("companies", items, (i, err) => {
        if (!err) res.coUpdated += items[i].n; else failed.push({ row: items[i].firstRow + rowOffset, reason: `Company “${items[i].label}”: ${err}` });
      }, advance);
    }

    /* 4) contacts: create the new ones (500 per request), then their company links */
    if (plan.newContacts.length) {
      begin("Creating contacts", plan.newContacts.length);
      ctBatchId = await startBatch("contact", `${fileName} (deals import)`);
      const items: { row: Record<string, any>; extra: Record<string, any> }[] = [];
      for (const c of plan.newContacts) {
        const { row, extra } = contactRow({ first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone, position: c.position, is_billing: !!c.is_billing, notes: c.notes, custom: resolveCustom(c.custom) } as any);
        items.push({ row: { ...row, id: newId(), ...(ctBatchId ? { import_batch_id: ctBatchId } : {}) }, extra });
        await tick();
      }
      const made: number[] = [];
      await w.insertMany("contacts", items, { on: false }, (i, err) => {
        const c = plan.newContacts[i];
        if (!err) { made.push(i); ctIds.set(c.key, items[i].row.id); }
        else failed.push({ row: c.firstRow + rowOffset, reason: `Contact “${[c.first_name, c.last_name].filter(Boolean).join(" ")}”: ${err}` });
      }, advance);
      const links = made.flatMap((i) => { const cid = coId(plan.newContacts[i].companyRef); return cid ? [{ company_id: cid, contact_id: items[i].row.id as string }] : []; });
      const bad = await w.linkMany(links);
      made.forEach((i) => {
        const c = plan.newContacts[i];
        res.ctCreated++;
        if (bad.has(items[i].row.id)) failed.push({ row: c.firstRow + rowOffset, reason: `Contact “${[c.first_name, c.last_name].filter(Boolean).join(" ")}”: created, but not linked to its company` });
      });
    }

    /* 5) contacts already in the CRM: what the file fills, and the company of their deals */
    if (ctFound.length) {
      const items: { id: string; set: Record<string, any>; c: ContactName }[] = [];
      const links: { company_id: string; contact_id: string }[] = [];
      const seen = new Set<string>();
      for (const c of ctFound) {
        const crm = crmCt.get(c.ref!.slice(4))!;
        if (state.ctExisting !== "keep" && !seen.has(crm.id!)) {
          const file = contactFile(c);
          const cust = resolveCustom(c.custom);
          const patch = patchFor(state.ctExisting, crm, diffRecord(crm, file, cust, (k) => k), file, cust);
          if (patch) { items.push({ id: crm.id!, set: patch, c }); seen.add(crm.id!); }
        }
        const cid = coId(c.companyRef);
        if (state.linkContacts && cid && !crm.companyIds.includes(cid) && !links.some((l) => l.contact_id === crm.id && l.company_id === cid)) links.push({ company_id: cid, contact_id: crm.id! });
        await tick();
      }
      begin("Updating contacts", items.length + links.length);
      await w.updateMany("contacts", items, (i, err) => {
        if (!err) res.ctUpdated++; else failed.push({ row: items[i].c.firstRow + rowOffset, reason: `Contact “${items[i].c.first_name}”: ${err}` });
      }, advance);
      const bad = await w.linkMany(links, advance);
      links.forEach((l) => { if (!bad.has(l.contact_id)) { res.ctLinked++; const crm = crmCt.get(l.contact_id); if (crm) crm.companyIds = [...crm.companyIds, l.company_id]; } });
    }

    /* 6) deals: 500 per request, each with its contact, product line (and partner), team, phase dates and notes */
    if (todo.length) {
      begin("Importing deals", todo.length);
      batchId = await startBatch("deal", fileName);
      res.batchId = batchId;
      const writes: DealWrite[] = [];
      for (const r of todo) {
        await tick();
        const company_id = coId(r.companyRef), contact_id = ctId(r.contactRef);
        if (!company_id && !contact_id) { failed.push({ row: r.idx + rowOffset, reason: "Its company / contact couldn't be created" }); continue; }
        const product = r.productId ? products.get(r.productId) : null;
        const price = r.value ?? product?.tiers?.[0]?.price ?? null;
        const id = newId();
        const partner_id = r.partnerRef ? coId(r.partnerRef) : null;
        const title = r.title ? r.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
        writes.push({
          r,
          row: {
            id, company_id, pipeline_id: r.pipelineId, current_phase_id: r.phaseId, status: r.dealStatus,
            product_id: r.productId, product_price: price, rep_close_prob: r.probability, rep_close_date: r.expectedClose,
            loss_reason: r.lossReason, loss_details: r.lossDetails, custom: resolveCustom(r.custom),
            ...(title ? { deal_name: title } : {}),
            ...(r.closedOn ? { close_date: r.closedOn } : {}),
            ...(Object.keys(r.dealRoles).length ? { deal_roles: r.dealRoles } : {}),
            ...(r.created ? { created_at: `${r.created}T09:00:00Z` } : {}),
            ...(batchId ? { import_batch_id: batchId } : {}),
          },
          contacts: contact_id ? [{ contact_id }] : [],
          products: r.productId ? [{ product_id: r.productId, price: price ?? 0, ...(partner_id ? { partner_id, partner_mode: r.partnerMode ?? "percent", partner_value: r.partnerValue } : {}) }] : [],
          employees: r.team.map((p) => ({ profile_id: p, is_owner: p === r.owner })),
          events: Object.entries(r.phaseDates).map(([phase_id, day]) => ({ phase_id, entered_at: `${day}T09:00:00Z` })),
          notes: r.notes.length ? [{ phase_id: r.phaseId, body: r.notes.join("\n\n") }] : [],
        });
      }
      const dropped = new Set<string>();
      let rpcDeals = true, noPartner = false;
      const childTables = [["contacts", "tracking_contacts"], ["products", "tracking_products"], ["employees", "tracking_employees"], ["events", "tracking_phase_events"], ["notes", "tracking_notes"]] as const;
      const label: Record<string, string> = { tracking_contacts: "its contact", tracking_products: "its product line", tracking_employees: "its team", tracking_phase_events: "its phase dates", tracking_notes: "its notes" };
      const done = (d: DealWrite) => { dealIdOf.set(d.r.idx, d.row.id); res.created++; if (d.products[0]?.partner_id && !noPartner) res.partners++; };

      for (const part of chunk(writes, BATCH)) {
        /* with 41_import_deals.sql: the deals and all they carry in one request, each deal all or nothing */
        if (rpcDeals) {
          // allow_duplicate only when the person chose to import duplicates — otherwise the database
          // itself refuses a deal it already has (same company, pipeline, title and day), so an
          // incomplete read of the CRM can never double a deal.
          const r = await w.send(() => supabase.rpc("import_deals_batch", { p_rows: part.map((d) => ({ deal: d.row, contacts: d.contacts, products: d.products, employees: d.employees, events: d.events, notes: d.notes, allow_duplicate: state.dupMode === "import" })) }) as any);
          if (!r.error) {
            const bad = new Map<string, string>(((r.data?.errors ?? []) as any[]).map((e) => [String(e.id), String(e.error)]));
            const same = new Map<string, string>(((r.data?.matched ?? []) as any[]).map((m) => [String(m.id), String(m.existing)]));
            ((r.data?.dropped ?? []) as string[]).forEach((c) => dropped.add(c));
            if (same.size) note(`${same.size} deal${same.size === 1 ? " was" : "s were"} already in the CRM (same company, pipeline, title and day) and left as they were`);
            part.forEach((d) => {
              if (bad.has(d.row.id)) failed.push({ row: d.r.idx + rowOffset, reason: friendly(bad.get(d.row.id)!) });
              else if (same.has(d.row.id)) dealIdOf.set(d.r.idx, same.get(d.row.id)!);
              else done(d);
            });
            advance(part.length);
            continue;
          }
          // not installed (or refused as a whole — nothing of the call was saved): the deals are written without it
          rpcDeals = false;
        }
        /* without it: the deals 500 per request, then each kind of thing they carry 1,000 per request */
        const body = (d: DealWrite) => (dropped.size ? Object.fromEntries(Object.entries(d.row).filter(([k]) => !dropped.has(k))) : d.row);
        const saved: DealWrite[] = [];
        let r = await w.send(() => supabase.from("trackings").insert(part.map(body), { defaultToNull: false }) as any);
        for (let k = 0; r.error && k < DEAL_OPTIONAL.length; k++) {
          const col = missingColumn(errText(r.error)) ? namedColumn(errText(r.error), DEAL_OPTIONAL.filter((c) => !dropped.has(c))) : undefined;
          if (!col) break;
          dropped.add(col);
          r = await w.send(() => supabase.from("trackings").insert(part.map(body), { defaultToNull: false }) as any);
        }
        if (!r.error) saved.push(...part);
        else {
          // the database refused the batch: one by one, to find the bad rows
          await pool(part, 6, async (d) => {
            let x = await w.send(() => supabase.from("trackings").insert(body(d)) as any);
            for (let k = 0; x.error && k < DEAL_OPTIONAL.length; k++) {
              const col = missingColumn(errText(x.error)) ? namedColumn(errText(x.error), DEAL_OPTIONAL.filter((c) => !dropped.has(c))) : undefined;
              if (!col) break;
              dropped.add(col);
              x = await w.send(() => supabase.from("trackings").insert(body(d)) as any);
            }
            if (!x.error || alreadyThere(x.error)) saved.push(d);
            else failed.push({ row: d.r.idx + rowOffset, reason: friendly(errText(x.error)) });
          });
        }
        // the title lives on the deal; if the database has no deal_name yet, keep it as a note
        if (dropped.has("deal_name")) saved.forEach((d) => { if (d.row.deal_name) d.notes = [{ phase_id: d.r.phaseId, body: [`Imported deal: ${d.row.deal_name}`, ...d.notes.map((n) => n.body)].join("\n\n") }]; });
        // what they carry is written even after Stop: a deal is never left half-saved
        const lost = new Map<string, string[]>();
        await Promise.all(childTables.map(async ([k, table]) => {
          const strip = (row: Record<string, any>) => (noPartner && table === "tracking_products" ? Object.fromEntries(Object.entries(row).filter(([c]) => !PARTNER_COLS.includes(c))) : row);
          for (const raw of chunk(saved.flatMap((d) => d[k].map((x) => ({ tracking_id: d.row.id, ...x }))), 1000)) {
            let part2 = raw.map(strip);
            let x = await w.send(() => supabase.from(table).insert(part2) as any, true);
            if (x.error && table === "tracking_products" && !noPartner && /partner_/i.test(errText(x.error)) && missingColumn(errText(x.error))) {
              noPartner = true;
              note("Partners weren't saved: run 12_proposals_partners.sql in Supabase, then set them on the deals.");
              part2 = raw.map(strip);
              x = await w.send(() => supabase.from(table).insert(part2) as any, true);
            }
            if (x.error) await pool(part2, 6, async (row) => {
              const y = await w.send(() => supabase.from(table).insert(row) as any, true);
              if (y.error && !/duplicate|unique|23505/i.test(`${y.error.code ?? ""} ${errText(y.error)}`)) lost.set(row.tracking_id, [...(lost.get(row.tracking_id) ?? []), `${label[table]} (${friendly(errText(y.error))})`]);
            });
          }
        }));
        saved.forEach((d) => {
          done(d);
          const l = lost.get(d.row.id);
          if (l) failed.push({ row: d.r.idx + rowOffset, reason: `Deal created, but ${l.join(", ")} couldn't be saved` });
        });
        advance(part.length);
      }
      if (dropped.size) note(`Your database doesn't have ${[...dropped].join(", ")} on deals yet — those values weren't saved.`);
    }

    /* 7) deals already in the CRM, updated with the file's data (only what the file maps) */
    if (upd.length) {
      const mapped = new Set(Object.values(state.mapping).filter(Boolean));
      const has = (t: string) => mapped.has(t);
      const phaseMapped = has("deal.phase") || has("deal.status") || [...mapped].some(isPhaseAt);
      const byId = new Map(ctx.trackings.map((t) => [t.id, t]));
      const items: { id: string; set: Record<string, any>; r: PlanRow }[] = [];
      for (const r of upd) {
        const cur0: any = byId.get(r.dupOf!) ?? {};
        const product = r.productId ? products.get(r.productId) : null;
        const price = r.value ?? product?.tiers?.[0]?.price ?? null;
        const cust = resolveCustom(r.custom);
        const set: Record<string, any> = {
          ...(phaseMapped && r.phaseId ? { current_phase_id: r.phaseId, status: r.dealStatus } : {}),
          ...(has("deal.product") && r.productId ? { product_id: r.productId } : {}),
          ...((has("deal.value") || has("deal.product")) && price != null ? { product_price: price } : {}),
          ...(has("deal.probability") && r.probability != null ? { rep_close_prob: r.probability } : {}),
          ...(has("deal.expected_close") && r.expectedClose ? { rep_close_date: r.expectedClose } : {}),
          ...(has("deal.loss_reason") && r.lossReason ? { loss_reason: r.lossReason } : {}),
          ...(has("deal.loss_reason") && r.lossDetails ? { loss_details: r.lossDetails } : {}),
          ...(r.closedOn ? { close_date: r.closedOn } : {}),
          ...(r.title ? { deal_name: r.title.replace(/\s+/g, " ").trim().slice(0, 200) } : {}),
          ...(Object.keys(cust).length ? { custom: { ...(cur0.custom ?? {}), ...cust } } : {}),
        };
        if (Object.keys(set).length) items.push({ id: r.dupOf!, set, r });
        await tick();
      }
      begin("Updating deals already in the CRM", items.length);
      await w.updateMany("trackings", items, (i, err) => {
        if (err) failed.push({ row: items[i].r.idx + rowOffset, reason: `Deal not updated — ${err}` }); else res.updated++;
      }, advance);
    }

    /* 8) won with a close date → the company becomes a client */
    const clientRows = todo.filter((r) => r.becomesClient && dealIdOf.has(r.idx));
    const byCompany = new Map<string, PlanRow[]>();
    clientRows.forEach((r) => { const id = coId(r.companyRef); if (id) byCompany.set(id, [...(byCompany.get(id) ?? []), r]); });
    if (byCompany.size) {
      begin("Creating clients", byCompany.size);
      // Existing clients: same company, else same name (legal forms ignored) or same VAT — never a duplicate.
      await w.gate();
      const known = await loadClientIndex();
      const fileCoById = new Map<string, CompanyName>();
      plan.companies.forEach((c) => { const id = coId(c.ref); if (id && !fileCoById.has(id)) fileCoById.set(id, c); });
      const ctsByCo = new Map<string, any[]>();
      ctx.contacts.forEach((c) => c.companyIds.forEach((id) => { if (byCompany.has(id)) ctsByCo.set(id, [...(ctsByCo.get(id) ?? []), c]); }));
      plan.newContacts.forEach((c) => { const id = coId(c.companyRef); if (id && byCompany.has(id) && ctIds.has(c.key)) ctsByCo.set(id, [...(ctsByCo.get(id) ?? []), { ...c, id: ctIds.get(c.key) }]); });
      for (const [companyId, dRows] of byCompany) {
        await w.gate();
        const crm = crmCo.get(companyId);
        const fileCo = fileCoById.get(companyId);
        const pick = (col: (typeof COMPANY_COLS)[number]) => ((crm as any)?.[col] || fileCo?.data[col] || "") as string;
        const same = matchClient(known, { companyId, name: crm?.name ?? fileCo?.name ?? null, vat: pick("vat_number") || null });
        if (same) {
          await adoptClient(same, { companyId, legal_name: pick("legal_name") || null, vat_number: pick("vat_number") || null }).catch(() => {});
          if (!same.company_id) same.company_id = companyId;
          advance(1); continue;
        }
        const cts = ctsByCo.get(companyId) ?? [];
        const clientRow = {
          name: crm?.name ?? fileCo?.name ?? "Client", legal_name: pick("legal_name") || null, vat_number: pick("vat_number") || null,
          address: { street: pick("street"), number: pick("addr_number"), details: pick("addr_details"), postalCode: pick("postal_code"), city: pick("city"), country: pick("country") },
          contacts: cts.map((c: any) => ({ id: newId(), sourceId: c.id ?? null, name: [c.first_name, c.last_name].filter(Boolean).join(" "), position: c.position ?? "", email: c.email ?? "", phone: c.phone ?? "", billing: !!c.is_billing })),
          company_id: companyId,
        };
        const r = await w.send(() => supabase.from("clients").insert(clientRow).select("id").single() as any);
        if (r.error || !r.data?.id) { failed.push({ row: dRows[0].idx + rowOffset, reason: `Client “${clientRow.name}”: ${r.error ? errText(r.error) : "couldn't be created"}` }); advance(1); continue; }
        known.push({ id: r.data.id, name: clientRow.name, company_id: companyId, vat_number: clientRow.vat_number } as any);
        res.clientsCreated++;
        // the products of its won deals, signed on the close date
        for (const d of dRows) {
          const product = d.productId ? products.get(d.productId) : null;
          if (!product) continue;
          await saveClientProducts(r.data.id, dealIdOf.get(d.idx)!, [{
            productId: product.id!, price: d.value ?? product.tiers?.[0]?.price ?? 0, quantity: 1,
            recurring: product.billing === "recurring", period: product.billing === "recurring" ? product.billing_period ?? "yearly" : null,
            termYears: null, discountMode: null, discountValue: null, signingDate: d.closedOn!,
          }]).catch(() => null);
        }
        advance(1);
      }
    }
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    res.cancelled = true;
  } finally {
    await finishBatch(batchId, res.created).catch(() => {});
    await finishBatch(coBatchId, res.coCreated, res.coUpdated).catch(() => {});
    await finishBatch(ctBatchId, res.ctCreated, res.ctUpdated).catch(() => {});
  }
  plan.rows.filter((r) => r.status === "error").forEach((r) => failed.push({ row: r.idx + rowOffset, reason: r.reason ?? "Error" }));
  failed.sort((a, b) => a.row - b.row);
  return res;
}
