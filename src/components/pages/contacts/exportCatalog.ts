/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Everything a contact export can filter on or put in a column — built from the
 * data itself, so nothing has to be added by hand:
 *
 *  • every column of the contacts, companies and deals tables (a column added to
 *    the database tomorrow shows up automatically, with its type inferred)
 *  • every custom field (from its definition) and any custom value without one
 *  • columns that point at something (…_id / …_by) shown as names
 *  • the relationships around a contact: client status, assignees, deal owner and
 *    team, every product of a deal, the real deal total, phase history, counts
 *
 * Contact fields look at the contact; company fields at each of its companies;
 * deal fields at each of its deals.
 */

export type Kind = "text" | "number" | "date" | "bool" | "enum";
export type Src = "contact" | "company" | "deal";
export interface Ctx { c: any; cos: any[]; deals: any[] }
export interface XF {
  key: string;
  src: Src;
  label: string;
  kind: Kind;
  options?: { value: string; label: string }[];
  /** All values for a contact: one for contact fields, one per company/deal otherwise. */
  get: (x: Ctx) => any[];
  /** True when the field is about one company/deal at a time ("same deal" logic applies). */
  perEntity: boolean;
  money?: boolean;
  noColumn?: boolean;
  /** Discovered automatically from the data (not one of the built-in fields). */
  auto?: boolean;
}
interface Def { id: string; label: string; type: string; options: string[] }
export interface CatalogInput {
  contacts: any[]; companies: any[]; deals: any[];
  contactFields: Def[]; companyFields: Def[];
  /** Custom deal fields (Sales → Deal fields). Without them deal custom values still show, with a generic name. */
  dealFields?: Def[];
  people: Record<string, string>; pipelines: Record<string, string>;
  phases: Record<string, { name: string; pipeline: string }>; products: Record<string, string>;
  clientCompanyIds: Set<string>; clientContactIds: Set<string>;
  contactAssignees: Record<string, string[]>; companyAssignees: Record<string, string[]>;
  owners: Record<string, string>; team: Record<string, string[]>;
  dealProducts: Record<string, string[]>; dealTotals: Record<string, number>;
  phaseHistory: Record<string, string[]>;
  dealsByCompany: Record<string, any[]>;
  shownIds?: string[];
  /** Import batch id → "file · date · person". */
  imports?: Record<string, string>;
}

const SKIP = new Set(["id", "tenant_id", "companyIds", "contactIds", "custom"]);
const LABEL: Record<string, string> = {
  first_name: "First name", last_name: "Last name", position: "Position", email: "Email", phone: "Phone", is_billing: "Billing contact",
  notes: "Notes", created_at: "Created", updated_at: "Last updated", created_by: "Created by", name: "Name", legal_name: "Legal name",
  vat_number: "VAT / tax ID", reg_number: "Registration number", website: "Website", street: "Street", addr_number: "Street number",
  addr_details: "Address details", postal_code: "Postal code", city: "City", province: "Province / state", country: "Country",
  company_id: "Deal company", pipeline_id: "Pipeline", product_id: "Main product", current_phase_id: "Current phase", status: "Status",
  product_price: "Main product price", rep_close_prob: "Close probability · sales (%)", mgr_close_prob: "Close probability · management (%)",
  rep_close_date: "Close date · sales", mgr_close_date: "Close date · management", loss_reason: "Loss reason", loss_details: "Loss details",
  imported_by: "Imported by", imported_at: "Imported on", import_batch_id: "Import",
};
const STATUS: Record<string, string> = { active: "Active", won: "Won", lost: "Lost", paused: "On hold" };
const TEXTISH = /phone|vat|postal|zip|iban|reg_number|tax|cif|nif|code|number$/i;
/** Columns we know are free text / known to be a short list, whatever the data looks like. */
const FORCE_TEXT = new Set(["first_name", "last_name", "email", "phone", "position", "notes", "name", "legal_name", "vat_number", "reg_number",
  "website", "street", "addr_number", "addr_details", "postal_code", "loss_details"]);
