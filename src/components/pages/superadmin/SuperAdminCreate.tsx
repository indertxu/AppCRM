import { useState } from "react";
import { createTenant } from "../../api/superadminApi";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export default function SuperAdminCreate({ onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [maxUsers, setMaxUsers] = useState(5);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!name.trim()) { setErr("Give the company a name."); return; }
    setBusy(true); setErr("");
    const r = await createTenant(name.trim(), maxUsers);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    onCreated();
  };

  return (
    <div className="sa-backdrop" onMouseDown={onClose}>
      <div className="sa-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sa-modal-head">
          <div>
            <span className="sa-badge">Superadmin</span>
            <h2 className="sa-modal-title">New company</h2>
          </div>
          <button className="sa-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="sa-field">
          <label>Company name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Consulting" autoFocus />
        </div>

        <div className="sa-field">
          <label>User limit</label>
          <div className="sa-stepper">
            <button onClick={() => setMaxUsers((n) => Math.max(1, n - 1))}>−</button>
            <span><b>{maxUsers}</b><i>users</i></span>
            <button onClick={() => setMaxUsers((n) => n + 1)}>+</button>
          </div>
        </div>

        {err && <p className="sa-error">{err}</p>}

        <div className="sa-modal-actions">
          <button className="sa-cancel" onClick={onClose}>Cancel</button>
          <button className="sa-confirm" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create company"}
          </button>
        </div>
        <p className="sa-hint">You'll add users from the company's page once it's created.</p>
      </div>
    </div>
  );
}