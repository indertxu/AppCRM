/* =====================================================================
   ENTERPRISE · Billing › Workflows (adopted from Base, src/base/pages/billing/flows, 2026-11-23) — what happens to an invoice once it exists.
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
import { myConnections, type MailAcct } from "../../../api/marketingHub";
import ClientLogo from "./FlowLogo";
import PdfPaper from "./PdfPaper";
import { money, type BClient, type Invoice } from "./flowsTypes";
import {
  DEFAULT_MAIL, DESIGN_DEFAULT, ENTITY_EMPTY, MAIL_VARS, flowEmpty, loadFlowsAll, loadMkTemplates, makeDefault, needsSql, pdfOf,
  removeRow, reorderFlows, saveBlueprint, saveFlow, triggerText,
  type BillFlow, type Blueprint, type Entity, type FlowSend, type MkTpl, type PdfDesign,
} from "./flowsApi";
import { ACCENTS, BpThumb, EntMark, I, Ico, TRIG_ICON, Vars, ago } from "./flowsUi";
import { EntityWizard, FlowWizard } from "./Guided";
import "./BillingFlows.css";

export type FlowsTab = "flows" | "blueprints" | "companies";
type Tab = FlowsTab;

export default function BillingFlows({ clients, invoices, siteOf, active, slotL, slotR, tab: tabIn, onTab, entSeed, onChanged }: {
  clients: BClient[]; invoices: Invoice[] | null; siteOf: (id: string | null, email?: string | null) => string; active: boolean;
  /** Billing's header: the tabs go next to its view switch (left), "New …" next to its buttons (right). */
  slotL?: HTMLElement | null; slotR?: HTMLElement | null;
  /** Enterprise: the part shown is chosen in Billing's own header (no tabs here). */
  tab?: Tab; onTab?: (t: Tab) => void;
  /** Enterprise: the first issuing company starts from Billing's invoice details. */
  entSeed?: Partial<Entity> | null;
  /** Told after workflows / companies / blueprints load or change (Billing's invoice sheet shows them). */
  onChanged?: () => void;
}) {
  const [tabS, setTabS] = useState<Tab>("flows");
  const tab = tabIn ?? tabS;
  const setTab = (t: Tab) => { if (onTab) onTab(t); else setTabS(t); };
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
    try { const r = await loadFlowsAll(); setFlows(r.flows); setBps(r.blueprints); setEnts(r.entities); setSends(r.sends); setErr(null); onChanged?.(); }
    catch (e) { setErr(String((e as Error)?.message ?? e)); setFlows([]); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
  const newFlow = () => setEditFlow({ ...flowEmpty(flows?.length ?? 0), entity_id: null, blueprint_id: null, sender_account: boxes?.length === 1 ? boxes[0].id : null });
  const newBp = () => setEditBp({ name: "", design: { ...DESIGN_DEFAULT }, email_subject: "", email_body: "", is_default: bps.length === 0 });
  const onNew = () => {
    if (tab === "flows") newFlow();
    else if (tab === "blueprints") newBp();
    else setEditEnt({ ...ENTITY_EMPTY, ...(ents.length === 0 && entSeed ? entSeed : {}), is_default: ents.length === 0 });
  };
  // a company made from inside the workflow wizard, without closing it
  const [nestEnt, setNestEnt] = useState<((e: Entity | null) => void) | null>(null);
  const askEntity = () => new Promise<Entity | null>((res) => setNestEnt(() => res));
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
      {slotL && !tabIn ? createPortal(segEl, slotL) : null}
      {slotR ? createPortal(newEl, slotR) : null}
      {((!slotL && !tabIn) || !slotR) && (
        <div className="bf-top">
          {!slotL && !tabIn && segEl}
          <span className="bf-sp" />
          {!slotR && newEl}
        </div>
      )}

      {err && <p className="bf-err">{err}</p>}

      <div className="bf-scroll" key={tab}>
        {tab === "flows" && (flows === null ? <FlowsSkel /> : flows.length === 0 ? (
          <Setup hasEnt={ents.length > 0} hasBp={bps.length > 0} boxes={boxes} hasFlow={false} onNew={newFlow} onEnt={() => { setTab("companies"); setEditEnt({ ...ENTITY_EMPTY, ...(ents.length === 0 && entSeed ? entSeed : {}), is_default: ents.length === 0 }); }} onBp={() => { setTab("blueprints"); newBp(); }} />
        ) : (
          <>
            <Setup compact hasEnt={ents.length > 0} hasBp={bps.length > 0} boxes={boxes} hasFlow onNew={newFlow} onEnt={() => { setTab("companies"); setEditEnt({ ...ENTITY_EMPTY, ...(ents.length === 0 && entSeed ? entSeed : {}), is_default: ents.length === 0 }); }} onBp={() => { setTab("blueprints"); newBp(); }} />
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
        <FlowWizard key={editFlow.id ?? "new"} init={editFlow} flows={flows ?? []} clients={clients} siteOf={siteOf} ents={ents} bps={bps} tpls={tpls} boxes={boxes}
          defEnt={defEnt} defBp={defBp} count={flows?.length ?? 0}
          onClose={() => setEditFlow(null)} toast={toast} onNewEntity={askEntity}
          onSaved={(f) => { setFlows((xs) => { const has = xs?.some((x) => x.id === f.id); return has ? xs!.map((x) => (x.id === f.id ? f : x)) : [...(xs ?? []), f]; }); }}
          onDeleted={(id) => { setFlows((xs) => xs?.filter((x) => x.id !== id) ?? xs); setEditFlow(null); }}
          onTab={(t) => { setEditFlow(null); setTab(t); }} />
      )}
      {nestEnt && (
        <EntityWizard init={{ ...ENTITY_EMPTY, is_default: ents.length === 0 }} usedBy={0}
          onClose={() => { nestEnt(null); setNestEnt(null); }}
          onSaved={async (e, def) => {
            if (def || ents.length === 0) await makeDefault("base_billing_entities", e.id).catch(() => {});
            await reload(); nestEnt(e); setNestEnt(null); toast(`“${e.name || e.legal_name}” added`);
          }}
          onDeleted={() => { nestEnt(null); setNestEnt(null); }} />
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
        <EntityWizard key={editEnt.id ?? "new"} init={editEnt} usedBy={flows?.filter((f) => editEnt.id && f.entity_id === editEnt.id).length ?? 0}
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
function FlowsSkel() {
  return <div className="bf-skel">{[0, 1, 2].map((i) => <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />)}</div>;
}
/** The setup checklist: the four things a workflow needs, with the next one to do lit up. */
function Setup({ hasEnt, hasBp, boxes, hasFlow, onEnt, onBp, onNew, compact }: { hasEnt: boolean; hasBp: boolean; boxes: MailAcct[] | null; hasFlow: boolean; onEnt: () => void; onBp: () => void; onNew: () => void; compact?: boolean }) {
  const box = (boxes?.length ?? 0) > 0;
  const items: { k: string; ic: string; t: string; s: string; done: boolean; act: ReactNode; opt?: boolean }[] = [
    { k: "ent", ic: I.building, t: "Add the company that issues the invoices", s: "Legal name, tax ID, address and IBAN — printed on every invoice.", done: hasEnt, act: <button className="bf-btn is-sm" onClick={onEnt}>Add a company</button> },
    { k: "box", ic: I.mail, t: "Connect the mailbox they're sent from", s: "Gmail, Outlook or SMTP, in Settings › Integrations.", done: box, act: <span className="bf-setup-note">Settings › Integrations</span> },
    { k: "bp", ic: I.brush, t: "Design how the PDF looks", s: "Layout, colour, language and the e-mail that carries it. The standard one works too.", done: hasBp, act: <button className="bf-btn is-sm" onClick={onBp}>Design a blueprint</button>, opt: true },
    { k: "flow", ic: I.flow, t: "Create your first workflow", s: "When it sends, to which clients — a guided step-by-step.", done: hasFlow, act: <button className="bf-btn is-sm is-primary" onClick={onNew}>Create a workflow</button> },
  ];
  const next = items.find((x) => !x.done && !x.opt) ?? items.find((x) => !x.done);
  const done = items.filter((x) => x.done).length;
  if (compact && !next) return null;
  return (
    <section className={`bf-setup ${compact ? "is-compact" : ""}`}>
      {!compact && <>
        <span className="bf-empty-ico"><Ico d={I.flow} s={30} /></span>
        <h3>Send every invoice the way each client should get it</h3>
        <p>A workflow e-mails each invoice to the client's billing contact at the right moment — from your company, your mailbox and with the PDF built from your blueprint. Four steps to get there:</p>
      </>}
      <div className="bf-setup-h"><b>{compact ? "Finish setting up" : "Getting started"}</b><span className="bf-setup-bar"><i style={{ width: `${(done / items.length) * 100}%` }} /></span><small>{done} of {items.length}</small></div>
      <ol>
        {items.map((x, i) => (
          <li key={x.k} className={`${x.done ? "is-done" : ""} ${next?.k === x.k ? "is-next" : ""}`}>
            <span className="bf-setup-n">{x.done ? <Ico d={I.check} s={14} /> : i + 1}</span>
            <span className="bf-setup-t"><b>{x.t}{x.opt && <em>optional</em>}</b><small>{x.s}</small></span>
            {x.done ? <span className="bf-setup-ok">Done</span> : x.act}
          </li>
        ))}
      </ol>
    </section>
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
          <div className="bf-dw-t">{eyebrow && <small>{eyebrow}</small>}{title}</div>
          {head}
          <button className="bf-x" onClick={onClose} aria-label="Close"><Ico d={I.x} s={18} /></button>
        </header>
        <div className="bf-dw-b">{children}</div>
        {foot ? <footer className="bf-dw-f">{foot}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
/* ============================ blueprints ============================ */
function BlueprintEditor({ init, ent, usedBy, onClose, onSaved, onDeleted, toast }: {
  init: Partial<Blueprint>; ent: Entity | null; usedBy: number; onClose: () => void; onSaved: (b: Blueprint, def: boolean) => void | Promise<void>; onDeleted: () => void | Promise<void>; toast: (t: string) => void;
}) {
  const [b, setB] = useState<Partial<Blueprint>>(() => ({ ...init, design: { ...DESIGN_DEFAULT, ...(init.design ?? {}) } }));
  const [def, setDef] = useState(!!init.is_default);
  type Part = "layout" | "look" | "texts" | "email";
  const PARTS: { k: Part; t: string; q: string; ic: string }[] = [
    { k: "layout", t: "Layout", q: "Pick a layout", ic: I.layout },
    { k: "look", t: "Look", q: "Colour, typeface and language", ic: I.brush },
    { k: "texts", t: "Texts", q: "What the invoice says", ic: I.text },
    { k: "email", t: "E-mail", q: "The e-mail that carries it", ic: I.mail },
  ];
  const [part, setPart] = useState<Part>("layout");
  const pi = PARTS.findIndex((x) => x.k === part);
  const [fit, setFit] = useState<"width" | "page">("width");
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
    <Drawer wide eyebrow="" onClose={onClose} foot={null}
      title={<input className="bf-title-in is-sm" value={b.name ?? ""} placeholder={`${layoutName(d.layout)} · ${lang === "es" ? "ES" : "EN"}`} onChange={(e) => setB({ ...b, name: e.target.value })} aria-label="Blueprint name" title="Blueprint name" />}
      head={<>
        <span className="bf-sp" />
        {err && <span className="bf-msg is-err">{err}</span>}
        {usedBy ? <span className="bf-state">Used by {usedBy}</span> : null}
        <button className={`bf-check ${def ? "is-on" : ""}`} onClick={() => setDef(!def)} disabled={!!init.is_default}><i><Ico d={I.check} s={12} /></i>Default</button>
        {b.id && <button className="bf-btn is-danger" onClick={() => void del()} disabled={busy} title="Delete blueprint"><Ico d={I.trash} s={14} /></button>}
        <button className="bf-btn" onClick={onClose}>Cancel</button>
        <button className="bf-btn is-primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <div className="bf-bp">
        <div className="bf-bp-side">
          <nav className="bf-bp-steps" aria-label="Steps">
            {PARTS.map((x, i) => (
              <button key={x.k} className={`${part === x.k ? "is-on" : ""} ${i < pi ? "is-done" : ""}`} onClick={() => setPart(x.k)} aria-current={part === x.k ? "step" : undefined}>
                <i>{i < pi ? <Ico d={I.check} s={11} /> : i + 1}</i>{x.t}
              </button>
            ))}
          </nav>
          <div className="bf-bp-q"><small><Ico d={PARTS[pi].ic} s={13} />Step {pi + 1} of {PARTS.length}</small><h4>{PARTS[pi].q}</h4></div>

          <div className="bf-bp-form" key={part}>
            {part === "layout" && <>
              <section className="bf-sec">
                <p className="bf-help">How the page is arranged. You can change it any time — the preview on the right is the real PDF.</p>
                <div className="bf-layouts">
                  {(["classic", "band", "minimal"] as const).map((l) => (
                    <button key={l} className={d.layout === l ? "is-on" : ""} onClick={() => setD({ layout: l })}>
                      <BpThumb d={{ ...d, layout: l }} ent={ent} /><b>{layoutName(l)}</b>
                    </button>
                  ))}
                </div>
              </section>
            </>}
            {part === "look" && <>
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
          <div className="bf-bp-nav">
            {pi > 0 ? <button className="bf-btn" onClick={() => setPart(PARTS[pi - 1].k)}><Ico d={I.left} s={14} />Back</button> : <span />}
            <span className="bf-sp" />
            {pi < PARTS.length - 1
              ? <button className="bf-btn is-primary" onClick={() => setPart(PARTS[pi + 1].k)}>Next: {PARTS[pi + 1].t}<Ico d={I.right} s={14} /></button>
              : <button className="bf-btn is-primary" onClick={() => void save()} disabled={busy}><Ico d={I.check} s={14} />{busy ? "Saving…" : b.id ? "Save blueprint" : "Create blueprint"}</button>}
          </div>
        </div>

        <div className="bf-bp-pv">
          {part === "email" ? (
            <div className="bf-pv-stage is-mail">
              <span className="bf-pv-tag">The e-mail as the client reads it · sample invoice</span>
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
            <div className={`bf-pv-stage ${fit === "page" ? "is-page" : ""}`}>
              <div className="bf-pv-bar">
                <span className="bf-pv-tag">{from ? `Sample invoice issued by ${from}` : "Sample invoice · your details from Billing settings"}</span>
                <span className="bf-sp" />
                {pvBusy && <i className="bf-spin" />}
                <div className="bf-mini-seg is-glass">
                  <button className={fit === "width" ? "is-on" : ""} onClick={() => setFit("width")}>Fit width</button>
                  <button className={fit === "page" ? "is-on" : ""} onClick={() => setFit("page")}>Whole page</button>
                </div>
                <button className="bf-btn is-sm is-glass" onClick={download} disabled={!pdf}><Ico d={I.download} s={13} />PDF</button>
              </div>
              {pvErr && !pdf ? <p className="bf-pv-err"><Ico d={I.alert} s={18} />{pvErr}</p> : <div className="bf-pv-scroll"><PdfPaper bytes={pdf?.bytes ?? null} busy={pvBusy} /></div>}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

/* ============================ issuing companies ============================ */