const FORCE_ENUM = new Set(["city", "province", "country", "status", "loss_reason"]);
const EMAIL_OR_URL = /^[^\s@]+@[^\s@]+\.[^\s@]+$|^(https?:\/\/|www\.)|^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$|^in\//i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
export const isEmpty = (v: any) => v == null || v === "" || (Array.isArray(v) && !v.length);
export const prettify = (k: string) => {
  const s = k.replace(/_(id|by)$/i, (m) => (m.toLowerCase() === "_by" ? " by" : "")).replace(/[_.]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const fullName = (c: any) => [c?.first_name, c?.last_name].filter(Boolean).join(" ");
const sortOpts = (o: { value: string; label: string }[]) => o.sort((a, b) => a.label.localeCompare(b.label));
const customKind = (t: string): Kind => (t === "select" ? "enum" : t === "boolean" ? "bool" : t === "number" ? "number" : t === "date" ? "date" : "text");

/** Guess what kind of values a column holds. */
function infer(key: string, values: any[], idMaps: { name: string; map: Record<string, string> }[]): { kind: Kind; options?: { value: string; label: string }[]; idMap?: Record<string, string> } {
  const vals = values.filter((v) => !isEmpty(v));
  if (!vals.length) return { kind: "text" };
  if (vals.every((v) => typeof v === "boolean")) return { kind: "bool" };
  const flat = vals.flatMap((v) => (Array.isArray(v) ? v : [v]));
  // references to other records → names
  if (/(_id|_by|_ids)$/i.test(key) || flat.every((v) => typeof v === "string" && /^[0-9a-f-]{32,36}$/i.test(v))) {
    for (const m of idMaps) {
      const hits = flat.filter((v) => m.map[String(v)] != null).length;
      if (hits && hits >= flat.length * 0.6) {
        return { kind: "enum", idMap: m.map, options: sortOpts([...new Set(flat.map(String))].map((v) => ({ value: v, label: m.map[v] ?? v }))) };
      }
    }
  }
  if (flat.every((v) => typeof v === "string" && ISO_DATE.test(v))) return { kind: "date" };
  if (FORCE_TEXT.has(key)) return { kind: "text" };
  if (!TEXTISH.test(key) && flat.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))))) return { kind: "number" };
  const distinct = [...new Set(flat.map((v) => String(v)))];
  const asOptions = () => ({ kind: "enum" as Kind, options: sortOpts(distinct.map((d) => ({ value: d, label: key === "status" ? STATUS[d] ?? d : d }))) });
  if (FORCE_ENUM.has(key)) return asOptions();
  if (flat.some((v) => typeof v === "string" && EMAIL_OR_URL.test(v.trim()))) return { kind: "text" };
  // a short list only when values repeat (on average twice or more)
  if (distinct.length <= 30 && flat.length >= distinct.length * 2 && distinct.every((d) => d.length <= 60)) return asOptions();
  return { kind: "text" };
}

