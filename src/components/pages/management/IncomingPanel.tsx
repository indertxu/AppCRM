/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../api/supabase";
import { listHandoffs, dismissHandoff, type Handoff } from "../sales/salesApi";
import Select from "../../framework/Select";
import IncomingConvertModal from "./IncomingConvertModal";
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
  const [rows, setRows] = useState<Handoff[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [convert, setConvert] = useState<Handoff | null>(null);
  const [q, setQ] = useState("");
  const [fClient, setFClient] = useState("");
  const [fService, setFService] = useState("");
  const [sort, setSort] = useState("recent");

  /**
   * Which delivery pipeline must finish before another can start.
   *
   * A non-sales pipeline carrying a handover phase is a step before the
   * pipeline it points at, so a handoff landing on that destination stays
   * locked until the earlier project is closed. Read straight from the
   * builder, so changing the chain there changes the gate here.
   */
  const [gate, setGate] = useState<Record<string, string>>({});
  const [gateService, setGateService] = useState<Record<string, string>>({});
  const [prevProjects, setPrevProjects] = useState<Record<string, { done: number; signed: number; closed: boolean; client: string }>>({});

  const loadChain = async () => {
    const { data: pipes } = await supabase.from("pipelines").select("id, name, is_sales");
    const delivery = new Set((pipes ?? []).filter((p: any) => !p.is_sales).map((p: any) => p.id));
    const { data: phases } = await supabase.from("pipeline_phases").select("pipeline_id, handover_to").not("handover_to", "is", null);
    const g: Record<string, string> = {};
    const prior: string[] = [];
    (phases ?? []).forEach((ph: any) => {
      if (delivery.has(ph.pipeline_id) && ph.handover_to) {
        g[ph.handover_to] = ph.pipeline_id;
        prior.push(ph.pipeline_id);
      }
    });
    setGate(g);

    // Which service the earlier pipeline delivers: the sales phase that hands
    // over to it lists exactly that.
    if (prior.length) {
      const { data: srcPhases } = await supabase.from("pipeline_phases")
        .select("id, handover_to").in("handover_to", prior);
      const { data: items } = await supabase.from("pipeline_phase_items")
        .select("phase_id, item_id, item_type")
        .in("phase_id", (srcPhases ?? []).map((x: any) => x.id))
        .eq("item_type", "service");
      const svcByPipe: Record<string, string> = {};
      (items ?? []).forEach((it: any) => {
        const ph = (srcPhases ?? []).find((x: any) => x.id === it.phase_id);
        if (ph?.handover_to) svcByPipe[ph.handover_to] = it.item_id;
      });
      setGateService(svcByPipe);
    }
  };

  const load = () => {
    setLoading(true);
    listHandoffs("pending").then(setRows).catch(() => {}).finally(() => setLoading(false));
    supabase.from("clients").select("id,name,company_id")
      .then(({ data }) => setClients((data ?? []) as ClientRow[]));
  };
  useEffect(load, []);
  useEffect(() => { loadChain(); }, []);

  /** Progress of the project that unlocks each blocked destination. */
  useEffect(() => {
    if (!rows.length || Object.keys(gate).length === 0) return;
    (async () => {
      const companyIds = Array.from(new Set(rows.map((h) => h.company_id).filter(Boolean)));
      if (!companyIds.length) return;
      const { data: cls } = await supabase.from("clients").select("id, name, company_id").in("company_id", companyIds as string[]);
      const clientIds = (cls ?? []).map((c: any) => c.id);
      if (!clientIds.length) return;
      const { data: pjs } = await supabase.from("projects")
        .select("id, client_id, service_id, status, consultor_days, connector_days, supervision_days")
        .in("client_id", clientIds);
      const { data: ents } = await supabase.from("calendar_entries")
        .select("project_id, billable, status")
        .in("project_id", (pjs ?? []).map((p: any) => p.id));

      const doneBy: Record<string, number> = {};
      (ents ?? []).forEach((e: any) => {
        if (e.status === "confirmed") doneBy[e.project_id] = (doneBy[e.project_id] ?? 0) + Number(e.billable || 0);
      });
      const out: Record<string, any> = {};
      (pjs ?? []).forEach((p: any) => {
        const c = (cls ?? []).find((x: any) => x.id === p.client_id);
        out[`${c?.company_id}|${p.service_id}`] = {
          done: doneBy[p.id] ?? 0,
          signed: Number(p.consultor_days || 0) + Number(p.connector_days || 0) + Number(p.supervision_days || 0),
          closed: p.status === "closed",
          client: c?.name ?? "",
        };
      });
      setPrevProjects(out);
    })();
  }, [rows, gate]);

  /**
   * Is this company already a client? Matched on company_id, falling back to
   * the name for clients created before the two were linked.
   */
  const existingClient = (h: Handoff): ClientRow | null =>
    clients.find((c) => h.company_id && c.company_id === h.company_id)
    ?? clients.find((c) => h.company_name && c.name.toLowerCase() === h.company_name.toLowerCase())
    ?? null;

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

  // Per-handoff figures used by the filters/sort.
  const hoValue = (h: Handoff) => (h.services ?? []).filter((s: any) => s.kind !== "product").reduce((s, x: any) => s + (Number(x.price) || 0), 0);
  const hoDays = (h: Handoff) => (h.services ?? []).filter((s: any) => s.kind !== "product").reduce((s, x: any) => s + (Number(x.days) || 0), 0);
  const hoClient = (h: Handoff) => h.company_name || "—";
  const hoServices = (h: Handoff) => (h.services ?? []).filter((s: any) => s.kind !== "product").map((s: any) => s.label || "Service");

  const clientOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((h) => { if (h.company_name) set.add(h.company_name); });
    return Array.from(set).sort().map((n) => ({ value: n, label: n }));
  }, [rows]);
  const serviceOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((h) => hoServices(h).forEach((s) => set.add(s)));
    return Array.from(set).sort().map((n) => ({ value: n, label: n }));
  }, [rows]);

  const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const shown = useMemo(() => {
    const needle = norm(q.trim());
    const list = rows.filter((h) => {
      if (fClient && h.company_name !== fClient) return false;
      if (fService && !hoServices(h).includes(fService)) return false;
      if (needle) {
        const hay = norm([hoClient(h), h.dest_pipeline_name ?? "", ...hoServices(h)].join(" "));
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    return list.sort((a, b) => {
      if (sort === "value") return hoValue(b) - hoValue(a);
      if (sort === "value_asc") return hoValue(a) - hoValue(b);
      if (sort === "days") return hoDays(b) - hoDays(a);
      if (sort === "days_asc") return hoDays(a) - hoDays(b);
      if (sort === "client") return hoClient(a).localeCompare(hoClient(b));
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, fClient, fService, sort]);

  const anyFilter = !!(q || fClient || fService || sort !== "recent");
  const clearFilters = () => { setQ(""); setFClient(""); setFService(""); setSort("recent"); };

  /** Is this handoff waiting on an earlier project, and how far along is it? */
  const blockerOf = (h: Handoff) => {
    const priorPipe = h.dest_pipeline_id ? gate[h.dest_pipeline_id] : null;
    if (!priorPipe || !h.company_id) return null;
    const svc = gateService[priorPipe];
    if (!svc) return null;
    const p = prevProjects[`${h.company_id}|${svc}`];
    if (!p) return { pct: 0, done: 0, signed: 0, ready: false, missing: true };
    if (p.closed) return null;
    const pct = p.signed > 0 ? Math.min(100, Math.round((p.done / p.signed) * 100)) : 0;
    return { pct, done: p.done, signed: p.signed, ready: false, missing: false };
  };

  if (loading) return <div className="inc"><p className="inc-empty">Loading…</p></div>;

  return (
    <div className="inc">
      <div className="inc-head">
        <div>
          <h2 className="inc-title">Incoming handoffs</h2>
        </div>
        {rows.length > 0 && (
          <div className="inc-filters">
            <div className="inc-search">
              <span className="inc-search-ico" aria-hidden="true">⌕</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client, service…" />
              {q && <button className="inc-search-x" onClick={() => setQ("")} aria-label="Clear">×</button>}
            </div>
            <div className="inc-filter">
              <Select value={fClient} onChange={setFClient} placeholder="All clients"
                options={[{ value: "", label: "All clients" }, ...clientOptions]} />
            </div>
            <div className="inc-filter">
              <Select value={fService} onChange={setFService} placeholder="All services"
                options={[{ value: "", label: "All services" }, ...serviceOptions]} />
            </div>
            <div className="inc-filter">
              <Select value={sort} onChange={setSort}
                options={[
                  { value: "recent", label: "Most recent" },
                  { value: "value", label: "Highest value" },
                  { value: "value_asc", label: "Lowest value" },
                  { value: "days", label: "Most days" },
                  { value: "days_asc", label: "Fewest days" },
                  { value: "client", label: "Client A–Z" },
                ]} />
            </div>
            {anyFilter && <button className="inc-clear" onClick={clearFilters}>Clear</button>}
          </div>
        )}
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
      ) : shown.length === 0 ? (
        <div className="inc-empty-state">
          <div className="inc-empty-art">⌕</div>
          <p>No handoffs match those filters.</p>
          <span><button className="inc-clear" onClick={clearFilters}>Clear filters</button></span>
        </div>
      ) : (
        <div className="inc-grid">
          {shown.map((h) => {
            const client = existingClient(h);
            const all = h.services ?? [];
            const svcs = all.filter((x: any) => x.kind !== "product");
            const total = svcs.reduce((s, x) => s + (Number(x.price) || 0), 0);
            const days = svcs.reduce((s, x) => s + (Number(x.days) || 0), 0);
            // Use the real per-line rate stored at handoff time. With one service
            // that's its rate; with several, fall back to a blended average.
            const lineRate = svcs.length === 1 && svcs[0].rate != null
              ? Number(svcs[0].rate)
              : (days > 0 ? total / days : 0);
            const blocked = blockerOf(h);
            return (
              <article className={`inc-card ${blocked ? "is-locked" : ""}`} key={h.id}>
                <span className="inc-accent" aria-hidden="true" />

                <header className="inc-hd">
                  <span className="inc-mono">{monogram(h.company_name || "?")}</span>
                  <div className="inc-hd-txt">
                    <div className="inc-name-row">
                      <h3 className="inc-name">{h.company_name || "Unknown company"}</h3>
                      <span className={`inc-tag ${client ? "is-existing" : "is-new"}`}>
                        {client ? "Existing" : "New"}
                      </span>
                    </div>
                    <p className="inc-route">
                      <span className="inc-route-from">Sales</span>
                      <svg className="inc-route-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M12 5l7 7-7 7" /></svg>
                      <span className="inc-route-to">{h.dest_pipeline_name || "Pipeline"}</span>
                    </p>
                  </div>
                </header>

                <div className="inc-body">
                  {blocked && (
                    <div className="inc-lock">
                      <div className="inc-lock-top">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
                        <span>
                          {blocked.missing
                            ? "Waiting on the machine installation, which has not started yet"
                            : "Unlocks when the machine installation is finalised"}
                        </span>
                        <b>{blocked.pct}%</b>
                      </div>
                      <span className="inc-lock-bar"><i style={{ width: `${blocked.pct}%` }} /></span>
                      {!blocked.missing && (
                        <span className="inc-lock-sub">
                          {num(blocked.done)} of {num(blocked.signed)} delivered · {num(blocked.signed - blocked.done)} left
                        </span>
                      )}
                    </div>
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
                      <span className="inc-rate">{eur(lineRate)} €/day</span>
                    </div>
                  )}
                </aside>

                <footer className="inc-foot">
                  <span className="inc-when">Arrived {ago(h.created_at)}</span>
                  <div className="inc-actions">
                    <button className="inc-dismiss" onClick={() => dismiss(h)} disabled={busy === h.id}>Dismiss</button>
                    <button className="inc-convert" onClick={() => setConvert(h)}
                      disabled={busy === h.id || !!blocked}
                      title={blocked ? "The previous project has to be finalised first" : undefined}>
                      {blocked ? "Locked" : "Build project"}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M12 5l7 7-7 7" /></svg>
                    </button>
                  </div>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {convert && (
        <IncomingConvertModal
          handoff={convert}
          onClose={() => setConvert(null)}
          onConverted={() => {
            setRows((xs) => xs.filter((x) => x.id !== convert.id));
            setConvert(null);
          }}
        />
      )}
    </div>
  );
}