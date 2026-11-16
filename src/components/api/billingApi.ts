import { supabase } from "./supabase";

/* =====================================================================
   A customer company's billing with Next — one record, two sides.
   • tenant_billing_entities (SQL 137): who the company is billed as.
   • tenant_subscription_invoices (SQL 137): what Next billed it.
   • tenant_billing_events (SQL 138): every change to those, by whom
     (the company = "client", a Next superadmin = "next"), written by
     triggers; tenant_billing_seen: up to when each person has looked.
   The company's owner reads and edits it in Settings › Your account; Next
   in the platform console › a company › Billing. Same rows, so both sides
   always show the same thing, and each side sees what the other changed.
   ===================================================================== */

export interface BillingEntity {
  id: string; tenant_id?: string; legal_name: string; tax_id: string; email: string | null; phone: string | null; street: string | null;
  postal_code: string | null; city: string | null; province: string | null; country: string | null; iban: string | null;
  po_reference: string | null; is_default: boolean; updated_at?: string;
}
export type InvoiceStatus = "pending" | "paid" | "overdue" | "void" | "refunded";
export interface BillingInvoice {
  id: string; tenant_id?: string; entity_id: string | null; number: string; issued_on: string; period_start: string | null; period_end: string | null;
  due_on: string | null; plan: string | null; users: number; price_per_user: number; discount_pct: number; net: number; vat_pct: number; vat: number;
  total: number; currency: string; status: InvoiceStatus; paid_on: string | null; bill_to_name: string | null; bill_to_tax_id: string | null;
  bill_to_address: string | null; lines: { label: string; qty?: number; unit?: number; amount: number }[] | null; pdf_url: string | null; notes: string | null;
}
export type BillingSide = "client" | "next";
export interface BillingEvent {
  id: string; tenant_id: string; side: BillingSide; actor_id: string | null; actor_name: string | null; kind: string;
  ref_id: string | null; label: string | null; fields: string[]; created_at: string;
}
export interface BillingData {
  entities: BillingEntity[]; invoices: BillingInvoice[]; events: BillingEvent[];
  /** when this person last looked at this company's billing (null: never) */
  seenAt: string | null;
  /** SQL 137 isn't in the database yet */
  notReady: boolean;
  /** SQL 138 isn't in the database yet (no change history) */
  noEvents: boolean;
}

export const EMPTY_ENTITY: Omit<BillingEntity, "id"> = {
  legal_name: "", tax_id: "", email: "", phone: "", street: "", postal_code: "", city: "", province: "", country: "Spain", iban: "", po_reference: "", is_default: false,
};
export const INVOICE_STATUS: Record<InvoiceStatus, string> = { pending: "Pending", paid: "Paid", overdue: "Overdue", void: "Void", refunded: "Refunded" };
export const PLAN_NAME: Record<string, string> = { base: "Base", enterprise: "Enterprise" };

const missing = (msg?: string) => !!msg && /tenant_billing|tenant_subscription|does not exist|schema cache|Could not find/i.test(msg);
const num = (v: unknown) => Number(v ?? 0) || 0;
const asInvoice = (r: any): BillingInvoice => ({
  ...r, users: num(r.users), price_per_user: num(r.price_per_user), discount_pct: num(r.discount_pct), net: num(r.net), vat_pct: num(r.vat_pct), vat: num(r.vat), total: num(r.total),
});

async function myId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data?.session?.user?.id ?? null;
}

