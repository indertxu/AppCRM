/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState, useEffect, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { supabase } from "../../api/supabase";
import { periodForDate, periodOf, type Cutoffs } from "../calendar/billingPeriods";
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
}
export interface BonusCap {
  minDays: number | null;
  minBilling: number | null;
  bonusPct1: number | null;
  highDays: number | null;
  highBilling: number | null;
  bonusPct2: number | null;
}
interface Proj { clientId: string; typeId: string; rate: number; supervision: number; team: { userId?: string; role?: string }[]; }

interface Props {
  entries: BonusEntry[];
  projects: Record<string, Proj>;
  people: Record<string, string>;
  clientNames: Record<string, string>;
  capacity: Record<string, BonusCap>;
  clientTypeIds: Set<string>;
  supRoles: Set<string>;
  cutoffs: Cutoffs;
  defaultCutoffDay: number;
  bonusLag: number;
  anchor: Date;
  hourProjects?: Set<string>;
  hoursPerDay?: number;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const periodLabel = (p: string) => { const [y, m] = p.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
const shiftPeriod = (p: string, by: number) => {
  const [y, m] = p.split("-").map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/* ===================================================================
   Presentation helpers. Same language as the Team, Backlog and Billing
   tabs: count-ups, a sweeping arc, cursor spotlight.
   =================================================================== */
const bpVars = (o: Record<string, string | number>) => o as CSSProperties;
const bpReduced = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const bpDate = (iso: string) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
function useBpCount(target: number, ms = 1100) {
  const [value, setValue] = useState(() => (bpReduced() ? target : 0));
  const from = useRef(value);
  useEffect(() => {
    if (bpReduced()) { from.current = target; setValue(target); return; }
    let raf = 0;
    const start = from.current;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      const cur = start + (target - start) * e;
      from.current = cur;
      setValue(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}
function BpCount({ value, fmt = eur }: { value: number; fmt?: (n: number) => string }) {
  return <>{fmt(useBpCount(value))}</>;
}
function useBpArmed(ms: number) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), bpReduced() ? 0 : ms);
    return () => window.clearTimeout(t);
  }, [ms]);
  return armed;
}
function bpSpot(e: ReactPointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse") return;
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-spot]");
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  el.style.setProperty("--mx", `${x}px`);
  el.style.setProperty("--my", `${y}px`);
  if (el.dataset.spot === "tilt") {
    el.style.setProperty("--ry", `${(x / r.width - 0.5) * 6}deg`);
    el.style.setProperty("--rx", `${(0.5 - y / r.height) * 6}deg`);
  }
}
const BP_ICON = {
  gift: "M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z",
  base: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01",
  spark: "M13 2L3 14h7l-1 8 10-12h-7z",
  check: "M20 6L9 17l-5-5",
  chev: "M9 6l6 6-6 6",
  empty: "M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4",
};
function BpIcon({ d, w = 2 }: { d: string; w?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const BP_ARC = "M16 70 A54 54 0 0 1 124 70";
const TIER_LABEL = ["Below minimum", "Minimum", "High tier"] as const;

function computeBonus(amount: number, days: number, cap: BonusCap | undefined) {
  if (!cap) return { amount: 0, tier: 0 as 0 | 1 | 2, minMet: false, highMet: false };
  const { minDays, minBilling, bonusPct1, highDays, highBilling, bonusPct2 } = cap;
  // Minimum tier requires BOTH thresholds (days and billing) to be met.
  const hasMin = minDays != null || minBilling != null;
  const minMet = hasMin && (minDays == null || days >= minDays) && (minBilling == null || amount >= minBilling);
  if (!minMet) return { amount: 0, tier: 0 as 0 | 1 | 2, minMet: false, highMet: false };
  // High tier also requires BOTH. When reached, the WHOLE invoiced amount pays
  // pct2 — the tiers are flat rates, not marginal brackets.
  const highMet = highBilling != null && bonusPct2 != null
    && (highDays == null || days >= highDays) && (highBilling == null || amount >= highBilling);
  const p1 = (bonusPct1 ?? 0) / 100;
  const p2 = (bonusPct2 ?? 0) / 100;
  if (highMet) {
    return { amount: amount * p2, tier: 2 as const, minMet: true, highMet: true };
  }
  return { amount: amount * p1, tier: 1 as const, minMet: true, highMet: false };
}

export default function BonusPanel({
  entries, projects, people, clientNames, capacity, clientTypeIds, supRoles,
  cutoffs, defaultCutoffDay, bonusLag, anchor,
  hourProjects = new Set(), hoursPerDay = 8,
}: Props) {
  const [open, setOpen] = useState<string | null>(null);
  /** Editable lag (months from realized to paid). Seeds from the prop. */
  const [lag, setLag] = useState(bonusLag);
  useEffect(() => setLag(bonusLag), [bonusLag]);
  /** Paid state per user for the current pay month: userId -> paid_date|null. */
  const [paidMap, setPaidMap] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // The month you're paying IN (from the page scope), and the month you're
  // paying FOR (realized), separated by the adjustable lag.
  const payMonth = periodOf(anchor);
  const forMonth = shiftPeriod(payMonth, -lag);

  // Load which bonuses are already marked paid for this pay month.
  useEffect(() => {
    let alive = true;
    supabase.from("bonus_payments").select("user_id, paid, paid_date")
      .eq("pay_period", payMonth)
      .then(({ data }) => {
        if (!alive) return;
        const m: Record<string, string | null> = {};
        (data ?? []).forEach((r: any) => { if (r.paid) m[r.user_id] = r.paid_date ?? ""; });
        setPaidMap(m);
      });
    return () => { alive = false; };
  }, [payMonth]);

  const persistLag = async (n: number) => {
    setLag(n);
    await supabase.from("billing_settings").upsert(
      { id: "default", bonus_lag_months: n }, { onConflict: "id,tenant_id" });
  };

  const togglePaid = async (userId: string) => {
    setBusy(userId);
    const isPaid = userId in paidMap;
    if (isPaid) {
      await supabase.from("bonus_payments").delete()
        .eq("user_id", userId).eq("pay_period", payMonth);
      setPaidMap((m) => { const n = { ...m }; delete n[userId]; return n; });
    } else {
      const today = new Date().toISOString().slice(0, 10);
      await supabase.from("bonus_payments").upsert(
        { user_id: userId, pay_period: payMonth, paid: true, paid_date: today },
        { onConflict: "tenant_id,user_id,pay_period" });
      setPaidMap((m) => ({ ...m, [userId]: today }));
    }
    setBusy(null);
  };

  const lineOf = (_p: Proj, line: string, _userId: string) => {
    // Billing line follows the user's pick, not their project role.
    if (line === "connector") return "connector";
    if (line === "supervision") return "supervision";
    return "consultor";
  };
  const rateOf = (p: Proj, line: string, userId: string) =>
    lineOf(p, line, userId) === "supervision" ? p.supervision : p.rate;

  // Invoiced amount/days per consultant for the "for" month (period the invoices belong to).
  // Accumulate invoiced amount + day-equivalent per consultant for the invoices
  // belonging to a given billing period, and the resulting bonus.
  const bonusForPeriod = (targetPeriod: string) => {
    const acc: Record<string, {
      userId: string; amount: number; days: number;
      byClient: Record<string, { name: string; amount: number; days: number }>;
    }> = {};
    entries.forEach((e) => {
      if (e.status === "cancelled" || e.line === "closure" || e.line === "connector") return;
      if (!e.projectId || !e.userId) return;
      const p = projects[e.projectId];
      if (!p) return;
      const per = e.billingPeriod || periodForDate(e.date, cutoffs, defaultCutoffDay);
      if (per !== targetPeriod) return;
      const isClient = clientTypeIds.size === 0 ? true : clientTypeIds.has(e.typeId);
      const rate = rateOf(p, e.line, e.userId);
      if (!(isClient && rate > 0 && e.billable > 0)) return;
      if (!acc[e.userId]) acc[e.userId] = { userId: e.userId, amount: 0, days: 0, byClient: {} };
      const amt = e.billable * rate;
      const hpd = hoursPerDay > 0 ? hoursPerDay : 8;
      const dayEq = hourProjects.has(e.projectId) ? e.billable / hpd : e.billable;
      acc[e.userId].amount += amt;
      acc[e.userId].days += dayEq;
      const cname = clientNames[p.clientId] ?? "—";
      if (!acc[e.userId].byClient[p.clientId]) acc[e.userId].byClient[p.clientId] = { name: cname, amount: 0, days: 0 };
      acc[e.userId].byClient[p.clientId].amount += amt;
      acc[e.userId].byClient[p.clientId].days += dayEq;
    });
    const out: Record<string, {
      bonusAmount: number; tier: 0 | 1 | 2; minMet: boolean; highMet: boolean;
      amount: number; days: number; byClient: any;
    }> = {};
    Object.values(acc).forEach((r) => {
      const b = computeBonus(r.amount, r.days, capacity[r.userId]);
      out[r.userId] = {
        bonusAmount: b.amount,        // the bonus owed
        tier: b.tier, minMet: b.minMet, highMet: b.highMet,
        amount: r.amount,             // the invoiced base
        days: r.days, byClient: r.byClient,
      };
    });
    return out;
  };

  // Payable NOW: bonus realized `lag` months ago, due in the current pay month.
  // Realized THIS month: what's being earned now, payable `lag` months later.
  const payable = useMemo(() => bonusForPeriod(forMonth),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, projects, clientNames, capacity, clientTypeIds, forMonth, cutoffs, defaultCutoffDay, hourProjects, hoursPerDay]);
  const realized = useMemo(() => bonusForPeriod(payMonth),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, projects, clientNames, capacity, clientTypeIds, payMonth, cutoffs, defaultCutoffDay, hourProjects, hoursPerDay]);

  const rows = useMemo(() => {
    const ids = new Set([...Object.keys(payable), ...Object.keys(realized)]);
    return [...ids].map((uid) => {
      const pay = payable[uid];
      return {
        userId: uid,
        amount: pay?.amount ?? 0,
        days: pay?.days ?? 0,
        byClient: pay?.byClient ?? {},
        bonus: pay ? { amount: pay.bonusAmount, tier: pay.tier, minMet: pay.minMet, highMet: pay.highMet }
                   : { amount: 0, tier: 0 as 0 | 1 | 2, minMet: false, highMet: false },
        realizedInvoiced: realized[uid]?.amount ?? 0,
        realizedBonus: realized[uid]?.bonusAmount ?? 0,
      };
    }).sort((a, b) => b.bonus.amount - a.bonus.amount);
  }, [payable, realized]);

  const totalBonus = rows.reduce((s, r) => s + r.bonus.amount, 0);
  const totalInvoiced = rows.reduce((s, r) => s + r.amount, 0);
  const qualifying = rows.filter((r) => r.bonus.minMet).length;

  /* ---------- presentation ---------- */
  const armed = useBpArmed(320);
  const payableRows = rows.filter((r) => r.bonus.amount > 0);
  const paidRows = payableRows.filter((r) => r.userId in paidMap);
  const paidAmount = paidRows.reduce((s, r) => s + r.bonus.amount, 0);
  const paidShare = totalBonus > 0 ? (paidAmount / totalBonus) * 100 : 0;
  const qualPct = rows.length > 0 ? (qualifying / rows.length) * 100 : 0;
  const realizedTotal = rows.reduce((s, r) => s + r.realizedBonus, 0);
  const realizedBase = rows.reduce((s, r) => s + r.realizedInvoiced, 0);
  const paidIn = periodLabel(shiftPeriod(payMonth, lag));
  const initials = (uid: string) =>
    (people[uid] ?? "?").split(" ").filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";

  return (
    <div className="bp" onPointerMove={bpSpot}>
      {/* ---------- headline cards on the dark band ---------- */}
      <section className="bp-hero">
        <div className="bp-kpis">
          <div className="bp-kpi is-main" data-spot="tilt" style={bpVars({ "--i": 0 })}>
            <span className="bp-kpi-head">
              <span className="bp-kpi-ico"><BpIcon d={BP_ICON.gift} w={1.9} /></span>
              <span className="bp-kpi-label">Bonus to pay in {periodLabel(payMonth)}</span>
            </span>
            <b className="bp-val is-xl"><BpCount value={totalBonus} /><em>€</em></b>
            <span className="bp-lagline">
              <span>On invoices from <b>{periodLabel(forMonth)}</b></span>
              <span className="bp-lag" title="Months between the work being invoiced and its bonus being paid">
                <button type="button" onClick={() => persistLag(Math.max(0, lag - 1))} disabled={lag <= 0} aria-label="Less delay">−</button>
                <b>{lag}-month lag</b>
                <button type="button" onClick={() => persistLag(lag + 1)} aria-label="More delay">+</button>
              </span>
            </span>
            <span className="bp-paid">
              <span className="bp-paid-bar" aria-hidden="true"><i style={{ width: `${armed ? paidShare : 0}%` }} /></span>
              <small>
                {payableRows.length === 0 ? "Nothing to pay this month"
                  : paidRows.length === payableRows.length ? `All ${payableRows.length} paid`
                  : `${paidRows.length} of ${payableRows.length} paid, ${eur(totalBonus - paidAmount)} € still to pay`}
              </small>
            </span>
          </div>

          <div className="bp-kpi" data-spot="tilt" style={bpVars({ "--i": 1 })}>
            <span className="bp-kpi-head">
              <span className="bp-kpi-ico"><BpIcon d={BP_ICON.base} w={1.9} /></span>
              <span className="bp-kpi-label">Invoiced base</span>
            </span>
            <b className="bp-val"><BpCount value={totalInvoiced} /><em>€</em></b>
            <small className="bp-kpi-sub">Invoiced in {periodLabel(forMonth)}</small>
          </div>

          <div className="bp-kpi" data-spot="tilt" style={bpVars({ "--i": 2 })}>
            <span className="bp-kpi-head">
              <span className="bp-kpi-ico"><BpIcon d={BP_ICON.target} w={1.9} /></span>
              <span className="bp-kpi-label">Qualifying</span>
            </span>
            <span className="bp-qual">
              <span className="bp-dial" aria-hidden="true">
                <svg viewBox="0 0 140 80">
                  <path className="bp-arc-bg" d={BP_ARC} pathLength={100} />
                  <path className={`bp-arc-fill ${armed && qualPct > 0 ? "" : "is-zero"}`} d={BP_ARC} pathLength={100}
                    style={{ strokeDasharray: `${armed ? qualPct.toFixed(2) : 0} 101` }} />
                </svg>
                <span className="bp-dial-pct"><BpCount value={qualPct} fmt={(n) => Math.round(n).toString()} /><em>%</em></span>
              </span>
              <span className="bp-qual-txt">
                <b className="bp-val"><BpCount value={qualifying} fmt={(n) => Math.round(n).toString()} /><em>of {rows.length}</em></b>
                <small className="bp-kpi-sub">reach the minimum</small>
              </span>
            </span>
          </div>

          <div className="bp-kpi is-next" data-spot="tilt" style={bpVars({ "--i": 3 })}>
            <span className="bp-kpi-head">
              <span className="bp-kpi-ico"><BpIcon d={BP_ICON.spark} w={1.9} /></span>
              <span className="bp-kpi-label">Earning this month</span>
            </span>
            <b className="bp-val"><BpCount value={realizedTotal} /><em>€</em></b>
            <small className="bp-kpi-sub">on {eur(realizedBase)} € invoiced, paid in {paidIn}</small>
          </div>
        </div>
      </section>

      {/* ---------- light sheet ---------- */}
      <section className="bp-sheet">
        <header className="bp-sheet-h">
          <h2>Consultants <span className="bp-count">{rows.length}</span></h2>
          <span className="bp-legend" aria-hidden="true">
            <span className="tier-0"><i />Below minimum</span>
            <span className="tier-1"><i />Minimum</span>
            <span className="tier-2"><i />High tier</span>
          </span>
        </header>

        {rows.length === 0 ? (
          <div className="bp-empty">
            <span className="bp-empty-art"><BpIcon d={BP_ICON.empty} w={1.6} /></span>
            <p>No invoiced work in {periodLabel(forMonth)}.</p>
          </div>
        ) : (
          <div className="bp-list">
            <div className="bp-head bp-grid" aria-hidden="true">
              <span>Consultant</span>
              <span>Invoiced in {periodLabel(forMonth)}</span>
              <span className="bp-r" title={`Invoiced in ${periodLabel(payMonth)}, paid in ${paidIn}`}>This month</span>
              <span className="bp-r">Payable now</span>
              <span>Status</span>
              <span />
            </div>
            {rows.map((r, ri) => {
              const cap = capacity[r.userId];
              const isOpen = open === r.userId;
              const isPaid = r.userId in paidMap;
              const hasPayable = r.bonus.amount > 0;
              const minB = cap?.minBilling ?? 0;
              const highB = cap?.highBilling ?? 0;
              const scale = Math.max(highB, minB, r.amount, 1) * 1.06;
              const at = (n: number) => Math.min(97, Math.max(3, (n / scale) * 100));
              const pct = (r.bonus.tier === 2 ? cap?.bonusPct2 : cap?.bonusPct1) ?? 0;
              const toggle = () => setOpen(isOpen ? null : r.userId);
              const clients = Object.values(r.byClient as Record<string, { name: string; amount: number; days: number }>).sort((a, b) => b.amount - a.amount);
              const clientMax = Math.max(0.0001, ...clients.map((c) => c.amount));
              return (
                <div className={`bp-row tier-${r.bonus.tier} ${isOpen ? "is-open" : ""} ${isPaid ? "is-paid" : ""}`} key={r.userId} style={bpVars({ "--i": Math.min(ri, 14) })}>
                  <div
                    className="bp-row-main bp-grid"
                    data-spot=""
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onClick={toggle}
                    onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}
                  >
                    <span className="bp-who">
                      <span className="bp-av">{initials(r.userId)}</span>
                      <span className="bp-who-t">
                        <b>{people[r.userId] ?? "Unknown"}</b>
                        <span className={`bp-tier tier-${r.bonus.tier}`}>
                          {r.bonus.tier === 0 ? TIER_LABEL[0] : `${TIER_LABEL[r.bonus.tier]}${pct ? `, ${pct}%` : ""}`}
                        </span>
                      </span>
                    </span>

                    {/* invoiced base against the person's thresholds */}
                    <span className="bp-base">
                      <span className="bp-base-v"><b>{eur(r.amount)} €</b><small>{r.days.toFixed(1)}d</small></span>
                      <span className="bp-track" aria-hidden="true">
                        <i className="bp-fill" style={{ width: `${Math.min(100, (r.amount / scale) * 100)}%` }} />
                        {minB > 0 && <i className={`bp-tick ${r.amount >= minB ? "is-hit" : ""}`} style={{ left: `${at(minB)}%` }} title={`Minimum ${eur(minB)} €`} />}
                        {highB > 0 && <i className={`bp-tick is-high ${r.amount >= highB ? "is-hit" : ""}`} style={{ left: `${at(highB)}%` }} title={`High tier ${eur(highB)} €`} />}
                      </span>
                      <span className="bp-marks">
                        {!cap ? <em>No targets set</em> : (
                          <>
                            {minB > 0 && <span>Min <b>{eur(minB)}</b></span>}
                            {highB > 0 && <span className="is-high">High <b>{eur(highB)}</b></span>}
                          </>
                        )}
                      </span>
                    </span>

                    <span className="bp-now" title={`Invoiced in ${periodLabel(payMonth)}; the bonus it earns is paid in ${paidIn}`}>
                      {r.realizedInvoiced > 0 ? (
                        <>
                          <b>{eur(r.realizedInvoiced)} €</b>
                          <small className={r.realizedBonus > 0 ? "is-on" : ""}>{r.realizedBonus > 0 ? `+${eur(r.realizedBonus)} bonus` : "no bonus yet"}</small>
                        </>
                      ) : <small>—</small>}
                    </span>

                    <span className={`bp-pay ${hasPayable ? "" : "is-none"}`}><b>{eur(r.bonus.amount)} €</b></span>

                    <span className="bp-status">
                      {hasPayable ? (
                        <button
                          type="button"
                          className={`bp-paybtn ${isPaid ? "is-paid" : ""}`}
                          disabled={busy === r.userId}
                          onClick={(e) => { e.stopPropagation(); if (busy !== r.userId) togglePaid(r.userId); }}
                          title={isPaid ? "Click to mark as not paid" : undefined}
                        >
                          {busy === r.userId ? "…" : isPaid ? (
                            <><BpIcon d={BP_ICON.check} w={2.6} />Paid{paidMap[r.userId] ? ` ${bpDate(paidMap[r.userId] as string)}` : ""}</>
                          ) : "Mark paid"}
                        </button>
                      ) : <span className="bp-nopay">Nothing to pay</span>}
                    </span>

                    <span className="bp-chev"><BpIcon d={BP_ICON.chev} w={2.4} /></span>
                  </div>

                  {isOpen && (
                    <div className="bp-detail">
                      <div className="bp-dbox">
                        <span className="bp-dh">How this bonus is built</span>
                        {!cap ? (
                          <p className="bp-note">No targets set for this consultant.</p>
                        ) : !r.bonus.minMet ? (
                          <p className="bp-note is-below">
                            Below the minimum ({cap.minBilling != null ? `${eur(cap.minBilling)} €` : ""}
                            {cap.minBilling != null && cap.minDays != null ? ", " : ""}
                            {cap.minDays != null ? `${cap.minDays}d` : ""}), so no bonus.
                          </p>
                        ) : (
                          <div className="bp-steps">
                            <div className="bp-step">
                              <span>{eur(r.amount)} € × {(r.bonus.tier === 2 ? cap.bonusPct2 : cap.bonusPct1) ?? 0}%</span>
                              <b>{eur(r.amount * ((r.bonus.tier === 2 ? cap.bonusPct2 : cap.bonusPct1) ?? 0) / 100)} €</b>
                            </div>
                            <div className="bp-step is-total">
                              <span>Total bonus</span><b>{eur(r.bonus.amount)} €</b>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="bp-dbox">
                        <span className="bp-dh">Invoiced by client, {periodLabel(forMonth)}</span>
                        {clients.map((c, i) => (
                          <div className="bp-client" key={i} style={bpVars({ "--d": Math.min(i, 10) })}>
                            <span className="bp-client-name">{c.name}</span>
                            <span className="bp-client-days">{c.days.toFixed(2)}d</span>
                            <span className="bp-client-amt">{eur(c.amount)} €</span>
                            <span className="bp-client-bar" aria-hidden="true"><i style={{ width: `${(c.amount / clientMax) * 100}%` }} /></span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}