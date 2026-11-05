/**
 * Tiny, dependency-free table export: CSV (Excel-friendly for Spanish locale)
 * and real .xlsx (stored ZIP, bold frozen header, autofilter, typed cells).
 *
 * A cell is `null` (empty), a string, a number, or `{ date: "YYYY-MM-DD" }`.
 * Columns may declare `format: "money"` so numbers get a € format in Excel.
 */

export type ExportCell = string | number | null | { date: string };
export interface ExportColumn { label: string; format?: "money" | "number" | "percent" | "date" | "text" }
export interface ExportTable { columns: ExportColumn[]; rows: ExportCell[][] }

/* ─────────────────────────── download ─────────────────────────── */

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ─────────────────────────── CSV ─────────────────────────── */

/** `;` separator + decimal comma + BOM: opens cleanly in Excel set to Spanish. */
export function tableToCsv(t: ExportTable): Blob {
  const esc = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const cell = (c: ExportCell): string => {
    if (c == null) return "";
    if (typeof c === "number") return String(c).replace(".", ",");
    if (typeof c === "object") return c.date;
    return esc(c);
  };
  const lines = [t.columns.map((c) => esc(c.label)).join(";"), ...t.rows.map((r) => r.map(cell).join(";"))];
  return new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
}

/* ─────────────────────────── XLSX ─────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(d: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Uncompressed ("stored") ZIP — all an .xlsx needs. */
function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), name, f.data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true);
    ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

const xml = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const colName = (i: number) => {
  let s = "", n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

const excelSerial = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
};

// style ids in cellXfs below
const S_HEAD = 1, S_DATE = 2, S_MONEY = 3;

