import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import DatePicker from "../../framework/DatePicker";
import { supabase } from "../../api/supabase";
import { billingWindow, cutoffOf, periodOf, type Cutoffs } from "./billingPeriods";
import HoursEditor from "./HoursEditor";
import TimeOffRequestPanel from "./TimeOffRequest";
import { roleSeesAll } from "../companies/companiesApi";
import { useAuth } from "../../api/AuthProvider";
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
  // Capacity is no longer set here: full working days per week now comes from
  // the weekly hours in the calendar settings, so it cannot drift out of step
  // with the days the company is actually open.
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
  minDays: null, minBilling: null, bonusPct1: null,
  highDays: null, highBilling: null, bonusPct2: null,
});

interface Props {
  /** Management → Security tab content. When set (management mode), a Security tab appears. */
  securityPanel?: ReactNode;
  /** Only the Security tab (for people who may edit access but not targets). */
  securityOnly?: boolean;
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
  /** The bonus everyone is on unless their own card overrides it. */
  genBonus?: CapValue;
  setGenBonus?: React.Dispatch<React.SetStateAction<CapValue>>;
  /** What a billed day is worth in hours, for services priced by the hour. */
  hoursPerDay?: number;
  setHoursPerDay?: React.Dispatch<React.SetStateAction<number>>;
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
  /** Calendar page: only "My time off" (time off, holidays, hours and cutoffs are set up in Settings › Calendar). */
  requestOnly?: boolean;
  /** Opens Settings › Calendar (shown to the people who may set it up). */
  onOpenSetup?: () => void;
  onClose: () => void;
}

