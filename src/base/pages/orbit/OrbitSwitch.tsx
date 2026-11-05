import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { OrbitView } from "./orbitTypes";
import { useOrbitView } from "./orbitContext";
import "./Orbit.css";

/** Where the pointer is: a switch "left" only because the next view came on top of it isn't really left. */
const pointer = { x: -1, y: -1 };
if (typeof window !== "undefined") window.addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });
const overSwitch = () => pointer.x >= 0 && !!document.elementFromPoint(pointer.x, pointer.y)?.closest(".ob-pane.is-on .ob-title");

const LABEL: Record<OrbitView, string> = { all: "All", contacts: "Contacts", companies: "Companies", clients: "Clients" };
const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const ICON: Record<OrbitView, ReactNode> = {
  // the same orbit as the dock's: a solid centre, a round orbit and a satellite in its gap
  all: svg(<><circle cx="12" cy="12" r="3.1" fill="currentColor" stroke="none" /><path d="M19.7 8.41A8.5 8.5 0 1 1 14.2 3.79" /><circle cx="17.46" cy="5.49" r="1.9" fill="currentColor" stroke="none" /></>),
  contacts: svg(<path d="M19 20.5v-1.6a3.9 3.9 0 0 0-3.9-3.9H8.9A3.9 3.9 0 0 0 5 18.9v1.6M12 11.6a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6" />),
  companies: svg(<path d="M3.5 20.5h17M5.5 20.5V5.3a1.8 1.8 0 0 1 1.8-1.8h6.4a1.8 1.8 0 0 1 1.8 1.8v15.2M15.5 9.5h3a1.8 1.8 0 0 1 1.8 1.8v9.2M9 7.6h2.5M9 11.2h2.5M9 14.8h2.5" />),
  clients: svg(<path d="M12 3.6l2.5 5.1 5.6.8-4.05 4 .95 5.6L12 16.4l-5 2.7.95-5.6-4.05-4 5.6-.8z" />),
};

/**
 * BASE · Orbit's title: an icon per view (All · Contacts · Companies · Clients); point at it (or focus it) and
 * the names open out next to the icons. The light sits under the view you're on and glides to the next one.
 * Open / closed is Orbit's state (not :hover): the view that comes in shows its switch open like the one you clicked.
 * Every view has its own copy in its header; all of them follow Orbit's current view.
 */
export default function OrbitSwitch(_: { on?: OrbitView }) {
  const { view: on, views, go, navOpen, setNavOpen } = useOrbitView();
  const box = useRef<HTMLDivElement>(null);
  const light = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  /** Put the light under the current view (animated, or following the buttons while they open / close). */
  const place = (animate: boolean) => {
    const b = box.current?.querySelector<HTMLElement>("button.is-on");
    const l = light.current;
    if (!b || !l) return;
    l.style.transition = animate && placed.current ? "" : "none";
    l.style.transform = `translateX(${b.offsetLeft}px)`;
    l.style.width = `${b.offsetWidth}px`;
    placed.current = true;
  };
  useLayoutEffect(() => { place(true); }, [on, views.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (placed.current) follow(); }, [navOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Hover intent: opens after a short beat (passing over it doesn't fling it open), closes a moment after you leave. */
  const timer = useRef(0);
  const intend = (open: boolean) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNavOpen(open || overSwitch()), open ? 110 : 220);
  };
  /** The names open or close in ~0.6 s: the light follows the button frame by frame. */
  const raf = useRef(0);
  const follow = () => {
    cancelAnimationFrame(raf.current);
    const end = performance.now() + 760;
    const tick = () => { place(false); if (performance.now() < end) raf.current = requestAnimationFrame(tick); };
    raf.current = requestAnimationFrame(tick);
  };
  return (
    <div className="ob-nav">
      <div ref={box} className={`ob-title ${navOpen ? "is-open" : ""}`} role="tablist" aria-label="Orbit views"
        onMouseEnter={() => intend(true)} onMouseLeave={() => intend(false)} onFocus={follow} onBlur={follow}>
        <span ref={light} className="ob-light" aria-hidden="true" />
        {views.map((v) => (
          <button key={v} type="button" role="tab" aria-selected={v === on} aria-label={LABEL[v]} title={LABEL[v]}
            className={v === on ? "is-on" : ""} onClick={() => go(v)}>
            {ICON[v]}
            <span className="ob-lbl">{LABEL[v]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
