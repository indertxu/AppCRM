import { useState } from "react";
import type { ContractFigures } from "./contractsApi";
import "./ContractTerms.css";

/* =====================================================================
   A contract's life on one line: signed → grace period → it starts →
   each paid period (and the invoice that goes out before it) → it ends /
   renews (with the renewal invoice and the last day to give notice).
   Below it (full), the payment plan invoice by invoice.
   ===================================================================== */

const T = (iso: string) => +new Date(`${iso}T12:00:00Z`);
const today = () => new Date().toISOString().slice(0, 10);
export const cpDay = (iso: string, y: "numeric" | "2-digit" = "numeric") => new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: y });
const short = (n: number) => (Math.abs(n) >= 1e4 ? `${(n / 1e3).toLocaleString("de-DE", { maximumFractionDigits: 1 })}k` : Math.round(n).toLocaleString("de-DE"));
export const graceLabel = (days: number) => {
  if (days <= 0) return "";
  const m = Math.round(days / 30.44);
  return Math.abs(days - m * 30.44) <= 3 && m > 0 ? `${m} month${m === 1 ? "" : "s"}` : `${days} day${days === 1 ? "" : "s"}`;
};

export function ContractTrack({ f, compact }: { f: ContractFigures; compact?: boolean }) {
  const now = today();
  const firstInv = f.invoices[0]?.date ?? f.start;
  const t0 = Math.min(T(f.signed), T(firstInv), T(f.start));
  const tEnd = T(f.end);
  const span = Math.max(1, tEnd - t0);
  const t1 = tEnd + span * 0.05;
  const pc = (iso: string) => Math.max(0, Math.min(100, ((T(iso) - t0) / (t1 - t0)) * 100));
  const pos = (iso: string) => `${pc(iso)}%`;
  const edge = (iso: string) => (pc(iso) < 5 ? "is-l" : pc(iso) > 95 ? "is-r" : "");
  const next = f.invoices.find((iv) => iv.date >= now);
  const labels = !compact && f.invoices.length <= 6;
  const showToday = T(now) > t0 && T(now) < t1;
  return (
    <div className={`ctp-track ${compact ? "is-compact" : ""} ${labels ? "has-labels" : ""}`} aria-hidden="true">
      <div className="ctp-rail">
        {f.graceDays > 0 && <span className="ctp-grace" style={{ left: pos(f.signed), width: `calc(${pos(f.start)} - ${pos(f.signed)})` }}></span>}
        {f.invoices.map((iv, i) => (
          <span key={i} className={`ctp-per ${i % 2 ? "is-alt" : ""}`} style={{ left: pos(iv.from), width: `calc(${pos(iv.to)} - ${pos(iv.from)})` }} />
        ))}
        {f.invoices.length === 0 && <span className="ctp-per" style={{ left: pos(f.start), width: `calc(${pos(f.end)} - ${pos(f.start)})` }} />}
        {f.renewal && <span className="ctp-after" style={{ left: pos(f.end) }} />}
      </div>
      {f.invoices.map((iv, i) => (
        <span key={i} className={`ctp-pin ${edge(iv.date)} ${iv.date < now ? "is-past" : ""} ${next === iv ? "is-next" : ""}`} style={{ left: pos(iv.date) }} title={`${cpDay(iv.date)} · ${iv.label}`}>
          {labels && <b>{short(iv.amount)}</b>}<i />
        </span>
      ))}
      {f.renewal && <span className={`ctp-pin is-renew ${edge(f.renewal.invoiceDate)}`} style={{ left: pos(f.renewal.invoiceDate) }}>{labels && <b>↻</b>}<i /></span>}
      {f.renewal?.noticeBy && T(f.renewal.noticeBy) > t0 && <span className="ctp-notice" style={{ left: pos(f.renewal.noticeBy) }} title={`Notice by ${cpDay(f.renewal.noticeBy)}`} />}
      <span className="ctp-dot is-signed" style={{ left: pos(f.signed) }} />
      {f.graceDays > 0 && <span className="ctp-dot is-start" style={{ left: pos(f.start) }} />}
      <span className="ctp-dot is-end" style={{ left: pos(f.end) }} />
      {showToday && <span className="ctp-today" style={{ left: pos(now) }}>{!compact && <em>Today</em>}</span>}
      {!compact && (
        <div className="ctp-legend">
          <span><i className="is-signed" />Signed</span>
          {f.graceDays > 0 && <span><i className="is-grace" />Grace</span>}
          <span><i className="is-start" />Starts</span>
          <span><i className="is-pin" />Invoice</span>
          {f.renewal?.noticeBy && <span><i className="is-notice" />Notice by</span>}
          <span><i className="is-end" />{f.renewal ? "Renews" : "Ends"}</span>
        </div>
      )}
    </div>
  );
}

/** The milestones as chips: signed, grace, starts, ends, renewal invoice, notice. */
export function ContractMilestones({ f }: { f: ContractFigures }) {
  return (
    <div className="ctp-ms">
      <span><em>Signed</em><b>{cpDay(f.signed)}</b></span>
      {f.graceDays > 0 && <span className="is-grace"><em>Grace</em><b>{graceLabel(f.graceDays)}</b></span>}
      <span className="is-start"><em>Starts</em><b>{cpDay(f.start)}</b></span>
      <span><em>{f.renewal ? "Renews" : "Ends"}</em><b>{cpDay(f.end)}</b></span>
      {f.renewal?.noticeBy && <span className="is-notice"><em>Notice by</em><b>{cpDay(f.renewal.noticeBy)}</b></span>}
    </div>
  );
}

/** The payment plan: every invoice — when it goes out, what it covers, when it's due — and the renewal one. */
export function PaymentPlan({ f, money, max = 6 }: { f: ContractFigures; money: (n: number) => string; max?: number }) {
  const [all, setAll] = useState(false);
  const now = today();
  const next = f.invoices.find((iv) => iv.date >= now);
  const rows = all ? f.invoices : f.invoices.slice(0, max);
  return (
    <div className="ctp-plan">
      {rows.map((iv, i) => {
        const st = iv.date < now ? "sent" : iv === next ? "next" : "later";
        return (
          <div key={i} className={`ctp-row is-${st}`}>
            <span className="ctp-row-d"><b>{cpDay(iv.date, "2-digit")}</b><em>due {cpDay(iv.due, "2-digit")}</em></span>
            <span className="ctp-row-t"><b>{iv.label}</b><em>{cpDay(iv.from, "2-digit")} → {cpDay(iv.to, "2-digit")}</em></span>
            <span className="ctp-row-s">{st === "sent" ? "Sent" : st === "next" ? "Next" : ""}</span>
            <b className="ctp-row-a">{money(iv.amount)}</b>
          </div>
        );
      })}
      {f.invoices.length > max && (
        <button type="button" className="ctp-more" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${f.invoices.length} invoices`}</button>
      )}
      {f.renewal && (
        <div className="ctp-row is-renew">
          <span className="ctp-row-d"><b>{cpDay(f.renewal.invoiceDate, "2-digit")}</b><em>due {cpDay(f.renewal.due, "2-digit")}</em></span>
          <span className="ctp-row-t"><b>Renewal invoice</b><em>{cpDay(f.renewal.date, "2-digit")} → {cpDay(f.renewal.until, "2-digit")}</em></span>
          <span className="ctp-row-s">Renews</span>
          <b className="ctp-row-a" title="Estimated: the last year's price, before any new increment">≈ {money(f.renewal.amount)}</b>
        </div>
      )}
    </div>
  );
}
