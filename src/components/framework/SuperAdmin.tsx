/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SUPERADMIN BUBBLE
 *
 * A small floating bubble (top-right, drag it anywhere) for superadmins:
 *
 *   • Preview a security level — see the app as a Salesperson, a Consultant…
 *     Menus, pages, panels and role-based screens follow that level. You stay
 *     yourself underneath: anything you save is saved as you.
 *
 *   • Act as someone — become that person for a while (a real sign-in as
 *     them, done by the act-as Edge Function): you see exactly what they see
 *     and what you do is done as them — booking a meeting goes to THEIR
 *     Outlook. "Return to me" brings your own session back. Every switch is
 *     logged (impersonation_log).
 *
 * Who gets it: people with profiles.is_org_superadmin = true — the
 * organisation's own superadmin. (profiles.is_superadmin is the PLATFORM
 * superadmin, who has a separate panel; that flag isn't used here.)
 *
 * Turned on from Settings → Organization → "Superadmin". While acting as someone the bubble always shows, so you can
 * always get back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../api/supabase";
import { deptName, levelName } from "./pageAccess";
import "./SuperAdmin.css";

/* ───────────────────────── storage ───────────────────────── */
const BUBBLE_KEY = "next.superBubble";
const POS_KEY = "next.superBubble.pos";
const PREVIEW_KEY = "next.preview.role";
const ACT_KEY = "next.actAs";
export const SUPER_BUBBLE_EVENT = "next:super-bubble";

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const readJson = <T,>(k: string): T | null => { try { return JSON.parse(ls.get(k) ?? "null"); } catch { return null; } };

/** Previewing a security level (only honoured for real superadmins). */
export interface RolePreview { uid: string; role: string; department: string | null }
/** The preview set by this person (a preview saved by someone else on this browser is ignored). */
export const getRolePreview = (uid?: string | null): RolePreview | null => {
  const pv = readJson<RolePreview>(PREVIEW_KEY);
  return pv && pv.uid && (!uid || pv.uid === uid) ? pv : null;
};
/** The role/department the app should use for this person while they preview a level. */
export function applyRolePreview<T extends { id?: string | null; role?: string | null; department?: string | null; is_superadmin?: boolean | null }>(p: T): T {
  const pv = p?.id ? getRolePreview(p.id) : null;
  if (!pv) return p;
  return { ...p, role: pv.role, department: pv.department ?? p.department ?? null, is_superadmin: false };
}

/** Acting as someone else (the real session is kept to come back). */
interface ActAs {
  original: { access_token: string; refresh_token: string };
  admin: { id: string; name: string };
  target: { id: string; name: string; role: string | null };
  logId: string | null;
  startedAt: string;
}
/*
 * Where the "acting as" note (with your own session to come back to) is kept
 * follows the app's "Keep me signed in", like the session itself: ticked → this
 * browser (survives restarts); not ticked → this tab (survives F5, gone when the
 * tab closes, so nothing of yours is left behind).
 */
const REMEMBER_KEY = "np-remember";
const remembers = () => ls.get(REMEMBER_KEY) === "true";
let memAct: string | null = null;
const tabGet = (): string | null => { try { return sessionStorage.getItem(ACT_KEY) ?? memAct; } catch { return memAct; } };
const tabSet = (v: string) => { memAct = v; try { sessionStorage.setItem(ACT_KEY, v); } catch { /* memory only */ } };
export const getActAs = (): ActAs | null => {
  const raw = remembers() ? ls.get(ACT_KEY) : tabGet();
  try { return raw ? (JSON.parse(raw) as ActAs) : null; } catch { return null; }
};
const saveActAs = (a: ActAs) => { if (remembers()) ls.set(ACT_KEY, JSON.stringify(a)); else tabSet(JSON.stringify(a)); };
const clearActAs = () => { memAct = null; ls.del(ACT_KEY); try { sessionStorage.removeItem(ACT_KEY); } catch { /* ignore */ } };
export const ACT_AS_EVENT = "next:act-as-changed";

