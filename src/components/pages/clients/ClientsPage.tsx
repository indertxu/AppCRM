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
  cadenceOf, setClientPriority, CS_PRIORITIES, loadCsAuto, saveCsTemplate, deleteCsTemplate, saveCsSequence, deleteCsSequence, setCsRun,
  uploadCsFile, removeCsFile, runCsSequences, testCsTemplate, CS_TAGS, fillCsTags, renderCsEmail, cleanCsBody, NEEDS_AUTO,
  scanCsMail, loadCsMailSync, type CsMailSync, csVariantFor, inspectCsFile, previewCsAttachment, type CsAttachment, type CsVariant, type CsVariantAudience,
  type CsData, type CsUpsell, type CsHealthStatus, type CsQbr, type RevenueEvent,
  type CsPriority, type CsAuto, type CsTemplate, type CsSequence, type CsRun, type CsStep,
} from "./useClientsData";
import SalesMultiFilter from "../sales/sales/SalesMultiFilter";
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
import { useInactiveIds } from "../../framework/peopleStatus";

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


  // Resolve team member ids → names for the consultant filter (laid-off people aren't offered).
  const inactive = useInactiveIds();
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
      options: () => [...new Set(rows.flatMap((r) => r.consultants))].filter((id) => !inactive.has(id)).map((id) => ({ value: id, label: personName(id) })).sort((a, b) => a.label.localeCompare(b.label)) },
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
  up: "M12 19V5M6 11l6-6 6 6",
  dn: "M12 5v14M6 13l6 6 6-6",
  clip: "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  din: "M17 7L7 17M7 17h9M7 17V8",
  dout: "M7 17L17 7M17 7H8M17 7v9",
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
  /** The people to offer as owners (laid-off ones keep their name on old records only). */
  const pickable = people.filter((p) => !p.former);
  return { products, services, people, pickable, me };
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
                options={[{ value: "", label: "Nobody yet" }, ...cat.pickable.map((p) => ({ value: p.id, label: p.name }))]} />
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
interface CsLog { client_id: string; contacted_at: string; reason: string | null; channel: string | null; contact_name?: string | null; direction?: "in" | "out" | null; source?: string | null; logged_by?: string | null }
interface CsClient {
  id: string; name: string; website: string;
  arr: number; lines: Line[];
  last: string | null; lastWhy: string | null; days: number | null;
  /** days since they last reached us / we last reached them, and which way the last contact went */
  daysIn: number | null; daysOut: number | null; lastDir: "in" | "out" | null;
  /** who it was: on our side (our team) and on theirs, for the last contact and the last one each way */
  lastUs: string; lastThem: string; inUs: string; inThem: string; outUs: string; outThem: string;
  owners: string[]; primary: string | null;
  /** days since the last contact / the client's cadence (Infinity when never contacted) */
  ratio: number; cadence: number;
  health: CsHealthStatus | null;
  ren: { end: Date; left: number; value: number; auto: boolean; kind: CsTermKind } | null;
  ups: number; upsValue: number;
  /** how often we should be in touch (its own cadence, else its priority's, else the default) */
  priority: CsPriority | null;
  typeId: string | null;
  contacts: { name?: string; email?: string; billing?: boolean }[];
  /** what needs doing first, highest first */
  score: number;
}
type CsTab = "accounts" | "followups" | "upsells" | "qbr" | "revenue";
type CsFilter = "all" | "contact" | "risk" | "renew" | "orphan" | "upsell" | "high";
/** Where a renewal date comes from: the product's own term, its deal's contract, or (no term on file) its yearly anniversary. */
type CsTermKind = "term" | "deal" | "anniversary";
const CS_DAY = 864e5;
const csAddYears = (d0: Date, y: number) => { const d = new Date(d0); d.setFullYear(d.getFullYear() + Math.floor(y)); d.setMonth(d.getMonth() + Math.round((y % 1) * 12)); return d; };
/** A signed product's next renewal — the same rule the automatic e-mails use. */
function csRenewalOf(l: Line, ct: any): { end: Date; left: number; kind: CsTermKind } | null {
  if (!isActive(l)) return null;
  const t = termOf(l);
  if (t) return t.left >= 0 ? { end: t.end, left: t.left, kind: "term" } : null;
  const startS = l.start_date || l.signing_date || ct?.contractStart || ct?.signDate;
  if (!startS) return null;
  const deal = Number(ct?.termYears) || 0;
  const y = deal || (l.recurring ? 1 : 0);
  if (!y) return null;
  const auto = deal ? !!ct?.autoRenew : true;
  const step = Number(ct?.renewYears) || y;
  let end = csAddYears(new Date(startS), y);
  for (let n = 0; auto && end.getTime() < Date.now() && n < 80; n++) end = csAddYears(end, step);
  const left = Math.ceil((end.getTime() - Date.now()) / CS_DAY);
  return left >= 0 ? { end, left, kind: deal ? "deal" : "anniversary" } : null;
}
const PRI_TONE: Record<CsPriority, string> = { high: "coral", medium: "gold", low: "slate" };
/** Does a sequence apply to a client (the same test the sender makes)? */
function csFits(q: CsSequence, c: CsClient, _cs?: CsData | null): boolean {
  const a = q.audience ?? {};
  if (a.exclude?.includes(c.id)) return false;
  if (q.start_mode === "before_renewal" && !c.ren) return false;
  if (a.clients?.length) return a.clients.includes(c.id);
  if (a.priorities?.length && !a.priorities.includes(c.priority ?? "none")) return false;
  if (a.types?.length && !a.types.includes(c.typeId ?? "")) return false;
  if (a.health?.length && !a.health.includes(c.health ?? "none")) return false;
  return true;
}
/** Who a sequence's e-mail goes to for a client. */
function csTo(q: CsSequence, c: CsClient, run: CsRun | null): string[] {
  if (run?.to_emails?.length) return run.to_emails;
  const cts = c.contacts.filter((x) => x.email && /@/.test(x.email));
  const main = cts.find((x) => !x.billing) ?? cts[0];
  if (q.recipients === "all") return [...new Set(cts.map((x) => x.email!.trim()))];
  if (q.recipients === "billing") { const b = cts.filter((x) => x.billing); return (b.length ? b : main ? [main] : []).map((x) => x.email!.trim()); }
  return main ? [main.email!.trim()] : [];
}
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
/** "Antonio ↔ Laura Gil": our person (first name) and theirs, in the order the contact went. */
const csWho = (us: string, them: string, dir: "in" | "out" | null) => {
  const u = us.split(" ")[0];
  if (u && them) return dir === "in" ? `${them} → ${u}` : `${u} → ${them}`;
  return u || them;
};
function CsCadence({ c, wide = false }: { c: CsClient; wide?: boolean }) {
  const late = c.days == null || c.days > c.cadence;
  const soon = !late && (c.days ?? 0) > c.cadence * 0.75;
  return (
    <span className={`cs3-cad ${late ? "is-late" : soon ? "is-soon" : ""} ${wide ? "is-wide" : ""}`} title={`Cadence: every ${c.cadence} days`}>
      <span className="cs3-cad-t">{c.lastDir && <em className={`cs4-dir-ico is-${c.lastDir}`} title={c.lastDir === "in" ? "They reached us" : "We reached them"}><CsIco n={c.lastDir === "in" ? "din" : "dout"} s={10} /></em>}<b>{csAgo(c.days)}</b>{c.lastWhy && wide ? <i>{c.lastWhy}</i> : null}</span>
      <span className="cs3-cad-bar"><span style={{ width: `${Math.min(100, ((c.days ?? c.cadence * 2) / c.cadence) * 100)}%` }} /></span>
      {!wide && (c.lastUs || c.lastThem) && <span className="cs3-cad-who" title={`${c.lastDir === "in" ? `${c.lastThem || "Them"} → ${c.lastUs || "us"}` : `${c.lastUs || "Us"} → ${c.lastThem || "them"}`}`}>{csWho(c.lastUs, c.lastThem, c.lastDir)}</span>}
    </span>
  );
}

/* ---------- contact priority: a pill that opens a small menu (over the list, never clipped) ---------- */
function CsPriPick({ value, onPick, disabled, days }: { value: CsPriority | null; onPick: (p: CsPriority | null) => void; disabled?: boolean; days?: Record<CsPriority, number> }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    window.addEventListener("resize", close); window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [at]);
  const lbl = value ? CS_PRIORITIES.find((x) => x.key === value)!.label : "Set";
  return (
    <>
      <button type="button" className={`cs4-pri-pill ${value ? `is-${PRI_TONE[value]}` : "is-none"}`} disabled={disabled} aria-haspopup="menu" aria-expanded={!!at}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 220) }); }}>
        <i />{lbl}
      </button>
      {at && createPortal(
        <div className="cs4-pop-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) setAt(null); }}>
          <div className="cs4-pop" role="menu" style={{ top: at.top, left: at.left }} onKeyDown={(e) => { if (e.key === "Escape") setAt(null); }}>
            {CS_PRIORITIES.map((p) => (
              <button key={p.key} type="button" role="menuitemradio" aria-checked={value === p.key} className={`is-${PRI_TONE[p.key]} ${value === p.key ? "is-on" : ""}`} onClick={() => { onPick(p.key); setAt(null); }}>
                <i /><b>{p.label}</b><em>every {days?.[p.key] ?? p.days} days</em>
              </button>
            ))}
            <button type="button" role="menuitemradio" aria-checked={!value} className={`is-none ${!value ? "is-on" : ""}`} onClick={() => { onPick(null); setAt(null); }}><i /><b>No priority</b><em>the default cadence</em></button>
          </div>
        </div>, document.body)}
    </>
  );
}

/* =====================================================================
   Automatic e-mails — blueprints (styled e-mails with the client's name filled in)
   and sequences (which blueprint, after how many days, to which clients).
   ===================================================================== */
