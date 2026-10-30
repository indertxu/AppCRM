import { useEffect, useLayoutEffect, useState, useRef, useCallback, lazy, Suspense, type ReactNode, type MouseEvent as ReactMouseEvent, type FocusEvent as ReactFocusEvent, type PointerEvent as ReactPointerEvent, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { loadPrefs } from "../pages/companies/companiesApi";
import { useNavigate, useLocation } from "react-router-dom";
import { usePageAccess, clearPendingSection, guardedLeave, NAV_RESET_EVENT, type PageKey } from "./pageAccess";
import { supabase } from "../api/supabase";
import { useAuth } from "../api/AuthProvider";

// The search lives on the home page; the rail opens the same one as a palette (loaded on demand).
const SearchPalette = lazy(() => import("../pages/homepage/HomePage").then((m) => ({ default: m.GlobalSearch })));

interface DockItem {
  label: string;
  path: string;
  icon: ReactNode;
  /** Which page this opens — visibility comes from Settings → Organization → Page access. */
  page: PageKey;
  /** Its own style hook when it shares the page's access (Tickets follows Home). */
  cls?: string;
}

// Home is the Next logo (the cube with the N, the chart and the bars), drawn in outline like the other icons.
const homeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2.8l8.6 4.6v9.2L12 21.2l-8.6-4.6V7.4z" />
    <path d="M3.4 7.4L12 12l8.6-4.6M12 12v9.2" />
    <path d="M6 15.4v-4.3l3.4 6.1v-4.3" strokeWidth="1.5" />
    <path d="M15 17.6v-2.4M18 16v-3.6" strokeWidth="1.6" />
    <path d="M8.6 7.6l2.4-1 1.6.8 2.8-1.6" strokeWidth="1.4" />
  </svg>
);
const successIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20.5s-7.5-4.4-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.8-7.5 10.2-7.5 10.2z" />
    <path d="M8.5 12.2h2l1.2-2.2 1.6 4 1.2-1.8h1.5" />
  </svg>
);
const marketingIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1z" />
    <path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10" />
  </svg>
);
const calendarIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4.5" width="18" height="16" rx="3" />
    <path d="M3 9h18" />
    <path d="M8 2.5v4M16 2.5v4" />
    <rect x="6.5" y="12" width="3.2" height="3.2" rx="0.8" fill="currentColor" stroke="none" />
  </svg>
);
const clientsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
    <circle cx="17.5" cy="9" r="2.4" />
    <path d="M16 14.2a4.8 4.8 0 0 1 4.5 4.8" />
  </svg>
);
const projectsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M8 13h8M8 16h5" />
  </svg>
);
const managementIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="8" height="7" rx="1.6" />
    <rect x="13" y="3" width="8" height="4.5" rx="1.6" />
    <rect x="13" y="10.5" width="8" height="10.5" rx="1.6" />
    <rect x="3" y="13" width="8" height="8" rx="1.6" />
  </svg>
);
const companiesIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="3" width="10" height="18" rx="1.5" />
    <path d="M14 8h6v13H4" />
    <path d="M7.5 7h3M7.5 11h3M7.5 15h3M17 12h0M17 16h0" />
  </svg>
);
const contactsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <circle cx="12" cy="10" r="2.6" />
    <path d="M8 17a4 4 0 0 1 8 0" />
    <path d="M4 7h2M4 12h1.5M4 17h2" />
  </svg>
);
const ticketsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5V10a2 2 0 0 0 0 4v2.5A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5V14a2 2 0 0 0 0-4z" />
    <path d="M14.5 6v2M14.5 11v2M14.5 16v2" strokeDasharray="0" />
  </svg>
);
const salesIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18" />
    <path d="M7 14l3-3 3 2 5-6" />
    <circle cx="7" cy="14" r="1" fill="currentColor" stroke="none" />
    <circle cx="18" cy="7" r="1" fill="currentColor" stroke="none" />
  </svg>
);
const reportsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M8 16v-4M12 16V8M16 16v-6" />
  </svg>
);
const settingsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/** Each person's own order of the toolbar (Settings → Interface), by path. */
export const DOCK_ORDER_KEY = "next.dockOrder";
export const DOCK_ORDER_EVENT = "next:dock-order";
const readOrder = (): string[] => { try { const v = JSON.parse(localStorage.getItem(DOCK_ORDER_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
/** Items in that order; anything new or not placed keeps its default spot at the end. */
export function orderDock<T extends { path: string }>(list: T[], order: string[]): T[] {
  const pos = (p: string) => { const i = order.indexOf(p); return i < 0 ? order.length + list.findIndex((x) => x.path === p) : i; };
  return [...list].sort((a, b) => pos(a.path) - pos(b.path));
}

const items: DockItem[] = [
  { label: "Home", path: "/home", icon: homeIcon, page: "home" },
  { label: "Tickets", path: "/tickets", icon: ticketsIcon, page: "tickets", cls: "tickets" },
  { label: "Calendar", path: "/calendar", icon: calendarIcon, page: "calendar" },
  { label: "Contacts", path: "/contacts", icon: contactsIcon, page: "contacts" },
  { label: "Companies", path: "/companies", icon: companiesIcon, page: "companies" },
  { label: "Clients", path: "/clients", icon: clientsIcon, page: "clients" },
  { label: "Projects", path: "/projects", icon: projectsIcon, page: "projects" },
  { label: "Deals", path: "/sales", icon: salesIcon, page: "sales" },
  { label: "Customer success", path: "/success", icon: successIcon, page: "success" },
  { label: "Marketing", path: "/marketing", icon: marketingIcon, page: "marketing" },
  { label: "Management", path: "/management", icon: managementIcon, page: "management" },
  { label: "Reports", path: "/reports", icon: reportsIcon, page: "reports" },
  { label: "Settings", path: "/settings", icon: settingsIcon, page: "settings" },
];

/** What the order editor in Settings shows. */
export const DOCK_ITEMS = items;

const searchIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
);
/** The app's sidebar: a fixed dark rail, always there. Icons with their name on hover
 *  (or always, with "Always show menu labels" in Settings › Interface). */
export default function Dock() {
  const navigate = useNavigate();
  const location = useLocation();
  const { canSee } = usePageAccess();
  const { session } = useAuth();
  const uid = session?.user?.id ?? null;

  const [order, setOrder] = useState<string[]>(readOrder);
  useEffect(() => {
    const on = (e: Event) => setOrder(Array.isArray((e as CustomEvent).detail) ? (e as CustomEvent).detail : readOrder());
    window.addEventListener(DOCK_ORDER_EVENT, on);
    // The saved order follows you to any browser.
    loadPrefs().then((p) => {
      if (Array.isArray(p.dockOrder)) { setOrder(p.dockOrder); try { localStorage.setItem(DOCK_ORDER_KEY, JSON.stringify(p.dockOrder)); } catch { /* ignore */ } }
    }).catch(() => {});
    return () => window.removeEventListener(DOCK_ORDER_EVENT, on);
  }, []);
  const visible = orderDock(items.filter((it) => canSee(it.page)), order);
  const main = visible.filter((it) => it.path !== "/settings");
  const settings = visible.find((it) => it.path === "/settings");
  const isOn = (path: string) => location.pathname === path || location.pathname.startsWith(`${path}/`);

  // ---- who I am (avatar + menu) ----
  const [me, setMe] = useState<{ name: string; email: string; initials: string } | null>(null);
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    supabase.from("profiles").select("first_name, last_name, email").eq("id", uid).maybeSingle().then(({ data }) => {
      if (!alive) return;
      const d: any = data ?? {};
      const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || session?.user?.email || "";
      const initials = (name.split(/\s+/).map((x: string) => x[0]).join("").slice(0, 2) || "?").toUpperCase();
      setMe({ name, email: d.email ?? session?.user?.email ?? "", initials });
    });
    return () => { alive = false; };
  }, [uid]);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const meRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !meRef.current?.contains(t)) setMenu(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [menu]);

  // ---- search palette (⌘K anywhere; on Home the page's own search answers) ----
  const [search, setSearch] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.key === "k" && (e.metaKey || e.ctrlKey))) return;
      if (document.querySelector(".home .gs-box input")) return; // the home page has it on screen
      e.preventDefault(); setSearch(true);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => { setSearch(false); setMenu(false); setTip(null); }, [location.key]);

  // ---- tooltips: drawn on <body> so a page or its overlays never hide them.
  // One tooltip that glides from item to item; it only fades when the pointer leaves the rail.
  const [tipRaw, setTipRaw] = useState<{ text: ReactNode; y: number; on: boolean; glide: boolean } | null>(null);
  const tipTimer = useRef<number | null>(null);
  const showTip = (text: ReactNode, y: number) => {
    if (tipTimer.current) { window.clearTimeout(tipTimer.current); tipTimer.current = null; }
    setTipRaw((t) => ({ text, y, on: true, glide: !!t?.on }));
  };
  const hideTip = () => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTipRaw((t) => (t ? { ...t, on: false } : t)), 110);
  };
  const setTip = (v: null) => { if (tipTimer.current) window.clearTimeout(tipTimer.current); setTipRaw(v); };
  const tip = tipRaw;
  const tipOn = (text: ReactNode) => ({
    onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => { const r = e.currentTarget.getBoundingClientRect(); showTip(text, r.top + r.height / 2); },
    onMouseLeave: hideTip,
    onFocus: (e: ReactFocusEvent<HTMLElement>) => { if (!e.currentTarget.matches(":focus-visible")) return; const r = e.currentTarget.getBoundingClientRect(); showTip(text, r.top + r.height / 2); },
    onBlur: hideTip,
  });

  // ---- motion: a sliding active pill, a glow that follows the pointer, magnetic icons, ripples ----
  const navRef = useRef<HTMLElement>(null);
  const inkRef = useRef<HTMLSpanElement>(null);
  const [inkReady, setInkReady] = useState(false);
  const placeInk = useCallback(() => {
    const nav = navRef.current, ink = inkRef.current;
    if (!nav || !ink) return;
    const on = nav.querySelector<HTMLElement>(".rail-item.is-on");
    if (!on) { ink.style.opacity = "0"; return; }
    // offsets, not screen boxes: entrance / hover transforms must not shift where the pill lands
    let x = 0, y = 0, el: HTMLElement | null = on;
    while (el && el !== nav) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent as HTMLElement | null; }
    if (el !== nav) { const n = nav.getBoundingClientRect(), r = on.getBoundingClientRect(); x = r.left - n.left; y = r.top - n.top; }
    ink.style.opacity = "1";
    ink.style.width = `${on.offsetWidth}px`;
    ink.style.height = `${on.offsetHeight}px`;
    ink.style.borderRadius = getComputedStyle(on).borderRadius;
    ink.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    setInkReady(true);
  }, []);
  useLayoutEffect(() => { placeInk(); });
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => placeInk());
    ro.observe(nav);
    window.addEventListener("resize", placeInk);
    return () => { ro.disconnect(); window.removeEventListener("resize", placeInk); };
  }, [placeInk]);
  const glowRaf = useRef(0);
  const onRailMove = (e: ReactMouseEvent<HTMLElement>) => {
    const nav = navRef.current; if (!nav) return;
    const y = e.clientY - nav.getBoundingClientRect().top;
    cancelAnimationFrame(glowRaf.current);
    glowRaf.current = requestAnimationFrame(() => { nav.style.setProperty("--gy", `${y}px`); nav.classList.add("is-near"); });
  };
  const onRailLeave = () => { navRef.current?.classList.remove("is-near"); hideTip(); };
  const magnet = {
    onMouseMove: (e: ReactMouseEvent<HTMLElement>) => {
      const el = e.currentTarget, r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      el.style.setProperty("--mx", `${(dx * 3).toFixed(2)}px`); el.style.setProperty("--my", `${(dy * 3).toFixed(2)}px`);
    },
    onMouseLeave: (e: ReactMouseEvent<HTMLElement>) => { e.currentTarget.style.setProperty("--mx", "0px"); e.currentTarget.style.setProperty("--my", "0px"); },
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      const el = e.currentTarget, r = el.getBoundingClientRect();
      const dot = document.createElement("span");
      dot.className = "rail-ripple";
      dot.style.left = `${e.clientX - r.left}px`; dot.style.top = `${e.clientY - r.top}px`;
      el.appendChild(dot);
      dot.addEventListener("animationend", () => dot.remove(), { once: true });
      window.setTimeout(() => dot.remove(), 900);
    },
  };
  const openSearch = () => {
    const home = document.querySelector<HTMLInputElement>(".home .gs-box input");
    if (home) { home.focus(); return; }
    setSearch(true);
  };

  const item = (it: DockItem) => (
    <button key={it.path} type="button" className={`rail-item k-${it.cls ?? it.page} ${isOn(it.path) ? "is-on" : ""}`} onClick={() => {
        setTip(null);
        guardedLeave(() => {
          clearPendingSection();
          // already on this page (maybe deep in a sub-section): back to its overview
          if (isOn(it.path)) window.dispatchEvent(new CustomEvent(NAV_RESET_EVENT, { detail: it.path }));
          navigate(it.path);
        });
      }}
      aria-label={it.label} aria-current={isOn(it.path) ? "page" : undefined} {...tipOn(it.label)}
      onMouseMove={magnet.onMouseMove} onPointerDown={magnet.onPointerDown}
      onMouseLeave={(e) => { magnet.onMouseLeave(e); hideTip(); }}>
      <span className="rail-ico">{it.icon}</span>
      <span className="rail-label">{it.label}</span>
    </button>
  );

  const homeItem = main.find((it) => it.path === "/home") ?? null;
  const rest = main.filter((it) => it !== homeItem);

  return (
    <>
      <nav className={`rail ${inkReady ? "has-ink" : ""}`} aria-label="Main" ref={navRef} onMouseMove={onRailMove} onMouseLeave={onRailLeave}>
        <span className="rail-ink" ref={inkRef} aria-hidden="true" />
        {/* Home (the Next logo) sits on top, where the logo used to be */}
        {homeItem && <div className="rail-slot" style={{ ["--i" as string]: 0 } as CSSProperties}>{item(homeItem)}</div>}
        <button type="button" className="rail-item is-search k-search" style={{ ["--i" as string]: 1 } as CSSProperties} onClick={() => { setTip(null); openSearch(); }} aria-label="Search"
          {...tipOn(<>Search <kbd>{/mac/i.test(navigator.platform) ? "⌘" : "Ctrl"} K</kbd></>)}
          onMouseMove={magnet.onMouseMove} onPointerDown={magnet.onPointerDown}
          onMouseLeave={(e) => { magnet.onMouseLeave(e); hideTip(); }}>
          <span className="rail-ico">{searchIcon}</span>
          <span className="rail-label">Search</span>
        </button>
        <div className="rail-list">
          {rest.map((it, i) => (
            <div key={it.path} className="rail-slot" style={{ ["--i" as string]: i + 2 } as CSSProperties}>
              {/* a quiet line between Home/Calendar and the CRM pages */}
              {i > 0 && rest[i - 1].path === "/calendar" && <span className="rail-sep is-thin" />}
              {item(it)}
            </div>
          ))}
        </div>
        <div className="rail-foot">
          {settings && item(settings)}
          <div className="rail-me" ref={meRef}>
            <button type="button" className={`rail-avatar ${menu ? "is-open" : ""}`} onClick={() => { setTip(null); setMenu((v) => !v); }} aria-label="Your account" aria-expanded={menu}
              {...(menu ? {} : tipOn(me?.name || "Your account"))}>
              {me?.initials ?? ""}
            </button>
            {menu && createPortal(
              <div className="rail-menu" role="menu" ref={menuRef}>
                <div className="rail-menu-who"><b>{me?.name}</b><span>{me?.email}</span></div>
                <button type="button" role="menuitem" onClick={() => guardedLeave(() => navigate("/settings", { state: { settingsView: "account" } }))}>Account</button>
                {settings && <button type="button" role="menuitem" onClick={() => guardedLeave(() => navigate("/settings", { state: { settingsView: "interface" } }))}>Interface</button>}
                <button type="button" role="menuitem" className="is-out" onClick={() => { setMenu(false); guardedLeave(() => { void supabase.auth.signOut().catch(() => {}); }); }}>Sign out</button>
              </div>,
              document.body,
            )}
          </div>
        </div>
      </nav>
      {tip && createPortal(
        <div className={`rail-tip-float ${tip.on ? "is-on" : ""} ${tip.glide ? "is-glide" : ""}`} role="tooltip" style={{ top: tip.y }}>
          <span key={typeof tip.text === "string" ? tip.text : "x"} className="rail-tip-txt">{tip.text}</span>
        </div>, document.body)}
      {search && createPortal(
        <div className="rail-pal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setSearch(false); }}
          onKeyDown={(e) => { if (e.key === "Escape") setSearch(false); }}>
          <div className="rail-pal">
            <Suspense fallback={<div className="rail-pal-wait">Loading search…</div>}>
              <PaletteFocus onClose={() => setSearch(false)}><SearchPalette /></PaletteFocus>
            </Suspense>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** Focuses the palette's search box when it appears; Escape on an empty box closes the palette. */
function PaletteFocus({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => ref.current?.querySelector<HTMLInputElement>("input")?.focus(), 30);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inp = ref.current?.querySelector<HTMLInputElement>("input");
      if (!inp || !inp.value) onClose();
    };
    document.addEventListener("keydown", key);
    return () => { window.clearTimeout(t); document.removeEventListener("keydown", key); };
  }, [onClose]);
  return <div ref={ref} className="rail-pal-in">{children}</div>;
}

