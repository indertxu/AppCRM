import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Select from "../../framework/Select";
import type { Product } from "./catalogApi";
import ContractTermsForm, { Pct, Sec, Ico, IC, ContractSteps } from "../sales/extras/ContractTermsForm";
import ContractSummary, { PriceMatrix } from "../sales/extras/ContractSummary";
import ContractConfirm, { useEscape } from "../sales/extras/ContractConfirm";
import {
  contractFigures, pricingMatrix, saveContractTemplate, deleteContractTemplate, PAY_LABEL, PAY_KEYS, termLabel, termYears, termKey,
  type ContractTemplate, type DealContractData, type PayKey, type Term,
} from "../sales/extras/contractsApi";
import "../sales/extras/ContractTerms.css";

/* =====================================================================
   Settings › Catalog › Contracts: contract blueprints, like products and
   services. A deal's contract starts from one of these.
   ===================================================================== */

const money = (n: number) => `${Math.round(n).toLocaleString("de-DE")} €`;
const DOC = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4";
const PAY_DOT: Record<PayKey, string> = { upfront: "1×", annually: "1/y", semiannually: "2/y", quarterly: "4/y", monthly: "12/y" };

export function ContractTemplateCards({ templates, onOpen, onNew }: { templates: ContractTemplate[]; onOpen: (t: ContractTemplate) => void; onNew: () => void }) {
  return (
    <div className="pw-grid ctc-grid">
      {templates.map((t, i) => {
        const c = t.config;
        const pays = c.payments.filter((p) => p.enabled);
        const lens = [...c.durations].sort((a, b) => termYears(a) - termYears(b));
        const maxD = Math.max(...lens.map((d) => d.discountPct), 1);
        const inc = c.increments.mode !== "none" && !!c.increments.value;
        return (
          <button key={t.id} type="button" className={`ctc-card ${t.active === false ? "is-off" : ""}`} style={{ ["--i" as any]: i }} onClick={() => onOpen(structuredClone(t))}>
            <span className="ctc-top">
              <span className="ctc-ico" aria-hidden="true"><Ico d={DOC} /></span>
              <span className="ctc-id">
                <b>{t.name || "Untitled contract"}</b>
                <em>{t.description?.trim() || (c.productIds.length ? `${c.productIds.length} product${c.productIds.length === 1 ? "" : "s"} it can include` : "Any product, or a fee of its own")}</em>
              </span>
              {t.active === false && <span className="ctc-off">Inactive</span>}
            </span>

            <span className="ctc-lab">Lengths</span>
            <span className="ctc-ladder">
              {lens.length === 0 && <span className="ctc-none">Any length</span>}
              {lens.map((d) => (
                <span key={d.id} className="ctc-step">
                  <span className="ctc-step-bar"><i className={d.discountPct ? "" : "is-zero"} style={{ height: `${d.discountPct ? 30 + (d.discountPct / maxD) * 70 : 14}%` }} /></span>
                  <b>{termLabel(d)}</b>
                  <em className={d.discountPct ? "" : "is-zero"}>{d.discountPct ? `−${d.discountPct}%` : "list"}</em>
                </span>
              ))}
            </span>

            <span className="ctc-lab">Ways to pay</span>
            <span className="ctc-pays">
              {pays.length === 0 && <span className="ctc-none">None switched on</span>}
              {PAY_KEYS.filter((k) => pays.some((p) => p.key === k)).map((k) => {
                const p = pays.find((x) => x.key === k)!;
                return (
                  <span key={k} className={`ctc-pay ${c.defaultPayment === k ? "is-def" : ""}`} title={`${PAY_LABEL[k]}${p.discountPct ? ` · −${p.discountPct}%` : ""}${c.defaultPayment === k ? " · picked first" : ""}`}>
                    <i>{PAY_DOT[k]}</i>{PAY_LABEL[k]}{p.discountPct ? <b>−{p.discountPct}%</b> : null}
                  </span>
                );
              })}
            </span>

            <span className="ctc-foot">
              <span className="ctc-fact"><Ico d={IC.inv} /><b>{c.prepayDays ? `${c.prepayDays}d ahead` : "On the day"}</b><em>net {c.paymentTermsDays}d</em></span>
              <span className="ctc-fact"><Ico d={IC.inc} /><b>{inc ? `+${c.increments.value}${c.increments.mode === "pct" ? "%" : "€"}/yr` : "Flat"}</b>{inc && c.increments.waivedIfUpfront ? <em>not upfront</em> : null}</span>
              <span className="ctc-fact"><Ico d={IC.renew} /><b>{c.autoRenew ? `Renews ${termLabel(c.renew ?? { value: 1, unit: "years" })}` : "Ends"}</b></span>
              {Number(c.fee) > 0 && <span className="ctc-fact"><Ico d={IC.pay} /><b>{money(c.fee)}</b><em>fee a year</em></span>}
              {c.discounts.length > 0 && <span className="ctc-fact"><Ico d={IC.disc} /><b>{c.discounts.length}</b><em>named</em></span>}
              <span className="ctc-go" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>
            </span>
          </button>
        );
      })}
      <button type="button" className="pw-newcard ctc-new" onClick={onNew}>
        <span>+</span><b>New contract</b><small>Lengths and their discounts, ways to pay, prepayment, increments and named discounts</small>
      </button>
    </div>
  );
}

