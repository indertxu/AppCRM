/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabase } from "../../../api/supabase";
import { calcBreakdown, type Calculator, type Product } from "../../settings/catalogApi";

/* =====================================================================
   Contracts (131_contracts.sql)
   • A contract template (Settings › Catalog › Contracts) is a blueprint:
     the lengths it is sold for (each with its discount), how it renews,
     the ways to pay (each with an early-payment discount), how many days
     before it starts / renews it is invoiced, the yearly increments
     (waived or not when paid upfront) and named commercial discounts.
   • A contract on a deal starts from a template and carries products —
     counted at what their calculator gives (no product discounts, term or
     increments: the contract's apply) — or none, just a fee of its own.
   ===================================================================== */

export type TermUnit = "days" | "months" | "years";
export interface Term { value: number; unit: TermUnit }
export type PayKey = "upfront" | "annually" | "semiannually" | "quarterly" | "monthly";
export interface PayOption { key: PayKey; enabled: boolean; discountPct: number }
export interface Duration { id: string; value: number; unit: TermUnit; discountPct: number }
export interface NamedDiscount { id: string; name: string; mode: "pct" | "amount"; value: number; on: boolean }
export interface ContractIncrements { mode: "none" | "pct" | "amount"; value: number; waivedIfUpfront: boolean }

export interface ContractConfig {
  durations: Duration[];
  autoRenew: boolean;
  renew: Term | null;
  noticeDays: number | null;
  payments: PayOption[];
  defaultPayment: PayKey;
  /** The invoice goes out this many days before the contract starts / renews / each paid period starts. */
  prepayDays: number;
  /** …and is due this many days after it goes out. */
  paymentTermsDays: number;
  increments: ContractIncrements;
  /** Commercial discounts: on a template, the ones offered (on = applied by default); on a deal, the ones applied. */
  discounts: NamedDiscount[];
  /** A yearly fee of the contract itself (e.g. a contract with no product). */
  fee: number;
  /** Products it may include (empty: any). */
  productIds: string[];
  /** A grace period: signed on one day, it starts this much later (null: it starts when it's signed). */
  grace: Term | null;
}

export interface ContractTemplate { id?: string; name: string; description?: string | null; active: boolean; in_proposals?: boolean; config: ContractConfig; sort?: number }

export interface ContractItem { id: string; product_id: string; tier_id: string | null; values: Record<string, number>; quantity: number }
export interface DealContractData extends ContractConfig {
  term: Term;
  payment: PayKey;
  /** When it's signed (empty: not yet — dates count from today). */
  signed: string | null;
  /** When it starts, set by hand (empty: signed + grace period). */
  start: string | null;
  items: ContractItem[];
  notes?: string | null;
}
export interface DealContract { id?: string; tracking_id: string; template_id: string | null; name: string; data: DealContractData; total: number; first_year: number; active: boolean }

export const PAY_LABEL: Record<PayKey, string> = { upfront: "Upfront", annually: "Yearly", semiannually: "Every 6 months", quarterly: "Quarterly", monthly: "Monthly" };
export const PAY_KEYS: PayKey[] = ["upfront", "annually", "semiannually", "quarterly", "monthly"];
export const UNIT_LABEL: Record<TermUnit, [string, string]> = { days: ["day", "days"], months: ["month", "months"], years: ["year", "years"] };
export const termLabel = (t: Term | null | undefined) => (t ? `${t.value} ${UNIT_LABEL[t.unit][Number(t.value) === 1 ? 0 : 1]}` : "—");
export const uid = () => Math.random().toString(36).slice(2, 10);

export const defaultContractConfig = (): ContractConfig => ({
  durations: [
    { id: uid(), value: 1, unit: "years", discountPct: 0 },
    { id: uid(), value: 2, unit: "years", discountPct: 5 },
    { id: uid(), value: 3, unit: "years", discountPct: 10 },
  ],
  autoRenew: true, renew: { value: 1, unit: "years" }, noticeDays: 90,
  payments: [
    { key: "upfront", enabled: true, discountPct: 5 },
    { key: "annually", enabled: true, discountPct: 0 },
    { key: "semiannually", enabled: false, discountPct: 0 },
    { key: "quarterly", enabled: false, discountPct: 0 },
    { key: "monthly", enabled: false, discountPct: 0 },
  ],
  defaultPayment: "annually",
  prepayDays: 30, paymentTermsDays: 30,
  increments: { mode: "pct", value: 3, waivedIfUpfront: true },
  discounts: [],
  fee: 0,
  productIds: [],
  grace: null,
});
export const newTemplate = (): ContractTemplate => ({ name: "", description: "", active: true, in_proposals: true, config: defaultContractConfig() });

