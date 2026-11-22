/* =====================================================================
   BASE · Billing › Workflows — the guided editors.
     Wizard        the shell: steps on the left (each shows what you chose),
                   one question in the middle, a live preview on the right,
                   Back / Next at the bottom. Any step can be opened again.
     FlowWizard    a workflow, one question at a time: when → which clients →
                   issued by → sent from → the e-mail → the PDF → review.
     EntityWizard  an issuing company: who it is → address → getting paid →
                   brand → review, with the invoice header drawn as you type.
   ===================================================================== */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Select from "../../../framework/Select";
import type { MailAcct } from "../../../../components/api/marketingHub";
import ClientLogo from "../ClientLogo";
import type { BClient } from "../billingApi";
import {
  DEFAULT_MAIL, DESIGN_DEFAULT, ENTITY_EMPTY, TRIGGER_LABEL, flowEmpty, pdfOf, removeRow, runFlow, saveEntity, saveFlow, testFlow, triggerText,
  type AudMode, type BillFlow, type Blueprint, type Entity, type FlowTrigger, type MkTpl,
} from "./flowsApi";
import { ACCENTS, BpThumb, EntMark, I, Ico, TRIG_HINT, TRIG_ICON, Vars, acctLabel } from "./flowsUi";
import "./Guided.css";

/* ============================ the shell ============================ */
export interface WStep { key: string; label: string; icon: string; q: string; hint: string; summary?: ReactNode; done?: boolean; optional?: boolean }

