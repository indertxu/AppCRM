/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Marketing › Forms — what a form is, and how it looks to the person filling it in.
 *
 *  - the field types (short text … NPS, consent, hidden, headings)
 *  - <FormView>: the form itself — used by the public page (/f/<token>) and,
 *    live, by the builder's canvas (with questions you can select)
 *  - formUrl / emailBlock: the link, and the block that goes into an e-mail
 *    (Outlook can't hold real form fields, so the first choice question comes
 *    as one-click answers that open the form with it already picked)
 *
 * Kept free of the Marketing page so the public page loads only this.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { countryOptions } from "../contactProfile";
import "./FormView.css";

/* ══════════════════════════ the model ══════════════════════════ */
export type FieldType =
  | "short_text" | "long_text" | "email" | "phone" | "number" | "url" | "date"
  | "single" | "multi" | "dropdown" | "yes_no" | "country"
  | "rating" | "nps" | "scale"
  | "consent" | "hidden" | "heading" | "text_block";

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  /** where the answer is saved: contact.<column> | contact.custom.<id> | company.<column> | company.custom.<id> | contact.opt_in */
  map?: string | null;
  /** scale: 1…max; labels at both ends */
  max?: number; minLabel?: string; maxLabel?: string;
  /** hidden: the link parameter it takes its value from (utm_source…) */
  param?: string;
  /** half the width, next to another half */
  half?: boolean;
}
export interface FormSettings {
  title?: string; intro?: string; thanks?: string; button?: string; redirect?: string;
  accent?: string; cover?: string;
  /** fill: only empty CRM fields (default) · overwrite: the answer wins */
  mode?: "fill" | "overwrite";
  /** false: only people already in the CRM are updated */
  create?: boolean;
  list_id?: string | null;
}
export type FormStatus = "draft" | "live" | "closed";
export interface MkForm {
  id: string; name: string; token: string; status: FormStatus; fields: FormField[]; settings: FormSettings;
  response_count: number; last_response_at: string | null; created_at: string; updated_at: string; created_by?: string | null;
}
export interface MkFormResponse {
  id: string; form_id: string; answers: Record<string, any>; contact_id: string | null; company_id: string | null;
  email: string | null; source: string; meta: Record<string, any>; created_at: string;
}
export type Answer = string | string[] | number | boolean | null | undefined;

export const NEEDS_FORMS = "Forms need 135_mk_forms.sql in Supabase.";
export const formsMissing = (m: string) => /mk_forms|mk_form_|relation|schema cache|does not exist|function/i.test(m);
export const newId = () => Math.random().toString(36).slice(2, 9);
export const formUrl = (token: string) => `${typeof window !== "undefined" ? window.location.origin : ""}/f/${token}`;
export const ACCENTS = ["#0f8a5f", "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0891b2", "#111827"];
const DEFAULT_ACCENT = ACCENTS[0];

