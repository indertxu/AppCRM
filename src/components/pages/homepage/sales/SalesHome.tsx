/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home · SALES
 *
 * The right-hand side of the home page for the sales team: your pipeline in
 * four figures, your deals by stage and the deals that need you now.
 * A rep sees their own deals (owner or on the team); boss and sales managers
 * see the whole team's.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listTrackings, loadTrackingTeams, loadPotentialTotals, type Tracking } from "../../sales/sales/salesApi";
import { listPipelines, loadPhasesByPipeline, type Phase, type Pipeline } from "../../settings/pipelineApi";
import { listCompanies } from "../../companies/companiesApi";
import { isoDay } from "../shared/HomeCalendar";
import "./SalesHome.css";

const eur = (n: number) => `${Math.round(n).toLocaleString("es-ES")} €`;
const short = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M €` : n >= 10_000 ? `${Math.round(n / 1000)}k €` : eur(n));
const daysBetween = (a: string, b: string) => Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);

interface Props { userId: string; seesTeam: boolean }
interface Attention { t: Tracking; reason: string; tone: "late" | "soon" | "idle"; rank: number }

export default function SalesHome({ userId, seesTeam }: Props) {
  const nav = useNavigate();
  const today = isoDay(new Date());
  const [loading, setLoading] = useState(true);
  const [deals, setDeals] = useState<Tracking[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [pipes, setPipes] = useState<Pipeline[]>([]);
  const [phases, setPhases] = useState<Record<string, Phase[]>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [pipeSel, setPipeSel] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const all = listTrackings().catch(() => [] as Tracking[]);
    Promise.all([
      all,
      loadTrackingTeams().catch(() => ({ members: {} as Record<string, string[]>, owners: {} as Record<string, string> })),
      loadPotentialTotals({ trackings: all }).catch(() => ({} as Record<string, number>)),
      listPipelines().catch(() => [] as Pipeline[]),
      loadPhasesByPipeline().catch(() => ({} as Record<string, Phase[]>)),
      listCompanies().catch(() => [] as any[]),
    ]).then(([ts, team, pt, ps, ph, cos]) => {
      if (!alive) return;
      const mine = seesTeam ? ts : ts.filter((t) => team.owners[t.id] === userId || (team.members[t.id] ?? []).includes(userId));
      setDeals(mine);
      setTotals(pt);
      const sales = ps.filter((p) => p.is_sales);
      setPipes(sales);
      setPhases(ph);
      setNames(Object.fromEntries((cos as any[]).map((c) => [c.id, c.name])));
      // Start on the pipeline with most open deals.
      const count = (id: string) => mine.filter((t) => t.pipeline_id === id && t.status === "active").length;
      setPipeSel([...sales].sort((a, b) => count(b.id) - count(a.id))[0]?.id ?? null);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [userId, seesTeam]);

  const titleOf = (t: Tracking) => (t.deal_name ?? "").trim() || (t.company_id ? names[t.company_id] : "") || "Deal";
  const phaseOf = (t: Tracking) => (phases[t.pipeline_id ?? ""] ?? []).find((p) => p.id === t.current_phase_id) ?? null;
  const closeDate = (t: Tracking) => t.mgr_close_date || t.rep_close_date || null;
  const probOf = (t: Tracking) => {
    const p = t.mgr_close_prob ?? t.rep_close_prob ?? phaseOf(t)?.close_probability ?? null;
    return p == null ? 0 : Number(p) / 100;
  };

  const active = useMemo(() => deals.filter((t) => t.status === "active"), [deals]);
  const kpi = useMemo(() => {
    const inPlay = active.reduce((s, t) => s + (totals[t.id] ?? 0), 0);
    const weighted = active.reduce((s, t) => s + (totals[t.id] ?? 0) * probOf(t), 0);
    const closing = active.filter((t) => { const d = closeDate(t); return d && daysBetween(today, d) >= 0 && daysBetween(today, d) <= 30; });
    return {
      open: active.length, inPlay, weighted,
      closing: closing.length, closingValue: closing.reduce((s, t) => s + (totals[t.id] ?? 0), 0),
      won: deals.filter((t) => t.status === "won").length,
    };
  }, [active, deals, totals]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deals by stage, for the chosen pipeline.
  const stages = useMemo(() => {
    const list = (phases[pipeSel ?? ""] ?? []).filter((p) => !p.sales_outcome && p.sales_visible !== false);
    return list.map((p) => {
      const here = active.filter((t) => t.current_phase_id === p.id);
      return { id: p.id, name: p.name, color: p.color, count: here.length, value: here.reduce((s, t) => s + (totals[t.id] ?? 0), 0) };
    });
  }, [phases, pipeSel, active, totals]);
  const maxStage = Math.max(1, ...stages.map((s) => s.count));

  // What needs you: overdue close dates, closing soon, or no close date at all.
  const attention = useMemo<Attention[]>(() => active.map((t) => {
    const d = closeDate(t);
    if (!d) return { t, reason: "No close date", tone: "idle" as const, rank: 3 };
    const diff = daysBetween(today, d);
    if (diff < 0) return { t, reason: `Close date passed ${-diff}d ago`, tone: "late" as const, rank: 0 - diff / 1000 };
    if (diff <= 14) return { t, reason: diff === 0 ? "Closes today" : `Closes in ${diff}d`, tone: "soon" as const, rank: 1 + diff / 100 };
    return null;
  }).filter(Boolean).sort((a, b) => a!.rank - b!.rank || (totals[b!.t.id] ?? 0) - (totals[a!.t.id] ?? 0)).slice(0, 20) as Attention[],
  [active, totals, today]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (t: Tracking) => nav(`/sales?tracking=${t.id}`);

  return (
    <div className="sh">
      {/* ---------- four figures ---------- */}
      <section className="sh-kpis" aria-label={seesTeam ? "Team pipeline" : "Your pipeline"}>
        <article className="sh-kpi is-hero" style={{ ["--i" as string]: 0 } as React.CSSProperties}>
          <span className="sh-kpi-k">{seesTeam ? "Team pipeline" : "Your pipeline"}</span>
          <b className="sh-kpi-v">{loading ? "—" : short(kpi.inPlay)}</b>
          <span className="sh-kpi-s">{loading ? "" : `${kpi.open} open ${kpi.open === 1 ? "deal" : "deals"} · ${kpi.won} won`}</span>
          <span className="sh-kpi-glow" aria-hidden="true" />
        </article>
        <article className="sh-kpi" style={{ ["--i" as string]: 1 } as React.CSSProperties}>
          <span className="sh-kpi-k">Weighted forecast</span>
          <b className="sh-kpi-v">{loading ? "—" : short(kpi.weighted)}</b>
          <span className="sh-kpi-s">{loading || !kpi.inPlay ? "" : `${Math.round((kpi.weighted / kpi.inPlay) * 100)}% of the pipeline`}</span>
          <span className="sh-kpi-bar"><i style={{ width: `${kpi.inPlay ? Math.min(100, (kpi.weighted / kpi.inPlay) * 100) : 0}%` }} /></span>
        </article>
        <article className="sh-kpi" style={{ ["--i" as string]: 2 } as React.CSSProperties}>
          <span className="sh-kpi-k">Closing in 30 days</span>
          <b className="sh-kpi-v">{loading ? "—" : kpi.closing}</b>
          <span className="sh-kpi-s">{loading ? "" : kpi.closing ? short(kpi.closingValue) : "Nothing expected"}</span>
        </article>
        <article className="sh-kpi" style={{ ["--i" as string]: 3 } as React.CSSProperties}>
          <span className="sh-kpi-k">Need attention</span>
          <b className={`sh-kpi-v ${attention.some((a) => a.tone === "late") ? "is-warn" : ""}`}>{loading ? "—" : attention.length}</b>
          <span className="sh-kpi-s">{loading ? "" : attention.length ? `${attention.filter((a) => a.tone === "late").length} overdue` : "All on track"}</span>
        </article>
      </section>

      <div className="sh-row">
        {/* ---------- by stage ---------- */}
        <section className="sh-card sh-stages">
          <header className="sh-head">
            <div>
              <span className="sh-eyebrow">Deals by stage</span>
              <h3 className="sh-title">{pipes.find((p) => p.id === pipeSel)?.name ?? "Pipeline"}</h3>
            </div>
            {pipes.length > 1 && (
              <div className="sh-pipes" role="tablist" aria-label="Pipeline">
                {pipes.map((p) => (
                  <button key={p.id} role="tab" aria-selected={p.id === pipeSel} className={p.id === pipeSel ? "is-on" : ""} onClick={() => setPipeSel(p.id)}>{p.name}</button>
                ))}
              </div>
            )}
          </header>
          {loading ? <div className="sh-skel" /> : stages.length === 0 ? (
            <p className="sh-empty">No stages in this pipeline yet.</p>
          ) : (
            <ol className="sh-funnel" key={pipeSel ?? ""}>
              {stages.map((s, i) => (
                <li key={s.id} style={{ ["--i" as string]: i } as React.CSSProperties} onClick={() => nav("/sales")}>
                  <span className="sh-funnel-name"><i style={{ background: s.color || undefined }} />{s.name}</span>
                  <span className={`sh-funnel-bar ${s.count ? "" : "is-zero"}`}>
                    {s.count > 0 && <i style={{ width: `${(s.count / maxStage) * 100}%` }} />}
                    <b>{s.count}</b>
                  </span>
                  <span className="sh-funnel-val">{s.value ? short(s.value) : "—"}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* ---------- needs you ---------- */}
        <section className="sh-card sh-attn">
          <header className="sh-head">
            <div>
              <span className="sh-eyebrow">Needs you</span>
              <h3 className="sh-title">Deals to move</h3>
            </div>
            <button className="sh-link" onClick={() => nav("/sales")}>All deals →</button>
          </header>
          {loading ? <div className="sh-skel" /> : attention.length === 0 ? (
            <div className="sh-ok">
              <span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" /></svg></span>
              <b>Every open deal has a close date ahead.</b>
            </div>
          ) : (
            <ul className="sh-attn-list">
              {attention.map((a, i) => (
                <li key={a.t.id} style={{ ["--i" as string]: i } as React.CSSProperties}>
                  <button onClick={() => open(a.t)}>
                    <span className="sh-attn-av" aria-hidden="true">{titleOf(a.t).charAt(0).toUpperCase()}</span>
                    <span className="sh-attn-body">
                      <b>{titleOf(a.t)}</b>
                      <small>{phaseOf(a.t)?.name ?? "—"}{totals[a.t.id] ? ` · ${short(totals[a.t.id])}` : ""}</small>
                    </span>
                    <span className={`sh-attn-why is-${a.tone}`}>{a.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}