/* =====================================================================
   BASE · Billing — when invoices are made.
   Automatic: on the month's cutoff (its last day, a set day, or N days before
   the month ends) every client
   with work or shipments up to it gets its invoice the next morning —
   as a draft to review, or sent at once (base_billing_tick, sql 104).
   Bill now: the same, by hand, up to any day.
   ===================================================================== */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import DatePicker from "../../framework/DatePicker";
import { IC } from "./InvoiceModal";
import {
  addDays, billNow, cutoffOf, fmtDate, hourlyRate, lastCutoff, loadRuns, money, money0, nextCutoff, round2, saveAutoSettings, todayIso,
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
const monthOf = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { month: "short" });
const nth = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

export default function AutoInvoiceModal({ settings, unbilled, clients, catalog, onClose, onSaved, onBilled }: Props) {
  const [s, setS] = useState<AutoSettings>(settings);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [runs, setRuns] = useState<BillingRun[]>([]);
  const [upTo, setUpTo] = useState(() => lastCutoff(settings.cutoff_day));
  const [closing, setClosing] = useState(false);
  const [nowSend, setNowSend] = useState(settings.auto_send);
  useEffect(() => { loadRuns().then(setRuns).catch(() => {}); }, []);
  const close = () => { setClosing(true); setTimeout(onClose, 200); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".sel-layer, .dp-layer")) close(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const next = nextCutoff(s.cutoff_day);
  const mode: "last" | "day" | "before" = s.cutoff_day === 0 ? "last" : s.cutoff_day > 0 ? "day" : "before";
  /** This month's cutoff and the next two, to see where it lands. */
  const preview = useMemo(() => {
    const out: string[] = [];
    let d = todayIso().slice(0, 8) + "01";
    for (let i = 0; i < 3; i++) { out.push(cutoffOf(d, s.cutoff_day)); const [y, m] = d.split("-").map(Number); d = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`; }
    return out;
  }, [s.cutoff_day]);
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
      const r = await billNow(upTo, nowSend);
      setMsg(r.invoices ? `${r.invoices} invoice${r.invoices === 1 ? "" : "s"} made for ${money(r.net)} (before tax)${nowSend ? " and marked as sent" : " — drafts, in To invoice"}.` : "Nothing to bill up to that day.");
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
          {/* ---- 1 · automatic: the month's cutoff ---- */}
          <section className={`bza-part is-auto ${s.auto_invoice ? "is-on" : ""}`} aria-label="Automatic invoices">
            <button type="button" className="bza-part-h" onClick={() => setS({ ...s, auto_invoice: !s.auto_invoice })} aria-pressed={s.auto_invoice}>
              <span className="bza-part-ico"><Ico d={IC.clock} s={17} /></span>
              <span className="bza-part-t"><b>Make the invoices automatically</b><small>On each cutoff, every client with work or shipments up to it gets its invoice the next morning.</small></span>
              <i className="bza-toggle" />
            </button>

            <div className={`bza-opts ${s.auto_invoice ? "" : "is-off"}`}>
              <div className="bza-field">
                <span className="bzi-lbl">Cutoff of the month</span>
                <div className="bza-modes" role="radiogroup" aria-label="Cutoff">
                  <button type="button" role="radio" aria-checked={mode === "last"} className={mode === "last" ? "is-on" : ""} onClick={() => setS({ ...s, cutoff_day: 0 })}>
                    <b>Last day</b><small>of each month</small>
                  </button>
                  <button type="button" role="radio" aria-checked={mode === "day"} className={mode === "day" ? "is-on" : ""} onClick={() => setS({ ...s, cutoff_day: s.cutoff_day > 0 ? s.cutoff_day : 25 })}>
                    <b>A set day</b><small>{s.cutoff_day > 0 ? `the ${nth(s.cutoff_day)}` : "e.g. the 25th"}</small>
                  </button>
                  <button type="button" role="radio" aria-checked={mode === "before"} className={mode === "before" ? "is-on" : ""} onClick={() => setS({ ...s, cutoff_day: s.cutoff_day < 0 ? s.cutoff_day : -10 })}>
                    <b>Before the month ends</b><small>{s.cutoff_day < 0 ? `${-s.cutoff_day} day${s.cutoff_day === -1 ? "" : "s"} before` : "e.g. 10 days before"}</small>
                  </button>
                </div>

                {mode === "day" && (
                  <div className="bza-pick" key="day">
                    <div className="bza-days" role="radiogroup" aria-label="Day of the month">
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                        <button key={d} type="button" role="radio" aria-checked={s.cutoff_day === d} className={s.cutoff_day === d ? "is-on" : ""} onClick={() => setS({ ...s, cutoff_day: d })}>{d}</button>
                      ))}
                    </div>
                    <small className="bza-days-note">Up to the 28th, so it exists every month.</small>
                  </div>
                )}
                {mode === "before" && (
                  <div className="bza-pick is-before" key="before">
                    <div className="bza-step">
                      <button type="button" onClick={() => setS({ ...s, cutoff_day: Math.min(-1, s.cutoff_day + 1) })} disabled={s.cutoff_day >= -1} aria-label="One day less">−</button>
                      <input type="number" min={1} max={27} value={-s.cutoff_day} aria-label="Days before the month ends"
                        onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 27) setS({ ...s, cutoff_day: -n }); }} />
                      <button type="button" onClick={() => setS({ ...s, cutoff_day: Math.max(-27, s.cutoff_day - 1) })} disabled={s.cutoff_day <= -27} aria-label="One day more">+</button>
                    </div>
                    <span className="bza-step-l">day{s.cutoff_day === -1 ? "" : "s"} before the last day of the month</span>
                    <div className="bza-quick">
                      {[3, 5, 7, 10, 15].map((n) => (
                        <button key={n} type="button" className={s.cutoff_day === -n ? "is-on" : ""} onClick={() => setS({ ...s, cutoff_day: -n })}>{n}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="bza-preview">
                  {preview.map((d) => <span key={d}><em>{monthOf(d)}</em><b>{fmtDate(d).replace(/ \d{4}$/, "")}</b></span>)}
                  <small>{mode === "last" ? "Each calendar month is billed on its own." : mode === "day" ? `Work up to the ${nth(s.cutoff_day)} goes on that month's invoice; from the ${nth(s.cutoff_day + 1)} on, on the next one.` : "It moves with the month's length — the same distance from its end every month."}</small>
                </div>
              </div>

              <div className="bza-field">
                <span className="bzi-lbl">They're made as</span>
                <div className="bza-cards">
                  <button type="button" className={!s.auto_send ? "is-on" : ""} onClick={() => setS({ ...s, auto_send: false })}>
                    <b>Drafts to review</b><small>You check them and press Send.</small>
                  </button>
                  <button type="button" className={s.auto_send ? "is-on" : ""} onClick={() => setS({ ...s, auto_send: true })}>
                    <b>Sent straight away</b><small>Marked as sent, ready to e-mail or print.</small>
                  </button>
                </div>
              </div>
            </div>

            <div className="bza-part-foot">
              <div className="bza-next">
                <Ico d={IC.clock} s={16} />
                <span>
                  <span className="bza-next-l">{s.auto_invoice ? <><b>Next cutoff {fmtDate(next)}</b> · invoices on {fmtDate(addDays(next, 1))}</> : <b>Off — nothing is made on its own</b>}</span>
                  <small>{soFar.clients ? `Right now that would be ${money0(soFar.net)} for ${soFar.clients} client${soFar.clients === 1 ? "" : "s"}, before tax.` : "Nothing is waiting to be billed yet."}</small>
                </span>
              </div>
              <button type="button" className="bzi-btn is-primary" disabled={!!busy || !dirty} onClick={save}>{busy === "save" ? "Saving…" : dirty ? "Save" : "Saved"}</button>
            </div>
          </section>

          {/* ---- 2 · by hand, now ---- */}
          <section className="bza-part is-now" aria-label="Bill now">
            <div className="bza-part-h is-static">
              <span className="bza-part-ico is-now"><Ico d={IC.send} s={16} /></span>
              <span className="bza-part-t"><b>Bill now</b><small>Make the invoices for everything logged up to a day, without waiting for the cutoff.</small></span>
            </div>
            <div className="bza-now-grid">
              <label className="bza-now-f"><span className="bzi-lbl">Up to</span><DatePicker value={upTo} onChange={setUpTo} maxDate={todayIso()} /></label>
              <div className="bza-now-f"><span className="bzi-lbl">Made as</span>
                <div className="bza-mini">
                  <button type="button" className={!nowSend ? "is-on" : ""} onClick={() => setNowSend(false)}>Drafts</button>
                  <button type="button" className={nowSend ? "is-on" : ""} onClick={() => setNowSend(true)}>Sent</button>
                </div>
              </div>
              <div className="bza-now-est">{now.clients ? <><b>{money0(now.net)}</b><small>{now.clients} client{now.clients === 1 ? "" : "s"} · before tax</small></> : <small>Nothing to bill up to that day</small>}</div>
              <button type="button" className="bzi-btn is-primary bza-now-go" disabled={!!busy || !now.clients} onClick={runNow}>{busy === "run" ? "Making them…" : "Make invoices"}</button>
            </div>
            {msg && <p className="bza-msg">{msg}</p>}
          </section>

          {runs.length > 0 && (
            <div className="bza-runs">
              <span className="bzi-lbl">Recent runs</span>
              {runs.map((r) => (
                <div key={r.id}><em className={r.auto ? "is-auto" : ""}>{r.auto ? "Automatic" : "By hand"}</em><span>up to {fmtDate(r.cutoff)}</span><span>{r.invoices} invoice{r.invoices === 1 ? "" : "s"}</span><b>{money(r.net)}</b><small>{fmtDate(r.created_at.slice(0, 10))}</small></div>
              ))}
            </div>
          )}
          {err && <p className="bzi-err">{/function|does not exist|relation|check constraint/i.test(err) ? "This needs src/base/sql/104_base_auto_invoices.sql and 143_base_cutoff_before_month_end.sql in Supabase." : err}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
