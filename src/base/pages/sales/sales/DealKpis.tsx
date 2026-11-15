import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Select from "../../../framework/Select";
import { nowMs, todayIso } from "../../../framework/asOf";
import { loadPrefs, savePref } from "../../companies/companiesApi";
import type { Tracking } from "./salesApi";
import "./DealKpis.css";

/* =====================================================================
   Deals › the figures on top, chosen by each user (1 to 6 cards,
   remembered in their profile as prefs.dealKpiSlots). They follow every
   filter of the list; the cards about a status (won, lost, on hold, open)
   filter the list when clicked, and clear it when clicked again.
   ===================================================================== */

const ICO = {
  deals: "M3 3h18v18H3zM3 9h18M9 21V9",
  open: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2",
  won: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3",
  lost: "M18 6 6 18M6 6l12 12",
  rate: "M19 5 5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  weight: "M3 3v18h18M7 15l4-4 3 3 5-6",
  avg: "M4 20V10M10 20V4M16 20v-6M22 20H2",
  soon: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  late: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  plus: "M12 5v14M5 12h14",
  cal: "M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM16 2v4M8 2v4M3 10h18",
  pause: "M10 4H6v16h4zM18 4h-4v16h4z",
};
const Ico = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

const n0 = (n: number) => Math.round(n).toLocaleString("de-DE");
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export type DealFig = {
  v: string; unit?: string; sub?: string;
  /** 0–100: a bar under the figure */
  bar?: number | null;
  /** open / won / lost shares: a bar in three parts */
  split?: [number, number, number] | null;
};
type Ctx = { deals: Tracking[]; valueOf: (t: Tracking) => number; probOf: (t: Tracking) => number | null; closeOf: (t: Tracking) => string | null };
type Def = { key: string; label: string; ico: string; status?: string; calc: (c: Ctx) => DealFig };

