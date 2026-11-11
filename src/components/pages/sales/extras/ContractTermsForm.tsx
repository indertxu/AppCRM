import type { ReactNode } from "react";
import Select from "../../../framework/Select";
import { NumInput } from "../../../framework/NumInput";
import {
  PAY_KEYS, PAY_LABEL, UNIT_LABEL, uid,
  type ContractConfig, type PayKey, type Term, type TermUnit, type NamedDiscount,
} from "./contractsApi";
import "./ContractTerms.css";

/* =====================================================================
   The terms of a contract — shared by the template (Settings › Catalog ›
   Contracts) and a contract on a deal. On a template every option is
   set up; on a deal (`pick`) you also choose its length and how it's paid.
   ===================================================================== */

const UNITS: TermUnit[] = ["days", "months", "years"];
const unitOpts = UNITS.map((u) => ({ value: u, label: UNIT_LABEL[u][1][0].toUpperCase() + UNIT_LABEL[u][1].slice(1) }));
const num = (v: string) => { const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : 0; };

function Sec({ icon, title, sub, children, aside }: { icon: string; title: string; sub?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="ctf-sec">
      <header className="ctf-sec-h">
        <span className="ctf-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d={icon} /></svg></span>
        <div className="ctf-sec-t"><b>{title}</b>{sub && <em>{sub}</em>}</div>
        {aside}
      </header>
      {children}
    </section>
  );
}
function Sw({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`ctf-sw ${on ? "is-on" : ""}`} onClick={() => onChange(!on)}>
      <span className="ctf-sw-k" aria-hidden="true"><i /></span>{label}
    </button>
  );
}
export function Pct({ value, onChange, suffix = "%", width = 82, label }: { value: number; onChange: (v: number) => void; suffix?: string; width?: number; label?: string }) {
  return (
    <label className="ctf-num" style={{ width }}>
      <NumInput inputMode="decimal" value={String(value ?? 0)} onChange={(e) => onChange(num(e.target.value))} aria-label={label} />
      <span>{suffix}</span>
    </label>
  );
}
function TermInput({ value, onChange }: { value: Term; onChange: (t: Term) => void }) {
  return (
    <span className="ctf-term">
      <label className="ctf-num" style={{ width: 70 }}><NumInput inputMode="decimal" value={String(value.value)} onChange={(e) => onChange({ ...value, value: Math.max(0, num(e.target.value)) })} aria-label="Length" /></label>
      <span className="ctf-unit"><Select size="sm" value={value.unit} onChange={(u) => onChange({ ...value, unit: u as TermUnit })} options={unitOpts} aria-label="Unit" /></span>
    </span>
  );
}

const IC = {
  len: "M4 5h16v15H4zM4 10h16M9 3v4M15 3v4",
  renew: "M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5",
  pay: "M3 7h18v12H3zM3 11h18M7 15h3",
  inv: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  inc: "M3 17l6-6 4 4 8-8M15 7h6v6",
  disc: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
};

