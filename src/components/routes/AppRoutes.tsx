import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../api/AuthProvider";
import ProtectedRoute from "./ProtectedRoute";
import LoginPage from "../login/LoginPage";
import AppLayout from "../framework/AppLayout";
import ManagementPage from "../pages/management/ManagementPage";
import HomePage from "../pages/homepage/HomePage";
import CalendarPage from "../pages/calendar/CalendarPage";
import ClientsPage from "../pages/clients/ClientsPage";
import SettingsPage from "../pages/settings/SettingsPage";

// If already logged in, /login redirects straight to /home
function LoginRoute() {
  const { session, loading } = useAuth();
  if (loading) return null;
  if (session) return <Navigate to="/home" replace />;
  return <LoginPage />;
}

// Only admin/boss may pass; consultants get sent home
function AdminRoute() {
  const { role, roleLoading } = useAuth();
  console.log("AdminRoute → role:", role, "roleLoading:", roleLoading);
  if (roleLoading) return null;
if (role !== "boss") return <Navigate to="/home" replace />;
  return <Outlet />;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/home" element={<HomePage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/management" element={<ManagementPage />} />
         <Route path="/settings" element={<SettingsPage />} />

          {/* Admin / boss only */}
          <Route element={<AdminRoute />}>
            <Route path="/clients" element={<ClientsPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  );
}