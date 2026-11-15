/* =====================================================================
   BASE · Billing — one page for everything money-in:
     Invoices   — the issued ones: follow them up (unpaid, overdue, paid),
                  export them as XML (Facturae) for the billing system
     To invoice — what's still to go out: drafts (made by hand, or by the
                  system on the cutoff) and the work and shipments logged in
                  the calendar that aren't on an invoice yet
     Time     — what each person logged on each client in a month
   Base has no projects or types of work: anyone logs hours on a client in
   the calendar (the client's team says who may), and this is where they
   turn into invoices.
   ===================================================================== */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { usePageAccess } from "../../framework/pageAccess";
import { useAuth } from "../../../components/api/AuthProvider";
import InvoiceModal, { IC } from "./InvoiceModal";
import AutoInvoiceModal from "./AutoInvoiceModal";
import ExportModal from "./ExportModal";
import ActionsMenu, { AM_ICON } from "../../framework/ActionsMenu";
import { ColumnHead } from "../../framework/ColumnHead";
import {
  ColumnsEditor, FilterBar, FilterChips, applyView, emptyView, useSavedViews, useStoredView, type FField, type FView,
} from "../companies/CompaniesPage";
import { loadPrefs, savePref } from "../companies/companiesApi";
import "../orbit/Orbit.css";
import {
  STATE_LABEL, AUTO_DEFAULT, autoTick, loadAutoSettings, nextCutoff, addDays, daysBetween, draftFor, fmtDate, fmtShort, hourlyRate, hrs, iso, linesFromWork, loadCatalog, loadClients,
  loadInvoices, loadLines, loadPeople, loadSeller, loadUnbilled, loadWork, money, money0, nextNumber, round2, stateOf, todayIso,
  SELLER_EMPTY, type AutoSettings, type BClient, type CatItem, type Draft, type InvState, type Invoice, type Person, type Seller, type WorkEntry,
} from "./billingApi";
import "./Billing.css";
import "./BillingModern.css";
import "./BillingModals.css";

type View = "invoices" | "toinvoice" | "time";

const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const V_ICON: Record<View, string> = {
  invoices: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
  toinvoice: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  time: "M4 20V10M10 20V4M16 20v-7M22 20H2",
};
const V_LABEL: Record<View, string> = { invoices: "Invoiced", toinvoice: "To invoice", time: "Time" };
const viewOf = (v: string | null): View => (v === "tobill" || v === "toinvoice" ? "toinvoice" : v === "time" ? "time" : "invoices");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const HUE = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const Avatar = ({ name, size = 26, square }: { name: string; size?: number; square?: boolean }) => (
  <span className={`bz-av ${square ? "is-sq" : ""}`} title={name} style={{ width: size, height: size, fontSize: size * 0.38, ["--h" as string]: HUE(name) }}>{initials(name)}</span>
);

