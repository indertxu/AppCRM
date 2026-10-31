/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useMemo, useRef, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent, type ReactNode } from "react";
import { supabase } from "../../api/supabase";
import NewClientForm from "./NewClientForm";
import ClientWorkspace, { CompanyLogo, isActive, termOf, lineAnnual, lineContractValue, lineOneTime, type Line } from "./ClientWorkspace";
import Select from "../../framework/Select";
import { PageLoader } from "../../framework/AppLayout";
import {
  useClientsData, loadCsData, setClientOwners, saveClientHealth, saveUpsell, deleteUpsell, saveQbr, deleteQbr, freezeArr,
  addRevenueEvent, deleteRevenueEvent, saveCsSettings, setClientCadence, logClientContact, createClientFollowUp, generateContactTasks,
  convertUpsellToDeal, CS_REASONS, UPSELL_STATUSES, SPICED, NEEDS_CS,
  type CsData, type CsUpsell, type CsHealthStatus, type CsQbr, type RevenueEvent,
} from "./useClientsData";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { listEmployees, type Employee } from "../companies/companiesApi";
import { loadProducts, loadServices, type Product as CatProduct, type Service as CatService } from "../settings/catalogApi";
import { projectValue, signedOf, legacyRoleMap, resolvedLinesOf, roleCounts, roleNameOf, lineRate, projectStatusOf, PROJECT_STATUS_LABEL, type Client, type Project, type ProjectType } from "./clientsTypes";
import ActionsMenu, { AM_ICON } from "../../framework/ActionsMenu";
import { downloadBlob, tableToXlsx, type ExportCell } from "../../framework/exportFile";
import { ClientImport } from "../contacts/ContactImport";
import { FilterBar, FilterChips, SortHead, applyView, nextSort, emptyView, useSavedViews, useStoredView, type FField } from "../companies/CompaniesPage";
import { loadPrefs, savePref } from "../companies/companiesApi";
import { countryLabel } from "../contacts/contactProfile";
import { ensureRenewalDeals } from "../sales/sales/salesApi";
import "../companies/CompaniesPage.css";
import "./ClientsPage.css";
import { useNavSection } from "../../framework/pageAccess";

// Re-export shared types & helpers from their new home so existing imports
// elsewhere (e.g. ./ClientsPage) keep working unchanged.
export * from "./clientsTypes";

/** Everything the client popup knows, one row per client — what the KPIs, filters and cards read. */
/** "Acme Iberia, S.L." → "acme iberia": to match a client with its CRM company by name. */
const bareName = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
  .replace(/\s(s\s?l\s?u?|s\s?a\s?u?|slp|sll|sccl|scp|cb|ab|gmbh|ltd|llc|inc|bv|srl|spa|sas|sarl|plc|ag|nv)$/, "").trim();

interface ClientRow {
  c: Client; name: string; services: string[]; consultants: string[];
  /** The company's website (for its logo), and whether another client looks like the same one. */
  website: string; dupOf: string | null;
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
/** Column names short enough for a narrow list (the full name stays in the header's tooltip). */
const HEAD_SHORT: Record<string, string> = {
  projectsValue: "Projects €", openValue: "Open €", openProjects: "Open", contract: "Contract", lastContact: "Contacted",
  oneTime: "One-time", activeProducts: "Products", nextRenewal: "Renewal", firstSigned: "Since", openTasks: "Tasks", lateTasks: "Late",
};
const HEALTH: Record<string, string> = { ok: "Healthy", warn: "Getting quiet", bad: "Neglected", none: "No contact yet" };

export function ClientList({
  clients, projects, projectTypes, onNew, onOpen, onDelete, usage, units, loaded = true, colsSignal = 0, linesRev = 0, toolsSlot = null,
}: {
  /** Where the search, filters, sort and layout switch go (the page's dark header); in the list itself when not given. */
  toolsSlot?: HTMLElement | null;
  /** Changes when a client's signed products change (one deleted in its popup): the figures are read again. */
  linesRev?: number;
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
      // The clients' companies, plus the companies named like a client (its "twin" when the two
      // aren't linked), so a client can also be found by the company's other name (common or legal).
      // Only those are read — never the whole directory (it can be hundreds of thousands).
      const cos: Record<string, any> = {};
      const allCos: any[] = [];
      const COLS = "id, name, legal_name, vat_number, city, province, country, sector, website";
      const linkedIds = [...new Set(Object.values(coOf))];
      const firstWord = (n: string) => (n ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/)[0] ?? "";
      const stems = [...new Set(clients.map((c) => firstWord(c.name)).filter((w) => w.length >= 3))];
      const parts = await Promise.all([
        ...Array.from({ length: Math.ceil(linkedIds.length / 150) }, (_, i) => linkedIds.slice(i * 150, i * 150 + 150))
          .map((ids) => Promise.resolve(supabase.from("companies").select(COLS).in("id", ids)).then((r: any) => (r.data ?? []) as any[])),
        ...Array.from({ length: Math.ceil(stems.length / 40) }, (_, i) => stems.slice(i * 40, i * 40 + 40))
          .map((ws) => Promise.resolve(supabase.from("companies").select(COLS).or(ws.map((w) => `name.ilike.${w}*,legal_name.ilike.${w}*`).join(",")).limit(2000)).then((r: any) => (r.data ?? []) as any[])),
      ]).catch(() => [] as any[][]);
      parts.flat().forEach((x) => { if (!cos[x.id]) { cos[x.id] = x; allCos.push(x); } });
      const co: Record<string, any> = {};
      Object.entries(coOf).forEach(([cid, coid]) => { if (cos[coid]) co[cid] = cos[coid]; });
      const allLines = ((cp.data ?? []) as any[]).map((r) => ({ ...r, name: pn[r.product_id] ?? "Product" }));
      if (alive) setExtra({ lines: allLines, last, tasks, co, cos: allCos });
      // subscriptions that have ended go back to Sales, as a deal in the renewal pipeline
      void ensureRenewalDeals(allLines, coOf, Object.fromEntries(clients.map((c) => [c.id, c.name])));
    })().catch(() => setExtra({ lines: [], last: {}, tasks: {}, co: {}, cos: [] }));
    return () => { alive = false; };
  }, [loaded, clients.length, linesRev]);

  const typeName = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "No service";
  /** Clients that look like the same one (same CRM company, or the same name once accents / legal form are dropped). */
  const dupOf = useMemo(() => {
    const key = (n: string) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
      .replace(/\s(s\s?l\s?u?|s\s?a\s?u?|slp|sll|sccl|scp|cb|ab|gmbh|ltd|llc|inc|bv|srl|spa|sas|sarl|plc|ag|nv)$/, "").trim();
    const groups = new Map<string, Client[]>();
    const add = (k: string, c: Client) => { if (!k) return; const l = groups.get(k) ?? []; if (!l.includes(c)) l.push(c); groups.set(k, l); };
    clients.forEach((c) => { add(`n:${key(c.name)}`, c); const co = extra?.co[c.id]; if (co?.id) add(`c:${co.id}`, c); });
    const out = new Map<string, string>();
    groups.forEach((l) => { if (l.length > 1) l.forEach((c) => { if (!out.has(c.id)) out.set(c.id, l.filter((x) => x.id !== c.id).map((x) => x.name).join(", ")); }); });
    return out;
  }, [clients, extra]);
  const rows = useMemo<ClientRow[]>(() => clients.map((c) => {
    const mine = projects.filter((p) => p.clientId === c.id);
    const open = mine.filter((p) => p.status !== "closed");
    const ls = (extra?.lines ?? []).filter((l) => l.client_id === c.id);
    const act = ls.filter(isActive);
    const renew = act.map(termOf).filter((t): t is NonNullable<ReturnType<typeof termOf>> => !!t && t.left >= 0).sort((a, b) => a.end.getTime() - b.end.getTime())[0];
    const signedAt = [...mine.map((p) => p.signingDate), ...ls.map((l) => l.signing_date)].filter(Boolean).sort()[0] ?? null;
    const last = extra?.last[c.id] ?? null;
    const days = last ? Math.max(0, Math.floor((Date.now() - new Date(last).getTime()) / 864e5)) : null;
    const signed = mine.reduce((t, p) => t + signedOf(p), 0);
    const used = mine.reduce((t, p) => t + (usage[p.id]?.done ?? 0), 0);
    const lastP = mine[mine.length - 1];
    const co = extra?.co[c.id] ?? {};
    const twinSite = !co.website ? (extra?.cos ?? []).find((x) => x.website && bareName(x.name) === bareName(c.name))?.website : "";
    return {
      c, name: c.name, website: co.website || twinSite || "", dupOf: dupOf.get(c.id) ?? null,
      services: [...new Set(mine.map((p) => typeName(p.projectTypeId)))],
      consultants: [...new Set(mine.flatMap((p) => (p.team ?? []).map((m) => m.userId).filter(Boolean)))] as string[],
      city: co.city || lastP?.address?.city || "", country: countryLabel(co.country || lastP?.address?.country || ""), sector: co.sector || "",
      projects: mine.length, openProjects: open.length,
      projectsValue: mine.reduce((t, p) => t + projectValue(p), 0), openValue: open.reduce((t, p) => t + projectValue(p), 0),
      signed, used, delivered: signed > 0 ? Math.min(100, Math.round((used / signed) * 100)) : 0,
      recurring: act.reduce((t, l) => t + lineAnnual(l), 0), contract: act.reduce((t, l) => t + lineContractValue(l), 0),
      oneTime: ls.reduce((t, l) => t + lineOneTime(l), 0),
      products: [...new Set(act.map((l) => l.name))], activeProducts: act.length,
      nextRenewal: renew ? renew.end.toISOString().slice(0, 10) : null, firstSigned: signedAt,
      lastContact: last, daysSince: days, health: days == null ? "none" : days > 60 ? "bad" : days > 30 ? "warn" : "ok",
      openTasks: extra?.tasks[c.id]?.open ?? 0, lateTasks: extra?.tasks[c.id]?.late ?? 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [clients, projects, extra, usage, projectTypes, dupOf]);

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

  if (!loaded || !prefsReady || (clients.length > 0 && !extra)) return <PageLoader label="Loading clients…" />;
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

  const tools = (
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
  );
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
        {toolsSlot ? createPortal(tools, toolsSlot) : tools}
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
                <div className="cx-table" style={{ ["--cols" as any]: `minmax(200px, 1.8fr) ${colFields.map((f) => (f.type === "multi" ? "minmax(150px, 1.3fr)" : "minmax(96px, 1fr)")).join(" ")} 56px`, minWidth: 300 + colFields.length * 115 }}>
                  <div className="cx-tr is-head">
                    <span><SortHead label="Client" k="name" sort={view.sort} onSort={onSortHead} /></span>
                    {colFields.map((f) => {
                      const full = f.label.replace(/ \(.*\)$/, "");
                      const short = HEAD_SHORT[f.key];
                      return (
                        <span key={f.key} className={f.type === "number" ? "is-num" : ""} title={full}>
                          <SortHead label={<><span className={`cx-h-full ${short ? "has-short" : ""}`}>{full}</span>{short && <span className="cx-h-short">{short}</span>}</>} k={f.key} sort={view.sort} onSort={onSortHead} />
                        </span>
                      );
                    })}
                    <span />
                  </div>
                  {shown.map((r, i) => (
                    <div className="cx-tr" key={r.c.id} role="button" tabIndex={0} style={{ ["--i" as any]: Math.min(i, 16) }}
                      onClick={() => onOpen(r.c)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(r.c); }}>
                      <span className="cx-td-name">
                        <CompanyLogo className="cx-av is-sm" name={r.name} website={r.website} />
                        <span className="cx-id"><b title={r.name}>{r.name}</b>{(r.dupOf || r.city || r.sector) && <small>{r.dupOf && <i className="cx-dup" title={`Looks like the same client as: ${r.dupOf}`}>Duplicate?</i>}{[r.city, r.sector].filter(Boolean).join(" · ")}</small>}</span>
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
                      <CompanyLogo className="cx-av" name={c.name} website={r.website} />
                      <span className="cx-id">
                        <b>{c.name}</b>
                        <small>{r.dupOf && <i className="cx-dup" title={`Looks like the same client as: ${r.dupOf}`}>Duplicate?</i>}{[r.city, r.sector].filter(Boolean).join(" · ") || (r.dupOf ? "" : "No details yet")}</small>
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


/* The dark header floats as a rounded card (index.css: .fh). The card is sized to the header + figures
   (they change height with the data, the tab and the width) and a soft glow follows the pointer over it. */
export function useFloatingHero(ref: { current: HTMLElement | null }, sel: string) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const rt = root.getBoundingClientRect();
      let bottom = 0;
      root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height > 0) bottom = Math.max(bottom, r.bottom - rt.top + root.scrollTop);
      });
      root.style.setProperty("--fh-h", `${Math.max(0, Math.round(bottom - 22))}px`);
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(measure); };
    const ro = new ResizeObserver(queue);
    const watch = () => { ro.observe(root); root.querySelectorAll<HTMLElement>(sel).forEach((el) => ro.observe(el)); };
    watch(); measure();
    const mo = new MutationObserver(() => { watch(); queue(); });
    mo.observe(root, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  });
}
export function fhMove(e: { clientX: number; clientY: number; currentTarget: HTMLElement; pointerType?: string }) {
  if (e.pointerType && e.pointerType !== "mouse") return;
  const root = e.currentTarget;
  const r = root.getBoundingClientRect();
  const x = e.clientX - r.left - 14, y = e.clientY - r.top + root.scrollTop - 12;
  const h = parseFloat(root.style.getPropertyValue("--fh-h")) || 0;
  root.style.setProperty("--fh-x", `${Math.round(x)}px`);
  root.style.setProperty("--fh-y", `${Math.round(y)}px`);
  root.style.setProperty("--fh-on", x >= 0 && y >= 0 && y <= h && x <= r.width - 28 ? "1" : "0");
}
export const fhLeave = (e: { currentTarget: HTMLElement }) => e.currentTarget.style.setProperty("--fh-on", "0");

