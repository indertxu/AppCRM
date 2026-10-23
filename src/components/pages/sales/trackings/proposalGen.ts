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
export interface PvRun { text: string; size: number; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; font?: string; caps?: boolean; smallCaps?: boolean; baseline?: number; spc?: number; link?: string; highlight?: string }
export interface PvPara { key?: string; align?: string; runs: PvRun[]; endSize: number; bullet?: string; buColor?: string; buSize?: number; marL?: number; indent?: number; lnSpc?: number; lnPts?: number; spcBef?: number; spcAft?: number; spcBefPct?: number; spcAftPct?: number; color?: string }
export interface PvText { anchor: string; l: number; t: number; r: number; b: number; wrap: boolean; paras: PvPara[]; scale?: number; vert?: boolean; /** "norm": shrink text on overflow, "sp": the box grows with its text */ autofit?: "norm" | "sp"; lnRed?: number }
export interface PvCell { tag: string; text: PvText; fill?: string; span?: number; rowSpan?: number; merged?: boolean; borders: { l?: string; r?: string; t?: string; b?: string } }
export interface PvTable { cols: number[]; rows: { h: number; tag: string; cells: PvCell[]; repeat?: string; text: string }[] }
export interface PvShape {
  sid: string; name: string; layer: "master" | "layout" | "slide";
  x: number; y: number; w: number; h: number; rot?: number; flipH?: boolean; flipV?: boolean;
  geom: string; adj?: Record<string, number>; radius?: number; path?: { d: string; w: number; h: number }[];
  fill?: string; img?: string; crop?: { l: number; t: number; r: number; b: number }; imgFill?: boolean; alpha?: number;
  line?: { color: string; w: number; dash?: boolean; head?: boolean; tail?: boolean; headType?: string; tailType?: string; headSz?: string; tailSz?: string }; connector?: boolean;
  text?: PvText; table?: PvTable; hideIf?: string[];
  /** a chart drawn as an SVG picture (data URL), from the values cached in the deck */
  chartSvg?: string;
  /** Slide shapes: the top-level shape it belongs to (itself, or the group it sits in) — what the editor moves. */
  top?: string;
}
export interface PvSlide { n: number; bg?: string; bgImg?: string; shapes: PvShape[]; /** the theme's body font */ font?: string }
export interface PvDeck { cx: number; cy: number; slides: PvSlide[]; info: DeckInfo }

// --- colours ---
type Theme = { colors: Record<string, string>; major: string; minor: string };
/** Table styles of a deck (ppt/tableStyles.xml), by style id. */
type TableStyles = Map<string, XEl>;
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
    // PowerPoint tints and shades in linear light (scRGB), not in sRGB
    else if (m.name === "a:tint") { rgbHex = linMix(rgbHex, (x) => x * val + (1 - val)); [h, s, l] = hexToHsl(rgbHex); }
    else if (m.name === "a:shade") { rgbHex = linMix(rgbHex, (x) => x * val); [h, s, l] = hexToHsl(rgbHex); }
    else if (m.name === "a:alpha") alpha = val;
  }
  if (alpha < 1) return `rgba(${parseInt(rgbHex.slice(0, 2), 16)},${parseInt(rgbHex.slice(2, 4), 16)},${parseInt(rgbHex.slice(4, 6), 16)},${alpha.toFixed(3)})`;
  return `#${rgbHex}`;
}
/** Apply f to each channel of a hex colour in linear light. */
function linMix(hex: string, f: (x: number) => number): string {
  return [0, 2, 4].map((k) => {
    const c = parseInt(hex.slice(k, k + 2), 16) / 255;
    const lin = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const o = Math.min(1, Math.max(0, f(lin)));
    const srgb = o <= 0.0031308 ? o * 12.92 : 1.055 * Math.pow(o, 1 / 2.4) - 0.055;
    return Math.round(srgb * 255).toString(16).padStart(2, "0");
  }).join("").toUpperCase();
}
const CLR = ["a:srgbClr", "a:schemeClr", "a:sysClr", "a:scrgbClr", "a:prstClr"];
const clrKid = (e: XEl | undefined) => xels(e).find((k) => CLR.includes(k.name));

interface Ctx { zip: any; th: Theme; map: Record<string, string>; rels: Rel[]; img: (path: string) => Promise<string | undefined>; tblStyles?: TableStyles; defText?: XEl }

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

const WINGDINGS: Record<number, string> = { 0x21: "✏", 0x22: "✂", 0x28: "☎", 0x2a: "✉", 0x36: "⌛", 0x3f: "✍", 0x41: "✌", 0x43: "👍", 0x44: "👎", 0x46: "☞", 0x4a: "☺", 0x4c: "☹", 0x4e: "☠", 0x6c: "●", 0x6e: "■", 0x6f: "□", 0x71: "❑", 0x75: "◆", 0x76: "❖", 0x77: "◆", 0x9f: "•", 0xa7: "▪", 0xa8: "◻", 0xab: "★", 0xd8: "➢", 0xdf: "←", 0xe0: "→", 0xe1: "↑", 0xe2: "↓", 0xe8: "➔", 0xe7: "➔", 0xef: "⇦", 0xf0: "⇨", 0xf1: "⇧", 0xf2: "⇩", 0xfb: "✗", 0xfc: "✓", 0xfd: "☒", 0xfe: "☑", 0xd5: "⌫", 0x9e: "·", 0xa1: "○", 0xa2: "◎", 0xa4: "◉", 0x3c: "💾", 0x31: "📂", 0x2b: "✉" };
const SYMBOL: Record<number, string> = { 0xae: "→", 0xac: "←", 0xad: "↑", 0xaf: "↓", 0xb7: "•", 0xd6: "√", 0xb0: "°", 0xb1: "±", 0xa5: "∞", 0xb4: "×", 0xb8: "÷", 0xb9: "≠", 0xa3: "≤", 0xb3: "≥", 0xe2: "®", 0xe3: "©", 0xe4: "™", 0x44: "Δ", 0x53: "Σ", 0x70: "π", 0x6d: "μ", 0x61: "α", 0x62: "β", 0xde: "⇒", 0xdb: "⇔" };
/** Letters of a symbol font → the unicode picture they show (Wingdings "à" = →). */
function symbolChars(text: string, font: string): string {
  const tbl = /symbol/i.test(font) ? SYMBOL : WINGDINGS;
  return Array.from(text).map((ch) => { let c = ch.charCodeAt(0); if (c >= 0xf000 && c <= 0xf0ff) c -= 0xf000; return tbl[c] ?? (c < 0x80 && /symbol/i.test(font) ? ch : tbl[c] ?? (c > 0x20 ? "•" : ch)); }).join("");
}
/** Text-style levels: lvl1pPr…  from a list style element. */
const lvlOf = (lst: XEl | undefined, lvl: number) => xkid(lst, `a:lvl${lvl}pPr`) ?? (lvl === 1 ? xkid(lst, "a:defPPr") : undefined);

async function textOf(body: XEl, cx: Ctx, inherit: XEl[] /* list styles, most specific first */, keyOf: (pi: number) => string | undefined, styleText?: string, bodyChain: XEl[] = []): Promise<PvText> {
  // bodyPr: the shape's own, then its layout / master placeholder's
  const bps = [xkid(body, "a:bodyPr"), ...bodyChain].filter(Boolean) as XEl[];
  const bat = (k: string) => bps.map((x) => xat(x, k)).find((v) => v !== undefined);
  // the first bodyPr that says anything about autofit decides
  const fitOwner = bps.find((x) => xkid(x, "a:normAutofit") || xkid(x, "a:spAutoFit") || xkid(x, "a:noAutofit"));
  const fa = xkid(fitOwner, "a:normAutofit"), spFit = !!xkid(fitOwner, "a:spAutoFit");
  const ins = (k: string, d: number) => Number(bat(k) ?? d);
  const lists = [xkid(body, "a:lstStyle"), ...inherit, ...(cx.defText ? [cx.defText] : [])];
  const relOf = (id?: string) => (id ? cx.rels.find((r) => r.id === id) : undefined);
  const paras: PvPara[] = xkids(body, "a:p").map((p, pi) => {
    const pPr = xkid(p, "a:pPr");
    const lvl = Number(xat(pPr, "lvl") ?? 0) + 1;
    const lvls = lists.map((l) => lvlOf(l, lvl)).filter(Boolean) as XEl[];
    const pick = (k: string) => xat(pPr, k) ?? lvls.map((l) => xat(l, k)).find((v) => v !== undefined);
    const pkid = (...path: string[]) => xpath(pPr, ...path) ?? lvls.map((l) => xpath(l, ...path)).find(Boolean);
    const defR = lvls.map((l) => xkid(l, "a:defRPr")).filter(Boolean) as XEl[];
    const ownLvl = lvlOf(lists[0], lvl);
    const ownDef = xkid(ownLvl, "a:defRPr");
    const runStyle = (rPr: XEl | undefined): Omit<PvRun, "text"> => {
      const chain = [rPr, ...defR].filter(Boolean) as XEl[];
      const a = (k: string) => chain.map((x) => xat(x, k)).find((v) => v !== undefined);
      // colour: the run's own, else the shape's style colour (table style / shape style), else what the masters say
      const fillOfEl = (x: XEl) => xkid(x, "a:solidFill") ?? (xkid(x, "a:noFill") ? x : undefined);
      const own = [rPr, ownDef].filter(Boolean) as XEl[];
      const fillEl = own.map(fillOfEl).find(Boolean) ?? (styleText ? undefined : chain.map(fillOfEl).find(Boolean));
      const gradEl = !fillEl ? own.map((x) => xkid(x, "a:gradFill")).find(Boolean) : undefined;
      const latin = chain.map((x) => xat(xkid(x, "a:latin"), "typeface")).find(Boolean);
      const font = latin === "+mj-lt" ? cx.th.major : latin === "+mn-lt" || !latin ? cx.th.minor : latin;
      const link = xkid(rPr, "a:hlinkClick");
      const rel = relOf(xat(link, "r:id"));
      const href = rel?.external ? rel.target : undefined;
      let color = fillEl && fillEl.name !== "a:solidFill" ? "transparent" : fillEl ? colorOf(clrKid(fillEl), cx.th, cx.map) : gradEl ? colorOf(clrKid(xkids(xkid(gradEl, "a:gsLst"), "a:gs")[0]), cx.th, cx.map) : styleText;
      // links: the theme's link colour, underlined (unless the run sets its own colour)
      if (link && !xkid(rPr, "a:solidFill")) color = colorOf(xel("a:schemeClr", [["val", "hlink"]]), cx.th, cx.map) ?? color;
      const hl = xkid(rPr, "a:highlight");
      return {
        size: Number(a("sz") ?? 1800) / 100, bold: a("b") === "1", italic: a("i") === "1", underline: (!!a("u") && a("u") !== "none") || (!!link && a("u") !== "none"),
        strike: !!a("strike") && a("strike") !== "noStrike", color,
        font, caps: a("cap") === "all", smallCaps: a("cap") === "small", baseline: Number(a("baseline") ?? 0) / 1000, spc: Number(a("spc") ?? 0) / 100,
        link: href, highlight: hl ? colorOf(clrKid(hl), cx.th, cx.map) : undefined,
      };
    };
    const runs: PvRun[] = paraRuns(p).map((r) => {
      const st = runStyle(xkid(r, "a:rPr"));
      const sym = xat(xkid(xkid(r, "a:rPr"), "a:sym"), "typeface");
      const latinSym = st.font && /wingdings|symbol|webdings/i.test(st.font) ? st.font : undefined;
      const raw = runText(r);
      // symbol fonts (Wingdings arrows, ticks…): their letters are pictures → the same picture as a normal character.
      // a:sym only covers the symbol characters themselves (private-use U+F0xx); a Wingdings run covers all of it.
      if (latinSym) return { ...st, text: symbolChars(raw, latinSym), font: "Arial" };
      if (sym && /[\uF020-\uF0FF]/.test(raw)) return { ...st, text: raw.replace(/[\uF020-\uF0FF]/g, (ch) => symbolChars(ch, sym)) };
      return { ...st, text: raw };
    });
    const end = runStyle(xkid(p, "a:endParaRPr"));
    // the most specific level that says anything about bullets decides (a layout's "no bullet" beats the master's "•")
    const buSrc = [pPr, ...lvls].find((l) => l && (xkid(l, "a:buNone") || xkid(l, "a:buChar") || xkid(l, "a:buAutoNum") || xkid(l, "a:buBlip")));
    let bu = xat(xkid(buSrc, "a:buChar"), "char");
    const auto = xkid(buSrc, "a:buAutoNum");
    const buFont = xat(pkid("a:buFont"), "typeface") ?? "";
    // symbol fonts: their letters are pictures
    if (bu && /wingdings|symbol/i.test(buFont)) bu = ({ "ü": "✓", "§": "■", "Ø": "➢", "l": "●", "n": "■", "q": "❑", "v": "❖", "Ÿ": "•", "è": "➔", "ð": "➔", "o": "○", "à": "→", "Þ": "➔", "ê": "✓", "þ": "☑" } as Record<string, string>)[bu] ?? "•";
    const noBu = !!xkid(buSrc, "a:buNone");
    if (!bu && auto && !noBu) {
      // numbered list: count the paragraphs of this level before it
      const t = xat(auto, "type") ?? "arabicPeriod", start = Number(xat(auto, "startAt") ?? 1);
      const prev = xkids(body, "a:p").slice(0, pi).reverse();
      let n = 0;
      for (const q of prev) { const ql = Number(xat(xkid(q, "a:pPr"), "lvl") ?? 0) + 1; if (ql < lvl) break; if (ql === lvl && paraTextOf(q).trim()) n++; }
      const num = start + n;
      const roman = (x: number) => { const m: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]]; let r = ""; for (const [v, c] of m) while (x >= v) { r += c; x -= v; } return r; };
      const core = /alpha/i.test(t) ? String.fromCharCode(96 + ((num - 1) % 26) + 1) : /roman/i.test(t) ? roman(num) : String(num);
      const cased = /UcPeriod|Uc/.test(t) ? core.toUpperCase() : core;
      bu = /ParenBoth/.test(t) ? `(${cased})` : /ParenR/.test(t) ? `${cased})` : /Plain/.test(t) ? cased : `${cased}.`;
    }
    const buClr = pkid("a:buClr");
    const buSz = xat(pkid("a:buSzPct"), "val");
    const lnPct = xat(pkid("a:lnSpc", "a:spcPct"), "val"), lnPts = xat(pkid("a:lnSpc", "a:spcPts"), "val");
    const sb = xat(pkid("a:spcBef", "a:spcPts"), "val"), sa = xat(pkid("a:spcAft", "a:spcPts"), "val");
    const sbP = xat(pkid("a:spcBef", "a:spcPct"), "val"), saP = xat(pkid("a:spcAft", "a:spcPct"), "val");
    const hasText = runs.some((r) => r.text.trim());
    return {
      key: keyOf(pi), align: pick("algn") ?? "l", runs, endSize: end.size, color: end.color,
      // an empty paragraph shows no bullet
      bullet: !noBu && bu && hasText ? bu : undefined, buColor: buClr ? colorOf(clrKid(buClr), cx.th, cx.map) : undefined, buSize: buSz ? Number(buSz) / 100000 : undefined,
      marL: Number(pick("marL") ?? 0), indent: Number(pick("indent") ?? 0),
      lnSpc: lnPct ? Number(lnPct) / 100000 : undefined, lnPts: lnPts ? Number(lnPts) / 100 : undefined,
      spcBef: sb ? Number(sb) / 100 : undefined, spcAft: sa ? Number(sa) / 100 : undefined,
      spcBefPct: sbP ? Number(sbP) / 100000 : undefined, spcAftPct: saP ? Number(saP) / 100000 : undefined,
    };
  });
  const vert = bat("vert");
  return {
    anchor: bat("anchor") ?? "t", l: ins("lIns", 91440), r: ins("rIns", 91440), t: ins("tIns", 45720), b: ins("bIns", 45720),
    wrap: bat("wrap") !== "none", paras, scale: fa ? Number(xat(fa, "fontScale") ?? 100000) / 100000 : undefined,
    lnRed: fa && xat(fa, "lnSpcReduction") ? Number(xat(fa, "lnSpcReduction")) / 100000 : undefined,
    autofit: fa ? "norm" : spFit ? "sp" : undefined,
    vert: !!vert && vert !== "horz" && /vert/.test(vert),
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
async function treeShapes(tree: XEl, cx: Ctx, layer: PvShape["layer"], opts: { n?: number; phLookup?: (ph: XEl) => { xfrm?: XEl; lists: XEl[]; body?: XEl; bodyPrs?: XEl[]; spPrs?: XEl[] } | undefined; skipPh?: boolean; txStyles: { title?: XEl; body?: XEl; other?: XEl } }): Promise<PvShape[]> {
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
    // a placeholder without its own fill / outline / geometry takes the layout's (then the master's)
    const spChain = [spPr, ...(phInfo?.spPrs ?? [])].filter(Boolean) as XEl[];
    const geomEl = spChain.map((x) => xkid(x, "a:prstGeom") ?? xkid(x, "a:custGeom")).find(Boolean);
    const prst = geomEl?.name === "a:custGeom" ? "cust" : xat(geomEl, "prst") ?? "rect";
    const shape: PvShape = {
      sid: ids[i], name, layer, x, y, w, h, geom: prst, top: layer === "slide" ? top : undefined,
      rot: Number(xat(xfrm, "rot") ?? 0) / 60000 || undefined, flipH: xat(xfrm, "flipH") === "1", flipV: xat(xfrm, "flipV") === "1",
      hideIf: tokensIn(name).length ? tokensIn(name) : undefined,
    };
    const gds = xkids(xkid(geomEl, "a:avLst"), "a:gd");
    if (gds.length) {
      shape.adj = {};
      gds.forEach((g) => { const m = /^val\s+(-?\d+)/.exec(xat(g, "fmla") ?? ""); if (m) shape.adj![xat(g, "name") ?? "adj"] = Number(m[1]); });
    }
    if (prst === "roundRect") shape.radius = (Math.min(w, h) * adjOf(shape.adj, "adj", 16667)) / 100000;
    if (prst === "cust") shape.path = custPaths(geomEl!);
    if (el.name === "p:cxnSp" || /line|Connector/i.test(prst)) shape.connector = true;
    // fill
    if (el.name === "p:pic") {
      const blip = xkid(xkid(el, "p:blipFill"), "a:blip");
      // Office keeps an SVG next to the PNG of icons: the SVG is sharper
      const svgId = xat(xfind(blip ?? xel("#"), (e) => /:svgBlip$/.test(e.name))[0], "r:embed");
      const svgRel = svgId ? cx.rels.find((r) => r.id === svgId) : undefined;
      const rel = cx.rels.find((r) => r.id === xat(blip, "r:embed"));
      shape.img = (svgRel ? await cx.img(svgRel.path) : undefined) ?? (rel ? await cx.img(rel.path) : undefined);
      const src = xpath(el, "p:blipFill", "a:srcRect");
      const amf = xkid(blip, "a:alphaModFix");
      if (amf) shape.alpha = Math.max(0, Math.min(1, Number(xat(amf, "amt") ?? 100000) / 100000));
      if (src) shape.crop = { l: Number(xat(src, "l") ?? 0) / 1000, t: Number(xat(src, "t") ?? 0) / 1000, r: Number(xat(src, "r") ?? 0) / 1000, b: Number(xat(src, "b") ?? 0) / 1000 };
    } else {
      const fillSrc = spChain.find((x) => xkid(x, "a:noFill") || xkid(x, "a:solidFill") || xkid(x, "a:gradFill") || xkid(x, "a:blipFill") || xkid(x, "a:pattFill"));
      const patt = xkid(fillSrc, "a:pattFill");
      const f = patt ? { fill: colorOf(clrKid(xkid(patt, "a:fgClr")), cx.th, cx.map) } : await fillOf(fillSrc, cx, styleFill);
      if (f?.img) { shape.img = f.img; shape.imgFill = true; }
      else if (f?.fill) shape.fill = f.fill;
      else if (!(f as any)?.none && styleFill) shape.fill = styleFill;
    }
    // line
    const ln = spChain.map((x) => xkid(x, "a:ln")).find(Boolean);
    const lnFill = xkid(ln, "a:solidFill") ?? xkid(ln, "a:gradFill");
    if (ln && !xkid(ln, "a:noFill")) {
      const lc = xkid(ln, "a:solidFill") ? colorOf(clrKid(xkid(ln, "a:solidFill")), cx.th, cx.map) : lnFill ? colorOf(clrKid(xkids(xkid(lnFill, "a:gsLst"), "a:gs")[0]), cx.th, cx.map) : styleLine;
      const he = xkid(ln, "a:headEnd"), te = xkid(ln, "a:tailEnd");
      const dashV = xat(xkid(ln, "a:prstDash"), "val");
      if (lc) shape.line = { color: lc, w: Number(xat(ln, "w") ?? (xkid(style, "a:lnRef") ? 12700 : 9525)), dash: !!dashV && dashV !== "solid", head: !!he && xat(he, "type") !== "none", tail: !!te && xat(te, "type") !== "none", headType: xat(he, "type"), tailType: xat(te, "type"), headSz: xat(he, "len") ?? xat(he, "w"), tailSz: xat(te, "len") ?? xat(te, "w") };
    } else if (!ln && styleLine) shape.line = { color: styleLine, w: 12700 };
    // text
    const n = opts.n;
    const body = xkid(el, "p:txBody");
    if (body) {
      const t = ph ? (xat(ph, "type") ?? "body") : "";
      const master = t === "title" || t === "ctrTitle" ? opts.txStyles.title : ph && !/^(dt|ftr|sldNum)$/.test(t) ? opts.txStyles.body : opts.txStyles.other;
      shape.text = await textOf(body, cx, [...(phInfo?.lists ?? []), ...(master ? [master] : [])], (pi) => (n ? `${n}:${ids[i]}:${pi}` : undefined), styleText, phInfo?.bodyPrs ?? []);
    }
    // table
    // charts: drawn from the values the deck keeps with them
    const chartRef = el.name === "p:graphicFrame" ? xfind(xpath(el, "a:graphic", "a:graphicData") ?? xel("#"), (e) => e.name === "c:chart")[0] : undefined;
    if (chartRef) {
      const rel = cx.rels.find((r) => r.id === xat(chartRef, "r:id"));
      const doc = rel ? await readPart(cx.zip, rel.path) : null;
      if (doc) { try { shape.chartSvg = chartToSvg(xroot(doc), w / 12700, h / 12700, cx); } catch (e) { console.warn("chart", e); } }
    }
    const tbl = el.name === "p:graphicFrame" ? tableOf(el) : undefined;
    if (tbl) {
      const cols = xkids(xkid(tbl, "a:tblGrid"), "a:gridCol").map((g) => Number(xat(g, "w") ?? 0) * pxf.sx);
      const rows = [];
      const trs = xkids(tbl, "a:tr");
      // the table style (ppt/tableStyles.xml): which parts apply (header row, banded rows…)
      const tblPr = xkid(tbl, "a:tblPr");
      const tsDef = cx.tblStyles?.get(xtext(xkid(tblPr, "a:tableStyleId")).trim());
      const on = (k: string) => xat(tblPr, k) === "1" || xat(tblPr, k) === "true";
      const nRows = trs.length, nCols = cols.length;
      const partsFor = (r: number, c: number) => {
        const p: string[] = ["a:wholeTbl"];
        const r0 = on("firstRow") ? r - 1 : r, c0 = on("firstCol") ? c - 1 : c;
        if (on("bandRow") && r0 >= 0) p.push(r0 % 2 === 0 ? "a:band1H" : "a:band2H");
        if (on("bandCol") && c0 >= 0) p.push(c0 % 2 === 0 ? "a:band1V" : "a:band2V");
        if (on("firstCol") && c === 0) p.push("a:firstCol");
        if (on("lastCol") && c === nCols - 1) p.push("a:lastCol");
        if (on("lastRow") && r === nRows - 1) p.push("a:lastRow");
        if (on("firstRow") && r === 0) p.push("a:firstRow");
        return p.map((k) => xkid(tsDef, k)).filter(Boolean) as XEl[];
      };
      const styleFillOf = async (part: XEl) => {
        const fill = xpath(part, "a:tcStyle", "a:fill");
        if (fill) return (await fillOf(fill, cx))?.fill ?? (xkid(fill, "a:noFill") ? "transparent" : undefined);
        const ref = xpath(part, "a:tcStyle", "a:fillRef");
        return ref ? colorOf(clrKid(ref), cx.th, cx.map) : undefined;
      };
      const lnCss = (l: XEl | undefined) => { if (!l || xkid(l, "a:noFill")) return undefined; const col = colorOf(clrKid(xkid(l, "a:solidFill")), cx.th, cx.map); return col ? `${Math.max(1, Number(xat(l, "w") ?? 12700) / 12700)}px solid ${col}` : undefined; };
      for (let r = 0; r < trs.length; r++) {
        const tr = trs[r];
        const cells: PvCell[] = [];
        const tcs = xkids(tr, "a:tc");
        for (let c = 0; c < tcs.length; c++) {
          const tc = tcs[c];
          const tcPr = xkid(tc, "a:tcPr");
          const f = await fillOf(tcPr, cx);
          // style: later parts win (header row over bands over whole table)
          const parts = tsDef ? partsFor(r, c) : [];
          let sFill: string | undefined, sColor: string | undefined, sBold = false;
          const sB: Record<string, string | undefined> = {};
          for (const part of parts) {
            const fl = await styleFillOf(part); if (fl) sFill = fl;
            const tx = xkid(part, "a:tcTxStyle");
            if (tx) { const col = colorOf(clrKid(tx), cx.th, cx.map) ?? colorOf(clrKid(xkid(tx, "a:fontRef")), cx.th, cx.map); if (col) sColor = col; if (xat(tx, "b") === "on") sBold = true; if (xat(tx, "b") === "off") sBold = false; }
            const bdr = xpath(part, "a:tcStyle", "a:tcBdr");
            if (bdr) {
              const side = (k: string) => { const e = xkid(bdr, k); return e ? lnCss(xkid(e, "a:ln")) ?? "none" : undefined; };
              const L = side("a:left"), R = side("a:right"), T = side("a:top"), B = side("a:bottom"), IH = side("a:insideH"), IV = side("a:insideV");
              if (c === 0 ? L : IV) sB.l = (c === 0 ? L : IV); if (c === nCols - 1 ? R : IV) sB.r = (c === nCols - 1 ? R : IV);
              if (r === 0 ? T : IH) sB.t = (r === 0 ? T : IH); if (r === nRows - 1 ? B : IH) sB.b = (r === nRows - 1 ? B : IH);
            }
          }
          const border = (k: string, sk: string) => { const l = xkid(tcPr, k); if (l) return xkid(l, "a:noFill") ? undefined : lnCss(l); const v = sB[sk]; return v === "none" ? undefined : v; };
          const tb = xkid(tc, "a:txBody") ?? xel("p:txBody", [], [xel("a:bodyPr"), xel("a:p")]);
          const text = await textOf(tb, cx, [], (pi) => (n ? `${n}:${ids[i]}:r${r}c${c}:${pi}` : undefined), sColor);
          if (sBold) text.paras.forEach((p) => p.runs.forEach((rn) => { rn.bold = true; }));
          text.l = Number(xat(tcPr, "marL") ?? 91440); text.r = Number(xat(tcPr, "marR") ?? 91440); text.t = Number(xat(tcPr, "marT") ?? 45720); text.b = Number(xat(tcPr, "marB") ?? 45720);
          text.anchor = xat(tcPr, "anchor") ?? "t";
          const cellFill = f?.fill ?? ((f as any)?.none ? undefined : sFill && sFill !== "transparent" ? sFill : undefined);
          cells.push({ tag: `r${r}c${c}`, text, fill: cellFill, span: Number(xat(tc, "gridSpan") ?? 1), rowSpan: Number(xat(tc, "rowSpan") ?? 1), merged: xat(tc, "hMerge") === "1" || xat(tc, "vMerge") === "1", borders: { l: border("a:lnL", "l"), r: border("a:lnR", "r"), t: border("a:lnT", "t"), b: border("a:lnB", "b") } });
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

// ------------------------------------------------- EMF pictures → PNG -----
/**
 * Windows metafiles (EMF) are how Office pastes Excel ranges, charts and many icons: browsers can't show them,
 * so their drawing records are played onto a canvas. Covers the GDI records Office writes (EMF+ "dual" files
 * carry them too): paths, polygons, lines, rectangles, ellipses, text, fills, clipping and bitmaps.
 */
export async function emfToPng(bytes: Uint8Array, maxSide = 1800): Promise<Blob | undefined> {
  if (typeof document === "undefined" || bytes.length < 88) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 1 || dv.getUint32(40, true) !== 0x464d4520) return undefined;
  const bL = dv.getInt32(8, true), bT = dv.getInt32(12, true), bR = dv.getInt32(16, true), bB = dv.getInt32(20, true);
  const devW = Math.max(1, bR - bL + 1), devH = Math.max(1, bB - bT + 1);
  const scale = Math.min(6, Math.max(1, maxSide / Math.max(devW, devH)));
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(devW * scale)); cv.height = Math.max(1, Math.round(devH * scale));
  const g = cv.getContext("2d")!;
  type Obj = { t: "pen"; style: number; w: number; color: string } | { t: "brush"; style: number; color: string } | { t: "font"; h: number; weight: number; italic: boolean; under: boolean; strike: boolean; face: string; esc: number };
  const objs = new Map<number, Obj>();
  type DC = { winOrg: [number, number]; winExt: [number, number]; vpOrg: [number, number]; vpExt: [number, number]; mode: number; world: number[]; pen: Obj | null; brush: Obj | null; font: Obj | null; text: string; bk: string; bkMode: number; align: number; fillMode: number; clip: [number, number, number, number] | null; cur: [number, number] };
  let dc: DC = { winOrg: [0, 0], winExt: [1, 1], vpOrg: [0, 0], vpExt: [1, 1], mode: 1, world: [1, 0, 0, 1, 0, 0], pen: { t: "pen", style: 0, w: 0, color: "#000" }, brush: { t: "brush", style: 0, color: "#fff" }, font: null, text: "#000", bk: "#fff", bkMode: 2, align: 0, fillMode: 1, clip: null, cur: [0, 0] };
  const stack: DC[] = [];
  const clone = (d: DC): DC => ({ ...d, winOrg: [...d.winOrg] as any, winExt: [...d.winExt] as any, vpOrg: [...d.vpOrg] as any, vpExt: [...d.vpExt] as any, world: [...d.world], clip: d.clip ? [...d.clip] as any : null, cur: [...d.cur] as any });
  const rgb = (o: number) => `rgb(${dv.getUint8(o)},${dv.getUint8(o + 1)},${dv.getUint8(o + 2)})`;
  // logical → device (page mapping) after the world transform
  const page = () => {
    const sx = dc.mode === 1 ? 1 : dc.vpExt[0] / (dc.winExt[0] || 1), sy = dc.mode === 1 ? 1 : dc.vpExt[1] / (dc.winExt[1] || 1);
    return { sx, sy, tx: dc.vpOrg[0] - dc.winOrg[0] * sx, ty: dc.vpOrg[1] - dc.winOrg[1] * sy };
  };
  const setXf = () => {
    const p = page(), w = dc.world;
    // canvas = scale * (device - bounds); device = page(world(x))
    const a = w[0] * p.sx, b = w[1] * p.sy, c = w[2] * p.sx, d = w[3] * p.sy, e = w[4] * p.sx + p.tx, f = w[5] * p.sy + p.ty;
    g.setTransform(a * scale, b * scale, c * scale, d * scale, (e - bL) * scale, (f - bT) * scale);
  };
  const devPx = () => { const p = page(); return Math.max(1e-6, Math.hypot(dc.world[0] * p.sx, dc.world[1] * p.sy)); };
  const withClip = (fn: () => void) => {
    g.save();
    if (dc.clip) { g.setTransform(scale, 0, 0, scale, -bL * scale, -bT * scale); g.beginPath(); g.rect(dc.clip[0], dc.clip[1], dc.clip[2] - dc.clip[0], dc.clip[3] - dc.clip[1]); g.clip(); }
    setXf(); fn(); g.restore();
  };
  const applyPen = () => {
    const p = dc.pen as any;
    if (!p || p.style === 5) return false;
    g.strokeStyle = p.color; g.lineWidth = p.w > 0 ? p.w : 1 / devPx();
    const st = p.style & 0xf; g.setLineDash(st === 1 ? [p.w * 3 || 3, p.w * 2 || 2] : st === 2 ? [p.w || 1, p.w || 1] : []);
    g.lineJoin = (p.style & 0xf000) === 0x2000 ? "miter" : (p.style & 0xf000) === 0x1000 ? "bevel" : "round";
    g.lineCap = (p.style & 0xf00) === 0x100 ? "square" : (p.style & 0xf00) === 0x200 ? "butt" : "round";
    return true;
  };
  const applyBrush = () => { const b = dc.brush as any; if (!b || b.style === 1) return false; g.fillStyle = b.color; return true; };
  const draw = (build: () => void, fill: boolean, stroke: boolean) => withClip(() => { g.beginPath(); build(); if (fill && applyBrush()) g.fill(dc.fillMode === 1 ? "evenodd" : "nonzero"); if (stroke && applyPen()) g.stroke(); });
  let path: Path2D | null = null;
  const tgt = () => path ?? null;
  const pts16 = (o: number, n: number) => { const a: [number, number][] = []; for (let i = 0; i < n; i++) a.push([dv.getInt16(o + i * 4, true), dv.getInt16(o + i * 4 + 2, true)]); return a; };
  const pts32 = (o: number, n: number) => { const a: [number, number][] = []; for (let i = 0; i < n; i++) a.push([dv.getInt32(o + i * 8, true), dv.getInt32(o + i * 8 + 4, true)]); return a; };
  const stock = (ih: number): Obj | null | undefined => {
    if (!(ih & 0x80000000)) return objs.get(ih);
    const k = ih & 0x7fffffff;
    const gray = ["#fff", "#c0c0c0", "#808080", "#404040", "#000"];
    if (k <= 4) return { t: "brush", style: 0, color: gray[k] };
    if (k === 5) return { t: "brush", style: 1, color: "#000" };
    if (k === 6) return { t: "pen", style: 0, w: 0, color: "#fff" };
    if (k === 7) return { t: "pen", style: 0, w: 0, color: "#000" };
    if (k === 8) return { t: "pen", style: 5, w: 0, color: "#000" };
    return null;
  };
  const dibImage = async (o: number, cbBmi: number, offBits: number, cbBits: number): Promise<CanvasImageSource | null> => {
    if (!cbBmi) return null;
    const hs = dv.getUint32(o, true), w = dv.getInt32(o + 4, true), h0 = dv.getInt32(o + 8, true), bpp = dv.getUint16(o + 14, true), comp = dv.getUint32(o + 16, true);
    if (comp === 4 || comp === 5) { try { return await createImageBitmap(new Blob([bytes.slice(offBits, offBits + cbBits) as any], { type: comp === 4 ? "image/jpeg" : "image/png" })); } catch { return null; } }
    const h = Math.abs(h0), up = h0 > 0;
    if (!w || !h || w * h > 40e6) return null;
    const nPal = bpp <= 8 ? (dv.getUint32(o + 32, true) || 1 << bpp) : 0;
    const pal = o + hs + (comp === 3 && hs === 40 ? 12 : 0);
    const stride = Math.ceil((w * bpp) / 32) * 4;
    const c2 = document.createElement("canvas"); c2.width = w; c2.height = h;
    const x2 = c2.getContext("2d")!; const id = x2.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const row = offBits + (up ? h - 1 - y : y) * stride;
      for (let x = 0; x < w; x++) {
        let r = 0, gg = 0, b = 0, a = 255;
        if (bpp === 24) { const q = row + x * 3; b = bytes[q]; gg = bytes[q + 1]; r = bytes[q + 2]; }
        else if (bpp === 32) { const q = row + x * 4; b = bytes[q]; gg = bytes[q + 1]; r = bytes[q + 2]; }
        else if (bpp === 16) { const v = dv.getUint16(row + x * 2, true); r = ((v >> 10) & 31) * 8; gg = ((v >> 5) & 31) * 8; b = (v & 31) * 8; }
        else if (bpp <= 8) { const bit = x * bpp, byte = bytes[row + (bit >> 3)], idx = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1); if (idx < nPal) { const q = pal + idx * 4; b = bytes[q]; gg = bytes[q + 1]; r = bytes[q + 2]; } }
        const q = (y * w + x) * 4; id.data[q] = r; id.data[q + 1] = gg; id.data[q + 2] = b; id.data[q + 3] = a;
      }
    }
    x2.putImageData(id, 0, 0);
    return c2;
  };
  const utf16 = (o: number, n: number) => { let t = ""; for (let i = 0; i < n; i++) t += String.fromCharCode(dv.getUint16(o + i * 2, true)); return t; };
  let off = 0, guard = 0;
  while (off + 8 <= bytes.length && guard++ < 200000) {
    const type = dv.getUint32(off, true), size = dv.getUint32(off + 4, true);
    if (size < 8 || off + size > bytes.length) break;
    const o = off + 8;
    try {
      switch (type) {
        case 9: dc.winExt = [dv.getInt32(o, true), dv.getInt32(o + 4, true)]; break;
        case 10: dc.winOrg = [dv.getInt32(o, true), dv.getInt32(o + 4, true)]; break;
        case 11: dc.vpExt = [dv.getInt32(o, true), dv.getInt32(o + 4, true)]; break;
        case 12: dc.vpOrg = [dv.getInt32(o, true), dv.getInt32(o + 4, true)]; break;
        case 17: dc.mode = dv.getUint32(o, true); break;
        case 18: dc.bkMode = dv.getUint32(o, true); break;
        case 19: dc.fillMode = dv.getUint32(o, true); break;
        case 22: dc.align = dv.getUint32(o, true); break;
        case 24: dc.text = rgb(o); break;
        case 25: dc.bk = rgb(o); break;
        case 27: dc.cur = [dv.getInt32(o, true), dv.getInt32(o + 4, true)]; if (path) path.moveTo(dc.cur[0], dc.cur[1]); break;
        case 54: { const x = dv.getInt32(o, true), y = dv.getInt32(o + 4, true); if (path) path.lineTo(x, y); else { const c = dc.cur; draw(() => { g.moveTo(c[0], c[1]); g.lineTo(x, y); }, false, true); } dc.cur = [x, y]; break; }
        case 33: stack.push(clone(dc)); break;
        case 34: { const rel = dv.getInt32(o, true); let i = rel < 0 ? stack.length + rel : rel; i = Math.max(0, Math.min(stack.length - 1, i)); if (stack.length) { dc = stack[i]; stack.length = i; } break; }
        case 35: dc.world = [0, 4, 8, 12, 16, 20].map((q) => dv.getFloat32(o + q, true)); break;
        case 36: {
          const m = [0, 4, 8, 12, 16, 20].map((q) => dv.getFloat32(o + q, true)), mode = dv.getUint32(o + 24, true), w = dc.world;
          const mul = (A: number[], B: number[]) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];
          dc.world = mode === 1 ? [1, 0, 0, 1, 0, 0] : mode === 2 ? mul(m, w) : mode === 3 ? mul(w, m) : m;
          break;
        }
        case 37: { const ih = dv.getUint32(o, true); const ob = stock(ih); if (ob) { if (ob.t === "pen") dc.pen = ob; else if (ob.t === "brush") dc.brush = ob; else dc.font = ob; } break; }
        case 38: objs.set(dv.getUint32(o, true), { t: "pen", style: dv.getUint32(o + 4, true), w: dv.getInt32(o + 8, true), color: rgb(o + 16) }); break;
        case 95: objs.set(dv.getUint32(o, true), { t: "pen", style: dv.getUint32(o + 20, true), w: dv.getUint32(o + 24, true), color: rgb(o + 32) }); break;
        case 39: objs.set(dv.getUint32(o, true), { t: "brush", style: dv.getUint32(o + 4, true), color: rgb(o + 8) }); break;
        case 93: case 94: objs.set(dv.getUint32(o, true), { t: "brush", style: 0, color: "#888" }); break;
        case 40: objs.delete(dv.getUint32(o, true)); break;
        case 82: {
          const lf = o + 4;
          objs.set(dv.getUint32(o, true), { t: "font", h: dv.getInt32(lf, true), esc: dv.getInt32(lf + 8, true), weight: dv.getInt32(lf + 16, true), italic: !!dv.getUint8(lf + 20), under: !!dv.getUint8(lf + 21), strike: !!dv.getUint8(lf + 22), face: utf16(lf + 28, 32).replace(/\0[\s\S]*$/, "") });
          break;
        }
        case 30: {
          // INTERSECTCLIPRECT (logical) → device rect
          const p = page(), wv = dc.world;
          const tr = (x: number, y: number) => [(wv[0] * x + wv[2] * y + wv[4]) * p.sx + p.tx, (wv[1] * x + wv[3] * y + wv[5]) * p.sy + p.ty];
          const [x1, y1] = tr(dv.getInt32(o, true), dv.getInt32(o + 4, true)), [x2, y2] = tr(dv.getInt32(o + 8, true), dv.getInt32(o + 12, true));
          const r: [number, number, number, number] = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
          dc.clip = dc.clip ? [Math.max(dc.clip[0], r[0]), Math.max(dc.clip[1], r[1]), Math.min(dc.clip[2], r[2]), Math.min(dc.clip[3], r[3])] : r;
          break;
        }
        case 75: {
          const cb = dv.getUint32(o, true), mode = dv.getUint32(o + 4, true);
          if (!cb) { dc.clip = null; break; }
          const rd = o + 8, n = dv.getUint32(rd + 8, true);
          if (n && (mode === 5 || mode === 1)) { const L = dv.getInt32(rd + 16, true), T = dv.getInt32(rd + 20, true), R = dv.getInt32(rd + 24, true), B = dv.getInt32(rd + 28, true); dc.clip = mode === 1 && dc.clip ? [Math.max(dc.clip[0], L), Math.max(dc.clip[1], T), Math.min(dc.clip[2], R), Math.min(dc.clip[3], B)] : [L, T, R, B]; }
          break;
        }
        case 59: path = new Path2D(); break;
        case 60: break;
        case 61: path?.closePath(); break;
        case 68: path = null; break;
        case 62: case 63: case 64: { const pp = path; path = null; if (pp) withClip(() => { if (type !== 64 && applyBrush()) g.fill(pp, dc.fillMode === 1 ? "evenodd" : "nonzero"); if (type !== 62 && applyPen()) g.stroke(pp); }); break; }
        case 67: path = null; break;
        case 2: case 3: case 4: case 5: case 6: case 85: case 86: case 87: case 88: case 89: {
          const sh16 = type >= 85, n = dv.getUint32(o + 16, true), ps = sh16 ? pts16(o + 20, n) : pts32(o + 20, n);
          const bez = type === 2 || type === 5 || type === 85 || type === 88, to = type === 5 || type === 6 || type === 88 || type === 89, closed = type === 3 || type === 86;
          const build = (ctx: CanvasPath) => {
            let i = 0;
            if (!to) { ctx.moveTo(ps[0][0], ps[0][1]); i = 1; } else if (!path) ctx.moveTo(dc.cur[0], dc.cur[1]);
            if (bez) for (; i + 2 < ps.length + (to ? 0 : 0) && i + 2 <= ps.length - 1 + 0; i += 3) ctx.bezierCurveTo(ps[i][0], ps[i][1], ps[i + 1][0], ps[i + 1][1], ps[i + 2][0], ps[i + 2][1]);
            else for (; i < ps.length; i++) ctx.lineTo(ps[i][0], ps[i][1]);
            if (closed) ctx.closePath();
          };
          if (ps.length) { const t = tgt(); if (t) build(t); else draw(() => build(g), closed, true); dc.cur = ps[ps.length - 1]; }
          break;
        }
        case 7: case 8: case 90: case 91: {
          const sh16 = type >= 90, nPolys = dv.getUint32(o + 16, true), total = dv.getUint32(o + 20, true);
          const counts = Array.from({ length: nPolys }, (_, i) => dv.getUint32(o + 24 + i * 4, true));
          const all = sh16 ? pts16(o + 24 + nPolys * 4, total) : pts32(o + 24 + nPolys * 4, total);
          const closed = type === 8 || type === 91;
          const build = (ctx: CanvasPath) => { let q = 0; for (const c of counts) { const seg = all.slice(q, q + c); q += c; if (!seg.length) continue; ctx.moveTo(seg[0][0], seg[0][1]); seg.slice(1).forEach(([x, y]) => ctx.lineTo(x, y)); if (closed) ctx.closePath(); } };
          const t = tgt(); if (t) build(t); else draw(() => build(g), closed, true);
          break;
        }
        case 42: case 43: case 44: {
          const L = dv.getInt32(o, true), T = dv.getInt32(o + 4, true), R = dv.getInt32(o + 8, true), B = dv.getInt32(o + 12, true);
          const build = (ctx: CanvasPath) => {
            if (type === 42) ctx.ellipse((L + R) / 2, (T + B) / 2, Math.abs(R - L) / 2, Math.abs(B - T) / 2, 0, 0, Math.PI * 2);
            else if (type === 44 && (ctx as any).roundRect) (ctx as any).roundRect(L, T, R - L, B - T, Math.min(dv.getInt32(o + 16, true), dv.getInt32(o + 20, true)) / 2);
            else ctx.rect(L, T, R - L, B - T);
          };
          const t = tgt(); if (t) build(t); else draw(() => build(g), true, true);
          break;
        }
        case 76: case 77: case 81: {
          // BITBLT / STRETCHBLT / STRETCHDIBITS: a picture, or (no picture) a fill with the brush
          const xD = dv.getInt32(o + 16, true), yD = dv.getInt32(o + 20, true);
          let cxD: number, cyD: number, offBmi: number, cbBmi: number, offBits: number, cbBits: number;
          if (type === 81) { offBmi = dv.getUint32(o + 40, true); cbBmi = dv.getUint32(o + 44, true); offBits = dv.getUint32(o + 48, true); cbBits = dv.getUint32(o + 52, true); cxD = dv.getInt32(o + 64, true); cyD = dv.getInt32(o + 68, true); }
          else { cxD = dv.getInt32(o + 24, true); cyD = dv.getInt32(o + 28, true); offBmi = dv.getUint32(o + 76, true); cbBmi = dv.getUint32(o + 80, true); offBits = dv.getUint32(o + 84, true); cbBits = dv.getUint32(o + 88, true); }
          const img = await dibImage(off + offBmi, cbBmi, off + offBits, cbBits);
          if (img) withClip(() => g.drawImage(img, xD, yD, cxD, cyD));
          else if (!cbBmi) withClip(() => { if (applyBrush()) g.fillRect(xD, yD, cxD, cyD); });
          break;
        }
        case 83: case 84: {
          const er = o + 28; // EMRTEXT
          const rx = dv.getInt32(er, true), ry = dv.getInt32(er + 4, true), n = dv.getUint32(er + 8, true), offS = dv.getUint32(er + 12, true), offDx = dv.getUint32(er + 36, true);
          const opts = dv.getUint32(er + 16, true);
          const text = type === 84 ? utf16(off + offS, n) : Array.from(bytes.slice(off + offS, off + offS + n)).map((c) => String.fromCharCode(c)).join("");
          const f = dc.font as any;
          const fh = f ? Math.abs(f.h) || 12 : 12;
          const dx = offDx ? Array.from({ length: n }, (_, i) => dv.getInt32(off + offDx + i * 4, true)) : null;
          // ETO_OPAQUE: the text's rectangle is filled with the background colour
          if (opts & 2) { const L = dv.getInt32(er + 20, true), T = dv.getInt32(er + 24, true), R = dv.getInt32(er + 28, true), B = dv.getInt32(er + 32, true); withClip(() => { g.fillStyle = dc.bk; g.fillRect(L, T, R - L, B - T); }); }
          if (!text.trim()) break;
          withClip(() => {
            const wf = webFont(f?.face || "Arial");
            g.font = `${f?.italic ? "italic " : ""}${f && f.weight >= 600 ? "700" : "400"} ${fh * (f && f.h < 0 ? 1 : 0.86)}px ${wf.stack}`;
            g.fillStyle = dc.text;
            const al = dc.align;
            g.textBaseline = (al & 24) === 24 ? "alphabetic" : (al & 8) ? "bottom" : "top";
            const total = dx ? dx.reduce((a, b) => a + b, 0) : g.measureText(text).width;
            let x0 = (al & 6) === 6 ? rx - total / 2 : (al & 6) === 2 ? rx - total : rx;
            g.translate(x0, ry);
            if (f?.esc) g.rotate((-f.esc / 10) * Math.PI / 180);
            if (dx) { let x = 0; for (let i = 0; i < text.length; i++) { g.textAlign = "left"; g.fillText(text[i], x, 0); x += dx[i] ?? 0; } }
            else { g.textAlign = "left"; g.fillText(text, 0, 0); }
          });
          break;
        }
        case 14: off = bytes.length; break;
        default: break;
      }
    } catch { /* one bad record does not spoil the picture */ }
    off += size;
  }
  return await new Promise<Blob | undefined>((ok) => cv.toBlob((b) => ok(b ?? undefined), "image/png"));
}