const isOpen = (t: Tracking) => t.status === "active" || t.status === "paused";
const sum = (c: Ctx, f: (t: Tracking) => boolean) => c.deals.filter(f).reduce((s, t) => s + (c.valueOf(t) || 0), 0);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const DEAL_KPIS: Def[] = [
  { key: "total", label: "Deals", ico: ICO.deals, status: "", calc: (c) => {
    const open = c.deals.filter(isOpen).length, won = c.deals.filter((t) => t.status === "won").length, lost = c.deals.filter((t) => t.status === "lost").length;
    const all = Math.max(1, open + won + lost);
    return { v: n0(c.deals.length), unit: `deal${c.deals.length === 1 ? "" : "s"}`, sub: `${n0(open)} open · ${n0(won)} won · ${n0(lost)} lost`, split: [open / all * 100, won / all * 100, lost / all * 100] };
  } },
  { key: "open", label: "Open pipeline", ico: ICO.open, status: "active", calc: (c) => {
    const v = sum(c, isOpen), all = sum(c, () => true);
    return { v: n0(v), unit: "€", sub: `${n0(c.deals.filter(isOpen).length)} open deals`, bar: pct(v, all) };
  } },
  { key: "won", label: "Won", ico: ICO.won, status: "won", calc: (c) => {
    const v = sum(c, (t) => t.status === "won"), all = sum(c, () => true), n = c.deals.filter((t) => t.status === "won").length;
    return { v: n0(v), unit: "€", sub: `${n0(n)} deal${n === 1 ? "" : "s"} · ${pct(v, all)}% of the value`, bar: pct(v, all) };
  } },
  { key: "winRate", label: "Win rate", ico: ICO.rate, calc: (c) => {
    const won = c.deals.filter((t) => t.status === "won").length, lost = c.deals.filter((t) => t.status === "lost").length;
    const wv = sum(c, (t) => t.status === "won"), lv = sum(c, (t) => t.status === "lost");
    return { v: String(pct(won, won + lost)), unit: "%", sub: won + lost ? `${n0(won)} won of ${n0(won + lost)} closed · ${pct(wv, wv + lv)}% by value` : "No deal closed yet", bar: pct(won, won + lost) };
  } },
  { key: "weighted", label: "Weighted pipeline", ico: ICO.weight, calc: (c) => {
    const open = c.deals.filter(isOpen);
    const w = open.reduce((s, t) => s + (c.valueOf(t) || 0) * ((c.probOf(t) ?? 0) / 100), 0), v = open.reduce((s, t) => s + (c.valueOf(t) || 0), 0);
    return { v: n0(w), unit: "€", sub: `${pct(w, v)}% of the open value · value × close chance`, bar: pct(w, v) };
  } },
  { key: "next90", label: "Closing in 90 days", ico: ICO.soon, calc: (c) => {
    const now = todayIso(), to = iso(nowMs() + 90 * 864e5);
    const xs = c.deals.filter((t) => { const d = c.closeOf(t); return isOpen(t) && !!d && d >= now && d <= to; });
    return { v: n0(xs.reduce((s, t) => s + (c.valueOf(t) || 0), 0)), unit: "€", sub: `${n0(xs.length)} open deal${xs.length === 1 ? "" : "s"} expected by ${new Date(nowMs() + 90 * 864e5).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` };
  } },
  { key: "overdue", label: "Overdue", ico: ICO.late, calc: (c) => {
    const now = todayIso(), open = c.deals.filter(isOpen);
    const xs = open.filter((t) => { const d = c.closeOf(t); return !!d && d < now; });
    return { v: n0(xs.length), sub: xs.length ? `${n0(xs.reduce((s, t) => s + (c.valueOf(t) || 0), 0))} € past the expected close` : "Nothing late", bar: pct(xs.length, open.length) };
  } },
  { key: "avg", label: "Average deal", ico: ICO.avg, calc: (c) => {
    const xs = c.deals.filter((t) => (c.valueOf(t) || 0) > 0);
    return { v: n0(xs.length ? xs.reduce((s, t) => s + c.valueOf(t), 0) / xs.length : 0), unit: "€", sub: `${n0(xs.length)} deals with a value` };
  } },
  { key: "newMonth", label: "New this month", ico: ICO.plus, calc: (c) => {
    const m = todayIso().slice(0, 7), xs = c.deals.filter((t) => String(t.created_at ?? "").slice(0, 7) === m);
    return { v: n0(xs.length), sub: `${n0(xs.reduce((s, t) => s + (c.valueOf(t) || 0), 0))} € opened since the 1st` };
  } },
  { key: "wonMonth", label: "Won this month", ico: ICO.cal, calc: (c) => {
    const m = todayIso().slice(0, 7), xs = c.deals.filter((t) => t.status === "won" && String(t.close_date ?? "").slice(0, 7) === m);
    return { v: n0(xs.reduce((s, t) => s + (c.valueOf(t) || 0), 0)), unit: "€", sub: `${n0(xs.length)} deal${xs.length === 1 ? "" : "s"} closed since the 1st` };
  } },
  { key: "lost", label: "Lost", ico: ICO.lost, status: "lost", calc: (c) => {
    const xs = c.deals.filter((t) => t.status === "lost");
    return { v: n0(xs.length), sub: `${n0(xs.reduce((s, t) => s + (c.valueOf(t) || 0), 0))} € lost`, bar: pct(xs.length, c.deals.length) };
  } },
  { key: "onHold", label: "On hold", ico: ICO.pause, status: "paused", calc: (c) => {
    const xs = c.deals.filter((t) => t.status === "paused");
    return { v: n0(xs.length), sub: `${n0(xs.reduce((s, t) => s + (c.valueOf(t) || 0), 0))} € paused` };
  } },
];
const DEFAULT = ["total", "open", "won", "winRate"];
const MAX = 6;
const known = (k: unknown): k is string => typeof k === "string" && DEAL_KPIS.some((d) => d.key === k);

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
  i: number; label: string; ico: string; f: DealFig; on?: boolean; clickable?: boolean; onClick?: () => void; onSwap?: (r: DOMRect) => void;
}) {
  return (
    <div className={`dkp-card ${on ? "is-on" : ""} ${clickable ? "is-click" : ""}`} style={{ ["--i" as any]: i }}
      onPointerMove={(e) => { const b = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty("--mx", `${e.clientX - b.left}px`); e.currentTarget.style.setProperty("--my", `${e.clientY - b.top}px`); }}
      role={clickable ? "button" : undefined} tabIndex={clickable ? 0 : undefined} aria-pressed={clickable ? !!on : undefined}
      onClick={clickable ? onClick : undefined} onKeyDown={(e) => { if (clickable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick?.(); } }}
      title={clickable ? (on ? "Click to show every deal again" : `Click to show only these deals`) : undefined}>
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

/** The user's cards for the list and the board. */
export default function DealKpis({ deals, valueOf, probOf, closeOf, statusOn, onStatus, onAll, loading }: Ctx & {
  statusOn: string[]; onStatus: (s: string) => void; onAll: () => void; loading?: boolean;
}) {
  const [slots, setSlots] = useState<string[]>(DEFAULT);
  const [ready, setReady] = useState(false);
  const [pick, setPick] = useState(false);
  const [swap, setSwap] = useState<{ i: number; top: number; left: number } | null>(null);
  useEffect(() => {
    loadPrefs().then((p) => {
      const xs = Array.isArray(p.dealKpiSlots) ? (p.dealKpiSlots as unknown[]).filter(known).slice(0, MAX) : [];
      if (xs.length) setSlots(xs);
    }).catch(() => {}).finally(() => setReady(true));
  }, []);
  const save = (next: string[]) => {
    const clean = next.filter((k, i, a) => known(k) && a.indexOf(k) === i).slice(0, MAX);
    if (!clean.length) return;
    setSlots(clean);
    savePref("dealKpiSlots", clean).catch(() => {});
  };
  const ctx = useMemo(() => ({ deals, valueOf, probOf, closeOf }), [deals, valueOf, probOf, closeOf]);
  const opts = DEAL_KPIS.map((d) => ({ value: d.key, label: d.label }));
  const defOf = (k: string) => DEAL_KPIS.find((d) => d.key === k)!;

  return (
    <div className={`dkp ${loading || !ready ? "is-loading" : ""}`} data-n={slots.length} style={{ ["--n" as any]: slots.length }} aria-busy={loading || !ready}>
      {slots.map((k, i) => {
        const d = defOf(k);
        const f = loading || !ready ? { v: "—" } : d.calc(ctx);
        const on = d.status ? statusOn.includes(d.status) : d.status === "" && !statusOn.length;
        return (
          <Card key={k} i={i} label={d.label} ico={d.ico} f={f} on={d.status != null && d.status !== "" && on}
            clickable={d.status != null} onClick={() => (d.status ? onStatus(d.status) : onAll())}
            onSwap={(r) => setSwap({ i, top: r.bottom + 8, left: Math.max(8, Math.min(r.left, window.innerWidth - 328)) })} />
        );
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
              <small>Pick 1 to {MAX} — they follow your filters and are remembered for you.</small>
              <div className="dk-opts">
                {DEAL_KPIS.map((d) => {
                  const on = slots.includes(d.key);
                  const full = !on && slots.length >= MAX;
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
                <span>{slots.length} of {MAX}</span>
                <button type="button" onClick={() => save(DEFAULT)}>Back to the default</button>
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

/** Fixed cards in the same look (the forecast's own figures). */
export function DealKpisFixed({ items, loading }: { items: { label: string; ico: keyof typeof ICO; f: DealFig }[]; loading?: boolean }) {
  return (
    <div className={`dkp is-fixed ${loading ? "is-loading" : ""}`} style={{ ["--n" as any]: items.length }}>
      {items.map((x, i) => <Card key={x.label} i={i} label={x.label} ico={ICO[x.ico]} f={x.f} />)}
    </div>
  );
}
