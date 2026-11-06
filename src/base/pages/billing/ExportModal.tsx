/* =====================================================================
   BASE · Billing — invoices out to a billing / accounting system as XML.
   Format: Facturae 3.2.2 (the Spanish e-invoice), one .xml per invoice,
   a .zip when there are several. The files aren't signed: the system they
   are imported into signs / files them (FACe, the tax agency…).
   The issuer (you) comes from Billing settings (sql 110) and is edited here.
   ===================================================================== */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { IC } from "./InvoiceModal";
import {
  exportFacturae, fmtDate, money, round2, saveSeller, sellerMissing,
  type Invoice, type Seller,
} from "./billingApi";

interface Props {
  invoices: Invoice[];
  seller: Seller;
  nameOf: (id: string | null) => string;
  onSeller: (s: Seller) => void;
  onClose: () => void;
}

const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const FIELDS: { k: keyof Seller; label: string; wide?: boolean; ph?: string }[] = [
  { k: "name", label: "Legal name", wide: true, ph: "Your Company S.L." },
  { k: "tax_id", label: "Tax ID (NIF / VAT)", ph: "B12345678" },
  { k: "email", label: "Billing e-mail", ph: "billing@…" },
  { k: "street", label: "Address", wide: true, ph: "Street and number" },
  { k: "postal_code", label: "Postal code", ph: "28001" },
  { k: "city", label: "Town", ph: "Madrid" },
  { k: "province", label: "Province", ph: "Madrid" },
  { k: "country", label: "Country", ph: "ES" },
  { k: "iban", label: "IBAN to be paid into", wide: true, ph: "ES00 0000 0000 0000 0000 0000" },
];

export default function ExportModal({ invoices, seller, nameOf, onSeller, onClose }: Props) {
  const [s, setS] = useState<Seller>(seller);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const missing = sellerMissing(s);
  const [editing, setEditing] = useState(missing.length > 0);
  const close = () => { setClosing(true); setTimeout(onClose, 200); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  /** Drafts and void invoices don't go out (a voided one needs a corrective invoice). */
  const out = useMemo(() => invoices.filter((i) => i.status === "sent" || i.status === "paid"), [invoices]);
  const skipped = invoices.length - out.length;
  const noVat = out.filter((i) => !(i.bill_to?.vat ?? "").trim());
  const total = round2(out.reduce((a, i) => a + i.amount, 0));
  const dates = out.map((i) => i.issue_date).sort();
  const dirty = (Object.keys(s) as (keyof Seller)[]).some((k) => (s[k] ?? "") !== (seller[k] ?? ""));

  const go = async () => {
    setBusy(true); setErr(null); setMsg(null); setDone(0);
    try {
      if (dirty) { await saveSeller(s); onSeller(s); }
      const n = await exportFacturae(out, s, setDone);
      setMsg(`${n} invoice${n === 1 ? "" : "s"} exported${n > 1 ? " in a .zip" : ""}.`);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    setBusy(false);
  };

  return createPortal(
    <div className={`bzi-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="bzi-modal bze-modal" role="dialog" aria-modal="true" aria-label="Export invoices as XML">
        <header className="bzi-head">
          <span className="bzi-head-ico"><Ico d={IC.code} s={18} /></span>
          <div className="bzi-head-t">
            <span className="bzi-kicker">Export to your billing system</span>
            <div className="bzi-head-row"><h2>{out.length} invoice{out.length === 1 ? "" : "s"} as XML</h2></div>
          </div>
          <button className="bzi-x" onClick={close} aria-label="Close"><Ico d={IC.x} s={18} /></button>
        </header>

        <div className="bzi-body bze-body">
          <section className="bze-sum">
            <div><span className="bzi-lbl">Invoices</span><b>{out.length}</b></div>
            <div><span className="bzi-lbl">Total</span><b>{money(total)}</b></div>
            <div><span className="bzi-lbl">Issued</span><b className="is-sm">{dates.length ? (dates[0] === dates[dates.length - 1] ? fmtDate(dates[0]) : `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`) : "—"}</b></div>
          </section>
          {out.length > 0 && (
            <div className="bze-list">
              {out.slice(0, 6).map((i) => (
                <span key={i.id}><b>{i.number}</b><em>{nameOf(i.client_id) !== "—" ? nameOf(i.client_id) : i.bill_to?.name}</em><u>{money(i.amount)}</u></span>
              ))}
              {out.length > 6 && <small>and {out.length - 6} more</small>}
            </div>
          )}
          {skipped > 0 && <p className="bze-note"><Ico d={IC.ban} s={14} />{skipped} draft or void invoice{skipped === 1 ? " is" : "s are"} left out — only sent and paid ones go out.</p>}
          {noVat.length > 0 && <p className="bze-note is-warn"><Ico d={IC.ban} s={14} />{noVat.length} client{noVat.length === 1 ? " has" : "s have"} no VAT number ({noVat.slice(0, 3).map((i) => i.number).join(", ")}{noVat.length > 3 ? "…" : ""}) — your system may ask for it.</p>}

          <section className="bze-fmt">
            <span className="bze-fmt-ico">XML</span>
            <span><b>Facturae 3.2.2</b><small>The Spanish e-invoice standard — imports into most billing and accounting systems. One .xml per invoice{out.length > 1 ? ", in a .zip" : ""}. Not signed: the system you import it into signs and files it.</small></span>
          </section>

          <section className={`bze-me ${editing ? "is-open" : ""}`}>
            <header>
              <span><b>Your details</b><small>{missing.length ? `Missing: ${missing.join(", ")}` : `${s.name} · ${s.tax_id}`}</small></span>
              {!editing && <button className="bzi-btn is-soft" onClick={() => setEditing(true)}>Edit</button>}
            </header>
            {editing && (
              <div className="bze-grid">
                {FIELDS.map((f) => (
                  <label key={f.k} className={f.wide ? "is-wide" : ""}>
                    <span className="bzi-lbl">{f.label}</span>
                    <input value={s[f.k] ?? ""} placeholder={f.ph} onChange={(e) => setS((x) => ({ ...x, [f.k]: e.target.value }))} />
                  </label>
                ))}
              </div>
            )}
          </section>
          {err && <p className="bzi-err">{err}</p>}
          {msg && <p className="bza-msg">{msg}</p>}
        </div>

        <footer className="bzi-actions">
          <span className="bze-foot">{dirty ? "Your details are saved for next time." : ""}</span>
          <span className="bzi-sp" />
          <button className="bzi-btn" onClick={close}>{msg ? "Done" : "Cancel"}</button>
          <button className="bzi-btn is-primary" disabled={busy || !out.length || missing.length > 0} onClick={go}
            title={missing.length ? `Fill in: ${missing.join(", ")}` : undefined}>
            <Ico d={IC.download} s={15} />{busy ? `Exporting ${done}/${out.length}…` : out.length > 1 ? "Download .zip" : "Download .xml"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
