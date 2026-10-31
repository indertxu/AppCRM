/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home · MANAGEMENT
 *
 * The right-hand side of the home page for the boss and managers outside
 * consultancy and sales: money (outstanding, invoiced, backlog, bonus), the
 * sales pipeline, clients nobody has talked to lately and the team bonus.
 * (Was ManagementWidget + HomeWidgets; the calendar now lives in the shared column.)
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../api/supabase";
import { pagedAll } from "../../companies/companiesApi";
import { periodForDate, periodOf, type Cutoffs } from "../../calendar/billingPeriods";
import { loadRoles } from "../../settings/blueprintsApi";
import { roleLinesOfRow, resolveRoleKey, legacyRoleMap, roleKeyOf, roleCounts, rateOn, lineRate } from "../../clients/clientsTypes";
import { loadInactiveIds } from "../../../framework/peopleStatus";
import "./ManagementHome.css";

const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const daysSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

/* =====================================================================
   SALES PIPELINE — trackings by stage, with an animated funnel
   ===================================================================== */
function SalesPipelineWidget() {
  const nav = useNavigate();
  const [stages, setStages] = useState<{ name: string; count: number; value: number }[]>([]);
  const [totals, setTotals] = useState({ active: 0, won: 0, value: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: ph } = await supabase.from("pipeline_phases").select("id, name, pos_x, sales_visible");
      if (!alive) return;
      const phaseName: Record<string, { name: string; x: number }> = {};
      (ph ?? []).forEach((p: any) => { if (p.sales_visible !== false) phaseName[p.id] = { name: p.name, x: p.pos_x ?? 0 }; });
      // Counted by the database (52_search_server.sql): no deal is downloaded for this card.
      const sum = await supabase.rpc("pipeline_summary").then((r: any) => (r.error ? null : r.data), () => null);
      if (!alive) return;
      if (sum) {
        const st = ((sum.phases ?? []) as any[]).filter((x) => phaseName[x.phase_id])
          .map((x) => ({ name: phaseName[x.phase_id].name, x: phaseName[x.phase_id].x, count: Number(x.count) || 0, value: Number(x.value) || 0 }))
          .sort((a, b) => a.x - b.x).slice(0, 6);
        setStages(st.map((s) => ({ name: s.name, count: s.count, value: s.value })));
        setTotals({ active: Number(sum.active) || 0, won: Number(sum.won) || 0, value: Number(sum.value) || 0 });
        setLoading(false);
        return;
      }
      // Without it: every deal (a plain read stops at 1,000 rows), pages fetched in parallel, in a stable order.
      const trk = await pagedAll<any>((count) => supabase
        .from("trackings")
        .select("id, status, current_phase_id, product_price, pipeline_id", count ? { count: "exact" } : undefined)
        .order("id")).catch(() => [] as any[]);
      if (!alive) return;

      const byStage: Record<string, { name: string; x: number; count: number; value: number }> = {};
      let active = 0, won = 0, value = 0;
      (trk ?? []).forEach((t: any) => {
        if (t.status === "won") won += 1;
        if (t.status === "active") {
          active += 1;
          const price = Number(t.product_price) || 0;
          value += price;
          const pn = phaseName[t.current_phase_id];
          if (pn) {
            const k = t.current_phase_id;
            if (!byStage[k]) byStage[k] = { name: pn.name, x: pn.x, count: 0, value: 0 };
            byStage[k].count += 1;
            byStage[k].value += price;
          }
        }
      });
      const arr = Object.values(byStage).sort((a, b) => a.x - b.x).slice(0, 6);
      setStages(arr.map((s) => ({ name: s.name, count: s.count, value: s.value })));
      setTotals({ active, won, value });
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const maxCount = Math.max(1, ...stages.map((s) => s.count));

  return (
    <aside className="hw hw-pipe" onClick={() => nav("/sales")} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && nav("/sales")}>
      <span className="hw-glow" aria-hidden="true" />
      <div className="hw-head">
        <span className="hw-eyebrow">Sales pipeline</span>
        <span className="hw-headfig">{loading ? "…" : totals.active}<i>active</i></span>
      </div>

      <div className="hw-funnel">
        {loading ? (
          <div className="hw-skel" />
        ) : stages.length === 0 ? (
          <p className="hw-empty">No active deals.</p>
        ) : stages.map((s, i) => (
          <div className="hw-funnel-row" key={i} style={{ animationDelay: `${i * 0.08}s` }}>
            <span className="hw-funnel-name">{s.name}</span>
            <span className="hw-funnel-bar">
              <span className="hw-funnel-fill" style={{ width: `${(s.count / maxCount) * 100}%` }} />
              <b>{s.count}</b>
            </span>
          </div>
        ))}
      </div>

      <div className="hw-foot">
        <span><b>{eur(totals.value)}</b> € in play</span>
        <span className="hw-foot-won">{totals.won} won</span>
      </div>
    </aside>
  );
}

/* =====================================================================
   NEGLECTED CLIENTS — who hasn't been contacted, most stale first
   ===================================================================== */
