/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";
import type { ProposalTemplate, ProposalData } from "./proposalGen";
import { buildProposalDeck, buildOrderFormPdf } from "./proposalGen";

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
  return { ...t, brand: { ...t.brand, assets: assets as any } };
}

const safeName = (s: string) => s.replace(/[^\w\-]+/g, "_").slice(0, 60);

/** Generate and download a proposal in the requested format. */
export async function generateProposal(kind: "pptx" | "pdf", data: ProposalData, template: ProposalTemplate) {
  const t = await resolveBrandAssets(template);
  const base = `${safeName(t.brand.company)}-Propuesta-${safeName(data.client.name)}`;
  if (kind === "pptx") {
    const mod: any = await import("pptxgenjs");
    const pptxgen = mod.default ?? mod;
    const pres = await buildProposalDeck(pptxgen, data, t);
    await pres.writeFile({ fileName: `${base}.pptx` });
  } else {
    const { jsPDF } = await import("jspdf");
    const doc = buildOrderFormPdf(jsPDF, data, t);
    doc.save(`${base}-OrderForm.pdf`);
  }
}