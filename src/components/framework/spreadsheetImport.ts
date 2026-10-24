/**
 * Read spreadsheets in the browser with no dependencies.
 *   .xlsx            → unzipped with the browser's DecompressionStream("deflate-raw"),
 *                      shared strings, inline strings, booleans and date cells resolved
 *   .csv .tsv .txt   → delimiter (, ; tab |) and encoding (UTF-8 / Windows-1252) detected
 * Old binary .xls files aren't supported (save them as .xlsx or CSV).
 */

export type SheetCell = string | number | boolean | { date: string } | null;
export interface Sheet { name: string; rows: SheetCell[][] }
export interface Workbook { kind: "xlsx" | "csv"; sheets: Sheet[] }

export async function readSpreadsheet(file: File): Promise<Workbook> {
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"
  if (name.endsWith(".xls") && !isZip) throw new Error("Old .xls files can't be read. In Excel use “Save as → .xlsx” (or CSV) and import that.");
  if (isZip) return { kind: "xlsx", sheets: await readXlsx(buf) };
  return { kind: "csv", sheets: [{ name: file.name.replace(/\.[^.]+$/, ""), rows: readCsv(decodeText(buf)) }] };
}

/* ───────────────────────── CSV ───────────────────────── */

function decodeText(buf: ArrayBuffer): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { text = new TextDecoder("windows-1252").decode(buf); } // Excel "CSV" on Windows/Spanish locales
  return text.replace(/^\uFEFF/, "");
}

function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 12).filter((l) => l.trim());
  const score = (d: string) => {
    const counts = sample.map((l) => { let n = 0, q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === d && !q) n++; } return n; });
    if (!counts.length || counts[0] === 0) return 0;
    const same = counts.filter((c) => c === counts[0]).length;
    return counts[0] * (same / counts.length);
  };
  return [",", ";", "\t", "|"].map((d) => [d, score(d)] as const).sort((a, b) => b[1] - a[1])[0][0];
}

export function readCsv(text: string, delimiter = detectDelimiter(text)): SheetCell[][] {
  const rows: SheetCell[][] = [];
  let row: SheetCell[] = [], field = "", q = false, i = 0;
  const push = () => { row.push(field === "" ? null : field); field = ""; };
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { q = true; i++; continue; }
    if (ch === delimiter) { push(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { push(); rows.push(row); row = []; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { push(); rows.push(row); }
  return trimRows(rows.map((r) => r.map((c) => (typeof c === "string" ? c.trim() || null : c))));
}

/* ───────────────────────── XLSX ───────────────────────── */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser can't open .xlsx files. Update it, or save the file as CSV.");
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf: ArrayBuffer, want: (path: string) => boolean): Promise<Map<string, string>> {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This file isn't a valid .xlsx workbook.");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder("utf-8");
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true), xlen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const path = dec.decode(u8.subarray(off + 46, off + 46 + nlen));
    off += 46 + nlen + xlen + clen;
    if (!want(path)) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = u8.subarray(start, start + csize);
    out.set(path, dec.decode(method === 0 ? raw : await inflateRaw(raw)));
  }
  return out;
}

const xml = (s: string | undefined) => (s ? new DOMParser().parseFromString(s, "application/xml") : null);

/* The two big parts of a workbook (its strings and its sheets) are read with a plain text scan
   instead of building the whole XML tree: several times faster, and it hands the page back every
   ~20 ms, so a file of tens of thousands of rows never freezes the screen. */
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) => (s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
  if (e[0] !== "#") return ENT[e.toLowerCase()] ?? m;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(n) ? String.fromCodePoint(n) : m;
}));
/** The text of the <t> elements of a string item (phonetic hints left out); `\r\n` → `\n` as the DOM does. */
const textOf = (inner: string) => {
  const body = inner.indexOf("rPh") < 0 ? inner : inner.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, "");
  let out = "";
  const re = /<(?:[\w.-]+:)?t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?t>)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out += m[1] ?? "";
  return unescapeXml(out.replace(/\r\n?/g, "\n"));
};
const ATTR_RE: Record<string, RegExp> = {};
const attrOf = (attrs: string, name: string) => {
  const m = (ATTR_RE[name] ??= new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)).exec(attrs);
  return m ? unescapeXml(m[1] ?? m[2] ?? "") : null;
};
/** Gives the page its turn (not throttled in a background tab, unlike setTimeout). */
const breathe = () => new Promise<void>((r) => {
  if (typeof MessageChannel === "undefined") { setTimeout(r, 0); return; }
  const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0);
});
const slicer = () => { let t = Date.now(); return async () => { if (Date.now() - t > 20) { await breathe(); t = Date.now(); } }; };