export default function BillingPage() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const { session } = useAuth();
  const me = session?.user?.id ?? null;
  const access = usePageAccess();
  /** Sees everyone's time (boss, or "Everyone" on Management › Billing); otherwise only their own. */
  const full = access.isSuper || access.panel("management.billing") === "all" || (access.level ?? "") === "boss";

  const [view, setView] = useState<View>(() => viewOf(new URLSearchParams(search).get("view")));
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [clients, setClients] = useState<BClient[]>([]);
  const [catalog, setCatalog] = useState<CatItem[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [seller, setSeller] = useState<Seller>(SELLER_EMPTY);
  const [unbilled, setUnbilled] = useState<WorkEntry[] | null>(null);
  const [open, setOpen] = useState<Draft | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  /** When invoices are made (sql 104); null = not set up in the database yet. */
  const [auto, setAuto] = useState<AutoSettings | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);
  /** The invoices going out as XML (null: the export window is closed). */
  const [exporting, setExporting] = useState<Invoice[] | null>(null);
  /** Each list: its filters / sort (remembered here), its saved views and its columns (kept with your profile). */
  const [invView, setInvView] = useStoredView("bz.inv.view", emptyView([{ key: "issue_date", dir: "desc" }]));
  const [toView, setToView] = useStoredView("bz.to.view", emptyView([{ key: "date", dir: "desc" }]));
  const [invSaved, setInvSaved] = useSavedViews("billingInvViews");
  const [toSaved, setToSaved] = useSavedViews("billingToViews");
  const [invCols, setInvCols] = useState<string[]>(INV_COLS_DEFAULT);
  const [toCols, setToCols] = useState<string[]>(TO_COLS_DEFAULT);
  const [colsOpen, setColsOpen] = useState(false);
  const [filtersTick, setFiltersTick] = useState(0);
  /** Picked invoices (Export XML takes these, or every one shown). */
  const [sel, setSel] = useState<Set<string>>(new Set());
  /** To invoice: everything, or only one stage. */
  const [stage, setStage] = useState<Stage | "all">("all");

  const reload = useCallback(async () => {
    try {
      const [inv, ub] = await Promise.all([loadInvoices(), loadUnbilled()]);
      setInvoices(inv); setUnbilled(ub); setErr(null);
    } catch (e: any) { setErr(e?.message ?? String(e)); setInvoices((x) => x ?? []); setUnbilled((x) => x ?? []); }
  }, []);
  useEffect(() => {
    void reload();
    loadClients().then(setClients).catch(() => {});
    loadCatalog().then(setCatalog).catch(() => {});
    loadPeople().then(setPeople).catch(() => {});
    loadSeller().then(setSeller).catch(() => {});
    loadPrefs().then((p) => {
      if (Array.isArray(p.billingInvColumns) && p.billingInvColumns.length) setInvCols(p.billingInvColumns);
      if (Array.isArray(p.billingToColumns) && p.billingToColumns.length) setToCols(p.billingToColumns);
    }).catch(() => {});
    // a cutoff that's due and wasn't billed yet (the daily job may not have run): bill it now
    loadAutoSettings().then(async (a) => {
      setAuto(a);
      if (a?.auto_invoice && (await autoTick()) > 0) void reload();
    }).catch(() => {});
  }, [reload]);

  const go = (v: View) => {
    setView(v);
    const p = new URLSearchParams(window.location.search); p.set("view", v);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${p}`);
  };
  const clientOf = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const nameOf = useCallback((id: string | null) => (id && clientOf.get(id)?.name) || "—", [clientOf]);
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const personOf = useCallback((id: string) => peopleById.get(id) ?? "Someone", [peopleById]);

  /* ---------- open / new ---------- */
  const openInvoice = async (inv: Invoice) => {
    const { lines, entryIds } = await loadLines(inv.id);
    setOpen({
      id: inv.id, number: inv.number, client_id: inv.client_id ?? "", status: inv.status, issue_date: inv.issue_date,
      payment_days: inv.due_date ? Math.max(0, daysBetween(inv.issue_date, inv.due_date)) : 30, tax_rate: inv.tax_rate,
      notes: inv.notes, bill_to: inv.bill_to?.name ? inv.bill_to : (inv.client_id && clientOf.get(inv.client_id) ? { name: nameOf(inv.client_id) } : { name: "" }),
      lines, entry_ids: entryIds, sent_date: inv.sent_date, paid_date: inv.paid_date, source: inv.source, created_at: inv.created_at,
    });
  };
  const newInvoice = async (clientId?: string, entries: WorkEntry[] = []) => {
    const c = clientId ? clientOf.get(clientId) : undefined;
    const d = draftFor(c, await nextNumber());
    if (entries.length) { d.lines = linesFromWork(entries, people, catalog, hourlyRate(c, catalog)); d.entry_ids = entries.map((e) => e.id); }
    setOpen(d);
  };
  // links: /billing?invoice=<id> opens it, /billing?new=<clientId> starts one
  useEffect(() => {
    if (!invoices || !clients.length) return;
    const p = new URLSearchParams(search);
    const id = p.get("invoice"), nw = p.get("new");
    if (!id && !nw) return;
    p.delete("invoice"); p.delete("new");
    navigate({ search: p.toString() }, { replace: true });
    const inv = id ? invoices.find((i) => i.id === id) : null;
    if (inv) void openInvoice(inv);
    else if (nw) void newInvoice(nw === "1" ? undefined : nw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, invoices, clients.length]);

  /* ---------- Invoiced: the rows, searched and filtered ---------- */
  const today = todayIso();
  const cnameOf = useCallback((i: Invoice) => (nameOf(i.client_id) !== "—" ? nameOf(i.client_id) : i.bill_to?.name || "—"), [nameOf]);
  const invRows = useMemo<InvRow[]>(() => (invoices ?? []).filter((i) => i.status !== "draft").map((i) => ({ i, s: stateOf(i, today), client: cnameOf(i) })), [invoices, today, cnameOf]);
  const invShown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hit = t ? invRows.filter((r) => r.i.number.toLowerCase().includes(t) || r.client.toLowerCase().includes(t)) : invRows;
    return applyView(hit, INV_FIELDS, invView);
  }, [invRows, q, invView]);

  /* ---------- To invoice: drafts and work not on an invoice, one list ---------- */
  const toRows = useMemo<ToRow[]>(() => {
    const out: ToRow[] = [];
    (invoices ?? []).filter((i) => i.status === "draft").forEach((i) => out.push({
      key: `d:${i.id}`, stage: i.source === "auto" ? "auto" : "manual", client: cnameOf(i), cid: i.client_id, number: i.number, date: i.issue_date,
      value: i.net, total: i.amount, hours: 0, units: 0, people: [], inv: i, note: i.notes ? i.notes.split("·")[0].trim() : i.bill_to?.email || "",
    }));
    const m = new Map<string, WorkEntry[]>();
    (unbilled ?? []).forEach((e) => { const g = m.get(e.client_id); if (g) g.push(e); else m.set(e.client_id, [e]); });
    m.forEach((es, cid) => {
      const c = clientOf.get(cid);
      const rate = hourlyRate(c, catalog);
      const work = es.filter((e) => e.kind === "client_work");
      const ships = es.filter((e) => e.kind === "shipment");
      const hours = round2(work.reduce((s, e) => s + e.hours, 0));
      const units = ships.reduce((s, e) => s + (e.quantity || 1), 0);
      const shipValue = ships.reduce((s, e) => s + (e.quantity || 1) * (e.unit_price || catalog.find((x) => x.kind === "product" && x.id === e.product_id)?.price || 0), 0);
      const value = round2(hours * rate + shipValue);
      const since = es.reduce((a, e) => (e.date < a ? e.date : a), es[0].date);
      out.push({
        key: `w:${cid}`, stage: "tobill", client: c?.name ?? "—", cid, number: "", date: since, value,
        total: round2(value * (1 + (c?.tax_rate ?? 21) / 100)), hours, units, people: Array.from(new Set(es.map((e) => e.user_id))), entries: es,
        note: [hours ? `${hrs(hours)}${rate ? ` × ${money(rate)}` : " · no rate"}` : "", units ? `${units} unit${units === 1 ? "" : "s"} shipped` : ""].filter(Boolean).join(" · "),
      });
    });
    return out;
  }, [invoices, unbilled, clientOf, catalog, cnameOf]);
  const toShown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hit = toRows.filter((r) => (stage === "all" || r.stage === stage) && (!t || r.client.toLowerCase().includes(t) || r.number.toLowerCase().includes(t)));
    return applyView(hit, TO_FIELDS, toView);
  }, [toRows, stage, q, toView]);
  const pending = toRows.length;

  const isList = view !== "time";
  const fields = (view === "invoices" ? INV_FIELDS : TO_FIELDS) as FField<any>[];
  const lview = view === "invoices" ? invView : toView;
  const setLview = view === "invoices" ? setInvView : setToView;
  const total = view === "invoices" ? invRows.length : toRows.length;
  const shown = view === "invoices" ? invShown.length : toShown.length;
  const noun: [string, string] = view === "invoices" ? ["invoice", "invoices"] : ["item", "items"];
  const picked = invRows.filter((r) => sel.has(r.i.id)).map((r) => r.i);
  const saveCols = (next: string[]) => {
    if (view === "invoices") { setInvCols(next); savePref("billingInvColumns", next).catch(() => {}); }
    else { setToCols(next); savePref("billingToColumns", next).catch(() => {}); }
  };
  const cutoffLabel = auto?.auto_invoice ? `Auto · ${fmtDate(addDays(nextCutoff(auto.cutoff_day), 1)).replace(/ \d{4}$/, "")}` : "Automatic invoices";

  return (
    <div className="bz bm">
      <header className="bz-head">
        <BzSwitch on={view} onPick={go} badge={{ toinvoice: pending }} />
        {isList && (
          <label className="bz-search"><Ico d={IC.search} s={15} />
            <input value={q} placeholder={view === "invoices" ? "Search a number or client…" : "Search a client or number…"} onChange={(e) => setQ(e.target.value)} />
            {q && <button onClick={() => setQ("")} aria-label="Clear">×</button>}
          </label>
        )}
        {isList && (
          <FilterBar fields={fields} view={lview} onView={setLview} total={total} shown={shown} noun={noun}
            saved={view === "invoices" ? invSaved : toSaved} onSaved={view === "invoices" ? setInvSaved : setToSaved} openSignal={filtersTick} />
        )}
        <span className="bz-sp" />
        <button className={`bz-gear ${auto?.auto_invoice ? "is-on" : ""}`} onClick={() => setAutoOpen(true)} title="When invoices are made"><i />{cutoffLabel}</button>
        <ActionsMenu quick={false} items={[
          { key: "new", group: "Create", label: "New invoice", hint: "Write one by hand", icon: AM_ICON.plus, primary: true, tone: "blue", shortcut: "N", onSelect: () => void newInvoice() },
          ...(view === "invoices" ? [{ key: "xml", group: "Export", label: picked.length ? `Export ${picked.length} as XML` : "Export XML", hint: "Facturae 3.2.2, for your billing / accounting system", icon: AM_ICON.export, tone: "violet" as const, shortcut: "X",
            onSelect: () => { const xs = picked.length ? picked : invShown.map((r) => r.i); if (xs.length) setExporting(xs); } }] : []),
          ...(isList ? [{ key: "cols", group: "Setup", label: "Columns", hint: "What the list shows, and in which order", icon: AM_ICON.fields, tone: "amber" as const, shortcut: "F", onSelect: () => setColsOpen(true) }] : []),
          { key: "auto", group: "Setup", label: "Automatic invoices", hint: "The monthly cutoff and what it makes", icon: AM_ICON.fields, tone: "amber", shortcut: "A", onSelect: () => setAutoOpen(true) },
        ]} />
      </header>
      {err && <p className="bz-err">{/does not exist|column/i.test(err) ? "Billing needs src/base/sql/103_base_billing.sql in Supabase." : err}</p>}

      <div className="bz-stage" key={view}>
        {view === "invoices" && (
          <>
            <BzKpis defs={INV_KPIS} rows={invShown} prefKey="billingInvKpis" fallback={INV_KPI_DEFAULT} ready={!!invoices} />
            <FilterChips fields={INV_FIELDS} view={invView} onView={setInvView} onEdit={() => setFiltersTick((x) => x + 1)} shown={invShown.length} total={invRows.length} noun={noun} />
            {picked.length > 0 && (
              <div className="bz-selbar">
                <b>{picked.length} selected</b><span>{money(round2(picked.reduce((a, i) => a + i.amount, 0)))}</span>
                <button onClick={() => setExporting(picked)}><Ico d={IC.download} s={14} />Export XML</button>
                <button onClick={() => setSel(new Set())}>Clear</button>
              </div>
            )}
            <BzList<InvRow> ready={!!invoices} rows={invShown} all={invRows} fields={INV_FIELDS} cols={invCols} view={invView} onView={setInvView}
              nameLabel="Client" rowKey={(r) => r.i.id} rowClass={(r) => `is-${r.s}`} onOpen={(r) => void openInvoice(r.i)}
              name={(r) => <><Avatar name={r.client} size={34} square /><span><b>{r.client}</b><small>{r.i.bill_to?.email || r.i.bill_to?.legal_name || ""}</small></span></>}
              cell={invCell(today)}
              check={{ on: (r) => sel.has(r.i.id), all: invShown.length > 0 && invShown.every((r) => sel.has(r.i.id)), some: invShown.some((r) => sel.has(r.i.id)),
                toggle: (rs, on) => setSel((s) => { const n = new Set(s); rs.forEach((r) => (on ? n.add(r.i.id) : n.delete(r.i.id))); return n; }) }}
              empty={invRows.length === 0
                ? <div className="bz-emptybig"><span className="bz-emptyico"><Ico d={V_ICON.invoices} s={28} /></span><h3>No invoices sent yet</h3><p>Drafts — yours and the ones made on the cutoff — wait in <b>To invoice</b> until they're sent.</p></div>
                : <p className="bz-none is-box">No invoices match.</p>} />
          </>
        )}
        {view === "toinvoice" && (
          <>
            <BzKpis defs={TO_KPIS(auto)} rows={toShown} prefKey="billingToKpis" fallback={TO_KPI_DEFAULT} ready={!!invoices && !!unbilled} />
            <div className="bz-toolbar">
              <div className="bz-chips">
                {(["all", "auto", "manual", "tobill"] as const).map((k) => (
                  <button key={k} className={`bz-chip is-${k} ${stage === k ? "is-on" : ""}`} onClick={() => setStage(k)}>
                    {k !== "all" && <em />}{k === "all" ? "Everything" : STAGE_LABEL[k]}<i>{k === "all" ? toRows.length : toRows.filter((r) => r.stage === k).length}</i>
                  </button>
                ))}
              </div>
              <FilterChips fields={TO_FIELDS} view={toView} onView={setToView} onEdit={() => setFiltersTick((x) => x + 1)} shown={toShown.length} total={toRows.length} noun={noun} />
            </div>
            <BzList<ToRow> ready={!!invoices && !!unbilled} rows={toShown} all={toRows} fields={TO_FIELDS} cols={toCols} view={toView} onView={setToView}
              nameLabel="Client" rowKey={(r) => r.key} rowClass={(r) => `is-${r.stage}`}
              onOpen={(r) => (r.inv ? void openInvoice(r.inv) : r.cid && void newInvoice(r.cid, r.entries ?? []))}
              name={(r) => <><Avatar name={r.client} size={34} square /><span><b>{r.client}</b><small>{r.note}</small></span></>}
              cell={toCell(personOf)}
              action={(r) => <span className={`bz-bill is-sm ${r.inv ? "is-ghost" : ""}`}>{r.inv ? "Review & send" : "Create invoice"}</span>}
              empty={toRows.length === 0
                ? <div className="bz-emptybig"><span className="bz-emptyico"><Ico d={IC.clock} s={28} /></span><h3>Nothing waiting to be invoiced</h3><p>Drafts and the work and shipments logged for a client in the <b>Calendar</b> show up here until they're on an invoice.</p></div>
                : <p className="bz-none is-box">Nothing matches.</p>} />
          </>
        )}
        {view === "time" && <TimeView clients={clientOf} personOf={personOf} people={people} me={full ? null : me} catalog={catalog} />}
      </div>

      {colsOpen && isList && (
        <ColumnsDrawer title={view === "invoices" ? "Invoiced · list columns" : "To invoice · list columns"}
          available={(view === "invoices" ? INV_FIELDS : TO_FIELDS).filter((f) => f.key !== "client").map((f) => ({ key: f.key, label: f.label }))}
          columns={view === "invoices" ? invCols : toCols} onColumns={saveCols} onClose={() => setColsOpen(false)} />
      )}
      {autoOpen && (
        <AutoInvoiceModal settings={auto ?? AUTO_DEFAULT} unbilled={unbilled ?? []} clients={clientOf} catalog={catalog}
          onClose={() => setAutoOpen(false)} onSaved={setAuto} onBilled={() => void reload()} />
      )}
      {exporting && <ExportModal invoices={exporting} seller={seller} nameOf={nameOf} onSeller={setSeller} onClose={() => setExporting(null)} />}
      {open && (
        <InvoiceModal key={open.id ?? open.number} draft={open} clients={clients} catalog={catalog} seller={seller}
          onClose={() => setOpen(null)} onChanged={() => void reload()}
          onExport={(d) => { const inv = invoices?.find((i) => i.id === d.id); if (inv) setExporting([inv]); }} />
      )}
    </div>
  );
}

/* ============================ the two lists' data ============================ */
interface InvRow { i: Invoice; s: InvState; client: string }
type Stage = "auto" | "manual" | "tobill";
const STAGE_LABEL: Record<Stage, string> = { auto: "Proposed · automatic", manual: "Proposed · manual", tobill: "To bill" };
interface ToRow {
  key: string; stage: Stage; client: string; cid: string | null; number: string; date: string;
  /** Before tax · with tax (for work: at the client's tax rate). */
  value: number; total: number; hours: number; units: number; people: string[]; note: string;
  inv?: Invoice; entries?: WorkEntry[];
}
const ST_OPTS = (["unpaid", "overdue", "paid", "void"] as InvState[]).map((s) => ({ value: s, label: STATE_LABEL[s] }));
const INV_FIELDS: FField<InvRow>[] = [
  { key: "client", label: "Client", group: "Invoice", type: "text", get: (r) => r.client },
  { key: "number", label: "Number", group: "Invoice", type: "text", get: (r) => r.i.number },
  { key: "issue_date", label: "Issued", group: "Dates", type: "date", get: (r) => r.i.issue_date },
  { key: "due_date", label: "Due", group: "Dates", type: "date", get: (r) => r.i.due_date },
  { key: "amount", label: "Total", group: "Amounts", type: "number", get: (r) => r.i.amount },
  { key: "status", label: "Status", group: "Invoice", type: "select", get: (r) => r.s, options: () => ST_OPTS },
  { key: "net", label: "Before tax", group: "Amounts", type: "number", get: (r) => r.i.net },
  { key: "tax", label: "Tax", group: "Amounts", type: "number", get: (r) => round2(r.i.amount - r.i.net) },
  { key: "sent_date", label: "Sent", group: "Dates", type: "date", get: (r) => r.i.sent_date },
  { key: "paid_date", label: "Paid on", group: "Dates", type: "date", get: (r) => r.i.paid_date },
  { key: "source", label: "Made", group: "Invoice", type: "select", get: (r) => r.i.source, options: () => [{ value: "auto", label: "Automatic" }, { value: "manual", label: "Manual" }] },
  { key: "email", label: "Billing e-mail", group: "Invoice", type: "text", get: (r) => r.i.bill_to?.email ?? "" },
];
const INV_COLS_DEFAULT = ["number", "issue_date", "due_date", "amount", "status"];
const TO_FIELDS: FField<ToRow>[] = [
  { key: "client", label: "Client", group: "Item", type: "text", get: (r) => r.client },
  { key: "stage", label: "Stage", group: "Item", type: "select", get: (r) => r.stage, options: () => (Object.keys(STAGE_LABEL) as Stage[]).map((k) => ({ value: k, label: STAGE_LABEL[k] })) },
  { key: "number", label: "Number", group: "Item", type: "text", get: (r) => r.number },
  { key: "date", label: "Date", group: "Item", type: "date", get: (r) => r.date },
  { key: "hours", label: "Hours", group: "Work", type: "number", get: (r) => r.hours },
  { key: "units", label: "Units", group: "Work", type: "number", get: (r) => r.units },
  { key: "value", label: "Before tax", group: "Amounts", type: "number", get: (r) => r.value },
  { key: "total", label: "With tax", group: "Amounts", type: "number", get: (r) => r.total },
  { key: "people", label: "Who", group: "Work", type: "number", get: (r) => r.people.length },
];
const TO_COLS_DEFAULT = ["stage", "number", "date", "hours", "value"];

const invCell = (today: string) => (k: string, r: InvRow): ReactNode => {
  const i = r.i;
  switch (k) {
    case "number": return <span className="bz-no">{i.number || "—"}{i.source === "auto" && <em className="bz-src is-auto" title="Made by the system on the cutoff">Auto</em>}</span>;
    case "issue_date": return <span className="bz-d">{fmtDate(i.issue_date)}</span>;
    case "due_date": {
      const late = i.due_date ? daysBetween(i.due_date, today) : 0;
      return <span className="bz-d">{fmtDate(i.due_date)}{r.s === "overdue" && <em className="is-late">{late}d late</em>}{r.s === "unpaid" && <em>in {-late}d</em>}{r.s === "paid" && i.paid_date && <em className="is-ok">paid {fmtShort(i.paid_date)}</em>}</span>;
    }
    case "amount": return <span className="bz-amt">{money(i.amount)}</span>;
    case "net": return <span className="bz-amt is-soft">{money(i.net)}</span>;
    case "tax": return <span className="bz-amt is-soft">{money(round2(i.amount - i.net))}</span>;
    case "status": return <i className={`bz-pill is-${r.s}`}>{STATE_LABEL[r.s]}</i>;
    case "sent_date": return <span className="bz-d">{fmtDate(i.sent_date)}</span>;
    case "paid_date": return <span className="bz-d">{fmtDate(i.paid_date)}</span>;
    case "source": return <em className={`bz-src is-${i.source}`}><Ico d={i.source === "auto" ? IC.bolt : IC.pen} s={12} />{i.source === "auto" ? "Automatic" : "Manual"}</em>;
    case "email": return <span className="bz-d">{i.bill_to?.email || "—"}</span>;
    default: return "—";
  }
};
const toCell = (personOf: (id: string) => string) => (k: string, r: ToRow): ReactNode => {
  switch (k) {
    case "stage": return <em className={`bz-src is-${r.stage}`}><Ico d={r.stage === "auto" ? IC.bolt : r.stage === "manual" ? IC.pen : IC.clock} s={12} />{STAGE_LABEL[r.stage]}</em>;
    case "number": return r.number ? <span className="bz-no">{r.number}</span> : <span className="bz-mute">not yet</span>;
    case "date": return <span className="bz-d">{r.stage === "tobill" ? `since ${fmtShort(r.date)}` : fmtDate(r.date)}</span>;
    case "hours": return r.hours ? <span className="bz-d"><b>{hrs(r.hours)}</b></span> : <span className="bz-mute">—</span>;
    case "units": return r.units ? <span className="bz-d"><b>{r.units}</b>&nbsp;u</span> : <span className="bz-mute">—</span>;
    case "value": return <span className="bz-amt">{money(r.value)}</span>;
    case "total": return <span className="bz-amt is-soft">{money(r.total)}</span>;
    case "people": return r.people.length ? <span className="bz-stack">{r.people.slice(0, 4).map((u) => <Avatar key={u} name={personOf(u)} size={24} />)}{r.people.length > 4 && <em>+{r.people.length - 4}</em>}</span> : <span className="bz-mute">—</span>;
    default: return "—";
  }
};

/* ============================ one list, every column a header filter ============================ */
const COL_W: Record<string, string> = {
  number: "minmax(120px, 0.8fr)", issue_date: "minmax(110px, 0.8fr)", due_date: "minmax(170px, 1.2fr)", amount: "minmax(110px, 0.8fr)",
  status: "minmax(100px, 0.7fr)", net: "minmax(110px, 0.8fr)", tax: "minmax(100px, 0.7fr)", sent_date: "minmax(110px, 0.8fr)",
  paid_date: "minmax(110px, 0.8fr)", source: "minmax(120px, 0.8fr)", email: "minmax(180px, 1.2fr)",
  stage: "minmax(170px, 1.1fr)", date: "minmax(110px, 0.8fr)", hours: "minmax(80px, 0.6fr)", units: "minmax(80px, 0.6fr)",
  value: "minmax(110px, 0.8fr)", total: "minmax(110px, 0.8fr)", people: "minmax(100px, 0.7fr)",
};
const RIGHT = new Set(["amount", "net", "tax", "value", "total"]);
function BzList<T>({ ready, rows, all, fields, cols, view, onView, nameLabel, rowKey, rowClass, onOpen, name, cell, check, action, empty }: {
  ready: boolean; rows: T[]; all: T[]; fields: FField<T>[]; cols: string[]; view: FView; onView: (v: FView) => void;
  nameLabel: string; rowKey: (r: T) => string; rowClass: (r: T) => string; onOpen: (r: T) => void;
  name: (r: T) => ReactNode; cell: (k: string, r: T) => ReactNode; action?: (r: T) => ReactNode; empty: ReactNode;
  check?: { on: (r: T) => boolean; all: boolean; some: boolean; toggle: (rs: T[], on: boolean) => void };
}) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const shownCols = cols.filter((k) => byKey.has(k) && k !== "client");
  const grid = ["minmax(240px, 2.2fr)", ...shownCols.map((k) => COL_W[k] ?? "minmax(110px, 0.8fr)"), ...(action ? ["150px"] : [])].join(" ");
  const style = { gridTemplateColumns: grid } as CSSProperties;
  if (!ready) return <div className="bz-loading"><span /><span /><span /><span /></div>;
  if (!all.length) return <>{empty}</>;
  return (
    <div className="bz-scroll">
      <div className="bz-lhead" style={style}>
        <span className="bz-cl ch-cell">
          {check && <Check on={check.all} some={check.some} onChange={(on) => check.toggle(rows, on)} label="Select all shown" />}
          <ColumnHead label={nameLabel} view={view} onView={onView} rows={all} fields={[byKey.get("client")]} sortKey="client" />
        </span>
        {shownCols.map((k) => (
          <span key={k} className={`ch-cell ${RIGHT.has(k) ? "is-r" : ""}`}><ColumnHead label={byKey.get(k)!.label} view={view} onView={onView} rows={all} fields={[byKey.get(k)]} sortKey={k} /></span>
        ))}
        {action && <span />}
      </div>
      {!rows.length ? empty : (
        <div className="bz-lbody">
          {rows.map((r, k) => (
            <div key={rowKey(r)} role="button" tabIndex={0} className={`bz-lrow ${rowClass(r)} ${check?.on(r) ? "is-sel" : ""}`} style={{ ...style, ["--i" as string]: Math.min(k, 14) }}
              onClick={() => onOpen(r)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(r); }}>
              <span className="bz-cl">{check && <Check on={check.on(r)} onChange={(on) => check.toggle([r], on)} label="Select" />}{name(r)}</span>
              {shownCols.map((c) => <span key={c} className={RIGHT.has(c) ? "is-r" : ""}>{cell(c, r)}</span>)}
              {action && <span className="bz-lact">{action(r)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The list's columns: Client first, then as many as you like, dragged into order (the editor of Contacts / Companies). */
function ColumnsDrawer({ title, available, columns, onColumns, onClose }: {
  title: string; available: { key: string; label: string }[]; columns: string[]; onColumns: (next: string[]) => void; onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dw-backdrop" onMouseDown={onClose}>
      <div className="dw dw-narrow" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dw-head">
          <div><span className="dw-eyebrow">Configure</span><h2 className="dw-title">{title}</h2></div>
          <button className="dw-x" onClick={onClose}>×</button>
        </div>
        <div className="dw-body"><div className="dw-sec">
          <p className="dw-sec-title">Overview columns</p>
          <ColumnsEditor availableColumns={available} columns={columns.filter((k) => available.some((a) => a.key === k))} onColumns={onColumns} />
        </div></div>
        <div className="dw-foot"><div className="dw-foot-right"><button className="dw-save" onClick={onClose}>Done</button></div></div>
      </div>
    </div>
  );
}

/* ============================ the figures on top (yours to pick) ============================ */
interface KpiDef<T> { key: string; label: string; icon: string; calc: (rs: T[]) => { v: string; sub?: string; bar?: number } }
const pct = (a: number, b: number) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
const sumBy = <T,>(rs: T[], f: (r: T) => number) => round2(rs.reduce((s, r) => s + f(r), 0));
const thisMonth = () => todayIso().slice(0, 7);
const INV_KPIS: KpiDef<InvRow>[] = [
  { key: "waiting", label: "Waiting to be paid", icon: IC.clock, calc: (rs) => { const xs = rs.filter((r) => r.s === "unpaid"); return { v: money0(sumBy(xs, (r) => r.i.amount)), sub: `${xs.length} sent · not due yet` }; } },
  { key: "overdue", label: "Overdue", icon: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", calc: (rs) => { const xs = rs.filter((r) => r.s === "overdue"); const open = rs.filter((r) => r.s === "unpaid" || r.s === "overdue"); return { v: money0(sumBy(xs, (r) => r.i.amount)), sub: xs.length ? `${xs.length} past their due date` : "Nothing late", bar: pct(sumBy(xs, (r) => r.i.amount), sumBy(open, (r) => r.i.amount)) }; } },
  { key: "paidMonth", label: "Paid this month", icon: IC.check, calc: (rs) => { const m = thisMonth(); const xs = rs.filter((r) => r.s === "paid" && (r.i.paid_date ?? "").startsWith(m)); return { v: money0(sumBy(xs, (r) => r.i.amount)), sub: `${xs.length} invoice${xs.length === 1 ? "" : "s"}` }; } },
  { key: "issuedMonth", label: "Invoiced this month", icon: IC.doc, calc: (rs) => { const m = thisMonth(); const xs = rs.filter((r) => r.s !== "void" && r.i.issue_date.startsWith(m)); return { v: money0(sumBy(xs, (r) => r.i.amount)), sub: `${xs.length} issued` }; } },
  { key: "issuedYear", label: "Invoiced this year", icon: IC.doc, calc: (rs) => { const y = todayIso().slice(0, 4); const xs = rs.filter((r) => r.s !== "void" && r.i.issue_date.startsWith(y)); return { v: money0(sumBy(xs, (r) => r.i.amount)), sub: `${xs.length} invoices · ${money0(sumBy(xs, (r) => r.i.net))} before tax` }; } },
  { key: "paidYear", label: "Collected this year", icon: IC.check, calc: (rs) => { const y = todayIso().slice(0, 4); const all = rs.filter((r) => r.s !== "void" && r.i.issue_date.startsWith(y)); const xs = all.filter((r) => r.s === "paid"); return { v: money0(sumBy(xs, (r) => r.i.amount)), sub: `${Math.round(pct(sumBy(xs, (r) => r.i.amount), sumBy(all, (r) => r.i.amount)))}% of what was invoiced`, bar: pct(sumBy(xs, (r) => r.i.amount), sumBy(all, (r) => r.i.amount)) }; } },
  { key: "daysToPay", label: "Days to get paid", icon: IC.clock, calc: (rs) => { const xs = rs.filter((r) => r.s === "paid" && r.i.paid_date); const d = xs.length ? Math.round(xs.reduce((s, r) => s + Math.max(0, daysBetween(r.i.issue_date, r.i.paid_date!)), 0) / xs.length) : null; return { v: d == null ? "—" : `${d} d`, sub: xs.length ? `average of ${xs.length} paid invoices` : "nothing paid yet" }; } },
  { key: "avg", label: "Average invoice", icon: IC.doc, calc: (rs) => { const xs = rs.filter((r) => r.s !== "void"); return { v: xs.length ? money0(sumBy(xs, (r) => r.i.amount) / xs.length) : "—", sub: `${new Set(xs.map((r) => r.client)).size} clients` }; } },
  { key: "count", label: "Invoices", icon: IC.doc, calc: (rs) => ({ v: String(rs.length), sub: `${rs.filter((r) => r.s === "paid").length} paid · ${rs.filter((r) => r.s === "unpaid" || r.s === "overdue").length} open` }) },
];
const INV_KPI_DEFAULT = ["waiting", "overdue", "paidMonth", "issuedMonth"];
const TO_KPIS = (auto: AutoSettings | null): KpiDef<ToRow>[] => [
  { key: "all", label: "Still to invoice", icon: IC.doc, calc: (rs) => ({ v: money0(sumBy(rs, (r) => r.value)), sub: `before tax · ${rs.filter((r) => r.stage !== "tobill").length} proposed · ${rs.filter((r) => r.stage === "tobill").length} to bill` }) },
  { key: "proposed", label: "Proposed invoices", icon: IC.send, calc: (rs) => { const xs = rs.filter((r) => r.stage !== "tobill"); return { v: money0(sumBy(xs, (r) => r.value)), sub: `${xs.filter((r) => r.stage === "auto").length} automatic · ${xs.filter((r) => r.stage === "manual").length} manual`, bar: pct(sumBy(xs, (r) => r.value), sumBy(rs, (r) => r.value)) }; } },
  { key: "auto", label: "Proposed · automatic", icon: IC.bolt, calc: (rs) => { const xs = rs.filter((r) => r.stage === "auto"); return { v: money0(sumBy(xs, (r) => r.value)), sub: `${xs.length} draft${xs.length === 1 ? "" : "s"} from the cutoff` }; } },
  { key: "manual", label: "Proposed · manual", icon: IC.pen, calc: (rs) => { const xs = rs.filter((r) => r.stage === "manual"); return { v: money0(sumBy(xs, (r) => r.value)), sub: `${xs.length} written by hand` }; } },
  { key: "tobill", label: "To bill", icon: IC.clock, calc: (rs) => { const xs = rs.filter((r) => r.stage === "tobill"); return { v: money0(sumBy(xs, (r) => r.value)), sub: `${xs.length} client${xs.length === 1 ? "" : "s"} with work not on an invoice` }; } },
  { key: "hours", label: "Hours not invoiced", icon: IC.clock, calc: (rs) => ({ v: hrs(sumBy(rs, (r) => r.hours)), sub: `${rs.filter((r) => r.hours > 0).length} clients` }) },
  { key: "units", label: "Units not invoiced", icon: IC.box, calc: (rs) => ({ v: String(rs.reduce((s, r) => s + r.units, 0)), sub: `${rs.filter((r) => r.units > 0).length} clients · shipped` }) },
  { key: "oldest", label: "Oldest work to bill", icon: IC.clock, calc: (rs) => { const xs = rs.filter((r) => r.stage === "tobill").sort((a, b) => (a.date < b.date ? -1 : 1)); return xs.length ? { v: `${daysBetween(xs[0].date, todayIso())} d`, sub: `${xs[0].client} · since ${fmtShort(xs[0].date)}` } : { v: "—", sub: "nothing waiting" }; } },
  { key: "cutoff", label: "Next cutoff", icon: IC.bolt, calc: () => {
    if (!auto?.auto_invoice) return { v: "By hand", sub: "set up automatic invoices in Actions" };
    const c = nextCutoff(auto.cutoff_day); const left = daysBetween(todayIso(), c);
    return { v: left === 0 ? "Today" : `${left} d`, sub: `up to ${fmtShort(c)} · ${auto.auto_send ? "sent" : "drafts to review"} on ${fmtShort(addDays(c, 1))}`, bar: pct(30 - Math.min(30, left), 30) };
  } },
];
const TO_KPI_DEFAULT = ["all", "proposed", "tobill", "cutoff"];

function BzKpis<T>({ defs, rows, prefKey, fallback, ready }: { defs: KpiDef<T>[]; rows: T[]; prefKey: string; fallback: string[]; ready: boolean }) {
  const [keys, setKeys] = useState<string[]>(fallback);
  const [edit, setEdit] = useState(false);
  useEffect(() => { loadPrefs().then((p) => { if (Array.isArray(p[prefKey]) && p[prefKey].length) setKeys(p[prefKey]); }).catch(() => {}); }, [prefKey]);
  const toggle = (k: string) => {
    const next = keys.includes(k) ? (keys.length > 1 ? keys.filter((x) => x !== k) : keys) : keys.length >= 6 ? keys : [...keys, k];
    setKeys(next); savePref(prefKey, next).catch(() => {});
  };
  const shown = keys.map((k) => defs.find((d) => d.key === k)).filter((d): d is KpiDef<T> => !!d);
  return (
    <section className="bz-kpix" style={{ ["--n" as string]: shown.length } as CSSProperties}>
      {shown.map((d, i) => {
        const r = ready ? d.calc(rows) : { v: "—", sub: "" };
        return (
          <div key={d.key} className={`bz-kx is-p${Math.min(i, 2)}`} style={{ ["--i" as string]: i }}>
            <span className="bz-kx-top"><i><Ico d={d.icon} s={15} /></i><em>{d.label}</em></span>
            <b>{r.v}</b>
            <small>{r.sub || " "}</small>
            <span className={`bz-kx-bar ${r.bar == null ? "is-ghost" : ""}`}><s style={{ width: `${r.bar ?? 0}%` }} /></span>
          </div>
        );
      })}
      <div className="bz-kx-edit">
        <button className={edit ? "is-on" : ""} onClick={() => setEdit((x) => !x)} title="Choose the figures" aria-label="Choose the figures">
          <Ico d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" s={17} />
        </button>
        {edit && (
          <>
            <div className="bz-kx-scrim" onMouseDown={() => setEdit(false)} />
            <div className="bz-kx-pop" role="dialog" aria-label="Choose the figures">
              <b>Figures on top</b>
              <small>Up to 6 — remembered for you. They follow the list's filters.</small>
              {defs.map((d) => {
                const on = keys.includes(d.key);
                return (
                  <button key={d.key} className={on ? "is-on" : ""} onClick={() => toggle(d.key)}>
                    <i>{on && <Ico d={IC.check} s={12} />}</i><span><Ico d={d.icon} s={14} /></span>{d.label}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/* ============================ the view switch: icons, names on hover (as Orbit's) ============================ */
function BzSwitch({ on, onPick, badge }: { on: View; onPick: (v: View) => void; badge: Partial<Record<View, number>> }) {
  const [openN, setOpenN] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const light = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const timer = useRef(0);
  const place = (animate: boolean) => {
    const b = box.current?.querySelector<HTMLElement>("button.is-on");
    const l = light.current;
    if (!b || !l || !b.offsetWidth) return;
    l.style.transition = animate && placed.current ? "" : "none";
    l.style.transform = `translateX(${b.offsetLeft}px)`;
    l.style.width = `${b.offsetWidth}px`;
    placed.current = true;
  };
  useLayoutEffect(() => { place(true); }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => place(false));
    el.querySelectorAll("button").forEach((b) => ro.observe(b));
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const intend = (o: boolean) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpenN(o), o ? 40 : 120); };
  return (
    <div className="ob-nav">
      <div ref={box} className={`ob-title ${openN ? "is-open" : ""}`} role="tablist" aria-label="Billing views" onMouseEnter={() => intend(true)} onMouseLeave={() => intend(false)}>
        <span ref={light} className="ob-light" aria-hidden="true" />
        {(["invoices", "toinvoice", "time"] as View[]).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={v === on} aria-label={V_LABEL[v]} title={V_LABEL[v]} className={v === on ? "is-on" : ""} onClick={() => onPick(v)}>
            <Ico d={V_ICON[v]} s={18} />
            {!!badge[v] && <i className="bz-sw-n">{badge[v]}</i>}
            <span className="ob-lbl">{V_LABEL[v]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A checkbox inside a clickable row (doesn't open the row). */
function Check({ on, some, onChange, label }: { on: boolean; some?: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <span role="checkbox" aria-checked={on ? true : some ? "mixed" : false} aria-label={label} tabIndex={0}
      className={`bz-check ${on ? "is-on" : some ? "is-some" : ""}`}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onChange(!on); } }}>
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d={on ? "M20 6L9 17l-5-5" : "M6 12h12"} /></svg>
    </span>
  );
}

/* ================================= Time ================================= */
const SEG = ["#12b57f", "#3c7fd0", "#e0a13c", "#9b6fd0", "#e0798c", "#1a9e9a", "#7d8b84", "#5b6ee1", "#c9772f", "#4a9a3f"];
function TimeView({ clients, personOf, people, me, catalog }: {
  clients: Map<string, BClient>; personOf: (id: string) => string; people: Person[]; me: string | null; catalog: CatItem[];
}) {
  /** Hours logged on clients, or units shipped (products sold) — remembered on this browser. */
  const [mode, setMode] = useState<"hours" | "units">(() => { try { return localStorage.getItem("bz.time.mode") === "units" ? "units" : "hours"; } catch { return "hours"; } });
  const pickMode = (m: "hours" | "units") => { setMode(m); try { localStorage.setItem("bz.time.mode", m); } catch { /* ignore */ } };
  const [all, setAll] = useState<WorkEntry[] | null>(null);
  const [anchor, setAnchor] = useState(() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), 1); });
  /** The pop-up: one person's month, or one client's. */
  const [openP, setOpenP] = useState<{ kind: "person" | "client"; id: string } | null>(null);
  const from = iso(anchor);
  const to = iso(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0));
  useEffect(() => {
    let alive = true; setAll(null);
    loadWork(from, to).then((w) => { if (alive) setAll(w.filter((e) => !me || e.user_id === me)); }).catch(() => alive && setAll([]));
    return () => { alive = false; };
  }, [from, to, me]);
  const units = mode === "units";
  /** What one entry counts for: its hours, or the units it shipped. */
  const amt = (e: WorkEntry) => (units ? e.quantity || 1 : e.hours);
  const fmtA = (n: number) => (units ? `${round2(n).toLocaleString("en-GB")} u` : hrs(n));
  const work = useMemo(() => (all ? all.filter((e) => e.kind === (units ? "shipment" : "client_work")) : null), [all, units]);
  const productOf = useCallback((e: WorkEntry) => e.name?.replace(/^\d+\s*×\s*/, "") || catalog.find((x) => x.id === e.product_id)?.name || "Product", [catalog]);
  const move = (n: number) => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + n, 1));

  const byClient = useMemo(() => {
    const m = new Map<string, { h: number; users: Set<string> }>();
    (work ?? []).forEach((e) => { const x = m.get(e.client_id) ?? { h: 0, users: new Set() }; x.h += amt(e); x.users.add(e.user_id); m.set(e.client_id, x); });
    return Array.from(m, ([c, x]) => ({ c, h: round2(x.h), users: Array.from(x.users) })).sort((a, b) => b.h - a.h);
  }, [work]); // eslint-disable-line react-hooks/exhaustive-deps
  /** One colour per client, the busiest first. */
  const colorOf = useMemo(() => new Map(byClient.map((c, i) => [c.c, SEG[i % SEG.length]])), [byClient]);
  const byPerson = useMemo(() => {
    const m = new Map<string, WorkEntry[]>();
    (work ?? []).forEach((e) => { const g = m.get(e.user_id); if (g) g.push(e); else m.set(e.user_id, [e]); });
    return Array.from(m, ([u, es]) => {
      const perClient = new Map<string, number>();
      es.forEach((e) => perClient.set(e.client_id, (perClient.get(e.client_id) ?? 0) + amt(e)));
      return {
        u, name: personOf(u), total: round2(es.reduce((s, e) => s + amt(e), 0)),
        billed: round2(es.filter((e) => e.invoice_id).reduce((s, e) => s + amt(e), 0)),
        days: new Set(es.map((e) => e.date)).size,
        clients: Array.from(perClient, ([c, h]) => ({ c, h: round2(h) })).sort((a, b) => b.h - a.h),
      };
    }).sort((a, b) => b.total - a.total);
  }, [work, personOf]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Units: which products went out, and how many. */
  const byProduct = useMemo(() => {
    if (!units) return [];
    const m = new Map<string, number>();
    (work ?? []).forEach((e) => { const k = productOf(e); m.set(k, (m.get(k) ?? 0) + amt(e)); });
    return Array.from(m, ([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  }, [work, units, productOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const max = Math.max(1, ...byPerson.map((p) => p.total));
  const maxC = Math.max(1, ...byClient.map((c) => c.h));
  const total = round2(byPerson.reduce((s, p) => s + p.total, 0));
  const billed = round2(byPerson.reduce((s, p) => s + p.billed, 0));
  const cname = (id: string) => clients.get(id)?.name ?? "—";
  const isNow = from.slice(0, 7) === todayIso().slice(0, 7);

  return (
    <div className="bz-time">
      <section className="bz-hero is-time">
        <div className="bz-month">
          <button onClick={() => move(-1)} aria-label="Previous month">‹</button>
          <b>{MONTHS[anchor.getMonth()]} <span>{anchor.getFullYear()}</span></b>
          <button onClick={() => move(1)} aria-label="Next month" disabled={isNow}>›</button>
          {!isNow && <button className="bz-month-now" onClick={() => { const t = new Date(); setAnchor(new Date(t.getFullYear(), t.getMonth(), 1)); }}>This month</button>}
        </div>
        <div className="bz-seg" role="tablist" aria-label="Count">
          <button className={!units ? "is-on" : ""} onClick={() => pickMode("hours")}><Ico d={IC.clock} s={14} />Hours</button>
          <button className={units ? "is-on" : ""} onClick={() => pickMode("units")}><Ico d={IC.box} s={14} />Units</button>
        </div>
        <div className="bz-kpis">
          <span><b>{work ? fmtA(total) : "—"}</b><small>{units ? "shipped to clients" : "logged on clients"}</small></span>
          <span><b>{work ? byPerson.length : "—"}</b><small>{byPerson.length === 1 ? "person" : "people"}</small></span>
          <span><b>{work ? byClient.length : "—"}</b><small>clients</small></span>
          <span><b>{work && total ? `${Math.round((billed / total) * 100)}%` : "—"}</b><small>already billed</small></span>
        </div>
      </section>
      {!work ? <div className="bz-loading"><span /><span /><span /></div> : !byPerson.length ? (
        <div className="bz-emptybig">
          <span className="bz-emptyico"><Ico d={V_ICON.time} s={28} /></span>
          <h3>{units ? "Nothing shipped" : "No client work logged"} in {MONTHS[anchor.getMonth()]}</h3>
          <p>{units ? "Shipments logged for a client in the Calendar (units of a product) add up here, per person, per client and per product." : people.length > 1 || !me ? "Time logged for a client in the Calendar adds up here, per person and per client." : "Your time logged for a client in the Calendar adds up here."}</p>
        </div>
      ) : (
        <div className="bz-time-grid">
          <section className="bz-card">
            <header className="bz-card-h"><h3>By person</h3><small>Each bar is split by client · click a person for their month</small></header>
            {byPerson.map((p, k) => (
              <div key={p.u} className="bz-tp" style={{ ["--i" as string]: k }}>
                <button className="bz-tp-top" onClick={() => setOpenP({ kind: "person", id: p.u })}>
                  <Avatar name={p.name} size={38} />
                  <span className="bz-tp-n"><b>{p.name}</b><small>{p.days} day{p.days === 1 ? "" : "s"} · {p.clients.length} client{p.clients.length === 1 ? "" : "s"}</small></span>
                  <span className="bz-tp-bar">
                    <span style={{ width: `${(p.total / max) * 100}%` }}>
                      {p.clients.map(({ c, h }) => <i key={c} title={`${cname(c)} · ${fmtA(h)}`} style={{ flexGrow: h, background: colorOf.get(c) }} />)}
                    </span>
                  </span>
                  <span className="bz-tp-h"><b>{fmtA(p.total)}</b><small>{p.billed ? `${Math.round((p.billed / p.total) * 100)}% billed` : "not billed yet"}</small></span>
                </button>
              </div>
            ))}
          </section>
          <section className="bz-card">
            <header className="bz-card-h"><h3>By client</h3><small>{units ? "Who shipped to it and how many units" : "Who worked on it and for how long"}</small></header>
            {byClient.map((c, k) => (
              <div key={c.c} className="bz-tc is-click" role="button" tabIndex={0} style={{ ["--i" as string]: k }}
                onClick={() => setOpenP({ kind: "client", id: c.c })} onKeyDown={(e) => { if (e.key === "Enter") setOpenP({ kind: "client", id: c.c }); }}>
                <i className="bz-tc-dot" style={{ background: colorOf.get(c.c) }} />
                <span className="bz-tc-n">{cname(c.c)}</span>
                <span className="bz-stack is-sm">{c.users.slice(0, 4).map((u) => <Avatar key={u} name={personOf(u)} size={22} />)}</span>
                <span className="bz-tc-bar"><i style={{ width: `${(c.h / maxC) * 100}%`, background: colorOf.get(c.c) }} /></span>
                <b>{fmtA(c.h)}</b>
              </div>
            ))}
            {units && byProduct.length > 0 && (
              <>
                <header className="bz-card-h is-sub"><h3>By product</h3><small>Units shipped this month</small></header>
                {byProduct.map((p2, k) => (
                  <div key={p2.name} className="bz-tc" style={{ ["--i" as string]: k }}>
                    <i className="bz-tc-dot" style={{ background: "#0c875f" }} />
                    <span className="bz-tc-n">{p2.name}</span>
                    <span />
                    <span className="bz-tc-bar"><i style={{ width: `${(p2.n / Math.max(1, byProduct[0].n)) * 100}%`, background: "#12a374" }} /></span>
                    <b>{fmtA(p2.n)}</b>
                  </div>
                ))}
              </>
            )}
          </section>
        </div>
      )}
      {openP && work && (
        <TimeDetail kind={openP.kind} id={openP.id} entries={work.filter((e) => (openP.kind === "person" ? e.user_id : e.client_id) === openP.id)}
          title={openP.kind === "person" ? personOf(openP.id) : cname(openP.id)} month={`${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`}
          other={(e) => (openP.kind === "person" ? cname(e.client_id) : personOf(e.user_id))} colorOf={(e) => (openP.kind === "person" ? colorOf.get(e.client_id) ?? "#12a374" : "#12a374")}
          amt={amt} fmtA={fmtA} units={units} what={(e) => (units ? productOf(e) : e.notes || "Work")} onClose={() => setOpenP(null)} />
      )}
    </div>
  );
}

/** Time: one person's month (by client) or one client's month (by person), day by day — a pop-up in the Billing look. */
function TimeDetail({ kind, title, month, entries, other, colorOf, amt, fmtA, units, what, onClose }: {
  kind: "person" | "client"; id: string; title: string; month: string; entries: WorkEntry[];
  other: (e: WorkEntry) => string; colorOf: (e: WorkEntry) => string; amt: (e: WorkEntry) => number; fmtA: (n: number) => string;
  units: boolean; what: (e: WorkEntry) => string; onClose: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const close = () => { setClosing(true); window.setTimeout(onClose, 200); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const total = round2(entries.reduce((s, e) => s + amt(e), 0));
  const billed = round2(entries.filter((e) => e.invoice_id).reduce((s, e) => s + amt(e), 0));
  const split = useMemo(() => {
    const m = new Map<string, { n: number; color: string }>();
    entries.forEach((e) => { const k = other(e); const x = m.get(k) ?? { n: 0, color: colorOf(e) }; x.n += amt(e); m.set(k, x); });
    return Array.from(m, ([name, x]) => ({ name, n: round2(x.n), color: x.color })).sort((a, b) => b.n - a.n);
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => {
    const m = new Map<string, WorkEntry[]>();
    entries.forEach((e) => { const g = m.get(e.date); if (g) g.push(e); else m.set(e.date, [e]); });
    return Array.from(m, ([d, es]) => ({ d, es, n: round2(es.reduce((s, e) => s + amt(e), 0)) })).sort((a, b) => (a.d < b.d ? 1 : -1));
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = split[0]?.n || 1;
  return createPortal(
    <div className={`bzi-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="bzi-modal bzt-modal" role="dialog" aria-modal="true" aria-label={`${title} · ${month}`}>
        <header className="bzi-head">
          <Avatar name={title} size={44} square={kind === "client"} />
          <div className="bzi-head-t">
            <span className="bzi-kicker">{units ? "Units shipped" : "Time logged"} · {month}</span>
            <div className="bzi-head-row"><h2>{title}</h2></div>
          </div>
          <button className="bzi-x" onClick={close} aria-label="Close"><Ico d={IC.x} s={18} /></button>
        </header>
        <div className="bzt-body">
          <div className="bzt-figs">
            <span><b>{fmtA(total)}</b><small>{units ? "shipped" : "logged"} in {month.split(" ")[0]}</small></span>
            <span><b>{days.length}</b><small>day{days.length === 1 ? "" : "s"}</small></span>
            <span><b>{split.length}</b><small>{kind === "person" ? (split.length === 1 ? "client" : "clients") : (split.length === 1 ? "person" : "people")}</small></span>
            <span><b>{total ? `${Math.round((billed / total) * 100)}%` : "—"}</b><small>already on an invoice</small></span>
          </div>
          <section className="bzt-card">
            <h3>{kind === "person" ? "By client" : "By person"}</h3>
            <div className="bzt-split">
              {split.map((x) => (
                <div key={x.name}><i style={{ background: x.color }} /><em>{x.name}</em><b>{fmtA(x.n)}</b><u><s style={{ width: `${(x.n / top) * 100}%`, background: x.color }} /></u></div>
              ))}
            </div>
          </section>
          <section className="bzt-card">
            <h3>Day by day</h3>
            <div className="bzt-days">
              {days.map((g) => (
                <div key={g.d} className="bzt-day">
                  <header><b>{fmtDate(g.d)}</b><span>{fmtA(g.n)}</span></header>
                  {g.es.map((e) => (
                    <div key={e.id} className="bzt-ent">
                      <i style={{ background: colorOf(e) }} />
                      <span>{what(e)}<small>{other(e)}</small></span>
                      <em className={e.invoice_id ? "is-on" : ""}>{e.invoice_id ? "Invoiced" : "To bill"}</em>
                      <b>{fmtA(amt(e))}</b>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
