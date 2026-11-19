/* =====================================================================
   BASE · Billing › Workflows — what happens to an invoice once it exists.
     Workflows   when (the billing day, an invoice is sent, before it's due,
                 when it's overdue), which clients, issued by which company,
                 sent from which mailbox, with which e-mail and which PDF.
                 Checked top to bottom: the first that fits an invoice sends it.
     Blueprints  how the invoice PDF looks (layout, colour, language, texts) and
                 its default e-mail — previewed live with the PDF the client gets.
     Companies   who issues the invoices (legal name, tax ID, address, IBAN, logo).
   Data: SQL 156 · sending + PDF: edge function "billing-flows".
   ===================================================================== */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Select from "../../../framework/Select";
import { myConnections, type MailAcct } from "../../../../components/api/marketingHub";
import ClientLogo from "../ClientLogo";
import PdfPaper from "./PdfPaper";
import { fmtDate, money, type BClient, type Invoice } from "../billingApi";
import {
  DEFAULT_MAIL, DESIGN_DEFAULT, ENTITY_EMPTY, MAIL_VARS, TRIGGER_LABEL, flowEmpty, loadFlowsAll, loadMkTemplates, makeDefault, needsSql, pdfOf,
  removeRow, reorderFlows, runFlow, saveBlueprint, saveEntity, saveFlow, testFlow, triggerText,
  type AudMode, type BillFlow, type Blueprint, type Entity, type FlowSend, type FlowTrigger, type MkTpl, type PdfDesign,
} from "./flowsApi";
import "./BillingFlows.css";

type Tab = "flows" | "blueprints" | "companies";
const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  flow: "M5 3v6M5 15v6M5 9a3 3 0 0 0 3 3h8a3 3 0 0 1 3 3v6M19 3v6",
  doc: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
  building: "M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1",
  plus: "M12 5v14M5 12h14",
  cal: "M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  up: "M18 15l-6-6-6 6", down: "M6 9l6 6 6-6", right: "M9 18l6-6-6-6",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  play: "M5 3l14 9-14 9z", trash: "M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z",
  check: "M20 6 9 17l-5-5", x: "M18 6 6 18M6 6l12 12", download: "M12 3v12M7 10l5 5 5-5M5 21h14",
};
const TRIG_ICON: Record<FlowTrigger, string> = { billing_day: I.cal, issued: I.send, before_due: I.bell, overdue: I.alert };
const TRIG_HINT: Record<FlowTrigger, string> = {
  billing_day: "The invoices the monthly cutoff makes go out to each client",
  issued: "Any invoice, by hand or automatic, once it's marked sent",
  before_due: "A friendly reminder while it's still unpaid",
  overdue: "A reminder when the due date has passed and it isn't paid",
};
const ACCENTS = ["#0a6f4d", "#12a374", "#1f6feb", "#2f4bd8", "#6d3bd8", "#b42363", "#d9480f", "#0f172a"];
const ago = (s: string | null) => {
  if (!s) return "never";
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtDate(s.slice(0, 10));
};
const acctLabel = (a: MailAcct) => `${a.email}${a.kind === "ionos" ? " · SMTP" : a.kind === "gmail" ? " · Gmail" : " · Outlook"}`;