/** A chart part (c:chartSpace) → an SVG picture of w×h points: bars / columns (clustered, stacked, 100 %), lines, areas, pies and doughnuts. */
function chartToSvg(cs: XEl, w: number, h: number, cx: Ctx): string | undefined {
  const chart = xkid(cs, "c:chart");
  const plot = xkid(chart, "c:plotArea");
  if (!plot) return undefined;
  const font = webFont(cx.th.minor).stack.replace(/"/g, "'");
  const accents = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map((a) => `#${cx.th.colors[a] ?? "4472C4"}`);
  const fmt = (v: number, code?: string) => {
    if (!Number.isFinite(v)) return "";
    if (code && /%/.test(code)) return `${(v * 100).toLocaleString("es-ES", { maximumFractionDigits: /0\.0/.test(code) ? 1 : 0 })}%`;
    const dec = code ? (/0\.(0+)/.exec(code)?.[1].length ?? 0) : Math.abs(v) < 10 && v % 1 ? 1 : 0;
    const n = v.toLocaleString("es-ES", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return code && /€/.test(code) ? `${n} €` : n;
  };
  const cache = (ref: XEl | undefined) => {
    const c = xfind(ref ?? xel("#"), (e) => e.name === "c:strCache" || e.name === "c:numCache")[0];
    const n = Number(xat(xkid(c, "c:ptCount"), "val") ?? 0);
    const out: string[] = Array(n).fill("");
    xkids(c, "c:pt").forEach((p) => { out[Number(xat(p, "idx") ?? 0)] = xtext(xkid(p, "c:v")); });
    return { vals: out, code: xtext(xkid(c, "c:formatCode")) || undefined };
  };
  const spFill = (sp: XEl | undefined) => { const f = xkid(sp, "a:solidFill") ?? xkid(sp, "a:gradFill"); if (!f) return undefined; return colorOf(clrKid(f.name === "a:gradFill" ? xkids(xkid(f, "a:gsLst"), "a:gs")[0] : f), cx.th, cx.map); };
  const lnFill = (sp: XEl | undefined) => { const l = xkid(sp, "a:ln"); return l && !xkid(l, "a:noFill") ? colorOf(clrKid(xkid(l, "a:solidFill")), cx.th, cx.map) : undefined; };
  const kinds = xels(plot).filter((k) => /^c:(bar|bar3D|line|line3D|area|area3D|pie|pie3D|doughnut|scatter)Chart$/.test(k.name));
  if (!kinds.length) return undefined;
  const title = xfind(xkid(chart, "c:title") ?? xel("#"), (e) => e.name === "a:t").map(xtext).join("");
  const autoDeleted = xat(xkid(chart, "c:autoTitleDeleted"), "val") === "1";
  const legPos = xat(xpath(chart, "c:legend", "c:legendPos"), "val");
  const hasLegend = !!xkid(chart, "c:legend");
  const E = (x: string) => esc(x);
  const parts: string[] = [];
  let top = 6, bottom = h - 6, left = 6, right = w - 6;
  const fs = Math.max(8, Math.min(14, Math.min(w, h) / 22));
  if (title && !autoDeleted) { parts.push(`<text x="${w / 2}" y="${top + fs * 1.2}" text-anchor="middle" font-size="${fs * 1.25}" font-weight="700" fill="#404040">${E(title)}</text>`); top += fs * 2; }
  type Ser = { name: string; cats: string[]; vals: number[]; color: string; line?: string; code?: string; pts: Record<number, string> };
  const allSers: { kind: XEl; sers: Ser[] }[] = kinds.map((kind) => ({
    kind,
    sers: xkids(kind, "c:ser").map((sr, i) => {
      const name = cache(xkid(sr, "c:tx")).vals[0] || `Series ${i + 1}`;
      const cats = cache(xkid(sr, "c:cat") ?? xkid(sr, "c:xVal")).vals;
      const v = cache(xkid(sr, "c:val") ?? xkid(sr, "c:yVal"));
      const sp = xkid(sr, "c:spPr");
      const pts: Record<number, string> = {};
      xkids(sr, "c:dPt").forEach((d) => { const c = spFill(xkid(d, "c:spPr")); if (c) pts[Number(xat(xkid(d, "c:idx"), "val") ?? 0)] = c; });
      const idx = Number(xat(xkid(sr, "c:idx"), "val") ?? i);
      return { name, cats, vals: v.vals.map(Number), color: spFill(sp) ?? lnFill(sp) ?? accents[idx % 6], line: lnFill(sp), code: v.code, pts };
    }),
  }));
  const first = allSers[0];
  const isPie = /pie|doughnut/.test(first.kind.name);
  const cats = first.sers[0]?.cats.length ? first.sers[0].cats : (first.sers[0]?.vals ?? []).map((_, i) => String(i + 1));
  // legend
  const legendItems = isPie ? cats.map((c, i) => ({ name: c, color: first.sers[0]?.pts[i] ?? accents[i % 6] })) : allSers.flatMap((g) => g.sers.map((x) => ({ name: x.name, color: x.color })));
  if (hasLegend && legendItems.length) {
    if (legPos === "r" || legPos === "l") {
      const lw = Math.min(w * 0.3, Math.max(...legendItems.map((it) => it.name.length)) * fs * 0.55 + fs * 2);
      const x0 = legPos === "r" ? w - lw : 6;
      legendItems.forEach((it, i) => { const y = top + (bottom - top) / 2 - (legendItems.length * fs * 1.5) / 2 + i * fs * 1.5; parts.push(`<rect x="${x0}" y="${y}" width="${fs * 0.8}" height="${fs * 0.8}" fill="${E(it.color)}"/><text x="${x0 + fs * 1.2}" y="${y + fs * 0.75}" font-size="${fs}" fill="#595959">${E(it.name)}</text>`); });
      if (legPos === "r") right -= lw; else left += lw;
    } else {
      const y = legPos === "t" ? top + fs : bottom - fs * 0.4;
      const widths = legendItems.map((it) => it.name.length * fs * 0.55 + fs * 2.2);
      let x = w / 2 - widths.reduce((a, b) => a + b, 0) / 2;
      legendItems.forEach((it, i) => { parts.push(`<rect x="${x}" y="${y - fs * 0.75}" width="${fs * 0.8}" height="${fs * 0.8}" fill="${E(it.color)}"/><text x="${x + fs * 1.2}" y="${y}" font-size="${fs}" fill="#595959">${E(it.name)}</text>`); x += widths[i]; });
      if (legPos === "t") top += fs * 2; else bottom -= fs * 2;
    }
  }
  const showVal = (g: XEl) => xat(xpath(g, "c:dLbls", "c:showVal"), "val") === "1" || xkids(g, "c:ser").some((sr) => xat(xpath(sr, "c:dLbls", "c:showVal"), "val") === "1");
  const showPct = (g: XEl) => xat(xpath(g, "c:dLbls", "c:showPercent"), "val") === "1" || xkids(g, "c:ser").some((sr) => xat(xpath(sr, "c:dLbls", "c:showPercent"), "val") === "1");
  if (isPie) {
    const s0 = first.sers[0]; if (!s0) return undefined;
    const tot = s0.vals.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
    const R = Math.min(right - left, bottom - top) / 2 - 4, cxp = (left + right) / 2, cyp = (top + bottom) / 2;
    const hole = /doughnut/.test(first.kind.name) ? R * (Number(xat(xkid(first.kind, "c:holeSize"), "val") ?? 50) / 100) : 0;
    let a0 = ((Number(xat(xkid(first.kind, "c:firstSliceAng"), "val") ?? 0) - 90) * Math.PI) / 180;
    s0.vals.forEach((v, i) => {
      if (!(v > 0)) return;
      const a1 = a0 + (v / tot) * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0;
      const P = (a: number, r: number) => `${(cxp + r * Math.cos(a)).toFixed(2)} ${(cyp + r * Math.sin(a)).toFixed(2)}`;
      const d = hole ? `M${P(a0, R)}A${R} ${R} 0 ${big} 1 ${P(a1, R)}L${P(a1, hole)}A${hole} ${hole} 0 ${big} 0 ${P(a0, hole)}Z` : `M${cxp} ${cyp}L${P(a0, R)}A${R} ${R} 0 ${big} 1 ${P(a1, R)}Z`;
      const col = s0.pts[i] ?? accents[i % 6];
      parts.push(`<path d="${d}" fill="${E(col)}" stroke="#fff" stroke-width="1.2"/>`);
      if (showVal(first.kind) || showPct(first.kind)) { const am = (a0 + a1) / 2, rr = hole ? (R + hole) / 2 : R * 0.62; parts.push(`<text x="${(cxp + rr * Math.cos(am)).toFixed(1)}" y="${(cyp + rr * Math.sin(am) + fs * 0.35).toFixed(1)}" text-anchor="middle" font-size="${fs}" fill="#fff" font-weight="700">${E(showPct(first.kind) ? `${Math.round((v / tot) * 100)}%` : fmt(v, s0.code))}</text>`); }
      a0 = a1;
    });
  } else {
    // value axis range over every series (stacked: over the sums)
    const barG = allSers.find((g) => /bar/.test(g.kind.name));
    const horiz = barG ? xat(xkid(barG.kind, "c:barDir"), "val") === "bar" : false;
    const grouping = (g: XEl) => xat(xkid(g, "c:grouping"), "val") ?? "clustered";
    let vmin = 0, vmax = 0;
    allSers.forEach((g) => {
      const gr = grouping(g.kind);
      if (/stacked/i.test(gr)) cats.forEach((_, i) => { let pos = 0, neg = 0; g.sers.forEach((x) => { const v = x.vals[i] || 0; if (v >= 0) pos += v; else neg += v; }); vmax = Math.max(vmax, gr === "percentStacked" ? 1 : pos); vmin = Math.min(vmin, gr === "percentStacked" ? 0 : neg); });
      else g.sers.forEach((x) => x.vals.forEach((v) => { if (Number.isFinite(v)) { vmax = Math.max(vmax, v); vmin = Math.min(vmin, v); } }));
    });
    const axMax = Number(xat(xfind(plot, (e) => e.name === "c:max")[0], "val") ?? NaN), axMin = Number(xat(xfind(plot, (e) => e.name === "c:min")[0], "val") ?? NaN);
    if (Number.isFinite(axMax)) vmax = axMax; if (Number.isFinite(axMin)) vmin = axMin;
    const span0 = vmax - vmin || 1, mag = Math.pow(10, Math.floor(Math.log10(span0 / 5))), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => span0 / st <= 6) ?? mag * 10;
    if (!Number.isFinite(axMax)) vmax = Math.ceil(vmax / step) * step; if (!Number.isFinite(axMin)) vmin = Math.floor(vmin / step) * step;
    const span = vmax - vmin || 1;
    const axDeleted = (n: string) => xkids(plot, n).every((ax) => xat(xkid(ax, "c:delete"), "val") === "1");
    const valAxOff = axDeleted("c:valAx"), catAxOff = axDeleted("c:catAx") && axDeleted("c:dateAx");
    const code0 = allSers[0].sers[0]?.code;
    const labW = valAxOff ? 0 : Math.max(...[vmin, vmax].map((v) => fmt(v, code0).length)) * fs * 0.6 + 6;
    if (horiz) { left += Math.min(w * 0.35, Math.max(...cats.map((c) => c.length)) * fs * 0.55 + 8); bottom -= valAxOff ? 0 : fs * 1.6; }
    else { left += labW; bottom -= catAxOff ? 0 : fs * 1.8; }
    const gridOn = xkids(plot, "c:valAx").some((ax) => !!xkid(ax, "c:majorGridlines"));
    const vPos = (v: number) => horiz ? left + ((v - vmin) / span) * (right - left) : bottom - ((v - vmin) / span) * (bottom - top);
    for (let v = vmin; v <= vmax + step / 1000; v += step) {
      const p = vPos(v);
      if (gridOn) parts.push(horiz ? `<line x1="${p}" y1="${top}" x2="${p}" y2="${bottom}" stroke="#D9D9D9" stroke-width="0.75"/>` : `<line x1="${left}" y1="${p}" x2="${right}" y2="${p}" stroke="#D9D9D9" stroke-width="0.75"/>`);
      if (!valAxOff) parts.push(horiz ? `<text x="${p}" y="${bottom + fs * 1.2}" text-anchor="middle" font-size="${fs}" fill="#595959">${E(fmt(v, code0))}</text>` : `<text x="${left - 4}" y="${p + fs * 0.35}" text-anchor="end" font-size="${fs}" fill="#595959">${E(fmt(v, code0))}</text>`);
    }
    const nC = Math.max(1, cats.length), band = (horiz ? bottom - top : right - left) / nC;
    if (!catAxOff) cats.forEach((c, i) => { const m = (horiz ? top : left) + band * (i + 0.5); parts.push(horiz ? `<text x="${left - 5}" y="${m + fs * 0.35}" text-anchor="end" font-size="${fs}" fill="#595959">${E(c)}</text>` : `<text x="${m}" y="${bottom + fs * 1.25}" text-anchor="middle" font-size="${fs}" fill="#595959">${E(c.length > 18 ? c.slice(0, 17) + "…" : c)}</text>`); });
    parts.push(horiz ? `<line x1="${vPos(0)}" y1="${top}" x2="${vPos(0)}" y2="${bottom}" stroke="#BFBFBF"/>` : `<line x1="${left}" y1="${vPos(0)}" x2="${right}" y2="${vPos(0)}" stroke="#BFBFBF"/>`);
    for (const g of allSers) {
      const gr = grouping(g.kind), stacked = /stacked/i.test(gr), pct = gr === "percentStacked";
      if (/bar/.test(g.kind.name)) {
        const gap = Number(xat(xkid(g.kind, "c:gapWidth"), "val") ?? 150) / 100, overlap = stacked ? 1 : Number(xat(xkid(g.kind, "c:overlap"), "val") ?? 0) / 100;
        const nS = g.sers.length, bw = band / (gap + (stacked ? 1 : nS - (nS - 1) * overlap));
        cats.forEach((_, i) => {
          let pos = 0, neg = 0;
          const tot = pct ? g.sers.reduce((a, x) => a + Math.abs(x.vals[i] || 0), 0) || 1 : 1;
          g.sers.forEach((x, si) => {
            let v = x.vals[i]; if (!Number.isFinite(v)) return; if (pct) v = v / tot;
            const base = stacked ? (v >= 0 ? pos : neg) : 0;
            if (stacked) { if (v >= 0) pos += v; else neg += v; }
            const a0 = vPos(base), a1 = vPos(base + v);
            const o = (horiz ? top : left) + band * i + (band - (stacked ? bw : bw * (nS - (nS - 1) * overlap))) / 2 + (stacked ? 0 : si * bw * (1 - overlap));
            const col = x.pts[i] ?? x.color;
            parts.push(horiz ? `<rect x="${Math.min(a0, a1).toFixed(1)}" y="${o.toFixed(1)}" width="${Math.abs(a1 - a0).toFixed(1)}" height="${bw.toFixed(1)}" fill="${E(col)}"/>` : `<rect x="${o.toFixed(1)}" y="${Math.min(a0, a1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(a1 - a0).toFixed(1)}" fill="${E(col)}"/>`);
            if (showVal(g.kind)) parts.push(horiz ? `<text x="${(stacked ? (a0 + a1) / 2 : a1 + 4).toFixed(1)}" y="${(o + bw / 2 + fs * 0.35).toFixed(1)}" text-anchor="${stacked ? "middle" : "start"}" font-size="${fs * 0.9}" fill="${stacked ? "#fff" : "#404040"}">${E(fmt(x.vals[i], x.code))}</text>` : `<text x="${(o + bw / 2).toFixed(1)}" y="${(stacked ? (a0 + a1) / 2 + fs * 0.35 : a1 - 4).toFixed(1)}" text-anchor="middle" font-size="${fs * 0.9}" fill="${stacked ? "#fff" : "#404040"}">${E(fmt(x.vals[i], x.code))}</text>`);
          });
        });
      } else {
        // lines / areas (stacked areas add up)
        const acc = cats.map(() => 0);
        g.sers.forEach((x) => {
          const pts = cats.map((_, i) => { const v = x.vals[i]; const base = stacked ? acc[i] : 0; const y = Number.isFinite(v) ? base + v : NaN; if (stacked && Number.isFinite(v)) acc[i] += v; return [left + band * (i + 0.5), vPos(y)] as [number, number]; }).filter(([, y]) => Number.isFinite(y));
          if (!pts.length) return;
          const d = `M${pts.map(([a, b]) => `${a.toFixed(1)} ${b.toFixed(1)}`).join("L")}`;
          if (/area/.test(g.kind.name)) parts.push(`<path d="${d}L${pts[pts.length - 1][0].toFixed(1)} ${vPos(0).toFixed(1)}L${pts[0][0].toFixed(1)} ${vPos(0).toFixed(1)}Z" fill="${E(x.color)}" fill-opacity="0.85"/>`);
          else {
            parts.push(`<path d="${d}" fill="none" stroke="${E(x.line ?? x.color)}" stroke-width="2.25" stroke-linejoin="round"/>`);
            const marker = xat(xpath(xkids(g.kind, "c:ser")[g.sers.indexOf(x)], "c:marker", "c:symbol"), "val");
            if (marker !== "none") pts.forEach(([a, b]) => parts.push(`<circle cx="${a.toFixed(1)}" cy="${b.toFixed(1)}" r="3" fill="${E(x.line ?? x.color)}"/>`));
          }
          if (showVal(g.kind)) pts.forEach(([a, b], i) => parts.push(`<text x="${a.toFixed(1)}" y="${(b - 6).toFixed(1)}" text-anchor="middle" font-size="${fs * 0.9}" fill="#404040">${E(fmt(x.vals[i], x.code))}</text>`));
        });
      }
    }
  }
  const svgDoc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="${(w * 2).toFixed(0)}" height="${(h * 2).toFixed(0)}" font-family="${font}">${parts.join("")}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgDoc)}`;
}
/** "Medium Style 2" (PowerPoint's default table look) in each accent, and the two plain styles. */
const BUILTIN_TABLE_STYLES: Record<string, XEl> = (() => {
  const out: Record<string, XEl> = {};
  const med2 = (id: string, clr: string) => {
    const c = (extra = "") => `<a:schemeClr val="${clr}">${extra}</a:schemeClr>`;
    const lt = `<a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln>`;
    const thick = `<a:ln w="38100"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln>`;
    const strong = (bdr = "") => `<a:tcTxStyle b="on"><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>${bdr}</a:tcBdr><a:fill><a:solidFill>${c()}</a:solidFill></a:fill></a:tcStyle>`;
    const xml = `<a:tblStyle styleId="${id}"><a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left>${lt}</a:left><a:right>${lt}</a:right><a:top>${lt}</a:top><a:bottom>${lt}</a:bottom><a:insideH>${lt}</a:insideH><a:insideV>${lt}</a:insideV></a:tcBdr><a:fill><a:solidFill>${c('<a:tint val="20000"/>')}</a:solidFill></a:fill></a:tcStyle></a:wholeTbl><a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill>${c('<a:tint val="40000"/>')}</a:solidFill></a:fill></a:tcStyle></a:band1H><a:band1V><a:tcStyle><a:tcBdr/><a:fill><a:solidFill>${c('<a:tint val="40000"/>')}</a:solidFill></a:fill></a:tcStyle></a:band1V><a:lastCol>${strong()}</a:lastCol><a:firstCol>${strong()}</a:firstCol><a:lastRow>${strong(`<a:top>${thick}</a:top>`)}</a:lastRow><a:firstRow>${strong(`<a:bottom>${thick}</a:bottom>`)}</a:firstRow></a:tblStyle>`;
    out[id] = xroot(xparse(xml));
  };
  med2("{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}", "dk1");
  med2("{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}", "accent1");
  med2("{21E4AEA4-8DFA-4A89-87EB-49C32662AFE8}", "accent2");
  med2("{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}", "accent3");
  med2("{00A15C55-8517-42AA-B614-E9B94910E393}", "accent4");
  med2("{7DF18680-E054-41AD-8BC1-D1AEF772440D}", "accent5");
  med2("{93296810-A885-4BE3-A3E7-6D5BEEA58F35}", "accent6");
  const grid = `<a:ln w="12700"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln>`;
  out["{5940675A-B579-460E-94D1-54222C63F5DA}"] = xroot(xparse(`<a:tblStyle styleId="{5940675A-B579-460E-94D1-54222C63F5DA}"><a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"/><a:schemeClr val="tx1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left>${grid}</a:left><a:right>${grid}</a:right><a:top>${grid}</a:top><a:bottom>${grid}</a:bottom><a:insideH>${grid}</a:insideH><a:insideV>${grid}</a:insideV></a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl></a:tblStyle>`));
  out["{2D5ABB26-0587-4C30-8999-92F81FD0307C}"] = xroot(xparse(`<a:tblStyle styleId="{2D5ABB26-0587-4C30-8999-92F81FD0307C}"><a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"/><a:schemeClr val="tx1"/></a:tcTxStyle><a:tcStyle><a:tcBdr/><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl></a:tblStyle>`));
  return out;
})();
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
      if (f && ext === "emf" && typeof window !== "undefined") {
        // Excel ranges, charts and icons pasted as metafiles: drawn onto a canvas
        try { const png = await emfToPng(await f.async("uint8array")); return png ? URL.createObjectURL(png) : undefined; } catch { return undefined; }
      }
      const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff" } as any)[ext];
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
  let tbl: Promise<TableStyles> | null = null, dts: Promise<XEl | undefined> | null = null;
  const tableStylesOf = () => (tbl ??= (async () => {
    const m: TableStyles = new Map();
    // PowerPoint's built-in styles are often not written into the file: the common ones are known here
    Object.entries(BUILTIN_TABLE_STYLES).forEach(([id, x]) => m.set(id, x));
    const d = await part("ppt/tableStyles.xml");
    if (d) xkids(xroot(d), "a:tblStyle").forEach((t) => m.set(xat(t, "styleId") ?? "", t));
    return m;
  })());
  const defaultTextStyle = () => (dts ??= (async () => { const d = await part("ppt/presentation.xml"); return d ? xkid(xroot(d), "p:defaultTextStyle") : undefined; })());
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
    // a layout or slide can remap the colours (dark slides: text = light 1…)
    for (const root of [lDoc ? xroot(lDoc) : undefined, xroot(sDoc)]) {
      const ov = xpath(root, "p:clrMapOvr", "a:overrideClrMapping");
      (ov?.attrs ?? []).forEach(([k, v]) => { map[k] = v; });
    }
    const tblStyles = await tableStylesOf();
    const defText = await defaultTextStyle();
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
      const bodyPrs = [xpath(l?.el, "p:txBody", "a:bodyPr"), xpath(m?.el, "p:txBody", "a:bodyPr")].filter(Boolean) as XEl[];
      const spPrs = [xkid(l?.el, "p:spPr"), xkid(m?.el, "p:spPr")].filter(Boolean) as XEl[];
      return { xfrm: xf, lists, body: xkid(l?.el, "p:txBody") ?? xkid(m?.el, "p:txBody"), bodyPrs, spPrs };
    };
    // background: slide → layout → master
    let bg: string | undefined, bgImg: string | undefined;
    for (const [root, rels] of [[sRoot, sRels], [lRoot, lRels], [mRoot, mRels]] as [XEl | undefined, Rel[]][]) {
      const b = xpath(root, "p:cSld", "p:bg");
      if (!b) continue;
      const ctx: Ctx = { zip, th, map, rels, img, tblStyles, defText };
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
      shapes.push(...(await treeShapes(tree, { zip, th, map, rels, img, tblStyles, defText }, layer, { txStyles, ...extra })));
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
  /** more fonts the pages use (free-layout pages from a reference document) */
  webFonts?: string[];
  /** who sends it (parties, footer) */
  company?: string; legalName?: string; vat?: string; address?: string; web?: string; city?: string;
}
export type DocBlockType =
  | "cover" | "text" | "stats" | "cards" | "products" | "services" | "pricing" | "timeline" | "team"
  | "quote" | "image" | "terms" | "cta" | "parties" | "clauses" | "schedule" | "signature" | "slide";
