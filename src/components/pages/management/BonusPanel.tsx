/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState, useEffect, useRef } from "react";
import { PageLoader } from "../../framework/AppLayout";
import { createPortal } from "react-dom";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { supabase } from "../../api/supabase";
import { periodForDate, type Cutoffs } from "../calendar/billingPeriods";
import { useInactiveIds } from "../../framework/peopleStatus";
import BonusPlanModal, { blankPlan } from "./BonusPlanModal";
import {
  MONTH_SHORT, everyLabel, periodStart, periodLabel, prevPeriod, payMonth, shiftMonth, monthLabel, periodLast,
  planFor, matchStrength, evaluate, periodActivity, tiersFromLegacy, activeConditions, legacyKey, planFromRow, planToRow, yearSlots,
  type Plan, type Person, type ActivityIndex, type Metric, type Tier,
} from "./bonusEngine";
import { roleCounts, rateOn, type ClientRole, type RoleLine } from "../clients/clientsTypes";
import "./BonusPanel.css";

export interface BonusEntry {
  id: string;
  userId: string;
  projectId: string;
  date: string;
  billable: number;
  status: string;
  line: string;
  typeId: string;
  billingPeriod: string | null;
  /** Minutes logged (any kind of work) — feeds the "hours worked" condition. */
  durationMin?: number;
}
interface Proj { clientId: string; typeId: string; lines: RoleLine[]; team: { userId?: string; role?: string }[]; }

interface Props {
  entries: BonusEntry[];
  projects: Record<string, Proj>;
  people: Record<string, string>;
  clientNames: Record<string, string>;
  clientTypeIds: Set<string>;
  /** Catalogue roles: only time on roles that count for the target feeds the bonus. */
  clientRoles: ClientRole[];
  cutoffs: Cutoffs;
  defaultCutoffDay: number;
  /** Everything is measured as of this date (like Backlog). */
  asOf: string;
  hourProjects?: Set<string>;
  hoursPerDay?: number;
  /** Access "only own": show just this user's bonus. */
  onlyUser?: string;
  /** May create and edit plans. */
  canEdit?: boolean;
  /** May mark bonuses as paid. */
  canPay?: boolean;
  /** The previous settings (Targets & bonus), to start the first plans from. */
  legacy?: { general: any; perPerson: Record<string, any>; lag: number };
}

