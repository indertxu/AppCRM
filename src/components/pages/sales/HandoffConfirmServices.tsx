/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../framework/DatePicker";
import Select from "../../framework/Select";
import LineCalcModal from "../../framework/LineCalcModal";
import { lineBreakdown, type RevenueLineFields, type TermPatch } from "./salesApi";
import type { Calculator } from "../settings/catalogApi";
import "./HandoffConfirmServices.css";

export interface ConfirmContact { id: string; sourceId?: string | null; name: string; position: string; email: string; phone: string; billing: boolean; selected?: boolean; }
export interface ConfirmClient {
  legalName: string; vatNumber: string;
  address: { street: string; number: string; details: string; postalCode: string; city: string; country: string };
  contacts: ConfirmContact[];
}
export interface ConfirmService {
  key: string;
  serviceId: string;
  name: string;
  line: RevenueLineFields;
  calculator: Calculator | null;
  unit: "hour" | "day" | null;
  minUnit?: number;
  signingDate: string;          // per-service signing date
  contactIds?: string[];             // contacts on THIS service (several, independent)
  billingContactId?: string | null;  // exclusive billing contact for THIS service
}

interface Props {
  clientName: string;
  skipPrompt?: boolean;   // client was just created → go straight to services
  client: ConfirmClient;
  services: ConfirmService[];
  money: (n: number) => string;
  onClose: () => void;
  onConfirm: (data: {
    services: ConfirmService[]; mode: "use" | "update";
    client: ConfirmClient; paymentDays: number | null;
  }) => Promise<void> | void;
}

const uid = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()));