export const isBubbleOn = () => ls.get(BUBBLE_KEY) === "1";
export function setBubbleOn(on: boolean) {
  if (on) ls.set(BUBBLE_KEY, "1"); else ls.del(BUBBLE_KEY);
  window.dispatchEvent(new CustomEvent(SUPER_BUBBLE_EVENT));
}

/* ───────────────────────── who am I really ───────────────────────── */
type MeCheck = { id: string; name: string; isSuper: boolean; why: string };
let meCache: Promise<MeCheck | null> | null = null;
/** Who is signed in, and whether their profile says superadmin — with the reason if not. */
async function realMe(): Promise<MeCheck | null> {
  return (meCache ??= (async () => {
    const { data } = await supabase.auth.getSession();
    const uid = data?.session?.user?.id;
    if (!uid) return null;
    // select("*") so a missing optional column (e.g. last_name) can't make the check fail.
    const { data: p, error } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
    const name = [(p as any)?.first_name, (p as any)?.last_name].filter(Boolean).join(" ") || data.session?.user?.email || "Me";
    const flag = (p as any)?.is_org_superadmin;
    const isSuper = flag === true || flag === "true" || flag === 1;
    const why = error ? `couldn't read your profile: ${error.message}`
      : !p ? `there is no row in profiles with id ${uid}`
      : !("is_org_superadmin" in (p as any)) ? "the is_org_superadmin column doesn't exist yet — run empower_superadmin.sql"
      : isSuper ? "is_org_superadmin = true" : `is_org_superadmin = ${JSON.stringify(flag)} for ${data.session?.user?.email ?? uid}`;
    console.info(`[superadmin] ${name} (${uid}) — ${isSuper ? "superadmin ✓" : "not superadmin"}: ${why}`);
    return { id: uid, name, isSuper, why };
  })().catch((e) => { meCache = null; throw e; }));
}
/** Is the signed-in person (not a preview) a superadmin? (+ why not) */
export function useRealSuperadmin(): boolean { return useSuperCheck().isSuper; }
function useSuperCheck(): { ready: boolean; isSuper: boolean; why: string } {
  const [st, setSt] = useState({ ready: false, isSuper: false, why: "" });
  useEffect(() => {
    let alive = true;
    realMe().then((m) => { if (alive) setSt({ ready: true, isSuper: !!m?.isSuper, why: m?.why ?? "not signed in" }); })
      .catch((e) => { if (alive) setSt({ ready: true, isSuper: false, why: String(e?.message ?? e) }); });
    return () => { alive = false; };
  }, []);
  return st;
}

