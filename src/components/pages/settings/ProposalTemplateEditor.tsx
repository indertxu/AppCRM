/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PageLoader } from "../../framework/AppLayout";
import { createPortal } from "react-dom";
import Select from "../../framework/Select";
import {
  loadProposalTemplateRow, saveProposalTemplate, uploadBrandAsset, generateProposal, loadProposalTemplateRowFor, saveProposalTemplateFor, deleteProposalTemplate, type ProposalTemplateRow,
  listProposalDecks, uploadProposalDeck, replaceProposalDeckFile, saveProposalDeck, deleteProposalDeck, loadProposalDeckFile, deckSlidesFor, guessDeckRules, downloadBlob,
  type DeckSlideRule, type ProposalDeckRow,
  listDocTemplates, saveDocTemplate, deleteDocTemplate, setDefaultDocTemplate, docThemeSeed, uploadDocImage, loadDocVarDefs, type DocTemplateRow,
  listDocSources, trackingFileAsFile, suggestDocPlan, type DocSourceDoc, type DocSourceFile, type DocSuggestion,
} from "../sales/trackings/proposalApi";
import {
  defaultSlideTitle, previewTexts, repeatCount, isKnownToken, condFails, nameHides, loadDeckPreview, DECK_TOKENS, openDeckEditor, tokensIn,
  type ProposalData, type ProposalTemplate, type TemplateSection, type PvDeck, type PvShape, type PvText, type PvPara, type DeckInfo, type DeckTokenDef,
  type PvSlide, type DeckEditOp, type EditShape, type DeckEditSession,
  planDoc, docValues, renderDocHtml, renderDocBody, docCss, DOC_FONTS, DOC_BLOCKS, docBlockMeta, docTokenLabel, docUsedTokens, docFreeTokens,
  cleanRich, richToText, newDocBlock, newDocItem, cloneBlock, defaultDocTemplate, DEFAULT_DOC_THEME, importReferenceDoc,
  cleanSlideRich, docFontLinks, docVarCatalog, setDocCustomVars, docSampleValues, persistImported, webFont,
  applyDocPlan, matchCatalog, docVarColor,
  type SlideEl, type ImportedDoc, type DocVarSource,
  type DocTheme, type DocBlock, type DocBlockType, type DocKind, type DocLang, type DocTemplate, type DocContext, type DocPlaced, type DocRenderOptions,
} from "../sales/trackings/proposalGen";
import { listCrmOptions, DEFAULT_SECTORS } from "../companies/companiesApi";
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
  const [tab, setTab] = useState<"proposal" | "contract" | "deck" | "pdf">("proposal");
  const TABS: { k: typeof tab; label: string; d: string }[] = [
    { k: "proposal", label: "Proposals", d: "M4 4h16v16H4zM4 9h16M9 9v11" },
    { k: "contract", label: "Contracts", d: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 17c2-2 3 1 5-1s2-3 4-1" },
    { k: "deck", label: "PowerPoint (legacy)", d: "M3 4h18v13H3zM8 21h8M12 17v4" },
    { k: "pdf", label: "Order form (PDF)", d: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5" },
  ];
  return (
    <div className="st pd-page">
      <header className="st-bar st-bar-row pd-bar">
        <button className="st-back" onClick={onBack} aria-label="Back">‹</button>
        <div className="pd-bar-txt">
          <h1 className="st-title">Proposals & contracts</h1>
          <p className="st-sub">Web documents per sector, filled in from each deal — send the link or a PDF.</p>
        </div>
        <div className="pd-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.k} role="tab" aria-selected={tab === t.k} className={tab === t.k ? "is-on" : ""} onClick={() => setTab(t.k)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={t.d} /></svg>
              {t.label}
            </button>
          ))}
        </div>
      </header>
      {tab === "proposal" ? <DocTemplatesPanel key="p" kind="proposal" canManage={canManage} />
        : tab === "contract" ? <DocTemplatesPanel key="c" kind="contract" canManage={canManage} />
        : tab === "deck" ? <><div className="pte-flash is-info dxt-legacy"><span>PowerPoint decks still work for older proposals. New proposals are built as web pages from the Proposals tab.</span></div><DeckManager canManage={canManage} /></>
        : <ProposalTemplateEditor canManage={canManage} variant="orderform" />}
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

/* =====================================================================
 *  HTML documents — the builder (templates in Settings, proposals in a deal)
 * ===================================================================== */
const DXI = (d: string, w = 1.9) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const DX_ICON = {
  x: "M6 6l12 12M18 6L6 18", plus: "M12 5v14M5 12h14", eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  eyeOff: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22",
  grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01", up: "M12 19V5M5 12l7-7 7 7", down: "M12 5v14M19 12l-7 7-7-7",
  copy: "M9 9h11v11H9zM5 15V5a2 2 0 0 1 2-2h10", trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14", play: "M7 4l13 8-13 8z",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4", phone: "M7 2h10v20H7zM11 18h2", page: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  image: "M3 5h18v14H3zM8.5 10.5a1.5 1.5 0 1 0 0-.01M21 15l-5-5L5 19", search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  ext: "M14 3h7v7M10 14L21 3M21 14v7H3V3h7", spark: "M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z", check: "M5 12.5l4.5 4.5L19 7.5",
  undo: "M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 7", file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4",
  upload: "M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4", palette: "M12 22a10 10 0 1 1 10-10c0 2.2-1.8 3-4 3h-1.5a2 2 0 0 0-1.5 3.3A2 2 0 0 1 12 22zM7.5 11.5h.01M10.5 7.5h.01M15.5 7.5h.01",
  layers: "M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5", braces: "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6", fields: "M4 6h16M4 12h10M4 18h7",
};
const DIcon = ({ d, w }: { d: keyof typeof DX_ICON; w?: number }) => DXI(DX_ICON[d], w);

/** A document context without the template parts (the builder adds theme and terms). */
export type DocCtxIn = Omit<DocContext, "theme" | "terms">;
export interface DocCanvasApi { insertToken: (key: string) => boolean; flash: (key: string) => void; scrollTo: (blockId: string) => void; hasCaret: () => boolean }

/** The live document: an iframe in editing mode. Texts are typed in place; values are chips. */
/** Where a picture was dropped: on an element of a free page (el), or a point of it (x, y in page pixels). */
export interface DocDropAt { el?: number; x?: number; y?: number }
function DocCanvas({ theme, blocks, kind, lang, ctx, terms, productIds, serviceIds, values, chipsAsLabels, selected, selectedEl, width, onSelect, onSelectEl, onField, onAction, onImageDrop, onSlideEl, onTokenClick, onTextSelect, apiRef }: {
  theme: DocTheme; blocks: DocBlock[]; kind: DocKind; lang: DocLang; ctx: DocCtxIn; terms?: DocTemplate["terms"];
  productIds: string[]; serviceIds: string[]; values?: Record<string, string>; chipsAsLabels: boolean; selected: string | null; selectedEl?: string | null; width: number | null;
  onSelect: (id: string) => void; onSelectEl?: (blockId: string, idx: number | null) => void; onField: (path: string, value: string) => void; onAction: (act: string, id: string, k?: number) => void;
  /** a picture (a file, or the url of one from the library) dropped / pasted on a section */
  onImageDrop: (blockId: string, src: File | string, at?: DocDropAt) => void;
  /** an element of a free page was moved or resized */
  onSlideEl?: (blockId: string, idx: number, patch: Partial<SlideEl>) => void;
  onTokenClick?: (key: string) => void; apiRef: React.MutableRefObject<DocCanvasApi | null>;
  /** some text of the page is selected (where, on screen, and what it says) — null when not */
  onTextSelect?: (sel: { rect: DOMRect; text: string } | null) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const placed = useMemo(() => planDoc(blocks, ctx.data, productIds, serviceIds, true), [blocks, ctx.data, productIds, serviceIds]);
  const fullCtx = useMemo<DocContext>(() => ({ ...ctx, theme, terms }), [ctx, theme, terms]);
  const valsCache = useRef(new Map<string, Record<string, string>>());
  const valuesFor = useCallback((p: DocPlaced) => {
    const k = `${p.scope.product ?? ""}|${p.scope.service ?? ""}`;
    let v = valsCache.current.get(k);
    if (!v) { v = { ...docValues(fullCtx, p.scope), ...(values ?? {}) }; valsCache.current.set(k, v); }
    return v;
  }, [fullCtx, values]);
  useMemo(() => valsCache.current.clear(), [fullCtx, values]);
  const selRef = useRef(selected); selRef.current = selected;
  const opts = (): DocRenderOptions => ({ mode: "edit", placed, data: ctx.data, contract: ctx.contract, terms, kind, lang, valuesFor, chipsAsLabels, selected: selRef.current });
  const [initial] = useState(() => renderDocHtml(theme, opts()));
  const cb = useRef({ onSelect, onSelectEl, onField, onAction, onImageDrop, onSlideEl, onTokenClick, onTextSelect });
  cb.current = { onSelect, onSelectEl, onField, onAction, onImageDrop, onSlideEl, onTokenClick, onTextSelect };
  const selElRef = useRef(selectedEl ?? null); selElRef.current = selectedEl ?? null;
  const markEl = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll(".se.is-el").forEach((x) => x.classList.remove("is-el", "is-on"));
    const [b, i] = (selElRef.current ?? "").split(":");
    if (b && i != null) doc.querySelector(`.sl[data-b="${CSS.escape(b)}"] .se[data-i="${CSS.escape(i)}"]`)?.classList.add("is-el", "is-on");
  };
  const selfAt = useRef(0);
  const dirty = useRef(false);
  const range = useRef<Range | null>(null);
  const placedRef = useRef(placed); placedRef.current = placed;
  const valuesForRef = useRef(valuesFor); valuesForRef.current = valuesFor;
  const chipsRef = useRef(chipsAsLabels); chipsRef.current = chipsAsLabels;

  const paint = useCallback(() => {
    const doc = frame.current?.contentDocument;
    const main = doc?.getElementById("doc");
    if (!doc || !main) return;
    const se = doc.scrollingElement ?? doc.documentElement;
    const y = se.scrollTop;
    main.innerHTML = renderDocBody(theme, opts());
    se.scrollTop = y;
    doc.body.className = `dm-edit st-${theme.style ?? "soft"} k-${kind}`;
    const css = doc.getElementById("dx-css");
    if (css) css.textContent = docCss(theme);
    // the fonts of the theme and of the kept pages (one stylesheet per family; the ones already there stay)
    const have = new Set(Array.from(doc.querySelectorAll("link[rel=stylesheet]")).map((l) => l.getAttribute("href")));
    docFontLinks(theme).forEach((href) => { if (have.has(href)) return; const l = doc.createElement("link"); l.rel = "stylesheet"; l.href = href; doc.head.appendChild(l); });
    markEl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, placed, valuesFor, chipsAsLabels, kind, lang, terms]);

  useEffect(() => {
    if (!ready) return;
    if (Date.now() - selfAt.current < 600) { selfAt.current = 0; return; }   // the page already shows what was typed
    paint();
  }, [ready, paint]);
  // the selection alone just moves the outline
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    doc?.querySelectorAll("section.blk").forEach((s) => s.classList.toggle("is-sel", (s as HTMLElement).dataset.b === selected));
  }, [selected]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => markEl(), [selectedEl]);

  const serialize = (el: HTMLElement) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll(".tk").forEach((t) => t.replaceWith(el.ownerDocument.createTextNode(`{{${t.getAttribute("data-tk")}}}`)));
    c.querySelectorAll(".dx-tools,.dx-it-del,.dx-it-add,.dx-ins").forEach((x) => x.remove());
    c.querySelectorAll(".se-h,.se-x").forEach((x) => x.remove());
    // text of a kept page: its look (fonts, sizes, colours, spacing) stays
    if (el.dataset.rich === "2") return cleanSlideRich(c.innerHTML.replace(/​/g, ""));
    return el.dataset.rich ? cleanRich(c.innerHTML.replace(/​/g, "")) : (c.textContent ?? "").replace(/​/g, "").replace(/\s*\n\s*/g, " ");
  };
  const chipFor = (doc: Document, key: string, host: HTMLElement) => {
    const chip = doc.createElement("span");
    chip.className = "tk"; chip.contentEditable = "false"; chip.dataset.tk = key; chip.title = `{{${key}}}`;
    const sec = host.closest("section.blk") as HTMLElement | null;
    const p = placedRef.current.find((x) => `b-${x.key}` === sec?.id) ?? placedRef.current[0];
    const v = p ? valuesForRef.current(p)[key] : "";
    if (chipsRef.current) { chip.classList.add("is-label"); chip.textContent = docTokenLabel(key); }
    else { chip.textContent = v || docTokenLabel(key); if (!v) chip.classList.add("is-empty"); }
    return chip;
  };
  const insertAt = (r: Range, key: string): boolean => {
    const doc = frame.current?.contentDocument;
    if (!doc) return false;
    const node = r.startContainer.nodeType === 1 ? (r.startContainer as HTMLElement) : r.startContainer.parentElement;
    const host = node?.closest?.("[data-f]") as HTMLElement | null;
    if (!host) return false;
    r.deleteContents();
    const chip = chipFor(doc, key, host);
    r.insertNode(chip);
    const space = doc.createTextNode(" ");
    chip.after(space);
    host.focus();
    const sel = doc.getSelection();
    const after = doc.createRange(); after.setStartAfter(space); after.collapse(true);
    sel?.removeAllRanges(); sel?.addRange(after);
    range.current = after.cloneRange();
    host.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  };
  apiRef.current = {
    insertToken: (key) => (range.current && frame.current?.contentDocument?.contains(range.current.startContainer) ? insertAt(range.current, key) : false),
    hasCaret: () => !!range.current && !!frame.current?.contentDocument?.contains(range.current.startContainer),
    flash: (key) => {
      const doc = frame.current?.contentDocument;
      const els = Array.from(doc?.querySelectorAll(`.tk[data-tk="${CSS.escape(key)}"]`) ?? []) as HTMLElement[];
      if (!els.length) return;
      els[0].scrollIntoView({ behavior: "smooth", block: "center" });
      els.forEach((e) => { e.classList.remove("is-flash"); void e.offsetWidth; e.classList.add("is-flash"); setTimeout(() => e.classList.remove("is-flash"), 2900); });
    },
    scrollTo: (id) => (frame.current?.contentDocument?.querySelector(`section[data-b="${CSS.escape(id)}"]`) as HTMLElement | null)?.scrollIntoView({ behavior: "smooth", block: "start" }),
  };

  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.addEventListener("input", (e) => {
      const el = (e.target as HTMLElement)?.closest?.("[data-f]") as HTMLElement | null;
      if (!el) return;
      selfAt.current = Date.now(); dirty.current = true;
      cb.current.onField(el.dataset.f!, serialize(el));
    });
    doc.addEventListener("keydown", (e) => {
      const el = (e.target as HTMLElement)?.closest?.("[data-f]") as HTMLElement | null;
      if (el && e.key === "Enter" && !el.dataset.rich) { e.preventDefault(); el.blur(); }
      if (el && e.key === "Escape") el.blur();
      // the selected element of a free page (not while typing in it): Delete removes it, arrows nudge it
      if (!el && selElRef.current) {
        const [b, i] = selElRef.current.split(":");
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); cb.current.onAction("el-del", b, Number(i)); }
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] as number[] | undefined;
        if (d) {
          e.preventDefault();
          const se = doc.querySelector(`.sl[data-b="${CSS.escape(b)}"] .se[data-i="${CSS.escape(i)}"]`) as HTMLElement | null;
          if (se) { const st = e.shiftKey ? 10 : 1; cb.current.onSlideEl?.(b, Number(i), { x: (parseFloat(se.style.left) || 0) + d[0] * st, y: (parseFloat(se.style.top) || 0) + d[1] * st }); }
        }
      }
    });
    doc.addEventListener("paste", (e) => {
      const img = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (img) {
        // a pasted picture: on the free page / section where the caret (or the selection) is
        e.preventDefault();
        const at = (e.target as HTMLElement)?.closest?.("section.blk") as HTMLElement | null;
        const bid = at?.dataset.b ?? selRef.current;
        if (bid) cb.current.onImageDrop(bid, img);
        return;
      }
      const el = (e.target as HTMLElement)?.closest?.("[data-f]");
      if (!el) return;
      e.preventDefault();
      doc.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? "");
    });
    doc.addEventListener("selectionchange", () => {
      const s = doc.getSelection();
      if (!s?.rangeCount) return;
      const r = s.getRangeAt(0);
      const n = r.startContainer.nodeType === 1 ? (r.startContainer as HTMLElement) : r.startContainer.parentElement;
      const inText = !!n?.closest?.("[data-f]");
      if (inText) range.current = r.cloneRange();
      // a piece of text selected: offer to make it a variable (where it is, in the editor's coordinates)
      const txt = inText && !r.collapsed ? r.toString().trim() : "";
      if (txt && txt.length <= 160) {
        const rr = r.getBoundingClientRect(), fr = frame.current!.getBoundingClientRect();
        cb.current.onTextSelect?.({ rect: new DOMRect(fr.left + rr.left, fr.top + rr.top, rr.width, rr.height), text: txt });
      } else cb.current.onTextSelect?.(null);
    });
    doc.addEventListener("scroll", () => cb.current.onTextSelect?.(null), { passive: true });
    doc.addEventListener("focusout", () => {
      if (!dirty.current) return;
      setTimeout(() => {
        const a = doc.activeElement as HTMLElement | null;
        if (a?.closest?.("[data-f]")) return;      // moved to another text: repaint later
        if (!doc.hasFocus()) return;               // went to the side panels (e.g. to pick a value): keep the caret where it is
        dirty.current = false; selfAt.current = 0; paintRef.current();
      }, 0);
    });
    doc.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const act = t.closest?.("[data-act]") as HTMLElement | null;
      if (act) { e.preventDefault(); e.stopPropagation(); cb.current.onAction(act.dataset.act!, act.dataset.b ?? act.dataset.at ?? "", act.dataset.k != null ? Number(act.dataset.k) : undefined); return; }
      const tk = t.closest?.(".tk") as HTMLElement | null;
      if (tk) cb.current.onTokenClick?.(tk.dataset.tk!);
      if (t.closest?.("a") && !t.closest?.("[data-f]")) e.preventDefault();
      const sec = t.closest?.("section.blk") as HTMLElement | null;
      if (sec) cb.current.onSelect(sec.dataset.b!);
      const se = t.closest?.(".se") as HTMLElement | null, sl = t.closest?.(".sl") as HTMLElement | null;
      if (sl) cb.current.onSelectEl?.(sl.dataset.b!, se ? Number(se.dataset.i) : null);
    });
    const secOf = (e: DragEvent) => (e.target as HTMLElement)?.closest?.("section.blk") as HTMLElement | null;
    let over: HTMLElement | null = null;
    const mark = (s: HTMLElement | null) => { if (over === s) return; over?.classList.remove("is-drop"); over = s; s?.classList.add("is-drop"); };
    doc.addEventListener("dragover", (e) => {
      const types = Array.from(e.dataTransfer?.types ?? []);
      if (types.includes("application/x-doc-token")) {
        const r = (doc as any).caretRangeFromPoint?.(e.clientX, e.clientY) as Range | null;
        const n = r ? (r.startContainer.nodeType === 1 ? (r.startContainer as HTMLElement) : r.startContainer.parentElement) : null;
        if (n?.closest?.("[data-f]")) { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; }
      } else if (types.includes("Files") || types.includes("application/x-doc-asset")) { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; mark(secOf(e)); }
    });
    doc.addEventListener("dragleave", (e) => { if (!(e.relatedTarget as Node | null) || !doc.contains(e.relatedTarget as Node)) mark(null); });
    doc.addEventListener("drop", (e) => {
      mark(null);
      const key = e.dataTransfer?.getData("application/x-doc-token");
      if (key) {
        e.preventDefault();
        const r = (doc as any).caretRangeFromPoint?.(e.clientX, e.clientY) as Range | null;
        if (r) insertAt(r, key);
        return;
      }
      const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith("image/"));
      const src: File | string | undefined = file ?? (e.dataTransfer?.getData("application/x-doc-asset") || undefined);
      const sec = secOf(e);
      if (!src || !sec) return;
      e.preventDefault();
      // on a free page: onto a picture (replaces it) or anywhere (a new picture there)
      const sl = (e.target as HTMLElement)?.closest?.(".sl") as HTMLElement | null;
      if (sl) {
        const se = (e.target as HTMLElement).closest(".se-image") as HTMLElement | null;
        const r = sl.getBoundingClientRect(), k = r.width / (Number(sl.dataset.w) || 1280);
        cb.current.onImageDrop(sl.dataset.b!, src, se ? { el: Number(se.dataset.i) } : { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k });
        return;
      }
      cb.current.onImageDrop(sec.dataset.b!, src);
    });
    // move / resize the elements of a free page with their handles
    doc.addEventListener("pointerdown", (e) => {
      const h = (e.target as HTMLElement)?.closest?.(".se-h") as HTMLElement | null;
      if (!h) return;
      const se = h.closest(".se") as HTMLElement | null, sl = h.closest(".sl") as HTMLElement | null;
      if (!se || !sl) return;
      e.preventDefault(); e.stopPropagation();
      const k = sl.getBoundingClientRect().width / (Number(sl.dataset.w) || 1280);
      const W = Number(sl.dataset.w) || 1280, H = Number(sl.dataset.h) || 720;
      const st = { x: e.clientX, y: e.clientY, l: parseFloat(se.style.left) || 0, t: parseFloat(se.style.top) || 0, w: parseFloat(se.style.width) || 10, h: parseFloat(se.style.height) || 10 };
      const resize = h.dataset.el === "rs";
      const snap = (v: number, to: number[]) => { for (const s of to) if (Math.abs(v - s) < 6 / k) return s; return v; };
      let box = { x: st.l, y: st.t, w: st.w, h: st.h };
      se.classList.add("is-moving");
      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - st.x) / k, dy = (ev.clientY - st.y) / k;
        if (resize) {
          let w = Math.max(8, st.w + dx), hh = Math.max(8, st.h + dy);
          if (ev.shiftKey) hh = w * (st.h / st.w);   // keep the proportions
          box = { ...box, w: Math.round(w), h: Math.round(hh) };
        } else {
          // snaps to the page's edges and centre
          const x = snap(snap(st.l + dx, [0, W / 2 - st.w / 2, W - st.w]), []), y = snap(st.t + dy, [0, H / 2 - st.h / 2, H - st.h]);
          box = { ...box, x: Math.round(x), y: Math.round(y) };
        }
        se.style.left = `${box.x}px`; se.style.top = `${box.y}px`; se.style.width = `${box.w}px`; se.style.height = `${box.h}px`;
      };
      const onUp = () => {
        doc.removeEventListener("pointermove", onMove); doc.removeEventListener("pointerup", onUp);
        se.classList.remove("is-moving");
        if (box.x !== st.l || box.y !== st.t || box.w !== st.w || box.h !== st.h) cb.current.onSlideEl?.(sl.dataset.b!, Number(se.dataset.i), box);
      };
      doc.addEventListener("pointermove", onMove); doc.addEventListener("pointerup", onUp);
    });
    setReady(true);
  };
  const paintRef = useRef(paint); paintRef.current = paint;

  return (
    <div className={`dxb-canvas ${width ? "is-device" : ""}`}>
      <iframe ref={frame} title="Document" srcDoc={initial} onLoad={onLoad} style={width ? { width } : undefined} />
    </div>
  );
}

