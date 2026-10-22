/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../../api/supabase";
import type { ProposalTemplate, ProposalData, DocTemplate, DocKind, DocTheme } from "./proposalGen";
import { buildProposalDeck, buildOrderFormPdf, DEFAULT_DOC_THEME } from "./proposalGen";

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
    reference: d.reference ?? null, updated_at: r.updated_at,
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
    doc: { theme: t.theme, blocks: t.blocks, terms: t.terms ?? {}, lang: t.lang, reference: t.reference ?? null },
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
/** An image for a template: uploaded to the brand bucket (or kept inline if Storage refuses). Returns something an <img> shows. */
export async function uploadDocImage(file: Blob, key = "doc"): Promise<string> {
  let f: File = file instanceof File ? file : new File([file], `${key}.${/png/.test(file.type) ? "png" : "jpg"}`, { type: file.type || "image/jpeg" });
  // big photos are shrunk first
  if (f.size > 700 * 1024 && typeof document !== "undefined" && /^image\/(png|jpe?g|webp)/.test(f.type)) {
    try {
      const url = URL.createObjectURL(f);
      const im = new Image(); await new Promise<void>((ok, bad) => { im.onload = () => ok(); im.onerror = () => bad(new Error("image")); im.src = url; });
      const k = Math.min(1, 1800 / Math.max(im.naturalWidth, im.naturalHeight));
      const cv = document.createElement("canvas"); cv.width = Math.round(im.naturalWidth * k); cv.height = Math.round(im.naturalHeight * k);
      cv.getContext("2d")!.drawImage(im, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
      const blob: Blob = await new Promise((ok) => cv.toBlob((b) => ok(b ?? f), "image/jpeg", 0.86));
      f = new File([blob], f.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
    } catch { /* keep the original */ }
  }
  const { value, inline } = await uploadBrandAsset(f, key);
  return inline ? `data:${value.replace(/^data:/, "")}` : value;
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