function NeglectedClientsWidget() {
  const nav = useNavigate();
  const [rows, setRows] = useState<{ id: string; name: string; days: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const todayISO = new Date().toISOString().slice(0, 10);
      const [{ data: clients }, { data: ce }, { data: notes }, { data: log }] = await Promise.all([
        supabase.from("clients").select("id, name"),
        supabase.from("calendar_entries").select("client_id, entry_date").eq("status", "confirmed").lte("entry_date", todayISO).not("client_id", "is", null),
        supabase.from("client_notes").select("client_id, created_at"),
        supabase.from("client_contacts_log").select("client_id, contacted_at"),
      ]);
      if (!alive) return;
      // most recent contact per client, from any source
      const lastByClient: Record<string, string> = {};
      const bump = (cid: string, iso: string) => { if (cid && (!lastByClient[cid] || iso > lastByClient[cid])) lastByClient[cid] = iso; };
      (ce ?? []).forEach((r: any) => bump(r.client_id, r.entry_date));
      (notes ?? []).forEach((r: any) => bump(r.client_id, r.created_at.slice(0, 10)));
      (log ?? []).forEach((r: any) => bump(r.client_id, r.contacted_at.slice(0, 10)));

      const out = (clients ?? []).map((c: any) => {
        const last = lastByClient[c.id];
        return { id: c.id, name: c.name, days: last ? daysSince(last) : 999 };
      })
        .filter((c) => c.days > 30)
        .sort((a, b) => b.days - a.days)
        .slice(0, 5);
      setRows(out);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const sev = (d: number) => d >= 90 ? "is-critical" : d >= 60 ? "is-bad" : "is-warn";

  return (
    <aside className="hw hw-neglect" onClick={() => nav("/clients")} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && nav("/clients")}>
      <span className="hw-glow hw-glow-warm" aria-hidden="true" />
      <div className="hw-head">
        <span className="hw-eyebrow">Needs attention</span>
        <span className="hw-headfig">{loading ? "…" : rows.length}<i>clients</i></span>
      </div>

      {loading ? <div className="hw-skel" /> : rows.length === 0 ? (
        <p className="hw-empty hw-empty-good">Everyone's been contacted recently. ✓</p>
      ) : (
        <div className="hw-neglect-list">
          {rows.map((r, i) => (
            <div className={`hw-neglect-row ${sev(r.days)}`} key={r.id} style={{ animationDelay: `${i * 0.07}s` }}>
              <span className="hw-neglect-dot" />
              <span className="hw-neglect-name">{r.name}</span>
              <span className="hw-neglect-days">{r.days >= 999 ? "never" : `${r.days}d`}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

/* =====================================================================
   TEAM BONUS — total to pay + top earners, animated bars
   ===================================================================== */
function TeamBonusWidget() {
  const nav = useNavigate();
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<{ name: string; amount: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const now = new Date();
      const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const { data: bs } = await supabase.from("billing_settings").select("bonus_lag_months").eq("id", "default").maybeSingle();
      const lag = Number((bs as any)?.bonus_lag_months ?? 2);
      const [y, m] = period.split("-").map(Number);
      const fd = new Date(y, m - 1 - lag, 1);
      const forMonth = `${fd.getFullYear()}-${String(fd.getMonth() + 1).padStart(2, "0")}`;

      const [{ data: inv }, { data: ut }, { data: prof }] = await Promise.all([
        supabase.from("invoices").select("project_id, amount, period, status").eq("period", forMonth),
        supabase.from("user_targets").select("*"),
        supabase.from("profiles").select("id, first_name, last_name, role"),
      ]);
      if (!alive) return;
      // Very light approximation for the home glance: bonus ≈ invoiced × pct1,
      // attributed to consultants who delivered. Detailed calc lives in Management.
      const capById: Record<string, any> = {};
      (ut ?? []).forEach((r: any) => { capById[r.user_id] = r; });
      const nameById: Record<string, string> = {};
      (prof ?? []).forEach((r: any) => { nameById[r.id] = [r.first_name, r.last_name].filter(Boolean).join(" ") || "—"; });

      // sum invoiced this bonus-month, then apply the average min pct as a proxy
      const invoiced = (inv ?? []).reduce((s: number, r: any) => s + (Number(r.amount) || 0), 0);
      const former = await loadInactiveIds().catch(() => new Set<string>());
      const consultants = (prof ?? []).filter((p: any) => p.role === "consultant" && !former.has(p.id));
      const avgPct = consultants.length
        ? consultants.reduce((s: number, p: any) => s + (Number(capById[p.id]?.bonus_pct_1) || 3), 0) / consultants.length
        : 3;
      const est = invoiced * (avgPct / 100);
      setTotal(est);
      // top earners proxy: split evenly-ish weighted by their min target
      const weights = consultants.map((p: any) => ({ name: nameById[p.id], w: Number(capById[p.id]?.min_days_month) || 10 }));
      const wsum = weights.reduce((s, x) => s + x.w, 0) || 1;
      setRows(weights.map((x) => ({ name: x.name, amount: est * (x.w / wsum) })).sort((a, b) => b.amount - a.amount).slice(0, 4));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const maxAmt = Math.max(1, ...rows.map((r) => r.amount));

  return (
    <aside className="hw hw-bonus" onClick={() => nav("/management")} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && nav("/management")}>
      <span className="hw-glow" aria-hidden="true" />
      <div className="hw-head">
        <span className="hw-eyebrow">Team bonus</span>
        <span className="hw-headfig hw-headfig-neon">{loading ? "…" : eur(total)}<i>€</i></span>
      </div>

      {loading ? <div className="hw-skel" /> : rows.length === 0 ? (
        <p className="hw-empty">No bonus this cycle.</p>
      ) : (
        <div className="hw-bonus-list">
          {rows.map((r, i) => (
            <div className="hw-bonus-row" key={i} style={{ animationDelay: `${i * 0.08}s` }}>
              <span className="hw-bonus-name">{r.name}</span>
              <span className="hw-bonus-bar"><span className="hw-bonus-fill" style={{ width: `${(r.amount / maxAmt) * 100}%` }} /></span>
              <span className="hw-bonus-amt">{eur(r.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
/* =====================================================================
   MANAGEMENT SUMMARY — outstanding, invoiced, backlog, bonus
   ===================================================================== */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
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

function ManagementSummary() {
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
      const [{ data: pj }, roles] = await Promise.all([
        supabase.from("projects").select("*"),
        loadRoles(),
      ]);
      const legacy = legacyRoleMap(roles);
      const projects: Record<string, any> = Object.fromEntries(((pj ?? []) as any[]).map((p) => [p.id, p]));
      // each project's roles (legacy rows read through the old columns)
      const linesById: Record<string, ReturnType<typeof roleLinesOfRow>> = {};
      ((pj ?? []) as any[]).forEach((p) => {
        const out: ReturnType<typeof roleLinesOfRow> = [];
        for (const l of roleLinesOfRow(p)) {
          const roleId = resolveRoleKey(l.roleId, legacy);
          const same = out.find((x) => x.roleId === roleId);
          if (same) same.days += l.days; else out.push({ ...l, roleId });
        }
        linesById[p.id] = out;
      });

      // Entries: consumed days per project + invoiced base for bonus
      const { data: ce } = await supabase
        .from("calendar_entries")
        .select("user_id, project_id, entry_date, billable, status, billing_line, role_id, billing_period, work_type_id");

      // Backlog value = sold value − delivered value, role by role, across live projects
      const deliveredByProj: Record<string, Record<string, number>> = {};
      ((ce ?? []) as any[]).forEach((e) => {
        if (e.status === "cancelled" || e.billing_line === "closure" || e.billing_line === "sales") return;
        if (!e.project_id) return;
        const k = resolveRoleKey(roleKeyOf(e), legacy);
        const d = (deliveredByProj[e.project_id] ??= {});
        d[k] = (d[k] ?? 0) + (Number(e.billable) || 0);
      });
      let backlogValue = 0;
      ((pj ?? []) as any[]).forEach((p) => {
        if (p.status && p.status !== "active" && p.status !== "live" && p.status !== "open") return;
        const delivered = deliveredByProj[p.id] ?? {};
        for (const l of linesById[p.id] ?? []) {
          backlogValue += Math.max(0, l.days - (delivered[l.roleId] ?? 0)) * lineRate(l);
        }
      });

      // Bonus to pay this month = invoiced N months ago × tiered pct, per consultant
      const forMonth = shiftPeriod(thisPeriod, -bonusLag);
      const { data: ut } = await supabase.from("user_targets")
        .select("user_id, min_days_month, min_billing_month, bonus_pct_1, high_days_month, high_billing_month, bonus_pct_2");
      const caps: Record<string, any> = Object.fromEntries(((ut ?? []) as any[]).map((r) => [r.user_id, r]));

      const invByUser: Record<string, { amount: number; days: number }> = {};
      ((ce ?? []) as any[]).forEach((e) => {
        if (e.status === "cancelled" || e.billing_line === "closure") return;
        if (!e.project_id || !e.user_id) return;
        const p = projects[e.project_id];
        if (!p) return;
        const key = resolveRoleKey(roleKeyOf(e), legacy);
        if (key !== "sales" && !roleCounts(key, roles)) return;   // roles that don't count (connector) stay out
        const per = e.billing_period || periodForDate(e.entry_date, cutoffs, defaultCutoffDay);
        if (per !== forMonth) return;
        const rate = rateOn(linesById[e.project_id] ?? [], key);
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
export default function ManagementHome() {
  return (
    <div className="mh">
      <div className="mh-cell mh-sum"><ManagementSummary /></div>
      <div className="mh-cell mh-pipe"><SalesPipelineWidget /></div>
      <div className="mh-cell mh-neglect"><NeglectedClientsWidget /></div>
      <div className="mh-cell mh-bonus"><TeamBonusWidget /></div>
    </div>
  );
}