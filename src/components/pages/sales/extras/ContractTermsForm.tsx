import { useState, type ReactNode } from "react";
import Select from "../../../framework/Select";
import { NumInput } from "../../../framework/NumInput";
import {
  PAY_KEYS, PAY_LABEL, UNIT_LABEL, uid, termYears,
  type ContractConfig, type PayKey, type Term, type TermUnit, type NamedDiscount,
} from "./contractsApi";
import "./ContractTerms.css";

/* =====================================================================
   The terms of a contract — shared by the template (Settings › Catalog ›
   Contracts) and a contract on a deal. On a template every option is set
   up; on a deal (`pick`) you choose its length and how it's paid, and the
   rest comes from the template (open "Fine-tune" to change it for this deal).
   ===================================================================== */

const UNITS: TermUnit[] = ["days", "months", "years"];
const unitOpts = UNITS.map((u) => ({ value: u, label: UNIT_LABEL[u][1][0].toUpperCase() + UNIT_LABEL[u][1].slice(1) }));
const num = (v: string) => { const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const tl = (t: Term) => `${t.value} ${UNIT_LABEL[t.unit][Number(t.value) === 1 ? 0 : 1]}`;

export const IC = {
  len: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  start: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  renew: "M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5",
  pay: "M2 7h20v12H2zM2 11h20M6 15h3",
  inv: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  inc: "M3 17l6-6 4 4 8-8M15 7h6v6",
  disc: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
  tune: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
};
const PAY_ICO: Record<PayKey, string> = {
  upfront: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  annually: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 14h.01",
  semiannually: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 15h.01M15 15h.01",
  quarterly: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 14h.01M12 14h.01M16 14h.01M8 18h.01",
  monthly: "M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0M12 7v5l3 2",
};
const PAY_HINT: Record<PayKey, string> = { upfront: "All of it at the start", annually: "Once a year", semiannually: "Twice a year", quarterly: "Four times a year", monthly: "Every month" };

export const Ico = ({ d, w = 1.9 }: { d: string; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

export function Sec({ icon, title, sub, children, aside, n }: { icon: string; title: string; sub?: ReactNode; children?: ReactNode; aside?: ReactNode; n?: number }) {
  return (
    <section className="ctf-sec">
      <header className="ctf-sec-h">
        <span className="ctf-ico">{n != null ? <b>{n}</b> : <Ico d={icon} />}</span>
        <div className="ctf-sec-t"><b>{title}</b>{sub && <em>{sub}</em>}</div>
        {aside}
      </header>
      {children}
    </section>
  );
}
export function Sw({ on, onChange, label, sm }: { on: boolean; onChange: (v: boolean) => void; label?: string; sm?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`ctf-sw ${on ? "is-on" : ""} ${sm ? "is-sm" : ""} ${label ? "" : "is-bare"}`} onClick={() => onChange(!on)} aria-label={label ? undefined : on ? "On" : "Off"}>
      <span className="ctf-sw-k" aria-hidden="true"><i /></span>{label}
    </button>
  );
}
export function Pct({ value, onChange, suffix = "%", width = 82, label, big }: { value: number; onChange: (v: number) => void; suffix?: string; width?: number; label?: string; big?: boolean }) {
  return (
    <label className={`ctf-num ${big ? "is-big" : ""}`} style={{ width }}>
      <NumInput inputMode="decimal" value={String(value ?? 0)} onChange={(e) => onChange(num(e.target.value))} aria-label={label} />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}
export function TermInput({ value, onChange, big }: { value: Term; onChange: (t: Term) => void; big?: boolean }) {
  return (
    <span className={`ctf-term ${big ? "is-big" : ""}`}>
      <label className="ctf-num" style={{ width: big ? 74 : 66 }}><NumInput inputMode="decimal" value={String(value.value)} onChange={(e) => onChange({ ...value, value: Math.max(0, num(e.target.value)) })} aria-label="Length" /></label>
      <span className="ctf-unit"><Select size="sm" value={value.unit} onChange={(u) => onChange({ ...value, unit: u as TermUnit })} options={unitOpts} aria-label="Unit" /></span>
    </span>
  );
}

/** The yearly increments, drawn: what each year costs against year 1. */
function IncBars({ c, years = 5 }: { c: ContractConfig; years?: number }) {
  const vals: number[] = [];
  let v = 100;
  for (let i = 0; i < years; i++) { if (i) v = c.increments.mode === "pct" ? v * (1 + c.increments.value / 100) : c.increments.mode === "amount" ? v + (c.increments.value / 100) : v; vals.push(v); }
  const max = Math.max(...vals);
  return (
    <div className="ctf-incbars" aria-hidden="true">
      {vals.map((x, i) => (
        <span key={i}><i style={{ height: `${max > 100 ? 28 + ((x - 100) / (max - 100)) * 72 : 40}%` }} /><em>Y{i + 1}</em><b>{i === 0 ? "base" : c.increments.mode === "amount" ? `+${Math.round(c.increments.value * i)}€` : `+${(x - 100).toFixed(1).replace(/\.0$/, "")}%`}</b></span>
      ))}
    </div>
  );
}

export default function ContractTermsForm({ value, onChange, pick }: {
  value: ContractConfig;
  onChange: (c: ContractConfig) => void;
  /** On a deal: the length and the way to pay chosen, and when it starts. */
  pick?: { term: Term; payment: PayKey; setTerm: (t: Term) => void; setPayment: (p: PayKey) => void; start: ReactNode };
}) {
  const c = value;
  const set = (p: Partial<ContractConfig>) => onChange({ ...c, ...p });
  const setDur = (id: string, p: Partial<ContractConfig["durations"][number]>) => set({ durations: c.durations.map((d) => (d.id === id ? { ...d, ...p } : d)) });
  const setPay = (k: PayKey, p: Partial<ContractConfig["payments"][number]>) => set({ payments: c.payments.map((x) => (x.key === k ? { ...x, ...p } : x)) });
  const setDisc = (id: string, p: Partial<NamedDiscount>) => set({ discounts: c.discounts.map((d) => (d.id === id ? { ...d, ...p } : d)) });
  const chosenDur = pick ? c.durations.find((d) => d.unit === pick.term.unit && Number(d.value) === Number(pick.term.value)) : null;
  const [tune, setTune] = useState(false);
  const sorted = [...c.durations].sort((a, b) => termYears(a) - termYears(b));

  /* ---- lengths ---- */
  const lengths = pick ? (
    <Sec icon={IC.len} n={2} title="Length" sub={chosenDur ? (chosenDur.discountPct ? `${chosenDur.discountPct}% off for committing ${tl(chosenDur)}` : "No length discount") : "A length of its own: no length discount"}>
      <div className="ctf-lens">
        {sorted.map((d) => {
          const on = chosenDur?.id === d.id;
          return (
            <button key={d.id} type="button" role="radio" aria-checked={on} className={`ctf-len is-pick ${on ? "is-on" : ""}`} onClick={() => pick.setTerm({ value: d.value, unit: d.unit })}>
              <b>{d.value}</b><span>{UNIT_LABEL[d.unit][d.value === 1 ? 0 : 1]}</span>
              <em className={d.discountPct ? "" : "is-zero"}>{d.discountPct ? `−${d.discountPct}%` : "list price"}</em>
            </button>
          );
        })}
        <div className={`ctf-len is-custom ${chosenDur ? "" : "is-on"}`}>
          <span className="ctf-len-k">Other</span>
          <TermInput value={pick.term} onChange={pick.setTerm} />
        </div>
      </div>
    </Sec>
  ) : (
    <Sec icon={IC.len} title="Lengths it's sold for" sub="Each with the discount it earns — the longer they commit, the better the price">
      <div className="ctf-lens">
        {c.durations.map((d) => (
          <div key={d.id} className="ctf-len is-edit">
            <button type="button" className="ctf-len-x" onClick={() => set({ durations: c.durations.filter((x) => x.id !== d.id) })} aria-label="Remove this length" title="Remove">×</button>
            <TermInput value={{ value: d.value, unit: d.unit }} onChange={(t) => setDur(d.id, t)} big />
            <span className="ctf-len-d"><span>Discount</span><Pct value={d.discountPct} onChange={(v) => setDur(d.id, { discountPct: Math.max(0, Math.min(100, v)) })} label="Discount for this length" width={84} /></span>
          </div>
        ))}
        <button type="button" className="ctf-len is-add" onClick={() => set({ durations: [...c.durations, { id: uid(), value: (c.durations.at(-1)?.value ?? 0) + 1, unit: c.durations.at(-1)?.unit ?? "years", discountPct: (c.durations.at(-1)?.discountPct ?? 0) + 5 }] })}>
          <span>+</span>Add a length
        </button>
      </div>
    </Sec>
  );

  /* ---- ways to pay ---- */
  const pays = (
    <Sec icon={IC.pay} n={pick ? 4 : undefined} title={pick ? "How it's paid" : "Ways to pay"} sub={pick ? "Its early-payment discount comes with it" : "Switch on the ones you offer, each with its early-payment discount; the star is picked first"}>
      <div className="ctf-pays">
        {PAY_KEYS.map((k) => {
          const p = c.payments.find((x) => x.key === k)!;
          if (pick && !p.enabled) return null;
          const on = pick ? pick.payment === k : p.enabled;
          const def = c.defaultPayment === k;
          return pick ? (
            <button key={k} type="button" role="radio" aria-checked={on} className={`ctf-pay is-pick ${on ? "is-on" : ""}`} onClick={() => pick.setPayment(k)}>
              <span className="ctf-pay-ico"><Ico d={PAY_ICO[k]} /></span>
              <span className="ctf-pay-t"><b>{PAY_LABEL[k]}</b><em>{PAY_HINT[k]}</em></span>
              {p.discountPct ? <span className="ctf-pay-badge">−{p.discountPct}%</span> : null}
            </button>
          ) : (
            <div key={k} className={`ctf-pay ${on ? "is-on" : "is-off"}`}>
              <div className="ctf-pay-top">
                <span className="ctf-pay-ico"><Ico d={PAY_ICO[k]} /></span>
                <span className="ctf-pay-t"><b>{PAY_LABEL[k]}</b><em>{PAY_HINT[k]}</em></span>
                <Sw on={p.enabled} onChange={(v) => { setPay(k, { enabled: v }); if (!v && def) { const nx = c.payments.find((x) => x.key !== k && x.enabled); if (nx) set({ payments: c.payments.map((x) => (x.key === k ? { ...x, enabled: false } : x)), defaultPayment: nx.key }); } }} sm />
              </div>
              <div className="ctf-pay-bot">
                <span className="ctf-pay-dl">Discount</span>
                <Pct value={p.discountPct} onChange={(v) => setPay(k, { discountPct: Math.max(0, Math.min(100, v)) })} label={`${PAY_LABEL[k]} discount`} width={84} />
                <button type="button" className={`ctf-star ${def ? "is-on" : ""}`} disabled={!p.enabled} onClick={() => set({ defaultPayment: k })} title={def ? "Picked first on a new contract" : "Pick this first on a new contract"} aria-pressed={def}>
                  <Ico d={IC.star} w={1.8} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Sec>
  );

  /* ---- invoicing: a small timeline ---- */
  const invoicing = (
    <Sec icon={IC.inv} title="When it's invoiced" sub="Paid ahead: the invoice goes out before the contract (or each paid period) starts or renews">
      <div className="ctf-tl">
        <div className="ctf-tl-n is-inv"><i /><b>Invoice goes out</b><em>Day 0</em></div>
        <div className="ctf-tl-gap"><span><Pct value={c.prepayDays} onChange={(v) => set({ prepayDays: Math.max(0, Math.round(v)) })} suffix="days before" width={150} label="Days before it starts" /></span></div>
        <div className="ctf-tl-n is-start"><i /><b>Starts / renews</b><em>{c.prepayDays ? `Day ${c.prepayDays}` : "Same day"}</em></div>
      </div>
      <div className="ctf-tl-due">
        <span>Due</span><Pct value={c.paymentTermsDays} onChange={(v) => set({ paymentTermsDays: Math.max(0, Math.round(v)) })} suffix="days" width={98} label="Payment terms" /><span>after it goes out — {c.paymentTermsDays <= c.prepayDays ? "paid before it starts" : `${c.paymentTermsDays - c.prepayDays} days after it starts`}</span>
      </div>
    </Sec>
  );

  /* ---- increments ---- */
  const increments = (
    <Sec icon={IC.inc} title="Yearly increments" sub={c.increments.mode === "none" || !c.increments.value ? "Flat: every year costs the same" : c.increments.waivedIfUpfront ? "From year 2 — not when it's paid upfront" : "From year 2, every year"}>
      <div className="ctf-inc">
        <div className="ctf-inc-l">
          <div className="ctf-seg" role="radiogroup" aria-label="Increments">
            {([["none", "Flat"], ["pct", "% a year"], ["amount", "€ a year"]] as const).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={c.increments.mode === k} className={c.increments.mode === k ? "is-on" : ""} onClick={() => set({ increments: { ...c.increments, mode: k } })}>{l}</button>
            ))}
          </div>
          {c.increments.mode !== "none" && (
            <div className="ctf-line">
              <Pct value={c.increments.value} onChange={(v) => set({ increments: { ...c.increments, value: Math.max(0, v) } })} suffix={c.increments.mode === "pct" ? "%" : "€"} label="Increment" width={92} />
              <Sw on={c.increments.waivedIfUpfront} onChange={(v) => set({ increments: { ...c.increments, waivedIfUpfront: v } })} label="None if paid upfront" />
            </div>
          )}
        </div>
        {c.increments.mode !== "none" && !!c.increments.value && c.increments.mode === "pct" && <IncBars c={c} />}
      </div>
    </Sec>
  );

  /* ---- renewal ---- */
  const renewal = (
    <Sec icon={IC.renew} title="Renewal" aside={<Sw on={c.autoRenew} onChange={(v) => set({ autoRenew: v, renew: v ? c.renew ?? { value: 1, unit: "years" } : c.renew })} label={c.autoRenew ? "Renews by itself" : "Ends"} />}
      sub={c.autoRenew ? `Renews for ${tl(c.renew ?? { value: 1, unit: "years" })} unless notice is given ${c.noticeDays ? `${c.noticeDays} days before` : ""}` : "It ends at the end of its length"}>
      {c.autoRenew && (
        <div className="ctf-line">
          <span>Renews for</span><TermInput value={c.renew ?? { value: 1, unit: "years" }} onChange={(t) => set({ renew: t })} />
          <span className="ctf-sep" />
          <span>Notice</span><Pct value={c.noticeDays ?? 0} onChange={(v) => set({ noticeDays: Math.max(0, Math.round(v)) })} suffix="days before" width={150} label="Notice days" />
        </div>
      )}
    </Sec>
  );

  /* ---- commercial discounts ---- */
  const discounts = (
    <Sec icon={IC.disc} n={pick ? 5 : undefined} title="Commercial discounts" sub={pick ? "Tick the ones that apply to this deal, or add your own" : "Named discounts sales can apply — ticked ones come applied"}>
      {c.discounts.length === 0 && <p className="ctf-empty">None yet. Add a discount with the name you want — e.g. “Launch partner”, “Multi-entity”, “Referral”.</p>}
      <div className="ctf-discs">
        {c.discounts.map((d) => (
          <div className={`ctf-disc ${d.on ? "is-on" : ""}`} key={d.id}>
            <button type="button" role="checkbox" aria-checked={d.on} className={`ctf-tick ${d.on ? "is-on" : ""}`} onClick={() => setDisc(d.id, { on: !d.on })} title={d.on ? (pick ? "Applied" : "Applied by default") : (pick ? "Not applied" : "Off by default")}>
              <svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10" /></svg>
            </button>
            <span className="ctf-disc-tag"><Ico d={IC.disc} /></span>
            <input className="ctf-name" value={d.name} placeholder="Name it" onChange={(e) => setDisc(d.id, { name: e.target.value })} aria-label="Discount name" />
            <div className="ctf-seg is-sm" role="radiogroup" aria-label="Kind">
              <button type="button" role="radio" aria-checked={d.mode === "pct"} className={d.mode === "pct" ? "is-on" : ""} onClick={() => setDisc(d.id, { mode: "pct" })}>%</button>
              <button type="button" role="radio" aria-checked={d.mode === "amount"} className={d.mode === "amount" ? "is-on" : ""} onClick={() => setDisc(d.id, { mode: "amount" })} title="Euros off each year">€</button>
            </div>
            <Pct value={d.value} onChange={(v) => setDisc(d.id, { value: Math.max(0, v) })} suffix={d.mode === "pct" ? "%" : "€/yr"} width={d.mode === "pct" ? 84 : 108} label="Discount" />
            <button type="button" className="ctf-x" onClick={() => set({ discounts: c.discounts.filter((x) => x.id !== d.id) })} aria-label="Remove the discount" title="Remove">×</button>
          </div>
        ))}
      </div>
      <button type="button" className="ctf-add" onClick={() => set({ discounts: [...c.discounts, { id: uid(), name: "", mode: "pct", value: 5, on: true }] })}>+ Add a discount</button>
    </Sec>
  );

  /* ---- grace period (template default) ---- */
  const graceSec = (
    <Sec icon={IC.start} title="Grace period" sub={c.grace ? `Signed, it starts ${tl(c.grace)} later — sales can change it on the deal` : "It starts the day it's signed — sales can add a grace period on the deal"}
      aside={<Sw on={!!c.grace} onChange={(v) => set({ grace: v ? { value: 1, unit: "months" } : null })} label={c.grace ? "By default" : "None"} />}>
      {c.grace && (
        <div className="ctf-line"><span>Starts</span><TermInput value={c.grace} onChange={(t) => set({ grace: t.value > 0 ? t : null })} /><span>after it's signed</span></div>
      )}
    </Sec>
  );

  if (!pick) return <div className="ctf">{lengths}{pays}{graceSec}{invoicing}{increments}{renewal}{discounts}</div>;

  // on a deal: the choices first, the template's terms folded under "Fine-tune"
  const tuneSum = [
    c.prepayDays ? `invoiced ${c.prepayDays}d ahead, due in ${c.paymentTermsDays}d` : `due in ${c.paymentTermsDays}d`,
    c.increments.mode === "none" || !c.increments.value ? "flat" : `+${c.increments.value}${c.increments.mode === "pct" ? "%" : "€"} a year${c.increments.waivedIfUpfront ? " (not upfront)" : ""}`,
    c.autoRenew ? `renews ${tl(c.renew ?? { value: 1, unit: "years" })}` : "ends",
  ].join(" · ");
  return (
    <div className="ctf">
      {lengths}
      <Sec icon={IC.start} n={3} title="Signed, grace period and start" sub="Signing and starting can be different days: the grace period sits in between">{pick.start}</Sec>
      {pays}
      {discounts}
      <section className={`ctf-tune ${tune ? "is-open" : ""}`}>
        <button type="button" className="ctf-tune-h" onClick={() => setTune((v) => !v)} aria-expanded={tune}>
          <span className="ctf-ico"><Ico d={IC.tune} /></span>
          <span className="ctf-sec-t"><b>Fine-tune the terms</b><em>{tuneSum}</em></span>
          <svg className="ctf-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        {tune && <div className="ctf-tune-b">{invoicing}{increments}{renewal}</div>}
      </section>
    </div>
  );
}
