/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../api/supabase";
import { listHandoffs, dismissHandoff, type Handoff } from "../sales/salesApi";
import "./IncomingPanel.css";

const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
const ago = (iso: string) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : fmtDate(iso);
};
const monogram = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const num = (n: number) => Number(n).toLocaleString("es-ES", { maximumFractionDigits: 2 });

interface ClientRow { id: string; name: string; company_id: string | null }

export default function IncomingPanel() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Handoff[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    listHandoffs("pending").then(setRows).catch(() => {}).finally(() => setLoading(false));
    supabase.from("clients").select("id,name,company_id")
      .then(({ data }) => setClients((data ?? []) as ClientRow[]));
  };
  useEffect(load, []);

  /**
   * Is this company already a client? Matched on company_id, falling back to
   * the name for clients created before the two were linked.
   */
  const existingClient = (h: Handoff): ClientRow | null =>
    clients.find((c) => h.company_id && c.company_id === h.company_id)
    ?? clients.find((c) => h.company_name && c.name.toLowerCase() === h.company_name.toLowerCase())
    ?? null;

  /**
   * Hand the deal to the Clients page with everything we already know filled
   * in, instead of silently creating an empty shell here. The user reviews and
   * completes it in the form they already know.
   */
  const openInClients = async (h: Handoff) => {
    setBusy(h.id);
    try {
      let company: any = null;
      let contacts: any[] = [];
      if (h.company_id) {
        const { data: co } = await supabase.from("companies").select("*").eq("id", h.company_id).maybeSingle();
        company = co;
        const { data: links } = await supabase.from("company_contacts").select("contact_id").eq("company_id", h.company_id);
        const ids = (links ?? []).map((l: any) => l.contact_id);
        if (ids.length) {
          const { data: cts } = await supabase.from("contacts").select("*").in("id", ids);
          contacts = cts ?? [];
        }
      }
      const client = existingClient(h);
      navigate("/clients", {
        state: {
          handoff: {
            handoffId: h.id,
            clientId: client?.id ?? null,
            clientName: client?.name ?? h.company_name ?? "New client",
            companyId: h.company_id,
            destPipelineName: h.dest_pipeline_name,
            potentialValue: h.potential_value,
            services: h.services ?? [],
            company,
            contacts,
          },
        },
      });
    } finally { setBusy(null); }
  };

  const dismiss = async (h: Handoff) => {
    setBusy(h.id);
    try {
      await dismissHandoff(h.id);
      setRows((xs) => xs.filter((x) => x.id !== h.id));
    } finally { setBusy(null); }
  };

  /** Totals across everything still waiting, split by service. */
  const stats = useMemo(() => {
    let value = 0, days = 0;
    const byType: Record<string, { count: number; days: number; value: number }> = {};
    rows.forEach((h) => {
      (h.services ?? []).filter((s: any) => s.kind !== "product").forEach((s: any) => {
        const v = Number(s.price) || 0;
        const d = Number(s.days) || 0;
        value += v; days += d;
        const k = s.label || "Service";
        byType[k] ??= { count: 0, days: 0, value: 0 };
        byType[k].count += 1; byType[k].days += d; byType[k].value += v;
      });
    });
    return { value, days, byType: Object.entries(byType).sort((a, b) => b[1].value - a[1].value) };
  }, [rows]);

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

      {rows.length > 0 && (
        <div className="inc-kpis">
          <div className="inc-kpi">
            <span className="inc-kpi-label">Incoming value</span>
            <b className="inc-kpi-fig">{eur(stats.value)} €</b>
            <span className="inc-kpi-sub">across {rows.length} handoff{rows.length === 1 ? "" : "s"}</span>
          </div>
          <div className="inc-kpi">
            <span className="inc-kpi-label">Work to schedule</span>
            <b className="inc-kpi-fig">{num(stats.days)}<em>days</em></b>
            <span className="inc-kpi-sub">
              {stats.days > 0 ? `${eur(stats.value / stats.days)} € per day average` : "no days estimated"}
            </span>
          </div>
          <div className="inc-kpi inc-kpi-mix">
            <span className="inc-kpi-label">By service</span>
            <ul className="inc-mix">
              {stats.byType.map(([label, s]) => (
                <li key={label}>
                  <span className="inc-mix-n">{s.count}×</span>
                  <span className="inc-mix-name">{label}</span>
                  <span className="inc-mix-days">{num(s.days)}d</span>
                  <span className="inc-mix-val">{eur(s.value)} €</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="inc-empty-state">
          <div className="inc-empty-art">✦</div>
          <p>No incoming handoffs.</p>
          <span>Won deals sent from sales will appear here.</span>
        </div>
      ) : (
        <div className="inc-grid">
          {rows.map((h) => {
            const client = existingClient(h);
            const all = h.services ?? [];
            const svcs = all.filter((x: any) => x.kind !== "product");
            const prods = all.filter((x: any) => x.kind === "product");
            const total = svcs.reduce((s, x) => s + (Number(x.price) || 0), 0);
            const days = svcs.reduce((s, x) => s + (Number(x.days) || 0), 0);
            return (
              <article className="inc-card" key={h.id}>
                <span className="inc-accent" aria-hidden="true" />

                <header className="inc-hd">
                  <span className="inc-mono">{monogram(h.company_name || "?")}</span>
                  <div className="inc-hd-txt">
                    <h3 className="inc-name">{h.company_name || "Unknown company"}</h3>
                    <p className="inc-route">
                      <span className="inc-route-from">Sales</span>
                      <svg className="inc-route-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M12 5l7 7-7 7" /></svg>
                      <span className="inc-route-to">{h.dest_pipeline_name || "Pipeline"}</span>
                    </p>
                  </div>
                  <span className={`inc-tag ${client ? "is-existing" : "is-new"}`}>
                    {client ? `Existing · ${client.name}` : "New client"}
                  </span>
                </header>

                <div className="inc-body">
                  {prods.length > 0 && (
                    <p className="inc-ctx">
                      <span>Sold with</span>
                      {prods.map((p: any, i: number) => (
                        <em key={i}>{p.label}{p.price > 0 ? ` · ${eur(p.price)} €` : ""}</em>
                      ))}
                    </p>
                  )}
                  {/* With a single service the value block already states the
                      amount and the days, so the ledger would just repeat it. */}
                  {svcs.length > 1 && (
                    <ul className="inc-ledger">
                      {svcs.map((s, i) => (
                        <li key={i}>
                          <span className="inc-l-name">{s.label}</span>
                          {s.days ? <span className="inc-l-days">{num(s.days)}d</span> : <span className="inc-l-days" />}
                          <span className="inc-l-amt">{eur(s.price || 0)} €</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <aside className="inc-side">
                  <span className="inc-val-label">Service value</span>
                  {/* Always derived from the service lines shown below: rows stored before
                      products were split out still carry a product-inclusive total. */}
                  <span className="inc-val">{eur(total)} €</span>
                  <span className="inc-val-sub">
                    {svcs.length === 1 ? svcs[0].label : `${svcs.length} services`}
                  </span>
                  {days > 0 && (
                    <div className="inc-daybox">
                      <span className="inc-days"><b>{num(days)}</b><em>days</em></span>
                      <span className="inc-rate">{eur(total / days)} €/day</span>
                    </div>
                  )}
                </aside>

                <footer className="inc-foot">
                  <span className="inc-when">Arrived {ago(h.created_at)}</span>
                  <div className="inc-actions">
                    <button className="inc-dismiss" onClick={() => dismiss(h)} disabled={busy === h.id}>Dismiss</button>
                    <button className="inc-convert" onClick={() => openInClients(h)} disabled={busy === h.id}>
                      {busy === h.id ? "Opening…" : client ? "Add project" : "Create client"}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M12 5l7 7-7 7" /></svg>
                    </button>
                  </div>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}