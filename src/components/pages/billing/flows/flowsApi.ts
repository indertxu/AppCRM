/* =====================================================================
   ENTERPRISE · Billing › Workflows (adopted from Base, src/base/pages/billing/flows, 2026-11-23) — data (SQL 156) and the "billing-flows"
   edge function (the PDF and the sending).
   ===================================================================== */
import { supabase } from "../../../api/supabase";

export type FlowTrigger = "billing_day" | "issued" | "before_due" | "overdue";
export type AudMode = "all" | "only" | "except";
export interface BillFlow {
  id: string; name: string; status: "draft" | "active" | "paused"; position: number;
  trigger: FlowTrigger; trigger_days: number;
  audience: { mode: AudMode; client_ids: string[] };
  entity_id: string | null; blueprint_id: string | null; template_id: string | null;
  sender_account: string | null; from_address: string | null; cc: string[];
  attach_pdf: boolean; send_drafts: boolean;
  activated_at: string | null; last_run_at: string | null; last_error: string | null;
  created_at: string; updated_at: string;
}
export interface PdfDesign {
  layout: "classic" | "band" | "minimal"; accent: string; lang: "en" | "es"; title: string; font: "sans" | "serif";
  show_logo: boolean; show_due: boolean; show_contact: boolean; notes: string; pay_text: string; footer: string;
}
export interface Blueprint { id: string; name: string; design: PdfDesign; email_subject: string; email_body: string; is_default: boolean; updated_at: string }
export interface Entity {
  id: string; name: string; legal_name: string; tax_id: string; street: string; postal_code: string; city: string; province: string;
  country: string; email: string; phone: string; website: string; iban: string; logo_url: string; color: string; is_default: boolean;
}
export interface FlowSend { id: string; flow_id: string | null; invoice_id: string; step: string; to_address: string | null; status: "sent" | "failed"; error: string | null; created_at: string }
export interface MkTpl { id: string; name: string; subject: string }

export const DESIGN_DEFAULT: PdfDesign = {
  layout: "classic", accent: "#0a6f4d", lang: "es", title: "", font: "sans", show_logo: true, show_due: true, show_contact: true,
  notes: "", pay_text: "", footer: "",
};
export const ENTITY_EMPTY: Omit<Entity, "id"> = {
  name: "", legal_name: "", tax_id: "", street: "", postal_code: "", city: "", province: "", country: "ES",
  email: "", phone: "", website: "", iban: "", logo_url: "", color: "", is_default: false,
};
export const flowEmpty = (position: number): Omit<BillFlow, "id" | "created_at" | "updated_at"> => ({
  name: "", status: "draft", position, trigger: "issued", trigger_days: 3, audience: { mode: "all", client_ids: [] },
  entity_id: null, blueprint_id: null, template_id: null, sender_account: null, from_address: null, cc: [],
  attach_pdf: true, send_drafts: true, activated_at: null, last_run_at: null, last_error: null,
});
export const TRIGGER_LABEL: Record<FlowTrigger, string> = {
  billing_day: "On the billing day", issued: "When an invoice is sent", before_due: "Before it's due", overdue: "When it's overdue",
};
export const triggerText = (f: Pick<BillFlow, "trigger" | "trigger_days" | "send_drafts">) =>
  f.trigger === "before_due" ? `${f.trigger_days} day${f.trigger_days === 1 ? "" : "s"} before it's due`
  : f.trigger === "overdue" ? (f.trigger_days ? `${f.trigger_days} day${f.trigger_days === 1 ? "" : "s"} overdue` : "The day it's overdue")
  : f.trigger === "billing_day" ? (f.send_drafts ? "On the billing day" : "On the billing day · once reviewed")
  : "When an invoice is sent";
export const MAIL_VARS: { key: string; label: string }[] = [
  { key: "first_name", label: "First name" }, { key: "client", label: "Client" }, { key: "invoice_number", label: "Invoice no." },
  { key: "invoice_total", label: "Total" }, { key: "due_date", label: "Due date" }, { key: "issue_date", label: "Issue date" },
  { key: "period", label: "Period" }, { key: "issuer", label: "Issuing company" }, { key: "iban", label: "IBAN" },
];
export const DEFAULT_MAIL = {
  en: { subject: "Invoice {{invoice_number}} from {{issuer}}", body: "Hello {{first_name}},\n\nPlease find attached invoice {{invoice_number}} for {{invoice_total}}, due on {{due_date}}.\n\nThank you,\n{{issuer}}" },
  es: { subject: "Factura {{invoice_number}} de {{issuer}}", body: "Hola {{first_name}},\n\nTe adjuntamos la factura {{invoice_number}} por {{invoice_total}}, con vencimiento el {{due_date}}.\n\nGracias,\n{{issuer}}" },
};

const NEEDS = "Billing workflows need sql 156_base_billing_flows.sql (src/base/sql) in Supabase.";
const fail = (m: string) => new Error(/does not exist|schema cache|relation/i.test(m) ? NEEDS : m);
export const needsSql = (e: unknown) => String((e as Error)?.message ?? e) === NEEDS;

