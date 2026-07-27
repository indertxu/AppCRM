/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { periodForDate, periodOf, type Cutoffs } from "../calendar/billingPeriods";
import "./ManagementWidget.css";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const periodLabel = (p: string) => { const [y, m] = p.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
const shiftPeriod = (p: string, by: number) => {
  const [y, m] = p.split("-").map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

interface Summary {
  outstanding: number;      // invoiced, not yet paid
  overdue: number;          // outstanding past due date
  invoicedThisMonth: number;
  backlogValue: number;     // sold − consumed, still to deliver
  bonusToPay: number;
  bonusForMonth: string;
  loading: boolean;
}

export default function ManagementWidget() {
  const navigate = useNavigate();
  const [s, setS] = useState<Summary>({
    outstanding: 0, overdue: 0, invoicedThisMonth: 0,
    backlogValue: 0, bonusToPay: 0, bonusForMonth: "", loading: true,
  });

  useEffect(() => {
    (async () => {
      const today = new Date();
      const todayISO = today.toISOString().slice(0, 10);
      const thisPeriod = periodOf(today);

      // Cutoffs + settings
      const { data: bs } = await supabase.from("billing_settings").select("default_cutoff_day, bonus_lag_months").eq("id", "default").maybeSingle();
      const defaultCutoffDay = Number(bs?.default_cutoff_day ?? 0);
      const bonusLag = Number(bs?.bonus_lag_months ?? 2);
      const { data: cutRows } = await supabase.from("billing_periods").select("period, cutoff_date");
      const cutoffs: Cutoffs = Object.fromEntries(((cutRows ?? []) as any[]).map((r) => [r.period, r.cutoff_date]));

      // Invoices → outstanding + overdue + invoiced this month
      const { data: inv } = await supabase.from("invoices").select("amount, status, sent_date, due_date, period");
      let outstanding = 0, overdue = 0, invoicedThisMonth = 0;
      ((inv ?? []) as any[]).forEach((r) => {
        const amt = Number(r.amount) || 0;
        if (r.status !== "paid") {
          outstanding += amt;
          if (r.due_date && r.due_date < todayISO) overdue += amt;
        }
        if (r.period === thisPeriod) invoicedThisMonth += amt;
      });

      // Projects for rates + backlog
      const { data: pj } = await supabase.from("projects").select("id, price_per_day, supervision_price, consultor_days, supervision_days, connector_days, status");
      const projects: Record<string, any> = Object.fromEntries(((pj ?? []) as any[]).map((p) => [p.id, p]));

      // Entries: consumed days per project + invoiced base for bonus
      const { data: ce } = await supabase
        .from("calendar_entries")
        .select("user_id, project_id, entry_date, billable, status, billing_line, billing_period, work_type_id");

      // Backlog value = sold value − delivered value, across live projects
      const deliveredByProj: Record<string, number> = {};
      ((ce ?? []) as any[]).forEach((e) => {
        if (e.status === "cancelled" || e.billing_line === "closure") return;
        if (!e.project_id) return;
        deliveredByProj[e.project_id] = (deliveredByProj[e.project_id] ?? 0) + (Number(e.billable) || 0);
      });
      let backlogValue = 0;
      ((pj ?? []) as any[]).forEach((p) => {
        if (p.status && p.status !== "active" && p.status !== "live" && p.status !== "open") return;
        const rate = Number(p.price_per_day) || 0;
        const sold = (Number(p.consultor_days) || 0) + (Number(p.supervision_days) || 0) + (Number(p.connector_days) || 0);
        const delivered = deliveredByProj[p.id] ?? 0;
        const remaining = Math.max(0, sold - delivered);
        backlogValue += remaining * rate;
      });

      // Bonus to pay this month = invoiced N months ago × tiered pct, per consultant
      const forMonth = shiftPeriod(thisPeriod, -bonusLag);
      const { data: ut } = await supabase.from("user_targets")
        .select("user_id, min_days_month, min_billing_month, bonus_pct_1, high_days_month, high_billing_month, bonus_pct_2");
      const caps: Record<string, any> = Object.fromEntries(((ut ?? []) as any[]).map((r) => [r.user_id, r]));

      const invByUser: Record<string, { amount: number; days: number }> = {};
      ((ce ?? []) as any[]).forEach((e) => {
        if (e.status === "cancelled" || e.billing_line === "closure" || e.billing_line === "connector") return;
        if (!e.project_id || !e.user_id) return;
        const p = projects[e.project_id];
        if (!p) return;
        const per = e.billing_period || periodForDate(e.entry_date, cutoffs, defaultCutoffDay);
        if (per !== forMonth) return;
        const rate = e.billing_line === "supervision" ? (Number(p.supervision_price) || 0) : (Number(p.price_per_day) || 0);
        const bill = Number(e.billable) || 0;
        if (rate <= 0 || bill <= 0) return;
        if (!invByUser[e.user_id]) invByUser[e.user_id] = { amount: 0, days: 0 };
        invByUser[e.user_id].amount += bill * rate;
        invByUser[e.user_id].days += bill;
      });

      let bonusToPay = 0;
      Object.entries(invByUser).forEach(([uid, v]) => {
        const c = caps[uid];
        if (!c) return;
        const minDays = c.min_days_month, minBill = c.min_billing_month;
        const hasMin = minDays != null || minBill != null;
        const minMet = hasMin && (minDays == null || v.days >= minDays) && (minBill == null || v.amount >= minBill);
        if (!minMet) return;
        const highBill = c.high_billing_month, p2 = c.bonus_pct_2;
        const highMet = highBill != null && p2 != null
          && (c.high_days_month == null || v.days >= c.high_days_month) && v.amount >= highBill;
        const pct1 = (c.bonus_pct_1 ?? 0) / 100;
        if (highMet && highBill != null) bonusToPay += highBill * pct1 + (v.amount - highBill) * ((p2 ?? 0) / 100);
        else bonusToPay += v.amount * pct1;
      });

      setS({
        outstanding, overdue, invoicedThisMonth, backlogValue,
        bonusToPay, bonusForMonth: forMonth, loading: false,
      });
    })().catch(() => setS((x) => ({ ...x, loading: false })));
  }, []);

  return (
    <aside className="mw">
      <div className="mw-head">
        <span className="mw-eyebrow">Management</span>
        <button className="mw-open" onClick={() => navigate("/management")}>Open →</button>
      </div>

      {s.loading ? (
        <div className="mw-loading">Loading…</div>
      ) : (
        <>
          <div className="mw-hero">
            <span className="mw-hero-k">Outstanding</span>
            <span className="mw-hero-v"><b>{eur(s.outstanding)}</b><i>€</i></span>
            <span className="mw-hero-s">
              {s.overdue > 0 ? <em className="mw-overdue">{eur(s.overdue)} € overdue</em> : "Nothing overdue"}
            </span>
          </div>

          <div className="mw-grid">
            <button className="mw-cell" onClick={() => navigate("/management")}>
              <span className="mw-cell-k">Invoiced {periodLabel(periodOf(new Date()))}</span>
              <b className="mw-cell-v">{eur(s.invoicedThisMonth)} €</b>
            </button>
            <button className="mw-cell" onClick={() => navigate("/management")}>
              <span className="mw-cell-k">Backlog value</span>
              <b className="mw-cell-v">{eur(s.backlogValue)} €</b>
            </button>
            <button className="mw-cell mw-cell-wide" onClick={() => navigate("/management")}>
              <span className="mw-cell-k">Bonus to pay {s.bonusForMonth ? `· on ${periodLabel(s.bonusForMonth)}` : ""}</span>
              <b className="mw-cell-v">{eur(s.bonusToPay)} €</b>
            </button>
          </div>
        </>
      )}
    </aside>
  );
}