import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { supabase, setRememberMe } from "../api/supabase";
import { PageCube } from "../framework/AppLayout";
import "./LoginPage.css";

/** Set right before leaving for the app: the home page plays its arrival sequence once. */
export const JUST_SIGNED_IN_KEY = "next:just-signed-in";

/**
 * From "Sign in" until the launch hands over to the app. The moment the session
 * exists, /login would redirect on its own and cut the launch half-way (a see-through
 * green screen, and a second navigation 1.5 s later that pulled you back to Home if
 * you had clicked somewhere). While this is set, /login keeps the sign-in page up.
 */
let launchHold = 0;
export const loginLaunching = () => launchHold > 0 && Date.now() - launchHold < 15000;

interface Ripple { id: number; x: number; y: number }

const reducedMotion = () => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

/* ---------------------------------------------------------------------------
   The Next cube as a flat logo (card badge, launch screen): the classic
   isometric drawing, all vector — the N is a path, not a font.
   --------------------------------------------------------------------------- */
export function NextCube({ className = "" }: { className?: string }) {
  return (
    <svg className={`nx-cube ${className}`} viewBox="14 15 92 93" role="img" aria-label="Next" shapeRendering="geometricPrecision">
      <g className="nx-face nx-face-top">
        <g transform="matrix(1,0.5,-1,0.5,60,17)">
          <rect width="38" height="38" rx="2" fill="#86efc0" />
          <polyline className="nx-line" points="7,30 15,19 22,24 31.7,10.1" fill="none" stroke="#0a6f4d" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
          <polygon className="nx-arrow" points="36,4 35.1,12.5 28.2,7.7" fill="#0a6f4d" />
        </g>
      </g>
      <g className="nx-face nx-face-left">
        <g transform="translate(16,47) skewY(26.565)">
          <rect width="38" height="40" rx="2" fill="#12b57f" />
          <path className="nx-n" d="M10.5 31V10h5.1l6.8 12.6V10h5.1v21h-5.1l-6.8-12.6V31z" fill="#ffffff" />
        </g>
      </g>
      <g className="nx-face nx-face-right">
        <g transform="translate(66,66) skewY(-26.565)">
          <rect width="38" height="40" rx="2" fill="#0a6f4d" />
          <rect className="nx-bar nx-bar-1" x="6" y="24" width="6" height="11" rx="1.5" fill="#ffffff" />
          <rect className="nx-bar nx-bar-2" x="16" y="16" width="6" height="19" rx="1.5" fill="#ffffff" />
          <rect className="nx-bar nx-bar-3" x="26" y="8" width="6" height="27" rx="1.5" fill="#ffffff" />
        </g>
      </g>
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   The hero cube: a real 3D cube drawn in vector. Each face is flat artwork
   (40×40 units) mapped onto the projected face with an affine matrix, so it
   stays razor-sharp at any size and any angle — no bitmaps, no CSS 3D, no
   filters on the drawing. Faces are lit from the top-left, explode apart on
   hover, follow the pointer and spin on click.
   --------------------------------------------------------------------------- */
type V3 = [number, number, number];
type FaceKey = "top" | "left" | "right" | "bottom" | "back" | "side";
const FACE_GEO: Record<FaceKey, { n: V3; u: V3; v: V3 }> = {
  top: { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  left: { n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
  right: { n: [1, 0, 0], u: [0, 0, -1], v: [0, -1, 0] },
  bottom: { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  back: { n: [0, 0, -1], u: [-1, 0, 0], v: [0, -1, 0] },
  side: { n: [-1, 0, 0], u: [0, 0, 1], v: [0, -1, 0] },
};
const FACE_KEYS = Object.keys(FACE_GEO) as FaceKey[];
const BASE_YAW = -45, BASE_PITCH = 30;
const LIGHT: V3 = (() => { const l: V3 = [-0.35, 0.85, 0.55]; const m = Math.hypot(...l); return [l[0] / m, l[1] / m, l[2] / m]; })();
const rad = (d: number) => (d * Math.PI) / 180;
function rotate(p: V3, yaw: number, pitch: number): V3 {
  const cy = Math.cos(rad(yaw)), sy = Math.sin(rad(yaw)), cp = Math.cos(rad(pitch)), sp = Math.sin(rad(pitch));
  const x = p[0] * cy + p[2] * sy, z0 = -p[0] * sy + p[2] * cy;
  return [x, p[1] * cp - z0 * sp, p[1] * sp + z0 * cp];
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** how lit each face is in the resting pose: shading is applied relative to it, so at rest the brand colours are exact */
const REST_LIGHT = Object.fromEntries(FACE_KEYS.map((k) => [k, dot(rotate(FACE_GEO[k].n, BASE_YAW, BASE_PITCH), LIGHT)])) as Record<FaceKey, number>;

const easeOutBack = (t: number) => { const c1 = 1.56, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export type CubeFocus = "top" | "left" | "right" | "all" | null;
interface CubeRig {
  hover: boolean;
  hx: number; hy: number;     // pointer relative to the cube centre (-1..1 roughly)
  spinAt: number;             // performance.now() of the last click
  focus: CubeFocus;           // a chip is hovered: light up its face
  launchAt: number;           // signed in: the cube bursts apart
}

const R = 66; // half the edge, in viewBox units (the viewBox is drawn 1:1 in CSS px at the default size)

function HeroCube({ rig, pointer }: { rig: React.MutableRefObject<CubeRig>; pointer: React.MutableRefObject<{ x: number; y: number; on: boolean }> }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const faceRefs = useRef<Partial<Record<FaceKey, SVGGElement | null>>>({});
  const shadeRefs = useRef<Partial<Record<FaceKey, SVGRectElement | null>>>({});
  const rootRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const still = reducedMotion();
    const t0 = performance.now();
    const cur = { yaw: BASE_YAW, pitch: BASE_PITCH, hov: 0, ex: 0, foc: { top: 0, left: 0, right: 0, bottom: 0, back: 0, side: 0 } as Record<FaceKey, number> };
    const INTRO: Partial<Record<FaceKey, number>> = { top: 250, left: 420, right: 580 };
    let raf = 0, alive = true, last = t0;
    const host = svgRef.current?.parentElement ?? null;

    const draw = (now: number) => {
      const dt = Math.min(64, now - last) / 16.67; last = now;
      const r = rig.current;
      const k = (s: number) => 1 - Math.pow(1 - s, dt); // frame-rate independent smoothing

      // where the cube looks
      let tYaw = BASE_YAW, tPitch = BASE_PITCH;
      if (!still) {
        const idle = now / 1000;
        if (r.hover) { tYaw += clamp(r.hx, -1.4, 1.4) * 30; tPitch += clamp(r.hy, -1.4, 1.4) * 18; }
        else if (pointer.current.on) {
          const px = (pointer.current.x / window.innerWidth - 0.5) * 2, py = (pointer.current.y / window.innerHeight - 0.5) * 2;
          tYaw += px * 14 + Math.sin(idle / 2.6) * 3; tPitch += py * 8 + Math.sin(idle / 3.3) * 2;
        } else { tYaw += Math.sin(idle / 2.6) * 7; tPitch += Math.sin(idle / 3.3) * 3; }
      }
      tPitch = clamp(tPitch, 10, 52);
      cur.yaw += (tYaw - cur.yaw) * k(0.09);
      cur.pitch += (tPitch - cur.pitch) * k(0.09);
      cur.hov += ((r.hover ? 1 : 0) - cur.hov) * k(0.14);
      for (const f of FACE_KEYS) {
        const want = r.focus === "all" ? 0.16 : r.focus === f ? 0.34 : 0;
        cur.foc[f] += (want - cur.foc[f]) * k(0.16);
      }

      // a click spins it once round, with a little pop
      let spin = 0, pop = 0;
      if (!still && r.spinAt) {
        const t = (now - r.spinAt) / 1100;
        if (t < 1) { spin = easeInOut(t) * 360; pop = Math.sin(t * Math.PI) * 0.12; } else r.spinAt = 0;
      }
      // signed in: the faces burst apart and fade
      let burst = 0;
      if (r.launchAt) burst = clamp((now - r.launchAt) / 650, 0, 1);

      const yaw = cur.yaw + spin, pitch = cur.pitch;
      const scale = 1 + cur.hov * 0.1 + pop;
      const lift = -cur.hov * 12 + (still ? 0 : Math.sin(now / 950) * 4 * (1 - cur.hov));
      rootRef.current?.setAttribute("transform", `translate(0 ${lift.toFixed(2)}) scale(${scale.toFixed(4)})`);
      if (host) host.style.setProperty("--hov", cur.hov.toFixed(3));

      for (const f of FACE_KEYS) {
        const g = faceRefs.current[f];
        if (!g) continue;
        const geo = FACE_GEO[f];
        const n = rotate(geo.n, yaw, pitch);
        // intro: the three visible faces fly in one after the other
        let intro = 1;
        const d = INTRO[f];
        if (!still && d !== undefined) intro = clamp((now - t0 - d) / 900, 0, 1);
        else if (!still) intro = clamp((now - t0 - 600) / 600, 0, 1);
        const introEx = (1 - easeOutBack(intro)) * 2.6;
        const ex = cur.hov * 0.24 + cur.foc[f] + introEx + burst * 2.2;
        const facing = n[2];
        const op = clamp(facing * 9, 0, 1) * clamp(intro * 2.4, 0, 1) * (1 - burst);
        if (op <= 0.001) { g.setAttribute("visibility", "hidden"); continue; }
        g.setAttribute("visibility", "visible");
        g.setAttribute("opacity", op.toFixed(3));
        const u = rotate(geo.u, yaw, pitch), v = rotate(geo.v, yaw, pitch);
        const c: V3 = [n[0] * (1 + ex), n[1] * (1 + ex), n[2] * (1 + ex)];
        // origin = centre - u - v ; screen y goes down
        const ox = (c[0] - u[0] - v[0]) * R, oy = -(c[1] - u[1] - v[1]) * R;
        const a = (u[0] * R) / 20, b = (-u[1] * R) / 20, cc = (v[0] * R) / 20, dd = (-v[1] * R) / 20;
        g.setAttribute("transform", `matrix(${a.toFixed(4)} ${b.toFixed(4)} ${cc.toFixed(4)} ${dd.toFixed(4)} ${ox.toFixed(3)} ${oy.toFixed(3)})`);
        // light: brighter or darker than at rest, plus the hovered/focused face glows
        const shade = dot(n, LIGHT) - REST_LIGHT[f];
        const s = shadeRefs.current[f];
        if (s) {
          const glow = cur.foc[f] * 0.38 + cur.hov * 0.04;
          const lum = shade * 0.5 + glow;
          s.setAttribute("fill", lum >= 0 ? "#ffffff" : "#021a10");
          s.setAttribute("opacity", Math.min(lum >= 0 ? 0.22 : 0.5, Math.abs(lum)).toFixed(3));
        }
      }
      if (alive && !still && !document.hidden) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const onVis = () => { cancelAnimationFrame(raf); if (!document.hidden && !still) { last = performance.now(); raf = requestAnimationFrame(draw); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVis); };
  }, [rig, pointer]);

  const face = (f: FaceKey, fill: string, art: React.ReactNode) => (
    <g key={f} ref={(el) => { faceRefs.current[f] = el; }} className={`np3-face is-${f}`} visibility="hidden">
      <rect width="40" height="40" rx="2.4" fill={fill} />
      <rect width="40" height="40" rx="2.4" fill={`url(#np3-gloss-${f === "top" ? "top" : "side"})`} />
      {art}
      <rect ref={(el) => { shadeRefs.current[f] = el; }} width="40" height="40" rx="2.4" fill="#ffffff" opacity="0" />
      <rect x="0.4" y="0.4" width="39.2" height="39.2" rx="2.1" fill="none" stroke="rgba(255,255,255,0.32)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </g>
  );

  return (
    <svg ref={svgRef} className="np3-cube" viewBox="-170 -170 340 340" shapeRendering="geometricPrecision" aria-hidden="true">
      <defs>
        <linearGradient id="np3-gloss-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.38" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#0a6f4d" stopOpacity="0.12" />
        </linearGradient>
        <linearGradient id="np3-gloss-side" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.2" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.16" />
        </linearGradient>
      </defs>
      <g ref={rootRef}>
        {face("bottom", "#064a33", null)}
        {face("back", "#0e9466", <path d="M11 31V9h5.6l6.8 12.8V9H29v22h-5.6l-6.8-12.8V31z" fill="#ffffff" opacity="0.18" />)}
        {face("side", "#0b7f58", <g fill="#ffffff" opacity="0.18"><rect x="6.3" y="24" width="6.3" height="11" rx="1.6" /><rect x="16.8" y="16" width="6.3" height="19" rx="1.6" /><rect x="27.4" y="8" width="6.3" height="27" rx="1.6" /></g>)}
        {face("top", "#86efc0", <>
          <polyline className="nx-line" points="7.4,31.6 15.8,20 23.2,25.3 33.4,10.6" fill="none" stroke="#0a6f4d" strokeWidth="3.7" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
          <polygon className="nx-arrow" points="37.9,4.2 36.9,13.2 29.7,8.1" fill="#0a6f4d" />
        </>)}
        {face("left", "#12b57f", <path className="nx-n" d="M11 31V9h5.6l6.8 12.8V9H29v22h-5.6l-6.8-12.8V31z" fill="#ffffff" />)}
        {face("right", "#0a6f4d", <>
          <rect className="nx-bar nx-bar-1" x="6.3" y="24" width="6.3" height="11" rx="1.6" fill="#ffffff" />
          <rect className="nx-bar nx-bar-2" x="16.8" y="16" width="6.3" height="19" rx="1.6" fill="#ffffff" />
          <rect className="nx-bar nx-bar-3" x="27.4" y="8" width="6.3" height="27" rx="1.6" fill="#ffffff" />
        </>)}
      </g>
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   A constellation of data points behind everything: they drift, link up when
   close, and lean towards the pointer (which lights up its neighbourhood).
   Plain canvas 2D, ~40–90 points, paused when the tab is hidden.
   --------------------------------------------------------------------------- */
function useConstellation(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  pointer: React.MutableRefObject<{ x: number; y: number; on: boolean }>,
  burst: React.MutableRefObject<number>,
) {
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const still = reducedMotion();
    let w = 0, h = 0, dpr = 1, raf = 0, alive = true;
    type P = { x: number; y: number; vx: number; vy: number; r: number; tw: number };
    let pts: P[] = [];
    const seed = () => {
      const n = Math.round(Math.min(90, Math.max(36, (w * h) / 21000)));
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() * 1.4 + 0.6, tw: Math.random() * Math.PI * 2,
      }));
    };
    const size = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };
    const LINK = 130, REACH = 190;
    const frame = (t: number) => {
      if (!alive) return;
      ctx.clearRect(0, 0, w, h);
      const p = pointer.current;
      const b = burst.current; // 0..1 after a successful sign-in: the points rush outwards
      if (!still) {
        for (const a of pts) {
          a.x += a.vx; a.y += a.vy;
          if (p.on) {
            const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
            if (d < REACH && d > 1) { const f = (1 - d / REACH) * 0.35; a.x += (dx / d) * f; a.y += (dy / d) * f; }
          }
          if (b > 0) { a.x += (a.x - w / 2) * 0.03 * b; a.y += (a.y - h / 2) * 0.03 * b; }
          if (a.x < -20) a.x = w + 20; else if (a.x > w + 20) a.x = -20;
          if (a.y < -20) a.y = h + 20; else if (a.y > h + 20) a.y = -20;
        }
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        for (let j = i + 1; j < pts.length; j++) {
          const c = pts[j];
          const dx = a.x - c.x, dy = a.y - c.y;
          if (dx > LINK || dx < -LINK || dy > LINK || dy < -LINK) continue;
          const d = Math.hypot(dx, dy);
          if (d > LINK) continue;
          let al = (1 - d / LINK) * 0.2;
          if (p.on) {
            const md = Math.hypot((a.x + c.x) / 2 - p.x, (a.y + c.y) / 2 - p.y);
            if (md < REACH) al += (1 - md / REACH) * 0.45;
          }
          ctx.strokeStyle = `rgba(134, 239, 192, ${al.toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
        }
      }
      for (const a of pts) {
        const tw = still ? 0.7 : 0.55 + Math.sin(t / 900 + a.tw) * 0.35;
        let glow = 0;
        if (p.on) { const d = Math.hypot(p.x - a.x, p.y - a.y); if (d < REACH) glow = 1 - d / REACH; }
        ctx.fillStyle = glow > 0.2 ? `rgba(200, 255, 230, ${Math.min(1, 0.5 + glow * 0.5).toFixed(3)})` : `rgba(134, 239, 192, ${(tw * 0.75).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(a.x, a.y, a.r + glow * 1.6, 0, Math.PI * 2); ctx.fill();
      }
      if (!still && !document.hidden) raf = requestAnimationFrame(frame);
    };
    size();
    raf = requestAnimationFrame(frame);
    const onResize = () => { size(); if (still) requestAnimationFrame(frame); };
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !still) raf = requestAnimationFrame(frame);
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false; cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [canvasRef, pointer, burst]);
}

const CHIPS: { k: string; v: string; more: string; cls: string; face: CubeFocus; spark: string }[] = [
  { k: "Deals", v: "Pipeline in motion", more: "From first call to signed contract", cls: "is-a", face: "top", spark: "M0 20 L10 16 L20 18 L30 10 L40 12 L50 5 L60 2" },
  { k: "Projects", v: "Delivery on track", more: "Days, milestones and margins", cls: "is-b", face: "right", spark: "M0 18 L10 18 L20 13 L30 14 L40 9 L50 9 L60 4" },
  { k: "Clients", v: "Health & renewals", more: "Every account, one timeline", cls: "is-c", face: "left", spark: "M0 12 L10 9 L20 13 L30 8 L40 10 L50 6 L60 7" },
  { k: "Tickets", v: "Nothing slips", more: "Each request lands on a desk", cls: "is-d", face: "all", spark: "M0 4 L10 8 L20 6 L30 12 L40 13 L50 17 L60 19" },
];

/** A line of the headline, split into words and letters (decorative; the hero is aria-hidden). */
function Letters({ text, from = 0 }: { text: string; from?: number }) {
  let i = from;
  return (
    <>
      {text.split(" ").map((w, wi, all) => (
        <span key={wi} className="np-w">
          {Array.from(w).map((ch, ci) => <span key={ci} className="np-l" style={{ ["--i" as string]: i++, ["--j" as string]: ci } as React.CSSProperties}>{ch}</span>)}
          {wi < all.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  );
}

export default function LoginPage() {
  const navigate = useNavigate();
  const sceneRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbitRef = useRef<HTMLDivElement>(null);
  const cubeHitRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<SVGSVGElement>(null);
  const chipRefs = useRef<(HTMLDivElement | null)[]>([]);
  const emRef = useRef<HTMLElement>(null);
  const rafRef = useRef<number | null>(null);
  const rippleId = useRef(0);
  const pointer = useRef({ x: -9999, y: -9999, on: false });
  const burst = useRef(0);
  const rig = useRef<CubeRig>({ hover: false, hx: 0, hy: 0, spinAt: 0, focus: null, launchAt: 0 });

  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shaking, setShaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [remember, setRemember] = useState(false);
  const [caps, setCaps] = useState(false);
  const [activeChip, setActiveChip] = useState<number | null>(null);
  const [cubeHot, setCubeHot] = useState(false);
  const [spinKey, setSpinKey] = useState(0);
  // still on screen (the launch navigates only from here)
  const onScreen = useRef(true);
  useEffect(() => { onScreen.current = true; return () => { onScreen.current = false; }; }, []);

  useConstellation(canvasRef, pointer, burst);

  // Cursor tracking -> CSS custom properties (no re-render, runs on rAF)
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY, on: true };
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        const { innerWidth: w, innerHeight: h } = window;
        scene.style.setProperty("--mx", `${e.clientX}px`);
        scene.style.setProperty("--my", `${e.clientY}px`);
        scene.style.setProperty("--px", `${((e.clientX / w) - 0.5) * 2}`);
        scene.style.setProperty("--py", `${((e.clientY / h) - 0.5) * 2}`);
        scene.classList.add("has-pointer");
        // "One place." carries a light that follows the pointer
        const em = emRef.current;
        if (em) {
          const r = em.getBoundingClientRect();
          em.style.setProperty("--hx", `${(e.clientX - r.left).toFixed(0)}px`);
          em.style.setProperty("--hy", `${(e.clientY - r.top).toFixed(0)}px`);
        }
        rafRef.current = null;
      });
    };
    const onLeave = () => { pointer.current = { ...pointer.current, on: false }; scene.classList.remove("has-pointer"); };
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // The connector lines from each chip to the cube follow both as they float.
  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0, alive = true;
    const tick = () => {
      const orbit = orbitRef.current, svg = linesRef.current, hit = cubeHitRef.current;
      if (orbit && svg && hit && orbit.offsetParent !== null) {
        const o = orbit.getBoundingClientRect();
        svg.setAttribute("viewBox", `0 0 ${o.width.toFixed(0)} ${o.height.toFixed(0)}`);
        const c = hit.getBoundingClientRect();
        const cx = c.left + c.width / 2 - o.left, cy = c.top + c.height / 2 - o.top;
        const paths = svg.querySelectorAll<SVGPathElement>("path.np-wire");
        chipRefs.current.forEach((chip, i) => {
          const p = paths[i];
          if (!chip || !p) return;
          const r = chip.getBoundingClientRect();
          const mx = r.left + r.width / 2 - o.left, my = r.top + r.height / 2 - o.top;
          const sx = mx < cx ? r.right - o.left - 6 : r.left - o.left + 6;
          const dx = cx - sx, dy = cy - my, d = Math.hypot(dx, dy) || 1;
          const ex = cx - (dx / d) * c.width * 0.36, ey = cy - (dy / d) * c.width * 0.36;
          const qx = (sx + ex) / 2, qy = Math.min(my, ey) - 18;
          p.setAttribute("d", `M${sx.toFixed(1)} ${my.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`);
        });
      }
      if (alive && !document.hidden) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onVis = () => { cancelAnimationFrame(raf); if (!document.hidden) raf = requestAnimationFrame(tick); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // ---- the cube: hover explodes it, it follows the pointer, a click spins it ----
  const onCubeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = cubeHitRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    rig.current.hx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    rig.current.hy = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  const onCubeEnter = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    rig.current.hover = true; setCubeHot(true); onCubeMove(e);
  };
  const onCubeLeave = () => { rig.current.hover = false; setCubeHot(false); };
  const onCubeClick = () => {
    if (reducedMotion()) return;
    rig.current.spinAt = performance.now();
    setSpinKey((k) => k + 1);
  };

  // ---- the chips: magnetic, they open up and wire themselves to the cube ----
  const onChipMove = (i: number, e: ReactPointerEvent<HTMLDivElement>) => {
    const el = chipRefs.current[i];
    if (!el || e.pointerType === "touch" || reducedMotion()) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mgx", `${((e.clientX - (r.left + r.width / 2)) * 0.22).toFixed(1)}px`);
    el.style.setProperty("--mgy", `${((e.clientY - (r.top + r.height / 2)) * 0.3).toFixed(1)}px`);
  };
  const onChipEnter = (i: number) => { setActiveChip(i); rig.current.focus = CHIPS[i].face; };
  const onChipLeave = (i: number) => {
    const el = chipRefs.current[i];
    if (el) { el.style.setProperty("--mgx", "0px"); el.style.setProperty("--mgy", "0px"); }
    setActiveChip((a) => (a === i ? null : a));
    rig.current.focus = null;
  };

  // The card tilts towards the pointer and carries a light that follows it.
  const onCardMove = (e: ReactPointerEvent<HTMLElement>) => {
    const el = cardRef.current;
    if (!el || reducedMotion() || e.pointerType === "touch") return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--tx", `${((y - 0.5) * -6).toFixed(2)}deg`);
    el.style.setProperty("--ty", `${((x - 0.5) * 8).toFixed(2)}deg`);
    el.style.setProperty("--cx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--cy", `${(y * 100).toFixed(1)}%`);
  };
  const onCardLeave = () => {
    const el = cardRef.current;
    if (!el) return;
    el.style.setProperty("--tx", "0deg");
    el.style.setProperty("--ty", "0deg");
  };

  const spawnRipple = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const id = rippleId.current++;
    setRipples((r) => [...r, { id, x: e.clientX, y: e.clientY }]);
    window.setTimeout(() => {
      setRipples((r) => r.filter((rp) => rp.id !== id));
    }, 1100);
  }, []);

  const watchCaps = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    try { setCaps(e.getModifierState("CapsLock")); } catch { /* ignore */ }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading || launching) return;
    setError(null);
    setLoading(true);
    launchHold = Date.now();

    // Persist the session only if "Keep me signed in" is checked
    setRememberMe(remember);

    const { error } = await supabase.auth.signInWithPassword({
      email: username, // using the username field as email for now
      password,
    });

    setLoading(false);

    if (error) {
      launchHold = 0;
      setError("Wrong email or password. Try again.");
      setShaking(true);
      window.setTimeout(() => setShaking(false), 560);
      return;
    }

    // Home plays its arrival sequence (set now, before anything else can mount it)
    try { sessionStorage.setItem(JUST_SIGNED_IN_KEY, String(Date.now())); } catch { /* ignore */ }

    // Success -> the card folds away, the hero cube bursts apart and re-forms
    // in the middle of a deep green screen; navigate once it has. Home picks up
    // from that exact frame and runs the real loading sequence.
    // It starts straight away; where to go is worked out while it plays.
    setLaunching(true);
    rig.current.launchAt = performance.now();
    if (!reducedMotion()) {
      const t0 = performance.now();
      const pump = () => { burst.current = Math.min(1, (performance.now() - t0) / 700); if (burst.current < 1) requestAnimationFrame(pump); };
      requestAnimationFrame(pump);
    }
    // Where to go: superadmins land on the platform panel, everyone else on home.
    const dest = (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return "/home";
        const { data: prof } = await supabase.from("profiles").select("is_superadmin").eq("id", user.id).maybeSingle();
        return prof?.is_superadmin ? "/superadmin" : "/home";
      } catch { return "/home"; }
    })();
    // one navigation, only once the screen is fully green (the iris closes at ~1.2 s)
    const minWait = new Promise((r) => window.setTimeout(r, reducedMotion() ? 120 : 1500));
    const [to] = await Promise.all([dest, minWait]);
    launchHold = 0;
    if (onScreen.current) navigate(to, { replace: true });
  };

  return (
    <div className={`np-scene ${launching ? "is-launching" : ""}`} ref={sceneRef} onPointerDown={spawnRipple}>
      <div className="np-sky" aria-hidden="true" />
      <div className="np-floor" aria-hidden="true"><div className="np-floor-grid" /></div>
      <canvas className="np-stars" ref={canvasRef} aria-hidden="true" />
      <div className="np-aurora" aria-hidden="true"><i className="is-1" /><i className="is-2" /><i className="is-3" /></div>
      <div className="np-cursor" aria-hidden="true" />
      <div className="np-vignette" aria-hidden="true" />

      {ripples.map((r) => (
        <span key={r.id} className="np-ripple" style={{ left: r.x, top: r.y }} aria-hidden="true" />
      ))}

      <div className="np-stage">
        {/* ---- the hero: the cube, with the work wired to it ---- */}
        <section className="np-hero" aria-hidden="true">
          <div className={`np-orbit ${activeChip !== null ? "has-active" : ""} ${cubeHot ? "is-hot" : ""}`} ref={orbitRef}>
            <div className="np-halo" />
            <div className="np-ring is-1" />
            <div className="np-ring is-2" />
            <svg className="np-wires" ref={linesRef} aria-hidden="true">
              <defs>
                <linearGradient id="np-wire-hot" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="#86efc0" stopOpacity="0.2" />
                  <stop offset="0.5" stopColor="#c8ffe4" stopOpacity="1" />
                  <stop offset="1" stopColor="#86efc0" stopOpacity="0.5" />
                </linearGradient>
              </defs>
              {CHIPS.map((c, i) => <path key={c.k} className={`np-wire ${activeChip === i ? "is-on" : ""}`} d="M0 0" />)}
            </svg>
            <div className="np-cube-wrap">
              <div className="np-cube-glow" />
              <div className="np-cube-shadow" />
              <div
                className="np-cube-hit"
                ref={cubeHitRef}
                onPointerEnter={onCubeEnter}
                onPointerMove={onCubeMove}
                onPointerLeave={onCubeLeave}
                onClick={onCubeClick}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <HeroCube rig={rig} pointer={pointer} />
                {spinKey > 0 && <span key={spinKey} className="np-cube-burst" />}
              </div>
            </div>
            {CHIPS.map((c, i) => (
              <div
                key={c.k}
                ref={(el) => { chipRefs.current[i] = el; }}
                className={`np-chip ${c.cls} ${activeChip === i ? "is-on" : ""}`}
                onPointerEnter={() => onChipEnter(i)}
                onPointerMove={(e) => onChipMove(i, e)}
                onPointerLeave={() => onChipLeave(i)}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="np-chip-in">
                  <i />
                  <span className="np-chip-txt"><b>{c.k}</b><em>{c.v}</em></span>
                </div>
                <div className="np-chip-more">
                  <div>
                    <svg className="np-spark" viewBox="-2 -2 64 26" preserveAspectRatio="none">
                      <path className="np-spark-area" d={`${c.spark} L60 24 L0 24 Z`} />
                      <path className="np-spark-line" d={c.spark} pathLength={1} />
                    </svg>
                    <p>{c.more}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="np-hero-copy">
            <span className="np-kicker"><i />Next Management</span>
            <h2 className="np-headline">
              <span className="np-hl"><Letters text="Every deal, project" /></span>
              <span className="np-hl"><Letters text="and client." from={20} /> <em ref={emRef}><Letters text="One place." from={32} /></em></span>
            </h2>
            <p className="np-sub">Sales, delivery, billing and customer success in one calm workspace.</p>
          </div>
        </section>

        {/* ---- the sign-in card ---- */}
        <div className="np-card-pos">
          <main
            ref={cardRef}
            className={`np-card ${launching ? "launching" : ""} ${shaking ? "is-shaking" : ""}`}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
          >
            <div className="np-card-light" aria-hidden="true" />

            <div className="np-brand">
              <span className="np-logo" aria-hidden="true"><NextCube /></span>
              <div className="np-wordmark">
                <span className="np-eyebrow">Management</span>
                <h1 className="np-title">Next</h1>
              </div>
            </div>

            <p className="np-lede">Welcome back. Sign in to your workspace.</p>

            <form className="np-form" onSubmit={onSubmit}>
              <div className="np-field">
                <span className="np-field-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></svg>
                </span>
                <input
                  id="np-username"
                  className="np-input"
                  type="text"
                  autoComplete="username"
                  placeholder=" "
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
                <label htmlFor="np-username" className="np-label">Email</label>
                <span className="np-field-line" aria-hidden="true" />
              </div>

              <div className="np-field">
                <span className="np-field-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10" width="15" height="10.5" rx="2.5" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></svg>
                </span>
                <input
                  id="np-password"
                  className="np-input"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder=" "
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={watchCaps}
                  onKeyUp={watchCaps}
                  onBlur={() => setCaps(false)}
                  required
                />
                <label htmlFor="np-password" className="np-label">Password</label>
                <button
                  type="button"
                  className={`np-reveal ${showPassword ? "is-on" : ""}`}
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
                    <circle cx="12" cy="12" r="3" />
                    <path className="np-reveal-slash" d="M4 4l16 16" />
                  </svg>
                </button>
                <span className="np-field-line" aria-hidden="true" />
              </div>
              <p className={`np-caps ${caps ? "is-on" : ""}`} role="status" aria-live="polite">
                {caps && (
                  <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4 4 12h4v5h8v-5h4z" /><path d="M8 20h8" /></svg>Caps Lock is on</>
                )}
              </p>

              <div className="np-row">
                <label className="np-check">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  <span className="np-toggle" aria-hidden="true"><i /></span>
                  <span>Keep me signed in</span>
                </label>
                <a className="np-link" href="#forgot">Forgot password?</a>
              </div>

              <div className={`np-error-wrap ${error ? "is-on" : ""}`} aria-live="assertive">
                <div className="np-error-in">
                  {error && (
                    <p className="np-error" role="alert">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></svg>
                      {error}
                    </p>
                  )}
                </div>
              </div>

              <button type="submit" className={`np-submit ${loading ? "is-loading" : ""} ${launching ? "is-done" : ""}`} disabled={loading || launching}>
                <span className="np-submit-label">{loading ? "Signing in…" : launching ? "Welcome" : "Sign in"}</span>
                <span className="np-submit-ico" aria-hidden="true">
                  {launching ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path className="np-check-draw" d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} /></svg>
                  ) : loading ? (
                    <span className="np-spin" />
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                  )}
                </span>
                <span className="np-submit-sheen" aria-hidden="true" />
              </button>
            </form>

            <p className="np-foot">
              New here? <a className="np-link" href="#signup">Create an account</a>
            </p>
          </main>
        </div>
      </div>

      {launching && (
        <div className="np-launch" aria-hidden="true">
          <div className="np-launch-bg" />
          <div className="np-launch-cube is-vec"><PageCube size={250} /></div>
        </div>
      )}
    </div>
  );
}
