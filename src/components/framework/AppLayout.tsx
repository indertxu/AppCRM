import { useEffect, useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import Dock from "./Dock";
import { supabase } from "../api/supabase";
import { useAuth } from "../api/AuthProvider";
import { DOCK_LABELS_KEY, DOCK_LABELS_EVENT } from "../pages/settings/SettingsPage";
import { PageAccessProvider } from "./pageAccess";
import "./AppLayout.css";

/** The app: a fixed sidebar rail on the left, always there, and the page to its right. */
export default function AppLayout() {
  const { session } = useAuth();
  const uid = session?.user?.id ?? null;

  // "Always show menu labels" (Settings › Interface): a slightly wider rail with names under the icons.
  // localStorage is a fast cache to avoid a flash; the profile is the source of truth.
  const [labels, setLabels] = useState<boolean>(() => { try { return localStorage.getItem(DOCK_LABELS_KEY) === "true"; } catch { return false; } });
  useEffect(() => {
    const onLabels = (e: Event) => setLabels((e as CustomEvent<boolean>).detail);
    window.addEventListener(DOCK_LABELS_EVENT, onLabels);
    return () => window.removeEventListener(DOCK_LABELS_EVENT, onLabels);
  }, []);
  useEffect(() => {
    if (!uid) return;
    supabase.from("profiles").select("dock_labels").eq("id", uid).maybeSingle().then(({ data }) => {
      if (data && typeof (data as any).dock_labels === "boolean") {
        setLabels((data as any).dock_labels);
        try { localStorage.setItem(DOCK_LABELS_KEY, String((data as any).dock_labels)); } catch { /* ignore */ }
      }
    });
  }, [uid]);

  return (
    <PageAccessProvider>
      <div className={`app-shell ${labels ? "rail-labels" : ""}`}>
        <Dock />
        <div className="app-page">
          <Outlet />
        </div>
      </div>
    </PageAccessProvider>
  );
}

/* ===========================================================================
   The shared page loader: the Next cube, drawn as real vector geometry (each
   face is flat 40×40 artwork mapped onto the projected face with an affine
   matrix — no bitmaps, no CSS 3D, no filters on the drawing, so it stays sharp
   at any size). It assembles face by face, the chart line draws on the top
   face, the bars rise on the right one, then it keeps breathing while the page
   loads. Around it: a soft orbit, a few particles, a shimmer bar and rotating
   status lines. Reduced motion: the finished cube, still.
   =========================================================================== */
type PV3 = [number, number, number];
type PFace = "top" | "left" | "right";
const PC_GEO: Record<PFace, { n: PV3; u: PV3; v: PV3 }> = {
  top: { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  left: { n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
  right: { n: [1, 0, 0], u: [0, 0, -1], v: [0, -1, 0] },
};
const PC_FACES: PFace[] = ["top", "left", "right"];
const PC_YAW = -45, PC_PITCH = 30;
const PC_LIGHT: PV3 = (() => { const l: PV3 = [-0.35, 0.85, 0.55]; const m = Math.hypot(...l); return [l[0] / m, l[1] / m, l[2] / m]; })();
const pcRad = (d: number) => (d * Math.PI) / 180;
const pcRot = (p: PV3, yaw: number, pitch: number): PV3 => {
  const cy = Math.cos(pcRad(yaw)), sy = Math.sin(pcRad(yaw)), cp = Math.cos(pcRad(pitch)), sp = Math.sin(pcRad(pitch));
  const x = p[0] * cy + p[2] * sy, z0 = -p[0] * sy + p[2] * cy;
  return [x, p[1] * cp - z0 * sp, p[1] * sp + z0 * cp];
};
const pcDot = (a: PV3, b: PV3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const PC_REST = Object.fromEntries(PC_FACES.map((k) => [k, pcDot(pcRot(PC_GEO[k].n, PC_YAW, PC_PITCH), PC_LIGHT)])) as Record<PFace, number>;
const pcClamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const pcBack = (t: number) => { const c1 = 1.7, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const pcOut = (t: number) => 1 - Math.pow(1 - t, 3);
const pcStill = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const PC_BARS = [{ x: 6.3, y: 24, h: 11 }, { x: 16.8, y: 16, h: 19 }, { x: 27.4, y: 8, h: 27 }];
const PC_R = 50; // half the edge in viewBox units (viewBox is 240 wide)

/** The Next cube, crisp at any size, assembling and breathing. */
export function PageCube({ size = 132, loop = true }: { size?: number; loop?: boolean }) {
  const faceRefs = useRef<Partial<Record<PFace, SVGGElement | null>>>({});
  const shadeRefs = useRef<Partial<Record<PFace, SVGRectElement | null>>>({});
  const lineRef = useRef<SVGPolylineElement>(null);
  const arrowRef = useRef<SVGPolygonElement>(null);
  const barRefs = useRef<(SVGRectElement | null)[]>([]);
  const nRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const still = pcStill();
    const t0 = performance.now();
    let raf = 0, alive = true;
    const CYCLE = 3200; // after the intro, one "breath" every cycle: faces part a little, the chart redraws, the bars rise again
    const draw = (now: number) => {
      const t = still ? 99999 : now - t0;
      const idle = still ? 0 : t / 1000;
      const yaw = PC_YAW + (still ? 0 : Math.sin(idle * 1.1) * 9);
      const pitch = PC_PITCH + (still ? 0 : Math.sin(idle * 0.8 + 1) * 3);
      // after the intro, the breathing cycle
      const cyc = !still && loop && t > 1900 ? ((t - 1900) % CYCLE) / CYCLE : -1;
      const breath = cyc >= 0 ? Math.pow(Math.sin(Math.min(1, cyc / 0.32) * Math.PI), 2) * 0.16 : 0;
      for (const f of PC_FACES) {
        const g = faceRefs.current[f];
        if (!g) continue;
        const geo = PC_GEO[f];
        const delay = f === "top" ? 0 : f === "left" ? 170 : 340;
        const p = still ? 1 : pcClamp((t - delay) / 720, 0, 1);
        const ex = (1 - pcBack(p)) * 2.4 + breath;
        const n = pcRot(geo.n, yaw, pitch), u = pcRot(geo.u, yaw, pitch), v = pcRot(geo.v, yaw, pitch);
        const c: PV3 = [n[0] * (1 + ex), n[1] * (1 + ex), n[2] * (1 + ex)];
        const ox = (c[0] - u[0] - v[0]) * PC_R, oy = -(c[1] - u[1] - v[1]) * PC_R;
        const a = (u[0] * PC_R) / 20, b = (-u[1] * PC_R) / 20, cc = (v[0] * PC_R) / 20, dd = (-v[1] * PC_R) / 20;
        g.setAttribute("transform", `matrix(${a.toFixed(4)} ${b.toFixed(4)} ${cc.toFixed(4)} ${dd.toFixed(4)} ${ox.toFixed(3)} ${oy.toFixed(3)})`);
        g.setAttribute("opacity", pcClamp(p * 2.2, 0, 1).toFixed(3));
        const sh = shadeRefs.current[f];
        if (sh) {
          const lum = (pcDot(n, PC_LIGHT) - PC_REST[f]) * 0.55 + breath * 0.5;
          sh.setAttribute("fill", lum >= 0 ? "#ffffff" : "#021a10");
          sh.setAttribute("opacity", Math.min(lum >= 0 ? 0.24 : 0.45, Math.abs(lum)).toFixed(3));
        }
      }
      // the chart line draws itself (first at 0.75s, then at the start of every breath)
      const lineT = cyc >= 0 ? pcClamp(cyc / 0.3, 0, 1) : pcClamp((t - 750) / 650, 0, 1);
      const lineP = still ? 1 : pcOut(lineT);
      lineRef.current?.setAttribute("stroke-dashoffset", (1 - lineP).toFixed(4));
      const arrowP = still ? 1 : cyc >= 0 ? pcClamp((cyc - 0.24) / 0.12, 0, 1) : pcClamp((t - 1300) / 380, 0, 1);
      const as = arrowP > 0 ? pcBack(arrowP) : 0;
      arrowRef.current?.setAttribute("transform", `translate(34.8 8.6) scale(${as.toFixed(3)}) translate(-34.8 -8.6)`);
      // the N fades in with the left face
      nRef.current?.setAttribute("opacity", (still ? 1 : pcClamp((t - 560) / 400, 0, 1)).toFixed(3));
      // the bars rise one after the other
      PC_BARS.forEach((bar, i) => {
        const el = barRefs.current[i];
        if (!el) return;
        const bt = cyc >= 0 ? pcClamp((cyc - 0.06 - i * 0.07) / 0.2, 0, 1) : pcClamp((t - 1000 - i * 130) / 520, 0, 1);
        const k = still ? 1 : bt <= 0 ? 0.08 : pcBack(bt);
        const h = Math.max(0.6, bar.h * k);
        el.setAttribute("y", (bar.y + bar.h - h).toFixed(3));
        el.setAttribute("height", h.toFixed(3));
      });
      if (alive && !still && !document.hidden) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const onVis = () => { cancelAnimationFrame(raf); if (!document.hidden && alive) raf = requestAnimationFrame(draw); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVis); };
  }, [loop]);

  const face = (f: PFace, fill: string, art: React.ReactNode) => (
    <g ref={(el) => { faceRefs.current[f] = el; }} opacity="0">
      <rect width="40" height="40" rx="2.6" fill={fill} />
      <rect width="40" height="40" rx="2.6" fill={`url(#pgl-gloss-${f === "top" ? "top" : "side"})`} />
      {art}
      <rect ref={(el) => { shadeRefs.current[f] = el; }} width="40" height="40" rx="2.6" fill="#ffffff" opacity="0" />
      <rect x="0.4" y="0.4" width="39.2" height="39.2" rx="2.3" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </g>
  );

  return (
    <svg className="pgl-cube" width={size} height={size} viewBox="-120 -120 240 240" shapeRendering="geometricPrecision" aria-hidden="true">
      <defs>
        <linearGradient id="pgl-gloss-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#0a6f4d" stopOpacity="0.12" />
        </linearGradient>
        <linearGradient id="pgl-gloss-side" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.2" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.16" />
        </linearGradient>
      </defs>
      {face("top", "#86efc0", <>
        <polyline ref={lineRef} points="7.4,31.6 15.8,20 23.2,25.3 33.4,10.6" fill="none" stroke="#0a6f4d" strokeWidth="3.7" strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1" strokeDashoffset="1" />
        <polygon ref={arrowRef} points="37.9,4.2 36.9,13.2 29.7,8.1" fill="#0a6f4d" transform="translate(34.8 8.6) scale(0) translate(-34.8 -8.6)" />
      </>)}
      {face("left", "#12b57f", <path ref={nRef} d="M11 31V9h5.6l6.8 12.8V9H29v22h-5.6l-6.8-12.8V31z" fill="#ffffff" opacity="0" />)}
      {face("right", "#0a6f4d", <>
        {PC_BARS.map((b, i) => <rect key={i} ref={(el) => { barRefs.current[i] = el; }} x={b.x} y={b.y + b.h - 0.6} width="6.3" height="0.6" rx="1.6" fill="#ffffff" />)}
      </>)}
    </svg>
  );
}

const PGL_LINES = ["Fetching the latest data", "Lining everything up", "Crunching the numbers", "Almost there"];

/** The app's shared page loader (every page shows this while its data loads).
 *  `label` = what is loading ("Loading clients…"); `fill` = take the whole page area;
 *  `tone` = "dark" on a dark hero / dark overlay. */
export function PageLoader({ label = "Loading…", fill = true, tone = "light", size }: { label?: string; fill?: boolean; tone?: "light" | "dark"; size?: number }) {
  const [line, setLine] = useState(0);
  useEffect(() => {
    if (pcStill()) return;
    const id = window.setInterval(() => setLine((i) => (i + 1) % PGL_LINES.length), 1700);
    return () => window.clearInterval(id);
  }, []);
  const s = size ?? (fill ? 132 : 96);
  return (
    <div className={`pgl ${fill ? "is-fill" : ""} is-${tone}`} role="status" aria-live="polite" aria-label={label}>
      <div className="pgl-stage" style={{ width: s * 1.9, height: s * 1.9 }}>
        <span className="pgl-glow" aria-hidden="true" />
        <svg className="pgl-orbit" viewBox="0 0 200 200" aria-hidden="true">
          <circle className="pgl-orbit-track" cx="100" cy="100" r="92" />
          <circle className="pgl-orbit-arc" cx="100" cy="100" r="92" pathLength={100} />
        </svg>
        <span className="pgl-dots" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span className="pgl-cube-pos"><PageCube size={s} /></span>
      </div>
      <div className="pgl-text">
        <span className="pgl-label">{label}</span>
        <span className="pgl-sub" aria-hidden="true"><span key={line} className="pgl-sub-in">{PGL_LINES[line]}…</span></span>
        <span className="pgl-bar" aria-hidden="true"><i /></span>
      </div>
    </div>
  );
}

/** The loader as a cover over the page area (right of the rail) while a page's first data loads;
 *  it fades away once `show` turns false. */
export function PageCover({ show, label }: { show: boolean; label?: string }) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) { setMounted(true); return; }
    const id = window.setTimeout(() => setMounted(false), pcStill() ? 0 : 520);
    return () => window.clearTimeout(id);
  }, [show]);
  if (!mounted) return null;
  return (
    <div className={`pgl-cover ${show ? "" : "is-out"}`}>
      <PageLoader label={label} />
    </div>
  );
}
