/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home page.
 *
 *   homepage/
 *     HomePage.tsx          ← this: greeting + layout, picks the right home
 *     shared/               ← what everyone gets, in the left column
 *       HomeCalendar.tsx      next 5 working days · month · coming up
 *       HomeTodo.tsx          my to-do (tasks from Sales for now)
 *     sales/SalesHome.tsx         ← right side for the sales team
 *     consultancy/ConsultancyHome ← right side for consultancy
 *     management/ManagementHome   ← right side for the boss / managers
 *
 * Which right side you get goes by DEPARTMENT first (a boss inside
 * consultancy sees consultancy), then by role. Anyone else gets the shared
 * column on its own, spread across the page.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import HomeCalendar from "./shared/HomeCalendar";
import HomeTodo, { TicketDesk, TicketDrawer, TicketDrawerById, TkIco, Avatar, loadDirectory, loadTicketTypes, ticketRef, stageLabel, TICKETS_EVENT, type Directory, type TicketStage } from "./shared/HomeTodo";
import SalesHome from "./sales/SalesHome";
import ConsultancyHome from "./consultancy/ConsultancyHome";
import ManagementHome from "./management/ManagementHome";
import { applyRolePreview } from "../../framework/SuperAdmin";
import { PageCube } from "../../framework/AppLayout";
import "./HomePage.css";

const greeting = () => {
  const h = new Date().getHours();
  if (h < 6) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 19) return "Good afternoon";
  return "Good evening";
};

const NextLogo = () => (
  <svg viewBox="14 15 92 93" role="img" aria-label="Next">
    <g transform="matrix(1,0.5,-1,0.5,60,17)">
      <rect width="38" height="38" rx="2" fill="#86efc0" />
      <polyline points="7,30 15,19 22,24 31.7,10.1" fill="none" stroke="#0a6f4d" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <polygon points="36,4 35.1,12.5 28.2,7.7" fill="#0a6f4d" />
    </g>
    <g transform="translate(16,47) skewY(26.565)"><rect width="38" height="40" rx="2" fill="#12b57f" /><path d="M10.5 31V10h5.1l6.8 12.6V10h5.1v21h-5.1l-6.8-12.6V31z" fill="#fff" /></g>
    <g transform="translate(66,66) skewY(-26.565)"><rect width="38" height="40" rx="2" fill="#0a6f4d" /><rect x="6" y="24" width="6" height="11" rx="1.5" fill="#fff" /><rect x="16" y="16" width="6" height="19" rx="1.5" fill="#fff" /><rect x="26" y="8" width="6" height="27" rx="1.5" fill="#fff" /></g>
  </svg>
);

/* ---------------------------------------------------------------------------
   Booting the home page — a paced sequence tied to what is really loading.
   Each step ticks only once its data has actually arrived (the session, your
   profile, then a count from the calendar, the tickets and the team), and the
   ring fills only once the panels underneath have stopped changing.
     · after the sign-in ("arrive"): full screen, on the same deep green the
       sign-in left; at the end the cube and the ring shrink into the rail's
       Home icon while the screen closes in after them.
     · on a direct visit ("page"): the same sequence in the page, lighter.
   Reduced motion: no choreography, the page shows as soon as it can.
   --------------------------------------------------------------------------- */
const JUST_SIGNED_IN_KEY = "next:just-signed-in";
const prefersStill = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
type StepKey = "auth" | "workspace" | "calendar" | "tickets" | "team";
const BOOT_STEPS: { k: StepKey; label: string }[] = [
  { k: "auth", label: "Authenticating" },
  { k: "workspace", label: "Loading your workspace" },
  { k: "calendar", label: "Calendar" },
  { k: "tickets", label: "Tickets" },
  { k: "team", label: "Team" },
];
type BootMode = "arrive" | "page";
type BootPhase = "boot" | "done" | "out" | "none";
interface Boot { mode: BootMode; phase: BootPhase; ticked: number; progress: number }

