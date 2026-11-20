/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Marketing › Forms — build a form, share its link (or put it in an e-mail),
 * and see what comes back. Each question can be saved into a field of the
 * contact or the company; mk_form_submit (135_mk_forms.sql) does the saving.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../../../../components/api/supabase";
import SalesMultiFilter from "../../../../framework/MultiFilter";
import {
  FIELD_KINDS, FORM_TEMPLATES, KIND, ACCENTS, NEEDS_FORMS, FormView, makeField, mapOptions, mapLabel, isLayout, hasOptions, formUrl, emailBlock,
  answerText, formsMissing, newId, type FormField, type FieldType, type MkForm, type MkFormResponse, type FormSettings, type Answer, type CustomDef, type FormStatus, type FormActionsCfg,
} from "./formsKit";
import "./MarketingForms.css";
import "./FormsModern.css";

export interface FormsListRef { id: string; name: string; kind: string; entity: string }
type View = "build" | "actions" | "responses" | "share";

const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtAgo = (iso: string | null | undefined) => {
  if (!iso) return "No answers yet";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "Just now"; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); return d < 30 ? `${d} day${d === 1 ? "" : "s"} ago` : fmtDay(iso);
};
const STATUS: Record<FormStatus, string> = { draft: "Draft", live: "Live", closed: "Closed" };

const Ico = {
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4-4" /></svg>,
  up: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
  down: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>,
  copy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>,
  link: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></svg>,
  ext: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>,
  mail: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></svg>,
  code: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" /></svg>,
  desk: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>,
  phone: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="3" width="10" height="18" rx="2.5" /><path d="M11 18h2" /></svg>,
  dl: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></svg>,
  form: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 8h8M8 12h8M8 16h4" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  grip: <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="7" r="1.4" /><circle cx="15" cy="7" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="17" r="1.4" /><circle cx="15" cy="17" r="1.4" /></svg>,
  dup: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M4 16V6a2 2 0 0 1 2-2h10" /></svg>,
  grid: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" /></svg>,
  rows: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="4" rx="2" /><rect x="4" y="11" width="16" height="4" rx="2" /><path d="M4 19h16" /></svg>,
  user: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>,
  building: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M3 21h18M8 7h4M8 11h4M8 15h4" /></svg>,
  deal: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" /></svg>,
  task: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>,
  tag: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" /><circle cx="8" cy="8" r="1.6" /></svg>,
  list: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></svg>,
  bolt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>,
  crm: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5A6.5 6.5 0 0 1 21.5 20" /></svg>,
};

