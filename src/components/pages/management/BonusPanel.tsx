/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState, useEffect } from "react";
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
        realizedBonus: realized[uid]?.bonusAmount ?? 0,
      };
    }).sort((a, b) => b.bonus.amount - a.bonus.amount);
  }, [payable, realized]);

  const totalBonus = rows.reduce((s, r) => s + r.bonus.amount, 0);
  const totalInvoiced = rows.reduce((s, r) => s + r.amount, 0);
  const qualifying = rows.filter((r) => r.bonus.minMet).length;

  return (
    <div className="bo">
      <div className="bo-hero bo-hero-neon">
        <span className="bo-hero-glow" aria-hidden="true" />
        <span className="bo-hero-scan" aria-hidden="true" />
        <div className="bo-hero-main">
          <span className="bo-hero-label">Bonus to pay in {periodLabel(payMonth)}</span>
          <span className="bo-hero-amount"><b>{eur(totalBonus)}</b><i>€</i></span>
          <span className="bo-hero-sub">
            On invoices from {periodLabel(forMonth)} ·{" "}
            <span className="bo-lag">
              <button className="bo-lag-btn" onClick={() => persistLag(Math.max(0, lag - 1))} disabled={lag <= 0} aria-label="Less delay">−</button>
              <b>{lag}-month lag</b>
              <button className="bo-lag-btn" onClick={() => persistLag(lag + 1)} aria-label="More delay">+</button>
            </span>{" "}
            · {qualifying} of {rows.length} qualify
          </span>
        </div>
        <div className="bo-hero-stats">
          <div className="bo-stat">
            <span className="bo-stat-k">Invoiced base</span>
            <span className="bo-stat-v is-neon">{eur(totalInvoiced)}<em>€</em></span>
            <span className="bo-stat-s">{periodLabel(forMonth)}</span>
          </div>
          <div className="bo-stat">
            <span className="bo-stat-k">Qualifying</span>
            <span className="bo-stat-v">{qualifying}<em>of {rows.length}</em></span>
            <span className="bo-stat-s">reaching minimum</span>
          </div>
        </div>
      </div>

      <div className="bo-scroll">
        {rows.length === 0 ? (
          <p className="bo-empty">No invoiced work in {periodLabel(forMonth)}.</p>
        ) : (
          <div className="bo-list">
            <div className="bo-listhead bo-listhead-pay">
              <span>Consultant</span>
              <span className="bo-r">Invoiced</span>
              <span className="bo-r">Realized now</span>
              <span>Tier</span>
              <span className="bo-r">Payable this month</span>
              <span>Status</span>
              <span />
            </div>
            {rows.map((r) => {
              const cap = capacity[r.userId];
              const isOpen = open === r.userId;
              const isPaid = r.userId in paidMap;
              const hasPayable = r.bonus.amount > 0;
              return (
                <div className={`bo-row bo-row-pay ${isOpen ? "is-open" : ""} ${isPaid ? "is-paid" : ""}`} key={r.userId}>
                  <button className="bo-row-main" onClick={() => setOpen(isOpen ? null : r.userId)}>
                    <span className="bo-who">
                      <span className="bo-av">{(people[r.userId] ?? "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>
                      <span className="bo-name">{people[r.userId] ?? "Unknown"}</span>
                    </span>
                    <span className="bo-r bo-inv">{eur(r.amount)} €</span>
                    <span className="bo-r bo-realized" title={`Bonus being earned in ${periodLabel(payMonth)}, payable in ${periodLabel(shiftPeriod(payMonth, lag))}`}>
                      {r.realizedBonus > 0 ? `${eur(r.realizedBonus)} €` : "—"}
                    </span>
                    <span className={`bo-tier tier-${r.bonus.tier}`}>
                      {r.bonus.tier === 2 ? "High" : r.bonus.tier === 1 ? "Min" : "—"}
                    </span>
                    <span className="bo-r bo-bonus"><b>{eur(r.bonus.amount)} €</b></span>
                    <span className="bo-paycell">
                      {hasPayable ? (
                        <span
                          role="button"
                          tabIndex={0}
                          className={`bo-paybtn ${isPaid ? "is-paid" : ""}`}
                          onClick={(e) => { e.stopPropagation(); if (busy !== r.userId) togglePaid(r.userId); }}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); togglePaid(r.userId); } }}
                        >
                          {busy === r.userId ? "…" : isPaid ? `Paid ${paidMap[r.userId] || ""}` : "Mark paid"}
                        </span>
                      ) : <span className="bo-nopay">—</span>}
                    </span>
                    <span className={`bo-chev ${isOpen ? "is-open" : ""}`}>›</span>
                  </button>
                  {isOpen && (
                    <div className="bo-detail">
                      <div className="bo-formula">
                        <span className="bo-detail-h">How this bonus is built</span>
                        {!cap ? (
                          <p className="bo-note">No targets set for this consultant.</p>
                        ) : !r.bonus.minMet ? (
                          <p className="bo-note">
                            Below the minimum ({cap.minBilling != null ? `${eur(cap.minBilling)} €` : ""}
                            {cap.minBilling != null && cap.minDays != null ? " · " : ""}
                            {cap.minDays != null ? `${cap.minDays}d` : ""}) — no bonus.
                          </p>
                        ) : (
                          <div className="bo-steps">
                            <div className="bo-step">
                              <span>{eur(r.amount)} € × {(r.bonus.tier === 2 ? cap.bonusPct2 : cap.bonusPct1) ?? 0}%</span>
                              <b>{eur(r.amount * ((r.bonus.tier === 2 ? cap.bonusPct2 : cap.bonusPct1) ?? 0) / 100)} €</b>
                            </div>
                            <div className="bo-step bo-step-total">
                              <span>Total bonus</span><b>{eur(r.bonus.amount)} €</b>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="bo-clients">
                        <span className="bo-detail-h">Invoiced by client ({periodLabel(forMonth)})</span>
                        {Object.values(r.byClient).sort((a, b) => b.amount - a.amount).map((c, i) => (
                          <div className="bo-client" key={i}>
                            <span className="bo-client-name">{c.name}</span>
                            <span className="bo-client-days">{c.days.toFixed(2)}d</span>
                            <span className="bo-client-amt">{eur(c.amount)} €</span>
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
      </div>
    </div>
  );
}