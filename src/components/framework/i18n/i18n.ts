/* =====================================================================
   The app's language: English (as written), Spanish, German or Dutch.

   The app is written in English. In another language every text the app
   shows — text, placeholders, tooltips, labels for screen readers, the
   tab's title, alerts / confirms — is swapped for its translation as it
   appears on screen, from a dictionary of the app's own texts
   (i18n/<lang>.json, made from the source by the i18n script: every
   English text with its translation; texts with values in them, like
   "{0} open deals", as patterns). Dates come out in the language too.
   What people type (names, notes, fields), proposal documents and
   anything marked translate="no" / .notranslate stay as they are.

   Chosen in Settings › Interface › Language: kept on this device
   (localStorage, so the app starts in it) and in the person's profile
   (profiles.prefs.lang, so it follows them to other devices).
   ===================================================================== */

import enUrl from "./en.json?url";
import esUrl from "./es.json?url";
import deUrl from "./de.json?url";
import nlUrl from "./nl.json?url";

export type Lang = "en" | "es" | "de" | "nl";
export const LANGS: { v: Lang; label: string; native: string; flag: string; locale: string }[] = [
  { v: "en", label: "English", native: "English", flag: "🇬🇧", locale: "en-GB" },
  { v: "es", label: "Spanish", native: "Español", flag: "🇪🇸", locale: "es-ES" },
  { v: "de", label: "German", native: "Deutsch", flag: "🇩🇪", locale: "de-DE" },
  { v: "nl", label: "Dutch", native: "Nederlands", flag: "🇳🇱", locale: "nl-NL" },
];
const KEY = "next.lang";
const isLang = (x: unknown): x is Lang => x === "en" || x === "es" || x === "de" || x === "nl";

/** The language the app is in. */
export function getLang(): Lang {
  try { const v = localStorage.getItem(KEY); if (isLang(v)) return v; } catch { /* private mode */ }
  return "en";
}
/** The locale dates are written in ("en-GB", "es-ES"…). */
export const appLocale = () => LANGS.find((l) => l.v === getLang())!.locale;

/** Change the language: kept here and in the profile, then the app starts again in it. */
export async function setLang(l: Lang, opts: { save?: (l: Lang) => Promise<unknown> | void; reload?: boolean } = {}) {
  try { localStorage.setItem(KEY, l); } catch { /* private mode */ }
  try { await opts.save?.(l); } catch { /* the device keeps it anyway */ }
  if (opts.reload !== false) window.location.reload();
}
/** The profile says another language than this device (chosen elsewhere): follow it. */
export function followProfileLang(p: unknown) {
  if (!isLang(p) || p === getLang()) return;
  try { localStorage.setItem(KEY, p); } catch { return; }
  window.location.reload();
}

/* ---------------------------------------------------------------------
   The dictionary
   --------------------------------------------------------------------- */
type Pat = { re: RegExp; to: string; n: number; weak: boolean };
let STR: Map<string, string> | null = null;
let PATS: Pat[] = [];
const PAT_BY_WORD = new Map<string, Pat[]>();
const MISS = new Map<string, string | null>();

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.replace(/[\s ]+/g, " ").trim();
const wordsOf = (s: string) => (s.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) ?? []);

/** English month and weekday names → the language's, for dates the app writes by hand. */
const DATEW = new Map<string, string>();
const NativeDTF = Intl.DateTimeFormat; // before patchDates() points it at the app's locale
function buildDates(locale: string) {
  const en = (o: Intl.DateTimeFormatOptions, d: Date) => new NativeDTF("en-GB", o).format(d);
  const to = (o: Intl.DateTimeFormatOptions, d: Date) => new NativeDTF(locale, o).format(d).replace(/\.$/, "");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  for (let m = 0; m < 12; m++) {
    const d = new Date(2026, m, 15);
    for (const o of [{ month: "long" }, { month: "short" }] as Intl.DateTimeFormatOptions[]) {
      const e = en(o, d), t2 = to(o, d);
      DATEW.set(e, cap(t2)); DATEW.set(e.toLowerCase(), t2.toLowerCase()); DATEW.set(e.toUpperCase(), t2.toUpperCase());
    }
    DATEW.set("Sept", cap(to({ month: "short" }, new Date(2026, 8, 15))));
  }
  for (let i = 0; i < 7; i++) {
    const d = new Date(2026, 10, 16 + i);
    for (const o of [{ weekday: "long" }, { weekday: "short" }] as Intl.DateTimeFormatOptions[]) {
      const e = en(o, d), t2 = to(o, d);
      DATEW.set(e, cap(t2)); DATEW.set(e.toLowerCase(), t2.toLowerCase()); DATEW.set(e.toUpperCase(), t2.toUpperCase());
    }
  }
}

