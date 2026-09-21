/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import Select from "../../framework/Select";
import { loadProposalTemplateRow, saveProposalTemplate, uploadBrandAsset, generateProposal } from "../sales/proposalApi";
import { defaultSlideTitle, type ProposalData, type ProposalTemplate, type TemplateSection } from "../sales/proposalGen";
import "./ProposalTemplateEditor.css";

/**
 * Settings → Proposal template.
 * One default template per tenant (proposal_templates, is_default = true):
 * brand identity, colours, fonts, images, closing contact, per-slide copy and
 * toggles, and commercial terms. Everything here feeds proposalGen directly.
 */

type Tab = "brand" | "look" | "images" | "contact" | "slides" | "terms";
type Colors = ProposalTemplate["brand"]["colors"];
type AssetKey = "logoLight" | "logoDark" | "bgCover" | "bgLight";

const TABS: { key: Tab; label: string }[] = [
  { key: "brand", label: "Company" },
  { key: "look", label: "Colours & fonts" },
  { key: "images", label: "Logos & backgrounds" },
  { key: "contact", label: "Closing contact" },
  { key: "slides", label: "Slides" },
  { key: "terms", label: "Terms" },
];

const SECTIONS: { key: string; label: string; hint: string; eyebrow: string }[] = [
  { key: "cover", label: "Cover", hint: "Your company, the client, the date and both logos.", eyebrow: "Propuesta comercial" },
  { key: "summary", label: "Executive summary", hint: "Opening message and the three-step structure.", eyebrow: "Resumen ejecutivo" },
  { key: "context", label: "Context", hint: "Up to 4 key figures and the current situation.", eyebrow: "01 · Contexto" },
  { key: "diagnosis", label: "Diagnosis", hint: "Up to 3 columns of current limitations.", eyebrow: "02 · Diagnóstico" },
  { key: "solution", label: "Recommendation", hint: "Up to 4 rows: today → with you → result.", eyebrow: "03 · Recomendación" },
  { key: "scope", label: "Scope", hint: "Up to 6 numbered blocks.", eyebrow: "04 · Alcance" },
  { key: "investment", label: "Investment (licence)", hint: "Shown when the deal has products.", eyebrow: "05 · Inversión" },
  { key: "services", label: "Services", hint: "Shown when the deal has services.", eyebrow: "06 · Servicios" },
  { key: "references", label: "References", hint: "Up to 3 client success stories.", eyebrow: "07 · Referencias" },
  { key: "conditions", label: "Conditions", hint: "Built from the Terms tab.", eyebrow: "08 · Anexos" },
  { key: "closing", label: "Closing", hint: "Thank-you slide with the closing contact.", eyebrow: "" },
];

const FONTS = ["Arial", "Calibri", "Helvetica", "Segoe UI", "Verdana", "Tahoma", "Trebuchet MS", "Georgia", "Garamond", "Times New Roman"];

const COLOR_META: { key: keyof Colors; label: string; hint: string }[] = [
  { key: "primary", label: "Primary", hint: "Titles, cover and closing background" },
  { key: "accent", label: "Accent", hint: "Eyebrows, numbered icons, highlights" },
  { key: "mint", label: "Soft accent", hint: "Light highlights on dark areas" },
  { key: "ink", label: "Text", hint: "Body copy" },
  { key: "muted", label: "Secondary text", hint: "Footers, captions" },
  { key: "light", label: "Card background", hint: "Boxes on content slides" },
];

const ASSET_META: { key: AssetKey; label: string; hint: string; wide?: boolean; dark?: boolean }[] = [
  { key: "logoLight", label: "Logo for dark backgrounds", hint: "Cover and closing. A white or light logo.", dark: true },
  { key: "logoDark", label: "Logo for light backgrounds", hint: "Footer of every content slide." },
  { key: "bgCover", label: "Cover background", hint: "Also used on the closing slide. 16:9, ideally 1920×1080.", wide: true, dark: true },
  { key: "bgLight", label: "Content slide background", hint: "Subtle texture behind content slides. 16:9.", wide: true },
];

const DEFAULT_COLORS: Colors = { primary: "0A6F4D", accent: "12B57F", mint: "86EFC0", ink: "0B241A", muted: "5A7D6D", light: "F2F8F5" };