const ACCENTS = ["#0a6f4d", "#12b57f", "#0f766e", "#2563eb", "#7c3aed", "#c2410c", "#b45309", "#334155"];
const HEALTH_KEYS: { key: string; label: string }[] = [{ key: "green", label: "Healthy" }, { key: "amber", label: "Watch" }, { key: "red", label: "At risk" }, { key: "none", label: "Not tracked" }];
/** Names always start with a capital letter ("laura gil" → "Laura Gil"). */
const capName = (x: string) => String(x ?? "").trim().replace(/(^|[\s\-'’])(\p{L})/gu, (_, a, b) => a + b.toLocaleUpperCase());
const csVarsFor = (c: CsClient | null, ownerName0: string, ownerEmail: string): Record<string, string> => {
  const ownerName = capName(ownerName0);
  const sample = Object.fromEntries(CS_TAGS.map((t) => [t.key, t.sample]));
  if (!c) return { ...sample, owner_name: ownerName || sample.owner_name, owner_first_name: (ownerName || sample.owner_name).split(" ")[0], owner_email: ownerEmail || sample.owner_email };
  const cts = c.contacts.filter((x) => x.email);
  const main = cts.find((x) => !x.billing) ?? cts[0];
  return {
    ...sample, client: c.name, legal_name: c.name, contact_name: capName(main?.name ?? ""), first_name: capName(String(main?.name ?? "").trim().split(/\s+/)[0]) || "there",
    owner_name: ownerName, owner_first_name: ownerName.split(" ")[0] ?? "", owner_email: ownerEmail,
    renewal_date: c.ren ? c.ren.end.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "",
    days_to_renewal: c.ren ? String(c.ren.left) : "",
  };
};
const plainOf = (h: string) => String(h ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<\/(p|div|li)>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const fmtSize = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
const newStep = (template_id = "", wait_days = 0): CsStep => ({ id: Math.random().toString(36).slice(2, 9), template_id, wait_days });
const audienceText = (q: CsSequence, types: { id: string; name: string }[], accounts: CsClient[]) => {
  const a = q.audience ?? {};
  if (a.clients?.length) return a.clients.length === 1 ? accounts.find((c) => c.id === a.clients![0])?.name ?? "1 client" : `${a.clients.length} picked clients`;
  const bits = [
    a.priorities?.length ? a.priorities.map((p) => (p === "none" ? "no priority" : `${p} priority`)).join(" or ") : "",
    a.types?.length ? a.types.map((t) => types.find((x) => x.id === t)?.name ?? "type").join(" or ") : "",
    a.health?.length ? a.health.map((h) => HEALTH_KEYS.find((x) => x.key === h)?.label.toLowerCase() ?? h).join(" or ") : "",
  ].filter(Boolean);
  return bits.length ? `Clients with ${bits.join(" · ")}` : "Every client";
};

function CsFollowUps({ auto, setAuto, accounts, cs, setCs, types, people, me, say, cmd, onOpenClient, onSendDue, onRunTasks }: {
  auto: CsAuto | null; setAuto: (f: (a: CsAuto | null) => CsAuto | null) => void;
  accounts: CsClient[]; cs: CsData | null; setCs: (f: (d: CsData | null) => CsData | null) => void;
  types: { id: string; name: string }[]; people: Employee[]; me: string | null;
  say: (m: string) => void; cmd: { k: "seq" | "tpl"; n: number } | null;
  onOpenClient: (id: string) => void; onSendDue: () => void; onRunTasks: () => void;
}) {
  const [view, setView] = useState<"sequences" | "blueprints" | "activity" | "cadence">("sequences");
  const [tpl, setTpl] = useState<Partial<CsTemplate> | null>(null);
  const [seq, setSeq] = useState<Partial<CsSequence> | null>(null);
  const [logF, setLogF] = useState<"all" | "sent" | "failed" | "skipped" | "test">("all");
  const [mail, setMail] = useState<{ connected: boolean; mail: boolean; email: string | null } | null>(null);
  const lastCmd = useRef(0);
  useEffect(() => {
    supabase.functions.invoke("outlook-sync", { body: { action: "mail_status" } })
      .then(({ data }: any) => setMail(data && typeof data.connected === "boolean" ? data : null)).catch(() => setMail(null));
  }, []);
  const ready = !!auto?.ready;
  const templates = auto?.templates ?? [], sequences = auto?.sequences ?? [], runs = auto?.runs ?? [], log = auto?.log ?? [];
  const tplName = (id: string | null) => templates.find((t) => t.id === id)?.name ?? "—";
  const pName = (id: string | null | undefined) => (id ? people.find((p) => p.id === id)?.name ?? "Someone" : "—");
  const newSeq = (): Partial<CsSequence> => ({ name: "", active: false, audience: {}, steps: [newStep(templates[0]?.id ?? "", 0)], start_mode: "now", start_days: 30, repeat: false, recipients: "all", sender: "owner", log_contact: true });
  const newTpl = (): Partial<CsTemplate> => ({ name: "", subject: "", body_html: "<p>Hi {{first_name}},</p><p><br></p><p><br></p>", design: { accent: "#0a6f4d", title: "", brand: "", signoff: "Best regards,\n{{owner_name}}" }, attachments: [] });
  useEffect(() => {
    if (!cmd || cmd.n === lastCmd.current) return;
    lastCmd.current = cmd.n;
    if (cmd.k === "seq") { setView("sequences"); setSeq(newSeq()); } else { setView("blueprints"); setTpl(newTpl()); }
  }, [cmd]); // eslint-disable-line react-hooks/exhaustive-deps

  const upTpl = (t: CsTemplate) => setAuto((a) => a ? { ...a, templates: a.templates.some((x) => x.id === t.id) ? a.templates.map((x) => (x.id === t.id ? t : x)) : [...a.templates, t] } : a);
  const upSeq = (q: CsSequence) => setAuto((a) => a ? { ...a, sequences: a.sequences.some((x) => x.id === q.id) ? a.sequences.map((x) => (x.id === q.id ? q : x)) : [...a.sequences, q] } : a);
  const toggleSeq = async (q: CsSequence) => {
    if (!q.active && !q.steps.some((s) => s.template_id)) { say("Give it at least one e-mail first."); setSeq(q); return; }
    const r = await saveCsSequence({ ...q, active: !q.active });
    if (r.error || !r.row) { say(r.error ?? "Not saved"); return; }
    upSeq({ ...r.row, audience: r.row.audience ?? {}, steps: r.row.steps ?? [] });
    say(r.row.active ? `${r.row.name} is on — e-mails go out every hour` : `${r.row.name} is off`);
  };
  const dupSeq = async (q: CsSequence) => { const r = await saveCsSequence({ ...q, id: undefined, name: `${q.name} (copy)`, active: false }); if (r.row) { upSeq(r.row); say("Copied — it starts switched off"); } else say(r.error ?? "Not saved"); };
  const dupTpl = async (t: CsTemplate) => { const r = await saveCsTemplate({ ...t, id: undefined, name: `${t.name} (copy)`, attachments: [] }); if (r.row) { upTpl(r.row); say("Copied (without its attachments)"); } else say(r.error ?? "Not saved"); };
  const dropSeq = async (q: CsSequence) => { if (!window.confirm(`Delete “${q.name}”? Clients stop getting its e-mails.`)) return; const e = await deleteCsSequence(q.id); if (e) { say(e); return; } setAuto((a) => a ? { ...a, sequences: a.sequences.filter((x) => x.id !== q.id), runs: a.runs.filter((r) => r.sequence_id !== q.id) } : a); };
  const dropTpl = async (t: CsTemplate) => {
    const used = sequences.filter((q) => q.steps.some((s) => s.template_id === t.id));
    if (!window.confirm(used.length ? `“${t.name}” is used by ${used.map((q) => q.name).join(", ")}. Delete it anyway? Those steps will be skipped.` : `Delete “${t.name}”?`)) return;
    const e = await deleteCsTemplate(t.id); if (e) { say(e); return; }
    for (const a of t.attachments) await removeCsFile(a.path);
    setAuto((a) => a ? { ...a, templates: a.templates.filter((x) => x.id !== t.id) } : a);
  };
  const since30 = Date.now() - 30 * CS_DAY;

  /* ---- cadence settings (moved here from the header) ---- */
  const setts = cs?.settings;
  const saveSettings = async (next: NonNullable<CsData["settings"]>) => {
    setCs((d) => (d ? { ...d, settings: next } : d));
    const e = await saveCsSettings(next);
    if (e) say(e);
  };
  const priCount = (p: CsPriority | null) => accounts.filter((c) => (c.priority ?? null) === p).length;

  const sub = [
    { key: "sequences" as const, label: "Sequences", n: sequences.length },
    { key: "blueprints" as const, label: "E-mail blueprints", n: templates.length },
    { key: "activity" as const, label: "Activity", n: log.filter((l) => new Date(l.sent_at).getTime() > since30).length },
    { key: "cadence" as const, label: "Priorities & cadence" },
  ];
  return (
    <div className="cs4-fu">
      <div className="cs4-fu-top">
        <div className="cs4-seg is-light" role="tablist">
          {sub.map((x) => <button key={x.key} type="button" role="tab" aria-selected={view === x.key} className={view === x.key ? "is-on" : ""} onClick={() => setView(x.key)}>{x.label}{x.n != null && <em>{x.n}</em>}</button>)}
        </div>
        <span className={`cs4-mailst ${mail?.mail ? "is-ok" : mail ? "is-warn" : ""}`} title="E-mails go out from each client's owner's Outlook (or yours, as the sequence says)">
          <i />{mail == null ? "Sent from your team's Outlook" : mail.mail ? `Your Outlook: ${mail.email ?? "connected"}` : mail.connected ? "Your Outlook has no mail permission — reconnect it with mail" : "Connect your Outlook (Settings › Interface)"}
        </span>
        <span className="csx-sp" />
        {view === "sequences" && <button type="button" className="csx-ghost is-sm" disabled={!ready} onClick={onSendDue}><CsIco n="play" s={12} />Send what's due now</button>}
        {view === "sequences" && <button type="button" className="csx-primary is-sm" disabled={!ready} onClick={() => setSeq(newSeq())}><CsIco n="plus" s={13} />New sequence</button>}
        {view === "blueprints" && <button type="button" className="csx-primary is-sm" disabled={!ready} onClick={() => setTpl(newTpl())}><CsIco n="plus" s={13} />New blueprint</button>}
      </div>

      {!auto ? <PageLoader label="Reading the automations" /> : !ready ? <div className="cs4-fu-scroll"><CsLocked what="Automatic e-mails" /><p className="cs3-empty">Run <code>88_cs_followups.sql</code> in Supabase.</p></div> : (
        <div className="cs4-fu-scroll">
          {view === "sequences" && (sequences.length ? (
            <div className="cs4-seqs">
              {sequences.map((q, i) => {
                const mine = runs.filter((r) => r.sequence_id === q.id);
                const inIt = mine.filter((r) => r.status === "active").length;
                const fits = accounts.filter((c) => csFits(q, c)).length;
                const sent = log.filter((l) => l.sequence_id === q.id && l.status === "sent" && new Date(l.sent_at).getTime() > since30).length;
                const failed = log.filter((l) => l.sequence_id === q.id && l.status === "failed" && new Date(l.sent_at).getTime() > since30).length;
                const next = mine.filter((r) => r.status === "active" && r.next_at).sort((a, b) => a.next_at!.localeCompare(b.next_at!))[0];
                return (
                  <article key={q.id} className={`cs4-seq ${q.active ? "is-on" : ""}`} style={{ ["--i" as any]: i }}>
                    <header>
                      <span className="cs4-seq-ico"><CsIco n="mail" s={16} /></span>
                      <div className="cs4-seq-t"><b>{q.name}</b><i>{audienceText(q, types, accounts)} · {q.start_mode === "before_renewal" ? `starts ${q.start_days} days before each renewal` : q.repeat ? `starts right away · again every ${q.start_days} days` : "starts right away"}</i></div>
                      <button type="button" role="switch" aria-checked={q.active} className={`csx-switch ${q.active ? "is-on" : ""}`} onClick={() => toggleSeq(q)}><i />{q.active ? "On" : "Off"}</button>
                    </header>
                    <ol className="cs4-seq-steps">
                      {q.steps.map((st, k) => (
                        <li key={st.id}>
                          <span className="cs4-seq-wait">{k === 0 ? (q.start_mode === "before_renewal" ? "Start" : st.wait_days ? `+${st.wait_days} d` : "Day 0") : `+${st.wait_days} d`}</span>
                          <span className="cs4-seq-dot" />
                          <span className="cs4-seq-name">{tplName(st.template_id)}</span>
                        </li>
                      ))}
                      {q.repeat && <li className="is-loop"><span className="cs4-seq-wait"><CsIco n="repeat" s={11} />{q.start_mode === "before_renewal" ? "" : ` +${q.start_days} d`}</span><span className="cs4-seq-dot" /><span className="cs4-seq-name">and again</span></li>}
                    </ol>
                    <div className="cs4-seq-stats">
                      <span title={`${fits} client${fits === 1 ? "" : "s"} match it`}><b>{q.active ? inIt : fits}</b><i>{q.active ? "in it" : "would get it"}</i></span>
                      <span title="In the last 30 days"><b>{sent}</b><i>sent (30 d)</i></span>
                      {failed > 0 && <span className="is-bad" title="In the last 30 days — see Activity"><b>{failed}</b><i>failed</i></span>}
                      <span title={next?.next_at ? csDate(next.next_at) : undefined}><b>{next?.next_at ? new Date(next.next_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}</b><i>next e-mail</i></span>
                    </div>
                    <footer>
                      <span className="cs4-seq-from" title={`To ${q.recipients === "all" ? "every contact, one e-mail each" : q.recipients === "billing" ? "the billing contact" : "the main contact"}, from ${q.sender === "owner" ? "each client's owner" : pName(q.created_by)}`}>To {q.recipients === "all" ? "every contact" : q.recipients === "billing" ? "billing" : "main contact"} · from {q.sender === "owner" ? "owner" : pName(q.created_by).split(" ")[0]}</span>
                      <span className="csx-sp" />
                      <button type="button" className="csx-ghost is-sm is-ico" title="Copy" onClick={() => dupSeq(q)}><CsIco n="repeat" s={12} /></button>
                      <button type="button" className="csx-ghost is-sm is-ico" title="Delete" onClick={() => dropSeq(q)}><CsIco n="trash" s={12} /></button>
                      <button type="button" className="csx-ghost is-sm" onClick={() => setSeq(q)}><CsIco n="edit" s={12} />Edit</button>
                    </footer>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="cs4-fu-empty">
              <span className="csx-empty-ico"><CsIco n="mail" s={22} /></span>
              <b>No automatic e-mails yet</b>
              <i>A sequence sends your e-mail blueprints to the clients you pick — say, a check-in every 30 days to high-priority clients, or a run-up 60 days before each renewal — from each client's owner's Outlook, with the client's name filled in.</i>
              <div className="cs4-fu-starts">
                <button type="button" className="csx-ghost" onClick={() => setSeq({ ...newSeq(), name: "Keep in touch · high priority", audience: { priorities: ["high"] }, repeat: true, steps: [newStep(templates[0]?.id ?? "", 0), newStep(templates[1]?.id ?? templates[0]?.id ?? "", 30)] })}><CsIco n="star" s={13} />Keep in touch with high priority</button>
                <button type="button" className="csx-ghost" onClick={() => setSeq({ ...newSeq(), name: "Renewal run-up", start_mode: "before_renewal", start_days: 60, steps: [newStep(templates[0]?.id ?? "", 0), newStep(templates[0]?.id ?? "", 30)] })}><CsIco n="repeat" s={13} />Renewal run-up</button>
                {!templates.length && <button type="button" className="csx-primary" onClick={() => { setView("blueprints"); setTpl(newTpl()); }}><CsIco n="plus" s={13} />First, an e-mail blueprint</button>}
              </div>
            </div>
          ))}

          {view === "blueprints" && (templates.length ? (
            <div className="cs4-tpls">
              {templates.map((t, i) => {
                const used = sequences.filter((q) => q.steps.some((s) => s.template_id === t.id));
                const accent = t.design?.accent || "#0a6f4d";
                return (
                  <article key={t.id} className="cs4-tpl" style={{ ["--i" as any]: i, ["--ac" as any]: accent }}>
                    <button type="button" className="cs4-tpl-prev" onClick={() => setTpl(t)} title="Edit">
                      <span className="cs4-tpl-band">{t.design?.brand && <small>{fillCsTags(t.design.brand, csVarsFor(null, "", ""), false)}</small>}<b>{fillCsTags(t.design?.title || t.subject || t.name, csVarsFor(null, "", ""), false)}</b></span>
                      <span className="cs4-tpl-body">{fillCsTags(plainOf(t.body_html), csVarsFor(null, "", ""), false).slice(0, 220)}</span>
                      {t.design?.button_label && <span className="cs4-tpl-btn">{t.design.button_label}</span>}
                    </button>
                    <div className="cs4-tpl-m">
                      <b>{t.name}</b>
                      <i>{t.subject ? fillCsTags(t.subject, csVarsFor(null, "", ""), false) : "No subject"}</i>
                      <span>
                        {(t.variants ?? []).length > 0 && <em className="is-ver" title={(t.variants ?? []).map((v) => v.name).join(" · ")}>{(t.variants ?? []).length + 1} versions</em>}
                        {t.attachments.length > 0 && <em><CsIco n="clip" s={10} />{t.attachments.length} file{t.attachments.length === 1 ? "" : "s"}</em>}
                        <em className={used.length ? "is-used" : ""}>{used.length ? `In ${used.length} sequence${used.length === 1 ? "" : "s"}` : "Not used yet"}</em>
                      </span>
                    </div>
                    <footer>
                      <button type="button" className="csx-ghost is-sm is-ico" title="Copy" onClick={() => dupTpl(t)}><CsIco n="repeat" s={12} /></button>
                      <button type="button" className="csx-ghost is-sm is-ico" title="Delete" onClick={() => dropTpl(t)}><CsIco n="trash" s={12} /></button>
                      <span className="csx-sp" />
                      <button type="button" className="csx-ghost is-sm" onClick={() => setTpl(t)}><CsIco n="edit" s={12} />Edit</button>
                    </footer>
                  </article>
                );
              })}
              <button type="button" className="cs4-tpl is-new" onClick={() => setTpl(newTpl())}><CsIco n="plus" s={20} /><b>New blueprint</b><i>A styled e-mail — the client's and contact's names filled in for each one</i></button>
            </div>
          ) : (
            <div className="cs4-fu-empty">
              <span className="csx-empty-ico"><CsIco n="edit" s={22} /></span>
              <b>No e-mail blueprints yet</b>
              <i>Write the e-mail once — subject, a styled body, a button, files — with fields like {"{{first_name}}"} and {"{{client}}"} filled in for each client.</i>
              <div className="cs4-fu-starts"><button type="button" className="csx-primary" onClick={() => setTpl(newTpl())}><CsIco n="plus" s={13} />New blueprint</button></div>
            </div>
          ))}

          {view === "activity" && (
            <div className="cs4-log">
              <div className="cs4-log-f">
                {(["all", "sent", "failed", "skipped", "test"] as const).map((f) => (
                  <button key={f} type="button" className={`${logF === f ? "is-on" : ""} is-${f}`} onClick={() => setLogF(f)}>
                    {f === "all" ? "Everything" : f[0].toUpperCase() + f.slice(1)}<em>{f === "all" ? log.length : log.filter((l) => l.status === f).length}</em>
                  </button>
                ))}
              </div>
              <div className="cs4-log-t">
                <div className="cs4-log-r is-head"><span>When</span><span>Client</span><span>E-mail</span><span>To</span><span>Status</span></div>
                {log.filter((l) => logF === "all" || l.status === logF).map((l) => (
                  <div className={`cs4-log-r is-${l.status}`} key={l.id}>
                    <span className="cs4-log-d"><b>{csDate(l.sent_at)}</b><i>{new Date(l.sent_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</i></span>
                    <span>{l.client_id ? <button type="button" className="cs3-name" onClick={() => onOpenClient(l.client_id!)}>{accounts.find((c) => c.id === l.client_id)?.name ?? "—"}</button> : "—"}</span>
                    <span className="cs4-log-s"><b>{l.subject || tplName(l.template_id)}</b><i>{tplName(l.template_id)}{l.sequence_id ? ` · ${sequences.find((q) => q.id === l.sequence_id)?.name ?? "deleted sequence"}` : ""} · from {pName(l.sent_by)}</i></span>
                    <span className="cs4-log-to" title={(l.to_emails ?? []).join(", ")}>{(l.to_emails ?? []).join(", ") || "—"}</span>
                    <span><em className={`cs4-st is-${l.status}`}>{l.status}</em>{l.error && <i className="cs4-log-err" title={l.error}>{l.error}</i>}</span>
                  </div>
                ))}
                {!log.filter((l) => logF === "all" || l.status === logF).length && <p className="cs3-empty">Nothing here yet. Sent e-mails, and the ones that couldn't go out (and why), show here.</p>}
              </div>
            </div>
          )}

          {view === "cadence" && setts && (
            <div className="cs4-cad">
              <section className="cs4-card">
                <h3>How often each priority hears from us</h3>
                <p className="cs4-help">Give each client a priority (in the list or its panel). An account is “to contact” once this many days pass without a logged contact — a client's own cadence, set in its panel, goes first.</p>
                <div className="cs4-cad-grid">
                  {CS_PRIORITIES.map((p) => (
                    <label key={p.key} className={`cs4-cad-c is-${PRI_TONE[p.key]}`}>
                      <span className="cs4-cad-h"><i />{p.label}<em>{priCount(p.key)} client{priCount(p.key) === 1 ? "" : "s"}</em></span>
                      <span className="cs4-cad-in">every <input type="number" min={1} value={setts.priority_cadence[p.key]}
                        onChange={(e) => setCs((d) => d ? { ...d, settings: { ...d.settings, priority_cadence: { ...d.settings.priority_cadence, [p.key]: Number(e.target.value) || 1 } } } : d)}
                        onBlur={() => cs && saveSettings(cs.settings)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /> days</span>
                    </label>
                  ))}
                  <label className="cs4-cad-c is-none">
                    <span className="cs4-cad-h"><i />No priority<em>{priCount(null)} client{priCount(null) === 1 ? "" : "s"}</em></span>
                    <span className="cs4-cad-in">every <input type="number" min={1} value={setts.default_cadence_days}
                      onChange={(e) => setCs((d) => d ? { ...d, settings: { ...d.settings, default_cadence_days: Number(e.target.value) || 30 } } : d)}
                      onBlur={() => cs && saveSettings(cs.settings)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /> days</span>
                  </label>
                </div>
              </section>
              <section className="cs4-card">
                <div className="cs4-card-h">
                  <div><h3>Follow-up tasks</h3><p className="cs4-help">When an account passes its cadence, a “get in touch” task lands on its starred owner's desk (once a day, never twice).</p></div>
                  <button type="button" role="switch" aria-checked={setts.auto_tasks} className={`csx-switch ${setts.auto_tasks ? "is-on" : ""}`} onClick={() => saveSettings({ ...setts, auto_tasks: !setts.auto_tasks })}><i />{setts.auto_tasks ? "On" : "Off"}</button>
                </div>
                <button type="button" className="csx-ghost is-sm" onClick={onRunTasks}><CsIco n="play" s={11} />Create them now</button>
              </section>
            </div>
          )}
        </div>
      )}

      {tpl && <CsTemplateEditor initial={tpl} accounts={accounts} people={people} me={me} say={say} onClose={() => setTpl(null)} onSaved={(t) => { upTpl(t); }}
        onDelete={tpl.id ? () => { const t = templates.find((x) => x.id === tpl.id); setTpl(null); if (t) dropTpl(t); } : undefined} />}
      {seq && <CsSequenceEditor initial={seq} templates={templates} accounts={accounts} runs={runs} types={types} me={me} people={people}
        onClose={() => setSeq(null)} onSaved={(q) => { upSeq(q); say(q.active ? `${q.name} saved — it's on` : `${q.name} saved`); }} onNewTemplate={() => { setSeq(null); setView("blueprints"); setTpl(newTpl()); }} />}
    </div>
  );
}

/* ---------- the blueprint editor: a form on the left, the real e-mail on the right ---------- */
/* fields show as cards in the editor and are stored as {{key}} */
const FIELD_CHIP: Record<string, string> = {
  first_name: "First name", contact_name: "Full name", client: "Client", legal_name: "Legal name",
  owner_name: "Sender", owner_first_name: "Sender's first name", owner_email: "Sender's e-mail",
  renewal_date: "Renewal date", days_to_renewal: "Days to renewal", today: "Today", year: "Year",
};
const FIELD_GROUPS: { label: string; keys: string[] }[] = [
  { label: "The person it goes to", keys: ["first_name", "contact_name"] },
  { label: "Their company", keys: ["client", "legal_name", "renewal_date", "days_to_renewal"] },
  { label: "You, the sender", keys: ["owner_name", "owner_first_name", "owner_email"] },
  { label: "Dates", keys: ["today", "year"] },
];
const chipHtml = (k: string) => `<span class="cs4-fld" contenteditable="false" data-f="${k}">${FIELD_CHIP[k] ?? k}</span>`;
const toChips = (h: string) => String(h ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (FIELD_CHIP[String(k).toLowerCase()] ? chipHtml(String(k).toLowerCase()) : m));
const fromChips = (h: string) => String(h ?? "").replace(/<span[^>]*data-f="([a-z_]+)"[^>]*>[\s\S]*?<\/span>/gi, "{{$1}}").replace(/\u200b/g, "");
const escT = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const multiOfChips = (h: string) => fromChips(h).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
const toMultiChips = (x: string) => toChips(escT(x ?? "").replace(/\n/g, "<br>"));
const textOfChips = (h: string) => fromChips(h).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function CsTemplateEditor({ initial, accounts, people, me, say, onClose, onSaved, onDelete }: {
  initial: Partial<CsTemplate>; accounts: CsClient[]; people: Employee[]; me: string | null; say: (m: string) => void;
  onClose: () => void; onSaved: (t: CsTemplate) => void; onDelete?: () => void;
}) {
  const [t, setT] = useState<Partial<CsTemplate>>({ ...initial, design: { ...(initial.design ?? {}) }, attachments: [...(initial.attachments ?? [])], variants: (initial.variants ?? []).map((v) => ({ ...v, audience: { ...(v.audience ?? {}) } })) });
  /** the version being edited: -1 the main one (everyone else), else one of t.variants */
  const [ver, setVer] = useState(-1);
  const vars_ = t.variants ?? [];
  const curV: CsVariant | null = ver >= 0 ? vars_[ver] ?? null : null;
  const cur = curV ? { subject: curV.subject, body_html: curV.body_html } : { subject: t.subject ?? "", body_html: t.body_html ?? "" };
  const patchCur = (p: { subject?: string; body_html?: string }) => setT((x) => (ver < 0 ? { ...x, ...p } : { ...x, variants: (x.variants ?? []).map((v, i) => (i === ver ? { ...v, ...p } : v)) }));
  const patchVer = (i: number, p: Partial<CsVariant>) => setT((x) => ({ ...x, variants: (x.variants ?? []).map((v, j) => (j === i ? { ...v, ...p } : v)) }));
  const setAud = (i: number, p: Partial<CsVariantAudience>) => setT((x) => ({ ...x, variants: (x.variants ?? []).map((v, j) => (j === i ? { ...v, audience: { ...(v.audience ?? {}), ...p } } : v)) }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"write" | "preview">("write");
  const [asClient, setAsClient] = useState<string>(accounts.find((a) => a.contacts.some((x) => x.email))?.id ?? accounts[0]?.id ?? "");
  const [asContact, setAsContact] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const subjRef = useRef<HTMLDivElement | null>(null);
  const signRef = useRef<HTMLDivElement | null>(null);
  const footRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const range = useRef<Range | null>(null);
  type Box = "subject" | "body" | "signoff" | "footer";
  const last = useRef<Box>("body");
  const boxOf = (w: Box) => (w === "subject" ? subjRef.current : w === "body" ? bodyRef.current : w === "signoff" ? signRef.current : footRef.current);
  const d = t.design ?? {};
  const setD = (p: Partial<NonNullable<CsTemplate["design"]>>) => setT((x) => ({ ...x, design: { ...(x.design ?? {}), ...p } }));
  const fillEditors = () => {
    if (bodyRef.current) bodyRef.current.innerHTML = toChips(cur.body_html ?? "");
    if (subjRef.current) subjRef.current.innerHTML = toChips(escT(cur.subject ?? ""));
  };
  useEffect(() => {
    if (signRef.current) signRef.current.innerHTML = toMultiChips(d.signoff ?? "");
    if (footRef.current) footRef.current.innerHTML = toMultiChips(d.footer ?? "");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view === "write") fillEditors(); }, [view, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const syncBody = () => { if (bodyRef.current) patchCur({ body_html: fromChips(bodyRef.current.innerHTML) }); };
  const syncSubj = () => { if (subjRef.current) patchCur({ subject: textOfChips(subjRef.current.innerHTML) }); };
  /** another version: starts as a copy of the main one */
  const addVersion = () => {
    if (view === "write") { syncBody(); syncSubj(); }
    setT((x) => ({ ...x, variants: [...(x.variants ?? []), { id: Math.random().toString(36).slice(2, 10), name: `Version ${(x.variants ?? []).length + 2}`, subject: x.subject ?? "", body_html: x.body_html ?? "", html: "", audience: {} }] }));
    setVer(vars_.length);
  };
  const dropVersion = (i: number) => { setT((x) => ({ ...x, variants: (x.variants ?? []).filter((_, j) => j !== i) })); setVer(-1); };
  const goVer = (i: number) => { if (i === ver) return; if (view === "write") { syncBody(); syncSubj(); } setVer(i); };
  /** who gets which version */
  const fitsV = (i: number, c: CsClient) => csVariantFor({ variants: vars_.slice(0, i + 1) }, c)?.id === vars_[i]?.id;
  const countOf = (i: number) => (i < 0 ? accounts.filter((c) => !csVariantFor(t, c)).length : accounts.filter((c) => fitsV(i, c)).length);
  const syncMulti = (w: "signoff" | "footer") => setD({ [w]: multiOfChips(boxOf(w)?.innerHTML ?? "") });
  const syncBox = (w: Box) => (w === "subject" ? syncSubj() : w === "body" ? syncBody() : syncMulti(w));
  const keepRange = (where: Box) => {
    last.current = where;
    const box = boxOf(where);
    const sel = window.getSelection();
    if (sel && sel.rangeCount && box?.contains(sel.anchorNode)) range.current = sel.getRangeAt(0).cloneRange();
  };
  const restore = (box: HTMLElement | null) => {
    box?.focus();
    const sel = window.getSelection();
    if (range.current && box?.contains(range.current.startContainer)) { sel?.removeAllRanges(); sel?.addRange(range.current); }
    else if (box) { const r = document.createRange(); r.selectNodeContents(box); r.collapse(false); sel?.removeAllRanges(); sel?.addRange(r); }
  };
  const cmd = (c: string, v?: string) => { restore(bodyRef.current); document.execCommand(c, false, v); syncBody(); keepRange("body"); };
  const addField = (key: string) => {
    const go = () => {
      const w = last.current, box = boxOf(w);
      restore(box);
      // put the card exactly at the caret (execCommand would push it out of the paragraph at a line's end)
      const sel = window.getSelection();
      if (box && sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        const tmp = document.createElement("span"); tmp.innerHTML = chipHtml(key);
        const chip = tmp.firstChild as Node; const after = document.createTextNode("\u200b");
        r.insertNode(after); r.insertNode(chip);
        const c2 = document.createRange(); c2.setStartAfter(after); c2.collapse(true);
        sel.removeAllRanges(); sel.addRange(c2);
      }
      syncBox(w); keepRange(w);
    };
    if (view !== "write" && (last.current === "subject" || last.current === "body")) { setView("write"); window.setTimeout(go, 30); } else go();
  };
  const owner = people.find((p) => p.id === me);
  const c = accounts.find((x) => x.id === asClient) ?? null;
  const cts = (c?.contacts ?? []).filter((x) => x.email);
  const who = cts[Math.min(asContact, Math.max(0, cts.length - 1))] ?? null;
  const base = csVarsFor(c, owner?.name ?? "", owner?.email ?? "");
  const vars = who ? { ...base, contact_name: capName(who.name ?? ""), first_name: capName(String(who.name ?? "").trim().split(/\s+/)[0]) || "there" } : base;
  const html = renderCsEmail({ body_html: cur.body_html ?? "", design: d });
  const preview = fillCsTags(html, vars, true);
  const clientGets = c ? csVariantFor(t, c) : null;
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const f of Array.from(files)) {
      const r = await uploadCsFile(f);
      if (r.error || !r.file) { setErr(r.error); continue; }
      setT((x) => ({ ...x, attachments: [...(x.attachments ?? []), r.file!] }));
    }
    setBusy(false);
  };
  const total = (t.attachments ?? []).reduce((sum, a) => sum + a.size, 0);
  const setAtt = (path: string, p: Partial<CsAttachment>) => setT((x) => ({ ...x, attachments: (x.attachments ?? []).map((y) => (y.path === path ? { ...y, ...p } : y)) }));
  // files attached before fields could be read: read them now
  useEffect(() => {
    (t.attachments ?? []).filter((a) => !a.kind).forEach(async (a) => {
      const { data } = await supabase.storage.from("cs-files").download(a.path);
      if (data) setAtt(a.path, await inspectCsFile(data, a.name, a.type));
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [peek, setPeek] = useState<string | null>(null);
  /** the attachment as the client in the preview gets it */
  const seeAtt = async (a: CsAttachment) => {
    setPeek(a.path);
    const w = window.open("", "_blank");
    const r = await previewCsAttachment(a, c?.id ?? null);
    setPeek(null);
    if (!r.blob) { w?.close(); setErr(r.error ?? "Couldn't open it."); return; }
    const url = URL.createObjectURL(r.blob);
    if (w) w.location.href = url; else window.open(url, "_blank");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const dnd = {
    onDragEnter: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDragging(true); },
    onDragOver: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; },
    onDragLeave: (e: React.DragEvent) => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); },
    onDrop: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current = 0; setDragging(false); upload(e.dataTransfer.files); },
  };
  const save = async (andTest = false) => {
    // what is in the editors belongs to the version on screen
    const eSubj = view === "write" && subjRef.current ? textOfChips(subjRef.current.innerHTML) : cur.subject;
    const eBody = view === "write" && bodyRef.current ? fromChips(bodyRef.current.innerHTML) : cur.body_html;
    const subject = ver < 0 ? eSubj : (t.subject ?? "");
    const body = cleanCsBody(ver < 0 ? eBody : (t.body_html ?? ""));
    const variants = vars_.map((v, i) => {
      const vs = i === ver ? eSubj : v.subject, vb = cleanCsBody(i === ver ? eBody : v.body_html);
      return { ...v, name: v.name.trim() || `Version ${i + 2}`, subject: vs, body_html: vb, html: renderCsEmail({ body_html: vb, design: d }) };
    });
    if (!t.name?.trim()) { setErr("Give it a name."); return null; }
    if (!subject.trim()) { setErr("Give the main version a subject."); setVer(-1); return null; }
    const noSubj = variants.findIndex((v) => !v.subject.trim());
    if (noSubj >= 0) { setErr(`Give “${variants[noSubj].name}” a subject.`); setVer(noSubj); return null; }
    const noWho = variants.findIndex((v) => !(v.audience?.clients?.length || v.audience?.owners?.length || v.audience?.priorities?.length || v.audience?.health?.length));
    if (noWho >= 0) { setErr(`Say who gets “${variants[noWho].name}”.`); setVer(noWho); return null; }
    if (total > 3_000_000) { setErr("The files add up to more than 3 MB — e-mails can't carry that."); return null; }
    setBusy(true); setErr(null);
    const r = await saveCsTemplate({ ...t, subject, body_html: body, html: renderCsEmail({ body_html: body, design: d }), variants });
    setBusy(false);
    if (r.error || !r.row) { setErr(r.error ?? "Not saved."); return null; }
    setT(r.row); onSaved(r.row);
    if (!andTest) { say(`${r.row.name} saved`); onClose(); }
    return r.row;
  };
  const test = async () => {
    const row = await save(true);
    if (!row) return;
    setBusy(true);
    const r = await testCsTemplate(row.id, c?.id ?? null);
    setBusy(false);
    if (r.error) setErr(/unknown action/i.test(r.error) ? "The e-mail sender isn't installed yet (outlook-sync)." : r.error);
    else say(`Test sent to ${r.to ?? "you"} — filled in for ${c?.name ?? "a client"}`);
  };
  /** The card right before (or after) the caret, skipping the invisible spacer that follows each card. */
  const chipNear = (box: HTMLElement, back: boolean): HTMLElement | null => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    let node: Node | null = sel.anchorNode; let off = sel.anchorOffset;
    if (!node || !box.contains(node)) return null;
    const isZ = (n: Node | null) => !!n && n.nodeType === 3 && /^[\u200b]*$/.test(n.textContent ?? "");
    const isChip = (n: Node | null): n is HTMLElement => !!n && n.nodeType === 1 && (n as HTMLElement).classList.contains("cs4-fld");
    if (node.nodeType === 3) {
      const txt = node.textContent ?? "";
      const rest = back ? txt.slice(0, off) : txt.slice(off);
      if (rest.replace(/\u200b/g, "").length) return null;
      let sib: Node | null = back ? node.previousSibling : node.nextSibling;
      while (isZ(sib)) sib = back ? sib!.previousSibling : sib!.nextSibling;
      return isChip(sib) ? sib : null;
    }
    let sib: Node | null = back ? node.childNodes[off - 1] ?? null : node.childNodes[off] ?? null;
    while (isZ(sib)) sib = back ? sib!.previousSibling : sib!.nextSibling;
    return isChip(sib) ? sib : null;
  };
  const dropChip = (chip: HTMLElement, w: Box) => {
    const z = chip.nextSibling;
    if (z && z.nodeType === 3 && /^\u200b/.test(z.textContent ?? "")) z.textContent = (z.textContent ?? "").replace(/^\u200b/, "");
    const sel = window.getSelection(); const r = document.createRange();
    r.setStartBefore(chip); r.collapse(true);
    chip.remove(); sel?.removeAllRanges(); sel?.addRange(r);
    syncBox(w); keepRange(w);
  };
  const chipKeys = (e: React.KeyboardEvent<HTMLElement>, w: Box) => {
    const box = e.currentTarget;
    if (e.key !== "Backspace" && e.key !== "Delete") { box.querySelectorAll(".cs4-fld.is-picked").forEach((x) => x.classList.remove("is-picked")); return false; }
    const picked = box.querySelector(".cs4-fld.is-picked") as HTMLElement | null;
    const chip = picked ?? chipNear(box, e.key === "Backspace");
    if (!chip) return false;
    e.preventDefault(); dropChip(chip, w); return true;
  };
  const chipClick = (e: React.MouseEvent<HTMLElement>, w: Box) => {
    const box = e.currentTarget;
    box.querySelectorAll(".cs4-fld.is-picked").forEach((x) => x.classList.remove("is-picked"));
    const chip = (e.target as HTMLElement).closest?.(".cs4-fld") as HTMLElement | null;
    if (!chip || !box.contains(chip)) return;
    const rc = chip.getBoundingClientRect();
    if (e.clientX >= rc.right - 18) { e.preventDefault(); dropChip(chip, w); return; }   // the × on its right
    chip.classList.add("is-picked");   // picked: Backspace / Delete removes it
  };
  const plainPaste = (e: React.ClipboardEvent, single: boolean) => {
    e.preventDefault();
    const txt = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, single ? txt.replace(/\s+/g, " ") : txt);
  };
  return createPortal(
    <div className="csx-modal-bg cs4-ed-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`cs4-ed is-bp ${dragging ? "is-drop" : ""}`} role="dialog" aria-modal="true" aria-label="E-mail blueprint" {...dnd}>
        {dragging && <div className="cs4-bp-drop" aria-hidden="true"><span><CsIco n="clip" s={22} /><b>Drop to attach</b><i>Up to 3 MB in all</i></span></div>}
        <header className="cs4-ed-h">
          <span className="csx-modal-ico"><CsIco n="mail" s={18} /></span>
          <div className="cs4-ed-ht"><span className="csx-eyebrow">{t.id ? "E-mail blueprint" : "New e-mail blueprint"}</span>
            <input className="cs4-ed-name" value={t.name ?? ""} onChange={(e) => setT((x) => ({ ...x, name: e.target.value }))} placeholder="Name it — e.g. Quarterly check-in" aria-label="Blueprint name" autoFocus={!t.id} /></div>
          <button type="button" className="csx-x" onClick={onClose} aria-label="Close"><CsIco n="x" /></button>
        </header>
        <div className="cs4-bp">
          <div className="cs4-bp-main">
            <div className="cs4-bp-vers" role="tablist" aria-label="Versions">
              <button type="button" role="tab" aria-selected={ver < 0} className={`cs4-bp-ver ${ver < 0 ? "is-on" : ""}`} onClick={() => goVer(-1)}>
                <b>Main version</b><i>{vars_.length ? `everyone else · ${countOf(-1)}` : `all clients · ${accounts.length}`}</i>
              </button>
              {vars_.map((v, i) => (
                <button key={v.id} type="button" role="tab" aria-selected={ver === i} className={`cs4-bp-ver ${ver === i ? "is-on" : ""}`} onClick={() => goVer(i)}>
                  <b>{v.name || `Version ${i + 2}`}</b><i>{countOf(i)} client{countOf(i) === 1 ? "" : "s"}</i>
                </button>
              ))}
              <button type="button" className="cs4-bp-ver is-add" onClick={addVersion} title="The same e-mail in other words, for some of the clients"><CsIco n="plus" s={13} />Add a version</button>
            </div>
            <div className="cs4-bp-top">
              <div className="cs4-seg is-light" role="tablist" aria-label="Write or preview">
                <button type="button" role="tab" aria-selected={view === "write"} className={view === "write" ? "is-on" : ""} onClick={() => setView("write")}><CsIco n="edit" s={13} />Write</button>
                <button type="button" role="tab" aria-selected={view === "preview"} className={view === "preview" ? "is-on" : ""} onClick={() => { syncBody(); syncSubj(); setView("preview"); }}><CsIco n="eye" s={13} />Preview</button>
              </div>
              {view === "preview" && (
                <div className="cs4-bp-as">
                  <span>As sent to</span>
                  <span className="cs4-bp-as-c"><Select size="sm" value={asClient} onChange={(v) => { setAsClient(v); setAsContact(0); }} searchable placeholder="A sample client" options={[{ value: "", label: "A sample client" }, ...accounts.map((x) => ({ value: x.id, label: x.name }))]} /></span>
                  {clientGets?.id !== curV?.id && <em className="cs4-bp-gets">gets {clientGets ? `“${clientGets.name}”` : "the main version"}</em>}
                  {cts.length > 1 && <span className="cs4-bp-as-p"><Select size="sm" value={String(asContact)} onChange={(v) => setAsContact(Number(v))} options={cts.map((x, i) => ({ value: String(i), label: x.name || x.email || "Contact" }))} /></span>}
                </div>
              )}
            </div>
            {view === "write" ? (
              <>
                <div className="cs4-bp-subj">
                  <span>Subject</span>
                  <div ref={subjRef} className="cs4-bp-line" contentEditable suppressContentEditableWarning role="textbox" aria-label="Subject" data-ph="How is everything going?"
                    onInput={syncSubj} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); else chipKeys(e, "subject"); }} onMouseDown={(e) => chipClick(e, "subject")} onPaste={(e) => { plainPaste(e, true); syncSubj(); }}
                    onKeyUp={() => keepRange("subject")} onMouseUp={() => keepRange("subject")} onFocus={() => { last.current = "subject"; }} onBlur={() => { keepRange("subject"); syncSubj(); }} />
                </div>
                <div className="cs4-rte cs4-bp-rte">
                  <div className="cs4-rte-bar" onMouseDown={(e) => e.preventDefault()}>
                    <button type="button" onClick={() => cmd("bold")} title="Bold"><b>B</b></button>
                    <button type="button" onClick={() => cmd("italic")} title="Italic"><i>I</i></button>
                    <button type="button" onClick={() => cmd("underline")} title="Underline"><u>U</u></button>
                    <span />
                    <button type="button" onClick={() => cmd("insertUnorderedList")} title="Bullets">• List</button>
                    <button type="button" onClick={() => cmd("insertOrderedList")} title="Numbered">1. List</button>
                    <button type="button" onClick={() => { const u = window.prompt("Link to (https://…)"); if (u) cmd("createLink", u); }} title="Link">Link</button>
                    <button type="button" onClick={() => cmd("removeFormat")} title="Plain text">Clear</button>
                  </div>
                  <div ref={bodyRef} className="cs4-rte-body" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Message"
                    onInput={syncBody} onKeyDown={(e) => chipKeys(e, "body")} onMouseDown={(e) => chipClick(e, "body")} onKeyUp={() => keepRange("body")} onMouseUp={() => keepRange("body")} onFocus={() => { last.current = "body"; }} onBlur={() => { keepRange("body"); syncBody(); }} />
                </div>
              </>
            ) : (
              <div className="cs4-ed-mail cs4-bp-mail">
                <div className="cs4-ed-env">
                  <span><i>From</i>{owner?.name ?? "You"} {owner?.email ? `<${owner.email}>` : ""}</span>
                  <span><i>To</i>{who ? `${who.name ? `${who.name} ` : ""}<${who.email}>` : c ? "no e-mail on file" : "laura@client.com"}{cts.length > 1 ? ` · each of the ${cts.length} contacts gets their own` : ""}</span>
                  <span><i>Subject</i><b>{fillCsTags(cur.subject ?? "", vars, false) || "—"}</b></span>
                  {(t.attachments ?? []).length > 0 && <span><i>Files</i>{(t.attachments ?? []).map((a) => a.name).join(", ")}</span>}
                </div>
                <iframe title="E-mail preview" className="cs4-ed-frame" srcDoc={preview} sandbox="" />
              </div>
            )}
          </div>

          <aside className="cs4-bp-side">
            {curV && (
              <section className="cs4-bp-sec cs4-bp-who">
                <div className="cs4-bp-who-h">
                  <input value={curV.name} onChange={(e) => patchVer(ver, { name: e.target.value })} aria-label="Version name" placeholder="Name this version" />
                  <button type="button" className="csx-ghost is-sm is-danger" onClick={() => dropVersion(ver)} title="Delete this version"><CsIco n="trash" s={12} /></button>
                </div>
                <h4>Who gets this version</h4>
                <div className="csx-f"><span>Clients looked after by</span>
                  <SalesMultiFilter values={curV.audience?.owners ?? []} onChange={(v) => setAud(ver, { owners: v })} options={people.map((p) => ({ value: p.id, label: p.name }))} placeholder="Anyone" noun="people" searchFrom={6} />
                </div>
                <div className="cs4-chiprow"><span>Priority</span>
                  {[...CS_PRIORITIES.map((p) => ({ k: p.key as string, l: p.label, tone: PRI_TONE[p.key] })), { k: "none", l: "None", tone: "none" }].map((x) => (
                    <button key={x.k} type="button" className={`cs4-chip is-${x.tone} ${(curV.audience?.priorities ?? []).includes(x.k) ? "is-on" : ""}`}
                      onClick={() => { const xs = curV.audience?.priorities ?? []; setAud(ver, { priorities: xs.includes(x.k) ? xs.filter((y) => y !== x.k) : [...xs, x.k] }); }}><i />{x.l}</button>
                  ))}
                </div>
                <div className="cs4-chiprow"><span>Health</span>
                  {HEALTH_KEYS.map((h) => (
                    <button key={h.key} type="button" className={`cs4-chip is-h-${h.key} ${(curV.audience?.health ?? []).includes(h.key) ? "is-on" : ""}`}
                      onClick={() => { const xs = curV.audience?.health ?? []; setAud(ver, { health: xs.includes(h.key) ? xs.filter((y) => y !== h.key) : [...xs, h.key] }); }}><i />{h.label}</button>
                  ))}
                </div>
                <div className="csx-f"><span>Or exactly these clients</span>
                  <SalesMultiFilter values={curV.audience?.clients ?? []} onChange={(v) => setAud(ver, { clients: v })} options={accounts.map((x) => ({ value: x.id, label: x.name }))} placeholder="Pick clients…" noun="clients" searchFrom={6} />
                </div>
                <p className="cs4-help">{curV.audience?.clients?.length ? "Only the clients picked get it (the rules above are left aside)." : "Every rule filled in must hold. "}A client gets the first version that applies to it; everyone else, the main one.</p>
                {(() => {
                  const fit = accounts.filter((x) => fitsV(ver, x));
                  return (
                    <div className="cs4-bp-fit">
                      <b>{fit.length} client{fit.length === 1 ? "" : "s"} get this version</b>
                      {fit.length > 0 && <span>{fit.slice(0, 8).map((x) => x.name).join(", ")}{fit.length > 8 ? ` and ${fit.length - 8} more` : ""}</span>}
                    </div>
                  );
                })()}
              </section>
            )}
            <section className="cs4-bp-sec">
              <h4>Look{vars_.length ? <em className="cs4-bp-shared"> · the same for every version</em> : null}</h4>
              <div className="csx-f-row">
                <label className="csx-f"><span>Small line on top</span><input value={d.brand ?? ""} onChange={(e) => setD({ brand: e.target.value })} placeholder="Your company" /></label>
                <label className="csx-f"><span>Headline</span><input value={d.title ?? ""} onChange={(e) => setD({ title: e.target.value })} placeholder="Quarterly check-in" /></label>
              </div>
              <div className="csx-f"><span>Colour</span>
                <span className="cs4-ed-acc">
                  {ACCENTS.map((a) => <button key={a} type="button" className={(d.accent ?? "#0a6f4d") === a ? "is-on" : ""} style={{ background: a }} onClick={() => setD({ accent: a })} aria-label={`Colour ${a}`} />)}
                  <label className="cs4-ed-acc-c" title="Any colour"><input type="color" value={d.accent ?? "#0a6f4d"} onChange={(e) => setD({ accent: e.target.value })} /></label>
                </span>
              </div>
              <div className="csx-f-row">
                <label className="csx-f"><span>Button text</span><input value={d.button_label ?? ""} onChange={(e) => setD({ button_label: e.target.value })} placeholder="Book a call" /></label>
                <label className="csx-f"><span>Button link</span><input value={d.button_url ?? ""} onChange={(e) => setD({ button_url: e.target.value })} placeholder="https://…" /></label>
              </div>
              <div className="csx-f-row">
                {(["signoff", "footer"] as const).map((w) => (
                  <div key={w} className="csx-f"><span>{w === "signoff" ? "Sign-off" : "Footer (small print)"}</span>
                    <div ref={w === "signoff" ? signRef : footRef} className="cs4-bp-box" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={w === "signoff" ? "Sign-off" : "Footer"}
                      data-ph={w === "signoff" ? "Best regards," : "Address, unsubscribe line…"}
                      onInput={() => syncMulti(w)} onPaste={(e) => { plainPaste(e, false); syncMulti(w); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); document.execCommand("insertLineBreak"); syncMulti(w); } else chipKeys(e, w); }} onMouseDown={(e) => chipClick(e, w)}
                      onKeyUp={() => keepRange(w)} onMouseUp={() => keepRange(w)} onFocus={() => { last.current = w; }} onBlur={() => { keepRange(w); syncMulti(w); }} />
                  </div>
                ))}
              </div>
              <div className="csx-f"><span>Files attached <em className={total > 3_000_000 ? "is-bad" : ""}>{fmtSize(total)} of 3 MB</em></span>
                <div className="cs4-files is-rich">
                  {(t.attachments ?? []).map((a) => {
                    const fieldNames = Object.keys(a.fields ?? {});
                    const fills = [...new Set([...(a.tags ?? []), ...Object.values(a.fields ?? {}).filter(Boolean)])];
                    return (
                      <div key={a.path} className="cs4-att">
                        <div className="cs4-att-h">
                          <span className="cs4-att-ico"><CsIco n="clip" s={12} /></span>
                          <span className="cs4-att-n"><b title={a.name}>{a.name}</b><i>{fmtSize(a.size)}{a.kind === "pdf" ? " · PDF" : a.kind === "text" ? " · text" : ""}</i></span>
                          <button type="button" className="csx-ghost is-sm is-ico" disabled={!!peek} title={`See it as ${c?.name ?? "a client"} gets it`} onClick={() => seeAtt(a)}><CsIco n="eye" s={12} /></button>
                          <button type="button" className="csx-ghost is-sm is-ico" onClick={async () => { setT((x) => ({ ...x, attachments: (x.attachments ?? []).filter((y) => y.path !== a.path) })); if (!initial.attachments?.some((y) => y.path === a.path)) await removeCsFile(a.path); }} aria-label={`Remove ${a.name}`} title="Remove"><CsIco n="x" s={11} /></button>
                        </div>
                        {fieldNames.length > 0 && (
                          <div className="cs4-att-map">
                            <em>Form fields in it</em>
                            {fieldNames.map((fn) => (
                              <label key={fn} className="cs4-att-row">
                                <code title={fn}>{fn}</code><CsIco n="arrow" s={11} />
                                <select value={a.fields?.[fn] ?? ""} onChange={(e) => setAtt(a.path, { fields: { ...(a.fields ?? {}), [fn]: e.target.value } })}>
                                  <option value="">Leave as it is</option>
                                  {Object.entries(FIELD_CHIP).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                                </select>
                              </label>
                            ))}
                          </div>
                        )}
                        {fills.length > 0
                          ? <div className="cs4-att-fills"><em>Filled in for each client:</em>{fills.map((k) => <i key={k} className="cs4-fld">{FIELD_CHIP[k] ?? k}</i>)}</div>
                          : (a.kind === "pdf" || a.kind === "text") && <p className="cs4-att-note">Nothing to fill in yet: write <code>{"{{client}}"}</code> (or another field) in the file{a.kind === "pdf" ? ", or give the PDF form fields" : ""}, and attach it again.</p>}
                      </div>
                    );
                  })}
                  <button type="button" className="cs4-file is-add" disabled={busy} onClick={() => fileRef.current?.click()}><CsIco n="plus" s={12} />Attach or drop files</button>
                  <input ref={fileRef} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
                </div>
              </div>
            </section>
            <section className="cs4-bp-sec">
              <h4>Insert a field</h4>
              <p className="cs4-bp-hint">Click where it goes, then pick one. Each contact gets their own e-mail: “Hi <i className="cs4-fld">First name</i> and the <i className="cs4-fld">Client</i> team”.</p>
              {FIELD_GROUPS.map((g) => (
                <div key={g.label} className="cs4-bp-grp">
                  <b>{g.label}</b>
                  <div className="cs4-bp-flds">
                    {g.keys.map((k) => (
                      <button key={k} type="button" className="cs4-bp-fld" onMouseDown={(e) => e.preventDefault()} onClick={() => addField(k)} title={`Insert “${FIELD_CHIP[k]}” — e.g. ${vars[k] || "—"}`}>
                        <CsIco n="plus" s={11} />{FIELD_CHIP[k]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          </aside>
        </div>
        {err && <p className="csx-err cs4-ed-err">{err}</p>}
        <footer className="csx-modal-f">
          {onDelete && <button type="button" className="csx-ghost is-danger" onClick={onDelete}><CsIco n="trash" s={14} />Delete</button>}
          <span className="csx-sp" />
          <button type="button" className="csx-ghost" disabled={busy} onClick={test} title="Saves it and sends it to you, filled in for the client in the preview (the version that client gets)"><CsIco n="mail" s={14} />Send me a test</button>
          <button type="button" className="csx-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="csx-primary" disabled={busy} onClick={() => save(false)}>{busy ? "Saving…" : "Save blueprint"}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- the sequence editor: who, when, which e-mails ---------- */
function CsSequenceEditor({ initial, templates, accounts, runs, types, me, people, onClose, onSaved, onNewTemplate }: {
  initial: Partial<CsSequence>; templates: CsTemplate[]; accounts: CsClient[]; runs: CsRun[]; types: { id: string; name: string }[];
  me: string | null; people: Employee[];
  onClose: () => void; onSaved: (q: CsSequence) => void; onNewTemplate: () => void;
}) {
  const [q, setQ] = useState<Partial<CsSequence>>({ ...initial, audience: { ...(initial.audience ?? {}) }, steps: [...(initial.steps ?? [])] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [who, setWho] = useState<"filters" | "picked">((initial.audience?.clients?.length ?? 0) > 0 ? "picked" : "filters");
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".smf-menu, .sel-menu")) onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const a = q.audience ?? {};
  const setA = (p: Partial<NonNullable<CsSequence["audience"]>>) => setQ((x) => ({ ...x, audience: { ...(x.audience ?? {}), ...p } }));
  const tog = (k: "priorities" | "types" | "health", v: string) => { const cur = a[k] ?? []; setA({ [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] }); };
  const steps = q.steps ?? [];
  const setStep = (i: number, p: Partial<CsStep>) => setQ((x) => ({ ...x, steps: (x.steps ?? []).map((s, j) => (j === i ? { ...s, ...p } : s)) }));
  const moveStep = (i: number, dir: -1 | 1) => setQ((x) => { const xs = [...(x.steps ?? [])]; const j = i + dir; if (j < 0 || j >= xs.length) return x; [xs[i], xs[j]] = [xs[j], xs[i]]; return { ...x, steps: xs }; });
  const full = { ...q, audience: who === "picked" ? { clients: a.clients ?? [], exclude: a.exclude ?? [] } : { ...a, clients: [] } } as CsSequence;
  const fits = accounts.filter((c) => csFits(full, c));
  const people_n = fits.reduce((n, c) => n + csTo(full, c, runs.find((r) => r.sequence_id === q.id && r.client_id === c.id) ?? null).length, 0);
  const totalDays = steps.reduce((t, s, i) => t + (i === 0 && q.start_mode === "before_renewal" ? 0 : Number(s.wait_days) || 0), 0);
  const save = async (activate?: boolean) => {
    if (!q.name?.trim()) { setErr("Give it a name."); return; }
    const st = steps.filter((s) => s.template_id);
    if (!st.length) { setErr("Pick the e-mail of at least one step."); return; }
    if (who === "picked" && !(a.clients ?? []).length) { setErr("Pick the clients it goes to."); return; }
    setBusy(true); setErr(null);
    const r = await saveCsSequence({ ...full, steps: st, active: activate ?? q.active });
    setBusy(false);
    if (r.error || !r.row) { setErr(r.error ?? "Not saved."); return; }
    onSaved({ ...r.row, audience: r.row.audience ?? {}, steps: r.row.steps ?? [] }); onClose();
  };
  const inNow = q.id ? runs.filter((r) => r.sequence_id === q.id && r.status === "active").length : 0;
  const clientOpts = accounts.map((c) => ({ value: c.id, label: c.name }));
  return createPortal(
    <div className="csx-modal-bg cs4-ed-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cs4-ed is-seq" role="dialog" aria-modal="true" aria-label="Follow-up sequence">
        <header className="cs4-ed-h">
          <span className="csx-modal-ico"><CsIco n="repeat" s={18} /></span>
          <div className="cs4-ed-ht"><span className="csx-eyebrow">{q.id ? "Follow-up sequence" : "New follow-up sequence"}</span>
            <input className="cs4-ed-name" value={q.name ?? ""} onChange={(e) => setQ((x) => ({ ...x, name: e.target.value }))} placeholder="Name it — e.g. Keep in touch · high priority" aria-label="Sequence name" autoFocus={!q.id} /></div>
          <button type="button" role="switch" aria-checked={!!q.active} className={`csx-switch ${q.active ? "is-on" : ""}`} onClick={() => setQ((x) => ({ ...x, active: !x.active }))}><i />{q.active ? "On" : "Off"}</button>
          <button type="button" className="csx-x" onClick={onClose} aria-label="Close"><CsIco n="x" /></button>
        </header>
        <div className="cs4-ed-b">
          <div className="cs4-ed-form">
            <section className="cs4-ed-sec">
              <h4><span>1</span>Who gets it</h4>
              <div className="cs4-seg is-light is-sm">
                <button type="button" className={who === "filters" ? "is-on" : ""} onClick={() => setWho("filters")}>Clients that match</button>
                <button type="button" className={who === "picked" ? "is-on" : ""} onClick={() => setWho("picked")}>Only the clients I pick</button>
              </div>
              {who === "filters" ? <>
                <div className="cs4-chiprow"><span>Priority</span>
                  {[...CS_PRIORITIES.map((p) => ({ k: p.key as string, l: p.label, tone: PRI_TONE[p.key] })), { k: "none", l: "No priority", tone: "none" }].map((x) => (
                    <button key={x.k} type="button" className={`cs4-chip is-${x.tone} ${(a.priorities ?? []).includes(x.k) ? "is-on" : ""}`} onClick={() => tog("priorities", x.k)}><i />{x.l}</button>
                  ))}
                </div>
                {types.length > 0 && <div className="cs4-chiprow"><span>Type</span>
                  {types.map((t) => <button key={t.id} type="button" className={`cs4-chip ${(a.types ?? []).includes(t.id) ? "is-on" : ""}`} onClick={() => tog("types", t.id)}>{t.name}</button>)}
                </div>}
                <div className="cs4-chiprow"><span>Health</span>
                  {HEALTH_KEYS.map((h) => <button key={h.key} type="button" className={`cs4-chip is-h-${h.key} ${(a.health ?? []).includes(h.key) ? "is-on" : ""}`} onClick={() => tog("health", h.key)}><i />{h.label}</button>)}
                </div>
                <p className="cs4-help">Nothing ticked in a row means any. Clients join and leave as they start or stop matching.</p>
              </> : (
                <div className="csx-f"><span>Clients</span>
                  <SalesMultiFilter values={a.clients ?? []} onChange={(v) => setA({ clients: v })} options={clientOpts} placeholder="Pick clients…" noun="clients" searchFrom={6} />
                </div>
              )}
              <div className="csx-f"><span>Never to</span>
                <SalesMultiFilter values={a.exclude ?? []} onChange={(v) => setA({ exclude: v })} options={clientOpts} placeholder="Nobody left out" noun="clients" searchFrom={6} />
              </div>
            </section>

            <section className="cs4-ed-sec">
              <h4><span>2</span>When it starts</h4>
              <div className="cs4-opts">
                <button type="button" className={q.start_mode !== "before_renewal" ? "is-on" : ""} onClick={() => setQ((x) => ({ ...x, start_mode: "now" }))}><b>Right away</b><i>As soon as a client is in</i></button>
                <button type="button" className={q.start_mode === "before_renewal" ? "is-on" : ""} onClick={() => setQ((x) => ({ ...x, start_mode: "before_renewal" }))}><b>Before each renewal</b><i>From each client's next renewal date</i></button>
              </div>
              {q.start_mode === "before_renewal" && (
                <div className="cs4-inline"><input type="number" min={0} value={q.start_days ?? 60} onChange={(e) => setQ((x) => ({ ...x, start_days: Math.max(0, Number(e.target.value) || 0) }))} /><span>days before the renewal (signed products' terms, their deals' contracts, else the yearly anniversary)</span></div>
              )}
            </section>

            <section className="cs4-ed-sec">
              <h4><span>3</span>The e-mails</h4>
              <ol className="cs4-steps">
                {steps.map((st, i) => (
                  <li key={st.id}>
                    <div className="cs4-step-wait">
                      {i === 0 && q.start_mode === "before_renewal" ? <span>On the start date</span> : <>
                        <span>{i === 0 ? "Wait" : "Then wait"}</span>
                        <input type="number" min={0} value={st.wait_days} onChange={(e) => setStep(i, { wait_days: Math.max(0, Number(e.target.value) || 0) })} aria-label="Days to wait" />
                        <span>day{st.wait_days === 1 ? "" : "s"}{i === 0 && !st.wait_days ? " (send at once)" : ""}</span>
                      </>}
                    </div>
                    <div className="cs4-step-card">
                      <span className="cs4-step-n">{i + 1}</span>
                      <span className="cs4-step-sel"><Select size="sm" value={st.template_id} onChange={(v) => v === "__new" ? onNewTemplate() : setStep(i, { template_id: v })} placeholder="Pick an e-mail blueprint…" searchable
                        options={[...templates.map((t) => ({ value: t.id, label: t.name, hint: t.attachments.length ? `${t.attachments.length} file${t.attachments.length === 1 ? "" : "s"}` : undefined })), { value: "__new", label: "+ New blueprint…" }]} /></span>
                      <button type="button" className="csx-ghost is-sm is-ico" disabled={i === 0} onClick={() => moveStep(i, -1)} title="Earlier"><CsIco n="up" s={12} /></button>
                      <button type="button" className="csx-ghost is-sm is-ico" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)} title="Later"><CsIco n="dn" s={12} /></button>
                      <button type="button" className="csx-ghost is-sm is-ico" disabled={steps.length === 1} onClick={() => setQ((x) => ({ ...x, steps: (x.steps ?? []).filter((_, j) => j !== i) }))} title="Remove"><CsIco n="trash" s={11} /></button>
                    </div>
                  </li>
                ))}
              </ol>
              <button type="button" className="csx-ghost is-sm" onClick={() => setQ((x) => ({ ...x, steps: [...(x.steps ?? []), newStep(templates[0]?.id ?? "", 14)] }))}><CsIco n="plus" s={12} />Add an e-mail</button>
              <div className="cs4-opts is-sm">
                <button type="button" className={!q.repeat ? "is-on" : ""} onClick={() => setQ((x) => ({ ...x, repeat: false }))}><b>Then stop</b><i>After the last e-mail</i></button>
                <button type="button" className={q.repeat ? "is-on" : ""} onClick={() => setQ((x) => ({ ...x, repeat: true }))}><b>Then start again</b><i>{q.start_mode === "before_renewal" ? "Before the next renewal" : "From the first e-mail, after a pause"}</i></button>
              </div>
              {q.repeat && q.start_mode !== "before_renewal" && (
                <div className="cs4-inline"><span>Start again</span><input type="number" min={1} value={q.start_days ?? 30} onChange={(e) => setQ((x) => ({ ...x, start_days: Math.max(1, Number(e.target.value) || 1) }))} /><span>days after the last e-mail{steps[0]?.wait_days ? ` (then the first one's own ${steps[0].wait_days}-day wait)` : ""}</span></div>
              )}
            </section>

            <section className="cs4-ed-sec">
              <h4><span>4</span>Sent to and from</h4>
              <div className="cs4-chiprow"><span>To</span>
                {([["all", "Every contact"], ["main", "Main contact only"], ["billing", "Billing contact"]] as const).map(([k, l]) => <button key={k} type="button" className={`cs4-chip ${q.recipients === k ? "is-on" : ""}`} onClick={() => setQ((x) => ({ ...x, recipients: k }))}>{l}</button>)}
              </div>
              <div className="cs4-chiprow"><span>From</span>
                <button type="button" className={`cs4-chip ${q.sender === "owner" ? "is-on" : ""}`} onClick={() => setQ((x) => ({ ...x, sender: "owner" }))}>Each client's starred owner</button>
                <button type="button" className={`cs4-chip ${q.sender === "me" ? "is-on" : ""}`} onClick={() => setQ((x) => ({ ...x, sender: "me" }))}>{q.created_by && q.created_by !== me ? people.find((p) => p.id === q.created_by)?.name ?? "Its creator" : "Me"}</button>
              </div>
              <p className="cs4-help">Each person gets their own e-mail, with their own name in it.</p>
              <label className="csx-check-row"><input type="checkbox" checked={q.log_contact !== false} onChange={(e) => setQ((x) => ({ ...x, log_contact: e.target.checked }))} /><span>Each e-mail counts as a contact (it resets the client's cadence)</span></label>
              <p className="cs4-help">A client without an owner (or whose owner hasn't connected Outlook with mail) is sent from the sequence's creator. Per client, you can pause it, leave the client out or send it to other addresses — in the client's panel.</p>
            </section>
          </div>

          <aside className="cs4-ed-side">
            <div className="cs4-ed-sum">
              <b>{fits.length}</b><span>client{fits.length === 1 ? "" : "s"} match{fits.length === 1 ? "es" : ""}{q.id ? ` · ${inNow} in it now` : ""}</span>
              <span className="cs4-ed-sum-p">{people_n} {people_n === 1 ? "person" : "people"} · one e-mail each</span>
              <i>{steps.length === 1 ? "1 e-mail" : `${steps.length} e-mails over ${totalDays} days`}{q.repeat ? (q.start_mode === "before_renewal" ? ", again before each renewal" : `, again ${q.start_days ?? 30} days later`) : ""}</i>
            </div>
            <ul className="cs4-ed-who">
              {fits.slice(0, 200).map((c) => {
                const to = csTo(full, c, runs.find((r) => r.sequence_id === q.id && r.client_id === c.id) ?? null);
                // which version of each e-mail this client gets (only the ones that differ from the main one)
                const vs = [...new Set(steps.map((st) => csVariantFor(templates.find((tp) => tp.id === st.template_id), c)?.name).filter(Boolean))] as string[];
                return (
                  <li key={c.id} className={to.length ? "" : "is-bad"}>
                    <CompanyLogo name={c.name} website={c.website} className="cx-av csx-logo is-xs" />
                    <span><b>{c.name}{vs.length > 0 && <em className="cs4-ed-ver" title={`Gets: ${vs.join(", ")}`}>{vs.join(" · ")}</em>}</b><i>{to.length ? `${to.length > 1 ? `${to.length} people · ` : ""}${to.join(", ")}` : "No e-mail on file — it'll be skipped"}{q.start_mode === "before_renewal" && c.ren ? ` · renews ${c.ren.end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" })}` : ""}</i></span>
                    {c.priority && <em className={`cs4-pri-dot is-${PRI_TONE[c.priority]}`} title={`${c.priority} priority`} />}
                  </li>
                );
              })}
              {!fits.length && <li className="cs3-empty">No client matches yet.</li>}
              {fits.length > 200 && <li className="cs3-empty">…and {fits.length - 200} more</li>}
            </ul>
          </aside>
        </div>
        {err && <p className="csx-err cs4-ed-err">{err}</p>}
        <footer className="csx-modal-f">
          <span className="cs4-foot-note">{q.active ? "On: due e-mails go out every hour." : "Off: nothing is sent until you switch it on."}</span>
          <span className="csx-sp" />
          <button type="button" className="csx-ghost" onClick={onClose}>Cancel</button>
          {!q.active && <button type="button" className="csx-ghost" disabled={busy} onClick={() => save(false)}>Save, keep it off</button>}
          <button type="button" className="csx-primary" disabled={busy} onClick={() => save(true)}>{busy ? "Saving…" : q.active ? "Save" : "Save and switch on"}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export function CustomerSuccessPage() {
  const cat = useCsCatalog();
  const nav = useNavigate();
  const [cs, setCs] = useState<CsData | null>(null);
  const [base, setBase] = useState<{ clients: any[]; lines: Line[]; logs: CsLog[]; sites: Record<string, string>; terms: Record<string, any> } | null>(null);
  const [auto, setAuto] = useState<CsAuto | null>(null);
  const [projTypes, setProjTypes] = useState<{ id: string; name: string }[]>([]);
  const fhRef = useRef<HTMLDivElement>(null);
  useFloatingHero(fhRef, ".cl-bar, .cx-kpis");
  const [scope, setScope] = useState<"mine" | "all">("all");
  const [owner, setOwner] = useState("");
  const [tab, setTab] = useState<CsTab>("accounts");
  useNavSection("/success", 0, (part) => { if (["accounts", "followups", "upsells", "qbr", "revenue"].includes(part)) setTab(part as CsTab); });
  const [filter, setFilter] = useState<CsFilter>("all");
  const [sort, setSort] = useState<CsSort>("priority");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [upView, setUpView] = useState<"pipeline" | "matrix">("pipeline");
  const [edit, setEdit] = useState<(Partial<CsUpsell> & { client_id: string }) | null>(null);
  const [logCh, setLogCh] = useState("call");
  const [recEdit, setRecEdit] = useState<{ seq: string; value: string } | null>(null);
  /** The page's Actions menu asks the follow-ups tab for a new sequence / blueprint. */
  const [fuCmd, setFuCmd] = useState<{ k: "seq" | "tpl"; n: number } | null>(null);
  const [logWhy, setLogWhy] = useState("");
  const [logDir, setLogDir] = useState<"out" | "in">("out");
  const [mailSync, setMailSync] = useState<CsMailSync[]>([]);
  const [mailBusy, setMailBusy] = useState(false);
  const [mailCover, setMailCover] = useState<{ read: string[]; unread: string[] } | null>(null);
  useEffect(() => { loadCsMailSync().then(setMailSync).catch(() => {}); }, []);
  const [qbrNew, setQbrNew] = useState<{ client: string; date: string }>({ client: "", date: "" });
  const [qbrDate, setQbrDate] = useState("");
  const [evNew, setEvNew] = useState<{ client: string; kind: RevenueEvent["kind"]; amount: number; date: string; reason: string } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkOwner, setBulkOwner] = useState("");
  const [ownPick, setOwnPick] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const year = new Date().getFullYear();
  const say = (m: string) => { setFlash(m); window.setTimeout(() => setFlash((x) => (x === m ? null : x)), 3200); };

  const reload = async () => setCs(await loadCsData());
  useEffect(() => {
    let alive = true;
    (async () => {
      const [cl, cp, pr, lg] = await Promise.all([
        supabase.from("clients").select("id, name, company_id, project_type_id, contacts").order("name"),
        supabase.from("client_products").select("*"),
        supabase.from("products").select("id, name"),
        supabase.from("client_contacts_log").select("client_id, contacted_at, reason, channel, contact_name, direction, source, logged_by"),
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
      if (lg.error) { const r2 = await supabase.from("client_contacts_log").select("client_id, contacted_at, reason, channel, contact_name"); logs = (r2.data ?? []) as CsLog[]; }
      if (!logs.length && lg.error) { const r3 = await supabase.from("client_contacts_log").select("client_id, contacted_at, reason, channel"); logs = (r3.data ?? []) as CsLog[]; }
      // renewal dates: a product without its own term follows its deal's contract
      const tids = [...new Set(((cp.data ?? []) as any[]).map((r) => r.tracking_id).filter(Boolean))] as string[];
      const terms: Record<string, any> = {};
      (await Promise.all(Array.from({ length: Math.ceil(tids.length / 150) }, (_, i) => tids.slice(i * 150, i * 150 + 150))
        .map((ids) => Promise.resolve(supabase.from("trackings").select("id, contract_terms").in("id", ids)).then((r: any) => (r.data ?? []) as any[]))).catch(() => [] as any[][]))
        .flat().forEach((t: any) => { if (t.contract_terms) terms[t.id] = t.contract_terms; });
      if (alive) setBase({ clients: (cl.data ?? []) as any[], lines: ((cp.data ?? []) as any[]).map((r) => ({ ...r, name: pn[r.product_id] ?? "Product" })), logs, sites, terms });
      loadCsAuto().then((a) => { if (alive) setAuto(a); }).catch(() => {});
      supabase.from("project_types").select("id, name").then(({ data }: any) => { if (alive) setProjTypes((data ?? []) as any[]); });
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
    })().catch(() => setBase({ clients: [], lines: [], logs: [], sites: {}, terms: {} }));
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
      const ago = (x?: CsLog) => (x ? Math.max(0, Math.floor((now - new Date(x.contacted_at).getTime()) / 864e5)) : null);
      const inL = logs.find((l) => l.direction === "in"), outL = logs.find((l) => l.direction !== "in");
      const daysIn = ago(inL);
      const daysOut = ago(outL);
      const us = (l?: CsLog) => (l?.logged_by ? pName(l.logged_by) : "");
      const them = (l?: CsLog) => String(l?.contact_name ?? "").trim();
      const cad = cadenceOf(cs, c.id);
      const priority = cs?.priority[c.id] ?? null;
      const ratio = days == null ? Infinity : days / cad;
      const health = cs?.health.find((h) => h.client_id === c.id)?.status ?? null;
      const rens = ls.map((l) => ({ l, t: csRenewalOf(l, l.tracking_id ? base.terms[l.tracking_id] : null) })).filter((x) => !!x.t).sort((a, b) => a.t!.end.getTime() - b.t!.end.getTime());
      const r0 = rens[0];
      const ups = (cs?.upsells ?? []).filter((u) => u.client_id === c.id && !["won", "lost"].includes(u.status));
      const arr = ls.filter(isActive).reduce((t, l) => t + (l.recurring ? lineAnnual(l) : 0), 0);
      const ren = r0 ? { end: r0.t!.end, left: r0.t!.left, value: lineAnnual(r0.l), auto: !!r0.l.auto_renew || r0.t!.kind === "anniversary", kind: r0.t!.kind } : null;
      const score = (priority === "high" ? 12 : priority === "medium" ? 5 : 0) + (ratio === Infinity ? 3 : Math.min(3, ratio)) * 10
        + (health === "red" ? 30 : health === "amber" ? 14 : 0)
        + (ren && ren.left <= 90 ? 18 - ren.left / 6 : 0)
        + Math.min(8, arr / 10000);
      return {
        id: c.id, name: c.name, website: c.company_id ? base.sites[c.company_id] ?? "" : "",
        lines: ls, arr, last, lastWhy: logs[0]?.reason || logs[0]?.channel || null, days,
        daysIn, daysOut, lastDir: logs[0] ? (logs[0].direction === "in" ? "in" : "out") : null,
        lastUs: us(logs[0]), lastThem: them(logs[0]), inUs: us(inL), inThem: them(inL), outUs: us(outL), outThem: them(outL),
        owners: own.map((o) => o.profile_id), primary: own.find((o) => o.is_primary)?.profile_id ?? own[0]?.profile_id ?? null,
        ratio, cadence: cad, health, ren, ups: ups.length, upsValue: ups.reduce((t, u) => t + u.est_value, 0), score, priority,
        typeId: c.project_type_id ?? null, contacts: Array.isArray(c.contacts) ? c.contacts : [],
      };
    });
  }, [base, cs, cat.people]); // eslint-disable-line react-hooks/exhaustive-deps
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

  // ---- the account list ----
  const ready = !!cs?.ready;
  const needsContact = (c: CsClient) => c.days == null || c.days > c.cadence;
  const atRisk = (c: CsClient) => c.health === "red" || c.health === "amber";
  const renewing = (c: CsClient) => !!c.ren && c.ren.left <= 90;
  const FILTERS: { key: CsFilter; label: string; test: (c: CsClient) => boolean; tone: string }[] = [
    { key: "all", label: "All accounts", test: () => true, tone: "slate" },
    { key: "contact", label: "Needs contact", test: needsContact, tone: "coral" },
    { key: "risk", label: "At risk", test: atRisk, tone: "gold" },
    { key: "renew", label: "Renewing in 90 d", test: renewing, tone: "teal" },
    { key: "upsell", label: "Open upsell", test: (c) => c.ups > 0, tone: "violet" },
    { key: "high", label: "High priority", test: (c) => c.priority === "high", tone: "coral" },
    { key: "orphan", label: "No owner", test: (c) => ready && !c.owners.length, tone: "slate" },
  ];
  const fTest = FILTERS.find((f) => f.key === filter)?.test ?? (() => true);
  const VIEW_SORT: Partial<Record<CsFilter, CsSort>> = { all: "priority", contact: "contact", risk: "priority", renew: "renewal", upsell: "arr", high: "contact", orphan: "arr" };
  const pickView = (k: CsFilter) => { setFilter(k); const so = VIEW_SORT[k]; if (so) setSort(so); };
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
  // the panel is drawn first, then it glides in (the heavy render never lands mid-animation);
  // on close it glides out and is removed afterwards
  // (the open / closed classes are set straight on the elements: no re-render of the page mid-animation)
  const [panelId, setPanelId] = useState<string | null>(null);
  const wsRef = useRef<HTMLDivElement | null>(null);
  const sideRef = useRef<HTMLElement | null>(null);
  const setPanelIn = (on: boolean) => { wsRef.current?.classList.toggle("has-open", on); sideRef.current?.classList.toggle("is-in", on); };
  useEffect(() => {
    if (openId) {
      setPanelId(openId);
      let r2 = 0;
      const r1 = window.requestAnimationFrame(() => { r2 = window.requestAnimationFrame(() => setPanelIn(true)); });
      return () => { window.cancelAnimationFrame(r1); window.cancelAnimationFrame(r2); };
    }
    setPanelIn(false);
    const t = window.setTimeout(() => setPanelId(null), 480);
    return () => window.clearTimeout(t);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = byId(panelId);

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
  /** Reads the Outlook mailboxes (again and again while there is more: the first time goes a year back). */
  const readMail = async () => {
    if (mailBusy) return;
    setMailBusy(true);
    let scanned = 0, logged = 0, rounds = 0, err: string | null = null, more = true, unread: string[] = [], read: string[] = [];
    while (more && rounds < 30) {
      rounds += 1;
      say(rounds === 1 ? "Reading Outlook…" : `Reading Outlook… ${scanned.toLocaleString("en-GB")} e-mails read, ${logged} with clients so far`);
      const r = await scanCsMail();
      if (r.error) { err = r.error; break; }
      scanned += r.scanned; logged += r.logged; more = r.more;
      if (r.unread) unread = r.unread;
      if (r.read) read = r.read;
      if (!r.mailboxes) { err = "No mailbox can be read yet: connect Outlook with mail (Settings › Interface), or have a Microsoft admin allow the whole team."; break; }
      if (r.errors?.length && !r.scanned) { err = r.errors[0]; break; }
    }
    const { data } = await supabase.from("client_contacts_log").select("client_id, contacted_at, reason, channel, contact_name, direction, source, logged_by");
    if (data) setBase((b) => b ? { ...b, logs: data as CsLog[] } : b);
    loadCsMailSync().then(setMailSync).catch(() => {});
    setMailBusy(false);
    setMailCover({ read, unread });
    const gap = unread.length ? ` · not read yet: ${unread.slice(0, 4).join(", ")}${unread.length > 4 ? ` and ${unread.length - 4} more` : ""}` : "";
    say(err ? (/unknown action/i.test(err) ? "The mail reader isn't installed yet (outlook-sync)." : err) : `${logged ? `${logged} e-mail${logged === 1 ? "" : "s"} with clients added as contacts` : "Up to date: no new e-mails with clients"} · ${read.length} mailbox${read.length === 1 ? "" : "es"} read${gap}`);
  };
  const mailHint = (() => {
    const last = mailSync.map((x) => x.last_run_at).filter(Boolean).sort().pop();
    if (!mailSync.length) return "Everyone's e-mails with clients become team contacts (a year back the first time)";
    const n = mailCover ? mailCover.read.length : mailSync.length, of = mailCover ? mailCover.read.length + mailCover.unread.length : 0;
    return `Last read ${csDate(last!)} · ${of ? `${n} of ${of}` : n} team mailbox${n === 1 && !of ? "" : "es"} · ${mailSync.reduce((t, x) => t + (x.logged || 0), 0)} e-mails found`;
  })();
  const openAccount = (id: string) => { setOpenId(id); setLogWhy(""); setLogCh("call"); setLogDir("out"); setOwnPick(false); setQbrDate(""); setRecEdit(null); };

  // ---- actions ----
  const doLog = async (id: string) => {
    const e = await logClientContact(id, { channel: logCh, reason: logWhy, direction: logDir });
    if (e) { say(e); return; }
    const at = new Date().toISOString();
    setBase((b) => b ? { ...b, logs: [...b.logs, { client_id: id, contacted_at: at, reason: logWhy || null, channel: logCh, direction: logDir, source: "manual", logged_by: cat.me }] } : b);
    setLogWhy(""); say(`Contact logged for ${nameOf(id)}`);
  };
  const quickLog = async (c: CsClient) => {
    const e = await logClientContact(c.id, { channel: "call", reason: null, direction: "out" });
    if (e) { say(e); return; }
    setBase((b) => b ? { ...b, logs: [...b.logs, { client_id: c.id, contacted_at: new Date().toISOString(), reason: null, channel: "call", direction: "out", source: "manual", logged_by: cat.me }] } : b);
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
  const renewals = clients.flatMap((c) => c.lines.map((l) => ({ c, l, t: csRenewalOf(l, l.tracking_id ? base?.terms[l.tracking_id] : null) })))
    .filter((x) => x.t && x.t.end.getTime() <= in12)
    .sort((a, b) => a.t!.end.getTime() - b.t!.end.getTime());
  const ren90 = renewals.filter((x) => x.t!.left <= 90);
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
  /** The contact priority of one or more clients (it sets how often they should hear from us). */
  const setPri = async (ids: string[], p: CsPriority | null) => {
    setCs((d) => { if (!d) return d; const pr = { ...d.priority }; ids.forEach((id) => { if (p) pr[id] = p; else delete pr[id]; }); return { ...d, priority: pr }; });
    for (const id of ids) { const e = await setClientPriority(id, p); if (e) { say(e); reload(); return; } }
    const lbl = p ? `${CS_PRIORITIES.find((x) => x.key === p)!.label} priority` : "no priority";
    say(ids.length === 1 ? `${nameOf(ids[0])}: ${lbl}` : `${ids.length} clients set to ${lbl}`);
  };
  /** The automatic e-mails: one client in one sequence. */
  const putRun = async (seqId: string, clientId: string, patch: Partial<CsRun>, msg?: string) => {
    const r = await setCsRun(seqId, clientId, patch);
    if (r.error || !r.row) { say(r.error ?? NEEDS_AUTO); return; }
    setAuto((a) => a ? { ...a, runs: [...a.runs.filter((x) => x.id !== r.row!.id), r.row!] } : a);
    if (msg) say(msg);
  };
  const sendDue = async () => {
    say("Sending what's due…");
    const r = await runCsSequences();
    if (r.error) { say(/not found|unknown action/i.test(r.error) ? "The e-mail sender isn't installed yet (outlook-sync)." : r.error); return; }
    say(r.sent ? `${r.sent} e-mail${r.sent === 1 ? "" : "s"} sent${r.failed ? ` · ${r.failed} failed` : ""}` : r.failed ? `${r.failed} couldn't be sent — see the activity` : "Nothing is due right now");
    loadCsAuto().then(setAuto).catch(() => {});
  };
  const runNow = async () => { const n = await generateContactTasks(); say(n == null ? NEEDS_CS : n ? `${n} follow-up${n === 1 ? "" : "s"} created` : "Nobody needs a follow-up right now"); };

  const loading = !base || !cs;
  const notReady = !!cs && !cs.ready;
  const TABS: { key: CsTab; label: string; icon: keyof typeof CSI; n?: number | string }[] = [
    { key: "accounts", label: "Accounts", icon: "users", n: clients.length },
    { key: "followups", label: "Automatic e-mails", icon: "mail", n: (auto?.sequences ?? []).filter((q) => q.active).length },
    { key: "upsells", label: "Upsells", icon: "trend", n: openUps.length },
    { key: "qbr", label: "QBRs", icon: "cal", n: qbrs.filter((x) => x.status === "planned").length },
    { key: "revenue", label: `Revenue ${year}`, icon: "euro", n: evs.length },
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
            <span>{[c.priority ? `${c.priority[0].toUpperCase()}${c.priority.slice(1)} priority` : "No priority", c.health ? HEALTH_TONE[c.health] : null, `${c.contacts.filter((x) => x.email).length || "no"} contact${c.contacts.filter((x) => x.email).length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span>
          </div>
          <button type="button" className="csx-ghost is-sm cs4-acc-open" onClick={() => nav(`/clients?client=${c.id}`)} title="Open the client"><CsIco n="arrow" s={13} /><span>Client</span></button>
          <button type="button" className="csx-x is-sm" onClick={() => setOpenId(null)} aria-label="Close (Esc)" title="Close (Esc)"><CsIco n="x" s={14} /></button>
        </header>
        <div className="cs4-acc-figs">
          <span><i>Recurring</i><b>{c.arr ? csShort(c.arr) : "—"}</b><em>per year</em></span>
          <span className={c.ren && c.ren.left <= 90 ? "is-hot" : ""}><i>Renewal</i><b>{c.ren ? c.ren.end.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}</b><em>{c.ren ? `in ${c.ren.left} days` : "no date"}</em></span>
          <span className={late ? "is-hot" : ""}><i>Last contact</i><b>{c.days == null ? "Never" : c.days === 0 ? "Today" : `${c.days} d ago`}</b><em title={c.lastUs || c.lastThem ? `${c.lastThem || "Their team"} · ${c.lastUs || "our team"}` : undefined}>{c.lastUs || c.lastThem ? csWho(c.lastUs, c.lastThem, c.lastDir) : c.lastDir === "in" ? "they reached us" : c.lastDir === "out" ? "we reached out" : `every ${c.cadence} days`}</em></span>
        </div>

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

          {/* priority: how often they should hear from us */}
          <CsBlock icon="star" title="Priority" tone={c.priority ? PRI_TONE[c.priority] : "jade"}
            right={<span className="cs3-muted">{cs?.cadence[c.id] ? `own cadence: every ${cs.cadence[c.id]} d` : `every ${c.cadence} days`}</span>}>
            <div className="cs4-pri" role="radiogroup" aria-label="Priority">
              {CS_PRIORITIES.map((pp) => (
                <button key={pp.key} type="button" role="radio" aria-checked={c.priority === pp.key} className={`is-${PRI_TONE[pp.key]} ${c.priority === pp.key ? "is-on" : ""}`} disabled={!ready}
                  onClick={() => setPri([c.id], c.priority === pp.key ? null : pp.key)}>
                  <b>{pp.label}</b><i>every {cs?.settings.priority_cadence[pp.key] ?? pp.days} d</i>
                </button>
              ))}
            </div>
          </CsBlock>

          {/* contact */}
          <CsBlock icon="phone" title="Contact" tone={late ? "coral" : "jade"}
            right={<span className="cs3-cadin" title="Get in touch every … days (this client)">every
              <input type="number" min={1} key={`cad-${c.id}-${cs?.cadence[c.id] ?? ""}`} placeholder={String(cs?.settings.default_cadence_days ?? 30)} defaultValue={cs?.cadence[c.id] ?? ""} disabled={!ready}
                onBlur={async (e) => { const v = Number(e.target.value) || null; if (v === (cs?.cadence[c.id] ?? null)) return; const er = await setClientCadence(c.id, v); if (er) say(er); else { say(v ? `${c.name}: every ${v} days` : `${c.name} follows the default cadence`); reload(); } }} />days</span>}>
            <CsCadence c={c} wide />
            <div className="cs4-dirs">
              <span className={`is-in ${c.daysIn == null ? "is-none" : ""}`}><em><CsIco n="din" s={12} /></em><span><i>From them</i><b>{c.daysIn == null ? "Not yet" : c.daysIn === 0 ? "Today" : `${c.daysIn} d ago`}</b>{c.daysIn != null && (c.inThem || c.inUs) && <small title={`${c.inThem || "Their team"} wrote to ${c.inUs || "us"}`}>{c.inThem || "Their team"}{c.inUs ? ` → ${c.inUs.split(" ")[0]}` : ""}</small>}</span></span>
              <span className={`is-out ${c.daysOut == null ? "is-none" : ""}`}><em><CsIco n="dout" s={12} /></em><span><i>From us</i><b>{c.daysOut == null ? "Not yet" : c.daysOut === 0 ? "Today" : `${c.daysOut} d ago`}</b>{c.daysOut != null && (c.outUs || c.outThem) && <small title={`${c.outUs || "We"} reached ${c.outThem || "them"}`}>{c.outUs ? c.outUs.split(" ")[0] : "Us"}{c.outThem ? ` → ${c.outThem}` : ""}</small>}</span></span>
            </div>
            <div className="cs3-log">
              <span className="cs4-dir-pick" role="radiogroup" aria-label="Who reached whom">
                <button type="button" role="radio" aria-checked={logDir === "out"} className={logDir === "out" ? "is-on" : ""} onClick={() => setLogDir("out")}><CsIco n="dout" s={11} />We reached out</button>
                <button type="button" role="radio" aria-checked={logDir === "in"} className={logDir === "in" ? "is-on is-in" : ""} onClick={() => setLogDir("in")}><CsIco n="din" s={11} />They reached us</button>
              </span>
              <span className="csx-chips">{["call", "email", "meeting", "visit"].map((ch) => <button key={ch} type="button" className={logCh === ch ? "is-on" : ""} onClick={() => setLogCh(ch)}><CsIco n={CH_ICON[ch]} s={11} />{ch}</button>)}</span>
              <div className="cs3-log-r">
                <input placeholder="What about?" value={logWhy} onChange={(e) => setLogWhy(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doLog(c.id); }} />
                <button type="button" className="csx-primary is-sm" onClick={() => doLog(c.id)}><CsIco n="check" s={12} />Log</button>
                <button type="button" className="csx-ghost is-sm" onClick={() => doTask(c)} title={`Add a follow-up to ${c.primary ? pName(c.primary) : "your"} desk`}><CsIco n="task" s={12} />Follow-up</button>
              </div>
            </div>
            {logs.length ? (
              <ol className="cs3-tl">
                {logs.slice(0, 6).map((l, i) => (
                  <li key={`${l.contacted_at}-${i}`} className={`is-${l.direction === "in" ? "in" : "out"}`}>
                    <span className="cs3-tl-ico"><CsIco n={CH_ICON[l.channel ?? ""] ?? "phone"} s={11} /><em><CsIco n={l.direction === "in" ? "din" : "dout"} s={8} /></em></span>
                    <span className="cs3-tl-m"><b>{l.reason || (l.channel ? `${l.channel[0].toUpperCase()}${l.channel.slice(1)}` : "Contact")}</b>
                      <i>{(() => {
                        const u = l.logged_by ? pName(l.logged_by) : "", t = l.contact_name || "their team";
                        const what = l.channel === "email" ? (l.source === "auto" ? "Automatic e-mail" : "E-mail") : l.channel ? `${l.channel[0].toUpperCase()}${l.channel.slice(1)}` : "Contact";
                        return l.direction === "in" ? `${what} from ${t}${u ? ` to ${u}` : ""}` : `${what}${u ? ` from ${u}` : ""} to ${t}`;
                      })()}{l.source === "email" ? " · Outlook" : ""}</i></span>
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
                      options={cat.pickable.filter((p) => !c.owners.includes(p.id)).map((p) => ({ value: p.id, label: p.name }))} />
                  </span>
                ) : <button type="button" className="csx-own-add" onClick={() => setOwnPick(true)}><CsIco n="plus" s={11} />{c.owners.length ? "Owner" : "Assign an owner"}</button>}
              </div>
            )}
          </CsBlock>

          {/* automatic e-mails */}
          <CsBlock icon="mail" title="Automatic e-mails" tone="blue"
            right={<button type="button" className="csx-link" onClick={() => setTab("followups")}>Set up</button>}>
            {!auto ? <p className="cs3-empty">Reading…</p> : !auto.ready ? <CsLocked what="Automatic e-mails" /> : (() => {
              const rows = auto.sequences.map((q) => ({ q, run: auto.runs.find((r) => r.sequence_id === q.id && r.client_id === c.id) ?? null, fits: csFits(q, c, cs) }))
                .filter((x) => x.run || (x.q.active && x.fits));
              const others = auto.sequences.filter((q) => !rows.some((x) => x.q.id === q.id));
              return <>
                {rows.length ? <ul className="cs4-runs">{rows.map(({ q, run, fits }) => {
                  const st = run?.status ?? (fits ? "waiting" : "out");
                  const step = q.steps[Math.min(run?.step ?? 0, Math.max(0, q.steps.length - 1))];
                  const tpl = auto.templates.find((t) => t.id === step?.template_id);
                  return (
                    <li key={q.id} className={`is-${st}`}>
                      <span className="cs4-runs-m">
                        <b>{q.name}{!q.active && <em className="cs3-tag is-slate">off</em>}</b>
                        <i>{st === "active" ? `Next: ${tpl?.name ?? "—"} · ${run?.next_at ? csDate(run.next_at) : "soon"}` : st === "paused" ? "Paused for this client" : st === "excluded" ? "Left out for this client" : st === "done" ? `Done${run?.last_sent_at ? ` · last ${csDate(run.last_sent_at)}` : ""}` : "Starts with the next run"}
                          {run?.to_emails?.length ? ` · to ${run.to_emails.join(", ")}` : ""}</i>
                      </span>
                      {st === "active" && <button type="button" className="csx-ghost is-sm" onClick={() => putRun(q.id, c.id, { status: "paused" }, `${q.name} paused for ${c.name}`)}>Pause</button>}
                      {(st === "paused" || st === "excluded" || st === "done") && <button type="button" className="csx-ghost is-sm" onClick={() => putRun(q.id, c.id, { status: "active", manual: true, ...(st === "done" ? { step: 0, next_at: new Date().toISOString() } : {}) }, `${q.name} running for ${c.name}`)}>{st === "done" ? "Start again" : "Resume"}</button>}
                      {(st === "active" || st === "waiting") && <button type="button" className="csx-ghost is-sm is-ico" title="Leave this client out" onClick={() => putRun(q.id, c.id, { status: "excluded" }, `${c.name} left out of ${q.name}`)}><CsIco n="x" s={12} /></button>}
                      <button type="button" className={`csx-ghost is-sm is-ico ${recEdit?.seq === q.id ? "is-on" : ""}`} title="Who it goes to (this client)"
                        onClick={() => setRecEdit(recEdit?.seq === q.id ? null : { seq: q.id, value: run?.to_emails?.join(", ") ?? "" })}><CsIco n="users" s={12} /></button>
                      {recEdit?.seq === q.id && (
                        <div className="cs4-rec">
                          <input autoFocus value={recEdit.value} onChange={(e) => setRecEdit({ seq: q.id, value: e.target.value })}
                            placeholder={`Default: ${q.recipients === "all" ? "all contacts" : q.recipients === "billing" ? "the billing contact" : "the main contact"}`}
                            onKeyDown={(e) => { if (e.key === "Escape") setRecEdit(null); if (e.key === "Enter") (e.currentTarget.nextElementSibling as HTMLButtonElement)?.click(); }} />
                          <button type="button" className="csx-primary is-sm" onClick={() => {
                            const list = recEdit.value.split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /@/.test(x));
                            putRun(q.id, c.id, { to_emails: list.length ? list : null, ...(run ? {} : { status: "active", manual: !fits }) }, list.length ? `${c.name}: ${q.name} goes to ${list.join(", ")}` : `${c.name}: ${q.name} goes to the usual contacts`);
                            setRecEdit(null);
                          }}>Save</button>
                          <em>E-mails, separated by commas — empty: {q.recipients === "all" ? "all its contacts" : q.recipients === "billing" ? "its billing contact" : "its main contact"}</em>
                        </div>
                      )}
                    </li>
                  );
                })}</ul> : <p className="cs3-empty">No automatic e-mails for {c.name} yet.</p>}
                {others.length > 0 && (
                  <div className="cs3-inline-add">
                    <Select size="sm" value="" onChange={(v) => v && putRun(v, c.id, { status: "active", manual: true, step: 0, next_at: new Date().toISOString() }, `${c.name} added to ${others.find((q) => q.id === v)?.name}`)}
                      placeholder="Add to a sequence…" options={others.map((q) => ({ value: q.id, label: q.name, hint: q.active ? undefined : "off" }))} />
                  </div>
                )}
              </>;
            })()}
          </CsBlock>

          {/* products & renewals */}
          <CsBlock icon="repeat" title="Products & renewals" right={<span className="cs3-muted">{lines.length} active</span>}>
            {lines.length ? (
              <ul className="cs3-prods">
                {lines.map((l) => { const t = csRenewalOf(l, l.tracking_id ? base?.terms[l.tracking_id] : null); return (
                  <li key={l.id} className={t && t.left < 90 ? "is-soon" : ""}>
                    <span className="cs3-prods-m"><b>{l.name}</b><i>{l.recurring ? "recurring" : "one-off"}{t ? ` · ${t.kind === "anniversary" ? "anniversary" : l.auto_renew || t.kind === "deal" ? "renews" : "ends"} ${t.end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}{t?.kind === "deal" ? " · from the deal's contract" : ""}</i></span>
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

  /* ---------- tabs ---------- */
  const accountsTab = () => (
    <div className="cs3-ws" ref={wsRef}>
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
              <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={`is-${f.tone} ${filter === f.key ? "is-on" : ""}`} onClick={() => pickView(f.key)}>
                {f.label}<em>{n}</em>
              </button>
            );
          })}
        </div>

        {sel.size > 0 && (
          <div className="cs3-bulk">
            <b>{sel.size} selected</b>
            <span className="cs3-bulk-sel"><Select size="sm" value={bulkOwner} onChange={setBulkOwner} placeholder="Add owner…" searchable options={cat.pickable.map((p) => ({ value: p.id, label: p.name }))} /></span>
            <button type="button" className="csx-primary is-sm" disabled={!bulkOwner || !ready} onClick={assignBulk}>Assign owner</button>
            <span className="cs3-bulk-sep" />
            <span className="cs3-bulk-l">Priority</span>
            {CS_PRIORITIES.map((pp) => <button key={pp.key} type="button" className={`csx-ghost is-sm cs4-pri-chip is-${PRI_TONE[pp.key]}`} disabled={!ready} onClick={() => setPri([...sel], pp.key)}><i />{pp.label}</button>)}
            <button type="button" className="csx-x is-sm" onClick={() => setSel(new Set())} aria-label="Clear the selection"><CsIco n="x" s={13} /></button>
          </div>
        )}

        <div className="cs3-table" ref={listRef} role="grid" aria-rowcount={list.length}>
          <div className="cs3-tr is-head" role="row">
            <span role="columnheader" />
            <span role="columnheader">Account</span>
            <span role="columnheader">Priority</span>
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
                    {filter === "risk" && c.health && <em className={`cs3-tag is-${c.health === "red" ? "coral" : "gold"}`}>{CS_REASONS.find((r) => r.key === healthOf(c.id)?.reason)?.label ?? healthOf(c.id)?.note ?? "No reason given"}</em>}
                    {c.ups > 0 && <em className="cs3-tag is-violet" title={`${c.ups} open upsell${c.ups === 1 ? "" : "s"}`}><CsIco n="trend" s={10} />{csShort(c.upsValue)}</em>}
                  </span>
                </span>
              </span>
              <span className="cs3-td-p" onClick={(e) => e.stopPropagation()}>
                <CsPriPick value={c.priority} disabled={!ready} days={cs?.settings.priority_cadence} onPick={(p) => setPri([c.id], p)} />
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
              <i>{!clients.length ? (scope === "mine" ? "Pick Everyone's accounts in the owner menu, select some and assign yourself." : "Clients show here once you have some.") : "Try another filter."}</i>
              {(filter !== "all" || q) && <button type="button" className="csx-ghost is-sm" onClick={() => { setFilter("all"); setQ(""); }}>Show all accounts</button>}
            </div>
          )}
        </div>
      </section>
      <aside className="cs3-side is-acc" ref={sideRef} aria-label={shown ? `Account: ${shown.name}` : "Account"} aria-hidden={!open}>
        {shown && <div className="cs4-acc-w">{accountPanel(shown)}</div>}
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

  const ren90Value = ren90.reduce((t, x) => t + lineAnnual(x.l), 0);
  return (
    <div className="csx cs3 cs4 cl cl-ov fh" ref={fhRef} onPointerMove={fhMove} onPointerLeave={fhLeave}>
      <header className="cl-bar cs4-bar">
        <div className="cl-bar-left">
          <h1 className="cl-title">Customer success</h1>
          <nav className="cs4-itabs" role="tablist" aria-label="Customer success">
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} aria-label={t.label}
                className={`cs4-itab ${tab === t.key ? "is-on" : ""}`} onClick={() => setTab(t.key)}>
                <CsIco n={t.icon} s={17} /><span className="cs4-itab-l" aria-hidden="true"><span>{t.label}</span></span>
              </button>
            ))}
          </nav>
        </div>
        <div className="cs4-tools">
          <div className="cs4-sel">
            <Select size="sm" value={scope === "mine" ? "__me" : owner} searchable
              onChange={(v) => { if (v === "__me") { setScope("mine"); setOwner(""); } else { setScope("all"); setOwner(v); } }}
              options={[{ value: "", label: "Everyone's accounts" }, ...(cat.me ? [{ value: "__me", label: "My portfolio" }] : []), ...cat.pickable.filter((p) => p.id !== cat.me).map((p) => ({ value: p.id, label: p.name }))]} />
          </div>
        </div>
        <div className="cl-actions">
          <ActionsMenu items={[
            { key: "seq", group: "Automatic e-mails", label: "New follow-up sequence", hint: "Blueprints sent every few days to the clients you pick", icon: AM_ICON.plus, primary: true, tone: "green", onSelect: () => { setTab("followups"); setFuCmd({ k: "seq", n: Date.now() }); } },
            { key: "tpl", group: "Automatic e-mails", label: "New e-mail blueprint", hint: "A styled e-mail with the client's name filled in", icon: AM_ICON.plus, tone: "blue", onSelect: () => { setTab("followups"); setFuCmd({ k: "tpl", n: Date.now() }); } },
            { key: "send", group: "Automatic e-mails", label: "Send what's due now", hint: "Otherwise they go out on their own every hour", icon: AM_ICON.import, tone: "violet", onSelect: sendDue },
            { key: "mail", group: "Contacts", label: mailBusy ? "Reading Outlook…" : "Read e-mails from Outlook now", hint: mailHint, icon: AM_ICON.import, tone: "blue", onSelect: readMail },
            { key: "tasks", group: "Follow-up tasks", label: "Create follow-up tasks now", hint: "For accounts past their contact cadence", icon: AM_ICON.fields, tone: "amber", onSelect: runNow },
            ...(snap ? [] : [{ key: "freeze", group: "Revenue", label: `Freeze today's ARR as the ${year} base`, hint: "NRR and churn are measured against it", icon: AM_ICON.export, tone: "blue" as const, onSelect: freeze }]),
          ]} />
        </div>
      </header>

      <div className="cx-kpis cs4-kpis" style={{ ["--n" as any]: 5 }}>
        {[
          { k: "ARR signed", icon: "euro" as const, tone: "jade", v: loading ? "…" : csShort(arrNow), sub: growth != null ? `${growth >= 0 ? "+" : ""}${csPct(growth)} vs. the start of ${year}` : `${clients.filter((c) => c.arr > 0).length} recurring accounts`, bar: initial > 0 ? Math.min(100, (arrNow / Math.max(initial, arrNow)) * 100) : null },
          { k: "NRR", icon: "repeat" as const, tone: nrr == null ? "mint" : nrr >= 100 ? "jade" : "gold", v: nrr == null ? "—" : csPct(nrr), sub: snap ? `Base ${csShort(initial)} · fixed ${csDate(snap.taken_at)}` : null, bar: nrr == null ? null : Math.min(100, nrr), freeze: !snap },
          { k: "Expansion", icon: "trend" as const, tone: "teal", v: csShort(expansion), sub: initial > 0 && expansion > 0 ? `+${csPct((expansion / initial) * 100)} of the base` : `${openUps.length} open upsell${openUps.length === 1 ? "" : "s"} · ${csShort(openUps.reduce((t, u) => t + u.est_value, 0))}`, bar: null },
          { k: "Churn rate", icon: "down" as const, tone: churnRate != null && churnRate > 5 ? "coral" : churnRate != null && churnRate > 2 ? "gold" : "mint", v: churnRate == null ? "—" : csPct(churnRate), sub: churn > 0 ? `${csShort(churn)} lost${contraction ? ` · ${csShort(contraction)} smaller` : ""}` : "Nothing lost this year", bar: null },
          { k: "Renewals · 90 days", icon: "cal" as const, tone: ren90.length ? "gold" : "mint", v: csShort(ren90Value), sub: ren90.length ? `${ren90.length} product${ren90.length === 1 ? "" : "s"} · next ${ren90[0].t!.end.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "Nothing renews soon", bar: null },
        ].map((x, i) => (
          <div className={`cx-kpi tone-${x.tone}`} key={x.k} style={{ ["--i" as any]: i }}>
            <span className="cx-kpi-top"><span className="cx-kpi-ico"><CsIco n={x.icon} s={15} /></span><span className="cx-kpi-k">{x.k}</span></span>
            <b className="cx-kpi-v">{x.v}</b>
            {x.sub && <span className="cx-kpi-sub">{x.sub}</span>}
            {"freeze" in x && x.freeze && <button type="button" className="cs4-kpi-btn" disabled={!ready || loading} onClick={freeze}><CsIco n="lock" s={11} />Freeze today's ARR</button>}
            {x.bar != null && <span className="cx-kpi-bar"><i style={{ width: `${Math.max(0, Math.min(100, x.bar))}%` }} /></span>}
          </div>
        ))}
      </div>

      <section className="cs4-sheet">
        {notReady && (
          <div className="csx-banner" role="note">
            <span className="csx-banner-ico"><CsIco n="lock" s={16} /></span>
            <div><b>Customer success isn't switched on yet</b><span>Run <code>17_customer_success.sql</code> in Supabase. Contact tracking and renewals already work from your clients; owners, health, QBRs, upsells and revenue movements need the new tables.</span></div>
          </div>
        )}
        {flash && <div className="csx-toast" role="status"><CsIco n="check" s={14} />{flash}</div>}

        {loading ? (
          <PageLoader label="Reading your portfolio" />
        ) : (
          <div className={`cs3-body cs4-body is-${tab}`} key={tab}>
            {tab === "accounts" ? accountsTab() : tab === "followups" ? (
              <CsFollowUps auto={auto} setAuto={setAuto} accounts={all} cs={cs} setCs={setCs} types={projTypes} people={cat.people} me={cat.me}
                say={say} cmd={fuCmd} onOpenClient={(id) => { setTab("accounts"); openAccount(id); }} onSendDue={sendDue} onRunTasks={runNow} />
            ) : tab === "upsells" ? upsellsTab() : tab === "qbr" ? qbrTab() : revenueTab()}
          </div>
        )}
      </section>
      {edit && <UpsellEditor initial={edit} clientName={nameOf(edit.client_id)} cat={cat} onClose={() => setEdit(null)} onSaved={upsert}
        onDeleted={(id) => setCs((d) => d ? { ...d, upsells: d.upsells.filter((x) => x.id !== id) } : d)} />}
    </div>
  );
}