/* ───────────────────────── act as ───────────────────────── */
async function callActAs(body: object): Promise<any> {
  const { data, error } = await supabase.functions.invoke("act-as", { body });
  if (error) {
    let msg = error.message ?? String(error);
    try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    if (/not found|404|Failed to send/i.test(msg)) msg = "The act-as function isn't deployed in Supabase yet (Edge Functions → act-as).";
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function startActingAs(target: { id: string; name: string; role: string | null }) {
  const me = await realMe();
  if (!me) throw new Error("Sign in again first.");
  trace(`Act as ${target.name} — started by ${me.name} on ${window.location.pathname}`, true);
  const r = await callActAs({ action: "start", userId: target.id });
  // Your own session, taken right before switching (the freshest tokens to come back with).
  const { data: s } = await supabase.auth.getSession();
  if (!s?.session) throw new Error("Sign in again first.");
  const record: ActAs = {
    original: { access_token: s.session.access_token, refresh_token: s.session.refresh_token },
    admin: { id: me.id, name: me.name }, target, logId: r.logId ?? null, startedAt: new Date().toISOString(),
  };
  saveActAs(record);
  ls.del(PREVIEW_KEY);
  log("got a one-time sign-in for", target.name, "· type:", r.verification_type ?? "?");
  // Use the type Supabase says the token is for; fall back to the usual ones.
  const types = [...new Set([r.verification_type, "email", "magiclink"].filter(Boolean))] as string[];
  let res: any = null;
  for (const type of types) {
    res = await supabase.auth.verifyOtp({ token_hash: r.token_hash, type } as any);
    log(`verifyOtp(${type}) →`, res.error ? `error: ${res.error.message}` : `signed in as ${res.data?.user?.email ?? res.data?.user?.id}`);
    if (!res.error) break;
  }
  const { data: now } = await supabase.auth.getSession();
  const nowId = now?.session?.user?.id;
  if (res?.error || nowId !== target.id) {
    // Didn't switch: put your own session back and say why (never leave you signed out).
    clearActAs();
    const back = await supabase.auth.setSession(record.original);
    log("couldn't switch; restored your session:", back.error ? `FAILED (${back.error.message})` : "ok");
    throw new Error(`Couldn't sign in as ${target.name}: ${res?.error?.message ?? `the session is ${nowId ?? "empty"}`}`);
  }
  log(`now acting as ${target.name} — saved: ${storedSessions()}`);
  await new Promise((r) => setTimeout(r, 300));
  log(`reloading the app · saved: ${storedSessions()}`);
  reloadApp();
}
/*
 * A small trace of the last switch, kept in this browser (survives reloads and
 * being sent to the login page) and shown in the bubble, so we can see what
 * happened step by step. It records for 3 minutes after you press Act as /
 * Return, then stops.
 */
const TRACE_KEY = "next.actAs.trace";
type TraceLine = { t: string; m: string };
const readTrace = (): { armedUntil: number; lines: TraceLine[] } => readJson(TRACE_KEY) ?? { armedUntil: 0, lines: [] };
const traceArmed = () => readTrace().armedUntil > Date.now();
function trace(m: string, arm = false) {
  const tr = readTrace();
  if (!arm && tr.armedUntil < Date.now()) return;
  const lines = [...(arm ? [] : tr.lines), { t: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), m }].slice(-40);
  ls.set(TRACE_KEY, JSON.stringify({ armedUntil: arm ? Date.now() + 180_000 : tr.armedUntil, lines }));
}
const log = (...a: unknown[]) => {
  console.info("[act-as]", ...a);
  trace(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
};
/** What Supabase has saved in this browser right now (who, until when) — read straight from storage. */
function storedSessions(): string {
  try {
    const out: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)!;
        if (!/^sb-.*auth-token/.test(k)) continue;
        const raw = store.getItem(k) ?? "";
        let who = "?", until = "?";
        try {
          const j = JSON.parse(raw.startsWith("base64-") ? atob(raw.slice(7)) : raw);
          const sess = j?.currentSession ?? j;
          who = sess?.user?.email ?? "?";
          until = sess?.expires_at ? `${Math.round(sess.expires_at - Date.now() / 1000)}s left` : "no expiry";
        } catch { who = `unreadable (${raw.length} chars)`; }
        out.push(`${store === localStorage ? "local" : "session"}:${k} → ${who}, ${until}`);
      }
    }
    if (document.cookie.includes("sb-")) out.push(`cookies: ${document.cookie.split(";").filter((c) => c.includes("sb-")).map((c) => c.split("=")[0].trim()).join(", ")}`);
    return out.length ? out.join(" | ") : "nothing saved";
  } catch (e: any) { return `can't read storage: ${e?.message ?? e}`; }
}

// While armed: note every page load and every sign-in / sign-out the app sees.
if (typeof window !== "undefined" && traceArmed()) {
  log(`page loading: ${window.location.pathname} · saved: ${storedSessions()}`);
  setTimeout(() => log(`2s later · saved: ${storedSessions()}`), 2000);
  supabase.auth.getSession().then(({ data }: any) => {
    log(`page loaded: ${window.location.pathname} · signed in as ${data?.session?.user?.email ?? "NOBODY (no session)"}`);
  }).catch((e: any) => log("page loaded, couldn't read the session:", String(e?.message ?? e)));
  supabase.auth.onAuthStateChange?.((event: string, session: any) => {
    log(`auth event ${event} · ${session?.user?.email ?? "no session"}`);
  });
}
/**
 * Start the app again as whoever is signed in now. Reloads the page you're on
 * (never a hard-coded address, so it works wherever the app is hosted); if
 * that page isn't open to the new person, the app's own guards take them Home.
 */
