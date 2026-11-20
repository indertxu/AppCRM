/* Relative time periods ("This month", "Last 90 days"…) used by filters and exports. */

export type PeriodKey =
  | "all" | "past" | "future" | "today"
  | "this_week" | "last_week" | "next_week"
  | "this_month" | "last_month" | "next_month"
  | "this_quarter" | "last_quarter" | "next_quarter"
  | "this_year" | "last_year" | "next_year" | "ytd"
  | "last_30" | "last_90" | "next_30" | "next_90" | "custom";
export const PERIODS: { key: PeriodKey; label: string; group: string }[] = [
  { key: "all", label: "All time", group: "Any" },
  { key: "this_month", label: "This month", group: "Months" }, { key: "next_month", label: "Next month", group: "Months" }, { key: "last_month", label: "Last month", group: "Months" },
  { key: "this_quarter", label: "This quarter", group: "Quarters" }, { key: "next_quarter", label: "Next quarter", group: "Quarters" }, { key: "last_quarter", label: "Last quarter", group: "Quarters" },
  { key: "this_year", label: "This year", group: "Years" }, { key: "next_year", label: "Next year", group: "Years" }, { key: "last_year", label: "Last year", group: "Years" }, { key: "ytd", label: "Year to date", group: "Years" },
  { key: "this_week", label: "This week", group: "Weeks" }, { key: "next_week", label: "Next week", group: "Weeks" }, { key: "last_week", label: "Last week", group: "Weeks" },
  { key: "next_30", label: "Next 30 days", group: "Rolling" }, { key: "next_90", label: "Next 90 days", group: "Rolling" }, { key: "last_30", label: "Last 30 days", group: "Rolling" }, { key: "last_90", label: "Last 90 days", group: "Rolling" },
  { key: "today", label: "Today", group: "Rolling" }, { key: "past", label: "Before today (overdue)", group: "Open-ended" }, { key: "future", label: "From today on", group: "Open-ended" },
  { key: "custom", label: "Custom dates", group: "Custom" },
];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ─────────────── the report's period (a parameter) ───────────────
   One period per report ("This year", "Q3", two dates…). The figures that depend on a
   period — ARR in the period, revenue in the period, what happened in it (new, renewed…) —
   and any rule set to "the report's period" read it, so changing it re-runs the whole report. */
export interface ReportPeriod { key: string; from?: string | null; to?: string | null }
export const DEFAULT_REPORT_PERIOD: ReportPeriod = { key: "this_year" };
let PARAM: ReportPeriod = DEFAULT_REPORT_PERIOD;
/** Set by the Reports page before it reads any row. */
export const setReportPeriod = (p?: ReportPeriod | null) => { PARAM = p?.key && p.key !== "report" ? p : DEFAULT_REPORT_PERIOD; };
export const reportPeriodNow = () => PARAM;
/** The report's period as [from, to] (null = open on that side). */
export const reportRange = (): [string | null, string | null] => resolvePeriod(PARAM.key, PARAM.from, PARAM.to);
/**
 * [from, to] inclusive ISO dates for a period, computed against TODAY — so a
 * saved report on "This quarter" always shows the current quarter. null = open side.
 */
export function resolvePeriod(key: string, from?: string | null, to?: string | null): [string | null, string | null] {
  const n = new Date(); const y = n.getFullYear(), m = n.getMonth(), d = n.getDate();
  const q = Math.floor(m / 3) * 3;
  const wd = (n.getDay() + 6) % 7; // Monday = 0
  const day = (off: number) => iso(new Date(y, m, d + off));
  switch (key) {
    case "today": return [day(0), day(0)];
    case "past": return [null, day(-1)];
    case "future": return [day(0), null];
    case "this_week": return [day(-wd), day(6 - wd)];
    case "last_week": return [day(-wd - 7), day(-wd - 1)];
    case "next_week": return [day(7 - wd), day(13 - wd)];
    case "this_month": return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
    case "last_month": return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case "next_month": return [iso(new Date(y, m + 1, 1)), iso(new Date(y, m + 2, 0))];
    case "this_quarter": return [iso(new Date(y, q, 1)), iso(new Date(y, q + 3, 0))];
    case "last_quarter": return [iso(new Date(y, q - 3, 1)), iso(new Date(y, q, 0))];
    case "next_quarter": return [iso(new Date(y, q + 3, 1)), iso(new Date(y, q + 6, 0))];
    case "this_year": return [`${y}-01-01`, `${y}-12-31`];
    case "last_year": return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case "next_year": return [`${y + 1}-01-01`, `${y + 1}-12-31`];
    case "ytd": return [`${y}-01-01`, day(0)];
    case "last_30": return [day(-30), day(0)];
    case "last_90": return [day(-90), day(0)];
    case "next_30": return [day(0), day(30)];
    case "next_90": return [day(0), day(90)];
    case "custom": return [from || null, to || null];
    case "report": return reportRange();
    default: return [null, null];
  }
}
export const inPeriod = (date: string | null | undefined, key: string, from?: string | null, to?: string | null) => {
  if (key === "all") return true;
  if (!date) return false;
  const v = String(date).slice(0, 10);
  const [lo, hi] = resolvePeriod(key, from, to);
  return (!lo || v >= lo) && (!hi || v <= hi);
};
export const periodLabel = (key: string) => (key === "report" ? "The report's period" : PERIODS.find((p) => p.key === key)?.label ?? key);