/** A template's config with every field there (older or partial rows). */
export function normConfig(c: any): ContractConfig {
  const d = defaultContractConfig();
  const pays = PAY_KEYS.map((k) => {
    const p = (Array.isArray(c?.payments) ? c.payments : []).find((x: any) => x?.key === k);
    const dp = d.payments.find((x) => x.key === k)!;
    return p ? { key: k, enabled: !!p.enabled, discountPct: Number(p.discountPct) || 0 } : (Array.isArray(c?.payments) ? { ...dp, enabled: false, discountPct: 0 } : dp);
  });
  return {
    durations: Array.isArray(c?.durations) ? c.durations.map((x: any) => ({ id: x.id || uid(), value: Number(x.value) || 1, unit: (["days", "months", "years"].includes(x.unit) ? x.unit : "years") as TermUnit, discountPct: Number(x.discountPct) || 0 })) : d.durations,
    autoRenew: c?.autoRenew ?? d.autoRenew,
    renew: c?.renew === null ? null : c?.renew ? { value: Number(c.renew.value) || 1, unit: c.renew.unit ?? "years" } : d.renew,
    noticeDays: c?.noticeDays ?? d.noticeDays,
    payments: pays,
    defaultPayment: PAY_KEYS.includes(c?.defaultPayment) ? c.defaultPayment : (pays.find((p) => p.enabled)?.key ?? "annually"),
    prepayDays: c?.prepayDays ?? d.prepayDays,
    paymentTermsDays: c?.paymentTermsDays ?? d.paymentTermsDays,
    increments: { mode: c?.increments?.mode ?? d.increments.mode, value: Number(c?.increments?.value ?? d.increments.value) || 0, waivedIfUpfront: c?.increments?.waivedIfUpfront ?? d.increments.waivedIfUpfront },
    discounts: Array.isArray(c?.discounts) ? c.discounts.map((x: any) => ({ id: x.id || uid(), name: String(x.name ?? ""), mode: x.mode === "amount" ? "amount" : "pct", value: Number(x.value) || 0, on: x.on !== false })) : [],
    fee: Number(c?.fee) || 0,
    productIds: Array.isArray(c?.productIds) ? c.productIds : [],
    grace: c?.grace && Number(c.grace.value) > 0 ? { value: Number(c.grace.value), unit: (["days", "months", "years"].includes(c.grace.unit) ? c.grace.unit : "months") as TermUnit } : null,
  };
}

/** A contract for a deal, from a template (or blank). */
export function contractFromTemplate(t: ContractTemplate | null, trackingId: string): DealContract {
  const c = normConfig(t?.config);
  const first = c.durations[0];
  return {
    tracking_id: trackingId, template_id: t?.id ?? null, name: t?.name || "Contract", active: true, total: 0, first_year: 0,
    data: { ...c, term: first ? { value: first.value, unit: first.unit } : { value: 1, unit: "years" }, payment: c.payments.find((p) => p.key === c.defaultPayment && p.enabled) ? c.defaultPayment : (c.payments.find((p) => p.enabled)?.key ?? "annually"), signed: null, start: null, items: [] },
  };
}

/* ------------------------------ the maths ------------------------------ */
const r2 = (n: number) => Math.round(n * 100) / 100;
export const termYears = (t: Term) => (t.unit === "years" ? t.value : t.unit === "months" ? t.value / 12 : t.value / 365);
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
};
export const addTerm = (iso: string, t: Term) => (t.unit === "days" ? addDays(iso, t.value) : addMonths(iso, t.unit === "years" ? t.value * 12 : t.value));
export const isoAddDays = (iso: string, n: number) => addDays(iso, n);
export const daysBetween = (a: string, b: string) => Math.round((+new Date(`${b}T12:00:00Z`) - +new Date(`${a}T12:00:00Z`)) / 864e5);
const todayIso = () => new Date().toISOString().slice(0, 10);

/** Signed → (grace period) → starts. A start set by hand wins over signed + grace. */
export function contractDates(d: Pick<DealContractData, "signed" | "start" | "grace">): { signed: string; start: string; graceDays: number; signedSet: boolean; startSet: boolean } {
  const signed = d.signed || todayIso();
  const start = d.start || (d.grace && Number(d.grace.value) > 0 ? addTerm(signed, d.grace) : signed);
  return { signed, start, graceDays: Math.max(0, daysBetween(signed, start)), signedSet: !!d.signed, startSet: !!d.start };
}

