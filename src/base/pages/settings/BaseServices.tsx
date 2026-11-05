/* =====================================================================
   BASE · services in Settings › Products & Services: the card on the page
   and its one-page pop-up (name, steps, how it bills, price).
   ===================================================================== */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BILLING, billingOf, evenPercents, newStep, saveBaseService, deleteBaseService, type BaseService, type ServiceBilling, type ServiceStep } from "./baseServicesApi";

export const SERVICE_COLOR = "#5b6ee1";
const amount = (n: number) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const D = {
  steps: "M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  pen: "M4 20h4L19 9l-4-4L4 16v4z",
  split: "M5 9h14M5 15h14",
};
const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const initialsOf = (name: string) => name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

// ============================ the card ============================
export function ServiceCard({ service, onOpen }: { service: BaseService; onOpen: () => void }) {
  const b = billingOf(service.billing);
  const fixed = service.billing === "upfront" || service.billing === "by_step";
  return (
    <section className="bc-card bc-svc" style={{ ["--kc" as string]: SERVICE_COLOR }} role="button" tabIndex={0}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }} aria-label={`Edit ${service.name}`}>
      <div className="bc-band" aria-hidden="true" />
      <header className="bc-hd">
        <span className="bc-tile" aria-hidden="true">{initialsOf(service.name) || <Ico d={D.steps} s={20} />}</span>
        <div className="bc-hd-txt">
          <h3 className="bc-svc-name">{service.name || "Untitled service"}</h3>
          <span className="bc-svc-pills">
            <span className="bc-pill"><i aria-hidden="true" />Service</span>
            <span className="bc-pill is-soft">{b.label}</span>
          </span>
        </div>
        <span className="bc-svc-edit" aria-hidden="true"><Ico d={D.pen} s={14} /></span>
      </header>

      <div className="bc-hero is-static">
        <div className="bc-hero-price">
          <span className="bc-static-price"><span className="bc-cur">€</span>{service.price ? amount(service.price) : "0"}</span>
          <span className="bc-hero-unit">{fixed ? (service.billing === "upfront" ? "fixed · billed upfront" : "fixed · billed by step") : b.unit}</span>
        </div>
      </div>

      {service.steps.length > 0 ? (
        <ol className="bc-flow" aria-label="Steps">
          {service.steps.map((st, i) => (
            <li key={st.id} style={{ ["--i" as string]: i }}>
              <span className="bc-flow-n">{i + 1}</span>
              <span className="bc-flow-name">{st.name || `Step ${i + 1}`}</span>
              {service.billing === "by_step" && <span className="bc-flow-pct">{amount(st.percent)}%</span>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="bc-flow-empty">No steps yet</p>
      )}
    </section>
  );
}

// ============================ the pop-up ============================
export function ServiceModal({ service, onClose, onSaved, onDeleted }: {
  service: BaseService; onClose: () => void; onSaved: (s: BaseService) => void; onDeleted: () => void;
}) {
  const isNew = !service.id;
  const [s, setS] = useState<BaseService>(() => structuredClone(service));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [askDel, setAskDel] = useState(false);
  const [closing, setClosing] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const stepRefs = useRef<(HTMLInputElement | null)[]>([]);
  const focusStep = useRef<number | null>(null);
  useEffect(() => { if (isNew) nameRef.current?.focus(); }, [isNew]);
  useEffect(() => { if (focusStep.current != null) { stepRefs.current[focusStep.current]?.focus(); focusStep.current = null; } });

  const close = () => { setClosing(true); window.setTimeout(onClose, 220); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<BaseService>) => { setS((x) => ({ ...x, ...patch })); setErr(null); };
  const setSteps = (steps: ServiceStep[]) => set({ steps });
  const byStep = s.billing === "by_step";
  const pctSum = Math.round(s.steps.reduce((n, st) => n + (Number(st.percent) || 0), 0) * 10) / 10;
  const setBilling = (b: ServiceBilling) => {
    // switching to "by step": the steps get an even split if they have none yet
    if (b === "by_step" && s.steps.length && pctSum !== 100) set({ billing: b, steps: evenPercents(s.steps) });
    else set({ billing: b });
  };
  const addStep = () => {
    const steps = [...s.steps, newStep()];
    focusStep.current = steps.length - 1;
    setSteps(byStep ? evenPercents(steps) : steps);
  };
  const removeStep = (i: number) => { const steps = s.steps.filter((_, j) => j !== i); setSteps(byStep ? evenPercents(steps) : steps); };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= s.steps.length) return;
    const steps = [...s.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setSteps(steps);
  };

  const save = async () => {
    if (!s.name.trim()) { setErr("Give the service a name."); nameRef.current?.focus(); return; }
    const steps = s.steps.filter((st) => st.name.trim());
    if (byStep && steps.length === 0) { setErr("Billing by step needs at least one step."); return; }
    if (byStep && Math.abs(steps.reduce((n, st) => n + (Number(st.percent) || 0), 0) - 100) > 0.05) { setErr("The steps must add up to 100%."); return; }
    setBusy(true);
    const r = await saveBaseService({ ...s, steps });
    setBusy(false);
    if (typeof r === "string") { setErr(r); return; }
    onSaved(r);
  };
  const remove = async () => {
    setBusy(true);
    const msg = await deleteBaseService(s);
    setBusy(false);
    if (msg) { setErr(msg); setAskDel(false); return; }
    onDeleted();
  };
  const b = billingOf(s.billing);

  return createPortal(
    <div className={`bsm-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={close}>
      <div className="bsm" role="dialog" aria-modal="true" aria-label={isNew ? "New service" : s.name} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void save(); } }}>
        <header className="bsm-hd">
          <span className="bsm-tile" aria-hidden="true">{initialsOf(s.name) || <Ico d={D.steps} s={20} />}</span>
          <div className="bsm-hd-txt">
            <span className="bsm-eyebrow">{isNew ? "New service" : "Service"}</span>
            <input ref={nameRef} className={`bsm-name ${err && !s.name.trim() ? "is-err" : ""}`} value={s.name} placeholder="Service name, e.g. Implementation"
              onChange={(e) => set({ name: e.target.value })} aria-label="Service name" />
          </div>
          <button type="button" className="bsm-x" onClick={close} aria-label="Close"><Ico d={D.x} s={16} /></button>
        </header>

        <div className="bsm-body">
          <section className="bsm-sec">
            <div className="bsm-sec-h">
              <div><h4>Steps</h4><p>What the work goes through, in order.</p></div>
              {byStep && s.steps.length > 1 && (
                <button type="button" className="bsm-mini" onClick={() => setSteps(evenPercents(s.steps))} title="Same % for every step"><Ico d={D.split} s={12} />Split evenly</button>
              )}
            </div>
            <ol className="bsm-steps">
              {s.steps.map((st, i) => (
                <li key={st.id} className="bsm-step" style={{ ["--i" as string]: i }}>
                  <span className="bsm-step-n">{i + 1}</span>
                  <input ref={(el) => { stepRefs.current[i] = el; }} className="bsm-step-name" value={st.name} placeholder={`Step ${i + 1}`}
                    onChange={(e) => setSteps(s.steps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (i === s.steps.length - 1) addStep(); else stepRefs.current[i + 1]?.focus(); } }}
                    aria-label={`Step ${i + 1}`} />
                  {byStep && (
                    <label className="bsm-pct">
                      <input inputMode="decimal" value={st.percent ? String(st.percent).replace(".", ",") : ""} placeholder="0"
                        onChange={(e) => {
                          const n = Number(e.target.value.replace(/[^\d.,]/g, "").replace(",", "."));
                          setSteps(s.steps.map((x, j) => (j === i ? { ...x, percent: Number.isFinite(n) ? Math.min(100, n) : 0 } : x)));
                        }} aria-label={`Share of the price for step ${i + 1}`} />
                      <span>%</span>
                      {s.price > 0 && <em>€{amount((s.price * (Number(st.percent) || 0)) / 100)}</em>}
                    </label>
                  )}
                  <span className="bsm-step-tools">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" title="Move up"><Ico d={D.up} s={12} /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === s.steps.length - 1} aria-label="Move down" title="Move down"><Ico d={D.down} s={12} /></button>
                    <button type="button" className="is-del" onClick={() => removeStep(i)} aria-label="Remove step" title="Remove step"><Ico d={D.x} s={12} /></button>
                  </span>
                </li>
              ))}
            </ol>
            <div className="bsm-steps-foot">
              <button type="button" className="bsm-add" onClick={addStep}><Ico d={D.plus} s={13} />Add step</button>
              {byStep && s.steps.length > 0 && (
                <span className={`bsm-sum ${Math.abs(pctSum - 100) < 0.05 ? "is-ok" : "is-off"}`}>{amount(pctSum)}% of 100%</span>
              )}
            </div>
          </section>

          <section className="bsm-sec">
            <div className="bsm-sec-h"><div><h4>How it bills</h4><p>{b.hint}</p></div></div>
            <div className="bsm-bill" role="radiogroup" aria-label="How it bills" style={{ ["--b" as string]: BILLING.findIndex((x) => x.v === s.billing) }}>
              <span className="bsm-bill-light" aria-hidden="true" />
              {BILLING.map((x) => (
                <button key={x.v} type="button" role="radio" aria-checked={s.billing === x.v} className={s.billing === x.v ? "is-on" : ""} onClick={() => setBilling(x.v)}>{x.label}</button>
              ))}
            </div>
            <label className="bsm-price">
              <span className="bsm-price-l">{b.priceLabel}</span>
              <span className="bsm-price-v">
                <span className="bc-cur">€</span>
                <PriceInput value={s.price} onChange={(v) => set({ price: v })} />
                <span className="bsm-price-u">{s.billing === "upfront" || s.billing === "by_step" ? "in total" : b.unit}</span>
              </span>
            </label>
          </section>
        </div>

        <footer className="bsm-ft">
          {!isNew && (askDel ? (
            <span className="bsm-del-ask">Delete this service?
              <button type="button" className="is-yes" onClick={remove} disabled={busy}>Delete</button>
              <button type="button" onClick={() => setAskDel(false)}>Keep</button>
            </span>
          ) : (
            <button type="button" className="bsm-del" onClick={() => setAskDel(true)}><Ico d={D.trash} s={14} />Delete</button>
          ))}
          <span className="bsm-ft-r">
            {err && <span className="bsm-err">{err}</span>}
            <button type="button" className="bc-ghost" onClick={close} disabled={busy}>Cancel</button>
            <button type="button" className="bc-save bsm-save" onClick={save} disabled={busy}>{busy ? "Saving…" : isNew ? "Create service" : "Save"}</button>
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** The price, formatted at rest, plain while you type (whole amount selected on focus). */
function PriceInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const show = (n: number) => (n ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "");
  const [txt, setTxt] = useState(() => show(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setTxt(show(value)); }, [value]);
  return (
    <input inputMode="decimal" value={txt} placeholder="0" size={Math.max(1, (txt || "0").length)} aria-label="Price"
      onFocus={(e) => { focused.current = true; const raw = value ? String(value).replace(".", ",") : ""; e.target.value = raw; e.target.select(); setTxt(raw); }}
      onBlur={() => { focused.current = false; setTxt(show(value)); }}
      onChange={(e) => {
        setTxt(e.target.value);
        let t = e.target.value.replace(/[^\d.,]/g, "");
        if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
        else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
        const n = Number(t);
        onChange(Number.isFinite(n) ? n : 0);
      }} />
  );
}
