import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * BASE · Calendar: no scrollbars. Every list that scrolls inside `root` (the to-do, the marketing
 * calendar, the week grid…) fades at the edge where there's more, and the tall ones get a "More ↓"
 * pill that scrolls them on. Works on whatever is inside, so the to-do and the marketing view need no changes.
 */
type Hint = { id: number; x: number; y: number; el: HTMLElement };

const BIG = 160;   // lists at least this tall get the pill; smaller ones only fade
const isScroller = (el: HTMLElement) => {
  const oy = getComputedStyle(el).overflowY;
  return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 2;
};
const hidden = (el: HTMLElement) => !!el.closest("[inert], [aria-hidden='true']") || el.offsetParent === null;

export default function ScrollHints({ root }: { root: HTMLElement | null }) {
  const [hints, setHints] = useState<Hint[]>([]);

  useEffect(() => {
    if (!root) return;
    let list: HTMLElement[] = [];
    let raf = 0, scanT = 0;
    const ids = new WeakMap<HTMLElement, number>(); let next = 1;

    const paint = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const out: Hint[] = [];
        for (const el of list) {
          if (!el.isConnected) continue;
          const up = el.scrollTop > 2;
          const down = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
          const v = `${up ? "up" : ""} ${down ? "down" : ""}`.trim();
          if ((el.getAttribute("data-sh") ?? "") !== v) { if (v) el.setAttribute("data-sh", v); else el.removeAttribute("data-sh"); }
          if (!down || el.clientHeight < BIG || hidden(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.bottom < 0 || r.top > innerHeight) continue;
          if (!ids.has(el)) ids.set(el, next++);
          out.push({ id: ids.get(el)!, x: r.left + r.width / 2, y: Math.min(r.bottom, innerHeight) - 12, el });
        }
        setHints((h) => (h.length === out.length && h.every((a, i) => a.id === out[i].id && Math.abs(a.x - out[i].x) < 1 && Math.abs(a.y - out[i].y) < 1) ? h : out));
      });
    };
    const scan = () => {
      window.clearTimeout(scanT);
      scanT = window.setTimeout(() => {
        const found: HTMLElement[] = [];
        root.querySelectorAll<HTMLElement>("div, main, section, aside, ul, ol").forEach((el) => { if (isScroller(el)) found.push(el); });
        list.forEach((el) => { if (!found.includes(el)) el.removeAttribute("data-sh"); });
        list = found; paint();
      }, 180);
    };

    scan();
    const mo = new MutationObserver(scan);
    mo.observe(root, { childList: true, subtree: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scan) : null;
    ro?.observe(root);
    const onScroll = () => paint();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", scan);
    root.addEventListener("transitionend", scan);
    return () => {
      mo.disconnect(); ro?.disconnect(); cancelAnimationFrame(raf); window.clearTimeout(scanT);
      window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", scan);
      root.removeEventListener("transitionend", scan);
      list.forEach((el) => el.removeAttribute("data-sh"));
    };
  }, [root]);

  if (!hints.length) return null;
  return createPortal(
    <>
      {hints.map((h) => (
        <button key={h.id} type="button" className="cal-more" style={{ left: h.x, top: h.y }}
          onClick={() => h.el.scrollBy({ top: Math.round(h.el.clientHeight * 0.75), behavior: "smooth" })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>More
        </button>
      ))}
    </>,
    document.body,
  );
}
