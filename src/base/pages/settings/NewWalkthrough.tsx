/* =====================================================================
   BASE · Settings › Products & Services — the walkthrough for a new one.
   Product: name & kind → how it's paid → price (one, or tiers) → check & create.
   Service: name → its steps → how it's billed → price (and % per step) → check & create.
   Closing it ("Skip the walkthrough") hands what's filled in so far to the
   usual editor (the product card / the service pop-up).
   ===================================================================== */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { saveProduct, loadProducts, type Product } from "./catalogApi";
import { BILLING, evenPercents, newStep, saveBaseService, type BaseService, type ServiceBilling } from "./baseServicesApi";
import "./NewWalkthrough.css";

const P_COLOR = "#12b57f";
const S_COLOR = "#5b6ee1";
const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  x: "M6 6l12 12M18 6L6 18", plus: "M12 5v14M5 12h14", check: "M5 12.5l4.2 4.2L19 7", left: "M15 18l-6-6 6-6", right: "M9 6l6 6-6 6",
  box: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8", steps: "M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3", cal: "M3 6h18v15H3zM3 10h18M8 3v4M16 3v4", one: "M12 2v20M5 9l7-7 7 7",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3", spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
};
const parse = (raw: string) => { let t = raw.replace(/[^\d.,]/g, ""); if (t.includes(",")) t = t.replace(/\./g, "").replace(",", "."); const n = Number(t); return Number.isFinite(n) ? n : 0; };
const fmt = (n: number) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

/** An amount typed as you like (12000, 12.000, 12,5); shown plain while editing. */
function MoneyIn({ value, onChange, onEnter, autoFocus, className }: { value: number; onChange: (n: number) => void; onEnter?: () => void; autoFocus?: boolean; className?: string }) {
  const [raw, setRaw] = useState(value ? String(value) : "");
  return (
    <input className={className} inputMode="decimal" value={raw} placeholder="0" autoFocus={autoFocus}
      onChange={(e) => { const t = e.target.value.replace(/[^\d.,]/g, ""); setRaw(t); onChange(parse(t)); }}
      onKeyDown={(e) => { if (e.key === "Enter") onEnter?.(); }} />
  );
}

type Kind = "product" | "service";
interface Props {
  kind: Kind;
  kinds: string[];
  onClose: () => void;
  /** Skip: carry on in the usual editor with what's filled in. */
  onSkipProduct: (p: Product) => void;
  onSkipService: (s: BaseService) => void;
  onCreatedProduct: (p: Product) => void;
  onCreatedService: (s: BaseService) => void;
}