export default function BillingFlows({ clients, invoices, siteOf, active, slotL, slotR }: {
  clients: BClient[]; invoices: Invoice[] | null; siteOf: (id: string | null, email?: string | null) => string; active: boolean;
  /** Billing's header: the tabs go next to its view switch (left), "New …" next to its buttons (right). */
  slotL?: HTMLElement | null; slotR?: HTMLElement | null;
}) {
  const [tab, setTab] = useState<Tab>("flows");
  const [flows, setFlows] = useState<BillFlow[] | null>(null);
  const [bps, setBps] = useState<Blueprint[]>([]);
  const [ents, setEnts] = useState<Entity[]>([]);
  const [sends, setSends] = useState<FlowSend[]>([]);
  const [tpls, setTpls] = useState<MkTpl[]>([]);
  const [boxes, setBoxes] = useState<MailAcct[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toastT, setToastT] = useState<string | null>(null);
  const [editFlow, setEditFlow] = useState<Partial<BillFlow> | null>(null);
  const [editBp, setEditBp] = useState<Partial<Blueprint> | null>(null);
  const [editEnt, setEditEnt] = useState<Partial<Entity> | null>(null);
  const toastTimer = useRef(0);
  const toast = useCallback((t: string) => { setToastT(t); window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToastT(null), 3200); }, []);

  const reload = useCallback(async () => {
    try { const r = await loadFlowsAll(); setFlows(r.flows); setBps(r.blueprints); setEnts(r.entities); setSends(r.sends); setErr(null); }
    catch (e) { setErr(String((e as Error)?.message ?? e)); setFlows([]); }
  }, []);
  const loaded = useRef(false);
  useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    void reload();
    loadMkTemplates().then(setTpls).catch(() => {});
    myConnections().then((c) => setBoxes(c.mail)).catch(() => setBoxes([]));
  }, [active, reload]);

  const entOf = useMemo(() => new Map(ents.map((e) => [e.id, e])), [ents]);
  const bpOf = useMemo(() => new Map(bps.map((b) => [b.id, b])), [bps]);
  const defEnt = ents.find((e) => e.is_default) ?? ents[0] ?? null;
  const defBp = bps.find((b) => b.is_default) ?? bps[0] ?? null;
  const stats = useMemo(() => {
    const m = new Map<string, { sent: number; failed: number }>();
    sends.forEach((s) => { if (!s.flow_id) return; const x = m.get(s.flow_id) ?? { sent: 0, failed: 0 }; if (s.status === "sent") x.sent++; else x.failed++; m.set(s.flow_id, x); });
    return m;
  }, [sends]);

  const move = async (id: string, dir: -1 | 1) => {
    if (!flows) return;
    const i = flows.findIndex((f) => f.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= flows.length) return;
    const next = [...flows]; [next[i], next[j]] = [next[j], next[i]];
    setFlows(next.map((f, k) => ({ ...f, position: k })));
    await reorderFlows(next.map((f) => f.id)).catch(() => {});
  };
  const toggle = async (f: BillFlow) => {
    const on = f.status !== "active";
    if (on && (!f.sender_account)) { setEditFlow(f); toast("Pick the mailbox it sends from first"); return; }
    const nf = { ...f, status: (on ? "active" : "paused") as BillFlow["status"], activated_at: on ? new Date().toISOString() : f.activated_at };
    setFlows((xs) => xs?.map((x) => (x.id === f.id ? nf : x)) ?? xs);
    try { await saveFlow({ id: f.id, status: nf.status, activated_at: nf.activated_at }); toast(on ? `“${f.name}” is on — it checks every hour` : `“${f.name}” is paused`); }
    catch (e) { toast(String((e as Error).message)); void reload(); }
  };

  const newLabel = tab === "flows" ? "New workflow" : tab === "blueprints" ? "New blueprint" : "New company";
  const onNew = () => {
    if (tab === "flows") setEditFlow({ ...flowEmpty(flows?.length ?? 0), entity_id: defEnt?.id ?? null, blueprint_id: defBp?.id ?? null, sender_account: boxes?.[0]?.id ?? null });
    else if (tab === "blueprints") setEditBp({ name: "", design: { ...DESIGN_DEFAULT }, email_subject: "", email_body: "", is_default: bps.length === 0 });
    else setEditEnt({ ...ENTITY_EMPTY, is_default: ents.length === 0 });
  };
  const counts: Record<Tab, number> = { flows: flows?.length ?? 0, blueprints: bps.length, companies: ents.length };

  const segEl = (
        <div className="bf-seg" role="tablist" aria-label="Workflows">
          {([["flows", "Workflows", I.flow], ["blueprints", "Blueprints", I.doc], ["companies", "Issuing companies", I.building]] as [Tab, string, string][]).map(([k, l, ic]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "is-on" : ""} onClick={() => setTab(k)}>
              <Ico d={ic} s={15} />{l}{flows && <i>{counts[k]}</i>}
            </button>
          ))}
        </div>
  );
  const newEl = (
  <button className="bf-new" onClick={onNew} disabled={!!err && needsSql(new Error(err))}><Ico d={I.plus} s={15} />{newLabel}</button>
  );

  return (
    <div className="bf">
      {slotL ? createPortal(segEl, slotL) : null}
      {slotR ? createPortal(newEl, slotR) : null}
      {(!slotL || !slotR) && (
        <div className="bf-top">
          {!slotL && segEl}
          <span className="bf-sp" />
          {!slotR && newEl}
        </div>
      )}

      {err && <p className="bf-err">{err}</p>}

      <div className="bf-scroll" key={tab}>
        {tab === "flows" && (flows === null ? <FlowsSkel /> : flows.length === 0 ? (
          <FlowsEmpty onNew={onNew} hasEnt={ents.length > 0} hasBp={bps.length > 0} onTab={setTab} />
        ) : (
          <>
            <section className="bf-card bf-list">
              <header className="bf-card-h">
                <div><b>Your workflows</b><small>Checked from the top: for each invoice and step, the first one that fits sends it — so put the specific ones above the general ones.</small></div>
              </header>
              {flows.map((f, i) => {
                const st = stats.get(f.id) ?? { sent: 0, failed: 0 };
                const ent = (f.entity_id && entOf.get(f.entity_id)) || defEnt;
                const box = boxes?.find((b) => b.id === f.sender_account);
                const bp = (f.blueprint_id && bpOf.get(f.blueprint_id)) || defBp;
                const tpl = f.template_id ? tpls.find((t) => t.id === f.template_id) : null;
                const n = f.audience.client_ids.length;
                return (
                  <div key={f.id} className={`bf-row is-${f.status}`}>
                    <div className="bf-ord">
                      <button onClick={() => void move(f.id, -1)} disabled={i === 0} aria-label="Move up"><Ico d={I.up} s={13} /></button>
                      <em>{i + 1}</em>
                      <button onClick={() => void move(f.id, 1)} disabled={i === flows.length - 1} aria-label="Move down"><Ico d={I.down} s={13} /></button>
                    </div>
                    <button className={`bf-sw ${f.status === "active" ? "is-on" : ""}`} role="switch" aria-checked={f.status === "active"} onClick={() => void toggle(f)} title={f.status === "active" ? "On — click to pause" : "Off — click to switch on"}><i /></button>
                    <button className="bf-row-main" onClick={() => setEditFlow(f)}>
                      <span className={`bf-trig is-${f.trigger}`}><Ico d={TRIG_ICON[f.trigger]} s={16} /></span>
                      <span className="bf-row-name">
                        <b>{f.name || "Untitled workflow"}</b>
                        <small>{triggerText(f)}</small>
                      </span>
                      <span className="bf-row-cell">
                        <small>Clients</small>
                        <b>{f.audience.mode === "all" ? "All clients" : f.audience.mode === "only" ? `${n} client${n === 1 ? "" : "s"}` : `All but ${n}`}</b>
                      </span>
                      <span className="bf-row-cell">
                        <small>Issued by</small>
                        <b className="bf-ent">{ent ? <><EntMark e={ent} />{ent.name || ent.legal_name}</> : <em>Billing settings</em>}</b>
                      </span>
                      <span className="bf-row-cell">
                        <small>From</small>
                        <b>{box ? box.email : f.sender_account ? <em className="is-warn">Mailbox not found</em> : <em className="is-warn">No mailbox</em>}</b>
                      </span>
                      <span className="bf-row-cell">
                        <small>E-mail · PDF</small>
                        <b>{tpl ? tpl.name : bp?.name ? `${bp.name}'s e-mail` : "Standard e-mail"}{f.attach_pdf ? <i className="bf-pdf">PDF</i> : null}</b>
                      </span>
                      <span className="bf-row-stat">
                        <b>{st.sent}</b><small>sent{st.failed ? <em> · {st.failed} failed</em> : null}</small>
                        <small className="bf-row-when">{f.status === "active" ? `checked ${ago(f.last_run_at)}` : f.status === "draft" ? "Draft" : "Paused"}</small>
                      </span>
                      <Ico d={I.right} s={16} />
                    </button>
                    {f.last_error && f.status === "active" && <p className="bf-row-err"><Ico d={I.alert} s={13} />{f.last_error}</p>}
                  </div>
                );
              })}
            </section>
            <Routing flows={flows} clients={clients} invoices={invoices} entOf={entOf} defEnt={defEnt} boxes={boxes ?? []} siteOf={siteOf} />
            <Activity sends={sends} flows={flows} invoices={invoices} />
          </>
        ))}

        {tab === "blueprints" && (flows === null ? <FlowsSkel /> : (
          <div className="bf-grid">
            {bps.map((b) => (
              <button key={b.id} className="bf-bpcard" onClick={() => setEditBp(b)}>
                <BpThumb d={b.design} ent={defEnt} />
                <span className="bf-bpcard-t"><b>{b.name || "Untitled blueprint"}</b>{b.is_default && <i className="bf-def"><Ico d={I.star} s={11} />Default</i>}</span>
                <small>{b.design.layout === "band" ? "Colour band" : b.design.layout === "minimal" ? "Minimal" : "Classic"} · {b.design.lang === "es" ? "Spanish" : "English"} · used by {flows.filter((f) => (f.blueprint_id ?? defBp?.id) === b.id).length}</small>
              </button>
            ))}
            <button className="bf-bpcard is-new" onClick={onNew}><span className="bf-plus"><Ico d={I.plus} s={26} /></span><b>New blueprint</b><small>Layout, colour, language and the e-mail that carries it</small></button>
          </div>
        ))}

        {tab === "companies" && (flows === null ? <FlowsSkel /> : (
          <div className="bf-grid is-ent">
            {ents.map((e) => (
              <button key={e.id} className="bf-entcard" onClick={() => setEditEnt(e)}>
                <span className="bf-entcard-h"><EntMark e={e} big /><span><b>{e.name || e.legal_name || "Unnamed"}</b><small>{e.legal_name && e.legal_name !== e.name ? e.legal_name : e.tax_id || "—"}</small></span>{e.is_default && <i className="bf-def"><Ico d={I.star} s={11} />Default</i>}</span>
                <dl>
                  <div><dt>Tax ID</dt><dd>{e.tax_id || <em>missing</em>}</dd></div>
                  <div><dt>Address</dt><dd>{[e.street, [e.postal_code, e.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || <em>missing</em>}</dd></div>
                  <div><dt>IBAN</dt><dd>{e.iban ? `•••• ${e.iban.replace(/\s/g, "").slice(-4)}` : <em>—</em>}</dd></div>
                  <div><dt>Workflows</dt><dd>{flows.filter((f) => (f.entity_id ?? defEnt?.id) === e.id).length}</dd></div>
                </dl>
              </button>
            ))}
            <button className="bf-entcard is-new" onClick={onNew}><span className="bf-plus"><Ico d={I.plus} s={26} /></span><b>New issuing company</b><small>Each workflow can invoice from a different one</small></button>
          </div>
        ))}
      </div>

      {editFlow && (
        <FlowEditor key={editFlow.id ?? "new"} init={editFlow} clients={clients} siteOf={siteOf} ents={ents} bps={bps} tpls={tpls} boxes={boxes}
          defEnt={defEnt} defBp={defBp} count={flows?.length ?? 0}
          onClose={() => setEditFlow(null)} toast={toast}
          onSaved={(f) => { setFlows((xs) => { const has = xs?.some((x) => x.id === f.id); return has ? xs!.map((x) => (x.id === f.id ? f : x)) : [...(xs ?? []), f]; }); setEditFlow(f); }}
          onDeleted={(id) => { setFlows((xs) => xs?.filter((x) => x.id !== id) ?? xs); setEditFlow(null); }}
          onTab={(t) => { setEditFlow(null); setTab(t); }} />
      )}
      {editBp && (
        <BlueprintEditor key={editBp.id ?? "new"} init={editBp} ent={defEnt} usedBy={flows?.filter((f) => editBp.id && (f.blueprint_id ?? defBp?.id) === editBp.id).length ?? 0}
          onClose={() => setEditBp(null)} toast={toast}
          onSaved={async (b, def) => {
            if (def && !b.is_default) { await makeDefault("base_billing_blueprints", b.id).catch(() => {}); }
            await reload(); setEditBp(null); toast(`Blueprint “${b.name}” saved`);
          }}
          onDeleted={async () => { await reload(); setEditBp(null); }} />
      )}
      {editEnt && (
        <EntityEditor key={editEnt.id ?? "new"} init={editEnt} usedBy={flows?.filter((f) => editEnt.id && f.entity_id === editEnt.id).length ?? 0}
          onClose={() => setEditEnt(null)}
          onSaved={async (e, def) => {
            if (def) await makeDefault("base_billing_entities", e.id).catch(() => {});
            await reload(); setEditEnt(null); toast(`“${e.name || e.legal_name}” saved`);
          }}
          onDeleted={async () => { await reload(); setEditEnt(null); }} />
      )}
      {toastT && createPortal(<div className="bf-toast" role="status">{toastT}</div>, document.body)}
    </div>
  );
}

/* ============================ bits ============================ */
function EntMark({ e, big }: { e: Pick<Entity, "name" | "legal_name" | "logo_url" | "website" | "color">; big?: boolean }) {
  const [bad, setBad] = useState(false);
  const n = e.name || e.legal_name || "?";
  if (e.logo_url && !bad) return <span className={`bf-em ${big ? "is-big" : ""} has-img`}><img src={e.logo_url} alt="" onError={() => setBad(true)} /></span>;
  if (e.website) return <span className={`bf-em ${big ? "is-big" : ""} is-site`}><ClientLogo name={n} website={e.website} size={big ? 40 : 20} /></span>;
  return <span className={`bf-em ${big ? "is-big" : ""}`} style={{ background: e.color || "#0a6f4d" }}>{n.trim()[0]?.toUpperCase() ?? "?"}</span>;
}
function FlowsSkel() {
  return <div className="bf-skel">{[0, 1, 2].map((i) => <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />)}</div>;
}
function FlowsEmpty({ onNew, hasEnt, hasBp, onTab }: { onNew: () => void; hasEnt: boolean; hasBp: boolean; onTab: (t: Tab) => void }) {
  const steps: [string, string, string, ReactNode][] = [
    [I.cal, "When", "The billing day, when an invoice is sent, before it's due or once it's overdue.", null],
    [I.building, "Issued by · sent from", "Each workflow picks the company on the invoice and the mailbox it goes out from.", !hasEnt && <button onClick={() => onTab("companies")}>Add a company</button>],
    [I.doc, "E-mail + PDF", "Your Marketing template (or the blueprint's own e-mail) with the invoice attached as a PDF.", !hasBp && <button onClick={() => onTab("blueprints")}>Design a blueprint</button>],
  ];
  return (
    <div className="bf-empty">
      <span className="bf-empty-ico"><Ico d={I.flow} s={30} /></span>
      <h3>Send every invoice the way each client should get it</h3>
      <p>A workflow takes an invoice the moment it's due to go out and e-mails it to the client's billing contact — with your e-mail, your company and the PDF built from your blueprint.</p>
      <ol>
        {steps.map(([ic, t, s, act], i) => (
          <li key={t}><span><Ico d={ic} s={18} /></span><b>{i + 1}. {t}</b><small>{s}</small>{act}</li>
        ))}
      </ol>
      <button className="bf-new is-big" onClick={onNew}><Ico d={I.plus} s={16} />Create your first workflow</button>
    </div>
  );
}

/** Which workflow takes each client's invoices (the first that fits, by step). */
function Routing({ flows, clients, invoices, entOf, defEnt, boxes, siteOf }: {
  flows: BillFlow[]; clients: BClient[]; invoices: Invoice[] | null; entOf: Map<string, Entity>; defEnt: Entity | null; boxes: MailAcct[];
  siteOf: (id: string | null, email?: string | null) => string;
}) {
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const live = flows.filter((f) => f.status !== "paused");
  const fitsC = (f: BillFlow, cid: string) => (f.audience.mode === "all" ? true : f.audience.mode === "only" ? f.audience.client_ids.includes(cid) : !f.audience.client_ids.includes(cid));
  const billed = useMemo(() => new Set((invoices ?? []).map((i) => i.client_id).filter(Boolean) as string[]), [invoices]);
  const rows = useMemo(() => clients
    .filter((c) => (all || billed.has(c.id)) && (!q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => {
      const main = live.find((f) => (f.trigger === "billing_day" || f.trigger === "issued") && fitsC(f, c.id)) ?? null;
      const rem = live.filter((f) => (f.trigger === "before_due" || f.trigger === "overdue") && fitsC(f, c.id));
      // reminders: one per step (first wins)
      const seen = new Set<string>();
      const reminders = rem.filter((f) => { const k = `${f.trigger}:${f.trigger_days}`; if (seen.has(k)) return false; seen.add(k); return true; });
      return { c, main, reminders };
    }), [clients, all, billed, q, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const none = rows.filter((r) => !r.main).length;
  return (
    <section className="bf-card bf-route">
      <header className="bf-card-h">
        <div><b>Who gets what</b><small>{none ? <><em className="is-warn">{none} client{none === 1 ? "" : "s"}</em> not covered by a workflow — their invoices stay for you to send.</> : "Every client below is covered by a workflow."}</small></div>
        <span className="bf-sp" />
        <label className="bf-q"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client…" /></label>
        <div className="bf-mini-seg">
          <button className={!all ? "is-on" : ""} onClick={() => setAll(false)}>Invoiced</button>
          <button className={all ? "is-on" : ""} onClick={() => setAll(true)}>All clients</button>
        </div>
      </header>
      <div className="bf-route-head"><span>Client</span><span>Invoice goes out with</span><span>Issued by</span><span>From</span><span>Reminders</span></div>
      <div className="bf-route-body">
        {rows.length === 0 && <p className="bf-none">No clients to show.</p>}
        {rows.slice(0, 200).map(({ c, main, reminders }) => {
          const ent = main ? ((main.entity_id && entOf.get(main.entity_id)) || defEnt) : null;
          const box = main ? boxes.find((b) => b.id === main.sender_account) : null;
          return (
            <div key={c.id} className={`bf-route-row ${main ? "" : "is-none"}`}>
              <span className="bf-route-c"><ClientLogo name={c.name} website={siteOf(c.id, c.email)} size={28} /><span><b>{c.name}</b><small>{c.email || <em className="is-warn">no billing e-mail</em>}</small></span></span>
              <span>{main ? <><b>{main.name || "Untitled"}</b><small>{triggerText(main)}{main.status === "draft" ? " · draft" : ""}</small></> : <em>Sent by hand</em>}</span>
              <span className="bf-ent">{ent ? <><EntMark e={ent} />{ent.name || ent.legal_name}</> : "—"}</span>
              <span className="bf-ell">{box?.email ?? "—"}</span>
              <span className="bf-rems">{reminders.length ? reminders.map((f) => <i key={f.id} className={`is-${f.trigger}`} title={f.name}>{f.trigger === "before_due" ? `−${f.trigger_days}d` : `+${f.trigger_days}d`}</i>) : <em>—</em>}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Activity({ sends, flows, invoices }: { sends: FlowSend[]; flows: BillFlow[]; invoices: Invoice[] | null }) {
  const inv = useMemo(() => new Map((invoices ?? []).map((i) => [i.id, i])), [invoices]);
  if (!sends.length) return null;
  const stepTxt = (s: string) => (s === "invoice" ? "Invoice" : s.startsWith("before_due") ? `Reminder · ${s.split(":")[1]}d before` : `Overdue · +${s.split(":")[1]}d`);
  return (
    <section className="bf-card bf-act">
      <header className="bf-card-h"><div><b>Latest e-mails</b><small>What the workflows sent (and what failed — it's tried again on the next run, up to three times).</small></div></header>
      {sends.slice(0, 14).map((s) => {
        const i = inv.get(s.invoice_id);
        return (
          <div key={s.id} className={`bf-act-row is-${s.status}`}>
            <span className="bf-act-ico"><Ico d={s.status === "sent" ? I.check : I.x} s={13} /></span>
            <b>{i?.number ?? "Invoice"}</b>
            <span>{stepTxt(s.step)} · {flows.find((f) => f.id === s.flow_id)?.name ?? "—"}</span>
            <span className="bf-ell">{s.status === "sent" ? `to ${s.to_address ?? "—"}` : s.error}</span>
            <small>{i ? money(i.amount) : ""}</small>
            <small>{ago(s.created_at)}</small>
          </div>
        );
      })}
    </section>
  );
}

/* ============================ the workflow editor ============================ */
function Drawer({ title, eyebrow, onClose, children, foot, wide, head }: { title: ReactNode; eyebrow: string; onClose: () => void; children: ReactNode; foot: ReactNode; wide?: boolean; head?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="bf-back" onMouseDown={onClose}>
      <div className={`bf-dw ${wide ? "is-wide" : ""}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="bf-dw-h">
          <div className="bf-dw-t"><small>{eyebrow}</small>{title}</div>
          {head}
          <button className="bf-x" onClick={onClose} aria-label="Close"><Ico d={I.x} s={18} /></button>
        </header>
        <div className="bf-dw-b">{children}</div>
        <footer className="bf-dw-f">{foot}</footer>
      </div>
    </div>,
    document.body,
  );
}
function Step({ n, title, sub, children }: { n: number; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="bf-step">
      <span className="bf-step-n">{n}</span>
      <div className="bf-step-c"><h4>{title}</h4>{sub && <p className="bf-step-sub">{sub}</p>}{children}</div>
    </section>
  );
}

function FlowEditor({ init, clients, siteOf, ents, bps, tpls, boxes, defEnt, defBp, count, onClose, onSaved, onDeleted, onTab, toast }: {
  init: Partial<BillFlow>; clients: BClient[]; siteOf: (id: string | null, email?: string | null) => string; ents: Entity[]; bps: Blueprint[]; tpls: MkTpl[];
  boxes: MailAcct[] | null; defEnt: Entity | null; defBp: Blueprint | null; count: number;
  onClose: () => void; onSaved: (f: BillFlow) => void; onDeleted: (id: string) => void; onTab: (t: Tab) => void; toast: (t: string) => void;
}) {
  const [f, setF] = useState<Partial<BillFlow>>(() => ({ ...flowEmpty(count), ...init }));
  const [busy, setBusy] = useState<"" | "save" | "test" | "run" | "pdf" | "del">("");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [pick, setPick] = useState("");
  const [cc, setCc] = useState((init.cc ?? []).join(", "));
  const set = (p: Partial<BillFlow>) => { setF((x) => ({ ...x, ...p })); setMsg(null); };
  const aud = f.audience ?? { mode: "all" as AudMode, client_ids: [] };
  const trig = (f.trigger ?? "billing_day") as FlowTrigger;
  const bp = (f.blueprint_id && bps.find((b) => b.id === f.blueprint_id)) || defBp;
  const ent = (f.entity_id && ents.find((e) => e.id === f.entity_id)) || defEnt;
  const tpl = f.template_id ? tpls.find((t) => t.id === f.template_id) : null;
  const lang = bp?.design.lang === "en" ? "en" : "es";
  const picked = aud.client_ids.map((id) => clients.find((c) => c.id === id)).filter(Boolean) as BClient[];
  const shownClients = clients.filter((c) => !aud.client_ids.includes(c.id) && (!pick.trim() || c.name.toLowerCase().includes(pick.trim().toLowerCase()))).slice(0, 8);
  const autoName = () => {
    const who = aud.mode === "all" ? "all clients" : aud.mode === "only" ? (picked.length === 1 ? picked[0].name : `${picked.length} clients`) : "the rest";
    return `${trig === "billing_day" ? "Billing day" : trig === "issued" ? "Sent invoices" : trig === "before_due" ? "Reminder" : "Overdue"} · ${who}`;
  };

  const save = async (alsoOn?: boolean): Promise<BillFlow | null> => {
    if (alsoOn && !f.sender_account) { setMsg({ ok: false, t: "Pick the mailbox it sends from." }); return null; }
    if (aud.mode !== "all" && !aud.client_ids.length) { setMsg({ ok: false, t: "Pick at least one client (or choose All clients)." }); return null; }
    setBusy("save");
    try {
      const row: Partial<BillFlow> = {
        ...f, name: (f.name ?? "").trim() || autoName(), cc: cc.split(/[;,\s]+/).map((x) => x.trim()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)),
        trigger_days: Math.max(0, Math.min(90, Number(f.trigger_days) || 0)),
        ...(alsoOn ? { status: "active" as const, activated_at: f.status === "active" ? f.activated_at : new Date().toISOString() } : {}),
      };
      const out = await saveFlow(row);
      setF(out); onSaved(out);
      setMsg({ ok: true, t: alsoOn ? "Saved and on — it checks every hour." : "Saved." });
      return out;
    } catch (e) { setMsg({ ok: false, t: String((e as Error).message) }); return null; }
    finally { setBusy(""); }
  };
  const test = async () => {
    const saved = await save(); if (!saved) return;
    setBusy("test");
    const r = await testFlow(saved.id);
    setBusy("");
    setMsg(r.ok ? { ok: true, t: `Test sent to ${r.to} (with invoice ${r.number}).` } : { ok: false, t: r.error ?? "Couldn't send the test." });
  };
  const run = async () => {
    if (!f.id) return;
    setBusy("run");
    const r = await runFlow(f.id);
    setBusy("");
    if ("error" in r) setMsg({ ok: false, t: r.error });
    else setMsg({ ok: !r.failed, t: r.sent || r.failed ? `${r.sent} sent${r.failed ? ` · ${r.failed} failed: ${r.errors[0] ?? ""}` : ""}` : "Nothing due right now." });
  };
  const preview = async () => {
    setBusy("pdf");
    const r = await pdfOf({ design: bp?.design ?? DESIGN_DEFAULT, entity: ent ?? undefined });
    setBusy("");
    if ("error" in r) setMsg({ ok: false, t: r.error }); else window.open(r.url, "_blank");
  };
  const del = async () => {
    if (!f.id) { onClose(); return; }
    if (!window.confirm(`Delete “${f.name || "this workflow"}”? Invoices it already sent stay sent.`)) return;
    setBusy("del");
    try { await removeRow("base_billing_flows", f.id); onDeleted(f.id); toast("Workflow deleted"); } catch (e) { setMsg({ ok: false, t: String((e as Error).message) }); setBusy(""); }
  };

  const mailSubject = tpl ? tpl.subject : (bp?.email_subject || DEFAULT_MAIL[lang].subject);
  const mailBody = tpl ? "" : (bp?.email_body || DEFAULT_MAIL[lang].body);
  return (
    <Drawer eyebrow={f.id ? "Workflow" : "New workflow"} onClose={onClose}
      title={<input className="bf-title-in" value={f.name ?? ""} placeholder={autoName()} onChange={(e) => set({ name: e.target.value })} aria-label="Workflow name" />}
      head={f.id ? <span className={`bf-state is-${f.status}`}>{f.status === "active" ? "On" : f.status === "paused" ? "Paused" : "Draft"}</span> : null}
      foot={<>
        {f.id && <button className="bf-btn is-danger" onClick={() => void del()} disabled={!!busy}><Ico d={I.trash} s={14} />Delete</button>}
        {msg && <span className={`bf-msg ${msg.ok ? "is-ok" : "is-err"}`}>{msg.t}</span>}
        <span className="bf-sp" />
        {f.id && f.status === "active" && <button className="bf-btn" onClick={() => void run()} disabled={!!busy}><Ico d={I.play} s={13} />{busy === "run" ? "Running…" : "Run now"}</button>}
        <button className="bf-btn" onClick={() => void test()} disabled={!!busy || !f.sender_account} title={f.sender_account ? "Sends this workflow's e-mail and PDF to you only" : "Pick a mailbox first"}><Ico d={I.mail} s={14} />{busy === "test" ? "Sending…" : "Send me a test"}</button>
        <button className="bf-btn" onClick={() => void save()} disabled={!!busy}>{busy === "save" ? "Saving…" : "Save"}</button>
        {f.status !== "active" && <button className="bf-btn is-primary" onClick={() => void save(true)} disabled={!!busy}>Save & switch on</button>}
      </>}>
      <Step n={1} title="When" sub="What wakes the workflow up. It checks every hour.">
        <div className="bf-tiles">
          {(Object.keys(TRIGGER_LABEL) as FlowTrigger[]).map((k) => (
            <button key={k} className={`bf-tile ${trig === k ? "is-on" : ""}`} onClick={() => set({ trigger: k, trigger_days: k === "overdue" ? (f.trigger_days || 7) : k === "before_due" ? (f.trigger_days || 3) : 0 })}>
              <span className={`bf-trig is-${k}`}><Ico d={TRIG_ICON[k]} s={16} /></span><b>{TRIGGER_LABEL[k]}</b><small>{TRIG_HINT[k]}</small>
            </button>
          ))}
        </div>
        {(trig === "before_due" || trig === "overdue") && (
          <div className="bf-days">
            <button onClick={() => set({ trigger_days: Math.max(trig === "before_due" ? 1 : 0, (f.trigger_days ?? 0) - 1) })} aria-label="One day less">−</button>
            <input type="number" min={0} max={90} value={f.trigger_days ?? 0} onChange={(e) => set({ trigger_days: Math.max(0, Math.min(90, Math.round(Number(e.target.value) || 0))) })} />
            <button onClick={() => set({ trigger_days: Math.min(90, (f.trigger_days ?? 0) + 1) })} aria-label="One day more">+</button>
            <span>{trig === "before_due" ? "days before the due date, while it's unpaid" : "days after the due date, while it's unpaid"}</span>
          </div>
        )}
        {trig === "billing_day" && (
          <div className="bf-radio">
            <button className={f.send_drafts ? "is-on" : ""} onClick={() => set({ send_drafts: true })}><i /><span><b>Send them straight away</b><small>The drafts the cutoff makes go out to the client and are marked sent.</small></span></button>
            <button className={!f.send_drafts ? "is-on" : ""} onClick={() => set({ send_drafts: false })}><i /><span><b>After someone reviews them</b><small>They wait in To invoice; once someone marks one sent, it goes out.</small></span></button>
          </div>
        )}
      </Step>

      <Step n={2} title="Which clients" sub="The first workflow (top of the list) that fits a client takes its invoices.">
        <div className="bf-mini-seg is-wide">
          {([["all", "All clients"], ["only", "Only these"], ["except", "All except these"]] as [AudMode, string][]).map(([k, l]) => (
            <button key={k} className={aud.mode === k ? "is-on" : ""} onClick={() => set({ audience: { ...aud, mode: k } })}>{l}</button>
          ))}
        </div>
        {aud.mode !== "all" && (
          <div className="bf-pick">
            <div className="bf-chips">
              {picked.map((c) => (
                <span key={c.id} className="bf-chip"><ClientLogo name={c.name} website={siteOf(c.id, c.email)} size={20} />{c.name}
                  <button onClick={() => set({ audience: { ...aud, client_ids: aud.client_ids.filter((x) => x !== c.id) } })} aria-label={`Remove ${c.name}`}>×</button></span>
              ))}
              <input value={pick} onChange={(e) => setPick(e.target.value)} placeholder={picked.length ? "Add another client…" : "Search a client to add…"} />
            </div>
            {(pick.trim() || !picked.length) && (
              <div className="bf-pick-list">
                {shownClients.map((c) => (
                  <button key={c.id} onClick={() => { set({ audience: { ...aud, client_ids: [...aud.client_ids, c.id] } }); setPick(""); }}>
                    <ClientLogo name={c.name} website={siteOf(c.id, c.email)} size={24} /><b>{c.name}</b><small>{c.email || "no billing e-mail"}</small>
                  </button>
                ))}
                {!shownClients.length && <p className="bf-none">No client matches.</p>}
              </div>
            )}
          </div>
        )}
      </Step>

      <Step n={3} title="Issued by · sent from" sub="The company on the invoice, and the mailbox the e-mail leaves from.">
        <div className="bf-two">
          <label className="bf-f"><span>Issuing company</span>
            <Select value={f.entity_id ?? ""} onChange={(v) => set({ entity_id: v || null })}
              options={[{ value: "", label: defEnt ? `Default · ${defEnt.name || defEnt.legal_name}` : "Billing settings (seller)" }, ...ents.map((e) => ({ value: e.id, label: e.name || e.legal_name || "Unnamed", hint: e.tax_id }))]} />
            <button className="bf-link" onClick={() => onTab("companies")}>Manage companies</button>
          </label>
          <label className="bf-f"><span>Mailbox</span>
            {boxes === null ? <span className="bf-skel-in" /> : boxes.length === 0
              ? <span className="bf-warn">No mailbox connected — connect Gmail, Outlook or an SMTP mailbox in <b>Settings › Integrations</b>.</span>
              : <Select value={f.sender_account ?? ""} onChange={(v) => set({ sender_account: v || null })} placeholder="Pick a mailbox…"
                  options={boxes.map((b) => ({ value: b.id, label: acctLabel(b), hint: b.status === "error" ? "needs reconnecting" : undefined }))} />}
          </label>
        </div>
        <div className="bf-two">
          <label className="bf-f"><span>Send as <em>optional</em></span>
            <input value={f.from_address ?? ""} placeholder="billing@yourcompany.com (an alias of that mailbox)" onChange={(e) => set({ from_address: e.target.value || null })} /></label>
          <label className="bf-f"><span>Copy to <em>optional</em></span>
            <input value={cc} placeholder="accounts@yourcompany.com" onChange={(e) => { setCc(e.target.value); setMsg(null); }} /></label>
        </div>
      </Step>

      <Step n={4} title="The e-mail" sub="Sent to the client's billing e-mail. Fields like {{first_name}} or {{invoice_number}} are filled in for each invoice.">
        <label className="bf-f"><span>E-mail</span>
          <Select value={f.template_id ?? ""} onChange={(v) => set({ template_id: v || null })} searchable
            options={[{ value: "", label: bp ? `The blueprint's e-mail (${bp.name})` : "The standard invoice e-mail", hint: "edit it in Blueprints" },
              ...tpls.map((t) => ({ value: t.id, label: t.name, hint: "Marketing template" })),
              ...(f.template_id && !tpl ? [{ value: f.template_id, label: "A Marketing template that no longer exists", hint: "pick another" }] : [])]} />
        </label>
        <div className="bf-mail">
          <div className="bf-mail-h">
            <span><small>From</small>{boxes?.find((b) => b.id === f.sender_account)?.email ?? "—"}{f.from_address ? ` (as ${f.from_address})` : ""}</span>
            <span><small>To</small>the client's billing e-mail{cc.trim() ? ` · cc ${cc}` : ""}</span>
            <span><small>Subject</small><b><Vars t={mailSubject} /></b></span>
          </div>
          <div className="bf-mail-b">
            {tpl ? <p className="bf-mail-tpl">Your Marketing template <b>“{tpl.name}”</b> — its unsubscribe footer is left out on invoices.</p> : mailBody.split(/\n{2,}/).map((p, i) => <p key={i}><Vars t={p} /></p>)}
            {f.attach_pdf && <span className="bf-att"><Ico d={I.doc} s={15} /><b>{lang === "es" ? "Factura" : "Invoice"} 2026-0042{ent?.name ? ` - ${ent.name}` : ""}.pdf</b><small>PDF</small></span>}
          </div>
        </div>
      </Step>

      <Step n={5} title="The invoice PDF" sub="Built from a blueprint with the issuing company's details.">
        <div className="bf-two is-pdf">
          <label className="bf-f"><span>Blueprint</span>
            <Select value={f.blueprint_id ?? ""} onChange={(v) => set({ blueprint_id: v || null })}
              options={[{ value: "", label: defBp ? `Default · ${defBp.name}` : "Standard (no blueprint yet)" }, ...bps.map((b) => ({ value: b.id, label: b.name || "Untitled" }))]} />
            <button className="bf-link" onClick={() => onTab("blueprints")}>Design blueprints</button>
          </label>
          <div className="bf-pdfrow">
            <button className={`bf-tg is-box ${f.attach_pdf ? "is-on" : ""}`} onClick={() => set({ attach_pdf: !f.attach_pdf })} role="switch" aria-checked={!!f.attach_pdf}><span><b>Attach the invoice as a PDF</b><small>Built from the blueprint</small></span><i /></button>
            <button className="bf-btn" onClick={() => void preview()} disabled={!!busy}><Ico d={I.eye} s={14} />{busy === "pdf" ? "Making it…" : "Preview the PDF"}</button>
          </div>
        </div>
      </Step>
    </Drawer>
  );
}
/** {{fields}} as chips. */
function Vars({ t }: { t: string }) {
  const parts = String(t ?? "").split(/(\{\{\s*[a-z_]+\s*\}\})/gi);
  return <>{parts.map((p, i) => { const k = /^\{\{\s*([a-z_]+)\s*\}\}$/i.exec(p)?.[1]?.toLowerCase(); const v = k && MAIL_VARS.find((m) => m.key === k); return v ? <span key={i} className="bf-var">{v.label}</span> : p.split("\n").map((x, j) => <span key={`${i}.${j}`}>{j > 0 && <br />}{x}</span>); })}</>;
}

/* ============================ blueprints ============================ */
function BpThumb({ d, ent }: { d: PdfDesign; ent: Entity | null }) {
  return (
    <span className={`bf-thumb is-${d.layout}`} style={{ ["--ac" as string]: d.accent || "#0a6f4d" }}>
      <span className="bf-thumb-pg">
        {d.layout === "band" ? <span className="bf-th-band"><i />{ent?.logo_url ? <img src={ent.logo_url} alt="" /> : <u />}</span> : <span className="bf-th-top"><i /><u /></span>}
        <span className="bf-th-lines"><s /><s /><s /><s /></span>
        <span className="bf-th-tot"><s /><b /></span>
      </span>
    </span>
  );
}
function BlueprintEditor({ init, ent, usedBy, onClose, onSaved, onDeleted, toast }: {
  init: Partial<Blueprint>; ent: Entity | null; usedBy: number; onClose: () => void; onSaved: (b: Blueprint, def: boolean) => void | Promise<void>; onDeleted: () => void | Promise<void>; toast: (t: string) => void;
}) {
  const [b, setB] = useState<Partial<Blueprint>>(() => ({ ...init, design: { ...DESIGN_DEFAULT, ...(init.design ?? {}) } }));
  const [def, setDef] = useState(!!init.is_default);
  const [part, setPart] = useState<"design" | "texts" | "email">("design");
  const [pdf, setPdf] = useState<{ url: string; bytes: Uint8Array } | null>(null);
  const [pvErr, setPvErr] = useState<string | null>(null);
  const [pvBusy, setPvBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = b.design!;
  const setD = (p: Partial<PdfDesign>) => setB((x) => ({ ...x, design: { ...x.design!, ...p } }));
  const lang = d.lang === "en" ? "en" : "es";
  const subjRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<"subject" | "body">("body");

  // the live preview: the same PDF the client gets (debounced); the last one stays up while the next is made
  const key = JSON.stringify(d);
  useEffect(() => {
    let alive = true; setPvBusy(true);
    const t = window.setTimeout(async () => {
      const r = await pdfOf({ design: d, entity: ent ?? undefined });
      if (!alive) { if (!("error" in r)) URL.revokeObjectURL(r.url); return; }
      setPvBusy(false);
      if ("error" in r) { setPvErr(r.error); return; }
      setPvErr(null);
      setPdf((old) => { if (old) URL.revokeObjectURL(old.url); return { url: r.url, bytes: r.bytes }; });
    }, 550);
    return () => { alive = false; window.clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const pdfRef = useRef(pdf); pdfRef.current = pdf;
  useEffect(() => () => { if (pdfRef.current) URL.revokeObjectURL(pdfRef.current.url); }, []);

  const insertVar = (k: string) => {
    const tag = `{{${k}}}`;
    const el = lastField.current === "subject" ? subjRef.current : bodyRef.current;
    const field = lastField.current === "subject" ? "email_subject" : "email_body";
    const cur = String((b as any)[field] || (field === "email_subject" ? DEFAULT_MAIL[lang].subject : DEFAULT_MAIL[lang].body));
    const s = el?.selectionStart ?? cur.length, e = el?.selectionEnd ?? cur.length;
    setB((x) => ({ ...x, [field]: cur.slice(0, s) + tag + cur.slice(e) }));
    window.setTimeout(() => { el?.focus(); el?.setSelectionRange(s + tag.length, s + tag.length); }, 0);
  };
  const layoutName = (l: PdfDesign["layout"]) => (l === "band" ? "Colour band" : l === "minimal" ? "Minimal" : "Classic");
  const save = async () => {
    setBusy(true); setErr(null);
    try { const out = await saveBlueprint({ ...b, is_default: !!init.is_default, name: (b.name ?? "").trim() || `${layoutName(d.layout)} · ${lang === "es" ? "ES" : "EN"}` }); await onSaved(out, def); }
    catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };
  const del = async () => {
    if (!b.id) { onClose(); return; }
    if (!window.confirm(`Delete the blueprint “${b.name}”?${usedBy ? ` ${usedBy} workflow${usedBy === 1 ? "" : "s"} use it — they'll use the default one.` : ""}`)) return;
    setBusy(true);
    try { await removeRow("base_billing_blueprints", b.id); toast("Blueprint deleted"); await onDeleted(); } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };
  const download = () => { if (!pdf) return; const a = document.createElement("a"); a.href = pdf.url; a.download = `${b.name || "Blueprint"} (sample).pdf`; a.click(); };
  const Toggle = ({ on, set, label, sub }: { on: boolean; set: (v: boolean) => void; label: string; sub: string }) => (
    <button className={`bf-tg ${on ? "is-on" : ""}`} onClick={() => set(!on)} role="switch" aria-checked={on}>
      <span><b>{label}</b><small>{sub}</small></span><i />
    </button>
  );
  const from = ent ? (ent.name || ent.legal_name) : null;

  return (
    <Drawer wide eyebrow={b.id ? "Blueprint" : "New blueprint"} onClose={onClose}
      title={<input className="bf-title-in" value={b.name ?? ""} placeholder={`${layoutName(d.layout)} · ${lang === "es" ? "ES" : "EN"}`} onChange={(e) => setB({ ...b, name: e.target.value })} aria-label="Blueprint name" />}
      head={usedBy ? <span className="bf-state">Used by {usedBy} workflow{usedBy === 1 ? "" : "s"}</span> : null}
      foot={<>
        {b.id && <button className="bf-btn is-danger" onClick={() => void del()} disabled={busy}><Ico d={I.trash} s={14} />Delete</button>}
        <button className={`bf-check ${def ? "is-on" : ""}`} onClick={() => setDef(!def)} disabled={!!init.is_default}><i><Ico d={I.check} s={12} /></i>Default blueprint</button>
        {err && <span className="bf-msg is-err">{err}</span>}
        <span className="bf-sp" />
        <button className="bf-btn" onClick={onClose}>Cancel</button>
        <button className="bf-btn is-primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save blueprint"}</button>
      </>}>
      <div className="bf-bp">
        <div className="bf-bp-side">
          <div className="bf-mini-seg is-wide bf-bp-tabs" role="tablist">
            {([["design", "Design"], ["texts", "Texts"], ["email", "E-mail"]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={part === k} className={part === k ? "is-on" : ""} onClick={() => setPart(k)}>{l}</button>
            ))}
          </div>

          <div className="bf-bp-form" key={part}>
            {part === "design" && <>
              <section className="bf-sec">
                <h5>Layout</h5>
                <div className="bf-layouts">
                  {(["classic", "band", "minimal"] as const).map((l) => (
                    <button key={l} className={d.layout === l ? "is-on" : ""} onClick={() => setD({ layout: l })}>
                      <BpThumb d={{ ...d, layout: l }} ent={ent} /><b>{layoutName(l)}</b>
                    </button>
                  ))}
                </div>
              </section>
              <section className="bf-sec">
                <h5 className="bf-h5row">Colour<code className="bf-hex">{d.accent.toUpperCase()}</code></h5>
                <div className="bf-swatches">
                  {ACCENTS.map((c) => <button key={c} className={d.accent.toLowerCase() === c ? "is-on" : ""} style={{ background: c }} onClick={() => setD({ accent: c })} aria-label={c} />)}
                  <label className={`bf-swatch-in ${ACCENTS.includes(d.accent.toLowerCase()) ? "" : "is-on"}`} title="Another colour"><input type="color" value={/^#[0-9a-f]{6}$/i.test(d.accent) ? d.accent : "#0a6f4d"} onChange={(e) => setD({ accent: e.target.value })} aria-label="Another colour" /></label>
                </div>
              </section>
              <section className="bf-sec">
                <h5>Typeface</h5>
                <div className="bf-fonts">
                  <button className={d.font !== "serif" ? "is-on" : ""} onClick={() => setD({ font: "sans" })}><b style={{ fontFamily: "Helvetica, Arial, sans-serif" }}>Aa</b><small>Sans</small></button>
                  <button className={d.font === "serif" ? "is-on" : ""} onClick={() => setD({ font: "serif" })}><b style={{ fontFamily: "'Times New Roman', Times, serif" }}>Aa</b><small>Serif</small></button>
                </div>
              </section>
              <section className="bf-sec">
                <h5>Language of the invoice</h5>
                <div className="bf-mini-seg is-wide"><button className={lang === "es" ? "is-on" : ""} onClick={() => setD({ lang: "es" })}>Spanish</button><button className={lang === "en" ? "is-on" : ""} onClick={() => setD({ lang: "en" })}>English</button></div>
              </section>
            </>}

            {part === "texts" && <>
              <section className="bf-sec">
                <h5>Heading</h5>
                <label className="bf-f"><span>Title</span><input value={d.title} placeholder={lang === "es" ? "Factura" : "Invoice"} onChange={(e) => setD({ title: e.target.value })} /></label>
              </section>
              <section className="bf-sec">
                <h5>On the invoice</h5>
                <div className="bf-tgs">
                  <Toggle on={d.show_logo} set={(v) => setD({ show_logo: v })} label="Company logo" sub="From the issuing company" />
                  <Toggle on={d.show_due} set={(v) => setD({ show_due: v })} label="Due date" sub="Next to the issue date" />
                  <Toggle on={d.show_contact} set={(v) => setD({ show_contact: v })} label="Our contact details" sub="E-mail, phone and website" />
                </div>
              </section>
              <section className="bf-sec">
                <h5>Under the totals</h5>
                <label className="bf-f"><span>Note <em>optional</em></span><textarea rows={2} value={d.notes} placeholder={lang === "es" ? "Gracias por confiar en nosotros." : "Thank you for your business."} onChange={(e) => setD({ notes: e.target.value })} /></label>
                <label className="bf-f"><span>How to pay <em>empty = “Pay to IBAN …”</em></span><textarea rows={2} value={d.pay_text} placeholder={lang === "es" ? "Pagar a IBAN {{iban}}" : "Pay to IBAN {{iban}}"} onChange={(e) => setD({ pay_text: e.target.value })} /></label>
              </section>
              <section className="bf-sec">
                <h5>Footer</h5>
                <label className="bf-f"><span>Legal text <em>registry, conditions…</em></span><textarea rows={3} value={d.footer} placeholder="{{company}} · Registro Mercantil de Madrid, Tomo …" onChange={(e) => setD({ footer: e.target.value })} /></label>
                <p className="bf-help">Write <code>{"{{iban}}"}</code> or <code>{"{{company}}"}</code> and they're filled in with the issuing company's.</p>
              </section>
            </>}

            {part === "email" && <>
              <section className="bf-sec">
                <h5>The e-mail that carries it</h5>
                <p className="bf-help">Used when a workflow doesn't pick a Marketing template. Reminders before and after the due date bring their own short text.</p>
                <label className="bf-f"><span>Subject</span><input ref={subjRef} value={b.email_subject || ""} placeholder={DEFAULT_MAIL[lang].subject} onFocus={() => { lastField.current = "subject"; }} onChange={(e) => setB({ ...b, email_subject: e.target.value })} /></label>
                <label className="bf-f"><span>Message</span><textarea ref={bodyRef} rows={9} value={b.email_body || ""} placeholder={DEFAULT_MAIL[lang].body} onFocus={() => { lastField.current = "body"; }} onChange={(e) => setB({ ...b, email_body: e.target.value })} /></label>
                <div className="bf-varbar"><small>Insert</small>{MAIL_VARS.map((v) => <button key={v.key} onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v.key)}>{v.label}</button>)}</div>
              </section>
            </>}
          </div>
        </div>

        <div className="bf-bp-pv">
          <div className="bf-pv-h">
            <span className="bf-pv-t"><b>{part === "email" ? "The e-mail" : "Preview"}</b>
              <small>{part === "email" ? "As the client reads it, with a sample invoice" : from ? `Sample invoice issued by ${from}` : "Sample invoice · your details from Billing settings"}</small></span>
            {pvBusy && part !== "email" && <i className="bf-spin" />}
            {part !== "email" && <button className="bf-btn is-sm" onClick={download} disabled={!pdf}><Ico d={I.download} s={13} />Download PDF</button>}
          </div>
          {part === "email" ? (
            <div className="bf-pv-stage is-mail">
              <div className="bf-mailcard">
                <div className="bf-mail-h">
                  <span><small>From</small>{from ?? "Your company"}{ent?.email ? ` <${ent.email}>` : ""}</span>
                  <span><small>To</small>billing@client.com</span>
                  <span><small>Subject</small><b><Vars t={b.email_subject || DEFAULT_MAIL[lang].subject} /></b></span>
                </div>
                <div className="bf-mail-b">
                  {(b.email_body || DEFAULT_MAIL[lang].body).split(/\n{2,}/).map((p, i) => <p key={i}><Vars t={p} /></p>)}
                  <span className="bf-att"><Ico d={I.doc} s={15} /><b>{lang === "es" ? "Factura" : "Invoice"} 2026-0042{from ? ` - ${from}` : ""}.pdf</b><small>PDF</small></span>
                </div>
              </div>
            </div>
          ) : (
            <div className="bf-pv-stage">
              {pvErr && !pdf ? <p className="bf-pv-err"><Ico d={I.alert} s={18} />{pvErr}</p> : <PdfPaper bytes={pdf?.bytes ?? null} busy={pvBusy} />}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

/* ============================ issuing companies ============================ */
function EntityEditor({ init, usedBy, onClose, onSaved, onDeleted }: {
  init: Partial<Entity>; usedBy: number; onClose: () => void; onSaved: (e: Entity, def: boolean) => void | Promise<void>; onDeleted: () => void | Promise<void>;
}) {
  const [e, setE] = useState<Partial<Entity>>({ ...ENTITY_EMPTY, ...init });
  const [def, setDef] = useState(!!init.is_default);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const F = (k: keyof Entity, label: string, ph = "", hint?: string) => (
    <label className="bf-f"><span>{label}{hint && <em>{hint}</em>}</span><input value={String(e[k] ?? "")} placeholder={ph} onChange={(ev) => setE({ ...e, [k]: ev.target.value })} /></label>
  );
  const save = async () => {
    if (!(e.legal_name ?? "").trim() && !(e.name ?? "").trim()) { setErr("Give it a name."); return; }
    if (e.logo_url && !/^https:\/\//i.test(e.logo_url)) { setErr("The logo has to be an https:// link to a PNG or JPG."); return; }
    setBusy(true); setErr(null);
    try { const out = await saveEntity({ ...e, is_default: !!init.is_default, name: (e.name ?? "").trim() || (e.legal_name ?? "").trim() }); await onSaved(out, def && !init.is_default); }
    catch (x) { setErr(String((x as Error).message)); setBusy(false); }
  };
  const del = async () => {
    if (!e.id) { onClose(); return; }
    if (!window.confirm(`Delete “${e.name || e.legal_name}”?${usedBy ? ` ${usedBy} workflow${usedBy === 1 ? "" : "s"} use it — they'll use the default company.` : ""}`)) return;
    setBusy(true);
    try { await removeRow("base_billing_entities", e.id); await onDeleted(); } catch (x) { setErr(String((x as Error).message)); setBusy(false); }
  };
  return (
    <Drawer eyebrow={e.id ? "Issuing company" : "New issuing company"} onClose={onClose}
      title={<span className="bf-ent-title"><EntMark e={{ name: e.name ?? "", legal_name: e.legal_name ?? "", logo_url: e.logo_url ?? "", website: e.website ?? "", color: e.color ?? "" }} big />{e.name || e.legal_name || "New company"}</span>}
      foot={<>
        {e.id && <button className="bf-btn is-danger" onClick={() => void del()} disabled={busy}><Ico d={I.trash} s={14} />Delete</button>}
        <button className={`bf-check ${def ? "is-on" : ""}`} onClick={() => setDef(!def)} disabled={!!init.is_default}><i><Ico d={I.check} s={12} /></i>Default company</button>
        {err && <span className="bf-msg is-err">{err}</span>}
        <span className="bf-sp" />
        <button className="bf-btn" onClick={onClose}>Cancel</button>
        <button className="bf-btn is-primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save company"}</button>
      </>}>
      <div className="bf-form">
        <h5>Who it is</h5>
        <div className="bf-two">{F("name", "Trade name", "Next Consulting")}{F("legal_name", "Legal name", "Next Consulting S.L.")}</div>
        <div className="bf-two">{F("tax_id", "Tax ID (NIF / VAT)", "B12345678")}{F("iban", "IBAN", "ES12 3456 7890 1234 5678 9012", "shown on the PDF")}</div>
        <h5>Address</h5>
        {F("street", "Street", "Paseo de la Castellana 100")}
        <div className="bf-three">{F("postal_code", "Postal code", "28046")}{F("city", "Town", "Madrid")}{F("province", "Province", "Madrid")}</div>
        {F("country", "Country (ISO code)", "ES")}
        <h5>Contact & brand</h5>
        <div className="bf-two">{F("email", "Billing e-mail", "billing@company.com")}{F("phone", "Phone", "+34 910 000 000")}</div>
        <div className="bf-two">{F("website", "Website", "company.com")}{F("logo_url", "Logo", "https://…/logo.png", "PNG or JPG link")}</div>
        <label className="bf-f"><span>Colour <em>for its mark when there's no logo</em></span>
          <div className="bf-swatches">{ACCENTS.map((c) => <button key={c} className={(e.color || "").toLowerCase() === c ? "is-on" : ""} style={{ background: c }} onClick={() => setE({ ...e, color: c })} aria-label={c} />)}</div>
        </label>
      </div>
    </Drawer>
  );
}
