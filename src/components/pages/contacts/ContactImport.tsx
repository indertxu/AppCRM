/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { createPortal } from "react-dom";
import SalesMultiFilter from "../sales/sales/SalesMultiFilter";
import { useBackToClose } from "../../framework/useBackToClose";
import {
  readSpreadsheet, colLetter, cellText, normHeader, parseNumber, parseDate, parseBool,
  type SheetCell, type Workbook,
} from "../../framework/spreadsheetImport";
import {
  saveContact, saveCompany, listCompanies, listContacts,
  listContactFields, listCompanyFields, addContactField, addCompanyField, updateContactField, updateCompanyField,
  type Contact, type Company, type ContactField,
} from "../companies/companiesApi";
import { startImportBatch, finishImportBatch } from "./importBatches";
import "./ContactImport.css";

/* ═══════════════════════════ shared definitions ═══════════════════════════ */

type FieldType = ContactField["type"];
type Entity = "contact" | "company";
interface FieldDef { id: string; label: string; type: FieldType; options: string[]; required: boolean }
interface NewField { tmp: string; label: string; type: FieldType; options: string[] }
interface BaseDef { key: string; label: string }

const CONTACT_BASE: BaseDef[] = [
  { key: "first_name", label: "First name" }, { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name (split in two)" }, { key: "email", label: "Email" },
  { key: "phone", label: "Phone" }, { key: "position", label: "Position / job title" },
  { key: "company", label: "Company (linked by name)" }, { key: "notes", label: "Notes" },
  { key: "is_billing", label: "Billing contact (yes / no)" },
];
const COMPANY_BASE: BaseDef[] = [
  { key: "name", label: "Name" }, { key: "legal_name", label: "Legal name" }, { key: "vat_number", label: "VAT / tax ID" },
  { key: "reg_number", label: "Registration number" }, { key: "website", label: "Website" }, { key: "phone", label: "Phone" },
  { key: "email", label: "Email" }, { key: "street", label: "Street / address" }, { key: "addr_number", label: "Street number" },
  { key: "addr_details", label: "Address details" }, { key: "postal_code", label: "Postal code" }, { key: "city", label: "City" },
  { key: "province", label: "Province / state" }, { key: "country", label: "Country" }, { key: "notes", label: "Notes" },
];
const SYN: Record<Entity, Record<string, string[]>> = {
  contact: {
    first_name: ["first name", "firstname", "first", "given name", "nombre", "nombre de pila", "prenom", "vorname"],
    last_name: ["last name", "lastname", "last", "surname", "family name", "apellido", "apellidos", "nachname"],
    full_name: ["name", "full name", "fullname", "contact", "contact name", "nombre completo", "nombre y apellidos", "contacto", "persona"],
    email: ["email", "e mail", "mail", "email address", "correo", "correo electronico"],
    phone: ["phone", "telephone", "tel", "telefono", "mobile", "movil", "cell", "phone number", "whatsapp"],
    position: ["position", "job title", "title", "job", "role", "cargo", "puesto", "rol", "funcion"],
    company: ["company", "company name", "empresa", "compania", "organization", "organisation", "organizacion", "account", "cliente", "razon social"],
    notes: ["notes", "note", "notas", "nota", "comments", "comentarios", "observaciones", "description", "descripcion"],
    is_billing: ["billing", "billing contact", "facturacion", "contacto de facturacion"],
  },
  company: {
    name: ["name", "company", "company name", "empresa", "nombre", "nombre comercial", "nombre empresa", "compania", "account", "organization", "organizacion", "cliente", "brand", "marca"],
    legal_name: ["legal name", "razon social", "denominacion social", "nombre legal", "nombre fiscal"],
    vat_number: ["vat", "vat number", "vat id", "cif", "nif", "cif nif", "nif cif", "tax id", "tax number"],
    reg_number: ["registration number", "company number", "reg number", "registro mercantil", "numero de registro"],
    website: ["website", "web", "url", "domain", "dominio", "sitio web", "pagina web"],
    phone: ["phone", "telephone", "tel", "telefono", "centralita"],
    email: ["email", "e mail", "mail", "correo", "correo electronico", "general email"],
    street: ["street", "address", "address line 1", "direccion", "calle", "domicilio", "domicilio social"],
    addr_number: ["number", "numero", "no", "street number", "num"],
    addr_details: ["address 2", "address line 2", "piso", "puerta", "planta", "details", "floor", "suite"],
    postal_code: ["postal code", "postcode", "zip", "zip code", "codigo postal", "cp"],
    city: ["city", "ciudad", "town", "localidad", "poblacion", "municipio"],
    province: ["province", "provincia", "state", "region", "comunidad", "county"],
    country: ["country", "pais", "nation"],
    notes: ["notes", "notas", "comments", "comentarios", "observaciones", "description", "descripcion"],
  },
};
const TYPE_LABEL = { text: "Text", number: "Number", date: "Date", boolean: "Yes / No", select: "Choice list" } as Record<FieldType, string>;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
const uid = () => Math.random().toString(36).slice(2, 9);
const LEGAL = /\b(s\s?l\s?u?|s\s?a\s?u?|s\s?l\s?l|ltd|limited|llc|inc|corp|gmbh|ag|bv|nv|sarl|sas|srl|spa|plc|co)\b/g;
/** Company matching key: lowercase, no accents/punctuation, no legal suffixes ("Acme, S.L." = "ACME"). */
const nameKey = (s: string | null | undefined) => normHeader((s ?? "").replace(/\./g, "")).replace(LEGAL, " ").replace(/\s+/g, " ").trim();
const vatKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[\s.\-/]/g, "").replace(/^ES(?=[A-Z0-9]\d{7})/, "");
const domainName = (w: string) => { const h = w.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].split(".")[0]; return h ? h.charAt(0).toUpperCase() + h.slice(1) : ""; };
const fmtN = (n: number) => n.toLocaleString("es-ES");

function guessBase(entity: Entity, header: string, samples: SheetCell[]): string | null {
  const h = normHeader(header);
  const syn = SYN[entity];
  for (const k of Object.keys(syn)) if (syn[k].includes(h)) return k;
  for (const k of Object.keys(syn)) if (syn[k].some((s) => s.length > 3 && h.includes(s))) return k;
  const vals = samples.map(cellText).filter(Boolean);
  if (vals.length && vals.every((v) => EMAIL_RE.test(v))) return "email";
  if (entity === "company" && vals.length && vals.every((v) => URL_RE.test(v) && !EMAIL_RE.test(v))) return "website";
  if (vals.length && vals.every((v) => /^[+()\d][\d\s().+-]{6,}$/.test(v))) return "phone";
  return null;
}
/** One option per value ignoring case/accents/spaces, written the "nicest" way seen (capitalised, with accents). */
function canonicalOptions(values: SheetCell[]): string[] {
  const groups = new Map<string, Map<string, number>>();
  values.map((v) => cellText(v).trim()).filter(Boolean).forEach((t) => {
    const k = normHeader(t);
    const g = groups.get(k) ?? new Map<string, number>(); g.set(t, (g.get(t) ?? 0) + 1); groups.set(k, g);
  });
  const score = (t: string) => (/^[A-ZÁÉÍÓÚÑ]/.test(t) ? 4 : 0) + (/[áéíóúñ]/i.test(t) ? 2 : 0);
  const best = (g: Map<string, number>) => [...g.entries()].sort((a, b) => score(b[0]) - score(a[0]) || b[1] - a[1])[0][0];
  return [...groups.values()].map((g) => { const t = best(g); return t.charAt(0).toUpperCase() + t.slice(1); }).sort((a, b) => a.localeCompare(b));
}
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;
function guessType(values: SheetCell[]): { type: FieldType; options: string[] } {
  const vals = values.filter((v) => v != null && v !== "");
  if (!vals.length) return { type: "text" as FieldType, options: [] };
  const texts = vals.map((v) => cellText(v).trim());
  // dates first: "1981-04-14" would otherwise pass as a phone number
  if (vals.every((v) => typeof v === "object" || (typeof v === "string" && parseDate(v) && /\d/.test(v) && /[-/.]/.test(v)))) return { type: "date" as FieldType, options: [] };
  // phone numbers look like numbers but must keep their "+" and spacing
  if (texts.every((t) => PHONE_RE.test(t)) && texts.some((t) => /^\+|\s/.test(t))) return { type: "text" as FieldType, options: [] };
  // yes/no when nearly every value is (the odd "maybe" is flagged on its row)
  const bools = vals.filter((v) => parseBool(v) != null).length;
  if (bools >= Math.max(2, vals.length * 0.9) && vals.some((v) => typeof v !== "number")) return { type: "boolean" as FieldType, options: [] };
  if (vals.every((v) => typeof v === "object" || (typeof v === "string" && parseDate(v) && /\d/.test(v) && /[-/.]/.test(v)))) return { type: "date" as FieldType, options: [] };
  if (vals.every((v) => parseNumber(v) != null)) return { type: "number" as FieldType, options: [] };
  const opts = canonicalOptions(vals);
  if (opts.length <= 15 && (opts.length <= 6 || opts.length < vals.length * 0.75) && opts.every((d) => d.length <= 40)) return { type: "select" as FieldType, options: opts };
  return { type: "text" as FieldType, options: [] };
}
/** Best option for a file value: same text ignoring case/accents, or one starting with the other. */
function autoOption(options: string[], raw: string): string | null {
  const n = normHeader(raw);
  if (!n) return null;
  const exact = options.find((o) => normHeader(o) === n);
  if (exact) return exact;
  const near = options.find((o) => { const on = normHeader(o); return on.length >= 3 && n.length >= 3 && (on.startsWith(n) || n.startsWith(on)); });
  return near ?? null;
}

