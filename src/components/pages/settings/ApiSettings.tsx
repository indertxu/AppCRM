// Settings › Your company › APIs — the keys other apps and your website use to reach the workspace
// (served by the manage-users Edge Function under /api):
//   · Companies & contacts: a website form (e.g. the demo request) adds leads; full keys import companies and contacts
//   · Client documents: the client files API (moved here from Settings › Clients)
import { useEffect, useMemo, useState } from "react";
import { PageLoader } from "../../framework/AppLayout";
import { supabase } from "../../api/supabase";
import Select from "../../framework/Select";
import { SettingsShell } from "../companies/CompaniesPage";
import WebForms, { type CrmField } from "./ApiForms";
import "./ApiSettings.css";

interface ApiKeyRow {
  id: string; name: string; prefix: string; access: "read" | "write" | "form"; client_ids: string[] | null; scope: "files" | "crm";
  settings: { source?: string; tags?: string[]; assign_to?: string[]; origins?: string[]; fields?: { name: string; label: string; to: string; required?: boolean }[]; public_key?: string } | null;
  expires_at: string | null; last_used_at: string | null; revoked_at: string | null; created_at: string;
}
export const API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-users/api`;
const FILE_ENDPOINTS: [string, string, string, boolean][] = [
  ["GET", "/clients", "Clients this key can reach", false],
  ["GET", "/clients/{client}/tree", "Every folder (with its path) and file of a client", false],
  ["GET", "/clients/{client}/files?folder=Contracts/2026", "Files in one folder (id or path); no folder = all", false],
  ["GET", "/clients/{client}/files/{file}", "File details and a download link valid for 10 min (?redirect=1 jumps to it)", false],
  ["GET", "/clients/{client}/files/{file}/content", "The file itself", false],
  ["POST", "/clients/{client}/files?name=offer.pdf&folder=Contracts", "Upload: the body is the file; missing folders are created", true],
  ["PUT", "/clients/{client}/files/{file}", "Replace the file's content (body = new file)", true],
  ["PATCH", "/clients/{client}/files/{file}", "JSON { name, note, folder } — rename, note or move", true],
  ["DELETE", "/clients/{client}/files/{file}", "Delete the file", true],
  ["GET", "/clients/{client}/folders", "Folders with their paths", false],
  ["POST", "/clients/{client}/folders", "JSON { name, parent } — create (parent = id or path)", true],
  ["PATCH", "/clients/{client}/folders/{folder}", "JSON { name, parent } — rename or move", true],
  ["DELETE", "/clients/{client}/folders/{folder}", "Delete the folder, its subfolders and files", true],
];
const CRM_ENDPOINTS: [string, string, string, boolean][] = [
  ["POST", "/crm/leads", "A form request: finds or creates the company and the contact, links them and notes the request", false],
  ["GET", "/crm/fields", "The fields it can fill — standard ones and your own, with their choices", false],
  ["POST", "/crm/companies", "JSON { name, website, city, …, company_fields } — one company (found by name or website)", true],
  ["POST", "/crm/contacts", "JSON { first_name, email, …, company, contact_fields } — one contact (found by e-mail)", true],
];

const shortDate = (d: string | null) => d ? new Date(d).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";
const hashKey = async (t: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
const newKey = () => "fck_" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
const statusOf = (k: ApiKeyRow) => k.revoked_at ? "revoked" : k.expires_at && new Date(k.expires_at).getTime() < Date.now() ? "expired" : "active";
const KeyIco = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M15 7a4 4 0 1 1-3.9 4.9L3 20v-3h3v-3h3l2.1-2.1A4 4 0 0 1 15 7zM16 10h.01" /></svg>;

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (t: string, k: string) => {
    navigator.clipboard?.writeText(t).then(() => { setCopied(k); window.setTimeout(() => setCopied(null), 1400); }).catch(() => {});
  };
  return { copied, copy };
}

function Endpoints({ list }: { list: [string, string, string, boolean][] }) {
  return (
    <div className="cps-eps">
      {list.map(([m, path, what, write], i) => (
        <div className="cps-ep" key={m + path} style={{ ["--i" as any]: i }}>
          <span className={`cps-m is-${m.toLowerCase()}`}>{m}</span>
          <code>{path}</code>
          <span className="cps-ep-d">{what}{write && <em>full key</em>}</span>
        </div>
      ))}
    </div>
  );
}

function RevokeCell({ k, canManage, ask, setAsk, revoke }: { k: ApiKeyRow; canManage: boolean; ask: string | null; setAsk: (v: string | null) => void; revoke: (id: string) => void }) {
  const st = statusOf(k);
  if (st !== "active") return <span className={`cps-badge is-${st}`}>{st === "revoked" ? "Revoked" : "Expired"}</span>;
  if (!canManage) return <span className="cps-badge is-active">Active</span>;
  if (ask === k.id) return <span className="cps-ask">Revoke? <button className="is-yes" onClick={() => revoke(k.id)}>Yes</button><button onClick={() => setAsk(null)}>No</button></span>;
  return <button className="cps-revoke" onClick={() => setAsk(k.id)}>Revoke</button>;
}

function FreshKey({ value, onDone, copy, copied }: { value: string; onDone: () => void; copy: (t: string, k: string) => void; copied: string | null }) {
  return (
    <div className="cps-fresh">
      <b>Your new key</b>
      <p>Copy it now: it won't be shown again.</p>
      <div className="cps-base is-key">
        <code>{value}</code>
        <button className="cps-copy" onClick={() => copy(value, "fresh")}>{copied === "fresh" ? "Copied" : "Copy"}</button>
      </div>
      <button className="cps-link" onClick={onDone}>Done</button>
    </div>
  );
}

export default function ApiSettings({ onBack, canManage }: { onBack: () => void; canManage: boolean }) {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [tagsAll, setTagsAll] = useState<string[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [fields, setFields] = useState<{ company: CrmField[]; contact: CrmField[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ scope: "crm" | "files"; key: string } | null>(null);
  const [askRevoke, setAskRevoke] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopy();

  const load = async () => {
    const [k, c, o, p, cf, tf] = await Promise.all([
      supabase.from("client_api_keys").select("id, name, prefix, access, client_ids, scope, settings, expires_at, last_used_at, revoked_at, created_at").order("created_at", { ascending: false }),
      supabase.from("clients").select("id, name").order("name"),
      supabase.from("crm_options").select("kind, label, sort").in("kind", ["source", "relationship"]).order("sort").order("label"),
      supabase.from("profiles").select("id, first_name, last_name").order("first_name"),
      supabase.from("company_fields").select("id, label, type, options").order("sort"),
      supabase.from("contact_fields").select("id, label, type, options").order("sort"),
    ]);
    if (k.error) { setErr(/scope|settings/.test(k.error.message) ? "Run sql/111_crm_import_api.sql in Supabase first." : k.error.message); setKeys([]); }
    else setKeys(((k.data ?? []) as any[]).map((x) => ({ ...x, scope: x.scope ?? "files" })) as ApiKeyRow[]);
    setClients(((c.data ?? []) as any[]).map((x) => ({ id: String(x.id), name: x.name ?? "" })));
    const opts = (o.data ?? []) as { kind: string; label: string }[];
    setSources(opts.filter((x) => x.kind === "source" && !/^no usar/i.test(x.label)).map((x) => x.label));
    setTagsAll(opts.filter((x) => x.kind === "relationship").map((x) => x.label));
    setPeople(((p.data ?? []) as any[]).map((x) => ({ id: x.id, name: [x.first_name, x.last_name].filter(Boolean).join(" ") || "Unnamed" })));
    const norm = (xs: any[] | null) => (xs ?? []).map((x) => ({ id: String(x.id), label: String(x.label ?? ""), type: String(x.type ?? "text"), options: Array.isArray(x.options) ? x.options.map(String) : [] }));
    setFields({ company: norm(cf.data), contact: norm(tf.data) });
  };
  useEffect(() => { load(); }, []);

  const revoke = async (id: string) => {
    setAskRevoke(null);
    const { error } = await supabase.from("client_api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (error) { setErr(error.message); return; }
    load();
  };

  const crmKeys = (keys ?? []).filter((k) => k.scope === "crm");
  const fileKeys = (keys ?? []).filter((k) => k.scope !== "crm");

  // ---------------- companies & contacts ----------------
  const url = `${API_BASE}/crm/leads`;
  const used = (k: { last_used_at: string | null }) => `Used ${k.last_used_at ? shortDate(k.last_used_at) : "never"}`;
  const formKeys = crmKeys.filter((k) => k.access === "form");
  const importKeys = crmKeys.filter((k) => k.access !== "form");
  type ImportForm = { name: string; source: string; tags: string[] };
  const [iform, setIform] = useState<ImportForm | null>(null);
  const createImport = async () => {
    if (!iform || !iform.name.trim()) return;
    setBusy(true); setErr(null);
    const key = newKey();
    const { error } = await supabase.from("client_api_keys").insert({
      name: iform.name.trim(), prefix: key.slice(0, 12), key_hash: await hashKey(key), access: "write", scope: "crm", client_ids: null,
      settings: { source: iform.source || undefined, tags: iform.tags },
    });
    setBusy(false);
    if (error) { setErr(/scope|settings|access_check/.test(error.message) ? "Run sql/111_crm_import_api.sql in Supabase first." : error.message); return; }
    setFresh({ scope: "crm", key }); setIform(null);
    load();
  };
  const sourceOpts = useMemo(() => {
    const xs = [...new Set(["Inbound / Website", ...sources, ...(iform?.source ? [iform.source] : [])])];
    return xs.map((x) => ({ value: x, label: x }));
  }, [sources, iform?.source]);

  const formsBody = keys === null || !fields
    ? <PageLoader fill={false} size={80} label="Loading forms" />
    : <WebForms forms={formKeys} canManage={canManage} sources={sources} tagsAll={tagsAll} people={people} fields={fields} reload={load}
        copy={copy} copied={copied} url={url} used={used}
        revokeCell={(k) => <RevokeCell k={k as ApiKeyRow} canManage={canManage} ask={askRevoke} setAsk={setAskRevoke} revoke={revoke} />} />;

  const importBody = (
    <>
      <div className="cps-keybar">
        <p className="st-note">For another system (another CRM, a script, a server) that adds and updates companies and contacts one by one. It can do more than a form key, so it's shown once and kept on a server — never in a web page.</p>
        {canManage && !iform && <button className="cl-primary" onClick={() => { setIform({ name: "", source: "Inbound / Website", tags: [] }); setFresh(null); setErr(null); }}>+ New key</button>}
      </div>
      {fresh?.scope === "crm" && <FreshKey value={fresh.key} onDone={() => setFresh(null)} copy={copy} copied={copied} />}
      {iform && (
        <div className="cps-form api-form">
          <div className="api-grid">
            <div className="cl-field"><label>Name</label>
              <input className="cl-input" autoFocus placeholder="e.g. HubSpot migration" value={iform.name} onChange={(e) => setIform({ ...iform, name: e.target.value })} />
            </div>
            <div className="cl-field"><label>Source of new companies</label>
              <Select value={iform.source} onChange={(v) => setIform({ ...iform, source: v })} options={sourceOpts} searchable />
            </div>
          </div>
          {tagsAll.length > 0 && (
            <div className="cl-field"><label>Type tags new companies get</label>
              <div className="cps-pick-list">
                {tagsAll.map((t) => {
                  const on = iform.tags.includes(t);
                  return <button key={t} className={`cps-chip ${on ? "is-on" : ""}`} onClick={() => setIform({ ...iform, tags: on ? iform.tags.filter((x) => x !== t) : [...iform.tags, t] })}><i />{t}</button>;
                })}
              </div>
            </div>
          )}
          <div className="cps-actions">
            <button className="cps-link" onClick={() => { setIform(null); setErr(null); }}>Cancel</button>
            <button className="cl-primary" disabled={busy || !iform.name.trim()} onClick={createImport}>{busy ? "Creating…" : "Create key"}</button>
          </div>
        </div>
      )}
      {err && <p className="su-error">{err}</p>}
      <div className="cps-keys">
        {keys === null && <PageLoader fill={false} size={80} label="Loading keys" />}
        {keys && importKeys.length === 0 && <p className="cps-none">No import keys.</p>}
        {importKeys.map((k, i) => {
          const s = k.settings ?? {};
          return (
            <div className={`cps-key api-key is-${statusOf(k)}`} key={k.id} style={{ ["--i" as any]: i }}>
              <span className="cps-key-ico" aria-hidden="true"><KeyIco /></span>
              <div className="cps-key-main"><b>{k.name}</b><code>{k.prefix}…</code></div>
              <span className="cps-scope api-src">{s.source || "Inbound / Website"}{s.tags?.length ? <small>{s.tags.join(", ")}</small> : null}</span>
              <span className="cps-meta">{used(k)}</span>
              <RevokeCell k={k} canManage={canManage} ask={askRevoke} setAsk={setAskRevoke} revoke={revoke} />
            </div>
          );
        })}
      </div>
    </>
  );

  const crmEps = (
    <>
      <div className="cps-base"><span className="cps-k">Base URL</span><code>{API_BASE}</code><button className="cps-copy" onClick={() => copy(API_BASE, "base2")}>{copied === "base2" ? "Copied" : "Copy"}</button></div>
      <p className="st-note">The key goes in the <code>x-api-key</code> header; the answers as JSON (a normal form post works too). Lists can go as arrays or as text with commas.</p>
      <Endpoints list={CRM_ENDPOINTS} />
      <div className="api-what">
        <b>What happens with each request</b>
        <ul>
          <li>The <b>company</b> is found by its name or by the e-mail's domain (not for gmail, hotmail…). If it's new, it's created with the source and type tags you chose, and the website from the e-mail.</li>
          <li>The <b>contact</b> is found by e-mail, or created, and linked to the company. Empty details are filled in; what's already there is kept.</li>
          <li>Answers go into your fields — several-choice fields add to what was there, and a new choice is added to the field — and the request is written in the contact's notes with the date.</li>
        </ul>
      </div>
    </>
  );

  // ---------------- client documents (was Settings › Clients) ----------------
  const [fform, setFform] = useState<{ name: string; access: "read" | "write"; scope: "all" | "some"; picked: string[]; expires: string } | null>(null);
  const [cq, setCq] = useState("");
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "Unknown client";
  const createFiles = async () => {
    if (!fform || !fform.name.trim()) return;
    if (fform.scope === "some" && !fform.picked.length) { setErr("Pick at least one client."); return; }
    setBusy(true); setErr(null);
    const key = newKey();
    const days = Number(fform.expires);
    const { error } = await supabase.from("client_api_keys").insert({
      name: fform.name.trim(), prefix: key.slice(0, 12), key_hash: await hashKey(key), access: fform.access,
      client_ids: fform.scope === "some" ? fform.picked : null,
      expires_at: days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setFresh({ scope: "files", key }); setFform(null); setCq("");
    load();
  };
  const shownClients = cq ? clients.filter((c) => c.name.toLowerCase().includes(cq.toLowerCase())) : clients;
  const fileKeysBody = (
    <>
      <div className="cps-keybar">
        <p className="st-note">Each key reaches the documents and folders of all clients, or only the ones you pick. Read keys list and download; write keys also upload, replace, rename, move and delete.</p>
        {canManage && !fform && <button className="cl-primary" onClick={() => { setFform({ name: "", access: "read", scope: "all", picked: [], expires: "0" }); setFresh(null); setErr(null); }}>+ New key</button>}
      </div>
      {fresh?.scope === "files" && <FreshKey value={fresh.key} onDone={() => setFresh(null)} copy={copy} copied={copied} />}
      {fform && (
        <div className="cps-form">
          <div className="cl-field"><label>Name</label>
            <input className="cl-input" autoFocus placeholder="e.g. SharePoint sync" value={fform.name} onChange={(e) => setFform({ ...fform, name: e.target.value })} />
          </div>
          <div className="cps-row">
            <div className="cl-field"><label>Access</label>
              <div className="cps-seg">
                {(["read", "write"] as const).map((a) => (
                  <button key={a} className={fform.access === a ? "is-on" : ""} onClick={() => setFform({ ...fform, access: a })}>{a === "read" ? "Read only" : "Read & write"}</button>
                ))}
              </div>
            </div>
            <div className="cl-field"><label>Clients</label>
              <div className="cps-seg">
                <button className={fform.scope === "all" ? "is-on" : ""} onClick={() => setFform({ ...fform, scope: "all" })}>All clients</button>
                <button className={fform.scope === "some" ? "is-on" : ""} onClick={() => setFform({ ...fform, scope: "some" })}>Only some</button>
              </div>
            </div>
            <div className="cl-field"><label>Expires</label>
              <Select value={fform.expires} onChange={(v) => setFform({ ...fform, expires: v })}
                options={[{ value: "0", label: "Never" }, { value: "30", label: "In 30 days" }, { value: "90", label: "In 90 days" }, { value: "365", label: "In a year" }]} />
            </div>
          </div>
          {fform.scope === "some" && (
            <div className="cps-pick">
              <input className="cl-input" placeholder="Search clients…" value={cq} onChange={(e) => setCq(e.target.value)} />
              <div className="cps-pick-list">
                {shownClients.map((c) => {
                  const on = fform.picked.includes(c.id);
                  return (
                    <button key={c.id} className={`cps-chip ${on ? "is-on" : ""}`}
                      onClick={() => setFform({ ...fform, picked: on ? fform.picked.filter((x) => x !== c.id) : [...fform.picked, c.id] })}>
                      <i />{c.name || "Unnamed"}
                    </button>
                  );
                })}
                {!shownClients.length && <span className="st-note">No clients match.</span>}
              </div>
            </div>
          )}
          <div className="cps-actions">
            <button className="cps-link" onClick={() => { setFform(null); setErr(null); }}>Cancel</button>
            <button className="cl-primary" disabled={busy || !fform.name.trim()} onClick={createFiles}>{busy ? "Creating…" : "Create key"}</button>
          </div>
        </div>
      )}
      <div className="cps-keys">
        {keys === null && <PageLoader fill={false} size={80} label="Loading keys" />}
        {keys && fileKeys.length === 0 && <p className="cps-none">No keys yet. Create one to let another app reach client documents.</p>}
        {fileKeys.map((k, i) => (
          <div className={`cps-key is-${statusOf(k)}`} key={k.id} style={{ ["--i" as any]: i }}>
            <span className="cps-key-ico" aria-hidden="true"><KeyIco /></span>
            <div className="cps-key-main"><b>{k.name}</b><code>{k.prefix}…</code></div>
            <span className={`cps-badge is-${k.access}`}>{k.access === "write" ? "Read & write" : "Read only"}</span>
            <span className="cps-scope" title={k.client_ids?.length ? k.client_ids.map(clientName).join(", ") : undefined}>
              {k.client_ids?.length ? `${k.client_ids.length} client${k.client_ids.length === 1 ? "" : "s"}` : "All clients"}
            </span>
            <span className="cps-meta">Used {k.last_used_at ? shortDate(k.last_used_at) : "never"}</span>
            <span className="cps-meta">{k.expires_at ? `Expires ${shortDate(k.expires_at)}` : "No expiry"}</span>
            <RevokeCell k={k} canManage={canManage} ask={askRevoke} setAsk={setAskRevoke} revoke={revoke} />
          </div>
        ))}
      </div>
    </>
  );
  const sample = `curl -H "x-api-key: fck_…" "${API_BASE}/clients"`;
  const filesConnect = (
    <>
      <div className="cps-base">
        <span className="cps-k">Base URL</span>
        <code>{API_BASE}</code>
        <button className="cps-copy" onClick={() => copy(API_BASE, "base")}>{copied === "base" ? "Copied" : "Copy"}</button>
      </div>
      <p className="st-note">Send the key in the <code>x-api-key</code> header. Folders can be given by id or by path, like <code>Contracts/2026</code>.</p>
      <div className="cps-base is-sample">
        <code>{sample}</code>
        <button className="cps-copy" onClick={() => copy(sample, "sample")}>{copied === "sample" ? "Copied" : "Copy"}</button>
      </div>
      <Endpoints list={FILE_ENDPOINTS} />
    </>
  );

  const activeForms = formKeys.filter((k) => statusOf(k) === "active").length;
  const activeFiles = fileKeys.filter((k) => statusOf(k) === "active").length;
  const wrap = (x: React.ReactNode) => <div className="cps api">{x}</div>;
  return (
    <SettingsShell icon="link" title="APIs" sub="Your website's forms send you leads; other apps reach your companies, contacts and client documents" onBack={onBack}
      tags={<>
        <span className="sx-tag is-ok">{activeForms} website form{activeForms === 1 ? "" : "s"}</span>
        <span className="sx-tag">{activeFiles} document key{activeFiles === 1 ? "" : "s"}</span>
      </>}
      sections={[
        { k: "forms", label: "Website forms", icon: "globe", tone: "green", count: formKeys.length, title: "Website forms", hint: "The forms on your website that create companies and contacts here — build them and copy their code", body: wrap(formsBody) },
        { k: "import", label: "Import keys", icon: "lock", tone: "amber", count: importKeys.length, title: "Import keys", hint: "For another system that adds and updates companies and contacts", body: wrap(importBody) },
        { k: "crmeps", label: "How it works", icon: "link", tone: "indigo", count: CRM_ENDPOINTS.length, title: "Companies & contacts · how it works", hint: "The endpoints, and what each request does", body: wrap(crmEps) },
        { k: "filekeys", label: "Document keys", icon: "folder", tone: "violet", count: fileKeys.length, title: "Client documents · keys", hint: "Who can reach client documents from outside, and how much they can do", body: wrap(fileKeysBody) },
        { k: "fileconnect", label: "Document API", icon: "tree", tone: "slate", count: FILE_ENDPOINTS.length, title: "Client documents · endpoints", hint: "List, download, upload, rename, move and delete files and folders", body: wrap(filesConnect) },
      ]} />
  );
}
