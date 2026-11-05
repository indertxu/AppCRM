import { createContext, useContext } from "react";
import type { OrbitView } from "./orbitTypes";

/**
 * BASE · Orbit's current view, kept in Orbit's own state (not read from the router):
 * switching views changes only this, so the three lists don't re-render on a switch.
 */
export const OrbitViewContext = createContext<{
  view: OrbitView; views: OrbitView[]; go: (v: OrbitView) => void;
  /** The switch is open (names showing). Shared by every view's copy, so the one that comes in looks like the one you were pointing at. */
  navOpen: boolean; setNavOpen: (open: boolean) => void;
}>({ view: "all", views: ["all"], go: () => {}, navOpen: false, setNavOpen: () => {} });
export const useOrbitView = () => useContext(OrbitViewContext);
