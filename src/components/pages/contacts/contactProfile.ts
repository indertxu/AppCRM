/**
 * Built-in contact fields (not custom fields): postal address, language and LinkedIn.
 * They are real columns on the contacts table (see 20261016_contacts_profile_fields.sql),
 * so every contact has them and they can't be deleted from "Fields & columns".
 *
 * Which built-in fields are mandatory (for contacts AND companies) is set in
 * Settings › Contacts page / Companies page › Required fields and kept in
 * crm_options (kind "required_field"). The editors, the importer and the field
 * settings read it through the store below; `def` is what applies until the
 * team changes it.
 */

export type ProfileKey = "street" | "addr_number" | "postal_code" | "city" | "province" | "country" | "language" | "linkedin";
export interface ProfileField { key: ProfileKey; label: string; required: boolean }

/* ═══════════════════════════ required built-in fields (contacts + companies) ═══════════════════════════ */

export type ReqScope = "company" | "contact";
export interface FixedField {
  key: string; label: string; group: string;
  /** Always required, can't be switched off (the name). */
  locked?: boolean;
  /** Required until the team changes it in Settings. */
  def?: boolean;
}
export const CONTACT_FIXED: FixedField[] = [
  { key: "first_name", label: "Name", group: "Who they are", locked: true },
  { key: "last_name", label: "Surname", group: "Who they are" },
  { key: "position", label: "Position / title", group: "Who they are" },
  { key: "companies", label: "Company", group: "Who they are" },
  { key: "email", label: "Email", group: "How to reach them" },
  { key: "landline", label: "Telephone", group: "How to reach them" },
  { key: "phone", label: "Mobile", group: "How to reach them" },
  { key: "linkedin", label: "LinkedIn", group: "How to reach them" },
  { key: "language", label: "Language", group: "How to reach them" },
  { key: "street", label: "Street", group: "Address", def: true },
  { key: "addr_number", label: "Number", group: "Address", def: true },
  { key: "postal_code", label: "Postal code", group: "Address", def: true },
  { key: "city", label: "City", group: "Address", def: true },
  { key: "province", label: "Province / state", group: "Address" },
  { key: "country", label: "Country", group: "Address", def: true },
];
export const COMPANY_FIXED: FixedField[] = [
  { key: "name", label: "Name", group: "Who they are", locked: true },
  { key: "legal_name", label: "Legal name", group: "Who they are" },
  { key: "vat_number", label: "VAT / Tax ID", group: "Who they are" },
  { key: "sector", label: "Sector", group: "Who they are" },
  { key: "source", label: "Source", group: "Who they are" },
  { key: "website", label: "Website", group: "How to reach them" },
  { key: "linkedin", label: "LinkedIn", group: "How to reach them" },
  { key: "email", label: "Email", group: "How to reach them" },
  { key: "landline", label: "Telephone", group: "How to reach them" },
  { key: "phone", label: "Mobile", group: "How to reach them" },
  { key: "street", label: "Street", group: "Address" },
  { key: "addr_number", label: "Number", group: "Address" },
  { key: "postal_code", label: "Postal code", group: "Address" },
  { key: "city", label: "City", group: "Address" },
  { key: "province", label: "Province / state", group: "Address" },
  { key: "country", label: "Country", group: "Address" },
  { key: "billing_name", label: "Billing name", group: "Billing" },
  { key: "billing_email", label: "Billing email", group: "Billing" },
  { key: "billing_phone", label: "Billing phone", group: "Billing" },
];
export const fixedFieldsOf = (scope: ReqScope) => (scope === "company" ? COMPANY_FIXED : CONTACT_FIXED);
const defaultsOf = (scope: ReqScope) => new Set(fixedFieldsOf(scope).filter((f) => f.def || f.locked).map((f) => f.key));

