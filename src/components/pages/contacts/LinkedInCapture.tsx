/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * LinkedIn → CRM.
 *
 *  - LinkedInCapturePage (route /linkedin): the small window the browser
 *    extension opens from a LinkedIn profile or company page. It shows what was
 *    read from the page, finds the person / company if it's already in the CRM,
 *    and saves it (new, or filling the blanks / overwriting an existing one).
 *  - LinkedInExtensionModal: how to install the extension, and the download
 *    (a .zip built here, with this app's address baked in).
 *  - liContent: the extension's content script (runs on linkedin.com). It is
 *    serialised with toString(), so it must not use anything from outside it.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase, setRememberMe } from "../../api/supabase";
import { saveContact, saveCompany, listCrmOptions, sectorOptions, matchSector, type Contact, type Company } from "../companies/companiesApi";
import { normalizeLinkedIn, matchCountry, countryName, countryOptions } from "./contactProfile";
import "./ContactsPage.css";

/* ══════════════════════════ what the extension sends ══════════════════════════ */
interface LiPerson {
  kind: "person"; url: string; name: string; firstName?: string; lastName?: string;
  headline?: string; position?: string; company?: string; companyUrl?: string;
  location?: string; about?: string; photo?: string; email?: string; phone?: string; website?: string; hint?: string;
}
interface LiCompany {
  kind: "company"; url: string; name: string; tagline?: string; industry?: string; size?: string;
  location?: string; website?: string; phone?: string; about?: string; logo?: string; founded?: string; specialties?: string; hint?: string;
}
type LiData = LiPerson | LiCompany;

