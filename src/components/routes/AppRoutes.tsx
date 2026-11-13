import { lazy, Suspense, useEffect, useRef } from "react";
import { Routes, Route, Navigate, Outlet, useNavigate, useLocation } from "react-router-dom";
import { supabase } from "../api/supabase";
import { useAuth } from "../api/authContext";
import ProtectedRoute from "./ProtectedRoute";
import LoginPage, { loginLaunching, JUST_SIGNED_IN_KEY, RESET_PATH, openedFromRecovery } from "../login/LoginPage";
import { PageCube } from "../framework/PageCube";
import { followProfileLang } from "../framework/i18n/i18n";

/* =====================================================================
   SHARED KERNEL — the one router both apps sit behind.
   Same sign-in for everyone; after it, the company's plan (tenants.plan,
   useAuth().plan) decides which app loads:
     enterprise → ./EnterpriseRoutes        (src/components/…, the full app)
     base       → ../../base/BaseApp        (src/base/…, the simple app)
   Each app is its own lazy chunk, so neither loads the other's code or CSS.
   Owned by the Enterprise chat; see src/base/TIERS.md before changing it.
   ===================================================================== */
const EnterpriseRoutes = lazy(() => import("./EnterpriseRoutes"));
const BaseApp = lazy(() => import("../../base/BaseApp"));
const LinkedInCapturePage = lazy(() => import("../pages/contacts/LinkedInCapture"));
const SuperAdminHome = lazy(() => import("../pages/superadmin/SuperAdminHome"));
const SuperAdminClient = lazy(() => import("../pages/superadmin/SuperAdminClient"));

// If already logged in, /login redirects to the right landing page.
function LoginRoute() {
  const { session, loading, isSuperadmin, roleLoading } = useAuth();
  // signing in right now: the sign-in page plays its launch and leaves by itself
  if (loginLaunching()) return <LoginPage />;
  if (loading || (session && roleLoading)) return null;
  if (session) return <Navigate to={isSuperadmin ? "/superadmin" : "/home"} replace />;
  return <LoginPage />;
}

// Superadmin-only. Uses the flag already loaded by AuthProvider (no flash).
function SuperAdminRoute() {
  const { isSuperadmin, roleLoading } = useAuth();
  if (roleLoading) return <JustSignedInHold />;
  if (!isSuperadmin) return <Navigate to="/home" replace />;
  return <Outlet />;
}

// The normal app: a superadmin has no company, so bounce them to their panel
// before any app page paints (prevents the home flash).
function AppGate() {
  const { isSuperadmin, roleLoading } = useAuth();
  if (roleLoading) return <JustSignedInHold />;
  if (isSuperadmin) return <Navigate to="/superadmin" replace />;
  return <Outlet />;
}

/** The company's app: Enterprise (full) or Base (simple), by its plan. */
function TierApp() {
  const { plan } = useAuth();
  // the language chosen on another device (kept in the profile): follow it
  useEffect(() => { void import("../pages/companies/companiesApi").then((m) => m.loadPrefs()).then((p) => followProfileLang(p?.lang)).catch(() => {}); }, []);
  return (
    <Suspense fallback={<JustSignedInHold />}>
      {plan === "base" ? <BaseApp /> : <EnterpriseRoutes />}
    </Suspense>
  );
}

/**
 * Right after the sign-in, while your profile is still on its way: the same deep
 * green screen and cube the sign-in ends on, so the hand-over to Home never shows
 * a blank page. On any other visit: nothing (as before).
 */
function JustSignedInHold() {
  let fresh = false;
  try { const v = sessionStorage.getItem(JUST_SIGNED_IN_KEY); fresh = !!v && Date.now() - Number(v) < 15000; } catch { /* ignore */ }
  if (!fresh) return null;
  return (
    <div aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: 500, cursor: "progress", background: "radial-gradient(60% 55% at 50% 46%, #0d3a2a 0%, #062319 45%, #03100b 100%)" }}>
      <div style={{ position: "absolute", left: "50%", top: "46%", width: 168, height: 170, margin: "-85px 0 0 -84px" }}>
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}><PageCube size={250} /></div>
      </div>
    </div>
  );
}

/**
 * A password-reset email always ends on the reset page, even when Supabase sent the
 * link to the Site URL (redirect URL not allow-listed) or the link has expired.
 */
let bootRecoveryDone = false;
/** true while the app, opened from a reset email somewhere else, still has to go to the reset page */
function useRecoveryLanding() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const nav = useRef(navigate);
  nav.current = navigate;
  // decided on the first render, before any other route can redirect (to /home, /login…)
  const landing = useRef<boolean | null>(null);
  if (landing.current === null) {
    landing.current = !bootRecoveryDone && openedFromRecovery() && window.location.pathname !== RESET_PATH;
    bootRecoveryDone = true;
  }
  if (landing.current && pathname === RESET_PATH) landing.current = false;
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((ev) => {
      if (ev === "PASSWORD_RECOVERY" && window.location.pathname !== RESET_PATH) nav.current(RESET_PATH, { replace: true });
    });
    return () => data.subscription.unsubscribe();
  }, []);
  return landing.current;
}

export default function AppRoutes() {
  if (useRecoveryLanding()) return <Navigate to={RESET_PATH} replace />;
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      {/* forgot password: the email link opens this (signed in by the link, not by the app) */}
      <Route path={RESET_PATH} element={<LoginPage mode="reset" />} />
      {/* the window the LinkedIn extension opens (signs in by itself) */}
      <Route path="/linkedin" element={<Suspense fallback={null}><LinkedInCapturePage /></Suspense>} />

      {/* Superadmin platform panel — protected by login, but outside the app layout */}
      <Route element={<ProtectedRoute />}>
        <Route element={<SuperAdminRoute />}>
          {/* straight from the sign-in, the green screen stays up while the console loads (it carries on from there) */}
          <Route path="/superadmin" element={<Suspense fallback={<JustSignedInHold />}><SuperAdminHome /></Suspense>} />
          <Route path="/superadmin/company/:id" element={<Suspense fallback={<JustSignedInHold />}><SuperAdminClient /></Suspense>} />
        </Route>
      </Route>

      {/* the app itself: Enterprise or Base, by the company's plan (each one routes its own pages) */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppGate />}>
          <Route path="/*" element={<TierApp />} />
        </Route>
      </Route>
    </Routes>
  );
}
