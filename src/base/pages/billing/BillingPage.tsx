/* =====================================================================
   BASE · Billing — one page for everything money-in:
     Invoices — write, send and follow up invoices (unpaid, overdue, paid)
     To bill  — work and shipments logged in the calendar, not billed yet,
                per client: one click makes the invoice
     Time     — what each person logged on each client in a month
   Base has no projects or types of work: anyone logs hours on a client in
   the calendar (the client's team says who may), and this is where they
   turn into invoices.
   ===================================================================== */
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { usePageAccess } from "../../framework/pageAccess";
import { useAuth } from "../../../components/api/AuthProvider";
import InvoiceModal, { IC } from "./InvoiceModal";
import AutoInvoiceModal from "./AutoInvoiceModal";
import {
  STATE_LABEL, AUTO_DEFAULT, autoTick, loadAutoSettings, nextCutoff, addDays, daysBetween, draftFor, fmtDate, fmtShort, hourlyRate, hrs, iso, linesFromWork, loadCatalog, loadClients,
  loadInvoices, loadLines, loadPeople, loadSeller, loadUnbilled, loadWork, money, money0, nextNumber, round2, stateOf, todayIso,
  type AutoSettings, type BClient, type CatItem, type Draft, type InvState, type Invoice, type Person, type WorkEntry,
} from "./billingApi";
import "./Billing.css";

type View = "invoices" | "tobill" | "time";
type Filter = "all" | InvState;

const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const V_ICON: Record<View, string> = {
  invoices: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
  tobill: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  time: "M4 20V10M10 20V4M16 20v-7M22 20H2",
};
const V_LABEL: Record<View, string> = { invoices: "Invoices", tobill: "To bill", time: "Time" };
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

  const [view, setView] = useState<View>(() => (new URLSearchParams(search).get("view") as View) || "invoices");
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [clients, setClients] = useState<BClient[]>([]);
  const [catalog, setCatalog] = useState<CatItem[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [seller, setSeller] = useState("");
  const [unbilled, setUnbilled] = useState<WorkEntry[] | null>(null);
  const [open, setOpen] = useState<Draft | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  /** When invoices are made (sql 104); null = not set up in the database yet. */
  const [auto, setAuto] = useState<AutoSettings | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);

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
  const personOf = useCallback((id: string) => people.find((p) => p.id === id)?.name ?? "Someone", [people]);

  /* ---------- open / new ---------- */
  const openInvoice = async (inv: Invoice) => {
    const { lines, entryIds } = await loadLines(inv.id);
    setOpen({
      id: inv.id, number: inv.number, client_id: inv.client_id ?? "", status: inv.status, issue_date: inv.issue_date,
      payment_days: inv.due_date ? Math.max(0, daysBetween(inv.issue_date, inv.due_date)) : 30, tax_rate: inv.tax_rate,
      notes: inv.notes, bill_to: inv.bill_to?.name ? inv.bill_to : (inv.client_id && clientOf.get(inv.client_id) ? { name: nameOf(inv.client_id) } : { name: "" }),
      lines, entry_ids: entryIds, sent_date: inv.sent_date, paid_date: inv.paid_date,
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

  return (
    <div className="bz">
      <header className="bz-head">
        <div className="bz-head-l">
          <h1 className="bz-title">Billing</h1>
          <nav className="bz-switch" role="tablist" aria-label="Billing views">
            {(["invoices", "tobill", "time"] as View[]).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? "is-on" : ""} onClick={() => go(v)}>
                <Ico d={V_ICON[v]} s={15} /><span>{V_LABEL[v]}</span>
                {v === "tobill" && (unbilled?.length ?? 0) > 0 && <i className="bz-dot">{new Set(unbilled!.map((e) => e.client_id)).size}</i>}
              </button>
            ))}
          </nav>
        </div>
        {view === "invoices" && (
          <label className="bz-search"><Ico d={IC.search} s={15} />
            <input value={q} placeholder="Search number or client" onChange={(e) => setQ(e.target.value)} />
            {q && <button onClick={() => setQ("")} aria-label="Clear">×</button>}
          </label>
        )}
        <button className={`bz-gear ${auto?.auto_invoice ? "is-on" : ""}`} onClick={() => setAutoOpen(true)} title="When invoices are made">
          <i />{auto?.auto_invoice ? `Auto · ${fmtDate(addDays(nextCutoff(auto.cutoff_day), 1)).replace(/ \d{4}$/, "")}` : "Automatic invoices"}
        </button>
        <button className="bz-new" onClick={() => void newInvoice()}><Ico d={IC.plus} s={15} />New invoice</button>
      </header>
      {err && <p className="bz-err">{/does not exist|column/i.test(err) ? "Billing needs src/base/sql/103_base_billing.sql in Supabase." : err}</p>}

      <div className="bz-stage" key={view}>
        {view === "invoices" && <InvoicesView invoices={invoices} nameOf={nameOf} filter={filter} setFilter={setFilter} q={q} onOpen={openInvoice} onNew={() => void newInvoice()} />}
        {view === "tobill" && <ToBillView entries={unbilled} clients={clientOf} catalog={catalog} personOf={personOf} onBill={(cid, es) => void newInvoice(cid, es)} auto={auto} onAuto={() => setAutoOpen(true)} />}
        {view === "time" && <TimeView clients={clientOf} personOf={personOf} people={people} me={full ? null : me} />}
      </div>

      {autoOpen && (
        <AutoInvoiceModal settings={auto ?? AUTO_DEFAULT} unbilled={unbilled ?? []} clients={clientOf} catalog={catalog}
          onClose={() => setAutoOpen(false)} onSaved={setAuto} onBilled={() => void reload()} />
      )}
      {open && (
        <InvoiceModal key={open.id ?? open.number} draft={open} clients={clients} catalog={catalog} seller={seller}
          onClose={() => setOpen(null)} onChanged={() => void reload()} />
      )}
    </div>
  );
}

