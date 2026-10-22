/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../../framework/DatePicker";
import Select from "../../../framework/Select";
import LineCalcModal, { IncrementsEditor } from "../../../framework/LineCalcModal";
import {
  lineBreakdown, yearAmounts, hasIncrements, contractFigures, incrementsToSchedule, EMPTY_INCREMENTS,
  catalogYears, catalogIncrements, REVENUE_MODES, loadRevenueMode, saveRevenueMode, teamRevenueModeNow, localRevenueMode, setLocalRevenueMode,
  type RevenueLineFields, type TermPatch, type LineIncrements, type ContractTerms, type PaymentSchedule, type RevenueMode,
} from "../sales/salesApi";
import type { Calculator, Product } from "../../settings/catalogApi";
import "./HandoffClientForm.css";

export interface HandoffContact {
  id: string; name: string; position: string; email: string; phone: string; billing: boolean;
}
export interface HandoffProduct {
  key: string;
  productId: string;
  name: string;
  price: number;                 // base (pre-discount) unit price
  quantity: number;
  recurring: boolean;
  period: string | null;
  termYears: number | null;
  discountMode: string | null;
  discountValue: number | null;
  // raw calculator state so the editable calculator opens with the deal's numbers
  tierId?: string | null;
  calcValues?: Record<string, number>;
  calcDiscounts?: Record<string, any>;
  calcRates?: Record<string, number>;
  /** Yearly increases (multi-year subscriptions). */
  increments?: LineIncrements | null;
  /** The deal line it comes from (tracking_products.id). */
  lineId?: string | null;
  signingDate: string;
  fromTracking: boolean;
  // contract details
  startDate?: string;
  oneTimeFee?: number;
  nonTerminableYears?: number | null;
  autoRenew?: boolean;
  renewYears?: number | null;
  annualIncreasePct?: number | null;
  paymentTermsDays?: number | null;
  contractRef?: string;
  externalRef?: string;
  billingContactId?: string | null;  // exclusive billing contact for THIS product contract
  /** Payment terms of a multi-year contract (from the yearly increases). */
  schedule?: PaymentSchedule | null;
  /** How the final price was built, for the client page. */
  breakdown?: any;
}

export interface HandoffPrefill {
  name: string;
  legalName: string;
  vatNumber: string;
  address: { street: string; number: string; details: string; postalCode: string; city: string; country: string };
  contacts: HandoffContact[];
  products: HandoffProduct[];
}

interface Props {
  prefill: HandoffPrefill;
  catalog: Product[];             // full products with calculator + tiers
  /** "create" = brand-new client (scenario A). "attach" = existing client buying new products (scenario C). */
  mode?: "create" | "attach";
  /** The day the deal was won: every product's signing date starts there. */
  signingDefault?: string;
  /** Opened when the deal was won: only the client is set up, nothing is sent to management yet. */
  standalone?: boolean;
  /** The deal's services, shown on the contract (their calculator edits the deal's lines). */
  services?: ContractPanelLine[];
  onServiceChange?: (key: string, patch: TermPatch) => void;
  /** The contract already saved on the deal, if any. */
  contractInitial?: ContractTerms | null;
  /** The contract column isn't there yet (27_deal_contracts.sql). */
  contractMissing?: boolean;
  dealName?: string;
  onClose: () => void;
  onConfirm: (data: {
    client: { name: string; legalName: string; vatNumber: string; address: HandoffPrefill["address"]; contacts: HandoffContact[] };
    products: HandoffProduct[];
    /** attach mode only: whether the user chose to revise the client's stored details. */
    reviseDetails: boolean;
    /** The contract as set in the contract step. */
    contract: ContractTerms;
  }) => Promise<void> | void;
}

const uid = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()));
const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const money = (n: number) => `${eur(n)} €`;
const moneyEn = money;

/* section icons */
const IconCompany = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01" /></svg>;
const IconAddress = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>;
const IconContacts = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="3.5" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
const IconProducts = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7" /><path d="M12 11v10" /></svg>;