/* ═══════════════════════════ one file + its mapping ═══════════════════════════ */

function useSide(entity: Entity, fields: FieldDef[]) {
  const [fileName, setFileName] = useState("");
  const [wb, setWb] = useState<Workbook | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [hasHeader, setHasHeader] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [newFields, setNewFields] = useState<NewField[]>([]);
  /** target ("custom:<id>") → normalized file value → option | "__new" | "__empty" */
  const [valueMaps, setValueMaps] = useState<Record<string, Record<string, string>>>({});
  const touched = useRef(false);

  const sheet = wb?.sheets[sheetIdx] ?? null;
  const rows = useMemo(() => (sheet ? (hasHeader ? sheet.rows.slice(1) : sheet.rows) : []).filter((r) => r.some((c) => c != null && c !== "")), [sheet, hasHeader]);
  const columns = useMemo(() => {
    if (!sheet) return [];
    const width = Math.max(0, ...sheet.rows.map((r) => r.length));
    return Array.from({ length: width }, (_, i) => {
      const header = hasHeader ? cellText(sheet.rows[0]?.[i] ?? null) : "";
      const values = rows.map((r) => r[i] ?? null);
      const filled = values.filter((v) => v != null && v !== "");
      return { i, letter: colLetter(i), header: header || `Column ${colLetter(i)}`, values, filled: filled.length, samples: filled.slice(0, 3) };
    }).filter((c) => c.filled > 0 || c.header !== `Column ${c.letter}`);
  }, [sheet, hasHeader, rows]);

  // auto-map when a sheet is picked, and again once the fields have loaded (unless the user already changed it)
  useEffect(() => {
    if (!sheet || touched.current) return;
    const m: Record<number, string> = {};
    const used = new Set<string>();
    for (const c of columns) {
      const byLabel = fields.find((f) => normHeader(f.label) === normHeader(c.header));
      if (byLabel && !used.has(`custom:${byLabel.id}`)) { m[c.i] = `custom:${byLabel.id}`; used.add(m[c.i]); continue; }
      const b = guessBase(entity, c.header, c.samples);
      if (b && (!used.has(b) || b === "notes" || b === "company")) { m[c.i] = b; used.add(b); continue; }
      m[c.i] = "";
    }
    if (entity === "contact" && Object.values(m).includes("first_name")) for (const k of Object.keys(m)) if (m[+k] === "full_name") m[+k] = "";
    setMapping(m);
  }, [sheet, hasHeader, columns, fields, entity]);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null); setLoading(true); touched.current = false;
    try {
      const book = await readSpreadsheet(f);
      const best = book.sheets.reduce((bi, s, i) => (s.rows.length > book.sheets[bi].rows.length ? i : bi), 0);
      const first = book.sheets[best].rows;
      const looksHeader = !!first[0] && first[0].every((c) => c == null || (typeof c === "string" && !EMAIL_RE.test(c) && parseNumber(c) == null));
      setWb(book); setSheetIdx(best); setHasHeader(looksHeader); setFileName(f.name); setNewFields([]); setValueMaps({});
      if (!first.length) setErr("This sheet is empty.");
    } catch (e: any) { setErr(e?.message ?? "Couldn't read this file."); setWb(null); }
    setLoading(false);
  };
  const clear = () => { setWb(null); setFileName(""); setMapping({}); setNewFields([]); setValueMaps({}); setErr(null); touched.current = false; };
  const setTarget = (col: number, v: string) => {
    touched.current = true;
    if (v === "__create") {
      const c = columns.find((x) => x.i === col)!;
      const g = guessType(c.values);
      let label = c.header.trim() || `Field ${c.letter}`;
      const taken = (l: string) => fields.some((f) => normHeader(f.label) === normHeader(l)) || newFields.some((n) => normHeader(n.label) === normHeader(l));
      if (taken(label)) label = `${label} (imported)`;
      const nf: NewField = { tmp: uid(), label, type: g.type, options: g.options };
      setNewFields((xs) => [...xs, nf]);
      setMapping((m) => ({ ...m, [col]: `new:${nf.tmp}` }));
      return;
    }
    setMapping((m) => ({ ...m, [col]: v === "__none" ? "" : v }));
  };
  const patchNew = (tmp: string, patch: Partial<NewField>) => setNewFields((xs) => xs.map((n) => (n.tmp === tmp ? { ...n, ...patch } : n)));
  const removeNew = (tmp: string) => { setNewFields((xs) => xs.filter((n) => n.tmp !== tmp)); setMapping((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === `new:${tmp}` ? "" : v]))); };
  const setValueChoice = (target: string, normValue: string, choice: string) => setValueMaps((vm) => ({ ...vm, [target]: { ...(vm[target] ?? {}), [normValue]: choice } }));

  return { entity, fileName, wb, sheet, sheetIdx, setSheetIdx, hasHeader, setHasHeader, loading, err, rows, columns, mapping, newFields, valueMaps,
    pick, clear, setTarget, patchNew, removeNew, setValueChoice };
}
type Side = ReturnType<typeof useSide>;

/** Which option a file value goes to for a choice field: what the user picked, or the automatic match, or "add as new". */
const choiceFor = (side: Side, target: string, def: FieldDef, raw: string) =>
  side.valueMaps[target]?.[normHeader(raw)] ?? autoOption(def.options, raw) ?? "__new";

/** Convert one cell for a custom/new field. Returns [value, issue]. */
function convertCustom(side: Side, target: string, def: FieldDef | NewField, cell: SheetCell, isNew: boolean): [any, string | null] {
  const txt = cellText(cell).trim();
  if (def.type === "number") { const n = parseNumber(cell); return n != null ? [n, null] : [undefined, `${def.label}: “${txt}” isn't a number`]; }
  if (def.type === "date") { const d = parseDate(cell); return d ? [d, null] : [undefined, `${def.label}: “${txt}” isn't a date`]; }
  if (def.type === "boolean") { const b = parseBool(cell); return b != null ? [b, null] : [undefined, `${def.label}: “${txt}” isn't yes/no`]; }
  if (def.type === "select" && !isNew) {
    const ch = choiceFor(side, target, def as FieldDef, txt);
    if (ch === "__empty") return [undefined, null];
    if (ch === "__new") return [txt, null];
    return [ch, null];
  }
  if (def.type === "select" && isNew) return [def.options.find((o) => normHeader(o) === normHeader(txt)) ?? txt, null];
  return [txt, null];
}

/* ═══════════════════════════ component ═══════════════════════════ */

