/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { supabase } from "../../api/supabase";
import { listHandoffs, markHandoffConverted, dismissHandoff, type Handoff } from "../sales/salesApi";
import "./IncomingPanel.css";

const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

export default function IncomingPanel() {
  const [rows, setRows] = useState<Handoff[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    listHandoffs("pending").then(setRows).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Turn a handoff into a client + a bare project, then mark it converted.
  const convert = async (h: Handoff) => {
    setBusy(h.id);
    try {
      const name = h.company_name || "New client";
      const { data: client, error: cErr } = await supabase.from("clients").insert({ name }).select("id").single();
      if (cErr || !client) { alert(`Could not create client: ${cErr?.message ?? "unknown"}`); return; }

      // Create a bare project shell — the rest is filled in by hand in Clients.
      const { error: pErr } = await supabase.from("projects").insert({
        client_id: client.id,
        status: "open",
        consultor_days: 0, connector_days: 0, supervision_days: 0,
        price_per_day: 0, supervision_price: 0,
        taxed: false, tax_rate: 0, payment_days: 0,
        discount_mode: "none", discount_value: 0,
        supervision_discount_mode: "none", supervision_discount_value: 0,
        phases: [], team: [], contacts: [],
      });
      if (pErr) { alert(`Client created, but project failed: ${pErr.message}`); }

      await markHandoffConverted(h.id, client.id);
      setRows((xs) => xs.filter((x) => x.id !== h.id));
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (h: Handoff) => {
    setBusy(h.id);
    try {
      await dismissHandoff(h.id);
      setRows((xs) => xs.filter((x) => x.id !== h.id));
    } finally { setBusy(null); }
  };

  if (loading) return <div className="inc"><p className="inc-empty">Loading…</p></div>;

  return (
    <div className="inc">
      <div className="inc-head">
        <div>
          <span className="inc-eyebrow">From sales</span>
          <h2 className="inc-title">Incoming handoffs</h2>
        </div>
        <span className="inc-count">{rows.length} pending</span>
      </div>

      {rows.length === 0 ? (
        <div className="inc-empty-state">
          <div className="inc-empty-art">✦</div>
          <p>No incoming handoffs.</p>
          <span>Won deals sent from sales will appear here.</span>
        </div>
      ) : (
        <div className="inc-grid">
          {rows.map((h) => (
            <div className="inc-card" key={h.id}>
              <div className="inc-card-top">
                <div className="inc-card-id">
                  <span className="inc-card-client">{h.company_name || "Unknown company"}</span>
                  <span className="inc-card-dest">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                    {h.dest_pipeline_name || "Pipeline"}
                  </span>
                </div>
                {h.potential_value > 0 && <span className="inc-card-val">{eur(h.potential_value)} €</span>}
              </div>

              {h.services && h.services.length > 0 && (
                <div className="inc-svcs">
                  <span className="inc-svcs-label">Recommended services</span>
                  {h.services.map((s, i) => (
                    <div className="inc-svc" key={i}>
                      <span>{s.label}</span>
                      {s.price > 0 && <b>{eur(s.price)} €</b>}
                    </div>
                  ))}
                </div>
              )}

              <div className="inc-card-foot">
                <span className="inc-date">{fmtDate(h.created_at)}</span>
                <div className="inc-actions">
                  <button className="inc-dismiss" onClick={() => dismiss(h)} disabled={busy === h.id}>Dismiss</button>
                  <button className="inc-convert" onClick={() => convert(h)} disabled={busy === h.id}>
                    {busy === h.id ? "Creating…" : "Create client"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}