export function buildCatalog(inp: CatalogInput): XF[] {
  const out: XF[] = [];
  const companyNames: Record<string, string> = Object.fromEntries(inp.companies.map((c) => [c.id, c.name]));
  const contactNames: Record<string, string> = Object.fromEntries(inp.contacts.map((c) => [c.id, fullName(c)]));
  const phaseNames: Record<string, string> = Object.fromEntries(Object.entries(inp.phases).map(([id, p]) => [id, p.pipeline ? `${p.pipeline} · ${p.name}` : p.name]));
  const idMaps = [
    { name: "imports", map: inp.imports ?? {} },
    { name: "phases", map: phaseNames }, { name: "pipelines", map: inp.pipelines }, { name: "products", map: inp.products },
    { name: "companies", map: companyNames }, { name: "people", map: inp.people }, { name: "contacts", map: contactNames },
  ];
  const peopleOpts = sortOpts(Object.entries(inp.people).map(([value, label]) => ({ value, label })));
  const entities = (src: Src, x: Ctx) => (src === "contact" ? [x.c] : src === "company" ? x.cos : x.deals);
  const mk = (src: Src, key: string, label: string, kind: Kind, value: (e: any, x: Ctx) => any, extra: Partial<XF> = {}): XF => ({
    key: `${src}:${key}`, src, label, kind, perEntity: src !== "contact",
    get: (x) => entities(src, x).flatMap((e) => { const v = value(e, x); return Array.isArray(v) ? v : [v]; }),
    ...extra,
  });

  /* ---------- built-in relationship fields ---------- */
  out.push(
    mk("contact", "@name", "Full name", "text", (c) => fullName(c)),
    mk("contact", "@domain", "Email domain", "text", (c) => (c.email ?? "").split("@")[1] ?? ""),
    mk("contact", "@client", "Is a client contact", "bool", (c) => inp.clientContactIds.has(c.id)),
    mk("contact", "@assigned", "Assigned to", "enum", (c) => inp.contactAssignees[c.id] ?? [], { options: peopleOpts }),
    mk("contact", "@ncompanies", "Number of companies", "number", (c) => (c.companyIds ?? []).length),
    mk("contact", "@ndeals", "Number of deals", "number", (_c, x) => x.deals.length),
  );
  if (inp.shownIds) { const shown = new Set(inp.shownIds); out.push(mk("contact", "@onscreen", "On screen right now", "bool", (c) => shown.has(c.id), { noColumn: true })); }
  out.push(
    mk("company", "@which", "Company", "enum", (co) => co.id, { options: sortOpts(inp.companies.map((c) => ({ value: c.id, label: c.name }))) }),
    { key: "company:@has", src: "company", label: "Has a company", kind: "bool", perEntity: false, get: (x) => [x.cos.length > 0], noColumn: true },
    mk("company", "@client", "Is a client", "bool", (co) => inp.clientCompanyIds.has(co.id)),
    mk("company", "@hasdeal", "Has a deal", "bool", (co) => (inp.dealsByCompany[co.id] ?? []).length > 0),
    mk("company", "@opendeal", "Has an open deal", "bool", (co) => (inp.dealsByCompany[co.id] ?? []).some((d) => d.status === "active")),
    mk("company", "@assigned", "Assigned to", "enum", (co) => inp.companyAssignees[co.id] ?? [], { options: peopleOpts }),
    { key: "deal:@has", src: "deal", label: "Is in a deal", kind: "bool", perEntity: false, get: (x) => [x.deals.length > 0], noColumn: true },
    { key: "deal:@open", src: "deal", label: "Is in an open deal", kind: "bool", perEntity: false, get: (x) => [x.deals.some((d) => d.status === "active")], noColumn: true },
    mk("deal", "@owner", "Owner", "enum", (d) => inp.owners[d.id] ?? null, { options: peopleOpts }),
    mk("deal", "@team", "Team", "enum", (d) => inp.team[d.id] ?? [], { options: peopleOpts }),
    mk("deal", "@products", "Products", "enum", (d) => [...new Set([...(inp.dealProducts[d.id] ?? []), ...(d.product_id ? [d.product_id] : [])])], { options: sortOpts(Object.entries(inp.products).map(([value, label]) => ({ value, label }))) }),
    mk("deal", "@total", "Value (total if won)", "number", (d) => inp.dealTotals[d.id] ?? (Number(d.product_price) || null), { money: true }),
    mk("deal", "@history", "Has been in phase", "enum", (d) => [...new Set([...(inp.phaseHistory[d.id] ?? []), ...(d.current_phase_id ? [d.current_phase_id] : [])])], { options: sortOpts(Object.entries(phaseNames).map(([value, label]) => ({ value, label }))) }),
  );

  /* ---------- every column of each table, discovered ---------- */
  const discover = (src: Src, rows: any[], defs: Def[] | null) => {
    const keys = new Set<string>();
    rows.forEach((r) => Object.keys(r ?? {}).forEach((k) => keys.add(k)));
    for (const k of [...keys].sort()) {
      if (SKIP.has(k)) continue;
      const values = rows.map((r) => r?.[k]);
      // nested objects (e.g. a jsonb column) → one field per inner key
      const objs = values.filter((v) => v && typeof v === "object" && !Array.isArray(v));
      if (objs.length && objs.length === values.filter((v) => !isEmpty(v)).length) {
        const inner = new Set<string>(); objs.forEach((o) => Object.keys(o).forEach((ik) => inner.add(ik)));
        inner.forEach((ik) => {
          const iv = rows.map((r) => r?.[k]?.[ik]);
          const g = infer(ik, iv, idMaps);
          out.push(mk(src, `${k}.${ik}`, `${prettify(k)} · ${prettify(ik)}`, g.kind, (e) => e?.[k]?.[ik], { options: g.options, auto: true }));
        });
        continue;
      }
      const g = infer(k, values, idMaps);
      let label = LABEL[k] ?? prettify(k);
      if (src === "company" && k === "name") label = "Name";
      if (src === "deal" && k === "company_id") label = "Company";
      out.push(mk(src, k, label, g.kind, (e) => e?.[k], { options: g.options, auto: !LABEL[k] }));
    }
    // custom fields: from their definition, plus any custom value without one
    if (defs) {
      const defined = new Set(defs.map((d) => d.id));
      defs.forEach((d) => out.push(mk(src, `custom:${d.id}`, d.label, customKind(d.type), (e) => e?.custom?.[d.id],
        { options: d.type === "select" ? d.options.map((o) => ({ value: o, label: o })) : undefined })));
      const orphan = new Set<string>(); rows.forEach((r) => Object.keys(r?.custom ?? {}).forEach((ck) => { if (!defined.has(ck)) orphan.add(ck); }));
      orphan.forEach((ck) => { const g = infer(ck, rows.map((r) => r?.custom?.[ck]), idMaps); out.push(mk(src, `custom:${ck}`, `${prettify(ck)} (custom)`, g.kind, (e) => e?.custom?.[ck], { options: g.options, auto: true })); });
    } else {
      // deals: custom values, if the table has them
      const ck = new Set<string>(); rows.forEach((r) => Object.keys(r?.custom ?? {}).forEach((x) => ck.add(x)));
      ck.forEach((x) => { const g = infer(x, rows.map((r) => r?.custom?.[x]), idMaps); out.push(mk(src, `custom:${x}`, prettify(x), g.kind, (e) => e?.custom?.[x], { options: g.options, auto: true })); });
    }
  };
  discover("contact", inp.contacts, inp.contactFields);
  discover("company", inp.companies, inp.companyFields);
  discover("deal", inp.deals, inp.dealFields?.length ? inp.dealFields : null);
  return out;
}

