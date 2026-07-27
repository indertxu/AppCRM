import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import Dock from "./Dock";
import { supabase } from "../api/supabase";
import { useAuth } from "../api/AuthProvider";
import { DOCK_PINNED_KEY, DOCK_PINNED_EVENT } from "../pages/settings/SettingsPage";
import "./AppLayout.css";

export default function AppLayout() {
  const { session } = useAuth();
  const uid = session?.user?.id ?? null;

  // localStorage is a fast cache to avoid a flash; the profile is the source of truth.
  const [pinned, setPinned] = useState<boolean>(
    () => localStorage.getItem(DOCK_PINNED_KEY) === "true"
  );

  // React to live toggles from the Settings page.
  useEffect(() => {
    const onChange = (e: Event) => setPinned((e as CustomEvent<boolean>).detail);
    window.addEventListener(DOCK_PINNED_EVENT, onChange);
    return () => window.removeEventListener(DOCK_PINNED_EVENT, onChange);
  }, []);

  // Load the saved preference from the user's profile on login (follows them across devices).
  useEffect(() => {
    if (!uid) return;
    (async () => {
      const { data } = await supabase.from("profiles").select("dock_pinned").eq("id", uid).maybeSingle();
      if (data && typeof data.dock_pinned === "boolean") {
        setPinned(data.dock_pinned);
        localStorage.setItem(DOCK_PINNED_KEY, String(data.dock_pinned));
      }
    })();
  }, [uid]);

  return (
    <div className={`app-shell ${pinned ? "dock-pinned" : ""}`}>
      <div className="app-page">
        <Outlet />
      </div>
      <Dock />
    </div>
  );
}