const reloadApp = () => restartApp();
/**
 * Start the app again as whoever is signed in now — WITHOUT reloading the page
 * (a reload would sign out anyone who didn't tick "Keep me signed in"). Every
 * page is closed and Home opens fresh, the menus and page access are worked
 * out again, and the bubble reads who you are.
 */
export function restartApp() {
  meCache = null;
  window.dispatchEvent(new CustomEvent(ACT_AS_EVENT));
  window.dispatchEvent(new Event("next:security-level-changed")); // page access recalculates
  // Through a route that doesn't exist, so the current page unmounts and Home mounts fresh.
  window.history.pushState(null, "", "/__switching");
  window.dispatchEvent(new PopStateEvent("popstate"));
  setTimeout(() => {
    if (window.location.pathname === "/__switching") {
      window.history.replaceState(null, "", "/home");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, 60);
}

async function returnToMe() {
  const a = getActAs();
  if (!a) return;
  trace(`Return to ${a.admin.name} — from ${a.target.name} on ${window.location.pathname}`, true);
  const { error } = await supabase.auth.setSession(a.original);
  log(`your session restored: ${error ? `FAILED (${error.message})` : "ok"}`);
  clearActAs();
  if (error) {
    // Your own session can't be brought back (it expired meanwhile): sign in as yourself again.
    log("couldn't restore your session:", error.message);
    await supabase.auth.signOut().catch(() => {});
    reloadApp();
    return;
  }
  if (a.logId) await callActAs({ action: "stop", logId: a.logId }).catch((e) => log("stop failed:", String(e?.message ?? e)));
  log("back as", a.admin.name);
  reloadApp();
}

/* ───────────────────────── UI ───────────────────────── */
const KNOWN_ROLES = ["boss", "consultancy_manager", "sales_manager", "customer_success", "it_manager", "marketing_manager", "hr_manager", "sales", "consultant"];
const roleLabel = (r: string | null | undefined) => (r ? levelName(r) : "No role");
const deptLabel = (d: string | null | undefined) => deptName(d);
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const hue = (s: string) => { let h = 11; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };

interface Person { id: string; name: string; email: string; role: string | null; department: string | null; isSuper: boolean }
type Pos = { right: number; top: number };
const SIZE = 52;
const clampPos = (p: Pos): Pos => ({
  right: Math.min(Math.max(8, p.right), Math.max(8, window.innerWidth - SIZE - 8)),
  top: Math.min(Math.max(8, p.top), Math.max(8, window.innerHeight - SIZE - 8)),
});

export default function SuperAdminBubble() {
  const [me, setMe] = useState<{ id: string; name: string; isSuper: boolean } | null>(null);
  const [on, setOn] = useState(isBubbleOn());
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos>(() => clampPos(readJson<Pos>(POS_KEY) ?? { right: 18, top: 18 }));
  const [people, setPeople] = useState<Person[]>([]);
  const [deptRole, setDeptRole] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState<Person | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const acting = getActAs();
  const preview = getRolePreview(me?.id ?? "-");
  const drag = useRef<{ x: number; y: number; start: Pos; moved: boolean } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    realMe().then((m) => {
      setMe(m);
      // A stale "acting as" note (e.g. you signed in again by hand): forget it.
      const a = getActAs();
      if (a && m && m.id !== a.target.id) { log("clearing a stale act-as record (signed in as", m.name, ")"); clearActAs(); setOn(isBubbleOn()); }
    }).catch(() => {});
    const sync = () => setOn(isBubbleOn());
    const keep = () => setPos((p) => clampPos(p));
    // After a switch (or a role preview) the app restarts in place: read who we are again.
    const switched = () => {
      setOpen(false); setBusy(false); setConfirm(null); setPeople([]); setTick((n) => n + 1);
      realMe().then(setMe).catch(() => {});
    };
    window.addEventListener(ACT_AS_EVENT, switched);
    window.addEventListener(SUPER_BUBBLE_EVENT, sync);
    window.addEventListener("storage", sync);
    window.addEventListener("resize", keep);
    return () => { window.removeEventListener(ACT_AS_EVENT, switched); window.removeEventListener(SUPER_BUBBLE_EVENT, sync); window.removeEventListener("storage", sync); window.removeEventListener("resize", keep); };
  }, []);

  const visible = !!acting || (!!me?.isSuper && on);

  // People of the organisation (loaded when the panel first opens).
  useEffect(() => {
    if (!open || people.length) return;
    Promise.all([
      supabase.from("profiles").select("*").order("first_name"),
      supabase.from("org_departments").select("dept_key, security_role"),
    ]).then(([{ data }, { data: depts }]) => {
      setPeople(((data ?? []) as any[]).map((p) => ({
        id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "—", email: p.email ?? "",
        role: p.role ?? null, department: p.department ?? null, isSuper: p.is_org_superadmin === true,
      })));
      setDeptRole(Object.fromEntries(((depts ?? []) as any[]).filter((d) => d.security_role).map((d) => [String(d.security_role).toLowerCase(), d.dept_key])));
    }).catch(() => {});
  }, [open, people.length]);

  // Close the panel on Escape / click outside.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setConfirm(null); } };
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (panelRef.current?.contains(t) || t.closest(".sab-bubble")) return;
      setOpen(false); setConfirm(null);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", down);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("pointerdown", down); };
  }, [open]);

  const roles = useMemo(() => {
    const set = new Set<string>(KNOWN_ROLES);
    people.forEach((p) => { if (p.role) set.add(p.role.toLowerCase()); });
    return [...set];
  }, [people]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return people.filter((p) => p.id !== (acting?.target.id ?? me?.id) && p.id !== acting?.admin.id)
      .filter((p) => !n || `${p.name} ${p.email} ${p.role ?? ""} ${p.department ?? ""}`.toLowerCase().includes(n));
  }, [people, q, acting, me]);

  /* drag: a press that moves more than a few pixels drags; otherwise it's a click */
  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: pos, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    setPos(clampPos({ right: d.start.right - dx, top: d.start.top + dy }));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) { setPos((p) => { ls.set(POS_KEY, JSON.stringify(p)); return p; }); return; }
    setOpen((o) => !o); setErr(null); setConfirm(null);
  };

  const pickRole = (role: string | null) => {
    if (role && me) ls.set(PREVIEW_KEY, JSON.stringify({ uid: me.id, role, department: deptRole[role] ?? people.find((p) => p.role === role)?.department ?? null }));
    else ls.del(PREVIEW_KEY);
    setOpen(false);
    restartApp();
  };
  const go = useCallback(async (p: Person) => {
    setBusy(true); setErr(null);
    try {
      if (getActAs()) {
        // Switching person: back to you first (the switch must be asked for as you).
        const a = getActAs()!;
        const { error } = await supabase.auth.setSession(a.original);
        clearActAs();
        if (error) throw new Error("Your own session expired — sign in again.");
        if (a.logId) await callActAs({ action: "stop", logId: a.logId }).catch(() => {});
      }
      await startActingAs({ id: p.id, name: p.name, role: p.role });
    } catch (e: any) {
      setErr(e?.message ?? String(e)); setBusy(false);
    }
  }, []);
  const back = async () => { setBusy(true); setErr(null); try { await returnToMe(); } catch (e: any) { setErr(e?.message ?? String(e)); setBusy(false); } };

  if (!visible) return null;

  const state = acting ? "acting" : preview ? "preview" : "idle";
  const leftHalf = window.innerWidth - pos.right - SIZE / 2 < window.innerWidth / 2;
  const lowerHalf = pos.top + SIZE / 2 > window.innerHeight / 2;
  const panelStyle: React.CSSProperties = {
    top: lowerHalf ? undefined : pos.top + SIZE + 10,
    bottom: lowerHalf ? window.innerHeight - pos.top + 10 : undefined,
    ...(leftHalf ? { left: Math.max(8, window.innerWidth - pos.right - SIZE) } : { right: Math.max(8, pos.right) }),
  };

  return (
    <>
      <button
        type="button"
        className={`sab-bubble is-${state} ${open ? "is-open" : ""}`}
        style={{ right: pos.right, top: pos.top }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        aria-label="Superadmin tools" aria-expanded={open}
        title={acting ? `Acting as ${acting.target.name}` : preview ? `Previewing: ${roleLabel(preview.role)}` : "Superadmin tools — drag to move"}
      >
        {acting ? (
          <span className="sab-av" style={{ ["--h" as string]: hue(acting.target.name) } as React.CSSProperties}>{initials(acting.target.name)}</span>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 8l4.5 3L12 4l4.5 7L21 8l-2 11H5z" /><path d="M5 19h14" />
          </svg>
        )}
        {state !== "idle" && <i className="sab-ring" aria-hidden="true" />}
      </button>

      {state !== "idle" && !open && (
        <span className={`sab-tag is-${state}`} style={{ right: pos.right + SIZE + 8, top: pos.top + 12 }} aria-hidden="true">
          {acting ? <>As <b>{acting.target.name.split(" ")[0]}</b></> : <>Viewing as <b>{roleLabel(preview!.role)}</b></>}
        </span>
      )}

      {open && (
        <div className="sab-panel" ref={panelRef} style={panelStyle} role="dialog" aria-label="Superadmin tools">
          <header className="sab-head">
            <span className="sab-head-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l4.5 3L12 4l4.5 7L21 8l-2 11H5z" /><path d="M5 19h14" /></svg>
            </span>
            <div>
              <span className="sab-eyebrow">Superadmin</span>
              <b className="sab-title">{acting ? "Acting as someone" : preview ? "Previewing a role" : "View the app as…"}</b>
            </div>
            {!acting && (
              <button className="sab-hide" onClick={() => { setBubbleOn(false); setOpen(false); }} title="Hide the bubble (turn it back on in Settings → Organization)">Hide</button>
            )}
          </header>

          {/* where you are now */}
          {acting ? (
            <div className="sab-now is-acting">
              <span className="sab-av is-big" style={{ ["--h" as string]: hue(acting.target.name) } as React.CSSProperties}>{initials(acting.target.name)}</span>
              <div className="sab-now-txt">
                <b>{acting.target.name}</b>
                <small>{roleLabel(acting.target.role)} · since {new Date(acting.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
              </div>
              <button className="sab-back" onClick={back} disabled={busy}>{busy ? "…" : <>Return to {acting.admin.name.split(" ")[0]}</>}</button>
              <p className="sab-warn">Everything you do now is done as {acting.target.name.split(" ")[0]} — including their Outlook.</p>
            </div>
          ) : preview ? (
            <div className="sab-now is-preview">
              <div className="sab-now-txt">
                <b>Viewing as {roleLabel(preview.role)}</b>
                <small>Menus, pages and screens follow this level. What you save is still saved as you.</small>
              </div>
              <button className="sab-back is-soft" onClick={() => pickRole(null)}>Back to my view</button>
            </div>
          ) : null}

          {err && <p className="sab-err" role="alert">{err}</p>}

          <TraceBox />

          {/* preview a security level */}
          {!acting && (
            <section className="sab-sec">
              <span className="sab-sec-h">Preview a security level</span>
              <div className="sab-roles">
                {roles.map((r) => (
                  <button key={r} className={preview?.role === r ? "is-on" : ""} onClick={() => pickRole(preview?.role === r ? null : r)}>{roleLabel(r)}</button>
                ))}
              </div>
            </section>
          )}

          {/* act as someone */}
          <section className="sab-sec sab-people">
            <span className="sab-sec-h">{acting ? "Switch to someone else" : "Act as someone"}</span>
            <label className="sab-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" aria-label="Search people" />
            </label>
            <ul className="sab-list">
              {!people.length && <li className="sab-empty">Loading people…</li>}
              {people.length > 0 && !shown.length && <li className="sab-empty">Nobody matches “{q}”.</li>}
              {shown.map((p) => (
                <li key={p.id} className={confirm?.id === p.id ? "is-confirm" : ""}>
                  {confirm?.id === p.id ? (
                    <div className="sab-confirm">
                      <p>Act as <b>{p.name}</b>? You'll see and do exactly what they can — as them.</p>
                      <div>
                        <button className="sab-btn" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
                        <button className="sab-btn is-go" onClick={() => go(p)} disabled={busy}>{busy ? "Switching…" : `Act as ${p.name.split(" ")[0]}`}</button>
                      </div>
                    </div>
                  ) : (
                    <button className="sab-person" onClick={() => { setConfirm(p); setErr(null); }}>
                      <span className="sab-av" style={{ ["--h" as string]: hue(p.name) } as React.CSSProperties}>{initials(p.name)}</span>
                      <span className="sab-person-txt">
                        <b>{p.name}{p.isSuper && <i className="sab-super">Superadmin</i>}</b>
                        <small>{[roleLabel(p.role), deptLabel(p.department)].filter(Boolean).join(" · ")}</small>
                      </span>
                      <span className="sab-go" aria-hidden="true">→</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </>
  );
}

/**
 * The switch in Settings → Organization (next to Page access) that shows or
 * hides the bubble. Only superadmins see it.
 */
export function SuperAdminSwitch() {
  const { ready, isSuper, why } = useSuperCheck();
  const [on, setOn] = useState(isBubbleOn());
  useEffect(() => {
    const sync = () => setOn(isBubbleOn());
    window.addEventListener(SUPER_BUBBLE_EVENT, sync);
    return () => window.removeEventListener(SUPER_BUBBLE_EVENT, sync);
  }, []);
  if (!ready) return null;
  // Not a superadmin: shown greyed out, saying exactly why (so it's never a mystery).
  if (!isSuper && !getActAs()) {
    return (
      <button type="button" className="st-sa-btn is-locked" disabled
        title={`Organisation superadmins only. Your profile: ${why}. In Supabase: update profiles set is_org_superadmin = true where id = '<your id>'; then reload.`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8l4.5 3L12 4l4.5 7L21 8l-2 11H5z" /><path d="M5 19h14" /></svg>
        Superadmin
      </button>
    );
  }
  return (
    <button type="button" className={`st-sa-btn ${on ? "is-on" : ""}`} role="switch" aria-checked={on}
      onClick={() => setBubbleOn(!on)}
      title={on ? "Hide the superadmin bubble" : "Show the superadmin bubble: preview a role or act as someone"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8l4.5 3L12 4l4.5 7L21 8l-2 11H5z" /><path d="M5 19h14" /></svg>
      Superadmin
      <i aria-hidden="true" />
    </button>
  );
}

/** The last switch's step-by-step log, with Copy (to paste it to whoever is fixing it). */
function TraceBox() {
  const [tr, setTr] = useState(readTrace());
  const [copied, setCopied] = useState(false);
  if (!tr.lines.length) return null;
  const text = tr.lines.map((l) => `${l.t}  ${l.m}`).join("\n");
  return (
    <details className="sab-trace">
      <summary>Last switch log <i>{tr.lines.length} steps</i></summary>
      <pre>{text}</pre>
      <div>
        <button className="sab-btn" onClick={() => { ls.del(TRACE_KEY); setTr({ armedUntil: 0, lines: [] }); }}>Clear</button>
        <button className="sab-btn is-go" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>
    </details>
  );
}