export interface DocItem { id: string; title?: string; text?: string; value?: string; image?: string }
/**
 * One element of a free-layout page ("slide" block): a page reproduced from a
 * PowerPoint slide or a PDF page. Coordinates are in page pixels (the page is
 * `SlideSpec.w` wide, 1280 by default) and scale with the screen.
 */
export interface SlideEl {
  id: string; kind: "text" | "shape" | "image" | "line" | "table";
  x: number; y: number; w: number; h: number; rot?: number; flipH?: boolean; flipV?: boolean;
  /** shape / text box background: a colour or a css gradient */
  fill?: string; radius?: number; ellipse?: boolean; path?: { d: string; w: number; h: number }[];
  /** css border, e.g. "2px solid #0A6F4D" (also the stroke of lines and paths) */
  border?: string; stroke?: { color: string; w: number; dash?: boolean; head?: string; tail?: string; headSz?: string; tailSz?: string };
  /** a PowerPoint preset shape (arrow, chevron, callout…) or connector, drawn as SVG at the element's size */
  geom?: { prst: string; adj?: Record<string, number> };
  /** text that must stay inside its box: when the deal's values make it longer, the type shrinks (PowerPoint "shrink text on overflow") */
  shrink?: boolean;
  /** text box that grows with its text (PowerPoint "resize shape to fit text") */
  autoH?: boolean;
  img?: string; fit?: "cover" | "contain" | "fill"; crop?: { l: number; t: number; r: number; b: number }; pos?: string;
  /** text: styled html (paragraphs and spans with inline styles) with {{tokens}} */
  html?: string; pad?: [number, number, number, number]; valign?: "t" | "ctr" | "b"; vert?: boolean; nowrap?: boolean;
  opacity?: number;
  /** a picture that shows a value of each deal (e.g. "client.logo"); when the deal has none, the client's name in `color` */
  bind?: string; color?: string;
}
export interface SlideSpec { w: number; h: number; bg?: string; bgImg?: string; els: SlideEl[] }
export interface DocBlock {
  id: string; type: DocBlockType;
  eyebrow?: string; title?: string; body?: string; items?: DocItem[]; image?: string;
  layout?: "left" | "right" | "center"; tone?: "light" | "tint" | "dark" | "brand";
  when?: "always" | "product" | "service"; ids?: string[]; hidden?: boolean;
  /** how the block's image sits: cover (fills, crops) or contain (whole picture); pos = css object-position */
  fit?: "cover" | "contain"; pos?: string;
  /** a background picture for the whole section (any block) */
  bg?: string; bgPos?: string;
  /** "slide" blocks: the page reproduced from the reference document */
  slide?: SlideSpec;
}
export interface DocTemplate {
  id?: string | null; name: string; kind: DocKind; lang: DocLang; sectors: string[]; isDefault?: boolean;
  theme: DocTheme; blocks: DocBlock[];
  terms?: { validityDays?: number; paymentDays?: number; annualIncreasePct?: number };
  reference?: { fileName: string; kind: string; at: string } | null;
  /** pictures and logos kept with the template (the image library) */
  assets?: string[];
}
/** A document as one deal has it: the template's blocks copied and edited, values typed by the seller. */
export interface DocInstance { templateId: string | null; blocks: DocBlock[]; values: Record<string, string>; theme?: DocTheme; updatedAt?: string; assets?: string[]; /** built from a file or another deal's document instead of a template */ source?: { name: string; at: string } }

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
  // ---- order form (salesApi ContractTerms) ----
  nonTerminableYears?: number | null;
  lines?: { kind: "product" | "service"; name: string; list: number; discount: number; final: number; years?: number[]; qty?: number | null; recurring?: boolean; discountPct?: number | null }[] | null;
  customer?: { legalName?: string | null; name?: string | null; regNo?: string | null; vat?: string | null; address?: string | null; country?: string | null } | null;
  contactPerson?: { name?: string | null; email?: string | null; phone?: string | null; role?: string | null } | null;
  adminUser?: { name?: string | null; email?: string | null } | null;
  billingFrequency?: string | null; currency?: string | null; termsUrl?: string | null;
  newsletter?: boolean | null; marketingConsent?: boolean | null;
  servicesBilling?: "per_day" | "fixed" | null; servicesTolerancePct?: number | null; servicesNote?: string | null;
  signatories?: { side: "supplier" | "customer"; name: string; role?: string | null; email?: string | null; phone?: string | null }[] | null;
  esignId?: string | null;
}

export const DOC_FONTS = ["Inter", "Manrope", "DM Sans", "Plus Jakarta Sans", "Outfit", "Space Grotesk", "Playfair Display", "Fraunces", "Source Serif 4", "Libre Baskerville", "Arial", "Georgia"];
const GOOGLE_FONTS = new Set(DOC_FONTS.filter((f) => f !== "Arial" && f !== "Georgia"));
const SERIF = /playfair|fraunces|serif|baskerville|georgia|garamond|times/i;
/**
 * Fonts of reference documents → what a browser can show: the font itself when the computer has it,
 * else a free look-alike from Google Fonts (metric-compatible where one exists: Carlito = Calibri,
 * Arimo = Arial, Tinos = Times, Caladea = Cambria).
 */
