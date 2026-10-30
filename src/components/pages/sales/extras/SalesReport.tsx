/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { supabase } from "../../../api/supabase";
import { downloadBlob, tableToCsv, tableToXlsx, type ExportColumn } from "../../../framework/exportFile";
import SalesMultiFilter, { type SmfOption } from "../sales/SalesMultiFilter";
import DatePicker from "../../../framework/DatePicker";
import { ReportChart, CHART_LABEL, PALETTE, type ChartType } from "./ReportCharts";
import {
  ENTITIES, entityOf, GROUP_LABEL, OPS, DEFAULT_OP, NO_VALUE, PERIODS, FN_LABEL,
  loadCrmData, buildCrmRows, buildCrmFields, aggregateCrm, testTree, countRules, isGroup, emptyTree, forgetCrmData,
  condComplete, toCell, showCell, sortValue, uid, norm,
  type Cond, type CondGroup, type Field, type EntityKey, type CrmFn, type CrmRow, type CrmData, type Kind,
} from "./salesReportEngine";
import "./SalesReport.css";

/* =====================================================================
   Reports — its own page. Any part of the CRM, every field (fixed, custom
   and computed), rules nested as deep as you like, and charts on any field.
   Built step by step: what it's about · which ones · what it shows · how it
   adds up · save.
   ===================================================================== */

interface CrmChart { id: string; title: string; type: ChartType; dim: string; fn: CrmFn; value: string | null; split: string | null; cumulative?: boolean }
export interface CrmReport {
  v: 2; name: string; source: EntityKey; filter: CondGroup;
  cols: string[]; labels: Record<string, string>;
  sort: { key: string; dir: "asc" | "desc" } | null; groupBy: string | null; totals: boolean;
  charts: CrmChart[]; openInView?: boolean;
}
interface SavedReport { id: string; name: string; owner_id: string | null; shared: boolean; updated_at: string; config: any }

const DEFAULT_COLS: Record<EntityKey, string[]> = {
  deal: ["deal.name", "deal.pipeline", "deal.phase", "deal.owner", "deal.revenue", "deal.weighted", "deal.close"],
  company: ["company.name", "company.types", "company.sector", "company.city", "company.country_name"],
  contact: ["contact.name", "contact.email", "contact.position", "company.name"],
  client: ["client.name", "client.projects", "client.projects_value", "client.recurring", "client.next_renewal"],
  project: ["project.name", "client.name", "project.type", "project.status_label", "project.value"],
  contract: ["client.name", "contract.product", "contract.kind", "contract.annual_now", "contract.value", "contract.end"],
  invoice: ["client.name", "invoice.period", "invoice.net", "invoice.amount", "invoice.status_label", "invoice.due_date", "invoice.days_late"],
  ticket: ["ticket.title", "client.name", "ticket.stage_label", "ticket.priority_label", "ticket.assignee", "ticket.created_at"],
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
  { title: "Contracts ending soon", hint: "Signed products ending in the next 90 days", make: () => ({ ...newReport("contract"), name: "Contracts ending in 90 days",
    filter: { id: uid(), match: "all", items: [rule("contract.end", "in_period", { a: "next_90" })] },
    sort: { key: "contract.end", dir: "asc" }, charts: [{ id: uid(), title: "Yearly value ending, by month", type: "bar", dim: "time:month:contract.end", fn: "sum", value: "contract.annual_now", split: null }] }) },
  { title: "Overdue invoices", hint: "Sent, not paid and past their due date", make: () => ({ ...newReport("invoice"), name: "Overdue invoices",
    filter: { id: uid(), match: "all", items: [rule("invoice.status_label", "in", { vals: ["Overdue"] })] },
    sort: { key: "invoice.days_late", dir: "desc" }, charts: [{ id: uid(), title: "Owed by client", type: "hbar", dim: "client.name", fn: "sum", value: "invoice.amount", split: null }] }) },
  { title: "Open tickets", hint: "By priority and who has them", make: () => ({ ...newReport("ticket"), name: "Open tickets",
    filter: { id: uid(), match: "all", items: [rule("ticket.open", "in", { vals: ["Yes"] })] },
    charts: [{ id: uid(), title: "By priority", type: "donut", dim: "ticket.priority_label", fn: "count", value: null, split: null }, { id: uid(), title: "By assignee and stage", type: "stacked", dim: "ticket.assignee", fn: "count", value: null, split: "ticket.stage_label" }] }) },
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
    id: uid(), title: ch.title, type: ch.type, split: ch.split ?? null, cumulative: ch.cumulative,
    dim: String(ch.dim ?? "deal.phase").startsWith("time:") ? `time:${String(ch.dim).slice(5)}:deal.close` : String(ch.dim ?? "").startsWith("created:") ? `time:${String(ch.dim).slice(8)}:deal.created` : ch.dim,
    fn: ch.measure === "count" ? "count" : ch.measure === "avgprob" ? "avg" : "sum",
    value: ch.measure === "revenue" ? "deal.revenue" : ch.measure === "weighted" ? "deal.weighted" : ch.measure === "avgprob" ? "deal.prob" : null,
  }));
  return r;
}