const STORE = "crm.linkedin.capture";
function readPayload(): LiData | null {
  const m = window.location.hash.match(/[#&]d=([^&]+)/);
  if (m) {
    try {
      const b = m[1].replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b + "===".slice((b.length + 3) % 4));
      const json = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
      const d = JSON.parse(json) as LiData;
      try { sessionStorage.setItem(STORE, JSON.stringify(d)); } catch { /* private mode */ }
      history.replaceState(null, "", window.location.pathname);
      return d;
    } catch { /* fall through */ }
  }
  try { const s = sessionStorage.getItem(STORE); return s ? (JSON.parse(s) as LiData) : null; } catch { return null; }
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
/** "Madrid, Comunidad de Madrid, España" → city / province / country code. */
function splitPlace(raw?: string): { city: string; province: string; country: string } {
  const parts = clean(raw).split(",").map((x) => x.trim()).filter(Boolean)
    .filter((x) => !/area|área|metropolitan|metropolitana|region$|greater/i.test(x) || x.split(" ").length > 4);
  let country = "";
  if (parts.length) { const c = matchCountry(parts[parts.length - 1]); if (c) { country = c; parts.pop(); } }
  return { city: parts[0] ?? "", province: parts.length > 1 ? parts[parts.length - 1] : "", country };
}
function splitName(d: LiPerson): [string, string] {
  if (d.firstName) return [d.firstName, d.lastName ?? ""];
  const n = clean(d.name).replace(/\s*\(.*?\)\s*/g, " ").replace(/,.*$/, "").trim().split(" ");
  return [n[0] ?? "", n.slice(1).join(" ")];
}
const siteOf = (w?: string) => {
  let s = clean(w);
  const r = s.match(/[?&]url=([^&]+)/); // linkedin.com/redir/redirect?url=…
  if (r) { try { s = decodeURIComponent(r[1]); } catch { /* keep */ } }
  return s.replace(/\/+$/, "");
};
const handleOf = (url: string) => (normalizeLinkedIn(url).match(/linkedin\.com\/((?:in|company)\/[^/?#]+)/i)?.[1] ?? "").toLowerCase();

/* ══════════════════════════ the capture window ══════════════════════════ */
type PersonDraft = { first_name: string; last_name: string; position: string; email: string; phone: string; city: string; province: string; country: string; linkedin: string; notes: string };
type CompanyDraft = { name: string; website: string; phone: string; sector: string; city: string; province: string; country: string; linkedin: string; notes: string };
type Mode = "fill" | "overwrite";

const PERSON_LABELS: [keyof PersonDraft, string][] = [
  ["first_name", "First name"], ["last_name", "Last name"], ["position", "Position"], ["email", "Email"], ["phone", "Phone"],
  ["city", "City"], ["province", "Province"], ["country", "Country"], ["linkedin", "LinkedIn"], ["notes", "Notes"],
];
const COMPANY_LABELS: [keyof CompanyDraft, string][] = [
  ["name", "Name"], ["website", "Website"], ["phone", "Phone"], ["sector", "Sector"],
  ["city", "City"], ["province", "Province"], ["country", "Country"], ["linkedin", "LinkedIn"], ["notes", "Notes"],
];

export default function LinkedInCapturePage() {
  const navigate = useNavigate();
  const [data] = useState<LiData | null>(() => readPayload());
  const waiting = !data && /[?&]wait=1/.test(window.location.search);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data: s }) => setSession(s.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => { document.title = "Save to CRM"; }, []);

  if (session === undefined) return <div className="lic"><div className="lic-card is-center"><span className="lic-spin" /></div></div>;
  if (!session) return <div className="lic"><LicLogin /></div>;
  if (!data && waiting) {
    return <div className="lic"><div className="lic-card is-center"><span className="lic-spin" /><p className="lic-note">Reading the LinkedIn page…</p></div></div>;
  }
  if (!data) {
    return (
      <div className="lic">
        <div className="lic-card is-center">
          <span className="lic-li">in</span>
          <h1>Nothing to save</h1>
          <p className="lic-note">Open a LinkedIn profile or company page and press <b>Save to CRM</b>.</p>
          <button className="lic-btn is-ghost" onClick={() => navigate("/contacts")}>Go to contacts</button>
        </div>
      </div>
    );
  }
  return <div className="lic">{data.kind === "company" ? <CompanyCapture d={data} /> : <PersonCapture d={data} />}</div>;
}

function LicLogin() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr(null);
    setRememberMe(true); // keep the session, so the next capture doesn't ask again
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    setBusy(false);
    if (error) setErr(error.message);
  };
  return (
    <form className="lic-card is-center" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <span className="lic-li">in</span>
      <h1>Sign in to save</h1>
      <p className="lic-note">Use your CRM account. Only the first time: you stay signed in.</p>
      <input className="lic-in" type="email" placeholder="Email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className="lic-in" type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      {err && <p className="lic-err">{err}</p>}
      <button className="lic-btn" disabled={busy || !email || !pw}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

/** The header of the capture card: picture, name, where it came from. */
function LicHead({ img, title, sub, kind, url }: { img?: string; title: string; sub?: string; kind: string; url: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <header className="lic-head">
      {img && !broken ? <img className="lic-pic" src={img} alt="" onError={() => setBroken(true)} referrerPolicy="no-referrer" />
        : <span className="lic-pic is-ph">{clean(title).split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "in"}</span>}
      <div className="lic-head-t">
        <span className="lic-kind"><i>in</i>{kind}</span>
        <h1>{title || "No name found"}</h1>
        {sub && <p>{sub}</p>}
      </div>
      <a className="lic-open" href={url} target="_blank" rel="noreferrer" title="Open on LinkedIn">↗</a>
    </header>
  );
}

/** Existing record banner + fill/overwrite switch. */
function LicMatch({ label, mode, onMode, onNew, asNew }: { label: string; mode: Mode; onMode: (m: Mode) => void; onNew: (v: boolean) => void; asNew: boolean }) {
  return (
    <div className={`lic-match ${asNew ? "is-off" : ""}`}>
      <div className="lic-match-t">
        <b>Already in the CRM</b>
        <span>{label}</span>
      </div>
      {!asNew && (
        <div className="lic-seg">
          <button className={mode === "fill" ? "is-on" : ""} onClick={() => onMode("fill")}>Fill blanks</button>
          <button className={mode === "overwrite" ? "is-on" : ""} onClick={() => onMode("overwrite")}>Overwrite</button>
        </div>
      )}
      <button className="lic-linkbtn" onClick={() => onNew(!asNew)}>{asNew ? "Update it instead" : "Save as new"}</button>
    </div>
  );
}

function LicField({ label, value, onChange, was, multi, keep, country }: { label: string; value: string; onChange: (v: string) => void; was?: string; multi?: boolean; keep?: boolean; country?: boolean }) {
  return (
    <label className={`lic-f ${multi ? "is-wide" : ""} ${keep ? "is-keep" : ""}`}>
      <span>{label}{keep && <em>keeps CRM value</em>}</span>
      {multi ? <textarea rows={4} value={value} onChange={(e) => onChange(e.target.value)} />
        : country ? (
          <select value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {countryOptions().map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : <input value={value} onChange={(e) => onChange(e.target.value)} />}
      {was != null && was !== "" && was !== value && <small>CRM: {was}</small>}
    </label>
  );
}

function LicDone({ what, onOpen }: { what: string; onOpen: () => void }) {
  return (
    <div className="lic-card is-center lic-done">
      <span className="lic-tick">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </span>
      <h1>Saved</h1>
      <p className="lic-note">{what}</p>
      <div className="lic-row">
        <button className="lic-btn is-ghost" onClick={() => window.close()}>Close</button>
        <button className="lic-btn" onClick={onOpen}>Open in CRM</button>
      </div>
    </div>
  );
}

const merge = <T extends Record<string, string>>(draft: T, cur: Record<string, any> | null, mode: Mode): T => {
  if (!cur) return draft;
  const out: Record<string, string> = {};
  (Object.keys(draft) as (keyof T & string)[]).forEach((k) => {
    const had = clean(cur[k]);
    out[k] = mode === "fill" && had ? had : clean(draft[k]) || had;
  });
  return out as T;
};

/* ---------------- a person ---------------- */
function PersonCapture({ d }: { d: LiPerson }) {
  const navigate = useNavigate();
  const place = splitPlace(d.location);
  const [first, last] = splitName(d);
  const [draft, setDraft] = useState<PersonDraft>({
    first_name: first, last_name: last, position: clean(d.position || d.headline), email: clean(d.email), phone: clean(d.phone),
    city: place.city, province: place.province, country: place.country, linkedin: normalizeLinkedIn(d.url),
    notes: [clean(d.headline) && clean(d.headline) !== clean(d.position) ? clean(d.headline) : "", clean(d.about)].filter(Boolean).join("\n\n"),
  });
  const [match, setMatch] = useState<any | null>(null);
  const [asNew, setAsNew] = useState(false);
  const [mode, setMode] = useState<Mode>("fill");
  const [companies, setCompanies] = useState<{ id: string; name: string; linkedin?: string | null }[]>([]);
  const [coPick, setCoPick] = useState<string>(""); // company id, "new" or "none"
  const [coName, setCoName] = useState(clean(d.company));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const h = handleOf(d.url);
      let hit: any = null;
      if (h) hit = (await supabase.from("contacts").select("*").ilike("linkedin", `%${h}%`).limit(1)).data?.[0] ?? null;
      if (!hit && first && last) hit = (await supabase.from("contacts").select("*").ilike("first_name", first).ilike("last_name", last).limit(1)).data?.[0] ?? null;
      let links: string[] = [];
      if (hit) links = ((await supabase.from("company_contacts").select("company_id").eq("contact_id", hit.id)).data ?? []).map((r: any) => r.company_id);
      const { data: cos } = await supabase.from("companies").select("*").order("name");
      if (!alive) return;
      const list = ((cos ?? []) as any[]).map((c) => ({ id: c.id as string, name: c.name as string, linkedin: c.linkedin as string | null }));
      setCompanies(list);
      if (hit) setMatch({ ...hit, companyIds: links });
      // the company they work at, if it's in the CRM
      const ch = d.companyUrl ? handleOf(d.companyUrl) : "";
      const nm = clean(d.company).toLowerCase();
      const co = list.find((c) => ch && c.linkedin && handleOf(c.linkedin) === ch) ?? list.find((c) => nm && c.name.trim().toLowerCase() === nm);
      setCoPick(co ? co.id : nm ? "new" : "none");
      setLoading(false);
    })().catch(() => setLoading(false));
    return () => { alive = false; };
  }, [d.url, d.company, d.companyUrl, first, last]);

  const cur = match && !asNew ? match : null;
  const set = (k: keyof PersonDraft) => (v: string) => setDraft((x) => ({ ...x, [k]: v }));

  const save = async () => {
    if (!draft.first_name.trim()) { setErr("Add a first name."); return; }
    setBusy(true); setErr(null);
    let companyId: string | null = null;
    if (coPick === "new" && coName.trim()) {
      const co: Company = { name: coName.trim(), linkedin: d.companyUrl ? normalizeLinkedIn(d.companyUrl) : null };
      const e = await saveCompany(co);
      if (e) { setBusy(false); setErr(`Company: ${e}`); return; }
      companyId = co.id ?? null;
    } else if (coPick && coPick !== "none" && coPick !== "new") companyId = coPick;
    const m = merge(draft, cur, mode);
    const c: Contact = {
      ...(cur ?? {}),
      ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v || null])),
      first_name: m.first_name,
      custom: cur?.custom ?? {},
      companyIds: [...new Set([...(cur?.companyIds ?? []), ...(companyId ? [companyId] : [])])],
    } as Contact;
    if (!cur) delete (c as any).id;
    const e = await saveContact(c);
    setBusy(false);
    if (e) { setErr(e); return; }
    setSaved(c.id ?? "");
  };

  if (saved != null) {
    return <LicDone what={`${draft.first_name} ${draft.last_name}`.trim() + (cur ? " was updated." : " was added to your contacts.")}
      onOpen={() => navigate("/contacts", { state: { focusContactId: saved } })} />;
  }
  const keep = (k: keyof PersonDraft) => !!cur && mode === "fill" && !!clean(cur[k]) && clean(cur[k]) !== clean(draft[k]);
  const field = (k: keyof PersonDraft, label: string, multi = false) => (
    <LicField key={k} label={label} value={draft[k]} onChange={set(k)} was={cur ? clean(k === "country" && cur[k] ? countryName(cur[k]) : cur[k]) : undefined} multi={multi} keep={keep(k)} country={k === "country"} />
  );
  return (
    <div className="lic-card">
      <LicHead img={d.photo} title={clean(d.name)} sub={clean(d.headline)} kind="Person" url={d.url} />
      <div className="lic-body">
        {loading ? <div className="lic-loading"><span className="lic-spin" />Looking in your CRM…</div> : (
          <>
            {match && <LicMatch label={`${match.first_name ?? ""} ${match.last_name ?? ""}`.trim()} mode={mode} onMode={setMode} asNew={asNew} onNew={setAsNew} />}
            <div className="lic-grid">
              {PERSON_LABELS.filter(([k]) => k !== "notes").map(([k, l]) => field(k, l))}
            </div>
            <div className="lic-co">
              <span className="lic-co-k">Company</span>
              <select value={coPick} onChange={(e) => setCoPick(e.target.value)}>
                {clean(coName) && <option value="new">+ Create “{coName}”</option>}
                <option value="none">No company</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {coPick === "new" && <input value={coName} onChange={(e) => setCoName(e.target.value)} placeholder="Company name" />}
            </div>
            {field("notes", "Notes", true)}
            {d.hint && <p className="lic-hint">{d.hint}</p>}
          </>
        )}
      </div>
      <LicFoot err={err} busy={busy || loading} label={cur ? "Update contact" : "Save contact"} onSave={save} />
    </div>
  );
}