async function readShared(text: string | undefined): Promise<string[]> {
  const out: string[] = [];
  if (!text) return out;
  const turn = slicer();
  const re = /<(?:[\w.-]+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?si>)/g;
  for (let m = re.exec(text), k = 0; m; m = re.exec(text), k++) {
    out.push(m[1] ? textOf(m[1]) : "");
    if (k % 500 === 499) await turn();
  }
  return out;
}

/** One sheet's rows, read as text (null when it doesn't look like a sheet this scan understands). */
async function readSheetRows(text: string, cellOf: (t: string | null, v: string | null, s: string | null, inline: string | null) => SheetCell): Promise<SheetCell[][] | null> {
  const turn = slicer();
  const rows: SheetCell[][] = [];
  const rowRe = /<(?:[\w.-]+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row>)/g;
  const cellRe = /<(?:[\w.-]+:)?c(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g;
  const vRe = /<(?:[\w.-]+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?v>/;
  const isRe = /<(?:[\w.-]+:)?is\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?is>/;
  let seen = 0;
  for (let m = rowRe.exec(text); m; m = rowRe.exec(text)) {
    seen++;
    const rAttr = attrOf(m[1], "r");
    const ri = Number(rAttr ?? rows.length + 1) - 1;
    const row: SheetCell[] = [];
    const inner = m[2] ?? "";
    cellRe.lastIndex = 0;
    let ci = 0;
    for (let c = cellRe.exec(inner); c; c = cellRe.exec(inner), ci++) {
      const ref = attrOf(c[1], "r");
      const col = ref ? colIndex(ref) : ci;
      const body = c[2] ?? "";
      const vm = body ? vRe.exec(body) : null;
      const t = attrOf(c[1], "t");
      const im = t === "inlineStr" && body ? isRe.exec(body) : null;
      row[col] = cellOf(t, vm ? unescapeXml(vm[1].replace(/\r\n?/g, "\n")) : null, attrOf(c[1], "s"), im ? textOf(im[1]) : t === "inlineStr" ? "" : null);
    }
    for (let k = 0; k < row.length; k++) if (row[k] === undefined) row[k] = null;
    if (Number.isFinite(ri) && ri >= 0) rows[ri] = row;
    if (seen % 200 === 0) await turn();
  }
  // a sheet the scan couldn't read (an unusual writer): the full XML reader takes over
  if (!seen && /<(?:[\w.-]+:)?row[\s>]/.test(text)) return null;
  return rows;
}
const kids = (el: Element | Document | null, tag: string): Element[] => (el ? Array.from(el.getElementsByTagName(tag)) : []);
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** Built-in Excel number formats that are dates/times. */
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const isDateCode = (code: string) => /[dy]|m{3,}|(^|[^h])m+[/\-. ]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""));

