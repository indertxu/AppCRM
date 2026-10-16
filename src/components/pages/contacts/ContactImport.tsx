/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Contacts → Actions → Import (and Companies → Import, companies first).
 *
 * As powerful as the deals importer, and built on the same pieces:
 *   - two files (contacts, companies); any column of either can go to any
 *     contact or company field, your custom fields of both, or a new field
 *   - automatic mapping by header (ES / EN / NL / DE) and by what the values
 *     look like; your custom fields recognised by name, similar names offered
 *   - columns nothing matches get a suggested new custom field — contact or
 *     company, with its type and options — one click, or all at once
 *   - choice-list, language and country values matched one by one
 *   - companies found by VAT, name, legal name, website or the contacts' email
 *     domain — even spelled differently; the doubtful ones are suggested
 *   - contacts found by email, phone or name
 *   - records already in the CRM: fill empty fields, replace with the file's
 *     data, or keep them — with a field-by-field preview
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { createPortal } from "react-dom";
import SalesMultiFilter from "../sales/sales/SalesMultiFilter";
import { useBackToClose } from "../../framework/useBackToClose";
import { readSpreadsheet, colLetter, cellText, normHeader, parseNumber, parseDate, parseBool, type SheetCell, type Workbook } from "../../framework/spreadsheetImport";
import { supabase } from "../../api/supabase";
import {
  saveContact, saveCompany, listCompanies, listContacts,
  listContactFields, listCompanyFields, addContactField, addCompanyField, updateContactField, updateCompanyField,
  type Contact, type Company, type ContactField, type CompanyField,
} from "../companies/companiesApi";
import { startImportBatch, finishImportBatch } from "./importBatches";
import { PROFILE_FIELDS, isRequired, matchCountry, matchLanguage, normalizeLinkedIn, isLinkedIn, languageOptions, countryOptions } from "./contactProfile";
import { TargetPicker, NewFieldEditor, ExistingChoice, DiffNote, SheetViewer, FailReport, type TOpt } from "../sales/extras/DealImport";
import {
  EMAIL_RE, nameKey, vatKey, domainKey, companySimilarity, closestCompany, diffRecord, patchFor, guessType, distinctValues, asDate,
  type ExistingMode, type RecordDiff, type NewField, type FieldType, type Column, type CompanyFoundBy, type ContactFoundBy,
} from "../sales/extras/dealImportEngine";
import "./ContactImport.css";

/* ═══════════════════════════ targets ═══════════════════════════ */

type Ent = "contact" | "company";
const ENT: Record<Ent, string> = { contact: "Contact", company: "Company" };
const TYPE_LABEL: Record<FieldType, string> = { text: "Text", number: "Number", date: "Date", boolean: "Yes / No", select: "Choice list" };

interface Base { key: string; label: string; group: Ent; hint?: string }
const BASE: Base[] = [
  { key: "contact.full_name", label: "Full name", group: "contact", hint: "Split into first and last name" },
  { key: "contact.first_name", label: "First name", group: "contact" },
  { key: "contact.last_name", label: "Last name", group: "contact" },
  { key: "contact.email", label: "Email", group: "contact", hint: "The surest way to find a contact" },
  { key: "contact.phone", label: "Phone", group: "contact" },
  { key: "contact.position", label: "Position / job title", group: "contact" },
  { key: "contact.street", label: "Street", group: "contact" },
  { key: "contact.addr_number", label: "Street number", group: "contact" },
  { key: "contact.postal_code", label: "Postal code", group: "contact" },
  { key: "contact.city", label: "City", group: "contact" },
  { key: "contact.country", label: "Country", group: "contact", hint: "Each value matched to the country list" },
  { key: "contact.language", label: "Language", group: "contact", hint: "Each value matched to the language list" },
  { key: "contact.linkedin", label: "LinkedIn", group: "contact" },
  { key: "contact.is_billing", label: "Billing contact (yes / no)", group: "contact" },
  { key: "contact.notes", label: "Notes", group: "contact" },
  { key: "company.name", label: "Company name", group: "company", hint: "Found in your companies, or created" },
  { key: "company.legal_name", label: "Legal name", group: "company" },
  { key: "company.vat_number", label: "VAT / tax ID", group: "company", hint: "The surest way to find the company" },
  { key: "company.reg_number", label: "Registration number", group: "company" },
  { key: "company.website", label: "Website", group: "company", hint: "Also finds the company by its domain" },
  { key: "company.phone", label: "Phone", group: "company" },
  { key: "company.email", label: "Email", group: "company" },
  { key: "company.street", label: "Street", group: "company" },
  { key: "company.addr_number", label: "Street number", group: "company" },
  { key: "company.addr_details", label: "Address details", group: "company" },
  { key: "company.postal_code", label: "Postal code", group: "company" },
  { key: "company.city", label: "City", group: "company" },
  { key: "company.province", label: "Province / state", group: "company" },
  { key: "company.country", label: "Country", group: "company" },
  { key: "company.notes", label: "Notes", group: "company" },
];
const TARGETS = BASE.map((b) => b.key);
/** Company columns saved from the file (the name is handled on its own). */
const CO_DATA = ["legal_name", "vat_number", "reg_number", "website", "phone", "email", "notes", "street", "addr_number", "addr_details", "postal_code", "city", "province", "country"] as const;
type CoCol = (typeof CO_DATA)[number];
type ProfCol = "street" | "addr_number" | "postal_code" | "city" | "country" | "language" | "linkedin";
const PROF: ProfCol[] = ["street", "addr_number", "postal_code", "city", "country", "language", "linkedin"];
/** Targets more than one column may feed (joined). */
const MULTI_OK = new Set(["contact.notes", "company.notes"]);
/** Built-in targets whose values are matched one by one to a list. */
const VALUE_BUILTIN = new Set(["contact.language", "contact.country"]);
const WHO_CT = ["contact.full_name", "contact.first_name", "contact.email"];
const WHO_CO = ["company.name", "company.legal_name", "company.vat_number", "company.website"];

const RAW_SYN: Record<string, string[]> = {
  "contact.full_name": ["name", "full name", "fullname", "contact", "contact name", "contact person", "nombre completo", "nombre y apellidos", "contacto", "persona de contacto", "nombre contacto", "nombre del contacto", "persona", "person", "contactpersoon", "ansprechpartner", "primary contact", "naam"],
  "contact.first_name": ["first name", "firstname", "given name", "nombre", "nombre de pila", "voornaam", "vorname", "prenom", "contact first name"],
  "contact.last_name": ["last name", "lastname", "surname", "family name", "apellido", "apellidos", "achternaam", "nachname", "contact last name"],
  "contact.email": ["email", "e mail", "mail", "email address", "correo", "correo electronico", "contact email", "email contacto", "email del contacto", "work email"],
  "contact.phone": ["phone", "telephone", "tel", "telefono", "mobile", "movil", "cell", "phone number", "whatsapp", "telefono movil", "mobile phone", "contact phone", "telefono contacto", "telefoon", "mobiel"],
  "contact.position": ["position", "job title", "title", "job", "role", "cargo", "puesto", "rol", "funcion", "functie", "job position", "position title"],
  "contact.street": ["street", "address", "address line 1", "street address", "direccion", "direccion postal", "calle", "domicilio", "adres", "straat"],
  "contact.addr_number": ["number", "numero", "street number", "num", "house number", "huisnummer", "numero calle"],
  "contact.postal_code": ["postal code", "postcode", "post code", "zip", "zip code", "codigo postal", "cp", "c p"],
  "contact.city": ["city", "ciudad", "town", "localidad", "poblacion", "municipio", "plaats", "stad"],
  "contact.country": ["country", "pais", "nation", "land", "country code"],
  "contact.language": ["language", "languages", "idioma", "idiomas", "lengua", "lang", "preferred language", "idioma preferido", "taal", "sprache"],
  "contact.linkedin": ["linkedin", "linked in", "linkedin url", "linkedin profile", "perfil linkedin", "perfil de linkedin", "url linkedin"],
  "contact.is_billing": ["billing contact", "contacto de facturacion", "contacto facturacion", "invoice contact", "is billing", "facturacion"],
  "contact.notes": ["notes", "note", "notas", "nota", "comments", "comentarios", "observaciones", "description", "descripcion"],
  "company.name": ["name", "nombre", "company", "company name", "empresa", "nombre empresa", "nombre de la empresa", "compania", "organization", "organisation", "organizacion", "account", "account name", "cliente", "client", "customer", "bedrijf", "bedrijfsnaam", "firma", "unternehmen", "organization name", "nombre comercial", "brand", "marca"],
  "company.legal_name": ["legal name", "razon social", "nombre fiscal", "denominacion social", "company legal name", "nombre legal", "statutaire naam"],
  "company.vat_number": ["vat", "vat number", "cif", "nif", "cif nif", "nif cif", "tax id", "btw", "btw nummer", "company vat", "vat id", "ust id", "numero fiscal", "tax number"],
  "company.reg_number": ["registration number", "reg number", "company number", "kvk", "kvk nummer", "numero de registro", "registro mercantil", "handelsregister", "chamber of commerce"],
  "company.website": ["website", "web", "url", "domain", "company website", "sitio web", "pagina web", "company domain", "dominio", "web empresa"],
  "company.phone": ["phone", "telephone", "tel", "telefono", "centralita", "main phone", "office phone"],
  "company.email": ["email", "e mail", "mail", "correo", "correo electronico", "general email", "info email"],
  "company.street": ["street", "address", "address line 1", "street address", "direccion", "calle", "domicilio", "domicilio social", "adres", "straat"],
  "company.addr_number": ["number", "numero", "street number", "num", "house number", "huisnummer", "numero calle"],
  "company.addr_details": ["address line 2", "address 2", "address details", "piso", "puerta", "piso puerta", "planta", "floor", "suite", "toevoeging"],
  "company.postal_code": ["postal code", "postcode", "post code", "zip", "zip code", "codigo postal", "cp", "c p"],
  "company.city": ["city", "ciudad", "town", "localidad", "poblacion", "municipio", "plaats", "stad"],
  "company.province": ["province", "provincia", "state", "region", "comunidad", "comunidad autonoma", "county", "state province"],
  "company.country": ["country", "pais", "nation", "land", "country code"],
  "company.notes": ["notes", "note", "notas", "comments", "comentarios", "observaciones", "description", "descripcion"],
};
/** "Company city", "Ciudad empresa", "Mailing city"… say whose field it is. */
const SHARED = new Set(["email", "phone", "street", "addr_number", "postal_code", "city", "country", "notes"]);
const SIDE: Record<Ent, { pre: string[]; post: string[] }> = {
  contact: { pre: ["contact", "contacto", "mailing", "personal"], post: ["contact", "contacto", "del contacto", "personal"] },
  company: { pre: ["company", "empresa", "organization", "account", "billing"], post: ["company", "empresa", "de la empresa", "organization", "account"] },
};
const SYN: Record<string, string[]> = Object.fromEntries(Object.entries(RAW_SYN).map(([k, list]) => {
  const [e, col] = k.split(".") as [Ent, string];
  const extra = SHARED.has(col) ? list.flatMap((s) => [...SIDE[e].pre.map((p) => `${p} ${s}`), ...SIDE[e].post.map((p) => `${s} ${p}`)]) : [];
  return [k, [...new Set([...list, ...extra])]];
}));
/** Words that only say whose field it is — never enough on their own inside a longer header. */
const MARKERS = new Set(["name", "nombre", "company", "empresa", "contact", "contacto", "cliente", "client", "customer", "account", "persona", "person", "naam", "firma"]);
const ID_RE = /^(id|no|n|num|numero|ref|record id|uuid|guid)( |$)|( |^)(id|uuid|guid)$/;
const URL_RE = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;

