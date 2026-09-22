import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../api/authContext";
import ProtectedRoute from "./ProtectedRoute";
import LoginPage from "../login/LoginPage";
import AppLayout from "../framework/AppLayout";
import ManagementPage from "../pages/management/ManagementPage";
import HomePage from "../pages/homepage/HomePage";
import CalendarPage from "../pages/calendar/CalendarPage";
import SalesCalendar from "../pages/calendar/SalesCalendar";
import ClientsPage from "../pages/clients/ClientsPage";
import ProjectsPage from "../pages/projects/ProjectsPage";
import CompaniesPage from "../pages/companies/CompaniesPage";
import ContactsPage from "../pages/contacts/ContactsPage";
import SalesPage from "../pages/sales/SalesPage";
import SettingsPage from "../pages/settings/SettingsPage";
import SuperAdminHome from "../pages/superadmin/SuperAdminHome";
import SuperAdminClient from "../pages/superadmin/SuperAdminClient";

// If already logged in, /login redirects to the right landing page.
function LoginRoute() {
  const { session, loading, isSuperadmin, roleLoading } = useAuth();
  if (loading || (session && roleLoading)) return null;
  if (session) return <Navigate to={isSuperadmin ? "/superadmin" : "/home"} replace />;
  return <LoginPage />;
}

// Only admin/boss may pass; consultants get sent home
function AdminRoute() {
  const { role, roleLoading } = useAuth();
  if (roleLoading) return null;
if (role !== "boss") return <Navigate to="/home" replace />;
  return <Outlet />;
}

/**
 * Sales, companies and contacts belong to the sales team, not just the boss.
 * Reps only see the records they are assigned to, which the pages handle
 * themselves.
 */
const SALES_TEAM = ["boss", "sales", "sales_manager"];
function SalesRoute() {
  const { role, roleLoading } = useAuth();
  if (roleLoading) return null;
  if (!role || !SALES_TEAM.includes(role)) return <Navigate to="/home" replace />;
  return <Outlet />;
}

// Managers of any department (and the boss) may see Management.
const MANAGER_ROLES = [
  "boss", "consultancy_manager", "sales_manager", "customer_success",
  "it_manager", "marketing_manager", "hr_manager",
];
function ManagerRoute() {
  const { role, roleLoading } = useAuth();
  if (roleLoading) return null;
  if (!role || !MANAGER_ROLES.includes(role)) return <Navigate to="/home" replace />;
  return <Outlet />;
}

/**
 * One "Calendar" entry, two calendars behind it.
 *
 * A rep does not log billable work against projects, so they get the meetings
 * booked on their deals instead. Bosses keep the consultancy one, which is the
 * one they were already using.
 */
const SALES_ROLES = ["sales", "sales_manager"];
function CalendarRoute() {
  const { role, roleLoading } = useAuth();
  if (roleLoading) return null;
  return role && SALES_ROLES.includes(role) ? <SalesCalendar /> : <CalendarPage />;
}

// Superadmin-only. Uses the flag already loaded by AuthProvider (no flash).
function SuperAdminRoute() {
  const { isSuperadmin, roleLoading } = useAuth();
  if (roleLoading) return null;
  if (!isSuperadmin) return <Navigate to="/home" replace />;
  return <Outlet />;
}

// The normal app: a superadmin has no company, so bounce them to their panel
// before any app page paints (prevents the home flash).
function AppGate() {
  const { isSuperadmin, roleLoading } = useAuth();
  if (roleLoading) return null;
  if (isSuperadmin) return <Navigate to="/superadmin" replace />;
  return <Outlet />;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />

      {/* Superadmin platform panel — protected by login, but outside the app layout */}
      <Route element={<ProtectedRoute />}>
        <Route element={<SuperAdminRoute />}>
          <Route path="/superadmin" element={<SuperAdminHome />} />
          <Route path="/superadmin/company/:id" element={<SuperAdminClient />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route element={<AppGate />}>
          <Route element={<AppLayout />}>
            <Route path="/home" element={<HomePage />} />
            <Route path="/calendar" element={<CalendarRoute />} />
            <Route element={<ManagerRoute />}>
              <Route path="/management" element={<ManagementPage />} />
            </Route>
            <Route path="/settings" element={<SettingsPage />} />

            {/* Delivery side: clients are boss only; projects are open to everyone. */}
            <Route element={<AdminRoute />}>
              <Route path="/clients" element={<ClientsPage />} />
            </Route>
            <Route path="/projects" element={<ProjectsPage />} />

            {/* Sales side: the sales team and the boss */}
            <Route element={<SalesRoute />}>
              <Route path="/companies" element={<CompaniesPage />} />
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/sales" element={<SalesPage />} />
            </Route>
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<CatchAll />} />
    </Routes>
  );
}

function CatchAll() {
  const { isSuperadmin, roleLoading } = useAuth();
  if (roleLoading) return null;
  return <Navigate to={isSuperadmin ? "/superadmin" : "/home"} replace />;
}