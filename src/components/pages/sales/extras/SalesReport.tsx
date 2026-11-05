/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as RDragEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../api/supabase";
import { downloadBlob, tableToCsv, tableToXlsx, type ExportColumn } from "../../../framework/exportFile";
import SalesMultiFilter, { type SmfOption } from "../sales/SalesMultiFilter";
import DatePicker from "../../../framework/DatePicker";
import { ReportChart, CHART_LABEL, PALETTE, type ChartType } from "./ReportCharts";
import {
  ENTITIES, entityOf, GROUP_LABEL, OPS, DEFAULT_OP, NO_VALUE, PERIODS, FN_LABEL,
  loadCrmData, buildCrmRows, buildCrmFields, aggregateCrm, partsOf, isListLink, ROW_CAP, testTree, countRules, isGroup, emptyTree, forgetCrmData,
  condComplete, toCell, showCell, sortValue, uid, norm, setReportPeriod, withPeriodTag, prettyRange, DEFAULT_REPORT_PERIOD, PERIOD_STATUS_HINT,
  type Cond, type CondGroup, type Field, type EntityKey, type CrmFn, type CrmRow, type CrmData, type Kind, type Agg, type ReportPeriod,
} from "./salesReportEngine";
import "./SalesReport.css";

/* =====================================================================
   Reports — its own page. Any part of the CRM, every field (fixed, custom
   and computed), rules nested as deep as you like, and charts on any field.
   One page: a toolbar (what each row is, filters, columns, charts, group,
   sort, totals) and the report right under it, changing as you go.
   ===================================================================== */

/** A chart's width on the report: a third, a half, or the whole width. */
type ChartSize = "s" | "m" | "l";
type ChartOrder = "auto" | "high" | "low" | "az";
interface CrmChart {
  id: string; title: string; type: ChartType; dim: string; fn: CrmFn; value: string | null; split: string | null; cumulative?: boolean;
  size?: ChartSize;
  /** How many bars (the rest add up as "Other"); 0 = every one. Unset: 14. */
  top?: number;
  order?: ChartOrder;
}
/** A figure on top of the report (a count, or a total / average / lowest / highest of any number). */
interface CrmFigure { id: string; fn: CrmFn; value: string | null; label?: string }
export interface CrmReport {
  v: 2; name: string; source: EntityKey; filter: CondGroup;
  /** More parts of the CRM in the same report, linked to each row (a deal's signed products, a client's invoices…). */
  with?: EntityKey[];
  cols: string[]; labels: Record<string, string>;
  sort: { key: string; dir: "asc" | "desc" } | null; groupBy: string | null; totals: boolean;
  charts: CrmChart[]; openInView?: boolean;
  /** The figures on top; unset = the count and the money columns' totals. */
  figures?: CrmFigure[];
  /** The report's period (a parameter): unset = this year. */
  period?: ReportPeriod;
}
interface SavedReport { id: string; name: string; owner_id: string | null; shared: boolean; updated_at: string; config: any }
/** One of your folders of saved reports (93_sales_report_folders.sql): yours alone, reports shared with you included. */
interface ReportFolder { id: string; name: string; color: string | null; sort: number; report_ids: string[] }
const FOLDER_COLORS = ["#0a6f4d", "#2f6fd6", "#7c3aed", "#c2410c", "#b7791f", "#0f766e", "#be185d", "#475569"];

const DEFAULT_COLS: Record<EntityKey, string[]> = {
  deal: ["deal.name", "deal.pipeline", "deal.phase", "deal.owner", "deal.revenue", "deal.weighted", "deal.close"],
  company: ["company.name", "company.types", "company.sector", "company.city", "company.country_name"],
  contact: ["contact.name", "contact.email", "contact.position", "company.name"],
  client: ["client.name", "client.projects", "client.projects_value", "client.recurring", "client.next_renewal"],
  project: ["project.name", "client.name", "project.type", "project.status_label", "project.value"],
  agreement: ["agreement.deal", "agreement.customer", "agreement.signed", "agreement.start", "agreement.end", "agreement.total", "agreement.per_year"],
  contract: ["client.name", "contract.product", "contract.kind", "contract.annual_now", "contract.value", "contract.end"],
  invoice: ["client.name", "invoice.period", "invoice.net", "invoice.amount", "invoice.status_label", "invoice.due_date", "invoice.days_late"],
  ticket: ["ticket.title", "ticket.what", "client.name", "ticket.stage_label", "ticket.priority_label", "ticket.assignee", "ticket.created_at"],
};
const newReport = (source: EntityKey = "deal"): CrmReport => ({
  v: 2, name: "Untitled report", source, filter: emptyTree(), cols: DEFAULT_COLS[source], labels: {},
  sort: null, groupBy: null, totals: true, charts: [],
});
const rule = (field: string, op: string, p: Partial<Cond> = {}): Cond => ({ id: uid(), field, op, a: "", b: "", vals: [], ...p });
/** Quick starts: a whole report in one click (then change anything). */
const TEMPLATES: { title: string; hint: string; make: () => CrmReport }[] = [
  { title: "Open pipeline by phase", hint: "Deals still open, their value per phase", make: () => ({ ...newReport("deal"), name: "Open pipeline by phase",
    filter: { id: uid(), match: "all", items: [rule("deal.status", "in", { vals: ["Active"] })] },
    charts: [{ id: uid(), title: "Value by phase", type: "bar", dim: "deal.phase", fn: "sum", value: "deal.revenue", split: null }, { id: uid(), title: "Deals by owner", type: "donut", dim: "deal.owner", fn: "count", value: null, split: null }] }) },
  { title: "Recurring by client", hint: "What each client bills a year today", make: () => ({ ...newReport("client"), name: "Recurring by client",
    filter: { id: uid(), match: "all", items: [rule("client.recurring", "gt", { a: "0" })] },
    sort: { key: "client.recurring", dir: "desc" }, charts: [{ id: uid(), title: "Top clients by recurring", type: "hbar", dim: "client.name", fn: "sum", value: "client.recurring", split: null }] }) },
  { title: "Signed contracts", hint: "Every signed contract: dates, term, value — by year signed", make: () => ({ ...newReport("agreement"), name: "Signed contracts",
    sort: { key: "agreement.signed", dir: "desc" }, charts: [{ id: uid(), title: "Contract value by year signed", type: "bar", dim: "time:year:agreement.signed", fn: "sum", value: "agreement.total", split: null }, { id: uid(), title: "Contracts by product", type: "donut", dim: "agreement.products", fn: "count", value: null, split: null }] }) },
  { title: "ARR this year: new + renewals", hint: "Contracts signed this year and the ones renewing in it, with the ARR they bring", make: () => ({ ...newReport("contract"), name: "ARR this year: new + renewals",
    period: { key: "this_year" },
    filter: { id: uid(), match: "all", items: [rule("contract.period_status", "in", { vals: ["New", "Renewal", "Auto-renews"] })] },
    cols: ["client.name", "contract.product", "contract.period_status", "contract.signed", "contract.period_date", "contract.next_renewal", "contract.arr_period", "contract.revenue_period"],
    sort: { key: "contract.period_date", dir: "asc" },
    figures: [{ id: uid(), fn: "count", value: null, label: "Contracts" }, { id: uid(), fn: "sum", value: "contract.arr_period", label: "ARR" }, { id: uid(), fn: "sum", value: "contract.revenue_period", label: "Revenue in the period" }],
    charts: [{ id: uid(), title: "ARR: new vs renewals", type: "donut", dim: "contract.period_status", fn: "sum", value: "contract.arr_period", split: null },
      { id: uid(), title: "ARR by product", type: "hbar", dim: "contract.product", fn: "sum", value: "contract.arr_period", split: null, top: 10, order: "high" },
      { id: uid(), title: "ARR by month", type: "stacked", dim: "time:month:contract.period_date", fn: "sum", value: "contract.arr_period", split: "contract.period_status", size: "l" }] }) },
  { title: "Contracts ending soon", hint: "Signed products ending in the next 90 days", make: () => ({ ...newReport("contract"), name: "Contracts ending in 90 days",
    filter: { id: uid(), match: "all", items: [rule("contract.end", "in_period", { a: "next_90" })] },
    sort: { key: "contract.end", dir: "asc" }, charts: [{ id: uid(), title: "Yearly value ending, by month", type: "bar", dim: "time:month:contract.end", fn: "sum", value: "contract.annual_now", split: null }] }) },
  { title: "Overdue invoices", hint: "Sent, not paid and past their due date", make: () => ({ ...newReport("invoice"), name: "Overdue invoices",
    filter: { id: uid(), match: "all", items: [rule("invoice.status_label", "in", { vals: ["Overdue"] })] },
    sort: { key: "invoice.days_late", dir: "desc" }, charts: [{ id: uid(), title: "Owed by client", type: "hbar", dim: "client.name", fn: "sum", value: "invoice.amount", split: null }] }) },
  { title: "Open tickets & tasks", hint: "By priority and who has them", make: () => ({ ...newReport("ticket"), name: "Open tickets & tasks",
    filter: { id: uid(), match: "all", items: [rule("ticket.open", "in", { vals: ["Yes"] })] },
    charts: [{ id: uid(), title: "Tickets and tasks", type: "donut", dim: "ticket.what", fn: "count", value: null, split: null }, { id: uid(), title: "By priority", type: "donut", dim: "ticket.priority_label", fn: "count", value: null, split: null }, { id: uid(), title: "By assignee and stage", type: "stacked", dim: "ticket.assignee", fn: "count", value: null, split: "ticket.stage_label" }] }) },
  { title: "Companies by type & country", hint: "The CRM at a glance", make: () => ({ ...newReport("company"), name: "Companies by type & country",
    charts: [{ id: uid(), title: "By type", type: "bar", dim: "company.types", fn: "count", value: null, split: null }, { id: uid(), title: "By country", type: "donut", dim: "company.country_name", fn: "count", value: null, split: null }] }) },
];

/** A saved report from the old Deals report: its rules, columns and charts carry over. */
function fromSaved(c: any, name: string): CrmReport {
  if (c?.v === 2) return { ...newReport(c.source), ...c, name, filter: c.filter ?? emptyTree() };
  const r = newReport("deal");
  r.name = name;
  r.filter = { id: uid(), match: c?.match === "any" ? "any" : "all", items: (c?.conds ?? []).map((x: Cond) => ({ ...x })) };
  if (Array.isArray(c?.list?.cols) && c.list.cols.length) r.cols = c.list.cols;
  r.labels = c?.list?.labels ?? {};
  r.sort = c?.list?.sort ?? null; r.groupBy = c?.list?.groupBy ?? null;
  r.charts = (c?.charts ?? []).map((ch: any) => ({
    id: uid(), title: ch.title, type: ch.type, split: ch.split ?? null, cumulative: ch.cumulative, size: ch.wide ? "l" : undefined,
    dim: String(ch.dim ?? "deal.phase").startsWith("time:") ? `time:${String(ch.dim).slice(5)}:deal.close` : String(ch.dim ?? "").startsWith("created:") ? `time:${String(ch.dim).slice(8)}:deal.created` : ch.dim,
    fn: ch.measure === "count" ? "count" : ch.measure === "avgprob" ? "avg" : "sum",
    value: ch.measure === "revenue" ? "deal.revenue" : ch.measure === "weighted" ? "deal.weighted" : ch.measure === "avgprob" ? "deal.prob" : null,
  }));
  return r;
}


