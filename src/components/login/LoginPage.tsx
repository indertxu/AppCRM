import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useLayoutEffect,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { supabase, setRememberMe, takeReturnTo } from "../api/supabase";
import { PageCube, PC_LAND_T, pcPoseAt, pcAdopt } from "../framework/AppLayout";
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

/**
 * Forgot password.
 * The email link (Supabase "Reset password" template) lands on RESET_PATH with the
 * recovery tokens in the URL; supabase-js turns them into a session a moment later
 * and wipes them, so the address the app was opened at is kept here.
 */
export const RESET_PATH = "/reset-password";
const BOOT_PARAMS = (() => {
  try {
    const u = new URL(window.location.href);
    const p = new URLSearchParams(u.hash.replace(/^#/, ""));
    u.searchParams.forEach((v, k) => { if (!p.has(k)) p.set(k, v); });
    return p;
  } catch { return new URLSearchParams(); }
})();
/**
 * The email template links to our own domain (RESET_PATH?token_hash=…&type=recovery), not to
 * supabase.co: spam filters trust it, and a mail scanner that opens the link can't burn the
 * one-time token (it's only spent when the page runs). Verified once, even under StrictMode.
 */
let otpOnce: Promise<boolean> | null = null;
const verifyRecoveryToken = () => {
  const token_hash = BOOT_PARAMS.get("token_hash");
  if (!token_hash || BOOT_PARAMS.get("type") !== "recovery") return null;
  otpOnce ??= supabase.auth.verifyOtp({ token_hash, type: "recovery" }).then(({ error }) => {
    try { window.history.replaceState(window.history.state, "", RESET_PATH); } catch { /* ignore */ }
    return !error;
  }, () => false);
  return otpOnce;
};
/** an expired, already used or broken email link */
const bootLinkBroken = () => BOOT_PARAMS.get("error_code") === "otp_expired" || /email link/i.test(BOOT_PARAMS.get("error_description") ?? "");
/** the app was opened from a reset email (good or expired link): it belongs on the reset page */
export const openedFromRecovery = () => BOOT_PARAMS.get("type") === "recovery" || bootLinkBroken();
/** set by the auth provider when a deactivated (laid-off) account gets signed out */
export const DEACTIVATED_KEY = "np-deactivated";
export const DEACTIVATED_EVENT = "np:deactivated";
const DEACTIVATED_MSG = "This account has been deactivated. Ask your administrator.";
const MIN_PW = 8;
/**
 * The password rule everywhere a password is set (reset, Settings, new users, superadmin):
 * at least 8 characters, with letters, numbers and a symbol (. - _ ! @ …).
 */
export const PASSWORD_RULES: { label: string; ok: (p: string) => boolean }[] = [
  { label: `At least ${MIN_PW} characters`, ok: (p) => p.length >= MIN_PW },
  { label: "Letters and numbers", ok: (p) => /\p{L}/u.test(p) && /\d/.test(p) },
  { label: "A symbol (. - _ ! @)", ok: (p) => /[^\p{L}\d\s]/u.test(p) },
];
export const PASSWORD_HINT = `At least ${MIN_PW} characters, with letters, numbers and a symbol (. - _ ! @ …).`;
/** what's wrong with this password, or null when it meets the rule */
export function passwordProblem(p: string): string | null {
  if (p.length < MIN_PW) return `Use at least ${MIN_PW} characters.`;
  if (!PASSWORD_RULES[1].ok(p)) return "Use both letters and numbers.";
  if (!PASSWORD_RULES[2].ok(p)) return "Add a symbol, like . - _ or !";
  return null;
}
const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
type View = "signin" | "forgot" | "sent" | "checking" | "reset" | "expired" | "blocked";

const IC_SEND = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M21 3 10.5 13.5" /><path d="M21 3 14.5 21l-4-7.5L3 9.5z" /></svg>;
const IC_ARROW = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
const IC_MAIL = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path pathLength={1} d="M20 12.5V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7.5" /><path pathLength={1} d="m3.5 7 8.5 6 8.5-6" /><path pathLength={1} d="m15.5 18 2.2 2.2L22 16" /></svg>;
const IC_CLOCK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>;
const IC_LOCK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10" width="15" height="10.5" rx="2.5" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /><path d="M12 14v2.5" /></svg>;
const IC_KEY = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.7-8.7M16.5 6.5l2.5 2.5M14.5 8.5l2 2" /></svg>;
const IC_AGAIN = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4.5V11h-6.5" /></svg>;

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
  launchAt: number;           // signed in: the cube flies to the middle and becomes the loader
  /** the hero cube's pose this frame (the flying cube starts from exactly here) */
  pose?: { yaw: number; pitch: number; scale: number; lift: number; hov: number };
  /** the flying cube has taken over: the hero one steps aside */
  flying?: boolean;
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
      const yaw = cur.yaw + spin, pitch = cur.pitch;
      const scale = 1 + cur.hov * 0.1 + pop;
      const lift = -cur.hov * 12 + (still ? 0 : Math.sin(now / 950) * 4 * (1 - cur.hov));
      r.pose = { yaw, pitch, scale, lift, hov: cur.hov };
      // signed in: this same cube flies on (FlyCube carries it), so the one in the hero steps aside
      rootRef.current?.setAttribute("display", r.flying ? "none" : "inline");
      if (r.flying) { if (alive && !document.hidden) raf = requestAnimationFrame(draw); return; }
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
        const ex = cur.hov * 0.24 + cur.foc[f] + introEx;
        const facing = n[2];
        const op = clamp(facing * 9, 0, 1) * clamp(intro * 2.4, 0, 1);
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
   Signed in: the hero cube itself flies to the middle of the screen and lands
   on the loader's exact pose and size; the loader takes over from that moment
   (same clock), so from the sign-in to Home it is one cube, never rebuilt.
   It starts from the hero's pose of this very frame, on top of the green iris.
   --------------------------------------------------------------------------- */
const FLY_MS = 1150;
const LOADER_PX = 250 / 240; // PageCube at 250 px: px per unit
const LOADER_HALF = 50 * LOADER_PX; // its half edge, px
function FlyCube({ rig, onLand }: { rig: React.MutableRefObject<CubeRig>; onLand: () => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const rootRef = useRef<SVGGElement>(null);
  const faceRefs = useRef<Partial<Record<FaceKey, SVGGElement | null>>>({});
  const shadeRefs = useRef<Partial<Record<FaceKey, SVGRectElement | null>>>({});
  const landRef = useRef(onLand);
  landRef.current = onLand;

  useEffect(() => {
    const hero = document.querySelector<SVGSVGElement>(".np-cube-hit .np3-cube");
    const box = hero?.getBoundingClientRect();
    const pose = rig.current.pose ?? { yaw: BASE_YAW, pitch: BASE_PITCH, scale: 1, lift: 0, hov: 0 };
    if (!box || !box.width) { landRef.current(); return; }
    const pxu0 = box.width / 340;
    const from = { x: box.left + box.width / 2, y: box.top + box.height / 2 + pose.lift * pxu0, half: R * pxu0 * pose.scale };
    const to = pcPoseAt(PC_LAND_T);
    const t0 = performance.now();
    let raf = 0, alive = true, landed = false;
    const lerp = (a: number, b: number, e: number) => a + (b - a) * e;
    const draw = (now: number) => {
      const p = clamp((now - t0) / FLY_MS, 0, 1), e = easeInOut(p);
      const W = window.innerWidth, H = window.innerHeight;
      // the path: to the loader's spot (50%, 46%), a little arc on the way, growing or shrinking to its size
      const half = lerp(from.half, LOADER_HALF, e);
      const pxu = half / R, size = 340 * pxu;
      const cx = lerp(from.x, W / 2, e), cy = lerp(from.y, H * 0.46, e) - Math.sin(p * Math.PI) * 34;
      const el = svgRef.current;
      if (el) { el.style.left = `${(cx - size / 2).toFixed(2)}px`; el.style.top = `${(cy - size / 2).toFixed(2)}px`; el.style.width = el.style.height = `${size.toFixed(2)}px`; }
      // the pose eases into the loader's; in flight the faces part a touch and come back together
      const yaw = lerp(pose.yaw, to.yaw, e), pitch = lerp(pose.pitch, to.pitch, e);
      const ex = pose.hov * 0.24 * (1 - e) + Math.sin(p * Math.PI) * 0.12;
      for (const f of ["top", "left", "right"] as FaceKey[]) {
        const g = faceRefs.current[f];
        if (!g) continue;
        const geo = FACE_GEO[f];
        const n = rotate(geo.n, yaw, pitch), u = rotate(geo.u, yaw, pitch), v = rotate(geo.v, yaw, pitch);
        const c: V3 = [n[0] * (1 + ex), n[1] * (1 + ex), n[2] * (1 + ex)];
        const ox = (c[0] - u[0] - v[0]) * R, oy = -(c[1] - u[1] - v[1]) * R;
        g.setAttribute("transform", `matrix(${((u[0] * R) / 20).toFixed(4)} ${((-u[1] * R) / 20).toFixed(4)} ${((v[0] * R) / 20).toFixed(4)} ${((-v[1] * R) / 20).toFixed(4)} ${ox.toFixed(3)} ${oy.toFixed(3)})`);
        g.setAttribute("opacity", clamp(n[2] * 9, 0, 1).toFixed(3));
        const sh = shadeRefs.current[f];
        if (sh) {
          const lum = (dot(n, LIGHT) - REST_LIGHT[f]) * 0.5;
          sh.setAttribute("fill", lum >= 0 ? "#ffffff" : "#021a10");
          sh.setAttribute("opacity", Math.min(lum >= 0 ? 0.22 : 0.5, Math.abs(lum)).toFixed(3));
        }
      }
      rootRef.current?.setAttribute("visibility", "visible");
      rig.current.flying = true;
      if (p >= 1 && !landed) { landed = true; landRef.current(); }
      if (alive && p < 1) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [rig]);

  const face = (f: FaceKey, fill: string, art: React.ReactNode) => (
    <g key={f} ref={(el) => { faceRefs.current[f] = el; }}>
      <rect width="40" height="40" rx="2.4" fill={fill} />
      <rect width="40" height="40" rx="2.4" fill={`url(#np3f-gloss-${f === "top" ? "top" : "side"})`} />
      {art}
      <rect ref={(el) => { shadeRefs.current[f] = el; }} width="40" height="40" rx="2.4" fill="#ffffff" opacity="0" />
      <rect x="0.4" y="0.4" width="39.2" height="39.2" rx="2.1" fill="none" stroke="rgba(255,255,255,0.32)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </g>
  );
  return (
    <svg ref={svgRef} className="np-fly" viewBox="-170 -170 340 340" shapeRendering="geometricPrecision" aria-hidden="true">
      <defs>
        <linearGradient id="np3f-gloss-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.38" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#0a6f4d" stopOpacity="0.12" />
        </linearGradient>
        <linearGradient id="np3f-gloss-side" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.2" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.16" />
        </linearGradient>
      </defs>
      <g ref={rootRef} visibility="hidden">
        {face("top", "#86efc0", <>
          <polyline points="7.4,31.6 15.8,20 23.2,25.3 33.4,10.6" fill="none" stroke="#0a6f4d" strokeWidth="3.7" strokeLinecap="round" strokeLinejoin="round" />
          <polygon points="37.9,4.2 36.9,13.2 29.7,8.1" fill="#0a6f4d" />
        </>)}
        {face("left", "#12b57f", <path d="M11 31V9h5.6l6.8 12.8V9H29v22h-5.6l-6.8-12.8V31z" fill="#ffffff" />)}
        {face("right", "#0a6f4d", <>
          <rect x="6.3" y="24" width="6.3" height="11" rx="1.6" fill="#ffffff" />
          <rect x="16.8" y="16" width="6.3" height="19" rx="1.6" fill="#ffffff" />
          <rect x="27.4" y="8" width="6.3" height="27" rx="1.6" fill="#ffffff" />
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

export default function LoginPage({ mode = "signin" }: { mode?: "signin" | "reset" }) {
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
  /** the flying cube has landed: the loader cube carries on from it */
  const [landed, setLanded] = useState(false);
  const [flyGone, setFlyGone] = useState(false);
  const onLand = useCallback(() => {
    pcAdopt(PC_LAND_T);
    setLanded(true);
    window.setTimeout(() => setFlyGone(true), 160);
  }, []);
  const [remember, setRemember] = useState(false);
  const [caps, setCaps] = useState(false);
  const [activeChip, setActiveChip] = useState<number | null>(null);
  const [cubeHot, setCubeHot] = useState(false);
  const [spinKey, setSpinKey] = useState(0);
  // which face of the card: sign in, the forgot-password steps, or the new-password form
  const [view, setView] = useState<View>(mode === "reset" ? "checking" : "signin");
  const [swapped, setSwapped] = useState(false);
  const [password2, setPassword2] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyIn = useRef<HTMLDivElement>(null);
  const swapFrom = useRef<number | null>(null);
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

  const fail = (msg: string) => {
    setError(msg);
    setShaking(true);
    window.setTimeout(() => setShaking(false), 560);
  };

  /** switch the card to another step: the content fades up and the card eases to its new height */
  const go = (v: View) => {
    try { sessionStorage.removeItem(DEACTIVATED_KEY); } catch { /* ignore */ }
    swapFrom.current = bodyIn.current?.offsetHeight ?? null;
    setSwapped(true);
    setError(null);
    setShaking(false);
    setView(v);
  };
  useLayoutEffect(() => {
    const wrap = bodyRef.current, inner = bodyIn.current, from = swapFrom.current;
    swapFrom.current = null;
    if (!wrap || !inner || from == null || reducedMotion()) return;
    const to = inner.offsetHeight;
    if (Math.abs(to - from) < 2) return;
    wrap.style.height = `${from}px`;
    wrap.style.overflow = "hidden";
    void wrap.offsetHeight;
    wrap.style.transition = "height 0.44s cubic-bezier(0.22, 1, 0.36, 1)";
    wrap.style.height = `${to}px`;
    const t = window.setTimeout(() => { wrap.style.height = ""; wrap.style.overflow = ""; wrap.style.transition = ""; }, 460);
    return () => { window.clearTimeout(t); wrap.style.height = ""; wrap.style.overflow = ""; wrap.style.transition = ""; };
  }, [view]);

  // "Send again" waits a minute (Supabase allows one email a minute per address)
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  // a deactivated account that got signed out: say why
  useEffect(() => {
    // the note stays until the next attempt: if it arrives mid-launch, the sign-in page you land back on still shows it
    const show = () => setError(DEACTIVATED_MSG);
    let pending = false;
    try { pending = !!sessionStorage.getItem(DEACTIVATED_KEY); } catch { /* ignore */ }
    if (pending) queueMicrotask(show);
    window.addEventListener(DEACTIVATED_EVENT, show);
    return () => window.removeEventListener(DEACTIVATED_EVENT, show);
  }, []);

  // the reset page: is the email link good (a recovery session), expired, or for a deactivated account?
  useEffect(() => {
    if (mode !== "reset") return;
    let alive = true;
    const to = (v: View) => { if (alive) go(v); };
    (async () => {
      if (bootLinkBroken()) return to("expired");
      const viaToken = verifyRecoveryToken();
      if (viaToken && !(await viaToken)) return to("expired");
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return to("expired");
      const { data: prof } = await supabase.from("profiles").select("active").eq("id", user.id).maybeSingle();
      if (!alive) return;
      if ((prof as { active?: boolean | null } | null)?.active === false) {
        await supabase.auth.signOut();
        return to("blocked");
      }
      setUsername(user.email ?? "");
      to("reset");
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /** Signed in (or a new password saved): fold the card, fly the cube, go to the app. */
  const launch = async () => {
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
        const back = takeReturnTo();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return back ?? "/home";
        const { data: prof } = await supabase.from("profiles").select("is_superadmin").eq("id", user.id).maybeSingle();
        // back to the page you were on before signing in (a superadmin: only to their own panel)
        return prof?.is_superadmin ? (back?.startsWith("/superadmin") ? back : "/superadmin") : back && !back.startsWith("/superadmin") ? back : "/home";
      } catch { return "/home"; }
    })();
    // one navigation, only once the screen is fully green (the iris closes at ~1.2 s)
    const minWait = new Promise((r) => window.setTimeout(r, reducedMotion() ? 120 : 1500));
    const [to] = await Promise.all([dest, minWait]);
    launchHold = 0;
    if (onScreen.current) navigate(to, { replace: true });
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading || launching) return;
    setError(null);
    try { sessionStorage.removeItem(DEACTIVATED_KEY); } catch { /* ignore */ }
    setLoading(true);
    launchHold = Date.now();

    // Persist the session only if "Keep me signed in" is checked
    setRememberMe(remember);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: username, // using the username field as email for now
      password,
    });

    if (error) {
      setLoading(false);
      launchHold = 0;
      fail("Wrong email or password. Try again.");
      return;
    }

    // laid off: the account still exists (their name stays on past work) but can't sign in
    const uid = data?.user?.id ?? data?.session?.user?.id;
    if (uid) {
      const { data: prof } = await supabase.from("profiles").select("active").eq("id", uid).maybeSingle();
      if ((prof as { active?: boolean | null } | null)?.active === false) {
        await supabase.auth.signOut();
        setLoading(false);
        launchHold = 0;
        fail(DEACTIVATED_MSG);
        return;
      }
    }
    setLoading(false);
    await launch();
  };

  /** Forgot password: email a link that opens RESET_PATH. Says the same whether the address exists or not. */
  const sendReset = async (e?: FormEvent) => {
    e?.preventDefault();
    if (loading || cooldown > 0) return;
    setError(null);
    const email = username.trim();
    if (!emailOk(email)) { fail("Enter the email you sign in with."); return; }
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}${RESET_PATH}` });
    setLoading(false);
    if (error) {
      const busy = error.status === 429 || /rate limit|security purposes|seconds/i.test(error.message ?? "");
      fail(busy ? "Too many requests. Wait a minute and try again." : "We couldn't send the email right now. Try again in a moment.");
      return;
    }
    setUsername(email);
    setCooldown(60);
    if (view !== "sent") go("sent");
  };

  /** the reset page: save the new password, then straight into the app */
  const saveNewPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (loading || launching) return;
    setError(null);
    const weak = passwordProblem(password);
    if (weak) { fail(weak); return; }
    if (password !== password2) { fail("The two passwords don't match."); return; }
    setLoading(true);
    launchHold = Date.now();
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      launchHold = 0;
      const code = (error as { code?: string }).code;
      fail(
        code === "same_password" ? "That's your current password. Choose a different one."
          : code === "weak_password" ? (error.message || "That password is too weak. Try a longer one.")
            : /session|expired|jwt/i.test(error.message ?? "") ? "This link has expired. Request a new one."
              : "Couldn't save the password. Try again.",
      );
      return;
    }
    await launch();
  };

  /** back to the sign-in card (from the reset page: drop the link's session first) */
  const backToSignIn = (e: ReactMouseEvent) => {
    e.preventDefault();
    if (mode === "reset") {
      setPassword(""); setPassword2("");
      void supabase.auth.signOut().finally(() => navigate("/login", { replace: true }));
      return;
    }
    setPassword("");
    go("signin");
  };

  const pwMatch = password2.length > 0 && password === password2;

  const emailField = (
    <div className="np-field">
      <span className="np-field-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></svg>
      </span>
      <input
        id="np-username"
        className="np-input"
        type={view === "forgot" ? "email" : "text"}
        autoComplete="username"
        placeholder=" "
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus={swapped && view === "forgot"}
        required
      />
      <label htmlFor="np-username" className="np-label">Email</label>
      <span className="np-field-line" aria-hidden="true" />
    </div>
  );

  const passwordField = (id: string, label: string, value: string, set: (v: string) => void, auto: string, reveal: boolean, focus = false) => (
    <div className="np-field">
      <span className="np-field-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10" width="15" height="10.5" rx="2.5" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></svg>
      </span>
      <input
        id={id}
        className="np-input"
        type={showPassword ? "text" : "password"}
        autoComplete={auto}
        placeholder=" "
        value={value}
        onChange={(e) => { set(e.target.value); if (error && view === "reset") setError(null); }}
        onKeyDown={watchCaps}
        onKeyUp={watchCaps}
        onBlur={() => setCaps(false)}
        autoFocus={focus}
        required
      />
      <label htmlFor={id} className="np-label">{label}</label>
      {reveal && (
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
      )}
      <span className="np-field-line" aria-hidden="true" />
    </div>
  );

  const capsNote = (
    <p className={`np-caps ${caps ? "is-on" : ""}`} role="status" aria-live="polite">
      {caps && (
        <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4 4 12h4v5h8v-5h4z" /><path d="M8 20h8" /></svg>Caps Lock is on</>
      )}
    </p>
  );

  const errorBox = (
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
  );

  const submit = (label: string, busy: string, done: string, icon: ReactNode, type: "submit" | "button" = "submit", onClick?: () => void) => (
    <button type={type} onClick={onClick} className={`np-submit ${loading ? "is-loading" : ""} ${launching ? "is-done" : ""}`} disabled={loading || launching}>
      <span className="np-submit-label">{loading ? busy : launching ? done : label}</span>
      <span className="np-submit-ico" aria-hidden="true">
        {launching ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path className="np-check-draw" d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} /></svg>
        ) : loading ? <span className="np-spin" /> : icon}
      </span>
      <span className="np-submit-sheen" aria-hidden="true" />
    </button>
  );

  const backFoot = (lead: string) => (
    <p className="np-foot">{lead} <a className="np-link" href="#signin" onClick={backToSignIn}>Back to sign in</a></p>
  );

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

            <div className="np-body" ref={bodyRef}>
              <div key={view} ref={bodyIn} className={`np-body-in ${swapped ? "is-swapped" : ""}`}>
                {view === "signin" && (
                  <>
                    <p className="np-lede">Welcome back. Sign in to your workspace.</p>
                    <form className="np-form" onSubmit={onSubmit}>
                      {emailField}
                      {passwordField("np-password", "Password", password, setPassword, "current-password", true)}
                      {capsNote}
                      <div className="np-row">
                        <label className="np-check">
                          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                          <span className="np-toggle" aria-hidden="true"><i /></span>
                          <span>Keep me signed in</span>
                        </label>
                        <a className="np-link" href="#forgot" onClick={(e) => { e.preventDefault(); go("forgot"); }}>Forgot password?</a>
                      </div>
                      {errorBox}
                      {submit("Sign in", "Signing in…", "Welcome", IC_ARROW)}
                    </form>
                    <p className="np-foot">
                      New here? <a className="np-link" href="#signup">Create an account</a>
                    </p>
                  </>
                )}

                {view === "forgot" && (
                  <>
                    <p className="np-lede">Forgot your password? Enter the email you sign in with and we'll send you a link to choose a new one.</p>
                    <form className="np-form" onSubmit={sendReset} noValidate>
                      {emailField}
                      {errorBox}
                      {submit("Send reset link", "Sending…", "Sent", IC_SEND)}
                    </form>
                    {backFoot("Remembered it?")}
                  </>
                )}

                {view === "sent" && (
                  <>
                    <div className="np-notice">
                      <span className="np-notice-ico is-ok is-draw" aria-hidden="true">{IC_MAIL}</span>
                      <h2 className="np-notice-title">Check your inbox</h2>
                      <p className="np-notice-txt">If <b>{username.trim()}</b> has an account, a link to set a new password is on its way. It works once and expires in an hour.</p>
                    </div>
                    <div className="np-form">
                      <p className="np-hint">Nothing yet? Check your spam folder, or send it again.</p>
                      {errorBox}
                      <button type="button" className="np-ghost" onClick={() => void sendReset()} disabled={loading || cooldown > 0}>
                        {loading ? <span className="np-spin is-light" /> : IC_AGAIN}
                        <span>{loading ? "Sending…" : cooldown > 0 ? `Send again in ${cooldown}s` : "Send again"}</span>
                      </button>
                    </div>
                    {backFoot("")}
                  </>
                )}

                {view === "checking" && (
                  <div className="np-notice is-tall" role="status">
                    <span className="np-notice-ico" aria-hidden="true"><span className="np-spin is-light is-big" /></span>
                    <h2 className="np-notice-title">Checking your link…</h2>
                    <p className="np-notice-txt">One moment.</p>
                  </div>
                )}

                {view === "reset" && (
                  <>
                    <p className="np-lede">Choose a new password{username ? <> for <b>{username}</b></> : null}.</p>
                    <form className="np-form" onSubmit={saveNewPassword}>
                      <input type="text" autoComplete="username" value={username} readOnly hidden />
                      {passwordField("np-password", "New password", password, setPassword, "new-password", true, true)}
                      {passwordField("np-password2", "Repeat new password", password2, setPassword2, "new-password", false)}
                      {capsNote}
                      <ul className="np-rules" aria-label="Password rules">
                        {PASSWORD_RULES.map((r) => (
                          <li key={r.label} className={r.ok(password) ? "is-ok" : ""}><i aria-hidden="true" />{r.label}</li>
                        ))}
                        <li className={pwMatch ? "is-ok" : ""}><i aria-hidden="true" />Both match</li>
                      </ul>
                      {errorBox}
                      {submit("Save and sign in", "Saving…", "Welcome", IC_KEY)}
                    </form>
                    {backFoot("Not you?")}
                  </>
                )}

                {view === "expired" && (
                  <>
                    <div className="np-notice">
                      <span className="np-notice-ico is-warn" aria-hidden="true">{IC_CLOCK}</span>
                      <h2 className="np-notice-title">This link has expired</h2>
                      <p className="np-notice-txt">Reset links work once and only for an hour. Send yourself a new one.</p>
                    </div>
                    <div className="np-form">
                      {submit("Send a new link", "Sending…", "Sent", IC_ARROW, "button", () => go("forgot"))}
                    </div>
                    {backFoot("")}
                  </>
                )}

                {view === "blocked" && (
                  <>
                    <div className="np-notice">
                      <span className="np-notice-ico is-warn" aria-hidden="true">{IC_LOCK}</span>
                      <h2 className="np-notice-title">Account deactivated</h2>
                      <p className="np-notice-txt">This account has been deactivated, so its password can't be changed. Ask your administrator if this is a mistake.</p>
                    </div>
                    {backFoot("")}
                  </>
                )}
              </div>
            </div>
          </main>
        </div>
      </div>

      {launching && (
        <div className="np-launch" aria-hidden="true">
          <div className="np-launch-bg" />
          {/* the hero cube flies here and lands as the loader (reduced motion: the loader, still) */}
          {!reducedMotion() && !flyGone && <FlyCube rig={rig} onLand={onLand} />}
          {(landed || reducedMotion()) && <div className="np-launch-cube is-vec is-landed"><PageCube size={250} /></div>}
        </div>
      )}
    </div>
  );
}