/** Everything about one company's billing. `tenantId` is required for Next (a superadmin sees every company). */
export async function loadBilling(tenantId: string): Promise<BillingData> {
  const me = await myId();
  const [e, i, ev, sn] = await Promise.all([
    supabase.from("tenant_billing_entities").select("*").eq("tenant_id", tenantId).order("is_default", { ascending: false }).order("created_at"),
    supabase.from("tenant_subscription_invoices").select("*").eq("tenant_id", tenantId).order("issued_on", { ascending: false }),
    supabase.from("tenant_billing_events").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(60),
    me ? supabase.from("tenant_billing_seen").select("seen_at").eq("tenant_id", tenantId).eq("user_id", me).maybeSingle() : Promise.resolve({ data: null, error: null } as any),
  ]);
  const notReady = missing(e.error?.message) || missing(i.error?.message);
  const noEvents = !!ev.error;
  return {
    entities: notReady ? [] : ((e.data ?? []) as BillingEntity[]),
    invoices: notReady ? [] : ((i.data ?? []) as any[]).map(asInvoice),
    events: noEvents ? [] : ((ev.data ?? []) as any[]).map((x) => ({ ...x, fields: x.fields ?? [] })),
    seenAt: (sn as any)?.error ? null : ((sn as any)?.data?.seen_at ?? null),
    notReady, noEvents,
  };
}

/** "I've seen this company's billing up to now." */
export async function markBillingSeen(tenantId: string): Promise<void> {
  const me = await myId();
  if (!me) return;
  await supabase.from("tenant_billing_seen").upsert({ tenant_id: tenantId, user_id: me, seen_at: new Date().toISOString() }, { onConflict: "tenant_id,user_id" });
}

/** Changes made by `side` after `seenAt` — what the other side hasn't looked at yet. */
export const unseenOf = (events: BillingEvent[], side: BillingSide, seenAt: string | null) =>
  events.filter((e) => e.side === side && (!seenAt || e.created_at > seenAt));

/** Next: per company, how many changes the company made that this superadmin hasn't looked at. */
export async function unseenClientChanges(): Promise<Map<string, { n: number; last: string }>> {
  const out = new Map<string, { n: number; last: string }>();
  const me = await myId();
  if (!me) return out;
  const since = new Date(Date.now() - 180 * 864e5).toISOString();
  const [ev, sn] = await Promise.all([
    supabase.from("tenant_billing_events").select("tenant_id, created_at").eq("side", "client").gte("created_at", since).order("created_at", { ascending: false }).limit(1000),
    supabase.from("tenant_billing_seen").select("tenant_id, seen_at").eq("user_id", me),
  ]);
  if (ev.error) return out;
  const seen = new Map(((sn.data ?? []) as any[]).map((r) => [r.tenant_id as string, r.seen_at as string]));
  ((ev.data ?? []) as any[]).forEach((r) => {
    const s = seen.get(r.tenant_id);
    if (s && r.created_at <= s) return;
    const cur = out.get(r.tenant_id);
    out.set(r.tenant_id, { n: (cur?.n ?? 0) + 1, last: cur?.last ?? r.created_at });
  });
  return out;
}

/** The company's owner: changes Next made since they last looked (for a badge outside the page). */
export async function unseenNextChanges(tenantId: string): Promise<number> {
  const me = await myId();
  if (!me) return 0;
  const sn = await supabase.from("tenant_billing_seen").select("seen_at").eq("tenant_id", tenantId).eq("user_id", me).maybeSingle();
  let q = supabase.from("tenant_billing_events").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("side", "next");
  const at = (sn as any)?.data?.seen_at;
  if (at) q = q.gt("created_at", at);
  const r = await q;
  return r.error ? 0 : r.count ?? 0;
}

/* ---------- writing (RLS decides who may) ---------- */
const clean = (s: unknown) => (s ?? "").toString().trim() || null;