export default function HandoffConfirmServices({ clientName, skipPrompt = false, client: initialClient, services: initial, money, onClose, onConfirm }: Props) {
  const [mode, setMode] = useState<"use" | "update" | null>(skipPrompt ? "use" : null);
  const [services, setServices] = useState<ConfirmService[]>(initial.map((s) => ({ ...s, contactIds: s.contactIds ?? [] })));
  // client.contacts is the ROSTER (company people + any newly added). Contacts
  // are assigned per service, not project-wide.
  const [client, setClient] = useState<ConfirmClient>(initialClient);
  const [paymentDays, setPaymentDays] = useState<number | null>(30);
  const [calcFor, setCalcFor] = useState<string | null>(null);
  const [editClient, setEditClient] = useState(false);
  const [saving, setSaving] = useState(false);
  // Fallback overlay positioning applied inline so the dialog is ALWAYS visible
  // even if the external stylesheet fails to load. CSS refines the look.
  const backdropFallback: React.CSSProperties = {
    position: "fixed", inset: 0, zIndex: 260,
    display: "grid", placeItems: "center", padding: "3vh",
    background: "rgba(6, 18, 13, 0.5)", overflow: "auto",
  };

  const bdOf = (s: ConfirmService) => lineBreakdown(s.line, s.calculator, undefined, s.minUnit);
  const total = useMemo(() => services.reduce((sum, s) => sum + bdOf(s).total, 0), [services]);

  const setService = (key: string, patch: Partial<ConfirmService>) => setServices((ss) => ss.map((s) => s.key === key ? { ...s, ...patch } : s));
  const applyCalc = (key: string, patch: TermPatch) => { setService(key, { line: { ...(services.find((s) => s.key === key)!.line), ...(patch as any) } }); setCalcFor(null); };

  const setAddr = (k: keyof ConfirmClient["address"], v: string) => setClient((c) => ({ ...c, address: { ...c.address, [k]: v } }));
  const setContact = (id: string, patch: Partial<ConfirmContact>) => setClient((c) => ({ ...c, contacts: c.contacts.map((x) => x.id === id ? { ...x, ...patch } : x) }));

  // stable identity for a roster contact: real id if it exists, else local id
  const ckey = (c: ConfirmContact) => (c.sourceId ?? c.id) as string;
  const contactByKey = (k: string) => client.contacts.find((c) => ckey(c) === k);

  // per-service contact assignment
  const addServiceContact = (key: string, k: string) =>
    setServices((ss) => ss.map((s) => s.key === key && !(s.contactIds ?? []).includes(k) ? { ...s, contactIds: [...(s.contactIds ?? []), k] } : s));
  const removeServiceContact = (key: string, k: string) =>
    setServices((ss) => ss.map((s) => s.key === key
      ? { ...s, contactIds: (s.contactIds ?? []).filter((x) => x !== k), billingContactId: s.billingContactId === k ? null : s.billingContactId }
      : s));
  // create a brand-new roster contact and assign it to this service (editable inline)
  const addNewContactToService = (key: string) => {
    const id = uid();
    setClient((c) => ({ ...c, contacts: [...c.contacts, { id, sourceId: null, name: "", position: "", email: "", phone: "", billing: false }] }));
    addServiceContact(key, id);
  };

  const confirm = async () => {
    if (saving || !mode) return;
    setSaving(true);
    // Roster passes through so new contacts can be created; per-service contactIds
    // carry the assignment. Drop the legacy UI-only flag if present.
    const roster = client.contacts.map(({ selected, ...c }: any) => c);
    try { await onConfirm({ services, mode, client: { ...client, contacts: roster }, paymentDays }); } finally { setSaving(false); }
  };

  const calcService = calcFor ? services.find((s) => s.key === calcFor) : null;

  return createPortal(
    <>
      {/* step 1 — small prompt */}
      {mode === null ? (
        <div className="hx-backdrop" style={backdropFallback} onMouseDown={onClose}>
          <div className="hx-prompt" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <span className="hx-prompt-glow" aria-hidden="true" />
            <div className="hx-prompt-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            </div>
            <h2 className="hx-prompt-title">Client already exists</h2>
            <p className="hx-prompt-sub"><b>{clientName}</b> is already in management. Keep its current details, or update them from this deal?</p>
            <div className="hx-prompt-actions">
              <button className="hx-btn-ghost" onClick={() => { setMode("update"); setEditClient(true); }}>Update details</button>
              <button className="hx-btn-primary" onClick={() => setMode("use")}>Use existing</button>
            </div>
            <button className="hx-prompt-x" onClick={onClose} aria-label="Cancel">×</button>
          </div>
        </div>
      ) : (
        /* step 2 — confirm services */
        <div className="hx-backdrop" style={backdropFallback} onMouseDown={onClose}>
          <div className="hx" style={{ width: "min(1440px, 96vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", background: "#fbfefc", borderRadius: 26, overflow: "hidden" }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <header className="hx-head">
              <span className="hx-head-glow" aria-hidden="true" />
              <div className="hx-head-txt">
                <span className="hx-eyebrow">Handoff · confirm services</span>
                <h2 className="hx-title">{clientName}</h2>
              </div>
              <div className="hx-head-right">
                <div className="hx-head-total"><span>Services value</span><b>{money(total)}</b></div>
                <button className="hx-btn-primary" disabled={saving || services.length === 0} onClick={confirm}>
                  {saving ? "Sending…" : "Send to management"}
                </button>
                <button className="hx-x" onClick={onClose} aria-label="Close">×</button>
              </div>
            </header>

            {/* control strip: mode + payment + edit */}
            <div className="hx-strip">
              <label className="hx-pay">
                <span>Payment</span>
                <div className="hx-pay-val"><input type="number" min={0} value={paymentDays ?? ""} placeholder="30" onChange={(e) => setPaymentDays(e.target.value === "" ? null : Number(e.target.value))} /><em>net days</em></div>
              </label>
              <div className="hx-strip-spacer" />
              <button className="hx-edit-client" onClick={() => setEditClient(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                Edit client details
              </button>
            </div>

            <div className="hx-body">
              {services.length === 0 ? (
                <p className="hx-empty">No services to hand off on this deal.</p>
              ) : (
                <div className="hx-cards">
                  {services.map((s) => {
                    const bd = bdOf(s);
                    return (
                      <div className="hx-card" key={s.key}>
                        <span className="hx-card-accent" aria-hidden="true" />
                        <div className="hx-card-top">
                          <span className="hx-card-name">{s.name}</span>
                          <button className="hx-card-calc" onClick={() => setCalcFor(s.key)} title="Adjust calculator">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h4" /></svg>
                          </button>
                        </div>
                        <div className="hx-card-rows">
                          {bd.rows.map((r, i) => (
                            <div className="hx-crow" key={i}>
                              <span className="hx-crow-l">{r.label}{r.detail ? <em> {r.detail}</em> : null}</span>
                              <span className="hx-crow-r">{money(r.amount)}{r.discount ? <i>−{money(r.discount)}</i> : null}</span>
                            </div>
                          ))}
                        </div>
                        <div className="hx-card-foot">
                          <span className="hx-card-qty">{bd.qty}{s.unit === "hour" ? "h" : "d"}{bd.multiplierLabel ? ` · ${bd.multiplierLabel}` : ""}</span>
                          <span className="hx-card-total">
                            {bd.discount > 0 && <em className="hx-card-gross">{money(bd.gross)}</em>}
                            <b>{money(bd.total)}</b>
                          </span>
                        </div>
                        {/* per-service signing date */}
                        <div className="hx-card-sign">
                          <span>Signing date</span>
                          <DatePicker value={s.signingDate} onChange={(iso) => setService(s.key, { signingDate: iso })} placeholder="Select" />
                        </div>

                        {/* contacts on THIS service (several, independent) */}
                        <div className="hx-svc-contacts">
                          <span className="hx-svc-c-label">Contacts</span>
                          <div className="hx-svc-c-list">
                            {(s.contactIds ?? []).map((k) => {
                              const c = contactByKey(k);
                              if (!c) return null;
                              const isNew = !c.sourceId;
                              return isNew ? (
                                <div className="hx-svc-c-new" key={k}>
                                  <div className="hx-svc-c-new-head">
                                    <span>New contact</span>
                                    <button className="hx-svc-c-x" onClick={() => removeServiceContact(s.key, k)} aria-label="Remove">×</button>
                                  </div>
                                  <input className="hx-svc-c-nm" value={c.name} onChange={(e) => setContact(c.id, { name: e.target.value })} placeholder="Full name" />
                                  <input value={c.position} onChange={(e) => setContact(c.id, { position: e.target.value })} placeholder="Position / role" />
                                  <input value={c.email} onChange={(e) => setContact(c.id, { email: e.target.value })} placeholder="Email" />
                                  <input value={c.phone} onChange={(e) => setContact(c.id, { phone: e.target.value })} placeholder="Phone" />
                                </div>
                              ) : (
                                <span className={"hx-svc-chip" + (s.billingContactId === k ? " is-bill" : "")} key={k}>
                                  {c.name}{s.billingContactId === k ? <i title="Billing contact"> · €</i> : null}
                                  <button onClick={() => removeServiceContact(s.key, k)} aria-label="Remove">×</button>
                                </span>
                              );
                            })}
                          </div>
                          <div className="hx-svc-c-add">
                            <Select
                              value=""
                              onChange={(v) => v && addServiceContact(s.key, v)}
                              placeholder="+ Add contact"
                              options={client.contacts
                                .filter((c) => c.sourceId && (c.name || "").trim() && !(s.contactIds ?? []).includes(ckey(c)))
                                .map((c) => ({ value: ckey(c), label: c.position ? `${c.name} · ${c.position}` : c.name }))}
                            />
                            <button className="hx-svc-c-newbtn" onClick={() => addNewContactToService(s.key)}>+ New</button>
                          </div>
                        </div>

                        {/* exclusive billing contact — chosen from THIS service's contacts */}
                        <div className="hx-card-bill">
                          <span>Bill to</span>
                          <Select
                            value={s.billingContactId ?? ""}
                            onChange={(v) => setService(s.key, { billingContactId: v || null })}
                            placeholder="Choose contact"
                            options={(s.contactIds ?? [])
                              .map((k) => contactByKey(k))
                              .filter((c): c is ConfirmContact => !!c && !!(c.name || "").trim())
                              .map((c) => ({ value: ckey(c), label: c.position ? `${c.name} · ${c.position}` : c.name }))}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* edit-client popup */}
      {editClient && (
        <div className="hx-backdrop hx-backdrop-2" onMouseDown={() => setEditClient(false)}>
          <div className="hx-edit" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <header className="hx-edit-head">
              <h3>Client details</h3>
              <button className="hx-prompt-x" onClick={() => setEditClient(false)} aria-label="Close">×</button>
            </header>
            <div className="hx-edit-body">
              <div className="hx-egroup">
                <span className="hx-egroup-t">Legal</span>
                <div className="hx-egrid">
                  <label className="hx-ef hx-ef-2"><input value={client.legalName} onChange={(e) => setClient((c) => ({ ...c, legalName: e.target.value }))} placeholder=" " /><span>Legal name</span></label>
                  <label className="hx-ef"><input value={client.vatNumber} onChange={(e) => setClient((c) => ({ ...c, vatNumber: e.target.value }))} placeholder=" " /><span>VAT / Tax ID</span></label>
                </div>
              </div>
              <div className="hx-egroup">
                <span className="hx-egroup-t">Address</span>
                <div className="hx-egrid">
                  <label className="hx-ef hx-ef-2"><input value={client.address.street} onChange={(e) => setAddr("street", e.target.value)} placeholder=" " /><span>Street</span></label>
                  <label className="hx-ef"><input value={client.address.number} onChange={(e) => setAddr("number", e.target.value)} placeholder=" " /><span>Number</span></label>
                  <label className="hx-ef"><input value={client.address.details} onChange={(e) => setAddr("details", e.target.value)} placeholder=" " /><span>Details</span></label>
                  <label className="hx-ef"><input value={client.address.postalCode} onChange={(e) => setAddr("postalCode", e.target.value)} placeholder=" " /><span>Postal code</span></label>
                  <label className="hx-ef"><input value={client.address.city} onChange={(e) => setAddr("city", e.target.value)} placeholder=" " /><span>City</span></label>
                  <label className="hx-ef"><input value={client.address.country} onChange={(e) => setAddr("country", e.target.value)} placeholder=" " /><span>Country</span></label>
                </div>
              </div>
            </div>
            <footer className="hx-edit-foot">
              <button className="hx-btn-primary" onClick={() => setEditClient(false)}>Done</button>
            </footer>
          </div>
        </div>
      )}

      {/* editable calculator */}
      {calcService && (
        <LineCalcModal
          variant="modern"
          title={calcService.name}
          line={calcService.line}
          calculator={calcService.calculator}
          unit={calcService.unit}
          money={money}
          onApply={(patch) => applyCalc(calcService.key, patch)}
          onClose={() => setCalcFor(null)}
        />
      )}
    </>,
    document.body);
}