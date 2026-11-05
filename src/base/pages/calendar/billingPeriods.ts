/**
 * Billing-period maths, shared by the calendar, management panels and home page
 * so they all agree on where a month starts and ends.
 *
 * A "billing month" is not the natural calendar month. It runs from the previous
 * month's cutoff date (EXCLUSIVE) to this month's cutoff date (INCLUSIVE):
 *
 *   window(P) = ( cutoff(P-1),  cutoff(P) ]
 *
 * Example — June cutoff = 23rd, July cutoff = 22nd:
 *   window("2026-07") = ("2026-06-23", "2026-07-22"]
 *   → includes 24–30 June, excludes 23–31 July.
 */

/** Map of 'YYYY-MM' → 'YYYY-MM-DD' explicit cutoffs. */
export type Cutoffs = Record<string, string>;

const pad = (n: number) => String(n).padStart(2, "0");

/** 'YYYY-MM' of the month before the given period. */
export function prevPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** 'YYYY-MM' for a Date. */
export function periodOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/**
 * The cutoff date ('YYYY-MM-DD') for a period. Uses an explicit override when
 * present, otherwise the default day of month (defaultDay = 0 → last day).
 */
export function cutoffOf(period: string, cutoffs: Cutoffs, defaultDay = 0): string {
  const explicit = cutoffs[period];
  if (explicit) return explicit;
  const [y, m] = period.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last of this
  const day = defaultDay > 0 ? Math.min(defaultDay, lastDay) : lastDay;
  return `${y}-${pad(m)}-${pad(day)}`;
}

/** The (from, to] window for a period, both as 'YYYY-MM-DD'. from is exclusive, to inclusive. */
export function billingWindow(period: string, cutoffs: Cutoffs, defaultDay = 0): { from: string; to: string } {
  return {
    from: cutoffOf(prevPeriod(period), cutoffs, defaultDay),
    to: cutoffOf(period, cutoffs, defaultDay),
  };
}

/** Is an ISO date (YYYY-MM-DD) inside the billing month for `period`? */
export function inBillingMonth(iso: string, period: string, cutoffs: Cutoffs, defaultDay = 0): boolean {
  if (!iso) return false;
  const { from, to } = billingWindow(period, cutoffs, defaultDay);
  return iso > from && iso <= to; // exclusive lower, inclusive upper
}

/** Which billing period an ISO date falls into — useful for grouping. */
export function periodForDate(iso: string, cutoffs: Cutoffs, defaultDay = 0): string {
  // Natural month is the starting guess; a date after this month's cutoff rolls
  // into next month's period, and a date on/before last month's cutoff is rare
  // but handled by walking one step.
  const [y, m] = iso.split("-").map(Number);
  let period = `${y}-${pad(m)}`;
  if (iso > cutoffOf(period, cutoffs, defaultDay)) {
    // after this month's cutoff → next period
    period = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }
  return period;
}