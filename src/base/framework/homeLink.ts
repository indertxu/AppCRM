/**
 * Home → a page, with the same filters the card was showing.
 *
 * A card (or one of its values) calls openFromHome(nav, path, data): the page opens and, once
 * it is on screen, useHomeLink(path, apply) hands it `data` (which tab, which filters…) to
 * apply — the same picture the person was looking at on the home, now in full.
 * It works whether the page has to load first or is already open (an event).
 *
 * Cards on the home board register what a click on the card itself does (setCardLink), so
 * the card's own settings — the pipeline and stages it shows, whose figures — go along.
 */
import { useEffect, useRef } from "react";
import { goToSection } from "./pageAccess";

type Nav = (to: string, opts?: { replace?: boolean; state?: unknown }) => void;
const EVENT = "next:home-link";
const TTL = 15_000;
let pending: { path: string; data: any; at: number } | null = null;

/** Open `path` (and its section, like goToSection) and give the page `data` to apply. */
export function openFromHome(nav: Nav, path: string, data: Record<string, any>, section?: string | null) {
  pending = { path, data, at: Date.now() };
  if (section) goToSection(nav, path, section); else nav(path);
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(EVENT, { detail: { path } })), 0);
}

/** On `path`: apply what a home card sent (once), now or when it arrives. */
export function useHomeLink<T = Record<string, any>>(path: string, apply: (data: T) => void, ready = true) {
  const fn = useRef(apply);
  fn.current = apply;
  useEffect(() => {
    if (!ready) return;
    const take = () => {
      const p = pending;
      if (!p || p.path !== path || Date.now() - p.at > TTL) return;
      pending = null;
      fn.current(p.data as T);
    };
    take();
    const on = (e: Event) => { if ((e as CustomEvent).detail?.path === path) take(); };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [path, ready]);
}

/** Peek (without taking) what a home card sent to `path` — for state that must start from it. */
export function peekHomeLink<T = Record<string, any>>(path: string): T | null {
  const p = pending;
  return p && p.path === path && Date.now() - p.at <= TTL ? (p.data as T) : null;
}

/* ---- a card's own click (the board calls cardLink(id) before its default page) ---- */
const cardLinks = new Map<string, () => void>();
/** Called while drawing a card: what a click on the card opens (null: the board's default). */
export function setCardLink(id: string, go: (() => void) | null) {
  if (go) cardLinks.set(id, go); else cardLinks.delete(id);
}
export function cardLink(id: string): (() => void) | null { return cardLinks.get(id) ?? null; }

/** Today and n days from it, as YYYY-MM-DD (local). */
export const homeDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
