import { useEffect, useState } from "react";
import DatePicker from "../../framework/DatePicker";
import { billingWindow, cutoffOf, periodOf, type Cutoffs } from "./billingPeriods";
import "./CalendarSettingsModal.css";

export interface Targets {
  perDay: number;
  minPerDay: number;
  minPerWeek: number;
  minPerMonth: number;
  minRevenueWeek?: number;
  minRevenueMonth: number;
  highPerMonth?: number;
  highRevenueMonth?: number;
}

export interface WorkTypeDef {
  id: string;
  name: string;
  clientRelated: boolean;
  color: string;
}

const uid = () => crypto.randomUUID();

const SWATCHES = ["#12b57f", "#0a6f4d", "#3aa6a0", "#5b8def", "#b06fd0", "#e08b3e", "#d64545", "#6b7f8f"];

export interface CapConsultant { userId: string; name: string; }
export interface CapValue {
  fullDays: number | null;        // full working days / week (capacity)
  // Tier 1 (minimum)
  minDays: number | null;         // days / month
  minBilling: number | null;      // € invoiced / month
  bonusPct1: number | null;       // %
  // Tier 2 (higher)
  highDays: number | null;
  highBilling: number | null;
  bonusPct2: number | null;
}
const emptyCap = (): CapValue => ({
  fullDays: null, minDays: null, minBilling: null, bonusPct1: null,
  highDays: null, highBilling: null, bonusPct2: null,
});

interface Props {
  types: WorkTypeDef[];
  setTypes: React.Dispatch<React.SetStateAction<WorkTypeDef[]>>;
targets: Targets;
  setTargets: React.Dispatch<React.SetStateAction<Targets>>;
  cutoffs?: Cutoffs;
  setCutoffs?: React.Dispatch<React.SetStateAction<Cutoffs>>;
  defaultCutoffDay?: number;
  setDefaultCutoffDay?: React.Dispatch<React.SetStateAction<number>>;
  targetsOnly?: boolean;
  /** Management mode: shows Targets + Cutoffs + per-consultant Capacity. */
  managementMode?: boolean;
  /** Calendar mode: hide the Targets tab (targets live in Management now). */
  hideTargets?: boolean;
  consultants?: CapConsultant[];
  capacity?: Record<string, CapValue>;
  onCapacityChange?: (userId: string, patch: Partial<CapValue>) => void;
  onCapacitySave?: (userId: string) => void;
  capSavedId?: string | null;
  /** When set, open on the capacity tab with this consultant expanded. */
  initialCapOpen?: string | null;
  /** Time off: holidays + yearly vacation allowance (calendar mode). */
  holidays?: string[];                                    // ISO dates
  onAddHoliday?: (iso: string, name: string) => void;
  onRemoveHoliday?: (iso: string) => void;
  vacationAllowance?: number;
  setVacationAllowance?: (n: number) => void;
  canEditTimeOff?: boolean;                               // only boss edits allowance/holidays
  onClose: () => void;
}