/** A finished document, animated, in a large overlay (with device sizes and "open in a tab"). */
function DocPreview({ html, onClose, title }: { html: string; onClose: () => void; title: string }) {
  const [dev, setDev] = useState<"web" | "tablet" | "phone">("web");
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }; window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true); }, [onClose]);
  const openTab = () => { const u = URL.createObjectURL(new Blob([html], { type: "text/html" })); window.open(u, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(u), 60000); };
  return createPortal(
    <div className="dxp" role="dialog" aria-modal="true" aria-label="Preview">
      <div className="dxp-bar">
        <b>{title}</b>
        <div className="dxb-seg">
          {(["web", "tablet", "phone"] as const).map((d) => (
            <button key={d} type="button" className={dev === d ? "is-on" : ""} onClick={() => setDev(d)}>
              <DIcon d={d === "phone" ? "phone" : "monitor"} />{d === "web" ? "Desktop" : d === "tablet" ? "Tablet" : "Phone"}
            </button>
          ))}
        </div>
        <button type="button" className="dxb-btn" onClick={openTab}><DIcon d="ext" />Open in a tab</button>
        <button type="button" className="dxb-x" onClick={onClose} aria-label="Close preview"><DIcon d="x" w={2.2} /></button>
      </div>
      <div className="dxp-stage">
        <iframe key={dev} title="Preview" srcDoc={html} className={`dxp-frame is-${dev}`} />
      </div>
    </div>,
    document.body,
  );
}

/** Picks the kind of block to add. */
function BlockPicker({ kind, onPick, onClose }: { kind: DocKind; onPick: (t: DocBlockType) => void; onClose: () => void }) {
  const list = [...DOC_BLOCKS].sort((a, b) => Number(b.kinds.includes(kind)) - Number(a.kinds.includes(kind)));
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }; window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true); }, [onClose]);
  return createPortal(
    <div className="dxk-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dxk" role="dialog" aria-modal="true" aria-label="Add a block">
        <div className="dxk-head"><b>Add a block</b><span>Pick what comes next — you can move it later.</span><button type="button" className="dxb-x" onClick={onClose} aria-label="Close"><DIcon d="x" w={2.2} /></button></div>
        <div className="dxk-grid">
          {list.map((b, i) => (
            <button key={b.type} type="button" className={`dxk-it ${b.kinds.includes(kind) ? "" : "is-other"}`} style={{ animationDelay: `${i * 18}ms` }} onClick={() => onPick(b.type)}>
              <span className="dxk-ic">{DXI(b.icon, 1.8)}</span>
              <b>{b.label}</b><i>{b.hint}</i>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const DOC_PALETTES: { name: string; t: Partial<DocTheme> }[] = [
  { name: "Forest", t: { primary: "#0A6F4D", accent: "#12B57F", ink: "#0B241A", paper: "#FBFDFC", muted: "#5A7D6D" } },
  { name: "Ocean", t: { primary: "#1D3F8F", accent: "#2F80ED", ink: "#0E1A33", paper: "#FBFCFF", muted: "#5B6B8C" } },
  { name: "Graphite", t: { primary: "#1F2933", accent: "#F2A93B", ink: "#111827", paper: "#FCFCFB", muted: "#6B7280" } },
  { name: "Plum", t: { primary: "#4C1D95", accent: "#C026D3", ink: "#1E1033", paper: "#FDFBFF", muted: "#6E5B8A" } },
  { name: "Ember", t: { primary: "#9A2B13", accent: "#F06A3A", ink: "#2A120B", paper: "#FFFCFA", muted: "#8A6A5E" } },
  { name: "Teal", t: { primary: "#0F5F66", accent: "#16B3A6", ink: "#0B2427", paper: "#FAFDFD", muted: "#4F7A7D" } },
];
const hexOk6 = (v: string) => /^#[0-9a-f]{6}$/i.test(v);

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [txt, setTxt] = useState(value);
  useEffect(() => setTxt(value), [value]);
  return (
    <label className="dxf-color">
      <span>{label}</span>
      <span className="dxf-color-in">
        <input type="color" value={hexOk6(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value.toUpperCase())} />
        <input value={txt} onChange={(e) => { setTxt(e.target.value); const v = e.target.value.trim(); const h = v.startsWith("#") ? v : `#${v}`; if (hexOk6(h)) onChange(h.toUpperCase()); }} spellCheck={false} />
      </span>
    </label>
  );
}

/** Upload / drop an image; shows it, with Remove. */
function ImagePick({ value, onPick, onClear, label, busy, wide }: { value?: string; onPick: (f: File) => void; onClear: () => void; label: string; busy?: boolean; wide?: boolean }) {
  const inp = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className={`dxf-img ${wide ? "is-wide" : ""} ${over ? "is-over" : ""}`}
      onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith("image/")); if (f) onPick(f); }}>
      <span className="dxf-lbl">{label}</span>
      <button type="button" className="dxf-img-box" onClick={() => inp.current?.click()} disabled={busy}>
        {busy ? <span className="dxb-spin" /> : value ? <img src={value} alt="" /> : <span className="dxf-img-ph"><DIcon d="image" />Drop or choose</span>}
      </button>
      {value && <button type="button" className="dxf-link" onClick={onClear}>Remove</button>}
      <input ref={inp} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
    </div>
  );
}

export interface DocBuilderProps {
  mode: "template" | "deal";
  kind: DocKind;
  lang: DocLang;
  theme: DocTheme; onTheme: (t: DocTheme) => void;
  blocks: DocBlock[]; onBlocks: (b: DocBlock[]) => void;
  terms?: DocTemplate["terms"]; onTerms?: (t: DocTemplate["terms"]) => void;
  values?: Record<string, string>; onValues?: (v: Record<string, string>) => void;
  ctx: DocCtxIn; productIds: string[]; serviceIds: string[];
  /** Product / service names for "only with…" (catalogue id → name). */
  catalog?: { products: { id: string; name: string }[]; services: { id: string; name: string }[] };
  /** Left of the top bar: title and template choice. */
  head: React.ReactNode;
  /** Right of the top bar: save, export… */
  actions: React.ReactNode;
  /** A line under the top bar (saving state, warnings). */
  status?: React.ReactNode;
  /** Extra tab for the template's own settings (template mode). */
  docTab?: React.ReactNode;
  onClose: () => void;
  /** Html of the finished document (view mode) for the preview. */
  previewHtml: () => string;
  title: string;
  /** Upload an image; returns what <img> shows. */
  uploadImage: (f: File) => Promise<string>;
  /** The picture library of the template / document (urls). */
  assets?: string[]; onAssets?: (a: string[]) => void;
}

