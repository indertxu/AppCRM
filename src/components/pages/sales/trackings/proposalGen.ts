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
export interface ProposalProduct {
  name: string; tier?: string; recurring: boolean; period?: "monthly" | "yearly"; termYears: number; unitPrice: number; qty: number; rows: ProposalLineRow[]; discount: number; total: number;
  /** The contract lengths the plan offers (for "1 year vs 3 years" slides): price per year before / after that term's discount. */
  terms?: { years: number; discountPct: number; annualGross: number; annual: number }[];
}
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
    if (B.assets?.logoLight) {
      const src = dataUrl(B.assets.logoLight);
      try { doc.addImage(src, /^data:image\/jpe?g/i.test(src) ? "JPEG" : "PNG", ML, 8, 34, 9); } catch { /* a logo jsPDF can't read: leave it out */ }
    }
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
// ======================================================= COMPANY DECKS ======
/*
 * Proposals built from the company's own PowerPoint. The deck is a normal
 * .pptx with {{tokens}} where the deal's data goes; each slide is kept or
 * dropped by the deck's rules. Everything here is pure (browser + node):
 * a tiny XML reader/writer over the zip parts, no DOM needed.
 */

// ---------------------------------------------------------- tiny XML -----
export interface XEl { t: 1; name: string; attrs: [string, string][]; kids: XNode[] }
export type XNode = XEl | { t: 3; raw: string } | { t: 9; raw: string };

const XENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export const xdecode = (s: string) => s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XENT[e] ?? m);
export const xescape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xescAttr = (s: string) => xescape(s).replace(/"/g, "&quot;");

/** Parses well-formed XML (OOXML parts) into a light tree; text and attribute values stay raw (escaped). */
export function xparse(src: string): XEl {
  const root: XEl = { t: 1, name: "#doc", attrs: [], kids: [] };
  const stack: XEl[] = [root];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const lt = src.indexOf("<", i);
    if (lt < 0) { if (i < n) top.kids.push({ t: 3, raw: src.slice(i) }); break; }
    if (lt > i) top.kids.push({ t: 3, raw: src.slice(i, lt) });
    const c1 = src[lt + 1];
    if (c1 === "!" || c1 === "?") {
      const end = src.startsWith("<!--", lt) ? src.indexOf("-->", lt) + 3
        : src.startsWith("<![CDATA[", lt) ? src.indexOf("]]>", lt) + 3
        : c1 === "?" ? src.indexOf("?>", lt) + 2 : src.indexOf(">", lt) + 1;
      top.kids.push({ t: 9, raw: src.slice(lt, end) });
      i = end; continue;
    }
    if (c1 === "/") { if (stack.length > 1) stack.pop(); i = src.indexOf(">", lt) + 1; continue; }
    let j = lt + 1;
    while (j < n && !" \t\r\n/>".includes(src[j])) j++;
    const el: XEl = { t: 1, name: src.slice(lt + 1, j), attrs: [], kids: [] };
    let self = false;
    for (;;) {
      while (j < n && " \t\r\n".includes(src[j])) j++;
      if (src[j] === "/") { self = true; j = src.indexOf(">", j) + 1; break; }
      if (src[j] === ">") { j++; break; }
      const eq = src.indexOf("=", j);
      const key = src.slice(j, eq).trim();
      let q = eq + 1; while (" \t\r\n".includes(src[q])) q++;
      const quote = src[q];
      const close = src.indexOf(quote, q + 1);
      let val = src.slice(q + 1, close);
      if (quote === "'") val = val.replace(/"/g, "&quot;");
      el.attrs.push([key, val]);
      j = close + 1;
    }
    top.kids.push(el);
    if (!self) stack.push(el);
    i = j;
  }
  return root;
}
export function xstr(node: XNode): string {
  if (node.t !== 1) return node.raw;
  if (node.name === "#doc") return node.kids.map(xstr).join("");
  const a = node.attrs.map(([k, v]) => ` ${k}="${v}"`).join("");
  return node.kids.length ? `<${node.name}${a}>${node.kids.map(xstr).join("")}</${node.name}>` : `<${node.name}${a}/>`;
}
const xels = (e: XEl | undefined): XEl[] => (e ? (e.kids.filter((k) => k.t === 1) as XEl[]) : []);
const xkid = (e: XEl | undefined, name: string) => xels(e).find((k) => k.name === name);
const xkids = (e: XEl | undefined, name: string) => xels(e).filter((k) => k.name === name);
const xpath = (e: XEl | undefined, ...names: string[]) => names.reduce<XEl | undefined>((cur, nm) => xkid(cur, nm), e);
const xat = (e: XEl | undefined, k: string): string | undefined => { const a = e?.attrs.find((x) => x[0] === k); return a ? xdecode(a[1]) : undefined; };
const xsetAt = (e: XEl, k: string, v: string) => { const a = e.attrs.find((x) => x[0] === k); if (a) a[1] = xescAttr(v); else e.attrs.push([k, xescAttr(v)]); };
const xclone = <T extends XNode>(x: T): T => (x.t === 1 ? ({ t: 1, name: x.name, attrs: x.attrs.map((a) => [a[0], a[1]]), kids: x.kids.map(xclone) } as any) : ({ ...x } as T));
const xroot = (doc: XEl) => xels(doc)[0];
const xtext = (e: XEl | undefined) => (e ? xdecode(e.kids.map((k) => (k.t === 3 ? k.raw : k.t === 9 && k.raw.startsWith("<![CDATA[") ? k.raw.slice(9, -3) : "")).join("")) : "");
const xel = (name: string, attrs: [string, string][] = [], kids: XNode[] = []): XEl => ({ t: 1, name, attrs, kids });
function xfind(e: XEl, pred: (x: XEl) => boolean, out: XEl[] = []): XEl[] {
  for (const k of xels(e)) { if (pred(k)) out.push(k); xfind(k, pred, out); }
  return out;
}

// ---------------------------------------------------------- zip parts -----
async function openZip(buf: ArrayBuffer | Uint8Array | Blob): Promise<any> {
  const JSZip: any = (await import("jszip")).default ?? (await import("jszip"));
  return JSZip.loadAsync(buf);
}
const readPart = async (zip: any, path: string): Promise<XEl | null> => {
  const f = zip.file(path);
  return f ? xparse(await f.async("string")) : null;
};
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
const relsPathOf = (p: string) => `${dirOf(p)}_rels/${p.slice(p.lastIndexOf("/") + 1)}.rels`;
function joinPath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (dirOf(base) + target).split("/");
  const out: string[] = [];
  parts.forEach((s) => { if (s === "..") out.pop(); else if (s !== "." && s !== "") out.push(s); });
  return out.join("/");
}
interface Rel { id: string; type: string; target: string; path: string; external: boolean }
async function readRels(zip: any, part: string): Promise<Rel[]> {
  const doc = await readPart(zip, relsPathOf(part));
  if (!doc) return [];
  return xkids(xroot(doc), "Relationship").map((r) => {
    const target = xat(r, "Target") ?? "";
    const external = xat(r, "TargetMode") === "External";
    return { id: xat(r, "Id") ?? "", type: (xat(r, "Type") ?? "").split("/").pop() ?? "", target, path: external ? target : joinPath(part, target), external };
  });
}
/** The slides in presentation order: [{ n, path, rid, sldId element }]. */
async function slideOrder(zip: any) {
  const pres = await readPart(zip, "ppt/presentation.xml");
  if (!pres) throw new Error("This file is not a PowerPoint presentation (.pptx).");
  const rels = await readRels(zip, "ppt/presentation.xml");
  const list = xkids(xpath(xroot(pres), "p:sldIdLst"), "p:sldId");
  const size = xpath(xroot(pres), "p:sldSz");
  return {
    pres, rels,
    cx: Number(xat(size, "cx") ?? 12192000), cy: Number(xat(size, "cy") ?? 6858000),
    slides: list.map((el, i) => {
      const rid = xat(el, "r:id") ?? "";
      return { n: i + 1, rid, el, path: rels.find((r) => r.id === rid)?.path ?? "" };
    }).filter((s) => s.path),
  };
}

// ---------------------------------------------------------- tokens -----
export const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
export const tokensIn = (s: string) => Array.from(s.matchAll(TOKEN_RE), (m) => m[1].trim());

export interface DeckTokenDef { key: string; label: string; group: "General" | "Product" | "Service" | "Repeat rows"; example: string; multi?: boolean }
/** Every value the deal can fill. N = 1, 2, 3… ; "#" repeats a table row once per item. */
export const DECK_TOKENS: DeckTokenDef[] = [
  { key: "client", label: "Client name", group: "General", example: "Grupo Mundomóvil" },
  { key: "client.legal", label: "Client legal name", group: "General", example: "Mundomóvil S.L." },
  { key: "client.contact", label: "Client contact", group: "General", example: "Ana García" },
  { key: "date", label: "Month and year", group: "General", example: "Junio 2026" },
  { key: "date.long", label: "Full date", group: "General", example: "19 de junio de 2026" },
  { key: "valid_until", label: "Valid until", group: "General", example: "30/06/2026" },
  { key: "deal", label: "Deal name", group: "General", example: "Mundomóvil consolidation" },
  { key: "proposal", label: "Proposal name", group: "General", example: "Licence + services" },
  { key: "seller.name", label: "Seller name", group: "General", example: "Basilio Alvarez" },
  { key: "seller.email", label: "Seller email", group: "General", example: "basilio@…" },
  { key: "seller.phone", label: "Seller phone", group: "General", example: "+34 641 178 601" },
  { key: "total", label: "Proposal total", group: "General", example: "45.000 €" },
  { key: "total.products", label: "Products total", group: "General", example: "20.825 €" },
  { key: "total.services", label: "Services total", group: "General", example: "24.175 €" },
  { key: "agenda", label: "One line per product / service", group: "General", example: "Licencia Suite ⏎ Data Management", multi: true },
  { key: "agenda.upper", label: "Same, in capitals", group: "General", example: "LICENCIA SUITE ⏎ DATA MANAGEMENT", multi: true },
  { key: "num", label: "Section number (counts the slides that use it)", group: "General", example: "06" },
  { key: "product", label: "Product name", group: "Product", example: "Konsolidator" },
  { key: "product.tier", label: "Plan / tier", group: "Product", example: "Enterprise Accounting" },
  { key: "product.annual", label: "Price per year", group: "Product", example: "20.825 €" },
  { key: "product.total", label: "Total of the contract", group: "Product", example: "62.475 €" },
  { key: "product.gross", label: "Before discount", group: "Product", example: "20.825 €" },
  { key: "product.discount", label: "Discount", group: "Product", example: "−4.165 €" },
  { key: "product.discount_pct", label: "Discount %", group: "Product", example: "20%" },
  { key: "product.years", label: "Contract years", group: "Product", example: "3" },
  { key: "product.rowN.label", label: "Price row N: concept", group: "Product", example: "4 sociedades × 275 €" },
  { key: "product.rowN.amount", label: "Price row N: amount", group: "Product", example: "1.100 €" },
  { key: "product.rows.labels", label: "All price rows: concepts", group: "Product", example: "Base fee ⏎ 4 sociedades…", multi: true },
  { key: "product.rows.amounts", label: "All price rows: amounts", group: "Product", example: "10.000 € ⏎ 1.100 €", multi: true },
  { key: "product.yN.annual", label: "N-year contract: price per year", group: "Product", example: "16.660 €" },
  { key: "product.yN.discount", label: "N-year contract: discount per year", group: "Product", example: "−4.165 €" },
  { key: "product.yN.discount_pct", label: "N-year contract: discount %", group: "Product", example: "20%" },
  { key: "service", label: "Service name", group: "Service", example: "Data Management" },
  { key: "service.days", label: "Days", group: "Service", example: "15" },
  { key: "service.rate", label: "Day rate", group: "Service", example: "900 €" },
  { key: "service.gross", label: "Before discount", group: "Service", example: "13.550 €" },
  { key: "service.discount", label: "Discount", group: "Service", example: "−2.710 €" },
  { key: "service.discount_pct", label: "Discount %", group: "Service", example: "20%" },
  { key: "service.total", label: "Total", group: "Service", example: "10.840 €" },
  { key: "service.roleN.name", label: "Role N", group: "Service", example: "Consultor Senior" },
  { key: "service.roleN.days", label: "Role N: days", group: "Service", example: "14" },
  { key: "service.roleN.rate", label: "Role N: day rate", group: "Service", example: "900 €" },
  { key: "service.roleN.amount", label: "Role N: amount", group: "Service", example: "12.600 €" },
  { key: "service.phaseN.name", label: "Phase N", group: "Service", example: "Kick-Off" },
  { key: "service.phaseN.bullets", label: "Phase N: tasks", group: "Service", example: "Kick-off meeting ⏎ …", multi: true },
  { key: "service.phaseN.days", label: "Phase N: days", group: "Service", example: "0,5" },
  { key: "service.roles.summary", label: "Days per role, in words", group: "Service", example: "14 jornadas Consultor Senior + 1 jornada Project Manager" },
  { key: "service.rowN.label", label: "Price row N: concept", group: "Service", example: "Consultor Senior × 14" },
  { key: "service.rowN.amount", label: "Price row N: amount", group: "Service", example: "12.600 €" },
  { key: "?key", label: "Show the shape / table row only when that value isn't empty (prints nothing)", group: "Repeat rows", example: "Descuento{{?service.discount}}" },
  { key: "service.phase#.name", label: "Table row per phase (use # in any cell)", group: "Repeat rows", example: "{{service.phase#.name}} | {{service.phase#.days}}" },
  { key: "service.role#.name", label: "Table row per role", group: "Repeat rows", example: "{{service.role#.name}} | {{service.role#.days}}" },
  { key: "product.row#.label", label: "Table row per price row", group: "Repeat rows", example: "{{product.row#.label}} | {{product.row#.amount}}" },
];
/**
 * "{{?key}}" prints nothing and keeps its shape (or table row) only when `key`
 * has a value — e.g. a discount row: "Descuento{{?service.discount}}".
 */
export const condFails = (text: string, get: (k: string) => string | undefined) =>
  tokensIn(text).some((k) => k.startsWith("?") && !(get(k.slice(1)) ?? "").trim());
/**
 * A shape named with tokens hides when they're empty: "{{a}} {{b}}" hides when
 * all are empty, "{{?a}} {{?b}}" when any is.
 */