/* ---------- conditions ---------- */
export interface Cond { id: string; field: string; op: string; vals: string[]; a: string; b: string }
export const OPS: Record<Kind, { value: string; label: string }[]> = {
  text: [{ value: "contains", label: "contains" }, { value: "not_contains", label: "doesn't contain" }, { value: "is", label: "is exactly" }, { value: "not_empty", label: "has a value" }, { value: "empty", label: "is empty" }],
  number: [{ value: "gte", label: "is at least" }, { value: "lte", label: "is at most" }, { value: "between", label: "is between" }, { value: "not_empty", label: "has a value" }, { value: "empty", label: "is empty" }],
  date: [{ value: "period", label: "is in" }, { value: "between", label: "is between" }, { value: "not_empty", label: "has a date" }, { value: "empty", label: "has no date" }],
  bool: [{ value: "yes", label: "is yes" }, { value: "no", label: "is no" }],
  enum: [{ value: "any", label: "is any of" }, { value: "none", label: "is none of" }, { value: "not_empty", label: "has a value" }, { value: "empty", label: "is empty" }],
};
export const DEFAULT_OP: Record<Kind, string> = { text: "contains", number: "gte", date: "period", bool: "yes", enum: "any" };
export const NO_VALUE = new Set(["empty", "not_empty", "yes", "no"]);
/** Operators that say what a value is NOT — never grouped into "the same deal/company". */
export const NEGATIVE = new Set(["none", "empty", "no", "not_contains"]);
const norm = (s: any) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const iso = (v: any) => (v ? String(v).slice(0, 10) : "");