/** Every picture a document shows (blocks, items, free pages, backgrounds, logos). */
function docImagesIn(blocks: DocBlock[], theme: DocTheme): string[] {
  const out: string[] = [];
  const add = (u?: string) => { if (u && /^(https?:|data:image)/.test(u) && !out.includes(u)) out.push(u); };
  blocks.forEach((b) => {
    add(b.image); add(b.bg); (b.items ?? []).forEach((x) => add(x.image));
    if (b.slide) { add(b.slide.bgImg); b.slide.els.forEach((e) => add(e.img)); }
  });
  add(theme.logo); add(theme.logoDark);
  return out;
}
/** Natural size of a picture (to place it with its proportions). */
const imageSize = (src: string) => new Promise<{ w: number; h: number }>((ok) => { const im = new Image(); im.onload = () => ok({ w: im.naturalWidth || 400, h: im.naturalHeight || 300 }); im.onerror = () => ok({ w: 400, h: 300 }); im.src = src; });
const POS9: [string, string][] = [["0% 0%", "↖"], ["50% 0%", "↑"], ["100% 0%", "↗"], ["0% 50%", "←"], ["50% 50%", "•"], ["100% 50%", "→"], ["0% 100%", "↙"], ["50% 100%", "↓"], ["100% 100%", "↘"]];
/** Where a picture sits in its box: 9 points. */
function PosGrid({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  return (
    <div className="dxf-pos9" role="group" aria-label="Position">
      {POS9.map(([v, l]) => <button key={v} type="button" className={(value ?? "50% 50%") === v ? "is-on" : ""} onClick={() => onChange(v)} title={v}>{l}</button>)}
    </div>
  );
}

/** The document editor: outline on the left, the page in the middle, settings on the right. */
export function DocBuilder(p: DocBuilderProps) {
  const { mode, kind, lang, theme, blocks, ctx } = p;
  const [sel, setSel] = useState<string | null>(blocks[0]?.id ?? null);
  const [tab, setTab] = useState<"fields" | "block" | "vars" | "pics" | "look" | "doc">(mode === "deal" ? "fields" : "block");
  /** the selected element of a free page: "blockId:index" */
  const [selEl, setSelEl] = useState<string | null>(null);
  const [vsrc, setVsrc] = useState<DocVarSource | "all">("all");
  const [libBusy, setLibBusy] = useState(0);
  const [libOver, setLibOver] = useState(false);
  /** selected text of the page (for "Make variable") and the open picker */
  const [txtSel, setTxtSel] = useState<{ rect: DOMRect; text: string } | null>(null);
  const [mkVar, setMkVar] = useState<{ rect: DOMRect; text: string } | null>(null);
  const [mkQ, setMkQ] = useState("");
  const libInput = useRef<HTMLInputElement>(null);
  const [picker, setPicker] = useState<null | { after: string | null }>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [device, setDevice] = useState<"web" | "phone">("web");
  const [busyImg, setBusyImg] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [find, setFind] = useState({ text: "", token: "client" });
  const [dragId, setDragId] = useState<string | null>(null);
  const api = useRef<DocCanvasApi | null>(null);
  const [labels, setLabels] = useState(mode === "template");
  const imgInput = useRef<HTMLInputElement>(null);
  const imgFor = useRef<string | null>(null);
  const block = blocks.find((b) => b.id === sel) ?? null;
  const blocksRef = useRef(blocks); blocksRef.current = blocks;
  const setBlocks = (fn: (b: DocBlock[]) => DocBlock[]) => p.onBlocks(fn(blocksRef.current));
  const patchBlock = (id: string, patch: Partial<DocBlock>) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  useEffect(() => { if (hint) { const t = setTimeout(() => setHint(null), 2600); return () => clearTimeout(t); } }, [hint]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !picker && !preview && !(document.activeElement as HTMLElement)?.closest?.(".dxb-right input, .dxb-right textarea")) p.onClose(); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });

  const patchEl = (id: string, idx: number, patch: Partial<SlideEl> | null) => setBlocks((bs) => bs.map((b) => {
    if (b.id !== id || !b.slide) return b;
    const els = patch === null ? b.slide.els.filter((_, i) => i !== idx) : b.slide.els.map((e, i) => (i === idx ? { ...e, ...patch } : e));
    return { ...b, slide: { ...b.slide, els } };
  }));
  const addEl = (id: string, el: Omit<SlideEl, "id">) => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.slide) return;
    const n = b.slide.els.length;
    setBlocks((bs) => bs.map((x) => (x.id === id && x.slide ? { ...x, slide: { ...x.slide, els: [...x.slide.els, { ...el, id: Math.random().toString(36).slice(2, 10) }] } } : x)));
    setSel(id); setSelEl(`${id}:${n}`); setTab("block");
  };
  /** moves the selected element up / down the stack (in front of / behind the others) */
  const restack = (id: string, idx: number, d: 1 | -1 | "front" | "back") => {
    const b = blocksRef.current.find((x) => x.id === id);
    if (!b?.slide) return;
    const els = [...b.slide.els]; const [e] = els.splice(idx, 1);
    const to = d === "front" ? els.length : d === "back" ? 0 : Math.max(0, Math.min(els.length, idx + d));
    els.splice(to, 0, e);
    patchBlock(id, { slide: { ...b.slide, els } }); setSelEl(`${id}:${to}`);
  };
  const addAssets = (urls: string[]) => { const cur = p.assets ?? []; const add = urls.filter((u) => u && !cur.includes(u)); if (add.length) p.onAssets?.([...cur, ...add]); };
  const onField = (path: string, value: string) => {
    const [id, f, k, f2] = path.split("|");
    setBlocks((bs) => bs.map((b) => {
      if (b.id !== id) return b;
      if (f === "els" && b.slide) return { ...b, slide: { ...b.slide, els: b.slide.els.map((e, i) => (i === Number(k) ? { ...e, [f2]: value } : e)) } };
      if (f === "items") return { ...b, items: (b.items ?? []).map((x, i) => (i === Number(k) ? { ...x, [f2]: value } : x)) };
      return { ...b, [f]: value };
    }));
  };
  const addBlock = (type: DocBlockType, after: string | null) => {
    const nb = newDocBlock(type, kind, lang);
    setBlocks((bs) => { const i = after ? bs.findIndex((b) => b.id === after) : bs.length - 1; const out = [...bs]; out.splice(i + 1, 0, nb); return out; });
    setSel(nb.id); setTab("block"); setPicker(null);
    setTimeout(() => api.current?.scrollTo(nb.id), 120);
  };
  const move = (id: string, d: -1 | 1) => setBlocks((bs) => { const i = bs.findIndex((b) => b.id === id); const j = i + d; if (i < 0 || j < 0 || j >= bs.length) return bs; const o = [...bs]; [o[i], o[j]] = [o[j], o[i]]; return o; });
  const remove = (id: string) => { setBlocks((bs) => bs.filter((b) => b.id !== id)); if (sel === id) setSel(null); };
  const dup = (id: string) => { const b = blocksRef.current.find((x) => x.id === id); if (!b) return; const c = cloneBlock(b); setBlocks((bs) => { const i = bs.findIndex((x) => x.id === id); const o = [...bs]; o.splice(i + 1, 0, c); return o; }); setSel(c.id); };
  const onAction = (act: string, id: string, k?: number) => {
    if (act === "up") move(id, -1);
    else if (act === "down") move(id, 1);
    else if (act === "dup") dup(id);
    else if (act === "del") remove(id);
    else if (act === "hide") { const b = blocksRef.current.find((x) => x.id === id); if (b) patchBlock(id, { hidden: !b.hidden }); }
    else if (act === "insert") setPicker({ after: id });
    else if (act === "add-item") { const b = blocksRef.current.find((x) => x.id === id); if (b) patchBlock(id, { items: [...(b.items ?? []), newDocItem()] }); }
    else if (act === "del-item" && k != null) { const b = blocksRef.current.find((x) => x.id === id); if (b) patchBlock(id, { items: (b.items ?? []).filter((_, i) => i !== k) }); }
    else if (act === "pick-image") { imgFor.current = id; imgInput.current?.click(); }
    else if (act === "el-del" && k != null) { patchEl(id, k, null); setSelEl(null); }
  };
  /** A picture onto a section: a free page gets it on the element it was dropped on, or as a new picture there. */
  const placeImage = async (blockId: string, src: File | string, at?: DocDropAt) => {
    const b = blocksRef.current.find((x) => x.id === blockId);
    if (!b) return;
    if (b.type !== "slide" || !b.slide) {
      if (typeof src !== "string") return setImage(blockId, src);
      patchBlock(blockId, { image: src, ...(b.type === "text" && !b.layout ? { layout: "right" as const } : {}) }); setSel(blockId);
      return;
    }
    setBusyImg(blockId);
    try {
      const url = typeof src === "string" ? src : await p.uploadImage(src);
      if (typeof src !== "string") addAssets([url]);
      if (at?.el != null && b.slide.els[at.el]) { patchEl(blockId, at.el, { img: url, kind: "image", crop: undefined, fit: b.slide.els[at.el].fit ?? "cover" }); setSelEl(`${blockId}:${at.el}`); return; }
      const { w: nw, h: nh } = await imageSize(url);
      const W = b.slide.w, H = b.slide.h;
      const k = Math.min(1, (W * 0.4) / nw, (H * 0.5) / nh);
      const w = Math.round(nw * k), h = Math.round(nh * k);
      const x = Math.round(Math.max(0, Math.min(W - w, (at?.x ?? W / 2) - w / 2))), y = Math.round(Math.max(0, Math.min(H - h, (at?.y ?? H / 2) - h / 2)));
      addEl(blockId, { kind: "image", x, y, w, h, img: url, fit: "cover" });
    } catch (e: any) { setHint(e?.message ?? "Could not add the picture."); }
    finally { setBusyImg(null); }
  };
  /** Pictures into the library (upload once, then drag them anywhere). */
  const addToLibrary = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setLibBusy((n) => n + imgs.length);
    const urls: string[] = [];
    for (const f of imgs) { try { urls.push(await p.uploadImage(f)); } catch { /* skip that one */ } finally { setLibBusy((n) => n - 1); } }
    addAssets(urls);
    if (urls.length) setHint(`${urls.length} picture${urls.length === 1 ? "" : "s"} added to Pictures — drag them onto the page.`);
  };
  // pasting a picture anywhere in the editor (outside a text field) keeps it in the library
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      if (a?.closest?.("input, textarea, [contenteditable=true]")) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); addToLibrary(files); setTab("pics"); }
    };
    window.addEventListener("paste", onPaste); return () => window.removeEventListener("paste", onPaste);
  });
  const setImage = async (blockId: string, file: File, itemIdx?: number) => {
    setBusyImg(itemIdx != null ? `${blockId}:${itemIdx}` : blockId);
    try {
      const url = await p.uploadImage(file);
      addAssets([url]);
      const b = blocksRef.current.find((x) => x.id === blockId);
      if (!b) return;
      if (itemIdx != null) patchBlock(blockId, { items: (b.items ?? []).map((x, i) => (i === itemIdx ? { ...x, image: url } : x)) });
      else patchBlock(blockId, { image: url, ...(b.type === "text" && !b.layout ? { layout: "right" as const } : {}) });
      setSel(blockId);
    } catch (e: any) { setHint(e?.message ?? "Could not upload the image."); }
    finally { setBusyImg(null); }
  };
  /** uploads a picture for a setting (shows a spinner on `key`), keeps it in the library, then hands back its url */
  const uploadFor = async (key: string, f: File, use: (url: string) => void) => {
    setBusyImg(key);
    try { const url = await p.uploadImage(f); addAssets([url]); use(url); }
    catch (e: any) { setHint(e?.message ?? "Could not upload the picture."); }
    finally { setBusyImg(null); }
  };
  const insertToken = (key: string) => {
    if (!api.current?.insertToken(key)) setHint("Click inside a text of the page first, then pick the value — or drag it onto the text.");
  };
  const replaceAll = () => {
    const txt = find.text.trim();
    if (!txt) return;
    let n = 0;
    const rep = (s?: string) => { if (!s || !s.includes(txt)) return s; n += s.split(txt).length - 1; return s.split(txt).join(`{{${find.token}}}`); };
    setBlocks((bs) => bs.map((b) => ({ ...b, eyebrow: rep(b.eyebrow), title: rep(b.title), body: rep(b.body), items: b.items?.map((x) => ({ ...x, title: rep(x.title), text: rep(x.text), value: rep(x.value) })) })));
    setHint(n ? `Replaced ${n} time${n === 1 ? "" : "s"} with {{${find.token}}}.` : `“${txt}” isn't in the document.`);
  };

  const fullCtx = useMemo<DocContext>(() => ({ ...ctx, theme, terms: p.terms }), [ctx, theme, p.terms]);
  const autoValues = useMemo(() => docValues(fullCtx, {}), [fullCtx]);
  const used = useMemo(() => docUsedTokens(blocks), [blocks]);
  const free = useMemo(() => docFreeTokens(blocks), [blocks]);
  const catalogV = docVarCatalog(kind);   // cheap; custom fields arrive after the first paint
  const gallery = useMemo(() => Array.from(new Set([...(p.assets ?? []), ...docImagesIn(blocks, theme)])), [p.assets, blocks, theme]);
  const fontOpts = useMemo(() => Array.from(new Set([...DOC_FONTS, theme.headingFont, theme.bodyFont, ...(theme.webFonts ?? [])].filter(Boolean))).map((f) => ({ value: f, label: f, hint: DOC_FONTS.includes(f) ? undefined : "From your document" })), [theme.headingFont, theme.bodyFont, theme.webFonts]);
  const ql = q.trim().toLowerCase();

  const tabs: { k: typeof tab; label: string; icon: keyof typeof DX_ICON }[] = [
    ...(mode === "deal" ? [{ k: "fields" as const, label: "Fields", icon: "fields" as const }] : []),
    { k: "block", label: "Block", icon: "layers" },
    { k: "vars", label: "Variables", icon: "braces" },
    { k: "pics", label: "Pictures", icon: "image" },
    { k: "look", label: "Look", icon: "palette" },
    ...(p.docTab ? [{ k: "doc" as const, label: "Template", icon: "sliders" as const }] : []),
  ];

  return createPortal(
    <div className="dxb" role="dialog" aria-modal="true" aria-label={p.title}>
      <header className="dxb-top">
        <button type="button" className="dxb-x" onClick={p.onClose} aria-label="Close"><DIcon d="x" w={2.2} /></button>
        <div className="dxb-head">{p.head}</div>
        <div className="dxb-actions">
          <button type="button" className="dxb-btn" onClick={() => setPreview(p.previewHtml())}><DIcon d="play" />Preview</button>
          {p.actions}
        </div>
      </header>
      {p.status && <div className="dxb-status">{p.status}</div>}
      <div className="dxb-body">
        <aside className="dxb-left">
          <div className="dxb-left-head"><b>Sections</b><span>{blocks.length}</span></div>
          <ol className="dxb-outline">
            {blocks.map((b, i) => {
              const meta = docBlockMeta(b.type);
              const when = b.when ?? (b.type === "products" ? "product" : b.type === "services" ? "service" : "always");
              const label = richToText(b.title ?? "").replace(/\{\{([^}]+)\}\}/g, (_m, k: string) => `‹${docTokenLabel(k.trim())}›`) || meta.label;
              return (
                <li key={b.id} className={`${sel === b.id ? "is-on" : ""} ${b.hidden ? "is-hidden" : ""} ${dragId === b.id ? "is-drag" : ""}`}
                  draggable onDragStart={(e) => { setDragId(b.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", b.id); }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => { if (dragId && dragId !== b.id) { e.preventDefault(); } }}
                  onDrop={(e) => { e.preventDefault(); if (!dragId || dragId === b.id) return; setBlocks((bs) => { const from = bs.findIndex((x) => x.id === dragId); const o = [...bs]; const [m] = o.splice(from, 1); const to = o.findIndex((x) => x.id === b.id); o.splice(from < i ? to + 1 : to, 0, m); return o; }); setDragId(null); }}
                  style={{ animationDelay: `${Math.min(i, 14) * 22}ms` }}>
                  <button type="button" className="dxb-ol-main" onClick={() => { setSel(b.id); setTab("block"); api.current?.scrollTo(b.id); }}>
                    <span className="dxb-ol-ic">{DXI(meta.icon, 1.8)}</span>
                    <span className="dxb-ol-txt"><b>{label}</b><i>{meta.label}{when !== "always" ? ` · per ${when}` : ""}</i></span>
                  </button>
                  <button type="button" className="dxb-ol-eye" onClick={() => patchBlock(b.id, { hidden: !b.hidden })} title={b.hidden ? "Show" : "Hide"} aria-label={b.hidden ? "Show" : "Hide"}><DIcon d={b.hidden ? "eyeOff" : "eye"} /></button>
                </li>
              );
            })}
          </ol>
          <button type="button" className="dxb-add" onClick={() => setPicker({ after: sel })}><DIcon d="plus" w={2.2} />Add a block</button>
        </aside>

        <main className="dxb-stage">
          <div className="dxb-stage-bar">
            <div className="dxb-seg is-sm">
              <button type="button" className={device === "web" ? "is-on" : ""} onClick={() => setDevice("web")}><DIcon d="monitor" />Desktop</button>
              <button type="button" className={device === "phone" ? "is-on" : ""} onClick={() => setDevice("phone")}><DIcon d="phone" />Phone</button>
            </div>
            <label className="dxb-switch" title="Show the variables by name instead of this deal's values">
              <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /><i />Variable names
            </label>
            <span className="dxb-tip">Click any text to edit it · drag a value onto a text · drop or paste pictures on the page</span>
          </div>
          <DocCanvas theme={theme} blocks={blocks} kind={kind} lang={lang} ctx={ctx} terms={p.terms} productIds={p.productIds} serviceIds={p.serviceIds}
            values={p.values} chipsAsLabels={labels} selected={sel} width={device === "phone" ? 400 : null}
            selectedEl={selEl} onSelectEl={(id, i) => { setSelEl(i == null ? null : `${id}:${i}`); if (i != null && tab !== "vars" && tab !== "pics") setTab("block"); }}
            onSlideEl={(id, i, patch) => patchEl(id, i, patch)}
            onSelect={(id) => { setSel(id); setSelEl((cur) => (cur && cur.split(":")[0] !== id ? null : cur)); if (tab !== "fields" && tab !== "vars" && tab !== "pics") setTab("block"); }} onField={onField} onAction={onAction}
            onTextSelect={(x) => { setTxtSel(x); }}
            onImageDrop={(id, src, at) => placeImage(id, src, at)} onTokenClick={(k) => { if (mode === "deal") { setTab("fields"); setTimeout(() => document.getElementById(`dxf-v-${k}`)?.focus(), 60); } }} apiRef={api} />
          {hint && <div className="dxb-hint" role="status">{hint}</div>}
        </main>
        {txtSel && !mkVar && createPortal(
          <button type="button" className="dxm-btn" style={{ left: txtSel.rect.left + txtSel.rect.width / 2, top: Math.max(8, txtSel.rect.top - 40) }}
            onMouseDown={(e) => e.preventDefault()} onClick={() => { setMkVar(txtSel); setMkQ(""); }}>
            <DIcon d="braces" />Make variable
          </button>, document.body)}
        {mkVar && createPortal((() => {
          const norm = (x: string) => x.toLowerCase().replace(/[\s.,€%]/g, "");
          const sel = norm(mkVar.text);
          const all = catalogV.flatMap((g) => g.vars.map((v) => ({ ...v, color: g.color, group: g.label, key: v.key.replace(/N/g, "1") })));
          const mq = mkQ.trim().toLowerCase();
          const hits = all.filter((v) => !mq || v.label.toLowerCase().includes(mq) || v.key.includes(mq) || v.group.toLowerCase().includes(mq));
          // the ones whose value (or example) is what's selected go first
          const sug = mq ? [] : all.filter((v) => { const val = norm(autoValues[v.key] ?? ""); return val && (val === sel || (sel.length > 3 && val.includes(sel))); }).slice(0, 6);
          const pick = (key: string) => { if (!api.current?.insertToken(key)) setHint("Select the text on the page again, then pick the value."); setMkVar(null); setTxtSel(null); };
          return (
            <div className="dxm-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setMkVar(null); }}>
              <div className="dxm" role="dialog" aria-label="Make variable" style={{ left: Math.min(window.innerWidth - 340, Math.max(12, mkVar.rect.left)), top: Math.min(window.innerHeight - 420, mkVar.rect.top + mkVar.rect.height + 10) }}>
                <div className="dxm-head"><b>“{mkVar.text.length > 40 ? `${mkVar.text.slice(0, 40)}…` : mkVar.text}”</b><span>becomes the value of each deal</span></div>
                <label className="dxf-search"><DIcon d="search" /><input autoFocus value={mkQ} onChange={(e) => setMkQ(e.target.value)} placeholder="Search a value or custom field" onKeyDown={(e) => { if (e.key === "Escape") setMkVar(null); if (e.key === "Enter" && hits[0]) pick((sug[0] ?? hits[0]).key); }} /></label>
                <div className="dxm-list">
                  {sug.length > 0 && <div className="dxm-sec">Same value now</div>}
                  {sug.map((v) => <button key={`s-${v.key}`} type="button" style={{ ["--tc" as any]: v.color }} onClick={() => pick(v.key)}><i />{v.label}<em>{v.group}</em></button>)}
                  {sug.length > 0 && <div className="dxm-sec">All values</div>}
                  {hits.slice(0, 80).map((v) => <button key={v.key} type="button" style={{ ["--tc" as any]: v.color }} onClick={() => pick(v.key)}><i />{v.label}<em>{v.group}{v.custom ? " · custom" : ""}</em></button>)}
                  {!hits.length && <p className="dxf-empty">Nothing matches.</p>}
                </div>
              </div>
            </div>
          );
        })(), document.body)}

        <aside className="dxb-right">
          <nav className="dxb-tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} className={tab === t.k ? "is-on" : ""} onClick={() => setTab(t.k)}>
                <DIcon d={t.icon} />{t.label}{t.k === "fields" && free.some((k) => !(p.values ?? {})[k]) ? <i className="dxb-dot" /> : null}
              </button>
            ))}
          </nav>
          <div className="dxb-panel" key={tab}>
            {tab === "fields" && (
              <div className="dxf">
                <p className="dxf-note">What this document says for this deal. Values come from the deal; type over any of them for this document only.</p>
                {free.length > 0 && (
                  <section className="dxf-sec is-warn">
                    <h4>To fill in</h4>
                    {free.map((k) => (
                      <label key={k} className="dxf-row">
                        <span>{k.replace(/_/g, " ")}</span>
                        <input id={`dxf-v-${k}`} value={(p.values ?? {})[k] ?? ""} placeholder="Type the value" onFocus={() => api.current?.flash(k)}
                          onChange={(e) => p.onValues?.({ ...(p.values ?? {}), [k]: e.target.value })} />
                      </label>
                    ))}
                  </section>
                )}
                <section className="dxf-sec">
                  <h4>From the deal</h4>
                  {used.filter((k) => !free.includes(k)).map((k) => {
                    const own = (p.values ?? {})[k];
                    const auto = autoValues[k] ?? "";
                    const scoped = /^(product|service)\b/.test(k);
                    return (
                      <div key={k} className={`dxf-row ${own != null ? "is-own" : ""}`}>
                        <button type="button" className="dxf-jump" onClick={() => api.current?.flash(k)} title="Show it in the document">{docTokenLabel(k)}</button>
                        {scoped ? <span className="dxf-auto">Per product / service</span> : (
                          <input id={`dxf-v-${k}`} value={own ?? auto} placeholder={auto || "Empty"} onFocus={() => api.current?.flash(k)}
                            onChange={(e) => p.onValues?.({ ...(p.values ?? {}), [k]: e.target.value })} />
                        )}
                        {own != null && <button type="button" className="dxf-reset" title="Back to the deal's value" onClick={() => { const v = { ...(p.values ?? {}) }; delete v[k]; p.onValues?.(v); }}><DIcon d="undo" /></button>}
                      </div>
                    );
                  })}
                  {!used.length && <p className="dxf-empty">This document uses no values yet. Add some from Variables.</p>}
                </section>
              </div>
            )}

            {tab === "block" && (block ? (() => {
              const meta = docBlockMeta(block.type);
              const when = block.when ?? (block.type === "products" ? "product" : block.type === "services" ? "service" : "always");
              const list = when === "product" ? p.catalog?.products ?? [] : when === "service" ? p.catalog?.services ?? [] : [];
              const auto = ["pricing", "schedule", "parties", "signature"].includes(block.type) || (block.type === "timeline" && !(block.items ?? []).length);
              const itemLabel: Partial<Record<DocBlockType, [string, string?]>> = { cover: ["Details", "label"], stats: ["Figures", "label"], cards: ["Cards"], terms: ["Conditions"], team: ["People", "role"], clauses: ["Clauses"], timeline: ["Steps", "when"], products: ["Features"], services: ["Points"] };
              const il = itemLabel[block.type];
              return (
                <div className="dxf">
                  <div className="dxf-blk-head">
                    <span className="dxf-blk-ic">{DXI(meta.icon, 1.8)}</span>
                    <div><b>{meta.label}</b><i>{meta.hint}</i></div>
                  </div>
                  {auto && <p className="dxf-note is-auto"><DIcon d="spark" />Filled from the deal{block.type === "timeline" ? " (the services' phases) — or add your own steps" : ""}.</p>}
                  <section className="dxf-sec">
                    <h4>Goes in</h4>
                    <div className="dxb-seg is-full">
                      {(["always", "product", "service"] as const).map((w) => (
                        <button key={w} type="button" className={when === w ? "is-on" : ""} onClick={() => patchBlock(block.id, { when: w, ids: [] })}>{w === "always" ? "Always" : w === "product" ? "Each product" : "Each service"}</button>
                      ))}
                    </div>
                    {when !== "always" && (
                      <>
                        <p className="dxf-note">Repeats once per {when} of the deal; its {when} values are that {when}'s.{list.length ? " Limit it to some:" : ""}</p>
                        {list.length > 0 && (
                          <div className="dxf-chips">
                            {list.map((x) => {
                              const on = (block.ids ?? []).includes(x.id);
                              return <button key={x.id} type="button" className={on ? "is-on" : ""} onClick={() => patchBlock(block.id, { ids: on ? (block.ids ?? []).filter((y) => y !== x.id) : [...(block.ids ?? []), x.id] })}>{on && <DIcon d="check" w={3} />}{x.name}</button>;
                            })}
                          </div>
                        )}
                        {list.length > 0 && !(block.ids ?? []).length && <p className="dxf-sub">None picked: every {when}.</p>}
                      </>
                    )}
                  </section>
                  {block.type !== "slide" && <section className="dxf-sec">
                    <h4>Background</h4>
                    <div className="dxf-tones">
                      {(["light", "tint", "dark", "brand"] as const).map((t) => (
                        <button key={t} type="button" className={`t-${t} ${(block.tone ?? "") === t ? "is-on" : ""}`} onClick={() => patchBlock(block.id, { tone: t })} title={t}><i /></button>
                      ))}
                      <button type="button" className={`t-auto ${!block.tone ? "is-on" : ""}`} onClick={() => patchBlock(block.id, { tone: undefined })}>Auto</button>
                    </div>
                  </section>}
                  {block.type === "slide" && block.slide && (() => {
                    const sp = block.slide;
                    const [sb, si] = (selEl ?? "").split(":");
                    const ei = sb === block.id && si ? Number(si) : -1;
                    const el = ei >= 0 ? sp.els[ei] ?? null : null;
                    const setSp = (patch: Partial<typeof sp>) => patchBlock(block.id, { slide: { ...sp, ...patch } });
                    const num = (k: "x" | "y" | "w" | "h", l: string) => (
                      <label className="dxf-num"><span>{l}</span><input type="number" value={Math.round(el?.[k] ?? 0)} onChange={(e) => patchEl(block.id, ei, { [k]: Number(e.target.value) || 0 } as Partial<SlideEl>)} /></label>
                    );
                    return (
                      <>
                        <section className="dxf-sec">
                          <h4>Page</h4>
                          <div className="dxf-colors"><ColorField label="Background colour" value={sp.bg ?? "#FFFFFF"} onChange={(v) => setSp({ bg: v })} /></div>
                          <ImagePick label="Background picture" wide value={sp.bgImg} busy={busyImg === `${block.id}:bg`} onPick={(f) => uploadFor(`${block.id}:bg`, f, (url) => setSp({ bgImg: url }))} onClear={() => setSp({ bgImg: undefined })} />
                          <div className="dxf-addels">
                            <button type="button" onClick={() => addEl(block.id, { kind: "text", x: 80, y: 80, w: 520, h: 80, pad: [0, 0, 0, 0], html: `<p style="font-size:24px;line-height:1.3">${lang === "en" ? "Text" : "Texto"}</p>` })}><DIcon d="plus" w={2.2} />Text box</button>
                            <button type="button" onClick={() => { imgFor.current = `slide:${block.id}`; imgInput.current?.click(); }}><DIcon d="image" />Picture</button>
                            <button type="button" onClick={() => addEl(block.id, { kind: "shape", x: 80, y: 80, w: 320, h: 160, fill: theme.accent, radius: 12 })}><DIcon d="plus" w={2.2} />Shape</button>
                          </div>
                          <p className="dxf-sub">Drag the blue handle to move an element and the round one to resize it (Shift keeps its proportions). Arrows nudge the selected one, Delete removes it. Drop or paste pictures straight onto the page.</p>
                        </section>
                        {el ? (
                          <section className="dxf-sec is-el">
                            <h4>Selected: {el.kind === "image" ? "picture" : el.kind === "text" || el.kind === "table" ? "text" : el.kind}</h4>
                            {el.kind === "image" && (
                              <>
                                <ImagePick label="" wide value={el.img} busy={busyImg === `${block.id}:${ei}:el`} onPick={(f) => uploadFor(`${block.id}:${ei}:el`, f, (url) => patchEl(block.id, ei, { img: url, crop: undefined }))} onClear={() => patchEl(block.id, ei, { img: undefined })} />
                                <div className="dxb-seg is-full">
                                  {([["cover", "Fill (crop)"], ["contain", "Whole picture"], ["fill", "Stretch"]] as const).map(([f, l]) => (
                                    <button key={f} type="button" className={(el.fit ?? "fill") === f && !el.crop ? "is-on" : ""} onClick={() => patchEl(block.id, ei, { fit: f, crop: undefined })}>{l}</button>
                                  ))}
                                </div>
                                <label className="dxf-row dxf-check"><input type="checkbox" checked={el.bind === "client.logo"} onChange={(e) => patchEl(block.id, ei, { bind: e.target.checked ? "client.logo" : undefined, fit: "contain" })} /><span>Each deal's client logo <i>(its company's logo, or its name when it has none)</i></span></label>
                                {(el.fit === "cover" || el.fit === "contain") && !el.crop && <div className="dxf-row"><span>Position</span><PosGrid value={el.pos} onChange={(v) => patchEl(block.id, ei, { pos: v })} /></div>}
                                {el.crop && <p className="dxf-sub">Cropped as in your document. Pick a fit to frame it again.</p>}
                              </>
                            )}
                            {(el.kind === "text" || el.kind === "shape" || el.kind === "table") && (
                              <div className="dxf-colors"><ColorField label={el.kind === "shape" ? "Colour" : "Box colour"} value={el.fill && !/gradient/.test(el.fill) ? el.fill : "#FFFFFF"} onChange={(v) => patchEl(block.id, ei, { fill: v })} /></div>
                            )}
                            {el.kind !== "line" && el.fill && <button type="button" className="dxf-link" onClick={() => patchEl(block.id, ei, { fill: undefined })}>No box colour</button>}
                            <label className="dxf-row"><span>Opacity</span><input type="range" min={0.1} max={1} step={0.05} value={el.opacity ?? 1} onChange={(e) => patchEl(block.id, ei, { opacity: Number(e.target.value) })} /></label>
                            <div className="dxf-nums">{num("x", "X")}{num("y", "Y")}{num("w", "W")}{num("h", "H")}</div>
                            <div className="dxf-blk-tools">
                              <button type="button" onClick={() => restack(block.id, ei, "front")}><DIcon d="up" />To front</button>
                              <button type="button" onClick={() => restack(block.id, ei, "back")}><DIcon d="down" />To back</button>
                              <button type="button" onClick={() => addEl(block.id, { ...JSON.parse(JSON.stringify(el)), x: el.x + 20, y: el.y + 20 })}><DIcon d="copy" />Duplicate</button>
                              <button type="button" className="is-del" onClick={() => { patchEl(block.id, ei, null); setSelEl(null); }}><DIcon d="trash" />Delete</button>
                            </div>
                          </section>
                        ) : <p className="dxf-sub">Click an element of the page to change it.</p>}
                      </>
                    );
                  })()}
                  {block.type !== "slide" && block.type !== "cover" && (
                    <section className="dxf-sec">
                      <h4>Background picture</h4>
                      <ImagePick label="" wide value={block.bg} busy={busyImg === `${block.id}:bg`} onPick={(f) => uploadFor(`${block.id}:bg`, f, (url) => patchBlock(block.id, { bg: url }))} onClear={() => patchBlock(block.id, { bg: undefined, bgPos: undefined })} />
                      {block.bg && <div className="dxf-row"><span>Position</span><PosGrid value={block.bgPos} onChange={(v) => patchBlock(block.id, { bgPos: v })} /></div>}
                      {block.bg && <p className="dxf-sub">The section's background colour (above) shades the picture so the text stays readable.</p>}
                    </section>
                  )}
                  {["cover", "text", "quote", "image"].includes(block.type) && (
                    <section className="dxf-sec">
                      <h4>{block.type === "cover" ? "Background image" : block.type === "quote" ? "Photo" : "Image"}</h4>
                      <ImagePick label="" value={block.image} busy={busyImg === block.id} wide={block.type !== "quote"} onPick={(f) => setImage(block.id, f)} onClear={() => patchBlock(block.id, { image: undefined })} />
                      {block.type === "text" && (
                        <div className="dxb-seg is-full">
                          {(["left", "right", "center"] as const).map((l) => (
                            <button key={l} type="button" className={(block.layout ?? (block.image ? "right" : "left")) === l ? "is-on" : ""} onClick={() => patchBlock(block.id, { layout: l })}>{l === "left" ? (block.image ? "Image left" : "Left") : l === "right" ? (block.image ? "Image right" : "Right") : "Centred"}</button>
                          ))}
                        </div>
                      )}
                      {block.image && block.type !== "quote" && (
                        <>
                          <div className="dxb-seg is-full">
                            {([["cover", "Fill (crop)"], ["contain", "Whole picture"]] as const).map(([f, l]) => (
                              <button key={f} type="button" className={(block.fit ?? "cover") === f ? "is-on" : ""} onClick={() => patchBlock(block.id, { fit: f })}>{l}</button>
                            ))}
                          </div>
                          <div className="dxf-row"><span>Position</span><PosGrid value={block.pos} onChange={(v) => patchBlock(block.id, { pos: v })} /></div>
                        </>
                      )}
                    </section>
                  )}
                  {il && (
                    <section className="dxf-sec">
                      <h4>{il[0]}</h4>
                      <ol className="dxf-items">
                        {(block.items ?? []).map((x, k) => (
                          <li key={x.id}>
                            <span className="dxf-it-n">{k + 1}</span>
                            <span className="dxf-it-t">{richToText(x.title || x.text || x.value || "") || <em>Empty</em>}</span>
                            {block.type === "team" || block.type === "cards" ? (
                              <label className="dxf-it-img" title="Picture">{busyImg === `${block.id}:${k}` ? <span className="dxb-spin" /> : x.image ? <img src={x.image} alt="" /> : <DIcon d="image" />}
                                <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setImage(block.id, f, k); e.target.value = ""; }} />
                              </label>
                            ) : null}
                            <button type="button" disabled={!k} onClick={() => patchBlock(block.id, { items: (() => { const o = [...(block.items ?? [])]; [o[k - 1], o[k]] = [o[k], o[k - 1]]; return o; })() })} aria-label="Up"><DIcon d="up" /></button>
                            <button type="button" onClick={() => patchBlock(block.id, { items: (block.items ?? []).filter((_, i) => i !== k) })} aria-label="Remove"><DIcon d="trash" /></button>
                          </li>
                        ))}
                      </ol>
                      <button type="button" className="dxf-add" onClick={() => patchBlock(block.id, { items: [...(block.items ?? []), newDocItem()] })}><DIcon d="plus" w={2.2} />Add</button>
                      <p className="dxf-sub">Type the texts on the page.</p>
                    </section>
                  )}
                  <div className="dxf-blk-tools">
                    <button type="button" onClick={() => move(block.id, -1)}><DIcon d="up" />Up</button>
                    <button type="button" onClick={() => move(block.id, 1)}><DIcon d="down" />Down</button>
                    <button type="button" onClick={() => dup(block.id)}><DIcon d="copy" />Duplicate</button>
                    <button type="button" onClick={() => patchBlock(block.id, { hidden: !block.hidden })}><DIcon d={block.hidden ? "eye" : "eyeOff"} />{block.hidden ? "Show" : "Hide"}</button>
                    <button type="button" className="is-del" onClick={() => remove(block.id)}><DIcon d="trash" />Delete</button>
                  </div>
                </div>
              );
            })() : <div className="dxf"><p className="dxf-empty">Click a section of the page (or in the list) to set it up.</p></div>)}

            {tab === "vars" && (
              <div className="dxf">
                <p className="dxf-note">Click a text on the page, then a value to put it there — or drag the value onto the text. Each deal shows its own figure.</p>
                <label className="dxf-search"><DIcon d="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search values, custom fields…" /></label>
                <div className="dxv-src" role="tablist">
                  <button type="button" className={vsrc === "all" ? "is-on" : ""} onClick={() => setVsrc("all")}>All</button>
                  {catalogV.filter((g) => g.vars.length).map((g) => (
                    <button key={g.source} type="button" className={vsrc === g.source ? "is-on" : ""} style={{ ["--tc" as any]: g.color }} onClick={() => setVsrc(g.source)} title={g.hint}><i />{g.label}</button>
                  ))}
                </div>
                {catalogV.filter((g) => vsrc === "all" || g.source === vsrc).map((g) => {
                  const vs = g.vars.filter((t) => !ql || t.label.toLowerCase().includes(ql) || t.key.toLowerCase().includes(ql) || g.label.toLowerCase().includes(ql));
                  if (!vs.length) return null;
                  return (
                    <section key={g.source} className="dxf-sec dxv-grp" style={{ ["--tc" as any]: g.color }}>
                      <h4><i className="dxv-dot" />{g.label}<span>{vs.length}</span></h4>
                      <div className="dxv-list">
                        {vs.map((t) => {
                          const key = t.key.replace(/N/g, "1");
                          const sample = (autoValues[key] ?? "").replace(/\n/g, " · ") || t.example.replace(/ ⏎ /g, " · ");
                          return (
                            <button key={t.key} type="button" draggable className={`dxv-it ${used.includes(key) ? "is-used" : ""}`} title={`{{${key}}}`}
                              onDragStart={(e) => { e.dataTransfer.setData("application/x-doc-token", key); e.dataTransfer.setData("text/plain", `{{${key}}}`); e.dataTransfer.effectAllowed = "copy"; }}
                              onMouseDown={(e) => e.preventDefault()} onClick={() => insertToken(key)}>
                              <b>{t.label}{t.custom && <em>Custom</em>}{t.scoped && <em>Per {t.scoped}</em>}{used.includes(key) && <DIcon d="check" w={3} />}</b>
                              <i>{sample}</i>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
                <section className="dxf-sec">
                  <h4>Replace text with a value</h4>
                  <p className="dxf-sub">E.g. every “Grupo Mundomóvil” becomes the client of each deal.</p>
                  <input className="dxf-in" value={find.text} onChange={(e) => setFind({ ...find, text: e.target.value })} placeholder="Text to find" />
                  <Select size="sm" value={find.token} onChange={(v) => setFind({ ...find, token: v })} aria-label="Value"
                    options={catalogV.flatMap((g) => g.vars.map((t) => ({ value: t.key.replace(/N/g, "1"), label: t.label, hint: g.label })))} />
                  <button type="button" className="dxb-btn is-primary is-full" disabled={!find.text.trim()} onClick={replaceAll}>Replace everywhere</button>
                </section>
              </div>
            )}

            {tab === "pics" && (
              <div className="dxf">
                <p className="dxf-note">Your pictures for this {mode === "deal" ? "document" : "template"}. Drag one onto the page (onto a picture to replace it), or select something and use the buttons. Paste (⌘V) adds a picture too.</p>
                <button type="button" className={`dxn-drop dxl-drop ${libOver ? "is-over" : ""}`} onClick={() => libInput.current?.click()}
                  onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setLibOver(true); } }} onDragLeave={() => setLibOver(false)}
                  onDrop={(e) => { e.preventDefault(); setLibOver(false); addToLibrary(Array.from(e.dataTransfer.files)); }}>
                  {libBusy ? <><span className="dxb-spin" /><b>Adding {libBusy} picture{libBusy === 1 ? "" : "s"}…</b></> : <><DIcon d="upload" /><b>Drop pictures or click to choose</b><i>Several at once · they're made light automatically</i></>}
                </button>
                {(() => {
                  const sb = block;
                  const [eb, ei0] = (selEl ?? "").split(":");
                  const ei = sb && eb === sb.id && ei0 ? Number(ei0) : -1;
                  const selImg = sb?.slide && ei >= 0 && sb.slide.els[ei]?.kind === "image";
                  const use = (u: string) => {
                    if (!sb) { setHint("Select a section of the page first."); return; }
                    if (sb.slide) { if (selImg) patchEl(sb.id, ei, { img: u, crop: undefined }); else placeImage(sb.id, u); }
                    else placeImage(sb.id, u);
                  };
                  const asBg = (u: string) => {
                    if (!sb) { setHint("Select a section of the page first."); return; }
                    if (sb.slide) patchBlock(sb.id, { slide: { ...sb.slide, bgImg: u } }); else if (sb.type === "cover") patchBlock(sb.id, { image: u }); else patchBlock(sb.id, { bg: u });
                  };
                  return gallery.length ? (
                    <div className="dxl-grid">
                      {gallery.map((u) => {
                        const inLib = (p.assets ?? []).includes(u);
                        return (
                          <figure key={u} className="dxl-it" draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-doc-asset", u); e.dataTransfer.effectAllowed = "copy"; }}>
                            <img src={u} alt="" loading="lazy" draggable={false} />
                            <figcaption>
                              <button type="button" onClick={() => use(u)} title={selImg ? "Replace the selected picture" : "Put it in the selected section"}>{selImg ? "Replace" : "Use"}</button>
                              <button type="button" onClick={() => asBg(u)} title="Background of the selected section">Background</button>
                              <button type="button" onClick={() => p.onTheme({ ...theme, logoDark: u, logo: theme.logo ?? u })} title="Use as your logo">Logo</button>
                              {inLib && <button type="button" className="is-del" onClick={() => p.onAssets?.((p.assets ?? []).filter((x) => x !== u))} aria-label="Remove from the library" title="Remove from the library"><DIcon d="trash" /></button>}
                            </figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  ) : <p className="dxf-empty">No pictures yet.</p>;
                })()}
              </div>
            )}
            {tab === "look" && (
              <div className="dxf">
                <section className="dxf-sec">
                  <h4>Style</h4>
                  <div className="dxf-styles">
                    {([["soft", "Soft", "Rounded, airy"], ["sharp", "Editorial", "Square, refined"], ["bold", "Bold", "Big type, strong colour"]] as const).map(([k, l, h]) => (
                      <button key={k} type="button" className={`s-${k} ${(theme.style ?? "soft") === k ? "is-on" : ""}`} onClick={() => p.onTheme({ ...theme, style: k })}><i /><b>{l}</b><span>{h}</span></button>
                    ))}
                  </div>
                </section>
                <section className="dxf-sec">
                  <h4>Colours</h4>
                  <div className="dxf-pals">
                    {DOC_PALETTES.map((pl) => (
                      <button key={pl.name} type="button" title={pl.name} onClick={() => p.onTheme({ ...theme, ...pl.t })} className={theme.primary === pl.t.primary ? "is-on" : ""}>
                        <i style={{ background: pl.t.primary }} /><i style={{ background: pl.t.accent }} /><i style={{ background: pl.t.ink }} />
                      </button>
                    ))}
                  </div>
                  <div className="dxf-colors">
                    <ColorField label="Main" value={theme.primary} onChange={(v) => p.onTheme({ ...theme, primary: v })} />
                    <ColorField label="Accent" value={theme.accent} onChange={(v) => p.onTheme({ ...theme, accent: v })} />
                    <ColorField label="Text" value={theme.ink} onChange={(v) => p.onTheme({ ...theme, ink: v })} />
                    <ColorField label="Soft text" value={theme.muted} onChange={(v) => p.onTheme({ ...theme, muted: v })} />
                    <ColorField label="Page" value={theme.paper} onChange={(v) => p.onTheme({ ...theme, paper: v })} />
                  </div>
                </section>
                <section className="dxf-sec">
                  <h4>Fonts</h4>
                  <label className="dxf-row is-stack"><span>Headings</span><Select size="sm" value={theme.headingFont} onChange={(v) => p.onTheme({ ...theme, headingFont: v })} options={fontOpts} aria-label="Heading font" /></label>
                  <label className="dxf-row is-stack"><span>Text</span><Select size="sm" value={theme.bodyFont} onChange={(v) => p.onTheme({ ...theme, bodyFont: v })} options={fontOpts} aria-label="Body font" /></label>
                  {fontOpts.some((f) => f.hint) && <p className="dxf-sub">Fonts of your document show with the closest free font when the computer doesn't have them ({fontOpts.filter((f) => f.hint).map((f) => `${f.value} → ${(webFont(f.value).google ?? "system")}`).join(" · ")}).</p>}
                </section>
                <section className="dxf-sec">
                  <h4>Logo</h4>
                  <div className="dxf-logos">
                    <ImagePick label="On dark (cover)" value={theme.logo} busy={busyImg === "logo"} onPick={async (f) => { setBusyImg("logo"); try { p.onTheme({ ...theme, logo: await p.uploadImage(f) }); } catch (e: any) { setHint(e?.message ?? "Upload failed"); } finally { setBusyImg(null); } }} onClear={() => p.onTheme({ ...theme, logo: undefined })} />
                    <ImagePick label="On light" value={theme.logoDark} busy={busyImg === "logoDark"} onPick={async (f) => { setBusyImg("logoDark"); try { p.onTheme({ ...theme, logoDark: await p.uploadImage(f) }); } catch (e: any) { setHint(e?.message ?? "Upload failed"); } finally { setBusyImg(null); } }} onClear={() => p.onTheme({ ...theme, logoDark: undefined })} />
                  </div>
                </section>
                <section className="dxf-sec">
                  <h4>Your company</h4>
                  <p className="dxf-sub">Used on covers, parties and signatures.</p>
                  {([["company", "Name"], ["legalName", "Legal name"], ["vat", "VAT"], ["address", "Address"], ["city", "City (signature place)"], ["web", "Website"]] as const).map(([k, l]) => (
                    <label key={k} className="dxf-row is-stack"><span>{l}</span><input value={(theme as any)[k] ?? ""} onChange={(e) => p.onTheme({ ...theme, [k]: e.target.value })} /></label>
                  ))}
                </section>
              </div>
            )}
            {tab === "doc" && p.docTab}
          </div>
        </aside>
      </div>
      <input ref={imgInput} type="file" accept="image/*" hidden onChange={(e) => {
        const f = e.target.files?.[0]; const to = imgFor.current;
        if (f && to) { if (to.startsWith("slide:")) placeImage(to.slice(6), f); else setImage(to, f); }
        e.target.value = "";
      }} />
      <input ref={libInput} type="file" accept="image/*" multiple hidden onChange={(e) => { addToLibrary(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      {picker && <BlockPicker kind={kind} onClose={() => setPicker(null)} onPick={(t) => addBlock(t, picker.after)} />}
      {preview && <DocPreview html={preview} title={p.title} onClose={() => setPreview(null)} />}
    </div>,
    document.body,
  );
}

/** Html of a document for one deal: the preview / file (view), print, or PDF layout. */
export function docHtmlFor(mode: "view" | "print", o: { theme: DocTheme; blocks: DocBlock[]; kind: DocKind; lang: DocLang; ctx: DocCtxIn; terms?: DocTemplate["terms"]; values?: Record<string, string>; productIds: string[]; serviceIds: string[]; title: string }): string {
  const full: DocContext = { ...o.ctx, theme: o.theme, terms: o.terms };
  const placed = planDoc(o.blocks, o.ctx.data, o.productIds, o.serviceIds);
  return renderDocHtml(o.theme, { mode, placed, data: o.ctx.data, contract: o.ctx.contract, terms: o.terms, kind: o.kind, lang: o.lang, title: o.title, valuesFor: (pl) => ({ ...docValues(full, pl.scope), ...(o.values ?? {}) }) });
}

/** Sample deal for editing templates. */
export function docSampleCtx(theme: DocTheme): DocCtxIn {
  const data = sampleData();
  data.products[0].terms = [{ years: 1, discountPct: 0, annualGross: 12000, annual: 12000 }, { years: 3, discountPct: 4.2, annualGross: 12000, annual: 11500 }];
  void theme;
  return {
    data, lang: "es", sellerName: "Laura Gómez", sellerEmail: "laura@tuempresa.com", sellerPhone: "+34 600 000 000", proposalName: "Licencia + implantación",
    contract: { signDate: new Date().toISOString().slice(0, 10), contractStart: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), termYears: 3, increments: { mode: "pct", value: 3 } },
    dealValue: data.totals.total,
    // stage, contacts, team, custom fields…: their examples
    extra: docSampleValues(),
  };
}

/* ---------- Settings › Proposals / Contracts ---------- */
/** Small live picture of a template (its cover, as a 1280-wide page scaled down). */
function DocThumb({ t }: { t: DocTemplate }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [k, setK] = useState(0.25);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    const ro = new ResizeObserver(() => setK(el.clientWidth / 1280));
    ro.observe(el);
    return () => { io.disconnect(); ro.disconnect(); };
  }, []);
  const html = useMemo(() => (seen ? docHtmlFor("view", { theme: t.theme, blocks: t.blocks.slice(0, 4), kind: t.kind, lang: t.lang, ctx: docSampleCtx(t.theme), terms: t.terms, productIds: [], serviceIds: [], title: t.name }) : ""), [seen, t]);
  return (
    <div ref={ref} className="dxt-thumb" style={{ height: Math.round(800 * k) }}>
      {seen && <iframe title={t.name} srcDoc={html} tabIndex={-1} aria-hidden="true" style={{ transform: `scale(${k})` }} />}
    </div>
  );
}

/** Settings page for one kind of document: the templates, which is default, sectors. */
export function DocTemplatesPanel({ kind, canManage }: { kind: DocKind; canManage: boolean }) {
  const [list, setList] = useState<DocTemplateRow[] | null | undefined>(undefined);
  const [editing, setEditing] = useState<DocTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [autoAi, setAutoAi] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [delAsk, setDelAsk] = useState<string | null>(null);
  const reload = useCallback(() => listDocTemplates(kind).then(setList).catch(() => setList([])), [kind]);
  useEffect(() => { reload(); }, [reload]);
  const noun = kind === "contract" ? "contract" : "proposal";
  const open = (t: DocTemplate) => setEditing(JSON.parse(JSON.stringify(t)));
  const dupT = async (t: DocTemplateRow) => {
    const { id: _id, ...rest } = t; void _id;
    const r = await saveDocTemplate({ ...rest, id: null, name: `${t.name} (copy)`, isDefault: false });
    if (r.error) setFlash({ kind: "err", text: r.error }); else { setFlash({ kind: "ok", text: "Template duplicated." }); reload(); }
  };
  const del = async (t: DocTemplateRow) => {
    setDelAsk(null);
    const e = await deleteDocTemplate(t.id);
    if (e) setFlash({ kind: "err", text: e }); else { setFlash({ kind: "ok", text: `“${t.name}” deleted.` }); reload(); }
  };
  const makeDefault = async (t: DocTemplateRow) => {
    const e = await setDefaultDocTemplate(t.id, kind);
    if (e) setFlash({ kind: "err", text: e }); else reload();
  };
  if (list === undefined) return <PageLoader label="Loading templates…" />;
  return (
    <div className="dxt">
      {list === null && (
        <div className="pte-flash is-info"><span>Run <b>28_proposal_html.sql</b> in Supabase to save templates. Until then you can try the editor — nothing is saved.</span></div>
      )}
      {flash && <DeckFlash flash={flash} onClose={() => setFlash(null)} />}
      <div className="dxt-intro">
        <div>
          <h2>{kind === "contract" ? "Contract templates" : "Proposal templates"}</h2>
          <p>{kind === "contract"
            ? "Contracts as clean web pages and PDFs: parties, clauses, prices and the year-by-year schedule come from the deal and its contract terms."
            : "Proposals as interactive web pages that open in any browser and print to PDF. One template per sector; each deal fills it with its client, products and prices."}</p>
        </div>
        {canManage && <button type="button" className="pte-btn is-primary" onClick={() => setCreating(true)}>{Ico.plus}New template</button>}
      </div>
      <div className="dxt-grid">
        {(list ?? []).map((t, i) => (
          <article key={t.id} className={`dxt-card ${t.isDefault ? "is-default" : ""}`} style={{ animationDelay: `${i * 40}ms` }}>
            <button type="button" className="dxt-open" onClick={() => open(t)} aria-label={`Open ${t.name}`}><DocThumb t={t} /></button>
            <div className="dxt-meta">
              <div className="dxt-name"><b>{t.name}</b>{t.isDefault && <span className="dxt-badge">{Ico.star}Default</span>}</div>
              <div className="dxt-secs">{t.sectors.length ? t.sectors.map((s) => <span key={s}>{s}</span>) : <em>Every sector</em>}</div>
              <div className="dxt-sub">{t.blocks.length} sections · {t.lang === "en" ? "English" : "Spanish"}{t.reference ? ` · from ${t.reference.fileName}` : ""}</div>
            </div>
            {canManage && (
              <div className="dxt-tools">
                <button type="button" className="pte-btn is-sm" onClick={() => open(t)}>{Ico.pen}Edit</button>
                {!t.isDefault && <button type="button" className="pte-btn is-sm" onClick={() => makeDefault(t)}>{Ico.star}Make default</button>}
                <button type="button" className="pte-btn is-sm" onClick={() => dupT(t)}>{Ico.copy}Duplicate</button>
                {delAsk === t.id ? (
                  <span className="dxt-del"><button type="button" className="pte-btn is-sm is-ghost" onClick={() => del(t)}>Delete</button><button type="button" className="pte-btn is-sm" onClick={() => setDelAsk(null)}>Keep</button></span>
                ) : <button type="button" className="pte-btn is-sm is-ghost" onClick={() => setDelAsk(t.id)} aria-label="Delete">{Ico.trash}</button>}
              </div>
            )}
          </article>
        ))}
        {canManage && (
          <button type="button" className="dxt-new" onClick={() => setCreating(true)}>
            <span>{Ico.plus}</span><b>New {noun} template</b><i>Start from our design or from one of your documents</i>
          </button>
        )}
        {!canManage && !(list ?? []).length && <p className="dxf-empty">No templates yet.</p>}
      </div>
      {creating && <NewDocTemplate kind={kind} templates={list ?? []} onClose={() => setCreating(false)} onReady={(t, o) => { setCreating(false); setAutoAi(!!o?.ai); setEditing(t); }} />}
      {editing && <DocTemplateEditor initial={editing} autoAi={autoAi} onClose={(changed) => { setEditing(null); setAutoAi(false); if (changed) reload(); }} />}
    </div>
  );
}

/** A document page scaled down into a box (previews of an import). */
function ScaledDoc({ html, height = 360 }: { html: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0.3);
  useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(() => setK(el.clientWidth / 1280)); ro.observe(el); return () => ro.disconnect(); }, []);
  return <div ref={ref} className="dxi-frame" style={{ height }}><iframe title="Preview" srcDoc={html} tabIndex={-1} aria-hidden="true" style={{ transform: `scale(${k})`, height: Math.round(height / k) }} /></div>;
}
/** The theme a reading gives (only what it found), on top of a base. */
const importedTheme = (base: DocTheme, t: Partial<DocTheme>): DocTheme => ({ ...base, ...Object.fromEntries(Object.entries(t).filter(([, v]) => v != null && v !== "")) } as DocTheme);
/** Custom fields as "Label → {{key}}", so "Sector: Retail" in a document becomes the field. */
async function importFields(): Promise<{ label: string; key: string }[]> {
  const defs = await loadDocVarDefs().catch(() => []);
  setDocCustomVars(defs);
  return defs.map((d) => ({ label: d.label, key: d.key }));
}
/**
 * After reading a document: keep its design (every page as it was, texts editable) or our layout with its colours,
 * fonts, logo and photos — side by side, the user picks.
 */
function ImportChooser({ imp, kind, lang, base, fileName, onPick, onBack }: {
  imp: ImportedDoc; kind: DocKind; lang: DocLang; base: DocTheme; fileName: string; onPick: (m: "faithful" | "smart") => void; onBack: () => void;
}) {
  const theme = useMemo(() => importedTheme(base, imp.theme), [base, imp]);
  const ctx = useMemo(() => docSampleCtx(theme), [theme]);
  const html = (blocks: DocBlock[]) => docHtmlFor("view", { theme, blocks: blocks.slice(0, 3), kind, lang, ctx, productIds: ["sample-p"], serviceIds: ["sample-s"], title: fileName });
  const faithful = useMemo(() => (imp.faithful?.length ? html(imp.faithful) : ""), [imp, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const smart = useMemo(() => html(imp.blocks), [imp, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const photos = imp.assets.filter((a) => a.role !== "page").length;
  const pal = [theme.primary, theme.accent, theme.ink, theme.muted].filter(Boolean);
  return (
    <div className="dxi">
      <div className="dxi-found">
        <b>Read {fileName}</b>
        <span>{imp.pages} {imp.source === "pdf" ? "page" : imp.source === "pptx" ? "slide" : "section"}{imp.pages === 1 ? "" : "s"} · {photos} picture{photos === 1 ? "" : "s"}</span>
        <span className="dxi-pal">{pal.map((c) => <i key={c} style={{ background: c }} title={c} />)}</span>
        {imp.fonts.length > 0 && <span className="dxi-fonts">{imp.fonts.slice(0, 4).join(" · ")}</span>}
      </div>
      <div className="dxi-grid">
        {faithful && (
          <button type="button" className="dxi-opt" onClick={() => onPick("faithful")}>
            <ScaledDoc html={faithful} />
            <b>Keep the original design <em>Recommended</em></b>
            <i>Every {imp.source === "pdf" ? "page" : "slide"} exactly as it is — photos, colours, fonts and layout — with its texts editable and the deal's values put in.</i>
          </button>
        )}
        <button type="button" className="dxi-opt" onClick={() => onPick("smart")}>
          <ScaledDoc html={smart} />
          <b>Our layout, your look</b>
          <i>The texts in our interactive sections, with your document's colours, fonts, logo and photos.</i>
        </button>
      </div>
      <button type="button" className="dxf-link" onClick={onBack}>Choose another file</button>
    </div>
  );
}
/** Keeps the pictures of an import (uploaded, or inline when Storage refuses) and gives the template's parts. */
async function keepImport(imp: ImportedDoc, m: "faithful" | "smart", base: DocTheme, onStage: (s: string) => void): Promise<{ blocks: DocBlock[]; theme: DocTheme; assets: string[] }> {
  const blocks = m === "faithful" && imp.faithful?.length ? imp.faithful : imp.blocks;
  const kept = await persistImported(blocks, imp.theme, m === "faithful" ? imp.assets : imp.assets.filter((a) => a.role !== "page"),
    (b, role) => uploadDocImage(b, role === "page" ? "page" : role === "logo" ? "logo" : "ref"),
    (d, n) => onStage(n ? `Keeping the pictures… ${d} of ${n}` : "Keeping the pictures…"));
  return { blocks: kept.blocks, theme: importedTheme(base, kept.theme), assets: kept.library };
}

/** New template: our design, or built from a reference document. */
function NewDocTemplate({ kind, templates, onClose, onReady }: { kind: DocKind; templates: DocTemplateRow[]; onClose: () => void; onReady: (t: DocTemplate, o?: { ai?: boolean }) => void }) {
  const [lang, setLang] = useState<DocLang>("es");
  const [stage, setStage] = useState<null | string>(null);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [read, setRead] = useState<{ imp: ImportedDoc; file: File; base: DocTheme } | null>(null);
  const [from, setFrom] = useState<DocTheme | null>(null);
  const inp = useRef<HTMLInputElement>(null);
  const seedTheme = async (): Promise<DocTheme> => ({ ...DEFAULT_DOC_THEME, ...(await docThemeSeed().catch(() => ({}))) });
  const fromDesign = async (style: DocTheme["style"]) => {
    setStage("Preparing…");
    const th = { ...(await seedTheme()), style };
    const t = defaultDocTemplate(kind, lang, th);
    onReady({ ...t, id: null });
  };
  const fromFile = async (f: File) => {
    setErr(null); setStage(`Reading ${f.name}…`);
    try {
      const [seed, fields] = await Promise.all([seedTheme(), importFields()]);
      const imp = await importReferenceDoc(f, kind, {}, { provider: seed.company, fields, onStage: setStage });
      setRead({ imp, file: f, base: seed }); setStage(null);
    } catch (e: any) { setStage(null); setErr(e?.message ?? "Could not read that document."); }
  };
  const pick = async (m: "faithful" | "smart") => {
    if (!read) return;
    const { imp, file: f, base: seed } = read;
    setStage("Keeping the pictures…");
    try {
      const kept = await keepImport(imp, m, seed, setStage);
      const base = defaultDocTemplate(kind, lang, kept.theme);
      onReady({ ...base, id: null, name: f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim() || base.name, blocks: kept.blocks, theme: kept.theme, assets: kept.assets, terms: { ...base.terms, ...(imp.terms ?? {}) }, reference: { fileName: f.name, kind: imp.source, at: new Date().toISOString() } }, { ai: true });
    } catch (e: any) { setStage(null); setErr(e?.message ?? "Could not keep the document."); }
  };
  const openFrom = async () => setFrom(await seedTheme());
  if (from) {
    return (
      <StartFrom kind={kind} lang={lang} base={from} templates={templates} onClose={() => setFrom(null)}
        onTemplate={(t) => { const { id: _id, ...rest } = t; void _id; onReady({ ...rest, id: null, isDefault: false, name: `${t.name} (copy)` }); }}
        onPicked={(r) => { const b = defaultDocTemplate(kind, lang, r.theme); onReady({ ...b, id: null, name: r.name || b.name, blocks: r.blocks, theme: r.theme, assets: r.assets, terms: { ...b.terms, ...(r.terms ?? {}) }, reference: r.reference }, { ai: true }); }} />
    );
  }
  return createPortal(
    <div className="dxk-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !stage) onClose(); }}>
      <div className={`dxn ${read && !stage ? "is-wide" : ""}`} role="dialog" aria-modal="true" aria-label="New template">
        <div className="dxk-head"><b>New {kind} template</b><span>You can change everything afterwards.</span><button type="button" className="dxb-x" onClick={onClose} aria-label="Close" disabled={!!stage}><DIcon d="x" w={2.2} /></button></div>
        {stage ? (
          <div className="dxn-busy"><span className="dxb-spin is-lg" /><b>{stage}</b><i>Placing the deal's values where they fit…</i></div>
        ) : read ? (
          <ImportChooser imp={read.imp} kind={kind} lang={lang} base={read.base} fileName={read.file.name} onPick={pick} onBack={() => setRead(null)} />
        ) : (
          <>
            <div className="dxn-lang">
              <span>Language of the document</span>
              <div className="dxb-seg is-sm">
                <button type="button" className={lang === "es" ? "is-on" : ""} onClick={() => setLang("es")}>Spanish</button>
                <button type="button" className={lang === "en" ? "is-on" : ""} onClick={() => setLang("en")}>English</button>
              </div>
            </div>
            <div className="dxn-grid">
              <div className="dxn-col">
                <h4>Start from our design</h4>
                <p>Ready-made copy and layout with every value in place.</p>
                <div className="dxn-styles">
                  {([["soft", "Soft"], ["sharp", "Editorial"], ["bold", "Bold"]] as const).map(([k, l]) => (
                    <button key={k} type="button" className={`dxn-style s-${k}`} onClick={() => fromDesign(k)}>
                      <span className="dxn-mini"><i /><i /><i /></span><b>{l}</b>
                    </button>
                  ))}
                </div>
              </div>
              <div className="dxn-col">
                <h4>Build it from your document</h4>
                <p>Drop a {kind === "contract" ? "contract" : "proposal"} you already use — PowerPoint, PDF, Word or text. We read its sections, colours and pictures and put the values in.</p>
                <button type="button" className={`dxn-drop ${over ? "is-over" : ""}`} onClick={() => inp.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
                  onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) fromFile(f); }}>
                  <DIcon d="upload" /><b>Drop a file or click to choose</b><i>.pptx · .pdf · .docx · .txt · .md · .html</i>
                </button>
                <input ref={inp} type="file" hidden accept=".pptx,.pdf,.docx,.txt,.md,.html,.htm" onChange={(e) => { const f = e.target.files?.[0]; if (f) fromFile(f); e.target.value = ""; }} />
                {err && <p className="dxn-err">{err}</p>}
              </div>
            </div>
            <button type="button" className="dxn-from" onClick={openFrom}>
              <span className="dxn-from-ic"><DIcon d="layers" /></span>
              <span><b>Start from something you already have</b><i>Another template, a {kind === "contract" ? "contract" : "proposal"} made on a deal, or a PowerPoint, PDF or Word file kept on a deal</i></span>
              <DIcon d="ext" />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ---------- AI suggestions: values → variables, pages that depend on a product or service ---------- */
type AiCatalog = { products: { id: string; name: string }[]; services: { id: string; name: string }[] };
/** Around `find` in `text`: a few words before and after, with the found part marked. */
function snippet(text: string, find: string): [string, string, string] {
  const t = text.replace(/\s+/g, " "), f = find.replace(/\s+/g, " ");
  const i = t.indexOf(f);
  if (i < 0) return ["", f, ""];
  const a = t.slice(Math.max(0, i - 48), i), b = t.slice(i + f.length, i + f.length + 48);
  return [(i > 48 ? "…" : "") + a, f, b + (i + f.length + 48 < t.length ? "…" : "")];
}
function AiRow({ on, off, onFlip, children }: { on: boolean; off?: boolean; onFlip: () => void; children: React.ReactNode }) {
  return (
    <label className={`dai-row ${on ? "is-on" : ""} ${off ? "is-off" : ""}`}>
      <input type="checkbox" checked={on} disabled={off} onChange={onFlip} />
      <span className="dai-tick"><DIcon d="check" w={3} /></span>
      <div className="dai-body">{children}</div>
    </label>
  );
}
/**
 * What the AI suggests to turn a document into a template (or a document written for another client into this deal's):
 * texts that become the deal's variables, wording fixes and pages shown only for a product / service. Accept all or one by one.
 */
export function AiReview({ blocks, kind, lang, provider, clientNames, catalog: cat0, title, onApply, onClose }: {
  blocks: DocBlock[]; kind: DocKind; lang: DocLang; provider?: string; clientNames?: string[]; catalog?: AiCatalog; title?: string;
  onApply: (blocks: DocBlock[], summary: string) => void; onClose: () => void;
}) {
  const [res, setRes] = useState<DocSuggestion | null>(null);
  const [cat, setCat] = useState<AiCatalog | null>(cat0 ?? null);
  const [acc, setAcc] = useState<{ rep: boolean[]; sec: boolean[] }>({ rep: [], sec: [] });
  useEffect(() => {
    let live = true;
    (async () => {
      const c = cat0 ?? await Promise.all([loadProducts(), loadServices()]).then(([ps, ss]) => ({ products: ps.map((x: any) => ({ id: x.id, name: x.name })), services: ss.map((x: any) => ({ id: x.id, name: x.name })) })).catch(() => ({ products: [], services: [] }));
      if (!live) return;
      setCat(c);
      const r = await suggestDocPlan(blocks, { kind, lang, provider, clientNames, catalog: c });
      if (!live) return;
      setRes(r);
      setAcc({ rep: r.plan.replacements.map(() => true), sec: r.plan.sections.map((x) => x.when === "always" || matchCatalog(x.names ?? [], x.when === "product" ? c.products : c.services).length > 0) });
    })();
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map((res?.inv ?? []).map((x) => [x.id, x])), [res]);
  const plan = res?.plan;
  const reps = (plan?.replacements ?? []).map((r, k) => ({ r, k }));
  const vars = reps.filter((x) => x.r.token), fixes = reps.filter((x) => !x.r.token);
  const secs = (plan?.sections ?? []).map((x, k) => ({ x, k, ok: x.when === "always" || (!!cat && matchCatalog(x.names ?? [], x.when === "product" ? cat.products : cat.services).length > 0) }));
  const n = acc.rep.filter(Boolean).length + acc.sec.filter(Boolean).length;
  const total = reps.length + secs.filter((s) => s.ok).length;
  const setAll = (on: boolean) => setAcc({ rep: reps.map(() => on), sec: secs.map((s) => on && s.ok) });
  const flip = (g: "rep" | "sec", k: number) => setAcc((a) => ({ ...a, [g]: a[g].map((v, i) => (i === k ? !v : v)) }));
  const apply = (a = acc) => {
    if (!plan || !cat) return;
    const r = applyDocPlan(blocks, res!.inv, plan, a, cat);
    onApply(r.blocks, `${r.applied} suggestion${r.applied === 1 ? "" : "s"} applied${r.missed ? ` · ${r.missed} couldn't be placed` : ""}. Check them and save.`);
  };
  const pageTitle = (p: number) => {
    const its = (res?.inv ?? []).filter((x) => x.page === p);
    const t = its.find((x) => x.role === "title") ?? [...its].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    return (t?.text ?? "").split("\n")[0].slice(0, 70);
  };
  return createPortal(
    <div className="dxk-back" style={{ zIndex: 2147483100 }} onMouseDown={(e) => { if (e.target === e.currentTarget && res) onClose(); }}>
      <div className="dxn dai" role="dialog" aria-modal="true" aria-label="AI suggestions">
        <div className="dxk-head">
          <span className="dai-ic"><DIcon d="spark" /></span>
          <b>AI suggestions</b>
          <span>{title ?? "Turn this document's one-off values into variables, and show pages only for the products or services they describe."}</span>
          <button type="button" className="dxb-x" onClick={onClose} aria-label="Close"><DIcon d="x" w={2.2} /></button>
        </div>
        {!res ? (
          <div className="dxn-busy"><span className="dai-orb"><i /><i /><i /></span><b>Reading the texts…</b><i>Only the words are read — pictures and files stay here.</i></div>
        ) : (
          <>
            <div className={`dai-src ${plan?.source === "ai" ? "is-ai" : ""}`}>
              {plan?.source === "ai" ? <><DIcon d="spark" /><span><b>Claude</b>{plan.model ? ` · ${plan.model}` : ""}{plan.notes ? ` — ${plan.notes}` : ""}</span></>
                : <><DIcon d="sliders" /><span><b>Suggested by rules.</b> {res.fallback}</span></>}
            </div>
            {!total ? (
              <div className="dai-empty"><DIcon d="check" w={2.4} /><b>Nothing to change</b><i>The deal's values are already variables and every page applies to any deal.</i></div>
            ) : (
              <div className="dai-list">
                {vars.length > 0 && <h5>Values that become variables <em>{vars.length}</em></h5>}
                {vars.map(({ r, k }) => {
                  const it = byId.get(r.id); const [a, f, b] = snippet(it?.text ?? "", r.find);
                  return (
                    <AiRow key={`r${k}`} on={!!acc.rep[k]} onFlip={() => flip("rep", k)}>
                      <div className="dai-line"><span className="dai-pg">p{it?.page}</span><span className="dai-ctx">{a}<s>{f}</s>{b}</span></div>
                      <div className="dai-to"><DIcon d="down" /><code style={{ ["--c" as any]: docVarColor(r.token!) }}>{docTokenLabel(r.token!)}</code><i>{r.reason}</i></div>
                    </AiRow>
                  );
                })}
                {fixes.length > 0 && <h5>Wording <em>{fixes.length}</em></h5>}
                {fixes.map(({ r, k }) => {
                  const it = byId.get(r.id); const [a, f, b] = snippet(it?.text ?? "", r.find);
                  return (
                    <AiRow key={`f${k}`} on={!!acc.rep[k]} onFlip={() => flip("rep", k)}>
                      <div className="dai-line"><span className="dai-pg">p{it?.page}</span><span className="dai-ctx">{a}<s>{f}</s>{b}</span></div>
                      <div className="dai-to"><DIcon d="down" /><b className="dai-new">{r.text || "(removed)"}</b><i>{r.reason}</i></div>
                    </AiRow>
                  );
                })}
                {secs.length > 0 && <h5>Pages for one product or service <em>{secs.length}</em></h5>}
                {secs.map(({ x, k, ok }) => (
                  <AiRow key={`s${k}`} on={!!acc.sec[k]} off={!ok} onFlip={() => flip("sec", k)}>
                    <div className="dai-line"><span className="dai-pg">p{x.page}</span><span className="dai-ctx"><b>{pageTitle(x.page) || `Page ${x.page}`}</b></span></div>
                    <div className="dai-to"><DIcon d="eye" />
                      <span className="dai-cond">{x.when === "always" ? "Every deal" : <>Only when the deal has <b>{(x.names ?? []).join(", ")}</b></>}</span>
                      <i>{ok ? x.reason : "Not in your catalog — add it or set the page's condition by hand."}</i>
                    </div>
                  </AiRow>
                ))}
              </div>
            )}
            <div className="dai-foot">
              {total > 0 && <button type="button" className="dxf-link" onClick={() => setAll(n < total)}>{n < total ? "Select all" : "Select none"}</button>}
              <span className="dai-count">{total ? `${n} of ${total} selected` : ""}</span>
              <button type="button" className="dxb-btn" onClick={onClose}>{total ? "Not now" : "Close"}</button>
              {total > 0 && n < total && <button type="button" className="dxb-btn" onClick={() => apply({ rep: reps.map(() => true), sec: secs.map((x) => x.ok) })}>Accept all</button>}
              {total > 0 && <button type="button" className="dxb-btn is-primary" disabled={!n} onClick={() => apply()}><DIcon d="check" w={2.4} />{n === total ? `Accept all ${n}` : `Apply ${n}`}</button>}
            </div>
          </>
        )}
      </div>
    </div>, document.body);
}

/* ---------- "Start from…": a template, a document made on a deal, or a file on a deal ---------- */
export interface StartPicked {
  blocks: DocBlock[]; theme: DocTheme; assets: string[]; terms?: DocTemplate["terms"];
  name: string; reference: { fileName: string; kind: string; at: string }; alsoTemplate: boolean;
}
const ago = (iso?: string) => {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  return d < 1 ? "today" : d < 2 ? "yesterday" : d < 30 ? `${Math.floor(d)} days ago` : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const extOf = (n: string) => (n.split(".").pop() ?? "").toLowerCase();
/**
 * Pick what a document starts from: one of the templates, a proposal / contract already made on a deal,
 * or a PowerPoint / PDF / Word file kept on a deal (or uploaded now). Files are read and rebuilt here.
 */
export function StartFrom({ kind, lang, base, trackingId, excludeProposalId, templates, onTemplate, onPicked, onClose, offerTemplate }: {
  kind: DocKind; lang: DocLang; base: DocTheme; trackingId?: string; excludeProposalId?: string;
  templates?: DocTemplateRow[]; onTemplate?: (t: DocTemplateRow) => void;
  onPicked: (r: StartPicked) => void; onClose: () => void; offerTemplate?: boolean;
}) {
  const noun = kind === "contract" ? "contract" : "proposal";
  const [tab, setTab] = useState<"tpl" | "docs" | "files">(templates?.length ? "tpl" : "docs");
  const [src, setSrc] = useState<{ docs: DocSourceDoc[]; files: DocSourceFile[] } | null>(null);
  const [q, setQ] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [read, setRead] = useState<{ imp: ImportedDoc; name: string } | null>(null);
  const [also, setAlso] = useState(false);
  const [over, setOver] = useState(false);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { listDocSources(kind, { trackingId, excludeProposalId }).then(setSrc).catch(() => setSrc({ docs: [], files: [] })); }, [kind, trackingId, excludeProposalId]);
  const match = (...xs: (string | undefined)[]) => !q.trim() || xs.some((x) => (x ?? "").toLowerCase().includes(q.trim().toLowerCase()));
  const readFile = async (f: File) => {
    setErr(null); setStage(`Reading ${f.name}…`);
    try {
      const fields = await importFields();
      const imp = await importReferenceDoc(f, kind, {}, { provider: base.company, fields, onStage: setStage });
      setRead({ imp, name: f.name }); setStage(null);
    } catch (e: any) { setStage(null); setErr(e?.message ?? "Could not read that document."); }
  };
  const openFile = async (x: DocSourceFile) => {
    setErr(null); setStage(`Opening ${x.name}…`);
    try { await readFile(await trackingFileAsFile(x.path, x.name)); } catch (e: any) { setStage(null); setErr(e?.message ?? "Could not open the file."); }
  };
  const pick = async (m: "faithful" | "smart") => {
    if (!read) return;
    setStage("Keeping the pictures…");
    try {
      const kept = await keepImport(read.imp, m, base, setStage);
      onPicked({ blocks: kept.blocks, theme: kept.theme, assets: kept.assets, terms: read.imp.terms, alsoTemplate: also,
        name: read.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim(), reference: { fileName: read.name, kind: read.imp.source, at: new Date().toISOString() } });
    } catch (e: any) { setStage(null); setErr(e?.message ?? "Could not keep the document."); }
  };
  const fromDoc = (d: DocSourceDoc) => onPicked({
    blocks: JSON.parse(JSON.stringify(d.inst.blocks)), theme: { ...base, ...(d.inst.theme ?? {}) }, assets: d.inst.assets ?? [], alsoTemplate: also,
    name: `${d.name} · ${d.deal}`, reference: { fileName: `${d.deal} · ${d.name}`, kind: "deal", at: new Date().toISOString() },
  });
  const tpls = (templates ?? []).filter((t) => match(t.name, t.sectors.join(" ")));
  const docs = (src?.docs ?? []).filter((d) => match(d.name, d.deal));
  const files = (src?.files ?? []).filter((f) => match(f.name, f.deal));
  const tabs: { k: "tpl" | "docs" | "files"; label: string; n: number | null }[] = [
    ...(templates ? [{ k: "tpl" as const, label: "Templates", n: templates.length }] : []),
    { k: "docs", label: kind === "contract" ? "Contracts on deals" : "Proposals on deals", n: src ? src.docs.length : null },
    { k: "files", label: "Files on deals", n: src ? src.files.length : null },
  ];
  const here = (t: string) => !!trackingId && t === trackingId;
  return createPortal(
    <div className="dxk-back" style={{ zIndex: 2147483050 }} onMouseDown={(e) => { if (e.target === e.currentTarget && !stage) onClose(); }}>
      <div className={`dxn dsf ${read && !stage ? "is-wide" : ""}`} role="dialog" aria-modal="true" aria-label="Start from">
        <div className="dxk-head">
          <b>Start from…</b>
          <span>{read ? "Choose how to keep it." : `A template, a ${noun} you already made, or one of your files. Nothing changes until you pick.`}</span>
          <button type="button" className="dxb-x" onClick={onClose} disabled={!!stage} aria-label="Close"><DIcon d="x" w={2.2} /></button>
        </div>
        {stage ? (
          <div className="dxn-busy"><span className="dxb-spin is-lg" /><b>{stage}</b><i>Rebuilding every page with its colours, fonts and pictures…</i></div>
        ) : read ? (
          <ImportChooser imp={read.imp} kind={kind} lang={lang} base={base} fileName={read.name} onPick={pick} onBack={() => setRead(null)} />
        ) : (
          <>
            <div className="dsf-bar">
              <div className="dsf-tabs" role="tablist">
                {tabs.map((t) => <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} className={tab === t.k ? "is-on" : ""} onClick={() => setTab(t.k)}>{t.label}{t.n != null && <em>{t.n}</em>}</button>)}
              </div>
              <label className="dsf-q"><DIcon d="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or deal…" /></label>
            </div>
            <div className="dsf-list">
              {tab === "tpl" && (tpls.length ? tpls.map((t, i) => (
                <button key={t.id} type="button" className="dsf-it" style={{ animationDelay: `${i * 25}ms` }} onClick={() => onTemplate?.(t)}>
                  <span className="dsf-ic is-tpl"><DIcon d="layers" /></span>
                  <span className="dsf-tx"><b>{t.name}</b><i>{t.blocks.length} sections{t.sectors.length ? ` · ${t.sectors.join(", ")}` : ""}{t.isDefault ? " · default" : ""}</i></span>
                  <span className="dsf-go">Use<DIcon d="ext" /></span>
                </button>
              )) : <p className="dsf-empty">No templates match.</p>)}
              {tab === "docs" && (!src ? <div className="dsf-load"><span className="dxb-spin" />Looking at your deals…</div> : docs.length ? docs.map((d, i) => (
                <button key={d.id} type="button" className="dsf-it" style={{ animationDelay: `${i * 25}ms` }} onClick={() => fromDoc(d)}>
                  <span className="dsf-ic is-doc"><DIcon d="page" /></span>
                  <span className="dsf-tx"><b>{d.name}{here(d.trackingId) && <em>This deal</em>}</b><i>{d.deal} · {d.inst.blocks.length} sections · edited {ago(d.updatedAt)}</i></span>
                  <span className="dsf-go">Use<DIcon d="ext" /></span>
                </button>
              )) : <p className="dsf-empty">{q ? "Nothing matches." : `No ${noun}s made on deals yet.`}</p>)}
              {tab === "files" && (!src ? <div className="dsf-load"><span className="dxb-spin" />Looking at your deals…</div> : files.length ? files.map((f, i) => (
                <button key={f.id} type="button" className="dsf-it" style={{ animationDelay: `${i * 25}ms` }} onClick={() => openFile(f)}>
                  <span className={`dsf-ic is-${extOf(f.name)}`}>{extOf(f.name).toUpperCase()}</span>
                  <span className="dsf-tx"><b>{f.name}{here(f.trackingId) && <em>This deal</em>}</b><i>{f.deal} · {ago(f.at)}{f.size ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB` : ""}</i></span>
                  <span className="dsf-go">Import<DIcon d="ext" /></span>
                </button>
              )) : <p className="dsf-empty">{q ? "Nothing matches." : "No PowerPoint, PDF or Word files on your deals yet."}</p>)}
            </div>
            <button type="button" className={`dsf-drop ${over ? "is-over" : ""}`} onClick={() => inp.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) readFile(f); }}>
              <DIcon d="upload" /><span><b>Or drop a file from your computer</b><i>.pptx · .pdf · .docx — colours, fonts, pictures and layout are kept</i></span>
            </button>
            <input ref={inp} type="file" hidden accept=".pptx,.pdf,.docx,.txt,.md,.html,.htm" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ""; }} />
            {err && <p className="dxn-err">{err}</p>}
          </>
        )}
        {offerTemplate && !stage && tab !== "tpl" && (
          <label className="dsf-also"><input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} /><span className="dai-tick"><DIcon d="check" w={3} /></span>Also keep it as a new {noun} template</label>
        )}
      </div>
    </div>, document.body);
}

/** Editing one template (Settings). */
function DocTemplateEditor({ initial, autoAi, onClose }: { initial: DocTemplate; autoAi?: boolean; onClose: (changed: boolean) => void }) {
  const [t, setT] = useState<DocTemplate>(initial);
  const [dirty, setDirty] = useState(!initial.id);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [closeAsk, setCloseAsk] = useState(false);
  const [sectorOpts, setSectorOpts] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<{ products: { id: string; name: string }[]; services: { id: string; name: string }[] }>({ products: [], services: [] });
  const [reimport, setReimport] = useState<string | null>(null);
  const [reread, setReread] = useState<{ imp: ImportedDoc; file: File } | null>(null);
  const [ai, setAi] = useState(false);
  const [catReady, setCatReady] = useState(false);
  const [, setVarsTick] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    importFields().then(() => setVarsTick((n) => n + 1)).catch(() => undefined);
    listCrmOptions().then((os) => setSectorOpts(Array.from(new Set([...os.filter((o) => o.kind === "sector").map((o) => o.label), ...DEFAULT_SECTORS.map((s) => s.label)])))).catch(() => setSectorOpts(DEFAULT_SECTORS.map((s) => s.label)));
    Promise.all([loadProducts(), loadServices()]).then(([ps, ss]) => setCatalog({ products: ps.map((x: any) => ({ id: x.id, name: x.name })), services: ss.map((x: any) => ({ id: x.id, name: x.name })) })).catch(() => undefined).finally(() => { setCatReady(true); if (autoAi) setAi(true); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const upd = (patch: Partial<DocTemplate>) => { setT((x) => ({ ...x, ...patch })); setDirty(true); setMsg(null); };
  const ctx = useMemo(() => docSampleCtx(t.theme), [t.theme]);
  const save = async () => {
    setSaving(true);
    const r = await saveDocTemplate(t);
    setSaving(false);
    if (r.error) { setMsg({ kind: "err", text: r.error }); return; }
    setT((x) => ({ ...x, id: r.id })); setDirty(false); setSaved(true); setMsg({ kind: "ok", text: "Saved." });
  };
  const rebuild = async (f: File) => {
    setReimport(`Reading ${f.name}…`);
    try {
      const fields = await importFields();
      const imp = await importReferenceDoc(f, t.kind, {}, { provider: t.theme.company, fields, onStage: setReimport });
      setReread({ imp, file: f });
    } catch (e: any) { setMsg({ kind: "err", text: e?.message ?? "Could not read that document." }); }
    finally { setReimport(null); }
  };
  const rebuildAs = async (m: "faithful" | "smart") => {
    if (!reread) return;
    const { imp, file: f } = reread;
    setReread(null); setReimport("Keeping the pictures…");
    try {
      const kept = await keepImport(imp, m, t.theme, setReimport);
      upd({ blocks: kept.blocks, theme: kept.theme, terms: { ...t.terms, ...(imp.terms ?? {}) }, assets: Array.from(new Set([...(t.assets ?? []), ...kept.assets])), reference: { fileName: f.name, kind: imp.source, at: new Date().toISOString() } });
      setMsg({ kind: "ok", text: `Rebuilt from ${f.name}: ${kept.blocks.length} ${m === "faithful" ? "pages" : "sections"}. Check them and save.` });
      setAi(true);
    } catch (e: any) { setMsg({ kind: "err", text: e?.message ?? "Could not keep the document." }); }
    finally { setReimport(null); }
  };
  const close = () => { if (dirty) setCloseAsk(true); else onClose(saved); };
  const docTab = (
    <div className="dxf">
      <section className="dxf-sec">
        <h4>Sectors</h4>
        <p className="dxf-sub">Deals of companies in these sectors get this template. None = any sector (when it's the default).</p>
        <div className="dxf-chips">
          {sectorOpts.map((s) => { const on = t.sectors.includes(s); return <button key={s} type="button" className={on ? "is-on" : ""} onClick={() => upd({ sectors: on ? t.sectors.filter((x) => x !== s) : [...t.sectors, s] })}>{on && <DIcon d="check" w={3} />}{s}</button>; })}
        </div>
      </section>
      <section className="dxf-sec">
        <h4>Language</h4>
        <div className="dxb-seg is-full">
          <button type="button" className={t.lang === "es" ? "is-on" : ""} onClick={() => upd({ lang: "es" })}>Spanish</button>
          <button type="button" className={t.lang === "en" ? "is-on" : ""} onClick={() => upd({ lang: "en" })}>English</button>
        </div>
        <p className="dxf-sub">Dates, the price tables and the schedule follow it.</p>
      </section>
      <section className="dxf-sec">
        <h4>Commercial terms</h4>
        <label className="dxf-row"><span>Offer valid (days)</span><input type="number" min={0} value={t.terms?.validityDays ?? 30} onChange={(e) => upd({ terms: { ...t.terms, validityDays: Number(e.target.value) || 0 } })} /></label>
        <label className="dxf-row"><span>Payment (days)</span><input type="number" min={0} value={t.terms?.paymentDays ?? 30} onChange={(e) => upd({ terms: { ...t.terms, paymentDays: Number(e.target.value) || 0 } })} /></label>
        <label className="dxf-row"><span>Yearly increase (%)</span><input type="number" step={0.5} min={0} value={t.terms?.annualIncreasePct ?? 0} onChange={(e) => upd({ terms: { ...t.terms, annualIncreasePct: Number(e.target.value) || 0 } })} /></label>
        <p className="dxf-sub">The deal's contract terms win when it has them.</p>
      </section>
      <section className="dxf-sec">
        <h4>AI suggestions</h4>
        <p className="dxf-sub">Finds the client's names, dates, prices and contacts still written out and turns them into variables; pages about one product or service show only when the deal has it.</p>
        <button type="button" className="dxb-btn is-full dai-cta" disabled={!catReady || !t.blocks.length} onClick={() => setAi(true)}><DIcon d="spark" />Suggest variables and conditions</button>
      </section>
      <section className="dxf-sec">
        <h4>Reference document</h4>
        {t.reference ? <p className="dxf-sub">Built from <b>{t.reference.fileName}</b>.</p> : <p className="dxf-sub">Rebuild the sections from one of your documents (replaces the current ones).</p>}
        <button type="button" className="dxb-btn is-full" disabled={!!reimport} onClick={() => ref.current?.click()}>{reimport ? <><span className="dxb-spin" />{reimport}</> : <><DIcon d="upload" />Rebuild from a document</>}</button>
        <input ref={ref} type="file" hidden accept=".pptx,.pdf,.docx,.txt,.md,.html,.htm" onChange={(e) => { const f = e.target.files?.[0]; if (f) rebuild(f); e.target.value = ""; }} />
      </section>
    </div>
  );
  return (
    <>
      <DocBuilder
        mode="template" kind={t.kind} lang={t.lang} title={t.name}
        theme={t.theme} onTheme={(theme) => upd({ theme })}
        blocks={t.blocks} onBlocks={(blocks) => upd({ blocks })}
        terms={t.terms} onTerms={(terms) => upd({ terms })}
        ctx={ctx} productIds={["sample-p"]} serviceIds={["sample-s"]} catalog={catalog}
        uploadImage={(f) => uploadDocImage(f, "doc")}
        assets={t.assets ?? []} onAssets={(assets) => upd({ assets })}
        previewHtml={() => docHtmlFor("view", { theme: t.theme, blocks: t.blocks, kind: t.kind, lang: t.lang, ctx, terms: t.terms, productIds: ["sample-p"], serviceIds: ["sample-s"], title: t.name })}
        head={(
          <div className="dxb-title">
            <span className="dxb-eyebrow">{t.kind === "contract" ? "Contract template" : "Proposal template"}{t.sectors.length ? ` · ${t.sectors.join(", ")}` : ""}</span>
            <input value={t.name} onChange={(e) => upd({ name: e.target.value })} aria-label="Template name" />
          </div>
        )}
        actions={(
          <>
            {dirty && <span className="dxb-dirty"><i />Unsaved</span>}
            <button type="button" className="dxb-btn is-primary" disabled={saving || !dirty} onClick={save}>{saving ? <span className="dxb-spin" /> : <DIcon d="check" w={2.4} />}{t.id ? "Save" : "Create template"}</button>
          </>
        )}
        status={msg ? <span className={`dxb-msg is-${msg.kind}`}>{msg.text}</span> : <span className="dxb-msg">Editing with a sample deal — every value will be the deal's own.</span>}
        docTab={docTab}
        onClose={close}
      />
      {reread && createPortal(
        <div className="dxk-back" style={{ zIndex: 2147482000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) setReread(null); }}>
          <div className="dxn is-wide" role="dialog" aria-modal="true" aria-label="Rebuild from a document">
            <div className="dxk-head"><b>Rebuild from {reread.file.name}</b><span>Replaces the current sections. Nothing is saved until you save.</span><button type="button" className="dxb-x" onClick={() => setReread(null)} aria-label="Close"><DIcon d="x" w={2.2} /></button></div>
            <ImportChooser imp={reread.imp} kind={t.kind} lang={t.lang} base={t.theme} fileName={reread.file.name} onPick={rebuildAs} onBack={() => { setReread(null); ref.current?.click(); }} />
          </div>
        </div>, document.body)}
      {ai && catReady && (
        <AiReview blocks={t.blocks} kind={t.kind} lang={t.lang} provider={t.theme.company} catalog={catalog}
          onClose={() => setAi(false)}
          onApply={(blocks, summary) => { setAi(false); upd({ blocks }); setMsg({ kind: "ok", text: summary }); }} />
      )}
      {closeAsk && createPortal(
        <div className="dxk-back" style={{ zIndex: 2147483000 }}>
          <div className="dxc" role="alertdialog" aria-modal="true">
            <b>Leave without saving?</b>
            <p>Your changes to this template will be lost.</p>
            <div><button type="button" className="dxb-btn" onClick={() => setCloseAsk(false)}>Keep editing</button><button type="button" className="dxb-btn is-danger" onClick={() => onClose(saved)}>Discard changes</button><button type="button" className="dxb-btn is-primary" onClick={async () => { await save(); setCloseAsk(false); }}>Save</button></div>
          </div>
        </div>, document.body)}
    </>
  );
}