/* ══════════════ Closing a modal with work in it (imports, exports…) ══════════════ */
/**
 * Escape, the backdrop, × and Cancel never throw away work silently:
 * - nothing done yet → closes as usual;
 * - work in progress (`dirty`) → asks "Discard…?" (Keep working is the default);
 * - something running (`busy`) → explains it can't close until it finishes.
 * The backdrop only closes on a click that started AND ended on it (dragging out of a field doesn't close).
 * Usage: const g = useCloseGuard({ dirty, busy, onClose, what: "import" });
 *        backdrop: <div {...g.backdrop}> · ×/Cancel/Esc: g.requestClose() · render {g.prompt}
 */
export function useCloseGuard(opts: { dirty: boolean; busy?: boolean; onClose: () => void; what: "import" | "export"; noun?: string }) {
  const [asking, setAsking] = useState(false);
  const ref = useRef(opts); ref.current = opts;
  const downOnBackdrop = useRef(false);
  const requestClose = useCallback(() => {
    const o = ref.current;
    if (o.busy || o.dirty) setAsking(true); else o.onClose();
  }, []);
  const backdrop = {
    onMouseDown: (e: ReactMouseEvent) => { downOnBackdrop.current = e.target === e.currentTarget; },
    onClick: (e: ReactMouseEvent) => {
      const ok = downOnBackdrop.current && e.target === e.currentTarget;
      downOnBackdrop.current = false;
      if (ok) requestClose();
    },
  };
  /** For useBackToClose's `holdBack`: Back asks too instead of closing. */
  const holdBack = useCallback(() => {
    const o = ref.current;
    if (o.busy || o.dirty) { setAsking(true); return true; }
    return false;
  }, []);
  const prompt = asking ? (
    <CloseGuardPrompt what={opts.what} noun={opts.noun} busy={!!opts.busy}
      onKeep={() => setAsking(false)}
      onDiscard={() => { setAsking(false); ref.current.onClose(); }} />
  ) : null;
  return { requestClose, holdBack, backdrop, prompt, asking };
}

