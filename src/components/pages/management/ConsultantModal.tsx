import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./ConsultantModal.css";

/* The numbers are computed in ManagementPage (insightsFor / computeBonus /
   the capacity block) and handed in whole, so this file is presentation only. */
export interface Insights {
  billableDays: number;
  billableAmount: number;
  clientUnbilledDays: number;
  internalDays: number;
  totalWorked: number;
  blendedRate: number;
  invoicedAmount: number;
  invoicedDays: number;
  availableDays: number;
  capUtilisation: number;
  utilisation: number;
  occupancy: number;
  idleDays: number;
  trend: { label: string; amount: number; days: number }[];
}
export interface BonusResult { amount: number; tier: 0 | 1 | 2; minMet: boolean; highMet: boolean; }
export interface CapView {
  minDays: number | null; minBilling: number | null; bonusPct1: number | null;
  highDays: number | null; highBilling: number | null; bonusPct2: number | null;
}
export interface CapWork { available: number; worked: number; billable: number; workedPct: number; billablePct: number; }

interface ProjectRow {
  key: string;
  client: string;
  service: string;
  rateKind: string;
  rate: number;
  hourly: boolean;
  amountPlanned: number;
  daysPlanned: number;
  amountDone: number;
  daysDone: number;
}

interface Props {
  name: string;
  scopeLabel: string;
  scope: string;
  hoursPerDay: number;
  ins: Insights;
  cap: CapView | null;
  showBonus: boolean;
  bonusInvoiced: BonusResult;
  cw: CapWork | null;
  capMode: "worked" | "billable";
  onToggleCap: () => void;
  projectRows: ProjectRow[];
  projOpenKey: string | null;
  onToggleProject: (key: string) => void;
  renderLedger: (key: string) => React.ReactNode;
  onClose: () => void;
}

const eur = (n: number) => Math.round(n).toLocaleString();
const d2 = (n: number) => (+n.toFixed(2)).toLocaleString();

