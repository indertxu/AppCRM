/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useMemo, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { supabase } from "../../api/supabase";
import NewClientForm from "./NewClientForm";
import ClientWorkspace, { isActive, termOf, lineAnnual, lineTotal, lineContractValue, type Line } from "./ClientWorkspace";
import Select from "../../framework/Select";
import { useClientsData } from "./useClientsData";
import { projectValue, effectiveRate, type Client, type Project, type ProjectType } from "./clientsTypes";
import ActionsMenu, { AM_ICON } from "../../framework/ActionsMenu";
import { downloadBlob, tableToXlsx, type ExportCell } from "../../framework/exportFile";
import { ClientImport } from "../contacts/ContactImport";
import { FilterBar, FilterChips, SortHead, applyView, nextSort, emptyView, useSavedViews, useStoredView, type FField } from "../companies/CompaniesPage";
import { loadPrefs, savePref } from "../companies/companiesApi";
import "../companies/CompaniesPage.css";
import "./ClientsPage.css";

// Re-export shared types & helpers from their new home so existing imports
// elsewhere (e.g. ./ClientsPage) keep working unchanged.
export * from "./clientsTypes";

/** Everything the client popup knows, one row per client — what the KPIs, filters and cards read. */
interface ClientRow {
  c: Client; name: string; services: string[]; consultants: string[];
  city: string; country: string; sector: string;
  projects: number; openProjects: number; projectsValue: number; openValue: number;
  signed: number; used: number; delivered: number;
  recurring: number; contract: number; oneTime: number; products: string[]; activeProducts: number;
  nextRenewal: string | null; firstSigned: string | null; lastContact: string | null; daysSince: number | null; health: string;
  openTasks: number; lateTasks: number;
}
interface Kpi { key: string; label: string; icon: string; tone?: string; calc: (rs: ClientRow[]) => { v: string; unit?: string; sub?: string; bar?: number } }
const KPI_ICONS: Record<string, string> = {
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  briefcase: "M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16",
  euro: "M4 10h12M4 14h9M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2",
  repeat: "m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  contract: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  cal: "M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM16 2v4M8 2v4M3 10h18",
  pulse: "M22 12h-4l-3 9L9 3l-3 9H2",
  tasks: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  box: "M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10",
  check: "M20 6 9 17l-5-5",
};
const sum = (rs: ClientRow[], f: (r: ClientRow) => number) => rs.reduce((t, r) => t + f(r), 0);
const eurN = (n: number) => Math.round(n).toLocaleString();
const KPIS: Kpi[] = [
  { key: "clients", label: "Clients", icon: "users", tone: "mint", calc: (rs) => ({ v: String(rs.length), sub: `${sum(rs, (r) => r.projects)} projects` }) },
  { key: "openValue", label: "Open projects", icon: "briefcase", tone: "jade", calc: (rs) => { const t = sum(rs, (r) => r.projectsValue), o = sum(rs, (r) => r.openValue); return { v: eurN(o), unit: "€", sub: `${sum(rs, (r) => r.openProjects)} open of ${sum(rs, (r) => r.projects)}`, bar: t > 0 ? (o / t) * 100 : 0 }; } },
  { key: "projectsValue", label: "Projects value", icon: "euro", calc: (rs) => ({ v: eurN(sum(rs, (r) => r.projectsValue)), unit: "€", sub: "all service projects" }) },
  { key: "recurring", label: "Recurring", icon: "repeat", tone: "teal", calc: (rs) => ({ v: eurN(sum(rs, (r) => r.recurring)), unit: "€ / yr", sub: `${rs.filter((r) => r.recurring > 0).length} clients subscribed` }) },
  { key: "contract", label: "Sales contracts", icon: "contract", tone: "gold", calc: (rs) => ({ v: eurN(sum(rs, (r) => r.contract)), unit: "€", sub: `${sum(rs, (r) => r.activeProducts)} signed products` }) },
  { key: "total", label: "Total signed", icon: "euro", calc: (rs) => ({ v: eurN(sum(rs, (r) => r.projectsValue + r.contract)), unit: "€", sub: "projects + products" }) },
  { key: "oneTime", label: "One-time fees", icon: "euro", calc: (rs) => ({ v: eurN(sum(rs, (r) => r.oneTime)), unit: "€", sub: "one-offs and set-up" }) },
  { key: "signed", label: "Signed days", icon: "cal", calc: (rs) => ({ v: eurN(sum(rs, (r) => r.signed)), unit: "d", sub: "committed to deliver" }) },
  { key: "delivered", label: "Delivered", icon: "check", calc: (rs) => { const s = sum(rs, (r) => r.signed), u = sum(rs, (r) => r.used); return { v: String(s > 0 ? Math.round((u / s) * 100) : 0), unit: "%", sub: `${eurN(u)} of ${eurN(s)} days`, bar: s > 0 ? (u / s) * 100 : 0 }; } },
  { key: "dayRate", label: "Avg. day rate", icon: "euro", calc: (rs) => { const s = sum(rs, (r) => r.signed); return { v: s > 0 ? eurN(sum(rs, (r) => r.projectsValue) / s) : "—", unit: s > 0 ? "€" : "", sub: "project value per signed day" }; } },
  { key: "products", label: "Active products", icon: "box", calc: (rs) => ({ v: String(sum(rs, (r) => r.activeProducts)), sub: `${rs.filter((r) => r.activeProducts > 0).length} clients` }) },
  { key: "renewals", label: "Renewals · 90 days", icon: "cal", calc: (rs) => { const lim = Date.now() + 90 * 864e5; const xs = rs.filter((r) => r.nextRenewal && new Date(r.nextRenewal).getTime() <= lim); return { v: String(xs.length), sub: xs.length ? xs.slice(0, 2).map((r) => r.name).join(", ") + (xs.length > 2 ? "…" : "") : "nothing due" }; } },
  { key: "quiet", label: "No contact 60+ days", icon: "pulse", tone: "coral", calc: (rs) => { const xs = rs.filter((r) => r.daysSince == null || r.daysSince > 60); return { v: String(xs.length), sub: `of ${rs.length} clients`, bar: rs.length ? (xs.length / rs.length) * 100 : 0 }; } },
  { key: "tasks", label: "Open tasks", icon: "tasks", tone: "gold", calc: (rs) => ({ v: String(sum(rs, (r) => r.openTasks)), sub: `${sum(rs, (r) => r.lateTasks)} late` }) },
];
const KPI_DEFAULT = ["clients", "openValue", "recurring", "contract"];
const COL_DEFAULT = ["services", "projectsValue", "openProjects", "delivered", "recurring", "contract", "lastContact"];
const MONEY_COLS = new Set(["projectsValue", "openValue", "recurring", "contract", "oneTime"]);
const HEALTH: Record<string, string> = { ok: "Healthy", warn: "Getting quiet", bad: "Neglected", none: "No contact yet" };