function useBoot(ready: Record<StepKey, boolean>, settled: boolean): Boot {
  const [mode] = useState<BootMode>(() => {
    try {
      const v = sessionStorage.getItem(JUST_SIGNED_IN_KEY);
      if (v && Date.now() - Number(v) < 15000 && !prefersStill()) return "arrive";
    } catch { /* ignore */ }
    return "page";
  });
  const [, render] = useState(0);
  const st = useRef({ phase: "boot" as BootPhase, ticked: 0, t0: performance.now(), last: 0, at: 0 });
  const live = useRef({ ready, settled });
  live.current = { ready, settled };
  // played once: forget it (in an effect, so a strict-mode double render still sees it)
  useEffect(() => { try { sessionStorage.removeItem(JUST_SIGNED_IN_KEY); } catch { /* ignore */ } }, []);
  useEffect(() => {
    const still = prefersStill();
    // pacing: the first tick after the cube has settled, then one step at a time
    const START = still ? 0 : mode === "arrive" ? 520 : 260;
    const GAP = still ? 0 : mode === "arrive" ? 400 : 270;
    const HOLD = still ? 0 : mode === "arrive" ? 520 : 320;
    const OUT = still ? 0 : mode === "arrive" ? 1080 : 560;
    const s = st.current;
    const id = window.setInterval(() => {
      const now = performance.now(), t = now - s.t0;
      const { ready: r, settled: done } = live.current;
      if (s.phase === "boot") {
        if (s.ticked < BOOT_STEPS.length) {
          const k = BOOT_STEPS[s.ticked].k;
          if (t >= START && now - s.last >= GAP && (r[k] || t > 8000)) { s.ticked += 1; s.last = now; render((x) => x + 1); }
        } else if (now - s.last >= GAP * 0.8 && (done || t > 10000)) { s.phase = "done"; s.at = now; render((x) => x + 1); }
      } else if (s.phase === "done" && now - s.at >= HOLD) { s.phase = "out"; s.at = now; render((x) => x + 1); }
      else if (s.phase === "out" && now - s.at >= OUT) { s.phase = "none"; render((x) => x + 1); window.clearInterval(id); }
    }, 50);
    return () => window.clearInterval(id);
  }, [mode]);
  const s = st.current;
  const progress = s.phase === "boot" ? (s.ticked / BOOT_STEPS.length) * 0.9 : 1;
  return { mode, phase: s.phase, ticked: s.ticked, progress };
}

/** Quiet = nothing in the page has changed for a moment (the panels have drawn their data). */
function useSettled(root: React.RefObject<HTMLElement | null>, armed: boolean): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!armed || settled || !root.current) return;
    let timer = window.setTimeout(() => setSettled(true), 450);
    const mo = new MutationObserver((recs) => {
      if (recs.every((r) => (r.target as Element).closest?.(".home-boot") || (r.target.parentElement?.closest(".home-boot")))) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setSettled(true), 450);
    });
    mo.observe(root.current, { childList: true, subtree: true, characterData: true });
    return () => { mo.disconnect(); window.clearTimeout(timer); };
  }, [root, armed, settled]);
  return settled;
}