const LIMITS = { stats: 4, diagCols: 3, diagItems: 5, solution: 4, scope: 6, references: 3, included: 6, considerations: 3 };

/* ─────────────── helpers ─────────────── */

const imgSrc = (v?: string) => (!v ? "" : /^(https?:|data:|blob:)/i.test(v) ? v : `data:${v}`);
const hexOk = (h: string) => /^[0-9a-f]{6}$/i.test(h);
const toHex = (h: string) => h.replace(/^#/, "").toUpperCase();
const linesOf = (a: any) => (Array.isArray(a) ? a.join("\n") : "");
const fromLines = (s: string) => s.split("\n"); // kept raw while typing; the generator drops blanks
const countLines = (a: any) => (Array.isArray(a) ? a.filter((x) => String(x ?? "").trim()).length : 0);

function normalizeSections(existing: TemplateSection[]): TemplateSection[] {
  const byKey = new Map((existing ?? []).map((s) => [s.key, s]));
  const known = SECTIONS.map((m) => ({ enabled: true, ...(byKey.get(m.key) ?? {}), key: m.key }));
  const extra = (existing ?? []).filter((s) => !SECTIONS.some((m) => m.key === s.key));
  return [...known, ...extra];
}

function sampleData(): ProposalData {
  const today = new Date().toISOString().slice(0, 10);
  return {
    client: { name: "Cliente Ejemplo", legalName: "Cliente Ejemplo, S.A.", vat: "A00000000", address: "Calle Mayor 1, 28001 Madrid", contactName: "Laura Martín", contactRole: "CFO", contactEmail: "laura@ejemplo.com" },
    deal: { title: "Propuesta de ejemplo", date: today, subtitle: "Vista previa de la plantilla" },
    products: [{ name: "Licencia", tier: "Business", recurring: true, period: "yearly", termYears: 3, unitPrice: 12000, qty: 1, rows: [{ label: "Suscripción anual", amount: 12000 }], discount: 1500, total: 34500 }],
    services: [{
      name: "Implantación", unit: "day", days: 20, rate: 850, discount: 0, total: 17000, rows: [],
      phases: [
        { name: "Análisis", bullets: ["Revisión de procesos", "Definición de requisitos"], days: 4 },
        { name: "Configuración", bullets: ["Parametrización", "Integraciones"], days: 10 },
        { name: "Formación", bullets: ["Sesiones con el equipo"], days: 4 },
        { name: "Arranque", bullets: ["Acompañamiento en el go-live"], days: 2 },
      ],
      roles: [{ name: "Senior Consultant", days: 18, rate: 850 }, { name: "Project Manager", days: 2, rate: 900 }],
    }],
    totals: { products: 34500, services: 17000, discount: 1500, total: 51500 },
  };
}

/* ─────────────── small field components ─────────────── */

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`pte-field ${wide ? "is-wide" : ""}`}>
      <span className="pte-flabel">{label}</span>
      {children}
      {hint && <span className="pte-fhint">{hint}</span>}
    </label>
  );
}
function Text({ value, onChange, placeholder, type = "text" }: { value: any; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return <input className="pte-in" type={type} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}
function Area({ value, onChange, placeholder, rows = 3 }: { value: any; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return <textarea className="pte-in pte-area" rows={rows} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}
function Num({ value, onChange, suffix, step = 1 }: { value: any; onChange: (v: number | undefined) => void; suffix?: string; step?: number }) {
  return (
    <div className="pte-num">
      <input className="pte-in" type="number" step={step} min={0} value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
      {suffix && <span>{suffix}</span>}
    </div>
  );
}
function Lines({ value, onChange, max, placeholder }: { value: any; onChange: (v: string[]) => void; max: number; placeholder?: string }) {
  const n = countLines(value);
  return (
    <div className="pte-lines">
      <Area rows={Math.min(8, Math.max(3, (Array.isArray(value) ? value.length : 0) + 1))} value={linesOf(value)} placeholder={placeholder} onChange={(v) => onChange(fromLines(v))} />
      <span className={`pte-fhint ${n > max ? "is-warn" : ""}`}>One per line · {n}/{max}{n > max ? ` — only the first ${max} are shown` : ""}</span>
    </div>
  );
}

function Repeater<T extends Record<string, any>>({ items, max, blank, addLabel, onChange, render }: {
  items: T[] | undefined; max: number; blank: T; addLabel: string;
  onChange: (next: T[]) => void; render: (item: T, set: (patch: Partial<T>) => void, i: number) => React.ReactNode;
}) {
  const list = items ?? [];
  return (
    <div className="pte-rep">
      {list.map((it, i) => (
        <div className="pte-rep-item" key={i}>
          <div className="pte-rep-head">
            <span className="pte-rep-n">{String(i + 1).padStart(2, "0")}</span>
            <button type="button" className="pte-icon-btn" aria-label="Remove" onClick={() => onChange(list.filter((_, j) => j !== i))}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          <div className="pte-grid">{render(it, (patch) => onChange(list.map((x, j) => (j === i ? { ...x, ...patch } : x))), i)}</div>
        </div>
      ))}
      {list.length < max && (
        <button type="button" className="pte-add" onClick={() => onChange([...list, { ...blank }])}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          {addLabel} <span>{list.length}/{max}</span>
        </button>
      )}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`pte-switch ${on ? "is-on" : ""}`}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}>
      <span />
    </button>
  );
}