type Step = "files" | "map" | "review" | "run" | "done";
type Dup = "skip" | "update" | "new";
interface CDraft { first_name?: string; last_name?: string; email?: string; phone?: string; position?: string; notes?: string; is_billing?: boolean; companies: string[]; custom: Record<string, any> }
interface CoDraft { base: Record<string, string>; custom: Record<string, any> }

export default function ContactImport({ fields: initialFields, onClose, onDone, primary = "contact" }: {
  fields: ContactField[];
  onClose: () => void;
  onDone: () => void;
  /** Where it was opened from: that file is required and comes first; the other is optional. */
  primary?: Entity;
}) {
  useBackToClose("contact-import", onClose);
  const [contactFields, setContactFields] = useState<FieldDef[]>(initialFields as FieldDef[]);
  const [companyFields, setCompanyFields] = useState<FieldDef[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [step, setStep] = useState<Step>("files");
  const [mapTab, setMapTab] = useState<Entity>(primary);
  const [dup, setDup] = useState<Dup>("skip");
  const [coDup, setCoDup] = useState<"skip" | "update">("skip");
  const [nameFromEmail, setNameFromEmail] = useState(true);
  /** unknown company name (key) → "create" | "skip" | "crm:<id>" | "file:<row>" */
  const [unknownChoice, setUnknownChoice] = useState<Record<string, string>>({});
  /** contact row → "none" | "crm:<id>" | "file:<row>" (overrides what was found) */
  const [rowCompany, setRowCompany] = useState<Record<number, string>>({});
  const [reviewTab, setReviewTab] = useState<"all" | "nocompany" | "new" | "update" | "skip" | "error">("all");
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: "" });
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; failed: { row: number; reason: string }[]; coCreated: number; coUpdated: number; newFields: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Fresh field lists every time the importer opens — new custom fields are always selectable.
  useEffect(() => {
    listContactFields().then((f) => setContactFields(f as FieldDef[])).catch(() => {});
    listCompanyFields().then((f) => setCompanyFields(f as FieldDef[])).catch(() => {});
    listCompanies().then(setCompanies).catch(() => {});
    listContacts().then(setContacts).catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && step !== "run" && !document.querySelector(".smf-menu")) onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose, step]);

  const ct = useSide("contact", contactFields);
  const co = useSide("company", companyFields);
  const hasCo = !!co.wb && co.rows.length > 0;
  const hasCt = !!ct.wb && ct.rows.length > 0;
  const mainSide = primary === "company" ? co : ct;
  const fieldsOf = (s: Side) => (s.entity === "contact" ? contactFields : companyFields);
  const baseOf = (s: Side) => (s.entity === "contact" ? CONTACT_BASE : COMPANY_BASE);
  const defOf = (s: Side, t: string): FieldDef | NewField | null =>
    t.startsWith("custom:") ? fieldsOf(s).find((f) => f.id === t.slice(7)) ?? null
    : t.startsWith("new:") ? s.newFields.find((n) => n.tmp === t.slice(4)) ?? null : null;
  const targetOptions = (s: Side) => [
    { value: "__none", label: "Don't import" },
    ...baseOf(s).map((b) => ({ value: b.key, label: `${s.entity === "contact" ? "Contact" : "Company"} · ${b.label}` })),
    ...fieldsOf(s).map((f) => ({ value: `custom:${f.id}`, label: `Your field · ${f.label} (${TYPE_LABEL[f.type] ?? f.type})` })),
    ...s.newFields.map((n) => ({ value: `new:${n.tmp}`, label: `New field · ${n.label} (${TYPE_LABEL[n.type]})` })),
    { value: "__create", label: "+ Create a new field from this column…" },
  ];

  /* ─────────────── companies file → drafts ─────────────── */
  const coPlan = useMemo(() => {
    const out: { idx: number; status: "new" | "update" | "skip" | "error"; reason?: string; draft: CoDraft; existing?: Company; display: string }[] = [];
    if (!hasCo) return out;
    const byVat = new Map<string, Company>(), byName = new Map<string, Company>();
    companies.forEach((c) => { const v = vatKey((c as any).vat_number); if (v) byVat.set(v, c); const n = nameKey(c.name); if (n && !byName.has(n)) byName.set(n, c); });
    const seen = new Set<string>();
    co.rows.forEach((r, idx) => {
      const d: CoDraft = { base: {}, custom: {} };
      for (const [colS, t] of Object.entries(co.mapping)) {
        if (!t) continue;
        const cell = r[+colS] ?? null;
        if (cell == null || cell === "") continue;
        const txt = cellText(cell).trim();
        const def = defOf(co, t);
        if (def) { const [v] = convertCustom(co, t, def, cell, t.startsWith("new:")); if (v !== undefined) d.custom[t] = v; continue; }
        if (t === "vat_number") d.base.vat_number = txt.toUpperCase().replace(/[\s.\-/]/g, "");
        else if (t === "email") { if (EMAIL_RE.test(txt.toLowerCase())) d.base.email = txt.toLowerCase(); }
        else if (t === "postal_code" || t === "phone" || t === "addr_number") d.base[t] = typeof cell === "number" ? String(Math.round(cell)) : txt;
        else if (t === "notes") d.base.notes = d.base.notes ? `${d.base.notes}\n${txt}` : txt;
        else d.base[t] = txt;
      }
      if (!d.base.name) d.base.name = d.base.legal_name || (d.base.website ? domainName(d.base.website) : "");
      const vk = vatKey(d.base.vat_number), nk = nameKey(d.base.name);
      const existing = (vk && byVat.get(vk)) || (nk ? byName.get(nk) : undefined);
      const key = vk ? `v:${vk}` : `n:${nk}`;
      let status: "new" | "update" | "skip" | "error" = existing ? (coDup === "update" ? "update" : "skip") : "new";
      let reason: string | undefined = existing && coDup === "skip" ? "Already in the CRM" : undefined;
      if (!d.base.name) { status = "error"; reason = "No company name"; }
      else if (seen.has(key)) { status = "skip"; reason = "Repeated in the file"; }
      seen.add(key);
      out.push({ idx, status, reason, draft: d, existing, display: d.base.name || `Row ${idx + 2}` });
    });
    return out;
  }, [hasCo, co.rows, co.mapping, co.valueMaps, co.newFields, companies, companyFields, coDup]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Where a company name points: a CRM company or a row of the companies file. */
  const companyIndex = useMemo(() => {
    const idx = new Map<string, string>();
    companies.forEach((c) => { const k = nameKey(c.name); if (k && !idx.has(k)) idx.set(k, `crm:${c.id}`); const l = nameKey((c as any).legal_name); if (l && !idx.has(l)) idx.set(l, `crm:${c.id}`); });
    coPlan.forEach((p) => {
      if (p.status === "error") return;
      const ref = p.existing ? `crm:${p.existing.id}` : `file:${p.idx}`;
      [p.draft.base.name, p.draft.base.legal_name].forEach((n) => { const k = nameKey(n); if (k && !idx.has(k)) idx.set(k, ref); });
    });
    return idx;
  }, [companies, coPlan]);
  const refLabel = (ref: string) => {
    if (ref.startsWith("crm:")) return companies.find((c) => c.id === ref.slice(4))?.name ?? "Company";
    if (ref.startsWith("file:")) return coPlan.find((p) => p.idx === Number(ref.slice(5)))?.display ?? "Company";
    return ref;
  };
  const companyPickOptions = useMemo(() => [
    ...coPlan.filter((p) => p.status === "new").map((p) => ({ value: `file:${p.idx}`, label: `${p.display} · from companies file` })),
    ...companies.map((c) => ({ value: `crm:${c.id}`, label: c.name })),
  ], [coPlan, companies]);

  /* ─────────────── contacts → plan ─────────────── */
  const plan = useMemo(() => {
    const contactByEmail = new Map<string, Contact>();
    contacts.forEach((c) => { if (c.email) contactByEmail.set(c.email.trim().toLowerCase(), c); });
    const names = new Map<string, { name: string; count: number; found: string | null }>();
    const seen = new Map<string, number>();
    const rows = ct.rows.map((r, idx) => {
      const d: CDraft = { companies: [], custom: {} };
      const issues: string[] = [];
      for (const [colS, t] of Object.entries(ct.mapping)) {
        if (!t) continue;
        const cell = r[+colS] ?? null;
        if (cell == null || cell === "") continue;
        const txt = cellText(cell).trim();
        const def = defOf(ct, t);
        if (def) { const [v, issue] = convertCustom(ct, t, def, cell, t.startsWith("new:")); if (v !== undefined) d.custom[t] = v; if (issue) issues.push(issue); continue; }
        switch (t) {
          case "first_name": d.first_name = txt; break;
          case "last_name": d.last_name = txt; break;
          case "full_name": { const parts = txt.split(/\s+/); if (!d.first_name) d.first_name = parts[0]; if (!d.last_name && parts.length > 1) d.last_name = parts.slice(1).join(" "); break; }
          case "email": { const e = txt.toLowerCase(); if (EMAIL_RE.test(e)) d.email = e; else issues.push(`“${txt}” isn't a valid email`); break; }
          case "phone": d.phone = typeof cell === "number" ? String(Math.round(cell)) : txt; break;
          case "position": d.position = txt; break;
          case "notes": d.notes = d.notes ? `${d.notes}\n${txt}` : txt; break;
          case "is_billing": { const b = parseBool(cell); if (b != null) d.is_billing = b; break; }
          case "company": txt.split(/[;|\n]/).map((x) => x.trim()).filter(Boolean).forEach((n) => { if (!d.companies.includes(n)) d.companies.push(n); }); break;
        }
      }
      if (!d.first_name && nameFromEmail && d.email) {
        const local = d.email.split("@")[0].split(/[._-]+/).filter(Boolean);
        if (local[0]) d.first_name = local[0][0].toUpperCase() + local[0].slice(1);
        if (!d.last_name && local[1]) d.last_name = local.slice(1).map((x) => x[0].toUpperCase() + x.slice(1)).join(" ");
      }
      // companies: found in the CRM, in the companies file, or unknown (decided per name)
      const auto: string[] = [];
      d.companies.forEach((n) => {
        const k = nameKey(n);
        const found = companyIndex.get(k) ?? null;
        const e = names.get(k) ?? { name: n, count: 0, found };
        e.count++; names.set(k, e);
        const choice = found ? (unknownChoice[k] && unknownChoice[k] !== "create" ? unknownChoice[k] : found) : (unknownChoice[k] ?? "create");
        if (choice === "skip") return;
        auto.push(choice === "create" ? `new:${k}` : choice);
      });
      const override = rowCompany[idx];
      const refs = override === "none" ? [] : override ? [override] : [...new Set(auto)];
      const existing = d.email ? contactByEmail.get(d.email) : undefined;
      let status: "new" | "update" | "skip" | "error" = "new"; let reason: string | undefined;
      if (!d.first_name && !(existing && dup === "update")) { status = "error"; reason = "No name"; }
      else if (d.email && seen.has(d.email)) { status = "skip"; reason = `Same email as row ${seen.get(d.email)! + (ct.hasHeader ? 2 : 1)}`; }
      else if (existing) { status = dup === "skip" ? "skip" : dup; if (dup === "skip") reason = "Already in the CRM"; }
      if (d.email && !seen.has(d.email)) seen.set(d.email, idx);
      if (status === "new" || status === "update") {
        const missing = contactFields.filter((f) => f.required).filter((f) => {
          const v = d.custom[`custom:${f.id}`] ?? (status === "update" ? (existing as any)?.custom?.[f.id] : undefined);
          return v == null || v === "" || (f.type === "boolean" && v === false);
        });
        if (missing.length) { status = "error"; reason = `Required: ${missing.map((f) => f.label).join(", ")}`; }
      }
      return { idx, status, reason, issues, draft: d, existing: status === "update" ? existing : undefined, refs };
    });
    return { rows, names: [...names.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => (a.found ? 1 : 0) - (b.found ? 1 : 0) || b.count - a.count) };
  }, [ct.rows, ct.mapping, ct.valueMaps, ct.newFields, ct.hasHeader, contactFields, contacts, companyIndex, unknownChoice, rowCompany, dup, nameFromEmail]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = { new: 0, update: 0, skip: 0, error: 0, nocompany: 0 };
    plan.rows.forEach((r) => { c[r.status]++; if ((r.status === "new" || r.status === "update") && !r.refs.length) c.nocompany++; });
    return c;
  }, [plan]);
  const coCounts = { new: coPlan.filter((p) => p.status === "new").length, update: coPlan.filter((p) => p.status === "update").length, skip: coPlan.filter((p) => p.status === "skip").length };
  const linksCreate = plan.names.filter((n) => !n.found && (unknownChoice[n.key] ?? "create") === "create").length;

  /* ─────────────── import ─────────────── */
  const run = async () => {
    setStep("run"); setErr(null);
    const todo = plan.rows.filter((r) => r.status === "new" || r.status === "update");
    const failed: { row: number; reason: string }[] = [];
    let created = 0, updated = 0, coCreated = 0, coUpdated = 0, newFieldCount = 0;
    // who imported what, and when: one batch for the contacts, one for any companies it creates
    const contactBatch = todo.some((r) => r.status === "new") ? await startImportBatch("contact", ct.fileName) : null;
    let companyBatchP: Promise<string | null> | null = null; // opened once, only if companies get created
    const coBatch = () => (companyBatchP ??= startImportBatch("company", hasCo ? co.fileName : `${ct.fileName} (companies named in the contacts)`));
    try {
      // 1) new fields, both sides
      const tmpIds = { contact: new Map<string, string>(), company: new Map<string, string>() };
      for (const s of [ct, co]) {
        const used = s.newFields.filter((n) => Object.values(s.mapping).includes(`new:${n.tmp}`));
        if (!used.length) continue;
        setProgress({ done: 0, total: todo.length, phase: "Creating fields…" });
        const existing = fieldsOf(s);
        for (const [k, n] of used.entries()) {
          const input = { label: n.label.trim(), type: n.type, required: false, options: n.type === "select" ? n.options : [], sort: existing.length + k };
          const f: any = s.entity === "contact" ? await addContactField(input) : await addCompanyField(input as any);
          if (f?.id) { tmpIds[s.entity].set(n.tmp, f.id); newFieldCount++; }
        }
        if (tmpIds[s.entity].size < used.length) {
          const fresh: FieldDef[] = (s.entity === "contact" ? await listContactFields() : await listCompanyFields()) as FieldDef[];
          used.forEach((n) => { if (!tmpIds[s.entity].has(n.tmp)) { const f = [...fresh].reverse().find((x) => normHeader(x.label) === normHeader(n.label)); if (f) tmpIds[s.entity].set(n.tmp, f.id); } });
        }
      }
      // 2) new options for existing choice lists (values set to "add as new option")
      for (const s of [ct, co]) {
        for (const [colS, t] of Object.entries(s.mapping)) {
          if (!t.startsWith("custom:")) continue;
          const def = defOf(s, t) as FieldDef | null;
          if (!def || def.type !== "select") continue;
          const add = new Set<string>();
          s.columns.find((c) => c.i === +colS)?.values.forEach((v) => {
            const txt = cellText(v).trim();
            if (txt && choiceFor(s, t, def, txt) === "__new" && !def.options.some((o) => normHeader(o) === normHeader(txt))) add.add(txt);
          });
          if (add.size) {
            const options = [...def.options, ...add];
            if (s.entity === "contact") await updateContactField(def.id, { options }); else await updateCompanyField(def.id, { options });
          }
        }
      }
      const resolveCustom = (entity: Entity, custom: Record<string, any>) => {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(custom)) { const id = k.startsWith("custom:") ? k.slice(7) : tmpIds[entity].get(k.slice(4)); if (id) out[id] = v; }
        return out;
      };
      // 3) companies file
      const fileIds = new Map<number, string>();
      const coTodo = coPlan.filter((p) => p.status === "new" || p.status === "update");
      if (coTodo.length) {
        setProgress({ done: 0, total: coTodo.length, phase: "Importing companies…" });
        let k = 0;
        for (const p of coTodo) {
          const b = p.draft.base;
          let c: any;
          if (p.status === "update" && p.existing) {
            c = { ...p.existing };
            Object.entries(b).forEach(([key, v]) => { if (key === "notes") c.notes = c.notes ? `${c.notes}\n${v}` : v; else if (v) c[key] = v; });
            c.custom = { ...(p.existing as any).custom ?? {}, ...resolveCustom("company", p.draft.custom) };
          } else {
            c = { ...b, name: b.name, custom: resolveCustom("company", p.draft.custom), import_batch_id: await coBatch() };
          }
          const e = await saveCompany(c as Company).catch((x: any) => x?.message ?? "Failed");
          if (e) failed.push({ row: p.idx + (co.hasHeader ? 2 : 1), reason: `Company: ${e}` });
          else { if (c.id) fileIds.set(p.idx, c.id); if (p.status === "update") coUpdated++; else coCreated++; }
          setProgress((x) => ({ ...x, done: ++k }));
        }
      }
      // 4) companies only named in the contacts file
      const newIds = new Map<string, string>();
      const toCreate = plan.names.filter((n) => !n.found && (unknownChoice[n.key] ?? "create") === "create" && plan.rows.some((r) => r.refs.includes(`new:${n.key}`)));
      if (toCreate.length) {
        setProgress({ done: 0, total: toCreate.length, phase: "Creating companies…" });
        let k = 0;
        for (const n of toCreate) {
          const c: any = { name: n.name, import_batch_id: await coBatch() };
          const e = await saveCompany(c);
          if (!e && c.id) { newIds.set(n.key, c.id); coCreated++; }
          setProgress((x) => ({ ...x, done: ++k }));
        }
      }
      const resolveRef = (ref: string): string | null =>
        ref.startsWith("crm:") ? ref.slice(4) : ref.startsWith("file:") ? fileIds.get(Number(ref.slice(5))) ?? null : ref.startsWith("new:") ? newIds.get(ref.slice(4)) ?? null : null;
      // 5) contacts (4 at a time)
      setProgress({ done: 0, total: todo.length, phase: "Importing contacts…" });
      let cursor = 0, done = 0;
      const worker = async () => {
        while (cursor < todo.length) {
          const r = todo[cursor++];
          const d = r.draft;
          const companyIds = [...new Set(r.refs.map(resolveRef).filter((x): x is string => !!x))];
          let c: any;
          if (r.status === "update" && r.existing) {
            const ex: any = r.existing;
            c = { ...ex, first_name: d.first_name || ex.first_name, last_name: d.last_name ?? ex.last_name, position: d.position ?? ex.position,
              email: d.email ?? ex.email, phone: d.phone ?? ex.phone, is_billing: d.is_billing ?? ex.is_billing,
              notes: d.notes ? (ex.notes ? `${ex.notes}\n${d.notes}` : d.notes) : ex.notes,
              companyIds: [...new Set([...(ex.companyIds ?? []), ...companyIds])], custom: { ...(ex.custom ?? {}), ...resolveCustom("contact", d.custom) } };
          } else {
            c = { first_name: d.first_name ?? "", last_name: d.last_name ?? null, position: d.position ?? null, email: d.email ?? null, phone: d.phone ?? null,
              is_billing: d.is_billing ?? false, notes: d.notes ?? null, companyIds, custom: resolveCustom("contact", d.custom), import_batch_id: contactBatch };
          }
          const e = await saveContact(c as Contact).catch((x: any) => x?.message ?? "Failed");
          if (e) failed.push({ row: r.idx + (ct.hasHeader ? 2 : 1), reason: String(e) }); else if (r.status === "update") updated++; else created++;
          done++; setProgress((x) => ({ ...x, done }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, todo.length || 1) }, worker));
    } catch (e: any) { setErr(e?.message ?? "The import stopped unexpectedly."); }
    await finishImportBatch(contactBatch, created, updated);
    if (companyBatchP) await finishImportBatch(await companyBatchP, coCreated, coUpdated);
    plan.rows.filter((r) => r.status === "error").forEach((r) => failed.push({ row: r.idx + (ct.hasHeader ? 2 : 1), reason: r.reason ?? "Error" }));
    failed.sort((a, b) => a.row - b.row);
    setResult({ created, updated, skipped: plan.rows.filter((r) => r.status === "skip").length, failed, coCreated, coUpdated, newFields: newFieldCount });
    setStep("done");
    onDone();
  };

  /* ─────────────── downloads ─────────────── */
  const download = (name: string, lines: string[][]) => {
    const esc = (s: string) => (/[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const blob = new Blob(["\uFEFF" + lines.map((l) => l.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const template = (e: Entity) => download(`${e === "contact" ? "contacts" : "companies"}-template.csv`, [[
    ...(e === "contact" ? CONTACT_BASE.filter((b) => b.key !== "full_name") : COMPANY_BASE).map((b) => b.label.replace(/ \(.*\)$/, "")),
    ...(e === "contact" ? contactFields : companyFields).map((f) => f.label),
  ]]);
  const downloadErrors = () => {
    if (!result || !ct.sheet) return;
    download(`${ct.fileName.replace(/\.[^.]+$/, "")}-import-errors.csv`, [["Row", "Problem", ...(ct.hasHeader ? ct.sheet.rows[0].map(cellText) : ct.columns.map((c) => c.header))],
      ...result.failed.map((f) => [String(f.row), f.reason, ...(ct.sheet!.rows[f.row - 1] ?? []).map(cellText)])]);
  };

  /* ─────────────── validation per step ─────────────── */
  const mapProblem = (s: Side): string | null => {
    const used = Object.values(s.mapping).filter(Boolean);
    if (!used.length) return `Map at least one ${s.entity === "contact" ? "contact" : "company"} column.`;
    if (s.entity === "contact" && !(used.includes("first_name") || used.includes("full_name") || (nameFromEmail && used.includes("email")))) return "Map a first name or full name (or use the email) for contacts.";
    if (s.entity === "company" && !(used.includes("name") || used.includes("legal_name") || used.includes("website"))) return "Map the company name (or legal name / website).";
    const bad = s.newFields.find((n) => !n.label.trim() || fieldsOf(s).some((f) => normHeader(f.label) === normHeader(n.label)) || s.newFields.some((o) => o.tmp !== n.tmp && normHeader(o.label) === normHeader(n.label)));
    if (bad) return `New field “${bad.label || "untitled"}” needs a unique name.`;
    return null;
  };
  const mapIssue = (hasCt ? mapProblem(ct) : null) ?? (hasCo ? mapProblem(co) : null);

  const STEPS: { key: Step; label: string }[] = [{ key: "files", label: "Files" }, { key: "map", label: "Map columns" }, { key: "review", label: "Review & link" }, { key: "done", label: "Import" }];
  const stepIdx = step === "run" ? 3 : STEPS.findIndex((s) => s.key === step);

  /* ─────────────── pieces of UI ─────────────── */
  const dropZone = (s: Side, title: string, hint: string, optional: boolean) => (
    <DropCard side={s} title={title} hint={hint} optional={optional} onTemplate={() => template(s.entity)} />
  );

  const mapRows = (s: Side) => {
    const used = Object.values(s.mapping).filter(Boolean);
    const dups = new Set(used.filter((t, i) => used.indexOf(t) !== i && t !== "notes" && t !== "company"));
    return (
      <div className="ci2-maplist">
        {s.columns.map((c, k) => {
          const t = s.mapping[c.i] ?? "";
          const def = t ? defOf(s, t) : null;
          const nf = t.startsWith("new:") ? (def as NewField) : null;
          const isChoice = !!def && def.type === "select" && t.startsWith("custom:");
          const distinct = isChoice ? [...new Map(c.values.map((v) => cellText(v).trim()).filter(Boolean).map((v) => [normHeader(v), v])).values()] : [];
          const countOf = (v: string) => c.values.filter((x) => normHeader(cellText(x).trim()) === normHeader(v)).length;
          const unmatched = isChoice ? distinct.filter((v) => choiceFor(s, t, def as FieldDef, v) === "__new").length : 0;
          return (
            <div key={c.i} className={`ci2-map ${t ? "is-mapped" : ""} ${dups.has(t) ? "is-dup" : ""}`} style={{ ["--i" as string]: Math.min(k, 16) } as CSSProperties}>
              <div className="ci2-map-row">
                <span className="ci2-col"><em>{c.letter}</em><span><b title={c.header}>{c.header}</b><small>{c.filled} filled</small></span></span>
                <span className="ci2-samples">{c.samples.length ? c.samples.map((x, i) => <span key={i} title={cellText(x)}>{cellText(x)}</span>) : <i>empty</i>}</span>
                <svg className="ci2-arrow" viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                <div className="ci2-target">
                  <SalesMultiFilter single values={[t || "__none"]} onChange={(v) => v[0] && s.setTarget(c.i, v[0])} options={targetOptions(s)} placeholder="Choose a field" searchFrom={8} />
                  {dups.has(t) && <small className="ci2-warn">Also used by another column — the last filled one wins</small>}
                </div>
              </div>

              {nf && (
                <div className="ci2-newfield">
                  <span className="ci2-tag">New field</span>
                  <input value={nf.label} onChange={(e) => s.patchNew(nf.tmp, { label: e.target.value })} placeholder="Field name" aria-label="New field name" />
                  <SalesMultiFilter single values={[nf.type]} onChange={(v) => v[0] && s.patchNew(nf.tmp, { type: v[0] as FieldType, options: v[0] === "select" ? guessType(c.values).options : [] })}
                    options={(Object.keys(TYPE_LABEL) as FieldType[]).map((x) => ({ value: x, label: TYPE_LABEL[x] }))} placeholder="Type" />
                  <button onClick={() => s.removeNew(nf.tmp)} aria-label="Don't create this field">×</button>
                  {nf.type === "select" && <span className="ci2-newopts">{nf.options.length} options from the file: {nf.options.slice(0, 8).join(", ")}{nf.options.length > 8 ? "…" : ""}</span>}
                </div>
              )}

              {isChoice && distinct.length > 0 && (
                <div className="ci2-values">
                  <div className="ci2-values-h">
                    <b>Match the values to “{(def as FieldDef).label}”</b>
                    <span>{distinct.length - unmatched} matched{unmatched ? ` · ${unmatched} not in your list` : ""}</span>
                  </div>
                  <div className="ci2-values-grid">
                    {distinct.map((v, j) => {
                      const ch = choiceFor(s, t, def as FieldDef, v);
                      return (
                        <div className={`ci2-val ${ch === "__new" ? "is-new" : ch === "__empty" ? "is-empty" : "is-ok"}`} key={v} style={{ ["--j" as string]: j } as CSSProperties}>
                          <span className="ci2-val-from"><b>{v}</b><small>{countOf(v)}×</small></span>
                          <svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
                          <SalesMultiFilter single values={[ch]} onChange={(x) => x[0] && s.setValueChoice(t, normHeader(v), x[0])} placeholder="Choose" searchFrom={10}
                            options={[
                              ...(def as FieldDef).options.map((o) => ({ value: o, label: o })),
                              { value: "__new", label: `+ Add “${v}” as a new option` },
                              { value: "__empty", label: "Leave empty" },
                            ]} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const shownRows = plan.rows.filter((r) =>
    reviewTab === "all" ? true : reviewTab === "nocompany" ? (r.status === "new" || r.status === "update") && !r.refs.length : r.status === reviewTab).slice(0, 250);
  const nameCol = (r: (typeof plan.rows)[number]) => [r.draft.first_name, r.draft.last_name].filter(Boolean).join(" ") || "—";

  return createPortal(
    <div className="ci-backdrop" onMouseDown={() => step !== "run" && onClose()}>
      <div className="ci ci2" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Import contacts">
        <header className="ci-head">
          <div className="ci-head-txt">
            <span className="ci-eyebrow">Import</span>
            <h2>{hasCo && hasCt ? (primary === "company" ? "Companies + contacts" : "Contacts + companies") : primary === "company" ? "Companies" : "Contacts"}</h2>
          </div>
          <ol className="ci-steps" style={{ ["--k" as string]: stepIdx } as CSSProperties}>
            <span className="ci-steps-bar"><i /></span>
            {STEPS.map((s, i) => <li key={s.key} className={i < stepIdx ? "is-done" : i === stepIdx ? "is-on" : ""}><b>{i < stepIdx ? "✓" : i + 1}</b>{s.label}</li>)}
          </ol>
          <button className="ci-x" onClick={onClose} disabled={step === "run"} aria-label="Close">×</button>
        </header>

        <div className="ci-body">
          {/* ═════ 1. FILES ═════ */}
          {step === "files" && (
            <div className="ci2-files">
              {primary === "company" ? (
                <>
                  {dropZone(co, "Companies", "The companies to import — required", false)}
                  {dropZone(ct, "Contacts", "Optional — imported too, and linked to these companies automatically", true)}
                </>
              ) : (
                <>
                  {dropZone(ct, "Contacts", "The people to import — required", false)}
                  {dropZone(co, "Companies", "Optional — imported too, and linked to the contacts automatically", true)}
                </>
              )}
            </div>
          )}

          {/* ═════ 2. MAP ═════ */}
          {step === "map" && (
            <div className="ci2-mapwrap">
              {hasCo && hasCt && (
                <div className="ci2-tabs" data-tab={mapTab} data-first={primary}>
                  {(primary === "company" ? (["company", "contact"] as Entity[]) : (["contact", "company"] as Entity[])).map((e) => (
                    <button key={e} className={mapTab === e ? "is-on" : ""} onClick={() => setMapTab(e)}>
                      {e === "contact" ? "Contacts" : "Companies"} <i>{(e === "contact" ? ct : co).columns.length} columns</i>{mapProblem(e === "contact" ? ct : co) && <em>!</em>}
                    </button>
                  ))}
                  <span className="ci2-tabs-ink" />
                </div>
              )}
              <div className="ci2-mapgrid" key={mapTab}>
                {mapRows(!(hasCo && hasCt) ? mainSide : mapTab === "contact" ? ct : co)}
                <aside className="ci2-side">
                  {(() => {
                    const s = !(hasCo && hasCt) ? mainSide : mapTab === "contact" ? ct : co;
                    const used = Object.values(s.mapping).filter(Boolean);
                    const essentials = s.entity === "contact" ? CONTACT_BASE.filter((b) => b.key !== "full_name") : COMPANY_BASE.filter((b) => ["name", "legal_name", "vat_number", "website", "email", "phone", "city", "country"].includes(b.key));
                    return (
                      <>
                        <h4>{s.entity === "contact" ? "Contact fields" : "Company fields"}</h4>
                        <ul className="ci2-checks">
                          {essentials.map((b) => {
                            const on = used.includes(b.key) || (s.entity === "contact" && ["first_name", "last_name"].includes(b.key) && used.includes("full_name"));
                            return <li key={b.key} className={on ? "is-on" : ""}><i>{on ? "✓" : ""}</i>{b.label}</li>;
                          })}
                          {fieldsOf(s).map((f) => { const on = used.includes(`custom:${f.id}`); return <li key={f.id} className={on ? "is-on" : ""}><i>{on ? "✓" : ""}</i>{f.label}{f.required && !on && <em>required</em>}</li>; })}
                        </ul>
                        {s.newFields.length > 0 && <><h4>Will be created</h4><ul className="ci2-checks">{s.newFields.map((n) => <li key={n.tmp} className="is-new"><i>+</i>{n.label || "Untitled"}<em>{TYPE_LABEL[n.type]}</em></li>)}</ul></>}
                        {s.entity === "contact" && (
                          <label className="ci-check"><input type="checkbox" checked={nameFromEmail} onChange={(e) => setNameFromEmail(e.target.checked)} /><span className="ci-box" />No name? Use the email (ana.lopez@… → Ana Lopez)</label>
                        )}
                      </>
                    );
                  })()}
                </aside>
              </div>
            </div>
          )}

          {/* ═════ 3. REVIEW & LINK ═════ */}
          {step === "review" && (
            <div className="ci2-review">
              <div className="ci2-tiles">
                {hasCt && <>
                  <div className="is-new"><b>{counts.new}</b>new contacts</div>
                  <div className="is-update"><b>{counts.update}</b>contacts updated</div>
                  <div className="is-skip"><b>{counts.skip}</b>contacts skipped</div>
                  <div className="is-error"><b>{counts.error}</b>with errors</div>
                </>}
                {(hasCo || linksCreate > 0) && <div className="is-co"><b>{coCounts.new + linksCreate}</b>new companies{coCounts.update ? ` · ${coCounts.update} updated` : ""}</div>}
                {hasCo && !hasCt && <>
                  <div className="is-update"><b>{coCounts.update}</b>companies updated</div>
                  <div className="is-skip"><b>{coCounts.skip}</b>already in the CRM</div>
                  <div className="is-error"><b>{coPlan.filter((p) => p.status === "error").length}</b>with errors</div>
                </>}
              </div>

              <div className="ci2-opts">
                {hasCt && <div className="ci-opt"><label>Contacts already in the CRM (same email)</label>
                  <div className="ci-seg">{(["skip", "update", "new"] as Dup[]).map((d) => <button key={d} className={dup === d ? "is-on" : ""} onClick={() => setDup(d)}>{d === "skip" ? "Skip" : d === "update" ? "Update" : "Import anyway"}</button>)}</div>
                </div>}
                {hasCo && (
                  <div className="ci-opt"><label>Companies in the file that are already in the CRM</label>
                    <div className="ci-seg">
                      <button className={coDup === "skip" ? "is-on" : ""} onClick={() => setCoDup("skip")}>{hasCt ? "Link only" : "Leave as they are"}</button>
                      <button className={coDup === "update" ? "is-on" : ""} onClick={() => setCoDup("update")}>{hasCt ? "Link and update" : "Update them"}</button>
                    </div>
                  </div>
                )}
              </div>

              {plan.names.length > 0 && (
                <section className="ci2-links">
                  <div className="ci2-sec-h">
                    <h3>Companies in your contacts</h3>
                    <span className="ci2-legend"><i className="is-crm" />In CRM <b>{plan.names.filter((n) => n.found?.startsWith("crm:")).length}</b> <i className="is-file" />In companies file <b>{plan.names.filter((n) => n.found?.startsWith("file:")).length}</b> <i className="is-none" />Not found <b>{plan.names.filter((n) => !n.found).length}</b></span>
                    {plan.names.some((n) => !n.found) && (
                      <span className="ci2-bulk">
                        <button onClick={() => setUnknownChoice((u) => ({ ...u, ...Object.fromEntries(plan.names.filter((n) => !n.found).map((n) => [n.key, "create"])) }))}>Create all missing</button>
                        <button onClick={() => setUnknownChoice((u) => ({ ...u, ...Object.fromEntries(plan.names.filter((n) => !n.found).map((n) => [n.key, "skip"])) }))}>Link none</button>
                      </span>
                    )}
                  </div>
                  <div className="ci2-links-grid">
                    {plan.names.map((n, i) => {
                      const ch = unknownChoice[n.key];
                      const where = n.found?.startsWith("crm:") ? "crm" : n.found?.startsWith("file:") ? "file" : "none";
                      const value = ch ?? (n.found ?? "create");
                      return (
                        <div className={`ci2-link is-${where}`} key={n.key} style={{ ["--j" as string]: Math.min(i, 20) } as CSSProperties}>
                          <span className="ci2-link-dot" />
                          <span className="ci2-link-name"><b>{n.name}</b><small>{n.count} {n.count === 1 ? "contact" : "contacts"} · {where === "crm" ? `found in CRM${refLabel(n.found!) !== n.name ? ` as ${refLabel(n.found!)}` : ""}` : where === "file" ? "found in companies file" : "not found"}</small></span>
                          <SalesMultiFilter single values={[value]} onChange={(v) => v[0] && setUnknownChoice((u) => ({ ...u, [n.key]: v[0] }))} placeholder="Choose" searchFrom={8}
                            options={[
                              ...(n.found ? [{ value: n.found, label: `✓ ${refLabel(n.found)}` }] : [{ value: "create", label: `+ Create “${n.name}”` }]),
                              { value: "skip", label: "Don't link" },
                              ...companyPickOptions.filter((o) => o.value !== n.found).map((o) => ({ value: o.value, label: `Link to ${o.label}` })),
                            ]} />
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {hasCt && <section className="ci2-rows">
                <div className="ci2-sec-h">
                  <h3>Contacts</h3>
                  <div className="ci-seg is-tabs">
                    {([["all", "All", plan.rows.length], ["nocompany", "No company", counts.nocompany], ["new", "New", counts.new], ["update", "Update", counts.update], ["skip", "Skipped", counts.skip], ["error", "Errors", counts.error]] as const).map(([k, l, n]) => (
                      <button key={k} className={`${reviewTab === k ? "is-on" : ""} ${k === "nocompany" && n ? "is-warn" : ""}`} onClick={() => setReviewTab(k)}>{l} <i>{n}</i></button>
                    ))}
                  </div>
                </div>
                <div className="ci2-table">
                  <div className="ci2-tr is-head"><span>Row</span><span>Contact</span><span>Email</span><span>Company</span><span>Result</span></div>
                  {shownRows.map((r) => {
                    const importing = r.status === "new" || r.status === "update";
                    const noCo = importing && !r.refs.length;
                    return (
                      <div className={`ci2-tr is-${r.status} ${noCo ? "is-nocompany" : ""}`} key={r.idx}>
                        <span className="ci2-rn">{r.idx + (ct.hasHeader ? 2 : 1)}</span>
                        <span className="ci2-cname"><b>{nameCol(r)}</b>{r.draft.position && <small>{r.draft.position}</small>}</span>
                        <span className="ci2-cemail">{r.draft.email ?? "—"}</span>
                        <span className="ci2-cco">
                          {importing ? (
                            <SalesMultiFilter single values={[rowCompany[r.idx] ?? (r.refs[0] ?? "none")]} placeholder="Link to a company…" searchFrom={8}
                              onChange={(v) => v[0] && setRowCompany((m) => ({ ...m, [r.idx]: v[0] }))}
                              options={[
                                { value: "none", label: noCo ? "No company — link one…" : "No company" },
                                ...r.refs.filter((x) => x.startsWith("new:")).map((x) => ({ value: x, label: `+ ${plan.names.find((n) => `new:${n.key}` === x)?.name ?? "New company"} (new)` })),
                                ...companyPickOptions,
                              ]} />
                          ) : <span className="ci2-muted">{r.draft.companies.join(", ") || "—"}</span>}
                          {importing && r.refs.length > 1 && <small>+{r.refs.length - 1} more</small>}
                        </span>
                        <span className="ci2-res">
                          <span className={`ci-pill is-${r.status}`}>{r.status === "new" ? "New" : r.status === "update" ? "Update" : r.status === "skip" ? "Skip" : "Error"}</span>
                          {(r.reason || r.issues.length > 0) && <small title={[r.reason, ...r.issues].filter(Boolean).join("\n")}>{r.reason ?? r.issues[0]}</small>}
                        </span>
                      </div>
                    );
                  })}
                  {shownRows.length === 0 && <p className="ci2-muted ci2-pad">Nothing here.</p>}
                </div>
              </section>}
              {!hasCt && hasCo && (
                <section className="ci2-rows">
                  <div className="ci2-sec-h"><h3>Companies</h3></div>
                  <div className="ci2-table">
                    <div className="ci2-tr is-head is-co"><span>Row</span><span>Company</span><span>VAT / city</span><span>Result</span></div>
                    {coPlan.slice(0, 250).map((p) => (
                      <div className={`ci2-tr is-co is-${p.status}`} key={p.idx}>
                        <span className="ci2-rn">{p.idx + (co.hasHeader ? 2 : 1)}</span>
                        <span className="ci2-cname"><b>{p.display}</b>{p.draft.base.legal_name && <small>{p.draft.base.legal_name}</small>}</span>
                        <span className="ci2-cemail">{[p.draft.base.vat_number, p.draft.base.city].filter(Boolean).join(" · ") || "—"}</span>
                        <span className="ci2-res"><span className={`ci-pill is-${p.status}`}>{p.status === "new" ? "New" : p.status === "update" ? "Update" : p.status === "skip" ? "Skip" : "Error"}</span>{p.reason && <small>{p.reason}</small>}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {/* ═════ 4. RUN / DONE ═════ */}
          {(step === "run" || step === "done") && (
            <div className="ci-run">
              {step === "run" ? (
                <>
                  <div className="ci-ring" style={{ ["--p" as string]: progress.total ? progress.done / progress.total : 0 } as CSSProperties}>
                    <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" pathLength={100} /><circle cx="60" cy="60" r="52" pathLength={100} className="is-fg" /></svg>
                    <b>{progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%</b>
                  </div>
                  <h3>{progress.phase || "Importing…"}</h3>
                  <p>{fmtN(progress.done)} of {fmtN(progress.total)} · keep this window open</p>
                </>
              ) : result && (
                <>
                  <span className={`ci-done-ico ${result.failed.length ? "is-partial" : ""}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
                  <h3>{result.failed.length ? "Imported with some problems" : "Import complete"}</h3>
                  <div className="ci-sum is-final">
                    {hasCt ? <>
                      <div className="is-new"><b>{result.created}</b>contacts created</div>
                      <div className="is-update"><b>{result.updated}</b>contacts updated</div>
                      <div className="is-skip"><b>{result.coCreated}</b>companies created{result.coUpdated ? ` · ${result.coUpdated} updated` : ""}</div>
                    </> : <>
                      <div className="is-new"><b>{result.coCreated}</b>companies created</div>
                      <div className="is-update"><b>{result.coUpdated}</b>companies updated</div>
                      <div className="is-skip"><b>{coCounts.skip}</b>skipped</div>
                    </>}
                    <div className="is-error"><b>{result.failed.length}</b>not imported</div>
                  </div>
                  {result.newFields > 0 && <p>Also created {result.newFields} new {result.newFields === 1 ? "field" : "fields"}.</p>}
                  {err && <p className="ci-err">{err}</p>}
                  {result.failed.length > 0 && (
                    <div className="ci-failed">
                      {result.failed.slice(0, 8).map((f, i) => <span key={i}><b>Row {f.row}</b>{f.reason}</span>)}
                      {result.failed.length > 8 && <span><b>…</b>{result.failed.length - 8} more in the report</span>}
                      <button className="ci-link" onClick={downloadErrors}>Download the error report (CSV)</button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {step !== "run" && (
          <footer className="ci-foot">
            <span className={`ci-foot-note ${step === "map" && mapIssue ? "is-warn" : ""}`}>
              {step === "files" && (mainSide.wb ? [hasCo && `${fmtN(co.rows.length)} companies`, hasCt && `${fmtN(ct.rows.length)} contacts`].filter(Boolean).join(" · ") + " ready to map" : "Nothing is changed until the last step.")}
              {step === "map" && (mapIssue ?? "All set — next, review what will happen and link the companies.")}
              {step === "review" && [hasCt && `${counts.new + counts.update} contacts will be saved${counts.nocompany ? ` (${counts.nocompany} without a company)` : ""}`, hasCo && `${coCounts.new + coCounts.update} companies from the file`].filter(Boolean).join(" · ") + "."}
            </span>
            <div className="ci-foot-actions">
              {step === "map" && <button className="ci-btn is-ghost" onClick={() => setStep("files")}>Back</button>}
              {step === "review" && <button className="ci-btn is-ghost" onClick={() => setStep("map")}>Back to mapping</button>}
              {step === "done" ? <button className="ci-btn is-primary" onClick={onClose}>Done</button> : <button className="ci-btn is-ghost" onClick={onClose}>Cancel</button>}
              {step === "files" && <button className="ci-btn is-primary" disabled={!mainSide.wb || !mainSide.rows.length} onClick={() => { setMapTab(primary); setStep("map"); }}>Map columns →</button>}
              {step === "map" && <button className="ci-btn is-primary" disabled={!!mapIssue} onClick={() => { setReviewTab(hasCt && counts.nocompany ? "nocompany" : "all"); setStep("review"); }}>Review →</button>}
              {step === "review" && (() => {
                const nC = hasCt ? counts.new + counts.update : 0, nCo = coCounts.new + coCounts.update + linksCreate;
                const parts = primary === "company"
                  ? [nCo && `${nCo} ${nCo === 1 ? "company" : "companies"}`, nC && `${nC} ${nC === 1 ? "contact" : "contacts"}`]
                  : [nC && `${nC} ${nC === 1 ? "contact" : "contacts"}`, nCo && `${nCo} ${nCo === 1 ? "company" : "companies"}`];
                return <button className="ci-btn is-primary" disabled={!(nC + nCo)} onClick={run}>Import {parts.filter(Boolean).join(" + ") || "nothing"}</button>;
              })()}
            </div>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ═══════════════════════════ a file drop card ═══════════════════════════ */

function DropCard({ side: s, title, hint, optional, onTemplate }: { side: Side; title: string; hint: string; optional: boolean; onTemplate: () => void }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); s.pick(e.dataTransfer.files?.[0]); };
  const mapped = Object.values(s.mapping).filter(Boolean).length;
  return (
    <section className={`ci2-drop ${s.wb ? "has-file" : ""} ${optional ? "is-optional" : ""}`}>
      <header>
        <span className={`ci2-drop-ico is-${s.entity}`}>
          {s.entity === "contact"
            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4M9 9h.01M15 9h.01M9 13h.01M15 13h.01" /></svg>}
        </span>
        <span><h3>{title}{optional && <em>optional</em>}</h3><p>{hint}</p></span>
        {s.wb && <button className="ci2-drop-clear" onClick={s.clear}>Remove</button>}
      </header>

      {!s.wb ? (
        <div className={`ci2-zone ${drag ? "is-drag" : ""}`} role="button" tabIndex={0}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
          onClick={() => ref.current?.click()} onKeyDown={(e) => e.key === "Enter" && ref.current?.click()}>
          <input ref={ref} type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt,.xls" hidden onChange={(e) => { s.pick(e.target.files?.[0]); e.target.value = ""; }} />
          <span className="ci2-zone-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg></span>
          <span className="ci2-zone-txt"><b>{s.loading ? "Reading…" : "Drop an Excel or CSV file"}</b><span>or click to choose · .xlsx .csv .tsv</span></span>
        </div>
      ) : (
        <div className="ci2-loaded">
          <div className="ci2-file"><b>{s.fileName}</b><span>{s.sheet?.name}</span></div>
          <div className="ci2-stats">
            <span><b>{fmtN(s.rows.length)}</b>rows</span>
            <span><b>{s.columns.length}</b>columns</span>
            <span><b>{mapped}</b>recognised</span>
          </div>
          {s.wb.sheets.length > 1 && (
            <div className="ci2-sheets">
              <span className="ci2-sheets-l">Sheet to import <em>This file has {s.wb.sheets.length} sheets — choose the one with the data</em></span>
              <div className="ci-chips">{s.wb.sheets.map((sh, i) => <button key={sh.name + i} className={`ci-chip ${i === s.sheetIdx ? "is-on" : ""}`} onClick={() => s.setSheetIdx(i)}>{sh.name}<em>{Math.max(0, sh.rows.length - 1)} rows</em></button>)}</div>
            </div>
          )}
          <label className="ci-check"><input type="checkbox" checked={s.hasHeader} onChange={(e) => s.setHasHeader(e.target.checked)} /><span className="ci-box" />First row has the column names</label>
          <div className="ci2-peek">
            <table><thead><tr>{s.columns.slice(0, 6).map((c) => <th key={c.i}>{c.header}</th>)}</tr></thead>
              <tbody>{s.rows.slice(0, 3).map((r, ri) => <tr key={ri}>{s.columns.slice(0, 6).map((c) => <td key={c.i}>{cellText(r[c.i] ?? null)}</td>)}</tr>)}</tbody></table>
          </div>
        </div>
      )}
      {s.err && <p className="ci-err">{s.err}</p>}
      {!s.wb && <button className="ci2-template" onClick={onTemplate}>Download a template with your fields</button>}
    </section>
  );
}