/* ============================== loading scene ============================== */
const LOAD_WORDS = ["clients", "projects", "contracts", "renewals", "contacts", "figures"];
function ClientsLoading() {
  const [w, setW] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setW((x) => (x + 1) % LOAD_WORDS.length), 1100); return () => window.clearInterval(t); }, []);
  return (
    <>
      <div className="cx-kpis is-loading" style={{ ["--n" as any]: 4 }}>
        {[0, 1, 2, 3].map((i) => (
          <div className="cx-kpi cx-skel-kpi" key={i} style={{ ["--i" as any]: i }}>
            <span className="cx-skel is-ico" /><span className="cx-skel is-k" /><span className="cx-skel is-v" /><span className="cx-skel is-s" />
          </div>
        ))}
        <span />
      </div>
      <section className="cx-sheet is-loading">
        <div className="cx-load">
          <div className="cx-orbit" aria-hidden="true">
            <span className="cx-orbit-core" />
            <span className="cx-orbit-ring is-1"><i /><i /><i /></span>
            <span className="cx-orbit-ring is-2"><i /><i /><i /><i /></span>
            <span className="cx-orbit-ring is-3"><i /><i /><i /><i /><i /></span>
            <span className="cx-orbit-pulse" />
          </div>
          <p className="cx-load-t">Gathering your <span key={w}>{LOAD_WORDS[w]}</span></p>
        </div>
        <div className="cx-grid cx-skel-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div className="cx-card cx-skel-card" key={i} style={{ ["--i" as any]: i }}>
              <div className="cx-card-top"><span className="cx-skel is-av" /><span className="cx-skel-lines"><span className="cx-skel is-l1" /><span className="cx-skel is-l2" /></span></div>
              <div className="cx-tags"><span className="cx-skel is-tag" /><span className="cx-skel is-tag is-short" /></div>
              <div className="cx-card-foot"><span className="cx-skel is-ring" /><span className="cx-skel is-l1" /><span className="cx-skel is-l3" /></div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

export function ClientList({
  clients, projects, projectTypes, onNew, onOpen, onDelete, usage, units, loaded = true, colsSignal = 0,
}: {
  /** Changes when the Actions menu asks for the columns editor. */
  colsSignal?: number;
  /** False while the page's first load runs: the loading scene shows instead. */
  loaded?: boolean;
  clients: Client[];
  projects: Project[];
  projectTypes: ProjectType[];
  onNew: () => void;
  onOpen: (c: Client) => void;
  onDelete?: (c: Client, projectCount: number) => void;
  usage: Record<string, { planned: number; done: number }>;
  units: Record<string, "hour" | "day">;
}) {
  void units;
  const [q, setQ] = useState("");
  const [view, setView] = useStoredView("np-clients-view", emptyView());
  const [savedViews, setSavedViews] = useSavedViews("clientViews");
  const [filtersOpenTick, setFiltersOpenTick] = useState(0);
  const [layout, setLayout] = useState<"grid" | "list">(() => { try { return localStorage.getItem("cl.view") === "list" ? "list" : "grid"; } catch { return "grid"; } });
  const setLayoutP = (v: "grid" | "list") => { setLayout(v); try { localStorage.setItem("cl.view", v); } catch { /* private mode */ } };
  /** The figures on top: one card per slot; a slot with two keys alternates on click. */
  const [slots, setSlots] = useState<string[][]>(KPI_DEFAULT.map((k) => [k]));
  const [shownAlt, setShownAlt] = useState<Record<number, number>>({});
  const [kpiEdit, setKpiEdit] = useState(false);
  const [slotEdit, setSlotEdit] = useState<{ i: number; top: number; left: number } | null>(null);
  const [cols, setCols] = useState<string[]>(COL_DEFAULT);
  const [colEdit, setColEdit] = useState(false);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  useEffect(() => { if (colsSignal) { setColEdit(true); setLayoutP("list"); } }, [colsSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadPrefs().then((p) => { if (Array.isArray(p.clientColumns) && p.clientColumns.length) setCols(p.clientColumns); }).catch(() => {}); }, []);
  const saveCols = (next: string[]) => { setCols(next); savePref("clientColumns", next).catch(() => {}); };
  const known = (k: string) => KPIS.some((x) => x.key === k);
  /** Your saved figures, so the cards don't draw with the defaults and then swap. */
  const [prefsReady, setPrefsReady] = useState(false);
  useEffect(() => {
    loadPrefs().then((p) => {
      if (Array.isArray(p.clientKpiSlots) && p.clientKpiSlots.length) {
        const xs = (p.clientKpiSlots as string[][]).map((sl) => (Array.isArray(sl) ? sl.filter(known).slice(0, 2) : [])).filter((sl) => sl.length);
        if (xs.length) setSlots(xs);
      } else if (Array.isArray(p.clientKpis) && p.clientKpis.length) {
        const xs = (p.clientKpis as string[]).filter(known).map((k) => [k]);
        if (xs.length) setSlots(xs);
      }
    }).catch(() => {}).finally(() => setPrefsReady(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const saveSlots = (next: string[][]) => {
    const clean = next.map((sl) => sl.filter(Boolean).slice(0, 2)).filter((sl) => sl.length);
    if (!clean.length) return;
    setSlots(clean);
    savePref("clientKpiSlots", clean).catch(() => {});
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


  // Resolve team member ids → names for the consultant filter.
  const [people, setPeople] = useState<Record<string, string>>({});
  useEffect(() => {
    supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(({ data }: any) => {
      const out: Record<string, string> = {};
      ((data?.users ?? []) as any[]).forEach((u) => {
        out[u.id] = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—";
      });
      setPeople(out);
    }).catch(() => {});
  }, []);
  const personName = (id: string, fb?: string) => people[id] || (fb && fb !== "—" ? fb : "") || "Unknown";

  // what the client popup shows, for every client at once
  const [extra, setExtra] = useState<{ lines: Line[]; last: Record<string, string>; tasks: Record<string, { open: number; late: number }>; co: Record<string, any>; cos?: any[] } | null>(null);
  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    (async () => {
      const [cp, pr, lg, ct, cl] = await Promise.all([
        supabase.from("client_products").select("*"),
        supabase.from("products").select("id, name"),
        supabase.from("client_contacts_log").select("client_id, contacted_at"),
        supabase.from("client_tasks").select("client_id, done, due_at"),
        supabase.from("clients").select("id, company_id"),
      ]);
      const pn: Record<string, string> = {};
      ((pr.data ?? []) as any[]).forEach((x) => { pn[x.id] = x.name; });
      const last: Record<string, string> = {};
      ((lg.data ?? []) as any[]).forEach((x) => { if (x.client_id && x.contacted_at && (!last[x.client_id] || x.contacted_at > last[x.client_id])) last[x.client_id] = x.contacted_at; });
      const tasks: Record<string, { open: number; late: number }> = {};
      const today = new Date().toISOString().slice(0, 10);
      ((ct.error ? [] : ct.data ?? []) as any[]).forEach((x) => {
        if (x.done) return;
        const t = (tasks[x.client_id] ??= { open: 0, late: 0 });
        t.open++; if (x.due_at && String(x.due_at).slice(0, 10) < today) t.late++;
      });
      const coOf: Record<string, string> = {};
      ((cl.data ?? []) as any[]).forEach((x) => { if (x.company_id) coOf[x.id] = x.company_id; });
      // Every company, so a client can also be found by the company's other name
      // (common or legal) even when the two are not linked.
      const cos: Record<string, any> = {};
      const allCos: any[] = [];
      for (let from = 0; ; from += 1000) {
        const { data: page } = await supabase.from("companies").select("id, name, legal_name, vat_number, city, province, country, sector").range(from, from + 999);
        ((page ?? []) as any[]).forEach((x) => { cos[x.id] = x; allCos.push(x); });
        if (!page || page.length < 1000) break;
      }
      const co: Record<string, any> = {};
      Object.entries(coOf).forEach(([cid, coid]) => { if (cos[coid]) co[cid] = cos[coid]; });
      if (alive) setExtra({ lines: ((cp.data ?? []) as any[]).map((r) => ({ ...r, name: pn[r.product_id] ?? "Product" })), last, tasks, co, cos: allCos });
    })().catch(() => setExtra({ lines: [], last: {}, tasks: {}, co: {}, cos: [] }));
    return () => { alive = false; };
  }, [loaded, clients.length]);

  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";
  const rows = useMemo<ClientRow[]>(() => clients.map((c) => {
    const mine = projects.filter((p) => p.clientId === c.id);
    const open = mine.filter((p) => p.status !== "closed");
    const ls = (extra?.lines ?? []).filter((l) => l.client_id === c.id);
    const act = ls.filter(isActive);
    const renew = act.map(termOf).filter((t): t is NonNullable<ReturnType<typeof termOf>> => !!t && t.left >= 0).sort((a, b) => a.end.getTime() - b.end.getTime())[0];
    const signedAt = [...mine.map((p) => p.signingDate), ...ls.map((l) => l.signing_date)].filter(Boolean).sort()[0] ?? null;
    const last = extra?.last[c.id] ?? null;
    const days = last ? Math.max(0, Math.floor((Date.now() - new Date(last).getTime()) / 864e5)) : null;
    const signed = mine.reduce((t, p) => t + p.consultorDays + p.connectorDays + p.supervisionDays, 0);
    const used = mine.reduce((t, p) => t + (usage[p.id]?.done ?? 0), 0);
    const lastP = mine[mine.length - 1];
    const co = extra?.co[c.id] ?? {};
    return {
      c, name: c.name,
      services: [...new Set(mine.map((p) => typeName(p.projectTypeId)))],
      consultants: [...new Set(mine.flatMap((p) => (p.team ?? []).map((m) => m.userId).filter(Boolean)))] as string[],
      city: co.city || lastP?.address?.city || "", country: co.country || lastP?.address?.country || "", sector: co.sector || "",
      projects: mine.length, openProjects: open.length,
      projectsValue: mine.reduce((t, p) => t + projectValue(p), 0), openValue: open.reduce((t, p) => t + projectValue(p), 0),
      signed, used, delivered: signed > 0 ? Math.min(100, Math.round((used / signed) * 100)) : 0,
      recurring: act.reduce((t, l) => t + lineAnnual(l), 0), contract: act.reduce((t, l) => t + lineContractValue(l), 0),
      oneTime: ls.reduce((t, l) => t + (l.recurring ? 0 : lineTotal(l)) + (Number(l.one_time_fee) || 0), 0),
      products: [...new Set(act.map((l) => l.name))], activeProducts: act.length,
      nextRenewal: renew ? renew.end.toISOString().slice(0, 10) : null, firstSigned: signedAt,
      lastContact: last, daysSince: days, health: days == null ? "none" : days > 60 ? "bad" : days > 30 ? "warn" : "ok",
      openTasks: extra?.tasks[c.id]?.open ?? 0, lateTasks: extra?.tasks[c.id]?.late ?? 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [clients, projects, extra, usage, projectTypes]);

  const opts = (xs: string[]) => () => [...new Set(xs.filter(Boolean))].sort().map((v) => ({ value: v, label: v }));
  const fields: FField<ClientRow>[] = [
    { key: "name", label: "Name", group: "Client", type: "text", get: (r) => r.name },
    { key: "city", label: "City", group: "Client", type: "select", get: (r) => r.city, options: opts(rows.map((r) => r.city)) },
    { key: "country", label: "Country", group: "Client", type: "select", get: (r) => r.country, options: opts(rows.map((r) => r.country)) },
    { key: "sector", label: "Sector", group: "Client", type: "select", get: (r) => r.sector, options: opts(rows.map((r) => r.sector)) },
    { key: "firstSigned", label: "Client since", group: "Client", type: "date", get: (r) => r.firstSigned },
    { key: "services", label: "Services", group: "Projects", type: "multi", get: (r) => r.services, options: opts(rows.flatMap((r) => r.services)) },
    { key: "consultants", label: "Consultants", group: "Projects", type: "multi", get: (r) => r.consultants,
      options: () => [...new Set(rows.flatMap((r) => r.consultants))].map((id) => ({ value: id, label: personName(id) })).sort((a, b) => a.label.localeCompare(b.label)) },
    { key: "projects", label: "Projects", group: "Projects", type: "number", get: (r) => r.projects },
    { key: "openProjects", label: "Open projects", group: "Projects", type: "number", get: (r) => r.openProjects },
    { key: "projectsValue", label: "Projects value (€)", group: "Projects", type: "number", get: (r) => Math.round(r.projectsValue) },
    { key: "openValue", label: "Open projects value (€)", group: "Projects", type: "number", get: (r) => Math.round(r.openValue) },
    { key: "signed", label: "Signed days", group: "Projects", type: "number", get: (r) => r.signed },
    { key: "delivered", label: "Delivered (%)", group: "Projects", type: "number", get: (r) => r.delivered },
    { key: "products", label: "Products", group: "Contract", type: "multi", get: (r) => r.products, options: opts(rows.flatMap((r) => r.products)) },
    { key: "activeProducts", label: "Active products", group: "Contract", type: "number", get: (r) => r.activeProducts },
    { key: "recurring", label: "Recurring (€ / year)", group: "Contract", type: "number", get: (r) => Math.round(r.recurring) },
    { key: "contract", label: "Sales contract (€)", group: "Contract", type: "number", get: (r) => Math.round(r.contract) },
    { key: "oneTime", label: "One-time (€)", group: "Contract", type: "number", get: (r) => Math.round(r.oneTime) },
    { key: "nextRenewal", label: "Next renewal", group: "Contract", type: "date", get: (r) => r.nextRenewal },
    { key: "lastContact", label: "Last contact", group: "Activity", type: "date", get: (r) => r.lastContact },
    { key: "daysSince", label: "Days since contact", group: "Activity", type: "number", get: (r) => r.daysSince },
    { key: "health", label: "Health", group: "Activity", type: "select", get: (r) => r.health, options: () => Object.entries(HEALTH).map(([value, label]) => ({ value, label })) },
    { key: "openTasks", label: "Open tasks", group: "Activity", type: "number", get: (r) => r.openTasks },
    { key: "lateTasks", label: "Late tasks", group: "Activity", type: "number", get: (r) => r.lateTasks },
  ];

  const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // Search: every word you type has to appear somewhere — name, legal names,
  // VAT, linked company, contacts, city, sector, services or products — in any
  // order, ignoring accents, case and punctuation ("S.L." = "SL").
  const flat = (s: unknown) => norm(String(s ?? "")).replace(/[^a-z0-9@\s]/g, "");
  /** Name without its legal form, so "Helix Pharma" meets "Helix Pharma, S.A.". */
  const bare = (s: unknown) => flat(s).replace(/\s+/g, " ").trim()
    .replace(/\s(s\s?l\s?u?|s\s?a\s?u?|slp|sll|sccl|scp|cb|sociedad limitada|sociedad anonima|ab|gmbh|ltd|llc|inc|bv|srl|spa|sas|sarl|plc|ag|nv)$/, "").trim();
  // Companies by any of their names / VAT, to pick up the other name of a client.
  const coIndex = useMemo(() => {
    const m = new Map<string, any[]>();
    const put = (k: string, c: any) => { if (!k) return; const l = m.get(k) ?? []; l.push(c); m.set(k, l); };
    (extra?.cos ?? []).forEach((c) => { put(bare(c.name), c); put(bare(c.legal_name), c); put(flat(c.vat_number).replace(/\s+/g, ""), c); });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extra]);
  // Names first: if what you type matches a client's own name (or its
  // company's common/legal name, or a VAT), only those clients show. Only when
  // no name matches does it fall back to city, sector, service, product and
  // contacts — so "Konsolidator" finds the client, not everyone on that service.
  const searchInfo = useMemo(() => {
    const words = flat(q).split(/\s+/).filter(Boolean);
    if (!words.length) return { list: rows, by: "" as "" | "name" | "other" };
    const hit = (txt: string) => { const tight = txt.replace(/\s+/g, ""); return words.every((w) => txt.includes(w) || tight.includes(w)); };
    const scored = rows.map((r) => {
      const mine = projects.filter((p) => p.clientId === r.c.id);
      const co = extra?.co[r.c.id] ?? {};
      const twins = [
        ...(coIndex.get(bare(r.name)) ?? []),
        ...mine.flatMap((p) => [...(coIndex.get(bare(p.legalName)) ?? []), ...(coIndex.get(flat(p.vatNumber).replace(/\s+/g, "")) ?? [])]),
      ];
      const names = flat([
        r.name, co.name, co.legal_name, co.vat_number,
        ...twins.flatMap((t) => [t.name, t.legal_name, t.vat_number]),
        ...mine.flatMap((p) => [p.legalName, p.vatNumber]),
      ].filter(Boolean).join(" "));
      const other = flat([
        r.city, r.country, r.sector, ...r.services, ...r.products,
        ...mine.flatMap((p) => [p.address?.city, ...(p.contacts ?? []).flatMap((ct) => [ct.name, ct.email])]),
      ].filter(Boolean).join(" "));
      const own = flat(r.name);
      const exact = own === words.join(" ") ? 0 : own.startsWith(words[0]) ? 1 : 2;
      return { r, byName: hit(names), byAny: hit(`${names} ${other}`), exact };
    });
    const named = scored.filter((x) => x.byName);
    if (named.length) return { list: named.sort((a, b) => a.exact - b.exact).map((x) => x.r), by: "name" as const };
    return { list: scored.filter((x) => x.byAny).map((x) => x.r), by: "other" as const };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, projects, extra, coIndex]);
  const searched = searchInfo.list;
  const shown = applyView(searched, fields, view);
  const sortKey = view.sort[0]?.key ?? "";
  const sortDir = view.sort[0]?.dir ?? "desc";
  const setSort = (key: string, dir: "asc" | "desc" = sortDir) => setView({ ...view, sort: key ? [{ key, dir }] : [] });

  if (!loaded || !prefsReady || (clients.length > 0 && !extra)) return <ClientsLoading />;
  if (clients.length === 0) {
    return (
      <div className="cl-empty">
        <div className="cl-empty-badge" aria-hidden="true" />
        <h2>No clients yet</h2>
        <p>Create your first engagement to get started.</p>
        <button className="cl-primary" onClick={onNew}>+ New client</button>
      </div>
    );
  }

  const money = (n: number) => `${Math.round(n).toLocaleString()} €`;
  const initials = (t: string) => t.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  const ring = (pct: number) => {
    const r = 17, c = 2 * Math.PI * r;
    return (
      <svg className="cx-ring" viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r={r} className="cx-ring-bg" />
        <circle cx="22" cy="22" r={r} className="cx-ring-fg" style={{ strokeDasharray: `${(pct / 100) * c} ${c}` }} />
      </svg>
    );
  };
  const kIco = (n: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={KPI_ICONS[n] ?? KPI_ICONS.euro} /></svg>;
  const spot = (e: RPointerEvent<HTMLElement>) => {
    const el = e.currentTarget, b = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - b.left}px`); el.style.setProperty("--my", `${e.clientY - b.top}px`);
  };
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const colFields = cols.map((k) => byKey.get(k)).filter((f): f is FField<ClientRow> => !!f && f.key !== "name");
  const onSortHead = (key: string, add: boolean) => setView({ ...view, sort: nextSort(view.sort, key, add) });
  const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
  const cell = (f: FField<ClientRow>, r: ClientRow): ReactNode => {
    const v = f.get(r);
    if (f.key === "health") return <span className={`cx-health is-${r.health}`}><i />{HEALTH[r.health]}</span>;
    if (f.key === "consultants") return (v as string[]).length ? <span className="cx-cell-tags">{(v as string[]).map((id) => <i key={id}>{personName(id)}</i>)}</span> : "—";
    if (f.type === "multi") return (v as string[]).length ? <span className="cx-cell-tags">{(v as string[]).map((x) => <i key={x}>{x}</i>)}</span> : "—";
    if (f.type === "date") return fmtDate(v);
    if (f.type === "number") {
      if (v == null || v === "") return "—";
      if (MONEY_COLS.has(f.key)) return Number(v) ? `${Math.round(Number(v)).toLocaleString()} €` : "—";
      if (f.key === "delivered") return <span className="cx-cell-bar"><span><i style={{ width: `${Number(v)}%` }} /></span><b>{v}%</b></span>;
      return Number(v).toLocaleString();
    }
    return v || "—";
  };
  const kpiOf = (k: string) => KPIS.find((x) => x.key === k);
  const kpiOpts = KPIS.map((k) => ({ value: k.key, label: k.label }));
  const sortable = fields.filter((f) => f.type !== "multi");

  return (
    <>
      <div className="cx-kpis" style={{ ["--n" as any]: slots.length }}>
        {slots.map((sl, i) => {
          const at = (shownAlt[i] ?? 0) % sl.length;
          const k = kpiOf(sl[at]);
          if (!k) return null;
          const r = k.calc(shown);
          const two = sl.length > 1;
          const flip = () => { if (two) setShownAlt((x) => ({ ...x, [i]: at + 1 })); };
          return (
            <div className={`cx-kpi tone-${k.tone ?? "mint"} ${two ? "is-alt" : ""} ${shownAlt[i] != null ? "is-flipped" : ""}`} key={`slot-${i}-${sl.join("|")}`} style={{ ["--i" as any]: i }} onPointerMove={spot}
              role={two ? "button" : undefined} tabIndex={two ? 0 : undefined}
              title={two ? `Click to show ${kpiOf(sl[(at + 1) % sl.length])?.label}` : undefined}
              onClick={flip} onKeyDown={(e) => { if (e.key === "Enter") flip(); }}>
              <span className="cx-kpi-top">
                <span className="cx-kpi-ico" key={`ico-${k.key}`}>{kIco(k.icon)}</span><span className="cx-kpi-k" key={`k-${k.key}`}>{k.label}</span>
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
                  {KPIS.map((k) => {
                    const on = inSlots(k.key);
                    return (
                      <button key={k.key} className={on ? "is-on" : ""} onClick={() => toggleKpi(k.key)}>
                        <i>{on && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}</i>
                        <span className="cx-kpi-o-ico">{kIco(k.icon)}</span>{k.label}
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

      <section className="cx-sheet">
        <div className="cx-tools">
          <label className="cx-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client, city, service or product…" />
            {q && <button onClick={() => setQ("")} aria-label="Clear">×</button>}
          </label>
          <FilterBar fields={fields} view={view} onView={setView} total={rows.length} shown={shown.length} noun={["client", "clients"]}
            saved={savedViews} onSaved={setSavedViews} openSignal={filtersOpenTick} />
          <div className="cx-sort">
            <Select size="sm" value={sortKey} onChange={(k) => setSort(k, k && fields.find((f) => f.key === k)?.type === "text" ? "asc" : "desc")} placeholder="Sort"
              options={[{ value: "", label: "Most recent" }, ...sortable.map((f) => ({ value: f.key, label: f.label, hint: f.group }))]} />
            {sortKey && (
              <button className="cx-dir" onClick={() => setSort(sortKey, sortDir === "asc" ? "desc" : "asc")} title={sortDir === "asc" ? "Ascending" : "Descending"} aria-label="Sort direction">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: sortDir === "asc" ? "scaleY(-1)" : undefined }}><path d="M12 5v14M6 13l6 6 6-6" /></svg>
              </button>
            )}
          </div>
          <div className="cx-view" role="group" aria-label="View">
            <button className={layout === "grid" ? "is-on" : ""} onClick={() => setLayoutP("grid")} aria-label="Cards" title="Cards">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></svg>
            </button>
            <button className={layout === "list" ? "is-on" : ""} onClick={() => setLayoutP("list")} aria-label="List" title="List">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
            </button>
          </div>
        </div>
        <FilterChips fields={fields} view={view} onView={setView} onEdit={() => setFiltersOpenTick((x) => x + 1)} shown={shown.length} total={rows.length} noun={["client", "clients"]} />
        {q.trim() && searchInfo.by === "other" && shown.length > 0 && (
          <p className="cx-search-note">No client is called “{q.trim()}” — showing clients where it appears in their service, products, city or contacts.</p>
        )}

        <div className="cl-scroll">
          {shown.length === 0 ? (
            <div className="cx-none"><b>No clients match</b><span>Try another search or change the filters.</span></div>
          ) : (
            layout === "list" ? (
              <div className="cx-table-wrap">
                <div className="cx-table" style={{ ["--cols" as any]: `minmax(230px, 1.7fr) ${colFields.map((f) => (f.type === "multi" ? "minmax(170px, 1.4fr)" : "minmax(118px, 1fr)")).join(" ")} 64px`, minWidth: 300 + colFields.length * 130 }}>
                  <div className="cx-tr is-head">
                    <span><SortHead label="Client" k="name" sort={view.sort} onSort={onSortHead} /></span>
                    {colFields.map((f) => <span key={f.key} className={f.type === "number" ? "is-num" : ""}><SortHead label={f.label.replace(/ \(.*\)$/, "")} k={f.key} sort={view.sort} onSort={onSortHead} /></span>)}
                    <span />
                  </div>
                  {shown.map((r, i) => (
                    <div className="cx-tr" key={r.c.id} role="button" tabIndex={0} style={{ ["--i" as any]: Math.min(i, 16) }}
                      onClick={() => onOpen(r.c)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(r.c); }}>
                      <span className="cx-td-name">
                        <span className="cx-av is-sm">{initials(r.name)}</span>
                        <span className="cx-id"><b>{r.name}</b><small>{[r.city, r.sector].filter(Boolean).join(" · ") || "—"}</small></span>
                      </span>
                      {colFields.map((f) => <span key={f.key} className={f.type === "number" ? "is-num" : ""}>{cell(f, r)}</span>)}
                      <span className="cx-td-go">
                        {onDelete && (
                          <button className="cx-del" aria-label={`Delete ${r.name}`} title="Delete client" onClick={(e) => { e.stopPropagation(); onDelete(r.c, r.projects); }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                          </button>
                        )}
                        <svg className="cx-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
            <div className="cx-grid">
              {shown.map((r, i) => {
                const c = r.c;
                return (
                  <div className="cx-card" key={c.id} role="button" tabIndex={0} style={{ ["--i" as any]: Math.min(i, 14) }}
                    onClick={() => onOpen(c)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(c); }}>
                    <div className="cx-card-top">
                      <span className="cx-av">{initials(c.name)}</span>
                      <span className="cx-id">
                        <b>{c.name}</b>
                        <small>{[r.city, r.sector].filter(Boolean).join(" · ") || "No details yet"}</small>
                      </span>
                      {r.daysSince != null && <span className={`cx-health is-${r.health}`} title={`${HEALTH[r.health]} · last contact ${r.daysSince}d ago`}><i />{r.daysSince}d</span>}
                      {onDelete && (
                        <button className="cx-del" aria-label={`Delete ${c.name}`} title="Delete client"
                          onClick={(e) => { e.stopPropagation(); onDelete(c, r.projects); }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                        </button>
                      )}
                    </div>
                    <div className="cx-tags">
                      {r.services.map((t) => <span key={`s${t}`}>{t}</span>)}
                      {r.products.map((t) => <span key={`p${t}`} className="is-prod">{t}</span>)}
                      {!r.services.length && !r.products.length && <span className="is-soft">Nothing signed yet</span>}
                    </div>
                    <div className="cx-card-foot">
                      <span className="cx-prog" title={`${r.delivered}% of signed days delivered`}>{ring(r.delivered)}<i>{r.delivered}%</i></span>
                      <span className="cx-stat"><b>{r.projectsValue > 0 ? money(r.projectsValue) : "—"}</b><small>{r.openProjects}/{r.projects} projects open</small></span>
                      <span className="cx-stat is-r"><b>{r.recurring > 0 ? <>{money(r.recurring)}<em> /yr</em></> : r.contract > 0 ? money(r.contract) : "—"}</b><small>{r.activeProducts ? `${r.activeProducts} product${r.activeProducts === 1 ? "" : "s"}` : "no products"}</small></span>
                      <svg className="cx-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                    </div>
                  </div>
                );
              })}
            </div>
            )
          )}
        </div>
      </section>

      {colEdit && (
        <div className="dw-backdrop" onMouseDown={() => setColEdit(false)}>
          <div className="dw dw-narrow cx-coled" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Columns">
            <div className="dw-head">
              <div>
                <span className="dw-eyebrow">Configure</span>
                <h2 className="dw-title">Client list columns</h2>
              </div>
              <button className="dw-x" onClick={() => setColEdit(false)}>×</button>
            </div>
            <div className="dw-body">
              <div className="dw-sec">
                <p className="dw-sec-title">Columns in the list</p>
                <p className="dw-empty-hint" style={{ marginTop: 0 }}>Client is always first. Drag to reorder, × to hide. Saved for you.</p>
                <div className="cf-cols">
                  <div className="cf-col cf-col-fixed"><span className="cf-col-grip">⋮⋮</span>Client<span className="cf-col-tag">fixed</span></div>
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

export default function ClientsPage() {
  const d = useClientsData();
  const {
    clients, projects, projectTypes, roles, blueprints, usage, units, loaded,
    showForm, setShowForm, detailClient, setDetailClient, editing, setEditing,
    handoffId, soldSummary, loadAll,
    saveClientProject, deleteProject, openNewProject,
  } = d;

  // Deleting a client cascades to its projects, so the confirmation is sized to
  // the damage. This flow is clients-only, so it lives here, not in the hook.
  const [deleteTarget, setDeleteTarget] = useState<{ client: Client; count: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [colsTick, setColsTick] = useState(0);

  /** One row per project (a client without projects gets one row) — the same columns the importer reads. */
  const exportClients = () => {
    const svc = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "";
    const date = (s: string) => (s ? { date: s.slice(0, 10) } : null);
    const rows: ExportCell[][] = [];
    [...clients].sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => {
      const ps = projects.filter((p) => p.clientId === c.id);
      if (!ps.length) { rows.push([c.name, ...Array(28).fill(null)]); return; }
      ps.forEach((p) => {
        const ct = p.contacts?.find((x) => x.billing) ?? p.contacts?.[0];
        const u = usage[p.id] ?? { planned: 0, done: 0 };
        const rate = p.discountMode === "rate" ? effectiveRate(p.pricePerDay, p.discountMode, p.discountValue) : p.pricePerDay;
        rows.push([
          c.name, p.legalName || null, p.vatNumber || null,
          p.address?.street || null, p.address?.number || null, p.address?.postalCode || null, p.address?.city || null, p.address?.country || null,
          ct?.name || null, ct?.email || null, ct?.phone || null, ct?.position || null,
          svc(p.projectTypeId) || null, p.status === "closed" ? "Closed" : "Open",
          date(p.signingDate), date(p.kickoffDate), date(p.endDate),
          p.consultorDays, p.connectorDays, rate, p.supervisionDays, p.supervisionPrice,
          p.discountMode === "percent" ? p.discountValue : null, p.discountMode === "total" ? p.discountValue : null,
          p.taxed ? p.taxRate : null, p.paymentDays || null,
          Math.round(projectValue(p) * 100) / 100, Math.round(u.done * 100) / 100, Math.round(u.planned * 100) / 100,
        ]);
      });
    });
    const cols: [string, "text" | "number" | "money" | "date" | "percent"][] = [
      ["Client", "text"], ["Legal name", "text"], ["VAT", "text"], ["Street", "text"], ["Number", "text"], ["Postal code", "text"], ["City", "text"], ["Country", "text"],
      ["Contact", "text"], ["Contact email", "text"], ["Contact phone", "text"], ["Position", "text"], ["Service", "text"], ["Status", "text"],
      ["Signing date", "date"], ["Kick-off", "date"], ["End date", "date"], ["Consultancy days", "number"], ["Connector days", "number"], ["Price per day", "money"],
      ["Supervision days", "number"], ["Supervision price", "money"], ["Discount %", "number"], ["Discount total", "money"], ["Tax rate", "number"], ["Payment days", "number"],
      ["Value", "money"], ["Used days", "number"], ["Booked days", "number"],
    ];
    const blob = tableToXlsx({ columns: cols.map(([label, format]) => ({ label, format })), rows }, "Clients");
    downloadBlob(blob, `clients-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };
  const [deleteTyped, setDeleteTyped] = useState("");
  const [deleteImpact, setDeleteImpact] = useState<{ invoices: number; entries: number } | null>(null);

  const askDeleteClient = async (c: Client, count: number) => {
    setDeleteTyped("");
    setDeleteImpact(null);
    setDeleteTarget({ client: c, count });
    const { data: ps } = await supabase.from("projects").select("id").eq("client_id", c.id);
    const ids = (ps ?? []).map((x: any) => x.id);
    if (!ids.length) { setDeleteImpact({ invoices: 0, entries: 0 }); return; }
    const inv = await supabase.from("invoices").select("id", { count: "exact", head: true }).in("project_id", ids);
    const ent = await supabase.from("calendar_entries").select("id", { count: "exact", head: true }).in("project_id", ids);
    setDeleteImpact({ invoices: inv.count ?? 0, entries: ent.count ?? 0 });
  };

  const doDeleteClient = async () => {
    if (!deleteTarget) return;
    const { error } = await supabase.from("clients").delete().eq("id", deleteTarget.client.id);
    if (error) { alert(`Could not delete client: ${error.message}`); return; }
    setDeleteTarget(null);
    setDetailClient((cur) => (cur && cur.id === deleteTarget.client.id ? null : cur));
    await loadAll();
  };

  return (
    <div className="cl cl-ov">
      <header className="cl-bar">
        <div className="cl-bar-left">
          <div>
            <h1 className="cl-title">Clients</h1>
            <p className="cx-sub">{clients.length} client{clients.length === 1 ? "" : "s"} · {projects.filter((p) => p.status !== "closed").length} open project{projects.filter((p) => p.status !== "closed").length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div className="cl-actions">
          <ActionsMenu items={[
            { key: "new", group: "Create", label: "New client", hint: "Add one client and its first project", icon: AM_ICON.plus, primary: true, tone: "green", shortcut: "N", onSelect: () => setShowForm(true) },
            { key: "import", group: "Data", label: "Import", hint: "Clients and projects from Excel or CSV", icon: AM_ICON.import, tone: "blue", shortcut: "I", onSelect: () => setImporting(true) },
            { key: "export", group: "Data", label: "Export", hint: "Every client and project to Excel — re-importable", icon: AM_ICON.export, tone: "violet", shortcut: "E", onSelect: exportClients },
            { key: "fields", group: "Setup", label: "Columns", hint: "Choose and order the columns of the list", icon: AM_ICON.fields, tone: "amber", shortcut: "F", onSelect: () => setColsTick((x) => x + 1) },
          ]} />
        </div>
      </header>

      <ClientList
        clients={clients}
        projects={projects}
        projectTypes={projectTypes}
        onNew={() => setShowForm(true)}
        onOpen={(c) => setDetailClient(c)}
        onDelete={askDeleteClient}
        usage={usage}
        units={units}
        loaded={loaded}
        colsSignal={colsTick}
      />

      {detailClient && (
        <ClientWorkspace
          client={detailClient}
          projects={projects.filter((p) => p.clientId === detailClient.id)}
          projectTypes={projectTypes}
          usage={usage}
          onOpenProject={(p) => setEditing({ client: detailClient, project: p })}
          onNewProject={() => openNewProject(detailClient)}
          onDeleteProject={deleteProject}
          onClose={() => setDetailClient(null)}
        />
      )}

      {importing && <ClientImport onClose={() => setImporting(false)} onDone={() => { void loadAll(); }} />}

      {showForm && (
        <NewClientForm
          onSave={saveClientProject}
          onClose={() => setShowForm(false)}
          roles={roles}
          projectTypes={projectTypes}
          blueprints={blueprints}
        />
      )}

      {editing && (
        <NewClientForm
          key={editing.project?.id ?? editing.client?.id}
          client={editing.client}
          project={editing.project}
          onSave={saveClientProject}
          onClose={() => setEditing(null)}
          roles={roles}
          projectTypes={projectTypes}
          blueprints={blueprints}
          soldFrom={handoffId ? soldSummary : null}
        />
      )}

      {deleteTarget && (
        <div className="cl-del-backdrop" onMouseDown={() => setDeleteTarget(null)}>
          <div className="cl-del" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="cl-del-title">Delete {deleteTarget.client.name}?</h3>
            {deleteTarget.count === 0 ? (
              <p className="cl-del-text">This client has no projects. Deleting it cannot be undone.</p>
            ) : (
              <>
                <p className="cl-del-text">
                  This permanently deletes <b>{deleteTarget.count} project{deleteTarget.count === 1 ? "" : "s"}</b>
                  {deleteImpact === null ? " and everything invoiced against them"
                    : deleteImpact.invoices > 0
                      ? <> and <b>{deleteImpact.invoices} invoice{deleteImpact.invoices === 1 ? "" : "s"}</b></>
                      : " (no invoices yet)"}. This cannot be undone.
                </p>
                {deleteImpact !== null && deleteImpact.entries > 0 && (
                  <p className="cl-del-note">
                    {deleteImpact.entries} logged calendar {deleteImpact.entries === 1 ? "entry" : "entries"} will be
                    kept but left without a project, so they stop counting towards backlog and bonus.
                  </p>
                )}
                <label className="cl-del-confirm">
                  <span>Type <b>{deleteTarget.client.name}</b> to confirm</span>
                  <input value={deleteTyped} autoFocus onChange={(e) => setDeleteTyped(e.target.value)} />
                </label>
              </>
            )}
            <div className="cl-del-actions">
              <button className="cl-del-cancel" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="cl-del-go"
                disabled={deleteTarget.count > 0 && deleteTyped.trim() !== deleteTarget.client.name}
                onClick={doDeleteClient}>Delete client</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}