const reqState: Record<ReqScope, Set<string>> = { company: defaultsOf("company"), contact: defaultsOf("contact") };
let reqVersion = 0;
const reqListeners = new Set<() => void>();
/** The keys required right now (always includes the locked name). */
export const requiredKeys = (scope: ReqScope): Set<string> => reqState[scope];
export function setRequiredKeys(scope: ReqScope, keys: Iterable<string> | null) {
  const next = keys ? new Set(keys) : defaultsOf(scope);
  fixedFieldsOf(scope).forEach((f) => { if (f.locked) next.add(f.key); });
  const known = new Set(fixedFieldsOf(scope).map((f) => f.key));
  for (const k of [...next]) if (!known.has(k)) next.delete(k);
  reqState[scope] = next;
  reqVersion++;
  reqListeners.forEach((fn) => fn());
}
export const subscribeRequired = (fn: () => void) => { reqListeners.add(fn); return () => { reqListeners.delete(fn); }; };
export const requiredVersion = () => reqVersion;
export const isFixedRequired = (scope: ReqScope, key: string) => reqState[scope].has(key);

/** What a record holds for a built-in field, as text ("" = empty). */
export function fixedValue(scope: ReqScope, row: any, key: string): string {
  if (!row) return "";
  if (scope === "contact" && key === "companies") return Array.isArray(row.companyIds) && row.companyIds.length ? "yes" : "";
  if (scope === "company" && key.startsWith("billing_")) { const b = row.billing ?? {}; const v = b[key.slice(8)]; return v == null ? "" : String(v).trim(); }
  const v = row[key];
  if (Array.isArray(v)) return v.length ? "yes" : "";
  return v == null ? "" : String(v).trim();
}
/** Labels of the required built-in fields a record is missing (the name is checked apart). `only` limits it to the fields a form shows. */
export function missingFixed(scope: ReqScope, row: any, only?: string[]): string[] {
  return fixedFieldsOf(scope)
    .filter((f) => !f.locked && reqState[scope].has(f.key) && (!only || only.includes(f.key)) && !fixedValue(scope, row, f.key))
    .map((f) => f.label);
}

const PROFILE_BASE: { key: ProfileKey; label: string }[] = [
  { key: "street", label: "Street" },
  { key: "addr_number", label: "Number" },
  { key: "postal_code", label: "Postal code" },
  { key: "city", label: "City" },
  { key: "province", label: "Province / state" },
  { key: "country", label: "Country" },
  { key: "language", label: "Language" },
  { key: "linkedin", label: "LinkedIn" },
];
/** The built-in profile fields; `required` follows Settings (read it at use time). */
export const PROFILE_FIELDS: ProfileField[] = PROFILE_BASE.map((b) => ({
  ...b, get required() { return reqState.contact.has(b.key); },
} as ProfileField));
export const PROFILE_KEYS: ProfileKey[] = PROFILE_BASE.map((f) => f.key);
export const isProfileKey = (k: string): k is ProfileKey => (PROFILE_KEYS as string[]).includes(k);
export const isRequired = (k: string) => reqState.contact.has(k);

