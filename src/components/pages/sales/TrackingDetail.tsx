/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../framework/DatePicker";
import TimePicker from "../../framework/TimePicker";
import Select from "../../framework/Select";
import MentionInput, { type MentionPerson } from "../../framework/MentionInput";
import "../../framework/MentionInput.css";

// Convert serialized mentions "@[Name](id)" into plain "@Name".
const MEETING_KINDS: { value: MeetingKind; label: string; icon: JSX.Element }[] = [
  { value: "teams", label: "Teams", icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l7-4v12l-7-4"/></svg>) },
  { value: "phone", label: "Call", icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>) },
  { value: "in_person", label: "In person", icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/></svg>) },
];

const cleanMentionsFn = (t: string) => t.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1");
import { supabase } from "../../api/supabase";
import TrackingFiles from "./TrackingFiles";
import { loadPipeline, listPipelines, type Phase, type Pipeline } from "../settings/pipelineApi";
import { myProfile, isSalesLead } from "../companies/companiesApi";
import { loadServices, calcBreakdown, discountOf, BASE_KEY, type Service, type Calculator, type CalcDiscount } from "../settings/catalogApi";
import type { Company, Contact } from "../companies/companiesApi";
import type { Product } from "../settings/catalogApi";
import type { Employee } from "./SalesPage";
import {
  setTrackingPhase, setTrackingStatus, deleteTracking,
  loadNotes, addNote, updateNote, deleteNote,
  loadTasks, addTask, toggleTask, updateTask, deleteTask,
  loadMeetings, addMeeting, updateMeeting, deleteMeeting,
  loadPhaseEvents, stampPhaseEntry, clearPhaseEventsAfter,
  loadPotentialServices, addPotentialService, updatePotentialServiceTerm, deletePotentialService,
  loadTrackingEmployees, setTrackingEmployees,
  loadTrackingProducts, addTrackingProduct, updateTrackingProduct, removeTrackingProduct,
  lineTotal, lineBreakdown, unitBreakdown,
  createHandoffs, loadTrackingHandoffs, type Handoff,
  loadAssignees, addAssignee, removeAssignee,
  trackingPct,
  type Tracking, type TrackNote, type TrackTask, type TrackMeeting, type MeetingKind, type PhaseEvent, type PotentialService, type Assignee,
  type TrackingProduct, type TermPatch, type RevenueLineFields,
} from "./salesApi";


/**
 * Discount for one row of a line. Defined at module level: nesting it inside
 * the modal made React remount the input on every keystroke, which is why the
 * field lost focus after a single character.
 */
function DiscountControl({ dkey, amount, discounts, setDisc, money }: {
  dkey: string; amount: number;
  discounts: Record<string, CalcDiscount>;
  setDisc: (key: string, patch: Partial<CalcDiscount>) => void;
  money: (n: number) => string;
}) {
  const d = discounts[dkey] ?? { mode: "none" as const, value: 0 };
  const off = discountOf(amount, d);
  return (
    <div className="sl-calc-disc">
      <div className="sl-calc-switch sl-calc-switch-xs">
        <button className={d.mode === "none" ? "is-on" : ""} onClick={() => setDisc(dkey, { mode: "none" })}>-</button>
        <button className={d.mode === "percent" ? "is-on" : ""} onClick={() => setDisc(dkey, { mode: "percent" })}>%</button>
        <button className={d.mode === "amount" ? "is-on" : ""} onClick={() => setDisc(dkey, { mode: "amount" })}>{"\u20ac"}</button>
      </div>
      {d.mode !== "none" && (
        <>
          <input type="number" min="0" value={d.value} onFocus={(e) => e.target.select()}
            onChange={(e) => setDisc(dkey, { value: parseFloat(e.target.value) || 0 })} />
          <span className="sl-calc-off">-{money(off)}</span>
        </>
      )}
    </div>
  );
}

/** Per-row rate override, used by service duration calculators. */
function RateControl({ rkey, rates, baseRate, setRate, unit }: {
  rkey: string; rates: Record<string, number>; baseRate: number;
  setRate: (key: string, v: number) => void; unit: string;
}) {
  const v = rates[rkey] == null ? baseRate : rates[rkey];
  return (
    <label className="sl-calc-rate">
      <input type="number" min="0" value={v} onFocus={(e) => e.target.select()}
        onChange={(e) => setRate(rkey, parseFloat(e.target.value) || 0)} />
      <span>/{unit}</span>
    </label>
  );
}

/**
 * Per-line calculator popup: tier, calculator inputs, term or quantity, and a
 * discount. Everything that decides the value of one revenue line lives here.
 */