export function ContractTemplateEditor({ template, products, onClose, onSaved, onDeleted }: {
  template: ContractTemplate; products: Product[]; onClose: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const [t, setT] = useState<ContractTemplate>(() => structuredClone(template));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sample, setSample] = useState(10000);
  const c = t.config;
  const dirty = JSON.stringify(t) !== JSON.stringify(template);
  const [ask, setAsk] = useState<null | "close" | "delete">(null);
  const close = () => { if (dirty) { setAsk("close"); return; } onClose(); };
  useEscape(() => { if (ask) setAsk(null); else close(); });

  // the preview: this template on a sample price a year — pick a length and a way to pay to see it
  const enabled = c.payments.filter((p) => p.enabled).map((p) => p.key);
  const firstTerm: Term = c.durations[0] ? { value: c.durations[0].value, unit: c.durations[0].unit } : { value: 1, unit: "years" };
  const [pv, setPv] = useState<{ term: Term | null; pay: PayKey | null }>({ term: null, pay: null });
  const pvTerm = pv.term && c.durations.some((d) => termKey(d) === termKey(pv.term!)) ? pv.term : firstTerm;
  const pvPay: PayKey = pv.pay && enabled.includes(pv.pay) ? pv.pay : enabled.includes(c.defaultPayment) ? c.defaultPayment : (enabled[0] ?? "annually");
  const previewData: DealContractData = useMemo(() => ({
    ...c, fee: (Number(c.fee) || 0) + sample, items: [], term: pvTerm, payment: pvPay, signed: null, start: null,
  }), [c, sample, pvTerm, pvPay]);
  const f = useMemo(() => contractFigures(previewData, []), [previewData]);
  const m = useMemo(() => pricingMatrix(previewData, []), [previewData]);
  const byId = new Map(products.map((p) => [p.id!, p]));
  const setC = (cfg: typeof c) => setT({ ...t, config: cfg });

  const save = async () => {
    setBusy(true); setErr(null);
    const r = await saveContractTemplate(t);
    setBusy(false);
    if (r.error) { setErr(r.error); setAsk(null); return; }
    onSaved();
  };
  const remove = async () => {
    if (!t.id) return;
    setBusy(true);
    const e = await deleteContractTemplate(t.id);
    setBusy(false);
    if (e) { setErr(e); setAsk(null); return; }
    onDeleted();
  };

  return createPortal(
    <div className="ctm-back" onMouseDown={close}>
      <div className="ctm" role="dialog" aria-modal="true" aria-label="Contract template" onMouseDown={(e) => e.stopPropagation()}>
        <header className="ctm-h">
          <span className="ctm-ico" aria-hidden="true"><Ico d={DOC} /></span>
          <div className="ctm-h-t">
            <em>{t.id ? "Contract template" : "New contract template"}</em>
            <input className="ctm-name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="Name it — e.g. Licence agreement" aria-label="Name" autoFocus={!t.id} />
          </div>
          <button type="button" className={`ctf-sw ${t.active ? "is-on" : ""}`} role="switch" aria-checked={t.active} onClick={() => setT({ ...t, active: !t.active })} title={t.active ? "Sales can pick it on a deal" : "Hidden from deals"}>
            <span className="ctf-sw-k" aria-hidden="true"><i /></span>{t.active ? "Active" : "Inactive"}
          </button>
          <button type="button" className="ctm-x" onClick={close} aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </header>

        <div className="ctm-body">
          <div className="ctm-main">
            <ContractSteps order={["about", "lengths", "pays", "grace", "invoicing", "increments", "renewal", "discounts"]} start={t.id ? null : "about"} allDone={!!t.id}>
            <Sec id="about" summary={[t.description?.trim() || "No description", c.productIds.length ? `${c.productIds.length} product${c.productIds.length === 1 ? "" : "s"}` : "any product", Number(c.fee) ? `fee ${money(c.fee)} a year` : ""].filter(Boolean).join(" · ")} icon="M4 6h16M4 11h16M4 16h10" title="What it is" sub="Shown to sales when they pick a contract on a deal">
              <textarea className="ctt-desc" rows={2} value={t.description ?? ""} onChange={(e) => setT({ ...t, description: e.target.value })} placeholder="A line on what this contract is for" />
              <div className="ctt-two">
                <div className="ctt-box">
                  <span className="ctt-box-h">Products it can include <em>{c.productIds.length ? `${c.productIds.length} chosen` : "Any product"}</em></span>
                  <div className="ctt-chips">
                    {c.productIds.map((id) => (
                      <span className="ctt-chip" key={id}>{byId.get(id)?.name ?? "Removed product"}
                        <button type="button" onClick={() => setC({ ...c, productIds: c.productIds.filter((x) => x !== id) })} aria-label="Remove">×</button>
                      </span>
                    ))}
                    <span className="ctt-addp"><Select size="sm" value="" searchable placeholder={c.productIds.length ? "+ Add a product" : "+ Limit to a product"} onChange={(v) => v && setC({ ...c, productIds: [...c.productIds, v] })}
                      options={products.filter((p) => !c.productIds.includes(p.id!)).map((p) => ({ value: p.id!, label: p.name }))} aria-label="Limit to a product" /></span>
                  </div>
                </div>
                <div className="ctt-box is-fee">
                  <span className="ctt-box-h">Fee of its own <em>On top of its products</em></span>
                  <Pct value={c.fee} onChange={(v) => setC({ ...c, fee: Math.max(0, v) })} suffix="€ a year" width={170} label="Fee per year" />
                </div>
              </div>
            </Sec>
            <ContractTermsForm value={c} onChange={setC} />
            </ContractSteps>
          </div>
          <aside className="ctm-side">
            <div className="ctt-sample">
              <span className="ctt-sample-t"><b>Preview</b><em>on a sample price</em></span>
              <Pct value={sample} onChange={(v) => setSample(Math.max(0, v))} suffix="€ a year" width={150} label="Sample price a year" />
            </div>
            <ContractSummary f={f} money={money}
              note={enabled.length ? undefined : "Switch on a way to pay to see what it comes to."}
              matrix={<PriceMatrix m={m} term={pvTerm} payment={pvPay} money={money} onPick={(tt, p) => setPv({ term: tt, pay: p })} />} />
          </aside>
        </div>

        <footer className="ctm-f">
          {err && <p className="ctm-err">{err}</p>}
          {t.id && <button type="button" className="ctm-del" onClick={() => setAsk("delete")} disabled={busy}>Delete</button>}
          <span className="ctm-f-sp" />
          <span className="ctm-f-sum">Preview: <b>{termLabel(pvTerm)}</b> · <b>{PAY_LABEL[pvPay]}</b> · {money(f.total)}</span>
          <button type="button" className="ctm-btn" onClick={close}>Cancel</button>
          <button type="button" className="ctm-btn is-main" onClick={save} disabled={busy || !t.name.trim() || (!dirty && !!t.id)}>{busy ? "Saving…" : t.id ? "Save" : "Create contract"}</button>
        </footer>
        {ask === "close" && (
          <ContractConfirm title="Save the contract before closing?" body={t.id ? "You changed this contract template; the changes aren't saved yet." : "This contract template hasn't been created yet."}
            onCancel={() => setAsk(null)}
            actions={[{ label: "Discard", tone: "danger", onClick: onClose }, { label: busy ? "Saving…" : t.id ? "Save and close" : "Create contract", tone: "main", onClick: () => void save(), disabled: busy || !t.name.trim() }]} />
        )}
        {ask === "delete" && (
          <ContractConfirm icon="trash" title={`Delete “${t.name || "this contract"}”?`} body="Deals that already use it keep their own copy of its terms."
            onCancel={() => setAsk(null)} actions={[{ label: busy ? "Deleting…" : "Delete", tone: "danger", onClick: () => void remove(), disabled: busy }]} />
        )}
      </div>
    </div>,
    document.body,
  );
}