/** What a product in a contract comes to: its calculator's figure (no product discounts), per year when recurring. */
export interface ItemRow { label: string; detail: string; amount: number }
export function itemFigure(it: ContractItem, product: Product | undefined): { amount: number; perYear: number; oneOff: number; detail: string; rows: ItemRow[]; base: number } {
  if (!product) return { amount: 0, perYear: 0, oneOff: 0, detail: "Product removed", rows: [], base: 0 };
  const tier = product.tiers.find((t) => t.id === it.tier_id) ?? product.tiers[0];
  const base = Number(tier?.price) || 0;
  const calc = product.calculator as Calculator | null | undefined;
  let amount: number;
  let rows: ItemRow[] = [];
  if (calc && calc.variables?.length) {
    const b = calcBreakdown(calc, it.values ?? {}, base);
    amount = calc.output_kind === "quantity" ? base * b.gross : b.gross;
    rows = b.rows.map((r) => ({ label: r.label, detail: r.detail, amount: calc.output_kind === "quantity" ? r.amount * base : r.amount }));
  } else {
    const q = Math.max(1, Number(it.quantity) || 1);
    amount = base * q;
    rows = [{ label: tier?.name || "Price", detail: q > 1 ? `${q} × ${base}` : "", amount }];
  }
  const recurring = product.billing === "recurring";
  const monthly = recurring && product.billing_period !== "yearly";
  return {
    amount: r2(amount),
    perYear: recurring ? r2(amount * (monthly ? 12 : 1)) : 0,
    oneOff: recurring ? 0 : r2(amount),
    detail: recurring ? (monthly ? "a month" : "a year") : "once",
    rows, base,
  };
}

export interface ContractYear { year: number; share: number; list: number; increment: number; duration: number; payment: number; commercial: number; net: number }
export interface ContractInvoice { date: string; due: string; amount: number; label: string; /** the paid period it covers */ from: string; to: string }
export interface ContractFigures {
  termYears: number; years: ContractYear[];
  annualList: number; oneOff: number;
  list: number; discount: number; total: number; firstYear: number;
  durationPct: number; paymentPct: number; incrementsWaived: boolean;
  breakdown: { label: string; amount: number }[];
  signed: string; graceDays: number; start: string; end: string; invoices: ContractInvoice[];
  /** Auto-renewal: when it renews, when that's invoiced, and the last day to give notice. */
  renewal: { date: string; invoiceDate: string; due: string; noticeBy: string | null; until: string; amount: number } | null;
}

