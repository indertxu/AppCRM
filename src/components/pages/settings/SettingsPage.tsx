import { useEffect, useRef, useState, type ReactNode } from "react";
import { PageLoader } from "../../framework/AppLayout";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/authContext";
import NewUserModal, { LEVELS, type NewUserPayload } from "./NewUserModal";
import UsersView, { type UserRow } from "./UsersView";
import UserDetailModal from "./UserDetailModal";
import Organization from "./Organization";
import CatalogPage from "./CatalogPage";
import PipelinePage from "./PipelinePage";
import { ProposalSettings } from "./ProposalTemplateEditor";
import PageAccessModal, { useSecuritySection, PanelAccess } from "./PageAccessModal";
import Select from "../../framework/Select";
import TaskSettings from "./TaskSettings";
import { FolderTemplatesEditor } from "../clients/ClientDirectory";
import HoursEditor from "../calendar/HoursEditor";
import { CutoffsEditor } from "../calendar/CalendarSettingsModal";
import { TimeOffApprovals, TimeOffAllowances, PublicHolidays } from "../calendar/TimeOffRequest";
import "../calendar/CalendarSettingsModal.css";
import { usePageAccess, useNavSection, levelName, levelBase, type PageKey } from "../../framework/pageAccess";
import { SuperAdminSwitch } from "../../framework/SuperAdmin";
import { connectOutlook, completeOutlookConnect, outlookStatus, disconnectOutlook, outlookConnectError, OUTLOOK_CONNECTION_EVENT } from "../../api/outlookSync";
import { DOCK_ITEMS, DOCK_ORDER_KEY, DOCK_ORDER_EVENT, orderDock } from "../../framework/Dock";
import { loadPrefs, savePref, isSalesLead } from "../companies/companiesApi";
import { CompanySettings, SettingsShell } from "../companies/CompaniesPage";
import { ContactSettings } from "../contacts/ContactsPage";
import SalesPage from "../sales/sales/SalesPage";
import { useLocation, useNavigate } from "react-router-dom";
import "./SettingsPage.css";

const levelLabel = (id: string | null) => (id ? levelName(id) : "—");

type View = "home" | "users" | "organization" | "account" | "interface" | "catalog" | "pipeline" | "proposal" | "tasks" | "salespage" | "mgmtpage" | "clientpage" | "companiespage" | "contactspage"
  | "ticketspage" | "calendarpage" | "projectspage" | "successpage" | "marketingpage";
/** Which Page-access panel opens each view (Settings → Organization → Page access → Settings). */
const VIEW_PANEL: Partial<Record<View, string>> = {
  organization: "settings.organization",
  catalog: "settings.catalog",
  pipeline: "settings.pipelines",
  proposal: "settings.proposal",
  calendarpage: "settings.calendar",
};
/** The page a settings section belongs to: someone who can't open that page doesn't get its settings either
 *  (no Deals settings without Sales). Any one of the pages listed is enough. */
