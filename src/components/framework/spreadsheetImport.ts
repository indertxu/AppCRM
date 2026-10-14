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
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
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

  const shared = kids(xml(files.get("xl/sharedStrings.xml")), "si").map((si) =>
    Array.from(si.childNodes).map((n) => {
      const el = n as Element;
      if (el.nodeName === "t") return el.textContent ?? "";
      if (el.nodeName === "r") return kids(el, "t").map((t) => t.textContent ?? "").join("");
      return "";
    }).join(""));

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
    const doc = xml(files.get(rels.get(rid) ?? ""));
    if (!doc) continue;
    const rows: SheetCell[][] = [];
    for (const r of kids(doc, "row")) {
      const ri = Number(r.getAttribute("r") ?? rows.length + 1) - 1;
      const row: SheetCell[] = [];
      kids(r, "c").forEach((c, ci) => {
        const ref = c.getAttribute("r");
        const col = ref ? colIndex(ref) : ci;
        const t = c.getAttribute("t");
        const v = kids(c, "v")[0]?.textContent ?? null;
        let val: SheetCell = null;
        if (t === "s") val = v != null ? shared[Number(v)] ?? null : null;
        else if (t === "inlineStr") val = kids(c, "t").map((x) => x.textContent ?? "").join("") || null;
        else if (t === "str") val = v;
        else if (t === "b") val = v === "1";
        else if (t === "e") val = null;
        else if (v != null && v !== "") {
          const n = Number(v);
          val = dateStyle[Number(c.getAttribute("s") ?? 0)] && Number.isFinite(n) ? { date: serialToIso(n, date1904) } : Number.isFinite(n) ? n : v;
        }
        if (typeof val === "string") val = val.trim() || null;
        row[col] = val;
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