function HomeBoot({ boot, details, hello, top }: { boot: Boot; details: Partial<Record<StepKey, string>>; hello: string; top: number }) {
  const ref = useRef<HTMLDivElement>(null);
  // at the end, fly into the rail's Home icon: measure it exactly
  useEffect(() => {
    if (boot.mode !== "arrive" || boot.phase !== "out" || !ref.current) return;
    const icon = document.querySelector<HTMLElement>(".rail-item.k-home .rail-ico") ?? document.querySelector<HTMLElement>(".rail-item.k-home");
    const W = window.innerWidth, H = window.innerHeight;
    const r = icon?.getBoundingClientRect();
    const ix = r ? r.left + r.width / 2 : 34, iy = r ? r.top + r.height / 2 : 36, is = r ? Math.max(r.width, r.height) : 24;
    const el = ref.current;
    el.style.setProperty("--ix", `${ix}px`);
    el.style.setProperty("--iy", `${iy}px`);
    el.style.setProperty("--tx", `${ix - W / 2}px`);
    el.style.setProperty("--ty", `${iy - H * 0.46}px`);
    el.style.setProperty("--ts", `${(is * 1.15) / 168}`);
    const item = document.querySelector<HTMLElement>(".rail-item.k-home");
    const t1 = window.setTimeout(() => item?.classList.add("is-landing"), 820);
    const t2 = window.setTimeout(() => item?.classList.remove("is-landing"), 1900);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); item?.classList.remove("is-landing"); };
  }, [boot.mode, boot.phase]);

  const pct = Math.round(boot.progress * 100);
  return (
    <div ref={ref} className={`home-boot is-${boot.mode} is-${boot.phase}`} style={boot.mode === "page" ? { top } : undefined}
      role="status" aria-live="polite" aria-label={boot.phase === "boot" ? `Loading your home, ${pct}%` : "Home ready"}>
      {boot.mode === "arrive" ? <div className="hb-bg" aria-hidden="true"><i className="hb-grid" /><i className="hb-aura" /></div> : (
        <div className="hl-skel" aria-hidden="true">
          <div className="hl-col"><i className="is-tall" /><i /></div>
          <div className="hl-col"><i className="is-full" /></div>
          <div className="hl-col"><i /><i className="is-tall" /></div>
        </div>
      )}
      <div className="hb-orb" aria-hidden="true">
        <span className="hb-glow" />
        <svg className="hb-ring" viewBox="0 0 200 200">
          <circle className="hb-ring-track" cx="100" cy="100" r="92" />
          <circle className="hb-ring-fill" cx="100" cy="100" r="92" pathLength={1} style={{ strokeDashoffset: 1 - boot.progress }} />
        </svg>
        <span className="hb-orbit-dot" />
        <div className="hb-cube-pos"><span className="hb-pc"><PageCube size={boot.mode === "arrive" ? 250 : 160} /></span></div>
      </div>
      <div className="hb-panel">
        <p className="hb-hi">{hello}</p>
        <ol className="hb-steps">
          {BOOT_STEPS.map((s, i) => {
            const state = i < boot.ticked ? "is-done" : i === boot.ticked && boot.phase === "boot" ? "is-active" : "";
            return (
              <li key={s.k} className={state}>
                <span className="hb-mark" aria-hidden="true">
                  <svg viewBox="0 0 16 16"><path d="M4 8.4l2.6 2.6L12 5.4" pathLength={1} /></svg>
                </span>
                <b>{s.label}</b>
                <em>{i < boot.ticked ? details[s.k] ?? "" : ""}</em>
              </li>
            );
          })}
        </ol>
        <span className="hb-pct">{boot.phase === "boot" ? `${pct}%` : "Ready"}</span>
      </div>
    </div>
  );
}

const areaTitle = (a: Area) => a === "consultancy" ? "Consultancy" : a === "sales" ? "Sales" : a === "management" ? "Management" : "Next Management";

type Me = { id: string; department: string | null; role: string | null; firstName: string | null; isSuper: boolean };
type Area = "sales" | "consultancy" | "management" | null;

const SALES_ROLES = ["sales", "sales_manager"];
const MANAGER_ROLES = ["boss", "consultancy_manager", "sales_manager"];

function areaFor(me: Me | null, authRole: string | null): Area {
  if (!me) return null;
  const role = (me.role ?? authRole ?? "").toLowerCase();
  if (me.department === "consultancy") return "consultancy";
  if (me.department === "sales" || SALES_ROLES.includes(role)) return "sales";
  if (MANAGER_ROLES.includes(role) || me.isSuper) return "management";
  return null;
}