export function nameHides(name: string, get: (k: string) => string | undefined): boolean {
  const ks = tokensIn(name);
  if (!ks.length) return false;
  if (condFails(name, get)) return true;
  const plain = ks.filter((k) => !k.startsWith("?"));
  return plain.length > 0 && plain.every((k) => !(get(k) ?? "").trim());
}
/** A token the deal fills (as opposed to a free field the seller types). */
export const isKnownToken = (key: string) => {
  if (key.startsWith("?")) return true;   // a condition, not a value
  const k = key.replace(/\d+|#/g, "N");
  return DECK_TOKENS.some((t) => t.key.replace(/#/g, "N") === k);
};

const MONTHS: Record<string, string[]> = {
  es: ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};
/** 10000 → "10.000 €", −4165 → "−4.165 €", 0.5 decimals with a comma. */
export function deckMoney(n: number, cur = "€"): string {
  const neg = n < 0; const v = Math.abs(n);
  const r = Math.round(v * 100) / 100;
  const [i, d] = r.toFixed(Number.isInteger(r) ? 0 : 2).split(".");
  return `${neg ? "−" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}${d ? "," + d : ""} ${cur}`.trim();
}
const deckNum = (n: number) => (Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString().replace(".", ","));
const pct = (n: number) => `${deckNum(Math.round(n * 10) / 10)}%`;

export interface DeckContext {
  data: ProposalData;
  sellerName?: string; sellerEmail?: string; sellerPhone?: string;
  proposalName?: string;
  validityDays?: number;
  lang?: "es" | "en";
  /** ISO date of the proposal (default today). */
  date?: string;
}
export interface DeckScope { product?: number; service?: number }

/** All the values a slide can use; product / service tokens come from the line the slide is about. */
export function resolveTokens(ctx: DeckContext, scope: DeckScope = {}): Record<string, string> {
  const d = ctx.data, lang = ctx.lang ?? "es";
  const day = new Date(ctx.date ?? d.deal?.date ?? new Date().toISOString().slice(0, 10));
  const valid = new Date(day.getTime() + (ctx.validityDays ?? 30) * 86400000);
  const two = (x: number) => String(x).padStart(2, "0");
  const lines = [...d.products.map((p) => p.name), ...d.services.map((s) => s.name)];
  const v: Record<string, string> = {
    client: d.client.name ?? "", "client.legal": d.client.legalName ?? d.client.name ?? "", "client.contact": d.client.contactName ?? "",
    date: `${MONTHS[lang][day.getMonth()]} ${day.getFullYear()}`,
    "date.long": lang === "es" ? `${day.getDate()} de ${MONTHS.es[day.getMonth()].toLowerCase()} de ${day.getFullYear()}` : `${day.getDate()} ${MONTHS.en[day.getMonth()]} ${day.getFullYear()}`,
    valid_until: `${two(valid.getDate())}/${two(valid.getMonth() + 1)}/${valid.getFullYear()}`,
    deal: d.deal?.title ?? "", proposal: ctx.proposalName ?? "",
    "seller.name": ctx.sellerName ?? "", "seller.email": ctx.sellerEmail ?? "", "seller.phone": ctx.sellerPhone ?? "",
    total: deckMoney(d.totals.total), "total.products": deckMoney(d.totals.products), "total.services": deckMoney(d.totals.services),
    agenda: lines.join("\n"), "agenda.upper": lines.join("\n").toUpperCase(),
  };
  const p = d.products[scope.product ?? 0];
  if (p) {
    const perYear = p.recurring ? (p.period === "monthly" ? 12 : 1) : 1;
    const years = p.recurring ? p.termYears || 1 : 1;
    const gross = p.total + p.discount;
    const label = (r: ProposalLineRow) => [r.label, r.detail].filter(Boolean).join(" · ");
    Object.assign(v, {
      product: p.name, "product.tier": p.tier ?? "", "product.total": deckMoney(p.total),
      "product.annual": deckMoney(p.total / years), "product.gross": deckMoney(gross / years),
      "product.discount": p.discount ? deckMoney(-p.discount / years) : "", "product.discount_pct": p.discount && gross ? pct((p.discount / gross) * 100) : "",
      "product.years": String(years),
      "product.rows.labels": p.rows.map(label).join("\n"), "product.rows.amounts": p.rows.map((r) => deckMoney(r.amount * perYear)).join("\n"),
    });
    p.rows.forEach((r, i) => { v[`product.row${i + 1}.label`] = label(r); v[`product.row${i + 1}.amount`] = deckMoney(r.amount * perYear); });
    // contract lengths: the plan's own, else 1 year at list price and the line's own term
    const annualGross = gross / years;
    const terms = p.terms?.length ? p.terms : [
      { years: 1, discountPct: 0, annualGross, annual: annualGross },
      ...(years > 1 ? [{ years, discountPct: annualGross ? (1 - p.total / years / annualGross) * 100 : 0, annualGross, annual: p.total / years }] : []),
    ];
    terms.forEach((t) => {
      v[`product.y${t.years}.annual`] = deckMoney(t.annual);
      v[`product.y${t.years}.discount`] = t.discountPct ? deckMoney(-(t.annualGross - t.annual)) : "";
      v[`product.y${t.years}.discount_pct`] = t.discountPct ? pct(t.discountPct) : "";
    });
  }
  const s = d.services[scope.service ?? 0];
  if (s) {
    const gross = s.total + s.discount;
    const roles = s.roles?.length ? s.roles : s.rows.filter((r) => r.days).map((r) => ({ name: r.label, days: r.days ?? 0, rate: r.days ? r.amount / (r.days || 1) : r.amount }));
    Object.assign(v, {
      service: s.name, "service.days": deckNum(s.days), "service.rate": deckMoney(s.rate),
      "service.gross": deckMoney(gross), "service.discount": s.discount ? deckMoney(-s.discount) : "",
      "service.discount_pct": s.discount && gross ? pct((s.discount / gross) * 100) : "", "service.total": deckMoney(s.total),
    });
    roles.forEach((r, i) => {
      v[`service.role${i + 1}.name`] = r.name; v[`service.role${i + 1}.days`] = deckNum(r.days);
      v[`service.role${i + 1}.rate`] = deckMoney(r.rate); v[`service.role${i + 1}.amount`] = deckMoney(r.rate * r.days);
    });
    s.phases.forEach((f, i) => {
      v[`service.phase${i + 1}.name`] = f.name; v[`service.phase${i + 1}.bullets`] = (f.bullets ?? []).join("\n"); v[`service.phase${i + 1}.days`] = deckNum(f.days);
    });
    const dayWord = (n: number) => (lang === "es" ? (n === 1 ? "jornada" : "jornadas") : n === 1 ? "day" : "days");
    v["service.roles.summary"] = roles.length
      ? roles.map((r) => `${deckNum(r.days)} ${dayWord(r.days)} ${r.name}`).join(" + ")
      : `${deckNum(s.days)} ${dayWord(s.days)}`;
    s.rows.forEach((r, i) => { v[`service.row${i + 1}.label`] = [r.label, r.detail].filter(Boolean).join(" · "); v[`service.row${i + 1}.amount`] = deckMoney(r.amount); });
  }
  return v;
}

// ----------------------------------------- resolving a paragraph's runs -----
export interface RunPiece { run: number; text: string }
export interface ResolvedPara { lines: RunPiece[][]; tokens: string[]; allEmpty: boolean; staticBlank: boolean; changed: boolean }
/**
 * Puts the values into one paragraph, keeping each run's formatting: a value
 * takes the formatting of the run where its token starts. A value with several
 * lines makes several paragraphs (text around the token repeats on each).
 * `get` returns undefined for a token it doesn't know: it is left as typed when
 * `keepUnknown`, else removed.
 */
export function resolvePara(runs: string[], get: (key: string) => string | undefined, keepUnknown = false): ResolvedPara {
  const full = runs.join("");
  const matches = Array.from(full.matchAll(TOKEN_RE));
  if (!matches.length) return { lines: [runs.map((text, run) => ({ run, text }))], tokens: [], allEmpty: false, staticBlank: !full.trim(), changed: false };
  const owner: number[] = [];
  runs.forEach((t, r) => { for (let k = 0; k < t.length; k++) owner.push(r); });
  const pieces: (RunPiece & { multi?: boolean })[] = [];
  const push = (run: number, text: string, multi = false) => {
    const last = pieces[pieces.length - 1];
    if (last && last.run === run && !last.multi && !multi) last.text += text; else pieces.push({ run, text, multi });
  };
  let pos = 0, allEmpty = true;
  const keys: string[] = [];
  for (const m of matches) {
    for (let k = pos; k < m.index!; k++) push(owner[k], full[k]);
    const key = m[1].trim(); keys.push(key);
    const val = get(key);
    const out = val === undefined ? (keepUnknown ? m[0] : "") : val;
    if (out.trim()) allEmpty = false;
    if (out) push(owner[m.index!], out, out.includes("\n"));
    pos = m.index! + m[0].length;
  }
  for (let k = pos; k < full.length; k++) push(owner[k], full[k]);
  const staticBlank = !full.replace(TOKEN_RE, "").trim();
  const multis = pieces.filter((p) => p.multi);
  let lines: RunPiece[][];
  if (multis.length === 1 && !pieces.some((p) => !p.multi && p.text.includes("\n"))) {
    const at = pieces.indexOf(multis[0]);
    const before = pieces.slice(0, at), after = pieces.slice(at + 1);
    lines = multis[0].text.split("\n").map((l) => [...before.map((x) => ({ run: x.run, text: x.text })), { run: multis[0].run, text: l }, ...after.map((x) => ({ run: x.run, text: x.text }))]);
  } else {
    lines = [[]];
    pieces.forEach((pc) => pc.text.split("\n").forEach((part, i) => { if (i) lines.push([]); if (part) lines[lines.length - 1].push({ run: pc.run, text: part }); }));
  }
  return { lines: lines.map((l) => l.filter((x) => x.text)), tokens: keys, allEmpty, staticBlank, changed: true };
}
/** Number of times a table row with "#" tokens repeats: the highest index the values have. */
export function repeatCount(rowText: string, get: (key: string) => string | undefined): number {
  const hashKeys = tokensIn(rowText).filter((k) => k.includes("#"));
  if (!hashKeys.length) return -1;
  let n = 0;
  for (let k = 1; k <= 99; k++) if (hashKeys.some((key) => get(key.replace(/#/g, String(k))) !== undefined)) n = k;
  return n;
}

// ------------------------------------------------------- reading a deck -----
export interface DeckText { key: string; text: string; shapeName: string; table?: boolean }
export interface DeckSlide { n: number; path: string; title: string; texts: DeckText[]; tokens: string[]; layout?: string; hidden?: boolean }
export interface DeckInfo { width: number; height: number; slides: DeckSlide[]; tokens: string[] }

const NV = ["p:nvSpPr", "p:nvPicPr", "p:nvGraphicFramePr", "p:nvGrpSpPr", "p:nvCxnSpPr"];
const cNvPr = (shape: XEl) => xkid(xels(shape).find((k) => NV.includes(k.name)), "p:cNvPr");
const SHAPES = ["p:sp", "p:pic", "p:graphicFrame", "p:grpSp", "p:cxnSp"];
/** Every shape of a shape tree in drawing order, groups included (group first, then its children). */
function shapesOf(tree: XEl, out: { el: XEl; parent: XEl }[] = []) {
  for (const k of xels(tree)) {
    if (k.name === "mc:AlternateContent") { const ch = xkid(k, "mc:Choice") ?? xkid(k, "mc:Fallback"); if (ch) shapesOf(ch, out); continue; }
    if (!SHAPES.includes(k.name)) continue;
    out.push({ el: k, parent: tree });
    if (k.name === "p:grpSp") shapesOf(k, out);
  }
  return out;
}
/** Stable ids per slide: the shape id, made unique when a deck repeats one. */
function shapeIds(shapes: { el: XEl }[]) {
  const seen = new Map<string, number>();
  return shapes.map(({ el }) => {
    const id = xat(cNvPr(el), "id") ?? "0";
    const c = (seen.get(id) ?? 0) + 1; seen.set(id, c);
    return c === 1 ? id : `${id}_${c}`;
  });
}
const paraRuns = (p: XEl) => xels(p).filter((k) => k.name === "a:r" || k.name === "a:fld" || k.name === "a:br");
const runText = (r: XEl) => (r.name === "a:br" ? "\n" : xtext(xkid(r, "a:t")));
export const paraTextOf = (p: XEl) => paraRuns(p).map(runText).join("");
/** The tables of a graphic frame (if it holds one). */
const tableOf = (gf: XEl) => xpath(gf, "a:graphic", "a:graphicData", "a:tbl");

/** Reads a deck: its slides in order, their texts (with keys the editor uses) and the {{tokens}} it has. */
export async function parseDeck(buf: ArrayBuffer | Uint8Array | Blob): Promise<DeckInfo> {
  const zip = await openZip(buf);
  const order = await slideOrder(zip);
  const all = new Set<string>();
  const slides: DeckSlide[] = [];
  for (const s of order.slides) {
    const doc = await readPart(zip, s.path);
    if (!doc) continue;
    const root = xroot(doc);
    const tree = xpath(root, "p:cSld", "p:spTree");
    const texts: DeckText[] = [];
    const tokens = new Set<string>();
    let title = "", phTitle = "";
    if (tree) {
      const shapes = shapesOf(tree);
      const ids = shapeIds(shapes);
      shapes.forEach(({ el }, i) => {
        const name = xat(cNvPr(el), "name") ?? "";
        tokensIn(name).forEach((t) => tokens.add(t));
        const isTitle = /title/i.test(xat(xpath(xels(el).find((k) => NV.includes(k.name)), "p:nvPr", "p:ph"), "type") ?? "");
        if (el.name === "p:sp") {
          xkids(xkid(el, "p:txBody"), "a:p").forEach((p, pi) => {
            const text = paraTextOf(p);
            if (!text.trim()) return;
            texts.push({ key: `${s.n}:${ids[i]}:${pi}`, text, shapeName: name });
            tokensIn(text).forEach((t) => tokens.add(t));
            if (isTitle && !phTitle) phTitle = text;
            if (!title && /[a-záéíóúñ]{3}/i.test(text) && !text.includes("{{")) title = text;
          });
        } else if (el.name === "p:graphicFrame") {
          const tbl = tableOf(el);
          xkids(tbl, "a:tr").forEach((tr, r) => xkids(tr, "a:tc").forEach((tc, c) => xkids(xkid(tc, "a:txBody"), "a:p").forEach((p, pi) => {
            const text = paraTextOf(p);
            if (!text.trim()) return;
            texts.push({ key: `${s.n}:${ids[i]}:r${r}c${c}:${pi}`, text, shapeName: name, table: true });
            tokensIn(text).forEach((t) => tokens.add(t));
          })));
        }
      });
    }
    const layout = (await readRels(zip, s.path)).find((r) => r.type === "slideLayout")?.path;
    tokens.forEach((t) => all.add(t));
    slides.push({ n: s.n, path: s.path, title: (phTitle || title || `Slide ${s.n}`).replace(/\s+/g, " ").trim().slice(0, 90), texts, tokens: Array.from(tokens), layout, hidden: xat(root, "show") === "0" });
  }
  return { width: order.cx, height: order.cy, slides, tokens: Array.from(all) };
}

/** Section numbers: "01", "02"… for the kept slides that use {{num}}, in order. */
export function deckNumbering(info: DeckInfo, include: number[]): string[] {
  let c = 0;
  return include.map((n) => { const s = info.slides.find((x) => x.n === n); return s?.tokens.includes("num") ? String(++c).padStart(2, "0") : ""; });
}
/**
 * How a slide is named in edit keys: its number, and for a repeated slide
 * (the same services slide once per service) "<n>.<i>" from the 2nd copy on.
 */
export const slideRef = (n: number, i = 0) => (i ? `${n}.${i}` : String(n));

// ------------------------------------------------------- filling a deck -----
/** Rewrites a paragraph into one or more paragraphs with the given lines (each a list of pieces of the old runs). */
function rebuildPara(p: XEl, runs: XEl[], lines: RunPiece[][]): XEl[] {
  const pPr = xkid(p, "a:pPr"), end = xkid(p, "a:endParaRPr");
  const textRuns = runs.filter((r) => r.name !== "a:br");
  const fallbackRPr = xkid(textRuns[0], "a:rPr") ?? (end ? xel("a:rPr", end.attrs.map((a) => [a[0], a[1]]), end.kids.map(xclone)) : undefined);
  return lines.map((line) => {
    const kids: XNode[] = [];
    if (pPr) kids.push(xclone(pPr));
    line.forEach((pc) => {
      const src = runs[pc.run];
      const rPr = src && src.name !== "a:br" ? xkid(src, "a:rPr") : fallbackRPr;
      kids.push(xel("a:r", [], [...(rPr ? [xclone(rPr)] : []), xel("a:t", [], [{ t: 3, raw: xescape(pc.text) }])]));
    });
    if (end) kids.push(xclone(end));
    else if (!line.length && fallbackRPr) kids.push(xel("a:endParaRPr", fallbackRPr.attrs.map((a) => [a[0], a[1]])));
    return xel("a:p", p.attrs.map((a) => [a[0], a[1]]), kids);
  });
}
const replaceKid = (parent: XEl, old: XEl, news: XEl[]) => { const i = parent.kids.indexOf(old); if (i >= 0) parent.kids.splice(i, 1, ...news); };
const removeKid = (parent: XEl, old: XEl) => { const i = parent.kids.indexOf(old); if (i >= 0) parent.kids.splice(i, 1); };

/**
 * Fills one text body's paragraphs. `keyOf(pi)` names each paragraph for edits.
 * Returns whether the body only held tokens that all came out empty (→ drop the shape).
 */
function fillBody(body: XEl, keyOf: (pi: number) => string, get: (k: string) => string | undefined, edits: Record<string, string>): boolean {
  let hadTokens = false, allEmpty = true, staticBlank = true, edited = false;
  xkids(body, "a:p").forEach((p, pi) => {
    const runs = paraRuns(p);
    const key = keyOf(pi);
    if (edits[key] !== undefined) {
      edited = true;
      const first = runs.findIndex((r) => r.name !== "a:br");
      replaceKid(body, p, rebuildPara(p, runs, edits[key].split("\n").map((l) => (l ? [{ run: Math.max(0, first), text: l }] : []))));
      return;
    }
    const res = resolvePara(runs.map(runText), get);
    if (!res.changed) { if (!res.staticBlank) staticBlank = false; return; }
    hadTokens = true;
    if (!res.allEmpty) allEmpty = false;
    if (!res.staticBlank) staticBlank = false;
    replaceKid(body, p, rebuildPara(p, runs, res.lines));
  });
  if (!xkids(body, "a:p").length) body.kids.push(xel("a:p"));
  return hadTokens && allEmpty && staticBlank && !edited;
}

export interface FillOptions {
  /** The slides to keep (their n), in the order they go. A number can repeat: that slide is copied (e.g. once per service). */
  include: number[];
  /** The values for each slide (product / service tokens differ per slide), or one set for all. i = which copy of slide n (0 = first). */
  values: Record<string, string> | ((n: number, i: number) => Record<string, string>);
  /** Paragraph texts typed by the seller, by key ("<n>:<shape>:<paragraph>"). */
  edits?: Record<string, string>;
}
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Fills one slide's XML in place. */
function fillSlideXml(root: XEl, n: string, get0: (k: string) => string | undefined, edits: Record<string, string>) {
  const get = (k: string) => (k.startsWith("?") ? "" : get0(k));
  const tree = xpath(root, "p:cSld", "p:spTree");
  if (!tree) return;
  const shapes = shapesOf(tree);
  const ids = shapeIds(shapes);
  const drop: { el: XEl; parent: XEl }[] = [];
  shapes.forEach(({ el, parent }, i) => {
    const name = xat(cNvPr(el), "name") ?? "";
    // A shape named after a token ("{{product.row4.label}}") only shows when that value isn't empty.
    if (nameHides(name, get0)) { drop.push({ el, parent }); return; }
    if (el.name === "p:sp") {
      const body = xkid(el, "p:txBody");
      if (body && condFails(xkids(body, "a:p").map(paraTextOf).join("\n"), get0)) { drop.push({ el, parent }); return; }
      if (body && fillBody(body, (pi) => `${n}:${ids[i]}:${pi}`, get, edits)) drop.push({ el, parent });
    } else if (el.name === "p:graphicFrame") {
      const tbl = tableOf(el);
      if (!tbl) return;
      let added = 0;
      xkids(tbl, "a:tr").forEach((tr, r) => {
        const rowText = xkids(tr, "a:tc").map((tc) => xkids(xkid(tc, "a:txBody"), "a:p").map(paraTextOf).join("\n")).join("\n");
        const count = repeatCount(rowText, get);
        const h = Number(xat(tr, "h") ?? 0);
        if (count < 0 && condFails(rowText, get0)) { added -= h; removeKid(tbl, tr); return; }
        const fillRow = (row: XEl, tag: string, g: (k: string) => string | undefined) =>
          xkids(row, "a:tc").forEach((tc, c) => { const b = xkid(tc, "a:txBody"); if (b) fillBody(b, (pi) => `${n}:${ids[i]}:r${tag}c${c}:${pi}`, g, edits); });
        if (count < 0) { fillRow(tr, String(r), get); return; }
        const copies: XEl[] = [];
        for (let k = 1; k <= count; k++) {
          const gk = (key: string) => get0(key.replace(/#/g, String(k)));
          if (condFails(rowText, gk)) continue;
          const row = xclone(tr);
          fillRow(row, `${r}.${k}`, (key) => (key.startsWith("?") ? "" : gk(key)));
          copies.push(row);
        }
        added += (copies.length - 1) * h;
        replaceKid(tbl, tr, copies);
      });
      if (added) {
        const ext = xpath(el, "p:xfrm", "a:ext");
        if (ext) xsetAt(ext, "cy", String(Math.max(0, Number(xat(ext, "cy") ?? 0) + added)));
      }
    }
  });
  drop.forEach(({ el, parent }) => removeKid(parent, el));
}

/** Builds the proposal: the kept slides, in order, with the values and the seller's edits. */
export async function fillDeck(buf: ArrayBuffer | Uint8Array | Blob, opts: FillOptions): Promise<Blob> {
  const zip = await openZip(buf);
  const order = await slideOrder(zip);
  const byN = new Map(order.slides.map((s) => [s.n, s]));
  const keepPaths = new Set(opts.include.map((n) => byN.get(n)?.path).filter(Boolean) as string[]);
  const dropped = order.slides.filter((s) => !keepPaths.has(s.path));
  const edits = opts.edits ?? {};
  const info = await parseDeck(buf);
  const nums = deckNumbering(info, opts.include);

  // 1. Fill the kept slides (copies of a repeated slide get new parts).
  const final: { el: XEl; path: string }[] = [];
  const original = new Map<string, string>();
  const occ = new Map<number, number>();
  const added: { path: string; rid: string }[] = [];
  let nextFile = Math.max(0, ...Object.keys(zip.files).map((f) => Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(f)?.[1] ?? 0))) + 1;
  let nextId = Math.max(255, ...order.slides.map((s) => Number(xat(s.el, "id") ?? 0))) + 1;
  for (let pos = 0; pos < opts.include.length; pos++) {
    const n = opts.include[pos];
    const s = byN.get(n);
    if (!s) continue;
    const i = (occ.get(n) ?? -1) + 1; occ.set(n, i);
    if (!original.has(s.path)) original.set(s.path, await zip.file(s.path).async("string"));
    const doc = xparse(original.get(s.path)!);
    const vals = { ...(typeof opts.values === "function" ? opts.values(n, i) : opts.values) };
    if (nums[pos] && vals.num === undefined) vals.num = nums[pos];
    fillSlideXml(xroot(doc), slideRef(n, i), (k) => vals[k], edits);
    if (i === 0) { zip.file(s.path, xstr(doc)); final.push({ el: s.el, path: s.path }); continue; }
    const path = `ppt/slides/slide${nextFile++}.xml`;
    zip.file(path, xstr(doc));
    const relDoc = await readPart(zip, relsPathOf(s.path));
    if (relDoc) {
      // the copy keeps the layout and pictures; notes and comments stay with the original
      xroot(relDoc).kids = xroot(relDoc).kids.filter((k) => !(k.t === 1 && /notesSlide|comments/.test(xat(k, "Type") ?? "")));
      zip.file(relsPathOf(path), xstr(relDoc));
    }
    const rid = `rIdCopy${added.length + 1}`;
    added.push({ path, rid });
    final.push({ el: xel("p:sldId", [["id", String(nextId++)], ["r:id", rid]]), path });
  }

  // 2. Drop the other slides: the list, their parts, their notes and comments, links to them.
  const removed = new Set<string>();
  for (const s of dropped) {
    const rels = await readRels(zip, s.path);
    rels.filter((r) => !r.external && /notesSlide|comments/.test(r.type)).forEach((r) => {
      removed.add(r.path); zip.remove(r.path); zip.remove(relsPathOf(r.path));
    });
    removed.add(s.path); zip.remove(s.path); zip.remove(relsPathOf(s.path));
  }
  const presRoot = xroot(order.pres);
  const lst = xpath(presRoot, "p:sldIdLst");
  if (lst) lst.kids = final.map((s) => s.el);
  // sections (p14:sectionLst) list slide ids too
  const keptIds = new Set(final.map((s) => xat(s.el, "id")));
  xfind(presRoot, (e) => e.name === "p14:sldId").forEach((e) => { if (!keptIds.has(xat(e, "id"))) e.name = "#gone"; });
  const prune = (e: XEl) => { e.kids = e.kids.filter((k) => !(k.t === 1 && k.name === "#gone")); xels(e).forEach(prune); };
  prune(presRoot);
  // custom shows that use a dropped slide go
  xfind(presRoot, (e) => e.name === "p:custShowLst").forEach((e) => { e.kids = []; });
  zip.file("ppt/presentation.xml", xstr(order.pres));
  const presRels = await readPart(zip, relsPathOf("ppt/presentation.xml"));
  if (presRels) {
    // revision history lists the slides by id: it goes with them
    order.rels.filter((r) => r.type === "changesInfo").forEach((r) => { removed.add(r.path); zip.remove(r.path); });
    const dropIds = new Set([...dropped.map((s) => s.rid), ...order.rels.filter((r) => r.type === "changesInfo").map((r) => r.id)]);
    xroot(presRels).kids = xroot(presRels).kids.filter((k) => !(k.t === 1 && dropIds.has(xat(k, "Id") ?? "")));
    added.forEach((a) => xroot(presRels).kids.push(xel("Relationship", [["Id", a.rid], ["Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"], ["Target", a.path.replace("ppt/", "")]])));
    zip.file(relsPathOf("ppt/presentation.xml"), xstr(presRels));
  }
  // links from kept slides to dropped ones
  for (const s of final) {
    const rp = relsPathOf(s.path);
    const relDoc = await readPart(zip, rp);
    if (!relDoc) continue;
    const gone: string[] = [];
    xroot(relDoc).kids = xroot(relDoc).kids.filter((k) => {
      if (k.t !== 1) return true;
      const t = xat(k, "Target") ?? "";
      if (xat(k, "TargetMode") !== "External" && removed.has(joinPath(s.path, t))) { gone.push(xat(k, "Id") ?? ""); return false; }
      return true;
    });
    if (!gone.length) continue;
    zip.file(rp, xstr(relDoc));
    const doc = await readPart(zip, s.path);
    if (doc) {
      xfind(xroot(doc), (e) => (e.name === "a:hlinkClick" || e.name === "a:hlinkMouseOver") && gone.includes(xat(e, "r:id") ?? "")).forEach((e) => { e.name = "#gone"; });
      prune(xroot(doc));
      zip.file(s.path, xstr(doc));
    }
  }
  // 3. Content types, and media nothing uses any more.
  const ct = await readPart(zip, "[Content_Types].xml");
  if (ct) {
    xroot(ct).kids = xroot(ct).kids.filter((k) => !(k.t === 1 && k.name === "Override" && removed.has((xat(k, "PartName") ?? "").replace(/^\//, ""))));
    added.forEach((a) => xroot(ct).kids.push(xel("Override", [["PartName", `/${a.path}`], ["ContentType", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"]])));
    zip.file("[Content_Types].xml", xstr(ct));
  }
  const used = new Set<string>();
  const relFiles = Object.keys(zip.files).filter((p) => p.endsWith(".rels"));
  for (const rf of relFiles) {
    const owner = rf.replace(/_rels\/([^/]+)\.rels$/, "$1");
    (await readRels(zip, owner)).forEach((r) => { if (!r.external) used.add(r.path); });
  }
  Object.keys(zip.files).filter((p) => p.startsWith("ppt/media/") && !used.has(p)).forEach((p) => zip.remove(p));
  // docProps/app.xml: slide count
  const app = await readPart(zip, "docProps/app.xml");
  const slidesEl = app && xfind(xroot(app), (e) => e.name === "Slides")[0];
  if (app && slidesEl) { slidesEl.kids = [{ t: 3, raw: String(final.length) }]; zip.file("docProps/app.xml", xstr(app)); }

  const bytes: Uint8Array = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: PPTX_MIME });
  return new Blob([bytes as any], { type: PPTX_MIME });
}

// ------------------------------------------------------- slide preview -----
export interface PvRun { text: string; size: number; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; font?: string; caps?: boolean; baseline?: number; spc?: number }
export interface PvPara { key?: string; align?: string; runs: PvRun[]; endSize: number; bullet?: string; marL?: number; indent?: number; lnSpc?: number; spcBef?: number; spcAft?: number; color?: string }
export interface PvText { anchor: string; l: number; t: number; r: number; b: number; wrap: boolean; paras: PvPara[]; scale?: number; vert?: boolean }
export interface PvCell { tag: string; text: PvText; fill?: string; span?: number; rowSpan?: number; merged?: boolean; borders: { l?: string; r?: string; t?: string; b?: string } }
export interface PvTable { cols: number[]; rows: { h: number; tag: string; cells: PvCell[]; repeat?: string; text: string }[] }
export interface PvShape {
  sid: string; name: string; layer: "master" | "layout" | "slide";
  x: number; y: number; w: number; h: number; rot?: number; flipH?: boolean; flipV?: boolean;
  geom: string; radius?: number; path?: { d: string; w: number; h: number }[];
  fill?: string; img?: string; crop?: { l: number; t: number; r: number; b: number }; imgFill?: boolean;
  line?: { color: string; w: number; dash?: boolean; head?: boolean; tail?: boolean }; connector?: boolean;
  text?: PvText; table?: PvTable; hideIf?: string[];
  /** Slide shapes: the top-level shape it belongs to (itself, or the group it sits in) — what the editor moves. */
  top?: string;
}
export interface PvSlide { n: number; bg?: string; bgImg?: string; shapes: PvShape[]; /** the theme's body font */ font?: string }
export interface PvDeck { cx: number; cy: number; slides: PvSlide[]; info: DeckInfo }

// --- colours ---
type Theme = { colors: Record<string, string>; major: string; minor: string };
function hexToHsl(h: string) {
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let hh = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh /= 6;
  }
  return [hh, s, l];
}
function hslToHex(h: number, s: number, l: number) {
  const f = (p: number, q: number, t: number) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  let r = l, g = l, b = l;
  if (s) { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return [r, g, b].map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}
/** A colour element (srgbClr, schemeClr…) with its modifiers → "#RRGGBB" or "rgba(…)". */
function colorOf(c: XEl | undefined, th: Theme, map: Record<string, string>, phClr?: string): string | undefined {
  if (!c) return undefined;
  let hex: string | undefined;
  if (c.name === "a:srgbClr") hex = xat(c, "val");
  else if (c.name === "a:sysClr") hex = xat(c, "lastClr") ?? "000000";
  else if (c.name === "a:scrgbClr") hex = [xat(c, "r"), xat(c, "g"), xat(c, "b")].map((v) => Math.round((Number(v ?? 0) / 100000) * 255).toString(16).padStart(2, "0")).join("");
  else if (c.name === "a:prstClr") hex = ({ black: "000000", white: "FFFFFF", red: "FF0000", blue: "0000FF", green: "00FF00", yellow: "FFFF00", gray: "808080" } as any)[xat(c, "val") ?? ""] ?? "000000";
  else if (c.name === "a:schemeClr") {
    const v = xat(c, "val") ?? "";
    if (v === "phClr") hex = phClr?.replace("#", "");
    else hex = th.colors[map[v] ?? v] ?? th.colors[v];
  }
  if (!hex) return undefined;
  hex = hex.toUpperCase();
  let alpha = 1;
  let [h, s, l] = hexToHsl(hex);
  let rgbHex = hex;
  for (const m of xels(c)) {
    const val = Number(xat(m, "val") ?? 0) / 100000;
    if (m.name === "a:lumMod") { l *= val; rgbHex = hslToHex(h, s, l); }
    else if (m.name === "a:lumOff") { l += val; rgbHex = hslToHex(h, s, l); }
    else if (m.name === "a:satMod") { s *= val; rgbHex = hslToHex(h, s, l); }
    else if (m.name === "a:tint") { const t = val; rgbHex = [0, 2, 4].map((k) => { const x = parseInt(rgbHex.slice(k, k + 2), 16); return Math.round(x + (255 - x) * (1 - t)).toString(16).padStart(2, "0"); }).join(""); [h, s, l] = hexToHsl(rgbHex); }
    else if (m.name === "a:shade") { const t = val; rgbHex = [0, 2, 4].map((k) => Math.round(parseInt(rgbHex.slice(k, k + 2), 16) * t).toString(16).padStart(2, "0")).join(""); [h, s, l] = hexToHsl(rgbHex); }
    else if (m.name === "a:alpha") alpha = val;
  }
  if (alpha < 1) return `rgba(${parseInt(rgbHex.slice(0, 2), 16)},${parseInt(rgbHex.slice(2, 4), 16)},${parseInt(rgbHex.slice(4, 6), 16)},${alpha.toFixed(3)})`;
  return `#${rgbHex}`;
}
const CLR = ["a:srgbClr", "a:schemeClr", "a:sysClr", "a:scrgbClr", "a:prstClr"];
const clrKid = (e: XEl | undefined) => xels(e).find((k) => CLR.includes(k.name));

interface Ctx { zip: any; th: Theme; map: Record<string, string>; rels: Rel[]; img: (path: string) => Promise<string | undefined> }

/** A fill element list (spPr / bgPr / tcPr) → css background (and image). */
async function fillOf(e: XEl | undefined, cx: Ctx, styleClr?: string): Promise<{ fill?: string; img?: string; none?: boolean } | undefined> {
  if (!e) return undefined;
  if (xkid(e, "a:noFill")) return { none: true };
  const solid = xkid(e, "a:solidFill");
  if (solid) return { fill: colorOf(clrKid(solid), cx.th, cx.map, styleClr) };
  const grad = xkid(e, "a:gradFill");
  if (grad) {
    const stops = xkids(xkid(grad, "a:gsLst"), "a:gs").map((g) => ({ c: colorOf(clrKid(g), cx.th, cx.map, styleClr) ?? "#000", p: Number(xat(g, "pos") ?? 0) / 1000 }))
      .sort((a, b) => a.p - b.p).map((g) => `${g.c} ${g.p}%`);
    const ang = Number(xat(xkid(grad, "a:lin"), "ang") ?? 0) / 60000;
    return stops.length ? { fill: `linear-gradient(${ang + 90}deg, ${stops.join(", ")})` } : undefined;
  }
  const blip = xkid(e, "a:blipFill");
  if (blip) {
    const rid = xat(xkid(blip, "a:blip"), "r:embed");
    const rel = cx.rels.find((r) => r.id === rid);
    return { img: rel ? await cx.img(rel.path) : undefined };
  }
  return undefined;
}

/** Text-style levels: lvl1pPr…  from a list style element. */
const lvlOf = (lst: XEl | undefined, lvl: number) => xkid(lst, `a:lvl${lvl}pPr`) ?? (lvl === 1 ? xkid(lst, "a:defPPr") : undefined);

async function textOf(body: XEl, cx: Ctx, inherit: XEl[] /* list styles, most specific first */, keyOf: (pi: number) => string | undefined, styleText?: string): Promise<PvText> {
  const bp = xkid(body, "a:bodyPr");
  const fa = xkid(bp, "a:normAutofit");
  const ins = (k: string, d: number) => Number(xat(bp, k) ?? d);
  const lists = [xkid(body, "a:lstStyle"), ...inherit];
  const paras: PvPara[] = xkids(body, "a:p").map((p, pi) => {
    const pPr = xkid(p, "a:pPr");
    const lvl = Number(xat(pPr, "lvl") ?? 0) + 1;
    const lvls = lists.map((l) => lvlOf(l, lvl)).filter(Boolean) as XEl[];
    const pick = (k: string) => xat(pPr, k) ?? lvls.map((l) => xat(l, k)).find((v) => v !== undefined);
    const defR = lvls.map((l) => xkid(l, "a:defRPr")).filter(Boolean) as XEl[];
    const runStyle = (rPr: XEl | undefined): Omit<PvRun, "text"> => {
      const chain = [rPr, ...defR].filter(Boolean) as XEl[];
      const a = (k: string) => chain.map((x) => xat(x, k)).find((v) => v !== undefined);
      const fillEl = chain.map((x) => xkid(x, "a:solidFill")).find(Boolean);
      const latin = chain.map((x) => xat(xkid(x, "a:latin"), "typeface")).find(Boolean);
      const font = latin === "+mj-lt" ? cx.th.major : latin === "+mn-lt" || !latin ? cx.th.minor : latin;
      return {
        size: Number(a("sz") ?? 1800) / 100, bold: a("b") === "1", italic: a("i") === "1", underline: !!a("u") && a("u") !== "none",
        strike: !!a("strike") && a("strike") !== "noStrike", color: fillEl ? colorOf(clrKid(fillEl), cx.th, cx.map) : styleText,
        font, caps: a("cap") === "all", baseline: Number(a("baseline") ?? 0) / 1000, spc: Number(a("spc") ?? 0) / 100,
      };
    };
    const runs: PvRun[] = paraRuns(p).map((r) => ({ text: runText(r), ...runStyle(xkid(r, "a:rPr")) }));
    const end = runStyle(xkid(p, "a:endParaRPr"));
    let bu = xat(xpath(pPr, "a:buChar") ?? lvls.map((l) => xkid(l, "a:buChar")).find(Boolean), "char");
    const buFont = xat(xpath(pPr, "a:buFont") ?? lvls.map((l) => xkid(l, "a:buFont")).find(Boolean), "typeface") ?? "";
    // symbol fonts: their letters are pictures
    if (bu && /wingdings|symbol/i.test(buFont)) bu = ({ "ü": "✓", "§": "■", "Ø": "➢", "l": "●", "n": "■", "q": "❑", "v": "❖", "Ÿ": "•", "è": "➔", "ð": "➔", "o": "○" } as Record<string, string>)[bu] ?? "•";
    const noBu = !!xkid(pPr, "a:buNone");
    const lnPct = xat(xpath(pPr, "a:lnSpc", "a:spcPct") ?? lvls.map((l) => xpath(l, "a:lnSpc", "a:spcPct")).find(Boolean), "val");
    const sb = xat(xpath(pPr, "a:spcBef", "a:spcPts") ?? lvls.map((l) => xpath(l, "a:spcBef", "a:spcPts")).find(Boolean), "val");
    const sa = xat(xpath(pPr, "a:spcAft", "a:spcPts") ?? lvls.map((l) => xpath(l, "a:spcAft", "a:spcPts")).find(Boolean), "val");
    return {
      key: keyOf(pi), align: pick("algn") ?? "l", runs, endSize: end.size, color: end.color,
      bullet: !noBu && bu ? bu : undefined, marL: Number(pick("marL") ?? 0), indent: Number(pick("indent") ?? 0),
      lnSpc: lnPct ? Number(lnPct) / 100000 : undefined, spcBef: sb ? Number(sb) / 100 : undefined, spcAft: sa ? Number(sa) / 100 : undefined,
    };
  });
  return {
    anchor: xat(bp, "anchor") ?? "t", l: ins("lIns", 91440), r: ins("rIns", 91440), t: ins("tIns", 45720), b: ins("bIns", 45720),
    wrap: xat(bp, "wrap") !== "none", paras, scale: fa ? Number(xat(fa, "fontScale") ?? 100000) / 100000 : undefined,
    vert: /vert/.test(xat(bp, "vert") ?? "") && xat(bp, "vert") !== "horz",
  };
}

/** custGeom → SVG path data in the path's own coordinates. */
function custPaths(geom: XEl): { d: string; w: number; h: number }[] {
  return xkids(xkid(geom, "a:pathLst"), "a:path").map((path) => {
    const w = Number(xat(path, "w") ?? 0) || 1, h = Number(xat(path, "h") ?? 0) || 1;
    let d = "", cx = 0, cy = 0;
    const pt = (e: XEl | undefined) => [Number(xat(e, "x") ?? 0), Number(xat(e, "y") ?? 0)];
    for (const c of xels(path)) {
      if (c.name === "a:moveTo") { [cx, cy] = pt(xkid(c, "a:pt")); d += `M${cx} ${cy}`; }
      else if (c.name === "a:lnTo") { [cx, cy] = pt(xkid(c, "a:pt")); d += `L${cx} ${cy}`; }
      else if (c.name === "a:cubicBezTo") { const ps = xkids(c, "a:pt").map(pt); d += `C${ps.map((p) => p.join(" ")).join(" ")}`; [cx, cy] = ps[2] ?? [cx, cy]; }
      else if (c.name === "a:quadBezTo") { const ps = xkids(c, "a:pt").map(pt); d += `Q${ps.map((p) => p.join(" ")).join(" ")}`; [cx, cy] = ps[1] ?? [cx, cy]; }
      else if (c.name === "a:arcTo") {
        const wR = Number(xat(c, "wR") ?? 0), hR = Number(xat(c, "hR") ?? 0);
        const st = (Number(xat(c, "stAng") ?? 0) / 60000) * Math.PI / 180, sw = (Number(xat(c, "swAng") ?? 0) / 60000) * Math.PI / 180;
        const ox = cx - wR * Math.cos(st), oy = cy - hR * Math.sin(st);
        const ex = ox + wR * Math.cos(st + sw), ey = oy + hR * Math.sin(st + sw);
        d += `A${wR} ${hR} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${ex} ${ey}`; cx = ex; cy = ey;
      } else if (c.name === "a:close") d += "Z";
    }
    return { d, w, h };
  });
}

type Xf = { sx: number; sy: number; tx: number; ty: number };
const ID: Xf = { sx: 1, sy: 1, tx: 0, ty: 0 };

/** Draws a shape tree (slide, layout or master) into preview shapes. */
async function treeShapes(tree: XEl, cx: Ctx, layer: PvShape["layer"], opts: { n?: number; phLookup?: (ph: XEl) => { xfrm?: XEl; lists: XEl[]; body?: XEl } | undefined; skipPh?: boolean; txStyles: { title?: XEl; body?: XEl; other?: XEl } }): Promise<PvShape[]> {
  const out: PvShape[] = [];
  const list = shapesOf(tree);
  const ids = shapeIds(list);
  const xfOf = new Map<XEl, Xf>();
  const topOf = new Map<XEl, string>();
  for (let i = 0; i < list.length; i++) {
    const { el, parent } = list[i];
    const pxf = xfOf.get(parent) ?? ID;
    const top = topOf.get(parent) ?? ids[i];
    topOf.set(el, top);
    const nv = xels(el).find((k) => NV.includes(k.name));
    const ph = xpath(nv, "p:nvPr", "p:ph");
    if (ph && opts.skipPh) continue;
    const spPr = xkid(el, "p:spPr") ?? xkid(el, "p:grpSpPr");
    const phInfo = ph ? opts.phLookup?.(ph) : undefined;
    const xfrm = el.name === "p:graphicFrame" ? xkid(el, "p:xfrm") : xkid(spPr, "a:xfrm") ?? phInfo?.xfrm;
    const off = xkid(xfrm, "a:off"), ext = xkid(xfrm, "a:ext");
    let x = Number(xat(off, "x") ?? 0), y = Number(xat(off, "y") ?? 0), w = Number(xat(ext, "cx") ?? 0), h = Number(xat(ext, "cy") ?? 0);
    if (el.name === "p:grpSp") {
      const cho = xkid(xfrm, "a:chOff"), che = xkid(xfrm, "a:chExt");
      const chw = Number(xat(che, "cx") ?? w) || 1, chh = Number(xat(che, "cy") ?? h) || 1;
      const sx = w / chw, sy = h / chh;
      const local: Xf = { sx, sy, tx: x - Number(xat(cho, "x") ?? 0) * sx, ty: y - Number(xat(cho, "y") ?? 0) * sy };
      xfOf.set(el, { sx: pxf.sx * local.sx, sy: pxf.sy * local.sy, tx: pxf.sx * local.tx + pxf.tx, ty: pxf.sy * local.ty + pxf.ty });
      continue;
    }
    x = x * pxf.sx + pxf.tx; y = y * pxf.sy + pxf.ty; w *= pxf.sx; h *= pxf.sy;
    const name = xat(xkid(nv, "p:cNvPr"), "name") ?? "";
    const style = xkid(el, "p:style");
    const styleFill = Number(xat(xkid(style, "a:fillRef"), "idx") ?? 0) > 0 ? colorOf(clrKid(xkid(style, "a:fillRef")), cx.th, cx.map) : undefined;
    const styleLine = Number(xat(xkid(style, "a:lnRef"), "idx") ?? 0) > 0 ? colorOf(clrKid(xkid(style, "a:lnRef")), cx.th, cx.map) : undefined;
    const styleText = colorOf(clrKid(xkid(style, "a:fontRef")), cx.th, cx.map);
    const prst = xat(xkid(spPr, "a:prstGeom"), "prst") ?? (xkid(spPr, "a:custGeom") ? "cust" : "rect");
    const shape: PvShape = {
      sid: ids[i], name, layer, x, y, w, h, geom: prst, top: layer === "slide" ? top : undefined,
      rot: Number(xat(xfrm, "rot") ?? 0) / 60000 || undefined, flipH: xat(xfrm, "flipH") === "1", flipV: xat(xfrm, "flipV") === "1",
      hideIf: tokensIn(name).length ? tokensIn(name) : undefined,
    };
    if (prst === "roundRect") {
      const adj = xat(xkids(xpath(spPr, "a:prstGeom", "a:avLst"), "a:gd")[0], "fmla");
      shape.radius = (Math.min(w, h) * (adj ? Number(adj.replace(/\D/g, "")) : 16667)) / 100000;
    }
    if (prst === "cust") shape.path = custPaths(xkid(spPr, "a:custGeom")!);
    if (el.name === "p:cxnSp" || /line|Connector/i.test(prst)) shape.connector = true;
    // fill
    if (el.name === "p:pic") {
      const blip = xkid(xkid(el, "p:blipFill"), "a:blip");
      const rel = cx.rels.find((r) => r.id === xat(blip, "r:embed"));
      shape.img = rel ? await cx.img(rel.path) : undefined;
      const src = xpath(el, "p:blipFill", "a:srcRect");
      if (src) shape.crop = { l: Number(xat(src, "l") ?? 0) / 1000, t: Number(xat(src, "t") ?? 0) / 1000, r: Number(xat(src, "r") ?? 0) / 1000, b: Number(xat(src, "b") ?? 0) / 1000 };
    } else {
      const f = await fillOf(spPr, cx, styleFill);
      if (f?.img) { shape.img = f.img; shape.imgFill = true; }
      else if (f?.fill) shape.fill = f.fill;
      else if (!f?.none && styleFill) shape.fill = styleFill;
    }
    // line
    const ln = xkid(spPr, "a:ln");
    if (ln && !xkid(ln, "a:noFill")) {
      const lc = xkid(ln, "a:solidFill") ? colorOf(clrKid(xkid(ln, "a:solidFill")), cx.th, cx.map) : styleLine;
      if (lc) shape.line = { color: lc, w: Number(xat(ln, "w") ?? 9525), dash: !!xkid(ln, "a:prstDash") && xat(xkid(ln, "a:prstDash"), "val") !== "solid", head: !!xkid(ln, "a:headEnd") && xat(xkid(ln, "a:headEnd"), "type") !== "none", tail: !!xkid(ln, "a:tailEnd") && xat(xkid(ln, "a:tailEnd"), "type") !== "none" };
    } else if (!ln && styleLine && (shape.connector)) shape.line = { color: styleLine, w: 9525 };
    // text
    const n = opts.n;
    const body = xkid(el, "p:txBody");
    if (body) {
      const t = ph ? (xat(ph, "type") ?? "body") : "";
      const master = /title/i.test(t) ? opts.txStyles.title : ph ? opts.txStyles.body : opts.txStyles.other;
      shape.text = await textOf(body, cx, [...(phInfo?.lists ?? []), ...(master ? [master] : [])], (pi) => (n ? `${n}:${ids[i]}:${pi}` : undefined), styleText);
      if (!xkid(body, "a:bodyPr")?.attrs.length && phInfo?.body) {
        const pb = xkid(phInfo.body, "a:bodyPr");
        if (pb) { shape.text.anchor = xat(pb, "anchor") ?? shape.text.anchor; }
      }
    }
    // table
    const tbl = el.name === "p:graphicFrame" ? tableOf(el) : undefined;
    if (tbl) {
      const cols = xkids(xkid(tbl, "a:tblGrid"), "a:gridCol").map((g) => Number(xat(g, "w") ?? 0) * pxf.sx);
      const rows = [];
      const trs = xkids(tbl, "a:tr");
      for (let r = 0; r < trs.length; r++) {
        const tr = trs[r];
        const cells: PvCell[] = [];
        const tcs = xkids(tr, "a:tc");
        for (let c = 0; c < tcs.length; c++) {
          const tc = tcs[c];
          const tcPr = xkid(tc, "a:tcPr");
          const f = await fillOf(tcPr, cx);
          const border = (k: string) => { const l = xkid(tcPr, k); if (!l || xkid(l, "a:noFill")) return undefined; const col = colorOf(clrKid(xkid(l, "a:solidFill")), cx.th, cx.map); return col ? `${Math.max(1, Number(xat(l, "w") ?? 12700) / 12700)}px solid ${col}` : undefined; };
          const tb = xkid(tc, "a:txBody") ?? xel("p:txBody", [], [xel("a:bodyPr"), xel("a:p")]);
          const text = await textOf(tb, cx, [], (pi) => (n ? `${n}:${ids[i]}:r${r}c${c}:${pi}` : undefined));
          text.l = Number(xat(tcPr, "marL") ?? 91440); text.r = Number(xat(tcPr, "marR") ?? 91440); text.t = Number(xat(tcPr, "marT") ?? 45720); text.b = Number(xat(tcPr, "marB") ?? 45720);
          text.anchor = xat(tcPr, "anchor") ?? "t";
          cells.push({ tag: `r${r}c${c}`, text, fill: f?.fill, span: Number(xat(tc, "gridSpan") ?? 1), rowSpan: Number(xat(tc, "rowSpan") ?? 1), merged: xat(tc, "hMerge") === "1" || xat(tc, "vMerge") === "1", borders: { l: border("a:lnL"), r: border("a:lnR"), t: border("a:lnT"), b: border("a:lnB") } });
        }
        const rowText = tcs.map((tc) => xkids(xkid(tc, "a:txBody"), "a:p").map(paraTextOf).join("\n")).join("\n");
        rows.push({ h: Number(xat(tr, "h") ?? 0) * pxf.sy, tag: String(r), cells, text: rowText, repeat: tokensIn(rowText).some((k) => k.includes("#")) ? rowText : undefined });
      }
      shape.table = { cols, rows };
    }
    out.push(shape);
  }
  return out;
}

/** Image URLs per deck file (the very buffer): the preview and the editor of one file share them, so an image never reloads. */
const sharedImages = new WeakMap<object, Map<string, Promise<string | undefined>>>();
/** Reads images of a deck as object URLs (browser) or data URLs (node), once each (once per file when `key` is the file's buffer). */
function imageReader(zip: any, key?: unknown) {
  let imgCache = key && typeof key === "object" ? sharedImages.get(key as object) : undefined;
  if (!imgCache) { imgCache = new Map<string, Promise<string | undefined>>(); if (key && typeof key === "object") sharedImages.set(key as object, imgCache); }
  const shared = !!key && typeof key === "object";
  const cache = imgCache;
  const img = (path: string) => {
    if (!cache.has(path)) cache.set(path, (async () => {
      const f = zip.file(path);
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp", webp: "image/webp" } as any)[ext];
      if (!f || !mime) return undefined;
      if (typeof URL !== "undefined" && typeof (URL as any).createObjectURL === "function" && typeof window !== "undefined") {
        return URL.createObjectURL(new Blob([await f.async("uint8array")], { type: mime }));
      }
      return `data:${mime};base64,${await f.async("base64")}`;
    })());
    return cache.get(path)!;
  };
  return { img, cache, shared };
}

/** Draws slides of an open deck: `draw(s, doc?)` — doc overrides the slide's XML (the editor's pending changes). */
function slideDrawer(zip: any, img: (path: string) => Promise<string | undefined>) {
  const partCache = new Map<string, Promise<XEl | null>>();
  const part = (p: string) => { if (!partCache.has(p)) partCache.set(p, readPart(zip, p)); return partCache.get(p)!; };
  return async (s: { n: number; path: string }, override?: XEl): Promise<PvSlide | null> => {
    const sDoc = override ?? await part(s.path);
    if (!sDoc) return null;
    const sRels = await readRels(zip, s.path);
    const layoutPath = sRels.find((r) => r.type === "slideLayout")?.path;
    const lDoc = layoutPath ? await part(layoutPath) : null;
    const lRels = layoutPath ? await readRels(zip, layoutPath) : [];
    const masterPath = lRels.find((r) => r.type === "slideMaster")?.path;
    const mDoc = masterPath ? await part(masterPath) : null;
    const mRels = masterPath ? await readRels(zip, masterPath) : [];
    const themePath = mRels.find((r) => r.type === "theme")?.path;
    const tDoc = themePath ? await part(themePath) : null;
    // theme
    const scheme = xpath(xroot(tDoc ?? xel("#")), "a:themeElements", "a:clrScheme");
    const colors: Record<string, string> = {};
    xels(scheme).forEach((c) => { const v = clrKid(c); colors[c.name.replace("a:", "")] = (v?.name === "a:sysClr" ? xat(v, "lastClr") : xat(v, "val")) ?? "000000"; });
    const fonts = xpath(xroot(tDoc ?? xel("#")), "a:themeElements", "a:fontScheme");
    const th: Theme = { colors, major: xat(xpath(fonts, "a:majorFont", "a:latin"), "typeface") ?? "Arial", minor: xat(xpath(fonts, "a:minorFont", "a:latin"), "typeface") ?? "Arial" };
    const mRoot = mDoc ? xroot(mDoc) : undefined, lRoot = lDoc ? xroot(lDoc) : undefined, sRoot = xroot(sDoc);
    const map: Record<string, string> = {};
    (xkid(mRoot, "p:clrMap")?.attrs ?? []).forEach(([k, v]) => { map[k] = v; });
    const txSt = xkid(mRoot, "p:txStyles");
    const txStyles = { title: xkid(txSt, "p:titleStyle"), body: xkid(txSt, "p:bodyStyle"), other: xkid(txSt, "p:otherStyle") };
    const phsOf = (root: XEl | undefined) => {
      const tree = xpath(root, "p:cSld", "p:spTree");
      return tree ? shapesOf(tree).map(({ el }) => ({ el, ph: xpath(xels(el).find((k) => NV.includes(k.name)), "p:nvPr", "p:ph") })).filter((x) => x.ph) : [];
    };
    const lPhs = phsOf(lRoot), mPhs = phsOf(mRoot);
    const match = (list: { el: XEl; ph: XEl | undefined }[], ph: XEl) => {
      const idx = xat(ph, "idx"), type = xat(ph, "type") ?? "body";
      const norm = (t: string) => (t === "ctrTitle" ? "title" : t === "subTitle" || t === "obj" ? "body" : t);
      return (idx ? list.find((x) => xat(x.ph, "idx") === idx) : undefined) ?? list.find((x) => norm(xat(x.ph, "type") ?? "body") === norm(type));
    };
    const phLookup = (ph: XEl) => {
      const l = match(lPhs, ph), m = match(mPhs, ph) ?? (l ? match(mPhs, l.ph!) : undefined);
      const xf = xpath(l?.el, "p:spPr", "a:xfrm") ?? xpath(m?.el, "p:spPr", "a:xfrm");
      const lists = [xpath(l?.el, "p:txBody", "a:lstStyle"), xpath(m?.el, "p:txBody", "a:lstStyle")].filter(Boolean) as XEl[];
      return { xfrm: xf, lists, body: xkid(l?.el, "p:txBody") ?? xkid(m?.el, "p:txBody") };
    };
    // background: slide → layout → master
    let bg: string | undefined, bgImg: string | undefined;
    for (const [root, rels] of [[sRoot, sRels], [lRoot, lRels], [mRoot, mRels]] as [XEl | undefined, Rel[]][]) {
      const b = xpath(root, "p:cSld", "p:bg");
      if (!b) continue;
      const ctx: Ctx = { zip, th, map, rels, img };
      const bgPr = xkid(b, "p:bgPr");
      if (bgPr) { const f = await fillOf(bgPr, ctx); bg = f?.fill; bgImg = f?.img; }
      else { const ref = xkid(b, "p:bgRef"); bg = colorOf(clrKid(ref), th, map); }
      break;
    }
    const showMaster = xat(sRoot, "showMasterSp") !== "0";
    const shapes: PvShape[] = [];
    const draw = async (root: XEl | undefined, rels: Rel[], layer: PvShape["layer"], extra: Partial<Parameters<typeof treeShapes>[3]>) => {
      const tree = xpath(root, "p:cSld", "p:spTree");
      if (!tree) return;
      shapes.push(...(await treeShapes(tree, { zip, th, map, rels, img }, layer, { txStyles, ...extra })));
    };
    if (showMaster) {
      if (xat(lRoot, "showMasterSp") !== "0") await draw(mRoot, mRels, "master", { skipPh: true });
      await draw(lRoot, lRels, "layout", { skipPh: true });
    }
    await draw(sRoot, sRels, "slide", { n: s.n, phLookup });
    return { n: s.n, bg: bg ?? (bgImg ? undefined : "#FFFFFF"), bgImg, shapes, font: th.minor };
  };
}

/** Everything the slide preview needs, for every slide (or just `slides`). Images become object URLs in the browser. */
export async function loadDeckPreview(buf: ArrayBuffer | Uint8Array | Blob, opts: { slides?: number[]; shareImages?: boolean } = {}): Promise<PvDeck> {
  const zip = await openZip(buf);
  const info = await parseDeck(buf);
  const order = await slideOrder(zip);
  const { img } = imageReader(zip, opts.shareImages ? buf : undefined);
  const drawSlide = slideDrawer(zip, img);
  const want = opts.slides ? new Set(opts.slides) : null;
  const slides: PvSlide[] = [];
  for (const s of order.slides) {
    if (want && !want.has(s.n)) continue;
    const sl = await drawSlide(s);
    if (sl) slides.push(sl);
  }
  return { cx: order.cx, cy: order.cy, slides, info };
}

/**
 * The preview's text after values and edits: what each paragraph shows, which
 * shapes disappear and how many times each "#" table row repeats.
 */
export function previewTexts(text: PvText, get: (k: string) => string | undefined, edits: Record<string, string>, keyFor?: (pi: number) => string | undefined): { paras: PvPara[]; drop: boolean } {
  let hadTokens = false, allEmpty = true, staticBlank = true, edited = false;
  const paras: PvPara[] = [];
  if (condFails(text.paras.map((p) => p.runs.map((r) => r.text).join("")).join("\n"), get)) return { paras: [], drop: true };
  text.paras.forEach((p, pi) => {
    const key = keyFor ? keyFor(pi) : p.key;
    const base = { ...p, key };
    if (key && edits[key] !== undefined) {
      edited = true;
      const st = p.runs.find((r) => r.text !== "\n") ?? { size: p.endSize, color: p.color } as PvRun;
      edits[key].split("\n").forEach((l) => paras.push({ ...base, runs: l ? [{ ...st, text: l }] : [] }));
      return;
    }
    const res = resolvePara(p.runs.map((r) => r.text), get, true);
    if (!res.changed) { if (!res.staticBlank) staticBlank = false; paras.push(base); return; }
    hadTokens = true;
    if (!res.allEmpty) allEmpty = false;
    if (!res.staticBlank) staticBlank = false;
    res.lines.forEach((line) => paras.push({ ...base, runs: line.map((pc) => ({ ...(p.runs[pc.run] ?? { size: p.endSize }), text: pc.text })) }));
  });
  return { paras, drop: hadTokens && allEmpty && staticBlank && !edited };
}

// ------------------------------------------------------- editing a deck -----
/**
 * Changes made to the deck itself in Settings › Proposal template (move / resize
 * boxes, edit texts, add text boxes…). `sid` is the shape id as in DeckText keys.
 */
export type DeckEditOp =
  | { op: "text"; n: number; sid: string; cell?: { r: number; c: number }; paras: string[] }
  | { op: "xfrm"; n: number; sid: string; x: number; y: number; w: number; h: number }
  | { op: "delete"; n: number; sid: string }
  | { op: "add"; n: number; sid: string; x: number; y: number; w: number; h: number; text: string; size?: number; bold?: boolean; color?: string; align?: "l" | "ctr" | "r" }
  | { op: "duplicate"; n: number; sid: string; newSid: string; dx: number; dy: number }
  | { op: "order"; n: number; sid: string; dir: "forward" | "backward" | "front" | "back" }
  | { op: "name"; n: number; sid: string; name: string }
  | { op: "style"; n: number; sid: string; size?: number; bold?: boolean; italic?: boolean; color?: string | null; align?: "l" | "ctr" | "r" | "just" };

/** A top-level shape of a slide, as the editor shows it. */
export interface EditShape {
  sid: string; name: string; kind: "text" | "shape" | "picture" | "table" | "group" | "line";
  x: number; y: number; w: number; h: number; rot?: number; ph?: boolean;
  /** Its paragraphs (a line break inside a paragraph is "\n"). */
  paras?: string[];
  /** Table cells with text. */
  cells?: { r: number; c: number; paras: string[] }[];
  /** Text shapes inside a group. */
  children?: { sid: string; name: string; paras: string[] }[];
  /** The first run's look. */
  style?: { size?: number; bold?: boolean; italic?: boolean; color?: string; align?: string };
}

const TOP_UNITS = (tree: XEl) => xels(tree).filter((k) => SHAPES.includes(k.name) || k.name === "mc:AlternateContent");
const unitShape = (u: XEl) => (u.name === "mc:AlternateContent" ? xels(xkid(u, "mc:Choice") ?? xkid(u, "mc:Fallback")).find((k) => SHAPES.includes(k.name)) : u);
/** sid → shape element (any depth), and top-level unit of each shape. */
function slideIndex(tree: XEl) {
  const list = shapesOf(tree);
  const ids = shapeIds(list);
  const bySid = new Map<string, XEl>();
  list.forEach(({ el }, i) => bySid.set(ids[i], el));
  const sidOf = new Map<XEl, string>();
  list.forEach(({ el }, i) => sidOf.set(el, ids[i]));
  const units = TOP_UNITS(tree).map((u) => ({ unit: u, el: unitShape(u)! })).filter((x) => x.el);
  return { bySid, sidOf, units, unitOf: (sid: string) => units.find((u) => sidOf.get(u.el) === sid) };
}
const maxShapeId = (root: XEl) => Math.max(1, ...xfind(root, (e) => e.name === "p:cNvPr").map((e) => Number(xat(e, "id") ?? 0) || 0));

/** The xfrm element of a shape (created on the slide for a placeholder that inherits it). */
function xfrmOf(el: XEl, create: boolean): XEl | undefined {
  if (el.name === "p:graphicFrame") {
    let xf = xkid(el, "p:xfrm");
    if (!xf && create) { xf = xel("p:xfrm", [], [xel("a:off", [["x", "0"], ["y", "0"]]), xel("a:ext", [["cx", "0"], ["cy", "0"]])]); el.kids.splice(1, 0, xf); }
    return xf;
  }
  const prName = el.name === "p:grpSp" ? "p:grpSpPr" : "p:spPr";
  let pr = xkid(el, prName);
  if (!pr) {
    if (!create) return undefined;
    pr = xel(prName);
    const nvIdx = el.kids.findIndex((k) => k.t === 1 && NV.includes(k.name));
    el.kids.splice(nvIdx + 1, 0, pr);
  }
  let xf = xkid(pr, "a:xfrm");
  if (!xf && create) { xf = xel("a:xfrm", [], [xel("a:off", [["x", "0"], ["y", "0"]]), xel("a:ext", [["cx", "0"], ["cy", "0"]])]); pr.kids.splice(0, 0, xf); }
  return xf;
}
const BODY_OF = (el: XEl, cell?: { r: number; c: number }) => {
  if (cell) {
    const tc = xkids(xkids(tableOf(el), "a:tr")[cell.r], "a:tc")[cell.c];
    if (!tc) return undefined;
    let b = xkid(tc, "a:txBody");
    if (!b) { b = xel("a:txBody", [], [xel("a:bodyPr"), xel("a:lstStyle"), xel("a:p")]); tc.kids.splice(0, 0, b); }
    return b;
  }
  return xkid(el, "p:txBody");
};
const runPrOf = (p: XEl): XEl | undefined => {
  const first = paraRuns(p).find((r) => r.name !== "a:br");
  const rPr = xkid(first, "a:rPr");
  if (rPr) return rPr;
  const end = xkid(p, "a:endParaRPr");
  return end ? xel("a:rPr", end.attrs.map((a) => [a[0], a[1]]), end.kids.map(xclone)) : undefined;
};
/** A paragraph with new text: the first run's look, "\n" → line breaks. */
function paraWithText(p: XEl, text: string): XEl {
  const rPr = runPrOf(p);
  const pPr = xkid(p, "a:pPr"), end = xkid(p, "a:endParaRPr");
  const kids: XNode[] = [];
  if (pPr) kids.push(xclone(pPr));
  text.split("\n").forEach((line, i) => {
    if (i > 0) kids.push(xel("a:br", [], rPr ? [xclone(rPr)] : []));
    if (line) kids.push(xel("a:r", [], [...(rPr ? [xclone(rPr)] : []), xel("a:t", [], [{ t: 3, raw: xescape(line) }])]));
  });
  if (end) kids.push(xclone(end));
  else if (rPr) kids.push(xel("a:endParaRPr", rPr.attrs.map((a) => [a[0], a[1]]), rPr.kids.map(xclone)));
  return xel("a:p", p.attrs.map((a) => [a[0], a[1]]), kids);
}
function setBodyText(body: XEl, paras: string[]) {
  const old = xkids(body, "a:p");
  const tmpl = old[old.length - 1] ?? xel("a:p");
  const next = (paras.length ? paras : [""]).map((t, i) => {
    const p = old[i];
    if (p && paraTextOf(p) === t) return p;
    return paraWithText(p ?? tmpl, t);
  });
  const firstIdx = body.kids.findIndex((k) => k.t === 1 && k.name === "a:p");
  body.kids = body.kids.filter((k) => !(k.t === 1 && k.name === "a:p"));
  body.kids.splice(firstIdx < 0 ? body.kids.length : Math.min(firstIdx, body.kids.length), 0, ...next);
}
const FILLS = ["a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill"];
function styleRPr(rPr: XEl, st: Extract<DeckEditOp, { op: "style" }>) {
  if (st.size) xsetAt(rPr, "sz", String(Math.round(st.size * 100)));
  if (st.bold !== undefined) xsetAt(rPr, "b", st.bold ? "1" : "0");
  if (st.italic !== undefined) xsetAt(rPr, "i", st.italic ? "1" : "0");
  if (st.color !== undefined) {
    rPr.kids = rPr.kids.filter((k) => !(k.t === 1 && FILLS.includes(k.name)));
    if (st.color) {
      const at = rPr.kids.findIndex((k) => k.t === 1 && k.name === "a:ln");
      rPr.kids.splice(at + 1, 0, xel("a:solidFill", [], [xel("a:srgbClr", [["val", st.color.replace("#", "").toUpperCase()]])]));
    }
  }
}
function styleBody(body: XEl, st: Extract<DeckEditOp, { op: "style" }>) {
  xkids(body, "a:p").forEach((p) => {
    if (st.align) {
      let pPr = xkid(p, "a:pPr");
      if (!pPr) { pPr = xel("a:pPr"); p.kids.splice(0, 0, pPr); }
      xsetAt(pPr, "algn", st.align);
    }
    paraRuns(p).forEach((r) => {
      if (r.name === "a:br") return;
      let rPr = xkid(r, "a:rPr");
      if (!rPr) { rPr = xel("a:rPr", [["lang", "es-ES"], ["dirty", "0"]]); r.kids.splice(0, 0, rPr); }
      styleRPr(rPr, st);
    });
    const end = xkid(p, "a:endParaRPr");
    if (end) styleRPr(end, st);
  });
}

/** Applies editor changes to one slide's XML (in place). */
export function applyDeckOps(slideRoot: XEl, ops: DeckEditOp[]) {
  const tree = xpath(slideRoot, "p:cSld", "p:spTree");
  if (!tree) return;
  for (const o of ops) {
    const ix = slideIndex(tree);
    if (o.op === "add") {
      const lines = o.text.split("\n");
      const rPr = `<a:rPr lang="es-ES" sz="${Math.round((o.size ?? 14) * 100)}"${o.bold ? ' b="1"' : ""} dirty="0">${o.color ? `<a:solidFill><a:srgbClr val="${o.color.replace("#", "").toUpperCase()}"/></a:solidFill>` : ""}</a:rPr>`;
      const ps = lines.map((l) => `<a:p><a:pPr algn="${o.align ?? "l"}"/>${l ? `<a:r>${rPr}<a:t>${xescape(l)}</a:t></a:r>` : ""}<a:endParaRPr${rPr.slice(6, rPr.indexOf(">"))}/></a:p>`).join("");
      const xml = `<p:sp><p:nvSpPr><p:cNvPr id="${o.sid}" name="Text ${o.sid}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(o.x)}" y="${Math.round(o.y)}"/><a:ext cx="${Math.round(o.w)}" cy="${Math.round(o.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${ps}</p:txBody></p:sp>`;
      const el = xels(xparse(xml))[0];
      const ext = tree.kids.findIndex((k) => k.t === 1 && k.name === "p:extLst");
      tree.kids.splice(ext < 0 ? tree.kids.length : ext, 0, el);
      continue;
    }
    const el = ix.bySid.get(o.sid);
    if (!el) continue;
    if (o.op === "text") {
      const body = BODY_OF(el, o.cell);
      if (body) setBodyText(body, o.paras);
    } else if (o.op === "style") {
      if (el.name === "p:sp") { const b = xkid(el, "p:txBody"); if (b) styleBody(b, o); }
      else if (el.name === "p:graphicFrame") xkids(tableOf(el), "a:tr").forEach((tr) => xkids(tr, "a:tc").forEach((tc) => { const b = xkid(tc, "a:txBody"); if (b) styleBody(b, o); }));
      else if (el.name === "p:grpSp") shapesOf(el).forEach(({ el: c }) => { const b = xkid(c, "p:txBody"); if (b) styleBody(b, o); });
    } else if (o.op === "name") {
      const c = cNvPr(el); if (c) xsetAt(c, "name", o.name);
    } else if (o.op === "xfrm") {
      const xf = xfrmOf(el, true)!;
      let off = xkid(xf, "a:off"), ext = xkid(xf, "a:ext");
      if (!off) { off = xel("a:off", [["x", "0"], ["y", "0"]]); xf.kids.splice(0, 0, off); }
      if (!ext) { ext = xel("a:ext", [["cx", "0"], ["cy", "0"]]); xf.kids.splice(1, 0, ext); }
      const ow = Number(xat(ext, "cx") ?? 0), oh = Number(xat(ext, "cy") ?? 0);
      if (el.name === "p:grpSp" && !xkid(xf, "a:chOff")) {
        // a group without child space: the children keep their place inside it
        xf.kids.push(xel("a:chOff", [["x", xat(off, "x") ?? "0"], ["y", xat(off, "y") ?? "0"]]), xel("a:chExt", [["cx", String(ow)], ["cy", String(oh)]]));
      }
      xsetAt(off, "x", String(Math.round(o.x))); xsetAt(off, "y", String(Math.round(o.y)));
      xsetAt(ext, "cx", String(Math.max(1, Math.round(o.w)))); xsetAt(ext, "cy", String(Math.max(1, Math.round(o.h))));
      const tbl = el.name === "p:graphicFrame" ? tableOf(el) : undefined;
      if (tbl && ow > 0 && oh > 0) {
        const sx = o.w / ow, sy = o.h / oh;
        xkids(xkid(tbl, "a:tblGrid"), "a:gridCol").forEach((g) => xsetAt(g, "w", String(Math.max(1, Math.round(Number(xat(g, "w") ?? 0) * sx)))));
        xkids(tbl, "a:tr").forEach((tr) => xsetAt(tr, "h", String(Math.max(1, Math.round(Number(xat(tr, "h") ?? 0) * sy)))));
      }
    } else {
      const u = ix.unitOf(o.sid);
      if (!u) continue;
      const kids = tree.kids;
      if (o.op === "delete") { removeKid(tree, u.unit); continue; }
      if (o.op === "duplicate") {
        const copy = xclone(u.unit);
        let id = Number(o.newSid) || maxShapeId(slideRoot) + 1;
        const seen = new Map<string, number>();
        xfind(copy, (e) => e.name === "p:cNvPr").forEach((c) => {
          // a shape inside mc:Choice and its mc:Fallback twin share an id
          const old = xat(c, "id") ?? "";
          if (!seen.has(old)) seen.set(old, id++);
          xsetAt(c, "id", String(seen.get(old)));
        });
        const shapesIn = copy.name === "mc:AlternateContent"
          ? xels(copy).flatMap((alt) => xels(alt).filter((k) => SHAPES.includes(k.name)))
          : [copy];
        shapesIn.forEach((sh) => {
          const xf = xfrmOf(sh, false), off = xkid(xf, "a:off");
          if (off) { xsetAt(off, "x", String(Number(xat(off, "x") ?? 0) + Math.round(o.dx))); xsetAt(off, "y", String(Number(xat(off, "y") ?? 0) + Math.round(o.dy))); }
        });
        kids.splice(kids.indexOf(u.unit) + 1, 0, copy);
        continue;
      }
      if (o.op === "order") {
        const unitsNow = TOP_UNITS(tree);
        const i = unitsNow.indexOf(u.unit);
        const target = o.dir === "forward" ? unitsNow[i + 1] : o.dir === "backward" ? unitsNow[i - 1] : o.dir === "front" ? unitsNow[unitsNow.length - 1] : unitsNow[0];
        if (!target || target === u.unit) continue;
        removeKid(tree, u.unit);
        const at = kids.indexOf(target);
        kids.splice(o.dir === "forward" || o.dir === "front" ? at + 1 : at, 0, u.unit);
      }
    }
  }
}

/** The slide's top-level shapes for the editor (positions from the drawn slide when a placeholder inherits them). */
export function editShapesOf(slideRoot: XEl, drawn?: PvSlide): EditShape[] {
  const tree = xpath(slideRoot, "p:cSld", "p:spTree");
  if (!tree) return [];
  const ix = slideIndex(tree);
  const pv = new Map((drawn?.shapes ?? []).filter((s) => s.layer === "slide").map((s) => [s.sid, s]));
  const parasOf = (b: XEl | undefined) => xkids(b, "a:p").map(paraTextOf);
  const styleOf = (b: XEl | undefined, sid: string): EditShape["style"] => {
    const ps = pv.get(sid)?.text?.paras;
    const r = ps?.find((p) => p.runs.some((x) => x.text.trim()))?.runs.find((x) => x.text.trim());
    const p0 = xkid(xkids(b, "a:p")[0], "a:pPr");
    if (!r) return { align: xat(p0, "algn") };
    return { size: r.size, bold: r.bold, italic: r.italic, color: r.color, align: ps?.[0]?.align ?? xat(p0, "algn") };
  };
  return ix.units.map(({ el }) => {
    const sid = ix.sidOf.get(el)!;
    const nv = xels(el).find((k) => NV.includes(k.name));
    const ph = !!xpath(nv, "p:nvPr", "p:ph");
    const xf = xfrmOf(el, false);
    const off = xkid(xf, "a:off"), ext = xkid(xf, "a:ext");
    const d = pv.get(sid);
    let x = Number(xat(off, "x") ?? d?.x ?? 0), y = Number(xat(off, "y") ?? d?.y ?? 0), w = Number(xat(ext, "cx") ?? d?.w ?? 0), h = Number(xat(ext, "cy") ?? d?.h ?? 0);
    if (el.name === "p:grpSp" && !ext) {
      const kids = (drawn?.shapes ?? []).filter((s) => s.layer === "slide" && s.top === sid);
      if (kids.length) { x = Math.min(...kids.map((k) => k.x)); y = Math.min(...kids.map((k) => k.y)); w = Math.max(...kids.map((k) => k.x + k.w)) - x; h = Math.max(...kids.map((k) => k.y + k.h)) - y; }
    }
    const base = { sid, name: xat(cNvPr(el), "name") ?? "", x, y, w, h, rot: Number(xat(xf, "rot") ?? 0) / 60000 || undefined, ph };
    if (el.name === "p:grpSp") {
      const children = shapesOf(el).filter(({ el: c }) => xkid(c, "p:txBody")).map(({ el: c }) => ({ sid: ix.sidOf.get(c)!, name: xat(cNvPr(c), "name") ?? "", paras: parasOf(xkid(c, "p:txBody")) }))
        .filter((c) => c.paras.some((t) => t.trim()));
      return { ...base, kind: "group" as const, children };
    }
    if (el.name === "p:pic") return { ...base, kind: "picture" as const };
    if (el.name === "p:cxnSp") return { ...base, kind: "line" as const };
    if (el.name === "p:graphicFrame") {
      const tbl = tableOf(el);
      const cells: { r: number; c: number; paras: string[] }[] = [];
      xkids(tbl, "a:tr").forEach((tr, r) => xkids(tr, "a:tc").forEach((tc, c) => { if (xat(tc, "hMerge") !== "1" && xat(tc, "vMerge") !== "1") cells.push({ r, c, paras: parasOf(xkid(tc, "a:txBody")) }); }));
      return { ...base, kind: "table" as const, cells };
    }
    const body = xkid(el, "p:txBody");
    const paras = body ? parasOf(body) : undefined;
    const hasText = !!paras && paras.some((t) => t.trim());
    const isTb = xat(xpath(nv, "p:cNvSpPr"), "txBox") === "1";
    return { ...base, kind: (hasText || isTb || (ph && body) ? "text" : d?.connector ? "line" : "shape") as EditShape["kind"], paras, style: body ? styleOf(body, sid) : undefined };
  });
}

export interface DeckEditSession {
  cx: number; cy: number; info: DeckInfo;
  /** One slide with the pending changes: how it looks, its shapes, and the next free shape id. */
  render(n: number, ops: DeckEditOp[]): Promise<{ slide: PvSlide; shapes: EditShape[]; nextId: number }>;
  /** The deck with every change applied. */
  save(ops: DeckEditOp[]): Promise<Blob>;
  /** Frees the images (object URLs). */
  dispose(): void;
}

/** Opens a deck for editing: renders slides with pending changes in memory, saves a new .pptx. */
export async function openDeckEditor(buf: ArrayBuffer | Uint8Array | Blob, opts: { shareImages?: boolean } = {}): Promise<DeckEditSession> {
  const zip = await openZip(buf);
  const order = await slideOrder(zip);
  const info = await parseDeck(buf);
  const { img, cache, shared } = imageReader(zip, opts.shareImages ? buf : undefined);
  const drawSlide = slideDrawer(zip, img);
  const orig = new Map<string, string>();
  const xmlOf = async (path: string) => { if (!orig.has(path)) orig.set(path, await zip.file(path).async("string")); return orig.get(path)!; };
  const byN = new Map(order.slides.map((s) => [s.n, s]));
  return {
    cx: order.cx, cy: order.cy, info,
    async render(n, ops) {
      const s = byN.get(n);
      if (!s) throw new Error(`No slide ${n}`);
      const doc = xparse(await xmlOf(s.path));
      applyDeckOps(xroot(doc), ops.filter((o) => o.n === n));
      const slide = (await drawSlide(s, doc))!;
      return { slide, shapes: editShapesOf(xroot(doc), slide), nextId: maxShapeId(xroot(doc)) + 1 };
    },
    async save(ops) {
      const ns = Array.from(new Set(ops.map((o) => o.n)));
      for (const n of ns) {
        const s = byN.get(n);
        if (!s) continue;
        const doc = xparse(await xmlOf(s.path));
        applyDeckOps(xroot(doc), ops.filter((o) => o.n === n));
        zip.file(s.path, xstr(doc));
      }
      const bytes: Uint8Array = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: PPTX_MIME });
      return new Blob([bytes as any], { type: PPTX_MIME });
    },
    dispose() {
      // images shared with the file's preview stay (the preview still shows them)
      if (shared) return;
      cache.forEach((p) => p.then((u) => { if (u && u.startsWith("blob:")) URL.revokeObjectURL(u); }).catch(() => undefined));
    },
  };
}

/** Applies editor changes to a deck file and returns the new .pptx. */
export async function editDeck(buf: ArrayBuffer | Uint8Array | Blob, ops: DeckEditOp[]): Promise<Blob> {
  const zip = await openZip(buf);
  const order = await slideOrder(zip);
  for (const n of Array.from(new Set(ops.map((o) => o.n)))) {
    const s = order.slides.find((x) => x.n === n);
    if (!s) continue;
    const doc = xparse(await zip.file(s.path).async("string"));
    applyDeckOps(xroot(doc), ops.filter((o) => o.n === n));
    zip.file(s.path, xstr(doc));
  }
  const bytes: Uint8Array = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: PPTX_MIME });
  return new Blob([bytes as any], { type: PPTX_MIME });
}

// =====================================================================
//  HTML documents — proposals and contracts as interactive web pages
// =====================================================================
/**
 * A document template is a theme plus an ordered list of blocks. Blocks hold
 * text with {{tokens}}; some blocks draw their content from the deal (pricing,
 * timeline, schedule, parties, signature). A block can go in always, or once
 * per product / service of the proposal (optionally only for given catalogue
 * ids) — then its product.* / service.* tokens are that item's.
 * One renderer serves the editor (contenteditable, token chips, block tools),
 * the animated preview, the standalone .html file and print / PDF.
 */
export type DocKind = "proposal" | "contract";
export type DocLang = "es" | "en";
export interface DocTheme {
  primary: string; accent: string; ink: string; paper: string; muted: string;
  headingFont: string; bodyFont: string;
  logo?: string; logoDark?: string;
  /** soft = rounded and airy, sharp = editorial with square edges, bold = big type and strong colour */
  style?: "soft" | "sharp" | "bold";
  /** who sends it (parties, footer) */
  company?: string; legalName?: string; vat?: string; address?: string; web?: string; city?: string;
}
export type DocBlockType =
  | "cover" | "text" | "stats" | "cards" | "products" | "services" | "pricing" | "timeline" | "team"
  | "quote" | "image" | "terms" | "cta" | "parties" | "clauses" | "schedule" | "signature";
export interface DocItem { id: string; title?: string; text?: string; value?: string; image?: string }
export interface DocBlock {
  id: string; type: DocBlockType;
  eyebrow?: string; title?: string; body?: string; items?: DocItem[]; image?: string;
  layout?: "left" | "right" | "center"; tone?: "light" | "tint" | "dark" | "brand";
  when?: "always" | "product" | "service"; ids?: string[]; hidden?: boolean;
}
export interface DocTemplate {
  id?: string | null; name: string; kind: DocKind; lang: DocLang; sectors: string[]; isDefault?: boolean;
  theme: DocTheme; blocks: DocBlock[];
  terms?: { validityDays?: number; paymentDays?: number; annualIncreasePct?: number };
  reference?: { fileName: string; kind: string; at: string } | null;
}
/** A document as one deal has it: the template's blocks copied and edited, values typed by the seller. */
export interface DocInstance { templateId: string | null; blocks: DocBlock[]; values: Record<string, string>; theme?: DocTheme; updatedAt?: string }

/** What the contract says, as the deal stores it (trackings.contract_terms, the contract panel). Read loosely. */
export interface ContractTerms {
  signDate?: string | null; contractStart?: string | null; termYears?: number | null;
  /** pct / fixed: value a year; custom: perYear holds each year's amount */
  increments?: { mode?: "pct" | "fixed" | "none" | "custom" | string; value?: number | null; perYear?: (number | null)[] | null } | null;
  paymentTermsDays?: number | null; autoRenew?: boolean; renewYears?: number | null; contractRef?: string | null;
  /** list / discount / final: the whole term; firstYear: year 1 */
  license?: { list?: number; discount?: number; final?: number; firstYear?: number } | null;
  services?: { list?: number; discount?: number; final?: number } | null;
  schedule?: { year: number; license: number; services: number; total: number }[] | null;
  total?: number | null;
}

export const DOC_FONTS = ["Inter", "Manrope", "DM Sans", "Plus Jakarta Sans", "Outfit", "Space Grotesk", "Playfair Display", "Fraunces", "Source Serif 4", "Libre Baskerville", "Arial", "Georgia"];
const GOOGLE_FONTS = new Set(DOC_FONTS.filter((f) => f !== "Arial" && f !== "Georgia"));
const SERIF = /playfair|fraunces|serif|baskerville|georgia|garamond|times/i;
const fontStack = (f: string) => `"${f}", ${SERIF.test(f) ? 'Georgia, "Times New Roman", serif' : 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'}`;

export const DOC_BLOCKS: { type: DocBlockType; label: string; hint: string; kinds: DocKind[]; icon: string }[] = [
  { type: "cover", label: "Cover", hint: "Big opening with title, client and date", kinds: ["proposal", "contract"], icon: "M4 4h16v16H4zM4 15l5-5 4 4 3-3 4 4" },
  { type: "text", label: "Text", hint: "A heading and paragraphs, optional image", kinds: ["proposal", "contract"], icon: "M4 6h16M4 12h16M4 18h10" },
  { type: "stats", label: "Key figures", hint: "Big numbers that count up", kinds: ["proposal"], icon: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
  { type: "cards", label: "Cards", hint: "Points in a grid: challenges, benefits, features", kinds: ["proposal", "contract"], icon: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z" },
  { type: "products", label: "Product", hint: "One section per product, with its prices", kinds: ["proposal"], icon: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8" },
  { type: "services", label: "Service", hint: "One section per service, with phases and price", kinds: ["proposal"], icon: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" },
  { type: "pricing", label: "Investment", hint: "Every line and the total", kinds: ["proposal", "contract"], icon: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" },
  { type: "timeline", label: "Timeline", hint: "The phases of the services, step by step", kinds: ["proposal"], icon: "M3 12h18M7 8v8M12 6v12M17 9v6" },
  { type: "team", label: "Team", hint: "People and roles", kinds: ["proposal"], icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 .01M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
  { type: "quote", label: "Quote", hint: "A client testimonial", kinds: ["proposal"], icon: "M7 7h4v6H5V9a2 2 0 0 1 2-2zM15 7h4v6h-6V9a2 2 0 0 1 2-2zM5 13c0 3 1 4 4 5M13 13c0 3 1 4 4 5" },
  { type: "image", label: "Image", hint: "A full-width picture with caption", kinds: ["proposal", "contract"], icon: "M3 5h18v14H3zM8 11a2 2 0 1 0 0-.01M21 16l-5-5-9 8" },
  { type: "terms", label: "Conditions", hint: "Commercial conditions, as a list", kinds: ["proposal", "contract"], icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
  { type: "cta", label: "Closing", hint: "Next steps and the seller's contact", kinds: ["proposal"], icon: "M5 12h14M12 5l7 7-7 7" },
  { type: "parties", label: "Parties", hint: "Who signs: your company and the client", kinds: ["contract", "proposal"], icon: "M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-.01M3 21v-1a3 3 0 0 1 3-3M21 21v-1a3 3 0 0 0-3-3" },
  { type: "clauses", label: "Clauses", hint: "Numbered clauses", kinds: ["contract"], icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
  { type: "schedule", label: "Payment schedule", hint: "Year by year, with the yearly increase", kinds: ["contract", "proposal"], icon: "M3 4h18v18H3zM16 2v4M8 2v4M3 10h18" },
  { type: "signature", label: "Signatures", hint: "Place, date and signature boxes", kinds: ["contract", "proposal"], icon: "M3 17c3-3 5 1 7-2s2-6 5-3 4 4 6 2M3 21h18" },
];
export const docBlockMeta = (t: DocBlockType) => DOC_BLOCKS.find((b) => b.type === t) ?? DOC_BLOCKS[1];

/** Extra values of documents (on top of the deck's). */
export const DOC_EXTRA_TOKENS: DeckTokenDef[] = [
  { key: "client.vat", label: "Client VAT", group: "General", example: "B12345678" },
  { key: "client.address", label: "Client address", group: "General", example: "Calle Mayor 1, Madrid" },
  { key: "client.contact.role", label: "Client contact role", group: "General", example: "CFO" },
  { key: "client.contact.email", label: "Client contact email", group: "General", example: "ana@cliente.com" },
  { key: "value", label: "Potential revenue (deal value)", group: "General", example: "45.000 €" },
  { key: "provider.name", label: "Your company", group: "General", example: "Konsolidator" },
  { key: "provider.legal", label: "Your legal name", group: "General", example: "Konsolidator Iberia, S.L." },
  { key: "provider.vat", label: "Your VAT", group: "General", example: "B00000000" },
  { key: "provider.address", label: "Your address", group: "General", example: "Paseo de la Castellana 1, Madrid" },
  { key: "provider.city", label: "Your city (signature place)", group: "General", example: "Madrid" },
  { key: "terms.payment_days", label: "Payment days", group: "General", example: "30" },
  { key: "terms.validity_days", label: "Offer valid for (days)", group: "General", example: "30" },
  { key: "contract.sign_date", label: "Contract: sign date", group: "General", example: "15 de octubre de 2026" },
  { key: "contract.start", label: "Contract: start date", group: "General", example: "1 de noviembre de 2026" },
  { key: "contract.end", label: "Contract: end date", group: "General", example: "31 de octubre de 2029" },
  { key: "contract.years", label: "Contract: years", group: "General", example: "3" },
  { key: "contract.increment", label: "Contract: yearly increase, in words", group: "General", example: "Incremento anual del 3%" },
  { key: "contract.license.list", label: "Contract: licence list price (year 1)", group: "General", example: "20.000 €" },
  { key: "contract.license.discount", label: "Contract: licence discount", group: "General", example: "−2.000 €" },
  { key: "contract.license.final", label: "Contract: licence final price (year 1)", group: "General", example: "18.000 €" },
  { key: "contract.services.final", label: "Contract: services final price", group: "General", example: "12.000 €" },
  { key: "contract.license.term", label: "Contract: licence over the whole term", group: "General", example: "55.620 €" },
  { key: "contract.ref", label: "Contract: reference", group: "General", example: "KON-2026-014" },
  { key: "contract.total", label: "Contract: total over its whole term", group: "General", example: "68.000 €" },
  { key: "contract.yearN.license", label: "Contract: year N licence", group: "General", example: "18.540 €" },
  { key: "contract.yearN.total", label: "Contract: year N total", group: "General", example: "18.540 €" },
];
/** Every value a document can use, grouped for the variable palette. */
export function docTokenGroups(kind: DocKind): { group: string; tokens: DeckTokenDef[] }[] {
  const base = DECK_TOKENS.filter((t) => t.group !== "Repeat rows" && t.key !== "num");
  const contract = DOC_EXTRA_TOKENS.filter((t) => t.key.startsWith("contract."));
  const general = [...base.filter((t) => t.group === "General"), ...DOC_EXTRA_TOKENS.filter((t) => !t.key.startsWith("contract."))];
  const out = [
    { group: "Client & deal", tokens: general.filter((t) => /^(client|deal|proposal|value|date|valid_until)/.test(t.key)) },
    { group: "Totals", tokens: general.filter((t) => /^(total|agenda)/.test(t.key)) },
    { group: "You", tokens: general.filter((t) => /^(seller|provider|terms)/.test(t.key)) },
    { group: "Contract", tokens: contract },
    { group: "Product (in a product block)", tokens: base.filter((t) => t.group === "Product") },
    { group: "Service (in a service block)", tokens: base.filter((t) => t.group === "Service") },
  ];
  return kind === "contract" ? [out[0], out[3], out[2], out[1], out[4], out[5]] : out;
}
export const docTokenLabel = (key: string) => {
  const k = key.replace(/\d+/g, "N");
  return [...DOC_EXTRA_TOKENS, ...DECK_TOKENS].find((t) => t.key === k)?.label ?? key;
};

const rid = () => Math.random().toString(36).slice(2, 10);
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ----------------------------------------------------------- values -----
export interface DocContext extends DeckContext {
  theme: DocTheme;
  terms?: DocTemplate["terms"];
  contract?: ContractTerms | null;
  /** The value the deal shows (potential revenue); else the proposal total. */
  dealValue?: number | null;
}
const longDate = (iso: string | null | undefined, lang: DocLang) => {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? iso + "T12:00:00" : iso);
  if (isNaN(d.getTime())) return "";
  return lang === "es" ? `${d.getDate()} de ${MONTHS.es[d.getMonth()].toLowerCase()} de ${d.getFullYear()}` : `${d.getDate()} ${MONTHS.en[d.getMonth()]} ${d.getFullYear()}`;
};
/** The contract year by year: the deal's own schedule, else year 1 grown by the yearly increase (services in year 1). */
export function contractSchedule(data: ProposalData, c: ContractTerms | null | undefined, terms?: DocTemplate["terms"]) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const years0 = Math.max(1, Math.ceil(Number(c?.termYears ?? 0) - 1e-9) || Math.max(1, ...data.products.map((p) => (p.recurring ? Math.ceil((p.termYears || 1) - 1e-9) : 1))));
  const prodYear1 = data.products.reduce((s, p) => s + (p.recurring ? p.total / (p.termYears || 1) : p.total), 0);
  const prodList1 = data.products.reduce((s, p) => s + (p.recurring ? (p.total + p.discount) / (p.termYears || 1) : p.total + p.discount), 0);
  const svc = c?.services?.final ?? data.services.reduce((s, x) => s + x.total, 0);
  const inc = c?.increments ?? (terms?.annualIncreasePct ? { mode: "pct", value: terms.annualIncreasePct } : null);
  let rows: { year: number; license: number; services: number; total: number }[];
  if (c?.schedule?.length) rows = c.schedule.map((r) => ({ year: Number(r.year), license: Number(r.license) || 0, services: Number(r.services) || 0, total: Number(r.total) || (Number(r.license) || 0) + (Number(r.services) || 0) }));
  else {
    rows = [];
    const first = c?.license?.firstYear ?? prodYear1;
    let lic = first;
    for (let y = 1; y <= years0; y++) {
      if (y > 1) {
        const v = Number(inc?.value ?? 0);
        if (inc?.mode === "pct") lic = lic * (1 + v / 100);
        else if (inc?.mode === "fixed") lic = lic + v;
        else if (inc?.mode === "custom") { const c2 = inc.perYear?.[y - 1]; if (c2 != null && Number.isFinite(Number(c2))) lic = Number(c2); }
      }
      const sv = y === 1 ? svc : 0;
      rows.push({ year: y, license: r2(lic), services: sv, total: r2(lic + sv) });
    }
  }
  const years = rows.length || years0;
  const lic1 = c?.license?.firstYear ?? rows[0]?.license ?? prodYear1;
  const licList = c?.license?.list != null && years ? c.license.list / Math.max(1, Number(c?.termYears) || years) : prodList1;
  const licTerm = c?.license?.final ?? rows.reduce((s, r) => s + r.license, 0);
  const incText = (lang: DocLang) => {
    const v = Number(inc?.value ?? 0);
    const es = lang === "es";
    if (!inc || inc.mode === "none") return es ? "Sin incremento anual" : "No yearly increase";
    if (inc.mode === "custom") return es ? "Importe de la licencia fijado para cada año" : "Licence amount set for each year";
    if (!v) return es ? "Sin incremento anual" : "No yearly increase";
    if (inc.mode === "pct") return es ? `Incremento anual del ${deckNum(v)}% sobre la licencia` : `Yearly increase of ${deckNum(v)}% on the licence`;
    return es ? `Incremento anual de ${deckMoney(v)} sobre la licencia` : `Yearly increase of ${deckMoney(v)} on the licence`;
  };
  const total = c?.total ?? rows.reduce((s, r) => s + r.total, 0);
  return { rows, years, lic1, licList, licTerm, svc, incText, total };
}

/** All values of a document for one block (product / service blocks get that item's). */
export function docValues(ctx: DocContext, scope: DeckScope = {}): Record<string, string> {
  const lang = (ctx.lang ?? "es") as DocLang;
  const v = resolveTokens({ ...ctx, validityDays: ctx.terms?.validityDays ?? ctx.validityDays }, scope);
  const d = ctx.data, th = ctx.theme, c = ctx.contract ?? null;
  const sch = contractSchedule(d, c, ctx.terms);
  const start = c?.contractStart || c?.signDate || null;
  let end = "";
  if (start) { const e = new Date(start + "T12:00:00"); e.setFullYear(e.getFullYear() + sch.years); e.setDate(e.getDate() - 1); end = longDate(e.toISOString().slice(0, 10), lang); }
  Object.assign(v, {
    "client.name": d.client.name ?? "", "client.vat": d.client.vat ?? "", "client.address": d.client.address ?? "",
    "client.contact.role": d.client.contactRole ?? "", "client.contact.email": d.client.contactEmail ?? "",
    value: deckMoney(ctx.dealValue ?? d.totals.total),
    "provider.name": th.company ?? "", "provider.legal": th.legalName || th.company || "", "provider.vat": th.vat ?? "",
    "provider.address": th.address ?? "", "provider.city": th.city ?? "",
    "terms.payment_days": String(c?.paymentTermsDays ?? ctx.terms?.paymentDays ?? 30), "terms.validity_days": String(ctx.terms?.validityDays ?? 30),
    "contract.ref": c?.contractRef ?? "", "contract.license.term": deckMoney(sch.licTerm),
    "contract.sign_date": longDate(c?.signDate, lang), "contract.start": longDate(start, lang), "contract.end": end,
    "contract.years": String(sch.years), "contract.increment": sch.incText(lang),
    "contract.license.list": deckMoney(sch.licList), "contract.license.discount": sch.licList > sch.lic1 ? deckMoney(sch.lic1 - sch.licList) : "",
    "contract.license.final": deckMoney(sch.lic1), "contract.services.final": deckMoney(sch.svc), "contract.total": deckMoney(sch.total),
  });
  sch.rows.forEach((r) => { v[`contract.year${r.year}.license`] = deckMoney(r.license); v[`contract.year${r.year}.total`] = deckMoney(r.total); });
  return v;
}

// ------------------------------------------------------ block plan -----
export interface DocPlaced { block: DocBlock; scope: DeckScope; key: string; who?: string }
/** The blocks as they come out for this deal: hidden ones out, product / service blocks once per matching item. */
export function planDoc(blocks: DocBlock[], data: ProposalData, productIds: string[], serviceIds: string[], showHidden = false): DocPlaced[] {
  const out: DocPlaced[] = [];
  blocks.forEach((b) => {
    if (b.hidden && !showHidden) return;
    const when = b.when ?? (b.type === "products" ? "product" : b.type === "services" ? "service" : "always");
    if (when === "always") { out.push({ block: b, scope: {}, key: b.id }); return; }
    const list = when === "product" ? productIds : serviceIds;
    const names = when === "product" ? data.products.map((p) => p.name) : data.services.map((s) => s.name);
    const n = Math.max(list.length, names.length);
    for (let k = 0; k < n; k++) {
      if (b.ids?.length && !b.ids.includes(list[k] ?? "")) continue;
      out.push({ block: b, scope: when === "product" ? { product: k } : { service: k }, key: `${b.id}-${k}`, who: names[k] });
    }
  });
  return out;
}

// ------------------------------------------------------- rich text -----
const INLINE_OK = /^(b|strong|i|em|u|br|p|ul|ol|li|a|h3|h4|span|div|mark|s)$/i;
/** Keeps a small safe subset of HTML (bold, italic, lists, links, paragraphs) and the {{tokens}}. */
export function cleanRich(html: string): string {
  return String(html ?? "")
    .replace(/<\s*(script|style|iframe|object|embed|svg|math)[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(\/?)\s*([a-z0-9]+)([^>]*)>/gi, (_m, close: string, tag: string, attrs: string) => {
      if (!INLINE_OK.test(tag)) return "";
      const t = tag.toLowerCase() === "div" ? "p" : tag.toLowerCase() === "span" ? "" : tag.toLowerCase();
      if (!t) return "";
      if (close) return `</${t}>`;
      if (t === "a") { const h = /href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? ""; return /^(https?:|mailto:|tel:)/i.test(h) ? `<a href="${esc(h)}">` : "<a>"; }
      return `<${t}>`;
    })
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/<p>\s*<\/p>/g, "")
    .trim();
}
/** Plain text → paragraphs (blank line = new paragraph, "- " lines = list). Leaves HTML as it is. */
export function textToRich(s: string): string {
  if (/<(p|ul|ol|br|b|strong|em|i)\b/i.test(s)) return s;
  return s.split(/\n{2,}/).map((para) => {
    const ls = para.split("\n").map((l) => l.trim()).filter(Boolean);
    if (ls.length && ls.every((l) => /^([-•·*▪–]|\d+[.)])\s+/.test(l))) return `<ul>${ls.map((l) => `<li>${esc(l.replace(/^([-•·*▪–]|\d+[.)])\s+/, ""))}</li>`).join("")}</ul>`;
    return ls.length ? `<p>${ls.map(esc).join("<br>")}</p>` : "";
  }).join("");
}
export const richToText = (html: string) => String(html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h3|h4)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();

// --------------------------------------------------------- renderer -----
export type DocMode = "view" | "edit" | "print";
export interface DocRenderOptions {
  mode: DocMode;
  /** The value of a token for one placed block. */
  valuesFor: (p: DocPlaced) => Record<string, string>;
  /** In the editor: show {{token}} chips with these names instead of values (template editing). */
  chipsAsLabels?: boolean;
  /** Placed blocks (from planDoc). */
  placed: DocPlaced[];
  data: ProposalData;
  contract?: ContractTerms | null;
  terms?: DocTemplate["terms"];
  title?: string;
  /** The block highlighted in the editor. */
  selected?: string | null;
  kind: DocKind;
  lang?: DocLang;
}

function themeCss(t: DocTheme): string {
  const style = t.style ?? "soft";
  const r = style === "sharp" ? 2 : style === "bold" ? 18 : 14;
  return `:root{--p:${t.primary};--a:${t.accent};--ink:${t.ink};--paper:${t.paper};--mut:${t.muted};--r:${r}px;--hf:${fontStack(t.headingFont)};--bf:${fontStack(t.bodyFont)};--hw:${style === "bold" ? 800 : style === "sharp" ? 600 : 700};--hs:${style === "bold" ? 1.12 : 1}}`;
}

// colour mixes are worked out here (not with CSS color-mix) so every browser — and the PDF renderer — draws them
const hexRgb = (h: string): [number, number, number] => {
  let x = String(h || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(x)) x = x.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(x)) return [0, 0, 0];
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
};
function resolveMixes(css: string, t: DocTheme): string {
  const vars: Record<string, string> = { "--p": t.primary, "--a": t.accent, "--ink": t.ink, "--paper": t.paper, "--mut": t.muted };
  const parse = (a: string): [number, number, number, number] => {
    a = a.trim();
    if (a === "transparent") return [0, 0, 0, 0];
    const v = /^var\((--[\w-]+)\)$/.exec(a);
    const hex = v ? vars[v[1]] ?? "#000" : a;
    return [...hexRgb(hex), 1];
  };
  return css.replace(/color-mix\(in srgb,\s*([^,()]+(?:\([^)]*\))?)\s+(\d+(?:\.\d+)?)%\s*,\s*([^,()]+(?:\([^)]*\))?)\)/g, (_m, a: string, pc: string, b: string) => {
    const p = Number(pc) / 100, A = parse(a), B = parse(b);
    const alpha = A[3] * p + B[3] * (1 - p);
    if (alpha <= 0) return "transparent";
    const ch = (i: number) => Math.round((A[i] * A[3] * p + B[i] * B[3] * (1 - p)) / alpha);
    return alpha >= 0.999 ? `rgb(${ch(0)},${ch(1)},${ch(2)})` : `rgba(${ch(0)},${ch(1)},${ch(2)},${alpha.toFixed(3)})`;
  });
}
/** The page's whole stylesheet for a theme. */
export const docCss = (t: DocTheme) => themeCss(t) + resolveMixes(DOC_CSS, t);

/** Text of a field: tokens become values (view / print) or chips (editor). Conditional paragraphs drop. */
function fieldHtml(raw: string | undefined, vals: Record<string, string>, o: DocRenderOptions, rich: boolean): string {
  let s = String(raw ?? "");
  if (rich) {
    s = cleanRich(textToRich(s));
    // a paragraph / list item with {{?x}} goes away when x is empty
    s = s.replace(/<(p|li)>([\s\S]*?)<\/\1>/g, (m, _t, inner: string) => (condFails(inner, (k) => vals[k]) ? "" : m));
  } else {
    s = esc(s);
  }
  const out = s.replace(TOKEN_RE, (_m, k0: string) => {
    const k = k0.trim();
    if (k.startsWith("?")) return o.mode === "edit" ? `<span class="tk is-cond" contenteditable="false" data-tk="${esc(k)}">if ${esc(k.slice(1))}</span>` : "";
    const val = vals[k];
    const shown = val == null || val === "" ? "" : rich ? esc(val).replace(/\n/g, "<br>") : esc(val).replace(/\n/g, " · ");
    if (o.mode !== "edit") return shown;
    const label = docTokenLabel(k);
    const txt = o.chipsAsLabels ? label : shown || label;
    return `<span class="tk${o.chipsAsLabels ? " is-label" : ""}${!o.chipsAsLabels && !shown ? " is-empty" : ""}" contenteditable="false" data-tk="${esc(k)}" title="{{${esc(k)}}}">${txt}</span>`;
  });
  return o.mode === "edit" ? out : out.replace(/(\b[A-Z]{1,3})\.\.(?=\s|<|$)/g, "$1.");
}

const ICONS: Record<string, string> = {
  check: "M20 6L9 17l-5-5", arrow: "M5 12h14M12 5l7 7-7 7", spark: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8",
  mail: "M4 4h16v16H4zM4 6l8 7 8-7", phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
};
const svg = (k: string, cls = "ic") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[k] ?? k}"/></svg>`;

/** Renders the whole document as one self-contained HTML page. */
export function renderDocHtml(theme: DocTheme, o: DocRenderOptions): string {
  const lang = o.lang ?? "es";
  const fonts = Array.from(new Set([theme.headingFont, theme.bodyFont].filter((f) => GOOGLE_FONTS.has(f))));
  const fontLink = fonts.length ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fonts.map((f) => `family=${encodeURIComponent(f)}:wght@400;500;600;700;800`).join("&")}&display=swap">` : "";
  const body = renderDocBody(theme, o);
  const nav = o.mode === "view" ? `<div class="dp-progress"><i></i></div><nav class="dp-dots">${o.placed.filter((p) => p.block.type !== "signature").map((p, i) => `<a href="#b-${esc(p.key)}" title="${esc(richToText(fieldHtml(p.block.title || docBlockMeta(p.block.type).label, o.valuesFor(p), { ...o, mode: "view" }, false)))}"><i></i></a>`.replace("<a ", i === 0 ? '<a class="is-on" ' : "<a ")).join("")}</nav>` : "";
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title ?? "Proposal")}</title>${fontLink}<style id="dx-css">${docCss(theme)}</style></head><body class="dm-${o.mode} st-${theme.style ?? "soft"} k-${o.kind}">${nav}<main id="doc">${body}</main>${o.mode === "view" ? `<script>${DOC_JS}</script>` : ""}</body></html>`;
}

/** Only the sections (the editor swaps them in place, keeping scroll and caret). */
export function renderDocBody(theme: DocTheme, o: DocRenderOptions): string {
  const ed = o.mode === "edit";
  const lang: DocLang = o.lang ?? "es";
  return o.placed.map((p, i) => {
    const b = p.block, vals = o.valuesFor(p);
    const f = (field: keyof DocBlock, rich = false, cls = "", tag = "div") => {
      const raw = (b as any)[field] as string | undefined;
      if (!ed && !String(raw ?? "").trim()) return "";
      const html = fieldHtml(raw, vals, o, rich);
      if (!ed && !richToText(html) && !/<img/.test(html)) return "";
      return `<${tag} class="${cls}${ed ? " ed" : ""}"${ed ? ` contenteditable="true" data-f="${b.id}|${String(field)}" data-ph="${esc(PH[String(field)] ?? "Type…")}"${rich ? ' data-rich="1"' : ""}` : ""}>${html}</${tag}>`;
    };
    const fi = (it: DocItem, k: number, field: keyof DocItem, rich = false, cls = "", tag = "div") => {
      const raw = (it as any)[field] as string | undefined;
      if (!ed && !String(raw ?? "").trim()) return "";
      const html = fieldHtml(raw, vals, o, rich);
      return `<${tag} class="${cls}${ed ? " ed" : ""}"${ed ? ` contenteditable="true" data-f="${b.id}|items|${k}|${String(field)}" data-ph="${esc(PH["i." + String(field)] ?? "Type…")}"${rich ? ' data-rich="1"' : ""}` : ""}>${html}</${tag}>`;
    };
    const items = b.items ?? [];
    const itemTools = (k: number) => (ed ? `<button class="dx-it-del" data-act="del-item" data-b="${b.id}" data-k="${k}" title="Remove">×</button>` : "");
    const addItem = (label: string) => (ed ? `<button class="dx-it-add" data-act="add-item" data-b="${b.id}">+ ${label}</button>` : "");
    const head = (center = false) => `<header class="sh${center ? " c" : ""} rv">${f("eyebrow", false, "eb")}${f("title", false, "h2", "h2")}${f("body", true, "lead rt")}</header>`;
    const tone = b.tone ?? DEFAULT_TONE[b.type] ?? "light";
    const img = (src?: string, cls = "") => (src ? `<img class="${cls}" src="${esc(src)}" alt="">` : "");
    let inner = "";
    switch (b.type) {
      case "cover": {
        const logo = theme.logo || theme.logoDark;
        inner = `<div class="cv-bg">${b.image ? `<div class="cv-img" style="background-image:url('${esc(b.image)}')"></div>` : ""}<i class="cv-o o1"></i><i class="cv-o o2"></i><i class="cv-o o3"></i><div class="cv-grid"></div></div>
<div class="cv-in"><div class="cv-top">${logo ? `<img class="cv-logo" src="${esc(logo)}" alt="">` : `<b class="cv-brand">${esc(theme.company ?? "")}</b>`}${f("eyebrow", false, "cv-eb")}</div>
<div class="cv-mid">${f("title", false, "cv-t", "h1")}${f("body", true, "cv-sub rt")}</div>
<div class="cv-foot">${items.map((it, k) => `<div class="cv-meta">${fi(it, k, "title", false, "cv-k")}${fi(it, k, "text", false, "cv-v")}${itemTools(k)}</div>`).join("")}${addItem("detail")}</div></div>
${o.mode === "view" ? `<a class="cv-down" href="#b-${esc(o.placed[i + 1]?.key ?? "")}" aria-label="Scroll">${svg("M12 5v14M5 12l7 7 7-7")}</a>` : ""}`;
        break;
      }
      case "text":
        inner = `<div class="wrap tx ${b.image ? `has-img lay-${b.layout ?? "right"}` : `lay-${b.layout ?? "left"}`}"><div class="tx-copy rv">${f("eyebrow", false, "eb")}${f("title", false, "h2", "h2")}${f("body", true, "rt")}</div>${b.image ? `<figure class="tx-img rv d2">${img(b.image)}</figure>` : ""}</div>`;
        break;
      case "stats":
        inner = `<div class="wrap">${head(true)}<div class="st-grid">${items.map((it, k) => `<div class="st rv d${(k % 4) + 1}">${fi(it, k, "value", false, "st-v", "div")}${fi(it, k, "title", false, "st-t")}${fi(it, k, "text", false, "st-x")}${itemTools(k)}</div>`).join("")}${addItem("figure")}</div></div>`;
        break;
      case "cards":
        inner = `<div class="wrap">${head()}<div class="cd-grid n${Math.min(4, Math.max(1, items.length))}">${items.map((it, k) => `<article class="cd rv d${(k % 4) + 1}">${it.image ? img(it.image, "cd-img") : `<span class="cd-n">${String(k + 1).padStart(2, "0")}</span>`}${fi(it, k, "title", false, "cd-t", "h3")}${fi(it, k, "text", true, "cd-x rt")}${itemTools(k)}</article>`).join("")}${addItem("card")}</div></div>`;
        break;
      case "products": {
        const pr = o.data.products[p.scope.product ?? 0];
        inner = `<div class="wrap pl">${head()}${pr ? productCard(pr, vals, o.kind) : ed ? `<p class="dx-note">Prices of each product of the deal show here.</p>` : ""}${items.length || ed ? `<div class="cd-grid n${Math.min(3, Math.max(1, items.length))} sm">${items.map((it, k) => `<article class="cd rv">${fi(it, k, "title", false, "cd-t", "h3")}${fi(it, k, "text", true, "cd-x rt")}${itemTools(k)}</article>`).join("")}${addItem("feature")}</div>` : ""}</div>`;
        break;
      }
      case "services": {
        const sv = o.data.services[p.scope.service ?? 0];
        inner = `<div class="wrap pl">${head()}${sv ? serviceCard(sv) : ed ? `<p class="dx-note">Phases and price of each service of the deal show here.</p>` : ""}${items.length || ed ? `<div class="cd-grid n${Math.min(3, Math.max(1, items.length))} sm">${items.map((it, k) => `<article class="cd rv">${fi(it, k, "title", false, "cd-t", "h3")}${fi(it, k, "text", true, "cd-x rt")}${itemTools(k)}</article>`).join("")}${addItem("point")}</div>` : ""}</div>`;
        break;
      }
      case "pricing":
        inner = `<div class="wrap">${head()}${o.kind === "contract" ? contractPricing(o.data, o.contract, o.terms, lang) : pricingTable(o.data, o.kind)}</div>`;
        break;
      case "timeline": {
        const phases = o.data.services.flatMap((s) => s.phases.map((ph) => ({ ...ph, svc: s.name })));
        const manual = items.map((it, k) => `<li class="tl-i rv"><span class="tl-dot"></span>${fi(it, k, "value", false, "tl-d")}${fi(it, k, "title", false, "tl-t", "h3")}${fi(it, k, "text", true, "tl-x rt")}${itemTools(k)}</li>`).join("");
        const auto = phases.map((ph, k) => `<li class="tl-i rv d${(k % 4) + 1}"><span class="tl-dot">${k + 1}</span><div class="tl-d">${esc(deckNum(ph.days))} ${lang === "es" ? (ph.days === 1 ? "jornada" : "jornadas") : ph.days === 1 ? "day" : "days"}${o.data.services.length > 1 ? ` · ${esc(ph.svc)}` : ""}</div><h3 class="tl-t">${esc(ph.name)}</h3>${ph.bullets?.length ? `<ul class="tl-x">${ph.bullets.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</li>`).join("");
        inner = `<div class="wrap">${head()}<ol class="tl">${items.length ? manual : auto || (ed ? `<li class="dx-note">The phases of the services show here — or add your own steps.</li>` : "")}</ol>${addItem("step")}</div>`;
        break;
      }
      case "team":
        inner = `<div class="wrap">${head()}<div class="tm-grid">${items.map((it, k) => `<div class="tm rv d${(k % 4) + 1}">${it.image ? img(it.image, "tm-ph") : `<span class="tm-ph tm-in">${esc(richToText(it.title ?? "").split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase())}</span>`}${fi(it, k, "title", false, "tm-t", "h3")}${fi(it, k, "value", false, "tm-r")}${fi(it, k, "text", true, "tm-x rt")}${itemTools(k)}</div>`).join("")}${addItem("person")}</div></div>`;
        break;
      case "quote":
        inner = `<div class="wrap qt rv"><span class="qt-m">“</span>${f("body", true, "qt-x rt")}<div class="qt-by">${b.image ? img(b.image, "qt-ph") : ""}<div>${f("title", false, "qt-t")}${f("eyebrow", false, "qt-r")}</div></div></div>`;
        break;
      case "image":
        inner = `<figure class="wrap im rv">${b.image ? img(b.image) : ed ? `<div class="dx-drop" data-act="pick-image" data-b="${b.id}">Drop an image here or click to choose one</div>` : ""}${f("title", false, "im-c", "figcaption")}</figure>`;
        break;
      case "terms":
        inner = `<div class="wrap">${head()}<ul class="tr">${items.map((it, k) => `<li class="rv">${svg("check")}<div>${fi(it, k, "title", false, "tr-t")}${fi(it, k, "text", true, "tr-x rt")}</div>${itemTools(k)}</li>`).join("")}</ul>${addItem("condition")}</div>`;
        break;
      case "cta": {
        const sname = vals["seller.name"], smail = vals["seller.email"], sphone = vals["seller.phone"];
        inner = `<div class="wrap ct rv">${f("eyebrow", false, "eb")}${f("title", false, "ct-t", "h2")}${f("body", true, "ct-x rt")}<div class="ct-card">${sname ? `<span class="ct-av">${esc(sname.split(/\s+/).map((w) => w[0]).join("").slice(0, 2))}</span>` : ""}<div><b>${esc(sname || "")}</b>${smail ? `<a href="mailto:${esc(smail)}">${svg("mail")}${esc(smail)}</a>` : ""}${sphone ? `<a href="tel:${esc(sphone.replace(/\s+/g, ""))}">${svg("phone")}${esc(sphone)}</a>` : ""}</div></div></div>`;
        break;
      }
      case "parties": {
        const lbl = lang === "es" ? ["De una parte", "De otra parte", "NIF", "Domicilio"] : ["On one side", "On the other side", "VAT", "Address"];
        const party = (k: string, name: string, legal: string, vat: string, addr: string, extra = "") => `<div class="pt rv"><span class="pt-k">${k}</span><b class="pt-n">${esc(legal || name)}</b>${vat ? `<span><i>${lbl[2]}</i>${esc(vat)}</span>` : ""}${addr ? `<span><i>${lbl[3]}</i>${esc(addr)}</span>` : ""}${extra}</div>`;
        inner = `<div class="wrap">${head()}<div class="pt-grid">${party(lbl[0], vals["provider.name"], vals["provider.legal"], vals["provider.vat"], vals["provider.address"])}${party(lbl[1], vals.client, vals["client.legal"], vals["client.vat"], vals["client.address"], vals["client.contact"] ? `<span><i>${lang === "es" ? "Contacto" : "Contact"}</i>${esc(vals["client.contact"])}${vals["client.contact.role"] ? ` · ${esc(vals["client.contact.role"])}` : ""}</span>` : "")}</div></div>`;
        break;
      }
      case "clauses":
        inner = `<div class="wrap cl">${head()}<ol class="cl-l">${items.map((it, k) => `<li class="rv"><span class="cl-n">${k + 1}</span><div class="cl-b">${fi(it, k, "title", false, "cl-t", "h3")}${fi(it, k, "text", true, "cl-x rt")}</div>${itemTools(k)}</li>`).join("")}</ol>${addItem("clause")}</div>`;
        break;
      case "schedule":
        inner = `<div class="wrap">${head()}${scheduleTable(o.data, o.contract, o.terms, lang)}</div>`;
        break;
      case "signature": {
        const l = lang === "es" ? ["Por", "Firma", "Nombre y cargo", "Fecha"] : ["For", "Signature", "Name and title", "Date"];
        const box = (who: string) => `<div class="sg-b"><span class="sg-k">${l[0]} ${esc(who)}</span><div class="sg-line"></div><span class="sg-l">${l[1]}</span><div class="sg-line s"></div><span class="sg-l">${l[2]}</span><div class="sg-line s"></div><span class="sg-l">${l[3]}</span></div>`;
        inner = `<div class="wrap sg rv">${f("title", false, "h2", "h2")}${f("body", true, "rt sg-x")}<div class="sg-grid">${box(vals["provider.legal"] || vals["provider.name"] || "—")}${box(vals["client.legal"] || vals.client || "—")}</div></div>`;
        break;
      }
    }
    const tools = ed ? `<div class="dx-tools" contenteditable="false"><span class="dx-tl">${esc(docBlockMeta(b.type).label)}${p.who ? ` · ${esc(p.who)}` : ""}${b.hidden ? " · hidden" : ""}</span><button data-act="up" data-b="${b.id}" title="Move up">↑</button><button data-act="down" data-b="${b.id}" title="Move down">↓</button><button data-act="dup" data-b="${b.id}" title="Duplicate">⧉</button><button data-act="hide" data-b="${b.id}" title="${b.hidden ? "Show" : "Hide"}">${b.hidden ? "◌" : "◉"}</button><button data-act="del" data-b="${b.id}" title="Delete" class="is-del">✕</button></div><button class="dx-ins" data-act="insert" data-at="${b.id}" contenteditable="false" title="Add a block here">+</button>` : "";
    return `<section id="b-${esc(p.key)}" class="blk t-${b.type} tone-${tone}${ed && o.selected === b.id ? " is-sel" : ""}${b.hidden ? " is-hidden" : ""}" data-b="${b.id}">${tools}${inner}</section>`;
  }).join("\n");
}
const DEFAULT_TONE: Partial<Record<DocBlockType, DocBlock["tone"]>> = { cover: "brand", stats: "dark", pricing: "tint", cta: "brand", quote: "tint", timeline: "light", schedule: "tint", parties: "tint" };
const PH: Record<string, string> = { eyebrow: "Small label", title: "Heading", body: "Write here…", "i.title": "Title", "i.text": "Text", "i.value": "Value" };

function productCard(p: ProposalProduct, v: Record<string, string>, kind: DocKind): string {
  const rows = p.rows.map((r) => `<tr><td>${esc([r.label, r.detail].filter(Boolean).join(" · "))}</td><td class="n">${esc(deckMoney(r.amount * (p.recurring && p.period === "monthly" ? 12 : 1)))}</td></tr>`).join("");
  const years = p.recurring ? p.termYears || 1 : 1;
  const terms = (p.terms ?? []).filter((t) => t.years > 0);
  const opts = terms.length > 1 ? `<div class="pc-opts">${terms.map((t, k) => `<div class="pc-opt rv d${k + 1}${Math.abs(t.years - years) < 0.01 ? " is-on" : ""}"><span>${esc(deckNum(t.years))} ${t.years === 1 ? "año" : "años"}</span><b>${esc(deckMoney(t.annual))}</b><i>/ año${t.discountPct ? ` · −${esc(deckNum(Math.round(t.discountPct * 10) / 10))}%` : ""}</i></div>`).join("")}</div>` : "";
  return `<div class="pc rv"><div class="pc-head"><div><span class="pc-k">${esc(p.tier || (p.recurring ? "Licencia" : "Producto"))}</span><b class="pc-n">${esc(p.name)}</b></div><div class="pc-price"><b>${esc(v["product.annual"] ?? "")}</b><i>${p.recurring ? "/ año" : ""}</i></div></div>${rows ? `<table class="pc-t"><tbody>${rows}${p.discount ? `<tr class="ds"><td>Descuento</td><td class="n">${esc(v["product.discount"] ?? "")}</td></tr>` : ""}</tbody></table>` : ""}<div class="pc-foot"><span>${p.recurring ? `Contrato de ${esc(String(years))} ${years === 1 ? "año" : "años"}` : "Pago único"}</span><b>${kind === "contract" ? "Total" : "Total contrato"} ${esc(deckMoney(p.total))}</b></div>${opts}</div>`;
}
function serviceCard(s: ProposalService): string {
  const roles = s.roles?.length ? s.roles : [];
  const ph = s.phases.length ? `<div class="sc-ph">${s.phases.map((f, k) => `<div class="sc-p rv d${(k % 4) + 1}"><span>${String(k + 1).padStart(2, "0")}</span><b>${esc(f.name)}</b><i>${esc(deckNum(f.days))} d</i></div>`).join("")}</div>` : "";
  return `<div class="pc sc rv"><div class="pc-head"><div><span class="pc-k">Servicio</span><b class="pc-n">${esc(s.name)}</b></div><div class="pc-price"><b>${esc(deckMoney(s.total))}</b><i>${esc(deckNum(s.days))} ${s.unit === "hour" ? "h" : "jornadas"}</i></div></div>${roles.length ? `<table class="pc-t"><tbody>${roles.map((r) => `<tr><td>${esc(r.name)} <i>· ${esc(deckNum(r.days))} × ${esc(deckMoney(r.rate))}</i></td><td class="n">${esc(deckMoney(r.days * r.rate))}</td></tr>`).join("")}${s.discount ? `<tr class="ds"><td>Descuento</td><td class="n">${esc(deckMoney(-s.discount))}</td></tr>` : ""}</tbody></table>` : ""}${ph}</div>`;
}
function pricingTable(d: ProposalData, kind: DocKind): string {
  const rows = [
    ...d.products.map((p) => ({ k: p.recurring ? "Licencia" : "Producto", n: p.name, x: p.recurring ? `${p.termYears || 1} ${(p.termYears || 1) === 1 ? "año" : "años"} · ${deckMoney(p.total / (p.termYears || 1))} / año` : p.tier ?? "", g: p.total + p.discount, t: p.total })),
    ...d.services.map((s) => ({ k: "Servicio", n: s.name, x: `${deckNum(s.days)} ${s.unit === "hour" ? "horas" : "jornadas"}`, g: s.total + s.discount, t: s.total })),
  ];
  const disc = rows.reduce((s, r) => s + (r.g - r.t), 0);
  return `<div class="pr rv"><table><thead><tr><th>Concepto</th><th class="n">Importe</th></tr></thead><tbody>${rows.map((r, k) => `<tr class="rv d${(k % 4) + 1}"><td><span class="pr-k">${esc(r.k)}</span><b>${esc(r.n)}</b>${r.x ? `<i>${esc(r.x)}</i>` : ""}</td><td class="n">${r.g !== r.t ? `<s>${esc(deckMoney(r.g))}</s>` : ""}${esc(deckMoney(r.t))}</td></tr>`).join("")}</tbody></table><div class="pr-tot">${disc > 0.5 ? `<div><span>Ahorro</span><b>${esc(deckMoney(-disc))}</b></div>` : ""}<div class="is-t"><span>${kind === "contract" ? "Importe total" : "Inversión total"}</span><b data-count="${Math.round(d.totals.total)}">${esc(deckMoney(d.totals.total))}</b></div><p>Impuestos no incluidos.</p></div></div>`;
}
function contractPricing(d: ProposalData, c: ContractTerms | null | undefined, terms: DocTemplate["terms"], lang: DocLang): string {
  const s = contractSchedule(d, c, terms);
  const L = lang === "es" ? ["Concepto", "Importe", "Licencia anual", "año 1", "Servicios profesionales", "precio cerrado", "Descuento", "Total del contrato", "Impuestos no incluidos.", "Precio de lista"] : ["Item", "Amount", "Yearly licence", "year 1", "Professional services", "fixed price", "Discount", "Contract total", "Taxes not included.", "List price"];
  const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(" · ");
  const disc = s.licList - s.lic1;
  return `<div class="pr rv"><table><thead><tr><th>${L[0]}</th><th class="n">${L[1]}</th></tr></thead><tbody>${d.products.length || s.lic1 ? `<tr><td><span class="pr-k">${L[2]} · ${L[3]}</span><b>${esc(names(d.products) || L[2])}</b><i>${esc(s.incText(lang))}${s.years > 1 ? ` · ${s.years} ${lang === "es" ? "años" : "years"}` : ""}</i></td><td class="n">${disc > 0.5 ? `<s>${esc(deckMoney(s.licList))}</s>` : ""}${esc(deckMoney(s.lic1))}</td></tr>` : ""}${disc > 0.5 ? `<tr><td><span class="pr-k">${L[6]}</span><b>${L[9]} ${esc(deckMoney(s.licList))}</b></td><td class="n">${esc(deckMoney(-disc))}</td></tr>` : ""}${s.svc ? `<tr><td><span class="pr-k">${L[4]} · ${L[5]}</span><b>${esc(names(d.services) || L[4])}</b></td><td class="n">${esc(deckMoney(s.svc))}</td></tr>` : ""}</tbody></table><div class="pr-tot"><div class="is-t"><span>${L[7]}</span><b data-count="${Math.round(s.total)}">${esc(deckMoney(s.total))}</b></div><p>${L[8]}</p></div></div>`;
}
function scheduleTable(d: ProposalData, c: ContractTerms | null | undefined, terms: DocTemplate["terms"], lang: DocLang): string {
  const s = contractSchedule(d, c, terms);
  const L = lang === "es" ? ["Año", "Licencia", "Servicios", "Total", "Total del contrato"] : ["Year", "Licence", "Services", "Total", "Contract total"];
  const max = Math.max(1, ...s.rows.map((r) => r.total));
  return `<div class="sd rv"><p class="sd-inc">${svg("spark")}${esc(s.incText(lang))}</p><div class="sd-bars">${s.rows.map((r, k) => `<div class="sd-b rv d${(k % 4) + 1}"><i style="--h:${Math.round((r.total / max) * 100)}%"><em style="--s:${Math.round((r.services / Math.max(1, r.total)) * 100)}%"></em></i><span>${L[0]} ${r.year}</span><b>${esc(deckMoney(r.total))}</b></div>`).join("")}</div><table><thead><tr><th>${L[0]}</th><th class="n">${L[1]}</th><th class="n">${L[2]}</th><th class="n">${L[3]}</th></tr></thead><tbody>${s.rows.map((r) => `<tr><td>${L[0]} ${r.year}</td><td class="n">${esc(deckMoney(r.license))}</td><td class="n">${r.services ? esc(deckMoney(r.services)) : "—"}</td><td class="n"><b>${esc(deckMoney(r.total))}</b></td></tr>`).join("")}</tbody><tfoot><tr><td colspan="3">${L[4]}</td><td class="n"><b>${esc(deckMoney(s.total))}</b></td></tr></tfoot></table></div>`;
}

const DOC_JS = `(function(){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);var c=e.target.querySelectorAll('[data-count]');c.forEach(count)}})},{threshold:.12,rootMargin:'0px 0px -6% 0px'});document.querySelectorAll('.rv').forEach(function(el){io.observe(el)});
function count(el){var to=+el.getAttribute('data-count');if(!to||el._c)return;el._c=1;var txt=el.textContent,t0=performance.now(),d=1400;function f(t){var k=Math.min(1,(t-t0)/d),v=Math.round(to*(1-Math.pow(1-k,3)));el.textContent=v.toLocaleString('es-ES')+' €';if(k<1)requestAnimationFrame(f);else el.textContent=txt}requestAnimationFrame(f)}
document.querySelectorAll('.st-v').forEach(function(el){var m=/^([^0-9]*)([0-9][0-9.,]*)(.*)$/.exec(el.textContent.trim());if(!m)return;var n=parseFloat(m[2].replace(/\\./g,'').replace(',','.'));if(!isFinite(n))return;var o=new IntersectionObserver(function(es){if(!es[0].isIntersecting)return;o.disconnect();var t0=performance.now(),dec=(m[2].split(',')[1]||'').length;function f(t){var k=Math.min(1,(t-t0)/1300),v=n*(1-Math.pow(1-k,3));el.textContent=m[1]+v.toLocaleString('es-ES',{minimumFractionDigits:dec,maximumFractionDigits:dec})+m[3];if(k<1)requestAnimationFrame(f)}requestAnimationFrame(f)});o.observe(el)});
var bar=document.querySelector('.dp-progress i'),dots=[].slice.call(document.querySelectorAll('.dp-dots a')),secs=dots.map(function(a){return document.querySelector(a.getAttribute('href'))});
function onS(){var h=document.documentElement,p=h.scrollTop/(h.scrollHeight-h.clientHeight||1);if(bar)bar.style.transform='scaleX('+p+')';var cur=0;secs.forEach(function(s,i){if(s&&s.getBoundingClientRect().top<innerHeight*.45)cur=i});dots.forEach(function(d,i){d.classList.toggle('is-on',i===cur)})}addEventListener('scroll',onS,{passive:true});onS();
document.addEventListener('pointermove',function(e){var c=document.querySelector('.t-cover');if(!c)return;var r=c.getBoundingClientRect();if(e.clientY>r.bottom)return;c.style.setProperty('--mx',((e.clientX/innerWidth)-.5).toFixed(3));c.style.setProperty('--my',(((e.clientY-r.top)/r.height)-.5).toFixed(3))});
document.querySelectorAll('.cd,.pc,.tm,.st').forEach(function(el){el.addEventListener('pointermove',function(e){var r=el.getBoundingClientRect();el.style.setProperty('--gx',(e.clientX-r.left)+'px');el.style.setProperty('--gy',(e.clientY-r.top)+'px')})});})();`;

const PRINT_CSS = `.dp-progress,.dp-dots,.cv-down,.dx-tools,.dx-ins,.dx-it-add,.dx-it-del{display:none!important}.rv{opacity:1!important;transform:none!important;transition:none!important}.cv-o{animation:none}body{font-size:13.5px}.blk{padding:46px 0;break-inside:auto}.wrap{width:calc(100% - 28mm)}.t-cover{height:297mm;min-height:0;break-after:page}.t-cover .cv-in{min-height:297mm;width:calc(100% - 28mm)}.cv-t{font-size:56px}.h2{font-size:32px}.lead{font-size:16px}.pc,.pr,.sd,.cd,.tl-i,.tm,.pt,.tr li,.cl-l li,.st,.sg-grid,.sh,table,.qt,.ct{break-inside:avoid}.sh,.h2,.eb,.tx-copy>.h2{break-after:avoid;page-break-after:avoid}.sh+*,.h2+*{break-before:avoid;page-break-before:avoid}.st-v{font-size:40px}.pr-tot .is-t b{font-size:34px}.cd:hover,.pc:hover,.tm:hover,.tl-i:hover{transform:none}.sd-b i{transform:none!important}body.k-contract .t-cover,body.k-contract .t-cover .cv-in{height:auto;min-height:150mm;break-after:auto}`;
/** Prefixes every selector of a flat stylesheet ("body" becomes the scope itself). */
function scopeCss(css: string, scope: string): string {
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (_m, sel: string, decl: string) => `${sel.split(",").map((x) => { x = x.trim(); return x === "body" ? scope : x.startsWith("body") ? scope + x.slice(4) : `${scope} ${x}`; }).join(",")}{${decl}}`);
}
const DOC_CSS = `
*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}body{font-family:var(--bf);color:var(--ink);background:var(--paper);font-size:17px;line-height:1.62;-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
img{max-width:100%;display:block}a{color:inherit}
.blk{position:relative;padding:112px 0;overflow:hidden}.wrap{width:min(1080px,calc(100% - 64px));margin:0 auto;position:relative}
.tone-tint{background:color-mix(in srgb,var(--p) 6%,var(--paper))}.tone-dark{background:var(--ink);color:#fff}.tone-brand{background:linear-gradient(135deg,var(--p),color-mix(in srgb,var(--p) 55%,var(--ink)));color:#fff}
.tone-dark .lead,.tone-brand .lead,.tone-dark .rt,.tone-brand .rt{color:rgba(255,255,255,.82)}
h1,h2,h3,.h2{font-family:var(--hf);font-weight:var(--hw);letter-spacing:-.02em;line-height:1.12}
.eb{display:inline-flex;align-items:center;gap:10px;font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--a);margin-bottom:16px}.eb:before{content:"";width:28px;height:2px;background:currentColor;border-radius:2px}
.tone-dark .eb,.tone-brand .eb{color:color-mix(in srgb,var(--a) 70%,#fff)}
.h2{font-size:clamp(32px,4.2vw,52px);margin-bottom:20px;max-width:880px;line-height:calc(1.1*var(--hs))}.sh{margin-bottom:52px}.sh.c{text-align:center}.sh.c .h2,.sh.c .lead{margin-left:auto;margin-right:auto}.sh.c .eb{justify-content:center}
.lead{font-size:20px;color:var(--mut);max-width:760px}.rt p+p,.rt p+ul,.rt ul+p{margin-top:14px}.rt ul,.rt ol{padding-left:22px}.rt li{margin:6px 0}.rt li::marker{color:var(--a)}.rt b,.rt strong{color:inherit;font-weight:700}.rt a{color:var(--a)}
.rv{opacity:0;transform:translateY(26px);transition:opacity .8s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1)}.rv.in{opacity:1;transform:none}.d2{transition-delay:.08s}.d3{transition-delay:.16s}.d4{transition-delay:.24s}
.dm-edit .rv,.dm-print .rv{opacity:1;transform:none;transition:none}
/* cover */
.t-cover{min-height:100vh;display:flex;padding:0;color:#fff}.cv-bg{position:absolute;inset:0;overflow:hidden}.cv-img{position:absolute;inset:-4%;background-size:cover;background-position:center;opacity:.32;transform:translate(calc(var(--mx,0)*-18px),calc(var(--my,0)*-18px)) scale(1.04);transition:transform .6s ease-out;mix-blend-mode:luminosity}
.cv-o{position:absolute;border-radius:50%;filter:blur(2px);opacity:.55;transition:transform .9s cubic-bezier(.2,.7,.2,1)}.o1{width:620px;height:620px;right:-160px;top:-180px;background:radial-gradient(circle at 30% 30%,color-mix(in srgb,var(--a) 85%,#fff),transparent 70%);transform:translate(calc(var(--mx,0)*40px),calc(var(--my,0)*40px));animation:fl 14s ease-in-out infinite}
.o2{width:380px;height:380px;left:-120px;bottom:-140px;background:radial-gradient(circle,color-mix(in srgb,var(--a) 60%,transparent),transparent 70%);transform:translate(calc(var(--mx,0)*-30px),calc(var(--my,0)*-30px));animation:fl 18s ease-in-out infinite reverse}.o3{width:160px;height:160px;right:22%;bottom:18%;border:1.5px solid rgba(255,255,255,.35);background:none;filter:none;animation:sp 30s linear infinite}
.cv-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px);background-size:64px 64px;mask-image:radial-gradient(ellipse at 70% 30%,#000 10%,transparent 70%)}
@keyframes fl{50%{margin-top:40px;margin-left:-20px}}@keyframes sp{to{transform:rotate(360deg)}}
.cv-in{position:relative;z-index:1;width:min(1080px,calc(100% - 64px));margin:0 auto;display:flex;flex-direction:column;justify-content:space-between;padding:56px 0 64px;min-height:100vh}
.cv-top{display:flex;align-items:center;justify-content:space-between;gap:20px}.cv-logo{max-height:46px;max-width:220px;object-fit:contain}.cv-brand{font-family:var(--hf);font-size:22px;letter-spacing:-.01em}.cv-eb{font-size:13px;letter-spacing:.16em;text-transform:uppercase;font-weight:700;padding:8px 14px;border:1px solid rgba(255,255,255,.35);border-radius:999px;backdrop-filter:blur(6px)}
.cv-mid{max-width:900px;animation:cvIn 1.1s cubic-bezier(.2,.7,.2,1) both}.cv-t{font-size:clamp(46px,7vw,96px);line-height:calc(1.02*var(--hs));letter-spacing:-.035em;margin-bottom:24px}.cv-sub{font-size:22px;color:rgba(255,255,255,.82);max-width:640px}
@keyframes cvIn{from{opacity:0;transform:translateY(40px)}}.dm-edit .cv-mid{animation:none}
.cv-foot{display:flex;flex-wrap:wrap;gap:12px 44px;padding-top:28px;border-top:1px solid rgba(255,255,255,.22)}.cv-meta{position:relative}.cv-k{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.6);font-weight:600}.cv-v{font-size:18px;font-weight:600}
.cv-down{position:absolute;left:50%;bottom:26px;z-index:2;width:44px;height:44px;margin-left:-22px;border-radius:50%;border:1px solid rgba(255,255,255,.4);display:grid;place-items:center;animation:bob 2.2s ease-in-out infinite}.cv-down .ic{width:18px;height:18px}@keyframes bob{50%{transform:translateY(8px)}}
/* text */
.tx{display:grid;grid-template-columns:1fr;gap:56px;align-items:center}.tx.has-img{grid-template-columns:1.05fr .95fr}.tx.lay-left.has-img .tx-img{order:-1}.tx.lay-center{text-align:center}.tx.lay-center .h2,.tx.lay-center .rt{margin-left:auto;margin-right:auto}.tx .rt{font-size:18px;max-width:720px;color:color-mix(in srgb,var(--ink) 82%,var(--paper))}
.tone-dark .tx .rt,.tone-brand .tx .rt{color:rgba(255,255,255,.85)}.tx-img{border-radius:calc(var(--r) + 6px);overflow:hidden;box-shadow:0 30px 60px -30px rgba(0,0,0,.35);transform:rotate(-1deg)}.tx-img img{width:100%;height:100%;object-fit:cover;aspect-ratio:4/3;transition:transform 1.2s ease}.tx-img:hover img{transform:scale(1.05)}
/* stats */
.st-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px}.st{position:relative;padding:30px 28px;border-radius:var(--r);background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);overflow:hidden}.tone-light .st,.tone-tint .st{background:#fff;border-color:color-mix(in srgb,var(--p) 14%,transparent)}
.st:before{content:"";position:absolute;inset:0;background:radial-gradient(240px circle at var(--gx,-200px) var(--gy,-200px),color-mix(in srgb,var(--a) 22%,transparent),transparent 60%);pointer-events:none}
.st-v{font-family:var(--hf);font-size:clamp(40px,5vw,60px);font-weight:var(--hw);color:var(--a);line-height:1;letter-spacing:-.03em}.st-t{margin-top:12px;font-weight:700}.st-x{font-size:14.5px;opacity:.7;margin-top:4px}
/* cards */
.cd-grid{display:grid;gap:20px}.cd-grid.n1{grid-template-columns:1fr}.cd-grid.n2{grid-template-columns:repeat(2,1fr)}.cd-grid.n3{grid-template-columns:repeat(3,1fr)}.cd-grid.n4{grid-template-columns:repeat(4,1fr)}.cd-grid.sm{margin-top:24px}
.cd{position:relative;padding:30px 28px 32px;border-radius:var(--r);background:#fff;border:1px solid color-mix(in srgb,var(--ink) 9%,transparent);transition:transform .35s cubic-bezier(.2,.7,.2,1),box-shadow .35s,border-color .35s;overflow:hidden}
.cd:before{content:"";position:absolute;inset:0;background:radial-gradient(300px circle at var(--gx,-300px) var(--gy,-300px),color-mix(in srgb,var(--a) 12%,transparent),transparent 60%);pointer-events:none}
.cd:hover{transform:translateY(-6px);box-shadow:0 26px 50px -28px color-mix(in srgb,var(--p) 60%,transparent);border-color:color-mix(in srgb,var(--a) 45%,transparent)}
.tone-dark .cd,.tone-brand .cd{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14);color:#fff}
.cd-n{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:12px;background:color-mix(in srgb,var(--a) 14%,transparent);color:var(--p);font-weight:800;font-family:var(--hf);margin-bottom:20px}.tone-dark .cd-n,.tone-brand .cd-n{color:#fff}
.cd-img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:calc(var(--r) - 4px);margin-bottom:18px}.cd-t{font-size:20px;margin-bottom:8px}.cd-x{font-size:15.5px;color:var(--mut)}.tone-dark .cd-x,.tone-brand .cd-x{color:rgba(255,255,255,.75)}
/* product / service */
.pc{border-radius:calc(var(--r) + 4px);background:#fff;border:1px solid color-mix(in srgb,var(--ink) 10%,transparent);box-shadow:0 30px 70px -40px color-mix(in srgb,var(--p) 55%,transparent);overflow:hidden;transition:transform .4s cubic-bezier(.2,.7,.2,1)}.pc:hover{transform:translateY(-4px)}
.pc-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;padding:30px 32px;background:linear-gradient(120deg,color-mix(in srgb,var(--p) 8%,#fff),#fff)}.pc-k{display:block;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--a)}.pc-n{font-family:var(--hf);font-size:28px;letter-spacing:-.02em;color:var(--ink)}
.pc-price{text-align:right;color:var(--ink)}.pc-price b{font-family:var(--hf);font-size:36px;letter-spacing:-.03em;color:var(--p)}.pc-price i{display:block;font-style:normal;font-size:13px;color:var(--mut)}
.pc-t{width:100%;border-collapse:collapse;color:var(--ink)}.pc-t td{padding:14px 32px;border-top:1px solid color-mix(in srgb,var(--ink) 7%,transparent);font-size:15.5px}.pc-t td i{color:var(--mut);font-style:normal}.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.pc-t .ds td{color:var(--a);font-weight:600}
.pc-foot{display:flex;justify-content:space-between;gap:16px;padding:18px 32px;background:color-mix(in srgb,var(--p) 5%,#fff);font-size:14.5px;color:var(--mut)}.pc-foot b{color:var(--ink)}
.pc-opts{display:flex;gap:14px;padding:0 32px 30px;flex-wrap:wrap;background:color-mix(in srgb,var(--p) 5%,#fff)}.pc-opt{flex:1;min-width:150px;padding:16px 18px;border-radius:var(--r);border:1.5px solid color-mix(in srgb,var(--ink) 10%,transparent);background:#fff;color:var(--ink)}.pc-opt.is-on{border-color:var(--a);box-shadow:0 0 0 4px color-mix(in srgb,var(--a) 15%,transparent)}.pc-opt span{display:block;font-size:13px;color:var(--mut)}.pc-opt b{font-size:22px;font-family:var(--hf)}.pc-opt i{font-style:normal;font-size:13px;color:var(--mut);margin-left:4px}
.sc-ph{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:color-mix(in srgb,var(--ink) 7%,transparent);border-top:1px solid color-mix(in srgb,var(--ink) 7%,transparent)}.sc-p{background:#fff;padding:18px 20px;color:var(--ink)}.sc-p span{font-size:12px;font-weight:800;color:var(--a)}.sc-p b{display:block;font-size:15px;margin:2px 0}.sc-p i{font-style:normal;font-size:13px;color:var(--mut)}
/* pricing */
.pr{border-radius:calc(var(--r) + 4px);background:#fff;border:1px solid color-mix(in srgb,var(--ink) 9%,transparent);overflow:hidden;box-shadow:0 40px 80px -50px color-mix(in srgb,var(--p) 60%,transparent);color:var(--ink)}.pr table{width:100%;border-collapse:collapse}
.pr th{text-align:left;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);padding:18px 32px;border-bottom:1px solid color-mix(in srgb,var(--ink) 8%,transparent)}.pr th.n{text-align:right}
.pr td{padding:20px 32px;border-bottom:1px solid color-mix(in srgb,var(--ink) 6%,transparent);vertical-align:top}.pr td b{display:block;font-size:18px}.pr td i{font-style:normal;font-size:14px;color:var(--mut)}.pr-k{font-size:11.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--a)}.pr td.n{font-size:18px;font-weight:700}.pr td s{display:block;font-size:13px;font-weight:500;color:var(--mut)}
.pr-tot{padding:26px 32px;background:linear-gradient(120deg,var(--p),color-mix(in srgb,var(--p) 60%,var(--ink)));color:#fff}.pr-tot div{display:flex;justify-content:space-between;align-items:baseline;gap:20px}.pr-tot div+div{margin-top:8px}.pr-tot .is-t span{font-size:15px;opacity:.85}.pr-tot .is-t b{font-family:var(--hf);font-size:clamp(34px,4.6vw,52px);letter-spacing:-.03em}.pr-tot p{font-size:13px;opacity:.7;margin-top:6px}
/* timeline */
.tl{list-style:none;position:relative;display:grid;gap:18px;padding-left:34px}.tl:before{content:"";position:absolute;left:13px;top:8px;bottom:8px;width:2px;background:linear-gradient(var(--a),color-mix(in srgb,var(--a) 10%,transparent))}
.tl-i{position:relative;padding:20px 24px;border-radius:var(--r);background:#fff;border:1px solid color-mix(in srgb,var(--ink) 8%,transparent);transition:transform .3s,box-shadow .3s}.tl-i:hover{transform:translateX(6px);box-shadow:0 20px 40px -28px color-mix(in srgb,var(--p) 55%,transparent)}
.tl-dot{position:absolute;left:-34px;top:20px;width:28px;height:28px;border-radius:50%;background:var(--a);color:#fff;font-size:12px;font-weight:800;display:grid;place-items:center;box-shadow:0 0 0 6px color-mix(in srgb,var(--a) 18%,var(--paper))}
.tl-d{font-size:12.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--a)}.tl-t{font-size:19px;margin:2px 0 6px;color:var(--ink)}.tl-x{font-size:15px;color:var(--mut);padding-left:18px}.tl-x li{margin:2px 0}
/* team */
.tm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:22px}.tm{position:relative;text-align:center;padding:28px 22px;border-radius:var(--r);background:#fff;border:1px solid color-mix(in srgb,var(--ink) 8%,transparent);transition:transform .35s}.tm:hover{transform:translateY(-6px)}
.tm-ph{width:96px;height:96px;border-radius:50%;object-fit:cover;margin:0 auto 16px;box-shadow:0 0 0 5px color-mix(in srgb,var(--a) 20%,transparent)}.tm-in{display:grid;place-items:center;background:linear-gradient(135deg,var(--p),var(--a));color:#fff;font-weight:800;font-size:28px;font-family:var(--hf)}.tm-t{font-size:18px;color:var(--ink)}.tm-r{font-size:13px;font-weight:700;color:var(--a);letter-spacing:.04em;margin:2px 0 8px}.tm-x{font-size:14.5px;color:var(--mut)}
/* quote */
.qt{max-width:880px;text-align:center}.qt-m{display:block;font-family:Georgia,serif;font-size:140px;line-height:.6;color:var(--a);opacity:.5}.qt-x{font-family:var(--hf);font-size:clamp(24px,3vw,34px);line-height:1.35;letter-spacing:-.015em}.qt-by{display:flex;justify-content:center;align-items:center;gap:14px;margin-top:28px;text-align:left}.qt-ph{width:56px;height:56px;border-radius:50%;object-fit:cover}.qt-t{font-weight:700}.qt-r{font-size:14px;color:var(--mut)}
/* image */
.im img{width:100%;border-radius:calc(var(--r) + 6px);box-shadow:0 40px 80px -50px rgba(0,0,0,.4)}.im-c{text-align:center;font-size:14.5px;color:var(--mut);margin-top:14px}
/* terms */
.tr{list-style:none;display:grid;grid-template-columns:repeat(2,1fr);gap:14px 28px}.tr li{position:relative;display:flex;gap:14px;padding:18px 20px;border-radius:var(--r);background:#fff;border:1px solid color-mix(in srgb,var(--ink) 8%,transparent)}.tr .ic{flex:none;width:22px;height:22px;padding:4px;border-radius:50%;background:var(--a);color:#fff;margin-top:2px}.tr-t{font-weight:700}.tr-x{font-size:15px;color:var(--mut)}
/* closing */
.ct{text-align:center;max-width:820px}.ct .eb{justify-content:center}.ct-t{font-size:clamp(38px,5.2vw,64px);margin-bottom:18px}.ct-x{font-size:20px;color:rgba(255,255,255,.85)}.tone-light .ct-x,.tone-tint .ct-x{color:var(--mut)}
.ct-card{display:inline-flex;align-items:center;gap:18px;margin-top:40px;padding:18px 26px 18px 18px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);text-align:left;backdrop-filter:blur(8px)}.tone-light .ct-card,.tone-tint .ct-card{background:#fff;border-color:color-mix(in srgb,var(--ink) 10%,transparent)}
.ct-av{width:52px;height:52px;border-radius:50%;background:#fff;color:var(--p);display:grid;place-items:center;font-weight:800;font-size:18px}.ct-card b{display:block;font-size:17px}.ct-card a{display:flex;align-items:center;gap:8px;font-size:14.5px;text-decoration:none;opacity:.9}.ct-card a:hover{opacity:1;text-decoration:underline}.ct-card .ic{width:15px;height:15px}
/* contract */
.pt-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.pt{display:flex;flex-direction:column;gap:6px;padding:28px;border-radius:var(--r);background:#fff;border:1px solid color-mix(in srgb,var(--ink) 9%,transparent)}.pt-k{font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;color:var(--a)}.pt-n{font-family:var(--hf);font-size:22px;margin-bottom:6px}.pt span i{display:inline-block;min-width:90px;font-style:normal;color:var(--mut);font-size:13px;text-transform:uppercase;letter-spacing:.06em}
.cl-l{list-style:none;display:grid;gap:4px}.cl-l li{position:relative;display:grid;grid-template-columns:48px 1fr;gap:16px;padding:22px 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 8%,transparent)}.cl-n{width:36px;height:36px;border-radius:10px;background:color-mix(in srgb,var(--p) 10%,transparent);color:var(--p);font-weight:800;display:grid;place-items:center;font-family:var(--hf)}.cl-t{font-size:19px;margin-bottom:6px}.cl-x{font-size:15.5px;color:color-mix(in srgb,var(--ink) 80%,var(--paper))}
.sd{border-radius:calc(var(--r) + 4px);background:#fff;border:1px solid color-mix(in srgb,var(--ink) 9%,transparent);overflow:hidden;color:var(--ink)}.sd-inc{display:flex;align-items:center;gap:10px;padding:18px 28px;font-weight:600;color:var(--p);background:color-mix(in srgb,var(--a) 8%,#fff)}.sd-inc .ic{width:18px;height:18px;color:var(--a)}
.sd-bars{display:flex;align-items:flex-end;gap:16px;height:220px;padding:24px 28px 0}.sd-b{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:6px}.sd-b i{position:relative;width:100%;max-width:90px;height:var(--h);min-height:6px;border-radius:10px 10px 4px 4px;background:linear-gradient(var(--a),var(--p));overflow:hidden;transform-origin:bottom;transition:transform 1s cubic-bezier(.2,.7,.2,1)}.sd-b i em{position:absolute;left:0;right:0;top:0;height:var(--s);background:color-mix(in srgb,#fff 35%,transparent)}.dm-view .sd-b:not(.in) i{transform:scaleY(.05)}.sd-b span{font-size:12.5px;color:var(--mut);font-weight:600}.sd-b b{font-size:14px}
.sd table{width:100%;border-collapse:collapse;margin-top:18px}.sd th{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);text-align:left;padding:12px 28px;border-bottom:1px solid color-mix(in srgb,var(--ink) 8%,transparent)}.sd th.n{text-align:right}.sd td{padding:13px 28px;border-bottom:1px solid color-mix(in srgb,var(--ink) 6%,transparent)}.sd tfoot td{font-weight:700;background:color-mix(in srgb,var(--p) 6%,#fff);border:0;font-size:17px}
.sg-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}.sg-k{font-weight:700;font-size:15px}.sg-line{height:90px;border-bottom:1.5px solid var(--ink)}.sg-line.s{height:36px}.sg-l{font-size:12.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em}.sg-x{color:var(--mut)}
.k-contract .blk{padding:80px 0}.k-contract .t-cover{min-height:78vh}.k-contract .t-cover .cv-in{min-height:78vh}
/* sharp / bold */
.st-sharp .h2{font-weight:600;letter-spacing:-.01em}.st-sharp .eb:before{width:40px;height:1px}.st-sharp .cd,.st-sharp .pc{box-shadow:none}.st-bold .h2{text-transform:none;letter-spacing:-.04em}.st-bold .cv-t{text-transform:uppercase}
/* nav */
.dp-progress{position:fixed;top:0;left:0;right:0;height:3px;z-index:50}.dp-progress i{display:block;height:100%;background:linear-gradient(90deg,var(--a),var(--p));transform-origin:left;transform:scaleX(0)}
.dp-dots{position:fixed;right:20px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:12px;z-index:50}.dp-dots a{width:14px;height:14px;display:grid;place-items:center}.dp-dots i{width:7px;height:7px;border-radius:50%;background:color-mix(in srgb,var(--ink) 30%,transparent);box-shadow:0 0 0 2px rgba(255,255,255,.7);transition:all .3s}.dp-dots a.is-on i{width:11px;height:11px;background:var(--a)}
@media screen and (max-width:720px){${scopeCss(`.blk{padding:72px 0}.tx.has-img,.cd-grid.n2,.cd-grid.n3,.cd-grid.n4,.tr,.pt-grid,.sg-grid{grid-template-columns:1fr}.dp-dots{display:none}.pc-head{flex-direction:column;align-items:flex-start}.pc-price{text-align:left}.pr td,.pr th,.pc-t td{padding-left:18px;padding-right:18px}`, "body:not(.dm-print)")}}
@media (prefers-reduced-motion:reduce){.rv{opacity:1;transform:none;transition:none}.cv-o,.cv-down{animation:none}}
/* print */
@page{size:A4;margin:0}
.dm-print .blk,.dm-print .t-cover{min-height:0}
@media print{${PRINT_CSS}}
${scopeCss(PRINT_CSS, "body.dm-print")}
.dm-print .t-cover{height:1123px}.dm-print .t-cover .cv-in{min-height:1123px}.dm-print .cv-o{animation:none}.dm-print.k-contract .t-cover,.dm-print.k-contract .t-cover .cv-in{height:auto;min-height:600px}
/* editor */
.dm-edit .ed{outline:none;border-radius:4px;transition:box-shadow .15s,background .15s;min-width:20px}.dm-edit .ed:hover{box-shadow:0 0 0 1.5px color-mix(in srgb,var(--a) 55%,transparent)}.dm-edit .ed:focus{box-shadow:0 0 0 2px var(--a);background:color-mix(in srgb,var(--a) 6%,transparent)}
.dm-edit .ed:empty:before{content:attr(data-ph);opacity:.4;font-style:italic;width:auto;height:auto;background:none;letter-spacing:normal;text-transform:none}.dm-edit .eb.ed:empty{min-width:120px}
.tk{display:inline-flex;align-items:center;padding:0 7px;margin:0 1px;border-radius:7px;background:color-mix(in srgb,var(--a) 16%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--a) 45%,transparent);font-size:.92em;line-height:1.45;white-space:nowrap;cursor:default;vertical-align:baseline;user-select:all}.tk.is-label{font-family:var(--bf);font-size:.62em;font-weight:700;letter-spacing:.01em;padding:2px 9px;text-transform:none;color:inherit;vertical-align:.12em;line-height:1.5;border-radius:99px}.tk.is-label:before{content:'{ }';opacity:.55;margin-right:5px;font-weight:800}.tk.is-empty{opacity:.65;font-style:italic}.tk.is-cond{font-size:.62em;font-family:ui-monospace,Menlo,monospace;background:#fff3cf;color:#8a6100;box-shadow:inset 0 0 0 1px #f0c860}.tk.is-flash{animation:tkf 1.4s ease 2}@keyframes tkf{50%{background:var(--a);color:#fff}}
.dm-edit .blk{transition:box-shadow .2s}.dm-edit .blk:hover{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--a) 35%,transparent)}.dm-edit .blk.is-sel{box-shadow:inset 0 0 0 3px var(--a)}.dm-edit .blk.is-hidden>*:not(.dx-tools):not(.dx-ins){opacity:.35;filter:grayscale(1)}
.dx-tools{position:absolute;top:14px;right:14px;z-index:20;display:flex;align-items:center;gap:2px;padding:4px;border-radius:12px;background:#0d1f18;box-shadow:0 10px 30px -10px rgba(0,0,0,.5);opacity:0;transform:translateY(-6px);transition:opacity .2s,transform .2s;font:600 12px/1 system-ui,sans-serif;color:#fff}
.dm-edit .blk:hover>.dx-tools,.dm-edit .blk.is-sel>.dx-tools{opacity:1;transform:none}.dx-tl{padding:0 10px 0 8px;opacity:.75;white-space:nowrap}.dx-tools button{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:#fff;cursor:pointer;font-size:14px}.dx-tools button:hover{background:rgba(255,255,255,.14)}.dx-tools .is-del:hover{background:#d9534f}
.dx-ins{position:absolute;left:50%;bottom:-15px;z-index:21;width:30px;height:30px;margin-left:-15px;border-radius:50%;border:0;background:var(--a);color:#fff;font:700 18px/1 system-ui;cursor:pointer;opacity:0;transform:scale(.6);transition:opacity .2s,transform .2s;box-shadow:0 6px 18px -6px rgba(0,0,0,.4)}.dm-edit .blk:hover>.dx-ins{opacity:1;transform:none}
.dx-it-del{position:absolute;top:8px;right:8px;width:24px;height:24px;border-radius:50%;border:0;background:#0d1f18;color:#fff;cursor:pointer;opacity:0;transition:opacity .2s;font:600 14px/1 system-ui;z-index:3}.dm-edit *:hover>.dx-it-del{opacity:.85}
.dx-it-add{align-self:center;justify-self:start;margin-top:10px;padding:10px 16px;border-radius:999px;border:1.5px dashed color-mix(in srgb,var(--a) 70%,transparent);background:transparent;color:inherit;font:600 13px system-ui,sans-serif;cursor:pointer;opacity:.6;transition:opacity .2s}.dx-it-add:hover{opacity:1}
.dx-note{padding:18px 22px;border-radius:12px;border:1.5px dashed color-mix(in srgb,var(--a) 50%,transparent);color:var(--mut);font-size:14.5px;list-style:none}
.dx-drop{display:grid;place-items:center;min-height:260px;border-radius:18px;border:2px dashed color-mix(in srgb,var(--a) 60%,transparent);color:var(--mut);cursor:pointer;font-size:15px}
.dm-edit .blk.is-drop{box-shadow:inset 0 0 0 3px var(--a),inset 0 0 0 9999px color-mix(in srgb,var(--a) 10%,transparent)}
`;

// --------------------------------------------------- default templates -----
const it = (title = "", text = "", value = ""): DocItem => ({ id: rid(), title, text, value });
export const DEFAULT_DOC_THEME: DocTheme = { primary: "#0A6F4D", accent: "#12B57F", ink: "#0B241A", paper: "#FBFDFC", muted: "#5A7D6D", headingFont: "Plus Jakarta Sans", bodyFont: "Inter", style: "soft" };
/** A ready-to-use template: good copy with variables in place. */
export function defaultDocTemplate(kind: DocKind, lang: DocLang = "es", theme: DocTheme = DEFAULT_DOC_THEME): DocTemplate {
  const es = lang === "es";
  const B = (type: DocBlockType, x: Partial<DocBlock> = {}): DocBlock => ({ id: rid(), type, ...x });
  if (kind === "contract") return {
    name: es ? "Contrato de licencia y servicios" : "Licence and services agreement", kind, lang, sectors: [], theme,
    terms: { paymentDays: 30, validityDays: 30, annualIncreasePct: 3 },
    blocks: [
      B("cover", { eyebrow: es ? "Contrato" : "Agreement", title: es ? "Contrato de licencia y servicios" : "Licence and services agreement", body: es ? "<p>{{provider.legal}} y {{client.legal}}</p>" : "<p>{{provider.legal}} and {{client.legal}}</p>", items: [it(es ? "Firma" : "Signed", "{{contract.sign_date}}"), it(es ? "Inicio" : "Start", "{{contract.start}}"), it(es ? "Duración" : "Term", es ? "{{contract.years}} años" : "{{contract.years}} years")] }),
      B("parties", { eyebrow: es ? "Reunidos" : "Parties", title: es ? "Las partes" : "The parties", body: es ? "<p>Ambas partes se reconocen capacidad suficiente para obligarse y, a tal efecto,</p>" : "<p>Both parties acknowledge they have capacity to enter into this agreement and</p>" }),
      B("clauses", { eyebrow: es ? "Cláusulas" : "Clauses", title: es ? "Acuerdan" : "They agree", items: es ? [
        it("Objeto", "<p>{{provider.legal}} concede a {{client.legal}} una licencia de uso de su software y prestará los servicios profesionales descritos en el anexo económico de este contrato.</p>"),
        it("Duración", "<p>El contrato entra en vigor el {{contract.start}} y se extiende durante {{contract.years}} años, hasta el {{contract.end}}. A su término se renovará por periodos anuales salvo preaviso escrito de tres meses.</p>"),
        it("Precio y actualización", "<p>La licencia asciende a {{contract.license.final}} el primer año. {{contract.increment}}. Los servicios profesionales tienen un precio cerrado de {{contract.services.final}}.</p>"),
        it("Facturación y pago", "<p>La licencia se factura anualmente por adelantado y los servicios a la firma. Las facturas se abonarán a {{terms.payment_days}} días. Impuestos no incluidos.</p>"),
        it("Confidencialidad", "<p>Las partes guardarán secreto sobre la información de la otra a la que tengan acceso con motivo de este contrato, durante su vigencia y los tres años siguientes.</p>"),
        it("Protección de datos", "<p>{{provider.name}} tratará los datos personales por cuenta de {{client}} únicamente para prestar el servicio, conforme al RGPD y al acuerdo de encargo de tratamiento anexo.</p>"),
        it("Propiedad intelectual", "<p>El software y su documentación son propiedad de {{provider.legal}}. Los datos del cliente son y seguirán siendo de {{client.legal}}.</p>"),
        it("Responsabilidad", "<p>La responsabilidad de cada parte queda limitada al importe abonado en los doce meses anteriores al hecho que la origine, salvo dolo o culpa grave.</p>"),
        it("Ley y jurisdicción", "<p>Este contrato se rige por la ley española. Las partes se someten a los juzgados y tribunales de {{provider.city}}.</p>"),
      ] : [
        it("Purpose", "<p>{{provider.legal}} grants {{client.legal}} a licence to use its software and will provide the professional services described in the commercial annex.</p>"),
        it("Term", "<p>This agreement starts on {{contract.start}} and lasts {{contract.years}} years, until {{contract.end}}. It renews yearly unless either party gives three months' written notice.</p>"),
        it("Price", "<p>The licence is {{contract.license.final}} in the first year. {{contract.increment}}. Professional services have a fixed price of {{contract.services.final}}.</p>"),
        it("Invoicing", "<p>The licence is invoiced yearly in advance and services on signature. Invoices are payable within {{terms.payment_days}} days. Taxes not included.</p>"),
        it("Confidentiality", "<p>Each party keeps the other's information confidential during the agreement and three years after.</p>"),
        it("Governing law", "<p>This agreement is governed by Spanish law; the courts of {{provider.city}} have jurisdiction.</p>"),
      ] }),
      B("pricing", { eyebrow: es ? "Anexo económico" : "Commercial annex", title: es ? "Condiciones económicas" : "Commercial terms" }),
      B("schedule", { eyebrow: es ? "Calendario" : "Schedule", title: es ? "Importe año a año" : "Year by year", body: es ? "<p>Licencia anual con su actualización y servicios en el primer año.</p>" : "<p>Yearly licence with its increase and services in the first year.</p>" }),
      B("signature", { title: es ? "Y en prueba de conformidad" : "In witness whereof", body: es ? "<p>Firman el presente contrato en {{provider.city}}, a {{contract.sign_date}}.</p>" : "<p>Signed in {{provider.city}} on {{contract.sign_date}}.</p>" }),
    ],
  };
  return {
    name: es ? "Propuesta comercial" : "Commercial proposal", kind, lang, sectors: [], theme,
    terms: { paymentDays: 30, validityDays: 30, annualIncreasePct: 3 },
    blocks: [
      B("cover", { eyebrow: es ? "Propuesta" : "Proposal", title: es ? "Una propuesta para {{client}}" : "A proposal for {{client}}", body: es ? "<p>{{deal}}</p>" : "<p>{{deal}}</p>", items: [it(es ? "Preparado para" : "Prepared for", "{{client.contact}}"), it(es ? "Fecha" : "Date", "{{date.long}}"), it(es ? "Válida hasta" : "Valid until", "{{valid_until}}")] }),
      B("text", { eyebrow: es ? "Resumen" : "Summary", title: es ? "Lo que os proponemos" : "What we propose", body: es ? "<p>Hola {{client.contact}},</p><p>Gracias por el tiempo dedicado a contarnos vuestros retos. En esta propuesta encontraréis cómo podemos ayudar a {{client}}, el alcance del proyecto y la inversión necesaria.</p><p>Un saludo,<br>{{seller.name}}</p>" : "<p>Hi {{client.contact}},</p><p>Thank you for sharing your challenges with us. This proposal explains how we can help {{client}}, the scope of the project and the investment.</p><p>Best regards,<br>{{seller.name}}</p>" }),
      B("cards", { eyebrow: es ? "El reto" : "The challenge", title: es ? "Dónde estáis hoy" : "Where you are today", items: es ? [it("Procesos manuales", "<p>Horas de trabajo en hojas de cálculo cada cierre.</p>"), it("Datos dispersos", "<p>Información en varios sistemas, difícil de consolidar.</p>"), it("Poca visibilidad", "<p>Los informes llegan tarde a quien tiene que decidir.</p>")] : [it("Manual work", "<p>Hours spent in spreadsheets every close.</p>"), it("Scattered data", "<p>Information spread across systems.</p>"), it("Little visibility", "<p>Reports reach decision makers late.</p>")] }),
      B("stats", { eyebrow: es ? "Resultados" : "Results", title: es ? "Lo que consiguen nuestros clientes" : "What our clients achieve", items: [it(es ? "más rápido el cierre" : "faster close", "", "70%"), it(es ? "horas ahorradas al mes" : "hours saved a month", "", "120"), it(es ? "clientes en el mundo" : "clients worldwide", "", "500+")] }),
      B("products", { eyebrow: es ? "Solución" : "Solution", title: "{{product}}", body: es ? "<p>La plataforma que necesitáis, con todo incluido.</p>" : "<p>The platform you need, all included.</p>", when: "product" }),
      B("services", { eyebrow: es ? "Servicios" : "Services", title: "{{service}}", body: es ? "<p>Un equipo experto acompaña a {{client}} en cada fase.</p>" : "<p>An expert team guides {{client}} through every phase.</p>", when: "service" }),
      B("timeline", { eyebrow: es ? "Plan" : "Plan", title: es ? "Cómo lo haremos" : "How we'll do it" }),
      B("pricing", { eyebrow: es ? "Inversión" : "Investment", title: es ? "Resumen económico" : "Investment summary", body: es ? "<p>Oferta válida hasta el {{valid_until}}.</p>" : "<p>Valid until {{valid_until}}.</p>" }),
      B("terms", { eyebrow: es ? "Condiciones" : "Conditions", title: es ? "Condiciones comerciales" : "Commercial conditions", items: es ? [it("Validez", "<p>{{terms.validity_days}} días desde la fecha de la propuesta.</p>"), it("Pago", "<p>A {{terms.payment_days}} días desde la factura.</p>"), it("Impuestos", "<p>Los importes no incluyen IVA.</p>"), it("Actualización", "<p>La licencia se actualiza anualmente según IPC.</p>")] : [it("Validity", "<p>{{terms.validity_days}} days from the proposal date.</p>"), it("Payment", "<p>{{terms.payment_days}} days from invoice.</p>"), it("Taxes", "<p>Amounts exclude VAT.</p>"), it("Increase", "<p>The licence is updated yearly.</p>")] }),
      B("cta", { eyebrow: es ? "Siguientes pasos" : "Next steps", title: es ? "¿Empezamos?" : "Shall we start?", body: es ? "<p>Estamos a vuestra disposición para resolver cualquier duda.</p>" : "<p>We're here for any question.</p>" }),
    ],
  };
}

// -------------------------------------- reading a reference document -----
export interface ImportedDoc { blocks: DocBlock[]; theme: Partial<DocTheme>; images: Blob[]; text: string; pages: number; source: string }
const GUESS: [RegExp, DocBlockType, DocKind[]][] = [
  [/precio|inversi[oó]n|econ[oó]mic|pricing|investment|presupuesto|tarifa|importe|honorarios|cost|fee/i, "pricing", ["proposal", "contract"]],
  [/fase|cronograma|calendario|planificaci[oó]n|timeline|roadmap|metodolog|plan de trabajo|hitos|implantaci[oó]n/i, "timeline", ["proposal"]],
  [/^(el |nuestro )?equipo|^team|qui[eé]nes somos|^our people/i, "team", ["proposal"]],
  [/condiciones|t[eé]rminos|terms|conditions/i, "terms", ["proposal"]],
  [/gracias|thank|^contacto|^contact|siguientes pasos|next steps/i, "cta", ["proposal"]],
  [/reto|problema|diagn[oó]stico|limitaci|situaci[oó]n actual|challenge|pain|contexto|dolor/i, "cards", ["proposal"]],
  [/resultados|cifras|figures|results|impact|referencias|casos de [eé]xito|clientes/i, "stats", ["proposal"]],
  [/cl[aá]usula|estipulaciones|clauses|acuerdan/i, "clauses", ["contract"]],
  [/reunidos|las partes|^parties|intervienen|exponen/i, "parties", ["contract"]],
  [/en prueba de conformidad|witness|^firmas?$|^signatures?$/i, "signature", ["contract"]],
  [/calendario de pagos|payment schedule|anexo econ/i, "schedule", ["contract"]],
];
/** "PROPUESTA COMERCIAL" → "Propuesta comercial" (keeps tokens and short acronyms). */
const sentenceCase = (t: string) => {
  if (t !== t.toUpperCase() || !/[A-ZÁÉÍÓÚÑ]{4}/.test(t)) return t;
  const low = t.toLowerCase().replace(/\{\{[^}]*\}\}/g, (m) => m.replace(/[a-z]/g, (c) => c));
  return low.replace(/(^|[.!?]\s+)(\p{L})/gu, (_m, a: string, c: string) => a + c.toUpperCase())
    .replace(/\b(konsolidator|excel|sap|erp|crm|bi|power bi|kpi|kpis|saas|iberia|europa|españa)\b/gi, (w) => (w.length <= 4 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
};
/** Puts variables where a reference document has the values of another deal: dates, money, the brand, e-mails. */
export function autoPlaceTokens(text: string, hints: { clientNames?: string[]; sellerEmail?: string; brand?: string; kind?: DocKind } = {}): string {
  let s = text;
  (hints.clientNames ?? []).filter((n) => n && n.length > 2).forEach((n) => { s = s.split(n).join("{{client}}"); });
  if (hints.kind === "contract") {
    const D = "\\d{1,2} de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) de 20\\d\\d";
    s = s.replace(new RegExp(`(desde el|a partir del?|con efectos del?|entra(rá)? en vigor el)\\s+${D}`, "gi"), (m) => m.replace(new RegExp(D, "i"), "{{contract.start}}"));
    s = s.replace(new RegExp(`(,\\s*a|firman? (el presente )?(contrato )?(en [^,]+, )?(a|el))\\s+${D}`, "gi"), (m) => m.replace(new RegExp(D, "i"), "{{contract.sign_date}}"));
    s = s.replace(new RegExp(`^(en [^,]{2,30}),\\s*a\\s+${D}`, "i"), "En {{provider.city}}, a {{contract.sign_date}}");
    const MONEY = "(\\d{1,3}(?:[.,]\\d{3})+(?:,\\d{1,2})?|\\d+(?:,\\d{1,2})?)\\s?(€|euros|EUR)";
    s = s.replace(new RegExp(`(licencia|licence|license|suscripci[oó]n|subscription)([^.€]{0,90}?)${MONEY}`, "gi"), (_m, a: string, b: string) => `${a}${b}{{contract.license.final}}`);
    s = s.replace(new RegExp(`(servicios|services|implantaci[oó]n|implementation)([^.€]{0,90}?)${MONEY}`, "gi"), (_m, a: string, b: string) => `${a}${b}{{contract.services.final}}`);
    s = s.replace(/(duraci[oó]n (inicial )?de|term of|plazo de)\s+(\d+|un|uno|dos|tres|cuatro|cinco|one|two|three|four|five)\s+(años|year|years)/gi, (_m, a: string, b = "", _n: string, y: string) => `${a} ${b ?? ""}{{contract.years}} ${y}`.replace(/\s+/g, " "));
    s = s.replace(/(actualizable|incremento|increase)[^.]{0,30}?\b\d+(?:,\d+)?\s?%\s*(anual(mente)?|a year|per year|yearly)?/gi, "{{contract.increment}}");
  }
  s = s.replace(/\b(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) de (20\d\d)\b/gi, "{{date.long}}");
  s = s.replace(/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december) (de )?(20\d\d)\b/gi, "{{date}}");
  s = s.replace(/\b(v[aá]lid[oa]s? hasta( el)?|valid until)\s+\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/gi, (m) => m.replace(/\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/, "{{valid_until}}"));
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "{{seller.email}}");
  s = s.replace(/(\+34|\+\d{2})?\s?\d{3}\s?\d{3}\s?\d{3}\b/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "{{seller.phone}}" : m));
  return s;
}
const CLAUSE_RE = /^((cl[aá]usula|art[ií]culo|article|section)\s+)?((\d+|[IVXL]+)\b[.)ºª\-–]*|(primera|segunda|tercera|cuarta|quinta|sexta|s[eé]ptima|octava|novena|d[eé]cima|und[eé]cima|duod[eé]cima|decimotercera|decimocuarta|decimoquinta|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\b[.:\-–]?)\s*/i;
const isUpper = (x: string) => x === x.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3}/.test(x);
const isHeading = (l: string) => l.length <= 70 && !/[.,;:]$/.test(l) && (isUpper(l) || /^(\d+[.)]|[IVX]+\.)\s+\S/.test(l) || /^#{1,3}\s/.test(l) || (CLAUSE_RE.test(l) && /^(cl[aá]usula|art[ií]culo|article|primera|segunda|tercera|cuarta|quinta|sexta|s[eé]ptima|octava|novena|d[eé]cima|first|second|third|fourth|fifth)/i.test(l) && l.length < 60));
/** Short line + longer line after it = a title and its text. */
function pairLines(lines: string[]): DocItem[] {
  const out: DocItem[] = [];
  const clean = (l: string) => l.replace(/^([-•·*▪–]|\d+[.)])\s+/, "").trim();
  for (let k = 0; k < lines.length; k++) {
    const a = clean(lines[k]), b = lines[k + 1] != null ? clean(lines[k + 1]) : "";
    const m = /^([^:–—]{2,48})[:–—]\s*(.+)$/.exec(a);
    if (m) { out.push(it(sentenceCase(m[1].trim()), `<p>${esc(m[2].trim())}</p>`)); continue; }
    if (a.length <= 60 && !/[.]$/.test(a) && b && b.length > a.length + 10) { out.push(it(sentenceCase(a), `<p>${esc(b)}</p>`)); k++; continue; }
    out.push(a.length <= 60 ? it(sentenceCase(a), "") : it("", `<p>${esc(sentenceCase(a))}</p>`));
  }
  return out;
}
/** Footers, page numbers and slide numerals repeat on every page: they don't belong in the document. */
function dropBoilerplate(sections: { title: string; lines: string[]; eyebrow?: string }[]): { title: string; lines: string[] }[] {
  const norm = (l: string) => l.replace(/^[-•·*▪–]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const count = new Map<string, number>();
  sections.forEach((sec) => new Set(sec.lines.map(norm)).forEach((l) => count.set(l, (count.get(l) ?? 0) + 1)));
  const many = Math.max(3, Math.ceil(sections.length * 0.3));
  const junk = (l: string) => {
    const n = norm(l);
    return !n || (count.get(n) ?? 0) >= many || /^([ivxlc]+|\d{1,3}|página \d+|page \d+|\d+ \/ \d+)$/i.test(n) || /confidencial|confidential|all rights reserved|todos los derechos/i.test(n) && n.length < 70;
  };
  return sections.map((sec) => ({ title: sec.title, lines: sec.lines.filter((l) => !junk(l)) }));
}
/** Builds blocks from plain sections (heading + paragraphs). */
function blocksFromSections(sections0: { title: string; lines: string[]; eyebrow?: string }[], kind: DocKind, hints0: Parameters<typeof autoPlaceTokens>[1]): DocBlock[] {
  const hints = { ...hints0, kind };
  const sections = dropBoilerplate(sections0).map((x, i) => ({ ...x, eyebrow: sections0[i].eyebrow }));
  const out: DocBlock[] = [];
  const clause: DocItem[] = [];
  const flushClauses = () => { if (clause.length) { out.push({ id: rid(), type: "clauses", eyebrow: "Cláusulas", title: "Acuerdan", items: clause.splice(0) }); } };
  const NUM = /^-?\s*\{\{num\}\}\s*[-–·.]*\s*/;
  sections.forEach((sec, i) => {
    // "{{num}} - ALCANCE" lines are section labels (eyebrows)
    let eyebrow = (sec as any).eyebrow ?? "";
    const raw = sec.lines.filter((l) => { if (NUM.test(l)) { eyebrow = eyebrow || sentenceCase(l.replace(NUM, "").trim()); return false; } return !/^-?\s*\d{1,2}$/.test(l.trim()); });
    let title0 = sec.title;
    if (NUM.test(title0)) { eyebrow = eyebrow || sentenceCase(title0.replace(NUM, "").trim()); title0 = raw.shift() ?? eyebrow; }
    let title = sentenceCase(autoPlaceTokens(title0.replace(/^#{1,3}\s*/, "").replace(/^-\s+/, "").trim(), hints));
    const lines = raw.map((l) => autoPlaceTokens(l, hints)).filter((l) => l.trim());
    if (title.length > 90) { lines.unshift(title); title = eyebrow || ""; }
    if (i === 0 && out.length === 0) {
      out.push({ id: rid(), type: "cover", eyebrow: eyebrow || (kind === "contract" ? "Contrato" : "Propuesta"), title: title || "{{deal}}", body: textToRich(lines.slice(0, 2).map((l) => l.replace(/^-\s+/, "")).join("\n")), items: kind === "contract" ? [it("Firma", "{{contract.sign_date}}"), it("Inicio", "{{contract.start}}")] : [it("Preparado para", "{{client}}"), it("Fecha", "{{date.long}}")] });
      return;
    }
    const joined = lines.join(" ");
    if (kind === "contract") {
      // "CLÁUSULAS" on its own is just the heading of the clauses that follow
      if (/^(cl[aá]usulas|estipulaciones|acuerdan|clauses|terms and conditions)$/i.test(title.trim()) && !lines.length) return;
      if (CLAUSE_RE.test(sec.title) && !/reunidos|exponen|intervienen|firmas?$|signatures?$/i.test(title)) {
        clause.push(it(sentenceCase(title.replace(CLAUSE_RE, "").trim()) || title, textToRich(lines.join("\n"))));
        return;
      }
    }
    let type = (GUESS.find(([re, , ks]) => ks.includes(kind) && re.test(title)) ?? [null, "text"])[1] as DocBlockType;
    if (/\{\{seller\./.test(joined) && kind === "proposal") type = "cta";
    if (/\{\{product/.test(title + joined) && kind === "proposal") type = "products";
    else if (/\{\{service/.test(title + joined) && kind === "proposal") type = "services";
    if (kind === "contract" && (type === "text" || type === "clauses") && /^(\d+|[IVX]+)[.)ºª]?\s|cl[aá]usula|^[A-ZÁÉÍÓÚÑ ]{4,}$/i.test(sec.title)) {
      clause.push(it(title.replace(/^(cl[aá]usula\s+)?(\d+|[IVX]+)[.)ºª-]*\s*/i, ""), textToRich(lines.join("\n"))));
      return;
    }
    flushClauses();
    // the deal fills prices, products and services: one block each is enough
    if (["pricing", "products", "services", "schedule", "parties", "signature"].includes(type) && out.some((b) => b.type === type)) return;
    if (type === "products") { out.push({ id: rid(), type, eyebrow: eyebrow || "Solución", title: "{{product}}", when: "product", body: "" }); return; }
    if (type === "services") { out.push({ id: rid(), type, eyebrow: eyebrow || "Servicios", title: "{{service}}", when: "service", body: "" }); return; }
    if (type === "pricing" || type === "schedule" || type === "parties" || type === "signature") {
      out.push({ id: rid(), type, eyebrow, title: type === "pricing" && /\{\{/.test(title) ? "Propuesta económica" : title, body: type === "signature" ? textToRich(lines.join("\n")) : "" });
      return;
    }
    if (type === "stats") {
      const nums = lines.map((l) => /^-?\s*([+−-]?[\d.,]+\s?[%+€kKmMx]*)\s*(.*)$/.exec(l.trim())).filter(Boolean) as RegExpExecArray[];
      if (nums.length >= 2) { out.push({ id: rid(), type, eyebrow, title, body: "", items: nums.slice(0, 4).map((n) => it(n[2] || "", "", n[1])) }); return; }
      type = lines.length >= 4 ? "cards" : "text";
    }
    if ((type === "cards" || type === "terms" || type === "team" || type === "timeline" || type === "text") && lines.length >= 3 && lines.filter((l) => l.replace(/^-\s+/, "").length <= 70).length >= 2) {
      const paras = lines.filter((l) => !/^-\s/.test(l) && l.length > 140);
      const items = pairLines(lines.filter((l) => !paras.includes(l))).slice(0, 8);
      if (items.length >= 2) {
        out.push({ id: rid(), type: type === "text" ? "cards" : type, eyebrow, title, body: textToRich(paras.join("\n")), items });
        return;
      }
    }
    out.push({ id: rid(), type: type === "cta" ? "cta" : "text", eyebrow, title, body: textToRich(lines.map((l) => l.replace(/^-\s+(?=.{60,})/, "")).join("\n")) });
  });
  flushClauses();
  if (kind === "contract") {
    if (!out.some((b) => b.type === "parties")) out.splice(1, 0, { id: rid(), type: "parties", title: "Las partes" });
    if (!out.some((b) => b.type === "signature")) out.push({ id: rid(), type: "signature", title: "Y en prueba de conformidad", body: "<p>Firman en {{provider.city}}, a {{contract.sign_date}}.</p>" });
    // the money annex goes right before the signatures
    const before = (b: DocBlock) => { const at = out.findIndex((x) => x.type === "signature"); out.splice(at < 0 ? out.length : at, 0, b); };
    if (!out.some((b) => b.type === "pricing")) before({ id: rid(), type: "pricing", eyebrow: "Anexo económico", title: "Condiciones económicas" });
    if (!out.some((b) => b.type === "schedule")) before({ id: rid(), type: "schedule", eyebrow: "Calendario", title: "Importe año a año" });
  } else {
    if (!out.some((b) => b.type === "products")) out.push({ id: rid(), type: "products", eyebrow: "Solución", title: "{{product}}", when: "product" });
    if (!out.some((b) => b.type === "services")) out.push({ id: rid(), type: "services", eyebrow: "Servicios", title: "{{service}}", when: "service" });
    if (!out.some((b) => b.type === "pricing")) out.push({ id: rid(), type: "pricing", eyebrow: "Inversión", title: "Resumen económico", body: "<p>Oferta válida hasta el {{valid_until}}.</p>" });
    if (!out.some((b) => b.type === "cta")) out.push({ id: rid(), type: "cta", eyebrow: "Siguientes pasos", title: "¿Empezamos?" });
    // product and service sections go right before the pricing; the closing goes last
    const move = (t: DocBlockType, before: () => number) => { const k = out.findIndex((b) => b.type === t); const at = before(); if (k > at && at >= 0) { const [b] = out.splice(k, 1); out.splice(at, 0, b); } };
    move("services", () => out.findIndex((b) => b.type === "pricing"));
    move("products", () => out.findIndex((b) => b.type === "services"));
    const ci = out.findIndex((b) => b.type === "cta"); if (ci >= 0 && ci < out.length - 1) { const [b] = out.splice(ci, 1); out.push(b); }
  }
  // tones alternate so the page has rhythm
  let alt = false;
  out.forEach((b) => { if (!b.tone && (b.type === "text" || b.type === "cards" || b.type === "timeline" || b.type === "terms")) { b.tone = alt ? "tint" : "light"; alt = !alt; } });
  return out;
}
/** Gives the pictures of a reference document to the cover and the text blocks. */
export function assignImages(blocks: DocBlock[], urls: string[]): DocBlock[] {
  const list = [...urls];
  return blocks.map((b, i) => {
    if (!list.length || b.image) return b;
    if (b.type === "cover") return { ...b, image: list.shift() };
    if (b.type === "text" && richToText(b.body ?? "").length > 40) return { ...b, image: list.shift(), layout: i % 2 ? "left" : "right" };
    return b;
  });
}
/** Lines of plain text → sections split at headings (wrapped lines joined, small capital labels as eyebrows). */
function sectionsFromLines(lines0: string[]): { title: string; lines: string[]; eyebrow?: string }[] {
  const lines: string[] = [];
  lines0.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).forEach((l) => {
    const prev = lines[lines.length - 1];
    if (prev && isUpper(prev) && isUpper(l) && isHeading(prev) && !/[.:;!?]$/.test(prev) && prev.length + l.length < 110) { lines[lines.length - 1] = `${prev} ${l}`; return; }
    if (prev && !isHeading(prev) && !isHeading(l) && /^[a-záéíóúñ(0-9]/.test(l) && !/[.:;!?]$/.test(prev) && prev.length > 30) { lines[lines.length - 1] = `${prev} ${l}`; return; }
    lines.push(l);
  });
  const out: { title: string; lines: string[]; eyebrow?: string }[] = [];
  lines.forEach((l) => { if (isHeading(l) || !out.length) out.push({ title: l, lines: [] }); else out[out.length - 1].lines.push(l); });
  out.forEach((sec) => {
    const first = sec.lines[0];
    if (isUpper(sec.title) && sec.title.length <= 28 && first && first.length <= 70 && !isUpper(first) && !/[.]$/.test(first) && !CLAUSE_RE.test(sec.title)) { sec.eyebrow = sentenceCase(sec.title); sec.title = sec.lines.shift()!; }
  });
  return out.filter((s) => s.title || s.lines.length);
}
// -- PDF: text of the page streams (Flate inflated with the browser's DecompressionStream) --
async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  const DS: any = (globalThis as any).DecompressionStream;
  if (!DS) return null;
  // the end-of-line before "endstream" is not part of the data
  let n = bytes.length;
  while (n > 0 && (bytes[n - 1] === 10 || bytes[n - 1] === 13)) n--;
  const chunks: Uint8Array[] = [];
  try {
    const reader: any = new Blob([bytes.subarray(0, n) as any]).stream().pipeThrough(new DS("deflate")).getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value as Uint8Array); }
  } catch { /* keep what came out before any trailing junk */ }
  if (!chunks.length) return null;
  const out = new Uint8Array(chunks.reduce((k, c) => k + c.length, 0));
  let o = 0; chunks.forEach((c) => { out.set(c, o); o += c.length; });
  return out;
}
const latin = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
// A small PDF reader: objects (also inside object streams), page fonts with their ToUnicode maps, and the text operators.
interface PdfObj { dict: string; stream?: Uint8Array }
async function pdfObjects(buf: Uint8Array): Promise<Map<number, PdfObj>> {
  const src = latin(buf);
  const objs = new Map<number, PdfObj>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  const streams: { n: number; dict: string }[] = [];
  while ((m = re.exec(src))) {
    const n = Number(m[1]);
    const start = m.index + m[0].length;
    const end = src.indexOf("endobj", start);
    if (end < 0) break;
    const body = src.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    if (si >= 0) {
      const dict = body.slice(0, si);
      const s0 = start + si + (body[si + 6] === "\r" ? 8 : 7);
      const se = src.lastIndexOf("endstream", end);
      let bytes: Uint8Array | null = buf.subarray(s0, se > s0 ? se : end);
      if (/\/FlateDecode/.test(dict)) bytes = await inflate(bytes);
      else if (/\/Filter/.test(dict)) bytes = null;
      objs.set(n, { dict, stream: bytes ?? undefined });
      if (/\/Type\s*\/ObjStm/.test(dict) && bytes) streams.push({ n, dict });
    } else objs.set(n, { dict: body });
    re.lastIndex = end;
  }
  // objects packed in object streams (PDF 1.5+)
  for (const os of streams) {
    const data = latin(objs.get(os.n)!.stream!);
    const N = Number(/\/N\s+(\d+)/.exec(os.dict)?.[1] ?? 0), first = Number(/\/First\s+(\d+)/.exec(os.dict)?.[1] ?? 0);
    const head = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < N; i++) {
      const num = head[i * 2], off = head[i * 2 + 1], next = i + 1 < N ? head[i * 2 + 3] : data.length - first;
      if (!objs.has(num)) objs.set(num, { dict: data.slice(first + off, first + next) });
    }
  }
  return objs;
}
/** The value after a key: a nested << >> dictionary, an array, or the object a reference points to. */
function pdfVal(dict: string, key: string, objs: Map<number, PdfObj>): string {
  const i = dict.search(new RegExp(`/${key}(?![A-Za-z0-9])`));
  if (i < 0) return "";
  let j = i + key.length + 1;
  while (/\s/.test(dict[j] ?? "")) j++;
  const ref = /^(\d+)\s+\d+\s+R/.exec(dict.slice(j));
  if (ref) return objs.get(Number(ref[1]))?.dict ?? "";
  const open = dict.slice(j, j + 2) === "<<" ? "<<" : dict[j] === "[" ? "[" : "";
  if (!open) return dict.slice(j, j + 40);
  const close = open === "<<" ? ">>" : "]";
  let depth = 0;
  for (let k = j; k < dict.length; k++) {
    if (dict.startsWith(open, k)) { depth++; k += open.length - 1; }
    else if (dict.startsWith(close, k)) { depth--; if (!depth) return dict.slice(j, k + close.length); k += close.length - 1; }
  }
  return dict.slice(j);
}
interface PdfCmap { len: number; map: Map<string, string>; widths?: Map<number, number>; dw?: number }
function pdfCmap(text: string): PdfCmap {
  const map = new Map<string, string>();
  const u16 = (h: string) => { let o = ""; for (let i = 0; i + 3 < h.length + 1; i += 4) o += String.fromCharCode(parseInt(h.slice(i, i + 4).padEnd(4, "0"), 16)); return o; };
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  const len = cs ? Math.max(1, cs[1].length / 2) : 2;
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(p[1].toLowerCase(), u16(p[2]));
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16), w = p[1].length;
      if (hi - lo > 5000) continue;
      if (p[3].startsWith("[")) { const ds = Array.from(p[3].matchAll(/<([0-9a-fA-F]+)>/g)).map((x) => x[1]); for (let c = lo; c <= hi; c++) if (ds[c - lo]) map.set(c.toString(16).padStart(w, "0"), u16(ds[c - lo])); }
      else { const d = p[3].slice(1, -1); const base = parseInt(d.slice(-4), 16); for (let c = lo; c <= hi; c++) map.set(c.toString(16).padStart(w, "0"), u16(d.slice(0, -4)) + String.fromCharCode(base + c - lo)); }
    }
  }
  return { len, map };
}
function pdfBytes(lit: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < lit.length; i++) {
    const c = lit[i];
    if (c !== "\\") { out.push(c.charCodeAt(0) & 255); continue; }
    const n = lit[++i];
    if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(lit[i + 1] ?? "")) o += lit[++i]; out.push(parseInt(o, 8) & 255); }
    else if (n === "n") out.push(10); else if (n === "r") out.push(13); else if (n === "t") out.push(9);
    else if (n === "b" || n === "f") out.push(32); else if (n === "\r" || n === "\n") { /* line continuation */ }
    else out.push(n.charCodeAt(0) & 255);
  }
  return out;
}
function pdfDecode(bytes: number[], cm: PdfCmap | null): string {
  if (!cm || !cm.map.size) return String.fromCharCode(...bytes);
  let o = "";
  for (let i = 0; i + cm.len <= bytes.length; i += cm.len) {
    const k = bytes.slice(i, i + cm.len).map((b) => b.toString(16).padStart(2, "0")).join("");
    o += cm.map.get(k) ?? (cm.len === 1 ? String.fromCharCode(bytes[i]) : "");
  }
  return o;
}
async function pdfText(buf: Uint8Array): Promise<{ lines: string[]; pages: number }> {
  const objs = await pdfObjects(buf);
  const pages = Array.from(objs.entries()).filter(([, o]) => /\/Type\s*\/Page(?![s\w])/.test(o.dict)).sort((a, b) => a[0] - b[0]);
  const cmaps = new Map<number, PdfCmap | null>();
  const lines: string[] = [];
  for (const [, pg] of pages) {
    // fonts of the page
    const res = pdfVal(pg.dict, "Resources", objs);
    const fontDict = pdfVal(res, "Font", objs);
    const fonts = new Map<string, PdfCmap | null>();
    for (const f of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const n = Number(f[2]);
      if (!cmaps.has(n)) {
        const fo = objs.get(n)?.dict ?? "";
        const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fo);
        const st = tu ? objs.get(Number(tu[1]))?.stream : undefined;
        const cm: PdfCmap = st ? pdfCmap(latin(st)) : { len: /Type0/.test(fo) ? 2 : 1, map: new Map() };
        // glyph widths (to tell letters from word gaps when every glyph is placed on its own)
        const widths = new Map<number, number>();
        const nums = (t: string) => (t.match(/-?[\d.]+/g) ?? []).map(Number);
        const wArr = pdfVal(fo, "Widths", objs);
        if (wArr.startsWith("[")) { const fc = Number(/\/FirstChar\s+(\d+)/.exec(fo)?.[1] ?? 0); nums(wArr).forEach((w, i) => widths.set(fc + i, w)); }
        const desc = pdfVal(fo, "DescendantFonts", objs);
        const dref = /(\d+)\s+\d+\s+R/.exec(desc);
        const dd = dref ? objs.get(Number(dref[1]))?.dict ?? "" : desc;
        if (dd) {
          cm.dw = Number(/\/DW\s+(\d+)/.exec(dd)?.[1] ?? 1000);
          const W = pdfVal(dd, "W", objs);
          for (const g of W.slice(1, -1).matchAll(/(\d+)\s*\[([^\]]*)\]|(\d+)\s+(\d+)\s+(-?[\d.]+)/g)) {
            if (g[1] != null) nums(g[2]).forEach((w, i) => widths.set(Number(g[1]) + i, w));
            else for (let c = Number(g[3]); c <= Number(g[4]) && c - Number(g[3]) < 5000; c++) widths.set(c, Number(g[5]));
          }
        }
        cm.widths = widths;
        cmaps.set(n, cm);
      }
      fonts.set(f[1], cmaps.get(n)!);
    }
    // the page's content streams
    const cref = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(pg.dict)?.[1] ?? "";
    const ids = Array.from(cref.matchAll(/(\d+)\s+\d+\s+R/g)).map((x) => Number(x[1]));
    const content = ids.map((n) => { const st = objs.get(n)?.stream; return st ? latin(st) : ""; }).join("\n");
    let font: PdfCmap | null = null, size = 10, cur = "", lastY: number | null = null, adv = 0;
    const advance = (bytes: number[]) => {
      const L = font?.len ?? 1; let w = 0;
      for (let i = 0; i + L <= bytes.length; i += L) { let c = 0; for (let k = 0; k < L; k++) c = c * 256 + bytes[i + k]; w += font?.widths?.get(c) ?? font?.dw ?? 500; }
      return (w / 1000) * size;
    };
    const hexBytes = (h: string) => { const x = h.replace(/\s/g, ""); return Array.from({ length: x.length / 2 }, (_, i) => parseInt(x.slice(i * 2, i * 2 + 2), 16)); };
    const flush = () => { const t = cur.replace(/\s+/g, " ").trim(); if (t) lines.push(t); cur = ""; };
    const tok = /\/([^\s/<>[\]()]+)\s+([-\d.]+)\s+Tf|\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(Tj|'|")|<([0-9A-Fa-f\s]*)>\s*(Tj|'|")|([-\d.]+)\s+([-\d.]+)\s+T[dD]|(?:[-\d.]+\s+){5}([-\d.]+)\s+Tm|\bT\*|\bET\b/g;
    let m: RegExpExecArray | null;
    while ((m = tok.exec(content))) {
      if (m[1]) { font = fonts.get(m[1]) ?? null; size = Math.abs(Number(m[2])) || size; continue; }
      if (m[3] != null) {
        adv = 0;
        for (const part of m[3].matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]*)>|(-?[\d.]+)/g)) {
          if (part[1] != null) { const by = pdfBytes(part[1]); cur += pdfDecode(by, font); adv += advance(by); }
          else if (part[2] != null) { const by = hexBytes(part[2]); cur += pdfDecode(by, font); adv += advance(by); }
          else { if (Number(part[3]) < -180) cur += " "; adv -= (Number(part[3]) / 1000) * size; }
        }
        continue;
      }
      if (m[4] != null || m[6] != null) {
        if (m[5] === "'" || m[5] === '"' || m[7] === "'" || m[7] === '"') flush();
        const by = m[4] != null ? pdfBytes(m[4]) : hexBytes(m[6]);
        cur += pdfDecode(by, font); adv = advance(by);
        continue;
      }
      if (m[8] != null) {
        const dx = Number(m[8]), dy = Number(m[9]);
        if (Math.abs(dy) > 0.5) flush();
        else if (dx > adv + size * 0.15 || dx < 0) cur += " ";      // a gap wider than the glyph before it: a new word
        adv = 0;
        continue;
      }
      if (m[10] != null) { const y = Number(m[10]); if (lastY == null || Math.abs(y - lastY) > 0.5) flush(); else cur += " "; lastY = y; adv = 0; continue; }
      flush();
    }
    flush();
  }
  return { lines: lines.filter((l) => /[a-záéíóúñ0-9]/i.test(l)), pages: pages.length };
}
async function docxText(buf: Uint8Array): Promise<{ sections: { title: string; lines: string[] }[]; images: Blob[] }> {
  const zip = await openZip(buf);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("This Word file has no text.");
  const body = xpath(xroot(xparse(xml)), "w:body");
  const sections: { title: string; lines: string[] }[] = [];
  const paras = xfind(body!, (e) => e.name === "w:p");
  paras.forEach((p) => {
    const style = xat(xpath(p, "w:pPr", "w:pStyle"), "w:val") ?? "";
    const text = xfind(p, (e) => e.name === "w:t" || e.name === "w:tab" || e.name === "w:br").map((e) => (e.name === "w:t" ? xtext(e) : " ")).join("").replace(/\s+/g, " ").trim();
    if (!text) return;
    const list = !!xpath(p, "w:pPr", "w:numPr");
    const head = /^(Title|Heading|Ttulo|T[ií]tulo|Encabezado)/i.test(style) || isHeading(text);
    if (head || !sections.length) sections.push({ title: text, lines: [] });
    else sections[sections.length - 1].lines.push(list ? `- ${text}` : text);
  });
  const images: Blob[] = [];
  const media = Object.keys(zip.files).filter((n) => /^word\/media\/.+\.(png|jpe?g)$/i.test(n)).slice(0, 8);
  for (const n of media) images.push(new Blob([await zip.file(n).async("uint8array")], { type: /png$/i.test(n) ? "image/png" : "image/jpeg" }));
  return { sections, images };
}
/** The main colours of a deck: its theme accents. */
async function deckTheme(buf: Uint8Array): Promise<Partial<DocTheme>> {
  try {
    const zip = await openZip(buf);
    const name = Object.keys(zip.files).find((n) => /^ppt\/theme\/theme\d*\.xml$/.test(n));
    if (!name) return {};
    const th = xroot(xparse(await zip.file(name).async("string")));
    const clr = xpath(th, "a:themeElements", "a:clrScheme");
    const get = (k: string) => { const e = xkid(clr, k); const c = xels(e)[0]; const v = xat(c, "val") ?? xat(c, "lastClr"); return v && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toUpperCase()}` : undefined; };
    const fonts = xpath(th, "a:themeElements", "a:fontScheme");
    const font = (k: string) => xat(xpath(fonts, k, "a:latin"), "typeface");
    const sat = (h?: string) => { if (!h) return 0; const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16); return Math.max(r, g, b) - Math.min(r, g, b); };
    const accents = ["a:accent1", "a:accent2", "a:accent3", "a:accent4", "a:dk2"].map(get).filter(Boolean) as string[];
    accents.sort((a, b) => sat(b) - sat(a));
    const pick = (f?: string) => (f && DOC_FONTS.find((x) => x.toLowerCase() === f.toLowerCase())) || undefined;
    return { primary: get("a:dk2") && sat(get("a:dk2")) > 40 ? get("a:dk2") : accents[0], accent: accents.find((a) => a !== (get("a:dk2"))) ?? accents[1], headingFont: pick(font("a:majorFont")), bodyFont: pick(font("a:minorFont")) };
  } catch { return {}; }
}
/** Who the parties are in a reference contract ("De otra parte, Acme Holding, S.A., con NIF…"): the client's names become {{client}}. */
type PlaceHints = NonNullable<Parameters<typeof autoPlaceTokens>[1]>;
function partyHints(text: string, hints: PlaceHints): PlaceHints {
  const names = new Set(hints?.clientNames ?? []);
  const m = /(de otra parte|and on the other(?: side| hand)?|y de otra),?\s+(?:la (?:mercantil|sociedad|empresa|entidad)\s+)?([A-ZÁÉÍÓÚÑ0-9][^,\n]{1,60}?)(,?\s+(S\.?\s?L\.?\s?U?\.?|S\.?\s?A\.?\s?U?\.?|S\.?\s?Coop\.?|Ltd\.?|GmbH|Inc\.?|B\.?V\.?|SAS|SRL))?(?=,|\s+con\s|\s+\(|\s+with\s)/i.exec(text);
  if (m) { const base = m[2].trim(); if (base.length > 2) { if (m[3]) names.add(`${base}${m[3]}`.trim()); names.add(base); } }
  return { ...hints, clientNames: Array.from(names).sort((a, b) => b.length - a.length) };
}
/** Reads any reference document (PowerPoint, PDF, Word, text) and builds a first template from it. */
export async function importReferenceDoc(file: Blob & { name?: string }, kind: DocKind, hints0: PlaceHints = {}): Promise<ImportedDoc> {
  let hints: PlaceHints = hints0;
  const name = (file as any).name ?? "document";
  const buf = new Uint8Array(await file.arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (/\.pptx$/i.test(name) || (isZip && !/\.docx$/i.test(name) && (await openZip(buf)).file("ppt/presentation.xml"))) {
    const info = await parseDeck(buf);
    const theme = await deckTheme(buf);
    const sections = info.slides.filter((s) => !s.hidden).map((s) => {
      const texts = s.texts.filter((t) => !t.table).map((t) => t.text.replace(/\s+/g, " ").trim()).filter(Boolean);
      const title = s.title && texts.includes(s.title) ? s.title : texts[0] ?? s.title;
      return { title, lines: texts.filter((t) => t !== title).map((t) => (t.length < 90 && !/[.:]$/.test(t) ? `- ${t}` : t)) };
    });
    // the pictures of the deck (biggest ones), to reuse
    const zip = await openZip(buf);
    const imgs = Object.keys(zip.files).filter((n) => /^ppt\/media\/.+\.(png|jpe?g)$/i.test(n));
    const sized = await Promise.all(imgs.map(async (n) => ({ n, b: await zip.file(n).async("uint8array") as Uint8Array })));
    const images = sized.filter((x) => x.b.length > 30000).sort((a, b) => b.b.length - a.b.length).slice(0, 6).map((x) => new Blob([x.b as any], { type: /png$/i.test(x.n) ? "image/png" : "image/jpeg" }));
    const text = sections.map((s) => [s.title, ...s.lines].join("\n")).join("\n\n");
    hints = partyHints(text, hints);
    const blocks = blocksFromSections(sections, kind, hints);
    return { blocks, theme, images, text, pages: info.slides.length, source: "pptx" };
  }
  if (/\.docx$/i.test(name) || isZip) {
    const { sections, images } = await docxText(buf);
    const text = sections.map((s) => [s.title, ...s.lines].join("\n")).join("\n\n");
    hints = partyHints(text, hints);
    return { blocks: blocksFromSections(sections, kind, hints), theme: {}, images, text, pages: 0, source: "docx" };
  }
  if (/\.pdf$/i.test(name) || latin(buf.subarray(0, 5)) === "%PDF-") {
    const { lines, pages } = await pdfText(buf);
    if (lines.length < 3) throw new Error("No text could be read from this PDF (it may be scanned). Try the Word or PowerPoint version.");
    hints = partyHints(lines.join("\n"), hints);
    return { blocks: blocksFromSections(sectionsFromLines(lines), kind, hints), theme: {}, images: [], text: lines.join("\n"), pages, source: "pdf" };
  }
  let text = new TextDecoder().decode(buf);
  if (/<html|<body|<p[\s>]/i.test(text)) text = text.replace(/<(br|\/p|\/h\d|\/li|\/div)[^>]*>/gi, "\n").replace(/<h\d[^>]*>/gi, "\n# ").replace(/<li[^>]*>/gi, "\n- ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  hints = partyHints(text, hints);
  return { blocks: blocksFromSections(sectionsFromLines(text.split(/\r?\n/)), kind, hints), theme: {}, images: [], text, pages: 0, source: "text" };
}

/** Field values the template uses that the deal doesn't fill (the seller types them). */
export function docFreeTokens(blocks: DocBlock[]): string[] {
  const all = new Set<string>();
  const add = (s?: string) => tokensIn(String(s ?? "")).forEach((k) => { if (!k.startsWith("?")) all.add(k); });
  blocks.forEach((b) => { add(b.eyebrow); add(b.title); add(b.body); (b.items ?? []).forEach((x) => { add(x.title); add(x.text); add(x.value); }); });
  const known = (k: string) => k === "client.name" || isKnownToken(k) || DOC_EXTRA_TOKENS.some((t) => t.key.replace(/N/g, "") === k.replace(/\d+/g, "") || t.key === k);
  return Array.from(all).filter((k) => !known(k));
}
/** Every token a set of blocks uses, in order of appearance. */
export function docUsedTokens(blocks: DocBlock[]): string[] {
  const out: string[] = [];
  const add = (s?: string) => tokensIn(String(s ?? "")).forEach((k) => { if (!k.startsWith("?") && !out.includes(k)) out.push(k); });
  blocks.forEach((b) => { add(b.eyebrow); add(b.title); add(b.body); (b.items ?? []).forEach((x) => { add(x.title); add(x.value); add(x.text); }); });
  return out;
}
export const newDocBlock = (type: DocBlockType, kind: DocKind, lang: DocLang = "es"): DocBlock => {
  const tpl = defaultDocTemplate(kind === "contract" && !["clauses", "parties", "schedule", "signature"].includes(type) ? "proposal" : kind, lang).blocks.find((b) => b.type === type)
    ?? defaultDocTemplate(kind === "proposal" ? "contract" : "proposal", lang).blocks.find((b) => b.type === type);
  const base: DocBlock = tpl ? JSON.parse(JSON.stringify(tpl)) : { id: "", type, title: docBlockMeta(type).label };
  if (type === "team" && !base.items) base.items = [it("Nombre Apellido", "<p>Experiencia y papel en el proyecto.</p>", "Rol"), it("Nombre Apellido", "<p>Experiencia y papel en el proyecto.</p>", "Rol")];
  if (type === "quote" && !base.body) { base.body = "<p>Con ellos cerramos el mes en la mitad de tiempo.</p>"; base.title = "Nombre Apellido"; base.eyebrow = "CFO, Empresa"; }
  if (type === "image" && !base.title) base.title = "";
  if (type === "text" && !tpl) { base.title = "Título"; base.body = "<p>Escribe aquí…</p>"; }
  return { ...base, id: rid(), items: (base.items ?? []).map((x) => ({ ...x, id: rid() })) };
};
export const newDocItem = (): DocItem => it("", "");
export const cloneBlock = (b: DocBlock): DocBlock => ({ ...JSON.parse(JSON.stringify(b)), id: rid(), items: (b.items ?? []).map((x) => ({ ...x, id: rid() })) });
