/* =====================================================================
   When each deal entered each phase (tracking_phase_events), by deal, by
   company (its deals) and by contact (the deals they're on) — for the
   "Entered a deal phase … since / before / between …" filter.

   Companies and Contacts filter on the server (SQL 148, phase_cond_sql);
   Clients, Deals and Marketing audiences filter here, so they read the whole
   index once (deal_phase_index(), ≈1 MB for 9k deals) only when a filter
   needs it, and keep it a few minutes.
   ===================================================================== */
import { useEffect, useState } from "react";
import { supabase } from "../../components/api/supabase";

/** One time a deal entered a phase: the phase id and the day (YYYY-MM-DD, UTC). */
export interface PhaseHit { p: string; d: string }
export interface DealPhaseIndex {
  deal: Map<string, PhaseHit[]>;
  company: Map<string, PhaseHit[]>;
  contact: Map<string, PhaseHit[]>;
}
export interface PhaseOpt { value: string; label: string }

const TTL = 5 * 60_000;
let idxCache: { at: number; p: Promise<DealPhaseIndex> } | null = null;
let optCache: { at: number; p: Promise<PhaseOpt[]> } | null = null;

async function readIndex(): Promise<DealPhaseIndex> {
  const { data, error } = await supabase.rpc("deal_phase_index");
  if (error) throw error;
  const phases: string[] = ((data as any)?.phases ?? []).map(String);
  const out: DealPhaseIndex = { deal: new Map(), company: new Map(), contact: new Map() };
  const add = (m: Map<string, PhaseHit[]>, id: string | null, hits: PhaseHit[]) => {
    if (!id || !hits.length) return;
    const cur = m.get(id);
    if (cur) cur.push(...hits); else m.set(id, hits.slice());
  };
  for (const row of ((data as any)?.deals ?? []) as any[]) {
    const [id, co, cts, ev] = row as [string, string | null, string[], [number, string][]];
    const hits = (ev ?? []).map(([i, d]) => ({ p: phases[i], d })).filter((h) => h.p && h.d);
    add(out.deal, id, hits);
    add(out.company, co, hits);
    (cts ?? []).forEach((ct) => add(out.contact, ct, hits));
  }
  return out;
}
/** The whole index (cached for a few minutes). */
export function loadDealPhaseIndex(fresh = false): Promise<DealPhaseIndex> {
  if (!fresh && idxCache && Date.now() - idxCache.at < TTL) return idxCache.p;
  const p = readIndex();
  idxCache = { at: Date.now(), p };
  p.catch(() => { idxCache = null; });
  return p;
}

/** Every phase as "Pipeline · Phase", pipeline by pipeline, in the order of the pipeline's flow. */
export function loadPhaseOptions(fresh = false): Promise<PhaseOpt[]> {
  if (!fresh && optCache && Date.now() - optCache.at < TTL) return optCache.p;
  const p = (async () => {
    const [ph, pl] = await Promise.all([
      supabase.from("pipeline_phases").select("id, name, pipeline_id, pos_x, pos_y"),
      supabase.from("pipelines").select("id, name"),
    ]);
    if (ph.error) throw ph.error;
    const pipe = new Map(((pl.data ?? []) as any[]).map((x) => [x.id, String(x.name ?? "")]));
    return ((ph.data ?? []) as any[])
      .map((x) => ({ id: String(x.id), name: String(x.name ?? ""), pipe: pipe.get(x.pipeline_id) ?? "", x: Number(x.pos_x) || 0, y: Number(x.pos_y) || 0 }))
      .sort((a, b) => a.pipe.localeCompare(b.pipe) || a.x - b.x || a.y - b.y || a.name.localeCompare(b.name))
      .map((x) => ({ value: x.id, label: x.pipe ? `${x.pipe} · ${x.name}` : x.name }));
  })();
  optCache = { at: Date.now(), p };
  p.catch(() => { optCache = null; });
  return p;
}

/** The index, read only while `on` (a phase filter is in the view). null until it arrives. */
export function useDealPhaseIndex(on: boolean): DealPhaseIndex | null {
  const [idx, setIdx] = useState<DealPhaseIndex | null>(null);
  useEffect(() => {
    if (!on || idx) return;
    let live = true;
    loadDealPhaseIndex().then((x) => { if (live) setIdx(x); }).catch(() => {});
    return () => { live = false; };
  }, [on, idx]);
  return idx;
}
/** The phases to pick from (read once the page needs them). */
export function usePhaseOptions(on = true): PhaseOpt[] {
  const [opts, setOpts] = useState<PhaseOpt[]>([]);
  useEffect(() => {
    if (!on || opts.length) return;
    let live = true;
    loadPhaseOptions().then((x) => { if (live) setOpts(x); }).catch(() => {});
    return () => { live = false; };
  }, [on, opts.length]);
  return opts;
}

/** Did one of these phases get entered in the window the operator asks for? (p_* operators, see SQL 148) */
export function phaseHitMatches(hits: PhaseHit[] | null | undefined, op: string, phases: string[], min?: string, max?: string): boolean {
  const want = new Set(phases);
  const list = (hits ?? []).filter((h) => want.has(h.p));
  if (op === "p_never") return list.length === 0;
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const ago = (n: number) => iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n)));
  return list.some(({ d }) => {
    switch (op) {
      case "p_ever": return true;
      case "p_since": return !min || d >= min;
      case "p_before": return !min || d < min;
      case "p_between": return (!min || d >= min) && (!max || d <= max);
      case "p_last30": return d >= ago(30);
      case "p_last90": return d >= ago(90);
      case "p_year": return d >= `${now.getUTCFullYear()}-01-01`;
      default: return true;
    }
  });
}
