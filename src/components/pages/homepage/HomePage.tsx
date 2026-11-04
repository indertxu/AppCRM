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
 * Everything under the header is a board of cards each person arranges
 * (Adjust, top right — see THE HOME BOARD). The board a person starts with
 * goes by DEPARTMENT first (a boss inside consultancy starts with
 * consultancy), then by role.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { MentionText, mentionsToPlain } from "../../framework/MentionInput";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import HomeCalendar, { CAL_SUMMARY_EVENT, type CalSummary } from "./shared/HomeCalendar";
import { TicketDesk, TicketDrawer, TicketDrawerById, TkIco, Avatar, loadDirectory, loadTicketTypes, ticketRef, stageLabel, TICKETS_EVENT, type Directory, type TicketStage, type ItemCat } from "./shared/HomeTodo";
import SalesHome, { SALES_KPIS, SALES_PREF } from "./sales/SalesHome";
import ConsultancyHome, { HERO_KPIS, HERO_PREF, renderSlots, useCount, Ring, Fig, Txt, type HomeSlot } from "./consultancy/ConsultancyHome";
import { ManagementSummary, SalesPipelineWidget, NeglectedClientsWidget, TeamBonusWidget } from "./management/ManagementHome";
import ActionsMenu from "../../framework/ActionsMenu";
import { applyRolePreview } from "../../framework/SuperAdmin";
import { PageCube } from "../../framework/AppLayout";
import { usePageAccess, goToSection, guardedLeave, deptName, levelBase, type PageKey } from "../../framework/pageAccess";
import { isSalesLead, globalSearch, loadPrefs, savePref, type SearchHit } from "../companies/companiesApi";
import { loadMyInvites, loadMyReplies, markRepliesSeen, answerInvite, declineInvite, type InviteCard } from "../calendar/invitesApi";
import "./HomePage.css";

const greeting = () => {
  const h = new Date().getHours();
  if (h < 6) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 19) return "Good afternoon";
  return "Good evening";
};

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

const areaTitle = (a: Area) => a === "consultancy" ? "Consultancy" : a === "sales" ? "Sales" : a === "marketing" ? "Marketing" : a === "management" ? "Management" : "Next Management";

type Me = { id: string; department: string | null; role: string | null; firstName: string | null; isSuper: boolean };
type Area = "sales" | "consultancy" | "marketing" | "management" | null;

const SALES_ROLES = ["sales", "sales_manager"];
const MARKETING_ROLES = ["marketing", "marketing_manager"];
const MANAGER_ROLES = ["boss", "consultancy_manager", "sales_manager"];

function areaFor(me: Me | null, authRole: string | null): Area {
  if (!me) return null;
  const role = (me.role ?? authRole ?? "").toLowerCase();
  if (me.department === "consultancy") return "consultancy";
  if (me.department === "sales" || SALES_ROLES.includes(role)) return "sales";
  if (me.department === "marketing" || MARKETING_ROLES.includes(role)) return "marketing";
  if (MANAGER_ROLES.includes(role) || me.isSuper) return "management";
  return null;
}

/* =====================================================================
   THE HOME BOARD — every card on Home is a piece you can move, resize,
   swap or take away (Adjust, top right). The page is a grid of 24 columns;
   rows are sized so that 22 of them fill one screen under the header, on
   any screen. Cards fall upwards (no holes). Each person's layout is saved
   with their profile (prefs.homeBoard); what they can add is what their
   access lets them open (page access + Management panels).
   The numbers come from "sources" — the sales, consultancy, marketing and
   management code — mounted only while one of their cards is on show; each
   draws its cards into the board's slots (portals), so moving a card never
   reloads it.
   ===================================================================== */
export const COLS = 24;
export const GAP = 16;
const SCREEN_ROWS = 22;
const BOARD_PREF = "homeBoard";
const MAX_FIGS = 6;

type Dept = "general" | "sales" | "consultancy" | "marketing" | "management";
const DEPTS: { key: Dept; label: string; color: string }[] = [
  { key: "general", label: "Everyone", color: "#12b57f" },
  { key: "sales", label: "Sales", color: "#3c9ae0" },
  { key: "consultancy", label: "Consultancy", color: "#0a8a5c" },
  { key: "marketing", label: "Marketing", color: "#e0a13c" },
  { key: "management", label: "Management", color: "#7a5cd6" },
];
interface Access { canSee: (p: PageKey) => boolean; canPanel: (k: string) => boolean; dept: string | null; full: boolean }
type Glyph = "cal" | "desk" | "stages" | "clock" | "alert" | "team" | "bill" | "stack" | "mail" | "share" | "users" | "coins" | "quiet" | "trophy" | "num" | "ring" | "pipe";
interface CardDef {
  key: string;
  dept: Dept;
  /** which code draws it */
  src: Dept;
  /** a single figure (fits the header too) */
  fig: boolean;
  title: string;
  hint: string;
  glyph: Glyph;
  /** default and smallest size, in columns × rows */
  def: [number, number];
  min: [number, number];
  /** below this size a card shows its headline figure instead (summary) */
  full?: [number, number];
  summary?: string;
  /** where a click on the card goes */
  go?: [string, string?];
  allow: (a: Access) => boolean;
}
const consOk = (panel: string) => (a: Access) => a.full || a.dept === "consultancy" || (a.canSee("management") && a.canPanel(`management.${panel}`));
const CONS_PANEL: Record<string, string> = { Team: "team", Bonus: "bonus", Backlog: "backlog", Billing: "billing", Incoming: "incoming" };
const CONS_GLYPH: Record<string, Glyph> = { Team: "team", Bonus: "trophy", Backlog: "stack", Billing: "bill", Incoming: "pipe" };
const SALES_GLYPH: Record<string, Glyph> = { pipeline: "stages", weighted: "ring", closing: "clock", attention: "alert", new_month: "num", won_month: "trophy", winrate: "ring", avg_won: "coins" };
const figDef = (key: string, dept: Dept, title: string, hint: string, glyph: Glyph, allow: (a: Access) => boolean, go?: [string, string?]): CardDef =>
  ({ key, dept, src: dept, fig: true, title, hint, glyph, def: [6, 4], min: [4, 3], allow, go });
const CARD_DEFS: CardDef[] = [
  // ---- everyone ----
  { key: "calendar", dept: "general", src: "general", fig: false, title: "Your calendar", hint: "The next 5 working days, the month and what's coming up", glyph: "cal", def: [9, 14], min: [4, 3], full: [7, 8], summary: "booked", go: ["/calendar"], allow: (a) => a.canSee("calendar") },
  { key: "desk", dept: "general", src: "general", fig: false, title: "To-do & tickets", hint: "Your tasks and tickets, with the inbox", glyph: "desk", def: [8, 22], min: [4, 3], full: [7, 10], summary: "tickets", go: ["/tickets"], allow: () => true },
  figDef("booked", "general", "Booked today", "How full today is, and what's next", "ring", (a) => a.canSee("calendar"), ["/calendar"]),
  figDef("tickets", "general", "Open tickets", "Your open tickets, late and due today", "desk", () => true, ["/tickets"]),
  figDef("tasks", "general", "Open tasks", "Your open tasks, late and due today", "desk", () => true, ["/tickets?kind=task"]),
  // ---- sales ----
  { key: "sales.stages", dept: "sales", src: "sales", fig: false, title: "Pipeline by stage", hint: "Open deals and value in each stage", glyph: "stages", def: [9, 8], min: [4, 3], full: [6, 5], summary: "pipeline", go: ["/sales"], allow: (a) => a.canSee("sales") },
  { key: "sales.closing", dept: "sales", src: "sales", fig: false, title: "About to close", hint: "Deals with a close date in the next 45 days (and the team)", glyph: "clock", def: [7, 10], min: [4, 3], full: [5, 6], summary: "closing", go: ["/sales"], allow: (a) => a.canSee("sales") },
  { key: "sales.attention", dept: "sales", src: "sales", fig: false, title: "Deals that need attention", hint: "Overdue, stuck, quiet or without a date", glyph: "alert", def: [7, 12], min: [4, 3], full: [5, 6], summary: "attention", go: ["/sales"], allow: (a) => a.canSee("sales") },
  ...SALES_KPIS.map((k) => figDef(k.key, "sales", k.label, `Sales · ${k.group}`, SALES_GLYPH[k.key] ?? "num", (a) => a.canSee("sales"), ["/sales"])),
  // ---- consultancy ----
  { key: "cons.backlog", dept: "consultancy", src: "consultancy", fig: false, title: "Backlog", hint: "Unbilled value and days left, by role", glyph: "stack", def: [9, 8], min: [4, 3], full: [8, 5], summary: "backlog_value", go: ["/management", "backlog"], allow: consOk("backlog") },
  { key: "cons.team", dept: "consultancy", src: "consultancy", fig: false, title: "Team performance", hint: "Days and billing against each consultant's target", glyph: "team", def: [7, 12], min: [4, 3], full: [6, 8], summary: "days", go: ["/management", "team"], allow: consOk("team") },
  { key: "cons.bills", dept: "consultancy", src: "consultancy", fig: false, title: "Outstanding bills", hint: "Bills waiting to be paid, oldest flagged", glyph: "bill", def: [7, 10], min: [4, 3], full: [5, 5], summary: "outstanding", go: ["/management", "billing/sent"], allow: consOk("billing") },
  ...HERO_KPIS.map((k) => figDef(k.key, "consultancy", k.label, `Consultancy · ${k.group}`, CONS_GLYPH[k.group] ?? "num", consOk(CONS_PANEL[k.group] ?? "team"))),
  // ---- marketing ----
  { key: "mk.campaigns", dept: "marketing", src: "marketing", fig: false, title: "E-mail campaigns", hint: "The latest campaigns: sent, opened, clicked", glyph: "mail", def: [8, 11], min: [4, 3], full: [6, 6], summary: "mk_open", go: ["/marketing"], allow: (a) => a.canSee("marketing") },
  { key: "mk.posts", dept: "marketing", src: "marketing", fig: false, title: "Social posts", hint: "What's scheduled next, on every network", glyph: "share", def: [8, 11], min: [4, 3], full: [6, 6], summary: "mk_planned", go: ["/marketing"], allow: (a) => a.canSee("marketing") },
  { key: "mk.lists", dept: "marketing", src: "marketing", fig: false, title: "Audiences", hint: "Your lists and how many people are in each", glyph: "users", def: [7, 9], min: [4, 3], full: [6, 5], summary: "mk_audience", go: ["/marketing"], allow: (a) => a.canSee("marketing") },
  figDef("mk_sent", "marketing", "E-mails sent this month", "Marketing · E-mail", "mail", (a) => a.canSee("marketing"), ["/marketing"]),
  figDef("mk_open", "marketing", "Open rate, 30 days", "Marketing · E-mail", "ring", (a) => a.canSee("marketing"), ["/marketing"]),
  figDef("mk_planned", "marketing", "Scheduled, next 14 days", "Marketing · Campaigns and posts", "clock", (a) => a.canSee("marketing"), ["/marketing"]),
  figDef("mk_audience", "marketing", "People in your lists", "Marketing · Audiences", "users", (a) => a.canSee("marketing"), ["/marketing"]),
  figDef("mk_unsub", "marketing", "Unsubscribes, 30 days", "Marketing · E-mail", "alert", (a) => a.canSee("marketing"), ["/marketing"]),
  // ---- management ----
  { key: "mgmt.summary", dept: "management", src: "management", fig: false, title: "Money at a glance", hint: "Outstanding, invoiced, backlog and bonus to pay", glyph: "coins", def: [7, 11], min: [4, 3], full: [6, 9], summary: "outstanding", go: ["/management"], allow: (a) => a.full || (a.canSee("management") && a.canPanel("management.billing")) },
  { key: "mgmt.pipeline", dept: "management", src: "management", fig: false, title: "Company pipeline", hint: "Every active deal, by stage", glyph: "pipe", def: [7, 11], min: [4, 3], full: [5, 7], summary: "pipeline", go: ["/sales"], allow: (a) => a.canSee("sales") },
  { key: "mgmt.quiet", dept: "management", src: "management", fig: false, title: "Clients gone quiet", hint: "Clients nobody has talked to in over a month", glyph: "quiet", def: [7, 9], min: [5, 6], go: ["/clients"], allow: (a) => a.canSee("clients") },
  { key: "mgmt.bonus", dept: "management", src: "management", fig: false, title: "Team bonus", hint: "The bonus to pay this cycle, per person", glyph: "trophy", def: [7, 9], min: [4, 3], full: [5, 6], summary: "bonus", go: ["/management", "bonus"], allow: (a) => a.full || (a.canSee("management") && a.canPanel("management.bonus")) },
];
const DEF: Record<string, CardDef> = Object.fromEntries(CARD_DEFS.map((d) => [d.key, d]));

