import { supabase } from "../api/supabase";
import { savePref } from "../pages/companies/companiesApi";

/* =====================================================================
   How the sidebar shows its items (Settings › Interface, and the
   expand / collapse button at the foot of the sidebar):
   • "hover" — icons only, the name on hover
   • "below" — the name under each icon (a slightly wider rail)
   • "side"  — the name beside each icon (a wide, fixed sidebar)
   Small icons are a separate choice and work with any of them.
   Saved with the person (prefs.dockLabelMode; profiles.dock_labels kept
   in step for older code); localStorage only avoids a flash on load.
   ===================================================================== */

export type DockLabelMode = "hover" | "below" | "side";
export const DOCK_MODE_KEY = "next.dockLabelMode";
/** Same event the old on/off switch used: detail is now the mode (a boolean still works). */
export const DOCK_MODE_EVENT = "next:dock-labels";
const LEGACY_LABELS_KEY = "next.dockLabels";

export const isDockMode = (v: unknown): v is DockLabelMode => v === "hover" || v === "below" || v === "side";
export const modeFromDetail = (d: unknown): DockLabelMode => (isDockMode(d) ? d : d === true ? "below" : "hover");

export function readDockMode(): DockLabelMode {
  try {
    const m = localStorage.getItem(DOCK_MODE_KEY);
    if (isDockMode(m)) return m;
    return localStorage.getItem(LEGACY_LABELS_KEY) === "true" ? "below" : "hover";
  } catch { return "hover"; }
}

/** The mode from the person's saved prefs (or the old dock_labels flag). */
export function dockModeFrom(prefs: Record<string, any> | null | undefined, dockLabels?: boolean | null): DockLabelMode | null {
  if (isDockMode(prefs?.dockLabelMode)) return prefs!.dockLabelMode;
  if (typeof dockLabels === "boolean") return dockLabels ? "below" : "hover";
  return null;
}

export async function setDockMode(mode: DockLabelMode, uid?: string | null): Promise<void> {
  try {
    localStorage.setItem(DOCK_MODE_KEY, mode);
    localStorage.setItem(LEGACY_LABELS_KEY, String(mode !== "hover"));
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(DOCK_MODE_EVENT, { detail: mode }));
  await savePref("dockLabelMode", mode).catch(() => {});
  if (uid) await supabase.from("profiles").update({ dock_labels: mode !== "hover" }).eq("id", uid);
}
