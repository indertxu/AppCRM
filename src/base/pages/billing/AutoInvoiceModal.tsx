/* =====================================================================
   BASE · Billing — when invoices are made.
   Automatic: on the month's cutoff (its last day, or a set day) every client
   with work or shipments up to it gets its invoice the next morning —
   as a draft to review, or sent at once (base_billing_tick, sql 104).
   Bill now: the same, by hand, up to any day.
   ===================================================================== */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../framework/DatePicker";
import Select from "../../framework/Select";
import { IC } from "./InvoiceModal";
import {
  addDays, billNow, fmtDate, hourlyRate, lastCutoff, loadRuns, money, money0, nextCutoff, round2, saveAutoSettings, todayIso,
  type AutoSettings, type BClient, type BillingRun, type CatItem, type WorkEntry,
} from "./billingApi";

interface Props {
  settings: AutoSettings;
  unbilled: WorkEntry[];
  clients: Map<string, BClient>;
  catalog: CatItem[];
  onClose: () => void;
  onSaved: (s: AutoSettings) => void;
  /** Invoices were made: the lists reload. */
  onBilled: () => void;
}

const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const DAYS = Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `Day ${i + 1}` }));
const nth = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

export default function AutoInvoiceModal({ settings, unbilled, clients, catalog, onClose, onSaved, onBilled }: Props) {
  const [s, setS] = useState<AutoSettings>(settings);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [runs, setRuns] = useState<BillingRun[]>([]);
  const [upTo, setUpTo] = useState(() => lastCutoff(settings.cutoff_day));
  const [closing, setClosing] = useState(false);
  useEffect(() => { loadRuns().then(setRuns).catch(() => {}); }, []);
  const close = () => { setClosing(true); setTimeout(onClose, 200); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".sel-layer, .dp-layer")) close(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const next = nextCutoff(s.cutoff_day);
  /** What a run up to a day would bill, from what's unbilled now. */
  const estimate = (to: string) => {
    const by = new Map<string, number>();
    unbilled.filter((e) => e.date <= to).forEach((e) => {
      const c = clients.get(e.client_id);
      const v = e.kind === "client_work" ? e.hours * hourlyRate(c, catalog)
        : (e.quantity || 1) * (e.unit_price || catalog.find((x) => x.kind === "product" && x.id === e.product_id)?.price || 0);
      by.set(e.client_id, (by.get(e.client_id) ?? 0) + v);
    });
    return { clients: by.size, net: round2(Array.from(by.values()).reduce((a, b) => a + b, 0)) };
  };
  const soFar = useMemo(() => estimate(next), [unbilled, next]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = useMemo(() => estimate(upTo), [unbilled, upTo]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = s.auto_invoice !== settings.auto_invoice || s.cutoff_day !== settings.cutoff_day || s.auto_send !== settings.auto_send;

  const save = async () => {
    setBusy("save"); setErr(null);
    try { const saved = await saveAutoSettings(s, settings); onSaved(saved); close(); } catch (e: any) { setErr(e?.message ?? String(e)); }
    setBusy(null);
  };
  const runNow = async () => {
    setBusy("run"); setErr(null); setMsg(null);
    try {
      const r = await billNow(upTo, s.auto_send);
      setMsg(r.invoices ? `${r.invoices} invoice${r.invoices === 1 ? "" : "s"} made for ${money(r.net)} (before tax)${s.auto_send ? " and marked as sent" : " — drafts, in To invoice"}.` : "Nothing to bill up to that day.");
      onBilled(); loadRuns().then(setRuns).catch(() => {});
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    setBusy(null);
  };

  return createPortal(
    <div className={`bzi-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="bzi-modal bza-modal" role="dialog" aria-modal="true" aria-label="Automatic invoices">
        <header className="bzi-head">
          <div className="bzi-head-t">
            <span className="bzi-kicker">Billing</span>
            <div className="bzi-head-row"><h2>When invoices are made</h2></div>
          </div>
          <button className="bzi-x" onClick={close} aria-label="Close"><Ico d={IC.x} s={18} /></button>
        </header>
        <div className="bzi-body bza-body">
          <button type="button" className={`bza-switch ${s.auto_invoice ? "is-on" : ""}`} onClick={() => setS({ ...s, auto_invoice: !s.auto_invoice })}>
            <i />
            <span><b>Make the invoices automatically</b><small>On each cutoff, every client with work or shipments up to it gets its invoice the next morning.</small></span>
          </button>

          <div className={`bza-opts ${s.auto_invoice ? "" : "is-off"}`}>
            <div className="bza-field">
              <span className="bzi-lbl">Cutoff of the month</span>
              <div className="bza-seg">
                <button className={s.cutoff_day === 0 ? "is-on" : ""} onClick={() => setS({ ...s, cutoff_day: 0 })}>Last day of the month</button>
                <button className={s.cutoff_day > 0 ? "is-on" : ""} onClick={() => setS({ ...s, cutoff_day: s.cutoff_day || 25 })}>A set day</button>
                {s.cutoff_day > 0 && (
                  <span className="bza-day"><Select size="sm" value={String(s.cutoff_day)} onChange={(v) => setS({ ...s, cutoff_day: Number(v) })} options={DAYS} aria-label="Cutoff day" /></span>
                )}
              </div>
              <small className="bza-hint">{s.cutoff_day ? `Work up to the ${nth(s.cutoff_day)} goes on that month's invoice; from the ${nth(s.cutoff_day + 1)} on, on the next one.` : "Each calendar month is billed on its own."}</small>
            </div>
            <div className="bza-field">
              <span className="bzi-lbl">They're made as</span>
              <div className="bza-cards">
                <button className={!s.auto_send ? "is-on" : ""} onClick={() => setS({ ...s, auto_send: false })}>
                  <b>Drafts to review</b><small>You check them and press Send.</small>
                </button>
                <button className={s.auto_send ? "is-on" : ""} onClick={() => setS({ ...s, auto_send: true })}>
                  <b>Sent straight away</b><small>Marked as sent, ready to e-mail or print.</small>
                </button>
              </div>
            </div>
            <div className="bza-next">
              <Ico d={IC.clock} s={18} />
              <span>
                <b>Next cutoff {fmtDate(next)}</b> — invoices made on {fmtDate(addDays(next, 1))}.
                <small>{soFar.clients ? `Right now that would be ${money0(soFar.net)} for ${soFar.clients} client${soFar.clients === 1 ? "" : "s"}, before tax.` : "Nothing is waiting to be billed yet."}</small>
              </span>
            </div>
          </div>

          <div className="bza-now">
            <div className="bza-now-t">
              <b>Bill now</b>
              <small>Make the invoices for everything logged up to a day, without waiting for the cutoff.</small>
            </div>
            <div className="bza-now-row">
              <span className="bza-now-lbl">Up to</span>
              <DatePicker value={upTo} onChange={setUpTo} maxDate={todayIso()} />
              <span className="bza-now-est">{now.clients ? <>{money0(now.net)} · {now.clients} client{now.clients === 1 ? "" : "s"}</> : "Nothing to bill"}</span>
              <button className="bzi-btn is-primary" disabled={!!busy || !now.clients} onClick={runNow}>{busy === "run" ? "Making them…" : "Make invoices"}</button>
            </div>
            {msg && <p className="bza-msg">{msg}</p>}
          </div>

          {runs.length > 0 && (
            <div className="bza-runs">
              <span className="bzi-lbl">Recent runs</span>
              {runs.map((r) => (
                <div key={r.id}><em>{r.auto ? "Automatic" : "By hand"}</em><span>up to {fmtDate(r.cutoff)}</span><span>{r.invoices} invoice{r.invoices === 1 ? "" : "s"}</span><b>{money(r.net)}</b><small>{fmtDate(r.created_at.slice(0, 10))}</small></div>
              ))}
            </div>
          )}
          {err && <p className="bzi-err">{/function|does not exist|relation/i.test(err) ? "This needs src/base/sql/104_base_auto_invoices.sql in Supabase." : err}</p>}
        </div>
        <footer className="bzi-actions">
          <span className="bzi-sp" />
          <button className="bzi-btn" onClick={close}>Close</button>
          <button className="bzi-btn is-primary" disabled={!!busy || !dirty} onClick={save}>{busy === "save" ? "Saving…" : "Save"}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
