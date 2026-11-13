/* =====================================================================
   A signed contract's figures, the same everywhere (Clients › Contracts,
   Reports › Contracts): its state (running, in its grace period…), what it
   bills a year today with the yearly increases, which contract year runs,
   how much it went up since year 1 and how much it goes up next.
   Two kinds of contract:
     · built on a deal (tracking_contracts): from its figures (contractFigures)
     · a client's signed products (client_products), grouped by their deal
   ===================================================================== */
import { nowMs, todayIso } from "../../framework/asOf";
import { contractState } from "../sales/extras/ContractView";
import type { ContractFigures } from "../sales/extras/contractsApi";
import { lineAnnualLast, lineAnnualGross, lineYearGross, isActive, renewalOf, lineStartOf, lineAnnual, lineContractValue, type Line } from "./ClientWorkspace";

export const YEAR_MS = 365.25 * 864e5;
/** The same day n calendar years later. */
export const addYearsIso = (d: string, n: number) => { const x = new Date(`${d.slice(0, 10)}T12:00:00`); x.setFullYear(x.getFullYear() + n); return x.toISOString().slice(0, 10); };
/** b over a, in % (0 when there's nothing to compare). */
export const upPct = (a: number, b: number) => (a > 0.5 && b > 0.5 ? (b / a - 1) * 100 : 0);
/** This year's rise and the next one, from the values year by year. */
export const steps = (vals: number[], idx: number, start: string | null) => {
  const stepNow = idx > 0 ? upPct(vals[idx - 1], vals[idx]) : 0;
  const k = vals.findIndex((v, i) => i > idx && upPct(vals[i - 1], v) > 0.05);
  return { stepNow, nextStep: k > 0 && start ? { pct: upPct(vals[k - 1], vals[k]), date: addYearsIso(start, k) } : null };
};

/** A deal contract's recurring value a year, contract year by contract year: its list price for that year (with the
 *  yearly increments) less that year's discounts — the one-offs of year 1 left out. */
export function dealYearly(f: ContractFigures) {
  const n = f.years.length;
  const rec = (i: number) => {
    const y = f.years[i];
    if (!y || y.list <= 0) return 0;
    const recList = y.list - (i === 0 ? f.oneOff : 0);
    return recList > 0 ? (recList / Math.max(y.share, 1e-9)) * (y.net / y.list) : 0;
  };
  const el = (nowMs() - +new Date(f.start)) / YEAR_MS;
  const idx = !n ? 0 : Math.max(0, Math.min(n - 1, Math.floor(el > 0 ? el + 1e-9 : 0)));
  return { now: rec(idx), first: rec(0), yearNo: idx + 1, next: idx + 1 < n ? rec(idx + 1) : null, last: rec(Math.max(0, n - 1)), vals: Array.from({ length: n }, (_, i) => rec(i)) };
}

export interface ContractYearFigures {
  state: string;
  /** What it bills a year today (0 once ended) and what it billed a year on its last running day. */
  perYear: number; lastPerYear: number;
  /** Which contract year runs today (1 while it waits to start), the rise since year 1 and the next one (%). */
  yearNo: number; incSoFar: number; incNext: number | null;
  yearVals: number[]; stepNow: number; nextStep: { pct: number; date: string } | null;
}

/** A contract built on a deal. */
export function dealContractFigures(f: ContractFigures): ContractYearFigures {
  const dy = dealYearly(f);
  const st = contractState(f);
  return {
    state: st, perYear: st === "Ended" ? 0 : dy.now, lastPerYear: st === "Ended" ? dy.last : dy.now,
    yearNo: dy.yearNo, incSoFar: upPct(dy.first, dy.now), incNext: st === "Ended" || dy.next == null ? null : upPct(dy.now, dy.next), yearVals: dy.vals,
    ...steps(dy.vals, dy.yearNo - 1, st === "Ended" ? null : f.start),
  };
}

/** A client's signed products of one deal (or none) as one contract: its dates, value, state and increases. */
export function linesContractFigures(ls: Line[], ct: any): ContractYearFigures & { signed: string | null; start: string | null; end: string | null; renews: boolean; total: number } {
  const now = todayIso();
  const live = ls.filter(isActive);
  const starts = ls.map((l) => lineStartOf(l, ct)).filter(Boolean).sort();
  const renew = live.map((l) => renewalOf(l, ct)).filter((x): x is NonNullable<ReturnType<typeof renewalOf>> => !!x).sort((a, b) => a.end.getTime() - b.end.getTime())[0];
  const signed = String(ct?.signDate || ls.map((l) => l.signing_date).filter(Boolean).sort()[0] || "") || null;
  const start = starts[0] ? String(starts[0]).slice(0, 10) : null;
  const state = !live.length ? "Ended" : start && start > now ? (signed && signed.slice(0, 10) <= now ? "In grace period" : "Not started") : "Running";
  // the yearly increments: year 1's value, today's contract year, and next year's
  const rec = live.filter((l) => l.recurring);
  const t0 = (l: Line) => +new Date(String(l.start_date || l.signing_date || todayIso()).slice(0, 10) + "T12:00:00");
  // the increments read on the price before the partner's cut (a cut that ends isn't an increase)
  const first = rec.reduce((s, l) => s + lineAnnualGross(l, t0(l) + 864e5), 0);
  const nowG = rec.reduce((s, l) => s + lineAnnualGross(l, Math.max(nowMs(), t0(l) + 864e5)), 0);
  const s0 = rec.length ? Math.min(...rec.map(t0)) : nowMs();
  const el = (nowMs() - s0) / YEAR_MS;
  const yearNo = Math.max(1, Math.floor(el > 0 ? el + 1e-9 : 0) + 1);
  // next contract year: each line on the first day of its own next contract year
  const nx = rec.reduce((s, l) => { const e = (nowMs() - t0(l)) / YEAR_MS; const k = Math.max(0, Math.floor(e > 0 ? e + 1e-9 : 0)) + 1; return s + lineAnnualGross(l, t0(l) + k * YEAR_MS + 2 * 864e5); }, 0);
  const nYears = Math.max(0, ...rec.map((l) => Math.ceil((Number(l.term_years) || 1) - 1e-9)));
  const yearVals = Array.from({ length: nYears }, (_, y) => rec.reduce((s, l) => s + (y < Math.ceil((Number(l.term_years) || 1) - 1e-9) ? lineYearGross(l, y) - (y === 0 ? Number(l.one_time_fee) || 0 : 0) : 0), 0));
  const perYear = live.reduce((s, l) => s + lineAnnual(l), 0);
  return {
    state, signed: signed ? signed.slice(0, 10) : null, start, end: renew?.end ? renew.end.toISOString().slice(0, 10) : null, renews: !!renew,
    total: ls.reduce((s, l) => s + lineContractValue(l), 0),
    perYear, lastPerYear: live.length ? perYear : ls.reduce((s, l) => s + lineAnnualLast(l), 0),
    yearNo, incSoFar: upPct(first, nowG), incNext: rec.length && nx > 0.5 ? upPct(nowG, nx) : null, yearVals,
    ...steps(yearVals, Math.min(yearNo, Math.max(1, nYears)) - 1, rec.length ? new Date(s0).toISOString().slice(0, 10) : null),
  };
}
