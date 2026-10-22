/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../../api/supabase";

/**
 * Custom fields on a sales tracking (deal), defined once per company and
 * filled in on each deal. Same model as contact and company fields: the
 * definitions live in `tracking_fields`, the values in `trackings.custom`
 * keyed by the field id (so renaming a field never loses its data).
 */
export type TrackingFieldType = "text" | "number" | "date" | "boolean" | "select";

export interface TrackingField {
  id: string;
  label: string;
  type: TrackingFieldType;
  required: boolean;
  options: string[];
  sort: number;
}

export const FIELD_TYPE_LABEL: Record<TrackingFieldType, string> = {
  text: "Text", number: "Number", date: "Date", boolean: "Yes / No", select: "Dropdown",
};

const fromRow = (r: any): TrackingField => ({
  id: r.id, label: r.label ?? "", type: (r.type ?? "text") as TrackingFieldType, required: !!r.required,
  options: Array.isArray(r.options) ? r.options.map(String) : [], sort: r.sort ?? 0,
});

/** All field definitions, in their display order. `missing` = the table isn't installed yet. */
export async function loadTrackingFields(): Promise<{ fields: TrackingField[]; missing: boolean }> {
  const { data, error } = await supabase.from("tracking_fields").select("*").order("sort").order("created_at");
  if (error) return { fields: [], missing: true };
  return { fields: (data ?? []).map(fromRow), missing: false };
}
export async function listTrackingFields(): Promise<TrackingField[]> {
  return (await loadTrackingFields()).fields;
}

export async function addTrackingField(input: Omit<TrackingField, "id">): Promise<{ field: TrackingField | null; error: string | null }> {
  const { data, error } = await supabase.from("tracking_fields")
    .insert({ label: input.label, type: input.type, required: input.required, options: input.options, sort: input.sort })
    .select().single();
  if (error || !data) return { field: null, error: error?.message ?? "Could not add the field." };
  return { field: fromRow(data), error: null };
}

export async function updateTrackingField(id: string, patch: Partial<Omit<TrackingField, "id">>): Promise<string | null> {
  const { error } = await supabase.from("tracking_fields").update(patch).eq("id", id);
  return error?.message ?? null;
}

export async function deleteTrackingField(id: string): Promise<string | null> {
  const { error } = await supabase.from("tracking_fields").delete().eq("id", id);
  return error?.message ?? null;
}

/** Store the new order (sort = position in the list). */
export async function reorderTrackingFields(ids: string[]): Promise<string | null> {
  for (let i = 0; i < ids.length; i++) {
    const { error } = await supabase.from("tracking_fields").update({ sort: i }).eq("id", ids[i]);
    if (error) return error.message;
  }
  return null;
}

/**
 * A dropdown option renamed in the field editor: every deal that had the old
 * value gets the new one (deals keep their values keyed by the field id).
 * Also follows a value stored as a list, in case a field ever held several.
 */
export async function renameTrackingValue(fieldId: string, from: string, to: string): Promise<string | null> {
  if (!from || from === to) return null;
  const [one, many] = await Promise.all([
    supabase.from("trackings").select("id, custom").eq(`custom->>${fieldId}`, from).range(0, 49999),
    supabase.from("trackings").select("id, custom").contains("custom", { [fieldId]: [from] }).range(0, 49999),
  ]);
  if (one.error) return one.error.message;
  const rows = new Map<string, any>();
  [...(one.data ?? []), ...(many.error ? [] : many.data ?? [])].forEach((r: any) => rows.set(r.id, r));
  for (const r of rows.values()) {
    const cur = (r.custom ?? {})[fieldId];
    const next = Array.isArray(cur) ? [...new Set(cur.map((x: any) => (x === from ? to : x)))] : to;
    const { error } = await supabase.from("trackings").update({ custom: { ...(r.custom ?? {}), [fieldId]: next } }).eq("id", r.id);
    if (error) return error.message;
  }
  return null;
}

/** Replace the custom values of one deal. */
export async function saveTrackingCustom(trackingId: string, custom: Record<string, any>): Promise<string | null> {
  const { error } = await supabase.from("trackings").update({ custom: cleanCustom(custom) }).eq("id", trackingId);
  return error?.message ?? null;
}

/* ─────────────── helpers shared by the form, the panel, reports and exports ─────────────── */

export const isEmptyValue = (f: Pick<TrackingField, "type">, v: any) =>
  v == null || v === "" || (f.type === "boolean" && v !== true && v !== false);

/** Drop empty values so the stored jsonb stays tidy. */
export function cleanCustom(custom: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  Object.entries(custom ?? {}).forEach(([k, v]) => { if (v != null && v !== "") out[k] = v; });
  return out;
}

/** The first required field that has no value, if any. */
export function missingRequired(fields: TrackingField[], custom: Record<string, any>): TrackingField | null {
  return fields.find((f) => f.required && isEmptyValue(f, custom?.[f.id])) ?? null;
}

/** A value as people read it (lists, exports, report cells). */
export function displayValue(f: TrackingField, v: any): string {
  if (v == null || v === "") return "";
  if (f.type === "boolean") return v === true ? "Yes" : v === false ? "No" : String(v);
  if (f.type === "date") {
    const s = String(v).slice(0, 10);
    const [y, m, d] = s.split("-").map(Number);
    return y && m && d ? new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : s;
  }
  if (f.type === "number") { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("es-ES") : String(v); }
  return String(v);
}
