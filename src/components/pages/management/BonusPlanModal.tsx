import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { deptName } from "../../framework/pageAccess";
import { createPortal } from "react-dom";
import SalesMultiFilter from "../sales/sales/SalesMultiFilter";
import {
  METRICS, METRIC_LABEL, EVERY_PRESETS, MONTH_SHORT, everyLabel, periodStart, periodLabel, periodMonths, payMonth, monthLabel,
  shiftMonth, yearSlots, evaluate, activeConditions, tierApplies, matchStrength,
  type Plan, type Tier, type Metric,
} from "./bonusEngine";

const uid = () => Math.random().toString(36).slice(2, 9);
const UNIT: Record<Metric, string> = { billing: "€", days: "days", hours: "h" };
const STEP: Record<Metric, number> = { billing: 1000, days: 1, hours: 10 };
const fmt = (n: number) => Math.round(n).toLocaleString("es-ES");
const nowYm = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const prettify = (k: string) => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const blankPlan = (): Plan => ({
  id: "", name: "", active: true, every: 3, start: `${new Date().getFullYear()}-01`, end: null, delay: 1,
  who: { everyone: true, roles: [], departments: [], people: [] },
  tiers: [{ id: uid(), name: "Tier 1", conditions: { billing: 30000, days: null, hours: null }, reward: { type: "pct", value: 3 } }],
});

/* a month picker made of two compact selects */
function MonthPick({ value, onChange, min }: { value: string; onChange: (ym: string) => void; min?: string }) {
  const [y, m] = value.split("-").map(Number);
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 7 }, (_, i) => thisYear - 2 + i);
  const set = (yy: number, mm: number) => { const v = `${yy}-${String(mm).padStart(2, "0")}`; onChange(min && v < min ? min : v); };
  return (
    <div className="bxw-month">
      <SalesMultiFilter single values={[String(m)]} onChange={(v) => v[0] && set(y, Number(v[0]))} placeholder="Month" searchFrom={99}
        options={MONTH_SHORT.map((n, i) => ({ value: String(i + 1), label: n }))} />
      <SalesMultiFilter single values={[String(y)]} onChange={(v) => v[0] && set(Number(v[0]), m)} placeholder="Year" searchFrom={99}
        options={years.map((yy) => ({ value: String(yy), label: String(yy) }))} />
    </div>
  );
}

type StepKey = "who" | "when" | "tiers" | "review";
const STEPS: { key: StepKey; label: string; hint: string }[] = [
  { key: "who", label: "Who", hint: "Name and people" },
  { key: "when", label: "When", hint: "Months, periods, payment" },
  { key: "tiers", label: "Tiers", hint: "Conditions and rewards" },
  { key: "review", label: "Review", hint: "Check and save" },
];

