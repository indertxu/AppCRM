import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import Select from "../../framework/Select";
import { ColumnHead } from "../../framework/ColumnHead";
import { FilterBar, FilterChips, applyView, emptyView, useSavedViews, useStoredView, type FField } from "../companies/CompaniesPage";
import { loadPrefs, savePref } from "../companies/companiesApi";
import { loadProducts, type Product } from "../settings/catalogApi";
import { contractFigures, normConfig, termLabel, PAY_LABEL, type DealContract, type ContractFigures } from "../sales/extras/contractsApi";
import ContractView, { ViewShell, ViewSec, contractState, stateTone } from "../sales/extras/ContractView";
import { cpDay, ContractTrack } from "../sales/extras/ContractPlan";
import { IC } from "../sales/extras/ContractTermsForm";
import { CompanyLogo, noteLines, lineAnnualLast, isActive, renewalOf, lineStartOf, lineAnnual, lineContractValue, type Line } from "./ClientWorkspace";
import "./ContractsBoard.css";

/* =====================================================================
   Clients › Contracts: every signed contract in one list — the ones
   built on a deal (terms, dates, payment plan) and the older ones made
   from a client's signed products (handoff). A click opens it.
   ===================================================================== */

type Row = {
  key: string; kind: "deal" | "lines";
  clientId: string | null; clientName: string; website: string | null; dealId: string | null; dealName: string;
  name: string; what: string; signed: string | null; start: string | null; end: string | null; renews: boolean;
  next: { date: string; amount: number } | null; total: number; perYear: number; state: string;
  /** What it billed a year in its last running day (= perYear while it runs): an ended contract's value. */
  lastPerYear: number;
  contract?: DealContract; f?: ContractFigures; lines?: Line[]; ct?: any;
};
const money = (n: number) => `${Math.round(n).toLocaleString("de-DE")} €`;
const iso = (d: Date | string | null | undefined) => (!d ? null : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const STATES = ["Running", "In grace period", "Not started", "Renewed", "Ended"];
/** The list's columns after Contract (always first), in their order — the person's own, saved as prefs.contractColumns. */
const COL_DEFAULT = ["client", "state", "signed", "start", "end", "next", "total"];
/* ---- The figures on top: the person picks them (up to 6 cards, each with an optional second figure) ---- */
type CKpi = { key: string; label: string; ico: string; tone?: string; calc: (rs: Row[], ctx: { now: string; in30: string; in90: string; year: string }) => { v: string; unit?: string; sub?: string; bar?: number } };
const K_ICO = {
  doc: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  euro: "M4 10h12M4 14h9M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2",
  repeat: "m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  cal: "M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM16 2v4M8 2v4M3 10h18",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  box: "M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  tag: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01",
  stop: "M18 6 6 18M6 6l12 12",
};
const eur = (n: number) => Math.round(n).toLocaleString("de-DE");
/** The contracts the figures are about: the running ones (ended ones don't add to a mixed list) — unless only ended
 *  ones are listed: then those, at what they billed a year when they ended. */
const liveOf = (rs: Row[]) => {
  const l = rs.filter((r) => r.state !== "Ended");
  return l.length || !rs.length ? l : rs.map((r) => ({ ...r, perYear: r.lastPerYear }));
};
const allEnded = (rs: Row[]) => rs.length > 0 && rs.every((r) => r.state === "Ended");
const invIn = (rs: Row[], from: string, to: string) => rs.reduce((s, r) => s + (r.f?.invoices ?? []).filter((iv) => iv.date >= from && iv.date <= to).reduce((a, iv) => a + iv.amount, 0), 0);
const termYearsOf = (r: Row) => (r.f?.termYears ? r.f.termYears : r.ct?.termYears ? Number(r.ct.termYears) : 0);
const C_KPIS: CKpi[] = [
  { key: "contracts", label: "Contracts", ico: K_ICO.doc, calc: (rs) => { if (allEnded(rs)) return { v: String(rs.length), sub: "all ended" }; const l = liveOf(rs).length; return { v: String(l), sub: `${rs.length - l} ended` }; } },
  { key: "signedValue", label: "Signed value", ico: K_ICO.euro, tone: "jade", calc: (rs) => { const l = liveOf(rs); return { v: eur(l.reduce((s, r) => s + r.total, 0)), unit: "€", sub: `${money(l.reduce((s, r) => s + r.perYear, 0))} a year` }; } },
  { key: "yearly", label: "Yearly value", ico: K_ICO.repeat, tone: "teal", calc: (rs) => { const l = liveOf(rs).filter((r) => r.perYear > 0.5); return { v: eur(l.reduce((s, r) => s + r.perYear, 0)), unit: "€ / yr", sub: `${l.length} recurring contract${l.length === 1 ? "" : "s"}` }; } },
  { key: "inv30", label: "Invoices · next 30 days", ico: K_ICO.doc, calc: (rs, c) => ({ v: eur(invIn(rs, c.now, c.in30)), unit: "€", sub: "from contracts built on deals" }) },
  { key: "inv90", label: "Invoices · next 90 days", ico: K_ICO.doc, tone: "gold", calc: (rs, c) => ({ v: eur(invIn(rs, c.now, c.in90)), unit: "€", sub: "from contracts built on deals" }) },
  { key: "invYear", label: "Invoiced this year", ico: K_ICO.cal, calc: (rs, c) => { const all = invIn(rs, `${c.year}-01-01`, `${c.year}-12-31`), done = invIn(rs, `${c.year}-01-01`, c.now); return { v: eur(all), unit: "€", sub: `${money(done)} already due`, bar: all > 0 ? (done / all) * 100 : 0 }; } },
  { key: "nextInv", label: "Next invoice", ico: K_ICO.clock, calc: (rs) => { const n = rs.filter((r) => r.next).sort((a, b) => a.next!.date.localeCompare(b.next!.date))[0]; return n ? { v: cpDay(n.next!.date, "2-digit"), sub: `${money(n.next!.amount)} · ${n.clientName}` } : { v: "—", sub: "nothing to invoice" }; } },
  { key: "renew90", label: "Renewing · 90 days", ico: K_ICO.repeat, calc: (rs, c) => { const xs = liveOf(rs).filter((r) => r.end && r.end >= c.now && r.end <= c.in90); return { v: String(xs.length), sub: xs.length ? xs.slice(0, 2).map((r) => r.clientName).join(", ") + (xs.length > 2 ? "…" : "") : "renew or end soon" }; } },
  { key: "autoRenew", label: "Renew by themselves", ico: K_ICO.repeat, calc: (rs) => { const l = liveOf(rs), a = l.filter((r) => r.renews).length; return { v: String(a), sub: `of ${l.length} running`, bar: l.length ? (a / l.length) * 100 : 0 }; } },
  { key: "grace", label: "In grace period", ico: K_ICO.clock, tone: "gold", calc: (rs) => { const xs = rs.filter((r) => r.state === "In grace period"); return { v: String(xs.length), sub: xs.length ? `${money(xs.reduce((s, r) => s + r.total, 0))} waiting to start` : "none waiting" }; } },
  { key: "notStarted", label: "Not started", ico: K_ICO.cal, calc: (rs) => ({ v: String(rs.filter((r) => r.state === "Not started").length), sub: "signed, start ahead" }) },
  { key: "ended", label: "Ended", ico: K_ICO.stop, tone: "coral", calc: (rs) => { const xs = rs.filter((r) => r.state === "Ended"); return { v: String(xs.length), sub: `${money(xs.reduce((s, r) => s + r.total, 0))} in all` }; } },
  { key: "clients", label: "Clients with a contract", ico: K_ICO.users, calc: (rs) => ({ v: String(new Set(liveOf(rs).map((r) => r.clientId || r.clientName)).size), sub: `${liveOf(rs).length} running contracts` }) },
  { key: "avgValue", label: "Avg. contract value", ico: K_ICO.euro, calc: (rs) => { const l = liveOf(rs); return { v: l.length ? eur(l.reduce((s, r) => s + r.total, 0) / l.length) : "—", unit: l.length ? "€" : "", sub: "running contracts" }; } },
  { key: "avgLength", label: "Avg. length", ico: K_ICO.cal, calc: (rs) => { const ys = liveOf(rs).map(termYearsOf).filter((y) => y > 0); const a = ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : 0; return { v: a ? a.toLocaleString("de-DE", { maximumFractionDigits: 1 }) : "—", unit: a ? (a === 1 ? "year" : "years") : "", sub: `${ys.length} with a length` }; } },
  { key: "products", label: "Products in contracts", ico: K_ICO.box, calc: (rs) => { const l = liveOf(rs); return { v: String(l.reduce((s, r) => s + (r.contract ? r.contract.data.items.length : r.lines?.length ?? 0), 0)), sub: "in running contracts" }; } },
  { key: "discount", label: "Discounts given", ico: K_ICO.tag, calc: (rs) => { const l = liveOf(rs).filter((r) => r.f); const d = l.reduce((s, r) => s + (r.f?.discount ?? 0), 0), list = l.reduce((s, r) => s + (r.f?.list ?? 0), 0); return { v: eur(d), unit: "€", sub: list > 0 ? `${Math.round((d / list) * 100)}% off list` : "on deal contracts", bar: list > 0 ? (d / list) * 100 : 0 }; } },
];
const C_KPI_DEFAULT = ["contracts", "signedValue", "inv90", "renew90"];

/** The last contracts read, so coming back to the tab draws at once (then refreshes quietly). */
let CACHE: { rows: Row[]; products: Product[] } | null = null;
const chunks = <T,>(xs: T[], n = 150) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export default function ContractsBoard({ toolsSlot, onOpenClient, onOpenDeal, colsSignal = 0 }: {
  toolsSlot?: HTMLElement | null;
  onOpenClient: (clientId: string, dealId?: string | null) => void;
  onOpenDeal: (dealId: string) => void;
  /** Changes when the Actions menu asks for the columns editor. */
  colsSignal?: number;
}) {
  const [rows, setRows] = useState<Row[] | null>(() => CACHE?.rows ?? null);
  const [products, setProducts] = useState<Product[]>(() => CACHE?.products ?? []);
  const [q, setQ] = useState("");
  /** Filters and sort — from the Filters panel, a saved view or a column's header (kept on this browser). */
  const [view, setView] = useStoredView("np-contracts-view", emptyView());
  const [savedViews, setSavedViews] = useSavedViews("contractViews");
  const [filtersOpenTick, setFiltersOpenTick] = useState(0);
  const [cols, setCols] = useState<string[]>(COL_DEFAULT);
  const [colEdit, setColEdit] = useState(false);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  useEffect(() => { loadPrefs().then((p) => { if (Array.isArray(p.contractColumns) && p.contractColumns.length) setCols(p.contractColumns); }).catch(() => {}); }, []);
  const saveCols = (next: string[]) => { setCols(next); savePref("contractColumns", next).catch(() => {}); };
  // the figures on top (prefs.contractKpiSlots)
  const knownK = (k: string) => C_KPIS.some((x) => x.key === k);
  const [slots, setSlots] = useState<string[][]>(C_KPI_DEFAULT.map((k) => [k]));
  const [prefsReady, setPrefsReady] = useState(false);
  const [shownAlt, setShownAlt] = useState<Record<number, number>>({});
  const [kpiEdit, setKpiEdit] = useState(false);
  const [slotEdit, setSlotEdit] = useState<{ i: number; top: number; left: number } | null>(null);
  useEffect(() => {
    loadPrefs().then((p) => {
      if (Array.isArray(p.contractKpiSlots) && p.contractKpiSlots.length) {
        const xs = (p.contractKpiSlots as string[][]).map((sl) => (Array.isArray(sl) ? sl.filter(knownK).slice(0, 2) : [])).filter((sl) => sl.length);
        if (xs.length) setSlots(xs);
      }
    }).catch(() => {}).finally(() => setPrefsReady(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const saveSlots = (next: string[][]) => {
    const clean = next.map((sl) => sl.filter(Boolean).slice(0, 2)).filter((sl) => sl.length);
    if (!clean.length) return;
    setSlots(clean);
    savePref("contractKpiSlots", clean).catch(() => {});
  };
  const inSlots = (k: string) => slots.some((sl) => sl.includes(k));
  const toggleKpi = (k: string) => {
    if (inSlots(k)) saveSlots(slots.map((sl) => sl.filter((x) => x !== k)));
    else if (slots.length < 6) saveSlots([...slots, [k]]);
  };
  const setSlot = (i: number, primary: string, alternate: string) => {
    saveSlots(slots.map((sl, j) => (j === i ? [primary, alternate].filter((x, n, arr) => x && arr.indexOf(x) === n) : sl)));
    setShownAlt((x) => ({ ...x, [i]: 0 }));
  };
  const kpiOf = (k: string) => C_KPIS.find((x) => x.key === k);
  const kpiOpts = C_KPIS.map((k) => ({ value: k.key, label: k.label }));
  const kIco = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
  const spot = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const el = e.currentTarget, b = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - b.left}px`); el.style.setProperty("--my", `${e.clientY - b.top}px`);
  };
  const [open, setOpen] = useState<Row | null>(null);
  const [layout, setLayout] = useState<"cards" | "list">(() => { try { return localStorage.getItem("ccb.layout") === "list" ? "list" : "cards"; } catch { return "cards"; } });
  const setLayoutP = (l: "cards" | "list") => { setLayout(l); try { localStorage.setItem("ccb.layout", l); } catch { /* ignore */ } };
  useEffect(() => { if (colsSignal) { setColEdit(true); setLayoutP("list"); } }, [colsSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    (async () => {
      const [tc, cp, pr, cl, cat] = await Promise.all([
        supabase.from("tracking_contracts").select("*"),
        supabase.from("client_products").select("*"),
        supabase.from("products").select("id, name"),
        supabase.from("clients").select("id, name, company_id, status"),
        loadProducts().catch(() => [] as Product[]),
      ]);
      const pn = new Map(((pr.data ?? []) as any[]).map((x) => [x.id, x.name as string]));
      const clients = (cl.data ?? []) as any[];
      const clientById = new Map(clients.map((c) => [c.id, c]));
      const clientByCo = new Map(clients.filter((c) => c.company_id).map((c) => [c.company_id, c]));
      const contracts = ((tc.error ? [] : tc.data ?? []) as any[]).filter((r) => r.active !== false);
      const lines = ((cp.data ?? []) as any[]).map((r) => ({ ...r, name: pn.get(r.product_id) ?? "Product" })) as Line[];
      noteLines(lines);
      const tids = [...new Set([...contracts.map((r) => r.tracking_id), ...lines.map((l) => String(l.contract_tracking_id || l.tracking_id || ""))].filter(Boolean))];
      // the clients' websites (for their logos) only for clients with a contract — all of it in one round
      const coIds = [...new Set(lines.map((l) => clientById.get(l.client_id)?.company_id).filter(Boolean))] as string[];
      const trk = new Map<string, any>();
      const site = new Map<string, string>();
      const [tParts, cParts] = await Promise.all([
        Promise.all(chunks(tids).map((ids) => Promise.resolve(supabase.from("trackings").select("id, deal_name, company_id, status, contract_terms").in("id", ids)).then((r: any) => (r.data ?? []) as any[]))),
        Promise.all(chunks(coIds).map((ids) => Promise.resolve(supabase.from("companies").select("id, website").in("id", ids)).then((r: any) => (r.data ?? []) as any[]))),
      ]);
      tParts.flat().forEach((x) => trk.set(x.id, x));
      cParts.flat().forEach((x) => { if (x.website) site.set(x.id, x.website); });
      // a deal's contract belongs to its deal's company: read those websites too (few)
      const more = [...new Set(contracts.map((r) => trk.get(r.tracking_id)?.company_id).filter((id) => id && !site.has(id) && !coIds.includes(id)))] as string[];
      if (more.length) {
        const { data } = await supabase.from("companies").select("id, website").in("id", more.slice(0, 150));
        ((data ?? []) as any[]).forEach((x) => { if (x.website) site.set(x.id, x.website); });
      }
      const siteOf = (c: any) => (c?.company_id ? site.get(c.company_id) ?? null : null);
      const out: Row[] = [];
      const now = iso(new Date())!;
      // contracts built on a deal — only once the deal is won
      const withContract = new Set<string>();
      contracts.forEach((r) => {
        const t = trk.get(r.tracking_id);
        if (!t || t.status !== "won") return;
        withContract.add(r.tracking_id);
        const c: DealContract = {
          id: r.id, tracking_id: r.tracking_id, template_id: r.template_id, name: r.name, active: true, total: Number(r.total) || 0, first_year: Number(r.first_year) || 0,
          data: { ...normConfig(r.data), term: r.data?.term ?? { value: 1, unit: "years" }, payment: r.data?.payment ?? "annually", signed: r.data?.signed ?? null, start: r.data?.start ?? null, items: Array.isArray(r.data?.items) ? r.data.items : [], notes: r.data?.notes ?? null },
        };
        const f = contractFigures(c.data, cat);
        const client = clientByCo.get(t.company_id);
        const nx = f.invoices.find((iv) => iv.date >= now) ?? null;
        out.push({
          key: `c:${r.id}`, kind: "deal", clientId: client?.id ?? null, clientName: client?.name ?? "No client yet", website: siteOf(client), dealId: r.tracking_id, dealName: t.deal_name || client?.name || "Deal",
          name: r.name, what: `${termLabel(c.data.term)} · ${PAY_LABEL[c.data.payment].toLowerCase()}${c.data.items.length ? ` · ${c.data.items.length} product${c.data.items.length === 1 ? "" : "s"}` : ""}`,
          signed: c.data.signed, start: f.start, end: f.end, renews: !!f.renewal, next: nx ? { date: nx.date, amount: nx.amount } : null,
          total: f.total, perYear: f.termYears ? f.total / Math.max(1, f.termYears) : f.total, lastPerYear: f.termYears ? f.total / Math.max(1, f.termYears) : f.total, state: contractState(f), contract: c, f,
        });
      });
      // older contracts: a client's signed products, grouped by the deal they were signed on
      const groups = new Map<string, Line[]>();
      lines.forEach((l) => {
        const k = String(l.contract_tracking_id || l.tracking_id || "");
        if (k && withContract.has(k)) return;
        const g = `${l.client_id}|${k || "none"}`;
        groups.set(g, [...(groups.get(g) ?? []), l]);
      });
      groups.forEach((ls, g) => {
        const [cid, k] = g.split("|");
        const client = clientById.get(cid);
        const t = k !== "none" ? trk.get(k) : null;
        const ct = t?.contract_terms && typeof t.contract_terms === "object" ? t.contract_terms : null;
        const live = ls.filter(isActive);
        const starts = ls.map((l) => lineStartOf(l, ct)).filter(Boolean).sort();
        const renew = live.map((l) => renewalOf(l, ct)).filter((x): x is NonNullable<ReturnType<typeof renewalOf>> => !!x).sort((a, b) => a.end.getTime() - b.end.getTime())[0];
        const signed = String(ct?.signDate || ls.map((l) => l.signing_date).filter(Boolean).sort()[0] || "") || null;
        const start = starts[0] ? String(starts[0]).slice(0, 10) : null;
        const state = !live.length ? "Ended" : start && start > now ? (signed && signed <= now ? "In grace period" : "Not started") : "Running";
        out.push({
          key: `l:${g}`, kind: "lines", clientId: cid, clientName: client?.name ?? "Client", website: siteOf(client), dealId: t?.id ?? null, dealName: t?.deal_name || client?.name || "",
          name: ct?.contractRef ? `Contract No. ${ct.contractRef}` : t?.deal_name ? `Contract · ${t.deal_name}` : "Signed products",
          what: ls.map((l) => l.name).slice(0, 3).join(" · ") + (ls.length > 3 ? ` +${ls.length - 3}` : ""),
          signed: signed ? signed.slice(0, 10) : null, start, end: iso(renew?.end), renews: !!renew,
          next: null, total: ls.reduce((s, l) => s + lineContractValue(l), 0), perYear: live.reduce((s, l) => s + lineAnnual(l), 0), lastPerYear: live.length ? live.reduce((s, l) => s + lineAnnual(l), 0) : ls.reduce((s, l) => s + lineAnnualLast(l), 0), state, lines: ls, ct,
        });
      });
      CACHE = { rows: out, products: cat };
      if (alive) { setRows(out); setProducts(cat); }
    })().catch(() => { if (alive) setRows((cur) => cur ?? []); });
    return () => { alive = false; };
  }, []);

  /** What the Filters panel, the saved views and the column headers can filter and sort on. */
  const fields: FField<Row>[] = useMemo(() => {
    const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((x, y) => x.localeCompare(y)).map((v) => ({ value: v, label: v }));
    const termOf = (r: Row) => (r.contract ? termLabel(r.contract.data.term) : r.ct?.termYears ? `${r.ct.termYears} year${Number(r.ct.termYears) === 1 ? "" : "s"}` : "");
    const payOf = (r: Row) => (r.contract ? PAY_LABEL[r.contract.data.payment] : "");
    const nProducts = (r: Row) => (r.contract ? r.contract.data.items.length : r.lines?.length ?? 0);
    const all = rows ?? [];
    return [
      { key: "name", label: "Contract", group: "Contract", type: "text", get: (r) => r.name },
      { key: "client", label: "Client", group: "Contract", type: "select", get: (r) => r.clientName, options: () => uniq(all.map((r) => r.clientName)) },
      { key: "state", label: "State", group: "Contract", type: "select", get: (r) => r.state, options: () => STATES.map((s) => ({ value: s, label: s })) },
      { key: "kind", label: "Made from", group: "Contract", type: "select", get: (r) => r.kind, options: () => [{ value: "deal", label: "A deal's contract" }, { value: "lines", label: "Signed products" }] },
      { key: "term", label: "Length", group: "Terms", type: "select", get: termOf, options: () => uniq(all.map(termOf)) },
      { key: "payment", label: "Paid", group: "Terms", type: "select", get: payOf, options: () => uniq(all.map(payOf)) },
      { key: "products", label: "Products", group: "Terms", type: "number", get: nProducts },
      { key: "signed", label: "Signed", group: "Dates", type: "date", get: (r) => r.signed },
      { key: "start", label: "Starts", group: "Dates", type: "date", get: (r) => r.start },
      { key: "end", label: "Renews / ends", group: "Dates", type: "date", get: (r) => r.end },
      { key: "renews", label: "Renews by itself", group: "Dates", type: "boolean", get: (r) => r.renews },
      { key: "next", label: "Next invoice", group: "Money", type: "date", get: (r) => r.next?.date ?? null },
      { key: "nextAmount", label: "Next invoice (€)", group: "Money", type: "number", get: (r) => (r.next ? Math.round(r.next.amount) : null) },
      { key: "total", label: "Total (€)", group: "Money", type: "number", get: (r) => Math.round(r.total) },
      { key: "perYear", label: "A year (€)", group: "Money", type: "number", get: (r) => Math.round(r.perYear) },
    ] as FField<Row>[];
  }, [rows]);
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const colFields = cols.map((k) => byKey.get(k)).filter((f): f is FField<Row> => !!f && f.key !== "name");

  const searched = useMemo(() => {
    const n = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const qq = n(q.trim());
    return (rows ?? []).filter((r) => !qq || n(`${r.name} ${r.clientName} ${r.dealName} ${r.what}`).includes(qq));
  }, [rows, q]);
  // no sort picked: the ones that renew or end soonest first
  const shown = useMemo(() => applyView(searched, fields, view, (a, b) => (a.end ?? "9999").localeCompare(b.end ?? "9999")), [searched, fields, view]);

  const kctx = { now: iso(new Date())!, in30: iso(new Date(Date.now() + 30 * 864e5))!, in90: iso(new Date(Date.now() + 90 * 864e5))!, year: String(new Date().getFullYear()) };

  const NUM = new Set(["total", "perYear", "nextAmount", "products"]);
  /** Each column's width (and the least it needs), so the table fits the page and only scrolls when it must. */
  const width = (k: string): [string, number] => (k === "client" ? ["minmax(150px, 1.3fr)", 150] : k === "state" || k === "kind" ? ["118px", 118] : k === "renews" ? ["88px", 88]
    : k === "end" ? ["108px", 108] : k === "next" ? ["116px", 116] : ["signed", "start"].includes(k) ? ["92px", 92] : k === "products" ? ["80px", 80]
    : NUM.has(k) ? ["minmax(104px, 0.9fr)", 104] : ["minmax(104px, 1fr)", 104]);
  const grid = {
    gridTemplateColumns: `minmax(200px, 2fr) ${colFields.map((f) => width(f.key)[0]).join(" ")}`,
    minWidth: 40 + 200 + colFields.reduce((s, f) => s + width(f.key)[1] + 14, 0),
  } as const;
  const yearNote = (r: Row) => (r.perYear > 0.5 ? `${money(r.perYear)} a year` : r.lastPerYear > 0.5 ? `${money(r.lastPerYear)} a year · ended` : "one-time");
  const day = (d: string | null) => (d ? cpDay(d, "2-digit") : "—");
  const cell = (f: FField<Row>, r: Row): ReactNode => {
    switch (f.key) {
      case "client": return <span className="ccb-cl"><CompanyLogo className="cx-av is-sm" name={r.clientName} website={r.website} /><span><b>{r.clientName}</b>{!cols.includes("state") && <i className={`ccb-st is-${stateTone(r.state)}`}>{r.state}</i>}</span></span>;
      case "state": return <i className={`ccb-st is-${stateTone(r.state)}`}>{r.state}</i>;
      case "kind": return <span className="ccb-d">{r.kind === "deal" ? "Deal contract" : "Signed products"}</span>;
      case "signed": case "start": return <span className="ccb-d">{day(f.get(r))}</span>;
      case "end": return <span className="ccb-d">{r.end ? <>{day(r.end)}<em>{r.renews ? "renews" : "ends"}</em></> : "—"}</span>;
      case "next": return <span className="ccb-d">{r.next ? <>{day(r.next.date)}<em>{money(r.next.amount)}</em></> : r.kind === "lines" ? <em>—</em> : "—"}</span>;
      case "renews": return <span className="ccb-d">{r.renews ? "Yes" : "No"}</span>;
      case "total": return <span className="ccb-m"><b>{money(r.total)}</b><em>{yearNote(r)}</em></span>;
      case "perYear": return <span className="ccb-m"><b>{r.perYear > 0.5 ? money(r.perYear) : r.lastPerYear > 0.5 ? money(r.lastPerYear) : "—"}</b>{r.perYear <= 0.5 && r.lastPerYear > 0.5 && <em>when it ended</em>}</span>;
      case "nextAmount": return <span className="ccb-m"><b>{r.next ? money(r.next.amount) : "—"}</b></span>;
      case "products": return <span className="ccb-m"><b>{f.get(r)}</b></span>;
      default: { const v = f.get(r); return <span className="ccb-d">{v === null || v === undefined || v === "" ? "—" : String(v)}</span>; }
    }
  };

  const tools = (
    <div className="cx-tools">
      <label className="cx-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a contract, client or product…" />
        {q && <button onClick={() => setQ("")} aria-label="Clear">×</button>}
      </label>
      <FilterBar fields={fields} view={view} onView={setView} total={searched.length} shown={shown.length} noun={["contract", "contracts"]}
        saved={savedViews} onSaved={setSavedViews} openSignal={filtersOpenTick} />
      <div className="cx-view" role="group" aria-label="View">
        <button className={layout === "cards" ? "is-on" : ""} onClick={() => setLayoutP("cards")} aria-label="Cards" title="Cards">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></svg>
        </button>
        <button className={layout === "list" ? "is-on" : ""} onClick={() => setLayoutP("list")} aria-label="List" title="List">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {toolsSlot ? createPortal(tools, toolsSlot) : tools}
      <div className={`cx-kpis ccb-kpis ${!rows || !prefsReady ? "is-skel" : ""}`} style={{ ["--n" as any]: slots.length }}>
        {!rows || !prefsReady ? slots.map((_, i) => (
          <div className="cx-kpi tone-mint is-skel" key={`sk-${i}`} style={{ ["--i" as any]: i }} aria-hidden="true">
            <span className="cx-kpi-top"><span className="cx-kpi-ico" /><span className="cx-skel is-k" /></span>
            <span className="cx-skel is-v" />
            <span className="cx-skel is-sub" />
          </div>
        )) : slots.map((sl, i) => {
          const at = (shownAlt[i] ?? 0) % sl.length;
          const k = kpiOf(sl[at]);
          if (!k) return null;
          // the figures follow the search and the filters
          const r = k.calc(shown, kctx);
          const two = sl.length > 1;
          const flip = () => { if (two) setShownAlt((x) => ({ ...x, [i]: at + 1 })); };
          return (
            <div className={`cx-kpi tone-${k.tone ?? "mint"} ${two ? "is-alt" : ""} ${shownAlt[i] != null ? "is-flipped" : ""}`} key={`slot-${i}-${sl.join("|")}`} style={{ ["--i" as any]: i }} onPointerMove={spot}
              role={two ? "button" : undefined} tabIndex={two ? 0 : undefined}
              title={two ? `Click to show ${kpiOf(sl[(at + 1) % sl.length])?.label}` : undefined}
              onClick={flip} onKeyDown={(e) => { if (e.key === "Enter") flip(); }}>
              <span className="cx-kpi-top">
                <span className="cx-kpi-ico" key={`ico-${k.key}`}>{kIco(k.ico)}</span><span className="cx-kpi-k" key={`k-${k.key}`}>{k.label}</span>
                {two && <span className="cx-kpi-dots" aria-hidden="true">{sl.map((_, n) => <i key={n} className={n === at ? "is-on" : ""} />)}</span>}
                <button className="cx-kpi-swap" aria-label="Change this figure" title="Change this figure"
                  onClick={(e) => { e.stopPropagation(); const b = (e.currentTarget.closest(".cx-kpi") as HTMLElement).getBoundingClientRect(); setSlotEdit({ i, top: b.bottom + 8, left: Math.max(8, Math.min(b.left, window.innerWidth - 328)) }); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" /></svg>
                </button>
              </span>
              <b className="cx-kpi-v" key={`v-${k.key}`}>{r.v}{r.unit && <em>{r.unit}</em>}</b>
              {r.sub && <span className="cx-kpi-sub" key={`s-${k.key}`}>{r.sub}</span>}
              {r.bar != null && <span className="cx-kpi-bar" key={`b-${k.key}`}><i style={{ width: `${Math.max(0, Math.min(100, r.bar))}%` }} /></span>}
              {two && shownAlt[i] != null && <span className="cx-kpi-sweep" key={`sw-${shownAlt[i]}`} aria-hidden="true" />}
            </div>
          );
        })}
        <div className="cx-kpi-edit">
          <button className={kpiEdit ? "is-on" : ""} onClick={() => setKpiEdit((v) => !v)} title="Choose the figures" aria-label="Choose the figures">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></svg>
          </button>
          {kpiEdit && (
            <>
              <div className="cx-kpi-scrim" onMouseDown={() => setKpiEdit(false)} />
              <div className="cx-kpi-pop" role="dialog" aria-label="Choose the figures">
                <b>Figures on top</b>
                <small>Up to 6 cards — remembered for you. Use ⇄ on a card to swap it or give it a second figure.</small>
                <div className="cx-kpi-opts">
                  {C_KPIS.map((k) => {
                    const on = inSlots(k.key);
                    return (
                      <button key={k.key} className={on ? "is-on" : ""} onClick={() => toggleKpi(k.key)}>
                        <i>{on && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}</i>
                        <span className="cx-kpi-o-ico">{kIco(k.ico)}</span>{k.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {slotEdit && slots[slotEdit.i] && (
        <>
          <div className="cx-kpi-scrim" onMouseDown={() => setSlotEdit(null)} />
          <div className="cx-slot-pop" style={{ top: slotEdit.top, left: slotEdit.left }} role="dialog" aria-label="Change this figure">
            <b>Card {slotEdit.i + 1}</b>
            <small>Pick what it shows. Add a second figure and click the card to switch.</small>
            <label><span>Shows</span>
              <Select value={slots[slotEdit.i][0]} onChange={(v) => v && setSlot(slotEdit.i, v, slots[slotEdit.i][1] ?? "")} options={kpiOpts} />
            </label>
            <label><span>Switches with</span>
              <Select value={slots[slotEdit.i][1] ?? ""} onChange={(v) => setSlot(slotEdit.i, slots[slotEdit.i][0], v)}
                options={[{ value: "", label: "— Nothing, one figure" }, ...kpiOpts.filter((o) => o.value !== slots[slotEdit.i][0])]} />
            </label>
            <div className="cx-slot-act">
              {slots.length > 1 && <button className="is-del" onClick={() => { saveSlots(slots.filter((_, j) => j !== slotEdit.i)); setShownAlt({}); setSlotEdit(null); }}>Remove card</button>}
              <button className="is-ok" onClick={() => setSlotEdit(null)}>Done</button>
            </div>
          </div>
        </>
      )}

      <div className="ccb">
        <FilterChips fields={fields} view={view} onView={setView} onEdit={() => setFiltersOpenTick((x) => x + 1)} shown={shown.length} total={searched.length} noun={["contract", "contracts"]} />
        {rows === null ? <p className="ccb-empty">Loading the contracts…</p> : shown.length === 0 ? (
          <p className="ccb-empty">{rows.length ? "No contract matches." : "No signed contracts yet — they appear here when a deal with a contract is won, or a client's products are signed."}</p>
        ) : layout === "cards" ? (
          <div className="ccb-cards">
            {shown.map((r, i) => {
              const pct = r.start && r.end ? Math.max(0, Math.min(1, (Date.now() - +new Date(r.start)) / Math.max(1, +new Date(r.end) - +new Date(r.start)))) : null;
              return (
                <button type="button" className="ccb-card" key={r.key} onClick={() => setOpen(r)} style={{ ["--i" as any]: Math.min(i, 14) }}>
                  <span className="ccb-card-top">
                    <CompanyLogo className="cx-av" name={r.clientName} website={r.website} />
                    <span className="ccb-card-id"><b>{r.clientName}</b><em>{r.name}</em></span>
                    <i className={`ccb-st is-${stateTone(r.state)}`}>{r.state}</i>
                  </span>
                  <span className="ccb-card-what">{r.what}</span>
                  {r.f ? <ContractTrack f={r.f} compact /> : (
                    <span className="ccb-prog" aria-hidden="true">{pct != null && <i style={{ width: `${pct * 100}%` }} />}</span>
                  )}
                  <span className="ccb-card-dates">
                    <span><em>Signed</em><b>{r.signed ? cpDay(r.signed, "2-digit") : "—"}</b></span>
                    <span><em>Starts</em><b>{r.start ? cpDay(r.start, "2-digit") : "—"}</b></span>
                    <span><em>{r.renews ? "Renews" : "Ends"}</em><b>{r.end ? cpDay(r.end, "2-digit") : "—"}</b></span>
                  </span>
                  <span className="ccb-card-foot">
                    <span className="ccb-card-next">{r.next ? <>Next invoice <b>{cpDay(r.next.date, "2-digit")}</b> · {money(r.next.amount)}</> : r.kind === "lines" ? "Signed products" : "No invoice left"}</span>
                    <span className="ccb-m"><b>{money(r.total)}</b><em>{yearNote(r)}</em></span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="ccb-table is-cols" role="table">
            <div className="ccb-tr is-head" role="row" style={grid}>
              <span><ColumnHead label="Contract" view={view} onView={setView} rows={searched} fields={[byKey.get("name"), byKey.get("kind")]} sortKey="name" /></span>
              {colFields.map((f) => (
                <span key={f.key} className={`ch-cell ${NUM.has(f.key) ? "is-r" : ""}`} title={f.label}>
                  <ColumnHead label={f.label.replace(/ \(.*\)$/, "")} name={f.label} view={view} onView={setView} rows={searched} fields={[f]} sortKey={f.key} />
                </span>
              ))}
            </div>
            {shown.map((r, i) => (
              <button type="button" className="ccb-tr" role="row" key={r.key} onClick={() => setOpen(r)} style={{ ...grid, ["--i" as any]: Math.min(i, 12) }}>
                <span className="ccb-c">
                  <span className={`ccb-ico ${r.kind === "lines" ? "is-old" : ""}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" /></svg></span>
                  <span className="ccb-t"><b>{r.name}</b><em>{r.what}</em></span>
                </span>
                {colFields.map((f) => <span key={f.key} className={NUM.has(f.key) ? "is-r" : ""}>{cell(f, r)}</span>)}
              </button>
            ))}
          </div>
        )}
      </div>

      {open?.kind === "deal" && open.contract && (
        <ContractView contract={open.contract} products={products} clientName={open.clientName} dealName={open.dealName} money={money}
          onClose={() => setOpen(null)}
          onOpenDeal={open.dealId ? () => { const id = open.dealId!; setOpen(null); onOpenDeal(id); } : undefined}
          onOpenClient={open.clientId ? () => { const r = open; setOpen(null); onOpenClient(r.clientId!, r.dealId); } : undefined} />
      )}
      {open?.kind === "lines" && open.lines && (
        <LinesContractView row={open} onClose={() => setOpen(null)}
          onOpenDeal={open.dealId ? () => { const id = open.dealId!; setOpen(null); onOpenDeal(id); } : undefined}
          onOpenClient={open.clientId ? () => { const r = open; setOpen(null); onOpenClient(r.clientId!, r.dealId); } : undefined} />
      )}

      {colEdit && (
        <div className="dw-backdrop" onMouseDown={() => setColEdit(false)}>
          <div className="dw dw-narrow cx-coled" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Columns">
            <div className="dw-head">
              <div>
                <span className="dw-eyebrow">Configure</span>
                <h2 className="dw-title">Contract list columns</h2>
              </div>
              <button className="dw-x" onClick={() => setColEdit(false)}>×</button>
            </div>
            <div className="dw-body">
              <div className="dw-sec">
                <p className="dw-sec-title">Columns in the list</p>
                <p className="dw-empty-hint" style={{ marginTop: 0 }}>Contract is always first. Drag to reorder, × to hide. Saved for you.</p>
                <div className="cf-cols">
                  <div className="cf-col cf-col-fixed"><span className="cf-col-grip">⋮⋮</span>Contract<span className="cf-col-tag">fixed</span></div>
                  {colFields.map((f) => (
                    <div key={f.key} className={`cf-col ${dragCol === f.key ? "is-dragging" : ""} ${dragOver === f.key ? "is-over" : ""}`} draggable
                      onDragStart={(e) => { setDragCol(f.key); e.dataTransfer.effectAllowed = "move"; }}
                      onDragEnd={() => { setDragCol(null); setDragOver(null); }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (f.key !== dragOver) setDragOver(f.key); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragCol && dragCol !== f.key) {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const next = cols.filter((x) => x !== dragCol);
                          const idx = next.indexOf(f.key) + (e.clientY > rect.top + rect.height / 2 ? 1 : 0);
                          next.splice(idx, 0, dragCol);
                          saveCols(next);
                        }
                        setDragCol(null); setDragOver(null);
                      }}>
                      <span className="cf-col-grip">⋮⋮</span>
                      {f.label}<em className="cx-coled-g">{f.group}</em>
                      <button className="cf-col-x" onClick={() => saveCols(cols.filter((x) => x !== f.key))} aria-label={`Hide ${f.label}`}>×</button>
                    </div>
                  ))}
                </div>
                <div className="cf-col-add">
                  <Select value="" onChange={(v) => v && saveCols([...cols, v])} placeholder="+ Add column"
                    options={fields.filter((f) => f.key !== "name" && !cols.includes(f.key)).map((f) => ({ value: f.key, label: f.label, hint: f.group }))} />
                </div>
              </div>
              <div className="dw-sec">
                <button className="cx-col-reset" onClick={() => saveCols(COL_DEFAULT)}>Reset to default columns</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** An older contract (a client's signed products): its products, dates and value. */
function LinesContractView({ row, onClose, onOpenDeal, onOpenClient }: { row: Row; onClose: () => void; onOpenDeal?: () => void; onOpenClient?: () => void }) {
  const ls = row.lines ?? [];
  const ct = row.ct;
  const grace = row.signed && row.start && row.start > row.signed ? Math.round((+new Date(row.start) - +new Date(row.signed)) / 864e5) : 0;
  return (
    <ViewShell title={row.name} eyebrow={<>Contract · {row.clientName}</>} state={row.state} total={money(row.total)} sub={row.perYear > 0.5 ? `${money(row.perYear)} a year` : "One-time"} onClose={onClose}
      foot={<>
        {onOpenDeal && <button type="button" className="ctm-btn" onClick={onOpenDeal}>Open the deal{row.dealName ? ` · ${row.dealName}` : ""}</button>}
        {onOpenClient && <button type="button" className="ctm-btn is-main" onClick={onOpenClient}>Open in {row.clientName}</button>}
      </>}>
      <ViewSec icon={IC.start} title="Dates">
        <div className="ctp-ms">
          <span><em>Signed</em><b>{row.signed ? cpDay(row.signed) : "—"}</b></span>
          {grace > 0 && <span className="is-grace"><em>Grace</em><b>{grace} days</b></span>}
          <span className="is-start"><em>Starts</em><b>{row.start ? cpDay(row.start) : "—"}</b></span>
          {row.end && <span><em>{row.renews ? "Next renewal" : "Ends"}</em><b>{cpDay(row.end)}</b></span>}
          {ct?.termYears && <span><em>Term</em><b>{ct.termYears} year{Number(ct.termYears) === 1 ? "" : "s"}{ct.autoRenew ? " · auto-renews" : ""}</b></span>}
        </div>
      </ViewSec>
      <ViewSec icon="M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5" title="What it includes" sub="The products signed with this contract"
        aside={<span className="ctm-sec-fig">{row.perYear > 0.5 ? money(row.perYear) : money(row.total)}<em>{row.perYear > 0.5 ? "a year" : "one-time"}</em></span>}>
        <div className="ctv-items">
          {ls.map((l) => {
            const r = renewalOf(l, ct);
            return (
              <div className="ctv-item" key={l.id}>
                <span className="ctm-item-ini" aria-hidden="true">{String(l.name ?? "?").slice(0, 1).toUpperCase()}</span>
                <span className="ctv-item-t"><b>{l.name}</b><em>{[l.recurring ? "Recurring" : "One-time", isActive(l) ? null : "stopped", lineStartOf(l, ct) ? `from ${cpDay(String(lineStartOf(l, ct)).slice(0, 10), "2-digit")}` : null, r ? `renews ${cpDay(iso(r.end)!, "2-digit")}` : null].filter(Boolean).join(" · ")}</em></span>
                <span className="ctv-item-f"><b>{money(l.recurring ? lineAnnual(l) : lineContractValue(l))}</b><em>{l.recurring ? "a year" : "once"} · {money(lineContractValue(l))} in all</em></span>
              </div>
            );
          })}
        </div>
      </ViewSec>
    </ViewShell>
  );
}
