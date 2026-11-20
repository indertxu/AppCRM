/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BASE · Growth › Website — reading and writing sites (sql/160_base_sites.sql) and
 * asking the AI (edge function "site-ai").
 */
import { supabase } from "../../../../components/api/supabase";
import { cleanSeo, cleanSite, type Brief, type Seo, type Site, type SiteRow, type SiteVersion } from "./siteTypes";

const COLS = "id, name, slug, status, draft, seo, settings, brief, published, published_at, created_at, updated_at";
const missingTable = (e: any) => !!e && (/base_sites|base_site_versions|schema cache|does not exist/i.test(String(e.message ?? "")) || e.code === "42P01" || e.code === "PGRST205");

const rowOf = (r: any): SiteRow => {
  const draft = cleanSite(r.draft, r.name);
  return {
    ...r, draft, seo: cleanSeo(r.seo, draft), settings: r.settings ?? {}, brief: r.brief ?? {},
    published: r.published ? { site: cleanSite(r.published.site ?? r.published, r.name), seo: cleanSeo(r.published.seo, draft) } : null,
  };
};

export async function listSites(): Promise<{ sites: SiteRow[]; missing: boolean; error?: string }> {
  const { data, error } = await supabase.from("base_sites").select(COLS).order("created_at", { ascending: true });
  if (error) return { sites: [], missing: missingTable(error), error: error.message };
  return { sites: ((data ?? []) as any[]).map(rowOf), missing: false };
}

export async function slugFree(slug: string, siteId?: string | null): Promise<boolean> {
  const { data, error } = await supabase.rpc("base_site_slug_free", { p_slug: slug, p_site: siteId ?? null });
  if (error) return true; // the save will tell
  return !!data;
}

export async function createSite(input: { name: string; slug: string; draft: Site; seo: Seo; brief: Partial<Brief> }): Promise<{ site: SiteRow | null; error: string | null }> {
  const { data, error } = await supabase.from("base_sites").insert({ name: input.name, slug: input.slug, draft: input.draft, seo: input.seo, brief: input.brief }).select(COLS).single();
  if (error) return { site: null, error: /duplicate|unique/i.test(error.message) ? "That address is taken — pick another." : error.message };
  return { site: rowOf(data), error: null };
}

export async function saveSite(id: string, patch: Partial<Pick<SiteRow, "name" | "slug" | "draft" | "seo" | "settings" | "brief" | "status">>): Promise<string | null> {
  const { error } = await supabase.from("base_sites").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return /duplicate|unique/i.test(error.message) ? "That address is taken — pick another." : error.message;
  return null;
}

export async function deleteSite(id: string): Promise<string | null> {
  const { error } = await supabase.from("base_sites").delete().eq("id", id);
  return error?.message ?? null;
}

/** "Publish": what's in the draft goes live now. */
export async function publishSite(row: SiteRow, draft: Site, seo: Seo): Promise<{ at: string | null; error: string | null }> {
  const at = new Date().toISOString();
  const { error } = await supabase.from("base_sites").update({ draft, seo, published: { site: draft, seo }, published_at: at, status: "live", updated_at: at }).eq("id", row.id);
  if (error) return { at: null, error: error.message };
  await addVersion(row.id, "publish", "Published", draft, seo);
  return { at, error: null };
}

export async function setStatus(id: string, status: SiteRow["status"]): Promise<string | null> {
  return saveSite(id, { status });
}

export async function addVersion(siteId: string, kind: string, note: string, draft: Site, seo: Seo): Promise<void> {
  await supabase.from("base_site_versions").insert({ site_id: siteId, kind, note: note.slice(0, 500), draft, seo }).then(() => {}, () => {});
}

export async function listVersions(siteId: string): Promise<SiteVersion[]> {
  const { data } = await supabase.from("base_site_versions").select("id, kind, note, created_at, draft, seo").eq("site_id", siteId).order("created_at", { ascending: false }).limit(60);
  return ((data ?? []) as any[]).map((v) => ({ ...v, draft: cleanSite(v.draft), seo: cleanSeo(v.seo) }));
}

/* ---- the AI ---- */
export interface AiAnswer { site: Site; seo: Seo; summary: string }
async function callAi(body: Record<string, any>): Promise<{ answer: AiAnswer | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke("site-ai", { body });
  let msg: string | null = null;
  if (error) {
    try { const j = await (error as any).context?.json?.(); msg = j?.message || j?.error || null; } catch { /* not json */ }
    let m: string = msg || error.message || "The AI didn't answer.";
    if (/Failed to send|not found|404/i.test(m)) m = "The AI website builder isn't switched on yet (edge function site-ai).";
    return { answer: null, error: m };
  }
  if ((data as any)?.error) return { answer: null, error: (data as any).message || (data as any).error };
  if (!(data as any)?.site || !Array.isArray((data as any).site.pages)) return { answer: null, error: "The AI gave no website back — try again." };
  const site = cleanSite((data as any)?.site, body.brief?.name ?? "");
  return { answer: { site, seo: cleanSeo((data as any)?.seo, site), summary: String((data as any)?.summary ?? "") }, error: null };
}
export const aiGenerate = (brief: Partial<Brief>) => callAi({ action: "generate", brief });
export const aiEdit = (p: { site: Site; seo: Seo; brief: Partial<Brief>; instruction: string; page_id?: string | null; section_id?: string | null; history?: { role: "user" | "assistant"; text: string }[] }) =>
  callAi({ action: "edit", ...p });

/* ---- pictures ---- */
export async function uploadAsset(siteId: string, file: File): Promise<{ url: string | null; error: string | null }> {
  const { data: t } = await supabase.rpc("current_tenant");
  const tenant = (t as any) ?? "";
  if (!tenant) return { url: null, error: "Couldn't tell your company." };
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
  const path = `${tenant}/${siteId}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const { error } = await supabase.storage.from("site-assets").upload(path, file, { cacheControl: "31536000", upsert: false, contentType: file.type || undefined });
  if (error) return { url: null, error: /bucket/i.test(error.message) ? "Run 160_base_sites.sql first (it adds the picture storage)." : error.message };
  return { url: supabase.storage.from("site-assets").getPublicUrl(path).data.publicUrl, error: null };
}

/* ---- the Growth forms a contact section can show ---- */
export async function listLiveForms(): Promise<{ token: string; name: string }[]> {
  const { data } = await supabase.from("mk_forms").select("name, token, status").eq("status", "live").order("updated_at", { ascending: false });
  return ((data ?? []) as any[]).map((f) => ({ token: f.token, name: f.name }));
}

/* ---- the public page ---- */
export async function loadPublicSite(slug: string): Promise<{ name: string; site: Site; seo: Seo } | null> {
  const { data, error } = await supabase.rpc("public_site", { p_slug: slug });
  if (error || !data) return null;
  const d = data as any;
  const site = cleanSite(d.site?.site ?? d.site, d.name);
  return { name: d.name, site, seo: cleanSeo(d.site?.seo, site) };
}