function LineCalcModal({ title, line, tiers, roles, roleName, calculator, unit, onApply, onClose, money }: {
  title: string;
  line: RevenueLineFields;
  tiers?: { id?: string; name: string; price: number }[];
  roles?: { role_id: string; price: number }[];
  roleName?: (id: string) => string;
  calculator?: Calculator | null;
  unit?: "hour" | "day" | null;
  onApply: (patch: TermPatch) => void;
  onClose: () => void;
  money: (n: number) => string;
}) {
  const [tierId, setTierId] = useState<string>(line.tier_id ?? "");
  const [roleId, setRoleId] = useState<string>(line.role_id ?? "");
  const [values, setValues] = useState<Record<string, number>>(line.calc_values ?? {});
  const [manualPrice, setManualPrice] = useState<number>(Number(line.price) || 0);
  const [qty, setQty] = useState<number>(line.quantity == null ? 1 : Number(line.quantity));
  const [years, setYears] = useState<number>(line.term_years == null ? 1 : Number(line.term_years));
  const [discounts, setDiscounts] = useState<Record<string, CalcDiscount>>(() => {
    const d = { ...(line.calc_discounts ?? {}) };
    // Fold a pre-existing whole-line discount into the base row.
    if (!d[BASE_KEY] && line.discount_mode && line.discount_mode !== "none") {
      d[BASE_KEY] = { mode: line.discount_mode as "percent" | "amount", value: Number(line.discount_value) || 0 };
    }
    return d;
  });
  const setDisc = (key: string, patch: Partial<CalcDiscount>) =>
    setDiscounts((x) => ({ ...x, [key]: { mode: "none", value: 0, ...(x[key] ?? {}), ...patch } }));
  const [rates, setRates] = useState<Record<string, number>>(line.calc_rates ?? {});
  const setRate = (key: string, v: number) => setRates((x) => ({ ...x, [key]: v }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const unitWord = unit === "hour" ? "hours" : "days";
  const isQtyCalc = calculator?.output_kind === "quantity";

  // Base unit price: the chosen tier, the chosen role, or whatever was typed.
  const tierPrice = tiers?.find((t) => t.id === tierId)?.price;
  const rolePrice = roles?.find((r) => r.role_id === roleId)?.price;
  const basePrice = tierPrice ?? rolePrice ?? manualPrice;

  // A price calculator overrides the unit price. A quantity calculator sets
  // how many units instead, leaving the price alone.
  const priceCalc = calculator && !isQtyCalc ? calculator : null;
  const qtyCalc = calculator && isQtyCalc ? calculator : null;
  const priceBd = priceCalc ? calcBreakdown(priceCalc, values, basePrice, discounts) : null;
  const qtyBd = qtyCalc ? calcBreakdown(qtyCalc, values, Number(qtyCalc.base_amount) || 0) : null;
  const quantity = qtyBd ? qtyBd.total : qty;

  const draft: RevenueLineFields = {
    price: basePrice, quantity, recurring: line.recurring, period: line.period,
    term_years: years, calc_values: values, calc_discounts: discounts, calc_rates: rates,
  };
  const bd = lineBreakdown(draft, calculator, basePrice);

  const apply = () => {
    onApply({
      // `price` stays the pre-discount base. Discounts live per row so the
      // receipt can show where each one was applied.
      price: basePrice,
      quantity,
      term_years: years,
      tier_id: tierId || null,
      role_id: roleId || null,
      calc_values: values,
      calc_discounts: discounts,
      calc_rates: rates,
      discount_mode: "none",
      discount_value: 0,
    });
    onClose();
  };

  const vars = calculator?.variables ?? [];

  return (
    <div className="sl-calc-backdrop" onMouseDown={onClose}>
      <div className="sl-calc" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sl-calc-head">
          <div>
            <span className="sl-calc-eyebrow">Line calculator</span>
            <h3 className="sl-calc-title">{title}</h3>
          </div>
          <button className="sl-calc-x" onClick={onClose}>×</button>
        </div>

        <div className="sl-calc-body">
          {tiers && tiers.length > 0 && (
            <div className="sl-calc-sec">
              <p className="sl-calc-sec-t">Tier</p>
              <div className="sl-calc-tiers">
                {tiers.map((t) => (
                  <button key={t.id ?? t.name} className={tierId === t.id ? "is-on" : ""} onClick={() => setTierId(t.id ?? "")}>
                    <b>{t.name || "Unnamed"}</b><span>{money(t.price)}</span>
                  </button>
                ))}
                <button className={tierId === "" ? "is-on" : ""} onClick={() => setTierId("")}>
                  <b>Custom</b><span>manual price</span>
                </button>
              </div>
            </div>
          )}

          {roles && roles.length > 0 && (
            <div className="sl-calc-sec">
              <p className="sl-calc-sec-t">Rate</p>
              <div className="sl-calc-tiers">
                {roles.map((r, i) => (
                  <button key={r.role_id} className={roleId === r.role_id ? "is-on" : ""} onClick={() => setRoleId(r.role_id)}>
                    <b>{roleName ? roleName(r.role_id) : `Rate ${i + 1}`}</b><span>{money(r.price)}/{unit ?? "day"}</span>
                  </button>
                ))}
                <button className={roleId === "" ? "is-on" : ""} onClick={() => setRoleId("")}>
                  <b>Custom</b><span>manual rate</span>
                </button>
              </div>
            </div>
          )}

          <div className="sl-calc-sec">
            <p className="sl-calc-sec-t">{unit ? `Rate per ${unit}` : "Base price"}</p>
            <div className="sl-calc-inline">
              <input type="number" min="0" value={tierPrice ?? rolePrice ?? manualPrice}
                disabled={tierPrice != null || rolePrice != null} onFocus={(e) => e.target.select()}
                onChange={(e) => setManualPrice(parseFloat(e.target.value) || 0)} />
              {qtyCalc
                ? <DiscountControl dkey={BASE_KEY} amount={bd.rows.find((r) => r.key === BASE_KEY)?.amount ?? 0} discounts={discounts} setDisc={setDisc} money={money} />
                : <DiscountControl dkey={BASE_KEY} amount={basePrice} discounts={discounts} setDisc={setDisc} money={money} />}
            </div>
          </div>

          {vars.length > 0 && (
            <div className="sl-calc-sec">
              <p className="sl-calc-sec-t">{isQtyCalc ? `Estimate the ${unitWord}` : "Calculator"}</p>
              <div className="sl-calc-vars">
                {vars.map((v) => {
                  const k = v.id ?? String(v.sort);
                  const val = values[k] ?? (Number(v.default_value) || 0);
                  const rowAmount = bd.rows.find((r) => r.key === k)?.amount ?? 0;
                  const showRate = !!qtyCalc;
                  const showDisc = !!priceCalc || !!qtyCalc;
                  if (v.var_type === "percent") {
                    return (
                      <div key={k} className="sl-calc-var sl-calc-var-fixed">
                        <span>{v.name}</span>
                        <em>{v.amount}% of base</em>
                        {showRate && <RateControl rkey={k} rates={rates} baseRate={basePrice} setRate={setRate} unit={unit ?? "day"} />}
                        {showDisc && <DiscountControl dkey={k} amount={rowAmount} discounts={discounts} setDisc={setDisc} money={money} />}
                      </div>
                    );
                  }
                  if (v.var_type === "fixed") {
                    return (
                      <div key={k} className="sl-calc-var">
                        <span>{v.name}</span>
                        <div className="sl-calc-switch">
                          <button className={val ? "is-on" : ""} onClick={() => setValues((x) => ({ ...x, [k]: 1 }))}>Yes</button>
                          <button className={!val ? "is-on" : ""} onClick={() => setValues((x) => ({ ...x, [k]: 0 }))}>No</button>
                        </div>
                        {qtyBd && <span className="sl-calc-out">{qtyBd.rows.find((r) => r.key === k)?.amount ?? 0} {unitWord}</span>}
                        {showRate && <RateControl rkey={k} rates={rates} baseRate={basePrice} setRate={setRate} unit={unit ?? "day"} />}
                        {showDisc && <DiscountControl dkey={k} amount={rowAmount} discounts={discounts} setDisc={setDisc} money={money} />}
                      </div>
                    );
                  }
                  return (
                    <div key={k} className="sl-calc-var">
                      <span>{v.name}{v.unit_label ? ` (${v.unit_label})` : ""}</span>
                      <input type="number" min="0" value={val} onFocus={(e) => e.target.select()}
                        onChange={(e) => setValues((x) => ({ ...x, [k]: parseFloat(e.target.value) || 0 }))} />
                      {qtyBd && <span className="sl-calc-out">{qtyBd.rows.find((r) => r.key === k)?.amount ?? 0} {unitWord}</span>}
                      {showRate && <RateControl rkey={k} rates={rates} baseRate={basePrice} setRate={setRate} unit={unit ?? "day"} />}
                      {showDisc && <DiscountControl dkey={k} amount={rowAmount} discounts={discounts} setDisc={setDisc} money={money} />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="sl-calc-sec">
            <p className="sl-calc-sec-t">{line.recurring ? "Contract term" : unit ? `How many ${unitWord}` : "Quantity"}</p>
            <div className="sl-calc-inline">
              {line.recurring ? (
                <>
                  <input type="number" min="0" step="0.5" value={years} onFocus={(e) => e.target.select()}
                    onChange={(e) => setYears(parseFloat(e.target.value) || 0)} />
                  <em>{years === 1 ? "year" : "years"}</em>
                </>
              ) : (
                <>
                  <input type="number" min="0" step="0.5" value={quantity} disabled={!!qtyBd}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setQty(parseFloat(e.target.value) || 0)} />
                  <em>{unit ? unitWord : "units"}</em>
                  {qtyBd && <span className="sl-calc-note">set by the calculator above</span>}
                </>
              )}
            </div>
          </div>

          <div className="sl-calc-receipt">
            {bd.rows.map((r) => (
              <div key={r.key} className="sl-rc-row">
                <span>{r.label}{r.detail ? ` (${r.detail})` : ""}</span>
                <em>{money(r.amount)}{r.discount > 0 ? <i className="sl-rc-off"> -{money(r.discount)}</i> : null}</em>
              </div>
            ))}
            {!qtyBd && <div className="sl-rc-row sl-rc-sub"><span>Unit price</span><em>{money(bd.unitPrice)}</em></div>}
            {bd.multiplierLabel && <div className="sl-rc-row"><span>{bd.multiplierLabel}</span><em>{money(bd.total)}</em></div>}
            <div className="sl-rc-row sl-rc-total"><span>Line total</span><em>{money(bd.total)}</em></div>
          </div>
        </div>

        <div className="sl-calc-foot">
          <button className="sl-calc-cancel" onClick={onClose}>Cancel</button>
          <button className="sl-calc-apply" onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  );
}

/**
 * One revenue line: the numbers, a receipt you can expand, and a calculator
 * button that opens everything that decides those numbers.
 */
function RevLine({ name, tag, tagClass, line, unit, minUnit, calculator, catalogBase, onRemove, onOpenCalc, money }: {
  name: string;
  tag: string;
  tagClass?: string;
  line: RevenueLineFields;
  unit?: "hour" | "day" | null;
  minUnit?: number | null;
  calculator?: Calculator | null;
  catalogBase?: number;
  onRemove: () => void;
  onOpenCalc: () => void;
  money: (n: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const bd = lineBreakdown(line, calculator, catalogBase, minUnit);
  const unitWord = unit === "hour" ? "hours" : "days";
  const qty = line.quantity == null ? 1 : Number(line.quantity);
  const years = line.term_years == null ? 1 : Number(line.term_years);

  const isQtyCalc = calculator?.output_kind === "quantity";
  const summary = line.recurring
    ? `${money(bd.unitPrice)} ${line.period === "monthly" ? "per month" : "per year"} ${bd.multiplierLabel}`
    // With a duration calculator each row already carries its own days and
    // rate, so there is no single rate to quote for the line.
    : isQtyCalc
      ? `${qty} ${unitWord} across ${bd.rows.length} ${bd.rows.length === 1 ? "line" : "lines"}`
      : unit
        ? `${money(bd.unitPrice)} per ${unit} x ${qty} ${unitWord}`
        : qty === 1 ? `${money(bd.unitPrice)} one-time` : `${money(bd.unitPrice)} x ${qty}`;

  return (
    <div className="sl-rev-item sl-rev-lined">
      <div className="sl-rev-top">
        <div className="sl-rev-body">
          <span className="sl-rev-name">{name}</span>
          <span className={`sl-rev-tag ${tagClass ?? ""}`}>{tag}</span>
        </div>
        <b className="sl-rev-amount">{money(bd.total)}</b>
      </div>

      <div className="sl-rev-term">
        <span className="sl-rev-period">{summary}</span>
        {bd.qty !== bd.rawQty && (
          <span className="sl-rev-round" title={`Calculated ${bd.rawQty}, billed in steps of ${minUnit}`}>
            {bd.rawQty} → <b>{bd.qty}</b>
          </span>
        )}
        {bd.discount > 0 && <span className="sl-rev-disc">-{money(bd.discount)}</span>}
        <div className="sl-rev-actions">
          <button className="sl-rev-icon" onClick={onOpenCalc} title="Open calculator" aria-label="Open calculator">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="2" width="16" height="20" rx="2" /><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h4" />
            </svg>
          </button>
          <button className={`sl-rev-icon ${open ? "is-on" : ""}`} onClick={() => setOpen((o) => !o)}
            title="Show breakdown" aria-expanded={open} aria-label="Show breakdown">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={open ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
            </svg>
          </button>
          <button className="sl-rev-icon sl-rev-icon-del" onClick={onRemove} title="Remove" aria-label="Remove line">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      {open && (
        <div className="sl-rev-receipt">
          {bd.rows.map((r) => (
            <div key={r.key} className="sl-rc-row">
              <span>{r.label}{r.detail ? ` (${r.detail})` : ""}</span>
              <em>{money(r.amount)}{r.discount > 0 ? <i className="sl-rc-off"> -{money(r.discount)}</i> : null}</em>
            </div>
          ))}
          {!isQtyCalc && (
            <div className="sl-rc-row sl-rc-sub">
              <span>{unit && !line.recurring ? `Rate per ${unit}` : "Unit price"}</span><em>{money(bd.unitPrice)}</em>
            </div>
          )}
          {line.recurring ? (
            <>
              {line.period === "monthly" && (
                <div className="sl-rc-row"><span>x 12 months</span><em>{money(bd.unitPrice * 12)}</em></div>
              )}
              <div className="sl-rc-row"><span>x {years} {years === 1 ? "year" : "years"}</span><em>{money(bd.total)}</em></div>
            </>
          ) : bd.multiplierLabel ? (
            <>
              {bd.qty !== bd.rawQty && (
                <div className="sl-rc-row sl-rc-round">
                  <span>Calculated {bd.rawQty} {unit ? unitWord : "units"}, billed in steps of {minUnit}</span>
                  <em>{bd.qty}</em>
                </div>
              )}
              <div className="sl-rc-row"><span>x {bd.qty} {unit ? unitWord : "units"}</span><em>{money(bd.total)}</em></div>
            </>
          ) : null}
          <div className="sl-rc-row sl-rc-total"><span>Total</span><em>{money(bd.total)}</em></div>
        </div>
      )}
    </div>
  );
}

export default function TrackingDetail({ tracking, companies, contacts, products, employees, onBack }: {
  tracking: Tracking; companies: Company[]; contacts: Contact[]; products: Product[]; employees: Employee[]; onBack: () => void;
}) {
  const [phases, setPhases] = useState<Phase[]>([]);
  const [allPhases, setAllPhases] = useState<Phase[]>([]);
  const [curPhase, setCurPhase] = useState<string | null>(tracking.current_phase_id);
  const [status, setStatus] = useState(tracking.status);
  const [notes, setNotes] = useState<TrackNote[]>([]);
  const [tasks, setTasks] = useState<TrackTask[]>([]);
  const [meetings, setMeetings] = useState<TrackMeeting[]>([]);
  const [events, setEvents] = useState<PhaseEvent[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [potentials, setPotentials] = useState<PotentialService[]>([]);
  const [tprods, setTProds] = useState<TrackingProduct[]>([]);
  const [calcFor, setCalcFor] = useState<{ kind: "product" | "service"; id: string } | null>(null);
  const [revErr, setRevErr] = useState<string | null>(null);
  const [allPipelines, setAllPipelines] = useState<Pipeline[]>([]);
  const [team, setTeam] = useState<string[]>([]);
  const [me, setMe] = useState<{ id: string; role: string; is_superadmin: boolean } | null>(null);
  const [handoffMenu, setHandoffMenu] = useState(false);
  const [handoffPicked, setHandoffPicked] = useState<Set<string>>(new Set());
  const [handoffSent, setHandoffSent] = useState(false);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [assignees, setAssignees] = useState<Record<string, Assignee[]>>({});
  const [companyContactIds, setCompanyContactIds] = useState<string[]>([]);

  const reloadAssignees = async () => {
    const ids = [...notes, ...tasks, ...meetings].map((x: any) => x.id);
    setAssignees(await loadAssignees(tracking.id, ids).catch(() => ({})));
  };

  useEffect(() => {
    if (tracking.pipeline_id) loadPipeline(tracking.pipeline_id).then(({ phases }) => { setAllPhases(phases); setPhases(phases.filter((p) => p.sales_visible !== false)); }).catch(() => {});
    Promise.all([loadNotes(tracking.id), loadTasks(tracking.id), loadMeetings(tracking.id)]).then(([n, t, m]) => {
      setNotes(n); setTasks(t); setMeetings(m);
      const ids = [...n, ...t, ...m].map((x: any) => x.id);
      loadAssignees(tracking.id, ids).then(setAssignees).catch(() => {});
    }).catch(() => {});
    loadPhaseEvents(tracking.id).then(setEvents).catch(() => {});
    loadServices().then(setServices).catch(() => {});
    listPipelines().then(setAllPipelines).catch(() => {});
    loadPotentialServices(tracking.id).then(setPotentials).catch(() => {});
    loadTrackingProducts(tracking.id).then(setTProds).catch(() => {});
    loadTrackingEmployees(tracking.id).then(setTeam).catch(() => {});
    loadTrackingHandoffs(tracking.id).then(setHandoffs).catch(() => {});
    // contacts already linked to this tracking's company
    if (tracking.company_id) {
      supabase.from("company_contacts").select("contact_id").eq("company_id", tracking.company_id)
        .then(({ data }: any) => setCompanyContactIds((data ?? []).map((r: any) => r.contact_id)));
    }
  }, [tracking.id, tracking.pipeline_id, tracking.company_id]);

  useEffect(() => {
    if (curPhase && events.length === 0) {
      stampPhaseEntry(tracking.id, curPhase).then((e) => { if (e) setEvents((xs) => [...xs, e]); }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curPhase, events.length]);

  const company = companies.find((c) => c.id === tracking.company_id);
  const product = products.find((p) => p.id === tracking.product_id);
  const contactName = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "Contact";
  };
  const empName = (id: string) => employees.find((e) => e.id === id)?.name ?? "Employee";

  useEffect(() => { myProfile().then(setMe).catch(() => {}); }, []);
  const canAssign = isSalesLead(me);
  const toggleMember = async (id: string) => {
    const next = team.includes(id) ? team.filter((x) => x !== id) : [...team, id];
    setTeam(next);
    await setTrackingEmployees(tracking.id, next).catch(() => {});
  };
  const title = company?.name || (tracking.contactIds[0] ? contactName(tracking.contactIds[0]) : "Untitled");

  // win/loss phases in this pipeline
  const winPhase = phases.find((p) => p.sales_outcome === "win");
  const lossPhase = phases.find((p) => p.sales_outcome === "loss");

  /**
   * Handoff destinations = pipelines referenced by any phase's handover_to.
   *
   * A destination is "recommended" when the handoff phase that points at it
   * lists a product or service this deal actually sold, so the obvious next
   * step is visible without reading every pipeline name.
   */
  const handoffTargets = useMemo(() => {
    const byPipeline = new Map<string, { id: string; name: string; items: { type: string; id: string }[] }>();
    allPhases.filter((ph) => ph.handover_to).forEach((ph) => {
      const id = ph.handover_to as string;
      const entry = byPipeline.get(id) ?? { id, name: allPipelines.find((pl) => pl.id === id)?.name ?? "Pipeline", items: [] };
      entry.items.push(...(ph.items ?? []));
      byPipeline.set(id, entry);
    });
    return Array.from(byPipeline.values()).map((e) => {
      const matched: string[] = [];
      e.items.forEach((it) => {
        if (it.type === "product" && tprods.some((tp) => tp.product_id === it.id)) {
          matched.push(products.find((p) => p.id === it.id)?.name ?? "Product");
        }
        if (it.type === "service" && potentials.some((ps) => ps.service_id === it.id)) {
          matched.push(services.find((s) => s.id === it.id)?.name ?? "Service");
        }
      });
      return { id: e.id, name: e.name, items: e.items, matched: Array.from(new Set(matched)) };
    }).sort((a, b) => b.matched.length - a.matched.length || a.name.localeCompare(b.name));
  }, [allPhases, allPipelines, tprods, potentials, products, services]);
  const canHandoff = status === "won" && handoffTargets.length > 0;

  const curIdx = phases.findIndex((p) => p.id === curPhase);
  // Shared with the overview list (salesApi.trackingPct) so both always agree.
  const pct = trackingPct(phases, curPhase);
  const phaseEnteredAt = (phaseId: string) => events.find((e) => e.phase_id === phaseId)?.entered_at ?? null;

  // Move to a phase, syncing status from the phase's outcome.
  const applyPhase = async (id: string) => {
    const newIdx = phases.findIndex((p) => p.id === id);
    setCurPhase(id);
    await setTrackingPhase(tracking.id, id);
    // Keep entry dates only up to and including the new current phase; clear later ones.
    const keepIds = phases.slice(0, newIdx + 1).map((p) => p.id);
    const e = await stampPhaseEntry(tracking.id, id);
    await clearPhaseEventsAfter(tracking.id, keepIds);
    setEvents((xs) => {
      let next = xs.filter((ev) => ev.phase_id && keepIds.includes(ev.phase_id));
      if (e && !next.find((x) => x.phase_id === id)) next = [...next, e];
      return next;
    });
    const ph = phases.find((p) => p.id === id);
    const next = ph?.sales_outcome === "win" ? "won" : ph?.sales_outcome === "loss" ? "lost" : "active";
    setStatus(next); await setTrackingStatus(tracking.id, next);
  };

  // Clicking a status button: sync the phase too.
  const applyStatus = async (s: string) => {
    if (s === "won") {
      if (!winPhase) return;
      await applyPhase(winPhase.id);
    } else if (s === "lost") {
      if (!lossPhase) return;
      await applyPhase(lossPhase.id);
    } else {
      // active/paused: if currently on a win/loss phase, step back to the last normal phase
      const cur = phases.find((p) => p.id === curPhase);
      if (cur?.sales_outcome) {
        const normals = phases.filter((p) => !p.sales_outcome);
        const back = normals[normals.length - 1];
        if (back) { setCurPhase(back.id); await setTrackingPhase(tracking.id, back.id); }
      }
      setStatus(s); await setTrackingStatus(tracking.id, s);
    }
  };

  const remove = async () => { if (confirm(`Delete tracking for "${title}"?`)) { await deleteTracking(tracking.id); onBack(); } };

  const phaseNotes = useMemo(() => notes.filter((n) => n.phase_id === curPhase), [notes, curPhase]);
  const phaseTasks = useMemo(() => tasks.filter((t) => t.phase_id === curPhase), [tasks, curPhase]);
  const phaseMeetings = useMemo(() => meetings.filter((m) => m.phase_id === curPhase), [meetings, curPhase]);

  // People available to @-mention: employees (internal) + contacts linked to the client's company.
  const mentionPeople = useMemo<MentionPerson[]>(() => {
    const emps: MentionPerson[] = employees
      .filter((e) => e.name && e.name !== "-")
      .map((e) => ({ id: `employee:${e.id}`, name: e.name, kind: "employee" }));
    const linked: MentionPerson[] = contacts
      .filter((c) => companyContactIds.includes(c.id!))
      .map((c) => ({ id: `contact:${c.id}`, name: [c.first_name, c.last_name].filter(Boolean).join(" "), kind: "contact" }));
    return [...emps, ...linked];
  }, [employees, contacts, companyContactIds]);

  const unassign = async (itemId: string, assigneeId: string) => {
    await removeAssignee(assigneeId);
    setAssignees((prev) => ({ ...prev, [itemId]: (prev[itemId] ?? []).filter((a) => a.id !== assigneeId) }));
  };

  // Extract mention ids still present in the serialized text "@[Name](id)".
  const extractMentions = (t: string): { id: string; name: string }[] => {
    const out: { id: string; name: string }[] = [];
    const re = /@\[([^\]]+)\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) out.push({ name: m[1], id: m[2] });
    return out;
  };
  // Convert serialized mentions "@[Name](id)" into plain "@Name" for storage.
  const cleanMentions = (t: string) => cleanMentionsFn(t);

  // Persist the mentions found in the final text against a freshly-created item.
  const persistFromText = async (itemType: string, itemId: string, rawText: string) => {
    const mentions = extractMentions(rawText);
    const seen = new Set<string>();
    const created: any[] = [];
    // Someone already tagged on this item must not be added twice when the
    // text is edited and mentions are typed again.
    const already = new Set(
      (assignees[itemId] ?? []).map((a) => `${a.kind}:${a.kind === "employee" ? a.employee_id : a.contact_id}`),
    );
    for (const mn of mentions) {
      if (seen.has(mn.id)) continue; seen.add(mn.id);
      if (already.has(mn.id)) continue;
      const [kind, refId] = mn.id.split(":") as ["employee" | "contact", string];
      if (!refId) continue;
      const a = await addAssignee(itemType, itemId, kind, refId);
      if (a) created.push(a);
    }
    if (created.length) setAssignees((prev) => ({ ...prev, [itemId]: [...(prev[itemId] ?? []), ...created] }));
  };

  // ---- add handlers ----
  const [newNote, setNewNote] = useState("");
  const submitNote = async () => {
    if (!cleanMentions(newNote).trim()) return;
    const n = await addNote(tracking.id, curPhase, cleanMentions(newNote).trim());
    if (n) { setNotes((xs) => [...xs, n]); await persistFromText("note", n.id, newNote); }
    setNewNote("");
  };
  const removeNote = async (id: string) => { await deleteNote(id); setNotes((xs) => xs.filter((n) => n.id !== id)); };
  const editNote = async (id: string, raw: string) => {
    const body = cleanMentions(raw);
    await updateNote(id, body);
    setNotes((xs) => xs.map((n) => n.id === id ? { ...n, body } : n));
    await persistFromText("note", id, raw);
  };

  const [newTask, setNewTask] = useState("");
  const submitTask = async () => {
    if (!cleanMentions(newTask).trim()) return;
    const t = await addTask(tracking.id, curPhase, cleanMentions(newTask).trim());
    if (t) { setTasks((xs) => [...xs, t]); await persistFromText("task", t.id, newTask); }
    setNewTask("");
  };
  const flipTask = async (t: TrackTask) => { const done = !t.done; setTasks((xs) => xs.map((x) => x.id === t.id ? { ...x, done } : x)); await toggleTask(t.id, done); };
  const removeTask = async (id: string) => { await deleteTask(id); setTasks((xs) => xs.filter((t) => t.id !== id)); };
  const editTask = async (id: string, raw: string) => {
    const title = cleanMentions(raw);
    await updateTask(id, title);
    setTasks((xs) => xs.map((t) => t.id === id ? { ...t, title } : t));
    await persistFromText("task", id, raw);
  };

  const [meetTitle, setMeetTitle] = useState("");
  const [meetDate, setMeetDate] = useState("");
  const [meetTime, setMeetTime] = useState("10:00");
  const [meetKind, setMeetKind] = useState<MeetingKind>("in_person");
  const submitMeeting = async () => {
    if (!cleanMentions(meetTitle).trim() || !meetDate) return;
    const iso = `${meetDate}T${meetTime || "00:00"}:00`;
    const m = await addMeeting(tracking.id, curPhase, cleanMentions(meetTitle).trim(), iso, meetKind);
    if (m) { setMeetings((xs) => [...xs, m]); await persistFromText("meeting", m.id, meetTitle); }
    setMeetTitle(""); setMeetDate(""); setMeetTime("10:00");
  };
  const removeMeeting = async (id: string) => { await deleteMeeting(id); setMeetings((xs) => xs.filter((m) => m.id !== id)); };
  const editMeeting = async (id: string, raw: string) => {
    const title = cleanMentions(raw);
    await updateMeeting(id, { title });
    setMeetings((xs) => xs.map((m) => m.id === id ? { ...m, title } : m));
    await persistFromText("meeting", id, raw);
  };
  const setMeetingKind = async (id: string, kind: MeetingKind) => {
    setMeetings((xs) => xs.map((m) => m.id === id ? { ...m, kind } : m));
    await updateMeeting(id, { kind });
  };

  // ---- revenue ----
  const serviceName = (id: string | null) => services.find((s) => s.id === id)?.name ?? "Service";
  const serviceUnit = (id: string | null) => services.find((s) => s.id === id)?.rate_unit ?? "day";
  const serviceMin = (id: string | null) => {
    const s = services.find((x) => x.id === id);
    return s?.min_unit ?? (s?.rate_unit === "hour" ? 0.5 : 0.25);
  };
  const productName = (id: string | null) => products.find((p) => p.id === id)?.name ?? "Product";
  const availableProducts = products.filter((p) => !tprods.some((tp) => tp.product_id === p.id));

  const addProduct = async (productId: string) => {
    const prod = products.find((p) => p.id === productId);
    const price = prod?.tiers?.[0]?.price ?? 0;
    // Inherit the recurrence straight from the catalogue so the line is right
    // the moment it appears.
    const row = await addTrackingProduct(tracking.id, productId, price, {
      recurring: prod?.billing === "recurring",
      period: (prod?.billing_period as "monthly" | "yearly") ?? "yearly",
      term_years: 1,
    });
    if (row) setTProds((xs) => [...xs, row]);
  };
  const patchProduct = async (id: string, patch: TermPatch) => {
    setTProds((xs) => xs.map((p) => p.id === id ? { ...p, ...patch } : p));
    const err = await updateTrackingProduct(id, tracking.id, patch);
    setRevErr(err);
    // The optimistic edit above is a lie if the write failed, so put the row back.
    if (err) loadTrackingProducts(tracking.id).then(setTProds).catch(() => {});
  };
  const removeProduct = async (id: string) => {
    await removeTrackingProduct(id, tracking.id);
    setTProds((xs) => xs.filter((p) => p.id !== id));
  };

  const addPotential = async (serviceId: string) => {
    const svc = services.find((s) => s.id === serviceId);
    const price = svc?.roles?.reduce((sum: number, r: any) => sum + (r.price || 0), 0) ?? 0;
    const p = await addPotentialService(tracking.id, serviceId, svc?.name ?? null, price);
    if (p) setPotentials((xs) => [...xs, p]);
  };
  const patchPotential = async (id: string, patch: TermPatch) => {
    setPotentials((xs) => xs.map((p) => p.id === id ? { ...p, ...patch } : p));
    const err = await updatePotentialServiceTerm(id, patch);
    setRevErr(err);
    if (err) loadPotentialServices(tracking.id).then(setPotentials).catch(() => {});
  };
  const removePotential = async (id: string) => { await deletePotentialService(id); setPotentials((xs) => xs.filter((p) => p.id !== id)); };
  const productOf = (id: string | null) => products.find((p) => p.id === id);
  const serviceOf = (id: string | null) => services.find((s) => s.id === id);
  const productsTotal = tprods.reduce((s, p) => {
    const prod = productOf(p.product_id);
    const base = prod?.tiers?.find((x) => x.id === p.tier_id)?.price;
    return s + lineTotal(p, prod?.calculator as Calculator | null, base);
  }, 0);
  const totalPotential = productsTotal + potentials.reduce(
    (s, p) => s + lineTotal(p, serviceOf(p.service_id)?.calculator as Calculator | null, undefined, serviceMin(p.service_id)), 0);
  const money = (n: number) =>
    `\u20ac${(Number(n) || 0).toLocaleString("es-ES", { maximumFractionDigits: 0 })}`;

  /**
   * Latest state per destination pipeline. A dismissed handoff is not the same
   * as never having sent one - management looked at it and rejected it - so it
   * is surfaced as a warning rather than silently allowing a resend.
   */
  const handoffState = useMemo(() => {
    const m: Record<string, string> = {};
    handoffs.forEach((h) => {
      if (!h.dest_pipeline_id) return;
      // The database nulls these when the client or project is deleted, so a
      // converted handoff with nothing left behind it is stale, not done.
      const gone = h.status === "converted" && !h.created_project_id && !h.created_client_id;
      m[h.dest_pipeline_id] = gone ? "removed" : h.status;
    });
    return m;
  }, [handoffs]);
  const dismissedTargets = handoffTargets.filter((tg) => handoffState[tg.id] === "dismissed");
  const removedTargets = handoffTargets.filter((tg) => handoffState[tg.id] === "removed");
  const liveHandoffs = handoffs.filter(
    (h) => h.status === "pending" || (h.status === "converted" && (h.created_project_id || h.created_client_id)),
  );

  // Opening the menu pre-ticks whatever this deal actually sold.
  useEffect(() => {
    if (!handoffMenu) return;
    // Never pre-tick something that is already sitting in management.
    setHandoffPicked(new Set(
      handoffTargets
        .filter((t) => t.matched.length && handoffState[t.id] !== "pending" && handoffState[t.id] !== "converted")
        .map((t) => t.id),
    ));
  }, [handoffMenu]);

  const doHandoff = async () => {
    const picked = handoffTargets.filter((t) => handoffPicked.has(t.id));
    if (!picked.length) return;

    /**
     * Each destination only receives what belongs to it: the products and
     * services listed on the handoff phase that points at that pipeline.
     * Sending the whole deal to every destination made every card in
     * management look identical.
     */
    const destinations = picked.map((tg) => {
      const ids = new Set((tg.items ?? []).map((it: any) => it.id));
      const lines: any[] = [];

      tprods.filter((tp) => tp.product_id && ids.has(tp.product_id)).forEach((tp) => {
        const prod = productOf(tp.product_id);
        const base = prod?.tiers?.find((x) => x.id === tp.tier_id)?.price;
        const bd = lineBreakdown(tp, prod?.calculator as Calculator | null, base);
        lines.push({
          label: productName(tp.product_id), kind: "product",
          price: Math.round(bd.total),
          gross: Math.round(bd.gross), discount: Math.round(bd.discount),
          rows: bd.rows.map((r) => ({ label: r.label, detail: r.detail, amount: r.amount, discount: r.discount })),
        });
      });

      potentials.filter((p) => p.service_id && ids.has(p.service_id)).forEach((p) => {
        const svcCalc = serviceOf(p.service_id)?.calculator as Calculator | null;
        const minU = serviceMin(p.service_id);
        const bd = lineBreakdown(p, svcCalc, undefined, minU);
        // Days behind each row, so management can see how the total was built.
        const timeRows = svcCalc && svcCalc.output_kind === "quantity"
          ? calcBreakdown(svcCalc, p.calc_values ?? {}, Number(svcCalc.base_amount) || 0).rows
          : [];
        // Management receives the billable quantity, never the raw one, so the
        // project it creates lines up with what was sold.
        const days = bd.qty;
        lines.push({
          label: p.label || serviceName(p.service_id), kind: "service",
          price: Math.round(bd.total), days,
          gross: Math.round(bd.gross), discount: Math.round(bd.discount),
          rate: days > 0 ? Math.round(bd.total / days) : Math.round(bd.total),
          rows: bd.rows.map((r) => {
            const tr = timeRows.find((x) => x.key === r.key);
            const d = tr ? tr.amount : undefined;
            return {
              label: r.label, detail: r.detail, amount: r.amount, discount: r.discount,
              days: d, rate: d && d > 0 ? Math.round(r.amount / d) : undefined,
            };
          }),
        });
      });

      return {
        id: tg.id, name: tg.name, services: lines,
        // Management delivers the service, not the licence, so the value they
        // see is the service work only. Products travel as context.
        potential_value: lines.filter((l) => l.kind !== "product")
          .reduce((s, l) => s + (l.price || 0), 0),
      };
    });

    await createHandoffs({
      tracking_id: tracking.id,
      company_id: tracking.company_id,
      company_name: company?.name ?? null,
      product_id: tracking.product_id,
      destinations,
    });
    setHandoffSent(true);
    loadTrackingHandoffs(tracking.id).then(setHandoffs).catch(() => {});
  };

  const fmtMeet = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-";
  const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" }) : null;

  // Assignee row (chips + dropdown) reused across items
  // Small "people tagged" indicator: avatars if they fit, else an icon; hover shows who in a portal popup.
  const MiniAssignees = ({ itemId, compact }: { itemId: string; compact?: boolean }) => {
    const list = assignees[itemId] ?? [];
    const [hover, setHover] = useState(false);
    const wrapRef = useRef<HTMLSpanElement>(null);
    const [pop, setPop] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
    if (list.length === 0) return null;
    const rows = list.map((a) => {
      const isEmp = a.kind === "employee";
      return { key: a.id, isEmp, name: isEmp ? empName(a.employee_id!) : contactName(a.contact_id!) };
    });
    const open = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setPop({ left: r.right, top: r.top });
      setHover(true);
    };
    const popup = hover && createPortal(
      <span className="sl-tag-pop" style={{ position: "fixed", left: pop.left, top: pop.top, transform: "translate(-100%, calc(-100% - 6px))" }}>
        {rows.map((r) => (
          <span key={r.key} className="sl-tag-pop-row">
            <span className={`sl-mini-av ${r.isEmp ? "sl-asg-int" : "sl-asg-ext"}`}>{r.name.slice(0, 1).toUpperCase()}</span>
            <span className="sl-tag-pop-name">{r.name}</span>
            <span className="sl-tag-pop-kind">{r.isEmp ? "Team" : "Contact"}</span>
          </span>
        ))}
      </span>,
      document.body
    );
    if (compact) {
      return (
        <span className="sl-tagged-wrap" ref={wrapRef} onMouseEnter={open} onMouseLeave={() => setHover(false)}>
          <span className="sl-tagged">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            {list.length}
          </span>
          {popup}
        </span>
      );
    }
    const shown = rows.slice(0, 2);
    const extra = rows.length - shown.length;
    return (
      <span className="sl-tagged-wrap" ref={wrapRef} onMouseEnter={open} onMouseLeave={() => setHover(false)}>
        <span className="sl-mini-asg">
          {shown.map((r) => <span key={r.key} className={`sl-mini-av ${r.isEmp ? "sl-asg-int" : "sl-asg-ext"}`}>{r.name.slice(0, 1).toUpperCase()}</span>)}
          {extra > 0 && <span className="sl-mini-more">+{extra}</span>}
        </span>
        {popup}
      </span>
    );
  };

  const AssigneeArea = ({ itemId }: { itemId: string }) => {
    const list = assignees[itemId] ?? [];
    if (list.length === 0) return null;
    return (
      <div className="sl-assignees">
        {list.map((a) => {
          const isEmp = a.kind === "employee";
          const name = isEmp ? empName(a.employee_id!) : contactName(a.contact_id!);
          return (
            <span key={a.id} className={`sl-asg ${isEmp ? "sl-asg-int" : "sl-asg-ext"}`}>
              <span className="sl-asg-av">{name.slice(0, 1).toUpperCase()}</span>
              {name}
              <button onClick={() => unassign(itemId, a.id)} aria-label="Remove">×</button>
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div className="sl sl-detail">
      <header className="sl-head sl-d-head">
        <button className="sl-back" onClick={onBack} aria-label="Back">‹</button>
        <span className="sl-d-avatar">{title.slice(0, 1).toUpperCase()}</span>
        <div className="sl-d-id">
          <h1 className="sl-title">{title}</h1>
          <div className="sl-d-metaline">
            <span className={`sl-d-badge sl-badge-${status}`}>{status}</span>
            <span className="sl-d-sub">
              {company ? "Company" : "Contact"}
              {tracking.contactIds.length > 0 && ` \u00b7 ${tracking.contactIds.map(contactName).join(", ")}`}
              {product && ` \u00b7 ${product.name}`}
            </span>
          </div>
        </div>
        <div className="sl-d-actions">
          {canHandoff && (
            <div className="sl-handoff-wrap">
              <button className={`sl-handoff-btn ${liveHandoffs.length ? "is-sent" : ""}`} onClick={() => setHandoffMenu((v) => !v)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                Handoff
              </button>
              {handoffMenu && (
                <>
                  <div className="sl-handoff-layer" onMouseDown={() => { setHandoffMenu(false); setHandoffSent(false); }} />
                  <div className="sl-handoff-pop">
                    {handoffSent ? (
                      <div className="sl-handoff-done">
                        <span className="sl-handoff-done-ico">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                        </span>
                        <p className="sl-handoff-done-txt">Handed off</p>
                        <ul className="sl-handoff-done-list">
                          {handoffTargets.filter((tg) => handoffPicked.has(tg.id)).map((tg) => (
                            <li key={tg.id}>{tg.name}</li>
                          ))}
                        </ul>
                        <p className="sl-handoff-done-sub">Waiting in Management, under Incoming.</p>
                        <button className="sl-handoff-done-btn" onClick={() => { setHandoffMenu(false); setHandoffSent(false); }}>Done</button>
                      </div>
                    ) : (
                      <>
                        {removedTargets.length > 0 && (
                          <div className="sl-handoff-warn">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
                            <span>{removedTargets.map((d) => d.name).join(", ")}: the project created in management was deleted. You can send again.</span>
                          </div>
                        )}
                        {dismissedTargets.length > 0 && (
                          <div className="sl-handoff-warn">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
                            <span>{dismissedTargets.map((d) => d.name).join(", ")} {dismissedTargets.length === 1 ? "was" : "were"} dismissed in management. You can send again.</span>
                          </div>
                        )}
                        <div className="sl-handoff-head">Hand off to</div>
                        <div className="sl-handoff-list">
                          {handoffTargets.map((tg) => {
                            const on = handoffPicked.has(tg.id);
                            const rec = tg.matched.length > 0;
                            const st = handoffState[tg.id];
                            const locked = st === "pending" || st === "converted";
                            const why = st === "dismissed" ? "Dismissed in management"
                              : st === "removed" ? "Deleted in management"
                              : rec ? tg.matched.join(" · ") : "";
                            return (
                              <button key={tg.id} disabled={locked}
                                className={`sl-handoff-dest ${on ? "is-picked" : ""} ${rec && !locked ? "is-rec" : ""} ${locked ? "is-locked" : ""} ${st === "dismissed" || st === "removed" ? "is-dismissed" : ""}`}
                                title={locked ? "Already handed off - dismiss it in management to send again" : ""}
                                onClick={() => setHandoffPicked((prev) => {
                                  const n = new Set(prev);
                                  if (n.has(tg.id)) n.delete(tg.id); else n.add(tg.id);
                                  return n;
                                })}>
                                <span className={`sl-handoff-check ${on ? "is-on" : ""} ${locked ? "is-locked" : ""}`}>
                                  {locked ? "✓" : on ? "✓" : ""}
                                </span>
                                <span className="sl-handoff-dest-txt">
                                  <span className="sl-handoff-dest-name">{tg.name}</span>
                                  {why && <span className={`sl-handoff-dest-why ${st === "dismissed" ? "is-warn" : ""}`}>{why}</span>}
                                </span>
                                {st === "converted" ? <span className="sl-handoff-badge is-done">client created</span>
                                  : st === "pending" ? <span className="sl-handoff-badge is-wait">in management</span>
                                  : st === "dismissed" ? <span className="sl-handoff-badge is-warn">dismissed</span>
                                  : st === "removed" ? <span className="sl-handoff-badge is-warn">deleted</span>
                                  : rec ? <span className="sl-handoff-badge">sold</span> : null}
                              </button>
                            );
                          })}
                        </div>
                        <button className="sl-handoff-send" disabled={handoffPicked.size === 0} onClick={doHandoff}>
                          Send{handoffPicked.size > 0 ? ` to ${handoffPicked.size}` : ""}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="sl-seg">
            {["active", "won", "lost", "paused"].map((s) => {
              const disabled = (s === "won" && !winPhase) || (s === "lost" && !lossPhase);
              return (
                <button key={s} className={`sl-seg-btn ${status === s ? "is-on" : ""} sl-seg-${s}`} disabled={disabled}
                  onClick={() => applyStatus(s)} title={disabled ? "Define a win/loss phase in the pipeline first" : ""}>{s}</button>
              );
            })}
          </div>
          <button className="sl-d-del" onClick={remove}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
          </button>
        </div>
      </header>

      <div className="sl-scroll">
        {/* Pipeline flow — hero */}
        <div className={`sl-pipe sl-pipe-${status}`}>
          <div className="sl-pipe-head">
            <span className="sl-pipe-title">Pipeline progress</span>
            <span className="sl-pipe-pct">{pct}<i>%</i></span>
          </div>
          <div className="sl-pipe-bar"><div className="sl-pipe-bar-fill" style={{ width: `${pct}%` }} /></div>
          <div className="sl-flow">
            {phases.length === 0 ? <span className="sl-pipe-empty">This pipeline has no phases.</span> : phases.map((p, i) => {
              const entered = phaseEnteredAt(p.id);
              const state = i < curIdx ? "done" : i === curIdx ? "cur" : "future";
              return (
                <div key={p.id} className="sl-flow-item">
                  {i > 0 && <div className={`sl-flow-bar ${i <= curIdx ? "is-on" : ""}`} />}
                  <button className={`sl-flow-node is-${state} ${p.sales_outcome ? `oc-${p.sales_outcome}` : ""}`} onClick={() => applyPhase(p.id)}>
                    <span className="sl-flow-num">{p.sales_outcome === "win" ? "★" : p.sales_outcome === "loss" ? "✕" : state === "done" ? "✓" : i + 1}</span>
                    <span className="sl-flow-text">
                      <span className="sl-flow-name">{p.name}</span>
                      <span className="sl-flow-date">{entered ? fmtDate(entered) : "—"}</span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Four columns */}
        <div className="sl-work">
          <div className="sl-col-left">
          <section className="sl-panel">
            <h3 className="sl-panel-title">Notes<span>{phaseNotes.length}</span></h3>
            <div className="sl-note-add">
              <MentionInput multiline value={newNote} onChange={setNewNote} people={mentionPeople}
                onMention={() => {}} placeholder="Write a note... use @ to mention" />
              <button className="sl-add-btn" onClick={submitNote} disabled={!cleanMentions(newNote).trim()}>Add note</button>
            </div>
            <div className="sl-notes">
              {phaseNotes.length === 0 ? <p className="sl-hint">No notes yet.</p> : phaseNotes.map((n) => (
                <NoteItem key={n.id} note={n} people={mentionPeople} onEdit={editNote} onDelete={removeNote} tagged={<MiniAssignees itemId={n.id} compact />}>
                  <AssigneeArea itemId={n.id} />
                </NoteItem>
              ))}
            </div>
          </section>

          <section className="sl-panel sl-panel-docs">
            <h3 className="sl-panel-title">Documents</h3>
            <TrackingFiles trackingId={tracking.id} phaseId={curPhase} />
          </section>
          </div>

          <section className="sl-panel">
            <h3 className="sl-panel-title">Tasks<span>{phaseTasks.filter((t) => !t.done).length}</span></h3>
            <div className="sl-task-add">
              <MentionInput multiline value={newTask} onChange={setNewTask} people={mentionPeople}
                onMention={() => {}} onEnter={submitTask} placeholder="Add a task... use @ to mention" />
              <button className="sl-add-btn" onClick={submitTask} disabled={!cleanMentions(newTask).trim()}>Add</button>
            </div>
            <div className="sl-tasks">
              {phaseTasks.length === 0 ? <p className="sl-hint">No tasks yet.</p> : phaseTasks.map((t) => (
                <TaskItem key={t.id} task={t} people={mentionPeople} onToggle={flipTask} onEdit={editTask} onDelete={removeTask} tagged={<MiniAssignees itemId={t.id} compact />} />
              ))}
            </div>
          </section>

          <section className="sl-panel">
            <h3 className="sl-panel-title">Meetings<span>{phaseMeetings.length}</span></h3>
            <div className="sl-meet-add">
              <MentionInput multiline value={meetTitle} onChange={setMeetTitle} people={mentionPeople}
                onMention={() => {}} placeholder="Meeting title... use @ to mention" />
              <div className="sl-meet-when">
                <DatePicker value={meetDate} onChange={setMeetDate} placeholder="Date" />
                <TimePicker value={meetTime} onChange={setMeetTime} />
                <div className="sl-meet-kinds sl-meet-kinds-new">
                  {MEETING_KINDS.map((k) => (
                    <button key={k.value} className={meetKind === k.value ? "is-on" : ""} title={k.label}
                      aria-label={k.label} onClick={() => setMeetKind(k.value)}>{k.icon}</button>
                  ))}
                </div>
              </div>
              <button className="sl-add-btn" onClick={submitMeeting} disabled={!cleanMentions(meetTitle).trim() || !meetDate}>Schedule</button>
            </div>
            <div className="sl-meetings">
              {phaseMeetings.length === 0 ? <p className="sl-hint">No meetings yet.</p> : phaseMeetings.map((m) => (
                <MeetingItem key={m.id} meeting={m} people={mentionPeople} fmtMeet={fmtMeet} onEdit={editMeeting} onKind={setMeetingKind} onDelete={removeMeeting} tagged={<MiniAssignees itemId={m.id} compact />} />
              ))}
            </div>
          </section>

          <section className="sl-panel sl-panel-rev">
            <h3 className="sl-panel-title sl-team-title">Who is on this deal
              <span className="sl-team-count">{team.length}</span>
            </h3>
            <div className="sl-team">
              {team.length === 0 && (
                <p className="sl-hint">
                  {canAssign ? "Nobody assigned. Only boss and sales managers can see it." : "Nobody assigned yet."}
                </p>
              )}
              <div className="sl-team-chips">
                {team.map((id) => (
                  <span key={id} className="sl-team-chip">
                    <i>{empName(id).slice(0, 1).toUpperCase()}</i>
                    {empName(id)}
                    {canAssign && <button onClick={() => toggleMember(id)} aria-label="Remove">×</button>}
                  </span>
                ))}
              </div>
              {canAssign && employees.filter((e) => !team.includes(e.id)).length > 0 && (
                <Select value="" onChange={(v) => v && toggleMember(v)} placeholder="+ Add someone"
                  options={employees.filter((e) => !team.includes(e.id)).map((e) => ({ value: e.id, label: e.name }))} />
              )}
            </div>

            <h3 className="sl-panel-title">Potential revenue<span className="sl-rev-total">{money(totalPotential)}</span></h3>
            {tprods.length === 0 && <p className="sl-hint">No products assigned.</p>}
            {tprods.map((tp) => (
              <RevLine key={tp.id} name={productName(tp.product_id)} tag="Product" line={tp} money={money}
                onRemove={() => removeProduct(tp.id)}
                calculator={productOf(tp.product_id)?.calculator as Calculator | null}
                catalogBase={productOf(tp.product_id)?.tiers?.find((x) => x.id === tp.tier_id)?.price}
                onOpenCalc={() => setCalcFor({ kind: "product", id: tp.id })} />
            ))}
            {availableProducts.length > 0 && (
              <div className="sl-rev-add">
                <Select value="" onChange={(v) => v && addProduct(v)} placeholder="+ Add product" options={availableProducts.map((p) => ({ value: p.id!, label: p.name }))} />
              </div>
            )}
            {potentials.map((p) => (
              <RevLine key={p.id} name={p.label || serviceName(p.service_id)} tag="Service" tagClass="sl-rev-tag-svc"
                line={p} money={money} unit={serviceUnit(p.service_id)} minUnit={serviceMin(p.service_id)}
                onRemove={() => removePotential(p.id)}
                calculator={serviceOf(p.service_id)?.calculator as Calculator | null}
                onOpenCalc={() => setCalcFor({ kind: "service", id: p.id })} />
            ))}
            {services.length > 0 && (
              <div className="sl-rev-add">
                <Select value="" onChange={(v) => v && addPotential(v)} placeholder="+ Add potential service" options={services.map((s) => ({ value: s.id!, label: s.name }))} />
              </div>
            )}
            {revErr && <p className="sl-rev-err">Could not save: {revErr}</p>}
            <div className="sl-rev-foot"><span>Total if won</span><b>{money(totalPotential)}</b></div>
          </section>
        </div>
      </div>

      {calcFor && (() => {
        if (calcFor.kind === "product") {
          const tp = tprods.find((x) => x.id === calcFor.id);
          if (!tp) return null;
          const prod = productOf(tp.product_id);
          return (
            <LineCalcModal
              title={prod?.name ?? "Product"}
              line={tp}
              tiers={prod?.tiers}
              calculator={prod?.calculator as Calculator | null}
              money={money}
              onApply={(patch) => patchProduct(tp.id, patch)}
              onClose={() => setCalcFor(null)}
            />
          );
        }
        const ps = potentials.find((x) => x.id === calcFor.id);
        if (!ps) return null;
        const svc = serviceOf(ps.service_id);
        return (
          <LineCalcModal
            title={ps.label || svc?.name || "Service"}
            line={ps}
            roles={svc?.roles}
            calculator={svc?.calculator as Calculator | null}
            unit={svc?.rate_unit ?? "day"}
            money={money}
            onApply={(patch) => patchPotential(ps.id, patch)}
            onClose={() => setCalcFor(null)}
          />
        );
      })()}
    </div>
  );
}
// ============================ Note item (expand/collapse + inline edit) ============================
function NoteItem({ note, people, onEdit, onDelete, tagged, children }: {
  people: MentionPerson[];
  note: TrackNote;
  onEdit: (id: string, body: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [overflowing, setOverflowing] = useState(false);
  const pRef = useRef<HTMLParagraphElement>(null);

  // Detect whether the collapsed text is clipped (so we only show the toggle when needed).
  useEffect(() => {
    const el = pRef.current;
    if (el && !editing) setOverflowing(el.scrollHeight > el.clientHeight + 2);
  }, [note.body, editing, expanded]);

  const save = async () => {
    const body = draft.trim();
    if (body && body !== note.body) await onEdit(note.id, body);
    setEditing(false);
  };
  const cancel = () => { setDraft(note.body); setEditing(false); };

  if (editing) {
    return (
      <div className="sl-note sl-note-editing">
        <MentionInput multiline value={draft} onChange={setDraft} people={people} placeholder="Edit note. Type @ to tag someone" />
        <div className="sl-note-edit-actions">
          <button className="sl-note-cancel" onClick={cancel}>Cancel</button>
          <button className="sl-note-save" onClick={save} disabled={!draft.trim()}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sl-note">
      <div className="sl-note-tools">
        {tagged}
        <button className="sl-note-edit-btn" onClick={() => { setDraft(note.body); setEditing(true); }} aria-label="Edit">✎</button>
        <button className="sl-note-x" onClick={() => onDelete(note.id)} aria-label="Delete">×</button>
      </div>
      <p
        ref={pRef}
        className={`sl-note-body ${expanded ? "is-expanded" : "is-clamped"}`}
        onClick={() => (overflowing || expanded) && setExpanded((v) => !v)}
        style={{ cursor: (overflowing || expanded) ? "pointer" : "default" }}
      >
        {note.body}
      </p>
      {(overflowing || expanded) && (
        <button className="sl-note-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {children}
    </div>
  );
}

// ============================ Task item (one line, check, inline edit) ============================
function TaskItem({ task, people, onToggle, onEdit, onDelete, tagged }: {
  people: MentionPerson[];
  task: TrackTask;
  onToggle: (t: TrackTask) => void;
  onEdit: (id: string, title: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Clicking anywhere outside folds the task back to one line.
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setExpanded(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [expanded]);
  const save = async () => { const v = draft.trim(); if (v && v !== task.title) await onEdit(task.id, v); setEditing(false); };
  const cancel = () => { setDraft(task.title); setEditing(false); };

  if (editing) {
    return (
      <div className="sl-task sl-task-editing">
        <MentionInput multiline value={draft} onChange={setDraft} people={people} placeholder="Edit task. Type @ to tag someone" />
        <div className="sl-inline-actions">
          <button className="sl-note-cancel" onClick={cancel}>Cancel</button>
          <button className="sl-note-save" onClick={save} disabled={!draft.trim()}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`sl-task ${task.done ? "is-done" : ""} ${expanded ? "is-expanded" : ""}`}>
      <button className="sl-check" onClick={() => onToggle(task)} aria-label="Toggle">{task.done ? "✓" : ""}</button>
      <span className="sl-task-title" onClick={() => setExpanded((v) => !v)}
        title={expanded ? "" : cleanMentionsFn(task.title)}>{cleanMentionsFn(task.title)}</span>
      {tagged}
      <button className="sl-note-edit-btn sl-inline-edit-btn" onClick={() => { setDraft(task.title); setEditing(true); }} aria-label="Edit">✎</button>
      <button className="sl-task-x sl-inline-x" onClick={() => onDelete(task.id)} aria-label="Delete">×</button>
    </div>
  );
}

// ============================ Meeting item (date/time left, title clamp+expand, edit) ============================
function MeetingItem({ meeting, people, fmtMeet, onEdit, onDelete, onKind, tagged }: {
  people: MentionPerson[];
  onKind: (id: string, kind: MeetingKind) => void;
  meeting: TrackMeeting;
  fmtMeet: (iso: string | null) => string;
  onEdit: (id: string, title: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  tagged?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meeting.title);
  const [overflowing, setOverflowing] = useState(false);
  const pRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = pRef.current;
    if (el && !editing) setOverflowing(el.scrollHeight > el.clientHeight + 2);
  }, [meeting.title, editing, expanded]);

  const save = async () => { const v = draft.trim(); if (v && v !== meeting.title) await onEdit(meeting.id, v); setEditing(false); };
  const cancel = () => { setDraft(meeting.title); setEditing(false); };

  // fmtMeet gives "12 Aug, 10:00"; split date and time for the left block.
  const at = fmtMeet(meeting.meet_at);
  const [datePart, timePart] = at.includes(",") ? at.split(",").map((s) => s.trim()) : [at, ""];

  const past = !!meeting.meet_at && new Date(meeting.meet_at).getTime() < Date.now();
  const kind = (meeting.kind ?? "in_person") as MeetingKind;

  return (
    <div className={`sl-meeting ${past ? "is-past" : ""}`}>
      <div className="sl-meet-when-block">
        <span className="sl-meet-date">{datePart}</span>
        {timePart && <span className="sl-meet-time">{timePart}</span>}
        {past && <span className="sl-meet-past">done</span>}
      </div>
      <div className="sl-meet-content">
        {editing ? (
          <div className="sl-meet-edit">
            <MentionInput multiline value={draft} onChange={setDraft} people={people} placeholder="Edit meeting. Type @ to tag someone" />
            <div className="sl-inline-actions">
              <button className="sl-note-cancel" onClick={cancel}>Cancel</button>
              <button className="sl-note-save" onClick={save} disabled={!draft.trim()}>Save</button>
            </div>
          </div>
        ) : (
          <>
            <div className="sl-meet-tools">
              <div className="sl-meet-kinds">
                {MEETING_KINDS.map((k) => (
                  <button key={k.value} className={kind === k.value ? "is-on" : ""} title={k.label}
                    aria-label={k.label} onClick={() => onKind(meeting.id, k.value)}>{k.icon}</button>
                ))}
              </div>
              {tagged}
              <button className="sl-note-edit-btn" onClick={() => { setDraft(meeting.title); setEditing(true); }} aria-label="Edit">✎</button>
              <button className="sl-note-x" onClick={() => onDelete(meeting.id)} aria-label="Delete">×</button>
            </div>
            <p ref={pRef}
              className={`sl-meet-title-body ${expanded ? "is-expanded" : "is-clamped"}`}
              onClick={() => (overflowing || expanded) && setExpanded((v) => !v)}
              style={{ cursor: (overflowing || expanded) ? "pointer" : "default" }}
            >{cleanMentionsFn(meeting.title)}</p>
            {(overflowing || expanded) && (
              <button className="sl-note-more" onClick={() => setExpanded((v) => !v)}>{expanded ? "Show less" : "Show more"}</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}