const str = (v: unknown) => (v == null ? "" : String(v).trim());
const norm = (s: unknown) => str(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
type ProfileLike = Partial<Record<ProfileKey, unknown>>;

/** Labels of the required fields this contact is missing. */
export function missingProfile(c: ProfileLike): string[] {
  return PROFILE_FIELDS.filter((f) => f.required && !str(c[f.key])).map((f) => f.label);
}
/** Trimmed values, empty → null, LinkedIn normalised — ready to save. */
export function tidyProfile(c: ProfileLike): Record<ProfileKey, string | null> {
  const out = {} as Record<ProfileKey, string | null>;
  PROFILE_KEYS.forEach((k) => { const v = k === "linkedin" ? normalizeLinkedIn(c[k]) : str(c[k]); out[k] = v || null; });
  return out;
}
/** "Calle de Alcalá 42, 28014 Madrid, Spain" */
export function formatAddress(c: ProfileLike): string {
  const line1 = [str(c.street), str(c.addr_number)].filter(Boolean).join(" ");
  const prov = str(c.province);
  const line2 = [str(c.postal_code), str(c.city), prov && norm(prov) !== norm(c.city) ? `(${prov})` : ""].filter(Boolean).join(" ");
  return [line1, line2, countryLabel(c.country)].filter(Boolean).join(", ");
}
/** Turn old free-text country / language values ("España", "Español") into codes when they can be recognised. */
export function withProfileCodes<T extends ProfileLike>(c: T): T {
  const country = str(c.country) ? matchCountry(c.country) ?? c.country : c.country;
  const language = str(c.language) ? matchLanguage(c.language) ?? c.language : c.language;
  return { ...c, country, language };
}

/** Names a custom field can no longer take — they are built in now. */
const RESERVED = new Set([
  "street", "calle", "address", "direccion", "domicilio", "number", "numero", "street number", "postal code", "postcode", "zip", "zip code",
  "codigo postal", "cp", "city", "ciudad", "localidad", "province", "provincia", "state", "region", "country", "pais", "language", "idioma", "lengua", "linkedin", "linked in", "linkedin url",
  "perfil linkedin", "perfil de linkedin",
]);
export const isReservedLabel = (label: string) => RESERVED.has(norm(label));

/* ═══════════════════════════ names from the browser (Intl) ═══════════════════════════ */

type DN = { of(code: string): string | undefined };
function displayNames(locale: string, type: "language" | "region"): DN | null {
  try { return new (Intl as any).DisplayNames([locale], { type, fallback: "none" }); } catch { return null; }
}
const nameIn = (dn: DN | null, code: string) => { try { return dn?.of(code) || undefined; } catch { return undefined; } };

/* ═══════════════════════════ languages ═══════════════════════════ */

/** Every ISO 639-1 language, plus a few widely used ones that only have a 3-letter code. */
const LANGUAGE_CODES = (
  "aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy " +
  "ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo " +
  "lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl " +
  "sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu ast fil yue haw"
).split(" ");
const LANG_SET = new Set(LANGUAGE_CODES);
/** Spellings Intl doesn't give us (ISO 639-2 codes, local names). */
const LANG_ALIASES: Record<string, string> = {
  spa: "es", esp: "es", castellano: "es", eng: "en", fra: "fr", fre: "fr", deu: "de", ger: "de", ita: "it", por: "pt",
  cat: "ca", valenciano: "ca", valencia: "ca", eus: "eu", baq: "eu", euskera: "eu", vasco: "eu", glg: "gl", gallego: "gl",
  zho: "zh", chi: "zh", mandarin: "zh", jpn: "ja", ara: "ar", rus: "ru", nld: "nl", dut: "nl", flemish: "nl", flamenco: "nl",
  farsi: "fa", persa: "fa", pol: "pl", tur: "tr", kor: "ko", hin: "hi", swe: "sv", nor: "no", dan: "da", fin: "fi", ell: "el", gre: "el",
};

interface Lang { code: string; en: string; es: string; own: string }
let langCache: { list: Lang[]; by: Map<string, Lang> } | null = null;
function langs() {
  if (langCache) return langCache;
  const en = displayNames("en", "language"), es = displayNames("es", "language");
  const list = LANGUAGE_CODES.map((code) => {
    const e = nameIn(en, code) ?? code;
    return { code, en: e, es: nameIn(es, code) ?? e, own: nameIn(displayNames(code, "language"), code) ?? e };
  }).sort((a, b) => a.en.localeCompare(b.en));
  langCache = { list, by: new Map(list.map((l) => [l.code, l])) };
  return langCache;
}
/** "es" → "Spanish" (an old free-text value is recognised if possible, else shown as is) */
export function languageName(code: string | null | undefined): string {
  if (!code) return "";
  const l = langs().by.get(code) ?? langs().by.get(matchLanguage(code) ?? "");
  return l?.en ?? code;
}
/** "German · Deutsch" (English name + the language's own name) */
export function languageLabel(code: string) {
  const l = langs().by.get(code);
  if (!l) return code;
  return l.own && norm(l.own) !== norm(l.en) ? `${l.en} · ${l.own}` : l.en;
}
export const languageOptions = () => langs().list.map((l) => ({ value: l.code, label: languageLabel(l.code) }));

/** File value → language code: "es", "es-ES", "spa", "Español", "Spanish", "Inglés y francés" (takes the first). */
export function matchLanguage(raw: unknown): string | null {
  const { list } = langs();
  for (const part of str(raw).split(/[,;/|+&]|\s+y\s+|\s+and\s+/i)) {
    const p = part.trim();
    if (!p) continue;
    const tag = p.match(/^([a-z]{2,3})(?:[-_][a-z0-9]+)*$/i);
    if (tag) { const c = tag[1].toLowerCase(); if (LANG_SET.has(c)) return c; if (LANG_ALIASES[c]) return LANG_ALIASES[c]; }
    const n = norm(p);
    if (LANG_ALIASES[n]) return LANG_ALIASES[n];
    const exact = list.find((l) => [l.en, l.es, l.own].some((x) => norm(x) === n));
    if (exact) return exact.code;
    if (n.length >= 4) {
      const near = list.find((l) => [l.en, l.es, l.own].some((x) => { const xn = norm(x); return xn.length >= 4 && (xn.startsWith(n) || n.startsWith(`${xn} `)); }));
      if (near) return near.code;
    }
  }
  return null;
}

/* ═══════════════════════════ countries ═══════════════════════════ */

/** ISO 3166-1 alpha-2, plus Kosovo. Stored on the contact as the code ("ES"). */
const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM " +
  "CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF " +
  "MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE " +
  "RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ " +
  "VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");
