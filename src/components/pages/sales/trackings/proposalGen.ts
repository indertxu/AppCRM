/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Proposal generator — builds a client-ready PPTX deck or PDF order form from
 * a deal + the tenant's proposal template. Runs in the browser (pptxgenjs +
 * jsPDF) and in node (for demos/tests). Everything visual is driven by
 * `template.brand`; every number by `data`. No tenant-specific code in here.
 */

// ---------------------------------------------------------------- types ----
export interface Brand {
  company: string; legalName?: string; vat?: string; address?: string; web?: string;
  colors: { primary: string; accent: string; mint: string; ink: string; muted: string; light: string };
  fonts: { heading: string; body: string };
  contact?: { name: string; role?: string; email?: string; phone?: string };
  footer?: string;
  /** base64 data URIs ("image/png;base64,...") — optional */
  assets?: { logoLight?: string; logoDark?: string; bgCover?: string; bgLight?: string; clientLogo?: string };
}
export interface TemplateSection { key: string; enabled: boolean; title?: string; [k: string]: any }
export interface ProposalTemplate { brand: Brand; sections: TemplateSection[]; terms: { validityDays?: number; paymentDays?: number; annualIncreasePct?: number; minBillableDay?: number; notes?: string[] } }

export interface ProposalLineRow { label: string; detail?: string; amount: number; days?: number }
export interface ProposalProduct { name: string; tier?: string; recurring: boolean; period?: "monthly" | "yearly"; termYears: number; unitPrice: number; qty: number; rows: ProposalLineRow[]; discount: number; total: number }
export interface ProposalServicePhase { name: string; bullets: string[]; days: number }
export interface ProposalService { name: string; unit: "day" | "hour"; days: number; rate: number; rows: ProposalLineRow[]; phases: ProposalServicePhase[]; discount: number; total: number; roles?: { name: string; days: number; rate: number }[] }
export interface ProposalData {
  client: { name: string; legalName?: string; vat?: string; address?: string; contactName?: string; contactRole?: string; contactEmail?: string };
  deal: { title: string; date: string; ref?: string; subtitle?: string };
  context?: { stats: { value: string; label: string; sub?: string }[]; situation?: string };
  diagnosis?: { title: string; items: string[] }[];
  solution?: { from: string; to: string; result: string }[];
  scope?: { title: string; text: string }[];
  differentiation?: { title: string; text: string }[];
  products: ProposalProduct[];
  services: ProposalService[];
  totals: { products: number; services: number; discount: number; total: number };
  references?: { company: string; stat: string; statLabel: string; before: string; quote: string; author: string }[];
  conditions?: string[];
}

// ------------------------------------------------------------ helpers -----
const eur = (n: number) => `${Math.round(n).toLocaleString("es-ES")} €`;
const num = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",");
const section = (t: ProposalTemplate, key: string) => t.sections.find((s) => s.key === key);
const on = (t: ProposalTemplate, key: string) => section(t, key)?.enabled !== false;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });

/** Default slide titles — used when the template doesn't set its own. */
export function defaultSlideTitle(key: string, company: string): string {
  const d: Record<string, string> = {
    summary: "Una solución a la altura del grupo",
    context: "Panorama actual del cliente",
    diagnosis: "Limitaciones del modelo actual",
    solution: `Cómo ${company} elimina las limitaciones actuales`,
    scope: `Cómo ${company} refuerza el control del grupo`,
    investment: "Propuesta económica: licencia",
    services: "Propuesta económica: servicios",
    references: "Resultados reales, clientes que ya decidieron",
    conditions: "Condiciones financieras y contractuales",
    closing: "¡Muchas gracias!",
  };
  return d[key] ?? "";
}
const slideTitle = (t: ProposalTemplate, key: string) =>
  String(section(t, key)?.title ?? "").trim() || defaultSlideTitle(key, t.brand.company);

const clean = (a: any): string[] => (Array.isArray(a) ? a.map((x) => String(x ?? "").trim()).filter(Boolean) : []);

/**
 * Narrative slides (context, diagnosis, solution, scope, references) take their
 * copy from the deal data when it has it, otherwise from the template's section
 * (written once per company in Settings → Proposal template).
 */
export function withTemplateNarrative(data: ProposalData, t: ProposalTemplate): ProposalData {
  const sec = (k: string) => section(t, k) ?? ({} as TemplateSection);
  const d: ProposalData = { ...data };
  if (!d.context) {
    const c = sec("context");
    const stats = (c.stats ?? []).filter((x: any) => x?.value || x?.label);
    const situation = String(c.situation ?? "").trim();
    if (stats.length || situation) d.context = { stats, situation: situation || undefined };
  }
  if (!d.diagnosis?.length) {
    const cols = (sec("diagnosis").columns ?? [])
      .map((x: any) => ({ title: String(x?.title ?? "").trim(), items: clean(x?.items) }))
      .filter((x: any) => x.title || x.items.length);
    if (cols.length) d.diagnosis = cols;
  }
  if (!d.solution?.length) {
    const rows = (sec("solution").rows ?? []).filter((x: any) => x?.from || x?.to || x?.result)
      .map((x: any) => ({ from: x.from ?? "", to: x.to ?? "", result: x.result ?? "" }));
    if (rows.length) d.solution = rows;
  }
  if (!d.scope?.length) {
    const items = (sec("scope").items ?? []).filter((x: any) => x?.title || x?.text)
      .map((x: any) => ({ title: x.title ?? "", text: x.text ?? "" }));
    if (items.length) d.scope = items;
  }
  if (!d.references?.length) {
    const refs = (sec("references").items ?? []).filter((x: any) => x?.company)
      .map((x: any) => ({ company: x.company ?? "", stat: x.stat ?? "", statLabel: x.statLabel ?? "", before: x.before ?? "", quote: x.quote ?? "", author: x.author ?? "" }));
    if (refs.length) d.references = refs;
  }
  return d;
}

