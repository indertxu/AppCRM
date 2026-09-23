/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import "./BillingAdjustModal.css";

export type Line = "consultor" | "supervision" | "connector";

export interface AdjustBill {
  key: string;
  projectId: string;
  period: string;
  clientId: string;
  typeId: string;
  type: string;
  legalName: string;
  vat: string;
  address: string;
  contact: { name: string; email: string } | null;
  rate: number;
  supervisionRate: number;
  taxed: boolean;
  taxRate: number;
  lines: Record<Line, number>;
  rows: { id: string; date: string; userId: string; days: number; line: Line; status: string; moved?: boolean }[];
}
export interface AdjustInvoice {
  id: string; projectId: string; period: string;
  net: number; amount: number; days: number;
  sentDate: string; dueDate: string; paidDate: string;
  status: string;
}

interface Props {
  bill: AdjustBill;
  invoice: AdjustInvoice | null;
  unit: "d" | "h";
  minUnit?: number;
  clientName: string;
  people: Record<string, string>;
  periodLabel: string;
  onClose: () => void;
  onSave?: (rows: EditRow[]) => void;
}

export interface EditRow {
  id: string; date: string; userId: string; days: number; origDays: number; line: Line; status: string; moved?: boolean; removed: boolean;
}

const eur = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lineLabel: Record<Line, string> = { consultor: "Consultancy", supervision: "Supervision", connector: "Connector" };
const baDate = (iso: string) => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export default function BillingAdjustModal({
  bill, invoice, unit, minUnit, clientName, people, periodLabel, onClose, onSave,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  const step = minUnit && minUnit > 0 ? minUnit : (unit === "h" ? 0.5 : 0.25);

  const [rows, setRows] = useState<EditRow[]>(
    () => [...bill.rows]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ ...r, origDays: r.days, removed: false }))
  );

  const rateOf = (ln: Line) => (ln === "supervision" ? bill.supervisionRate : bill.rate);

  const bump = (id: string, dir: 1 | -1) =>
    setRows((rs) => rs.map((r) => r.id === id
      ? { ...r, days: Math.max(0, round2(r.days + dir * step)) }
      : r));
  const toggleRemove = (id: string) =>
    setRows((rs) => rs.map((r) => r.id === id ? { ...r, removed: !r.removed } : r));
  const resetAll = () =>
    setRows((rs) => rs.map((r) => ({ ...r, days: r.origDays, removed: false })));

  const live = useMemo(() => {
    const lines: Record<Line, number> = { consultor: 0, supervision: 0, connector: 0 };
    const per: Record<string, { days: number; value: number }> = {};
    rows.forEach((r) => {
      if (r.removed) return;
      lines[r.line] += r.days;
      if (!per[r.userId]) per[r.userId] = { days: 0, value: 0 };
      per[r.userId].days += r.days;
      per[r.userId].value += r.days * rateOf(r.line);
    });
    const net = (["consultor", "supervision", "connector"] as Line[]).reduce((s, ln) => s + lines[ln] * rateOf(ln), 0);
    const gross = net * (bill.taxed ? 1 + bill.taxRate / 100 : 1);
    const owners = Object.entries(per).sort((a, b) => b[1].value - a[1].value);
    const totalDays = lines.consultor + lines.supervision + lines.connector;
    return { lines, net, gross, owners, totalDays };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const ownerMax = Math.max(0.0001, ...live.owners.map(([, v]) => v.value));
  const tax = +(live.gross - live.net).toFixed(2);
  const dirty = rows.some((r) => r.removed || r.days !== r.origDays);

  const statusChip = invoice
    ? (invoice.status === "paid" ? { cls: "is-paid", label: "Paid" } : { cls: "is-sent", label: "Sent" })
    : { cls: "is-tobill", label: "To bill" };

  return createPortal(
    <div className="ba-backdrop" onMouseDown={onClose}>
      <div className="ba" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Adjust ${clientName} ${periodLabel}`}>
        <header className="ba-head">
          <div className="ba-head-main">
            <span className="ba-av">{clientName.charAt(0).toUpperCase()}</span>
            <div className="ba-id">
              <h2 className="ba-name">{clientName}</h2>
              <span className="ba-sub">{bill.type} · {periodLabel}</span>
            </div>
            <span className={`ba-status ${statusChip.cls}`}>{statusChip.label}</span>
          </div>
          <button className="ba-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="ba-body">
          <div className="ba-top">
            <section className="ba-card">
              <h3 className="ba-card-h">How this bill was invoiced</h3>
              {(["consultor", "supervision", "connector"] as Line[]).map((ln) =>
                live.lines[ln] > 0 ? (
                  <div className={`ba-line is-${ln}`} key={ln}>
                    <span className="ba-line-name"><i />{lineLabel[ln]}</span>
                    <span className="ba-line-calc">{live.lines[ln].toFixed(2)}{unit} × {rateOf(ln).toLocaleString()} €</span>
                    <span className="ba-line-val">{eur(live.lines[ln] * rateOf(ln))} €</span>
                  </div>
                ) : null
              )}
              <div className="ba-line is-net">
                <span className="ba-line-name">Net</span><span className="ba-line-calc">{live.totalDays.toFixed(2)}{unit}</span>
                <span className="ba-line-val">{eur(live.net)} €</span>
              </div>
              {bill.taxed && (
                <div className="ba-line">
                  <span className="ba-line-name">Tax</span><span className="ba-line-calc">{bill.taxRate}%</span>
                  <span className="ba-line-val">{eur(tax)} €</span>
                </div>
              )}
              <div className="ba-line is-total">
                <span className="ba-line-name">Total</span><span className="ba-line-calc" />
                <span className="ba-line-val">{eur(live.gross)} €</span>
              </div>
              {invoice && dirty && (
                <p className="ba-frozen">
                  Was invoiced at {eur(invoice.amount)} €. Preview after your changes: {eur(live.gross)} €.
                </p>
              )}
            </section>

            <section className="ba-card">
              <h3 className="ba-card-h">Who's responsible</h3>
              {live.owners.length === 0 ? (
                <p className="ba-empty">No entries counted.</p>
              ) : live.owners.map(([uid, v]) => (
                <div className="ba-owner" key={uid}>
                  <span className="ba-av is-sm">{(people[uid] ?? "?").charAt(0).toUpperCase()}</span>
                  <span className="ba-oname">{people[uid] ?? "Unknown"}</span>
                  <span className="ba-odays">{v.days.toFixed(2)}{unit}</span>
                  <span className="ba-oval">{eur(v.value)} €</span>
                  <span className="ba-obar" aria-hidden="true"><i style={{ width: `${(v.value / ownerMax) * 100}%` }} /></span>
                </div>
              ))}
            </section>
          </div>

          <section className="ba-card ba-ledger-card">
            <div className="ba-ledger-top">
              <h3 className="ba-card-h">Entries recorded this period</h3>
              <span className="ba-step-note">± in steps of {step}{unit}</span>
              {dirty && <button type="button" className="ba-reset" onClick={resetAll}>Reset</button>}
            </div>
            {rows.length === 0 ? (
              <p className="ba-empty">No entries.</p>
            ) : (
              <div className="ba-ledger">
                <div className="ba-lhead">
                  <span>Date</span><span>Consultant</span><span>Line</span>
                  <span className="ba-r">{unit === "h" ? "Hours" : "Days"}</span>
                  <span className="ba-r">Value</span>
                  <span className="ba-lc">Adjust</span>
                  <span />
                </div>
                <div className="ba-lscroll">
                  {rows.map((r) => (
                    <div className={`ba-lrow ${r.removed ? "is-removed" : ""} ${r.days !== r.origDays ? "is-edited" : ""}`} key={r.id}>
                      <span className="ba-ldate">{baDate(r.date)}{r.moved && <em className="ba-lmoved">moved</em>}</span>
                      <span className="ba-lname">{people[r.userId] ?? "Unknown"}</span>
                      <span className={`ba-ltag is-${r.line}`}>{lineLabel[r.line]}</span>
                      <span className="ba-r ba-ldays">
                        {r.days.toFixed(2)}
                        {r.days !== r.origDays && <em className="ba-lorig">was {r.origDays.toFixed(2)}</em>}
                      </span>
                      <span className="ba-r">{eur(r.days * rateOf(r.line))} €</span>
                      <span className="ba-lc">
                        <button type="button" className="ba-step" onClick={() => bump(r.id, -1)} disabled={r.removed || r.days <= 0} aria-label="Decrease">−</button>
                        <button type="button" className="ba-step" onClick={() => bump(r.id, 1)} disabled={r.removed} aria-label="Increase">+</button>
                      </span>
                      <span>
                        <button type="button" className={`ba-del ${r.removed ? "is-on" : ""}`} onClick={() => toggleRemove(r.id)} title={r.removed ? "Restore entry" : "Remove entry"}>
                          {r.removed ? "Undo" : "×"}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>

        <footer className="ba-foot">
          <span className="ba-foot-note">
            {dirty ? "Preview only — nothing is saved yet." : "No changes."}
          </span>
          <div className="ba-foot-actions">
            <button type="button" className="ba-btn is-ghost" onClick={onClose}>Close</button>
            <button type="button" className="ba-btn is-primary" disabled={!dirty} onClick={() => onSave?.(rows)}>
              Save changes
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body
  );
}