/** `lay`: the calendar's layout — "stack" (week on top, coming up below) or "side" (side by side). */
type CalLay = "stack" | "side";
export interface BoardItem {
  id: string; key: string; x: number; y: number; w: number; h: number; lay?: CalLay;
  /** the deal page: the card opens collapsed (set while adjusting) */
  fold?: "closed";
  /** drawn collapsed right now (only its header shows) */
  folded?: boolean;
  /** drawn shorter than its size: it holds less than fills it */
  fitted?: boolean;
}
interface BoardState { v: 1; hero: "full" | "compact"; figs: string[]; items: BoardItem[] }
let idSeq = 0;
export const newId = () => `c${Date.now().toString(36)}${(idSeq++).toString(36)}`;
const item = (key: string, x: number, y: number, w: number, h: number): BoardItem => ({ id: newId(), key, x, y, w, h });

function defaultBoard(area: Area, prefs: Record<string, any>): BoardState {
  const keep = (v: unknown, fallback: string[]) => (Array.isArray(v) && v.length === 4 && v.every((k) => typeof k === "string" && DEF[k]) ? v as string[] : fallback);
  switch (area) {
    case "consultancy": return { v: 1, hero: "full", figs: keep(prefs[HERO_PREF], ["booked", "tickets", "billed", "outstanding"]), items: [
      item("calendar", 0, 0, 9, 15), item("cons.backlog", 0, 15, 9, 7), item("desk", 9, 0, 8, 22), item("cons.team", 17, 0, 7, 12), item("cons.bills", 17, 12, 7, 10)] };
    case "sales": return { v: 1, hero: "full", figs: keep(prefs[SALES_PREF], ["pipeline", "weighted", "won_month", "closing"]), items: [
      item("calendar", 0, 0, 9, 16), item("sales.stages", 0, 16, 9, 6), item("desk", 9, 0, 8, 22), item("sales.closing", 17, 0, 7, 10), item("sales.attention", 17, 10, 7, 12)] };
    case "marketing": return { v: 1, hero: "full", figs: ["booked", "tickets", "mk_sent", "mk_open"], items: [
      item("calendar", 0, 0, 9, 14), item("mk.lists", 0, 14, 9, 8), item("desk", 9, 0, 8, 22), item("mk.campaigns", 17, 0, 7, 11), item("mk.posts", 17, 11, 7, 11)] };
    case "management": return { v: 1, hero: "full", figs: ["booked", "tickets", "outstanding", "pipeline"], items: [
      item("calendar", 0, 0, 9, 14), item("mgmt.quiet", 0, 14, 9, 8), item("desk", 9, 0, 8, 22), item("mgmt.summary", 17, 0, 7, 11), item("mgmt.pipeline", 17, 11, 7, 11)] };
    default: return { v: 1, hero: "full", figs: ["booked", "tickets", "tasks"], items: [item("calendar", 0, 0, 12, 22), item("desk", 12, 0, 12, 22)] };
  }
}
/** A saved board, checked: unknown cards dropped, sizes kept inside the grid, no overlaps. */
function readBoard(v: any): BoardState | null {
  if (!v || v.v !== 1 || !Array.isArray(v.items)) return null;
  const items: BoardItem[] = v.items
    .filter((i: any) => i && typeof i.key === "string" && DEF[i.key])
    .map((i: any) => {
      const d = DEF[i.key];
      const w = Math.max(d.min[0], Math.min(COLS, Math.round(Number(i.w) || d.def[0])));
      const h = Math.max(d.min[1], Math.min(60, Math.round(Number(i.h) || d.def[1])));
      const lay: CalLay | undefined = i.key === "calendar" && (i.lay === "side" || i.lay === "stack") ? i.lay : undefined;
      return { id: typeof i.id === "string" ? i.id : newId(), key: i.key, x: Math.max(0, Math.min(COLS - w, Math.round(Number(i.x) || 0))), y: Math.max(0, Math.round(Number(i.y) || 0)), w, h, ...(lay ? { lay } : {}) };
    });
  const figs = (Array.isArray(v.figs) ? v.figs : []).filter((k: any, i: number, all: any[]) => typeof k === "string" && DEF[k]?.fig && all.indexOf(k) === i).slice(0, MAX_FIGS);
  return { v: 1, hero: v.hero === "compact" ? "compact" : "full", figs, items: compactAll(items) };
}

/* ---- the grid's rules: no overlaps, everything falls up ---- */
const hit = (a: BoardItem, b: BoardItem) => a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Each card, in order, goes as high as it can without touching the ones already placed. `fixed` stays exactly where it is. */
function settle(list: BoardItem[], order: (a: BoardItem, b: BoardItem) => number, fixed?: BoardItem): BoardItem[] {
  const out: BoardItem[] = fixed ? [{ ...fixed }] : [];
  for (const it of list.filter((i) => i.id !== fixed?.id).sort(order)) {
    const n = { ...it, y: Math.max(0, it.y) };
    while (n.y > 0 && !out.some((o) => hit({ ...n, y: n.y - 1 }, o))) n.y--;
    for (let c = out.find((o) => hit(n, o)); c; c = out.find((o) => hit(n, o))) n.y = c.y + c.h;
    // cards of a fractional height (the deal page's, fitted to what they hold): no gap under the card above
    const floor = out.reduce((m, o) => (o.x < n.x + n.w && n.x < o.x + o.w && o.y + o.h <= n.y + 1e-6 ? Math.max(m, o.y + o.h) : m), 0);
    if (floor < n.y) n.y = floor;
    out.push(n);
  }
  return out;
}
const byTop = (a: BoardItem, b: BoardItem) => a.y - b.y || a.x - b.x;
export function compactAll(list: BoardItem[]): BoardItem[] { return settle(list, byTop); }
/** A card dropped at (x, y): it goes before a neighbour once it passes the neighbour's middle (like a sortable list). */
function moveTo(list: BoardItem[], id: string, x: number, y: number): BoardItem[] {
  const d = list.find((i) => i.id === id);
  if (!d) return list;
  const dir = Math.sign(y - d.y);
  const keyOf = (i: BoardItem) => (i.id === id ? (dir > 0 ? y + d.h - 0.01 : dir < 0 ? y - 0.01 : y + d.h / 2 - 0.01) : i.y + i.h / 2);
  return settle(list.map((i) => (i.id === id ? { ...i, x, y } : i)), (a, b) => keyOf(a) - keyOf(b) || a.x - b.x);
}
/** A card given a new size where it stands: what's in the way moves down, then everything falls up. */
export function resizeTo(list: BoardItem[], id: string, w: number, h: number): BoardItem[] {
  const d = list.find((i) => i.id === id);
  if (!d) return list;
  const x = Math.min(d.x, COLS - w);
  return compactAll(settle(list, byTop, { ...d, x, w, h }));
}
/** The highest free spot for a new card (left to right, top to bottom). */
export function firstFit(list: BoardItem[], w: number, h: number): { x: number; y: number } {
  const bottom = list.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  for (let y = 0; y <= bottom; y++) for (let x = 0; x + w <= COLS; x++) {
    const probe = { id: "_", key: "", x, y, w, h };
    if (!list.some((o) => hit(probe, o))) return { x, y };
  }
  return { x: 0, y: bottom };
}
/** What a card shows at its size: itself, or (too small) its headline figure. */
const shownKey = (it: BoardItem) => {
  const d = DEF[it.key];
  return d?.full && d.summary && (it.w < d.full[0] || it.h < d.full[1]) ? d.summary : it.key;
};
/** Width / height steps (px) every card is styled by: each step has its own look. */
const tierW = (px: number) => (px < 300 ? 1 : px < 430 ? 2 : px < 620 ? 3 : px < 900 ? 4 : 5);
const tierH = (px: number) => (px < 150 ? 1 : px < 300 ? 2 : px < 500 ? 3 : 4);
/** Side by side needs this much width; below it the calendar is always top and bottom. */
const SIDE_MIN_PX = 620;
/** The calendar goes side by side only when that is chosen (top and bottom unless) and the card is wide enough. */
const isSplitCal = (it: BoardItem, pxW: number) => it.key === "calendar" && it.lay === "side" && pxW >= SIDE_MIN_PX;
/** The name of the look a card takes at a size (shown while adjusting). */
function lookOf(it: BoardItem, pxW: number, pxH: number): string {
  const d = DEF[it.key];
  if (shownKey(it) !== it.key) return "Headline";
  if (d.fig) return pxH < 90 || pxW < 230 ? "Mini" : pxW >= 560 && pxH < 150 ? "Strip" : pxW >= 480 && pxH >= 240 ? "Spotlight" : pxH >= 220 && pxW < 420 ? "Tower" : "Standard";
  if (it.key === "calendar") return isSplitCal(it, pxW) ? "Side by side" : pxW >= SIDE_MIN_PX ? "Top and bottom" : ["", "Slim", "Compact", "Standard"][tierW(pxW)];
  return ["", "Slim", "Compact", "Standard", "Wide", "Extra wide"][tierW(pxW)];
}
/** Ready-made sizes for the size menu. */
function presetsOf(d: CardDef): { label: string; w: number; h: number }[] {
  if (d.fig) return [{ label: "Small", w: 4, h: 3 }, { label: "Medium", w: 6, h: 4 }, { label: "Large", w: 8, h: 6 }, { label: "Wide", w: 12, h: 4 }];
  const out: { label: string; w: number; h: number }[] = [];
  if (d.summary && d.full) out.push({ label: "Headline figure", w: 6, h: 4 });
  const s = d.full ?? d.min;
  out.push({ label: "Small", w: s[0], h: s[1] });
  out.push({ label: "Medium", w: d.def[0], h: d.def[1] });
  out.push({ label: "Large", w: Math.min(COLS, d.def[0] + 4), h: d.def[1] + 6 });
  out.push({ label: "Full width", w: COLS, h: d.def[1] });
  return out.filter((p, i, all) => all.findIndex((q) => q.w === p.w && q.h === p.h) === i);
}

