import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../api/AuthProvider";
import { rememberReturnTo } from "../api/supabase";

export default function ProtectedRoute() {
  const { session, loading } = useAuth();
  const loc = useLocation();

  // While we check for an existing session, render nothing (avoids a flash)
  if (loading) return null;

  // Not logged in -> send to login, and come back to this page once signed in
  if (!session) {
    rememberReturnTo(`${loc.pathname}${loc.search}`);
    return <Navigate to="/login" replace />;
  }

  // Logged in -> render the nested route
  return <Outlet />;
}
