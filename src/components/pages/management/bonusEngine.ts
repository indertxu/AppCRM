/**
 * Bonus engine — pure functions, no React, no database.
 *
 * A PLAN says who it applies to, the months it runs (from a start month, and
 * optionally until an end month), how long each bonus period is (any number of
 * months — 1, 3, 6, 12 or custom, counted from the start month), how many months
 * after a period closes it's paid, and its TIERS.
 *
 * A TIER has conditions (billing €, billable days, hours worked — every condition
 * that's switched on must be met), a reward (a % of the period's billing or a fixed
 * amount) and, optionally, the periods of the year it applies to (e.g. a lower
 * target only in Q3). The best tier reached in a period is paid on the whole period.
 *
 * Months are BILLING months ("YYYY-MM", as set by the cutoffs). A period is named
 * by its first month ("2026-07" for a 3-month period Jul–Sep).
 */

export type Metric = "billing" | "days" | "hours";
export const METRICS: Metric[] = ["billing", "days", "hours"];
export const METRIC_LABEL: Record<Metric, string> = { billing: "Billing", days: "Billable days", hours: "Hours worked" };
export const EVERY_PRESETS = [1, 3, 6, 12] as const;
export const everyLabel = (n: number) => (n === 1 ? "Monthly" : n === 12 ? "Yearly" : `Every ${n} months`);

export interface Tier {
  id: string;
  name: string;
  /** Thresholds; a missing/null metric isn't a condition. */
  conditions: Partial<Record<Metric, number | null>>;
  reward: { type: "pct" | "fixed"; value: number };
  /** Calendar months (1–12) whose periods this tier applies to — a period counts by
      its first month. Missing or empty = every period. */
  months?: number[];
}
export interface Who { everyone: boolean; roles: string[]; departments: string[]; people: string[] }
export interface Plan {
  id: string;
  name: string;
  active: boolean;
  /** Length of a bonus period in months (1 = monthly, 3 = quarterly, … any number). */
  every: number;
  /** First month the plan counts ("YYYY-MM"); periods are counted from here. */
  start: string;
  /** Last month the plan counts, or null for no end. */
  end: string | null;
  /** Months after a period closes that it's paid: 1 = the month right after, 0 = its last month. */
  delay: number;
  who: Who;
  tiers: Tier[];
}
export interface Person { id: string; name: string; role: string | null; department: string | null }
/** One person's activity in one billing month. */
export interface MonthActivity { billing: number; days: number; hours: number; byClient: Record<string, { name: string; billing: number; days: number }> }
export type ActivityIndex = Record<string, Record<string, MonthActivity>>; // userId -> "YYYY-MM" -> activity

/* ─────────────── months ─────────────── */

export const shiftMonth = (ym: string, by: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
export const monthsBetween = (a: string, b: string) => {
  const [ay, am] = a.split("-").map(Number), [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
};
export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (ym: string, long = false) => { const [y, m] = ym.split("-").map(Number); return `${(long ? MONTH_LONG : MONTH_SHORT)[m - 1]} ${y}`; };
const monthNum = (ym: string) => Number(ym.slice(5, 7));

/* ─────────────── periods (defined by the plan) ─────────────── */

/** First month of the period that contains `ym`, or null if the plan doesn't run then. */
export function periodStart(plan: Plan, ym: string): string | null {
  if (ym < plan.start || (plan.end && ym > plan.end)) return null;
  const n = Math.max(1, plan.every);
  return shiftMonth(plan.start, Math.floor(monthsBetween(plan.start, ym) / n) * n);
}
/** The months a period is made of (cut at the plan's end month). */
export function periodMonths(plan: Plan, first: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, plan.every); i++) {
    const ym = shiftMonth(first, i);
    if (plan.end && ym > plan.end) break;
    out.push(ym);
  }
  return out;
}
export const periodLast = (plan: Plan, first: string) => periodMonths(plan, first).slice(-1)[0] ?? first;
export const prevPeriod = (plan: Plan, first: string): string | null => {
  const p = shiftMonth(first, -Math.max(1, plan.every));
  return p < plan.start ? null : p;
};
/** The month the bonus for a period is paid in. */
export const payMonth = (plan: Plan, first: string) => shiftMonth(periodLast(plan, first), Math.max(0, plan.delay));
/** Human name of a period: "October 2026", "Q3 2026", "1st half 2026", "2026" or "Nov 2026 – Jan 2027". */
export function periodLabel(plan: Plan, first: string): string {
  const n = plan.every, m = monthNum(first), y = first.slice(0, 4);
  const last = periodLast(plan, first);
  if (n === 1) return monthLabel(first, true);
  if (n === 3 && (m - 1) % 3 === 0 && last === shiftMonth(first, 2)) return `Q${(m - 1) / 3 + 1} ${y}`;
  if (n === 6 && (m === 1 || m === 7) && last === shiftMonth(first, 5)) return `${m === 1 ? "1st" : "2nd"} half ${y}`;
  if (n === 12 && m === 1 && last === shiftMonth(first, 11)) return y;
  if (first.slice(0, 4) === last.slice(0, 4)) return `${MONTH_SHORT[m - 1]} – ${monthLabel(last)}`;
  return `${monthLabel(first)} – ${monthLabel(last)}`;
}
/** The key the first version of the bonus page used for the same period (to recognise payments made then). */
export function legacyKey(plan: Plan, first: string): string | null {
  const n = plan.every, m = monthNum(first), y = first.slice(0, 4);
  if (n === 1) return first;
  if (n === 3 && (m - 1) % 3 === 0) return `${y}-Q${(m - 1) / 3 + 1}`;
  if (n === 6 && (m === 1 || m === 7)) return `${y}-H${m === 1 ? 1 : 2}`;
  if (n === 12 && m === 1) return y;
  return null;
}

