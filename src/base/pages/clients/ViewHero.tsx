import { type ReactNode } from "react";
import { nowMs } from "../../framework/asOf";
import "./ViewHero.css";

/* The figures on top of a client's products: cards (the first one dark, with its years as small bars),
   and the term as a card of its own. */

const Ico = ({ d, w = 1.9 }: { d: string; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const cpDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const stateTone = (s: string) => (s === "Running" ? "run" : s === "In grace period" ? "grace" : s === "Not started" ? "soon" : s === "Renewed" ? "run" : "off");

const DAYMS = 864e5;
export const HERO_ICO = {
  value: "M20 12V8H6a2 2 0 0 1 0-4h12v4M4 6v12a2 2 0 0 0 2 2h14v-4M18 12a2 2 0 0 0 0 4h4v-4z",
  year: "M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3",
  gross: "M3 3v18h18M7 15l4-4 3 3 5-6",
  total: "M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5",
  term: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
};
export type HeroKpi = { k: string; v: ReactNode; sub?: ReactNode; main?: boolean; ico?: string; bars?: { v: number; on?: boolean; label?: string }[] };
/** A contract's figures as cards — the first one dark, with its years as small bars — and its term as a card of its own:
 *  how far through it is, signed → starts → ends. */
export function ViewHero({ kpis, term }: {
  kpis: HeroKpi[];
  term?: { signed?: string | null; start?: string | null; end?: string | null; renews?: boolean; state?: string } | null;
}) {
  const t = term && term.start && term.end ? term : null;
  let pct = 0, big = "", small = "", chip = "";
  if (t) {
    const a = +new Date(`${t.start!.slice(0, 10)}T12:00:00`), b = +new Date(`${t.end!.slice(0, 10)}T12:00:00`), now = nowMs();
    pct = b > a ? Math.max(0, Math.min(1, (now - a) / (b - a))) : now >= b ? 1 : 0;
    const left = Math.ceil((b - now) / DAYMS), until = Math.ceil((a - now) / DAYMS);
    if (now < a) { big = `${until}`; small = until === 1 ? "day to start" : "days to start"; chip = "Not started"; }
    else if (now >= b) { big = t.renews ? "Renewed" : "Ended"; small = ""; chip = cpDay(t.end!.slice(0, 10)); }
    else { big = `${Math.round(pct * 100)}%`; small = "of the term"; chip = left > 60 ? `${Math.round(left / 30.4)} months left` : `${left} day${left === 1 ? "" : "s"} left`; }
  }
  return (
    <div className={`ctv-hero ${t ? "has-term" : ""}`} style={{ ["--n" as any]: kpis.length }}>
      {kpis.map((x, i) => {
        const max = Math.max(1, ...(x.bars ?? []).map((y) => y.v));
        return (
          <div key={i} className={`ctv-kpi ${x.main ? "is-main" : ""}`}>
            <span className="ctv-kpi-h"><em>{x.k}</em>{x.ico && <span className="ctv-kpi-ico"><Ico d={x.ico} /></span>}</span>
            <b className="ctv-kpi-v">{x.v}</b>
            {x.bars && x.bars.length > 1 && (
              <span className="ctv-spark" aria-hidden="true">
                {x.bars.map((y, j) => <i key={j} className={y.on ? "is-on" : ""} style={{ height: `${Math.max(14, (y.v / max) * 100)}%` }} title={y.label} />)}
              </span>
            )}
            <i className="ctv-kpi-sub">{x.sub ?? "\u00a0"}</i>
          </div>
        );
      })}
      {t && (
        <div className={`ctv-kpi is-term is-${stateTone(t.state ?? "")}`}>
          <span className="ctv-kpi-h"><em>Term</em><span className="ctv-kpi-ico"><Ico d={HERO_ICO.term} /></span></span>
          <span className="ctv-term-big"><b>{big}</b>{small && <em>{small}</em>}{chip && <i>{chip}</i>}</span>
          <span className="ctv-bar" aria-hidden="true"><span style={{ width: `${pct * 100}%` }} /></span>
          <span className="ctv-term-d">
            {t.signed && t.signed.slice(0, 10) !== t.start!.slice(0, 10) && <span><em>Signed</em><b>{cpDay(t.signed.slice(0, 10))}</b></span>}
            <span><em>Starts</em><b>{cpDay(t.start!.slice(0, 10))}</b></span>
            <span className="is-r"><em>{t.renews ? "Renews" : "Ends"}</em><b>{cpDay(t.end!.slice(0, 10))}</b></span>
          </span>
        </div>
      )}
    </div>
  );
}
