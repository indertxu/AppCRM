/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PageLoader } from "../../framework/AppLayout";
import { createPortal } from "react-dom";
import Select from "../../framework/Select";
import {
  loadProposalTemplateRow, saveProposalTemplate, uploadBrandAsset, generateProposal, loadProposalTemplateRowFor, saveProposalTemplateFor, deleteProposalTemplate, type ProposalTemplateRow,
  listProposalDecks, uploadProposalDeck, replaceProposalDeckFile, saveProposalDeck, deleteProposalDeck, loadProposalDeckFile, deckSlidesFor, guessDeckRules, downloadBlob,
  type DeckSlideRule, type ProposalDeckRow,
} from "../sales/trackings/proposalApi";
import {
  defaultSlideTitle, previewTexts, repeatCount, isKnownToken, condFails, nameHides, loadDeckPreview, DECK_TOKENS, openDeckEditor, tokensIn,
  type ProposalData, type ProposalTemplate, type TemplateSection, type PvDeck, type PvShape, type PvText, type PvPara, type DeckInfo, type DeckTokenDef,
  type PvSlide, type DeckEditOp, type EditShape, type DeckEditSession,
} from "../sales/trackings/proposalGen";
import { loadProducts, loadServices } from "./catalogApi";
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

/** A product or service with a proposal template of its own. */
export interface TemplateOwner { type: "product" | "service"; id: string; name: string }

