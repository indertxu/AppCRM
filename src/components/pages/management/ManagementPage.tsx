/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { inBillingMonth, periodOf, type Cutoffs } from "../calendar/billingPeriods";
import { effectiveRate, effectiveSupervisionRate } from "../clients/ClientsPage";
import CalendarSettingsModal, { type WorkTypeDef, type Targets, type CapValue } from "../calendar/CalendarSettingsModal";
import UserTargetModal, { type UserTarget } from "./UserTargetModal";
import DatePicker from "../../framework/DatePicker";
import BacklogPanel from "./BacklogPanel";
import BonusPanel from "./BonusPanel";
import BillingPanel from "./BillingPanel";
import "./ManagementPage.css";

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

type Scope = "week" | "month" | "year" | "all" | "custom";

interface Entry {
  id: string;
  userId: string;
  projectId: string;
  date: string;
  billable: number;
  status: string;
  line: string;
  typeId: string;
  durationDays: number;
  billingPeriod: string | null;
}
interface Proj {
  id: string;
  clientId: string;
  typeId: string;
  kickoff: string;
  rate: number;
  supervision: number;
  consultorDays: number;
  connectorDays: number;
  supervisionDays: number;
  status: string;
  taxed: boolean;
  taxRate: number;
  legalName: string;
  vat: string;
  address: any;
  contacts: any[];
  team: { userId?: string; role?: string }[];
}
interface Row {
  userId: string;
  name: string;
  daysDone: number;
  daysPlanned: number;
amountDone: number;
  amountPlanned: number;
  connDays: number;
  connAmount: number;
  byProject: Record<string, {
    rateKind: string; rate: number;
    daysDone: number; daysPlanned: number;
    amountDone: number; amountPlanned: number;
  }>;
}

function startOfWeek(input: Date): Date {
  const d = new Date(input);
  const day = d.getDay();
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  d.setHours(0, 0, 0, 0);
  return d;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Mon-Fri days between two ISO dates, inclusive. Drives prorated targets. */
function businessDays(fromIso: string, toIso: string): number {
  if (!fromIso || !toIso) return 0;
  const a = new Date(`${fromIso}T00:00:00`);
  const b = new Date(`${toIso}T00:00:00`);
  if (b < a) return 0;
  let n = 0;
  for (const d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) n += 1;
  }
  return n;
}

export default function ManagementPage() {
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState(() => new Date());
  const [scope, setScope] = useState<Scope>("month");
  const [cutoffs, setCutoffs] = useState<Cutoffs>({});
  const [defaultCutoffDay, setDefaultCutoffDay] = useState(0);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [projOpen, setProjOpen] = useState<string | null>(null); // "userId|projectKey"
  const [tab, setTab] = useState<"team" | "backlog" | "billing" | "bonus">("team");

  const [entries, setEntries] = useState<Entry[]>([]);
  const [clientTypeIds, setClientTypeIds] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<Record<string, Proj>>({});
  const [clientNames, setClientNames] = useState<Record<string, string>>({});
const [people, setPeople] = useState<Record<string, string>>({});
const [supRoles, setSupRoles] = useState<Set<string>>(new Set());
const [typeNames, setTypeNames] = useState<Record<string, string>>({});
const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [userTargets, setUserTargets] = useState<Record<string, UserTarget>>({});
  const [capacity, setCapacity] = useState<Record<string, CapValue>>({});
  const [capSavedId, setCapSavedId] = useState<string | null>(null);
  const [bonusLag, setBonusLag] = useState(2);
  const [targetFor, setTargetFor] = useState<string | null>(null);
  const [capFocusUser, setCapFocusUser] = useState<string | null>(null);
const [targets, setTargets] = useState<Targets>({
perDay: 1, minPerDay: 0.5, minPerWeek: 3, minPerMonth: 12, minRevenueWeek: 0, minRevenueMonth: 0,
  });
  const [workTypes, setWorkTypes] = useState<WorkTypeDef[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: ce } = await supabase
        .from("calendar_entries")
        .select("id, user_id, project_id, entry_date, billable, status, billing_line, work_type_id, start_min, end_min, billing_period");
      const { data: ea } = await supabase.from("entry_actuals").select("entry_id, actual_billable");
      const actual: Record<string, number> = Object.fromEntries(
        ((ea ?? []) as any[]).map((r) => [r.entry_id, Number(r.actual_billable) || 0])
      );
      setEntries(((ce ?? []) as any[]).map((r) => {
        const dur = (Number(r.end_min) || 0) - (Number(r.start_min) || 0);
        const iso = r.entry_date ?? "";
        // Full workday length depends on the weekday: Fri 09:00–14:30 = 5.5h, else 8h.
        const dow = iso ? new Date(`${iso}T00:00:00`).getDay() : 1; // 0=Sun … 5=Fri
        const fullDay = dow === 5 ? 330 : 480; // minutes
        return {
          id: r.id,
          userId: r.user_id ?? "",
          projectId: r.project_id ?? "",
          date: iso,
          billable: actual[r.id] ?? (Number(r.billable) || 0),
          status: r.status ?? "planned",
          line: r.billing_line ?? "consultor",
          typeId: r.work_type_id ?? "",
          durationDays: dur > 0 ? +(dur / fullDay).toFixed(3) : 0,
          billingPeriod: r.billing_period ?? null,
        };
      }));

      const { data: wtypes } = await supabase.from("work_types").select("id, client_related");
      setClientTypeIds(new Set(((wtypes ?? []) as any[]).filter((t) => t.client_related).map((t) => t.id)));

      const { data: pj } = await supabase
        .from("projects")
     .select("id, client_id, project_type_id, kickoff_date, price_per_day, supervision_price, discount_mode, discount_value, team, consultor_days, connector_days, supervision_days, status, legal_name, vat_number, address, contacts, taxed, tax_rate");
      setProjects(Object.fromEntries(((pj ?? []) as any[]).map((r) => {
        const base = Number(r.price_per_day) || 0;
        const d = Number(r.discount_value) || 0;
return [r.id, {
          id: r.id,
          clientId: r.client_id,
          typeId: r.project_type_id ?? "",
          kickoff: r.kickoff_date ?? "",
          rate: effectiveRate(base, r.discount_mode, d),
supervision: effectiveSupervisionRate(Number(r.supervision_price) || 0, r.discount_mode, d),
          consultorDays: Number(r.consultor_days) || 0,
          connectorDays: Number(r.connector_days) || 0,
          supervisionDays: Number(r.supervision_days) || 0,
          status: r.status ?? "open",
          legalName: r.legal_name ?? "",
          vat: r.vat_number ?? "",
          address: r.address ?? null,
          contacts: Array.isArray(r.contacts) ? r.contacts : [],
          taxed: !!r.taxed,
          taxRate: Number(r.tax_rate) || 0,
          team: r.team ?? [],
        } as Proj];
      })));

const { data: ut } = await supabase.from("user_targets").select("*");
      setUserTargets(Object.fromEntries(((ut ?? []) as any[]).map((r) => [r.user_id, {
        minPerWeek: r.min_per_week === null ? null : Number(r.min_per_week),
        minPerMonth: r.min_per_month === null ? null : Number(r.min_per_month),
minRevenueWeek: r.min_revenue_week === null ? null : Number(r.min_revenue_week),
        minRevenueMonth: r.min_revenue_month === null ? null : Number(r.min_revenue_month),
      }])));
      setCapacity(Object.fromEntries(((ut ?? []) as any[]).map((r) => [r.user_id, {
        fullDays: r.full_days_per_week ?? null,
        minDays: r.min_days_month ?? null,
        minBilling: r.min_billing_month ?? null,
        bonusPct1: r.bonus_pct_1 ?? null,
        highDays: r.high_days_month ?? null,
        highBilling: r.high_billing_month ?? null,
        bonusPct2: r.bonus_pct_2 ?? null,
      }])));

      const { data: pt } = await supabase.from("project_types").select("id, name");
      setTypeNames(Object.fromEntries(((pt ?? []) as any[]).map((t) => [t.id, t.name ?? ""])));

      const { data: rl } = await supabase.from("client_roles").select("id, is_supervision");
      setSupRoles(new Set(((rl ?? []) as any[]).filter((r) => r.is_supervision).map((r) => r.id)));

      const { data: cl } = await supabase.from("clients").select("id, name");
      setClientNames(Object.fromEntries(((cl ?? []) as any[]).map((c) => [c.id, c.name])));

      const { data: tg } = await supabase.from("calendar_targets").select("*").eq("id", "default").maybeSingle();
if (tg) setTargets({
        perDay: Number(tg.per_day) || 0,
        minPerDay: Number(tg.min_per_day) || 0,
        minPerWeek: Number(tg.min_per_week) || 0,
        minPerMonth: Number(tg.min_per_month) || 0,
minRevenueWeek: Number(tg.min_revenue_week) || 0,
        minRevenueMonth: Number(tg.min_revenue_month) || 0,
      });

      const { data: wt } = await supabase.from("work_types").select("*").order("created_at");
      setWorkTypes(((wt ?? []) as any[]).map((r) => ({
        id: r.id, name: r.name ?? "", clientRelated: !!r.client_related, color: r.color ?? "#12b57f",
      })));

const { data: us } = await supabase.functions.invoke("manage-users", { body: { action: "list" } });
const { data: prof } = await supabase.from("profiles").select("id, role, job_title");
      const excluded = new Set(
        ((prof ?? []) as any[])
          .filter((p) => {
            const jt = (p.job_title ?? "").toLowerCase();
            const rl = (p.role ?? "").toLowerCase();
            return rl === "boss" || jt === "ceo" || jt === "cfo";
          })
          .map((p) => p.id)
      );
setExcluded(excluded);
      setPeople(Object.fromEntries(((us?.users ?? []) as any[])
        .map((u) => [
          u.id,
          [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—",
        ])));

      const { data: bp } = await supabase.from("billing_periods").select("period, cutoff_date");
      if (bp) setCutoffs(Object.fromEntries((bp as any[]).map((r) => [r.period, r.cutoff_date])));
      const { data: bs } = await supabase.from("billing_settings").select("default_cutoff_day, bonus_lag_months").eq("id", "default").maybeSingle();
      if (bs) { setDefaultCutoffDay(Number(bs.default_cutoff_day) || 0); setBonusLag(Number(bs.bonus_lag_months ?? 2)); }

      setLoading(false);
    })();
  }, []);