export function Wizard({ icon, eyebrow, title, head, steps, at, onAt, onClose, children, side, foot, nextLabel, canNext, why, onFinishStep }: {
  icon: string; eyebrow: string; title: ReactNode; head?: ReactNode;
  steps: WStep[]; at: number; onAt: (i: number) => void; onClose: () => void;
  children: ReactNode; side?: ReactNode; foot?: ReactNode;
  /** The Next button's text on this step ("Next: Which clients"). */
  nextLabel?: string;
  /** Can this step be left forward? If not, `why` says what's missing. */
  canNext: boolean; why?: string | null;
  /** On the last step the footer shows `foot` instead of Next. */
  onFinishStep?: boolean;
}) {
  const backRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // only the top wizard closes (a company can be added from inside a workflow)
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && backRef.current && [...document.querySelectorAll(".gw-back")].pop() === backRef.current) onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const s = steps[at];
  const last = at === steps.length - 1;
  const pct = Math.round((steps.filter((x) => x.done).length / steps.length) * 100);
  return createPortal(
    <div ref={backRef} className="bf-back gw-back" onMouseDown={onClose}>
      <div className="gw" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="gw-h">
          <span className="gw-ico"><Ico d={icon} s={20} /></span>
          <div className="gw-t"><small>{eyebrow}</small>{title}</div>
          {head}
          <button className="bf-x" onClick={onClose} aria-label="Close"><Ico d={I.x} s={18} /></button>
        </header>
        <div className="gw-main">
          <nav className="gw-rail" aria-label="Steps">
            <div className="gw-prog"><i style={{ width: `${pct}%` }} /><span>{pct}% ready</span></div>
            {steps.map((x, i) => (
              <button key={x.key} className={`gw-st ${i === at ? "is-on" : ""} ${x.done ? "is-done" : ""}`} onClick={() => onAt(i)} aria-current={i === at ? "step" : undefined}>
                <i>{x.done && i !== at ? <Ico d={I.check} s={13} /> : i + 1}</i>
                <span><b>{x.label}{x.optional && <em>optional</em>}</b><small>{x.summary ?? (x.done ? "Done" : "Not yet")}</small></span>
              </button>
            ))}
          </nav>
          <div className="gw-body">
            <div className="gw-scroll" key={s.key}>
              <div className="gw-q">
                <small><Ico d={s.icon} s={13} />Step {at + 1} of {steps.length}</small>
                <h3>{s.q}</h3>
                <p>{s.hint}</p>
              </div>
              {children}
            </div>
          </div>
          {side && <aside className="gw-side">{side}</aside>}
        </div>
        <footer className="gw-f">
          {at > 0 ? <button className="bf-btn" onClick={() => onAt(at - 1)}><Ico d={I.left} s={14} />Back</button> : <button className="bf-btn" onClick={onClose}>Cancel</button>}
          {!canNext && why ? <span className="gw-why"><Ico d={I.info} s={14} />{why}</span> : null}
          <span className="bf-sp" />
          {onFinishStep || last ? foot : (
            <button className="bf-btn is-primary gw-next" onClick={() => canNext && onAt(at + 1)} disabled={!canNext}>
              {nextLabel ?? `Next: ${steps[at + 1]?.label ?? ""}`}<Ico d={I.right} s={15} />
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** A big choice card (radio). */
function Choice({ on, onClick, icon, title, sub, tone, children, disabled }: { on: boolean; onClick: () => void; icon?: ReactNode; title: ReactNode; sub?: ReactNode; tone?: string; children?: ReactNode; disabled?: boolean }) {
  return (
    <button className={`gw-ch ${on ? "is-on" : ""} ${tone ? `t-${tone}` : ""}`} onClick={onClick} disabled={disabled} role="radio" aria-checked={on}>
      {icon && <span className="gw-ch-ico">{icon}</span>}
      <span className="gw-ch-t"><b>{title}</b>{sub && <small>{sub}</small>}{children}</span>
      <span className="gw-ch-dot" aria-hidden="true"><Ico d={I.check} s={12} /></span>
    </button>
  );
}

/* ============================ checks ============================ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** IBAN: the mod-97 check every bank uses. */
export function ibanOk(v: string): boolean {
  const s = v.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (let i = 0; i < r.length; i += 7) m = Number(String(m) + r.slice(i, i + 7)) % 97;
  return m === 1;
}
const ibanFmt = (v: string) => v.replace(/\s+/g, "").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
/** Spanish NIF / CIF / NIE, or an EU VAT number (ES… / FR… …): only the shape. */
const taxLooksOk = (v: string) => {
  const s = v.replace(/[\s.-]+/g, "").toUpperCase();
  return /^([A-Z]{2})?([A-HJNP-SUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z]|[A-Z0-9]{8,12})$/.test(s);
};

/* ============================ the workflow ============================ */
export function FlowWizard({ init, flows, clients, siteOf, ents, bps, tpls, boxes, defEnt, defBp, count, onClose, onSaved, onDeleted, onTab, onNewEntity, toast }: {
  init: Partial<BillFlow>; flows: BillFlow[]; clients: BClient[]; siteOf: (id: string | null, email?: string | null) => string;
  ents: Entity[]; bps: Blueprint[]; tpls: MkTpl[]; boxes: MailAcct[] | null; defEnt: Entity | null; defBp: Blueprint | null; count: number;
  onClose: () => void; onSaved: (f: BillFlow) => void; onDeleted: (id: string) => void; onTab: (t: "blueprints" | "companies") => void;
  /** Make an issuing company without leaving: resolves with it (or null if cancelled). */
  onNewEntity: () => Promise<Entity | null>;
  toast: (t: string) => void;
}) {
  const isNew = !init.id;
  const [f, setF] = useState<Partial<BillFlow>>(() => ({ ...flowEmpty(count), ...init }));
  const [at, setAt] = useState(isNew ? 0 : 6);
  const [seen, setSeen] = useState<Set<number>>(() => new Set(isNew ? [0] : [0, 1, 2, 3, 4, 5, 6]));
  const [busy, setBusy] = useState<"" | "save" | "test" | "run" | "pdf" | "del">("");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [pick, setPick] = useState("");
  const [cc, setCc] = useState((init.cc ?? []).join(", "));
  const [more, setMore] = useState(!!(init.from_address || init.cc?.length));
  const [tq, setTq] = useState("");
  const set = (p: Partial<BillFlow>) => { setF((x) => ({ ...x, ...p })); setMsg(null); };
  const go = (i: number) => { setAt(i); setSeen((s) => new Set(s).add(i)); setMsg(null); };

  const aud = f.audience ?? { mode: "all" as AudMode, client_ids: [] };
  const trig = (f.trigger ?? "billing_day") as FlowTrigger;
  const bp = (f.blueprint_id && bps.find((b) => b.id === f.blueprint_id)) || defBp;
  const ent = (f.entity_id && ents.find((e) => e.id === f.entity_id)) || defEnt;
  const tpl = f.template_id ? tpls.find((t) => t.id === f.template_id) : null;
  const box = boxes?.find((b) => b.id === f.sender_account) ?? null;
  const lang = bp?.design.lang === "en" ? "en" : "es";
  const picked = aud.client_ids.map((id) => clients.find((c) => c.id === id)).filter(Boolean) as BClient[];
  const pool = clients.filter((c) => !aud.client_ids.includes(c.id) && (!pick.trim() || c.name.toLowerCase().includes(pick.trim().toLowerCase())));
  const covered = aud.mode === "all" ? clients.length : aud.mode === "only" ? picked.length : Math.max(0, clients.length - picked.length);
  const noMail = (aud.mode === "only" ? picked : aud.mode === "except" ? clients.filter((c) => !aud.client_ids.includes(c.id)) : clients).filter((c) => !c.email).length;
  // another workflow above this one that already takes the same step for everyone
  const shadow = useMemo(() => {
    const fam = (t: FlowTrigger) => (t === "billing_day" || t === "issued" ? "main" : t);
    const pos = f.position ?? count;
    return flows.find((o) => o.id !== f.id && o.status !== "paused" && o.position < pos && fam(o.trigger) === fam(trig)
      && (trig === "before_due" || trig === "overdue" ? o.trigger_days === f.trigger_days : true) && o.audience.mode === "all") ?? null;
  }, [flows, f.id, f.position, f.trigger_days, trig, count]);
  const autoName = () => {
    const who = aud.mode === "all" ? "all clients" : aud.mode === "only" ? (picked.length === 1 ? picked[0].name : `${picked.length} clients`) : "the rest";
    return `${trig === "billing_day" ? "Billing day" : trig === "issued" ? "Sent invoices" : trig === "before_due" ? `Reminder ${f.trigger_days}d before` : `Overdue +${f.trigger_days}d`} · ${who}`;
  };

  const audOk = aud.mode === "all" || aud.client_ids.length > 0;
  const steps: WStep[] = [
    { key: "when", label: "When", icon: I.cal, q: "When should invoices go out?", hint: "Pick the moment that wakes this workflow up. It looks every hour, so nothing waits long.",
      summary: triggerText({ trigger: trig, trigger_days: f.trigger_days ?? 0, send_drafts: !!f.send_drafts }), done: seen.has(1) || !isNew },
    { key: "who", label: "Which clients", icon: I.users, q: "Which clients does it cover?", hint: "Start broad and add specific workflows above it for clients who need something different.",
      summary: aud.mode === "all" ? `All clients · ${clients.length}` : aud.mode === "only" ? `${picked.length} client${picked.length === 1 ? "" : "s"}` : `All but ${picked.length}`, done: audOk && (seen.has(2) || !isNew) },
    { key: "issuer", label: "Issued by", icon: I.building, q: "Which company issues the invoices?", hint: "Its legal name, tax ID, address and IBAN go on the invoice. Groups can bill from different companies.",
      summary: ent ? (ent.name || ent.legal_name) : "Billing settings", done: seen.has(3) || !isNew },
    { key: "from", label: "Sent from", icon: I.mail, q: "Which mailbox sends them?", hint: "The e-mail leaves from one of your connected mailboxes — clients reply straight to it.",
      summary: box ? box.email : "Not chosen", done: !!f.sender_account },
    { key: "mail", label: "The e-mail", icon: I.text, q: "What does the e-mail say?", hint: "The blueprint's short e-mail is ready to go; or pick one of your Marketing templates. Fields like the invoice number are filled in for each invoice.",
      summary: tpl ? tpl.name : bp ? `${bp.name}'s e-mail` : "Standard e-mail", done: seen.has(5) || !isNew },
    { key: "pdf", label: "The PDF", icon: I.doc, q: "How does the invoice look?", hint: "The PDF is built from a blueprint with the issuing company's details, and attached to the e-mail.",
      summary: f.attach_pdf ? (bp ? `${bp.name} · attached` : "Standard · attached") : "No PDF attached", done: seen.has(6) || !isNew },
    { key: "review", label: "Review", icon: I.check, q: "Everything in place?", hint: "A last look. Click any line to change it — then send yourself a test, or switch it on.",
      summary: f.status === "active" ? "On" : f.id ? (f.status === "paused" ? "Paused" : "Draft") : "Not saved yet", done: !!f.id },
  ];
  const canNext = at === 1 ? audOk : at === 3 ? !!f.sender_account || (boxes?.length ?? 0) === 0 : true;
  const why = at === 1 && !audOk ? "Pick at least one client, or choose All clients." : at === 3 && !f.sender_account && (boxes?.length ?? 0) > 0 ? "Pick the mailbox it sends from." : null;

  const save = async (alsoOn?: boolean): Promise<BillFlow | null> => {
    if (alsoOn && !f.sender_account) { setMsg({ ok: false, t: "Pick the mailbox it sends from (step 4)." }); return null; }
    if (!audOk) { setMsg({ ok: false, t: "Pick at least one client (step 2)." }); return null; }
    setBusy("save");
    try {
      const row: Partial<BillFlow> = {
        ...f, name: (f.name ?? "").trim() || autoName(), cc: cc.split(/[;,\s]+/).map((x) => x.trim()).filter((x) => EMAIL_RE.test(x)),
        trigger_days: Math.max(0, Math.min(90, Number(f.trigger_days) || 0)),
        ...(alsoOn ? { status: "active" as const, activated_at: f.status === "active" ? f.activated_at : new Date().toISOString() } : {}),
      };
      const out = await saveFlow(row);
      setF(out); onSaved(out);
      setMsg({ ok: true, t: alsoOn ? "Saved and on — it looks for invoices every hour." : "Saved as a draft." });
      if (alsoOn) toast(`“${out.name}” is on`);
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
  const sample = (aud.mode === "only" ? picked[0] : clients.find((c) => aud.mode !== "except" || !aud.client_ids.includes(c.id))) ?? null;

  /* the live preview: what the client gets */
  const side = (
    <div className="gw-pv">
      <span className="gw-pv-tag"><Ico d={I.eye} s={13} />What the client gets</span>
      <div className="gw-mail">
        <div className="gw-mail-h">
          <span className="gw-mail-from">{ent ? <EntMark e={ent} /> : <span className="bf-em" style={{ background: "#0a6f4d" }}>?</span>}
            <span><b>{ent ? (ent.name || ent.legal_name) : "Your company"}</b><small>{f.from_address || box?.email || "pick a mailbox"}</small></span></span>
          <span className="gw-mail-to"><small>To</small>{sample ? <><ClientLogo name={sample.name} website={siteOf(sample.id, sample.email)} size={18} />{sample.email || sample.name}</> : "the client's billing e-mail"}{cc.trim() ? ` · cc ${cc}` : ""}</span>
          <b className="gw-mail-s"><Vars t={mailSubject} /></b>
        </div>
        <div className="gw-mail-b">
          {tpl ? <p className="gw-mute">Your Marketing template <b>“{tpl.name}”</b> (without its unsubscribe footer).</p> : mailBody.split(/\n{2,}/).map((p, i) => <p key={i}><Vars t={p} /></p>)}
          {f.attach_pdf && (
            <span className={`gw-att ${at === 5 ? "is-hl" : ""}`}><BpThumb d={bp?.design ?? DESIGN_DEFAULT} ent={ent} /><span><b>{lang === "es" ? "Factura" : "Invoice"} 2026-0042{ent?.name ? ` - ${ent.name}` : ""}.pdf</b><small>PDF · {bp?.name ?? "standard"}</small></span></span>
          )}
        </div>
      </div>
      <div className="gw-when">
        <span className={`bf-trig is-${trig}`}><Ico d={TRIG_ICON[trig]} s={15} /></span>
        <span><b>{triggerText({ trigger: trig, trigger_days: f.trigger_days ?? 0, send_drafts: !!f.send_drafts })}</b>
          <small>{covered} client{covered === 1 ? "" : "s"}{noMail ? ` · ${noMail} without a billing e-mail` : ""}</small></span>
      </div>
    </div>
  );

  const finish = (
    <>
      {f.id && <button className="bf-btn is-danger" onClick={() => void del()} disabled={!!busy} title="Delete"><Ico d={I.trash} s={14} /></button>}
      {msg && <span className={`bf-msg ${msg.ok ? "is-ok" : "is-err"}`}>{msg.t}</span>}
      {f.id && f.status === "active" && <button className="bf-btn" onClick={() => void run()} disabled={!!busy}><Ico d={I.play} s={13} />{busy === "run" ? "Running…" : "Run now"}</button>}
      <button className="bf-btn" onClick={() => void test()} disabled={!!busy || !f.sender_account} title={f.sender_account ? "Sends this workflow's e-mail and PDF to you only" : "Pick a mailbox first"}><Ico d={I.mail} s={14} />{busy === "test" ? "Sending…" : "Send me a test"}</button>
      <button className="bf-btn" onClick={() => void save()} disabled={!!busy}>{busy === "save" ? "Saving…" : f.status === "active" ? "Save" : "Save as draft"}</button>
      {f.status !== "active" && <button className="bf-btn is-primary gw-next" onClick={() => void save(true)} disabled={!!busy || !f.sender_account}><Ico d={I.spark} s={14} />Save & switch on</button>}
    </>
  );

  return (
    <Wizard icon={I.flow} eyebrow={isNew ? "New workflow" : "Workflow"} onClose={onClose} steps={steps} at={at} onAt={go} side={at === 6 ? undefined : side}
      canNext={canNext} why={why} foot={finish}
      title={<input className="bf-title-in" value={f.name ?? ""} placeholder={autoName()} onChange={(e) => set({ name: e.target.value })} aria-label="Workflow name" />}
      head={f.id ? <span className={`bf-state is-${f.status}`}>{f.status === "active" ? "On" : f.status === "paused" ? "Paused" : "Draft"}</span> : null}>

      {at === 0 && <>
        <div className="gw-grid2" role="radiogroup">
          {(Object.keys(TRIGGER_LABEL) as FlowTrigger[]).map((k) => (
            <Choice key={k} on={trig === k} onClick={() => set({ trigger: k, trigger_days: k === "overdue" ? (f.trigger_days || 7) : k === "before_due" ? (f.trigger_days || 3) : 0 })}
              icon={<span className={`bf-trig is-${k}`}><Ico d={TRIG_ICON[k]} s={17} /></span>} title={TRIGGER_LABEL[k]} sub={TRIG_HINT[k]} />
          ))}
        </div>
        {(trig === "before_due" || trig === "overdue") && (
          <div className="gw-box">
            <b>How many days {trig === "before_due" ? "before the due date" : "after the due date"}?</b>
            <div className="gw-days">
              {(trig === "before_due" ? [1, 3, 7, 14] : [0, 3, 7, 15, 30]).map((n) => (
                <button key={n} className={f.trigger_days === n ? "is-on" : ""} onClick={() => set({ trigger_days: n })}>{n === 0 ? "Same day" : `${n} day${n === 1 ? "" : "s"}`}</button>
              ))}
              <span className="bf-days">
                <button onClick={() => set({ trigger_days: Math.max(trig === "before_due" ? 1 : 0, (f.trigger_days ?? 0) - 1) })} aria-label="One day less">−</button>
                <input type="number" min={0} max={90} value={f.trigger_days ?? 0} onChange={(e) => set({ trigger_days: Math.max(0, Math.min(90, Math.round(Number(e.target.value) || 0))) })} />
                <button onClick={() => set({ trigger_days: Math.min(90, (f.trigger_days ?? 0) + 1) })} aria-label="One day more">+</button>
              </span>
            </div>
            <Timeline trig={trig} days={f.trigger_days ?? 0} />
            <small className="gw-mute">Only while the invoice is unpaid — once it's paid, no reminder goes out. Add one workflow per reminder (e.g. 3 days before, then 7 days overdue).</small>
          </div>
        )}
        {trig === "billing_day" && (
          <div className="gw-box">
            <b>The billing day makes the month's invoices as drafts. Then…</b>
            <div className="gw-grid2" role="radiogroup">
              <Choice on={!!f.send_drafts} onClick={() => set({ send_drafts: true })} icon={<Ico d={I.send} s={17} />} title="Send them straight away" sub="Each draft goes to its client and is marked sent. Fully automatic." tone="green" />
              <Choice on={!f.send_drafts} onClick={() => set({ send_drafts: false })} icon={<Ico d={I.eye} s={17} />} title="After someone reviews them" sub="They wait in To invoice; when someone marks one sent, it goes out." />
            </div>
          </div>
        )}
        {trig === "issued" && <p className="gw-tip"><Ico d={I.info} s={14} />Covers every invoice — made by hand or by the billing day — the moment it's marked sent.</p>}
      </>}

      {at === 1 && <>
        <div className="gw-grid3" role="radiogroup">
          <Choice on={aud.mode === "all"} onClick={() => set({ audience: { ...aud, mode: "all" } })} icon={<Ico d={I.users} s={17} />} title="All clients" sub={`${clients.length} today, and new ones too`} />
          <Choice on={aud.mode === "only"} onClick={() => set({ audience: { ...aud, mode: "only" } })} icon={<Ico d={I.check} s={17} />} title="Only some" sub="Pick the clients" />
          <Choice on={aud.mode === "except"} onClick={() => set({ audience: { ...aud, mode: "except" } })} icon={<Ico d={I.x} s={17} />} title="All except some" sub="Leave a few out" />
        </div>
        {aud.mode !== "all" && (
          <div className="gw-box">
            <b>{aud.mode === "only" ? "Which clients?" : "Which clients stay out?"}</b>
            <div className="bf-chips">
              {picked.map((c) => (
                <span key={c.id} className="bf-chip"><ClientLogo name={c.name} website={siteOf(c.id, c.email)} size={20} />{c.name}
                  <button onClick={() => set({ audience: { ...aud, client_ids: aud.client_ids.filter((x) => x !== c.id) } })} aria-label={`Remove ${c.name}`}>×</button></span>
              ))}
              <input value={pick} onChange={(e) => setPick(e.target.value)} placeholder={picked.length ? "Add another client…" : "Search a client…"} autoFocus />
            </div>
            <div className="gw-clients">
              {pool.slice(0, 40).map((c) => (
                <button key={c.id} onClick={() => { set({ audience: { ...aud, client_ids: [...aud.client_ids, c.id] } }); setPick(""); }}>
                  <ClientLogo name={c.name} website={siteOf(c.id, c.email)} size={26} /><span><b>{c.name}</b><small>{c.email || <em className="is-warn">no billing e-mail</em>}</small></span><Ico d={I.plus} s={14} />
                </button>
              ))}
              {!pool.length && <p className="bf-none">No client matches.</p>}
            </div>
          </div>
        )}
        <div className="gw-facts">
          <span className="gw-fact"><b>{covered}</b><small>client{covered === 1 ? "" : "s"} covered</small></span>
          {noMail > 0 && <span className="gw-fact is-warn"><b>{noMail}</b><small>without a billing e-mail — their invoices can't be e-mailed</small></span>}
          {shadow && <span className="gw-fact is-warn"><Ico d={I.alert} s={15} /><small>“{shadow.name}” is above this one and already takes every client for this step — move this one up in the list, or narrow that one.</small></span>}
        </div>
      </>}

      {at === 2 && <>
        <div className="gw-grid2" role="radiogroup">
          {ents.map((e) => {
            const missing = [!e.tax_id && "tax ID", !(e.street && e.city) && "address", !e.iban && "IBAN"].filter(Boolean) as string[];
            return (
              <Choice key={e.id} on={(f.entity_id ?? defEnt?.id) === e.id} onClick={() => set({ entity_id: e.id === defEnt?.id ? null : e.id })}
                icon={<EntMark e={e} big />} title={<>{e.name || e.legal_name}{e.is_default && <i className="bf-def"><Ico d={I.star} s={10} />Default</i>}</>}
                sub={<>{e.legal_name && e.legal_name !== e.name ? `${e.legal_name} · ` : ""}{e.tax_id || "no tax ID"}</>}>
                {missing.length > 0 && <em className="gw-miss">Missing: {missing.join(", ")}</em>}
              </Choice>
            );
          })}
          {!ents.length && (
            <Choice on={!f.entity_id} onClick={() => set({ entity_id: null })} icon={<Ico d={I.card} s={17} />} title="Your Billing settings" sub="The seller details from Billing › Automatic invoices" />
          )}
          <button className="gw-ch is-add" onClick={async () => { const e = await onNewEntity(); if (e) set({ entity_id: e.id }); }}>
            <span className="gw-ch-ico"><Ico d={I.plus} s={18} /></span><span className="gw-ch-t"><b>Add a company</b><small>A guided form — two minutes</small></span>
          </button>
        </div>
        {ents.length > 0 && <button className="bf-link" onClick={() => onTab("companies")}>Edit companies</button>}
      </>}

      {at === 3 && <>
        {boxes === null ? <span className="bf-skel-in" /> : boxes.length === 0 ? (
          <div className="gw-empty">
            <span><Ico d={I.mail} s={24} /></span>
            <b>No mailbox connected yet</b>
            <p>Connect Gmail, Outlook or an SMTP mailbox in <b>Settings › Integrations</b>, then come back — your work here is kept if you save it as a draft first.</p>
          </div>
        ) : (
          <div className="gw-grid2" role="radiogroup">
            {boxes.map((b) => (
              <Choice key={b.id} on={f.sender_account === b.id} onClick={() => set({ sender_account: b.id })}
                icon={<span className={`gw-prov is-${b.kind}`}>{b.kind === "gmail" ? "G" : b.kind === "ionos" ? "@" : "O"}</span>}
                title={b.email} sub={acctLabel(b).split(" · ")[1] ?? ""}>
                {b.status === "error" && <em className="gw-miss">Needs reconnecting</em>}
              </Choice>
            ))}
          </div>
        )}
        <button className={`gw-more ${more ? "is-open" : ""}`} onClick={() => setMore(!more)}><Ico d={I.down} s={14} />More options: send as an alias, copy someone</button>
        {more && (
          <div className="bf-two">
            <label className="bf-f"><span>Send as <em>optional</em></span><input value={f.from_address ?? ""} placeholder="billing@yourcompany.com (an alias of that mailbox)" onChange={(e) => set({ from_address: e.target.value || null })} /></label>
            <label className="bf-f"><span>Copy to <em>optional</em></span><input value={cc} placeholder="accounts@yourcompany.com" onChange={(e) => { setCc(e.target.value); setMsg(null); }} /></label>
          </div>
        )}
      </>}

      {at === 4 && <>
        <div className="gw-grid1" role="radiogroup">
          <Choice on={!f.template_id} onClick={() => set({ template_id: null })} icon={<Ico d={I.doc} s={17} />} tone="green"
            title={bp ? `The blueprint's e-mail · ${bp.name}` : "The standard invoice e-mail"} sub="Short and clear, in the blueprint's language — edit its words in Blueprints › E-mail." />
        </div>
        {tpls.length > 0 && (
          <div className="gw-box">
            <div className="gw-box-h"><b>Or one of your Marketing templates</b><input className="gw-search" value={tq} onChange={(e) => setTq(e.target.value)} placeholder="Search…" /></div>
            <div className="gw-list">
              {tpls.filter((t) => !tq.trim() || t.name.toLowerCase().includes(tq.trim().toLowerCase())).map((t) => (
                <Choice key={t.id} on={f.template_id === t.id} onClick={() => set({ template_id: t.id })} icon={<Ico d={I.mail} s={16} />} title={t.name} sub={t.subject} />
              ))}
            </div>
          </div>
        )}
        {f.template_id && !tpl && <p className="gw-tip is-warn"><Ico d={I.alert} s={14} />The Marketing template it used no longer exists — pick another.</p>}
        {!tpl && <button className="bf-link" onClick={() => onTab("blueprints")}>Edit the blueprint's e-mail</button>}
      </>}

      {at === 5 && <>
        <button className={`bf-tg is-box ${f.attach_pdf ? "is-on" : ""}`} onClick={() => set({ attach_pdf: !f.attach_pdf })} role="switch" aria-checked={!!f.attach_pdf}>
          <span><b>Attach the invoice as a PDF</b><small>Recommended — most clients file the PDF</small></span><i />
        </button>
        {f.attach_pdf && <>
          <div className="gw-bps" role="radiogroup">
            {bps.map((b) => (
              <button key={b.id} className={`gw-bp ${(f.blueprint_id ?? defBp?.id) === b.id ? "is-on" : ""}`} onClick={() => set({ blueprint_id: b.id === defBp?.id ? null : b.id })} role="radio" aria-checked={(f.blueprint_id ?? defBp?.id) === b.id}>
                <BpThumb d={b.design} ent={ent} />
                <span><b>{b.name || "Untitled"}</b><small>{b.design.layout === "band" ? "Colour band" : b.design.layout === "minimal" ? "Minimal" : "Classic"} · {b.design.lang === "es" ? "Spanish" : "English"}{b.is_default ? " · default" : ""}</small></span>
                <span className="gw-ch-dot" aria-hidden="true"><Ico d={I.check} s={12} /></span>
              </button>
            ))}
            {!bps.length && (
              <button className="gw-bp is-on" role="radio" aria-checked>
                <BpThumb d={DESIGN_DEFAULT} ent={ent} /><span><b>Standard</b><small>Classic · Spanish</small></span><span className="gw-ch-dot"><Ico d={I.check} s={12} /></span>
              </button>
            )}
            <button className="gw-bp is-add" onClick={() => onTab("blueprints")}><span className="bf-plus"><Ico d={I.plus} s={22} /></span><span><b>Design a blueprint</b><small>Layout, colour, texts</small></span></button>
          </div>
          <button className="bf-btn" onClick={() => void preview()} disabled={!!busy}><Ico d={I.eye} s={14} />{busy === "pdf" ? "Making it…" : `See the PDF${ent ? ` issued by ${ent.name || ent.legal_name}` : ""}`}</button>
        </>}
      </>}

      {at === 6 && (
        <div className="gw-review">
          <div className="gw-rev-list">
            {steps.slice(0, 6).map((x, i) => (
              <button key={x.key} className={`gw-rev ${i === 3 && !f.sender_account ? "is-warn" : ""}`} onClick={() => go(i)}>
                <span className="gw-rev-ico"><Ico d={x.icon} s={16} /></span>
                <span className="gw-rev-k">{x.label}</span>
                <span className="gw-rev-v">{x.summary}</span>
                <span className="gw-rev-go"><Ico d={I.edit} s={13} />Change</span>
              </button>
            ))}
          </div>
          <div className="gw-rev-side">{side}</div>
          {!f.sender_account && <p className="gw-tip is-warn"><Ico d={I.alert} s={14} />It can be saved as a draft, but it needs a mailbox (step 4) before it can switch on.</p>}
          {shadow && <p className="gw-tip is-warn"><Ico d={I.alert} s={14} />“{shadow.name}” is above this one and takes every client first — reorder them in the list after saving.</p>}
        </div>
      )}
    </Wizard>
  );
}

/** "Due 30 Nov — reminder on 27 Nov" drawn as a line. */
function Timeline({ trig, days }: { trig: FlowTrigger; days: number }) {
  const due = new Date(); due.setDate(due.getDate() + 14);
  const at = new Date(due); at.setDate(due.getDate() + (trig === "before_due" ? -days : days));
  const d = (x: Date) => x.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const issued = new Date(due); issued.setDate(due.getDate() - 30);
  return (
    <div className={`gw-tl is-${trig}`}>
      <span className="gw-tl-p is-a"><i />Issued<small>{d(issued)}</small></span>
      {trig === "before_due" && <span className="gw-tl-p is-hit"><i />Reminder<small>{d(at)}</small></span>}
      <span className="gw-tl-p is-due"><i />Due<small>{d(due)}</small></span>
      {trig === "overdue" && <span className="gw-tl-p is-hit"><i />Reminder<small>{days ? d(at) : "same day"}</small></span>}
    </div>
  );
}

/* ============================ the issuing company ============================ */
export function EntityWizard({ init, usedBy, onClose, onSaved, onDeleted }: {
  init: Partial<Entity>; usedBy: number; onClose: () => void; onSaved: (e: Entity, def: boolean) => void | Promise<void>; onDeleted: () => void | Promise<void>;
}) {
  const isNew = !init.id;
  const [e, setE] = useState<Partial<Entity>>({ ...ENTITY_EMPTY, ...init });
  const [def, setDef] = useState(!!init.is_default);
  const [at, setAt] = useState(isNew ? 0 : 4);
  const [seen, setSeen] = useState<Set<number>>(() => new Set(isNew ? [0] : [0, 1, 2, 3, 4]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [logoBad, setLogoBad] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { window.setTimeout(() => firstRef.current?.focus(), 60); }, [at]);
  const set = (p: Partial<Entity>) => { setE((x) => ({ ...x, ...p })); setErr(null); };
  const go = (i: number) => { setAt(i); setSeen((s) => new Set(s).add(i)); };
  const F = (k: keyof Entity, label: string, ph = "", o: { hint?: string; first?: boolean; check?: "ok" | "bad" | null; note?: string; fmt?: (v: string) => string } = {}) => (
    <label className={`bf-f gw-fld ${o.check ? `is-${o.check}` : ""}`}><span>{label}{o.hint && <em>{o.hint}</em>}</span>
      <span className="gw-in">
        <input ref={o.first ? firstRef : undefined} value={String(e[k] ?? "")} placeholder={ph} onChange={(ev) => set({ [k]: ev.target.value } as Partial<Entity>)}
          onBlur={o.fmt ? (ev) => set({ [k]: o.fmt!(ev.target.value) } as Partial<Entity>) : undefined} />
        {o.check === "ok" && <i className="gw-ok"><Ico d={I.check} s={13} /></i>}
      </span>
      {o.note && <small className={o.check === "bad" ? "gw-bad" : "gw-mute"}>{o.note}</small>}
    </label>
  );
  const name = (e.name ?? "").trim() || (e.legal_name ?? "").trim();
  const taxCheck = !e.tax_id ? null : taxLooksOk(e.tax_id) ? "ok" : "bad";
  const ibanCheck = !e.iban ? null : ibanOk(e.iban) ? "ok" : "bad";
  const mailCheck = !e.email ? null : EMAIL_RE.test(e.email.trim()) ? "ok" : "bad";
  const addr = e.street || e.city || e.postal_code ? [e.street, [e.postal_code, e.city].filter(Boolean).join(" "), [e.province, e.country].filter(Boolean).join(", ")].filter(Boolean) as string[] : [];
  const steps: WStep[] = [
    { key: "who", label: "Who it is", icon: I.building, q: "Which company issues the invoices?", hint: "As it appears in the company register — the legal name and tax ID are required on every invoice.",
      summary: name ? `${name}${e.tax_id ? ` · ${e.tax_id}` : ""}` : "Not yet", done: !!name && !!e.tax_id },
    { key: "addr", label: "Address", icon: I.pin, q: "Where is it registered?", hint: "The fiscal address printed under the company's name.",
      summary: addr.length ? addr.slice(0, 2).join(", ") : "Not yet", done: !!(e.street && e.city) },
    { key: "pay", label: "Getting paid", icon: I.card, q: "How do clients pay and reach you?", hint: "The IBAN is printed on the invoice under “How to pay”; the e-mail and phone in its contact line.",
      summary: e.iban ? `IBAN •••• ${e.iban.replace(/\s/g, "").slice(-4)}` : "No IBAN", done: seen.has(3) || (!!e.iban && ibanCheck === "ok"), optional: true },
    { key: "brand", label: "Brand", icon: I.brush, q: "How does it look?", hint: "A logo on the invoice makes it look like yours. No logo? Pick a colour for its mark.",
      summary: e.logo_url ? "Logo" : e.website ? e.website : e.color ? "Colour mark" : "Default", done: seen.has(4) || !!e.logo_url, optional: true },
    { key: "review", label: "Review", icon: I.check, q: "Is it all correct?", hint: "This is how the top of each invoice from this company will read. Click a line to change it.",
      summary: e.id ? "Saved" : "Not saved yet", done: !!e.id },
  ];
  const canNext = at === 0 ? !!name : true;
  const why = at === 0 && !name ? "Write at least its name." : null;
  const save = async () => {
    if (!name) { setErr("Give it a name (step 1)."); go(0); return; }
    if (e.logo_url && !/^https:\/\//i.test(e.logo_url)) { setErr("The logo has to be an https:// link to a PNG or JPG (step 4)."); return; }
    setBusy(true); setErr(null);
    try {
      const out = await saveEntity({ ...e, iban: e.iban ? ibanFmt(e.iban) : "", is_default: !!init.is_default, name: (e.name ?? "").trim() || (e.legal_name ?? "").trim() });
      await onSaved(out, def && !init.is_default);
    } catch (x) { setErr(String((x as Error).message)); setBusy(false); }
  };
  const del = async () => {
    if (!e.id) { onClose(); return; }
    if (!window.confirm(`Delete “${e.name || e.legal_name}”?${usedBy ? ` ${usedBy} workflow${usedBy === 1 ? "" : "s"} use it — they'll use the default company.` : ""}`)) return;
    setBusy(true);
    try { await removeRow("base_billing_entities", e.id); await onDeleted(); } catch (x) { setErr(String((x as Error).message)); setBusy(false); }
  };
  const mark = { name: e.name ?? "", legal_name: e.legal_name ?? "", logo_url: logoBad ? "" : e.logo_url ?? "", website: e.website ?? "", color: e.color ?? "" };

  /* the invoice header, drawn as you type */
  const side = (
    <div className="gw-pv">
      <span className="gw-pv-tag"><Ico d={I.eye} s={13} />The top of its invoices</span>
      <div className="gw-inv">
        <div className="gw-inv-h">
          {e.logo_url && !logoBad ? <img className="gw-inv-logo" src={e.logo_url} alt="" onError={() => setLogoBad(true)} /> : <EntMark e={mark} big />}
          <span className="gw-inv-title">{"FACTURA"}<small>2026-0042</small></span>
        </div>
        <div className="gw-inv-from">
          <b>{e.legal_name || e.name || <em>Legal name</em>}</b>
          <span>{e.tax_id ? `NIF ${e.tax_id}` : <em>Tax ID</em>}</span>
          {addr.length ? addr.map((l, i) => <span key={i}>{l}</span>) : <em>Address</em>}
          {(e.email || e.phone || e.website) && <span className="gw-inv-c">{[e.email, e.phone, e.website].filter(Boolean).join(" · ")}</span>}
        </div>
        <div className="gw-inv-lines"><s /><s /><s /></div>
        <div className="gw-inv-pay"><small>{e.iban ? "Pagar a IBAN" : "How to pay"}</small><b>{e.iban ? ibanFmt(e.iban) : <em>IBAN (optional)</em>}</b></div>
      </div>
      {isNew && <button className={`bf-check ${def ? "is-on" : ""}`} onClick={() => setDef(!def)}><i><Ico d={I.check} s={12} /></i>Use it by default</button>}
    </div>
  );

  return (
    <Wizard icon={I.building} eyebrow={isNew ? "New issuing company" : "Issuing company"} onClose={onClose} steps={steps} at={at} onAt={go} side={side}
      canNext={canNext} why={why}
      title={<span className="bf-ent-title"><EntMark e={mark} big />{name || "New company"}</span>}
      foot={<>
        {e.id && <button className="bf-btn is-danger" onClick={() => void del()} disabled={busy}><Ico d={I.trash} s={14} />Delete</button>}
        {!isNew && <button className={`bf-check ${def ? "is-on" : ""}`} onClick={() => setDef(!def)} disabled={!!init.is_default}><i><Ico d={I.check} s={12} /></i>Default company</button>}
        {err && <span className="bf-msg is-err">{err}</span>}
        <button className="bf-btn is-primary gw-next" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : isNew ? "Create company" : "Save company"}</button>
      </>}>
      {at === 0 && <div className="gw-form">
        <div className="bf-two">{F("name", "Trade name", "Next Consulting", { first: true, hint: "how clients know it" })}{F("legal_name", "Legal name", "Next Consulting S.L.", { hint: "as registered" })}</div>
        {F("tax_id", "Tax ID", "B12345678", { hint: "NIF / CIF / VAT", check: taxCheck, note: taxCheck === "bad" ? "That doesn't look like a NIF, CIF or VAT number — check it." : "Spanish NIF/CIF (B12345678) or an EU VAT number (ESB12345678)." })}
      </div>}
      {at === 1 && <div className="gw-form">
        {F("street", "Street and number", "Paseo de la Castellana 100, 4º", { first: true })}
        <div className="bf-three">{F("postal_code", "Postal code", "28046")}{F("city", "Town", "Madrid")}{F("province", "Province", "Madrid")}</div>
        <label className="bf-f"><span>Country</span>
          <Select value={e.country || "ES"} onChange={(v) => set({ country: v })}
            options={[["ES", "Spain"], ["PT", "Portugal"], ["FR", "France"], ["DE", "Germany"], ["IT", "Italy"], ["NL", "Netherlands"], ["BE", "Belgium"], ["IE", "Ireland"], ["GB", "United Kingdom"], ["US", "United States"], ["MX", "Mexico"]].map(([v, l]) => ({ value: v, label: l }))} />
        </label>
      </div>}
      {at === 2 && <div className="gw-form">
        {F("iban", "IBAN", "ES12 3456 7890 1234 5678 9012", { first: true, hint: "printed on the invoice", check: ibanCheck, fmt: (v) => (v ? ibanFmt(v) : v), note: ibanCheck === "bad" ? "That IBAN doesn't add up — a digit may be wrong." : ibanCheck === "ok" ? "Valid IBAN." : "Leave it empty if clients don't pay by transfer." })}
        <div className="bf-two">
          {F("email", "Billing e-mail", "billing@company.com", { check: mailCheck, note: mailCheck === "bad" ? "Not a valid e-mail." : undefined })}
          {F("phone", "Phone", "+34 910 000 000")}
        </div>
      </div>}
      {at === 3 && <div className="gw-form">
        {F("logo_url", "Logo", "https://yourcompany.com/logo.png", { first: true, hint: "a link to a PNG or JPG", check: e.logo_url ? (/^https:\/\//i.test(e.logo_url) && !logoBad ? "ok" : "bad") : null, note: e.logo_url && logoBad ? "That link doesn't open as a picture." : e.logo_url && !/^https:\/\//i.test(e.logo_url) ? "It has to start with https://" : "Tip: right-click your logo on your website › Copy image address." })}
        {F("website", "Website", "yourcompany.com", { note: !e.logo_url ? "With a website and no logo, its icon is used." : undefined })}
        <label className="bf-f"><span>Colour <em>for its mark when there's no logo</em></span>
          <div className="bf-swatches">{ACCENTS.map((c) => <button key={c} className={(e.color || "").toLowerCase() === c ? "is-on" : ""} style={{ background: c }} onClick={() => set({ color: c })} aria-label={c} />)}</div>
        </label>
      </div>}
      {at === 4 && (
        <div className="gw-rev-list">
          {steps.slice(0, 4).map((x, i) => (
            <button key={x.key} className={`gw-rev ${i === 0 && !e.tax_id ? "is-warn" : ""} ${i === 1 && !(e.street && e.city) ? "is-warn" : ""} ${i === 2 && ibanCheck === "bad" ? "is-warn" : ""}`} onClick={() => go(i)}>
              <span className="gw-rev-ico"><Ico d={x.icon} s={16} /></span>
              <span className="gw-rev-k">{x.label}</span>
              <span className="gw-rev-v">{x.summary}</span>
              <span className="gw-rev-go"><Ico d={I.edit} s={13} />Change</span>
            </button>
          ))}
          {(!e.tax_id || !(e.street && e.city)) && <p className="gw-tip is-warn"><Ico d={I.alert} s={14} />A Spanish invoice needs the tax ID and the address — it can be saved now and finished later.</p>}
        </div>
      )}
    </Wizard>
  );
}