const FONT_MAP: [RegExp, { stack: string; google?: string; spec?: string; weight?: number }][] = [
  [/^arial[\s-]?black$/i, { stack: "'Arial Black','Archivo Black',Arial,sans-serif", google: "Archivo Black", weight: 900 }],
  [/^arial[\s-]?nova[\s-]?light/i, { stack: "'Arial Nova Light','Arial Nova','Arimo',Arial,sans-serif", google: "Arimo", spec: "ital,wght@0,400;0,700;1,400", weight: 300 }],
  [/^arial[\s-]?nova/i, { stack: "'Arial Nova','Arimo',Arial,sans-serif", google: "Arimo", spec: "ital,wght@0,400;0,700;1,400" }],
  [/^arial[\s-]?narrow/i, { stack: "'Arial Narrow','Archivo Narrow',Arial,sans-serif", google: "Archivo Narrow", spec: "wght@400;700" }],
  [/^(arial|arialmt|helvetica|helvetica[\s-]?neue|liberation[\s-]?sans)$/i, { stack: "Arial,'Arimo',Helvetica,sans-serif", google: "Arimo", spec: "ital,wght@0,400;0,700;1,400;1,700" }],
  [/^calibri[\s-]?light/i, { stack: "'Calibri Light','Carlito',Calibri,sans-serif", google: "Carlito", spec: "ital,wght@0,400;0,700;1,400", weight: 300 }],
  [/^calibri/i, { stack: "Calibri,'Carlito',sans-serif", google: "Carlito", spec: "ital,wght@0,400;0,700;1,400;1,700" }],
  [/^cambria/i, { stack: "Cambria,'Caladea',Georgia,serif", google: "Caladea", spec: "ital,wght@0,400;0,700;1,400" }],
  [/^(times[\s-]?new[\s-]?roman|times|timesnewroman)/i, { stack: "'Times New Roman','Tinos',Times,serif", google: "Tinos", spec: "ital,wght@0,400;0,700;1,400" }],
  [/^georgia/i, { stack: "Georgia,'Gelasio',serif", google: "Gelasio", spec: "ital,wght@0,400;0,700;1,400" }],
  [/^segoe[\s-]?ui[\s-]?(symbol|emoji)/i, { stack: "'Segoe UI Symbol','Apple Symbols','Noto Sans Symbols 2',sans-serif" }],
  [/^segoe[\s-]?ui/i, { stack: "'Segoe UI','Open Sans',system-ui,sans-serif", google: "Open Sans", spec: "ital,wght@0,300;0,400;0,600;0,700;1,400" }],
  [/^(verdana|tahoma|geneva)/i, { stack: "Verdana,Tahoma,'DejaVu Sans',sans-serif" }],
  [/^century[\s-]?gothic/i, { stack: "'Century Gothic','Questrial',sans-serif", google: "Questrial" }],
  [/^gill[\s-]?sans/i, { stack: "'Gill Sans','Gill Sans MT','Lato',sans-serif", google: "Lato", spec: "ital,wght@0,300;0,400;0,700;1,400" }],
  [/^(aptos)/i, { stack: "Aptos,'Inter',sans-serif", google: "Inter", spec: "wght@300;400;600;700;800" }],
  [/^(wingdings|symbol|webdings)/i, { stack: "'Segoe UI Symbol',sans-serif" }],
  [/^(garamond|eb[\s-]?garamond)/i, { stack: "Garamond,'EB Garamond',serif", google: "EB Garamond", spec: "ital,wght@0,400;0,700;1,400" }],
  [/^(franklin[\s-]?gothic)/i, { stack: "'Franklin Gothic Medium','Libre Franklin',sans-serif", google: "Libre Franklin", spec: "wght@400;600;700" }],
  [/^(futura)/i, { stack: "Futura,'Jost',sans-serif", google: "Jost", spec: "wght@400;500;700" }],
];
const SYSTEM_FONTS = /^(system-ui|sans-serif|serif|monospace|-apple-system|blinkmacsystemfont|roboto|courier|courier new|consolas|menlo)$/i;
/** "BCDEEE+Arial-BoldMT" → { family: "Arial", weight: 700 }; reads the subset prefix, PostScript suffixes and style words. */
export function parseFontName(raw: string): { family: string; weight: number; italic: boolean } {
  let n = String(raw || "").replace(/^[A-Z]{6}\+/, "").replace(/,/g, "-");
  const style = (n.match(/[-_ ]?(Bold|Black|Heavy|Semibold|SemiBold|Demi|DemiBold|Medium|Light|Thin|ExtraLight|UltraLight|ExtraBold|Italic|Oblique|BoldItalic|It|MT|PSMT|PS|Regular|Roman|Book)+$/i)?.[0] ?? "");
  let fam = n.slice(0, n.length - style.length).replace(/(PSMT|MT|PS)$/, "");
  const st = style.toLowerCase() + " " + n.toLowerCase();
  // "Arial-Black" keeps "Black" in the family (it's a family of its own)
  if (/^arial$/i.test(fam) && /black/i.test(style)) fam = "Arial Black";
  fam = fam.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  const weight = /black|heavy/.test(st) && !/arial black/i.test(fam) ? 900 : /extrabold|ultrabold/.test(st) ? 800 : /semibold|demibold|demi/.test(st) ? 600 : /bold/.test(st) ? 700 : /medium/.test(st) ? 500 : /extralight|ultralight|thin/.test(st) ? 200 : /light/.test(st) ? 300 : 400;
  return { family: fam || "Arial", weight: /arial black/i.test(fam) ? 900 : weight, italic: /italic|oblique/i.test(n) || /[a-z]It$/.test(n) };
}
/** How a document font is written in css, and which free font to load for it. */
export function webFont(name: string): { stack: string; google?: string; spec?: string; weight?: number } {
  const f = String(name || "").trim().replace(/^['"]|['"]$/g, "");
  const hit = FONT_MAP.find(([re]) => re.test(f));
  if (hit) return hit[1];
  if (!f) return { stack: "Arial,'Arimo',sans-serif", google: "Arimo" };
  if (SYSTEM_FONTS.test(f)) return { stack: `${f},sans-serif` };
  if (DOC_FONTS.includes(f)) return { stack: `'${f}',${SERIF.test(f) ? "Georgia,serif" : "system-ui,sans-serif"}`, google: GOOGLE_FONTS.has(f) ? f : undefined, spec: f === "Space Grotesk" ? "wght@400;500;600;700" : f === "Libre Baskerville" ? "ital,wght@0,400;0,700;1,400" : "wght@400;500;600;700;800" };
  // any other name: the font if installed, else the Google font of that name (most brand fonts are there)
  return { stack: `'${f}',${SERIF.test(f) ? "Georgia,serif" : "Arial,sans-serif"}`, google: /^[A-Za-z][A-Za-z0-9 ]{1,40}$/.test(f) ? f : undefined };
}
/** Google font links of a theme and of the fonts the pages use (one link each: a family Google doesn't have can't break the others). */
export function docFontLinks(theme: DocTheme): string[] {
  const fams = new Map<string, string | undefined>();
  [theme.headingFont, theme.bodyFont, ...(theme.webFonts ?? [])].forEach((f) => { const w = webFont(f); if (w.google) fams.set(w.google, w.spec); });
  return Array.from(fams.entries()).map(([f, spec]) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, "+")}${spec ? `:${spec}` : ""}&display=swap`);
}
const fontStack = (f: string) => webFont(f).stack;

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
  { type: "slide", label: "Free page", hint: "A page laid out freely: text boxes, pictures and shapes where you want them", kinds: ["proposal", "contract"], icon: "M3 5h18v14H3zM7 9h6M7 13h4M15 11h3v4h-3z" },
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
  { key: "contract.increase_pct", label: "Contract: yearly increase %", group: "General", example: "3%" },
  { key: "contract.license.list", label: "Contract: licence list price (year 1)", group: "General", example: "20.000 €" },
  { key: "contract.license.discount", label: "Contract: licence discount", group: "General", example: "−2.000 €" },
  { key: "contract.license.final", label: "Contract: licence final price (year 1)", group: "General", example: "18.000 €" },
  { key: "contract.services.final", label: "Contract: services final price", group: "General", example: "12.000 €" },
  { key: "contract.license.term", label: "Contract: licence over the whole term", group: "General", example: "55.620 €" },
  { key: "contract.ref", label: "Contract: reference", group: "General", example: "KON-2026-014" },
  { key: "contract.total", label: "Contract: total over its whole term", group: "General", example: "68.000 €" },
  { key: "contract.yearN.license", label: "Contract: year N licence", group: "General", example: "18.540 €" },
  { key: "contract.yearN.total", label: "Contract: year N total", group: "General", example: "18.540 €" },
  // ---- order form ----
  { key: "contract.customer.legal", label: "Contract: customer legal name", group: "General", example: "Secuoya Grupo de Comunicación, S.A." },
  { key: "contract.customer.vat", label: "Contract: customer VAT / tax no.", group: "General", example: "A18859520" },
  { key: "contract.customer.reg_no", label: "Contract: customer company reg. no.", group: "General", example: "—" },
  { key: "contract.customer.address", label: "Contract: customer address", group: "General", example: "Gran Vía de Colón 12, 28108 Granada" },
  { key: "contract.customer.country", label: "Contract: customer country", group: "General", example: "Spain" },
  { key: "contract.contact.name", label: "Contract: customer contact person", group: "General", example: "Raul Puche" },
  { key: "contract.contact.email", label: "Contract: contact person e-mail", group: "General", example: "rpuche@cliente.com" },
  { key: "contract.contact.phone", label: "Contract: contact person phone", group: "General", example: "+34 913 717 569" },
  { key: "contract.contact.role", label: "Contract: contact person role", group: "General", example: "CFO" },
  { key: "contract.admin.name", label: "Contract: customer admin user (name)", group: "General", example: "Raul Puche" },
  { key: "contract.admin.email", label: "Contract: customer admin user (e-mail)", group: "General", example: "rpuche@cliente.com" },
  { key: "contract.billing", label: "Contract: billing frequency", group: "General", example: "Annually" },
  { key: "contract.currency", label: "Contract: currency", group: "General", example: "EUR" },
  { key: "contract.payment_days", label: "Contract: payment term (net days)", group: "General", example: "Net 30 days" },
  { key: "contract.one_time", label: "Contract: one-time fees", group: "General", example: "0,00 €" },
  { key: "contract.license.annual_list", label: "Contract: annual list price (all licences)", group: "General", example: "18.775 €" },
  { key: "contract.scope", label: "Contract: scope of services (line by line)", group: "General", example: "Enterprise Accounting Tier · 12.000 € → 9.120 € (−24%)" },
  { key: "contract.non_terminable_years", label: "Contract: non-terminable years", group: "General", example: "3" },
  { key: "contract.renewal", label: "Contract: renewal, in words", group: "General", example: "Renewal will be automatic for 3 years" },
  { key: "contract.renew_years", label: "Contract: renewal years", group: "General", example: "3" },
  { key: "contract.services.billing", label: "Contract: how services are billed", group: "General", example: "Billed per day performed (±25%)" },
  { key: "contract.services.days", label: "Contract: services days", group: "General", example: "23" },
  { key: "contract.services.tolerance", label: "Contract: services days tolerance %", group: "General", example: "25%" },
  { key: "contract.services.note", label: "Contract: services scope note", group: "General", example: "Scope agreed at the kick-off" },
  { key: "contract.terms_url", label: "Contract: general terms URL", group: "General", example: "https://konsolidator.com/legal/" },
  { key: "contract.newsletter", label: "Contract: newsletter (Yes / No)", group: "General", example: "Yes" },
  { key: "contract.marketing", label: "Contract: logo & name may be shown (Yes / No)", group: "General", example: "Yes" },
  { key: "contract.signatory.client.name", label: "Contract: client signatory", group: "General", example: "Raul Puche" },
  { key: "contract.signatory.client.role", label: "Contract: client signatory role", group: "General", example: "CFO" },
  { key: "contract.signatory.client.email", label: "Contract: client signatory e-mail", group: "General", example: "rpuche@cliente.com" },
  { key: "contract.signatory.client2.name", label: "Contract: second client signatory", group: "General", example: "Alfredo Candido" },
  { key: "contract.signatory.us.name", label: "Contract: our signatory", group: "General", example: "Basilio Álvarez" },
  { key: "contract.signatory.us.email", label: "Contract: our signatory e-mail", group: "General", example: "basilio@konsolidator.com" },
  { key: "contract.signatories", label: "Contract: everyone who signs", group: "General", example: "Raul Puche (CFO) · Basilio Álvarez" },
  { key: "contract.esign_id", label: "Contract: e-signature ID", group: "General", example: "15010740" },
];
/** Where a value comes from (the variable palette groups and colours them by it). */
export type DocVarSource = "deal" | "company" | "contact" | "lines" | "contract" | "team" | "provider" | "dates";
export const DOC_VAR_SOURCES: { key: DocVarSource; label: string; color: string; hint: string }[] = [
  { key: "deal", label: "Deal", color: "#2F6FED", hint: "The deal: name, stage, value, dates and your deal custom fields" },
  { key: "company", label: "Company", color: "#7C3AED", hint: "The client company and its custom fields" },
  { key: "contact", label: "Contact", color: "#0E9F8E", hint: "The deal's main contact (or every contact) and contact custom fields" },
  { key: "lines", label: "Products & services", color: "#D97706", hint: "Lines of the proposal — in a product / service block, that line's" },
  { key: "contract", label: "Contract", color: "#DB2777", hint: "The contract terms of the deal: dates, years, increase, prices" },
  { key: "team", label: "Owner & team", color: "#4F46E5", hint: "Who sells it and the deal team" },
  { key: "provider", label: "Your company", color: "#0A6F4D", hint: "Your own company data (Look › Your company)" },
  { key: "dates", label: "Dates", color: "#64748B", hint: "Today, validity and other dates" },
];
export interface DocVarDef { key: string; label: string; source: DocVarSource; example: string; multi?: boolean; custom?: boolean; scoped?: "product" | "service" }
/** Values on top of the deck's and the document's: filled by the deal loader (loadDocVariables). */
const MORE_VARS: DocVarDef[] = [
  { key: "deal.stage", label: "Stage", source: "deal", example: "Proposal" },
  { key: "deal.pipeline", label: "Pipeline", source: "deal", example: "New business" },
  { key: "deal.status", label: "Status", source: "deal", example: "Open" },
  { key: "deal.close_date", label: "Expected close date", source: "deal", example: "30 de noviembre de 2026" },
  { key: "deal.created", label: "Created on", source: "deal", example: "2 de septiembre de 2026" },
  { key: "deal.probability", label: "Close probability", source: "deal", example: "60%" },
  { key: "deal.owner", label: "Deal owner", source: "deal", example: "Laura Gómez" },
  { key: "client.logo", label: "Logo (from the website)", source: "company", example: "" },
  { key: "client.city", label: "City", source: "company", example: "Madrid" },
  { key: "client.country", label: "Country", source: "company", example: "España" },
  { key: "client.postal_code", label: "Postal code", source: "company", example: "28046" },
  { key: "client.website", label: "Website", source: "company", example: "www.cliente.com" },
  { key: "client.sector", label: "Sector", source: "company", example: "Retail" },
  { key: "client.source", label: "Source", source: "company", example: "Event" },
  { key: "client.phone", label: "Phone", source: "company", example: "+34 910 000 000" },
  { key: "client.email", label: "Email", source: "company", example: "info@cliente.com" },
  { key: "client.linkedin", label: "LinkedIn page", source: "company", example: "linkedin.com/company/cliente" },
  { key: "client.contact.first_name", label: "First name", source: "contact", example: "Ana" },
  { key: "client.contact.last_name", label: "Last name", source: "contact", example: "García" },
  { key: "client.contact.phone", label: "Phone", source: "contact", example: "+34 600 000 000" },
  { key: "client.contact.linkedin", label: "LinkedIn", source: "contact", example: "linkedin.com/in/ana" },
  { key: "contacts.list", label: "Every contact (one per line)", source: "contact", example: "Ana García · CFO ⏎ Luis Pérez · CIO", multi: true },
  { key: "contacts.names", label: "Every contact's name", source: "contact", example: "Ana García, Luis Pérez" },
  { key: "products.list", label: "Every product (one per line)", source: "lines", example: "Konsolidator Suite ⏎ Data Management", multi: true },
  { key: "services.list", label: "Every service (one per line)", source: "lines", example: "Implantación ⏎ Formación", multi: true },
  { key: "team.list", label: "Deal team (one per line)", source: "team", example: "Laura Gómez · Account Executive ⏎ …", multi: true },
  { key: "team.names", label: "Deal team names", source: "team", example: "Laura Gómez, Pablo Ruiz" },
  { key: "today", label: "Today (dd/mm/yyyy)", source: "dates", example: "22/10/2026" },
  { key: "year", label: "Year", source: "dates", example: "2026" },
];
const sourceOf = (key: string): DocVarSource => {
  if (/^deal\.cf\./.test(key)) return "deal";
  if (/^company\.cf\./.test(key)) return "company";
  if (/^contact\.cf\./.test(key)) return "contact";
  if (/^(client\.contact|contacts\.)/.test(key)) return "contact";
  if (/^client/.test(key)) return "company";
  if (/^(deal|proposal|value|total)/.test(key)) return "deal";
  if (/^(product|service|agenda|products|services)/.test(key)) return "lines";
  if (/^(contract|terms)/.test(key)) return "contract";
  if (/^(seller|team)/.test(key)) return "team";
  if (/^provider/.test(key)) return "provider";
  return "dates";
};
/** The custom fields of deals, companies and contacts as variables (set when the editor loads them). */
let CUSTOM_VARS: DocVarDef[] = [];
export function setDocCustomVars(defs: DocVarDef[]) { CUSTOM_VARS = defs.map((d) => ({ ...d, custom: true })); }
export const docCustomVars = () => CUSTOM_VARS;
/** Every built-in variable with its source. */
export function docBuiltinVars(): DocVarDef[] {
  const base: DocVarDef[] = [...DECK_TOKENS.filter((t) => t.group !== "Repeat rows" && t.key !== "num"), ...DOC_EXTRA_TOKENS].map((t) => ({
    key: t.key, label: t.label, source: sourceOf(t.key), example: t.example, multi: t.multi,
    scoped: t.group === "Product" ? "product" : t.group === "Service" ? "service" : undefined,
  }));
  const seen = new Set(base.map((b) => b.key));
  return [...base, ...MORE_VARS.filter((m) => !seen.has(m.key))];
}
/** The palette: every variable grouped by where it comes from (custom fields last in their group). */
export function docVarCatalog(kind: DocKind): { source: DocVarSource; label: string; color: string; hint: string; vars: DocVarDef[] }[] {
  const all = [...docBuiltinVars(), ...CUSTOM_VARS];
  const order: DocVarSource[] = kind === "contract" ? ["company", "contact", "contract", "deal", "provider", "lines", "team", "dates"] : ["deal", "company", "contact", "lines", "contract", "team", "provider", "dates"];
  return order.map((k) => {
    const src = DOC_VAR_SOURCES.find((x) => x.key === k)!;
    return { source: k, label: src.label, color: src.color, hint: src.hint, vars: all.filter((v) => v.source === k) };
  });
}
export const docVarColor = (key: string) => DOC_VAR_SOURCES.find((x) => x.key === sourceOf(key))?.color ?? "#12B57F";
export const docVarSourceOf = sourceOf;
/** Every value a document can use, grouped for the variable palette. */
export function docTokenGroups(kind: DocKind): { group: string; tokens: DeckTokenDef[] }[] {
  return docVarCatalog(kind).map((g) => ({ group: g.label, tokens: g.vars.map((v) => ({ key: v.key, label: v.label, group: "General" as const, example: v.example, multi: v.multi })) }));
}
export const docTokenLabel = (key: string) => {
  const custom = CUSTOM_VARS.find((t) => t.key === key);
  if (custom) return custom.label;
  if (/^(deal|company|contact)\.cf\./.test(key)) return key.replace(/^(\w+)\.cf\./, "$1 · ");
  const k = key.replace(/\d+/g, "N");
  return [...DOC_EXTRA_TOKENS, ...DECK_TOKENS, ...MORE_VARS].find((t) => t.key === k)?.label ?? key;
};
/** Sample values for every variable (editing templates with no deal). */
export function docSampleValues(): Record<string, string> {
  const out: Record<string, string> = {};
  [...MORE_VARS, ...CUSTOM_VARS].forEach((v) => { out[v.key] = v.example.replace(/ ⏎ /g, "\n"); });
  return out;
}

const rid = () => Math.random().toString(36).slice(2, 10);
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ----------------------------------------------------------- values -----
export interface DocContext extends DeckContext {
  theme: DocTheme;
  terms?: DocTemplate["terms"];
  contract?: ContractTerms | null;
  /** The value the deal shows (potential revenue); else the proposal total. */
  dealValue?: number | null;
  /** More values: deal / company / contact data and custom fields (loadDocVariables), keyed by token. */
  extra?: Record<string, string> | null;
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
  const incPct = inc && inc.mode === "pct" && Number(inc.value) ? `${deckNum(Number(inc.value))}%` : "";
  return { rows, years, lic1, licList, licTerm, svc, incText, incPct, total };
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
    "contract.years": String(sch.years), "contract.increment": sch.incText(lang), "contract.increase_pct": sch.incPct,
    "contract.license.list": deckMoney(sch.licList), "contract.license.discount": sch.licList > sch.lic1 ? deckMoney(sch.lic1 - sch.licList) : "",
    "contract.license.final": deckMoney(sch.lic1), "contract.services.final": deckMoney(sch.svc), "contract.total": deckMoney(sch.total),
  });
  sch.rows.forEach((r) => { v[`contract.year${r.year}.license`] = deckMoney(r.license); v[`contract.year${r.year}.total`] = deckMoney(r.total); });
  // ---- order form ----
  if (c) {
    const es = lang === "es";
    const yn = (b: boolean | null | undefined) => (b == null ? "" : b ? (es ? "Sí" : "Yes") : "No");
    const freq: Record<string, [string, string]> = { annually: ["Anual", "Annually"], quarterly: ["Trimestral", "Quarterly"], monthly: ["Mensual", "Monthly"], upfront: ["Por adelantado", "Upfront"] };
    const signers = c.signatories ?? [];
    const cl = signers.filter((x) => x.side === "customer"), us = signers.filter((x) => x.side === "supplier");
    const lines = c.lines ?? [];
    const svcDays = lines.filter((l) => l.kind === "service").reduce((a, l) => a + (Number(l.qty) || 0), 0);
    const oneTime = lines.filter((l) => l.kind === "product" && l.recurring === false).reduce((a, l) => a + (Number(l.final) || 0), 0);
    Object.assign(v, {
      "contract.customer.legal": c.customer?.legalName || c.customer?.name || d.client.name || "",
      "contract.customer.vat": c.customer?.vat || d.client.vat || "", "contract.customer.reg_no": c.customer?.regNo || "",
      "contract.customer.address": c.customer?.address || d.client.address || "", "contract.customer.country": c.customer?.country || "",
      "contract.contact.name": c.contactPerson?.name || "", "contract.contact.email": c.contactPerson?.email || "",
      "contract.contact.phone": c.contactPerson?.phone || "", "contract.contact.role": c.contactPerson?.role || "",
      "contract.admin.name": c.adminUser?.name || "", "contract.admin.email": c.adminUser?.email || "",
      "contract.billing": c.billingFrequency ? (freq[c.billingFrequency]?.[es ? 0 : 1] ?? c.billingFrequency) : "",
      "contract.currency": c.currency || "EUR",
      "contract.payment_days": c.paymentTermsDays != null ? (es ? `${c.paymentTermsDays} días` : `Net ${c.paymentTermsDays} days`) : "",
      "contract.one_time": deckMoney(oneTime),
      "contract.license.annual_list": deckMoney(lines.filter((l) => l.kind === "product" && l.recurring !== false).reduce((a, l) => a + (Number(l.list) || 0) / Math.max(1, (l.years ?? []).length || 1), 0)),
      "contract.scope": lines.map((l) => `${l.name} · ${deckMoney(l.list)}${l.discount ? ` → ${deckMoney(l.final)} (−${l.discountPct ?? Math.round((l.discount / Math.max(1, l.list)) * 100)}%)` : ""}`).join("\n"),
      "contract.non_terminable_years": c.nonTerminableYears ? String(c.nonTerminableYears) : "",
      "contract.renew_years": c.autoRenew ? String(c.renewYears ?? c.termYears ?? "") : "",
      "contract.renewal": c.autoRenew ? (es ? `Renovación automática por ${c.renewYears ?? c.termYears} años` : `Renewal will be automatic for ${c.renewYears ?? c.termYears} years`) : (es ? "Sin renovación automática" : "No automatic renewal"),
      "contract.services.billing": c.servicesBilling === "fixed" ? (es ? "Precio cerrado" : "Fixed fee")
        : c.servicesBilling === "per_day" ? (es ? `Se factura por día realizado${c.servicesTolerancePct ? ` (±${c.servicesTolerancePct}%)` : ""}` : `Billed per day performed${c.servicesTolerancePct ? ` (±${c.servicesTolerancePct}%)` : ""}`) : "",
      "contract.services.days": svcDays ? String(svcDays) : "",
      "contract.services.tolerance": c.servicesTolerancePct != null ? `${c.servicesTolerancePct}%` : "",
      "contract.services.note": c.servicesNote || "",
      "contract.terms_url": c.termsUrl || "", "contract.newsletter": yn(c.newsletter), "contract.marketing": yn(c.marketingConsent),
      "contract.signatory.client.name": cl[0]?.name || "", "contract.signatory.client.role": cl[0]?.role || "", "contract.signatory.client.email": cl[0]?.email || "",
      "contract.signatory.client2.name": cl[1]?.name || "",
      "contract.signatory.us.name": us[0]?.name || "", "contract.signatory.us.email": us[0]?.email || "",
      "contract.signatories": signers.map((x) => `${x.name}${x.role ? ` (${x.role})` : ""}`).join(" · "),
      "contract.esign_id": c.esignId || "",
    });
  }
  const now = new Date();
  v.today = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;
  v.year = String(now.getFullYear());
  v["products.list"] = d.products.map((p) => p.name).join("\n");
  v["services.list"] = d.services.map((x) => x.name).join("\n");
  Object.entries(ctx.extra ?? {}).forEach(([k, val]) => { if (val != null && (v[k] == null || v[k] === "")) v[k] = String(val); });
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
const SLIDE_TAGS = /^(p|div|span|b|strong|i|em|u|s|br|ul|ol|li|a|sup|sub|table|thead|tbody|tr|td|th|colgroup|col)$/i;
const SLIDE_CSS = /^(color|background|background-color|font-size|font-family|font-weight|font-style|font-variant|text-decoration|text-align|line-height|letter-spacing|text-transform|margin|margin-(top|right|bottom|left)|padding|padding-(top|right|bottom|left)|text-indent|vertical-align|border|border-(top|right|bottom|left)|border-collapse|width|height|white-space|list-style|list-style-type|display|min-width|max-width|position|top|left|opacity)$/i;
/** Keeps the look of text reproduced from a slide or page: paragraphs and spans with safe inline styles, tables, and the {{tokens}}. */
export function cleanSlideRich(html: string): string {
  const style = (attrs: string) => {
    const m = /style\s*=\s*"([^"]*)"/i.exec(attrs) ?? /style\s*=\s*'([^']*)'/i.exec(attrs);
    if (!m) return "";
    const keep = m[1].replace(/&quot;/g, "'").split(";").map((d) => d.trim()).filter((d) => {
      const i = d.indexOf(":"); if (i < 1) return false;
      const k = d.slice(0, i).trim(), v = d.slice(i + 1).trim();
      if (/^position$/i.test(k) && v !== "relative") return false;
      return SLIDE_CSS.test(k) && !/url\(|expression|javascript:|@import/i.test(v);
    });
    return keep.length ? ` style="${keep.join(";").replace(/"/g, "'")}"` : "";
  };
  return String(html ?? "")
    .replace(/<\s*(script|style|iframe|object|embed|svg|math)[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(\/?)\s*([a-z0-9]+)([^>]*)>/gi, (_m, close: string, tag: string, attrs: string) => {
      if (!SLIDE_TAGS.test(tag)) return "";
      const t = tag.toLowerCase();
      if (close) return `</${t}>`;
      if (t === "br") return "<br>";
      let extra = "";
      if (t === "a") { const h = /href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? ""; if (/^(https?:|mailto:|tel:)/i.test(h)) extra += ` href="${esc(h)}"`; }
      if (t === "td" || t === "th") { const cs = /colspan\s*=\s*"?(\d+)/i.exec(attrs)?.[1]; const rs = /rowspan\s*=\s*"?(\d+)/i.exec(attrs)?.[1]; if (cs) extra += ` colspan="${cs}"`; if (rs) extra += ` rowspan="${rs}"`; }
      return `<${t}${style(attrs)}${extra}>`;
    })
    .replace(/\u00a0/g, "&nbsp;")
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
function fieldHtml(raw: string | undefined, vals: Record<string, string>, o: DocRenderOptions, rich: boolean | "slide"): string {
  let s = String(raw ?? "");
  if (rich === "slide") {
    s = cleanSlideRich(s);
    s = s.replace(/<(p|li)\b([^>]*)>([\s\S]*?)<\/\1>/g, (m, _t, _a, inner: string) => (condFails(inner, (k) => vals[k]) ? "" : m));
  } else if (rich) {
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
    const txt = o.chipsAsLabels ? esc(label) : shown || esc(label);
    return `<span class="tk${o.chipsAsLabels ? " is-label" : ""}${!o.chipsAsLabels && !shown ? " is-empty" : ""}" contenteditable="false" data-tk="${esc(k)}" style="--tc:${docVarColor(k)}" title="{{${esc(k)}}} · ${esc(DOC_VAR_SOURCES.find((x) => x.key === sourceOf(k))?.label ?? "")}">${txt}</span>`;
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
  const links = docFontLinks(theme);
  const fontLink = links.length ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>${links.map((h) => `<link rel="stylesheet" class="dx-font" href="${esc(h)}">`).join("")}` : "";
  const slides = o.placed.length > 0 && o.placed.every((p) => p.block.type === "slide");
  const s0 = slides ? o.placed[0].block.slide : undefined;
  const pageCss = slides && s0 ? `@page{size:${s0.w}px ${s0.h}px;margin:0}` : "";
  const body = renderDocBody(theme, o);
  const nav = o.mode === "view" ? `<div class="dp-progress"><i></i></div><nav class="dp-dots">${o.placed.filter((p) => p.block.type !== "signature").map((p, i) => `<a href="#b-${esc(p.key)}" title="${esc(richToText(fieldHtml(p.block.title || docBlockMeta(p.block.type).label, o.valuesFor(p), { ...o, mode: "view" }, false)))}"><i></i></a>`.replace("<a ", i === 0 ? '<a class="is-on" ' : "<a ")).join("")}</nav>` : "";
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title ?? "Proposal")}</title>${fontLink}<style id="dx-css">${docCss(theme)}</style>${pageCss ? `<style>${pageCss}</style>` : ""}</head><body class="dm-${o.mode} st-${theme.style ?? "soft"} k-${o.kind}${slides ? " k-slides" : ""}">${nav}<main id="doc">${body}</main><script>${SL_JS}</script>${o.mode === "view" ? `<script>${DOC_JS}</script>` : ""}</body></html>`;
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
    const fitCss = `${b.fit ? `object-fit:${b.fit};` : ""}${b.pos ? `object-position:${esc(b.pos)};` : ""}`;
    const img = (src?: string, cls = "") => (src ? `<img class="${cls}" src="${esc(src)}" alt=""${fitCss ? ` style="${fitCss}"` : ""}>` : "");
    let inner = "";
    switch (b.type) {
      case "cover": {
        const logo = theme.logo || theme.logoDark;
        inner = `<div class="cv-bg">${b.image ? `<div class="cv-img" style="background-image:url('${esc(b.image)}');${b.fit === "contain" ? "background-size:contain;background-repeat:no-repeat;" : ""}${b.pos ? `background-position:${esc(b.pos)};` : ""}"></div>` : ""}<i class="cv-o o1"></i><i class="cv-o o2"></i><i class="cv-o o3"></i><div class="cv-grid"></div></div>
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
      case "slide":
        inner = slideHtml(b, vals, o);
        break;
      case "signature": {
        const l = lang === "es" ? ["Por", "Firma", "Nombre y cargo", "Fecha"] : ["For", "Signature", "Name and title", "Date"];
        const box = (who: string) => `<div class="sg-b"><span class="sg-k">${l[0]} ${esc(who)}</span><div class="sg-line"></div><span class="sg-l">${l[1]}</span><div class="sg-line s"></div><span class="sg-l">${l[2]}</span><div class="sg-line s"></div><span class="sg-l">${l[3]}</span></div>`;
        inner = `<div class="wrap sg rv">${f("title", false, "h2", "h2")}${f("body", true, "rt sg-x")}<div class="sg-grid">${box(vals["provider.legal"] || vals["provider.name"] || "—")}${box(vals["client.legal"] || vals.client || "—")}</div></div>`;
        break;
      }
    }
    const tools = ed ? `<div class="dx-tools" contenteditable="false"><span class="dx-tl">${esc(docBlockMeta(b.type).label)}${p.who ? ` · ${esc(p.who)}` : ""}${b.hidden ? " · hidden" : ""}</span><button data-act="up" data-b="${b.id}" title="Move up">↑</button><button data-act="down" data-b="${b.id}" title="Move down">↓</button><button data-act="dup" data-b="${b.id}" title="Duplicate">⧉</button><button data-act="hide" data-b="${b.id}" title="${b.hidden ? "Show" : "Hide"}">${b.hidden ? "◌" : "◉"}</button><button data-act="del" data-b="${b.id}" title="Delete" class="is-del">✕</button></div><button class="dx-ins" data-act="insert" data-at="${b.id}" contenteditable="false" title="Add a block here">+</button>` : "";
    const bgLayer = b.bg && b.type !== "slide" ? `<div class="blk-bg" style="background-image:url('${esc(b.bg)}');${b.bgPos ? `background-position:${esc(b.bgPos)};` : ""}"></div>` : "";
    return `<section id="b-${esc(p.key)}" class="blk t-${b.type} tone-${tone}${bgLayer ? " has-bg" : ""}${ed && o.selected === b.id ? " is-sel" : ""}${b.hidden ? " is-hidden" : ""}" data-b="${b.id}">${bgLayer}${tools}${inner}</section>`;
  }).join("\n");
}
const r1 = (n: number) => Math.round(n * 10) / 10;
/** A free-layout page: every element absolutely placed in page pixels; the page scales to the screen (SL_JS). */
function slideHtml(b: DocBlock, vals: Record<string, string>, o: DocRenderOptions): string {
  const sp = b.slide ?? { w: 1280, h: 720, els: [] };
  const ed = o.mode === "edit";
  const els = sp.els.map((e, i) => {
    const tr = [e.rot ? `rotate(${r1(e.rot)}deg)` : "", e.flipH ? "scaleX(-1)" : "", e.flipV ? "scaleY(-1)" : ""].filter(Boolean).join(" ");
    let st = `left:${r1(e.x)}px;top:${r1(e.y)}px;width:${r1(Math.max(1, e.w))}px;height:${r1(Math.max(1, e.h))}px;${tr ? `transform:${tr};` : ""}${e.opacity != null && e.opacity < 1 ? `opacity:${e.opacity};` : ""}`;
    const box = `${e.fill ? `background:${esc(e.fill)};` : ""}${e.border ? `border:${esc(e.border)};` : ""}${e.ellipse ? "border-radius:50%;" : e.radius ? `border-radius:${r1(e.radius)}px;` : ""}`;
    let inner = "";
    if (e.kind === "image" && e.bind) {
      // the deal's own picture (the client's logo); none → the client's name, written in the box
      st += box + "overflow:hidden;";
      const bound = String(vals[e.bind] ?? "").trim();
      const name = String(vals["client"] ?? "").trim();
      const fs = r1(Math.max(10, Math.min(e.h * 0.5, (e.w * 0.92) / Math.max(4, name.length * 0.62))));
      const ok = /^(https?:|data:image\/)/i.test(bound);
      inner = (ok ? `<img src="${esc(bound)}" alt="${esc(name)}" draggable="false" style="width:100%;height:100%;box-sizing:border-box;padding:${e.fill ? "7% 8%" : "0"};object-fit:contain;object-position:${esc(e.pos ?? "50% 50%")}" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='flex'">` : "")
        + `<span class="se-bind-t" style="display:${ok ? "none" : "flex"};color:${esc(e.color ?? "#111111")};font-size:${fs}px">${esc(name || (ed ? "Client" : ""))}</span>`
        + (ed ? `<span class="se-bind" contenteditable="false">{ } ${esc(docTokenLabel(e.bind))}</span>` : "");
    } else if (e.kind === "image") {
      st += box + "overflow:hidden;";
      if (e.img) {
        const c = e.crop;
        if (c && (c.l || c.t || c.r || c.b)) {
          const fw = Math.max(0.01, 1 - c.l - c.r), fh = Math.max(0.01, 1 - c.t - c.b);
          inner = `<img src="${esc(e.img)}" alt="" draggable="false" style="position:absolute;max-width:none;left:${r1((-c.l / fw) * 100)}%;top:${r1((-c.t / fh) * 100)}%;width:${r1(100 / fw)}%;height:${r1(100 / fh)}%">`;
        } else inner = `<img src="${esc(e.img)}" alt="" draggable="false" style="width:100%;height:100%;object-fit:${e.fit ?? "fill"};object-position:${esc(e.pos ?? "50% 50%")}">`;
      } else if (ed) inner = `<span class="se-ph">Drop a picture</span>`;
    } else if (e.kind === "shape" && e.geom && !CSS_GEOMS.test(e.geom.prst)) {
      inner = isConnectorGeom(e.geom.prst) ? connectorSvg(e.geom, e.w, e.h, e.stroke ?? { color: "#000", w: 1 }) : geomSvg(e.geom, e.w, e.h, e.fill, e.stroke);
    } else if (e.kind === "shape") {
      if (e.path?.length) {
        const stroke = e.stroke ? `stroke="${esc(e.stroke.color)}" stroke-width="${r1(e.stroke.w)}"${e.stroke.dash ? ' stroke-dasharray="6 4"' : ""} vector-effect="non-scaling-stroke"` : 'stroke="none"';
        inner = `<svg viewBox="0 0 ${e.path[0].w} ${e.path[0].h}" preserveAspectRatio="none" width="100%" height="100%" style="overflow:visible">${e.path.map((pt) => `<path d="${esc(pt.d)}" fill="${esc(e.fill && !/gradient/.test(e.fill) ? e.fill : e.fill ? "#888" : "none")}" ${stroke}/>`).join("")}</svg>`;
      } else st += box;
    } else if (e.kind === "line" && e.geom) {
      inner = connectorSvg(e.geom, e.w, e.h, e.stroke ?? { color: "#000", w: 1 });
    } else if (e.kind === "line") {
      const c = e.stroke ?? { color: "#000", w: 1 };
      inner = `<svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100" style="overflow:visible"><line x1="0" y1="${e.flipV ? 100 : 0}" x2="100" y2="${e.flipV ? 0 : 100}" stroke="${esc(c.color)}" stroke-width="${r1(c.w)}" vector-effect="non-scaling-stroke"${c.dash ? ' stroke-dasharray="6 4"' : ""}/></svg>`;
    } else {
      const pd = e.pad ?? [6, 8, 6, 8];
      // a text box in an arrow / chevron / callout: the shape is drawn behind the text
      const drawn = e.kind === "text" && e.geom && !CSS_GEOMS.test(e.geom.prst);
      st += `${drawn ? "" : box}display:flex;flex-direction:column;justify-content:${e.valign === "b" ? "flex-end" : e.valign === "ctr" ? "center" : "flex-start"};padding:${pd.map((x) => `${r1(x)}px`).join(" ")};`;
      const html = fieldHtml(e.html, vals, o, "slide");
      const bgSvg = drawn ? geomSvg(e.geom!, e.w, e.h, e.fill, e.stroke ?? (e.border ? borderStroke(e.border) : undefined)) : "";
      inner = `${bgSvg}<div class="se-tx${ed ? " ed" : ""}"${ed ? ` contenteditable="true" data-f="${b.id}|els|${i}|html" data-rich="2" data-ph="Type…"` : ""}${ed || e.autoH || e.vert ? "" : e.shrink ? ' data-shrink="1"' : ' data-shrink="2"'} style="${drawn ? "position:relative;" : ""}${e.nowrap ? "white-space:nowrap;" : ""}${e.vert ? "writing-mode:vertical-rl;" : ""}">${html}</div>`;
    }
    const tools = ed ? `<i class="se-h se-mv" data-el="mv" title="Drag to move" contenteditable="false"></i><i class="se-h se-rs" data-el="rs" title="Drag to resize" contenteditable="false"></i><button class="se-x" data-act="el-del" data-b="${b.id}" data-k="${i}" title="Delete this element" contenteditable="false">×</button>` : "";
    return `<div class="se se-${e.kind}" data-i="${i}" style="${st}${ed ? "" : `transition-delay:${Math.min(i, 24) * 28}ms;`}">${inner}${tools}</div>`;
  }).join("");
  const bg = `background:${esc(sp.bg || "#FFFFFF")};${sp.bgImg ? `background-image:url('${esc(sp.bgImg)}');background-size:cover;background-position:center;` : ""}`;
  return `<div class="sl rv" data-w="${sp.w}" data-h="${sp.h}" data-b="${b.id}" style="aspect-ratio:${sp.w}/${sp.h};${bg}"><div class="sl-in" style="width:${sp.w}px;height:${sp.h}px">${els}</div></div>`;
}
/** Scales every free-layout page to its box (all modes: the editor swaps the html, so it watches). */
const SL_JS = `(function(){function hit(t,b){var r=t.getBoundingClientRect(),q=b.getBoundingClientRect(),zs=[],sl=t.closest('.sl')||document;if(r.top<q.top-2)zs.push([r.top,q.top]);if(r.bottom>q.bottom+2)zs.push([q.bottom,r.bottom]);if(!zs.length)return false;var o=sl.querySelectorAll('.se-tx');for(var i=0;i<o.length;i++){var u=o[i];if(u===t||!u.textContent.trim())continue;var v=u.getBoundingClientRect();if(v.right<=r.left+1||v.left>=r.right-1)continue;for(var k=0;k<zs.length;k++)if(v.bottom>zs[k][0]+1&&v.top<zs[k][1]-1)return true}return false}function shrink(){var a=document.querySelectorAll('.se-tx[data-shrink]');for(var i=0;i<a.length;i++){var t=a[i],b=t.parentElement;if(!b)continue;t.style.transform='';t.style.width='';t.style.marginBottom='';t.style.overflowWrap='normal';var cs=getComputedStyle(b),av=b.clientHeight-parseFloat(cs.paddingTop||0)-parseFloat(cs.paddingBottom||0),loose=t.getAttribute('data-shrink')==='2',ow=t.scrollWidth>t.clientWidth+1,oh=t.scrollHeight>av+(loose?6:2);if(oh&&loose&&!ow&&!hit(t,b))oh=false;if(!oh&&!ow){t.style.overflowWrap='';continue}var z=1;t.style.transformOrigin='0 0';while(z>0.42){z-=0.02;t.style.width=(100/z)+'%';t.style.transform='scale('+z+')';if((!oh||t.scrollHeight*z<=av+1)&&t.scrollWidth<=t.clientWidth+1)break}if(t.scrollWidth>t.clientWidth+1)t.style.overflowWrap='';t.style.marginBottom=(-t.scrollHeight*(1-z))+'px'}}try{shrink();addEventListener('load',shrink);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(shrink)}catch(e){}function fit(){var a=document.querySelectorAll('.sl');for(var i=0;i<a.length;i++){var s=a[i],n=s.firstElementChild;if(!n)continue;var k=s.clientWidth/(+s.getAttribute('data-w')||1280);if(n.__k!==k){n.__k=k;n.style.transform='scale('+k+')';}}}var t=0;function soon(){if(t)return;t=requestAnimationFrame(function(){t=0;fit()})}fit();addEventListener('load',fit);addEventListener('resize',soon);try{new ResizeObserver(soon).observe(document.documentElement);new MutationObserver(soon).observe(document.body,{childList:true,subtree:true})}catch(e){}})();`;
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
.tk{background:color-mix(in srgb,var(--tc,var(--a)) 16%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tc,var(--a)) 50%,transparent)}.tk.is-label{color:var(--tc,inherit)}.tk.is-label:before{color:var(--tc,inherit)}
/* section background picture */
.blk.has-bg>.wrap,.blk.has-bg>figure,.blk.has-bg>.cv-in{position:relative;z-index:1}.blk>.blk-bg{position:absolute;inset:0;z-index:0;background-size:cover;background-position:center}.blk>.blk-bg:after{content:"";position:absolute;inset:0}
.tone-light>.blk-bg:after{background:rgba(255,255,255,.84)}.tone-tint>.blk-bg:after{background:color-mix(in srgb,var(--paper) 86%,transparent)}.tone-dark>.blk-bg:after{background:color-mix(in srgb,var(--ink) 74%,transparent)}.tone-brand>.blk-bg:after{background:linear-gradient(135deg,color-mix(in srgb,var(--p) 86%,transparent),color-mix(in srgb,var(--ink) 70%,transparent))}
.dm-edit .blk.has-bg>.dx-tools{z-index:20}
/* free-layout pages (from a slide or a PDF page) */
.t-slide{padding:26px 0;background:transparent}.t-slide .sl{position:relative;width:min(1280px,calc(100% - 48px));margin:0 auto;overflow:hidden;border-radius:12px;box-shadow:0 34px 70px -40px rgba(10,20,40,.45),0 0 0 1px rgba(10,20,40,.06)}
.sl-in{position:absolute;left:0;top:0;transform-origin:0 0}.se{position:absolute;box-sizing:border-box}.se img{display:block;max-width:none}
.se-tx{width:100%;min-height:1em;flex-shrink:0;color:#000;font-family:Arial,'Arimo',sans-serif;font-size:18px;line-height:1.2;overflow-wrap:break-word}.se-tx p{margin:0}.se-tx table{border-collapse:collapse;width:100%;height:100%}.se-tx td,.se-tx th{vertical-align:top}
.se-table .se-tx{height:100%}
.k-slides{background:color-mix(in srgb,var(--ink) 6%,#f3f4f6)}.k-slides .t-slide:first-child{padding-top:44px}.k-slides .t-slide:last-child{padding-bottom:64px}
.dm-view .t-slide .sl.rv{transform:translateY(34px) scale(.985);transition:opacity .9s cubic-bezier(.2,.7,.2,1),transform .9s cubic-bezier(.2,.7,.2,1)}.dm-view .t-slide .sl.rv.in{transform:none}
.dm-view .sl .se{transition:opacity .7s ease}.dm-view .sl:not(.in) .se{opacity:0}
.dm-view .t-slide .sl:hover{box-shadow:0 44px 90px -40px rgba(10,20,40,.55),0 0 0 1px rgba(10,20,40,.08)}
.dm-print .t-slide{padding:0;break-after:page;page-break-after:always;break-inside:avoid}.dm-print .t-slide .sl{width:100%;border-radius:0;box-shadow:none}.dm-print.k-slides{background:#fff}
@media print{.t-slide{padding:0!important;break-after:page;page-break-after:always;break-inside:avoid}.t-slide .sl{width:100%!important;border-radius:0!important;box-shadow:none!important}.k-slides{background:#fff}}
/* editing free-layout pages */
.dm-edit .t-slide .sl{overflow:visible}.dm-edit .se{outline:1px dashed transparent;transition:outline-color .15s}.dm-edit .sl:hover .se{outline-color:rgba(0,120,255,.18)}
.se-bind-t{position:absolute;inset:0;align-items:center;justify-content:center;text-align:center;font-family:var(--hf,Arial),Arial,sans-serif;font-weight:800;line-height:1.05;letter-spacing:-.01em;padding:0 4%;overflow:hidden}.se-bind{position:absolute;left:4px;top:4px;padding:1px 6px;border-radius:99px;background:#7C3AED;color:#fff;font:700 10px/1.5 system-ui,sans-serif;opacity:.85;pointer-events:none;white-space:nowrap}.dm-print .se-bind,.dm-view .se-bind{display:none}
.dm-edit .se.is-el{outline:2px solid #2F80ED!important;outline-offset:1px;z-index:5}.dm-edit .se.is-moving{opacity:.85;cursor:grabbing}.dm-edit .se-image{cursor:pointer}.dm-edit .se:hover,.dm-edit .se.is-on{outline:2px solid #2F80ED;z-index:5}
.dm-edit .se-tx.ed:focus{box-shadow:none;background:rgba(47,128,237,.06)}
.se-h{position:absolute;z-index:6;width:22px;height:22px;border-radius:7px;background:#2F80ED;box-shadow:0 4px 12px -4px rgba(0,0,0,.4);opacity:0;transition:opacity .15s;cursor:move;display:none}.dm-edit .se-h{display:block}
.se-mv{left:-11px;top:-11px;background:#2F80ED url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2.4' stroke-linecap='round'%3E%3Cpath d='M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3'/%3E%3C/svg%3E") center/14px no-repeat}
.se-rs{right:-9px;bottom:-9px;width:18px;height:18px;border-radius:50%;cursor:nwse-resize;border:3px solid #fff}
.se-x{position:absolute;z-index:6;right:-11px;top:-11px;width:22px;height:22px;border-radius:50%;border:0;background:#0d1f18;color:#fff;font:700 13px/1 system-ui;cursor:pointer;opacity:0;transition:opacity .15s;display:none}.dm-edit .se-x{display:block}
.dm-edit .se:hover>.se-h,.dm-edit .se.is-on>.se-h,.dm-edit .se:hover>.se-x,.dm-edit .se.is-on>.se-x{opacity:1}
.se-ph{position:absolute;inset:0;display:grid;place-items:center;border:2px dashed rgba(47,128,237,.5);border-radius:inherit;color:#2F80ED;font:600 13px system-ui;background:rgba(47,128,237,.05)}
.dm-edit .se.is-drop{outline:3px solid #2F80ED;background-color:rgba(47,128,237,.12)}.dm-edit .sl.is-drop{box-shadow:0 0 0 4px #2F80ED}
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
      B("text", { eyebrow: es ? "Pedido" : "Order form", title: es ? "Datos del pedido" : "Order details", body: es
        ? "<p><b>Contrato nº</b> {{contract.ref}}<br><b>Cliente</b> {{contract.customer.legal}} · CIF {{contract.customer.vat}}<br><b>Domicilio</b> {{contract.customer.address}}</p><p><b>Persona de contacto</b> {{contract.contact.name}} · {{contract.contact.email}}<br><b>Usuario administrador</b> {{contract.admin.name}} · {{contract.admin.email}}</p><p><b>Facturación</b> {{contract.billing}} · {{contract.payment_days}} · {{contract.currency}}, impuestos no incluidos<br><b>Inicio de la suscripción</b> {{contract.start}} · <b>Duración</b> {{contract.years}} años · {{contract.renewal}}</p>"
        : "<p><b>Contract no.</b> {{contract.ref}}<br><b>Customer</b> {{contract.customer.legal}} · VAT {{contract.customer.vat}}<br><b>Address</b> {{contract.customer.address}}</p><p><b>Contact person</b> {{contract.contact.name}} · {{contract.contact.email}}<br><b>Admin user</b> {{contract.admin.name}} · {{contract.admin.email}}</p><p><b>Billing</b> {{contract.billing}} · {{contract.payment_days}} · {{contract.currency}}, excluding VAT<br><b>Subscription start</b> {{contract.start}} · <b>Term</b> {{contract.years}} years · {{contract.renewal}}</p>" }),
      B("clauses", { eyebrow: es ? "Cláusulas" : "Clauses", title: es ? "Acuerdan" : "They agree", items: es ? [
        it("Objeto", "<p>{{provider.legal}} concede a {{client.legal}} una licencia de uso de su software y prestará los servicios profesionales descritos en el anexo económico de este contrato.</p>"),
        it("Duración", "<p>El contrato entra en vigor el {{contract.start}} y se extiende durante {{contract.years}} años, hasta el {{contract.end}}, sin posibilidad de resolución durante {{contract.non_terminable_years}} años. {{contract.renewal}}.</p>"),
        it("Precio y actualización", "<p>La licencia asciende a {{contract.license.final}} el primer año. {{contract.increment}}. Los servicios profesionales tienen un precio cerrado de {{contract.services.final}}.</p>"),
        it("Facturación y pago", "<p>La licencia se factura con periodicidad {{contract.billing}} por adelantado. Las facturas se abonarán a {{terms.payment_days}} días. Impuestos no incluidos. Los servicios de consultoría: {{contract.services.billing}}. {{contract.services.note}}</p>"),
        it("Confidencialidad", "<p>Las partes guardarán secreto sobre la información de la otra a la que tengan acceso con motivo de este contrato, durante su vigencia y los tres años siguientes.</p>"),
        it("Protección de datos", "<p>{{provider.name}} tratará los datos personales por cuenta de {{client}} únicamente para prestar el servicio, conforme al RGPD y al acuerdo de encargo de tratamiento anexo.</p>"),
        it("Propiedad intelectual", "<p>El software y su documentación son propiedad de {{provider.legal}}. Los datos del cliente son y seguirán siendo de {{client.legal}}.</p>"),
        it("Responsabilidad", "<p>La responsabilidad de cada parte queda limitada al importe abonado en los doce meses anteriores al hecho que la origine, salvo dolo o culpa grave.</p>"),
        it("Ley y jurisdicción", "<p>Este contrato se rige por la ley española. Las partes se someten a los juzgados y tribunales de {{provider.city}}.</p>"),
      ] : [
        it("Purpose", "<p>{{provider.legal}} grants {{client.legal}} a licence to use its software and will provide the professional services described in the commercial annex.</p>"),
        it("Term", "<p>This agreement starts on {{contract.start}} and lasts {{contract.years}} years, until {{contract.end}}, and is non-terminable for {{contract.non_terminable_years}} years. {{contract.renewal}}.</p>"),
        it("Price", "<p>The licence is {{contract.license.final}} in the first year. {{contract.increment}}. Professional services have a fixed price of {{contract.services.final}}.</p>"),
        it("Invoicing", "<p>The licence is invoiced {{contract.billing}} in advance. Invoices are payable within {{terms.payment_days}} days. Taxes not included. Consulting services: {{contract.services.billing}}. {{contract.services.note}}</p>"),
        it("General terms", "<p>This agreement is subject to our general subscription terms, data processing agreement and service-level agreement, available at {{contract.terms_url}}.</p>"),
        it("Confidentiality", "<p>Each party keeps the other's information confidential during the agreement and three years after.</p>"),
        it("Governing law", "<p>This agreement is governed by Spanish law; the courts of {{provider.city}} have jurisdiction.</p>"),
      ] }),
      B("pricing", { eyebrow: es ? "Anexo económico" : "Commercial annex", title: es ? "Condiciones económicas" : "Commercial terms" }),
      B("schedule", { eyebrow: es ? "Calendario" : "Schedule", title: es ? "Importe año a año" : "Year by year", body: es ? "<p>Licencia anual con su actualización y servicios en el primer año.</p>" : "<p>Yearly licence with its increase and services in the first year.</p>" }),
      B("signature", { title: es ? "Y en prueba de conformidad" : "In witness whereof", body: es ? "<p>Firman el presente contrato en {{provider.city}}, a {{contract.sign_date}}: {{contract.signatories}}.</p>" : "<p>Signed in {{provider.city}} on {{contract.sign_date}} by {{contract.signatories}}.</p>" }),
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
export interface ImportedDoc {
  /** our layout, with the document's texts, colours, fonts and pictures */
  blocks: DocBlock[];
  /** every slide / page as it was (PowerPoint, PDF) */
  faithful?: DocBlock[];
  theme: Partial<DocTheme>; images: Blob[]; assets: ImportedAsset[]; fonts: string[]; text: string; pages: number; source: string;
  /** commercial terms read in the document (e.g. the yearly increase), to start the template's terms with */
  terms?: DocTemplate["terms"];
}
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
// ------------------------------- faithful import: every page as it was -----
/**
 * A picture found in a reference document. `url` is a temporary object URL used in
 * the imported blocks until the editor stores the picture (persistDocImages).
 */
export interface ImportedAsset { url: string; blob: Blob; w: number; h: number; role: "photo" | "logo" | "page" }
const SLIDE_W = 1280;
const hasDom = () => typeof document !== "undefined" && typeof window !== "undefined";
const newCanvas = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const canvasBlob = (c: HTMLCanvasElement, type = "image/webp", q = 0.84) => new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("Could not encode the picture."))), type, q));
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();
const hexHsl = (h: string) => { const [r, g, b] = hexRgb(h); return hexToHsl([r, g, b].map(hex2).join("")); };
/** Loads the free fonts a document needs into this page (to measure text with them). Waits at most ~2.5 s. */
export async function ensureWebFonts(families: string[]): Promise<void> {
  if (!hasDom()) return;
  const links = docFontLinks({ ...DEFAULT_DOC_THEME, headingFont: "Inter", bodyFont: "Inter", webFonts: families });
  links.forEach((h) => { if (!document.querySelector(`link[data-dxf="${CSS.escape(h)}"]`)) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = h; l.dataset.dxf = h; document.head.appendChild(l); } });
  const loads = families.map((f) => (document as any).fonts?.load?.(`16px ${webFont(f).stack}`).catch(() => null));
  await Promise.race([Promise.all(loads), new Promise((ok) => setTimeout(ok, 2500))]);
}
/** The strong colours of some pictures, most used first (greys, whites and blacks left out). */
export async function paletteOf(srcs: (Blob | HTMLCanvasElement)[]): Promise<string[]> {
  if (!hasDom()) return [];
  const bins = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (const s0 of srcs.slice(0, 30)) {
    let src: CanvasImageSource, w = 0, h = 0;
    try {
      if (s0 instanceof HTMLCanvasElement) { src = s0; w = s0.width; h = s0.height; }
      else { const bm = await createImageBitmap(s0); src = bm; w = bm.width; h = bm.height; }
    } catch { continue; }
    if (!w || !h) continue;
    const k = 72 / Math.max(w, h);
    const c = newCanvas(w * k, h * k);
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const l = (mx + mn) / 510, sat = mx === mn ? 0 : (mx - mn) / (255 - Math.abs(mx + mn - 255));
      if (l > 0.93 || l < 0.06 || sat < 0.28) continue;
      const key = `${r >> 4}-${gg >> 4}-${b >> 4}`;
      const e = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n += 1 + sat; e.r += r; e.g += gg; e.b += b; bins.set(key, e);
    }
  }
  const out: { c: string; n: number }[] = [];
  // average colour of each bin (the sums are of every pixel; n counts pixels weighted by saturation)
  const pix = Array.from(bins.entries()).map(([key, e]) => { const [r, g, b] = key.split("-").map((v) => Number(v) * 16 + 8); return { c: rgbHex(r, g, b), n: e.n }; }).sort((a, b) => b.n - a.n);
  pix.forEach((x) => {
    const [r, g, b] = hexRgb(x.c);
    const near = out.find((o) => { const [r2, g2, b2] = hexRgb(o.c); return Math.abs(r - r2) + Math.abs(g - g2) + Math.abs(b - b2) < 70; });
    if (near) near.n += x.n; else out.push({ c: x.c, n: x.n });
  });
  return out.sort((a, b) => b.n - a.n).slice(0, 8).map((x) => x.c);
}
/** A theme from the colours found: main = the most used strong colour, accent = the next one of another hue. */
function themeFromColours(strong: string[], texts: { c: string; n: number }[]): Partial<DocTheme> {
  const out: Partial<DocTheme> = {};
  if (strong[0]) out.primary = strong[0];
  const h0 = strong[0] ? hexHsl(strong[0])[0] : -1;
  const acc = strong.slice(1).find((c) => { const h = hexHsl(c)[0]; const d = Math.min(Math.abs(h - h0), 1 - Math.abs(h - h0)); return d > 0.09; });
  if (acc) out.accent = acc;
  const dark = texts.filter((t) => hexHsl(t.c)[2] < 0.35).sort((a, b) => b.n - a.n)[0];
  if (dark) out.ink = dark.c;
  const grey = texts.filter((t) => { const [, sat, l] = hexHsl(t.c); return l >= 0.3 && l <= 0.62 && sat < 0.25; }).sort((a, b) => b.n - a.n)[0];
  if (grey) out.muted = grey.c;
  if (out.primary && hexHsl(out.primary)[2] > 0.72 && out.accent && hexHsl(out.accent)[2] < hexHsl(out.primary)[2]) { const t = out.primary; out.primary = out.accent; out.accent = t; }
  return out;
}

/** Who the client is in a reference proposal: "Konsolidator® / Ubimia", "Ubimia (Proyectos Formación y Servicios, S.L.)". */
export function guessClientNames(text: string, provider?: string): { names: string[]; legal: string[] } {
  const prov = (provider ?? (/\b([A-Z][\w-]{2,30})®/.exec(text)?.[1] ?? "")).trim();
  const names = new Set<string>(), legal = new Set<string>();
  const notProv = (n: string) => n && (!prov || n.toLowerCase().replace(/®/g, "").trim() !== prov.toLowerCase());
  for (const m of text.matchAll(/([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ&.\- ]{1,40}?)®?\s*[/×]\s*([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ&.\-]{1,30}(?: [A-ZÁÉÍÓÚÑ][\wáéíóúñ&.\-]{1,20}){0,2})/g)) {
    const a = m[1].trim(), b = m[2].trim();
    if (prov && a.toLowerCase().startsWith(prov.toLowerCase()) && notProv(b)) names.add(b);
    else if (prov && b.toLowerCase().startsWith(prov.toLowerCase()) && notProv(a)) names.add(a);
  }
  const LEGAL = "(?:S\\.\\s?L\\.\\s?U?\\.?|S\\.\\s?A\\.\\s?U?\\.?|SLU|SAU|S\\.\\s?Coop\\.?|GmbH|Ltd\\.?|Inc\\.?|B\\.V\\.|A\\/S|SAS|SRL|S\\.L|S\\.A)";
  for (const m of text.matchAll(new RegExp(`([A-ZÁÉÍÓÚÑ][\\wÁÉÍÓÚÑáéíóúñ&.\\-]{1,30})\\s*\\(([^()]{3,70}?,?\\s${LEGAL})\\)`, "g"))) { if (notProv(m[1])) { names.add(m[1].trim()); legal.add(m[2].trim()); } }
  return { names: Array.from(names).filter((n) => n.length > 2 && !/^(de|la|el|los|las|the|and|y)$/i.test(n)), legal: Array.from(legal) };
}
/** Client names and legal names → {{client}} / {{client.legal}} (whole words only). */
function placeClient(s: string, who: { names: string[]; legal: string[] }): string {
  const re = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  who.legal.forEach((l) => { s = s.replace(new RegExp(re(l), "g"), "{{client.legal}}"); });
  who.names.slice().sort((a, b) => b.length - a.length).forEach((n) => { s = s.replace(new RegExp(`(^|[^\\wÁÉÍÓÚÑáéíóúñ{])${re(n)}(?![\\wÁÉÍÓÚÑáéíóúñ])`, "g"), "$1{{client}}"); });
  return s;
}
/** Everything that becomes a variable in one piece of text of a reference document. */
export interface PlaceOpts { who: { names: string[]; legal: string[] }; kind: DocKind; fields?: { label: string; key: string }[]; sellerEmail?: string }
export function placeVariables(text: string, o: PlaceOpts): string {
  let s = placeClient(text, o.who);
  // "valid until / sign before" dates
  const D = "(\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{1,2} de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) de 20\\d\\d)";
  s = s.replace(new RegExp(`((?:v[aá]lid[oa]s?|firm[ae]s?)\\s(?:solo\\s)?(?:si\\s)?(?:se\\s)?(?:firma\\s)?(?:hasta|antes)\\s(?:del?|el)\\s|before\\s|until\\s|antes del?\\s)${D}`, "gi"), "$1{{valid_until}}");
  (o.fields ?? []).forEach((f) => {
    if (f.label.length < 3) return;
    const re = new RegExp(`(${f.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s*[:：]\\s*([^\\n{]{1,80})`, "i");
    s = s.replace(re, `$1: {{${f.key}}}`);
  });
  return autoPlaceTokens(s, { kind: o.kind, clientNames: [] });
}

// -- PowerPoint preset shapes (arrows, chevrons, callouts…) and connectors, drawn as SVG at any size --
/** Adjust value `name` of a preset (OOXML units: 100000 = 100 %), else its default. */
const adjOf = (adj: Record<string, number> | undefined, name: string, def: number) => (adj && Number.isFinite(adj[name]) ? adj[name] : def);
/** Elbow / curved connectors and lines: the points of the path (in the box), so arrowheads can follow the ends. */
export function connectorPoints(prst: string, w: number, h: number, adj?: Record<string, number>): { pts: [number, number][]; curve?: boolean } {
  const a1 = adjOf(adj, "adj1", 50000) / 100000, a2 = adjOf(adj, "adj2", 50000) / 100000, a3 = adjOf(adj, "adj3", 50000) / 100000;
  switch (prst) {
    case "bentConnector2": return { pts: [[0, 0], [w, 0], [w, h]] };
    case "bentConnector3": return { pts: [[0, 0], [w * a1, 0], [w * a1, h], [w, h]] };
    case "bentConnector4": return { pts: [[0, 0], [w * a1, 0], [w * a1, h * a2], [w, h * a2], [w, h]] };
    case "bentConnector5": return { pts: [[0, 0], [w * a1, 0], [w * a1, h * a2], [w * a3, h * a2], [w * a3, h], [w, h]] };
    case "curvedConnector2": return { pts: [[0, 0], [w, 0], [w, h]], curve: true };
    case "curvedConnector3": case "curvedConnector4": case "curvedConnector5": return { pts: [[0, 0], [w * a1, 0], [w * a1, h], [w, h]], curve: true };
    default: return { pts: [[0, 0], [w, h]] };
  }
}
export const isConnectorGeom = (prst?: string) => !!prst && (/^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/.test(prst));
/** A preset shape as SVG path data for a w×h box (most used presets; unknown ones fall back to a rectangle). */
export function presetPath(prst: string, w: number, h: number, adj?: Record<string, number>): string {
  const ss = Math.min(w, h), f = (n: number) => Math.round(n * 100) / 100;
  const P = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
  const a = (name: string, def: number) => adjOf(adj, name, def) / 100000;
  const rr = (r: number) => { r = Math.max(0, Math.min(r, ss / 2)); return `M${f(r)} 0H${f(w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)}V${f(h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)}H${f(r)}A${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)}V${f(r)}A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0Z`; };
  const ell = (cx: number, cy: number, rx: number, ry: number) => `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
  switch (prst) {
    case "roundRect": case "flowChartAlternateProcess": return rr(ss * a("adj", 16667));
    case "round2SameRect": { const r = Math.min(ss * a("adj1", 16667), ss / 2); return `M${f(r)} 0H${f(w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)}V${f(h)}H0V${f(r)}A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0Z`; }
    case "round1Rect": { const r = Math.min(ss * a("adj", 16667), ss / 2); return `M0 0H${f(w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)}V${f(h)}H0Z`; }
    case "snip1Rect": { const s = ss * a("adj", 16667); return P([[0, 0], [w - s, 0], [w, s], [w, h], [0, h]]); }
    case "snip2SameRect": { const s = ss * a("adj1", 16667); return P([[s, 0], [w - s, 0], [w, s], [w, h], [0, h], [0, s]]); }
    case "ellipse": case "flowChartConnector": return ell(w / 2, h / 2, w / 2, h / 2);
    case "triangle": case "flowChartExtract": { const x = w * a("adj", 50000); return P([[x, 0], [w, h], [0, h]]); }
    case "flowChartMerge": return P([[0, 0], [w, 0], [w / 2, h]]);
    case "rtTriangle": return P([[0, 0], [w, h], [0, h]]);
    case "diamond": case "flowChartDecision": return P([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case "parallelogram": case "flowChartInputOutput": { const o = prst === "parallelogram" ? ss * a("adj", 25000) : w * 0.2; return P([[o, 0], [w, 0], [w - o, h], [0, h]]); }
    case "trapezoid": { const o = ss * a("adj", 25000); return P([[o, 0], [w - o, 0], [w, h], [0, h]]); }
    case "pentagon": return P([[w / 2, 0], [w, h * 0.38], [w * 0.81, h], [w * 0.19, h], [0, h * 0.38]]);
    case "hexagon": { const o = ss * a("adj", 25000); return P([[o, 0], [w - o, 0], [w, h / 2], [w - o, h], [o, h], [0, h / 2]]); }
    case "octagon": { const o = ss * a("adj", 29289); return P([[o, 0], [w - o, 0], [w, o], [w, h - o], [w - o, h], [o, h], [0, h - o], [0, o]]); }
    case "homePlate": case "flowChartOffpageConnector": { const o = prst === "homePlate" ? ss * a("adj", 50000) : 0; return prst === "homePlate" ? P([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h]]) : P([[0, 0], [w, 0], [w, h * 0.8], [w / 2, h], [0, h * 0.8]]); }
    case "chevron": { const o = ss * a("adj", 50000); return P([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h], [o, h / 2]]); }
    case "rightArrow": case "notchedRightArrow": case "stripedRightArrow": { const t = h * a("adj1", 50000), hl = ss * a("adj2", 50000); const y1 = (h - t) / 2, y2 = (h + t) / 2; return P([[0, y1], [w - hl, y1], [w - hl, 0], [w, h / 2], [w - hl, h], [w - hl, y2], [0, y2], ...(prst === "notchedRightArrow" ? [[hl * 0.5, h / 2] as [number, number]] : [])]); }
    case "leftArrow": { const t = h * a("adj1", 50000), hl = ss * a("adj2", 50000); const y1 = (h - t) / 2, y2 = (h + t) / 2; return P([[w, y1], [hl, y1], [hl, 0], [0, h / 2], [hl, h], [hl, y2], [w, y2]]); }
    case "upArrow": { const t = w * a("adj1", 50000), hl = ss * a("adj2", 50000); const x1 = (w - t) / 2, x2 = (w + t) / 2; return P([[x1, h], [x1, hl], [0, hl], [w / 2, 0], [w, hl], [x2, hl], [x2, h]]); }
    case "downArrow": { const t = w * a("adj1", 50000), hl = ss * a("adj2", 50000); const x1 = (w - t) / 2, x2 = (w + t) / 2; return P([[x1, 0], [x2, 0], [x2, h - hl], [w, h - hl], [w / 2, h], [0, h - hl], [x1, h - hl]]); }
    case "leftRightArrow": { const t = h * a("adj1", 50000), hl = ss * a("adj2", 50000); const y1 = (h - t) / 2, y2 = (h + t) / 2; return P([[0, h / 2], [hl, 0], [hl, y1], [w - hl, y1], [w - hl, 0], [w, h / 2], [w - hl, h], [w - hl, y2], [hl, y2], [hl, h]]); }
    case "upDownArrow": { const t = w * a("adj1", 50000), hl = ss * a("adj2", 50000); const x1 = (w - t) / 2, x2 = (w + t) / 2; return P([[w / 2, 0], [w, hl], [x2, hl], [x2, h - hl], [w, h - hl], [w / 2, h], [0, h - hl], [x1, h - hl], [x1, hl], [0, hl]]); }
    case "plus": case "mathPlus": { const o = ss * a("adj", 25000); return P([[o, 0], [w - o, 0], [w - o, o], [w, o], [w, h - o], [w - o, h - o], [w - o, h], [o, h], [o, h - o], [0, h - o], [0, o], [o, o]].map(([x, y]) => [x, y]) as [number, number][]); }
    case "star4": case "star5": case "star6": case "star8": case "star10": case "star12": {
      const n = Number(prst.slice(4)), ri = prst === "star5" ? 0.38 : prst === "star4" ? 0.25 : 0.5;
      const pts: [number, number][] = [];
      for (let i = 0; i < n * 2; i++) { const ang = -Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? ri : 1; pts.push([w / 2 + (w / 2) * r * Math.cos(ang), h / 2 + (h / 2) * r * Math.sin(ang)]); }
      return P(pts);
    }
    case "donut": { const t = ss * a("adj", 25000); return `${ell(w / 2, h / 2, w / 2, h / 2)}${ell(w / 2, h / 2, Math.max(0, w / 2 - t), Math.max(0, h / 2 - t))}`; }
    case "frame": { const t = ss * a("adj1", 12500); return `M0 0H${f(w)}V${f(h)}H0Z M${f(t)} ${f(t)}V${f(h - t)}H${f(w - t)}V${f(t)}Z`; }
    case "flowChartTerminator": return rr(ss / 2);
    case "flowChartDocument": return `M0 0H${f(w)}V${f(h * 0.83)}C${f(w * 0.75)} ${f(h * 0.7)} ${f(w * 0.5)} ${f(h * 1.08)} 0 ${f(h * 0.9)}Z`;
    case "flowChartPredefinedProcess": return `M0 0H${f(w)}V${f(h)}H0Z M${f(w * 0.12)} 0V${f(h)} M${f(w * 0.88)} 0V${f(h)}`;
    case "can": case "flowChartMagneticDisk": { const e = Math.min(h * 0.25 * (prst === "can" ? a("adj", 25000) / 0.25 : 1), h / 2) / 2; return `M0 ${f(e)}A${f(w / 2)} ${f(e)} 0 0 1 ${f(w)} ${f(e)}V${f(h - e)}A${f(w / 2)} ${f(e)} 0 0 1 0 ${f(h - e)}Z M0 ${f(e)}A${f(w / 2)} ${f(e)} 0 0 0 ${f(w)} ${f(e)}`; }
    case "wedgeRectCallout": case "wedgeRoundRectCallout": case "wedgeEllipseCallout": {
      const tx = w / 2 + w * a("adj1", -20833), ty = h / 2 + h * a("adj2", 62500);
      const body = prst === "wedgeEllipseCallout" ? ell(w / 2, h / 2, w / 2, h / 2) : prst === "wedgeRoundRectCallout" ? rr(ss * a("adj3", 16667)) : `M0 0H${f(w)}V${f(h)}H0Z`;
      const bx = Math.max(0, Math.min(w, tx)), by = ty > h ? h : ty < 0 ? 0 : h;
      return `${body} M${f(Math.max(0, Math.min(w, bx - w * 0.08)))} ${f(by)}L${f(tx)} ${f(ty)}L${f(Math.max(0, Math.min(w, bx + w * 0.08)))} ${f(by)}Z`;
    }
    case "teardrop": return `M${f(w / 2)} 0H${f(w)}V${f(h / 2)}A${f(w / 2)} ${f(h / 2)} 0 1 1 ${f(w / 2)} 0Z`;
    case "pie": case "blockArc": case "arc": case "chord": {
      const s0 = (adjOf(adj, "adj1", prst === "arc" ? 16200000 : 0) / 60000) * Math.PI / 180, s1 = (adjOf(adj, "adj2", prst === "arc" ? 0 : 16200000) / 60000) * Math.PI / 180;
      const pt = (t: number) => [w / 2 + (w / 2) * Math.cos(t), h / 2 + (h / 2) * Math.sin(t)];
      let sw = s1 - s0; if (sw <= 0) sw += Math.PI * 2;
      const [x0, y0] = pt(s0), [x1, y1] = pt(s0 + sw);
      const arcD = `M${f(x0)} ${f(y0)}A${f(w / 2)} ${f(h / 2)} 0 ${sw > Math.PI ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
      return prst === "arc" ? arcD : prst === "chord" ? `${arcD}Z` : `${arcD}L${f(w / 2)} ${f(h / 2)}Z`;
    }
    case "leftBracket": return `M${f(w)} 0Q0 0 0 ${f(h * 0.1)}V${f(h * 0.9)}Q0 ${f(h)} ${f(w)} ${f(h)}`;
    case "rightBracket": return `M0 0Q${f(w)} 0 ${f(w)} ${f(h * 0.1)}V${f(h * 0.9)}Q${f(w)} ${f(h)} 0 ${f(h)}`;
    case "leftBrace": return `M${f(w)} 0Q${f(w / 2)} 0 ${f(w / 2)} ${f(h * 0.1)}V${f(h * 0.4)}Q${f(w / 2)} ${f(h / 2)} 0 ${f(h / 2)}Q${f(w / 2)} ${f(h / 2)} ${f(w / 2)} ${f(h * 0.6)}V${f(h * 0.9)}Q${f(w / 2)} ${f(h)} ${f(w)} ${f(h)}`;
    case "rightBrace": return `M0 0Q${f(w / 2)} 0 ${f(w / 2)} ${f(h * 0.1)}V${f(h * 0.4)}Q${f(w / 2)} ${f(h / 2)} ${f(w)} ${f(h / 2)}Q${f(w / 2)} ${f(h / 2)} ${f(w / 2)} ${f(h * 0.6)}V${f(h * 0.9)}Q${f(w / 2)} ${f(h)} 0 ${f(h)}`;
    case "cube": { const o = ss * a("adj", 25000); return `M0 ${f(o)}L${f(o)} 0H${f(w)}V${f(h - o)}L${f(w - o)} ${f(h)}H0Z M0 ${f(o)}H${f(w - o)}V${f(h)} M${f(w - o)} ${f(o)}L${f(w)} 0`; }
    case "heart": return `M${f(w / 2)} ${f(h * 0.25)}C${f(w * 0.5)} 0 0 0 0 ${f(h * 0.3)}C0 ${f(h * 0.6)} ${f(w * 0.4)} ${f(h * 0.8)} ${f(w / 2)} ${f(h)}C${f(w * 0.6)} ${f(h * 0.8)} ${f(w)} ${f(h * 0.6)} ${f(w)} ${f(h * 0.3)}C${f(w)} 0 ${f(w * 0.5)} 0 ${f(w / 2)} ${f(h * 0.25)}Z`;
    default: return `M0 0H${f(w)}V${f(h)}H0Z`;
  }
}
/** Where PowerPoint lays the text inside a preset shape (its "text rectangle"): extra insets [l, t, r, b] in px. */
function presetTextInsets(prst: string, w: number, h: number, adj?: Record<string, number>): [number, number, number, number] {
  const ss = Math.min(w, h), a = (n: string, d: number) => adjOf(adj, n, d) / 100000;
  switch (prst) {
    case "ellipse": case "flowChartConnector": return [w * 0.1464, h * 0.1464, w * 0.1464, h * 0.1464];
    case "roundRect": case "flowChartAlternateProcess": { const i = ss * a("adj", 16667) * 0.29289; return [i, i, i, i]; }
    case "chevron": { const o = ss * a("adj", 50000); return [o, 0, o, 0]; }
    case "homePlate": { const o = ss * a("adj", 50000); return [0, 0, o / 2, 0]; }
    case "rightArrow": case "notchedRightArrow": case "stripedRightArrow": { const t = (h - h * a("adj1", 50000)) / 2, hl = ss * a("adj2", 50000); return [0, t, hl / 2, t]; }
    case "leftArrow": { const t = (h - h * a("adj1", 50000)) / 2, hl = ss * a("adj2", 50000); return [hl / 2, t, 0, t]; }
    case "upArrow": { const t = (w - w * a("adj1", 50000)) / 2, hl = ss * a("adj2", 50000); return [t, hl / 2, t, 0]; }
    case "downArrow": { const t = (w - w * a("adj1", 50000)) / 2, hl = ss * a("adj2", 50000); return [t, 0, t, hl / 2]; }
    case "leftRightArrow": { const t = (h - h * a("adj1", 50000)) / 2, hl = ss * a("adj2", 50000) / 2; return [hl, t, hl, t]; }
    case "diamond": case "flowChartDecision": return [w / 4, h / 4, w / 4, h / 4];
    case "triangle": case "flowChartExtract": return [w / 4, h / 2, w / 4, 0];
    case "rtTriangle": return [w / 12, h * 7 / 12, w * 5 / 12, h / 12];
    case "hexagon": { const o = ss * a("adj", 25000); return [o / 2, h * 0.08, o / 2, h * 0.08]; }
    case "octagon": { const o = ss * a("adj", 29289) / 2; return [o, o, o, o]; }
    case "parallelogram": { const o = ss * a("adj", 25000) / 2; return [o, 0, o, 0]; }
    case "trapezoid": { const o = ss * a("adj", 25000) * 0.66; return [o, 0, o, 0]; }
    case "pentagon": return [w * 0.19, h * 0.24, w * 0.19, 0];
    case "star5": case "star4": case "star6": case "star8": return [w * 0.25, h * 0.27, w * 0.25, h * 0.2];
    case "plus": { const o = ss * a("adj", 25000); return [0, o, 0, o]; }
    case "can": case "flowChartMagneticDisk": { const e = h * 0.25 * a("adj", 25000) / 0.25; return [0, e, 0, 0]; }
    case "frame": { const t = ss * a("adj1", 12500); return [t, t, t, t]; }
    case "donut": return [w * 0.15, h * 0.15, w * 0.15, h * 0.15];
    case "flowChartDocument": return [0, 0, 0, h * 0.2];
    case "flowChartPredefinedProcess": return [w * 0.12, 0, w * 0.12, 0];
    case "flowChartTerminator": return [ss * 0.15, 0, ss * 0.15, 0];
    default: return [0, 0, 0, 0];
  }
}
/** "1.5px dashed #333" → an SVG stroke. */
function borderStroke(b: string): SlideEl["stroke"] | undefined {
  const m = /([\d.]+)px\s+(solid|dashed|dotted)\s+(.+)$/.exec(b.trim());
  return m ? { w: Number(m[1]), dash: m[2] !== "solid", color: m[3] } : undefined;
}
/** Shapes the html box can draw by itself (css border-radius). */
const CSS_GEOMS = /^(rect|roundRect|ellipse|flowChartProcess|flowChartConnector|flowChartAlternateProcess|cust)$/;
/** Arrowhead size in px for a line of width `lw` (PowerPoint: sm / med / lg = 2 / 3 / 5 line widths, min a few px). */
const arrowLen = (lw: number, sz?: string) => Math.max(5, lw * (sz === "sm" ? 2.2 : sz === "lg" ? 4.4 : 3.2));
/** SVG of a line / connector with its arrowheads, in a w×h box. */
function connectorSvg(geom: { prst: string; adj?: Record<string, number> }, w: number, h: number, st: NonNullable<SlideEl["stroke"]>): string {
  const { pts, curve } = connectorPoints(geom.prst, w, h, geom.adj);
  const f = (n: number) => Math.round(n * 100) / 100;
  let d: string;
  if (curve && pts.length === 4) d = `M${f(pts[0][0])} ${f(pts[0][1])}C${f(pts[1][0])} ${f(pts[1][1])} ${f(pts[2][0])} ${f(pts[2][1])} ${f(pts[3][0])} ${f(pts[3][1])}`;
  else if (curve && pts.length === 3) d = `M${f(pts[0][0])} ${f(pts[0][1])}Q${f(pts[1][0])} ${f(pts[1][1])} ${f(pts[2][0])} ${f(pts[2][1])}`;
  else d = `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}`;
  const head = (tip: [number, number], from: [number, number], type?: string, sz?: string) => {
    if (!type || type === "none") return "";
    const L = arrowLen(st.w, sz), W = L * 0.9;
    let dx = tip[0] - from[0], dy = tip[1] - from[1];
    const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
    const bx = tip[0] - dx * L, by = tip[1] - dy * L, px = -dy * W / 2, py = dx * W / 2;
    if (type === "oval") return `<circle cx="${f(tip[0])}" cy="${f(tip[1])}" r="${f(L / 2.6)}" fill="${esc(st.color)}"/>`;
    if (type === "diamond") return `<path d="M${f(tip[0] + dx * L / 2)} ${f(tip[1] + dy * L / 2)}L${f(tip[0] + px)} ${f(tip[1] + py)}L${f(tip[0] - dx * L / 2)} ${f(tip[1] - dy * L / 2)}L${f(tip[0] - px)} ${f(tip[1] - py)}Z" fill="${esc(st.color)}"/>`;
    if (type === "arrow") return `<path d="M${f(bx + px)} ${f(by + py)}L${f(tip[0])} ${f(tip[1])}L${f(bx - px)} ${f(by - py)}" fill="none" stroke="${esc(st.color)}" stroke-width="${f(st.w)}" stroke-linejoin="round"/>`;
    const notch = type === "stealth" ? `L${f(tip[0] - dx * L * 0.6)} ${f(tip[1] - dy * L * 0.6)}` : "";
    return `<path d="M${f(tip[0])} ${f(tip[1])}L${f(bx + px)} ${f(by + py)}${notch}L${f(bx - px)} ${f(by - py)}Z" fill="${esc(st.color)}"/>`;
  };
  const n = pts.length;
  return `<svg width="100%" height="100%" viewBox="0 0 ${f(Math.max(w, 1))} ${f(Math.max(h, 1))}" preserveAspectRatio="none" style="overflow:visible;position:absolute;left:0;top:0"><path d="${d}" fill="none" stroke="${esc(st.color)}" stroke-width="${f(st.w)}"${st.dash ? ` stroke-dasharray="${f(st.w * 4)} ${f(st.w * 3)}"` : ""} stroke-linejoin="round"/>${head(pts[0], pts[1], st.head, st.headSz)}${head(pts[n - 1], pts[n - 2], st.tail, st.tailSz)}</svg>`;
}
/** css linear-gradient(…) → an SVG <linearGradient> (shapes drawn as SVG keep their gradients). */
function svgGradient(css: string, id: string): string | undefined {
  const m = /linear-gradient\(\s*([\d.-]+)deg\s*,(.*)\)\s*$/i.exec(css);
  if (!m) return undefined;
  const ang = ((Number(m[1]) - 90) * Math.PI) / 180;
  const stops = Array.from(m[2].matchAll(/(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s+([\d.]+)%/gi)).map((s) => `<stop offset="${s[2]}%" stop-color="${s[1]}"/>`).join("");
  const x = Math.cos(ang) / 2, y = Math.sin(ang) / 2;
  return `<linearGradient id="${id}" x1="${(0.5 - x).toFixed(3)}" y1="${(0.5 - y).toFixed(3)}" x2="${(0.5 + x).toFixed(3)}" y2="${(0.5 + y).toFixed(3)}">${stops}</linearGradient>`;
}
let svgUid = 0;
/** A preset shape (fill + outline) as SVG in a w×h box. */
function geomSvg(geom: { prst: string; adj?: Record<string, number> }, w: number, h: number, fill?: string, stroke?: SlideEl["stroke"]): string {
  const d = presetPath(geom.prst, w, h, geom.adj);
  let defs = "", fillAttr = "none";
  if (fill) {
    if (/gradient/i.test(fill)) { const id = `g${++svgUid}`; const g = svgGradient(fill, id); if (g) { defs = `<defs>${g}</defs>`; fillAttr = `url(#${id})`; } else fillAttr = firstColour(fill) ?? "none"; }
    else fillAttr = fill;
  }
  const open = /^(arc|leftBracket|rightBracket|leftBrace|rightBrace)$/.test(geom.prst);
  const sw = stroke ? Math.round(stroke.w * 100) / 100 : 0;
  return `<svg width="100%" height="100%" viewBox="0 0 ${Math.max(w, 1).toFixed(2)} ${Math.max(h, 1).toFixed(2)}" preserveAspectRatio="none" style="overflow:visible;position:absolute;left:0;top:0">${defs}<path d="${d}" fill="${open ? "none" : esc(fillAttr)}" fill-rule="evenodd"${stroke ? ` stroke="${esc(stroke.color)}" stroke-width="${sw}"${stroke.dash ? ` stroke-dasharray="${sw * 4} ${sw * 3}"` : ""}` : ""} stroke-linejoin="round"/></svg>`;
}

// -- PowerPoint: each slide as a free-layout page --
const PX_PT = 12700;
const alignCss = (a?: string) => (a === "ctr" ? "center" : a === "r" ? "right" : a === "just" || a === "dist" ? "justify" : "left");
function pvParasHtml(t: PvText, k: number, font0: string, place: (s: string) => string, fams: Set<string>, usage?: DeckUsage): string {
  const sc = t.scale ?? 1;
  const red = 1 - (t.lnRed ?? 0);
  const pt = PX_PT * k;
  return t.paras.map((p) => {
    const sz0 = ((p.runs.find((r) => r.text.trim())?.size ?? p.endSize) || 18) * sc * pt;
    const before = p.spcBef != null ? p.spcBef * pt : p.spcBefPct != null ? p.spcBefPct * sz0 * 1.2 : 0;
    const after = p.spcAft != null ? p.spcAft * pt : p.spcAftPct != null ? p.spcAftPct * sz0 * 1.2 : 0;
    const lh = p.lnPts != null ? `${r1(p.lnPts * pt * red)}px` : ((p.lnSpc ?? 1) * red * 1.17).toFixed(3);
    const ps = [`text-align:${alignCss(p.align)}`, `margin:${r1(before)}px 0 ${r1(after)}px 0`, `line-height:${lh}`, `font-size:${r1(sz0)}px`];
    const marL = (p.marL ?? 0) * k, ind = (p.indent ?? 0) * k;
    if (marL || ind) ps.push(`padding-left:${r1(marL)}px`, `text-indent:${r1(ind)}px`);
    const runCss = (r: Omit<PvRun, "text">) => {
      const f = r.font || font0; fams.add(f);
      const wf = webFont(f);
      const fs = (r.size || 18) * sc * pt;
      // superscript / subscript: smaller and raised by the % of the size the slide says (® in titles)
      const css = [`font-family:${wf.stack}`, `font-size:${r1(r.baseline ? fs * 0.62 : fs)}px`, `color:${r.color ?? p.color ?? "#000000"}`];
      if (r.bold) css.push("font-weight:700"); else if (wf.weight) css.push(`font-weight:${wf.weight}`);
      if (r.italic) css.push("font-style:italic");
      if (r.underline || r.strike) css.push(`text-decoration:${[r.underline ? "underline" : "", r.strike ? "line-through" : ""].filter(Boolean).join(" ")}`);
      if (r.caps) css.push("text-transform:uppercase");
      if (r.smallCaps) css.push("font-variant:small-caps");
      if (r.highlight) css.push(`background:${r.highlight}`);
      if (r.spc) css.push(`letter-spacing:${r1(r.spc * pt)}px`);
      if (r.baseline) css.push(`vertical-align:${r1((fs * r.baseline) / 100)}px`, "line-height:0");
      return css.join(";");
    };
    const first = p.runs.find((r) => r.text.trim()) ?? { size: p.endSize, color: p.color } as PvRun;
    // bullet: hangs in the indent, so the text starts where PowerPoint starts it
    const buCss = runCss({ ...first, bold: false, italic: false, underline: false, color: p.buColor ?? first.color, size: (first.size || 18) * (p.buSize ?? 1) });
    const bullet = p.bullet ? (ind < 0 ? `<span style="${buCss};display:inline-block;min-width:${r1(-ind)}px;text-indent:0">${esc(p.bullet)}</span>` : `<span style="${buCss}">${esc(p.bullet)}&nbsp;</span>`) : "";
    // runs that look the same are joined first, so a name split over several runs still becomes {{client}}
    const merged: { css: string; text: string; link?: string }[] = [];
    for (const r of p.runs) {
      if (r.text === "\n") { merged.push({ css: "", text: "\n" }); continue; }
      const css = runCss(r);
      const last = merged[merged.length - 1];
      if (last && last.css === css && last.link === r.link && last.text !== "\n") last.text += r.text; else merged.push({ css, text: r.text, link: r.link });
      if (usage && r.text.trim()) { const f = r.font || font0; const big = (r.size || 18) * sc >= 24; const m = big ? usage.bigFonts : usage.smallFonts; m.set(f, (m.get(f) ?? 0) + r.text.trim().length); if (r.color && /^#/.test(r.color)) usage.texts.set(r.color, (usage.texts.get(r.color) ?? 0) + r.text.trim().length); }
    }
    const runs = merged.map((m) => {
      if (m.text === "\n") return "<br>";
      const inner = `<span style="${m.css}">${esc(place(m.text)).replace(/\n/g, "<br>")}</span>`;
      return m.link && /^(https?:|mailto:)/i.test(m.link) ? `<a href="${esc(m.link)}" style="color:inherit">${inner}</a>` : inner;
    }).join("");
    return `<p style="${ps.join(";")}">${bullet}${runs || "<br>"}</p>`;
  }).join("");
}
/** What a deck really uses: colours by area / letters and fonts by letters (its look, beyond the theme's accents). */
interface DeckUsage { fills: Map<string, number>; texts: Map<string, number>; bigFonts: Map<string, number>; smallFonts: Map<string, number> }
function pvTableHtml(tb: PvTable, k: number, font0: string, place: (s: string) => string, fams: Set<string>): string {
  const cols = `<colgroup>${tb.cols.map((c) => `<col style="width:${r1(c * k)}px">`).join("")}</colgroup>`;
  const rows = tb.rows.map((r) => `<tr style="height:${r1(r.h * k)}px">${r.cells.filter((c) => !c.merged).map((c) => {
    const b = c.borders;
    const st = [c.fill ? `background:${c.fill}` : "", b.l ? `border-left:${b.l}` : "", b.r ? `border-right:${b.r}` : "", b.t ? `border-top:${b.t}` : "", b.b ? `border-bottom:${b.b}` : "",
      `padding:${r1(c.text.t * k)}px ${r1(c.text.r * k)}px ${r1(c.text.b * k)}px ${r1(c.text.l * k)}px`, `vertical-align:${c.text.anchor === "ctr" ? "middle" : c.text.anchor === "b" ? "bottom" : "top"}`].filter(Boolean).join(";");
    return `<td${(c.span ?? 1) > 1 ? ` colspan="${c.span}"` : ""}${(c.rowSpan ?? 1) > 1 ? ` rowspan="${c.rowSpan}"` : ""} style="${st}">${pvParasHtml(c.text, k, font0, place, fams)}</td>`;
  }).join("")}</tr>`).join("");
  return `<table style="width:100%;border-collapse:collapse;table-layout:fixed">${cols}<tbody>${rows}</tbody></table>`;
}
const firstColour = (fill?: string) => (fill && /gradient/.test(fill) ? /#[0-9A-F]{6}|rgba?\([^)]*\)/i.exec(fill)?.[0] : fill);
async function deckToPages(buf: Uint8Array, place: (s: string) => string): Promise<{ blocks: DocBlock[]; assets: ImportedAsset[]; fonts: string[]; logo?: string; usage: DeckUsage }> {
  const pv = await loadDeckPreview(buf);
  const k = SLIDE_W / pv.cx, H = Math.round(pv.cy * k);
  const fams = new Set<string>();
  const usage: DeckUsage = { fills: new Map(), texts: new Map(), bigFonts: new Map(), smallFonts: new Map() };
  const addFill = (c: string | undefined, a: number) => { const x = firstColour(c); if (x && /^#[0-9A-F]{6}$/i.test(x) && a > 0) usage.fills.set(x.toUpperCase(), (usage.fills.get(x.toUpperCase()) ?? 0) + a); };
  const assets = new Map<string, ImportedAsset>();
  const area = (s: PvShape) => (s.w * s.h) / (pv.cx * pv.cy);
  const keep = async (url: string | undefined, role: ImportedAsset["role"], s?: PvShape) => {
    if (!url) return undefined;
    if (!assets.has(url)) {
      try { const blob = await (await fetch(url)).blob(); assets.set(url, { url, blob, w: s ? s.w * k : SLIDE_W, h: s ? s.h * k : H, role }); } catch { return undefined; }
    } else if (role === "photo") assets.get(url)!.role = "photo";
    return url;
  };
  let logo: string | undefined;
  const hidden = new Set(pv.info.slides.filter((x) => x.hidden).map((x) => x.n));
  const blocks: DocBlock[] = [];
  let secNo = 0;
  const strokeOf = (sh: PvShape): SlideEl["stroke"] | undefined => sh.line ? { color: sh.line.color, w: Math.max(0.6, sh.line.w * k), dash: sh.line.dash, head: sh.line.head ? sh.line.headType ?? "triangle" : undefined, tail: sh.line.tail ? sh.line.tailType ?? "triangle" : undefined, headSz: sh.line.headSz, tailSz: sh.line.tailSz } : undefined;
  for (const sl of pv.slides) {
    if (hidden.has(sl.n)) continue;
    addFill(sl.bg, 1);
    const els: SlideEl[] = [];
    for (const sh of sl.shapes) {
      const box = { x: sh.x * k, y: sh.y * k, w: sh.w * k, h: sh.h * k, rot: sh.rot || undefined, flipH: sh.flipH || undefined, flipV: sh.flipV || undefined };
      const drawnGeom = !CSS_GEOMS.test(sh.geom) && !isConnectorGeom(sh.geom) ? { prst: sh.geom, ...(sh.adj ? { adj: sh.adj } : {}) } : undefined;
      const border = sh.line && !sh.connector && !drawnGeom ? `${r1(Math.max(0.6, sh.line.w * k))}px ${sh.line.dash ? "dashed" : "solid"} ${sh.line.color}` : undefined;
      const round = sh.geom === "ellipse" ? { ellipse: true } : sh.geom === "roundRect" && sh.radius ? { radius: sh.radius * k } : {};
      const font0 = sl.font ?? "Arial";
      const textEl = (extra: Partial<SlideEl>): SlideEl => {
        const t = sh.text!;
        const [il, it, ir, ib] = presetTextInsets(sh.geom, box.w, box.h, sh.adj);
        return { id: rid(), kind: "text", ...box, ...extra, html: pvParasHtml(t, k, font0, place, fams, usage), pad: [t.t * k + it, t.r * k + ir, t.b * k + ib, t.l * k + il],
          // a box that grows with its text keeps its top: the text runs down from there
          valign: t.autofit === "sp" ? "t" : t.anchor === "ctr" ? "ctr" : t.anchor === "b" ? "b" : "t",
          vert: t.vert || undefined, nowrap: !t.wrap || undefined, shrink: t.autofit === "norm" || undefined, autoH: t.autofit === "sp" || undefined };
      };
      if (sh.fill && !sh.img) addFill(sh.fill, area(sh));
      if (sh.chartSvg) { els.push({ id: rid(), kind: "image", ...box, img: sh.chartSvg, fit: "fill" }); continue; }
      if (sh.img) {
        const small = sh.layer !== "slide" && area(sh) < 0.05;
        const url = await keep(sh.img, small ? "logo" : "photo", sh);
        if (small && !logo) logo = url;
        if (url) els.push({ id: rid(), kind: "image", ...box, img: url, crop: sh.crop ? { l: sh.crop.l / 100, t: sh.crop.t / 100, r: sh.crop.r / 100, b: sh.crop.b / 100 } : undefined, fit: sh.imgFill ? "cover" : undefined, border, ...round, ...(sh.alpha != null && sh.alpha < 1 ? { opacity: Math.round(sh.alpha * 100) / 100 } : {}) });
      } else if ((sh.connector || isConnectorGeom(sh.geom)) && sh.line) {
        els.push({ id: rid(), kind: "line", ...box, geom: { prst: isConnectorGeom(sh.geom) ? sh.geom : "line", ...(sh.adj ? { adj: sh.adj } : {}) }, stroke: strokeOf(sh) });
      } else if (sh.path?.length && (sh.fill || sh.line)) {
        els.push({ id: rid(), kind: "shape", ...box, path: sh.path, fill: firstColour(sh.fill), stroke: strokeOf(sh) });
      }
      const hasText = !!sh.text && sh.text.paras.some((p) => p.runs.some((r) => r.text.trim()));
      if (sh.table) {
        els.push({ id: rid(), kind: "table", ...box, html: pvTableHtml(sh.table, k, font0, place, fams), pad: [0, 0, 0, 0] });
        continue;
      }
      if (sh.img || sh.connector || isConnectorGeom(sh.geom) || sh.path?.length) {
        if (hasText && sh.text) els.push(textEl({}));
        continue;
      }
      if (hasText && sh.text) {
        els.push(textEl(drawnGeom ? { geom: drawnGeom, fill: sh.fill, stroke: strokeOf(sh) } : { ...round, fill: sh.fill, border }));
      } else if (drawnGeom && (sh.fill || sh.line)) {
        els.push({ id: rid(), kind: "shape", ...box, geom: drawnGeom, fill: sh.fill, stroke: strokeOf(sh) });
      } else if (sh.fill || border) {
        els.push({ id: rid(), kind: "shape", ...box, ...round, fill: sh.fill, border });
      }
    }
    const bgImg = await keep(sl.bgImg, "photo");
    // {{num}} (the deck's section number) becomes the number it would have had: 01, 02… in slide order
    if (els.some((e) => e.html?.includes("{{num}}"))) { const nn = String(++secNo).padStart(2, "0"); els.forEach((e) => { if (e.html) e.html = e.html.replace(/\{\{num\}\}/g, nn); }); }
    blocks.push({ id: rid(), type: "slide", title: `Slide ${sl.n}`, slide: { w: SLIDE_W, h: H, bg: sl.bg, bgImg, els } });
  }
  return { blocks, assets: Array.from(assets.values()), fonts: Array.from(fams), logo, usage };
}
/** A deck's look from what its slides really use: main / accent colours by area, text colours and fonts by letters. */
function themeFromUsage(u: DeckUsage): Partial<DocTheme> {
  const sorted = (m: Map<string, number>) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  // near shades of one colour count together (a navy and its darker navy are one brand colour)
  const merged: [string, number][] = [];
  sorted(u.fills).forEach(([c, n]) => {
    const [r, g, b] = hexRgb(c);
    const near = merged.find(([m]) => { const [r2, g2, b2] = hexRgb(m); return Math.abs(r - r2) + Math.abs(g - g2) + Math.abs(b - b2) < 75; });
    if (near) near[1] += n; else merged.push([c, n]);
  });
  merged.sort((a, b) => b[1] - a[1]);
  const strong = merged.filter(([c]) => { const [, sat, l] = hexHsl(c); return l > 0.08 && l < 0.92 && sat > 0.2; }).map(([c]) => c);
  // texts: the colours of letters (weighted), for ink / muted
  const texts = sorted(u.texts).map(([c, n]) => ({ c, n }));
  // strong text colours (titles in brand colours) count as brand colours too, after the fills
  const strongTexts = texts.filter((t) => { const [, sat, l] = hexHsl(t.c); return sat > 0.3 && l > 0.12 && l < 0.85; }).map((t) => t.c);
  const out = themeFromColours([...strong, ...strongTexts.filter((c) => !strong.includes(c))], texts);
  const top = (m: Map<string, number>) => sorted(m)[0]?.[0];
  const head = top(u.bigFonts) ?? top(u.smallFonts), body = top(u.smallFonts) ?? head;
  if (head) out.headingFont = head;
  if (body) out.bodyFont = body;
  return out;
}

// -- PDF: each page as a free-layout page (pdf.js draws it; its texts become editable boxes) --
async function loadPdfjs(): Promise<any> {
  const pdfjs: any = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const w: any = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = w.default ?? w;
  }
  return pdfjs;
}
interface PItem { s: string; x: number; y: number; w: number; size: number; fam: string; weight: number; italic: boolean; color: string; asc: number; desc: number; spaced: boolean }
interface PLine { items: PItem[]; x0: number; x1: number; y: number; size: number }
const nearColour = (a: string, b: string) => { if (a === b) return true; const x = hexRgb(a), y = hexRgb(b); return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) < 46; };
const sameStyle = (a: PItem, b: PItem) => a.fam === b.fam && a.weight === b.weight && a.italic === b.italic && nearColour(a.color, b.color) && Math.abs(a.size - b.size) < 0.6;
/** Splits the text items of a page into lines (same baseline, close together). */
function pdfLines(items: PItem[]): PLine[] {
  // big text first, so small raised pieces (®, footnote marks) join the line they belong to
  const sorted = items.slice().sort((a, b) => (Math.abs(a.size - b.size) > 1.5 ? b.size - a.size : Math.abs(a.y - b.y) < Math.min(a.size, b.size) * 0.35 ? a.x - b.x : a.y - b.y));
  const lines: PLine[] = [];
  sorted.forEach((it) => {
    // a wide blank between columns joins nothing
    if (!it.s.trim() && it.w > it.size * 2) return;
    const ln = lines.find((l) => Math.abs(l.y - it.y) < (it.size < l.size * 0.8 && it.y < l.y - l.size * 0.05 ? l.size * 0.6 : Math.min(l.size, it.size) * 0.4) && it.x >= l.x0 - it.size && it.x - l.x1 < Math.max(l.size, it.size) * 1.6);
    if (ln) { ln.items.push(it); ln.x0 = Math.min(ln.x0, it.x); ln.x1 = Math.max(ln.x1, it.x + it.w); ln.size = Math.max(ln.size, it.size); const main = ln.items.filter((x) => x.s.trim() && x.size >= ln.size * 0.8); if (main.length) ln.y = main.reduce((s2, x) => s2 + x.y, 0) / main.length; }
    else lines.push({ items: [it], x0: it.x, x1: it.x + it.w, y: it.y, size: it.size });
  });
  lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));
  return lines.filter((l) => l.items.some((i) => i.s.trim()));
}
/** Groups lines into text boxes: same style, aligned, one under the other. */
function pdfBlocks(lines: PLine[]): { lines: PLine[]; align: "left" | "center" | "right" }[] {
  const out: { lines: PLine[]; align: "left" | "center" | "right" }[] = [];
  const main = (l: PLine) => l.items.filter((i) => i.s.trim()).sort((a, b) => b.s.length - a.s.length)[0] ?? l.items[0];
  lines.slice().sort((a, b) => a.y - b.y || a.x0 - b.x0).forEach((l) => {
    const m = main(l);
    const fit = out.slice().reverse().find((b) => {
      const last = b.lines[b.lines.length - 1], lm = main(last);
      if (!sameStyle(lm, m) && !(lm.fam === m.fam && Math.abs(lm.size - m.size) < 0.6 && nearColour(lm.color, m.color))) return false;
      const gap = l.y - last.y;
      if (gap < l.size * 0.85 || gap > l.size * 1.85) return false;
      if (b.lines.length > 1) { const g0 = last.y - b.lines[b.lines.length - 2].y; if (Math.abs(gap - g0) > l.size * 0.3) return false; }
      const left = Math.abs(l.x0 - last.x0) < l.size * 0.9;
      const center = Math.abs((l.x0 + l.x1) / 2 - (last.x0 + last.x1) / 2) < l.size * 1.2;
      const right = Math.abs(l.x1 - last.x1) < l.size * 0.9;
      const overlap = Math.min(l.x1, last.x1) - Math.max(l.x0, last.x0) > -l.size;
      if (!overlap) return false;
      if (left) { if (b.align !== "left" && b.lines.length > 1) return false; b.align = b.lines.length === 1 ? "left" : b.align; return true; }
      if (center) { if (b.lines.length > 1 && b.align !== "center") return false; b.align = "center"; return true; }
      if (right) { if (b.lines.length > 1 && b.align !== "right") return false; b.align = "right"; return true; }
      return false;
    });
    if (fit) fit.lines.push(l); else out.push({ lines: [l], align: "left" });
  });
  return out;
}
async function pdfToPages(buf: Uint8Array, opts: { makePlace: (allText: string) => (s: string) => string; onPage?: (n: number, of: number) => void; maxPages?: number }): Promise<{ blocks: DocBlock[]; assets: ImportedAsset[]; fonts: string[]; text: string; pages: number; lines: { page: number; text: string; size: number; weight: number; spaced: boolean; y: number }[]; palette: string[]; textColours: { c: string; n: number }[]; terms: { annualIncreasePct?: number } }> {
  const pdfjs = await loadPdfjs();
  const found: { annualIncreasePct?: number } = {};
  const doc = await pdfjs.getDocument({ data: buf.slice(), isEvalSupported: false, useSystemFonts: true }).promise;
  const blocks: DocBlock[] = [];
  const assets: ImportedAsset[] = [];
  const fams = new Set<string>();
  const textCol = new Map<string, number>();
  const allLines: { page: number; text: string; size: number; weight: number; spaced: boolean; y: number }[] = [];
  const seenImg = new Map<string, true>();
  const bgCanvases: HTMLCanvasElement[] = [];
  const measure = newCanvas(8, 8).getContext("2d")!;
  const n = Math.min(doc.numPages, opts.maxPages ?? 60);
  const pending: { page: any; vp1: any; items: PItem[]; full: Uint8ClampedArray; bg: Uint8ClampedArray; cw: number; ch: number; RS: number; bgc: HTMLCanvasElement; k: number; H: number; photos: SlideEl[];
    smalls: { i: number; x: number; y: number; w: number; h: number; sig: number[] }[]; kept: Set<number>; rerender: (skip: Set<number>) => Promise<HTMLCanvasElement>; kx: number }[] = [];
  for (let pn = 1; pn <= n; pn++) {
    opts.onPage?.(pn, n);
    const page = await doc.getPage(pn);
    const vp1 = page.getViewport({ scale: 1 });
    const k = SLIDE_W / vp1.width, H = Math.round(vp1.height * k);
    const RS = Math.min(2.2, 1700 / vp1.width);
    const vp = page.getViewport({ scale: RS });
    const full = newCanvas(vp.width, vp.height), bgc = newCanvas(vp.width, vp.height);
    const fg = full.getContext("2d", { willReadFrequently: true })!;
    await page.render({ canvasContext: fg, viewport: vp }).promise;
    const bg = bgc.getContext("2d", { willReadFrequently: true })!;
    // the same page without its texts: they come back as editable boxes on top
    const glyphs: { ch: string; x: number; y: number }[] = [];
    (bg as any).fillText = function (this: CanvasRenderingContext2D, t: string, gx: number, gy: number) { const m = this.getTransform(); glyphs.push({ ch: String(t), x: (m.a * gx + m.c * gy + m.e) / RS, y: (m.b * gx + m.d * gy + m.f) / RS }); };
    (bg as any).strokeText = () => undefined;
    await page.render({ canvasContext: bg, viewport: vp }).promise;
    const fd = fg.getImageData(0, 0, full.width, full.height).data, bd = bg.getImageData(0, 0, bgc.width, bgc.height).data;
    // the photos: drawn alone, and the page drawn without them. A photo nothing else covers becomes its own
    // picture on the page (to replace / move it); the others stay in the background.
    const noText = async (skip: Set<number> | "big") => {
      const c = newCanvas(vp.width, vp.height), g = c.getContext("2d", { willReadFrequently: true })!;
      const solo = newCanvas(vp.width, vp.height), sg = solo.getContext("2d", { willReadFrequently: true })!;
      const shots: { i: number; x: number; y: number; w: number; h: number }[] = [];
      /** small pictures (logos): where, and a tiny thumbnail to recognise the same picture on other pages */
      const smalls: { i: number; x: number; y: number; w: number; h: number; sig: number[] }[] = [];
      (g as any).fillText = () => undefined; (g as any).strokeText = () => undefined;
      const real = g.drawImage.bind(g);
      let idx = 0;
      (g as any).drawImage = function (this: CanvasRenderingContext2D, img: any, ...a: number[]) {
        const i = idx++;
        try {
          const iw = Number(img?.width) || 0, ih = Number(img?.height) || 0, m = this.getTransform();
          if (iw >= 16 && ih >= 16 && Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6) {
            const [dx, dy, dw, dh] = a.length >= 8 ? a.slice(4, 8) : a.length >= 4 ? a.slice(0, 4) : [a[0], a[1], iw, ih];
            const X1 = m.a * dx + m.e, Y1 = m.d * dy + m.f, X2 = m.a * (dx + dw) + m.e, Y2 = m.d * (dy + dh) + m.f;
            const r = { x: Math.min(X1, X2), y: Math.min(Y1, Y2), w: Math.abs(X2 - X1), h: Math.abs(Y2 - Y1) };
            const area = (r.w * r.h) / (c.width * c.height);
            if (skip === "big" && area > 0.0008 && area <= 0.06 && r.w > 12 && r.h > 6) {
              try {
                const t = newCanvas(12, 12), tg = t.getContext("2d", { willReadFrequently: true })!;
                if (a.length >= 8) tg.drawImage(img, a[0], a[1], a[2], a[3], 0, 0, 12, 12); else tg.drawImage(img, 0, 0, 12, 12);
                smalls.push({ i, ...r, sig: Array.from(tg.getImageData(0, 0, 12, 12).data) });
              } catch { /* no thumbnail: not a logo candidate */ }
            }
            if (skip === "big" ? area > 0.015 : skip.has(i)) {
              shots.push({ i, ...r });
              if (skip === "big") { sg.setTransform(m); sg.drawImage(img, ...(a as [number, number, number, number])); sg.setTransform(1, 0, 0, 1, 0, 0); }
              return;
            }
          }
        } catch { /* drawn as usual */ }
        return (real as any)(img, ...a);
      };
      await page.render({ canvasContext: g, viewport: vp }).promise;
      return { c, solo, shots, smalls };
    };
    let pageBg = bgc;
    const photoEls: SlideEl[] = [];
    let smalls: { i: number; x: number; y: number; w: number; h: number; sig: number[] }[] = [];
    let kept = new Set<number>();
    try {
      const first = await noText("big");
      smalls = first.smalls;
      if (first.shots.length) {
        const sd = first.solo.getContext("2d", { willReadFrequently: true })!;
        const keep = new Set<number>();
        for (const sh of first.shots) {
          const x0 = Math.max(0, Math.floor(sh.x)), y0 = Math.max(0, Math.floor(sh.y)), x1 = Math.min(bgc.width, Math.ceil(sh.x + sh.w)), y1 = Math.min(bgc.height, Math.ceil(sh.y + sh.h));
          if (x1 - x0 < 8 || y1 - y0 < 8) continue;
          const pd = sd.getImageData(x0, y0, x1 - x0, y1 - y0).data;
          // every pixel: even a thin line drawn over the photo keeps it in the background
          let opaque = 0, diff = 0, total = 0;
          for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
            const q = ((yy - y0) * (x1 - x0) + (xx - x0)) * 4, o = (yy * bgc.width + xx) * 4;
            total++;
            if (pd[q + 3] < 200) continue;
            opaque++;
            if (Math.abs(pd[q] - bd[o]) + Math.abs(pd[q + 1] - bd[o + 1]) + Math.abs(pd[q + 2] - bd[o + 2]) >= 36) diff++;
          }
          // nothing drawn over it and not clipped into another shape
          if (total && opaque / total > 0.5 && diff <= Math.max(40, opaque * 0.00002)) keep.add(sh.i);
        }
        kept = keep;
        if (keep.size) {
          const second = keep.size === first.shots.length ? first : await noText(keep);
          pageBg = second.c;
          for (const sh of first.shots.filter((x) => keep.has(x.i))) {
            const x0 = Math.max(0, Math.floor(sh.x)), y0 = Math.max(0, Math.floor(sh.y)), w = Math.min(bgc.width, Math.ceil(sh.x + sh.w)) - x0, h = Math.min(bgc.height, Math.ceil(sh.y + sh.h)) - y0;
            const kk = Math.min(1, 1600 / Math.max(w, h));
            const c2 = newCanvas(Math.max(1, Math.round(w * kk)), Math.max(1, Math.round(h * kk)));
            c2.getContext("2d")!.drawImage(first.solo, x0, y0, w, h, 0, 0, c2.width, c2.height);
            const blob = await canvasBlob(c2, "image/webp", 0.86);
            const url = URL.createObjectURL(blob);
            assets.push({ url, blob, w: c2.width, h: c2.height, role: "photo" });
            const kx = SLIDE_W / vp.width;
            photoEls.push({ id: rid(), kind: "image", x: r1(x0 * kx), y: r1(y0 * kx), w: r1(w * kx), h: r1(h * kx), img: url, fit: "cover" });
          }
        }
      }
    } catch { /* the photos stay in the background */ }
    const tc = await page.getTextContent();
    const items: PItem[] = [];
    for (const it of tc.items as any[]) {
      if (typeof it.str !== "string" || !it.str) continue;
      const t = it.transform as number[];
      const size = Math.hypot(t[2], t[3]);
      if (!size || size < 2) continue;
      let face = { family: "Arial", weight: 400, italic: false };
      try { const fo = page.commonObjs.get(it.fontName); face = parseFontName(fo?.name ?? ""); if (fo?.bold && face.weight < 700) face.weight = 700; if (fo?.italic) face.italic = true; } catch { /* the font isn't known: Arial */ }
      const st = (tc.styles ?? {})[it.fontName] ?? {};
      const asc = Math.min(1.15, Math.max(0.65, Number(st.ascent ?? 0.9) || 0.9)), desc = Math.min(0.4, Math.max(0.1, Math.abs(Number(st.descent ?? -0.21)) || 0.21));
      const x = t[4], y = vp1.height - t[5];
      let s = it.str as string, spaced = false;
      if (/^(\S ){1,}\S$/.test(s) && s.length >= 3 && it.width > size * s.replace(/ /g, "").length * 0.5) {
        s = s.replace(/ /g, ""); spaced = true;
        // word gaps of tracked text: where the drawn letters are further apart than usual
        const gs = glyphs.filter((gl) => gl.ch.trim() && Math.abs(gl.y - y) < size * 0.4 && gl.x >= x - 1 && gl.x <= x + it.width + 1).sort((a, b) => a.x - b.x);
        const chars = Array.from(s);
        if (gs.length === chars.length && gs.length > 3) {
          // each step minus the letter's own width = the tracking; a step with clearly more is a word gap
          measure.font = `${face.weight} ${size}px ${webFont(face.family).stack}`;
          const extra = gs.slice(1).map((gl, i) => gl.x - gs[i].x - measure.measureText(chars[i]).width);
          const med = extra.slice().sort((a, b) => a - b)[Math.floor(extra.length / 2)] ?? 0;
          s = chars.map((c, i) => (i > 0 && extra[i - 1] - med > size * 0.17 ? " " + c : c)).join("");
        }
      }
      // the colour: pixels the text adds to the page
      let color = "#000000";
      const x0 = Math.max(0, Math.floor(x * RS)), x1 = Math.min(full.width - 1, Math.ceil((x + Math.max(it.width, size * 0.4)) * RS));
      const y0 = Math.max(0, Math.floor((y - size * asc) * RS)), y1 = Math.min(full.height - 1, Math.ceil((y + size * 0.1) * RS));
      if (s.trim() && x1 > x0 && y1 > y0) {
        const px: [number, number, number, number][] = [];
        const step = Math.max(1, Math.floor((x1 - x0) * (y1 - y0) / 6000));
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx += step) {
          const i = (yy * full.width + xx) * 4;
          const d = Math.abs(fd[i] - bd[i]) + Math.abs(fd[i + 1] - bd[i + 1]) + Math.abs(fd[i + 2] - bd[i + 2]);
          if (d > 60) px.push([d, fd[i], fd[i + 1], fd[i + 2]]);
        }
        if (px.length) {
          px.sort((a, b) => b[0] - a[0]);
          const top = px.slice(0, Math.max(1, Math.ceil(px.length * 0.35)));
          color = rgbHex(top.reduce((a, p) => a + p[1], 0) / top.length, top.reduce((a, p) => a + p[2], 0) / top.length, top.reduce((a, p) => a + p[3], 0) / top.length);
          // snap near-black / near-white
          const [rr, gg, bb] = hexRgb(color);
          if (rr < 40 && gg < 40 && bb < 40) color = "#000000"; else if (rr > 238 && gg > 238 && bb > 238) color = "#FFFFFF";
          textCol.set(color, (textCol.get(color) ?? 0) + s.length);
        }
      }
      fams.add(face.family);
      // the same text drawn twice on the same spot (masters and slides both have it): once
      if (s.trim() && items.some((o) => o.s === s && Math.abs(o.x - x) < 1 && Math.abs(o.y - y) < 1)) continue;
      items.push({ s, x, y, w: it.width, size, fam: face.family, weight: face.weight, italic: face.italic, color, asc, desc, spaced });
    }
    // pictures of the page, for the library (and the "our layout" mode)
    try {
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (fn !== pdfjs.OPS.paintImageXObject) continue;
        const id = ops.argsArray[i]?.[0];
        if (!id || seenImg.has(id)) continue;
        seenImg.set(id, true);
        const obj: any = await new Promise((ok) => { try { page.objs.get(id, ok); } catch { ok(null); } setTimeout(() => ok(null), 1500); });
        if (!obj || obj.width * obj.height < 160 * 160) continue;
        const c = newCanvas(obj.width, obj.height);
        const g = c.getContext("2d")!;
        if (obj.bitmap) g.drawImage(obj.bitmap, 0, 0);
        else if (obj.data) {
          const im = g.createImageData(obj.width, obj.height);
          const src = obj.data as Uint8ClampedArray;
          if (src.length === obj.width * obj.height * 4) im.data.set(src);
          else if (src.length === obj.width * obj.height * 3) { for (let p = 0, q = 0; p < src.length; p += 3, q += 4) { im.data[q] = src[p]; im.data[q + 1] = src[p + 1]; im.data[q + 2] = src[p + 2]; im.data[q + 3] = 255; } }
          else continue;
          g.putImageData(im, 0, 0);
        } else continue;
        const kk = Math.min(1, 1600 / Math.max(c.width, c.height));
        const c2 = kk < 1 ? newCanvas(c.width * kk, c.height * kk) : c;
        if (kk < 1) c2.getContext("2d")!.drawImage(c, 0, 0, c2.width, c2.height);
        const blob = await canvasBlob(c2, "image/webp", 0.84);
        assets.push({ url: URL.createObjectURL(blob), blob, w: c2.width, h: c2.height, role: "photo" });
      }
    } catch { /* pictures are a bonus */ }
    bgCanvases.push(bgc);
    pending.push({ page, vp1, items, full: fd, bg: bd, cw: full.width, ch: full.height, RS, bgc: pageBg, k, H, photos: photoEls, smalls, kept, rerender: async (skip: Set<number>) => (await noText(skip)).c, kx: SLIDE_W / vp.width });
  }
  // the client's logo: a small picture of the cover that no other page has (your own logo repeats on the others).
  // It leaves the background and becomes a picture bound to {{client.logo}} (each deal shows its client's).
  try {
    const p1 = pending[0];
    if (p1 && pending.length > 1 && p1.smalls.length) {
      const same = (a: number[], b: number[]) => { let d = 0, n = 0; for (let q = 0; q < a.length; q += 4) { const w = (a[q + 3] + b[q + 3]) / 510; if (w < 0.1) continue; d += (Math.abs(a[q] - b[q]) + Math.abs(a[q + 1] - b[q + 1]) + Math.abs(a[q + 2] - b[q + 2])) / 3; n++; } return n ? d / n < 22 : false; };
      const elsewhere = pending.slice(1).flatMap((pg) => pg.smalls.map((x) => x.sig));
      const uniq = p1.smalls.filter((x) => !elsewhere.some((o) => same(o, x.sig)));
      // next to another logo (a logo bar) wins; else the one furthest right
      const logo = uniq.length === 1 ? uniq[0] : uniq.length > 1 && uniq.length <= 3 ? uniq.slice().sort((a, b) => b.x - a.x)[0] : null;
      if (logo) {
        p1.bgc = await p1.rerender(new Set([...p1.kept, logo.i]));
        // the logo's own box colour (its edges, as the page showed it): painted under the new logo so the bar keeps its look
        const W = p1.cw, bdat = p1.bg;
        const x0 = Math.max(0, Math.floor(logo.x)), y0 = Math.max(0, Math.floor(logo.y)), x1 = Math.min(W - 1, Math.ceil(logo.x + logo.w) - 1), y1 = Math.min(p1.ch - 1, Math.ceil(logo.y + logo.h) - 1);
        let rr = 0, gg = 0, bb = 0, nn = 0;
        const add = (x: number, y: number) => { const o = (y * W + x) * 4; rr += bdat[o]; gg += bdat[o + 1]; bb += bdat[o + 2]; nn++; };
        for (let x = x0; x <= x1; x += 2) { add(x, y0 + 1); add(x, y1 - 1); }
        for (let y = y0; y <= y1; y += 2) { add(x0 + 1, y); add(x1 - 1, y); }
        const fill = nn ? rgbHex(rr / nn, gg / nn, bb / nn) : "#FFFFFF";
        const [fr, fg, fb] = hexRgb(fill);
        const lum = 0.299 * fr + 0.587 * fg + 0.114 * fb;
        p1.photos.push({ id: rid(), kind: "image", bind: "client.logo", fit: "contain", fill, color: lum > 150 ? "#111111" : "#FFFFFF",
          x: r1(logo.x * p1.kx), y: r1(logo.y * p1.kx), w: r1(logo.w * p1.kx), h: r1(logo.h * p1.kx), pad: [0, 0, 0, 0] });
      }
    }
  } catch { /* the cover keeps its picture */ }
  // fonts first (to measure texts with the fonts the page will use)
  await ensureWebFonts(Array.from(fams));
  const place = opts.makePlace(pending.map((pg) => pdfLines(pg.items).map((l) => l.items.map((i) => i.s).join(" ")).join("\n")).join("\n"));
  for (const pg of pending) {
    const { k, H, bgc } = pg;
    const items = mergeRuns(pg.items);
    mapFigures(items, found);
    const lines = pdfLines(items);
    const groups = pdfBlocks(lines);
    // the photos first (under the texts)
    const els: SlideEl[] = [...pg.photos];
    groups.forEach((gr) => {
      const L = gr.lines;
      const size = Math.max(...L.map((l) => l.size));
      const gap = L.length > 1 ? (L[L.length - 1].y - L[0].y) / (L.length - 1) : size * 1.2;
      const lh = gap * k;
      const head = L[0].items.find((i) => i.s.trim()) ?? L[0].items[0];
      const asc = head.asc, desc = head.desc;
      // where the first baseline sits in a line box of height lh
      const off = lh / 2 + ((asc - desc) / 2) * size * k;
      const x0 = Math.min(...L.map((l) => l.x0)), x1 = Math.max(...L.map((l) => l.x1));
      const html = L.map((l) => {
        // spans of one style; spaces where the gap between items is a word gap
        // w = up to where the next span starts; ink = up to the end of its last letter
        const spans: { it: PItem; text: string; w: number; ink: number; tail: number }[] = [];
        let prevEnd = l.items[0].x;
        l.items.forEach((it, i) => {
          const gapPx = it.x - prevEnd;
          const last = spans[spans.length - 1];
          const space = i > 0 && gapPx > Math.min(it.size, l.size) * (it.spaced || last?.it.spaced ? 0.1 : 0.2) && !/\s$/.test(last?.text ?? "") && !/^\s/.test(it.s) ? " " : "";
          const blank = !it.s.trim();
          // a space with almost no width (before ®, ™…): the letters touch in the PDF
          if (blank && it.w < it.size * 0.12) { prevEnd = it.x + it.w; return; }
          // a tab-like gap starts a new span even in the same style, so the gap isn't spread over the letters
          const tab = gapPx > Math.min(it.size, l.size) * 0.65 || (last != null && last.tail > Math.min(it.size, l.size) * 0.65);
          if (last && (blank || (sameStyle(last.it, it) && !tab))) {
            last.text += space + it.s; last.w += it.w + Math.max(0, gapPx);
            if (blank) last.tail += it.w + Math.max(0, gapPx); else { last.ink = last.w; last.tail = 0; }
          } else {
            if (last) { if (space) last.text += " "; last.w += Math.max(0, gapPx); last.tail += Math.max(0, gapPx); }
            spans.push({ it, text: it.s, w: it.w, ink: it.w, tail: 0 });
          }
          prevEnd = it.x + it.w;
        });
        const content = spans.map((sp, si) => {
          const it = sp.it, wf = webFont(it.fam);
          const px = it.size * k;
          const css = [`font-family:${wf.stack}`, `font-size:${r1(px)}px`, `color:${it.color}`];
          const wt = it.weight !== 400 ? it.weight : wf.weight ?? 400;
          if (wt !== 400) css.push(`font-weight:${wt}`);
          if (it.italic) css.push("font-style:italic");
          // a small raised piece (®, ™, footnote numbers)
          if (it.size < l.size * 0.8 && l.y - it.y > l.size * 0.12) css.push(`position:relative;top:${r1(-(l.y - it.y) * k)}px`);
          // letter spacing that makes the line as wide as in the PDF (spaced headings; another font's widths)
          measure.font = `${it.italic ? "italic " : ""}${wt} ${px}px ${wf.stack}`;
          const inkText = sp.text.replace(/\s+$/, "");
          const natural = measure.measureText(inkText).width;
          const target = sp.w * k, inkW = sp.ink * k;
          const chars = Array.from(inkText).length;
          if ((chars > 3 || (it.spaced && chars > 1)) && natural > 0 && !/\{\{/.test(sp.text)) {
            const ls = (inkW - natural) / (it.spaced ? chars : Math.max(1, chars - 1));
            if (it.spaced || Math.abs(inkW - natural) > inkW * 0.035) css.push(`letter-spacing:${r1(Math.max(-px * 0.12, Math.min(px * 0.9, ls)) * 100) / 100}px`);
          }
          // a wide gap after it (tab, columns of a row): the next piece starts where it did
          if (si < spans.length - 1) {
            measure.font = `${it.italic ? "italic " : ""}${wt} ${px}px ${wf.stack}`;
            const ls = /letter-spacing:(-?[\d.]+)px/.exec(css.join(";"));
            const shown = measure.measureText(sp.text).width + (ls ? Number(ls[1]) * Array.from(sp.text).length : 0);
            if (sp.tail > it.size * 0.5 || shown < target * 0.97) css.push(`display:inline-block;min-width:${r1(target)}px`);
          }
          return `<span style="${css.join(";")}">${esc(place(sp.text))}</span>`;
        }).join("");
        const lead = (l.x0 - x0) * k;
        return `<p style="line-height:${r1(lh)}px;white-space:pre${gr.align === "left" && lead > 2 ? `;padding-left:${r1(lead)}px` : ""}">${content}</p>`;
      }).join("");
      const top = L[0].y * k - off;
      els.push({ id: rid(), kind: "text", x: r1(x0 * k - 1), y: r1(top), w: r1((x1 - x0) * k + size * k * 0.6 + 2), h: r1(lh * L.length), html: html.replace(/<p style="/g, `<p style="text-align:${gr.align};`), pad: [0, 0, 0, 0], nowrap: true });
      L.forEach((l) => allLines.push({ page: blocks.length + 1, text: l.items.map((i) => i.s).join(" ").replace(/\s+/g, " ").trim(), size: l.size, weight: head.weight, spaced: l.items.some((i) => i.spaced), y: l.y }));
    });
    // the page without its texts: a picture (or a plain colour when it's all one colour)
    const g = bgc.getContext("2d", { willReadFrequently: true })!;
    const d = g.getImageData(0, 0, bgc.width, bgc.height).data;
    let plain = true; const r0 = d[0], g0 = d[1], b0 = d[2];
    for (let i = 0; i < d.length; i += 4 * 97) { if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 18) { plain = false; break; } }
    let bgImg: string | undefined;
    if (!plain) {
      const kk = Math.min(1, 1600 / bgc.width);
      const c2 = kk < 1 ? newCanvas(bgc.width * kk, bgc.height * kk) : bgc;
      if (kk < 1) c2.getContext("2d")!.drawImage(bgc, 0, 0, c2.width, c2.height);
      const blob = await canvasBlob(c2, "image/webp", 0.86);
      bgImg = URL.createObjectURL(blob);
      assets.push({ url: bgImg, blob, w: c2.width, h: c2.height, role: "page" });
    }
    blocks.push({ id: rid(), type: "slide", title: `Page ${blocks.length + 1}`, slide: { w: SLIDE_W, h: H, bg: rgbHex(r0, g0, b0), bgImg, els } });
  }
  const palette = await paletteOf([...bgCanvases.slice(0, 12), ...assets.filter((a) => a.role === "photo").slice(0, 8).map((a) => a.blob)]);
  const textColours = Array.from(textCol.entries()).map(([c, nn]) => ({ c, n: nn })).sort((a, b) => b.n - a.n);
  try { await doc.destroy(); } catch { /* done */ }
  return { blocks, assets, fonts: Array.from(fams), text: allLines.map((l) => l.text).join("\n"), pages: n, lines: allLines, palette, textColours, terms: found };
}
/** Pieces of one word or figure the PDF wrote separately ("Descuent" "o", "-" "722" ",5" "EUR") joined; tab gaps stay apart. */
function mergeRuns(items: PItem[]): PItem[] {
  const out: PItem[] = [];
  const wideBlank = (x: PItem) => !x.s.trim() && x.w > x.size * 0.6;
  for (const it0 of items) {
    const it = { ...it0 };
    const prev = out[out.length - 1];
    if (prev && !prev.spaced && !it.spaced && !wideBlank(prev) && !wideBlank(it) && Math.abs(prev.y - it.y) < Math.min(prev.size, it.size) * 0.3
      && (sameStyle(prev, it) || !it.s.trim()) && it.x >= prev.x + prev.w - it.size * 0.3 && it.x - (prev.x + prev.w) < it.size * 0.35) {
      const gap = it.x - (prev.x + prev.w);
      // a space with almost no width (before ®, ™…) is not a space: the letters touch
      if (!it.s.trim() && it.w < it.size * 0.12) { prev.w = it.x + it.w - prev.x; continue; }
      prev.s += (gap > it.size * 0.12 && !/\s$/.test(prev.s) && !/^\s/.test(it.s) ? " " : "") + it.s;
      prev.w = it.x + it.w - prev.x;
      continue;
    }
    out.push(it);
  }
  return out;
}
/**
 * The figures of a price page become the deal's values, by what their row and column say:
 * "Base fee 12.000 €" → {{product.row1.amount}}, "Anualidad" under "CONTRATO 3 AÑOS" → {{product.y3.annual}},
 * "ANUALIDAD FINAL … 9.056 €" → {{product.annual}}, SUBTOTAL / Descuento / TOTAL of services, their days,
 * the commercial discount %, "antes del 15/08/2026" → {{valid_until}}, "Incremento anual del 5%" → {{contract.increase_pct}}.
 * Anything not clearly one of those stays as typed text (Make variable turns it into one).
 */
function mapFigures(items: PItem[], found: { annualIncreasePct?: number } = {}) {
  const MONEY = /-?\s?\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?\s?(?:€|EUR\b)/;
  const PCT = /-?\d+(?:[.,]\d+)?\s?%/;
  const DATE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2} de [a-záéíóú]+ de \d{4}\b/i;
  const txt = (xs: PItem[]) => xs.map((x) => x.s).join(" ").replace(/\s+/g, " ").trim();
  const rowOf = (it: PItem) => items.filter((o) => o !== it && Math.abs(o.y - it.y) < Math.max(it.size, o.size) * 0.7);
  const leftOf = (it: PItem) => txt(rowOf(it).filter((o) => o.x < it.x).sort((a, b) => a.x - b.x));
  const above = (it: PItem, dy: number) => items.filter((o) => o.y < it.y - 1 && o.y > it.y - dy && o.x <= it.x + 40 && o.x + o.w >= it.x - 420).sort((a, b) => b.y - a.y);
  const yearsOver = (it: PItem) => {
    // the column heading above: "CONTRATO 3 AÑOS", "3-year contract" (the nearest one to its left)
    const hs = items.filter((o) => o.y < it.y && /(\d+)\s*(?:AÑOS?|años?|years?|YEARS?)\b|(\d+)-year/.test(o.s) && o.x <= it.x + 10).sort((a, b) => b.x - a.x || b.y - a.y);
    const m = hs[0] && /(\d+)\s*(?:AÑOS?|años?|years?|YEARS?)\b|(\d+)-year/.exec(hs[0].s);
    return m ? Number(m[1] ?? m[2]) : 0;
  };
  // a percentage keeps its sign ("-20%" → "-{{product.discount_pct}}"); amounts carry their own
  const put = (it: PItem, re: RegExp, key: string) => { it.s = it.s.replace(re, (m) => `${/^\s/.test(m) ? " " : ""}${re === PCT && /^\s*[-−]/.test(m) ? m.trim()[0] : ""}{{${key}}}`); };
  for (const it of items) {
    const s = it.s;
    if (!s.trim() || /\{\{/.test(s)) continue;
    const row = `${leftOf(it)} ${s}`.toLowerCase();
    const up = above(it, it.size * 3.2).map((o) => o.s).join(" ").toLowerCase();
    if (MONEY.test(s)) {
      const yrs = yearsOver(it);
      if (/anualidad final|inversi[oó]n final|final annual|precio final|importe final/.test(`${row} ${up}`)) put(it, MONEY, "product.annual");
      else if (/base fee|cuota base|licencia base|tarifa base/.test(row)) put(it, MONEY, "product.row1.amount");
      else if (/descuento por (duraci|plazo|volumen)|duration discount|multi-?year discount/.test(row)) put(it, MONEY, yrs ? `product.y${yrs}.discount` : "product.discount");
      else if (/(^|\s)(anualidad|annual fee|annual|cuota anual|total anual)\s*[-\d]/.test(row) || /^\s*(anualidad|annual|cuota anual)\s*$/.test(leftOf(it).toLowerCase())) put(it, MONEY, yrs ? `product.y${yrs}.annual` : "product.gross");
      else if (/\bsubtotal\b/.test(row)) put(it, MONEY, "service.gross");
      else if (/descuento por firma|early.?sign|descuento comercial/.test(row)) put(it, MONEY, "service.discount");
      else if (/(^|\s)total(\s|$)/.test(row) && !/total precio|por empresa/.test(row)) put(it, MONEY, "service.total");
    } else if (PCT.test(s)) {
      if (/incremento anual|yearly increase|annual increase|subida anual/.test(row)) { found.annualIncreasePct = Number(PCT.exec(s)![0].replace(/[^\d,.]/g, "").replace(",", ".")) || undefined; put(it, PCT, "contract.increase_pct"); }
      else if (/descuento comercial|commercial discount/.test(up) || /por firma anticipada|early signature/.test(row)) put(it, PCT, /descuento por firma/.test(row) ? "service.discount_pct" : "product.discount_pct");
    }
    // days of the services in their subtotal / total row ("16 jornadas")
    if (/\b(subtotal|total)\b/.test(row) && !/total precio|por empresa/.test(row)) {
      const next = rowOf(it).filter((o) => o.x > it.x && o.s.trim()).sort((a, b) => a.x - b.x)[0];
      if (/^\s*\d+(?:,\d+)?\s*$/.test(it.s) && next && /^\s*(jornadas|días|dias|days)\b/i.test(next.s)) it.s = it.s.replace(/\d+(?:,\d+)?/, "{{service.days}}");
      else it.s = it.s.replace(/\b\d+(?:,\d+)?(?=\s*(jornadas|días|dias|days)\b)/i, "{{service.days}}");
    }
    if (DATE.test(it.s) && /antes del|antes de|before|hasta el|valid until|válid[oa] hasta/.test(row)) put(it, DATE, "valid_until");
  }
}
/** Sections of a PDF read with pdf.js: per page, its biggest text is the title, a small spaced capital line the eyebrow. */
function sectionsFromPdfLines(lines: { page: number; text: string; size: number; weight: number; spaced: boolean; y: number }[]): { title: string; lines: string[]; eyebrow?: string }[] {
  const pages = new Map<number, typeof lines>();
  lines.forEach((l) => { if (!pages.has(l.page)) pages.set(l.page, []); pages.get(l.page)!.push(l); });
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const med = sizes[Math.floor(sizes.length / 2)] ?? 10;
  const out: { title: string; lines: string[]; eyebrow?: string }[] = [];
  pages.forEach((ls) => {
    const sorted = ls.slice().sort((a, b) => a.y - b.y);
    const max = Math.max(...sorted.map((l) => l.size));
    const titleLines = max > med * 1.3 ? sorted.filter((l) => l.size > max * 0.9) : [sorted[0]];
    const title = titleLines.map((l) => l.text).join(" ");
    const eb = sorted.find((l) => l.spaced && l.y < (titleLines[0]?.y ?? 0) && l.text.length < 60);
    const rest = sorted.filter((l) => !titleLines.includes(l) && l !== eb && !/confidencial|confidential|^\d{1,3}$/i.test(l.text)).map((l) => (l.text.length < 70 && !/[.:]$/.test(l.text) ? `- ${l.text}` : l.text));
    out.push({ title, lines: rest, eyebrow: eb ? sentenceCase(eb.text.replace(/^\d+\s*-\s*/, "")) : undefined });
  });
  return out;
}
/** DOCX: theme colours and heading look (theme1.xml, styles.xml) and every picture, in order. */
async function docxLook(buf: Uint8Array): Promise<{ theme: Partial<DocTheme>; fonts: string[]; images: Blob[] }> {
  const zip = await openZip(buf);
  const theme: Partial<DocTheme> = {}; const fonts: string[] = [];
  try {
    const th = zip.file("word/theme/theme1.xml");
    if (th) {
      const root = xroot(xparse(await th.async("string")));
      const clr = xpath(root, "a:themeElements", "a:clrScheme");
      const get = (k2: string) => { const c = xels(xkid(clr, k2))[0]; const v = xat(c, "val") ?? xat(c, "lastClr"); return v && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toUpperCase()}` : undefined; };
      const acc = ["a:accent1", "a:accent2", "a:accent5", "a:dk2"].map(get).filter(Boolean) as string[];
      if (acc[0]) theme.primary = get("a:dk2") && hexHsl(get("a:dk2")!)[1] > 0.3 ? get("a:dk2") : acc[0];
      theme.accent = acc.find((c) => c !== theme.primary);
      const fs = xpath(root, "a:themeElements", "a:fontScheme");
      const mj = xat(xpath(fs, "a:majorFont", "a:latin"), "typeface"), mn = xat(xpath(fs, "a:minorFont", "a:latin"), "typeface");
      if (mj) { theme.headingFont = mj; fonts.push(mj); }
      if (mn) { theme.bodyFont = mn; fonts.push(mn); }
    }
    const stx = zip.file("word/styles.xml");
    if (stx) {
      const root = xroot(xparse(await stx.async("string")));
      const h1 = xels(root).find((e) => e.name === "w:style" && /^(Heading1|Ttulo1|Titulo1|Title)$/i.test(xat(e, "w:styleId") ?? ""));
      const col = xat(xpath(h1, "w:rPr", "w:color"), "w:val");
      if (col && /^[0-9a-f]{6}$/i.test(col)) theme.primary = `#${col.toUpperCase()}`;
      const hf = xat(xpath(h1, "w:rPr", "w:rFonts"), "w:ascii");
      if (hf) { theme.headingFont = hf; fonts.push(hf); }
    }
  } catch { /* the look is optional */ }
  const images: Blob[] = [];
  const media = Object.keys(zip.files).filter((nm) => /^word\/media\/.+\.(png|jpe?g|gif|webp)$/i.test(nm));
  for (const nm of media) { const b = await zip.file(nm).async("uint8array"); if (b.length > 9000) images.push(new Blob([b as any], { type: /png$/i.test(nm) ? "image/png" : /webp$/i.test(nm) ? "image/webp" : /gif$/i.test(nm) ? "image/gif" : "image/jpeg" })); }
  return { theme, fonts, images };
}

/** Keeps the pictures an import uses (and the photos, for the library): uploads each once and swaps the temporary URLs. */
export async function persistImported(blocks: DocBlock[], theme: Partial<DocTheme>, assets: ImportedAsset[], upload: (b: Blob, role: ImportedAsset["role"]) => Promise<string>, onProgress?: (done: number, of: number) => void): Promise<{ blocks: DocBlock[]; theme: Partial<DocTheme>; library: string[] }> {
  let json = JSON.stringify({ blocks, theme });
  const used = assets.filter((a) => json.includes(a.url) || a.role === "photo" || a.role === "logo");
  const library: string[] = [];
  let done = 0;
  for (const a of used) {
    onProgress?.(done, used.length);
    try {
      const url = await upload(a.blob, a.role);
      json = json.split(a.url).join(url);
      if (a.role !== "page") library.push(url);
    } catch { json = json.split(a.url).join(""); }
    done++;
  }
  onProgress?.(done, used.length);
  const out = JSON.parse(json);
  return { blocks: out.blocks, theme: out.theme, library };
}

export interface ImportOpts {
  /** your company's name: never mistaken for the client */
  provider?: string;
  /** custom fields as "Label: value" → {{key}} */
  fields?: { label: string; key: string }[];
  onStage?: (s: string) => void;
}
/**
 * Reads any reference document (PowerPoint, PDF, Word, text) and builds two first templates from it:
 * `blocks` (our layout with its colours, fonts and pictures) and, for PowerPoint and PDF, `faithful`
 * (every slide / page as it was, texts editable). Pictures come as temporary URLs: persistImported keeps them.
 */
export async function importReferenceDoc(file: Blob & { name?: string }, kind: DocKind, hints0: PlaceHints = {}, o: ImportOpts = {}): Promise<ImportedDoc> {
  const name = (file as any).name ?? "document";
  const buf = new Uint8Array(await file.arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const placeFor = (text: string) => {
    // a template that already has {{client}} in it: the other names in it are not the client's
    const tokenised = /\{\{\s*client/.test(text);
    const who = tokenised ? { names: [] as string[], legal: [] as string[] } : guessClientNames(text, o.provider);
    const ph = tokenised ? { clientNames: [] as string[] } : partyHints(text, { clientNames: who.names });
    const names = Array.from(new Set([...(ph.clientNames ?? []), ...who.names]));
    const w2 = { names: names.filter((x) => !who.legal.includes(x)), legal: who.legal };
    return { who: w2, hints: { ...hints0, clientNames: [...w2.legal, ...w2.names] } as PlaceHints, place: (x: string) => placeVariables(x, { who: w2, kind, fields: o.fields }) };
  };
  if (/\.pptx$/i.test(name) || (isZip && !/\.docx$/i.test(name) && (await openZip(buf)).file("ppt/presentation.xml"))) {
    o.onStage?.("Reading the slides…");
    const info = await parseDeck(buf);
    const look = await deckTheme(buf);
    const sections = info.slides.filter((sl) => !sl.hidden).map((sl) => {
      const texts = sl.texts.filter((t) => !t.table).map((t) => t.text.replace(/\s+/g, " ").trim()).filter(Boolean);
      const title = sl.title && texts.includes(sl.title) ? sl.title : texts[0] ?? sl.title;
      return { title, lines: texts.filter((t) => t !== title).map((t) => (t.length < 90 && !/[.:]$/.test(t) ? `- ${t}` : t)) };
    });
    const text = sections.map((x) => [x.title, ...x.lines].join("\n")).join("\n\n");
    const pl = placeFor(text);
    o.onStage?.("Rebuilding every slide…");
    let faithful: DocBlock[] | undefined, assets: ImportedAsset[] = [], fonts: string[] = [], logo: string | undefined, used: Partial<DocTheme> = {};
    try { const fp = await deckToPages(buf, pl.place); faithful = fp.blocks; assets = fp.assets; fonts = fp.fonts; logo = fp.logo; used = themeFromUsage(fp.usage); } catch (e) { console.warn("slide rebuild failed", e); /* our layout still works */ }
    const zip = await openZip(buf);
    const th = xroot(xparse(await zip.file(Object.keys(zip.files).find((nm) => /^ppt\/theme\/theme\d*\.xml$/.test(nm)) ?? "").async("string").catch(() => "<a/>")));
    const fsch = xpath(th, "a:themeElements", "a:fontScheme");
    const major = xat(xpath(fsch, "a:majorFont", "a:latin"), "typeface"), minor = xat(xpath(fsch, "a:minorFont", "a:latin"), "typeface");
    // what the slides really use beats the theme file (decks often keep Office's default theme and colour everything by hand)
    const theme: Partial<DocTheme> = { ...look, headingFont: major || look.headingFont, bodyFont: minor || look.bodyFont, ...Object.fromEntries(Object.entries(used).filter(([, v]) => v)), webFonts: Array.from(new Set([...fonts, major ?? "", minor ?? ""].filter(Boolean))), ...(logo ? { logoDark: logo } : {}) };
    if (!assets.length) {
      const imgs = Object.keys(zip.files).filter((nm) => /^ppt\/media\/.+\.(png|jpe?g)$/i.test(nm));
      for (const nm of imgs) { const b = await zip.file(nm).async("uint8array") as Uint8Array; if (b.length > 30000 && hasDom()) { const blob = new Blob([b as any], { type: /png$/i.test(nm) ? "image/png" : "image/jpeg" }); assets.push({ url: URL.createObjectURL(blob), blob, w: 0, h: 0, role: "photo" }); } }
    }
    const photos = assets.filter((a) => a.role === "photo").sort((a, b) => b.w * b.h - a.w * a.h);
    const blocks = assignImages(blocksFromSections(sections, kind, pl.hints), photos.map((a) => a.url));
    return { blocks, faithful, theme, images: photos.map((a) => a.blob), assets, fonts: theme.webFonts ?? [], text, pages: info.slides.length, source: "pptx" };
  }
  if (/\.docx$/i.test(name) || isZip) {
    o.onStage?.("Reading the document…");
    const { sections, images: imgs0 } = await docxText(buf);
    const look = await docxLook(buf).catch(() => ({ theme: {}, fonts: [] as string[], images: imgs0 }));
    const text = sections.map((x) => [x.title, ...x.lines].join("\n")).join("\n\n");
    const pl = placeFor(text);
    const imgs = look.images.length ? look.images : imgs0;
    const assets: ImportedAsset[] = hasDom() ? imgs.map((b) => ({ url: URL.createObjectURL(b), blob: b, w: 0, h: 0, role: "photo" as const })) : [];
    const pal = await paletteOf(imgs).catch(() => [] as string[]);
    const theme: Partial<DocTheme> = { ...(pal.length ? themeFromColours(pal, []) : {}), ...look.theme, webFonts: look.fonts };
    return { blocks: assignImages(blocksFromSections(sections, kind, pl.hints), assets.map((a) => a.url)), theme, images: imgs, assets, fonts: look.fonts, text, pages: 0, source: "docx" };
  }
  if (/\.pdf$/i.test(name) || latin(buf.subarray(0, 5)) === "%PDF-") {
    if (hasDom()) {
      try {
        let pl: ReturnType<typeof placeFor> | null = null;
        o.onStage?.("Opening the PDF…");
        const r = await pdfToPages(buf, { makePlace: (t) => { pl = placeFor(t); return pl.place; }, onPage: (pn, of) => o.onStage?.(`Reading page ${pn} of ${of}…`) });
        const p2 = pl ?? placeFor(r.text);
        o.onStage?.("Putting the values in…");
        // letters written in each font: in big type (headings) and in small type (body)
        const big = new Map<string, number>(), small = new Map<string, number>();
        const spanRe = /<span style="font-family:([^;]+);font-size:([\d.]+)px[^"]*">([^<]*)/g;
        r.blocks.forEach((b) => (b.slide?.els ?? []).forEach((e) => {
          for (const m of (e.html ?? "").matchAll(spanRe)) {
            const f = r.fonts.find((ff) => webFont(ff).stack === m[1]); if (!f) continue;
            const into = Number(m[2]) >= 26 ? big : small;
            into.set(f, (into.get(f) ?? 0) + m[3].trim().length);
          }
        }));
        const top = (mp: Map<string, number>) => Array.from(mp.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
        const headFont = top(big) ?? top(small), bodyFont = top(small) ?? headFont;
        const theme: Partial<DocTheme> = { ...themeFromColours(r.palette, r.textColours), headingFont: headFont, bodyFont, webFonts: r.fonts };
        const photos = r.assets.filter((a) => a.role === "photo").sort((a, b) => b.w * b.h - a.w * a.h);
        const blocks = assignImages(blocksFromSections(sectionsFromPdfLines(r.lines), kind, p2.hints), photos.map((a) => a.url));
        return { blocks, faithful: r.blocks, theme, images: photos.map((a) => a.blob), assets: r.assets, fonts: r.fonts, text: r.text, pages: r.pages, source: "pdf", terms: r.terms.annualIncreasePct ? { annualIncreasePct: r.terms.annualIncreasePct } : undefined };
      } catch (e) { console.warn("pdf.js import failed, reading the text only", e); }
    }
    const { lines, pages } = await pdfText(buf);
    if (lines.length < 3) throw new Error("No text could be read from this PDF (it may be scanned). Try the Word or PowerPoint version.");
    const pl = placeFor(lines.join("\n"));
    return { blocks: blocksFromSections(sectionsFromLines(lines), kind, pl.hints), theme: {}, images: [], assets: [], fonts: [], text: lines.join("\n"), pages, source: "pdf" };
  }
  let text = new TextDecoder().decode(buf);
  if (/<html|<body|<p[\s>]/i.test(text)) text = text.replace(/<(br|\/p|\/h\d|\/li|\/div)[^>]*>/gi, "\n").replace(/<h\d[^>]*>/gi, "\n# ").replace(/<li[^>]*>/gi, "\n- ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const pl = placeFor(text);
  return { blocks: blocksFromSections(sectionsFromLines(text.split(/\r?\n/)), kind, pl.hints), theme: {}, images: [], assets: [], fonts: [], text, pages: 0, source: "text" };
}

/** Field values the template uses that the deal doesn't fill (the seller types them). */
export function docFreeTokens(blocks: DocBlock[]): string[] {
  const all = new Set<string>();
  const add = (s?: string) => tokensIn(String(s ?? "")).forEach((k) => { if (!k.startsWith("?")) all.add(k); });
  blocks.forEach((b) => { add(b.eyebrow); add(b.title); add(b.body); (b.items ?? []).forEach((x) => { add(x.title); add(x.text); add(x.value); }); });
  const builtin = new Set(docBuiltinVars().map((v) => v.key));
  const known = (k: string) => k === "client.name" || isKnownToken(k) || builtin.has(k) || /^(deal|company|contact)\.cf\./.test(k) || DOC_EXTRA_TOKENS.some((t) => t.key.replace(/N/g, "") === k.replace(/\d+/g, "") || t.key === k);
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
  if (type === "slide") {
    base.title = "Free page";
    base.slide = { w: SLIDE_W, h: 720, bg: "#FFFFFF", els: [
      { id: rid(), kind: "text", x: 64, y: 56, w: 1152, h: 70, pad: [0, 0, 0, 0], html: `<p style="font-size:40px;font-weight:800;line-height:1.15">${lang === "en" ? "Title" : "Título"}</p>` },
      { id: rid(), kind: "text", x: 64, y: 150, w: 760, h: 200, pad: [0, 0, 0, 0], html: `<p style="font-size:20px;line-height:1.5">${lang === "en" ? "Write here…" : "Escribe aquí…"}</p>` },
    ] };
  }
  return { ...base, id: rid(), items: (base.items ?? []).map((x) => ({ ...x, id: rid() })) };
};
export const newDocItem = (): DocItem => it("", "");
export const cloneBlock = (b: DocBlock): DocBlock => ({ ...JSON.parse(JSON.stringify(b)), id: rid(), items: (b.items ?? []).map((x) => ({ ...x, id: rid() })) });


// ------------------------------------------------ AI template builder -----
/** One text of a document as the AI (or the rules) read it. */
export interface DocTextItem { id: string; page: number; text: string; size?: number; role?: string; blockId: string; path: string }
/** What the AI (or the rules) suggests to turn a one-off document into a template. */
export interface DocAiPlan {
  replacements: { id: string; find: string; token?: string; text?: string; reason: string }[];
  sections: { page: number; when: "always" | "product" | "service"; names?: string[]; reason: string }[];
  notes?: string; source: "ai" | "rules"; model?: string;
}
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: "\u00a0" };
const decodeEnt = (t: string) => t.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => ENT[e.toLowerCase()] ?? (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : m));
const encodeEnt = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The plain text of a bit of html (paragraphs and breaks become line breaks). */
export function htmlPlain(html: string): string {
  return decodeEnt(String(html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<\/t[dh]>/gi, " · ").replace(/<[^>]+>/g, ""))
    .replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}
/** Replaces `find` with `to` in the text of html (never inside tags). Returns null when the text isn't there. */
export function replaceInHtmlText(html: string, find: string, to: string): string | null {
  if (!find) return null;
  const parts = String(html ?? "").split(/(<[^>]*>)/);
  let hit = false;
  const norm = (x: string) => x.replace(/\u00a0/g, " ");
  for (let i = 0; i < parts.length; i += 2) {
    const t = norm(decodeEnt(parts[i]));
    if (t.includes(find)) { parts[i] = encodeEnt(t.split(find).join(to)); hit = true; }
  }
  if (hit) return parts.join("");
  // the text runs over several spans: put it in the first one and empty the rest
  const segs: { i: number; t: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) segs.push({ i, t: norm(decodeEnt(parts[i])) });
  const all = segs.map((x) => x.t).join("");
  const at = all.indexOf(find);
  if (at < 0) return null;
  let pos = 0, left = find.length, placed = false;
  for (const sg of segs) {
    const a = pos, b = pos + sg.t.length; pos = b;
    if (b <= at || left <= 0) continue;
    const from = Math.max(0, at - a), take = Math.min(sg.t.length - from, left);
    parts[sg.i] = encodeEnt(sg.t.slice(0, from) + (placed ? "" : to) + sg.t.slice(from + take));
    placed = true; left -= take;
  }
  return parts.join("");
}
/** Every text of the document, numbered (t1, t2…) for the AI; pictures and files never leave. */
export function docTextInventory(blocks: DocBlock[]): DocTextItem[] {
  const out: DocTextItem[] = [];
  const add = (b: DocBlock, page: number, path: string, raw: string, html = false, size?: number, role?: string) => {
    const text = html ? htmlPlain(raw) : String(raw ?? "").trim();
    if (!text || text.length < 2 || /^\{\{[^}]+\}\}$/.test(text)) return;
    out.push({ id: `t${out.length + 1}`, page, text: text.slice(0, 1500), size, role, blockId: b.id, path });
  };
  blocks.forEach((b, k) => {
    const page = k + 1;
    if (b.type === "slide" && b.slide) {
      b.slide.els.forEach((e, i) => {
        if ((e.kind !== "text" && e.kind !== "table" && e.kind !== "shape") || !e.html) return;
        const sizes = Array.from(e.html.matchAll(/font-size:\s*([\d.]+)px/g)).map((m) => Number(m[1]));
        const size = sizes.length ? Math.max(...sizes) : undefined;
        add(b, page, `els.${i}`, e.html, true, size, e.kind === "table" ? "table" : size && size >= 28 ? "title" : size && size <= 11 ? "small" : undefined);
      });
      return;
    }
    if (b.eyebrow) add(b, page, "eyebrow", b.eyebrow, false, undefined, "eyebrow");
    if (b.title) add(b, page, "title", b.title, false, undefined, "title");
    if (b.body) add(b, page, "body", b.body, /</.test(b.body));
    (b.items ?? []).forEach((it, j) => {
      if (it.title) add(b, page, `items.${j}.title`, it.title);
      if (it.text) add(b, page, `items.${j}.text`, it.text, /</.test(it.text));
      if (it.value) add(b, page, `items.${j}.value`, it.value);
    });
  });
  return out;
}
/** Page titles (the biggest text of each page) for the AI's overview. */
export function docPageTitles(inv: DocTextItem[], n: number): { page: number; title: string }[] {
  return Array.from({ length: n }, (_, k) => {
    const its = inv.filter((x) => x.page === k + 1);
    const t = its.find((x) => x.role === "title") ?? [...its].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    return { page: k + 1, title: (t?.text ?? "").split("\n")[0].slice(0, 120) };
  });
}
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Catalog lines whose name matches the given names (either contains the other). */
export function matchCatalog(names: string[], list: { id: string; name: string }[]): string[] {
  const out = new Set<string>();
  names.map(fold).filter((n) => n.length > 2).forEach((n) => list.forEach((c) => { const f = fold(c.name); if (f && (f === n || f.includes(n) || n.includes(f))) out.add(c.id); }));
  return Array.from(out);
}
/**
 * The rules' suggestions when the AI isn't available: values still written out (dates, e-mails, phones,
 * the client's name) and pages about one product or service of the catalog.
 */
export function rulesDocPlan(inv: DocTextItem[], o: { clientNames?: string[]; provider?: string; catalog: { products: { id: string; name: string }[]; services: { id: string; name: string }[] }; vars: string[] }): DocAiPlan {
  const has = (k: string) => o.vars.includes(k);
  const rep: DocAiPlan["replacements"] = [];
  const seen = new Set<string>();
  const push = (id: string, find: string, token: string, reason: string) => { const k = `${id}|${find}`; if (!seen.has(k) && has(token)) { seen.add(k); rep.push({ id, find, token, reason }); } };
  const MONTH = "(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december)";
  const prov = fold(o.provider ?? "");
  inv.forEach((x) => {
    const t = x.text;
    for (const m of t.matchAll(new RegExp(`\\b${MONTH}\\s+(?:de\\s+)?20\\d\\d\\b`, "gi"))) push(x.id, m[0], "date", "The offer's month — it changes with every deal");
    for (const m of t.matchAll(/\b\d{1,2}[\/.]\d{1,2}[\/.]20\d\d\b/g)) if (/v[aá]lid|hasta|until|antes|before/i.test(t)) push(x.id, m[0], "valid_until", "Validity date of the offer");
    for (const name of o.clientNames ?? []) if (name.length > 2 && t.includes(name)) push(x.id, name, "client", "The client's name");
    for (const m of t.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) if (!prov || !fold(m[0]).includes(prov.split(" ")[0])) push(x.id, m[0], "client.contact.email", "A contact's e-mail");
  });
  const secs: DocAiPlan["sections"] = [];
  const pages = Array.from(new Set(inv.map((x) => x.page)));
  pages.forEach((page) => {
    // the page's title only (its biggest text): "Konsolidator Suite", "Licencia Data Management"
    const its = inv.filter((x) => x.page === page && x.role !== "table");
    const top = its.find((x) => x.role === "title" && x.path === "title") ?? [...its].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    const head = fold((top?.text ?? "").split("\n")[0]);
    if (!head || head.length > 90) return;
    const words = ` ${head} `;
    const hit = (c: { name: string }) => { const f = fold(c.name); return f.length > 3 && words.includes(` ${f} `) && f.length * 3 >= head.length; };
    const p = o.catalog.products.filter(hit), sv = o.catalog.services.filter(hit);
    if (p.length === 1 && !sv.length) secs.push({ page, when: "product", names: [p[0].name], reason: `The page is about ${p[0].name}` });
    else if (sv.length === 1 && !p.length) secs.push({ page, when: "service", names: [sv[0].name], reason: `The page is about ${sv[0].name}` });
  });
  return { replacements: rep, sections: secs, source: "rules", notes: "Suggested by rules (dates, names, e-mails, pages named after a product or service)." };
}
/** Applies the accepted suggestions to a copy of the blocks. */
export function applyDocPlan(blocks: DocBlock[], inv: DocTextItem[], plan: DocAiPlan, accept: { rep: boolean[]; sec: boolean[] }, catalog: { products: { id: string; name: string }[]; services: { id: string; name: string }[] }): { blocks: DocBlock[]; applied: number; missed: number } {
  const out: DocBlock[] = JSON.parse(JSON.stringify(blocks));
  const byId = new Map(inv.map((x) => [x.id, x]));
  let applied = 0, missed = 0;
  plan.replacements.forEach((r, k) => {
    if (!accept.rep[k]) return;
    const it = byId.get(r.id); const b = it && out.find((x) => x.id === it.blockId);
    if (!it || !b) { missed++; return; }
    const to = r.token ? `{{${r.token}}}` : r.text ?? "";
    const seg = it.path.split(".");
    if (seg[0] === "els" && b.slide) {
      const e = b.slide.els[Number(seg[1])];
      const next = e?.html != null ? replaceInHtmlText(e.html, r.find, to) : null;
      if (next == null) { missed++; return; }
      e.html = next; applied++; return;
    }
    const host: any = seg[0] === "items" ? (b.items ?? [])[Number(seg[1])] : b;
    const f = seg[0] === "items" ? seg[2] : seg[0];
    const cur = host?.[f];
    if (typeof cur !== "string") { missed++; return; }
    const next = /</.test(cur) ? replaceInHtmlText(cur, r.find, to) : cur.includes(r.find) ? cur.split(r.find).join(to) : null;
    if (next == null) { missed++; return; }
    host[f] = next; applied++;
  });
  plan.sections.forEach((s, k) => {
    if (!accept.sec[k]) return;
    const b = out[s.page - 1];
    if (!b) { missed++; return; }
    if (s.when === "always") { delete b.when; delete b.ids; applied++; return; }
    const ids = matchCatalog(s.names ?? [], s.when === "product" ? catalog.products : catalog.services);
    if (!ids.length) { missed++; return; }
    b.when = s.when; b.ids = ids; applied++;
  });
  return { blocks: out, applied, missed };
}

/* =====================================================================
   Signed contract / order form → contract fields
   pdf.js text with positions is put back into lines and columns, then read
   with label rules (English and Spanish). Pure functions below the loader,
   so they can be tested without a browser.
   ===================================================================== */
export interface OfSeg { x: number; w: number; s: string }
export interface OfLine { page: number; y: number; segs: OfSeg[]; text: string }
export interface OrderFormLine { name: string; list: number; final: number; discountPct: number | null; qty: number; oneTime: boolean }
export interface OrderFormData {
  ref?: string;
  customer?: { legalName?: string; regNo?: string; vat?: string; address?: string; country?: string };
  supplier?: { name?: string; regNo?: string };
  contactPerson?: { name?: string; email?: string; phone?: string; role?: string };
  adminUser?: { name?: string; email?: string };
  lines?: OrderFormLine[];
  totals?: { oneTime?: number; annualList?: number; annualFinal?: number };
  currency?: string; pricesExclVat?: boolean; paymentTermsDays?: number; billingFrequency?: string;
  termsUrl?: string; newsletter?: boolean; marketingConsent?: boolean;
  contractStart?: string; nonTerminableYears?: number; autoRenew?: boolean; renewYears?: number; increasePct?: number;
  services?: { days?: number; tolerancePct?: number; billing?: "per_day" | "fixed"; roles?: { label: string; days?: number; rate: number }[]; note?: string };
  signatories?: { side: "supplier" | "customer"; name: string; role?: string; email?: string; phone?: string }[];
  signDate?: string; esignId?: string; esignProvider?: string;
  /** What was found (field keys), for the "from PDF" badges. */
  found: string[];
  /** Plain text of the document (for the AI). */
  text?: string;
}

const ofLig = (s: string) => s.replace(/[\ufb00-\ufb06]/g, (c) => c.normalize("NFKC"));
const ofClean = (s: string) => ofLig(s).replace(/[​-‍⁠﻿­]/g, "").replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

/** Text items of each page (pdf.js coordinates: y up) → lines top to bottom, split in columns where the gap is wide. */
export function ofLinesFromItems(pages: { items: { str: string; x: number; y: number; w: number; h: number }[] }[]): OfLine[] {
  const out: OfLine[] = [];
  pages.forEach((pg, pi) => {
    const its = pg.items.map((i) => ({ ...i, str: ofLig(i.str).replace(/[​-‍⁠﻿­]/g, "") })).filter((i) => i.str.trim());
    its.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: { y: number; its: typeof its }[] = [];
    for (const it of its) {
      const tol = Math.max(2, (it.h || 10) * 0.35);
      const row = rows.find((r) => Math.abs(r.y - it.y) <= tol);
      if (row) row.its.push(it); else rows.push({ y: it.y, its: [it] });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.its.sort((a, b) => a.x - b.x);
      const segs: OfSeg[] = [];
      let cur: { x: number; end: number; s: string; h: number } | null = null;
      for (const it of r.its) {
        const h = it.h || 10;
        if (cur && it.x - cur.end < Math.max(h * 1.6, 9)) {
          const gap = it.x - cur.end;
          cur.s += (gap > h * 0.12 && !/\s$/.test(cur.s) && !/^\s/.test(it.str) ? " " : "") + it.str;
          cur.end = Math.max(cur.end, it.x + it.w);
        } else {
          if (cur) segs.push({ x: cur.x, w: cur.end - cur.x, s: ofClean(cur.s) });
          cur = { x: it.x, end: it.x + it.w, s: it.str, h };
        }
      }
      if (cur) segs.push({ x: cur.x, w: cur.end - cur.x, s: ofClean(cur.s) });
      const ss = segs.filter((s) => s.s);
      if (ss.length) out.push({ page: pi + 1, y: r.y, segs: ss, text: ss.map((s) => s.s).join("   ") });
    }
  });
  return out;
}

/** Reads a PDF (bytes) into lines with columns. */
export async function pdfOrderFormLines(bytes: ArrayBuffer | Uint8Array): Promise<OfLine[]> {
  const pdfjs = await loadPdfjs();
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages: { items: { str: string; x: number; y: number; w: number; h: number }[] }[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 30); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push({ items: (tc.items as any[]).filter((i) => typeof i.str === "string").map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: i.height || Math.abs(i.transform[3]) || 10 })) });
  }
  try { await doc.destroy(); } catch { /* ignore */ }
  return pages.length ? ofLinesFromItems(pages) : [];
}

/** Reads a signed contract PDF into contract fields. */
export async function extractOrderForm(bytes: ArrayBuffer | Uint8Array): Promise<OrderFormData> {
  return parseOrderForm(await pdfOrderFormLines(bytes));
}

const OF_WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
const OF_MONTHS: Record<string, number> = { jan: 1, january: 1, enero: 1, feb: 2, february: 2, febrero: 2, mar: 3, march: 3, marzo: 3, apr: 4, april: 4, abril: 4, may: 5, mayo: 5, jun: 6, june: 6, junio: 6, jul: 7, july: 7, julio: 7, aug: 8, august: 8, agosto: 8, sep: 9, sept: 9, september: 9, septiembre: 9, setiembre: 9, oct: 10, october: 10, octubre: 10, nov: 11, november: 11, noviembre: 11, dec: 12, december: 12, diciembre: 12 };
/** "2026-08-01", "01/08/2026", "1 August 2026", "1 de agosto de 2026" → ISO date. */
export function ofDate(s: string): string | undefined {
  const t = s.trim().toLowerCase();
  let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+)?([a-zá-ú]+)\.?\s+(?:de\s+)?(\d{4})/);
  if (m && OF_MONTHS[m[2]]) return `${m[3]}-${String(OF_MONTHS[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = t.match(/([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && OF_MONTHS[m[1]]) return `${m[3]}-${String(OF_MONTHS[m[1]]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return undefined;
}
const OF_MONEY = /(?:€|EUR|USD|\$|DKK|GBP|£|SEK|NOK|CHF)?\s*-?\d{1,3}(?:[ .,' ]\d{3})*(?:[.,]\d{1,2})?\s*(?:€|EUR|USD|\$|DKK|GBP|£|SEK|NOK|CHF)/i;
/** "12 000.00 EUR", "12.000,00 €" → 12000 */
export function ofMoney(s: string): number | null {
  const m = s.match(/-?\d[\d .,' ]*/);
  if (!m) return null;
  let n = m[0].replace(/[\s' ]/g, "");
  const dec = n.match(/[.,](\d{1,2})$/);
  if (dec) n = n.slice(0, -dec[0].length).replace(/[.,]/g, "") + "." + dec[1];
  else n = n.replace(/[.,]/g, "");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}
const ofCurrency = (s: string) => { const m = s.match(/€|EUR|USD|\$|DKK|GBP|£|SEK|NOK|CHF/i); if (!m) return undefined; const c = m[0].toUpperCase(); return c === "€" ? "EUR" : c === "$" ? "USD" : c === "£" ? "GBP" : c; };
const ofYes = (s?: string) => (s == null ? undefined : /^(yes|sí|si|ja|oui|true|x)$/i.test(s.trim()) ? true : /^(no|nej|non|false)$/i.test(s.trim()) ? false : undefined);
const ofNum = (s?: string) => { if (!s) return undefined; const w = OF_WORD_NUM[s.toLowerCase()]; if (w) return w; const n = Number(s.replace(",", ".")); return Number.isFinite(n) ? n : undefined; };
const ofEmail = /[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+/;
const ofPhone = /^\+?[\d][\d\s().\-]{6,}$/;

/** Reads the lines of a signed contract / order form. */
export function parseOrderForm(lines: OfLine[]): OrderFormData {
  const out: OrderFormData = { found: [] };
  const found = (k: string) => { if (!out.found.includes(k)) out.found.push(k); };
  const full = lines.map((l) => l.text.replace(/ {3}/g, " ")).join("\n");
  const flat = full.replace(/\s+/g, " ");
  out.text = full;
  const isLabelish = (s: string) => /[:)]$|^(company|customer|payment|billing|newsletter|marketing|description|quantity|signatory|date|participants|cif|nif|vat|plazo|facturaci)/i.test(s);
  /** The value under a label (same column, the next few lines). */
  const below = (re: RegExp): { s: string; line: OfLine } | null => {
    for (let i = 0; i < lines.length; i++) {
      const seg = lines[i].segs.find((s) => re.test(s.s) && s.s.length < 70);
      if (!seg) continue;
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (lines[j].page !== lines[i].page) break;
        const v = lines[j].segs.find((s) => Math.abs(s.x - seg.x) < 30);
        if (v && !re.test(v.s)) { if (isLabelish(v.s) && !/@/.test(v.s)) break; return { s: v.s, line: lines[j] }; }
      }
    }
    return null;
  };

  // ---- reference ----
  const ref = flat.match(/contract\s*(?:no|number|nr|n[º°o])\.?\s*[:#]?\s*([A-Z0-9][\w\-\/]{3,})/i)
    ?? flat.match(/(?:n[º°o]\.?|número)\s*(?:de\s*)?contrato\s*[:#]?\s*([A-Z0-9][\w\-\/]{3,})/i)
    ?? flat.match(/order\s*form\s*(?:no|number|nr)\.?\s*[:#]?\s*([A-Z0-9][\w\-\/]{3,})/i);
  if (ref) { out.ref = ref[1]; found("ref"); }

  // ---- parties ----
  const pIdx = lines.findIndex((l) => l.segs.some((s) => /^(parties|partes|las partes)$/i.test(s.s)));
  const cIdx = lines.findIndex((l, i) => i > pIdx && /\((?:the|el)\s*["“”']?\s*(?:customer|cliente)/i.test(l.text));
  if (pIdx >= 0 && cIdx > pIdx) {
    const custSeg = lines[cIdx].segs.find((s) => /(?:customer|cliente)/i.test(s.s))!;
    const cx = custSeg.x;
    const block: string[] = [];
    const supp: string[] = [];
    for (let i = pIdx + 1; i < cIdx; i++) {
      for (const s of lines[i].segs) {
        if (Math.abs(s.x - cx) < 70) block.push(s.s);
        else if (s.x > cx + 70) supp.push(s.s);
      }
    }
    const clean = block.map((s) => s.replace(/\((?:the|el)\s*["“”']?.*$/i, "").trim()).filter(Boolean);
    if (clean.length) {
      const c: NonNullable<OrderFormData["customer"]> = {};
      c.legalName = clean[0];
      const rest = clean.slice(1);
      if (rest.length && !/\d/.test(rest[rest.length - 1]) && rest[rest.length - 1].split(" ").length <= 3) c.country = rest.pop();
      if (rest.length) c.address = rest.join(", ");
      out.customer = c;
      found("customer.legalName"); if (c.address) found("customer.address"); if (c.country) found("customer.country");
    }
    const sname = supp.find((s) => !/reg\.?\s*no|^\(|^\d/i.test(s));
    const sreg = supp.join(" ").match(/reg\.?\s*(?:\/\s*org\.?\s*)?no\.?\s*([\d ]{6,})/i);
    if (sname || sreg) out.supplier = { name: sname, regNo: sreg?.[1].trim() };
  }
  // ---- customer ids ----
  const reg = below(/^company\s+reg\.?\s*(?:\/\s*org\.?)?\s*no\.?$|^(?:n[º°o]\.?\s*de\s*registro|registro mercantil)$/i);
  if (reg && reg.s.toLowerCase() !== (out.customer?.legalName ?? "").toLowerCase() && /\d/.test(reg.s)) { out.customer = { ...(out.customer ?? {}), regNo: reg.s }; found("customer.regNo"); }
  const vat = below(/(?:vat|tax)\s*\/?\s*(?:tax\s*)?(?:no|number|id)\.?$|^(?:cif|nif|nif\/cif|cif\/nif|n\.?i\.?f\.?)$/i);
  if (vat && /\d/.test(vat.s)) { out.customer = { ...(out.customer ?? {}), vat: vat.s.replace(/\s+/g, "") }; found("customer.vat"); }

  // ---- people ----
  const cpN = below(/^(?:customer\s+)?contact\s+person(?:\s*\(name\))?$|^persona de contacto/i);
  if (cpN) { out.contactPerson = { name: cpN.s }; found("contactPerson"); }
  const adN = below(/admin\w*\s+user.*\(name\)|usuario\s+administrador.*nombre/i);
  const adE = below(/admin\w*\s+user.*e-?mail|usuario\s+administrador.*(?:correo|e-?mail)/i);
  if (adN || adE) { out.adminUser = { name: adN?.s, email: adE?.s.match(ofEmail)?.[0] }; found("adminUser"); }

  // ---- scope lines ----
  const hIdx = lines.findIndex((l) => l.segs.some((s) => /^(description|descripción|concepto)$/i.test(s.s)) && l.segs.some((s) => /annual|anual|yearly|monthly|mensual|quantity|cantidad/i.test(s.s)));
  if (hIdx >= 0) {
    const h = lines[hIdx];
    const center = (s: OfSeg) => s.x + s.w / 2;
    const col = (re: RegExp) => { const s = h.segs.find((x) => re.test(x.s)); return s ? center(s) : null; };
    const xDesc = h.segs.find((s) => /^(description|descripción|concepto)$/i.test(s.s))!.x;
    const xOne = col(/one-?\s*time|único|setup|alta/i), xAnn = col(/annual|anual|yearly|monthly|mensual|recurr/i), xQty = col(/quantity|cantidad|qty|uds/i);
    const items: OrderFormLine[] = [];
    let cur: OrderFormLine | null = null; let gotFinal = false;
    for (let i = hIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.segs.some((s) => /^(one-?\s*time fee|annually|total|subtotal)\s*:/i.test(s.s)) || /^(subscription fees|terms|payment)/i.test(l.segs[0].s)) {
        // totals line(s)
        for (let j = i; j < Math.min(lines.length, i + 3); j++) {
          const t = lines[j].text;
          const am = (t.match(new RegExp(OF_MONEY.source, "gi")) ?? []).map((x) => ofMoney(x)).filter((v): v is number => v != null);
          if (/one-?\s*time fee\s*:/i.test(t) && am.length) out.totals = { ...(out.totals ?? {}), oneTime: am[0] };
          if (/(?:annually|anual(?:mente)?)\s*:/i.test(t) && am.length) out.totals = { ...(out.totals ?? {}), annualList: am[0], annualFinal: am[am.length - 1] };
        }
        break;
      }
      const desc = l.segs.find((s) => Math.abs(s.x - xDesc) < 24 && !OF_MONEY.test(s.s) && !/^discount|^descuento/i.test(s.s) && /[a-z]/i.test(s.s));
      const money = l.segs.filter((s) => OF_MONEY.test(s.s));
      const disc = l.text.match(/(?:discount|descuento|dto\.?)\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/i);
      if (desc) {
        if (cur) items.push(cur);
        cur = { name: desc.s.replace(/^(subscription|suscripci[oó]n)\s*:\s*/i, "").trim(), list: 0, final: 0, discountPct: null, qty: 1, oneTime: false };
        gotFinal = false;
        const am = money[0];
        if (am) {
          cur.list = ofMoney(am.s) ?? 0; cur.final = cur.list;
          if (xOne != null && xAnn != null) cur.oneTime = Math.abs(center(am) - xOne) < Math.abs(center(am) - xAnn);
          if (!out.currency) out.currency = ofCurrency(am.s);
        }
        const q = l.segs.find((s) => /^\d{1,6}$/.test(s.s) && (xQty == null || Math.abs(center(s) - xQty) < 60));
        if (q) cur.qty = Number(q.s);
      } else if (cur) {
        if (money.length && !gotFinal) { cur.final = ofMoney(money[0].s) ?? cur.final; gotFinal = true; }
        if (disc) cur.discountPct = Number(disc[1].replace(",", "."));
      }
    }
    if (cur) items.push(cur);
    if (items.length) { out.lines = items; found("lines"); }
  }
  if (!out.currency) { const m = flat.match(OF_MONEY); if (m) out.currency = ofCurrency(m[0]); }
  if (out.currency) found("currency");
  if (/excluding\s+vat|excl\.?\s*vat|ex\.?\s*vat|sin\s+iva|iva\s+no\s+incluido|impuestos\s+no\s+incluidos|plus\s+vat/i.test(flat)) { out.pricesExclVat = true; found("pricesExclVat"); }

  // ---- billing & terms ----
  const pay = below(/^payment\s+terms?$|^(?:plazo|condiciones|forma)\s+de\s+pago$/i)?.s ?? flat.match(/net\s*(\d{1,3})\s*days?/i)?.[0] ?? flat.match(/(\d{1,3})\s*d[ií]as\s*(?:fecha\s*(?:de\s*)?factura|desde)/i)?.[0];
  const payN = pay?.match(/(\d{1,3})/);
  if (payN) { out.paymentTermsDays = Number(payN[1]); found("paymentTermsDays"); }
  const bill = below(/^billing(?:\s+frequency)?$|^facturaci[oó]n$|^periodicidad(?:\s+de\s+facturaci[oó]n)?$/i)?.s;
  if (bill) {
    const b = /annual|anual|yearly|año/i.test(bill) ? "annually" : /quarter|trimes/i.test(bill) ? "quarterly" : /month|mensual|mes/i.test(bill) ? "monthly" : /upfront|advance|anticipad/i.test(bill) ? "upfront" : null;
    if (b) { out.billingFrequency = b; found("billingFrequency"); }
  }
  const urls = flat.match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
  const url = (urls.find((u) => /legal|terms|condic|conditions/i.test(u)) ?? urls[0])?.replace(/[.,;⁠]+$/, "");
  if (url) { out.termsUrl = url; found("termsUrl"); }
  const nl = ofYes(below(/^newsletter$|^bolet[ií]n/i)?.s);
  if (nl != null) { out.newsletter = nl; found("newsletter"); }
  const mk = ofYes(below(/^marketing$|^(?:uso\s+de\s+)?(?:logo|marca)$/i)?.s);
  if (mk != null) { out.marketingConsent = mk; found("marketingConsent"); }

  // ---- term ----
  const st = flat.match(/(?:subscription\s+)?start\s*date\s*[:\-]?\s*([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|[0-9]{1,2}[\/.\-][0-9]{1,2}[\/.\-][0-9]{2,4}|[0-9]{1,2}\s+\w+\s+[0-9]{4})/i)
    ?? flat.match(/fecha\s+de\s+(?:inicio|comienzo)(?:\s+de\s+la\s+suscripci[oó]n)?\s*[:\-]?\s*([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|[0-9]{1,2}[\/.\-][0-9]{1,2}[\/.\-][0-9]{2,4}|[0-9]{1,2}\s+de\s+\w+\s+de\s+[0-9]{4})/i);
  const sd = st ? ofDate(st[1]) : undefined;
  if (sd) { out.contractStart = sd; found("contractStart"); }
  const nt = flat.match(/non[-\s]?terminable\s+for\s+(?:([a-z]+)\s*)?\(?(\d+)?\)?\s*years?/i);
  const ntN = nt ? (nt[2] ? Number(nt[2]) : ofNum(nt[1])) : undefined;
  const ntEs = flat.match(/(?:permanencia|per[ií]odo\s+no\s+rescindible|no\s+rescindible)[^.]{0,60}?(\d+|[a-z]+)\s*\(?\d*\)?\s*años/i);
  const nonTerm = ntN ?? (ntEs ? ofNum(ntEs[1]) : undefined);
  if (nonTerm) { out.nonTerminableYears = nonTerm; found("nonTerminableYears"); }
  const rn = flat.match(/renewal[^.]{0,80}?automatic[^.]{0,30}?(?:for\s+)?(\d+|[a-z]+)\s*\(?\d*\)?\s*years?/i)
    ?? flat.match(/automatic(?:ally)?\s+renew\w*[^.]{0,40}?(\d+|[a-z]+)\s*years?/i)
    ?? flat.match(/renovaci[oó]n\s+autom[aá]tica[^.]{0,50}?(\d+|[a-z]+)\s*años/i);
  if (rn) { out.autoRenew = true; out.renewYears = ofNum(rn[1]); found("autoRenew"); }
  else if (/automatic(?:ally)?\s+renew|renew\w*\s+automatic|renovaci[oó]n\s+autom[aá]tica|se\s+renovar[aá]\s+autom/i.test(flat)) { out.autoRenew = true; found("autoRenew"); }
  const inc = flat.match(/annual\s+increase\s*(?:of\s*)?(\d+(?:[.,]\d+)?)\s*%/i) ?? flat.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:annual|yearly|per\s+year)\s+increase/i)
    ?? flat.match(/incremento\s+anual(?:\s+del?)?\s*(\d+(?:[.,]\d+)?)\s*%/i) ?? flat.match(/(?:subida|incremento|actualizaci[oó]n)\s+(?:anual\s+)?del?\s*(\d+(?:[.,]\d+)?)\s*%\s*(?:anual)?/i);
  if (inc) { out.increasePct = Number(inc[1].replace(",", ".")); found("increasePct"); }

  // ---- consulting ----
  const para = (flat.match(/[^.]*\bconsult\w*[^]*?(?=\b(?:Best regards|Saludos|Atentamente|Participants|Participantes)\b|$)/i)?.[0] ?? "").slice(0, 1600);
  if (para) {
    const sv: NonNullable<OrderFormData["services"]> = {};
    const dm = para.match(/(\d+)\s*(?:project\s*)?(?:days?|d[ií]as|jornadas)\s*\(\s*\+\s*\/\s*-\s*(\d+)\s*%\s*\)/i) ?? para.match(/(\d+)\s*(?:project\s*)?(?:days?|d[ií]as|jornadas)/i);
    if (dm) { sv.days = Number(dm[1]); if (dm[2]) sv.tolerancePct = Number(dm[2]); }
    const tol = para.match(/\+\s*\/\s*-\s*(\d+)\s*%|±\s*(\d+)\s*%/);
    if (sv.tolerancePct == null && tol) sv.tolerancePct = Number(tol[1] ?? tol[2]);
    const roles: { label: string; days?: number; rate: number }[] = [];
    const rateRe = /(\d[\d.,]*)\s*(?:EUR|€)\s*\/\s*(?:day|d[ií]a|jornada)/gi;
    let m: RegExpExecArray | null;
    while ((m = rateRe.exec(para))) {
      const before = para.slice(Math.max(0, m.index - 90), m.index);
      const pm = before.match(/(\d+|[a-z]+)\s+project\s+manager\s+days?|(\d+|[a-z]+)\s+d[ií]as?\s+de\s+(?:jefe|project\s+manager)/i);
      const isPm = /project\s+manager|jefe\s+de\s+proyecto/i.test(before);
      roles.push({ label: isPm ? "Project manager" : "Consultant", rate: ofMoney(m[1]) ?? 0, days: isPm ? ofNum(pm?.[1] ?? pm?.[2]) : sv.days });
    }
    if (roles.length) sv.roles = roles;
    if (/per\s+day\s+performed|billed[^.]{0,30}per\s+day|por\s+d[ií]a|por\s+jornada/i.test(para)) sv.billing = "per_day";
    else if (/fixed\s+fee|precio\s+cerrado|tarifa\s+fija/i.test(para)) sv.billing = "fixed";
    const note = para.match(/[^.]*\b(?:scope|alcance)\b[^.]*\./i)?.[0]?.trim();
    if (note) sv.note = note;
    if (Object.keys(sv).length) { out.services = sv; found("services"); }
  }

  // ---- signatures ----
  const ms = flat.match(/marked\s+as\s+signed\s+(\d{4}-\d{2}-\d{2})/i) ?? flat.match(/(?:manually\s+)?signed\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})/i) ?? flat.match(/firmado\s+(?:el\s+)?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  const sdt = ms ? ofDate(ms[1]) : undefined;
  if (sdt) { out.signDate = sdt; found("signDate"); }
  const es = flat.match(/one\s*flow\s*id\s*[:#]?\s*(\d+)/i);
  if (es) { out.esignId = es[1]; out.esignProvider = "Oneflow"; found("esignId"); }
  else {
    const ds = flat.match(/docusign\s+envelope\s+id\s*[:#]?\s*([\w\-]+)/i) ?? flat.match(/signaturit[^\n]{0,30}?id\s*[:#]?\s*([\w\-]+)/i) ?? flat.match(/adobe\s+sign[^\n]{0,30}?(?:id|transaction)\s*[:#]?\s*([\w\-]+)/i);
    if (ds) { out.esignId = ds[1]; out.esignProvider = /docusign/i.test(ds[0]) ? "DocuSign" : /signaturit/i.test(ds[0]) ? "Signaturit" : "Adobe Sign"; found("esignId"); }
  }
  const partIdx = lines.findIndex((l) => l.segs.some((s) => /^(participants|participantes|firmantes|signatories|signatures|firmas)$/i.test(s.s)));
  if (partIdx >= 0) {
    const supplierRe = new RegExp((out.supplier?.name ?? "konsolidator").split(/\s+/)[0].replace(/[^\w]/g, "") || "konsolidator", "i");
    let side: "supplier" | "customer" = "customer";
    /** A party heading: "KONSOLIDATOR A/S 36078383 Denmark" (upper case up to the first number). */
    const isParty = (l: OfLine) => {
      if (l.segs.length > 2) return false;
      const head = l.segs[0].s.split(/\s\d|\s[A-Z]\d/)[0];
      const letters = head.replace(/[^A-Za-zÀ-ÿ]/g, "");
      return letters.length > 5 && letters === letters.toUpperCase() && !/^(MANUALLY|SIGNATORY|DATE|CFO|CEO|COO|CTO)\b/.test(head);
    };
    const sigs: NonNullable<OrderFormData["signatories"]> = [];
    for (let i = partIdx + 1; i < lines.length; i++) {
      const l = lines[i]; const t = l.segs[0].s;
      if (/marked as signed|page \d+\s*\/\s*\d+/i.test(l.text)) continue;
      if (isParty(l)) {
        side = supplierRe.test(t) ? "supplier" : "customer";
        if (side === "customer") {
          const hv = t.match(/\b([A-Z]\d{7}[A-Z0-9]|[A-Z]{2}\d{8,12}|\d{8}[A-Z])\b/);
          if (hv && !out.customer?.vat) { out.customer = { ...(out.customer ?? {}), vat: hv[1] }; found("customer.vat"); }
        }
        continue;
      }
      if (l.segs.some((s) => /^(signatory|firmante)$/i.test(s.s))) {
        const sx = l.segs.find((s) => /^(signatory|firmante)$/i.test(s.s))!.x;
        const p: { side: "supplier" | "customer"; name: string; role?: string; email?: string; phone?: string } = { side, name: "" };
        for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
          const lj = lines[j];
          if (lj.segs.some((s) => /^(signatory|firmante)$|manually signed|^signed$/i.test(s.s)) || isParty(lj)) break;
          const v = lj.segs.find((s) => Math.abs(s.x - sx) < 40);
          if (!v || /delivery channel|canal de entrega/i.test(v.s) || /marked as signed|page \d/i.test(lj.text)) { if (!v) continue; else break; }
          const vl = v.s.replace(/[A-Za-zÀ-ÿ]/g, "");
          if (ofEmail.test(v.s)) p.email = v.s.match(ofEmail)![0];
          else if (ofPhone.test(v.s) && vl.replace(/\D/g, "").length >= 7) p.phone = v.s;
          else if (!p.name) p.name = v.s;
          else if (!p.role) p.role = v.s;
        }
        if (p.name) sigs.push(p);
      }
    }
    if (sigs.length) { out.signatories = sigs; found("signatories"); }
  }
  // the contact person's details from the signatories / admin user
  if (out.contactPerson?.name) {
    const same = (n?: string) => !!n && n.trim().toLowerCase() === out.contactPerson!.name!.trim().toLowerCase();
    const sg = out.signatories?.find((s) => same(s.name));
    if (sg) out.contactPerson = { ...out.contactPerson, email: sg.email, phone: sg.phone, role: sg.role };
    else if (same(out.adminUser?.name)) out.contactPerson = { ...out.contactPerson, email: out.adminUser?.email };
  }
  return out;
}
