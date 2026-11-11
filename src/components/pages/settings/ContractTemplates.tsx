import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Select from "../../framework/Select";
import type { Product } from "./catalogApi";
import ContractTermsForm, { Pct } from "../sales/extras/ContractTermsForm";
import ContractSummary from "../sales/extras/ContractSummary";
import {
  contractFigures, saveContractTemplate, deleteContractTemplate, PAY_LABEL, termLabel,
  type ContractTemplate, type DealContractData,
} from "../sales/extras/contractsApi";
import "../sales/extras/ContractTerms.css";

/* =====================================================================
   Settings › Catalog › Contracts: contract blueprints, like products and
   services. A deal's contract starts from one of these.
   ===================================================================== */

const money = (n: number) => `${Math.round(n).toLocaleString("de-DE")} €`;

export function ContractTemplateCards({ templates, onOpen, onNew }: { templates: ContractTemplate[]; onOpen: (t: ContractTemplate) => void; onNew: () => void }) {
  return (
    <div className="pw-grid">
      {templates.map((t, i) => {
        const c = t.config;
        const pays = c.payments.filter((p) => p.enabled);
        return (
          <button key={t.id} type="button" className="cat-prod-card pw-pcard ctc-card" style={{ ["--i" as any]: i }} onClick={() => onOpen(structuredClone(t))}>
            <span className="pw-pcard-top">
              <span className="ctc-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" /></svg></span>
              <span className="pw-pcard-id">
                <span className="cat-prod-name">{t.name || "Untitled contract"}</span>
                <span className="cat-svc-meta">
                  <span className="cat-pill is-plain">{c.durations.map((d) => termLabel(d)).join(" · ") || "Any length"}</span>
                  {t.active === false && <span className="cat-pill is-off">Inactive</span>}
                </span>
              </span>
            </span>
            <span className="ctc-facts">
              {c.durations.filter((d) => d.discountPct).slice(0, 3).map((d) => <span key={d.id}><b>−{d.discountPct}%</b> {termLabel(d)}</span>)}
              {pays.filter((p) => p.discountPct).slice(0, 2).map((p) => <span key={p.key}><b>−{p.discountPct}%</b> {PAY_LABEL[p.key].toLowerCase()}</span>)}
              {c.prepayDays > 0 && <span><b>{c.prepayDays}d</b> before it starts</span>}
              {c.increments.mode !== "none" && !!c.increments.value && <span><b>+{c.increments.value}{c.increments.mode === "pct" ? "%" : "€"}</b> a year{c.increments.waivedIfUpfront ? " · not upfront" : ""}</span>}
              {c.discounts.length > 0 && <span><b>{c.discounts.length}</b> named discount{c.discounts.length === 1 ? "" : "s"}</span>}
            </span>
            <span className="pw-pcard-foot">
              <span className="cat-pill is-plain">{pays.map((p) => PAY_LABEL[p.key]).join(" · ") || "No way to pay yet"}</span>
              <span className="pw-pcard-go">Edit<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>
            </span>
          </button>
        );
      })}
      <button type="button" className="pw-newcard" onClick={onNew}>
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
  const close = () => { if (dirty && !window.confirm("Close without saving the contract?")) return; onClose(); };
  // the preview: this template on a sample price a year
  const previewData: DealContractData = useMemo(() => ({
    ...c, fee: (Number(c.fee) || 0) + sample, items: [],
    term: c.durations[0] ? { value: c.durations[0].value, unit: c.durations[0].unit } : { value: 1, unit: "years" },
    payment: c.payments.find((p) => p.key === c.defaultPayment && p.enabled) ? c.defaultPayment : (c.payments.find((p) => p.enabled)?.key ?? "annually"),
    start: null,
  }), [c, sample]);
  const f = useMemo(() => contractFigures(previewData, []), [previewData]);
  const byId = new Map(products.map((p) => [p.id!, p]));

  const save = async () => {
    setBusy(true); setErr(null);
    const r = await saveContractTemplate(t);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    onSaved();
  };
  const remove = async () => {
    if (!t.id || !window.confirm(`Delete the contract “${t.name}”? Deals that used it keep their own copy.`)) return;
    setBusy(true);
    const e = await deleteContractTemplate(t.id);
    setBusy(false);
    if (e) { setErr(e); return; }
    onDeleted();
  };

  return createPortal(
    <div className="ctm-back" onMouseDown={close}>
      <div className="ctm" role="dialog" aria-modal="true" aria-label="Contract template" onMouseDown={(e) => e.stopPropagation()}>
        <header className="ctm-h">
          <span className="ctm-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" /></svg></span>
          <div className="ctm-h-t">
            <em>{t.id ? "Contract template" : "New contract template"}</em>
            <input className="ctm-name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="Name it — e.g. Konsolidator licence agreement" aria-label="Name" autoFocus={!t.id} />
          </div>
          <button type="button" className={`ctf-sw ${t.active ? "is-on" : ""}`} role="switch" aria-checked={t.active} onClick={() => setT({ ...t, active: !t.active })}>
            <span className="ctf-sw-k" aria-hidden="true"><i /></span>{t.active ? "Active" : "Inactive"}
          </button>
          <button type="button" className="ctm-x" onClick={close} aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </header>

        <div className="ctm-body">
          <div className="ctm-main">
            <section className="ctf-sec">
              <header className="ctf-sec-h">
                <span className="ctf-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 11h16M4 16h10" /></svg></span>
                <div className="ctf-sec-t"><b>What it is</b><em>Shown to sales when they pick a contract on a deal</em></div>
              </header>
              <textarea className="ctt-desc" rows={2} value={t.description ?? ""} onChange={(e) => setT({ ...t, description: e.target.value })} placeholder="A line on what this contract is for" />
              <div className="ctm-addrow">
                <span className="ctm-fee"><span>Fee of its own</span><Pct value={c.fee} onChange={(v) => setT({ ...t, config: { ...c, fee: Math.max(0, v) } })} suffix="€ a year" width={150} label="Fee per year" /></span>
              </div>
              <div className="ctt-prods">
                <span className="ctt-prods-h">Products it can include <em>{c.productIds.length ? `${c.productIds.length} chosen` : "Any product"}</em></span>
                <div className="ctt-chips">
                  {c.productIds.map((id) => (
                    <span className="ctt-chip" key={id}>{byId.get(id)?.name ?? "Removed product"}
                      <button type="button" onClick={() => setT({ ...t, config: { ...c, productIds: c.productIds.filter((x) => x !== id) } })} aria-label="Remove">×</button>
                    </span>
                  ))}
                  <span className="ctt-addp"><Select size="sm" value="" searchable placeholder="+ Limit to a product" onChange={(v) => v && setT({ ...t, config: { ...c, productIds: [...c.productIds, v] } })}
                    options={products.filter((p) => !c.productIds.includes(p.id!)).map((p) => ({ value: p.id!, label: p.name }))} aria-label="Limit to a product" /></span>
                </div>
              </div>
            </section>
            <ContractTermsForm value={c} onChange={(cfg) => setT({ ...t, config: cfg })} />
          </div>
          <aside className="ctm-side">
            <div className="ctt-sample">
              <span>Preview on</span>
              <Pct value={sample} onChange={(v) => setSample(Math.max(0, v))} suffix="€ a year" width={160} label="Sample price a year" />
            </div>
            <ContractSummary f={f} money={money} note={`Its first length (${termLabel(previewData.term)}), paid ${PAY_LABEL[previewData.payment].toLowerCase()}, with the discounts that are on by default.`} />
          </aside>
        </div>

        <footer className="ctm-f">
          {err && <p className="ctm-err">{err}</p>}
          {t.id && <button type="button" className="ctm-del" onClick={remove} disabled={busy}>Delete</button>}
          <span className="ctm-f-sp" />
          <button type="button" className="ctm-btn" onClick={close}>Cancel</button>
          <button type="button" className="ctm-btn is-main" onClick={save} disabled={busy || !t.name.trim() || (!dirty && !!t.id)}>{busy ? "Saving…" : t.id ? "Save" : "Create contract"}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