/** Thousands always dotted (es-ES leaves 4-digit numbers bare: "7740" next to "17.028"). */
const group3 = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const eur = (n: number) => { const r = Math.round(n); return (r < 0 ? "-" : "") + group3(String(Math.abs(r))); };
const d1 = (n: number) => { const r = Math.round(n * 10) / 10; const [i, d] = String(Math.abs(r)).split("."); return (r < 0 ? "-" : "") + group3(i) + (d ? `,${d}` : ""); };
const bpVars = (o: Record<string, string | number>) => o as CSSProperties;
const bpReduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const prettyDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
function useBpCount(target: number, ms = 1100) {
  const [value, setValue] = useState(() => (bpReduced() ? target : 0));
  const from = useRef(value);
  useEffect(() => {
    if (bpReduced()) { from.current = target; setValue(target); return; }
    let raf = 0;
    const start = from.current, t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const cur = start + (target - start) * (p === 1 ? 1 : 1 - Math.pow(2, -10 * p));
      from.current = cur; setValue(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}
function BpCount({ value, fmt = eur }: { value: number; fmt?: (n: number) => string }) { return <>{fmt(useBpCount(value))}</>; }
function useBpArmed(ms: number) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setArmed(true), bpReduced() ? 0 : ms); return () => window.clearTimeout(t); }, [ms]);
  return armed;
}
function bpSpot(e: ReactPointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse") return;
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-spot]");
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  el.style.setProperty("--mx", `${x}px`); el.style.setProperty("--my", `${y}px`);
  if (el.dataset.spot === "tilt") { el.style.setProperty("--ry", `${(x / r.width - 0.5) * 6}deg`); el.style.setProperty("--rx", `${(0.5 - y / r.height) * 6}deg`); }
}
const BP_ICON = {
  gift: "M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 2",
  spark: "M13 2L3 14h7l-1 8 10-12h-7z",
  check: "M20 6L9 17l-5-5",
  chev: "M9 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
};
function BpIcon({ d, w = 2 }: { d: string; w?: number }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

/* rows from/to the database */
const fromRow = planFromRow;
const toRow = planToRow;
/** Which periods of the year a tier counts in, in words. */
const tierWhen = (pl: Plan, t: Tier) => {
  if (!t.months || !t.months.length) return "";
  const slots = yearSlots(pl);
  if (slots) return slots.filter((s) => s.months.every((m) => t.months!.includes(m))).map((s) => s.label).join(", ");
  return t.months.map((m) => MONTH_SHORT[m - 1]).join(", ");
};
/** A paid row's period name (also understands keys written by the first version: "2026-Q3"…). */
const paidLabel = (pl: Plan | undefined, key: string) => {
  if (/^\d{4}-\d{2}$/.test(key)) return pl ? periodLabel(pl, key) : monthLabel(key, true);
  const m = key.match(/^(\d{4})-(Q|H)(\d)$/);
  if (m) return m[2] === "Q" ? `Q${m[3]} ${m[1]}` : `${m[3] === "1" ? "1st" : "2nd"} half ${m[1]}`;
  return key;
};

interface PayItem { key: string; userId: string; name: string; plan: Plan; periodKey: string; payMonth: string; amount: number; tier: Tier | null; act: ReturnType<typeof periodActivity> }

export default function BonusPanel({
  entries, projects, people, clientNames, clientTypeIds, clientRoles, cutoffs, defaultCutoffDay, asOf,
  hourProjects = new Set(), hoursPerDay = 8, onlyUser, canEdit = false, canPay = false, legacy,
}: Props) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<{ id: string; role: string | null; department: string | null; name: string }[]>([]);
  const [missing, setMissing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const inactive = useInactiveIds();

  const load = async () => {
    const [pl, po, pr] = await Promise.all([
      supabase.from("bonus_plans").select("*").order("sort").order("created_at"),
      supabase.from("bonus_payouts").select("*").order("paid_date", { ascending: false }).range(0, 9999),
      supabase.from("profiles").select("id, role, department, first_name, last_name, email"),
    ]);
    if (pl.error) { setMissing(true); setLoaded(true); return; }
    setMissing(false);
    setPlans(((pl.data ?? []) as any[]).map(fromRow));
    setPayouts((po.data ?? []) as any[]);
    setProfiles(((pr.data ?? []) as any[]).map((r) => ({
      id: r.id, role: r.role ?? null, department: r.department ?? null,
      name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || "—",
    })));
    setLoaded(true);
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- activity per person per billing month ---- */
  const idx = useMemo<ActivityIndex>(() => {
    const out: ActivityIndex = {};
    const hpd = hoursPerDay > 0 ? hoursPerDay : 8;
    entries.forEach((e) => {
      if (e.status === "cancelled" || !e.userId) return;
      const ym = e.billingPeriod || periodForDate(e.date, cutoffs, defaultCutoffDay);
      const a = ((out[e.userId] ??= {})[ym] ??= { billing: 0, days: 0, hours: 0, byClient: {} });
      if (e.line !== "closure") a.hours += (e.durationMin ?? 0) / 60;
      if (e.line === "closure" || !e.projectId) return;
      if (e.line !== "sales" && !roleCounts(e.line, clientRoles)) return;   // e.g. connector time
      const p = projects[e.projectId];
      if (!p) return;
      const isClient = clientTypeIds.size === 0 ? true : clientTypeIds.has(e.typeId);
      const rate = rateOn(p.lines, e.line);
      if (!(isClient && rate > 0 && e.billable > 0)) return;
      const amt = e.billable * rate;
      const dayEq = hourProjects.has(e.projectId) ? e.billable / hpd : e.billable;
      a.billing += amt; a.days += dayEq;
      const c = (a.byClient[p.clientId] ??= { name: clientNames[p.clientId] ?? "—", billing: 0, days: 0 });
      c.billing += amt; c.days += dayEq;
    });
    return out;
  }, [entries, projects, clientNames, clientTypeIds, clientRoles, cutoffs, defaultCutoffDay, hourProjects, hoursPerDay]);

  /* ---- who, which plan, what's due ---- */
  const asOfYm = asOf.slice(0, 7);
  const asOfBp = periodForDate(asOf, cutoffs, defaultCutoffDay);
  const view = useMemo(() => {
    const ids = new Set<string>([...profiles.map((p) => p.id), ...Object.keys(idx)]);
    const persons: Person[] = [...ids]
      .filter((id) => !onlyUser || id === onlyUser)
      .map((id) => { const pr = profiles.find((p) => p.id === id); return { id, name: people[id] ?? pr?.name ?? "Unknown", role: pr?.role ?? null, department: pr?.department ?? null }; });
    const paidKey = new Set(payouts.map((p) => `${p.plan_id}|${p.user_id}|${p.period_key}`));
    const isPaid = (pl: Plan, uid: string, first: string) => {
      const lk = legacyKey(pl, first);
      return paidKey.has(`${pl.id}|${uid}|${first}`) || (!!lk && paidKey.has(`${pl.id}|${uid}|${lk}`));
    };
    const due: PayItem[] = [], upcoming: PayItem[] = [], running: (PayItem & { ev: ReturnType<typeof evaluate>; ends: string })[] = [];
    const uncovered: Person[] = [];
    const oldest = shiftMonth(asOfYm, -12);
    for (const person of persons) {
      const governing = planFor(plans, person, asOfBp);
      const hasRecent = Object.keys(idx[person.id] ?? {}).some((ym) => ym >= oldest);
      if (!governing && !inactive.has(person.id) && hasRecent) uncovered.push(person);
      // the open period, under the plan that applies today
      if (governing && !inactive.has(person.id)) {
        const cur = periodStart(governing, asOfBp)!;
        const act = periodActivity(idx, person.id, governing, cur);
        const ev = evaluate(governing, act, cur);
        running.push({ key: `${governing.id}|${person.id}|${cur}`, userId: person.id, name: person.name, plan: governing, periodKey: cur, payMonth: payMonth(governing, cur), amount: ev.amount, tier: ev.tier, act, ev, ends: periodLast(governing, cur) });
      }
      // closed periods, each under the plan that governed it (plans can change over time)
      for (const pl of plans) {
        if (matchStrength({ ...pl, active: true }, person) === 0 || !pl.active) continue;
        const lastMonth = pl.end && pl.end < asOfBp ? pl.end : asOfBp;
        let k: string | null = periodStart(pl, lastMonth);
        for (let guard = 0; k && guard < 60 && payMonth(pl, k) >= oldest; guard++, k = prevPeriod(pl, k)) {
          if (periodLast(pl, k) >= asOfBp) continue;                 // still open
          if (planFor(plans, person, k)?.id !== pl.id) continue;      // another plan governed this period
          if (isPaid(pl, person.id, k)) continue;
          const act = periodActivity(idx, person.id, pl, k);
          if (!act.billing && !act.days && !act.hours) continue;
          const ev = evaluate(pl, act, k);
          if (ev.amount <= 0) continue;
          const pm = payMonth(pl, k);
          const item: PayItem = { key: `${pl.id}|${person.id}|${k}`, userId: person.id, name: person.name, plan: pl, periodKey: k, payMonth: pm, amount: ev.amount, tier: ev.tier, act };
          (pm <= asOfYm ? due : upcoming).push(item);
        }
      }
    }
    due.sort((a, b) => a.payMonth.localeCompare(b.payMonth) || b.amount - a.amount);
    upcoming.sort((a, b) => a.payMonth.localeCompare(b.payMonth) || b.amount - a.amount);
    running.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
    const paid = payouts
      .filter((p) => !onlyUser || p.user_id === onlyUser)
      .map((p) => ({ ...p, plan: plans.find((x) => x.id === p.plan_id), name: people[p.user_id] ?? profiles.find((x) => x.id === p.user_id)?.name ?? "Unknown" }));
    return { due, upcoming, running, uncovered, paid };
  }, [profiles, idx, plans, payouts, people, onlyUser, asOfYm, asOfBp, inactive]);

  const totals = {
    due: view.due.reduce((s, r) => s + r.amount, 0),
    upcoming: view.upcoming.reduce((s, r) => s + r.amount, 0),
    running: view.running.reduce((s, r) => s + r.amount, 0),
    paidYear: view.paid.filter((p) => String(p.paid_date).slice(0, 4) === asOf.slice(0, 4)).reduce((s, p) => s + Number(p.amount || 0), 0),
  };
  const armed = useBpArmed(320);

  /* ---- actions ---- */
  const payoutRow = (it: PayItem, today: string) => ({
    plan_id: it.plan.id, user_id: it.userId, period_key: it.periodKey, amount: Math.round(it.amount * 100) / 100, paid_date: today,
    figures: { billing: it.act.billing, days: it.act.days, hours: it.act.hours, tier: it.tier?.name ?? null, plan: it.plan.name },
  });
  const [vanishing, setVanishing] = useState<Set<string>>(new Set());
  const markPaid = async (items: PayItem[], busyKey: string) => {
    if (!items.length) return;
    if (items.length > 1 && !window.confirm(`Mark ${items.length} bonuses (${eur(items.reduce((s, i) => s + i.amount, 0))} €) as paid today?`)) return;
    setBusy(busyKey);
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase.from("bonus_payouts").insert(items.map((it) => payoutRow(it, today)));
    setBusy(null);
    if (error) { alert(`Couldn't mark it paid: ${error.message}`); return; }
    // let the paid period(s) fold away, then refresh
    setVanishing(new Set(items.map((i) => i.key)));
    window.setTimeout(() => { load(); setVanishing(new Set()); }, 520);
  };
  const undoPaid = async (id: string) => {
    if (!window.confirm("Mark this bonus as not paid again?")) return;
    setBusy(id);
    const { error } = await supabase.from("bonus_payouts").delete().eq("id", id);
    setBusy(null);
    if (error) { alert(error.message); return; }
    load();
  };
  const savePlan = async (p: Plan): Promise<string | null> => {
    const res = p.id
      ? await supabase.from("bonus_plans").update(toRow(p)).eq("id", p.id)
      : await supabase.from("bonus_plans").insert({ ...toRow(p), sort: plans.length });
    if (res.error) return res.error.message;
    setEditing(null); load(); return null;
  };
  const deletePlan = async (p: Plan): Promise<string | null> => {
    const { error } = await supabase.from("bonus_plans").delete().eq("id", p.id);
    if (error) return error.message;
    setEditing(null); load(); return null;
  };
  const startFromLegacy = async () => {
    if (!legacy) return;
    setBusy("legacy");
    const id = () => Math.random().toString(36).slice(2, 9);
    const rows: any[] = [];
    const general = legacy.general ?? {};
    const genTiers = tiersFromLegacy(general, id);
    const since = `${Number(asOf.slice(0, 4)) - 1}-01`;
    rows.push({ ...toRow({ ...blankPlan(), name: "Company bonus", every: 1, start: since, delay: Math.max(0, legacy.lag ?? 1), tiers: genTiers.length ? genTiers : blankPlan().tiers }), sort: 0 });
    Object.entries(legacy.perPerson ?? {}).forEach(([uid, cap], i) => {
      const own = Object.fromEntries(Object.entries(cap ?? {}).filter(([k, v]) => v != null && ["minDays", "minBilling", "bonusPct1", "highDays", "highBilling", "bonusPct2"].includes(k)));
      if (!Object.keys(own).length) return;
      const tiers = tiersFromLegacy({ ...general, ...own }, id);
      if (!tiers.length) return;
      rows.push({ ...toRow({ ...blankPlan(), name: `${people[uid] ?? "Personal"} — personal`, every: 1, start: since, delay: Math.max(0, legacy.lag ?? 1), who: { everyone: false, roles: [], departments: [], people: [uid] }, tiers }), sort: i + 1 });
    });
    const { error } = await supabase.from("bonus_plans").insert(rows);
    setBusy(null);
    if (error) { alert(error.message); return; }
    load();
  };

  const roles = useMemo(() => [...new Set(profiles.map((p) => p.role).filter(Boolean) as string[])].sort(), [profiles]);
  const departments = useMemo(() => [...new Set(profiles.map((p) => p.department).filter(Boolean) as string[])].sort(), [profiles]);
  const pickPeople = useMemo(() => profiles.filter((p) => !inactive.has(p.id)).map((p) => ({ id: p.id, name: people[p.id] ?? p.name, role: p.role, department: p.department })).sort((a, b) => a.name.localeCompare(b.name)), [profiles, people, inactive]);

  /* ---- tier colours: rank by requirement, easiest first ---- */
  const tierRank = (pl: Plan, t: Tier | null) => {
    if (!t) return -1;
    const sorted = [...pl.tiers].sort((x, y) => (Number(x.conditions.billing ?? 0) - Number(y.conditions.billing ?? 0)) || (Number(x.conditions.days ?? 0) - Number(y.conditions.days ?? 0)));
    return sorted.findIndex((x) => x.id === t.id);
  };

  /* ---- one card per consultant: this period's progress + what's still owed ---- */
  const cards = useMemo(() => {
    type Card = { userId: string; name: string; plan: Plan | null; run: (typeof view.running)[number] | null; due: PayItem[]; upcoming: PayItem[] };
    const by = new Map<string, Card>();
    const get = (uid: string, name: string) => { let c = by.get(uid); if (!c) { c = { userId: uid, name, plan: null, run: null, due: [], upcoming: [] }; by.set(uid, c); } return c; };
    view.running.forEach((r) => { const c = get(r.userId, r.name); c.run = r; c.plan = r.plan; });
    view.due.forEach((it) => { const c = get(it.userId, it.name); c.due.push(it); c.plan ??= it.plan; });
    view.upcoming.forEach((it) => { const c = get(it.userId, it.name); c.upcoming.push(it); c.plan ??= it.plan; });
    const sum = (xs: PayItem[]) => xs.reduce((s, i) => s + i.amount, 0);
    return [...by.values()].sort((x, y) => sum(y.due) - sum(x.due) || (y.run?.amount ?? 0) - (x.run?.amount ?? 0) || x.name.localeCompare(y.name));
  }, [view]);

  /* plans open in an animated side panel from the "Bonus plans" KPI */
  const [drawer, setDrawer] = useState<null | "plans" | "paid">(null);
  const [closing, setClosing] = useState(false);
  const openDrawer = (tab: "plans" | "paid") => { setClosing(false); setDrawer(tab); };
  const closeDrawer = () => { setClosing(true); window.setTimeout(() => { setDrawer(null); setClosing(false); }, 260); };
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !editing) closeDrawer(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const hue = (s2: string) => { let h = 7; for (let i = 0; i < s2.length; i++) h = (h * 31 + s2.charCodeAt(i)) % 360; return h; };
  const initials = (n: string) => n.split(" ").filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";

  if (!loaded) return <div className="bp"><div className="bp-sheet"><PageLoader fill={false} size={96} label="Loading bonus" /></div></div>;

  return (
    <div className="bp" onPointerMove={bpSpot}>
      {/* ---------- headline cards on the dark band ---------- */}
      <section className="bp-hero">
        <div className="bp-kpis">
          <div className="bp-kpi is-main" data-spot="tilt" style={bpVars({ "--i": 0 })}>
            <span className="bp-kpi-head"><span className="bp-kpi-ico"><BpIcon d={BP_ICON.gift} w={1.9} /></span><span className="bp-kpi-label">To pay by {prettyDate(asOf)}</span></span>
            <b className="bp-val is-xl"><BpCount value={totals.due} /><em>€</em></b>
            <small className="bp-kpi-sub">{view.due.length ? `${view.due.length} ${view.due.length === 1 ? "bonus" : "bonuses"} due${view.due.some((r) => r.payMonth < asOfYm) ? " · some overdue" : ""}` : "Nothing due"}</small>
          </div>
          <div className="bp-kpi" data-spot="tilt" style={bpVars({ "--i": 1 })}>
            <span className="bp-kpi-head"><span className="bp-kpi-ico"><BpIcon d={BP_ICON.clock} w={1.9} /></span><span className="bp-kpi-label">Coming up</span></span>
            <b className="bp-val"><BpCount value={totals.upcoming} /><em>€</em></b>
            <small className="bp-kpi-sub">Earned, waiting for the pay date</small>
          </div>
          <div className="bp-kpi" data-spot="tilt" style={bpVars({ "--i": 2 })}>
            <span className="bp-kpi-head"><span className="bp-kpi-ico"><BpIcon d={BP_ICON.spark} w={1.9} /></span><span className="bp-kpi-label">Running now</span></span>
            <b className="bp-val"><BpCount value={totals.running} /><em>€</em></b>
            <small className="bp-kpi-sub">Reached so far in open periods</small>
          </div>
          <button type="button" className="bp-kpi bk-kpi-plans" data-spot="tilt" style={bpVars({ "--i": 3 })} onClick={() => openDrawer("plans")} disabled={missing}>
            <span className="bp-kpi-head"><span className="bp-kpi-ico"><BpIcon d={BP_ICON.users} w={1.9} /></span><span className="bp-kpi-label">Bonus plans</span></span>
            <b className="bp-val"><BpCount value={plans.length} fmt={(n) => String(Math.round(n))} /><em>{plans.length === 1 ? "plan" : "plans"}</em></b>
            <small className="bp-kpi-sub bk-kpi-names">{plans.length ? plans.slice(0, 2).map((p) => p.name).join(" · ") + (plans.length > 2 ? ` +${plans.length - 2}` : "") : "None yet — create one"}</small>
            <span className="bk-kpi-go">View plans<BpIcon d={BP_ICON.chev} w={2.4} /></span>
          </button>
        </div>
      </section>

      <section className="bp-sheet bk">
        {missing && (
          <div className="bx-setup"><b>One step left</b><span>Run <code>empower_bonus_plans.sql</code> in Supabase to start using bonus plans.</span></div>
        )}
        {!missing && plans.length === 0 && !onlyUser && (
          <div className="bk-empty">
            <b>No bonus plans yet</b>
            <span>Create a plan and every consultant on it shows up here with their progress.</span>
            {canEdit && (
              <div>
                {legacy && <button className="bk-btn" onClick={startFromLegacy} disabled={busy === "legacy"}>{busy === "legacy" ? "Creating…" : "Start from current rules"}</button>}
                <button className="bk-btn is-soft" onClick={() => setEditing(blankPlan())}>Create a plan</button>
              </div>
            )}
          </div>
        )}

        <div className="bk-list">
          {cards.map((c, i) => {
            const r = c.run;
            const owed = [...c.due, ...c.upcoming];
            const owedTotal = owed.reduce((s2, x) => s2 + x.amount, 0);
            const late = c.due.some((x) => x.payMonth < asOfYm);
            const isOpen = openCard === c.userId;
            const tiers = r ? [...r.plan.tiers].filter((t) => activeConditions(t).length && (!t.months?.length || t.months.includes(Number(r.periodKey.slice(5, 7))))).sort((x, y) => tierRank(r.plan, x) - tierRank(r.plan, y)) : [];
            const top = tiers[tiers.length - 1];
            const tone = !r || !tiers.length ? "none" : !r.tier ? "red" : top && r.tier.id === top.id ? "purple" : "green";
            const status = tone === "none" ? "No tiers now" : tone === "red" ? "Below minimum" : tone === "purple" ? "Top tier" : `${r!.tier!.name} reached`;
            const metrics = (["billing", "days", "hours"] as Metric[]).filter((m) => tiers.some((t) => t.conditions[m] != null)).slice(0, 2);
            return (
              <article key={c.userId} className={`bk-card tone-${tone} ${isOpen ? "is-open" : ""}`} style={bpVars({ "--i": Math.min(i, 16), "--h": hue(c.name) })}>
                <button type="button" className="bk-hit" onClick={() => owed.length && setOpenCard(isOpen ? null : c.userId)} aria-expanded={isOpen} aria-label={`${c.name}: bonus details`} disabled={!owed.length} />
                <span className="bk-who">
                  <span className="bk-av">{initials(c.name)}</span>
                  <span className="bk-id">
                    <b>{c.name}</b>
                    <small>{r ? `${periodLabel(r.plan, r.periodKey)} · ${r.plan.name}` : c.plan?.name ?? "No plan now"}</small>
                    <span className="bk-status"><i />{status}{r && r.amount > 0 ? ` · ${eur(r.amount)} €` : ""}</span>
                  </span>
                </span>

                {metrics.length ? metrics.map((m) => {
                  const marks = tiers.filter((t) => t.conditions[m] != null).map((t) => ({ t, v: Number(t.conditions[m]) })).sort((x, y) => x.v - y.v);
                  const cur = r!.act[m];
                  const scale = Math.max(cur, marks.length ? marks[marks.length - 1].v : 1) * 1.06 || 1;
                  const next = marks.find((x) => cur < x.v);
                  const u = m === "billing" ? " €" : m === "days" ? "d" : "h";
                  const f = (n: number) => (m === "billing" ? eur(n) : d1(n));
                  return (
                    <div className="bk-metric" key={m}>
                      <div className="bk-metric-h">
                        <span>{m === "billing" ? "Billing" : m === "days" ? "Billable days" : "Hours worked"}</span>
                        <b>{f(cur)}<em>{u}</em></b>
                      </div>
                      <div className="bk-track">
                        <span className="bk-fill" style={{ width: `${armed ? Math.min(100, (cur / scale) * 100) : 0}%` }} />
                        {marks.map(({ t, v }) => <span key={t.id} className={`bk-tick ${cur >= v ? "is-hit" : ""}`} style={{ left: `${Math.min(98, (v / scale) * 100)}%` }} title={`${t.name}: ${f(v)}${u}`} />)}
                      </div>
                      <div className="bk-metric-f">
                        <span>{next ? <>{f(next.v - cur)}{u} to <b>{next.t.name}</b></> : <b>All tiers met</b>}</span>
                        <span className="bk-marks">{marks.map(({ t, v }) => <span key={t.id} className={cur >= v ? "is-hit" : ""}>{t.name} <b>{f(v)}</b></span>)}</span>
                      </div>
                    </div>
                  );
                }) : <span className="bk-noplan">{r ? "No tiers in this period" : "Not on a plan right now"}</span>}
                {metrics.length === 1 && <span />}

                <span className={`bk-owed ${owedTotal ? (late ? "is-late" : c.due.length ? "is-due" : "") : "is-clear"}`}>
                  <small>Owed</small>
                  <b>{eur(owedTotal)} €</b>
                  <em>{!owed.length ? "nothing pending" : late ? `${c.due.length} overdue` : c.due.length ? `${c.due.length} to pay` : `${owed.length} later`}</em>
                </span>
                <span className="bk-go" aria-hidden="true"><BpIcon d={BP_ICON.chev} w={2.4} /></span>

                {isOpen && owed.length > 0 && (() => {
                  const stat = (it: PayItem) => (c.due.includes(it) ? (it.payMonth < asOfYm ? "late" : "due") : "later");
                  const sums = { late: 0, due: 0, later: 0 } as Record<string, number>;
                  owed.forEach((it) => { sums[stat(it)] += it.amount; });
                  const dueTotalC = c.due.reduce((s2, x) => s2 + x.amount, 0);
                  return (
                    <div className="bk-owe">
                      <div className="bk-owe-sum">
                        <span className="bk-owe-k">Owed to {c.name.split(" ")[0]}</span>
                        <b className="bk-owe-total"><BpCount value={owedTotal} /><em>€</em></b>
                        <div className="bk-owe-stack">
                          {owed.map((it, k) => (
                            <i key={it.key} className={`is-${stat(it)}`} style={bpVars({ "--w": `${(it.amount / Math.max(1, owedTotal)) * 100}%`, "--k": k })} title={`${periodLabel(it.plan, it.periodKey)}: ${eur(it.amount)} €`} />
                          ))}
                        </div>
                        <div className="bk-owe-legend">
                          {sums.late > 0 && <span className="is-late"><i />Overdue <b>{eur(sums.late)} €</b></span>}
                          {sums.due > 0 && <span className="is-due"><i />Due now <b>{eur(sums.due)} €</b></span>}
                          {sums.later > 0 && <span className="is-later"><i />Later <b>{eur(sums.later)} €</b></span>}
                        </div>
                        {canPay && c.due.length > 1 && (
                          <button className="bk-owe-all" onClick={() => markPaid(c.due, `u|${c.userId}`)} disabled={busy === `u|${c.userId}`}>
                            <BpIcon d={BP_ICON.check} w={2.6} />{busy === `u|${c.userId}` ? "Saving…" : `Mark all paid · ${eur(dueTotalC)} €`}
                          </button>
                        )}
                      </div>

                      <div className="bk-owe-periods">
                        {owed.map((it, k) => {
                          const st = stat(it);
                          const ladder = [...it.plan.tiers].filter((t) => activeConditions(t).length && (!t.months?.length || t.months.includes(Number(it.periodKey.slice(5, 7))))).sort((x, y) => tierRank(it.plan, x) - tierRank(it.plan, y));
                          const reached = it.tier ? ladder.findIndex((t) => t.id === it.tier!.id) : -1;
                          return (
                            <div className={`bk-pc is-${st} ${vanishing.has(it.key) ? "is-vanishing" : ""}`} key={it.key} style={bpVars({ "--k": k })}>
                              <div className="bk-pc-top">
                                <b>{periodLabel(it.plan, it.periodKey)}</b>
                                <span className="bk-pc-chip">{st === "late" ? `Overdue · ${monthLabel(it.payMonth)}` : st === "due" ? "Due now" : `Pay ${monthLabel(it.payMonth)}`}</span>
                              </div>
                              <div className="bk-pc-steps">
                                {ladder.map((t, j) => <span key={t.id} className={j <= reached ? "is-on" : ""} style={bpVars({ "--j": j })}><i />{t.name}</span>)}
                              </div>
                              <div className="bk-pc-eq">
                                {it.tier && it.tier.reward.type === "pct"
                                  ? <><span>{eur(it.act.billing)} €</span><i>×</i><span className="is-pct">{it.tier.reward.value}%</span></>
                                  : <span>{it.tier ? "Fixed bonus" : "—"}</span>}
                              </div>
                              <div className="bk-pc-amt"><BpCount value={it.amount} /><em>€</em></div>
                              <div className="bk-pc-foot">
                                <span>{d1(it.act.days)} days · {d1(it.act.hours)} h</span>
                                {st !== "later" && canPay
                                  ? <button className="bk-pc-pay" onClick={() => markPaid([it], it.key)} disabled={busy === it.key}><BpIcon d={BP_ICON.check} w={2.8} />{busy === it.key ? "…" : "Paid"}</button>
                                  : <span className="bk-pc-wait">{st === "later" ? "Not due yet" : ""}</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </article>
            );
          })}
          {!missing && plans.length > 0 && cards.length === 0 && <p className="bk-none">Nobody is on a plan for this date.</p>}
        </div>
      </section>

      {/* ---------- plans side panel ---------- */}
      {drawer && createPortal(
        <div className={`bk-drawer-wrap ${closing ? "is-closing" : ""}`} onMouseDown={closeDrawer}>
          <aside className="bk-drawer" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Bonus plans">
            <header className="bk-dr-head">
              <div>
                <span className="bk-dr-eyebrow">Bonus</span>
                <h2>{drawer === "plans" ? "Plans" : "Payment history"}</h2>
              </div>
              <button className="bk-dr-x" onClick={closeDrawer} aria-label="Close">×</button>
            </header>
            <nav className="bk-dr-tabs" data-tab={drawer}>
              <button className={drawer === "plans" ? "is-on" : ""} onClick={() => setDrawer("plans")}>Plans <i>{plans.length}</i></button>
              <button className={drawer === "paid" ? "is-on" : ""} onClick={() => setDrawer("paid")}>Paid <i>{view.paid.length}</i></button>
              <span className="bk-dr-ink" />
            </nav>
            <div className="bk-dr-body" key={drawer}>
              {drawer === "plans" ? (
                <>
                  {plans.map((pl, k) => {
                    const sorted = [...pl.tiers].sort((x, y) => tierRank(pl, x) - tierRank(pl, y));
                    const whens = sorted.map((t) => tierWhen(pl, t));
                    const shared = whens.length > 0 && whens.every((w) => w === whens[0]) ? whens[0] : null;
                    const covered = profiles.filter((x) => !inactive.has(x.id) && matchStrength({ ...pl, active: true }, { id: x.id, name: x.name, role: x.role, department: x.department }) > 0);
                    const maxReward = Math.max(...sorted.map((t) => (t.reward.type === "pct" ? t.reward.value : 0)), 1);
                    return (
                      <article key={pl.id} className={`bk-plan ${pl.active ? "" : "is-paused"}`} style={bpVars({ "--i": k })}>
                        <div className="bk-plan-top">
                          <div>
                            <h3>{pl.name}</h3>
                            <p>{everyLabel(pl.every)} · paid {pl.delay === 0 ? "at the end" : `${pl.delay} ${pl.delay === 1 ? "month" : "months"} after`}{shared ? ` · only ${shared}` : ""}</p>
                          </div>
                          {!pl.active && <em>Paused</em>}
                          {canEdit && <button className="bk-btn is-soft" onClick={() => setEditing(pl)}>Edit</button>}
                        </div>
                        <div className="bk-ladder">
                          {sorted.map((t, j) => (
                            <div className="bk-step" key={t.id} style={bpVars({ "--j": j, "--hgt": `${30 + (t.reward.type === "pct" ? (t.reward.value / maxReward) * 70 : 50)}%` })}>
                              <span className="bk-step-bar"><b>{t.reward.type === "pct" ? `${t.reward.value}%` : `${eur(t.reward.value)}€`}</b></span>
                              <span className="bk-step-name">{t.name}</span>
                              <span className="bk-step-req">{activeConditions(t).map((m) => (m === "billing" ? `${eur(Number(t.conditions[m]))} €` : `${d1(Number(t.conditions[m]))}${m === "days" ? "d" : "h"}`)).join(" · ")}</span>
                              {!shared && whens[j] && <span className="bk-step-when">{whens[j]}</span>}
                            </div>
                          ))}
                        </div>
                        <div className="bk-plan-people">
                          <span className="bk-faces">{covered.slice(0, 6).map((x) => <i key={x.id} style={bpVars({ "--h": hue(x.name) })} title={x.name}>{initials(x.name)}</i>)}</span>
                          <span>{covered.length} {covered.length === 1 ? "person" : "people"}{pl.end ? ` · until ${monthLabel(pl.end)}` : ` · since ${monthLabel(pl.start)}`}</span>
                        </div>
                      </article>
                    );
                  })}
                  {!plans.length && <p className="bk-none">No plans yet.</p>}
                  {view.uncovered.length > 0 && plans.length > 0 && <p className="bk-warn">Not on any plan: {view.uncovered.map((x) => x.name).join(", ")}</p>}
                </>
              ) : (
                <div className="bk-paidlist">
                  {view.paid.length === 0 && <p className="bk-none">No payments yet.</p>}
                  {view.paid.slice(0, 100).map((p, k) => (
                    <div className="bk-paidrow" key={p.id} style={bpVars({ "--i": Math.min(k, 14) })}>
                      <i style={bpVars({ "--h": hue(p.name) })}>{initials(p.name)}</i>
                      <span><b>{p.name}</b><em>{paidLabel(p.plan, String(p.period_key))}{p.figures?.tier ? ` · ${p.figures.tier}` : ""} · paid {prettyDate(String(p.paid_date))}</em></span>
                      <b>{eur(Number(p.amount))} €</b>
                      {canPay && <button className="bk-undo" onClick={() => undoPaid(p.id)} disabled={busy === p.id}>Undo</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {drawer === "plans" && canEdit && (
              <footer className="bk-dr-foot">
                {!plans.length && legacy && <button className="bk-btn is-soft" onClick={startFromLegacy} disabled={busy === "legacy"}>Start from current rules</button>}
                <button className="bk-btn is-big" onClick={() => setEditing(blankPlan())}>+ New plan</button>
              </footer>
            )}
          </aside>
        </div>,
        document.body,
      )}

      {editing && (
        <BonusPlanModal
          plan={editing}
          people={pickPeople}
          roles={roles}
          departments={departments}
          onSave={savePlan}
          onDelete={editing.id ? () => deletePlan(editing) : undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}