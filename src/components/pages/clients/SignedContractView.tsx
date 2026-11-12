import { nowMs } from "../../framework/asOf";
import { useMemo, useState, type ReactNode } from "react";
import { ViewShell, ViewSec } from "../sales/extras/ContractView";
import { Ico, IC, Sw } from "../sales/extras/ContractTermsForm";
import ContractConfirm from "../sales/extras/ContractConfirm";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import { NumInput } from "../../framework/NumInput";
import { cpDay } from "../sales/extras/ContractPlan";
import {
  isActive, lineAnnual, lineAnnualGross, lineYearGross, lineContractValue, lineOneTime, lineTotal, partnerCut, partnerTotal,
  firstYearOf, scheduleOf, periodsAYear, periodLabel, termOf, renewalOf, lineStartOf, type Line,
  contractEditValues, saveContractEditValues, lineEditValues, saveLineEditValues,
} from "./ClientWorkspace";

/* =====================================================================
   A signed contract made of a client's signed products (and the deal's
   order form, when there is one): everything about it in one wide view —
   its value year by year with the increases, each product's price build-up,
   the services sold with it, its terms, the parties, who signed and how.
   ===================================================================== */

const DAY = 864e5;
const s = (v: unknown) => (v == null ? "" : String(v).trim());
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** The same day `n` calendar years (and months) later — contract years run day to day, not 365.25-day steps. */
const addYears = (t: number, n: number) => { const d = new Date(t); const m = Math.round((n % 1) * 12); d.setFullYear(d.getFullYear() + Math.floor(n)); if (m) d.setMonth(d.getMonth() + m); return d.getTime(); };
const day = (d?: string | null) => (d ? cpDay(String(d).slice(0, 10)) : "—");
const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("de-DE", { maximumFractionDigits: 1 })}%`;
const ICO = {
  glance: "M3 12h4l3-8 4 16 3-8h4",
  years: "M3 3v18h18M7 15l4-4 3 3 5-6",
  box: "M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5",
  svc: "M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16",
  co: "M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1",
  people: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  sign: "M3 17c3-3 5-8 8-8 2 0 1 5 3 5s2-3 4-3 2 2 3 2M3 21h18",
  note: "M4 4h16v12H8l-4 4z",
};

export interface SignedContractRow {
  name: string; clientName: string; dealName: string; state: string; dealId?: string | null;
  signed: string | null; start: string | null; end: string | null; renews: boolean;
  total: number; perYear: number; lastPerYear: number; yearNo: number; incSoFar: number; incNext: number | null;
  lines?: Line[]; ct?: any;
}

function Fact({ k, v, sub, tone }: { k: string; v: ReactNode; sub?: ReactNode; tone?: string }) {
  return <span className={`scv-fact ${tone ? `is-${tone}` : ""}`}><em>{k}</em><b>{v}</b>{sub ? <i>{sub}</i> : null}</span>;
}
function Person({ who, role, name, email, phone, extra }: { who: string; role?: string | null; name?: string | null; email?: string | null; phone?: string | null; extra?: ReactNode }) {
  if (!name && !email) return null;
  const ini = s(name || email).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
  return (
    <div className="scv-person">
      <span className="scv-ini" aria-hidden="true">{ini || "?"}</span>
      <span className="scv-person-t">
        <em>{who}</em>
        <b>{name || email}</b>
        <i>{[role, name ? email : null, phone].filter(Boolean).join(" · ")}</i>
      </span>
      {extra}
    </div>
  );
}

/* ---- editing: one field, a text box, a number, a day, a choice ---- */
function F({ k, children, wide, hint }: { k: string; children: ReactNode; wide?: boolean; hint?: string }) {
  return <label className={`scv-f ${wide ? "is-wide" : ""}`}><em>{k}</em>{children}{hint ? <i>{hint}</i> : null}</label>;
}
const Txt = ({ v, on, ph, type = "text" }: { v: unknown; on: (x: string) => void; ph?: string; type?: string }) =>
  <input className="scv-in" type={type} value={s(v)} placeholder={ph} onChange={(e) => on(e.target.value)} />;
const Num = ({ v, on, ph, suffix }: { v: unknown; on: (x: string) => void; ph?: string; suffix?: string }) => (
  <span className="scv-in-wrap"><NumInput className="scv-in" value={s(v)} placeholder={ph} onChange={(e) => on(e.target.value)} />{suffix && <i>{suffix}</i>}</span>
);
const Day = ({ v, on }: { v: unknown; on: (x: string) => void }) => <span className="scv-in-date"><DatePicker value={s(v)} onChange={(x) => on(x || "")} placeholder="—" /></span>;
const Pick = ({ v, on, opts }: { v: unknown; on: (x: string) => void; opts: [string, string][] }) =>
  <span className="scv-in-sel"><Select size="sm" value={s(v)} onChange={(x) => on(x)} options={opts.map(([value, label]) => ({ value, label }))} /></span>;
/** Contract fields that every product of it shares: editing the contract carries them onto each product's editor. */
const SHARED: Record<string, string> = { signDate: "signing", contractStart: "start", termYears: "term", autoRenew: "autoRenew", renewYears: "renew", nonTerminableYears: "nonTerm", paymentTermsDays: "pay", contractRef: "ref" };

export default function SignedContractView({ row, money, onClose, onOpenDeal, onOpenClient, onSaved }: {
  row: SignedContractRow; money: (n: number) => string; onClose: () => void; onOpenDeal?: () => void; onOpenClient?: () => void;
  /** After a save: the list reads the contracts again (this window closes). */
  onSaved?: () => void;
}) {
  const ls = row.lines ?? [];
  const ct = row.ct && typeof row.ct === "object" ? row.ct : null;
  const rec = ls.filter((l) => l.recurring);
  const now = nowMs();
  const startOf = (l: Line) => +new Date(`${s(l.start_date || l.signing_date || lineStartOf(l, ct) || iso(now)).slice(0, 10)}T12:00:00`);
  const s0 = ls.length ? Math.min(...ls.map(startOf)) : now;
  const years = Math.max(1, ...rec.map((l) => Math.ceil((Number(l.term_years) || 1) - 1e-9)), Number(ct?.termYears) || 1);
  const curIdx = Math.max(0, Math.min(years - 1, Array.from({ length: years }, (_, y) => y).filter((y) => addYears(s0, y) <= now).pop() ?? 0));
  const grace = row.signed && row.start && row.start > row.signed ? Math.round((+new Date(row.start) - +new Date(row.signed)) / DAY) : 0;
  const nonTerm = Number(ct?.nonTerminableYears) || Math.max(0, ...ls.map((l) => Number(l.non_terminable_years) || 0));
  const autoRenew = ct?.autoRenew ?? ls.some((l) => l.auto_renew);
  const renewYears = Number(ct?.renewYears) || Math.max(0, ...ls.map((l) => Number(l.renew_years) || 0)) || Number(ct?.termYears) || null;
  const payDays = Number(ct?.paymentTermsDays) || Math.max(0, ...ls.map((l) => Number(l.payment_terms_days) || 0)) || null;
  const incPct = Number(ct?.increments?.value) || Math.max(0, ...ls.map((l) => Number(l.annual_increase_pct) || 0));
  const incMode = ct?.increments?.mode ?? (incPct ? "pct" : "none");
  const billing = s(ct?.billingFrequency) || s(ls.find((l) => l.billing_cycle)?.billing_cycle) || (rec[0] ? `${periodLabel(rec[0].period)}ly` : "");
  const term = termOf(rec[0] ?? ls[0] ?? ({} as Line));
  const renew = rec.map((l) => renewalOf(l, ct)).filter(Boolean).sort((a, b) => a!.end.getTime() - b!.end.getTime())[0] ?? null;
  const noticeDays = Number(ct?.noticeDays) || null;

  // year by year: each product's value that contract year (with its increase), one-offs in year 1, the partner's cut
  const yearRows = Array.from({ length: years }, (_, y) => {
    const from = addYears(s0, y), to = addYears(s0, y + 1) - DAY;
    const recurring = rec.reduce((t, l) => t + (y < Math.ceil((Number(l.term_years) || 1) - 1e-9) ? lineYearGross(l, y) - (y === 0 ? Number(l.one_time_fee) || 0 : 0) : 0), 0);
    const once = y === 0 ? ls.reduce((t, l) => t + lineOneTime(l) + (l.recurring ? 0 : partnerTotal(l)), 0) : 0;
    const fees = y === 0 ? rec.reduce((t, l) => t + (Number(l.one_time_fee) || 0), 0) : 0;
    const partner = ls.reduce((t, l) => t + partnerCut(l, y), 0);
    return { y, from, to, recurring, once: once + fees, partner, net: recurring + once + fees - partner };
  });
  const svcLines = Array.isArray(ct?.lines) ? (ct.lines as any[]).filter((x) => x.kind === "service" || x.oneTime) : [];
  const svcTotal = svcLines.reduce((t, x) => t + (Number(x.final) || 0), 0);
  const listTotal = Number(ct?.license?.list) || 0, finalLic = Number(ct?.license?.final) || 0, discLic = Number(ct?.license?.discount) || 0;
  const signatories = Array.isArray(ct?.signatories) ? (ct.signatories as any[]) : [];
  const cust = ct?.customer ?? null;
  const billingContact = ls.find((l) => l.billing_contact_name || l.billing_contact_email);
  const lineSigner = ls.find((l) => l.signatory_name || l.signatory_email);
  const ref = s(ct?.contractRef) || s(ls.find((l) => l.contract_ref)?.contract_ref);
  const notes = [s(ct?.notes), ...ls.map((l) => s(l.notes))].filter(Boolean);
  const sofar = row.incSoFar > 0.05 ? pct(row.incSoFar) : "";

  /* ---- editing everything in place ---- */
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const init = useMemo(() => ({
    cv: contractEditValues(ct, ls),
    lv: Object.fromEntries(ls.map((l) => [l.id, { ...lineEditValues(l), notes: s(l.notes), billingName: s(l.billing_contact_name), billingEmail: s(l.billing_contact_email) }])) as Record<string, Record<string, any>>,
    xv: {
      customer: { legalName: s(cust?.legalName), name: s(cust?.name) || row.clientName, vat: s(cust?.vat), address: s(cust?.address), country: s(cust?.country) },
      contactPerson: { name: s(ct?.contactPerson?.name), role: s(ct?.contactPerson?.role), email: s(ct?.contactPerson?.email), phone: s(ct?.contactPerson?.phone) },
      adminUser: { name: s(ct?.adminUser?.name), email: s(ct?.adminUser?.email) },
      signatories: signatories.map((x) => ({ name: s(x.name), role: s(x.role), email: s(x.email), side: x.side === "supplier" ? "supplier" : "customer" })),
      esignProvider: s(ct?.esignProvider), esignId: s(ct?.esignId), termsUrl: s(ct?.termsUrl), noticeDays: String(ct?.noticeDays ?? ""),
      billingName: s(billingContact?.billing_contact_name), billingEmail: s(billingContact?.billing_contact_email),
    },
  }), [edit]); // eslint-disable-line react-hooks/exhaustive-deps
  const [cv, setCv] = useState<Record<string, any>>(init.cv);
  const [lv, setLv] = useState<Record<string, Record<string, any>>>(init.lv);
  const [xv, setXv] = useState<any>(init.xv);
  const startEdit = () => { setCv(init.cv); setLv(init.lv); setXv(init.xv); setErr(null); setEdit(true); };
  const dirty = edit && (JSON.stringify(cv) !== JSON.stringify(init.cv) || JSON.stringify(lv) !== JSON.stringify(init.lv) || JSON.stringify(xv) !== JSON.stringify(init.xv));
  const setC = (k: string, v: unknown) => {
    setCv((x) => ({ ...x, [k]: v }));
    // a shared field goes onto every product too, so the two never disagree
    if (SHARED[k]) setLv((m) => Object.fromEntries(Object.entries(m).map(([id, x]) => [id, { ...x, [SHARED[k]]: v }])));
  };
  const setL = (id: string, k: string, v: unknown) => setLv((m) => ({ ...m, [id]: { ...m[id], [k]: v } }));
  const setX = (path: string, v: unknown) => setXv((x: any) => { const [a, b] = path.split("."); return b ? { ...x, [a]: { ...x[a], [b]: v } } : { ...x, [a]: v }; });
  const leave = () => { if (dirty) setAsk(true); else if (edit) setEdit(false); else onClose(); };
  const save = async () => {
    setBusy(true); setErr(null);
    const cvDirty = JSON.stringify(cv) !== JSON.stringify(init.cv) || JSON.stringify(xv) !== JSON.stringify(init.xv);
    if (cvDirty) {
      const extra: Record<string, any> = row.dealId ? {
        customer: { ...(cust ?? {}), ...xv.customer }, contactPerson: { ...(ct?.contactPerson ?? {}), ...xv.contactPerson }, adminUser: { ...(ct?.adminUser ?? {}), ...xv.adminUser },
        signatories: (xv.signatories as any[]).filter((x) => x.name || x.email).map((x) => ({ ...x, phone: null })),
        esignProvider: xv.esignProvider || null, esignId: xv.esignId || null, termsUrl: xv.termsUrl || null, noticeDays: xv.noticeDays ? Number(xv.noticeDays) : null,
      } : {};
      const r = await saveContractEditValues(row.dealId ?? null, ct, ls, cv, extra);
      if (r.error) { setBusy(false); setErr(r.error); return; }
    }
    // each product whose own values changed (the contract's shared ones are already on it), and the billing contact on all
    const billingChanged = xv.billingName !== init.xv.billingName || xv.billingEmail !== init.xv.billingEmail;
    for (const l of ls) {
      const v = { ...lv[l.id], ...(billingChanged ? { billingName: xv.billingName, billingEmail: xv.billingEmail } : {}) };
      if (JSON.stringify(lv[l.id]) === JSON.stringify(init.lv[l.id]) && !billingChanged) continue;
      const e = await saveLineEditValues(l, v);
      if (e) { setBusy(false); setErr(`${l.name}: ${e}`); return; }
    }
    setBusy(false);
    setEdit(false);
    onSaved?.();
  };
  const nextInc = row.incNext != null && row.incNext > 0.05 ? pct(row.incNext) : "";

  return (
    <ViewShell wide mode={edit ? "edit" : undefined}
      head={!edit ? <button type="button" className="scv-edit" onClick={startEdit}><Ico d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />Edit</button> : <span className="scv-editing">Editing</span>}
      footEnd={edit ? <>
        {err && <span className="scv-err">{err}</span>}
        <button type="button" className="ctm-btn" onClick={leave} disabled={busy}>Cancel</button>
        <button type="button" className="ctm-btn is-main" onClick={() => void save()} disabled={busy || !dirty}>{busy ? "Saving…" : "Save changes"}</button>
      </> : undefined}
      title={row.name} eyebrow={<>Contract · {row.clientName}{ref ? ` · No. ${ref}` : ""}</>} state={row.state} total={money(row.total)}
      sub={row.perYear > 0.5 ? `${money(row.perYear)} a year · year ${row.yearNo} of ${years}` : row.lastPerYear > 0.5 ? `${money(row.lastPerYear)} a year when it ended` : "One-time"} onClose={leave}
      side={edit ? (<>
        <ViewSec icon={ICO.co} title="Customer" sub="On the order form">
          <div className="scv-form">
            <F k="Legal name" wide><Txt v={xv.customer.legalName} on={(x) => setX("customer.legalName", x)} /></F>
            <F k="VAT"><Txt v={xv.customer.vat} on={(x) => setX("customer.vat", x)} /></F>
            <F k="Country"><Txt v={xv.customer.country} on={(x) => setX("customer.country", x)} /></F>
            <F k="Address" wide><Txt v={xv.customer.address} on={(x) => setX("customer.address", x)} /></F>
          </div>
        </ViewSec>
        <ViewSec icon={ICO.people} title="People">
          <div className="scv-form">
            <span className="scv-form-h">Contact person</span>
            <F k="Name"><Txt v={xv.contactPerson.name} on={(x) => setX("contactPerson.name", x)} /></F>
            <F k="Role"><Txt v={xv.contactPerson.role} on={(x) => setX("contactPerson.role", x)} /></F>
            <F k="E-mail"><Txt type="email" v={xv.contactPerson.email} on={(x) => setX("contactPerson.email", x)} /></F>
            <F k="Phone"><Txt v={xv.contactPerson.phone} on={(x) => setX("contactPerson.phone", x)} /></F>
            <span className="scv-form-h">Platform admin</span>
            <F k="Name"><Txt v={xv.adminUser.name} on={(x) => setX("adminUser.name", x)} /></F>
            <F k="E-mail"><Txt type="email" v={xv.adminUser.email} on={(x) => setX("adminUser.email", x)} /></F>
            <span className="scv-form-h">Billing contact <i>on every product</i></span>
            <F k="Name"><Txt v={xv.billingName} on={(x) => setX("billingName", x)} /></F>
            <F k="E-mail"><Txt type="email" v={xv.billingEmail} on={(x) => setX("billingEmail", x)} /></F>
          </div>
        </ViewSec>
        <ViewSec icon={ICO.sign} title="Signed" aside={<button type="button" className="scv-add" onClick={() => setX("signatories", [...xv.signatories, { name: "", role: "", email: "", side: "customer" }])}><Ico d="M12 5v14M5 12h14" />Signatory</button>}>
          <div className="scv-sigs">
            {(xv.signatories as any[]).map((p, i) => {
              const setP = (k: string, v: string) => setX("signatories", xv.signatories.map((x: any, j: number) => (j === i ? { ...x, [k]: v } : x)));
              return (
                <div className="scv-sig" key={i}>
                  <Pick v={p.side} on={(x) => setP("side", x)} opts={[["customer", "For the customer"], ["supplier", "For us"]]} />
                  <Txt v={p.name} on={(x) => setP("name", x)} ph="Name" />
                  <Txt v={p.role} on={(x) => setP("role", x)} ph="Role" />
                  <Txt type="email" v={p.email} on={(x) => setP("email", x)} ph="E-mail" />
                  <button type="button" className="scv-x" aria-label="Remove" onClick={() => setX("signatories", xv.signatories.filter((_: any, j: number) => j !== i))}><Ico d="M6 6l12 12M18 6L6 18" /></button>
                </div>
              );
            })}
            {!xv.signatories.length && <p className="scv-empty">No one yet — add who signed on each side.</p>}
          </div>
          <div className="scv-form">
            <F k="E-signature"><Txt v={xv.esignProvider} on={(x) => setX("esignProvider", x)} ph="Oneflow, DocuSign…" /></F>
            <F k="Its ID"><Txt v={xv.esignId} on={(x) => setX("esignId", x)} /></F>
            <F k="Terms link" wide><Txt v={xv.termsUrl} on={(x) => setX("termsUrl", x)} ph="https://" /></F>
          </div>
          {!row.dealId && <p className="scv-empty">Not signed on a deal: customer, people and signatures are kept on the deal's order form, so only the billing contact saves here.</p>}
        </ViewSec>
      </>) : <>
        <ViewSec icon={IC.tune} title="Terms" sub={ct ? "From the signed order form" : "From the signed products"}>
          <div className="scv-facts is-col">
            <Fact k="Length" v={years === 1 ? "1 year" : `${years} years`} sub={nonTerm ? `Can't be ended in the first ${nonTerm} year${nonTerm === 1 ? "" : "s"}` : undefined} />
            <Fact k="Renewal" v={autoRenew ? `Renews by itself${renewYears ? ` for ${renewYears} year${renewYears === 1 ? "" : "s"}` : ""}` : "Ends at the end of its term"} sub={noticeDays ? `${noticeDays} days' notice` : undefined} />
            <Fact k="Yearly increase" v={incMode === "pct" && incPct ? `+${incPct}% a year` : incMode === "amount" && incPct ? `+${money(incPct)} a year` : "None"} sub={rec.some((l) => scheduleOf(l)) ? "From year 2 on" : undefined} />
            <Fact k="Invoiced" v={billing ? billing.charAt(0).toUpperCase() + billing.slice(1) : "—"} sub={payDays ? `Due ${payDays} days after the invoice` : undefined} />
            <Fact k="Currency" v={s(ct?.currency) || s(ls[0]?.currency) || "EUR"} sub={ct?.pricesExclVat === false ? "Prices include VAT" : "Prices exclude VAT"} />
            {ct?.servicesBilling && <Fact k="Services billed" v={ct.servicesBilling === "per_day" ? "Per day worked" : s(ct.servicesBilling)} sub={[ct.servicesFrequency ? `${s(ct.servicesFrequency)}` : "", ct.servicesTolerancePct ? `±${ct.servicesTolerancePct}% tolerance` : ""].filter(Boolean).join(" · ") || undefined} />}
          </div>
        </ViewSec>
        {(cust || ct?.contactPerson || ct?.adminUser || billingContact) && (
          <ViewSec icon={ICO.co} title="Customer" sub={cust?.legalName || row.clientName}>
            {cust && (
              <div className="scv-facts is-col">
                {cust.legalName && <Fact k="Legal name" v={cust.legalName} />}
                {cust.vat && <Fact k="VAT" v={cust.vat} />}
                {(cust.address || cust.country) && <Fact k="Address" v={cust.address || "—"} sub={cust.country} />}
              </div>
            )}
            <div className="scv-people">
              <Person who="Contact person" name={ct?.contactPerson?.name} role={ct?.contactPerson?.role} email={ct?.contactPerson?.email} phone={ct?.contactPerson?.phone} />
              <Person who="Platform admin" name={ct?.adminUser?.name} email={ct?.adminUser?.email} />
              <Person who="Billing" name={billingContact?.billing_contact_name} email={billingContact?.billing_contact_email} />
            </div>
          </ViewSec>
        )}
        {(signatories.length > 0 || lineSigner || ct?.esignProvider || ct?.signedScope?.fileName || ct?.termsUrl) && (
          <ViewSec icon={ICO.sign} title="Signed" sub={row.signed ? day(row.signed) : undefined}>
            <div className="scv-people">
              {signatories.map((p, i) => <Person key={i} who={p.side === "supplier" ? "Signed for us" : "Signed for the customer"} name={p.name} role={p.role} email={p.email} phone={p.phone} />)}
              {!signatories.length && lineSigner && <Person who="Signed by" name={lineSigner.signatory_name} email={lineSigner.signatory_email} />}
            </div>
            <div className="scv-facts is-col">
              {ct?.esignProvider && <Fact k="E-signature" v={ct.esignProvider} sub={ct.esignId ? `ID ${ct.esignId}` : undefined} />}
              {ct?.signedScope?.fileName && <Fact k="Signed document" v={<span className="scv-file">{ct.signedScope.fileName}</span>} />}
              {ct?.termsUrl && <Fact k="Terms" v={<a href={ct.termsUrl} target="_blank" rel="noreferrer">{String(ct.termsUrl).replace(/^https?:\/\//, "")}</a>} />}
            </div>
          </ViewSec>
        )}
        {notes.length > 0 && (
          <ViewSec icon={ICO.note} title="Notes">
            {notes.map((n, i) => <p key={i} className="scv-note">{n}</p>)}
          </ViewSec>
        )}
      </>}
      foot={<>
        {onOpenDeal && <button type="button" className="ctm-btn" onClick={onOpenDeal}>Open the deal{row.dealName ? ` · ${row.dealName}` : ""}</button>}
        {onOpenClient && <button type="button" className="ctm-btn is-main" onClick={onOpenClient}>Open in {row.clientName}</button>}
      </>}>
      {edit ? (
        <ViewSec icon={IC.tune} title="The contract" sub="Shared by all its products — a change here goes onto each of them">
          <div className="scv-form is-grid">
            <F k="Signed"><Day v={cv.signDate} on={(x) => setC("signDate", x)} /></F>
            <F k="Starts" hint="After a grace period, if later than signed"><Day v={cv.contractStart} on={(x) => setC("contractStart", x)} /></F>
            <F k="Length"><Num v={cv.termYears} on={(x) => setC("termYears", x)} suffix="years" /></F>
            <F k="Can't be ended in the first"><Num v={cv.nonTerminableYears} on={(x) => setC("nonTerminableYears", x)} suffix="years" /></F>
            <F k="Renews by itself"><span className="scv-sw"><Sw on={!!cv.autoRenew} onChange={(x) => setC("autoRenew", x)} label={cv.autoRenew ? "Yes" : "No"} /></span></F>
            {cv.autoRenew && <F k="Renews for"><Num v={cv.renewYears} on={(x) => setC("renewYears", x)} suffix="years" /></F>}
            {cv.autoRenew && <F k="Notice"><Num v={xv.noticeDays} on={(x) => setX("noticeDays", x)} suffix="days" /></F>}
            <F k="Invoiced"><Pick v={cv.billingFrequency} on={(x) => setC("billingFrequency", x)} opts={[["annually", "Annually"], ["semiannually", "Every 6 months"], ["quarterly", "Quarterly"], ["monthly", "Monthly"], ["upfront", "All upfront"]]} /></F>
            <F k="Due"><Num v={cv.paymentTermsDays} on={(x) => setC("paymentTermsDays", x)} suffix="days" /></F>
            <F k="Contract No."><Txt v={cv.contractRef} on={(x) => setC("contractRef", x)} /></F>
            <F k="Currency"><Pick v={cv.currency} on={(x) => setC("currency", x)} opts={[["EUR", "EUR"], ["USD", "USD"], ["GBP", "GBP"], ["CHF", "CHF"]]} /></F>
            <F k="Notes" wide><textarea className="scv-in is-area" rows={3} value={s(cv.notes)} onChange={(e) => setC("notes", e.target.value)} /></F>
          </div>
        </ViewSec>
      ) : (
      <ViewSec icon={ICO.glance} title="At a glance">
        <div className="scv-facts is-grid">
          <Fact tone="big" k="Contract value" v={money(row.total)} sub={listTotal > finalLic && finalLic > 0 ? `List ${money(listTotal + (Number(ct?.services?.list) || 0))} · ${money(discLic + (Number(ct?.services?.discount) || 0))} off` : `${ls.length} product${ls.length === 1 ? "" : "s"}`} />
          <Fact tone="big" k={row.perYear > 0.5 ? `This year · year ${row.yearNo}` : "A year"} v={row.perYear > 0.5 ? money(row.perYear) : row.lastPerYear > 0.5 ? money(row.lastPerYear) : "—"}
            sub={sofar ? <span className="is-up">{sofar} vs year 1</span> : nextInc ? `${nextInc} from year ${row.yearNo + 1}` : row.perYear > 0.5 ? "net to us, a year" : row.lastPerYear > 0.5 ? "when it ended" : "one-time"} />
          <Fact k="Signed" v={day(row.signed)} sub={grace ? `${grace} days' grace` : undefined} />
          <Fact k="Starts" v={day(row.start)} sub={row.state === "In grace period" ? `in ${Math.ceil((+new Date(row.start!) - now) / DAY)} days` : undefined} />
          <Fact k={row.renews ? "Renews" : "Ends"} v={day(row.end || (term ? iso(term.end.getTime()) : null))} sub={renew ? (renew.left >= 0 ? `in ${renew.left} days` : "") : undefined} />
          <Fact k="Services" v={svcTotal ? money(svcTotal) : "—"} sub={svcLines.length ? `${svcLines.length} item${svcLines.length === 1 ? "" : "s"}, one-time` : "none sold with it"} />
        </div>
      </ViewSec>
      )}

      <ViewSec icon={ICO.years} title="Year by year" sub={rec.length ? `${years} contract year${years === 1 ? "" : "s"} from ${day(iso(s0))}` : "One-off"}>
        <div className="scv-table" role="table">
          <div className="scv-tr is-head" role="row">
            <span>Year</span><span>Period</span><span className="is-r">Recurring</span><span className="is-r">Increase</span><span className="is-r">One-time</span><span className="is-r">Partner</span><span className="is-r">Net to us</span>
          </div>
          {yearRows.map((r) => {
            const prev = r.y > 0 ? yearRows[r.y - 1].recurring : 0;
            const up = prev > 0.5 && r.recurring > prev * 1.0005 ? ((r.recurring / prev - 1) * 100) : 0;
            const on = r.y === curIdx && row.state === "Running";
            return (
              <div className={`scv-tr ${on ? "is-now" : ""} ${r.to < now ? "is-past" : ""}`} role="row" key={r.y}>
                <span><b>Year {r.y + 1}</b>{on && <i className="scv-now">now</i>}</span>
                <span className="scv-d">{day(iso(r.from))} – {day(iso(r.to))}</span>
                <span className="is-r"><b>{r.recurring ? money(r.recurring) : "—"}</b></span>
                <span className={`is-r ${up ? "is-up" : ""}`}>{up ? pct(up) : "—"}</span>
                <span className="is-r">{r.once ? money(r.once) : "—"}</span>
                <span className="is-r">{r.partner ? `−${money(r.partner)}` : "—"}</span>
                <span className="is-r"><b>{money(r.net)}</b></span>
              </div>
            );
          })}
          <div className="scv-tr is-foot" role="row">
            <span><b>Total</b></span><span />
            <span className="is-r"><b>{money(yearRows.reduce((t, r) => t + r.recurring, 0))}</b></span><span />
            <span className="is-r">{yearRows.some((r) => r.once) ? money(yearRows.reduce((t, r) => t + r.once, 0)) : "—"}</span>
            <span className="is-r">{yearRows.some((r) => r.partner) ? `−${money(yearRows.reduce((t, r) => t + r.partner, 0))}` : "—"}</span>
            <span className="is-r"><b>{money(yearRows.reduce((t, r) => t + r.net, 0))}</b></span>
          </div>
        </div>
      </ViewSec>

      {edit ? (
        <ViewSec icon={ICO.box} title="Products" sub="Each product's own price, dates and terms">
          <div className="scv-prods">
            {ls.map((l) => {
              const v = lv[l.id] ?? {};
              const set = (k: string, x: unknown) => setL(l.id, k, x);
              const rec2 = v.billing !== "once";
              return (
                <div className="scv-prod is-edit" key={l.id}>
                  <div className="scv-prod-h">
                    <span className="ctm-item-ini" aria-hidden="true">{s(l.name).slice(0, 1).toUpperCase() || "?"}</span>
                    <span className="scv-prod-t"><b>{l.name}</b><em>{rec2 ? "Recurring" : "One-time"}</em></span>
                    <span className="scv-in-sel is-status"><Select size="sm" value={s(v.status)} onChange={(x) => set("status", x)} options={[{ value: "active", label: "Active" }, { value: "cancelled", label: "Stopped" }]} /></span>
                  </div>
                  <div className="scv-form is-grid">
                    <F k="Billed"><Pick v={v.billing} on={(x) => set("billing", x)} opts={[["yearly", "Yearly"], ["monthly", "Monthly"], ["once", "Once"]]} /></F>
                    <F k={v.billing === "monthly" ? "Price a month" : v.billing === "once" ? "Price" : "Price a year"} hint={rec2 ? "Year 1, before increases" : undefined}><Num v={v.amount} on={(x) => set("amount", x)} suffix="€" /></F>
                    <F k="Set-up fee"><Num v={v.fee} on={(x) => set("fee", x)} suffix="€" /></F>
                    <F k="Signed"><Day v={v.signing} on={(x) => set("signing", x)} /></F>
                    <F k="Starts"><Day v={v.start} on={(x) => set("start", x)} /></F>
                    {rec2 && <F k="Length"><Num v={v.term} on={(x) => set("term", x)} suffix="years" /></F>}
                    {rec2 && <F k="Yearly increase"><Num v={v.inc} on={(x) => set("inc", x)} suffix="%" /></F>}
                    {rec2 && <F k="Renews by itself"><span className="scv-sw"><Sw on={!!v.autoRenew} onChange={(x) => set("autoRenew", x)} label={v.autoRenew ? "Yes" : "No"} /></span></F>}
                    {rec2 && v.autoRenew && <F k="Renews for"><Num v={v.renew} on={(x) => set("renew", x)} suffix="years" /></F>}
                    <F k="Partner's cut"><Pick v={v.pMode} on={(x) => set("pMode", x)} opts={[["none", "None"], ["percent", "% of each year"], ["amount", "Amount a year"], ["once", "Once"]]} /></F>
                    {v.pMode !== "none" && <F k={v.pMode === "percent" ? "Partner %" : "Partner amount"}><Num v={v.pValue} on={(x) => set("pValue", x)} suffix={v.pMode === "percent" ? "%" : "€"} /></F>}
                    <F k="Notes" wide><Txt v={v.notes} on={(x) => set("notes", x)} /></F>
                  </div>
                </div>
              );
            })}
          </div>
        </ViewSec>
      ) : (
      <ViewSec icon={ICO.box} title="Products" sub={`${ls.length} signed product${ls.length === 1 ? "" : "s"}`} aside={<span className="ctm-sec-fig">{money(ls.reduce((t, l) => t + lineContractValue(l), 0))}<em>in all</em></span>}>
        <div className="scv-prods">
          {ls.map((l) => {
            const rows = Array.isArray(l.breakdown?.rows) ? (l.breakdown.rows as any[]) : [];
            const yrs = l.recurring ? Array.from({ length: Math.ceil((Number(l.term_years) || 1) - 1e-9) }, (_, y) => lineYearGross(l, y) - (y === 0 ? Number(l.one_time_fee) || 0 : 0)) : [];
            const gross = Number(l.breakdown?.gross) || 0, final = Number(l.breakdown?.total) || 0;
            const disc = gross > final && final > 0 ? Math.round((1 - final / gross) * 1000) / 10 : 0;
            const r = renewalOf(l, ct);
            const per = periodsAYear(l.period);
            return (
              <div className={`scv-prod ${isActive(l) ? "" : "is-off"}`} key={l.id}>
                <div className="scv-prod-h">
                  <span className="ctm-item-ini" aria-hidden="true">{s(l.name).slice(0, 1).toUpperCase() || "?"}</span>
                  <span className="scv-prod-t">
                    <b>{l.name}</b>
                    <em>{[l.recurring ? `Recurring · ${periodLabel(l.period)}ly` : "One-time", Number(l.quantity) > 1 ? `× ${l.quantity}` : null, l.term_years ? `${l.term_years} year${Number(l.term_years) === 1 ? "" : "s"}` : null, isActive(l) ? null : "stopped", r ? `renews ${day(iso(r.end.getTime()))}` : null].filter(Boolean).join(" · ")}</em>
                  </span>
                  <span className="scv-prod-f">
                    <b>{money(l.recurring ? lineAnnual(l) || firstYearOf(l) - partnerCut(l, 0) : lineContractValue(l))}</b>
                    <em>{l.recurring ? `a year now${lineAnnualGross(l) - lineAnnual(l) > 0.5 ? ` · ${money(lineAnnualGross(l))} before partner` : ""}` : "once"}</em>
                  </span>
                </div>
                <div className="scv-prod-k">
                  <Fact k="Price" v={`${money(Number(l.price) || 0)}${l.recurring && per !== 1 ? ` / ${periodLabel(l.period)}` : l.recurring ? " / year" : ""}`} sub={Number(l.list_price) ? `List ${money(Number(l.list_price))}` : undefined} />
                  {disc > 0 && <Fact k="Discount" v={`−${disc.toLocaleString("de-DE")}%`} sub={`${money(gross - final)} over the term`} />}
                  {l.recurring && <Fact k="Over the term" v={money(lineContractValue(l))} sub={partnerTotal(l) ? `partner −${money(partnerTotal(l))}` : undefined} />}
                  {Number(l.one_time_fee) > 0 && <Fact k="Set-up fee" v={money(Number(l.one_time_fee))} />}
                  {!l.recurring && <Fact k="Total" v={money(lineTotal(l))} />}
                  <Fact k="Starts" v={day(l.start_date || l.signing_date)} sub={l.ends_on ? `ended ${day(l.ends_on)}` : undefined} />
                </div>
                {yrs.length > 1 && (
                  <div className="scv-yrs" aria-label="Each year">
                    {yrs.map((v, y) => {
                      const up = y > 0 && yrs[y - 1] > 0.5 && v > yrs[y - 1] * 1.0005 ? (v / yrs[y - 1] - 1) * 100 : 0;
                      return <span key={y} className={y === curIdx && row.state === "Running" ? "is-now" : ""}><em>Y{y + 1}</em><b>{money(v)}</b>{up ? <i>{pct(up)}</i> : null}</span>;
                    })}
                  </div>
                )}
                {rows.length > 0 && (
                  <div className="scv-rows">
                    {rows.map((x, i) => (
                      <div key={i} className="scv-row">
                        <span>{x.label}{x.detail ? <em>{x.detail}</em> : null}</span>
                        <span className="is-r">{money(Number(x.amount) || 0)}</span>
                        <span className="is-r is-off">{Number(x.discount) ? `−${money(Number(x.discount))}` : ""}</span>
                        <span className="is-r"><b>{money(Math.max(0, (Number(x.amount) || 0) - (Number(x.discount) || 0)))}</b></span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ViewSec>
      )}

      {svcLines.length > 0 && (
        <ViewSec icon={ICO.svc} title="Services sold with it" sub={ct?.servicesNote ? undefined : "One-time, delivered as a project"} aside={<span className="ctm-sec-fig">{money(svcTotal)}<em>one-time</em></span>}>
          <div className="scv-prods">
            {svcLines.map((x, i) => (
              <div className="scv-prod" key={x.id ?? i}>
                <div className="scv-prod-h">
                  <span className="ctm-item-ini is-svc" aria-hidden="true">{s(x.name).slice(0, 1).toUpperCase() || "S"}</span>
                  <span className="scv-prod-t"><b>{x.name}</b><em>{[x.qty ? `${x.qty} ${x.unit === "day" ? "days" : x.unit || ""}`.trim() : null, x.discountPct ? `−${x.discountPct}%` : null].filter(Boolean).join(" · ")}</em></span>
                  <span className="scv-prod-f"><b>{money(Number(x.final) || 0)}</b><em>{Number(x.list) > Number(x.final) ? `list ${money(Number(x.list))}` : "one-time"}</em></span>
                </div>
                {Array.isArray(x.rows) && x.rows.length > 0 && (
                  <div className="scv-rows">
                    {(x.rows as any[]).map((rr, j) => (
                      <div key={j} className="scv-row">
                        <span>{rr.label}{rr.detail ? <em>{rr.detail}</em> : null}</span>
                        <span className="is-r">{money(Number(rr.amount) || 0)}</span>
                        <span className="is-r is-off">{Number(rr.discount) ? `−${money(Number(rr.discount))}` : ""}</span>
                        <span className="is-r"><b>{money(Math.max(0, (Number(rr.amount) || 0) - (Number(rr.discount) || 0)))}</b></span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </ViewSec>
      )}
      {ask && (
        <ContractConfirm title="Discard your changes?" body="What you changed in this contract hasn't been saved."
          actions={[{ label: "Discard", tone: "danger", onClick: () => { setAsk(false); setEdit(false); } }, { label: "Save changes", tone: "main", onClick: () => { setAsk(false); void save(); } }]}
          onCancel={() => setAsk(false)} />
      )}
      {!ls.length && <p className="ctf-empty"><Ico d={IC.inv} /> Nothing signed in it yet.</p>}
    </ViewShell>
  );
}