export default function BonusPlanModal({ plan: initial, people, roles, departments, onSave, onDelete, onClose }: {
  plan: Plan;
  people: { id: string; name: string; role: string | null; department: string | null }[];
  roles: string[];
  departments: string[];
  onSave: (p: Plan) => Promise<string | null>;
  onDelete?: () => Promise<string | null>;
  onClose: () => void;
}) {
  const isNew = !initial.id;
  const [p, setP] = useState<Plan>(() => JSON.parse(JSON.stringify(initial)));
  const [step, setStep] = useState<StepKey>("who");
  const [visited, setVisited] = useState<Set<StepKey>>(() => new Set(isNew ? ["who"] : ["who", "when", "tiers", "review"]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tryIt, setTryIt] = useState({ billing: 40000, days: 45, hours: 340 });
  const [customOpen, setCustomOpen] = useState(() => !EVERY_PRESETS.includes(initial.every as 1));
  const set = (patch: Partial<Plan>) => setP((x) => ({ ...x, ...patch }));
  const setWho = (patch: Partial<Plan["who"]>) => setP((x) => ({ ...x, who: { ...x.who, ...patch } }));
  const setTier = (id: string, patch: Partial<Tier>) => setP((x) => ({ ...x, tiers: x.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  const setCond = (id: string, m: Metric, v: number | null) => setP((x) => ({ ...x, tiers: x.tiers.map((t) => (t.id === id ? { ...t, conditions: { ...t.conditions, [m]: v } } : t)) }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".smf-menu")) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* ---- validation per step ---- */
  const covered = useMemo(() => people.filter((x) => matchStrength({ ...p, active: true }, x) > 0), [people, p]);
  const stepProblem: Record<StepKey, string | null> = {
    who: !p.name.trim() ? "Give the plan a name."
      : !p.who.everyone && !p.who.roles.length && !p.who.departments.length && !p.who.people.length ? "Choose who the plan applies to." : null,
    when: p.end && p.end < p.start ? "The end month is before the start month." : null,
    tiers: !p.tiers.length ? "Add at least one tier."
      : p.tiers.some((t) => activeConditions(t).length === 0) ? "Every tier needs at least one condition."
      : p.tiers.some((t) => !(t.reward.value > 0)) ? "Every tier needs a reward above 0."
      : p.tiers.some((t) => t.months && t.months.length === 0) ? "Every tier has to apply to at least one period." : null,
    review: null,
  };
  const firstProblem = (["who", "when", "tiers"] as StepKey[]).map((k) => stepProblem[k]).find(Boolean) ?? null;
  const idx = STEPS.findIndex((s) => s.key === step);
  const go = (k: StepKey) => { setErr(null); setStep(k); setVisited((v) => new Set([...v, k])); };
  const next = () => {
    if (stepProblem[step]) { setErr(stepProblem[step]); return; }
    go(STEPS[Math.min(STEPS.length - 1, idx + 1)].key);
  };

  /* ---- timeline: the next periods from the start (or from now, if the plan started long ago) ---- */
  const from = (() => { const n = nowYm(); const s = periodStart(p, n > p.start ? n : p.start); return s ?? p.start; })();
  const timeline = useMemo(() => {
    const out: { first: string; label: string; months: string[]; pay: string }[] = [];
    let f: string | null = periodStart(p, from) ?? p.start;
    for (let i = 0; f && i < 8; i++) {
      const months = periodMonths(p, f);
      if (!months.length) break;
      out.push({ first: f, label: periodLabel(p, f), months, pay: payMonth(p, f) });
      const nx: string = shiftMonth(f, p.every);
      f = p.end && nx > p.end ? null : nx;
      if (out.reduce((s, x) => s + x.months.length, 0) >= 14) break;
    }
    return out;
  }, [p, from]);

  /* ---- try it ---- */
  const [tryPeriod, setTryPeriod] = useState<string>(() => timeline[0]?.first ?? p.start);
  useEffect(() => { if (!timeline.some((t) => t.first === tryPeriod)) setTryPeriod(timeline[0]?.first ?? p.start); }, [timeline, tryPeriod, p.start]);
  const result = useMemo(() => evaluate(p, tryIt, tryPeriod), [p, tryIt, tryPeriod]);
  const slots = yearSlots(p);

  const save = async () => {
    if (firstProblem) { setErr(firstProblem); return; }
    setBusy(true); setErr(null);
    const e = await onSave({ ...p, name: p.name.trim(), tiers: p.tiers.map((t) => ({ ...t, months: t.months && t.months.length && t.months.length < 12 ? [...t.months].sort((a, b) => a - b) : undefined })) });
    setBusy(false);
    if (e) setErr(e);
  };
  const remove = async () => {
    if (!onDelete || !window.confirm(`Delete “${p.name}”? Bonuses already marked as paid under it are deleted too.`)) return;
    setBusy(true);
    const e = await onDelete();
    setBusy(false);
    if (e) setErr(e);
  };

  /* ---- tier periods ---- */
  const tierMonths = (t: Tier) => (t.months && t.months.length ? t.months : null);
  const toggleSlot = (t: Tier, months: number[]) => {
    const current = tierMonths(t);
    // From "All periods", picking one means "only this one"; after that, clicks add/remove.
    if (!current) { setTier(t.id, { months: [...months] }); return; }
    const cur = new Set(current);
    const on = months.every((m) => cur.has(m));
    months.forEach((m) => (on ? cur.delete(m) : cur.add(m)));
    setTier(t.id, { months: cur.size === 0 || cur.size === 12 ? undefined : [...cur] });
  };
  const tierPeriodText = (t: Tier) => {
    const ms = tierMonths(t);
    if (!ms) return "every period";
    if (slots) { const on = slots.filter((s) => s.months.every((m) => ms.includes(m))); return on.length ? on.map((s) => s.label).join(", ") : "no period"; }
    return `periods starting in ${ms.sort((a, b) => a - b).map((m) => MONTH_SHORT[m - 1]).join(", ")}`;
  };

  return createPortal(
    <div className="bxm-backdrop" onMouseDown={onClose}>
      <div className="bxm bxw" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Bonus plan builder">
        <header className="bxm-head">
          <div className="bxm-head-main">
            <span className="bxm-eyebrow">{isNew ? "New bonus plan" : "Edit bonus plan"}</span>
            <span className="bxw-title">{p.name.trim() || "Untitled plan"}</span>
          </div>
          <button type="button" role="switch" aria-checked={p.active} className={`bxm-active ${p.active ? "is-on" : ""}`} onClick={() => set({ active: !p.active })}>
            <span className="bxm-sw"><span /></span>{p.active ? "Active" : "Paused"}
          </button>
          <button className="bxm-x" onClick={onClose} aria-label="Close">×</button>
        </header>

        {/* stepper */}
        <nav className="bxw-steps" aria-label="Steps">
          {STEPS.map((s, i) => {
            const done = i < idx || (visited.has(s.key) && !stepProblem[s.key] && i !== idx && s.key !== "review");
            return (
              <button key={s.key} className={`bxw-step ${i === idx ? "is-on" : ""} ${done ? "is-done" : ""}`} disabled={!visited.has(s.key)} onClick={() => go(s.key)} aria-current={i === idx ? "step" : undefined}>
                <span className="bxw-step-bar"><i /></span>
                <span className="bxw-step-row">
                  <b>{done ? <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg> : i + 1}</b>
                  <span>{s.label}<em>{s.hint}</em></span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="bxm-body">
          <div className="bxw-pane" key={step}>
            {/* ===== 1. WHO ===== */}
            {step === "who" && (
              <>
                <label className="bxw-field">
                  <span>Plan name</span>
                  <input className="bxw-input is-lg" autoFocus value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Consultancy bonus 2026" />
                </label>
                <div className="bxw-field">
                  <span>Who it applies to</span>
                  <div className="bxw-cards">
                    <button className={`bxw-card ${p.who.everyone ? "is-on" : ""}`} onClick={() => setWho({ everyone: true })}>
                      <b>Everyone</b><em>Anyone not covered by a more specific plan</em>
                    </button>
                    <button className={`bxw-card ${!p.who.everyone ? "is-on" : ""}`} onClick={() => setWho({ everyone: false })}>
                      <b>Only some people</b><em>Pick roles, departments or names</em>
                    </button>
                  </div>
                </div>
                {!p.who.everyone && (
                  <div className="bxm-who">
                    <label>Roles<SalesMultiFilter values={p.who.roles} onChange={(v) => setWho({ roles: v })} placeholder="Any role" noun="roles" options={roles.map((r) => ({ value: r, label: prettify(r) }))} /></label>
                    <label>Departments<SalesMultiFilter values={p.who.departments} onChange={(v) => setWho({ departments: v })} placeholder="Any department" noun="departments" options={departments.map((d) => ({ value: d, label: deptName(d) }))} /></label>
                    <label>People<SalesMultiFilter values={p.who.people} onChange={(v) => setWho({ people: v })} placeholder="Nobody named" noun="people" options={people.map((x) => ({ value: x.id, label: x.name }))} /></label>
                  </div>
                )}
                <div className="bxw-cover">
                  <b>{covered.length}</b>
                  <span>{covered.length === 1 ? "person" : "people"} covered{covered.length ? `: ${covered.slice(0, 6).map((x) => x.name).join(", ")}${covered.length > 6 ? ` +${covered.length - 6}` : ""}` : ""}</span>
                </div>
                <p className="bxm-hint">If someone fits several plans, the most specific one applies: a plan naming them, then their department, then their role, then “Everyone”.</p>
              </>
            )}

            {/* ===== 2. WHEN ===== */}
            {step === "when" && (
              <>
                <div className="bxw-row2">
                  <div className="bxw-field"><span>Starts</span><MonthPick value={p.start} onChange={(v) => set({ start: v, end: p.end && p.end < v ? v : p.end })} /></div>
                  <div className="bxw-field">
                    <span>Ends</span>
                    <div className="bxw-endrow">
                      <button className={`bxw-chip ${!p.end ? "is-on" : ""}`} onClick={() => set({ end: null })}>No end</button>
                      <button className={`bxw-chip ${p.end ? "is-on" : ""}`} onClick={() => set({ end: p.end ?? shiftMonth(p.start, 11) })}>On a month</button>
                      {p.end && <MonthPick value={p.end} min={p.start} onChange={(v) => set({ end: v })} />}
                    </div>
                  </div>
                </div>
                <div className="bxw-field">
                  <span>Each bonus period lasts</span>
                  <div className="bxw-chips">
                    {EVERY_PRESETS.map((n) => <button key={n} className={`bxw-chip ${p.every === n && !customOpen ? "is-on" : ""}`} onClick={() => { setCustomOpen(false); set({ every: n }); }}>{n === 1 ? "1 month" : n === 12 ? "12 months" : `${n} months`}</button>)}
                    <button className={`bxw-chip ${customOpen ? "is-on" : ""}`} onClick={() => { setCustomOpen(true); if (EVERY_PRESETS.includes(p.every as 1)) set({ every: 2 }); }}>Custom</button>
                    {customOpen && (
                      <div className="bxm-stepper">
                        <button onClick={() => set({ every: Math.max(1, p.every - 1) })} aria-label="Shorter">−</button>
                        <b key={p.every}>{p.every}</b>
                        <button onClick={() => set({ every: Math.min(24, p.every + 1) })} aria-label="Longer">+</button>
                        <span className="bxw-unit">months</span>
                      </div>
                    )}
                  </div>
                  <em className="bxw-sub">{everyLabel(p.every)}, counted from {monthLabel(p.start, true)}.</em>
                </div>
                <div className="bxw-field">
                  <span>Paid</span>
                  <div className="bxm-delay">
                    <div className="bxm-stepper">
                      <button onClick={() => set({ delay: Math.max(0, p.delay - 1) })} aria-label="Sooner">−</button>
                      <b key={p.delay}>{p.delay}</b>
                      <button onClick={() => set({ delay: Math.min(12, p.delay + 1) })} aria-label="Later">+</button>
                    </div>
                    <span>{p.delay === 1 ? "month" : "months"} after each period closes</span>
                  </div>
                </div>
                <div className="bxw-timeline" aria-label="Upcoming periods">
                  {timeline.map((t, i) => (
                    <div className="bxw-tl" key={t.first} style={{ flexGrow: t.months.length, ["--i" as string]: i } as CSSProperties}>
                      <span className="bxw-tl-bar" />
                      <b>{t.label}</b>
                      <em>paid {monthLabel(t.pay)}</em>
                    </div>
                  ))}
                  {!timeline.length && <p className="bxm-hint">No periods in this range.</p>}
                </div>
              </>
            )}

            {/* ===== 3. TIERS ===== */}
            {step === "tiers" && (
              <>
                <p className="bxm-hint">Switch on what a tier needs — every condition you switch on must be met in the period. Choose the periods it counts in. The best tier reached is paid on the whole period.</p>
                <div className="bxm-tiers">
                  {p.tiers.map((t, ti) => (
                    <div className="bxm-tier" key={t.id} style={{ ["--i" as string]: ti } as CSSProperties}>
                      <div className="bxm-tier-head">
                        <span className="bxm-tier-n">{ti + 1}</span>
                        <input value={t.name} onChange={(e) => setTier(t.id, { name: e.target.value })} aria-label="Tier name" />
                        {p.tiers.length > 1 && <button className="bxm-del" onClick={() => set({ tiers: p.tiers.filter((x) => x.id !== t.id) })} aria-label="Remove tier">×</button>}
                      </div>
                      <div className="bxw-tier-label">Needs</div>
                      <div className="bxm-conds">
                        {METRICS.map((m) => {
                          const on = t.conditions[m] != null;
                          return (
                            <div className={`bxm-cond ${on ? "is-on" : ""}`} key={m}>
                              <button type="button" role="switch" aria-checked={on} className="bxm-cond-sw" onClick={() => setCond(t.id, m, on ? null : m === "billing" ? 30000 : m === "days" ? 40 : 300)}>
                                <span className="bxm-sw"><span /></span>{METRIC_LABEL[m]}
                              </button>
                              {on && (
                                <label className="bxm-num"><em>at least</em>
                                  <input type="number" min={0} step={STEP[m]} value={t.conditions[m] ?? 0} onChange={(e) => setCond(t.id, m, e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)))} />
                                  <i>{UNIT[m]}</i>
                                </label>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="bxw-tier-label">Pays</div>
                      <div className="bxm-reward">
                        <div className="bxm-seg is-sm">
                          <button className={t.reward.type === "pct" ? "is-on" : ""} onClick={() => setTier(t.id, { reward: { ...t.reward, type: "pct" } })}>% of billing</button>
                          <button className={t.reward.type === "fixed" ? "is-on" : ""} onClick={() => setTier(t.id, { reward: { ...t.reward, type: "fixed" } })}>Fixed amount</button>
                        </div>
                        <label className="bxm-num is-reward">
                          <input type="number" min={0} step={t.reward.type === "pct" ? 0.5 : 100} value={t.reward.value} onChange={(e) => setTier(t.id, { reward: { ...t.reward, value: Math.max(0, Number(e.target.value) || 0) } })} />
                          <i>{t.reward.type === "pct" ? "%" : "€"}</i>
                        </label>
                      </div>
                      <div className="bxw-tier-label">Counts in <em>{tierPeriodText(t)}</em></div>
                      <div className="bxw-slots">
                        <button className={`bxw-chip is-sm ${!tierMonths(t) ? "is-on" : ""}`} onClick={() => setTier(t.id, { months: undefined })}>All periods</button>
                        {(slots ?? MONTH_SHORT.map((n, i) => ({ label: n, months: [i + 1] }))).map((s) => {
                          const ms = tierMonths(t);
                          const on = !!ms && s.months.every((m) => ms.includes(m));
                          return <button key={s.label} className={`bxw-chip is-sm ${on ? "is-on" : ""}`} onClick={() => toggleSlot(t, s.months)}>{s.label}</button>;
                        })}
                      </div>
                      {!slots && <em className="bxw-sub">With {p.every}-month periods the periods don’t repeat on the same months each year — pick the months a period may start in.</em>}
                    </div>
                  ))}
                </div>
                <button className="bxm-add" onClick={() => { const last = p.tiers[p.tiers.length - 1]; set({ tiers: [...p.tiers, { id: uid(), name: `Tier ${p.tiers.length + 1}`, conditions: { billing: (Number(last?.conditions.billing) || 20000) + 20000, days: null, hours: null }, reward: { type: "pct", value: (last?.reward.value || 2) + 1 }, months: last?.months ? [...last.months] : undefined }] }); }}>+ Add tier</button>
              </>
            )}

            {/* ===== 4. REVIEW ===== */}
            {step === "review" && (
              <div className="bxw-review">
                <div className="bxw-summary">
                  <div className="bxw-sum-head">
                    <h3>{p.name.trim() || "Untitled plan"}</h3>
                    <span className={`bxw-pill ${p.active ? "is-on" : ""}`}>{p.active ? "Active" : "Paused"}</span>
                    <span className="bxw-pill">{covered.length} {covered.length === 1 ? "person" : "people"}</span>
                  </div>

                  <div className="bxw-facts">
                    <button className="bxw-fact" onClick={() => go("who")} title="Edit who">
                      <span className="bxw-fact-k">Who</span>
                      {p.who.everyone ? <b>Everyone</b> : (
                        <span className="bxw-tags">
                          {people.filter((x) => p.who.people.includes(x.id)).map((x) => <i key={x.id} className="is-person">{x.name}</i>)}
                          {p.who.departments.map((d) => <i key={d} className="is-dept">{deptName(d)} dept.</i>)}
                          {p.who.roles.map((r) => <i key={r} className="is-role">{prettify(r)} role</i>)}
                        </span>
                      )}
                      <em>{covered.length ? covered.slice(0, 4).map((x) => x.name.split(" ")[0]).join(", ") + (covered.length > 4 ? ` +${covered.length - 4}` : "") : "Nobody matches yet"}</em>
                    </button>
                    <button className="bxw-fact" onClick={() => go("when")} title="Edit when">
                      <span className="bxw-fact-k">Runs</span>
                      <b>{monthLabel(p.start)} → {p.end ? monthLabel(p.end) : "no end"}</b>
                      <em>{p.every === 1 ? "monthly" : p.every === 12 ? "yearly" : `${p.every}-month`} periods</em>
                    </button>
                    <button className="bxw-fact" onClick={() => go("when")} title="Edit payment">
                      <span className="bxw-fact-k">Paid</span>
                      <b>{p.delay === 0 ? "In the last month" : `${p.delay} ${p.delay === 1 ? "month" : "months"} after`}</b>
                      <em>each period closes</em>
                    </button>
                  </div>

                  <div className="bxw-tt">
                    <div className="bxw-tt-row is-head">
                      <span>Tier</span><span>Billing ≥</span><span>Days ≥</span><span>Hours ≥</span><span>Pays</span><span>Counts in</span>
                    </div>
                    {[...p.tiers].sort((a, b) =>
                        (Number(a.conditions.billing ?? 0) - Number(b.conditions.billing ?? 0)) ||
                        (Number(a.conditions.days ?? 0) - Number(b.conditions.days ?? 0)) ||
                        (Number(a.conditions.hours ?? 0) - Number(b.conditions.hours ?? 0))).map((t, i) => (
                      <div className={`bxw-tt-row ${result.tier?.id === t.id ? "is-hit" : ""}`} key={t.id} style={{ ["--i" as string]: i } as CSSProperties}>
                        <span className="bxw-tt-name"><i>{i + 1}</i>{t.name}</span>
                        {METRICS.map((m) => (
                          <span key={m} className={t.conditions[m] == null ? "is-off" : ""}>
                            {t.conditions[m] == null ? "—" : m === "billing" ? `${fmt(Number(t.conditions[m]))} €` : `${fmt(Number(t.conditions[m]))}${m === "hours" ? " h" : ""}`}
                          </span>
                        ))}
                        <span className="bxw-tt-pay">{t.reward.type === "pct" ? `${t.reward.value}%` : `${fmt(t.reward.value)} €`}<small>{t.reward.type === "pct" ? "of billing" : "fixed"}</small></span>
                        <span className="bxw-tt-when">{tierPeriodText(t) === "every period" ? <em>All</em> : tierPeriodText(t)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="bxw-periods">
                    <span className="bxw-fact-k">Next periods</span>
                    <div className="bxw-periods-row">
                      {timeline.slice(0, 6).map((t, i) => (
                        <div className={`bxw-period ${t.first === tryPeriod ? "is-on" : ""}`} key={t.first} style={{ ["--i" as string]: i } as CSSProperties}>
                          <b>{t.label}</b>
                          <em><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>{monthLabel(t.pay)}</em>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <aside className="bxm-try">
                  <span className="bxm-eyebrow">Try it</span>
                  <h4>What would someone earn?</h4>
                  <label className="bxw-try-period"><em>Period</em>
                    <SalesMultiFilter single values={[tryPeriod]} onChange={(v) => v[0] && setTryPeriod(v[0])} placeholder="Period" searchFrom={99}
                      options={timeline.map((t) => ({ value: t.first, label: t.label }))} />
                  </label>
                  {METRICS.map((m) => (
                    <label className="bxm-num is-try" key={m}><em>{METRIC_LABEL[m]}</em>
                      <input type="number" min={0} step={STEP[m]} value={tryIt[m]} onChange={(e) => setTryIt((x) => ({ ...x, [m]: Math.max(0, Number(e.target.value) || 0) }))} />
                      <i>{UNIT[m]}</i>
                    </label>
                  ))}
                  <div className={`bxm-result ${result.tier ? "is-hit" : ""}`} key={`${result.tier?.id}-${Math.round(result.amount)}-${tryPeriod}`}>
                    <span>{result.tier ? result.tier.name : "No tier reached"}</span>
                    <b>{fmt(result.amount)} €</b>
                    <em>for {periodLabel(p, tryPeriod)}, paid in {monthLabel(payMonth(p, tryPeriod), true)}</em>
                  </div>
                  {result.next && (
                    <p className="bxm-next">Next: <b>{result.next.tier.name}</b> ({fmt(result.next.amount)} €) — {Object.entries(result.next.gaps).map(([m, g]) => (m === "billing" ? `${fmt(g as number)} € more billing` : `${fmt(g as number)} ${UNIT[m as Metric]} more`)).join(", ")}</p>
                  )}
                  {p.tiers.some((t) => !tierApplies(t, tryPeriod)) && <p className="bxm-next">Not counting in this period: {p.tiers.filter((t) => !tierApplies(t, tryPeriod)).map((t) => t.name).join(", ")}</p>}
                </aside>
              </div>
            )}
          </div>
        </div>

        <footer className="bxm-foot">
          {onDelete && step === "review" ? <button className="bxm-btn is-danger" onClick={remove} disabled={busy}>Delete plan</button> : <span />}
          <span className={`bxm-err ${err ? "is-on" : ""}`}>{err ?? ""}</span>
          <div className="bxm-foot-actions">
            {idx > 0 ? <button className="bxm-btn is-ghost" onClick={() => go(STEPS[idx - 1].key)} disabled={busy}>Back</button>
              : <button className="bxm-btn is-ghost" onClick={onClose} disabled={busy}>Cancel</button>}
            {step !== "review"
              ? <button className="bxm-btn is-primary" onClick={next}>Next: {STEPS[idx + 1].label} →</button>
              : <button className="bxm-btn is-primary" onClick={save} disabled={busy || !!firstProblem}>{busy ? "Saving…" : isNew ? "Create plan" : "Save plan"}</button>}
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}