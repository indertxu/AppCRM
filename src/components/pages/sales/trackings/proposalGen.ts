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