export default function HandoffClientForm({ prefill, catalog, mode = "create", signingDefault, standalone = false, services = [], onServiceChange, contractInitial, contractMissing, dealName, onClose, onConfirm }: Props) {
  const attach = mode === "attach";
  // attach mode opens on a "revise or reuse" gate; create mode goes straight to the form.
  const [gate, setGateS] = useState<"prompt" | "revise" | "reuse">(attach ? "prompt" : "revise");
  // Two steps: the client, then its contract (a panel of its own).
  const [step, setStep] = useState<"client" | "contract">("client");
  const setGate = (g: "prompt" | "revise" | "reuse") => { setGateS(g); if (g === "reuse") setStep("contract"); };
  const [name, setName] = useState(prefill.name);
  const [legalName, setLegalName] = useState(prefill.legalName);
  const [vat, setVat] = useState(prefill.vatNumber);
  const [addr, setAddr] = useState(prefill.address);
  const [contacts, setContacts] = useState<HandoffContact[]>(prefill.contacts);
  const [products, setProducts] = useState<HandoffProduct[]>(() =>
    signingDefault ? prefill.products.map((p) => ({ ...p, signingDate: signingDefault })) : prefill.products);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [calcFor, setCalcFor] = useState<string | null>(null);        // which product's calculator is open
  const today = new Date().toISOString().slice(0, 10);

  const productById = useMemo(() => Object.fromEntries(catalog.map((p) => [p.id!, p])), [catalog]);

  const setAddrField = (k: keyof HandoffPrefill["address"], v: string) => setAddr((a) => ({ ...a, [k]: v }));
  const setContact = (id: string, patch: Partial<HandoffContact>) => setContacts((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const addContact = () => setContacts((cs) => [...cs, { id: uid(), name: "", position: "", email: "", phone: "", billing: false }]);
  const removeContact = (id: string) => setContacts((cs) => cs.filter((c) => c.id !== id));

  const setProduct = (key: string, patch: Partial<HandoffProduct>) => setProducts((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const removeProduct = (key: string) => setProducts((ps) => ps.filter((p) => p.key !== key));
  const addFromCatalog = (c: Product) => {
    setProducts((ps) => [...ps, {
      key: uid(), productId: c.id!, name: c.name, price: 0, quantity: 1,
      recurring: c.billing === "recurring", period: c.billing_period ?? (c.billing === "recurring" ? "yearly" : null),
      termYears: c.billing === "recurring" ? catalogYears(c) : null, discountMode: null, discountValue: null,
      increments: c.billing === "recurring" ? catalogIncrements(c) : null,
      tierId: null, calcValues: {}, calcDiscounts: {}, calcRates: {},
      signingDate: signingDefault || today, fromTracking: false,
    }]);
    setAdding(false);
  };

  // Turn a handoff product into the calculator's RevenueLineFields shape.
  const lineOf = (p: HandoffProduct): RevenueLineFields => ({
    price: p.price, quantity: p.quantity, recurring: p.recurring, period: p.period as any,
    term_years: p.termYears, tier_id: p.tierId ?? null,
    calc_values: p.calcValues ?? {}, calc_discounts: p.calcDiscounts ?? {}, calc_rates: p.calcRates ?? {},
    discount_mode: p.discountMode as any, discount_value: p.discountValue ?? 0,
    increments: p.increments ?? null,
  });
  const bdOf = (p: HandoffProduct) => lineBreakdown(lineOf(p), productById[p.productId]?.calculator ?? null, productById[p.productId]?.tiers?.find((t) => t.id === p.tierId)?.price);

  // When the calculator modal applies, fold its patch back into the product.
  const applyCalc = (key: string, patch: TermPatch) => {
    setProduct(key, {
      price: (patch as any).price ?? undefined,
      quantity: (patch as any).quantity ?? undefined,
      termYears: (patch as any).term_years ?? undefined,
      tierId: (patch as any).tier_id ?? null,
      calcValues: (patch as any).calc_values ?? {},
      calcDiscounts: (patch as any).calc_discounts ?? {},
      calcRates: (patch as any).calc_rates ?? {},
      discountMode: (patch as any).discount_mode ?? null,
      discountValue: (patch as any).discount_value ?? 0,
      ...("increments" in patch ? { increments: patch.increments ?? null } : {}),
    });
    setCalcFor(null);
  };
  /** A change made on the contract (calculator, term, yearly increase) — only the fields it carries. */
  const patchFromContract = (key: string, patch: TermPatch) => {
    const p: Partial<HandoffProduct> = {};
    if ("price" in patch) p.price = Number(patch.price) || 0;
    if ("quantity" in patch) p.quantity = Number(patch.quantity) || 1;
    if ("term_years" in patch) p.termYears = patch.term_years ?? null;
    if ("tier_id" in patch) p.tierId = patch.tier_id ?? null;
    if ("calc_values" in patch) p.calcValues = patch.calc_values ?? {};
    if ("calc_discounts" in patch) p.calcDiscounts = patch.calc_discounts ?? {};
    if ("calc_rates" in patch) p.calcRates = patch.calc_rates ?? {};
    if ("discount_mode" in patch) p.discountMode = patch.discount_mode ?? null;
    if ("discount_value" in patch) p.discountValue = patch.discount_value ?? 0;
    if ("increments" in patch) p.increments = patch.increments ?? null;
    setProduct(key, p);
  };

  const stillAddable = useMemo(() => catalog.filter((c) => !products.some((p) => p.productId === c.id)), [catalog, products]);
  const productsValue = products.reduce((s, p) => s + bdOf(p).total, 0);
  // A services-only deal still gets its client; products, when there are any, need their signing date.
  const canSave = name.trim().length > 0 && (products.length > 0 || standalone || services.length > 0);
  const clientReady = name.trim().length > 0;
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const confirm = async (terms: ContractTerms) => {
    if (!canSave || saving) return;
    setSaving(true); setSaveErr(null);
    try {
      // Every product signs on the contract's day and follows its terms (a product's own value wins).
      const signed = products.map((p): HandoffProduct => {
        const years = Number(p.termYears) || 1;
        const bd = bdOf(p);
        const first = bd.years[0] ?? 0;
        return {
          ...p,
          // The client signs the FINAL price: calculator rows, tier price as changed on the deal and
          // every discount already applied (per period for subscriptions, per unit otherwise).
          price: Math.round(bd.unitPrice * 100) / 100,
          quantity: p.recurring ? 1 : bd.qty,
          discountMode: "none", discountValue: 0,
          breakdown: {
            version: null, multiplier: bd.multiplierLabel, gross: bd.gross, discount: bd.discount, total: bd.total,
            rows: bd.rows.map((r) => ({ label: r.label, detail: r.detail, amount: r.amount, discount: r.discount })),
            years: bd.years,
          },
          signingDate: terms.signDate || p.signingDate || today,
          startDate: terms.contractStart || p.startDate || terms.signDate || p.signingDate,
          paymentTermsDays: p.paymentTermsDays ?? terms.paymentTermsDays ?? null,
          nonTerminableYears: p.nonTerminableYears ?? terms.nonTerminableYears ?? null,
          autoRenew: p.recurring ? (terms.autoRenew ?? p.autoRenew ?? false) : false,
          renewYears: p.recurring && terms.autoRenew ? (terms.renewYears ?? p.renewYears ?? years) : p.renewYears ?? null,
          annualIncreasePct: p.increments?.mode === "pct" ? Number(p.increments.value) || 0 : p.annualIncreasePct ?? null,
          contractRef: p.contractRef || terms.contractRef || undefined,
          schedule: p.recurring ? incrementsToSchedule(first, years, p.increments) : null,
        };
      });
      await onConfirm({
        client: { name: name.trim(), legalName, vatNumber: vat, address: addr, contacts },
        products: signed,
        reviseDetails: gate === "revise",
        contract: terms,
      });
    } catch (e: any) {
      setSaveErr(e?.message ?? String(e));
    } finally { setSaving(false); }
  };

  const calcProduct = calcFor ? products.find((p) => p.key === calcFor) : null;
  const steps = [
    { label: "Client", on: step === "client", done: step === "contract" },
    { label: "Contract", on: step === "contract" },
    ...(standalone ? [] : [{ label: "Handoff" }]),
  ];
  const finalLabel = standalone ? (attach ? "Add products to client" : "Create client") : (attach ? "Attach & continue" : "Create & continue");

  // The products, as lines of the contract.
  const contractLines: ContractPanelLine[] = [
    ...products.map((p): ContractPanelLine => ({
      key: p.key, kind: "product", name: p.name, line: lineOf(p),
      calculator: productById[p.productId]?.calculator ?? null,
      tiers: (productById[p.productId]?.tiers ?? []).map((t) => ({ id: t.id, name: t.name, price: t.price })),
      defaultIncrements: catalogIncrements(productById[p.productId]),
      tag: p.fromTracking ? "From deal" : "Added",
    })),
    ...services,
  ];
  const isService = (key: string) => services.some((x) => x.key === key);

  /** A product's own contract details (fees, who is billed, references). */
  const productExtra = (key: string) => {
    const p = products.find((x) => x.key === key);
    if (!p) return null;
    return (
      <div className="hc-contract dct-extra">
        <div className="hc-cgroup">
          <span className="hc-cgroup-t">Fees & billing</span>
          <div className="hc-crow">
            <label>One-time fee</label>
            <div className="hc-cval"><input type="number" min={0} value={p.oneTimeFee ?? ""} placeholder="0" onChange={(e) => setProduct(p.key, { oneTimeFee: e.target.value === "" ? undefined : Number(e.target.value) })} /><em>€</em></div>
          </div>
          <div className="hc-crow">
            <label>Payment terms</label>
            <div className="hc-cval"><input type="number" min={0} value={p.paymentTermsDays ?? ""} placeholder="—" onChange={(e) => setProduct(p.key, { paymentTermsDays: e.target.value === "" ? null : Number(e.target.value) })} /><em>net days</em></div>
          </div>
          <div className="hc-crow hc-crow-billto">
            <label>Bill to</label>
            <div className="hc-billto-sel">
              <Select
                value={p.billingContactId ?? ""}
                onChange={(v) => setProduct(p.key, { billingContactId: v || null })}
                placeholder="Choose contact"
                options={contacts.filter((c) => (c.name || "").trim()).map((c) => ({ value: c.id, label: c.position ? `${c.name} · ${c.position}` : c.name }))}
              />
            </div>
          </div>
        </div>
        <div className="hc-cgroup">
          <span className="hc-cgroup-t">This product</span>
          <div className="hc-crow">
            <label>Service start</label>
            <DatePicker value={p.startDate ?? ""} onChange={(iso) => setProduct(p.key, { startDate: iso })} placeholder="Contract start" />
          </div>
          {p.recurring && (
            <div className="hc-crow">
              <label>Non-terminable</label>
              <div className="hc-cval"><input type="number" min={0} value={p.nonTerminableYears ?? ""} placeholder="—" onChange={(e) => setProduct(p.key, { nonTerminableYears: e.target.value === "" ? null : Number(e.target.value) })} /><em>years</em></div>
            </div>
          )}
        </div>
        <div className="hc-cgroup">
          <span className="hc-cgroup-t">References</span>
          <div className="hc-crow">
            <label>Contract ref.</label>
            <div className="hc-cval"><input value={p.contractRef ?? ""} placeholder="—" onChange={(e) => setProduct(p.key, { contractRef: e.target.value })} /></div>
          </div>
          <div className="hc-crow">
            <label>External ref.</label>
            <div className="hc-cval"><input value={p.externalRef ?? ""} placeholder="—" onChange={(e) => setProduct(p.key, { externalRef: e.target.value })} /></div>
          </div>
        </div>
      </div>
    );
  };

  if (step === "contract") {
    return (
      <ContractPanel
        dealName={name || dealName || "New client"}
        eyebrow={standalone ? (attach ? "Deal won · new products" : "Deal won · contract") : (attach ? "Handoff · new products" : "Handoff · contract")}
        lines={contractLines}
        initial={contractInitial}
        signDefault={signingDefault || today}
        missing={contractMissing}
        steps={steps}
        onLineChange={(key, patch) => (isService(key) ? onServiceChange?.(key, patch) : patchFromContract(key, patch))}
        onRemoveLine={(key) => { if (!isService(key)) removeProduct(key); }}
        renderExtra={(key) => (isService(key) ? null : productExtra(key))}
        addSlot={stillAddable.length > 0 ? (
          <div className="hc-addprod">
            {!adding ? (
              <button className="hc-addprod-btn" onClick={() => setAdding(true)}>+ Add product from catalogue</button>
            ) : (
              <div className="hc-addprod-menu">
                {stillAddable.map((c) => (
                  <button key={c.id} className="hc-addprod-opt" onClick={() => addFromCatalog(c)}>{c.name}</button>
                ))}
                <button className="hc-addprod-cancel" onClick={() => setAdding(false)}>Cancel</button>
              </div>
            )}
          </div>
        ) : null}
        primaryLabel={finalLabel}
        busy={saving}
        canSave={canSave}
        error={saveErr}
        onBack={attach && gate === "reuse" ? () => { setGateS("prompt"); setStep("client"); } : () => setStep("client")}
        backLabel="Client"
        onSave={confirm}
        onClose={onClose}
      />
    );
  }

  return createPortal(
    <>
    <div className="hc-backdrop" onMouseDown={onClose}>
      <div className="hc" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {attach && gate === "prompt" && (
          <div className="hc-gate">
            <div className="hc-gate-card">
              <button className="hc-gate-x" onClick={onClose} aria-label="Close">×</button>
              <span className="hc-gate-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              </span>
              <h3 className="hc-gate-title">{name || "This client"} is already in management</h3>
              <p className="hc-gate-sub">You're handing off <b>new products</b> for an existing client. Revise the details we have on file, or reuse them as-is and go straight to the contract.</p>
              <div className="hc-gate-actions">
                <button className="hc-gate-ghost" onClick={() => setGate("revise")}>Revise details</button>
                <button className="hc-gate-primary" onClick={() => setGate("reuse")}>Reuse existing</button>
              </div>
            </div>
          </div>
        )}
        {/* header: title + steps + next + close */}
        <header className="hc-head">
          <span className="hc-head-glow" aria-hidden="true" />
          <div className="hc-head-txt">
            <span className="hc-eyebrow">{standalone ? (attach ? "Deal won · client details" : "Deal won · create client") : attach ? "Handoff · client details" : "Handoff · create client"}</span>
            <h2 className="hc-title">{name || "New client"}</h2>
          </div>
          <ol className="dct-steps is-hc">
            {steps.map((s2, i) => <li key={i} className={`${s2.on ? "is-on" : ""} ${s2.done ? "is-done" : ""}`}><i>{i + 1}</i>{s2.label}</li>)}
          </ol>
          <div className="hc-head-right">
            <div className="hc-head-total">
              <span>{attach ? "New products" : "Signed products"}</span>
              <b>{money(productsValue)}</b>
            </div>
            <button className="hc-btn-primary" disabled={!clientReady} onClick={() => setStep("contract")}>
              Next: contract →
            </button>
            <button className="hc-x" onClick={onClose} aria-label="Close">×</button>
          </div>
        </header>

        <div className="hc-body">
          <div className="hc-col hc-col-left">
            <section className="hc-sec">
              <h3 className="hc-sec-title"><span className="hc-icon"><IconCompany /></span>Company</h3>
              <div className="hc-grid">
                <label className="hc-field hc-col-2"><input value={name} onChange={(e) => setName(e.target.value)} placeholder=" " /><span>Client name</span></label>
                <label className="hc-field hc-col-2"><input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder=" " /><span>Legal name</span></label>
                <label className="hc-field"><input value={vat} onChange={(e) => setVat(e.target.value)} placeholder=" " /><span>VAT / Tax ID</span></label>
              </div>
            </section>

            <section className="hc-sec">
              <h3 className="hc-sec-title"><span className="hc-icon"><IconAddress /></span>Address</h3>
              <div className="hc-grid">
                <label className="hc-field hc-col-2"><input value={addr.street} onChange={(e) => setAddrField("street", e.target.value)} placeholder=" " /><span>Street</span></label>
                <label className="hc-field"><input value={addr.number} onChange={(e) => setAddrField("number", e.target.value)} placeholder=" " /><span>Number</span></label>
                <label className="hc-field"><input value={addr.details} onChange={(e) => setAddrField("details", e.target.value)} placeholder=" " /><span>Details</span></label>
                <label className="hc-field"><input value={addr.postalCode} onChange={(e) => setAddrField("postalCode", e.target.value)} placeholder=" " /><span>Postal code</span></label>
                <label className="hc-field"><input value={addr.city} onChange={(e) => setAddrField("city", e.target.value)} placeholder=" " /><span>City</span></label>
                <label className="hc-field"><input value={addr.country} onChange={(e) => setAddrField("country", e.target.value)} placeholder=" " /><span>Country</span></label>
              </div>
            </section>
          </div>

          <div className="hc-col hc-col-right">
            <section className="hc-sec">
              <h3 className="hc-sec-title"><span className="hc-icon"><IconContacts /></span>Contacts <i className="hc-count">{contacts.length}</i></h3>
              <div className="hc-contacts">
                {contacts.map((c) => (
                  <div className="hc-contact" key={c.id}>
                    <span className="hc-contact-av">{(c.name || "?").charAt(0).toUpperCase()}</span>
                    <div className="hc-contact-fields">
                      <input className="hc-contact-name" value={c.name} onChange={(e) => setContact(c.id, { name: e.target.value })} placeholder="Full name" />
                      <input value={c.position} onChange={(e) => setContact(c.id, { position: e.target.value })} placeholder="Position" />
                      <input value={c.email} onChange={(e) => setContact(c.id, { email: e.target.value })} placeholder="Email" />
                      <input value={c.phone} onChange={(e) => setContact(c.id, { phone: e.target.value })} placeholder="Phone" />
                    </div>
                    <button className={`hc-billing ${c.billing ? "is-on" : ""}`} onClick={() => setContact(c.id, { billing: !c.billing })} title="Billing contact">€</button>
                    <button className="hc-contact-del" onClick={() => removeContact(c.id)} aria-label="Remove">×</button>
                  </div>
                ))}
                <button className="hc-add-contact" onClick={addContact}>+ Add contact</button>
              </div>
            </section>

            <div className="hc-next-hint">
              <span className="hc-icon"><IconProducts /></span>
              <p><b>Next: the contract</b>{products.length ? ` — ${products.length} ${products.length === 1 ? "product" : "products"} from the deal` : ""}{services.length ? `${products.length ? " and" : " —"} ${services.length} ${services.length === 1 ? "service" : "services"}` : ""}. Set the sign date, contract start, term, yearly increases and final prices there.</p>
            </div>
          </div>
        </div>
      </div>
    </div>

      {/* editable calculator — sibling of the backdrop so closing it doesn't
          bubble a mousedown into the handoff's own onClose */}
      {calcProduct && (
        <LineCalcModal
          title={calcProduct.name}
          line={lineOf(calcProduct)}
          tiers={(productById[calcProduct.productId]?.tiers ?? []).map((t) => ({ id: t.id, name: t.name, price: t.price }))}
          calculator={productById[calcProduct.productId]?.calculator ?? null}
          defaultIncrements={catalogIncrements(productById[calcProduct.productId])}
          unit={null}
          money={money}
          onApply={(patch) => applyCalc(calcProduct.key, patch)}
          onClose={() => setCalcFor(null)}
        />
      )}
    </>,
    document.body);
}

/* =====================================================================
   Contract panel — the contract of a won deal, on its own.
   Dates (signed / starts), term, yearly increases, every line with its
   calculator, and the final licence and services prices year by year.
   Used after the client step (won deal, handoff) and from the deal itself.
   ===================================================================== */
export interface ContractPanelLine {
  key: string;
  kind: "product" | "service";
  name: string;
  line: RevenueLineFields;
  calculator?: Calculator | null;
  catalogBase?: number;
  minUnit?: number | null;
  tiers?: { id?: string; name: string; price: number }[];
  roles?: { role_id: string; price: number }[];
  roleName?: (id: string) => string;
  unit?: "hour" | "day" | null;
  /** "From deal" / "Added" etc. */
  tag?: string;
  /** The catalogue item (for the partner section of the calculator). */
  partnerItem?: { type: "product" | "service"; id: string | null };
  /** The catalogue product's yearly increase (default when the line has none). */
  defaultIncrements?: LineIncrements | null;
}

const IconCal = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4.5" width="18" height="16.5" rx="3" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" /></svg>;
const IconTrend = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>;
const IconService = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" /></svg>;
const IconCalc = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h4" /></svg>;
const IconDoc = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></svg>;

/** A number that eases to its new value. */
function Tween({ v, fmt }: { v: number; fmt: (n: number) => string }) {
  const [shown, setShown] = useState(v);
  const from = useRef(v);
  useEffect(() => {
    const a = from.current, b = v;
    if (a === b) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setShown(b); from.current = b; return; }
    const t0 = performance.now(); let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 420); const e = 1 - Math.pow(1 - k, 3);
      const x = a + (b - a) * e; setShown(x); from.current = x;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [v]);
  return <>{fmt(shown)}</>;
}

export function ContractPanel({
  dealName, eyebrow, lines, initial, signDefault, onLineChange, onRemoveLine, renderExtra, addSlot,
  primaryLabel, busy, canSave = true, error, onBack, backLabel = "Back", onSave, onClose, steps, missing, money: fmtMoney,
}: {
  dealName: string;
  eyebrow?: string;
  lines: ContractPanelLine[];
  initial?: ContractTerms | null;
  /** The day the deal was won: the signing date unless changed. */
  signDefault: string;
  onLineChange: (key: string, patch: TermPatch) => void;
  onRemoveLine?: (key: string) => void;
  /** Per-line contract details (fees, renewal, references…). */
  renderExtra?: (key: string) => ReactNode;
  addSlot?: ReactNode;
  primaryLabel: string;
  busy?: boolean;
  canSave?: boolean;
  error?: string | null;
  onBack?: () => void;
  backLabel?: string;
  onSave: (terms: ContractTerms) => void | Promise<void>;
  onClose: () => void;
  steps?: { label: string; on?: boolean; done?: boolean }[];
  /** The contract column isn't in the database yet. */
  missing?: boolean;
  /** How amounts are written (the page's own format). */
  money?: (n: number) => string;
}) {
  const money = fmtMoney ?? moneyEn;
  const recurring = lines.filter((l) => l.kind === "product" && l.line.recurring);
  const termFromLines = Math.max(1, ...recurring.map((l) => Number(l.line.term_years) || 1));
  const [signDate, setSignDate] = useState<string>(initial?.signDate || signDefault);
  const [contractStart, setContractStart] = useState<string>(initial?.contractStart || "");
  const [term, setTerm] = useState<number>(() => (recurring.length ? termFromLines : Number(initial?.termYears) || 1));
  const [payDays, setPayDays] = useState<number | null>(initial?.paymentTermsDays ?? null);
  const [autoRenew, setAutoRenew] = useState<boolean>(!!initial?.autoRenew);
  const [renewYears, setRenewYears] = useState<number | null>(initial?.renewYears ?? null);
  const [nonTerm, setNonTerm] = useState<number | null>(initial?.nonTerminableYears ?? null);
  const [ref, setRef] = useState<string>(initial?.contractRef ?? "");
  const [notes, setNotes] = useState<string>(initial?.notes ?? "");
  const [inc, setInc] = useState<LineIncrements>(() => {
    if (initial?.increments?.mode) return initial.increments;
    const own = recurring.map((l) => l.line.increments).filter((x) => hasIncrements(x));
    return own.length === recurring.length && own.length > 0 && own.every((x) => JSON.stringify(x) === JSON.stringify(own[0])) ? own[0]! : { ...EMPTY_INCREMENTS };
  });
  const [calcKey, setCalcKey] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const mixed = recurring.length > 1 && new Set(recurring.map((l) => JSON.stringify(hasIncrements(l.line.increments) ? l.line.increments : null))).size > 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !calcKey) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, calcKey]);

  const bds = lines.map((l) => ({ l, bd: lineBreakdown(l.line, l.calculator ?? null, l.catalogBase, l.minUnit) }));
  const fig = contractFigures(bds.map(({ l, bd }) => ({ id: l.key, kind: l.kind, name: l.name, bd })));
  const firstYearRec = bds.filter(({ l }) => l.kind === "product" && l.line.recurring).reduce((a, { bd }) => a + (bd.years[0] ?? 0), 0);

  /** The contract's yearly increase, spread over its recurring products. */
  const applyInc = (next: LineIncrements) => {
    setInc(next);
    if (!recurring.length) return;
    if (!hasIncrements(next)) { recurring.forEach((l) => onLineChange(l.key, { increments: null })); return; }
    if (recurring.length === 1 || next.mode === "pct") { recurring.forEach((l) => onLineChange(l.key, { increments: next })); return; }
    // € a year or each year typed: the same growth for every product, in proportion to its size.
    const totals = yearAmounts(firstYearRec, Math.ceil(term), next);
    bds.filter(({ l }) => l.kind === "product" && l.line.recurring).forEach(({ l, bd }) => {
      const y0 = bd.years[0] ?? 0;
      const perYear = totals.map((t) => (totals[0] ? Math.round((y0 * t) / totals[0] * 100) / 100 : y0));
      onLineChange(l.key, { increments: { mode: "custom", value: 0, perYear } });
    });
  };
  const applyTerm = (n: number) => {
    const v = Math.max(1, Math.round(n * 2) / 2);
    setTerm(v);
    recurring.forEach((l) => onLineChange(l.key, { term_years: v }));
  };

  const save = () => {
    if (busy || !canSave) return;
    const terms: ContractTerms = {
      signDate: signDate || null, contractStart: contractStart || null,
      termYears: recurring.length ? term : Number(initial?.termYears) || term,
      increments: inc, paymentTermsDays: payDays, autoRenew, renewYears: autoRenew ? renewYears : null,
      nonTerminableYears: nonTerm, contractRef: ref.trim() || null, notes: notes.trim() || null,
      ...fig,
    };
    onSave(terms);
  };

  const calcLine = calcKey ? lines.find((l) => l.key === calcKey) : null;
  const maxYear = Math.max(1, ...fig.schedule.map((y) => y.total));
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const products = bds.filter(({ l }) => l.kind === "product");
  const services = bds.filter(({ l }) => l.kind === "service");
  const lineCard = ({ l, bd }: { l: ContractPanelLine; bd: ReturnType<typeof lineBreakdown> }, i: number) => {
    const isOpen = open.has(l.key);
    const per = l.line.period === "monthly" ? "/mo" : "/yr";
    return (
      <div key={l.key} className={`dct-line is-${l.kind} ${isOpen ? "is-open" : ""}`} style={{ ["--i" as any]: i }}>
        <div className="dct-line-row">
          <span className="dct-line-ico">{l.kind === "product" ? <IconProducts /> : <IconService />}</span>
          <div className="dct-line-id">
            <b>{l.name}</b>
            <small>
              {l.tag && <i className="dct-tag">{l.tag}</i>}
              {l.kind === "product"
                ? (l.line.recurring ? `${money(bd.unitPrice)} ${per} · ${Number(l.line.term_years) || 1} ${(Number(l.line.term_years) || 1) === 1 ? "year" : "years"}` : `One-off · ${bd.qty} ${bd.qty === 1 ? "unit" : "units"}`)
                : `Fixed fee · ${bd.qty} ${l.unit === "hour" ? "hours" : "days"}`}
              {l.kind === "product" && hasIncrements(l.line.increments) && Number(l.line.term_years) > 1 && <i className="dct-tag is-inc">+ yearly increase</i>}
            </small>
          </div>
          <div className="dct-line-money">
            {bd.discount > 0 && <s>{money(bd.gross)}</s>}
            <b>{money(bd.total)}</b>
            {bd.discount > 0 && <em>−{money(bd.discount)}</em>}
          </div>
          <button type="button" className="dct-ibtn" onClick={() => setCalcKey(l.key)} title="Open the calculator"><IconCalc /></button>
          {renderExtra && (
            <button type="button" className={`dct-ibtn ${isOpen ? "is-on" : ""}`} onClick={() => toggle(l.key)} title="Contract details">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          )}
          {onRemoveLine && <button type="button" className="dct-ibtn is-del" onClick={() => onRemoveLine(l.key)} aria-label="Remove">×</button>}
        </div>
        {l.kind === "product" && l.line.recurring && bd.years.length > 1 && (
          <div className="dct-line-years">
            {bd.years.map((a, yi) => <span key={yi}><i>Y{yi + 1}</i>{money(a)}</span>)}
          </div>
        )}
        {isOpen && renderExtra && <div className="dct-line-extra">{renderExtra(l.key)}</div>}
      </div>
    );
  };

  return createPortal(
    <>
      <div className="dct-backdrop" onMouseDown={onClose}>
        <div className="dct" role="dialog" aria-modal="true" aria-label="Contract" onMouseDown={(e) => e.stopPropagation()}>
          <header className="dct-head">
            <span className="dct-head-glow" aria-hidden="true" />
            <div className="dct-head-txt">
              <span className="dct-eyebrow">{eyebrow ?? "Deal won · contract"}</span>
              <h2 className="dct-title"><IconDoc />Contract <em>· {dealName}</em></h2>
            </div>
            {steps && steps.length > 0 && (
              <ol className="dct-steps">
                {steps.map((s, i) => <li key={i} className={`${s.on ? "is-on" : ""} ${s.done ? "is-done" : ""}`}><i>{s.done ? "✓" : i + 1}</i>{s.label}</li>)}
              </ol>
            )}
            <button type="button" className="dct-x" onClick={onClose} aria-label="Close">×</button>
          </header>

          <div className="dct-body">
            <div className="dct-form">
              {missing && <p className="dct-warn">Run <b>27_deal_contracts.sql</b> in Supabase to keep the contract on the deal. Everything else still works.</p>}
              <section className="dct-sec">
                <h3 className="dct-sec-t"><span className="dct-ico"><IconCal /></span>Dates & term</h3>
                <div className="dct-dates">
                  <div className="dct-date">
                    <span>Sign date</span>
                    <DatePicker value={signDate} onChange={(v) => setSignDate(v)} placeholder="Pick a day" />
                    <small>{signDate === signDefault ? "The day the deal was won" : <button type="button" className="dct-link" onClick={() => setSignDate(signDefault)}>Use the won date</button>}</small>
                  </div>
                  <div className="dct-date">
                    <span>Contract start <em>optional</em></span>
                    <DatePicker value={contractStart} onChange={(v) => setContractStart(v)} placeholder="Same as signed" />
                    <small>{contractStart ? <button type="button" className="dct-link" onClick={() => setContractStart("")}>Same as the sign date</button> : "Starts the day it's signed"}</small>
                  </div>
                  <div className="dct-date">
                    <span>Term</span>
                    <div className="dct-step">
                      <button type="button" onClick={() => applyTerm(term - 1)} disabled={term <= 1} aria-label="Shorter">−</button>
                      <b>{term}</b><em>{term === 1 ? "year" : "years"}</em>
                      <button type="button" onClick={() => applyTerm(term + 1)} aria-label="Longer">+</button>
                    </div>
                    <small>{recurring.length ? `Applies to ${recurring.length === 1 ? "the subscription" : `all ${recurring.length} subscriptions`}` : "No subscriptions on this contract"}</small>
                  </div>
                </div>
                <div className="dct-terms">
                  <label className="dct-mini"><span>Payment</span><input type="number" min={0} value={payDays ?? ""} placeholder="30" onChange={(e) => setPayDays(e.target.value === "" ? null : Number(e.target.value))} /><em>days</em></label>
                  <label className="dct-mini"><span>Non-terminable</span><input type="number" min={0} value={nonTerm ?? ""} placeholder="0" onChange={(e) => setNonTerm(e.target.value === "" ? null : Number(e.target.value))} /><em>years</em></label>
                  <div className="dct-mini is-toggle">
                    <span>Auto-renew</span>
                    <button type="button" className={`hc-toggle ${autoRenew ? "is-on" : ""}`} onClick={() => setAutoRenew((v) => !v)} aria-pressed={autoRenew}><span className="hc-toggle-knob" /></button>
                    {autoRenew && <><input type="number" min={0} value={renewYears ?? ""} placeholder={String(term)} onChange={(e) => setRenewYears(e.target.value === "" ? null : Number(e.target.value))} /><em>years</em></>}
                  </div>
                  <label className="dct-mini is-wide"><span>Contract ref.</span><input value={ref} placeholder="—" onChange={(e) => setRef(e.target.value)} /></label>
                </div>
              </section>

              <section className="dct-sec">
                <h3 className="dct-sec-t"><span className="dct-ico"><IconTrend /></span>Yearly increase
                  {mixed && <i className="dct-note">Each product has its own — choosing one here sets them all</i>}
                </h3>
                {recurring.length
                  ? <IncrementsEditor value={inc} onChange={applyInc} firstYear={firstYearRec} years={term} money={money} />
                  : <p className="dct-empty">Only subscriptions go up year after year. This contract has none.</p>}
              </section>

              <section className="dct-sec">
                <h3 className="dct-sec-t"><span className="dct-ico"><IconProducts /></span>Licences <i className="hc-count">{products.length}</i></h3>
                {products.length === 0 && <p className="dct-empty">No products on this contract.</p>}
                <div className="dct-lines">{products.map(lineCard)}</div>
                {addSlot}
              </section>

              {services.length > 0 && (
                <section className="dct-sec">
                  <h3 className="dct-sec-t"><span className="dct-ico"><IconService /></span>Services <i className="hc-count">{services.length}</i></h3>
                  <div className="dct-lines">{services.map(lineCard)}</div>
                </section>
              )}

              <section className="dct-sec">
                <h3 className="dct-sec-t"><span className="dct-ico"><IconDoc /></span>Notes</h3>
                <textarea className="dct-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything special agreed in this contract" rows={3} />
              </section>
            </div>

            <aside className="dct-sum">
              <div className="dct-final is-lic">
                <span className="dct-final-k">Final licence price</span>
                <b><Tween v={fig.license.final} fmt={money} /></b>
                <div className="dct-final-sub">
                  <span>Year 1 <b>{money(fig.license.firstYear)}</b></span>
                  {fig.license.discount > 0 && <span>List <s>{money(fig.license.list)}</s> <em>−{money(fig.license.discount)}</em></span>}
                </div>
              </div>
              <div className="dct-final is-svc">
                <span className="dct-final-k">Final services price</span>
                <b><Tween v={fig.services.final} fmt={money} /></b>
                <div className="dct-final-sub">
                  <span>Fixed fee, billed once</span>
                  {fig.services.discount > 0 && <span>List <s>{money(fig.services.list)}</s> <em>−{money(fig.services.discount)}</em></span>}
                </div>
              </div>

              <div className="dct-years">
                <div className="dct-years-h"><span>Year by year</span><i className="is-lic">Licence</i><i className="is-svc">Services</i></div>
                {fig.schedule.map((y) => (
                  <div className="dct-year" key={y.year} style={{ ["--i" as any]: y.year }}>
                    <span className="dct-year-k">Year {y.year}</span>
                    <span className="dct-year-bar" aria-hidden="true">
                      <i className="is-lic" style={{ width: `${(y.license / maxYear) * 100}%` }} />
                      <i className="is-svc" style={{ width: `${(y.services / maxYear) * 100}%` }} />
                    </span>
                    <b>{money(y.total)}</b>
                  </div>
                ))}
              </div>

              <div className="dct-total">
                <span>Contract total</span>
                <b><Tween v={fig.total} fmt={money} /></b>
                <small>{recurring.length ? `${term} ${term === 1 ? "year" : "years"}` : "One-off"}{signDate ? ` · signed ${new Date(`${signDate}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}</small>
              </div>

              {error && <p className="dct-err">{error}</p>}
              <div className="dct-actions">
                {onBack ? <button type="button" className="hc-btn-ghost" onClick={onBack}>← {backLabel}</button> : <button type="button" className="hc-btn-ghost" onClick={onClose}>Cancel</button>}
                <button type="button" className="hc-btn-primary" disabled={!canSave || !!busy} onClick={save}>{busy ? "Saving…" : primaryLabel}</button>
              </div>
            </aside>
          </div>
        </div>
      </div>
      {calcLine && (
        <LineCalcModal
          title={calcLine.name}
          line={calcLine.line}
          tiers={calcLine.tiers}
          roles={calcLine.roles}
          roleName={calcLine.roleName}
          calculator={calcLine.calculator ?? null}
          unit={calcLine.kind === "service" ? (calcLine.unit ?? "day") : null}
          minUnit={calcLine.minUnit}
          money={money}
          partnerItem={calcLine.partnerItem}
          defaultIncrements={calcLine.defaultIncrements}
          onApply={(patch) => onLineChange(calcLine.key, patch)}
          onClose={() => setCalcKey(null)}
        />
      )}
    </>,
    document.body);
}