function build(en: { s: string[]; p: string[] }, tr: { s: (string | null)[]; p: (string | null)[] }) {
  STR = new Map();
  buildDates(appLocale());
  en.s.forEach((k, i) => { const t = tr.s[i]; if (t) STR!.set(norm(k), t); }); // the same in both (“Open tickets” in Dutch) stays: it is not a pattern’s
  en.p.forEach((k, i) => {
    const t = tr.p[i];
    if (!t) return;
    const parts = k.split(/\{(\d+)\}/);
    let src = "^";
    let n = 0;
    parts.forEach((part, j) => { if (j % 2) { src += "([\\s\\S]*?)"; n++; } else src += esc(norm(part)).replace(/ /g, "\\s+"); });
    src += "$";
    let re: RegExp;
    try { re = new RegExp(src); } catch { return; }
    // indexed by its longest word, so a text is only tried against the patterns that could match it
    const w = wordsOf(parts.filter((_, j) => j % 2 === 0).join(" ")).sort((a, b) => b.length - a.length)[0] ?? "";
    // little text of its own ("On {0}", "To {0}"): it could be somebody's own words, so only with values in it
    const p: Pat = { re, to: t, n, weak: !w };
    PATS.push(p);
    const list = PAT_BY_WORD.get(w); if (list) list.push(p); else PAT_BY_WORD.set(w, [p]);
  });
}

/** A text's translation (null: none — it stays as it is). */
export function lookup(text: string, depth = 0): string | null {
  if (!STR) return null;
  const k = norm(text);
  if (!k || !/[A-Za-z]/.test(k)) return null;
  const hit = STR.get(k);
  if (hit != null) return hit;
  if (MISS.has(k)) return MISS.get(k)!;
  let out: string | null = null;
  // a bullet in front or punctuation behind: translate what's in between
  const m = /^([·•–—\-(\s]*)(.*?)([\s:.…!?),]*)$/.exec(k);
  if (m && (m[1] || m[3]) && m[2] && m[2] !== k) {
    const t = STR.get(m[2]) ?? (depth < 2 ? lookup(m[2], depth + 1) : null);
    if (t != null) out = m[1] + t + m[3];
  }
  // a date written by hand ("November 2026", "Nov 9 – 13, 2026", "Mon 16"): its month and day names
  if (out == null && DATEW.size) {
    const words = k.match(/[A-Za-z]+/g) ?? [];
    if (words.length && words.every((w) => DATEW.has(w)) && /^[A-Za-z0-9\s.,:/–\-]+$/.test(k)) out = k.replace(/[A-Za-z]+/g, (w) => DATEW.get(w)!);
  }
  // a text with values in it ("5 open deals"): its pattern, with each value translated too when it is a text
  if (out == null && PATS.length) {
    const cands = new Set<Pat>();
    for (const w of wordsOf(k)) PAT_BY_WORD.get(w)?.forEach((p) => cands.add(p));
    PAT_BY_WORD.get("")?.forEach((p) => cands.add(p));
    for (const p of cands) {
      const r = p.re.exec(k);
      if (!r) continue;
      if (p.weak && !r.slice(1).every((v) => !/[A-Za-z]{2,}/.test(v) || /\d/.test(v) || (depth < 2 && lookup(v, depth + 1) != null))) continue;
      out = p.to.replace(/\{(\d+)\}/g, (_, i) => {
        const v = r[Number(i) + 1] ?? "";
        const vt = depth < 2 && /[A-Za-z]{2,}/.test(v) ? lookup(v, depth + 1) : null;
        return vt ?? v;
      });
      break;
    }
  }
  // a number in front ("20 bills", "3 open"): the words after it
  if (out == null && depth < 2) {
    const n = /^([+\-−]?[\d.,]+\s*[%€k]?\s+)([A-Za-z].*)$/.exec(k);
    if (n) { const t2 = lookup(n[2], depth + 1); if (t2 != null) out = n[1] + t2; }
  }
  // parts joined by hand ("Good morning, Inder", "Open · 3 deals"): each known part, the rest as it is
  if (out == null && depth < 2 && /(, | · | — | – |: )/.test(k)) {
    const segs = k.split(/(, | · | — | – |: )/);
    let any = false;
    const tr = segs.map((s, i) => {
      if (i % 2) return s;
      const x = STR!.get(s) ?? (/^[+\-−]?[\d.,]+\s/.test(s) ? lookup(s, depth + 1) : null);
      if (x != null) { any = true; return x; }
      return s;
    });
    if (any) out = tr.join("");
  }
  if (MISS.size > 60000) MISS.clear();
  MISS.set(k, out);
  return out;
}
/** For code that builds a text by hand (a canvas, a file name…): its translation, or itself. */
export const t = (s: string) => lookup(s) ?? s;