const closeSettings = async () => {
    const { data: existing } = await supabase.from("work_types").select("id");
    const keep = new Set(workTypes.map((t) => t.id));
    const gone = ((existing ?? []) as any[]).filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (gone.length) await supabase.from("work_types").delete().in("id", gone);
    if (workTypes.length)
      await supabase.from("work_types").upsert(workTypes.map((t) => ({
        id: t.id, name: t.name, client_related: t.clientRelated, color: t.color,
      })));
    await supabase.from("calendar_targets").upsert({
      id: "default",
      per_day: targets.perDay,
      min_per_day: targets.minPerDay,
      min_per_week: targets.minPerWeek,
      min_per_month: targets.minPerMonth,
      min_revenue_week: targets.minRevenueWeek,
      min_revenue_month: targets.minRevenueMonth,
    });
    // Billing cutoffs (shared with the calendar)
    await supabase.from("billing_settings").upsert({ id: "default", default_cutoff_day: defaultCutoffDay });
    const cutoffRows = Object.entries(cutoffs).map(([period, cutoff_date]) => ({ period, cutoff_date }));
    if (cutoffRows.length) await supabase.from("billing_periods").upsert(cutoffRows);
    setShowSettings(false);
  };

const saveUserTarget = async (uid: string, v: UserTarget) => {
    const { error } = await supabase.from("user_targets").upsert({
      user_id: uid,
      min_per_week: v.minPerWeek,
      min_per_month: v.minPerMonth,
min_revenue_week: v.minRevenueWeek,
      min_revenue_month: v.minRevenueMonth,
    }, { onConflict: "user_id" });
    if (error) { alert(`Could not save targets: ${error.message}`); return; }
    setUserTargets((s) => ({ ...s, [uid]: v }));
    setTargetFor(null);
  };

  const changeCapacity = (uid: string, patch: Partial<CapValue>) =>
    setCapacity((c) => ({
      ...c,
      [uid]: {
        fullDays: null, minDays: null, minBilling: null, bonusPct1: null,
        highDays: null, highBilling: null, bonusPct2: null,
        ...c[uid], ...patch,
      },
    }));

  const saveCapacity = async (uid: string) => {
    const c = capacity[uid];
    if (!c) return;
    const { error } = await supabase.from("user_targets").upsert({
      user_id: uid,
      full_days_per_week: c.fullDays,
      min_days_month: c.minDays,
      min_billing_month: c.minBilling,
      bonus_pct_1: c.bonusPct1,
      high_days_month: c.highDays,
      high_billing_month: c.highBilling,
      bonus_pct_2: c.bonusPct2,
    }, { onConflict: "user_id" });
    if (error) { alert(`Could not save: ${error.message}`); return; }
    setCapSavedId(uid);
    window.setTimeout(() => setCapSavedId((x) => (x === uid ? null : x)), 1600);
  };

  /** Goals for one person, falling back to the company defaults. */
  const goalsFor = (uid: string) => {
    const c = capacity[uid];
    // Monthly minimums/highs come from the two-tier targets (Management settings).
    const minM = c?.minDays ?? null;
    const highM = c?.highDays ?? null;
    const minRevM = c?.minBilling ?? null;
    const highRevM = c?.highBilling ?? null;
    // Subdivide monthly → scope. week ≈ month/4.333; year ≈ month×12.
    const WPM = 4.333;
    const scaleDays = (m: number | null) => {
      if (m == null) return 0;
      return scope === "week" ? +(m / WPM).toFixed(2)
        : scope === "month" ? m
        : scope === "year" ? m * 12
        : scope === "custom" ? +((m / WPM) * rangeWeeks).toFixed(2) : 0;
    };
    const scaleMoney = (m: number | null) => {
      if (m == null) return 0;
      return scope === "week" ? Math.round(m / WPM)
        : scope === "month" ? m
        : scope === "year" ? m * 12
        : scope === "custom" ? Math.round((m / WPM) * rangeWeeks) : 0;
    };
    return {
      days: scaleDays(minM),
      daysHigh: scaleDays(highM),
      money: scaleMoney(minRevM),
      moneyHigh: scaleMoney(highRevM),
      custom: !!c && (c.minDays != null || c.minBilling != null || c.highDays != null || c.highBilling != null),
    };
  };

  const weekStart = startOfWeek(anchor);
  const inScope = (iso: string) => {
    if (scope === "all") return true;
    if (!iso) return false;
    if (scope === "custom") {
      if (rangeFrom && iso < rangeFrom) return false;
      if (rangeTo && iso > rangeTo) return false;
      return true;
    }
    const d = new Date(`${iso}T00:00:00`);
    if (scope === "year") return d.getFullYear() === anchor.getFullYear();
    if (scope === "month")
      return inBillingMonth(iso, periodOf(anchor), cutoffs, defaultCutoffDay);
    const end = addDays(weekStart, 5);
    return d >= weekStart && d < end;
  };

  /**
   * Scope test for BILLING figures (revenue, bonus base): an entry moved to
   * another billing period must count in that period, not its work date.
   * Work-time metrics keep using inScope(e.date) instead.
   */
  const inBillingScope = (e: Entry) => {
    const override = e.billingPeriod;
    if (!override) return inScope(e.date);
    // Entry has been moved to a specific billing period ('YYYY-MM').
    if (scope === "all") return true;
    if (scope === "year") return override.slice(0, 4) === String(anchor.getFullYear());
    if (scope === "month") return override === periodOf(anchor);
    // week / custom: a moved entry bills on its target period's cutoff; fall back
    // to the natural date test since sub-month billing windows aren't period-keyed.
    return inScope(e.date);
  };

  /** Weeks-worth of target covered by the custom range, so goals stay comparable. */
  const rangeWeeks = scope === "custom" ? businessDays(rangeFrom, rangeTo) / 5 : 0;