const GLYPHS: Record<Glyph, ReactNode> = {
  cal: <><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  desk: <><path d="M4 13l2.4-7.2A2 2 0 0 1 8.3 4.5h7.4a2 2 0 0 1 1.9 1.3L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M4 13h4.5l1.5 2.5h4l1.5-2.5H20" /></>,
  stages: <path d="M4 6h16M6 11h12M8.5 16h7M11 20.5h2" />,
  clock: <><circle cx="12" cy="12.5" r="8" /><path d="M12 8.5v4.2l2.8 1.8" /></>,
  alert: <><path d="M12 4l9 15.5H3z" /><path d="M12 10v4.2M12 17.2v.1" /></>,
  team: <><circle cx="9" cy="9" r="3.2" /><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6" /><circle cx="17" cy="9.5" r="2.5" /><path d="M16 14.6c2.3-.2 4 1.2 4.5 3.9" /></>,
  bill: <><path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2z" /><path d="M9 8.5h6M9 12h6" /></>,
  stack: <><path d="M12 4l8.5 4.3L12 12.6 3.5 8.3z" /><path d="M3.5 12.2L12 16.5l8.5-4.3M3.5 16L12 20.3 20.5 16" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M4 7l8 6 8-6" /></>,
  share: <><circle cx="17.5" cy="6" r="2.5" /><circle cx="6.5" cy="12" r="2.5" /><circle cx="17.5" cy="18" r="2.5" /><path d="M8.7 10.8l6.6-3.6M8.7 13.2l6.6 3.6" /></>,
  users: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" /></>,
  coins: <><ellipse cx="10" cy="7" rx="6" ry="2.6" /><path d="M4 7v4.5c0 1.4 2.7 2.6 6 2.6M16 7v2" /><ellipse cx="15" cy="14" rx="5.5" ry="2.4" /><path d="M9.5 14v3.6c0 1.3 2.5 2.4 5.5 2.4s5.5-1.1 5.5-2.4V14" /></>,
  quiet: <><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" /><path d="M9 10.5h6" /></>,
  trophy: <><path d="M8 4h8v5a4 4 0 0 1-8 0z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7" /></>,
  num: <path d="M9 4L7 20M17 4l-2 16M4.5 9h15M3.5 15h15" />,
  ring: <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 8 8" strokeWidth="3" /></>,
  pipe: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
};
const Glyph = ({ g }: { g: Glyph }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPHS[g]}</svg>;

/** The nearest box that scrolls the page (for moving cards past the bottom of the screen). */
function scrollerOf(el: HTMLElement | null): HTMLElement {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight + 2) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

/* ---------------------------------------------------------------------
   The board can carry any set of cards: a kit says what each card is
   called, how small it may go, how it looks at a size and what extra
   controls it has. The home brings its own (HOME_KIT); the deal page
   brings another.
   --------------------------------------------------------------------- */
export interface KitCtx { items: BoardItem[]; sx: number; stack: boolean; onChange: (next: BoardItem[]) => void; close: () => void }
export interface BoardKit {
  min: (key: string) => [number, number];
  title: (key: string) => string;
  icon: (key: string) => ReactNode;
  color: (key: string) => string | undefined;
  /** what the card draws at its size (the home's cards show their headline figure when too small) */
  shown: (it: BoardItem) => string;
  /** a single figure (its bar only shows on hover) */
  fig: (key: string) => boolean;
  /** a click on the card opens something */
  link: (it: BoardItem) => boolean;
  /** the name of the look at a size, and a tip for it */
  look: (it: BoardItem, pxW: number, pxH: number) => string;
  lookTip?: (it: BoardItem, pxW: number, pxH: number) => string;
  /** extra classes for a card at a size */
  cls?: (it: BoardItem, pxW: number, pxH: number) => string;
  snug?: (it: BoardItem, pxW: number, pxH: number) => boolean;
  presets: (key: string) => { label: string; w: number; h: number }[];
  bar?: (it: BoardItem, pxW: number, ctx: KitCtx) => ReactNode;
  menu?: (it: BoardItem, ctx: KitCtx) => ReactNode;
  /** height on a phone (cards one under the other) */
  stackH: (it: BoardItem) => number;
  /** rows that fill the screen (draws "End of your screen" while adjusting) */
  screenRows?: number;
}

const LAYS_K: { k: CalLay; label: string }[] = [{ k: "stack", label: "Top and bottom" }, { k: "side", label: "Side by side" }];
/** The calendar's layout; side by side widens the card first if it's too narrow for it. */
function setCalLay(it: BoardItem, lay: CalLay, ctx: KitCtx) {
  let next = ctx.items.map((i) => (i.id === it.id ? { ...i, lay } : i));
  const need = Math.min(COLS, Math.ceil((SIDE_MIN_PX + GAP) / Math.max(1, ctx.sx)));
  if (lay === "side" && it.w < need) next = resizeTo(next, it.id, need, it.h);
  ctx.onChange(next);
}
const HOME_KIT: BoardKit = {
  min: (k) => DEF[k]?.min ?? [4, 3],
  title: (k) => DEF[k]?.title ?? k,
  icon: (k) => <Glyph g={DEF[k]?.glyph ?? "num"} />,
  color: (k) => DEPTS.find((x) => x.key === DEF[k]?.dept)?.color,
  shown: shownKey,
  fig: (k) => DEF[k]?.fig ?? false,
  link: (it) => !!DEF[it.key]?.go && it.key !== "desk" && it.key !== "calendar",
  look: lookOf,
  lookTip: (it) => (shownKey(it) !== it.key ? "Too small for the whole card: it shows its headline figure. Make it bigger to see everything." : "How the card looks at this size"),
  cls: (it, pxW) => (isSplitCal(it, pxW) ? "is-split" : ""),
  snug: (it, pxW, pxH) => pxH < 560 && !(isSplitCal(it, pxW) && pxH >= 300),
  presets: (k) => presetsOf(DEF[k]),
  bar: (it, pxW, ctx) => it.key === "calendar" && shownKey(it) === it.key && !ctx.stack && pxW >= 460 ? (
    <span className="hb-lay" role="radiogroup" aria-label="Layout" onPointerDown={(e) => e.stopPropagation()}>
      {LAYS_K.map((l) => (
        <button key={l.k} type="button" role="radio" aria-checked={(it.lay ?? "stack") === l.k} className={(it.lay ?? "stack") === l.k ? "is-on" : ""} title={l.label} aria-label={l.label} onClick={() => setCalLay(it, l.k, ctx)}>
          <LayPic k={l.k} />
        </button>
      ))}
    </span>
  ) : null,
  menu: (it, ctx) => it.key === "calendar" ? (
    <>
      <b className="hb-sizes-h">Layout</b>
      <div className="hb-sizes-lay" role="radiogroup" aria-label="Layout">
        {LAYS_K.map((l) => (
          <button key={l.k} type="button" role="radio" aria-checked={(it.lay ?? "stack") === l.k} className={(it.lay ?? "stack") === l.k ? "is-on" : ""} onClick={() => { setCalLay(it, l.k, ctx); ctx.close(); }}>
            <LayPic k={l.k} /><span>{l.label}</span>
          </button>
        ))}
      </div>
    </>
  ) : null,
  stackH: (it) => (DEF[it.key]?.fig || shownKey(it) !== it.key ? 132 : Math.max(260, Math.min(640, it.h * 30))),
  screenRows: SCREEN_ROWS,
};

type Drag = { id: string; mode: "move" | "e" | "s" | "se"; x0: number; y0: number; sc0: number; orig: BoardItem; dx: number; dy: number; prev: BoardItem[] };

