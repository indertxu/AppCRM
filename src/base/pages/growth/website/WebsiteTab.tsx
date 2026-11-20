/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BASE · Growth › Website — the AI website builder (next to Forms).
 *
 *   No site yet: a short brief (name, what you do, who for, tone, look, pages, language,
 *   address) → "Create with AI" (edge function site-ai) or a blank template.
 *   A site: the live preview in the middle (desktop / tablet / phone; click a section to
 *   pick it), the page's sections and the look on the left, and the AI on the right —
 *   ask for any change in your own words; every change is kept in History and can be undone.
 *   Publish puts the draft live at <slug>.<sites domain> (and /w/<slug>); Settings has the
 *   address, SEO, and — coming — your own domain and an SEO budget.
 * Tables: sql/160_base_sites.sql. Drawn by SiteRender (same as the public page).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import SiteRender from "./SiteRender";
import { SiteIcon } from "./SiteRender";
import {
  BODY_FONTS, HEADING_FONTS, ICONS, SECTION_INFO, blankSection, cleanSeo, newId, siteHost, siteUrl, slugValid, slugify, starterSite, SITES_DOMAIN,
  type Brief, type Section, type SectionBg, type SectionType, type Seo, type Site, type SiteRow, type SiteVersion,
} from "./siteTypes";
import { FIELDS, type FieldDef } from "./sectionFields";
import {
  aiEdit, aiGenerate, addVersion, createSite, deleteSite, listLiveForms, listSites, listVersions, publishSite, saveSite, setStatus, slugFree, uploadAsset,
} from "./siteApi";
import "./Website.css";

/* ---------------------------------------------------------------- icons */
const P = (d: string, w = 1.9) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const I = {
  spark: P("M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"),
  desk: P("M3 5h18v11H3zM8 20h8M12 16v4"), tab: P("M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2"),
  phone: P("M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 19h2"),
  plus: P("M12 5v14M5 12h14"), up: P("M12 19V5M5 12l7-7 7 7"), down: P("M12 5v14M19 12l-7 7-7-7"), copy: P("M8 8h12v12H8zM4 16V4h12"),
  trash: P("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"), x: P("M18 6L6 18M6 6l12 12"), send: P("M22 2L11 13M22 2l-7 20-4-9-9-4z"),
  gear: P("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z", 1.7),
  hist: P("M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"), eye: P("M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"),
  ext: P("M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"), globe: P("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"),
  layers: P("M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5"), brush: P("M9.1 14.9a3 3 0 0 0-4.2 0C3.7 16 4 18.5 2 20c3 .9 6.3.6 7.6-.9a3 3 0 0 0-.5-4.2zM9 15l11.6-11.6a1.4 1.4 0 0 0-2-2L7 13"),
  undo: P("M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"), check: P("M20 6L9 17l-5-5"), img: P("M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9h.01"),
  page: P("M6 3h8l4 4v14H6zM14 3v4h4"), back: P("M15 18l-6-6 6-6"), rocket: P("M5 15c-1.5 1.3-2 4-2 6 2 0 4.7-.5 6-2M12 15l-3-3M9 12c1-4 4.5-8 11-9-1 6.5-5 10-9 11z"),
  drag: P("M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01", 3),
};

const LANGS = [{ v: "es", l: "Español" }, { v: "en", l: "English" }, { v: "nl", l: "Nederlands" }, { v: "de", l: "Deutsch" }, { v: "fr", l: "Français" }, { v: "pt", l: "Português" }, { v: "it", l: "Italiano" }];
const TONES = ["Professional", "Friendly", "Bold", "Elegant", "Playful", "Minimal", "Technical", "Warm"];
const PAGE_CHOICES = ["About", "Services", "Pricing", "FAQ", "Contact"];
const LOOKS: { k: string; label: string; c: string[] }[] = [
  { k: "AI decides", label: "Let the AI choose", c: ["#0c875f", "#d6f46c", "#fff"] },
  { k: "Fresh green and lime, light", label: "Fresh", c: ["#0c875f", "#d6f46c", "#ffffff"] },
  { k: "Deep navy and warm orange, light", label: "Trust", c: ["#1e3a8a", "#f97316", "#ffffff"] },
  { k: "Black, white and one bold accent, minimal", label: "Mono", c: ["#111111", "#ff4d2e", "#ffffff"] },
  { k: "Soft sand and terracotta, elegant serif", label: "Warm", c: ["#9a3412", "#fde68a", "#fbf7f1"] },
  { k: "Dark mode, violet and cyan, modern tech", label: "Night", c: ["#7c3aed", "#22d3ee", "#0b0b14"] },
];
const AI_TIPS = ["Make the hero bolder", "Add a pricing section", "Rewrite everything in English", "Make it feel more premium", "Add an FAQ with 6 questions", "Improve the SEO"];
const GEN_STEPS = ["Reading your brief", "Choosing colours and fonts", "Writing the headline", "Laying out the sections", "Writing every page", "Polishing the copy", "Checking the SEO"];

type Device = "desktop" | "tablet" | "phone";
interface Msg { id: string; role: "user" | "assistant"; text: string; undo?: { draft: Site; seo: Seo } | null; err?: boolean }

