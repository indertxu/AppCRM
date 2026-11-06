// Settings › APIs › Website forms — each workspace builds its own forms: the questions, the name each is sent
// as and where the answer lands (a contact or company field, one of your own fields — made right here — or the
// notes). Saving makes the form's key; the page then hands out the code with the key already in it, ready to
// paste in the website. Nothing to look up anywhere else. Served by manage-users › /api/crm/leads.
import { useMemo, useState } from "react";
import { supabase } from "../../api/supabase";
import Select, { type SelectOption } from "../../framework/Select";

export interface CrmField { id: string; label: string; type: string; options: string[] }
export interface FormKey {
  id: string; name: string; prefix: string; access: string; scope: string; last_used_at: string | null; revoked_at: string | null; expires_at: string | null;
  settings: { source?: string; tags?: string[]; assign_to?: string[]; origins?: string[]; fields?: FormFieldDef[]; public_key?: string } | null;
}
export interface FormFieldDef { name: string; label: string; to: string; required?: boolean }
type NewField = { on: "company" | "contact"; type: string; options: string };
type Row = { k: number; label: string; name: string; to: string; required: boolean; nf?: NewField; named?: boolean };

const CONTACT_STD: [string, string][] = [["first_name", "First name"], ["last_name", "Last name"], ["email", "E-mail"], ["phone", "Phone"], ["position", "Job title"],
  ["city", "City"], ["country", "Country"], ["language", "Language"], ["linkedin", "LinkedIn"]];
const COMPANY_STD: [string, string][] = [["name", "Name"], ["website", "Website"], ["phone", "Phone"], ["email", "E-mail"], ["vat_number", "VAT number"],
  ["city", "City"], ["province", "Province"], ["country", "Country"], ["sector", "Sector"], ["linkedin", "LinkedIn"]];
const TYPES: [string, string][] = [["text", "Text"], ["select", "One choice"], ["multiselect", "Several choices"], ["number", "Number"], ["date", "Date"], ["boolean", "Yes / no"]];
const TYPE_NAME: Record<string, string> = Object.fromEntries(TYPES);

let seq = 1;
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
const row = (label: string, to: string, required = false, nf?: NewField, name?: string): Row => ({ k: seq++, label, name: name ?? slug(label), to, required, nf });

