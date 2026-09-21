/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../framework/DatePicker";
import Select from "../../framework/Select";
import LineCalcModal from "../../framework/LineCalcModal";
import { lineBreakdown, type RevenueLineFields, type TermPatch } from "./salesApi";
import type { Product } from "../settings/catalogApi";
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
  onClose: () => void;
  onConfirm: (data: {
    client: { name: string; legalName: string; vatNumber: string; address: HandoffPrefill["address"]; contacts: HandoffContact[] };
    products: HandoffProduct[];
    /** attach mode only: whether the user chose to revise the client's stored details. */
    reviseDetails: boolean;
  }) => Promise<void> | void;
}

const uid = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()));
const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const money = (n: number) => `${eur(n)} €`;

/* section icons */
const IconCompany = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01" /></svg>;
const IconAddress = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>;
const IconContacts = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="3.5" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
const IconProducts = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7" /><path d="M12 11v10" /></svg>;

export default function HandoffClientForm({ prefill, catalog, mode = "create", onClose, onConfirm }: Props) {
  const attach = mode === "attach";
  // attach mode opens on a "revise or reuse" gate; create mode goes straight to the form.
  const [gate, setGate] = useState<"prompt" | "revise" | "reuse">(attach ? "prompt" : "revise");
  const [name, setName] = useState(prefill.name);
  const [legalName, setLegalName] = useState(prefill.legalName);
  const [vat, setVat] = useState(prefill.vatNumber);
  const [addr, setAddr] = useState(prefill.address);
  const [contacts, setContacts] = useState<HandoffContact[]>(prefill.contacts);
  const [products, setProducts] = useState<HandoffProduct[]>(prefill.products);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());   // contract drawer
  const [calcFor, setCalcFor] = useState<string | null>(null);        // which product's calculator is open
  const today = new Date().toISOString().slice(0, 10);

  const productById = useMemo(() => Object.fromEntries(catalog.map((p) => [p.id!, p])), [catalog]);

  const setAddrField = (k: keyof HandoffPrefill["address"], v: string) => setAddr((a) => ({ ...a, [k]: v }));
  const setContact = (id: string, patch: Partial<HandoffContact>) => setContacts((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const addContact = () => setContacts((cs) => [...cs, { id: uid(), name: "", position: "", email: "", phone: "", billing: false }]);
  const removeContact = (id: string) => setContacts((cs) => cs.filter((c) => c.id !== id));

  const setProduct = (key: string, patch: Partial<HandoffProduct>) => setProducts((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const removeProduct = (key: string) => setProducts((ps) => ps.filter((p) => p.key !== key));
  const toggleExpand = (key: string) => setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const addFromCatalog = (c: Product) => {
    setProducts((ps) => [...ps, {
      key: uid(), productId: c.id!, name: c.name, price: 0, quantity: 1,
      recurring: c.billing === "recurring", period: c.billing_period ?? (c.billing === "recurring" ? "yearly" : null),
      termYears: c.billing === "recurring" ? 1 : null, discountMode: null, discountValue: null,
      tierId: null, calcValues: {}, calcDiscounts: {}, calcRates: {},
      signingDate: today, fromTracking: false,
    }]);
    setAdding(false);
  };

  // Turn a handoff product into the calculator's RevenueLineFields shape.
  const lineOf = (p: HandoffProduct): RevenueLineFields => ({
    price: p.price, quantity: p.quantity, recurring: p.recurring, period: p.period as any,
    term_years: p.termYears, tier_id: p.tierId ?? null,
    calc_values: p.calcValues ?? {}, calc_discounts: p.calcDiscounts ?? {}, calc_rates: p.calcRates ?? {},
    discount_mode: p.discountMode as any, discount_value: p.discountValue ?? 0,
  });
  const bdOf = (p: HandoffProduct) => lineBreakdown(lineOf(p), productById[p.productId]?.calculator ?? null);

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
    });
    setCalcFor(null);
  };

  const stillAddable = useMemo(() => catalog.filter((c) => !products.some((p) => p.productId === c.id)), [catalog, products]);
  const productsValue = products.reduce((s, p) => s + bdOf(p).total, 0);
  const canSave = name.trim().length > 0 && products.length > 0 && products.every((p) => p.signingDate);

  const confirm = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onConfirm({
        client: { name: name.trim(), legalName, vatNumber: vat, address: addr, contacts },
        products,
        reviseDetails: gate === "revise",
      });
    } finally { setSaving(false); }
  };

  const calcProduct = calcFor ? products.find((p) => p.key === calcFor) : null;

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
              <p className="hc-gate-sub">You're handing off <b>new products</b> for an existing client. Revise the details we have on file, or reuse them as-is and go straight to the products.</p>
              <div className="hc-gate-actions">
                <button className="hc-gate-ghost" onClick={() => setGate("revise")}>Revise details</button>
                <button className="hc-gate-primary" onClick={() => setGate("reuse")}>Reuse existing</button>
              </div>
            </div>
          </div>
        )}
        {/* header: title + total + primary action + close */}
        <header className="hc-head">
          <span className="hc-head-glow" aria-hidden="true" />
          <div className="hc-head-txt">
            <span className="hc-eyebrow">{attach ? "Handoff · new products" : "Handoff · create client"}</span>
            <h2 className="hc-title">{name || "New client"}</h2>
          </div>
          <div className="hc-head-right">
            <div className="hc-head-total">
              <span>{attach ? "New products value" : "Total value"}</span>
              <b>{money(productsValue)}</b>
            </div>
            <button className="hc-btn-primary" disabled={!canSave || saving} onClick={confirm}>
              {saving ? (attach ? "Attaching…" : "Creating…") : (attach ? "Attach & send handoff" : "Create & send handoff")}
            </button>
            <button className="hc-x" onClick={onClose} aria-label="Close">×</button>
          </div>
        </header>

        <div className={"hc-body" + (attach && gate === "reuse" ? " hc-body-solo" : "")}>
          {gate !== "reuse" && (
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
          </div>
          )}

          <div className="hc-col hc-col-right">
            <section className="hc-sec hc-sec-products">
              <h3 className="hc-sec-title"><span className="hc-icon"><IconProducts /></span>Signed products <i className="hc-count">{products.length}</i></h3>
              {products.length === 0 && <p className="hc-empty">Add at least one product the client is signing.</p>}
              <div className="hc-products">
                {products.map((p) => {
                  const bd = bdOf(p);
                  const isOpen = expanded.has(p.key);
                  return (
                    <div className={`hc-product ${p.fromTracking ? "is-deal" : ""} ${isOpen ? "is-open" : ""}`} key={p.key}>
                      <span className="hc-product-glow" aria-hidden="true" />
                      <div className="hc-product-row">
                        <div className="hc-product-main">
                          <div className="hc-product-id">
                            <span className="hc-product-name">{p.name}</span>
                            {p.fromTracking ? <span className="hc-product-tag">From deal</span> : <span className="hc-product-tag is-added">Added</span>}
                          </div>
                          {/* price: gross → discount → net */}
                          <div className="hc-product-figs">
                            {bd.discount > 0 && <span className="hc-product-gross">{money(bd.gross)}</span>}
                            <span className="hc-product-price">{money(bd.total)}</span>
                            {bd.discount > 0 && <span className="hc-product-disc">−{money(bd.discount)}</span>}
                            {bd.qty > 1 && <span className="hc-product-qty">·  {bd.qty}{p.recurring ? "" : " units"}</span>}
                            {p.recurring && <span className="hc-product-recurr">{p.period === "monthly" ? "/mo" : "/yr"} · {p.termYears}y</span>}
                          </div>
                        </div>
                        <div className="hc-product-sign">
                          <DatePicker value={p.signingDate} onChange={(iso) => setProduct(p.key, { signingDate: iso })} placeholder="Signing date" />
                        </div>
                        <button className="hc-product-calc" onClick={() => setCalcFor(p.key)} title="Edit pricing / calculator">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h4" /></svg>
                        </button>
                        <button className={`hc-product-expand ${isOpen ? "is-open" : ""}`} onClick={() => toggleExpand(p.key)} title="Contract details">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                        <button className="hc-product-del" onClick={() => removeProduct(p.key)} aria-label="Remove">×</button>
                      </div>

                      {isOpen && (
                        <div className="hc-contract">
                          {/* Dates & fees */}
                          <div className="hc-cgroup">
                            <span className="hc-cgroup-t">Dates & fees</span>
                            <div className="hc-crow">
                              <label>Service start</label>
                              <DatePicker value={p.startDate ?? p.signingDate} onChange={(iso) => setProduct(p.key, { startDate: iso })} placeholder="Select" />
                            </div>
                            <div className="hc-crow">
                              <label>One-time fee</label>
                              <div className="hc-cval"><input type="number" min={0} value={p.oneTimeFee ?? ""} placeholder="0" onChange={(e) => setProduct(p.key, { oneTimeFee: e.target.value === "" ? undefined : Number(e.target.value) })} /><em>€</em></div>
                            </div>
                            <div className="hc-crow">
                              <label>Payment terms</label>
                              <div className="hc-cval"><input type="number" min={0} value={p.paymentTermsDays ?? ""} placeholder="30" onChange={(e) => setProduct(p.key, { paymentTermsDays: e.target.value === "" ? null : Number(e.target.value) })} /><em>net days</em></div>
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

                          {/* Renewal — only relevant for recurring products, not one-time purchases */}
                          {p.recurring && (
                          <div className="hc-cgroup">
                            <span className="hc-cgroup-t">Renewal</span>
                            <div className="hc-crow">
                              <label>Non-terminable</label>
                              <div className="hc-cval"><input type="number" min={0} value={p.nonTerminableYears ?? ""} placeholder="0" onChange={(e) => setProduct(p.key, { nonTerminableYears: e.target.value === "" ? null : Number(e.target.value) })} /><em>years</em></div>
                            </div>
                            <div className="hc-crow">
                              <label>Annual increase</label>
                              <div className="hc-cval"><input type="number" min={0} step={0.5} value={p.annualIncreasePct ?? ""} placeholder="0" onChange={(e) => setProduct(p.key, { annualIncreasePct: e.target.value === "" ? null : Number(e.target.value) })} /><em>%</em></div>
                            </div>
                            <div className="hc-crow">
                              <label>Auto-renew</label>
                              <button className={`hc-toggle ${p.autoRenew ? "is-on" : ""}`} onClick={() => setProduct(p.key, { autoRenew: !p.autoRenew })}><span className="hc-toggle-knob" /></button>
                            </div>
                            {p.autoRenew && (
                              <div className="hc-crow">
                                <label>Renewal term</label>
                                <div className="hc-cval"><input type="number" min={0} value={p.renewYears ?? ""} placeholder="0" onChange={(e) => setProduct(p.key, { renewYears: e.target.value === "" ? null : Number(e.target.value) })} /><em>years</em></div>
                              </div>
                            )}
                          </div>
                          )}

                          {/* References */}
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
                      )}
                    </div>
                  );
                })}
              </div>

              {stillAddable.length > 0 && (
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
              )}
            </section>
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
          unit={null}
          money={money}
          onApply={(patch) => applyCalc(calcProduct.key, patch)}
          onClose={() => setCalcFor(null)}
        />
      )}
    </>,
    document.body);
}