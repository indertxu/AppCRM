import { useEffect, useState } from "react";

export interface UserTarget {
  minPerWeek: number | null;
  minPerMonth: number | null;
  minRevenueWeek: number | null;
  minRevenueMonth: number | null;
}

interface Props {
  name: string;
  /** Company-wide defaults, shown when a field has no override. */
general: { minPerWeek: number; minPerMonth: number; minRevenueWeek: number; minRevenueMonth: number };
  value: UserTarget;
  onSave: (v: UserTarget) => void;
  onClose: () => void;
}

const ROWS: { key: keyof UserTarget; label: string; note: string; icon: string; step: number }[] = [
  { key: "minPerWeek", label: "Days per week", note: "Billable days expected each week.", icon: "🗓️", step: 0.25 },
  { key: "minPerMonth", label: "Days per month", note: "Billable days expected each month.", icon: "📆", step: 0.5 },
 { key: "minRevenueWeek", label: "Billing per week", note: "Revenue expected each week.", icon: "💶", step: 100 },
  { key: "minRevenueMonth", label: "Billing per month", note: "Revenue expected each month.", icon: "🏦", step: 100 },
];

export default function UserTargetModal({ name, general, value, onSave, onClose }: Props) {
  const [v, setV] = useState<UserTarget>(value);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fallback = (k: keyof UserTarget) =>
k === "minPerWeek" ? general.minPerWeek
    : k === "minPerMonth" ? general.minPerMonth
    : k === "minRevenueWeek" ? general.minRevenueWeek
    : general.minRevenueMonth;

  const toggle = (k: keyof UserTarget) =>
    setV((s) => ({ ...s, [k]: s[k] === null ? fallback(k) : null }));

  return (
    <div className="ut-backdrop" onMouseDown={onClose}>
      <div className="ut-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="ut-head">
          <div>
            <span className="ut-eyebrow">Personal targets</span>
            <h2 className="ut-title">{name}</h2>
          </div>
          <button className="ut-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <p className="ut-note">
          Turn a target on to override the company default for this person. Left off, they follow the general target.
        </p>

        <div className="ut-rows">
          {ROWS.map((row) => {
            const custom = v[row.key] !== null;
            return (
              <div className={`ut-row ${custom ? "is-custom" : ""}`} key={row.key}>
                <span className="ut-ico">{row.icon}</span>
                <span className="ut-text">
                  <span className="ut-label">{row.label}</span>
                  <span className="ut-sub">
                    {custom ? row.note : `Using company default · ${fallback(row.key).toLocaleString()}`}
                  </span>
                </span>

                {custom && (
                  <input
                    type="number"
                    min="0"
                    step={row.step}
                    className="ut-input"
                    value={v[row.key] ?? 0}
                    onChange={(e) => setV((s) => ({ ...s, [row.key]: Number(e.target.value) || 0 }))}
                  />
                )}

                <button
                  type="button"
                  role="switch"
                  aria-checked={custom}
                  className={`ncm-switch ${custom ? "on" : ""}`}
                  onClick={() => toggle(row.key)}
                >
                  <span className="ncm-switch-knob" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="ut-foot">
          <button className="ut-cancel" onClick={onClose}>Cancel</button>
          <button className="ut-save" onClick={() => onSave(v)}>Save targets</button>
        </div>
      </div>
    </div>
  );
}