const COUNTRY_ALIASES: Record<string, string> = {
  uk: "GB", "great britain": "GB", "gran bretana": "GB", england: "GB", inglaterra: "GB", scotland: "GB", escocia: "GB", wales: "GB", gales: "GB",
  usa: "US", "united states of america": "US", eeuu: "US", "ee uu": "US", "estados unidos de america": "US", america: "US",
  holland: "NL", holanda: "NL", "the netherlands": "NL", "czech republic": "CZ", "republica checa": "CZ", "south korea": "KR", "corea del sur": "KR",
  "north korea": "KP", "corea del norte": "KP", russia: "RU", uae: "AE", emiratos: "AE", "emiratos arabes": "AE", "ivory coast": "CI",
  "costa de marfil": "CI", turkey: "TR", turquia: "TR",
  esp: "ES", fra: "FR", deu: "DE", ita: "IT", prt: "PT", gbr: "GB", irl: "IE", nld: "NL", bel: "BE", che: "CH", aut: "AT", mex: "MX",
  arg: "AR", col: "CO", chl: "CL", per: "PE", bra: "BR", can: "CA", aus: "AU",
};

interface Country { code: string; en: string; es: string }
let countryCache: { list: Country[]; by: Map<string, Country> } | null = null;
function countries() {
  if (countryCache) return countryCache;
  const en = displayNames("en", "region"), es = displayNames("es", "region");
  const list = COUNTRY_CODES.map((code) => {
    const e = nameIn(en, code) ?? code;
    return { code, en: e, es: nameIn(es, code) ?? e };
  }).sort((a, b) => a.en.localeCompare(b.en));
  countryCache = { list, by: new Map(list.map((c) => [c.code, c])) };
  return countryCache;
}
/** "ES" → "Spain" */
export const countryName = (code: string) => countries().by.get(code)?.en ?? code;
/** Every country: ISO code, English and Spanish name (the English one is what is shown everywhere). */
export const countryList = (): { code: string; en: string; es: string }[] => countries().list;
/** value = ISO code (what is saved); label shows the English and Spanish names so "España" finds it. */
export const countryOptions = () => countries().list.map((c) => ({ value: c.code, label: norm(c.es) === norm(c.en) ? c.en : `${c.en} · ${c.es}` }));

/** Any spelling → ISO code: "ES", "es", "España", "Spain", "UK", "EEUU"… */
export function matchCountry(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  if (/^[a-z]{2}$/i.test(s)) { const c = countries().by.get(s.toUpperCase()); if (c) return c.code; }
  const n = norm(s);
  if (COUNTRY_ALIASES[n]) return COUNTRY_ALIASES[n];
  const hit = countries().list.find((c) => norm(c.en) === n || norm(c.es) === n);
  return hit ? hit.code : null;
}
/** What to show for a stored country: "ES" → "Spain" (an old free-text value is shown as is). */
export function countryLabel(v: unknown): string {
  const code = matchCountry(v);
  return code ? countryName(code) : str(v);
}

