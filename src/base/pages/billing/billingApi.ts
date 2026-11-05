/* =====================================================================
   BASE · Billing — invoices with lines, and the work / shipments logged in
   the calendar that haven't been billed yet (103_base_billing.sql).
   A Base invoice belongs to a client (project_id null, period "YYYY-MM").
   ===================================================================== */
import { supabase } from "../../../components/api/supabase";

export type InvStatus = "draft" | "sent" | "paid" | "void";
/** What the list shows: a sent invoice is "unpaid", or "overdue" once its due date has gone. */
export type InvState = "draft" | "unpaid" | "overdue" | "paid" | "void";

export interface BillTo { name: string; legal_name?: string; vat?: string; address?: string; email?: string; contact?: string }

export interface InvLine {
  key: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  product_id?: string | null;
  service_id?: string | null;
  user_id?: string | null;
}

export interface Invoice {
  id: string;
  number: string;
  client_id: string | null;
  company_id: string | null;
  status: InvStatus;
  issue_date: string;
  due_date: string | null;
  sent_date: string | null;
  paid_date: string | null;
  net: number;
  amount: number;
  tax_rate: number;
  notes: string;
  bill_to: BillTo;
  created_at: string;
}

/** A new invoice being written (not saved yet), or a saved one opened. */
export interface Draft {
  id: string | null;
  number: string;
  client_id: string;
  status: InvStatus;
  issue_date: string;
  payment_days: number;
  tax_rate: number;
  notes: string;
  bill_to: BillTo;
  lines: InvLine[];
  /** Calendar entries this invoice bills (they're marked with it on save). */
  entry_ids: string[];
  sent_date: string | null;
  paid_date: string | null;
}

export interface BClient {
  id: string; name: string; company_id: string | null; legal_name: string; vat: string; address: string;
  payment_days: number; tax_rate: number; price_per_day: number; team: { userId: string; name?: string }[];
  email: string; contact: string;
}
export interface Person { id: string; name: string; active: boolean }
export interface CatItem { key: string; kind: "product" | "service"; id: string; name: string; label: string; price: number; unit: string; recurring: boolean }

export interface WorkEntry {
  id: string; user_id: string; date: string; start_min: number; end_min: number; hours: number;
  client_id: string; notes: string; kind: "client_work" | "shipment"; product_id: string | null;
  quantity: number; unit_price: number; name: string; invoice_id: string | null;
}

export const UNITS = [
  { value: "", label: "—" }, { value: "h", label: "hours" }, { value: "day", label: "days" },
  { value: "unit", label: "units" }, { value: "month", label: "months" }, { value: "year", label: "years" },
];

/* ------------------------------ helpers ------------------------------ */
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const todayIso = () => iso(new Date());
export const addDays = (s: string, n: number) => { const [y, m, d] = s.split("-").map(Number); return iso(new Date(y, m - 1, d + n)); };
export const daysBetween = (a: string, b: string) => {
  const [y1, m1, d1] = a.split("-").map(Number); const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
};
export const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
export const lineAmount = (l: Pick<InvLine, "quantity" | "unit_price">) => round2((Number(l.quantity) || 0) * (Number(l.unit_price) || 0));
export const totalsOf = (lines: InvLine[], taxRate: number) => {
  const net = round2(lines.reduce((s, l) => s + lineAmount(l), 0));
  const tax = round2(net * (Number(taxRate) || 0) / 100);
  return { net, tax, total: round2(net + tax) };
};
const eur = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 2, minimumFractionDigits: 2 });
const eur0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
export const money = (n: number) => eur.format(Number(n) || 0);
export const money0 = (n: number) => eur0.format(Number(n) || 0);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDate = (s: string | null | undefined) => {
  if (!s) return "—";
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return `${d} ${MON[m - 1]} ${y}`;
};
export const fmtShort = (s: string) => { const [, m, d] = s.slice(0, 10).split("-").map(Number); return `${d} ${MON[m - 1]}`; };
export const hrs = (n: number) => `${round2(n).toLocaleString("en-GB", { maximumFractionDigits: 2 })} h`;
export const newKey = () => Math.random().toString(36).slice(2, 10);