/**
 * The periods of one year of the plan, for choosing which ones a tier applies to.
 * When the period length divides 12 they repeat every year (Q1…Q4, Jan…Dec, H1/H2):
 * one slot each, listing its calendar months. Otherwise null — pick by month instead.
 */
export function yearSlots(plan: Plan): { label: string; months: number[] }[] | null {
  const n = Math.max(1, plan.every);
  if (12 % n !== 0) return null;
  const startM = monthNum(plan.start);
  const slots: { label: string; months: number[] }[] = [];
  for (let k = 0; k < 12 / n; k++) {
    const months = Array.from({ length: n }, (_, i) => ((startM - 1 + k * n + i) % 12) + 1);
    const label = n === 1 ? MONTH_SHORT[months[0] - 1]
      : n === 12 ? "Whole year"
      : n === 3 && (startM - 1) % 3 === 0 ? `Q${Math.floor((months[0] - 1) / 3) + 1}`
      : n === 6 && (startM === 1 || startM === 7) ? (months[0] === 1 ? "1st half" : "2nd half")
      : `${MONTH_SHORT[months[0] - 1]}–${MONTH_SHORT[months[months.length - 1] - 1]}`;
    slots.push({ label, months });
  }
  return slots.sort((a, b) => a.months[0] - b.months[0]);
}
/** Does a tier count in the period starting at `first`? */
export const tierApplies = (t: Tier, first: string) => !t.months || t.months.length === 0 || t.months.includes(monthNum(first));

/* ─────────────── who gets which plan ─────────────── */

/** How specifically a plan names this person (0 = not at all). People > department > role > everyone. */
export function matchStrength(plan: Plan, p: Person): number {
  if (!plan.active) return 0;
  if (plan.who.people.includes(p.id)) return 4;
  if (p.department && plan.who.departments.includes(p.department)) return 3;
  if (p.role && plan.who.roles.includes(p.role)) return 2;
  if (plan.who.everyone) return 1;
  return 0;
}
/**
 * The plan that applies to a person in a given month: the most specific active plan
 * running that month. When two plans are equally specific, the one that has tiers for
 * that period wins (e.g. a "Q3" plan next to a plan whose tiers skip Q3).
 */
export function planFor(plans: Plan[], p: Person, ym?: string): Plan | null {
  let best: Plan | null = null, bestS = 0;
  for (const pl of plans) {
    const first = ym ? periodStart(pl, ym) : null;
    if (ym && first === null) continue;
    const strength = matchStrength(pl, p);
    if (!strength) continue;
    const hasTiers = !first || pl.tiers.some((t) => activeConditions(t).length > 0 && tierApplies(t, first));
    const s = strength * 2 + (hasTiers ? 1 : 0);
    if (s > bestS) { best = pl; bestS = s; }
  }
  return best;
}

/* ─────────────── tiers ─────────────── */

export const tierPayout = (t: Tier, billing: number) => (t.reward.type === "pct" ? (billing * (t.reward.value || 0)) / 100 : t.reward.value || 0);
export const activeConditions = (t: Tier) => METRICS.filter((m) => t.conditions[m] != null && !Number.isNaN(Number(t.conditions[m])));
export const tierMet = (t: Tier, a: { billing: number; days: number; hours: number }) =>
  activeConditions(t).length > 0 && activeConditions(t).every((m) => a[m] >= Number(t.conditions[m]));