/* ─────────────── preview ─────────────── */

function Preview({ brand, activeKey, sections }: { brand: any; activeKey: string | null; sections: TemplateSection[] }) {
  const C: Colors = { ...DEFAULT_COLORS, ...(brand.colors ?? {}) };
  const hx = (k: keyof Colors) => `#${hexOk(C[k]) ? C[k] : DEFAULT_COLORS[k]}`;
  const heading = `${brand.fonts?.heading || "Arial"}, Arial, sans-serif`;
  const body = `${brand.fonts?.body || "Calibri"}, Calibri, Arial, sans-serif`;
  const company = brand.company || "Tu empresa";
  const meta = SECTIONS.find((s) => s.key === activeKey && !["cover", "closing"].includes(s.key)) ?? SECTIONS[1];
  const sec = sections.find((s) => s.key === meta.key);
  const title = String(sec?.title ?? "").trim() || defaultSlideTitle(meta.key, company);
  const a = brand.assets ?? {};

  return (
    <div className="pte-preview">
      <div className="pte-prev-item">
      <div className="pte-prev-label">Cover</div>
      <div className="pte-slide" style={{ background: a.bgCover ? `center / cover url("${imgSrc(a.bgCover)}")` : hx("primary") }}>
        <div className="pte-s-eyebrow" style={{ color: hx("accent"), fontFamily: heading, top: "34%" }}>PROPUESTA COMERCIAL</div>
        <div className="pte-s-cover-title" style={{ fontFamily: heading }}>{company} · Cliente</div>
        <div className="pte-s-cover-date" style={{ fontFamily: body }}>21 de septiembre de 2026</div>
        <div className="pte-s-cover-bar" style={{ background: hx("primary") }}>
          {a.logoLight ? <img src={imgSrc(a.logoLight)} alt="" /> : <span style={{ fontFamily: heading }}>{company}</span>}
        </div>
      </div>
      </div>

      <div className="pte-prev-item">
      <div className="pte-prev-label">{meta.label}</div>
      <div className="pte-slide" style={{ background: a.bgLight ? `center / cover url("${imgSrc(a.bgLight)}")` : "#fff" }}>
        <div className="pte-s-eyebrow" style={{ color: hx("accent"), fontFamily: heading }}>{meta.eyebrow.toUpperCase()}</div>
        <div className="pte-s-title" style={{ color: hx("primary"), fontFamily: heading }}>{title}</div>
        <div className="pte-s-cards">
          {[0, 1, 2].map((i) => (
            <div key={i} className="pte-s-card" style={{ background: hx("light") }}>
              <span className="pte-s-dot" style={{ background: hx("accent"), fontFamily: heading }}>{i + 1}</span>
              <span className="pte-s-line" style={{ background: hx("ink") }} />
              <span className="pte-s-line is-short" style={{ background: hx("muted") }} />
            </div>
          ))}
        </div>
        <div className="pte-s-footer" style={{ color: hx("muted"), fontFamily: body }}>
          <span>{brand.footer || `${company} | Confidential`}</span>
          {a.logoDark && <img src={imgSrc(a.logoDark)} alt="" />}
        </div>
      </div>
      </div>
      <p className="pte-prev-note">Approximate preview. Download a sample to see the real deck.</p>
    </div>
  );
}

/* ─────────────── page ─────────────── */