function serialToIso(serial: number, date1904: boolean): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 864e5) + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function readXlsx(buf: ArrayBuffer): Promise<Sheet[]> {
  const files = await unzip(buf, (p) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(p));
  const wb = xml(files.get("xl/workbook.xml"));
  if (!wb) throw new Error("This workbook has no sheets.");
  const date1904 = kids(wb, "workbookPr")[0]?.getAttribute("date1904") === "1" || kids(wb, "workbookPr")[0]?.getAttribute("date1904") === "true";

  const rels = new Map<string, string>();
  kids(xml(files.get("xl/_rels/workbook.xml.rels")), "Relationship").forEach((r) => {
    const t = r.getAttribute("Target") ?? "";
    rels.set(r.getAttribute("Id") ?? "", t.startsWith("/") ? t.slice(1) : `xl/${t}`);
  });

  const shared = await readShared(files.get("xl/sharedStrings.xml"));

  const styles = xml(files.get("xl/styles.xml"));
  const customFmt = new Map<number, string>();
  kids(styles, "numFmt").forEach((f) => customFmt.set(Number(f.getAttribute("numFmtId")), f.getAttribute("formatCode") ?? ""));
  const cellXfs = kids(styles, "cellXfs")[0];
  const dateStyle = (cellXfs ? kids(cellXfs, "xf") : []).map((xf) => {
    const id = Number(xf.getAttribute("numFmtId") ?? 0);
    return DATE_FMT_IDS.has(id) || (customFmt.has(id) && isDateCode(customFmt.get(id)!));
  });

  const sheets: Sheet[] = [];
  for (const s of kids(wb, "sheet")) {
    const rid = s.getAttribute("r:id") ?? s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? "";
    const src = files.get(rels.get(rid) ?? "");
    if (!src) continue;
    const valueOf = (t: string | null, v: string | null, st: string | null, inline: string | null): SheetCell => {
      let val: SheetCell = null;
      if (t === "s") val = v != null ? shared[Number(v)] ?? null : null;
      else if (t === "inlineStr") val = inline || null;
      else if (t === "str") val = v;
      else if (t === "b") val = v === "1";
      else if (t === "e") val = null;
      else if (v != null && v !== "") {
        const n = Number(v);
        val = dateStyle[Number(st ?? 0)] && Number.isFinite(n) ? { date: serialToIso(n, date1904) } : Number.isFinite(n) ? n : v;
      }
      if (typeof val === "string") val = val.trim() || null;
      return val;
    };
    const fast = await readSheetRows(src, valueOf).catch(() => null);
    if (fast) {
      for (let k = 0; k < fast.length; k++) if (!fast[k]) fast[k] = [];
      sheets.push({ name: s.getAttribute("name") ?? `Sheet ${sheets.length + 1}`, rows: trimRows(fast) });
      continue;
    }
    const doc = xml(src);
    if (!doc) continue;
    const rows: SheetCell[][] = [];
    for (const r of kids(doc, "row")) {
      const ri = Number(r.getAttribute("r") ?? rows.length + 1) - 1;
      const row: SheetCell[] = [];
      kids(r, "c").forEach((c, ci) => {
        const ref = c.getAttribute("r");
        const col = ref ? colIndex(ref) : ci;
        row[col] = valueOf(c.getAttribute("t"), kids(c, "v")[0]?.textContent ?? null, c.getAttribute("s"), kids(c, "t").map((x) => x.textContent ?? "").join(""));
      });
      for (let k = 0; k < row.length; k++) if (row[k] === undefined) row[k] = null;
      rows[ri] = row;
    }
    for (let k = 0; k < rows.length; k++) if (!rows[k]) rows[k] = [];
    sheets.push({ name: s.getAttribute("name") ?? `Sheet ${sheets.length + 1}`, rows: trimRows(rows) });
  }
  if (!sheets.length) throw new Error("This workbook has no readable sheets.");
  return sheets;
}

/** Drop fully-empty rows at the end and pad every row to the same width. */
function trimRows(rows: SheetCell[][]): SheetCell[][] {
  const filled = (r: SheetCell[]) => r.some((c) => c !== null && c !== "");
  let end = rows.length; while (end > 0 && !filled(rows[end - 1])) end--;
  const out = rows.slice(0, end);
  let start = 0; while (start < out.length && !filled(out[start])) start++;
  const body = out.slice(start);
  const width = Math.max(0, ...body.map((r) => { let w = r.length; while (w > 0 && (r[w - 1] === null || r[w - 1] === "")) w--; return w; }));
  return body.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
}

/* ───────────────────────── helpers for importers ───────────────────────── */