export interface Evaluation {
  tier: Tier | null;
  amount: number;
  next: { tier: Tier; gaps: Partial<Record<Metric, number>>; amount: number } | null;
}
/** Best tier reached (only tiers that apply to this period, when `first` is given). */
export function evaluate(plan: Plan, a: { billing: number; days: number; hours: number }, first?: string): Evaluation {
  const tiers = plan.tiers.filter((t) => activeConditions(t).length > 0 && (!first || tierApplies(t, first)));
  let best: Tier | null = null, bestAmt = 0;
  for (const t of tiers) if (tierMet(t, a)) { const v = tierPayout(t, a.billing); if (!best || v > bestAmt) { best = t; bestAmt = v; } }
  let next: Evaluation["next"] = null, nextScore = Infinity;
  for (const t of tiers) {
    if (tierMet(t, a)) continue;
    const gaps: Partial<Record<Metric, number>> = {};
    let score = 0;
    for (const m of activeConditions(t)) {
      const need = Number(t.conditions[m]);
      const miss = Math.max(0, need - a[m]);
      if (miss > 0) { gaps[m] = miss; score += need > 0 ? miss / need : 1; }
    }
    const projected = tierPayout(t, Math.max(a.billing, Number(t.conditions.billing ?? 0)));
    if (projected <= bestAmt) continue;
    if (score < nextScore) { next = { tier: t, gaps, amount: projected }; nextScore = score; }
  }
  return { tier: best, amount: bestAmt, next };
}

/** A person's totals over a whole period (sums its billing months inside the plan). */
export function periodActivity(idx: ActivityIndex, userId: string, plan: Plan, first: string): MonthActivity {
  const out: MonthActivity = { billing: 0, days: 0, hours: 0, byClient: {} };
  for (const ym of periodMonths(plan, first)) {
    const a = idx[userId]?.[ym];
    if (!a) continue;
    out.billing += a.billing; out.days += a.days; out.hours += a.hours;
    for (const [cid, c] of Object.entries(a.byClient)) {
      const t = (out.byClient[cid] ??= { name: c.name, billing: 0, days: 0 });
      t.billing += c.billing; t.days += c.days;
    }
  }
  return out;
}

/* ─────────────── storage + starting from the old rules ─────────────── */

const FREQ_TO_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
/** A row of bonus_plans (any version) → Plan. */
export function planFromRow(r: any): Plan {
  const every = Number(r.period_months) || FREQ_TO_MONTHS[r.frequency] || 1;
  const created = String(r.created_at ?? new Date().toISOString());
  return {
    id: r.id, name: r.name ?? "Bonus plan", active: r.active !== false, every,
    start: r.start_month || `${created.slice(0, 4)}-01`, end: r.end_month || null,
    delay: Number(r.pay_delay_months ?? 1),
    who: { everyone: !!r.who?.everyone, roles: r.who?.roles ?? [], departments: r.who?.departments ?? [], people: r.who?.people ?? [] },
    tiers: Array.isArray(r.tiers) ? r.tiers : [],
  };
}
export function planToRow(p: Plan) {
  const freq = Object.entries(FREQ_TO_MONTHS).find(([, n]) => n === p.every)?.[0] ?? "custom";
  return {
    name: p.name, active: p.active, frequency: freq, period_months: p.every, start_month: p.start, end_month: p.end,
    pay_delay_months: p.delay, who: p.who, tiers: p.tiers, updated_at: new Date().toISOString(),
  };
}
/** Old per-person/company settings → a plan's tiers (min tier + high tier, % of billing). */
export function tiersFromLegacy(c: any, uid: () => string): Tier[] {
  if (!c) return [];
  const tiers: Tier[] = [];
  const cond = (days: any, billing: any) => ({ days: days != null ? Number(days) : null, billing: billing != null ? Number(billing) : null, hours: null });
  if ((c.minDays != null || c.minBilling != null) && c.bonusPct1 != null)
    tiers.push({ id: uid(), name: "Minimum", conditions: cond(c.minDays, c.minBilling), reward: { type: "pct", value: Number(c.bonusPct1) } });
  if ((c.highDays != null || c.highBilling != null) && c.bonusPct2 != null)
    tiers.push({ id: uid(), name: "High", conditions: cond(c.highDays, c.highBilling), reward: { type: "pct", value: Number(c.bonusPct2) } });
  return tiers;
}