export default function ConsultantModal({
  name, scopeLabel, scope, hoursPerDay, ins, cap, showBonus, bonusInvoiced, cw,
  capMode, onToggleCap, projectRows, projOpenKey, onToggleProject, renderLedger, onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const initials = name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const rateHour = hoursPerDay > 0 ? ins.blendedRate / hoursPerDay : 0;
  const [rateMode, setRateMode] = useState<"day" | "hour">("day");

  // Utilisation split, largest first, idle last.
  const slices = [
    { key: "bill", label: "Billable", days: ins.billableDays, cls: "is-bill" },
    { key: "unbilled", label: "Client, unbilled", days: ins.clientUnbilledDays, cls: "is-unbilled" },
    { key: "internal", label: "Internal", days: ins.internalDays, cls: "is-internal" },
    { key: "idle", label: "Idle", days: ins.idleDays, cls: "is-idle" },
  ].filter((s) => s.days > 0.01);
  const barBase = ins.availableDays > 0 ? ins.availableDays : (ins.totalWorked || 1);

  const maxTrend = Math.max(1, ...ins.trend.map((t) => t.amount));

  // Bonus shortfall, so "not met" says by how much.
  const daysGap = cap?.minDays != null ? cap.minDays - ins.invoicedDays : 0;
  const billGap = cap?.minBilling != null ? cap.minBilling - ins.invoicedAmount : 0;
  const tierLabel = bonusInvoiced.tier === 2 ? "High tier"
    : bonusInvoiced.tier === 1 ? "Minimum met" : "Below minimum";

  return createPortal(
    <div className="cm-backdrop" onMouseDown={onClose}>
      <div className="cm" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`${name} detail`}>
        {/* Dark instrument header, matching the KPI gauges */}
        <header className="cm-head">
          <span className="cm-head-glow" aria-hidden="true" />
          <span className="cm-av">{initials}</span>
          <div className="cm-id">
            <h2 className="cm-name">{name}</h2>
            <span className="cm-scope">{scopeLabel}</span>
          </div>
          <button className="cm-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="cm-body">
          {/* Rate + booked time, side by side. Both cards flip on click. */}
          <div className="cm-stats">
            <button type="button"
              className={`cm-stat cm-stat-btn ${rateMode === "hour" ? "is-alt" : ""}`}
              onClick={() => setRateMode((m) => (m === "day" ? "hour" : "day"))}
              title="Switch between per day and per hour">
              <span className="cm-stat-k">
                Blended rate
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 2l4 4-4 4M3 6h18M7 22l-4-4 4-4M21 18H3" />
                </svg>
              </span>
              <b className="cm-stat-v">
                {eur(rateMode === "day" ? ins.blendedRate : rateHour)}
                <i>€/{rateMode === "day" ? "day" : "hour"}</i>
              </b>
              <span className="cm-stat-s">
                {rateMode === "day"
                  ? <>{eur(rateHour)} €/hour · {hoursPerDay}h day</>
                  : <>{eur(ins.blendedRate)} €/day · {hoursPerDay}h day</>}
              </span>
            </button>

            {cw && cw.available > 0 && (
              <button type="button"
                className={`cm-stat cm-stat-btn ${capMode === "billable" ? "is-alt" : ""}`}
                onClick={onToggleCap}
                title="Switch between time booked and the billable share">
                <span className="cm-stat-k">
                  {capMode === "worked" ? "Time booked" : "Billable share"}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 2l4 4-4 4M3 6h18M7 22l-4-4 4-4M21 18H3" />
                  </svg>
                </span>
                <b className="cm-stat-v">
                  {Math.round(capMode === "worked" ? cw.workedPct : cw.billablePct)}<i>%</i>
                </b>
                <span className="cm-stat-s">
                  {(capMode === "worked" ? cw.worked : cw.billable).toFixed(1)} / {cw.available.toFixed(1)} h
                </span>
              </button>
            )}
          </div>

          {/* Utilisation */}
          <section className="cm-sec">
            <div className="cm-sec-head">
              <h3>Utilisation</h3>
            </div>
            <div className="cm-util">
              {slices.map((s) => (
                <span key={s.key} className={`cm-util-seg ${s.cls}`}
                  style={{ width: `${(s.days / barBase) * 100}%` }}
                  title={`${s.label}: ${d2(s.days)}d`} />
              ))}
            </div>
            <div className="cm-util-keys">
              {slices.map((s) => (
                <span key={s.key} className="cm-util-key">
                  <i className={s.cls} />{s.label}<b>{d2(s.days)}d</b>
                </span>
              ))}
            </div>
          </section>

          {/* Bonus — compact. Bonuses are assessed monthly, so a weekly view
              would compare one week against a whole month's target and always
              read "below minimum". Show a note there instead. */}
          {showBonus && cap && (scope === "week" || scope === "custom") ? (
            <section className="cm-bonus is-note">
              <div className="cm-bonus-main">
                <span className="cm-bonus-k">Bonus</span>
                <span className="cm-bonus-noteline">Assessed monthly — switch to a month or longer to see it.</span>
              </div>
            </section>
          ) : showBonus && cap && (
            <section className={`cm-bonus t${bonusInvoiced.tier}`}>
              <div className="cm-bonus-main">
                <span className="cm-bonus-k">Bonus this period</span>
                <b className="cm-bonus-amt">{eur(bonusInvoiced.amount)}<i>€</i></b>
                <span className={`cm-bonus-tier t${bonusInvoiced.tier}`}>{tierLabel}</span>
              </div>
              <div className="cm-bonus-calc">
                {bonusInvoiced.minMet ? (
                  <span>
                    {eur(ins.invoicedAmount)} invoiced ×{" "}
                    {bonusInvoiced.tier === 2 ? (cap.bonusPct2 ?? 0) : (cap.bonusPct1 ?? 0)}%
                  </span>
                ) : (
                  <span className="cm-bonus-gap">
                    {daysGap > 0 && billGap > 0
                      ? `Needs ${d2(daysGap)}d and ${eur(billGap)} € more`
                      : daysGap > 0 ? `Needs ${d2(daysGap)}d more`
                      : billGap > 0 ? `Needs ${eur(billGap)} € more`
                      : "Just short of the minimum"}
                  </span>
                )}
              </div>
              {(cap.minBilling != null || cap.highBilling != null) && (() => {
                const minB = cap.minBilling ?? 0;
                const highB = cap.highBilling ?? 0;
                const scale = Math.max(highB, minB, ins.invoicedAmount, 1);
                const at = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;
                return (
                  <div className="cm-bonus-track" title={`${eur(ins.invoicedAmount)} € invoiced`}>
                    <span className="cm-bonus-fill" style={{ width: at(ins.invoicedAmount) }} />
                    {minB > 0 && <span className={`cm-bonus-mark ${ins.invoicedAmount >= minB ? "hit" : ""}`} style={{ left: at(minB) }} title={`Min ${eur(minB)} €`} />}
                    {highB > 0 && <span className={`cm-bonus-mark high ${ins.invoicedAmount >= highB ? "hit" : ""}`} style={{ left: at(highB) }} title={`High ${eur(highB)} €`} />}
                  </div>
                );
              })()}
            </section>
          )}

          {/* Billing trend */}
          <section className="cm-sec">
            <div className="cm-sec-head">
              <h3>Billing trend</h3>
              <span className="cm-sec-sub">{ins.trend.length} periods</span>
            </div>
            {ins.trend.length === 0 ? (
              <p className="cm-empty">No billed work in this range.</p>
            ) : (() => {
              // With many periods, labels and value tags collide, so show them
              // only every Nth column — the bars still read as a trend.
              const n = ins.trend.length;
              const step = n <= 12 ? 1 : n <= 26 ? 2 : Math.ceil(n / 12);
              const showText = (i: number) => i % step === 0 || i === n - 1;
              return (
                <div className={`cm-trend ${n > 20 ? "is-dense" : ""}`}>
                  {ins.trend.map((t, i) => (
                    <div className="cm-trend-col" key={i} title={`${t.label}: ${eur(t.amount)} € · ${d2(t.days)}d`}>
                      <span className="cm-trend-val">
                        {showText(i) ? (t.amount >= 1000 ? `${Math.round(t.amount / 1000)}k` : Math.round(t.amount)) : ""}
                      </span>
                      <div className="cm-trend-barwrap">
                        <div className="cm-trend-bar" style={{ height: `${(t.amount / maxTrend) * 100}%` }} />
                      </div>
                      <span className="cm-trend-x">{showText(i) ? t.label : ""}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </section>

          {/* Per-project breakdown */}
          <section className="cm-sec">
            <div className="cm-sec-head"><h3>By project</h3></div>
            {projectRows.length === 0 ? (
              <p className="cm-empty">Nothing logged in this period.</p>
            ) : (
              <div className="cm-proj">
                <div className="cm-proj-head">
                  <span>Client &amp; project</span>
                  <span className="cm-r">Rate</span>
                  <span className="cm-r">Booked</span>
                  <span className="cm-r">Billed</span>
                </div>
                {projectRows.map((v) => {
                  const isOpen = projOpenKey === v.key;
                  const u = v.hourly ? "h" : "d";
                  return (
                    <div key={v.key}>
                      <button className={`cm-proj-row ${isOpen ? "is-open" : ""}`} onClick={() => onToggleProject(v.key)}>
                        <span className="cm-proj-id">
                          <span className={`cm-proj-chev ${isOpen ? "is-open" : ""}`}>›</span>
                          <b>{v.client}</b>
                          <em>{v.service}</em>
                          <span className="cm-proj-kind">{v.rateKind}</span>
                        </span>
                        <span className="cm-r cm-proj-rate">{eur(v.rate)}<u>/{u}</u></span>
                        <span className="cm-r cm-proj-booked"><b>{eur(v.amountPlanned)}</b><i>{d2(v.daysPlanned)}{u}</i></span>
                        <span className="cm-r cm-proj-billed"><b>{eur(v.amountDone)}</b><i>{d2(v.daysDone)}{u}</i></span>
                      </button>
                      {isOpen && <div className="cm-ledger">{renderLedger(v.key)}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body
  );
}