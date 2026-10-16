import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Dock from "./Dock";
import { supabase } from "../api/supabase";
import { useAuth } from "../api/AuthProvider";
import { DOCK_PINNED_KEY, DOCK_PINNED_EVENT, DOCK_LABELS_KEY, DOCK_LABELS_EVENT } from "../pages/settings/SettingsPage";
import { PageAccessProvider } from "./pageAccess";
import "./AppLayout.css";

export default function AppLayout() {
  const { session } = useAuth();
  const uid = session?.user?.id ?? null;

  // localStorage is a fast cache to avoid a flash; the profile is the source of truth.
  const [pinned, setPinned] = useState<boolean>(
    () => localStorage.getItem(DOCK_PINNED_KEY) === "true"
  );
  const [labels, setLabels] = useState<boolean>(
    () => localStorage.getItem(DOCK_LABELS_KEY) === "true"
  );

  // React to live toggles from the Settings page.
  useEffect(() => {
    const onPin = (e: Event) => setPinned((e as CustomEvent<boolean>).detail);
    const onLabels = (e: Event) => setLabels((e as CustomEvent<boolean>).detail);
    window.addEventListener(DOCK_PINNED_EVENT, onPin);
    window.addEventListener(DOCK_LABELS_EVENT, onLabels);
    return () => {
      window.removeEventListener(DOCK_PINNED_EVENT, onPin);
      window.removeEventListener(DOCK_LABELS_EVENT, onLabels);
    };
  }, []);

  // Load the saved preference from the user's profile on login (follows them across devices).
  useEffect(() => {
    if (!uid) return;
    (async () => {
      const { data } = await supabase.from("profiles").select("dock_pinned, dock_labels").eq("id", uid).maybeSingle();
      if (data && typeof data.dock_pinned === "boolean") {
        setPinned(data.dock_pinned);
        localStorage.setItem(DOCK_PINNED_KEY, String(data.dock_pinned));
      }
      if (data && typeof data.dock_labels === "boolean") {
        setLabels(data.dock_labels);
        localStorage.setItem(DOCK_LABELS_KEY, String(data.dock_labels));
      }
    })();
  }, [uid]);

  // Is the page behind the pinned dock dark (Sales, Management…) or light?
  // The dock takes the same glass as that page's own cards.
  const pageRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const [onDark, setOnDark] = useState(false);
  useEffect(() => {
    const host = pageRef.current;
    if (!host) return;
    const check = () => {
      const el = host.firstElementChild as HTMLElement | null;
      const bg = el ? getComputedStyle(el).backgroundColor : "";
      const m = bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) { setOnDark(false); return; }
      const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
      setOnDark(lum < 0.35);
    };
    check();
    const mo = new MutationObserver(check);
    mo.observe(host, { childList: true });
    let watched: Element | null = null;
    const watchFirst = () => {
      const el = host.firstElementChild;
      if (el && el !== watched) { watched = el; mo.observe(el, { attributes: true, attributeFilter: ["class", "style"] }); }
    };
    watchFirst();
    const mo2 = new MutationObserver(() => { watchFirst(); check(); });
    mo2.observe(host, { childList: true });
    const t = window.setTimeout(check, 400);
    return () => { mo.disconnect(); mo2.disconnect(); window.clearTimeout(t); };
  }, [location.pathname]);

  return (
    <PageAccessProvider>
    <div className={`app-shell ${pinned ? "dock-pinned" : ""} ${labels ? "dock-labels" : ""} ${pinned && onDark ? "dock-on-dark" : ""}`}>
      <div className="app-page" ref={pageRef}>
        <Outlet />
      </div>
      <Dock />
    </div>
    </PageAccessProvider>
  );
}