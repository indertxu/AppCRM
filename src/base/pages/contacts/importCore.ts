/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The pure parts of importing contacts and companies from a spreadsheet:
 * tidying names and addresses, matching companies (VAT, name, domain,
 * similar names), guessing a column's type, and comparing a file row with
 * the CRM record it matches.
 */
import { cellText, normHeader, parseBool, parseDate, parseNumber, type SheetCell } from "../../framework/spreadsheetImport";
import type { Company } from "../companies/companiesApi";

export type FieldType = "text" | "number" | "date" | "boolean" | "select";
export type Entity = "company" | "contact";
/** A custom field the import creates (on companies or contacts). */
export interface NewField { tmp: string; entity: Entity; label: string; type: FieldType; options: string[] }
export interface Column { i: number; letter: string; header: string; values: SheetCell[]; filled: number; samples: SheetCell[] }

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

export type CompanyFoundBy = "vat" | "name" | "legal" | "domain" | "similar";
export type ContactFoundBy = "email" | "phone" | "name";
