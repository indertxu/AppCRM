/* BASE · Smooth — animates its own height whenever what's inside grows or
   shrinks (a row opening into a card, a list unfolding). Used by Products &
   Services. Overflow is only clipped while it moves, so shadows stay. */
import { useLayoutEffect, useRef, type ReactNode } from "react";

export default function Smooth({ children, className = "" }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current, el = inner.current;
    if (!o || !el || typeof ResizeObserver === "undefined") return;
    let last = el.offsetHeight;
    o.style.height = `${last}px`;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const ro = new ResizeObserver(() => {
      const next = el.offsetHeight;
      if (next === last) return;
      last = next;
      if (!reduce) o.classList.add("is-moving");
      o.style.height = `${next}px`;
    });
    ro.observe(el);
    const end = (e: TransitionEvent) => { if (e.target === o && e.propertyName === "height") o.classList.remove("is-moving"); };
    o.addEventListener("transitionend", end);
    return () => { ro.disconnect(); o.removeEventListener("transitionend", end); o.style.height = ""; };
  }, []);
  return (
    <div ref={outer} className={`bc-smooth ${className}`}>
      <div ref={inner} className="bc-smooth-in">{children}</div>
    </div>
  );
}
