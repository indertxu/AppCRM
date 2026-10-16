/**
 * Built-in contact fields (not custom fields): postal address, language and LinkedIn.
 * They are real columns on the contacts table (see 20261016_contacts_profile_fields.sql),
 * so every contact has them and they can't be deleted from "Fields & columns".
 *
 * To change what is mandatory, flip `required` below — the editor, the importer
 * and the field settings all read it from here.
 */

export type ProfileKey = "street" | "addr_number" | "postal_code" | "city" | "country" | "language" | "linkedin";
export interface ProfileField { key: ProfileKey; label: string; required: boolean }

export const PROFILE_FIELDS: ProfileField[] = [
  { key: "street", label: "Street", required: true },
  { key: "addr_number", label: "Number", required: true },
  { key: "postal_code", label: "Postal code", required: true },
  { key: "city", label: "City", required: true },
  { key: "country", label: "Country", required: true },
  { key: "language", label: "Language", required: false },
  { key: "linkedin", label: "LinkedIn", required: false },
];
export const PROFILE_KEYS: ProfileKey[] = PROFILE_FIELDS.map((f) => f.key);
export const isProfileKey = (k: string): k is ProfileKey => (PROFILE_KEYS as string[]).includes(k);
export const isRequired = (k: string) => PROFILE_FIELDS.some((f) => f.key === k && f.required);

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
  const line2 = [str(c.postal_code), str(c.city)].filter(Boolean).join(" ");
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
  "codigo postal", "cp", "city", "ciudad", "localidad", "country", "pais", "language", "idioma", "lengua", "linkedin", "linked in", "linkedin url",
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
