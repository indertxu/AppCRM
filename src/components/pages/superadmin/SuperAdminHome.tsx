import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { listTenants, type Tenant } from "../../api/superadminApi";
import SuperAdminCreate from "./SuperAdminCreate";
import "./SuperAdmin.css";

export default function SuperAdminHome() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setTenants(await listTenants()); } catch { /* ignore */ }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const totalUsers = tenants.reduce((s, t) => s + t.user_count, 0);
  const activeCount = tenants.filter((t) => t.active).length;

  return (
    <div className="sa">
      <header className="sa-top">
        <div className="sa-top-left">
          <span className="sa-badge">Platform control</span>
          <h1 className="sa-title">Companies</h1>
        </div>
        <div className="sa-top-right">
          <button className="sa-signout" onClick={() => supabase.auth.signOut()}>Sign out</button>
          <button className="sa-new" onClick={() => setShowCreate(true)}>+ New company</button>
        </div>
      </header>

      <div className="sa-stats">
        <div className="sa-stat"><span className="sa-stat-k">Companies</span><b className="sa-stat-v">{tenants.length}</b></div>
        <div className="sa-stat"><span className="sa-stat-k">Active</span><b className="sa-stat-v">{activeCount}</b></div>
        <div className="sa-stat"><span className="sa-stat-k">Total users</span><b className="sa-stat-v">{totalUsers}</b></div>
      </div>

      {loading ? (
        <p className="sa-empty">Loading…</p>
      ) : tenants.length === 0 ? (
        <p className="sa-empty">No companies yet. Create the first one.</p>
      ) : (
        <div className="sa-grid">
          {tenants.map((t) => (
            <button key={t.id} className={`sa-card ${t.active ? "" : "is-off"}`} onClick={() => navigate(`/superadmin/company/${t.id}`)}>
              <div className="sa-card-head">
                <span className="sa-card-avatar">{t.name.slice(0, 2).toUpperCase()}</span>
                <span className={`sa-card-status ${t.active ? "is-on" : ""}`}>{t.active ? "Active" : "Disabled"}</span>
              </div>
              <span className="sa-card-name">{t.name}</span>
              <span className="sa-card-meta">{t.user_count} / {t.max_users} users</span>
              <div className="sa-card-bar">
                <div className="sa-card-fill" style={{ width: `${Math.min(100, (t.user_count / Math.max(1, t.max_users)) * 100)}%` }} />
              </div>
            </button>
          ))}
        </div>
      )}

      {showCreate && (
        <SuperAdminCreate
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}