/* ---------------------------------------------------------------------
   On screen: every text as it appears
   --------------------------------------------------------------------- */
const SKIP = 'script, style, noscript, textarea, code, pre, [translate="no"], .notranslate, [contenteditable=""], [contenteditable="true"]';
const ATTRS = ["placeholder", "title", "aria-label", "alt", "data-tip", "data-ph", "data-placeholder", "data-group"]; // data-*: shown by CSS (content: attr(…))
const seen = new WeakMap<Node, string>();
const seenAttr = new WeakMap<Element, Record<string, string>>();

function swapText(n: Text) {
  const v = n.nodeValue;
  if (!v || seen.get(n) === v || !/[A-Za-z]/.test(v)) return;
  const el = n.parentElement;
  if (!el || el.closest(SKIP)) { seen.set(n, v); return; }
  const core = v.trim();
  const tr = lookup(core);
  if (tr == null || tr === core) { seen.set(n, v); return; }
  const out = v.replace(core, tr);
  seen.set(n, out);
  n.nodeValue = out;
}
function swapAttrs(el: Element) {
  let rec: Record<string, string> | undefined;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v || !/[A-Za-z]/.test(v)) continue;
    rec ??= seenAttr.get(el) ?? {};
    if (rec[a] === v) continue;
    if (el.closest('[translate="no"], .notranslate')) { rec[a] = v; continue; }
    const tr = lookup(v);
    const out = tr ?? v;
    rec[a] = out;
    if (out !== v) el.setAttribute(a, out);
  }
  if (rec) seenAttr.set(el, rec);
}
function swapTree(root: Node) {
  if (root.nodeType === 3) { swapText(root as Text); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  if (root.nodeType === 1) {
    const el = root as Element;
    if (el.matches?.("script, style, noscript")) return;
    swapAttrs(el);
  }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n = w.nextNode();
  while (n) {
    if (n.nodeType === 3) swapText(n as Text);
    else swapAttrs(n as Element);
    n = w.nextNode();
  }
}

let started = false;
/** Load the dictionary of the chosen language and translate the app as it draws. English: nothing to do. */
export async function startI18n(): Promise<void> {
  const lang = getLang();
  document.documentElement.lang = lang;
  patchDates();
  if (lang === "en" || started) return;
  started = true;
  try {
    const get = (u: string) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
    const [en, tr] = await Promise.all([get(enUrl), get(lang === "es" ? esUrl : lang === "de" ? deUrl : nlUrl)]);
    build(en, tr);
  } catch (e) {
    console.warn("[i18n] the dictionary could not be loaded; the app stays in English", e);
    return;
  }
  // the browser's own boxes
  const al = window.alert.bind(window), cf = window.confirm.bind(window), pr = window.prompt.bind(window);
  window.alert = (m?: any) => al(typeof m === "string" ? t(m) : m);
  window.confirm = (m?: string) => cf(typeof m === "string" ? t(m) : m);
  window.prompt = (m?: string, d?: string) => pr(typeof m === "string" ? t(m) : m, d);
  const obs = new MutationObserver((list) => {
    for (const r of list) {
      if (r.type === "characterData") swapText(r.target as Text);
      else if (r.type === "attributes") swapAttrs(r.target as Element);
      else r.addedNodes.forEach((n) => swapTree(n));
    }
  });
  obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  swapTree(document.documentElement);
}

/* ---------------------------------------------------------------------
   Dates in the language: whatever locale a screen asks for, dates come
   out in the app's (numbers keep their one format: main.tsx).
   --------------------------------------------------------------------- */
let datesPatched = false;
function patchDates() {
  if (datesPatched) return;
  datesPatched = true;
  const lang = getLang();
  if (lang === "en") return;
  const loc = appLocale();
  const P = Date.prototype as any;
  for (const fn of ["toLocaleDateString", "toLocaleTimeString", "toLocaleString"]) {
    const native = P[fn];
    P[fn] = function (this: Date, _l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) { return native.call(this, loc, o); };
  }
  const DTF = Intl.DateTimeFormat;
  const Patched = function (this: unknown, _l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) { return new DTF(loc, o); } as unknown as typeof Intl.DateTimeFormat;
  Object.defineProperty(Patched, "prototype", { value: DTF.prototype });
  (Patched as any).supportedLocalesOf = DTF.supportedLocalesOf.bind(DTF);
  try { (Intl as any).DateTimeFormat = Patched; } catch { /* frozen: leave it */ }
}