/* ---------------- a company ---------------- */
function CompanyCapture({ d }: { d: LiCompany }) {
  const navigate = useNavigate();
  const place = splitPlace(d.location);
  const extra = [clean(d.tagline), clean(d.about),
    [d.size && `Size: ${clean(d.size)}`, d.founded && `Founded: ${clean(d.founded)}`, d.specialties && `Specialties: ${clean(d.specialties)}`].filter(Boolean).join(" · ")]
    .filter(Boolean).join("\n\n");
  const [draft, setDraft] = useState<CompanyDraft>({
    name: clean(d.name), website: siteOf(d.website), phone: clean(d.phone), sector: "",
    city: place.city, province: place.province, country: place.country, linkedin: normalizeLinkedIn(d.url), notes: extra,
  });
  const [sectors, setSectors] = useState<string[]>([]);
  const [match, setMatch] = useState<any | null>(null);
  const [asNew, setAsNew] = useState(false);
  const [mode, setMode] = useState<Mode>("fill");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const opts = sectorOptions(await listCrmOptions());
      const h = handleOf(d.url);
      let hit: any = null;
      if (h) { const r = await supabase.from("companies").select("*").ilike("linkedin", `%${h}%`).limit(1); hit = r.error ? null : r.data?.[0] ?? null; }
      if (!hit && clean(d.name)) hit = (await supabase.from("companies").select("*").ilike("name", clean(d.name)).limit(1)).data?.[0] ?? null;
      const host = siteOf(d.website).replace(/^https?:\/\/(www\.)?/i, "").split("/")[0];
      if (!hit && host) hit = (await supabase.from("companies").select("*").ilike("website", `%${host}%`).limit(1)).data?.[0] ?? null;
      if (!alive) return;
      setSectors(opts);
      setDraft((x) => ({ ...x, sector: matchSector(d.industry, opts) || (d.industry ? "" : "") }));
      setMatch(hit);
      setLoading(false);
    })().catch(() => setLoading(false));
    return () => { alive = false; };
  }, [d.url, d.name, d.website, d.industry]);

  const cur = match && !asNew ? match : null;
  const set = (k: keyof CompanyDraft) => (v: string) => setDraft((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!draft.name.trim()) { setErr("Add the company name."); return; }
    setBusy(true); setErr(null);
    const m = merge(draft, cur, mode);
    const c: Company = {
      ...(cur ?? {}),
      ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v || null])),
      name: m.name,
      custom: cur?.custom ?? {},
    } as Company;
    if (!cur) delete (c as any).id;
    const e = await saveCompany(c);
    setBusy(false);
    if (e) { setErr(e); return; }
    setSaved(c.id ?? "");
  };

  if (saved != null) {
    return <LicDone what={`${draft.name} ${cur ? "was updated." : "was added to your companies."}`}
      onOpen={() => navigate("/companies", { state: { focusCompanyId: saved } })} />;
  }
  const keep = (k: keyof CompanyDraft) => !!cur && mode === "fill" && !!clean(cur[k]) && clean(cur[k]) !== clean(draft[k]);
  const field = (k: keyof CompanyDraft, label: string, multi = false) => (
    <LicField key={k} label={label} value={draft[k]} onChange={set(k)} was={cur ? clean(k === "country" && cur[k] ? countryName(cur[k]) : cur[k]) : undefined} multi={multi} keep={keep(k)} country={k === "country"} />
  );
  return (
    <div className="lic-card">
      <LicHead img={d.logo} title={clean(d.name)} sub={[clean(d.industry), clean(d.size)].filter(Boolean).join(" · ") || clean(d.tagline)} kind="Company" url={d.url} />
      <div className="lic-body">
        {loading ? <div className="lic-loading"><span className="lic-spin" />Looking in your CRM…</div> : (
          <>
            {match && <LicMatch label={match.name} mode={mode} onMode={setMode} asNew={asNew} onNew={setAsNew} />}
            <div className="lic-grid">
              {COMPANY_LABELS.filter(([k]) => k !== "notes" && k !== "sector").map(([k, l]) => field(k, l))}
              <label className={`lic-f ${keep("sector") ? "is-keep" : ""}`}>
                <span>Sector{keep("sector") && <em>keeps CRM value</em>}</span>
                <select value={draft.sector} onChange={(e) => set("sector")(e.target.value)}>
                  <option value="">—</option>
                  {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {d.industry && <small>LinkedIn: {clean(d.industry)}</small>}
              </label>
            </div>
            {field("notes", "Notes", true)}
            {d.hint && <p className="lic-hint">{d.hint}</p>}
          </>
        )}
      </div>
      <LicFoot err={err} busy={busy || loading} label={cur ? "Update company" : "Save company"} onSave={save} />
    </div>
  );
}