const Ico = ({ d, w = 2 }: { d: string; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  plus: "M12 5v14M5 12h14", x: "M6 6l12 12M18 6L6 18", up: "M12 19V5M6 11l6-6 6 6", dn: "M12 5v14M6 13l6 6 6-6",
  left: "M15 6l-6 6 6 6", right: "M9 6l6 6-6 6", check: "M5 12l5 5 9-10", edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  down: "M12 4v11M7 10l5 5 5-5M5 20h14", chart: "M4 20V10M10 20V4M16 20v-7M22 20H2", trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1", search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3", refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5",
  group: "M4 6h16M8 12h12M12 18h8M4 6v12", spark: "M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z",
  sliders: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  cal: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 10h16M8 2v4M16 2v4",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  print: "M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z",
  sheet: "M4 4h16v16H4zM4 10h16M4 15h16M10 4v16",
  more: "M5 11.2a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6zM12 11.2a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6zM19 11.2a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6z",

};
const KIND_ICON: Record<Kind, string> = { text: "Aa", number: "#", money: "€", percent: "%", date: "◷", enum: "≡" };
const vars = (o: Record<string, string | number>) => o as CSSProperties;
/** Six dots: drag me. */
const Grip = () => (
  <svg className="rp-grip-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
);
const SIZE_LABEL: Record<ChartSize, string> = { s: "A third of the width", m: "Half the width", l: "The whole width" };
const sizeOf = (c: CrmChart): ChartSize => c.size ?? (c.type === "line" || c.type === "area" ? "l" : "m");
const TOPS: { v: number | null; label: string }[] = [{ v: null, label: "Auto" }, { v: 5, label: "5" }, { v: 10, label: "10" }, { v: 20, label: "20" }, { v: 0, label: "All" }];
const ORDER_LABEL: Record<ChartOrder, string> = { auto: "As listed", high: "Biggest first", low: "Smallest first", az: "A → Z" };
/** Moves the item with id `from` before / after the one with id `to`. */
function moveBy<T extends { id: string }>(xs: T[], from: string, to: string, after: boolean): T[] {
  const it = xs.find((x) => x.id === from);
  if (!it || from === to) return xs;
  const rest = xs.filter((x) => x.id !== from);
  const j = rest.findIndex((x) => x.id === to);
  rest.splice(j < 0 ? rest.length : j + (after ? 1 : 0), 0, it);
  return rest;
}
const glabel = (g: string) => GROUP_LABEL[g as EntityKey] ?? g;
/** Lower case for a label inside a sentence — acronyms (ARR, VAT, CRM…) stay as they are. */
const low = (x: string) => x.split(" ").map((w) => (/^[A-Z0-9]{2,}\b/.test(w) ? w : w.toLowerCase())).join(" ");

/** A field picker: every field, grouped by the part of the CRM it belongs to. */
function FieldPick({ fields, value, onChange, placeholder, filter, main }: { fields: Field[]; value: string | null; onChange: (k: string) => void; placeholder: string; filter?: (f: Field) => boolean; main?: string }) {
  // a field of another part says whose it is ("Company · Country"), so a picked rule reads right
  const opts: SmfOption[] = fields.filter((f) => !filter || filter(f)).map((f) => ({ value: f.key, label: main && f.group !== main && !norm(f.label).includes(norm(glabel(f.group))) ? `${glabel(f.group)} · ${f.label}` : f.label, group: glabel(f.group), hint: KIND_ICON[f.kind] }));
  return <SalesMultiFilter single values={value ? [value] : []} onChange={(v) => v[0] && onChange(v[0])} options={opts} placeholder={placeholder} searchFrom={8} />;
}

/** The values a rule can pick, each with how many rows it would keep given the other rules. */
type ValueOpts = (c: Cond, f: Field) => SmfOption[];
/** The rules without one of them (to count what the others leave). */
const withoutRule = (g: CondGroup, id: string): CondGroup => ({ ...g, items: g.items.filter((it) => it.id !== id).map((it) => (isGroup(it) ? withoutRule(it, id) : it)) });
/** Every complete rule in a tree. */
const rulesOf = (g: CondGroup, fieldByKey: Map<string, Field>): Cond[] => g.items.flatMap((it) => (isGroup(it) ? rulesOf(it, fieldByKey) : condComplete(it, fieldByKey.get(it.field)) ? [it] : []));

/** One rule: field · how · value(s). */
function RuleRow({ c, fields, fieldByKey, values, opts, onChange, onRemove, main, left, noun }: {
  c: Cond; fields: Field[]; fieldByKey: Map<string, Field>; values: (f: Field) => string[]; opts: ValueOpts; main: string;
  /** How many are left once this rule (and the ones above it) apply. */
  left?: number; noun?: (n: number) => string;
  onChange: (c: Cond) => void; onRemove: () => void;
}) {
  const f = fieldByKey.get(c.field);
  const ops = f ? OPS[f.kind] : [];
  // a text with a known set of values (country, city, owner…) is picked from its values; free text is searched
  const firstOp = (nf: Field) => (nf.kind === "text" ? (values(nf).length <= 400 ? "in" : "contains") : DEFAULT_OP[nf.kind]);
  const set = (p: Partial<Cond>) => onChange({ ...c, ...p });
  return (
    <div className={`rp-rule ${f && condComplete(c, f) ? "is-ok" : ""}`}>
      <div className="rp-rule-f"><FieldPick fields={fields} main={main} value={c.field || null} placeholder="Pick a field…" onChange={(k) => { const nf = fieldByKey.get(k); set({ field: k, op: nf ? firstOp(nf) : "contains", a: "", b: "", vals: [] }); }} /></div>
      {f && (
        <div className="rp-rule-op">
          <SalesMultiFilter single values={[c.op]} onChange={(v) => v[0] && set({ op: v[0] })} options={ops.map((o) => ({ value: o.value, label: o.label }))} placeholder="How" />
        </div>
      )}
      {f && !NO_VALUE.has(c.op) && (
        <div className="rp-rule-v">
          {f.kind === "enum" || (f.kind === "text" && (c.op === "in" || c.op === "not_in")) ? (
            <SalesMultiFilter values={c.vals} onChange={(v) => set({ vals: v })} options={opts(c, f)} placeholder="Pick values…" noun="values" searchFrom={8} />
          ) : f.kind === "date" ? (
            c.op === "in_period" ? (
              <SalesMultiFilter single values={c.a ? [c.a] : []} onChange={(v) => v[0] && set({ a: v[0] })} options={[{ value: "report", label: "The report's period", group: "This report", hint: "◷" }, ...PERIODS.filter((p) => p.key !== "all" && p.key !== "custom").map((p) => ({ value: p.key, label: p.label, group: p.group }))]} placeholder="Pick a period…" />
            ) : (
              <span className="rp-rule-dates">
                <DatePicker value={c.a} onChange={(v) => set({ a: v ?? "" })} placeholder="Date" />
                {c.op === "between" && <><i>and</i><DatePicker value={c.b} onChange={(v) => set({ b: v ?? "" })} placeholder="Date" /></>}
              </span>
            )
          ) : f.kind === "text" ? (
            <input className="rp-in" value={c.a} onChange={(e) => set({ a: e.target.value })} placeholder="Text…" />
          ) : (
            <span className="rp-rule-dates">
              <input className="rp-in" inputMode="decimal" value={c.a} onChange={(e) => set({ a: e.target.value })} placeholder={f.kind === "money" ? "€" : f.kind === "percent" ? "%" : "Number"} />
              {c.op === "between" && <><i>and</i><input className="rp-in" inputMode="decimal" value={c.b} onChange={(e) => set({ b: e.target.value })} placeholder={f.kind === "money" ? "€" : "Number"} /></>}
            </span>
          )}
        </div>
      )}
      {left != null && <span className={`rp-left ${left === 0 ? "is-zero" : ""}`} title={left === 0 ? "Nothing is left after this rule: change it, or take it out" : "How many are left after this rule and the ones above it"}>{left.toLocaleString("en-GB")} {noun ? noun(left) : "left"}</span>}
      <button type="button" className="rp-x" onClick={onRemove} aria-label="Remove this rule"><Ico d={I.x} w={2.4} /></button>
    </div>
  );
}

/** A group of rules — all / any / none of them — with rules and more groups inside. */
function RuleGroup({ g, depth, fields, fieldByKey, values, opts, onChange, onRemove, main, left, noun }: {
  g: CondGroup; depth: number; fields: Field[]; fieldByKey: Map<string, Field>; values: (f: Field) => string[]; opts: ValueOpts; main: string;
  left?: Map<string, number>; noun?: (n: number) => string;
  onChange: (g: CondGroup) => void; onRemove?: () => void;
}) {
  const setItem = (i: number, it: Cond | CondGroup) => onChange({ ...g, items: g.items.map((x, j) => (j === i ? it : x)) });
  const drop = (i: number) => onChange({ ...g, items: g.items.filter((_, j) => j !== i) });
  const add = () => onChange({ ...g, items: [...g.items, rule("", "contains")] });
  const addGroup = () => onChange({ ...g, items: [...g.items, { id: uid(), match: g.match === "all" ? "any" : "all", items: [rule("", "contains")] }] });
  const word = g.match === "all" ? "and" : g.match === "any" ? "or" : "nor";
  return (
    <div className={`rp-grp d${Math.min(depth, 4)}`}>
      <div className="rp-grp-h">
        <span>{depth ? "A group where" : "Keep the ones where"}</span>
        <div className="rp-seg" role="radiogroup">
          {(["all", "any", "none"] as const).map((m) => (
            <button type="button" key={m} role="radio" aria-checked={g.match === m} className={g.match === m ? "is-on" : ""} onClick={() => onChange({ ...g, match: m })}>{m}</button>
          ))}
        </div>
        <span>of these are true</span>
        {onRemove && <button type="button" className="rp-x is-grp" onClick={onRemove} aria-label="Remove this group"><Ico d={I.x} w={2.4} /></button>}
      </div>
      <div className="rp-grp-items">
        {g.items.length === 0 && <p className="rp-none">No rules yet — everything is in. Add a rule to narrow it down.</p>}
        {g.items.map((it, i) => (
          <div className="rp-grp-it" key={it.id}>
            {i > 0 && <span className="rp-join">{word}</span>}
            {isGroup(it)
              ? <RuleGroup g={it} depth={depth + 1} fields={fields} fieldByKey={fieldByKey} values={values} opts={opts} main={main} onChange={(x) => setItem(i, x)} onRemove={() => drop(i)} />
              : <RuleRow c={it} fields={fields} fieldByKey={fieldByKey} values={values} opts={opts} main={main} left={left?.get(it.id)} noun={noun} onChange={(x) => setItem(i, x)} onRemove={() => drop(i)} />}
            {isGroup(it) && left?.has(it.id) && <span className={`rp-left is-grp ${left.get(it.id) === 0 ? "is-zero" : ""}`}>{left.get(it.id)!.toLocaleString("en-GB")} {noun ? noun(left.get(it.id)!) : "left"} after this group</span>}
          </div>
        ))}
      </div>
      <div className="rp-grp-add">
        <button type="button" className="rp-add" onClick={add}><Ico d={I.plus} w={2.4} />Add a rule</button>
        <button type="button" className="rp-add is-ghost" onClick={addGroup}><Ico d={I.group} />Add a group</button>
      </div>
    </div>
  );
}

/* ====================================================================== */

/** Where clicking a row of a report goes: the client (and the contract), the company, the deal… */
type RowLink = { to: string; state?: Record<string, unknown> };
function rowLink(src: EntityKey | null | undefined, r: CrmRow): RowLink | null {
  const company = (id: unknown): RowLink | null => (id ? { to: "/companies", state: { focusCompanyId: String(id) } } : null);
  const client = (id: unknown, extra = ""): RowLink | null => (id ? { to: `/clients?client=${encodeURIComponent(String(id))}${extra}` } : null);
  const it = src ? (r as any)[src] : null;
  if (!it) return null;
  switch (src) {
    case "deal": return it.id ? { to: `/sales?tracking=${encodeURIComponent(String(it.id))}` } : null;
    case "agreement": {
      const tid = it.tracking_id ?? (it.__lines?.[0]?.tracking_id) ?? null;
      const cl = r.client?.id ?? it.client_id ?? null;
      if (cl) return client(cl, tid ? `&contract=${encodeURIComponent(String(tid))}` : "&products=1");
      if (tid && r.deal?.id) return { to: `/sales?tracking=${encodeURIComponent(String(r.deal.id))}` };
      return company(it.company_id ?? r.company?.id);
    }
    case "contract": return client(it.client_id ?? r.client?.id, it.tracking_id ? `&contract=${encodeURIComponent(String(it.tracking_id))}` : "&products=1");
    case "client": return client(it.id);
    case "company": return company(it.id);
    case "contact": return it.id ? { to: "/contacts", state: { focusContactId: String(it.id) } } : null;
    case "project": return client(it.client_id ?? r.client?.id, it.id ? `&project=${encodeURIComponent(String(it.id))}` : "");
    case "invoice": {
      const pid = it.project_id ?? r.project?.id ?? null;
      return client(r.project?.client_id ?? r.client?.id ?? it.client_id, pid ? `&project=${encodeURIComponent(String(pid))}` : "") ?? company(r.company?.id);
    }
    case "ticket": return it.id ? { to: `/tickets?ticket=${encodeURIComponent(String(it.id))}` } : null;
    default: return null;
  }
}
const RETURN_KEY = "rp-return";
/** What a column search looks in: its name (with and without the period spelt out), and the words people use for money per year. */
const findable = (f: Field) => norm(`${f.label} ${(f as any).raw ?? ""} ${/ARR|Licen|Recurring/i.test(f.label) ? "recurring annual yearly per year licence license subscription" : ""} ${/period/i.test((f as any).raw ?? f.label) ? "year quarter month period" : ""}`);

export default function ReportsPage() {
  const navigate = useNavigate();
  const [saved, setSaved] = useState<SavedReport[]>([]);
  /* ---- folders of saved reports ---- */
  const [folders, setFolders] = useState<ReportFolder[]>([]);
  const [foldersOk, setFoldersOk] = useState(true);
  const [closed, setClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem("rp-closed-folders") || "[]")); } catch { return new Set(); } });
  const [fNew, setFNew] = useState<string | null>(null);
  const [fEdit, setFEdit] = useState<{ id: string; name: string } | null>(null);
  const [fMenu, setFMenu] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState<string | null>(null);
  const [dragRep, setDragRep] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  /** where the open folder / move menu sits (fixed, so the list's scrolling never clips it) */
  const [menuAt, setMenuAt] = useState<CSSProperties>({});
  const placeMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - 228, r.left - 6));
    setMenuAt(r.bottom + 280 > window.innerHeight ? { left, bottom: window.innerHeight - r.top + 4 } : { left, top: r.bottom + 4 });
  };
  const [tableMissing, setTableMissing] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [cfg, setCfg] = useState<CrmReport | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  /** Who the open report belongs to (null: a new one, yours). */
  const [owner, setOwner] = useState<string | null>(null);
  const [snap, setSnap] = useState("");
  /** The toolbar's open panel (one at a time): what the rows are, the filters, the columns, the charts. */
  const [panel, setPanel] = useState<"data" | "period" | "filter" | "cols" | "charts" | null>(null);
  /** Build (the toolbar, rules, columns, chart settings) or View (the report as it reads: figures, charts, table). */
  const [mode, setMode] = useState<"build" | "view">("build");
  const [expOpen, setExpOpen] = useState(false);
  const togglePanel = (p: "data" | "period" | "filter" | "cols" | "charts") => setPanel((cur) => (cur === p ? null : p));
  const [sharedSnap, setSharedSnap] = useState(false);
  useEffect(() => {
    if (!panel) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".smf-menu, .dp-pop")) setPanel(null); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [panel]);
  const [q, setQ] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the data of the report's subject, its fields and rows
  const [data, setData] = useState<CrmData | null>(null);
  const [rawFields, setFields] = useState<Field[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [shown, setShown] = useState(200);
  const [dataFor, setDataFor] = useState("");
  /** The chart whose settings are open (one at a time). */
  const [openChart, setOpenChart] = useState<string | null>(null);
  /** Dragging: a chart / a column, armed from its grip, and where it would land. */
  const [dragArm, setDragArm] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ id: string; after: boolean } | null>(null);
  const [colQ, setColQ] = useState("");
  const [figDraft, setFigDraft] = useState<{ fn: CrmFn; value: string | null } | null>(null);
  const scrollToChart = useRef<string | null>(null);
  useEffect(() => {
    const id = scrollToChart.current;
    if (!id) return;
    scrollToChart.current = null;
    window.requestAnimationFrame(() => document.querySelector(`[data-chart="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  });

  useEffect(() => { if (note) { const t = setTimeout(() => setNote(null), 2800); return () => clearTimeout(t); } }, [note]);
  useEffect(() => { supabase.auth.getSession().then(({ data: s }) => setMe(s?.session?.user?.id ?? null)); void loadSaved(); }, []);

  async function loadSaved() {
    const [{ data: rows, error }, fo] = await Promise.all([
      supabase.from("sales_reports").select("id, name, owner_id, shared, updated_at, config").order("updated_at", { ascending: false }),
      supabase.from("sales_report_folders").select("id, name, color, sort, report_ids").order("sort").order("created_at"),
    ]);
    if (error) { setTableMissing(true); return; }
    setSaved((rows ?? []) as SavedReport[]);
    if (fo.error) setFoldersOk(false);
    else { setFoldersOk(true); setFolders(((fo.data ?? []) as any[]).map((f) => ({ id: f.id, name: f.name ?? "Folder", color: f.color ?? null, sort: Number(f.sort) || 0, report_ids: Array.isArray(f.report_ids) ? f.report_ids : [] }))); }
  }
  useEffect(() => {
    if (!fMenu && !moveOpen) return;
    const k = (e: MouseEvent) => { if (!(e.target as Element)?.closest?.(".rp-fold-menu, .rp-mv-menu, .rp-fold-more, .rp-mv")) { setFMenu(null); setMoveOpen(null); } };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setFMenu(null); setMoveOpen(null); } };
    document.addEventListener("mousedown", k); window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", k); window.removeEventListener("keydown", esc); };
  }, [fMenu, moveOpen]);
  const NEEDS_FOLDERS = "Folders need 93_sales_report_folders.sql in Supabase.";
  const folderOf = (id: string) => folders.find((f) => f.report_ids.includes(id)) ?? null;
  const toggleFolder = (id: string) => setClosed((cur) => {
    const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem("rp-closed-folders", JSON.stringify([...next])); } catch { /* private mode */ }
    return next;
  });
  const addFolder = async (name: string) => {
    setFNew(null);
    if (!name.trim()) return;
    const res = await supabase.from("sales_report_folders").insert({ name: name.trim(), color: FOLDER_COLORS.find((c) => !folders.some((f) => f.color === c)) ?? FOLDER_COLORS[folders.length % FOLDER_COLORS.length], sort: (folders[folders.length - 1]?.sort ?? 0) + 1 }).select("id, name, color, sort, report_ids").single();
    if (res.error || !res.data) { setNote(/sales_report_folders|relation|schema cache/i.test(res.error?.message ?? "") ? NEEDS_FOLDERS : res.error?.message ?? "Not saved"); return; }
    const f = res.data as any;
    setFolders((xs) => [...xs, { id: f.id, name: f.name, color: f.color, sort: f.sort, report_ids: f.report_ids ?? [] }]);
  };
  const patchFolder = async (f: ReportFolder, p: Partial<ReportFolder>) => {
    setFolders((xs) => xs.map((x) => (x.id === f.id ? { ...x, ...p } : x)));
    const { error } = await supabase.from("sales_report_folders").update(p).eq("id", f.id);
    if (error) { setNote(error.message); setFolders((xs) => xs.map((x) => (x.id === f.id ? f : x))); }
  };
  const dropFolder = async (f: ReportFolder) => {
    const n = f.report_ids.filter((id) => saved.some((s) => s.id === id)).length;
    if (!window.confirm(n ? `Delete the folder “${f.name}”? Its ${n} report${n === 1 ? "" : "s"} stay, just not in a folder.` : `Delete the folder “${f.name}”?`)) return;
    const { error } = await supabase.from("sales_report_folders").delete().eq("id", f.id);
    if (error) { setNote(error.message); return; }
    setFolders((xs) => xs.filter((x) => x.id !== f.id));
  };
  /** a report into one of your folders (null: out of every folder) */
  const moveTo = async (reportId: string, to: string | null) => {
    const from = folderOf(reportId);
    if ((from?.id ?? null) === to) return;
    const before = folders;
    const next = folders.map((f) => (f.id === to ? { ...f, report_ids: [...f.report_ids.filter((x) => x !== reportId), reportId] } : f.report_ids.includes(reportId) ? { ...f, report_ids: f.report_ids.filter((x) => x !== reportId) } : f));
    setFolders(next);
    const changed = next.filter((f) => before.find((b) => b.id === f.id)?.report_ids !== f.report_ids);
    for (const f of changed) {
      const { error } = await supabase.from("sales_report_folders").update({ report_ids: f.report_ids }).eq("id", f.id);
      if (error) { setNote(error.message); setFolders(before); return; }
    }
    const rName = saved.find((x) => x.id === reportId)?.name ?? "Report";
    setNote(to ? `${rName} → ${next.find((f) => f.id === to)?.name ?? "folder"}` : `${rName} is out of its folder`);
    if (to) setClosed((cur) => { if (!cur.has(to)) return cur; const n2 = new Set(cur); n2.delete(to); return n2; });
  };
  const dropTarget = (key: string) => ({
    onDragOver: (e: RDragEvent) => { if (!dragRep) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dropOn !== key) setDropOn(key); },
    onDragLeave: (e: RDragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropOn((x) => (x === key ? null : x)); },
    onDrop: (e: RDragEvent) => { e.preventDefault(); const id = dragRep; setDropOn(null); setDragRep(null); if (id) void moveTo(id, key === "none" ? null : key); },
  });
  const source = cfg?.source ?? null;
  const withKey = (cfg?.with ?? []).join(",");
  const extra = useMemo(() => (withKey ? withKey.split(",") as EntityKey[] : []), [withKey]);
  // read what the subject needs (once per visit; "Refresh data" reads again)
  const [dataTick, setDataTick] = useState(0);
  useEffect(() => {
    if (!source) return;
    let off = false;
    setLoading("Reading the CRM…"); setLoadErr(null);
    const key = `${source}|${extra.join(",")}`;
    loadCrmData(source, (w) => { if (!off) setLoading(`Reading ${w}…`); }, extra)
      .then(async (d) => { const fs = await buildCrmFields(source, d, extra); if (!off) { setData(d); setFields(fs); setDataFor(key); setLoading(null); } })
      .catch((e) => { if (!off) { setLoadErr(String(e?.message ?? e)); setLoading(null); } });
    return () => { off = true; };
  }, [source, extra, dataTick]);

  // the report's period: every period-aware field and "the report's period" rule reads it
  const period = cfg?.period ?? DEFAULT_REPORT_PERIOD;
  setReportPeriod(period);
  const periodSig = `${period.key}|${period.from ?? ""}|${period.to ?? ""}`;
  /** the fields, with "this period" / "next period" spelt out ("ARR · 2026", "ARR · 2027") */
  const fields = useMemo(() => rawFields.map((f) => { const l = withPeriodTag(f.label); return l === f.label ? f : { ...f, label: l, raw: f.label } as Field; }), [rawFields, periodSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const periodName = period.key === "custom" ? "Custom dates" : PERIODS.find((p) => p.key === period.key)?.label ?? "This year";
  const periodRange = prettyRange(period.key, period.from, period.to);
  /** Does anything on the report read the period (a period figure, or a rule on "the report's period")? */
  const usesPeriod = !!cfg && /(_period|_next|\.period_status|_in_period|\.period_date)"|"a":"report"/.test(JSON.stringify([cfg.cols, cfg.filter, cfg.charts, cfg.figures ?? null, cfg.groupBy, cfg.sort]));
  // the rows are built only from data read for this subject and these parts (never a half-read mix)
  const ready = dataFor === `${source}|${withKey}`;
  const allRows: CrmRow[] = useMemo(() => (data && source && ready ? buildCrmRows(source, data, extra) : []), [data, source, extra, ready]);
  const filter = cfg?.filter;
  const rows = useMemo(() => (filter ? allRows.filter((r) => testTree(filter, r, fieldByKey)) : []), [allRows, filter, fieldByKey, periodSig]); // eslint-disable-line react-hooks/exhaustive-deps
  // the values a category field takes (its list, plus what is in the data)
  const valuesOf = useMemo(() => {
    const memo = new Map<string, string[]>();
    return (f: Field) => {
      if (memo.has(f.key)) return memo.get(f.key)!;
      const s = new Set<string>(f.options ?? []);
      allRows.forEach((r) => { if (f.list) f.list(r as any).forEach((v) => v && s.add(v)); else { const v = f.get(r as any); if (v != null && v !== "") s.add(String(v)); } });
      const rank = (x: string) => { const i = f.options?.indexOf(x) ?? -1; return i < 0 ? 9999 : i; };
      const out = [...s].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      memo.set(f.key, out);
      return out;
    };
  }, [allRows]);

  /* ---- how many rows each value would keep, given the other rules (so no pick leads to an empty report by surprise) ---- */
  const facetCache = useMemo(() => new Map<string, Map<string, number>>(), [allRows, filter, fieldByKey, periodSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const facet = (ruleId: string, f: Field): Map<string, number> => {
    const k = `${ruleId}|${f.key}`;
    let m = facetCache.get(k);
    if (!m) {
      const out = new Map<string, number>();
      const others = filter ? withoutRule(filter, ruleId) : null;
      for (const r of allRows) {
        if (others && !testTree(others, r, fieldByKey)) continue;
        const vs = f.list ? f.list(r as any) : (() => { const v = f.get(r as any); return v == null || v === "" ? [] : [String(v)]; })();
        new Set(vs).forEach((v) => out.set(v, (out.get(v) ?? 0) + 1));
      }
      facetCache.set(k, (m = out));
    }
    return m;
  };
  const valueOpts: ValueOpts = (c, f) => {
    const m = facet(c.id, f);
    const all = valuesOf(f).map((v) => ({ v, n: m.get(v) ?? 0 }));
    const live = all.filter((x) => x.n > 0), dead = all.filter((x) => !x.n);
    // a long list reads best biggest first; a short one keeps its own order (phases, stages…)
    if (live.length > 12) live.sort((a, b) => b.n - a.n);
    return [
      ...live.map((x) => ({ value: x.v, label: x.v, hint: x.n.toLocaleString("en-US") })),
      ...dead.map((x) => ({ value: x.v, label: x.v, hint: "0", group: nRulesOther(c) ? "None left with your other rules" : "No records have these", tone: "muted" })),
    ];
  };
  const nRulesOther = (c: Cond) => (filter ? rulesOf(filter, fieldByKey).filter((x) => x.id !== c.id).length : 0);
  /** Nothing left: the one rule whose removal would bring the most back. */
  const blocker = useMemo((): { rule: Cond; n: number } | null => {
    if (!filter || rows.length || !allRows.length) return null;
    let best: { rule: Cond; n: number } | null = null;
    for (const r of rulesOf(filter, fieldByKey)) {
      const t = withoutRule(filter, r.id);
      let n = 0; for (const x of allRows) if (testTree(t, x, fieldByKey)) n++;
      if (n > 0 && (!best || n > best.n)) best = { rule: r, n };
    }
    return best;
  }, [filter, rows.length, allRows, fieldByKey, periodSig]); // eslint-disable-line react-hooks/exhaustive-deps
  /** "and" rules, one after the other: how many are left after each (shows where the rows go). */
  const leftAfter = useMemo(() => {
    const m = new Map<string, number>();
    if (!filter || filter.match !== "all") return m;
    let cur = allRows;
    for (const it of filter.items) {
      if (isGroup(it)) {
        if (!countRules(it)) continue;
        cur = cur.filter((r) => testTree(it, r, fieldByKey));
      } else {
        const f = fieldByKey.get(it.field);
        if (!condComplete(it, f)) continue;
        const one: CondGroup = { ...filter, items: [it] };
        cur = cur.filter((r) => testTree(one, r, fieldByKey));
      }
      m.set(it.id, cur.length);
    }
    return m;
  }, [filter, allRows, fieldByKey, periodSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const ruleText = (c: Cond) => {
    const f = fieldByKey.get(c.field);
    if (!f) return "a rule";
    const op = OPS[f.kind].find((o) => o.value === c.op)?.label ?? c.op;
    const v = NO_VALUE.has(c.op) ? "" : c.vals.length ? c.vals.slice(0, 3).join(", ") + (c.vals.length > 3 ? ` +${c.vals.length - 3}` : "") : c.op === "in_period" ? (c.a === "report" ? "the report's period" : PERIODS.find((p) => p.key === c.a)?.label ?? c.a) : c.op === "between" ? `${c.a} and ${c.b}` : c.a;
    return `${f.label} ${op}${v ? ` ${v}` : ""}`;
  };

  const set = (p: Partial<CrmReport>) => setCfg((c) => (c ? { ...c, ...p } : c));
  const dirty = !!cfg && JSON.stringify(cfg) !== snap;
  const mine = !owner || !me || owner === me;
  const start = (r: CrmReport, id: string | null = null, sh = false, view = false, by: string | null = null) => {
    setCfg(r); setReportId(id); setShared(sh); setSharedSnap(sh); setOwner(by); setSnap(JSON.stringify(r)); setPanel(null); setShown(200);
    setMode(view ? "view" : "build"); setOpenChart(null); setExpOpen(false);
  };
  const leaveOk = () => !dirty || window.confirm("Leave this report without saving your changes?");
  const switchMode = (m: "build" | "view") => { setMode(m); setPanel(null); setOpenChart(null); setFigDraft(null); setExpOpen(false); document.querySelector(".rp-main")?.scrollTo({ top: 0 }); };
  useEffect(() => {
    if (!expOpen) return;
    const k = (e: MouseEvent) => { if (!(e.target as Element)?.closest?.(".rp-exp")) setExpOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setExpOpen(false); };
    document.addEventListener("mousedown", k); window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", k); window.removeEventListener("keydown", esc); };
  }, [expOpen]);
  /** PDF: the browser's print dialog, with only the report on the page (see @media print in the CSS). */
  const printReport = () => {
    setExpOpen(false);
    if (mode !== "view") switchMode("view");
    setShown((n) => Math.max(n, Math.min(rows.length, 3000))); // the whole table (up to 3,000 rows) on paper
    window.setTimeout(() => {
      const src = document.getElementById("rp-print");
      if (!src) return;
      // a copy of the report straight under <body>: the app's scrolling panes can't cut it into one page
      document.querySelectorAll(".rp-print-root").forEach((x) => x.remove());
      const root = document.createElement("div");
      root.className = "rp rp-print-root";
      root.appendChild(src.cloneNode(true));
      document.body.appendChild(root);
      const t = document.title;
      document.title = `${cfg?.name?.trim() || "Report"} · ${new Date().toISOString().slice(0, 10)}`;
      const done = () => { root.remove(); document.title = t; window.removeEventListener("afterprint", done); };
      window.addEventListener("afterprint", done);
      window.print();
    }, mode !== "view" ? 450 : 120);
  };
  /* ---- clicking a row opens what it is (asking first when the report has unsaved changes) ---- */
  const [leaving, setLeaving] = useState<RowLink | null>(null);
  const go = (l: RowLink) => {
    // keep the report as it is, so Back comes straight back to it (unsaved changes included)
    if (cfg) { try { sessionStorage.setItem(RETURN_KEY, JSON.stringify({ cfg, reportId, shared, sharedSnap, owner, snap, mode, at: Date.now() })); } catch { /* private mode */ } }
    setLeaving(null);
    navigate(l.to, l.state ? { state: l.state } : undefined);
  };
  const openRow = (r: CrmRow) => {
    const l = rowLink(cfg?.source, r);
    if (!l) return;
    if (dirty) setLeaving(l); else go(l);
  };
  useEffect(() => {
    let back: any = null;
    try { back = JSON.parse(sessionStorage.getItem(RETURN_KEY) || "null"); sessionStorage.removeItem(RETURN_KEY); } catch { /* none */ }
    if (!back?.cfg || Date.now() - (back.at ?? 0) > 6 * 3600e3) return;
    start(back.cfg, back.reportId ?? null, !!back.sharedSnap, back.mode === "view", back.owner ?? null);
    setShared(!!back.shared);
    if (typeof back.snap === "string") setSnap(back.snap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setLeaving(null); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [leaving]);
  const open = (s: SavedReport) => { if (!leaveOk()) return; start(fromSaved(s.config, s.name), s.id, !!s.shared, true, s.owner_id); };
  const save = async (copyAsked = false) => {
    if (!cfg) return false;
    // a report someone shared with you can't be changed in place: your changes become your own copy
    const theirs = !!reportId && !mine;
    const copy = copyAsked || theirs;
    if (tableMissing) { setNote("Saved reports need the sales_reports table in the database."); return false; }
    setBusy(true);
    const name = (copy ? `${cfg.name} (copy)` : cfg.name).trim() || "Untitled report";
    const body = { name, config: { ...cfg, name, openInView: true }, shared, updated_at: new Date().toISOString() };
    const res = !copy && reportId
      ? await supabase.from("sales_reports").update(body).eq("id", reportId).select("id").single()
      : await supabase.from("sales_reports").insert(body).select("id").single();
    setBusy(false);
    if (res.error) { setNote(`Couldn't save: ${res.error.message}`); return false; }
    const c = { ...cfg, name };
    setCfg(c); setReportId((res.data as any).id); setOwner(me); setSnap(JSON.stringify(c)); setSharedSnap(shared); setNote(theirs ? "Saved as your own copy (the shared one stays as it was)" : copy ? "Saved as a copy" : "Report saved");
    void loadSaved();
    return true;
  };
  const remove = async (s: SavedReport) => {
    if (!window.confirm(`Delete “${s.name}”? This can't be undone.`)) return;
    const { error } = await supabase.from("sales_reports").delete().eq("id", s.id);
    if (error) { setNote(error.message); return; }
    if (s.id === reportId) { setCfg(null); setReportId(null); }
    void loadSaved();
  };

  /** A column's title: what it was renamed to, or its name — with its part when it isn't the rows' own ("Company · Name"). */
  const colTitle = (f: Field) => cfg?.labels[f.key] || (cfg && f.group !== cfg.source && !norm(f.label).includes(norm(glabel(f.group))) ? `${glabel(f.group)} · ${f.label}` : f.label);
  /* ---- the table ---- */
  const colFields = (cfg?.cols ?? []).map((k) => fieldByKey.get(k)).filter((f): f is Field => !!f);
  const sortCfg = cfg?.sort ?? null, groupKey = cfg?.groupBy ?? null;
  const sorted = useMemo(() => {
    const f = sortCfg ? fieldByKey.get(sortCfg.key) : null;
    const g = groupKey ? fieldByKey.get(groupKey) : null;
    const out = [...rows];
    out.sort((a, b) => {
      if (g) { const ga = String(g.get(a as any) ?? "—"), gb = String(g.get(b as any) ?? "—"); if (ga !== gb) return ga.localeCompare(gb); }
      if (!f || !sortCfg) return 0;
      const va = sortValue(toCell(f, f.get(a as any))), vb = sortValue(toCell(f, f.get(b as any)));
      if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return sortCfg.dir === "asc" ? c : -c;
    });
    return out;
  }, [rows, sortCfg, groupKey, fieldByKey]);
  const numeric = (f: Field) => f.kind === "money" || f.kind === "number" || f.kind === "percent";
  const totalOf = (f: Field, rs: CrmRow[]) => {
    const ns = rs.map((r) => Number(f.get(r as any))).filter((n) => Number.isFinite(n));
    if (!ns.length) return null;
    return f.kind === "percent" ? ns.reduce((a, b) => a + b, 0) / ns.length : ns.reduce((a, b) => a + b, 0);
  };
  const exportAs = (kind: "xlsx" | "csv") => {
    if (!cfg) return;
    const columns: ExportColumn[] = colFields.map((f) => ({ label: colTitle(f), format: f.kind === "money" ? "money" : f.kind === "number" ? "number" : f.kind === "percent" ? "percent" : f.kind === "date" ? "date" : "text" }));
    const t = { columns, rows: sorted.map((r) => colFields.map((f) => toCell(f, f.get(r as any)))) };
    const file = `${cfg.name || "Report"} ${new Date().toISOString().slice(0, 10)}`;
    downloadBlob(kind === "xlsx" ? tableToXlsx(t, (cfg.name || "Report").slice(0, 28)) : tableToCsv(t), `${file}.${kind}`);
  };

  /* ---- helpers for the steps ---- */
  const moveCol = (i: number, d: -1 | 1) => { if (!cfg) return; const xs = [...cfg.cols]; const j = i + d; if (j < 0 || j >= xs.length) return; [xs[i], xs[j]] = [xs[j], xs[i]]; set({ cols: xs }); };
  const addChart = (pr?: Omit<CrmChart, "id">) => {
    if (!cfg) return;
    const id = uid();
    const blank: Omit<CrmChart, "id"> = { title: "New chart", type: "bar", dim: cfg.groupBy ?? cfg.cols.find((k) => fieldByKey.get(k)?.kind === "enum") ?? cfg.cols[0] ?? "", fn: "count", value: null, split: null };
    set({ charts: [...cfg.charts, { ...(pr ?? blank), id }] });
    if (!pr) setOpenChart(id);
    scrollToChart.current = id;
  };
  const setChart = (id: string, p: Partial<CrmChart>) => cfg && set({ charts: cfg.charts.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const dupChart = (ch: CrmChart) => {
    if (!cfg) return;
    const id = uid(); const i = cfg.charts.findIndex((c) => c.id === ch.id);
    const xs = [...cfg.charts]; xs.splice(i + 1, 0, { ...ch, id, title: `${ch.title} (copy)` });
    set({ charts: xs }); scrollToChart.current = id;
  };
  /** From the result (or the preview): straight to that chart's settings. */
  const editChart = (id: string) => { if (mode !== "build") { setMode("build"); setPanel(null); } setOpenChart(id); scrollToChart.current = id; };
  /** "Add a filter": an empty rule, ready to pick its field. */
  const addFilter = () => { if (!cfg) return; set({ filter: { ...cfg.filter, items: [...cfg.filter.items, rule("", "")] } }); setPanel("filter"); };
  /** A field's name in a picker: a field of another part says whose it is ("Company · Country"). */
  const fl = (f: Field) => (cfg && f.group !== cfg.source && !norm(f.label).includes(norm(glabel(f.group))) ? `${glabel(f.group)} · ${f.label}` : f.label);
  const dimOptions: SmfOption[] = [
    ...fields.filter((f) => f.kind !== "date").map((f) => ({ value: f.key, label: fl(f), group: glabel(f.group), hint: KIND_ICON[f.kind] })),
    ...fields.filter((f) => f.kind === "date").flatMap((f) => (["month", "quarter", "year", "week"] as const).map((g) => ({ value: `time:${g}:${f.key}`, label: `${fl(f)} · by ${g}`, group: `Over time · ${glabel(f.group)}` }))),
  ];
  const numFields = fields.filter(numeric);
  const nRules = cfg ? countRules(cfg.filter) : 0;
  const ent = cfg ? entityOf(cfg.source) : null;
  const withList = cfg?.with ?? [];
  const parts = cfg ? partsOf(cfg.source, withList) : [];
  const many = withList.length > 0;
  // what a row is, in words
  const rowWord = (n: number) => (many ? (n === 1 ? "row" : "rows") : ent ? (n === 1 ? ent.label.toLowerCase() : ent.plural.toLowerCase()) : "");
  const listParts = cfg ? withList.filter((k) => isListLink(cfg.source, k)) : [];
  const rowsHint = !ent ? "" : listParts.length
    ? `One line for each ${ent.label.toLowerCase()} and each of its ${listParts.map((k) => entityOf(k).plural.toLowerCase()).join(" and ")}${listParts.length > 1 ? " together" : ""}.`
    : `One line for each ${ent.label.toLowerCase()}, with its ${withList.map((k) => entityOf(k).label.toLowerCase()).join(" and ")}.`;
  /** Rules, columns and charts on a part that left the report go with it. */
  const pruneTo = (c: CrmReport): CrmReport => {
    const alive = new Set(partsOf(c.source, c.with ?? []));
    const ok = (key: string | null | undefined) => { if (!key) return true; const k = key.startsWith("time:") ? key.split(":").slice(2).join(":") : key; return alive.has(k.split(".")[0] as EntityKey); };
    const tree = (g: CondGroup): CondGroup => ({ ...g, items: g.items.filter((it) => isGroup(it) || !it.field || ok(it.field)).map((it) => (isGroup(it) ? tree(it) : it)) });
    const cols = c.cols.filter(ok);
    return { ...c, filter: tree(c.filter), cols: cols.length ? cols : DEFAULT_COLS[c.source], sort: c.sort && ok(c.sort.key) ? c.sort : null, groupBy: ok(c.groupBy) ? c.groupBy : null, charts: c.charts.filter((ch) => ok(ch.dim) && ok(ch.value) && ok(ch.split)), figures: c.figures?.filter((fg) => ok(fg.value)) };
  };
  /** The rows changed: their own columns come first (a few of them if there were none). */
  const leadCols = (c: CrmReport): CrmReport => {
    const own = c.cols.filter((k) => k.startsWith(`${c.source}.`)), rest = c.cols.filter((k) => !k.startsWith(`${c.source}.`));
    return { ...c, cols: [...(own.length ? own : DEFAULT_COLS[c.source].slice(0, 3)), ...rest] };
  };
  const togglePart = (k: EntityKey) => {
    if (!cfg) return;
    const w = cfg.with ?? [];
    if (k === cfg.source) { if (!w.length) return; setCfg(leadCols(pruneTo({ ...cfg, source: w[0], with: w.slice(1) }))); return; }
    if (w.includes(k)) { setCfg(pruneTo({ ...cfg, with: w.filter((x) => x !== k) })); return; }
    // a new part: in, with a few of its columns
    setCfg({ ...cfg, with: [...w, k], cols: [...cfg.cols, ...DEFAULT_COLS[k].slice(0, 3).filter((c) => !cfg.cols.includes(c))] });
  };
  const makeMain = (k: EntityKey) => { if (!cfg || k === cfg.source) return; setCfg(leadCols(pruneTo({ ...cfg, source: k, with: [cfg.source, ...(cfg.with ?? []).filter((x) => x !== k)] }))); };
  const list = saved.filter((s) => !q || norm(s.name).includes(norm(q)));
  const sourceOf = (s: SavedReport) => (s.config?.v === 2 ? s.config.source : "deal") as EntityKey;
  const partsLabel = (s: SavedReport) => [sourceOf(s), ...((s.config?.v === 2 && Array.isArray(s.config.with) ? s.config.with : []) as EntityKey[])].map((k) => entityOf(k)?.plural ?? k).join(" + ");

  /* ---- render pieces ---- */
  const table = (limit: number, editable = true): ReactNode => {
    if (!cfg) return null;
    const g = cfg.groupBy ? fieldByKey.get(cfg.groupBy) : null;
    const body: ReactNode[] = [];
    let last: string | null = null;
    sorted.slice(0, limit).forEach((r, i) => {
      if (g) {
        const gv = String(g.get(r as any) ?? "—");
        if (gv !== last) {
          last = gv;
          const inGroup = sorted.filter((x) => String(g.get(x as any) ?? "—") === gv);
          body.push(
            <tr className="rp-tgrp" key={`g${i}`}>
              <td><b>{gv}</b><em>{inGroup.length}</em></td>
              {colFields.slice(1).map((f) => <td key={f.key} className={numeric(f) ? "is-num" : ""}>{cfg.totals && numeric(f) ? showCell(f, totalOf(f, inGroup)) : ""}</td>)}
            </tr>,
          );
        }
      }
      const link = rowLink(cfg.source, r);
      body.push(<tr key={i} className={link ? "is-link" : undefined} onClick={link ? (e) => { if (!(window.getSelection()?.toString())) { e.preventDefault(); openRow(r); } } : undefined}
        title={link ? `Open this ${entityOf(cfg.source)?.label.toLowerCase() ?? "row"}` : undefined}>{colFields.map((f) => <td key={f.key} className={numeric(f) ? "is-num" : ""}>{showCell(f, toCell(f, f.get(r as any))) || <span className="rp-dash">—</span>}</td>)}</tr>);
    });
    return (
      <div className="rp-twrap">
        <table className="rp-table">
          <thead>
            <tr>
              {colFields.map((f) => {
                const on = cfg.sort?.key === f.key;
                if (!editable) return <th key={f.key} className={`${numeric(f) ? "is-num" : ""} is-ro`}><span className="rp-th-s">{colTitle(f)}</span></th>;
                return (
                  <th key={f.key} className={numeric(f) ? "is-num" : ""}>
                    <button type="button" className={on ? "is-on" : ""} title="Sort"
                      onClick={() => set({ sort: on && cfg.sort!.dir === "desc" ? { key: f.key, dir: "asc" } : on ? null : { key: f.key, dir: "desc" } })}>
                      <span>{colTitle(f)}</span>{on && <Ico d={cfg.sort!.dir === "asc" ? I.up : I.dn} w={2.4} />}
                    </button>
                    <button type="button" className="rp-th-x" onClick={() => set({ cols: cfg.cols.filter((x) => x !== f.key) })} title="Take this column out" aria-label={`Take out ${colTitle(f)}`}><Ico d={I.x} w={2.6} /></button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>{body}</tbody>
          {cfg.totals && colFields.some(numeric) && sorted.length > 0 && (
            <tfoot><tr>{colFields.map((f, i) => <td key={f.key} className={numeric(f) ? "is-num" : ""}>{i === 0 ? `Total · ${sorted.length.toLocaleString("en-GB")}` : numeric(f) ? showCell(f, totalOf(f, sorted)) : ""}</td>)}</tr></tfoot>
          )}
        </table>
        {sorted.length === 0 && !loading && !editable && (
          <div className="rp-nothing">
            <b>{nRules ? "Nothing matches this report's rules right now." : "There's nothing of this kind in the CRM yet."}</b>
            {nRules > 0 && <span>Its rules may be for a period that has no records yet.<button type="button" className="rp-link" onClick={() => switchMode("build")}>Change the rules</button></span>}
          </div>
        )}
        {sorted.length === 0 && !loading && editable && (
          <div className="rp-nothing">
            <b>Nothing matches all these rules together.</b>
            {blocker ? (
              <span>Without <em>“{ruleText(blocker.rule)}”</em> there would be {blocker.n.toLocaleString("en-GB")} {rowWord(blocker.n)}.
                <button type="button" className="rp-link" onClick={() => set({ filter: withoutRule(cfg.filter, blocker.rule.id) })}>Take that rule out</button></span>
            ) : nRules ? <span>Each value shows how many it keeps — pick ones that aren't 0.</span> : <span>There's nothing of this kind in the CRM yet.</span>}
          </div>
        )}
        {sorted.length > limit && limit > 20 && <button type="button" className="rp-more" onClick={() => setShown((n) => n + 500)}>Show {Math.min(500, sorted.length - limit).toLocaleString("en-GB")} more · {sorted.length.toLocaleString("en-GB")} in all</button>}
      </div>
    );
  };
  /* ---- dragging (charts and columns): armed from a grip, so inputs inside still select text ---- */
  const dragProps = (id: string, onMove: (from: string, to: string, after: boolean) => void, vertical = false) => ({
    draggable: dragArm === id,
    onDragStart: (e: RDragEvent) => { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch { /* */ } setDragId(id); },
    onDragOver: (e: RDragEvent<HTMLElement>) => {
      if (!dragId || dragId === id) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      const after = vertical ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
      if (dragOver?.id !== id || dragOver.after !== after) setDragOver({ id, after });
    },
    onDrop: (e: RDragEvent) => { e.preventDefault(); if (dragId && dragOver) onMove(dragId, dragOver.id, dragOver.after); setDragId(null); setDragOver(null); setDragArm(null); },
    onDragEnd: () => { setDragId(null); setDragOver(null); setDragArm(null); },
  });
  const dragCls = (id: string) => `${dragId === id ? "is-dragging" : ""} ${dragOver?.id === id ? (dragOver.after ? "is-drop-after" : "is-drop-before") : ""}`;
  const gripProps = (id: string) => ({
    onPointerDown: () => setDragArm(id), onPointerUp: () => { if (!dragId) setDragArm(null); },
    title: "Drag to move", "aria-hidden": true as const,
  });

  /* ---- charts ---- */
  const isTimeDim = (dim: string) => dim.startsWith("time:");
  const dimLabel = (dim: string) => {
    const f = fieldByKey.get(dim.startsWith("time:") ? dim.split(":").slice(2).join(":") : dim);
    const l = dimOptions.find((o) => o.value === dim)?.label ?? f?.label ?? "—";
    return f && cfg && f.group !== cfg.source && !norm(l).includes(norm(glabel(f.group))) ? `${glabel(f.group)} ${l}` : l;
  };
  const chartSub = (ch: CrmChart) => {
    const vf = ch.value ? fieldByKey.get(ch.value) : null;
    const what = ch.fn === "count" || !vf ? "How many" : `${FN_LABEL[ch.fn === "sum" && vf.kind === "percent" ? "avg" : ch.fn]} of ${low(vf.label)}`;
    const sp = ch.split ? fieldByKey.get(ch.split) : null;
    return [what, `by ${low(dimLabel(ch.dim))}`, sp ? `split by ${low(sp.label)}` : "", ch.top ? `top ${ch.top}` : "", ch.cumulative ? "running total" : ""].filter(Boolean).join(" · ");
  };
  const splitOptions: SmfOption[] = [{ value: "__none", label: "No split" }, ...fields.filter((f) => f.kind === "enum" || f.kind === "text").map((f) => ({ value: f.key, label: fl(f), group: glabel(f.group), hint: KIND_ICON[f.kind] }))];
  /** Charts that fit this report, one click each (built from its own fields). */
  const suggestions = useMemo((): Omit<CrmChart, "id">[] => {
    if (!cfg || !fields.length) return [];
    const e = entityOf(cfg.source);
    const lc = low;
    const own = fields.filter((f) => f.group === cfg.source && !f.key.endsWith(".__count"));
    const fit = (f: Field) => f.kind === "enum" && !/name|email|phone|website|url/i.test(f.key) && (() => { const n = valuesOf(f).length; return n >= 2 && n <= 40; })();
    // its own categories first, then those of what comes along (a contact's company country…)
    const enums = [...own.filter(fit), ...fields.filter((f) => f.group !== cfg.source && fit(f))].slice(0, 4);
    const money = own.filter((f) => f.kind === "money");
    const dates = own.filter((f) => f.kind === "date");
    const name = own.find((f) => /\.(name|title)$/.test(f.key));
    const out: Omit<CrmChart, "id">[] = [];
    const nm = (f: Field) => (f.group === cfg.source ? lc(f.label) : `${lc(glabel(f.group))} ${lc(f.label)}`);
    const stage = enums.find((f) => /phase|stage/i.test(f.key));
    if (stage) out.push({ title: `Funnel by ${nm(stage)}`, type: "funnel", dim: stage.key, fn: "count", value: null, split: null });
    enums.slice(0, 3).forEach((f, i) => out.push({ title: `${e.plural} by ${nm(f)}`, type: i % 2 ? "donut" : "bar", dim: f.key, fn: "count", value: null, split: null }));
    if (money[0] && enums[0]) out.push({ title: `${money[0].label} by ${nm(enums[0])}`, type: "bar", dim: enums[0].key, fn: "sum", value: money[0].key, split: null });
    if (money[0] && name) out.push({ title: `Top 10 by ${lc(money[0].label)}`, type: "hbar", dim: name.key, fn: "sum", value: money[0].key, split: null, top: 10, order: "high" });
    if (dates[0]) out.push({ title: `${money[0] ? money[0].label : e.plural} by month · ${lc(dates[0].label)}`, type: "area", dim: `time:month:${dates[0].key}`, fn: money[0] ? "sum" : "count", value: money[0]?.key ?? null, split: null, size: "l" });
    if (dates[0] && money[0]) out.push({ title: `${money[0].label} · running total`, type: "line", dim: `time:month:${dates[0].key}`, fn: "sum", value: money[0].key, split: null, cumulative: true, size: "l" });
    if (enums.length >= 2) out.push({ title: `${enums[1].group === cfg.source ? enums[1].label : `${glabel(enums[1].group)} ${lc(enums[1].label)}`} by ${nm(enums[0])}`, type: "stacked", dim: enums[1].key, fn: "count", value: null, split: enums[0].key });
    const seen = new Set<string>();
    return out.filter((c) => { const k = `${c.type}|${c.dim}|${c.fn}|${c.value}|${c.split}|${c.cumulative}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
  }, [cfg?.source, fields, valuesOf]); // eslint-disable-line react-hooks/exhaustive-deps

  // each chart is worked out once per set of rows (not again on every key typed in the report)
  const aggCache = useMemo(() => new Map<string, Agg>(), [rows, fieldByKey]);
  const aggOf = (ch: CrmChart): Agg => {
    const k = JSON.stringify([ch.dim, ch.fn, ch.value, ch.split, !!ch.cumulative, ch.top ?? null, ch.order ?? null]);
    let a = aggCache.get(k);
    if (!a) { a = aggregateCrm({ rows, dim: ch.dim, fn: ch.fn, value: ch.value, split: ch.split, fieldByKey, cumulative: ch.cumulative, limit: ch.top === 0 ? 60 : ch.top ?? undefined, order: ch.order, other: ch.top ? false : undefined }); aggCache.set(k, a); }
    return a;
  };
  const chartCard = (ch: CrmChart, i: number, mode: "edit" | "view"): ReactNode => {
    const agg = aggOf(ch);
    const editable = mode === "edit";
    const open = editable && openChart === ch.id;
    const sz = sizeOf(ch);
    const move = (from: string, to: string, after: boolean) => cfg && set({ charts: moveBy(cfg.charts, from, to, after) });
    return (
      <div className={`rp-chart sz-${sz} ${editable ? "is-edit" : ""} ${open ? "is-open" : ""} ${editable ? dragCls(ch.id) : ""}`} key={ch.id} data-chart={ch.id}
        style={vars({ "--i": i, "--c": PALETTE[i % PALETTE.length] })} {...(editable ? dragProps(ch.id, move) : {})}>
        <div className="rp-chart-h">
          {editable && <span className="rp-grip" {...gripProps(ch.id)}><Grip /></span>}
          <div className="rp-chart-ht">
            {editable ? <input className="rp-chart-t" value={ch.title} onChange={(e) => setChart(ch.id, { title: e.target.value })} aria-label="Chart title" /> : <b>{ch.title}</b>}
            <em>{chartSub(ch)}</em>
          </div>
          {editable ? (
            <div className="rp-chart-tools">
              <div className="rp-size" role="radiogroup" aria-label="Width">
                {(["s", "m", "l"] as ChartSize[]).map((z) => (
                  <button type="button" key={z} role="radio" aria-checked={sz === z} className={sz === z ? "is-on" : ""} title={SIZE_LABEL[z]} onClick={() => setChart(ch.id, { size: z })}>
                    <span className={`rp-size-ico is-${z}`}><i /><i /><i /></span>
                  </button>
                ))}
              </div>
              <button type="button" className={`rp-tool ${open ? "is-on" : ""}`} onClick={() => setOpenChart(open ? null : ch.id)} aria-pressed={open} title="Chart settings"><Ico d={I.sliders} /></button>
              <button type="button" className="rp-tool" onClick={() => dupChart(ch)} title="Duplicate"><Ico d={I.copy} /></button>
              <button type="button" className="rp-tool is-del" onClick={() => { set({ charts: cfg!.charts.filter((c) => c.id !== ch.id) }); if (open) setOpenChart(null); }} title="Remove"><Ico d={I.trash} /></button>
            </div>
          ) : (
            <button type="button" className="rp-tool is-ghost" onClick={() => editChart(ch.id)} title="Change this chart"><Ico d={I.edit} /></button>
          )}
        </div>
        {open && (
          <div className="rp-chart-set">
            <div className="rp-types" role="radiogroup" aria-label="Chart type">
              {(Object.keys(CHART_LABEL) as ChartType[]).map((t) => (
                <button type="button" key={t} role="radio" aria-checked={ch.type === t} className={`rp-type ${ch.type === t ? "is-on" : ""}`} onClick={() => setChart(ch.id, { type: t })}>
                  <span className={`rb-preset-ico is-${t}`}><i /><i /><i /></span>{CHART_LABEL[t]}
                </button>
              ))}
            </div>
            <div className="rp-chart-cfg">
              <label><span>By</span><SalesMultiFilter single values={ch.dim ? [ch.dim] : []} onChange={(v) => v[0] && setChart(ch.id, { dim: v[0] })} options={dimOptions} placeholder="Pick…" searchFrom={8} /></label>
              <label><span>Figure</span><SalesMultiFilter single values={[ch.fn]} onChange={(v) => v[0] && setChart(ch.id, { fn: v[0] as CrmFn, value: v[0] === "count" ? null : ch.value ?? numFields[0]?.key ?? null })} options={(Object.keys(FN_LABEL) as CrmFn[]).map((f) => ({ value: f, label: f === "count" ? "How many" : `${FN_LABEL[f]} of…` }))} placeholder="Figure" /></label>
              {ch.fn !== "count" && <label><span>Of</span><FieldPick fields={numFields} main={cfg?.source} value={ch.value} onChange={(k) => setChart(ch.id, { value: k })} placeholder="A number…" /></label>}
              <label><span>Split by</span><SalesMultiFilter single values={[ch.split ?? "__none"]} onChange={(v) => setChart(ch.id, { split: v[0] && v[0] !== "__none" ? v[0] : null })} options={splitOptions} placeholder="No split" searchFrom={8} /></label>
            </div>
            <div className="rp-chart-opts">
              {!isTimeDim(ch.dim) && (
                <div className="rp-opt"><span>Show</span>
                  <div className="rp-seg is-light">
                    {TOPS.map((t) => <button type="button" key={t.label} className={(ch.top ?? null) === t.v ? "is-on" : ""} onClick={() => setChart(ch.id, { top: t.v ?? undefined })}>{t.v ? `Top ${t.label}` : t.label}</button>)}
                  </div>
                </div>
              )}
              {!isTimeDim(ch.dim) && (
                <div className="rp-opt"><span>Order</span>
                  <div className="rp-seg is-light">
                    {(Object.keys(ORDER_LABEL) as ChartOrder[]).map((o) => <button type="button" key={o} className={(ch.order ?? "auto") === o ? "is-on" : ""} onClick={() => setChart(ch.id, { order: o })}>{ORDER_LABEL[o]}</button>)}
                  </div>
                </div>
              )}
              <label className="rp-chk"><input type="checkbox" checked={!!ch.cumulative} onChange={(e) => setChart(ch.id, { cumulative: e.target.checked })} /><span>Running total</span></label>
            </div>
          </div>
        )}
        <div className="rp-chart-body">{agg.keys.length ? <ReportChart type={ch.type} agg={agg} /> : <p className="rp-none">No data for this chart yet.</p>}</div>
      </div>
    );
  };
  const chartGrid = (mode: "edit" | "view"): ReactNode => cfg && cfg.charts.length > 0 && (
    <div className={`rp-charts is-grid ${mode === "edit" ? "is-edit" : ""} ${dragId ? "is-dragging" : ""}`}>{cfg.charts.map((c, i) => chartCard(c, i, mode))}</div>
  );

  /* ---- figures on top ---- */
  const autoFigures = (): CrmFigure[] => [{ id: "count", fn: "count", value: null }, ...colFields.filter((f) => f.kind === "money").slice(0, 3).map((f) => ({ id: f.key, fn: "sum" as CrmFn, value: f.key }))];
  const figures = cfg ? cfg.figures ?? autoFigures() : [];
  const figValue = (fg: CrmFigure): { label: string; value: string; sub: string } => {
    const f = fg.value ? fieldByKey.get(fg.value) : undefined;
    if (fg.fn === "count" || !f) return { label: fg.label || (many ? "Rows" : ent?.plural ?? "Rows"), value: rows.length.toLocaleString("en-GB"), sub: `of ${allRows.length.toLocaleString("en-GB")} · ${nRules ? `${nRules} rule${nRules === 1 ? "" : "s"}` : "no rules"}` };
    const ns = rows.map((r) => Number(f.get(r as any))).filter((n) => Number.isFinite(n));
    // a percentage doesn't add up: its "total" is its average
    const fn = fg.fn === "sum" && f.kind === "percent" ? "avg" : fg.fn;
    const v = !ns.length ? 0 : fn === "sum" ? ns.reduce((a, b) => a + b, 0) : fn === "avg" ? ns.reduce((a, b) => a + b, 0) / ns.length : fn === "min" ? Math.min(...ns) : Math.max(...ns);
    const word = { sum: "total", avg: "average", min: "lowest", max: "highest", count: "" }[fn];
    return { label: fg.label || cfg?.labels[f.key] || f.label, value: showCell(f, v) || "0", sub: `${glabel(f.group)} · ${word}` };
  };
  const setFigures = (xs: CrmFigure[]) => set({ figures: xs });
  const kpis = (editable = false): ReactNode => {
    if (!cfg) return null;
    const move = (from: string, to: string, after: boolean) => setFigures(moveBy(figures, from, to, after));
    return (
      <div className={`rp-kpis ${editable ? "is-edit" : ""}`}>
        {figures.map((fg, i) => {
          const x = figValue(fg);
          return (
            <div className={`rp-kpi ${editable ? dragCls(fg.id) : ""}`} key={fg.id} style={vars({ "--c": i === 0 ? ent?.tone ?? "#1fb98a" : PALETTE[i % PALETTE.length], "--i": i })} {...(editable ? dragProps(fg.id, move) : {})}>
              {editable && <span className="rp-grip is-kpi" {...gripProps(fg.id)}><Grip /></span>}
              <span>{x.label}</span><b>{x.value}</b><em>{x.sub}</em>
              {editable && <button type="button" className="rp-x rp-kpi-x" onClick={() => setFigures(figures.filter((y) => y.id !== fg.id))} aria-label={`Remove ${x.label}`}><Ico d={I.x} w={2.4} /></button>}
            </div>
          );
        })}
        {editable && (figDraft ? (
          <div className="rp-kpi is-add is-open">
            <SalesMultiFilter single values={[figDraft.fn]} onChange={(v) => v[0] && setFigDraft({ fn: v[0] as CrmFn, value: v[0] === "count" ? null : figDraft.value ?? numFields[0]?.key ?? null })} options={(Object.keys(FN_LABEL) as CrmFn[]).map((f) => ({ value: f, label: f === "count" ? "How many" : f === "sum" ? "Total of…" : `${FN_LABEL[f]} of…` }))} placeholder="Figure" />
            {figDraft.fn !== "count" && <FieldPick fields={numFields} main={cfg.source} value={figDraft.value} onChange={(k) => setFigDraft({ ...figDraft, value: k })} placeholder="A number…" />}
            <div className="rp-kpi-acts">
              <button type="button" className="rp-btn is-ghost" onClick={() => setFigDraft(null)}>Cancel</button>
              <button type="button" className="rp-btn is-main" disabled={figDraft.fn !== "count" && !figDraft.value} onClick={() => { setFigures([...figures, { id: uid(), fn: figDraft.fn, value: figDraft.fn === "count" ? null : figDraft.value }]); setFigDraft(null); }}>Add</button>
            </div>
          </div>
        ) : (
          <button type="button" className="rp-kpi is-add" onClick={() => { const nf = numFields.find((f) => f.kind === "money" && !figures.some((x) => x.value === f.key)) ?? numFields.find((f) => !figures.some((x) => x.value === f.key)) ?? numFields[0]; setFigDraft({ fn: nf?.kind === "percent" ? "avg" : "sum", value: nf?.key ?? null }); }}><Ico d={I.plus} w={2.4} /><b>Add a figure</b><em>A count, total, average, lowest or highest</em></button>
        ))}
      </div>
    );
  };

  /* ---------------------------------------------------------------- */
  return (
    <div className="rp">
      <header className="rp-hero">
        <div className="rp-hero-t">
          <h1>Reports</h1>
          <p>Every part of the CRM — every field, your rules, your charts.{saved.length ? ` ${saved.length} saved report${saved.length === 1 ? "" : "s"}.` : ""}</p>
        </div>
        <div className="rp-hero-acts">
          {cfg && <button type="button" className="rp-btn is-glass" onClick={() => { forgetCrmData(); setDataTick((x) => x + 1); }} title="Read the CRM again"><Ico d={I.refresh} />Refresh data</button>}
          <button type="button" className="rp-btn is-mint" onClick={() => { if (!leaveOk()) return; start(newReport("deal")); }}><Ico d={I.plus} w={2.4} />New report</button>
        </div>
      </header>

      <div className={`rp-body ${cfg && mode === "view" ? "is-view" : ""}`}>
        <aside className="rp-side" aria-label="Saved reports">
          <div className="rp-side-hh">
            <p className="rp-side-h">Saved reports</p>
            {!tableMissing && <button type="button" className="rp-fold-add" disabled={!foldersOk} title={foldersOk ? "A folder for your reports" : NEEDS_FOLDERS} onClick={() => setFNew("")}><Ico d={I.plus} w={2.4} />Folder</button>}
          </div>
          <label className="rp-search"><Ico d={I.search} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a report" /></label>
          {fNew != null && (
            <label className="rp-fold-new"><Ico d={I.folder} />
              <input autoFocus value={fNew} placeholder="Folder name — e.g. Pipeline" aria-label="New folder name" onChange={(e) => setFNew(e.target.value)} onBlur={() => void addFolder(fNew)}
                onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); if (e.key === "Escape") setFNew(null); }} />
            </label>
          )}
          {tableMissing && <p className="rp-none">Saved reports need the sales_reports table.</p>}
          {!tableMissing && !list.length && (q ? <p className="rp-none">No report matches.</p> : (
            <div className="rp-side-empty">
              <span><Ico d={I.chart} /></span>
              <b>No saved reports yet</b>
              <em>Build one and press Save — it stays here for you, or for the whole team if you share it.</em>
            </div>
          ))}
          <div className="rp-saved">
            {(() => {
              const row = (s: SavedReport) => {
                const e = entityOf(sourceOf(s));
                const fo = folderOf(s.id);
                return (
                  <div className={`rp-sv ${s.id === reportId ? "is-on" : ""} ${dragRep === s.id ? "is-drag" : ""} ${moveOpen === s.id ? "is-menu" : ""}`} key={s.id} style={vars({ "--c": e.tone })}
                    draggable={folders.length > 0} onDragStart={(ev) => { setDragRep(s.id); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", s.name); }} onDragEnd={() => { setDragRep(null); setDropOn(null); }}>
                    <button type="button" className="rp-sv-main" onClick={() => open(s)}>
                      <span className="rp-sv-ico"><Ico d={e.icon} /></span>
                      <span className="rp-sv-t"><b>{s.name}</b><em>{partsLabel(s)}{s.shared ? " · shared" : ""}{s.owner_id && me && s.owner_id !== me ? " · someone else's" : ""}</em></span>
                    </button>
                    {foldersOk && (
                      <span className="rp-mv-w">
                        <button type="button" className={`rp-x rp-mv ${moveOpen === s.id ? "is-on" : ""}`} onClick={(ev) => { placeMenu(ev.currentTarget); setFMenu(null); setMoveOpen(moveOpen === s.id ? null : s.id); }} aria-label={`Move ${s.name} to a folder`} title="Move to a folder" aria-expanded={moveOpen === s.id}><Ico d={I.folder} /></button>
                        {moveOpen === s.id && (
                          <div className="rp-mv-menu" role="menu" style={menuAt}>
                            <b>Move to</b>
                            {folders.map((f) => (
                              <button key={f.id} type="button" role="menuitemradio" aria-checked={fo?.id === f.id} className={fo?.id === f.id ? "is-on" : ""} onClick={() => { setMoveOpen(null); void moveTo(s.id, f.id); }}>
                                <i style={{ background: f.color || "#0a6f4d" }} /><span>{f.name}</span>{fo?.id === f.id && <Ico d={I.check} w={2.4} />}
                              </button>
                            ))}
                            {folders.length > 0 && <button type="button" role="menuitemradio" aria-checked={!fo} className={!fo ? "is-on" : ""} onClick={() => { setMoveOpen(null); void moveTo(s.id, null); }}><i className="is-none" /><span>Not in a folder</span>{!fo && <Ico d={I.check} w={2.4} />}</button>}
                            <button type="button" className="is-add" onClick={() => { setMoveOpen(null); setFNew(""); }}><Ico d={I.plus} w={2.4} /><span>New folder…</span></button>
                          </div>
                        )}
                      </span>
                    )}
                    {(!s.owner_id || s.owner_id === me) && <button type="button" className="rp-x" onClick={() => void remove(s)} aria-label={`Delete ${s.name}`}><Ico d={I.trash} /></button>}
                  </div>
                );
              };
              const loose = list.filter((s) => !folderOf(s.id));
              return <>
                {folders.map((f) => {
                  const items = list.filter((s) => f.report_ids.includes(s.id));
                  if (q && !items.length) return null;
                  const isOpen = !!q || !closed.has(f.id);
                  return (
                    <div key={f.id} className={`rp-fold ${dropOn === f.id ? "is-drop" : ""} ${isOpen ? "is-open" : ""}`} style={vars({ "--fc": f.color || "#0a6f4d" })} {...dropTarget(f.id)}>
                      <div className={`rp-fold-h ${fMenu === f.id ? "is-menu" : ""}`}>
                        {fEdit?.id === f.id ? (
                          <input className="rp-fold-in" autoFocus value={fEdit.name} aria-label="Folder name" onChange={(e) => setFEdit({ id: f.id, name: e.target.value })}
                            onBlur={() => { if (fEdit.name.trim() && fEdit.name.trim() !== f.name) void patchFolder(f, { name: fEdit.name.trim() }); setFEdit(null); }}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); if (e.key === "Escape") setFEdit(null); }} />
                        ) : (
                          <button type="button" className="rp-fold-b" onClick={() => toggleFolder(f.id)} onDoubleClick={() => setFEdit({ id: f.id, name: f.name })} aria-expanded={isOpen} title={`${f.name} — double-click to rename`}>
                            <span className="rp-fold-car"><Ico d={I.right} w={2.4} /></span>
                            <span className="rp-fold-ico"><Ico d={I.folder} /></span>
                            <b>{f.name}</b><em>{items.length}</em>
                          </button>
                        )}
                        <button type="button" className={`rp-fold-more ${fMenu === f.id ? "is-on" : ""}`} onClick={(ev) => { placeMenu(ev.currentTarget); setMoveOpen(null); setFMenu(fMenu === f.id ? null : f.id); }} aria-label={`${f.name}: options`} aria-expanded={fMenu === f.id}><Ico d={I.more} /></button>
                        {fMenu === f.id && (
                          <div className="rp-fold-menu" role="menu" style={menuAt}>
                            <button type="button" role="menuitem" onClick={() => { setFMenu(null); setFEdit({ id: f.id, name: f.name }); }}><Ico d={I.edit} />Rename</button>
                            <div className="rp-fold-cols" role="group" aria-label="Colour">
                              {FOLDER_COLORS.map((c) => <button key={c} type="button" className={(f.color || "#0a6f4d") === c ? "is-on" : ""} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => void patchFolder(f, { color: c })} />)}
                            </div>
                            <button type="button" role="menuitem" className="is-danger" onClick={() => { setFMenu(null); void dropFolder(f); }}><Ico d={I.trash} />Delete folder</button>
                          </div>
                        )}
                      </div>
                      {isOpen && (
                        <div className="rp-fold-list">
                          {items.length ? items.map(row) : <p className="rp-fold-empty">{dragRep ? "Drop it here" : "Empty — drag a report here"}</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
                {folders.length > 0 && (loose.length > 0 || dragRep) ? (
                  <div className={`rp-loose ${dropOn === "none" ? "is-drop" : ""}`} {...dropTarget("none")}>
                    <p className="rp-loose-h">Not in a folder<em>{loose.length}</em></p>
                    {loose.map(row)}
                  </div>
                ) : loose.map(row)}
              </>;
            })()}
          </div>
        </aside>

        <main className="rp-main">
          {!cfg ? (
            <div className="rp-start">
              <section className="rp-intro">
                <div className="rp-intro-t">
                  <span className="rp-eyebrow"><Ico d={I.spark} />Report builder</span>
                  <h2>What do you want to know?</h2>
                  <p>Pick a ready-made report, or what yours is about. The table shows up at once — then filter it, add columns, group it and add charts, right there.</p>
                </div>
              </section>

              <section className="rp-block">
                <div className="rp-block-h"><h3>Ready-made</h3><span>Opens with its rules and charts — change anything after</span></div>
                <div className="rp-tpls">
                  {TEMPLATES.map((t, i) => {
                    const r = t.make(); const e = entityOf(r.source); const n = countRules(r.filter);
                    return (
                      <button type="button" className="rp-tpl" key={t.title} style={vars({ "--c": e.tone, "--i": i })} onClick={() => start(r, null, false, false)}>
                        <span className="rp-tpl-top">
                          <span className="rp-tpl-ico"><Ico d={e.icon} /></span>
                          <span className="rp-tpl-ent">{e.plural}</span>
                          <span className="rp-tpl-go"><Ico d={I.right} w={2.4} /></span>
                        </span>
                        <b>{t.title}</b>
                        <em>{t.hint}</em>
                        <span className="rp-tpl-meta">
                          {n > 0 && <i><Ico d={I.group} />{n} rule{n === 1 ? "" : "s"}</i>}
                          <i><Ico d={I.edit} />{r.cols.length} columns</i>
                          {r.charts.length > 0 && <i><Ico d={I.chart} />{r.charts.length} chart{r.charts.length === 1 ? "" : "s"}</i>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rp-block">
                <div className="rp-block-h"><h3>From scratch</h3><span>What is the report about? Each row is one of these</span></div>
                <div className="rp-ents is-start">
                  {ENTITIES.map((e, i) => (
                    <button type="button" key={e.key} className="rp-ent" style={vars({ "--c": e.tone, "--i": i })} onClick={() => start(newReport(e.key))}>
                      <span className="rp-ent-ico"><Ico d={e.icon} /></span>
                      <span className="rp-ent-t"><b>{e.plural}</b><em>{e.hint}</em></span>
                      <span className="rp-ent-go"><Ico d={I.plus} w={2.4} /></span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <>
              <div className={`rp-bar ${mode === "view" ? "is-view" : ""}`}>
                {mode === "build" ? (
                  <>
                    <button type="button" className="rp-x rp-back" onClick={() => { if (!leaveOk()) return; setCfg(null); setReportId(null); }} aria-label="All reports and templates" title="All reports and templates"><Ico d={I.left} w={2.4} /></button>
                    <span className="rp-bar-ico" style={vars({ "--c": ent!.tone })}><Ico d={ent!.icon} /></span>
                    <input className="rp-name" value={cfg.name} onChange={(e) => set({ name: e.target.value })} aria-label="Report name" />
                  </>
                ) : (
                  <>
                    <button type="button" className="rp-crumb" onClick={() => { if (!leaveOk()) return; setCfg(null); setReportId(null); }} title="All reports and templates"><Ico d={I.left} w={2.4} />All reports</button>
                    <span className="rp-bar-gap" />
                  </>
                )}
                {loading ? <span className="rp-chip is-busy" role="status"><span className="rp-spin" />{loading}</span>
                  : <span className="rp-chip">{rows.length.toLocaleString("en-GB")} {rowWord(rows.length)}{allRows.length >= ROW_CAP ? " (first 200,000)" : ""}</span>}
                {mode === "view" && dirty && <span className="rp-chip is-draft" title="What you see includes changes that aren't saved yet">Unsaved changes</span>}
                <div className="rp-mode" role="radiogroup" aria-label="Build or view the report">
                  <button type="button" role="radio" aria-checked={mode === "build"} className={mode === "build" ? "is-on" : ""} onClick={() => switchMode("build")}><Ico d={I.edit} />Build</button>
                  <button type="button" role="radio" aria-checked={mode === "view"} className={mode === "view" ? "is-on" : ""} onClick={() => switchMode("view")}
                    title={reportId && !dirty ? "The report as it reads" : "See the report as it will read, without the building tools"}><Ico d={I.eye} />{reportId && !dirty ? "View" : "Preview"}</button>
                </div>
                {mode === "build" && (
                  <button type="button" className={`rp-share ${shared ? "is-on" : ""}`} onClick={() => setShared((v) => !v)} aria-pressed={shared}
                    title={shared ? "The whole team sees it (each with the records they may see). Click: only you." : "Only you see it. Click to share it with the team."}>
                    <Ico d={shared ? "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" : "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"} />{shared ? "Team" : "Only me"}
                  </button>
                )}
                <div className="rp-exp">
                  <button type="button" className={`rp-btn is-ghost ${expOpen ? "is-on" : ""}`} onClick={() => setExpOpen((v) => !v)} aria-expanded={expOpen} aria-haspopup="menu"><Ico d={I.down} />Export<Ico d={I.dn} w={2.4} /></button>
                  {expOpen && (
                    <div className="rp-exp-menu" role="menu">
                      <button type="button" role="menuitem" onClick={printReport} disabled={!!loading}><span className="rp-exp-ico is-pdf"><Ico d={I.print} /></span><span><b>PDF</b><em>Figures, charts and table, ready to print</em></span></button>
                      <button type="button" role="menuitem" onClick={() => { setExpOpen(false); exportAs("xlsx"); }} disabled={!rows.length}><span className="rp-exp-ico is-xls"><Ico d={I.sheet} /></span><span><b>Excel</b><em>The table, with its formats</em></span></button>
                      <button type="button" role="menuitem" onClick={() => { setExpOpen(false); exportAs("csv"); }} disabled={!rows.length}><span className="rp-exp-ico"><Ico d={I.down} /></span><span><b>CSV</b><em>The table as plain text</em></span></button>
                    </div>
                  )}
                </div>
                {mode === "build" && reportId && mine && <button type="button" className="rp-btn is-ghost rp-copy" onClick={() => void save(true)} disabled={busy} aria-label="Save as a copy" title="Save as a copy: keep this one as it is and save your changes as a new report"><Ico d={I.copy} />Copy</button>}
                {(mode === "build" || dirty || !reportId) && (
                  <button type="button" className="rp-btn is-main" onClick={() => void save()} disabled={busy || (!!reportId && !dirty && shared === sharedSnap)}><Ico d={I.check} w={2.4} />{busy ? "Saving…" : reportId && !dirty && shared === sharedSnap ? "Saved" : reportId && !mine ? "Save a copy" : "Save"}</button>
                )}
              </div>

              {loadErr && <div className="rp-err">Couldn't read the data: {loadErr}</div>}

              {mode === "view" ? (
                <div className="rp-view" id="rp-print">
                  <header className="rp-view-h">
                    <span className="rp-view-ico" style={vars({ "--c": ent!.tone })}><Ico d={ent!.icon} /></span>
                    <div className="rp-view-t">
                      <h2>{cfg.name.trim() || "Untitled report"}</h2>
                      <p>
                        <span>{[ent!.plural, ...withList.map((k) => entityOf(k).plural.toLowerCase())].join(" + ")}</span>
                        {usesPeriod && <span>{periodName} · {periodRange}</span>}
                        {cfg.groupBy && <span>By {low(fieldByKey.get(cfg.groupBy)?.label ?? "")}</span>}
                        <span>{(() => { const u = reportId ? saved.find((x) => x.id === reportId)?.updated_at : null; return dirty || !u ? "Not saved yet" : `Updated ${new Date(u).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`; })()}</span>
                      </p>
                    </div>
                    <span className="rp-view-print">{new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</span>
                  </header>
                  {kpis(false)}
                  {chartGrid("view")}
                  {cfg.cols.length > 0 && (
                    <section className="rp-card is-table is-view">
                      <div className="rp-thead">
                        <b>{rows.length.toLocaleString("en-GB")} {rowWord(rows.length)}</b>
                        <em>{cfg.groupBy ? `grouped by ${low(fieldByKey.get(cfg.groupBy)?.label ?? "")}` : ""}{cfg.sort && fieldByKey.get(cfg.sort.key) ? `${cfg.groupBy ? " · " : ""}${cfg.sort.dir === "desc" ? "highest" : "lowest"} ${low(colTitle(fieldByKey.get(cfg.sort.key)!))} first` : ""}</em>
                      </div>
                      {table(shown, false)}
                    </section>
                  )}
                </div>
              ) : (
              /* One page: the toolbar on top, the report under it — every change shows at once */
              <div className="rp-canvas">
                <div className="rp-tools" role="toolbar" aria-label="Build the report">
                  <button type="button" className={`rp-tb ${panel === "data" ? "is-on" : ""}`} onClick={() => togglePanel("data")} aria-expanded={panel === "data"} style={vars({ "--c": ent!.tone })}>
                    <span className="rp-tb-ico"><Ico d={ent!.icon} /></span>
                    <span className="rp-tb-t"><em>Each row is</em><b>{[ent!.label, ...withList.map((k) => entityOf(k).plural)].join(" + ")}</b></span>
                    <Ico d={I.dn} w={2.4} />
                  </button>
                  <button type="button" className={`rp-tb ${panel === "period" ? "is-on" : ""} ${usesPeriod ? "has-n" : ""}`} onClick={() => togglePanel("period")} aria-expanded={panel === "period"} style={vars({ "--c": "#b7791f" })}
                    title={usesPeriod ? `This report reads the period: ${periodRange}` : "The report's period: the period figures (ARR in the period, revenue, renewals…) and the rules on “the report's period” read it"}>
                    <span className="rp-tb-ico"><Ico d={I.cal} /></span>
                    <span className="rp-tb-t"><em>Period</em><b>{periodName}</b></span>
                    <Ico d={I.dn} w={2.4} />
                  </button>
                  <button type="button" className={`rp-tb ${panel === "filter" ? "is-on" : ""} ${nRules ? "has-n" : ""}`} onClick={() => togglePanel("filter")} aria-expanded={panel === "filter"}>
                    <span className="rp-tb-ico"><Ico d={I.group} /></span>
                    <span className="rp-tb-t"><em>Filter</em><b>{nRules ? `${nRules} rule${nRules === 1 ? "" : "s"}` : "All of them"}</b></span>
                    <Ico d={I.dn} w={2.4} />
                  </button>
                  <button type="button" className={`rp-tb ${panel === "cols" ? "is-on" : ""}`} onClick={() => togglePanel("cols")} aria-expanded={panel === "cols"}>
                    <span className="rp-tb-ico"><Ico d={I.edit} /></span>
                    <span className="rp-tb-t"><em>Columns</em><b>{cfg.cols.length} shown</b></span>
                    <Ico d={I.dn} w={2.4} />
                  </button>
                  <button type="button" className={`rp-tb ${panel === "charts" ? "is-on" : ""}`} onClick={() => togglePanel("charts")} aria-expanded={panel === "charts"}>
                    <span className="rp-tb-ico"><Ico d={I.chart} /></span>
                    <span className="rp-tb-t"><em>Charts</em><b>{cfg.charts.length ? `${cfg.charts.length} on the report` : "Add one"}</b></span>
                    <Ico d={I.dn} w={2.4} />
                  </button>
                </div>

                {panel && (
                  <section className={`rp-panel is-${panel}`} key={panel}>
                    <button type="button" className="rp-x rp-panel-x" onClick={() => setPanel(null)} aria-label="Close" title="Close (Esc)"><Ico d={I.x} w={2.4} /></button>
                    {panel === "data" && (
                <section className="rp-card">
                  <h3>What is this report about?</h3>
                  <p className="rp-help">Pick one or more. Each row is the first one; the others are linked to it — and when a row has several of them (a company's deals), it gets a line for each.</p>
                  <div className="rp-ents is-multi">
                    {ENTITIES.map((e, i) => {
                      const main = e.key === cfg.source, on = main || withList.includes(e.key), along = !on && parts.includes(e.key);
                      return (
                        <button type="button" key={e.key} aria-pressed={on} className={`rp-ent ${on ? "is-on" : ""} ${main ? "is-main" : ""}`} style={vars({ "--c": e.tone, "--i": i })} onClick={() => togglePart(e.key)}
                          title={main ? (withList.length ? "Take it out (the next one becomes the rows)" : "Each row is one of these") : on ? "Take it out of the report" : "Add it to the report"}>
                          <span className="rp-ent-top">
                            <span className="rp-ent-ico"><Ico d={e.icon} /></span>
                            <span className="rp-ent-tick" aria-hidden="true">{on && <Ico d={I.check} w={3} />}</span>
                          </span>
                          <b>{e.plural}</b><em>{e.hint}</em>
                          <span className="rp-ent-tags">
                            {main ? <i className="rp-ent-tag is-main">Each row</i>
                              : on ? <i className="rp-ent-tag">{isListLink(cfg.source, e.key) ? "Linked · a line each" : "Linked"}</i>
                              : along ? <i className="rp-ent-tag is-along">Comes along</i> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {withList.length > 0 && (
                    <div className="rp-rowis">
                      <span>Each row is</span>
                      <div className="rp-seg" role="radiogroup" aria-label="Each row is">
                        {[cfg.source, ...withList].map((k) => (
                          <button type="button" key={k} role="radio" aria-checked={k === cfg.source} className={k === cfg.source ? "is-on" : ""} onClick={() => makeMain(k)}>{entityOf(k).label.toLowerCase()}</button>
                        ))}
                      </div>
                      <em>{rowsHint}</em>
                    </div>
                  )}
                </section>
                    )}
                    {panel === "period" && (
                <section className="rp-card rp-period">
                  <h3>The report's period</h3>
                  <p className="rp-help">One period for the whole report. The figures that depend on a period read it — <b>In the period</b> (new, renewal, auto-renews, up for renewal…), <b>ARR in the period</b>, <b>Revenue in the period</b>, <b>Signed or renews in the period</b> — and so does any filter set to <b>The report's period</b>. It moves with the calendar: “This year” is always the current one.</p>
                  <div className="rp-pgrid">
                    {["Years", "Quarters", "Months", "Rolling", "Weeks", "Open-ended", "Any"].filter((grp) => PERIODS.some((p) => p.group === grp)).map((grp) => (
                      <div className="rp-pg" key={grp}>
                        <span>{grp}</span>
                        <div className="rp-pg-chips">
                          {PERIODS.filter((p) => p.group === grp).map((p) => (
                            <button type="button" key={p.key} className={`rp-pchip ${period.key === p.key ? "is-on" : ""}`} aria-pressed={period.key === p.key} onClick={() => set({ period: { key: p.key } })} title={prettyRange(p.key)}>{p.label}</button>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div className="rp-pg is-custom">
                      <span>Custom</span>
                      <div className="rp-pg-chips">
                        <DatePicker value={period.key === "custom" ? period.from ?? "" : ""} onChange={(v) => set({ period: { key: "custom", from: v || null, to: period.key === "custom" ? period.to ?? null : null } })} placeholder="From" />
                        <i>to</i>
                        <DatePicker value={period.key === "custom" ? period.to ?? "" : ""} onChange={(v) => set({ period: { key: "custom", from: period.key === "custom" ? period.from ?? null : null, to: v || null } })} placeholder="To" />
                      </div>
                    </div>
                  </div>
                  <div className="rp-pnow">
                    <span className="rp-pnow-ico"><Ico d={I.cal} /></span>
                    <span><b>{periodName}</b><em>{periodRange}</em></span>
                    {!usesPeriod && <p>Nothing on this report reads the period yet: add a column such as <b>ARR in the period</b>, or a filter on <b>The report's period</b>.</p>}
                  </div>
                  {cfg.source === "contract" || cfg.source === "agreement" || withList.includes("contract") || withList.includes("agreement") ? (
                    <div className="rp-pkey">
                      {Object.entries(PERIOD_STATUS_HINT).map(([k, v]) => <span key={k}><b>{k}</b>{v}</span>)}
                    </div>
                  ) : null}
                </section>
                    )}
                    {panel === "filter" && (
                <section className="rp-card">
                  <h3>Which {many ? "rows" : ent!.plural.toLowerCase()}?</h3>
                  <p className="rp-help">As many rules as you need, on any field of {ent!.plural.toLowerCase()} or of what is linked to them — custom fields included. Put rules in a group to mix “and” and “or”; groups can hold more groups.</p>
                  <RuleGroup g={cfg.filter} depth={0} fields={fields} fieldByKey={fieldByKey} values={valuesOf} opts={valueOpts} main={cfg.source} left={leftAfter} noun={rowWord} onChange={(g) => set({ filter: g })} />
                </section>
                    )}
                    {panel === "cols" && (
                <section className="rp-card">
                  <h3>What does each row show?</h3>
                  <p className="rp-help">Tick any field below to add it. Drag the columns by their handle to put them in your order, and rename any of them for this report. In the result, click a column title to sort.</p>
                  <div className={`rp-cols ${dragId ? "is-dragging" : ""}`}>
                    {cfg.cols.map((k, i) => {
                      const f = fieldByKey.get(k);
                      const move = (from: string, to: string, after: boolean) => set({ cols: moveBy(cfg.cols.map((x) => ({ id: x })), from, to, after).map((x) => x.id) });
                      return (
                        <div className={`rp-col ${dragCls(k)}`} key={k} {...dragProps(k, move, true)}>
                          <span className="rp-grip" {...gripProps(k)}><Grip /></span>
                          <span className="rp-col-k">{f ? KIND_ICON[f.kind] : "?"}</span>
                          <span className="rp-col-g" style={vars({ "--c": entityOf((f?.group ?? cfg.source) as EntityKey)?.tone ?? "#999" })}>{f ? glabel(f.group) : "—"}</span>
                          <input value={cfg.labels[k] ?? (f?.label ?? k)} onChange={(e) => set({ labels: { ...cfg.labels, [k]: e.target.value } })} aria-label="Column name" />
                          {!f && !loading && <em className="rp-warn">Not in the data</em>}
                          <button type="button" className="rp-x" onClick={() => moveCol(i, -1)} disabled={i === 0} aria-label="Move up"><Ico d={I.up} /></button>
                          <button type="button" className="rp-x" onClick={() => moveCol(i, 1)} disabled={i === cfg.cols.length - 1} aria-label="Move down"><Ico d={I.dn} /></button>
                          <button type="button" className="rp-x" onClick={() => set({ cols: cfg.cols.filter((x) => x !== k) })} aria-label="Remove column"><Ico d={I.x} w={2.4} /></button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="rp-catalog">
                    <div className="rp-catalog-h">
                      <b>Every field</b>
                      <label className="rp-search is-light"><Ico d={I.search} /><input value={colQ} onChange={(e) => setColQ(e.target.value)} placeholder="Find a field…" /></label>
                      {parts.map((g) => (
                        <button type="button" key={g} className="rp-add is-ghost" onClick={() => set({ cols: [...cfg.cols, ...fields.filter((f) => f.group === g && !cfg.cols.includes(f.key) && !f.key.endsWith(".__count")).slice(0, 6).map((f) => f.key)] })}>
                          + {entityOf(g).label} basics
                        </button>
                      ))}
                    </div>
                    <div className="rp-catalog-b">
                      {[...new Set(fields.map((f) => f.group))].map((g) => {
                        const fs = fields.filter((f) => f.group === g && (!colQ.trim() || findable(f).includes(norm(colQ.trim()))));
                        if (!fs.length) return null;
                        return (
                          <div className="rp-cat-g" key={g} style={vars({ "--c": entityOf(g as EntityKey)?.tone ?? "#1fb98a" })}>
                            <span className="rp-cat-gl">{glabel(g)}</span>
                            <div className="rp-cat-chips">
                              {fs.map((f) => {
                                const on = cfg.cols.includes(f.key);
                                return (
                                  <button type="button" key={f.key} aria-pressed={on} className={`rp-cat-chip ${on ? "is-on" : ""}`} onClick={() => set({ cols: on ? cfg.cols.filter((x) => x !== f.key) : [...cfg.cols, f.key] })}>
                                    <i>{on ? <Ico d={I.check} w={3} /> : KIND_ICON[f.kind]}</i>{f.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
                    )}
                    {panel === "charts" && (
                      <section className="rp-card">
                        <h3>Add a chart</h3>
                        <p className="rp-help">Made for this report — one click each. It lands on the report below, where you change it (type, what it counts, split, size), drag it into place or remove it.</p>
                        <div className="rp-gallery">
                          {suggestions.map((pr) => (
                            <button type="button" key={pr.title} className="rb-preset rp-preset" onClick={() => addChart(pr)} title={`Add “${pr.title}”`}>
                              <span className={`rb-preset-ico is-${pr.type}`}><i /><i /><i /></span><span className="rp-preset-t">{pr.title}</span>
                            </button>
                          ))}
                          <button type="button" className="rb-preset is-custom rp-preset" onClick={() => addChart()}><Ico d={I.plus} />Your own chart</button>
                        </div>
                      </section>
                    )}
                  </section>
                )}

                {/* the rules, always in sight: one chip each */}
                <div className="rp-chips" aria-label="Filters">
                  {cfg.filter.match !== "all" && rulesOf(cfg.filter, fieldByKey).length > 1 && <span className="rp-chips-k">{cfg.filter.match === "any" ? "Any of" : "None of"}</span>}
                  {rulesOf(cfg.filter, fieldByKey).map((c) => (
                    <span className="rp-fchip" key={c.id}>
                      <button type="button" onClick={() => setPanel("filter")} title="Change it">{ruleText(c)}</button>
                      {leftAfter.has(c.id) && <em className={leftAfter.get(c.id) === 0 ? "is-zero" : ""}>{leftAfter.get(c.id)!.toLocaleString("en-GB")}</em>}
                      <button type="button" className="rp-fchip-x" onClick={() => set({ filter: withoutRule(cfg.filter, c.id) })} aria-label="Remove this filter"><Ico d={I.x} w={2.6} /></button>
                    </span>
                  ))}
                  <button type="button" className="rp-fchip is-add" onClick={addFilter}><Ico d={I.plus} w={2.6} />{nRules ? "Add a filter" : "Filter the rows"}</button>
                  {nRules > 0 && <button type="button" className="rp-link rp-chips-clear" onClick={() => set({ filter: emptyTree() })}>Clear all</button>}
                </div>

                {rows.length === 0 && nRules > 0 && !loading && (
                  <div className="rp-nothing is-inline">
                    <b>Nothing matches all these filters together.</b>
                    {blocker
                      ? <span>Without <em>“{ruleText(blocker.rule)}”</em> there would be {blocker.n.toLocaleString("en-GB")} {rowWord(blocker.n)}.<button type="button" className="rp-link" onClick={() => set({ filter: withoutRule(cfg.filter, blocker.rule.id) })}>Take that one out</button></span>
                      : <span>Each value in a filter shows how many it keeps — pick ones that aren't 0.</span>}
                  </div>
                )}

                {kpis(true)}
                {chartGrid("edit")}
                <section className="rp-card is-table">
                  <div className="rp-thead">
                    <b>{rows.length.toLocaleString("en-GB")} {rowWord(rows.length)}</b>
                    <em>{allRows.length !== rows.length ? `of ${allRows.length.toLocaleString("en-GB")}` : "all of them"}{cfg.groupBy ? ` · grouped by ${low(fieldByKey.get(cfg.groupBy)?.label ?? "")}` : ""}{usesPeriod ? ` · period: ${periodName.toLowerCase()} (${periodRange})` : ""}</em>
                    <div className="rp-thead-ctl">
                    <label className="rp-tb-sel"><span>Group by</span>
                      <SalesMultiFilter single values={[cfg.groupBy ?? "__none"]} onChange={(v) => set({ groupBy: v[0] && v[0] !== "__none" ? v[0] : null })}
                        options={[{ value: "__none", label: "Nothing" }, ...fields.filter((f) => f.kind === "enum" || f.kind === "text").map((f) => ({ value: f.key, label: fl(f), group: glabel(f.group) }))]} placeholder="Nothing" searchFrom={8} />
                    </label>
                    <label className="rp-tb-sel"><span>Sort by</span>
                      <SalesMultiFilter single values={[cfg.sort?.key ?? "__none"]} onChange={(v) => set({ sort: v[0] && v[0] !== "__none" ? { key: v[0], dir: cfg.sort?.dir ?? "desc" } : null })}
                        options={[{ value: "__none", label: "As they come" }, ...colFields.map((f) => ({ value: f.key, label: colTitle(f) }))]} placeholder="As they come" />
                    </label>
                    {cfg.sort && (
                      <button type="button" className="rp-tb-dir" onClick={() => set({ sort: { ...cfg.sort!, dir: cfg.sort!.dir === "desc" ? "asc" : "desc" } })} title="Change the order">
                        <Ico d={cfg.sort.dir === "desc" ? I.dn : I.up} w={2.4} />{cfg.sort.dir === "desc" ? "High → low" : "Low → high"}
                      </button>
                    )}
                    <label className="rp-tb-chk"><input type="checkbox" checked={cfg.totals} onChange={(e) => set({ totals: e.target.checked })} /><span>Totals</span></label>
                    </div>
                    <button type="button" className="rp-btn is-ghost is-sm" onClick={() => setPanel("cols")}><Ico d={I.plus} w={2.4} />Column</button>
                  </div>
                  {table(shown)}
                </section>
              </div>
              )}
            </>
          )}
        </main>
      </div>
      {note && <div className="rb-toast">{note}</div>}
      {leaving && (
        <div className="rp-leave" onMouseDown={(e) => { if (e.target === e.currentTarget) setLeaving(null); }}>
          <div className="rp-leave-box" role="dialog" aria-modal="true" aria-labelledby="rp-leave-t">
            <h3 id="rp-leave-t">Save this report first?</h3>
            <p>“{cfg?.name?.trim() || "Untitled report"}” has changes you haven't saved. You can save it now, or open the row and come back to it with Back — your changes wait for you.</p>
            <div className="rp-leave-acts">
              <button type="button" className="rp-btn is-ghost" onClick={() => setLeaving(null)}>Cancel</button>
              <button type="button" className="rp-btn is-ghost" onClick={() => go(leaving)}>Open without saving</button>
              <button type="button" className="rp-btn is-main" disabled={busy} autoFocus onClick={async () => { const l = leaving; if (await save()) go(l); }}>{busy ? "Saving…" : "Save and open"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