export function stateOf(inv: Pick<Invoice, "status" | "due_date">, today = todayIso()): InvState {
  if (inv.status === "sent") return inv.due_date && inv.due_date < today ? "overdue" : "unpaid";
  return inv.status;
}
export const STATE_LABEL: Record<InvState, string> = { draft: "Draft", unpaid: "Unpaid", overdue: "Overdue", paid: "Paid", void: "Void" };

const addrOf = (a: any): string => {
  if (!a) return "";
  if (typeof a === "string") return a;
  return [[a.street, a.number ?? a.addr_number].filter(Boolean).join(" "), [a.postal_code ?? a.zip, a.city].filter(Boolean).join(" "), a.country]
    .filter(Boolean).join(", ");
};

/* ------------------------------ loading ------------------------------ */
export async function loadPeople(): Promise<Person[]> {
  const { data } = await supabase.from("profiles").select("id, first_name, last_name, username, active");
  return ((data ?? []) as any[]).map((p) => ({
    id: p.id,
    name: [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || p.username || "Someone",
    active: p.active !== false,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadClients(): Promise<BClient[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from("clients")
      .select("id, name, legal_name, vat_number, address, payment_days, taxed, tax_rate, price_per_day, team, company_id, contacts, status")
      .order("name").range(from, from + 999);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const coIds = Array.from(new Set(out.map((c) => c.company_id).filter(Boolean)));
  const cos: Record<string, any> = {};
  for (let i = 0; i < coIds.length; i += 200) {
    const { data } = await supabase.from("companies")
      .select("id, legal_name, vat_number, street, addr_number, postal_code, city, country, email").in("id", coIds.slice(i, i + 200));
    (data ?? []).forEach((c: any) => { cos[c.id] = c; });
  }
  return out.map((c) => {
    const co = c.company_id ? cos[c.company_id] : null;
    const contacts = Array.isArray(c.contacts) ? c.contacts : [];
    const billing = contacts.find((x: any) => x?.billing) ?? contacts[0] ?? null;
    return {
      id: c.id, name: c.name ?? "—", company_id: c.company_id ?? null,
      legal_name: c.legal_name || co?.legal_name || c.name || "",
      vat: c.vat_number || co?.vat_number || "",
      address: addrOf(c.address) || (co ? addrOf({ street: co.street, number: co.addr_number, postal_code: co.postal_code, city: co.city, country: co.country }) : ""),
      payment_days: Number(c.payment_days) || 30,
      tax_rate: c.taxed === false ? 0 : c.tax_rate != null ? Number(c.tax_rate) : 21,
      price_per_day: Number(c.price_per_day) || 0,
      team: Array.isArray(c.team) ? c.team.filter((m: any) => m?.userId) : [],
      email: billing?.email || co?.email || "",
      contact: billing?.name || [billing?.first_name, billing?.last_name].filter(Boolean).join(" ") || "",
    };
  });
}

export async function loadCatalog(): Promise<CatItem[]> {
  const [{ data: ps }, { data: ts }, { data: ss }] = await Promise.all([
    supabase.from("products").select("id, name, billing, billing_period, active").order("name"),
    supabase.from("product_tiers").select("id, product_id, name, price, sort").order("sort"),
    supabase.from("services").select("id, name, billing, price, rate_unit, active").order("name"),
  ]);
  const out: CatItem[] = [];
  ((ps ?? []) as any[]).filter((p) => p.active !== false).forEach((p) => {
    const tiers = ((ts ?? []) as any[]).filter((t) => t.product_id === p.id);
    const recurring = p.billing !== "one_time";
    const unit = recurring ? (p.billing_period === "monthly" ? "month" : "year") : "unit";
    if (!tiers.length) out.push({ key: `p${p.id}`, kind: "product", id: p.id, name: p.name, label: p.name, price: 0, unit, recurring });
    tiers.forEach((t) => out.push({
      key: `p${p.id}:${t.id}`, kind: "product", id: p.id, name: p.name,
      label: tiers.length > 1 || (t.name && t.name !== "Standard") ? `${p.name} · ${t.name}` : p.name,
      price: Number(t.price) || 0, unit, recurring,
    }));
  });
  ((ss ?? []) as any[]).filter((s) => s.active !== false).forEach((s) => {
    const unit = s.billing === "hourly" ? "h" : s.billing === "daily" ? "day" : s.billing === "monthly" ? "month" : "unit";
    out.push({ key: `s${s.id}`, kind: "service", id: s.id, name: s.name, label: s.name, price: Number(s.price) || 0, unit, recurring: s.billing === "monthly" });
  });
  return out;
}

/** What an hour of work is billed at: the client's day rate, else the hourly / daily service, ÷ 8. */
export function hourlyRate(client: BClient | undefined, catalog: CatItem[]): number {
  if (client?.price_per_day) return round2(client.price_per_day / 8);
  const h = catalog.find((c) => c.kind === "service" && c.unit === "h" && c.price > 0);
  if (h) return h.price;
  const d = catalog.find((c) => c.kind === "service" && c.unit === "day" && c.price > 0);
  return d ? round2(d.price / 8) : 0;
}

const toInvoice = (r: any): Invoice => ({
  id: r.id, number: r.number ?? "", client_id: r.client_id ?? null, company_id: r.company_id ?? null,
  status: r.status, issue_date: r.issue_date ?? String(r.created_at).slice(0, 10), due_date: r.due_date ?? null,
  sent_date: r.sent_date ?? null, paid_date: r.paid_date ?? null, net: Number(r.net) || 0, amount: Number(r.amount) || 0,
  tax_rate: Number(r.tax_rate) || 0, notes: r.notes ?? "", bill_to: r.bill_to ?? {}, created_at: r.created_at,
});

export async function loadInvoices(): Promise<Invoice[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("invoices")
      .select("id, number, client_id, company_id, status, issue_date, due_date, sent_date, paid_date, net, amount, tax_rate, notes, bill_to, created_at")
      .is("project_id", null).order("issue_date", { ascending: false }).order("number", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out.map(toInvoice);
}

export async function loadLines(invoiceId: string): Promise<{ lines: InvLine[]; entryIds: string[] }> {
  const [{ data: ls }, { data: es }] = await Promise.all([
    supabase.from("invoice_lines").select("*").eq("invoice_id", invoiceId).order("sort"),
    supabase.from("calendar_entries").select("id").eq("invoice_id", invoiceId),
  ]);
  return {
    lines: ((ls ?? []) as any[]).map((l) => ({
      key: l.id, description: l.description ?? "", quantity: Number(l.quantity) || 0, unit: l.unit ?? "",
      unit_price: Number(l.unit_price) || 0, product_id: l.product_id, service_id: l.service_id, user_id: l.user_id,
    })),
    entryIds: ((es ?? []) as any[]).map((e) => e.id),
  };
}

/** The next number of the year: 2026-0001, 2026-0002… */
export async function nextNumber(year = new Date().getFullYear()): Promise<string> {
  const { data } = await supabase.from("invoices").select("number").is("project_id", null).like("number", `${year}-%`);
  const max = ((data ?? []) as any[]).reduce((m, r) => Math.max(m, Number(String(r.number).split("-")[1]) || 0), 0);
  return `${year}-${String(max + 1).padStart(4, "0")}`;
}

/** Writes the invoice, replaces its lines and marks the calendar entries it bills. Returns its id. */
export async function saveInvoice(d: Draft): Promise<string> {
  const { net, total } = totalsOf(d.lines, d.tax_rate);
  const row: Record<string, unknown> = {
    number: d.number, client_id: d.client_id || null, status: d.status, issue_date: d.issue_date,
    due_date: addDays(d.issue_date, d.payment_days), sent_date: d.sent_date, paid_date: d.paid_date,
    net, amount: total, days: 0, tax_rate: d.tax_rate, notes: d.notes || null, bill_to: d.bill_to,
    period: d.issue_date.slice(0, 7),
  };
  let id = d.id;
  if (id) {
    const { error } = await supabase.from("invoices").update(row).eq("id", id);
    if (error) throw new Error(error.message);
  } else {
    const { data, error } = await supabase.from("invoices").insert(row).select("id").single();
    if (error) throw new Error(error.message);
    id = (data as any).id as string;
  }
  const { error: de } = await supabase.from("invoice_lines").delete().eq("invoice_id", id);
  if (de) throw new Error(de.message);
  const lines = d.lines.filter((l) => l.description.trim() || l.unit_price || l.quantity);
  if (lines.length) {
    const { error } = await supabase.from("invoice_lines").insert(lines.map((l, i) => ({
      invoice_id: id, sort: i, description: l.description.trim(), quantity: Number(l.quantity) || 0, unit: l.unit || "",
      unit_price: Number(l.unit_price) || 0, product_id: l.product_id || null, service_id: l.service_id || null, user_id: l.user_id || null,
    })));
    if (error) throw new Error(error.message);
  }
  // entries: the ones it bills point at it; any it no longer bills are let go
  await supabase.from("calendar_entries").update({ invoice_id: null }).eq("invoice_id", id)
    .not("id", "in", `(${d.entry_ids.length ? d.entry_ids.join(",") : "00000000-0000-0000-0000-000000000000"})`);
  for (let i = 0; i < d.entry_ids.length; i += 200) {
    const { error } = await supabase.from("calendar_entries").update({ invoice_id: id }).in("id", d.entry_ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
  return id!;
}

export async function setInvoiceStatus(id: string, status: InvStatus, extra: Record<string, unknown> = {}) {
  const { error } = await supabase.from("invoices").update({ status, ...extra }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Only drafts are deleted; their entries go back to "to bill" (the FK lets go of them). */
export async function deleteInvoice(id: string) {
  await supabase.from("calendar_entries").update({ invoice_id: null }).eq("invoice_id", id);
  const { error } = await supabase.from("invoices").delete().eq("id", id).eq("status", "draft");
  if (error) throw new Error(error.message);
}

const toWork = (r: any): WorkEntry => ({
  id: r.id, user_id: r.user_id, date: r.entry_date ?? "", start_min: Number(r.start_min) || 0, end_min: Number(r.end_min) || 0,
  hours: Number(r.billable) || Math.max(0, ((Number(r.end_min) || 0) - (Number(r.start_min) || 0)) / 60),
  client_id: r.client_id, notes: r.notes ?? "", kind: r.kind, product_id: r.product_id ?? null,
  quantity: Number(r.quantity) || 0, unit_price: Number(r.unit_price) || 0, name: r.name ?? "", invoice_id: r.invoice_id ?? null,
});
const WORK_COLS = "id, user_id, entry_date, start_min, end_min, billable, client_id, notes, kind, product_id, quantity, unit_price, name, invoice_id, status";

/** Work and shipments logged for a client up to today and not billed yet. */
export async function loadUnbilled(): Promise<WorkEntry[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("calendar_entries").select(WORK_COLS)
      .in("kind", ["client_work", "shipment"]).is("invoice_id", null).not("client_id", "is", null)
      .lte("entry_date", todayIso()).neq("status", "cancelled").order("entry_date").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out.map(toWork);
}

/** Every piece of client work and every shipment between two days (billed or not). */
export async function loadWork(from: string, to: string): Promise<WorkEntry[]> {
  const out: any[] = [];
  for (let p = 0; ; p += 1000) {
    const { data, error } = await supabase.from("calendar_entries").select(WORK_COLS)
      .in("kind", ["client_work", "shipment"]).gte("entry_date", from).lte("entry_date", to)
      .neq("status", "cancelled").order("entry_date").range(p, p + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out.map(toWork);
}

/** A draft for a client: its billing details, terms and tax. */
export function draftFor(c: BClient | undefined, number: string): Draft {
  return {
    id: null, number, client_id: c?.id ?? "", status: "draft", issue_date: todayIso(),
    payment_days: c?.payment_days ?? 30, tax_rate: c?.tax_rate ?? 21, notes: "",
    bill_to: c ? billToOf(c) : { name: "" }, lines: [], entry_ids: [], sent_date: null, paid_date: null,
  };
}
export const billToOf = (c: BClient): BillTo => ({ name: c.name, legal_name: c.legal_name, vat: c.vat, address: c.address, email: c.email, contact: c.contact });

/**
 * Lines for a client's unbilled entries: one line per person for their hours (at the client's
 * rate), one per shipment (at its own price).
 */
export function linesFromWork(entries: WorkEntry[], people: Person[], catalog: CatItem[], rate: number): InvLine[] {
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "Team";
  const work = entries.filter((e) => e.kind === "client_work");
  const ships = entries.filter((e) => e.kind === "shipment");
  const byUser = new Map<string, WorkEntry[]>();
  work.forEach((e) => byUser.set(e.user_id, [...(byUser.get(e.user_id) ?? []), e]));
  const out: InvLine[] = [];
  byUser.forEach((list, uid) => {
    const h = round2(list.reduce((s, e) => s + e.hours, 0));
    const ds = list.map((e) => e.date).sort();
    const span = ds[0] === ds[ds.length - 1] ? fmtShort(ds[0]) : `${fmtShort(ds[0])} – ${fmtShort(ds[ds.length - 1])}`;
    out.push({ key: newKey(), description: `Work · ${nameOf(uid)} (${span})`, quantity: h, unit: "h", unit_price: rate, user_id: uid });
  });
  ships.forEach((e) => {
    const p = catalog.find((c) => c.kind === "product" && c.id === e.product_id);
    out.push({
      key: newKey(), description: `${e.name || p?.name || "Shipment"} · shipped ${fmtShort(e.date)}`,
      quantity: e.quantity || 1, unit: "unit", unit_price: e.unit_price || p?.price || 0, product_id: e.product_id,
    });
  });
  return out;
}

/** The invoice as a printable page (its own window: print, or save as PDF). */
export function printInvoice(d: Draft, seller: string) {
  const { net, tax, total } = totalsOf(d.lines, d.tax_rate);
  const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const unitL = (u: string) => UNITS.find((x) => x.value === u)?.label ?? u;
  const rows = d.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="n">${round2(l.quantity)} ${esc(l.unit ? unitL(l.unit) : "")}</td><td class="n">${money(l.unit_price)}</td><td class="n">${money(lineAmount(l))}</td></tr>`).join("");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice ${esc(d.number)}</title>
<style>
body{font-family:Inter,system-ui,sans-serif;color:#0b241a;margin:48px;font-size:13px}
h1{font-size:30px;margin:0;letter-spacing:-.02em}.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:36px}
.muted{color:#5a7d6d}.box{display:flex;gap:60px;margin-bottom:30px}.box b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5a7d6d;margin-bottom:6px}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#5a7d6d;border-bottom:2px solid #0a6f4d;padding:8px 6px}
td{padding:10px 6px;border-bottom:1px solid #e3ece7}.n{text-align:right;white-space:nowrap}
.tot{margin-left:auto;width:280px;margin-top:20px}.tot div{display:flex;justify-content:space-between;padding:5px 0}.tot .g{font-size:17px;font-weight:700;border-top:2px solid #0a6f4d;padding-top:10px;margin-top:4px}
.notes{margin-top:36px;white-space:pre-wrap}
</style></head><body>
<div class="top"><div><h1>Invoice</h1><div class="muted">${esc(d.number)}</div></div><div style="text-align:right"><strong>${esc(seller)}</strong></div></div>
<div class="box"><div><b>Bill to</b>${esc(d.bill_to.legal_name || d.bill_to.name)}<br>${d.bill_to.vat ? `VAT ${esc(d.bill_to.vat)}<br>` : ""}${esc(d.bill_to.address || "")}</div>
<div><b>Issued</b>${fmtDate(d.issue_date)}</div><div><b>Due</b>${fmtDate(addDays(d.issue_date, d.payment_days))}</div></div>
<table><thead><tr><th>Description</th><th class="n">Quantity</th><th class="n">Price</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<div class="tot"><div><span>Net</span><span>${money(net)}</span></div><div><span>Tax ${round2(d.tax_rate)}%</span><span>${money(tax)}</span></div><div class="g"><span>Total</span><span>${money(total)}</span></div></div>
${d.notes ? `<div class="notes">${esc(d.notes)}</div>` : ""}
<script>window.onload=()=>setTimeout(()=>window.print(),150)</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open(); w.document.write(html); w.document.close();
  return true;
}

/** A mail to the client's billing contact, ready to send (attach the PDF). */
export function mailInvoice(d: Draft, seller: string) {
  const { total } = totalsOf(d.lines, d.tax_rate);
  const due = fmtDate(addDays(d.issue_date, d.payment_days));
  const subject = `Invoice ${d.number} from ${seller}`;
  const body = `Hello${d.bill_to.contact ? ` ${d.bill_to.contact.split(" ")[0]}` : ""},\n\nPlease find attached invoice ${d.number} for ${money(total)}, due on ${due}.\n\nThank you,\n${seller}`;
  window.location.href = `mailto:${encodeURIComponent(d.bill_to.email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** The company sending the invoices (the tenant's name). */
export async function loadSeller(): Promise<string> {
  const { data } = await supabase.from("tenants").select("name").limit(1).maybeSingle();
  return (data as any)?.name ?? "";
}

/* ------------------------- automatic invoices (104) ------------------------- */
export interface AutoSettings { auto_invoice: boolean; cutoff_day: number; auto_send: boolean; enabled_on: string | null }
export interface BillingRun { id: string; cutoff: string; auto: boolean; invoices: number; net: number; created_at: string }
export const AUTO_DEFAULT: AutoSettings = { auto_invoice: false, cutoff_day: 0, auto_send: false, enabled_on: null };

/** The cutoff in the month of a day: its last day (0) or that day. */
export function cutoffOf(day: string, cutoffDay: number): string {
  const [y, m] = day.split("-").map(Number);
  return cutoffDay > 0 ? iso(new Date(y, m - 1, Math.min(cutoffDay, 28))) : iso(new Date(y, m, 0));
}
/** The next cutoff from today on (today included) — its invoices are made the day after. */
export function nextCutoff(cutoffDay: number, today = todayIso()): string {
  const c = cutoffOf(today, cutoffDay);
  if (c >= today) return c;
  const [y, m] = today.split("-").map(Number);
  return cutoffOf(iso(new Date(y, m, 1)), cutoffDay);
}
/** The last cutoff that's already over (before today). */
export function lastCutoff(cutoffDay: number, today = todayIso()): string {
  const c = cutoffOf(today, cutoffDay);
  if (c < today) return c;
  const [y, m] = today.split("-").map(Number);
  return cutoffOf(iso(new Date(y, m - 2, 1)), cutoffDay);
}

export async function loadAutoSettings(): Promise<AutoSettings | null> {
  const { data, error } = await supabase.from("base_billing_settings").select("auto_invoice, cutoff_day, auto_send, enabled_on").maybeSingle();
  if (error) return null; // 104 not run yet
  return data ? { ...AUTO_DEFAULT, ...(data as any) } : { ...AUTO_DEFAULT };
}
export async function saveAutoSettings(s: AutoSettings, was: AutoSettings): Promise<AutoSettings> {
  const next = { ...s, enabled_on: s.auto_invoice ? (was.auto_invoice ? was.enabled_on ?? todayIso() : todayIso()) : null };
  const { data: me } = await supabase.auth.getUser();
  const { data: prof } = await supabase.from("profiles").select("tenant_id").eq("id", me?.user?.id ?? "").maybeSingle();
  const { error } = await supabase.from("base_billing_settings").upsert({ tenant_id: (prof as any)?.tenant_id, ...next, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  return next;
}
export async function loadRuns(): Promise<BillingRun[]> {
  const { data } = await supabase.from("base_billing_runs").select("id, cutoff, auto, invoices, net, created_at").order("created_at", { ascending: false }).limit(12);
  return ((data ?? []) as any[]).map((r) => ({ ...r, invoices: Number(r.invoices) || 0, net: Number(r.net) || 0 }));
}
/** Makes the invoices for everything unbilled up to a day (one per client). */
export async function billNow(cutoff: string, send: boolean): Promise<{ invoices: number; net: number }> {
  const { data, error } = await supabase.rpc("base_bill_now", { p_cutoff: cutoff, p_send: send });
  if (error) throw new Error(error.message);
  const r = (Array.isArray(data) ? data[0] : data) as any;
  return { invoices: Number(r?.n_invoices) || 0, net: Number(r?.total_net) || 0 };
}
/** Runs a cutoff that's due and wasn't billed yet (the daily job does the same). */
export async function autoTick(): Promise<number> {
  const { data, error } = await supabase.rpc("base_billing_tick");
  return error ? 0 : Number(data) || 0;
}