export function contractFigures(d: DealContractData, products: Product[]): ContractFigures {
  const byId = new Map(products.map((p) => [p.id!, p]));
  let annual = Number(d.fee) || 0, oneOff = 0;
  d.items.forEach((it) => { const f = itemFigure(it, byId.get(it.product_id)); annual += f.perYear; oneOff += f.oneOff; });
  const ty = Math.max(0, termYears(d.term));
  const n = Math.max(1, Math.ceil(ty - 1e-9));
  const durationPct = d.durations.find((x) => x.unit === d.term.unit && Number(x.value) === Number(d.term.value))?.discountPct ?? 0;
  const paymentPct = d.payments.find((p) => p.key === d.payment)?.discountPct ?? 0;
  const waived = d.payment === "upfront" && d.increments.waivedIfUpfront;
  const inc = waived ? { mode: "none" as const, value: 0 } : d.increments;
  const years: ContractYear[] = [];
  let cur = annual;
  for (let i = 0; i < n; i++) {
    if (i > 0) cur = inc.mode === "pct" ? cur * (1 + inc.value / 100) : inc.mode === "amount" ? cur + inc.value : cur;
    const share = i === n - 1 && ty % 1 > 1e-9 ? ty % 1 : (ty < 1 ? ty : 1);
    const flat = annual * share;
    const list = cur * share + (i === 0 ? oneOff : 0);
    const increment = cur * share - flat;
    const dDur = list * (durationPct / 100);
    const dPay = (list - dDur) * (paymentPct / 100);
    let run = list - dDur - dPay, dCom = 0;
    d.discounts.filter((x) => x.on).forEach((x) => {
      const cut = x.mode === "pct" ? run * (x.value / 100) : Math.min(run, x.value * share);
      dCom += cut; run -= cut;
    });
    years.push({ year: i + 1, share, list: r2(list), increment: r2(increment), duration: r2(dDur), payment: r2(dPay), commercial: r2(dCom), net: r2(Math.max(0, run)) });
  }
  const sum = (k: keyof ContractYear) => r2(years.reduce((a, y) => a + (y[k] as number), 0));
  const list = sum("list"), total = sum("net");
  const breakdown = [
    { label: `List price${n > 1 ? ` · ${n} years` : ""}`, amount: r2(list - sum("increment")) },
    ...(sum("increment") ? [{ label: "Yearly increments", amount: sum("increment") }] : []),
    ...(sum("duration") ? [{ label: `${termLabel(d.term)} discount · ${durationPct}%`, amount: -sum("duration") }] : []),
    ...(sum("payment") ? [{ label: `${PAY_LABEL[d.payment]} payment · ${paymentPct}%`, amount: -sum("payment") }] : []),
    ...(sum("commercial") ? [{ label: d.discounts.filter((x) => x.on).map((x) => x.name || "Discount").join(" · "), amount: -sum("commercial") }] : []),
  ];
  // when it's invoiced: N days before each paid period starts
  const dates = contractDates(d);
  const start = dates.start;
  const end = addTerm(start, d.term);
  const invoices: ContractInvoice[] = [];
  const per = d.payment === "monthly" ? 12 : d.payment === "quarterly" ? 4 : d.payment === "semiannually" ? 2 : 1;
  const step = 12 / per;
  const push = (date: string, amount: number, label: string, to: string) => {
    const at = addDays(date, -(Number(d.prepayDays) || 0));
    invoices.push({ date: at, due: addDays(at, Number(d.paymentTermsDays) || 0), amount: r2(amount), label, from: date, to: to > end ? end : to });
  };
  if (d.payment === "upfront") push(start, total, `Whole contract · ${termLabel(d.term)}`, end);
  else years.forEach((y, i) => {
    const yStart = addMonths(start, 12 * i);
    const parts = Math.max(1, Math.round(per * y.share));
    const oneOffNet = i === 0 && oneOff ? oneOff * (y.net / Math.max(1e-9, y.list)) : 0;
    for (let k = 0; k < parts; k++) {
      const amt = (y.net - oneOffNet) / parts + (k === 0 ? oneOffNet : 0);
      push(addMonths(yStart, step * k), amt, per === 1 ? `Year ${y.year}` : `Year ${y.year} · ${k + 1}/${parts}`, addMonths(yStart, step * (k + 1)));
    }
  });
  const lastY = years[years.length - 1];
  const renewInv = addDays(end, -(Number(d.prepayDays) || 0));
  const renewal = d.autoRenew ? {
    date: end, invoiceDate: renewInv, due: addDays(renewInv, Number(d.paymentTermsDays) || 0),
    noticeBy: d.noticeDays ? addDays(end, -Number(d.noticeDays)) : null, until: addTerm(end, d.renew ?? { value: 1, unit: "years" }),
    // a guess: the last year's price, for as long as it renews
    amount: lastY ? r2((lastY.net / Math.max(lastY.share, 1e-9)) * (d.payment === "upfront" ? termYears(d.renew ?? { value: 1, unit: "years" }) : 1 / per)) : 0,
  } : null;
  return {
    termYears: ty, years, annualList: r2(annual), oneOff: r2(oneOff), list, discount: r2(list - total), total, firstYear: years[0]?.net ?? 0,
    durationPct, paymentPct, incrementsWaived: waived && d.increments.mode !== "none" && !!d.increments.value, breakdown, signed: dates.signed, graceDays: dates.graceDays, start, end, invoices, renewal,
  };
}

/* ------------------------------ storage ------------------------------ */
const missing = (m?: string) => !!m && /contract_templates|tracking_contracts|does not exist|schema cache/i.test(m);
export const CONTRACTS_SQL = "Run 131_contracts.sql in Supabase first.";