export default function ClientsPage() {
  const fhRef = useRef<HTMLDivElement>(null);
  useFloatingHero(fhRef, ".cl-bar, .cx-kpis");
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null);
  const d = useClientsData();
  /** Bumped when a client's signed products change in its popup, so the list's figures follow. */
  const [linesRev, setLinesRev] = useState(0);
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

  /** Arriving with ?client=… (global search, a ticket's link) opens that client. */
  const askedClient = useRef<string | null>(new URLSearchParams(window.location.search).get("client"));
  useEffect(() => {
    const id = askedClient.current;
    if (!id || !loaded) return;
    const c = clients.find((x) => x.id === id);
    if (c) { askedClient.current = null; setDetailClient(c); }
  }, [loaded, clients, setDetailClient]);

  /** One row per project (a client without projects gets one row) — the same columns the importer reads. */
  const exportClients = () => {
    const svc = (id: string) => projectTypes.find((t) => t.id === id)?.name ?? "";
    const date = (s: string) => (s ? { date: s.slice(0, 10) } : null);
    const rows: ExportCell[][] = [];
    [...clients].sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => {
      const ps = projects.filter((p) => p.clientId === c.id);
      if (!ps.length) { rows.push([c.name, ...Array(29).fill(null)]); return; }
      const legacy = legacyRoleMap(roles);
      ps.forEach((p) => {
        const ct = p.contacts?.find((x) => x.billing) ?? p.contacts?.[0];
        const u = usage[p.id] ?? { planned: 0, done: 0 };
        // The importer reads the three classic columns: the supervision role,
        // the roles that don't count (connector) and the rest as consultancy.
        const lines = resolvedLinesOf(p, legacy);
        const sup = lines.filter((l) => l.roleId === legacy.supervision);
        const conn = lines.filter((l) => l.roleId !== legacy.supervision && !roleCounts(l.roleId, roles));
        const cons = lines.filter((l) => !sup.includes(l) && !conn.includes(l));
        const days = (ls: typeof lines) => ls.reduce((t, l) => t + l.days, 0);
        const avg = (ls: typeof lines) => (days(ls) > 0 ? Math.round((ls.reduce((t, l) => t + l.days * lineRate(l), 0) / days(ls)) * 100) / 100 : ls[0] ? lineRate(ls[0]) : 0);
        const rate = avg(cons.length ? cons : conn);
        const roleText = lines.map((l) => `${roleNameOf(l.roleId, roles)}: ${l.days}d × ${Math.round(lineRate(l) * 100) / 100}€`).join("; ");
        rows.push([
          c.name, p.legalName || null, p.vatNumber || null,
          p.address?.street || null, p.address?.number || null, p.address?.postalCode || null, p.address?.city || null, p.address?.country || null,
          ct?.name || null, ct?.email || null, ct?.phone || null, ct?.position || null,
          svc(p.projectTypeId) || null, PROJECT_STATUS_LABEL[projectStatusOf(p.status)],
          date(p.signingDate), date(p.kickoffDate), date(p.endDate),
          days(cons), days(conn), rate, days(sup), sup.length ? avg(sup) : null,
          null, p.discountMode === "total" ? p.discountValue : null,
          p.taxed ? p.taxRate : null, p.paymentDays || null,
          Math.round(projectValue(p) * 100) / 100, Math.round(u.done * 100) / 100, Math.round(u.planned * 100) / 100,
          roleText || null,
        ]);
      });
    });
    const cols: [string, "text" | "number" | "money" | "date" | "percent"][] = [
      ["Client", "text"], ["Legal name", "text"], ["VAT", "text"], ["Street", "text"], ["Number", "text"], ["Postal code", "text"], ["City", "text"], ["Country", "text"],
      ["Contact", "text"], ["Contact email", "text"], ["Contact phone", "text"], ["Position", "text"], ["Service", "text"], ["Status", "text"],
      ["Signing date", "date"], ["Kick-off", "date"], ["End date", "date"], ["Consultancy days", "number"], ["Connector days", "number"], ["Price per day", "money"],
      ["Supervision days", "number"], ["Supervision price", "money"], ["Discount %", "number"], ["Discount total", "money"], ["Tax rate", "number"], ["Payment days", "number"],
      ["Value", "money"], ["Used days", "number"], ["Booked days", "number"], ["Roles", "text"],
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
    <div className="cl cl-ov fh" ref={fhRef} onPointerMove={fhMove} onPointerLeave={fhLeave}>
      <header className="cl-bar">
        <div className="cl-bar-left">
          <div>
            <h1 className="cl-title">Clients</h1>
            <p className="cx-sub">{clients.length} client{clients.length === 1 ? "" : "s"} · {projects.filter((p) => projectStatusOf(p.status) === "open").length} open project{projects.filter((p) => projectStatusOf(p.status) === "open").length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div className="cl-bar-tools" ref={setToolsSlot} />
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
        linesRev={linesRev}
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
        toolsSlot={toolsSlot}
      />

      {detailClient && (
        <ClientWorkspace
          client={detailClient}
          projects={projects.filter((p) => p.clientId === detailClient.id)}
          projectTypes={projectTypes}
          usage={usage}
          roles={roles}
          onOpenProject={(p) => setEditing({ client: detailClient, project: p })}
          onNewProject={() => openNewProject(detailClient)}
          onDeleteProject={deleteProject}
          onLinesChanged={() => setLinesRev((n) => n + 1)}
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
/* ============================================================================
   CUSTOMER SUCCESS — retention, health, renewals and expansion (/success)
   ============================================================================ */
const CSI: Record<string, string> = {
  heart: "M12 20.5s-7.5-4.4-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.8-7.5 10.2-7.5 10.2z",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z",
  task: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  cal: "M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM16 2v4M8 2v4M3 10h18",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  cols: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  repeat: "m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z",
  bolt: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  trend: "M23 6l-9.5 9.5-5-5L1 18M17 6h6v6",
  down: "M23 18l-9.5-9.5-5 5L1 6M17 18h6v-6",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  check: "M20 6 9 17l-5-5",
  arrow: "M5 12h14M13 6l6 6-6 6",
  euro: "M4 10h12M4 14h9M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2",
  play: "M5 3l14 9-14 9z",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  pin: "M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
};
const CsIco = ({ n, s = 16 }: { n: keyof typeof CSI; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={CSI[n]} /></svg>
);
const csMoney = (n: number) => `${n < 0 ? "−" : ""}€${String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
const csShort = (n: number) => (Math.abs(n) >= 1e6 ? `€${(n / 1e6).toFixed(2).replace(".", ",")}M` : Math.abs(n) >= 1e4 ? `€${Math.round(n / 1000)}k` : csMoney(n));
const csDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const csInitials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const todayIso = () => new Date().toISOString().slice(0, 10);
const UPS_TONE: Record<string, string> = { idea: "slate", planned: "teal", contacted: "blue", proposal: "gold", won: "jade", lost: "coral" };
const HEALTH_TONE: Record<CsHealthStatus, string> = { green: "Healthy", amber: "Watch", red: "At risk" };

/** Everything the CS page and the per-client upsells need from the catalogue and the team. */
function useCsCatalog() {
  const [products, setProducts] = useState<CatProduct[]>([]);
  const [services, setServices] = useState<CatService[]>([]);
  const [people, setPeople] = useState<Employee[]>([]);
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => {
    loadProducts().then((xs) => setProducts(xs.filter((p) => p.active !== false))).catch(() => {});
    loadServices().then((xs) => setServices(xs.filter((s) => s.active !== false))).catch(() => {});
    listEmployees().then(setPeople).catch(() => {});
    supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null));
  }, []);
  return { products, services, people, me };
}
type CsCatalog = ReturnType<typeof useCsCatalog>;

function CsAvatar({ name, tone = 0, size = 26, title }: { name: string; tone?: number; size?: number; title?: string }) {
  return <span className={`csx-av is-t${tone % 5}`} style={{ width: size, height: size, fontSize: size * 0.38 }} title={title ?? name}>{csInitials(name)}</span>;
}

/* ---------- the upsell editor (shared by the page and the client popup) ---------- */
function UpsellEditor({ initial, clientName, cat, onClose, onSaved, onDeleted }: {
  initial: Partial<CsUpsell> & { client_id: string };
  clientName: string; cat: CsCatalog;
  onClose: () => void; onSaved: (u: CsUpsell) => void; onDeleted?: (id: string) => void;
}) {
  const [u, setU] = useState<Partial<CsUpsell> & { client_id: string }>({ kind: "product", status: "idea", est_value: 0, ...initial });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [askDel, setAskDel] = useState(false);
  const nav = useNavigate();
  const set = (p: Partial<CsUpsell>) => setU((x) => ({ ...x, ...p }));
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !askDel) onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose, askDel]);
  const tierOpts = cat.products.flatMap((p) => p.tiers.map((t) => ({ value: `${p.id}|${t.id}`, label: `${p.name} · ${t.name}`, hint: csMoney(t.price), price: t.price, name: `${p.name} ${t.name}` })));
  const itemValue = u.kind === "product" ? u.product_id ?? "" : u.kind === "service" ? u.service_id ?? "" : u.kind === "tier" ? (u.product_id && u.tier_id ? `${u.product_id}|${u.tier_id}` : "") : "";
  const pickItem = (v: string) => {
    if (u.kind === "product") {
      const p = cat.products.find((x) => x.id === v);
      const price = p?.tiers?.[0]?.price ?? 0;
      set({ product_id: v || null, tier_id: null, service_id: null, title: u.title?.trim() ? u.title : p?.name ?? "", est_value: u.est_value || price });
    } else if (u.kind === "service") {
      const sv = cat.services.find((x) => x.id === v);
      set({ service_id: v || null, product_id: null, tier_id: null, title: u.title?.trim() ? u.title : sv?.name ?? "" });
    } else if (u.kind === "tier") {
      const o = tierOpts.find((x) => x.value === v);
      const [pid, tid] = v.split("|");
      set({ product_id: pid || null, tier_id: tid || null, service_id: null, title: u.title?.trim() ? u.title : o ? `Upgrade to ${o.name}` : "", est_value: u.est_value || o?.price || 0 });
    }
  };
  const save = async () => {
    if (!u.title?.trim()) { setErr("Give it a name."); return; }
    setBusy(true); setErr(null);
    const r = await saveUpsell({ ...u, title: u.title! });
    setBusy(false);
    if (r.error || !r.upsell) { setErr(r.error); return; }
    onSaved(r.upsell); onClose();
  };
  const toDeal = async () => {
    if (!u.id) return;
    setBusy(true); setErr(null);
    const r = await convertUpsellToDeal(u as CsUpsell, clientName);
    setBusy(false);
    if (r.error || !r.dealId) { setErr(r.error ?? "Could not create the deal."); return; }
    onSaved({ ...(u as CsUpsell), deal_id: r.dealId, status: u.status === "idea" || u.status === "planned" ? "proposal" : (u.status as CsUpsell["status"]) });
    nav(`/sales?tracking=${r.dealId}`);
  };
  return createPortal(
    <div className="csx-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="csx-modal" role="dialog" aria-modal="true" aria-label="Upsell">
        <header className="csx-modal-h">
          <span className="csx-modal-ico"><CsIco n="trend" s={18} /></span>
          <div><span className="csx-eyebrow">{u.id ? "Upsell" : "New upsell"} · {clientName}</span><h3>{u.title?.trim() || "What could they buy next?"}</h3></div>
          <button type="button" className="csx-x" onClick={onClose} aria-label="Close"><CsIco n="x" /></button>
        </header>
        <div className="csx-modal-b">
          <div className="csx-seg" role="tablist">
            {([["product", "Product"], ["tier", "Higher tier"], ["service", "Service"], ["other", "Other"]] as const).map(([k, l]) => (
              <button key={k} type="button" className={u.kind === k ? "is-on" : ""} onClick={() => set({ kind: k, product_id: null, tier_id: null, service_id: null })}>{l}</button>
            ))}
          </div>
          {u.kind !== "other" && (
            <label className="csx-f">
              <span>{u.kind === "service" ? "Service" : u.kind === "tier" ? "Product tier" : "Product"}</span>
              <Select value={itemValue} onChange={pickItem} placeholder="Pick one…" searchable
                options={u.kind === "product" ? cat.products.map((p) => ({ value: p.id!, label: p.name, hint: p.kind }))
                  : u.kind === "service" ? cat.services.map((sv) => ({ value: sv.id!, label: sv.name }))
                  : tierOpts.map(({ value, label, hint }) => ({ value, label, hint }))} />
            </label>
          )}
          <label className="csx-f"><span>Name</span><input value={u.title ?? ""} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Move to Enterprise, add FP&A" /></label>
          <div className="csx-f-row">
            <label className="csx-f"><span>Estimated value / year</span><span className="csx-money"><input type="number" min={0} value={u.est_value ?? 0} onFocus={(e) => e.target.select()} onChange={(e) => set({ est_value: Number(e.target.value) || 0 })} /><em>€</em></span></label>
            <label className="csx-f"><span>Best moment to contact</span><input type="date" value={u.ideal_contact_date ?? ""} onChange={(e) => set({ ideal_contact_date: e.target.value || null })} /></label>
          </div>
          <div className="csx-f-row">
            <label className="csx-f"><span>Status</span>
              <Select value={u.status ?? "idea"} onChange={(v) => set({ status: v as CsUpsell["status"] })} options={UPSELL_STATUSES.map((x) => ({ value: x.key, label: x.label }))} />
            </label>
            <label className="csx-f"><span>Owner</span>
              <Select value={u.owner_id ?? ""} onChange={(v) => set({ owner_id: v || null })} placeholder="Nobody yet" searchable
                options={[{ value: "", label: "Nobody yet" }, ...cat.people.map((p) => ({ value: p.id, label: p.name }))]} />
            </label>
          </div>
          <label className="csx-f"><span>Notes</span><textarea rows={3} value={u.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="Why now, who to talk to, what they said…" /></label>
          {u.deal_id && <button type="button" className="csx-link" onClick={() => nav(`/sales?tracking=${u.deal_id}`)}><CsIco n="arrow" s={14} />Open its deal</button>}
          {err && <p className="csx-err">{err}</p>}
        </div>
        <footer className="csx-modal-f">
          {u.id && onDeleted && (askDel ? (
            <span className="csx-ask">Delete it?
              <button type="button" className="is-yes" onClick={async () => { const e = await deleteUpsell(u.id!); if (e) { setErr(e); return; } onDeleted(u.id!); onClose(); }}>Delete</button>
              <button type="button" onClick={() => setAskDel(false)}>Keep</button></span>
          ) : <button type="button" className="csx-ghost is-danger" onClick={() => setAskDel(true)}><CsIco n="trash" s={14} />Delete</button>)}
          <span className="csx-sp" />
          {u.id && !u.deal_id && <button type="button" className="csx-ghost" disabled={busy} onClick={toDeal}><CsIco n="bolt" s={14} />Create deal</button>}
          <button type="button" className="csx-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="csx-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : u.id ? "Save" : "Add upsell"}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function UpsellCard({ u, clientName, ownerName, onOpen, i = 0 }: { u: CsUpsell; clientName?: string; ownerName?: string; onOpen: () => void; i?: number }) {
  const late = u.ideal_contact_date && u.ideal_contact_date < todayIso() && !["won", "lost"].includes(u.status);
  return (
    <button type="button" className={`csx-up is-${UPS_TONE[u.status]}`} onClick={onOpen} style={{ ["--i" as any]: i }}>
      {clientName && <span className="csx-up-client">{clientName}</span>}
      <b>{u.title}</b>
      <span className="csx-up-meta">
        <em>{csShort(u.est_value)}/yr</em>
        {u.ideal_contact_date && <span className={late ? "is-late" : ""}><CsIco n="cal" s={11} />{csDate(u.ideal_contact_date)}</span>}
        {ownerName && <CsAvatar name={ownerName} size={20} />}
        {u.deal_id && <span className="csx-up-deal">Deal</span>}
      </span>
    </button>
  );
}

/* ---------- per-client upsells (a section of the client popup) ---------- */
export function ClientUpsells({ clientId, clientName }: { clientId: string; clientName?: string }) {
  const cat = useCsCatalog();
  const [list, setList] = useState<CsUpsell[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [edit, setEdit] = useState<(Partial<CsUpsell> & { client_id: string }) | null>(null);
  useEffect(() => {
    let alive = true;
    supabase.from("client_upsells").select("*").eq("client_id", clientId).order("created_at", { ascending: false }).then(({ data, error }) => {
      if (!alive) return;
      if (error) { setMissing(true); setList([]); return; }
      setList(((data ?? []) as any[]).map((u) => ({ ...u, est_value: Number(u.est_value) || 0 })));
    });
    return () => { alive = false; };
  }, [clientId]);
  const name = clientName ?? "This client";
  const open = (list ?? []).filter((u) => !["won", "lost"].includes(u.status));
  const won = (list ?? []).filter((u) => u.status === "won");
  const personName = (id: string | null) => (id ? cat.people.find((p) => p.id === id)?.name : undefined);
  const upsert = (u: CsUpsell) => setList((xs) => (xs ?? []).some((x) => x.id === u.id) ? (xs ?? []).map((x) => x.id === u.id ? u : x) : [u, ...(xs ?? [])]);
  return (
    <div className="csx-cu">
      <div className="csx-cu-top">
        <div className="csx-cu-figs">
          <span><em>Open pipeline</em><b>{csMoney(open.reduce((t, u) => t + u.est_value, 0))}</b><i>{open.length} upsell{open.length === 1 ? "" : "s"} · per year</i></span>
          <span><em>Won</em><b className="is-jade">{csMoney(won.reduce((t, u) => t + u.est_value, 0))}</b><i>{won.length} so far</i></span>
          <span><em>Next moment</em><b>{open.filter((u) => u.ideal_contact_date).sort((a, b) => a.ideal_contact_date!.localeCompare(b.ideal_contact_date!))[0]?.ideal_contact_date ? csDate(open.filter((u) => u.ideal_contact_date).sort((a, b) => a.ideal_contact_date!.localeCompare(b.ideal_contact_date!))[0].ideal_contact_date) : "—"}</b><i>best time to call</i></span>
        </div>
        <button type="button" className="csx-primary" disabled={missing} onClick={() => setEdit({ client_id: clientId, kind: "product", status: "idea" })}><CsIco n="plus" s={14} />New upsell</button>
      </div>
      {missing ? <CsLocked what="Upsell planning" /> : list == null ? <div className="csx-cu-load"><span /><span /><span /></div> : list.length === 0 ? (
        <button type="button" className="csx-empty" onClick={() => setEdit({ client_id: clientId, kind: "product", status: "idea" })}>
          <span className="csx-empty-ico"><CsIco n="trend" s={22} /></span>
          <b>No upsells yet</b><i>Note what {name} could buy next — a higher tier, another product, more services — and when to bring it up.</i>
        </button>
      ) : (
        <div className="csx-cu-board">
          {UPSELL_STATUSES.map((st) => {
            const xs = (list ?? []).filter((u) => u.status === st.key);
            if (!xs.length && (st.key === "lost" || st.key === "won")) return null;
            return (
              <div key={st.key} className={`csx-col is-${UPS_TONE[st.key]}`}>
                <div className="csx-col-h"><i />{st.label}<em>{xs.length}</em></div>
                {xs.map((u, i) => <UpsellCard key={u.id} u={u} i={i} ownerName={personName(u.owner_id)} onOpen={() => setEdit(u)} />)}
              </div>
            );
          })}
        </div>
      )}
      {edit && <UpsellEditor initial={edit} clientName={name} cat={cat} onClose={() => setEdit(null)} onSaved={upsert}
        onDeleted={(id) => setList((xs) => (xs ?? []).filter((x) => x.id !== id))} />}
    </div>
  );
}

/* ---------- the page ---------- */
interface CsLog { client_id: string; contacted_at: string; reason: string | null; channel: string | null; contact_name?: string | null }
interface CsClient {
  id: string; name: string; website: string;
  arr: number; lines: Line[];
  last: string | null; lastWhy: string | null; days: number | null;
  owners: string[]; primary: string | null;
  /** days since the last contact / the client's cadence (Infinity when never contacted) */
  ratio: number; cadence: number;
  health: CsHealthStatus | null;
  ren: { end: Date; left: number; value: number; auto: boolean } | null;
  ups: number; upsValue: number;
  /** what needs doing first, highest first */
  score: number;
}
type CsTab = "accounts" | "upsells" | "qbr" | "revenue";
type CsFilter = "all" | "contact" | "risk" | "renew" | "orphan" | "upsell";
type CsSort = "priority" | "contact" | "arr" | "renewal" | "name";
const CH_ICON: Record<string, keyof typeof CSI> = { call: "phone", email: "mail", meeting: "users", visit: "pin" };
const csAgo = (days: number | null) => (days == null ? "Never" : days === 0 ? "Today" : days === 1 ? "Yesterday" : days < 90 ? `${days} days ago` : days < 365 ? `${Math.round(days / 30)} months ago` : `${(days / 365).toFixed(1).replace(".", ",")} yr ago`);
const csPct = (n: number) => `${n.toFixed(1).replace(".", ",")}%`;

function CsPanel({ icon, title, sub, tone = "jade", right, children, className = "", i = 0 }: {
  icon: keyof typeof CSI; title: string; sub?: string; tone?: string; right?: ReactNode; children: ReactNode; className?: string; i?: number;
}) {
  return (
    <section className={`csx-panel ${className}`} style={{ ["--i" as any]: i }}>
      <header className="csx-panel-h">
        <span className={`csx-panel-ico is-${tone}`}><CsIco n={icon} s={17} /></span>
        <div className="csx-panel-t"><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
        {right && <div className="csx-panel-r">{right}</div>}
      </header>
      <div className="csx-panel-b">{children}</div>
    </section>
  );
}

/** A section that needs the customer-success tables (17_customer_success.sql) before it can work. */
function CsLocked({ what }: { what: string }) {
  return (
    <div className="csx-locked">
      <span className="csx-locked-ico"><CsIco n="lock" s={16} /></span>
      <div><b>{what} switches on with the customer-success tables</b><span>Run <code>17_customer_success.sql</code> in Supabase, then reload this page.</span></div>
    </div>
  );
}

/** A small titled block inside the side panel. */
function CsBlock({ icon, title, right, children, tone = "jade" }: { icon: keyof typeof CSI; title: string; right?: ReactNode; children: ReactNode; tone?: string }) {
  return (
    <section className="cs3-block">
      <header><span className={`cs3-block-ico is-${tone}`}><CsIco n={icon} s={13} /></span><h4>{title}</h4>{right && <span className="cs3-block-r">{right}</span>}</header>
      {children}
    </section>
  );
}

/** Contact bar: how much of the cadence has gone by since the last contact. */
function CsCadence({ c, wide = false }: { c: CsClient; wide?: boolean }) {
  const late = c.days == null || c.days > c.cadence;
  const soon = !late && (c.days ?? 0) > c.cadence * 0.75;
  return (
    <span className={`cs3-cad ${late ? "is-late" : soon ? "is-soon" : ""} ${wide ? "is-wide" : ""}`} title={`Cadence: every ${c.cadence} days`}>
      <span className="cs3-cad-t"><b>{csAgo(c.days)}</b>{c.lastWhy && wide ? <i>{c.lastWhy}</i> : null}</span>
      <span className="cs3-cad-bar"><span style={{ width: `${Math.min(100, ((c.days ?? c.cadence * 2) / c.cadence) * 100)}%` }} /></span>
    </span>
  );
}

export function CustomerSuccessPage() {
  const cat = useCsCatalog();
  const nav = useNavigate();
  const [cs, setCs] = useState<CsData | null>(null);
  const [base, setBase] = useState<{ clients: any[]; lines: Line[]; logs: CsLog[]; sites: Record<string, string> } | null>(null);
  const [scope, setScope] = useState<"mine" | "all">("all");
  const [owner, setOwner] = useState("");
  const [tab, setTab] = useState<CsTab>("accounts");
  useNavSection("/success", 0, (part) => { if (["accounts", "upsells", "qbr", "revenue"].includes(part)) setTab(part as CsTab); });
  const [filter, setFilter] = useState<CsFilter>("all");
  const [sort, setSort] = useState<CsSort>("priority");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [upView, setUpView] = useState<"pipeline" | "matrix">("pipeline");
  const [edit, setEdit] = useState<(Partial<CsUpsell> & { client_id: string }) | null>(null);
  const [logCh, setLogCh] = useState("call");
  const [logWhy, setLogWhy] = useState("");
  const [qbrNew, setQbrNew] = useState<{ client: string; date: string }>({ client: "", date: "" });
  const [qbrDate, setQbrDate] = useState("");
  const [evNew, setEvNew] = useState<{ client: string; kind: RevenueEvent["kind"]; amount: number; date: string; reason: string } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkOwner, setBulkOwner] = useState("");
  const [ownPick, setOwnPick] = useState(false);
  const [autoAt, setAutoAt] = useState<{ top: number; left: number } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const year = new Date().getFullYear();
  const say = (m: string) => { setFlash(m); window.setTimeout(() => setFlash((x) => (x === m ? null : x)), 3200); };

  const reload = async () => setCs(await loadCsData());
  useEffect(() => {
    let alive = true;
    (async () => {
      const [cl, cp, pr, lg] = await Promise.all([
        supabase.from("clients").select("id, name, company_id").order("name"),
        supabase.from("client_products").select("*"),
        supabase.from("products").select("id, name"),
        supabase.from("client_contacts_log").select("client_id, contacted_at, reason, channel, contact_name"),
      ]);
      // websites (logos) of the clients' own companies only — not the whole directory
      const coIds = [...new Set(((cl.data ?? []) as any[]).map((x) => x.company_id).filter(Boolean))] as string[];
      const coRows = (await Promise.all(Array.from({ length: Math.ceil(coIds.length / 150) }, (_, i) => coIds.slice(i * 150, i * 150 + 150))
        .map((ids) => Promise.resolve(supabase.from("companies").select("id, website").in("id", ids)).then((r: any) => (r.data ?? []) as any[]))).catch(() => [] as any[][])).flat();
      const co = { data: coRows };
      const pn: Record<string, string> = {};
      ((pr.data ?? []) as any[]).forEach((x) => { pn[x.id] = x.name; });
      const sites: Record<string, string> = {};
      ((co.data ?? []) as any[]).forEach((x) => { if (x.website) sites[x.id] = x.website; });
      // an older log table without contact_name: read it again without that column
      let logs = (lg.data ?? []) as CsLog[];
      if (lg.error) { const r2 = await supabase.from("client_contacts_log").select("client_id, contacted_at, reason, channel"); logs = (r2.data ?? []) as CsLog[]; }
      if (alive) setBase({ clients: (cl.data ?? []) as any[], lines: ((cp.data ?? []) as any[]).map((r) => ({ ...r, name: pn[r.product_id] ?? "Product" })), logs, sites });
      const d = await loadCsData();
      if (!alive) return;
      setCs(d);
      // automatic follow-ups: once per session, when they're on
      if (d.ready && d.settings.auto_tasks) {
        let done = false;
        try { done = sessionStorage.getItem("cs-auto-tasks") === todayIso(); } catch { /* private mode */ }
        if (!done) {
          const n = await generateContactTasks();
          try { sessionStorage.setItem("cs-auto-tasks", todayIso()); } catch { /* ignore */ }
          if (alive && n) say(`${n} follow-up${n === 1 ? "" : "s"} created for clients past their contact cadence`);
        }
      }
    })().catch(() => setBase({ clients: [], lines: [], logs: [], sites: {} }));
    return () => { alive = false; };
  }, []);

  const pName = (id: string | null | undefined) => (id ? cat.people.find((p) => p.id === id)?.name ?? "Someone" : "");
  const pTone = (id: string) => Math.abs([...id].reduce((t, c) => t + c.charCodeAt(0), 0));
  const healthOf = (id: string) => cs?.health.find((h) => h.client_id === id) ?? null;

  const all: CsClient[] = useMemo(() => {
    if (!base) return [];
    const now = Date.now();
    return base.clients.map((c) => {
      const ls = base.lines.filter((l) => l.client_id === c.id);
      const logs = base.logs.filter((l) => l.client_id === c.id).sort((a, b) => String(b.contacted_at).localeCompare(String(a.contacted_at)));
      const last = logs[0]?.contacted_at ?? null;
      const own = (cs?.owners ?? []).filter((o) => o.client_id === c.id).sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
      const days = last ? Math.max(0, Math.floor((now - new Date(last).getTime()) / 864e5)) : null;
      const cad = cs?.cadence[c.id] ?? cs?.settings.default_cadence_days ?? 30;
      const ratio = days == null ? Infinity : days / cad;
      const health = cs?.health.find((h) => h.client_id === c.id)?.status ?? null;
      const rens = ls.filter(isActive).map((l) => ({ l, t: termOf(l) })).filter((x) => x.t && x.t.end.getTime() >= now).sort((a, b) => a.t!.end.getTime() - b.t!.end.getTime());
      const r0 = rens[0];
      const ups = (cs?.upsells ?? []).filter((u) => u.client_id === c.id && !["won", "lost"].includes(u.status));
      const arr = ls.filter(isActive).reduce((t, l) => t + (l.recurring ? lineAnnual(l) : 0), 0);
      const ren = r0 ? { end: r0.t!.end, left: r0.t!.left, value: lineAnnual(r0.l), auto: !!r0.l.auto_renew } : null;
      const score = (ratio === Infinity ? 3 : Math.min(3, ratio)) * 10
        + (health === "red" ? 30 : health === "amber" ? 14 : 0)
        + (ren && ren.left <= 90 ? 18 - ren.left / 6 : 0)
        + Math.min(8, arr / 10000);
      return {
        id: c.id, name: c.name, website: c.company_id ? base.sites[c.company_id] ?? "" : "",
        lines: ls, arr, last, lastWhy: logs[0]?.reason || logs[0]?.channel || null, days,
        owners: own.map((o) => o.profile_id), primary: own.find((o) => o.is_primary)?.profile_id ?? own[0]?.profile_id ?? null,
        ratio, cadence: cad, health, ren, ups: ups.length, upsValue: ups.reduce((t, u) => t + u.est_value, 0), score,
      };
    });
  }, [base, cs]);
  const clients = useMemo(() => all.filter((c) => {
    if (scope === "mine" && cat.me && !c.owners.includes(cat.me)) return false;
    if (owner && !c.owners.includes(owner)) return false;
    return true;
  }), [all, scope, owner, cat.me]);
  const ids = useMemo(() => new Set(clients.map((c) => c.id)), [clients]);
  const nameOf = (id: string | null) => all.find((c) => c.id === id)?.name ?? "—";
  const byId = (id: string | null) => all.find((c) => c.id === id) ?? null;

  // ---- KPIs ----
  const arrNow = clients.reduce((t, c) => t + c.arr, 0);
  const snap = cs?.snapshots.find((x) => x.year === year) ?? null;
  const filtered = scope !== "all" || !!owner;
  const initial = snap ? (filtered ? Object.entries(snap.by_client).reduce((t, [k, v]) => t + (ids.has(k) ? Number(v) || 0 : 0), 0) : snap.initial_arr) : 0;
  const evs = (cs?.events ?? []).filter((e) => e.event_date.startsWith(String(year)) && (!e.client_id || ids.has(e.client_id) || !filtered));
  const sumK = (k: RevenueEvent["kind"]) => evs.filter((e) => e.kind === k).reduce((t, e) => t + e.amount, 0);
  const expansion = sumK("expansion"), contraction = sumK("contraction"), churn = sumK("churn");
  const nrr = initial > 0 ? ((initial + expansion - contraction - churn) / initial) * 100 : null;
  const churnRate = initial > 0 ? (churn / initial) * 100 : null;
  const growth = initial > 0 ? ((arrNow - initial) / initial) * 100 : null;
  const freeze = async () => {
    const by: Record<string, number> = {};
    all.forEach((c) => { if (c.arr) by[c.id] = Math.round(c.arr * 100) / 100; });
    const e = await freezeArr(year, all.reduce((t, c) => t + c.arr, 0), by);
    if (e) { say(e); return; }
    say(`ARR frozen as the ${year} base`); reload();
  };

  // ---- hero pointer glow ----
  const glow = (e: RPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--gx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--gy", `${e.clientY - r.top}px`);
  };

  // ---- the account list ----
  const needsContact = (c: CsClient) => c.days == null || c.days > c.cadence;
  const atRisk = (c: CsClient) => c.health === "red" || c.health === "amber";
  const renewing = (c: CsClient) => !!c.ren && c.ren.left <= 90;
  const FILTERS: { key: CsFilter; label: string; test: (c: CsClient) => boolean; tone: string }[] = [
    { key: "all", label: "All accounts", test: () => true, tone: "slate" },
    { key: "contact", label: "Needs contact", test: needsContact, tone: "coral" },
    { key: "risk", label: "At risk", test: atRisk, tone: "gold" },
    { key: "renew", label: "Renewing in 90 d", test: renewing, tone: "teal" },
    { key: "upsell", label: "Open upsell", test: (c) => c.ups > 0, tone: "violet" },
    { key: "orphan", label: "No owner", test: (c) => ready && !c.owners.length, tone: "slate" },
  ];
  const fTest = FILTERS.find((f) => f.key === filter)?.test ?? (() => true);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const xs = clients.filter((c) => fTest(c) && (!s || c.name.toLowerCase().includes(s)));
    const cmp: Record<CsSort, (a: CsClient, b: CsClient) => number> = {
      priority: (a, b) => b.score - a.score,
      contact: (a, b) => b.ratio - a.ratio,
      arr: (a, b) => b.arr - a.arr,
      renewal: (a, b) => (a.ren?.left ?? 1e9) - (b.ren?.left ?? 1e9),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return [...xs].sort((a, b) => cmp[sort](a, b) || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, filter, sort, q]);
  const open = byId(openId);
  const overdue = clients.filter(needsContact);

  // the automation popover floats over the page (the hero clips its content); it closes on scroll / resize
  useEffect(() => {
    if (!autoAt) return;
    const close = () => setAutoAt(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [autoAt]);
  const toggleAutoPop = (el: HTMLElement) => {
    if (autoAt) { setAutoAt(null); return; }
    const r = el.getBoundingClientRect();
    setAutoAt({ top: r.bottom + 8, left: Math.max(8, Math.min(r.right - 300, window.innerWidth - 308)) });
  };

  // keyboard: "/" finds, Esc closes the account
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "/" && !typing && tab === "accounts") { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === "Escape" && !edit && openId && !typing) setOpenId(null);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [tab, openId, edit]);
  const rowKey = (e: RKeyboardEvent<HTMLDivElement>, id: string) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(id); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
      const i = rows.indexOf(e.currentTarget);
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    }
  };
  const openAccount = (id: string) => { setOpenId(id); setLogWhy(""); setLogCh("call"); setOwnPick(false); setQbrDate(""); };

  // ---- actions ----
  const doLog = async (id: string) => {
    const e = await logClientContact(id, { channel: logCh, reason: logWhy });
    if (e) { say(e); return; }
    const at = new Date().toISOString();
    setBase((b) => b ? { ...b, logs: [...b.logs, { client_id: id, contacted_at: at, reason: logWhy || null, channel: logCh }] } : b);
    setLogWhy(""); say(`Contact logged for ${nameOf(id)}`);
  };
  const quickLog = async (c: CsClient) => {
    const e = await logClientContact(c.id, { channel: "call", reason: null });
    if (e) { say(e); return; }
    setBase((b) => b ? { ...b, logs: [...b.logs, { client_id: c.id, contacted_at: new Date().toISOString(), reason: null, channel: "call" }] } : b);
    say(`Call logged for ${c.name}`);
  };
  const doTask = async (c: CsClient) => {
    const e = await createClientFollowUp(c.id, `Get in touch with ${c.name}${c.days == null ? " (no contact logged yet)" : ` (${c.days} days since last contact)`}`, c.primary ?? cat.me, `cs-contact:${c.id}`);
    say(e ?? `Follow-up added to ${c.primary ? `${pName(c.primary)}'s` : "your"} desk`);
  };
  const setHealth = async (id: string, patch: { status?: CsHealthStatus; reason?: string | null; note?: string | null }) => {
    const cur = healthOf(id);
    const next = { status: patch.status ?? cur?.status ?? "green", reason: patch.reason !== undefined ? patch.reason : cur?.reason ?? null, note: patch.note !== undefined ? patch.note : cur?.note ?? null };
    if (patch.reason && patch.status === undefined) next.status = CS_REASONS.find((r) => r.key === patch.reason)?.tone ?? next.status;
    setCs((d) => d ? { ...d, health: [...d.health.filter((h) => h.client_id !== id), { client_id: id, ...next, updated_at: new Date().toISOString(), updated_by: cat.me }] } : d);
    const e = await saveClientHealth(id, next);
    if (e) say(e);
  };
  const qbrs = (cs?.qbrs ?? []).filter((x) => ids.has(x.client_id) && x.status !== "cancelled").sort((a, b) => a.meeting_date.localeCompare(b.meeting_date));
  const putQbr = async (x: Partial<CsQbr> & { client_id: string; meeting_date: string }) => {
    const r = await saveQbr(x);
    if (r.error || !r.qbr) { say(r.error ?? "Not saved"); return; }
    setCs((d) => d ? { ...d, qbrs: [...d.qbrs.filter((y) => y.id !== r.qbr!.id), r.qbr!] } : d);
  };
  const dropQbr = async (id: string) => { const e = await deleteQbr(id); if (e) say(e); else setCs((d) => d ? { ...d, qbrs: d.qbrs.filter((x) => x.id !== id) } : d); };
  const in12 = Date.now() + 365 * 864e5;
  const renewals = clients.flatMap((c) => c.lines.filter(isActive).map((l) => ({ c, l, t: termOf(l) })))
    .filter((x) => x.t && x.t.end.getTime() >= Date.now() && x.t.end.getTime() <= in12)
    .sort((a, b) => a.t!.end.getTime() - b.t!.end.getTime());
  const upsells = (cs?.upsells ?? []).filter((u) => ids.has(u.client_id));
  const openUps = upsells.filter((u) => !["won", "lost"].includes(u.status));
  const upsert = (u: CsUpsell) => setCs((d) => d ? { ...d, upsells: d.upsells.some((x) => x.id === u.id) ? d.upsells.map((x) => x.id === u.id ? u : x) : [u, ...d.upsells] } : d);
  const items = [
    ...cat.products.map((p) => ({ key: `p:${p.id}`, kind: "product" as const, id: p.id!, name: p.name })),
    ...cat.services.map((sv) => ({ key: `s:${sv.id}`, kind: "service" as const, id: sv.id!, name: sv.name })),
  ];
  const matrixRows = clients.filter((c) => c.lines.length || upsells.some((u) => u.client_id === c.id) || c.arr > 0).slice(0, 80);
  const quickUpsell = async (c: CsClient, it: (typeof items)[number]) => {
    const r = await saveUpsell({ client_id: c.id, kind: it.kind, product_id: it.kind === "product" ? it.id : null, service_id: it.kind === "service" ? it.id : null, title: it.name, status: "idea", owner_id: c.primary });
    if (r.error || !r.upsell) { say(r.error ?? "Not saved"); return; }
    upsert(r.upsell); say(`${it.name} noted as an upsell for ${c.name}`);
  };
  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const assignBulk = async () => {
    if (!bulkOwner || !sel.size) return;
    for (const id of sel) {
      const c = all.find((x) => x.id === id);
      const lst = [...new Set([...(c?.owners ?? []), bulkOwner])];
      const e = await setClientOwners(id, lst, c?.primary ?? bulkOwner);
      if (e) { say(e); return; }
    }
    say(`${pName(bulkOwner)} now looks after ${sel.size} client${sel.size === 1 ? "" : "s"}`);
    setSel(new Set()); setBulkOwner(""); reload();
  };
  const toggleOwner = async (c: CsClient, pid: string) => {
    const on = c.owners.includes(pid);
    const lst = on ? c.owners.filter((x) => x !== pid) : [...c.owners, pid];
    const e = await setClientOwners(c.id, lst, on && c.primary === pid ? lst[0] ?? null : c.primary ?? pid);
    if (e) { say(e); return; }
    reload();
  };
  const makePrimary = async (c: CsClient, pid: string) => { const e = await setClientOwners(c.id, c.owners, pid); if (e) say(e); else reload(); };
  const saveDefaultCadence = async () => { if (!cs) return; const e = await saveCsSettings(cs.settings); if (e) say(e); else { say("Default cadence saved"); reload(); } };
  const toggleAuto = async () => { if (!cs) return; const s2 = { ...cs.settings, auto_tasks: !cs.settings.auto_tasks }; setCs({ ...cs, settings: s2 }); const e = await saveCsSettings(s2); if (e) say(e); else reload(); };
  const runNow = async () => { const n = await generateContactTasks(); say(n == null ? NEEDS_CS : n ? `${n} follow-up${n === 1 ? "" : "s"} created` : "Nobody needs a follow-up right now"); };

  const loading = !base || !cs;
  const notReady = !!cs && !cs.ready;
  const ready = !!cs?.ready;
  const TABS: { key: CsTab; label: string; icon: keyof typeof CSI; n?: number | string }[] = [
    { key: "accounts", label: "Accounts", icon: "users", n: clients.length },
    { key: "upsells", label: "Upsells", icon: "trend", n: openUps.length },
    { key: "qbr", label: "QBRs", icon: "cal", n: qbrs.filter((x) => x.status === "planned").length },
    { key: "revenue", label: `Revenue · ${year}`, icon: "euro", n: evs.length },
  ];

  /* ---------- the side panel: one account, everything about it ---------- */
  const accountPanel = (c: CsClient) => {
    const h = healthOf(c.id);
    const logs = (base?.logs ?? []).filter((l) => l.client_id === c.id).sort((a, b) => String(b.contacted_at).localeCompare(String(a.contacted_at)));
    const myUps = (cs?.upsells ?? []).filter((u) => u.client_id === c.id);
    const myQbrs = (cs?.qbrs ?? []).filter((x) => x.client_id === c.id && x.status !== "cancelled").sort((a, b) => a.meeting_date.localeCompare(b.meeting_date));
    const myEvs = (cs?.events ?? []).filter((e) => e.client_id === c.id);
    const lines = c.lines.filter(isActive);
    const late = needsContact(c);
    return (
      <div className="cs3-acc" key={c.id}>
        <header className="cs3-acc-h">
          <CompanyLogo name={c.name} website={c.website} className="cx-av csx-logo is-lg" />
          <div className="cs3-acc-t">
            <h3>{c.name}</h3>
            <span>{c.arr ? <><b>{csMoney(c.arr)}</b>/yr recurring</> : "No recurring products"}{c.ren ? ` · renews ${c.ren.end.toLocaleDateString("en-GB", { month: "short", year: "numeric" })}` : ""}</span>
          </div>
          <button type="button" className="csx-ghost is-sm" onClick={() => nav(`/clients?client=${c.id}`)} title="Open the client"><CsIco n="arrow" s={13} />Client</button>
          <button type="button" className="csx-x is-sm" onClick={() => setOpenId(null)} aria-label="Close (Esc)" title="Close (Esc)"><CsIco n="x" s={14} /></button>
        </header>

        <div className="cs3-acc-b">
          {/* health */}
          <CsBlock icon="heart" title="Health" tone={h?.status === "red" ? "coral" : h?.status === "amber" ? "gold" : "jade"}
            right={h ? <span className="cs3-muted">Updated {csDate(h.updated_at)}</span> : <span className="cs3-muted">Not tracked yet</span>}>
            {notReady ? <CsLocked what="Health tracking" /> : <>
              <div className="cs3-health" role="radiogroup" aria-label="Health">
                {(["green", "amber", "red"] as CsHealthStatus[]).map((st) => (
                  <button key={st} type="button" role="radio" aria-checked={h?.status === st} className={`is-${st} ${h?.status === st ? "is-on" : ""}`} onClick={() => setHealth(c.id, { status: st })}>
                    <i />{HEALTH_TONE[st]}
                  </button>
                ))}
              </div>
              <div className="cs3-health-r">
                <Select size="sm" value={h?.reason ?? ""} onChange={(v) => setHealth(c.id, { reason: v || null })} placeholder="Why?"
                  options={[{ value: "", label: "No reason" }, ...CS_REASONS.map((r) => ({ value: r.key, label: r.label }))]} />
                <input key={`${c.id}-${h?.note ?? ""}`} className="csx-inline is-box" defaultValue={h?.note ?? ""} placeholder="What's going on?"
                  onBlur={(e) => { if ((e.target.value || null) !== (h?.note ?? null)) setHealth(c.id, { note: e.target.value || null }); }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              </div>
            </>}
          </CsBlock>

          {/* contact */}
          <CsBlock icon="phone" title="Contact" tone={late ? "coral" : "jade"}
            right={<span className="cs3-cadin" title="Get in touch every … days (this client)">every
              <input type="number" min={1} key={`cad-${c.id}-${cs?.cadence[c.id] ?? ""}`} placeholder={String(cs?.settings.default_cadence_days ?? 30)} defaultValue={cs?.cadence[c.id] ?? ""} disabled={!ready}
                onBlur={async (e) => { const v = Number(e.target.value) || null; if (v === (cs?.cadence[c.id] ?? null)) return; const er = await setClientCadence(c.id, v); if (er) say(er); else { say(v ? `${c.name}: every ${v} days` : `${c.name} follows the default cadence`); reload(); } }} />days</span>}>
            <CsCadence c={c} wide />
            <div className="cs3-log">
              <span className="csx-chips">{["call", "email", "meeting", "visit"].map((ch) => <button key={ch} type="button" className={logCh === ch ? "is-on" : ""} onClick={() => setLogCh(ch)}><CsIco n={CH_ICON[ch]} s={11} />{ch}</button>)}</span>
              <div className="cs3-log-r">
                <input placeholder="What about? (optional)" value={logWhy} onChange={(e) => setLogWhy(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doLog(c.id); }} />
                <button type="button" className="csx-primary is-sm" onClick={() => doLog(c.id)}><CsIco n="check" s={12} />Log</button>
                <button type="button" className="csx-ghost is-sm" onClick={() => doTask(c)} title={`Add a follow-up to ${c.primary ? pName(c.primary) : "your"} desk`}><CsIco n="task" s={12} />Follow-up</button>
              </div>
            </div>
            {logs.length ? (
              <ol className="cs3-tl">
                {logs.slice(0, 6).map((l, i) => (
                  <li key={`${l.contacted_at}-${i}`}>
                    <span className="cs3-tl-ico"><CsIco n={CH_ICON[l.channel ?? ""] ?? "phone"} s={11} /></span>
                    <span className="cs3-tl-m"><b>{l.reason || (l.channel ? `${l.channel[0].toUpperCase()}${l.channel.slice(1)}` : "Contact")}</b>{l.contact_name ? <i>with {l.contact_name}</i> : null}</span>
                    <time>{csDate(l.contacted_at)}</time>
                  </li>
                ))}
                {logs.length > 6 && <li className="cs3-tl-more">+{logs.length - 6} earlier — see them in the client</li>}
              </ol>
            ) : <p className="cs3-empty">No contact logged yet. Log the first one above.</p>}
          </CsBlock>

          {/* owners */}
          <CsBlock icon="users" title="Owners" right={<span className="cs3-muted">★ gets the follow-ups</span>}>
            {notReady ? <CsLocked what="Client owners" /> : (
              <div className="csx-own-list">
                {c.owners.map((o) => (
                  <span key={o} className={`csx-own-chip ${c.primary === o ? "is-primary" : ""}`}>
                    <button type="button" className="csx-own-star" title={c.primary === o ? "Primary owner" : "Make primary"} onClick={() => makePrimary(c, o)}><CsIco n="star" s={11} /></button>
                    {pName(o)}
                    <button type="button" className="csx-own-x" title="Remove" onClick={() => toggleOwner(c, o)}><CsIco n="x" s={10} /></button>
                  </span>
                ))}
                {ownPick ? (
                  <span className="csx-own-pick">
                    <Select size="sm" value="" onChange={(v) => { if (v) { toggleOwner(c, v); setOwnPick(false); } }} placeholder="Pick someone…" searchable
                      options={cat.people.filter((p) => !c.owners.includes(p.id)).map((p) => ({ value: p.id, label: p.name }))} />
                  </span>
                ) : <button type="button" className="csx-own-add" onClick={() => setOwnPick(true)}><CsIco n="plus" s={11} />{c.owners.length ? "Owner" : "Assign an owner"}</button>}
              </div>
            )}
          </CsBlock>

          {/* products & renewals */}
          <CsBlock icon="repeat" title="Products & renewals" right={<span className="cs3-muted">{lines.length} active</span>}>
            {lines.length ? (
              <ul className="cs3-prods">
                {lines.map((l) => { const t = termOf(l); return (
                  <li key={l.id} className={t && t.left < 90 ? "is-soon" : ""}>
                    <span className="cs3-prods-m"><b>{l.name}</b><i>{l.recurring ? "recurring" : "one-off"}{t ? ` · ${l.auto_renew ? "renews" : "ends"} ${t.end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}</i></span>
                    {t && <em>{t.left} d</em>}
                    <b className="cs3-prods-v">{csMoney(l.recurring ? lineAnnual(l) : Number(l.price) || 0)}{l.recurring ? <small>/yr</small> : null}</b>
                  </li>
                ); })}
              </ul>
            ) : <p className="cs3-empty">No signed products.</p>}
          </CsBlock>

          {/* upsells */}
          <CsBlock icon="trend" title="Upsells" tone="violet"
            right={<button type="button" className="csx-link" disabled={!ready} onClick={() => setEdit({ client_id: c.id, kind: "product", status: "idea", owner_id: c.primary })}><CsIco n="plus" s={12} />New</button>}>
            {notReady ? <CsLocked what="Upsell planning" /> : myUps.length ? (
              <div className="cs3-ups">{myUps.map((u, i) => <UpsellCard key={u.id} u={u} i={i} clientName={UPSELL_STATUSES.find((x) => x.key === u.status)?.label} ownerName={pName(u.owner_id) || undefined} onOpen={() => setEdit(u)} />)}</div>
            ) : <p className="cs3-empty">Nothing noted. What could {c.name} buy next?</p>}
          </CsBlock>

          {/* QBRs */}
          <CsBlock icon="cal" title="QBRs" tone="teal">
            {notReady ? <CsLocked what="QBR planning" /> : <>
              {myQbrs.length ? <ul className="cs3-qbrs">{myQbrs.map((x) => {
                const n = SPICED.filter((s) => x.spiced[s.key]).length;
                return (
                  <li key={x.id} className={x.status === "done" ? "is-done" : x.meeting_date < todayIso() ? "is-past" : ""}>
                    <span className="csx-qbr-date"><b>{new Date(x.meeting_date).getDate()}</b><i>{new Date(x.meeting_date).toLocaleDateString("en-GB", { month: "short" })}</i></span>
                    <span className="csx-spiced">{SPICED.map((s) => (
                      <button key={s.key} type="button" title={s.label} className={x.spiced[s.key] ? "is-on" : ""} onClick={() => putQbr({ ...x, spiced: { ...x.spiced, [s.key]: !x.spiced[s.key] } })}>{s.key.toUpperCase()}</button>
                    ))}<em>{n}/6</em></span>
                    <button type="button" className={`csx-ghost is-sm is-ico ${x.status === "done" ? "is-on" : ""}`} title={x.status === "done" ? "Done — mark as planned" : "Mark done"} onClick={() => putQbr({ ...x, status: x.status === "done" ? "planned" : "done" })}><CsIco n="check" s={12} /></button>
                    <button type="button" className="csx-ghost is-sm is-ico" title="Remove" onClick={() => dropQbr(x.id)}><CsIco n="trash" s={12} /></button>
                  </li>
                ); })}</ul> : null}
              <div className="cs3-inline-add">
                <input type="date" className="csx-date" value={qbrDate} onChange={(e) => setQbrDate(e.target.value)} aria-label="QBR date" />
                <button type="button" className="csx-ghost is-sm" disabled={!qbrDate || !ready} onClick={async () => { await putQbr({ client_id: c.id, meeting_date: qbrDate, owner_id: c.primary ?? cat.me, spiced: {} }); setQbrDate(""); }}><CsIco n="plus" s={12} />Schedule QBR</button>
              </div>
            </>}
          </CsBlock>

          {myEvs.length > 0 && (
            <CsBlock icon="euro" title="Revenue movements" tone="blue">
              <ul className="cs3-evs">{myEvs.map((e) => (
                <li key={e.id} className={`is-${e.kind}`}><span className="csx-ev-k">{e.kind}</span><i>{e.reason ?? "—"} · {csDate(e.event_date)}</i><b>{e.kind === "expansion" ? "+" : "−"}{csMoney(e.amount)}</b></li>
              ))}</ul>
            </CsBlock>
          )}
        </div>
      </div>
    );
  };

  /* ---------- the side panel when no account is open: what to do today ---------- */
  const todayPanel = () => {
    const due = [...overdue].sort((a, b) => b.ratio - a.ratio).slice(0, 5);
    const soon = renewals.filter((x) => x.t!.left <= 120).slice(0, 4);
    const nextQ = qbrs.filter((x) => x.status === "planned").slice(0, 3);
    const risky = clients.filter((c) => c.health === "red").slice(0, 4);
    return (
      <div className="cs3-today">
        <header className="cs3-today-h">
          <span className="csx-eyebrow"><CsIco n="bolt" s={12} />Today</span>
          <h3>{!clients.length ? "No accounts yet" : due.length ? `${overdue.length} account${overdue.length === 1 ? "" : "s"} to call` : "Everyone is in touch"}</h3>
          <p>{clients.length ? "Pick an account to see everything about it." : "Accounts show here once you have clients."}</p>
        </header>

        <CsBlock icon="play" title="Automatic follow-ups" tone="jade"
          right={ready ? <button type="button" role="switch" aria-checked={!!cs?.settings.auto_tasks} className={`csx-switch ${cs?.settings.auto_tasks ? "is-on" : ""}`} onClick={toggleAuto}><i />{cs?.settings.auto_tasks ? "On" : "Off"}</button> : undefined}>
          {notReady ? <CsLocked what="Automatic follow-ups" /> : <>
            <p className="cs3-auto-p">When an account passes its cadence, a follow-up lands on its starred owner's desk.</p>
            <div className="cs3-auto">
              <span>Default: every</span>
              <input type="number" min={1} value={cs?.settings.default_cadence_days ?? 30}
                onChange={(e) => setCs((d) => d ? { ...d, settings: { ...d.settings, default_cadence_days: Number(e.target.value) || 30 } } : d)}
                onBlur={saveDefaultCadence} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              <span>days</span>
              <button type="button" className="csx-ghost is-sm" onClick={runNow}><CsIco n="play" s={11} />Run now</button>
            </div>
          </>}
        </CsBlock>

        <CsBlock icon="phone" title="Call next" tone="coral" right={overdue.length > 5 ? <button type="button" className="csx-link" onClick={() => { setFilter("contact"); setSort("contact"); }}>All {overdue.length}</button> : undefined}>
          {due.length ? <ul className="cs3-mini">{due.map((c) => (
            <li key={c.id}>
              <button type="button" className="cs3-mini-m" onClick={() => openAccount(c.id)}>
                <CompanyLogo name={c.name} website={c.website} className="cx-av csx-logo is-xs" />
                <span><b>{c.name}</b><i>{c.days == null ? "never contacted" : `${c.days} days · every ${c.cadence}`}</i></span>
              </button>
              <button type="button" className="csx-ghost is-sm is-ico" title="Log a call" onClick={() => quickLog(c)}><CsIco n="phone" s={12} /></button>
              <button type="button" className="csx-ghost is-sm is-ico" title="Add a follow-up task" onClick={() => doTask(c)}><CsIco n="task" s={12} /></button>
            </li>
          ))}</ul> : <p className="cs3-empty">Nobody is past their cadence.</p>}
        </CsBlock>

        {risky.length > 0 && (
          <CsBlock icon="alert" title="At risk" tone="gold">
            <ul className="cs3-mini">{risky.map((c) => (
              <li key={c.id}><button type="button" className="cs3-mini-m" onClick={() => openAccount(c.id)}>
                <span className="cs3-dot is-red" /><span><b>{c.name}</b><i>{CS_REASONS.find((r) => r.key === healthOf(c.id)?.reason)?.label ?? healthOf(c.id)?.note ?? "No reason given"}</i></span>
              </button></li>
            ))}</ul>
          </CsBlock>
        )}

        <CsBlock icon="repeat" title="Renewals coming up" tone="teal" right={<span className="cs3-muted">{csShort(renewals.reduce((t, x) => t + lineAnnual(x.l), 0))}/yr in 12 mo</span>}>
          {soon.length ? <ul className="cs3-mini">{soon.map(({ c, l, t }) => (
            <li key={l.id}><button type="button" className="cs3-mini-m" onClick={() => openAccount(c.id)}>
              <span className={`cs3-days ${t!.left < 60 ? "is-hot" : ""}`}><b>{t!.left}</b><i>days</i></span>
              <span><b>{c.name}</b><i>{l.name} · {l.auto_renew ? "renews" : "ends"} {t!.end.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</i></span>
              <em>{csShort(lineAnnual(l))}</em>
            </button></li>
          ))}</ul> : <p className="cs3-empty">Nothing renews in the next 4 months.</p>}
        </CsBlock>

        {nextQ.length > 0 && (
          <CsBlock icon="cal" title="Next QBRs" tone="teal" right={<button type="button" className="csx-link" onClick={() => setTab("qbr")}>All</button>}>
            <ul className="cs3-mini">{nextQ.map((x) => (
              <li key={x.id}><button type="button" className="cs3-mini-m" onClick={() => openAccount(x.client_id)}>
                <span className="csx-qbr-date is-sm"><b>{new Date(x.meeting_date).getDate()}</b><i>{new Date(x.meeting_date).toLocaleDateString("en-GB", { month: "short" })}</i></span>
                <span><b>{nameOf(x.client_id)}</b><i>SPICED {SPICED.filter((s) => x.spiced[s.key]).length}/6</i></span>
              </button></li>
            ))}</ul>
          </CsBlock>
        )}
      </div>
    );
  };

  /* ---------- tabs ---------- */
  const accountsTab = () => (
    <div className={`cs3-ws ${open ? "has-open" : ""}`}>
      <section className="cs3-list" aria-label="Accounts">
        <div className="cs3-tools">
          <span className="csx-search cs3-search">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
            <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an account…" aria-label="Find an account" />
            {!q && <kbd>/</kbd>}
          </span>
          <div className="cs3-sort">
            <Select size="sm" value={sort} onChange={(v) => setSort(v as CsSort)}
              options={[{ value: "priority", label: "Sort: what needs you" }, { value: "contact", label: "Sort: longest without contact" }, { value: "renewal", label: "Sort: next renewal" }, { value: "arr", label: "Sort: ARR" }, { value: "name", label: "Sort: name" }]} />
          </div>
        </div>
        <div className="cs3-chips" role="tablist" aria-label="Show">
          {FILTERS.map((f) => {
            const n = clients.filter(f.test).length;
            if (f.key !== "all" && !n && filter !== f.key) return null;
            return (
              <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={`is-${f.tone} ${filter === f.key ? "is-on" : ""}`} onClick={() => setFilter(f.key)}>
                {f.label}<em>{n}</em>
              </button>
            );
          })}
        </div>

        {sel.size > 0 && (
          <div className="cs3-bulk">
            <b>{sel.size} selected</b>
            <span className="cs3-bulk-sel"><Select size="sm" value={bulkOwner} onChange={setBulkOwner} placeholder="Add owner…" searchable options={cat.people.map((p) => ({ value: p.id, label: p.name }))} /></span>
            <button type="button" className="csx-primary is-sm" disabled={!bulkOwner || !ready} onClick={assignBulk}>Assign owner</button>
            <button type="button" className="csx-x is-sm" onClick={() => setSel(new Set())} aria-label="Clear the selection"><CsIco n="x" s={13} /></button>
          </div>
        )}

        <div className="cs3-table" ref={listRef} role="grid" aria-rowcount={list.length}>
          <div className="cs3-tr is-head" role="row">
            <span role="columnheader" />
            <span role="columnheader">Account</span>
            <span role="columnheader">Health</span>
            <span role="columnheader">Last contact</span>
            <span role="columnheader" className="is-num">Renewal</span>
            <span role="columnheader" className="is-num">ARR</span>
            <span role="columnheader" />
          </div>
          {list.map((c, i) => (
            <div key={c.id} data-row role="row" tabIndex={0} aria-selected={openId === c.id}
              className={`cs3-tr ${openId === c.id ? "is-open" : ""} ${sel.has(c.id) ? "is-sel" : ""} ${needsContact(c) ? "is-late" : ""}`}
              style={{ ["--i" as any]: Math.min(i, 14) }}
              onClick={() => openAccount(c.id)} onKeyDown={(e) => rowKey(e, c.id)}>
              <span className="cs3-td-chk" onClick={(e) => e.stopPropagation()}>
                <label className="csx-check" title="Select"><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggleSel(c.id)} aria-label={`Select ${c.name}`} /><span><CsIco n="check" s={11} /></span></label>
              </span>
              <span className="cs3-td-acc">
                <CompanyLogo name={c.name} website={c.website} className="cx-av csx-logo" />
                <span className="cs3-td-n">
                  <b>{c.name}</b>
                  <span className="cs3-td-sub">
                    {c.owners.length ? <span className="csx-owners">{c.owners.slice(0, 3).map((o) => <CsAvatar key={o} name={pName(o)} tone={pTone(o)} size={18} />)}</span> : ready ? <em className="cs3-tag is-gold">No owner</em> : null}
                    {c.ups > 0 && <em className="cs3-tag is-violet" title={`${c.ups} open upsell${c.ups === 1 ? "" : "s"}`}><CsIco n="trend" s={10} />{csShort(c.upsValue)}</em>}
                  </span>
                </span>
              </span>
              <span className="cs3-td-h">
                {c.health ? <span className={`cs3-hpill is-${c.health}`}><i />{HEALTH_TONE[c.health]}</span> : <span className="cs3-hpill is-none">—</span>}
              </span>
              <span className="cs3-td-c"><CsCadence c={c} /></span>
              <span className="cs3-td-r is-num">{c.ren ? <><b className={c.ren.left <= 90 ? "is-hot" : ""}>{c.ren.end.toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}</b><i>in {c.ren.left} d</i></> : <i>—</i>}</span>
              <span className="cs3-td-v is-num">{c.arr ? <b>{csShort(c.arr)}</b> : <i>—</i>}</span>
              <span className="cs3-td-a" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="csx-ghost is-sm is-ico" title="Log a call" onClick={() => quickLog(c)}><CsIco n="phone" s={12} /></button>
                <button type="button" className="csx-ghost is-sm is-ico" title="Add a follow-up task" onClick={() => doTask(c)}><CsIco n="task" s={12} /></button>
              </span>
            </div>
          ))}
          {!list.length && (
            <div className="cs3-none">
              <span className="csx-empty-ico"><CsIco n={clients.length ? "check" : "users"} s={20} /></span>
              <b>{!clients.length ? (scope === "mine" ? "You don't look after any account yet" : "No clients yet") : q ? `Nothing matches “${q}”` : "Nothing here — nice"}</b>
              <i>{!clients.length ? (scope === "mine" ? "Switch to Everyone, select some accounts and assign yourself." : "Clients show here once you have some.") : "Try another filter."}</i>
              {(filter !== "all" || q) && <button type="button" className="csx-ghost is-sm" onClick={() => { setFilter("all"); setQ(""); }}>Show all accounts</button>}
            </div>
          )}
        </div>
      </section>
      <aside className={`cs3-side ${open ? "is-acc" : ""}`} aria-label={open ? `Account: ${open.name}` : "Today"}>
        {open ? accountPanel(open) : todayPanel()}
      </aside>
      {open && <div className="cs3-scrim" onClick={() => setOpenId(null)} aria-hidden="true" />}
    </div>
  );

  const upsellsTab = () => (
    <CsPanel icon="trend" title="Upsell planning" sub={upView === "pipeline" ? "Every open opportunity, by stage" : "What each client has, and what we could sell them next"} tone="violet"
      right={<>
        <span className="csx-badge is-violet">{csShort(openUps.reduce((t, u) => t + u.est_value, 0))}/yr open</span>
        <div className="csx-seg is-sm">
          <button type="button" className={upView === "pipeline" ? "is-on" : ""} onClick={() => setUpView("pipeline")}><CsIco n="cols" s={12} />Pipeline</button>
          <button type="button" className={upView === "matrix" ? "is-on" : ""} onClick={() => setUpView("matrix")}><CsIco n="grid" s={12} />Matrix</button>
        </div>
      </>}>
      {notReady ? <CsLocked what="Upsell planning" /> : upView === "matrix" ? (
        <div className="csx-matrix-wrap">
          <table className="csx-matrix">
            <thead><tr><th>Client</th>{items.map((it) => <th key={it.key} title={it.name}><span>{it.name}</span><i>{it.kind === "product" ? "product" : "service"}</i></th>)}</tr></thead>
            <tbody>
              {matrixRows.map((c) => (
                <tr key={c.id}>
                  <th><button type="button" className="csx-mx-c" onClick={() => { setTab("accounts"); openAccount(c.id); }}><CompanyLogo name={c.name} website={c.website} className="cx-av csx-logo is-xs" />{c.name}</button></th>
                  {items.map((it) => {
                    const has = it.kind === "product" && c.lines.some((l) => isActive(l) && l.product_id === it.id);
                    const up = upsells.find((u) => u.client_id === c.id && (it.kind === "product" ? u.product_id === it.id : u.service_id === it.id));
                    return (
                      <td key={it.key}>
                        {has ? <span className="csx-mx-has" title="Already has it"><CsIco n="check" s={12} /></span>
                          : up ? <button type="button" className={`csx-mx-up is-${UPS_TONE[up.status]}`} onClick={() => setEdit(up)} title={`${up.title} · ${up.status}`}>{UPSELL_STATUSES.find((x) => x.key === up.status)?.label}</button>
                          : <button type="button" className="csx-mx-add" disabled={!ready} onClick={() => quickUpsell(c, it)} title={`Note ${it.name} as an upsell for ${c.name}`}><CsIco n="plus" s={12} /></button>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!matrixRows.length && <p className="csx-none">No clients with products yet.</p>}
          <p className="csx-legend"><span className="csx-mx-has"><CsIco n="check" s={10} /></span>has it <span className="csx-mx-up is-slate">Idea</span>upsell noted <span className="csx-mx-add"><CsIco n="plus" s={10} /></span>click to note one</p>
        </div>
      ) : (
        <div className="csx-board">
          {UPSELL_STATUSES.map((st) => {
            const xs = upsells.filter((u) => u.status === st.key);
            return (
              <div key={st.key} className={`csx-col is-${UPS_TONE[st.key]}`}>
                <div className="csx-col-h"><i />{st.label}<em>{xs.length}</em><span>{csShort(xs.reduce((t, u) => t + u.est_value, 0))}</span></div>
                {xs.map((u, i) => <UpsellCard key={u.id} u={u} i={i} clientName={nameOf(u.client_id)} ownerName={pName(u.owner_id) || undefined} onOpen={() => setEdit(u)} />)}
                {st.key === "idea" && (
                  <div className="csx-col-add">
                    <Select size="sm" value="" onChange={(v) => v && setEdit({ client_id: v, kind: "product", status: "idea", owner_id: all.find((c) => c.id === v)?.primary ?? null })}
                      placeholder="+ New upsell for…" searchable options={clients.map((c) => ({ value: c.id, label: c.name }))} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </CsPanel>
  );

  const qbrTab = () => {
    const t0 = todayIso();
    const groups: { key: string; label: string; xs: CsQbr[] }[] = [
      { key: "past", label: "Overdue — still planned", xs: qbrs.filter((x) => x.status === "planned" && x.meeting_date < t0) },
      { key: "next", label: "Upcoming", xs: qbrs.filter((x) => x.status === "planned" && x.meeting_date >= t0) },
      { key: "done", label: "Done", xs: qbrs.filter((x) => x.status === "done").reverse() },
    ];
    return (
      <CsPanel icon="cal" title="QBR · SPICED" sub="Quarterly business reviews and how far each conversation got" tone="teal"
        right={<span className="csx-badge is-teal">{qbrs.filter((x) => x.status === "planned").length} planned</span>}>
        {notReady ? <CsLocked what="QBR planning" /> : <>
          <div className="csx-addrow is-top">
            <Select size="sm" value={qbrNew.client} onChange={(v) => setQbrNew((x) => ({ ...x, client: v }))} placeholder="Client…" searchable options={clients.map((c) => ({ value: c.id, label: c.name }))} />
            <input type="date" className="csx-date" value={qbrNew.date} onChange={(e) => setQbrNew((x) => ({ ...x, date: e.target.value }))} aria-label="QBR date" />
            <button type="button" className="csx-primary is-sm" disabled={!qbrNew.client || !qbrNew.date || !ready}
              onClick={async () => { await putQbr({ client_id: qbrNew.client, meeting_date: qbrNew.date, owner_id: all.find((c) => c.id === qbrNew.client)?.primary ?? cat.me, spiced: {} }); setQbrNew({ client: "", date: "" }); }}><CsIco n="plus" s={12} />Schedule</button>
          </div>
          {!qbrs.length && <p className="csx-none">No QBR scheduled yet. Pick a client and a date above.</p>}
          {groups.filter((g) => g.xs.length).map((g) => (
            <div key={g.key} className={`cs3-qgroup is-${g.key}`}>
              <h4>{g.label}<em>{g.xs.length}</em></h4>
              <ul className="csx-rows">
                {g.xs.map((x, i) => {
                  const n = SPICED.filter((s) => x.spiced[s.key]).length;
                  const c = byId(x.client_id);
                  return (
                    <li key={x.id} className={`csx-qbr ${x.status === "done" ? "is-done" : ""} ${g.key === "past" ? "is-past" : ""}`} style={{ ["--i" as any]: i }}>
                      <span className="csx-qbr-date"><b>{new Date(x.meeting_date).getDate()}</b><i>{new Date(x.meeting_date).toLocaleDateString("en-GB", { month: "short" })}</i></span>
                      <div className="csx-qbr-m">
                        <button type="button" className="cs3-name" onClick={() => { setTab("accounts"); openAccount(x.client_id); }}>{c && <CompanyLogo name={c.name} website={c.website} className="cx-av csx-logo is-xs" />}{nameOf(x.client_id)}</button>
                        <span className="csx-spiced">
                          {SPICED.map((s) => (
                            <button key={s.key} type="button" title={s.label} className={x.spiced[s.key] ? "is-on" : ""} onClick={() => putQbr({ ...x, spiced: { ...x.spiced, [s.key]: !x.spiced[s.key] } })}>{s.key.toUpperCase()}</button>
                          ))}
                          <em>{n}/6</em>
                        </span>
                      </div>
                      <span className="csx-acts">
                        <button type="button" className={`csx-ghost is-sm ${x.status === "done" ? "is-on" : ""}`} onClick={() => putQbr({ ...x, status: x.status === "done" ? "planned" : "done" })}><CsIco n="check" s={12} />{x.status === "done" ? "Done" : "Mark done"}</button>
                        <button type="button" className="csx-ghost is-sm is-ico" title="Remove" onClick={() => dropQbr(x.id)}><CsIco n="trash" s={12} /></button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>}
      </CsPanel>
    );
  };

  const revenueTab = () => {
    const end = initial + expansion - contraction - churn;
    const max = Math.max(initial, end, initial + expansion, 1);
    const bars = [
      { k: "Initial ARR", v: initial, from: 0, to: initial, tone: "slate" },
      { k: "Expansion", v: expansion, from: initial, to: initial + expansion, tone: "jade", sign: "+" },
      { k: "Contraction", v: contraction, from: initial + expansion - contraction, to: initial + expansion, tone: "gold", sign: "−" },
      { k: "Churn", v: churn, from: end, to: initial + expansion - contraction, tone: "coral", sign: "−" },
      { k: "Net retained", v: end, from: 0, to: end, tone: "pine" },
    ];
    return (
      <div className="cs3-rev">
        <CsPanel icon="euro" title={`Net revenue retention · ${year}`} sub="From the ARR the year started with to what's kept" tone="blue"
          right={snap ? <span className="csx-badge"><CsIco n="lock" s={11} />Base fixed {csDate(snap.taken_at)}</span>
            : <button type="button" className="csx-primary is-sm" disabled={!ready} onClick={freeze}><CsIco n="lock" s={12} />Freeze today's ARR as the {year} base</button>}>
          {notReady ? <CsLocked what="Revenue movements" /> : !snap ? (
            <p className="csx-none">NRR and churn are measured against the ARR the year starts with. Freeze it once (button above) — today's ARR is {csMoney(all.reduce((t, c) => t + c.arr, 0))}.</p>
          ) : (
            <div className="cs3-bridge" role="img" aria-label={`NRR ${nrr == null ? "—" : csPct(nrr)}`}>
              {bars.map((b, i) => (
                <div key={b.k} className={`cs3-bridge-r is-${b.tone}`} style={{ ["--i" as any]: i }}>
                  <span className="cs3-bridge-k">{b.k}</span>
                  <span className="cs3-bridge-t">{b.v > 0 && <span style={{ left: `${(Math.min(b.from, b.to) / max) * 100}%`, width: `${Math.max(0.8, (Math.abs(b.to - b.from) / max) * 100)}%` }} />}</span>
                  <b>{b.sign && b.v ? b.sign : ""}{csMoney(b.v)}</b>
                </div>
              ))}
              <p className="cs3-bridge-f">NRR <b className={nrr != null && nrr >= 100 ? "is-good" : "is-warn"}>{nrr == null ? "—" : csPct(nrr)}</b> · churn rate <b>{churnRate == null ? "—" : csPct(churnRate)}</b> · ARR today <b>{csMoney(arrNow)}</b></p>
            </div>
          )}
        </CsPanel>
        <CsPanel icon="repeat" title="Movements" sub="Expansion, contraction and churn — won upsells add themselves" tone="blue"
          right={<button type="button" className="csx-ghost is-sm" disabled={!ready} onClick={() => setEvNew({ client: "", kind: "churn", amount: 0, date: todayIso(), reason: "" })}><CsIco n="plus" s={12} />Add</button>}>
          {notReady ? <CsLocked what="Revenue movements" /> : <>
            {evNew && (
              <div className="csx-evform">
                <Select size="sm" value={evNew.client} onChange={(v) => setEvNew({ ...evNew, client: v })} placeholder="Client…" searchable options={clients.map((c) => ({ value: c.id, label: c.name }))} />
                <div className="csx-seg is-sm is-cap">
                  {(["churn", "contraction", "expansion"] as const).map((k) => <button key={k} type="button" className={evNew.kind === k ? "is-on" : ""} onClick={() => setEvNew({ ...evNew, kind: k })}>{k}</button>)}
                </div>
                <span className="csx-money is-sm"><input type="number" min={0} value={evNew.amount} onFocus={(e) => e.target.select()} onChange={(e) => setEvNew({ ...evNew, amount: Number(e.target.value) || 0 })} /><em>€/yr</em></span>
                <input type="date" className="csx-date" value={evNew.date} onChange={(e) => setEvNew({ ...evNew, date: e.target.value })} />
                <input className="csx-inline is-box" placeholder="Reason" value={evNew.reason} onChange={(e) => setEvNew({ ...evNew, reason: e.target.value })} />
                <button type="button" className="csx-primary is-sm" disabled={!evNew.client || !evNew.amount}
                  onClick={async () => { const e = await addRevenueEvent({ client_id: evNew.client, kind: evNew.kind, amount: evNew.amount, event_date: evNew.date, reason: evNew.reason || null }); if (e) { say(e); return; } setEvNew(null); reload(); }}>Save</button>
                <button type="button" className="csx-x is-sm" onClick={() => setEvNew(null)} aria-label="Cancel"><CsIco n="x" s={13} /></button>
              </div>
            )}
            <ul className="csx-rows">
              {evs.map((e, i) => (
                <li key={e.id} className={`csx-ev is-${e.kind}`} style={{ ["--i" as any]: i }}>
                  <span className="csx-ev-k">{e.kind}</span>
                  <span className="csx-ev-m"><b>{nameOf(e.client_id)}</b><span>{e.reason ?? "—"} · {csDate(e.event_date)}</span></span>
                  <b className="csx-ev-v">{e.kind === "expansion" ? "+" : "−"}{csMoney(e.amount)}</b>
                  {!e.upsell_id ? <button type="button" className="csx-ghost is-sm is-ico" title="Remove" onClick={async () => { const er = await deleteRevenueEvent(e.id); if (er) say(er); else reload(); }}><CsIco n="trash" s={12} /></button> : <span title="Comes from a won upsell" className="cs3-auto-ev"><CsIco n="trend" s={12} /></span>}
                </li>
              ))}
              {!evs.length && <li className="csx-none">No movements this year. Won upsells show here on their own.</li>}
            </ul>
          </>}
        </CsPanel>
      </div>
    );
  };

  return (
    <div className="csx cs3">
      <header className="csx-hero is-compact" onPointerMove={glow}>
        <div className="csx-hero-top">
          <div className="csx-hero-t">
            <span className="csx-eyebrow is-light"><CsIco n="heart" s={12} />Customer success</span>
            <h1>Retention &amp; expansion</h1>
          </div>
          <p className="csx-hero-sub">{clients.length} account{clients.length === 1 ? "" : "s"} · <b>{overdue.length}</b> to contact · <b>{clients.filter(atRisk).length}</b> at risk · <b>{openUps.length}</b> open upsell{openUps.length === 1 ? "" : "s"}</p>
          <div className="csx-hero-ctl">
            <div className="csx-seg is-dark">
              <button type="button" className={scope === "mine" ? "is-on" : ""} onClick={() => setScope("mine")}>My portfolio</button>
              <button type="button" className={scope === "all" ? "is-on" : ""} onClick={() => setScope("all")}>Everyone</button>
            </div>
            <div className="csx-hero-sel">
              <Select size="sm" value={owner} onChange={setOwner} placeholder="Any owner" searchable
                options={[{ value: "", label: "Any owner" }, ...cat.people.map((p) => ({ value: p.id, label: p.name }))]} />
            </div>
            <span className="cs3-hero-auto">
              <button type="button" className={`csx-hero-btn ${autoAt ? "is-on" : ""}`} onClick={(e) => toggleAutoPop(e.currentTarget)} aria-expanded={!!autoAt} aria-haspopup="dialog" title="Automatic follow-ups">
                <CsIco n="bolt" s={14} /><span>Auto follow-ups</span><i className={cs?.settings.auto_tasks && ready ? "is-on" : ""} />
              </button>
              {autoAt && createPortal(
                <div className="cs3-pop-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) setAutoAt(null); }}>
                  <div className="cs3-pop" role="dialog" aria-label="Automatic follow-ups" style={{ top: autoAt.top, left: autoAt.left }} onKeyDown={(e) => { if (e.key === "Escape") setAutoAt(null); }}>
                    <b>Automatic follow-ups</b>
                    <i>When an account passes its contact cadence, a follow-up lands on its starred owner's desk (once a day).</i>
                    {notReady ? <span className="cs3-pop-lock">Needs <code>17_customer_success.sql</code></span> : <>
                      <span className="cs3-pop-r"><button type="button" role="switch" aria-checked={!!cs?.settings.auto_tasks} className={`csx-switch ${cs?.settings.auto_tasks ? "is-on" : ""}`} onClick={toggleAuto} autoFocus><i />{cs?.settings.auto_tasks ? "On" : "Off"}</button>
                        <button type="button" className="csx-ghost is-sm" onClick={runNow}><CsIco n="play" s={11} />Run now</button></span>
                      <span className="cs3-pop-r">Default cadence
                        <input type="number" min={1} value={cs?.settings.default_cadence_days ?? 30}
                          onChange={(e) => setCs((d) => d ? { ...d, settings: { ...d.settings, default_cadence_days: Number(e.target.value) || 30 } } : d)}
                          onBlur={saveDefaultCadence} />days</span>
                    </>}
                  </div>
                </div>, document.body)}
            </span>
            <ActionsMenu items={[]} />
          </div>
        </div>
        <div className="csx-kpis">
          <div className="csx-kpi is-lead" style={{ ["--i" as any]: 0 }}>
            <span className="csx-kpi-k">ARR signed</span>
            <span className="csx-kpi-v"><b>{loading ? "…" : csMoney(arrNow)}</b>{growth != null && <em className={growth >= 0 ? "is-up" : "is-down"} title="vs. the initial ARR"><CsIco n={growth >= 0 ? "trend" : "down"} s={11} />{csPct(growth)}</em>}</span>
          </div>
          <div className="csx-kpi" style={{ ["--i" as any]: 1 }}>
            <span className="csx-kpi-k">Initial ARR · {year}</span>
            <span className="csx-kpi-v">{snap ? <><b>{csMoney(initial)}</b><em className="is-flat" title={`Frozen ${csDate(snap.taken_at)}`}><CsIco n="lock" s={10} />fixed</em></> :
              <button type="button" className="csx-kpi-btn" disabled={!ready || loading} onClick={freeze}><CsIco n="lock" s={11} />Freeze today's ARR</button>}</span>
          </div>
          <div className="csx-kpi" style={{ ["--i" as any]: 2 }} title="(initial ARR + expansion − contraction − churn) / initial ARR">
            <span className="csx-kpi-k">NRR</span>
            <span className="csx-kpi-v"><b className={nrr == null ? "is-muted" : nrr >= 100 ? "is-good" : "is-warn"}>{nrr == null ? "—" : csPct(nrr)}</b>{nrr != null && <em className={nrr >= 100 ? "is-good" : "is-warn"}>{nrr >= 100 ? "Healthy" : "Watch"}</em>}</span>
          </div>
          <div className="csx-kpi" style={{ ["--i" as any]: 3 }} title="Won upsells and other expansion this year">
            <span className="csx-kpi-k">Expansion</span>
            <span className="csx-kpi-v"><b>{csMoney(expansion)}</b>{initial > 0 && expansion > 0 && <em className="is-up"><CsIco n="trend" s={11} />{csPct((expansion / initial) * 100)}</em>}</span>
          </div>
          <div className={`csx-kpi ${churnRate != null && churnRate > 5 ? "is-alarm" : ""}`} style={{ ["--i" as any]: 4 }} title={`${csMoney(churn)} lost${contraction ? ` · ${csMoney(contraction)} contraction` : ""}`}>
            <span className="csx-kpi-k">Churn rate</span>
            <span className="csx-kpi-v"><b className={churnRate == null ? "is-muted" : churnRate > 5 ? "is-bad" : churnRate > 2 ? "is-warn" : "is-good"}>{churnRate == null ? "—" : csPct(churnRate)}</b>{churn > 0 && <em className="is-down">−{csShort(churn)}</em>}</span>
          </div>
        </div>
      </header>

      {notReady && (
        <div className="csx-banner" role="note">
          <span className="csx-banner-ico"><CsIco n="lock" s={16} /></span>
          <div><b>Customer success isn't switched on yet</b><span>Run <code>17_customer_success.sql</code> in Supabase. Contact tracking and renewals already work from your clients; owners, health, QBRs, upsells and revenue movements need the new tables.</span></div>
        </div>
      )}
      {flash && <div className="csx-toast" role="status"><CsIco n="check" s={14} />{flash}</div>}

      <nav className="cs3-tabs" role="tablist" aria-label="Customer success">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "is-on" : ""} onClick={() => setTab(t.key)}>
            <CsIco n={t.icon} s={14} />{t.label}{t.n != null && <em>{t.n}</em>}
          </button>
        ))}
      </nav>

      {loading ? (
        <PageLoader label="Reading your portfolio" />
      ) : (
        <div className="cs3-body" key={tab}>
          {tab === "accounts" ? accountsTab() : tab === "upsells" ? upsellsTab() : tab === "qbr" ? qbrTab() : revenueTab()}
        </div>
      )}
      {edit && <UpsellEditor initial={edit} clientName={nameOf(edit.client_id)} cat={cat} onClose={() => setEdit(null)} onSaved={upsert}
        onDeleted={(id) => setCs((d) => d ? { ...d, upsells: d.upsells.filter((x) => x.id !== id) } : d)} />}
    </div>
  );
}
