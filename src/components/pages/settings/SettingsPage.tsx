import { useEffect, useState } from "react";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import NewUserModal, { LEVELS, type NewUserPayload } from "./NewUserModal";
import UsersView, { type UserRow } from "./UsersView";
import UserDetailModal from "./UserDetailModal";
import { connectOutlook, completeOutlookConnect, outlookStatus, disconnectOutlook } from "../../api/outlookSync";
import "./SettingsPage.css";

const levelLabel = (id: string | null) => LEVELS.find((l) => l.id === id)?.label ?? id ?? "—";

type View = "home" | "users" | "account" | "interface";

export const DOCK_PINNED_KEY = "next.dockPinned";
export const DOCK_PINNED_EVENT = "next:dock-pinned";

export default function SettingsPage() {
  const { session, role } = useAuth();
  console.log("my role →", role);
  const isBoss = role === "boss";
  const isManager = role === "consultancy_manager" || role === "sales_manager";
  const canManage = isBoss || isManager;

  const allowedLevels = isBoss
    ? LEVELS.map((l) => l.id)
    : role === "consultancy_manager"
    ? ["consultant"]
    : role === "sales_manager"
    ? ["sales"]
    : [];

  const [view, setView] = useState<View>("home");
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
    return (
      <div className="st">
        <header className="st-bar">
          <h1 className="st-title">Settings</h1>
          <p className="st-sub">Manage your workspace</p>
        </header>
        <div className="set-cards">
          {canManage && (
            <button className="set-card" onClick={() => setView("users")}>
              <span className="set-card-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
                  <circle cx="17.5" cy="9" r="2.4" /><path d="M16 14.2a4.8 4.8 0 0 1 4.5 4.8" />
                </svg>
              </span>
              <span className="set-card-title">Users</span>
              <span className="set-card-sub">{isBoss ? "Everyone in the company" : "Your department"}</span>
            </button>
          )}
<button className="set-card" onClick={() => setView("interface")}>
            <span className="set-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2.5" />
                <path d="M8 4v16" />
              </svg>
            </span>
            <span className="set-card-title">Interface</span>
            <span className="set-card-sub">Toolbar & layout</span>
          </button>

          <button className="set-card" onClick={() => setView("account")}>
            <span className="set-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
              </svg>
            </span>
            <span className="set-card-title">Your account</span>
            <span className="set-card-sub">Password & details</span>
          </button>
        </div>
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