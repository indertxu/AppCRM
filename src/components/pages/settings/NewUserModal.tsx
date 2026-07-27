import { useEffect, useState } from "react";
import DatePicker from "../../framework/DatePicker";
import "./SettingsPage.css";
import Select from "../../framework/Select";
export const LEVELS = [
  { id: "consultant", label: "Consultant" },
  { id: "consultancy_manager", label: "Consultancy manager" },
  { id: "customer_success", label: "Customer success" },
  { id: "sales", label: "Sales" },
  { id: "sales_manager", label: "Sales manager" },
  { id: "boss", label: "Boss" },
] as const;

export const TITLES = [
  { id: "consultant", label: "Consultant" },
  { id: "sales", label: "Sales" },
  { id: "ceo", label: "CEO" },
  { id: "cfo", label: "CFO" },
  { id: "consultancy_director", label: "Consultancy director" },
] as const;

export interface NewUserPayload {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  username: string;
  password: string;
  yearly_wage: number;
  start_date: string;
  birthday: string;
role: string;
  job_title: string;
  social_security: string;
  bank_account: string;
}

interface Props {
  allowedLevels: string[];
  onCreate: (payload: NewUserPayload) => Promise<string | null>;
  onClose: () => void;
}

export default function NewUserModal({ allowedLevels, onCreate, onClose }: Props) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [wage, setWage] = useState(0);
  const [startDate, setStartDate] = useState("");
const [birthday, setBirthday] = useState("");
  const [ss, setSs] = useState("");
  const [bank, setBank] = useState("");
  const [role, setRole] = useState(allowedLevels[0] ?? "consultant");
  const [title, setTitle] = useState("consultant");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const levels = LEVELS.filter((l) => allowedLevels.includes(l.id));

  const canSave =
    first.trim() && email.trim() && username.trim() && password.length >= 6;

  const submit = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    const err = await onCreate({
      first_name: first.trim(),
      last_name: last.trim(),
      phone,
      email: email.trim(),
      username: username.trim(),
      password,
      yearly_wage: wage,
      start_date: startDate,
      birthday,
role,
      job_title: title,
      social_security: ss,
      bank_account: bank,
    });
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <div className="su-backdrop" onMouseDown={onClose}>
      <div className="su-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="su-head">
          <div>
            <span className="su-eyebrow">New user</span>
            <h2 className="su-title">Add a team member</h2>
          </div>
          <button className="su-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="su-body">
          <div className="su-grid">
            <div className="cl-field"><label>First name</label><input className="cl-input" value={first} onChange={(e) => setFirst(e.target.value)} /></div>
            <div className="cl-field"><label>Surname</label><input className="cl-input" value={last} onChange={(e) => setLast(e.target.value)} /></div>
            <div className="cl-field"><label>Phone</label><input className="cl-input" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
            <div className="cl-field"><label>Email</label><input type="email" className="cl-input" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="cl-field"><label>Username</label><input className="cl-input" value={username} onChange={(e) => setUsername(e.target.value)} /></div>
            <div className="cl-field"><label>Password (min 6)</label><input type="text" className="cl-input" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <div className="cl-field"><label>Yearly wage</label><input type="number" min="0" className="cl-input" value={wage} onChange={(e) => setWage(Number(e.target.value) || 0)} /></div>
            <div className="cl-field"><label>Start date</label><DatePicker value={startDate} onChange={setStartDate} /></div>
        <div className="cl-field"><label>Birthday</label><DatePicker value={birthday} onChange={setBirthday} /></div>
            <div className="cl-field"><label>Nº seguridad social</label><input className="cl-input" value={ss} onChange={(e) => setSs(e.target.value)} /></div>
            <div className="cl-field"><label>Nº cuenta bancaria</label><input className="cl-input" value={bank} onChange={(e) => setBank(e.target.value)} /></div>
            <div className="cl-field"><label>Security level</label>
              <select className="cl-input" value={role} onChange={(e) => setRole(e.target.value)}>
                {levels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
            <div className="cl-field"><label>Role</label>
<Select
                value={title}
                onChange={setTitle}
                options={TITLES.map((t) => ({ value: t.id, label: t.label }))}
              />
            </div>
          </div>

          {error && <p className="su-error">{error}</p>}
        </div>

        <div className="su-foot">
          <button className="cl-cancel" onClick={onClose}>Cancel</button>
          <button className="cl-primary" onClick={submit} disabled={!canSave || busy}>
            {busy ? "Creating…" : "Create user"}
          </button>
        </div>
      </div>
    </div>
  );
}