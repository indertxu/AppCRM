import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import "./ActionsMenu.css";

export interface ActionItem {
  key: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  onSelect: () => void;
  /** Highlighted as the main action. */
  primary?: boolean;
  /** Section heading the item sits under ("Create", "Data", "Setup"…). */
  group?: string;
  /** Single key that runs the item while the menu is open (shown as a chip). */
  shortcut?: string;
  /** Colour of the icon tile. */
  tone?: "green" | "blue" | "amber" | "violet" | "slate";
  /** This page's own way to make a deal / contact / company: it takes that slot in "Quick create". */
  quick?: QuickKind;
}
export type QuickKind = "deal" | "contact" | "company";

/** Every Actions menu starts with these: a new deal, contact or company from anywhere. */
const QUICK: { kind: QuickKind; label: string; hint: string; shortcut: string; tone: ActionItem["tone"]; path: string; icon: ReactNode }[] = [
  { kind: "deal", label: "New deal", hint: "Open a deal with a company or contact", shortcut: "D", tone: "green", path: "/sales?new=1",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8M15 7h6v6" /></svg> },
  { kind: "contact", label: "New contact", hint: "Add a person", shortcut: "P", tone: "blue", path: "/contacts?new=1",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6" /></svg> },
  { kind: "company", label: "New company", hint: "Add an account or a prospect", shortcut: "O", tone: "violet", path: "/companies?new=1",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M16 9h3a2 2 0 0 1 2 2v10M9 7h3M9 11h3M9 15h3" /></svg> },
];

/**
 * One header button that holds the page's actions (new record, import, export,
 * fields…). The menu is portalled to <body>, closes on outside click / Esc,
 * follows the arrow keys and each item's shortcut key, and a highlight slides
 * to whichever item you point at.
 */
export default function ActionsMenu({ items: pageItems, label = "Actions", quick = true }: {
  items: ActionItem[]; label?: string;
  /** Show the "Quick create" group (new deal / contact / company) on top. On by default everywhere. */
  quick?: boolean;
}) {
  const navigate = useNavigate();
  // "Quick create" first (the page's own creator takes its slot), then the page's own actions as they were
  const items: ActionItem[] = quick ? [
    ...QUICK.map((q) => {
      const own = pageItems.find((i) => i.quick === q.kind);
      return own ? { ...own, group: "Quick create" } : { key: `q-${q.kind}`, group: "Quick create", label: q.label, hint: q.hint, icon: q.icon, tone: q.tone, shortcut: q.shortcut, onSelect: () => navigate(q.path) };
    }),
    ...pageItems.filter((i) => !i.quick),
  ] : pageItems;
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [active, setActive] = useState(0);
  const [hi, setHi] = useState<{ top: number; height: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 10, right: Math.max(8, window.innerWidth - r.right) });
  };
  const close = () => { setClosing(true); window.setTimeout(() => { setOpen(false); setClosing(false); }, 160); };
  const run = (it: ActionItem) => { setOpen(false); setClosing(false); it.onSelect(); };

  useLayoutEffect(() => { if (open) { place(); setActive(Math.max(0, items.findIndex((i) => i.primary))); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // move the sliding highlight to the active item
  useLayoutEffect(() => {
    // offsetTop is relative to the menu (sections aren't positioned) and ignores the opening scale
    const el = itemRefs.current[active];
    if (open && el) setHi({ top: el.offsetTop, height: el.offsetHeight });
  }, [active, open, pos, items.length]);

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(); btnRef.current?.focus(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % items.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return; }
      if (e.key === "Enter") { e.preventDefault(); const it = items[active]; if (it) run(it); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = items.find((i) => i.shortcut && i.shortcut.toLowerCase() === e.key.toLowerCase());
      if (hit) { e.preventDefault(); run(hit); }
    };
    // scrolling inside the menu itself must not move (or re-measure) it: that threw the list back to the top
    const re = (e?: Event) => { if (e && menuRef.current?.contains(e.target as Node)) return; place(); };
    window.addEventListener("mousedown", off, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", re);
    window.addEventListener("scroll", re, true);
    return () => {
      window.removeEventListener("mousedown", off, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", re);
      window.removeEventListener("scroll", re, true);
    };
  }, [open, active, items]); // eslint-disable-line react-hooks/exhaustive-deps

  // items in their sections, keeping the original order
  const sections: { title?: string; list: { it: ActionItem; idx: number }[] }[] = [];
  items.forEach((it, idx) => {
    const last = sections[sections.length - 1];
    if (last && last.title === it.group) last.list.push({ it, idx });
    else sections.push({ title: it.group, list: [{ it, idx }] });
  });

  return (
    <>
      {/* compact: just the icon; pointing at it (or opening it) slides the label out to the left, over its neighbours */}
      <span className={`am-wrap ${open ? "is-open" : ""}`}>
        <button ref={btnRef} type="button" className={`am-btn ${open ? "is-open" : ""}`} onClick={() => (open ? close() : setOpen(true))} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label}>
          <span className="am-btn-grid" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="am-btn-l" aria-hidden="true">{label}</span>
        </button>
      </span>
      {open && pos && createPortal(
        <div ref={menuRef} className={`am-menu ${closing ? "is-closing" : ""}`} role="menu" style={{ top: pos.top, right: pos.right }} onMouseDown={(e) => e.stopPropagation()}>
          {hi && <span className="am-hi" style={{ transform: `translateY(${hi.top}px)`, height: hi.height }} aria-hidden="true" />}
          {sections.map((sec, si) => (
            <div className="am-sec" key={si}>
              {sec.title && <span className="am-sec-t">{sec.title}</span>}
              {sec.list.map(({ it, idx }) => (
                <button key={it.key} ref={(el) => { itemRefs.current[idx] = el; }} type="button" role="menuitem"
                  className={`am-item tone-${it.tone ?? (it.primary ? "green" : "slate")} ${idx === active ? "is-active" : ""}`}
                  style={{ ["--i" as string]: idx } as CSSProperties}
                  onMouseEnter={() => setActive(idx)} onFocus={() => setActive(idx)}
                  onClick={() => run(it)}>
                  <span className="am-ico">{it.icon}</span>
                  <span className="am-txt"><b>{it.label}</b>{it.hint && <em>{it.hint}</em>}</span>
                  {it.shortcut && <kbd className="am-kbd">{it.shortcut.toUpperCase()}</kbd>}
                </button>
              ))}
            </div>
          ))}
          <div className="am-foot" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>↵</kbd> to open · <kbd>Esc</kbd> to close</div>
        </div>,
        document.body,
      )}
    </>
  );
}

/* Icons used by the Contacts / Companies menus */
export const AM_ICON = {
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  import: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>,
  export: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3M7 8l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>,
  fields: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h10M4 18h7M17 15l2 2 3-4" /></svg>,
};