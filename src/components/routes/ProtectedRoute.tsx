import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../api/AuthProvider";

export default function ProtectedRoute() {
  const { session, loading } = useAuth();

  // While we check for an existing session, render nothing (avoids a flash)
  if (loading) return null;

  // Not logged in -> send to login
  if (!session) return <Navigate to="/login" replace />;

  // Logged in -> render the nested route
  return <Outlet />;
}