/* ================================ Invoices ================================ */
const MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthTitle = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${MON_LONG[m - 1]} ${y}`; };
const S_ICON: Record<string, string> = {
  unpaid: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  overdue: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  paid: "M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4L12 14l-3-3",
  draft: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
};

/** A small area chart: the last months of a figure. */
function Spark({ values }: { values: number[] }) {
  const gid = `bzsp${useId().replace(/:/g, "")}`;
  const w = 96, h = 34, max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - (v / max) * (h - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg className="bz-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity="0.28" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0] - 1} cy={pts[pts.length - 1][1]} r="3" fill="#fff" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
/** A euro figure that counts up when it first shows. */
function CountMoney({ v }: { v: number }) {
  const [x, setX] = useState(0);
  useEffect(() => {
    let raf = 0; const t0 = performance.now(); const from = 0;
    const step = (t: number) => { const k = Math.min(1, (t - t0) / 900); const e = 1 - Math.pow(1 - k, 3); setX(from + (v - from) * e); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [v]);
  return <>{money0(x)}</>;
}

function InvoicesView({ invoices, nameOf, filter, setFilter, q, onOpen, onNew }: {
  invoices: Invoice[] | null; nameOf: (id: string | null) => string; filter: Filter; setFilter: (f: Filter) => void; q: string;
  onOpen: (i: Invoice) => void; onNew: () => void;
}) {
  const today = todayIso();
  const month = today.slice(0, 7);
  const list = invoices ?? [];
  const withState = useMemo(() => list.map((i) => ({ i, s: stateOf(i, today) })), [list, today]);
  const sum = (f: (x: { i: Invoice; s: InvState }) => boolean) => {
    const xs = withState.filter(f);
    return { n: xs.length, v: round2(xs.reduce((a, x) => a + x.i.amount, 0)) };
  };
  const out = sum((x) => x.s === "unpaid");
  const over = sum((x) => x.s === "overdue");
  const paid = sum((x) => x.s === "paid" && (x.i.paid_date ?? "").startsWith(month));
  const drafts = sum((x) => x.s === "draft");
  const open = out.v + over.v;
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: list.length };
    withState.forEach((x) => { c[x.s] = (c[x.s] ?? 0) + 1; });
    return c;
  }, [withState, list.length]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return withState.filter((x) => (filter === "all" || x.s === filter)
      && (!t || x.i.number.toLowerCase().includes(t) || nameOf(x.i.client_id).toLowerCase().includes(t) || (x.i.bill_to?.name ?? "").toLowerCase().includes(t)));
  }, [withState, filter, q, nameOf]);
  // by the month they were issued, newest first
  const groups = useMemo(() => {
    const m = new Map<string, typeof shown>();
    shown.forEach((x) => { const k = x.i.issue_date.slice(0, 7); m.set(k, [...(m.get(k) ?? []), x]); });
    return Array.from(m, ([k, xs]) => ({ k, xs, total: round2(xs.reduce((a, x) => a + x.i.amount, 0)) })).sort((a, b) => (a.k < b.k ? 1 : -1));
  }, [shown]);

  if (!invoices) return <div className="bz-loading"><span /><span /><span /><span /></div>;
  /** The last 6 months of a state, by the date that matters for it (paid: when paid; the rest: when issued). */
  const months = Array.from({ length: 6 }, (_, k) => { const d = new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 6 + k, 1); return iso(d).slice(0, 7); });
  const series = (key: InvState) => months.map((m) => round2(withState.filter((x) => x.s === key && ((key === "paid" ? x.i.paid_date : x.i.issue_date) ?? "").startsWith(m)).reduce((a, x) => a + x.i.amount, 0)));
  const paidPrev = series("paid")[4];
  const delta = paidPrev > 0 ? Math.round(((paid.v - paidPrev) / paidPrev) * 100) : null;
  const all = open + paid.v + drafts.v;
  const stat = (key: InvState, label: string, v: { n: number; v: number }, sub: ReactNode, i: number) => (
    <button className={`bz-kpi is-${key} ${filter === key ? "is-on" : ""}`} style={{ ["--i" as string]: i }} onClick={() => setFilter(filter === key ? "all" : key)}>
      <span className="bz-kpi-top"><i><Ico d={S_ICON[key]} s={17} /></i><em>{label}</em><u>{v.n}</u></span>
      <b><CountMoney v={v.v} /></b>
      <span className="bz-kpi-foot">
        <small>{sub}</small>
        <Spark values={series(key)} />
      </span>
      <span className="bz-kpi-share" aria-hidden="true"><s style={{ width: `${all ? (v.v / all) * 100 : 0}%` }} /></span>
    </button>
  );
  return (
    <div className="bz-inv">
      <section className="bz-kpis4">
        {stat("unpaid", "Waiting to be paid", out, `${out.n} sent · not due yet`, 0)}
        {stat("overdue", "Overdue", over, over.n ? `${over.n} past their due date` : "Nothing late", 1)}
        {stat("paid", "Paid this month", paid, delta == null ? `${paid.n} invoice${paid.n === 1 ? "" : "s"}` : <><span className={`bz-delta ${delta >= 0 ? "is-up" : "is-down"}`}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}%</span> vs {MON_LONG[Number(months[4].slice(5)) - 1].slice(0, 3)}</>, 2)}
        {stat("draft", "Drafts", drafts, drafts.n ? `${drafts.n} not sent yet` : "None", 3)}
      </section>

      <div className="bz-toolbar">
        <div className="bz-chips">
          {(["all", "draft", "unpaid", "overdue", "paid", "void"] as Filter[]).filter((f) => f === "all" || f === filter || counts[f]).map((f) => (
            <button key={f} className={`bz-chip is-${f} ${filter === f ? "is-on" : ""}`} onClick={() => setFilter(f)}>
              {f !== "all" && <em />}{f === "all" ? "All invoices" : STATE_LABEL[f]}<i>{counts[f] ?? 0}</i>
            </button>
          ))}
        </div>
        <span className="bz-count">{shown.length} shown · {money(round2(shown.reduce((a, x) => a + x.i.amount, 0)))}</span>
      </div>

      {list.length === 0 ? (
        <div className="bz-emptybig">
          <span className="bz-emptyico"><Ico d={V_ICON.invoices} s={28} /></span>
          <h3>No invoices yet</h3>
          <p>Write one from scratch, or bill the work your team logged in the calendar from <b>To bill</b>.</p>
          <button className="bz-new is-light" onClick={onNew}><Ico d={IC.plus} s={15} />New invoice</button>
        </div>
      ) : (
        <div className="bz-table">
          <div className="bz-row bz-rhead"><span>Client</span><span>Number</span><span>Issued</span><span>Due</span><span className="n">Amount</span><span>Status</span></div>
          {groups.length === 0 && <p className="bz-none">No invoices match.</p>}
          {groups.map((g) => (
            <div key={g.k} className="bz-group">
              <div className="bz-ghead"><b>{monthTitle(g.k)}</b><span>{g.xs.length} invoice{g.xs.length === 1 ? "" : "s"}</span><em>{money(g.total)}</em></div>
              {g.xs.map(({ i, s }, k) => {
                const late = i.due_date ? daysBetween(i.due_date, today) : 0;
                const cname = nameOf(i.client_id) !== "—" ? nameOf(i.client_id) : i.bill_to?.name || "—";
                return (
                  <button key={i.id} className={`bz-row is-${s}`} style={{ ["--i" as string]: Math.min(k, 12) }} onClick={() => onOpen(i)}>
                    <span className="bz-cl"><Avatar name={cname} size={34} square /><span><b>{cname}</b><small>{i.bill_to?.email || i.bill_to?.legal_name || ""}</small></span></span>
                    <span className="bz-no">{i.number || "—"}</span>
                    <span className="bz-d">{fmtDate(i.issue_date)}</span>
                    <span className="bz-d">
                      {fmtDate(i.due_date)}
                      {s === "overdue" && <em className="is-late">{late}d late</em>}
                      {s === "unpaid" && <em>in {-late}d</em>}
                      {s === "paid" && i.paid_date && <em className="is-ok">paid {fmtShort(i.paid_date)}</em>}
                    </span>
                    <span className="bz-amt n">{money(i.amount)}</span>
                    <span><i className={`bz-pill is-${s}`}>{STATE_LABEL[s]}</i></span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================ To bill ================================ */
function ToBillView({ entries, clients, catalog, personOf, onBill, auto, onAuto }: {
  entries: WorkEntry[] | null; clients: Map<string, BClient>; catalog: CatItem[]; personOf: (id: string) => string;
  onBill: (clientId: string, es: WorkEntry[]) => void; auto: AutoSettings | null; onAuto: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  /** Cards or a list — remembered on this browser. */
  const [mode, setMode] = useState<"cards" | "list">(() => { try { return localStorage.getItem("bz.tobill") === "list" ? "list" : "cards"; } catch { return "cards"; } });
  const pickMode = (m: "cards" | "list") => { setMode(m); try { localStorage.setItem("bz.tobill", m); } catch { /* ignore */ } };
  const groups = useMemo(() => {
    const m = new Map<string, WorkEntry[]>();
    (entries ?? []).forEach((e) => m.set(e.client_id, [...(m.get(e.client_id) ?? []), e]));
    return Array.from(m, ([cid, es]) => {
      const c = clients.get(cid);
      const rate = hourlyRate(c, catalog);
      const work = es.filter((e) => e.kind === "client_work");
      const ships = es.filter((e) => e.kind === "shipment");
      const hours = round2(work.reduce((s, e) => s + e.hours, 0));
      const shipValue = ships.reduce((s, e) => s + (e.quantity || 1) * (e.unit_price || catalog.find((x) => x.kind === "product" && x.id === e.product_id)?.price || 0), 0);
      const users = Array.from(new Set(work.map((e) => e.user_id)));
      return { cid, name: c?.name ?? "—", es, work, ships, hours, rate, value: round2(hours * rate + shipValue), users, since: es.map((e) => e.date).sort()[0] };
    }).sort((a, b) => b.value - a.value);
  }, [entries, clients, catalog]);
  const total = groups.reduce((s, g) => s + g.value, 0);
  const hoursAll = round2(groups.reduce((s, g) => s + g.hours, 0));
  const shipsAll = groups.reduce((s, g) => s + g.ships.length, 0);
  const max = Math.max(1, ...groups.map((g) => g.value));

  if (!entries) return <div className="bz-loading"><span /><span /><span /><span /></div>;
  return (
    <div className="bz-tb">
      <section className="bz-hero">
        <div className="bz-hero-main">
          <span className="bz-hero-k">Ready to bill</span>
          <b>{money0(total)}</b>
          <small>{groups.length} client{groups.length === 1 ? "" : "s"} · {hrs(hoursAll)} of work{shipsAll ? ` · ${shipsAll} shipment${shipsAll === 1 ? "" : "s"}` : ""} · before tax</small>
        </div>
        <AutoNote auto={auto} onAuto={onAuto} />
      </section>
      {groups.length > 0 && (
        <div className="bz-toolbar">
          <span className="bz-count is-l">{groups.length} client{groups.length === 1 ? "" : "s"} with work or shipments not on an invoice</span>
          <div className="bz-seg" role="tablist" aria-label="Show as">
            <button className={mode === "cards" ? "is-on" : ""} onClick={() => pickMode("cards")} aria-label="Cards"><Ico d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" s={15} />Cards</button>
            <button className={mode === "list" ? "is-on" : ""} onClick={() => pickMode("list")} aria-label="List"><Ico d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" s={15} />List</button>
          </div>
        </div>
      )}
      {!groups.length ? (
        <div className="bz-emptybig">
          <span className="bz-emptyico"><Ico d={V_ICON.tobill} s={28} /></span>
          <h3>Everything is billed</h3>
          <p>Work and shipments logged for a client in the <b>Calendar</b> show up here until they're on an invoice.</p>
        </div>
      ) : mode === "list" ? (
        <div className="bz-table bz-tbl">
          <div className="bz-trow bz-rhead"><span>Client</span><span>Who</span><span>Work</span><span>Shipments</span><span className="n">To bill</span><span /></div>
          {groups.map((g, k) => {
            const isOpen = openId === g.cid;
            return (
              <div key={g.cid} className={`bz-tli ${isOpen ? "is-open" : ""}`} style={{ ["--i" as string]: Math.min(k, 14) }}>
                <div className="bz-trow" role="button" tabIndex={0} onClick={() => setOpenId(isOpen ? null : g.cid)} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(isOpen ? null : g.cid); }}>
                  <span className="bz-cl"><Avatar name={g.name} size={34} square /><span><b>{g.name}</b><small>Logged since {fmtShort(g.since)}</small></span></span>
                  <span className="bz-stack">{g.users.slice(0, 5).map((u) => <Avatar key={u} name={personOf(u)} size={26} />)}{g.users.length > 5 && <em>+{g.users.length - 5}</em>}{!g.users.length && <em>—</em>}</span>
                  <span className="bz-tl-work">{g.hours > 0 ? <><b>{hrs(g.hours)}</b>{g.rate ? <small> × {money(g.rate)}</small> : <small className="is-warn"> · no rate</small>}</> : <small>—</small>}</span>
                  <span className="bz-tl-work">{g.ships.length ? <b className="is-ship">{g.ships.length} shipment{g.ships.length === 1 ? "" : "s"}</b> : <small>—</small>}</span>
                  <span className="bz-amt n">{money(g.value)}<i className="bz-tl-bar"><s style={{ width: `${(g.value / max) * 100}%` }} /></i></span>
                  <span className="bz-tl-act">
                    <button className="bz-bill is-sm" onClick={(e) => { e.stopPropagation(); onBill(g.cid, g.es); }}>Create invoice</button>
                    <svg className="bz-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                  </span>
                </div>
                <div className="bz-tbc-more"><div>
                  <div className="bz-tbc-list is-wide">
                    {g.es.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((e) => (
                      <div key={e.id} className={`bz-ent is-${e.kind}`}>
                        <span className="bz-ent-d">{fmtShort(e.date)}</span>
                        <span className="bz-ent-who">{personOf(e.user_id)}</span>
                        <span className="bz-ent-n">{e.kind === "shipment" ? `${e.quantity || 1} × ${e.name || catalog.find((x) => x.id === e.product_id)?.name || "Product"}` : e.notes || "Work"}</span>
                        <b>{e.kind === "shipment" ? money((e.quantity || 1) * (e.unit_price || 0)) : hrs(e.hours)}</b>
                      </div>
                    ))}
                  </div>
                </div></div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bz-tb-grid">
          {groups.map((g, k) => {
            const isOpen = openId === g.cid;
            const byUser = g.users.map((u) => ({ u, h: round2(g.work.filter((e) => e.user_id === u).reduce((s, e) => s + e.hours, 0)) })).sort((a, b) => b.h - a.h);
            return (
              <article key={g.cid} className={`bz-tbc ${isOpen ? "is-open" : ""}`} style={{ ["--i" as string]: Math.min(k, 14) }}>
                <header className="bz-tbc-top">
                  <Avatar name={g.name} size={42} square />
                  <span className="bz-tbc-name"><b>{g.name}</b><small>Logged since {fmtShort(g.since)}</small></span>
                  <span className="bz-tbc-val"><b>{money(g.value)}</b><small>before tax</small></span>
                </header>
                <div className="bz-tbc-bar"><i style={{ width: `${(g.value / max) * 100}%` }} /></div>
                <div className="bz-tbc-mid">
                  <span className="bz-tbc-chips">
                    {g.hours > 0 && <span><Ico d={IC.clock} s={14} />{hrs(g.hours)}{g.rate ? <small> × {money(g.rate)}</small> : <small className="is-warn"> · no rate</small>}</span>}
                    {g.ships.length > 0 && <span className="is-ship"><Ico d={IC.box} s={14} />{g.ships.length} shipment{g.ships.length === 1 ? "" : "s"}</span>}
                  </span>
                  <span className="bz-stack">{g.users.slice(0, 5).map((u) => <Avatar key={u} name={personOf(u)} size={28} />)}{g.users.length > 5 && <em>+{g.users.length - 5}</em>}</span>
                </div>
                <footer className="bz-tbc-foot">
                  <button className="bz-link" onClick={() => setOpenId(isOpen ? null : g.cid)}>
                    {isOpen ? "Hide details" : `See ${g.es.length} entr${g.es.length === 1 ? "y" : "ies"}`}
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  <button className="bz-bill" onClick={() => onBill(g.cid, g.es)}><Ico d={V_ICON.invoices} s={15} />Create invoice</button>
                </footer>
                <div className="bz-tbc-more"><div>
                  {byUser.length > 0 && (
                    <div className="bz-tbc-people">
                      {byUser.map(({ u, h }) => (
                        <span key={u}><Avatar name={personOf(u)} size={22} />{personOf(u)}<b>{hrs(h)}</b></span>
                      ))}
                    </div>
                  )}
                  <div className="bz-tbc-list">
                    {g.es.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((e) => (
                      <div key={e.id} className={`bz-ent is-${e.kind}`}>
                        <span className="bz-ent-d">{fmtShort(e.date)}</span>
                        <span className="bz-ent-who">{personOf(e.user_id)}</span>
                        <span className="bz-ent-n">{e.kind === "shipment" ? `${e.quantity || 1} × ${e.name || catalog.find((x) => x.id === e.product_id)?.name || "Product"}` : e.notes || "Work"}</span>
                        <b>{e.kind === "shipment" ? money((e.quantity || 1) * (e.unit_price || 0)) : hrs(e.hours)}</b>
                      </div>
                    ))}
                  </div>
                </div></div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** When the next invoices get made, or how to make them automatic. */
function AutoNote({ auto, onAuto }: { auto: AutoSettings | null; onAuto: () => void }) {
  if (!auto) return null;
  if (!auto.auto_invoice) return (
    <div className="bz-auto-note is-off">
      <i><Ico d={IC.clock} s={18} /></i>
      <span><b>Invoices are only made by hand</b><small>Make them on the month's cutoff instead.</small></span>
      <button onClick={onAuto}>Set it up</button>
    </div>
  );
  const c = nextCutoff(auto.cutoff_day);
  const left = daysBetween(todayIso(), c);
  return (
    <div className="bz-auto-note">
      <i><Ico d={IC.clock} s={18} /></i>
      <span><b>Automatic · {left === 0 ? "cutoff today" : `${left} day${left === 1 ? "" : "s"} to the cutoff`}</b>
        <small>Up to {fmtDate(c)}, invoiced on {fmtDate(addDays(c, 1))} as {auto.auto_send ? "sent invoices" : "drafts to review"}.</small></span>
      <button onClick={onAuto}>Change</button>
    </div>
  );
}

/* ================================= Time ================================= */
const SEG = ["#12b57f", "#3c7fd0", "#e0a13c", "#9b6fd0", "#e0798c", "#1a9e9a", "#7d8b84", "#5b6ee1", "#c9772f", "#4a9a3f"];
function TimeView({ clients, personOf, people, me }: {
  clients: Map<string, BClient>; personOf: (id: string) => string; people: Person[]; me: string | null;
}) {
  const [anchor, setAnchor] = useState(() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), 1); });
  const [work, setWork] = useState<WorkEntry[] | null>(null);
  const [openP, setOpenP] = useState<string | null>(null);
  const from = iso(anchor);
  const to = iso(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0));
  useEffect(() => {
    let alive = true; setWork(null);
    loadWork(from, to).then((w) => { if (alive) setWork(w.filter((e) => e.kind === "client_work" && (!me || e.user_id === me))); }).catch(() => alive && setWork([]));
    return () => { alive = false; };
  }, [from, to, me]);
  const move = (n: number) => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + n, 1));

  const byClient = useMemo(() => {
    const m = new Map<string, { h: number; users: Set<string> }>();
    (work ?? []).forEach((e) => { const x = m.get(e.client_id) ?? { h: 0, users: new Set() }; x.h += e.hours; x.users.add(e.user_id); m.set(e.client_id, x); });
    return Array.from(m, ([c, x]) => ({ c, h: round2(x.h), users: Array.from(x.users) })).sort((a, b) => b.h - a.h);
  }, [work]);
  /** One colour per client, the busiest first. */
  const colorOf = useMemo(() => new Map(byClient.map((c, i) => [c.c, SEG[i % SEG.length]])), [byClient]);
  const byPerson = useMemo(() => {
    const m = new Map<string, WorkEntry[]>();
    (work ?? []).forEach((e) => m.set(e.user_id, [...(m.get(e.user_id) ?? []), e]));
    return Array.from(m, ([u, es]) => {
      const perClient = new Map<string, number>();
      es.forEach((e) => perClient.set(e.client_id, (perClient.get(e.client_id) ?? 0) + e.hours));
      return {
        u, name: personOf(u), total: round2(es.reduce((s, e) => s + e.hours, 0)),
        billed: round2(es.filter((e) => e.invoice_id).reduce((s, e) => s + e.hours, 0)),
        days: new Set(es.map((e) => e.date)).size,
        clients: Array.from(perClient, ([c, h]) => ({ c, h: round2(h) })).sort((a, b) => b.h - a.h),
      };
    }).sort((a, b) => b.total - a.total);
  }, [work, personOf]);
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
        <div className="bz-kpis">
          <span><b>{work ? hrs(total) : "—"}</b><small>logged on clients</small></span>
          <span><b>{work ? byPerson.length : "—"}</b><small>{byPerson.length === 1 ? "person" : "people"}</small></span>
          <span><b>{work ? byClient.length : "—"}</b><small>clients</small></span>
          <span><b>{work && total ? `${Math.round((billed / total) * 100)}%` : "—"}</b><small>already billed</small></span>
        </div>
      </section>
      {!work ? <div className="bz-loading"><span /><span /><span /></div> : !byPerson.length ? (
        <div className="bz-emptybig">
          <span className="bz-emptyico"><Ico d={V_ICON.time} s={28} /></span>
          <h3>No client work logged in {MONTHS[anchor.getMonth()]}</h3>
          <p>{people.length > 1 || !me ? "Time logged for a client in the Calendar adds up here, per person and per client." : "Your time logged for a client in the Calendar adds up here."}</p>
        </div>
      ) : (
        <div className="bz-time-grid">
          <section className="bz-card">
            <header className="bz-card-h"><h3>By person</h3><small>Each bar is split by client · click a person for the detail</small></header>
            {byPerson.map((p, k) => (
              <div key={p.u} className={`bz-tp ${openP === p.u ? "is-open" : ""}`} style={{ ["--i" as string]: k }}>
                <button className="bz-tp-top" onClick={() => setOpenP(openP === p.u ? null : p.u)}>
                  <Avatar name={p.name} size={38} />
                  <span className="bz-tp-n"><b>{p.name}</b><small>{p.days} day{p.days === 1 ? "" : "s"} · {p.clients.length} client{p.clients.length === 1 ? "" : "s"}</small></span>
                  <span className="bz-tp-bar">
                    <span style={{ width: `${(p.total / max) * 100}%` }}>
                      {p.clients.map(({ c, h }) => <i key={c} title={`${cname(c)} · ${hrs(h)}`} style={{ flexGrow: h, background: colorOf.get(c) }} />)}
                    </span>
                  </span>
                  <span className="bz-tp-h"><b>{hrs(p.total)}</b><small>{p.billed ? `${Math.round((p.billed / p.total) * 100)}% billed` : "not billed yet"}</small></span>
                </button>
                <div className="bz-tp-more"><div>
                  {p.clients.map(({ c, h }) => (
                    <span key={c}><i style={{ background: colorOf.get(c) }} /><em>{cname(c)}</em><u><s style={{ width: `${(h / p.total) * 100}%`, background: colorOf.get(c) }} /></u><b>{hrs(h)}</b></span>
                  ))}
                </div></div>
              </div>
            ))}
          </section>
          <section className="bz-card">
            <header className="bz-card-h"><h3>By client</h3><small>Who worked on it and for how long</small></header>
            {byClient.map((c, k) => (
              <div key={c.c} className="bz-tc" style={{ ["--i" as string]: k }}>
                <i className="bz-tc-dot" style={{ background: colorOf.get(c.c) }} />
                <span className="bz-tc-n">{cname(c.c)}</span>
                <span className="bz-stack is-sm">{c.users.slice(0, 4).map((u) => <Avatar key={u} name={personOf(u)} size={22} />)}</span>
                <span className="bz-tc-bar"><i style={{ width: `${(c.h / maxC) * 100}%`, background: colorOf.get(c.c) }} /></span>
                <b>{hrs(c.h)}</b>
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
