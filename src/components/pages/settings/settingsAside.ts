import { createContext, useContext, useEffect } from "react";

/* A card to the right of a settings page's sections (SettingsShell with `top`):
   a section can put something there — e.g. Settings › Tickets › Whose mail,
   "who reads what". The column only takes room while someone uses it. */
export interface SettingsAside { el: HTMLElement | null; claim: () => () => void }
export const SettingsAsideContext = createContext<SettingsAside | null>(null);

/** The element to portal into (null: no side card here — render in place). */
export function useSettingsAside(): HTMLElement | null {
  const ctx = useContext(SettingsAsideContext);
  useEffect(() => (ctx?.el ? ctx.claim() : undefined), [ctx]);
  return ctx?.el ?? null;
}
