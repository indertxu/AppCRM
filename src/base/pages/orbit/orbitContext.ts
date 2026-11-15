import { createContext, useContext, useSyncExternalStore } from "react";
import type { OrbitView } from "./orbitTypes";

/**
 * BASE · Orbit's current view, kept in Orbit's own state (not read from the router):
 * switching views changes only this, so the three lists don't re-render on a switch.
 */
export const OrbitViewContext = createContext<{
  view: OrbitView; views: OrbitView[]; go: (v: OrbitView) => void;
}>({ view: "all", views: ["all"], go: () => {} });
export const useOrbitView = () => useContext(OrbitViewContext);

/**
 * The switch is open (names showing). Shared by every view's copy, so the one that comes in looks like the one
 * you were pointing at. Kept OUTSIDE React's context on purpose: opening / closing re-renders only the switches,
 * never the pages (Clients and Contracts read the context above — re-rendering them on every hover made it stutter).
 */
let navOpen = false;
const subs = new Set<() => void>();
export const setNavOpen = (open: boolean) => { if (open === navOpen) return; navOpen = open; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useNavOpen = () => useSyncExternalStore(subscribe, () => navOpen, () => false);
