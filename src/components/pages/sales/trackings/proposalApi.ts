/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../../api/supabase";
import type { ProposalTemplate, ProposalData, DocTemplate, DocKind, DocTheme, DocVarDef, DocInstance, DocBlock, DocAiPlan, DocTextItem, DocLang, OrderFormData } from "./proposalGen";
import { buildProposalDeck, buildOrderFormPdf, DEFAULT_DOC_THEME, docTextInventory, docPageTitles, rulesDocPlan, docVarCatalog, extractOrderForm } from "./proposalGen";
import { logoCandidates } from "../../clients/clientsTypes";

/** The tenant's default proposal template (RLS scopes it to the caller's tenant). */
export async function loadProposalTemplate(): Promise<ProposalTemplate | null> {
  const { data } = await supabase.from("proposal_templates").select("*").eq("is_default", true).limit(1).maybeSingle();
  if (!data) return null;
  return { brand: data.brand ?? {}, sections: data.sections ?? [], terms: data.terms ?? {} } as ProposalTemplate;
}

export interface ProposalTemplateRow { id: string | null; name: string; brand: any; sections: any[]; terms: any }

/** The tenant's default template row, with its id (for the Settings editor). */
export async function loadProposalTemplateRow(): Promise<ProposalTemplateRow | null> {
  const { data, error } = await supabase.from("proposal_templates").select("*").eq("is_default", true).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: data.id, name: data.name ?? "Default", brand: data.brand ?? {}, sections: data.sections ?? [], terms: data.terms ?? {} };
}