export function tableToXlsx(t: ExportTable, sheetName = "Export"): Blob {
  const enc = new TextEncoder();
  const sheet = xml(sheetName.slice(0, 31).replace(/[\\/?*[\]:]/g, " ") || "Export");
  const nCols = Math.max(1, t.columns.length);
  const lastRef = `${colName(nCols - 1)}${t.rows.length + 1}`;

  const width = t.columns.map((c, i) => {
    let w = c.label.length;
    for (const r of t.rows.slice(0, 500)) {
      const v = r[i];
      const len = v == null ? 0 : typeof v === "object" ? 10 : String(v).length;
      if (len > w) w = len;
    }
    return Math.min(55, Math.max(10, w + 2));
  });

  const cellXml = (c: ExportCell, ref: string, col: ExportColumn): string => {
    if (c == null || c === "") return "";
    if (typeof c === "number") return `<c r="${ref}"${col.format === "money" ? ` s="${S_MONEY}"` : ""}><v>${c}</v></c>`;
    if (typeof c === "object") {
      const n = excelSerial(c.date);
      return n == null ? "" : `<c r="${ref}" s="${S_DATE}"><v>${n}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(c)}</t></is></c>`;
  };

  const head = `<row r="1">${t.columns.map((c, i) =>
    `<c r="${colName(i)}1" t="inlineStr" s="${S_HEAD}"><is><t xml:space="preserve">${xml(c.label)}</t></is></c>`).join("")}</row>`;
  const body = t.rows.map((r, ri) =>
    `<row r="${ri + 2}">${r.map((c, ci) => cellXml(c, `${colName(ci)}${ri + 2}`, t.columns[ci] ?? { label: "" })).join("")}</row>`).join("");

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${width.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData>${head}${body}</sheetData>` +
    (t.columns.length ? `<autoFilter ref="A1:${lastRef}"/>` : "") +
    `</worksheet>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets>` +
    (t.columns.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${sheet.replace(/'/g, "''")}'!$A$1:$${colName(nCols - 1)}$${t.rows.length + 1}</definedName></definedNames>` : "") +
    `</workbook>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00 &quot;€&quot;"/></numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="4">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const files = [
    { name: "[Content_Types].xml", data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`) },
    { name: "_rels/.rels", data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheetXml) },
    { name: "xl/styles.xml", data: enc.encode(styles) },
  ];
  return new Blob([zipStore(files).buffer as ArrayBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/* ─────────────────────────── Styled XLSX ─────────────────────────── */
/*
 * Cell-level control for fixed-layout exports (e.g. the invoicing sheet):
 * bold / underline / colour, number formats, per-edge borders, alignment,
 * formulas (with a cached value) and mailto/URL hyperlinks.
 */

export type XBorder = "thin" | "medium";
export interface XStyle {
  bold?: boolean; underline?: boolean; color?: string; // "RRGGBB"
  fmt?: string;                                         // Excel number format code
  align?: "left" | "center" | "right";
  border?: { t?: XBorder; b?: XBorder; l?: XBorder; r?: XBorder };
}
export interface XCell {
  v: string | number | null;
  /** v is an ISO date (YYYY-MM-DD) → written as a real Excel date. */
  date?: boolean;
  /** Formula without "=", v is its cached result. */
  formula?: string;
  link?: string;
  s?: XStyle;
}
export interface XSheet { name: string; cols: number[]; rows: (XCell | null)[][] }

export function sheetToXlsx(sheet: XSheet): Blob {
  const enc = new TextEncoder();
  const name = xml(sheet.name.slice(0, 31).replace(/[\\/?*[\]:]/g, " ") || "Sheet1");

  // style registries (index 0 is always the default)
  const fonts = ["<font><sz val=\"11\"/><name val=\"Calibri\"/></font>"];
  const borders = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  const numFmts: string[] = [];
  const xfs = ["<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>"];
  const xfIndex = new Map<string, number>([["{}", 0]]);
  const idx = (list: string[], item: string) => { let i = list.indexOf(item); if (i < 0) { list.push(item); i = list.length - 1; } return i; };

  const styleId = (s?: XStyle): number => {
    if (!s) return 0;
    const key = JSON.stringify(s);
    if (xfIndex.has(key)) return xfIndex.get(key)!;
    const font = (s.bold || s.underline || s.color)
      ? idx(fonts, `<font>${s.bold ? "<b/>" : ""}${s.underline ? "<u/>" : ""}<sz val="11"/>${s.color ? `<color rgb="FF${s.color}"/>` : ""}<name val="Calibri"/></font>`)
      : 0;
    const e = (tag: string, st?: XBorder) => (st ? `<${tag} style="${st}"><color auto="1"/></${tag}>` : `<${tag}/>`);
    const border = s.border
      ? idx(borders, `<border>${e("left", s.border.l)}${e("right", s.border.r)}${e("top", s.border.t)}${e("bottom", s.border.b)}<diagonal/></border>`)
      : 0;
    const fmt = s.fmt ? 164 + idx(numFmts, s.fmt) : 0;
    const align = s.align ? `<alignment horizontal="${s.align}"/>` : "";
    const xf = `<xf numFmtId="${fmt}" fontId="${font}" fillId="0" borderId="${border}" xfId="0"`
      + `${fmt ? " applyNumberFormat=\"1\"" : ""}${font ? " applyFont=\"1\"" : ""}${border ? " applyBorder=\"1\"" : ""}`
      + (align ? ` applyAlignment="1">${align}</xf>` : "/>");
    xfs.push(xf);
    xfIndex.set(key, xfs.length - 1);
    return xfs.length - 1;
  };

  const links: { ref: string; target: string }[] = [];
  const rowsXml = sheet.rows.map((row, ri) => {
    const r = ri + 1;
    const cells = row.map((c, ci) => {
      if (!c) return "";
      const ref = `${colName(ci)}${r}`;
      const s = styleId(c.s);
      const sAttr = s ? ` s="${s}"` : "";
      if (c.link) links.push({ ref, target: c.link });
      if (c.formula) {
        const val = typeof c.v === "number" ? `<v>${c.v}</v>` : "";
        return `<c r="${ref}"${sAttr}><f>${xml(c.formula)}</f>${val}</c>`;
      }
      if (c.v == null || c.v === "") return s ? `<c r="${ref}"${sAttr}/>` : "";
      if (c.date && typeof c.v === "string") {
        const n = excelSerial(c.v);
        return n == null ? `<c r="${ref}"${sAttr}/>` : `<c r="${ref}"${sAttr}><v>${n}</v></c>`;
      }
      if (typeof c.v === "number") return `<c r="${ref}"${sAttr}><v>${c.v}</v></c>`;
      return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xml(c.v)}</t></is></c>`;
    }).join("");
    return `<row r="${r}">${cells}</row>`;
  }).join("");

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` +
    `<sheetViews><sheetView workbookViewId="0" showGridLines="1"/></sheetViews>` +
    `<cols>${sheet.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData>${rowsXml}</sheetData>` +
    (links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rIdL${i + 1}"/>`).join("")}</hyperlinks>` : "") +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>` +
    `</worksheet>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xml(f)}"/>`).join("")}</numFmts>` : "") +
    `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="${borders.length}">${borders.join("")}</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const files = [
    { name: "[Content_Types].xml", data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`) },
    { name: "_rels/.rels", data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`) },
    { name: "xl/workbook.xml", data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheetXml) },
    { name: "xl/styles.xml", data: enc.encode(styles) },
  ];
  if (links.length) files.push({ name: "xl/worksheets/_rels/sheet1.xml.rels", data: enc.encode(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    links.map((l, i) => `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(l.target)}" TargetMode="External"/>`).join("") +
    `</Relationships>`) });

  return new Blob([zipStore(files).buffer as ArrayBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}