export default function CalendarSettingsModal({
  types, setTypes, targets, setTargets,
  cutoffs = {}, setCutoffs = () => {}, defaultCutoffDay = 0, setDefaultCutoffDay = () => {},
  targetsOnly = false, managementMode = false, hideTargets = false,
  consultants = [], capacity = {}, onCapacityChange = () => {}, onCapacitySave = () => {}, capSavedId = null,
  initialCapOpen = null,
  holidays = [], onAddHoliday = () => {}, onRemoveHoliday = () => {},
  vacationAllowance = 22, setVacationAllowance = () => {}, canEditTimeOff = false,
  onClose,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<"types" | "targets" | "billing" | "capacity" | "timeoff">(
    initialCapOpen ? "capacity" : (managementMode || targetsOnly ? "capacity" : "types")
  );
  const [capOpen, setCapOpen] = useState<string | null>(initialCapOpen);
  const [newHolidayDate, setNewHolidayDate] = useState("");
  const [newHolidayName, setNewHolidayName] = useState("");
  const [revText, setRevText] = useState(String(targets.minRevenueMonth));
  const [cutoffYear, setCutoffYear] = useState(new Date().getFullYear());

  /** The twelve months of the selected year. */
  const cutoffMonths = Array.from({ length: 12 }, (_, m) => periodOf(new Date(cutoffYear, m, 1)));
  const monthLabel = (p: string) => {
    const [y, m] = p.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleString("en", { month: "long", year: "numeric" });
  };
  const setCutoff = (period: string, iso: string) =>
    setCutoffs((c) => ({ ...c, [period]: iso }));


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const addType = () => {
    const id = uid();
    setTypes((t) => [...t, { id, name: "", clientRelated: true, color: SWATCHES[t.length % SWATCHES.length] }]);
    setOpenId(id);
  };
  const patch = (id: string, p: Partial<WorkTypeDef>) =>
    setTypes((t) => t.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const remove = (id: string) => {
    setTypes((t) => t.filter((x) => x.id !== id));
    if (openId === id) setOpenId(null);
  };

  return (
    <div className="cws-backdrop" onMouseDown={onClose}>
      <div className="cws-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="cws-head">
          <div>
            <span className="cws-eyebrow">{managementMode ? "Management settings" : "Calendar settings"}</span>
            <h2 className="cws-title">{tab === "types" ? "Types of work" : tab === "targets" ? "Billable targets" : tab === "capacity" ? "Targets & bonus" : tab === "timeoff" ? "Time off" : "Billing cutoffs"}</h2>
          </div>
          <button className="cws-x" onClick={onClose} aria-label="Close">×</button>
        </div>

       <div className="cws-tabs" style={targetsOnly && !managementMode ? { display: "none" } : undefined}>
          {!managementMode && <button className={`cws-tab ${tab === "types" ? "is-on" : ""}`} onClick={() => setTab("types")}>Types of work</button>}
          {!managementMode && !hideTargets && <button className={`cws-tab ${tab === "targets" ? "is-on" : ""}`} onClick={() => setTab("targets")}>Targets</button>}
          {managementMode && <button className={`cws-tab ${tab === "capacity" ? "is-on" : ""}`} onClick={() => setTab("capacity")}>Targets & bonus</button>}
          {!managementMode && <button className={`cws-tab ${tab === "timeoff" ? "is-on" : ""}`} onClick={() => setTab("timeoff")}>Time off</button>}
          <button className={`cws-tab ${tab === "billing" ? "is-on" : ""}`} onClick={() => setTab("billing")}>Cutoffs</button>
        </div>

        {tab === "targets" ? (
<div className="cws-body">
            <p className="cws-hint cws-intro">Billable consultancy days expected from each consultant.</p>

            {[
{ key: "perDay" as const, label: "Target per day", note: "What a full day of client work adds up to.", icon: "🎯" },
              { key: "minPerDay" as const, label: "Minimum per day", note: "Below this, the day shows as under target.", icon: "☀️" },
{ key: "minPerWeek" as const, label: "Minimum per week", note: "Expected total across Mon–Fri.", icon: "🗓️" },
              { key: "minPerMonth" as const, label: "Minimum per month", note: "Billable days expected each month.", icon: "📆" },
            ].map((row) => (
              <div className="cws-target" key={row.key}>
                <span className="cws-target-icon">{row.icon}</span>
                <span className="cws-target-text">
                  <span className="cws-target-label">{row.label}</span>
                  <span className="cws-target-note">{row.note}</span>
                </span>
                <span className="cws-stepper">
                  <button type="button" onClick={() => setTargets((t) => ({ ...t, [row.key]: Math.max(0, +(t[row.key] - 0.25).toFixed(2)) }))}>−</button>
                  <span className="cws-stepper-val">
                    <b>{targets[row.key].toFixed(2)}</b>
                    <i>days</i>
                  </span>
                  <button type="button" onClick={() => setTargets((t) => ({ ...t, [row.key]: +(t[row.key] + 0.25).toFixed(2) }))}>+</button>
                </span>
              </div>
            ))}
<div className="cws-target">
              <span className="cws-target-icon">💶</span>
              <span className="cws-target-text">
                <span className="cws-target-label">Minimum billing per week</span>
                <span className="cws-target-note">Revenue expected each week.</span>
              </span>
              <span className="cws-amount">
                <input type="number" min="0" step="100" className="cws-amount-input"
                  value={targets.minRevenueWeek}
                  onChange={(e) => setTargets((t) => ({ ...t, minRevenueWeek: Number(e.target.value) || 0 }))} />
              </span>
            </div>

            <div className="cws-target">
              <span className="cws-target-icon">🏦</span>
              <span className="cws-target-text">
                <span className="cws-target-label">Minimum billing per month</span>
                <span className="cws-target-note">Revenue expected from billable days.</span>
              </span>
<span className="cws-amount">
<input
                  type="number"
                  min="0"
                  step="100"
                  className="cws-amount-input"
                  value={revText}
                  placeholder="0"
                  onFocus={(e) => { if (targets.minRevenueMonth === 0) setRevText(""); e.target.select(); }}
                  onBlur={() => setRevText(String(targets.minRevenueMonth))}
                  onChange={(e) => {
                    setRevText(e.target.value);
                    setTargets((t) => ({ ...t, minRevenueMonth: Number(e.target.value) || 0 }));
                  }}
                />
</span>
            </div>
          </div>
        ) : tab === "timeoff" ? (
          <div className="cws-body">
            <p className="cws-hint cws-intro">
              Holidays are company-wide non-working days. The yearly allowance is how many
              vacation days each person may take — everyone books their own from the calendar.
            </p>

            <div className="cws-target" style={{ marginBottom: "1.3rem" }}>
              <span className="cws-target-icon">🏖️</span>
              <span className="cws-target-text">
                <span className="cws-target-label">Vacation days / year</span>
                <span className="cws-target-note">Allowance per consultant</span>
              </span>
              <div className="cws-stepper">
                <button onClick={() => canEditTimeOff && setVacationAllowance(Math.max(0, vacationAllowance - 1))} disabled={!canEditTimeOff}>−</button>
                <span className="cws-stepper-val"><b>{vacationAllowance}</b><i>days</i></span>
                <button onClick={() => canEditTimeOff && setVacationAllowance(vacationAllowance + 1)} disabled={!canEditTimeOff}>+</button>
              </div>
            </div>

            <p className="cws-hint" style={{ margin: "0 0 10px", fontWeight: 600 }}>Public holidays</p>
            {canEditTimeOff && (
              <div className="cws-holiday-add">
                <div className="cws-holiday-pick">
                  <DatePicker value={newHolidayDate} onChange={setNewHolidayDate} placeholder="Pick a date" />
                </div>
                <input
                  className="cws-input cws-holiday-name"
                  placeholder="Name (e.g. Christmas)"
                  value={newHolidayName}
                  onChange={(e) => setNewHolidayName(e.target.value)}
                />
                <button
                  className="cws-add"
                  style={{ margin: 0 }}
                  disabled={!newHolidayDate}
                  onClick={() => { onAddHoliday(newHolidayDate, newHolidayName.trim()); setNewHolidayDate(""); setNewHolidayName(""); }}
                >Add</button>
              </div>
            )}
            {holidays.length === 0 ? (
              <p className="cws-hint">No holidays yet.</p>
            ) : (
              <div className="cws-holiday-list">
                {[...holidays].sort().map((iso) => (
                  <div className="cws-holiday-row" key={iso}>
                    <span className="cws-holiday-date">{new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}</span>
                    {canEditTimeOff && <button className="cws-del" onClick={() => onRemoveHoliday(iso)} aria-label="Remove">×</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : tab === "billing" ? (
          <div className="cws-body">
            <p className="cws-hint cws-intro">
              The date each month’s billing closes. A billing month runs from the day after the
              previous month’s cutoff up to and including this month’s cutoff.
            </p>

            <div className="cws-target">
              <span className="cws-target-icon">📌</span>
              <span className="cws-target-text">
                <span className="cws-target-label">Default cutoff day</span>
                <span className="cws-target-note">Used for any month without a specific date. 0 = last day of month.</span>
              </span>
              <span className="cws-stepper">
                <button type="button" onClick={() => setDefaultCutoffDay((d) => Math.max(0, d - 1))}>−</button>
                <span className="cws-stepper-val">
                  <b>{defaultCutoffDay === 0 ? "Last" : defaultCutoffDay}</b>
                  <i>{defaultCutoffDay === 0 ? "day" : "of month"}</i>
                </span>
                <button type="button" onClick={() => setDefaultCutoffDay((d) => Math.min(28, d + 1))}>+</button>
              </span>
            </div>

            <p className="cws-hint" style={{ margin: "1.2rem 0 0.6rem" }}>Per-month cutoff</p>
            <div className="cws-year-nav">
              <button type="button" onClick={() => setCutoffYear((y) => y - 1)} aria-label="Previous year">‹</button>
              <span>{cutoffYear}</span>
              <button type="button" onClick={() => setCutoffYear((y) => y + 1)} aria-label="Next year">›</button>
            </div>
            {cutoffMonths.map((period) => {
              const win = billingWindow(period, cutoffs, defaultCutoffDay);
              const isCustom = !!cutoffs[period];
              return (
                <div className="cws-cutoff" key={period}>
                  <div className="cws-cutoff-info">
                    <span className="cws-cutoff-month">{monthLabel(period)}</span>
                    <span className="cws-cutoff-window">
                      counts {win.from} → {win.to}
                      {isCustom ? "" : " (default)"}
                    </span>
                  </div>
                  <div className="cws-cutoff-pick">
                    <DatePicker
                      value={cutoffOf(period, cutoffs, defaultCutoffDay)}
                      onChange={(iso) => setCutoff(period, iso)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : tab === "capacity" ? (
          <div className="cws-body">
            <p className="cws-hint" style={{ margin: "0 0 1rem" }}>
              Per consultant: weekly capacity, monthly billing targets and the variable bonus.
              Two tiers — reach the minimum to earn bonus %1; billing above the higher target earns %2.
              Bonus is paid on invoiced revenue (moved billing counts where it was invoiced).
            </p>
            {consultants.length === 0 ? (
              <p className="cws-hint">No consultants found.</p>
            ) : (
              <div className="cws-cap">
                {consultants.map((c) => {
                  const v = { ...emptyCap(), ...(capacity[c.userId] ?? {}) };
                  const inits = c.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
                  const isOpen = capOpen === c.userId;
                  const num = (field: keyof CapValue, ph: string, max?: number) => (
                    <input
                      className="cws-cap-input" type="number" min="0" max={max} step={field.includes("Billing") ? 100 : 0.5}
                      placeholder={ph}
                      value={v[field] ?? ""}
                      onChange={(e) => onCapacityChange(c.userId, { [field]: e.target.value === "" ? null : Number(e.target.value) })}
                    />
                  );
                  return (
                    <div className={`cws-capc ${isOpen ? "is-open" : ""}`} key={c.userId}>
                      <button className="cws-capc-head" onClick={() => setCapOpen(isOpen ? null : c.userId)}>
                        <span className="cws-cap-av">{inits}</span>
                        <span className="cws-cap-name">{c.name}</span>
                        <span className="cws-capc-summary">
                          {v.fullDays != null ? `${v.fullDays}d/wk cap` : "no cap"}
                          {v.bonusPct1 != null ? ` · ${v.bonusPct1}%` : ""}
                          {v.bonusPct2 != null ? ` / ${v.bonusPct2}%` : ""}
                        </span>
                        <span className={`cws-capc-chev ${isOpen ? "is-open" : ""}`}>›</span>
                      </button>
                      {isOpen && (
                        <div className="cws-capc-body">
                          <div className="cws-capc-row">
                            <label>Full working days / week</label>
                            {num("fullDays", "5", 7)}
                          </div>

                          <div className="cws-capc-tier">
                            <span className="cws-capc-tierhead cws-tier1">Minimum target → bonus %1</span>
                            <div className="cws-capc-grid">
                              <div className="cws-capc-cell"><label>Days / month</label>{num("minDays", "—")}</div>
                              <div className="cws-capc-cell"><label>Billing / month €</label>{num("minBilling", "—")}</div>
                              <div className="cws-capc-cell"><label>Bonus %1</label>{num("bonusPct1", "—", 100)}</div>
                            </div>
                          </div>

                          <div className="cws-capc-tier">
                            <span className="cws-capc-tierhead cws-tier2">Higher target → bonus %2</span>
                            <div className="cws-capc-grid">
                              <div className="cws-capc-cell"><label>Days / month</label>{num("highDays", "—")}</div>
                              <div className="cws-capc-cell"><label>Billing / month €</label>{num("highBilling", "—")}</div>
                              <div className="cws-capc-cell"><label>Bonus %2</label>{num("bonusPct2", "—", 100)}</div>
                            </div>
                          </div>

                          <button
                            className={`cws-cap-save cws-capc-save ${capSavedId === c.userId ? "is-saved" : ""}`}
                            onClick={() => onCapacitySave(c.userId)}
                          >
                            {capSavedId === c.userId ? "Saved ✓" : "Save"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
        <div className="cws-body">
          <button className="cws-add" onClick={addType}>+ New type of work</button>
          {types.length === 0 && <p className="cws-hint">No types of work yet.</p>}

          {types.map((t) => {
            if (openId !== t.id) {
              return (
                <div className="cws-row" key={t.id}>
                  <button className="cws-row-main" onClick={() => setOpenId(t.id)}>
                    <span className="cws-dot" style={{ background: t.color }} />
                    <span className="cws-row-text">
                      <span className="cws-row-name">{t.name || "Untitled type"}</span>
                      <span className="cws-row-sub">{t.clientRelated ? "Client related" : "Not client related"}</span>
                    </span>
                  </button>
                  <button className="cws-del" onClick={() => remove(t.id)} aria-label="Remove">×</button>
                </div>
              );
            }
            return (
              <div className="cws-edit" key={t.id}>
                <button className="cws-bar" onClick={() => setOpenId(null)}>
                  <span>{t.name || "Untitled type"}</span>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>
                </button>

                <div className="cws-field">
                  <label>Name</label>
                  <input className="cws-input" placeholder="e.g. Live session" value={t.name}
                    onChange={(e) => patch(t.id, { name: e.target.value })} />
                </div>

                <div className="cws-toggle-row">
                  <span className="cws-toggle-label">Client related</span>
                  <button type="button" role="switch" aria-checked={t.clientRelated}
                    className={`cws-switch ${t.clientRelated ? "on" : ""}`}
                    onClick={() => patch(t.id, { clientRelated: !t.clientRelated })}>
                    <span className="cws-knob" />
                  </button>
                </div>

                <div className="cws-field">
                  <label>Colour</label>
                  <div className="cws-swatches">
                    {SWATCHES.map((c) => (
                      <button key={c} type="button" aria-label={c}
                        className={`cws-swatch ${t.color === c ? "is-sel" : ""}`}
                        style={{ background: c }} onClick={() => patch(t.id, { color: c })} />
                    ))}
                  </div>
                </div>

                <div className="cws-edit-foot">
                  <button className="cws-remove-text" onClick={() => remove(t.id)}>Delete type</button>
                  <button className="cws-done" onClick={() => setOpenId(null)}>Done</button>
                </div>
              </div>
            );
          })}
        </div>
        )}

        <div className="cws-foot">
          <button className="cws-done" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}