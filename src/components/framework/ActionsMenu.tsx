import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
}

/**
 * One header button that holds the page's actions (new record, import, export,
 * fields…). The menu is portalled to <body>, closes on outside click / Esc,
 * follows the arrow keys and each item's shortcut key, and a highlight slides
 * to whichever item you point at.
 */
export default function ActionsMenu({ items, label = "Actions" }: { items: ActionItem[]; label?: string }) {
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
    const re = () => place();
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
      <button ref={btnRef} type="button" className={`am-btn ${open ? "is-open" : ""}`} onClick={() => (open ? close() : setOpen(true))} aria-haspopup="menu" aria-expanded={open}>
        <span className="am-btn-grid" aria-hidden="true"><i /><i /><i /><i /></span>
        {label}
        <svg className="am-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
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