export const colLetter = (i: number) => { let s = "", n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
export const cellText = (c: SheetCell): string => (c == null ? "" : typeof c === "object" ? c.date : typeof c === "boolean" ? (c ? "Yes" : "No") : String(c));
export const normHeader = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** 15000 · 15.000 · 15,000 · 15.000,50 · "15 000 €" → number */
export function parseNumber(c: SheetCell): number | null {
  if (typeof c === "number") return c;
  if (c == null || typeof c !== "string") return null;
  let s = c.replace(/[€$£%\s]/g, "");
  if (!s) return null;
  if (s.includes(".") && s.includes(",")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Excel date cell, ISO, dd/mm/yyyy (European first), yyyy/mm/dd, dd-mm-yy … → "YYYY-MM-DD" */
export function parseDate(c: SheetCell): string | null {
  if (c == null) return null;
  if (typeof c === "object") return c.date;
  if (typeof c === "number") return c > 59 && c < 80000 ? serialToIso(c, false) : null;
  if (typeof c !== "string") return null;
  const s = c.trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return fmt(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let a = +m[1], b = +m[2]; const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (a <= 12 && b > 12) [a, b] = [b, a]; // clearly month/day
    return fmt(y, b, a);
  }
  const d = new Date(s);
  return isNaN(+d) ? null : fmt(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
const fmt = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null);

export function parseBool(c: SheetCell): boolean | null {
  if (typeof c === "boolean") return c;
  if (typeof c === "number") return c === 1 ? true : c === 0 ? false : null;
  if (typeof c !== "string") return null;
  const s = normHeader(c);
  if (["yes", "y", "si", "s", "true", "1", "x", "verdadero", "ok"].includes(s)) return true;
  if (["no", "n", "false", "0", "falso"].includes(s)) return false;
  return null;
}
/* ───────────────────────── cleaning & merging columns (every importer) ─────────────────────────
 * Before an import reads a file, each column can get rules that clean its values
 * ("drop the first word", "remove what column B has", "keep the text before ','"…),
 * and several columns can feed the same field: the importer then sees ONE column
 * per field, whose value is picked by priority, or the longest, or all joined. */

export type ColRuleOp =
  | "dropWords" | "keepWords" | "dropLastWords" | "keepLastWords"
  | "removeCol" | "before" | "after" | "replace" | "case";
export interface ColRule {
  id: string; op: ColRuleOp;
  /** words (drop / keep) */
  n?: number;
  /** the other column (removeCol) */
  col?: number;
  /** separator (before / after) or text to find (replace) */
  text?: string;
  /** replacement (replace) */
  with?: string;
  /** before / after: use the last time the separator appears instead of the first */
  last?: boolean;
  to?: "title" | "upper" | "lower";
}
export type MergeMode = "first" | "last" | "longest" | "shortest" | "join";
export interface MergeRule { order: number[]; mode: MergeMode; sep: string }
export interface ImportPrep {
  /** column → its cleaning rules, applied in order */
  rules: Record<number, ColRule[]>;
  /** target field → how its columns are merged */
  merges: Record<string, MergeRule>;
}
export const emptyPrep = (): ImportPrep => ({ rules: {}, merges: {} });

export const RULE_LABEL: Record<ColRuleOp, string> = {
  dropWords: "Remove the first words", keepWords: "Keep only the first words",
  dropLastWords: "Remove the last words", keepLastWords: "Keep only the last words",
  removeCol: "Remove what another column has", before: "Keep the text before", after: "Keep the text after",
  replace: "Replace text", case: "Change capitals",
};
export const MERGE_LABEL: Record<MergeMode, string> = {
  first: "First with data, by priority", last: "Last with data, by priority", longest: "The longest value", shortest: "The shortest value", join: "Join them all",
};

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const squash = (s: string) => s.replace(/\s+/g, " ").replace(/^[\s,;·\-–]+|[\s,;·\-–]+$/g, "").trim();
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-'’(])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());

/** One column's value after its rules (other columns of the same row are read raw). */
export function applyColRules(value: string, rules: ColRule[] | undefined, row: SheetCell[]): string {
  let s = value ?? "";
  for (const r of rules ?? []) {
    const words = s.trim().split(/\s+/).filter(Boolean);
    const n = Math.max(0, Math.floor(r.n ?? 1));
    switch (r.op) {
      case "dropWords": s = words.slice(n).join(" "); break;
      case "keepWords": s = words.slice(0, n).join(" "); break;
      case "dropLastWords": s = words.slice(0, Math.max(0, words.length - n)).join(" "); break;
      case "keepLastWords": s = n ? words.slice(-n).join(" ") : ""; break;
      case "removeCol": {
        const other = r.col == null ? "" : cellText(row[r.col] ?? null).trim();
        if (!other) break;
        const whole = new RegExp(`(^|[\\s,;])${escRe(other)}(?=$|[\\s,;])`, "i");
        if (whole.test(s)) s = s.replace(whole, "$1");
        else for (const w of other.split(/\s+/).filter(Boolean)) s = s.replace(new RegExp(`(^|[\\s,;])${escRe(w)}(?=$|[\\s,;])`, "i"), "$1");
        s = squash(s);
        break;
      }
      case "before": case "after": {
        const sep = r.text ?? "";
        if (!sep) break;
        const i = r.last ? s.toLowerCase().lastIndexOf(sep.toLowerCase()) : s.toLowerCase().indexOf(sep.toLowerCase());
        if (i < 0) break;
        s = r.op === "before" ? s.slice(0, i) : s.slice(i + sep.length);
        break;
      }
      case "replace": if (r.text) s = s.replace(new RegExp(escRe(r.text), "gi"), r.with ?? ""); break;
      case "case": s = r.to === "upper" ? s.toUpperCase() : r.to === "lower" ? s.toLowerCase() : titleCase(s); break;
    }
    s = squash(s);
  }
  return s;
}

/** The value a merged field takes from its columns' values (already cleaned, in priority order). */
export function mergeValues(values: string[], rule: Pick<MergeRule, "mode" | "sep">): string {
  const vs = values.map((v) => (v ?? "").trim()).filter(Boolean);
  if (!vs.length) return "";
  switch (rule.mode) {
    case "last": return vs[vs.length - 1];
    case "longest": return vs.reduce((a, b) => (b.length > a.length ? b : a));
    case "shortest": return vs.reduce((a, b) => (b.length < a.length ? b : a));
    case "join": return [...new Set(vs)].join(rule.sep ?? " ");
    default: return vs[0];
  }
}

/** Fields fed by several columns (fields that already take several, like notes, don't merge). */
export function mergeGroups(mapping: Record<number, string>, multiOk: Set<string>, prep?: ImportPrep): Record<string, number[]> {
  const by: Record<string, number[]> = {};
  Object.entries(mapping).forEach(([c, t]) => { if (t && !multiOk.has(t)) (by[t] ??= []).push(+c); });
  const out: Record<string, number[]> = {};
  for (const [t, cols] of Object.entries(by)) {
    if (cols.length < 2) continue;
    const order = (prep?.merges[t]?.order ?? []).filter((c) => cols.includes(c));
    out[t] = [...order, ...cols.filter((c) => !order.includes(c)).sort((a, b) => a - b)];
  }
  return out;
}

/**
 * The file as the importer should read it: cleaned cells, and one column per merged
 * field (the first by priority carries the merged value; the others stop importing).
 */
export function prepareImport(rows: SheetCell[][], mapping: Record<number, string>, prep: ImportPrep, multiOk: Set<string>): {
  rows: SheetCell[][]; mapping: Record<number, string>; groups: Record<string, number[]>;
} {
  const ruled = Object.entries(prep.rules).filter(([, rs]) => rs?.length).map(([c, rs]) => [+c, rs] as const);
  const groups = mergeGroups(mapping, multiOk, prep);
  const groupList = Object.entries(groups);
  if (!ruled.length && !groupList.length) return { rows, mapping, groups };
  const out = rows.map((r) => {
    const row = r.slice();
    for (const [c, rs] of ruled) {
      const v = applyColRules(cellText(r[c] ?? null), rs, r);
      row[c] = v === "" ? null : v;
    }
    for (const [t, cols] of groupList) {
      const rule = prep.merges[t] ?? { order: cols, mode: "first" as MergeMode, sep: " " };
      const v = mergeValues(cols.map((c) => cellText(row[c] ?? null)), rule);
      // a single value keeps its cell as it was (a real date or number stays one)
      const only = cols.filter((c) => cellText(row[c] ?? null).trim());
      row[cols[0]] = only.length === 1 && rule.mode !== "join" ? row[only[0]] : v === "" ? null : v;
    }
    return row;
  });
  const m = { ...mapping };
  for (const [, cols] of groupList) cols.slice(1).forEach((c) => { m[c] = ""; });
  return { rows: out, mapping: m, groups };
}