export function condPasses(f: XF, cond: Cond, x: Ctx, inPeriod: (d: string, key: string) => boolean): boolean {
  const vals = f.get(x);
  const filled = vals.filter((v) => !isEmpty(v));
  switch (cond.op) {
    case "empty": return filled.length === 0;
    case "not_empty": return filled.length > 0;
    case "yes": return vals.some((v) => v === true);
    case "no": return !vals.some((v) => v === true);
    case "contains": return !!cond.a && filled.some((v) => norm(v).includes(norm(cond.a)));
    case "not_contains": return !cond.a || !filled.some((v) => norm(v).includes(norm(cond.a)));
    case "is": return filled.some((v) => norm(v) === norm(cond.a));
    case "gte": return cond.a !== "" && filled.some((v) => Number(v) >= Number(cond.a));
    case "lte": return cond.a !== "" && filled.some((v) => Number(v) <= Number(cond.a));
    case "any": return cond.vals.length > 0 && filled.some((v) => cond.vals.includes(String(v)));
    case "none": return !filled.some((v) => cond.vals.includes(String(v)));
    case "period": return !!cond.a && filled.some((v) => inPeriod(iso(v), cond.a));
    case "between":
      if (f.kind === "date") return filled.some((v) => { const d = iso(v); return (!cond.a || d >= cond.a) && (!cond.b || d <= cond.b); });
      return filled.some((v) => { const n = Number(v); return (cond.a === "" || n >= Number(cond.a)) && (cond.b === "" || n <= Number(cond.b)); });
    default: return true;
  }
}
export const condReady = (f: XF | undefined, c: Cond) => !!f && (NO_VALUE.has(c.op) || (f.kind === "enum" ? c.vals.length > 0 : c.op === "between" ? !!(c.a || c.b) : !!c.a));

/**
 * Does a contact match? Company conditions can be required to hold for the same
 * company, and deal conditions for the same deal (the default), instead of being
 * satisfied by different ones.
 */
export function contactMatches(x: Ctx, conds: { f: XF; c: Cond }[], match: "all" | "any", same: { company: boolean; deal: boolean }, inPeriod: (d: string, key: string) => boolean): boolean {
  if (!conds.length) return true;
  if (match === "any") return conds.some(({ f, c }) => condPasses(f, c, x, inPeriod));
  const grouped = (src: "company" | "deal") => conds.filter(({ f, c }) => f.src === src && f.perEntity && same[src] && !NEGATIVE.has(c.op));
  const coG = grouped("company"), dG = grouped("deal");
  const rest = conds.filter((k) => !coG.includes(k) && !dG.includes(k));
  if (!rest.every(({ f, c }) => condPasses(f, c, x, inPeriod))) return false;
  if (coG.length && !x.cos.some((co) => coG.every(({ f, c }) => condPasses(f, c, { ...x, cos: [co] }, inPeriod)))) return false;
  if (dG.length && !x.deals.some((d) => dG.every(({ f, c }) => condPasses(f, c, { ...x, deals: [d] }, inPeriod)))) return false;
  return true;
}

/* ---------- a field as an export cell ---------- */
export type Cell = string | number | null | { date: string };
export function cellOf(f: XF, x: Ctx): Cell {
  const vals = f.get(x).filter((v) => !isEmpty(v));
  if (!vals.length) return f.kind === "bool" ? "No" : null;
  const label = (v: any) => (f.kind === "bool" ? (v === true ? "Yes" : v === false ? "No" : String(v)) : f.options?.find((o) => o.value === String(v))?.label ?? String(v));
  if (vals.length === 1) {
    const v = vals[0];
    if (f.kind === "number" && Number.isFinite(Number(v))) return Number(v);
    if (f.kind === "date") return { date: iso(v) };
    return label(v);
  }
  if (f.kind === "bool") return vals.some((v) => v === true) ? "Yes" : "No";
  if (f.kind === "number" && f.money) return vals.reduce((s, v) => s + (Number(v) || 0), 0);
  return [...new Set(vals.map((v) => (f.kind === "date" ? iso(v) : label(v))))].join("; ");
}
export const formatOf = (f: XF): "text" | "number" | "money" | "date" => (f.kind === "date" ? "date" : f.kind === "number" ? (f.money ? "money" : "number") : "text");