export default function ProposalTemplateEditor({ canManage, owner, onClose, onOwnChange, variant }: {
  canManage: boolean;
  /** Shown as the "Order form (PDF)" tab of Settings › Proposal template. */
  variant?: "orderform";
  /** Edit the template of this product / service instead of the default one. */
  owner?: TemplateOwner;
  /** Shows a back button (used when opened over another page). */
  onClose?: () => void;
  /** Tells the caller whether the owner now has a template of its own. */
  onOwnChange?: (own: boolean) => void;
}) {
  const [loading, setLoading] = useState(true);
  /** Owner without a template yet: what you see is a copy of the default one. */
  const [inherited, setInherited] = useState(false);
  const [resetAsk, setResetAsk] = useState(false);
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

  const apply = (row: ProposalTemplateRow | null) => {
    if (!row) return;
    setBrand({ ...row.brand, colors: { ...DEFAULT_COLORS, ...(row.brand?.colors ?? {}) }, fonts: { heading: "Arial", body: "Calibri", ...(row.brand?.fonts ?? {}) }, assets: row.brand?.assets ?? {} });
    setSections(normalizeSections(row.sections));
    setTerms(row.terms ?? {});
  };
  const load = async () => {
    if (!owner) {
      const row = await loadProposalTemplateRow();
      if (row) setId(row.id);
      apply(row);
      return;
    }
    const own = await loadProposalTemplateRowFor(owner.type, owner.id);
    if (own) { setId(own.id); setInherited(false); apply(own); return; }
    // No template of its own yet: start from a copy of the default one.
    setId(null); setInherited(true);
    apply(await loadProposalTemplateRow().catch(() => null));
  };
  useEffect(() => {
    load()
      .catch((e) => setFlash({ kind: "err", text: `Couldn't load the template: ${e.message ?? e}` }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.type, owner?.id]);

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
      const patch = { brand: { ...brand, assets }, sections, terms: cleanTerms(terms) };
      const newId = owner
        ? await saveProposalTemplateFor(owner.type, owner.id, id, { name: owner.name, ...patch })
        : await saveProposalTemplate(id, patch);
      setId(newId); setDirty(false);
      if (owner) { setInherited(false); onOwnChange?.(true); }
      setFlash({ kind: "ok", text: owner ? `Template saved. New proposals for ${owner.name} will use it.` : "Template saved. New proposals will use it." });
    } catch (e: any) {
      setFlash({ kind: "err", text: `Couldn't save: ${e.message ?? e}` });
    } finally { setSaving(false); }
  };

  /** Owner only: drop its own template and go back to the default one. */
  const backToDefault = async () => {
    if (!owner || !id) return;
    setSaving(true);
    try {
      await deleteProposalTemplate(id);
      setResetAsk(false); setDirty(false);
      await load();
      onOwnChange?.(false);
      setFlash({ kind: "ok", text: `${owner.name} uses the default template again.` });
    } catch (e: any) {
      setFlash({ kind: "err", text: `Couldn't remove it: ${e.message ?? e}` });
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

  if (loading) return <div className="pte"><PageLoader label="Loading template" /></div>;

  const company = brand.company || "Tu empresa";
  const activePreviewKey = tab === "slides" ? openSec : null;

  return (
    <div className="pte">
      <header className="pte-head">
        {onClose && (
          <button className="pte-back" onClick={() => { if (!dirty || confirm("Leave without saving your changes?")) onClose(); }} aria-label="Back">‹</button>
        )}
        <div>
          {owner && <span className="pte-owner-eyebrow">{owner.type === "product" ? "Product" : "Service"} · {owner.name}</span>}
          <h2>{variant === "orderform" ? "Order form (PDF)" : "Proposal template"}{owner && <em className={`pte-own-tag ${inherited ? "is-default" : ""}`}>{inherited ? "Default" : "Own template"}</em>}</h2>
          <p>{owner
            ? `How proposals for ${owner.name} look, and the copy they start from.`
            : variant === "orderform"
              ? "Brand, copy and terms of the PDF order form, and of the built-in deck used when no PowerPoint is uploaded."
              : "How every proposal deck and order form looks, and the copy it starts from."}</p>
        </div>
        <div className="pte-head-actions">
          {dirty && <span className="pte-dirty"><i />Unsaved changes</span>}
          {owner && id && canManage && !resetAsk && <button className="pte-btn is-ghost" disabled={saving} onClick={() => setResetAsk(true)}>Back to default</button>}
          {owner && id && canManage && resetAsk && (
            <span className="pte-reset-ask">
              Use the default template again?
              <button className="pte-btn is-sm" onClick={() => setResetAsk(false)}>Keep</button>
              <button className="pte-btn is-sm is-danger" disabled={saving} onClick={backToDefault}>Remove own</button>
            </span>
          )}
          <button className="pte-btn" disabled={!!sampling} onClick={() => sample("pptx")}>{sampling === "pptx" ? "Building…" : "Sample PPT"}</button>
          <button className="pte-btn" disabled={!!sampling} onClick={() => sample("pdf")}>{sampling === "pdf" ? "Building…" : "Sample PDF"}</button>
          {canManage && <button className="pte-btn is-primary" disabled={saving || (!dirty && !inherited)} onClick={save}>{saving ? "Saving…" : inherited ? "Save as own template" : "Save template"}</button>}
        </div>
      </header>

      {owner && inherited && (
        <div className="pte-flash is-info"><span>Using the default template — save to give {owner.name} its own.</span></div>
      )}

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

/* ============================ Slide preview ============================ */
/**
 * Draws one slide of a company deck (from loadDeckPreview) as HTML, close to
 * how PowerPoint shows it. With `values` the {{tokens}} show their values (and
 * shapes / rows that come out empty disappear); without, the tokens show as
 * typed. `edits` override paragraphs by key. Clicking a text calls onPickText.
 */
export function SlidePreview({ deck, n, refId, values, edits, width, onPickText, highlightKey, className, hide, hideText }: {
  deck: PvDeck; n: number;
  /** For a repeated slide's copy: its ref ("17.1", see slideRef) — edit keys use it instead of n. */
  refId?: string;
  values?: Record<string, string>; edits?: Record<string, string>; width: number;
  onPickText?: (key: string) => void; highlightKey?: string | null; className?: string;
  /** Top-level slide shapes not to draw (just deleted). */
  hide?: string[];
  /** Top-level slide shapes whose words aren't drawn (being typed over in place). */
  hideText?: string[];
}) {
  const ref = refId ?? String(n);
  const slide = deck.slides.find((x) => x.n === n);
  const k = width / deck.cx;
  const pt = 12700 * k;
  const height = deck.cy * k;
  // a value the deal fills but doesn't have (a 5th phase…) is empty; a free field not typed yet shows as {{typed}}
  const get = (key: string) => (values ? values[key] ?? (isKnownToken(key) ? "" : undefined) : undefined);
  const ed = edits ?? {};
  if (!slide) return <div className={className} style={{ width, height, background: "#f1f4f2" }} />;

  const paraView = (p: PvPara, i: number, scale = 1) => {
    const pick = onPickText && p.key ? () => onPickText(p.key!) : undefined;
    const on = !!highlightKey && p.key === highlightKey;
    const size = (p.runs[0]?.size ?? p.endSize) * pt * scale;
    // the paragraph's own size sets the line box (else the page's 16px would)
    const lineSize = Math.max(p.endSize, ...p.runs.map((r) => r.size)) * pt * scale;
    return (
      <div key={i} data-key={p.key} className={`spv-p ${pick ? "is-pick" : ""} ${on ? "is-on" : ""}`}
        onClick={pick ? (e) => { e.stopPropagation(); pick(); } : undefined}
        style={{
          textAlign: p.align === "ctr" ? "center" : p.align === "r" ? "right" : p.align === "just" ? "justify" : "left",
          marginLeft: (p.marL ?? 0) * k, textIndent: (p.indent ?? 0) * k,
          lineHeight: p.lnSpc ? 1.18 * p.lnSpc : 1.18,
          marginTop: p.spcBef ? p.spcBef * pt : 0, marginBottom: p.spcAft ? p.spcAft * pt : 0,
          fontSize: p.runs.length ? lineSize : p.endSize * pt * scale, minHeight: p.runs.length ? undefined : p.endSize * pt * scale * (p.lnSpc ? 1.18 * p.lnSpc : 1.18),
          color: p.color,
        }}>
        {p.bullet && p.runs.length > 0 && <span style={{ fontSize: size, color: p.runs[0]?.color }}>{p.bullet}&nbsp;</span>}
        {p.runs.map((r, j) => (
          <span key={j} style={{
            fontSize: r.size * pt * scale * (r.baseline ? 0.62 : 1), lineHeight: r.baseline ? 0 : undefined, fontWeight: r.bold ? 700 : 400, fontStyle: r.italic ? "italic" : undefined,
            textDecoration: [r.underline && "underline", r.strike && "line-through"].filter(Boolean).join(" ") || undefined,
            color: r.color, fontFamily: r.font ? `"${r.font}", Arial, sans-serif` : undefined,
            textTransform: r.caps ? "uppercase" : undefined, letterSpacing: r.spc ? r.spc * pt : undefined,
            verticalAlign: r.baseline ? (r.baseline > 0 ? "super" : "sub") : undefined,
          }}>{r.text}</span>
        ))}
      </div>
    );
  };
  const textView = (t0: PvText, keyFor?: (pi: number) => string | undefined) => {
    const t: PvText = ref === String(n) ? t0 : { ...t0, paras: t0.paras.map((p) => ({ ...p, key: p.key?.replace(/^[^:]+:/, `${ref}:`) })) };
    const res = values || Object.keys(ed).length ? previewTexts(t, get, ed, keyFor) : { paras: keyFor ? t.paras.map((p, i) => ({ ...p, key: keyFor(i) })) : t.paras, drop: false };
    return {
      drop: !!values && res.drop,
      el: (
        <div className="spv-text" style={{
          justifyContent: t.anchor === "ctr" ? "center" : t.anchor === "b" ? "flex-end" : "flex-start",
          padding: `${t.t * k}px ${t.r * k}px ${t.b * k}px ${t.l * k}px`, whiteSpace: t.wrap ? "pre-wrap" : "pre",
        }}>
          {res.paras.map((p, i) => paraView(p, i, t.scale ?? 1))}
        </div>
      ),
    };
  };

  const shapeView = (s: PvShape, i: number | string) => {
    if (values && s.hideIf && nameHides(s.name, get)) return null;
    if (hide && s.layer === "slide" && s.top && hide.includes(s.top)) return null;
    const box: React.CSSProperties = {
      left: s.x * k, top: s.y * k, width: Math.max(s.w * k, 0.5), height: Math.max(s.h * k, 0.5),
      transform: [s.rot ? `rotate(${s.rot}deg)` : "", s.flipH && !s.connector ? "scaleX(-1)" : "", s.flipV && !s.connector ? "scaleY(-1)" : ""].join(" ").trim() || undefined,
    };
    if (s.connector && !s.text) {
      const w = s.w * k, h = s.h * k, lw = Math.max(1, (s.line?.w ?? 9525) * k);
      const [x1, x2] = s.flipH ? [w, 0] : [0, w], [y1, y2] = s.flipV ? [h, 0] : [0, h];
      return (
        <svg key={i} className="spv-shape" style={{ ...box, transform: s.rot ? `rotate(${s.rot}deg)` : undefined, overflow: "visible" }} width={Math.max(w, 1)} height={Math.max(h, 1)}>
          {s.line && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={s.line.color} strokeWidth={lw} strokeDasharray={s.line.dash ? `${lw * 3} ${lw * 2}` : undefined} />}
        </svg>
      );
    }
    let text: ReturnType<typeof textView> | null = null;
    if (s.text && !(hideText && s.layer === "slide" && s.top && hideText.includes(s.top))) {
      text = textView(s.text);
      if (text.drop) return null;
    }
    const radius = s.geom === "ellipse" ? "50%" : s.radius ? s.radius * k : s.geom === "flowChartTerminator" ? s.h * k / 2 : undefined;
    const border = s.line && !s.path ? `${Math.max(0.6, s.line.w * k)}px ${s.line.dash ? "dashed" : "solid"} ${s.line.color}` : undefined;
    return (
      <div key={i} className="spv-shape" data-top={s.layer === "slide" ? s.top : undefined} style={box}>
        {s.path ? (
          <svg className="spv-fill" viewBox={`0 0 ${s.path[0]?.w ?? 1} ${s.path[0]?.h ?? 1}`} preserveAspectRatio="none" width="100%" height="100%">
            {s.path.map((p, j) => <path key={j} d={p.d} fill={s.fill ?? "none"} stroke={s.line?.color ?? "none"} strokeWidth={s.line ? (s.line.w * (p.w / Math.max(1, s.w))) : 0} vectorEffect="non-scaling-stroke" />)}
          </svg>
        ) : (s.fill || border || (s.img && s.imgFill)) ? (
          <div className="spv-fill" style={{ background: s.img && s.imgFill ? `center / 100% 100% no-repeat url("${s.img}")` : s.fill, border, borderRadius: radius }} />
        ) : null}
        {s.img && !s.imgFill && (
          <div className="spv-fill" style={{ borderRadius: radius, overflow: "hidden" }}>
            {s.crop ? (() => {
              const cw = 100 - s.crop.l - s.crop.r, ch = 100 - s.crop.t - s.crop.b;
              return <img src={s.img} alt="" draggable={false} style={{ position: "absolute", width: `${(100 / cw) * 100}%`, height: `${(100 / ch) * 100}%`, left: `${(-s.crop.l / cw) * 100}%`, top: `${(-s.crop.t / ch) * 100}%` }} />;
            })() : <img src={s.img} alt="" draggable={false} style={{ width: "100%", height: "100%", display: "block" }} />}
          </div>
        )}
        {text?.el}
        {s.table && tableView(s)}
      </div>
    );
  };

  const tableView = (s: PvShape) => {
    const t = s.table!;
    const xs = t.cols.reduce<number[]>((a, w) => [...a, a[a.length - 1] + w], [0]);
    let y = 0;
    const out: React.ReactNode[] = [];
    t.rows.forEach((row, r) => {
      const copies = row.repeat && values ? repeatCount(row.repeat, (key) => values[key]) : -1;
      if (values && copies < 0 && condFails(row.text, get)) return;
      const runs = (copies < 0 ? [{ tag: String(r), g: get }] : Array.from({ length: copies }, (_, j) => ({ tag: `${r}.${j + 1}`, g: (key: string) => get(key.replace(/#/g, String(j + 1))) })))
        .filter((x) => !(values && copies >= 0 && condFails(row.text, x.g)));
      runs.forEach(({ tag, g }) => {
        row.cells.forEach((c, ci) => {
          if (c.merged) return;
          const span = c.span ?? 1;
          const x0 = xs[ci] ?? 0, x1 = xs[Math.min(ci + span, xs.length - 1)] ?? x0;
          const keyFor = (pi: number) => `${ref}:${s.sid}:r${tag}c${ci}:${pi}`;
          const res = values || Object.keys(ed).length ? previewTexts(c.text, g, ed, keyFor) : { paras: c.text.paras.map((p, pi) => ({ ...p, key: keyFor(pi) })), drop: false };
          out.push(
            <div key={`${tag}-${ci}`} className="spv-cell" style={{
              left: x0 * k, top: y * k, width: (x1 - x0) * k, height: row.h * k, background: c.fill,
              borderLeft: c.borders.l, borderRight: c.borders.r, borderTop: c.borders.t, borderBottom: c.borders.b,
            }}>
              <div className="spv-text" style={{
                justifyContent: c.text.anchor === "ctr" ? "center" : c.text.anchor === "b" ? "flex-end" : "flex-start",
                padding: `${c.text.t * k}px ${c.text.r * k}px ${c.text.b * k}px ${c.text.l * k}px`, whiteSpace: "pre-wrap",
              }}>
                {res.paras.map((p, pi) => paraView(p, pi))}
              </div>
            </div>,
          );
        });
        y += row.h;
      });
    });
    return <div className="spv-table">{out}</div>;
  };

  const seen = new Map<string, number>();
  return (
    <div className={`spv ${className ?? ""}`} style={{ width, height, background: slide.bg ?? "#fff" }}>
      {slide.bgImg && <img className="spv-bg" src={slide.bgImg} alt="" draggable={false} />}
      {slide.shapes.map((s, i) => {
        // stable keys: a shape keeps its DOM (and its image) when others are added, removed or reordered
        const base = `${s.layer}:${s.sid || i}`;
        const c = (seen.get(base) ?? 0) + 1; seen.set(base, c);
        return shapeView(s, c > 1 ? `${base}#${c}` : base);
      })}
    </div>
  );
}

/* ======================= Settings › Proposal template ======================= */
/**
 * The page: your PowerPoint deck (main tab) and the PDF order form (the
 * brand / copy editor above). Sales build every proposal from the deck.
 */
export function ProposalSettings({ canManage, onBack }: { canManage: boolean; onBack: () => void }) {
  const [tab, setTab] = useState<"deck" | "pdf">("deck");
  return (
    <div className="st pd-page">
      <header className="st-bar st-bar-row pd-bar">
        <button className="st-back" onClick={onBack} aria-label="Back">‹</button>
        <div className="pd-bar-txt">
          <h1 className="st-title">Proposal template</h1>
          <p className="st-sub">Your own PowerPoint, filled in from each deal.</p>
        </div>
        <div className="pd-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "deck"} className={tab === "deck" ? "is-on" : ""} onClick={() => setTab("deck")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
            Deck
          </button>
          <button role="tab" aria-selected={tab === "pdf"} className={tab === "pdf" ? "is-on" : ""} onClick={() => setTab("pdf")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></svg>
            Order form (PDF)
          </button>
        </div>
      </header>
      {tab === "deck" ? <DeckManager canManage={canManage} /> : <ProposalTemplateEditor canManage={canManage} variant="orderform" />}
    </div>
  );
}

/* ---------- rules ---------- */
type When = DeckSlideRule["when"];
const WHEN_META: Record<When, { label: string; color: string; soft: string }> = {
  always: { label: "Always", color: "#2c6e8f", soft: "#e8f2f7" },
  product: { label: "With a product", color: "#0e9a6a", soft: "#e5f6ee" },
  service: { label: "With a service", color: "#6a4fd6", soft: "#efebfd" },
  off: { label: "Left out", color: "#94a29c", soft: "#f1f3f2" },
};
interface CatItem { id: string; name: string; on: boolean }
interface Catalog { products: CatItem[]; services: CatItem[] }
const sameRule = (a: DeckSlideRule, b: DeckSlideRule) => a.when === b.when && [...a.ids].sort().join() === [...b.ids].sort().join();

/** Short text of a rule: "Always", "Any product", "Konsolidator", "Data Management +1", "Left out". */
function ruleText(r: Pick<DeckSlideRule, "when" | "ids">, cat: Catalog): string {
  if (r.when === "always") return "Always";
  if (r.when === "off") return "Left out";
  const list = r.when === "product" ? cat.products : cat.services;
  if (!r.ids.length) return r.when === "product" ? "Any product" : "Any service";
  const names = r.ids.map((id) => list.find((x) => x.id === id)?.name ?? "Removed item");
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}

/** First rules for a deck: product / service tokens decide; hidden slides are left out; plain slides sitting
 *  between two slides of the same product / service rule join them (e.g. the copy slides of a service section). */
function smartRules(info: DeckInfo, keep?: DeckSlideRule[]): DeckSlideRule[] {
  const base = guessDeckRules(info.slides.map((s) => ({ n: s.n, tokens: s.tokens })));
  const own = (s: DeckInfo["slides"][number]) => s.tokens.some((t) => t.startsWith("product") || t.startsWith("service"));
  info.slides.forEach((s, i) => { if (s.hidden) base[i] = { n: s.n, when: "off", ids: [] }; });
  for (let i = 0; i < base.length; i++) {
    if (base[i].when !== "always" || own(info.slides[i])) continue;
    let a = i - 1; while (a >= 0 && base[a].when === "always") a--;
    let b = i + 1; while (b < base.length && base[b].when === "always" && !own(info.slides[b])) b++;
    if (a >= 0 && b < base.length && base[a].when === base[b].when && (base[a].when === "product" || base[a].when === "service")) {
      for (let k = a + 1; k < b; k++) base[k] = { ...base[k], when: base[a].when };
      i = b;
    }
  }
  if (!keep) return base;
  return base.map((r) => keep.find((k) => k.n === r.n) ?? r);
}

/** Rules for exactly the slides of the deck (new slides get a guess, gone ones are dropped). */
function fitRules(info: DeckInfo, rules: DeckSlideRule[]): DeckSlideRule[] {
  if (info.slides.every((s) => rules.some((r) => r.n === s.n)) && rules.length === info.slides.length) return [...rules].sort((a, b) => a.n - b.n);
  return smartRules(info, rules);
}

/** Blob URLs a preview made (images), to free them. */
function previewUrls(pv: PvDeck | null): string[] {
  if (!pv) return [];
  const out: string[] = [];
  pv.slides.forEach((s) => { if (s.bgImg?.startsWith("blob:")) out.push(s.bgImg); s.shapes.forEach((sh) => { if (sh.img?.startsWith("blob:")) out.push(sh.img); }); });
  return out;
}

const tokenDef = (key: string): DeckTokenDef | undefined => {
  const k = key.replace(/\d+|#/g, "N");
  return DECK_TOKENS.find((t) => t.key.replace(/#/g, "N") === k);
};
/** Deck titles are often in capitals: "PROPUESTA COMERCIAL" → "Propuesta comercial". */
const niceTitle = (t?: string) => {
  const x = String(t ?? "").replace(/\s+/g, " ").trim();
  if (!x || x !== x.toUpperCase() || !/[A-ZÁÉÍÓÚÑ]/.test(x)) return x;
  const low = x.toLowerCase();
  return low.charAt(0).toUpperCase() + low.slice(1);
};
/** Fields of a slide grouped by what they are ("Price row N: amount" ×4 → one line). */
function groupTokens(tokens: string[]): { key: string; label: string; tokens: string[] }[] {
  const out: { key: string; label: string; tokens: string[] }[] = [];
  tokens.forEach((t) => {
    const d = tokenDef(t);
    const key = d?.key ?? t;
    const g = out.find((x) => x.key === key);
    if (g) g.tokens.push(t); else out.push({ key, label: d?.label ?? t, tokens: [t] });
  });
  return out;
}
const fmtSize = (b: number | null | undefined) => !b ? "" : b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const Ico = {
  upload: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg>,
  download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>,
  swap: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3" /></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>,
  star: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  chev: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  copy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>,
  deck: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 9h6M7 12h10" /></svg>,
  play: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M10 8l6 4-6 4z" /><circle cx="12" cy="12" r="9" /></svg>,
  left: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>,
  right: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>,
  pen: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>,
};

/* ---------- the manager ---------- */
function DeckManager({ canManage }: { canManage: boolean }) {
  const [decks, setDecks] = useState<ProposalDeckRow[] | null | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [cat, setCat] = useState<Catalog>({ products: [], services: [] });
  const [pv, setPv] = useState<PvDeck | null>(null);
  const [pvState, setPvState] = useState<"idle" | "loading" | "error">("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [sim, setSim] = useState<{ products: string[]; services: string[] }>({ products: [], services: [] });
  const [open, setOpen] = useState<number | null>(null);
  const [delAsk, setDelAsk] = useState(false);
  const [editing, setEditing] = useState<{ n: number; buf: ArrayBuffer } | null>(null);
  const bufs = useRef(new Map<string, ArrayBuffer>());
  /** The preview of a file just uploaded, so it isn't read twice. */
  const fresh = useRef(new Map<string, PvDeck>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const lastPick = useRef<number | null>(null);

  const deck = decks?.find((d) => d.id === activeId) ?? null;

  useEffect(() => {
    listProposalDecks().then((xs) => { setDecks(xs); if (xs?.length) setActiveId(xs[0].id); });
    Promise.all([loadProducts().catch(() => []), loadServices().catch(() => [])]).then(([ps, ss]) => setCat({
      products: ps.filter((p) => p.id).map((p) => ({ id: p.id!, name: p.name || "Untitled product", on: p.in_proposals !== false })),
      services: ss.filter((s) => s.id).map((s) => ({ id: s.id!, name: s.name || "Untitled service", on: s.in_proposals !== false })),
    }));
  }, []);
  useEffect(() => { if (!flash || flash.kind === "err") return; const t = setTimeout(() => setFlash(null), 3200); return () => clearTimeout(t); }, [flash]);

  // the active deck's preview (from the file just uploaded, else downloaded once)
  useEffect(() => {
    if (!deck) { setPv(null); return; }
    let alive = true;
    setPvState("loading"); setSelected([]); setOpen(null); setDelAsk(false);
    (async () => {
      try {
        let p = fresh.current.get(deck.storage_path);
        fresh.current.delete(deck.storage_path);
        if (!p) {
          let buf = bufs.current.get(deck.storage_path);
          if (!buf) { buf = await loadProposalDeckFile(deck); bufs.current.set(deck.storage_path, buf); }
          p = await loadDeckPreview(buf);
        }
        if (!alive) { previewUrls(p).forEach((u) => URL.revokeObjectURL(u)); return; }
        setPv(p); setPvState("idle");
        // the file may have slides the rules don't know yet
        const fitted = fitRules(p.info, deck.slides);
        if (JSON.stringify(fitted) !== JSON.stringify(deck.slides)) setRulesNow(fitted, false);
      } catch (e: any) {
        if (alive) { setPvState("error"); setFlash({ kind: "err", text: `Couldn't open the deck: ${e.message ?? e}` }); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck?.id, deck?.storage_path]);
  // free the images of a preview we no longer show
  useEffect(() => () => { previewUrls(pv).forEach((u) => URL.revokeObjectURL(u)); }, [pv]);

  const rules = useMemo(() => [...(deck?.slides ?? [])].sort((a, b) => a.n - b.n), [deck?.slides]);

  /** Applies rules at once and saves them shortly after (several clicks → one save). */
  const setRulesNow = useCallback((next: DeckSlideRule[], save = true) => {
    if (!activeId) return;
    setDecks((xs) => xs?.map((d) => (d.id === activeId ? { ...d, slides: next } : d)) ?? xs);
    if (!canManage) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    const id = activeId;
    saveTimer.current = setTimeout(async () => {
      const e = await saveProposalDeck(id, { slides: next });
      setSaveState(e ? "error" : "saved");
      if (e) setFlash({ kind: "err", text: `Couldn't save the slide rules: ${e}` });
    }, save ? 650 : 0);
  }, [activeId, canManage]);
  const setRule = (ns: number[], r: Pick<DeckSlideRule, "when" | "ids">) =>
    setRulesNow(rules.map((x) => (ns.includes(x.n) ? { n: x.n, when: r.when, ids: r.when === "product" || r.when === "service" ? r.ids : [] } : x)));

  /* upload / replace / delete */
  const readDeck = async (file: File) => {
    if (!/\.pptx$/i.test(file.name)) throw new Error("Use a PowerPoint file (.pptx).");
    const buf = await file.arrayBuffer();
    const p = await loadDeckPreview(buf);
    if (!p.info.slides.length) throw new Error("This file has no slides.");
    return { buf, p };
  };
  const upload = async (file: File) => {
    setBusy("Reading your deck…"); setFlash(null);
    try {
      const { buf, p } = await readDeck(file);
      setBusy("Uploading…");
      const { deck: row, error } = await uploadProposalDeck(file, smartRules(p.info));
      if (error || !row) { previewUrls(p).forEach((u) => URL.revokeObjectURL(u)); throw new Error(error ?? "Upload failed."); }
      bufs.current.set(row.storage_path, buf);
      fresh.current.set(row.storage_path, p);
      setDecks((xs) => [...(xs ?? []), row]); setActiveId(row.id); setAdding(false);
      setFlash({ kind: "ok", text: `${p.info.slides.length} slides read. Check when each one goes in.` });
    } catch (e: any) { setFlash({ kind: "err", text: e.message ?? String(e) }); }
    finally { setBusy(null); }
  };
  const replace = async (file: File | undefined) => {
    if (!file || !deck) return;
    setBusy("Reading the new file…"); setFlash(null);
    try {
      const { buf, p } = await readDeck(file);
      const next = smartRules(p.info, deck.slides.filter((r) => r.n <= p.info.slides.length));
      setBusy("Uploading…");
      const e = await replaceProposalDeckFile(deck, file, next);
      if (e) { previewUrls(p).forEach((u) => URL.revokeObjectURL(u)); throw new Error(e); }
      const rows = (await listProposalDecks()) ?? [];
      const row = rows.find((d) => d.id === deck.id);
      if (row) { bufs.current.set(row.storage_path, buf); fresh.current.set(row.storage_path, p); }
      setDecks(rows);
      setFlash({ kind: "ok", text: "File replaced. Slide rules kept by position." });
    } catch (e: any) { setFlash({ kind: "err", text: e.message ?? String(e) }); }
    finally { setBusy(null); if (replaceRef.current) replaceRef.current.value = ""; }
  };
  /** Opens the slide editor on the deck's file. */
  const editSlide = async (n: number) => {
    if (!deck || !canManage) return;
    setOpen(null);
    try {
      let buf = bufs.current.get(deck.storage_path);
      if (!buf) { setBusy("Opening the deck…"); buf = await loadProposalDeckFile(deck); bufs.current.set(deck.storage_path, buf); }
      setEditing({ n, buf });
    } catch (e: any) { setFlash({ kind: "err", text: e.message ?? String(e) }); }
    finally { setBusy(null); }
  };
  /** The editor saved: the new file replaces the deck's (rules unchanged — same slides). */
  const saveEdited = async (blob: Blob): Promise<string | null> => {
    if (!deck) return "No deck.";
    const file = new File([blob], deck.file_name || `${deck.name}.pptx`, { type: PPTX });
    const e = await replaceProposalDeckFile(deck, file, deck.slides);
    if (e) return e;
    const buf = await blob.arrayBuffer();
    const p = await loadDeckPreview(buf);
    const rows = (await listProposalDecks()) ?? [];
    const row = rows.find((d) => d.id === deck.id);
    if (row) { bufs.current.set(row.storage_path, buf); fresh.current.set(row.storage_path, p); }
    setDecks(rows.map((d) => (d.id === deck.id ? { ...d, size_bytes: blob.size } : d)));
    setPv(p);
    return null;
  };
  const download = async () => {
    if (!deck) return;
    const buf = bufs.current.get(deck.storage_path) ?? await loadProposalDeckFile(deck);
    downloadBlob(new Blob([buf], { type: PPTX }), deck.file_name || `${deck.name}.pptx`);
  };
  const remove = async () => {
    if (!deck) return;
    setBusy("Deleting…");
    const e = await deleteProposalDeck(deck);
    setBusy(null); setDelAsk(false);
    if (e) { setFlash({ kind: "err", text: e }); return; }
    const rest = (decks ?? []).filter((d) => d.id !== deck.id);
    if (deck.is_default && rest[0]) { await saveProposalDeck(rest[0].id, { is_default: true }); rest[0] = { ...rest[0], is_default: true }; }
    setDecks(rest); setActiveId(rest[0]?.id ?? null);
  };
  const rename = async (name: string) => {
    if (!deck || !name.trim() || name === deck.name) return;
    setDecks((xs) => xs?.map((d) => (d.id === deck.id ? { ...d, name } : d)) ?? xs);
    const e = await saveProposalDeck(deck.id, { name: name.trim() });
    if (e) setFlash({ kind: "err", text: e });
  };
  const makeDefault = async () => {
    if (!deck) return;
    const e = await saveProposalDeck(deck.id, { is_default: true });
    if (e) { setFlash({ kind: "err", text: e }); return; }
    setDecks((xs) => xs?.map((d) => ({ ...d, is_default: d.id === deck.id })) ?? xs);
    setFlash({ kind: "ok", text: `${deck.name} is now the deck new proposals start from.` });
  };

  /* simulator */
  const simOn = sim.products.length + sim.services.length > 0;
  const simPlan = useMemo(() => (simOn ? deckSlidesFor(rules, sim.products, sim.services) : []), [simOn, rules, sim]);
  const simPos = useMemo(() => {
    const m = new Map<number, number[]>();
    simPlan.forEach((x, i) => m.set(x.n, [...(m.get(x.n) ?? []), i + 1]));
    return m;
  }, [simPlan]);

  /* blocks of consecutive slides with the same rule (they repeat together) */
  const blocks = useMemo(() => {
    const out: { rule: DeckSlideRule; ns: number[] }[] = [];
    rules.forEach((r) => {
      const last = out[out.length - 1];
      if (last && sameRule(last.rule, r)) last.ns.push(r.n); else out.push({ rule: r, ns: [r.n] });
    });
    return out;
  }, [rules]);
  const counts = useMemo(() => {
    const c: Record<When, number> = { always: 0, product: 0, service: 0, off: 0 };
    rules.forEach((r) => { c[r.when]++; });
    return c;
  }, [rules]);

  const pickSlide = (n: number, shift: boolean) => {
    const last = lastPick.current;
    setSelected((sel) => {
      if (shift && last != null) {
        const [a, b] = [Math.min(last, n), Math.max(last, n)];
        const range = rules.filter((r) => r.n >= a && r.n <= b).map((r) => r.n);
        return Array.from(new Set([...sel, ...range]));
      }
      return sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n];
    });
    lastPick.current = n;
  };

  // ---- states ----
  if (decks === undefined) return <PageLoader fill={false} size={88} label="Loading decks" />;
  if (decks === null) {
    return (
      <div className="pd-card pd-missing">
        <h3>One step first</h3>
        <p>Run <b>13_proposal_decks.sql</b> in Supabase to upload your proposal deck. The order form (PDF) tab works already.</p>
      </div>
    );
  }
  if (!deck || adding) {
    return (
      <div className="pd-wrap">
        {flash && <DeckFlash flash={flash} onClose={() => setFlash(null)} />}
        <DeckEmpty canManage={canManage} busy={busy} onFile={upload} onCancel={deck ? () => setAdding(false) : undefined} />
      </div>
    );
  }

  const info = pv?.info ?? null;
  const slideOf = (n: number) => info?.slides.find((s) => s.n === n);
  const unknown = (info?.tokens ?? []).filter((t) => !isKnownToken(t));
  const openIdx = open != null ? rules.findIndex((r) => r.n === open) : -1;

  return (
    <div className="pd-wrap">
      {flash && <DeckFlash flash={flash} onClose={() => setFlash(null)} />}
      {!canManage && <div className="pd-note">You can look at the deck and its rules. Only managers can change them.</div>}

      {decks.length > 1 && (
        <div className="pd-decks">
          {decks.map((d) => (
            <button key={d.id} className={`pd-deck-tab ${d.id === deck.id ? "is-on" : ""}`} onClick={() => setActiveId(d.id)}>
              {d.is_default && <span className="pd-deck-star" title="Default deck">{Ico.star}</span>}
              {d.name}
            </button>
          ))}
          {canManage && <button className="pd-deck-tab is-add" onClick={() => setAdding(true)}>{Ico.plus}Add deck</button>}
        </div>
      )}

      {/* deck header */}
      <section className="pd-card pd-head">
        <span className="pd-head-icon">{Ico.deck}</span>
        <div className="pd-head-txt">
          <div className="pd-head-name">
            <input key={deck.id} className="pd-name" defaultValue={deck.name} disabled={!canManage} aria-label="Deck name"
              onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            {deck.is_default && decks.length > 1 && <span className="pd-badge">{Ico.star}Default</span>}
          </div>
          <span className="pd-head-meta">
            {deck.file_name}{deck.size_bytes ? ` · ${fmtSize(deck.size_bytes)}` : ""}{info ? ` · ${info.slides.length} slides` : ""}
            {saveState === "saving" && <em className="pd-save is-saving"><i />Saving…</em>}
            {saveState === "saved" && <em className="pd-save"><i />All changes saved</em>}
            {saveState === "error" && <em className="pd-save is-err"><i />Not saved</em>}
          </span>
        </div>
        <div className="pd-head-actions">
          {delAsk ? (
            <span className="pd-ask">
              Delete this deck? Proposals already sent keep their files.
              <button className="pte-btn is-sm" onClick={() => setDelAsk(false)}>Keep</button>
              <button className="pte-btn is-sm is-danger" disabled={!!busy} onClick={remove}>Delete</button>
            </span>
          ) : (
            <>
              {canManage && decks.length > 1 && !deck.is_default && <button className="pte-btn is-sm" onClick={makeDefault}>{Ico.star}Make default</button>}
              <button className="pte-btn is-sm" onClick={download}>{Ico.download}Download</button>
              {canManage && <button className="pte-btn is-sm" disabled={!!busy} onClick={() => replaceRef.current?.click()}>{Ico.swap}Replace file</button>}
              {canManage && decks.length === 1 && <button className="pte-btn is-sm" onClick={() => setAdding(true)}>{Ico.plus}Another deck</button>}
              {canManage && <button className="pd-icon-btn is-del" onClick={() => setDelAsk(true)} aria-label="Delete deck" title="Delete deck">{Ico.trash}</button>}
              <input ref={replaceRef} type="file" accept=".pptx" hidden onChange={(e) => replace(e.target.files?.[0])} />
            </>
          )}
        </div>
        {busy && <div className="pd-busy"><span className="pd-spin" />{busy}</div>}
      </section>

      <div className="pd-layout">
        <div className="pd-main">
          <div className="pd-legend">
            <div className="pd-legend-items">
              {(Object.keys(WHEN_META) as When[]).map((w) => (
                <span key={w} className="pd-legend-item" style={{ ["--rc" as any]: WHEN_META[w].color }}><i />{WHEN_META[w].label}<b>{counts[w]}</b></span>
              ))}
            </div>
            <span className="pd-legend-tip">Tick slides to set several at once · shift-click for a range</span>
          </div>

          {pvState === "loading" && (
            <div className="pd-card pd-reading"><span className="pd-spin" />Opening {deck.file_name ?? "the deck"}…</div>
          )}
          {pvState === "error" && <div className="pd-card pd-reading">The deck couldn't be opened. Try Replace file.</div>}

          {pv && blocks.map((b, bi) => {
            const meta = WHEN_META[b.rule.when];
            const first = b.ns[0], last = b.ns[b.ns.length - 1];
            const repeats = (b.rule.when === "product" || b.rule.when === "service") && (b.rule.ids.length !== 1);
            return (
              <section key={`${bi}-${first}`} className={`pd-block is-${b.rule.when}`} style={{ ["--rc" as any]: meta.color, ["--rs" as any]: meta.soft }}>
                <header className="pd-block-head">
                  <span className="pd-block-dot" />
                  <div className="pd-block-txt">
                    <b>{b.rule.when === "always" ? "In every proposal" : b.rule.when === "off" ? "Left out" : `${b.rule.when === "product" ? "When the proposal has" : "When the proposal has"} ${ruleText(b.rule, cat)}`}</b>
                    <span>
                      {first === last ? `Slide ${first}` : `Slides ${first}–${last}`}
                      {repeats && ` · repeats for each ${b.rule.when} it includes`}
                      {b.rule.when === "off" && " · never used"}
                    </span>
                  </div>
                  {canManage && <RulePicker rule={b.rule} cat={cat} label="Change all" onChange={(r) => setRule(b.ns, r)} compact />}
                </header>
                <div className={`pd-grid ${selected.length ? "has-sel" : ""}`}>
                  {b.ns.map((n) => {
                    const s = slideOf(n);
                    const r = rules.find((x) => x.n === n)!;
                    const pos = simPos.get(n);
                    return (
                      <article key={n} className={`pd-slide ${selected.includes(n) ? "is-sel" : ""} ${simOn ? (pos ? "is-in" : "is-out") : ""} ${r.when === "off" ? "is-off" : ""}`}>
                        <button className="pd-thumb" onClick={() => setOpen(n)} aria-label={`Open slide ${n}`}>
                          <LazySlide deck={pv} n={n} />
                          {s && s.tokens.length > 0 && <span className="pd-tok" title={s.tokens.map((t) => `{{${t}}}`).join("  ")}>{s.tokens.length} field{s.tokens.length === 1 ? "" : "s"}</span>}
                          {simOn && pos && <span className="pd-sim-badge">{Ico.check}{pos.length > 1 ? `×${pos.length}` : `#${pos[0]}`}</span>}
                          {s?.hidden && <span className="pd-hidden">Hidden in PowerPoint</span>}
                        </button>
                        {canManage && (
                          <label className="pd-check" title="Select (shift-click for a range)" onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }} onClick={(e) => { e.preventDefault(); pickSlide(n, e.shiftKey); }}>
                            <input type="checkbox" readOnly checked={selected.includes(n)} />
                            <span>{Ico.check}</span>
                          </label>
                        )}
                        <div className="pd-slide-foot">
                          <div className="pd-slide-line">
                            <span className="pd-num">{n}</span>
                            <span className="pd-slide-title" title={s?.title}>{niceTitle(s?.title) || `Slide ${n}`}</span>
                            {canManage && <button className="pd-rm is-edit" onClick={() => editSlide(n)} title="Edit this slide: move boxes, change texts, add fields" aria-label={`Edit slide ${n}`}>{Ico.pen}</button>}
                            {canManage && (r.when === "off" ? (
                              <button className="pd-rm is-back" onClick={() => setRule([n], { when: "always", ids: [] })} title="Use this slide again (in every proposal)">Restore</button>
                            ) : (
                              <button className="pd-rm" onClick={() => setRule([n], { when: "off", ids: [] })} title="Remove this slide: it never goes in a proposal" aria-label={`Remove slide ${n}`}>{Ico.trash}</button>
                            ))}
                          </div>
                          <RulePicker rule={r} cat={cat} disabled={!canManage} onChange={(x) => setRule([n], x)} />
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        <aside className="pd-side">
          <TryIt cat={cat} sim={sim} setSim={setSim} plan={simPlan} />
          <FieldsPanel used={info?.tokens ?? []} unknown={unknown} />
        </aside>
      </div>

      {selected.length > 0 && canManage && createPortal(
        <div className="pd-selbar" role="toolbar">
          <b>{selected.length} slide{selected.length === 1 ? "" : "s"} selected</b>
          <RulePicker rule={{ when: "always", ids: [] }} cat={cat} label="Set when they go in" up compact onChange={(r) => { setRule(selected, r); setSelected([]); }} />
          <button className="pd-selbar-x" onClick={() => setSelected([])}>Clear</button>
        </div>,
        document.body,
      )}

      {pv && openIdx >= 0 && (
        <SlideModal pv={pv} rule={rules[openIdx]} cat={cat} canManage={canManage} title={slideOf(rules[openIdx].n)?.title ?? ""}
          tokens={slideOf(rules[openIdx].n)?.tokens ?? []}
          onRule={(r) => setRule([rules[openIdx].n], r)}
          onEdit={canManage ? () => editSlide(rules[openIdx].n) : undefined}
          onPrev={openIdx > 0 ? () => setOpen(rules[openIdx - 1].n) : undefined}
          onNext={openIdx < rules.length - 1 ? () => setOpen(rules[openIdx + 1].n) : undefined}
          onClose={() => setOpen(null)} />
      )}

      {pv && editing && (
        <DeckSlideEditor buf={editing.buf} base={pv} startN={editing.n} deckName={deck.name} onSave={saveEdited} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function DeckFlash({ flash, onClose }: { flash: { kind: "ok" | "err"; text: string }; onClose: () => void }) {
  return (
    <div className={`pte-flash is-${flash.kind}`} role={flash.kind === "err" ? "alert" : "status"}>
      <span>{flash.text}</span>
      <button onClick={onClose} aria-label="Dismiss">×</button>
    </div>
  );
}

/* ---------- empty state: upload ---------- */
function DeckEmpty({ canManage, busy, onFile, onCancel }: { canManage: boolean; busy: string | null; onFile: (f: File) => void; onCancel?: () => void }) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="pd-empty">
      <section className="pd-card pd-empty-main">
        {onCancel && <button className="pd-icon-btn pd-empty-x" onClick={onCancel} aria-label="Cancel">{Ico.x}</button>}
        <span className="pd-eyebrow">{onCancel ? "Another deck" : "Your proposal deck"}</span>
        <h2>Build every proposal from your own PowerPoint</h2>
        <p className="pd-lead">Upload the deck you already send. Each deal fills it in — client, dates, prices, phases — and only the slides for what you sell go in.</p>
        <div
          className={`pd-drop ${over ? "is-over" : ""} ${busy ? "is-busy" : ""} ${!canManage ? "is-disabled" : ""}`}
          onDragOver={(e) => { e.preventDefault(); if (canManage) setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f && canManage && !busy) onFile(f); }}
          onClick={() => canManage && !busy && ref.current?.click()} role="button" tabIndex={0}
          onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && canManage && !busy) ref.current?.click(); }}>
          {busy ? (
            <><span className="pd-spin is-lg" /><b>{busy}</b><span>Big decks take a few seconds.</span></>
          ) : (
            <>
              <span className="pd-drop-icon">{Ico.upload}</span>
              <b>{canManage ? "Drop your .pptx here" : "No deck uploaded yet"}</b>
              <span>{canManage ? <>or <u>browse your files</u></> : "Ask a manager to upload the company deck."}</span>
            </>
          )}
          <input ref={ref} type="file" accept=".pptx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
        </div>
        <ol className="pd-steps">
          <li><b>Write fields where values go</b><span>Type <code>{"{{client}}"}</code>, <code>{"{{date}}"}</code> or <code>{"{{product.annual}}"}</code> in the slide text — the deal fills them.</span></li>
          <li><b>Say when each slide goes in</b><span>Always, with a product, with a service, or never. A licence section only appears when the proposal has the licence.</span></li>
          <li><b>Sales generate it from the deal</b><span>They pick the versions, review every text and download the PowerPoint.</span></li>
        </ol>
      </section>
      <aside className="pd-side">
        <FieldsPanel used={[]} unknown={[]} />
      </aside>
    </div>
  );
}

/* ---------- rule picker ---------- */
function RulePicker({ rule, cat, onChange, disabled, label, compact, up }: {
  rule: Pick<DeckSlideRule, "when" | "ids">; cat: Catalog; onChange: (r: Pick<DeckSlideRule, "when" | "ids">) => void;
  disabled?: boolean; label?: string; compact?: boolean; up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const meta = WHEN_META[rule.when];
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = 280, left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w));
    const below = window.innerHeight - r.bottom;
    setPos(up || below < 340 ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 });
  }, [open, up]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const scroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key); window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); window.removeEventListener("scroll", scroll, true); };
  }, [open]);

  const set = (r: Pick<DeckSlideRule, "when" | "ids">, close = true) => { onChange(r); if (close) setOpen(false); };
  const toggle = (when: "product" | "service", id: string) => {
    const ids = rule.when === when ? rule.ids : [];
    set({ when, ids: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] }, false);
  };
  const group = (when: "product" | "service") => {
    const items = (when === "product" ? cat.products : cat.services).filter((x) => x.on || (rule.when === when && rule.ids.includes(x.id)));
    const anyOn = rule.when === when && !rule.ids.length;
    return (
      <div className="pd-pop-group" style={{ ["--rc" as any]: WHEN_META[when].color }}>
        <span className="pd-pop-label">{when === "product" ? "With a product" : "With a service"}</span>
        <button className={`pd-pop-opt ${anyOn ? "is-on" : ""}`} onClick={() => set({ when, ids: [] })}>
          <span className="pd-pop-radio" /><span>Any {when}<em>Repeats for each one in the proposal</em></span>
        </button>
        {items.map((x) => {
          const on = rule.when === when && rule.ids.includes(x.id);
          return (
            <button key={x.id} className={`pd-pop-opt is-item ${on ? "is-on" : ""}`} onClick={() => toggle(when, x.id)}>
              <span className="pd-pop-box">{on && Ico.check}</span><span>{x.name}{!x.on && <em>Not in proposals</em>}</span>
            </button>
          );
        })}
        {!items.length && <span className="pd-pop-empty">No {when}s available in proposals yet.</span>}
      </div>
    );
  };

  return (
    <>
      <button ref={btn} type="button" className={`pd-rule ${compact ? "is-compact" : ""} ${open ? "is-open" : ""}`} disabled={disabled}
        style={{ ["--rc" as any]: meta.color, ["--rs" as any]: meta.soft }} onClick={() => setOpen((o) => !o)} title={ruleText(rule, cat)}>
        {!label && <i />}
        <span>{label ?? ruleText(rule, cat)}</span>
        {!disabled && Ico.chev}
      </button>
      {open && pos && createPortal(
        <div ref={pop} className="pd-pop" style={{ left: pos.left, top: pos.top, bottom: pos.bottom }} role="menu">
          <button className={`pd-pop-opt is-big ${rule.when === "always" ? "is-on" : ""}`} style={{ ["--rc" as any]: WHEN_META.always.color }} onClick={() => set({ when: "always", ids: [] })}>
            <span className="pd-pop-radio" /><span>Always<em>In every proposal</em></span>
          </button>
          {group("product")}
          {group("service")}
          <button className={`pd-pop-opt is-big ${rule.when === "off" ? "is-on" : ""}`} style={{ ["--rc" as any]: WHEN_META.off.color }} onClick={() => set({ when: "off", ids: [] })}>
            <span className="pd-pop-radio" /><span>Leave out<em>Never used</em></span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

/* ---------- a thumbnail drawn only when it scrolls into view ---------- */
function LazySlide({ deck, n }: { deck: PvDeck; n: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: "300px" });
    io.observe(el);
    return () => { ro.disconnect(); io.disconnect(); };
  }, []);
  return (
    <div ref={ref} className="pd-lazy" style={{ aspectRatio: `${deck.cx} / ${deck.cy}` }}>
      {seen && w > 0 ? <SlidePreview deck={deck} n={n} width={w} /> : <span className="pd-lazy-ph" />}
    </div>
  );
}

/* ---------- large view of one slide ---------- */
function SlideModal({ pv, rule, cat, canManage, title, tokens, onRule, onEdit, onPrev, onNext, onClose }: {
  pv: PvDeck; rule: DeckSlideRule; cat: Catalog; canManage: boolean; title: string; tokens: string[];
  onRule: (r: Pick<DeckSlideRule, "when" | "ids">) => void; onEdit?: () => void; onPrev?: () => void; onNext?: () => void; onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setW(Math.floor(Math.min(width, height * (pv.cx / pv.cy))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [pv.cx, pv.cy]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.(".pd-pop") || document.querySelector(".pd-pop")) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && onPrev) onPrev();
      if (e.key === "ArrowRight" && onNext) onNext();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, onPrev, onNext]);
  const known = tokens.filter((t) => isKnownToken(t));
  const free = tokens.filter((t) => !isKnownToken(t));
  return createPortal(
    <div className="pd-modal-bg" onMouseDown={onClose}>
      <div className="pd-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`Slide ${rule.n}`}>
        <div className="pd-modal-stage">
          <button className="pd-nav is-prev" disabled={!onPrev} onClick={onPrev} aria-label="Previous slide">{Ico.left}</button>
          <div ref={stage} className="pd-modal-fit">
            {w > 0 && <SlidePreview deck={pv} n={rule.n} width={w} className="pd-modal-slide" />}
          </div>
          <button className="pd-nav is-next" disabled={!onNext} onClick={onNext} aria-label="Next slide">{Ico.right}</button>
        </div>
        <aside className="pd-modal-side">
          <div className="pd-modal-top">
            <span className="pd-eyebrow">Slide {rule.n} of {pv.slides.length}</span>
            <button className="pd-icon-btn" onClick={onClose} aria-label="Close">{Ico.x}</button>
          </div>
          <h3>{niceTitle(title) || `Slide ${rule.n}`}</h3>
          {onEdit && (
            <button className="pd-edit-btn" onClick={onEdit}>
              {Ico.pen}<span><b>Edit slide</b><i>Move boxes, change texts, add fields</i></span>
            </button>
          )}
          <div className="pd-modal-rule">
            <span>Goes in</span>
            <RulePicker rule={rule} cat={cat} disabled={!canManage} onChange={onRule} />
          </div>
          <div className="pd-modal-fields">
            <span className="pd-sublabel">Filled from the deal <b>{known.length}</b></span>
            {known.length ? groupTokens(known).map((g) => (
              <div key={g.key} className="pd-mf">
                <code title={g.tokens.map((t) => `{{${t}}}`).join("  ")}>{`{{${g.tokens[0]}}}`}</code>
                <span>{g.label}{g.tokens.length > 1 && <em> · {g.tokens.length} on this slide</em>}</span>
              </div>
            )) : <p className="pd-muted">No fields — this slide goes as it is.</p>}
            {free.length > 0 && (
              <>
                <span className="pd-sublabel is-warn">Seller fills in <b>{free.length}</b></span>
                {free.map((t) => <div key={t} className="pd-mf is-free"><code>{`{{${t}}}`}</code><span>Typed in when generating</span></div>)}
              </>
            )}
            <p className="pd-muted">Every other text on the slide can still be edited by the seller before downloading.</p>
          </div>
        </aside>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- try it ---------- */
function TryIt({ cat, sim, setSim, plan }: {
  cat: Catalog; sim: { products: string[]; services: string[] };
  setSim: (s: { products: string[]; services: string[] }) => void; plan: { n: number }[];
}) {
  const flip = (k: "products" | "services", id: string) =>
    setSim({ ...sim, [k]: sim[k].includes(id) ? sim[k].filter((x) => x !== id) : [...sim[k], id] });
  const on = sim.products.length + sim.services.length > 0;
  const chips = (k: "products" | "services") => {
    const list = cat[k].filter((x) => x.on);
    if (!list.length) return <span className="pd-muted">None available in proposals.</span>;
    return list.map((x) => (
      <button key={x.id} className={`pd-chip ${sim[k].includes(x.id) ? "is-on" : ""}`} style={{ ["--rc" as any]: WHEN_META[k === "products" ? "product" : "service"].color }} onClick={() => flip(k, x.id)}>
        <span className="pd-chip-box">{sim[k].includes(x.id) && Ico.check}</span>{x.name}
      </button>
    ));
  };
  return (
    <section className="pd-card pd-try">
      <header className="pd-side-head">
        <span className="pd-side-icon">{Ico.play}</span>
        <div><h3>Try it</h3><p>Pick what a proposal sells and see which slides go in.</p></div>
      </header>
      <span className="pd-sublabel">Products</span>
      <div className="pd-chips">{chips("products")}</div>
      <span className="pd-sublabel">Services</span>
      <div className="pd-chips">{chips("services")}</div>
      {on && (
        <div className="pd-try-res">
          <b>{plan.length} slide{plan.length === 1 ? "" : "s"}</b>
          <span>{new Set(plan.map((x) => x.n)).size !== plan.length ? "some repeat for each item" : "in the order shown"}</span>
          <button onClick={() => setSim({ products: [], services: [] })}>Clear</button>
        </div>
      )}
    </section>
  );
}

/* ---------- fields reference ---------- */
function FieldsPanel({ used, unknown }: { used: string[]; unknown: string[] }) {
  const [q, setQ] = useState("");
  const [openG, setOpenG] = useState<string | null>("General");
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string) => {
    const txt = `{{${key}}}`;
    navigator.clipboard?.writeText(txt).catch(() => undefined);
    setCopied(key); setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
  };
  const usedSet = new Set(used.map((t) => t.replace(/\d+|#/g, "N")));
  const groups: DeckTokenDef["group"][] = ["General", "Product", "Service", "Repeat rows"];
  const match = (t: DeckTokenDef) => !q || `${t.key} ${t.label}`.toLowerCase().includes(q.toLowerCase());
  return (
    <section className="pd-card pd-fields">
      <header className="pd-side-head">
        <span className="pd-side-icon is-code">{"{ }"}</span>
        <div><h3>Fields</h3><p>Type them in your slides. Click one to copy it.</p></div>
      </header>
      {unknown.length > 0 && (
        <div className="pd-free">
          <span className="pd-sublabel is-warn">In your deck, filled in by the seller</span>
          <div className="pd-free-list">{unknown.map((t) => <code key={t}>{`{{${t}}}`}</code>)}</div>
        </div>
      )}
      <label className="pd-search">{Ico.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields" /></label>
      <div className="pd-groups">
        {groups.map((g) => {
          const items = DECK_TOKENS.filter((t) => t.group === g && match(t));
          if (!items.length) return null;
          const isOpen = !!q || openG === g;
          return (
            <div key={g} className={`pd-group ${isOpen ? "is-open" : ""}`}>
              <button className="pd-group-head" onClick={() => setOpenG(isOpen && !q ? null : g)}>
                <span>{g}</span><em>{items.length}</em>{Ico.chev}
              </button>
              {isOpen && (
                <div className="pd-group-body">
                  {g === "Repeat rows" && <p className="pd-muted">Put a <code>#</code> field in any cell of a table row and the row repeats once per phase, role or price row.</p>}
                  {items.map((t) => (
                    <button key={t.key} className={`pd-token ${usedSet.has(t.key.replace(/#/g, "N")) ? "is-used" : ""}`} onClick={() => copy(t.key)} title={`Example: ${t.example}`}>
                      <code>{`{{${t.key}}}`}</code>
                      <span className="pd-token-txt"><b>{t.label}</b><i>{t.example}</i></span>
                      <span className="pd-token-copy">{copied === t.key ? <em>Copied</em> : Ico.copy}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ul className="pd-tips">
        <li><b>N</b> is a number: <code>{"{{service.phase2.name}}"}</code> is the second phase.</li>
        <li>A field the deal doesn't have (a 5th phase…) comes out empty, and a box holding only empty fields disappears.</li>
        <li>Name a shape with a field (Selection pane, e.g. <code>{"{{product.y3.annual}}"}</code>) to hide it when that value is empty — handy for row backgrounds.</li>
        <li>Any other <code>{"{{name}}"}</code> becomes a field the seller types when generating.</li>
      </ul>
    </section>
  );
}

/* ============================ Slide editor ============================ */
/**
 * Edits the deck itself: move and resize boxes, edit texts, add text boxes,
 * put {{fields}} in, hide a box when a field is empty. Changes stay pending
 * (drawn live from the open deck) until "Save to deck" writes a new .pptx.
 */
const EMU_CM = 360000;
const cm = (emu: number) => Math.round((emu / EMU_CM) * 100) / 100;
export type Box = { x: number; y: number; w: number; h: number };
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const KIND_LABEL: Record<EditShape["kind"], string> = { text: "Text box", shape: "Shape", picture: "Picture", table: "Table", group: "Group", line: "Line" };
const DSE_ICON = {
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3",
  text: "M4 7V5h16v2M9 19h6M12 5v14",
  close: "M6 6l12 12M18 6L6 18",
  dup: "M9 9h11v11H9zM5 15H4V4h11v1",
  del: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  front: "M8 8h12v12H8zM4 4h12v2M4 4v12h2",
  back: "M4 4h12v12H4zM20 8v12H8v-2",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  field: "M8 4H6a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-2",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  save: "M5 3h11l3 3v15H5zM8 3v6h8M8 21v-7h8v7",
  layers: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  plus: "M12 5v14M5 12h14", minus: "M5 12h14",
  pic: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4",
  shape: "M4 6h16v12H4z", table: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  group: "M4 4h7v7H4zM13 13h7v7h-7zM13 4h7v7h-7", line: "M4 20L20 4",
};
export const DIco = ({ d }: { d: keyof typeof DSE_ICON }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={DSE_ICON[d]} /></svg>
);
const kindIco = (k: EditShape["kind"]): keyof typeof DSE_ICON => (k === "text" ? "text" : k === "picture" ? "pic" : k === "table" ? "table" : k === "group" ? "group" : k === "line" ? "line" : "shape");
/** The conditions in a shape name: {{?key}} (shown only when key has a value). */
const condsOf = (name: string) => tokensIn(name).filter((t) => t.startsWith("?")).map((t) => t.slice(1));
const withConds = (name: string, conds: string[]) => `${name.replace(/\s*\{\{\s*\?[^{}]*\}\}/g, "").trim() || "Shape"}${conds.map((c) => ` {{?${c}}}`).join("")}`;
const plainName = (name: string) => name.replace(/\s*\{\{[^{}]*\}\}/g, "").trim();

/** Moves / scales the drawn shapes of one top-level shape from box a to box b (while dragging). */
function warpSlide(slide: PvSlide, sid: string, a: Box, b: Box): PvSlide {
  const sx = a.w ? b.w / a.w : 1, sy = a.h ? b.h / a.h : 1;
  return {
    ...slide,
    shapes: slide.shapes.map((s) => {
      if (s.layer !== "slide" || s.top !== sid) return s;
      const out: PvShape = { ...s, x: b.x + (s.x - a.x) * sx, y: b.y + (s.y - a.y) * sy, w: s.w * sx, h: s.h * sy };
      if (s.table) out.table = { ...s.table, cols: s.table.cols.map((c) => c * sx), rows: s.table.rows.map((r) => ({ ...r, h: r.h * sy })) };
      return out;
    }),
  };
}

/** A slide as a canvas draws it: the slide with the changes `ops` (the very array it was drawn with). */
export interface CanvasView { n: number; slide: PvSlide; shapes: EditShape[]; nextId: number; ops: DeckEditOp[] }

/** The changes a view hasn't drawn yet (it was drawn with the start of `ops`). */
export function pendingOf(view: CanvasView | null, ops: DeckEditOp[]): DeckEditOp[] {
  if (!view) return [];
  let i = 0;
  while (i < ops.length && i < view.ops.length && ops[i] === view.ops[i]) i++;
  return ops.slice(i);
}
/** The paragraph (edit key) under the pointer, through the boxes drawn over the slide. */
const paraAt = (x: number, y: number): string | undefined =>
  (document.elementsFromPoint(x, y).find((el) => (el as HTMLElement).classList?.contains("spv-p") && (el as HTMLElement).dataset.key) as HTMLElement | undefined)?.dataset.key;

const SCV_PAD = 36, SCV_TOP = 40, SCV_BOTTOM = 76;

/**
 * The slide on a stage you can edit: click to select a box, drag to move, handles to
 * resize, snapping guides. Steady while you work: the slide keeps its size, a change
 * shows at once (before the slide is redrawn), and images are never reloaded.
 */
export function SlideCanvas({ cx, cy, n, view, ops, sel, onSel, zoom = 1, onCommit, editable = true, values, edits, refId, highlightKey, onPickText, onDblShape, hide, hideText, overlay, footer, children, onBackground, loading, outline }: {
  cx: number; cy: number; n: number;
  view: CanvasView | null;
  /** The changes on this slide now (the view may be a step behind). */
  ops: DeckEditOp[];
  sel: string | null; onSel: (sid: string | null) => void;
  zoom?: number;
  onCommit: (ops: DeckEditOp[]) => void;
  editable?: boolean;
  values?: Record<string, string>; edits?: Record<string, string>; refId?: string; highlightKey?: string | null;
  /** A click (no drag) on a text: the paragraph clicked. */
  onPickText?: (key: string) => void;
  onDblShape?: (s: EditShape, key?: string) => void;
  hide?: string[];
  hideText?: string[];
  /** More things over the slide, in slide pixels (k = px per EMU). */
  overlay?: (k: number, box: (s: EditShape) => Box) => React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  onBackground?: () => void;
  loading?: React.ReactNode;
  /** A box to outline (hovered in a list beside). */
  outline?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const measure = () => setRoom((r) => (r.w === el.clientWidth && r.h === el.clientHeight ? r : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fitW = Math.max(200, Math.floor(Math.min(room.w - SCV_PAD * 2, (room.h - SCV_TOP - SCV_BOTTOM) * (cx / cy))));
  const width = Math.round(fitW * zoom);
  const height = Math.round((width * cy) / cx);
  const k = width / cx;

  const [hover, setHover] = useState<string | null>(null);
  const [drag, setDrag] = useState<null | { sid: string; mode: "move" | Handle; sx: number; sy: number; orig: Box; box: Box; moved: boolean }>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });

  const v = view && view.n === n ? view : null;
  // what the view hasn't drawn yet shows at once: moved boxes where they go, deleted ones gone
  const pending = pendingOf(v, ops);
  const pendBox = new Map<string, Box>();
  const pendGone = new Set<string>();
  pending.forEach((o) => {
    if (o.op === "xfrm") pendBox.set(o.sid, { x: o.x, y: o.y, w: o.w, h: o.h });
    if (o.op === "delete") pendGone.add(o.sid);
  });
  const shapes: EditShape[] = (v?.shapes ?? []).filter((s) => !pendGone.has(s.sid)).map((s) => (pendBox.has(s.sid) ? { ...s, ...pendBox.get(s.sid)! } : s));
  const shown = useMemo(() => {
    if (!v) return null;
    let sl = v.slide;
    pendBox.forEach((b, sid) => { const s0 = v.shapes.find((x) => x.sid === sid); if (s0) sl = warpSlide(sl, sid, s0, b); });
    if (drag?.moved) sl = warpSlide(sl, drag.sid, drag.orig, drag.box);
    return sl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, drag, pending.length, JSON.stringify(Array.from(pendBox))]);
  const hidden = useMemo(() => [...(hide ?? []), ...pendGone], [hide?.join(), Array.from(pendGone).join()]);
  const boxOf = (s: EditShape): Box => (drag?.moved && drag.sid === s.sid ? drag.box : s);
  const cur = shapes.find((s) => s.sid === sel) ?? null;

  /* ---- snapping ---- */
  const snap = (b: Box, mode: "move" | Handle, sid: string): { box: Box; gx: number[]; gy: number[] } => {
    const th = 6 / k;
    const others = shapes.filter((s) => s.sid !== sid);
    const xs = [0, cx / 2, cx, ...others.flatMap((s) => [s.x, s.x + s.w / 2, s.x + s.w])];
    const ys = [0, cy / 2, cy, ...others.flatMap((s) => [s.y, s.y + s.h / 2, s.y + s.h])];
    const out = { ...b }; const gx: number[] = [], gy: number[] = [];
    const best = (cands: number[], vals: number[]) => {
      let bd = th, bv: number | null = null, bi = -1;
      vals.forEach((val, i) => cands.forEach((c) => { const d = Math.abs(c - val); if (d < bd) { bd = d; bv = c - val; bi = i; } }));
      return bv === null ? null : { delta: bv as number, i: bi };
    };
    if (mode === "move") {
      const bx = best(xs, [b.x, b.x + b.w / 2, b.x + b.w]); if (bx) { out.x += bx.delta; gx.push([out.x, out.x + out.w / 2, out.x + out.w][bx.i]); }
      const by = best(ys, [b.y, b.y + b.h / 2, b.y + b.h]); if (by) { out.y += by.delta; gy.push([out.y, out.y + out.h / 2, out.y + out.h][by.i]); }
    } else {
      if (mode.includes("w")) { const r = best(xs, [b.x]); if (r) { out.x += r.delta; out.w -= r.delta; gx.push(out.x); } }
      if (mode.includes("e")) { const r = best(xs, [b.x + b.w]); if (r) { out.w += r.delta; gx.push(out.x + out.w); } }
      if (mode.includes("n")) { const r = best(ys, [b.y]); if (r) { out.y += r.delta; out.h -= r.delta; gy.push(out.y); } }
      if (mode.includes("s")) { const r = best(ys, [b.y + b.h]); if (r) { out.h += r.delta; gy.push(out.y + out.h); } }
    }
    return { box: out, gx, gy };
  };

  /* ---- pointer ---- */
  const startDrag = (e: React.PointerEvent, s: EditShape, mode: "move" | Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    if (sel !== s.sid) onSel(s.sid);
    const orig = { x: s.x, y: s.y, w: s.w, h: s.h };
    setDrag({ sid: s.sid, mode, sx: e.clientX, sy: e.clientY, orig, box: orig, moved: false });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
      const dx = (e.clientX - drag.sx) / k, dy = (e.clientY - drag.sy) / k;
      const o = drag.orig;
      let b: Box = { ...o };
      if (drag.mode === "move") b = { ...o, x: o.x + dx, y: o.y + dy };
      else {
        const m = drag.mode;
        if (m.includes("e")) b.w = o.w + dx;
        if (m.includes("w")) { b.x = o.x + dx; b.w = o.w - dx; }
        if (m.includes("s")) b.h = o.h + dy;
        if (m.includes("n")) { b.y = o.y + dy; b.h = o.h - dy; }
        if (e.shiftKey && o.w > 0 && o.h > 0 && m.length === 2) {
          const r = o.w / o.h;
          if (Math.abs(b.w / o.w) > Math.abs(b.h / o.h)) { const nh = b.w / r; if (m.includes("n")) b.y += b.h - nh; b.h = nh; }
          else { const nw = b.h * r; if (m.includes("w")) b.x += b.w - nw; b.w = nw; }
        }
        const min = 12700 * 4;
        if (b.w < min) { if (m.includes("w")) b.x -= min - b.w; b.w = min; }
        const minH = o.h < min ? o.h : min;
        if (b.h < minH) { if (m.includes("n")) b.y -= minH - b.h; b.h = minH; }
      }
      const sn = e.altKey ? { box: b, gx: [], gy: [] } : snap(b, drag.mode, drag.sid);
      setGuides((g) => (g.x.join() === sn.gx.join() && g.y.join() === sn.gy.join() ? g : { x: sn.gx, y: sn.gy }));
      setDrag({ ...drag, box: sn.box, moved: true });
    };
    const up = (e: PointerEvent) => {
      if (drag.moved) onCommit([{ op: "xfrm", n, sid: drag.sid, x: drag.box.x, y: drag.box.y, w: drag.box.w, h: drag.box.h }]);
      else if (onPickText && drag.mode === "move") { const key = paraAt(e.clientX, e.clientY); if (key) onPickText(key); }
      setDrag(null); setGuides({ x: [], y: [] });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, k]);

  return (
    <div className="scv">
      <div className="scv-scroll" ref={scrollRef} onPointerDown={() => onBackground?.()}>
        <div className="scv-pad" style={{ minWidth: width + SCV_PAD * 2, minHeight: height + SCV_TOP + SCV_BOTTOM, padding: `${SCV_TOP}px ${SCV_PAD}px ${SCV_BOTTOM}px` }}>
          {!shown || room.w === 0 ? (
            <div className="scv-loading">{loading ?? <><span className="pd-spin" />Drawing the slide…</>}</div>
          ) : (
            <div className="scv-canvas" style={{ width, height }}>
              <SlidePreview deck={{ cx, cy, slides: [shown], info: null as any }} n={n} refId={refId} values={values} edits={edits} width={width}
                highlightKey={highlightKey} hide={hidden} hideText={hideText} className="scv-slide"
                onPickText={!editable ? onPickText : undefined} />
              {editable && (
                <div className="scv-overlay" onPointerLeave={() => setHover(null)}>
                  {shapes.map((s) => {
                    const b = boxOf(s);
                    const tw = b.w * k < 8, th = b.h * k < 8;
                    return (
                      <div key={s.sid} className={`scv-hit ${sel === s.sid ? "is-sel" : ""} ${(hover === s.sid || outline === s.sid) && sel !== s.sid && !drag ? "is-hover" : ""}`}
                        style={{ left: b.x * k - (tw ? 4 : 0), top: b.y * k - (th ? 4 : 0), width: Math.max(8, b.w * k), height: Math.max(8, b.h * k), transform: s.rot ? `rotate(${s.rot}deg)` : undefined, zIndex: sel === s.sid ? 2 : undefined }}
                        onPointerEnter={() => setHover(s.sid)}
                        onPointerDown={(e) => startDrag(e, s, "move")}
                        onDoubleClick={(e) => { e.stopPropagation(); onDblShape?.(s, paraAt(e.clientX, e.clientY)); }}
                        title={plainName(s.name) || KIND_LABEL[s.kind]} />
                    );
                  })}
                  {cur && (() => {
                    const b = boxOf(cur);
                    return (
                      <div className="scv-sel" style={{ left: b.x * k, top: b.y * k, width: Math.max(1, b.w * k), height: Math.max(1, b.h * k) }}>
                        <span className="scv-sel-tag">{plainName(cur.name) || KIND_LABEL[cur.kind]}{condsOf(cur.name).length > 0 && <i title="Shown only when a field has a value"><DIco d="eye" /></i>}</span>
                        {HANDLES.map((h) => <span key={h} className={`scv-h is-${h}`} onPointerDown={(e) => startDrag(e, cur, h)} />)}
                        {drag?.moved && <span className="scv-sel-size">{cm(b.w)} × {cm(b.h)} cm</span>}
                      </div>
                    );
                  })()}
                  {guides.x.map((x, i) => <span key={`gx${i}`} className="scv-guide is-v" style={{ left: x * k }} />)}
                  {guides.y.map((y, i) => <span key={`gy${i}`} className="scv-guide is-h" style={{ top: y * k }} />)}
                  {overlay?.(k, boxOf)}
                </div>
              )}
              {children}
            </div>
          )}
        </div>
      </div>
      {footer && <div className="scv-foot" onPointerDown={(e) => e.stopPropagation()}>{footer}</div>}
    </div>
  );
}

export function DeckSlideEditor({ buf, base, startN, deckName, onSave, onClose }: {
  buf: ArrayBuffer;
  /** The deck as saved (thumbnails of slides without changes). */
  base: PvDeck;
  startN: number;
  deckName: string;
  /** Writes the new file; returns an error message or null. */
  onSave: (blob: Blob) => Promise<string | null>;
  onClose: () => void;
}) {
  const [ses, setSes] = useState<DeckEditSession | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [n, setN] = useState(startN);
  const [ops, setOps] = useState<DeckEditOp[]>([]);
  const [past, setPast] = useState<DeckEditOp[][]>([]);
  const [future, setFuture] = useState<DeckEditOp[][]>([]);
  const [view, setView] = useState<CanvasView | null>(null);
  const [rendered, setRendered] = useState<Record<number, PvSlide>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [inline, setInline] = useState<null | { sid: string; text: string; closing?: boolean }>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [askClose, setAskClose] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fieldsFor, setFieldsFor] = useState<null | { anchor: DOMRect }>(null);
  const [layerHover, setLayerHover] = useState<string | null>(null);
  const lastNudge = useRef<{ sid: string; at: number } | null>(null);
  /** The text field the user typed in last (for "Insert field"). */
  const focusField = useRef<{ el: HTMLTextAreaElement | HTMLInputElement; apply: (v: string) => void } | null>(null);
  const renderSeq = useRef(0);

  // open the deck once
  useEffect(() => {
    let alive = true;
    let opened: DeckEditSession | null = null;
    openDeckEditor(buf).then((s) => { if (alive) { opened = s; setSes(s); } else s.dispose(); }).catch((e) => alive && setLoadErr(e.message ?? String(e)));
    return () => { alive = false; opened?.dispose(); };
  }, [buf]);

  // draw the current slide with its pending changes (the canvas shows moves at once, before this lands)
  const opsN = useMemo(() => ops.filter((o) => o.n === n), [ops, n]);
  useEffect(() => {
    if (!ses) return;
    const seq = ++renderSeq.current;
    const these = opsN;
    ses.render(n, these).then((r) => {
      if (seq !== renderSeq.current) return;
      setView({ n, ...r, ops: these });
      setRendered((m) => (m[n] === r.slide ? m : { ...m, [n]: r.slide }));
    }).catch((e) => setLoadErr(e.message ?? String(e)));
  }, [ses, n, opsN]);
  const caughtUp = !!view && view.n === n && pendingOf(view, opsN).length === 0;
  // a text typed on the slide stays drawn by the editor until the slide is redrawn with it (no flash of the old text)
  useEffect(() => { if (inline?.closing && caughtUp) setInline(null); }, [inline?.closing, caughtUp]);

  const dirty = ops.length > 0 && saving !== "saved";
  const dirtyNs = useMemo(() => new Set(ops.map((o) => o.n)), [ops]);
  useEffect(() => {
    if (!ops.length) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [ops.length]);

  /* ---- changes ---- */
  const commit = (add: DeckEditOp[], opts: { merge?: boolean } = {}) => {
    if (!add.length) return;
    setSaving("idle");
    if (opts.merge && ops.length) { setOps([...ops.slice(0, -1), ...add]); return; }
    setPast((p) => [...p.slice(-80), ops]); setFuture([]);
    setOps([...ops, ...add]);
  };
  const undo = () => { if (!past.length) return; setFuture((f) => [ops, ...f]); setOps(past[past.length - 1]); setPast((p) => p.slice(0, -1)); lastNudge.current = null; };
  const redo = () => { if (!future.length) return; setPast((p) => [...p, ops]); setOps(future[0]); setFuture((f) => f.slice(1)); lastNudge.current = null; };

  // the shapes as they are now (pending moves included)
  const shapes = useMemo(() => {
    if (!view || view.n !== n) return [];
    const pend = pendingOf(view, opsN);
    const box = new Map<string, Box>(), gone = new Set<string>();
    pend.forEach((o) => { if (o.op === "xfrm") box.set(o.sid, { x: o.x, y: o.y, w: o.w, h: o.h }); if (o.op === "delete") gone.add(o.sid); });
    return view.shapes.filter((s) => !gone.has(s.sid)).map((s) => (box.has(s.sid) ? { ...s, ...box.get(s.sid)! } : s));
  }, [view, n, opsN]);
  const cur = shapes.find((s) => s.sid === sel) ?? null;
  const setBox = (s: EditShape, b: Box, merge = false) => commit([{ op: "xfrm", n, sid: s.sid, x: b.x, y: b.y, w: b.w, h: b.h }], { merge });
  const del = (s: EditShape) => { commit([{ op: "delete", n, sid: s.sid }]); setSel(null); };
  const dup = (s: EditShape) => {
    if (!view) return;
    const newSid = String(view.nextId);
    commit([{ op: "duplicate", n, sid: s.sid, newSid, dx: 228600, dy: 228600 }]);
    setSel(newSid);
  };
  const addText = () => {
    if (!view) return;
    const sid = String(view.nextId);
    const w = base.cx * 0.34, h = base.cy * 0.09;
    commit([{ op: "add", n, sid, x: (base.cx - w) / 2, y: (base.cy - h) / 2, w, h, text: "New text", size: 18, color: "#0B0E63", align: "l" }]);
    setSel(sid);
  };
  const order = (s: EditShape, dir: "forward" | "backward" | "front" | "back") => commit([{ op: "order", n, sid: s.sid, dir }]);
  const setText = (sid: string, paras: string[], cell?: { r: number; c: number }) => commit([{ op: "text", n, sid, paras, ...(cell ? { cell } : {}) }]);
  const setStyle = (s: EditShape, st: Omit<Extract<DeckEditOp, { op: "style" }>, "op" | "n" | "sid">) => commit([{ op: "style", n, sid: s.sid, ...st }]);
  const rename = (s: EditShape, name: string) => { if (name !== s.name) commit([{ op: "name", n, sid: s.sid, name }]); };
  const openInline = (s: EditShape) => { if (s.kind === "text" && s.paras) setInline({ sid: s.sid, text: s.paras.join("\n") }); };

  /* ---- keys ---- */
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = /input|textarea|select/i.test(t?.tagName ?? "") || t?.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
      if (e.key === "Escape") {
        if (fieldsFor) { setFieldsFor(null); return; }
        if (inline && !inline.closing) { setInline(null); return; }
        if (typing) { t.blur(); return; }
        if (askClose) { setAskClose(false); return; }
        if (sel) { setSel(null); return; }
        tryClose(); return;
      }
      if (typing || !cur) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); del(cur); return; }
      if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); dup(cur); return; }
      if (e.key === "Enter" && cur.kind === "text" && cur.paras) { e.preventDefault(); openInline(cur); return; }
      const step = (e.shiftKey ? 10 : 1) * 12700;
      const d = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
      if (d) {
        e.preventDefault();
        const ln = lastNudge.current;
        const merge = !!ln && ln.sid === cur.sid && Date.now() - ln.at < 900;
        lastNudge.current = { sid: cur.sid, at: Date.now() };
        setBox(cur, { x: cur.x + d[0], y: cur.y + d[1], w: cur.w, h: cur.h }, merge);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  /* ---- save / close ---- */
  const save = async () => {
    if (!ses || !ops.length || saving === "saving") return;
    setSaving("saving"); setSaveErr(null);
    try {
      const blob = await ses.save(ops);
      const err = await onSave(blob);
      if (err) { setSaving("error"); setSaveErr(err); return; }
      // keep editing on the saved file
      const next = await openDeckEditor(await blob.arrayBuffer());
      ses.dispose();
      setSes(next); setOps([]); setPast([]); setFuture([]); setRendered({}); setSaving("saved");
    } catch (e: any) { setSaving("error"); setSaveErr(e.message ?? String(e)); }
  };
  const tryClose = () => { if (ops.length && saving !== "saved") setAskClose(true); else onClose(); };
  useEffect(() => { if (saving !== "saved") return; const t = setTimeout(() => setSaving("idle"), 2600); return () => clearTimeout(t); }, [saving]);

  /* ---- insert a field ---- */
  const insertField = (key: string) => {
    const f = focusField.current;
    const tok = `{{${key}}}`;
    setFieldsFor(null);
    if (f && document.body.contains(f.el)) {
      const el = f.el;
      const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
      const v = el.value.slice(0, a) + tok + el.value.slice(b);
      f.apply(v);
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tok.length, a + tok.length); });
      return;
    }
    if (cur?.kind === "text") setText(cur.sid, [...(cur.paras ?? []).filter((p, i, arr) => p || i < arr.length - 1), tok]);
  };
  const track = (el: HTMLTextAreaElement | HTMLInputElement, apply: (v: string) => void) => { focusField.current = { el, apply }; };

  const deckOf = (slide: PvSlide): PvDeck => ({ cx: base.cx, cy: base.cy, slides: [slide], info: base.info });
  const curIdx = base.slides.findIndex((s) => s.n === n);
  const goTo = (m: number) => { if (m === n) return; setN(m); setSel(null); setInline(null); };

  if (loadErr) {
    return createPortal(
      <div className="dse"><div className="dse-fail"><b>The deck couldn't be opened for editing.</b><span>{loadErr}</span><button className="dse-btn" onClick={onClose}>Close</button></div></div>,
      document.body,
    );
  }

  return createPortal(
    <div className="dse" role="dialog" aria-label={`Edit slide ${n}`}>
      {/* ---- top bar ---- */}
      <header className="dse-bar">
        <button className="dse-icon" onClick={tryClose} aria-label="Close editor" title="Close (Esc)"><DIco d="close" /></button>
        <div className="dse-title">
          <span className="dse-eyebrow">Edit deck · {deckName}</span>
          <b>Slide {n} <em>of {base.slides.length}</em></b>
        </div>
        <div className="dse-tools">
          <button className="dse-icon" onClick={undo} disabled={!past.length} title="Undo (⌘Z)" aria-label="Undo"><DIco d="undo" /></button>
          <button className="dse-icon" onClick={redo} disabled={!future.length} title="Redo (⇧⌘Z)" aria-label="Redo"><DIco d="redo" /></button>
          <span className="dse-sep" />
          <button className="dse-btn" onClick={addText} disabled={!view}><DIco d="text" />Add text box</button>
          <span className="dse-sep" />
          <div className="dse-zoom">
            <button onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 4) / 4))} aria-label="Zoom out"><DIco d="minus" /></button>
            <button className="is-pct" onClick={() => setZoom(1)} title="Fit to screen">{zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}</button>
            <button onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.25) * 4) / 4))} aria-label="Zoom in"><DIco d="plus" /></button>
          </div>
        </div>
        <div className="dse-save">
          {askClose ? (
            <span className="dse-ask">
              Discard your changes?
              <button className="dse-btn is-sm" onClick={() => setAskClose(false)}>Keep editing</button>
              <button className="dse-btn is-sm is-danger" onClick={onClose}>Discard</button>
            </span>
          ) : (
            <>
              <span className={`dse-state is-${saving === "idle" ? (dirty ? "dirty" : "clean") : saving}`}>
                {saving === "saving" ? "Saving…" : saving === "saved" ? "Saved to the deck" : saving === "error" ? (saveErr ?? "Not saved") : dirty ? `${ops.length} unsaved change${ops.length === 1 ? "" : "s"}` : "No changes"}
              </span>
              <button className="dse-btn is-primary" onClick={save} disabled={!ops.length || saving === "saving"}><DIco d="save" />Save to deck</button>
            </>
          )}
        </div>
      </header>

      <div className="dse-body">
        {/* ---- slide strip ---- */}
        <nav className="dse-strip" aria-label="Slides">
          {base.slides.map((s) => {
            const pv = rendered[s.n];
            return (
              <button key={s.n} className={`dse-thumb ${s.n === n ? "is-on" : ""}`} onClick={() => goTo(s.n)}>
                <span className="dse-thumb-n">{s.n}{dirtyNs.has(s.n) && <i title="Unsaved changes" />}</span>
                <StripSlide deck={pv ? deckOf(pv) : base} n={s.n} />
              </button>
            );
          })}
        </nav>

        {/* ---- canvas ---- */}
        <main className="dse-stage">
          <SlideCanvas cx={base.cx} cy={base.cy} n={n} view={ses ? view : null} ops={opsN} sel={sel} zoom={zoom} outline={layerHover}
            onSel={(sid) => { setSel(sid); if (inline && !inline.closing && inline.sid !== sid) setInline(null); }}
            onCommit={(o) => commit(o)}
            onBackground={() => { setSel(null); if (inline && !inline.closing) setInline(null); }}
            onDblShape={(s) => openInline(s)}
            hideText={inline ? [inline.sid] : undefined}
            loading={<><span className="pd-spin" />{ses ? "Drawing the slide…" : "Opening the deck…"}</>}
            overlay={(k) => {
              if (!inline || !view) return null;
              const s = shapes.find((x) => x.sid === inline.sid);
              if (!s) return null;
              const look = textLookOf(view.slide, s.sid, k);
              return (
                <InlineText key={s.sid} box={{ left: s.x * k, top: s.y * k, width: Math.max(40, s.w * k), minHeight: Math.max(18, s.h * k) }} look={look}
                  value={inline.text} readOnly={!!inline.closing} onFocusField={track}
                  onChange={(v) => setInline({ ...inline, text: v })}
                  onDone={(keep) => {
                    if (keep && inline.text !== (s.paras ?? []).join("\n")) { setText(s.sid, inline.text.split("\n")); setInline({ ...inline, closing: true }); }
                    else setInline(null);
                  }}
                  onFields={(r) => setFieldsFor({ anchor: r })} />
              );
            }}
            footer={(
              <div className="dse-hintbar">
                <button className="dse-nav" disabled={curIdx <= 0} onClick={() => goTo(base.slides[curIdx - 1].n)} aria-label="Previous slide"><DIco d="up" /></button>
                <span>Click a box to select · drag to move · double-click a text to edit · <kbd>Alt</kbd> turns off snapping</span>
                <button className="dse-nav" disabled={curIdx >= base.slides.length - 1} onClick={() => goTo(base.slides[curIdx + 1].n)} aria-label="Next slide"><DIco d="down" /></button>
              </div>
            )} />
        </main>

        {/* ---- inspector ---- */}
        <aside className="dse-side" onPointerDown={(e) => e.stopPropagation()}>
          {cur ? (
            <ShapePanel key={`${n}:${cur.sid}`} s={cur} slideW={base.cx} slideH={base.cy}
              onBox={(b) => setBox(cur, b)} onText={setText} onStyle={(st) => setStyle(cur, st)} onRename={(nm) => rename(cur, nm)}
              onOrder={(d) => order(cur, d)} onDup={() => dup(cur)} onDel={() => del(cur)} onFocusField={track}
              onFields={(r) => setFieldsFor({ anchor: r })} onEditInline={() => openInline(cur)} />
          ) : (
            <div className="dse-empty">
              <span className="dse-empty-ico"><DIco d="layers" /></span>
              <h3>Nothing selected</h3>
              <p>Click a box on the slide, or pick one below. Double-click a text to type on the slide.</p>
              <button className="dse-btn is-wide" onClick={addText} disabled={!view}><DIco d="text" />Add a text box</button>
              <ul className="dse-keys">
                <li><kbd>←↑→↓</kbd> nudge · <kbd>⇧</kbd> ×10</li>
                <li><kbd>⌘D</kbd> duplicate · <kbd>Del</kbd> delete</li>
                <li><kbd>⌘Z</kbd> undo · <kbd>⌘S</kbd> save</li>
              </ul>
            </div>
          )}
          <LayerList shapes={shapes} sel={sel} onPick={(sid) => { setSel(sid); setInline(null); }} onHover={setLayerHover} />
        </aside>
      </div>

      {fieldsFor && <FieldPicker anchor={fieldsFor.anchor} onPick={insertField} onClose={() => setFieldsFor(null)} />}
    </div>,
    document.body,
  );
}

/** How a text box's words look on the slide (for typing over it in place). */
export function textLookOf(slide: PvSlide, sid: string, k: number): InlineLook {
  const sh = slide.shapes.find((x) => x.layer === "slide" && x.top === sid && x.text) ?? slide.shapes.find((x) => x.layer === "slide" && x.sid === sid);
  const t = sh?.text;
  const p = t?.paras.find((x) => x.runs.some((r) => r.text.trim())) ?? t?.paras[0];
  const r = p?.runs.find((x) => x.text.trim()) ?? p?.runs[0];
  const pt = 12700 * k * (t?.scale ?? 1);
  return {
    size: Math.max(9, ((r?.size ?? p?.endSize ?? 18) * pt)),
    color: r?.color ?? p?.color ?? "#0b241a",
    font: r?.font ? `"${r.font}", Arial, sans-serif` : `${slide.font ? `"${slide.font}", ` : ""}Arial, sans-serif`,
    bold: !!r?.bold, italic: !!r?.italic,
    align: p?.align,
    pad: t ? `${t.t * k}px ${t.r * k}px ${t.b * k}px ${t.l * k}px` : "4px 6px",
    lineHeight: p?.lnSpc ? 1.18 * p.lnSpc : 1.18,
  };
}

function StripSlide({ deck, n }: { deck: PvDeck; n: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className="dse-thumb-img" style={{ aspectRatio: `${deck.cx} / ${deck.cy}` }}>{seen && <SlidePreview deck={deck} n={n} width={132} />}</div>;
}

/** Typing straight on the slide: one line per paragraph. */
export interface InlineLook { size: number; color: string; font: string; bold: boolean; italic: boolean; align?: string; pad: string; lineHeight: number }
/** Typing straight on the slide: the text box's own font, size and colour, in its own place (the drawn text is hidden meanwhile). */
export function InlineText({ box, look, value, readOnly, onChange, onDone, onFocusField, onFields }: {
  box: { left: number; top: number; width: number; minHeight: number }; look: InlineLook; value: string; readOnly?: boolean;
  onChange: (v: string) => void; onDone: (keep: boolean) => void;
  onFocusField: (el: HTMLTextAreaElement, apply: (v: string) => void) => void; onFields: (r: DOMRect) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => { const el = ref.current; if (el && !readOnly) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, []);
  useLayoutEffect(() => { const el = ref.current; if (el) { el.style.height = "0px"; el.style.height = `${Math.max(box.minHeight, el.scrollHeight)}px`; } }, [value, box.minHeight, look.size]);
  return (
    <div className={`dse-inline ${readOnly ? "is-closing" : ""}`} style={{ left: box.left, top: box.top, width: box.width }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea ref={ref} value={value} spellCheck={false} readOnly={readOnly}
        style={{ fontSize: look.size, color: look.color, fontFamily: look.font, fontWeight: look.bold ? 700 : 400, fontStyle: look.italic ? "italic" : undefined,
          textAlign: look.align === "ctr" ? "center" : look.align === "r" ? "right" : "left", padding: look.pad, lineHeight: look.lineHeight }}
        onFocus={(e) => onFocusField(e.currentTarget, onChange)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onDone(false); } if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onDone(true); } }}
        onBlur={(e) => { if (readOnly) return; if (e.relatedTarget && (e.relatedTarget === btn.current || (e.relatedTarget as HTMLElement).closest?.(".dse-fp"))) return; onDone(true); }} />
      {!readOnly && (
        <div className="dse-inline-bar">
          <button ref={btn} onMouseDown={(e) => e.preventDefault()} onClick={() => onFields(btn.current!.getBoundingClientRect())}><DIco d="field" />Insert field</button>
          <span>Enter = new paragraph · ⌘Enter to finish</span>
        </div>
      )}
    </div>
  );
}

/** The selected shape: position, texts, look, show-when, arrange. */
export function ShapePanel({ s, slideW, slideH, onBox, onText, onStyle, onRename, onOrder, onDup, onDel, onFocusField, onFields, onEditInline, mode = "template", ownText, onPickText }: {
  s: EditShape; slideW: number; slideH: number;
  /** "proposal": a seller's layout for one proposal — no names / conditions; the template's words are edited in the Text tab. */
  mode?: "template" | "proposal";
  /** A box added in this proposal: its words are part of the layout. */
  ownText?: boolean;
  onPickText?: () => void;
  onBox: (b: Box) => void; onText: (sid: string, paras: string[], cell?: { r: number; c: number }) => void;
  onStyle: (st: { size?: number; bold?: boolean; italic?: boolean; color?: string | null; align?: "l" | "ctr" | "r" | "just" }) => void;
  onRename: (name: string) => void; onOrder: (d: "forward" | "backward" | "front" | "back") => void; onDup: () => void; onDel: () => void;
  onFocusField: (el: HTMLTextAreaElement | HTMLInputElement, apply: (v: string) => void) => void; onFields: (r: DOMRect) => void; onEditInline: () => void;
}) {
  const [delAsk, setDelAsk] = useState(false);
  const [cond, setCond] = useState("");
  const conds = condsOf(s.name);
  const num = (label: string, v: number, set: (emu: number) => void, max: number) => (
    <label className="dse-num">
      <span>{label}</span>
      <input key={`${label}${v}`} type="number" step="0.1" defaultValue={cm(v)}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        onBlur={(e) => { const x = parseFloat(e.target.value.replace(",", ".")); if (Number.isFinite(x) && Math.abs(x - cm(v)) > 0.004) set(Math.max(-max, Math.min(max * 2, x * EMU_CM))); }} />
      <em>cm</em>
    </label>
  );
  const fieldBtn = (
    <button className="dse-chipbtn" onMouseDown={(e) => e.preventDefault()} onClick={(e) => onFields((e.currentTarget as HTMLElement).getBoundingClientRect())}><DIco d="field" />Insert field</button>
  );
  return (
    <div className="dse-panel">
      <div className="dse-panel-head">
        <span className={`dse-kind is-${s.kind}`}><DIco d={kindIco(s.kind)} /></span>
        <div>
          <span className="dse-eyebrow">{KIND_LABEL[s.kind]}{s.ph ? " · from the layout" : ""}</span>
          {mode === "proposal" ? <b className="dse-name is-static">{plainName(s.name) || KIND_LABEL[s.kind]}</b> : (
            <input key={s.name} className="dse-name" defaultValue={plainName(s.name)} placeholder={KIND_LABEL[s.kind]}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              onBlur={(e) => onRename(withConds(`${e.target.value}${tokensIn(s.name).filter((t) => !t.startsWith("?")).map((t) => ` {{${t}}}`).join("")}`, conds))} />
          )}
        </div>
      </div>

      <section className="dse-sec">
        <h4>Position &amp; size</h4>
        <div className="dse-grid4">
          {num("X", s.x, (v) => onBox({ x: v, y: s.y, w: s.w, h: s.h }), slideW)}
          {num("Y", s.y, (v) => onBox({ x: s.x, y: v, w: s.w, h: s.h }), slideH)}
          {num("W", s.w, (v) => onBox({ x: s.x, y: s.y, w: Math.max(12700, v), h: s.h }), slideW)}
          {num("H", s.h, (v) => onBox({ x: s.x, y: s.y, w: s.w, h: Math.max(s.kind === "line" ? 0 : 12700, v) }), slideH)}
        </div>
        <div className="dse-align">
          <button title="Centre horizontally on the slide" onClick={() => onBox({ x: (slideW - s.w) / 2, y: s.y, w: s.w, h: s.h })}>Centre ↔</button>
          <button title="Centre vertically on the slide" onClick={() => onBox({ x: s.x, y: (slideH - s.h) / 2, w: s.w, h: s.h })}>Centre ↕</button>
        </div>
      </section>

      {s.kind === "text" && s.paras && (mode === "template" || ownText) && (
        <section className="dse-sec">
          <div className="dse-sec-head"><h4>Text</h4>{fieldBtn}</div>
          <ParaFields paras={s.paras} onChange={(p) => onText(s.sid, p)} onFocusField={onFocusField} />
          <button className="dse-link" onClick={onEditInline}>Type on the slide instead</button>
        </section>
      )}
      {mode === "proposal" && !ownText && (s.kind === "text" || s.kind === "group" || s.kind === "table") && (
        <section className="dse-sec">
          <h4>Text</h4>
          <p className="dse-muted">Its words come from the template and the deal. Click the text on the slide to change them for this proposal.</p>
          {onPickText && <button className="dse-btn is-sm" onClick={onPickText}><DIco d="text" />Edit the words</button>}
        </section>
      )}
      {mode === "template" && s.kind === "group" && (s.children?.length ?? 0) > 0 && (
        <section className="dse-sec">
          <div className="dse-sec-head"><h4>Texts in this group</h4>{fieldBtn}</div>
          {s.children!.map((c) => (
            <div key={c.sid} className="dse-sub">
              <span className="dse-sub-name">{plainName(c.name) || "Text"}</span>
              <ParaFields paras={c.paras} onChange={(p) => onText(c.sid, p)} onFocusField={onFocusField} />
            </div>
          ))}
        </section>
      )}
      {mode === "template" && s.kind === "table" && (s.cells?.length ?? 0) > 0 && (
        <section className="dse-sec">
          <div className="dse-sec-head"><h4>Table cells</h4>{fieldBtn}</div>
          <p className="dse-muted">A row with a <code>#</code> field (e.g. <code>{"{{service.phase#.name}}"}</code>) repeats once per item.</p>
          <div className="dse-cells">
            {s.cells!.map((c) => (
              <label key={`${c.r}-${c.c}`} className="dse-cell">
                <span>R{c.r + 1} · C{c.c + 1}</span>
                <AutoArea value={c.paras.join("\n")} onFocusField={onFocusField} onCommit={(v) => onText(s.sid, v.split("\n"), { r: c.r, c: c.c })} />
              </label>
            ))}
          </div>
        </section>
      )}

      {(s.kind === "text" || s.kind === "group" || s.kind === "table") && (
        <section className="dse-sec">
          <h4>Text look</h4>
          <div className="dse-look">
            <label className="dse-num is-size">
              <input key={`sz${s.style?.size}`} type="number" min="4" max="200" step="0.5" defaultValue={s.style?.size ?? ""} placeholder="pt"
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                onBlur={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v !== s.style?.size) onStyle({ size: Math.max(4, Math.min(200, v)) }); }} />
              <em>pt</em>
            </label>
            <button className={`dse-tog ${s.style?.bold ? "is-on" : ""}`} onClick={() => onStyle({ bold: !s.style?.bold })} title="Bold"><b>B</b></button>
            <button className={`dse-tog ${s.style?.italic ? "is-on" : ""}`} onClick={() => onStyle({ italic: !s.style?.italic })} title="Italic"><i>I</i></button>
            <label className="dse-color" title="Text colour">
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(s.style?.color ?? "") ? s.style!.color! : "#000000"} onChange={(e) => onStyle({ color: e.target.value })} />
              <span style={{ background: s.style?.color ?? "#000" }} />
            </label>
            <div className="dse-seg">
              {(["l", "ctr", "r"] as const).map((a) => (
                <button key={a} className={(s.style?.align ?? "l") === a ? "is-on" : ""} onClick={() => onStyle({ align: a })} title={a === "l" ? "Left" : a === "ctr" ? "Centre" : "Right"}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d={a === "l" ? "M4 6h16M4 12h10M4 18h13" : a === "ctr" ? "M4 6h16M7 12h10M5 18h14" : "M4 6h16M10 12h10M7 18h13"} /></svg>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {mode === "template" && <section className="dse-sec">
        <h4>Show only when…</h4>
        <p className="dse-muted">Hide this box in a proposal when a field comes out empty (a 3-year price, a 2nd role…).</p>
        {conds.map((c) => (
          <div key={c} className="dse-cond">
            <DIco d="eye" /><span>Only when <code>{`{{${c}}}`}</code> has a value</span>
            <button onClick={() => onRename(withConds(s.name, conds.filter((x) => x !== c)))} aria-label="Remove condition"><DIco d="close" /></button>
          </div>
        ))}
        <div className="dse-cond-add">
          <input list="dse-token-list" value={cond} placeholder="Field, e.g. product.y3.annual" onChange={(e) => setCond(e.target.value.replace(/[{}?\s]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter" && cond) { onRename(withConds(s.name, Array.from(new Set([...conds, cond])))); setCond(""); } }} />
          <button className="dse-btn is-sm" disabled={!cond} onClick={() => { onRename(withConds(s.name, Array.from(new Set([...conds, cond])))); setCond(""); }}>Add</button>
          <datalist id="dse-token-list">{DECK_TOKENS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</datalist>
        </div>
      </section>}

      <section className="dse-sec">
        <h4>Arrange</h4>
        <div className="dse-arrange">
          <button onClick={() => onOrder("front")} title="Bring to front"><DIco d="front" />Bring to front</button>
          <button onClick={() => onOrder("back")} title="Send to back"><DIco d="back" />Send to back</button>
          <button onClick={() => onOrder("forward")} title="Bring forward"><DIco d="up" />Forward</button>
          <button onClick={() => onOrder("backward")} title="Send backward"><DIco d="down" />Backward</button>
        </div>
        <div className="dse-arrange is-2">
          <button onClick={onDup}><DIco d="dup" />Duplicate</button>
          {delAsk ? (
            <span className="dse-delask"><button className="is-danger" onClick={onDel}>Delete it</button><button onClick={() => setDelAsk(false)}>Keep</button></span>
          ) : <button className="is-danger" onClick={() => setDelAsk(true)}><DIco d="del" />Delete</button>}
        </div>
      </section>
    </div>
  );
}

/** One field per paragraph (a line break inside a paragraph shows as a new line in its field). */
function ParaFields({ paras, onChange, onFocusField }: {
  paras: string[]; onChange: (p: string[]) => void; onFocusField: (el: HTMLTextAreaElement, apply: (v: string) => void) => void;
}) {
  const list = paras.length ? paras : [""];
  return (
    <div className="dse-paras">
      {list.map((p, i) => (
        <div key={`${i}-${list.length}`} className="dse-para">
          <AutoArea value={p} onFocusField={onFocusField} onCommit={(v) => onChange(list.map((x, j) => (j === i ? v : x)))} />
          {list.length > 1 && <button className="dse-para-x" onClick={() => onChange(list.filter((_, j) => j !== i))} title="Remove paragraph" aria-label="Remove paragraph"><DIco d="close" /></button>}
        </div>
      ))}
      <button className="dse-link" onClick={() => onChange([...list, ""])}>+ Paragraph</button>
    </div>
  );
}

/** A textarea that grows and saves when you leave it (or ⌘Enter). */
function AutoArea({ value, onCommit, onFocusField }: { value: string; onCommit: (v: string) => void; onFocusField: (el: HTMLTextAreaElement, apply: (v: string) => void) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(value), [value]);
  useLayoutEffect(() => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; } }, [v]);
  const apply = (x: string) => { setV(x); if (x !== value) onCommit(x); };
  return (
    <textarea ref={ref} className="dse-area" rows={1} value={v} spellCheck={false}
      onFocus={(e) => onFocusField(e.currentTarget, apply)}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur(); }}
      onBlur={(e) => { if ((e.relatedTarget as HTMLElement | null)?.closest?.(".dse-fp, .dse-chipbtn")) return; if (v !== value) onCommit(v); }} />
  );
}

/** Every box of the slide, top first. */
export function LayerList({ shapes, sel, onPick, onHover }: { shapes: EditShape[]; sel: string | null; onPick: (sid: string) => void; onHover: (sid: string | null) => void }) {
  const [open, setOpen] = useState(true);
  const list = [...shapes].reverse();
  return (
    <section className={`dse-layers ${open ? "is-open" : ""}`}>
      <button className="dse-layers-head" onClick={() => setOpen((o) => !o)}><DIco d="layers" /><span>Boxes on this slide</span><em>{shapes.length}</em></button>
      {open && (
        <div className="dse-layers-list" onPointerLeave={() => onHover(null)}>
          {list.map((s) => {
            const txt = (s.paras ?? s.children?.flatMap((c) => c.paras) ?? s.cells?.flatMap((c) => c.paras) ?? []).join(" ").trim();
            return (
              <button key={s.sid} className={`dse-layer ${sel === s.sid ? "is-on" : ""}`} onClick={() => onPick(s.sid)} onPointerEnter={() => onHover(s.sid)}>
                <span className={`dse-kind is-${s.kind} is-xs`}><DIco d={kindIco(s.kind)} /></span>
                <span className="dse-layer-txt"><b>{txt || plainName(s.name) || KIND_LABEL[s.kind]}</b>{txt && <i>{plainName(s.name)}</i>}</span>
                {condsOf(s.name).length > 0 && <span className="dse-layer-cond" title="Shown only when a field has a value"><DIco d="eye" /></span>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Pick a {{field}} to insert (deal values, or a free one the seller types). */
export function FieldPicker({ anchor, onPick, onClose }: { anchor: DOMRect; onPick: (key: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [onClose]);
  const groups: DeckTokenDef["group"][] = ["General", "Product", "Service", "Repeat rows"];
  const match = (t: DeckTokenDef) => !q || `${t.key} ${t.label}`.toLowerCase().includes(q.toLowerCase());
  const custom = q.trim().replace(/[{}\s]+/g, "_").toLowerCase();
  const top = Math.min(anchor.bottom + 6, window.innerHeight - 440);
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - 372));
  return (
    <div ref={ref} className="dse-fp" style={{ top, left }} onMouseDown={(e) => e.preventDefault()} role="dialog" aria-label="Insert field">
      <label className="dse-fp-search"><DIco d="field" /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields or type a new one"
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Enter" && custom) onPick(DECK_TOKENS.find(match)?.key ?? custom); }} /></label>
      <div className="dse-fp-list">
        {groups.map((g) => {
          const items = DECK_TOKENS.filter((t) => t.group === g && match(t) && !t.key.startsWith("?"));
          if (!items.length) return null;
          return (
            <div key={g} className="dse-fp-group">
              <span className="dse-fp-g">{g}</span>
              {items.map((t) => (
                <button key={t.key} className="dse-fp-item" onClick={() => onPick(t.key)}>
                  <code>{`{{${t.key}}}`}</code><span><b>{t.label}</b><i>{t.example}</i></span>
                </button>
              ))}
            </div>
          );
        })}
        {custom && !DECK_TOKENS.some((t) => t.key === custom) && (
          <button className="dse-fp-item is-free" onClick={() => onPick(custom)}>
            <code>{`{{${custom}}}`}</code><span><b>New field the seller types</b><i>Asked when generating the proposal</i></span>
          </button>
        )}
      </div>
    </div>
  );
}
