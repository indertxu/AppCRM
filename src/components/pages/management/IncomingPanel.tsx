/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
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

/* ===================================================================
   Presentation helpers. Same language as the other Management tabs:
   count-ups, cursor spotlight and tilt.
   =================================================================== */
const icVars = (o: Record<string, string | number>) => o as CSSProperties;
const icReduced = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
function useIcCount(target: number, ms = 1100) {
  const [value, setValue] = useState(() => (icReduced() ? target : 0));
  const from = useRef(value);
  useEffect(() => {
    if (icReduced()) { from.current = target; setValue(target); return; }
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
function IcCount({ value, fmt = eur }: { value: number; fmt?: (n: number) => string }) {
  return <>{fmt(useIcCount(value))}</>;
}
function icSpot(e: ReactPointerEvent<HTMLElement>) {
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
const IC_ICON = {
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  days: "M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  mix: "M4 19V9M10 19V5M16 19v-7M22 19H2",
  arrow: "M5 12h13M12 5l7 7-7 7",
  lock: "M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 8 0v4",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  empty: "M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4",
  build: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z",
};
function IcIcon({ d, w = 2 }: { d: string; w?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

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

  /* ---------- presentation ---------- */
  const newCount = rows.filter((h) => !existingClient(h)).length;
  const mixMax = Math.max(1, ...stats.byType.map(([, s]) => s.value));

  if (loading) {
    return (
      <div className="ic">
        <section className="ic-sheet is-only">
          <div className="ic-empty"><span className="ic-empty-art is-busy"><IcIcon d={IC_ICON.inbox} w={1.6} /></span><p>Loading handoffs…</p></div>
        </section>
      </div>
    );
  }

  return (
    <div className="ic" onPointerMove={icSpot}>
      {/* ---------- headline cards on the dark band ---------- */}
      {rows.length > 0 && (
        <section className="ic-hero">
          <div className="ic-kpis">
            <div className="ic-kpi is-main" data-spot="tilt" style={icVars({ "--i": 0 })}>
              <span className="ic-kpi-head">
                <span className="ic-kpi-ico"><IcIcon d={IC_ICON.inbox} w={1.9} /></span>
                <span className="ic-kpi-label">Incoming value</span>
              </span>
              <b className="ic-val is-xl"><IcCount value={stats.value} /><em>€</em></b>
              <small className="ic-kpi-sub">across {rows.length} handoff{rows.length === 1 ? "" : "s"}</small>
              <span className="ic-split">
                <span><i className="is-new" /><b>{newCount}</b> new client{newCount === 1 ? "" : "s"}</span>
                <span><i className="is-existing" /><b>{rows.length - newCount}</b> existing</span>
              </span>
            </div>

            <div className="ic-kpi" data-spot="tilt" style={icVars({ "--i": 1 })}>
              <span className="ic-kpi-head">
                <span className="ic-kpi-ico"><IcIcon d={IC_ICON.days} w={1.9} /></span>
                <span className="ic-kpi-label">Work to schedule</span>
              </span>
              <b className="ic-val"><IcCount value={stats.days} fmt={num} /><em>days</em></b>
              <small className="ic-kpi-sub">
                {stats.days > 0 ? `${eur(stats.value / stats.days)} € per day on average` : "No days estimated"}
              </small>
            </div>

            <div className="ic-kpi is-mix" data-spot="tilt" style={icVars({ "--i": 2 })}>
              <span className="ic-kpi-head">
                <span className="ic-kpi-ico"><IcIcon d={IC_ICON.mix} w={1.9} /></span>
                <span className="ic-kpi-label">By service</span>
              </span>
              <ul className="ic-mix">
                {stats.byType.slice(0, 4).map(([label, s], i) => (
                  <li key={label} style={icVars({ "--d": i })}>
                    <span className="ic-mix-name"><em>{s.count}×</em>{label}</span>
                    <span className="ic-mix-days">{num(s.days)}d</span>
                    <b className="ic-mix-val">{eur(s.value)} €</b>
                    <span className="ic-mix-bar" aria-hidden="true"><i style={{ width: `${(s.value / mixMax) * 100}%` }} /></span>
                  </li>
                ))}
                {stats.byType.length > 4 && <li className="ic-mix-more">+{stats.byType.length - 4} more</li>}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* ---------- light sheet ---------- */}
      <section className={`ic-sheet ${rows.length === 0 ? "is-only" : ""}`}>
        <header className="ic-sheet-h">
          <h2>Incoming handoffs <span className="ic-count">{rows.length}</span></h2>
          {rows.length > 0 && (
            <div className="ic-filters">
              <div className="ic-search">
                <span className="ic-search-ico"><IcIcon d={IC_ICON.search} w={2.1} /></span>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client, service…" />
                {q && <button type="button" onClick={() => setQ("")} aria-label="Clear">×</button>}
              </div>
              <div className="ic-sel">
                <Select value={fClient} onChange={setFClient} placeholder="All clients"
                  options={[{ value: "", label: "All clients" }, ...clientOptions]} />
              </div>
              <div className="ic-sel">
                <Select value={fService} onChange={setFService} placeholder="All services"
                  options={[{ value: "", label: "All services" }, ...serviceOptions]} />
              </div>
              <div className="ic-sel">
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
              {anyFilter && <button type="button" className="ic-clear" onClick={clearFilters}>Clear</button>}
            </div>
          )}
        </header>

        {rows.length === 0 ? (
          <div className="ic-empty">
            <span className="ic-empty-art"><IcIcon d={IC_ICON.inbox} w={1.6} /></span>
            <p>No incoming handoffs.</p>
            <small>Won deals sent from sales will appear here.</small>
          </div>
        ) : shown.length === 0 ? (
          <div className="ic-empty">
            <span className="ic-empty-art"><IcIcon d={IC_ICON.search} w={1.6} /></span>
            <p>No handoffs match those filters.</p>
            <button type="button" className="ic-clear" onClick={clearFilters}>Clear filters</button>
          </div>
        ) : (
          <div className="ic-list">
            <div className="ic-head ic-grid" aria-hidden="true">
              <span>Company</span>
              <span>Services</span>
              <span className="ic-r">Days</span>
              <span className="ic-r">Value</span>
              <span />
            </div>
            {shown.map((h, hi) => {
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
                <article
                  className={`ic-row ${blocked ? "is-locked" : client ? "is-existing" : "is-new"}`}
                  key={h.id}
                  style={icVars({ "--i": Math.min(hi, 14) })}
                >
                  <div className="ic-row-main ic-grid" data-spot="">
                    <span className="ic-who">
                      <span className="ic-av">{blocked ? <IcIcon d={IC_ICON.lock} w={2} /> : monogram(h.company_name || "?")}</span>
                      <span className="ic-who-t">
                        <span className="ic-name">
                          <b>{h.company_name || "Unknown company"}</b>
                          <span className={`ic-tag ${client ? "is-existing" : "is-new"}`}>{client ? "Existing" : "New client"}</span>
                        </span>
                        <span className="ic-route">
                          <span>Sales</span>
                          <IcIcon d={IC_ICON.arrow} w={2.2} />
                          <b>{h.dest_pipeline_name || "Pipeline"}</b>
                          <em>Arrived {ago(h.created_at)}</em>
                        </span>
                      </span>
                    </span>

                    <span className="ic-svcs">
                      {svcs.length === 0 ? <em className="ic-none">No services</em> : svcs.map((s, i) => (
                        <span className="ic-svc" key={i}>
                          <b>{s.label}</b>
                          {s.days ? <small>{num(s.days)}d</small> : null}
                          {svcs.length > 1 && <em>{eur(s.price || 0)} €</em>}
                        </span>
                      ))}
                    </span>

                    <span className="ic-num">
                      <b>{days > 0 ? <>{num(days)}<em>d</em></> : "—"}</b>
                      {days > 0 && <small>{eur(lineRate)} €/day</small>}
                    </span>

                    <span className="ic-num is-val"><b>{eur(total)} €</b></span>

                    <span className="ic-actions">
                      <button type="button" className="ic-act is-ghost" onClick={() => dismiss(h)} disabled={busy === h.id}>Dismiss</button>
                      <button
                        type="button"
                        className={`ic-act ${blocked ? "is-locked" : "is-go"}`}
                        onClick={() => setConvert(h)}
                        disabled={busy === h.id || !!blocked}
                        title={blocked ? "The previous project has to be finalised first" : undefined}
                      >
                        {blocked ? <><IcIcon d={IC_ICON.lock} w={2.2} />Locked</> : <>Build project<IcIcon d={IC_ICON.arrow} w={2.4} /></>}
                      </button>
                    </span>
                  </div>

                  {blocked && (
                    <div className="ic-lock">
                      <span className="ic-lock-ico"><IcIcon d={IC_ICON.lock} w={2} /></span>
                      <span className="ic-lock-txt">
                        <b>
                          {blocked.missing
                            ? "Waiting on the machine installation, which has not started yet"
                            : "Unlocks when the machine installation is finalised"}
                        </b>
                        {!blocked.missing && (
                          <small>{num(blocked.done)} of {num(blocked.signed)} delivered, {num(blocked.signed - blocked.done)} left</small>
                        )}
                      </span>
                      <span className="ic-lock-bar" aria-hidden="true"><i style={{ width: `${blocked.pct}%` }} /></span>
                      <b className="ic-lock-pct">{blocked.pct}%</b>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

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