const toFlow = (r: any): BillFlow => ({
  ...r, trigger_days: Number(r.trigger_days) || 0, cc: r.cc ?? [],
  audience: { mode: r.audience?.mode === "only" || r.audience?.mode === "except" ? r.audience.mode : "all", client_ids: Array.isArray(r.audience?.client_ids) ? r.audience.client_ids : [] },
});
const toBp = (r: any): Blueprint => ({ ...r, design: { ...DESIGN_DEFAULT, ...(r.design ?? {}) } });

export async function loadFlowsAll(): Promise<{ flows: BillFlow[]; blueprints: Blueprint[]; entities: Entity[]; sends: FlowSend[] }> {
  const [f, b, e, s] = await Promise.all([
    supabase.from("base_billing_flows").select("*").order("position").order("created_at"),
    supabase.from("base_billing_blueprints").select("*").order("created_at"),
    supabase.from("base_billing_entities").select("*").order("created_at"),
    supabase.from("base_billing_flow_sends").select("id, flow_id, invoice_id, step, to_address, status, error, created_at").order("created_at", { ascending: false }).limit(300),
  ]);
  const err = f.error || b.error || e.error;
  if (err) throw fail(err.message);
  return { flows: (f.data ?? []).map(toFlow), blueprints: (b.data ?? []).map(toBp), entities: (e.data ?? []) as Entity[], sends: (s.data ?? []) as FlowSend[] };
}
export async function loadMkTemplates(): Promise<MkTpl[]> {
  const { data } = await supabase.from("mk_templates").select("id, name, subject").order("name");
  return (data ?? []) as MkTpl[];
}

async function upsert<T extends { id?: string | null }>(table: string, row: T): Promise<any> {
  const { id, ...rest } = row as any;
  const body = { ...rest, updated_at: new Date().toISOString() };
  const res = id ? await supabase.from(table).update(body).eq("id", id).select("*").single() : await supabase.from(table).insert(body).select("*").single();
  if (res.error) throw fail(res.error.message);
  return res.data;
}
export async function saveFlow(f: Partial<BillFlow> & { id?: string | null }): Promise<BillFlow> {
  const row: any = { ...f };
  delete row.created_at; delete row.last_run_at; delete row.last_error;
  return toFlow(await upsert("base_billing_flows", row));
}
export async function saveBlueprint(b: Partial<Blueprint> & { id?: string | null }): Promise<Blueprint> {
  const row: any = { ...b }; delete row.updated_at;
  return toBp(await upsert("base_billing_blueprints", row));
}
export async function saveEntity(e: Partial<Entity> & { id?: string | null }): Promise<Entity> {
  return (await upsert("base_billing_entities", e)) as Entity;
}
/** Only one default: the others lose it. */
export async function makeDefault(table: "base_billing_entities" | "base_billing_blueprints", id: string) {
  await supabase.from(table).update({ is_default: false }).neq("id", id);
  const { error } = await supabase.from(table).update({ is_default: true }).eq("id", id);
  if (error) throw fail(error.message);
}
export async function removeRow(table: "base_billing_flows" | "base_billing_blueprints" | "base_billing_entities", id: string) {
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw fail(error.message);
}
export async function reorderFlows(ids: string[]) {
  await Promise.all(ids.map((id, i) => supabase.from("base_billing_flows").update({ position: i }).eq("id", id)));
}

/* ---------- the edge function ---------- */
async function fn(action: string, payload: object): Promise<any> {
  const { data, error } = await supabase.functions.invoke("billing-flows", { body: { action, ...payload } });
  if (!error) return data ?? {};
  try { const b = await (error as any).context?.json?.(); if (b?.error) return b; } catch { /* not JSON */ }
  const m = String((error as any)?.message ?? error);
  return { error: /Failed to send|fetch|404|not found/i.test(m) ? "The billing workflows service isn't reachable yet." : m };
}
/** The invoice as the client gets it (a sample invoice when none is given). */
export async function pdfOf(o: { invoiceId?: string; design?: PdfDesign; entity?: Partial<Entity> | null; entityId?: string | null; blueprintId?: string | null; flowId?: string }): Promise<{ url: string; name: string; bytes: Uint8Array } | { error: string }> {
  const r = await fn("pdf", o);
  if (!r?.pdf) return { error: String(r?.error ?? "Couldn't make the PDF.") };
  const bin = atob(r.pdf); const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return { url: URL.createObjectURL(new Blob([b], { type: "application/pdf" })), name: String(r.name ?? "invoice.pdf"), bytes: b };
}
export async function runFlow(id: string): Promise<{ sent: number; failed: number; errors: string[] } | { error: string }> {
  const r = await fn("run", { id });
  return r?.error ? { error: String(r.error) } : { sent: Number(r.sent) || 0, failed: Number(r.failed) || 0, errors: r.errors ?? [] };
}
export async function testFlow(flowId: string): Promise<{ ok: boolean; error: string | null; to?: string; number?: string }> {
  const r = await fn("test", { flowId });
  return { ok: !!r?.ok, error: r?.ok ? null : String(r?.error ?? "Couldn't send the test."), to: r?.to, number: r?.number };
}