export function HomeBoard({ items, editing, step, onChange, onPreview, slotRef, onRemove, flash, onOpen, kit = HOME_KIT, className = "" }: {
  kit?: BoardKit;
  className?: string;
  items: BoardItem[];
  editing: boolean;
  /** one row + gap, px */
  step: number;
  onChange: (next: BoardItem[]) => void;
  /** while a card is being resized: the grid as it would be (so the cards change their look live) */
  onPreview: (list: BoardItem[] | null) => void;
  slotRef: (id: string) => (el: HTMLElement | null) => void;
  onRemove: (id: string) => void;
  flash: string | null;
  onOpen: (it: BoardItem) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = () => setWidth(el.clientWidth);
    m();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(m) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const stack = width > 0 && width < 760;
  const colW = (width - GAP * (COLS - 1)) / COLS;
  const sx = colW + GAP;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<{ id: string; at: DOMRect } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const ctx: KitCtx = { items, sx, stack, onChange, close: () => setMenu(null) };

  /* ---- what the grid looks like while a card is held ---- */
  const preview = useMemo(() => {
    if (!drag) return items;
    const o = drag.orig;
    if (drag.mode === "move") {
      const x = Math.max(0, Math.min(COLS - o.w, Math.round((o.x * sx + drag.dx) / sx)));
      const y = Math.max(0, Math.round((o.y * step + drag.dy) / step));
      return moveTo(drag.prev, o.id, x, y);
    }
    const mn = kit.min(o.key);
    const w = drag.mode === "s" ? o.w : Math.max(mn[0], Math.min(COLS - o.x, Math.round(o.w + drag.dx / sx)));
    const h = drag.mode === "e" ? o.h : Math.max(mn[1], Math.min(60, Math.round(o.h + drag.dy / step)));
    return resizeTo(drag.prev, o.id, w, h);
  }, [drag, items, sx, step]);

  // tell the page only when what a card shows changes (headline ↔ whole card), not on every pixel
  const sig = preview === items ? "" : preview.map((i) => `${i.id}:${kit.shown(i)}`).join("|");
  const base = items.map((i) => `${i.id}:${kit.shown(i)}`).join("|");
  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(() => { onPreview(sig && sig !== base ? previewRef.current : null); }, [sig, base]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (it: BoardItem, mode: Drag["mode"]) => (e: React.PointerEvent) => {
    if (!editing || stack || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    setMenu(null);
    const sc = scrollerOf(ref.current);
    const d: Drag = { id: it.id, mode, x0: e.clientX, y0: e.clientY, sc0: sc.scrollTop, orig: it, dx: 0, dy: 0, prev: items };
    setDrag(d);
    let px = e.clientX, py = e.clientY, raf = 0, auto = 0;
    const apply = () => {
      raf = 0;
      const cur = dragRef.current;
      if (!cur) return;
      setDrag({ ...cur, dx: px - cur.x0, dy: py - cur.y0 + (sc.scrollTop - cur.sc0) });
    };
    // past the top / bottom edge of the screen: the page scrolls along
    const edge = () => {
      const H = window.innerHeight;
      const v = py > H - 70 ? Math.min(18, (py - (H - 70)) / 3) : py < 70 ? -Math.min(18, (70 - py) / 3) : 0;
      if (v) { sc.scrollTop += v; if (!raf) raf = requestAnimationFrame(apply); }
      auto = requestAnimationFrame(edge);
    };
    auto = requestAnimationFrame(edge);
    const move = (ev: PointerEvent) => { px = ev.clientX; py = ev.clientY; if (!raf) raf = requestAnimationFrame(apply); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      cancelAnimationFrame(auto); if (raf) cancelAnimationFrame(raf);
      apply();
      const cur = dragRef.current;
      setDrag(null);
      if (!cur) return;
      // the final grid, worked out from where it was let go
      const o = cur.orig, def = { min: kit.min(o.key) };
      let next: BoardItem[];
      if (cur.mode === "move") {
        const x = Math.max(0, Math.min(COLS - o.w, Math.round((o.x * sx + cur.dx) / sx)));
        const y = Math.max(0, Math.round((o.y * step + cur.dy) / step));
        next = moveTo(cur.prev, o.id, x, y);
      } else {
        const w = cur.mode === "s" ? o.w : Math.max(def.min[0], Math.min(COLS - o.x, Math.round(o.w + cur.dx / sx)));
        const h = cur.mode === "e" ? o.h : Math.max(def.min[1], Math.min(60, Math.round(o.h + cur.dy / step)));
        next = resizeTo(cur.prev, o.id, w, h);
      }
      if (JSON.stringify(next) !== JSON.stringify(cur.prev)) onChange(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /* ---- keyboard: arrows move, shift + arrows resize, delete takes it away ---- */
  const onKey = (it: BoardItem) => (e: React.KeyboardEvent) => {
    if (!editing || e.target !== e.currentTarget) return;
    const d = { min: kit.min(it.key) };
    const k = e.key;
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); onRemove(it.id); return; }
    const dx = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0, dy = k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    if (e.shiftKey) onChange(resizeTo(items, it.id, Math.max(d.min[0], Math.min(COLS - it.x, it.w + dx)), Math.max(d.min[1], Math.min(60, it.h + dy))));
    else onChange(moveTo(items, it.id, Math.max(0, Math.min(COLS - it.w, it.x + dx)), Math.max(0, it.y + (dy > 0 ? it.h : dy))));
  };

  /* ---- a click on a card (not on one of its buttons) opens its page.
     Native: the cards' content is drawn through portals, so React's own click
     never passes through the card. The calendar and the desk are workspaces: only their own links. ---- */
  const live = useRef({ editing, items, onOpen });
  live.current = { editing, items, onOpen };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const click = (e: MouseEvent) => {
      const { editing: ed, items: list, onOpen: open } = live.current;
      if (ed || e.defaultPrevented || e.button !== 0) return;
      const t = e.target as Element;
      const card = t.closest?.(".hb-card.is-link") as HTMLElement | null;
      if (!card || !el.contains(card)) return;
      const inner = t.closest("button, a, input, select, textarea, label, [role], [tabindex], [contenteditable]");
      if (inner && card.contains(inner) && inner !== card) return;
      if (window.getSelection()?.toString()) return;
      const it = list.find((i) => i.id === card.dataset.id);
      if (it) open(it);
    };
    el.addEventListener("click", click);
    return () => el.removeEventListener("click", click);
  }, []);

  // a card follows the pointer; the others make room
  const rect = (it: BoardItem) => ({ left: it.x * sx, top: it.y * step, width: it.w * sx - GAP, height: it.h * step - GAP });
  const shown = preview;
  const rows = shown.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  const height = Math.max(0, (rows + (editing ? 5 : 0)) * step - GAP);
  const held = drag ? shown.find((i) => i.id === drag.id) ?? null : null;
  // the cards keep their place in the page (no moving nodes around); only the stagger follows the grid
  const rank = new Map([...items].sort(byTop).map((i, k) => [i.id, k]));

  return (
    <div ref={ref} className={`hb ${className} ${editing ? "is-editing" : ""} ${drag ? "is-dragging" : ""} ${stack ? "is-stack" : ""}`}
      style={stack ? undefined : { height, ["--sx" as string]: `${sx}px`, ["--sy" as string]: `${step}px`, ["--cw" as string]: `${colW}px` } as CSSProperties}>
      {editing && !stack && width > 0 && (
        <>
          <i className="hb-guides" aria-hidden="true" />
          {kit.screenRows && kit.screenRows * step - GAP < height && <i className="hb-fold" style={{ top: kit.screenRows * step - GAP / 2 }} aria-hidden="true"><span>End of your screen</span></i>}
        </>
      )}
      {held && <i className="hb-ph" style={rect(held)} aria-hidden="true" />}
      {width > 0 && items.map((o) => {
        const idx = rank.get(o.id) ?? 0;
        const it = shown.find((i) => i.id === o.id) ?? o;
        const isHeld = drag?.id === it.id;
        const r = rect(isHeld ? drag!.orig : it);
        const style: CSSProperties = stack
          ? { order: idx, height: kit.stackH(it) }
          : isHeld
            ? drag!.mode === "move"
              ? { left: r.left + drag!.dx, top: r.top + drag!.dy, width: r.width, height: r.height }
              : { left: r.left, top: r.top, width: Math.max(colW, r.width + (drag!.mode === "s" ? 0 : drag!.dx)), height: Math.max(step - GAP, r.height + (drag!.mode === "e" ? 0 : drag!.dy)) }
            : r;
        const sk = kit.shown(it);
        const fig = kit.fig(sk);
        const pxH = stack ? Number(style.height) || 260 : it.h * step - GAP, pxW = stack ? width : it.w * sx - GAP;
        const cls = [
          "hb-card", fig ? "is-fig" : `is-panel k-${it.key.replace(/\./g, "-")}`,
          isHeld ? `is-held is-${drag!.mode}` : "", flash === it.id ? "is-new" : "",
          !fig && (kit.snug ? kit.snug(it, pxW, pxH) : pxH < 560) ? "is-snug" : "", !fig && pxH < 330 ? "is-tiny" : "", !fig && pxW < 350 ? "is-narrow" : "", !fig && pxW < 460 ? "is-mid" : "", !fig && pxW > 760 ? "is-wide" : "",
          !fig && kit.link(it) ? "is-link" : "",
          !fig ? `sw-${tierW(pxW)} sh-${tierH(pxH)}` : "", !fig && kit.cls ? kit.cls(it, pxW, pxH) : "",
        ].filter(Boolean).join(" ");
        const look = kit.look(it, pxW, pxH);
        return (
          <div key={it.id} className={cls} style={{ ...style, ["--i" as string]: Math.min(idx, 12) } as CSSProperties} data-id={it.id}
            tabIndex={editing ? 0 : undefined} onKeyDown={editing ? onKey(it) : undefined}
            aria-label={editing ? `${kit.title(it.key)}: ${it.w} by ${it.h}. Arrows move it, Shift and arrows resize it, Delete takes it away.` : undefined}
>
            <div className="hb-slot" ref={slotRef(it.id)} />
            {fig && !stack && <span className="hb-fig-mark" style={{ ["--c" as string]: kit.color(sk) } as CSSProperties} aria-hidden="true">{kit.icon(sk)}</span>}
            {editing && (
              <>
                <div className="hb-veil" onPointerDown={start(it, "move")} />
                <div className="hb-bar" onPointerDown={start(it, "move")}>
                  <span className="hb-grip" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg></span>
                  <span className="hb-bar-ico" style={{ ["--c" as string]: kit.color(it.key) } as CSSProperties}>{kit.icon(it.key)}</span>
                  <b className="hb-bar-t">{kit.title(it.key)}</b>
                  <em className={`hb-bar-tag ${sk !== it.key ? "is-head" : ""}`} title={kit.lookTip ? kit.lookTip(it, pxW, pxH) : "How the card looks at this size"}>{look}</em>
                  <span className="hb-bar-grow" />
                  {kit.bar?.(it, pxW, ctx)}
                  {!stack && (
                    <button type="button" className={`hb-bar-btn ${menu?.id === it.id ? "is-on" : ""}`} title="Size" aria-label="Size"
                      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => setMenu(menu?.id === it.id ? null : { id: it.id, at: e.currentTarget.getBoundingClientRect() })}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>
                      <span>{it.w}×{it.h}</span>
                    </button>
                  )}
                  <button type="button" className="hb-bar-btn is-x" title="Take it off your home" aria-label="Remove"
                    onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemove(it.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </div>
                {!stack && (
                  <>
                    <span className="hb-rz is-e" onPointerDown={start(it, "e")} title="Drag to make it wider or narrower" />
                    <span className="hb-rz is-s" onPointerDown={start(it, "s")} title="Drag to make it taller or shorter" />
                    <span className="hb-rz is-se" onPointerDown={start(it, "se")} title="Drag to resize" />
                  </>
                )}
                {isHeld && drag!.mode !== "move" && <span className="hb-size" aria-hidden="true"><b>{look}</b>{it.w} × {it.h}</span>}
              </>
            )}
          </div>
        );
      })}
      {menu && (() => {
        const it = items.find((i) => i.id === menu.id);
        if (!it) return null;
        return <SizeMenu at={menu.at} it={it} list={kit.presets(it.key)} extra={kit.menu?.(it, ctx)} onPick={(w, h) => { onChange(resizeTo(items, it.id, Math.min(w, COLS), h)); setMenu(null); }} onClose={() => setMenu(null)} />;
      })()}
    </div>
  );
}

/** A little picture of the two calendar layouts. */
function LayPic({ k }: { k: CalLay }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      {k === "stack" ? <path d="M3.5 12h17" stroke="currentColor" strokeWidth="1.8" /> : <path d="M11 4.5v15" stroke="currentColor" strokeWidth="1.8" />}
    </svg>
  );
}

function SizeMenu({ at, it, list, extra, onPick, onClose }: { at: DOMRect; it: BoardItem; list: { label: string; w: number; h: number }[]; extra?: ReactNode; onPick: (w: number, h: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".hb-bar-btn")) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", off);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", off); document.removeEventListener("keydown", key); };
  }, [onClose]);
  const W = 228;
  const max = Math.max(...list.map((p) => p.w)), maxH = Math.max(...list.map((p) => p.h));
  return createPortal(
    <div ref={ref} className="hb-sizes" role="menu" style={{ top: Math.max(8, Math.min(at.bottom + 6, window.innerHeight - 60 - list.length * 40 - (extra ? 96 : 0))), left: Math.max(8, Math.min(at.right - W, window.innerWidth - W - 8)), width: W }}>
      {extra}
      <b className="hb-sizes-h">Size</b>
      {list.map((p) => {
        const on = p.w === it.w && p.h === it.h;
        return (
          <button key={p.label} type="button" role="menuitemradio" aria-checked={on} className={on ? "is-on" : ""} onClick={() => onPick(p.w, p.h)}>
            <span className="hb-sizes-pic"><i style={{ width: `${Math.max(14, (p.w / max) * 100)}%`, height: `${Math.max(22, (p.h / maxH) * 100)}%` }} /></span>
            <span className="hb-sizes-t">{p.label}</span>
            <em>{p.w}×{p.h}</em>
          </button>
        );
      })}
      <p className="hb-sizes-tip">Or pull the right or bottom edge of the card.</p>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------------
   Sources that live here: what everyone has (calendar, desk, today's
   figures), marketing and management.
   --------------------------------------------------------------------- */
function GeneralCards({ slots, userId, hoursPerDay, needCal }: { slots: HomeSlot[]; userId: string; hoursPerDay: number; needCal: boolean }) {
  const nav = useNavigate();
  const [cal, setCal] = useState<CalSummary | null>(null);
  useEffect(() => {
    const on = (e: Event) => setCal((e as CustomEvent<CalSummary>).detail);
    window.addEventListener(CAL_SUMMARY_EVENT, on);
    return () => window.removeEventListener(CAL_SUMMARY_EVENT, on);
  }, []);
  type Tix = { open: number; late: number; today: number };
  const [tix, setTix] = useState<Tix | null>(null);
  const [tasks, setTasks] = useState<Tix | null>(null);
  const wants = slots.some((s) => s.key === "tickets" || s.key === "tasks");
  useEffect(() => {
    if (!wants) return;
    let alive = true;
    const load = async () => {
      let r: any = await supabase.from("tracking_tasks").select("id, done, status, stage, due_at, source, requester_email, requester_name, category").eq("assignee_id", userId).range(0, 4999);
      if (r.error) r = await supabase.from("tracking_tasks").select("id, done, status, stage, due_at, source, requester_email, requester_name").eq("assignee_id", userId).range(0, 4999);
      if (r.error) r = await supabase.from("tracking_tasks").select("id, done, status, due_at").eq("assignee_id", userId).range(0, 4999);
      if (!alive || r.error) return;
      const now = Date.now();
      const end = new Date(); end.setHours(23, 59, 59, 999);
      const open = ((r.data ?? []) as any[]).filter((t) => !(t.done || t.status === "done" || ["resolved", "closed"].includes(t.stage)));
      // tickets are conversations (e-mail, messages, calls); tasks are the work
      const isTicket = (t: any) => (t.category ? t.category === "ticket" : ["email", "phone", "portal", "message"].includes(t.source) || !!t.requester_email || !!t.requester_name);
      const tally = (xs: any[]): Tix => ({
        open: xs.length,
        late: xs.filter((t) => t.due_at && new Date(t.due_at).getTime() < now).length,
        today: xs.filter((t) => t.due_at && new Date(t.due_at).getTime() >= now && new Date(t.due_at).getTime() <= end.getTime()).length,
      });
      setTix(tally(open.filter(isTicket)));
      setTasks(tally(open.filter((t) => !isTicket(t))));
    };
    load().catch(() => {});
    const again = () => { load().catch(() => {}); };
    window.addEventListener(TICKETS_EVENT, again);
    return () => { alive = false; window.removeEventListener(TICKETS_EVENT, again); };
  }, [userId, wants]);
  const cOpen = useCount(tix?.open ?? 0, 600);
  const cTasks = useCount(tasks?.open ?? 0, 600);
  const cToday = useCount(cal?.todayMin ?? 0, 700);
  const hrs = (m: number) => `${+(m / 60).toFixed(1)}h`;
  const todayPct = cal ? (cal.todayCap > 0 ? (cal.todayMin / cal.todayCap) * 100 : cal.todayMin > 0 ? 101 : 0) : 0;
  const card = (key: string): ReactNode => {
    switch (key) {
      case "calendar": return <HomeCalendar userId={userId} hoursPerDay={hoursPerDay} />;
      case "desk": return <TicketDesk />;
      case "booked": return (
        <Fig cls="is-today" onClick={() => nav("/calendar")} title="Open your calendar">
          <Ring pct={todayPct} size={58} stroke={6}><b>{cal ? `${Math.round(Math.min(todayPct, 999))}%` : "…"}</b></Ring>
          <Txt label="Booked today" value={cal ? hrs(cToday) : "…"} unit={cal ? ` of ${hrs(cal.todayCap)}` : ""}
            sub={cal?.next ? <>Next: <em>{cal.next.time}</em> {cal.next.title}{cal.next.today ? "" : " (later this week)"}</> : cal ? "Nothing else booked" : "Reading your calendar…"} />
        </Fig>
      );
      case "tickets": case "tasks": {
        const x = key === "tickets" ? tix : tasks;
        const c = key === "tickets" ? cOpen : cTasks;
        return (
          <Fig cls={`is-tix ${x && x.late > 0 ? "has-late" : ""}`} onClick={() => nav(key === "tickets" ? "/tickets" : "/tickets?kind=task")} title={key === "tickets" ? "Open your tickets" : "Open your tasks"}>
            <Txt label={key === "tickets" ? "Open tickets" : "Open tasks"} value={x ? Math.round(c) : "…"} big>
              <span className="chx-chips">
                {x && x.late > 0 && <span className="chx-chip is-late">{x.late} late</span>}
                {x && x.today > 0 && <span className="chx-chip is-today">{x.today} due today</span>}
                {x && x.late === 0 && x.today === 0 && <span className="chx-chip is-ok">{x.open ? "All on time" : key === "tickets" ? "Inbox zero" : "Nothing pending"}</span>}
              </span>
            </Txt>
          </Fig>
        );
      }
      default: return null;
    }
  };
  return (
    <>
      {renderSlots(slots, card)}
      {/* "Booked today" without the calendar card: the calendar still reads the day, out of sight */}
      {needCal && <div className="hb-offstage" aria-hidden="true"><HomeCalendar userId={userId} hoursPerDay={hoursPerDay} /></div>}
    </>
  );
}

const MK_NETS: Record<string, { label: string; short: string; color: string }> = {
  linkedin: { label: "LinkedIn", short: "in", color: "#0a66c2" }, instagram: { label: "Instagram", short: "IG", color: "#d62976" },
  facebook: { label: "Facebook", short: "f", color: "#1877f2" }, x: { label: "X", short: "X", color: "#14171a" },
  tiktok: { label: "TikTok", short: "TT", color: "#ee1d52" }, threads: { label: "Threads", short: "@", color: "#3d3d3d" }, youtube: { label: "YouTube", short: "YT", color: "#e62117" },
};
const MK_STATUS: Record<string, string> = { draft: "Draft", scheduled: "Scheduled", sending: "Sending", paused: "Paused", sent: "Sent", cancelled: "Cancelled", idea: "Idea", published: "Published", failed: "Failed" };
interface MkCamp { id: string; name: string; status: string; when: string | null; total: number; sent: number; opened: number; clicked: number }
interface MkData {
  missing: boolean; camps: MkCamp[]; sentMonth: number | null; sent30: number | null; opened30: number | null; unsub30: number | null;
  posts: { id: string; title: string; networks: string[]; status: string; at: string | null }[];
  lists: { id: string; name: string; kind: string; entity: string; members: number }[];
}
function MarketingCards({ slots }: { slots: HomeSlot[] }) {
  const nav = useNavigate();
  const [d, setD] = useState<MkData | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const now = new Date();
      const month = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const ago30 = new Date(Date.now() - 30 * 864e5).toISOString();
      const count = (q: any) => Promise.resolve(q).then((r: any) => (r?.error ? null : (r?.count ?? 0) as number), () => null);
      const [cr, pr, lr, sentMonth, sent30, opened30, unsub30] = await Promise.all([
        Promise.resolve(supabase.from("marketing_campaigns").select("id, name, status, scheduled_at, started_at, finished_at, stats, created_at").order("created_at", { ascending: false }).limit(12)).catch(() => ({ data: null, error: { message: "x" } })) as any,
        Promise.resolve(supabase.from("marketing_posts").select("id, title, body, networks, status, scheduled_at").gte("scheduled_at", now.toISOString()).order("scheduled_at", { ascending: true }).limit(30)).catch(() => ({ data: null, error: { message: "x" } })) as any,
        Promise.resolve(supabase.from("marketing_lists").select("id, name, kind, entity, member_count, updated_at").order("updated_at", { ascending: false }).limit(30)).catch(() => ({ data: null, error: { message: "x" } })) as any,
        count(supabase.from("marketing_sends").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", month)),
        count(supabase.from("marketing_sends").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", ago30)),
        count(supabase.from("marketing_sends").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", ago30).not("opened_at", "is", null)),
        count(supabase.from("marketing_unsubscribes").select("id", { count: "exact", head: true }).gte("created_at", ago30)),
      ]);
      const camps0 = ((cr?.data ?? []) as any[]);
      // opens and clicks of the latest campaigns, read in one go
      const agg = new Map<string, { opened: number; clicked: number; sent: number; total: number }>();
      if (camps0.length) {
        let sr: any = await Promise.resolve(supabase.from("marketing_sends").select("campaign_id, status, opened_at, clicked_at").in("campaign_id", camps0.map((c) => c.id)).range(0, 49999)).catch(() => null);
        if (!sr || sr.error) sr = await Promise.resolve(supabase.from("marketing_sends").select("campaign_id, status").in("campaign_id", camps0.map((c) => c.id)).range(0, 49999)).catch(() => null);
        ((sr?.data ?? []) as any[]).forEach((s) => {
          if (s.status === "skipped") return;
          const a = agg.get(s.campaign_id) ?? { opened: 0, clicked: 0, sent: 0, total: 0 };
          a.total++; if (s.status === "sent") a.sent++; if (s.opened_at) a.opened++; if (s.clicked_at) a.clicked++;
          agg.set(s.campaign_id, a);
        });
      }
      if (!alive) return;
      setD({
        missing: !!cr?.error && !!lr?.error,
        camps: camps0.map((c) => {
          const a = agg.get(c.id);
          const st = c.stats ?? {};
          return { id: c.id, name: c.name || "Untitled campaign", status: c.status, when: c.finished_at ?? c.started_at ?? c.scheduled_at ?? c.created_at ?? null,
            total: a?.total ?? (Number(st.total) || 0), sent: a?.sent ?? (Number(st.sent) || 0), opened: a?.opened ?? 0, clicked: a?.clicked ?? 0 };
        }),
        sentMonth, sent30, opened30, unsub30,
        posts: ((pr?.data ?? []) as any[]).filter((p) => p.status !== "cancelled" && p.status !== "published").map((p) => ({ id: p.id, title: (p.title || p.body || "Untitled post").replace(/\s+/g, " ").slice(0, 140), networks: Array.isArray(p.networks) ? p.networks : [], status: p.status, at: p.scheduled_at })),
        lists: ((lr?.data ?? []) as any[]).map((l) => ({ id: l.id, name: l.name || "List", kind: l.kind, entity: l.entity, members: Number(l.member_count) || 0 })),
      });
    })();
    return () => { alive = false; };
  }, []);
  const go = () => nav("/marketing");
  const wait = d ? null : "…";
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const soon = Date.now() + 14 * 864e5;
  const campSoon = (d?.camps ?? []).filter((c) => c.status === "scheduled" && c.when && new Date(c.when).getTime() <= soon).length;
  const postSoon = (d?.posts ?? []).filter((p) => p.status === "scheduled" && p.at && new Date(p.at).getTime() <= soon).length;
  const people = (d?.lists ?? []).reduce((s, l) => s + l.members, 0);
  const openRate = d && d.sent30 ? (d.opened30 ?? 0) / d.sent30 * 100 : null;
  const cSent = useCount(d?.sentMonth ?? 0, 700);
  const cPeople = useCount(people, 700);
  const when = (iso: string | null) => {
    if (!iso) return "";
    const t = new Date(iso), n = new Date(); n.setHours(0, 0, 0, 0);
    const diff = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() - n.getTime()) / 864e5);
    const day = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : t.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return diff === 0 || diff === 1 ? `${day} · ${t.toTimeString().slice(0, 5)}` : day;
  };
  const empty = (text: string) => <p className="cz-empty">{d?.missing ? "Marketing isn't set up yet (run 20_marketing.sql in Supabase)." : text}</p>;
  const card = (key: string): ReactNode => {
    switch (key) {
      case "mk_sent": return (
        <Fig onClick={go} title="Open Marketing">
          <Txt label="E-mails sent this month" value={wait ?? (d!.sentMonth == null ? "—" : Math.round(cSent))} big sub={d ? `${d.camps.filter((c) => c.status === "sent" || c.status === "sending").length} campaigns lately` : ""} />
        </Fig>
      );
      case "mk_open": return (
        <Fig onClick={go} title="Open Marketing">
          <Ring pct={openRate ?? 0} size={58} stroke={6}><b>{openRate == null ? "—" : `${Math.round(openRate)}%`}</b></Ring>
          <Txt label="Open rate, 30 days" value={wait ?? (openRate == null ? "—" : `${Math.round(openRate)}%`)} sub={d?.sent30 ? `${(d.opened30 ?? 0).toLocaleString("en-US")} of ${d.sent30.toLocaleString("en-US")} e-mails opened` : "Nothing sent in 30 days"} />
        </Fig>
      );
      case "mk_planned": return (
        <Fig onClick={go} title="Open Marketing">
          <Txt label="Scheduled, next 14 days" value={wait ?? campSoon + postSoon} big>
            <span className="chx-chips">
              {campSoon > 0 && <span className="chx-chip is-today">{campSoon} {campSoon === 1 ? "e-mail" : "e-mails"}</span>}
              {postSoon > 0 && <span className="chx-chip is-ok">{postSoon} {postSoon === 1 ? "post" : "posts"}</span>}
              {d && campSoon + postSoon === 0 && <span className="chx-chip is-ok">Nothing planned</span>}
            </span>
          </Txt>
        </Fig>
      );
      case "mk_audience": return (
        <Fig onClick={go} title="Open Marketing">
          <Txt label="People in your lists" value={wait ?? Math.round(cPeople).toLocaleString("en-US")} sub={d ? `${d.lists.length} ${d.lists.length === 1 ? "list" : "lists"}` : ""} />
        </Fig>
      );
      case "mk_unsub": return (
        <Fig cls={d?.unsub30 ? "has-late" : ""} onClick={go} title="Open Marketing">
          <Txt label="Unsubscribes, 30 days" value={wait ?? (d!.unsub30 ?? "—")} big sub={d?.sent30 && d.unsub30 ? `${((d.unsub30 / d.sent30) * 100).toFixed(1)}% of the e-mails sent` : "Nobody left lately"} />
        </Fig>
      );
      case "mk.campaigns": return (
        <section className="cz-card hb-mk hb-mk-camps" aria-label="E-mail campaigns">
          <header className="cz-head">
            <div className="cz-titles">
              <span className="cz-eyebrow">E-mail campaigns</span>
              <h2 className="cz-title">{!d ? "…" : <>{openRate == null ? "—" : `${Math.round(openRate)}%`}<small>opened · 30 days</small></>}</h2>
            </div>
            <button type="button" className="cz-link" onClick={go}>Marketing<i aria-hidden="true">→</i></button>
          </header>
          {!d ? <div className="cz-skel" /> : d.camps.length === 0 ? empty("No campaigns yet.") : (
            <div className="hb-mk-list">
              {d.camps.map((c, i) => (
                <button type="button" key={c.id} className="hb-mk-row" style={{ ["--i" as string]: Math.min(i, 10) } as CSSProperties} onClick={go}>
                  <span className={`hb-mk-st is-${c.status}`}>{MK_STATUS[c.status] ?? c.status}</span>
                  <span className="hb-mk-main"><b>{c.name}</b><small>{when(c.when)}{c.total ? ` · ${c.sent.toLocaleString("en-US")} of ${c.total.toLocaleString("en-US")} sent` : ""}</small></span>
                  <span className="hb-mk-side">
                    <b>{c.sent ? `${pct(c.opened, c.sent)}%` : "—"}</b>
                    <small>{c.sent ? `${pct(c.clicked, c.sent)}% clicked` : "not sent"}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      );
      case "mk.posts": return (
        <section className="cz-card hb-mk hb-mk-posts" aria-label="Social posts">
          <header className="cz-head">
            <div className="cz-titles">
              <span className="cz-eyebrow">Social posts</span>
              <h2 className="cz-title">{!d ? "…" : <>{postSoon}<small>scheduled · next 14 days</small></>}</h2>
            </div>
            <button type="button" className="cz-link" onClick={go}>Calendar<i aria-hidden="true">→</i></button>
          </header>
          {!d ? <div className="cz-skel" /> : d.posts.length === 0 ? empty("Nothing scheduled.") : (
            <div className="hb-mk-list">
              {d.posts.map((p, i) => (
                <button type="button" key={p.id} className="hb-mk-row is-post" style={{ ["--i" as string]: Math.min(i, 10) } as CSSProperties} onClick={go}>
                  <span className="hb-mk-nets">{(p.networks.length ? p.networks : ["?"]).slice(0, 3).map((n) => (
                    <i key={n} style={{ background: MK_NETS[n]?.color ?? "#9aaaa2" }} title={MK_NETS[n]?.label ?? n}>{MK_NETS[n]?.short ?? "·"}</i>
                  ))}</span>
                  <span className="hb-mk-main"><b>{p.title}</b><small>{p.networks.map((n) => MK_NETS[n]?.label ?? n).join(", ") || "No network yet"}</small></span>
                  <span className="hb-mk-side"><b className="is-when">{when(p.at)}</b><small>{MK_STATUS[p.status] ?? p.status}</small></span>
                </button>
              ))}
            </div>
          )}
        </section>
      );
      case "mk.lists": {
        const top = Math.max(1, ...(d?.lists ?? []).map((l) => l.members));
        return (
          <section className="cz-card hb-mk hb-mk-lists" aria-label="Audiences">
            <header className="cz-head">
              <div className="cz-titles">
                <span className="cz-eyebrow">Audiences</span>
                <h2 className="cz-title">{!d ? "…" : <>{people.toLocaleString("en-US")}<small>people · {d.lists.length} {d.lists.length === 1 ? "list" : "lists"}</small></>}</h2>
              </div>
              <button type="button" className="cz-link" onClick={go}>Lists<i aria-hidden="true">→</i></button>
            </header>
            {!d ? <div className="cz-skel" /> : d.lists.length === 0 ? empty("No lists yet.") : (
              <div className="hb-mk-list">
                {d.lists.map((l, i) => (
                  <button type="button" key={l.id} className="hb-mk-row is-list" style={{ ["--i" as string]: Math.min(i, 10) } as CSSProperties} onClick={go}>
                    <span className="hb-mk-main">
                      <b>{l.name}</b>
                      <span className="hb-mk-bar"><i style={{ width: `${(l.members / top) * 100}%` }} /></span>
                    </span>
                    <span className="hb-mk-side"><b>{l.members.toLocaleString("en-US")}</b><small>{l.kind === "dynamic" ? "Updates itself" : "Fixed list"}</small></span>
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      }
      default: return null;
    }
  };
  return renderSlots(slots, card);
}

function ManagementCards({ slots }: { slots: HomeSlot[] }) {
  const card = (key: string): ReactNode => {
    switch (key) {
      case "mgmt.summary": return <ManagementSummary />;
      case "mgmt.pipeline": return <SalesPipelineWidget />;
      case "mgmt.quiet": return <NeglectedClientsWidget />;
      case "mgmt.bonus": return <TeamBonusWidget />;
      default: return null;
    }
  };
  return renderSlots(slots, card);
}

/* ---------------------------------------------------------------------
   The library: every card your access lets you add, by department.
   --------------------------------------------------------------------- */
function CardLibrary({ access, live, focus, onAddCard, onAddFig, onRemoveKey, onRemoveFig, onClose }: {
  access: Access; live: BoardState; focus: "cards" | "figs";
  onAddCard: (key: string) => void; onAddFig: (key: string) => void; onRemoveKey: (key: string) => void; onRemoveFig: (key: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [dept, setDept] = useState<Dept | "all">("all");
  const [kind, setKind] = useState<"all" | "cards" | "figs">(focus === "figs" ? "figs" : "all");
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const allowed = CARD_DEFS.filter((d) => d.allow(access));
  const f = fold(q.trim());
  const list = allowed.filter((d) => (dept === "all" || d.dept === dept) && (kind === "all" || (kind === "figs" ? d.fig : !d.fig))
    && (!f || fold(`${d.title} ${d.hint} ${DEPTS.find((x) => x.key === d.dept)?.label}`).includes(f)));
  const onBoard = new Set(live.items.map((i) => i.key));
  const inHero = new Set(live.figs);
  const heroFull = live.figs.length >= MAX_FIGS;
  const count = (k: Dept) => allowed.filter((d) => d.dept === k).length;
  return createPortal(
    <aside className="hb-lib" role="dialog" aria-label="Add to your home">
      <header className="hb-lib-h">
        <div>
          <b>Add to your home</b>
          <span>Cards go on the board; figures fit the header too.</span>
        </div>
        <button type="button" className="hb-lib-x" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <label className="hb-lib-q">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input ref={inp} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cards and figures" />
      </label>
      <div className="hb-lib-kind" role="tablist">
        {(["all", "cards", "figs"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "is-on" : ""} onClick={() => setKind(k)}>{k === "all" ? "Everything" : k === "cards" ? "Cards" : "Figures"}</button>
        ))}
      </div>
      <nav className="hb-lib-depts">
        <button type="button" className={dept === "all" ? "is-on" : ""} onClick={() => setDept("all")}>All <i>{allowed.length}</i></button>
        {DEPTS.filter((x) => count(x.key) > 0).map((x) => (
          <button key={x.key} type="button" className={dept === x.key ? "is-on" : ""} onClick={() => setDept(x.key)} style={{ ["--c" as string]: x.color } as CSSProperties}>
            <em />{x.label} <i>{count(x.key)}</i>
          </button>
        ))}
      </nav>
      <div className="hb-lib-list">
        {list.length === 0 && <p className="hb-lib-none">Nothing matches “{q}”.</p>}
        {DEPTS.map((x) => {
          const mine = list.filter((d) => d.dept === x.key);
          if (!mine.length) return null;
          return (
            <section key={x.key} className="hb-lib-sec" style={{ ["--c" as string]: x.color } as CSSProperties}>
              <h3><em />{x.label}</h3>
              {mine.map((d) => {
                const on = onBoard.has(d.key), top = inHero.has(d.key);
                return (
                  <div key={d.key} className={`hb-lib-it ${on || top ? "is-in" : ""}`}>
                    <span className={`hb-lib-pic ${d.fig ? "is-fig" : ""}`}><Glyph g={d.glyph} /></span>
                    <span className="hb-lib-txt">
                      <b>{d.title}</b>
                      <small>{d.hint}</small>
                      {(on || top) && <span className="hb-lib-where">{[on && "On the board", top && "In the header"].filter(Boolean).join(" · ")}</span>}
                    </span>
                    <span className="hb-lib-acts">
                      {on
                        ? <button type="button" className="is-rm" onClick={() => onRemoveKey(d.key)} title="Take it off the board">Remove</button>
                        : <button type="button" className="is-add" onClick={() => onAddCard(d.key)} title="Add it to the board">{d.fig ? "+ Card" : "+ Add"}</button>}
                      {d.fig && (top
                        ? <button type="button" className="is-rm" onClick={() => onRemoveFig(d.key)} title="Take it out of the header">Header ✓</button>
                        : <button type="button" className="is-add is-alt" disabled={heroFull} onClick={() => onAddFig(d.key)} title={heroFull ? `The header holds ${MAX_FIGS} figures` : "Put it in the header"}>+ Header</button>)}
                    </span>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      <footer className="hb-lib-f">You see what your access lets you open. Ask an admin for more.</footer>
    </aside>,
    document.body,
  );
}

export default function HomePage() {
  const { role } = useAuth();
  const nav = useNavigate();
  const pa = usePageAccess();
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

  /* ---- the board: saved with your profile; while adjusting, a draft ---- */
  const [board, setBoard] = useState<BoardState | null>(null);
  const [draft, setDraft] = useState<BoardState | null>(null);
  const [lib, setLib] = useState<"cards" | "figs" | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState(false);
  const prefsRef = useRef<Record<string, any>>({});
  useEffect(() => {
    if (!me) return;
    let alive = true;
    loadPrefs().catch(() => ({} as Record<string, any>)).then((p) => {
      if (!alive) return;
      prefsRef.current = p ?? {};
      setBoard(readBoard(p?.[BOARD_PREF]) ?? defaultBoard(area, p ?? {}));
    });
    return () => { alive = false; };
  }, [me?.id, area]); // eslint-disable-line react-hooks/exhaustive-deps
  const editing = draft !== null;
  const live = draft ?? board;
  const access: Access = useMemo(() => ({
    canSee: pa.canSee, canPanel: pa.canPanel, dept: me?.department ?? pa.department ?? null,
    full: !!me?.isSuper || r === "boss" || levelBase(pa.level) === "boss",
  }), [pa.canSee, pa.canPanel, pa.department, pa.level, me?.department, me?.isSuper, r]);
  const okKey = (k: string) => !!DEF[k] && pa.ready && DEF[k].allow(access);
  const items = useMemo(() => (live ? compactAll(live.items.filter((i) => okKey(i.key))) : []), [live, access, pa.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const figs = useMemo(() => (live ? live.figs.filter(okKey) : []), [live, access, pa.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const heroMode = live?.hero ?? "full";

  const change = (f: (b: BoardState) => BoardState) => setDraft((d) => (d ? f(d) : d));
  const startAdjust = () => { if (board) { setDraft({ ...board, items: compactAll(board.items.filter((i) => okKey(i.key))) }); } };
  const finish = (save: boolean) => {
    if (save && draft) {
      setBoard(draft);
      setSaveErr(false);
      savePref(BOARD_PREF, draft).catch(() => setSaveErr(true));
    }
    setDraft(null); setLib(null);
  };
  const reset = () => setDraft(defaultBoard(area, prefsRef.current));
  const addCard = (key: string) => {
    const d = DEF[key];
    if (!d || !draft) return;
    const [w, h] = d.def;
    const at = firstFit(items, w, h);
    const it = { id: newId(), key, x: at.x, y: at.y, w, h };
    change((b) => ({ ...b, items: compactAll([...items, it]) }));
    setFlash(it.id);
    window.setTimeout(() => setFlash((f) => (f === it.id ? null : f)), 1600);
    window.setTimeout(() => document.querySelector(`.hb-card[data-id="${it.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
  };
  const removeCard = (id: string) => change((b) => ({ ...b, items: compactAll(items.filter((i) => i.id !== id)) }));
  const removeKey = (key: string) => change((b) => ({ ...b, items: compactAll(items.filter((i) => i.key !== key)) }));
  const addFig = (key: string) => change((b) => ({ ...b, hero: "full", figs: [...figs.filter((k) => k !== key), key].slice(0, MAX_FIGS) }));
  const removeFig = (key: string) => change((b) => ({ ...b, figs: figs.filter((k) => k !== key) }));
  const openCard = (it: BoardItem) => {
    const go = DEF[it.key]?.go;
    if (!go) return;
    if (go[1]) goToSection(nav, go[0], go[1]); else nav(go[0]);
  };
  // leaving the page half-way through: nothing is saved
  useEffect(() => {
    if (!editing) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !lib && !document.querySelector(".hb-sizes")) finish(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [editing, lib]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- the slots each source draws into ---- */
  const [els, setEls] = useState<Record<string, HTMLElement>>({});
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const slotRef = useCallback((id: string) => {
    let f = refs.current.get(id);
    if (!f) {
      f = (el: HTMLElement | null) => setEls((m) => {
        if (el) return m[id] === el ? m : { ...m, [id]: el };
        if (!(id in m)) return m;
        const next = { ...m }; delete next[id]; return next;
      });
      refs.current.set(id, f);
    }
    return f;
  }, []);
  const [livePreview, setLivePreview] = useState<BoardItem[] | null>(null);
  useEffect(() => { if (!editing) setLivePreview(null); }, [editing]);
  const slots = useMemo(() => {
    const out: Record<Dept, HomeSlot[]> = { general: [], sales: [], consultancy: [], marketing: [], management: [] };
    (livePreview ?? items).forEach((it) => {
      const el = els[it.id];
      const key = shownKey(it);
      if (el && DEF[key]) out[DEF[key].src].push({ id: it.id, key, el });
    });
    if (heroMode === "full") figs.forEach((k) => { const el = els[`fig:${k}`]; if (el) out[DEF[k].src].push({ id: `fig:${k}`, key: k, el }); });
    return out;
  }, [items, livePreview, figs, heroMode, els]);
  const needCal = slots.general.some((s) => s.key === "booked") && !items.some((i) => shownKey(i) === "calendar");

  /* ---- row height: 22 rows fill the screen under the header ---- */
  const boardWrap = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(34);
  useLayoutEffect(() => {
    const m = () => {
      const el = boardWrap.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + scrollerOf(el).scrollTop;
      const avail = window.innerHeight - top - 22;
      setStep(Math.max(26, Math.min(56, (avail + GAP) / SCREEN_ROWS)));
    };
    m();
    const ro = typeof ResizeObserver !== "undefined" && barRef.current ? new ResizeObserver(m) : null;
    if (barRef.current) ro?.observe(barRef.current);
    window.addEventListener("resize", m);
    return () => { ro?.disconnect(); window.removeEventListener("resize", m); };
  }, [!!live, heroMode, figs.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- the header's figures: drag to reorder while adjusting ---- */
  const figsRef = useRef<HTMLDivElement>(null);
  const [figDrag, setFigDrag] = useState<string | null>(null);
  const grabFig = (k: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setFigDrag(k);
    const move = (ev: PointerEvent) => {
      const boxes = [...(figsRef.current?.querySelectorAll<HTMLElement>(".hb-fig[data-k]") ?? [])];
      const to = boxes.findIndex((b) => { const r = b.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX <= r.right; });
      if (to < 0) return;
      setDraft((d) => {
        if (!d) return d;
        const cur = d.figs.filter((x) => DEF[x] && pa.ready && DEF[x].allow(access));
        const from = cur.indexOf(k);
        if (from < 0 || from === to) return d;
        const next = [...cur]; next.splice(from, 1); next.splice(to, 0, k);
        return { ...d, figs: next };
      });
    };
    const up = () => { setFigDrag(null); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const glow = (e: React.PointerEvent<HTMLElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - b.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - b.top}px`);
  };
  const dateLabel = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const showFigs = heroMode === "full" && (figs.length > 0 || editing);

  return (
    <div ref={rootRef} className={`home is-cons is-board ${area === "sales" ? "is-sales" : ""} ${editing ? "is-adjusting" : ""} ${booting ? (boot.mode === "arrive" ? "is-held" : "is-held-grid") : ""} ${boot.phase === "out" ? `is-revealing is-revealing-${boot.mode}` : ""}`}>
      {boot.phase !== "none" && <HomeBoot boot={boot} details={details} hello={hello} top={bootTop} />}

      <section className={`chx-hero hb-hero is-${heroMode} ${editing ? "is-editing" : ""}`} ref={barRef} onPointerMove={glow} aria-label="Your day">
        <i className="chx-hero-grid" aria-hidden="true" />
        <i className="chx-hero-glow" aria-hidden="true" />
        <div className="chx-hero-top">
          <div className="chx-hello">
            <h1 className="chx-greet">{hello}</h1>
            <span className="chx-date">{dateLabel}</span>
          </div>
          <span className="chx-grow" />
          {uid && me && <HomeAlertsBell h={alerts} tone="dark" />}
          {editing && (
            <button type="button" className="chx-edit is-on" onClick={() => finish(true)} title="Save your home as it is">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              Done
            </button>
          )}
          <ActionsMenu items={board ? [{
            key: "adjust-home", group: "Home", label: "Adjust home", hint: "Move, resize, add or take away cards", tone: "green", shortcut: "A",
            icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="9" rx="2" /><rect x="13.5" y="3.5" width="7" height="5" rx="2" /><rect x="13.5" y="11.5" width="7" height="9" rx="2" /><rect x="3.5" y="15.5" width="7" height="5" rx="2" /></svg>,
            onSelect: () => { if (!editing) startAdjust(); },
          }] : []} />
        </div>
        {showFigs && (
          <div className="chx-figs hb-figs" ref={figsRef} style={{ ["--n" as string]: Math.max(1, figs.length + (editing && figs.length < MAX_FIGS ? 1 : 0)) } as CSSProperties}>
            {figs.map((k) => (
              <div key={k} className={`hb-fig ${figDrag === k ? "is-held" : ""}`} data-k={k}>
                <div className="hb-slot" ref={slotRef(`fig:${k}`)} />
                {editing && (
                  <>
                    <div className="hb-fig-veil" onPointerDown={grabFig(k)} title="Drag to reorder" />
                    <button type="button" className="hb-fig-x" onClick={() => removeFig(k)} aria-label={`Take ${DEF[k]?.title} out of the header`} title="Take it out of the header">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>
                    </button>
                  </>
                )}
              </div>
            ))}
            {editing && figs.length < MAX_FIGS && (
              <button type="button" className="hb-fig-add" onClick={() => setLib("figs")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                <span><b>Add a figure</b><small>{figs.length ? `${MAX_FIGS - figs.length} more fit here` : "Any figure you can see"}</small></span>
              </button>
            )}
          </div>
        )}
      </section>

      <div ref={boardWrap} className="hb-wrap">
        {!uid || !me || !live || !pa.ready ? (
          <div className="home-wait" aria-hidden="true" />
        ) : items.length === 0 && !editing ? (
          <div className="hb-empty">
            <b>Your home is empty</b>
            <span>Add the cards you want to see first thing.</span>
            <button type="button" onClick={() => { startAdjust(); setLib("cards"); }}>Add cards</button>
          </div>
        ) : (
          <HomeBoard items={items} editing={editing} step={step} slotRef={slotRef} flash={flash} onOpen={openCard} onPreview={setLivePreview}
            onChange={(next) => change((b) => ({ ...b, items: next }))} onRemove={removeCard} />
        )}
      </div>

      {/* the sources: each only while one of its cards is on show */}
      {uid && me && (
        <>
          <GeneralCards slots={slots.general} userId={uid} hoursPerDay={hoursPerDay} needCal={needCal} />
          {slots.consultancy.length > 0 && <ConsultancyHome userId={me.id} isLead={isLead} hoursPerDay={hoursPerDay} slots={slots.consultancy} />}
          {slots.sales.length > 0 && <SalesHome userId={me.id} seesTeam={seesSalesTeam} slots={slots.sales} />}
          {slots.marketing.length > 0 && <MarketingCards slots={slots.marketing} />}
          {slots.management.length > 0 && <ManagementCards slots={slots.management} />}
        </>
      )}

      {editing && createPortal(
        <div className="hb-dock" role="toolbar" aria-label="Adjust your home">
          <span className="hb-dock-t">
            <b>Adjusting your home</b>
            <small>Drag a card to move it · pull its edge to resize</small>
          </span>
          <button type="button" className="hb-dock-add" onClick={() => setLib(lib ? null : "cards")} aria-expanded={!!lib}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            Add cards
          </button>
          <span className="hb-dock-seg" role="radiogroup" aria-label="Header">
            <span className="hb-dock-k">Header</span>
            <button type="button" role="radio" aria-checked={heroMode === "full"} className={heroMode === "full" ? "is-on" : ""} onClick={() => change((b) => ({ ...b, hero: "full" }))}>With figures</button>
            <button type="button" role="radio" aria-checked={heroMode === "compact"} className={heroMode === "compact" ? "is-on" : ""} onClick={() => change((b) => ({ ...b, hero: "compact" }))}>One line</button>
          </span>
          <span className="hb-dock-sep" />
          <button type="button" className="hb-dock-btn" onClick={reset} title={`Back to the ${areaTitle(area).toLowerCase()} home everyone starts with`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" /></svg>
            Reset
          </button>
          <button type="button" className="hb-dock-btn" onClick={() => finish(false)}>Cancel</button>
          <button type="button" className="hb-dock-done" onClick={() => finish(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            Done
          </button>
        </div>,
        document.body,
      )}
      {editing && lib && live && (
        <CardLibrary access={access} live={{ ...live, items, figs }} focus={lib}
          onAddCard={addCard} onAddFig={addFig} onRemoveKey={removeKey} onRemoveFig={removeFig} onClose={() => setLib(null)} />
      )}
      {saveErr && <p className="hb-err" role="alert">Your layout couldn't be saved. It stays for now; try Adjust → Done again.</p>}
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
      const { data: ev } = await supabase.from("calendar_entries").select("*").eq("user_id", me).eq("kind", "meeting").gte("entry_date", iso(today)).lte("entry_date", iso(to)).order("entry_date").limit(30);
      const nowMin = today.getHours() * 60 + today.getMinutes();
      setMeetings(((ev ?? []) as any[]).filter((e) => e.kind === "meeting" && (e.entry_date > iso(today) || (e.start_min ?? 0) >= nowMin))
        .sort((a, b) => a.entry_date.localeCompare(b.entry_date) || (a.start_min ?? 0) - (b.start_min ?? 0)).slice(0, 3)
        .map((e) => ({ kind: "meeting" as const, id: e.id, label: e.name || e.title || e.notes || "Meeting",
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