function guessTarget(file: Ent, header: string, samples: SheetCell[]): string | null {
  const h = normHeader(header);
  if (!h || ID_RE.test(h)) return null;
  const mine = (k: string) => k.startsWith(`${file}.`);
  const exact = TARGETS.filter((k) => SYN[k]?.includes(h));
  if (exact.length) return exact.find(mine) ?? exact[0];
  const vals = samples.map((v) => cellText(v).trim()).filter(Boolean);
  const all = (re: RegExp) => vals.length > 0 && vals.every((v) => re.test(v));
  // what the values look like beats a word in the header
  if (all(EMAIL_RE)) return /empresa|company|organi[sz]ation|general|info|account/.test(h) ? "company.email" : /contact|persona|person/.test(h) ? "contact.email" : `${file}.email`;
  if (all(/linkedin\.com\/(in|pub)\//i)) return "contact.linkedin";
  if (all(URL_RE) && !vals.some((v) => /linkedin\.com/i.test(v))) return "company.website";
  // dates are never a name or an address ("Fecha alta empresa")
  if (vals.length && vals.filter((v) => asDate(v)).length >= vals.length * 0.6) return null;
  // the longest known phrase inside the header; on a tie, this file's side
  let best: { k: string; len: number } | null = null;
  for (const k of TARGETS) for (const syn of SYN[k] ?? []) {
    if (syn.length < 3 || MARKERS.has(syn) || !(` ${h} `).includes(` ${syn} `)) continue;
    if (!best || syn.length > best.len || (syn.length === best.len && mine(k) && !mine(best.k))) best = { k, len: syn.length };
  }
  if (best) return best.k;
  if (vals.length >= 2 && all(PHONE_RE) && vals.some((v) => /^\+|\s/.test(v))) return `${file}.phone`;
  return null;
}

/** "Contacto - Sector" → "sector": the part that names the field. */
const stripSide = (h: string) => h.replace(/^(contact|contacto|company|empresa|cliente|client|account|persona|person)\s+/, "").replace(/\s+(contact|contacto|company|empresa|de la empresa|del contacto)$/, "").trim();
const cleanLabel = (header: string) => {
  const s = header.replace(/^\s*(contact|contacto|company|empresa|cliente|client|account)\s*[-:·|_/]\s*/i, "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : header.trim();
};
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const pairs = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const A = pairs(a), B = pairs(b); let hit = 0;
  A.forEach((n, g) => { hit += Math.min(n, B.get(g) ?? 0); });
  return (2 * hit) / (a.length - 1 + b.length - 1);
}
/** 0…1: how alike a header and a field name are. */
function labelSim(a: string, b: string): number {
  const x = stripSide(normHeader(a)), y = stripSide(normHeader(b));
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tx = x.split(" "), ty = y.split(" ");
  const [s, l] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  const contained = s.join("").length >= 4 && s.every((w) => l.includes(w)) ? 0.8 : 0;
  return Math.max(dice(x.replace(/ /g, ""), y.replace(/ /g, "")), contained);
}
const COMPANYISH = /\b(empresa|company|compania|organi[sz]ation|organizacion|account|cuenta|sector|industr\w*|employees|empleados|plantilla|trabajadores|facturacion|revenue|turnover|ventas|cnae|sic|naics|fundacion|founded|ingresos|tamano|size|forma juridica|legal form|segment\w*|tier|vertical)\b/;
const CONTACTISH = /\b(contact|contacto|persona|person|cumpleanos|birthday|nacimiento|birth|genero|gender|sexo|hobby|hobbies|twitter|instagram|personal|dni|nie|pasaporte|passport|tratamiento|salutation|saludo)\b/;

/* ═══════════════════════════ state ═══════════════════════════ */

interface IState {
  /** per file: column → target */
  maps: Record<Ent, Record<number, string>>;
  newFields: NewField[];
  /** target → normalized file value → choice */
  valueMaps: Record<string, Record<string, string>>;
  /** file company key → "create" | "skip" | "crm:<id>" */
  companyChoice: Record<string, string>;
  /** contact key → "create" | "skip" | "crm:<id>" */
  contactChoice: Record<string, string>;
  /** contact key → "none" | "co:<file company key>" | "crm:<id>" (overrides what was found) */
  contactCompany: Record<string, string>;
  coExisting: ExistingMode;
  ctExisting: ExistingMode;
  createContacts: boolean;
  /** Companies only named in the contacts and not in the CRM get created. */
  createCompanies: boolean;
  linkContacts: boolean;
  nameFromEmail: boolean;
  companyFromDomain: boolean;
}
const emptyState = (): IState => ({
  maps: { contact: {}, company: {} }, newFields: [], valueMaps: {}, companyChoice: {}, contactChoice: {}, contactCompany: {},
  coExisting: "fill", ctExisting: "fill", createContacts: true, createCompanies: true, linkContacts: true, nameFromEmail: true, companyFromDomain: true,
});

interface Ctx { companies: Company[]; contacts: Contact[]; coFields: CompanyField[]; ctFields: ContactField[] }
interface Def { label: string; type: FieldType; options: string[]; required: boolean; entity: Ent }

function defOf(ctx: Ctx, st: Pick<IState, "newFields">, t: string): Def | null {
  const pick = (list: { id: string; label: string; type: FieldType; options: string[]; required?: boolean }[], id: string, entity: Ent) => {
    const f = list.find((x) => x.id === id);
    return f ? { label: f.label, type: f.type, options: f.options ?? [], required: !!f.required, entity } : null;
  };
  if (t.startsWith("ctcustom:")) return pick(ctx.ctFields, t.slice(9), "contact");
  if (t.startsWith("cocustom:")) return pick(ctx.coFields, t.slice(9), "company");
  if (t.startsWith("new:")) { const n = st.newFields.find((x) => x.tmp === t.slice(4)); return n ? { label: n.label, type: n.type, options: n.options, required: false, entity: n.entity as Ent } : null; }
  return null;
}
const hasValueStep = (ctx: Ctx, st: IState, t: string) => VALUE_BUILTIN.has(t) || defOf(ctx, st, t)?.type === "select";
function targetLabelOf(ctx: Ctx, st: IState, t: string): string {
  const b = BASE.find((x) => x.key === t);
  if (b) return `${ENT[b.group]} · ${b.label}`;
  const d = defOf(ctx, st, t);
  return d ? `${ENT[d.entity]} · ${d.label}` : t;
}

const optionMatch = (options: string[], raw: string) => {
  const n = normHeader(raw);
  return options.find((o) => normHeader(o) === n) ?? options.find((o) => { const k = normHeader(o); return k.length >= 3 && n.length >= 3 && (k.startsWith(n) || n.startsWith(k)); }) ?? null;
};
/** Where a file value of a value target goes: picked by hand, matched automatically, or the fallback. */
function choiceFor(ctx: Ctx, st: IState, target: string, raw: string): { choice: string; auto: boolean; matched: boolean } {
  const def = defOf(ctx, st, target);
  const picked = st.valueMaps[target]?.[normHeader(raw)];
  if (picked && (picked.startsWith("__") || def?.type !== "select" || def.options.includes(picked))) return { choice: picked, auto: false, matched: true };
  const auto = target === "contact.language" ? matchLanguage(raw) : target === "contact.country" ? matchCountry(raw) : def?.type === "select" ? optionMatch(def.options, raw) : null;
  if (auto) return { choice: auto, auto: true, matched: true };
  return { choice: target === "contact.language" ? "__empty" : target === "contact.country" ? "__keep" : "__new", auto: true, matched: false };
}

/* ═══════════════════════════ the plan ═══════════════════════════ */

interface FileData { entity: Ent; columns: Column[]; rows: SheetCell[][]; offset: number }
interface RowRef { file: Ent; idx: number }
interface Parsed { file: Ent; idx: number; get: Record<string, string[]>; cells: Record<string, SheetCell>; coCustom: Record<string, any>; ctCustom: Record<string, any>; issues: string[] }
interface CoEntry {
  key: string; name: string; nameIsFallback: boolean;
  data: Partial<Record<CoCol, string>>; custom: Record<string, any>;
  /** Rows of the companies file it comes from. */
  fileRows: number[];
  /** Contacts that name it. */
  contacts: number;
  found: string | null; foundBy?: CompanyFoundBy; score?: number;
  suggest?: { id: string; name: string; score: number; why: string } | null;
  ref: string | null; used: boolean; diff: RecordDiff | null; issues: string[];
}
interface CtEntry {
  key: string; first_name: string; last_name: string | null; email: string | null; phone: string | null; position: string | null;
  notes: string | null; is_billing: boolean | null; profile: Partial<Record<ProfCol, string>>; custom: Record<string, any>;
  rows: RowRef[]; coKeys: string[]; domainCo: string | null;
  found: string | null; foundBy?: ContactFoundBy; ref: string | null;
  /** Its companies ("crm:" / "new:"), and the ones it isn't linked to yet. */
  coRefs: string[]; newLinks: string[];
  status: "new" | "found" | "skip" | "error"; reason?: string; issues: string[];
  /** Required address fields it would still miss. */
  incomplete: string[];
  diff: RecordDiff | null;
}
interface Orphan { file: Ent; idx: number; reason: string }
interface Counts {
  ctNew: number; ctFound: number; ctSkip: number; ctError: number; ctWarn: number; ctNoCompany: number; ctIncomplete: number; ctLink: number;
  coNew: number; coFound: number; coCheck: number; coSkip: number; orphans: number;
  coExisting: number; coFill: number; coChange: number; ctExisting: number; ctFill: number; ctChange: number;
}
interface Plan { companies: CoEntry[]; contacts: CtEntry[]; orphans: Orphan[]; counts: Counts }

const personKey = (s: string | null | undefined) => normHeader(s ?? "");
const phoneKey = (s: string | null | undefined) => { const d = (s ?? "").replace(/\D/g, ""); return d.length >= 7 ? d.slice(-9) : ""; };
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const domainLabel = (w: string) => cap(w.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].split(".")[0] ?? "");
const numText = (c: SheetCell | undefined, txt: string) => (typeof c === "number" ? String(Math.round(c)) : txt);
const blank = (v: any, type?: FieldType) => v == null || v === "" || (type === "boolean" && v === false);
const fullName = (c: { first_name?: string | null; last_name?: string | null }) => [c.first_name, c.last_name].filter(Boolean).join(" ");
/** A file contact's own fields, as the contacts table names them. */
const contactFile = (c: CtEntry): Record<string, any> => ({ last_name: c.last_name, email: c.email, phone: c.phone, position: c.position, notes: c.notes, ...(c.is_billing ? { is_billing: true } : {}), ...c.profile });
/** "ctcustom:<id>" → "<id>"; new fields keep their "new:" key until they exist. */
const planCustom = (c: Record<string, any>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k.startsWith("new:") ? k : k.slice(k.indexOf(":") + 1), v]));

function parseRow(ctx: Ctx, st: IState, file: Ent, r: SheetCell[], idx: number): Parsed {
  const p: Parsed = { file, idx, get: {}, cells: {}, coCustom: {}, ctCustom: {}, issues: [] };
  for (const [colS, t] of Object.entries(st.maps[file])) {
    if (!t) continue;
    const cell = r[+colS] ?? null;
    if (cell == null || cell === "") continue;
    const txt = cellText(cell).trim();
    if (!txt) continue;
    if (t === "contact.language" || t === "contact.country") {
      const ch = choiceFor(ctx, st, t, txt);
      const v = ch.choice === "__keep" ? txt : ch.choice === "__empty" ? null : ch.choice;
      if (!ch.matched) p.issues.push(t === "contact.language" ? `Language “${txt}” not recognised — left empty` : `Country “${txt}” not recognised — kept as written`);
      if (v) (p.get[t] ??= []).push(v);
      continue;
    }
    const def = defOf(ctx, st, t);
    if (def) {
      const bucket = def.entity === "company" ? p.coCustom : p.ctCustom;
      if (def.type === "number") { const n = parseNumber(cell); if (n != null) bucket[t] = n; else p.issues.push(`${def.label}: “${txt}” isn't a number`); }
      else if (def.type === "date") { const d = asDate(cell) ?? parseDate(cell); if (d) bucket[t] = d; else p.issues.push(`${def.label}: “${txt}” isn't a date`); }
      else if (def.type === "boolean") { const b = parseBool(cell); if (b != null) bucket[t] = b; else p.issues.push(`${def.label}: “${txt}” isn't yes/no`); }
      else if (def.type === "select") { const ch = choiceFor(ctx, st, t, txt).choice; if (ch === "__new") bucket[t] = def.options.find((o) => normHeader(o) === normHeader(txt)) ?? txt; else if (ch !== "__empty") bucket[t] = ch; }
      else bucket[t] = txt;
      continue;
    }
    (p.get[t] ??= []).push(txt);
    if (!(t in p.cells)) p.cells[t] = cell;
  }
  return p;
}

