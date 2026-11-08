/* =====================================================================
   BASE APP — the simple tier, for companies on the Base plan
   (tenants.plan = 'base'). Same sign-in, same database as Enterprise.
   Loaded on its own (lazy) by src/components/routes/AppRoutes.tsx, so it
   never loads Enterprise code or styles, and Enterprise never loads this.

   Everything under src/base/ belongs to the Base app and is edited by the
   Base chat only. Shared kernel it may import (read-only, owned by the
   Enterprise chat): src/components/api/{supabase,authContext,AuthProvider},
   src/components/login/LoginPage, src/components/framework/PageCube.
   Read src/base/TIERS.md first, and log every change there.
   ===================================================================== */
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import AppLayout from "./framework/AppLayout";
import { PageRoute, usePageAccess } from "./framework/pageAccess";
import HomePage from "./pages/homepage/HomePage";
import { TicketsPage } from "./pages/homepage/shared/HomeTodo";
import CalendarPage from "./pages/calendar/CalendarPage";
import OrbitPage from "./pages/orbit/OrbitPage";
import SettingsPage from "./pages/settings/SettingsPage";
import SalesPage from "./pages/sales/sales/SalesPage";
import BillingPage from "./pages/billing/BillingPage";
import GrowthPage from "./pages/growth/GrowthPage";

/**
 * Links to /contacts, /companies, /clients (and the old /people) land on Orbit:
 * the view follows the link, the search (?new=1…) and the state (open this contact…) go along.
 */
function ToOrbit({ view }: { view?: "contacts" | "companies" | "clients" }) {
  const { search, state } = useLocation();
  const q = new URLSearchParams(search);
  if (view) q.set("view", view);
  const s = q.toString();
  return <Navigate to={`/orbit${s ? `?${s}` : ""}`} state={state} replace />;
}

/** Old links (/tickets?ticket=…) open the Tasks page. */
function ToTasks() {
  const { search } = useLocation();
  const q = new URLSearchParams(search); q.delete("kind");
  const s = q.toString();
  return <Navigate to={`/tasks${s ? `?${s}` : ""}`} replace />;
}

export default function BaseApp() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        {/* Home and Settings are always open; everything else follows Page access. */}
        <Route path="/home" element={<HomePage />} />
        {/* Tasks (Base has no ticketing): the task desk; /tickets is an old link to it */}
        <Route element={<PageRoute page="tickets" />}><Route path="/tasks" element={<TicketsPage />} /></Route>
        <Route path="/tickets" element={<ToTasks />} />
        <Route element={<PageRoute page="calendar" />}><Route path="/calendar" element={<CalendarPage />} /></Route>
        <Route element={<PageRoute page="contacts" />}><Route path="/orbit" element={<OrbitPage />} /></Route>
        {/* Deals: pipelines and deals (a deal opens inside it: /sales?tracking=…) */}
        <Route element={<PageRoute page="sales" />}><Route path="/sales" element={<SalesPage />} /></Route>
        {/* Billing: invoices, work to bill, time per person (Management's people) */}
        <Route element={<PageRoute page="management" />}><Route path="/billing" element={<BillingPage />} /></Route>
        {/* Growth: Marketing + Customer health on one page (open with either page access); old links land on their section */}
        <Route path="/growth" element={<GrowthRoute />} />
        <Route path="/marketing" element={<Navigate to="/growth" replace />} />
        <Route path="/success" element={<Navigate to="/growth?s=customers" replace />} />
        <Route path="/health" element={<Navigate to="/growth?s=customers" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/contacts" element={<ToOrbit view="contacts" />} />
        <Route path="/companies" element={<ToOrbit view="companies" />} />
        <Route path="/people" element={<ToOrbit />} />
        <Route path="/clients" element={<ToOrbit view="clients" />} />
      </Route>
      {/* pages only the Enterprise app has (Projects, Management, Reports…) → Home */}
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  );
}

/** Growth opens for anyone with Marketing or Customer health access. */
function GrowthRoute() {
  const { ready, canSee } = usePageAccess();
  if (!ready) return null;
  if (!canSee("marketing") && !canSee("success")) return <Navigate to="/home" replace />;
  return <GrowthPage />;
}
