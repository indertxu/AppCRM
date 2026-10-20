import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import Dock from "./Dock";
import { supabase } from "../api/supabase";
import { useAuth } from "../api/AuthProvider";
import { DOCK_LABELS_KEY, DOCK_LABELS_EVENT } from "../pages/settings/SettingsPage";
import { PageAccessProvider } from "./pageAccess";
import "./AppLayout.css";

/** The app: a fixed sidebar rail on the left, always there, and the page to its right. */
export default function AppLayout() {
  const { session } = useAuth();
  const uid = session?.user?.id ?? null;

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

  return (
    <PageAccessProvider>
      <div className={`app-shell ${labels ? "rail-labels" : ""}`}>
        <Dock />
        <div className="app-page">
          <Outlet />
        </div>
      </div>
    </PageAccessProvider>
  );
}