function buildPlan(ctx: Ctx, files: FileData[], st: IState): Plan {
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
    const k = personKey(fullName(c)); if (k) ctByName.set(k, [...(ctByName.get(k) ?? []), c]);
    const ph = phoneKey(c.phone); if (ph) ctByPhone.set(ph, [...(ctByPhone.get(ph) ?? []), c]);
  });
  const crmCo = new Map(ctx.companies.map((c) => [c.id as string, c]));
  const crmCt = new Map(ctx.contacts.map((c) => [c.id as string, c]));

  /* ---- 1) read every row of both files ---- */
  const parsed = files.flatMap((f) => f.rows.map((r, idx) => parseRow(ctx, st, f.entity, r, idx)));
  const one = (p: Parsed, k: string) => p.get[k]?.[0] ?? null;

  /* ---- 2) the companies in the files ---- */
  const companies = new Map<string, CoEntry>();
  const keyByVat = new Map<string, string>(), keyByName = new Map<string, string>();
  const mailDomains = new Map<string, Set<string>>();
  const orphans: Orphan[] = [];
  const rowCoKeys = parsed.map((p) => {
    const data: Partial<Record<CoCol, string>> = {};
    for (const col of CO_DATA) {
      const k = `company.${col}`;
      if (!p.get[k]) continue;
      let v = col === "notes" ? p.get[k].join("\n") : ["phone", "postal_code", "addr_number"].includes(col) ? numText(p.cells[k], p.get[k][0]) : p.get[k][0];
      if (col === "vat_number") v = v.toUpperCase().replace(/[\s.\-/]/g, "");
      if (col === "email") { v = v.toLowerCase(); if (!EMAIL_RE.test(v)) { p.issues.push(`Company email “${v}” isn't valid`); continue; } }
      data[col] = v;
    }
    if (data.postal_code && /^\d{4}$/.test(data.postal_code) && matchCountry(data.country) === "ES") data.postal_code = `0${data.postal_code}`;
    const named = (p.get["company.name"] ?? []).flatMap((t) => t.split(/[;|\n]/)).map((x) => x.trim()).filter(Boolean);
    let names = [...new Map(named.map((n) => [nameKey(n) || n, n])).values()];
    const fallback = !names.length;
    if (fallback) { const alt = data.legal_name || data.vat_number || (data.website ? domainLabel(data.website) : ""); if (alt) names = [alt]; }
    const keys: string[] = [];
    names.forEach((name, i) => {
      const first = i === 0;
      const vk = first ? vatKey(data.vat_number) : "", nk = nameKey(name), lk = first ? nameKey(data.legal_name) : "";
      const key = (vk && keyByVat.get(vk)) || (nk && keyByName.get(nk)) || (lk && keyByName.get(lk)) || nk || lk || `vat:${vk}`;
      if (vk && !keyByVat.has(vk)) keyByVat.set(vk, key);
      if (nk && !keyByName.has(nk)) keyByName.set(nk, key);
      if (lk && !keyByName.has(lk)) keyByName.set(lk, key);
      const e: CoEntry = companies.get(key) ?? { key, name, nameIsFallback: fallback, data: {}, custom: {}, fileRows: [], contacts: 0, found: null, ref: null, used: false, diff: null, issues: [] };
      if (e.nameIsFallback && !fallback) { e.name = name; e.nameIsFallback = false; }
      if (first) {
        for (const [k, v] of Object.entries(data)) if (v && !(e.data as any)[k]) (e.data as any)[k] = v;
        for (const [k, v] of Object.entries(p.coCustom)) if (!(k in e.custom)) e.custom[k] = v;
        if (p.file === "company") e.fileRows.push(p.idx);
      }
      companies.set(key, e);
      keys.push(key);
    });
    const d = domainKey(one(p, "contact.email"));
    if (keys[0] && d) { const s = mailDomains.get(keys[0]) ?? new Set<string>(); s.add(d); mailDomains.set(keys[0], s); }
    return keys;
  });

  /* ---- 3) companies vs the CRM ---- */
  companies.forEach((e) => {
    const vk = vatKey(e.data.vat_number);
    let hit: Company | undefined, by: CompanyFoundBy | undefined, score: number | undefined;
    if (vk && coByVat.get(vk)) { hit = coByVat.get(vk); by = "vat"; }
    else if (nameKey(e.name) && coByName.get(nameKey(e.name))) { hit = coByName.get(nameKey(e.name)); by = "name"; }
    else if (e.data.legal_name && coByName.get(nameKey(e.data.legal_name))) { hit = coByName.get(nameKey(e.data.legal_name)); by = "legal"; }
    else {
      const dHit = [domainKey(e.data.website), domainKey(e.data.email)].filter(Boolean).map((d) => coByDomain.get(d!)).find(Boolean);
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
    if (hit) { e.found = `crm:${hit.id}`; e.foundBy = by; e.score = score; }
    else if (!e.suggest && best && best.s >= 0.72) e.suggest = { id: best.c.id!, name: best.c.name, score: best.s, why: `${Math.round(best.s * 100)}% alike` };
    const ch = st.companyChoice[e.key];
    e.ref = ch === "skip" ? null : ch?.startsWith("crm:") ? ch : ch === "create" ? `new:${e.key}` : e.found ?? (e.fileRows.length || st.createCompanies ? `new:${e.key}` : null);
  });

  /* ---- 4) the contacts in the files ---- */
  const contacts = new Map<string, CtEntry>();
  parsed.forEach((p, i) => {
    const keys = rowCoKeys[i];
    let first = one(p, "contact.first_name"), last = one(p, "contact.last_name");
    const full = one(p, "contact.full_name");
    if (full && !first) {
      // "García, Ana" → Ana García
      const f = full.includes(",") ? full.split(",").map((x) => x.trim()).reverse().join(" ") : full;
      const parts = f.split(/\s+/); first = parts[0]; if (!last && parts.length > 1) last = parts.slice(1).join(" ");
    }
    const rawEmail = (one(p, "contact.email") ?? "").toLowerCase() || null;
    const email = rawEmail && EMAIL_RE.test(rawEmail) ? rawEmail : null;
    if (rawEmail && !email) p.issues.push(`“${rawEmail}” isn't a valid email`);
    if (!first && email && st.nameFromEmail) {
      const local = email.split("@")[0].split(/[._-]+/).filter(Boolean);
      if (local[0]) { first = cap(local[0]); if (!last && local.length > 1) last = local.slice(1).map(cap).join(" "); }
    }
    if (!first && !email) {
      const hasContact = Object.keys(p.get).some((k) => k.startsWith("contact.")) || Object.keys(p.ctCustom).length > 0;
      if (keys.length) {
        const co = companies.get(keys[0])!;
        if (hasContact) p.issues.push("A contact without a name or email was left out");
        co.issues.push(...p.issues);
      } else orphans.push({ file: p.file, idx: p.idx, reason: p.file === "company" ? "No company name" : hasContact ? "No name or email" : "Nothing to import in this row" });
      return;
    }
    const key = email ? `e:${email}` : `n:${personKey([first, last].filter(Boolean).join(" "))}|${keys[0] ?? ""}`;
    const e: CtEntry = contacts.get(key) ?? {
      key, first_name: first ?? "", last_name: last, email, phone: null, position: null, notes: null, is_billing: null, profile: {}, custom: {},
      rows: [], coKeys: [], domainCo: null, found: null, ref: null, coRefs: [], newLinks: [], status: "new", issues: [], incomplete: [], diff: null,
    };
    if (!e.first_name && first) e.first_name = first;
    if (!e.last_name && last) e.last_name = last;
    const phone = p.get["contact.phone"] ? numText(p.cells["contact.phone"], p.get["contact.phone"][0]) : null;
    if (!e.phone && phone) e.phone = phone;
    if (!e.position) e.position = one(p, "contact.position");
    const notes = p.get["contact.notes"]?.join("\n");
    if (notes) e.notes = e.notes ? `${e.notes}\n${notes}` : notes;
    const bill = one(p, "contact.is_billing");
    if (bill != null && e.is_billing == null) e.is_billing = parseBool(bill);
    for (const col of PROF) {
      const k = `contact.${col}`;
      if (!p.get[k] || e.profile[col]) continue;
      let v = col === "postal_code" || col === "addr_number" ? numText(p.cells[k], p.get[k][0]) : p.get[k][0];
      if (col === "linkedin") { const l = normalizeLinkedIn(v); if (!isLinkedIn(l)) { p.issues.push(`“${v}” isn't a LinkedIn link`); continue; } v = l; }
      e.profile[col] = v;
    }
    for (const [k, v] of Object.entries(p.ctCustom)) if (!(k in e.custom)) e.custom[k] = v;
    keys.forEach((k) => { if (!e.coKeys.includes(k)) { e.coKeys.push(k); companies.get(k)!.contacts++; } });
    e.rows.push({ file: p.file, idx: p.idx });
    e.issues.push(...p.issues);
    contacts.set(key, e);
  });

  /* ---- 5) contacts vs the CRM, their companies, what happens ---- */
  contacts.forEach((e) => {
    if (e.profile.postal_code && /^\d{4}$/.test(e.profile.postal_code) && e.profile.country === "ES") e.profile.postal_code = `0${e.profile.postal_code}`;
    if (!e.coKeys.length && st.companyFromDomain) { const d = domainKey(e.email); const hit = d ? coByDomain.get(d) : undefined; if (hit) e.domainCo = hit.id!; }
    const ov = st.contactCompany[e.key];
    const refs: (string | null)[] = ov === "none" ? [] : ov?.startsWith("co:") ? [companies.get(ov.slice(3))?.ref ?? null] : ov?.startsWith("crm:") ? [ov]
      : e.coKeys.length ? e.coKeys.map((k) => companies.get(k)?.ref ?? null) : e.domainCo ? [`crm:${e.domainCo}`] : [];
    e.coRefs = [...new Set(refs.filter((x): x is string => !!x))];

    const coId = e.coRefs.find((r) => r.startsWith("crm:"))?.slice(4) ?? null;
    const nameK = personKey(fullName(e));
    let hit: Contact | undefined, by: ContactFoundBy | undefined;
    if (e.email && ctByEmail.get(e.email)) { hit = ctByEmail.get(e.email); by = "email"; }
    if (!hit && phoneKey(e.phone)) {
      const same = (ctByPhone.get(phoneKey(e.phone)) ?? []).filter((c) => !nameK || personKey(fullName(c)).split(" ")[0] === nameK.split(" ")[0]);
      if (same.length === 1) { hit = same[0]; by = "phone"; }
    }
    if (!hit && nameK) {
      const same = ctByName.get(nameK) ?? [];
      // the same name at the same company, or the only one with that name
      hit = (coId ? same.find((c) => c.companyIds.includes(coId)) : undefined) ?? (same.length === 1 && !e.email && (!coId || !same[0].companyIds.length) ? same[0] : undefined);
      if (hit) by = "name";
    }
    if (hit) { e.found = `crm:${hit.id}`; e.foundBy = by; }
    const ch = st.contactChoice[e.key];
    e.ref = ch === "skip" ? null : ch?.startsWith("crm:") ? ch : ch === "create" ? `new:${e.key}` : e.found ?? (st.createContacts ? `new:${e.key}` : null);
    const crm = e.ref?.startsWith("crm:") ? crmCt.get(e.ref.slice(4)) ?? null : null;

    if (!e.ref) { e.status = "skip"; e.reason = ch === "skip" ? "Left out" : "Not in the CRM — creating contacts is off"; }
    else if (crm) e.status = "found";
    else {
      e.status = "new";
      const miss = ctx.ctFields.filter((f) => f.required && blank(e.custom[`ctcustom:${f.id}`], f.type));
      if (!e.first_name) { e.status = "error"; e.reason = "No name"; }
      else if (miss.length) { e.status = "error"; e.reason = `Required field empty: ${miss.map((f) => f.label).join(", ")}`; }
    }
    e.newLinks = e.status === "new" ? e.coRefs : crm && st.linkContacts ? e.coRefs.filter((r) => !(r.startsWith("crm:") && crm.companyIds.includes(r.slice(4)))) : [];
    if (e.status === "new" || e.status === "found") {
      const fromFile = st.ctExisting === "keep" && crm ? {} : Object.fromEntries(Object.entries(e.profile).filter(([, v]) => v));
      const merged: Record<string, any> = { ...(crm ?? {}), ...fromFile };
      e.incomplete = PROFILE_FIELDS.filter((f) => f.required && !String(merged[f.key] ?? "").trim()).map((f) => f.label);
    }
    e.diff = crm ? diffRecord(crm, contactFile(e), planCustom(e.custom), fieldLabel(ctx, st, "contact")) : null;
    e.issues = [...new Set(e.issues)];
  });

  /* ---- 6) which companies are used, and what the file changes in the CRM ones ---- */
  const going = [...contacts.values()].filter((c) => c.status === "new" || c.status === "found");
  const refUsed = new Set(going.flatMap((c) => c.coRefs));
  companies.forEach((e) => {
    e.used = !!e.ref && (e.fileRows.length > 0 || refUsed.has(e.ref));
    const crm = e.ref?.startsWith("crm:") ? crmCo.get(e.ref.slice(4)) : null;
    e.diff = crm ? diffRecord(crm, { ...e.data }, planCustom(e.custom), fieldLabel(ctx, st, "company")) : null;
    e.issues = [...new Set(e.issues)];
  });

  const toCheck = (c: CoEntry) => c.used && (c.foundBy === "similar" && c.ref === c.found || (!!c.suggest && !!c.ref?.startsWith("new:")));
  const companyList = [...companies.values()].sort((a, b) => Number(toCheck(b)) - Number(toCheck(a)) || (a.found ? 1 : 0) - (b.found ? 1 : 0) || (b.contacts + b.fileRows.length) - (a.contacts + a.fileRows.length));
  const order = { error: 0, new: 1, found: 2, skip: 3 } as const;
  const contactList = [...contacts.values()].sort((a, b) => order[a.status] - order[b.status] || (a.rows[0]?.idx ?? 0) - (b.rows[0]?.idx ?? 0));
  const usedCo = companyList.filter((c) => c.used);
  const coCrm = usedCo.filter((c) => c.diff), ctCrm = going.filter((c) => c.diff);
  const sum = (xs: { diff: RecordDiff | null }[], k: "fill" | "change") => xs.reduce((n, x) => n + (x.diff?.[k].length ?? 0), 0);
  return {
    companies: companyList, contacts: contactList, orphans,
    counts: {
      ctNew: going.filter((c) => c.status === "new").length, ctFound: going.filter((c) => c.status === "found").length,
      ctSkip: contactList.filter((c) => c.status === "skip").length, ctError: contactList.filter((c) => c.status === "error").length,
      ctWarn: going.filter((c) => c.issues.length).length, ctNoCompany: going.filter((c) => !c.coRefs.length).length,
      ctIncomplete: going.filter((c) => c.incomplete.length).length, ctLink: going.filter((c) => c.status === "found" && c.newLinks.length).length,
      coNew: usedCo.filter((c) => c.ref?.startsWith("new:")).length, coFound: usedCo.filter((c) => c.ref?.startsWith("crm:")).length,
      coCheck: companyList.filter(toCheck).length, coSkip: companyList.filter((c) => !c.ref && c.fileRows.length).length, orphans: orphans.length,
      coExisting: coCrm.length, coFill: sum(coCrm, "fill"), coChange: sum(coCrm, "change"),
      ctExisting: ctCrm.length, ctFill: sum(ctCrm, "fill"), ctChange: sum(ctCrm, "change"),
    },
  };
}
function fieldLabel(ctx: Ctx, st: IState, entity: Ent) {
  return (k: string, isCustom: boolean) => {
    if (!isCustom) return BASE.find((b) => b.key === `${entity}.${k}`)?.label ?? k;
    if (k.startsWith("new:")) return st.newFields.find((n) => `new:${n.tmp}` === k)?.label ?? "New field";
    return ((entity === "company" ? ctx.coFields : ctx.ctFields) as { id: string; label: string }[]).find((f) => f.id === k)?.label ?? k;
  };
}

/* ═══════════════════════════ running it ═══════════════════════════ */

interface Result { ctCreated: number; ctUpdated: number; ctLinked: number; coCreated: number; coUpdated: number; newFields: number; failed: { row: number; reason: string }[] }