function LicFoot({ err, busy, label, onSave }: { err: string | null; busy: boolean; label: string; onSave: () => void }) {
  return (
    <footer className="lic-foot">
      {err && <p className="lic-err">{err}</p>}
      <button className="lic-btn is-ghost" onClick={() => window.close()}>Cancel</button>
      <button className="lic-btn" disabled={busy} onClick={onSave}>{busy ? "Saving…" : label}</button>
    </footer>
  );
}

/* ══════════════════════════ install modal + .zip ══════════════════════════ */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** A plain (stored, uncompressed) .zip — enough for a few small text files. */
function makeZip(files: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, 0, true);
    local.setUint32(14, crc, true); local.setUint32(18, f.data.length, true); local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    const head = new Uint8Array(local.buffer);
    parts.push(head, name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, f.data.length, true); cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += head.length + name.length + f.data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)].map((p) => p.slice().buffer as ArrayBuffer), { type: "application/zip" });
}
/** The extension's icon, drawn here (a green rounded square with "in+"). */
async function iconPng(size: number): Promise<Uint8Array> {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d")!;
  const r = size * 0.22;
  g.fillStyle = "#12b57f";
  g.beginPath(); g.moveTo(r, 0); g.arcTo(size, 0, size, size, r); g.arcTo(size, size, 0, size, r); g.arcTo(0, size, 0, 0, r); g.arcTo(0, 0, size, 0, r); g.fill();
  g.fillStyle = "#fff"; g.font = `700 ${Math.round(size * 0.5)}px Arial, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("in", size * 0.47, size * 0.54);
  g.font = `700 ${Math.round(size * 0.34)}px Arial, sans-serif`; g.fillText("+", size * 0.8, size * 0.28);
  const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
  return new Uint8Array(blob ? await blob.arrayBuffer() : new ArrayBuffer(0));
}
export async function downloadLinkedInExtension(appUrl = window.location.origin) {
  const enc = new TextEncoder();
  const manifest = {
    manifest_version: 3,
    name: "Save to CRM from LinkedIn",
    version: "1.0.0",
    description: "Adds a “Save to CRM” button to LinkedIn profiles and company pages.",
    icons: { 16: "icon16.png", 48: "icon48.png", 128: "icon128.png" },
    content_scripts: [{ matches: ["https://www.linkedin.com/*"], js: ["content.js"], run_at: "document_idle" }],
  };
  const files = [
    { name: "manifest.json", data: enc.encode(JSON.stringify(manifest, null, 2)) },
    { name: "content.js", data: enc.encode(`// Save to CRM — reads the LinkedIn page you're on and opens ${appUrl}/linkedin\n(${liContent.toString()})(${JSON.stringify(appUrl)});\n`) },
    { name: "icon16.png", data: await iconPng(16) },
    { name: "icon48.png", data: await iconPng(48) },
    { name: "icon128.png", data: await iconPng(128) },
  ];
  const url = URL.createObjectURL(makeZip(files));
  const a = document.createElement("a");
  a.href = url; a.download = "linkedin-to-crm.zip";
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function LinkedInExtensionModal({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const steps: [string, ReactNode][] = useMemo(() => [
    ["Download", <>Get the extension below and unzip it into a folder you'll keep.</>],
    ["Load it in Chrome", <>Open <code>chrome://extensions</code>, switch on <b>Developer mode</b> (top right) and click <b>Load unpacked</b>. Pick the unzipped folder.</>],
    ["Save from LinkedIn", <>Open any profile or company page: a <b>Save to CRM</b> button appears bottom-right. It fills in everything the page shows; you check it and save.</>],
  ], []);
  const get = async () => { setBusy(true); try { await downloadLinkedInExtension(); setDone(true); } finally { setBusy(false); } };
  return createPortal(
    <div className="lix-backdrop" onMouseDown={onClose}>
      <div className="lix" role="dialog" aria-modal="true" aria-label="LinkedIn extension" onMouseDown={(e) => e.stopPropagation()}>
        <button className="lix-x" onClick={onClose} aria-label="Close">×</button>
        <span className="lic-li is-big">in</span>
        <h2>Save from LinkedIn</h2>
        <p className="lix-sub">A Chrome extension that adds people and companies to your CRM straight from LinkedIn, with their details filled in.</p>
        <ol className="lix-steps">
          {steps.map(([t, b], i) => <li key={t} style={{ ["--i" as any]: i }}><b>{t}</b><span>{b}</span></li>)}
        </ol>
        <p className="lix-tip">For a person's email and phone, open <b>Contact info</b> on their profile before saving. For a company's website and phone, use its <b>About</b> tab. Works in Chrome, Edge and Brave.</p>
        <div className="lix-act">
          <span className="lix-app">Saves to <code>{window.location.origin}</code></span>
          <button className="lic-btn" disabled={busy} onClick={get}>{busy ? "Preparing…" : done ? "Download again" : "Download extension"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ══════════════════════════ the extension's content script ══════════════════════════
   Runs inside linkedin.com. Self-contained on purpose: it is shipped as text. */
export function liContent(APP: string) {
  const w = window as any;
  if (w.__crmLinkedIn) return;
  w.__crmLinkedIn = true;

  const txt = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  /** Every leaf text in order (LinkedIn's class names are scrambled, so we go by text). */
  const leaves = (root: ParentNode | null | undefined): { el: Element; t: string }[] => {
    if (!root) return [];
    return Array.from(root.querySelectorAll("h1, h2, h3, p, span, a, dt, dd"))
      .filter((e) => !e.querySelector("h1, h2, h3, p, span, a, dt, dd") && txt(e))
      .map((e) => ({ el: e, t: txt(e) }))
      .filter((x, i, arr) => x.t !== "·" && x.t !== "•" && (i === 0 || arr[i - 1].t !== x.t));
  };
  /** "Label" then its value, as LinkedIn lists them (Website / https://…). */
  const pairs = (list: { t: string }[], labels: string[]) => {
    const want = labels.map((l) => l.toLowerCase());
    const i = list.findIndex((x) => want.includes(x.t.toLowerCase()));
    return i >= 0 && list[i + 1] ? list[i + 1].t : "";
  };
  const kindOf = () => (/^\/in\/[^/]+/.test(location.pathname) ? "person" : /^\/company\/[^/]+/.test(location.pathname) ? "company" : null);
  const canon = () => {
    const m = location.pathname.match(/^\/(in|company)\/([^/]+)/);
    return m ? `https://www.linkedin.com/${m[1]}/${m[2]}` : location.href.split("?")[0];
  };
  const cleanUrl = (h: string) => {
    const r = h.match(/[?&]url=([^&]+)/);
    try { return r ? decodeURIComponent(r[1]) : h; } catch { return h; }
  };
  const titleName = () => document.title.replace(/^\(\d+\)\s*/, "").split(/\s[|:–-]\s|:\s/)[0].trim();
  const card = (suffix: RegExp) => Array.from(document.querySelectorAll('[id^="com.linkedin.sdui.profile.card"]')).find((c) => suffix.test(c.id)) ?? null;
  /** A section found by its heading ("About", "Experience"…), old and new LinkedIn. */
  const sectionByHeading = (names: string[]) => {
    const h = Array.from(document.querySelectorAll("main h2, main h3")).find((e) => names.includes(txt(e).toLowerCase()));
    if (!h) return null;
    let s: Element | null = h;
    for (let k = 0; k < 8 && s && txt(s).length <= txt(h).length + 20; k++) s = s.parentElement;
    return s;
  };
  const isTime = (s: string) => /\b(yrs?|mos?|years?|months?|años?|meses|mes|ans?|mois|jahre?|monate?)\b|full-time|part-time|jornada|tiempo completo|self-employed|autónomo|freelance/i.test(s);
  const isPronoun = (s: string) => /^(he|she|they|him|her|them|él|ella|elle|il|sie|er)\s*\/\s*\w+/i.test(s);
  const noise = (s: string) => /\b(followers|seguidores|connections|contactos|conexiones|abonnés|relations)\b/i.test(s)
    || /^(contact info|información de contacto|coordonnées|message|mensaje|connect|conectar|follow|seguir|more|más|open to|disponible para|add section|añadir sección|enhance profile|view my newsletter|profile enhanced with premium|.*verifications?|edit .*|followed by .*|seguido por .*)$/i.test(s);

  /** Opens "Contact info", reads it and closes it again. */
  const readContactInfo = async () => {
    const out = { email: "", phone: "", website: "", birthday: "" };
    let dlg = document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]');
    let opened = false;
    if (!dlg || !/contact info|información de contacto|coordonnées/i.test(txt(dlg))) {
      const link = document.querySelector('a[href*="/overlay/contact-info"]') as HTMLAnchorElement | null;
      if (!link) return out;
      link.click(); opened = true;
      for (let k = 0; k < 30; k++) {
        await sleep(100);
        dlg = document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]');
        if (dlg && /contact info|información de contacto|coordonnées/i.test(txt(dlg)) && leaves(dlg).length > 3) break;
      }
      await sleep(250);
    }
    if (!dlg) return out;
    const L = leaves(dlg);
    const mail = dlg.querySelector('a[href^="mailto:"]') as HTMLAnchorElement | null;
    out.email = mail ? mail.href.replace(/^mailto:/, "").split("?")[0] : pairs(L, ["email", "correo electrónico", "e-mail"]);
    const tel = dlg.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null;
    out.phone = tel ? tel.href.replace(/^tel:/, "") : pairs(L, ["phone", "teléfono", "téléphone", "telefoon"]).replace(/\s*\((mobile|work|home|móvil|trabajo|casa)\)\s*$/i, "");
    const site = pairs(L, ["website", "websites", "sitio web", "sitios web", "site web"]);
    const siteA = Array.from(dlg.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href)
      .map(cleanUrl).find((h) => /^https?:/.test(h) && !/linkedin\.com/.test(h));
    out.website = siteA || site;
    if (opened) {
      const x = dlg.querySelector('button[aria-label*="ismiss"], button[aria-label*="lose"], button[aria-label*="errar"], button[aria-label*="ermer"]') as HTMLButtonElement | null;
      if (x) x.click();
      await sleep(200);
      if (/\/overlay\/contact-info/.test(location.pathname)) history.back();
    }
    return out;
  };

  const person = async () => {
    const top = card(/Topcard$/) ?? sectionByHeading([titleName().toLowerCase()]) ?? document.querySelector("main");
    const L = leaves(top);
    const nameIdx = Math.max(0, L.findIndex((x) => /^H[123]$/.test(x.el.tagName)));
    const name = L[nameIdx]?.t || titleName();
    // the company / school chips: elements holding a company logo or the company icon
    const chip = (re: RegExp) => {
      const mark = Array.from(top?.querySelectorAll("img, svg, use") ?? []).find((e) =>
        re.test((e as HTMLImageElement).src ?? "") || re.test(e.getAttribute("id") ?? "") || re.test(e.getAttribute("href") ?? ""));
      let p: Element | null = mark ?? null;
      for (let k = 0; k < 6 && p && !txt(p); k++) p = p.parentElement;
      return p ? txt(p) : "";
    };
    let company = chip(/company-logo|company-accent/);
    const school = chip(/school-logo|school-accent/);
    const contactIdx = L.findIndex((x) => x.el.tagName === "A" && /overlay\/contact-info/.test(x.el.getAttribute("href") ?? ""));
    let location = contactIdx > 0 ? L[contactIdx - 1].t : "";
    if (!location || location === company || noise(location)) location = "";
    const rest = L.slice(nameIdx + 1, contactIdx > 0 ? contactIdx : undefined).map((x) => x.t)
      .filter((t) => t !== name && !isPronoun(t) && !noise(t) && t !== location && !/^\d/.test(t));
    const headline = rest.find((t) => t !== company && !t.includes(" · ")) ?? "";
    if (!company) { const both = rest.find((t) => t.includes(" · ")); if (both) company = both.split(" · ")[0]; }
    if (!company && school === "" && rest[1] && rest[1] !== headline) company = rest[1];

    // Experience (when the profile shows it): title, company · type, dates…
    let position = "", companyUrl = "";
    const exp = card(/Experience/i) ?? sectionByHeading(["experience", "experiencia", "expérience", "berufserfahrung", "werkervaring"]);
    if (exp) {
      const E = leaves(exp).map((x) => x.t).filter((t) => !/^(experience|experiencia|expérience|show all.*|mostrar todo.*)$/i.test(t));
      if (E[1] && isTime(E[1]) && !isTime(E[0])) { // several roles at one company
        if (!company) company = E[0];
        position = E[2] ?? "";
      } else {
        position = E[0] ?? "";
        if (!company && E[1]) company = E[1].split(" · ")[0];
      }
      const a = exp.querySelector('a[href*="/company/"]') as HTMLAnchorElement | null;
      if (a) companyUrl = a.href.split("?")[0];
    }
    if (!position && headline) {
      const m = headline.split(/\s+(?:at|en|@|chez|bei|presso|bij)\s+/i);
      position = m[0].split("|")[0].trim();
      if (!company && m[1]) company = m[1].split(/[|·]/)[0].trim();
    }
    if (!companyUrl && company) {
      const a = Array.from(document.querySelectorAll('main a[href*="/company/"]')).find((x) => txt(x) === company) as HTMLAnchorElement | undefined;
      if (a) companyUrl = a.href.split("?")[0];
    }
    const ab = card(/About$/) ?? sectionByHeading(["about", "acerca de", "info", "à propos", "infos"]);
    const about = ab ? leaves(ab).map((x) => x.t).filter((t) => !/^(about|acerca de|info|à propos|edit about|…\s*see more|see more|ver más|…ver más)$/i.test(t)).join("\n").replace(/…\s*(see more|ver más)$/i, "").trim() : "";
    const photo = Array.from(top?.querySelectorAll("img") ?? []).map((i) => (i as HTMLImageElement).src).find((src) => /profile-displayphoto/.test(src)) ?? "";
    const ci = await readContactInfo();
    const parts = name.replace(/\s*\(.*?\)\s*/g, " ").replace(/,.*$/, "").trim().split(/\s+/);
    return {
      kind: "person", url: canon(), name,
      firstName: parts[0] ?? "", lastName: parts.slice(1).join(" "),
      headline, position, company, companyUrl, location, about, photo,
      email: ci.email, phone: ci.phone, website: ci.website,
    };
  };

  /** On a company's home tab: open "About" for a moment to read website, phone, HQ… then come back. */
  const visitAbout = async () => {
    if (/\/about\/?$/.test(location.pathname)) return false;
    const slug = location.pathname.match(/^\/company\/([^/]+)/)?.[1];
    const a = Array.from(document.querySelectorAll('main a[href*="/about"]')).find((x) => (x.getAttribute("href") ?? "").includes(`/company/${slug}/about`)) as HTMLAnchorElement | undefined;
    if (!a) return false;
    a.click();
    for (let k = 0; k < 40; k++) {
      await sleep(100);
      if (/\/about\/?$/.test(location.pathname) && leaves(document.querySelector("main")).some((x) => /^(website|industry|sitio web|sector|company size|tamaño de la empresa)$/i.test(x.t))) break;
    }
    await sleep(200);
    return true;
  };

  const company = async () => {
    const went = await visitAbout();
    const main = document.querySelector("main") ?? document.body;
    const h = main.querySelector("h1, h2");
    const name = txt(h) || titleName();
    let topEl: Element | null = h;
    for (let k = 0; k < 6 && topEl && txt(topEl).length < 120; k++) topEl = topEl.parentElement;
    const T = leaves(topEl).map((x) => x.t).filter((t) => t !== name);
    const followersAt = T.findIndex((t) => /followers|seguidores|abonnés/i.test(t));
    const staff = T.find((t) => /employees|empleados|salariés|werknemers/i.test(t)) ?? "";
    const lead = followersAt > 0 ? T.slice(0, followersAt) : T.slice(0, 4);
    // lead: [tagline?, industry, location]
    const loc = lead.length >= 2 ? lead[lead.length - 1] : "";
    const ind = lead.length >= 2 ? lead[lead.length - 2] : lead[0] ?? "";
    const tagline = lead.length >= 3 ? lead[0] : "";
    const L = leaves(main);
    const P = (...ls: string[]) => pairs(L, ls);
    let website = P("website", "sitio web", "site web", "webseite");
    if (!website) {
      const a = Array.from(main.querySelectorAll("a[href]")).find((x) => /visit website|visitar sitio web|ver sitio web|visiter le site|website/i.test(`${txt(x)} ${x.getAttribute("aria-label") ?? ""}`)) as HTMLAnchorElement | undefined;
      if (a) website = cleanUrl(a.href);
    }
    const ov = sectionByHeading(["overview", "información general", "vue d’ensemble", "vue d'ensemble", "overzicht"]);
    let about = "";
    if (ov) {
      const O = leaves(ov).map((x) => x.t);
      const stop = O.findIndex((t) => /^(website|sitio web|site web|phone|teléfono|industry|sector)$/i.test(t));
      about = O.slice(1, stop > 0 ? stop : undefined).join("\n");
    }
    const logo = Array.from(main.querySelectorAll("img")).map((i) => (i as HTMLImageElement).src).find((src) => /company-logo/.test(src)) ?? "";
    const onAbout = /\/about\/?$/.test(location.pathname);
    if (went) history.back();
    return {
      kind: "company", url: canon(), name, tagline,
      industry: P("industry", "sector", "secteur") || ind,
      size: P("company size", "tamaño de la empresa", "taille de l’entreprise", "taille de l'entreprise") || staff,
      location: P("headquarters", "sede", "siège social") || loc,
      website: cleanUrl(website), phone: P("phone", "teléfono", "téléphone"),
      about: about || tagline, logo,
      founded: P("founded", "año de fundación", "fundada en", "fondée en"),
      specialties: P("specialties", "especialidades", "spécialisations"),
      hint: onAbout || website ? "" : "Tip: open the company's “About” tab before saving to bring in the website, phone and headquarters.",
    };
  };

  const b64 = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = ""; bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const send = async () => {
    const k = kindOf();
    if (!k) return;
    // open the window right away (browsers only allow it on the click), fill it once the page is read
    const W = 500, H = 820;
    const left = Math.max(0, (window.screenX ?? 0) + window.outerWidth - W - 40);
    const top = Math.max(0, (window.screenY ?? 0) + 60);
    const win = window.open(`${APP}/linkedin?wait=1`, "crm-linkedin", `popup=yes,width=${W},height=${H},left=${left},top=${top}`);
    btn.classList.add("busy");
    let data: any;
    try { data = k === "person" ? await person() : await company(); } catch { data = { kind: k, url: canon(), name: titleName() }; }
    btn.classList.remove("busy");
    const url = `${APP}/linkedin?t=${Date.now()}#d=${b64(JSON.stringify(data))}`;
    if (win && !win.closed) win.location.href = url;
    else window.open(url, "crm-linkedin", `popup=yes,width=${W},height=${H},left=${left},top=${top}`);
  };

  // a small round button (it opens up on hover), in a shadow root so LinkedIn's styles don't touch it
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:18px;bottom:76px;z-index:2147483646;display:none;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:0;height:36px;padding:0 3px;border-radius:999px;cursor:pointer;
        font:600 12.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff;white-space:nowrap;
        background:linear-gradient(120deg,#12b57f,#0a6f4d);box-shadow:0 8px 20px -8px rgba(10,111,77,.75);
        transition:gap .25s,padding .25s,box-shadow .25s;animation:in .4s cubic-bezier(.16,1,.3,1) both}
      i{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#fff;color:#0a6f4d;font:800 16px/1 Arial,sans-serif;font-style:normal;flex-shrink:0}
      span{max-width:0;overflow:hidden;transition:max-width .3s cubic-bezier(.16,1,.3,1)}
      button:hover,button.busy{gap:7px;padding:0 13px 0 3px;box-shadow:0 12px 26px -10px rgba(10,111,77,.85)}
      button:hover span,button.busy span{max-width:120px}
      button.busy i{animation:spin .8s linear infinite;font-size:13px}
      @keyframes in{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
      @keyframes spin{to{transform:rotate(360deg)}}
    </style>
    <button type="button" title="Save to CRM"><i>+</i><span>Save to CRM</span></button>`;
  const btn = root.querySelector("button")!;
  btn.addEventListener("click", () => { void send(); });
  document.documentElement.appendChild(host);

  let last = "";
  const tick = () => {
    const k = kindOf();
    const key = `${k}:${location.pathname}`;
    if (key === last) return;
    last = key;
    host.style.display = k ? "block" : "none";
  };
  tick();
  window.setInterval(tick, 800);
}