// ============================================================== PPTX ======
export async function buildProposalDeck(pptxgen: any, data: ProposalData, t: ProposalTemplate): Promise<any> {
  data = withTemplateNarrative(data, t);
  const B = t.brand, C = B.colors, F = B.fonts;
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5
  const W = 13.33, H = 7.5, M = 0.6;

  // ---- shared building blocks ----
  const footer = (s: any, dark = false) => {
    s.addText(B.footer ?? `${B.company} | Confidential`, { x: M, y: H - 0.42, w: 6, h: 0.3, fontFace: F.body, fontSize: 9, color: dark ? "A7D9C4" : C.muted, isTextBox: true, margin: 0 });
    const logo = dark ? B.assets?.logoLight : B.assets?.logoDark;
    if (logo) s.addImage({ data: logo, x: W - M - 1.7, y: H - 0.5, w: 1.7, h: 0.45, sizing: { type: "contain", w: 1.7, h: 0.45 } });
  };
  const eyebrow = (s: any, text: string, y = 0.55) =>
    s.addText(text.toUpperCase(), { x: M, y, w: 8, h: 0.3, fontFace: F.heading, fontSize: 10, bold: true, color: C.accent, charSpacing: 4, isTextBox: true, margin: 0 });
  const title = (s: any, text: string, y = 0.9, size = 30, w = W - 2 * M) =>
    s.addText(text, { x: M, y, w, h: 1.0, fontFace: F.heading, fontSize: size, bold: true, color: C.primary, isTextBox: true, margin: 0, valign: "top" });
  const lightSlide = () => {
    const s = pres.addSlide();
    if (B.assets?.bgLight) s.background = { data: B.assets.bgLight }; else s.background = { color: "FFFFFF" };
    footer(s); return s;
  };
  const card = (s: any, x: number, y: number, w: number, h: number, fill = C.light) =>
    s.addShape(pres.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: "E3EEE8", width: 0.75 }, rectRadius: 0.12 });
  const iconCircle = (s: any, x: number, y: number, label: string) => {
    s.addShape(pres.ShapeType.ellipse, { x, y, w: 0.42, h: 0.42, fill: { color: C.accent }, line: { color: C.accent } });
    s.addText(label, { x, y, w: 0.42, h: 0.42, fontFace: F.heading, fontSize: 11, bold: true, color: "FFFFFF", align: "center", valign: "middle", isTextBox: true, margin: 0 });
  };

  // ================================================================ COVER
  if (on(t, "cover")) {
    const s = pres.addSlide();
    if (B.assets?.bgCover) s.background = { data: B.assets.bgCover }; else s.background = { color: C.primary };
    eyebrow(s, "Propuesta comercial", 2.55);
    s.addText(`${B.company} · ${data.client.name}`, { x: M, y: 2.9, w: W - 2 * M, h: 1.2, fontFace: F.heading, fontSize: 40, bold: true, color: "FFFFFF", isTextBox: true, margin: 0, valign: "top" });
    if (data.deal.subtitle) s.addText(data.deal.subtitle, { x: M, y: 4.15, w: 9, h: 0.6, fontFace: F.body, fontSize: 16, color: "DFF5EA", isTextBox: true, margin: 0 });
    s.addText(fmtDate(data.deal.date), { x: M, y: 4.75, w: 6, h: 0.4, fontFace: F.body, fontSize: 13, color: "A7D9C4", isTextBox: true, margin: 0 });
    // logos block
    s.addShape(pres.ShapeType.rect, { x: 0, y: H - 1.05, w: 6.2, h: 1.05, fill: { color: C.primary }, line: { color: C.primary } });
    if (B.assets?.logoLight) s.addImage({ data: B.assets.logoLight, x: M, y: H - 0.85, w: 2.2, h: 0.6, sizing: { type: "contain", w: 2.2, h: 0.6 } });
    if (B.assets?.clientLogo) s.addImage({ data: B.assets.clientLogo, x: M + 2.6, y: H - 0.85, w: 2.2, h: 0.6, sizing: { type: "contain", w: 2.2, h: 0.6 } });
    else s.addText(data.client.name, { x: M + 2.6, y: H - 0.85, w: 3.2, h: 0.6, fontFace: F.heading, fontSize: 14, bold: true, color: "FFFFFF", isTextBox: true, margin: 0, valign: "middle" });
  }

  // ============================================================== SUMMARY
  if (on(t, "summary")) {
    const s = lightSlide();
    eyebrow(s, "Resumen ejecutivo");
    title(s, slideTitle(t, "summary"), 0.9, 28);
    const intro = section(t, "summary")?.intro ??
      `${data.client.legalName ?? data.client.name} necesita un modelo de trabajo moderno, auditable y escalable. Esta propuesta plantea cómo ${B.company} lo hace posible, con un alcance claro y una inversión predecible.`;
    s.addText(intro, { x: M, y: 2.15, w: W - 2 * M, h: 1.1, fontFace: F.body, fontSize: 14, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
    const cols = [
      ["I", "Diagnóstico", "Revisión de los puntos críticos del proceso actual."],
      ["II", "Recomendación", `${B.company} como solución y equipo de implantación.`],
      ["III", "Inversión", "Modelo económico predecible y alcance del proyecto."],
    ];
    cols.forEach(([n, h, p], i) => {
      const x = M + i * 4.1;
      card(s, x, 3.7, 3.8, 2.3);
      iconCircle(s, x + 0.3, 4.0, n);
      s.addText(h, { x: x + 0.9, y: 3.98, w: 2.7, h: 0.45, fontFace: F.heading, fontSize: 15, bold: true, color: C.primary, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(p, { x: x + 0.3, y: 4.6, w: 3.2, h: 1.2, fontFace: F.body, fontSize: 12.5, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
    });
  }

  // ============================================================== CONTEXT
  if (on(t, "context") && data.context) {
    const s = lightSlide();
    eyebrow(s, "01 · Contexto");
    title(s, slideTitle(t, "context"), 0.9, 28);
    const stats = data.context.stats.slice(0, 4);
    stats.forEach((st, i) => {
      const x = M + i * 3.05;
      s.addText(st.value, { x, y: 2.05, w: 2.9, h: 1.0, fontFace: F.heading, fontSize: 48, bold: true, color: C.primary, isTextBox: true, margin: 0, valign: "bottom" });
      s.addText(st.label.toUpperCase(), { x, y: 3.1, w: 2.9, h: 0.35, fontFace: F.heading, fontSize: 9.5, bold: true, color: C.accent, charSpacing: 2, isTextBox: true, margin: 0 });
      if (st.sub) s.addText(st.sub, { x, y: 3.45, w: 2.9, h: 0.6, fontFace: F.body, fontSize: 11.5, color: C.muted, isTextBox: true, margin: 0, valign: "top" });
    });
    if (data.context.situation) {
      card(s, M, 4.45, W - 2 * M, 2.1, "FFFFFF");
      s.addText("SITUACIÓN ACTUAL", { x: M + 0.35, y: 4.65, w: 6, h: 0.3, fontFace: F.heading, fontSize: 10.5, bold: true, color: C.primary, charSpacing: 2, isTextBox: true, margin: 0 });
      s.addText(data.context.situation, { x: M + 0.35, y: 5.0, w: W - 2 * M - 0.7, h: 1.4, fontFace: F.body, fontSize: 12.5, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
    }
  }

  // ============================================================ DIAGNOSIS
  if (on(t, "diagnosis") && data.diagnosis?.length) {
    const s = lightSlide();
    eyebrow(s, "02 · Diagnóstico");
    title(s, slideTitle(t, "diagnosis"), 0.9, 28);
    const cols = data.diagnosis.slice(0, 3);
    const cw = (W - 2 * M - 0.4 * (cols.length - 1)) / cols.length;
    cols.forEach((col, i) => {
      const x = M + i * (cw + 0.4);
      s.addText(col.title.toUpperCase(), { x, y: 2.05, w: cw, h: 0.35, fontFace: F.heading, fontSize: 10.5, bold: true, color: C.primary, charSpacing: 2, isTextBox: true, margin: 0 });
      col.items.slice(0, 5).forEach((it, j) => {
        const y = 2.6 + j * 0.78;
        s.addText(String(j + 1).padStart(2, "0"), { x, y, w: 0.45, h: 0.5, fontFace: F.heading, fontSize: 11, bold: true, color: C.accent, isTextBox: true, margin: 0, valign: "top" });
        s.addText(it, { x: x + 0.5, y, w: cw - 0.5, h: 0.7, fontFace: F.body, fontSize: 12.5, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
      });
    });
  }

  // ============================================================= SOLUTION
  if (on(t, "solution") && data.solution?.length) {
    const s = lightSlide();
    eyebrow(s, "03 · Recomendación");
    title(s, slideTitle(t, "solution"), 0.9, 26);
    const heads = ["Situación actual", `Con ${B.company}`, "Resultado"];
    const xs = [M, M + 4.0, M + 8.6], ws = [3.7, 4.3, 3.5];
    heads.forEach((h, i) => s.addText(h.toUpperCase(), { x: xs[i], y: 2.05, w: ws[i], h: 0.3, fontFace: F.heading, fontSize: 10, bold: true, color: i === 1 ? C.accent : C.muted, charSpacing: 2, isTextBox: true, margin: 0 }));
    data.solution.slice(0, 4).forEach((row, j) => {
      const y = 2.5 + j * 1.05;
      s.addShape(pres.ShapeType.line, { x: M, y: y + 0.95, w: W - 2 * M, h: 0, line: { color: "E3EEE8", width: 0.75 } });
      s.addText(row.from, { x: xs[0], y, w: ws[0], h: 0.9, fontFace: F.body, fontSize: 12, color: C.muted, isTextBox: true, margin: 0, valign: "middle" });
      s.addText("→", { x: xs[1] - 0.35, y, w: 0.3, h: 0.9, fontFace: F.heading, fontSize: 16, bold: true, color: C.accent, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(row.to, { x: xs[1], y, w: ws[1], h: 0.9, fontFace: F.body, fontSize: 12, bold: true, color: C.primary, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(row.result, { x: xs[2], y, w: ws[2], h: 0.9, fontFace: F.body, fontSize: 12, italic: true, color: C.ink, isTextBox: true, margin: 0, valign: "middle" });
    });
  }

  // ================================================================ SCOPE
  if (on(t, "scope") && data.scope?.length) {
    const s = lightSlide();
    eyebrow(s, "04 · Alcance");
    title(s, slideTitle(t, "scope"), 0.9, 26);
    data.scope.slice(0, 6).forEach((it, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const x = M + col * 4.1, y = 2.1 + row * 2.45;
      iconCircle(s, x, y, String(i + 1).padStart(2, "0"));
      s.addText(it.title, { x, y: y + 0.55, w: 3.7, h: 0.45, fontFace: F.heading, fontSize: 14, bold: true, color: C.primary, isTextBox: true, margin: 0 });
      s.addText(it.text, { x, y: y + 1.0, w: 3.7, h: 1.3, fontFace: F.body, fontSize: 11.5, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
    });
  }

  // =========================================================== INVESTMENT
  if (on(t, "investment") && data.products.length) {
    const s = lightSlide();
    eyebrow(s, "05 · Inversión");
    title(s, slideTitle(t, "investment"), 0.9, 28);
    const p = data.products[0];
    const yearly = p.recurring && p.period === "monthly" ? p.unitPrice * 12 : p.unitPrice;
    // left card: breakdown
    card(s, M, 2.0, 6.0, 3.3, "FFFFFF");
    s.addText(p.name.toUpperCase(), { x: M + 0.35, y: 2.2, w: 5.3, h: 0.3, fontFace: F.heading, fontSize: 10, bold: true, color: C.primary, charSpacing: 2, isTextBox: true, margin: 0 });
    const lines: [string, string][] = p.rows.length
      ? p.rows.map((r) => [r.label + (r.detail ? ` (${r.detail})` : ""), eur(r.amount)])
      : [[p.tier ? `Tier ${p.tier}` : "Suscripción", eur(yearly)]];
    if (p.discount > 0) lines.push([`Descuento`, `-${eur(p.discount)}`]);
    lines.slice(0, 5).forEach(([l, v], i) => {
      const y = 2.62 + i * 0.42;
      s.addText(l, { x: M + 0.35, y, w: 3.7, h: 0.38, fontFace: F.body, fontSize: 12, color: l === "Descuento" ? C.accent : C.ink, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(v, { x: M + 4.0, y, w: 1.65, h: 0.38, fontFace: F.body, fontSize: 12, bold: true, color: l === "Descuento" ? C.accent : C.ink, align: "right", isTextBox: true, margin: 0, valign: "middle" });
    });
    s.addShape(pres.ShapeType.line, { x: M + 0.35, y: 4.75, w: 5.3, h: 0, line: { color: "E3EEE8", width: 0.75 } });
    s.addText(p.recurring ? "Anualidad" : "Total", { x: M + 0.35, y: 4.85, w: 3, h: 0.35, fontFace: F.heading, fontSize: 13, bold: true, color: C.primary, isTextBox: true, margin: 0, valign: "middle" });
    s.addText(eur(p.recurring ? yearly - p.discount / Math.max(1, p.termYears) : p.total), { x: M + 3.0, y: 4.85, w: 2.65, h: 0.35, fontFace: F.heading, fontSize: 13, bold: true, color: C.primary, align: "right", isTextBox: true, margin: 0, valign: "middle" });
    // right hero: final investment
    s.addShape(pres.ShapeType.roundRect, { x: M + 6.4, y: 2.0, w: W - 2 * M - 6.4, h: 3.3, fill: { color: C.primary }, line: { color: C.primary }, rectRadius: 0.12 });
    s.addText(p.recurring ? `TOTAL CONTRATO · ${p.termYears} ${p.termYears === 1 ? "AÑO" : "AÑOS"}` : "INVERSIÓN TOTAL", { x: M + 6.8, y: 2.3, w: 5.5, h: 0.3, fontFace: F.heading, fontSize: 10, bold: true, color: "A7D9C4", charSpacing: 2, isTextBox: true, margin: 0 });
    s.addText(eur(p.total), { x: M + 6.8, y: 2.65, w: 5.5, h: 1.0, fontFace: F.heading, fontSize: 44, bold: true, color: C.mint, isTextBox: true, margin: 0, valign: "middle" });
    if (p.recurring) s.addText(`${eur(p.total / Math.max(1, p.termYears))} / año`, { x: M + 6.8, y: 3.65, w: 5.5, h: 0.4, fontFace: F.body, fontSize: 14, color: "FFFFFF", isTextBox: true, margin: 0 });
    if (p.discount > 0) s.addText(`Incluye ${eur(p.discount)} de descuento comercial`, { x: M + 6.8, y: 4.1, w: 5.5, h: 0.4, fontFace: F.body, fontSize: 12, color: "DFF5EA", isTextBox: true, margin: 0 });
    s.addText("IVA no incluido", { x: M + 6.8, y: 4.75, w: 5.5, h: 0.3, fontFace: F.body, fontSize: 9.5, color: "A7D9C4", isTextBox: true, margin: 0 });
    // included list
    const inc = clean(section(t, "investment")?.included).length ? clean(section(t, "investment")?.included) : ["Solución 100% cloud", "Usuarios ilimitados", "Soporte especializado y actualizaciones continuas", "Formación del equipo incluida"];
    s.addText("INCLUIDO", { x: M, y: 5.6, w: 4, h: 0.3, fontFace: F.heading, fontSize: 10, bold: true, color: C.muted, charSpacing: 2, isTextBox: true, margin: 0 });
    s.addText(inc.slice(0, 6).map((x: string, i: number, a: string[]) => ({ text: x, options: { bullet: { code: "2713" }, breakLine: i < a.length - 1, paraSpaceAfter: 3 } })),
      { x: M, y: 5.9, w: W - 2 * M, h: 1.0, fontFace: F.body, fontSize: 11.5, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
  }

  // ============================================================= SERVICES
  if (on(t, "services") && data.services.length) {
    const s = lightSlide();
    eyebrow(s, "06 · Servicios");
    title(s, slideTitle(t, "services"), 0.9, 28);
    const sv = data.services[0];
    // phases table (left)
    const rows: any[] = [[
      { text: "FASE", options: { bold: true, color: "FFFFFF", fill: { color: C.primary }, fontFace: F.heading, fontSize: 9 } },
      { text: "DESCRIPCIÓN", options: { bold: true, color: "FFFFFF", fill: { color: C.primary }, fontFace: F.heading, fontSize: 9 } },
      { text: "DÍAS", options: { bold: true, color: "FFFFFF", fill: { color: C.primary }, fontFace: F.heading, fontSize: 9, align: "center" } },
    ]];
    sv.phases.slice(0, 7).forEach((ph, i) => rows.push([
      { text: ph.name, options: { bold: true, color: C.primary, fontFace: F.heading, fontSize: 9.5, fill: { color: i % 2 ? "FFFFFF" : C.light } } },
      { text: ph.bullets.map((b, k) => ({ text: b, options: { bullet: true, breakLine: k < ph.bullets.length - 1 } })), options: { color: C.ink, fontFace: F.body, fontSize: 8.5, fill: { color: i % 2 ? "FFFFFF" : C.light } } },
      { text: num(ph.days), options: { bold: true, color: C.primary, fontFace: F.heading, fontSize: 11, align: "center", valign: "middle", fill: { color: i % 2 ? "FFFFFF" : C.light } } },
    ]));
    rows.push([
      { text: `${num(sv.days)} jornadas`, options: { bold: true, italic: true, color: C.primary, fontFace: F.body, fontSize: 10, fill: { color: "E3EEE8" }, colspan: 2 } },
      { text: num(sv.days), options: { bold: true, color: "FFFFFF", fontFace: F.heading, fontSize: 11, align: "center", fill: { color: C.accent } } },
    ]);
    s.addTable(rows, { x: M, y: 1.95, w: 7.3, colW: [1.35, 5.2, 0.75], border: { type: "solid", color: "E3EEE8", pt: 0.5 }, margin: 0.06, autoPage: false });
    // rate card (right)
    const rx = M + 7.7, rw = W - 2 * M - 7.7;
    s.addShape(pres.ShapeType.roundRect, { x: rx, y: 1.95, w: rw, h: 2.75, fill: { color: C.primary }, line: { color: C.primary }, rectRadius: 0.12 });
    s.addText("TARIFAS", { x: rx + 0.3, y: 2.12, w: 3, h: 0.3, fontFace: F.heading, fontSize: 10, bold: true, color: "A7D9C4", charSpacing: 2, isTextBox: true, margin: 0 });
    const roles = sv.roles?.length ? sv.roles : [{ name: sv.name, days: sv.days, rate: sv.rate }];
    roles.slice(0, 3).forEach((r, i) => {
      const y = 2.5 + i * 0.42;
      s.addText(r.name, { x: rx + 0.3, y, w: 1.9, h: 0.38, fontFace: F.body, fontSize: 11, bold: true, color: "FFFFFF", isTextBox: true, margin: 0, valign: "middle" });
      s.addText(`${num(r.days)} d`, { x: rx + 2.2, y, w: 0.7, h: 0.38, fontFace: F.body, fontSize: 11, color: "DFF5EA", align: "right", isTextBox: true, margin: 0, valign: "middle" });
      s.addText(`${eur(r.rate)}/día`, { x: rx + 2.95, y, w: rw - 3.25, h: 0.38, fontFace: F.body, fontSize: 11, color: "DFF5EA", align: "right", isTextBox: true, margin: 0, valign: "middle" });
    });
    const yb = 2.5 + Math.min(3, roles.length) * 0.42 + 0.15;
    s.addShape(pres.ShapeType.line, { x: rx + 0.3, y: yb, w: rw - 0.6, h: 0, line: { color: "3D6B58", width: 0.75 } });
    if (sv.discount > 0) {
      s.addText("Descuento", { x: rx + 0.3, y: yb + 0.1, w: 2.5, h: 0.35, fontFace: F.body, fontSize: 11.5, color: C.mint, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(`-${eur(sv.discount)}`, { x: rx + 2.5, y: yb + 0.1, w: rw - 2.8, h: 0.35, fontFace: F.body, fontSize: 11.5, bold: true, color: C.mint, align: "right", isTextBox: true, margin: 0, valign: "middle" });
    }
    s.addText("TOTAL", { x: rx + 0.3, y: 4.05, w: 2, h: 0.5, fontFace: F.heading, fontSize: 12, bold: true, color: "FFFFFF", isTextBox: true, margin: 0, valign: "middle" });
    s.addText(eur(sv.total), { x: rx + 2.0, y: 4.0, w: rw - 2.3, h: 0.6, fontFace: F.heading, fontSize: 24, bold: true, color: C.mint, align: "right", isTextBox: true, margin: 0, valign: "middle" });
    // considerations
    const cons = clean(section(t, "services")?.considerations).length ? clean(section(t, "services")?.considerations) : [
      "El precio es una estimación basada en los requisitos actuales, con una precisión aproximada de ±25 %.",
      `La unidad mínima facturable es de ${num(t.terms.minBillableDay ?? 0.5)} días.`,
      "Las jornadas adicionales fuera de alcance se facturarán según la tarifa diaria indicada.",
    ];
    card(s, rx, 4.95, rw, 1.95);
    s.addText("CONSIDERACIONES", { x: rx + 0.3, y: 5.1, w: 3, h: 0.3, fontFace: F.heading, fontSize: 9.5, bold: true, color: C.primary, charSpacing: 2, isTextBox: true, margin: 0 });
    s.addText(cons.slice(0, 3).map((x: string, i: number, a: string[]) => ({ text: x, options: { bullet: true, breakLine: i < a.length - 1, paraSpaceAfter: 2 } })),
      { x: rx + 0.3, y: 5.4, w: rw - 0.6, h: 1.45, fontFace: F.body, fontSize: 9.5, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
  }

  // =========================================================== REFERENCES
  if (on(t, "references") && data.references?.length) {
    const s = lightSlide();
    eyebrow(s, "07 · Referencias");
    title(s, slideTitle(t, "references"), 0.9, 28);
    data.references.slice(0, 3).forEach((r, i) => {
      const x = M + i * 4.1;
      card(s, x, 2.05, 3.8, 4.75, "FFFFFF");
      s.addText(r.company, { x: x + 0.3, y: 2.25, w: 3.2, h: 0.4, fontFace: F.heading, fontSize: 15, bold: true, color: C.primary, isTextBox: true, margin: 0 });
      s.addText(r.stat, { x: x + 0.3, y: 2.7, w: 1.8, h: 0.9, fontFace: F.heading, fontSize: 40, bold: true, color: C.accent, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(r.statLabel, { x: x + 2.1, y: 2.75, w: 1.5, h: 0.8, fontFace: F.body, fontSize: 10.5, color: C.muted, isTextBox: true, margin: 0, valign: "middle" });
      s.addText(`Antes: ${r.before}`, { x: x + 0.3, y: 3.65, w: 3.2, h: 0.5, fontFace: F.body, fontSize: 10.5, italic: true, color: C.muted, isTextBox: true, margin: 0, valign: "top" });
      s.addText(`“${r.quote}”`, { x: x + 0.3, y: 4.3, w: 3.2, h: 1.5, fontFace: F.body, fontSize: 11.5, italic: true, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
      s.addText(r.author, { x: x + 0.3, y: 6.05, w: 3.2, h: 0.4, fontFace: F.heading, fontSize: 10.5, bold: true, color: C.primary, isTextBox: true, margin: 0 });
    });
  }

  // =========================================================== CONDITIONS
  if (on(t, "conditions")) {
    const s = lightSlide();
    eyebrow(s, "08 · Anexos");
    title(s, slideTitle(t, "conditions"), 0.9, 28);
    s.addText(`Creemos que este es el principio de una asociación de futuro y queremos contar con ${data.client.legalName ?? data.client.name} como cliente de referencia.`,
      { x: M, y: 1.95, w: W - 2 * M, h: 0.6, fontFace: F.body, fontSize: 12.5, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
    const conds = data.conditions ?? [
      ...(t.terms.notes ?? []),
      `Plazo de pago: ${t.terms.paymentDays ?? 30} días a fecha de factura.`,
      `Incremento anual del ${t.terms.annualIncreasePct ?? 5} %.`,
      `La presente propuesta tendrá una validez de ${t.terms.validityDays ?? 30} días.`,
    ];
    card(s, M, 2.8, W - 2 * M, 3.7, "FFFFFF");
    s.addText("Las condiciones de facturación son las siguientes:", { x: M + 0.4, y: 3.0, w: 8, h: 0.35, fontFace: F.body, fontSize: 12, color: C.ink, isTextBox: true, margin: 0 });
    s.addText(conds.slice(0, 7).map((x: string, i: number, a: string[]) => ({ text: x, options: { bullet: true, breakLine: i < a.length - 1, paraSpaceAfter: 4 } })),
      { x: M + 0.4, y: 3.45, w: W - 2 * M - 0.8, h: 2.9, fontFace: F.body, fontSize: 11.5, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
  }

  // ============================================================== CLOSING
  if (on(t, "closing")) {
    const s = pres.addSlide();
    if (B.assets?.bgCover) s.background = { data: B.assets.bgCover }; else s.background = { color: C.primary };
    s.addText(slideTitle(t, "closing"), { x: M, y: 2.3, w: 7, h: 1.2, fontFace: F.heading, fontSize: 44, bold: true, color: "FFFFFF", isTextBox: true, margin: 0, valign: "middle" });
    if (B.contact) {
      card(s, M, 3.8, 5.6, 1.9, "FFFFFF");
      s.addText(B.contact.name, { x: M + 0.4, y: 4.0, w: 4.8, h: 0.4, fontFace: F.heading, fontSize: 15, bold: true, color: C.primary, isTextBox: true, margin: 0 });
      s.addText([B.contact.role, B.contact.email, B.contact.phone].filter(Boolean).join("\n"), { x: M + 0.4, y: 4.4, w: 4.8, h: 1.2, fontFace: F.body, fontSize: 12, color: C.ink, isTextBox: true, margin: 0, valign: "top" });
    }
    if (B.assets?.logoLight) s.addImage({ data: B.assets.logoLight, x: W - M - 2.4, y: H - 1.0, w: 2.4, h: 0.65, sizing: { type: "contain", w: 2.4, h: 0.65 } });
    if (B.web) s.addText(B.web, { x: M, y: H - 0.8, w: 5, h: 0.35, fontFace: F.body, fontSize: 11, color: "A7D9C4", isTextBox: true, margin: 0 });
  }

  return pres;
}

// =============================================================== PDF ======
/** Order-form style PDF (legal/summary doc). `jsPDF` is the constructor. */
export function buildOrderFormPdf(jsPDF: any, data: ProposalData, t: ProposalTemplate): any {
  const B = t.brand, C = B.colors;
  const hex = (h: string) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] as [number, number, number];
  // pptxgenjs assets are "image/png;base64,…"; jsPDF needs a full data URL.
  const dataUrl = (s: string) => s.startsWith("data:") ? s : `data:${s}`;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const PW = 210, ML = 18, MR = 18, CW = PW - ML - MR;
  let y = 0;

  const header = () => {
    doc.setFillColor(...hex(C.primary)); doc.rect(0, 0, PW, 30, "F");
    if (B.assets?.logoLight) doc.addImage(dataUrl(B.assets.logoLight), "PNG", ML, 8, 34, 9);
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    doc.text([B.legalName ?? B.company, B.address ?? "", B.vat ? `VAT ${B.vat}` : ""].filter(Boolean).join(" · "), PW - MR, 14, { align: "right" });
    if (B.web) doc.text(B.web, PW - MR, 19, { align: "right" });
    y = 42;
  };
  const footer = (page: number, total: number) => {
    doc.setDrawColor(...hex(C.accent)); doc.setLineWidth(1.2); doc.line(0, 287, PW, 287);
    doc.setFontSize(8); doc.setTextColor(...hex(C.muted)); doc.setFont("helvetica", "normal");
    doc.text(`${B.footer ?? B.company}  ·  ${data.deal.ref ? `Ref. ${data.deal.ref}  ·  ` : ""}${fmtDate(data.deal.date)}`, ML, 292);
    doc.text(`Página ${page} / ${total}`, PW - MR, 292, { align: "right" });
  };
  const h1 = (s: string) => { doc.setFont("helvetica", "bold"); doc.setFontSize(22); doc.setTextColor(...hex(C.primary)); doc.text(s, ML, y); y += 9; };
  const h2 = (s: string) => { y += 4; doc.setFont("helvetica", "bold"); doc.setFontSize(12.5); doc.setTextColor(...hex(C.primary)); doc.text(s, ML, y); y += 7; };
  const p = (s: string, size = 9.5, color = C.ink) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor(...hex(color));
    const lines = doc.splitTextToSize(s, CW); doc.text(lines, ML, y); y += lines.length * (size * 0.45) + 2.5;
  };
  const label = (k: string, v: string, x: number, yy: number) => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...hex(C.ink)); doc.text(k, x, yy);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.text(v || "—", x, yy + 5);
  };
  const ensure = (need: number) => { if (y + need > 275) { doc.addPage(); header(); } };

  // ---- Page 1: parties ----
  header();
  h1("Order form");
  doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...hex(C.muted));
  doc.text(`Contract no. ${data.deal.ref ?? "—"}`, ML, y); y += 8;
  h2(`Subscription & services · ${data.deal.title}`);
  p("This Order Form, together with the General Terms and any amendments hereto, form the agreement between the Parties as of the date of signing (the “Effective Date”). Capitalised terms have the meaning attributed to them in this Order Form and in the Agreement.");
  h2("Parties");
  const boxY = y; const boxH = 34;
  doc.setDrawColor(...hex("E3EEE8")); doc.setLineWidth(0.4); doc.rect(ML, boxY, CW, boxH); doc.line(PW / 2, boxY, PW / 2, boxY + boxH);
  doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(...hex(C.ink));
  doc.text(data.client.legalName ?? data.client.name, ML + 4, boxY + 8);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
  doc.text(doc.splitTextToSize(data.client.address ?? "", CW / 2 - 8), ML + 4, boxY + 13);
  doc.text('(the "Customer")', ML + 4, boxY + 29);
  doc.setFont("helvetica", "bold"); doc.setFontSize(9.5);
  doc.text(B.legalName ?? B.company, PW / 2 + 4, boxY + 8);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
  doc.text(doc.splitTextToSize([B.vat ? `VAT ${B.vat}` : "", B.address ?? ""].filter(Boolean).join("\n"), CW / 2 - 8), PW / 2 + 4, boxY + 13);
  doc.text(`("${B.company}")`, PW / 2 + 4, boxY + 29);
  y = boxY + boxH + 10;
  label("Company VAT/tax no.", data.client.vat ?? "", ML, y);
  label("Customer contact person", [data.client.contactName, data.client.contactRole].filter(Boolean).join(" · "), PW / 2 + 4, y); y += 14;
  label("Customer e-mail for invoicing", data.client.contactEmail ?? "", ML, y); y += 14;

  // ---- Scope of services table ----
  ensure(60);
  h2("Scope of services");
  p("Platform solutions and associated services. All prices are excluding VAT.", 8.5, C.muted);
  const th = (yy: number) => {
    doc.setFillColor(...hex(C.light)); doc.rect(ML, yy - 4.5, CW, 7, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...hex(C.ink));
    doc.text("Description", ML + 3, yy); doc.text("Qty", ML + 118, yy, { align: "right" }); doc.text("Unit", ML + 145, yy, { align: "right" }); doc.text("Amount", ML + CW - 3, yy, { align: "right" });
  };
  th(y); y += 6;
  const row = (desc: string, qty: string, unit: string, amount: string, strong = false, sub?: string) => {
    ensure(10);
    doc.setFont("helvetica", strong ? "bold" : "normal"); doc.setFontSize(9); doc.setTextColor(...hex(C.ink));
    doc.text(desc, ML + 3, y); doc.text(qty, ML + 118, y, { align: "right" }); doc.text(unit, ML + 145, y, { align: "right" }); doc.text(amount, ML + CW - 3, y, { align: "right" });
    if (sub) { y += 4; doc.setFontSize(7.5); doc.setTextColor(...hex(C.muted)); doc.text(sub, ML + 3, y); }
    y += 6; doc.setDrawColor(...hex("EEF3F0")); doc.line(ML, y - 3, PW - MR, y - 3);
  };
  data.products.forEach((pr) => {
    const per = pr.recurring ? (pr.period === "monthly" ? "/month" : "/year") : "";
    row(`Subscription: ${pr.name}${pr.tier ? ` — ${pr.tier}` : ""}`, String(pr.qty), `${eur(pr.unitPrice)}${per}`, eur(pr.total), false,
      pr.recurring ? `${pr.termYears} year${pr.termYears === 1 ? "" : "s"} term${pr.discount ? ` · discount ${eur(pr.discount)} applied` : ""}` : (pr.discount ? `discount ${eur(pr.discount)} applied` : undefined));
    pr.rows.forEach((r) => row(`    ${r.label}${r.detail ? ` (${r.detail})` : ""}`, "", "", eur(r.amount)));
  });
  data.services.forEach((sv) => {
    row(`Services: ${sv.name}`, `${num(sv.days)} ${sv.unit === "hour" ? "h" : "d"}`, `${eur(sv.rate)}/${sv.unit === "hour" ? "h" : "day"}`, eur(sv.total), false,
      sv.discount ? `discount ${eur(sv.discount)} applied` : undefined);
    (sv.roles ?? []).forEach((r) => row(`    ${r.name}`, `${num(r.days)} d`, `${eur(r.rate)}/day`, eur(r.days * r.rate)));
  });
  y += 2;
  doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...hex(C.primary));
  doc.text("Total (excl. VAT):", ML + 118, y, { align: "right" }); doc.text(eur(data.totals.total), ML + CW - 3, y, { align: "right" }); y += 10;

  // ---- Terms ----
  ensure(50);
  h2("Terms");
  const terms = [
    `Payment term: net ${t.terms.paymentDays ?? 30} days.`,
    `Billing cycle: annually in advance for subscriptions; services invoiced per day performed (minimum billable unit ${num(t.terms.minBillableDay ?? 0.5)} day).`,
    `Annual increase: ${t.terms.annualIncreasePct ?? 5} %.`,
    ...(t.terms.notes ?? []),
    `This proposal is valid for ${t.terms.validityDays ?? 30} days from ${fmtDate(data.deal.date)}.`,
  ];
  terms.forEach((tm) => { ensure(8); doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...hex(C.ink)); const l = doc.splitTextToSize(`•  ${tm}`, CW - 4); doc.text(l, ML + 2, y); y += l.length * 4.3 + 1.5; });

  // ---- Signatures ----
  ensure(50);
  h2("Signatures");
  const sy = y + 4;
  [[B.legalName ?? B.company, B.contact?.name ?? "", B.contact?.role ?? "", ML], [data.client.legalName ?? data.client.name, data.client.contactName ?? "", data.client.contactRole ?? "", PW / 2 + 4]].forEach(([co, nm, rl, x]: any) => {
    doc.setFillColor(...hex(C.light)); doc.roundedRect(x, sy, CW / 2 - 6, 34, 2, 2, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...hex(C.muted)); doc.text(String(co).toUpperCase(), x + 4, sy + 7);
    doc.setDrawColor(...hex(C.muted)); doc.setLineWidth(0.3); doc.line(x + 4, sy + 22, x + CW / 2 - 12, sy + 22);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...hex(C.ink)); doc.text([nm, rl].filter(Boolean).join(" — ") || "Signatory", x + 4, sy + 27);
    doc.setFontSize(7.5); doc.setTextColor(...hex(C.muted)); doc.text("Date", x + CW / 2 - 30, sy + 27);
  });

  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) { doc.setPage(i); footer(i, total); }
  return doc;
}