const VIEW_PAGES: Partial<Record<View, PageKey[]>> = {
  salespage: ["sales"],
  proposal: ["sales"],
  pipeline: ["sales"],
  catalog: ["sales", "clients", "projects"],
  mgmtpage: ["management"],
  companiespage: ["companies"],
  contactspage: ["contacts"],
  clientpage: ["clients"],
  ticketspage: ["tickets"],
  calendarpage: ["calendar"],
  projectspage: ["projects"],
  successpage: ["success"],
  marketingpage: ["marketing"],
};
/** Pages whose settings are only their Security section for now (Bosses and superadmins). */
const SECURITY_ONLY: { view: View; page: PageKey; icon: string; title: string; sub: string; accent: string; svg: string }[] = [
  { view: "ticketspage", page: "tickets", icon: "ticket", title: "Tickets page", sub: "Who sees which tickets and tasks", accent: "#e0a13c", svg: "M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM14 5v12" },
  { view: "projectspage", page: "projects", icon: "folder", title: "Projects page", sub: "Which projects people see", accent: "#0a6f4d", svg: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 13h8" },
  { view: "successpage", page: "success", icon: "heart", title: "Customer success page", sub: "Which clients people follow up", accent: "#e0798c", svg: "M12 20.5s-7.5-4.4-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.8-7.5 10.2-7.5 10.2z" },
  { view: "marketingpage", page: "marketing", icon: "megaphone", title: "Marketing page", sub: "Which lists and campaigns people see", accent: "#9b6fd0", svg: "M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1zM16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10" },
];

export const DOCK_PINNED_KEY = "next.dockPinned";
export const DOCK_PINNED_EVENT = "next:dock-pinned";
export const DOCK_LABELS_KEY = "next.dockLabels";
export const DOCK_LABELS_EVENT = "next:dock-labels";

export default function SettingsPage() {
  const { session, role, isSuperadmin } = useAuth() as any;
  console.log("my role →", role);
  const isBoss = (role ?? "").toString().toLowerCase() === "boss";
  /** Who may edit Page access: by SECURITY LEVEL (read live, as Organization shows it). */
  const { level: secLevel, isSuper: secSuper, canPanel, ready: accessReady, canSee: canSeePage } = usePageAccess();
  const canEditAccess = levelBase(secLevel) === "boss" || secSuper || isSuperadmin === true;
  console.log("[page-access] security level (live) →", secLevel, "| can edit:", canEditAccess);
  const isManager = role === "consultancy_manager" || role === "sales_manager"
    || role === "customer_success" || role === "it_manager"
    || role === "marketing_manager" || role === "hr_manager";
  const canManage = isBoss || isManager;
  const orgBackRef = useRef<(() => boolean) | null>(null);
  const orgToolbarRef = useRef<HTMLDivElement | null>(null);
  const canSeeSensitive = isBoss || isManager;

  const allowedLevels = isBoss
    ? LEVELS.map((l) => l.id)
    : role === "consultancy_manager"
    ? ["consultant"]
    : role === "sales_manager"
    ? ["sales"]
    : [];

  const [viewRaw, setView] = useState<View>("home");
  /** Companies / Contacts set-up (fields, lists, import, export, clean-up): sales leads. */
  const crmLead = isSalesLead({ role, is_superadmin: isSuperadmin === true });
  // Opened from the Companies or Contacts page ("… settings"): go straight to that section.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const v = (location.state as any)?.settingsView as View | undefined;
    if (!v) return;
    setView(v);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);
  // Global search → Settings › a section (deep link "settings/<view>[/<tab>]").
  useNavSection("/settings", 0, (part) => {
    const views: View[] = ["home", "organization", "account", "interface", "catalog", "pipeline", "proposal", "tasks", "salespage", "mgmtpage", "clientpage", "companiespage", "contactspage", "ticketspage", "calendarpage", "projectspage", "successpage", "marketingpage"];
    if ((views as string[]).includes(part)) setView(part as View);
  });
  // A panel switched off in Page access can't be opened (also not while it's open).
  /** May this person open a settings section: its panel isn't switched off and they can open its page. */
  const viewOpen = (v: View) => {
    const panel = VIEW_PANEL[v], pages = VIEW_PAGES[v];
    if (panel && !(accessReady && canPanel(panel))) return false;
    if (pages && !(accessReady && pages.some((pg) => canSeePage(pg)))) return false;
    if (SECURITY_ONLY.some((x) => x.view === v) && !canEditAccess) return false;
    return true;
  };
  const view: View = viewOpen(viewRaw) ? viewRaw : "home";
  const seesCompanyCards = (["organization", "catalog", "pipeline", "proposal"] as View[]).some((v) => viewOpen(v));
  const [showPageAccess, setShowPageAccess] = useState(false);
  const [homeQ, setHomeQ] = useState("");

  // Quick insights shown on the landing cards (loaded lazily).
  const [stats, setStats] = useState<{
    employees: number; departments: number;
    products: number; services: number; pipelines: number;
  } | null>(null);
  useEffect(() => {
    if (!seesCompanyCards) return;
    (async () => {
      const [emp, dep, prod, svc, pipe] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("org_departments").select("id", { count: "exact", head: true }),
        supabase.from("products").select("id", { count: "exact", head: true }),
        supabase.from("services").select("id", { count: "exact", head: true }),
        supabase.from("pipelines").select("id", { count: "exact", head: true }),
      ]);
      setStats({
        employees: emp.count ?? 0,
        departments: dep.count ?? 0,
        products: prod.count ?? 0,
        services: svc.count ?? 0,
        pipelines: pipe.count ?? 0,
      });
    })().catch(() => {});
  }, [seesCompanyCards]);

  // When the Settings icon is tapped while already on /settings, reset to home.
  useEffect(() => {
    const onReset = (e: Event) => {
      const path = (e as CustomEvent).detail;
      if (path === "/settings") setView("home");
    };
    window.addEventListener("next:nav-reset", onReset);
    return () => window.removeEventListener("next:nav-reset", onReset);
  }, []);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<UserRow | null>(null);

  // localStorage is a fast cache to avoid a flash on load; the profile is the source of truth.
  // (The sidebar is always fixed now; only the labels are a choice.)
  const [dockLabels, setDockLabels] = useState<boolean>(
    () => localStorage.getItem(DOCK_LABELS_KEY) === "true"
  );

  const uid = session?.user?.id ?? null;

  // Load the saved preference from the user's profile on mount.
  useEffect(() => {
    if (!uid) return;
    (async () => {
      const { data } = await supabase.from("profiles").select("dock_labels").eq("id", uid).maybeSingle();
      if (data && typeof (data as any).dock_labels === "boolean") {
        setDockLabels((data as any).dock_labels);
        localStorage.setItem(DOCK_LABELS_KEY, String((data as any).dock_labels));
        window.dispatchEvent(new CustomEvent(DOCK_LABELS_EVENT, { detail: (data as any).dock_labels }));
      }
    })();
  }, [uid]);

  const toggleLabels = async () => {
    const next = !dockLabels;
    setDockLabels(next);
    localStorage.setItem(DOCK_LABELS_KEY, String(next));
    window.dispatchEvent(new CustomEvent(DOCK_LABELS_EVENT, { detail: next }));
    if (uid) await supabase.from("profiles").update({ dock_labels: next }).eq("id", uid);
  };

  // Your own order of the toolbar: dragged here, saved to your profile.
  const [dockOrder, setDockOrder] = useState<string[]>(() => { try { const v = JSON.parse(localStorage.getItem(DOCK_ORDER_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } });
  const [dockDrag, setDockDrag] = useState<string | null>(null);
  const [dockOver, setDockOver] = useState<string | null>(null);
  useEffect(() => { loadPrefs().then((p) => { if (Array.isArray(p.dockOrder)) setDockOrder(p.dockOrder); }).catch(() => {}); }, []);
  const saveDockOrder = (next: string[]) => {
    setDockOrder(next);
    try { localStorage.setItem(DOCK_ORDER_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(DOCK_ORDER_EVENT, { detail: next }));
    savePref("dockOrder", next).catch(() => {});
  };
  const dockShown = orderDock(DOCK_ITEMS.filter((it) => canSeePage(it.page)), dockOrder);
  const dropDock = (target: string, after: boolean) => {
    if (!dockDrag || dockDrag === target) return;
    const paths = orderDock(DOCK_ITEMS, dockOrder).map((it) => it.path).filter((p) => p !== dockDrag);
    paths.splice(paths.indexOf(target) + (after ? 1 : 0), 0, dockDrag);
    saveDockOrder(paths);
  };
  const moveDock = (path: string, by: number) => {
    const paths = orderDock(DOCK_ITEMS, dockOrder).map((it) => it.path);
    const shown = dockShown.map((it) => it.path);
    const i = shown.indexOf(path), j = i + by;
    if (j < 0 || j >= shown.length) return;
    const a = paths.indexOf(shown[i]), b = paths.indexOf(shown[j]);
    [paths[a], paths[b]] = [paths[b], paths[a]];
    saveDockOrder(paths);
  };

  // Outlook connection state
  const [outlookConnected, setOutlookConnected] = useState<boolean | null>(null);
  const [outlookBusy, setOutlookBusy] = useState(false);
  const [outlookError, setOutlookError] = useState<string | null>(() => outlookConnectError());
  useEffect(() => {
    (async () => {
      const returning = !!outlookConnectError() || !!sessionStorage.getItem("ms_oauth_pending");
      const finished = await completeOutlookConnect().catch(() => false);
      const status = await outlookStatus().catch(() => false);
      setOutlookConnected(finished || status);
      setOutlookError(finished || status ? null : outlookConnectError());
      // Just back from Microsoft: show the result where the button is.
      if (finished || returning) setView("interface");
    })();
  }, []);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (d.connected) { setOutlookConnected(true); setOutlookError(null); }
      else setOutlookError(d.error ?? null);
    };
    window.addEventListener(OUTLOOK_CONNECTION_EVENT, on);
    return () => window.removeEventListener(OUTLOOK_CONNECTION_EVENT, on);
  }, []);
  const handleOutlook = async () => {
    if (outlookConnected) {
      setOutlookBusy(true);
      await disconnectOutlook().catch(() => {});
      setOutlookConnected(false);
      setOutlookBusy(false);
    } else {
      // Microsoft opens in a popup; this page stays put and finishes the connection.
      setOutlookBusy(true); setOutlookError(null);
      const ok = await connectOutlook().catch(() => false);
      setOutlookBusy(false);
      if (ok) setOutlookConnected(true);
      else setOutlookError(outlookConnectError());
    }
  };

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadUsers = async () => {
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("manage-users", { body: { action: "list" } });
    setLoading(false);
    if (error) return;
    setUsers((data?.users as UserRow[]) ?? []);
  };

  useEffect(() => {
    if (canManage) loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  const createUser = async (p: NewUserPayload): Promise<string | null> => {
    const { data, error } = await supabase.functions.invoke("manage-users", { body: { action: "create", user: p } });
    if (error) return error.message ?? "Could not create user.";
    if (data?.error) return data.error as string;
    await loadUsers();
    return null;
  };

  const updateUser = async (id: string, fields: Partial<UserRow>): Promise<string | null> => {
    const { data, error } = await supabase.functions.invoke("manage-users", { body: { action: "update", id, fields } });
    if (error) return error.message ?? "Could not save.";
    if (data?.error) return data.error as string;
    await loadUsers();
    return null;
  };

  const resetUserPassword = async (id: string, password: string): Promise<string | null> => {
    const { data, error } = await supabase.functions.invoke("manage-users", { body: { action: "reset_password", id, password } });
    if (error) return error.message ?? "Could not reset password.";
    if (data?.error) return data.error as string;
    return null;
  };

  const changeOwnPassword = async () => {
    setPwMsg(null);
    if (pw.length < 6) return setPwMsg({ ok: false, text: "Password must be at least 6 characters." });
    if (pw !== pw2) return setPwMsg({ ok: false, text: "Passwords do not match." });
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) return setPwMsg({ ok: false, text: error.message });
    setPw(""); setPw2("");
    setPwMsg({ ok: true, text: "Password updated." });
  };

  const myEmail = session?.user?.email ?? "";

  // ---- Landing ----
  if (view === "home") {
    const fmt = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString("en-GB"));
    const I = (...d: string[]) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d.map((x, i) => <path key={i} d={x} />)}</svg>;
    type Tile = { v: View; title: string; sub: string; accent: string; icon: ReactNode; stats?: [string, string][]; keys?: string };
    const workspace: Tile[] = [
      { v: "organization", title: "Organization", sub: "People, departments & who can open each page", accent: "#12b57f", keys: "people users departments structure access security",
        icon: I("M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-2h12v2"), stats: [[fmt(stats?.employees), "people"], [fmt(stats?.departments), "departments"]] },
      { v: "catalog", title: "Products & Services", sub: "Catalog, pricing, calculators & blueprints", accent: "#3c9ae0", keys: "catalog price products services blueprints",
        icon: I("M3 7l9-4 9 4-9 4-9-4z", "M3 7v10l9 4 9-4V7", "M12 11v10"), stats: [[fmt(stats?.products), "products"], [fmt(stats?.services), "services"]] },
      { v: "pipeline", title: "Client Pipelines", sub: "The phases a client goes through", accent: "#9b6fd0", keys: "pipelines phases deals",
        icon: I("M5 3.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8zM5 15.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8zM19 9.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z", "M7.4 6H12a3 3 0 0 1 3 3v.5M7.4 18H12a3 3 0 0 0 3-3v-.5"), stats: [[fmt(stats?.pipelines), "pipelines"]] },
      { v: "proposal", title: "Proposal template", sub: "Your PowerPoint deck & order form", accent: "#d1685f", keys: "proposal deck powerpoint order form",
        icon: I("M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M14 4v5h5M8 13h8M8 17h8M8 9h2") },
      { v: "tasks", title: "Tasks", sub: "Predefined tasks & processes", accent: "#5b6ee1", keys: "tasks processes templates",
        icon: I("M9 6h11M9 12h11M9 18h11", "M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2") },
    ];
    const pageTiles: Tile[] = [
      { v: "salespage", title: "Deals", sub: "Import, export, deal fields & sales roles", accent: "#3c9ae0", keys: "sales deals import export fields roles", icon: I("M4 19V9M10 19V5M16 19v-7M22 19H2") },
      { v: "companiespage", title: "Companies", sub: "Fields, sectors, sources, import & clean-up", accent: "#d98324", keys: "companies fields sectors sources import", icon: I("M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4M9 9h.01M15 9h.01M9 13h.01M15 13h.01") },
      { v: "contactspage", title: "Contacts", sub: "Fields, import, export & clean-up", accent: "#e0574b", keys: "contacts people fields import", icon: I("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8") },
      { v: "clientpage", title: "Clients", sub: "Folder templates & API access to client documents", accent: "#12b57f", keys: "clients api documents folders", icon: I("M7 8l-4 4 4 4M17 8l4 4-4 4M14 5l-4 14") },
      { v: "calendarpage", title: "Calendar", sub: "Time off & approvals, public holidays, working hours and cutoffs", accent: "#3c9ae0", keys: "calendar time off vacation holidays approvals allowance hours cutoffs billing security",
        icon: I("M3 9h18M8 3v4M16 3v4", "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z") },
      ...SECURITY_ONLY.map((x) => ({ v: x.view, title: x.title.replace(/ page$/, ""), sub: x.sub, accent: x.accent, keys: `${x.page} security`, icon: I(...x.svg.split(/(?=M)/)) })),
      { v: "mgmtpage", title: "Management", sub: "Incoming, billing & bonuses", accent: "#9b6fd0", keys: "management billing bonus backlog", icon: I("M3 4h18v16H3z", "M3 10h18M9 10v10") },
    ];
    const you: Tile[] = [
      { v: "interface", title: "Interface", sub: "Sidebar, labels & Outlook", accent: "#e0a13c", keys: "interface sidebar menu labels outlook",
        icon: I("M5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11A2.5 2.5 0 0 1 5.5 4z", "M8 4v16"),
        stats: [[dockLabels ? "On" : "Off", "menu labels"], [outlookConnected ? "Synced" : "Off", "Outlook"]] },
      { v: "account", title: "Your account", sub: "Password & details", accent: "#5a7d6d", keys: "account password profile",
        icon: I("M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M4 21a8 8 0 0 1 16 0"), stats: [[levelLabel(secLevel ?? role), "your level"]] },
    ];
    const needle = homeQ.trim().toLowerCase();
    const visible = (t: Tile) => viewOpen(t.v) && (crmLead || (t.v !== "companiespage" && t.v !== "contactspage"))
      && (!needle || `${t.title} ${t.sub} ${t.keys ?? ""}`.toLowerCase().includes(needle));
    const groups = [
      { k: "workspace", title: "Your company", sub: "Who works here, what you sell and how a client moves through", items: workspace.filter(visible) },
      { k: "pages", title: "Pages", sub: "What each page of the menu carries and who sees what in it", items: pageTiles.filter(visible) },
      { k: "you", title: "Just you", sub: "Your own account and how the app looks for you", items: you.filter(visible) },
    ].filter((g) => g.items.length);
    let n = 0;
    return (
      <div className="sty">
        <header className="sty-hero">
          <div className="sty-hero-txt">
            <h1>Settings</h1>
            <p>Everything you can set up, in one place.</p>
          </div>
          <label className="sty-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={homeQ} onChange={(e) => setHomeQ(e.target.value)} placeholder="Find a setting" aria-label="Find a setting" />
            {homeQ && <button onClick={() => setHomeQ("")} aria-label="Clear the search">×</button>}
          </label>
        </header>
        <div className="sty-body">
          {groups.length === 0 && <p className="sty-none">Nothing matches “{homeQ}”. Try “security”, “fields” or “import”.</p>}
          {groups.map((g) => (
            <section key={g.k} className="sty-group">
              <div className="sty-group-h"><h2>{g.title}</h2><p>{g.sub}</p></div>
              <div className={`sty-grid is-${g.k}`}>
                {g.items.map((t) => (
                  <button key={t.v} className="sty-card" style={{ ["--accent" as any]: t.accent, ["--i" as any]: n++ }} onClick={() => setView(t.v)}>
                    <span className="sty-card-top">
                      <span className="sty-ico">{t.icon}</span>
                      <svg className="sty-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M9 7h8v8" /></svg>
                    </span>
                    <b>{t.title}</b>
                    <small>{t.sub}</small>
                    {t.stats && <span className="sty-stats">{t.stats.map(([v, l]) => <i key={l}><b>{v}</b> {v === "1" ? l.replace(/s$/, "") : l}</i>)}</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    );
  }

  // ---- Page settings (second row) ----
  if (view === "companiespage" && crmLead) return <CompanySettings onBack={() => setView("home")} />;
  if (view === "contactspage" && crmLead) return <ContactSettings onBack={() => setView("home")} />;
  if (view === "clientpage") return <ClientPageSettings onBack={() => setView("home")} canManage={canManage || isSuperadmin === true} />;
  if (view === "salespage") return <SalesPage settings={{ onBack: () => setView("home") }} />;
  if (view === "calendarpage") return <CalendarPageSettings onBack={() => setView("home")} />;
  if (view === "mgmtpage") return <PageOnlySettings page="management" icon="grid" title="Management page" sub="Settings for incoming, billing & bonuses — and who sees whose figures" onBack={() => setView("home")} />;
  {
    const so = SECURITY_ONLY.find((x) => x.view === view);
    if (so) return <PageOnlySettings page={so.page} icon={so.icon} title={so.title} sub={so.sub} onBack={() => setView("home")} />;
  }

  // ---- Organization ----
  if (view === "organization") {
    return (
      <div className="st st-org">
        <header className="st-bar st-bar-row">
          <button className="st-back" onClick={() => { if (!(orgBackRef.current && orgBackRef.current())) setView("home"); }} aria-label="Back">‹</button>
          <div>
            <h1 className="st-title">Organization</h1>
          </div>
          <div className="st-org-toolbar" ref={orgToolbarRef} />
          <button
            className="st-pa-btn"
            onClick={() => canEditAccess && setShowPageAccess(true)}
            disabled={!canEditAccess}
            title={canEditAccess ? "Which departments can open each page" : `Only the Boss security level can change page access (your security level: ${secLevel ?? "none"})`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>
            Page access
          </button>
          <SuperAdminSwitch />
        </header>
        <Organization canManage={canManage} canSeeSensitive={canSeeSensitive} backRef={orgBackRef} toolbarRef={orgToolbarRef} />
        {showPageAccess && <PageAccessModal onClose={() => setShowPageAccess(false)} />}
      </div>
    );
  }

  // ---- Catalog (products & services) ----
  if (view === "catalog") {
    return (
      <div className="st">
        <CatalogPage onBack={() => setView("home")} />
      </div>
    );
  }

  if (view === "pipeline") {
    return (
      <div className="st st-pipeline">
        <PipelinePage onBack={() => setView("home")} />
      </div>
    );
  }

  // ---- Tasks: quick → process rule, predefined tasks & processes ----
  if (view === "tasks") {
    return <TaskSettings onBack={() => setView("home")} canManage={canManage || isSuperadmin === true} />;
  }

  // ---- Proposal template ----
  if (view === "proposal") {
    return <ProposalSettings canManage={canManage} onBack={() => setView("home")} />;
  }

  // ---- Users ----
  if (view === "users") {
    return (
      <div className="st">
        <UsersView
          users={users}
          loading={loading}
          scope={isBoss ? "All users" : "Your department"}
          onBack={() => setView("home")}
          onNew={() => setShowCreate(true)}
          onOpen={(u) => setSelected(u)}
        />
        {showCreate && (
          <NewUserModal allowedLevels={allowedLevels} onCreate={createUser} onClose={() => setShowCreate(false)} />
        )}
        {selected && (
          <UserDetailModal
            user={selected}
            canEditRole={isBoss}
            allowedLevels={allowedLevels.length ? allowedLevels : LEVELS.map((l) => l.id)}
            onSave={updateUser}
            onReset={resetUserPassword}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    );
  }

// ---- Interface ----
  if (view === "interface") {
    return (
      <div className="st">
        <header className="st-bar st-bar-back">
          <button className="uv-back" onClick={() => setView("home")}>‹ Settings</button>
          <h1 className="st-title">Interface</h1>
          <p className="st-sub">How the workspace behaves</p>
        </header>

        <section className="st-section" style={{ maxWidth: 640 }}>
          <div className="st-toggle-row">
            <div className="st-toggle-text">
              <span className="st-toggle-label">Always show menu labels</span>
              <span className="st-toggle-note">
                Show each item's name under its icon in the sidebar instead of only on hover.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={dockLabels}
              className={`st-switch ${dockLabels ? "on" : ""}`}
              onClick={toggleLabels}
            >
              <span className="st-switch-knob" />
            </button>
          </div>

          <div className="st-dock-order">
            <div className="st-toggle-text">
              <span className="st-toggle-label">Toolbar order</span>
              <span className="st-toggle-note">Drag the items into the order that suits you. Only you see this order.</span>
            </div>
            <div className="st-dock-list">
              {dockShown.map((it, i) => (
                <div key={it.path} draggable
                  className={`st-dock-row ${dockDrag === it.path ? "is-dragging" : ""} ${dockOver === it.path && dockDrag !== it.path ? "is-over" : ""}`}
                  onDragStart={(e) => { setDockDrag(it.path); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setDockDrag(null); setDockOver(null); }}
                  onDragOver={(e) => { if (!dockDrag) return; e.preventDefault(); if (dockOver !== it.path) setDockOver(it.path); }}
                  onDrop={(e) => { e.preventDefault(); const b = e.currentTarget.getBoundingClientRect(); dropDock(it.path, e.clientY > b.top + b.height / 2); setDockDrag(null); setDockOver(null); }}>
                  <span className="st-dock-grip" aria-hidden="true">⋮⋮</span>
                  <span className="st-dock-ico">{it.icon}</span>
                  <span className="st-dock-name">{it.label}</span>
                  <span className="st-dock-pos">{i + 1}</span>
                  <button type="button" className="st-dock-mv" onClick={() => moveDock(it.path, -1)} disabled={i === 0} aria-label={`Move ${it.label} up`}>↑</button>
                  <button type="button" className="st-dock-mv" onClick={() => moveDock(it.path, 1)} disabled={i === dockShown.length - 1} aria-label={`Move ${it.label} down`}>↓</button>
                </div>
              ))}
            </div>
            {dockOrder.length > 0 && <button type="button" className="st-dock-reset" onClick={() => saveDockOrder([])}>Reset to the default order</button>}
          </div>

          <div className="st-toggle-row" style={{ marginTop: "1.1rem" }}>
            <div className="st-toggle-text">
              <span className="st-toggle-label">Sync calendar to Outlook</span>
              <span className="st-toggle-note">
                {outlookConnected
                  ? "Connected. New and edited activities appear in your Outlook calendar."
                  : "Connect your Outlook so activities you book here also land in your Outlook calendar."}
                {!outlookConnected && outlookError && (
                  <span style={{ display: "block", marginTop: 6, color: "#a83434", fontWeight: 600 }}>Couldn't connect: {outlookError}</span>
                )}
              </span>
            </div>
            <button
              type="button"
              className={`st-outlook-btn ${outlookConnected ? "is-connected" : ""}`}
              onClick={handleOutlook}
              disabled={outlookBusy || outlookConnected === null}
            >
              {outlookConnected === null ? "…" : outlookBusy && !outlookConnected ? "Waiting for Microsoft…" : outlookConnected ? "Disconnect" : "Connect Outlook"}
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ---- Account ----
  return (
    <div className="st">
      <header className="st-bar st-bar-back">
        <button className="uv-back" onClick={() => setView("home")}>‹ Settings</button>
        <h1 className="st-title">Your account</h1>
        <p className="st-sub">Signed in as {myEmail} · {levelLabel(secLevel ?? role)}</p>
      </header>

      <section className="st-section" style={{ maxWidth: 640 }}>
        <h2 className="st-h2">Change password</h2>
        <div className="st-pw">
          <div className="cl-field"><label>New password</label>
            <input type="password" className="cl-input" value={pw} onChange={(e) => setPw(e.target.value)} />
          </div>
          <div className="cl-field"><label>Confirm password</label>
            <input type="password" className="cl-input" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </div>
          <button className="cl-primary" onClick={changeOwnPassword}>Update</button>
        </div>
        {pwMsg && <p className={pwMsg.ok ? "st-ok" : "su-error"}>{pwMsg.text}</p>}
      </section>

      <section className="st-section st-signout" style={{ maxWidth: 640 }}>
        <div>
          <h2 className="st-h2">Sign out</h2>
          <p className="st-signout-sub">Close your session on this device.</p>
        </div>
        <button className="st-signout-btn" onClick={async () => {
          await supabase.auth.signOut().catch(() => {});
          window.location.assign("/login");
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
          Sign out
        </button>
      </section>
    </div>
  );
}
/* =====================================================================
   Settings → Client page: API keys for the client files API
   (served by the manage-users Edge Function under /api).
   ===================================================================== */
interface ApiKeyRow {
  id: string; name: string; prefix: string; access: "read" | "write"; client_ids: string[] | null;
  expires_at: string | null; last_used_at: string | null; revoked_at: string | null; created_at: string;
}
const API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/api`;
const API_ENDPOINTS: [string, string, string, boolean][] = [
  ["GET", "/clients", "Clients this key can reach", false],
  ["GET", "/clients/{client}/tree", "Every folder (with its path) and file of a client", false],
  ["GET", "/clients/{client}/files?folder=Contracts/2026", "Files in one folder (id or path); no folder = all", false],
  ["GET", "/clients/{client}/files/{file}", "File details and a download link valid for 10 min (?redirect=1 jumps to it)", false],
  ["GET", "/clients/{client}/files/{file}/content", "The file itself", false],
  ["POST", "/clients/{client}/files?name=offer.pdf&folder=Contracts", "Upload: the body is the file; missing folders are created", true],
  ["PUT", "/clients/{client}/files/{file}", "Replace the file's content (body = new file)", true],
  ["PATCH", "/clients/{client}/files/{file}", "JSON { name, note, folder } — rename, note or move", true],
  ["DELETE", "/clients/{client}/files/{file}", "Delete the file", true],
  ["GET", "/clients/{client}/folders", "Folders with their paths", false],
  ["POST", "/clients/{client}/folders", "JSON { name, parent } — create (parent = id or path)", true],
  ["PATCH", "/clients/{client}/folders/{folder}", "JSON { name, parent } — rename or move", true],
  ["DELETE", "/clients/{client}/folders/{folder}", "Delete the folder, its subfolders and files", true],
];
const shortDate = (d: string | null) => d ? new Date(d).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";
const hashKey = async (t: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

/** A page's settings that, for now, hold only its Security section. */
/** Settings › Calendar: what the calendar runs on. People ask for their own time off from the calendar. */
function CalendarPageSettings({ onBack }: { onBack: () => void }) {
  const sec = useSecuritySection("calendar");
  const sections = [
    { k: "approvals", label: "Approvals", icon: "flag", tone: "amber" as const, title: "Time off requests", hint: "Approve, decline or cancel what people ask for — approved holidays go straight into their calendar", body: <TimeOffApprovals /> },
    { k: "allowances", label: "Vacation days", icon: "users", tone: "green" as const, title: "Vacation days per person", hint: "The company default, and each person's own days for the year when they differ", body: <TimeOffAllowances /> },
    { k: "holidays", label: "Public holidays", icon: "star", tone: "rose" as const, title: "Public holidays", hint: "Days off for everyone: nobody is expected to work them", body: <PublicHolidays /> },
    { k: "hours", label: "Working hours", icon: "clock", tone: "blue" as const, title: "Working hours", hint: "The company's week, and where a department or a person differs", body: <div className="cws-hours-embed"><HoursEditor /></div> },
    { k: "cutoffs", label: "Billing cutoffs", icon: "euro", tone: "violet" as const, title: "Billing cutoffs", hint: "The day each billing month closes", body: <CutoffsEditor /> },
    ...(sec ? [{ ...sec, hint: "Whose calendars and logged time people see" }] : []),
    ...(sec ? [{ k: "access", label: "Who can set it up", icon: "lock", tone: "slate" as const, title: "Who can open these settings", hint: "The people who approve time off and set holidays, hours and cutoffs",
      body: <PanelAccess panelKey="settings.calendar" what="Settings › Calendar" /> }] : []),
  ];
  return <SettingsShell icon="calendar" title="Calendar" sub="Time off, public holidays, working hours and cutoffs" onBack={onBack} sections={sections} />;
}

function PageOnlySettings({ page, icon, title, sub, onBack }: { page: PageKey; icon: string; title: string; sub: string; onBack: () => void }) {
  const sec = useSecuritySection(page);
  return (
    <SettingsShell icon={icon} title={title} sub={sub} onBack={onBack}
      sections={sec ? [sec] : [{ k: "none", label: title, icon: "lock", tone: "slate", title: "Nothing to set up yet", hint: "Settings for this page will appear here", body: <p className="st-note">Nothing to set up here yet.</p> }]} />
  );
}

export function ClientPageSettings({ onBack, canManage }: { onBack: () => void; canManage: boolean }) {
  const secSection = useSecuritySection("clients");
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; access: "read" | "write"; scope: "all" | "some"; picked: string[]; expires: string } | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [askRevoke, setAskRevoke] = useState<string | null>(null);

  const load = async () => {
    const [k, c] = await Promise.all([
      supabase.from("client_api_keys").select("id, name, prefix, access, client_ids, expires_at, last_used_at, revoked_at, created_at").order("created_at", { ascending: false }),
      supabase.from("clients").select("id, name").order("name"),
    ]);
    if (k.error) { setErr(/client_api_keys/.test(k.error.message) ? "Run client_api.sql in Supabase first." : k.error.message); setKeys([]); }
    else setKeys((k.data ?? []) as ApiKeyRow[]);
    setClients(((c.data ?? []) as any[]).map((x) => ({ id: String(x.id), name: x.name ?? "" })));
  };
  useEffect(() => { load(); }, []);

  const copy = (t: string, k: string) => {
    navigator.clipboard?.writeText(t).then(() => { setCopied(k); window.setTimeout(() => setCopied(null), 1400); }).catch(() => {});
  };
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "Unknown client";

  const create = async () => {
    if (!form || !form.name.trim()) return;
    if (form.scope === "some" && !form.picked.length) { setErr("Pick at least one client."); return; }
    setBusy(true); setErr(null);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = "fck_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    const days = Number(form.expires);
    const { error } = await supabase.from("client_api_keys").insert({
      name: form.name.trim(), prefix: key.slice(0, 12), key_hash: await hashKey(key), access: form.access,
      client_ids: form.scope === "some" ? form.picked : null,
      expires_at: days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setFresh(key); setForm(null); setQ("");
    load();
  };
  const revoke = async (id: string) => {
    setAskRevoke(null);
    const { error } = await supabase.from("client_api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (error) { setErr(error.message); return; }
    load();
  };

  const statusOf = (k: ApiKeyRow) => k.revoked_at ? "revoked" : k.expires_at && new Date(k.expires_at).getTime() < Date.now() ? "expired" : "active";
  const shownClients = q ? clients.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())) : clients;
  const sample = `curl -H "x-api-key: fck_…" "${API_BASE}/clients"`;

  const keysBody = (
    <>
      <div className="cps-keybar">
        <p className="st-note">Each key reaches the documents and folders of all clients, or only the ones you pick. Read keys list and download; write keys also upload, replace, rename, move and delete.</p>
        {canManage && !form && <button className="cl-primary" onClick={() => { setForm({ name: "", access: "read", scope: "all", picked: [], expires: "0" }); setFresh(null); setErr(null); }}>+ New key</button>}
      </div>

      {fresh && (
        <div className="cps-fresh">
          <b>Your new key</b>
          <p>Copy it now: it won't be shown again.</p>
          <div className="cps-base is-key">
            <code>{fresh}</code>
            <button className="cps-copy" onClick={() => copy(fresh, "fresh")}>{copied === "fresh" ? "Copied" : "Copy"}</button>
          </div>
          <button className="cps-link" onClick={() => setFresh(null)}>Done</button>
        </div>
      )}

      {form && (
        <div className="cps-form">
          <div className="cl-field"><label>Name</label>
            <input className="cl-input" autoFocus placeholder="e.g. SharePoint sync" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="cps-row">
            <div className="cl-field"><label>Access</label>
              <div className="cps-seg">
                {(["read", "write"] as const).map((a) => (
                  <button key={a} className={form.access === a ? "is-on" : ""} onClick={() => setForm({ ...form, access: a })}>{a === "read" ? "Read only" : "Read & write"}</button>
                ))}
              </div>
            </div>
            <div className="cl-field"><label>Clients</label>
              <div className="cps-seg">
                <button className={form.scope === "all" ? "is-on" : ""} onClick={() => setForm({ ...form, scope: "all" })}>All clients</button>
                <button className={form.scope === "some" ? "is-on" : ""} onClick={() => setForm({ ...form, scope: "some" })}>Only some</button>
              </div>
            </div>
            <div className="cl-field"><label>Expires</label>
              <Select value={form.expires} onChange={(v) => setForm({ ...form, expires: v })}
                options={[{ value: "0", label: "Never" }, { value: "30", label: "In 30 days" }, { value: "90", label: "In 90 days" }, { value: "365", label: "In a year" }]} />
            </div>
          </div>
          {form.scope === "some" && (
            <div className="cps-pick">
              <input className="cl-input" placeholder="Search clients…" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="cps-pick-list">
                {shownClients.map((c) => {
                  const on = form.picked.includes(c.id);
                  return (
                    <button key={c.id} className={`cps-chip ${on ? "is-on" : ""}`}
                      onClick={() => setForm({ ...form, picked: on ? form.picked.filter((x) => x !== c.id) : [...form.picked, c.id] })}>
                      <i />{c.name || "Unnamed"}
                    </button>
                  );
                })}
                {!shownClients.length && <span className="st-note">No clients match.</span>}
              </div>
            </div>
          )}
          <div className="cps-actions">
            <button className="cps-link" onClick={() => { setForm(null); setErr(null); }}>Cancel</button>
            <button className="cl-primary" disabled={busy || !form.name.trim()} onClick={create}>{busy ? "Creating…" : "Create key"}</button>
          </div>
        </div>
      )}

      {err && <p className="su-error">{err}</p>}

      <div className="cps-keys">
        {keys === null && <PageLoader fill={false} size={80} label="Loading keys" />}
        {keys?.length === 0 && !err && <p className="cps-none">No keys yet. Create one to let another app reach client documents.</p>}
        {keys?.map((k, i) => {
          const st = statusOf(k);
          return (
            <div className={`cps-key is-${st}`} key={k.id} style={{ ["--i" as any]: i }}>
              <span className="cps-key-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M15 7a4 4 0 1 1-3.9 4.9L3 20v-3h3v-3h3l2.1-2.1A4 4 0 0 1 15 7zM16 10h.01" /></svg></span>
              <div className="cps-key-main">
                <b>{k.name}</b>
                <code>{k.prefix}…</code>
              </div>
              <span className={`cps-badge is-${k.access}`}>{k.access === "write" ? "Read & write" : "Read only"}</span>
              <span className="cps-scope" title={k.client_ids?.length ? k.client_ids.map(clientName).join(", ") : undefined}>
                {k.client_ids?.length ? `${k.client_ids.length} client${k.client_ids.length === 1 ? "" : "s"}` : "All clients"}
              </span>
              <span className="cps-meta">Used {k.last_used_at ? shortDate(k.last_used_at) : "never"}</span>
              <span className="cps-meta">{k.expires_at ? `Expires ${shortDate(k.expires_at)}` : "No expiry"}</span>
              {st !== "active" ? <span className={`cps-badge is-${st}`}>{st === "revoked" ? "Revoked" : "Expired"}</span>
                : !canManage ? <span className="cps-badge is-active">Active</span>
                : askRevoke === k.id ? (
                  <span className="cps-ask">Revoke? <button className="is-yes" onClick={() => revoke(k.id)}>Yes</button><button onClick={() => setAskRevoke(null)}>No</button></span>
                ) : <button className="cps-revoke" onClick={() => setAskRevoke(k.id)}>Revoke</button>}
            </div>
          );
        })}
      </div>
    </>
  );
  const eps = (pred: (path: string) => boolean) => (
    <div className="cps-eps">
      {API_ENDPOINTS.filter(([, path]) => pred(path)).map(([m, path, what, write], i) => (
        <div className="cps-ep" key={m + path} style={{ ["--i" as any]: i }}>
          <span className={`cps-m is-${m.toLowerCase()}`}>{m}</span>
          <code>{path}</code>
          <span className="cps-ep-d">{what}{write && <em>write</em>}</span>
        </div>
      ))}
    </div>
  );
  const active = (keys ?? []).filter((k) => statusOf(k) === "active").length;
  return (
    <SettingsShell icon="lock" title="Client page" sub="Standard folders for every client, and access for other apps" onBack={onBack}
      tags={<>
        <span className="sx-tag is-ok">{active} active key{active === 1 ? "" : "s"}</span>
        <span className="sx-tag">{clients.length} clients</span>
        <span className="sx-tag">{API_ENDPOINTS.length} endpoints</span>
      </>}
      sections={[
        { k: "skeletons", label: "Folder templates", icon: "folder", tone: "amber", title: "Folder templates", hint: "Standard folder structures you add to any client from its Folders tab, in one click",
          body: <FolderTemplatesEditor canEdit={canManage} /> },
        { k: "keys", label: "API keys", icon: "lock", tone: "green", count: (keys ?? []).length, title: "API keys", hint: "Who can reach client documents from outside, and how much they can do", body: keysBody },
        { k: "connect", label: "Connecting", icon: "link", tone: "blue", title: "Connecting", hint: "Where to call and how to send the key",
          body: (
            <>
              <div className="cps-base">
                <span className="cps-k">Base URL</span>
                <code>{API_BASE}</code>
                <button className="cps-copy" onClick={() => copy(API_BASE, "base")}>{copied === "base" ? "Copied" : "Copy"}</button>
              </div>
              <p className="st-note">Send the key in the <code>x-api-key</code> header. Folders can be given by id or by path, like <code>Contracts/2026</code>.</p>
              <div className="cps-base is-sample">
                <code>{sample}</code>
                <button className="cps-copy" onClick={() => copy(sample, "sample")}>{copied === "sample" ? "Copied" : "Copy"}</button>
              </div>
            </>
          ) },
        { k: "clients", label: "Clients", icon: "building", tone: "violet", count: API_ENDPOINTS.filter(([, p]) => !/\/(files|folders)/.test(p)).length, title: "Clients & tree", hint: "The clients a key reaches, and everything in one client at once", body: eps((p) => !/\/(files|folders)/.test(p)) },
        { k: "files", label: "Files", icon: "note", tone: "amber", count: API_ENDPOINTS.filter(([, p]) => /\/files/.test(p)).length, title: "Files", hint: "List, download, upload, replace, rename, move and delete files", body: eps((p) => /\/files/.test(p)) },
        { k: "folders", label: "Folders", icon: "tree", tone: "indigo", count: API_ENDPOINTS.filter(([, p]) => /\/folders/.test(p)).length, title: "Folders", hint: "Create, rename, move and delete folders", body: eps((p) => /\/folders/.test(p)) },
        ...(secSection ? [secSection] : []),
      ]} />
  );
}