const emptyBrief = (): Brief => ({ name: "", about: "", offer: "", audience: "", tone: "Professional", colors: "AI decides", contact: "", lang: "es", pages: ["About", "Services", "Contact"], extra: "" });
const fmtWhen = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/* ================================================================ the tab */
export default function WebsiteTab({ bar, toast }: { bar: HTMLElement | null; toast: (s: string) => void }) {
  const [state, setState] = useState<{ loading: boolean; missing: boolean; error?: string; sites: SiteRow[] }>({ loading: true, missing: false, sites: [] });
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const reload = useCallback(async () => {
    const r = await listSites();
    setState({ loading: false, missing: r.missing, error: r.missing ? undefined : r.error, sites: r.sites });
    setOpenId((cur) => cur ?? r.sites[0]?.id ?? null);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  if (state.loading) return <div className="wsb wsb-load"><span className="wsb-spin" />Loading your website…</div>;
  if (state.missing) return (
    <div className="wsb wsb-setup">
      <div className="wsb-setup-card"><span className="wsb-setup-ico">{I.globe}</span><b>One SQL file switches Website on</b>
        <p>Run <code>src/base/sql/160_base_sites.sql</code> in Supabase (SQL editor). It adds the websites, their history, the public address and the picture storage.</p></div>
    </div>
  );
  const site = state.sites.find((s) => s.id === openId) ?? null;
  if (!site || creating) return (
    <Wizard bar={bar} hasSites={state.sites.length > 0} onCancel={state.sites.length ? () => setCreating(false) : undefined}
      onCreated={(s) => { setState((x) => ({ ...x, sites: [...x.sites.filter((y) => y.id !== s.id), s] })); setOpenId(s.id); setCreating(false); toast("Your website is ready"); }} />
  );
  return <Editor key={site.id} row={site} sites={state.sites} bar={bar} toast={toast}
    onSwitch={(id) => setOpenId(id)} onNew={() => setCreating(true)}
    onChanged={(r) => setState((x) => ({ ...x, sites: x.sites.map((s) => (s.id === r.id ? r : s)) }))}
    onDeleted={(id) => { setState((x) => ({ ...x, sites: x.sites.filter((s) => s.id !== id) })); setOpenId(null); }} />;
}

/* ================================================================ wizard */
function Wizard({ bar, hasSites, onCancel, onCreated }: { bar: HTMLElement | null; hasSites: boolean; onCancel?: () => void; onCreated: (s: SiteRow) => void }) {
  const [b, setB] = useState<Brief>(emptyBrief);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugOk, setSlugOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"ai" | "blank" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const set = (p: Partial<Brief>) => setB((x) => ({ ...x, ...p }));
  useEffect(() => { if (!slugTouched) setSlug(b.name ? slugify(b.name) : ""); }, [b.name, slugTouched]);
  useEffect(() => {
    if (!slug || !slugValid(slug)) { setSlugOk(slug ? false : null); return; }
    let off = false; setSlugOk(null);
    const t = window.setTimeout(() => { void slugFree(slug).then((ok) => { if (!off) setSlugOk(ok); }); }, 350);
    return () => { off = true; window.clearTimeout(t); };
  }, [slug]);
  useEffect(() => {
    if (busy !== "ai") return;
    setStep(0);
    const t = window.setInterval(() => setStep((n) => Math.min(GEN_STEPS.length - 1, n + 1)), 7000);
    return () => window.clearInterval(t);
  }, [busy]);
  const ready = b.name.trim().length > 1 && slugValid(slug) && slugOk !== false;
  const make = async (withAi: boolean) => {
    setErr(null); setBusy(withAi ? "ai" : "blank");
    let draft: Site, seo: Seo;
    if (withAi) {
      const r = await aiGenerate({ ...b, pages: ["Home", ...b.pages], colors: b.colors === "AI decides" ? "" : b.colors });
      if (!r.answer) { setBusy(null); setErr(r.error); return; }
      draft = r.answer.site; seo = { ...r.answer.seo, lang: b.lang };
    } else {
      draft = starterSite(b.name.trim());
      seo = cleanSeo({ title: b.name.trim(), description: b.about.trim().slice(0, 160), lang: b.lang }, draft);
    }
    const c = await createSite({ name: b.name.trim(), slug, draft, seo, brief: b });
    if (!c.site) { setBusy(null); setErr(c.error); return; }
    await addVersion(c.site.id, withAi ? "ai" : "manual", withAi ? "Created with AI" : "Started from the template", draft, seo);
    setBusy(null);
    onCreated(c.site);
  };

  if (busy === "ai") return (
    <div className="wsb wsb-gen">
      <div className="wsb-gen-card">
        <div className="wsb-gen-orb"><i /><i /><i /><span>{I.spark}</span></div>
        <b>Building {b.name || "your website"}…</b>
        <ol>{GEN_STEPS.map((s, i) => <li key={s} className={i < step ? "is-done" : i === step ? "is-on" : ""}><span>{i < step ? I.check : null}</span>{s}</li>)}</ol>
        <p>About a minute. You can change everything afterwards — by hand or by asking the AI.</p>
      </div>
    </div>
  );
  return (
    <div className="wsb wsb-wiz">
      {bar && onCancel && createPortal(<button type="button" className="wsb-tbtn" onClick={onCancel}>{I.back}Back to your website</button>, bar)}
      <div className="wsb-wiz-in">
        <div className="wsb-wiz-intro">
          <span className="wsb-pill">{I.spark}AI website builder</span>
          <h2>{hasSites ? "A new website" : "Your website, written and designed by AI"}</h2>
          <p>Tell it about your business. It writes every page, picks colours and fonts, and lays it out — then you change anything by asking, like you'd ask a designer.</p>
          <div className="wsb-wiz-art" aria-hidden="true"><div className="wsb-wiz-win"><i /><i /><i /><div className="wsb-wiz-l1" /><div className="wsb-wiz-l2" /><div className="wsb-wiz-l3" /><div className="wsb-wiz-cards"><span /><span /><span /></div></div></div>
        </div>
        <div className="wsb-wiz-form">
          <div className="wsb-f2">
            <label className="wsb-f"><span>Business name</span><input value={b.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Brazo Consulting" autoFocus /></label>
            <label className="wsb-f"><span>Language</span><select value={b.lang} onChange={(e) => set({ lang: e.target.value })}>{LANGS.map((l) => <option key={l.v} value={l.v}>{l.l}</option>)}</select></label>
          </div>
          <label className="wsb-f"><span>What you do</span><textarea rows={3} value={b.about} onChange={(e) => set({ about: e.target.value })} placeholder="Two or three sentences: what you offer, what makes you different, where you work." /></label>
          <div className="wsb-f2">
            <label className="wsb-f"><span>Products or services</span><textarea rows={2} value={b.offer} onChange={(e) => set({ offer: e.target.value })} placeholder="One per line, with prices if you want them shown" /></label>
            <label className="wsb-f"><span>Who it's for</span><textarea rows={2} value={b.audience} onChange={(e) => set({ audience: e.target.value })} placeholder="e.g. CFOs of mid-size groups in Spain" /></label>
          </div>
          <div className="wsb-f"><span>Tone</span><div className="wsb-chips">{TONES.map((t) => <button type="button" key={t} className={b.tone === t ? "is-on" : ""} onClick={() => set({ tone: t })}>{t}</button>)}</div></div>
          <div className="wsb-f"><span>Look</span><div className="wsb-looks">{LOOKS.map((l) => (
            <button type="button" key={l.k} className={b.colors === l.k ? "is-on" : ""} onClick={() => set({ colors: l.k })}>
              <i style={{ background: l.c[2] }}><em style={{ background: l.c[0] }} /><em style={{ background: l.c[1] }} /></i>{l.label}
            </button>
          ))}</div></div>
          <div className="wsb-f"><span>Pages besides Home</span><div className="wsb-chips">{PAGE_CHOICES.map((p) => (
            <button type="button" key={p} className={b.pages.includes(p) ? "is-on" : ""} onClick={() => set({ pages: b.pages.includes(p) ? b.pages.filter((x) => x !== p) : [...b.pages, p] })}>{b.pages.includes(p) && I.check}{p}</button>
          ))}</div></div>
          <label className="wsb-f"><span>Contact details to show <em>(optional)</em></span><input value={b.contact} onChange={(e) => set({ contact: e.target.value })} placeholder="E-mail, phone, address — only what you want public" /></label>
          <label className="wsb-f"><span>Anything else <em>(optional)</em></span><input value={b.extra} onChange={(e) => set({ extra: e.target.value })} placeholder="Facts you want on the site, things to avoid, a site you like…" /></label>
          <div className="wsb-f"><span>Address</span>
            <div className={`wsb-slug ${slugOk === false ? "is-bad" : slugOk ? "is-ok" : ""}`}>
              <input value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); }} placeholder="your-name" />
              <em>{SITES_DOMAIN ? `.${SITES_DOMAIN}` : " · /w/"}</em>
              <i>{slugOk === null ? "" : slugOk ? "Free" : slug && !slugValid(slug) ? "3–48 letters, digits or dashes" : "Taken"}</i>
            </div>
            <small>Your site goes live here; your own domain comes later.</small>
          </div>
          {err && <p className="wsb-err">{err}</p>}
          <div className="wsb-wiz-go">
            <button type="button" className="wsb-btn is-ai" disabled={!ready || !!busy || (!b.about.trim() && !b.offer.trim())} onClick={() => void make(true)}
              title={!b.about.trim() && !b.offer.trim() ? "Say what you do first" : undefined}>{I.spark}Create with AI</button>
            <button type="button" className="wsb-btn is-ghost" disabled={!ready || !!busy} onClick={() => void make(false)}>{busy === "blank" ? "Creating…" : "Start from a template"}</button>
          </div>
          <p className="wsb-fine">The AI only writes what it knows: reviews, client names and figures are left as [placeholders] for you to fill in.</p>
        </div>
      </div>
    </div>
  );
}

