import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import Dock from "./Dock";
import { supabase } from "../api/supabase";
import { useAuth } from "../api/AuthProvider";
import { DOCK_PINNED_KEY, DOCK_PINNED_EVENT, DOCK_LABELS_KEY, DOCK_LABELS_EVENT } from "../pages/settings/SettingsPage";
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

  return (
    <div className={`app-shell ${pinned ? "dock-pinned" : ""} ${labels ? "dock-labels" : ""}`}>
      <div className="app-page">
        <Outlet />
      </div>
      <Dock />
    </div>
  );
}