async function runImport(ctx: Ctx, st: IState, files: FileData[], plan: Plan, names: Record<Ent, string>, reportFile: Ent,
  onProgress: (p: { done: number; total: number; phase: string }) => void): Promise<Result> {
  const res: Result = { ctCreated: 0, ctUpdated: 0, ctLinked: 0, coCreated: 0, coUpdated: 0, newFields: 0, failed: [] };
  const offsetOf = (e: Ent) => files.find((f) => f.entity === e)?.offset ?? 2;
  const rowOf = (rows: RowRef[]) => { const r = rows.find((x) => x.file === reportFile); return r ? r.idx + offsetOf(reportFile) : 0; };

  /* 1) new fields, and new options on existing choice lists */
  const used = new Set(files.flatMap((f) => Object.values(st.maps[f.entity]).filter(Boolean)));
  const extraOptions = (t: string, base: string[]) => {
    const add: string[] = [];
    for (const f of files) for (const [colS, tt] of Object.entries(st.maps[f.entity])) {
      if (tt !== t) continue;
      f.columns.find((c) => c.i === +colS)?.values.forEach((v) => {
        const txt = cellText(v).trim();
        if (txt && choiceFor(ctx, st, t, txt).choice === "__new" && ![...base, ...add].some((o) => normHeader(o) === normHeader(txt))) add.push(txt);
      });
    }
    return add;
  };
  const tmpIds = new Map<string, string>();
  const usedNew = st.newFields.filter((n) => used.has(`new:${n.tmp}`));
  if (usedNew.length) {
    onProgress({ done: 0, total: usedNew.length, phase: "Creating fields…" });
    const sortBase = { contact: ctx.ctFields.length, company: ctx.coFields.length };
    for (const [k, n] of usedNew.entries()) {
      const entity = n.entity as Ent;
      const options = n.type === "select" ? [...n.options, ...extraOptions(`new:${n.tmp}`, n.options)] : [];
      const input = { label: n.label.trim(), type: n.type, required: false, options, sort: sortBase[entity] + k };
      try {
        const f = entity === "company" ? await addCompanyField(input) : await addContactField(input);
        if (f?.id) tmpIds.set(n.tmp, f.id);
      } catch { /* looked up below */ }
      if (tmpIds.has(n.tmp)) res.newFields++;
      onProgress({ done: k + 1, total: usedNew.length, phase: "Creating fields…" });
    }
    const missing = usedNew.filter((n) => !tmpIds.has(n.tmp));
    if (missing.length) {
      const [fc, ft] = await Promise.all([listCompanyFields().catch(() => [] as CompanyField[]), listContactFields().catch(() => [] as ContactField[])]);
      missing.forEach((n) => {
        const f = [...(n.entity === "company" ? fc : ft)].reverse().find((x) => normHeader(x.label) === normHeader(n.label));
        if (f) { tmpIds.set(n.tmp, f.id); res.newFields++; }
      });
    }
  }
  for (const t of used) {
    if (!/^(ctcustom|cocustom):/.test(t)) continue;
    const def = defOf(ctx, st, t);
    if (!def || def.type !== "select") continue;
    const add = extraOptions(t, def.options);
    if (!add.length) continue;
    const id = t.slice(t.indexOf(":") + 1);
    if (def.entity === "company") await updateCompanyField(id, { options: [...def.options, ...add] });
    else await updateContactField(id, { options: [...def.options, ...add] });
  }
  const resolveCustom = (custom: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(custom)) { const id = k.startsWith("new:") ? tmpIds.get(k.slice(4)) : k.slice(k.indexOf(":") + 1); if (id) out[id] = v; }
    return out;
  };

  /* 2) companies: create the new ones, update the found ones */
  const coIds = new Map<string, string>();
  let coBatchP: Promise<string | null> | null = null;
  const coBatch = () => (coBatchP ??= startImportBatch("company", names.company || `${names.contact} (companies named in the contacts)`));
  const coTodo = plan.companies.filter((c) => c.used && c.ref === `new:${c.key}`);
  if (coTodo.length) {
    onProgress({ done: 0, total: coTodo.length, phase: "Creating companies…" });
    let k = 0;
    for (const c of coTodo) {
      const row: any = { ...c.data, name: c.name, custom: resolveCustom(c.custom), import_batch_id: await coBatch() };
      const e = await saveCompany(row as Company).catch((x: any) => x?.message ?? "Failed");
      if (!e && row.id) { coIds.set(c.key, row.id); res.coCreated++; }
      else res.failed.push({ row: reportFile === "company" && c.fileRows.length ? c.fileRows[0] + offsetOf("company") : 0, reason: `Company “${c.name}”: ${e}` });
      onProgress({ done: ++k, total: coTodo.length, phase: "Creating companies…" });
    }
  }
  if (st.coExisting !== "keep") {
    for (const c of plan.companies.filter((x) => x.used && x.ref?.startsWith("crm:") && x.diff)) {
      const crm = ctx.companies.find((x) => x.id === c.ref!.slice(4));
      if (!crm) continue;
      const file = { ...c.data }, cust = resolveCustom(c.custom);
      const p = patchFor(st.coExisting, crm, diffRecord(crm, file, cust, (k) => k), file, cust);
      if (!p) continue;
      const { error } = await supabase.from("companies").update(p).eq("id", crm.id!);
      if (!error) res.coUpdated++; else res.failed.push({ row: 0, reason: `Company “${crm.name}”: ${error.message}` });
    }
  }
  const coId = (ref: string) => (ref.startsWith("crm:") ? ref.slice(4) : coIds.get(ref.slice(4)) ?? null);

  /* 3) contacts: create (4 at a time), then update and link the found ones */
  const todo = plan.contacts.filter((c) => c.status === "new");
  const ctBatch = todo.length ? await startImportBatch("contact", names.contact || `${names.company} (contacts in the companies file)`) : null;
  if (todo.length) {
    onProgress({ done: 0, total: todo.length, phase: "Importing contacts…" });
    let cursor = 0, done = 0;
    const worker = async () => {
      while (cursor < todo.length) {
        const c = todo[cursor++];
        try {
          const row: any = {
            first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone, position: c.position, is_billing: !!c.is_billing, notes: c.notes,
            ...Object.fromEntries(PROF.map((k) => [k, c.profile[k] || null])),
            custom: resolveCustom(c.custom), companyIds: [...new Set(c.coRefs.map(coId).filter((x): x is string => !!x))], import_batch_id: ctBatch,
          };
          const e = await saveContact(row as Contact).catch((x: any) => x?.message ?? "Failed");
          if (e) res.failed.push({ row: rowOf(c.rows), reason: `Contact “${fullName(c)}”: ${e}` }); else res.ctCreated++;
        } catch (x: any) { res.failed.push({ row: rowOf(c.rows), reason: `Contact “${fullName(c)}”: ${x?.message ?? "Failed"}` }); }
        onProgress({ done: ++done, total: todo.length, phase: "Importing contacts…" });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
  }
  const found = plan.contacts.filter((c) => c.status === "found");
  if (found.length) {
    onProgress({ done: 0, total: found.length, phase: "Updating contacts in the CRM…" });
    let k = 0;
    for (const c of found) {
      const crm = ctx.contacts.find((x) => x.id === c.ref!.slice(4));
      if (crm && st.ctExisting !== "keep") {
        const file = contactFile(c), cust = resolveCustom(c.custom);
        const p = patchFor(st.ctExisting, crm, diffRecord(crm, file, cust, (x) => x), file, cust);
        if (p) { const { error } = await supabase.from("contacts").update(p).eq("id", crm.id!); if (!error) res.ctUpdated++; else res.failed.push({ row: rowOf(c.rows), reason: `Contact “${fullName(c)}”: ${error.message}` }); }
      }
      if (crm) {
        const add = [...new Set(c.newLinks.map(coId).filter((x): x is string => !!x && !crm.companyIds.includes(x)))];
        if (add.length) {
          const { error } = await supabase.from("company_contacts").insert(add.map((company_id) => ({ company_id, contact_id: crm.id })));
          if (!error) res.ctLinked++;
        }
      }
      onProgress({ done: ++k, total: found.length, phase: "Updating contacts in the CRM…" });
    }
  }

  await finishImportBatch(ctBatch, res.ctCreated, res.ctUpdated);
  if (coBatchP) await finishImportBatch(await coBatchP, res.coCreated, res.coUpdated);
  plan.contacts.filter((c) => c.status === "error").forEach((c) => res.failed.push({ row: rowOf(c.rows), reason: `${c.reason ?? "Error"} — ${fullName(c) || c.email || "unnamed"}` }));
  plan.orphans.filter((o) => o.file === reportFile).forEach((o) => res.failed.push({ row: o.idx + offsetOf(reportFile), reason: o.reason }));
  res.failed.sort((a, b) => a.row - b.row);
  return res;
}

/** A plain-language reading of this importer's errors. */
function explainError(reason: string): { title: string; hint: string } | null {
  const r = reason.toLowerCase();
  if (r.startsWith("no name or email")) return { title: "No name or email", hint: "The row has neither — fill one in, or map the column that has it." };
  if (r.startsWith("no name")) return { title: "No name", hint: "Map the name column, or turn on “use the email” in the review options." };
  if (r.startsWith("no company name")) return { title: "No company name", hint: "Map the column with the name (or legal name, VAT or website)." };
  if (r.startsWith("nothing to import")) return { title: "Empty rows", hint: "No mapped column has a value in these rows." };
  if (r.startsWith("required field empty")) return { title: "A required contact field is empty", hint: "Map a column to that field, or make it optional in Contacts → Fields & columns." };
  return null;
}

/* ═══════════════════════════ one file ═══════════════════════════ */

function useFile() {
  const [fileName, setFileName] = useState("");
  const [wb, setWb] = useState<Workbook | null>(null);
  const [sheetIdx, setSheetIdxRaw] = useState(0);
  const [hasHeader, setHasHeaderRaw] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** The person changed the mapping — stop mapping automatically. */
  const touched = useRef(false);
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
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null); setLoading(true); touched.current = false;
    try {
      const book = await readSpreadsheet(f);
      const best = book.sheets.reduce((bi, s, i) => (s.rows.length > book.sheets[bi].rows.length ? i : bi), 0);
      const first = book.sheets[best].rows;
      const looksHeader = !!first[0] && first[0].every((c) => c == null || (typeof c === "string" && !EMAIL_RE.test(c) && parseNumber(c) == null));
      setWb(book); setSheetIdxRaw(best); setHasHeaderRaw(looksHeader); setFileName(f.name);
      if (!first.length) setErr("This sheet is empty.");
    } catch (e: any) { setErr(e?.message ?? "Couldn't read this file."); setWb(null); }
    setLoading(false);
  };
  const clear = () => { setWb(null); setFileName(""); setErr(null); touched.current = false; };
  return {
    fileName, wb, sheet, sheetIdx, hasHeader, loading, err, rows, columns, touched, pick, clear,
    offset: hasHeader ? 2 : 1,
    setSheetIdx: (i: number) => { touched.current = false; setSheetIdxRaw(i); },
    setHasHeader: (b: boolean) => { touched.current = false; setHasHeaderRaw(b); },
  };
}
type FileSide = ReturnType<typeof useFile>;

/* ═══════════════════════════ component ═══════════════════════════ */

type Step = "file" | "map" | "review" | "run" | "done";
const STEPS: { key: Step; label: string }[] = [{ key: "file", label: "Files" }, { key: "map", label: "Columns" }, { key: "review", label: "Review" }, { key: "done", label: "Import" }];
const fmtN = (n: number) => n.toLocaleString("de-DE");
const uid = () => Math.random().toString(36).slice(2, 9);
type Suggestion =
  | { kind: "existing"; target: string; label: string; entity: Ent; score: number }
  | { kind: "create"; entity: Ent; label: string; type: FieldType; options: string[] };

