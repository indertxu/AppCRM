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
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { MentionText, mentionsToPlain } from "../../framework/MentionInput";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import HomeCalendar from "./shared/HomeCalendar";
import HomeTodo, { TicketDesk, TicketDrawer, TicketDrawerById, TkIco, Avatar, loadDirectory, loadTicketTypes, ticketRef, stageLabel, TICKETS_EVENT, type Directory, type TicketStage, type ItemCat } from "./shared/HomeTodo";
import SalesHome from "./sales/SalesHome";
import ConsultancyHome from "./consultancy/ConsultancyHome";
import ManagementHome from "./management/ManagementHome";
import { applyRolePreview } from "../../framework/SuperAdmin";
import { PageCube } from "../../framework/AppLayout";
import { usePageAccess, goToSection, guardedLeave, deptName, type PageKey } from "../../framework/pageAccess";
import { isSalesLead, globalSearch, type SearchHit } from "../companies/companiesApi";
import { loadMyInvites, loadMyReplies, markRepliesSeen, answerInvite, declineInvite, type InviteCard } from "../calendar/invitesApi";
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
    // coming back to Home ("page"): no show — each step ticks as soon as its data is in
    const START = still ? 0 : mode === "arrive" ? 520 : 0;
    const GAP = still ? 0 : mode === "arrive" ? 400 : 60;
    const HOLD = still ? 0 : mode === "arrive" ? 520 : 120;
    const OUT = still ? 0 : mode === "arrive" ? 1080 : 420;
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
  // the in-page loader sits right under the greeting / hero — measured once the hero is really there
  // (it appears only after your profile loads; measuring on mount put the loader over the hero)
  const [bootTop, setBootTop] = useState(0);
  useEffect(() => {
    const m = () => {
      const b = barRef.current, root = rootRef.current;
      if (!b || !root) { setBootTop(0); return; }
      setBootTop(Math.round(b.getBoundingClientRect().bottom - root.getBoundingClientRect().top + 12));
    };
    m();
    const b = barRef.current;
    const ro = b && typeof ResizeObserver !== "undefined" ? new ResizeObserver(m) : null;
    if (b) ro?.observe(b);
    window.addEventListener("resize", m);
    return () => { ro?.disconnect(); window.removeEventListener("resize", m); };
  }, [me, area]);
  const booting = boot.phase === "boot" || boot.phase === "done";
  const hello = `${greeting()}${me?.firstName ? `, ${me.firstName}` : ""}`;
  const alerts = useHomeAlerts(uid && me ? uid : null);

  return (
    <div ref={rootRef} className={`home ${area === "consultancy" || area === "sales" ? "is-cons" : ""} ${area === "sales" ? "is-sales" : ""} ${booting ? (boot.mode === "arrive" ? "is-held" : "is-held-grid") : ""} ${boot.phase === "out" ? `is-revealing is-revealing-${boot.mode}` : ""}`}>
      {boot.phase !== "none" && <HomeBoot boot={boot} details={details} hello={hello} top={bootTop} />}

      {area !== "consultancy" && area !== "sales" && (
        <header className="home-bar" ref={barRef}>
          <span className="home-logo-mini" aria-hidden="true"><NextLogo /></span>
          <h1 className="home-title">{greeting()}{me?.firstName ? <>, <em>{me.firstName}</em></> : ""}</h1>
          <span className="home-date">{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</span>
          {area && <span className="home-area">{areaTitle(area)}</span>}
          {uid && me && <HomeAlertsBell h={alerts} />}
        </header>
      )}

      {!uid || !me ? (
        <div className="home-wait" aria-hidden="true" />
      ) : area === "consultancy" ? (
        <ConsultancyHome userId={me.id} isLead={isLead} hoursPerDay={hoursPerDay}
          greeting={greeting()} firstName={me.firstName} heroRef={barRef}
          alertsBell={<HomeAlertsBell h={alerts} tone="dark" />}
          calendar={<HomeCalendar userId={uid} hoursPerDay={hoursPerDay} />}
          desk={<TicketDesk />} />
      ) : area === "sales" ? (
        <SalesHome userId={me.id} seesTeam={seesSalesTeam}
          greeting={greeting()} firstName={me.firstName} heroRef={barRef}
          alertsBell={<HomeAlertsBell h={alerts} tone="dark" />}
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
type HitKind = "page" | "client" | "company" | "contact" | "deal" | "project" | "ticket" | "person" | "meeting" | "action";
interface Hit { kind: HitKind; id: string; label: string; sub?: string; score?: number; stage?: TicketStage; extra?: any }
const KIND_LABEL: Record<HitKind, string> = { page: "Go to", client: "Clients", company: "Companies", contact: "Contacts", deal: "Deals", project: "Projects", ticket: "Tickets & tasks", person: "People", meeting: "Up next", action: "Actions" };
const KIND_ONE: Record<HitKind, string> = { page: "Page", client: "Client", company: "Company", contact: "Contact", deal: "Deal", project: "Project", ticket: "Ticket", person: "Person", meeting: "Meeting", action: "" };
const KIND_ICON: Record<HitKind, "arrow" | "briefcase" | "building" | "user" | "deal" | "folder" | "inbox" | "clock" | "plus"> = {
  page: "arrow", client: "briefcase", company: "building", contact: "user", deal: "deal", project: "folder", ticket: "inbox", person: "user", meeting: "clock", action: "plus",
};
const ORDER: HitKind[] = ["page", "ticket", "client", "deal", "company", "contact", "project", "person"];
const RECENT_KEY = "home.search.recent";
const readRecent = (): Hit[] => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(v) ? v.slice(0, 6) : []; } catch { return []; } };
const pushRecent = (h: Hit) => {
  if (h.kind === "action" || h.kind === "meeting") return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([{ kind: h.kind, id: h.id, label: h.label, sub: h.sub, ...(h.kind === "page" ? { extra: h.extra } : {}) }, ...readRecent().filter((x) => !(x.kind === h.kind && x.id === h.id))].slice(0, 6))); } catch { /* private mode */ }
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


/* ---- every page and sub-section you can jump to (deep links: see goToSection) ---- */
interface NavTarget { id: string; label: string; crumb: string; path: string; section?: string; page: PageKey; panel?: string; words?: string; crmLead?: boolean }
const NAV_INDEX: NavTarget[] = [
  { id: "home", label: "Home", crumb: "Your day", path: "/home", page: "home", words: "dashboard start overview tickets to-do" },
  { id: "tickets", label: "Tickets", crumb: "Tickets · conversations", path: "/tickets", page: "home", words: "ticketing ticket desk helpdesk support incidents requests inbox sla email e-mail messages calls conversations" },
  { id: "tasks", label: "Tasks", crumb: "Tasks · the work", path: "/tickets?kind=task", page: "home", words: "tasks task to-do todo tareas work pendientes checklist" },
  { id: "cal", label: "Calendar", crumb: "Calendar", path: "/calendar", page: "calendar", words: "agenda bookings hours" },
  { id: "cal-week", label: "Week view", crumb: "Calendar › Week", path: "/calendar", section: "week", page: "calendar", words: "calendar week semana" },
  { id: "cal-month", label: "Month view", crumb: "Calendar › Month", path: "/calendar", section: "month", page: "calendar", words: "calendar month mes" },
  { id: "contacts", label: "Contacts", crumb: "Contacts", path: "/contacts", page: "contacts", words: "people crm contactos" },
  { id: "companies", label: "Companies", crumb: "Companies", path: "/companies", page: "companies", words: "accounts crm empresas organisations" },
  { id: "clients", label: "Clients", crumb: "Clients", path: "/clients", page: "clients", words: "customers clientes contracts" },
  { id: "projects", label: "Projects", crumb: "Projects › List", path: "/projects", section: "list", page: "projects", words: "implementations proyectos" },
  { id: "projects-canvas", label: "Projects canvas", crumb: "Projects › Canvas", path: "/projects", section: "canvas", page: "projects", words: "board implementations map" },
  { id: "deals", label: "Deals", crumb: "Deals › List", path: "/sales", section: "list", page: "sales", words: "sales pipeline trackings ventas opportunities" },
  { id: "deals-board", label: "Deals board", crumb: "Deals › Board", path: "/sales", section: "kanban", page: "sales", words: "kanban pipeline stages" },
  { id: "deals-forecast", label: "Forecast", crumb: "Deals › Forecast", path: "/sales", section: "forecast", page: "sales", words: "forecast revenue prevision" },
  { id: "cs", label: "Customer success", crumb: "Customer success › Accounts", path: "/success", section: "accounts", page: "success", words: "retention health accounts cs" },
  { id: "cs-up", label: "Upsells", crumb: "Customer success › Upsells", path: "/success", section: "upsells", page: "success", words: "expansion upsell cross-sell" },
  { id: "cs-qbr", label: "QBRs", crumb: "Customer success › QBRs", path: "/success", section: "qbr", page: "success", words: "quarterly business review meetings" },
  { id: "cs-rev", label: "Revenue", crumb: "Customer success › Revenue", path: "/success", section: "revenue", page: "success", words: "arr nrr churn bridge" },
  { id: "marketing", label: "Marketing", crumb: "Marketing", path: "/marketing", page: "marketing", words: "lists mailings campaigns newsletter" },
  { id: "mg", label: "Management", crumb: "Management › Team", path: "/management", section: "team", page: "management", words: "team performance consultants" },
  { id: "mg-backlog", label: "Backlog", crumb: "Management › Backlog", path: "/management", section: "backlog", page: "management", words: "unbilled days to deliver" },
  { id: "mg-billing", label: "Billing", crumb: "Management › Billing", path: "/management", section: "billing/tobill", page: "management", words: "invoices facturas bill to bill" },
  { id: "mg-sent", label: "Sent invoices", crumb: "Management › Billing › Sent", path: "/management", section: "billing/sent", page: "management", words: "awaiting payment outstanding bills" },
  { id: "mg-paid", label: "Paid invoices", crumb: "Management › Billing › Paid", path: "/management", section: "billing/paid", page: "management", words: "collected cobradas" },
  { id: "mg-history", label: "Billing history", crumb: "Management › Billing › History", path: "/management", section: "billing/history", page: "management", words: "log invoices history" },
  { id: "mg-bonus", label: "Bonus", crumb: "Management › Bonus", path: "/management", section: "bonus", page: "management", words: "bonus commissions targets" },
  { id: "mg-incoming", label: "Incoming", crumb: "Management › Incoming", path: "/management", section: "incoming", page: "management", words: "handoffs won deals new projects" },
  { id: "st", label: "Settings", crumb: "Settings", path: "/settings", section: "home", page: "settings", words: "preferences configuration ajustes" },
  { id: "st-org", label: "Organization", crumb: "Settings › Organization", path: "/settings", section: "organization", page: "settings", panel: "settings.organization", words: "users people employees departments roles page access security" },
  { id: "st-cat", label: "Products & services", crumb: "Settings › Products & services", path: "/settings", section: "catalog/products", page: "settings", panel: "settings.catalog", words: "catalog catalogue products tiers calculator pricing" },
  { id: "st-svc", label: "Services", crumb: "Settings › Products & services › Services", path: "/settings", section: "catalog/services", page: "settings", panel: "settings.catalog", words: "services rates roles consulting" },
  { id: "st-bp", label: "Blueprints", crumb: "Settings › Products & services › Blueprints", path: "/settings", section: "catalog/blueprints", page: "settings", panel: "settings.catalog", words: "project types phases templates" },
  { id: "st-pipe", label: "Client pipelines", crumb: "Settings › Client pipelines", path: "/settings", section: "pipeline", page: "settings", panel: "settings.pipelines", words: "pipelines phases stages" },
  { id: "st-prop", label: "Proposal templates", crumb: "Settings › Proposals & contracts", path: "/settings", section: "proposal/proposal", page: "settings", panel: "settings.proposal", words: "proposals templates deck html" },
  { id: "st-contract", label: "Contract templates", crumb: "Settings › Proposals & contracts › Contracts", path: "/settings", section: "proposal/contract", page: "settings", panel: "settings.proposal", words: "contracts order form templates" },
  { id: "st-pptx", label: "PowerPoint decks", crumb: "Settings › Proposals & contracts › PowerPoint", path: "/settings", section: "proposal/deck", page: "settings", panel: "settings.proposal", words: "pptx legacy deck" },
  { id: "st-pdf", label: "Order form (PDF)", crumb: "Settings › Proposals & contracts › Order form", path: "/settings", section: "proposal/pdf", page: "settings", panel: "settings.proposal", words: "order form pdf" },
  { id: "st-tasks", label: "Task settings", crumb: "Settings › Tasks", path: "/settings", section: "tasks", page: "settings", words: "tasks templates ticket types sla" },
  { id: "st-ui", label: "Interface", crumb: "Settings › Interface", path: "/settings", section: "interface", page: "settings", words: "sidebar dock labels order outlook" },
  { id: "st-acc", label: "Your account", crumb: "Settings › Your account", path: "/settings", section: "account", page: "settings", words: "profile password email account" },
  { id: "st-deals", label: "Deals settings", crumb: "Settings › Deals page", path: "/settings", section: "salespage", page: "settings", words: "deal fields sales roles potential revenue import export" },
  { id: "st-mgmt", label: "Management settings", crumb: "Settings › Management page", path: "/settings", section: "mgmtpage", page: "settings", words: "billing settings targets bonus security" },
  { id: "st-companies", label: "Companies settings", crumb: "Settings › Companies page", path: "/settings", section: "companiespage", page: "settings", crmLead: true, words: "company fields types sectors sources required import" },
  { id: "st-contacts", label: "Contacts settings", crumb: "Settings › Contacts page", path: "/settings", section: "contactspage", page: "settings", crmLead: true, words: "contact fields required lists import export" },
  { id: "st-client", label: "Client page settings", crumb: "Settings › Client page", path: "/settings", section: "clientpage", page: "settings", words: "client kpis folders" },
];

export function GlobalSearch() {
  const nav = useNavigate();
  const { canSee, canPanel, ready: accessReady } = usePageAccess();
  const { role: authRole, isSuperadmin } = useAuth() as any;
  const crmLead = isSalesLead({ role: authRole ?? undefined, is_superadmin: isSuperadmin === true });
  const navTargets = useMemo(() => NAV_INDEX.filter((t) => (!t.crmLead || crmLead) && (!accessReady || (canSee(t.page) && (!t.panel || canPanel(t.panel))))), [accessReady, canSee, canPanel, crmLead]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<Directory | null>(null);
  const [tickets, setTickets] = useState<{ id: string; title: string; no: number | null; stage: TicketStage; due: string | null; assignee: string | null; active: boolean; category: ItemCat }[]>([]);
  const [meetings, setMeetings] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const [recent, setRecent] = useState<Hit[]>([]);
  const [ticketOpen, setTicketOpen] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<ItemCat>("task");
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
      let r: any = await supabase.from("tracking_tasks").select("id, title, ticket_no, stage, done, status, due_at, assignee_id, source, requester_email, requester_name, category").order("created_at", { ascending: false }).range(0, 4999);
      if (r.error) r = await supabase.from("tracking_tasks").select("id, title, ticket_no, stage, done, status, due_at, assignee_id, source, requester_email, requester_name").order("created_at", { ascending: false }).range(0, 4999);
      if (r.error) r = await supabase.from("tracking_tasks").select("id, title, done, status, due_at").order("created_at", { ascending: false }).range(0, 4999);
      setTickets(((r.data ?? []) as any[]).map((t) => {
        const stage: TicketStage = t.stage ?? (t.done || t.status === "done" ? "resolved" : t.status === "in_progress" ? "in_progress" : t.status === "blocked" ? "waiting" : "open");
        const category: ItemCat = t.category === "ticket" || t.category === "task" ? t.category
          : ["email", "phone", "portal", "message"].includes(t.source) || t.requester_email || t.requester_name ? "ticket" : "task";
        return { id: t.id, title: t.title ?? "", no: t.ticket_no ?? null, stage, due: t.due_at ?? null, assignee: t.assignee_id ?? null, active: !["resolved", "closed"].includes(stage), category };
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
  // contacts, companies and deals are searched in the database (52_search_server.sql): never downloaded whole
  const [remoteHits, setRemoteHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (!dir?.remote || !fq) { setRemoteHits([]); return; }
    let off = false;
    const t = setTimeout(() => { globalSearch(q.trim(), ["contact", "company", "deal"], 6).then((r) => { if (!off) setRemoteHits(r ?? []); }).catch(() => {}); }, 160);
    return () => { off = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fq, dir?.remote]);
  const sections = useMemo((): { kind: HitKind; title: string; hits: Hit[] }[] => {
    const me = dir?.me ?? null;
    const coName = new Map((dir?.companies ?? []).map((c) => [c.id, c.name]));
    const clName = new Map((dir?.clients ?? []).map((c) => [c.id, c.name]));
    if (!fq) {
      const mine = tickets.filter((t) => t.active && t.assignee === me).sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9")).slice(0, 4)
        .map((t) => ({ kind: "ticket" as const, id: t.id, label: mentionsToPlain(t.title), sub: `${t.category === "task" ? "Task" : "Ticket"} ${ticketRef(t)} · ${stageLabel(t.stage, t.category)}${t.due ? ` · due ${new Date(t.due).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}`, stage: t.stage }));
      const out: { kind: HitKind; title: string; hits: Hit[] }[] = [];
      if (recent.length) out.push({ kind: "client", title: "Recent", hits: recent });
      if (mine.length) out.push({ kind: "ticket", title: "Your open tickets & tasks", hits: mine });
      if (meetings.length) out.push({ kind: "meeting", title: "Up next", hits: meetings });
      return out;
    }
    const all: Hit[] = [];
    const add = (kind: HitKind, id: string, label: string, sub: string | undefined, texts: string[], boost = 0, extra?: any) => {
      const sc = Math.max(...texts.map((t) => scoreOf(t, fq)));
      if (sc > 0) all.push({ kind, id, label, sub, score: sc + boost, extra });
    };
    // pages and sub-sections: name first, then the path ("settings contacts"), then related words
    navTargets.forEach((t) => {
      const sc = Math.max(scoreOf(t.label, fq), scoreOf(t.crumb.replace(/›/g, " "), fq) - 5, (t.words ? scoreOf(t.words, fq) : 0) - 15);
      if (sc > 0) all.push({ kind: "page", id: t.id, label: t.label, sub: t.crumb, score: sc + 2, extra: t });
    });
    tickets.forEach((t) => add("ticket", t.id, mentionsToPlain(t.title), `${t.category === "task" ? "Task" : "Ticket"} ${ticketRef(t)} · ${stageLabel(t.stage, t.category)}`, [mentionsToPlain(t.title), ticketRef(t), t.no ? String(t.no) : "", t.category], t.active ? 4 : -10, t));
    (dir?.clients ?? []).forEach((c) => add("client", c.id, c.name, "Client", [c.name], 6));
    (dir?.deals ?? []).forEach((d) => add("deal", d.id, d.name, [d.companyId ? coName.get(d.companyId) : null, d.status].filter(Boolean).join(" · ") || "Deal", [d.name, d.companyId ? coName.get(d.companyId) ?? "" : ""], d.status === "active" ? 3 : 0));
    (dir?.companies ?? []).forEach((c) => add("company", c.id, c.name, c.legal && c.legal !== c.name ? c.legal : "Company", [c.name, c.legal ?? ""]));
    (dir?.contacts ?? []).forEach((c) => add("contact", c.id, c.name, [c.title, c.email].filter(Boolean).join(" · ") || "Contact", [c.name, c.email ?? ""]));
    (dir?.projects ?? []).forEach((p) => add("project", p.id, p.name, p.clientId ? clName.get(p.clientId) : "Project", [p.name, p.clientId ? clName.get(p.clientId) ?? "" : ""], 0, p));
    // found by the database: ranked with the same scoring as everything else
    remoteHits.forEach((h) => add(h.kind, h.id, h.label, h.sub ?? (h.kind === "deal" ? "Deal" : h.kind === "company" ? "Company" : "Contact"),
      [h.label, h.email ?? "", h.sub ?? ""], h.kind === "deal" && h.status === "active" ? 3 : 0));
    (dir?.people ?? []).forEach((p) => add("person", p.id, p.name, [p.department ? deptName(p.department) : "", p.email].filter(Boolean).join(" · "), [p.name, p.email], -2));
    const best = [...all].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const out: { kind: HitKind; title: string; hits: Hit[] }[] = [];
    if (best[0] && (best[0].score ?? 0) >= 60) out.push({ kind: best[0].kind, title: "Top hit", hits: [best[0]] });
    ORDER.forEach((k) => {
      const hits = best.filter((h) => h.kind === k && h !== out[0]?.hits[0]).slice(0, k === "ticket" || k === "page" ? 4 : 3);
      if (hits.length) out.push({ kind: k, title: KIND_LABEL[k], hits });
    });
    out.push({ kind: "action", title: "Actions", hits: [
      { kind: "action", id: "new-task", label: `Add a task: “${q.trim()}”`, sub: "Work to do · lands on your list" },
      { kind: "action", id: "new-ticket", label: `Log a ticket: “${q.trim()}”`, sub: "A message, call or request · lands on your desk" },
    ] });
    return out;
  }, [fq, q, dir, tickets, meetings, recent, navTargets, remoteHits]);
  const flat = sections.flatMap((s) => s.hits);
  useEffect(() => { setSel(0); }, [fq]);

  const go = (h: Hit) => {
    pushRecent(h);
    setOpen(false); setQ("");
    inputRef.current?.blur();
    // leaving the screen: a screen with unsaved work (pipeline editor…) asks first
    const leave = (f: () => void) => guardedLeave(f);
    switch (h.kind) {
      case "page": { const t = h.extra as NavTarget; leave(() => goToSection(nav, t.path, t.section ?? null)); break; }
      case "company": leave(() => nav("/companies", { state: { focusCompanyId: h.id } })); break;
      case "contact": leave(() => nav("/contacts", { state: { focusContactId: h.id } })); break;
      case "client": leave(() => nav(`/clients?client=${h.id}`)); break;
      case "deal": leave(() => nav(`/sales?tracking=${h.id}`)); break;
      case "project": { const p = dir?.projects.find((x) => x.id === h.id); leave(() => nav(p?.clientId ? `/clients?client=${p.clientId}` : "/projects")); break; }
      case "ticket": setTicketOpen(h.id); break;
      case "meeting": leave(() => nav("/calendar")); break;
      case "person": { const p = dir?.people.find((x) => x.id === h.id); if (p?.email) window.location.href = `mailto:${p.email}`; break; }
      case "action": setNewKind(h.id === "new-task" ? "task" : "ticket"); setNewTicket(q.trim()); break;
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
        <input ref={inputRef} value={q} placeholder="Search or jump to — clients, deals, tickets, any page…" aria-label="Search everything"
          onFocus={() => { setOpen(true); setRecent(readRecent()); if (!loaded.current) loadAll(); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown={onKey} />
        {q ? <button type="button" className="gs-clear" onClick={() => { setQ(""); inputRef.current?.focus(); }} aria-label="Clear"><TkIco d="x" /></button>
          : <kbd className="gs-kbd">{isMac ? "⌘" : "Ctrl"} K</kbd>}
      </div>
      {open && (
        <div className="gs-panel" role="listbox">
          {loading ? <div className="gs-loading"><span className="gs-spin" />Loading everything…</div>
            : !sections.length ? <p className="gs-empty">Start typing to search clients, deals, companies, contacts, projects, tickets and people — or jump to any page, like “billing sent” or “contacts settings”.</p>
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
        <TicketDrawer ticket={null} draft={{ title: newTicket, assignee: dir.me, category: newKind, ...(newKind === "ticket" ? { source: "message" } : {}) }} dir={dir} types={types.length ? types : ["Request"]} ready={tickets.length === 0 || tickets.some((t) => t.no != null)}
          onClose={() => setNewTicket(null)} onCreated={(id) => { setNewTicket(null); setTicketOpen(id); }} />
      )}
    </div>
  );
}

/* =====================================================================
   ALERTS — always at the top of Home: what happened to you since you
   last looked. Written by the database (66_home_alerts.sql): tasks and
   tickets assigned to you, replies on them, notes that mention you,
   meeting invitations and what became of them, answers to yours.
   Before that SQL runs, the same is pieced together from invites and tasks.
   ===================================================================== */
interface HomeAlert {
  id: string; kind: string; title: string; body: string | null; ref_type: string | null; ref_id: string | null;
  actor_id: string | null; at: string | null; created_at: string; seen_at: string | null; local?: boolean;
}
const HA_VERB: Record<string, string> = {
  task_assigned: "assigned you", task_added: "added you to", task_step: "gave you a step on", message: "replied on", mention: "mentioned you on", invite: "invited you to",
  invite_moved: "moved", invite_cancelled: "cancelled", invite_removed: "took you off", invite_accepted: "accepted", invite_declined: "declined",
};
const HA_TONE: Record<string, string> = {
  task_assigned: "task", task_added: "task", task_step: "task", message: "msg", mention: "msg", invite: "invite", invite_moved: "warn", invite_cancelled: "bad", invite_removed: "bad", invite_accepted: "ok", invite_declined: "bad",
};
const haIcon = (kind: string) => {
  const p = kind === "task_assigned" || kind === "task_added" || kind === "task_step" ? <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></>
    : kind === "message" ? <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
    : kind === "mention" ? <><circle cx="12" cy="12" r="3.6" /><path d="M15.6 12v1.4a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7" /></>
    : kind === "invite_accepted" ? <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></>
    : kind === "invite_declined" || kind === "invite_cancelled" || kind === "invite_removed" ? <><circle cx="12" cy="12" r="8.5" /><path d="M9 9l6 6M15 9l-6 6" /></>
    : kind === "invite_moved" ? <><rect x="3" y="5" width="18" height="15" rx="3" /><path d="M3 10h18M8 3v4M16 3v4M10 15h5M13 13l2 2-2 2" /></>
    : <><rect x="3" y="5" width="18" height="15" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{p}</svg>;
};
const haAgo = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "now"; if (s < 3600) return `${Math.floor(s / 60)} min`; if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
const haWhen = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso); const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t.getTime()) / 864e5);
  const day = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${day} · ${d.toTimeString().slice(0, 5)}`;
};

/** The alerts of one person: read, kept live, and the actions on them. Home shows them in two places (bell + strip). */
function useHomeAlerts(userId: string | null) {
  const nav = useNavigate();
  const [rows, setRows] = useState<HomeAlert[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [inviteState, setInviteState] = useState<Record<string, string>>({});
  /** task id → "ticket" | "task" */
  const [cats, setCats] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState(false);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    if (!userId) return;
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const r = await supabase.from("user_alerts").select("id, kind, title, body, ref_type, ref_id, actor_id, at, created_at, seen_at")
      .eq("user_id", userId).is("done_at", null).gte("created_at", since).order("created_at", { ascending: false }).limit(60);
    let list: HomeAlert[] = [];
    if (r.error) {
      // before 66_home_alerts.sql: what can be read directly
      setMissing(/relation|does not exist|schema cache|Could not find/i.test(r.error.message));
      const [inv, rep, tk] = await Promise.all([
        loadMyInvites(userId).catch(() => [] as InviteCard[]),
        loadMyReplies(userId).catch(() => []),
        supabase.from("tracking_tasks").select("id, title, created_by, created_at, done").eq("assignee_id", userId).gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString()).limit(20),
      ]);
      // tasks you were added to as a watcher lately
      const watch = await Promise.resolve(supabase.from("tracking_assignees").select("item_id, created_at").eq("item_type", "task").eq("kind", "employee").eq("employee_id", userId)
        .gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString()).limit(20)).then((r: any) => (r?.error ? [] : r?.data ?? []) as any[]).catch(() => [] as any[]);
      const own = new Set((((tk as any).data ?? []) as any[]).map((t) => t.id));
      const watchIds = [...new Set(watch.map((w) => w.item_id as string))].filter((id) => !own.has(id));
      const wt = watchIds.length ? (((await supabase.from("tracking_tasks").select("id, title, created_by, created_at, done").in("id", watchIds)).data ?? []) as any[]) : [];
      const addedAt = new Map(watch.map((w) => [w.item_id, w.created_at]));
      list = [
        ...inv.filter((i, k, all) => !i.series_id || all.findIndex((x) => x.series_id === i.series_id) === k).map((i) => ({ id: `inv:${i.id}`, kind: "invite", title: i.title || "A meeting", body: i.series_id ? [i.message, "Repeats — one answer covers every date"].filter(Boolean).join(" · ") : i.message, ref_type: "invite", ref_id: i.id, actor_id: i.organiser_id, at: `${i.entry_date}T${String(Math.floor(i.start_min / 60)).padStart(2, "0")}:${String(i.start_min % 60).padStart(2, "0")}:00`, created_at: i.created_at, seen_at: null, local: true })),
        ...rep.filter((x) => !x.seen).map((x) => ({ id: `rep:${x.id}`, kind: `invite_${x.status}`, title: x.entry_title || "Your meeting", body: null, ref_type: "reply", ref_id: x.id, actor_id: null, at: `${x.entry_date}T${String(Math.floor(x.start_min / 60)).padStart(2, "0")}:${String(x.start_min % 60).padStart(2, "0")}:00`, created_at: x.responded_at, seen_at: null, local: true, actorName: x.invitee_name } as HomeAlert & { actorName: string })),
        ...(((tk as any).data ?? []) as any[]).filter((t) => t.created_by !== userId && !t.done).map((t) => ({ id: `tk:${t.id}`, kind: "task_assigned", title: t.title || "A task", body: null, ref_type: "task", ref_id: t.id, actor_id: t.created_by, at: null, created_at: t.created_at, seen_at: null, local: true })),
        ...wt.filter((t) => t.created_by !== userId && !t.done).map((t) => ({ id: `tw:${t.id}`, kind: "task_added", title: t.title || "A task", body: null, ref_type: "task", ref_id: t.id, actor_id: t.created_by, at: null, created_at: addedAt.get(t.id) ?? t.created_at, seen_at: null, local: true })),
      ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const fromReplies: Record<string, string> = {};
      list.forEach((a: any) => { if (a.actorName) fromReplies[a.id] = a.actorName; });
      setNames((n) => ({ ...n, ...Object.fromEntries(Object.entries(fromReplies).map(([k, v]) => [`@${k}`, v])) }));
    } else {
      setMissing(false);
      list = (r.data ?? []) as HomeAlert[];
    }
    const actors = [...new Set(list.map((a) => a.actor_id).filter(Boolean))] as string[];
    if (actors.length) {
      const { data } = await supabase.from("profiles").select("id, first_name, last_name, email").in("id", actors);
      setNames((n) => ({ ...n, ...Object.fromEntries(((data ?? []) as any[]).map((p) => [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "Someone"])) }));
    }
    // a task alert is about a ticket (a conversation) or a task (work): the popup files them apart
    const taskIds = [...new Set(list.filter((a) => a.ref_type === "task" && a.ref_id).map((a) => a.ref_id!))] as string[];
    if (taskIds.length) {
      let tr: any = await supabase.from("tracking_tasks").select("id, category, source, requester_email, requester_name").in("id", taskIds);
      if (tr.error) tr = await supabase.from("tracking_tasks").select("id, source, requester_email, requester_name").in("id", taskIds);
      const CH = ["email", "phone", "portal", "message"];
      setCats(Object.fromEntries(((tr.data ?? []) as any[]).map((r) => [r.id,
        r.category === "ticket" || r.category === "task" ? r.category : CH.includes(r.source) || r.requester_email || r.requester_name ? "ticket" : "task"])));
    }
    const invIds = list.filter((a) => a.kind === "invite" && a.ref_id).map((a) => a.ref_id!) as string[];
    if (invIds.length) {
      const { data } = await supabase.from("entry_invites").select("id, status").in("id", invIds);
      setInviteState(Object.fromEntries(((data ?? []) as any[]).map((i) => [i.id, i.status])));
    } else setInviteState({});
    setRows(list);
  };
  useEffect(() => {
    if (!userId) return;
    void load();
    const again = () => { void load(); };
    window.addEventListener(TICKETS_EVENT, again);
    window.addEventListener("focus", again);
    const t = window.setInterval(again, 90_000);
    let ch: any = null;
    try {
      ch = supabase.channel(`alerts-${userId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "user_alerts", filter: `user_id=eq.${userId}` }, again)
        .subscribe();
    } catch { /* realtime off */ }
    return () => { window.removeEventListener(TICKETS_EVENT, again); window.removeEventListener("focus", again); window.clearInterval(t); try { if (ch) supabase.removeChannel(ch); } catch { /* */ } };
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const nowIso = () => new Date().toISOString();
  const markSeen = async (ids: string[]) => {
    const real = ids.filter((id) => !id.includes(":"));
    setRows((rs) => rs?.map((a) => (ids.includes(a.id) ? { ...a, seen_at: a.seen_at ?? nowIso() } : a)) ?? rs);
    if (real.length) await supabase.from("user_alerts").update({ seen_at: nowIso() }).in("id", real).is("seen_at", null);
    const replies = ids.filter((id) => id.startsWith("rep:")).map((id) => id.slice(4));
    if (replies.length) await markRepliesSeen(replies);
  };
  const clear = async (ids: string[]) => {
    setRows((rs) => rs?.filter((a) => !ids.includes(a.id)) ?? rs);
    const real = ids.filter((id) => !id.includes(":"));
    if (real.length) await supabase.from("user_alerts").update({ done_at: nowIso(), seen_at: nowIso() }).in("id", real);
    const replies = ids.filter((id) => id.startsWith("rep:")).map((id) => id.slice(4));
    if (replies.length) await markRepliesSeen(replies);
  };
  const answer = async (a: HomeAlert, yes: boolean) => {
    if (!a.ref_id) return;
    setBusy(a.id); setErr(null);
    let e: string | null = null;
    if (!userId) return;
    // on a repeating booking, one answer covers every date
    const card = (await loadMyInvites(userId).catch(() => [] as InviteCard[])).find((i) => i.id === a.ref_id);
    if (card) e = await answerInvite(card, userId, yes);
    else e = yes ? "This invitation isn't open any more." : await declineInvite(a.ref_id);
    setBusy(null);
    if (e) { setErr(e); return; }
    setInviteState((s) => ({ ...s, [a.ref_id!]: yes ? "accepted" : "declined" }));
    await markSeen([a.id]);
    if (card?.series_id) void load();
  };
  const open = (a: HomeAlert) => {
    void markSeen([a.id]);
    if (a.ref_type === "task" && a.ref_id) { setTicket(a.ref_id); return; }
    if (a.ref_type === "client") { nav("/clients"); return; }
    nav("/calendar");
  };

  const unseen = (rows ?? []).filter((a) => !a.seen_at).length;
  return { rows, names, inviteState, cats, missing, all, setAll, busy, ticket, setTicket, err, markSeen, clear, answer, open, unseen };
}
type HomeAlertsState = ReturnType<typeof useHomeAlerts>;

/** What an alert is about, for the tabs of the notifications window. */
type HaCat = "invites" | "meetings" | "tasks" | "tickets" | "mentions";
const HA_CATS: { key: HaCat | "all"; label: string }[] = [
  { key: "all", label: "All" }, { key: "invites", label: "Invitations" }, { key: "meetings", label: "Meetings" },
  { key: "tasks", label: "Tasks" }, { key: "tickets", label: "Tickets" }, { key: "mentions", label: "Mentions" },
];
const haCatsOf = (a: HomeAlert, cats: Record<string, string>): HaCat[] => {
  if (a.kind === "invite") return ["invites"];
  if (a.kind.startsWith("invite_")) return ["meetings"];
  const out: HaCat[] = [];
  if (a.ref_type === "task") out.push(a.ref_id && cats[a.ref_id] === "ticket" ? "tickets" : "tasks");
  if (a.kind === "mention") out.push("mentions");
  return out.length ? out : ["mentions"];
};
const haDay = (iso: string) => {
  const d = new Date(iso); const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 864e5);
  return diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : diff < 7 ? "This week" : "Earlier";
};

/**
 * The bell next to Customize: how many new notifications (or a check when there's none).
 * It opens a window over the page — nothing on Home moves — with every notification,
 * all together or by kind: invitations, meetings, tasks, tickets, mentions.
 */
function HomeAlertsBell({ h, tone = "light" }: { h: HomeAlertsState; tone?: "light" | "dark" }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  if (!h.rows) return null;
  const n = h.rows.length;
  const calm = n === 0;
  return (
    <>
      <button ref={btn} type="button" className={`ha-bell is-${tone} ${calm ? "is-calm" : ""} ${h.unseen ? "has-new" : ""} ${at ? "is-on" : ""}`}
        onClick={() => setAt(at ? null : btn.current?.getBoundingClientRect() ?? null)} aria-expanded={!!at} aria-haspopup="dialog"
        title={calm ? `Notifications — you're all caught up${h.missing ? " (run 66_home_alerts.sql for every kind)" : ""}` : `Notifications · ${h.unseen ? `${h.unseen} new` : `${n}`}`}
        aria-label={calm ? "Notifications — none" : `Notifications, ${h.unseen} new`}>
        {calm
          ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 21h4" /><path d="M9.5 11.5l1.8 1.8 3.2-3.4" /></svg>
          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 21h4" /></svg>}
        {!calm && h.unseen > 0 && <em>{h.unseen}</em>}
      </button>
      {at && <HomeAlertsPop h={h} anchor={at} onClose={() => setAt(null)} />}
      {h.ticket && <TicketDrawerById id={h.ticket} onClose={() => h.setTicket(null)} />}
    </>
  );
}

function HomeAlertsPop({ h, anchor, onClose }: { h: HomeAlertsState; anchor: DOMRect; onClose: () => void }) {
  const { rows, names, inviteState, cats, busy, err, markSeen, clear, answer, open, unseen } = h;
  const [tab, setTab] = useState<HaCat | "all">("all");
  const [onlyNew, setOnlyNew] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = rows ?? [];
  // what you saw counts as read once you close it
  const seenRef = useRef<string[]>([]);
  seenRef.current = list.filter((a) => !a.seen_at).map((a) => a.id);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest?.(".ha-bell")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const tm = window.setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key);
    return () => {
      window.clearTimeout(tm); document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key);
      if (seenRef.current.length) void markSeen(seenRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = Object.fromEntries(HA_CATS.map((c) => [c.key, c.key === "all" ? list.length : list.filter((a) => haCatsOf(a, cats).includes(c.key as HaCat)).length])) as Record<string, number>;
  const newIn = (k: string) => list.filter((a) => !a.seen_at && (k === "all" || haCatsOf(a, cats).includes(k as HaCat))).length;
  const shown = list.filter((a) => (tab === "all" || haCatsOf(a, cats).includes(tab)) && (!onlyNew || !a.seen_at));
  const who = (a: HomeAlert) => names[`@${a.id}`] ?? (a.actor_id ? names[a.actor_id] : "") ?? "";
  const width = Math.min(440, window.innerWidth - 16);
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
  let lastDay = "";

  return createPortal(
    <div ref={ref} className="hn" role="dialog" aria-label="Notifications" style={{ top: anchor.bottom + 10, left, width }}>
      <header className="hn-h">
        <b>Notifications</b>
        {unseen > 0 && <em className="hn-n">{unseen} new</em>}
        <span className="hn-grow" />
        {list.length > 0 && (
          <>
            <button type="button" className={`hn-link ${onlyNew ? "is-on" : ""}`} onClick={() => setOnlyNew((v) => !v)} aria-pressed={onlyNew}>Unread only</button>
            {unseen > 0 && <button type="button" className="hn-link" onClick={() => void markSeen(list.filter((a) => !a.seen_at).map((a) => a.id))}>Mark all read</button>}
          </>
        )}
      </header>
      <nav className="hn-tabs" role="tablist">
        {HA_CATS.filter((c) => c.key === "all" || counts[c.key] > 0).map((c) => (
          <button key={c.key} type="button" role="tab" aria-selected={tab === c.key} className={tab === c.key ? "is-on" : ""} onClick={() => setTab(c.key)}>
            {c.label}<i className={newIn(c.key) ? "is-new" : ""}>{counts[c.key]}</i>
          </button>
        ))}
      </nav>
      {err && <p className="hn-err">{err}</p>}
      <div className="hn-list">
        {!shown.length ? (
          <div className="hn-empty">
            <span className="hn-empty-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 21h4" /><path d="M9.5 11.5l1.8 1.8 3.2-3.4" /></svg></span>
            <b>{list.length ? "Nothing here" : "You're all caught up"}</b>
            <span>{list.length ? "No notifications of this kind." : "Invitations, meetings, tasks and tickets for you show up here."}</span>
          </div>
        ) : shown.map((a, i) => {
          const st = a.kind === "invite" && a.ref_id ? inviteState[a.ref_id] ?? "pending" : null;
          const meta = a.at ? haWhen(a.at) : a.body ? a.body : "";
          const day = haDay(a.created_at);
          const head = day !== lastDay ? (lastDay = day) : null;
          const cat = haCatsOf(a, cats)[0];
          return (
            <div key={a.id}>
              {head && <span className="hn-day">{head}</span>}
              <article className={`hn-item is-${HA_TONE[a.kind] ?? "msg"} ${a.seen_at ? "" : "is-new"}`} style={{ ["--i" as string]: Math.min(i, 10) } as CSSProperties}
                onClick={() => { open(a); if (a.ref_type !== "task") onClose(); }} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") open(a); }}>
                <i className="hn-ico">{haIcon(a.kind)}</i>
                <div className="hn-txt">
                  <span className="hn-line"><b>{who(a) || (a.kind.startsWith("invite_") && a.kind !== "invite_moved" ? "Someone" : "")}</b> {HA_VERB[a.kind] ?? "updated"}{a.kind === "task_assigned" ? (cat === "tickets" ? " a ticket" : " a task") : ""}</span>
                  <strong className="hn-title" title={mentionsToPlain(a.title)}><MentionText text={a.title} /></strong>
                  {meta && <span className="hn-meta" title={a.body ?? ""}>{meta}{a.at && a.body ? ` — ${a.body}` : ""}</span>}
                  {st && (
                    <div className="hn-acts" onClick={(e) => e.stopPropagation()}>
                      {st === "pending" ? (
                        <>
                          <button type="button" className="is-yes" disabled={busy === a.id} onClick={() => void answer(a, true)}>Accept</button>
                          <button type="button" disabled={busy === a.id} onClick={() => void answer(a, false)}>Decline</button>
                        </>
                      ) : <span className={`hn-done is-${st}`}>{st === "accepted" ? "You accepted" : st === "declined" ? "You declined" : st}</span>}
                    </div>
                  )}
                </div>
                <span className="hn-ago">{haAgo(a.created_at)}</span>
                <button type="button" className="hn-x" onClick={(e) => { e.stopPropagation(); void clear([a.id]); }} aria-label="Clear" title="Clear">×</button>
              </article>
            </div>
          );
        })}
      </div>
      {shown.length > 0 && (
        <footer className="hn-f">
          <button type="button" className="hn-link" onClick={() => void clear(shown.map((a) => a.id))}>Clear {tab === "all" && !onlyNew ? "all" : "these"}</button>
        </footer>
      )}
    </div>,
    document.body,
  );
}