/** Starting points: the usual contact form, and a demo request like Konsolidator's. */
function template(kind: "contact" | "demo", fields: { company: CrmField[]; contact: CrmField[] }): Row[] {
  const own = (on: "company" | "contact", label: string, type: string, options: string[], q: string, name: string) => {
    const f = fields[on].find((x) => x.label.trim().toLowerCase() === label.toLowerCase());
    return f ? row(q, `${on}.custom.${f.id}`, false, undefined, name) : row(q, "", false, { on, type, options: options.join(", ") }, name);
  };
  if (kind === "contact") return [
    row("First name", "contact.first_name", true), row("Last name", "contact.last_name"), row("Work e-mail", "contact.email", true, undefined, "email"),
    row("Phone", "contact.phone", false, undefined, "phone"), row("Company", "company.name", false, undefined, "company"), row("Message", "note", false, undefined, "message"),
  ];
  return [
    row("First name", "contact.first_name", true), row("Last name", "contact.last_name"), row("Company", "company.name", true, undefined, "company"),
    own("company", "Employees", "select", ["1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"], "Company size", "employees"),
    own("company", "Legal entities", "select", ["1", "2-5", "6-10", "11-25", "26-50", "50+"], "Number of legal entities", "entities"),
    own("company", "ERPs", "multiselect", ["Business Central", "SAP", "Sage", "a3ERP", "Odoo", "Holded", "NetSuite", "Excel", "Other"], "ERPs you use", "erps"),
    own("contact", "Interested in", "multiselect", ["Data Warehouse", "Consolidation", "Planning", "Reporting"], "What interests you", "interests"),
    row("Work e-mail", "contact.email", true, undefined, "email"),
  ];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What a field looks like on the web: its input, choices and whether it's a list. */
function kindOf(f: FormFieldDef, fields: { company: CrmField[]; contact: CrmField[] }) {
  const m = f.to.match(/^(company|contact)\.custom\.(.+)$/);
  if (m) {
    const d = fields[m[1] as "company" | "contact"].find((x) => x.id === m[2]);
    return { type: d?.type ?? "text", options: d?.options ?? [], where: `${m[1] === "company" ? "Company" : "Contact"} · ${d?.label ?? "your field"}` };
  }
  if (f.to === "note") return { type: "long", options: [], where: "Contact · notes" };
  const [on, col] = f.to.split(".");
  const std = (on === "company" ? COMPANY_STD : CONTACT_STD).find(([c]) => c === col);
  return { type: col === "email" ? "email" : col === "phone" ? "tel" : col === "website" || col === "linkedin" ? "url" : "text", options: [], where: `${on === "company" ? "Company" : "Contact"} · ${std?.[1] ?? col}` };
}

function htmlCode(name: string, defs: FormFieldDef[], url: string, key: string, fields: { company: CrmField[]; contact: CrmField[] }) {
  const lists: string[] = [];
  const inputs = defs.map((f) => {
    const k = kindOf(f, fields); const req = f.required ? " required" : "";
    const lab = esc(f.label);
    if (k.type === "multiselect") {
      lists.push(f.name);
      return `  <fieldset>\n    <legend>${lab}</legend>\n${(k.options.length ? k.options : ["Option 1", "Option 2"]).map((o) => `    <label><input type="checkbox" name="${f.name}" value="${esc(o)}"> ${esc(o)}</label>`).join("\n")}\n  </fieldset>`;
    }
    if (k.type === "select") return `  <label>${lab}\n    <select name="${f.name}"${req}>\n      <option value="">Choose…</option>\n${(k.options.length ? k.options : ["Option 1", "Option 2"]).map((o) => `      <option>${esc(o)}</option>`).join("\n")}\n    </select>\n  </label>`;
    if (k.type === "boolean") return `  <label><input type="checkbox" name="${f.name}" value="yes"> ${lab}</label>`;
    if (k.type === "long") return `  <label>${lab}\n    <textarea name="${f.name}" rows="4"${req}></textarea>\n  </label>`;
    const t = k.type === "number" ? "number" : k.type === "date" ? "date" : ["email", "tel", "url"].includes(k.type) ? k.type : "text";
    return `  <label>${lab}\n    <input type="${t}" name="${f.name}"${req}>\n  </label>`;
  }).join("\n");
  return `<!-- ${name} — paste where the form goes. Style it like the rest of your page. -->
<form id="crm-form">
${inputs}
  <!-- anti-spam: hidden from people; if a bot fills it, nothing is saved -->
  <input type="text" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
  <button type="submit">Send</button>
  <p data-msg hidden></p>
</form>
<script>
document.getElementById("crm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget, data = {}, msg = form.querySelector("[data-msg]");
  new FormData(form).forEach((v, k) => { data[k] = k in data ? [].concat(data[k], v) : v; });
${lists.length ? `  ${JSON.stringify(lists)}.forEach((k) => { data[k] = [].concat(data[k] ?? []); });\n` : ""}  data.page = location.href;
  const res = await fetch("${url}", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "${key}" },
    body: JSON.stringify(data),
  });
  msg.hidden = false;
  msg.textContent = res.ok ? "Thank you! We'll be in touch soon." : "Something went wrong. Please try again.";
  if (res.ok) form.reset();
});
</script>`;
}

function jsCode(defs: FormFieldDef[], url: string, key: string, fields: { company: CrmField[]; contact: CrmField[] }) {
  const lines = defs.map((f) => {
    const k = kindOf(f, fields);
    const ex = k.type === "multiselect" ? `[${(k.options.slice(0, 2).length ? k.options.slice(0, 2) : ["…"]).map((o) => JSON.stringify(o)).join(", ")}]` : k.type === "select" && k.options[0] ? JSON.stringify(k.options[0]) : "…";
    return `    ${f.name}: ${ex},${" ".repeat(Math.max(1, 26 - f.name.length - ex.length))}// ${f.label}${f.required ? " (required)" : ""}`;
  }).join("\n");
  return `// your own form: send the answers like this when it's submitted
const res = await fetch("${url}", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": "${key}" },
  body: JSON.stringify({
${lines}
    page: location.href,
    _hp: "",                  // a hidden input people leave empty (anti-spam)
  }),
});
// 201 new lead · 200 already there, updated · 400 { error, missing } · 403 wrong key or website`;
}

function brief(name: string, defs: FormFieldDef[], url: string, key: string, fields: { company: CrmField[]; contact: CrmField[] }) {
  const w = Math.max(...defs.map((f) => f.name.length), 4) + 2;
  return `Website form "${name}" → our CRM

When the form is submitted, send the answers as JSON:
  POST ${url}
  Content-Type: application/json
  x-api-key: ${key}

Fields:
${defs.map((f) => { const k = kindOf(f, fields); return `  ${f.name.padEnd(w)}${f.label}${f.required ? " · required" : ""}${k.type === "multiselect" ? " · a list" : ""}${k.options.length ? ` · choices: ${k.options.join(", ")}` : ""}`; }).join("\n")}
  ${"page".padEnd(w)}the page it was sent from (optional)
  ${"_hp".padEnd(w)}a hidden input people leave empty (anti-spam, optional)

Answers: 201 = new lead · 200 = already there, updated · 400 = { error, missing } · 403 = wrong key or website.
This key can only add leads, so it can live in the page's code.`;
}

export default function WebForms({ forms, canManage, sources, tagsAll, people, fields, reload, copy, copied, url, revokeCell, used }: {
  forms: FormKey[]; canManage: boolean; sources: string[]; tagsAll: string[]; people: { id: string; name: string }[];
  fields: { company: CrmField[]; contact: CrmField[] }; reload: () => Promise<void>; copy: (t: string, k: string) => void; copied: string | null;
  url: string; revokeCell: (k: FormKey) => React.ReactNode; used: (k: FormKey) => string;
}) {
  type Draft = { id: string | null; name: string; source: string; tags: string[]; assign: string[]; origins: string; rows: Row[] };
  const [draft, setDraft] = useState<Draft | null>(null);
  const [code, setCode] = useState<{ id: string; tab: "html" | "js" | "brief" } | null>(null);
  const [pq, setPq] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const targets: SelectOption[] = useMemo(() => [
    ...CONTACT_STD.map(([c, l]) => ({ value: `contact.${c}`, label: `Contact · ${l}` })),
    ...fields.contact.map((f) => ({ value: `contact.custom.${f.id}`, label: `Contact · ${f.label}`, hint: TYPE_NAME[f.type] ?? "your field" })),
    { value: "note", label: "Contact · notes", hint: "kept as text" },
    ...COMPANY_STD.map(([c, l]) => ({ value: `company.${c}`, label: `Company · ${l}` })),
    ...fields.company.map((f) => ({ value: `company.custom.${f.id}`, label: `Company · ${f.label}`, hint: TYPE_NAME[f.type] ?? "your field" })),
    { value: "new:contact", label: "+ New contact field…" },
    { value: "new:company", label: "+ New company field…" },
  ], [fields]);

  const start = (f?: FormKey) => {
    setErr(null); setCode(null); setPq("");
    if (!f) {
      setDraft({ id: null, name: "", source: "Inbound / Website", tags: tagsAll.includes("0. Potential Client") ? ["0. Potential Client"] : [], assign: [], origins: "", rows: template("contact", fields) });
      return;
    }
    const s = f.settings ?? {};
    setDraft({ id: f.id, name: f.name, source: s.source ?? "Inbound / Website", tags: s.tags ?? [], assign: s.assign_to ?? [], origins: (s.origins ?? []).join(", "),
      rows: (s.fields ?? []).map((x) => ({ ...row(x.label, x.to, !!x.required, undefined, x.name), named: true })) });
  };
  const setRow = (k: number, patch: Partial<Row>) => setDraft((d) => d && { ...d, rows: d.rows.map((r) => r.k === k ? { ...r, ...patch } : r) });

  const names = draft?.rows.map((r) => r.name.trim()) ?? [];
  const dupe = names.find((n, i) => n && names.indexOf(n) !== i);
  const hasEmail = !!draft?.rows.some((r) => r.to === "contact.email");
  const ready = !!draft && !!draft.name.trim() && draft.rows.length > 0 && !dupe && hasEmail
    && draft.rows.every((r) => r.label.trim() && r.name.trim() && (r.to || r.nf));

  const save = async () => {
    if (!draft || !ready) return;
    setBusy(true); setErr(null);
    try {
      const defs: FormFieldDef[] = [];
      const made: Record<string, number> = { company: fields.company.length, contact: fields.contact.length };
      for (const r of draft.rows) {
        let to = r.to;
        if (r.nf) {
          const on = r.nf.on;
          const same = fields[on].find((f) => f.label.trim().toLowerCase() === r.label.trim().toLowerCase());
          if (same) to = `${on}.custom.${same.id}`;
          else {
            const options = /select/.test(r.nf.type) ? r.nf.options.split(/\s*[,;\n]\s*/).map((x) => x.trim()).filter(Boolean) : [];
            const { data, error } = await supabase.from(on === "company" ? "company_fields" : "contact_fields")
              .insert({ label: r.label.trim(), type: r.nf.type, required: false, options, sort: made[on]++ }).select("id").single();
            if (error || !data) throw new Error(error?.message ?? "Couldn't make the field.");
            to = `${on}.custom.${(data as any).id}`;
          }
        }
        defs.push({ name: r.name.trim(), label: r.label.trim(), to, required: r.required });
      }
      const origins = draft.origins.split(/[\s,;]+/).map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean).map((x) => (/^https?:\/\//i.test(x) ? x : `https://${x}`));
      const settings = { source: draft.source || undefined, tags: draft.tags, assign_to: draft.assign, origins, fields: defs };
      let openId = draft.id;
      if (draft.id) {
        const old = forms.find((f) => f.id === draft.id)?.settings ?? {};
        const { error } = await supabase.from("client_api_keys").update({ name: draft.name.trim(), settings: { ...old, ...settings } }).eq("id", draft.id);
        if (error) throw new Error(error.message);
      } else {
        const key = "fck_" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))).map((b) => b.toString(16).padStart(2, "0")).join("");
        // a form key can only add leads and lives in the page's code anyway, so it's kept to hand it out again
        const { data, error } = await supabase.from("client_api_keys").insert({
          name: draft.name.trim(), prefix: key.slice(0, 12), key_hash: hash, access: "form", scope: "crm", client_ids: null, settings: { ...settings, public_key: key },
        }).select("id").single();
        if (error) throw new Error(/scope|settings|access_check/.test(error.message) ? "Run sql/111_crm_import_api.sql in Supabase first." : error.message);
        openId = (data as any)?.id ?? null;
      }
      await reload();
      setDraft(null);
      if (openId) setCode({ id: openId, tab: "html" });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  const sourceOpts = [...new Set(["Inbound / Website", ...sources, ...(draft?.source ? [draft.source] : [])])].map((x) => ({ value: x, label: x }));

  const editor = draft && (
    <div className="cps-form api-form">
      <div className="api-grid is-3">
        <div className="cl-field"><label>Form name</label>
          <input className="cl-input" autoFocus placeholder="e.g. Demo request" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="cl-field"><label>Source of new companies</label>
          <Select value={draft.source} onChange={(v) => setDraft({ ...draft, source: v })} options={sourceOpts} searchable />
        </div>
        <div className="cl-field"><label>Only from these websites <span className="api-opt">optional</span></label>
          <input className="cl-input" placeholder="yourcompany.com" value={draft.origins} onChange={(e) => setDraft({ ...draft, origins: e.target.value })} />
        </div>
      </div>

      <div className="api-fh">
        <b>The form's fields</b>
        <span>Start from <button onClick={() => setDraft({ ...draft, rows: template("contact", fields) })}>a contact form</button> · <button onClick={() => setDraft({ ...draft, rows: template("demo", fields) })}>a demo request</button></span>
      </div>
      <div className="api-fl" role="table">
        <div className="api-fl-h" role="row"><span>Question on the form</span><span>Sent as</span><span>Goes to</span><span>Required</span><span /></div>
        {draft.rows.map((r) => (
          <div className="api-fl-r" role="row" key={r.k}>
            <input className="cl-input" placeholder="e.g. Company size" value={r.label}
              onChange={(e) => setRow(r.k, { label: e.target.value, ...(r.named ? {} : { name: slug(e.target.value) }) })} />
            <input className={`cl-input api-mono ${dupe === r.name.trim() ? "is-bad" : ""}`} value={r.name} spellCheck={false}
              onChange={(e) => setRow(r.k, { name: e.target.value.replace(/[^\w-]/g, "_"), named: true })} title={dupe === r.name.trim() ? "Two fields are sent with this name" : undefined} />
            <Select value={r.nf ? `new:${r.nf.on}` : r.to} placeholder="Choose where it goes…" options={targets} searchable
              onChange={(v) => v.startsWith("new:") ? setRow(r.k, { to: "", nf: { on: v.slice(4) as "company" | "contact", type: "text", options: "" } }) : setRow(r.k, { to: v, nf: undefined })} />
            <label className="api-req"><input type="checkbox" checked={r.required} onChange={(e) => setRow(r.k, { required: e.target.checked })} /><span aria-hidden="true" /></label>
            <button className="api-x" aria-label="Remove field" onClick={() => setDraft({ ...draft, rows: draft.rows.filter((x) => x.k !== r.k) })}>×</button>
            {r.nf && (
              <div className="api-nf">
                <span>New {r.nf.on} field <b>{r.label.trim() || "…"}</b></span>
                <div className="cps-seg is-sm">
                  {TYPES.map(([t, l]) => <button key={t} className={r.nf!.type === t ? "is-on" : ""} onClick={() => setRow(r.k, { nf: { ...r.nf!, type: t } })}>{l}</button>)}
                </div>
                {/select/.test(r.nf.type) && <input className="cl-input" placeholder="Choices, with commas: 1-10, 11-50, 51-200" value={r.nf.options} onChange={(e) => setRow(r.k, { nf: { ...r.nf!, options: e.target.value } })} />}
              </div>
            )}
          </div>
        ))}
        <button className="api-add" onClick={() => setDraft({ ...draft, rows: [...draft.rows, row("", "")] })}>+ Add a field</button>
      </div>
      {!hasEmail && <p className="api-warn">Add a field that goes to <b>Contact · E-mail</b>: it's how the contact is found or created.</p>}
      {dupe && <p className="api-warn">Two fields are sent as <code>{dupe}</code>: give each its own name.</p>}

      {tagsAll.length > 0 && (
        <div className="cl-field"><label>Type tags new companies get</label>
          <div className="cps-pick-list">
            {tagsAll.map((t) => {
              const on = draft.tags.includes(t);
              return <button key={t} className={`cps-chip ${on ? "is-on" : ""}`} onClick={() => setDraft({ ...draft, tags: on ? draft.tags.filter((x) => x !== t) : [...draft.tags, t] })}><i />{t}</button>;
            })}
          </div>
        </div>
      )}
      <div className="cl-field"><label>Give the leads to <span className="api-opt">optional — they see them in their lists</span></label>
        <input className="cl-input api-q" placeholder="Search people…" value={pq} onChange={(e) => setPq(e.target.value)} />
        <div className="cps-pick-list">
          {people.filter((x) => draft.assign.includes(x.id) || !pq || x.name.toLowerCase().includes(pq.toLowerCase())).slice(0, 40).map((x) => {
            const on = draft.assign.includes(x.id);
            return <button key={x.id} className={`cps-chip ${on ? "is-on" : ""}`} onClick={() => setDraft({ ...draft, assign: on ? draft.assign.filter((y) => y !== x.id) : [...draft.assign, x.id] })}><i />{x.name}</button>;
          })}
        </div>
      </div>
      {err && <p className="su-error">{err}</p>}
      <div className="cps-actions">
        <button className="cps-link" onClick={() => { setDraft(null); setErr(null); }}>Cancel</button>
        <button className="cl-primary" disabled={busy || !ready} onClick={save}>{busy ? "Saving…" : draft.id ? "Save form" : "Create form"}</button>
      </div>
    </div>
  );

  const codeFor = (f: FormKey) => {
    const s = f.settings ?? {};
    const defs = s.fields ?? [];
    const key = s.public_key;
    if (!key) return <p className="st-note">This key was shown only once, when it was made. Make the form again to get its code.</p>;
    const tab = code?.tab ?? "html";
    const text = tab === "html" ? htmlCode(f.name, defs, url, key, fields) : tab === "js" ? jsCode(defs, url, key, fields) : brief(f.name, defs, url, key, fields);
    return (
      <div className="api-codebox">
        <div className="api-codebar">
          <div className="cps-seg">
            <button className={tab === "html" ? "is-on" : ""} onClick={() => setCode({ id: f.id, tab: "html" })}>Ready-made form</button>
            <button className={tab === "js" ? "is-on" : ""} onClick={() => setCode({ id: f.id, tab: "js" })}>For your own form</button>
            <button className={tab === "brief" ? "is-on" : ""} onClick={() => setCode({ id: f.id, tab: "brief" })}>Note for your web developer</button>
          </div>
          <button className="cl-primary" onClick={() => copy(text, `code-${f.id}`)}>{copied === `code-${f.id}` ? "Copied" : "Copy"}</button>
        </div>
        <p className="st-note">{tab === "html" ? "Paste it in the page where the form goes: it already sends everything to your CRM." : tab === "js" ? "If the website already has its form, it only has to send the answers like this." : "Everything they need, in plain words. Send it as it is."}</p>
        <div className="api-code"><pre><code>{text}</code></pre></div>
        <div className="cps-base is-key">
          <span className="cps-k">Key</span>
          <code>{key}</code>
          <button className="cps-copy" onClick={() => copy(key, `key-${f.id}`)}>{copied === `key-${f.id}` ? "Copied" : "Copy"}</button>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="cps-keybar">
        <p className="st-note">Build the form your website shows: its questions, and where each answer goes in your companies and contacts. The page then gives you the code to paste — key included.</p>
        {canManage && !draft && <button className="cl-primary" onClick={() => start()}>+ New form</button>}
      </div>
      {draft && !draft.id && editor}
      <div className="cps-keys">
        {forms.length === 0 && !draft && <p className="cps-none">No forms yet. Make one, then paste its code in your website.</p>}
        {forms.map((f, i) => {
          const s = f.settings ?? {};
          const n = s.fields?.length ?? 0;
          const live = !f.revoked_at;
          return (
            <div className="api-formcard" key={f.id} style={{ ["--i" as any]: i }}>
              <div className={`cps-key api-key is-${live ? "active" : "revoked"}`}>
                <span className="cps-key-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M8 8h8M8 12h8M8 16h5" /></svg></span>
                <div className="cps-key-main"><b>{f.name}</b><code>{n ? `${n} field${n === 1 ? "" : "s"}` : "fixed demo fields"}</code></div>
                <span className="cps-scope api-src" title={[s.source, s.origins?.length ? `Only from ${s.origins.join(", ")}` : ""].filter(Boolean).join(" · ")}>
                  {s.source || "Inbound / Website"}{s.tags?.length ? <small>{s.tags.join(", ")}</small> : null}
                </span>
                <span className="cps-meta">{used(f)}</span>
                <span className="api-acts">
                  {live && canManage && <button className="cps-link" onClick={() => draft?.id === f.id ? setDraft(null) : start(f)}>{draft?.id === f.id ? "Close" : "Edit"}</button>}
                  {live && <button className={`cps-link ${code?.id === f.id ? "is-on" : ""}`} onClick={() => { setDraft(null); setCode(code?.id === f.id ? null : { id: f.id, tab: "html" }); }}>{code?.id === f.id ? "Hide code" : "Get the code"}</button>}
                  {revokeCell(f)}
                </span>
              </div>
              {draft?.id === f.id && editor}
              {code?.id === f.id && codeFor(f)}
            </div>
          );
        })}
      </div>
    </>
  );
}