/** Saves (or creates) the default template. Throws on failure; returns the row id. */
export async function saveProposalTemplate(id: string | null, patch: Partial<{ name: string; brand: any; sections: any; terms: any }>): Promise<string> {
  if (id) {
    const { error } = await supabase.from("proposal_templates").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
    return id;
  }
  const { data, error } = await supabase.from("proposal_templates").insert({ ...patch, is_default: true }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

/* ---------- Templates of a product or a service ---------- */
export type ProposalOwnerType = "product" | "service";

/** The template a product / service has of its own (null when it uses the default one). */
export async function loadProposalTemplateRowFor(ownerType: ProposalOwnerType, ownerId: string): Promise<ProposalTemplateRow | null> {
  const { data, error } = await supabase.from("proposal_templates").select("*").eq("owner_type", ownerType).eq("owner_id", ownerId).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: data.id, name: data.name ?? "Template", brand: data.brand ?? {}, sections: data.sections ?? [], terms: data.terms ?? {} };
}

/** Saves (or creates) the template of a product / service. Returns the row id. */
export async function saveProposalTemplateFor(ownerType: ProposalOwnerType, ownerId: string, id: string | null, patch: Partial<{ name: string; brand: any; sections: any; terms: any }>): Promise<string> {
  if (id) {
    const { error } = await supabase.from("proposal_templates").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
    return id;
  }
  const { data, error } = await supabase.from("proposal_templates").insert({ ...patch, is_default: false, owner_type: ownerType, owner_id: ownerId }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

/** Removes a product / service template (it goes back to the default one). */
export async function deleteProposalTemplate(id: string): Promise<void> {
  const { error } = await supabase.from("proposal_templates").delete().eq("id", id);
  if (error) throw error;
}

/** Which products / services have a template of their own: "product:<id>" / "service:<id>" → template id. */
export async function listOwnedTemplates(): Promise<Map<string, string>> {
  const { data } = await supabase.from("proposal_templates").select("id, owner_type, owner_id").not("owner_type", "is", null);
  return new Map((data ?? []).map((r: any) => [`${r.owner_type}:${r.owner_id}`, r.id as string]));
}

/** The template to use for a product / service: its own, else the default one. */
export async function loadProposalTemplateFor(ownerType: ProposalOwnerType | null, ownerId: string | null): Promise<{ id: string | null; template: ProposalTemplate } | null> {
  if (ownerType && ownerId) {
    const own = await loadProposalTemplateRowFor(ownerType, ownerId).catch(() => null);
    if (own) return { id: own.id, template: { brand: own.brand, sections: own.sections, terms: own.terms } as ProposalTemplate };
  }
  const def = await loadProposalTemplateRow().catch(() => null);
  return def ? { id: def.id, template: { brand: def.brand, sections: def.sections, terms: def.terms } as ProposalTemplate } : null;
}

/**
 * Uploads a brand image to the public `brand` bucket under the tenant's folder
 * and returns its public URL. If Storage refuses (e.g. no upload policy yet),
 * falls back to an inline "image/…;base64,…" value, which the generators also
 * accept — flagged with `inline: true` so the UI can say so.
 */
export async function uploadBrandAsset(file: File, key: string): Promise<{ value: string; inline: boolean }> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  const { data: prof } = uid ? await supabase.from("profiles").select("tenant_id").eq("id", uid).maybeSingle() : { data: null };
  const folder = (prof as any)?.tenant_id ?? "shared";
  const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const path = `${folder}/${key}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("brand").upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (!error) return { value: supabase.storage.from("brand").getPublicUrl(path).data.publicUrl, inline: false };
  if (file.size > 1.5 * 1024 * 1024) throw new Error("Upload failed and the image is too large to store inline (max 1.5 MB).");
  const b64: string = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
  return { value: b64.replace(/^data:/, ""), inline: true };
}

/** Brand assets may be stored as http(s) URLs (e.g. Supabase Storage) — turn them into
 *  the "image/png;base64,…" form the generators need. Already-inline values pass through. */
export async function resolveBrandAssets(t: ProposalTemplate): Promise<ProposalTemplate> {
  const assets = { ...(t.brand.assets ?? {}) } as Record<string, string | undefined>;
  await Promise.all(Object.keys(assets).map(async (k) => {
    const v = assets[k];
    if (!v || !/^https?:\/\//i.test(v)) return;
    try {
      const blob = await (await fetch(v)).blob();
      const b64: string = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });
      assets[k] = b64.replace(/^data:/, ""); // "image/png;base64,…"
    } catch { assets[k] = undefined; }
  }));
  // The generators read PNG / JPEG only: anything else (SVG, WebP, GIF…) is drawn to a PNG first.
  await Promise.all(Object.keys(assets).map(async (k) => {
    const v = assets[k];
    if (!v || /^image\/(png|jpe?g);base64,/i.test(v)) return;
    assets[k] = (await toPng(`data:${v.replace(/^data:/, "")}`).catch(() => null)) ?? undefined;
  }));
  return { ...t, brand: { ...t.brand, assets: assets as any } };
}

/** Any image data URL → "image/png;base64,…" (browser only). */
async function toPng(src: string): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error("image")); img.src = src; });
  const w = img.naturalWidth || 600, h = img.naturalHeight || 200;
  const scale = Math.min(1, 1600 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/png").replace(/^data:/, "");
}

const safeName = (s: string) => s.replace(/[^\w\-]+/g, "_").slice(0, 60);

/** Colours as the generators want them ("0A6F4D": no "#", 6 digits) and fonts / colours always present. */
const DEFAULT_COLORS = { primary: "0A6F4D", accent: "12B57F", mint: "86EFC0", ink: "0B241A", muted: "5A7D6D", light: "F4F9F6" };
const hex6 = (v: unknown, fb: string) => {
  let h = String(v ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/i.test(h) ? h.toUpperCase() : fb;
};
export function normalizeTemplate(t: ProposalTemplate): ProposalTemplate {
  const b: any = t.brand ?? {};
  const c: any = b.colors ?? {};
  const colors = Object.fromEntries(Object.entries(DEFAULT_COLORS).map(([k, fb]) => [k, hex6(c[k], fb)])) as typeof DEFAULT_COLORS;
  return {
    ...t,
    sections: Array.isArray(t.sections) ? t.sections : [],
    terms: t.terms ?? {},
    brand: { ...b, company: String(b.company ?? "").trim() || "Proposal", colors, fonts: { heading: b.fonts?.heading || "Arial", body: b.fonts?.body || "Arial" } },
  };
}

/** Builds a proposal file without downloading it (to keep it in the deal's files). */
export async function renderProposal(kind: "pptx" | "pdf", data: ProposalData, template: ProposalTemplate, label?: string): Promise<{ blob: Blob; fileName: string }> {
  const t = await resolveBrandAssets(normalizeTemplate(template));
  const base = `${safeName(t.brand.company)}-Propuesta-${safeName(data.client.name)}${label ? `-${safeName(label)}` : ""}`;
  if (kind === "pptx") {
    const mod: any = await import("pptxgenjs");
    const pptxgen = mod.default ?? mod;
    const pres = await buildProposalDeck(pptxgen, data, t);
    const blob = (await pres.write({ outputType: "blob" })) as Blob;
    return { blob, fileName: `${base}.pptx` };
  }
  const { jsPDF } = await import("jspdf");
  const doc = buildOrderFormPdf(jsPDF, data, t);
  return { blob: doc.output("blob") as Blob, fileName: `${base}-OrderForm.pdf` };
}

/** Saves a file to the user's computer. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Generate and download a proposal in the requested format. */
export async function generateProposal(kind: "pptx" | "pdf", data: ProposalData, template: ProposalTemplate) {
  const { blob, fileName } = await renderProposal(kind, data, template);
  downloadBlob(blob, fileName);
}
/* ---------- Proposal decks: the company's own PowerPoint (13_proposal_decks.sql) ---------- */
/** When a slide of the deck goes in: always, with a product / service (ids empty = any), or never. */
export interface DeckSlideRule { n: number; when: "always" | "product" | "service" | "off"; ids: string[] }
export interface ProposalDeckRow {
  id: string; name: string; storage_path: string; file_name: string | null; size_bytes: number | null;
  slides: DeckSlideRule[]; is_default: boolean; updated_at: string;
}
const DECK_BUCKET = "tracking-files";

/** Every deck of the company (default first). null = the table is missing (SQL 13 not run). */
export async function listProposalDecks(): Promise<ProposalDeckRow[] | null> {
  // only PowerPoint decks: the same table also keeps the HTML templates (28_proposal_html.sql)
  let { data, error } = await supabase.from("proposal_decks").select("*").or("format.is.null,format.eq.pptx").order("is_default", { ascending: false }).order("created_at");
  if (error && /format/i.test(error.message)) ({ data, error } = await supabase.from("proposal_decks").select("*").order("is_default", { ascending: false }).order("created_at"));
  if (error) return /relation|does not exist|schema cache/i.test(error.message) ? null : [];
  return (data ?? []).filter((r: any) => !r.format || r.format === "pptx").map((r: any) => ({ ...r, slides: Array.isArray(r.slides) ? r.slides : [] })) as ProposalDeckRow[];
}

/** Uploads a .pptx and creates its deck row (the first one becomes the default). */
export async function uploadProposalDeck(file: File, slides: DeckSlideRule[], name?: string): Promise<{ deck: ProposalDeckRow | null; error: string | null }> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  const { data: prof } = uid ? await supabase.from("profiles").select("tenant_id").eq("id", uid).maybeSingle() : { data: null };
  const tenant = (prof as any)?.tenant_id;
  if (!tenant) return { deck: null, error: "Could not read your company." };
  const safe = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `${tenant}/_decks/${crypto.randomUUID()}_${safe}`;
  const up = await supabase.storage.from(DECK_BUCKET).upload(path, file, { contentType: file.type || "application/vnd.openxmlformats-officedocument.presentationml.presentation", upsert: false });
  if (up.error) return { deck: null, error: up.error.message };
  const existing = await listProposalDecks();
  const { data, error } = await supabase.from("proposal_decks").insert({
    name: name || file.name.replace(/\.pptx$/i, ""), storage_path: path, file_name: file.name, size_bytes: file.size,
    slides, is_default: !(existing ?? []).length,
  }).select("*").single();
  if (error) { await supabase.storage.from(DECK_BUCKET).remove([path]); return { deck: null, error: error.message }; }
  return { deck: { ...(data as any), slides: (data as any).slides ?? [] }, error: null };
}

/** Replaces the file of a deck (keeps its rules for the slides that still exist). */
export async function replaceProposalDeckFile(deck: ProposalDeckRow, file: File, slides: DeckSlideRule[]): Promise<string | null> {
  const folder = deck.storage_path.split("/").slice(0, -1).join("/");
  const path = `${folder}/${crypto.randomUUID()}_${file.name.replace(/[^\w.\-]+/g, "_")}`;
  const up = await supabase.storage.from(DECK_BUCKET).upload(path, file, { upsert: false });
  if (up.error) return up.error.message;
  const { error } = await supabase.from("proposal_decks").update({ storage_path: path, file_name: file.name, size_bytes: file.size, slides, updated_at: new Date().toISOString() }).eq("id", deck.id);
  if (error) { await supabase.storage.from(DECK_BUCKET).remove([path]); return error.message; }
  await supabase.storage.from(DECK_BUCKET).remove([deck.storage_path]);
  deckCache.delete(deck.storage_path);
  return null;
}

export async function saveProposalDeck(id: string, patch: Partial<Pick<ProposalDeckRow, "name" | "slides" | "is_default">>): Promise<string | null> {
  if (patch.is_default) {
    const r = await supabase.from("proposal_decks").update({ is_default: false }).neq("id", id).or("format.is.null,format.eq.pptx");
    if (r.error && /format/i.test(r.error.message)) await supabase.from("proposal_decks").update({ is_default: false }).neq("id", id);
  }
  const { error } = await supabase.from("proposal_decks").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  return error?.message ?? null;
}

export async function deleteProposalDeck(deck: ProposalDeckRow): Promise<string | null> {
  const { error } = await supabase.from("proposal_decks").delete().eq("id", deck.id);
  if (error) return error.message;
  await supabase.storage.from(DECK_BUCKET).remove([deck.storage_path]);
  deckCache.delete(deck.storage_path);
  return null;
}

/** The .pptx bytes of a deck (kept in memory for the session). */
const deckCache = new Map<string, Promise<ArrayBuffer>>();
export function loadProposalDeckFile(deck: Pick<ProposalDeckRow, "storage_path">): Promise<ArrayBuffer> {
  let p = deckCache.get(deck.storage_path);
  if (!p) {
    p = (async () => {
      const { data, error } = await supabase.storage.from(DECK_BUCKET).download(deck.storage_path);
      if (error || !data) throw new Error(error?.message ?? "Could not download the deck.");
      return await data.arrayBuffer();
    })();
    p.catch(() => deckCache.delete(deck.storage_path));
    deckCache.set(deck.storage_path, p);
  }
  return p;
}

/** Which slides go in for a proposal with these products / services (catalogue ids), in deck order.
 *  Consecutive slides with the same rule form a block; a block for "any product / service" repeats once per
 *  product / service (e.g. cover + pricing slides per service); one for given ids, once per match.
 *  Returns [slide n, scope] pairs — scope is the index in the proposal's products / services. */
export function deckSlidesFor(rules: DeckSlideRule[], productIds: string[], serviceIds: string[]): { n: number; scope: { product?: number; service?: number } }[] {
  const out: { n: number; scope: { product?: number; service?: number } }[] = [];
  const sorted = [...rules].sort((a, b) => a.n - b.n);
  const same = (a: DeckSlideRule, b: DeckSlideRule) => a.when === b.when && [...a.ids].sort().join() === [...b.ids].sort().join();
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && same(sorted[i], sorted[j])) j++;
    const block = sorted.slice(i, j), r = sorted[i];
    if (r.when === "always") block.forEach((x) => out.push({ n: x.n, scope: {} }));
    else if (r.when !== "off") {
      const list = r.when === "product" ? productIds : serviceIds;
      list.forEach((id, k) => {
        if (r.ids.length && !r.ids.includes(id)) return;
        block.forEach((x) => out.push({ n: x.n, scope: r.when === "product" ? { product: k } : { service: k } }));
      });
    }
    i = j;
  }
  return out;
}

/** First guess at the rules of a freshly uploaded deck: product / service tokens decide, the rest goes always. */
export function guessDeckRules(slides: { n: number; tokens: string[] }[]): DeckSlideRule[] {
  return slides.map((s) => ({
    n: s.n, ids: [],
    when: s.tokens.some((t) => t.startsWith("service")) ? "service" : s.tokens.some((t) => t.startsWith("product")) ? "product" : "always",
  }));
}

/* ---------- HTML documents: proposal and contract templates (28_proposal_html.sql) ---------- */
export interface DocTemplateRow extends DocTemplate { id: string; updated_at?: string }
const docFrom = (r: any): DocTemplateRow => {
  const d = r.doc && typeof r.doc === "object" ? r.doc : {};
  return {
    id: r.id, name: r.name ?? "Template", kind: r.kind === "contract" ? "contract" : "proposal", lang: d.lang === "en" ? "en" : "es",
    sectors: Array.isArray(r.sectors) ? r.sectors : [], isDefault: !!r.is_default,
    theme: { ...DEFAULT_DOC_THEME, ...(d.theme ?? {}) }, blocks: Array.isArray(d.blocks) ? d.blocks : [], terms: d.terms ?? {},
    reference: d.reference ?? null, assets: Array.isArray(d.assets) ? d.assets.filter((x: any) => typeof x === "string") : [], updated_at: r.updated_at,
  };
};
const MISSING = /format|kind|sectors|column|relation|does not exist|schema cache|null value in column "storage_path"/i;
/** The company's HTML templates (default first). null = 28_proposal_html.sql not run yet. */
export async function listDocTemplates(kind?: DocKind): Promise<DocTemplateRow[] | null> {
  let q = supabase.from("proposal_decks").select("*").eq("format", "html");
  if (kind) q = q.eq("kind", kind);
  const { data, error } = await q.order("is_default", { ascending: false }).order("created_at");
  if (error) return MISSING.test(error.message) ? null : [];
  return (data ?? []).map(docFrom);
}
/** Saves a template (creates it when it has no id). The first one of its kind becomes the default. */
export async function saveDocTemplate(t: DocTemplate): Promise<{ id: string | null; error: string | null }> {
  const row: any = {
    name: t.name.trim() || "Template", kind: t.kind, sectors: t.sectors ?? [], format: "html",
    doc: { theme: t.theme, blocks: t.blocks, terms: t.terms ?? {}, lang: t.lang, reference: t.reference ?? null, assets: t.assets ?? [] },
    updated_at: new Date().toISOString(),
  };
  if (t.id) {
    const { error } = await supabase.from("proposal_decks").update(row).eq("id", t.id);
    return { id: t.id, error: error ? (MISSING.test(error.message) ? "Run 28_proposal_html.sql in Supabase to save templates." : error.message) : null };
  }
  const existing = await listDocTemplates(t.kind);
  if (existing === null) return { id: null, error: "Run 28_proposal_html.sql in Supabase to save templates." };
  const { data, error } = await supabase.from("proposal_decks").insert({ ...row, slides: [], storage_path: null, is_default: !existing.length }).select("id").single();
  if (error) return { id: null, error: MISSING.test(error.message) ? "Run 28_proposal_html.sql in Supabase to save templates." : error.message };
  return { id: (data as any).id, error: null };
}
export async function deleteDocTemplate(id: string): Promise<string | null> {
  const { error } = await supabase.from("proposal_decks").delete().eq("id", id);
  return error?.message ?? null;
}
/** Makes a template the default of its kind (for deals whose sector has no template of its own). */
export async function setDefaultDocTemplate(id: string, kind: DocKind): Promise<string | null> {
  const off = await supabase.from("proposal_decks").update({ is_default: false }).eq("format", "html").eq("kind", kind).neq("id", id);
  if (off.error) return off.error.message;
  const { error } = await supabase.from("proposal_decks").update({ is_default: true }).eq("id", id);
  return error?.message ?? null;
}
/** The template for a deal: the one for its sector, else the default, else the first. */
export function pickDocTemplate<T extends DocTemplate>(list: T[], kind: DocKind, sector?: string | null): T | null {
  const own = list.filter((t) => t.kind === kind);
  const sec = (sector ?? "").trim().toLowerCase();
  return (sec && own.find((t) => t.sectors.some((x) => x.trim().toLowerCase() === sec))) || own.find((t) => t.isDefault) || own[0] || null;
}
/** Colours, fonts, logo and company data from the existing proposal template (Order form tab), to start new templates with. */
export async function docThemeSeed(): Promise<Partial<DocTheme>> {
  const row = await loadProposalTemplateRow().catch(() => null);
  if (!row) return {};
  const b: any = row.brand ?? {}, c: any = b.colors ?? {}, a: any = b.assets ?? {};
  const hx = (v: any) => (v && /^#?[0-9a-f]{6}$/i.test(String(v)) ? `#${String(v).replace(/^#/, "").toUpperCase()}` : undefined);
  const img = (v?: string) => (!v ? undefined : /^https?:|^data:/i.test(v) ? v : `data:${v}`);
  const out: Partial<DocTheme> = {
    primary: hx(c.primary), accent: hx(c.accent), ink: hx(c.ink), muted: hx(c.muted),
    company: b.company || undefined, legalName: b.legalName || undefined, vat: b.vat || undefined, address: b.address || undefined, web: b.web || undefined,
    logo: img(a.logoLight) ?? img(a.logoDark), logoDark: img(a.logoDark),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null)) as Partial<DocTheme>;
}
/** Makes a picture light enough to keep: at most 1600px on its longest side, WebP (or JPEG) at 0.82. Small ones stay as they are. */
export async function shrinkImage(file: Blob, max = 1600, q = 0.82): Promise<Blob> {
  if (typeof document === "undefined" || !/^image\/(png|jpe?g|webp|bmp)/i.test(file.type)) return file;
  const url = URL.createObjectURL(file);
  try {
    const im = new Image();
    await new Promise<void>((ok, bad) => { im.onload = () => ok(); im.onerror = () => bad(new Error("image")); im.src = url; });
    const w0 = im.naturalWidth, h0 = im.naturalHeight;
    if (!w0 || !h0) return file;
    if (file.size < 350 * 1024 && Math.max(w0, h0) <= max) return file;
    const k = Math.min(1, max / Math.max(w0, h0));
    const cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(w0 * k)); cv.height = Math.max(1, Math.round(h0 * k));
    const g = cv.getContext("2d")!;
    const opaque = /jpe?g/i.test(file.type);
    if (opaque) { g.fillStyle = "#ffffff"; g.fillRect(0, 0, cv.width, cv.height); }
    g.drawImage(im, 0, 0, cv.width, cv.height);
    let out: Blob | null = await new Promise((ok) => cv.toBlob((b) => ok(b), "image/webp", q));
    // browsers without WebP give a PNG back: JPEG then (pictures with transparency keep the PNG)
    if (!out || !/webp/.test(out.type)) out = opaque ? await new Promise((ok) => cv.toBlob((b) => ok(b), "image/jpeg", q)) : out;
    return out && out.size < file.size ? out : file;
  } catch { return file; }
  finally { URL.revokeObjectURL(url); }
}
const blobDataUrl = (b: Blob) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => bad(new Error("read")); r.readAsDataURL(b); });
/**
 * An image for a template or a document: made light (1600px, WebP 0.82), then uploaded to the brand bucket.
 * If Storage says no for any reason (no bucket, no permission, offline), the light picture is kept inline instead —
 * so a picture never gets lost. Returns something an <img> shows.
 */