/* ══════════════════════════ the field types ══════════════════════════ */
type Group = "Contact details" | "Choices" | "Ratings" | "Other" | "Layout";
export interface FieldKind { type: FieldType; label: string; group: Group; hint: string; icon: ReactNode; make: () => Partial<FormField> }
const I = (d: ReactNode) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
export const FIELD_KINDS: FieldKind[] = [
  { type: "short_text", label: "Short answer", group: "Contact details", hint: "A name, a job title, a word or two", icon: I(<><path d="M4 7h16M4 12h10" /><path d="M17 15v4M15 17h4" /></>), make: () => ({ label: "Your answer", placeholder: "" }) },
  { type: "email", label: "E-mail", group: "Contact details", hint: "Checked, and how we find the contact", icon: I(<><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></>), make: () => ({ label: "E-mail", placeholder: "name@company.com", map: "contact.email", required: true }) },
  { type: "phone", label: "Phone", group: "Contact details", hint: "Any format", icon: I(<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />), make: () => ({ label: "Phone", placeholder: "+34 600 000 000", map: "contact.phone" }) },
  { type: "long_text", label: "Long answer", group: "Contact details", hint: "A few lines: a question, a comment", icon: I(<><path d="M4 6h16M4 10h16M4 14h16M4 18h9" /></>), make: () => ({ label: "Anything else you'd like to tell us?" }) },
  { type: "url", label: "Website", group: "Contact details", hint: "A link, checked", icon: I(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>), make: () => ({ label: "Company website", placeholder: "www.company.com", map: "company.website" }) },
  { type: "country", label: "Country", group: "Contact details", hint: "Picked from the list", icon: I(<><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></>), make: () => ({ label: "Country", map: "contact.country" }) },
  { type: "single", label: "One choice", group: "Choices", hint: "Pick one of a few options", icon: I(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.2" fill="currentColor" /></>), make: () => ({ label: "Which fits you best?", options: ["Option 1", "Option 2", "Option 3"] }) },
  { type: "multi", label: "Several choices", group: "Choices", hint: "Tick all that apply", icon: I(<><rect x="4" y="4" width="16" height="16" rx="4" /><path d="m8 12 3 3 5-6" /></>), make: () => ({ label: "What are you interested in?", options: ["Option 1", "Option 2", "Option 3"] }) },
  { type: "dropdown", label: "Dropdown", group: "Choices", hint: "A long list, one answer", icon: I(<><rect x="3" y="6" width="18" height="12" rx="3" /><path d="m14 11 2 2 2-2" /></>), make: () => ({ label: "Pick one", options: ["Option 1", "Option 2", "Option 3", "Option 4"] }) },
  { type: "yes_no", label: "Yes / No", group: "Choices", hint: "Two big buttons", icon: I(<><path d="m4 12 4 4 8-9" /><path d="M15 15l5 5M20 15l-5 5" /></>), make: () => ({ label: "Would you like a call from us?" }) },
  { type: "rating", label: "Stars", group: "Ratings", hint: "1 to 5 stars", icon: I(<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />), make: () => ({ label: "How would you rate it?" }) },
  { type: "nps", label: "NPS (0–10)", group: "Ratings", hint: "The classic NPS question", icon: I(<><rect x="3" y="8" width="18" height="8" rx="2" /><path d="M7 8v8M11 8v8M15 8v8" /></>), make: () => ({ label: "How likely are you to recommend us to a colleague?", minLabel: "Not likely", maxLabel: "Very likely" }) },
  { type: "scale", label: "Scale", group: "Ratings", hint: "1 to 5 (or 10), with words at the ends", icon: I(<><path d="M4 12h16" /><circle cx="8" cy="12" r="2" /><circle cx="16" cy="12" r="2" /></>), make: () => ({ label: "How easy was it?", max: 5, minLabel: "Hard", maxLabel: "Easy" }) },
  { type: "number", label: "Number", group: "Other", hint: "Only digits", icon: I(<><path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" /></>), make: () => ({ label: "How many people are in your team?" }) },
  { type: "date", label: "Date", group: "Other", hint: "A day from a calendar", icon: I(<><rect x="3" y="4.5" width="18" height="16" rx="3" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /></>), make: () => ({ label: "Preferred date" }) },
  { type: "consent", label: "Consent", group: "Other", hint: "A tick-box, e.g. to receive e-mails", icon: I(<><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></>), make: () => ({ label: "I'd like to receive news and invitations by e-mail.", map: "contact.opt_in" }) },
  { type: "hidden", label: "Hidden value", group: "Other", hint: "Taken from the link (utm_source, campaign…)", icon: I(<><path d="M3 3l18 18" /><path d="M10.6 6.1A10 10 0 0 1 21.5 12a14 14 0 0 1-3 3.6M6.1 6.1A14 14 0 0 0 2.5 12S6 18.5 12 18.5a9.6 9.6 0 0 0 4-.9" /></>), make: () => ({ label: "Source", param: "utm_source" }) },
  { type: "heading", label: "Section title", group: "Layout", hint: "Splits a long form in parts", icon: I(<><path d="M5 5v14M19 5v14M5 12h14" /></>), make: () => ({ label: "About your company" }) },
  { type: "text_block", label: "Paragraph", group: "Layout", hint: "A few words between questions", icon: I(<><path d="M5 7h14M5 11h14M5 15h9" /></>), make: () => ({ label: "We'll only use this to get back to you." }) },
];
export const KIND = Object.fromEntries(FIELD_KINDS.map((k) => [k.type, k])) as Record<FieldType, FieldKind>;
export const isLayout = (t: FieldType) => t === "heading" || t === "text_block";
export const hasOptions = (t: FieldType) => t === "single" || t === "multi" || t === "dropdown";
export function makeField(type: FieldType): FormField {
  return { id: newId(), type, label: "", required: false, ...KIND[type].make() } as FormField;
}

/* ══════════════════════════ ready-made forms ══════════════════════════ */
const F = (type: FieldType, x: Partial<FormField> = {}): FormField => ({ ...makeField(type), ...x });
export const FORM_TEMPLATES: { key: string; name: string; hint: string; tone: string; fields: () => FormField[]; settings: FormSettings }[] = [
  { key: "blank", name: "Blank form", hint: "Start from nothing", tone: "slate", fields: () => [], settings: {} },
  {
    key: "contact", name: "Contact us", hint: "Name, e-mail, company and a message", tone: "green",
    fields: () => [F("short_text", { label: "First name", map: "contact.first_name", required: true, half: true }), F("short_text", { label: "Surname", map: "contact.last_name", half: true }),
      F("email"), F("short_text", { label: "Company", map: "company.name", half: true }), F("short_text", { label: "Job title", map: "contact.position", half: true }),
      F("long_text", { label: "How can we help?", required: true }), F("consent")],
    settings: { title: "Get in touch", intro: "Tell us a little about you and we'll get back to you within one working day.", button: "Send", thanks: "Thanks — we'll be in touch very soon." },
  },
  {
    key: "event", name: "Event registration", hint: "Sign-ups for a webinar or event", tone: "blue",
    fields: () => [F("short_text", { label: "First name", map: "contact.first_name", required: true, half: true }), F("short_text", { label: "Surname", map: "contact.last_name", required: true, half: true }),
      F("email"), F("short_text", { label: "Company", map: "company.name", required: true, half: true }), F("short_text", { label: "Job title", map: "contact.position", half: true }),
      F("single", { label: "How will you join?", options: ["In person", "Online"], required: true }), F("multi", { label: "Topics you'd like us to cover", options: ["Month-end close", "Consolidation", "Reporting", "Budgeting"] }),
      F("consent"), F("hidden", { label: "Source", param: "utm_source" })],
    settings: { title: "Save your seat", intro: "One place, one hour — and the slides afterwards.", button: "Register", thanks: "You're in. We've saved your seat and will send the details by e-mail." },
  },
  {
    key: "newsletter", name: "Newsletter sign-up", hint: "Just an e-mail and consent", tone: "violet",
    fields: () => [F("email", { label: "Your e-mail" }), F("short_text", { label: "First name", map: "contact.first_name", half: true }), F("country", { half: true }), F("consent", { required: true })],
    settings: { title: "Stay in the loop", intro: "One e-mail a month. Useful things only.", button: "Subscribe", thanks: "You're subscribed. Welcome!" },
  },
  {
    key: "feedback", name: "Customer feedback", hint: "NPS, a rating and a comment", tone: "amber",
    fields: () => [F("nps"), F("rating", { label: "How happy are you with our support?" }), F("multi", { label: "What do you value most?", options: ["Speed", "Expertise", "Price", "Support"] }),
      F("long_text", { label: "What could we do better?" }), F("email", { required: false, label: "Your e-mail (optional)" })],
    settings: { title: "How are we doing?", intro: "Two minutes, five questions. It helps us a lot.", button: "Send feedback", thanks: "Thank you — every answer is read by the team." },
  },
  {
    key: "lead", name: "Lead qualification", hint: "Company size, needs, timing", tone: "rose",
    fields: () => [F("short_text", { label: "Full name", map: "contact.first_name", required: true, half: true }), F("email", { half: true }),
      F("heading", { label: "About your company" }), F("short_text", { label: "Company", map: "company.name", required: true, half: true }), F("url", { half: true }),
      F("dropdown", { label: "Company size", options: ["1–10", "11–50", "51–200", "201–1000", "1000+"], required: true, half: true }), F("country", { label: "Country", map: "company.country", half: true }),
      F("multi", { label: "What do you need help with?", options: ["Consolidation", "Reporting", "Budgeting", "ERP integration"] }),
      F("single", { label: "When would you like to start?", options: ["This quarter", "Next quarter", "Later this year", "Just exploring"] }), F("yes_no", { label: "Would you like a demo?" })],
    settings: { title: "Let's see if we're a fit", intro: "A few questions so the first call is useful from minute one.", button: "Send", thanks: "Thanks — someone from the team will reach out shortly." },
  },
];

/* ══════════════════════════ where answers go ══════════════════════════ */
export const CONTACT_COLS: [string, string][] = [
  ["first_name", "First name"], ["last_name", "Surname"], ["email", "E-mail"], ["phone", "Mobile"], ["landline", "Phone"], ["position", "Job title"],
  ["city", "City"], ["province", "Province"], ["country", "Country"], ["postal_code", "Postal code"], ["street", "Street"], ["linkedin", "LinkedIn"], ["language", "Language"], ["notes", "Notes (added)"],
];
export const COMPANY_COLS: [string, string][] = [
  ["name", "Company name"], ["legal_name", "Legal name"], ["website", "Website"], ["email", "E-mail"], ["phone", "Phone"], ["sector", "Sector"], ["vat_number", "VAT number"],
  ["city", "City"], ["province", "Province"], ["country", "Country"], ["postal_code", "Postal code"], ["street", "Street"], ["linkedin", "LinkedIn"],
];
export interface CustomDef { id: string; label: string }
export function mapOptions(ctFields: CustomDef[], coFields: CustomDef[]) {
  return [
    { value: "", label: "Keep in the response only", group: "Nowhere else" },
    ...CONTACT_COLS.map(([k, l]) => ({ value: `contact.${k}`, label: l, group: "Contact" })),
    { value: "contact.opt_in", label: "Agrees to marketing e-mails", group: "Contact" },
    ...ctFields.map((f) => ({ value: `contact.custom.${f.id}`, label: f.label, group: "Contact · custom fields" })),
    ...COMPANY_COLS.map(([k, l]) => ({ value: `company.${k}`, label: l, group: "Company" })),
    ...coFields.map((f) => ({ value: `company.custom.${f.id}`, label: f.label, group: "Company · custom fields" })),
  ];
}
export function mapLabel(map: string | null | undefined, ctFields: CustomDef[] = [], coFields: CustomDef[] = []) {
  if (!map) return null;
  const o = mapOptions(ctFields, coFields).find((x) => x.value === map);
  return o ? `${o.group.startsWith("Company") ? "Company" : "Contact"} · ${o.label}` : map;
}

/* ══════════════════════════ checking answers ══════════════════════════ */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const emptyAnswer = (v: Answer) => v == null || v === "" || (Array.isArray(v) && !v.length) || v === false;
export function checkAnswers(fields: FormField[], vals: Record<string, Answer>): Record<string, string> {
  const err: Record<string, string> = {};
  fields.forEach((f) => {
    if (isLayout(f.type) || f.type === "hidden") return;
    const v = vals[f.id];
    if (f.required && emptyAnswer(v)) { err[f.id] = f.type === "consent" ? "Please tick this to continue." : "Please answer this one."; return; }
    if (emptyAnswer(v)) return;
    if (f.type === "email" && !EMAIL_RE.test(String(v).trim())) err[f.id] = "That e-mail doesn't look right.";
    if (f.type === "url" && !/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(String(v).trim())) err[f.id] = "That doesn't look like a web address.";
    if (f.type === "number" && !Number.isFinite(Number(String(v).replace(",", ".")))) err[f.id] = "Only numbers here.";
  });
  return err;
}
/** what an answer reads as, for tables and summaries */
export function answerText(f: FormField | undefined, v: any): string {
  if (v == null || v === "") return "";
  if (Array.isArray(v)) return v.join(", ");
  if (f?.type === "consent") return v === true || v === "true" ? "Yes" : "No";
  if (f?.type === "yes_no") return v === true || v === "true" || v === "Yes" ? "Yes" : v === false || v === "false" || v === "No" ? "No" : String(v);
  if (f?.type === "rating") return `${v} ★`;
  if (f?.type === "country") return countryLabel(String(v));
  return String(v);
}
let COUNTRIES: { value: string; label: string }[] | null = null;
const countries = () => (COUNTRIES ??= countryOptions().map((c) => ({ value: c.value, label: c.label.split(" · ")[0] })).sort((a, b) => a.label.localeCompare(b.label)));
export const countryLabel = (code: string) => countries().find((c) => c.value === code)?.label ?? code;

/* ══════════════════════════ the form ══════════════════════════ */
export interface FormLike { name: string; fields: FormField[]; settings: FormSettings; company?: string | null }

/** The form as the person filling it in sees it. In the builder, questions can be selected. */
export function FormView({ form, values, onChange, errors = {}, onSubmit, busy, preview = false, selected, onSelect, renderTools, width }: {
  form: FormLike; values: Record<string, Answer>; onChange: (id: string, v: Answer) => void; errors?: Record<string, string>;
  onSubmit?: () => void; busy?: boolean; preview?: boolean; selected?: string | null; onSelect?: (id: string) => void;
  /** builder: the buttons on a selected question */
  renderTools?: (f: FormField, i: number) => ReactNode;
  width?: "mobile" | "desktop";
}) {
  const st = form.settings ?? {};
  const accent = st.accent || DEFAULT_ACCENT;
  const shown = form.fields.filter((f) => f.type !== "hidden" || preview);
  return (
    <div className={`fv ${preview ? "is-preview" : ""} ${width === "mobile" ? "is-mobile" : ""}`} style={{ ["--fv-accent" as string]: accent } as CSSProperties} translate="no">
      {st.cover && <div className="fv-cover" style={{ backgroundImage: `url("${st.cover.replace(/"/g, "")}")` }} />}
      <div className="fv-card">
        <header className="fv-head">
          {form.company && <span className="fv-org">{form.company}</span>}
          <h1>{st.title || form.name || "Untitled form"}</h1>
          {st.intro && <p>{st.intro}</p>}
        </header>
        <form className="fv-grid" noValidate onSubmit={(e) => { e.preventDefault(); if (!preview) onSubmit?.(); }}>
          {shown.map((f, i) => (
            <div key={f.id} data-fid={f.id}
              className={`fv-q is-${f.type} ${f.half && !isLayout(f.type) ? "is-half" : ""} ${errors[f.id] ? "has-err" : ""} ${preview ? "is-pick" : ""} ${selected === f.id ? "is-sel" : ""}`}
              onClickCapture={preview && onSelect ? (e) => { if (selected !== f.id) { e.preventDefault(); e.stopPropagation(); onSelect(f.id); } } : undefined}>
              <Question f={f} v={values[f.id]} onChange={(v) => onChange(f.id, v)} accent={accent} preview={preview} />
              {errors[f.id] && <span className="fv-err" role="alert">{errors[f.id]}</span>}
              {preview && selected === f.id && renderTools?.(f, i)}
            </div>
          ))}
          {preview && !shown.length && <div className="fv-empty">Add questions from the left — or drop them here.</div>}
          <div className="fv-foot">
            <button type="submit" className="fv-submit" disabled={busy}>{busy ? "Sending…" : st.button || "Send"}</button>
          </div>
        </form>
      </div>
      <p className="fv-small">{form.company ? `${form.company} · ` : ""}Your answers go only to {form.company || "the team that sent you this form"}.</p>
    </div>
  );
}

function Question({ f, v, onChange, accent, preview }: { f: FormField; v: Answer; onChange: (v: Answer) => void; accent: string; preview: boolean }) {
  const label = f.label || (preview ? <em className="fv-ph">Untitled question</em> : "");
  if (f.type === "heading") return <h2 className="fv-h2">{label}</h2>;
  if (f.type === "text_block") return <p className="fv-par">{label}</p>;
  if (f.type === "consent") {
    const on = v === true;
    return (
      <label className="fv-consent">
        <button type="button" role="checkbox" aria-checked={on} className={`fv-box ${on ? "is-on" : ""}`} onClick={() => onChange(!on)}>{on && <Tick />}</button>
        <span>{label}{f.required && <i className="fv-req">*</i>}{f.help && <small>{f.help}</small>}</span>
      </label>
    );
  }
  const head = (
    <span className="fv-label">
      <b>{label}{f.required && <i className="fv-req">*</i>}</b>
      {f.help && <small>{f.help}</small>}
      {f.type === "hidden" && preview && <small className="fv-hid">Hidden · from the link’s “{f.param || "…"}”</small>}
    </span>
  );
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  let body: ReactNode = null;
  switch (f.type) {
    case "short_text": case "email": case "phone": case "number": case "url":
      body = <input className="fv-in" type={f.type === "email" ? "email" : f.type === "phone" ? "tel" : f.type === "url" ? "url" : "text"} inputMode={f.type === "number" ? "decimal" : undefined}
        value={s} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder || (f.type === "email" ? "name@company.com" : "")} autoComplete={f.map === "contact.email" ? "email" : f.map === "contact.first_name" ? "given-name" : f.map === "contact.last_name" ? "family-name" : f.map === "company.name" ? "organization" : f.type === "phone" ? "tel" : "on"} />;
      break;
    case "long_text": body = <textarea className="fv-in is-area" value={s} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder || ""} rows={4} />; break;
    case "date": body = <input className="fv-in is-date" type="date" value={s} onChange={(e) => onChange(e.target.value)} />; break;
    case "hidden": body = <div className="fv-in is-hidden">{s || `?${f.param || "utm_source"}=…`}</div>; break;
    case "single": body = (
      <div className="fv-opts" role="radiogroup">
        {(f.options ?? []).map((o) => <button type="button" key={o} role="radio" aria-checked={s === o} className={`fv-opt ${s === o ? "is-on" : ""}`} onClick={() => onChange(s === o ? "" : o)}><i className="fv-dot" />{o}</button>)}
      </div>
    ); break;
    case "multi": {
      const arr = Array.isArray(v) ? v : [];
      body = (
        <div className="fv-opts">
          {(f.options ?? []).map((o) => { const on = arr.includes(o); return <button type="button" key={o} role="checkbox" aria-checked={on} className={`fv-opt is-multi ${on ? "is-on" : ""}`} onClick={() => onChange(on ? arr.filter((x) => x !== o) : [...arr, o])}><i className="fv-box">{on && <Tick />}</i>{o}</button>; })}
        </div>
      );
      break;
    }
    case "dropdown": body = <FvSelect value={s} onChange={onChange} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} placeholder={f.placeholder || "Choose…"} />; break;
    case "country": body = <FvSelect value={s} onChange={onChange} options={countries()} placeholder={f.placeholder || "Choose a country…"} search />; break;
    case "yes_no": body = (
      <div className="fv-yn">
        {["Yes", "No"].map((o) => <button type="button" key={o} className={`fv-ynb ${s === o ? "is-on" : ""} is-${o.toLowerCase()}`} onClick={() => onChange(s === o ? "" : o)}>{o === "Yes" ? <Tick /> : <Cross />}{o}</button>)}
      </div>
    ); break;
    case "rating": {
      const n = Number(v) || 0;
      body = (
        <div className="fv-stars" role="radiogroup">
          {[1, 2, 3, 4, 5].map((k) => <button type="button" key={k} role="radio" aria-checked={n === k} aria-label={`${k} of 5`} className={`fv-star ${k <= n ? "is-on" : ""}`} onClick={() => onChange(n === k ? null : k)}><svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></svg></button>)}
        </div>
      );
      break;
    }
    case "nps": case "scale": {
      const from = f.type === "nps" ? 0 : 1, to = f.type === "nps" ? 10 : Math.min(10, Math.max(3, f.max || 5));
      const n = v == null || v === "" ? null : Number(v);
      body = (
        <div className="fv-scale-w">
          <div className={`fv-scale ${f.type === "nps" ? "is-nps" : ""}`} style={{ ["--n" as string]: to - from + 1 } as CSSProperties} role="radiogroup">
            {Array.from({ length: to - from + 1 }, (_, i) => from + i).map((k) => (
              <button type="button" key={k} role="radio" aria-checked={n === k} className={`fv-sc ${n === k ? "is-on" : ""} ${f.type === "nps" ? (k <= 6 ? "is-lo" : k <= 8 ? "is-mid" : "is-hi") : ""}`} onClick={() => onChange(n === k ? null : k)}>{k}</button>
            ))}
          </div>
          {(f.minLabel || f.maxLabel) && <div className="fv-scale-l"><span>{f.minLabel}</span><span>{f.maxLabel}</span></div>}
        </div>
      );
      break;
    }
  }
  void accent;
  return <>{head}{body}</>;
}
const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
const Cross = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M7 7l10 10M17 7 7 17" /></svg>;

/** A dropdown that is ours (never the browser's), with a search box for long lists. */
function FvSelect({ value, onChange, options, placeholder, search = false }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder: string; search?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => { const n = q.trim().toLowerCase(); return n ? options.filter((o) => o.label.toLowerCase().includes(n)) : options; }, [options, q]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect(); if (!r) return;
      const below = window.innerHeight - r.bottom - 16, above = r.top - 16;
      const up = below < 220 && above > below;
      const maxH = Math.min(300, Math.max(160, up ? above : below));
      setPos({ top: up ? r.top - 6 - maxH : r.bottom + 6, left: r.left, width: r.width, maxH });
    };
    place();
    const off = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", off, true); window.addEventListener("keydown", esc); window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("mousedown", off, true); window.removeEventListener("keydown", esc); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => { if (!open) setQ(""); }, [open]);
  const label = options.find((o) => o.value === value)?.label;
  return (
    <>
      <button ref={btn} type="button" className={`fv-in fv-sel ${label ? "" : "is-empty"} ${open ? "is-open" : ""}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span>{label ?? placeholder}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && pos && createPortal(
        <div ref={menu} className="fv-menu" style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }} role="listbox" translate="no">
          {(search || options.length > 8) && <input className="fv-menu-q" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />}
          <div className="fv-menu-list">
            {shown.slice(0, 300).map((o) => <button type="button" key={o.value} role="option" aria-selected={o.value === value} className={o.value === value ? "is-on" : ""} onClick={() => { onChange(o.value); setOpen(false); }}>{o.label}</button>)}
            {!shown.length && <div className="fv-menu-none">No matches</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/* ══════════════════════════ the form in an e-mail ══════════════════════════ */
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/**
 * The block that goes into an e-mail. Outlook shows no form fields in an e-mail,
 * so: the form's first one-pick question as buttons (each opens the form with
 * that answer already picked) and a button to the whole form. {{email}} is filled
 * in for each person, so their answers land on their contact.
 */
export function emailBlock(form: Pick<MkForm, "token" | "name" | "fields" | "settings">, origin = typeof window !== "undefined" ? window.location.origin : ""): string {
  const st = form.settings ?? {};
  const accent = st.accent || DEFAULT_ACCENT;
  const base = `${origin}/f/${form.token}?e={{email}}`;
  const q = form.fields.find((f) => ["single", "yes_no", "rating", "nps", "scale"].includes(f.type));
  let quick = "";
  if (q) {
    const vals: string[] = q.type === "single" ? (q.options ?? []).slice(0, 6) : q.type === "yes_no" ? ["Yes", "No"] : q.type === "rating" ? ["1", "2", "3", "4", "5"]
      : q.type === "nps" ? Array.from({ length: 11 }, (_, i) => String(i)) : Array.from({ length: Math.min(10, Math.max(3, q.max || 5)) }, (_, i) => String(i + 1));
    const small = vals.length > 6;
    const cells = vals.map((v) => `<td style="padding:3px"><a href="${esc(`${base}&q=${q.id}&a=${encodeURIComponent(v)}`)}" style="display:block;min-width:${small ? 28 : 64}px;padding:${small ? "8px 6px" : "10px 14px"};border:1px solid #d6dfda;border-radius:8px;background:#ffffff;color:#14211b;font-size:${small ? 13 : 14}px;font-weight:600;text-align:center;text-decoration:none">${esc(q.type === "rating" ? "★".repeat(Number(v)) : v)}</a></td>`).join("");
    quick = `<p style="margin:14px 0 6px;font-size:14px;font-weight:600;color:#14211b">${esc(q.label)}</p><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate"><tr>${cells}</tr></table>`;
  }
  return `<div data-mkform="${esc(form.token)}" style="margin:18px 0;padding:18px 20px;border:1px solid #e3e8e5;border-left:4px solid ${accent};border-radius:10px;background:#f8faf9">`
    + `<p style="margin:0 0 4px;font-size:16px;font-weight:700;color:#14211b">${esc(st.title || form.name)}</p>`
    + (st.intro ? `<p style="margin:0;font-size:13.5px;color:#4b5b54">${esc(st.intro)}</p>` : "")
    + quick
    + `<p style="margin:16px 0 0"><a href="${esc(base)}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:${accent};color:#ffffff;font-size:14px;font-weight:700;text-decoration:none">${esc(q ? "Answer the rest" : st.button || "Fill in the form")} →</a></p>`
    + `</div>`;
}
