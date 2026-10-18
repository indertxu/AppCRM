import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../api/authContext";
import ProtectedRoute from "./ProtectedRoute";
import LoginPage from "../login/LoginPage";
import AppLayout from "../framework/AppLayout";
import { PageRoute } from "../framework/pageAccess";
import ManagementPage from "../pages/management/ManagementPage";
import HomePage from "../pages/homepage/HomePage";
import CalendarPage from "../pages/calendar/CalendarPage";
import SalesCalendar from "../pages/calendar/SalesCalendar";
import ClientsPage from "../pages/clients/ClientsPage";
import ProjectsPage from "../pages/projects/ProjectsPage";
import CompaniesPage from "../pages/companies/CompaniesPage";
import ContactsPage from "../pages/contacts/ContactsPage";
import SalesPage from "../pages/sales/sales/SalesPage";
import SettingsPage from "../pages/settings/SettingsPage";
import LinkedInCapturePage from "../pages/contacts/LinkedInCapture";
import SuperAdminHome from "../pages/superadmin/SuperAdminHome";
import SuperAdminClient from "../pages/superadmin/SuperAdminClient";

// If already logged in, /login redirects to the right landing page.
function LoginRoute() {
  const { session, loading, isSuperadmin, roleLoading } = useAuth();
  if (loading || (session && roleLoading)) return null;
  if (session) return <Navigate to={isSuperadmin ? "/superadmin" : "/home"} replace />;
  return <LoginPage />;
}

// Which pages each security level may open is configured in
// Settings → Organization → Page access (table page_access). The built-in
// defaults (what used to be hard-coded here) live in framework/pageAccess.tsx.

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
      {/* the window the LinkedIn extension opens (signs in by itself) */}
      <Route path="/linkedin" element={<LinkedInCapturePage />} />

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
            {/* Home and Settings are always open; everything else follows Page access. */}
            <Route path="/home" element={<HomePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route element={<PageRoute page="calendar" />}><Route path="/calendar" element={<CalendarRoute />} /></Route>
            <Route element={<PageRoute page="management" />}><Route path="/management" element={<ManagementPage />} /></Route>
            <Route element={<PageRoute page="clients" />}><Route path="/clients" element={<ClientsPage />} /></Route>
            <Route element={<PageRoute page="projects" />}><Route path="/projects" element={<ProjectsPage />} /></Route>
            <Route element={<PageRoute page="companies" />}><Route path="/companies" element={<CompaniesPage />} /></Route>
            <Route element={<PageRoute page="contacts" />}><Route path="/contacts" element={<ContactsPage />} /></Route>
            <Route element={<PageRoute page="sales" />}><Route path="/sales" element={<SalesPage />} /></Route>
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