/** Every ISO date from `a` to `b`, inclusive. */
function spanDays(a: string, b: string): string[] {
  if (!a) return [];
  const start = new Date(`${a}T00:00:00`);
  const end = new Date(`${b || a}T00:00:00`);
  if (end < start) return [a];
  const out: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export default function CalendarSettingsModal({
  types, setTypes, targets, setTargets,
  cutoffs = {}, setCutoffs = () => {}, defaultCutoffDay = 0, setDefaultCutoffDay = () => {},
  targetsOnly = false, managementMode = false, hideTargets = false,
  consultants = [], capacity = {}, onCapacityChange = () => {}, onCapacitySave = () => {}, capSavedId = null,
  genBonus, setGenBonus, hoursPerDay = 8, setHoursPerDay,
  initialCapOpen = null,
  holidays = [], onAddHoliday = () => {}, onRemoveHoliday = () => {},
  vacationAllowance = 22, setVacationAllowance = () => {}, canEditTimeOff = false,
  securityPanel, securityOnly = false, requestOnly = false, onOpenSetup,
  onClose,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  // Types of work are edited in Catalog now, under Blueprints.
  const { role } = useAuth();
  /** Time off, hours and cutoffs are company settings: managers and above. */
  const canSetup = roleSeesAll(role);
  /** Inside Management, its own access rules decide: whoever may open the settings sees Hours and Cutoffs. */
  const canCompany = managementMode ? !securityOnly : canSetup;

  const [tab, setTab] = useState<"targets" | "billing" | "capacity" | "timeoff" | "hours" | "request" | "security">(
    securityOnly && securityPanel ? "security"
      : managementMode ? (canCompany ? "hours" : "security")
      : initialCapOpen ? "capacity" : (targetsOnly ? "capacity" : "request")
  );
  const [capOpen, setCapOpen] = useState<string | null>(initialCapOpen);
  useEffect(() => { if (managementMode) console.info("[settings] management settings v2: Hours · Cutoffs · Security"); }, [managementMode]);
  const [newHolidayDate, setNewHolidayDate] = useState("");
  const [newHolidayName, setNewHolidayName] = useState("");
  const [holidayUntil, setHolidayUntil] = useState("");
  const [revText, setRevText] = useState(String(targets.minRevenueMonth));


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

  // The white pill under the active tab slides to whichever tab is picked.
  const tabsRef = useRef<HTMLDivElement>(null);
  const [inkStyle, setInkStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    const box = tabsRef.current;
    const on = box?.querySelector<HTMLElement>(".cws-tab.is-on");
    if (!box || !on) return;
    setInkStyle({ ["--ink-x" as string]: `${on.offsetLeft}px`, ["--ink-w" as string]: `${on.offsetWidth}px` });
  }, [tab]);

  return (
    <div className="cws-backdrop" onMouseDown={onClose}>
      <div className={`cws-card ${managementMode ? "" : "is-cal"}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="cws-head">
          <div>
            <span className="cws-eyebrow">{managementMode ? "Management settings" : requestOnly ? "Calendar" : "Calendar settings"}</span>
            <h2 className="cws-title">{tab === "security" ? "Security" : tab === "targets" ? "Billable targets" : tab === "capacity" ? "Targets & bonus" : tab === "timeoff" ? "Time off" : tab === "request" ? "My time off" : tab === "hours" ? "Working hours" : "Billing cutoffs"}</h2>
          </div>
          <button className="cws-x" onClick={onClose} aria-label="Close">×</button>
        </div>

       <div className="cws-tabs" style={(targetsOnly && !managementMode) || requestOnly ? { display: "none" } : undefined}>
        <div className="cws-tabs-in" ref={tabsRef} style={inkStyle}>
          <span className="cws-tab-ink" aria-hidden="true" />
          {!managementMode && !hideTargets && <button className={`cws-tab ${tab === "targets" ? "is-on" : ""}`} onClick={() => setTab("targets")}>Targets</button>}
          {!managementMode && <button className={`cws-tab ${tab === "request" ? "is-on" : ""}`} onClick={() => setTab("request")}>My time off</button>}
          {!managementMode && canSetup && <button className={`cws-tab ${tab === "timeoff" ? "is-on" : ""}`} onClick={() => setTab("timeoff")}>Time off</button>}
          {canCompany && !securityOnly && <button className={`cws-tab ${tab === "hours" ? "is-on" : ""}`} onClick={() => setTab("hours")}>Hours</button>}
          {canCompany && !securityOnly && <button className={`cws-tab ${tab === "billing" ? "is-on" : ""}`} onClick={() => setTab("billing")}>Cutoffs</button>}
          {managementMode && securityPanel && <button className={`cws-tab ${tab === "security" ? "is-on" : ""}`} onClick={() => setTab("security")}>Security</button>}
        </div>
        </div>

        {tab === "security" && securityPanel ? (
          <div key={tab} className="cws-body cws-body-wide cws-sec-body">{securityPanel}</div>
        ) : tab === "request" ? (
          <div key={tab} className="cws-body">
            <TimeOffRequestPanel allowance={vacationAllowance} />
            {requestOnly && canSetup && onOpenSetup && (
              <button type="button" className="cws-setup-link" onClick={onOpenSetup}>
                <span><b>Allowances, approvals, public holidays, working hours and cutoffs</b> are set up in Settings › Calendar.</span>
                <em>Open →</em>
              </button>
            )}
          </div>
        ) : tab === "hours" ? (
          <div key={tab} className="cws-body cws-body-wide"><HoursEditor /></div>
        ) : tab === "targets" ? (
<div key={tab} className="cws-body">
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
          <div key={tab} className="cws-body">
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
                  <DatePicker value={newHolidayDate} onChange={setNewHolidayDate} placeholder="From" />
                </div>
                <span className="cws-range-arrow" aria-hidden="true">→</span>
                <div className="cws-holiday-pick">
                  <DatePicker value={holidayUntil} onChange={setHolidayUntil} placeholder="To (optional)" />
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
                  onClick={() => {
                    // A range adds every day in it, so a fortnight of shutdown is
                    // one action rather than fourteen.
                    const days = spanDays(newHolidayDate, holidayUntil || newHolidayDate);
                    days.forEach((iso) => onAddHoliday(iso, newHolidayName.trim()));
                    setNewHolidayDate(""); setHolidayUntil(""); setNewHolidayName("");
                  }}
                >{holidayUntil && holidayUntil !== newHolidayDate
                    ? `Add ${spanDays(newHolidayDate, holidayUntil).length} days`
                    : "Add"}</button>
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
          <div key={tab} className="cws-body cx">
            <CutoffsBody cutoffs={cutoffs} setCutoffs={setCutoffs} defaultCutoffDay={defaultCutoffDay} setDefaultCutoffDay={setDefaultCutoffDay} allowReset={managementMode} />
          </div>
        ) : tab === "capacity" ? (
          <div key={tab} className="cws-body">
            <p className="cws-hint" style={{ margin: "0 0 1rem" }}>
              Per consultant: weekly capacity, monthly billing targets and the variable bonus.
              Two tiers — reach the minimum to earn bonus %1; billing above the higher target earns %2.
              Bonus is paid on invoiced revenue (moved billing counts where it was invoiced).
            </p>
            {genBonus && setGenBonus && (
              <div className="cws-gen">
                <div className="cws-gen-head">
                  <span className="cws-gen-eyebrow">Everyone</span>
                  <p className="cws-gen-note">
                    What each consultant is on unless their own card below says otherwise.
                  </p>
                </div>

                {setHoursPerDay && (
                  <label className="cws-gen-f cws-gen-hpd">
                    <span>Hours in a billed day</span>
                    <input type="number" min="1" max="24" step="0.5"
                      value={hoursPerDay}
                      onChange={(e) => setHoursPerDay(Number(e.target.value) || 8)} />
                    <em>
                      Work sold by the hour is compared against days at this rate,
                      so the two never end up added together.
                    </em>
                  </label>
                )}
                <div className="cws-gen-grid">
                  {([
                    ["minDays", "Min days / month", "12"],
                    ["minBilling", "Min billing / month", "12000"],
                    ["bonusPct1", "Bonus %1", "5"],
                    ["highDays", "High days / month", "18"],
                    ["highBilling", "High billing / month", "20000"],
                    ["bonusPct2", "Bonus %2", "8"],
                  ] as [keyof CapValue, string, string][]).map(([field, label, ph]) => (
                    <label className="cws-gen-f" key={field}>
                      <span>{label}</span>
                      <input type="number" min="0" placeholder={ph}
                        value={genBonus[field] ?? ""}
                        onChange={(e) => setGenBonus((g) => ({
                          ...g, [field]: e.target.value === "" ? null : Number(e.target.value),
                        }))} />
                    </label>
                  ))}
                </div>
              </div>
            )}

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
                          {v.minDays != null ? `${v.minDays}d/mo min` : "no target"}
                          {v.bonusPct1 != null ? ` · ${v.bonusPct1}%` : ""}
                          {v.bonusPct2 != null ? ` / ${v.bonusPct2}%` : ""}
                        </span>
                        <span className={`cws-capc-chev ${isOpen ? "is-open" : ""}`}>›</span>
                      </button>
                      {isOpen && (
                        <div className="cws-capc-body">
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
        ) : null}
      </div>
    </div>
  );
}

/**
 * Billing cutoffs: the default day and each month's own date, a year at a time.
 * Used by the Management settings and, on its own (CutoffsEditor), by Settings › Calendar.
 */
export function CutoffsBody({ cutoffs, setCutoffs, defaultCutoffDay, setDefaultCutoffDay, allowReset = true }: {
  cutoffs: Cutoffs; setCutoffs: React.Dispatch<React.SetStateAction<Cutoffs>>;
  defaultCutoffDay: number; setDefaultCutoffDay: React.Dispatch<React.SetStateAction<number>>;
  allowReset?: boolean;
}) {
  const [cutoffYear, setCutoffYear] = useState(new Date().getFullYear());

  /** The twelve months of the selected year. */
  const cutoffMonths = Array.from({ length: 12 }, (_, m) => periodOf(new Date(cutoffYear, m, 1)));
  const monthLabel = (p: string) => {
    const [y, m] = p.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleString("en", { month: "long", year: "numeric" });
  };
  const setCutoff = (period: string, iso: string) =>
    setCutoffs((c) => ({ ...c, [period]: iso }));
  /** Back to the default day (removes the month's own date). */
  const resetCutoff = (period: string) =>
    setCutoffs((c) => { const n = { ...c }; delete n[period]; return n; });
  const isoShift = (iso: string, days: number) => {
    const [y, m, d] = iso.split("-").map(Number);
    const t = new Date(y, m - 1, d + days);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  };
  const isoDays = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 864e5);
  const dayMonth = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const weekday = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long" });
  const thisPeriod = periodOf(new Date());
  return (
    <>
            <p className="cws-hint cws-intro">
              Each billing month closes on its cutoff day. It covers everything from the day after the
              previous month’s cutoff up to and including its own.
            </p>

            {/* default cutoff + a ruler of the month showing where it falls */}
            <section className="cx-default">
              <div className="cx-default-txt">
                <span className="cx-eyebrow">Default cutoff</span>
                <b>{defaultCutoffDay === 0 ? "Last day of every month" : `Day ${defaultCutoffDay} of every month`}</b>
                <em>Used for every month that doesn’t have its own date.</em>
              </div>
              <div className="cx-stepper">
                <button type="button" onClick={() => setDefaultCutoffDay((d) => Math.max(0, d - 1))} aria-label="Earlier">−</button>
                <span className="cx-stepper-val" key={defaultCutoffDay}>
                  <b>{defaultCutoffDay === 0 ? "Last" : defaultCutoffDay}</b>
                  <i>{defaultCutoffDay === 0 ? "day" : "of month"}</i>
                </span>
                <button type="button" onClick={() => setDefaultCutoffDay((d) => Math.min(28, d + 1))} aria-label="Later">+</button>
              </div>
              <div className="cx-ruler" aria-hidden="true">
                {Array.from({ length: 31 }, (_, i) => {
                  const day = i + 1;
                  const cut = defaultCutoffDay === 0 ? 31 : defaultCutoffDay;
                  return <i key={day} className={day === cut ? "is-cut" : day < cut ? "is-in" : "is-next"} title={day === cut ? "Closes" : undefined} />;
                })}
                <span className="cx-ruler-l"><em>1</em><em>{defaultCutoffDay === 0 ? "last day" : `closes on day ${defaultCutoffDay}`}</em><em>31</em></span>
              </div>
            </section>

            <div className="cx-yearbar">
              <div className="cx-year">
                <button type="button" onClick={() => setCutoffYear((y) => y - 1)} aria-label="Previous year">‹</button>
                <span key={cutoffYear}>{cutoffYear}</span>
                <button type="button" onClick={() => setCutoffYear((y) => y + 1)} aria-label="Next year">›</button>
              </div>
              {cutoffYear !== new Date().getFullYear() && (
                <button type="button" className="cx-today" onClick={() => setCutoffYear(new Date().getFullYear())}>This year</button>
              )}
              <span className="cx-legend"><i className="is-default" />Default <i className="is-custom" />Own date</span>
            </div>

            <div className="cws-cut-grid cx-grid" key={`y${cutoffYear}`}>
              {cutoffMonths.map((period, i) => {
                const cut = cutoffOf(period, cutoffs, defaultCutoffDay);
                const start = isoShift(billingWindow(period, cutoffs, defaultCutoffDay).from, 1);
                const days = isoDays(start, cut) + 1;
                const isCustom = !!cutoffs[period];
                const now = period === thisPeriod;
                const past = period < thisPeriod;
                const [, mm] = period.split("-").map(Number);
                return (
                  <div className={`cx-month ${isCustom ? "is-custom" : ""} ${now ? "is-now" : ""} ${past ? "is-past" : ""}`} key={period} style={{ ["--i" as string]: i } as CSSProperties}>
                    <div className="cx-m-top">
                      <span className="cx-m-name">{new Date(cutoffYear, mm - 1, 1).toLocaleDateString("en-GB", { month: "long" })}</span>
                      {now && <span className="cx-now">This month</span>}
                      <span className={`cx-tag ${isCustom ? "is-custom" : ""}`}>{isCustom ? "Own date" : "Default"}</span>
                    </div>
                    <div className="cx-m-cut">
                      <b>{Number(cut.slice(8, 10))}</b>
                      <span><em>{dayMonth(cut).split(" ")[1]}</em>closes · {weekday(cut)}</span>
                    </div>
                    <div className="cx-m-range">
                      <span>{dayMonth(start)} → {dayMonth(cut)}</span>
                      <em>{days} days</em>
                    </div>
                    <div className="cx-m-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (days / 35) * 100)}%` }} /></div>
                    <div className="cx-m-actions">
                      <DatePicker value={cut} onChange={(iso) => setCutoff(period, iso)} />
                      {isCustom && allowReset && (
                        <button type="button" className="cx-reset" onClick={() => resetCutoff(period)} title="Use the default cutoff for this month">Use default</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
    </>
  );
}

/** Settings › Calendar › Cutoffs: loads the cutoffs and saves each change by itself. */
export function CutoffsEditor() {
  const [cutoffs, setCutoffs] = useState<Cutoffs>({});
  const [def, setDef] = useState(0);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saved = useRef<{ cutoffs: Cutoffs; def: number }>({ cutoffs: {}, def: 0 });
  useEffect(() => {
    (async () => {
      const [bp, bs] = await Promise.all([
        supabase.from("billing_periods").select("period, cutoff_date"),
        supabase.from("billing_settings").select("default_cutoff_day").eq("id", "default").maybeSingle(),
      ]);
      const c = Object.fromEntries(((bp.data ?? []) as { period: string; cutoff_date: string }[]).map((r) => [r.period, r.cutoff_date]));
      const d = Number((bs.data as any)?.default_cutoff_day) || 0;
      saved.current = { cutoffs: c, def: d };
      setCutoffs(c); setDef(d); setReady(true);
    })().catch(() => setReady(true));
  }, []);
  // each change is saved a moment later
  useEffect(() => {
    if (!ready) return;
    const t = window.setTimeout(async () => {
      const prev = saved.current;
      const changed = Object.entries(cutoffs).filter(([k, v]) => prev.cutoffs[k] !== v).map(([period, cutoff_date]) => ({ period, cutoff_date }));
      const gone = Object.keys(prev.cutoffs).filter((k) => !(k in cutoffs));
      if (!changed.length && !gone.length && prev.def === def) return;
      setState("saving");
      const res = await Promise.all([
        prev.def !== def ? supabase.from("billing_settings").upsert({ id: "default", default_cutoff_day: def }) : null,
        changed.length ? supabase.from("billing_periods").upsert(changed) : null,
        gone.length ? supabase.from("billing_periods").delete().in("period", gone) : null,
      ]);
      const bad = res.find((r: any) => r?.error);
      if (bad) { setState("error"); return; }
      saved.current = { cutoffs, def };
      setState("saved");
      window.setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 1600);
    }, 600);
    return () => window.clearTimeout(t);
  }, [cutoffs, def, ready]);
  if (!ready) return <div className="cws-embed-skel" />;
  return (
    <div className="cws-embed cx">
      <span className={`cws-embed-state is-${state}`}>{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Not saved — try again" : ""}</span>
      <CutoffsBody cutoffs={cutoffs} setCutoffs={setCutoffs} defaultCutoffDay={def} setDefaultCutoffDay={setDef} />
    </div>
  );
}