export async function saveEntity(edit: Omit<BillingEntity, "id"> & { id?: string }, tenantId: string, isFirst: boolean): Promise<string | null> {
  const row: any = {
    legal_name: edit.legal_name.trim(), tax_id: edit.tax_id.trim().toUpperCase().replace(/\s+/g, ""),
    email: clean(edit.email), phone: clean(edit.phone), street: clean(edit.street), postal_code: clean(edit.postal_code), city: clean(edit.city),
    province: clean(edit.province), country: clean(edit.country), iban: clean(edit.iban)?.toUpperCase().replace(/\s+/g, " ") ?? null,
    po_reference: clean(edit.po_reference), is_default: isFirst ? true : !!edit.is_default,
  };
  const { error } = edit.id
    ? await supabase.from("tenant_billing_entities").update(row).eq("id", edit.id)
    : await supabase.from("tenant_billing_entities").insert({ ...row, tenant_id: tenantId });
  return error ? error.message : null;
}
export async function makeEntityDefault(id: string): Promise<string | null> {
  const { error } = await supabase.from("tenant_billing_entities").update({ is_default: true }).eq("id", id);
  return error ? error.message : null;
}
export async function deleteEntity(id: string): Promise<string | null> {
  const { error } = await supabase.from("tenant_billing_entities").delete().eq("id", id);
  return error ? error.message : null;
}

/** price_per_user is per month: a quarter or a year counts its months */
export const invoiceMonths = (start: string | null, end: string | null) =>
  start && end ? Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 864e5 / 30.44)) : 1;
export function invoiceTotals(v: { users: number; price_per_user: number; discount_pct: number; vat_pct: number; period_start: string | null; period_end: string | null }) {
  const months = invoiceMonths(v.period_start, v.period_end);
  const gross = Math.round(v.users * v.price_per_user * months * 100) / 100;
  const net = Math.round(gross * (1 - (v.discount_pct || 0) / 100) * 100) / 100;
  const vat = Math.round(net * ((v.vat_pct || 0) / 100) * 100) / 100;
  return { months, gross, discount: Math.round((gross - net) * 100) / 100, net, vat, total: Math.round((net + vat) * 100) / 100 };
}
export const entityAddress = (x: Pick<BillingEntity, "street" | "postal_code" | "city" | "province" | "country">) =>
  [x.street, [x.postal_code, x.city].filter(Boolean).join(" "), x.province, x.country].filter(Boolean).join(", ");

export async function saveInvoice(v: Omit<BillingInvoice, "id"> & { id?: string }, tenantId: string): Promise<string | null> {
  const t = invoiceTotals(v);
  const row: any = {
    entity_id: v.entity_id, number: v.number.trim(), issued_on: v.issued_on, period_start: v.period_start || null, period_end: v.period_end || null,
    due_on: v.due_on || null, plan: v.plan, users: v.users, price_per_user: v.price_per_user, discount_pct: v.discount_pct, vat_pct: v.vat_pct,
    net: t.net, vat: t.vat, total: t.total, currency: v.currency || "EUR", status: v.status, paid_on: v.status === "paid" ? (v.paid_on || new Date().toISOString().slice(0, 10)) : v.paid_on || null,
    bill_to_name: v.bill_to_name, bill_to_tax_id: v.bill_to_tax_id, bill_to_address: v.bill_to_address, pdf_url: clean(v.pdf_url), notes: clean(v.notes),
  };
  const { error } = v.id
    ? await supabase.from("tenant_subscription_invoices").update(row).eq("id", v.id)
    : await supabase.from("tenant_subscription_invoices").insert({ ...row, tenant_id: tenantId, lines: [] });
  return error ? error.message : null;
}
export async function setInvoiceStatus(id: string, status: InvoiceStatus): Promise<string | null> {
  const patch: any = { status };
  if (status === "paid") patch.paid_on = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from("tenant_subscription_invoices").update(patch).eq("id", id);
  return error ? error.message : null;
}
export async function deleteInvoice(id: string): Promise<string | null> {
  const { error } = await supabase.from("tenant_subscription_invoices").delete().eq("id", id);
  return error ? error.message : null;
}