export async function uploadDocImage(file: Blob, key = "doc"): Promise<string> {
  const small = await shrinkImage(file);
  const type = small.type || file.type || "image/png";
  const ext = /webp/.test(type) ? "webp" : /png/.test(type) ? "png" : /svg/.test(type) ? "svg" : /gif/.test(type) ? "gif" : "jpg";
  try {
    const f = new File([small], `${key}.${ext}`, { type });
    const { data: auth } = await supabase.auth.getSession();
    const uid = auth?.session?.user?.id;
    const { data: prof } = uid ? await supabase.from("profiles").select("tenant_id").eq("id", uid).maybeSingle() : { data: null };
    const folder = (prof as any)?.tenant_id ?? "shared";
    const path = `${folder}/${key}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const { error } = await supabase.storage.from("brand").upload(path, f, { upsert: true, contentType: type });
    if (!error) return supabase.storage.from("brand").getPublicUrl(path).data.publicUrl;
  } catch { /* kept inline below */ }
  return blobDataUrl(small);
}

/* ---------- Variables of a deal: everything a document can show (custom fields included) ---------- */
const longDate = (v: any) => {
  if (!v) return "";
  const d = new Date(String(v).length <= 10 ? `${v}T12:00:00` : v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
};
/** A custom field's value as text: lists joined with commas, yes/no, dates written out. */
export function customValueText(v: any, type?: string): string {
  if (v == null || v === "") return "";
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.label ?? x.name ?? x.value ?? "" : String(x))).filter((x) => String(x).trim()).join(", ");
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (type === "boolean") return /^(true|1|yes|s[ií])$/i.test(String(v)) ? "Sí" : "No";
  if (type === "date") return longDate(v);
  if (typeof v === "number") return v.toLocaleString("es-ES");
  if (typeof v === "object") return String(v.label ?? v.name ?? v.value ?? "");
  return String(v);
}
type FieldRow = { id: string; label: string; type?: string; options?: any };
const fieldsOf = async (table: string): Promise<FieldRow[]> => {
  try { const { data, error } = await supabase.from(table).select("*").order("sort"); return error ? [] : ((data ?? []) as FieldRow[]); } catch { return []; }
};
/** The custom fields of deals, companies and contacts, as variables (deal.cf.<id>, company.cf.<id>, contact.cf.<id>). */
export async function loadDocVarDefs(): Promise<DocVarDef[]> {
  const [tf, cf, kf] = await Promise.all([fieldsOf("tracking_fields"), fieldsOf("company_fields"), fieldsOf("contact_fields")]);
  const ex = (f: FieldRow) => {
    const o = Array.isArray(f.options) ? f.options.map(String) : [];
    return f.type === "multiselect" ? o.slice(0, 2).join(", ") || "Option A, Option B" : f.type === "select" ? o[0] ?? "Option" : f.type === "date" ? "15 de marzo de 2026" : f.type === "number" ? "1.200" : f.type === "boolean" ? "Sí" : f.label;
  };
  return [
    ...tf.map((f) => ({ key: `deal.cf.${f.id}`, label: f.label, source: "deal" as const, example: ex(f) })),
    ...cf.map((f) => ({ key: `company.cf.${f.id}`, label: f.label, source: "company" as const, example: ex(f) })),
    ...kf.map((f) => ({ key: `contact.cf.${f.id}`, label: f.label, source: "contact" as const, example: ex(f) })),
  ];
}
/**
 * Every value of one deal for its documents, on top of what the proposal itself knows: stage, pipeline, dates,
 * the company's and the main contact's data, every contact, the deal team, and all custom fields
 * (multi-choice ones joined with commas). Never fails: what can't be read stays empty.
 */
export async function loadDocVariables(trackingId: string): Promise<{ values: Record<string, string>; defs: DocVarDef[] }> {
  const v: Record<string, string> = {};
  const one = async (q: PromiseLike<{ data: any; error: any }>) => { try { const r = await q; return r.error ? null : r.data; } catch { return null; } };
  const [tr, tf, cf, kf, defs] = await Promise.all([
    one(supabase.from("trackings").select("*").eq("id", trackingId).maybeSingle()),
    fieldsOf("tracking_fields"), fieldsOf("company_fields"), fieldsOf("contact_fields"), loadDocVarDefs(),
  ]);
  if (!tr) return { values: v, defs };
  const custom = (row: any) => (row?.custom && typeof row.custom === "object" ? row.custom : {});
  tf.forEach((f) => { v[`deal.cf.${f.id}`] = customValueText(custom(tr)[f.id], f.type); });
  v["deal.status"] = tr.status ? String(tr.status).replace(/^\w/, (c: string) => c.toUpperCase()) : "";
  v["deal.close_date"] = longDate(tr.mgr_close_date ?? tr.rep_close_date ?? tr.close_date);
  v["deal.created"] = longDate(tr.created_at);
  const prob = tr.mgr_close_prob ?? tr.rep_close_prob;
  v["deal.probability"] = prob != null ? `${prob}%` : "";
  const [phase, pipe, co] = await Promise.all([
    tr.current_phase_id ? one(supabase.from("pipeline_phases").select("name").eq("id", tr.current_phase_id).maybeSingle()) : null,
    tr.pipeline_id ? one(supabase.from("pipelines").select("name").eq("id", tr.pipeline_id).maybeSingle()) : null,
    tr.company_id ? one(supabase.from("companies").select("*").eq("id", tr.company_id).maybeSingle()) : null,
  ]);
  v["deal.stage"] = phase?.name ?? "";
  v["deal.pipeline"] = pipe?.name ?? "";
  if (co) {
    v["client.city"] = co.city ?? ""; v["client.country"] = co.country ?? ""; v["client.postal_code"] = co.postal_code ?? "";
    v["client.website"] = co.website ?? ""; v["client.sector"] = co.sector ?? ""; v["client.source"] = co.source ?? "";
    v["client.phone"] = co.landline || co.phone || ""; v["client.email"] = co.email ?? ""; v["client.linkedin"] = co.linkedin ?? "";
    // the company's logo: its own picture if it has one, else the website's icon
    v["client.logo"] = String(co.logo_url ?? co.logo ?? "").trim() || logoCandidates(co.website)[0] || "";
    cf.forEach((f) => { v[`company.cf.${f.id}`] = customValueText(custom(co)[f.id], f.type); });
  }
  // contacts: the deal's own, else the company's
  let ids: string[] = ((await one(supabase.from("tracking_contacts").select("contact_id").eq("tracking_id", trackingId))) ?? []).map((r: any) => r.contact_id);
  if (!ids.length && tr.company_id) ids = ((await one(supabase.from("company_contacts").select("contact_id").eq("company_id", tr.company_id))) ?? []).map((r: any) => r.contact_id);
  if (ids.length) {
    const rows: any[] = (await one(supabase.from("contacts").select("*").in("id", ids.slice(0, 200)))) ?? [];
    const people = ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
    const name = (c: any) => [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
    const main = people[0];
    if (main) {
      v["client.contact.first_name"] = main.first_name ?? ""; v["client.contact.last_name"] = main.last_name ?? "";
      v["client.contact.phone"] = main.phone ?? main.landline ?? ""; v["client.contact.linkedin"] = main.linkedin ?? "";
      kf.forEach((f) => { v[`contact.cf.${f.id}`] = customValueText(custom(main)[f.id], f.type); });
    }
    v["contacts.list"] = people.map((c) => [name(c), c.position].filter(Boolean).join(" · ")).filter(Boolean).join("\n");
    v["contacts.names"] = people.map(name).filter(Boolean).join(", ");
  }
  // the deal team (who plays which sales role)
  const roles: Record<string, string> = tr.deal_roles && typeof tr.deal_roles === "object" ? tr.deal_roles : {};
  const pids = Object.keys(roles);
  if (pids.length) {
    const [profs, srs] = await Promise.all([
      one(supabase.from("profiles").select("id, first_name, last_name, username, email").in("id", pids)),
      one(supabase.from("sales_roles").select("*").in("id", Array.from(new Set(Object.values(roles))))),
    ]);
    const team = pids.map((id) => {
      const pr = (profs ?? []).find((x: any) => x.id === id);
      const nm = pr ? [pr.first_name, pr.last_name].filter(Boolean).join(" ").trim() || pr.username || pr.email || "" : "";
      const role = (srs ?? []).find((x: any) => x.id === roles[id]);
      return { nm, role: role?.name ?? role?.label ?? "" };
    }).filter((x) => x.nm);
    v["team.list"] = team.map((x) => [x.nm, x.role].filter(Boolean).join(" · ")).join("\n");
    v["team.names"] = team.map((x) => x.nm).join(", ");
    v["deal.owner"] = (team.find((x) => /owner|account|propiet|comercial|exec/i.test(x.role)) ?? team[0])?.nm ?? "";
  }
  return { values: Object.fromEntries(Object.entries(v).filter(([, x]) => x != null)), defs };
}

/** Opens the print dialog for a document (the browser's "Save as PDF" gives a vector PDF). */
export function printDocHtml(html: string) {
  const f = document.createElement("iframe");
  f.setAttribute("aria-hidden", "true");
  Object.assign(f.style, { position: "fixed", right: "0", bottom: "0", width: "1px", height: "1px", border: "0", opacity: "0" });
  document.body.appendChild(f);
  f.srcdoc = html;
  f.onload = async () => {
    try { await (f.contentDocument as any)?.fonts?.ready; } catch { /* fonts are optional */ }
    setTimeout(() => { f.contentWindow?.focus(); f.contentWindow?.print(); setTimeout(() => f.remove(), 60000); }, 350);
  };
}

/**
 * A PDF file of a document (to keep in the deal's files): the print layout drawn page by page, A4,
 * cutting between blocks, cards and rows rather than through them.
 */
export async function docToPdfBlob(html: string): Promise<Blob> {
  const W = 794, H = 1123;
  const f = document.createElement("iframe");
  Object.assign(f.style, { position: "fixed", left: "-10000px", top: "0", width: `${W}px`, height: `${H}px`, border: "0" });
  document.body.appendChild(f);
  try {
    await new Promise<void>((ok) => { f.onload = () => ok(); f.srcdoc = html; });
    const doc = f.contentDocument!;
    try { await (doc as any).fonts?.ready; } catch { /* fonts are optional */ }
    await Promise.all(Array.from(doc.images).map((im) => (im.complete ? null : new Promise((ok) => { im.onload = im.onerror = () => ok(null); }))));
    await new Promise((ok) => setTimeout(ok, 250));
    // a document made of slides (kept from a PowerPoint / PDF): one page per slide, at the slide's own size
    if (doc.body.classList.contains("k-slides")) {
      const first = doc.querySelector(".sl") as HTMLElement | null;
      const sw = Number(first?.dataset.w) || 1280, sh = Number(first?.dataset.h) || 720;
      f.style.width = `${sw}px`; f.style.height = `${sh}px`;
      await new Promise((ok) => setTimeout(ok, 350));   // the slides scale to the new width
      const slides = Array.from(doc.querySelectorAll(".sl")) as HTMLElement[];
      const mod: any = await import("html2canvas");
      const h2c = mod.default ?? mod;
      const { jsPDF } = await import("jspdf");
      let pdf: any = null;
      for (const el of slides) {
        const w = Number(el.dataset.w) || sw, h = Number(el.dataset.h) || sh;
        const r = el.getBoundingClientRect();
        const canvas: HTMLCanvasElement = await h2c(el, { scale: Math.max(1.5, (w * 1.5) / Math.max(1, r.width)), useCORS: true, backgroundColor: "#ffffff", windowWidth: sw, logging: false });
        const orient = w >= h ? "landscape" : "portrait";
        if (!pdf) pdf = new jsPDF({ unit: "px", format: [w, h], orientation: orient, hotfixes: ["px_scaling"], compress: true });
        else pdf.addPage([w, h], orient);
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, w, h);
      }
      if (pdf) return pdf.output("blob") as Blob;
    }
    const root = doc.body;
    const total = Math.ceil(root.scrollHeight);
    // where a page may end: between blocks and between the pieces inside them
    const cuts = new Set<number>([total]);
    root.querySelectorAll(".blk, .sh, .rv, tr, li, p, h2, h3, .pc-head, .pc-foot, .pr-tot, .cd, .st, .tl-i, .tm, .pt").forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      cuts.add(Math.round(r.top + (doc.defaultView?.scrollY ?? 0)));
    });
    const stops = Array.from(cuts).filter((y) => y > 0).sort((a, b) => a - b);
    const mod: any = await import("html2canvas");
    const h2c = mod.default ?? mod;
    const scale = 2;
    const canvas: HTMLCanvasElement = await h2c(root, { scale, useCORS: true, backgroundColor: "#ffffff", windowWidth: W, width: W, height: total, logging: false });
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ unit: "px", format: [W, H], orientation: "portrait", hotfixes: ["px_scaling"], compress: true });
    let y = 0, page = 0;
    while (y < total - 4) {
      const limit = y + H;
      let end = limit >= total ? total : stops.filter((s) => s > y + H * 0.35 && s <= limit).pop() ?? limit;
      if (end <= y) end = limit;
      const slice = document.createElement("canvas");
      slice.width = W * scale; slice.height = Math.round((end - y) * scale);
      const g = slice.getContext("2d")!;
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, slice.width, slice.height);
      g.drawImage(canvas, 0, Math.round(y * scale), slice.width, slice.height, 0, 0, slice.width, slice.height);
      if (page) pdf.addPage([W, H], "portrait");
      pdf.addImage(slice.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, W, end - y);
      y = end; page++;
    }
    return pdf.output("blob") as Blob;
  } finally { f.remove(); }
}


/* ---------- "Start from…": what a new document can start from ---------- */
/** A proposal or contract already made on a deal. */
export interface DocSourceDoc { id: string; name: string; deal: string; trackingId: string; updatedAt: string; inst: DocInstance }
/** A PowerPoint, PDF or Word file kept on a deal. */
export interface DocSourceFile { id: string; name: string; path: string; size: number | null; at: string; deal: string; trackingId: string }
const DOC_FILE = /\.(pptx|pdf|docx)$/i;
/** The documents made on deals and the files on deals a new document can start from (most recent first; this deal's first). */
export async function listDocSources(kind: DocKind, o: { trackingId?: string; excludeProposalId?: string } = {}): Promise<{ docs: DocSourceDoc[]; files: DocSourceFile[] }> {
  const [pr, fr] = await Promise.all([
    supabase.from("deal_proposals").select("id, name, tracking_id, doc, updated_at").order("updated_at", { ascending: false }).limit(80),
    supabase.from("tracking_files").select("id, name, storage_path, size_bytes, created_at, tracking_id").or("name.ilike.%.pptx,name.ilike.%.pdf,name.ilike.%.docx").order("created_at", { ascending: false }).limit(150),
  ]);
  const prows = (pr.error ? [] : pr.data ?? []) as any[];
  const frows = (fr.error ? [] : fr.data ?? []) as any[];
  const ids = Array.from(new Set([...prows, ...frows].map((r) => r.tracking_id).filter(Boolean)));
  const deals = new Map<string, string>();
  if (ids.length) {
    const { data } = await supabase.from("trackings").select("id, deal_name").in("id", ids);
    (data ?? []).forEach((t: any) => deals.set(t.id, t.deal_name || "Deal"));
  }
  const mine = (t: string) => (o.trackingId && t === o.trackingId ? 0 : 1);
  const docs: DocSourceDoc[] = prows
    .filter((r) => r.id !== o.excludeProposalId)
    .map((r) => ({ r, inst: r.doc?.html?.[kind] as DocInstance | undefined }))
    .filter((x) => x.inst && Array.isArray(x.inst.blocks) && x.inst.blocks.length)
    .map(({ r, inst }) => ({ id: r.id, name: r.name || "Proposal", deal: deals.get(r.tracking_id) ?? "Deal", trackingId: r.tracking_id, updatedAt: inst!.updatedAt ?? r.updated_at, inst: inst! }))
    .sort((a, b) => mine(a.trackingId) - mine(b.trackingId));
  const files: DocSourceFile[] = frows.filter((r) => DOC_FILE.test(r.name ?? ""))
    .map((r) => ({ id: r.id, name: r.name, path: r.storage_path, size: r.size_bytes ?? null, at: r.created_at, deal: deals.get(r.tracking_id) ?? "Deal", trackingId: r.tracking_id }))
    .sort((a, b) => mine(a.trackingId) - mine(b.trackingId));
  return { docs, files };
}
/** A file kept on a deal, as a File (to import it). */
export async function trackingFileAsFile(path: string, name: string): Promise<File> {
  const { data, error } = await supabase.storage.from("tracking-files").download(path);
  if (error || !data) throw new Error(error?.message ?? "Could not open the file.");
  return new File([data], name, { type: data.type || undefined });
}

/* ---------- AI suggestions: variables and per-product pages (edge function proposal-ai) ---------- */
export interface DocSuggestion { plan: DocAiPlan; inv: DocTextItem[]; /** why the rules answered instead of the AI */ fallback?: string }
/** Asks the AI what to turn into variables and which pages depend on a product / service; the rules answer when it can't. */
export async function suggestDocPlan(blocks: DocBlock[], o: { kind: DocKind; lang: DocLang; provider?: string; clientNames?: string[]; catalog: { products: { id: string; name: string }[]; services: { id: string; name: string }[] }; model?: string }): Promise<DocSuggestion> {
  const inv = docTextInventory(blocks);
  const vars = docVarCatalog(o.kind).flatMap((g) => g.vars).filter((v) => !/N\./.test(v.key));
  const keys = vars.map((v) => v.key);
  const rules = (why: string): DocSuggestion => ({ plan: rulesDocPlan(inv, { clientNames: o.clientNames, provider: o.provider, catalog: o.catalog, vars: keys }), inv, fallback: why });
  if (!inv.length) return rules("The document has no texts to read.");
  try {
    const { data, error } = await supabase.functions.invoke("proposal-ai", {
      body: {
        kind: o.kind, lang: o.lang, provider: o.provider, model: o.model,
        items: inv.map(({ id, page, text, size, role }) => ({ id, page, text, size, role })),
        pages: docPageTitles(inv, blocks.length),
        vars: vars.map((v) => ({ key: v.key, label: v.label, example: v.example })),
        catalog: { products: o.catalog.products.map((x) => x.name), services: o.catalog.services.map((x) => x.name) },
      },
    });
    if (error) {
      let msg = error.message;
      try { const j = await (error as any).context?.json?.(); if (j?.error === "no_key") return rules("AI isn't set up yet (ANTHROPIC_API_KEY)."); msg = j?.error ?? j?.message ?? msg; } catch { /* keep message */ }
      return rules(/not found|404|failed to send|fetch/i.test(msg) ? "AI isn't set up yet (deploy the proposal-ai function)." : `AI unavailable: ${msg}`);
    }
    const raw = (data as any)?.plan;
    if (!raw || typeof raw !== "object") return rules("The AI gave no answer.");
    const byId = new Map(inv.map((x) => [x.id, x]));
    const okKey = new Set(keys);
    const replacements = (Array.isArray(raw.replacements) ? raw.replacements : [])
      .filter((r: any) => r && typeof r.find === "string" && r.find.trim() && byId.get(r.id)?.text.replace(/\s+/g, " ").includes(r.find.replace(/\s+/g, " ")))
      .map((r: any) => ({ id: String(r.id), find: String(r.find), token: typeof r.token === "string" && okKey.has(r.token.replace(/^\{\{|\}\}$/g, "")) ? r.token.replace(/^\{\{|\}\}$/g, "") : undefined, text: typeof r.text === "string" ? r.text : undefined, reason: String(r.reason ?? "") }))
      .filter((r: any) => r.token || r.text != null);
    const sections = (Array.isArray(raw.sections) ? raw.sections : [])
      .filter((x: any) => x && Number.isInteger(x.page) && x.page >= 1 && x.page <= blocks.length && ["always", "product", "service"].includes(x.when))
      .map((x: any) => ({ page: x.page, when: x.when, names: Array.isArray(x.names) ? x.names.map(String) : [], reason: String(x.reason ?? "") }));
    return { plan: { replacements, sections, notes: typeof raw.notes === "string" ? raw.notes : undefined, source: "ai", model: (data as any)?.model }, inv };
  } catch (e: any) {
    return rules(`AI unavailable: ${e?.message ?? "no connection"}`);
  }
}


/* ---------- Reading a signed contract PDF (rules first, the AI fills the gaps when it's set up) ---------- */
export interface SignedContractRead { data: OrderFormData; source: "rules" | "ai"; note?: string }
const ofEmptyish = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => x == null || x === ""));
/** Reads a signed contract / order form PDF into contract fields. */
export async function readSignedContract(bytes: ArrayBuffer | Uint8Array, opts: { ai?: boolean } = {}): Promise<SignedContractRead> {
  const data = await extractOrderForm(bytes);
  if (opts.ai === false || !(data.text ?? "").trim()) return { data, source: "rules" };
  try {
    const { data: res, error } = await supabase.functions.invoke("proposal-ai", { body: { action: "extract_contract", text: data.text } });
    if (error) {
      let why = error.message;
      try { const j = await (error as any).context?.json?.(); if (j?.error === "no_key") why = "AI isn't set up yet"; else why = j?.error ?? j?.message ?? why; } catch { /* keep */ }
      return { data, source: "rules", note: /not found|404|failed to send|fetch/i.test(why) ? "AI isn't set up yet" : why };
    }
    const ai = (res as any)?.fields;
    if (!ai || typeof ai !== "object") return { data, source: "rules" };
    const merged: any = { ...data };
    for (const [k, v] of Object.entries(ai)) {
      if (ofEmptyish(v)) continue;
      const cur = merged[k];
      if (ofEmptyish(cur)) { merged[k] = v; if (!merged.found.includes(k)) merged.found.push(k); continue; }
      // objects: fill only the missing parts (the rules read the layout; the AI fills what they missed)
      if (cur && typeof cur === "object" && !Array.isArray(cur) && typeof v === "object" && !Array.isArray(v)) {
        const o: any = { ...cur };
        for (const [kk, vv] of Object.entries(v as object)) if (ofEmptyish(o[kk]) && !ofEmptyish(vv)) { o[kk] = vv; const fk = `${k}.${kk}`; if (k === "customer" && !merged.found.includes(fk)) merged.found.push(fk); }
        merged[k] = o;
      }
    }
    return { data: merged as OrderFormData, source: "ai" };
  } catch (e: any) {
    return { data, source: "rules", note: e?.message };
  }
}
