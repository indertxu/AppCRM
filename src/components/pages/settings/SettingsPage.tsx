import { useEffect, useRef, useState } from "react";
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
import PageAccessModal from "./PageAccessModal";
import Select from "../../framework/Select";
import TaskSettings from "./TaskSettings";
import { usePageAccess } from "../../framework/pageAccess";
import { SuperAdminSwitch } from "../../framework/SuperAdmin";
import { connectOutlook, completeOutlookConnect, outlookStatus, disconnectOutlook, outlookConnectError, OUTLOOK_CONNECTION_EVENT } from "../../api/outlookSync";
import { DOCK_ITEMS, DOCK_ORDER_KEY, DOCK_ORDER_EVENT, orderDock } from "../../framework/Dock";
import { loadPrefs, savePref, isSalesLead } from "../companies/companiesApi";
import { CompanySettings, SettingsShell } from "../companies/CompaniesPage";
import { ContactSettings } from "../contacts/ContactsPage";
import SalesPage from "../sales/sales/SalesPage";
import { useLocation, useNavigate } from "react-router-dom";
import "./SettingsPage.css";

const levelLabel = (id: string | null) => LEVELS.find((l) => l.id === id)?.label ?? id ?? "—";

type View = "home" | "users" | "organization" | "account" | "interface" | "catalog" | "pipeline" | "proposal" | "tasks" | "salespage" | "mgmtpage" | "clientpage" | "companiespage" | "contactspage";
/** Which Page-access panel opens each view (Settings → Organization → Page access → Settings). */
const VIEW_PANEL: Partial<Record<View, string>> = {
  organization: "settings.organization",
  catalog: "settings.catalog",
  pipeline: "settings.pipelines",
  proposal: "settings.proposal",
};

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
  const canEditAccess = secLevel === "boss" || secSuper || isSuperadmin === true;
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
  // A panel switched off in Page access can't be opened (also not while it's open).
  const view: View = VIEW_PANEL[viewRaw] && !(accessReady && canPanel(VIEW_PANEL[viewRaw]!)) ? "home" : viewRaw;
  const seesCompanyCards = ["settings.organization", "settings.catalog", "settings.pipelines", "settings.proposal"].some((k) => canPanel(k));
  const [showPageAccess, setShowPageAccess] = useState(false);

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
    const fmt = (n: number | undefined) => (n === undefined ? "—" : String(n));
    return (
      <div className="st st-landing">
        <header className="st-bar">
          <h1 className="st-title">Settings</h1>
          <p className="st-sub">Manage your workspace</p>
        </header>

        <div className="nav-rows">
        <div className="nav-cards">
          {canPanel("settings.organization") && (
            <button className="nav-card" style={{ ["--accent" as any]: "#12b57f" }} onClick={() => setView("organization")}>
              <span className="nav-card-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="3" width="6" height="5" rx="1.2" /><rect x="3" y="16" width="6" height="5" rx="1.2" />
                  <rect x="15" y="16" width="6" height="5" rx="1.2" /><path d="M12 8v4M6 16v-2h12v2" />
                </svg>
              </span>
              <span className="nav-card-title">Organization</span>
              <span className="nav-card-sub">People, departments &amp; structure</span>
              <span className="nav-card-spacer" />
              <div className="nav-insights">
                <div className="nav-stat"><b>{fmt(stats?.employees)}</b><span>people</span></div>
                <div className="nav-stat"><b>{fmt(stats?.departments)}</b><span>departments</span></div>
              </div>
              <span className="nav-card-go">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
            </button>
          )}

          {canPanel("settings.catalog") && (
            <button className="nav-card" style={{ ["--accent" as any]: "#3c9ae0" }} onClick={() => setView("catalog")}>
              <span className="nav-card-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 7v10l9 4 9-4V7" /><path d="M12 11v10" />
                </svg>
              </span>
              <span className="nav-card-title">Products &amp; Services</span>
              <span className="nav-card-sub">Catalog, pricing &amp; blueprints</span>
              <span className="nav-card-spacer" />
              <div className="nav-insights">
                <div className="nav-stat"><b>{fmt(stats?.products)}</b><span>products</span></div>
                <div className="nav-stat"><b>{fmt(stats?.services)}</b><span>services</span></div>
              </div>
              <span className="nav-card-go">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
            </button>
          )}

          {canPanel("settings.pipelines") && (
            <button className="nav-card" style={{ ["--accent" as any]: "#9b6fd0" }} onClick={() => setView("pipeline")}>
              <span className="nav-card-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="5" cy="6" r="2.4" /><circle cx="5" cy="18" r="2.4" /><circle cx="19" cy="12" r="2.4" />
                  <path d="M7.4 6H12a3 3 0 0 1 3 3v.5M7.4 18H12a3 3 0 0 0 3-3v-.5" />
                </svg>
              </span>
              <span className="nav-card-title">Client Pipelines</span>
              <span className="nav-card-sub">Design the phases a client goes through</span>
              <span className="nav-card-spacer" />
              <div className="nav-insights">
                <div className="nav-stat"><b>{fmt(stats?.pipelines)}</b><span>pipelines</span></div>
              </div>
              <span className="nav-card-go">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
            </button>
          )}

          {canPanel("settings.proposal") && (
            <button className="nav-card" style={{ ["--accent" as any]: "#d1685f" }} onClick={() => setView("proposal")}>
              <span className="nav-card-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /><path d="M14 4v5h5M8 13h8M8 17h8M8 9h2" /></svg>
              </span>
              <span className="nav-card-title">Proposal template</span>
              <span className="nav-card-sub">Your PowerPoint deck &amp; order form</span>
              <span className="nav-card-spacer" />
              <span className="nav-card-go">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
            </button>
          )}

          <button className="nav-card" style={{ ["--accent" as any]: "#5b6ee1" }} onClick={() => setView("tasks")}>
            <span className="nav-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
              </svg>
            </span>
            <span className="nav-card-title">Tasks</span>
            <span className="nav-card-sub">Predefined tasks &amp; processes, and when a task becomes a process</span>
            <span className="nav-card-spacer" />
            <span className="nav-card-go">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </span>
          </button>

          <button className="nav-card" style={{ ["--accent" as any]: "#e0a13c" }} onClick={() => setView("interface")}>
            <span className="nav-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M8 4v16" />
              </svg>
            </span>
            <span className="nav-card-title">Interface</span>
            <span className="nav-card-sub">Sidebar &amp; layout</span>
            <span className="nav-card-spacer" />
            <div className="nav-insights">
              <div className="nav-stat"><b>{dockLabels ? "On" : "Off"}</b><span>menu labels</span></div>
              <div className="nav-stat"><b>{outlookConnected ? "Yes" : "No"}</b><span>outlook synced</span></div>
            </div>
            <span className="nav-card-go">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </span>
          </button>

          <button className="nav-card" style={{ ["--accent" as any]: "#5a7d6d" }} onClick={() => setView("account")}>
            <span className="nav-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
              </svg>
            </span>
            <span className="nav-card-title">Your account</span>
            <span className="nav-card-sub">Password &amp; details</span>
            <span className="nav-card-spacer" />
            <div className="nav-insights">
              <div className="nav-stat nav-stat-wide"><b>{levelLabel(role)}</b><span>your role</span></div>
            </div>
            <span className="nav-card-go">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </span>
          </button>
        </div>

        <h2 className="nav-row-k">Pages</h2>
        <div className="nav-cards is-pages">
          <button className="nav-card" style={{ ["--accent" as any]: "#3c9ae0" }} onClick={() => setView("salespage")}>
            <span className="nav-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></svg>
            </span>
            <span className="nav-card-title">Deals page</span>
            <span className="nav-card-sub">Import, export, deal fields &amp; sales roles</span>
            <span className="nav-card-spacer" />
            <span className="nav-card-go">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
          </button>
          <button className="nav-card" style={{ ["--accent" as any]: "#9b6fd0" }} onClick={() => setView("mgmtpage")}>
            <span className="nav-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 10h18M9 10v10" /></svg>
            </span>
            <span className="nav-card-title">Management page</span>
            <span className="nav-card-sub">Settings for incoming, billing &amp; bonuses</span>
            <span className="nav-card-spacer" />
            <span className="nav-card-go">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
          </button>
          {crmLead && (
            <button className="nav-card" style={{ ["--accent" as any]: "#d98324" }} onClick={() => setView("companiespage")}>
              <span className="nav-card-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4M9 9h.01M15 9h.01M9 13h.01M15 13h.01" /></svg>
              </span>
              <span className="nav-card-title">Companies page</span>
              <span className="nav-card-sub">Custom fields, sectors &amp; sources, import, export &amp; clean-up</span>
              <span className="nav-card-spacer" />
              <span className="nav-card-go">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
            </button>
          )}
          {crmLead && (
            <button className="nav-card" style={{ ["--accent" as any]: "#e0574b" }} onClick={() => setView("contactspage")}>
              <span className="nav-card-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></svg>
              </span>
              <span className="nav-card-title">Contacts page</span>
              <span className="nav-card-sub">Fields, import, export &amp; clean-up</span>
              <span className="nav-card-spacer" />
              <span className="nav-card-go">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
            </button>
          )}
          <button className="nav-card" style={{ ["--accent" as any]: "#12b57f" }} onClick={() => setView("clientpage")}>
            <span className="nav-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 8l-4 4 4 4M17 8l4 4-4 4M14 5l-4 14" /></svg>
            </span>
            <span className="nav-card-title">Client page</span>
            <span className="nav-card-sub">API access to client documents &amp; folders</span>
            <span className="nav-card-spacer" />
            <span className="nav-card-go">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
          </button>
        </div>
        </div>
      </div>
    );
  }

  // ---- Page settings (second row) ----
  if (view === "companiespage" && crmLead) return <CompanySettings onBack={() => setView("home")} />;
  if (view === "contactspage" && crmLead) return <ContactSettings onBack={() => setView("home")} />;
  if (view === "clientpage") return <ClientPageSettings onBack={() => setView("home")} canManage={canManage || isSuperadmin === true} />;
  if (view === "salespage") return <SalesPage settings={{ onBack: () => setView("home") }} />;
  if (view === "mgmtpage") {
    return (
      <div className="st">
        <header className="st-bar st-bar-back">
          <button className="uv-back" onClick={() => setView("home")}>‹ Settings</button>
          <h1 className="st-title">Management page</h1>
          <p className="st-sub">Settings for this page</p>
        </header>
        <section className="st-section cps-empty">
          <p className="st-note">Nothing to set up here yet.</p>
        </section>
      </div>
    );
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
            title={canEditAccess ? "Which pages and panels each person can open" : `Only the Boss security level can change page access (your security level: ${secLevel ?? "none"})`}
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
        <p className="st-sub">Signed in as {myEmail} · {levelLabel(role)}</p>
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

export function ClientPageSettings({ onBack, canManage }: { onBack: () => void; canManage: boolean }) {
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
    <SettingsShell icon="lock" title="Client page" sub="Let other apps read and manage client documents and folders" onBack={onBack}
      tags={<>
        <span className="sx-tag is-ok">{active} active key{active === 1 ? "" : "s"}</span>
        <span className="sx-tag">{clients.length} clients</span>
        <span className="sx-tag">{API_ENDPOINTS.length} endpoints</span>
      </>}
      sections={[
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
      ]} />
  );
}
