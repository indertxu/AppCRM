import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Tracking } from "./salesApi";
import "./SalesForecast.css";

/** Headline figures (also handed to the page if it wants to render them itself). */
export interface ForecastKpis {
  ranged: boolean;
  pipeline: number; openCount: number;
  weighted: number; estimated: number; probLabel: string;
  next90: number; next90By: string;
  overdueCount: number; overdueValue: number;
}

interface Props {
  /** Optional: if the page renders the top-row figures itself. Otherwise this view takes over that row. */
  onKpis?: (k: ForecastKpis) => void;
  trackings: Tracking[];                       // already filtered by the page (incl. "Any range")
  potentialTotals: Record<string, number>;
  closeDateOf: (t: Tracking) => string | null;
  probOf: (t: Tracking) => number | null;      // follows the page's Probability selector
  fallbackProbOf?: (t: Tracking) => number | null;
  probLabel: string;
  trackTitle: (t: Tracking) => string;
  phaseName: (t: Tracking) => string;
  ownerName: (t: Tracking) => string | null;
  productName: (t: Tracking) => string | null;
  onOpen: (id: string) => void;
  /** Optional control of the two timeline switches (a saved report remembers them). */
  group?: "day" | "month";
  onGroupChange?: (g: "day" | "month") => void;
  valueMode?: "weighted" | "full";
  onValueModeChange?: (m: "weighted" | "full") => void;
}

interface Item {
  t: Tracking; date: string | null; value: number; prob: number | null; estimated: boolean;
  weighted: number; won: boolean; overdue: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const eur = (n: number) => `${Math.round(n).toLocaleString("de-DE")} €`;
const monthTitle = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
};
const monthShort = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short" });
};
const dayParts = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return { day: d.getDate(), wd: d.toLocaleDateString("en-GB", { weekday: "short" }), mo: d.toLocaleDateString("en-GB", { month: "short" }) };
};
const band = (p: number | null) => (p == null ? "none" : p >= 70 ? "hi" : p >= 40 ? "mid" : "lo");
const stateOf = (i: Item) => (i.won ? "won" : i.overdue ? "late" : band(i.prob));

/** Number that eases up to its value. */
function useTween(target: number, ms = 900) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const cur = a + (target - a) * (1 - Math.pow(1 - k, 4));
      setV(cur);
      if (k < 1) raf = requestAnimationFrame(step); else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function Ring({ p, est = false }: { p: number | null; est?: boolean }) {
  const pct = p == null ? 0 : Math.max(0, Math.min(100, p));
  return (
    <span className={`fc-ring is-${band(p)} ${est ? "is-est" : ""}`}
      title={p == null ? "No probability" : est ? `${pct}% — estimated from pipeline progress (no close probability set on this phase)` : `${pct}%`}>
      <svg viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15" pathLength={100} className="fc-ring-bg" />
        <circle cx="18" cy="18" r="15" pathLength={100} className="fc-ring-fg" style={{ ["--off" as string]: 100 - pct } as CSSProperties} />
      </svg>
      <b>{p == null ? "—" : `${Math.round(pct)}`}<i>{p == null ? "" : "%"}</i></b>
      {est && <em className="fc-ring-est">est.</em>}
    </span>
  );
}

/* ---------- top-row card: same markup/classes as the page's status cards ---------- */
const ICON = {
  pipe: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 10h18M8 5v14",
  weighted: "M3 17l6-6 4 4 8-8M17 7h4v4",
  next: "M13 2L3 14h7l-1 8 10-12h-7z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 2",
};
function TopCard({ i, tone, icon, label, value, unit, sub, share, title }: {
  i: number; tone: string; icon: string; label: string; value: number; unit?: string; sub: string; share?: number; title?: string;
}) {
  const v = useTween(value);
  const [armed, setArmed] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setArmed(true), 420 + i * 90); return () => window.clearTimeout(t); }, [i]);
  const s = Math.max(0, Math.min(1, share ?? 0));
  return (
    <div className={`so-kpi tone-${tone} fc-topcard`} data-spot="tilt" title={title}
      style={{ ["--i" as string]: i, ["--w" as string]: `${armed ? s * 100 : 0}%` } as CSSProperties}>
      <span className="so-kpi-top">
        <span className="so-kpi-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>
        </span>
        <span className="so-kpi-label">{label}</span>
      </span>
      <span className="so-kpi-body">
        <span className="so-kpi-txt">
          <b className="so-kpi-val">{Math.round(v).toLocaleString("de-DE")}{unit && <em className="so-kpi-unit">{unit}</em>}</b>
          <small>{sub}</small>
        </span>
      </span>
      {share != null && <span className="so-kpi-bar" aria-hidden="true"><i /></span>}
    </div>
  );
}

