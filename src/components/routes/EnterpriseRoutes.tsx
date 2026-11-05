/* =====================================================================
   ENTERPRISE APP — every page of the full app, for companies on the
   Enterprise plan (tenants.plan = 'enterprise'). Loaded on its own (lazy) by
   AppRoutes, so a Base company never loads any of this code or its styles.
   The Base app's routes are in src/base/BaseApp.tsx. See src/base/TIERS.md.
   ===================================================================== */
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "../api/authContext";
import AppLayout from "../framework/AppLayout";
import { PageRoute } from "../framework/pageAccess";
import ManagementPage from "../pages/management/ManagementPage";
import HomePage from "../pages/homepage/HomePage";
import { TicketsPage } from "../pages/homepage/shared/HomeTodo";
import CalendarPage from "../pages/calendar/CalendarPage";
import SalesCalendar from "../pages/calendar/SalesCalendar";
import ClientsPage from "../pages/clients/ClientsPage";
import ProjectsPage from "../pages/projects/ProjectsPage";
import CompaniesPage from "../pages/companies/CompaniesPage";
import ContactsPage from "../pages/contacts/ContactsPage";
import { MarketingPage } from "../pages/contacts/ContactExport";
import { CustomerSuccessPage } from "../pages/clients/ClientsPage";
import SalesPage from "../pages/sales/sales/SalesPage";
import ReportsPage from "../pages/sales/extras/SalesReport";
import SettingsPage from "../pages/settings/SettingsPage";

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

export default function EnterpriseRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        {/* Home and Settings are always open; everything else follows Page access. */}
        <Route path="/home" element={<HomePage />} />
        {/* everyone has a ticket desk, like Home */}
        <Route element={<PageRoute page="tickets" />}><Route path="/tickets" element={<TicketsPage />} /></Route>
        <Route path="/settings" element={<SettingsPage />} />
        <Route element={<PageRoute page="calendar" />}><Route path="/calendar" element={<CalendarRoute />} /></Route>
        <Route element={<PageRoute page="management" />}><Route path="/management" element={<ManagementPage />} /></Route>
        <Route element={<PageRoute page="clients" />}><Route path="/clients" element={<ClientsPage />} /></Route>
        <Route element={<PageRoute page="projects" />}><Route path="/projects" element={<ProjectsPage />} /></Route>
        <Route element={<PageRoute page="companies" />}><Route path="/companies" element={<CompaniesPage />} /></Route>
        <Route element={<PageRoute page="contacts" />}><Route path="/contacts" element={<ContactsPage />} /></Route>
        <Route element={<PageRoute page="sales" />}><Route path="/sales" element={<SalesPage />} /></Route>
        <Route element={<PageRoute page="reports" />}><Route path="/reports" element={<ReportsPage />} /></Route>
        <Route element={<PageRoute page="marketing" />}><Route path="/marketing" element={<MarketingPage />} /></Route>
        <Route element={<PageRoute page="success" />}><Route path="/success" element={<CustomerSuccessPage />} /></Route>
      </Route>
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  );
}
