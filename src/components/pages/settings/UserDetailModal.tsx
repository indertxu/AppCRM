import { useEffect, useState } from "react";
import DatePicker from "../../framework/DatePicker";
import { LEVELS, TITLES } from "./NewUserModal";
import { initials, type UserRow } from "./UsersView";

interface Props {
  user: UserRow;
  canEditRole: boolean;
  allowedLevels: string[];
  onSave: (id: string, fields: Partial<UserRow>) => Promise<string | null>;
  onReset: (id: string, password: string) => Promise<string | null>;
  onClose: () => void;
}

export default function UserDetailModal({ user, canEditRole, allowedLevels, onSave, onReset, onClose }: Props) {
  const [first, setFirst] = useState(user.first_name ?? "");
  const [last, setLast] = useState(user.last_name ?? "");
  const [phone, setPhone] = useState(user.phone ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [wage, setWage] = useState(user.yearly_wage ?? 0);
  const [startDate, setStartDate] = useState(user.start_date ?? "");
  const [birthday, setBirthday] = useState(user.birthday ?? "");
  const [role, setRole] = useState(user.role ?? "consultant");
  const [title, setTitle] = useState(user.job_title ?? "consultant");

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const levels = LEVELS.filter((l) => allowedLevels.includes(l.id));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const err = await onSave(user.id, {
      first_name: first, last_name: last, phone, email,
      yearly_wage: wage, start_date: startDate, birthday,
      role, job_title: title,
    });
    setBusy(false);
    setMsg(err ? { ok: false, text: err } : { ok: true, text: "Saved." });
  };

  const reset = async () => {
    setPwMsg(null);
    if (newPw.length < 6) return setPwMsg({ ok: false, text: "At least 6 characters." });
    setPwBusy(true);
    const err = await onReset(user.id, newPw);
    setPwBusy(false);
    if (err) return setPwMsg({ ok: false, text: err });
    setNewPw("");
    setPwMsg({ ok: true, text: "Password reset." });
  };

  return (
    <div className="su-backdrop" onMouseDown={onClose}>
      <div className="su-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="su-head">
          <div className="ud-head-id">
            <span className="uv-avatar ud-avatar">{initials(user)}</span>
            <div>
              <span className="su-eyebrow">Edit user</span>
              <h2 className="su-title">{[first, last].filter(Boolean).join(" ") || "User"}</h2>
            </div>
          </div>
          <button className="su-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="su-body">
          <div className="su-grid">
            <div className="cl-field"><label>First name</label><input className="cl-input" value={first} onChange={(e) => setFirst(e.target.value)} /></div>
            <div className="cl-field"><label>Surname</label><input className="cl-input" value={last} onChange={(e) => setLast(e.target.value)} /></div>
            <div className="cl-field"><label>Phone</label><input className="cl-input" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
            <div className="cl-field"><label>Email</label><input type="email" className="cl-input" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="cl-field"><label>Yearly wage</label><input type="number" min="0" className="cl-input" value={wage} onChange={(e) => setWage(Number(e.target.value) || 0)} /></div>
            <div className="cl-field"><label>Start date</label><DatePicker value={startDate} onChange={setStartDate} /></div>
            <div className="cl-field"><label>Birthday</label><DatePicker value={birthday} onChange={setBirthday} /></div>
            <div className="cl-field"><label>Role</label>
              <select className="cl-input" value={title} onChange={(e) => setTitle(e.target.value)}>
                {TITLES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div className="cl-field"><label>Security level</label>
              <select className="cl-input" value={role} disabled={!canEditRole} onChange={(e) => setRole(e.target.value)}>
                {(canEditRole ? levels : LEVELS).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
          </div>

          {msg && <p className={msg.ok ? "st-ok" : "su-error"}>{msg.text}</p>}

          <div className="ud-reset">
            <span className="ud-reset-label">Reset password</span>
            <div className="ud-reset-row">
              <input type="text" className="cl-input" placeholder="New password (min 6)" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
              <button className="cl-cancel" onClick={reset} disabled={pwBusy}>{pwBusy ? "…" : "Reset"}</button>
            </div>
            {pwMsg && <p className={pwMsg.ok ? "st-ok" : "su-error"}>{pwMsg.text}</p>}
          </div>
        </div>

        <div className="su-foot">
          <button className="cl-cancel" onClick={onClose}>Close</button>
          <button className="cl-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </div>
    </div>
  );
}