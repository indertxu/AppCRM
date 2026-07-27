import { useEffect, useState } from "react";
import "./ActualModal.css";

const HOURS = Array.from({ length: 17 }, (_, i) => 5 + i);
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function hourLabel(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${period}`;
}
function fmtDur(mins: number): string {
  if (mins <= 0) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ") || "0m";
}

export interface ActualValue {
  startMin: number;
  endMin: number;
  billable: number;
  reason: string;
}

interface Props {
  /** What was originally booked. */
  planned: { startMin: number; endMin: number; billable: number };
  /** Previously logged actual, if any. */
  existing?: ActualValue | null;
  onSave: (v: ActualValue) => void;
  onClear?: () => void;
  onClose: () => void;
}

export default function ActualModal({ planned, existing, onSave, onClear, onClose }: Props) {
  const base = existing ?? planned;
  const [startH, setStartH] = useState(Math.floor(base.startMin / 60));
  const [startM, setStartM] = useState(base.startMin % 60);
  const [endH, setEndH] = useState(Math.floor(base.endMin / 60));
  const [endM, setEndM] = useState(base.endMin % 60);
  const [billable, setBillable] = useState(existing?.billable ?? planned.billable);
  const [reason, setReason] = useState(existing?.reason ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  const error = endMin <= startMin ? "Finish must be after the start." : null;

  const plannedDur = planned.endMin - planned.startMin;
  const actualDur = endMin - startMin;
  const durDelta = actualDur - plannedDur;
  const billDelta = +(billable - planned.billable).toFixed(2);

  const save = () => {
    if (error) return;
    onSave({ startMin, endMin, billable, reason });
  };

  return (
    <div className="am-backdrop" onMouseDown={onClose}>
      <div className="am-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="am-head">
          <div>
            <span className="am-eyebrow">Actuals</span>
            <h2 className="am-title">What really happened</h2>
          </div>
          <button className="am-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <p className="am-note">
          This is logged separately — the original booking stays untouched so deviations can be compared later.
        </p>

        <div className="am-times">
          <div className="am-field">
            <label>Actual start</label>
            <div className="am-time">
              <select value={startH} onChange={(e) => setStartH(Number(e.target.value))}>
                {HOURS.map((h) => (<option key={h} value={h}>{hourLabel(h)}</option>))}
              </select>
              <span className="am-colon">:</span>
              <select value={startM} onChange={(e) => setStartM(Number(e.target.value))}>
                {MINUTES.map((m) => (<option key={m} value={m}>{String(m).padStart(2, "0")}</option>))}
              </select>
            </div>
          </div>

          <div className="am-arrow">→</div>

          <div className="am-field">
            <label>Actual finish</label>
            <div className="am-time">
              <select value={endH} onChange={(e) => setEndH(Number(e.target.value))}>
                {HOURS.map((h) => (<option key={h} value={h}>{hourLabel(h)}</option>))}
              </select>
              <span className="am-colon">:</span>
              <select value={endM} onChange={(e) => setEndM(Number(e.target.value))}>
                {MINUTES.map((m) => (<option key={m} value={m}>{String(m).padStart(2, "0")}</option>))}
              </select>
            </div>
          </div>
        </div>

        <div className="am-compare">
          <div className="am-cmp">
            <span>Planned</span>
            <strong>{fmtDur(plannedDur)}</strong>
          </div>
          <div className="am-cmp">
            <span>Actual</span>
            <strong>{fmtDur(actualDur)}</strong>
          </div>
          <div className={`am-cmp am-delta ${durDelta > 0 ? "is-over" : durDelta < 0 ? "is-under" : ""}`}>
            <span>Deviation</span>
            <strong>{durDelta === 0 ? "—" : `${durDelta > 0 ? "+" : "−"}${fmtDur(Math.abs(durDelta))}`}</strong>
          </div>
        </div>

        <div className="am-field am-block">
          <label>Actually billed</label>
          <div className="am-stepper">
            <button type="button" onClick={() => setBillable((b) => Math.max(0, +(b - 0.25).toFixed(2)))}>−</button>
            <span className="am-stepper-val">
              <b>{billable.toFixed(2)}</b>
              <i>days</i>
            </span>
            <button type="button" onClick={() => setBillable((b) => +(b + 0.25).toFixed(2))}>+</button>
          </div>
          <span className={`am-bill-note ${billDelta > 0 ? "is-over" : billDelta < 0 ? "is-under" : ""}`}>
            {billDelta === 0
              ? `Same as booked (${planned.billable.toFixed(2)}d)`
              : `${billDelta > 0 ? "+" : ""}${billDelta.toFixed(2)}d vs booked ${planned.billable.toFixed(2)}d`}
          </span>
        </div>

        <div className="am-field am-block">
          <label>Reason for the difference <i>(optional)</i></label>
          <input
            className="am-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. client arrived late, extra scope"
          />
        </div>

        {error && <p className="am-error">{error}</p>}

        <div className="am-actions">
          {existing && onClear ? (
            <button className="am-clear" onClick={onClear}>Remove actuals</button>
          ) : (<span />)}
          <div className="am-actions-right">
            <button className="am-cancel" onClick={onClose}>Cancel</button>
            <button className="am-save" onClick={save} disabled={!!error}>
              {existing ? "Update" : "Log actuals"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}