/* ================================================================ editor */
function Editor({ row, sites, bar, toast, onSwitch, onNew, onChanged, onDeleted }: {
  row: SiteRow; sites: SiteRow[]; bar: HTMLElement | null; toast: (s: string) => void;
  onSwitch: (id: string) => void; onNew: () => void; onChanged: (r: SiteRow) => void; onDeleted: (id: string) => void;
}) {
  const [draft, setDraftRaw] = useState<Site>(row.draft);
  const [seo, setSeo] = useState<Seo>(row.seo);
  const [meta, setMeta] = useState({ name: row.name, slug: row.slug, status: row.status, published: row.published, published_at: row.published_at, settings: row.settings, brief: row.brief });
  const [pageId, setPageId] = useState(row.draft.pages[0]?.id ?? "home");
  const [sel, setSel] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [left, setLeft] = useState<"sections" | "style" | "pages">("sections");
  const [save, setSave] = useState<"saved" | "saving" | "error">("saved");
  const [panel, setPanel] = useState<null | "settings" | "history" | "preview" | "add">(null);
  const [publishing, setPublishing] = useState(false);
  const [forms, setForms] = useState<{ token: string; name: string }[]>([]);
  useEffect(() => { void listLiveForms().then(setForms); }, []);

  const page = draft.pages.find((p) => p.id === pageId) ?? draft.pages[0];
  const section = page.sections.find((s) => s.id === sel) ?? null;

  /* autosave: the draft and SEO, a moment after the last change */
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setSave("saving");
    const t = window.setTimeout(() => {
      void saveSite(row.id, { draft, seo }).then((e) => { setSave(e ? "error" : "saved"); if (!e) onChanged({ ...row, ...meta, draft, seo } as SiteRow); });
    }, 700);
    return () => window.clearTimeout(t);
  }, [draft, seo]); // eslint-disable-line react-hooks/exhaustive-deps

  const setDraft = (f: (s: Site) => Site) => setDraftRaw((s) => f(s));
  const patchPage = (f: (sections: Section[]) => Section[]) => setDraft((s) => ({ ...s, pages: s.pages.map((p) => (p.id === page.id ? { ...p, sections: f(p.sections) } : p)) }));
  const patchSection = (id: string, f: (x: Section) => Section) => patchPage((ss) => ss.map((x) => (x.id === id ? f(x) : x)));
  const move = (id: string, d: -1 | 1) => patchPage((ss) => { const i = ss.findIndex((x) => x.id === id); const j = i + d; if (i < 0 || j < 0 || j >= ss.length) return ss; const n = [...ss]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const remove = (id: string) => { patchPage((ss) => ss.filter((x) => x.id !== id)); if (sel === id) setSel(null); };
  const duplicate = (id: string) => patchPage((ss) => { const i = ss.findIndex((x) => x.id === id); if (i < 0) return ss; const c = { ...JSON.parse(JSON.stringify(ss[i])), id: newId() }; const n = [...ss]; n.splice(i + 1, 0, c); return n; });
  const addSection = (type: SectionType) => {
    const s = blankSection(type);
    if (page.sections.some((x) => x.id === s.id)) s.id = newId();
    patchPage((ss) => (type === "hero" ? [s, ...ss] : [...ss, s]));
    setSel(s.id); setPanel(null); setLeft("sections");
    window.setTimeout(() => document.querySelector(`.wsb-frame [data-sid="${CSS.escape(s.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  };
  const pickSection = (id: string, scroll = false) => {
    setSel(id); setLeft("sections");
    if (scroll) window.setTimeout(() => document.querySelector(`.wsb-frame [data-sid="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  };

  const pubJson = meta.published ? JSON.stringify(meta.published.site) + JSON.stringify(meta.published.seo) : "";
  const changed = !meta.published || JSON.stringify(draft) + JSON.stringify(seo) !== pubJson;
  const publish = async () => {
    setPublishing(true);
    const r = await publishSite({ ...row, ...meta } as SiteRow, draft, seo);
    setPublishing(false);
    if (r.error) { toast(r.error); return; }
    const m = { ...meta, status: "live" as const, published: { site: draft, seo }, published_at: r.at };
    setMeta(m); onChanged({ ...row, ...m, draft, seo } as SiteRow);
    toast(`Live at ${siteHost(meta.slug)}`);
  };

  /* restoring a version (or an AI undo) */
  const restore = (d: Site, s: Seo, note: string) => {
    setDraftRaw(d); setSeo(s);
    if (!d.pages.some((p) => p.id === pageId)) setPageId(d.pages[0].id);
    setSel(null);
    void addVersion(row.id, "restore", note, d, s);
  };

  const tools = (
    <div className="wsb-tools">
      {sites.length > 1 && <select className="wsb-tsel" value={row.id} onChange={(e) => onSwitch(e.target.value)} aria-label="Website">{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
      <div className="wsb-pages" role="tablist" aria-label="Pages">
        {draft.pages.map((p) => <button type="button" key={p.id} role="tab" aria-selected={p.id === page.id} className={p.id === page.id ? "is-on" : ""} onClick={() => { setPageId(p.id); setSel(null); }}>{p.title}</button>)}
      </div>
      <div className="wsb-dev" role="radiogroup" aria-label="Preview size">
        {([["desktop", I.desk, "Desktop"], ["tablet", I.tab, "Tablet"], ["phone", I.phone, "Phone"]] as [Device, ReactNode, string][]).map(([k, ic, l]) => (
          <button type="button" key={k} role="radio" aria-checked={device === k} title={l} className={device === k ? "is-on" : ""} onClick={() => setDevice(k)}>{ic}</button>
        ))}
      </div>
      <span className={`wsb-save is-${save}`}>{save === "saving" ? "Saving…" : save === "error" ? "Not saved" : "Saved"}</span>
      <button type="button" className="wsb-tbtn is-ico" title="History" onClick={() => setPanel("history")}>{I.hist}</button>
      <button type="button" className="wsb-tbtn is-ico" title="Full-screen preview" onClick={() => setPanel("preview")}>{I.eye}</button>
      <button type="button" className="wsb-tbtn is-ico" title="Settings: address, SEO, domain" onClick={() => setPanel("settings")}>{I.gear}</button>
      <button type="button" className={`wsb-pub ${meta.status === "live" && !changed ? "is-live" : ""}`} disabled={publishing || (meta.status === "live" && !changed)} onClick={() => void publish()}>
        {meta.status === "live" && !changed ? <><i className="wsb-dot" />Live</> : publishing ? "Publishing…" : <>{I.rocket}{meta.status === "live" ? "Publish changes" : "Publish"}</>}
      </button>
    </div>
  );

  /* the preview is drawn at the device's real width and scaled to fit (a desktop site looks like one) */
  const design = device === "phone" ? 390 : device === "tablet" ? 820 : 1280;
  const stage = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState(900);
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth - 24));
    ro.observe(el); setAvail(el.clientWidth - 24);
    return () => ro.disconnect();
  }, []);
  const scale = Math.min(1, Math.max(0.3, avail / design));
  return (
    <div className="wsb wsb-ed">
      {bar ? createPortal(tools, bar) : tools}
      {/* left: sections, look, pages */}
      <aside className="wsb-left">
        <div className="wsb-seg">
          {([["sections", I.layers, "Sections"], ["style", I.brush, "Look"], ["pages", I.page, "Pages"]] as const).map(([k, ic, l]) => (
            <button type="button" key={k} className={left === k ? "is-on" : ""} onClick={() => setLeft(k)}>{ic}{l}</button>
          ))}
        </div>
        <div className="wsb-left-body">
          {left === "sections" && (section
            ? <SectionEditor s={section} siteId={row.id} forms={forms} onBack={() => setSel(null)}
              onChange={(d) => patchSection(section.id, (x) => ({ ...x, data: d }))} onBg={(bg) => patchSection(section.id, (x) => ({ ...x, bg }))}
              onMove={(d) => move(section.id, d)} onCopy={() => duplicate(section.id)} onDelete={() => remove(section.id)} toast={toast} />
            : <SectionList page={page} sel={sel} onPick={(id) => pickSection(id, true)} onMove={move} onDelete={remove} onAdd={() => setPanel("add")} />)}
          {left === "style" && <StyleEditor site={draft} siteId={row.id} onChange={(f) => setDraft(f)} toast={toast} />}
          {left === "pages" && <PagesEditor site={draft} current={page.id} onPick={(id) => { setPageId(id); setSel(null); }} onChange={(f) => setDraft(f)} />}
        </div>
      </aside>

      {/* middle: the live preview */}
      <div className="wsb-stage" ref={stage} onClick={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
        <div className={`wsb-frame is-${device}`} style={{ width: Math.round(design * scale) }}>
          <div className="wsb-frame-bar"><i /><i /><i /><span>{siteHost(meta.slug)}{page.path ? `/${page.path}` : ""}</span>{scale < 0.99 && <em>{Math.round(scale * 100)}%</em>}</div>
          <div className="wsb-frame-scroll">
            <div className="wsb-zoom" style={{ width: design, zoom: scale } as React.CSSProperties}>
            <SiteRender site={draft} pageId={page.id} editing contained selected={sel} onSelect={(id) => pickSection(id)}
              onNavigate={(path) => { const p = draft.pages.find((x) => x.path === path); if (p) { setPageId(p.id); setSel(null); } }} />
            </div>
          </div>
        </div>
      </div>

      {/* right: the AI */}
      <AiPanel row={{ ...row, ...meta } as SiteRow} draft={draft} seo={seo} page={page.id} section={section}
        onClearSection={() => setSel(null)}
        onApply={(d, s, note) => {
          setDraftRaw(d); setSeo(s);
          if (!d.pages.some((p) => p.id === pageId)) setPageId(d.pages[0].id);
          if (sel && !d.pages.some((p) => p.sections.some((x) => x.id === sel))) setSel(null);
          void addVersion(row.id, "ai", note, d, s);
        }}
        onUndo={(d, s) => restore(d, s, "Undid an AI change")} />

      {panel === "add" && <AddSection onPick={addSection} onClose={() => setPanel(null)} />}
      {panel === "history" && <History siteId={row.id} onClose={() => setPanel(null)} onRestore={(v) => { restore(v.draft, v.seo, `Brought back ${fmtWhen(v.created_at)}`); setPanel(null); toast("Version brought back"); }} />}
      {panel === "preview" && <FullPreview site={draft} slug={meta.slug} onClose={() => setPanel(null)} />}
      {panel === "settings" && <Settings row={{ ...row, ...meta } as SiteRow} seo={seo} siteId={row.id} toast={toast} onClose={() => setPanel(null)}
        onSeo={setSeo}
        onMeta={(m) => { const n = { ...meta, ...m }; setMeta(n); onChanged({ ...row, ...n, draft, seo } as SiteRow); }}
        onNew={() => { setPanel(null); onNew(); }}
        onDelete={async () => { const e = await deleteSite(row.id); if (e) { toast(e); return; } onDeleted(row.id); toast("Website deleted"); }} />}
    </div>
  );
}

/* ---------------------------------------------------------------- left: the section list */
function SectionList({ page, sel, onPick, onMove, onDelete, onAdd }: { page: Site["pages"][number]; sel: string | null; onPick: (id: string) => void; onMove: (id: string, d: -1 | 1) => void; onDelete: (id: string) => void; onAdd: () => void }) {
  return (
    <div className="wsb-list">
      <div className="wsb-lh"><b>{page.title}</b><em>{page.sections.length} section{page.sections.length === 1 ? "" : "s"}</em></div>
      {page.sections.map((s, i) => (
        <div key={s.id} className={`wsb-li ${sel === s.id ? "is-on" : ""}`} style={{ ["--i" as string]: i } as React.CSSProperties}>
          <button type="button" className="wsb-li-main" onClick={() => onPick(s.id)}>
            <span className={`wsb-li-ico t-${s.type}`}>{secIco(s.type)}</span>
            <span className="wsb-li-t"><b>{SECTION_INFO[s.type].label}</b><em>{String(s.data.title || s.data.eyebrow || "—").replace(/\s+/g, " ").slice(0, 46)}</em></span>
          </button>
          <span className="wsb-li-x">
            <button type="button" title="Up" disabled={i === 0} onClick={() => onMove(s.id, -1)}>{I.up}</button>
            <button type="button" title="Down" disabled={i === page.sections.length - 1} onClick={() => onMove(s.id, 1)}>{I.down}</button>
            <button type="button" title="Remove" onClick={() => onDelete(s.id)}>{I.trash}</button>
          </span>
        </div>
      ))}
      <button type="button" className="wsb-add" onClick={onAdd}>{I.plus}Add a section</button>
    </div>
  );
}
const SEC_ICON: Record<SectionType, string> = { hero: "star", features: "layers", services: "tool", about: "users", steps: "target", stats: "chart", testimonials: "chat", pricing: "cart", faq: "book", gallery: "camera", logos: "award", cta: "rocket", contact: "mail", text: "book" };
const secIco = (t: SectionType) => <SiteIcon name={SEC_ICON[t]} size={16} />;

function AddSection({ onPick, onClose }: { onPick: (t: SectionType) => void; onClose: () => void }) {
  return createPortal(
    <div className="wsb-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wsb-modal is-add" role="dialog" aria-label="Add a section">
        <header><b>Add a section</b><button type="button" className="wsb-x" onClick={onClose} aria-label="Close">{I.x}</button></header>
        <div className="wsb-addgrid">
          {(Object.keys(SECTION_INFO) as SectionType[]).map((t, i) => (
            <button type="button" key={t} onClick={() => onPick(t)} style={{ ["--i" as string]: i } as React.CSSProperties}>
              <span className={`wsb-li-ico t-${t}`}>{secIco(t)}</span><b>{SECTION_INFO[t].label}</b><em>{SECTION_INFO[t].hint}</em>
            </button>
          ))}
        </div>
      </div>
    </div>, document.body);
}

/* ---------------------------------------------------------------- left: one section's fields */
function SectionEditor({ s, siteId, forms, onBack, onChange, onBg, onMove, onCopy, onDelete, toast }: {
  s: Section; siteId: string; forms: { token: string; name: string }[]; onBack: () => void; onChange: (d: Record<string, any>) => void; onBg: (bg: SectionBg) => void;
  onMove: (d: -1 | 1) => void; onCopy: () => void; onDelete: () => void; toast: (s: string) => void;
}) {
  return (
    <div className="wsb-sed">
      <div className="wsb-sed-h">
        <button type="button" className="wsb-back" onClick={onBack}>{I.back}All sections</button>
        <span className="wsb-sed-x">
          <button type="button" title="Up" onClick={() => onMove(-1)}>{I.up}</button>
          <button type="button" title="Down" onClick={() => onMove(1)}>{I.down}</button>
          <button type="button" title="Duplicate" onClick={onCopy}>{I.copy}</button>
          <button type="button" title="Remove" onClick={onDelete}>{I.trash}</button>
        </span>
      </div>
      <div className="wsb-sed-t"><span className={`wsb-li-ico t-${s.type}`}>{secIco(s.type)}</span><b>{SECTION_INFO[s.type].label}</b></div>
      <div className="wsb-f"><span>Background</span>
        <div className="wsb-bgs">{([["default", "Page"], ["alt", "Soft"], ["primary", "Brand"], ["dark", "Dark"]] as [SectionBg, string][]).map(([k, l]) => (
          <button type="button" key={k} className={`b-${k} ${s.bg === k ? "is-on" : ""}`} onClick={() => onBg(k)}><i />{l}</button>
        ))}</div>
      </div>
      <Fields defs={FIELDS[s.type]} value={s.data} onChange={onChange} siteId={siteId} forms={forms} toast={toast} />
      <p className="wsb-fine">Tip: select a section and tell the AI on the right what to change in it.</p>
    </div>
  );
}

function Fields({ defs, value, onChange, siteId, forms, toast }: { defs: FieldDef[]; value: Record<string, any>; onChange: (v: Record<string, any>) => void; siteId: string; forms: { token: string; name: string }[]; toast: (s: string) => void }) {
  const set = (k: string, v: any) => onChange({ ...value, [k]: v });
  return (
    <>
      {defs.map((f) => {
        const v = value[f.k];
        switch (f.kind) {
          case "text": return <label key={f.k} className="wsb-f"><span>{f.label}</span><input value={v ?? ""} onChange={(e) => set(f.k, e.target.value)} /></label>;
          case "area": return <label key={f.k} className="wsb-f"><span>{f.label}</span><AutoArea value={v ?? ""} onChange={(x) => set(f.k, x)} /></label>;
          case "bool": return <label key={f.k} className="wsb-tog"><input type="checkbox" checked={!!v} onChange={(e) => set(f.k, e.target.checked)} /><i />{f.label}</label>;
          case "select": return <label key={f.k} className="wsb-f"><span>{f.label}</span><select value={String(v ?? "")} onChange={(e) => set(f.k, /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value)}>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
          case "link": return (
            <div key={f.k} className="wsb-f"><span>{f.label}</span>
              <div className="wsb-link"><input value={v?.label ?? ""} placeholder="Text" onChange={(e) => set(f.k, { ...(v ?? {}), label: e.target.value })} /><input value={v?.href ?? ""} placeholder="#contact or https://…" onChange={(e) => set(f.k, { ...(v ?? {}), href: e.target.value })} /></div>
            </div>
          );
          case "image": return <ImageField key={f.k} label={f.label} value={v ?? ""} onChange={(x) => set(f.k, x)} siteId={siteId} toast={toast} />;
          case "icon": return (
            <div key={f.k} className="wsb-f"><span>{f.label}</span>
              <div className="wsb-icons">{ICONS.map((n) => <button type="button" key={n} title={n} className={v === n ? "is-on" : ""} onClick={() => set(f.k, n)}><SiteIcon name={n} size={16} /></button>)}</div>
            </div>
          );
          case "form": return (
            <label key={f.k} className="wsb-f"><span>{f.label}</span>
              <select value={v ?? ""} onChange={(e) => set(f.k, e.target.value)}>
                <option value="">No form — show the e-mail</option>
                {forms.map((x) => <option key={x.token} value={x.token}>{x.name}</option>)}
              </select>
              {f.hint && <small>{forms.length ? f.hint : "You have no live forms yet — make one in Growth › Forms."}</small>}
            </label>
          );
          case "strings": {
            const list: string[] = Array.isArray(v) ? v : [];
            return (
              <div key={f.k} className="wsb-f"><span>{f.label}</span>
                <div className="wsb-strs">
                  {list.map((x, i) => <div key={i} className="wsb-str"><input value={x} onChange={(e) => set(f.k, list.map((y, j) => (j === i ? e.target.value : y)))} /><button type="button" onClick={() => set(f.k, list.filter((_, j) => j !== i))} aria-label="Remove">{I.x}</button></div>)}
                  <button type="button" className="wsb-mini" onClick={() => set(f.k, [...list, ""])}>{I.plus}Add a {f.noun ?? "line"}</button>
                </div>
              </div>
            );
          }
          case "list": {
            const list: Record<string, any>[] = Array.isArray(v) ? v : [];
            return (
              <div key={f.k} className="wsb-f"><span>{f.label}</span>
                {f.hint && <small className="is-warn">{f.hint}</small>}
                <div className="wsb-items">
                  {list.map((it, i) => (
                    <details key={i} className="wsb-item" open={list.length <= 2}>
                      <summary><b>{String(it.title || it.name || it.q || it.quote || it.value || it.caption || `${f.noun ?? "Item"} ${i + 1}`).slice(0, 40)}</b>
                        <span className="wsb-item-x">
                          <button type="button" title="Up" disabled={i === 0} onClick={(e) => { e.preventDefault(); const n = [...list]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set(f.k, n); }}>{I.up}</button>
                          <button type="button" title="Remove" onClick={(e) => { e.preventDefault(); set(f.k, list.filter((_, j) => j !== i)); }}>{I.trash}</button>
                        </span>
                      </summary>
                      <Fields defs={f.item!} value={it} onChange={(nv) => set(f.k, list.map((y, j) => (j === i ? nv : y)))} siteId={siteId} forms={forms} toast={toast} />
                    </details>
                  ))}
                  <button type="button" className="wsb-mini" onClick={() => set(f.k, [...list, JSON.parse(JSON.stringify(f.blank ?? {}))])}>{I.plus}Add a {f.noun ?? "item"}</button>
                </div>
              </div>
            );
          }
        }
        return null;
      })}
    </>
  );
}

function AutoArea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = `${Math.min(320, el.scrollHeight + 2)}px`; } }, [value]);
  return <textarea ref={ref} rows={2} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function ImageField({ label, value, onChange, siteId, toast }: { label: string; value: string; onChange: (v: string) => void; siteId: string; toast: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const inp = useRef<HTMLInputElement | null>(null);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast("Pictures up to 8 MB"); return; }
    setBusy(true);
    const r = await uploadAsset(siteId, f);
    setBusy(false);
    if (r.error) toast(r.error); else onChange(r.url!);
  };
  return (
    <div className="wsb-f"><span>{label}</span>
      <div className="wsb-imgf">
        <div className="wsb-imgf-th">{value ? <img src={value} alt="" /> : I.img}</div>
        <div className="wsb-imgf-b">
          <button type="button" className="wsb-mini" disabled={busy} onClick={() => inp.current?.click()}>{busy ? "Uploading…" : value ? "Change" : "Upload"}</button>
          {value && <button type="button" className="wsb-mini is-ghost" onClick={() => onChange("")}>Remove</button>}
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="…or paste a link" />
        </div>
        <input ref={inp} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- left: the look */
function StyleEditor({ site, siteId, onChange, toast }: { site: Site; siteId: string; onChange: (f: (s: Site) => Site) => void; toast: (s: string) => void }) {
  const t = site.theme;
  const setT = (p: Partial<Site["theme"]>) => onChange((s) => ({ ...s, theme: { ...s.theme, ...p } }));
  const setBrand = (p: Partial<Site["brand"]>) => onChange((s) => ({ ...s, brand: { ...s.brand, ...p } }));
  const setFoot = (p: Partial<Site["footer"]>) => onChange((s) => ({ ...s, footer: { ...s.footer, ...p } }));
  const colours: [keyof Site["theme"], string][] = [["primary", "Brand"], ["accent", "Accent"], ["bg", "Background"], ["surface", "Soft areas"], ["text", "Text"], ["muted", "Quiet text"]];
  return (
    <div className="wsb-style">
      <div className="wsb-lh"><b>Brand</b></div>
      <label className="wsb-f"><span>Name</span><input value={site.brand.name} onChange={(e) => setBrand({ name: e.target.value })} /></label>
      <label className="wsb-f"><span>Tagline</span><input value={site.brand.tagline} onChange={(e) => setBrand({ tagline: e.target.value })} /></label>
      <ImageField label="Logo" value={site.brand.logo_url} onChange={(v) => setBrand({ logo_url: v })} siteId={siteId} toast={toast} />
      <div className="wsb-lh"><b>Colours</b></div>
      <div className="wsb-cols">{colours.map(([k, l]) => (
        <label key={k} className="wsb-col"><input type="color" value={String(t[k]).length === 4 ? `#${String(t[k]).slice(1).split("").map((c) => c + c).join("")}` : String(t[k])} onChange={(e) => setT({ [k]: e.target.value } as any)} /><i style={{ background: String(t[k]) }} /><span>{l}</span></label>
      ))}</div>
      <div className="wsb-lh"><b>Type and shape</b></div>
      <label className="wsb-f"><span>Headings</span><select value={t.font_heading} onChange={(e) => setT({ font_heading: e.target.value })}>{HEADING_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
      <label className="wsb-f"><span>Text</span><select value={t.font_body} onChange={(e) => setT({ font_body: e.target.value })}>{BODY_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
      <label className="wsb-f"><span>Corners <em>{t.radius}px</em></span><input type="range" min={0} max={28} value={t.radius} onChange={(e) => setT({ radius: Number(e.target.value) })} /></label>
      <div className="wsb-lh"><b>Top bar</b></div>
      <div className="wsb-f"><span>Button</span><div className="wsb-link">
        <input value={site.nav.cta.label} placeholder="Text" onChange={(e) => onChange((s) => ({ ...s, nav: { ...s.nav, cta: { ...s.nav.cta, label: e.target.value } } }))} />
        <input value={site.nav.cta.href} placeholder="#contact" onChange={(e) => onChange((s) => ({ ...s, nav: { ...s.nav, cta: { ...s.nav.cta, href: e.target.value } } }))} />
      </div></div>
      <div className="wsb-f"><span>Links</span>
        <div className="wsb-strs">
          {site.nav.links.map((l, i) => (
            <div key={i} className="wsb-link is-row">
              <input value={l.label} placeholder="Text" onChange={(e) => onChange((s) => ({ ...s, nav: { ...s.nav, links: s.nav.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } }))} />
              <input value={l.href} placeholder="#about or /services" onChange={(e) => onChange((s) => ({ ...s, nav: { ...s.nav, links: s.nav.links.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)) } }))} />
              <button type="button" aria-label="Remove" onClick={() => onChange((s) => ({ ...s, nav: { ...s.nav, links: s.nav.links.filter((_, j) => j !== i) } }))}>{I.x}</button>
            </div>
          ))}
          <button type="button" className="wsb-mini" onClick={() => onChange((s) => ({ ...s, nav: { ...s.nav, links: [...s.nav.links, { label: "Link", href: "#" }] } }))}>{I.plus}Add a link</button>
        </div>
      </div>
      <div className="wsb-lh"><b>Footer</b></div>
      <label className="wsb-f"><span>E-mail</span><input value={site.footer.email} onChange={(e) => setFoot({ email: e.target.value })} /></label>
      <label className="wsb-f"><span>Phone</span><input value={site.footer.phone} onChange={(e) => setFoot({ phone: e.target.value })} /></label>
      <label className="wsb-f"><span>Address</span><input value={site.footer.address} onChange={(e) => setFoot({ address: e.target.value })} /></label>
      <label className="wsb-f"><span>Small print</span><input value={site.footer.text} onChange={(e) => setFoot({ text: e.target.value })} /></label>
      <div className="wsb-f"><span>Social networks</span>
        <div className="wsb-strs">
          {site.footer.socials.map((x, i) => (
            <div key={i} className="wsb-link is-row">
              <select value={x.network} onChange={(e) => setFoot({ socials: site.footer.socials.map((y, j) => (j === i ? { ...y, network: e.target.value } : y)) })}>{["linkedin", "instagram", "facebook", "x", "youtube", "tiktok"].map((n) => <option key={n} value={n}>{n}</option>)}</select>
              <input value={x.url} placeholder="https://…" onChange={(e) => setFoot({ socials: site.footer.socials.map((y, j) => (j === i ? { ...y, url: e.target.value } : y)) })} />
              <button type="button" aria-label="Remove" onClick={() => setFoot({ socials: site.footer.socials.filter((_, j) => j !== i) })}>{I.x}</button>
            </div>
          ))}
          <button type="button" className="wsb-mini" onClick={() => setFoot({ socials: [...site.footer.socials, { network: "linkedin", url: "" }] })}>{I.plus}Add a network</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- left: pages */
function PagesEditor({ site, current, onPick, onChange }: { site: Site; current: string; onPick: (id: string) => void; onChange: (f: (s: Site) => Site) => void }) {
  const setPage = (id: string, p: Partial<Site["pages"][number]>) => onChange((s) => ({ ...s, pages: s.pages.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
  return (
    <div className="wsb-list">
      <div className="wsb-lh"><b>Pages</b><em>{site.pages.length}</em></div>
      {site.pages.map((p, i) => (
        <div key={p.id} className={`wsb-pg ${p.id === current ? "is-on" : ""}`}>
          <button type="button" className="wsb-pg-open" onClick={() => onPick(p.id)}>{I.page}</button>
          <div className="wsb-pg-f">
            <input value={p.title} onChange={(e) => setPage(p.id, { title: e.target.value })} aria-label="Page name" />
            <span className="wsb-pg-path">/{i === 0 ? "" : <input value={p.path} onChange={(e) => setPage(p.id, { path: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} aria-label="Page address" />}{i === 0 && <em>home</em>}</span>
          </div>
          {i > 0 && <button type="button" className="wsb-pg-x" title="Delete this page" onClick={() => { onChange((s) => ({ ...s, pages: s.pages.filter((x) => x.id !== p.id) })); if (current === p.id) onPick(site.pages[0].id); }}>{I.trash}</button>}
        </div>
      ))}
      <button type="button" className="wsb-add" onClick={() => {
        const id = newId("p"); let path = "new-page"; let n = 2; while (site.pages.some((x) => x.path === path)) path = `new-page-${n++}`;
        onChange((s) => ({ ...s, pages: [...s.pages, { id, path, title: "New page", description: "", sections: [blankSection("hero"), blankSection("text")] }] }));
        onPick(id);
      }}>{I.plus}Add a page</button>
      <p className="wsb-fine">Link to a page from a button or the top bar with “/address”, e.g. /services.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- right: the AI */
function AiPanel({ row, draft, seo, page, section, onApply, onUndo, onClearSection }: {
  row: SiteRow; draft: Site; seo: Seo; page: string; section: Section | null;
  onApply: (d: Site, s: Seo, note: string) => void; onUndo: (d: Site, s: Seo) => void; onClearSection: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>(() => [{ id: "hi", role: "assistant", text: `Hi! Tell me what to change on ${row.name} — the words, the look, a new section or page, the SEO… Pick a section in the preview to talk about just that one.` }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);
  const send = async (q0?: string) => {
    const q = (q0 ?? text).trim();
    if (!q || busy) return;
    setText("");
    const before = { draft, seo };
    const mine: Msg = { id: newId("m"), role: "user", text: section ? `${q}` : q };
    setMsgs((m) => [...m, mine]);
    setBusy(true);
    const r = await aiEdit({
      site: draft, seo, brief: row.brief ?? {}, instruction: q, page_id: page, section_id: section?.id ?? null,
      history: msgs.filter((m) => m.id !== "hi" && !m.err).map((m) => ({ role: m.role, text: m.text })),
    });
    setBusy(false);
    if (!r.answer) { setMsgs((m) => [...m, { id: newId("m"), role: "assistant", text: r.error ?? "That didn't work.", err: true }]); return; }
    onApply(r.answer.site, r.answer.seo, q);
    setMsgs((m) => [...m, { id: newId("m"), role: "assistant", text: r.answer!.summary || "Done.", undo: before }]);
  };
  return (
    <aside className="wsb-ai">
      <header className="wsb-ai-h"><span className="wsb-ai-ico">{I.spark}</span><b>Change it with AI</b></header>
      <div className="wsb-ai-list" ref={list}>
        {msgs.map((m) => (
          <div key={m.id} className={`wsb-msg is-${m.role} ${m.err ? "is-err" : ""}`}>
            <p>{m.text}</p>
            {m.undo && <button type="button" className="wsb-undo" onClick={() => { onUndo(m.undo!.draft, m.undo!.seo); setMsgs((x) => x.map((y) => (y.id === m.id ? { ...y, undo: null, text: `${y.text} (undone)` } : y))); }}>{I.undo}Undo</button>}
          </div>
        ))}
        {busy && <div className="wsb-msg is-assistant is-busy"><span className="wsb-dots"><i /><i /><i /></span>Working on it…</div>}
      </div>
      {msgs.length <= 2 && !busy && <div className="wsb-tips">{AI_TIPS.map((t) => <button type="button" key={t} onClick={() => void send(t)}>{t}</button>)}</div>}
      <div className="wsb-ai-box">
        {section && <span className="wsb-ctx">About: <b>{SECTION_INFO[section.type].label}</b><button type="button" onClick={onClearSection} aria-label="Talk about the whole site">{I.x}</button></span>}
        <textarea rows={2} value={text} placeholder={section ? `What should change in this ${SECTION_INFO[section.type].label.toLowerCase()}?` : "e.g. Make the colours warmer and add a pricing page"}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} disabled={busy} />
        <button type="button" className="wsb-send" disabled={busy || !text.trim()} onClick={() => void send()} aria-label="Send">{I.send}</button>
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------- history */
function History({ siteId, onClose, onRestore }: { siteId: string; onClose: () => void; onRestore: (v: SiteVersion) => void }) {
  const [list, setList] = useState<SiteVersion[] | null>(null);
  useEffect(() => { void listVersions(siteId).then(setList); }, [siteId]);
  const KIND: Record<string, string> = { ai: "AI", manual: "Created", publish: "Published", restore: "Brought back" };
  return createPortal(
    <div className="wsb-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wsb-modal is-side" role="dialog" aria-label="History">
        <header><b>History</b><button type="button" className="wsb-x" onClick={onClose} aria-label="Close">{I.x}</button></header>
        <div className="wsb-hist">
          {list === null ? <p className="wsb-fine">Loading…</p> : !list.length ? <p className="wsb-fine">Nothing yet.</p> : list.map((v) => (
            <div key={v.id} className={`wsb-hi k-${v.kind}`}>
              <span className="wsb-hi-k">{KIND[v.kind] ?? v.kind}</span>
              <div><b>{v.note || "—"}</b><em>{fmtWhen(v.created_at)}</em></div>
              <button type="button" className="wsb-mini" onClick={() => onRestore(v)}>Bring back</button>
            </div>
          ))}
        </div>
      </div>
    </div>, document.body);
}

/* ---------------------------------------------------------------- full-screen preview */
function FullPreview({ site, slug, onClose }: { site: Site; slug: string; onClose: () => void }) {
  const [pageId, setPageId] = useState(site.pages[0].id);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return createPortal(
    <div className="wsb-full">
      <div className="wsb-full-bar"><span>{I.globe}{siteHost(slug)}</span><em>Preview of the draft</em><button type="button" className="wsb-x" onClick={onClose} aria-label="Close">{I.x}</button></div>
      <div className="wsb-full-scroll"><SiteRender site={site} pageId={pageId} contained onNavigate={(p) => { const x = site.pages.find((y) => y.path === p); if (x) setPageId(x.id); }} /></div>
    </div>, document.body);
}

/* ---------------------------------------------------------------- settings */
function Settings({ row, seo, siteId, toast, onClose, onSeo, onMeta, onNew, onDelete }: {
  row: SiteRow; seo: Seo; siteId: string; toast: (s: string) => void; onClose: () => void; onSeo: (s: Seo) => void;
  onMeta: (m: Partial<SiteRow>) => void; onNew: () => void; onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(row.name);
  const [slug, setSlug] = useState(row.slug);
  const [slugOk, setSlugOk] = useState<boolean | null>(true);
  const [kw, setKw] = useState(seo.keywords.join(", "));
  const [busy, setBusy] = useState(false);
  const [askDel, setAskDel] = useState(false);
  useEffect(() => {
    if (slug === row.slug) { setSlugOk(true); return; }
    if (!slugValid(slug)) { setSlugOk(false); return; }
    let off = false; setSlugOk(null);
    const t = window.setTimeout(() => { void slugFree(slug, row.id).then((ok) => { if (!off) setSlugOk(ok); }); }, 350);
    return () => { off = true; window.clearTimeout(t); };
  }, [slug, row.slug, row.id]);
  const saveMeta = async () => {
    if (!slugOk) return;
    setBusy(true);
    const e = await saveSite(row.id, { name: name.trim() || row.name, slug });
    setBusy(false);
    if (e) { toast(e); return; }
    onMeta({ name: name.trim() || row.name, slug }); toast("Saved");
  };
  const desc = seo.description.length;
  const live = row.status === "live";
  const url = siteUrl(row.slug);
  return createPortal(
    <div className="wsb-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wsb-modal is-set" role="dialog" aria-label="Website settings">
        <header><b>Website settings</b><button type="button" className="wsb-x" onClick={onClose} aria-label="Close">{I.x}</button></header>
        <div className="wsb-set">
          <section>
            <h4>Address</h4>
            <div className="wsb-live">
              <span className={`wsb-live-dot ${live ? "is-on" : ""}`} />
              <div><b>{live ? "Live" : row.status === "paused" ? "Offline" : "Not published yet"}</b>
                <a href={url} target="_blank" rel="noreferrer">{siteHost(row.slug)}{I.ext}</a>
                {row.published_at && <em>Published {fmtWhen(row.published_at)}</em>}</div>
              {live && <button type="button" className="wsb-mini is-ghost" onClick={async () => { const e = await setStatus(row.id, "paused"); if (e) toast(e); else { onMeta({ status: "paused" }); toast("Taken offline"); } }}>Take offline</button>}
              {row.status === "paused" && row.published && <button type="button" className="wsb-mini" onClick={async () => { const e = await setStatus(row.id, "live"); if (e) toast(e); else { onMeta({ status: "live" }); toast("Back online"); } }}>Put back online</button>}
            </div>
            <div className="wsb-f2">
              <label className="wsb-f"><span>Website name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
              <div className="wsb-f"><span>Address</span>
                <div className={`wsb-slug ${slugOk === false ? "is-bad" : slugOk && slug !== row.slug ? "is-ok" : ""}`}>
                  <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
                  <em>{SITES_DOMAIN ? `.${SITES_DOMAIN}` : ""}</em>
                </div>
              </div>
            </div>
            <button type="button" className="wsb-btn is-dark" disabled={busy || !slugOk || (name === row.name && slug === row.slug)} onClick={() => void saveMeta()}>{busy ? "Saving…" : "Save"}</button>
            {slug !== row.slug && live && <p className="wsb-fine is-warn">Changing the address moves the live site: the old address stops working.</p>}
          </section>

          <section>
            <h4>Search engines (SEO)</h4>
            <div className="wsb-serp">
              <span>{siteHost(row.slug)}</span>
              <b>{seo.title || row.name}</b>
              <p>{seo.description || "Add a description: it's the line Google shows under your title."}</p>
            </div>
            <label className="wsb-f"><span>Title <em>{seo.title.length}/60</em></span><input value={seo.title} maxLength={70} onChange={(e) => onSeo({ ...seo, title: e.target.value })} /></label>
            <label className="wsb-f"><span>Description <em className={desc > 160 || (desc && desc < 110) ? "is-warn" : ""}>{desc}/160</em></span><AutoArea value={seo.description} onChange={(v) => onSeo({ ...seo, description: v.slice(0, 200) })} /></label>
            <div className="wsb-f2">
              <label className="wsb-f"><span>Keywords</span><input value={kw} onChange={(e) => setKw(e.target.value)} onBlur={() => onSeo({ ...seo, keywords: kw.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 15) })} placeholder="comma, separated" /></label>
              <label className="wsb-f"><span>Language</span><select value={seo.lang} onChange={(e) => onSeo({ ...seo, lang: e.target.value })}>{LANGS.map((l) => <option key={l.v} value={l.v}>{l.l}</option>)}</select></label>
            </div>
            <ImageField label="Picture when shared (LinkedIn, WhatsApp…)" value={seo.og_image ?? ""} onChange={(v) => onSeo({ ...seo, og_image: v })} siteId={siteId} toast={toast} />
            <p className="wsb-fine">Saved with the draft; it goes live with the next Publish.</p>
          </section>

          <section className="is-soon">
            <h4>Your own domain <i>Soon</i></h4>
            <p className="wsb-fine">Put the site on www.yourcompany.com: you'll add one DNS record and we take care of the certificate.</p>
            <div className="wsb-f"><input disabled placeholder="www.yourcompany.com" /></div>
          </section>
          <section className="is-soon">
            <h4>SEO budget <i>Soon</i></h4>
            <p className="wsb-fine">Set a monthly amount and the AI keeps your site climbing: new pages for what people search, better texts, and ads on Google when it's worth it — with a report every month.</p>
            <div className="wsb-budget"><input type="range" disabled min={0} max={2000} defaultValue={300} /><b>300 € / month</b></div>
          </section>

          <section className="is-danger">
            <div className="wsb-row">
              <button type="button" className="wsb-mini is-ghost" onClick={onNew}>{I.plus}Another website</button>
              {!askDel ? <button type="button" className="wsb-mini is-red" onClick={() => setAskDel(true)}>{I.trash}Delete this website</button>
                : <span className="wsb-confirm">Delete {row.name} and its history for good? <button type="button" className="wsb-mini is-red" onClick={() => void onDelete()}>Delete</button><button type="button" className="wsb-mini is-ghost" onClick={() => setAskDel(false)}>Keep it</button></span>}
            </div>
          </section>
        </div>
      </div>
    </div>, document.body);
}