/**
 * While the forecast is open, it owns the page's top KPI row: the status cards
 * are hidden and the forecast's four figures take their place. Restored on exit.
 */
function useTopRowSlot(enabled: boolean) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!enabled) return;
    const host = document.querySelector<HTMLElement>(".so-kpis:not([data-fc-slot])");
    if (!host || !host.parentElement) return;
    const box = document.createElement("div");
    box.className = "so-kpis is-forecast";
    box.setAttribute("data-fc-slot", "");
    box.style.gridTemplateColumns = "repeat(4, minmax(0, 1fr))";
    host.parentElement.insertBefore(box, host);
    const prev = host.style.display;
    host.style.display = "none";
    setSlot(box);
    return () => { host.style.display = prev; box.remove(); setSlot(null); };
  }, [enabled]);
  return slot;
}

export default function SalesForecast({
  onKpis, trackings, potentialTotals, closeDateOf, probOf, fallbackProbOf, probLabel,
  trackTitle, phaseName, ownerName, productName, onOpen,
  group: groupProp, onGroupChange, valueMode: modeProp, onValueModeChange,
}: Props) {
  const [modeS, setModeS] = useState<"weighted" | "full">(modeProp ?? "weighted");
  const [groupS, setGroupS] = useState<"day" | "month">(groupProp ?? "day");
  const mode = modeProp ?? modeS;
  const group = groupProp ?? groupS;
  const setMode = (m: "weighted" | "full") => { setModeS(m); onValueModeChange?.(m); };
  const setGroup = (g: "day" | "month") => { setGroupS(g); onGroupChange?.(g); };
  const todayRef = useRef<HTMLDivElement>(null);
  const today = isoOf(new Date());
  const curMonth = today.slice(0, 7);
  const slot = useTopRowSlot(!onKpis);

  const items = useMemo<Item[]>(() =>
    trackings
      .filter((t) => t.status !== "lost")
      .map((t) => {
        const won = t.status === "won";
        const date = (closeDateOf(t) ?? "").slice(0, 10) || null;
        const value = potentialTotals[t.id] || 0;
        const own = won ? 100 : probOf(t);
        const fb = own == null && fallbackProbOf ? fallbackProbOf(t) : null;
        const prob = own ?? fb;
        return {
          t, date, value, prob, estimated: own == null && fb != null,
          weighted: value * ((prob ?? 0) / 100), won, overdue: !won && !!date && date < today,
        };
      }),
  [trackings, potentialTotals, closeDateOf, probOf, fallbackProbOf, today]);

  const dated = useMemo(() => items.filter((i) => i.date).sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : b.value - a.value)), [items]);
  const undated = useMemo(() => items.filter((i) => !i.date && !i.won), [items]);

  const months = useMemo(() => {
    const m = new Map<string, Item[]>();
    dated.forEach((i) => { const k = i.date!.slice(0, 7); (m.get(k) ?? m.set(k, []).get(k)!).push(i); });
    return [...m.entries()].map(([key, list]) => {
      const open = list.filter((i) => !i.won);
      return {
        key, list,
        won: list.filter((i) => i.won).reduce((s, i) => s + i.value, 0),
        weighted: open.reduce((s, i) => s + i.weighted, 0),
        full: open.reduce((s, i) => s + i.value, 0),
      };
    });
  }, [dated]);

  // ---- headline figures ----
  const open = items.filter((i) => !i.won);
  const in90 = isoOf(new Date(Date.now() + 90 * 864e5));
  const pipeline = open.reduce((s, i) => s + i.value, 0);
  const weighted = open.reduce((s, i) => s + i.weighted, 0);
  const next90 = open.filter((i) => i.date && i.date >= today && i.date <= in90).reduce((s, i) => s + i.weighted, 0);
  const overdue = open.filter((i) => i.overdue);
  const overdueValue = overdue.reduce((s, i) => s + i.value, 0);
  const estimatedN = open.filter((i) => i.estimated).length;
  const next90By = new Date(`${in90}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  useEffect(() => {
    onKpis?.({ ranged: false, pipeline, openCount: open.length, weighted, estimated: estimatedN, probLabel, next90, next90By, overdueCount: overdue.length, overdueValue });
  }, [pipeline, open.length, weighted, estimatedN, probLabel, next90, next90By, overdue.length, overdueValue]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxMonth = Math.max(1, ...months.map((m) => m.won + (mode === "weighted" ? m.weighted : m.full)));
  const maxDeal = Math.max(1, ...dated.map((i) => i.value));
  const delay = (i: number): CSSProperties => ({ ["--d" as string]: `${Math.min(i, 28) * 45}ms` });
  const shownValue = (i: Item) => (mode === "weighted" && !i.won ? i.weighted : i.value);
  const jumpToday = () => todayRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });

  const todayMarker = (key: string) => (
    <div className="fc-today" ref={todayRef} key={key}>
      <span className="fc-today-date">{new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
      <span className="fc-today-dot" />
      <span className="fc-today-pill">Today</span>
      <span className="fc-today-rule" />
    </div>
  );

  const monthHeader = (m: (typeof months)[number], idx: number, withDeals?: Item[]) => {
    const sum = mode === "weighted" ? m.weighted : m.full;
    return (
      <div className={`fc-month ${m.key < curMonth ? "is-past" : ""} ${m.key === curMonth ? "is-now" : ""} ${withDeals ? "is-group" : ""}`} key={m.key} style={delay(idx)}>
        <span className="fc-month-side">{m.key.slice(0, 4)}</span>
        <span className="fc-month-node">{monthShort(m.key)}</span>
        <div className="fc-month-body">
          <div className="fc-month-top">
            <h3>{monthTitle(m.key)}</h3>
            <span className="fc-month-n">{m.list.length} {m.list.length === 1 ? "deal" : "deals"}</span>
            <b className="fc-month-sum">{eur(sum + m.won)}</b>
          </div>
          <div className="fc-month-bar" aria-hidden="true">
            <i className="is-won" style={{ width: `${(m.won / maxMonth) * 100}%` }} />
            <i className="is-open" style={{ width: `${(sum / maxMonth) * 100}%` }} />
          </div>
          <div className="fc-month-meta">
            {m.won > 0 && <span><i className="is-won" />{eur(m.won)} won</span>}
            <span><i className="is-open" />{eur(sum)} {mode === "weighted" ? "weighted" : "in pipeline"}</span>
            {mode === "weighted" && m.full > 0 && <span className="is-dim">of {eur(m.full)}</span>}
          </div>
          {withDeals && (
            <div className="fc-glist">
              {withDeals.map((it, k) => {
                const { day, mo } = dayParts(it.date!);
                return (
                  <button key={it.t.id} className={`fc-grow is-${stateOf(it)}`} onClick={() => onOpen(it.t.id)} style={delay(idx + k + 1)}>
                    <span className="fc-grow-date">{day} {mo}{it.overdue && <em>Overdue</em>}</span>
                    <span className="fc-grow-dot" />
                    <span className="fc-grow-main">
                      <b>{trackTitle(it.t)}</b>
                      <span><span className="fc-phase">{it.won ? "Won" : phaseName(it.t)}</span>{productName(it.t) && <span className="fc-prod">{productName(it.t)}</span>}</span>
                    </span>
                    <span className="fc-grow-owner">{ownerName(it.t) ?? ""}</span>
                    <span className="fc-money"><b>{eur(shownValue(it))}</b><em>{mode === "weighted" && !it.won && it.value > 0 ? `of ${eur(it.value)}` : it.won ? "closed" : "potential"}</em></span>
                    <Ring p={it.prob} est={it.estimated} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Rows for the line (day view interleaves deals; month view nests them in the month card).
  const rows: ReactNode[] = [];
  let placed = false, n = 0;
  months.forEach((m) => {
    if (group === "month") {
      if (!placed && m.key >= curMonth) { rows.push(todayMarker("today")); placed = true; }
      rows.push(monthHeader(m, n, m.list)); n += m.list.length + 1;
      return;
    }
    if (!placed && m.key > curMonth) { rows.push(todayMarker("today")); placed = true; }
    rows.push(monthHeader(m, n++));
    m.list.forEach((it) => {
      if (!placed && it.date! >= today) { rows.push(todayMarker("today")); placed = true; }
      const { day, wd, mo } = dayParts(it.date!);
      const size = 10 + Math.round(Math.sqrt(it.value / maxDeal) * 14);
      const owner = ownerName(it.t);
      const product = productName(it.t);
      rows.push(
        <div className={`fc-deal is-${stateOf(it)}`} key={it.t.id} style={delay(n++)}>
          <span className="fc-date"><b>{day} {mo}</b><em>{it.overdue ? "Overdue" : wd}</em></span>
          <span className="fc-dot" style={{ width: size, height: size }}>
            {it.won && <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
          </span>
          <button className="fc-card" onClick={() => onOpen(it.t.id)}>
            <span className="fc-card-main">
              <b className="fc-title">{trackTitle(it.t)}</b>
              <span className="fc-sub">
                <span className="fc-phase">{it.won ? "Won" : phaseName(it.t)}</span>
                {product && <span className="fc-prod">{product}</span>}
              </span>
            </span>
            {owner ? (
              <span className="fc-owner" title={owner}><span className="fc-av">{owner.charAt(0).toUpperCase()}</span><span className="fc-owner-n">{owner}</span></span>
            ) : <span />}
            <span className="fc-money">
              <b>{eur(shownValue(it))}</b>
              <em>{it.value > 0 ? (mode === "weighted" && !it.won ? `of ${eur(it.value)}` : it.won ? "closed" : "potential") : "no value yet"}</em>
            </span>
            <Ring p={it.prob} est={it.estimated} />
          </button>
        </div>,
      );
    });
  });
  if (!placed && months.length) rows.push(todayMarker("today"));

  const topRow = slot && createPortal(
    <>
      <TopCard i={0} tone="total" icon={ICON.pipe} label="Open pipeline" value={pipeline} unit="€"
        sub={`${open.length} open ${open.length === 1 ? "deal" : "deals"}`} title="Total value of the open deals in view" />
      <TopCard i={1} tone="won" icon={ICON.weighted} label="Weighted forecast" value={weighted} unit="€"
        sub={estimatedN ? `${estimatedN} without a probability · using pipeline progress` : `value × ${probLabel.toLowerCase()}`}
        share={pipeline ? weighted / pipeline : 0} title="Each deal's value × its close probability" />
      <TopCard i={2} tone="active" icon={ICON.next} label="Next 90 days" value={next90} unit="€"
        sub={`weighted, closing by ${next90By}`} share={weighted ? next90 / weighted : 0} title="Weighted value expected to close in the next 90 days" />
      <TopCard i={3} tone="lost" icon={ICON.clock} label="Overdue" value={overdue.length}
        sub={overdue.length ? `${eur(overdueValue)} past its expected close date` : "nothing late"}
        share={open.length ? overdue.length / open.length : 0} title="Open deals whose expected close date has passed" />
    </>,
    slot,
  );

  return (
    <div className="fc">
      {topRow}

      <div className="fc-bar">
        <div className="fc-seg" data-mode={group === "day" ? "a" : "b"} role="tablist" aria-label="Grouping">
          <span className="fc-seg-pill" />
          <button className={group === "day" ? "is-on" : ""} onClick={() => setGroup("day")}>By day</button>
          <button className={group === "month" ? "is-on" : ""} onClick={() => setGroup("month")}>By month</button>
        </div>
        <div className="fc-seg" data-mode={mode === "weighted" ? "a" : "b"} role="tablist" aria-label="Value">
          <span className="fc-seg-pill" />
          <button className={mode === "weighted" ? "is-on" : ""} onClick={() => setMode("weighted")}>Weighted</button>
          <button className={mode === "full" ? "is-on" : ""} onClick={() => setMode("full")}>Full value</button>
        </div>
        <div className="fc-legend">
          <span><i className="is-hi" />≥ 70%</span>
          <span><i className="is-mid" />40–69%</span>
          <span><i className="is-lo" />&lt; 40%</span>
          <span><i className="is-won" />Won</span>
          <span><i className="is-late" />Overdue</span>
        </div>
        {months.length > 0 && <button className="fc-jump" onClick={jumpToday}>Jump to today</button>}
      </div>

      {months.length === 0 ? (
        <div className="fc-empty">
          <p>No deals with an expected close date match these filters.</p>
          <span>Widen the Expected close date in “Any range”, or set one on a deal.</span>
        </div>
      ) : (
        <div className={`fc-line is-${group}`} key={group}>
          <span className="fc-spine" aria-hidden="true" />
          {rows}
          <span className="fc-end" aria-hidden="true" />
        </div>
      )}

      {undated.length > 0 && (
        <section className="fc-undated">
          <header>
            <b>No expected close date</b>
            <span>{undated.length} open {undated.length === 1 ? "deal isn't" : "deals aren't"} on the timeline · {eur(undated.reduce((s, i) => s + i.value, 0))}</span>
          </header>
          <div className="fc-chips">
            {undated.map((i) => (
              <button key={i.t.id} onClick={() => onOpen(i.t.id)}>
                {trackTitle(i.t)}<em>{i.value > 0 ? eur(i.value) : phaseName(i.t)}</em>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}