const CG_CSS = `
.cg-back{position:fixed;inset:0;z-index:10050;display:grid;place-items:center;padding:16px;background:rgba(6,26,19,.42);backdrop-filter:blur(3px);animation:cg-fade .18s ease}
.cg{position:relative;width:min(420px,100%);padding:26px 26px 20px;border-radius:22px;background:#fff;box-shadow:0 30px 70px -30px rgba(6,26,19,.65),0 0 0 1px rgba(10,111,77,.08);font-family:inherit;color:#0b241a;animation:cg-pop .26s cubic-bezier(.16,1,.3,1)}
.cg-ico{display:grid;place-items:center;width:46px;height:46px;margin-bottom:14px;border-radius:14px;background:#fff4e2;color:#c27a12}
.cg-ico.is-busy{background:#e8f6ef;color:#0a6f4d}
.cg-ico svg{width:22px;height:22px}
.cg h2{margin:0 0 6px;font-size:18px;font-weight:750;letter-spacing:-.01em}
.cg p{margin:0 0 20px;font-size:13.5px;line-height:1.5;color:#5a7d6d}
.cg-act{display:flex;justify-content:flex-end;gap:8px}
.cg-act button{height:40px;padding:0 18px;border-radius:12px;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;transition:background .15s,border-color .15s,transform .15s,box-shadow .15s}
.cg-keep{border:0;background:linear-gradient(120deg,#12b57f,#0a6f4d);color:#fff;box-shadow:0 10px 20px -12px rgba(10,111,77,.95)}
.cg-keep:hover{transform:translateY(-1px)}
.cg-keep:focus-visible{outline:3px solid rgba(18,181,127,.35);outline-offset:2px}
.cg-discard{border:1.5px solid rgba(184,69,47,.22);background:#fff;color:#b8452f}
.cg-discard:hover{background:#fdebe8;border-color:rgba(184,69,47,.45)}
@keyframes cg-fade{from{opacity:0}}
@keyframes cg-pop{from{opacity:0;transform:translateY(8px) scale(.97)}}
`;

