import { LEVELS, TITLES } from "./NewUserModal";

export interface UserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  job_title: string | null;
  department: string | null;
  username: string | null;
  start_date?: string | null;
  birthday?: string | null;
  yearly_wage?: number | null;
}

const levelLabel = (id: string | null) => LEVELS.find((l) => l.id === id)?.label ?? id ?? "—";
const titleLabel = (id: string | null) => TITLES.find((t) => t.id === id)?.label ?? id ?? "—";

export function initials(u: UserRow): string {
  const a = u.first_name?.[0] ?? u.email?.[0] ?? "?";
  const b = u.last_name?.[0] ?? "";
  return (a + b).toUpperCase();
}

interface Props {
  users: UserRow[];
  loading: boolean;
  scope: string;
  onBack: () => void;
  onNew: () => void;
  onOpen: (u: UserRow) => void;
}

export default function UsersView({ users, loading, scope, onBack, onNew, onOpen }: Props) {
  return (
    <>
      <header className="uv-head">
        <div>
          <button className="uv-back" onClick={onBack}>‹ Settings</button>
          <h1 className="st-title">Users</h1>
          <p className="st-sub">{scope}</p>
        </div>
        <button className="cl-primary" onClick={onNew}>+ New user</button>
      </header>

      {loading ? (
        <p className="st-note">Loading…</p>
      ) : users.length === 0 ? (
        <p className="st-note">No users yet.</p>
      ) : (
        <div className="uv-grid">
          {users.map((u) => (
            <button className="uv-card" key={u.id} onClick={() => onOpen(u)}>
              <span className="uv-avatar">{initials(u)}</span>
              <span className="uv-name">
                {[u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "—"}
              </span>
              <span className="uv-role">{titleLabel(u.job_title)}</span>
              <span className="uv-badge">{levelLabel(u.role)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}