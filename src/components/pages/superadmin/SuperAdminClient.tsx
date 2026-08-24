import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../api/supabase";
import {
  listTenants, listUsers, createUser, deleteUser, toggleTenant, updateTenant,
  type Tenant, type TenantUser,
} from "../../api/superadminApi";
import "./SuperAdmin.css";

const ROLES = [
  { value: "boss", label: "Boss / Owner" },
  { value: "consultancy_manager", label: "Consultancy manager" },
  { value: "customer_success", label: "Customer success" },
  { value: "customer_success_manager", label: "Customer Success Manager" },
  { value: "sales_manager", label: "Sales manager" },
  { value: "consultant", label: "Consultant" },
];

export default function SuperAdminClient() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(true);

  // new-user form
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // password reset
  const [pwFor, setPwFor] = useState<TenantUser | null>(null);
  const [pw, setPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState("");
  const [pwDone, setPwDone] = useState(false);

  /**
   * Passwords live in auth.users, which only the service role can write, so
   * this goes through the edge function rather than the browser client.
   */
  const savePassword = async () => {
    if (!pwFor) return;
    if (pw.trim().length < 6) { setPwErr("Password must be at least 6 characters."); return; }
    setPwBusy(true); setPwErr("");
    const { data, error } = await supabase.functions.invoke("manage-tenants", {
      body: { action: "set_password", userId: pwFor.id, password: pw.trim() },
    });
    setPwBusy(false);
    if (error || (data && data.error)) { setPwErr(error?.message ?? data.error); return; }
    setPwDone(true);
  };

  const openPw = (u: TenantUser) => { setPwFor(u); setPw(""); setPwErr(""); setPwDone(false); };
  const randomPw = () => {
    // Readable but not guessable: no lookalike characters.
    const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    setPw(Array.from({ length: 12 }, () => abc[Math.floor(Math.random() * abc.length)]).join(""));
  };

  const load = async () => {
    setLoading(true);
    // Fetch tenants and users in parallel instead of one after the other.
    const [all, us] = await Promise.all([
      listTenants().catch(() => []),
      id ? listUsers(id).catch(() => []) : Promise.resolve([]),
    ]);
    setTenant(all.find((t) => t.id === id) ?? null);
    setUsers(us);
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const atLimit = tenant ? users.length >= tenant.max_users : false;

  const addUser = async () => {
    if (!id) return;
    if (!email.trim() || !password.trim()) { setErr("Email and password are required."); return; }
    if (password.length < 6) { setErr("Password must be at least 6 characters."); return; }
    setBusy(true); setErr("");
    // Superadmin only creates the login. Role and job title are left empty for the
    // company to set from inside their own app.
    const r = await createUser(id, email.trim(), password, "", "");
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setEmail(""); setPassword("");
    load();
  };

  const removeUser = async (userId: string) => {
    if (!confirm("Delete this user? This cannot be undone.")) return;
    await deleteUser(userId);
    load();
  };

  const changeLimit = async (delta: number) => {
    if (!tenant) return;
    const next = Math.max(users.length, tenant.max_users + delta); // never below current users
    if (next === tenant.max_users) return;
    setTenant({ ...tenant, max_users: next }); // optimistic
    const r = await updateTenant(tenant.id, { maxUsers: next });
    if (r?.error) { setErr(r.error); load(); }
  };

  if (loading) return <div className="sa"><p className="sa-empty">Loading…</p></div>;
  if (!tenant) return <div className="sa"><p className="sa-empty">Company not found.</p></div>;

  return (
    <div className="sa sa-page">
      <header className="sa-top">
        <div className="sa-top-left">
          <button className="sa-back" onClick={() => navigate("/superadmin")}>‹</button>
          <div>
            <span className="sa-badge">Company</span>
            <h1 className="sa-title">{tenant.name}</h1>
          </div>
        </div>
        <div className="sa-top-right">
          <button
            className={`sa-toggle ${tenant.active ? "is-on" : ""}`}
            onClick={async () => { await toggleTenant(tenant.id, !tenant.active); load(); }}
          >
            {tenant.active ? "Active" : "Disabled"}
          </button>
        </div>
      </header>

      <div className="sa-stats">
        <div className="sa-stat"><span className="sa-stat-k">Users</span><b className="sa-stat-v">{users.length}</b></div>
        <div className="sa-stat">
          <span className="sa-stat-k">User limit</span>
          <div className="sa-seat-edit">
            <button onClick={() => changeLimit(-1)} disabled={tenant.max_users <= users.length} aria-label="Decrease limit">−</button>
            <b className="sa-stat-v">{tenant.max_users}</b>
            <button onClick={() => changeLimit(1)} aria-label="Increase limit">+</button>
          </div>
        </div>
        <div className="sa-stat"><span className="sa-stat-k">Seats left</span><b className="sa-stat-v">{Math.max(0, tenant.max_users - users.length)}</b></div>
      </div>

      <div className="sa-panel">
        <h2 className="sa-panel-title">Add a user</h2>
        {atLimit ? (
          <p className="sa-hint">User limit reached. Increase the limit to add more.</p>
        ) : (
          <div className="sa-userform">
            <div className="sa-field"><label>Email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></div>
            <div className="sa-field"><label>Password</label>
              <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 6 characters" type="text" /></div>
            <button className="sa-confirm sa-adduser" onClick={addUser} disabled={busy}>
              {busy ? "Adding…" : "Add user"}
            </button>
          </div>
        )}
        {err && <p className="sa-error">{err}</p>}
      </div>

      <div className="sa-panel sa-panel-grow">
        <h2 className="sa-panel-title">Users</h2>
        {users.length === 0 ? (
          <p className="sa-hint">No users yet.</p>
        ) : (
          <div className="sa-userlist">
            {users.map((u) => (
              <div className="sa-userrow" key={u.id}>
                <span className="sa-user-av">{(u.email || "?").slice(0, 2).toUpperCase()}</span>
                <span className="sa-user-main">
                  <span className="sa-user-email">{u.email}</span>
                  <span className="sa-user-role">{u.role ? (ROLES.find((r) => r.value === u.role)?.label ?? u.role) : "Role not set"}{u.job_title ? ` · ${u.job_title}` : ""}</span>
                </span>
                <button className="sa-user-key" onClick={() => openPw(u)} aria-label="Change password" title="Change password">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2M15.5 8.5a4.5 4.5 0 1 1-6.4 6.3 4.5 4.5 0 0 1 6.4-6.3zM19 4l-6.5 6.5M17 6l2 2"/></svg>
                </button>
                <button className="sa-user-del" onClick={() => removeUser(u.id)} aria-label="Delete user">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {pwFor && (
        <div className="sa-backdrop" onMouseDown={() => setPwFor(null)}>
          <div className="sa-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="sa-modal-head">
              <div>
                <span className="sa-badge">Reset password</span>
                <h2 className="sa-modal-title">{pwFor.email}</h2>
              </div>
              <button className="sa-x" onClick={() => setPwFor(null)} aria-label="Close">×</button>
            </div>

            {pwDone ? (
              <>
                <p className="sa-hint">
                  Password changed. Give it to the user through a channel you trust - it cannot be read back later.
                </p>
                <div className="sa-pw-done">{pw}</div>
                <div className="sa-modal-actions">
                  <button className="sa-confirm" onClick={() => setPwFor(null)}>Done</button>
                </div>
              </>
            ) : (
              <>
                <div className="sa-field">
                  <label>New password</label>
                  <div className="sa-pw-row">
                    <input value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Min 6 characters" autoFocus />
                    <button className="sa-pw-gen" onClick={randomPw} type="button">Generate</button>
                  </div>
                </div>
                {pwErr && <p className="sa-error">{pwErr}</p>}
                <div className="sa-modal-actions">
                  <button className="sa-cancel" onClick={() => setPwFor(null)}>Cancel</button>
                  <button className="sa-confirm" onClick={savePassword} disabled={pwBusy || pw.trim().length < 6}>
                    {pwBusy ? "Saving…" : "Set password"}
                  </button>
                </div>
                <p className="sa-hint">
                  The user is not signed out, and no email is sent. Their existing sessions stay valid until they expire.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}