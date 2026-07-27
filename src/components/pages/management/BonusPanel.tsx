/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
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
  fullDays: number | null;
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
  const hasMin = minDays != null || minBilling != null;
  const minMet = hasMin && (minDays == null || days >= minDays) && (minBilling == null || amount >= minBilling);
  if (!minMet) return { amount: 0, tier: 0 as 0 | 1 | 2, minMet: false, highMet: false };
  const highMet = highBilling != null && bonusPct2 != null
    && (highDays == null || days >= highDays) && (highBilling == null || amount >= highBilling);
  const p1 = (bonusPct1 ?? 0) / 100;
  const p2 = (bonusPct2 ?? 0) / 100;
  if (highMet && highBilling != null) {
    return { amount: highBilling * p1 + (amount - highBilling) * p2, tier: 2 as const, minMet: true, highMet: true };
  }
  return { amount: amount * p1, tier: 1 as const, minMet: true, highMet: false };
}

export default function BonusPanel({
  entries, projects, people, clientNames, capacity, clientTypeIds, supRoles,
  cutoffs, defaultCutoffDay, bonusLag, anchor,
}: Props) {
  const [open, setOpen] = useState<string | null>(null);

  // The month you're paying IN (from the page scope), and the month you're paying FOR.
  const payMonth = periodOf(anchor);
  const forMonth = shiftPeriod(payMonth, -bonusLag);

  const lineOf = (p: Proj, line: string, userId: string) => {
    if (line === "connector") return "connector";
    const member = (p.team ?? []).find((m) => m.userId === userId);
    if (line === "supervision" || supRoles.has(member?.role ?? "")) return "supervision";
    return "consultor";
  };
  const rateOf = (p: Proj, line: string, userId: string) =>
    lineOf(p, line, userId) === "supervision" ? p.supervision : p.rate;

  // Invoiced amount/days per consultant for the "for" month (period the invoices belong to).
  const rows = useMemo(() => {
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
      if (per !== forMonth) return;
      const isClient = clientTypeIds.size === 0 ? true : clientTypeIds.has(e.typeId);
      const rate = rateOf(p, e.line, e.userId);
      if (!(isClient && rate > 0 && e.billable > 0)) return;
      if (!acc[e.userId]) acc[e.userId] = { userId: e.userId, amount: 0, days: 0, byClient: {} };
      const amt = e.billable * rate;
      acc[e.userId].amount += amt;
      acc[e.userId].days += e.billable;
      const cname = clientNames[p.clientId] ?? "—";
      if (!acc[e.userId].byClient[p.clientId]) acc[e.userId].byClient[p.clientId] = { name: cname, amount: 0, days: 0 };
      acc[e.userId].byClient[p.clientId].amount += amt;
      acc[e.userId].byClient[p.clientId].days += e.billable;
    });
    return Object.values(acc)
      .map((r) => ({ ...r, bonus: computeBonus(r.amount, r.days, capacity[r.userId]) }))
      .sort((a, b) => b.bonus.amount - a.bonus.amount);
  }, [entries, projects, clientNames, capacity, clientTypeIds, forMonth, cutoffs, defaultCutoffDay, supRoles]);

  const totalBonus = rows.reduce((s, r) => s + r.bonus.amount, 0);
  const totalInvoiced = rows.reduce((s, r) => s + r.amount, 0);
  const qualifying = rows.filter((r) => r.bonus.minMet).length;

  return (
    <div className="bo">
      <div className="bo-hero">
        <div className="bo-hero-main">
          <span className="bo-hero-label">Bonus to pay in {periodLabel(payMonth)}</span>
          <span className="bo-hero-amount"><b>{eur(totalBonus)}</b><i>€</i></span>
          <span className="bo-hero-sub">
            On invoices from {periodLabel(forMonth)} · {bonusLag}-month lag · {qualifying} of {rows.length} qualify
          </span>
        </div>
        <div className="bo-hero-stats">
          <div className="bo-stat">
            <span className="bo-stat-k">Invoiced base</span>
            <span className="bo-stat-v">{eur(totalInvoiced)} €</span>
            <span className="bo-stat-s">{periodLabel(forMonth)}</span>
          </div>
          <div className="bo-stat">
            <span className="bo-stat-k">Consultants</span>
            <span className="bo-stat-v">{qualifying}</span>
            <span className="bo-stat-s">reaching minimum</span>
          </div>
        </div>
      </div>

      <div className="bo-scroll">
        {rows.length === 0 ? (
          <p className="bo-empty">No invoiced work in {periodLabel(forMonth)}.</p>
        ) : (
          <div className="bo-list">
            <div className="bo-listhead">
              <span>Consultant</span>
              <span className="bo-r">Invoiced</span>
              <span className="bo-r">Days</span>
              <span>Tier</span>
              <span className="bo-r">Bonus</span>
              <span />
            </div>
            {rows.map((r) => {
              const cap = capacity[r.userId];
              const isOpen = open === r.userId;
              return (
                <div className={`bo-row ${isOpen ? "is-open" : ""}`} key={r.userId}>
                  <button className="bo-row-main" onClick={() => setOpen(isOpen ? null : r.userId)}>
                    <span className="bo-who">
                      <span className="bo-av">{(people[r.userId] ?? "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>
                      <span className="bo-name">{people[r.userId] ?? "Unknown"}</span>
                    </span>
                    <span className="bo-r bo-inv">{eur(r.amount)} €</span>
                    <span className="bo-r">{r.days.toFixed(2)}</span>
                    <span className={`bo-tier tier-${r.bonus.tier}`}>
                      {r.bonus.tier === 2 ? "High" : r.bonus.tier === 1 ? "Min" : "—"}
                    </span>
                    <span className="bo-r bo-bonus"><b>{eur(r.bonus.amount)} €</b></span>
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
                            {r.bonus.tier === 2 && cap.highBilling != null ? (
                              <>
                                <div className="bo-step">
                                  <span>{eur(cap.highBilling)} € × {cap.bonusPct1 ?? 0}%</span>
                                  <b>{eur(cap.highBilling * (cap.bonusPct1 ?? 0) / 100)} €</b>
                                </div>
                                <div className="bo-step">
                                  <span>{eur(r.amount - cap.highBilling)} € × {cap.bonusPct2 ?? 0}%</span>
                                  <b>{eur((r.amount - cap.highBilling) * (cap.bonusPct2 ?? 0) / 100)} €</b>
                                </div>
                              </>
                            ) : (
                              <div className="bo-step">
                                <span>{eur(r.amount)} € × {cap.bonusPct1 ?? 0}%</span>
                                <b>{eur(r.amount * (cap.bonusPct1 ?? 0) / 100)} €</b>
                              </div>
                            )}
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