export async function loadContractTemplates(): Promise<ContractTemplate[]> {
  const { data, error } = await supabase.from("contract_templates").select("*").order("sort").order("created_at");
  if (error) return [];
  return ((data ?? []) as any[]).map((r) => ({ id: r.id, name: r.name, description: r.description, active: r.active !== false, in_proposals: r.in_proposals !== false, sort: r.sort, config: normConfig(r.config) }));
}
export async function saveContractTemplate(t: ContractTemplate): Promise<{ error: string | null; id?: string }> {
  const row = { name: t.name.trim() || "Untitled contract", description: t.description?.trim() || null, active: t.active, in_proposals: t.in_proposals !== false, config: t.config, updated_at: new Date().toISOString() };
  const r = t.id ? await supabase.from("contract_templates").update(row).eq("id", t.id).select("id").single() : await supabase.from("contract_templates").insert(row).select("id").single();
  if (r.error) return { error: missing(r.error.message) ? CONTRACTS_SQL : r.error.message };
  return { error: null, id: (r.data as any)?.id };
}
export async function deleteContractTemplate(id: string): Promise<string | null> {
  const { error } = await supabase.from("contract_templates").delete().eq("id", id);
  return error ? error.message : null;
}

const rowToContract = (r: any): DealContract => ({
    id: r.id, tracking_id: r.tracking_id, template_id: r.template_id, name: r.name, active: r.active !== false,
    total: Number(r.total) || 0, first_year: Number(r.first_year) || 0,
    data: { ...normConfig(r.data), term: r.data?.term ?? { value: 1, unit: "years" }, payment: r.data?.payment ?? "annually", signed: r.data?.signed ?? null, start: r.data?.start ?? null, items: Array.isArray(r.data?.items) ? r.data.items : [], notes: r.data?.notes ?? null },
  });
export async function loadDealContracts(trackingId: string): Promise<DealContract[]> {
  const { data, error } = await supabase.from("tracking_contracts").select("*").eq("tracking_id", trackingId).order("created_at");
  if (error) return [];
  return ((data ?? []) as any[]).map(rowToContract);
}
/** The contracts on several deals (a client's), active ones. */
export async function loadContractsForDeals(trackingIds: string[]): Promise<DealContract[]> {
  const out: DealContract[] = [];
  for (let i = 0; i < trackingIds.length; i += 150) {
    const { data, error } = await supabase.from("tracking_contracts").select("*").in("tracking_id", trackingIds.slice(i, i + 150)).order("created_at");
    if (error) return out;
    out.push(...((data ?? []) as any[]).map(rowToContract));
  }
  return out.filter((c) => c.active !== false);
}
export async function saveDealContract(c: DealContract, products: Product[]): Promise<{ error: string | null; row?: DealContract }> {
  const f = contractFigures(c.data, products);
  const row = { tracking_id: c.tracking_id, template_id: c.template_id, name: c.name.trim() || "Contract", data: c.data, total: f.total, first_year: f.firstYear, active: c.active, updated_at: new Date().toISOString() };
  const r = c.id ? await supabase.from("tracking_contracts").update(row).eq("id", c.id).select("*").single() : await supabase.from("tracking_contracts").insert(row).select("*").single();
  if (r.error) return { error: missing(r.error.message) ? CONTRACTS_SQL : r.error.message };
  return { error: null, row: { ...c, id: (r.data as any).id, total: f.total, first_year: f.firstYear } };
}
export async function deleteDealContract(id: string): Promise<string | null> {
  const { error } = await supabase.from("tracking_contracts").delete().eq("id", id);
  return error ? error.message : null;
}

/** What it comes to for every length × every way to pay (the template's offer), to compare and pick. */
export function pricingMatrix(d: DealContractData, products: Product[]): { durations: Term[]; payments: PayKey[]; cells: Record<string, { total: number; firstYear: number; perYear: number }> } {
  const durations: Term[] = d.durations.length ? d.durations.map((x) => ({ value: x.value, unit: x.unit })) : [d.term];
  if (!durations.some((t) => t.unit === d.term.unit && Number(t.value) === Number(d.term.value))) durations.push(d.term);
  durations.sort((a, b) => termYears(a) - termYears(b));
  const payments = d.payments.filter((p) => p.enabled).map((p) => p.key);
  const cells: Record<string, { total: number; firstYear: number; perYear: number }> = {};
  durations.forEach((t) => payments.forEach((p) => {
    const f = contractFigures({ ...d, term: t, payment: p }, products);
    cells[`${t.value}${t.unit}|${p}`] = { total: f.total, firstYear: f.firstYear, perYear: f.termYears ? f.total / Math.max(f.termYears, 1e-9) : f.total };
  }));
  return { durations, payments, cells };
}
export const termKey = (t: Term) => `${t.value}${t.unit}`;