/** The forms, and the one that's open. */
export default function FormsTab({ lists, toast, onEmail, head, bar, onCampaign, onListsChanged }: {
  lists: FormsListRef[]; toast: (s: string) => void; onEmail: (form: MkForm) => void;
  /** the page's own tools to show on the left of the bar */
  head?: ReactNode;
  /** the page's bar (right of the tabs): the list's filters, search and "New form" go there */
  bar?: HTMLElement | null;
  /** write an e-mail campaign to this audience */
  onCampaign?: (listId: string, form: MkForm) => void;
  /** a list was made here (Actions › New audience) */
  onListsChanged?: () => Promise<void> | void;
}) {
  const [forms, setForms] = useState<MkForm[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(() => { try { return sessionStorage.getItem("mk-form-open"); } catch { return null; } });
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const [st, setSt] = useState<"all" | FormStatus>("all");
  // BASE: forms are always a list (no cards / list switch)
  const layout = "list" as "cards" | "list";
  const [ct, setCt] = useState<CustomDef[]>([]);
  const [co, setCo] = useState<CustomDef[]>([]);
  const open = (id: string | null) => { setOpenId(id); try { if (id) sessionStorage.setItem("mk-form-open", id); else sessionStorage.removeItem("mk-form-open"); } catch { /* private mode */ } };

  const load = async () => {
    const { data, error } = await supabase.from("mk_forms").select("*").order("updated_at", { ascending: false });
    if (error) { setMissing(formsMissing(error.message)); setForms([]); return; }
    setMissing(false);
    setForms(((data ?? []) as any[]).map((f) => ({ ...f, fields: Array.isArray(f.fields) ? f.fields : [], settings: f.settings ?? {} })));
  };
  useEffect(() => {
    void load();
    supabase.from("contact_fields").select("id, label").order("sort").then(({ data }: any) => setCt((data ?? []) as CustomDef[]));
    supabase.from("company_fields").select("id, label").order("sort").then(({ data }: any) => setCo((data ?? []) as CustomDef[]));
  }, []);

  const create = async (tplKey: string) => {
    const t = FORM_TEMPLATES.find((x) => x.key === tplKey) ?? FORM_TEMPLATES[0];
    const row = { name: t.key === "blank" ? "Untitled form" : t.name, fields: t.fields(), settings: { ...t.settings, mode: "fill", create: true } };
    const { data, error } = await supabase.from("mk_forms").insert(row).select("*").single();
    setPicking(false);
    if (error) { toast(formsMissing(error.message) ? NEEDS_FORMS : error.message); return; }
    const f = data as MkForm;
    setForms((xs) => [f, ...(xs ?? [])]);
    open(f.id);
  };
  const remove = async (id: string) => {
    const { error } = await supabase.from("mk_forms").delete().eq("id", id);
    if (error) { toast(error.message); return; }
    setForms((xs) => (xs ?? []).filter((f) => f.id !== id));
    if (openId === id) open(null);
    toast("Form deleted");
  };
  const duplicate = async (f: MkForm) => {
    const { data, error } = await supabase.from("mk_forms").insert({ name: `${f.name} (copy)`, fields: f.fields.map((x) => ({ ...x, id: newId() })), settings: f.settings }).select("*").single();
    if (error) { toast(error.message); return; }
    setForms((xs) => [data as MkForm, ...(xs ?? [])]);
    toast("Copied — the copy is a draft");
  };

  const cur = forms?.find((f) => f.id === openId) ?? null;
  if (cur) {
    return <FormEditor key={cur.id} form={cur} lists={lists} ct={ct} co={co} toast={toast} onEmail={onEmail} onCampaign={onCampaign} onListsChanged={onListsChanged}
      onBack={() => open(null)} onDelete={() => void remove(cur.id)} onDuplicate={() => void duplicate(cur)}
      onSaved={(f) => setForms((xs) => (xs ?? []).map((y) => (y.id === f.id ? f : y)))} />;
  }

  const nq = q.trim().toLowerCase();
  const shown = (forms ?? []).filter((f) => (st === "all" || f.status === st) && (!nq || f.name.toLowerCase().includes(nq) || (f.settings.title ?? "").toLowerCase().includes(nq)));
  const total = (forms ?? []).reduce((a, f) => a + (f.response_count || 0), 0);
  const by = (s: FormStatus) => (forms ?? []).filter((f) => f.status === s).length;
  const tools = (
    <div className="em-tools mfx-tools">
      {head}
      <div className="mfx-seg" role="group" aria-label="Show">
        {(["all", "live", "draft", "closed"] as const).map((k) => (
          <button key={k} type="button" className={st === k ? "is-on" : ""} onClick={() => setSt(k)} aria-pressed={st === k}>{k === "all" ? "All" : STATUS[k]}<em>{k === "all" ? forms?.length ?? 0 : by(k)}</em></button>
        ))}
      </div>
      <label className={`em-search ${q ? "has-q" : ""}`}>{Ico.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a form" />{q && <button type="button" onClick={() => setQ("")} aria-label="Clear">{Ico.x}</button>}</label>
      <button type="button" className="em-new" onClick={() => setPicking(true)} disabled={missing} title="New form">{Ico.plus}<span>New form</span></button>
    </div>
  );
  return (
    <div className="mkx-page mf">
      {bar ? createPortal(tools, bar) : <div className="mkx-bar">{tools}</div>}
      <div className="mkx-scroll">
        {missing && <div className="mf-setup"><b>One SQL file switches Forms on</b><p>Run <code>135_mk_forms.sql</code> in Supabase (SQL editor). It adds the forms, their answers and the public link.</p></div>}
        {forms == null ? <div className="mf-loading"><span className="mf-spin" /></div>
          : !forms.length && !missing ? (
            <div className="mf-hero">
              <div className="mf-hero-art" aria-hidden="true"><span>{Ico.form}</span><i /><i /><i /></div>
              <h2>Forms that fill your CRM by themselves</h2>
              <p>Build a form with the questions you need — from a name and e-mail to ratings and NPS — and choose what each answer does: fill the contact and the company, give someone a task, add the person to an audience. Share the link, put it on your website or send it in an e-mail.</p>
              <TemplatePicker onPick={(k) => void create(k)} />
            </div>
          ) : layout === "list" ? (
            <div className="mfl">
              <div className="mfl-row is-head"><span>Form</span><span>Status</span><span className="is-num">Questions</span><span className="is-num">Answers</span><span>Last answer</span><span>What it does</span><span /></div>
              <div className="mfl-body">
                {shown.map((f, i) => <FormRow key={f.id} f={f} i={i} onOpen={() => open(f.id)} onDuplicate={() => void duplicate(f)} onDelete={() => void remove(f.id)} />)}
                {!shown.length && <div className="mf-none">No forms match.</div>}
              </div>
              {forms.length > 0 && <p className="mfl-foot"><b>{total.toLocaleString()}</b> answers in all</p>}
            </div>
          ) : (
            <div className="mf-grid">
              <button className="mf-new" onClick={() => setPicking(true)} disabled={missing}><span>{Ico.plus}</span><b>New form</b><em>From scratch or a ready-made one</em></button>
              {shown.map((f) => <FormCard key={f.id} f={f} ct={ct} co={co} onOpen={() => open(f.id)} onDuplicate={() => void duplicate(f)} onDelete={() => void remove(f.id)} />)}
              {!shown.length && <div className="mf-none">No forms match.</div>}
            </div>
          )}
      </div>
      {picking && (
        <div className="mf-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setPicking(false); }}>
          <div className="mf-modal" role="dialog" aria-modal="true">
            <header><div><h2>New form</h2><p>Start from a ready-made form — every question can be changed.</p></div><button className="mf-x" onClick={() => setPicking(false)} aria-label="Close">{Ico.x}</button></header>
            <TemplatePicker onPick={(k) => void create(k)} />
          </div>
        </div>
      )}
    </div>
  );
}

function TemplatePicker({ onPick }: { onPick: (key: string) => void }) {
  return (
    <div className="mf-tpls">
      {FORM_TEMPLATES.map((t) => {
        const fields = t.fields().filter((f) => !isLayout(f.type) && f.type !== "hidden");
        return (
          <button key={t.key} className={`mf-tpl is-${t.tone}`} onClick={() => onPick(t.key)}>
            <span className="mf-tpl-art">
              {t.key === "blank" ? <i className="is-plus">{Ico.plus}</i> : fields.slice(0, 4).map((f) => <i key={f.id} className={`is-${f.type}`}><b /></i>)}
            </span>
            <b>{t.name}</b>
            <em>{t.hint}</em>
            {t.key !== "blank" && <small>{fields.length} questions</small>}
          </button>
        );
      })}
    </div>
  );
}

function FormCard({ f, ct, co, onOpen, onDuplicate, onDelete }: { f: MkForm; ct: CustomDef[]; co: CustomDef[]; onOpen: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const [ask, setAsk] = useState(false);
  const qs = f.fields.filter((x) => !isLayout(x.type) && x.type !== "hidden");
  void ct; void co;
  const accent = f.settings.accent || ACCENTS[0];
  return (
    <div className={`mf-card is-${f.status}`} style={{ ["--acc" as string]: accent } as React.CSSProperties}>
      <button className="mf-card-main" onClick={onOpen}>
        <span className="mf-card-top">
          <span className={`mf-st is-${f.status}`}><i />{STATUS[f.status]}</span>
          <span className="mf-card-n"><b>{(f.response_count || 0).toLocaleString()}</b>{f.response_count === 1 ? "answer" : "answers"}</span>
        </span>
        <b className="mf-card-name">{f.name}</b>
        <em className="mf-card-sub">{f.settings.title && f.settings.title !== f.name ? f.settings.title : `${qs.length} question${qs.length === 1 ? "" : "s"}`}</em>
        <span className="mf-card-mini" aria-hidden="true">{qs.slice(0, 5).map((x) => <i key={x.id} title={KIND[x.type]?.label}>{KIND[x.type]?.icon}</i>)}{qs.length > 5 && <em>+{qs.length - 5}</em>}</span>
        <span className="mf-card-foot">
          <span>{fmtAgo(f.last_response_at)}</span>
          <DoesChips f={f} />
        </span>
      </button>
      <div className="mf-card-acts">
        {ask ? (
          <><span>Delete it and its answers?</span><button className="is-danger" onClick={onDelete}>Delete</button><button onClick={() => setAsk(false)}>Keep</button></>
        ) : (
          <>
            <button onClick={() => void navigator.clipboard?.writeText(formUrl(f.token))} title="Copy the link" disabled={f.status !== "live"}>{Ico.link}</button>
            <button onClick={onDuplicate} title="Make a copy">{Ico.dup}</button>
            <button onClick={() => setAsk(true)} title="Delete">{Ico.trash}</button>
          </>
        )}
      </div>
    </div>
  );
}

/** What a form's answers do in the CRM, as small icons (cards, list). */
function doesWhat(f: MkForm): { k: string; label: string; ico: ReactNode }[] {
  const a = f.settings.actions ?? {};
  const out: { k: string; label: string; ico: ReactNode }[] = [];
  if (f.fields.some((x) => x.map?.startsWith("contact."))) out.push({ k: "contact", label: f.settings.create === false ? "Updates contacts" : "Creates or updates contacts", ico: Ico.user });
  if (a.company?.on !== false && f.fields.some((x) => x.map?.startsWith("company."))) out.push({ k: "company", label: f.settings.create === false ? "Updates companies" : "Creates or updates companies", ico: Ico.building });
  if (a.company_type?.on && a.company_type.values?.length) out.push({ k: "type", label: `Marks the company as ${a.company_type.values.join(", ")}`, ico: Ico.tag });
  if (a.task?.on && a.task.assignee_id) out.push({ k: "task", label: "Gives someone a task", ico: Ico.task });
  if (f.settings.list_id) out.push({ k: "list", label: "Adds the person to an audience", ico: Ico.list });
  return out;
}
function DoesChips({ f }: { f: MkForm }) {
  const d = doesWhat(f);
  if (!d.length) return <span className="mf-does is-none">Answers only</span>;
  return <span className="mf-does">{d.map((x) => <i key={x.k} className={`is-${x.k}`} title={x.label}>{x.ico}</i>)}</span>;
}
function FormRow({ f, i, onOpen, onDuplicate, onDelete }: { f: MkForm; i: number; onOpen: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const [ask, setAsk] = useState(false);
  const qs = f.fields.filter((x) => !isLayout(x.type) && x.type !== "hidden");
  return (
    <div className={`mfl-row mfl-tr is-${f.status}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      style={{ ["--i" as string]: Math.min(i, 12), ["--acc" as string]: f.settings.accent || ACCENTS[0] } as React.CSSProperties}>
      <span className="mfl-name"><i className="mfl-ico">{Ico.form}</i><span><b>{f.name}</b><em>{f.settings.title && f.settings.title !== f.name ? f.settings.title : `Created ${fmtDay(f.created_at)}`}</em></span></span>
      <span><span className={`mf-st is-${f.status}`}><i />{STATUS[f.status]}</span></span>
      <span className="is-num">{qs.length}</span>
      <span className="is-num"><b>{(f.response_count || 0).toLocaleString()}</b></span>
      <span className="mfl-when">{fmtAgo(f.last_response_at)}</span>
      <span><DoesChips f={f} /></span>
      <span className="mfl-acts" onClick={(e) => e.stopPropagation()}>
        {ask ? (
          <><button className="is-danger" onClick={onDelete}>Delete</button><button onClick={() => setAsk(false)}>Keep</button></>
        ) : (
          <>
            <button onClick={() => void navigator.clipboard?.writeText(formUrl(f.token))} title="Copy the link" disabled={f.status !== "live"}>{Ico.link}</button>
            <button onClick={onDuplicate} title="Make a copy">{Ico.dup}</button>
            <button onClick={() => setAsk(true)} title="Delete">{Ico.trash}</button>
          </>
        )}
      </span>
    </div>
  );
}

/* ══════════════════════════ one form ══════════════════════════ */
function FormEditor({ form, lists, ct, co, toast, onEmail, onCampaign, onListsChanged, onBack, onDelete, onDuplicate, onSaved }: {
  form: MkForm; lists: FormsListRef[]; ct: CustomDef[]; co: CustomDef[]; toast: (s: string) => void; onEmail: (f: MkForm) => void;
  onCampaign?: (listId: string, f: MkForm) => void; onListsChanged?: () => Promise<void> | void;
  onBack: () => void; onDelete: () => void; onDuplicate: () => void; onSaved: (f: MkForm) => void;
}) {
  const [f, setF] = useState<MkForm>(form);
  const [view, setView] = useState<View>(() => (form.response_count > 0 ? "responses" : "build"));
  const [save, setSave] = useState<"saved" | "saving" | "dirty" | { err: string }>("saved");
  const [ask, setAsk] = useState(false);
  const first = useRef(true);
  const patch = (p: Partial<MkForm>) => setF((x) => ({ ...x, ...p }));
  const setSettings = (p: Partial<FormSettings>) => setF((x) => ({ ...x, settings: { ...x.settings, ...p } }));

  // saved by itself, a moment after each change
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setSave("dirty");
    const t = window.setTimeout(async () => {
      setSave("saving");
      const row = { name: f.name.trim() || "Untitled form", status: f.status, fields: f.fields, settings: f.settings, updated_at: new Date().toISOString() };
      const { data, error } = await supabase.from("mk_forms").update(row).eq("id", f.id).select("*").maybeSingle();
      if (error) { setSave({ err: error.message }); return; }
      setSave("saved");
      if (data) onSaved({ ...(data as MkForm), fields: (data as any).fields ?? [], settings: (data as any).settings ?? {} });
    }, 700);
    return () => window.clearTimeout(t);
  }, [f.name, f.status, f.fields, f.settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const publish = (s: FormStatus) => { patch({ status: s }); if (s === "live") toast("The form is live — its link works now"); };
  const nq = f.fields.filter((x) => !isLayout(x.type)).length;
  return (
    <div className="mkx-page mf-ed">
      <div className="mkx-bar mf-ed-bar">
        <button className="mkx-back" onClick={onBack} aria-label="Back to forms">{Ico.back}</button>
        <input className="mf-ed-name" value={f.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Name this form" aria-label="Form name" />
        <div className={`mf-status is-${f.status}`} role="radiogroup" aria-label="Status">
          {(["draft", "live", "closed"] as FormStatus[]).map((s) => (
            <button key={s} role="radio" aria-checked={f.status === s} className={f.status === s ? "is-on" : ""} onClick={() => publish(s)}><i />{STATUS[s]}</button>
          ))}
        </div>
        <span className={`mf-saved ${typeof save === "object" ? "is-err" : `is-${save}`}`} title={typeof save === "object" ? save.err : undefined}>
          {save === "saved" ? <>{Ico.check}Saved</> : save === "saving" ? "Saving…" : save === "dirty" ? "Editing…" : "Not saved"}
        </span>
        <span className="mkx-grow" />
        <div className="mkx-seg is-tabs">
          {([["build", "Build", nq], ["actions", "Actions", doesWhat(f).length || null], ["responses", "Answers", f.response_count], ["share", "Share", null]] as [View, string, number | null][]).map(([k, l, n]) => (
            <button key={k} className={view === k ? "is-on" : ""} onClick={() => setView(k)}>{l}{n != null && <em>{n.toLocaleString()}</em>}</button>
          ))}
        </div>
        {f.status === "live"
          ? <a className="mkx-btn" href={formUrl(f.token)} target="_blank" rel="noreferrer">{Ico.ext}Open</a>
          : <button className="mkx-btn is-primary" onClick={() => publish("live")}>Publish</button>}
        <div className="mf-more">
          {ask ? <span className="mf-ask"><span>Delete this form?</span><button className="is-danger" onClick={onDelete}>Delete</button><button onClick={() => setAsk(false)}>Keep</button></span>
            : <><button className="mkx-icon" onClick={onDuplicate} title="Make a copy">{Ico.dup}</button><button className="mkx-icon" onClick={() => setAsk(true)} title="Delete form">{Ico.trash}</button></>}
        </div>
      </div>
      {view === "build" && <Builder f={f} setF={setF} setSettings={setSettings} ct={ct} co={co} />}
      {view === "responses" && <Responses f={f} ct={ct} co={co} />}
      {view === "share" && <Share f={f} toast={toast} onEmail={() => onEmail(f)} onPublish={() => publish("live")} />}
      {view === "actions" && <FormActions f={f} setSettings={setSettings} setF={setF} lists={lists} toast={toast} onListsChanged={onListsChanged} onCampaign={onCampaign ? (id) => onCampaign(id, f) : undefined} />}
    </div>
  );
}

/* ---------------- Build ---------------- */
function Builder({ f, setF, setSettings, ct, co }: { f: MkForm; setF: (u: (x: MkForm) => MkForm) => void; setSettings: (p: Partial<FormSettings>) => void; ct: CustomDef[]; co: CustomDef[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, Answer>>({});
  const [dev, setDev] = useState<"desktop" | "mobile">("desktop");
  const [drop, setDrop] = useState<number | null>(null);
  const drag = useRef<{ kind: "new"; type: FieldType } | { kind: "move"; id: string } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const fields = f.fields;
  const setFields = (fs: FormField[]) => setF((x) => ({ ...x, fields: fs }));
  const selF = fields.find((x) => x.id === sel) ?? null;
  const upd = (id: string, p: Partial<FormField>) => setFields(fields.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const add = (type: FieldType, at?: number) => {
    const nf = makeField(type);
    // the e-mail question is how the contact is found: only one goes to contact.email
    if (nf.map && fields.some((x) => x.map === nf.map) && nf.map !== "contact.opt_in") nf.map = null;
    const i = at ?? (sel ? fields.findIndex((x) => x.id === sel) + 1 : fields.length);
    const next = [...fields]; next.splice(Math.max(0, Math.min(i, fields.length)), 0, nf);
    setFields(next); setSel(nf.id);
    window.setTimeout(() => canvas.current?.querySelector(`[data-fid="${nf.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30);
  };
  const move = (id: string, to: number) => {
    const from = fields.findIndex((x) => x.id === id); if (from < 0) return;
    const next = [...fields]; const [it] = next.splice(from, 1); next.splice(to > from ? to - 1 : to, 0, it); setFields(next);
  };
  const removeF = (id: string) => { const i = fields.findIndex((x) => x.id === id); setFields(fields.filter((x) => x.id !== id)); setSel(fields[i + 1]?.id ?? fields[i - 1]?.id ?? null); };
  const dupF = (id: string) => { const i = fields.findIndex((x) => x.id === id); const c = { ...fields[i], id: newId(), map: fields[i].map === "contact.email" ? null : fields[i].map }; const next = [...fields]; next.splice(i + 1, 0, c); setFields(next); setSel(c.id); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!sel || /INPUT|TEXTAREA/.test(t.tagName) || t.isContentEditable) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeF(sel); }
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  /** where a drag over the canvas would land: before the question under the pointer (or after the last) */
  const dropAt = (y: number) => {
    const els = Array.from(canvas.current?.querySelectorAll<HTMLElement>(".fv-q[data-fid]") ?? []);
    for (let i = 0; i < els.length; i++) { const r = els[i].getBoundingClientRect(); if (y < r.top + r.height / 2) return fields.findIndex((x) => x.id === els[i].dataset.fid); }
    return fields.length;
  };
  const groups = useMemo(() => [...new Set(FIELD_KINDS.map((k) => k.group))], []);
  return (
    <div className="mf-build">
      <aside className="mf-pal" aria-label="Questions you can add">
        <div className="mf-pal-scroll">
          {groups.map((g) => (
            <div key={g} className="mf-pal-g">
              <h4>{g}</h4>
              {FIELD_KINDS.filter((k) => k.group === g).map((k) => (
                <button key={k.type} className="mf-pal-i" draggable onClick={() => add(k.type)} title={k.hint}
                  onDragStart={(e) => { drag.current = { kind: "new", type: k.type }; e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("text/plain", k.type); }}
                  onDragEnd={() => { drag.current = null; setDrop(null); }}>
                  <i>{k.icon}</i><span>{k.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <section className="mf-canvas-w">
        <div className="mf-canvas-bar">
          <span>Preview · what people see</span>
          <span className="mkx-grow" />
          <div className="mkx-seg is-sm">
            <button className={dev === "desktop" ? "is-on" : ""} onClick={() => setDev("desktop")} title="Computer">{Ico.desk}</button>
            <button className={dev === "mobile" ? "is-on" : ""} onClick={() => setDev("mobile")} title="Phone">{Ico.phone}</button>
          </div>
        </div>
        <div ref={canvas} className={`mf-canvas is-${dev} ${drop != null ? "is-dropping" : ""}`}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setSel(null); }}
          onDragOver={(e) => { if (!drag.current) return; e.preventDefault(); setDrop(dropAt(e.clientY)); }}
          onDragLeave={(e) => { if (!canvas.current?.contains(e.relatedTarget as Node)) setDrop(null); }}
          onDrop={(e) => {
            e.preventDefault(); const d = drag.current; const at = dropAt(e.clientY); drag.current = null; setDrop(null);
            if (d?.kind === "new") add(d.type, at); else if (d?.kind === "move") move(d.id, at);
          }}>
          <DropLine fields={fields} at={drop} host={canvas} />
          <FormView form={f} values={vals} onChange={(id, v) => setVals((x) => ({ ...x, [id]: v }))} preview selected={sel} onSelect={setSel} width={dev}
            renderTools={(q, i) => (
              <div className="mf-qtools" onMouseDown={(e) => e.stopPropagation()}>
                <span className="mf-qtools-k">{KIND[q.type]?.icon}{KIND[q.type]?.label}{q.map && <em>→ {mapLabel(q.map, ct, co)}</em>}</span>
                <button draggable title="Drag to move" className="is-grip"
                  onDragStart={(e) => { drag.current = { kind: "move", id: q.id }; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", q.id); }}
                  onDragEnd={() => { drag.current = null; setDrop(null); }}>{Ico.grip}</button>
                <button onClick={() => move(q.id, i - 1)} disabled={i === 0} title="Move up">{Ico.up}</button>
                <button onClick={() => move(q.id, i + 2)} disabled={i === fields.length - 1} title="Move down">{Ico.down}</button>
                <button onClick={() => dupF(q.id)} title="Duplicate">{Ico.dup}</button>
                <button onClick={() => removeF(q.id)} title="Delete" className="is-del">{Ico.trash}</button>
              </div>
            )} />
        </div>
      </section>

      <aside className="mf-insp">
        <div className="mf-insp-scroll">
          {selF ? <FieldInspector key={selF.id} q={selF} all={fields} ct={ct} co={co} onPatch={(p) => upd(selF.id, p)} onType={(t) => upd(selF.id, { type: t, ...(hasOptions(t) && !selF.options?.length ? { options: ["Option 1", "Option 2"] } : {}) })} />
            : <LookInspector f={f} setSettings={setSettings} n={fields.length} />}
        </div>
      </aside>
    </div>
  );
}

function DropLine({ fields, at, host }: { fields: FormField[]; at: number | null; host: React.RefObject<HTMLDivElement | null> }) {
  if (at == null || !host.current) return null;
  const els = Array.from(host.current.querySelectorAll<HTMLElement>(".fv-q[data-fid]"));
  const box = host.current.getBoundingClientRect();
  let top: number, left: number, width: number;
  if (!els.length) { const e = host.current.querySelector<HTMLElement>(".fv-grid"); const r = e?.getBoundingClientRect(); if (!r) return null; top = r.top + 30; left = r.left + 38; width = r.width - 76; }
  else if (at < fields.length) { const el = els.find((x) => x.dataset.fid === fields[at]?.id) ?? els[0]; const r = el.getBoundingClientRect(); top = r.top - 9; left = r.left; width = r.width; }
  else { const r = els[els.length - 1].getBoundingClientRect(); top = r.bottom + 9; left = r.left; width = r.width; }
  return <i className="mf-dropline" style={{ top: top - box.top + host.current.scrollTop, left: left - box.left, width }} />;
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`mf-tog ${on ? "is-on" : ""}`} onClick={() => onChange(!on)}>
      <span><b>{label}</b>{hint && <em>{hint}</em>}</span><i><i /></i>
    </button>
  );
}

function FieldInspector({ q, all, ct, co, onPatch, onType }: { q: FormField; all: FormField[]; ct: CustomDef[]; co: CustomDef[]; onPatch: (p: Partial<FormField>) => void; onType: (t: FieldType) => void }) {
  const k = KIND[q.type];
  const layout = isLayout(q.type);
  const textish = ["short_text", "long_text", "email", "phone", "number", "url", "dropdown", "country"].includes(q.type);
  const mapOpts = mapOptions(ct, co).filter((o) => !o.value || o.value === q.map || !all.some((x) => x.id !== q.id && x.map === o.value && o.value !== "contact.opt_in"));
  const swaps = FIELD_KINDS.filter((x) => x.group === k.group || (hasOptions(q.type) && hasOptions(x.type)));
  const [bulk, setBulk] = useState(false);
  return (
    <div className="mf-in">
      <div className="mf-in-head"><i>{k.icon}</i><div><b>{k.label}</b><em>{k.hint}</em></div></div>
      {swaps.length > 1 && (
        <div className="mf-f"><span>Type</span>
          <SalesMultiFilter single values={[q.type]} onChange={(v) => v[0] && onType(v[0] as FieldType)} placeholder="Type" searchFrom={99} options={swaps.map((x) => ({ value: x.type, label: x.label }))} />
        </div>
      )}
      <label className="mf-f"><span>{layout ? (q.type === "heading" ? "Title" : "Text") : q.type === "consent" ? "What they agree to" : "Question"}</span>
        <textarea rows={q.type === "text_block" || q.type === "consent" ? 3 : 2} value={q.label} onChange={(e) => onPatch({ label: e.target.value })} placeholder={layout ? "" : "Ask something…"} autoFocus={!q.label} />
      </label>
      {!layout && q.type !== "hidden" && <label className="mf-f"><span>Help text <em>optional</em></span><input value={q.help ?? ""} onChange={(e) => onPatch({ help: e.target.value })} placeholder="A short hint under the question" /></label>}
      {textish && q.type !== "country" && q.type !== "dropdown" && <label className="mf-f"><span>Placeholder <em>optional</em></span><input value={q.placeholder ?? ""} onChange={(e) => onPatch({ placeholder: e.target.value })} placeholder="Shown inside the empty box" /></label>}
      {q.type === "hidden" && <label className="mf-f"><span>Read from the link</span><input value={q.param ?? ""} onChange={(e) => onPatch({ param: e.target.value.replace(/[^\w-]/g, "") })} placeholder="utm_source" /><small>…/f/link<b>?{q.param || "utm_source"}=linkedin</b> saves “linkedin”.</small></label>}

      {hasOptions(q.type) && (
        <div className="mf-f"><span>Options <button type="button" className="mf-lnk" onClick={() => setBulk((b) => !b)}>{bulk ? "One by one" : "Paste a list"}</button></span>
          {bulk ? (
            <textarea rows={6} value={(q.options ?? []).join("\n")} onChange={(e) => onPatch({ options: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} placeholder="One option per line" />
          ) : (
            <div className="mf-opts">
              {(q.options ?? []).map((o, i) => (
                <div key={i} className="mf-opt">
                  <i className={q.type === "multi" ? "is-box" : "is-dot"} />
                  <input value={o} onChange={(e) => { const n = [...(q.options ?? [])]; n[i] = e.target.value; onPatch({ options: n }); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const n = [...(q.options ?? [])]; n.splice(i + 1, 0, ""); onPatch({ options: n }); window.setTimeout(() => (e.currentTarget.closest(".mf-opts")?.querySelectorAll("input")[i + 1] as HTMLInputElement | undefined)?.focus(), 20); } }} />
                  <button type="button" onClick={() => onPatch({ options: (q.options ?? []).filter((_, j) => j !== i) })} aria-label="Remove option">{Ico.x}</button>
                </div>
              ))}
              <button type="button" className="mf-opt-add" onClick={() => onPatch({ options: [...(q.options ?? []), `Option ${(q.options?.length ?? 0) + 1}`] })}>{Ico.plus}Add option</button>
            </div>
          )}
        </div>
      )}
      {q.type === "scale" && (
        <div className="mf-f"><span>From 1 to</span>
          <div className="mkx-seg is-sm is-fill">{[5, 7, 10].map((n) => <button key={n} className={(q.max || 5) === n ? "is-on" : ""} onClick={() => onPatch({ max: n })}>{n}</button>)}</div>
        </div>
      )}
      {(q.type === "scale" || q.type === "nps") && (
        <div className="mf-two">
          <label className="mf-f"><span>Low end</span><input value={q.minLabel ?? ""} onChange={(e) => onPatch({ minLabel: e.target.value })} placeholder="Not at all" /></label>
          <label className="mf-f"><span>High end</span><input value={q.maxLabel ?? ""} onChange={(e) => onPatch({ maxLabel: e.target.value })} placeholder="Very" /></label>
        </div>
      )}

      {!layout && (
        <div className="mf-in-sec">
          <h5>{Ico.crm}Save the answer to</h5>
          <SalesMultiFilter single values={[q.map ?? ""]} onChange={(v) => onPatch({ map: v[0] || null })} placeholder="Keep in the response only" searchFrom={8} options={mapOpts} />
          <small>{q.map === "contact.email" ? "This is how the person is found in your contacts — new e-mails create a contact."
            : q.map === "company.name" ? "Found by name (or website); a new name creates the company and links the person to it."
            : q.map === "contact.opt_in" ? "Ticked: the contact can receive your marketing e-mails. Not ticked on a new contact: kept out of them."
            : q.map ? "Filled in on the contact or company the answer belongs to." : "Every answer is always kept with the response, wherever else it goes."}</small>
        </div>
      )}
      {!layout && q.type !== "hidden" && (
        <div className="mf-in-sec">
          <Toggle on={!!q.required} onChange={(v) => onPatch({ required: v })} label="Must be answered" />
          {!["consent", "single", "multi", "nps", "scale", "rating", "long_text"].includes(q.type) && <Toggle on={!!q.half} onChange={(v) => onPatch({ half: v })} label="Half width" hint="Two of these sit side by side" />}
        </div>
      )}
    </div>
  );
}

function LookInspector({ f, setSettings, n }: { f: MkForm; setSettings: (p: Partial<FormSettings>) => void; n: number }) {
  const s = f.settings;
  return (
    <div className="mf-in">
      <div className="mf-in-head is-form"><i>{Ico.form}</i><div><b>The form</b><em>{n ? "Click a question in the preview to change it" : "Add your first question from the left"}</em></div></div>
      <label className="mf-f"><span>Title</span><input value={s.title ?? ""} onChange={(e) => setSettings({ title: e.target.value })} placeholder={f.name} /></label>
      <label className="mf-f"><span>Introduction <em>optional</em></span><textarea rows={3} value={s.intro ?? ""} onChange={(e) => setSettings({ intro: e.target.value })} placeholder="What it's for, how long it takes…" /></label>
      <label className="mf-f"><span>Button</span><input value={s.button ?? ""} onChange={(e) => setSettings({ button: e.target.value })} placeholder="Send" /></label>
      <div className="mf-f"><span>Colour</span>
        <div className="mf-swatches">
          {ACCENTS.map((c) => <button key={c} type="button" className={(s.accent || ACCENTS[0]) === c ? "is-on" : ""} style={{ background: c }} onClick={() => setSettings({ accent: c })} aria-label={c} />)}
          <label className="mf-hex"><span style={{ background: s.accent || ACCENTS[0] }} /><input value={s.accent ?? ""} onChange={(e) => { const v = e.target.value.trim(); setSettings({ accent: v }); }} placeholder="#0f8a5f" maxLength={7} /></label>
        </div>
      </div>
      <label className="mf-f"><span>Header image <em>optional</em></span><input value={s.cover ?? ""} onChange={(e) => setSettings({ cover: e.target.value })} placeholder="https://… (a wide picture)" /></label>
    </div>
  );
}

/* ---------------- Actions: what an answer does ---------------- */
type Person = { id: string; name: string };
const TOKENS = ["{company}", "{name}", "{form}", "{email}"];
const DUE: [number, string][] = [[0, "Same day"], [1, "Next day"], [2, "In 2 days"], [7, "In a week"]];

function ActSwitch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`mfa-sw ${on ? "is-on" : ""}`} onClick={() => onChange(!on)}><i /></button>;
}
function ActCard({ ico, tone, title, sub, on, onToggle, children, n, keep = false }: {
  ico: ReactNode; tone: string; title: string; sub: string; on?: boolean; onToggle?: (v: boolean) => void; children?: ReactNode; n: number;
  /** the body stays when switched off (its options still apply) */
  keep?: boolean;
}) {
  const off = on === false;
  return (
    <section className={`mfa-card is-${tone} ${off ? "is-off" : ""}`} style={{ ["--i" as string]: n } as React.CSSProperties}>
      <header onClick={onToggle ? () => onToggle(!on) : undefined} className={onToggle ? "is-click" : ""}>
        <span className="mfa-ico">{ico}</span>
        <span className="mfa-t"><b>{title}</b><em>{sub}</em></span>
        {onToggle && <span onClick={(e) => e.stopPropagation()}><ActSwitch on={!!on} onChange={onToggle} label={title} /></span>}
      </header>
      {(!off || keep) && children && <div className="mfa-body">{children}</div>}
    </section>
  );
}
/** A text with {tokens}: click a token to add it where the caret is. */
function TokenInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const put = (t: string) => {
    const el = ref.current; const v = value || "";
    const at = el?.selectionStart ?? v.length, to = el?.selectionEnd ?? v.length;
    const nv = v.slice(0, at) + t + v.slice(to); onChange(nv);
    window.setTimeout(() => { el?.focus(); el?.setSelectionRange(at + t.length, at + t.length); }, 0);
  };
  return (
    <div className="mfa-tok">
      <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <span>{TOKENS.map((t) => <button key={t} type="button" onClick={() => put(t)} title={`Add ${t}`}>{t}</button>)}</span>
    </div>
  );
}

function FormActions({ f, setSettings, setF, lists, toast, onListsChanged, onCampaign }: {
  f: MkForm; setSettings: (p: Partial<FormSettings>) => void; setF: (u: (x: MkForm) => MkForm) => void; lists: FormsListRef[]; toast: (s: string) => void;
  onListsChanged?: () => Promise<void> | void; onCampaign?: (listId: string) => void;
}) {
  const s = f.settings;
  const a: FormActionsCfg = s.actions ?? {};
  const setA = <K extends keyof FormActionsCfg>(k: K, p: Partial<NonNullable<FormActionsCfg[K]>>) => setSettings({ actions: { ...a, [k]: { ...(a[k] ?? {}), ...p } } });
  const [people, setPeople] = useState<Person[]>([]);
  const [types, setTypes] = useState<string[] | null>(null);
  const [making, setMaking] = useState(false);
  useEffect(() => {
    supabase.from("profiles").select("id, first_name, last_name, email").then(({ data }: any) => setPeople(((data ?? []) as any[])
      .map((p) => ({ id: p.id as string, name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || (p.email as string) || "Someone" }))
      .sort((x, y) => x.name.localeCompare(y.name))), () => undefined);
    supabase.from("crm_options").select("label").eq("kind", "relationship").order("sort").then(({ data, error }: any) => setTypes(error ? [] : ((data ?? []) as any[]).map((x) => String(x.label))), () => setTypes([]));
  }, []);
  const hasEmail = f.fields.some((x) => x.map === "contact.email");
  const hasCompanyQ = f.fields.some((x) => x.map === "company.name" || x.map === "company.website");
  const addCompanyQ = () => {
    setF((x) => ({ ...x, fields: [...x.fields, { ...makeField("short_text"), label: "Company", map: "company.name", required: false }] }));
    toast("A “Company” question was added at the end of the form");
  };
  const fixed = lists.filter((l) => l.kind === "static" && l.entity === "contacts");
  const list = lists.find((l) => l.id === s.list_id) ?? null;
  const newAudience = async () => {
    setMaking(true);
    const def = { groups: [{ id: newId(), match: "all", conds: [] }], groupsMatch: "any", dealScope: "direct", who: "all" };
    const { data, error } = await supabase.from("marketing_lists").insert({ name: `${f.name} — answers`, description: `Everyone who sends the form “${f.name}”`, entity: "contacts", kind: "static", definition: def, member_count: 0 }).select("id").single();
    if (error || !data) { setMaking(false); toast(error?.message ?? "Couldn't make the list"); return; }
    const id = (data as any).id as string;
    // the people who already answered come in too
    const { data: rs } = await supabase.from("mk_form_responses").select("contact_id").eq("form_id", f.id).not("contact_id", "is", null).limit(5000);
    const ids = [...new Set(((rs ?? []) as any[]).map((r) => r.contact_id as string))];
    for (let i = 0; i < ids.length; i += 500) await supabase.from("marketing_list_members").insert(ids.slice(i, i + 500).map((cid) => ({ list_id: id, contact_id: cid })));
    if (ids.length) await supabase.from("marketing_lists").update({ member_count: ids.length }).eq("id", id);
    setSettings({ list_id: id });
    await onListsChanged?.();
    setMaking(false);
    toast(ids.length ? `New audience with the ${ids.length} people who already answered` : "New audience — everyone who answers goes into it");
  };
  const task = a.task ?? {}, ctype = a.company_type ?? {};
  const who = (id?: string | null) => people.find((p) => p.id === id)?.name;
  const steps: string[] = [
    `${s.create === false ? "Updates the contact" : "Finds or creates the contact"}${hasEmail ? " by e-mail" : ""}${(s.mode ?? "fill") === "overwrite" ? " — the answers replace what's there" : " — only empty fields are filled"}`,
    ...(a.company?.on !== false && hasCompanyQ ? [`${s.create === false ? "Updates" : "Finds or creates"} the company and links the person to it`] : []),
    ...(ctype.on && ctype.values?.length ? [`Marks the company as ${ctype.values.join(", ")}`] : []),
    ...(task.on && task.assignee_id ? [`Gives ${who(task.assignee_id) ?? "someone"} a task, due ${DUE.find(([d]) => d === (task.due_days ?? 1))?.[1].toLowerCase() ?? `in ${task.due_days} days`}`] : []),
    ...(list ? [`Adds the person to “${list.name}”`] : []),
    s.redirect ? "Sends them to your page" : "Shows your thank-you message",
  ];
  let n = 0;
  return (
    <div className="mkx-scroll">
      <div className="mfa">
        <div className="mfa-flow">
          <div className="mfa-start"><span>{Ico.bolt}</span><b>When someone sends “{f.name}”</b><em>…each answer does this, in this order</em></div>

          <ActCard n={n++} ico={Ico.user} tone="green" title="The contact" sub={hasEmail ? "Found by the e-mail they type" : "Found by the e-mail the link carries"}
            on={s.create !== false} onToggle={(v) => setSettings({ create: v })} keep>
            {!hasEmail && <div className="mf-warn">No question saves to <b>Contact · E-mail</b>, so answers only find people who opened the form from one of your e-mails.</div>}
            <div className="mfa-f"><span>New people</span><em>Create a contact for anyone who isn't in your CRM yet. Off: only people already there are updated.</em></div>
            <div className="mfa-f"><span>When the contact already has a value</span>
              <div className="mfa-seg">
                <button type="button" className={(s.mode ?? "fill") === "fill" ? "is-on" : ""} onClick={() => setSettings({ mode: "fill" })}>Keep it — fill only empty fields</button>
                <button type="button" className={s.mode === "overwrite" ? "is-on" : ""} onClick={() => setSettings({ mode: "overwrite" })}>Replace it with the answer</button>
              </div>
            </div>
          </ActCard>

          <ActCard n={n++} ico={Ico.building} tone="blue" title="The company" sub={hasCompanyQ ? "Found by name or website — the person is linked to it" : "Needs a Company or Website question"}
            on={a.company?.on !== false} onToggle={(v) => setA("company", { on: v })}>
            {hasCompanyQ ? <div className="mfa-f"><em>{s.create === false ? "Only companies already in your CRM are updated." : "A new name creates the company (source: “Form: " + f.name + "”)."}</em></div>
              : <div className="mfa-row"><em>Add a question that asks for the company and its answers fill it in.</em><button type="button" className="mfa-btn" onClick={addCompanyQ}>{Ico.plus}Add a Company question</button></div>}
          </ActCard>

          <ActCard n={n++} ico={Ico.tag} tone="amber" title="Mark the company as…" sub="Adds types to “What it is to you” — e.g. Lead, Event 2026"
            on={!!ctype.on} onToggle={(v) => setA("company_type", { on: v })}>
            {types == null ? <span className="mf-spin is-sm" /> : types.length ? (
              <div className="mfa-chips">
                {types.map((t) => {
                  const on = (ctype.values ?? []).includes(t);
                  return <button key={t} type="button" className={on ? "is-on" : ""} aria-pressed={on} onClick={() => setA("company_type", { values: on ? (ctype.values ?? []).filter((x) => x !== t) : [...(ctype.values ?? []), t] })}>{on && Ico.check}{t}</button>;
                })}
              </div>
            ) : <em className="mfa-note">You have no company types yet — add them in Settings › Companies.</em>}
          </ActCard>

          <ActCard n={n++} ico={Ico.task} tone="teal" title="Give someone a task" sub="On their To-do"
            on={!!task.on} onToggle={(v) => setA("task", { on: v })}>
            <div className="mfa-grid">
              <div className="mfa-f"><span>Who</span>
                <SalesMultiFilter single values={task.assignee_id ? [task.assignee_id] : []} placeholder="Choose someone" searchFrom={8}
                  options={people.map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => setA("task", { assignee_id: v[0] || null })} />
              </div>
              <div className="mfa-f"><span>Due</span>
                <div className="mfa-seg is-sm">{DUE.map(([d, l]) => <button key={d} type="button" className={(task.due_days ?? 1) === d ? "is-on" : ""} onClick={() => setA("task", { due_days: d })}>{l}</button>)}</div>
              </div>
              <div className="mfa-f is-wide"><span>Task</span>
                <TokenInput value={task.title ?? ""} onChange={(v) => setA("task", { title: v })} placeholder="Follow up {name} ({form})" />
              </div>
            </div>
          </ActCard>

          <ActCard n={n++} ico={Ico.list} tone="slate" title="Add to an audience" sub="A fixed list in Audiences — ready for a follow-up e-mail"
            on={!!s.list_id} onToggle={(v) => { if (!v) setSettings({ list_id: null }); else if (fixed[0]) setSettings({ list_id: fixed[0].id }); else void newAudience(); }}>
            <div className="mfa-row">
              <div className="mfa-f is-grow">
                <SalesMultiFilter single values={s.list_id ? [s.list_id] : []} placeholder="Choose a list" searchFrom={8}
                  options={fixed.map((l) => ({ value: l.id, label: l.name }))} onChange={(v) => setSettings({ list_id: v[0] || null })} />
              </div>
              <button type="button" className="mfa-btn" onClick={() => void newAudience()} disabled={making}>{making ? <span className="mf-spin is-sm" /> : Ico.plus}New audience for this form</button>
            </div>
          </ActCard>

          <ActCard n={n++} ico={Ico.mail} tone="green" title="Follow up by e-mail" sub={list ? `Write a campaign to “${list.name}”` : "Add the answers to an audience first"}>
            <div className="mfa-row">
              <em>{list ? "Opens a new campaign with this audience picked — send it now or schedule it." : "Then you can send everyone who answered one e-mail, and see who opens it."}</em>
              <button type="button" className="mfa-btn is-primary" disabled={!list || !onCampaign} onClick={() => list && onCampaign?.(list.id)}>{Ico.mail}Write the campaign</button>
            </div>
          </ActCard>

          <ActCard n={n++} ico={Ico.check} tone="lime" title="After sending" sub="What the person sees once they press the button">
            <div className="mfa-grid">
              <label className="mfa-f is-wide"><span>Thank-you message</span><textarea rows={2} value={s.thanks ?? ""} onChange={(e) => setSettings({ thanks: e.target.value })} placeholder="Thank you — we got your answers." /></label>
              <label className="mfa-f is-wide"><span>Or go to a page <em>optional</em></span><input value={s.redirect ?? ""} onChange={(e) => setSettings({ redirect: e.target.value })} placeholder="https://www.yoursite.com/thanks" /></label>
            </div>
          </ActCard>
        </div>

        <aside className="mfa-sum">
          <h4>Each answer will</h4>
          <ol>{steps.map((t, i) => <li key={i} style={{ ["--i" as string]: i } as React.CSSProperties}><i>{i + 1}</i><span>{t}</span></li>)}</ol>
          <p>Every answer is kept with the form too, under Answers — whatever else it does.</p>
        </aside>
      </div>
    </div>
  );
}

/* ---------------- Share ---------------- */
function Share({ f, toast, onEmail, onPublish }: { f: MkForm; toast: (s: string) => void; onEmail: () => void; onPublish: () => void }) {
  const url = formUrl(f.token);
  const embed = `<iframe src="${url}" width="100%" height="900" style="border:0;max-width:720px" title="${(f.settings.title || f.name).replace(/"/g, "")}"></iframe>`;
  const block = emailBlock(f);
  const copy = async (t: string, what: string) => { try { await navigator.clipboard.writeText(t); toast(`${what} copied`); } catch { toast("Couldn't copy — select it and copy by hand"); } };
  const copyRich = async () => {
    const html = block.replace(/\{\{email\}\}/g, "");
    try {
      await (navigator.clipboard as any).write([new (window as any).ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([url], { type: "text/plain" }) })]);
      toast("Copied — paste it into an Outlook e-mail");
    } catch {
      const d = document.createElement("div"); d.innerHTML = html; d.style.position = "fixed"; d.style.left = "-9999px"; document.body.appendChild(d);
      const r = document.createRange(); r.selectNodeContents(d); const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
      document.execCommand("copy"); sel?.removeAllRanges(); d.remove(); toast("Copied — paste it into an Outlook e-mail");
    }
  };
  const live = f.status === "live";
  return (
    <div className="mkx-scroll">
      <div className="mf-share">
        {!live && (
          <div className="mf-banner">
            <div><b>{f.status === "closed" ? "This form is closed" : "This form is a draft"}</b><p>{f.status === "closed" ? "Its link shows that it no longer takes answers." : "Nobody can open the link until you publish it."}</p></div>
            <button className="mkx-btn is-primary" onClick={onPublish}>{f.status === "closed" ? "Open it again" : "Publish now"}</button>
          </div>
        )}
        <section className="mf-sh-card is-link">
          <header><span className="mf-set-ico is-green">{Ico.link}</span><div><h3>The link</h3><p>Anyone with it can fill in the form — no sign-in.</p></div></header>
          <div className="mf-url"><code>{url}</code><button className="mkx-btn" onClick={() => void copy(url, "Link")}>{Ico.copy}Copy</button><a className="mkx-btn" href={url} target="_blank" rel="noreferrer">{Ico.ext}Open</a></div>
          <p className="mf-fine">Add <code>?utm_source=linkedin</code> (or any name a hidden question reads) to know where people came from.</p>
        </section>
        <section className="mf-sh-card is-mail">
          <header><span className="mf-set-ico is-blue">{Ico.mail}</span><div><h3>In an e-mail</h3><p>Outlook can't hold form fields, so the first one-pick question comes as one-click answers — each opens the form with it already picked, signed with the person's e-mail.</p></div></header>
          <div className="mf-mailprev"><div className="mf-mailprev-in" dangerouslySetInnerHTML={{ __html: block.replace(/href="[^"]*"/g, 'href="#" onclick="return false"') }} translate="no" /></div>
          <div className="mf-sh-acts">
            <button className="mkx-btn is-primary" onClick={onEmail}>{Ico.mail}Write a campaign with it</button>
            <button className="mkx-btn" onClick={() => void copyRich()}>{Ico.copy}Copy for Outlook</button>
          </div>
        </section>
        <section className="mf-sh-card is-embed">
          <header><span className="mf-set-ico is-violet">{Ico.code}</span><div><h3>On your website</h3><p>Paste this where the form should appear.</p></div></header>
          <pre className="mf-code">{embed}</pre>
          <div className="mf-sh-acts"><button className="mkx-btn" onClick={() => void copy(embed, "Code")}>{Ico.copy}Copy code</button></div>
        </section>
      </div>
    </div>
  );
}

/* ---------------- Answers ---------------- */
const META_HIDE = new Set(["e", "deal_id", "task_id", "errors"]);
function Responses({ f, ct, co }: { f: MkForm; ct: CustomDef[]; co: CustomDef[] }) {
  const [rows, setRows] = useState<MkFormResponse[] | null>(null);
  const [who, setWho] = useState<Record<string, { name: string; email: string | null }>>({});
  const [cos, setCos] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<MkFormResponse | null>(null);
  const [mode, setMode] = useState<"summary" | "table">("summary");
  const navigate = useNavigate();
  useEffect(() => {
    let alive = true;
    (async () => {
      const all: MkFormResponse[] = [];
      for (let from = 0; from < 20000; from += 1000) {
        const { data, error } = await supabase.from("mk_form_responses").select("*").eq("form_id", f.id).order("created_at", { ascending: false }).range(from, from + 999);
        if (error || !data?.length) break;
        all.push(...(data as MkFormResponse[]));
        if (data.length < 1000) break;
      }
      if (!alive) return;
      setRows(all);
      const cids = [...new Set(all.map((r) => r.contact_id).filter(Boolean))] as string[];
      const coids = [...new Set(all.map((r) => r.company_id).filter(Boolean))] as string[];
      const people: Record<string, { name: string; email: string | null }> = {};
      for (let i = 0; i < cids.length; i += 300) {
        const { data } = await supabase.from("contacts").select("id, first_name, last_name, email").in("id", cids.slice(i, i + 300));
        (data ?? []).forEach((c: any) => { people[c.id] = { name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(), email: c.email }; });
      }
      const comp: Record<string, string> = {};
      for (let i = 0; i < coids.length; i += 300) {
        const { data } = await supabase.from("companies").select("id, name").in("id", coids.slice(i, i + 300));
        (data ?? []).forEach((c: any) => { comp[c.id] = c.name; });
      }
      if (alive) { setWho(people); setCos(comp); }
    })();
    return () => { alive = false; };
  }, [f.id]);
  const qs = f.fields.filter((x) => !isLayout(x.type));
  const exportCsv = () => {
    if (!rows) return;
    const head = ["Sent", "Contact", "E-mail", "Company", "Came from", ...qs.map((q) => q.label || KIND[q.type].label)];
    const lines = rows.map((r) => [new Date(r.created_at).toLocaleString("en-GB"), r.contact_id ? who[r.contact_id]?.name ?? "" : "", r.email ?? "", r.company_id ? cos[r.company_id] ?? "" : "", r.source, ...qs.map((q) => answerText(q, r.answers?.[q.id]))]);
    const csv = [head, ...lines].map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" })); a.download = `${f.name.replace(/[^\w\- ]+/g, "")} — answers.csv`; a.click();
  };
  if (rows == null) return <div className="mkx-scroll"><div className="mf-loading"><span className="mf-spin" /></div></div>;
  if (!rows.length) return (
    <div className="mkx-scroll"><div className="mf-hero is-sm">
      <div className="mf-hero-art" aria-hidden="true"><span>{Ico.check}</span><i /><i /><i /></div>
      <h2>No answers yet</h2><p>{f.status === "live" ? "Share the link (or send it in an e-mail) — answers show up here as they come in, and on each contact." : "Publish the form, then share its link. Answers show up here as they come in."}</p>
    </div></div>
  );
  const week = rows.filter((r) => Date.now() - new Date(r.created_at).getTime() < 7 * 864e5).length;
  const known = rows.filter((r) => r.contact_id).length;
  const fromMail = rows.filter((r) => r.source === "email").length;
  return (
    <div className="mf-resp">
      <div className="mf-resp-kpis">
        <div><em>Answers</em><b>{rows.length.toLocaleString()}</b><small>{week} this week</small></div>
        <div><em>Saved on a contact</em><b>{Math.round((known / rows.length) * 100)}%</b><small>{known.toLocaleString()} people</small></div>
        <div><em>From your e-mails</em><b>{fromMail.toLocaleString()}</b><small>{rows.length - fromMail} from the link</small></div>
        <div><em>Last answer</em><b className="is-sm">{fmtAgo(rows[0].created_at)}</b><small>{fmtDay(rows[0].created_at)}</small></div>
        <span className="mkx-grow" />
        <div className="mkx-seg is-sm"><button className={mode === "summary" ? "is-on" : ""} onClick={() => setMode("summary")}>Summary</button><button className={mode === "table" ? "is-on" : ""} onClick={() => setMode("table")}>Each answer</button></div>
        <button className="mkx-btn" onClick={exportCsv}>{Ico.dl}Export</button>
      </div>
      <div className="mkx-scroll">
        {mode === "summary" ? (
          <div className="mf-sum">
            {qs.map((q) => <QSummary key={q.id} q={q} rows={rows} ct={ct} co={co} />)}
          </div>
        ) : (
          <div className="mf-table" style={{ ["--cols" as string]: Math.min(qs.length, 6) } as React.CSSProperties}>
            <div className="mf-tr is-head"><span>Sent</span><span>Who</span>{qs.slice(0, 6).map((q) => <span key={q.id} title={q.label}>{q.label || KIND[q.type].label}</span>)}</div>
            {rows.map((r) => (
              <button key={r.id} className={`mf-tr ${open?.id === r.id ? "is-on" : ""}`} onClick={() => setOpen(r)}>
                <span className="mf-td-when">{new Date(r.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                <span className="mf-td-who"><b>{r.contact_id ? who[r.contact_id]?.name || r.email || "Contact" : r.email || "Anonymous"}</b><em>{r.company_id ? cos[r.company_id] : r.source === "email" ? "From an e-mail" : ""}</em></span>
                {qs.slice(0, 6).map((q) => <span key={q.id} className="mf-td">{answerText(q, r.answers?.[q.id]) || <i>—</i>}</span>)}
              </button>
            ))}
          </div>
        )}
      </div>
      {open && (
        <aside className="mf-drawer" role="dialog" aria-label="Answer">
          <header>
            <div><b>{open.contact_id ? who[open.contact_id]?.name || open.email : open.email || "Anonymous"}</b><em>{new Date(open.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · {open.source === "email" ? "from an e-mail" : "from the link"}</em></div>
            <button className="mf-x" onClick={() => setOpen(null)} aria-label="Close">{Ico.x}</button>
          </header>
          <div className="mf-drawer-body">
            {(open.contact_id || open.company_id || open.meta?.task_id) && (
              <div className="mf-drawer-crm">
                {open.contact_id && <button className="mkx-btn" onClick={() => navigate("/contacts", { state: { focusContactId: open.contact_id } })}>{Ico.crm}Open contact</button>}
                {open.company_id && <button className="mkx-btn" onClick={() => navigate("/companies", { state: { focusCompanyId: open.company_id } })}>{Ico.building}{cos[open.company_id] ?? "Company"}</button>}
                {open.meta?.task_id && <span className="mf-drawer-done">{Ico.task}Task created</span>}
              </div>
            )}
            {qs.map((q) => (
              <div key={q.id} className="mf-ans"><em>{q.label || KIND[q.type].label}{q.map && <small>→ {mapLabel(q.map, ct, co)}</small>}</em><b translate="no">{answerText(q, open.answers?.[q.id]) || <i>No answer</i>}</b></div>
            ))}
            {Object.keys(open.meta ?? {}).filter((k) => !META_HIDE.has(k)).length > 0 && (
              <div className="mf-ans is-meta"><em>Where it came from</em>{Object.entries(open.meta).filter(([k]) => !META_HIDE.has(k)).map(([k, v]) => <span key={k}><b>{k}</b> {String(v)}</span>)}</div>
            )}
            {open.meta?.errors && (
              <div className="mf-ans is-meta is-err"><em>Something it couldn't do</em>{Object.entries(open.meta.errors as Record<string, string>).map(([k, v]) => <span key={k}><b>{k}</b> {String(v)}</span>)}</div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function QSummary({ q, rows, ct, co }: { q: FormField; rows: MkFormResponse[]; ct: CustomDef[]; co: CustomDef[] }) {
  const vals = rows.map((r) => r.answers?.[q.id]).filter((v) => v != null && v !== "" && !(Array.isArray(v) && !v.length));
  const n = vals.length;
  let body: ReactNode;
  if (q.type === "single" || q.type === "multi" || q.type === "dropdown" || q.type === "yes_no" || q.type === "country" || q.type === "consent") {
    const cnt = new Map<string, number>();
    vals.forEach((v) => (Array.isArray(v) ? v : [v]).forEach((x: any) => { const k = answerText(q, x); cnt.set(k, (cnt.get(k) ?? 0) + 1); }));
    const order = (q.options?.length ? [...q.options, ...[...cnt.keys()].filter((k) => !q.options!.includes(k))] : [...cnt.keys()].sort((a, b) => (cnt.get(b) ?? 0) - (cnt.get(a) ?? 0))).slice(0, 12);
    const max = Math.max(1, ...cnt.values());
    body = <div className="mf-bars">{order.map((k) => { const c = cnt.get(k) ?? 0; return <div key={k} className="mf-bar"><span>{k}</span><i><i style={{ width: `${(c / max) * 100}%` }} /></i><b>{c}</b><em>{n ? Math.round((c / n) * 100) : 0}%</em></div>; })}</div>;
  } else if (q.type === "rating" || q.type === "scale" || q.type === "nps" || q.type === "number") {
    const nums = vals.map(Number).filter(Number.isFinite);
    const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    if (q.type === "nps") {
      const pro = nums.filter((x) => x >= 9).length, det = nums.filter((x) => x <= 6).length, pas = nums.length - pro - det;
      const score = nums.length ? Math.round(((pro - det) / nums.length) * 100) : 0;
      body = (
        <div className="mf-nps">
          <div className="mf-big"><b className={score >= 30 ? "is-good" : score < 0 ? "is-bad" : ""}>{score > 0 ? "+" : ""}{score}</b><em>NPS</em></div>
          <div className="mf-nps-bar"><i className="is-det" style={{ flex: det }} /><i className="is-pas" style={{ flex: pas }} /><i className="is-pro" style={{ flex: pro }} /></div>
          <div className="mf-nps-l"><span><i className="is-det" />Detractors {det}</span><span><i className="is-pas" />Passives {pas}</span><span><i className="is-pro" />Promoters {pro}</span></div>
        </div>
      );
    } else {
      const top = q.type === "rating" ? 5 : q.type === "scale" ? q.max || 5 : 0;
      body = (
        <div className="mf-avg">
          <div className="mf-big"><b>{avg.toLocaleString("en-GB", { maximumFractionDigits: 1 })}</b><em>{top ? `average of ${top}` : "average"}</em></div>
          {top > 0 && <div className="mf-dist">{Array.from({ length: top }, (_, i) => i + 1).map((k) => { const c = nums.filter((x) => x === k).length; const mx = Math.max(1, ...Array.from({ length: top }, (_, j) => nums.filter((x) => x === j + 1).length)); return <span key={k}><i style={{ height: `${(c / mx) * 100}%` }} /><em>{q.type === "rating" ? `${k}★` : k}</em></span>; })}</div>}
        </div>
      );
    }
  } else {
    body = <ul className="mf-texts">{vals.slice(0, 4).map((v, i) => <li key={i} translate="no">{answerText(q, v)}</li>)}{n > 4 && <li className="is-more">+{n - 4} more — see “Each answer”</li>}</ul>;
  }
  return (
    <section className={`mf-qs is-${q.type}`}>
      <header><i>{KIND[q.type]?.icon}</i><div><b>{q.label || KIND[q.type].label}</b><em>{n} of {rows.length} answered{q.map ? ` · → ${mapLabel(q.map, ct, co)}` : ""}</em></div></header>
      {n ? body : <p className="mf-fine">Nobody answered this one yet.</p>}
    </section>
  );
}