export default function ContactImport({ fields: initialFields, onClose, onDone, primary = "contact" }: {
  fields: ContactField[];
  onClose: () => void;
  onDone: () => void;
  /** Where it was opened from: that file is required and comes first; the other is optional. */
  primary?: Ent;
}) {
  useBackToClose("contact-import", onClose);
  const [step, setStep] = useState<Step>("file");
  const [ctFields, setCtFields] = useState<ContactField[]>(initialFields ?? []);
  const [coFields, setCoFields] = useState<CompanyField[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  // fresh lists every time it opens — fields created a minute ago are selectable
  useEffect(() => {
    listContactFields().then(setCtFields).catch(() => {});
    listCompanyFields().then(setCoFields).catch(() => {});
    listCompanies().then(setCompanies).catch(() => {});
    listContacts().then(setContacts).catch(() => {});
  }, []);
  const ctx: Ctx = useMemo(() => ({ companies, contacts, coFields, ctFields }), [companies, contacts, coFields, ctFields]);

  /* ─────────────── the files ─────────────── */
  const ctF = useFile(), coF = useFile();
  const fileOf = (e: Ent): FileSide => (e === "contact" ? ctF : coF);
  const secondary: Ent = primary === "contact" ? "company" : "contact";
  const has = (e: Ent) => !!fileOf(e).wb && fileOf(e).rows.length > 0;
  const both = has("contact") && has("company");
  const [mapTab, setMapTab] = useState<Ent>(primary);
  const cur: Ent = both ? mapTab : has(primary) ? primary : secondary;
  const reportFile: Ent = has("contact") ? "contact" : "company";
  const [viewer, setViewer] = useState(false);

  /* ─────────────── import state ─────────────── */
  const [st, setSt] = useState<IState>(emptyState);
  const patch = (p: Partial<IState>) => setSt((s) => ({ ...s, ...p }));
  const [openValues, setOpenValues] = useState<Record<string, boolean>>({});
  const vKey = (file: Ent, col: number) => `${file}:${col}`;

  /** The automatic mapping of a file: your fields by name first, then every built-in field. */
  const autoMap = (file: Ent, columns: Column[]) => {
    const m: Record<number, string> = {};
    const used = new Set<string>();
    const guesses = new Map(columns.map((c) => [c.i, guessTarget(file, c.header, c.samples)]));
    // a companies file only fills contact fields when it has contact columns too
    const withContacts = file === "contact" || [...guesses.values()].some((g) => g?.startsWith("contact."));
    const own = [...ctx.ctFields.map((f) => ({ label: f.label, t: `ctcustom:${f.id}`, e: "contact" as Ent })), ...ctx.coFields.map((f) => ({ label: f.label, t: `cocustom:${f.id}`, e: "company" as Ent }))]
      .filter((x) => x.e === file || withContacts);
    for (const c of columns) {
      const h = stripSide(normHeader(c.header));
      const free = own.filter((x) => !used.has(x.t));
      const hits = free.filter((x) => h && stripSide(normHeader(x.label)) === h);
      // your field by name, a built-in field, or your field by a very similar name ("Empleados" → "Nº empleados")
      const near = free.map((x) => ({ ...x, s: labelSim(c.header, x.label) + (x.e === file ? 0.01 : 0) })).sort((a, b) => b.s - a.s)[0];
      const g = (hits.find((x) => x.e === file) ?? hits[0])?.t ?? guesses.get(c.i) ?? (near && near.s >= 0.9 ? near.t : null);
      if (g && (!used.has(g) || MULTI_OK.has(g))) { m[c.i] = g; used.add(g); } else m[c.i] = "";
    }
    if (used.has("contact.first_name")) for (const k of Object.keys(m)) if (m[+k] === "contact.full_name") m[+k] = "";
    return m;
  };
  useEffect(() => { if (ctF.sheet && !ctF.touched.current) setSt((s) => ({ ...s, maps: { ...s.maps, contact: autoMap("contact", ctF.columns) } })); }, [ctF.sheet, ctF.columns, ctx.ctFields, ctx.coFields]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (coF.sheet && !coF.touched.current) setSt((s) => ({ ...s, maps: { ...s.maps, company: autoMap("company", coF.columns) } })); }, [coF.sheet, coF.columns, ctx.ctFields, ctx.coFields]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetChoices = (e: Ent) => setSt((s) => ({ ...s, maps: { ...s.maps, [e]: {} }, companyChoice: {}, contactChoice: {}, contactCompany: {} }));
  const pickFile = (e: Ent, f: File | undefined) => { resetChoices(e); void fileOf(e).pick(f); };
  const clearFile = (e: Ent) => { fileOf(e).clear(); resetChoices(e); };

  const touch = (file: Ent) => { fileOf(file).touched.current = true; };
  const newFieldFrom = (s: IState, file: Ent, col: number, entity: Ent, preset?: { label: string; type: FieldType; options: string[] }): NewField => {
    const c = fileOf(file).columns.find((x) => x.i === col)!;
    const g = preset ?? { label: cleanLabel(c.header) || `Field ${c.letter}`, ...guessType(c.values) };
    const list = (entity === "company" ? ctx.coFields : ctx.ctFields) as { label: string }[];
    let label = g.label;
    if (list.some((f) => normHeader(f.label) === normHeader(label)) || s.newFields.some((n) => n.entity === entity && normHeader(n.label) === normHeader(label))) label = `${label} (imported)`;
    return { tmp: uid(), entity, label, type: g.type, options: g.options };
  };
  const setTarget = (file: Ent, col: number, v: string) => {
    touch(file);
    if (v.startsWith("__create:")) {
      const entity = v.slice(9) as Ent;
      setSt((s) => {
        const nf = newFieldFrom(s, file, col, entity);
        const prev = s.maps[file][col];
        return { ...s, newFields: [...s.newFields.filter((n) => `new:${n.tmp}` !== prev), nf], maps: { ...s.maps, [file]: { ...s.maps[file], [col]: `new:${nf.tmp}` } } };
      });
      setOpenValues((o) => ({ ...o, [vKey(file, col)]: true }));
      return;
    }
    setSt((s) => {
      const prev = s.maps[file][col];
      const newFields = prev?.startsWith("new:") && prev !== v ? s.newFields.filter((n) => `new:${n.tmp}` !== prev) : s.newFields;
      return { ...s, newFields, maps: { ...s.maps, [file]: { ...s.maps[file], [col]: v === "__none" ? "" : v } } };
    });
    if (VALUE_BUILTIN.has(v) || /^(ctcustom|cocustom):/.test(v)) setOpenValues((o) => ({ ...o, [vKey(file, col)]: true }));
  };
  /** Take every suggested new field of a file in one go. */
  const createSuggested = (file: Ent, cols: { col: number; sg: Extract<Suggestion, { kind: "create" }> }[]) => {
    if (!cols.length) return;
    touch(file);
    setSt((s) => {
      let next = s;
      for (const { col, sg } of cols) {
        const nf = newFieldFrom(next, file, col, sg.entity, sg);
        next = { ...next, newFields: [...next.newFields, nf], maps: { ...next.maps, [file]: { ...next.maps[file], [col]: `new:${nf.tmp}` } } };
      }
      return next;
    });
  };
  const patchNew = (tmp: string, p: Partial<NewField>) => setSt((s) => ({ ...s, newFields: s.newFields.map((n) => (n.tmp === tmp ? { ...n, ...p } : n)) }));
  const removeNew = (tmp: string) => setSt((s) => ({
    ...s, newFields: s.newFields.filter((n) => n.tmp !== tmp),
    maps: { contact: Object.fromEntries(Object.entries(s.maps.contact).map(([k, v]) => [k, v === `new:${tmp}` ? "" : v])), company: Object.fromEntries(Object.entries(s.maps.company).map(([k, v]) => [k, v === `new:${tmp}` ? "" : v])) },
  }));
  const setValueChoice = (target: string, key: string, choice: string) => setSt((s) => ({ ...s, valueMaps: { ...s.valueMaps, [target]: { ...(s.valueMaps[target] ?? {}), [key]: choice } } }));

  /* ─────────────── suggestions for columns nothing matched ─────────────── */
  const suggestFor = (file: Ent, c: Column): Suggestion | null => {
    if (st.maps[file][c.i] || !c.filled || ID_RE.test(normHeader(c.header))) return null;
    const used = new Set(Object.values(st.maps[file]));
    const withContacts = file === "contact" || [...used].some((t) => t.startsWith("contact.") || t.startsWith("ctcustom:"));
    let best: Extract<Suggestion, { kind: "existing" }> | null = null;
    for (const [list, entity, pre] of [[ctx.ctFields, "contact", "ctcustom"], [ctx.coFields, "company", "cocustom"]] as const) {
      if (entity !== file && !withContacts) continue;
      for (const f of list as { id: string; label: string }[]) {
        const t = `${pre}:${f.id}`;
        if (used.has(t)) continue;
        const sc = labelSim(c.header, f.label) + (entity === file ? 0.01 : 0);
        if (sc >= 0.62 && (!best || sc > best.score)) best = { kind: "existing", target: t, label: f.label, entity, score: sc };
      }
    }
    if (best) return best;
    const h = normHeader(c.header);
    const entity: Ent = !withContacts ? "company" : COMPANYISH.test(h) && !CONTACTISH.test(h) ? "company" : CONTACTISH.test(h) ? "contact" : file;
    return { kind: "create", entity, label: cleanLabel(c.header), ...guessType(c.values) };
  };

  /* ─────────────── checks per step ─────────────── */
  const targetLabel = (t: string) => targetLabelOf(ctx, st, t);
  const mapProblemOf = (file: Ent): string | null => {
    if (!has(file)) return null;
    const used = Object.values(st.maps[file]).filter(Boolean);
    const label = file === "contact" ? "contacts" : "companies";
    if (!used.length) return `Map at least one column of the ${label} file.`;
    if (file === "contact" && !used.some((t) => WHO_CT.includes(t) || WHO_CO.includes(t))) return "Map the contact's name or email in the contacts file.";
    if (file === "company" && !used.some((t) => WHO_CO.includes(t))) return "Map the company name (or legal name, VAT or website) in the companies file.";
    const dup = used.find((t, i) => used.indexOf(t) !== i && !MULTI_OK.has(t));
    if (dup) return `“${targetLabel(dup)}” is mapped from two columns of the ${label} file.`;
    const all = new Set([...Object.values(st.maps.contact), ...Object.values(st.maps.company)]);
    const listOf = (e: Ent) => (e === "company" ? ctx.coFields : ctx.ctFields) as { label: string }[];
    const bad = st.newFields.find((n) => all.has(`new:${n.tmp}`) && (!n.label.trim() || listOf(n.entity as Ent).some((f) => normHeader(f.label) === normHeader(n.label))
      || st.newFields.some((o) => o.tmp !== n.tmp && o.entity === n.entity && all.has(`new:${o.tmp}`) && normHeader(o.label) === normHeader(n.label))));
    if (bad) return `New ${ENT[bad.entity as Ent].toLowerCase()} field “${bad.label || "untitled"}” needs a unique name.`;
    return null;
  };
  const mapIssue = mapProblemOf(primary) ?? mapProblemOf(secondary);

  const fileData = useMemo<FileData[]>(() => (["contact", "company"] as Ent[]).filter(has).map((e) => ({ entity: e, columns: fileOf(e).columns, rows: fileOf(e).rows, offset: fileOf(e).offset })),
    [ctF.wb, ctF.columns, ctF.rows, ctF.offset, coF.wb, coF.columns, coF.rows, coF.offset]); // eslint-disable-line react-hooks/exhaustive-deps
  const planNeeded = step === "review" || step === "run";
  const plan = useMemo(() => (planNeeded ? buildPlan(ctx, fileData, st) : null), [planNeeded, ctx, fileData, st]);

  /* ─────────────── run ─────────────── */
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: "" });
  const [result, setResult] = useState<Result | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [ranPlan, setRanPlan] = useState<Plan | null>(null);
  const run = async () => {
    if (!plan) return;
    setRanPlan(plan); setStep("run"); setRunErr(null);
    try { setResult(await runImport(ctx, st, fileData, plan, { contact: ctF.fileName, company: coF.fileName }, reportFile, setProgress)); }
    catch (e: any) { setRunErr(e?.message ?? "The import stopped unexpectedly."); setResult({ ctCreated: 0, ctUpdated: 0, ctLinked: 0, coCreated: 0, coUpdated: 0, newFields: 0, failed: [] }); }
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
  const template = (e: Ent) => download(`${e === "contact" ? "contacts" : "companies"}-template.csv`, [e === "contact"
    ? ["First name", "Last name", "Email", "Phone", "Position", "Street", "Number", "Postal code", "City", "Country", "Language", "LinkedIn", "Company", "Company VAT", "Company website", ...ctFields.map((f) => f.label)]
    : ["Company", "Legal name", "VAT", "Website", "Phone", "Email", "Street", "Number", "Postal code", "City", "Province", "Country", ...coFields.map((f) => f.label)]]);
  const downloadErrors = () => {
    const f = fileOf(reportFile);
    if (!result || !f.sheet) return;
    download(`${f.fileName.replace(/\.[^.]+$/, "")}-import-errors.csv`, [["Row", "Problem", ...(f.hasHeader ? f.sheet.rows[0].map(cellText) : f.columns.map((c) => c.header))],
      ...result.failed.map((x) => [x.row ? String(x.row) : "—", x.reason, ...(x.row ? (f.sheet!.rows[x.row - 1] ?? []).map(cellText) : [])])]);
  };
  const describeRow = (row: number) => {
    const p = ranPlan;
    if (!p) return null;
    const idx = row - fileOf(reportFile).offset;
    const c = p.contacts.find((x) => x.rows.some((r) => r.file === reportFile && r.idx === idx));
    if (c) return { name: fullName(c) || c.email, sub: [c.email, c.position].filter(Boolean).join(" · ") || null, issues: c.issues };
    const co = p.companies.find((x) => reportFile === "company" && x.fileRows.includes(idx));
    return co ? { name: co.name, sub: [co.data.vat_number, co.data.city].filter(Boolean).join(" · ") || null, issues: co.issues } : null;
  };

  /* ─────────────── what a column can go to ─────────────── */
  const targetOptions = (file: Ent): TOpt[] => {
    const out: TOpt[] = [{ value: "__none", label: "Don't import", group: "", tone: "none" }];
    const order: Ent[] = file === "contact" ? ["contact", "company"] : ["company", "contact"];
    order.forEach((e) => BASE.filter((b) => b.group === e).forEach((b) => out.push({ value: b.key, label: b.label, group: ENT[e], tone: e === "company" ? "co" : "ct", hint: b.hint })));
    order.forEach((e) => ((e === "contact" ? ctx.ctFields : ctx.coFields) as { id: string; label: string; type: FieldType }[]).forEach((f) =>
      out.push({ value: `${e === "contact" ? "ctcustom" : "cocustom"}:${f.id}`, label: f.label, group: `Your ${e} fields`, tone: "field", hint: TYPE_LABEL[f.type] })));
    st.newFields.forEach((n) => out.push({ value: `new:${n.tmp}`, label: n.label || "Untitled", group: "New fields", tone: "new", hint: `${ENT[n.entity as Ent]} · ${TYPE_LABEL[n.type]}` }));
    order.forEach((e) => out.push({ value: `__create:${e}`, label: `New ${e} field from this column`, group: "Create", tone: "create" }));
    return out;
  };
  const [langOpts] = useState(() => languageOptions());
  const [countryOpts] = useState(() => countryOptions());
  const valueOptions = (target: string, raw: string): { value: string; label: string }[] => {
    if (target === "contact.language") return [...langOpts, { value: "__empty", label: "Leave empty" }];
    if (target === "contact.country") return [...countryOpts, { value: "__keep", label: `Keep “${raw}” as written` }, { value: "__empty", label: "Leave empty" }];
    const f = defOf(ctx, st, target);
    return [...(f?.options ?? []).map((o) => ({ value: o, label: o })), { value: "__new", label: `+ Add “${raw}” as a new option` }, { value: "__empty", label: "Leave empty" }];
  };

  /* ─────────────── map step filters ─────────────── */
  const [colQ, setColQ] = useState("");
  const [colFilter, setColFilter] = useState<"all" | "mapped" | "unmapped" | "check" | "suggest">("all");
  const [flashCol, setFlashCol] = useState<number | null>(null);
  const jumpToColumn = (i: number) => {
    setViewer(false);
    if (step !== "map") return;
    setColQ(""); setColFilter("all"); setFlashCol(i);
    setTimeout(() => document.getElementById(`ci-col-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    setTimeout(() => setFlashCol(null), 1800);
  };

  /* ─────────────── review ─────────────── */
  const [rvTab, setRvTab] = useState<"contacts" | "companies" | "options">("contacts");
  const companyOptions = useMemo(() => companies.map((c) => ({ value: `crm:${c.id}`, label: c.name })), [companies]);
  const contactOptions = useMemo(() => contacts.map((c) => ({ value: `crm:${c.id}`, label: `${fullName(c)}${c.email ? ` · ${c.email}` : ""}` })), [contacts]);

  const stepIdx = step === "run" ? 3 : STEPS.findIndex((s) => s.key === step);
  const title = both ? (primary === "company" ? "Companies + contacts" : "Contacts + companies") : primary === "company" ? "Companies" : "Contacts";
  const names = [ctF.fileName, coF.fileName].filter(Boolean).join(" · ");

  /* ═══════════════════════════ render ═══════════════════════════ */
  const curF = fileOf(cur);
  const mapping = st.maps[cur];
  const usedTargets = Object.values(mapping).filter(Boolean);
  const tOpts = targetOptions(cur);
  const suggestions = step === "map" ? curF.columns.map((c) => ({ c, sg: suggestFor(cur, c) })).filter((x): x is { c: Column; sg: Suggestion } => !!x.sg) : [];
  const createSugg = suggestions.filter((x) => x.sg.kind === "create").map((x) => ({ col: x.c.i, sg: x.sg as Extract<Suggestion, { kind: "create" }> }));

  return createPortal(
    <div className="di-backdrop ci-import" onMouseDown={() => step !== "run" && onClose()}>
      <div className="di" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Import ${title.toLowerCase()}`}>
        <header className="di-head">
          <div className="di-head-txt">
            <span className="di-eyebrow">Import</span>
            <h2>{title}{names && <small>{names}</small>}</h2>
          </div>
          <ol className="di-steps" style={{ ["--k" as string]: stepIdx, ["--n" as string]: STEPS.length } as CSSProperties}>
            <span className="di-steps-bar"><i /></span>
            {STEPS.map((s, i) => <li key={s.key} className={i < stepIdx ? "is-done" : i === stepIdx ? "is-on" : ""}><b>{i < stepIdx ? "✓" : i + 1}</b><span>{s.label}</span></li>)}
          </ol>
          <div className="di-head-actions">
            {curF.sheet && step !== "run" && step !== "done" && (
              <button className="di-sheetbtn" onClick={() => setViewer(true)} title="See every row and column of the file">
                <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9.5h18M3 15h18M9 4v16M15 4v16" /></svg>
                <span>Sheet</span>
              </button>
            )}
            <button className="di-x" onClick={onClose} disabled={step === "run"} aria-label="Close">×</button>
          </div>
        </header>

        <div className={`di-body is-${step}`} key={step}>
          {/* ═════ 1. FILES ═════ */}
          {step === "file" && (
            <div className="di-file">
              <div className="di-file-intro">
                <h3>Bring your {primary === "company" ? "companies and their contacts" : "contacts and their companies"} over</h3>
                <p>Export them from your old CRM or a spreadsheet as Excel or CSV — one file, or one for {primary === "company" ? "companies and another for contacts" : "contacts and another for companies"}. Every column can go to any contact or company field, and they're linked to each other.</p>
                <ul className="di-file-points">
                  <li><b>Columns recognised</b>Every contact and company field and your custom fields — in Spanish, English or Dutch</li>
                  <li><b>Fields suggested</b>A column nothing matches gets a proposed custom field, with its type and options</li>
                  <li><b>Companies found</b>by VAT, name, website or the contacts' email — even spelled differently; the doubtful ones are suggested</li>
                  <li><b>Already in the CRM</b>fill their empty fields, replace them with the file's data, or keep them</li>
                </ul>
              </div>
              <div className="ci-drops">
                {[primary, secondary].map((e) => (
                  <DropCard key={e} entity={e} side={fileOf(e)} optional={e !== primary}
                    hint={e === primary ? (e === "contact" ? "The people to import — required" : "The companies to import — required")
                      : e === "company" ? "Optional — imported too, and linked to the contacts" : "Optional — imported too, and linked to these companies"}
                    onPick={(f) => pickFile(e, f)} onClear={() => clearFile(e)} onTemplate={() => template(e)} onView={() => { setMapTab(e); setViewer(true); }}
                    recognised={Object.values(st.maps[e]).filter(Boolean).length} />
                ))}
              </div>
            </div>
          )}

          {/* ═════ 2. COLUMNS ═════ */}
          {step === "map" && (
            <>
              {both && (
                <div className="ci-ftabs" data-tab={mapTab} data-first={primary} role="tablist">
                  {[primary, secondary].map((e) => (
                    <button key={e} role="tab" aria-selected={mapTab === e} className={mapTab === e ? "is-on" : ""} onClick={() => { setMapTab(e); setColQ(""); setColFilter("all"); }}>
                      {e === "contact" ? "Contacts file" : "Companies file"}<i>{fileOf(e).columns.length} columns</i>{mapProblemOf(e) && <em>!</em>}
                    </button>
                  ))}
                  <span className="ci-ftabs-ink" />
                </div>
              )}
              <div className="di-mapgrid" key={cur}>
                <div className="di-maplist">
                  <div className="di-maptools">
                    <label className="di-search">
                      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
                      <input value={colQ} onChange={(e) => setColQ(e.target.value)} placeholder="Find a column…" />
                    </label>
                    <div className="di-seg is-small">
                      {([["all", "All", curF.columns.length], ["mapped", "Mapped", curF.columns.filter((c) => mapping[c.i]).length], ["unmapped", "Not imported", curF.columns.filter((c) => !mapping[c.i]).length],
                        ["suggest", "Suggestions", suggestions.length],
                        ["check", "To check", curF.columns.filter((c) => { const t = mapping[c.i]; return t && hasValueStep(ctx, st, t) && distinctValues(c.values).some((d) => !choiceFor(ctx, st, t, d.text).matched); }).length]] as const).map(([k, l, n]) => (
                        <button key={k} className={`${colFilter === k ? "is-on" : ""} ${(k === "check" || k === "suggest") && n ? "is-warn" : ""}`} onClick={() => setColFilter(k)}>{l}<i>{n}</i></button>
                      ))}
                    </div>
                  </div>
                  {curF.columns.map((c, k) => {
                    const t = mapping[c.i] ?? "";
                    const nf = t.startsWith("new:") ? st.newFields.find((n) => `new:${n.tmp}` === t) ?? null : null;
                    const valued = !!t && hasValueStep(ctx, st, t);
                    const dist = valued ? distinctValues(c.values) : [];
                    const decisions = dist.map((d) => ({ ...d, ...choiceFor(ctx, st, t, d.text) }));
                    const open = decisions.filter((d) => !d.matched).length;
                    const sg = suggestions.find((x) => x.c.i === c.i)?.sg ?? null;
                    if (colQ.trim() && !normHeader(`${c.header} ${c.letter} ${t ? targetLabel(t) : ""}`).includes(normHeader(colQ))) return null;
                    if (colFilter === "mapped" && !t) return null;
                    if (colFilter === "unmapped" && t) return null;
                    if (colFilter === "check" && !open) return null;
                    if (colFilter === "suggest" && !sg) return null;
                    const expanded = valued && (openValues[vKey(cur, c.i)] ?? open > 0);
                    const tone = tOpts.find((o) => o.value === t)?.tone ?? "none";
                    return (
                      <div key={c.i} id={`ci-col-${c.i}`} className={`di-map is-t-${tone} ${t ? "is-mapped" : ""} ${open ? "has-open" : ""} ${sg ? "has-suggest" : ""} ${flashCol === c.i ? "is-flash" : ""}`} style={{ ["--i" as string]: Math.min(k, 14) } as CSSProperties}>
                        <div className="di-map-row">
                          <span className="di-col"><em>{c.letter}</em><span><b title={c.header}>{c.header}</b><small>{c.filled} of {curF.rows.length} filled</small></span></span>
                          <span className="di-samples">{c.samples.length ? c.samples.map((x, i) => <span key={i} title={cellText(x)}>{cellText(x)}</span>) : <i>empty</i>}</span>
                          <svg className="di-arrow" viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                          <div className="di-target">
                            <TargetPicker value={t || "__none"} options={tOpts} used={usedTargets} onChange={(v) => setTarget(cur, c.i, v)} />
                          </div>
                        </div>
                        {sg?.kind === "create" && (
                          <div className="di-hintbar is-suggest">
                            <i>✦</i>
                            <span>Suggested: a new <b>{sg.entity}</b> field <b>“{sg.label}”</b> · {TYPE_LABEL[sg.type]}{sg.type === "select" ? ` with ${sg.options.length} options` : ""}</span>
                            <button className="ci-sugbtn" onClick={() => createSuggested(cur, [{ col: c.i, sg }])}>Create it</button>
                          </div>
                        )}
                        {sg?.kind === "existing" && (
                          <div className="di-hintbar is-similar">
                            <i>≈</i>
                            <span>Looks like your {sg.entity} field <b>“{sg.label}”</b> ({Math.round(Math.min(sg.score, 1) * 100)}% alike)</span>
                            <button className="ci-sugbtn" onClick={() => setTarget(cur, c.i, sg.target)}>Use it</button>
                          </div>
                        )}
                        {(() => {
                          const d = /^(ctcustom|cocustom):/.test(t) ? defOf(ctx, st, t) : null;
                          if (!d || stripSide(normHeader(c.header)) === stripSide(normHeader(d.label)) || labelSim(c.header, d.label) < 0.9) return null;
                          return (
                            <div className="di-hintbar is-similar">
                              <i>≈</i>
                              <span>Matched to your {d.entity} field <b>“{d.label}”</b> by its similar name — change it above if that's not right.</span>
                            </div>
                          );
                        })()}
                        {t === "company.name" && cur === "contact" && (
                          <div className="di-hintbar is-co">
                            <i>⌂</i>
                            <span>Each contact is linked to this company — found in your CRM by VAT, name or website, or <b>created</b>. Several in one cell (“Acme; Beta”) link to all of them.</span>
                          </div>
                        )}
                        {nf && (
                          <NewFieldEditor nf={nf} column={c} entities={["contact", "company"]} onPatch={(p) => patchNew(nf.tmp, p)} onRemove={() => removeNew(nf.tmp)}
                            onOptionsChanged={() => setOpenValues((o) => ({ ...o, [vKey(cur, c.i)]: true }))} />
                        )}
                        {valued && dist.length > 0 && (
                          <div className={`di-values ${expanded ? "is-open" : ""}`}>
                            <button className="di-values-h" onClick={() => setOpenValues((o) => ({ ...o, [vKey(cur, c.i)]: !expanded }))} aria-expanded={expanded}>
                              <b>{nf ? "Each value of the column → one of your options" : t === "contact.language" ? "Match the values to a language" : t === "contact.country" ? "Match the values to a country" : <>Match the values to “{defOf(ctx, st, t)?.label}”</>}</b>
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
                                {decisions.length > 120 && <p className="di-muted">+{decisions.length - 120} more values — matched automatically when they can be.</p>}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <aside className="di-side">
                  {createSugg.length > 0 && (
                    <section className="ci-sugg">
                      <div className="ci-sugg-h"><h4>Suggested fields</h4><button className="ci-sugbtn" onClick={() => createSuggested(cur, createSugg)}>Create all {createSugg.length}</button></div>
                      <p className="di-side-p">Columns that don't match any field yet. Each becomes a custom field with the type its values suggest.</p>
                      <ul className="di-checks">
                        {createSugg.map(({ col, sg }) => (
                          <li key={col} className="is-sugg">
                            <i>+</i><button onClick={() => jumpToColumn(col)} title="Go to the column">{sg.label}</button>
                            <em>{ENT[sg.entity]} · {TYPE_LABEL[sg.type]}</em>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  <h4>What gets filled</h4>
                  <Coverage used={new Set([...Object.values(st.maps.contact), ...Object.values(st.maps.company)].filter(Boolean))} ctx={ctx} />
                  {st.newFields.some((n) => usedTargets.includes(`new:${n.tmp}`) || Object.values(st.maps[cur === "contact" ? "company" : "contact"]).includes(`new:${n.tmp}`)) && (
                    <>
                      <h4>Will be created</h4>
                      <ul className="di-checks">{st.newFields.filter((n) => [...Object.values(st.maps.contact), ...Object.values(st.maps.company)].includes(`new:${n.tmp}`)).map((n) => <li key={n.tmp} className="is-new"><i>+</i>{n.label || "Untitled"}<em>{ENT[n.entity as Ent]} · {TYPE_LABEL[n.type]}</em></li>)}</ul>
                    </>
                  )}
                </aside>
              </div>
            </>
          )}

          {/* ═════ 3. REVIEW ═════ */}
          {step === "review" && plan && (() => {
            const c = plan.counts;
            const ctGoing = c.ctNew + c.ctFound;
            const facts: [string, number, string?][] = [
              ["new contacts", c.ctNew], ["contacts in the CRM", c.ctFound], ["new companies", c.coNew], ["companies in the CRM", c.coFound],
              ["without a company", c.ctNoCompany, "is-muted"], ["address incomplete", c.ctIncomplete, "is-gold"], ["left out", c.ctSkip + c.coSkip, "is-muted"], ["with errors", c.ctError + c.orphans, "is-red"],
            ];
            return (
              <div className="rv">
                <div className="rv-top">
                  <div className="rv-hero">
                    {has("contact") ? <><b>{fmtN(ctGoing)}</b><span>{ctGoing === 1 ? "contact" : "contacts"} ready to import</span></> : <><b>{fmtN(c.coNew + c.coFound)}</b><span>companies ready to import</span></>}
                  </div>
                  <ul className="rv-facts">{facts.filter(([, n]) => n > 0).map(([l, n, cls]) => <li key={l} className={cls ?? ""}><b>{fmtN(n)}</b>{l}</li>)}</ul>
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
                    {c.coExisting > 0 && <ExistingChoice label="Companies" n={c.coExisting} fill={c.coFill} change={c.coChange} value={st.coExisting} onChange={(v) => patch({ coExisting: v })} keepText="Nothing changes — they're only linked" />}
                    {c.ctExisting > 0 && <ExistingChoice label="Contacts" n={c.ctExisting} fill={c.ctFill} change={c.ctChange} value={st.ctExisting} onChange={(v) => patch({ ctExisting: v })} keepText="Nothing changes — they're only linked to their companies" />}
                  </section>
                )}

                <nav className="rv-tabs" role="tablist">
                  {([
                    ["contacts", "Contacts", plan.contacts.length, c.ctError ? `${c.ctError} ${c.ctError === 1 ? "error" : "errors"}` : c.ctWarn ? `${c.ctWarn} to look at` : null],
                    ["companies", "Companies", plan.companies.length, c.coCheck ? `${c.coCheck} to check` : null],
                    ["options", "Options", null, null],
                  ] as const).filter(([k]) => (k !== "contacts" && k !== "options") || plan.contacts.length > 0).map(([k, l, n, flag]) => (
                    <button key={k} role="tab" aria-selected={rvTab === k} className={rvTab === k ? "is-on" : ""} onClick={() => setRvTab(k)}>
                      {l}{n != null && <i>{fmtN(n)}</i>}{flag && <em>{flag}</em>}
                    </button>
                  ))}
                </nav>

                <div className="rv-panel" key={rvTab}>
                  {rvTab === "contacts" && (
                    <ContactsReview plan={plan} st={st} offset={(f) => fileOf(f).offset} contactOptions={contactOptions} companyOptions={companyOptions}
                      onChoose={(key, v) => setSt((s) => ({ ...s, contactChoice: { ...s.contactChoice, [key]: v } }))}
                      onCompany={(key, v) => setSt((s) => ({ ...s, contactCompany: { ...s.contactCompany, [key]: v } }))} />
                  )}
                  {rvTab === "companies" && (
                    <CompaniesReview plan={plan} st={st} companies={companies} companyOptions={companyOptions}
                      onChoose={(key, v) => setSt((s) => ({ ...s, companyChoice: { ...s.companyChoice, [key]: v } }))}
                      onChooseMany={(m) => setSt((s) => ({ ...s, companyChoice: { ...s.companyChoice, ...m } }))} />
                  )}
                  {rvTab === "options" && (
                    <div className="rv-options">
                      {([
                        ["createContacts", "Create contacts that aren't in the CRM", "Otherwise only the contacts found in the CRM are updated and linked."],
                        ["createCompanies", "Create the companies named in the contacts", "When a contact's company isn't in the CRM. Companies of the companies file are always created."],
                        ["linkContacts", "Link found contacts to their company", "A contact already in the CRM joins the company the file gives it."],
                        ["companyFromDomain", "No company? Find it by the email domain", "ana@acme.es joins Acme when Acme's website is acme.es."],
                        ["nameFromEmail", "No name? Take it from the email", "ana.lopez@… becomes Ana Lopez."],
                      ] as const).map(([k, l, d]) => (
                        <label key={k} className="rv-opt is-toggle">
                          <div><b>{l}</b><span>{d}</span></div>
                          <span className={`rv-switch ${st[k] ? "is-on" : ""}`}><input type="checkbox" checked={st[k]} onChange={(e) => patch({ [k]: e.target.checked } as Partial<IState>)} /><i /></span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ═════ 4. RUN / DONE ═════ */}
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
                    {(ranPlan?.contacts.length ?? 0) > 0 ? <>
                      <div className="is-new"><b>{fmtN(result.ctCreated)}</b>contacts created</div>
                      <div className="is-ct"><b>{fmtN(result.ctUpdated)}</b>contacts updated{result.ctLinked > 0 && <small>{fmtN(result.ctLinked)} linked to a company</small>}</div>
                      <div className="is-co"><b>{fmtN(result.coCreated)}</b>companies created{result.coUpdated > 0 && <small>{fmtN(result.coUpdated)} updated</small>}</div>
                    </> : <>
                      <div className="is-new"><b>{fmtN(result.coCreated)}</b>companies created</div>
                      <div className="is-co"><b>{fmtN(result.coUpdated)}</b>companies updated</div>
                    </>}
                    <div className="is-error"><b>{fmtN(result.failed.length)}</b>not imported</div>
                  </div>
                  {result.newFields > 0 && <p>Also created {result.newFields} new {result.newFields === 1 ? "field" : "fields"}.</p>}
                  {runErr && <p className="di-err">{runErr}</p>}
                  {result.failed.length > 0 && (
                    <FailReport failed={result.failed} plan={null} rowOffset={fileOf(reportFile).offset} sheet={fileOf(reportFile).sheet} hasHeader={fileOf(reportFile).hasHeader}
                      onDownload={downloadErrors} describe={describeRow} explainFn={explainError} />
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {step !== "run" && (
          <footer className="di-foot">
            <span className={`di-foot-note ${step === "map" && mapIssue ? "is-warn" : ""}`}>
              {step === "file" && (has(primary) ? [has("contact") && `${fmtN(ctF.rows.length)} contacts`, has("company") && `${fmtN(coF.rows.length)} companies`].filter(Boolean).join(" · ") + " ready to map" : "Nothing changes until the last step.")}
              {step === "map" && (mapIssue ?? (createSugg.length ? `${createSugg.length} ${createSugg.length === 1 ? "column could become a field" : "columns could become fields"} — or leave them out.` : "Looks good — next, check who's new and who's already in the CRM."))}
              {step === "review" && plan && [plan.counts.ctNew + plan.counts.ctFound ? `${fmtN(plan.counts.ctNew)} new and ${fmtN(plan.counts.ctFound)} existing contacts` : null, plan.counts.coNew ? `${fmtN(plan.counts.coNew)} new companies` : null].filter(Boolean).join(" · ") + "."}
            </span>
            <div className="di-foot-actions">
              {step === "map" && <button className="di-btn is-ghost" onClick={() => setStep("file")}>Back</button>}
              {step === "review" && <button className="di-btn is-ghost" onClick={() => setStep("map")}>Back</button>}
              {step === "done" ? <button className="di-btn is-primary" onClick={onClose}>Done</button> : <button className="di-btn is-ghost" onClick={onClose}>Cancel</button>}
              {step === "file" && <button className="di-btn is-primary" disabled={!has(primary)} onClick={() => { setMapTab(primary); setStep("map"); }}>Map columns →</button>}
              {step === "map" && <button className="di-btn is-primary" disabled={!!mapIssue} onClick={() => { setRvTab(has("contact") ? "contacts" : "companies"); setStep("review"); }}>Review →</button>}
              {step === "review" && plan && (() => {
                const nC = plan.counts.ctNew + plan.counts.ctFound, nCo = plan.counts.coNew + plan.counts.coFound;
                const parts = primary === "company" ? [nCo && `${fmtN(nCo)} ${nCo === 1 ? "company" : "companies"}`, nC && `${fmtN(nC)} ${nC === 1 ? "contact" : "contacts"}`]
                  : [nC && `${fmtN(nC)} ${nC === 1 ? "contact" : "contacts"}`, nCo && `${fmtN(nCo)} ${nCo === 1 ? "company" : "companies"}`];
                return <button className="di-btn is-primary" disabled={!(nC + nCo)} onClick={run}>Import {parts.filter(Boolean).join(" + ") || "nothing"}</button>;
              })()}
            </div>
          </footer>
        )}

        {viewer && curF.sheet && (
          <SheetViewer sheet={curF.sheet} name={curF.wb && curF.wb.sheets.length > 1 ? curF.sheet.name : curF.fileName} hasHeader={curF.hasHeader} mapping={mapping}
            labelOf={(t) => ({ label: targetLabel(t), tone: tOpts.find((o) => o.value === t)?.tone ?? "ct" })}
            canJump={step === "map"} onJump={jumpToColumn} onClose={() => setViewer(false)} />
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ═══════════════════════════ pieces ═══════════════════════════ */

function DropCard({ entity, side: s, optional, hint, recognised, onPick, onClear, onTemplate, onView }: {
  entity: Ent; side: FileSide; optional: boolean; hint: string; recognised: number;
  onPick: (f: File | undefined) => void; onClear: () => void; onTemplate: () => void; onView: () => void;
}) {
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); onPick(e.dataTransfer.files?.[0]); };
  return (
    <section className={`ci-drop is-${entity} ${s.wb ? "has-file" : ""} ${optional ? "is-optional" : ""}`}>
      <header>
        <span className="ci-drop-ico">
          {entity === "contact"
            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4M9 9h.01M15 9h.01M9 13h.01M15 13h.01" /></svg>}
        </span>
        <span className="ci-drop-t"><b>{entity === "contact" ? "Contacts" : "Companies"}{optional && <em>optional</em>}</b><small>{hint}</small></span>
        {s.wb && <button className="ci-drop-x" onClick={onClear}>Remove</button>}
      </header>
      {!s.wb ? (
        <div className={`di-zone ${drag ? "is-drag" : ""}`} role="button" tabIndex={0}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
          onClick={() => ref.current?.click()} onKeyDown={(e) => e.key === "Enter" && ref.current?.click()}>
          <input ref={ref} type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt,.xls" hidden onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = ""; }} />
          <span className="di-zone-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg></span>
          <b>{s.loading ? "Reading…" : `Drop the ${entity === "contact" ? "contacts" : "companies"} file here`}</b>
          <span>or click to choose · .xlsx .csv .tsv</span>
        </div>
      ) : (
        <div className="ci-loaded">
          <div className="di-loaded-h">
            <span className="di-file-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg></span>
            <b title={s.fileName}>{s.fileName}</b>
          </div>
          <div className="di-stats">
            <span><b>{fmtN(s.rows.length)}</b>rows</span>
            <span><b>{s.columns.length}</b>columns</span>
            <span><b>{recognised}</b>recognised</span>
          </div>
          {s.wb.sheets.length > 1 && (
            <div className="di-sheets">
              <span>Sheet with the data</span>
              <div>{s.wb.sheets.map((sh, i) => <button key={sh.name + i} className={i === s.sheetIdx ? "is-on" : ""} onClick={() => s.setSheetIdx(i)}>{sh.name}<em>{Math.max(0, sh.rows.length - 1)}</em></button>)}</div>
            </div>
          )}
          <label className="di-check"><input type="checkbox" checked={s.hasHeader} onChange={(e) => s.setHasHeader(e.target.checked)} /><span />First row has the column names</label>
          <div className="di-peek">
            <table><thead><tr>{s.columns.slice(0, 6).map((c) => <th key={c.i}>{c.header}</th>)}</tr></thead>
              <tbody>{s.rows.slice(0, 3).map((r, ri) => <tr key={ri}>{s.columns.slice(0, 6).map((c) => <td key={c.i}>{cellText(r[c.i] ?? null)}</td>)}</tr>)}</tbody></table>
            <button className="di-peek-open" onClick={onView}>
              <svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
              View the whole sheet · {fmtN(s.rows.length)} rows × {s.columns.length} columns
            </button>
          </div>
        </div>
      )}
      {s.err && <p className="di-err">{s.err}</p>}
      {!s.wb && <button className="di-linkbtn" onClick={onTemplate}>Download a template with your fields</button>}
    </section>
  );
}

/** Which fields the mapping fills, contact and company. */
function Coverage({ used, ctx }: { used: Set<string>; ctx: Ctx }) {
  const groups: { title: string; items: [string, string[], string?][] }[] = [
    { title: "Contact", items: [["Name", ["contact.full_name", "contact.first_name"]], ["Email · phone", ["contact.email", "contact.phone"]], ["Position", ["contact.position"]],
      ["Street & number", ["contact.street", "contact.addr_number"], "street"], ["Postal code & city", ["contact.postal_code", "contact.city"], "city"], ["Country", ["contact.country"], "country"],
      ["Language", ["contact.language"], "language"], ["LinkedIn", ["contact.linkedin"], "linkedin"]] },
    { title: "Company", items: [["Name / VAT", ["company.name", "company.legal_name", "company.vat_number"]], ["Website · phone · email", ["company.website", "company.phone", "company.email"]],
      ["Address", ["company.street", "company.postal_code", "company.city", "company.province", "company.country"]]] },
  ];
  const req = ctx.ctFields.filter((f) => f.required);
  return (
    <div className="di-cover">
      {groups.map((g) => (
        <div key={g.title}>
          <span className="di-cover-h">{g.title}</span>
          <ul className="di-checks">
            {g.items.map(([l, ks, prof]) => {
              const on = ks.some((k) => used.has(k));
              return <li key={l} className={on ? "is-on" : ""}><i>{on ? "✓" : ""}</i>{l}{!on && prof && isRequired(prof) && <em>required</em>}</li>;
            })}
          </ul>
        </div>
      ))}
      {req.length > 0 && (
        <ul className="di-checks">
          {req.map((f) => { const on = used.has(`ctcustom:${f.id}`); return <li key={f.id} className={on ? "is-on" : ""}><i>{on ? "✓" : ""}</i>{f.label}{!on && <em>required</em>}</li>; })}
        </ul>
      )}
    </div>
  );
}

const FOUND_SHORT: Record<string, string> = { vat: "VAT", name: "name", legal: "legal name", domain: "web domain", similar: "similar name", email: "email", phone: "phone" };
const rowNums = (rows: RowRef[], offset: (f: Ent) => number) => {
  const ns = rows.map((r) => `${r.file === "company" ? "C" : ""}${r.idx + offset(r.file)}`);
  return ns.length > 3 ? `rows ${ns.slice(0, 3).join(", ")}…` : `row${ns.length > 1 ? "s" : ""} ${ns.join(", ")}`;
};

function ContactsReview({ plan, st, offset, contactOptions, companyOptions, onChoose, onCompany }: {
  plan: Plan; st: IState; offset: (f: Ent) => number; contactOptions: { value: string; label: string }[]; companyOptions: { value: string; label: string }[];
  onChoose: (key: string, v: string) => void; onCompany: (key: string, v: string) => void;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "new" | "found" | "nocompany" | "incomplete" | "warn" | "skip" | "error">(plan.counts.ctError ? "error" : "all");
  const [limit, setLimit] = useState(300);
  const list = plan.contacts;
  const going = (c: CtEntry) => c.status === "new" || c.status === "found";
  const test: Record<typeof filter, (c: CtEntry) => boolean> = {
    all: () => true, new: (c) => c.status === "new", found: (c) => c.status === "found", nocompany: (c) => going(c) && !c.coRefs.length,
    incomplete: (c) => going(c) && c.incomplete.length > 0, warn: (c) => going(c) && c.issues.length > 0, skip: (c) => c.status === "skip", error: (c) => c.status === "error",
  };
  const n = Object.fromEntries(Object.entries(test).map(([k, f]) => [k, list.filter(f).length])) as Record<typeof filter, number>;
  const shown = list.filter((c) => test[filter](c) && (!q.trim() || normHeader(`${fullName(c)} ${c.email ?? ""} ${c.position ?? ""}`).includes(normHeader(q))));
  const coName = (ref: string) => ref.startsWith("crm:") ? companyOptions.find((o) => o.value === ref)?.label ?? "Company" : plan.companies.find((x) => `new:${x.key}` === ref)?.name ?? "New company";
  const coPick = useMemo(() => [
    { value: "none", label: "No company" },
    ...plan.companies.filter((c) => c.ref).map((c) => ({ value: `co:${c.key}`, label: `${c.name}${c.ref?.startsWith("new:") ? " (new)" : ""}` })),
    ...companyOptions,
  ], [plan.companies, companyOptions]);
  return (
    <>
      <div className="rv-tools">
        <label className="di-search is-small">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
          <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(300); }} placeholder="Find a contact…" />
        </label>
        <div className="rv-chips">
          {([["all", "All"], ["new", "New"], ["found", "In the CRM"], ["nocompany", "No company"], ["incomplete", "Address incomplete"], ["warn", "To look at"], ["skip", "Left out"], ["error", "Errors"]] as const)
            .filter(([k]) => k === "all" || n[k] > 0).map(([k, l]) => (
              <button key={k} className={`${filter === k ? "is-on" : ""} ${(k === "error" || k === "warn" || k === "nocompany") && n[k] ? "is-warn" : ""}`} onClick={() => { setFilter(k); setLimit(300); }}>{l} <i>{fmtN(n[k])}</i></button>
            ))}
        </div>
        {!st.createContacts && <span className="rv-tools-note">New contacts are off (Options)</span>}
      </div>
      <div className="rv-list">
        {shown.slice(0, limit).map((c, i) => {
          const full = fullName(c) || c.email || "Unnamed";
          const kind = c.status === "found" ? "crm" : c.status;
          const ch = c.ref ? (c.ref.startsWith("new:") ? "create" : c.ref) : "skip";
          const coVal = st.contactCompany[c.key] ?? (c.coKeys[0] ? `co:${c.coKeys[0]}` : c.domainCo ? `crm:${c.domainCo}` : "none");
          return (
            <div key={c.key} className={`rv-row is-ct is-${kind}`} style={{ ["--j" as string]: Math.min(i, 24) } as CSSProperties}>
              <span className="rv-row-main">
                <b title={full}>{full}</b>
                <small>
                  <em className={`rv-tag is-${kind === "crm" ? "crm" : kind === "new" ? "new" : kind === "error" ? "error" : "skip"}`}>{kind === "new" ? "New" : kind === "crm" ? "In the CRM" : kind === "error" ? "Error" : "Left out"}</em>
                  {c.found && c.status === "found" ? `by ${FOUND_SHORT[c.foundBy ?? "email"]} · ` : ""}{[c.email, c.phone, c.position].filter(Boolean).join(" · ") || "no email or phone"}
                  <span className="rv-n">{rowNums(c.rows, offset)}</span>
                </small>
              </span>
              <span className="rv-row-mid">
                {c.status === "error" ? <span className="rv-rel is-err">{c.reason}</span> : c.status === "skip" ? <span className="rv-diff is-none">{c.reason}</span> : (
                  <>
                    {c.coRefs.length ? c.coRefs.map((r) => {
                      const linked = c.status === "found" && !c.newLinks.includes(r);
                      return <span key={r} className={`rv-rel ${linked ? "is-ok" : c.status === "new" || st.linkContacts ? "is-link" : "is-off"}`}>{linked ? "At" : c.status === "new" || st.linkContacts ? "Joins" : "Not linked to"} {coName(r)}{r.startsWith("new:") ? " (new)" : ""}</span>;
                    }) : <span className="rv-rel is-off">No company</span>}
                    {c.status === "found" && <DiffNote diff={c.diff} mode={st.ctExisting} />}
                    {c.incomplete.length > 0 && <span className="ci-miss" title={`Missing: ${c.incomplete.join(", ")}`}>Address: {c.incomplete.length} missing</span>}
                    {c.issues.length > 0 && <span className="ci-issue" title={c.issues.join("\n")}>{c.issues[0]}{c.issues.length > 1 ? ` (+${c.issues.length - 1})` : ""}</span>}
                  </>
                )}
              </span>
              <SalesMultiFilter single values={[coVal]} placeholder="Company" searchFrom={8} options={coPick} onChange={(v) => v[0] && onCompany(c.key, v[0])} />
              <SalesMultiFilter single values={[ch]} placeholder="Choose" searchFrom={8} onChange={(v) => v[0] && onChoose(c.key, v[0])}
                options={[
                  ...(c.found ? [{ value: c.found, label: `✓ ${contactOptions.find((o) => o.value === c.found)?.label ?? full}` }] : []),
                  { value: "create", label: `+ Create “${full}”` },
                  { value: "skip", label: "Leave out" },
                  ...contactOptions.filter((o) => o.value !== c.found).map((o) => ({ value: o.value, label: `Same as ${o.label}` })),
                ]} />
            </div>
          );
        })}
        {shown.length === 0 && <p className="di-muted di-pad">Nothing here.</p>}
        {shown.length > limit && <button className="di-more" onClick={() => setLimit((l) => l + 300)}>Show {fmtN(Math.min(300, shown.length - limit))} more of {fmtN(shown.length - limit)}</button>}
      </div>
    </>
  );
}

function CompaniesReview({ plan, st, companies, companyOptions, onChoose, onChooseMany }: {
  plan: Plan; st: IState; companies: Company[]; companyOptions: { value: string; label: string }[];
  onChoose: (key: string, v: string) => void; onChooseMany: (m: Record<string, string>) => void;
}) {
  const [q, setQ] = useState("");
  const toCheck = (c: CoEntry) => c.used && ((c.foundBy === "similar" && c.ref === c.found) || (!!c.suggest && !!c.ref?.startsWith("new:")));
  const [filter, setFilter] = useState<"all" | "check" | "new" | "found" | "skip">(plan.counts.coCheck ? "check" : "all");
  const list = plan.companies;
  const test: Record<typeof filter, (c: CoEntry) => boolean> = {
    all: () => true, check: toCheck, new: (c) => !!c.ref?.startsWith("new:"), found: (c) => !!c.ref?.startsWith("crm:"), skip: (c) => !c.ref,
  };
  const n = Object.fromEntries(Object.entries(test).map(([k, f]) => [k, list.filter(f).length])) as Record<typeof filter, number>;
  const shown = list.filter((c) => test[filter](c) && (!q.trim() || normHeader(`${c.name} ${c.data.vat_number ?? ""} ${c.data.city ?? ""}`).includes(normHeader(q))));
  const nameOf = (ref: string | null) => companies.find((x) => `crm:${x.id}` === ref)?.name;
  const suggested = list.filter((c) => c.used && c.suggest && c.ref?.startsWith("new:"));
  return (
    <>
      <div className="rv-tools">
        <label className="di-search is-small">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a company…" />
        </label>
        <div className="rv-chips">
          {([["all", "All"], ["check", "To check"], ["new", "New"], ["found", "In the CRM"], ["skip", "Not created"]] as const).filter(([k]) => k === "all" || n[k] > 0).map(([k, l]) => (
            <button key={k} className={`${filter === k ? "is-on" : ""} ${k === "check" && n[k] ? "is-warn" : ""}`} onClick={() => setFilter(k)}>{l} <i>{fmtN(n[k])}</i></button>
          ))}
        </div>
        {suggested.length > 0 && (
          <button className="ci-sugbtn is-big" onClick={() => onChooseMany(Object.fromEntries(suggested.map((c) => [c.key, `crm:${c.suggest!.id}`])))}>
            Link the {suggested.length} suggested {suggested.length === 1 ? "match" : "matches"}
          </button>
        )}
        {!st.createCompanies && <span className="rv-tools-note">New companies from the contacts are off (Options)</span>}
      </div>
      <div className="rv-list">
        {shown.slice(0, 400).map((c, i) => {
          const ch = st.companyChoice[c.key] ?? (!c.ref ? "skip" : c.ref.startsWith("new:") ? "create" : c.ref);
          const linked = nameOf(c.ref);
          const kind = !c.ref ? "skip" : c.ref.startsWith("new:") ? "new" : c.foundBy === "similar" && c.ref === c.found ? "similar" : "crm";
          const where = [c.fileRows.length ? "companies file" : null, c.contacts ? `${c.contacts} ${c.contacts === 1 ? "contact" : "contacts"}` : null].filter(Boolean).join(" · ");
          return (
            <div key={c.key} className={`rv-row is-${kind} ${c.used ? "" : "is-unused"}`} style={{ ["--j" as string]: Math.min(i, 24) } as CSSProperties}>
              <span className="rv-row-main">
                <b title={c.name}>{c.name}</b>
                <small>
                  <em className={`rv-tag is-${kind}`}>{kind === "new" ? "New" : kind === "skip" ? "Not created" : kind === "similar" ? "Similar name" : "In the CRM"}</em>
                  {c.ref?.startsWith("crm:")
                    ? <>{c.ref === c.found ? `by ${FOUND_SHORT[c.foundBy ?? "name"]}` : "picked by hand"}{linked && normHeader(linked) !== normHeader(c.name) ? <> · as <b>{linked}</b></> : null}{c.score ? ` · ${Math.round(c.score * 100)}%` : ""}</>
                    : [c.data.vat_number, c.data.city, c.data.website].filter(Boolean).join(" · ")}
                  {where && <span className="rv-n">{where}</span>}
                </small>
              </span>
              <span className="rv-row-mid">
                {!c.used ? <span className="rv-diff is-none">{c.ref ? "No imported contact links to it" : "Its contacts are imported without it"}</span>
                  : c.suggest && c.ref?.startsWith("new:") ? (
                    <button className="rv-suggest" onClick={() => onChoose(c.key, `crm:${c.suggest!.id}`)} title={c.suggest.why}>
                      Looks like <b>{c.suggest.name}</b><span>{c.suggest.why}</span><i>Link</i>
                    </button>
                  ) : c.ref?.startsWith("crm:") ? <DiffNote diff={c.diff} mode={st.coExisting} /> : null}
                {c.issues.length > 0 && <span className="ci-issue" title={c.issues.join("\n")}>{c.issues[0]}</span>}
              </span>
              <SalesMultiFilter single values={[ch]} placeholder="Choose" searchFrom={8} onChange={(v) => v[0] && onChoose(c.key, v[0])}
                options={[
                  ...(c.found ? [{ value: c.found, label: `✓ ${nameOf(c.found) ?? c.name}` }] : []),
                  { value: "create", label: `+ Create “${c.name}”` },
                  { value: "skip", label: "Don't create — no company" },
                  ...companyOptions.filter((o) => o.value !== c.found).map((o) => ({ value: o.value, label: `Link to ${o.label}` })),
                ]} />
            </div>
          );
        })}
        {shown.length === 0 && <p className="di-muted di-pad">Nothing here.</p>}
      </div>
    </>
  );
}