const STEPS = [
  { k: "data", t: "What it's about", s: "Pick the part of the CRM" },
  { k: "filter", t: "Which ones", s: "Rules and groups of rules" },
  { k: "cols", t: "What it shows", s: "The columns, in your order" },
  { k: "sum", t: "How it adds up", s: "Groups, totals and charts" },
  { k: "save", t: "Save", s: "Name it and share it" },
] as const;

const Ico = ({ d, w = 2 }: { d: string; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  plus: "M12 5v14M5 12h14", x: "M6 6l12 12M18 6L6 18", up: "M12 19V5M6 11l6-6 6 6", dn: "M12 5v14M6 13l6 6 6-6",
  left: "M15 6l-6 6 6 6", right: "M9 6l6 6-6 6", check: "M5 12l5 5 9-10", edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  down: "M12 4v11M7 10l5 5 5-5M5 20h14", chart: "M4 20V10M10 20V4M16 20v-7M22 20H2", trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1", search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3", refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5",
  group: "M4 6h16M8 12h12M12 18h8M4 6v12", spark: "M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z",
};
const KIND_ICON: Record<Kind, string> = { text: "Aa", number: "#", money: "€", percent: "%", date: "◷", enum: "≡" };
const vars = (o: Record<string, string | number>) => o as CSSProperties;
const glabel = (g: string) => GROUP_LABEL[g as EntityKey] ?? g;

/** A field picker: every field, grouped by the part of the CRM it belongs to. */
function FieldPick({ fields, value, onChange, placeholder, filter }: { fields: Field[]; value: string | null; onChange: (k: string) => void; placeholder: string; filter?: (f: Field) => boolean }) {
  const opts: SmfOption[] = fields.filter((f) => !filter || filter(f)).map((f) => ({ value: f.key, label: f.label, group: glabel(f.group), hint: KIND_ICON[f.kind] }));
  return <SalesMultiFilter single values={value ? [value] : []} onChange={(v) => v[0] && onChange(v[0])} options={opts} placeholder={placeholder} searchFrom={8} />;
}

/** One rule: field · how · value(s). */
function RuleRow({ c, fields, fieldByKey, values, onChange, onRemove }: {
  c: Cond; fields: Field[]; fieldByKey: Map<string, Field>; values: (f: Field) => string[];
  onChange: (c: Cond) => void; onRemove: () => void;
}) {
  const f = fieldByKey.get(c.field);
  const ops = f ? OPS[f.kind] : [];
  const set = (p: Partial<Cond>) => onChange({ ...c, ...p });
  return (
    <div className={`rp-rule ${f && condComplete(c, f) ? "is-ok" : ""}`}>
      <div className="rp-rule-f"><FieldPick fields={fields} value={c.field || null} placeholder="Pick a field…" onChange={(k) => { const nf = fieldByKey.get(k); set({ field: k, op: nf ? DEFAULT_OP[nf.kind] : "contains", a: "", b: "", vals: [] }); }} /></div>
      {f && (
        <div className="rp-rule-op">
          <SalesMultiFilter single values={[c.op]} onChange={(v) => v[0] && set({ op: v[0] })} options={ops.map((o) => ({ value: o.value, label: o.label }))} placeholder="How" />
        </div>
      )}
      {f && !NO_VALUE.has(c.op) && (
        <div className="rp-rule-v">
          {f.kind === "enum" ? (
            <SalesMultiFilter values={c.vals} onChange={(v) => set({ vals: v })} options={values(f).map((v) => ({ value: v, label: v }))} placeholder="Pick values…" noun="values" searchFrom={8} />
          ) : f.kind === "date" ? (
            c.op === "in_period" ? (
              <SalesMultiFilter single values={c.a ? [c.a] : []} onChange={(v) => v[0] && set({ a: v[0] })} options={PERIODS.filter((p) => p.key !== "all" && p.key !== "custom").map((p) => ({ value: p.key, label: p.label, group: p.group }))} placeholder="Pick a period…" />
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
      <button type="button" className="rp-x" onClick={onRemove} aria-label="Remove this rule"><Ico d={I.x} w={2.4} /></button>
    </div>
  );
}

/** A group of rules — all / any / none of them — with rules and more groups inside. */
function RuleGroup({ g, depth, fields, fieldByKey, values, onChange, onRemove }: {
  g: CondGroup; depth: number; fields: Field[]; fieldByKey: Map<string, Field>; values: (f: Field) => string[];
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
              ? <RuleGroup g={it} depth={depth + 1} fields={fields} fieldByKey={fieldByKey} values={values} onChange={(x) => setItem(i, x)} onRemove={() => drop(i)} />
              : <RuleRow c={it} fields={fields} fieldByKey={fieldByKey} values={values} onChange={(x) => setItem(i, x)} onRemove={() => drop(i)} />}
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

export default function ReportsPage() {
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [tableMissing, setTableMissing] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [cfg, setCfg] = useState<CrmReport | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [snap, setSnap] = useState("");
  const [mode, setMode] = useState<"build" | "view">("build");
  const [step, setStep] = useState(0);
  const [q, setQ] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the data of the report's subject, its fields and rows
  const [data, setData] = useState<CrmData | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [shown, setShown] = useState(200);

  useEffect(() => { if (note) { const t = setTimeout(() => setNote(null), 2800); return () => clearTimeout(t); } }, [note]);
  useEffect(() => { supabase.auth.getSession().then(({ data: s }) => setMe(s?.session?.user?.id ?? null)); void loadSaved(); }, []);

  async function loadSaved() {
    const { data: rows, error } = await supabase.from("sales_reports").select("id, name, owner_id, shared, updated_at, config").order("updated_at", { ascending: false });
    if (error) { setTableMissing(true); return; }
    setSaved((rows ?? []) as SavedReport[]);
  }
  const source = cfg?.source ?? null;
  // read what the subject needs (once per visit; "Refresh data" reads again)
  const [dataTick, setDataTick] = useState(0);
  useEffect(() => {
    if (!source) return;
    let off = false;
    setLoading("Reading the CRM…"); setLoadErr(null);
    loadCrmData(source, (w) => { if (!off) setLoading(`Reading ${w}…`); })
      .then(async (d) => { const fs = await buildCrmFields(source, d); if (!off) { setData(d); setFields(fs); setLoading(null); } })
      .catch((e) => { if (!off) { setLoadErr(String(e?.message ?? e)); setLoading(null); } });
    return () => { off = true; };
  }, [source, dataTick]);

  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const allRows: CrmRow[] = useMemo(() => (data && source ? buildCrmRows(source, data) : []), [data, source]);
  const filter = cfg?.filter;
  const rows = useMemo(() => (filter ? allRows.filter((r) => testTree(filter, r, fieldByKey)) : []), [allRows, filter, fieldByKey]);
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

  const set = (p: Partial<CrmReport>) => setCfg((c) => (c ? { ...c, ...p } : c));
  const dirty = !!cfg && JSON.stringify(cfg) !== snap;
  const start = (r: CrmReport, id: string | null = null, sh = false, view = false) => {
    setCfg(r); setReportId(id); setShared(sh); setSnap(JSON.stringify(r)); setMode(view ? "view" : "build"); setStep(id || view ? 1 : 0); setShown(200);
  };
  const leaveOk = () => !dirty || window.confirm("Leave this report without saving your changes?");
  const open = (s: SavedReport) => { if (!leaveOk()) return; start(fromSaved(s.config, s.name), s.id, !!s.shared, true); };
  const save = async (copy = false) => {
    if (!cfg) return false;
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
    setCfg(c); setReportId((res.data as any).id); setSnap(JSON.stringify(c)); setNote(copy ? "Saved as a copy" : "Report saved");
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
    const columns: ExportColumn[] = colFields.map((f) => ({ label: cfg.labels[f.key] || f.label, format: f.kind === "money" ? "money" : f.kind === "number" ? "number" : f.kind === "percent" ? "percent" : f.kind === "date" ? "date" : "text" }));
    const t = { columns, rows: sorted.map((r) => colFields.map((f) => toCell(f, f.get(r as any)))) };
    const file = `${cfg.name || "Report"} ${new Date().toISOString().slice(0, 10)}`;
    downloadBlob(kind === "xlsx" ? tableToXlsx(t, (cfg.name || "Report").slice(0, 28)) : tableToCsv(t), `${file}.${kind}`);
  };

  /* ---- helpers for the steps ---- */
  const moveCol = (i: number, d: -1 | 1) => { if (!cfg) return; const xs = [...cfg.cols]; const j = i + d; if (j < 0 || j >= xs.length) return; [xs[i], xs[j]] = [xs[j], xs[i]]; set({ cols: xs }); };
  const addChart = () => cfg && set({ charts: [...cfg.charts, { id: uid(), title: "New chart", type: "bar", dim: cfg.groupBy ?? cfg.cols.find((k) => fieldByKey.get(k)?.kind === "enum") ?? cfg.cols[0] ?? "", fn: "count", value: null, split: null }] });
  const setChart = (id: string, p: Partial<CrmChart>) => cfg && set({ charts: cfg.charts.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const dimOptions: SmfOption[] = [
    ...fields.filter((f) => f.kind !== "date").map((f) => ({ value: f.key, label: f.label, group: glabel(f.group), hint: KIND_ICON[f.kind] })),
    ...fields.filter((f) => f.kind === "date").flatMap((f) => (["month", "quarter", "year", "week"] as const).map((g) => ({ value: `time:${g}:${f.key}`, label: `${f.label} · by ${g}`, group: `Over time · ${glabel(f.group)}` }))),
  ];
  const numFields = fields.filter(numeric);
  const nRules = cfg ? countRules(cfg.filter) : 0;
  const ent = cfg ? entityOf(cfg.source) : null;
  const canNext = !!cfg && (step !== 2 || cfg.cols.length > 0);
  const list = saved.filter((s) => !q || norm(s.name).includes(norm(q)));
  const sourceOf = (s: SavedReport) => (s.config?.v === 2 ? s.config.source : "deal") as EntityKey;

  /* ---- render pieces ---- */
  const table = (limit: number): ReactNode => {
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
      body.push(<tr key={i}>{colFields.map((f) => <td key={f.key} className={numeric(f) ? "is-num" : ""}>{showCell(f, toCell(f, f.get(r as any))) || <span className="rp-dash">—</span>}</td>)}</tr>);
    });
    return (
      <div className="rp-twrap">
        <table className="rp-table">
          <thead>
            <tr>
              {colFields.map((f) => {
                const on = cfg.sort?.key === f.key;
                return (
                  <th key={f.key} className={numeric(f) ? "is-num" : ""}>
                    <button type="button" className={on ? "is-on" : ""} title="Sort"
                      onClick={() => set({ sort: on && cfg.sort!.dir === "desc" ? { key: f.key, dir: "asc" } : on ? null : { key: f.key, dir: "desc" } })}>
                      <span>{cfg.labels[f.key] || f.label}</span>{on && <Ico d={cfg.sort!.dir === "asc" ? I.up : I.dn} w={2.4} />}
                    </button>
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
        {sorted.length === 0 && !loading && <p className="rp-none is-big">Nothing matches these rules.</p>}
        {sorted.length > limit && limit > 20 && <button type="button" className="rp-more" onClick={() => setShown((n) => n + 500)}>Show {Math.min(500, sorted.length - limit).toLocaleString("en-GB")} more · {sorted.length.toLocaleString("en-GB")} in all</button>}
      </div>
    );
  };
  const chartCard = (ch: CrmChart, i: number, editable: boolean): ReactNode => {
    const agg = aggregateCrm({ rows, dim: ch.dim, fn: ch.fn, value: ch.value, split: ch.split, fieldByKey, cumulative: ch.cumulative });
    return (
      <div className={`rp-chart ${editable ? "is-edit" : ""}`} key={ch.id} style={vars({ "--i": i, "--c": PALETTE[i % PALETTE.length] })}>
        <div className="rp-chart-h">
          {editable ? <input className="rp-chart-t" value={ch.title} onChange={(e) => setChart(ch.id, { title: e.target.value })} aria-label="Chart title" /> : <b>{ch.title}</b>}
          {editable && <button type="button" className="rp-x" onClick={() => set({ charts: cfg!.charts.filter((c) => c.id !== ch.id) })} aria-label="Remove chart"><Ico d={I.trash} /></button>}
        </div>
        {editable && (
          <div className="rp-chart-cfg">
            <label><span>Chart</span><SalesMultiFilter single values={[ch.type]} onChange={(v) => v[0] && setChart(ch.id, { type: v[0] as ChartType })} options={(Object.keys(CHART_LABEL) as ChartType[]).map((t) => ({ value: t, label: CHART_LABEL[t] }))} placeholder="Type" /></label>
            <label><span>By</span><SalesMultiFilter single values={ch.dim ? [ch.dim] : []} onChange={(v) => v[0] && setChart(ch.id, { dim: v[0] })} options={dimOptions} placeholder="Pick…" searchFrom={8} /></label>
            <label><span>Figure</span><SalesMultiFilter single values={[ch.fn]} onChange={(v) => v[0] && setChart(ch.id, { fn: v[0] as CrmFn, value: v[0] === "count" ? null : ch.value ?? numFields[0]?.key ?? null })} options={(Object.keys(FN_LABEL) as CrmFn[]).map((f) => ({ value: f, label: f === "count" ? "How many" : `${FN_LABEL[f]} of…` }))} placeholder="Figure" /></label>
            {ch.fn !== "count" && <label><span>Of</span><FieldPick fields={numFields} value={ch.value} onChange={(k) => setChart(ch.id, { value: k })} placeholder="A number…" /></label>}
            <label><span>Split by</span><SalesMultiFilter single values={[ch.split ?? "__none"]} onChange={(v) => setChart(ch.id, { split: v[0] && v[0] !== "__none" ? v[0] : null })} options={[{ value: "__none", label: "No split" }, ...fields.filter((f) => f.kind === "enum").map((f) => ({ value: f.key, label: f.label, group: glabel(f.group) }))]} placeholder="No split" searchFrom={8} /></label>
            <label className="rp-chk"><input type="checkbox" checked={!!ch.cumulative} onChange={(e) => setChart(ch.id, { cumulative: e.target.checked })} /><span>Running total</span></label>
          </div>
        )}
        <div className="rp-chart-body">{agg.keys.length ? <ReportChart type={ch.type} agg={agg} /> : <p className="rp-none">No data for this chart yet.</p>}</div>
      </div>
    );
  };
  const kpis = (): ReactNode => {
    if (!cfg) return null;
    const money = colFields.filter((f) => f.kind === "money").slice(0, 3);
    return (
      <div className="rp-kpis">
        <div className="rp-kpi" style={vars({ "--c": ent?.tone ?? "#1fb98a", "--i": 0 })}><span>{ent?.plural}</span><b>{rows.length.toLocaleString("en-GB")}</b><em>of {allRows.length.toLocaleString("en-GB")} · {nRules ? `${nRules} rule${nRules === 1 ? "" : "s"}` : "no rules"}</em></div>
        {money.map((f, i) => (
          <div className="rp-kpi" key={f.key} style={vars({ "--c": PALETTE[(i + 1) % PALETTE.length], "--i": i + 1 })}><span>{cfg.labels[f.key] || f.label}</span><b>{showCell(f, totalOf(f, rows)) || "0 €"}</b><em>{glabel(f.group)} · total</em></div>
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
          <button type="button" className="rp-btn is-mint" onClick={() => { if (!leaveOk()) return; setCfg(null); setReportId(null); }}><Ico d={I.plus} w={2.4} />New report</button>
        </div>
      </header>

      <div className="rp-body">
        <aside className="rp-side" aria-label="Saved reports">
          <p className="rp-side-h">Saved reports</p>
          <label className="rp-search"><Ico d={I.search} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a report" /></label>
          {tableMissing && <p className="rp-none">Saved reports need the sales_reports table.</p>}
          {!tableMissing && !list.length && (q ? <p className="rp-none">No report matches.</p> : (
            <div className="rp-side-empty">
              <span><Ico d={I.chart} /></span>
              <b>No saved reports yet</b>
              <em>Build one and press Save — it stays here for you, or for the whole team if you share it.</em>
            </div>
          ))}
          <div className="rp-saved">
            {list.map((s) => {
              const e = entityOf(sourceOf(s));
              return (
                <div className={`rp-sv ${s.id === reportId ? "is-on" : ""}`} key={s.id} style={vars({ "--c": e.tone })}>
                  <button type="button" className="rp-sv-main" onClick={() => open(s)}>
                    <span className="rp-sv-ico"><Ico d={e.icon} /></span>
                    <span className="rp-sv-t"><b>{s.name}</b><em>{e.plural}{s.shared ? " · shared" : ""}{s.owner_id && me && s.owner_id !== me ? " · someone else's" : ""}</em></span>
                  </button>
                  {(!s.owner_id || s.owner_id === me) && <button type="button" className="rp-x" onClick={() => void remove(s)} aria-label={`Delete ${s.name}`}><Ico d={I.trash} /></button>}
                </div>
              );
            })}
          </div>
        </aside>

        <main className="rp-main">
          {!cfg ? (
            <div className="rp-start">
              <section className="rp-intro">
                <div className="rp-intro-t">
                  <span className="rp-eyebrow"><Ico d={I.spark} />Report builder</span>
                  <h2>What do you want to know?</h2>
                  <p>Pick a ready-made report, or build your own on any part of the CRM. You go step by step — nothing to get lost in.</p>
                </div>
                <ol className="rp-flow" aria-label="The steps">
                  {STEPS.map((x, i) => (
                    <li key={x.k} style={vars({ "--i": i })}><i>{i + 1}</i><span><b>{x.t}</b><em>{x.s}</em></span></li>
                  ))}
                </ol>
              </section>

              <section className="rp-block">
                <div className="rp-block-h"><h3>Ready-made</h3><span>Opens with its rules and charts — change anything after</span></div>
                <div className="rp-tpls">
                  {TEMPLATES.map((t, i) => {
                    const r = t.make(); const e = entityOf(r.source); const n = countRules(r.filter);
                    return (
                      <button type="button" className="rp-tpl" key={t.title} style={vars({ "--c": e.tone, "--i": i })} onClick={() => start(r, null, false, true)}>
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
                    <button type="button" key={e.key} className="rp-ent" style={vars({ "--c": e.tone, "--i": i })} onClick={() => { start(newReport(e.key)); setStep(1); }}>
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
              <div className="rp-bar">
                <span className="rp-bar-ico" style={vars({ "--c": ent!.tone })}><Ico d={ent!.icon} /></span>
                <input className="rp-name" value={cfg.name} onChange={(e) => set({ name: e.target.value })} aria-label="Report name" />
                <span className="rp-chip">{rows.length.toLocaleString("en-GB")} {ent!.plural.toLowerCase()}</span>
                <div className="rp-modes" role="tablist">
                  <button type="button" role="tab" aria-selected={mode === "build"} className={mode === "build" ? "is-on" : ""} onClick={() => setMode("build")}><Ico d={I.edit} />Build</button>
                  <button type="button" role="tab" aria-selected={mode === "view"} className={mode === "view" ? "is-on" : ""} onClick={() => setMode("view")}><Ico d={I.chart} />View</button>
                </div>
                <button type="button" className="rp-btn is-ghost" onClick={() => exportAs("xlsx")} disabled={!rows.length}><Ico d={I.down} />Excel</button>
                <button type="button" className="rp-btn is-ghost" onClick={() => exportAs("csv")} disabled={!rows.length}>CSV</button>
                <button type="button" className="rp-btn is-main" onClick={() => void save()} disabled={busy || (!!reportId && !dirty)}><Ico d={I.check} w={2.4} />{busy ? "Saving…" : reportId && !dirty ? "Saved" : "Save"}</button>
              </div>

              {loading && <div className="rp-loading"><span className="rp-spin" />{loading}</div>}
              {loadErr && <div className="rp-err">Couldn't read the data: {loadErr}</div>}

              {mode === "build" ? (
                <div className="rp-build">
                  <ol className="rp-steps">
                    {STEPS.map((s, i) => (
                      <li key={s.k} className={`${i === step ? "is-on" : ""} ${i < step ? "is-done" : ""}`}>
                        <button type="button" onClick={() => setStep(i)}>
                          <i>{i < step ? <Ico d={I.check} w={3} /> : i + 1}</i>
                          <span><b>{s.t}</b><em>{i === 0 ? ent!.plural : i === 1 && nRules ? `${nRules} rule${nRules === 1 ? "" : "s"}` : i === 2 ? `${cfg.cols.length} column${cfg.cols.length === 1 ? "" : "s"}` : i === 3 && cfg.charts.length ? `${cfg.charts.length} chart${cfg.charts.length === 1 ? "" : "s"}` : s.s}</em></span>
                        </button>
                      </li>
                    ))}
                  </ol>

                  <div className="rp-stage" key={step}>
                    {step === 0 && (
                      <section className="rp-card">
                        <h3>What is this report about?</h3>
                        <p className="rp-help">Each row of the report is one of these. What is linked to it comes along, so you can also use its fields — a deal's company, a project's client, an invoice's project.</p>
                        <div className="rp-ents">
                          {ENTITIES.map((e, i) => (
                            <button type="button" key={e.key} className={`rp-ent ${cfg.source === e.key ? "is-on" : ""}`} style={vars({ "--c": e.tone, "--i": i })}
                              onClick={() => { if (e.key === cfg.source) return; if (countRules(cfg.filter) && !window.confirm("Changing what it's about starts the rules and columns again. Go on?")) return; setCfg({ ...newReport(e.key), name: cfg.name }); }}>
                              <span className="rp-ent-ico"><Ico d={e.icon} /></span><b>{e.plural}</b><em>{e.hint}</em>
                              {e.related.length > 0 && <i>+ {e.related.map((r) => entityOf(r).plural.toLowerCase()).join(", ")}</i>}
                            </button>
                          ))}
                        </div>
                      </section>
                    )}

                    {step === 1 && (
                      <section className="rp-card">
                        <h3>Which {ent!.plural.toLowerCase()}?</h3>
                        <p className="rp-help">As many rules as you need, on any field of {ent!.plural.toLowerCase()} or of what is linked to them — custom fields included. Put rules in a group to mix “and” and “or”; groups can hold more groups.</p>
                        <RuleGroup g={cfg.filter} depth={0} fields={fields} fieldByKey={fieldByKey} values={valuesOf} onChange={(g) => set({ filter: g })} />
                      </section>
                    )}

                    {step === 2 && (
                      <section className="rp-card">
                        <h3>What does each row show?</h3>
                        <p className="rp-help">The columns, in the order you want. Rename any of them for this report. In the result, click a column title to sort.</p>
                        <div className="rp-cols">
                          {cfg.cols.map((k, i) => {
                            const f = fieldByKey.get(k);
                            return (
                              <div className="rp-col" key={k}>
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
                        <div className="rp-addcol">
                          <div className="rp-addcol-pick"><FieldPick fields={fields} value={null} filter={(f) => !cfg.cols.includes(f.key)} placeholder="+ Add a column" onChange={(k) => set({ cols: [...cfg.cols, k] })} /></div>
                          {[cfg.source, ...ent!.related].map((g) => (
                            <button type="button" key={g} className="rp-add is-ghost" onClick={() => set({ cols: [...cfg.cols, ...fields.filter((f) => f.group === g && !cfg.cols.includes(f.key) && !f.key.endsWith(".__count")).slice(0, 6).map((f) => f.key)] })}>
                              + {entityOf(g).label} basics
                            </button>
                          ))}
                        </div>
                      </section>
                    )}

                    {step === 3 && (
                      <section className="rp-card">
                        <h3>How does it add up?</h3>
                        <div className="rp-sumrow">
                          <label><span>Group the rows by</span>
                            <SalesMultiFilter single values={[cfg.groupBy ?? "__none"]} onChange={(v) => set({ groupBy: v[0] && v[0] !== "__none" ? v[0] : null })}
                              options={[{ value: "__none", label: "No groups" }, ...fields.filter((f) => f.kind === "enum" || f.kind === "text").map((f) => ({ value: f.key, label: f.label, group: glabel(f.group) }))]} placeholder="No groups" searchFrom={8} /></label>
                          <label><span>Sort by</span>
                            <SalesMultiFilter single values={[cfg.sort?.key ?? "__none"]} onChange={(v) => set({ sort: v[0] && v[0] !== "__none" ? { key: v[0], dir: cfg.sort?.dir ?? "desc" } : null })}
                              options={[{ value: "__none", label: "As they come" }, ...cfg.cols.map((k) => ({ value: k, label: cfg.labels[k] || fieldByKey.get(k)?.label || k }))]} placeholder="As they come" /></label>
                          {cfg.sort && (
                            <div className="rp-seg is-light" role="radiogroup">
                              <button type="button" className={cfg.sort.dir === "desc" ? "is-on" : ""} onClick={() => set({ sort: { ...cfg.sort!, dir: "desc" } })}>High → low</button>
                              <button type="button" className={cfg.sort.dir === "asc" ? "is-on" : ""} onClick={() => set({ sort: { ...cfg.sort!, dir: "asc" } })}>Low → high</button>
                            </div>
                          )}
                          <label className="rp-chk"><input type="checkbox" checked={cfg.totals} onChange={(e) => set({ totals: e.target.checked })} /><span>Totals for the numbers</span></label>
                        </div>
                        <div className="rp-charts-h"><h4>Charts</h4><button type="button" className="rp-add" onClick={addChart}><Ico d={I.plus} w={2.4} />Add a chart</button></div>
                        {!cfg.charts.length && <p className="rp-none">No charts yet. A chart counts or adds up the rows by any field — or by week, month, quarter or year of any date.</p>}
                        <div className="rp-charts">{cfg.charts.map((c, i) => chartCard(c, i, true))}</div>
                      </section>
                    )}

                    {step === 4 && (
                      <section className="rp-card">
                        <h3>Save it</h3>
                        <div className="rp-savegrid">
                          <label className="rp-lab"><span>Name</span><input className="rp-in is-big" value={cfg.name} onChange={(e) => set({ name: e.target.value })} /></label>
                          <label className="rp-chk is-big"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /><span><b>Share with the team</b><em>Everyone who can open Reports sees it — each with the records they are allowed to see.</em></span></label>
                        </div>
                        <div className="rp-summary">
                          <span><Ico d={ent!.icon} />{ent!.plural}</span>
                          <span><Ico d={I.group} />{nRules ? `${nRules} rule${nRules === 1 ? "" : "s"}` : "No rules — all of them"}</span>
                          <span><Ico d={I.edit} />{cfg.cols.length} column{cfg.cols.length === 1 ? "" : "s"}</span>
                          <span><Ico d={I.chart} />{cfg.charts.length} chart{cfg.charts.length === 1 ? "" : "s"}</span>
                        </div>
                        <div className="rp-saveacts">
                          <button type="button" className="rp-btn is-main is-big" onClick={async () => { if (await save()) setMode("view"); }} disabled={busy}><Ico d={I.check} w={2.4} />Save and view</button>
                          {reportId && <button type="button" className="rp-btn is-ghost is-big" onClick={() => void save(true)} disabled={busy}><Ico d={I.copy} />Save as a copy</button>}
                        </div>
                      </section>
                    )}

                    {step > 0 && step < 4 && (
                      <section className="rp-card is-preview">
                        <div className="rp-prev-h"><b>Preview</b><em>{rows.length.toLocaleString("en-GB")} of {allRows.length.toLocaleString("en-GB")} {ent!.plural.toLowerCase()} · first 8 rows</em></div>
                        {table(8)}
                      </section>
                    )}
                  </div>

                  <div className="rp-nav">
                    <button type="button" className="rp-btn is-ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}><Ico d={I.left} />Back</button>
                    <span>Step {step + 1} of {STEPS.length}</span>
                    {step < STEPS.length - 1
                      ? <button type="button" className="rp-btn is-main" onClick={() => setStep((s) => s + 1)} disabled={!canNext}>Next<Ico d={I.right} /></button>
                      : <button type="button" className="rp-btn is-main" onClick={() => setMode("view")}>See the report<Ico d={I.right} /></button>}
                  </div>
                </div>
              ) : (
                <div className="rp-view">
                  {kpis()}
                  {cfg.charts.length > 0 && <div className="rp-charts is-view">{cfg.charts.map((c, i) => chartCard(c, i, false))}</div>}
                  <section className="rp-card is-table">{table(shown)}</section>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {note && <div className="rb-toast">{note}</div>}
    </div>
  );
}
