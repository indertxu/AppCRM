import { useState, useRef, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth, type Role } from "../api/AuthProvider";

interface DockItem {
  label: string;
  path: string;
  icon: ReactNode;
  roles?: Role[]; // if set, only these roles see it
}

const homeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
  </svg>
);
const calendarIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4.5" width="18" height="16" rx="3" />
    <path d="M3 9h18" />
    <path d="M8 2.5v4M16 2.5v4" />
    <rect x="6.5" y="12" width="3.2" height="3.2" rx="0.8" fill="currentColor" stroke="none" />
  </svg>
);
const clientsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
    <circle cx="17.5" cy="9" r="2.4" />
    <path d="M16 14.2a4.8 4.8 0 0 1 4.5 4.8" />
  </svg>
);
const managementIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="8" height="7" rx="1.6" />
    <rect x="13" y="3" width="8" height="4.5" rx="1.6" />
    <rect x="13" y="10.5" width="8" height="10.5" rx="1.6" />
    <rect x="3" y="13" width="8" height="8" rx="1.6" />
  </svg>
);
const companiesIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="3" width="10" height="18" rx="1.5" />
    <path d="M14 8h6v13H4" />
    <path d="M7.5 7h3M7.5 11h3M7.5 15h3M17 12h0M17 16h0" />
  </svg>
);
const contactsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <circle cx="12" cy="10" r="2.6" />
    <path d="M8 17a4 4 0 0 1 8 0" />
    <path d="M4 7h2M4 12h1.5M4 17h2" />
  </svg>
);
const salesIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18" />
    <path d="M7 14l3-3 3 2 5-6" />
    <circle cx="7" cy="14" r="1" fill="currentColor" stroke="none" />
    <circle cx="18" cy="7" r="1" fill="currentColor" stroke="none" />
  </svg>
);
const settingsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const items: DockItem[] = [
  { label: "Home", path: "/home", icon: homeIcon },
  { label: "Calendar", path: "/calendar", icon: calendarIcon },
 { label: "Clients", path: "/clients", icon: clientsIcon, roles: ["boss"] },
  { label: "Companies", path: "/companies", icon: companiesIcon, roles: ["boss"] },
  { label: "Contacts", path: "/contacts", icon: contactsIcon, roles: ["boss"] },
  { label: "Sales", path: "/sales", icon: salesIcon, roles: ["boss"] },
{ label: "Management", path: "/management", icon: managementIcon, roles: ["boss", "consultancy_manager", "sales_manager", "customer_success", "it_manager", "marketing_manager", "hr_manager"] },
  { label: "Settings", path: "/settings", icon: settingsIcon },
];

export default function Dock() {
  const [open, setOpen] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { role } = useAuth();

  const visible = items.filter((it) => !it.roles || (role !== null && it.roles.includes(role)));

  const show = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setOpen(true);
  };
  const hide = () => {
    hideTimer.current = window.setTimeout(() => setOpen(false), 220);
  };

  return (
    <>
      <div className="dock-trigger" onMouseEnter={show} onMouseLeave={hide} />
      <div className={`dock ${open ? "dock-open" : ""}`} onMouseEnter={show} onMouseLeave={hide}>
        <div className="dock-bar">
          {visible.map((it) => (
            <button
              key={it.path}
              className={`dock-app ${it.path === "/settings" ? "dock-app-settings" : ""} ${location.pathname === it.path ? "dock-app-active" : ""}`}
    onClick={() => navigate(it.path)}
            >
              <span className="dock-icon">{it.icon}</span>
              <span className="dock-label">{it.label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}