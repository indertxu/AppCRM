/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../api/supabase";

/**
 * One row per import (who, when, which file). Records created by the import carry
 * its id; the database stamps imported_by / imported_at itself and never lets
 * them change. If the import_batches table isn't there yet, imports still work —
 * they just aren't tracked.
 */
export interface ImportBatch { id: string; entity: "contact" | "company"; file_name: string | null; created_by: string; created_at: string; rows_created: number; rows_updated: number }

export async function startImportBatch(entity: "contact" | "company", fileName: string | null): Promise<string | null> {
  const { data, error } = await supabase.from("import_batches").insert({ entity, file_name: fileName || null }).select("id").single();
  if (error) { console.warn("Import not tracked:", error.message); return null; }
  return (data as any)?.id ?? null;
}

export async function finishImportBatch(id: string | null, rowsCreated: number, rowsUpdated: number) {
  if (!id) return;
  await supabase.from("import_batches").update({ rows_created: rowsCreated, rows_updated: rowsUpdated }).eq("id", id);
}

export async function listImportBatches(): Promise<ImportBatch[]> {
  const { data, error } = await supabase.from("import_batches").select("*").order("created_at", { ascending: false }).range(0, 9999);
  if (error) return [];
  return (data ?? []) as ImportBatch[];
}

/** "contacts.xlsx · 7 Oct 2026, 13:20 · Inder Andrés" */
export function batchLabel(b: ImportBatch, people: Record<string, string>): string {
  const when = new Date(b.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return [b.file_name || "Import", when, people[b.created_by]].filter(Boolean).join(" · ");
}