export default function HomePage() {
  const { role } = useAuth();
  const [uid, setUid] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [hoursPerDay, setHoursPerDay] = useState(8);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Local session (no trip to the auth server, which would hold up every other query).
      const { data: s } = await supabase.auth.getSession();
      const uid = s?.session?.user?.id;
      if (!uid) return;
      setUid(uid); // the shared column only needs this — it starts loading straight away
      const [{ data: prof }, { data: bs }] = await Promise.all([
        supabase.from("profiles").select("id, department, role, first_name, is_superadmin").eq("id", uid).maybeSingle(),
        supabase.from("billing_settings").select("hours_per_day").eq("id", "default").maybeSingle(),
      ]);
      if (!alive) return;
      const p = prof ? applyRolePreview(prof as any) : null; // superadmin previewing a role
      setMe({ id: uid, department: p?.department ?? null, role: p?.role ?? role ?? null, firstName: p?.first_name ?? null, isSuper: p?.is_superadmin === true });
      setHoursPerDay(Number((bs as any)?.hours_per_day) || 8);
    })();
    return () => { alive = false; };
  }, [role]);

  const area = areaFor(me, role ?? null);
  const r = (me?.role ?? role ?? "").toLowerCase();
  const isLead = r === "boss" || r === "consultancy_manager";
  const seesSalesTeam = r === "boss" || r === "sales_manager" || !!me?.isSuper;

  // ---- the boot sequence: real probes behind every step ----
  const [probe, setProbe] = useState<{ calendar?: number | null; tickets?: number | null; team?: number | null }>({});
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const run = (k: "calendar" | "tickets" | "team", q: PromiseLike<{ count: number | null; error: unknown }>) =>
      Promise.resolve(q).then((res) => { if (alive) setProbe((p) => ({ ...p, [k]: res.error ? null : res.count ?? null })); }, () => { if (alive) setProbe((p) => ({ ...p, [k]: null })); });
    run("calendar", supabase.from("calendar_entries").select("id", { count: "exact", head: true }).eq("user_id", uid).gte("entry_date", day(0)).lte("entry_date", day(14)) as any);
    run("tickets", supabase.from("tracking_tasks").select("id", { count: "exact", head: true }).eq("assignee_id", uid).eq("done", false) as any);
    run("team", supabase.from("profiles").select("id", { count: "exact", head: true }) as any);
    return () => { alive = false; };
  }, [uid]);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const settled = useSettled(rootRef, !!me);
  const boot = useBoot({ auth: !!uid, workspace: !!me, calendar: "calendar" in probe, tickets: "tickets" in probe, team: "team" in probe }, settled);
  const n = (v: number | null | undefined, one: string, many: string) => (typeof v === "number" ? `${v} ${v === 1 ? one : many}` : "");
  const details: Partial<Record<StepKey, string>> = {
    auth: "Signed in",
    workspace: me ? `${areaTitle(area)}` : "",
    calendar: n(probe.calendar, "entry ahead", "entries ahead"),
    tickets: n(probe.tickets, "open", "open"),
    team: n(probe.team, "person", "people"),
  };
  const [bootTop, setBootTop] = useState(90);
  useEffect(() => {
    const m = () => { const b = barRef.current; if (b) setBootTop(b.offsetTop + b.offsetHeight + 12); };
    m(); window.addEventListener("resize", m);
    return () => window.removeEventListener("resize", m);
  }, []);
  const booting = boot.phase === "boot" || boot.phase === "done";
  const hello = `${greeting()}${me?.firstName ? `, ${me.firstName}` : ""}`;

  return (
    <div ref={rootRef} className={`home ${booting ? (boot.mode === "arrive" ? "is-held" : "is-held-grid") : ""} ${boot.phase === "out" ? `is-revealing is-revealing-${boot.mode}` : ""}`}>
      {boot.phase !== "none" && <HomeBoot boot={boot} details={details} hello={hello} top={bootTop} />}

      <header className="home-bar" ref={barRef}>
        <span className="home-logo-mini" aria-hidden="true"><NextLogo /></span>
        <div className="home-hello">
          <span className="home-eyebrow">{areaTitle(area)}</span>
          <h1 className="home-title">{greeting()}{me?.firstName ? <>, <em>{me.firstName}</em></> : ""}</h1>
        </div>
        <GlobalSearch />
        <span className="home-date">{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</span>
      </header>

      {!uid || !me ? (
        <div className="home-wait" aria-hidden="true" />
      ) : area === "consultancy" ? (
        <ConsultancyHome userId={me.id} isLead={isLead} hoursPerDay={hoursPerDay}
          calendar={<HomeCalendar userId={uid} hoursPerDay={hoursPerDay} />}
          desk={<TicketDesk />} />
      ) : (
        <div className={`home-grid ${me && !area ? "is-solo" : ""}`}>
          <aside className="home-side">
            <HomeCalendar userId={uid} hoursPerDay={hoursPerDay} />
            <HomeTodo />
          </aside>
          {area && (
            <main className="home-main">
              {area === "sales" && <SalesHome userId={me.id} seesTeam={seesSalesTeam} />}
              {area === "management" && <ManagementHome />}
            </main>
          )}
        </div>
      )}
    </div>
  );
}

/* =====================================================================
   GLOBAL SEARCH — one box for everything: companies, contacts, clients,
   deals, projects, tickets and people. ⌘K / Ctrl K or "/" from anywhere on
   the page. Empty, it suggests: what you opened lately, your open tickets
   and your next meetings. Results are grouped by kind; ↑ ↓ Enter to open.
   ===================================================================== */