const rateFor = (p: Proj, line: string, userId: string): { rate: number; kind: string } => {
    if (line === "connector") return { rate: p.rate, kind: "Connector" };
    const member = (p.team ?? []).find((m) => m.userId === userId);
    const isSup = line === "supervision" || supRoles.has(member?.role ?? "");
    return isSup
      ? { rate: p.supervision, kind: "Project management" }
      : { rate: p.rate, kind: "Consultancy" };
  };

  const rows = useMemo<Row[]>(() => {
    const acc: Record<string, Row> = {};
    const blank = (uid: string): Row => ({
      userId: uid, name: people[uid] ?? "—",
daysDone: 0, daysPlanned: 0, amountDone: 0, amountPlanned: 0,
      connDays: 0, connAmount: 0, byProject: {},
    });

    entries.forEach((e) => {
      if (e.status === "cancelled" || e.line === "closure") return;
     if (!e.projectId || !e.userId) return;
      if (!inBillingScope(e)) return; // revenue/bonus base: follow the invoiced period
      const p = projects[e.projectId];
      if (!p) return;

const { rate, kind } = rateFor(p, e.line, e.userId);
      const amount = e.billable * rate;
      if (!acc[e.userId]) acc[e.userId] = blank(e.userId);
      const row = acc[e.userId];
if (e.line === "connector") return;
      if (e.status === "confirmed") {
        row.daysDone += e.billable; row.amountDone += amount;
      } else {
        row.daysPlanned += e.billable; row.amountPlanned += amount;
      }

      const key = `${e.projectId}|${kind}`;
      if (!row.byProject[key])
        row.byProject[key] = { rateKind: kind, rate, daysDone: 0, daysPlanned: 0, amountDone: 0, amountPlanned: 0 };
      const cell = row.byProject[key];
      if (e.status === "confirmed") { cell.daysDone += e.billable; cell.amountDone += amount; }
      else { cell.daysPlanned += e.billable; cell.amountPlanned += amount; }
    });

   const inTeam = new Set(
      Object.values(projects).flatMap((p) => (p.team ?? []).map((m) => m.userId).filter(Boolean) as string[])
    );
    Object.keys(people).forEach((uid) => {
      if (!acc[uid] && !excluded.has(uid) && inTeam.has(uid)) acc[uid] = blank(uid);
    });

    return Object.values(acc).sort((a, b) =>
      (b.amountDone + b.amountPlanned) - (a.amountDone + a.amountPlanned)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [entries, projects, people, supRoles, excluded, anchor, scope, rangeFrom, rangeTo, cutoffs, defaultCutoffDay]);

  // Goals scaled to the current scope
  const dayGoal =
    scope === "week" ? targets.minPerWeek
    : scope === "month" ? targets.minPerMonth
    : scope === "year" ? targets.minPerMonth * 12
    : scope === "custom" ? targets.minPerWeek * rangeWeeks
    : 0;
const moneyGoal =
    scope === "week" ? targets.minRevenueWeek
    : scope === "month" ? targets.minRevenueMonth
    : scope === "year" ? targets.minRevenueMonth * 12
    : scope === "custom" ? targets.minRevenueWeek * rangeWeeks
    : 0;

  const totalDone = rows.reduce((s, r) => s + r.amountDone, 0);
  const totalPlanned = rows.reduce((s, r) => s + r.amountPlanned, 0);
  const totalDays = rows.reduce((s, r) => s + r.daysDone, 0);
const totalDaysPlanned = rows.reduce((s, r) => s + r.daysPlanned, 0);
  const teamDayGoal = rows.reduce((s, r) => s + goalsFor(r.userId).days, 0);
const teamMoneyGoal = rows.reduce((s, r) => s + goalsFor(r.userId).money, 0);

  // Buckets across the current scope, for the mini chart
  const buckets = (() => {
    const out: { label: string; done: number; planned: number }[] = [];
    const add = (label: string, test: (d: Date) => boolean) => {
      let done = 0, planned = 0;
      entries.forEach((e) => {
        if (e.status === "cancelled" || e.line === "closure" || e.line === "connector") return;
        if (!e.projectId || !e.userId || !e.date) return;
        if (!inBillingScope(e)) return; // billing chart: follow invoiced period
        const d = new Date(`${e.date}T00:00:00`);
        if (!test(d)) return;
        const p = projects[e.projectId];
        if (!p) return;
        const { rate } = rateFor(p, e.line, e.userId);
        const amt = e.billable * rate;
        if (e.status === "confirmed") done += amt; else planned += amt;
      });
      out.push({ label, done, planned });
    };

    if (scope === "custom") {
      if (!rangeFrom || !rangeTo) return out;
      const a = new Date(`${rangeFrom}T00:00:00`);
      const b = new Date(`${rangeTo}T00:00:00`);
      const span = Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
      if (span <= 0) return out;
      if (span <= 14) {
        for (let i = 0; i < span; i++) {
          const day = addDays(a, i);
          if (day.getDay() === 0 || day.getDay() === 6) continue;
          add(`${day.getDate()}`, (d) => d.toDateString() === day.toDateString());
        }
      } else if (span <= 120) {
        for (let s = startOfWeek(a), i = 1; s <= b; s = addDays(s, 7), i++) {
          const from = new Date(s);
          const to = addDays(s, 7);
          add(`W${i}`, (d) => d >= from && d < to);
        }
      } else {
        for (let s = new Date(a.getFullYear(), a.getMonth(), 1); s <= b; s = new Date(s.getFullYear(), s.getMonth() + 1, 1)) {
          const from = new Date(s);
          const to = new Date(s.getFullYear(), s.getMonth() + 1, 1);
          add(MONTHS_SHORT[from.getMonth()], (d) => d >= from && d < to);
        }
      }
      return out;
    }

    if (scope === "week") {
      ["M", "T", "W", "T", "F"].forEach((n, i) => {
        const day = addDays(weekStart, i);
        add(n, (d) => d.toDateString() === day.toDateString());
      });
    } else if (scope === "month") {
      for (let w = 0; w < 5; w++) {
        const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1 + w * 7);
        const to = new Date(anchor.getFullYear(), anchor.getMonth(), 8 + w * 7);
        add(`W${w + 1}`, (d) => d >= from && d < to);
      }
    } else {
      MONTHS_SHORT.forEach((n, i) => add(n, (d) => d.getMonth() === i));
    }
    return out;
  })();

  const peak = Math.max(1, ...buckets.map((b) => b.done + b.planned));
  const onTarget = rows.filter((r) => {
    const g = goalsFor(r.userId);
    return g.money > 0 && r.amountDone >= g.money;
  }).length;

  const dayPct = teamDayGoal > 0 ? (totalDays / teamDayGoal) * 100 : 0;
  const moneyPct = teamMoneyGoal > 0 ? (totalDone / teamMoneyGoal) * 100 : 0;
  const dayProjPct = teamDayGoal > 0 ? ((totalDays + totalDaysPlanned) / teamDayGoal) * 100 : 0;
  const moneyProjPct = teamMoneyGoal > 0 ? ((totalDone + totalPlanned) / teamMoneyGoal) * 100 : 0;
  const RING_R = 34;
  const RING_C = 2 * Math.PI * RING_R;
  const ring = (p: number) => ({
    strokeDasharray: `${(Math.min(100, p) / 100) * RING_C} ${RING_C}`,
  });

  /** Switch to custom, seeding the range with the month in view the first time. */
  const openCustom = () => {
    if (!rangeFrom && !rangeTo) {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      setRangeFrom(toISO(first));
      setRangeTo(toISO(last));
    }
    setScope("custom");
  };

  const step = (d: 1 | -1) =>
    setAnchor((a) =>
      scope === "year" ? new Date(a.getFullYear() + d, 0, 1)
      : scope === "week" ? addDays(a, d * 7)
      : new Date(a.getFullYear(), a.getMonth() + d, 1)
    );

  const label = (() => {
    if (scope === "all") return "All time";
    if (scope === "custom") return "Custom range";
    if (scope === "year") return `${anchor.getFullYear()}`;
    if (scope === "month") return `${MONTHS_FULL[anchor.getMonth()]} ${anchor.getFullYear()}`;
    const e = addDays(weekStart, 4);
    return `${MONTHS_SHORT[weekStart.getMonth()]} ${weekStart.getDate()} – ${MONTHS_SHORT[e.getMonth()]} ${e.getDate()}`;
  })();

  const pct = (n: number, goal: number) => (goal > 0 ? Math.min(100, (n / goal) * 100) : 0);

  /**
   * Deep per-consultant analytics for the expanded row, computed over the
   * current scope. Splits work into billable (client + has a rate) vs
   * client-facing-unbilled vs internal; derives averages, blended rate,
   * utilisation and a per-period trend.
   */
  /**
   * Two-tier marginal bonus on an invoiced amount.
   * Gate: must meet the minimum days AND billing to earn anything.
   * Up to the high billing threshold pays pct1; the excess above it pays pct2.
   */
  const computeBonus = (amount: number, days: number, cap: CapValue | undefined) => {
    if (!cap) return { amount: 0, tier: 0 as 0 | 1 | 2, minMet: false, highMet: false };
    const { minDays, minBilling, bonusPct1, highDays, highBilling, bonusPct2 } = cap;
    const hasMin = minDays != null || minBilling != null;
    const minMet = hasMin
      && (minDays == null || days >= minDays)
      && (minBilling == null || amount >= minBilling);
    if (!minMet) return { amount: 0, tier: 0 as 0 | 1 | 2, minMet: false, highMet: false };
    const hasHigh = highBilling != null && bonusPct2 != null;
    const highMet = hasHigh
      && (highDays == null || days >= highDays)
      && (highBilling == null || amount >= highBilling);
    const p1 = (bonusPct1 ?? 0) / 100;
    const p2 = (bonusPct2 ?? 0) / 100;
    let bonus: number;
    let tier: 0 | 1 | 2;
    if (highMet && highBilling != null) {
      bonus = highBilling * p1 + (amount - highBilling) * p2;
      tier = 2;
    } else {
      bonus = amount * p1;
      tier = 1;
    }
    return { amount: bonus, tier, minMet, highMet };
  };

  const insightsFor = (uid: string) => {
    const mine = entries.filter((e) =>
      e.userId === uid && e.status !== "cancelled" && e.line !== "closure" && e.line !== "connector" && inScope(e.date)
    );

    let billableDays = 0, billableAmount = 0;
    let clientUnbilledDays = 0;   // client-facing but no rate/project → not invoiced
    let internalDays = 0;         // non-client work types
    const perDay: Record<string, { billable: number; total: number; amount: number }> = {};
    const rateSamples: number[] = [];

    mine.forEach((e) => {
      const p = e.projectId ? projects[e.projectId] : null;
      const isClientType = clientTypeIds.size === 0 ? !!p : clientTypeIds.has(e.typeId);
      const rate = p ? rateFor(p, e.line, uid).rate : 0;
      const billed = !!p && rate > 0 && isClientType && e.billable > 0;
      // For non-billed work, billable is 0, so measure real time worked instead.
      const worked = e.billable > 0 ? e.billable : e.durationDays;

      if (!perDay[e.date]) perDay[e.date] = { billable: 0, total: 0, amount: 0 };
      perDay[e.date].total += worked;

      if (billed) {
        billableDays += e.billable;
        billableAmount += e.billable * rate;
        perDay[e.date].billable += e.billable;
        perDay[e.date].amount += e.billable * rate;
        rateSamples.push(rate);
      } else if (isClientType) {
        clientUnbilledDays += worked;
      } else {
        internalDays += worked;
      }
    });

    const totalWorked = billableDays + clientUnbilledDays + internalDays;
    const blendedRate = billableDays > 0 ? billableAmount / billableDays : 0;
    const utilisation = totalWorked > 0 ? (billableDays / totalWorked) * 100 : 0;

    // INVOICED figures = bonus base. These follow the billing period (override),
    // not the work date, because bonuses are paid on what the client was invoiced.
    let invoicedAmount = 0, invoicedDays = 0;
    entries.forEach((e) => {
      if (e.userId !== uid || e.status === "cancelled" || e.line === "closure" || e.line === "connector") return;
      if (!e.projectId) return;
      if (!inBillingScope(e)) return;
      const p = projects[e.projectId];
      if (!p) return;
      const isClientType = clientTypeIds.size === 0 ? !!p : clientTypeIds.has(e.typeId);
      const rate = rateFor(p, e.line, uid).rate;
      if (rate > 0 && isClientType && e.billable > 0) {
        invoicedAmount += e.billable * rate;
        invoicedDays += e.billable;
      }
    });

    // Scope length in business days & weeks, for averages
    let bizDays = 0;
    if (scope === "week") bizDays = 5;
    else if (scope === "month") bizDays = 22;
    else if (scope === "year") bizDays = 260;
    else if (scope === "custom") bizDays = businessDays(rangeFrom, rangeTo);
    else {
      // "all": span of logged dates
      const ds = mine.map((e) => e.date).filter(Boolean).sort();
      bizDays = ds.length ? businessDays(ds[0], ds[ds.length - 1]) : 0;
    }
    const weeks = bizDays > 0 ? bizDays / 5 : 0;
    const months = bizDays > 0 ? bizDays / 22 : 0;

    // Available capacity over the scope, from the consultant's configured full days/week.
    const cap = capacity[uid];
    const fullDaysWeek = cap?.fullDays ?? 5;          // default 5 if unset
    const billTargetWeek = cap?.billableDays ?? null; // billable-days target
    const availableDays = weeks > 0 ? fullDaysWeek * weeks : 0;
    // Utilisation vs available time: how much of their capacity was billable.
    const capUtilisation = availableDays > 0 ? (billableDays / availableDays) * 100 : 0;
    // How much of capacity was worked at all (billable + unbilled + internal).
    const occupancy = availableDays > 0 ? (totalWorked / availableDays) * 100 : 0;
    const idleDays = Math.max(0, availableDays - totalWorked);

    const avgDaysWeek = weeks > 0 ? billableDays / weeks : 0;
    const avgAmountWeek = weeks > 0 ? billableAmount / weeks : 0;
    const avgDaysMonth = months > 0 ? billableDays / months : 0;
    const avgAmountMonth = months > 0 ? billableAmount / months : 0;
    const avgAmountDay = bizDays > 0 ? billableAmount / bizDays : 0;

    // Trend: bucket billable amount by period across the scope
    const trend: { label: string; amount: number; days: number }[] = [];
    const buckets: Record<string, { amount: number; days: number }> = {};
    const keyFor = (iso: string) => {
      const d = new Date(`${iso}T00:00:00`);
      if (scope === "week" || scope === "custom") return iso; // per day
      if (scope === "year" || scope === "all") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      // month → per ISO week number within the month
      const wk = Math.ceil(d.getDate() / 7);
      return `W${wk}`;
    };
    mine.forEach((e) => {
      const p = e.projectId ? projects[e.projectId] : null;
      const rate = p ? rateFor(p, e.line, uid).rate : 0;
      const isClientType = clientTypeIds.size === 0 ? !!p : clientTypeIds.has(e.typeId);
      if (!(p && rate > 0 && isClientType)) return;
      const k = keyFor(e.date);
      if (!buckets[k]) buckets[k] = { amount: 0, days: 0 };
      buckets[k].amount += e.billable * rate;
      buckets[k].days += e.billable;
    });
    Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, v]) =>
      trend.push({ label: k, amount: v.amount, days: v.days })
    );

    return {
      billableDays, billableAmount, clientUnbilledDays, internalDays, totalWorked,
      blendedRate, utilisation,
      invoicedAmount, invoicedDays,
      availableDays, capUtilisation, occupancy, idleDays, fullDaysWeek, billTargetWeek,
      avgDaysWeek, avgAmountWeek, avgDaysMonth, avgAmountMonth, avgAmountDay,
      trend, activeDays: Object.keys(perDay).length,
    };
  };

  return (
    <div className={`mg mg-tab-${tab}`}>
      <header className="mg-bar">
        <div className="mg-bar-left">
          <button className="mg-home" onClick={() => navigate("/home")} aria-label="Back to home">‹</button>
          <h1 className="mg-title">Management</h1>
          <div className="mg-tabseg" data-tab={tab}>
            <span className="mg-tabseg-slider" />
            <button className={tab === "team" ? "is-on" : ""} onClick={() => setTab("team")}>Team</button>
            <button className={tab === "backlog" ? "is-on" : ""} onClick={() => setTab("backlog")}>Backlog</button>
            <button className={tab === "billing" ? "is-on" : ""} onClick={() => setTab("billing")}>Billing</button>
            <button className={tab === "bonus" ? "is-on" : ""} onClick={() => setTab("bonus")}>Bonus</button>
          </div>
        </div>

        <div className="mg-nav">
          <div className="mg-seg" data-scope={scope}>
            <span className="mg-seg-slider" />
            <button className={scope === "week" ? "is-on" : ""} onClick={() => setScope("week")}>Week</button>
            <button className={scope === "month" ? "is-on" : ""} onClick={() => setScope("month")}>Month</button>
            <button className={scope === "year" ? "is-on" : ""} onClick={() => setScope("year")}>Year</button>
            <button className={scope === "all" ? "is-on" : ""} onClick={() => setScope("all")}>All</button>
            <button className={scope === "custom" ? "is-on" : ""} onClick={openCustom}>Custom</button>
          </div>

          {scope === "custom" ? (
            <div className="mg-range">
              <span className="mg-range-field">
                <DatePicker value={rangeFrom} onChange={setRangeFrom} placeholder="From" />
              </span>
              <span className="mg-range-arrow">→</span>
              <span className="mg-range-field">
                <DatePicker value={rangeTo} onChange={setRangeTo} placeholder="To" />
              </span>
              {rangeFrom && rangeTo && (
                <span className="mg-range-count">
                  {businessDays(rangeFrom, rangeTo)} working days
                </span>
              )}
            </div>
          ) : (
            <>
              {scope !== "all" && <button className="mg-btn" onClick={() => step(-1)} aria-label="Previous">‹</button>}
              <span className="mg-period">{label}</span>
              {scope !== "all" && <button className="mg-btn" onClick={() => step(1)} aria-label="Next">›</button>}
            </>
          )}

          <button className="mg-btn mg-gear" onClick={() => { setCapFocusUser(null); setShowSettings(true); }} aria-label="Targets" title="Targets">⚙</button>
        </div>
      </header>

      {targetFor && (
        <UserTargetModal
          name={people[targetFor] ?? "—"}
          general={{
            minPerWeek: targets.minPerWeek,
minPerMonth: targets.minPerMonth,
            minRevenueWeek: targets.minRevenueWeek,
            minRevenueMonth: targets.minRevenueMonth,
          }}
         value={userTargets[targetFor] ?? { minPerWeek: null, minPerMonth: null, minRevenueWeek: null, minRevenueMonth: null }}
          onSave={(v) => saveUserTarget(targetFor, v)}
          onClose={() => setTargetFor(null)}
        />
      )}

      {showSettings && (
        <CalendarSettingsModal
          types={workTypes}
          setTypes={setWorkTypes}
          targets={targets}
          setTargets={setTargets}
          cutoffs={cutoffs}
          setCutoffs={setCutoffs}
          defaultCutoffDay={defaultCutoffDay}
          setDefaultCutoffDay={setDefaultCutoffDay}
          managementMode
          consultants={rows.map((r) => ({ userId: r.userId, name: r.name }))}
          capacity={capacity}
          onCapacityChange={changeCapacity}
          onCapacitySave={saveCapacity}
          capSavedId={capSavedId}
          initialCapOpen={capFocusUser}
          onClose={() => { setCapFocusUser(null); closeSettings(); }}
        />
      )}

{tab === "team" ? (<>
      <div className="mg-kpis">
        <div className="mg-kpi mg-kpi-ring-card">
          <div className="mg-kpi-ring">
            <svg viewBox="0 0 80 80" width="80" height="80">
              <defs>
                <linearGradient id="mgGradDays" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#86efc0" />
                  <stop offset="100%" stopColor="#0a6f4d" />
                </linearGradient>
              </defs>
              <g transform="rotate(-90 40 40)">
                <circle cx="40" cy="40" r={RING_R} className="mg-ring-bg" />
                <circle cx="40" cy="40" r={RING_R} className="mg-ring-proj" style={ring(dayProjPct)} />
                <circle cx="40" cy="40" r={RING_R} className="mg-ring-fg" stroke="url(#mgGradDays)" style={ring(dayPct)} />
              </g>
              <text x="40" y="38" className="mg-ring-num" textAnchor="middle">
                {Math.round(dayPct)}<tspan className="mg-ring-pct">%</tspan>
              </text>
              <text x="40" y="53" className="mg-ring-cap" textAnchor="middle">of goal</text>
            </svg>
          </div>
          <div className="mg-kpi-body">
            <span className="mg-kpi-label">Days delivered</span>
            <span className="mg-kpi-fig">
              <b>{totalDays.toFixed(2)}</b>
              <em>days</em>
            </span>
            <span className="mg-kpi-meta">
              <span className="mg-kpi-planned"><i /> +{totalDaysPlanned.toFixed(2)} planned</span>
              <span className="mg-kpi-goal">Goal {teamDayGoal > 0 ? (+teamDayGoal.toFixed(2)).toLocaleString() : "—"}</span>
            </span>
          </div>
        </div>

        <div className="mg-kpi mg-kpi-ring-card">
          <div className="mg-kpi-ring">
            <svg viewBox="0 0 80 80" width="80" height="80">
              <defs>
                <linearGradient id="mgGradMoney" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#4ad991" />
                  <stop offset="100%" stopColor="#0a6f4d" />
                </linearGradient>
              </defs>
              <g transform="rotate(-90 40 40)">
                <circle cx="40" cy="40" r={RING_R} className="mg-ring-bg" />
                <circle cx="40" cy="40" r={RING_R} className="mg-ring-proj" style={ring(moneyProjPct)} />
                <circle cx="40" cy="40" r={RING_R} className="mg-ring-fg" stroke="url(#mgGradMoney)" style={ring(moneyPct)} />
              </g>
              <text x="40" y="38" className="mg-ring-num" textAnchor="middle">
                {Math.round(moneyPct)}<tspan className="mg-ring-pct">%</tspan>
              </text>
              <text x="40" y="53" className="mg-ring-cap" textAnchor="middle">of goal</text>
            </svg>
          </div>
          <div className="mg-kpi-body">
            <span className="mg-kpi-label">Billed</span>
            <span className="mg-kpi-fig">
              <b>{Math.round(totalDone).toLocaleString()}</b>
              <em>€</em>
            </span>
            <span className="mg-kpi-meta">
              <span className="mg-kpi-planned"><i /> +{Math.round(totalPlanned).toLocaleString()} planned</span>
              <span className="mg-kpi-goal">Goal {teamMoneyGoal > 0 ? teamMoneyGoal.toLocaleString() : "—"}</span>
            </span>
          </div>
        </div>

        <div className="mg-kpi mg-kpi-chart">
          <div className="mg-kpi-body">
            <span className="mg-kpi-label">Billing over the period</span>
            <span className="mg-kpi-fig">
              <b>{Math.round(totalDone + totalPlanned).toLocaleString()}</b>
              <em>booked in total</em>
            </span>
          </div>
          <div className="mg-spark">
            {buckets.map((b, i) => (
              <span className="mg-spark-col" key={i} title={`${b.label}: ${Math.round(b.done).toLocaleString()} billed`}>
                <span className="mg-spark-stack">
                  <span className="mg-spark-plan" style={{ height: `${(b.planned / peak) * 100}%` }} />
                  <span className="mg-spark-done" style={{ height: `${(b.done / peak) * 100}%` }} />
                </span>
                <span className="mg-spark-label">{b.label}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="mg-kpi mg-kpi-team">
          <div className="mg-kpi-body">
            <span className="mg-kpi-label">On target</span>
            <span className="mg-kpi-fig">
              <b>{onTarget}</b>
              <em>of {rows.length} consultants</em>
            </span>
          </div>
          <div className="mg-dots">
            {rows.map((r) => {
              const g = goalsFor(r.userId);
              const hit = g.money > 0 && r.amountDone >= g.money;
              const p = g.money > 0 ? Math.min(100, (r.amountDone / g.money) * 100) : 0;
              return (
                <span className={`mg-dot ${hit ? "is-hit" : ""}`} key={r.userId} title={`${r.name} — ${Math.round(p)}%`}>
                  <span className="mg-dot-fill" style={{ height: `${p}%` }} />
                  <span className="mg-dot-initial">{r.name.charAt(0).toUpperCase()}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>



      {loading ? (
        <p className="mg-hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mg-hint">No consultants found.</p>
      ) : (
        <div className="mg-list">
          {rows.map((r) => {
            const open = expanded === r.userId;
            const daysTotal = r.daysDone + r.daysPlanned;
            const moneyTotal = r.amountDone + r.amountPlanned;
            const g = goalsFor(r.userId);
            const dayGoalU = g.days;
            const moneyGoalU = g.money;
            const dayGoalHigh = g.daysHigh;
            const moneyGoalHigh = g.moneyHigh;
            // Scale to the high goal when it exists, so both markers fit on the bar.
            const dayScale = Math.max(dayGoalHigh, dayGoalU, daysTotal, 1);
            const moneyScale = Math.max(moneyGoalHigh, moneyGoalU, moneyTotal, 1);
            const dayPctU = dayGoalU > 0 ? (r.daysDone / dayGoalU) * 100 : null;
            const moneyPctU = moneyGoalU > 0 ? (r.amountDone / moneyGoalU) * 100 : null;
            return (
              <div className={`mg-row ${open ? "is-open" : ""}`} key={r.userId}>
                <button className="mg-row-main" onClick={() => setExpanded(open ? null : r.userId)}>
                  <span className="mg-who">
                    <span className="mg-av">{r.name.charAt(0).toUpperCase()}</span>
                    <span className="mg-who-txt">
                      <span className="mg-name">{r.name}</span>
                      <span className="mg-sub">
                        {new Set(Object.keys(r.byProject).map((k) => k.split("|")[0])).size} projects
                      </span>
                    </span>
                    <span
                      className={`mg-target-btn ${g.custom ? "is-custom" : ""}`}
                      role="button"
                      title={g.custom ? "Custom targets" : "Set personal targets"}
                      onClick={(ev) => { ev.stopPropagation(); setCapFocusUser(r.userId); setShowSettings(true); }}
                    >◎</span>
                  </span>

                  <span className="mg-metric">
                    <span className="mg-metric-head">
                      <span className="mg-metric-label">Days</span>
                      <span className={`mg-metric-pct ${dayPctU === null ? "is-none" : dayPctU >= 100 ? "is-hit" : ""}`}>
                        {dayPctU === null ? "—" : `${Math.round(dayPctU)}%`}
                      </span>
                    </span>
                    <span className="mg-metric-nums">
                      <b>{r.daysDone.toFixed(2)}</b>
                      {r.daysPlanned > 0 && <em>+{r.daysPlanned.toFixed(2)}</em>}
                      {dayGoalU > 0 && (
                        <u className={r.daysDone >= dayGoalU ? "is-hit" : ""}><s /> {dayGoalU}</u>
                      )}
                      {dayGoalHigh > 0 && (
                        <u className={`is-high ${r.daysDone >= dayGoalHigh ? "is-hit" : ""}`}><s /> {dayGoalHigh}</u>
                      )}
                    </span>
                    <span className="mg-mbar">
                      <span className="mg-track">
                        <span className="mg-seg-done" style={{ width: `${pct(r.daysDone, dayScale)}%` }} />
                        <span className="mg-seg-plan" style={{ width: `${pct(r.daysPlanned, dayScale)}%` }} />
                      </span>
                      {dayGoalU > 0 && (
                        <span
                          className={`mg-goal ${r.daysDone >= dayGoalU ? "is-hit" : ""}`}
                          style={{ left: `${pct(dayGoalU, dayScale)}%` }}
                          title={`Min ${dayGoalU} days`}
                        />
                      )}
                      {dayGoalHigh > 0 && (
                        <span
                          className={`mg-goal is-high ${r.daysDone >= dayGoalHigh ? "is-hit" : ""}`}
                          style={{ left: `${pct(dayGoalHigh, dayScale)}%` }}
                          title={`High ${dayGoalHigh} days`}
                        />
                      )}
                    </span>
                  </span>

                  <span className="mg-metric">
                    <span className="mg-metric-head">
                      <span className="mg-metric-label">Billing</span>
                      <span className={`mg-metric-pct ${moneyPctU === null ? "is-none" : moneyPctU >= 100 ? "is-hit" : ""}`}>
                        {moneyPctU === null ? "—" : `${Math.round(moneyPctU)}%`}
                      </span>
                    </span>
                    <span className="mg-metric-nums">
                      <b>{Math.round(r.amountDone).toLocaleString()}</b>
                      {r.amountPlanned > 0 && <em>+{Math.round(r.amountPlanned).toLocaleString()}</em>}
                      {moneyGoalU > 0 && (
                        <u className={r.amountDone >= moneyGoalU ? "is-hit" : ""}><s /> {moneyGoalU.toLocaleString()}</u>
                      )}
                      {moneyGoalHigh > 0 && (
                        <u className={`is-high ${r.amountDone >= moneyGoalHigh ? "is-hit" : ""}`}><s /> {moneyGoalHigh.toLocaleString()}</u>
                      )}
                    </span>
                    <span className="mg-mbar">
                      <span className="mg-track">
                        <span className="mg-seg-done" style={{ width: `${pct(r.amountDone, moneyScale)}%` }} />
                        <span className="mg-seg-plan" style={{ width: `${pct(r.amountPlanned, moneyScale)}%` }} />
                      </span>
                      {moneyGoalU > 0 && (
                        <span
                          className={`mg-goal ${r.amountDone >= moneyGoalU ? "is-hit" : ""}`}
                          style={{ left: `${pct(moneyGoalU, moneyScale)}%` }}
                          title={`Min ${moneyGoalU.toLocaleString()}`}
                        />
                      )}
                      {moneyGoalHigh > 0 && (
                        <span
                          className={`mg-goal is-high ${r.amountDone >= moneyGoalHigh ? "is-hit" : ""}`}
                          style={{ left: `${pct(moneyGoalHigh, moneyScale)}%` }}
                          title={`High ${moneyGoalHigh.toLocaleString()}`}
                        />
                      )}
                    </span>
                  </span>

                  <span className={`mg-chev ${open ? "is-open" : ""}`}>›</span>
                </button>

                {open && (
                  <div className="mg-detail">
                    {(() => {
                      const ins = insightsFor(r.userId);
                      const maxTrend = Math.max(1, ...ins.trend.map((t) => t.amount));
                      const utilSlices = [
                        { key: "bill", label: "Billable", days: ins.billableDays, color: "var(--forest)" },
                        { key: "unbilled", label: "Client · unbilled", days: ins.clientUnbilledDays, color: "#e0a03e" },
                        { key: "internal", label: "Internal", days: ins.internalDays, color: "#8aa0b5" },
                        { key: "idle", label: "Idle / available", days: ins.idleDays, color: "rgba(10,111,77,0.1)" },
                      ].filter((s) => s.days > 0.01);
                      // Bar is measured against available capacity when we know it, else against worked time.
                      const barBase = ins.availableDays > 0 ? ins.availableDays : (ins.totalWorked || 1);
                      // Two "realised" bonuses: one on work done this month (real date),
                      // one on what was invoiced to the client this month (follows moved billing).
                      const cap = capacity[r.userId];
                      const bonusWork = computeBonus(ins.billableAmount, ins.billableDays, cap);
                      const bonusInvoiced = computeBonus(ins.invoicedAmount, ins.invoicedDays, cap);
                      const showBonus = !!cap && (cap.minDays != null || cap.minBilling != null || cap.bonusPct1 != null);
                      return (
                        <div className="mg-insights">
                          {/* Row of headline metric cards */}
                          <div className="mg-ins-cards">
                            <div className="mg-ins-card">
                              <span className="mg-ins-k">Billed this period</span>
                              <b className="mg-ins-v">{Math.round(ins.billableAmount).toLocaleString()} €</b>
                              <span className="mg-ins-s">{ins.billableDays.toFixed(2)} billable days</span>
                            </div>
                            <div className="mg-ins-card">
                              <span className="mg-ins-k">Blended rate</span>
                              <b className="mg-ins-v">{Math.round(ins.blendedRate).toLocaleString()} €</b>
                              <span className="mg-ins-s">avg per billed day</span>
                            </div>
                            <div className="mg-ins-card">
                              <span className="mg-ins-k">Avg / week</span>
                              <b className="mg-ins-v">{Math.round(ins.avgAmountWeek).toLocaleString()} €</b>
                              <span className="mg-ins-s">{ins.avgDaysWeek.toFixed(2)} d/wk</span>
                            </div>
                            <div className="mg-ins-card">
                              <span className="mg-ins-k">Avg / month</span>
                              <b className="mg-ins-v">{Math.round(ins.avgAmountMonth).toLocaleString()} €</b>
                              <span className="mg-ins-s">{ins.avgDaysMonth.toFixed(2)} d/mo</span>
                            </div>
                            {ins.availableDays > 0 && (
                              <div className="mg-ins-card">
                                <span className="mg-ins-k">Capacity used</span>
                                <b className="mg-ins-v">{Math.round(ins.capUtilisation)}%</b>
                                <span className="mg-ins-s">{ins.billableDays.toFixed(1)} / {ins.availableDays.toFixed(1)} days</span>
                              </div>
                            )}
                          </div>

                          {showBonus && (
                            <div className="bwrap">
                              <div className="bwrap-head">
                                <span className="bwrap-title">Bonus</span>
                                <span className="bwrap-lag">Paid on invoiced · {bonusLag}-month lag</span>
                              </div>
                              <div className="bwrap-cards">
                                <div className={`bcard ${bonusWork.tier === 2 ? "t2" : bonusWork.tier === 1 ? "t1" : "t0"}`}>
                                  <span className="bcard-k">On work done</span>
                                  <b className="bcard-amt">{Math.round(bonusWork.amount).toLocaleString()} €</b>
                                  <span className="bcard-base">{ins.billableDays.toFixed(1)}d · {Math.round(ins.billableAmount).toLocaleString()} € worked</span>
                                  <span className="bcard-badge">{bonusWork.tier === 2 ? "High tier" : bonusWork.tier === 1 ? "Minimum tier" : "Below minimum"}</span>
                                </div>
                                <div className={`bcard ${bonusInvoiced.tier === 2 ? "t2" : bonusInvoiced.tier === 1 ? "t1" : "t0"}`}>
                                  <span className="bcard-k">On invoiced</span>
                                  <b className="bcard-amt">{Math.round(bonusInvoiced.amount).toLocaleString()} €</b>
                                  <span className="bcard-base">{ins.invoicedDays.toFixed(1)}d · {Math.round(ins.invoicedAmount).toLocaleString()} € invoiced</span>
                                  <span className="bcard-badge">{bonusInvoiced.tier === 2 ? "High tier" : bonusInvoiced.tier === 1 ? "Minimum tier" : "Below minimum"}</span>
                                </div>
                              </div>
                              {(cap?.minBilling != null || cap?.highBilling != null) && (() => {
                                const minB = cap?.minBilling ?? 0;
                                const highB = cap?.highBilling ?? 0;
                                const scaleB = Math.max(highB, minB, ins.invoicedAmount, 1);
                                return (
                                  <div className="bprog">
                                    <div className="bprog-head">
                                      <span>Invoiced toward targets</span>
                                      <b>{Math.round(ins.invoicedAmount).toLocaleString()} €</b>
                                    </div>
                                    <div className="bprog-track">
                                      <div className="bprog-fill" style={{ width: `${Math.min(100, (ins.invoicedAmount / scaleB) * 100)}%` }} />
                                      {minB > 0 && <span className="bprog-mark min" style={{ left: `${(minB / scaleB) * 100}%` }} title={`Min ${Math.round(minB).toLocaleString()} €`} />}
                                      {highB > 0 && <span className="bprog-mark high" style={{ left: `${(highB / scaleB) * 100}%` }} title={`High ${Math.round(highB).toLocaleString()} €`} />}
                                    </div>
                                    <div className="bprog-legend">
                                      {minB > 0 && <span className={ins.invoicedAmount >= minB ? "ok" : ""}><i className="min" />Min {Math.round(minB).toLocaleString()} €{cap?.minDays != null ? ` · ${cap.minDays}d` : ""}</span>}
                                      {highB > 0 && <span className={ins.invoicedAmount >= highB ? "ok" : ""}><i className="high" />High {Math.round(highB).toLocaleString()} €{cap?.highDays != null ? ` · ${cap.highDays}d` : ""}</span>}
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          )}

                          <div className="mg-ins-mid">
                            {/* Utilisation bar */}
                            <div className="mg-ins-block">
                              <div className="mg-ins-blockhead">
                                <span className="mg-ins-blocktitle">Utilisation</span>
                                <span className="mg-ins-util-pct">
                                  {ins.availableDays > 0
                                    ? `${Math.round(ins.capUtilisation)}% of capacity billable`
                                    : `${Math.round(ins.utilisation)}% billable`}
                                </span>
                              </div>
                              <div className="mg-util-bar">
                                {utilSlices.map((s) => (
                                  <span
                                    key={s.key}
                                    className="mg-util-seg"
                                    style={{ width: `${(s.days / barBase) * 100}%`, background: s.color }}
                                    title={`${s.label}: ${s.days.toFixed(2)}d`}
                                  />
                                ))}
                              </div>
                              <div className="mg-util-legend">
                                {utilSlices.map((s) => (
                                  <span className="mg-util-li" key={s.key}>
                                    <i style={{ background: s.color }} />
                                    {s.label} <b>{s.days.toFixed(2)}d</b>
                                  </span>
                                ))}
                              </div>
                              <p className="mg-ins-note">
                                {ins.availableDays > 0
                                  ? `${ins.billableDays.toFixed(2)} of ${ins.availableDays.toFixed(1)} available days billed · ${Math.round(ins.occupancy)}% occupied${ins.clientUnbilledDays > 0 ? ` · ${ins.clientUnbilledDays.toFixed(2)}d client work unbilled` : ""}`
                                  : ins.clientUnbilledDays > 0
                                    ? `${ins.clientUnbilledDays.toFixed(2)}d of client work went unbilled.`
                                    : "All client work is billed."}
                              </p>
                            </div>

                            {/* Trend mini-chart */}
                            <div className="mg-ins-block">
                              <div className="mg-ins-blockhead">
                                <span className="mg-ins-blocktitle">Billing trend</span>
                                <span className="mg-ins-blocksub">{ins.trend.length} periods</span>
                              </div>
                              {ins.trend.length === 0 ? (
                                <p className="mg-ins-note">No billed work in range.</p>
                              ) : (
                                <div className="mg-trend">
                                  {ins.trend.map((t, i) => (
                                    <div className="mg-trend-col" key={i} title={`${t.label}: ${Math.round(t.amount).toLocaleString()} € · ${t.days.toFixed(2)}d`}>
                                      <div className="mg-trend-barwrap">
                                        <div className="mg-trend-bar" style={{ height: `${(t.amount / maxTrend) * 100}%` }} />
                                      </div>
                                      <span className="mg-trend-x">{t.label}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {Object.keys(r.byProject).length === 0 ? (
                      <p className="mg-hint-sm">Nothing logged in this period.</p>
                    ) : (
                      <>
                        <div className="mg-dhead">
                          <span>Client &amp; project</span>
                          <span className="mg-r">Rate / day</span>
                          <span className="mg-r">Booked</span>
                          <span className="mg-r">Billed</span>
                        </div>
                        {Object.entries(r.byProject).map(([key, v]) => {
                          const projId = key.split("|")[0];
                          const kind = key.split("|")[1];
                          const rowKey = `${r.userId}|${key}`;
                          const isProjOpen = projOpen === rowKey;
                          // Entries feeding this project×line for this consultant, in scope.
                          const feed = entries
                            .filter((e) =>
                              e.userId === r.userId && e.projectId === projId &&
                              e.status !== "cancelled" && e.line !== "closure" &&
                              inScope(e.date) &&
                              (kind === "Supervision" ? e.line === "supervision"
                                : kind === "Connector" ? e.line === "connector"
                                : (e.line !== "supervision" && e.line !== "connector"))
                            )
                            .sort((a, b) => a.date.localeCompare(b.date));
                          return (
                            <div key={key}>
                              <button className={`mg-dline mg-dline-btn ${isProjOpen ? "is-open" : ""}`} onClick={() => setProjOpen(isProjOpen ? null : rowKey)}>
                                <span className="mg-dclient">
                                  <span className={`mg-dchev ${isProjOpen ? "is-open" : ""}`}>›</span>
                                  <b>{clientNames[projects[projId]?.clientId ?? ""] ?? "—"}</b>
                                  <em>{typeNames[projects[projId]?.typeId ?? ""] || "No project type"}</em>
                                  <span className="mg-dkind">{v.rateKind}</span>
                                </span>
                                <span className="mg-r mg-drate">{Math.round(v.rate).toLocaleString()}</span>
                                <span className="mg-r mg-dbooked">
                                  <b>{Math.round(v.amountPlanned).toLocaleString()}</b>
                                  <i>{v.daysPlanned.toFixed(2)}d</i>
                                </span>
                                <span className="mg-r mg-dbilled">
                                  <b>{Math.round(v.amountDone).toLocaleString()}</b>
                                  <i>{v.daysDone.toFixed(2)}d</i>
                                </span>
                              </button>
                              {isProjOpen && (
                                <div className="mg-dledger">
                                  <div className="mg-dl-head">
                                    <span>Date</span><span>Status</span>
                                    <span className="mg-r">Days</span><span className="mg-r">Value</span>
                                  </div>
                                  {feed.length === 0 ? (
                                    <p className="mg-hint-sm" style={{ padding: "6px 12px" }}>No entries.</p>
                                  ) : feed.map((e) => (
                                    <div className="mg-dl-row" key={e.id}>
                                      <span className="mg-dl-date">
                                        {e.date}
                                        {e.billingPeriod && <span className="mg-dl-moved">→ {e.billingPeriod}</span>}
                                      </span>
                                      <span className={`mg-dl-status is-${e.status}`}>{e.status}</span>
                                      <span className="mg-r">{e.billable.toFixed(2)}</span>
                                      <span className="mg-r">{Math.round(e.billable * v.rate).toLocaleString()} €</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </>) : tab === "backlog" ? (
        <BacklogPanel
          entries={entries}
          projects={projects}
          clientNames={clientNames}
          typeNames={typeNames}
          people={people}
          supRoles={supRoles}
          scope={scope}
          anchor={anchor}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
        />
      ) : tab === "billing" ? (
        <BillingPanel
          entries={entries}
          projects={projects}
          clientNames={clientNames}
          typeNames={typeNames}
          people={people}
          supRoles={supRoles}
          cutoffs={cutoffs}
          defaultCutoffDay={defaultCutoffDay}
        />
      ) : (
        <BonusPanel
          entries={entries.map((e) => ({
            id: e.id, userId: e.userId, projectId: e.projectId, date: e.date,
            billable: e.billable, status: e.status, line: e.line, typeId: e.typeId,
            billingPeriod: e.billingPeriod,
          }))}
          projects={projects}
          people={people}
          clientNames={clientNames}
          capacity={capacity}
          clientTypeIds={clientTypeIds}
          supRoles={supRoles}
          cutoffs={cutoffs}
          defaultCutoffDay={defaultCutoffDay}
          bonusLag={bonusLag}
          anchor={anchor}
        />
      )}
    </div>
  );
}