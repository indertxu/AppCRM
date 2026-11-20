import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Select from "../../../framework/Select";
import { loadPrefs, savePref } from "../../companies/companiesApi";
import "./kpiStrip.css";

/* =====================================================================
   The figures on top of a page (Marketing › E-mail…), chosen by each user
   (1 to 6 cards, remembered in their profile).
   ===================================================================== */

const Ico = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;


export type KpiFig = {
  v: string; unit?: string; sub?: string;
  /** 0–100: a bar under the figure */
  bar?: number | null;
  /** open / won / lost shares: a bar in three parts */
  split?: [number, number, number] | null;
};
const MAX = 6;

/** A figure that counts to its new value ("1.711.877" → glides there); text that isn't a number shows as it is. */
function Fig({ text }: { text: string }) {
  const target = /^[\d.]+$/.test(text) ? Number(text.replace(/\./g, "")) : null;
  const [v, setV] = useState<number | null>(target == null ? null : 0);
  const from = useRef(0);
  useEffect(() => {
    if (target == null) { setV(null); return; }
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { from.current = target; setV(target); return; }
    let raf = 0; const start = from.current, t0 = performance.now(), ms = 900;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 4);
      const cur = start + (target - start) * e; from.current = cur; setV(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return <>{target == null || v == null ? text : Math.round(v).toLocaleString("de-DE")}</>;
}

function Card({ i, label, ico, f, on, clickable, onClick, onSwap }: {
  i: number; label: string; ico: string; f: KpiFig; on?: boolean; clickable?: boolean; onClick?: () => void; onSwap?: (r: DOMRect) => void;
}) {
  return (
    <div className={`dkp-card ${on ? "is-on" : ""} ${clickable ? "is-click" : ""}`} style={{ ["--i" as any]: i }}
      onPointerMove={(e) => { const b = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty("--mx", `${e.clientX - b.left}px`); e.currentTarget.style.setProperty("--my", `${e.clientY - b.top}px`); }}
      role={clickable ? "button" : undefined} tabIndex={clickable ? 0 : undefined} aria-pressed={clickable ? !!on : undefined}
      onClick={clickable ? onClick : undefined} onKeyDown={(e) => { if (clickable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick?.(); } }}
      title={clickable ? (on ? "Click to show everything again" : "Click to show only these") : undefined}>
      <span className="dk-top">
        <span className="dk-k">{label}</span>
        {on && <i className="dk-flag">Filtering</i>}
        {onSwap && (
          <button type="button" className="dk-swap" aria-label="Change this figure" title="Change this figure"
            onClick={(e) => { e.stopPropagation(); onSwap((e.currentTarget.closest(".dkp-card") as HTMLElement).getBoundingClientRect()); }}>
            <Ico d="m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" />
          </button>
        )}
        <span className="dk-ico"><Ico d={ico} /></span>
      </span>
      <b className="dk-v"><Fig text={f.v} />{f.unit && <em>{f.unit}</em>}</b>
      {f.sub && <span className="dk-sub" title={f.sub}>{f.sub}</span>}
      {f.split ? (
        <span className="dk-bar is-split" aria-hidden="true"><i className="is-open" style={{ width: `${f.split[0]}%` }} /><i className="is-won" style={{ width: `${f.split[1]}%` }} /><i className="is-lost" style={{ width: `${f.split[2]}%` }} /></span>
      ) : f.bar != null ? (
        <span className="dk-bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, f.bar))}%` }} /></span>
      ) : null}
    </div>
  );
}

/** The same cards and picker for any page's figures (Marketing › E-mail…): each user picks 1 to `max`, remembered under `prefKey`. */
export type FigDef<C> = { key: string; label: string; ico: string; calc: (c: C) => KpiFig };
export function KpiStrip<C>({ defs, ctx, prefKey, defaults, loading, max = MAX, className = "" }: {
  defs: FigDef<C>[]; ctx: C; prefKey: string; defaults: string[]; loading?: boolean; max?: number; className?: string;
}) {
  const known = (k: unknown): k is string => typeof k === "string" && defs.some((d) => d.key === k);
  const [slots, setSlots] = useState<string[]>(defaults);
  const [ready, setReady] = useState(false);
  const [pick, setPick] = useState(false);
  const [swap, setSwap] = useState<{ i: number; top: number; left: number } | null>(null);
  useEffect(() => {
    loadPrefs().then((p) => {
      const saved = (p as Record<string, unknown>)[prefKey];
      const xs = Array.isArray(saved) ? (saved as unknown[]).filter(known).slice(0, max) : [];
      if (xs.length) setSlots(xs);
    }).catch(() => {}).finally(() => setReady(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: string[]) => {
    const clean = next.filter((k, i, a) => known(k) && a.indexOf(k) === i).slice(0, max);
    if (!clean.length) return;
    setSlots(clean);
    savePref(prefKey, clean).catch(() => {});
  };
  const opts = defs.map((d) => ({ value: d.key, label: d.label }));
  const defOf = (k: string) => defs.find((d) => d.key === k)!;
  return (
    <div className={`dkp ${className} ${loading || !ready ? "is-loading" : ""}`} data-n={slots.length} style={{ ["--n" as any]: slots.length }} aria-busy={loading || !ready}>
      {slots.map((k, i) => {
        const d = defOf(k);
        const f = loading || !ready ? { v: "—" } : d.calc(ctx);
        return <Card key={k} i={i} label={d.label} ico={d.ico} f={f} onSwap={(r) => setSwap({ i, top: r.bottom + 8, left: Math.max(8, Math.min(r.left, window.innerWidth - 328)) })} />;
      })}
      <div className="dk-edit">
        <button type="button" className={pick ? "is-on" : ""} onClick={() => setPick((v) => !v)} title="Choose the figures" aria-label="Choose the figures">
          <Ico d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
        </button>
        {pick && (
          <>
            <div className="dk-scrim" onMouseDown={() => setPick(false)} />
            <div className="dk-pop" role="dialog" aria-label="Choose the figures">
              <b>Figures on top</b>
              <small>Pick 1 to {max} — remembered for you.</small>
              <div className="dk-opts">
                {defs.map((d) => {
                  const on = slots.includes(d.key);
                  const full = !on && slots.length >= max;
                  return (
                    <button type="button" key={d.key} className={on ? "is-on" : ""} disabled={full || (on && slots.length === 1)}
                      onClick={() => save(on ? slots.filter((x) => x !== d.key) : [...slots, d.key])}>
                      <i>{on && <Ico d="M20 6 9 17l-5-5" />}</i>
                      <span className="dk-o-ico"><Ico d={d.ico} /></span>{d.label}
                    </button>
                  );
                })}
              </div>
              <div className="dk-pop-foot">
                <span>{slots.length} of {max}</span>
                <button type="button" onClick={() => save(defaults)}>Back to the default</button>
              </div>
            </div>
          </>
        )}
      </div>
      {swap && slots[swap.i] && createPortal(
        <>
          <div className="dk-scrim" onMouseDown={() => setSwap(null)} />
          <div className="dk-pop dk-slot" style={{ top: swap.top, left: swap.left }} role="dialog" aria-label="Change this figure">
            <b>Card {swap.i + 1}</b>
            <small>Pick what it shows.</small>
            <Select value={slots[swap.i]} onChange={(v) => { if (v) save(slots.map((x, j) => (j === swap.i ? v : x)).filter((x, j, a) => a.indexOf(x) === j)); }} options={opts} />
            <div className="dk-pop-foot">
              {slots.length > 1 ? <button type="button" className="is-del" onClick={() => { save(slots.filter((_, j) => j !== swap.i)); setSwap(null); }}>Remove card</button> : <span />}
              <button type="button" className="is-ok" onClick={() => setSwap(null)}>Done</button>
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