type HitKind = "client" | "company" | "contact" | "deal" | "project" | "ticket" | "person" | "meeting" | "action";
interface Hit { kind: HitKind; id: string; label: string; sub?: string; score?: number; stage?: TicketStage; extra?: any }
const KIND_LABEL: Record<HitKind, string> = { client: "Clients", company: "Companies", contact: "Contacts", deal: "Deals", project: "Projects", ticket: "Tickets", person: "People", meeting: "Up next", action: "Actions" };
const KIND_ONE: Record<HitKind, string> = { client: "Client", company: "Company", contact: "Contact", deal: "Deal", project: "Project", ticket: "Ticket", person: "Person", meeting: "Meeting", action: "" };
const KIND_ICON: Record<HitKind, "briefcase" | "building" | "user" | "deal" | "folder" | "inbox" | "clock" | "plus"> = {
  client: "briefcase", company: "building", contact: "user", deal: "deal", project: "folder", ticket: "inbox", person: "user", meeting: "clock", action: "plus",
};
const ORDER: HitKind[] = ["ticket", "client", "deal", "company", "contact", "project", "person"];
const RECENT_KEY = "home.search.recent";
const readRecent = (): Hit[] => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(v) ? v.slice(0, 6) : []; } catch { return []; } };
const pushRecent = (h: Hit) => {
  if (h.kind === "action" || h.kind === "meeting") return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([{ kind: h.kind, id: h.id, label: h.label, sub: h.sub }, ...readRecent().filter((x) => !(x.kind === h.kind && x.id === h.id))].slice(0, 6))); } catch { /* private mode */ }
};
const fold = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** How well `text` answers `q`: whole start > a word start > anywhere (0 = no match). */
function scoreOf(text: string, q: string): number {
  const t = fold(text);
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (new RegExp(`(^|[\\s@._\\-/(])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t)) return 60;
  if (t.includes(q)) return 35;
  // every word of the query somewhere
  const words = q.split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every((w) => t.includes(w)) ? 25 : 0;
}
function Mark({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = fold(text).indexOf(q);
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export function GlobalSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<Directory | null>(null);
  const [tickets, setTickets] = useState<{ id: string; title: string; no: number | null; stage: TicketStage; due: string | null; assignee: string | null; active: boolean }[]>([]);
  const [meetings, setMeetings] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const [recent, setRecent] = useState<Hit[]>([]);
  const [ticketOpen, setTicketOpen] = useState<string | null>(null);
  const [newTicket, setNewTicket] = useState<string | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  const loadAll = () => {
    loaded.current = true;
    loadDirectory().then(setDir).catch(() => {});
    loadTicketTypes().then(setTypes).catch(() => {});
    (async () => {
      let r: any = await supabase.from("tracking_tasks").select("id, title, ticket_no, stage, done, status, due_at, assignee_id").order("created_at", { ascending: false }).range(0, 4999);
      if (r.error) r = await supabase.from("tracking_tasks").select("id, title, done, status, due_at").order("created_at", { ascending: false }).range(0, 4999);
      setTickets(((r.data ?? []) as any[]).map((t) => {
        const stage: TicketStage = t.stage ?? (t.done || t.status === "done" ? "resolved" : t.status === "in_progress" ? "in_progress" : t.status === "blocked" ? "waiting" : "open");
        return { id: t.id, title: t.title ?? "", no: t.ticket_no ?? null, stage, due: t.due_at ?? null, assignee: t.assignee_id ?? null, active: !["resolved", "closed"].includes(stage) };
      }));
      const { data: s } = await supabase.auth.getSession();
      const me = s?.session?.user?.id;
      if (!me) return;
      const today = new Date(); const to = new Date(); to.setDate(to.getDate() + 14);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const { data: ev } = await supabase.from("calendar_entries").select("id, entry_date, start_min, kind, title, notes").eq("user_id", me).eq("kind", "meeting").gte("entry_date", iso(today)).lte("entry_date", iso(to)).order("entry_date").limit(30);
      const nowMin = today.getHours() * 60 + today.getMinutes();
      setMeetings(((ev ?? []) as any[]).filter((e) => e.kind === "meeting" && (e.entry_date > iso(today) || (e.start_min ?? 0) >= nowMin))
        .sort((a, b) => a.entry_date.localeCompare(b.entry_date) || (a.start_min ?? 0) - (b.start_min ?? 0)).slice(0, 3)
        .map((e) => ({ kind: "meeting" as const, id: e.id, label: e.title || e.notes || "Meeting",
          sub: `${new Date(e.entry_date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · ${String(Math.floor((e.start_min ?? 0) / 60)).padStart(2, "0")}:${String((e.start_min ?? 0) % 60).padStart(2, "0")}` })));
    })().catch(() => {});
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "") || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); inputRef.current?.focus(); }
    };
    const down = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const changed = () => { if (loaded.current) loadAll(); };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", down);
    window.addEventListener(TICKETS_EVENT, changed);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("mousedown", down); window.removeEventListener(TICKETS_EVENT, changed); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fq = fold(q.trim());
  const sections = useMemo((): { kind: HitKind; title: string; hits: Hit[] }[] => {
    const me = dir?.me ?? null;
    const coName = new Map((dir?.companies ?? []).map((c) => [c.id, c.name]));
    const clName = new Map((dir?.clients ?? []).map((c) => [c.id, c.name]));
    if (!fq) {
      const mine = tickets.filter((t) => t.active && t.assignee === me).sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9")).slice(0, 4)
        .map((t) => ({ kind: "ticket" as const, id: t.id, label: t.title, sub: `${ticketRef(t)} · ${stageLabel(t.stage)}${t.due ? ` · due ${new Date(t.due).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}`, stage: t.stage }));
      const out: { kind: HitKind; title: string; hits: Hit[] }[] = [];
      if (recent.length) out.push({ kind: "client", title: "Recent", hits: recent });
      if (mine.length) out.push({ kind: "ticket", title: "Your open tickets", hits: mine });
      if (meetings.length) out.push({ kind: "meeting", title: "Up next", hits: meetings });
      return out;
    }
    const all: Hit[] = [];
    const add = (kind: HitKind, id: string, label: string, sub: string | undefined, texts: string[], boost = 0, extra?: any) => {
      const sc = Math.max(...texts.map((t) => scoreOf(t, fq)));
      if (sc > 0) all.push({ kind, id, label, sub, score: sc + boost, extra });
    };
    tickets.forEach((t) => add("ticket", t.id, t.title, `${ticketRef(t)} · ${stageLabel(t.stage)}`, [t.title, ticketRef(t), t.no ? String(t.no) : ""], t.active ? 4 : -10, t));
    (dir?.clients ?? []).forEach((c) => add("client", c.id, c.name, "Client", [c.name], 6));
    (dir?.deals ?? []).forEach((d) => add("deal", d.id, d.name, [d.companyId ? coName.get(d.companyId) : null, d.status].filter(Boolean).join(" · ") || "Deal", [d.name, d.companyId ? coName.get(d.companyId) ?? "" : ""], d.status === "active" ? 3 : 0));
    (dir?.companies ?? []).forEach((c) => add("company", c.id, c.name, c.legal && c.legal !== c.name ? c.legal : "Company", [c.name, c.legal ?? ""]));
    (dir?.contacts ?? []).forEach((c) => add("contact", c.id, c.name, [c.title, c.email].filter(Boolean).join(" · ") || "Contact", [c.name, c.email ?? ""]));
    (dir?.projects ?? []).forEach((p) => add("project", p.id, p.name, p.clientId ? clName.get(p.clientId) : "Project", [p.name, p.clientId ? clName.get(p.clientId) ?? "" : ""], 0, p));
    (dir?.people ?? []).forEach((p) => add("person", p.id, p.name, [p.department, p.email].filter(Boolean).join(" · "), [p.name, p.email], -2));
    const best = [...all].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const out: { kind: HitKind; title: string; hits: Hit[] }[] = [];
    if (best[0] && (best[0].score ?? 0) >= 60) out.push({ kind: best[0].kind, title: "Top hit", hits: [best[0]] });
    ORDER.forEach((k) => {
      const hits = best.filter((h) => h.kind === k && h !== out[0]?.hits[0]).slice(0, k === "ticket" ? 4 : 3);
      if (hits.length) out.push({ kind: k, title: KIND_LABEL[k], hits });
    });
    out.push({ kind: "action", title: "Actions", hits: [{ kind: "action", id: "new-ticket", label: `Log a ticket: “${q.trim()}”`, sub: "Lands on your desk" }] });
    return out;
  }, [fq, q, dir, tickets, meetings, recent]);
  const flat = sections.flatMap((s) => s.hits);
  useEffect(() => { setSel(0); }, [fq]);

  const go = (h: Hit) => {
    pushRecent(h);
    setOpen(false); setQ("");
    inputRef.current?.blur();
    switch (h.kind) {
      case "company": nav("/companies", { state: { focusCompanyId: h.id } }); break;
      case "contact": nav("/contacts", { state: { focusContactId: h.id } }); break;
      case "client": nav(`/clients?client=${h.id}`); break;
      case "deal": nav(`/sales?tracking=${h.id}`); break;
      case "project": { const p = dir?.projects.find((x) => x.id === h.id); nav(p?.clientId ? `/clients?client=${p.clientId}` : "/projects"); break; }
      case "ticket": setTicketOpen(h.id); break;
      case "meeting": nav("/calendar"); break;
      case "person": { const p = dir?.people.find((x) => x.id === h.id); if (p?.email) window.location.href = `mailto:${p.email}`; break; }
      case "action": setNewTicket(q.trim()); break;
    }
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { const h = flat[sel]; if (h) go(h); }
    else if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
  };
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  let idx = -1;
  const loading = open && !dir;

  return (
    <div className={`gs ${open ? "is-open" : ""}`} ref={boxRef}>
      <div className="gs-box" onClick={() => inputRef.current?.focus()}>
        <TkIco d="search" className="gs-ico" />
        <input ref={inputRef} value={q} placeholder="Search anything — clients, deals, contacts, tickets…" aria-label="Search everything"
          onFocus={() => { setOpen(true); setRecent(readRecent()); if (!loaded.current) loadAll(); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown={onKey} />
        {q ? <button type="button" className="gs-clear" onClick={() => { setQ(""); inputRef.current?.focus(); }} aria-label="Clear"><TkIco d="x" /></button>
          : <kbd className="gs-kbd">{isMac ? "⌘" : "Ctrl"} K</kbd>}
      </div>
      {open && (
        <div className="gs-panel" role="listbox">
          {loading ? <div className="gs-loading"><span className="gs-spin" />Loading everything…</div>
            : !sections.length ? <p className="gs-empty">Start typing to search clients, deals, companies, contacts, projects, tickets and people.</p>
            : sections.map((s, si) => (
              <div className="gs-sec" key={`${s.title}-${si}`}>
                <span className="gs-sec-h">{s.title}</span>
                {s.hits.map((h) => {
                  idx += 1;
                  const i = idx;
                  const person = h.kind === "person" ? dir?.people.find((p) => p.id === h.id) : null;
                  return (
                    <button type="button" key={`${h.kind}-${h.id}`} className={`gs-hit is-${h.kind} ${i === sel ? "is-sel" : ""}`} role="option" aria-selected={i === sel}
                      onMouseEnter={() => setSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => go(h)}>
                      {person ? <Avatar person={person} size={30} /> : <span className="gs-hit-ico"><TkIco d={KIND_ICON[h.kind]} /></span>}
                      <span className="gs-hit-txt">
                        <b><Mark text={h.label} q={fq} /></b>
                        {h.sub && <em>{h.sub}</em>}
                      </span>
                      {h.kind !== "action" && <span className="gs-hit-kind">{KIND_ONE[h.kind]}</span>}
                      <span className="gs-hit-go" aria-hidden="true">↵</span>
                    </button>
                  );
                })}
              </div>
            ))}
          {!loading && fq && flat.length <= 1 && <p className="gs-empty">Nothing found for “{q.trim()}”.</p>}
          <div className="gs-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
        </div>
      )}
      {ticketOpen && <TicketDrawerById id={ticketOpen} onClose={() => setTicketOpen(null)} />}
      {newTicket !== null && dir && (
        <TicketDrawer ticket={null} draft={{ title: newTicket, assignee: dir.me }} dir={dir} types={types.length ? types : ["Request"]} ready={tickets.length === 0 || tickets.some((t) => t.no != null)}
          onClose={() => setNewTicket(null)} onCreated={(id) => { setNewTicket(null); setTicketOpen(id); }} />
      )}
    </div>
  );
}