function CloseGuardPrompt({ what, noun, busy, onKeep, onDiscard }: { what: "import" | "export"; noun?: string; busy: boolean; onKeep: () => void; onDiscard: () => void }) {
  // Escape here only closes this question (back to the import / export), never the modal behind it.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); onKeep(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onKeep]);
  const thing = noun ?? (what === "import" ? "import" : "export");
  const title = busy ? `The ${thing} is still running` : what === "import" ? `Discard this ${thing}?` : `Close the ${thing}?`;
  const sub = busy
    ? `Closing now would stop it halfway. Wait until it finishes — it only takes a moment.`
    : what === "import"
      ? "The file, the column mapping and everything you've set up here will be lost."
      : "The rows, conditions and columns you've set up here won't be kept unless you save the export.";
  return createPortal(
    <div className="cg-back" onMouseDown={(e) => { if (e.target === e.currentTarget) e.stopPropagation(); }} onClick={(e) => { if (e.target === e.currentTarget) onKeep(); }}>
      <style>{CG_CSS}</style>
      <div className="cg" role="alertdialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <span className={`cg-ico ${busy ? "is-busy" : ""}`}>
          {busy
            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>}
        </span>
        <h2>{title}</h2>
        <p>{sub}</p>
        <div className="cg-act">
          {!busy && <button type="button" className="cg-discard" onClick={onDiscard}>Discard</button>}
          <button type="button" className="cg-keep" onClick={onKeep} autoFocus>Keep working</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