/* =====================================================================
   Settings › Deals page: which potential revenue every deal shows
   ===================================================================== */
export function RevenueModeSetting({ canEdit }: { canEdit: boolean }) {
  const [team, setTeam] = useState<RevenueMode>(teamRevenueModeNow());
  const [mine, setMine] = useState<RevenueMode | null>(localRevenueMode());
  const [busy, setBusy] = useState<RevenueMode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { loadRevenueMode(true).then(setTeam).catch(() => {}); }, []);
  const pick = async (m: RevenueMode) => {
    if (!canEdit || busy) return;
    setBusy(m); setErr(null); setSaved(false);
    const e = await saveRevenueMode(m);
    setBusy(null);
    if (e) { setErr(e); return; }
    setTeam(m); setSaved(true);
  };
  // A worked example: a 3-year licence at 10,000 a year (+5% a year) and 6,000 of services.
  const ex = (m: RevenueMode) => {
    const lic = [10000, 10500, 11025];
    const svc = 6000;
    return m === "product_year1" ? lic[0] : m === "product_term" ? lic.reduce((a, b) => a + b, 0) : m === "all_year1" ? lic[0] + svc : lic.reduce((a, b) => a + b, 0) + svc;
  };
  return (
    <div className="rvs">
      <p className="rvs-lead">Services are a one-off fee; licences can run for several years. Pick the figure a deal is worth everywhere — the list, the board, the forecast and the reports. Anyone can still switch their own view on the deal page.</p>
      <div className="rvs-grid">
        {REVENUE_MODES.map((m, i) => (
          <button type="button" key={m.value} className={`rvs-card ${team === m.value ? "is-on" : ""}`} disabled={!canEdit} onClick={() => void pick(m.value)} style={{ ["--i" as any]: i }}>
            <span className="rvs-dot" aria-hidden="true" />
            <b>{m.label}</b>
            <small>{m.hint}</small>
            <span className="rvs-ex"><i>Example</i>{money(ex(m.value))}</span>
            {busy === m.value && <em className="rvs-busy">Saving…</em>}
          </button>
        ))}
      </div>
      <p className="rvs-foot">
        Example: a 3-year licence at 10,000 € a year with +5% a year, plus 6,000 € of services.
        {mine && mine !== team && <> · Your own view is <b>{REVENUE_MODES.find((x) => x.value === mine)?.label}</b> — <button type="button" className="dct-link" onClick={() => { setLocalRevenueMode(null); setMine(null); }}>use the team's</button></>}
      </p>
      {!canEdit && <p className="rvs-foot">Only sales managers can change this.</p>}
      {saved && <p className="rvs-ok">Saved — every deal now shows this figure.</p>}
      {err && <p className="dct-err">{err}</p>}
    </div>
  );
}