/* ═══════════════════════════ LinkedIn ═══════════════════════════ */

const LI_URL = /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/\S+$/i;
/** "linkedin.com/in/ana/", "in/ana", "@ana" or just "ana" → "https://www.linkedin.com/in/ana". Anything else is returned as is. */
export function normalizeLinkedIn(raw: unknown): string {
  const s = str(raw).replace(/^@/, "");
  if (!s) return "";
  const m = s.match(/^(?:https?:\/\/)?((?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/\S*)$/i);
  if (m) return `https://${m[1]}`.split(/[?#]/)[0].replace(/\/+$/, "");
  if (/^(in|company|pub)\/\S+$/i.test(s)) return `https://www.linkedin.com/${s}`.replace(/\/+$/, "");
  if (/^[a-z0-9][a-z0-9_%-]{2,99}$/i.test(s)) return `https://www.linkedin.com/in/${s}`;
  return s;
}
export const isLinkedIn = (s: string | null | undefined) => LI_URL.test(str(s));
/** "https://www.linkedin.com/in/ana-lopez" → "in/ana-lopez" */
export const linkedInHandle = (url: string | null | undefined) => str(url).replace(/^https?:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\//i, "") || str(url);

/* ═══════════════════════════ address lookup ═══════════════════════════
 * Free, no key: Photon (OpenStreetMap, photon.komoot.io) for streets and towns,
 * Zippopotam (api.zippopotam.us) for postal codes, and the Spanish provinces
 * straight from the first two digits of the postal code (works offline).
 */

/** Spanish provinces by the first two digits of the postal code. */
const ES_PROVINCES: Record<string, string> = {
  "01": "Álava", "02": "Albacete", "03": "Alicante", "04": "Almería", "05": "Ávila", "06": "Badajoz", "07": "Illes Balears", "08": "Barcelona",
  "09": "Burgos", "10": "Cáceres", "11": "Cádiz", "12": "Castellón", "13": "Ciudad Real", "14": "Córdoba", "15": "A Coruña", "16": "Cuenca",
  "17": "Girona", "18": "Granada", "19": "Guadalajara", "20": "Gipuzkoa", "21": "Huelva", "22": "Huesca", "23": "Jaén", "24": "León",
  "25": "Lleida", "26": "La Rioja", "27": "Lugo", "28": "Madrid", "29": "Málaga", "30": "Murcia", "31": "Navarra", "32": "Ourense",
  "33": "Asturias", "34": "Palencia", "35": "Las Palmas", "36": "Pontevedra", "37": "Salamanca", "38": "Santa Cruz de Tenerife", "39": "Cantabria",
  "40": "Segovia", "41": "Sevilla", "42": "Soria", "43": "Tarragona", "44": "Teruel", "45": "Toledo", "46": "Valencia", "47": "Valladolid",
  "48": "Bizkaia", "49": "Zamora", "50": "Zaragoza", "51": "Ceuta", "52": "Melilla",
};
/** "28014" → "Madrid" (Spain only, or when no country is set). */
export function provinceFromPostal(postal: unknown, country?: unknown): string {
  const cc = matchCountry(country) ?? (str(country) ? null : "ES");
  const cp = str(postal).replace(/\s+/g, "");
  return cc === "ES" && /^\d{5}$/.test(cp) ? ES_PROVINCES[cp.slice(0, 2)] ?? "" : "";
}
/** Long enough to look up? (5 digits in Spain; 3+ characters elsewhere) */
export function postalLooksComplete(postal: unknown, country?: unknown): boolean {
  const cc = matchCountry(country) ?? "ES";
  const cp = str(postal).replace(/\s+/g, "");
  if (cc === "ES" || cc === "FR" || cc === "DE" || cc === "IT" || cc === "US") return /^\d{5}$/.test(cp);
  if (cc === "PT") return /^\d{4}-?\d{3}$/.test(cp);
  return cp.length >= 3;
}

/** One suggestion: what to show, and the address parts it fills (country = ISO code). */
export interface AddressHit {
  key: string; label: string; sub: string; kind: "address" | "street" | "city";
  street?: string; number?: string; postal_code?: string; city?: string; province?: string; country?: string;
}

const lookCache = new Map<string, Promise<any>>();
async function getJson(url: string, signal?: AbortSignal): Promise<any> {
  if (!lookCache.has(url)) {
    const p = (async () => {
      const ctl = new AbortController();
      const t = window.setTimeout(() => ctl.abort(), 6000);
      try {
        const r = await fetch(url, { signal: ctl.signal });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; } finally { window.clearTimeout(t); }
    })();
    lookCache.set(url, p);
    p.then((v) => { if (v == null) lookCache.delete(url); });
  }
  const res = await lookCache.get(url)!;
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  return res;
}

/** Streets / addresses or towns that match what was typed — best first. `near` narrows it to a town or country. */
export async function searchPlaces(q: string, kind: "address" | "city", near: { city?: string; country?: string } = {}, signal?: AbortSignal): Promise<AddressHit[]> {
  const text = str(q);
  if (text.length < 3) return [];
  const cc = matchCountry(near.country) ?? "";
  const query = kind === "address" && near.city && !norm(text).includes(norm(near.city)) ? `${text}, ${near.city}` : text;
  // lean on Spain unless another country is set
  const bias = !cc || cc === "ES" ? "&lat=40.2&lon=-3.7&location_bias_scale=0.3" : "";
  const layers = kind === "city" ? "&layer=city&layer=locality" : "&layer=house&layer=street";
  const base = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}${bias}`;
  // older Photon servers don't know "layer": then ask for more and keep the right kinds ourselves
  const data = (await getJson(`${base}&limit=8${layers}`, signal)) ?? (await getJson(`${base}&limit=15`, signal));
  const wanted = kind === "city" ? ["city", "locality", "district"] : ["house", "street"];
  const out: AddressHit[] = [];
  const seen = new Set<string>();
  for (const f of (data?.features ?? []) as any[]) {
    const p = f?.properties ?? {};
    if (p.type && !wanted.includes(p.type)) continue;
    const country = str(p.countrycode).toUpperCase() || undefined;
    if (cc && country && country !== cc) continue;
    const postal = str(p.postcode).split(/[;,]/)[0].trim() || undefined;
    const isCity = kind === "city";
    const city = (isCity ? str(p.name) : str(p.city) || str(p.locality) || str(p.district)) || undefined;
    const province = (country === "ES" ? provinceFromPostal(postal, "ES") : "") || str(p.county) || str(p.state) || undefined;
    const street = isCity ? undefined : (p.type === "house" || p.osm_key === "building" ? str(p.street) : str(p.street) || str(p.name)) || undefined;
    const number = isCity ? undefined : str(p.housenumber) || undefined;
    if (!isCity && !street) continue;
    const label = isCity ? city! : [street, number].filter(Boolean).join(" ");
    const sub = [isCity ? postal : [postal, city].filter(Boolean).join(" "), province && norm(province) !== norm(city) ? province : "", country ? countryName(country) : ""].filter(Boolean).join(", ");
    const key = `${label}|${sub}`;
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label, sub, kind: isCity ? "city" : number ? "address" : "street", street, number, postal_code: postal, city, province, country });
    if (out.length >= 8) break;
  }
  return out;
}

/** Postal code → the towns it covers, the province and the country. */
export async function lookupPostal(postal: string, country?: string, signal?: AbortSignal): Promise<{ cities: string[]; province: string; country: string } | null> {
  const cc = matchCountry(country) ?? "ES";
  const cp = str(postal).replace(/\s+/g, "");
  if (!postalLooksComplete(cp, cc)) return null;
  const data = await getJson(`https://api.zippopotam.us/${cc.toLowerCase()}/${encodeURIComponent(cp)}`, signal);
  const places = (data?.places ?? []) as any[];
  const cities = [...new Set(places.map((p) => str(p["place name"])).filter(Boolean))];
  const province = provinceFromPostal(cp, cc) || str(places[0]?.state);
  if (!cities.length && !province) return null;
  return { cities, province, country: cc };
}