export default function ProposalTemplateEditor({ canManage }: { canManage: boolean }) {
  const [loading, setLoading] = useState(true);
  const [id, setId] = useState<string | null>(null);
  const [brand, setBrand] = useState<any>({ company: "", colors: DEFAULT_COLORS, fonts: { heading: "Arial", body: "Calibri" }, assets: {} });
  const [sections, setSections] = useState<TemplateSection[]>(normalizeSections([]));
  const [terms, setTerms] = useState<any>({});
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("brand");
  const [openSec, setOpenSec] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [uploading, setUploading] = useState<AssetKey | null>(null);
  const [sampling, setSampling] = useState<"pptx" | "pdf" | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    loadProposalTemplateRow()
      .then((row) => {
        if (row) {
          setId(row.id);
          setBrand({ ...row.brand, colors: { ...DEFAULT_COLORS, ...(row.brand?.colors ?? {}) }, fonts: { heading: "Arial", body: "Calibri", ...(row.brand?.fonts ?? {}) }, assets: row.brand?.assets ?? {} });
          setSections(normalizeSections(row.sections));
          setTerms(row.terms ?? {});
        }
      })
      .catch((e) => setFlash({ kind: "err", text: `Couldn't load the template: ${e.message ?? e}` }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!flash || flash.kind === "err") return;
    const t = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(t);
  }, [flash]);

  const touch = () => setDirty(true);
  const setB = (patch: any) => { setBrand((b: any) => ({ ...b, ...patch })); touch(); };
  const setColor = (k: keyof Colors, v: string) => { setBrand((b: any) => ({ ...b, colors: { ...b.colors, [k]: toHex(v) } })); touch(); };
  const setFont = (k: "heading" | "body", v: string) => { setBrand((b: any) => ({ ...b, fonts: { ...b.fonts, [k]: v } })); touch(); };
  const setContact = (patch: any) => { setBrand((b: any) => ({ ...b, contact: { name: "", ...(b.contact ?? {}), ...patch } })); touch(); };
  const setAsset = (k: AssetKey, v: string | undefined) => { setBrand((b: any) => ({ ...b, assets: { ...(b.assets ?? {}), [k]: v } })); touch(); };
  const setSec = (key: string, patch: Partial<TemplateSection>) => { setSections((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s))); touch(); };
  const setT = (patch: any) => { setTerms((t: any) => ({ ...t, ...patch })); touch(); };
  const sec = (key: string) => sections.find((s) => s.key === key) ?? ({ key, enabled: true } as TemplateSection);

  // Blank lines are kept while typing; strip them from what gets saved or generated.
  const cleanTerms = (t: any) => ({ ...t, notes: (t.notes ?? []).map((x: string) => x.trim()).filter(Boolean) });

  const template = useMemo<ProposalTemplate>(() => {
    const assets = Object.fromEntries(Object.entries(brand.assets ?? {}).filter(([, v]) => !!v));
    const contact = brand.contact?.name?.trim() ? brand.contact : undefined;
    return { brand: { ...brand, company: brand.company || "Tu empresa", assets, contact }, sections, terms: cleanTerms(terms) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand, sections, terms]);

  const badColors = COLOR_META.filter((c) => !hexOk(brand.colors?.[c.key] ?? ""));

  const save = async () => {
    if (badColors.length) { setTab("look"); setFlash({ kind: "err", text: `Fix the colour code for: ${badColors.map((c) => c.label).join(", ")}.` }); return; }
    if (!String(brand.company ?? "").trim()) { setTab("brand"); setFlash({ kind: "err", text: "Add your company name — it appears on every slide." }); return; }
    setSaving(true);
    try {
      const assets = Object.fromEntries(Object.entries(brand.assets ?? {}).filter(([, v]) => !!v));
      const newId = await saveProposalTemplate(id, { brand: { ...brand, assets }, sections, terms: cleanTerms(terms) });
      setId(newId); setDirty(false);
      setFlash({ kind: "ok", text: "Template saved. New proposals will use it." });
    } catch (e: any) {
      setFlash({ kind: "err", text: `Couldn't save: ${e.message ?? e}` });
    } finally { setSaving(false); }
  };

  const upload = async (k: AssetKey, file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) { setFlash({ kind: "err", text: "Use a PNG, JPG or WebP image." }); return; }
    setUploading(k);
    try {
      const r = await uploadBrandAsset(file, k);
      setAsset(k, r.value);
      setFlash(r.inline
        ? { kind: "info", text: "Image added. It's stored inside the template because Storage uploads aren't enabled yet." }
        : { kind: "ok", text: "Image uploaded. Remember to save." });
    } catch (e: any) {
      setFlash({ kind: "err", text: e.message ?? String(e) });
    } finally {
      setUploading(null);
      const el = fileRefs.current[k]; if (el) el.value = "";
    }
  };

  const sample = async (kind: "pptx" | "pdf") => {
    setSampling(kind);
    try { await generateProposal(kind, sampleData(), template); }
    catch (e: any) { setFlash({ kind: "err", text: `Couldn't build the sample: ${e.message ?? e}` }); }
    finally { setSampling(null); }
  };

  if (loading) return <div className="pte"><div className="pte-loading">Loading template…</div></div>;

  const company = brand.company || "Tu empresa";
  const activePreviewKey = tab === "slides" ? openSec : null;

  return (
    <div className="pte">
      <header className="pte-head">
        <div>
          <h2>Proposal template</h2>
          <p>How every proposal deck and order form looks, and the copy it starts from.</p>
        </div>
        <div className="pte-head-actions">
          {dirty && <span className="pte-dirty"><i />Unsaved changes</span>}
          <button className="pte-btn" disabled={!!sampling} onClick={() => sample("pptx")}>{sampling === "pptx" ? "Building…" : "Sample PPT"}</button>
          <button className="pte-btn" disabled={!!sampling} onClick={() => sample("pdf")}>{sampling === "pdf" ? "Building…" : "Sample PDF"}</button>
          {canManage && <button className="pte-btn is-primary" disabled={saving || !dirty} onClick={save}>{saving ? "Saving…" : "Save template"}</button>}
        </div>
      </header>

      {flash && (
        <div className={`pte-flash is-${flash.kind}`} role={flash.kind === "err" ? "alert" : "status"}>
          <span>{flash.text}</span>
          <button onClick={() => setFlash(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {!canManage && <div className="pte-flash is-info"><span>You can view the template and download samples. Only managers can edit it.</span></div>}

      <div className="pte-body">
        <nav className="pte-nav">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? "is-on" : ""} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === "look" && badColors.length > 0 && <i className="pte-nav-warn" />}
            </button>
          ))}
        </nav>

        <fieldset className="pte-main" disabled={!canManage}>
          {tab === "brand" && (
            <section className="pte-card">
              <h3>Company</h3>
              <p className="pte-card-sub">Shown on the cover, the footers and the order form.</p>
              <div className="pte-grid">
                <Field label="Company name" hint="Used in titles, e.g. “Cómo Empower elimina…”"><Text value={brand.company} onChange={(v) => setB({ company: v })} placeholder="Empower" /></Field>
                <Field label="Legal name" hint="Order form signature block."><Text value={brand.legalName} onChange={(v) => setB({ legalName: v })} placeholder="Empower Solutions, S.L." /></Field>
                <Field label="VAT number"><Text value={brand.vat} onChange={(v) => setB({ vat: v })} placeholder="B12345678" /></Field>
                <Field label="Website" hint="Closing slide."><Text value={brand.web} onChange={(v) => setB({ web: v })} placeholder="www.empower.com" /></Field>
                <Field label="Address" wide><Text value={brand.address} onChange={(v) => setB({ address: v })} placeholder="Calle Serrano 1, 28001 Madrid" /></Field>
                <Field label="Footer text" wide hint="Bottom-left of every content slide."><Text value={brand.footer} onChange={(v) => setB({ footer: v })} placeholder={`${company} | Confidential`} /></Field>
              </div>
            </section>
          )}

          {tab === "look" && (
            <>
              <section className="pte-card">
                <h3>Colours</h3>
                <p className="pte-card-sub">Six-digit hex codes, as in your brand guide.</p>
                <div className="pte-colors">
                  {COLOR_META.map((c) => {
                    const v = brand.colors?.[c.key] ?? "";
                    const ok = hexOk(v);
                    return (
                      <div key={c.key} className={`pte-color ${ok ? "" : "is-bad"}`}>
                        <label className="pte-swatch" style={{ background: ok ? `#${v}` : "transparent" }}>
                          <input type="color" value={ok ? `#${v}` : "#000000"} onChange={(e) => setColor(c.key, e.target.value)} aria-label={`${c.label} colour`} />
                        </label>
                        <div className="pte-color-txt">
                          <span className="pte-flabel">{c.label}</span>
                          <div className="pte-hex"><span>#</span><input value={v} maxLength={7} onChange={(e) => setColor(c.key, e.target.value)} /></div>
                          <span className="pte-fhint">{ok ? c.hint : "Use 6 characters, e.g. 0A6F4D"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
              <section className="pte-card">
                <h3>Fonts</h3>
                <p className="pte-card-sub">Fonts installed on every computer, so the deck looks the same when your client opens it.</p>
                <div className="pte-grid">
                  <Field label="Headings">
                    <div className="pte-sel"><Select value={brand.fonts?.heading ?? "Arial"} onChange={(v) => setFont("heading", v)} options={FONTS.map((f) => ({ value: f, label: f }))} /></div>
                    <span className="pte-font-demo" style={{ fontFamily: brand.fonts?.heading }}>Propuesta comercial</span>
                  </Field>
                  <Field label="Body text">
                    <div className="pte-sel"><Select value={brand.fonts?.body ?? "Calibri"} onChange={(v) => setFont("body", v)} options={FONTS.map((f) => ({ value: f, label: f }))} /></div>
                    <span className="pte-font-demo is-body" style={{ fontFamily: brand.fonts?.body }}>Esta propuesta plantea cómo lo hacemos posible.</span>
                  </Field>
                </div>
              </section>
            </>
          )}

          {tab === "images" && (
            <section className="pte-card">
              <h3>Logos & backgrounds</h3>
              <p className="pte-card-sub">PNG with transparency works best for logos. The client's logo is added per deal.</p>
              <div className="pte-assets">
                {ASSET_META.map((m) => {
                  const v = brand.assets?.[m.key];
                  return (
                    <div key={m.key} className={`pte-asset ${m.wide ? "is-wide" : ""}`}>
                      <div className={`pte-asset-img ${m.dark ? "is-dark" : ""}`} style={m.dark && !v ? { background: `#${hexOk(brand.colors?.primary) ? brand.colors.primary : DEFAULT_COLORS.primary}` } : undefined}>
                        {v ? <img src={imgSrc(v)} alt="" className={m.wide ? "is-cover" : ""} /> : <span>No image</span>}
                        {uploading === m.key && <div className="pte-asset-busy">Uploading…</div>}
                      </div>
                      <div className="pte-asset-meta">
                        <span className="pte-flabel">{m.label}</span>
                        <span className="pte-fhint">{m.hint}</span>
                        <div className="pte-asset-actions">
                          <input ref={(el) => { fileRefs.current[m.key] = el; }} type="file" accept="image/png,image/jpeg,image/webp" hidden
                            onChange={(e) => upload(m.key, e.target.files?.[0])} />
                          <button type="button" className="pte-btn is-sm" onClick={() => fileRefs.current[m.key]?.click()}>{v ? "Replace" : "Upload"}</button>
                          {v && <button type="button" className="pte-btn is-sm is-ghost" onClick={() => setAsset(m.key, undefined)}>Remove</button>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {tab === "contact" && (
            <section className="pte-card">
              <h3>Closing contact</h3>
              <p className="pte-card-sub">Appears on the thank-you slide and signs the order form. Leave the name empty to hide it.</p>
              <div className="pte-grid">
                <Field label="Name"><Text value={brand.contact?.name} onChange={(v) => setContact({ name: v })} placeholder="Basilio García" /></Field>
                <Field label="Role"><Text value={brand.contact?.role} onChange={(v) => setContact({ role: v })} placeholder="Managing Director" /></Field>
                <Field label="Email"><Text type="email" value={brand.contact?.email} onChange={(v) => setContact({ email: v })} placeholder="basilio@empower.com" /></Field>
                <Field label="Phone"><Text value={brand.contact?.phone} onChange={(v) => setContact({ phone: v })} placeholder="+34 600 000 000" /></Field>
              </div>
            </section>
          )}

          {tab === "slides" && (
            <section className="pte-card is-flush">
              <div className="pte-card-pad">
                <h3>Slides</h3>
                <p className="pte-card-sub">Switch slides on or off and write the copy each one starts from. Deal-specific data always wins when a deal has it.</p>
              </div>
              <div className="pte-secs">
                {SECTIONS.map((m) => {
                  const s = sec(m.key);
                  const open = openSec === m.key;
                  return (
                    <div key={m.key} className={`pte-sec ${open ? "is-open" : ""} ${s.enabled === false ? "is-off" : ""}`}>
                      <div className="pte-sec-head" role="button" tabIndex={0}
                        onClick={() => setOpenSec(open ? null : m.key)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenSec(open ? null : m.key); } }}>
                        <Toggle on={s.enabled !== false} label={`Include ${m.label}`} onChange={(v) => setSec(m.key, { enabled: v })} />
                        <div className="pte-sec-txt">
                          <span className="pte-sec-name">{m.label}</span>
                          <span className="pte-sec-hint">{m.hint}</span>
                        </div>
                        <svg className="pte-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                      </div>
                      {open && (
                        <div className="pte-sec-body">
                          {m.key !== "cover" && (
                            <Field label="Slide title" wide hint={m.key === "closing" ? "Leave empty to use the default. Keep it to a few words — it's large on the slide." : "Leave empty to use the default."}>
                              <Text value={s.title} onChange={(v) => setSec(m.key, { title: v })} placeholder={defaultSlideTitle(m.key, company)} />
                            </Field>
                          )}
                          {m.key === "cover" && <p className="pte-note">The cover has no editable copy: it uses your company name, the client, the date and the logos.</p>}

                          {m.key === "summary" && (
                            <Field label="Opening paragraph" wide hint="Leave empty for the default text, which mentions the client by name.">
                              <Area rows={4} value={s.intro} onChange={(v) => setSec("summary", { intro: v })} placeholder={`[Cliente] necesita un modelo de trabajo moderno, auditable y escalable. Esta propuesta plantea cómo ${company} lo hace posible…`} />
                            </Field>
                          )}

                          {m.key === "context" && (
                            <>
                              <div className="pte-sublabel">Key figures</div>
                              <Repeater items={s.stats} max={LIMITS.stats} blank={{ value: "", label: "", sub: "" }} addLabel="Add figure"
                                onChange={(v) => setSec("context", { stats: v })}
                                render={(it, set) => (<>
                                  <Field label="Figure"><Text value={it.value} onChange={(v) => set({ value: v })} placeholder="+40 %" /></Field>
                                  <Field label="Label"><Text value={it.label} onChange={(v) => set({ label: v })} placeholder="Tiempo de cierre" /></Field>
                                  <Field label="Detail" wide><Text value={it.sub} onChange={(v) => set({ sub: v })} placeholder="Media del sector en grupos similares" /></Field>
                                </>)} />
                              <Field label="Current situation" wide>
                                <Area rows={4} value={s.situation} onChange={(v) => setSec("context", { situation: v })} placeholder="Describe the typical situation of a client before working with you." />
                              </Field>
                            </>
                          )}

                          {m.key === "diagnosis" && (
                            <Repeater items={s.columns} max={LIMITS.diagCols} blank={{ title: "", items: [] as string[] }} addLabel="Add column"
                              onChange={(v) => setSec("diagnosis", { columns: v })}
                              render={(it, set) => (<>
                                <Field label="Column title" wide><Text value={it.title} onChange={(v) => set({ title: v })} placeholder="Procesos manuales" /></Field>
                                <Field label="Points" wide><Lines value={it.items} max={LIMITS.diagItems} onChange={(v) => set({ items: v })} placeholder={"Consolidación en Excel\nErrores de conciliación"} /></Field>
                              </>)} />
                          )}

                          {m.key === "solution" && (
                            <Repeater items={s.rows} max={LIMITS.solution} blank={{ from: "", to: "", result: "" }} addLabel="Add row"
                              onChange={(v) => setSec("solution", { rows: v })}
                              render={(it, set) => (<>
                                <Field label="Today"><Text value={it.from} onChange={(v) => set({ from: v })} placeholder="Cierre en 15 días" /></Field>
                                <Field label={`With ${company}`}><Text value={it.to} onChange={(v) => set({ to: v })} placeholder="Consolidación automática" /></Field>
                                <Field label="Result" wide><Text value={it.result} onChange={(v) => set({ result: v })} placeholder="Cierre en 5 días" /></Field>
                              </>)} />
                          )}

                          {m.key === "scope" && (
                            <Repeater items={s.items} max={LIMITS.scope} blank={{ title: "", text: "" }} addLabel="Add block"
                              onChange={(v) => setSec("scope", { items: v })}
                              render={(it, set) => (<>
                                <Field label="Title" wide><Text value={it.title} onChange={(v) => set({ title: v })} placeholder="Control en tiempo real" /></Field>
                                <Field label="Text" wide><Area rows={2} value={it.text} onChange={(v) => set({ text: v })} /></Field>
                              </>)} />
                          )}

                          {m.key === "investment" && (
                            <Field label="What's included" wide hint="Leave empty for the default list.">
                              <Lines value={s.included} max={LIMITS.included} onChange={(v) => setSec("investment", { included: v })} placeholder={"Solución 100% cloud\nUsuarios ilimitados"} />
                            </Field>
                          )}

                          {m.key === "services" && (
                            <Field label="Considerations" wide hint="Leave empty for the default text (estimate accuracy, minimum billable unit, extra days).">
                              <Lines value={s.considerations} max={LIMITS.considerations} onChange={(v) => setSec("services", { considerations: v })} />
                            </Field>
                          )}

                          {m.key === "references" && (
                            <Repeater items={s.items} max={LIMITS.references} blank={{ company: "", stat: "", statLabel: "", before: "", quote: "", author: "" }} addLabel="Add reference"
                              onChange={(v) => setSec("references", { items: v })}
                              render={(it, set) => (<>
                                <Field label="Client"><Text value={it.company} onChange={(v) => set({ company: v })} placeholder="Grupo Alvear" /></Field>
                                <Field label="Before"><Text value={it.before} onChange={(v) => set({ before: v })} placeholder="Cierre en 20 días" /></Field>
                                <Field label="Result figure"><Text value={it.stat} onChange={(v) => set({ stat: v })} placeholder="-60 %" /></Field>
                                <Field label="Figure label"><Text value={it.statLabel} onChange={(v) => set({ statLabel: v })} placeholder="tiempo de cierre" /></Field>
                                <Field label="Quote" wide><Area rows={2} value={it.quote} onChange={(v) => set({ quote: v })} /></Field>
                                <Field label="Quote author" wide><Text value={it.author} onChange={(v) => set({ author: v })} placeholder="Ana Pérez, CFO" /></Field>
                              </>)} />
                          )}

                          {m.key === "conditions" && <p className="pte-note">This slide lists your terms. Edit them in the <button type="button" className="pte-link" onClick={() => setTab("terms")}>Terms</button> tab.</p>}
                          {m.key === "closing" && <p className="pte-note">Shows the <button type="button" className="pte-link" onClick={() => setTab("contact")}>closing contact</button>, your website and the logo for dark backgrounds.</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {tab === "terms" && (
            <section className="pte-card">
              <h3>Terms</h3>
              <p className="pte-card-sub">Used on the Conditions slide, the services slide and the order form.</p>
              <div className="pte-grid">
                <Field label="Proposal validity"><Num value={terms.validityDays} onChange={(v) => setT({ validityDays: v })} suffix="days" /></Field>
                <Field label="Payment term"><Num value={terms.paymentDays} onChange={(v) => setT({ paymentDays: v })} suffix="days" /></Field>
                <Field label="Annual increase"><Num value={terms.annualIncreasePct} step={0.5} onChange={(v) => setT({ annualIncreasePct: v })} suffix="%" /></Field>
                <Field label="Minimum billable unit"><Num value={terms.minBillableDay} step={0.25} onChange={(v) => setT({ minBillableDay: v })} suffix="days" /></Field>
                <Field label="Extra conditions" wide hint="One per line. Added before the payment and validity terms.">
                  <Area rows={5} value={linesOf(terms.notes)} onChange={(v) => setT({ notes: fromLines(v) })} placeholder={"Los gastos de desplazamiento se facturarán aparte.\nPrecios sin IVA."} />
                </Field>
              </div>
              <p className="pte-fhint">Empty fields use the defaults: 30 days validity, 30 days payment, 5 % increase, 0,5 days minimum.</p>
            </section>
          )}
        </fieldset>

        <aside className="pte-side">
          <Preview brand={template.brand} sections={sections} activeKey={activePreviewKey} />
        </aside>
      </div>
    </div>
  );
}