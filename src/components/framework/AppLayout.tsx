import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Dock from "./Dock";
import { supabase, usageMeter } from "../api/supabase";
import { getActAs } from "./SuperAdmin";
import { useAuth } from "../api/AuthProvider";
import { DOCK_LABELS_KEY, DOCK_LABELS_EVENT, DOCK_COMPACT_KEY, DOCK_COMPACT_EVENT } from "../pages/settings/SettingsPage";
import { loadPrefs } from "../pages/companies/companiesApi";
import { PageAccessProvider, NAV_RESET_EVENT } from "./pageAccess";
import "./AppLayout.css";

/**
 * Page meter (for the superadmin's usage & cost panel): one row per page visit in
 * platform_page_visits — the page, the seconds you were actually using it (tab in
 * front and some input in the last 2 minutes), and the requests / bytes it moved.
 * Written when you leave the page, hide the tab, or every 10 minutes on a long stay.
 * Not while a superadmin is acting as someone.
 */
const METER_TICK = 5;
const METER_IDLE_MS = 2 * 60 * 1000;
const METER_FLUSH_MS = 10 * 60 * 1000;
function usePageMeter(uid: string | null, token: string | null) {
  const { pathname } = useLocation();
  const page = (pathname.split("/")[1] || "home").toLowerCase();
  const tok = useRef(token);
  tok.current = token;
  const who = useRef(uid);
  who.current = uid;
  const st = useRef({ page: "", started: 0, active: 0, req0: 0, bytes0: 0, lastInput: Date.now(), lastFlush: Date.now() });

  const flush = useRef((beacon: boolean) => {
    const s = st.current;
    const uidNow = who.current;
    if (!uidNow || !s.page) return;
    const row = {
      user_id: uidNow, page: s.page, started_at: new Date(s.started).toISOString(),
      active_seconds: Math.min(Math.round(s.active), 86400),
      requests: Math.max(0, usageMeter.requests - s.req0), bytes: Math.max(0, usageMeter.bytes - s.bytes0),
    };
    s.started = Date.now(); s.active = 0; s.req0 = usageMeter.requests; s.bytes0 = usageMeter.bytes; s.lastFlush = Date.now();
    if (row.active_seconds < 2 && row.requests === 0) return;
    if (getActAs()) return;
    if (beacon && tok.current) {
      try {
        void fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/platform_page_visits`, {
          method: "POST", keepalive: true, body: JSON.stringify(row),
          headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string, Authorization: `Bearer ${tok.current}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        }).catch(() => { /* ignore */ });
      } catch { /* ignore */ }
      return;
    }
    void supabase.from("platform_page_visits").insert(row).then(() => { /* ignore */ }, () => { /* ignore */ });
  });

  // a new page: close the last one first (layout effect: before the new page's own requests start)
  useLayoutEffect(() => {
    flush.current(false);
    const s = st.current;
    s.page = page; s.started = Date.now(); s.active = 0; s.req0 = usageMeter.requests; s.bytes0 = usageMeter.bytes;
  }, [page]);

  useEffect(() => {
    const onInput = () => { st.current.lastInput = Date.now(); };
    const evs = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    evs.forEach((e) => window.addEventListener(e, onInput, { passive: true }));
    const tick = window.setInterval(() => {
      const s = st.current;
      if (document.visibilityState === "visible" && Date.now() - s.lastInput < METER_IDLE_MS) s.active += METER_TICK;
      if (Date.now() - s.lastFlush > METER_FLUSH_MS) flush.current(false);
    }, METER_TICK * 1000);
    const onVis = () => { if (document.visibilityState === "hidden") flush.current(true); else st.current.lastInput = Date.now(); };
    const onHide = () => flush.current(true);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, onInput));
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
      flush.current(false);
    };
  }, []);
}

/** The app: a fixed sidebar rail on the left, always there, and the page to its right. */
export default function AppLayout() {
  const { session } = useAuth();
  const uid = session?.user?.id ?? null;
  usePageMeter(uid, session?.access_token ?? null);

  // "Always show menu labels" (Settings › Interface): a slightly wider rail with names under the icons.
  // localStorage is a fast cache to avoid a flash; the profile is the source of truth.
  const [labels, setLabels] = useState<boolean>(() => { try { return localStorage.getItem(DOCK_LABELS_KEY) === "true"; } catch { return false; } });
  useEffect(() => {
    const onLabels = (e: Event) => setLabels((e as CustomEvent<boolean>).detail);
    window.addEventListener(DOCK_LABELS_EVENT, onLabels);
    return () => window.removeEventListener(DOCK_LABELS_EVENT, onLabels);
  }, []);
  useEffect(() => {
    if (!uid) return;
    supabase.from("profiles").select("dock_labels").eq("id", uid).maybeSingle().then(({ data }) => {
      if (data && typeof (data as any).dock_labels === "boolean") {
        setLabels((data as any).dock_labels);
        try { localStorage.setItem(DOCK_LABELS_KEY, String((data as any).dock_labels)); } catch { /* ignore */ }
      }
    });
  }, [uid]);

  // "Small sidebar icons" (Settings › Interface): a slimmer rail that still fits a zoomed-in page.
  const [compact, setCompact] = useState<boolean>(() => { try { return localStorage.getItem(DOCK_COMPACT_KEY) === "true"; } catch { return false; } });
  useEffect(() => {
    const on = (e: Event) => setCompact((e as CustomEvent<boolean>).detail);
    window.addEventListener(DOCK_COMPACT_EVENT, on);
    return () => window.removeEventListener(DOCK_COMPACT_EVENT, on);
  }, []);
  useEffect(() => {
    if (!uid) return;
    loadPrefs().then((p) => {
      if (typeof p.dockCompact !== "boolean") return;
      setCompact(p.dockCompact);
      try { localStorage.setItem(DOCK_COMPACT_KEY, String(p.dockCompact)); } catch { /* ignore */ }
    }).catch(() => {});
  }, [uid]);

  // Sidebar item of the page you're on → back to that page's overview: remount it (every
  // sub-view, open panel and tab is local state, so a fresh mount is the overview).
  const [resetKey, setResetKey] = useState(0);
  useEffect(() => {
    const on = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (path === "/home") return;     // nothing to reset there (and no reason to replay its intro)
      setResetKey((k) => k + 1);
      try { window.scrollTo({ top: 0 }); } catch { /* ignore */ }
    };
    window.addEventListener(NAV_RESET_EVENT, on);
    return () => window.removeEventListener(NAV_RESET_EVENT, on);
  }, []);

  return (
    <PageAccessProvider>
      <div className={`app-shell ${compact ? "rail-compact" : labels ? "rail-labels" : ""}`}>
        <Dock />
        <div className="app-page" key={resetKey}>
          <Outlet />
        </div>
      </div>
    </PageAccessProvider>
  );
}

// The cube and the page loader live in the shared kernel (both apps use them); re-exported here
// so the existing imports from "framework/AppLayout" keep working.
export { PageCube, PageLoader, PageCover, PC_LAND_T, pcPoseAt, pcAdopt } from "./PageCube";