/** The next invoice number: NX-<year>-<4 digits>, one past the highest of that year (all companies Next can see). */
export async function nextInvoiceNumber(): Promise<string> {
  const y = new Date().getFullYear();
  const { data } = await supabase.from("tenant_subscription_invoices").select("number").ilike("number", `NX-${y}-%`).order("number", { ascending: false }).limit(1);
  const last = Number(String((data as any)?.[0]?.number ?? "").split("-")[2] ?? 0) || 0;
  return `NX-${y}-${String(last + 1).padStart(4, "0")}`;
}

/** Keep an open page in step: changes from the other side (or another tab) reload it. Returns the stop. */
export function watchBilling(tenantId: string, onChange: () => void): () => void {
  let ch: any = null;
  let t: number | undefined;
  const ping = () => { window.clearTimeout(t); t = window.setTimeout(onChange, 250); };
  try {
    ch = (supabase as any).channel?.(`billing-${tenantId}-${Math.random().toString(36).slice(2, 8)}`);
    ["tenant_billing_events", "tenant_billing_entities", "tenant_subscription_invoices"].forEach((table) => {
      ch?.on?.("postgres_changes", { event: "*", schema: "public", table, filter: `tenant_id=eq.${tenantId}` }, ping);
    });
    ch?.subscribe?.();
  } catch { /* realtime off: focus + interval still refresh */ }
  const onFocus = () => ping();
  window.addEventListener("focus", onFocus);
  const iv = window.setInterval(ping, 120_000);
  return () => {
    window.clearTimeout(t); window.clearInterval(iv); window.removeEventListener("focus", onFocus);
    try { if (ch) (supabase as any).removeChannel?.(ch); } catch { /* ignore */ }
  };
}

/* ---------- words ---------- */
export const FIELD_LABEL: Record<string, string> = {
  legal_name: "legal name", tax_id: "tax ID", email: "e-mail", phone: "phone", street: "address", postal_code: "postal code", city: "city",
  province: "province", country: "country", iban: "IBAN", po_reference: "PO reference", is_default: "default",
  number: "number", issued_on: "date", period_start: "period", period_end: "period", due_on: "due date", plan: "plan", users: "users",
  price_per_user: "price per user", discount_pct: "discount", net: "net", vat_pct: "VAT", vat: "VAT", total: "total", currency: "currency",
  status: "status", paid_on: "paid date", bill_to_name: "billed to", bill_to_tax_id: "billed to", bill_to_address: "billed to", entity_id: "billed to",
  lines: "lines", pdf_url: "PDF", notes: "notes",
};
/** "changed the IBAN and city" — the fields people care about, said once each. */
export function fieldsText(fields: string[]): string {
  const skip = new Set(["net", "vat", "total"]);
  const words = [...new Set(fields.filter((f) => !skip.has(f) || fields.every((x) => skip.has(x))).map((f) => FIELD_LABEL[f] ?? f.replace(/_/g, " ")))];
  if (!words.length) return "";
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
/** What happened, said from a viewer's side ("You" for their own side). */
export function eventText(e: BillingEvent): { what: string; detail: string } {
  const label = e.label ?? "";
  switch (e.kind) {
    case "entity_added": return { what: `added ${label || "a billing entity"}`, detail: "" };
    case "entity_removed": return { what: `removed ${label || "a billing entity"}`, detail: "" };
    case "entity_default": return { what: `made ${label || "an entity"} the default`, detail: "" };
    case "entity_changed": return { what: `updated ${label || "a billing entity"}`, detail: fieldsText(e.fields) };
    case "invoice_added": return { what: `issued invoice ${label}`, detail: "" };
    case "invoice_removed": return { what: `removed invoice ${label}`, detail: "" };
    case "invoice_changed": return { what: `updated invoice ${label}`, detail: fieldsText(e.fields) };
    default: return { what: "changed the billing", detail: "" };
  }
}
export const billingMoney = (v: number | null | undefined, cur = "EUR") =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: cur || "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v ?? 0));
export const billingDay = (d: string | null | undefined) =>
  d ? new Date(d + (d.length === 10 ? "T12:00:00" : "")).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
export function billingAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