export default function ContractTermsForm({ value, onChange, pick }: {
  value: ContractConfig;
  onChange: (c: ContractConfig) => void;
  /** On a deal: the length and the way to pay chosen. */
  pick?: { term: Term; payment: PayKey; setTerm: (t: Term) => void; setPayment: (p: PayKey) => void; start: ReactNode };
}) {
  const c = value;
  const set = (p: Partial<ContractConfig>) => onChange({ ...c, ...p });
  const setDur = (id: string, p: Partial<ContractConfig["durations"][number]>) => set({ durations: c.durations.map((d) => (d.id === id ? { ...d, ...p } : d)) });
  const setPay = (k: PayKey, p: Partial<ContractConfig["payments"][number]>) => set({ payments: c.payments.map((x) => (x.key === k ? { ...x, ...p } : x)) });
  const setDisc = (id: string, p: Partial<NamedDiscount>) => set({ discounts: c.discounts.map((d) => (d.id === id ? { ...d, ...p } : d)) });
  const chosenDur = pick ? c.durations.find((d) => d.unit === pick.term.unit && Number(d.value) === Number(pick.term.value)) : null;

  return (
    <div className="ctf">
      <Sec icon={IC.len} title={pick ? "Length" : "Lengths it's sold for"}
        sub={pick ? (chosenDur ? `${chosenDur.discountPct}% off for this length` : "A length of its own: no length discount") : "Each with the discount it earns — a longer commitment, a better price"}>
        {pick && (
          <div className="ctf-pickrow">
            <TermInput value={pick.term} onChange={pick.setTerm} />
            <div className="ctf-chips">
              {c.durations.map((d) => (
                <button key={d.id} type="button" className={`ctf-chip ${chosenDur?.id === d.id ? "is-on" : ""}`} onClick={() => pick.setTerm({ value: d.value, unit: d.unit })}>
                  {d.value} {UNIT_LABEL[d.unit][d.value === 1 ? 0 : 1]}{d.discountPct ? <em>−{d.discountPct}%</em> : null}
                </button>
              ))}
            </div>
          </div>
        )}
        {!pick && (
          <div className="ctf-rows">
            {c.durations.map((d) => (
              <div className="ctf-row" key={d.id}>
                <TermInput value={{ value: d.value, unit: d.unit }} onChange={(t) => setDur(d.id, t)} />
                <span className="ctf-row-mid">discount</span>
                <Pct value={d.discountPct} onChange={(v) => setDur(d.id, { discountPct: v })} label="Discount for this length" />
                <button type="button" className="ctf-x" onClick={() => set({ durations: c.durations.filter((x) => x.id !== d.id) })} aria-label="Remove this length">×</button>
              </div>
            ))}
            <button type="button" className="ctf-add" onClick={() => set({ durations: [...c.durations, { id: uid(), value: (c.durations.at(-1)?.value ?? 0) + 1, unit: c.durations.at(-1)?.unit ?? "years", discountPct: 0 }] })}>+ Add a length</button>
          </div>
        )}
      </Sec>

      {pick && <Sec icon={IC.len} title="Starts" sub="Empty: the day it's signed">{pick.start}</Sec>}

      <Sec icon={IC.renew} title="Renewal" aside={<Sw on={c.autoRenew} onChange={(v) => set({ autoRenew: v })} label={c.autoRenew ? "Renews by itself" : "Ends"} />}
        sub={c.autoRenew ? "At the end it renews for another period unless notice is given" : "It ends at the end of its length"}>
        {c.autoRenew && (
          <div className="ctf-line">
            <span>Renews for</span><TermInput value={c.renew ?? { value: 1, unit: "years" }} onChange={(t) => set({ renew: t })} />
            <span>· notice</span><Pct value={c.noticeDays ?? 0} onChange={(v) => set({ noticeDays: v })} suffix="days" width={98} label="Notice days" />
          </div>
        )}
      </Sec>

      <Sec icon={IC.pay} title={pick ? "How it's paid" : "Ways to pay"} sub="Each with its early-payment discount">
        <div className="ctf-pays">
          {PAY_KEYS.map((k) => {
            const p = c.payments.find((x) => x.key === k)!;
            if (pick && !p.enabled) return null;
            const on = pick ? pick.payment === k : p.enabled;
            return (
              <div key={k} className={`ctf-pay ${on ? "is-on" : ""}`}>
                {pick
                  ? <button type="button" className="ctf-pay-pick" role="radio" aria-checked={on} onClick={() => pick.setPayment(k)}><i aria-hidden="true" />{PAY_LABEL[k]}</button>
                  : <Sw on={p.enabled} onChange={(v) => setPay(k, { enabled: v })} label={PAY_LABEL[k]} />}
                <span className="ctf-pay-d"><span>discount</span><Pct value={p.discountPct} onChange={(v) => setPay(k, { discountPct: v })} label={`${PAY_LABEL[k]} discount`} /></span>
                {!pick && p.enabled && <button type="button" className={`ctf-def ${c.defaultPayment === k ? "is-on" : ""}`} onClick={() => set({ defaultPayment: k })} title="Picked first on a new contract">{c.defaultPayment === k ? "Default" : "Make default"}</button>}
              </div>
            );
          })}
        </div>
      </Sec>

      <Sec icon={IC.inv} title="When it's invoiced" sub="Paid before it starts or renews: the invoice goes out ahead of each paid period">
        <div className="ctf-line">
          <span>Invoice</span><Pct value={c.prepayDays} onChange={(v) => set({ prepayDays: Math.max(0, v) })} suffix="days" width={98} label="Days before" />
          <span>before it starts / renews · due in</span><Pct value={c.paymentTermsDays} onChange={(v) => set({ paymentTermsDays: Math.max(0, v) })} suffix="days" width={98} label="Payment terms" />
        </div>
      </Sec>

      <Sec icon={IC.inc} title="Yearly increments" sub={c.increments.mode === "none" ? "Flat: every year costs the same" : c.increments.waivedIfUpfront ? "Not applied when it's paid upfront" : "Applied every year after the first"}>
        <div className="ctf-line">
          <div className="ctf-seg" role="radiogroup">
            {([["none", "Flat"], ["pct", "% a year"], ["amount", "€ a year"]] as const).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={c.increments.mode === k} className={c.increments.mode === k ? "is-on" : ""} onClick={() => set({ increments: { ...c.increments, mode: k } })}>{l}</button>
            ))}
          </div>
          {c.increments.mode !== "none" && <>
            <Pct value={c.increments.value} onChange={(v) => set({ increments: { ...c.increments, value: v } })} suffix={c.increments.mode === "pct" ? "%" : "€"} label="Increment" />
            <Sw on={c.increments.waivedIfUpfront} onChange={(v) => set({ increments: { ...c.increments, waivedIfUpfront: v } })} label="None if paid upfront" />
          </>}
        </div>
      </Sec>

      <Sec icon={IC.disc} title="Commercial discounts" sub={pick ? "Switch on the ones that apply; add your own" : "Named discounts sales can apply (on: applied by default)"}>
        <div className="ctf-rows">
          {c.discounts.map((d) => (
            <div className={`ctf-row ctf-disc ${d.on ? "is-on" : ""}`} key={d.id}>
              <button type="button" role="switch" aria-checked={d.on} className={`ctf-tick ${d.on ? "is-on" : ""}`} onClick={() => setDisc(d.id, { on: !d.on })} title={d.on ? "Applied" : "Not applied"}>
                <svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10" /></svg>
              </button>
              <input className="ctf-name" value={d.name} placeholder="Name it — e.g. Launch partner" onChange={(e) => setDisc(d.id, { name: e.target.value })} />
              <div className="ctf-seg is-sm">
                <button type="button" className={d.mode === "pct" ? "is-on" : ""} onClick={() => setDisc(d.id, { mode: "pct" })}>%</button>
                <button type="button" className={d.mode === "amount" ? "is-on" : ""} onClick={() => setDisc(d.id, { mode: "amount" })} title="Per year">€</button>
              </div>
              <Pct value={d.value} onChange={(v) => setDisc(d.id, { value: v })} suffix={d.mode === "pct" ? "%" : "€/yr"} width={d.mode === "pct" ? 82 : 100} label="Discount" />
              <button type="button" className="ctf-x" onClick={() => set({ discounts: c.discounts.filter((x) => x.id !== d.id) })} aria-label="Remove the discount">×</button>
            </div>
          ))}
          <button type="button" className="ctf-add" onClick={() => set({ discounts: [...c.discounts, { id: uid(), name: "", mode: "pct", value: 5, on: true }] })}>+ Add a discount</button>
        </div>
      </Sec>
    </div>
  );
}
