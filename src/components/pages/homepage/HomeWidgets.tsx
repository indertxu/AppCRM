/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import "./HomeWidgets.css";

const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const daysSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

/* =====================================================================
   SALES PIPELINE — trackings by stage, with an animated funnel
   ===================================================================== */
export function SalesPipelineWidget() {
  const nav = useNavigate();
  const [stages, setStages] = useState<{ name: string; count: number; value: number }[]>([]);
  const [totals, setTotals] = useState({ active: 0, won: 0, value: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: trk } = await supabase
        .from("trackings")
        .select("id, status, current_phase_id, product_price, pipeline_id");
      const { data: ph } = await supabase.from("pipeline_phases").select("id, name, pos_x, sales_visible");
      if (!alive) return;
      const phaseName: Record<string, { name: string; x: number }> = {};
      (ph ?? []).forEach((p: any) => { if (p.sales_visible !== false) phaseName[p.id] = { name: p.name, x: p.pos_x ?? 0 }; });

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
export function NeglectedClientsWidget() {
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
export function TeamBonusWidget() {
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
      const consultants = (prof ?? []).filter((p: any) => p.role === "consultant");
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