export default function NewWalkthrough({ kind, kinds, onClose, onSkipProduct, onSkipService, onCreatedProduct, onCreatedService }: Props) {
  const color = kind === "product" ? P_COLOR : S_COLOR;
  const [step, setStep] = useState(0);
  const [seen, setSeen] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [splitN, setSplitN] = useState(0);
  // product
  const [p, setP] = useState<Product>(() => ({
    name: "", kind: kinds[0] ?? "SaaS", billing: "recurring", billing_period: "monthly", description: "", active: true,
    tiers: [{ name: "Standard", price: 0, sort: 0, durations: [] }], multi_year: false, default_years: 1, increment_mode: "none", increment_value: 0,
  }));
  const [tiered, setTiered] = useState(false);
  // service
  const [s, setS] = useState<BaseService>(() => ({ name: "", billing: "upfront", price: 0, steps: evenPercents([newStep("Kick-off"), newStep("Delivery"), newStep("Hand-over")]) }));

  const STEPS = kind === "product"
    ? [{ t: "Name", q: "What's it called?" }, { t: "Billing", q: "How is it paid?" }, { t: "Price", q: "What does it cost?" }, { t: "Create", q: "Looks right?" }]
    : [{ t: "Name", q: "What's the service called?" }, { t: "Steps", q: "How is the work done?" }, { t: "Billing", q: "How is it billed?" }, { t: "Price", q: "What does it cost?" }, { t: "Create", q: "Looks right?" }];
  const last = STEPS.length - 1;
  const name = kind === "product" ? p.name : s.name;
  const canNext = step !== 0 || !!name.trim();
  const go = (n: number) => { if (n < 0 || n > last) return; if (n > step && !canNext) { setErr("Give it a name first."); return; } setErr(null); setStep(n); setSeen((x) => Math.max(x, n)); };
  const close = (after?: () => void) => { setClosing(true); window.setTimeout(() => { onClose(); after?.(); }, 220); };
  const skip = () => close(() => (kind === "product" ? onSkipProduct(p) : onSkipService(s)));

  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (step === 0) first.current?.focus(); }, [step]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") skip(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const create = async () => {
    setBusy(true); setErr(null);
    if (kind === "product") {
      const clean: Product = { ...p, name: p.name.trim(), tiers: (tiered ? p.tiers : p.tiers.slice(0, 1)).map((t, i) => ({ ...t, name: t.name.trim() || (tiered ? `Tier ${i + 1}` : "Standard"), price: Number(t.price) || 0, sort: i })) };
      const msg = await saveProduct(clean);
      if (msg && !/^Saved, but/.test(msg)) { setErr(msg); setBusy(false); return; }
      const saved = (await loadProducts().catch(() => [])).find((x) => x.name === clean.name && x.kind === clean.kind) ?? clean;
      setBusy(false); close(() => onCreatedProduct(saved));
    } else {
      const clean: BaseService = { ...s, name: s.name.trim(), steps: s.steps.filter((x) => x.name.trim()).map((x) => ({ ...x, name: x.name.trim() })) };
      const r = await saveBaseService(clean);
      setBusy(false);
      if (typeof r === "string") { setErr(r); return; }
      close(() => onCreatedService(r));
    }
  };

  const mode = p.billing === "one_time" ? "one_time" : p.billing_period === "yearly" ? "yearly" : "monthly";
  const unit = mode === "one_time" ? "one time" : mode === "yearly" ? "/ year" : "/ month";
  const sb = BILLING.find((b) => b.v === s.billing)!;
  const pctSum = Math.round(s.steps.reduce((a, x) => a + (Number(x.percent) || 0), 0) * 10) / 10;

  /* ---------------- the steps ---------------- */
  const body = (() => {
    const q = STEPS[step].t;
    if (q === "Name") return (
      <div className="wk-pane">
        <input ref={first} className="wk-big" value={name} placeholder={kind === "product" ? "e.g. Reporting Cloud" : "e.g. Implementation"}
          onChange={(e) => { setErr(null); if (kind === "product") setP({ ...p, name: e.target.value }); else setS({ ...s, name: e.target.value }); }}
          onKeyDown={(e) => { if (e.key === "Enter") go(step + 1); }} />
        {kind === "product" && (
          <>
            <span className="wk-lbl">What kind of product</span>
            <div className="wk-chips">
              {(kinds.length ? kinds : ["SaaS", "Physical", "Add-on"]).map((k) => (
                <button key={k} type="button" className={`wk-chip ${p.kind === k ? "is-on" : ""}`} onClick={() => setP({ ...p, kind: k })}>{p.kind === k && <Ico d={I.check} s={12} />}{k}</button>
              ))}
            </div>
            <p className="wk-tip">Kinds are your own list — you can add or rename them on the product later.</p>
          </>
        )}
        {kind === "service" && <p className="wk-tip">The name clients see on deals and invoices.</p>}
      </div>
    );
    if (q === "Billing" && kind === "product") return (
      <div className="wk-pane">
        <div className="wk-opts is-3">
          {([["monthly", "Every month", "A subscription, billed monthly", I.repeat], ["yearly", "Every year", "A yearly licence or plan", I.cal], ["one_time", "One time", "Sold once — no renewal", I.one]] as const).map(([m, t, sub, ic]) => (
            <button key={m} type="button" className={`wk-opt ${mode === m ? "is-on" : ""}`}
              onClick={() => setP(m === "one_time" ? { ...p, billing: "one_time" } : { ...p, billing: "recurring", billing_period: m })}>
              <i><Ico d={ic} s={18} /></i><b>{t}</b><small>{sub}</small>
            </button>
          ))}
        </div>
        <p className="wk-tip">One time is for selling directly, with nothing recurring.</p>
      </div>
    );
    if (q === "Price" && kind === "product") return (
      <div className="wk-pane">
        <div className="wk-seg">
          <button type="button" className={!tiered ? "is-on" : ""} onClick={() => setTiered(false)}>One price</button>
          <button type="button" className={tiered ? "is-on" : ""} onClick={() => {
            setTiered(true);
            if (p.tiers.length < 2) setP({ ...p, tiers: [{ ...p.tiers[0], name: "Basic" }, { name: "Pro", price: 0, sort: 1, durations: [] }] });
          }}>Tiers (Basic, Pro…)</button>
        </div>
        {!tiered ? (
          <label className="wk-money is-big"><span>€</span><MoneyIn value={p.tiers[0].price} autoFocus onEnter={() => go(step + 1)}
            onChange={(n) => setP({ ...p, tiers: [{ ...p.tiers[0], price: n }, ...p.tiers.slice(1)] })} /><em>{unit}</em></label>
        ) : (
          <div className="wk-rows">
            {p.tiers.map((t, i) => (
              <div key={i} className="wk-row" style={{ ["--i" as string]: i }}>
                <input className="wk-in" value={t.name} placeholder={`Tier ${i + 1}`} onChange={(e) => setP({ ...p, tiers: p.tiers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <label className="wk-money"><span>€</span><MoneyIn value={t.price} onChange={(n) => setP({ ...p, tiers: p.tiers.map((x, j) => (j === i ? { ...x, price: n } : x)) })} /><em>{unit}</em></label>
                <button type="button" className="wk-x" disabled={p.tiers.length < 3} onClick={() => setP({ ...p, tiers: p.tiers.filter((_, j) => j !== i) })} aria-label="Remove tier"><Ico d={I.trash} s={14} /></button>
              </div>
            ))}
            <button type="button" className="wk-add" onClick={() => setP({ ...p, tiers: [...p.tiers, { name: ["Basic", "Pro", "Enterprise", "Premium"][p.tiers.length] ?? "", price: 0, sort: p.tiers.length, durations: [] }] })}><Ico d={I.plus} s={14} />Add a tier</button>
          </div>
        )}
      </div>
    );
    if (q === "Steps") return (
      <div className="wk-pane">
        <div className="wk-rows">
          {s.steps.map((x, i) => (
            <div key={x.id} className="wk-row is-step" style={{ ["--i" as string]: i }}>
              <span className="wk-n">{i + 1}</span>
              <input className="wk-in" value={x.name} placeholder={`Step ${i + 1}`} onChange={(e) => setS({ ...s, steps: s.steps.map((y) => (y.id === x.id ? { ...y, name: e.target.value } : y)) })} />
              <button type="button" className="wk-x" disabled={s.steps.length < 2} onClick={() => setS({ ...s, steps: evenPercents(s.steps.filter((y) => y.id !== x.id)) })} aria-label="Remove step"><Ico d={I.trash} s={14} /></button>
            </div>
          ))}
          <button type="button" className="wk-add" onClick={() => setS({ ...s, steps: evenPercents([...s.steps, newStep("")]) })}><Ico d={I.plus} s={14} />Add a step</button>
        </div>
        <p className="wk-tip">The phases you go through with the client. You can add tasks to each step later.</p>
      </div>
    );
    if (q === "Billing") return (
      <div className="wk-pane">
        <div className="wk-opts">
          {BILLING.map((b) => (
            <button key={b.v} type="button" className={`wk-opt is-row ${s.billing === b.v ? "is-on" : ""}`} onClick={() => setS({ ...s, billing: b.v as ServiceBilling })}>
              <i>{s.billing === b.v ? <Ico d={I.check} s={14} /> : null}</i><span><b>{b.label}</b><small>{b.hint}</small></span>
            </button>
          ))}
        </div>
      </div>
    );
    if (q === "Price") return (
      <div className="wk-pane">
        <span className="wk-lbl">{sb.priceLabel}</span>
        <label className="wk-money is-big"><span>€</span><MoneyIn value={s.price} autoFocus onEnter={() => go(step + 1)} onChange={(n) => setS({ ...s, price: n })} /><em>{sb.unit}</em></label>
        {s.billing === "by_step" && (
          <>
            <span className="wk-lbl">Billed at each step <button type="button" className="wk-link" onClick={() => { setS({ ...s, steps: evenPercents(s.steps) }); setSplitN((n) => n + 1); }}>Split evenly</button></span>
            <div className="wk-rows">
              {s.steps.map((x, i) => (
                <div key={x.id} className="wk-row is-pct">
                  <span className="wk-n">{i + 1}</span><span className="wk-sname">{x.name || `Step ${i + 1}`}</span>
                  <label className="wk-money is-pct"><MoneyIn key={`${x.id}-${splitN}`} value={x.percent} onChange={(n) => setS({ ...s, steps: s.steps.map((y) => (y.id === x.id ? { ...y, percent: n } : y)) })} /><em>%</em></label>
                  <em className="wk-eq">€{fmt((s.price * (Number(x.percent) || 0)) / 100)}</em>
                </div>
              ))}
            </div>
            <p className={`wk-tip ${pctSum !== 100 ? "is-warn" : ""}`}>{pctSum === 100 ? "Adds up to 100%." : `Adds up to ${pctSum}% — it should be 100%.`}</p>
          </>
        )}
      </div>
    );
    // Create: a preview of the row it will be
    return (
      <div className="wk-pane">
        <div className="wk-preview">
          <span className="wk-pv-tile">{name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?"}</span>
          <span className="wk-pv-main">
            <b>{name.trim() || "Untitled"}</b>
            <span>{kind === "product"
              ? <><em>{p.kind}</em><em>{mode === "one_time" ? "One time" : mode === "yearly" ? "Yearly" : "Monthly"}</em>{tiered && <em>{p.tiers.length} tiers</em>}</>
              : <><em>{sb.label}</em><em>{s.steps.filter((x) => x.name.trim()).length} steps</em></>}</span>
          </span>
          <span className="wk-pv-price">
            <b>€{kind === "product" ? (tiered ? `${fmt(Math.min(...p.tiers.map((t) => t.price)))}–${fmt(Math.max(...p.tiers.map((t) => t.price)))}` : fmt(p.tiers[0].price)) : fmt(s.price)}</b>
            <small>{kind === "product" ? unit : sb.unit}</small>
          </span>
        </div>
        {kind === "service" && (
          <ol className="wk-flow">{s.steps.filter((x) => x.name.trim()).map((x, i) => <li key={x.id}><span>{i + 1}</span>{x.name}{s.billing === "by_step" && <em>{fmt(x.percent)}%</em>}</li>)}</ol>
        )}
        <p className="wk-tip">You can change any of this later from its card.</p>
      </div>
    );
  })();

  return createPortal(
    <div className={`wk-back ${closing ? "is-closing" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) skip(); }}>
      <div className="wk" style={{ ["--kc" as string]: color }} role="dialog" aria-modal="true" aria-label={`New ${kind}`}>
        <aside className="wk-side">
          <span className="wk-kicker"><Ico d={kind === "product" ? I.box : I.steps} s={15} />New {kind}</span>
          <ol className="wk-steps">
            {STEPS.map((x, i) => (
              <li key={x.t} className={`${i === step ? "is-on" : ""} ${i < step ? "is-done" : ""}`}>
                <button type="button" disabled={i > seen} onClick={() => go(i)}>
                  <i>{i < step ? <Ico d={I.check} s={12} /> : i + 1}</i><span>{x.t}</span>
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="wk-skip" onClick={skip}>Skip the walkthrough</button>
        </aside>
        <section className="wk-main">
          <header className="wk-head">
            <span className="wk-count">Step {step + 1} of {STEPS.length}</span>
            <button type="button" className="wk-close" onClick={skip} aria-label="Close the walkthrough"><Ico d={I.x} s={16} /></button>
          </header>
          <div className="wk-bar"><s style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
          <h2 className="wk-q" key={`q${step}`}>{STEPS[step].q}</h2>
          <div className="wk-body" key={`b${step}`}>{body}</div>
          {err && <p className="wk-err">{err}</p>}
          <footer className="wk-foot">
            {step > 0 && <button type="button" className="wk-btn" onClick={() => go(step - 1)}><Ico d={I.left} s={15} />Back</button>}
            <span className="wk-sp" />
            {step < last
              ? <button type="button" className="wk-btn is-primary" disabled={!canNext} onClick={() => go(step + 1)}>Next<Ico d={I.right} s={15} /></button>
              : <button type="button" className="wk-btn is-primary" disabled={busy} onClick={() => void create()}><Ico d={I.spark} s={15} />{busy ? "Creating…" : `Create ${kind}`}</button>}
          </footer>
        </section>
      </div>
    </div>,
    document.body,
  );
}
