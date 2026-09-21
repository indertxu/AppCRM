import { useEffect, useRef, useState } from "react";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/authContext";
import NewUserModal, { LEVELS, type NewUserPayload } from "./NewUserModal";
import UsersView, { type UserRow } from "./UsersView";
import UserDetailModal from "./UserDetailModal";
import Organization from "./Organization";
import CatalogPage from "./CatalogPage";
import PipelinePage from "./PipelinePage";
import ProposalTemplateEditor from "./ProposalTemplateEditor";
import { connectOutlook, completeOutlookConnect, outlookStatus, disconnectOutlook } from "../../api/outlookSync";
import "./SettingsPage.css";

const levelLabel = (id: string | null) => LEVELS.find((l) => l.id === id)?.label ?? id ?? "—";

type View = "home" | "users" | "organization" | "account" | "interface" | "catalog" | "pipeline" | "proposal";

export const DOCK_PINNED_KEY = "next.dockPinned";
export const DOCK_PINNED_EVENT = "next:dock-pinned";

export default function SettingsPage() {
  const { session, role } = useAuth();
  console.log("my role →", role);
  const isBoss = role === "boss";
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

  const [view, setView] = useState<View>("home");

  // Quick insights shown on the landing cards (loaded lazily).
  const [stats, setStats] = useState<{
    employees: number; departments: number;
    products: number; services: number; pipelines: number;
  } | null>(null);
  useEffect(() => {
    if (!canManage) return;
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
  }, [canManage]);

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
  const [dockPinned, setDockPinned] = useState<boolean>(
    () => localStorage.getItem(DOCK_PINNED_KEY) === "true"
  );

  const uid = session?.user?.id ?? null;

  // Load the saved preference from the user's profile on mount.
  useEffect(() => {
    if (!uid) return;
    (async () => {
      const { data } = await supabase.from("profiles").select("dock_pinned").eq("id", uid).maybeSingle();
      if (data && typeof data.dock_pinned === "boolean") {
        setDockPinned(data.dock_pinned);
        localStorage.setItem(DOCK_PINNED_KEY, String(data.dock_pinned));
        window.dispatchEvent(new CustomEvent(DOCK_PINNED_EVENT, { detail: data.dock_pinned }));
      }
    })();
  }, [uid]);

  const toggleDock = async () => {
    const next = !dockPinned;
    setDockPinned(next);
    localStorage.setItem(DOCK_PINNED_KEY, String(next));
    window.dispatchEvent(new CustomEvent(DOCK_PINNED_EVENT, { detail: next }));
    if (uid) await supabase.from("profiles").update({ dock_pinned: next }).eq("id", uid);
  };

  // Outlook connection state
  const [outlookConnected, setOutlookConnected] = useState<boolean | null>(null);
  const [outlookBusy, setOutlookBusy] = useState(false);
  useEffect(() => {
    (async () => {
      const finished = await completeOutlookConnect().catch(() => false);
      const status = await outlookStatus().catch(() => false);
      setOutlookConnected(finished || status);
    })();
  }, []);
  const handleOutlook = async () => {
    if (outlookConnected) {
      setOutlookBusy(true);
      await disconnectOutlook().catch(() => {});
      setOutlookConnected(false);
      setOutlookBusy(false);
    } else {
      await connectOutlook();
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

        <div className="nav-cards">
          {canManage && (
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

          {canManage && (
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

          {canManage && (
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

          {canManage && (
            <button className="nav-card" style={{ ["--accent" as any]: "#d1685f" }} onClick={() => setView("proposal")}>
              <span className="nav-card-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /><path d="M14 4v5h5M8 13h8M8 17h8M8 9h2" /></svg>
              </span>
              <span className="nav-card-title">Proposal template</span>
              <span className="nav-card-sub">Brand, copy &amp; terms for proposals</span>
              <span className="nav-card-spacer" />
              <span className="nav-card-go">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
            </button>
          )}

          <button className="nav-card" style={{ ["--accent" as any]: "#e0a13c" }} onClick={() => setView("interface")}>
            <span className="nav-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M8 4v16" />
              </svg>
            </span>
            <span className="nav-card-title">Interface</span>
            <span className="nav-card-sub">Toolbar &amp; layout</span>
            <span className="nav-card-spacer" />
            <div className="nav-insights">
              <div className="nav-stat"><b>{dockPinned ? "On" : "Off"}</b><span>toolbar pinned</span></div>
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
        </header>
        <Organization canManage={canManage} canSeeSensitive={canSeeSensitive} backRef={orgBackRef} toolbarRef={orgToolbarRef} />
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

  // ---- Proposal template ----
  if (view === "proposal") {
    return (
      <div className="st">
        <header className="st-bar st-bar-row">
          <button className="st-back" onClick={() => setView("home")} aria-label="Back">‹</button>
          <div>
            <h1 className="st-title">Proposal template</h1>
          </div>
        </header>
        <ProposalTemplateEditor canManage={canManage} />
      </div>
    );
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
              <span className="st-toggle-label">Keep the toolbar expanded</span>
              <span className="st-toggle-note">
                When off, the dock stays hidden and slides in when you reach the left edge.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={dockPinned}
              className={`st-switch ${dockPinned ? "on" : ""}`}
              onClick={toggleDock}
            >
              <span className="st-switch-knob" />
            </button>
          </div>

          <div className="st-toggle-row" style={{ marginTop: "1.1rem" }}>
            <div className="st-toggle-text">
              <span className="st-toggle-label">Sync calendar to Outlook</span>
              <span className="st-toggle-note">
                {outlookConnected
                  ? "Connected. New and edited activities appear in your Outlook calendar."
                  : "Connect your Outlook so activities you book here also land in your Outlook calendar."}
              </span>
            </div>
            <button
              type="button"
              className={`st-outlook-btn ${outlookConnected ? "is-connected" : ""}`}
              onClick={handleOutlook}
              disabled={outlookBusy || outlookConnected === null}
            >
              {outlookConnected === null ? "…" : outlookConnected ? "Disconnect" : "Connect Outlook"}
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
    </div>
  );
}