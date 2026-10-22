/* eslint-disable @typescript-eslint/no-explicit-any */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import {
  loadProducts, loadServices, saveProduct, deleteProduct, saveService, deleteService,
  type Product, type Service, type ProductTier, type TierDuration,
  calcTotal, calcBreakdown, emptyCalculator, emptyCalcVariable, yearlySchedule, incrementLabel, BASE_KEY,
  type Calculator, type CalcVariable, type CalcVarType,
} from "./catalogApi";
import {
  loadBlueprintData, saveBlueprintData,
  type Blueprint, type ProjectType, type ClientRole, type BlueprintPhase,
} from "./blueprintsApi";
import Select from "../../framework/Select";
import { ROLE_COLORS, roleColor } from "../clients/clientsTypes";
import { listCrmOptions, addCrmOption, deleteCrmOption, productKindOptions, type CrmOption } from "../companies/companiesApi";
import "../clients/ClientsPage.css";
import "./CatalogPage.css";

interface Props { onBack: () => void; }

type Tab = "products" | "services" | "blueprints";

const money = (n: number) => `€${(Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

// ---- Product kinds (your list; the old fixed values were "saas" / "physical") ----
const kindKey = (k: string | null | undefined) => String(k ?? "").trim().toLowerCase();
/** The kind as your list writes it ("saas" → "SaaS"). */
const kindLabel = (k: string | null | undefined, kinds: string[]) => {
  const hit = kinds.find((o) => kindKey(o) === kindKey(k));
  if (hit) return hit;
  if (kindKey(k) === "saas") return "SaaS";
  const t = String(k ?? "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "No kind";
};
/** A stable colour per kind: SaaS and Physical keep theirs, the rest by name. */
const KIND_HUES = ["#d1685f", "#c9973a", "#7c5cd6", "#2f9e8f", "#d0628f", "#5b7fd6", "#8a6d3b", "#4f9b4a"];
const kindColor = (k: string | null | undefined) => {
  const key = kindKey(k);
  if (key === "saas") return "#12b57f";
  if (key === "physical") return "#3c7fb8";
  let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return KIND_HUES[h % KIND_HUES.length];
};
const kindClass = (k: string | null | undefined) => (["saas", "physical"].includes(kindKey(k)) ? kindKey(k) : "custom");

function KindIcon({ kind }: { kind: string }) {
  const k = kindKey(kind);
  if (k === "saas") return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10a6 6 0 0 0-11.3-2.7A4.5 4.5 0 0 0 7 16h11a4 4 0 0 0 0-8z" />
    </svg>
  );
  if (k === "physical") return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 7v10l9 4 9-4V7" /><path d="M12 11v10" />
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  );
}

/** "Available in proposals": whether sales can put it in a proposal (and its slides can be picked in the deck). */
function ProposalSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`cat-prop-sw ${on ? "is-on" : ""}`} onClick={() => onChange(!on)}
      title={on ? "Sales can add it to proposals" : "Hidden when building proposals"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 9h6M7 12h10" />
      </svg>
      <span className="cat-prop-sw-txt">Available in proposals</span>
      <span className="cat-prop-sw-track"><i /></span>
    </button>
  );
}
/** Card hint when it's kept out of proposals. */
const NotInProposals = () => (
  <span className="cat-pill is-noprop" title="Not offered when building proposals">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M3 3l18 18" /></svg>
    Not in proposals
  </span>
);

export default function CatalogPage({ onBack }: Props) {
  const [tab, setTab] = useState<Tab>("products");
  const [products, setProducts] = useState<Product[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [roles, setRoles] = useState<ClientRole[]>([]);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [crmOpts, setCrmOpts] = useState<CrmOption[]>([]);
  /** A save that went through without something (a missing SQL upgrade). */
  const [notice, setNotice] = useState<string | null>(null);
  const kinds = productKindOptions(crmOpts);
  const reloadKinds = async () => setCrmOpts(await listCrmOptions().catch(() => []));

  const reload = async () => {
    reloadKinds();
    setProducts(await loadProducts().catch(() => []));
    setServices(await loadServices().catch(() => []));
    const bp = await loadBlueprintData().catch(() => null);
    if (bp) { setBlueprints(bp.blueprints); setRoles(bp.roles); }
  };
  useEffect(() => { reload(); }, []);

  const newProduct = (): Product => ({
    name: "", kind: kinds[0] ?? "SaaS", billing: "recurring", billing_period: "monthly", description: "", active: true,
    tiers: [{ name: "Standard", price: 0, sort: 0, durations: [] }],
    multi_year: false, default_years: 1, increment_mode: "none", increment_value: 0,
  });
  const newService = (): Service => ({
    name: "", rate_unit: "hour", min_unit: 0.5, description: "", active: true,
    roles: [],
  });

  return (
    <div className="cat">
      <header className="cat-head">
        <button className="cat-back" onClick={onBack} aria-label="Back">‹</button>
        <div>
          <h1 className="cat-title">Products &amp; Services</h1>
        </div>
        <div className="cat-tabs">
          <button className={tab === "products" ? "is-on" : ""} onClick={() => setTab("products")}>Products <i>{products.length}</i></button>
          <button className={tab === "services" ? "is-on" : ""} onClick={() => setTab("services")}>Services <i>{services.length}</i></button>
          <button className={tab === "blueprints" ? "is-on" : ""} onClick={() => setTab("blueprints")}>Blueprints</button>
        </div>
      </header>

      {notice && (
        <div className="pw-notice" role="status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {tab === "products" ? (
        <section className="cat-body">
          <div className="cat-list-head">
            <span className="cat-eyebrow">Your products</span>
            <button className="cat-add" onClick={() => setEditingProduct(newProduct())}>+ New product</button>
          </div>
          <div className="pw-grid">
            {products.map((p, i) => {
              const suffix = perSuffixOf(p);
              const prices = p.tiers.map((t) => Number(t.price) || 0);
              const from = prices.length ? Math.min(...prices) : 0;
              return (
                <button key={p.id} className="cat-prod-card pw-pcard" style={{ ["--kc" as any]: kindColor(p.kind), ["--i" as any]: i }} onClick={() => setEditingProduct(structuredClone(p))}>
                  <span className="pw-pcard-top">
                    <span className={`cat-prod-icon ${kindClass(p.kind)}`} style={{ ["--kc" as any]: kindColor(p.kind) }}>
                      <KindIcon kind={p.kind} />
                    </span>
                    <span className="pw-pcard-id">
                      <span className="cat-prod-name">{p.name || "Untitled product"}</span>
                      <span className="cat-svc-meta">
                        <span className="cat-pill is-kind" style={{ ["--kc" as any]: kindColor(p.kind) }}>{kindLabel(p.kind, kinds)}</span>
                        <span className="cat-svc-count">{p.billing === "recurring" ? (p.billing_period === "yearly" ? "Billed yearly" : "Billed monthly") : "One-time"}</span>
                        {p.active === false && <span className="cat-pill is-off">Inactive</span>}
                      </span>
                    </span>
                    <span className="pw-pcard-from"><small>From</small><b>{p.tiers.length ? <>{money(from)}<em>{suffix}</em></> : "—"}</b></span>
                  </span>
                  {p.tiers.length > 0 && (
                    <span className="pw-pcard-tiers">
                      {p.tiers.slice(0, 4).map((t, ti) => (
                        <span key={ti} className="pw-pcard-tier">
                          <i style={{ ["--w" as any]: `${from > 0 && Math.max(...prices) > 0 ? Math.max(18, ((Number(t.price) || 0) / Math.max(...prices)) * 100) : 40}%` }} />
                          <b>{t.name || `Tier ${ti + 1}`}</b><em>{money(Number(t.price) || 0)}{suffix}</em>
                        </span>
                      ))}
                      {p.tiers.length > 4 && <small>+{p.tiers.length - 4} more</small>}
                    </span>
                  )}
                  <span className="pw-pcard-foot">
                    {p.calculator ? <span className="cat-pill is-calc" title="Has a price calculator">Calculator · {p.calculator.variables.length} input{p.calculator.variables.length === 1 ? "" : "s"}</span> : <span className="cat-pill is-plain">Tier price</span>}
                    {p.multi_year && p.billing === "recurring" && <span className="cat-pill is-multi" title="Can be sold for several years">{p.default_years ?? 1} yr · {incrementLabel(p.increment_mode, p.increment_value)}</span>}
                    {p.in_proposals === false && <NotInProposals />}
                    <span className="pw-pcard-go">Edit<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>
                  </span>
                </button>
              );
            })}
            <button className="pw-newcard" onClick={() => setEditingProduct(newProduct())}>
              <span>+</span><b>New product</b><small>Tiers, contract length and an optional price calculator</small>
            </button>
          </div>
        </section>
      ) : tab === "services" ? (
        <section className="cat-body">
          <div className="cat-list-head">
            <span className="cat-eyebrow">Your services</span>
            <button className="cat-add" onClick={() => setEditingService(newService())}>+ New service</button>
          </div>
          <div className="pw-grid">
            {services.map((s, i) => {
              const u = s.rate_unit === "hour" ? "h" : "d";
              const main = s.roles.find((r) => r.is_main) ?? s.roles[0];
              return (
                <button key={s.id} className="cat-svc-card pw-pcard is-svc" style={{ ["--i" as any]: i }} onClick={() => setEditingService(structuredClone(s))}>
                  <span className="pw-pcard-top">
                    <span className="cat-svc-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="7" width="18" height="13" rx="2" />
                        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <path d="M3 12h18" />
                      </svg>
                    </span>
                    <span className="pw-pcard-id">
                      <span className="cat-svc-name">{s.name || "Untitled service"}</span>
                      <span className="cat-svc-meta">
                        <span className="cat-pill svc">per {s.rate_unit}</span>
                        <span className="cat-svc-min">min {s.min_unit ?? (s.rate_unit === "hour" ? 0.5 : 0.25)}{u}</span>
                      </span>
                    </span>
                    {main && <span className="pw-pcard-from"><small>Main rate</small><b>{money(Number(main.price) || 0)}<em>/{u}</em></b></span>}
                  </span>
                  <span className="pw-pcard-roles">
                    {s.roles.length === 0 ? <small>No roles priced yet</small> : s.roles.slice(0, 4).map((r, ri) => {
                      const at = roles.findIndex((x) => x.id === r.role_id);
                      return (
                        <span key={ri} className={`pw-pcard-role ${r.is_main ? "is-main" : ""}`} style={{ ["--c" as any]: roleColor(roles[at], Math.max(0, at)) }}>
                          <i />{roles[at]?.name || "Role"}<em>{money(Number(r.price) || 0)}/{u}</em>
                        </span>
                      );
                    })}
                    {s.roles.length > 4 && <small>+{s.roles.length - 4}</small>}
                  </span>
                  <span className="pw-pcard-foot">
                    {s.calculator ? <span className="cat-pill is-calc">Duration calculator · {s.calculator.variables.length}</span> : <span className="cat-pill is-plain">No calculator</span>}
                    {s.blueprint_id && <span className="cat-pill is-plain">Blueprint</span>}
                    {s.in_proposals === false && <NotInProposals />}
                    <span className="pw-pcard-go">Edit<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>
                  </span>
                </button>
              );
            })}
            <button className="pw-newcard" onClick={() => setEditingService(newService())}>
              <span>+</span><b>New service</b><small>Roles and rates, a phase blueprint and a duration calculator</small>
            </button>
          </div>
        </section>
      ) : (
        <BlueprintsTab onChanged={reload} />
      )}

      {editingProduct && (
        <ProductEditor
          product={editingProduct}
          kinds={kinds}
          kindOptions={crmOpts.filter((o) => o.kind === "product_kind")}
          onKindsChanged={reloadKinds}
          onClose={() => setEditingProduct(null)}
          onSaved={async (n) => { setEditingProduct(null); setNotice(n ?? null); await reload(); }}
          onDeleted={async () => { setEditingProduct(null); await reload(); }}
        />
      )}
      {editingService && (
        <ServiceEditor
          service={editingService}
          blueprints={blueprints}
          roles={roles}
          onClose={() => setEditingService(null)}
          onSaved={async (n) => { setEditingService(null); setNotice(n ?? null); await reload(); }}
          onDeleted={async () => { setEditingService(null); await reload(); }}
        />
      )}
    </div>
  );
}

// ============================ Product studio: a step-by-step editor ============================
/*
 * A product is set up in four steps — Basics, Pricing, Calculator, Review —
 * shown on a rail on the left. Any step can be opened at any time; Next/Back
 * walk through them. The Calculator step is a builder with a live preview of
 * how the calculator will look and price on a deal, with sample values you can
 * move. Saving is the same as before (saveProduct).
 */
// ============================ Studio helpers (product + service editors) ============================
/** The scroll box a studio field lives in. */
const SCROLL_BOX = ".pw-duo-main, .pw-body, .cp-body";

/**
 * When a field gets focus (click or Tab), glide it to the middle of its scroll
 * box so you always see what you're typing and what's around it. Only on
 * focus, never while typing, and not when it's already near the middle.
 */
function useCenterOnFocus(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
      if (t instanceof HTMLInputElement && ["range", "checkbox", "radio"].includes(t.type)) return;
      if (t.closest(".pw-guide")) return;
      const box = t.closest(SCROLL_BOX) as HTMLElement | null;
      if (!box || box.scrollHeight <= box.clientHeight + 4) return;
      const field = (t.closest(".pw-num, .pw-money, .cat-price-input, .pw-tier-name, .cb-f, .cat-field") as HTMLElement | null) ?? t;
      requestAnimationFrame(() => {
        const br = box.getBoundingClientRect();
        const fr = field.getBoundingClientRect();
        const off = fr.top + fr.height / 2 - (br.top + br.height / 2);
        if (Math.abs(off) < br.height * 0.16) return;
        box.scrollTo({ top: box.scrollTop + off, behavior: "smooth" });
      });
    };
    el.addEventListener("focusin", onFocus);
    return () => el.removeEventListener("focusin", onFocus);
  }, [root]);
}

/** Opens the "how this page works" guide, optionally at one zone. */
const GuideCtx = createContext<((sel?: string) => void) | null>(null);

const ZONE_ICON: Record<string, string> = {
  ident: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
  desc: "M4 6h16M4 11h16M4 16h10",
  vis: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  billing: "M3 7h18v12H3zM3 11h18M7 15h3",
  tiers: "M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5",
  term: "M4 5h16v15H4zM4 10h16M9 3v4M15 3v4M8 14h3M8 17h6",
  calc: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8.5 7h7M8.5 11h.01M12 11h.01M15.5 11h.01M8.5 15h.01M12 15h.01M15.5 15h.01M8.5 18h7",
  inputs: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4",
  check: "M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  summary: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  delivery: "M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10",
  roles: "M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8",
  service: "M3 7h18v13H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18",
};

/** Header of a coloured zone card: icon chip, title, helper line, actions, ⓘ. */
function ZoneHead({ z, title, sub, guide, children }: { z: string; title: string; sub?: React.ReactNode; guide?: string; children?: React.ReactNode }) {
  const open = useContext(GuideCtx);
  return (
    <div className="pw-zh">
      <span className="pw-zi" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={ZONE_ICON[z] ?? ZONE_ICON.summary} /></svg>
      </span>
      <span className="pw-zt"><b>{title}</b>{sub && <small>{sub}</small>}</span>
      {children && <span className="pw-za">{children}</span>}
      {guide && open && (
        <button type="button" className="pw-zinfo" onClick={() => open(guide)} title={`What can I do in ${title}?`} aria-label={`About ${title}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 11v6M12 7.5h.01" /></svg>
        </button>
      )}
    </div>
  );
}

/** A number box with − / + on the sides; the value sits in the middle. */
function NumStep({ value, onChange, step = 1, min = 0, max, unit, prefix, size, label }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number;
  unit?: string; prefix?: string; size?: "sm" | "lg"; label?: string;
}) {
  const fix = (v: number) => {
    let n = Math.round((Number(v) || 0) * 100) / 100;
    if (n < min) n = min;
    if (max != null && n > max) n = max;
    return n;
  };
  return (
    <div className={`pw-num ${size ? `is-${size}` : ""}`}>
      <button type="button" tabIndex={-1} onClick={() => onChange(fix(value - step))} disabled={value <= min} aria-label={`Less${label ? ` ${label}` : ""}`}>−</button>
      <span className="pw-num-val">
        {prefix && <span className="pw-num-pre">{prefix}</span>}
        <input type="number" className="cat-nospin" value={value} step={step} min={min} max={max} aria-label={label}
          onFocus={(e) => e.target.select()} onChange={(e) => onChange(fix(Number(e.target.value)))} />
        {unit && <em>{unit}</em>}
      </span>
      <button type="button" tabIndex={-1} onClick={() => onChange(fix(value + step))} disabled={max != null && value >= max} aria-label={`More${label ? ` ${label}` : ""}`}>+</button>
    </div>
  );
}

/** The ⓘ "How it works" button in a studio header. */
function GuideButton({ onClick, nudge }: { onClick: () => void; nudge?: boolean }) {
  return (
    <button type="button" className={`pw-info ${nudge ? "is-nudge" : ""}`} onClick={onClick} title="What can I do on this page?">
      <span className="pw-info-i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 11v6M12 7.5h.01" /></svg></span>
      <span className="pw-info-t">How it works</span>
    </button>
  );
}

type GuideStop = { sel: string; t: string; d: string };

const PRODUCT_GUIDE: Record<string, GuideStop[]> = {
  basics: [
    { sel: '[data-g="b-ident"]', t: "Name and kind", d: "The name is what sales see on deals and proposals. The kind groups it in your catalog; kinds are your own list and you can add or rename them right here." },
    { sel: '[data-g="b-desc"]', t: "Description", d: "Optional. A short line on what's included and who it's for. Sales see it when they add the product to a deal." },
    { sel: '[data-g="b-vis"]', t: "Where it shows up", d: "Active keeps it in the product picker for new deals (existing deals are never touched). “Available in proposals” decides if it can go into a proposal." },
    { sel: '[data-g="b-prev"]', t: "Catalog preview", d: "This is how the product looks in your catalog. It updates as you type." },
    { sel: ".pw-rail", t: "Steps", d: "Jump between steps whenever you like. A green tick means a step is complete, amber means something needs a look. Ctrl + Enter saves from any step." },
  ],
  pricing: [
    { sel: '[data-g="p-billing"]', t: "Billing", d: "Recurring is a licence or subscription billed every month or year. One-time is paid once, like a set-up fee or hardware." },
    { sel: '[data-g="p-tiers"]', t: "Tiers", d: "Each tier is an edition with its own price. Name it, set the price and reorder with the arrows; the first tier is the one used as the example." },
    { sel: ".pw-tier .pw-durs", t: "Commitment discounts", d: "Give a lower price for longer contracts: pick the length and the % off. The final price and the saving are worked out for you." },
    { sel: '[data-g="p-term"]', t: "Contract length", d: "Turn on “Sold for several years” if deals can sign for more than a year. Set the usual length and how the price rises each year, as a % or a fixed amount. The bars show the price year by year." },
    { sel: ".cp", t: "Live preview", d: "Prices the product exactly like a deal will. Click a tier or a commitment and move the values to try it. Nothing here is saved." },
  ],
  calc: [
    { sel: '[data-g="c-start"]', t: "Starting point", d: "A calculator is optional: use it when the price depends on users, entities or extras. Choose whether the inputs add to the tier price or build the whole price on their own." },
    { sel: '[data-g="c-inputs"]', t: "Inputs", d: "Each input is one thing sales fill in on a deal. Open a card to set its name, unit and how it's priced: per unit, per block, a fixed extra or a % of the base. The sentence underneath says exactly what it does." },
    { sel: '[data-g="c-add"]', t: "Add inputs", d: "Add another input of any kind. Each card's toolbar lets you reorder, duplicate or remove it." },
    { sel: ".cp", t: "Try it", d: "Hover an input to light up its line in the breakdown, and move the sliders to test real cases before you save." },
  ],
  review: [
    { sel: '[data-g="r-check"]', t: "Before you save", d: "Anything missing is listed here. Click a line to jump straight to the step that fixes it." },
    { sel: '[data-g="r-cards"]', t: "Summary", d: "One card per step. Click a card to go back and change it." },
    { sel: ".pw-rv.is-total", t: "The price", d: "What it costs with the calculator's starting values, plus the first year and the whole contract when it's sold for several years." },
    { sel: ".pw-foot", t: "Save", d: "Create or save the product here. Delete removes it for good; you'll be asked first." },
  ],
};

const SERVICE_GUIDE: GuideStop[] = [
  { sel: '[data-g="s-ident"]', t: "The service", d: "Name it and choose if it's billed per hour or per day, plus the smallest amount that can be booked." },
  { sel: '[data-g="s-delivery"]', t: "Delivery", d: "Pick a phase blueprint to give every project of this service the same phases and tasks." },
  { sel: '[data-g="s-roles"]', t: "Roles and rates", d: "Set a rate for each role that works on the service. The star marks the main role, used when a project doesn't say otherwise." },
  { sel: '[data-g="s-calc"]', t: "Duration calculator", d: "Questions that work out how long a project takes, e.g. days per entity. Sales answer them when they scope a deal." },
  { sel: ".cp", t: "Live estimate", d: "Move the answers to see the days and the fee per role, and the total. Nothing here is saved." },
  { sel: ".cat-prop-sw", t: "Proposals", d: "Switch off if this service should never be offered in a proposal." },
];

/**
 * An animated walkthrough: dims the studio, lights up one zone at a time and
 * explains it. Next / Back / dots, arrow keys, Esc closes.
 */
function StudioGuide({ root, stops, start, onClose }: { root: React.RefObject<HTMLElement | null>; stops: GuideStop[]; start: string; onClose: () => void }) {
  const [list] = useState(() => stops.filter((s) => root.current?.querySelector(s.sel)));
  const [i, setI] = useState(() => Math.max(0, list.findIndex((s) => s.sel === start)));
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const card = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(200);
  const stop = list[i];
  const last = list.length - 1;
  const targetOf = (s?: GuideStop) => (s ? (root.current?.querySelector(s.sel) as HTMLElement | null) : null);

  // bring the zone into view
  useEffect(() => {
    const t = targetOf(stop);
    const sc = t?.parentElement?.closest(SCROLL_BOX) as HTMLElement | null;
    if (!t || !sc || sc.scrollHeight <= sc.clientHeight + 4) return;
    const br = sc.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const off = tr.height > br.height - 60 ? tr.top - br.top - 18 : tr.top + tr.height / 2 - (br.top + br.height / 2);
    if (Math.abs(off) > 8) sc.scrollTo({ top: sc.scrollTop + off, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // follow the zone while things scroll or resize
  useEffect(() => {
    let raf = 0;
    let prev = "";
    const tick = () => {
      const r = root.current;
      const t = targetOf(stop);
      if (r && t) {
        const rr = r.getBoundingClientRect();
        const tr = t.getBoundingClientRect();
        let top = tr.top, bottom = tr.bottom;
        const sc = t.parentElement?.closest(SCROLL_BOX) as HTMLElement | null;
        if (sc) { const b = sc.getBoundingClientRect(); top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
        const pad = 8;
        const next = { x: tr.left - rr.left - pad, y: top - rr.top - pad, w: tr.width + pad * 2, h: Math.max(24, bottom - top) + pad * 2 };
        const key = [next.x, next.y, next.w, next.h, rr.width, rr.height].map(Math.round).join(",");
        if (key !== prev) { prev = key; setBox(next); setFrame({ w: rr.width, h: rr.height }); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  useLayoutEffect(() => { if (card.current) setCardH(card.current.offsetHeight); }, [i, box?.w]);

  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); setI((x) => { if (x >= last) { closeRef.current(); return x; } return x + 1; }); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [last]);

  if (!stop) return null;
  // where the card goes: right of the zone, else left, else below / above
  const W = Math.max(260, Math.min(340, frame.w - 32)), M = 16, G = 18;
  let pos = { x: M, y: M };
  if (box) {
    const clampY = (y: number) => Math.min(Math.max(M, y), Math.max(M, frame.h - cardH - M));
    if (box.x + box.w + G + W + M <= frame.w) pos = { x: box.x + box.w + G, y: clampY(box.y) };
    else if (box.x - G - W >= M) pos = { x: box.x - G - W, y: clampY(box.y) };
    else if (box.y + box.h + G + cardH + M <= frame.h) pos = { x: Math.min(Math.max(M, box.x + 24), frame.w - W - M), y: box.y + box.h + G };
    else if (box.y - G - cardH >= M) pos = { x: Math.min(Math.max(M, box.x + 24), frame.w - W - M), y: box.y - G - cardH };
    else pos = { x: Math.max(M, frame.w - W - M * 2), y: Math.max(M, frame.h - cardH - M * 2) };
  }
  const side = box ? (pos.x >= box.x + box.w ? "is-right" : pos.x + W <= box.x ? "is-left" : pos.y >= box.y + box.h ? "is-below" : "is-above") : "";

  return (
    <div className="pw-guide" role="dialog" aria-label="How this page works" onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
      {box && <div className="pw-guide-spot" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
      <div ref={card} key={i} className={`pw-guide-card ${side}`} style={{ left: pos.x, top: pos.y, width: W }}>
        <span className="pw-guide-k"><i>{i + 1}</i> of {list.length}</span>
        <b>{stop.t}</b>
        <p>{stop.d}</p>
        <div className="pw-guide-foot">
          <span className="pw-guide-dots">
            {list.map((s, j) => <button key={s.sel} type="button" className={j === i ? "is-on" : j < i ? "is-past" : ""} onClick={() => setI(j)} aria-label={`Go to ${s.t}`} />)}
          </span>
          {i > 0 && <button type="button" className="pw-guide-btn" onClick={() => setI(i - 1)}>Back</button>}
          <button type="button" className="pw-guide-btn is-next" onClick={() => (i >= last ? onClose() : setI(i + 1))}>{i >= last ? "Done" : "Next"}</button>
        </div>
        <button type="button" className="pw-guide-x" onClick={onClose} aria-label="Close the guide">×</button>
      </div>
    </div>
  );
}

const STEPS = [
  { k: "basics", t: "Basics", s: "Name, kind and description" },
  { k: "pricing", t: "Pricing", s: "Billing, tiers and contract" },
  { k: "calc", t: "Calculator", s: "Build the price, see it live" },
  { k: "review", t: "Review", s: "Check everything and save" },
] as const;

const StepIcon = ({ k }: { k: (typeof STEPS)[number]["k"] }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {k === "basics" ? <><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.5" /></>
      : k === "pricing" ? <><path d="M12 2v20" /><path d="M17 6.5c0-1.9-2.2-3.5-5-3.5S7 4.6 7 6.5 9.2 10 12 10s5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5" /></>
      : k === "calc" ? <><rect x="5" y="2.5" width="14" height="19" rx="2.5" /><path d="M8.5 6.5h7M8.5 11h.01M12 11h.01M15.5 11h.01M8.5 14.5h.01M12 14.5h.01M15.5 14.5h.01M8.5 18h.01M12 18h3.5" /></>
      : <><path d="M9 12l2 2 4-4" /><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" /></>}
  </svg>
);

const periodWord = (p: Product) => (p.billing === "recurring" ? (p.billing_period === "yearly" ? "year" : "month") : "");
const perSuffixOf = (p: Product) => (p.billing === "recurring" ? (p.billing_period === "yearly" ? "/yr" : "/mo") : "");
/** What the product brings in the first year, from one period's price. */
const firstYearOf = (p: Product, perPeriod: number) => (p.billing === "recurring" && p.billing_period !== "yearly" ? perPeriod * 12 : perPeriod);

function ProductEditor({ product, kinds, kindOptions, onKindsChanged, onClose, onSaved, onDeleted }: {
  product: Product; kinds: string[]; kindOptions: CrmOption[]; onKindsChanged: () => void;
  onClose: () => void; onSaved: (notice?: string) => void; onDeleted: () => void;
}) {
  const start = useRef<Product>({ multi_year: false, default_years: 1, increment_mode: "none", increment_value: 0, ...product });
  const [p, setP] = useState<Product>(start.current);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [visited, setVisited] = useState<Set<number>>(() => new Set(product.id ? [0, 1, 2, 3] : [0]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [askDel, setAskDel] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const set = (patch: Partial<Product>) => { setP((x) => ({ ...x, ...patch })); setErr(null); };
  const dirty = JSON.stringify(p) !== JSON.stringify(start.current);
  const isNew = !p.id;

  const tiersOk = p.tiers.length > 0 && p.tiers.every((t) => t.name.trim());
  const varsOk = !p.calculator || p.calculator.variables.every((v) => v.name.trim());
  const stepOk = [!!p.name.trim(), tiersOk, varsOk, !!p.name.trim() && tiersOk && varsOk];
  const go = (i: number) => {
    if (i === step || i < 0 || i >= STEPS.length) return;
    setDir(i > step ? 1 : -1); setStep(i); setErr(null);
    setVisited((v) => new Set(v).add(i));
  };
  const next = () => {
    if (step === 0 && !p.name.trim()) { setErr("Give the product a name to continue."); return; }
    go(step + 1);
  };

  const requestClose = () => { if (dirty && !busy) setAskClose(true); else onClose(); };
  const save = async () => {
    if (!p.name.trim()) { go(0); setErr("Give the product a name."); return; }
    if (!tiersOk) { go(1); setErr("Every tier needs a name."); return; }
    if (!varsOk) { go(2); setErr("Every calculator input needs a name."); return; }
    setBusy(true); setErr(null);
    const e = await saveProduct(p);
    setBusy(false);
    if (e && !/^Saved, but/.test(e)) setErr(e); else onSaved(e ?? undefined);
  };
  const remove = async () => {
    if (!p.id) return onClose();
    setBusy(true);
    await deleteProduct(p.id);
    setBusy(false);
    onDeleted();
  };

  const saveRef = useRef(save); saveRef.current = save;
  const closeRef = useRef(requestClose); closeRef.current = requestClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".pw-guide")) return;
      if (e.key === "Escape" && !document.querySelector(".cat-kind-pop, .sel-pop, .dp-pop")) { e.preventDefault(); closeRef.current(); }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [step]);
  const k = STEPS[step].k;
  const rootRef = useRef<HTMLDivElement>(null);
  useCenterOnFocus(rootRef);
  const [guide, setGuide] = useState<string | null>(null);
  useEffect(() => { setGuide(null); }, [step]);
  // Rendered on <body>: the page around it can be transformed or scrolled, which
  // would move a fixed backdrop and clip the studio.
  return createPortal(
    <div className="cat-backdrop pw-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <GuideCtx.Provider value={(sel) => setGuide(sel ?? "")}>
      <div ref={rootRef} className="pw" role="dialog" aria-modal="true" aria-label={isNew ? "New product" : `Edit ${p.name}`}>
        <aside className="pw-rail">
          <div className="pw-rail-head">
            <span className={`cat-prod-icon ${kindClass(p.kind)}`} style={{ ["--kc" as any]: kindColor(p.kind) }}><KindIcon kind={p.kind} /></span>
            <span className="pw-rail-id">
              <span className="cat-modal-eyebrow">{isNew ? "New product" : "Edit product"}</span>
              <b>{p.name.trim() || "Untitled product"}</b>
            </span>
          </div>
          <ol className="pw-steps" style={{ ["--at" as any]: step }}>
            {STEPS.map((s, i) => {
              const state = i === step ? "is-on" : visited.has(i) && stepOk[i] ? "is-done" : visited.has(i) && !stepOk[i] ? "is-warn" : "";
              return (
                <li key={s.k}>
                  <button type="button" className={`pw-step ${state}`} onClick={() => go(i)} aria-current={i === step ? "step" : undefined}>
                    <span className="pw-step-dot">
                      {state === "is-done" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg> : <StepIcon k={s.k} />}
                    </span>
                    <span className="pw-step-txt"><b>{i + 1}. {s.t}</b><small>{s.s}</small></span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="pw-rail-foot">
            <div className="pw-rail-sum">
              <span>From</span>
              <b>{money(Math.min(...(p.tiers.length ? p.tiers.map((t) => Number(t.price) || 0) : [0])))}{perSuffixOf(p)}</b>
              <small>
                {p.tiers.length} tier{p.tiers.length === 1 ? "" : "s"}
                {p.calculator ? ` · calculator (${p.calculator.variables.length})` : ""}
                {p.multi_year && p.billing === "recurring" ? ` · ${p.default_years ?? 1} yr, ${incrementLabel(p.increment_mode, p.increment_value).toLowerCase()}` : ""}
                {p.in_proposals === false ? " · not in proposals" : ""}
              </small>
            </div>
            <p className="pw-rail-hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> saves from any step.</p>
          </div>
        </aside>

        <section className="pw-main">
          <header className="pw-head">
            <div className="pw-head-id">
              <span className="pw-head-step">Step {step + 1} of {STEPS.length}</span>
              <h2 className="pw-head-title">{STEPS[step].t}<small>{STEPS[step].s}</small></h2>
            </div>
            <div className="pw-progress" aria-hidden="true"><i style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
            <GuideButton onClick={() => setGuide("")} nudge={isNew && step === 0} />
            <button className="cat-x" onClick={requestClose} aria-label="Close">×</button>
          </header>

          <div ref={bodyRef} className={`pw-body ${k === "calc" || k === "pricing" ? "is-duo" : ""}`}>
            <div key={step} className={`pw-pane ${dir > 0 ? "from-right" : "from-left"}`}>
              {k === "basics" && <BasicsStep p={p} set={set} kinds={kinds} kindOptions={kindOptions} onKindsChanged={onKindsChanged} nameError={!!err && !p.name.trim()} />}
              {k === "pricing" && <PricingStep p={p} setP={setP} set={set} />}
              {k === "calc" && <CalcStep p={p} set={set} />}
              {k === "review" && <ReviewStep p={p} kinds={kinds} go={go} />}
            </div>
          </div>

          {err && <p className="cat-error pw-err">{err}</p>}
          <footer className="pw-foot">
            {p.id && (askDel ? (
              <span className="pw-ask">
                Delete “{p.name}” for good?
                <button type="button" onClick={() => setAskDel(false)}>Keep</button>
                <button type="button" className="is-danger" onClick={() => void remove()} disabled={busy}>Delete</button>
              </span>
            ) : <button className="cat-delete" onClick={() => setAskDel(true)}>Delete</button>)}
            <div className="cat-foot-right">
              {step > 0 && <button className="cat-cancel pw-back" onClick={() => go(step - 1)}>‹ Back</button>}
              {!isNew && step < STEPS.length - 1 && <button className="cat-cancel" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</button>}
              {step < STEPS.length - 1
                ? <button className="cat-save pw-next" onClick={next}>Next: {STEPS[step + 1].t} ›</button>
                : <button className="cat-save pw-next" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : isNew ? "Create product" : "Save product"}</button>}
            </div>
          </footer>
        </section>

        {askClose && (
          <div className="pw-confirm" onMouseDown={(e) => e.stopPropagation()}>
            <div className="pw-confirm-card">
              <b>Discard your changes?</b>
              <p>{isNew ? "This product hasn't been created yet." : "The changes you made to this product aren't saved."}</p>
              <div>
                <button type="button" className="cat-cancel" onClick={() => setAskClose(false)}>Keep editing</button>
                <button type="button" className="cat-delete" onClick={onClose}>Discard</button>
              </div>
            </div>
          </div>
        )}
        {guide !== null && <StudioGuide key={`${k}-${guide}`} root={rootRef} stops={PRODUCT_GUIDE[k]} start={guide} onClose={() => setGuide(null)} />}
      </div>
      </GuideCtx.Provider>
    </div>,
    document.body,
  );
}

// ---------- Step 1 · Basics ----------
function BasicsStep({ p, set, kinds, kindOptions, onKindsChanged, nameError }: {
  p: Product; set: (patch: Partial<Product>) => void; kinds: string[]; kindOptions: CrmOption[]; onKindsChanged: () => void; nameError?: boolean;
}) {
  return (
    <div className="pw-split">
      <div className="pw-col pw-zones">
        <section className="pw-card pw-zone z-ident" data-g="b-ident">
          <ZoneHead z="ident" title="Name and kind" sub="What sales see on deals and proposals" guide='[data-g="b-ident"]' />
          <div className="pw-zb">
            <div className="cat-field">
              <label>Product name</label>
              <input className={`pw-bigname ${nameError ? "is-invalid" : ""}`} value={p.name} autoFocus={!p.id} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Analytics Suite" />
            </div>
            <div className="cat-field">
              <label>Kind</label>
              <KindPicker value={p.kind} kinds={kinds} options={kindOptions} onChange={(k) => set({ kind: k })} onKindsChanged={onKindsChanged} />
            </div>
          </div>
        </section>
        <section className="pw-card pw-zone z-desc" data-g="b-desc">
          <ZoneHead z="desc" title="Description" sub="Optional · shown to sales when they pick it" guide='[data-g="b-desc"]' />
          <div className="pw-zb">
            <textarea className="pw-area" rows={4} value={p.description ?? ""} onChange={(e) => set({ description: e.target.value })}
              placeholder="What it is, who it's for, what's included…" aria-label="Description" />
          </div>
        </section>
        <section className="pw-card pw-zone z-vis" data-g="b-vis">
          <ZoneHead z="vis" title="Where it shows up" sub="New deals and proposals" guide='[data-g="b-vis"]' />
          <div className="pw-zb">
            <div className="pw-toggles">
              <button type="button" role="switch" aria-checked={p.active !== false} className={`pw-toggle ${p.active !== false ? "is-on" : ""}`} onClick={() => set({ active: p.active === false })}>
                <i /><span><b>Active</b><small>{p.active !== false ? "Can be added to new deals" : "Hidden from new deals; existing deals keep it"}</small></span>
              </button>
              <button type="button" role="switch" aria-checked={p.in_proposals !== false} className={`pw-toggle ${p.in_proposals !== false ? "is-on" : ""}`} onClick={() => set({ in_proposals: p.in_proposals === false })}>
                <i /><span><b>Available in proposals</b><small>{p.in_proposals !== false ? "Sales can put it in a proposal" : "Left out when building proposals"}</small></span>
              </button>
            </div>
          </div>
        </section>
      </div>
      <div className="pw-col pw-aside" data-g="b-prev">
        <span className="pw-aside-k">How it shows in your catalog</span>
        <div className="cat-prod-card pw-tile">
          <span className={`cat-prod-icon ${kindClass(p.kind)}`} style={{ ["--kc" as any]: kindColor(p.kind) }}><KindIcon kind={p.kind} /></span>
          <span className="cat-prod-info">
            <span className="cat-prod-name">{p.name.trim() || "Untitled product"}</span>
            <span className="cat-svc-meta">
              <span className="cat-pill is-kind" style={{ ["--kc" as any]: kindColor(p.kind) }}>{kindLabel(p.kind, kinds)}</span>
              {p.in_proposals === false && <NotInProposals />}
              <span className="cat-svc-count">{p.billing === "recurring" ? (p.billing_period === "yearly" ? "Yearly" : "Monthly") : "One-time"} · {p.tiers.length} tier{p.tiers.length !== 1 ? "s" : ""}</span>
            </span>
          </span>
        </div>
        <p className="pw-aside-desc">{p.description?.trim() || "No description yet."}</p>
        <ol className="pw-roadmap">
          <li><i className="z-billing" /><span>Next you set how it's <b>billed</b> and its <b>tiers</b>.</span></li>
          <li><i className="z-calc" /><span>If the price depends on users, entities or extras, build a <b>calculator</b>.</span></li>
          <li><i className="z-check" /><span>Last, <b>review</b> and save.</span></li>
        </ol>
      </div>
    </div>
  );
}

// ---------- Step 2 · Pricing ----------
function PricingStep({ p, setP, set }: { p: Product; setP: (f: (x: Product) => Product) => void; set: (patch: Partial<Product>) => void }) {
  const perSuffix = perSuffixOf(p);
  const setTier = (i: number, patch: Partial<ProductTier>) =>
    setP((x) => ({ ...x, tiers: x.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const addTier = () => setP((x) => ({ ...x, tiers: [...x.tiers, { name: "", price: 0, sort: x.tiers.length, durations: [] }] }));
  const removeTier = (i: number) => setP((x) => ({ ...x, tiers: x.tiers.filter((_, j) => j !== i) }));
  const moveTier = (i: number, d: number) => setP((x) => {
    const j = i + d; if (j < 0 || j >= x.tiers.length) return x;
    const t = [...x.tiers]; [t[i], t[j]] = [t[j], t[i]]; return { ...x, tiers: t };
  });
  const addDuration = (ti: number) =>
    setTier(ti, { durations: [...p.tiers[ti].durations, { months: 12 * (p.tiers[ti].durations.length + 1), discount_pct: 0, sort: p.tiers[ti].durations.length }] });
  const setDuration = (ti: number, di: number, patch: Partial<TierDuration>) =>
    setTier(ti, { durations: p.tiers[ti].durations.map((d, j) => (j === di ? { ...d, ...patch } : d)) });
  const removeDuration = (ti: number, di: number) =>
    setTier(ti, { durations: p.tiers[ti].durations.filter((_, j) => j !== di) });
  const first = p.tiers[0]?.price ?? 0;
  const schedule = yearlySchedule(firstYearOf(p, first), p.multi_year ? p.default_years ?? 1 : 1, p.increment_mode, p.increment_value);

  const maxPrice = Math.max(1, ...p.tiers.map((t) => Number(t.price) || 0));
  const recurring = p.billing === "recurring";

  return (
    <div className="pw-duo">
    <div className="pw-duo-main">
      <section className="pw-card pw-zone z-billing" data-g="p-billing">
        <ZoneHead z="billing" title="Billing" sub="How the client pays for it" guide='[data-g="p-billing"]' />
        <div className="pw-zb">
          <div className="pw-choice">
            {([
              { v: "recurring", t: "Recurring", s: "A licence or subscription, billed every period", ico: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" },
              { v: "one_time", t: "One-time", s: "Paid once, e.g. a set-up fee or hardware", ico: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v8M8 12h8" },
            ] as const).map((o) => (
              <button key={o.v} type="button" className={`pw-choice-btn ${p.billing === o.v ? "is-on" : ""}`}
                onClick={() => set(o.v === "one_time" ? { billing: "one_time", multi_year: false } : { billing: "recurring" })}>
                <i /><span className="pw-choice-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={o.ico} /></svg></span>
                <b>{o.t}</b><small>{o.s}</small>
              </button>
            ))}
          </div>
          <div className={`pw-reveal ${recurring ? "is-on" : ""}`}>
            <div className="pw-reveal-in">
              <div className="pw-inline-f">
                <span className="pw-lbl">Billed every</span>
                <div className="cat-seg pw-seg">
                  <button className={(p.billing_period ?? "monthly") === "monthly" ? "on" : ""} onClick={() => set({ billing_period: "monthly" })}>Month</button>
                  <button className={p.billing_period === "yearly" ? "on" : ""} onClick={() => set({ billing_period: "yearly" })}>Year</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="pw-card pw-zone z-tiers" data-g="p-tiers">
        <ZoneHead z="tiers" title="Tiers" sub={`Editions or plans, each with its own price${recurring ? ` per ${periodWord(p)}` : ""}`} guide='[data-g="p-tiers"]'>
          <button className="pw-zbtn" onClick={addTier}>+ Add tier</button>
        </ZoneHead>
        <div className="pw-zb">
          <div className="pw-tiers">
            {p.tiers.map((t, ti) => (
              <div key={ti} className={`pw-tier ${!t.name.trim() ? "is-unnamed" : ""}`} style={{ ["--i" as any]: ti, ["--tc" as any]: TIER_HUES[ti % TIER_HUES.length] }}>
                <div className="pw-tier-top">
                  <span className="pw-tier-n">{ti + 1}</span>
                  <label className="pw-tier-name">
                    <small>Tier name</small>
                    <input value={t.name} onChange={(e) => setTier(ti, { name: e.target.value })} placeholder="e.g. Professional" />
                  </label>
                  <label className="pw-tier-price">
                    <small>Price{recurring ? ` per ${periodWord(p)}` : ""}</small>
                    <span className="pw-money is-lg">
                      <span>€</span>
                      <input type="number" min="0" className="cat-nospin" value={t.price} onFocus={(e) => e.target.select()} onChange={(e) => setTier(ti, { price: Number(e.target.value) || 0 })} />
                      {perSuffix && <em>{perSuffix}</em>}
                    </span>
                  </label>
                  <span className="pw-tier-tools">
                    <button type="button" disabled={ti === 0} onClick={() => moveTier(ti, -1)} aria-label="Move up" title="Move up">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
                    </button>
                    <button type="button" disabled={ti === p.tiers.length - 1} onClick={() => moveTier(ti, 1)} aria-label="Move down" title="Move down">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
                    </button>
                    {p.tiers.length > 1 && (
                      <button type="button" className="is-del" onClick={() => removeTier(ti)} aria-label="Remove tier" title="Remove tier">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
                      </button>
                    )}
                  </span>
                </div>
                <div className="pw-tier-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, ((Number(t.price) || 0) / maxPrice) * 100)}%` }} /></div>
                {recurring && (
                  <div className="pw-durs">
                    <div className="pw-durs-head">
                      <span className="pw-durs-k">Commitment discounts</span>
                      <small>Lower price for longer contracts</small>
                      <button type="button" className="pw-dur-add" onClick={() => addDuration(ti)}>+ Add</button>
                    </div>
                    {t.durations.length === 0 ? (
                      <p className="pw-durs-none">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2" /></svg>
                        Same price whatever the length of the contract.
                      </p>
                    ) : (
                      <div className="pw-dtab">
                        <div className="pw-dtab-h"><span>Commitment</span><span>Discount</span><span>Final price</span><span /></div>
                        {t.durations.map((d, di) => {
                          const final = t.price * (1 - d.discount_pct / 100);
                          return (
                            <div key={di} className="pw-dtab-r">
                              <NumStep size="sm" value={d.months} min={1} max={120} step={6} unit="months" label="months" onChange={(v) => setDuration(ti, di, { months: v || 1 })} />
                              <NumStep size="sm" value={d.discount_pct} min={0} max={100} step={1} unit="% off" label="discount" onChange={(v) => setDuration(ti, di, { discount_pct: v })} />
                              <span className="pw-dprice"><b>{money(final)}{perSuffix}</b>{d.discount_pct > 0 && <small>saves {money(t.price - final)}{perSuffix}</small>}</span>
                              <button type="button" className="pw-dtab-x" onClick={() => removeDuration(ti, di)} aria-label="Remove discount" title="Remove">×</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            <button type="button" className="pw-tier-new" onClick={addTier}><span>+</span>Add another tier</button>
          </div>
        </div>
      </section>

      <section className={`pw-card pw-zone z-term ${!recurring ? "is-muted" : ""}`} data-g="p-term">
        <ZoneHead z="term" title="Contract length" sub={recurring ? "Can it be sold for several years, and does the price go up each year?" : "Only for recurring products"} guide='[data-g="p-term"]' />
        <div className="pw-zb">
          <button type="button" role="switch" aria-checked={!!p.multi_year} disabled={!recurring}
            className={`pw-toggle is-wide ${p.multi_year ? "is-on" : ""}`} onClick={() => set({ multi_year: !p.multi_year, default_years: Math.max(p.default_years ?? 1, p.multi_year ? 1 : 3) })}>
            <i /><span><b>Sold for several years</b><small>{p.multi_year ? "Deals pick how many years; each year can go up" : "One year at a time"}</small></span>
          </button>
          <div className={`pw-reveal ${p.multi_year && recurring ? "is-on" : ""}`}>
            <div className="pw-reveal-in">
              <div className="pw-term">
                <div className="pw-term-f">
                  <span className="pw-lbl">Usual length</span>
                  <NumStep value={p.default_years ?? 1} min={1} max={10} unit={(p.default_years ?? 1) === 1 ? "year" : "years"} label="years" onChange={(v) => set({ default_years: v || 1 })} />
                </div>
                <div className="pw-term-f">
                  <span className="pw-lbl">Annual increase</span>
                  <div className="cat-seg pw-seg pw-incseg">
                    <button className={(p.increment_mode ?? "none") === "none" ? "on" : ""} onClick={() => set({ increment_mode: "none" })}>None</button>
                    <button className={p.increment_mode === "percent" ? "on" : ""} onClick={() => set({ increment_mode: "percent", increment_value: p.increment_mode === "percent" ? p.increment_value : 3 })}>Percent</button>
                    <button className={p.increment_mode === "amount" ? "on" : ""} onClick={() => set({ increment_mode: "amount", increment_value: p.increment_mode === "amount" ? p.increment_value : 500 })}>Amount</button>
                  </div>
                </div>
                <div className={`pw-term-f ${(p.increment_mode ?? "none") === "none" ? "is-off" : ""}`}>
                  <span className="pw-lbl">{p.increment_mode === "amount" ? "Added each year" : "Each year, on the year before"}</span>
                  <NumStep value={p.increment_value ?? 0} min={0} step={p.increment_mode === "amount" ? 50 : 0.5}
                    prefix={p.increment_mode === "amount" ? "€" : undefined} unit={p.increment_mode === "amount" ? "/ year" : "% / year"} label="increase"
                    onChange={(v) => set({ increment_value: v })} />
                </div>
              </div>
              <div className="pw-years">
                {schedule.map((v, i) => {
                  const max = Math.max(...schedule, 1), min = Math.min(...schedule);
                  const h = max === min ? 70 : 45 + ((v - min) / (max - min)) * 55;
                  return (
                    <span key={i} className="pw-year" style={{ ["--h" as any]: `${h}%`, ["--i" as any]: i }}>
                      <b>{money(Math.round(v))}</b><i /><small>Year {i + 1}</small>
                    </span>
                  );
                })}
              </div>
              <p className="cat-hint">With the first tier ({p.tiers[0]?.name || "unnamed"}) as an example. Deals can change the years and the increase.</p>
            </div>
          </div>
        </div>
      </section>
    </div>
    <CalcPreview p={p} hover={null} onHover={() => {}} />
    </div>
  );
}

const TIER_HUES = ["#12b57f", "#3b6fe0", "#7c5cd6", "#e0861e", "#d0628f", "#0e9f8a"];

// ---------- Step 3 · Calculator: builder + live preview ----------
const VAR_KIND: { value: CalcVarType; label: string; hint: string; icon: string }[] = [
  { value: "per_unit", label: "Per unit", hint: "A price for every unit above what's included", icon: "M4 12h16M12 4v16" },
  { value: "per_block", label: "Per block", hint: "A price for every block of units, e.g. every 5 entities", icon: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" },
  { value: "fixed", label: "Extra", hint: "A fixed amount added when it's switched on", icon: "M12 5v14M5 12h14" },
  { value: "percent", label: "% of base", hint: "A percentage of the base price", icon: "M19 5L5 19M7 7h.01M17 17h.01" },
];
const PRESETS: { k: string; t: string; s: string; icon: string; make: () => Calculator }[] = [
  { k: "users", t: "Per user", icon: "M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8", s: "Base price + each user above the ones included", make: () => ({ ...emptyCalculator("product"), variables: [{ ...emptyCalcVariable(0), name: "Users", unit_label: "users", var_type: "per_unit", amount: 15, included: 5, default_value: 10 }] }) },
  { k: "entities", t: "Per entity block", icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", s: "Base price + every block of entities", make: () => ({ ...emptyCalculator("product"), variables: [{ ...emptyCalcVariable(0), name: "Entities", unit_label: "entities", var_type: "per_block", amount: 450, block_size: 5, included: 5, default_value: 12 }] }) },
  { k: "addons", t: "Base + extras", icon: "M12 2l3 6 6 .9-4.5 4.3 1 6.3L12 16.6 6.5 19.5l1-6.3L3 8.9 9 8z", s: "Base price + optional add-ons sales can switch on", make: () => ({ ...emptyCalculator("product"), variables: [{ ...emptyCalcVariable(0), name: "Premium support", var_type: "fixed", amount: 1200, default_value: 0 }, { ...emptyCalcVariable(1), name: "Extra environment", var_type: "fixed", amount: 800, default_value: 0 }] }) },
  { k: "blank", t: "Start blank", icon: "M12 5v14M5 12h14", s: "Add your own inputs one by one", make: () => emptyCalculator("product") },
];
/** A plain sentence for what an input does to the price. */
function varSentence(v: CalcVariable): string {
  const unit = v.unit_label?.trim() || "units";
  const amt = money(v.amount);
  const inc = Number(v.included) || 0;
  if (v.var_type === "fixed") return `Adds ${amt} when switched on${v.default_value ? " (on by default)" : ""}.`;
  if (v.var_type === "percent") return `Adds ${Number(v.amount) || 0}% of the base price.`;
  if (v.var_type === "per_block") return `${amt} for every ${v.block_size || 1} ${unit}${inc ? ` above the first ${inc}` : ""}, counting ${v.round_mode === "down" ? "only full" : "started"} blocks.`;
  return `${amt} for each ${unit.replace(/s$/, "")}${inc ? ` above the first ${inc}` : ""}.`;
}

function CalcStep({ p, set }: { p: Product; set: (patch: Partial<Product>) => void }) {
  const calc = p.calculator ?? null;
  const [hover, setHover] = useState<string | null>(null);
  const [openVar, setOpenVar] = useState<number | null>(calc?.variables.length ? 0 : null);
  const setCalc = (c: Calculator | null) => set({ calculator: c ? { ...c, owner_type: "product" } : null });
  const key = (v: CalcVariable, i: number) => v.id ?? `v${i}`;
  const setVar = (i: number, patch: Partial<CalcVariable>) => calc && setCalc({ ...calc, variables: calc.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const addVar = (type: CalcVarType) => {
    if (!calc) return;
    const v = { ...emptyCalcVariable(calc.variables.length), var_type: type, amount: type === "percent" ? 10 : 0, block_size: type === "per_block" ? 5 : 25 };
    setCalc({ ...calc, variables: [...calc.variables, v] });
    setOpenVar(calc.variables.length);
  };
  const moveVar = (i: number, d: number) => {
    if (!calc) return;
    const j = i + d; if (j < 0 || j >= calc.variables.length) return;
    const vs = [...calc.variables]; [vs[i], vs[j]] = [vs[j], vs[i]];
    setCalc({ ...calc, variables: vs.map((v, k) => ({ ...v, sort: k })) });
    setOpenVar(j);
  };
  const dupVar = (i: number) => {
    if (!calc) return;
    const { id: _id, ...rest } = calc.variables[i]; void _id;
    const vs = [...calc.variables]; vs.splice(i + 1, 0, { ...rest, name: `${rest.name || "Input"} (copy)` });
    setCalc({ ...calc, variables: vs.map((v, k) => ({ ...v, sort: k })) });
    setOpenVar(i + 1);
  };
  const removeVar = (i: number) => {
    if (!calc) return;
    setCalc({ ...calc, variables: calc.variables.filter((_, j) => j !== i).map((v, k) => ({ ...v, sort: k })) });
    setOpenVar(null);
  };

  return (
    <div className="pw-duo cb">
      <div className="pw-duo-main cb-build">
        {!calc ? (
          <section className="pw-card pw-zone z-calc cb-start" data-g="c-start">
            <ZoneHead z="calc" title="Price calculator" sub="Optional. Use one when the price depends on users, entities or extras instead of a single tier price." guide='[data-g="c-start"]' />
            <div className="pw-zb">
            <div className="cb-presets">
              {PRESETS.map((pr, i) => (
                <button key={pr.k} type="button" className={`cb-preset is-${pr.k}`} style={{ ["--i" as any]: i }} onClick={() => { const c = pr.make(); setCalc(c); setOpenVar(c.variables.length ? 0 : null); }}>
                  <span className="cb-preset-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={pr.icon} /></svg></span>
                  <b>{pr.t}</b><small>{pr.s}</small>
                </button>
              ))}
            </div>
            <p className="cat-hint">Without a calculator, a deal's price is the tier price{p.billing === "recurring" ? " for the term chosen" : ""}.</p>
            </div>
          </section>
        ) : (
          <>
            <section className="pw-card pw-zone z-calc cb-basecard" data-g="c-start">
              <ZoneHead z="calc" title="Starting point" sub="What the calculator adds to" guide='[data-g="c-start"]'>
                <button className="pw-zbtn is-danger" onClick={() => { setCalc(null); setOpenVar(null); }}>Remove calculator</button>
              </ZoneHead>
              <div className="pw-zb">
              <div className="pw-choice is-compact">
                <button type="button" className={`pw-choice-btn ${calc.include_base ? "is-on" : ""}`} onClick={() => setCalc({ ...calc, include_base: true })}>
                  <i /><b>Tier price + inputs</b><small>Starts from the tier's price ({money(p.tiers[0]?.price ?? 0)}{perSuffixOf(p)} for {p.tiers[0]?.name || "the first tier"})</small>
                </button>
                <button type="button" className={`pw-choice-btn ${!calc.include_base ? "is-on" : ""}`} onClick={() => setCalc({ ...calc, include_base: false })}>
                  <i /><b>Inputs only</b><small>The price is built only from the inputs below</small>
                </button>
              </div>
              </div>
            </section>

            <section className="pw-card pw-zone z-inputs" data-g="c-inputs">
            <ZoneHead z="inputs" title="Inputs" sub={calc.variables.length ? `${calc.variables.length} input${calc.variables.length === 1 ? "" : "s"} sales fill in on a deal` : "What sales fill in on a deal"} guide='[data-g="c-inputs"]' />
            <div className="pw-zb">
            <div className="cb-vars">
              {calc.variables.length === 0 && (
                <p className="cb-empty">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={ZONE_ICON.inputs} /></svg>
                  <b>No inputs yet</b><small>Add one below: users, a block of entities, an extra or a % of the price.</small>
                </p>
              )}
              {calc.variables.map((v, i) => {
                const k = key(v, i);
                const open = openVar === i;
                const kind = VAR_KIND.find((x) => x.value === v.var_type) ?? VAR_KIND[0];
                const isBlock = v.var_type === "per_block";
                const isUnits = v.var_type === "per_unit" || isBlock;
                return (
                  <div key={k} className={`cb-var is-${v.var_type} ${open ? "is-open" : ""} ${hover === k ? "is-hot" : ""} ${!v.name.trim() ? "is-unnamed" : ""}`} style={{ ["--i" as any]: i }}
                    onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
                    <div className="cb-var-head">
                      <button type="button" className="cb-var-toggle" onClick={() => setOpenVar(open ? null : i)} aria-expanded={open}>
                        <span className="cb-var-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={kind.icon} /></svg></span>
                        <span className="cb-var-sum">
                          <b>{v.name.trim() || "Unnamed input"}</b>
                          <small>{kind.label} · {varSentence(v)}</small>
                        </span>
                        <svg className="cb-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                      </button>
                      <span className="cb-var-tools">
                        <button type="button" disabled={i === 0} onClick={() => moveVar(i, -1)} title="Move up" aria-label="Move up">↑</button>
                        <button type="button" disabled={i === calc.variables.length - 1} onClick={() => moveVar(i, 1)} title="Move down" aria-label="Move down">↓</button>
                        <button type="button" onClick={() => dupVar(i)} title="Duplicate" aria-label="Duplicate">⧉</button>
                        <button type="button" className="is-del" onClick={() => removeVar(i)} title="Remove" aria-label="Remove">×</button>
                      </span>
                    </div>
                    {open && (
                      <div className="cb-var-body">
                        <div className="cb-row">
                          <label className="cb-f is-grow"><span>Name sales will see</span>
                            <input value={v.name} autoFocus={!v.name} placeholder="e.g. Number of users" onChange={(e) => setVar(i, { name: e.target.value })} />
                          </label>
                          {isUnits && (
                            <label className="cb-f"><span>Unit</span>
                              <input value={v.unit_label ?? ""} placeholder="users" onChange={(e) => setVar(i, { unit_label: e.target.value })} />
                            </label>
                          )}
                        </div>
                        <div className="cb-kinds">
                          {VAR_KIND.map((t) => (
                            <button key={t.value} type="button" className={v.var_type === t.value ? "is-on" : ""} onClick={() => setVar(i, { var_type: t.value })} title={t.hint}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
                              <b>{t.label}</b><small>{t.hint}</small>
                            </button>
                          ))}
                        </div>
                        <div className="cb-row is-fields">
                          <label className="cb-f"><span>{v.var_type === "percent" ? "Percent" : v.var_type === "per_block" ? "Price per block" : v.var_type === "fixed" ? "Amount" : "Price per unit"}</span>
                            <div className="cat-price-input">
                              {v.var_type !== "percent" && <span>€</span>}
                              <input type="number" min="0" className="cat-nospin" value={v.amount} onFocus={(e) => e.target.select()} onChange={(e) => setVar(i, { amount: Number(e.target.value) || 0 })} />
                              {v.var_type === "percent" ? <em>%</em> : perSuffixOf(p) ? <em>{perSuffixOf(p)}</em> : null}
                            </div>
                          </label>
                          {isBlock && (
                            <label className="cb-f"><span>Block of</span>
                              <div className="cat-price-input">
                                <input type="number" min="1" className="cat-nospin" value={v.block_size} onFocus={(e) => e.target.select()} onChange={(e) => setVar(i, { block_size: Number(e.target.value) || 1 })} />
                                <em>{v.unit_label || "units"}</em>
                              </div>
                            </label>
                          )}
                          {isUnits && (
                            <label className="cb-f"><span>Included free</span>
                              <div className="cat-price-input">
                                <input type="number" min="0" className="cat-nospin" value={v.included} onFocus={(e) => e.target.select()} onChange={(e) => setVar(i, { included: Number(e.target.value) || 0 })} />
                                <em>{v.unit_label || "units"}</em>
                              </div>
                            </label>
                          )}
                          {v.var_type === "fixed" ? (
                            <label className="cb-f"><span>On by default</span>
                              <div className="cat-calc-switch">
                                <button className={v.default_value ? "on" : ""} onClick={() => setVar(i, { default_value: 1 })}>Yes</button>
                                <button className={!v.default_value ? "on" : ""} onClick={() => setVar(i, { default_value: 0 })}>No</button>
                              </div>
                            </label>
                          ) : v.var_type !== "percent" && (
                            <label className="cb-f"><span>Starts at</span>
                              <div className="cat-price-input">
                                <input type="number" min="0" className="cat-nospin" value={v.default_value} onFocus={(e) => e.target.select()} onChange={(e) => setVar(i, { default_value: Number(e.target.value) || 0 })} />
                                <em>{v.unit_label || "units"}</em>
                              </div>
                            </label>
                          )}
                          {isBlock && (
                            <label className="cb-f"><span>Count</span>
                              <div className="cat-calc-switch">
                                <button className={v.round_mode !== "down" ? "on" : ""} onClick={() => setVar(i, { round_mode: "up" })}>Started blocks</button>
                                <button className={v.round_mode === "down" ? "on" : ""} onClick={() => setVar(i, { round_mode: "down" })}>Full blocks</button>
                              </div>
                            </label>
                          )}
                        </div>
                        <p className="cb-sentence">{varSentence(v)}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="cb-add" data-g="c-add">
              <span>Add an input</span>
              {VAR_KIND.map((t) => (
                <button key={t.value} type="button" onClick={() => addVar(t.value)} title={t.hint}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>{t.label}
                </button>
              ))}
            </div>
            </div>
            </section>
          </>
        )}
      </div>
      <CalcPreview p={p} hover={hover} onHover={setHover} />
    </div>
  );
}

/** ⓘ on the dark preview: opens the guide at the preview. */
function CpInfo() {
  const open = useContext(GuideCtx);
  if (!open) return null;
  return (
    <button type="button" className="cp-info" onClick={() => open(".cp")} title="What can I do here?" aria-label="About the preview">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 11v6M12 7.5h.01" /></svg>
    </button>
  );
}

/**
 * How the product prices on a deal, live: tier, commitment, the calculator's
 * inputs (sample values you can move), the years with their increase, and the
 * totals. Nothing here is saved; the sample values start from each input's
 * "starts at" value.
 */
function CalcPreview({ p, hover, onHover }: { p: Product; hover: string | null; onHover: (k: string | null) => void }) {
  const calc = p.calculator ?? null;
  const key = (v: CalcVariable, i: number) => v.id ?? `v${i}`;
  const [tierAt, setTierAt] = useState(0);
  const [durAt, setDurAt] = useState(-1);
  const [vals, setVals] = useState<Record<string, number>>({});
  const [years, setYears] = useState<number | null>(null);
  const tier = p.tiers[Math.min(tierAt, Math.max(0, p.tiers.length - 1))];
  const durs = p.billing === "recurring" ? tier?.durations ?? [] : [];
  const dur = durAt >= 0 ? durs[durAt] : undefined;
  const base = (tier?.price ?? 0) * (1 - (dur?.discount_pct ?? 0) / 100);
  const previewCalc: Calculator | null = calc ? { ...calc, variables: calc.variables.map((v, i) => ({ ...v, id: key(v, i) })) } : null;
  const valOf = (v: CalcVariable, i: number) => vals[key(v, i)] ?? (Number(v.default_value) || 0);
  const values: Record<string, number> = {};
  calc?.variables.forEach((v, i) => { values[key(v, i)] = valOf(v, i); });
  const bd = previewCalc ? calcBreakdown(previewCalc, values, base) : { rows: [{ key: BASE_KEY, label: "Tier price", detail: "", amount: base, discount: 0, net: base }], gross: base, discount: 0, total: base };
  const perPeriod = bd.total;
  const multi = !!p.multi_year && p.billing === "recurring";
  const nYears = multi ? years ?? p.default_years ?? 1 : 1;
  const schedule = yearlySchedule(firstYearOf(p, perPeriod), nYears, p.increment_mode, p.increment_value);
  const contract = schedule.reduce((s, x) => s + x, 0);
  const suffix = perSuffixOf(p);
  const sliderMax = (v: CalcVariable) => Math.max(10, Math.ceil(((Number(v.default_value) || 0) * 3 + (Number(v.included) || 0) + (v.var_type === "per_block" ? (Number(v.block_size) || 1) * 4 : 10)) / 5) * 5);

  return (
    <aside className="cp">
      <div className="cp-head">
        <span className="cp-live"><i />Live preview</span>
        <CpInfo />
        <b>{p.name.trim() || "Untitled product"}</b>
        <small>How it will price on a deal. Move the values to try it.</small>
      </div>
      <div className="cp-body">
        {p.tiers.length > 1 && (
          <div className="cp-sec">
            <span className="cp-k"><i>1</i>Tier</span>
            <div className="cp-chips">
              {p.tiers.map((t, i) => (
                <button key={i} type="button" className={i === tierAt ? "is-on" : ""} onClick={() => { setTierAt(i); setDurAt(-1); }}>
                  {t.name || `Tier ${i + 1}`}<small>{money(t.price)}{suffix}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        {durs.length > 0 && (
          <div className="cp-sec">
            <span className="cp-k"><i>{p.tiers.length > 1 ? 2 : 1}</i>Commitment</span>
            <div className="cp-chips">
              <button type="button" className={durAt < 0 ? "is-on" : ""} onClick={() => setDurAt(-1)}>Standard<small>{money(tier?.price ?? 0)}{suffix}</small></button>
              {durs.map((d, i) => (
                <button key={i} type="button" className={i === durAt ? "is-on" : ""} onClick={() => setDurAt(i)}>
                  {d.months} months<small>−{d.discount_pct}%</small>
                </button>
              ))}
            </div>
          </div>
        )}
        {calc && calc.variables.length > 0 && (
          <div className="cp-sec">
            <span className="cp-k"><i>✦</i>Calculator</span>
            <div className="cp-inputs">
              {calc.variables.map((v, i) => {
                const k = key(v, i);
                const val = valOf(v, i);
                return (
                  <div key={k} className={`cp-in ${hover === k ? "is-hot" : ""}`} onMouseEnter={() => onHover(k)} onMouseLeave={() => onHover(null)}>
                    <span className="cp-in-name">{v.name.trim() || "Unnamed input"}</span>
                    {v.var_type === "fixed" ? (
                      <button type="button" role="switch" aria-checked={!!val} className={`cp-sw ${val ? "is-on" : ""}`} onClick={() => setVals((x) => ({ ...x, [k]: val ? 0 : 1 }))}><i /></button>
                    ) : v.var_type === "percent" ? (
                      <span className="cp-in-fixed">+{Number(v.amount) || 0}%</span>
                    ) : (
                      <span className="cp-in-num">
                        <input type="range" min={0} max={sliderMax(v)} step={1} value={val} style={{ ["--p" as any]: `${Math.min(100, (val / sliderMax(v)) * 100)}%` }}
                          onChange={(e) => setVals((x) => ({ ...x, [k]: Number(e.target.value) || 0 }))} />
                        <input type="number" min={0} className="cat-nospin" value={val} onFocus={(e) => e.target.select()}
                          onChange={(e) => setVals((x) => ({ ...x, [k]: Math.max(0, Number(e.target.value) || 0) }))} />
                        <em>{v.unit_label || "units"}</em>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {Object.keys(vals).length > 0 && <button type="button" className="cp-reset" onClick={() => setVals({})}>Reset to the starting values</button>}
          </div>
        )}

        <div className="cp-bd">
          {bd.rows.map((r) => (
            <div key={r.key} className={`cp-row ${hover === r.key ? "is-hot" : ""} ${r.key === BASE_KEY ? "is-base" : ""}`} onMouseEnter={() => r.key !== BASE_KEY && onHover(r.key)} onMouseLeave={() => onHover(null)}>
              <span><b>{r.key === BASE_KEY ? `${tier?.name || "Tier"} price` : r.label}</b>{r.detail && <small>{r.detail}</small>}</span>
              <em>{money(r.amount)}</em>
            </div>
          ))}
          {dur && <div className="cp-row is-note"><span><b>{dur.months}-month commitment</b><small>−{dur.discount_pct}% on the tier price, already applied</small></span></div>}
          <div className="cp-total">
            <span>{p.billing === "recurring" ? `Price per ${periodWord(p)}` : "Price"}</span>
            <b key={Math.round(perPeriod)}>{money(perPeriod)}{suffix}</b>
          </div>
        </div>

        {p.billing === "recurring" && (
          <div className="cp-sec">
            <span className="cp-k"><i>⟳</i>{multi ? "Contract years" : "First year"}
              {multi && (
                <span className="pw-stepper is-mini">
                  <button type="button" onClick={() => setYears(Math.max(1, nYears - 1))} aria-label="Fewer years">−</button>
                  <b>{nYears}</b>
                  <button type="button" onClick={() => setYears(Math.min(10, nYears + 1))} aria-label="More years">+</button>
                </span>
              )}
            </span>
            {multi && <div className="cp-years">
              {schedule.map((v, i) => (
                <span key={i} className="cp-year" style={{ ["--i" as any]: i }}>
                  <small>Year {i + 1}</small><b>{money(Math.round(v))}</b>
                  {i > 0 && v !== schedule[i - 1] && <em>+{money(Math.round(v - schedule[i - 1]))}</em>}
                </span>
              ))}
            </div>}
            <div className="cp-sum">
              <span><small>First year{p.billing_period !== "yearly" ? " · 12 months" : ""}</small><b>{money(Math.round(schedule[0] ?? 0))}</b></span>
              {multi && <span><small>Whole contract · {nYears} yr{nYears === 1 ? "" : "s"}</small><b>{money(Math.round(contract))}</b></span>}
              {multi && <span><small>Increase</small><b>{incrementLabel(p.increment_mode, p.increment_value)}</b></span>}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------- Step 4 · Review ----------
function ReviewStep({ p, kinds, go }: { p: Product; kinds: string[]; go: (i: number) => void }) {
  const suffix = perSuffixOf(p);
  const calc = p.calculator;
  const issues: { t: string; at: number }[] = [];
  if (!p.name.trim()) issues.push({ t: "The product has no name.", at: 0 });
  p.tiers.forEach((t, i) => { if (!t.name.trim()) issues.push({ t: `Tier ${i + 1} has no name.`, at: 1 }); if (!t.price && !calc) issues.push({ t: `${t.name || `Tier ${i + 1}`} costs €0 and there's no calculator.`, at: 1 }); });
  calc?.variables.forEach((v, i) => { if (!v.name.trim()) issues.push({ t: `Calculator input ${i + 1} has no name.`, at: 2 }); });
  if (calc && !calc.variables.length) issues.push({ t: "The calculator has no inputs yet.", at: 2 });
  const sample = calc ? calcTotal({ ...calc, variables: calc.variables.map((v, i) => ({ ...v, id: v.id ?? `v${i}` })) }, {}, p.tiers[0]?.price ?? 0) : p.tiers[0]?.price ?? 0;
  const sched = yearlySchedule(firstYearOf(p, sample), p.multi_year && p.billing === "recurring" ? p.default_years ?? 1 : 1, p.increment_mode, p.increment_value);
  return (
    <div className="pw-stack">
      {issues.length > 0 ? (
        <div className="pw-issues" data-g="r-check">
          <b><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>Before you save · {issues.length} to fix</b>
          {issues.map((x, i) => <button key={i} type="button" onClick={() => go(x.at)}>{x.t}<span>Fix ›</span></button>)}
        </div>
      ) : <div className="pw-allgood" data-g="r-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>Everything's set. Save to add it to your catalog.</div>}
      <div className="pw-review" data-g="r-cards">
        <button type="button" className="pw-rv z-ident" onClick={() => go(0)}>
          <span className="pw-rv-k"><i /><span>Basics</span><em>Edit ›</em></span>
          <b>{p.name || "Untitled product"}</b>
          <small>{kindLabel(p.kind, kinds)} · {p.active === false ? "Inactive" : "Active"} · {p.in_proposals === false ? "Not in proposals" : "In proposals"}</small>
          {p.description?.trim() && <p>{p.description}</p>}
        </button>
        <button type="button" className="pw-rv z-tiers" onClick={() => go(1)}>
          <span className="pw-rv-k"><i /><span>Pricing</span><em>Edit ›</em></span>
          <b>{p.billing === "recurring" ? `Recurring · billed every ${periodWord(p)}` : "One-time"}</b>
          <span className="pw-rv-tiers">
            {p.tiers.map((t, i) => (
              <span key={i}><b>{t.name || `Tier ${i + 1}`}</b><em>{money(t.price)}{suffix}</em>{t.durations.length > 0 && <small>{t.durations.map((d) => `${d.months}mo −${d.discount_pct}%`).join(" · ")}</small>}</span>
            ))}
          </span>
          <small>{p.billing === "recurring" ? (p.multi_year ? `Multi-year · usually ${p.default_years ?? 1} years · ${incrementLabel(p.increment_mode, p.increment_value)}` : "One year at a time") : ""}</small>
        </button>
        <button type="button" className="pw-rv z-calc" onClick={() => go(2)}>
          <span className="pw-rv-k"><i /><span>Calculator</span><em>Edit ›</em></span>
          {calc ? (
            <>
              <b>{calc.variables.length} input{calc.variables.length === 1 ? "" : "s"} · {calc.include_base ? "tier price + inputs" : "inputs only"}</b>
              <span className="pw-rv-vars">{calc.variables.map((v, i) => <small key={i}>• <b>{v.name || "Unnamed"}</b> — {varSentence(v)}</small>)}</span>
            </>
          ) : <b>No calculator · the price is the tier price</b>}
        </button>
        <div className="pw-rv is-total">
          <span className="pw-rv-k"><span>With the starting values</span></span>
          <b>{money(sample)}{suffix}</b>
          {p.billing === "recurring" && <small>First year {money(Math.round(sched[0] ?? 0))}{sched.length > 1 ? ` · ${sched.length}-year contract ${money(Math.round(sched.reduce((s, x) => s + x, 0)))}` : ""}</small>}
        </div>
      </div>
    </div>
  );
}

// ============================ Product kind picker (your list, editable here) ============================
function KindPicker({ value, kinds, options, onChange, onKindsChanged }: {
  value: string; kinds: string[]; options: CrmOption[]; onChange: (k: string) => void; onKindsChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [askDel, setAskDel] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // A kind the product has that is no longer on the list still shows (so it isn't lost).
  const list = kinds.some((k) => kindKey(k) === kindKey(value)) || !kindKey(value) ? kinds : [...kinds, kindLabel(value, kinds)];

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) { setOpen(false); setAskDel(null); } };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);

  const add = async () => {
    const label = draft.trim();
    if (!label) return;
    if (kinds.some((k) => kindKey(k) === kindKey(label))) { setErr("That kind is already on the list."); return; }
    setErr(null);
    // The first kind you add also saves the two you had (SaaS / Physical) so they stay on the list.
    if (options.length === 0) for (const [i, k] of kinds.entries()) await addCrmOption("product_kind", k, i);
    const e = await addCrmOption("product_kind", label, kinds.length);
    if (e) { setErr(e); return; }
    setDraft(""); onKindsChanged(); onChange(label);
  };
  const remove = async (label: string) => {
    const o = options.find((x) => kindKey(x.label) === kindKey(label));
    setAskDel(null);
    if (!o) { // still the built-in pair: save the rest so the list exists without it
      for (const [i, k] of kinds.filter((k) => kindKey(k) !== kindKey(label)).entries()) await addCrmOption("product_kind", k, i);
      onKindsChanged(); return;
    }
    const e = await deleteCrmOption(o.id);
    if (e) setErr(e); else onKindsChanged();
  };

  return (
    <div className="cat-kinds" ref={boxRef}>
      <div className="cat-kind-chips">
        {list.map((k) => (
          <button key={k} type="button" className={`cat-kind-chip ${kindKey(k) === kindKey(value) ? "on" : ""}`}
            style={{ ["--kc" as any]: kindColor(k) }} onClick={() => onChange(k)}>
            <i />{k}
          </button>
        ))}
        <button type="button" className={`cat-kind-edit ${open ? "on" : ""}`} onClick={() => setOpen((v) => !v)} title="Edit the list of kinds">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
          Edit kinds
        </button>
      </div>
      {open && (
        <div className="cat-kind-pop">
          <span className="cat-kind-pop-title">Product kinds</span>
          <div className="cat-kind-rows">
            {kinds.map((k) => (
              <div key={k} className="cat-kind-row">
                <i style={{ background: kindColor(k) }} />
                <span>{k}</span>
                {askDel === k ? (
                  <span className="cat-kind-ask">
                    Remove?
                    <button type="button" onClick={() => setAskDel(null)}>No</button>
                    <button type="button" className="is-danger" onClick={() => remove(k)}>Yes</button>
                  </span>
                ) : kinds.length > 1 && (
                  <button type="button" className="cat-kind-x" aria-label={`Remove ${k}`} onClick={() => setAskDel(k)}>×</button>
                )}
              </div>
            ))}
          </div>
          <div className="cat-kind-add">
            <input value={draft} placeholder="New kind, e.g. Hardware" onChange={(e) => { setDraft(e.target.value); setErr(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
            <button type="button" disabled={!draft.trim()} onClick={add}>Add</button>
          </div>
          {err && <p className="cat-kind-err">{err}</p>}
          <p className="cat-kind-hint">Products keep their kind if you remove it from the list.</p>
        </div>
      )}
    </div>
  );
}

// ============================ Calculator editor (shared) ============================
const VAR_TYPES: { value: CalcVarType; label: string; hint: string }[] = [
  { value: "per_unit",  label: "Per unit",  hint: "counted for every unit above the included amount" },
  { value: "per_block", label: "Per block", hint: "counted for every block of units above the included amount" },
  { value: "fixed",     label: "Fixed",     hint: "added once when switched on" },
  { value: "percent",   label: "% of base", hint: "a percentage of the base amount" },
];

function CalculatorEditor({ calc, onChange, ownerType, basePrice, unit, currencySuffix, rates = [], allRoles = [] }: {
  calc: Calculator | null | undefined;
  onChange: (c: Calculator | null) => void;
  ownerType: "product" | "service";
  /** Base price of the item (products only). */
  basePrice: number;
  /** Rate unit for services: "hour" or "day". Ignored for products. */
  unit?: "hour" | "day";
  currencySuffix?: string;
  /** Services: the service's roles with their rates; each variable says which one its time is billed as. */
  rates?: { id: string; label: string; price: number; main?: boolean }[];
  /** Every role, to name a variable's role even if the service no longer has it. */
  allRoles?: ClientRole[];
}) {
  const isService = ownerType === "service";
  const unitWord = unit === "hour" ? "hours" : "days";

  if (!calc) {
    return (
      <>
        <div className="cat-tiers-head">
          <span className="cat-eyebrow">{isService ? "Duration calculator" : "Price calculator"}</span>
          <button className="cat-mini-add" onClick={() => onChange(emptyCalculator(ownerType))}>+ Add calculator</button>
        </div>
        <p className="cat-hint">
          {isService
            ? `Optional. Estimate how many ${unitWord} an engagement will take, from variables such as number of companies or km travelled.`
            : "Optional. Build a price from variables such as number of users or entities, instead of a single fixed price."}
        </p>
      </>
    );
  }

  const isQty = calc.output_kind === "quantity";
  const base = isQty ? Number(calc.base_amount) || 0 : basePrice;
  // Amounts are money for products and units of time for services.
  const fmt = (n: number) => (isQty ? `${(Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unitWord}` : `${money(n)}${currencySuffix ?? ""}`);
  const amountUnit = isQty ? unitWord : null;

  const setVar = (i: number, patch: Partial<CalcVariable>) =>
    onChange({ ...calc, variables: calc.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const addVar = () => onChange({ ...calc, variables: [...calc.variables, emptyCalcVariable(calc.variables.length)] });
  const removeVar = (i: number) => onChange({ ...calc, variables: calc.variables.filter((_, j) => j !== i) });
  /** The role a variable's time is billed as ("" = the service's main role). */
  const mainRate = rates.find((r) => r.main) ?? rates[0];
  const setRole = (i: number, roleId: string) => setVar(i, { role_id: roleId || null, is_supervision: false, rate: null });

  const key = (v: CalcVariable, i: number) => v.id ?? String(i);
  // The result shown below uses each variable's default value.
  const previewValues: Record<string, number> = {};
  calc.variables.forEach((v, i) => {
    const k = key(v, i);
    previewValues[k] = Number(v.default_value) || 0;
  });
  const previewCalc: Calculator = { ...calc, variables: calc.variables.map((v, i) => ({ ...v, id: key(v, i) })) };
  const total = calcTotal(previewCalc, previewValues, base);

  return (
    <>
      <div className="cat-tiers-head">
        <span className="cat-eyebrow">{isService ? "Duration calculator" : "Price calculator"}</span>
        <div className="cat-calc-headbtns">
          <button className="cat-mini-add" onClick={addVar}>+ Add variable</button>
          <button className="cat-calc-remove" onClick={() => onChange(null)}>Remove</button>
        </div>
      </div>

      {isQty ? (
        <div className="cat-calc-baseqty">
          <label className="cat-calc-base">
            <input type="checkbox" checked={calc.include_base} onChange={(e) => onChange({ ...calc, include_base: e.target.checked })} />
            <span>Start from a base of</span>
          </label>
          <div className="cat-price-input">
            <input type="number" min="0" step="0.5" className="cat-nospin" value={calc.base_amount}
              disabled={!calc.include_base} onFocus={(e) => e.target.select()}
              onChange={(e) => onChange({ ...calc, base_amount: Number(e.target.value) || 0 })} />
            <em>{unitWord}</em>
          </div>
          <span className="cat-hint">before any variable is applied.</span>
        </div>
      ) : (
        <label className="cat-calc-base">
          <input type="checkbox" checked={calc.include_base} onChange={(e) => onChange({ ...calc, include_base: e.target.checked })} />
          <span>Start from the base price ({money(basePrice)}{currencySuffix}). Uncheck to build the price only from the variables below.</span>
        </label>
      )}

      {calc.variables.length === 0 && (
        <p className="cat-hint">No variables yet. Add one to start building the {isQty ? "estimate" : "price"}.</p>
      )}

      {calc.variables.map((v, i) => {
        const k = key(v, i);
        const isBlock = v.var_type === "per_block";
        const isUnits = v.var_type === "per_unit" || isBlock;
        return (
          <div key={k} className="cat-calc-var">
            <div className="cat-calc-var-top">
              <input className="cat-calc-name" value={v.name}
                placeholder={isQty ? "Variable name (e.g. Number of companies)" : "Variable name (e.g. Number of users)"}
                onChange={(e) => setVar(i, { name: e.target.value })} />
              {isUnits && (
                <input className="cat-calc-unit" value={v.unit_label ?? ""}
                  placeholder={isQty ? "unit (e.g. companies, km)" : "unit (e.g. users)"}
                  onChange={(e) => setVar(i, { unit_label: e.target.value })} />
              )}
              <button className="cat-tier-del" onClick={() => removeVar(i)} aria-label="Remove variable">×</button>
            </div>

            <div className="cat-calc-types">
              {VAR_TYPES.map((vt) => (
                <button key={vt.value} className={v.var_type === vt.value ? "on" : ""}
                  title={vt.hint} onClick={() => setVar(i, { var_type: vt.value })}>{vt.label}</button>
              ))}
            </div>

            <div className="cat-calc-fields">
              <label className="cat-calc-f">
                <span>{v.var_type === "percent" ? "Percent" : isQty ? `Adds (${unitWord})` : "Amount"}</span>
                <div className="cat-price-input">
                  {!isQty && v.var_type !== "percent" && <span>€</span>}
                  <input type="number" min="0" step={isQty ? "0.25" : "1"} className="cat-nospin" value={v.amount} onFocus={(e) => e.target.select()}
                    onChange={(e) => setVar(i, { amount: Number(e.target.value) || 0 })} />
                  {v.var_type === "percent" ? <em>%</em> : amountUnit ? <em>{amountUnit}</em> : null}
                </div>
              </label>

              {isBlock && (
                <label className="cat-calc-f">
                  <span>Per every</span>
                  <div className="cat-price-input">
                    <input type="number" min="1" className="cat-nospin" value={v.block_size} onFocus={(e) => e.target.select()}
                      onChange={(e) => setVar(i, { block_size: Number(e.target.value) || 1 })} />
                    <em>{v.unit_label || "units"}</em>
                  </div>
                </label>
              )}

              {isUnits && (
                <label className="cat-calc-f">
                  <span>Included</span>
                  <div className="cat-price-input">
                    <input type="number" min="0" className="cat-nospin" value={v.included} onFocus={(e) => e.target.select()}
                      onChange={(e) => setVar(i, { included: Number(e.target.value) || 0 })} />
                    <em>free</em>
                  </div>
                </label>
              )}

              <label className="cat-calc-f">
                <span>{v.var_type === "fixed" ? "On by default" : "Default"}</span>
                {v.var_type === "fixed" ? (
                  <div className="cat-calc-switch">
                    <button className={v.default_value ? "on" : ""} onClick={() => setVar(i, { default_value: 1 })}>Yes</button>
                    <button className={!v.default_value ? "on" : ""} onClick={() => setVar(i, { default_value: 0 })}>No</button>
                  </div>
                ) : (
                  <div className="cat-price-input">
                    <input type="number" min="0" className="cat-nospin" value={v.default_value} onFocus={(e) => e.target.select()}
                      onChange={(e) => setVar(i, { default_value: Number(e.target.value) || 0 })} />
                    <em>{v.var_type === "percent" ? "n/a" : v.unit_label || "units"}</em>
                  </div>
                )}
              </label>

              {isBlock && (
                <label className="cat-calc-f">
                  <span>Count</span>
                  <div className="cat-calc-switch">
                    <button className={v.round_mode !== "down" ? "on" : ""} onClick={() => setVar(i, { round_mode: "up" })}>Started blocks</button>
                    <button className={v.round_mode === "down" ? "on" : ""} onClick={() => setVar(i, { round_mode: "down" })}>Full blocks</button>
                  </div>
                </label>
              )}
            </div>

            {isQty && (() => {
              const own = v.role_id ? rates.find((r) => r.id === v.role_id) : undefined;
              const roleRate = own ? own.price : mainRate?.price;
              const opts = [
                { value: "", label: mainRate ? `Main · ${mainRate.label}` : "Main role" },
                ...rates.filter((r) => !r.main || v.role_id === r.id).map((r) => ({ value: r.id, label: r.label })),
              ];
              if (v.role_id && !own) opts.push({ value: v.role_id, label: allRoles.find((r) => r.id === v.role_id)?.name ?? "Role no longer on this service" });
              const at = allRoles.findIndex((r) => r.id === (v.role_id || mainRate?.id));
              return (
                <div className={`cat-calc-sup ${v.role_id ? "is-on" : ""}`} style={{ ["--c" as any]: roleColor(allRoles[at], at < 0 ? 0 : at) }}>
                  <span className="cat-calc-role-dot" aria-hidden="true" />
                  <div className="cat-calc-sup-txt">
                    <b>Billed as</b>
                    <span>{v.role_id
                      ? `The ${unitWord} this adds are billed on this role, at its rate unless you set one.`
                      : `The ${unitWord} this adds go to the service's main role.`}</span>
                  </div>
                  <div className="cat-calc-sup-rate">
                    <div className="cat-calc-role-sel">
                      <Select value={v.role_id ?? ""} onChange={(val) => setRole(i, val)} options={opts} />
                    </div>
                    <div className="cat-price-input">
                      <span>€</span>
                      <input type="number" min="0" className="cat-nospin" value={v.rate ?? ""} placeholder={roleRate != null ? String(roleRate) : "Role rate"}
                        title="Leave empty to use the role's rate"
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => setVar(i, { rate: e.target.value === "" ? null : Number(e.target.value) || 0 })} />
                      <em>/{unit === "hour" ? "h" : "d"}</em>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })}

      {calc.variables.length > 0 && (
        <div className="cat-calc-result">
          <span className="cat-calc-result-k">{isQty ? "Estimated length" : "Total"}</span>
          <b className="cat-calc-result-v">{fmt(total)}</b>
          <span className="cat-calc-result-n">with the default values above</span>
        </div>
      )}
    </>
  );
}

// ============================ Service editor ============================
function ServiceEditor({ service, blueprints, roles, onClose, onSaved, onDeleted }: {
  service: Service; blueprints: Blueprint[]; roles: ClientRole[];
  onClose: () => void; onSaved: (notice?: string) => void; onDeleted: () => void;
}) {
  const [s, setS] = useState<Service>(service);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Service>) => setS((x) => ({ ...x, ...patch }));

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name || "Role";
  const roleAt = (id: string) => roles.findIndex((r) => r.id === id);
  const usedRoleIds = new Set(s.roles.map((r) => r.role_id));
  const available = roles.filter((r) => !usedRoleIds.has(r.id));

  const addRole = (roleId: string) =>
    setS((x) => ({ ...x, roles: [...x.roles, { role_id: roleId, price: 0, sort: x.roles.length, is_main: x.roles.length === 0 }] }));
  /** Only one role per service can be main — picking a new one clears the old. */
  const setMainRole = (i: number) =>
    setS((x) => ({ ...x, roles: x.roles.map((r, j) => ({ ...r, is_main: j === i })) }));
  const setRolePrice = (i: number, price: number) =>
    setS((x) => ({ ...x, roles: x.roles.map((r, j) => (j === i ? { ...r, price } : r)) }));
  const removeRole = (i: number) =>
    setS((x) => ({ ...x, roles: x.roles.filter((_, j) => j !== i) }));

  const save = async () => {
    if (!s.name.trim()) { setErr("Give the service a name."); return; }
    setBusy(true); setErr(null);
    const e = await saveService(s);
    setBusy(false);
    if (e && !/^Saved, but/.test(e)) setErr(e); else onSaved(e ?? undefined);
  };
  const remove = async () => {
    if (!s.id) return onClose();
    if (!confirm(`Delete "${s.name}" permanently?`)) return;
    await deleteService(s.id);
    onDeleted();
  };

  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".pw-guide")) return;
      if (e.key === "Escape" && !document.querySelector(".sel-pop, .dp-pop")) { e.preventDefault(); closeRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  useCenterOnFocus(rootRef);
  const [guide, setGuide] = useState<string | null>(null);

  return createPortal(
    <div className="cat-backdrop pw-backdrop" onMouseDown={onClose}>
      <GuideCtx.Provider value={(sel) => setGuide(sel ?? "")}>
      <div ref={rootRef} className="pw is-svc" role="dialog" aria-modal="true" aria-label={s.id ? `Edit ${s.name}` : "New service"} onMouseDown={(e) => e.stopPropagation()}>
        <section className="pw-main">
        <header className="pw-head">
          <span className="cat-svc-icon pw-head-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M3 12h18" /></svg>
          </span>
          <div className="pw-head-id">
            <span className="pw-head-step">{s.id ? "Edit service" : "New service"}</span>
            <h2 className="pw-head-title">{s.name.trim() || "Untitled service"}<small>Rates per role, delivery and how long a project takes</small></h2>
          </div>
          <div className="cat-head-right">
            <ProposalSwitch on={s.in_proposals !== false} onChange={(v) => setS((x) => ({ ...x, in_proposals: v }))} />
            <GuideButton onClick={() => setGuide("")} nudge={!s.id} />
            <button className="cat-x" onClick={onClose} aria-label="Close">×</button>
          </div>
        </header>

        <div className="pw-body is-duo"><div className="pw-pane"><div className="pw-duo">
        <div className="pw-duo-main">
          <section className="pw-card pw-zone z-ident" data-g="s-ident">
            <ZoneHead z="service" title="Service" sub="Name and how it's billed" guide='[data-g="s-ident"]' />
            <div className="pw-zb">
            <div className="cat-field">
              <label>Service name</label>
              <input value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Consolidation Implementation" />
            </div>

            <div className="cat-unit-row">
              <div className="cat-field">
                <label>Billed per</label>
                <div className="cat-seg cat-seg-unit">
                  <button className={s.rate_unit === "hour" ? "on" : ""}
                    onClick={() => set({ rate_unit: "hour", min_unit: s.min_unit ?? 0.5 })}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                    Hour
                  </button>
                  <button className={s.rate_unit === "day" ? "on" : ""}
                    onClick={() => set({ rate_unit: "day", min_unit: s.min_unit ?? 0.25 })}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>
                    Day
                  </button>
                </div>
              </div>

              <div className="cat-field">
                <label>Smallest bookable amount</label>
                <input type="number" min="0" step="any" className="cat-nospin"
                  value={s.min_unit ?? (s.rate_unit === "hour" ? 0.5 : 0.25)}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => set({ min_unit: Number(e.target.value) || 0 })} />
              </div>
            </div>
            </div>
          </section>

          <section className="pw-card pw-zone z-billing" data-g="s-delivery">
            <ZoneHead z="delivery" title="Delivery" sub="The phases every project of this service follows" guide='[data-g="s-delivery"]' />
            <div className="pw-zb">
            <div className="cat-field">
              <label>Phase blueprint</label>
              <Select
                value={s.blueprint_id ?? ""}
                onChange={(v) => set({ blueprint_id: v || null })}
                placeholder="- No blueprint -"
                options={[{ value: "", label: "- No blueprint -" }, ...blueprints.map((b) => ({ value: b.id, label: b.name || "Untitled blueprint" }))]}
              />
              <span className="cat-hint">Structures the phases of every project delivered under this service.</span>
            </div>
            </div>
          </section>

          <section className="pw-card pw-zone z-tiers" data-g="s-roles">
            <ZoneHead z="roles" title="Roles and rates" sub={s.roles.length > 0 ? `${s.roles.length} of ${roles.length} roles priced · the star is the main role` : "What each role costs"} guide='[data-g="s-roles"]' />
            <div className="pw-zb">

            {roles.length === 0 ? (
              <p className="cat-hint">No roles yet. Create them in the Blueprints tab first, then set their rates here.</p>
            ) : (
              <>
                {s.roles.length === 0 && <p className="cat-hint">No rates set. Add a role to price this service.</p>}
                <div className="cat-roles">
                  {s.roles.map((r, ri) => (
                    <div key={ri} className={`cat-role ${r.is_main ? "is-main" : ""}`}>
                      <button
                        type="button"
                        className={`cat-role-main ${r.is_main ? "is-on" : ""}`}
                        onClick={() => setMainRole(ri)}
                        title={r.is_main ? "Main role for this service" : "Set as the main role for this service"}
                        aria-pressed={!!r.is_main}
                      >
                        <svg viewBox="0 0 24 24" fill={r.is_main ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2.5l2.9 6.3 6.9.7-5.2 4.7 1.5 6.8L12 17.6l-6.1 3.4 1.5-6.8-5.2-4.7 6.9-.7z" />
                        </svg>
                      </button>
                      <span className="cat-role-av" style={{ background: roleColor(roles[roleAt(r.role_id)], Math.max(0, roleAt(r.role_id))), color: "#fff" }}>{(roleName(r.role_id) || "?").slice(0, 1).toUpperCase()}</span>
                      <span className="cat-role-nm">
                        {roleName(r.role_id)}
                        {r.is_main && <em className="cat-role-tag">Main</em>}
                        {roles.find((x) => x.id === r.role_id)?.countsForTarget === false && <em className="cat-role-tag is-nocount" title="Time on this role doesn't count for the consultant's billing">Doesn't count</em>}
                      </span>
                      <div className="cat-price-input cat-role-price">
                        <span>€</span>
                        <input type="number" min="0" className="cat-nospin" value={r.price}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => setRolePrice(ri, Number(e.target.value) || 0)} />
                        <em>/{s.rate_unit === "hour" ? "h" : "d"}</em>
                      </div>
                      <button className="cat-role-x" onClick={() => removeRole(ri)} aria-label="Remove role">×</button>
                    </div>
                  ))}
                </div>
                {available.length > 0 && (
                  <div className="cat-add-role">
                    <Select value="" onChange={(v) => v && addRole(v)} placeholder="+ Add a role"
                      options={available.map((r) => ({ value: r.id, label: r.name || "Untitled role" }))} />
                  </div>
                )}
              </>
            )}
            </div>
          </section>

          <section className="pw-card pw-zone z-calc is-svc-calc" data-g="s-calc">
          <ZoneHead z="calc" title="Duration calculator" sub="Questions that work out how long a project takes" guide='[data-g="s-calc"]' />
          <div className="pw-zb">
          <CalculatorEditor
            calc={s.calculator}
            onChange={(c) => set({ calculator: c ? { ...c, owner_type: "service" } : null })}
            ownerType="service"
            basePrice={0}
            unit={s.rate_unit}
            rates={s.roles.filter((r) => r.role_id).map((r, k) => ({ id: r.role_id, label: roleName(r.role_id) || "Role", price: Number(r.price) || 0, main: s.roles.some((x) => x.is_main) ? !!r.is_main : k === 0 }))}
            allRoles={roles}
          />
          </div>
          </section>
        </div>
        <ServicePreview s={s} roles={roles} />
        </div></div></div>

        {err && <p className="cat-error pw-err">{err}</p>}
        <footer className="pw-foot">
          {s.id && <button className="cat-delete" onClick={remove}>Delete</button>}
          <div className="cat-foot-right">
            <button className="cat-cancel" onClick={onClose}>Cancel</button>
            <button className="cat-save pw-next" onClick={save} disabled={busy}>{busy ? "Saving…" : s.id ? "Save service" : "Create service"}</button>
          </div>
        </footer>
        </section>
        {guide !== null && <StudioGuide key={guide} root={rootRef} stops={SERVICE_GUIDE} start={guide} onClose={() => setGuide(null)} />}
      </div>
      </GuideCtx.Provider>
    </div>,
    document.body,
  );
}

/**
 * Live estimate for a service: its rates, the duration calculator with sample
 * values you can move, the time it adds per role and what that costs.
 * Nothing here is saved.
 */
function ServicePreview({ s, roles }: { s: Service; roles: ClientRole[] }) {
  const calc = s.calculator ?? null;
  const u = s.rate_unit === "hour" ? "h" : "d";
  const unitWord = s.rate_unit === "hour" ? "hours" : "days";
  const key = (v: CalcVariable, i: number) => v.id ?? String(i);
  const [vals, setVals] = useState<Record<string, number>>({});
  const svcRoles = s.roles.filter((r) => r.role_id);
  const main = svcRoles.find((r) => r.is_main) ?? svcRoles[0];
  const roleAt = (id?: string | null) => roles.findIndex((r) => r.id === id);
  const roleNm = (id?: string | null) => roles.find((r) => r.id === id)?.name || "Role";
  const rateOf = (id?: string | null) => Number(svcRoles.find((r) => r.role_id === (id || main?.role_id))?.price) || 0;
  const values: Record<string, number> = {};
  calc?.variables.forEach((v, i) => { values[key(v, i)] = vals[key(v, i)] ?? (Number(v.default_value) || 0); });
  const previewCalc: Calculator | null = calc ? { ...calc, variables: calc.variables.map((v, i) => ({ ...v, id: key(v, i) })) } : null;
  const bd = previewCalc ? calcBreakdown(previewCalc, values, Number(calc!.base_amount) || 0) : null;
  const fmtQ = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${u}`;
  // Time and money per role.
  const byRole = new Map<string, { id: string; days: number; cost: number }>();
  bd?.rows.forEach((r) => {
    const v = previewCalc!.variables.find((x) => x.id === r.key);
    const rid = (r.key === BASE_KEY ? null : v?.role_id) || main?.role_id || "";
    const rate = v?.rate != null && r.key !== BASE_KEY ? Number(v.rate) || 0 : rateOf(rid);
    const cur = byRole.get(rid) ?? { id: rid, days: 0, cost: 0 };
    cur.days += r.amount; cur.cost += r.amount * rate;
    byRole.set(rid, cur);
  });
  const split = [...byRole.values()].filter((x) => x.days > 0);
  const totalCost = split.reduce((a, x) => a + x.cost, 0);
  const sliderMax = (v: CalcVariable) => Math.max(10, Math.ceil(((Number(v.default_value) || 0) * 3 + (Number(v.included) || 0) + (v.var_type === "per_block" ? (Number(v.block_size) || 1) * 4 : 10)) / 5) * 5);

  return (
    <aside className="cp">
      <div className="cp-head">
        <span className="cp-live"><i />Live estimate</span>
        <CpInfo />
        <b>{s.name.trim() || "Untitled service"}</b>
        <small>{calc ? "How a project of this service is sized and priced. Move the values to try it." : "Its rates. Add a duration calculator to size projects from a few questions."}</small>
      </div>
      <div className="cp-body">
        <div className="cp-sec">
          <span className="cp-k"><i>€</i>Rates per {s.rate_unit}</span>
          {svcRoles.length === 0 ? <p className="cp-none">No roles priced yet. Add them on the left.</p> : (
            <div className="cp-rates">
              {svcRoles.map((r, i) => {
                const at = roleAt(r.role_id);
                return (
                  <span key={i} className={`cp-rate ${r === main ? "is-main" : ""}`} style={{ ["--c" as any]: roleColor(roles[at], Math.max(0, at)) }}>
                    <i />{roleNm(r.role_id)}{r === main && <em>Main</em>}<b>{money(Number(r.price) || 0)}<small>/{u}</small></b>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {calc && calc.variables.length > 0 && (
          <div className="cp-sec">
            <span className="cp-k"><i>✦</i>Project questions</span>
            <div className="cp-inputs">
              {calc.variables.map((v, i) => {
                const k = key(v, i);
                const val = values[k];
                return (
                  <div key={k} className="cp-in">
                    <span className="cp-in-name">{v.name.trim() || "Unnamed variable"}</span>
                    {v.var_type === "fixed" ? (
                      <button type="button" role="switch" aria-checked={!!val} className={`cp-sw ${val ? "is-on" : ""}`} onClick={() => setVals((x) => ({ ...x, [k]: val ? 0 : 1 }))}><i /></button>
                    ) : v.var_type === "percent" ? (
                      <span className="cp-in-fixed">+{Number(v.amount) || 0}%</span>
                    ) : (
                      <span className="cp-in-num">
                        <input type="range" min={0} max={sliderMax(v)} step={1} value={val} style={{ ["--p" as any]: `${Math.min(100, (val / sliderMax(v)) * 100)}%` }}
                          onChange={(e) => setVals((x) => ({ ...x, [k]: Number(e.target.value) || 0 }))} />
                        <input type="number" min={0} className="cat-nospin" value={val} onFocus={(e) => e.target.select()}
                          onChange={(e) => setVals((x) => ({ ...x, [k]: Math.max(0, Number(e.target.value) || 0) }))} />
                        <em>{v.unit_label || "units"}</em>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {Object.keys(vals).length > 0 && <button type="button" className="cp-reset" onClick={() => setVals({})}>Reset to the defaults</button>}
          </div>
        )}

        {bd && (
          <div className="cp-bd">
            {bd.rows.map((r) => (
              <div key={r.key} className={`cp-row ${r.key === BASE_KEY ? "is-base" : ""}`}>
                <span><b>{r.key === BASE_KEY ? "Base" : r.label}</b>{r.detail && <small>{r.detail}</small>}</span>
                <em>{fmtQ(r.amount)}</em>
              </div>
            ))}
            {bd.rows.length === 0 && <div className="cp-row"><span><small>Nothing adds time with these values.</small></span></div>}
            <div className="cp-total">
              <span>Estimated length</span>
              <b key={Math.round(bd.total * 100)}>{fmtQ(bd.total)}</b>
            </div>
          </div>
        )}

        {bd && split.length > 0 && (
          <div className="cp-sec">
            <span className="cp-k"><i>◔</i>By role</span>
            <div className="cp-split">
              {split.map((x) => {
                const at = roleAt(x.id);
                return (
                  <div key={x.id} className="cp-split-row" style={{ ["--c" as any]: roleColor(roles[at], Math.max(0, at)), ["--w" as any]: `${bd.total > 0 ? (x.days / bd.total) * 100 : 0}%` }}>
                    <span><i />{x.id ? roleNm(x.id) : "Main role"}</span>
                    <small>{fmtQ(x.days)}</small>
                    <b>{money(Math.round(x.cost))}</b>
                    <em />
                  </div>
                );
              })}
            </div>
            <div className="cp-sum">
              <span><small>Total {unitWord}</small><b>{fmtQ(bd.total)}</b></span>
              <span><small>Estimated fee</small><b>{money(Math.round(totalCost))}</b></span>
            </div>
          </div>
        )}

        {!calc && (
          <div className="cp-empty">
            <b>No duration calculator</b>
            <small>On a deal, sales will type the {unitWord} by hand. Add a calculator on the left to estimate them from a few questions (companies, entities, travel…).</small>
          </div>
        )}
      </div>
    </aside>
  );
}

// ============================ Blueprints tab (types + blueprints + roles) ============================
const uid = () => crypto.randomUUID();
const Chevron = ({ dir }: { dir: "right" | "up" }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {dir === "right" ? <path d="M9 6l6 6-6 6" /> : <path d="M6 15l6-6 6 6" />}
  </svg>
);

function BlueprintsTab({ onChanged }: { onChanged: () => void }) {
  const [projectTypes, setProjectTypes] = useState<ProjectType[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [roles, setRoles] = useState<ClientRole[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [sub, setSub] = useState<"blueprints" | "roles" | "worktypes">("blueprints");

  /**
   * Types of work used to be edited from the calendar's gear. They live in
   * their own table and are what tells an entry whether it needs a client and
   * a project, so they belong with the rest of the catalogue.
   */
  const [workTypes, setWorkTypes] = useState<{ id: string; name: string; clientRelated: boolean; color: string }[]>([]);
  const [wtDirty, setWtDirty] = useState(false);

  useEffect(() => {
    supabase.from("work_types").select("*").order("created_at").then(({ data }) => {
      setWorkTypes((data ?? []).map((r: any) => ({
        id: r.id, name: r.name ?? "", clientRelated: !!r.client_related, color: r.color ?? "#12b57f",
      })));
    });
  }, []);

  const addWorkType = () => {
    setWorkTypes((xs) => [...xs, { id: crypto.randomUUID(), name: "", clientRelated: true, color: "#12b57f" }]);
    setWtDirty(true);
    setSavedAt(null);
  };
  const patchWorkType = (id: string, patch: Partial<{ name: string; clientRelated: boolean; color: string }>) => {
    setWorkTypes((xs) => xs.map((w) => (w.id === id ? { ...w, ...patch } : w)));
    setWtDirty(true);
    setSavedAt(null);
  };
  const removeWorkType = (id: string) => {
    setWorkTypes((xs) => xs.filter((w) => w.id !== id));
    setWtDirty(true);
    setSavedAt(null);
  };
  const saveWorkTypes = async () => {
    const { data: existing } = await supabase.from("work_types").select("id");
    const keep = new Set(workTypes.map((w) => w.id));
    const gone = (existing ?? []).map((r: any) => r.id).filter((id: string) => !keep.has(id));
    // Entries keep pointing at a deleted type, so only remove what is unused.
    if (gone.length) await supabase.from("work_types").delete().in("id", gone);
    if (workTypes.length) {
      await supabase.from("work_types").upsert(workTypes.map((w) => ({
        id: w.id, name: w.name, client_related: w.clientRelated, color: w.color,
      })));
    }
    setWtDirty(false);
  };
  const [openId, setOpenId] = useState<string | null>(null);
  const [openRoleId, setOpenRoleId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // When any data changes after a save, drop the "Saved ✓" state so the button
  // invites saving again. A ref lets us skip the change caused by the save/load itself.
  const skipDirty = useRef(true);
  useEffect(() => {
    if (skipDirty.current) { skipDirty.current = false; return; }
    setSavedAt(null);
  }, [projectTypes, blueprints, roles]);

  useEffect(() => {
    loadBlueprintData().then((d) => { skipDirty.current = true; setProjectTypes(d.projectTypes); setBlueprints(d.blueprints); setRoles(d.roles); }).catch(() => {});
    supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(({ data }: any) => {
      setUsers(((data?.users ?? []) as any[]).map((u) => ({
        id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—",
      })));
    }).catch(() => {});
  }, []);

  const userName = (id: string) => users.find((u) => u.id === id)?.name ?? "—";

  const save = async () => {
    setSaving(true);
    await saveBlueprintData(projectTypes, blueprints, roles).catch(() => {});
    await saveWorkTypes().catch(() => {});
    setSaving(false);
    skipDirty.current = true;   // the reload below shouldn't count as a new edit
    setSavedAt(Date.now());
    onChanged();
  };

  // roles
  const addRole = () => {
    const id = uid();
    setRoles((r) => [...r, { id, name: "", userIds: [], isSupervision: false, countsForTarget: true, color: ROLE_COLORS[r.length % ROLE_COLORS.length], sort: r.length + 1 }]);
    setOpenRoleId(id);
  };
  const patchRole = (id: string, patch: Partial<ClientRole>) => setRoles((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeRole = (id: string) => { setRoles((r) => r.filter((x) => x.id !== id)); if (openRoleId === id) setOpenRoleId(null); };
  const addPerson = (roleId: string, userId: string) => setRoles((r) => r.map((x) => x.id !== roleId || x.userIds.includes(userId) ? x : { ...x, userIds: [...x.userIds, userId] }));
  const removePerson = (roleId: string, userId: string) => setRoles((r) => r.map((x) => x.id !== roleId ? x : { ...x, userIds: x.userIds.filter((u) => u !== userId) }));
  // blueprints
  const addBlueprint = () => { const id = uid(); setBlueprints((b) => [...b, { id, name: "", projectTypeId: "", phases: [] }]); setOpenId(id); };
  const patchBp = (bpId: string, patch: Partial<Blueprint>) => setBlueprints((b) => b.map((x) => (x.id === bpId ? { ...x, ...patch } : x)));
  const removeBp = (bpId: string) => { setBlueprints((b) => b.filter((x) => x.id !== bpId)); if (openId === bpId) setOpenId(null); };
  const addPhase = (bpId: string) => setBlueprints((b) => b.map((x) => x.id !== bpId ? x : { ...x, phases: [...x.phases, { id: uid(), name: "", percent: 0, tasks: [] }] }));
  const patchPhase = (bpId: string, phId: string, patch: Partial<BlueprintPhase>) => setBlueprints((b) => b.map((x) => x.id !== bpId ? x : { ...x, phases: x.phases.map((p) => (p.id === phId ? { ...p, ...patch } : p)) }));
  const removePhase = (bpId: string, phId: string) => setBlueprints((b) => b.map((x) => x.id !== bpId ? x : { ...x, phases: x.phases.filter((p) => p.id !== phId) }));
  const addTask = (bpId: string, phId: string) => setBlueprints((b) => b.map((x) => x.id !== bpId ? x : { ...x, phases: x.phases.map((p) => p.id !== phId ? p : { ...p, tasks: [...p.tasks, { id: uid(), name: "", percent: 0 }] }) }));
  const patchTask = (bpId: string, phId: string, tId: string, name: string) => setBlueprints((b) => b.map((x) => x.id !== bpId ? x : { ...x, phases: x.phases.map((p) => p.id !== phId ? p : { ...p, tasks: p.tasks.map((t) => (t.id === tId ? { ...t, name } : t)) }) }));
  const removeTask = (bpId: string, phId: string, tId: string) => setBlueprints((b) => b.map((x) => x.id !== bpId ? x : { ...x, phases: x.phases.map((p) => p.id !== phId ? p : { ...p, tasks: p.tasks.filter((t) => t.id !== tId) }) }));

  return (
    <section className="cat-body">
      <div className="cat-list-head">
        <div className="cat-subtabs">
          <button className={sub === "blueprints" ? "on" : ""} onClick={() => setSub("blueprints")}>Phase blueprints</button>
          <button className={sub === "roles" ? "on" : ""} onClick={() => setSub("roles")}>Roles</button>
          <button className={sub === "worktypes" ? "on" : ""} onClick={() => setSub("worktypes")}>Types of work</button>
        </div>
        <button className="cat-save" onClick={save} disabled={saving}>{saving ? "Saving…" : savedAt ? "Saved ✓" : "Save changes"}</button>
      </div>

      {sub === "roles" && (
        <div className="cs-roles">
          <button className="cl-add cs-add-bp" onClick={addRole}>+ New role</button>
          {roles.length === 0 && <p className="cl-hint">No roles yet.</p>}
          {roles.map((role) => {
            if (openRoleId !== role.id) {
              return (
                <button className="cs-bp-row" key={role.id} onClick={() => setOpenRoleId(role.id)}>
                  <div className="cs-bp-row-main">
                    <span className="cs-bp-row-name">
                      <span className="cat-role-dot" style={{ background: roleColor(role, roles.indexOf(role)) }} aria-hidden="true" />
                      {role.name || "Untitled role"}
                      {!role.countsForTarget && <span className="cat-role-tag is-nocount">Doesn't count</span>}
                    </span>
                    <span className="cs-bp-row-type">{role.userIds.length} {role.userIds.length === 1 ? "person" : "people"}</span>
                  </div>
                  <Chevron dir="right" />
                </button>
              );
            }
            const unassigned = users.filter((u) => !role.userIds.includes(u.id));
            return (
              <div className="cs-bp" key={role.id}>
                <button className="cs-bp-bar" onClick={() => setOpenRoleId(null)}><span>{role.name || "Untitled role"}</span><Chevron dir="up" /></button>
                <div className="cs-role-head">
                  <input className="cl-input" placeholder="Role name (e.g. Main consultor)" value={role.name} onChange={(e) => patchRole(role.id, { name: e.target.value })} />
                  <button className="cl-remove" onClick={() => removeRole(role.id)} aria-label="Remove role">×</button>
                </div>
                <div className="ncm-tax-row" style={{ marginBottom: 6 }}>
                  <span className="ncm-tax-label">Counts for the consultant's billing</span>
                  <button type="button" role="switch" aria-checked={role.countsForTarget}
                    className={`ncm-switch ${role.countsForTarget ? "on" : ""}`}
                    onClick={() => patchRole(role.id, { countsForTarget: !role.countsForTarget })}>
                    <span className="ncm-switch-knob" />
                  </button>
                </div>
                <p className="cl-hint" style={{ margin: "0 0 12px" }}>
                  {role.countsForTarget
                    ? "Time on this role adds to the consultant's billing target and bonus."
                    : "Time on this role is billed to the client but doesn't add to the consultant's target or bonus (a connector, for example)."}
                </p>
                <div className="cat-role-colors" role="radiogroup" aria-label="Colour">
                  <span className="ncm-tax-label">Colour</span>
                  {ROLE_COLORS.map((c) => (
                    <button key={c} type="button" role="radio" aria-checked={roleColor(role, roles.indexOf(role)) === c} aria-label={c}
                      className={roleColor(role, roles.indexOf(role)) === c ? "is-on" : ""} style={{ background: c }}
                      onClick={() => patchRole(role.id, { color: c })} />
                  ))}
                </div>
                <div className="cs-chips">
                  {role.userIds.length === 0 && <span className="cl-hint">No people assigned.</span>}
                  {role.userIds.map((uidv) => (
                    <span className="cs-chip" key={uidv}>{userName(uidv)}<button onClick={() => removePerson(role.id, uidv)} aria-label="Remove person">×</button></span>
                  ))}
                </div>
                <div className="cs-role-add">
                  <Select value="" onChange={(v) => v && addPerson(role.id, v)} options={unassigned.map((u) => ({ value: u.id, label: u.name }))} placeholder="+ Assign person" />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {sub === "worktypes" && (
        <div className="cs-roles">
          <button className="cl-add cs-add-bp" onClick={addWorkType}>+ New type of work</button>
          <p className="cl-hint" style={{ margin: "0 0 12px" }}>
            These are the options people pick when logging work in the calendar. A
            client-related type asks for a client, a project and a phase.
          </p>
          {workTypes.length === 0 && <p className="cl-hint">No types of work yet.</p>}
          {workTypes.map((w) => (
            <div className="cat-wt" key={w.id}>
              <label className="cat-wt-swatch" style={{ background: w.color }}>
                <input type="color" value={w.color} onChange={(e) => patchWorkType(w.id, { color: e.target.value })} />
              </label>
              <input className="cl-input cat-wt-name" placeholder="Type name (e.g. Client work, Internal, Training)"
                value={w.name} onChange={(e) => patchWorkType(w.id, { name: e.target.value })} />
              <div className="cat-wt-toggle">
                <span>Client related</span>
                <button type="button" role="switch" aria-checked={w.clientRelated}
                  className={`ncm-switch ${w.clientRelated ? "on" : ""}`}
                  onClick={() => patchWorkType(w.id, { clientRelated: !w.clientRelated })}>
                  <span className="ncm-switch-knob" />
                </button>
              </div>
              <button className="cl-remove" onClick={() => removeWorkType(w.id)} aria-label="Remove type">×</button>
            </div>
          ))}
        </div>
      )}

      {sub === "blueprints" && (
        <div className="cs-blueprints">
          <button className="cl-add cs-add-bp" onClick={addBlueprint}>+ New blueprint</button>
          {blueprints.length === 0 && <p className="cl-hint">No blueprints yet.</p>}
          {blueprints.map((bp) => {
            const phaseTotal = bp.phases.reduce((s, p) => s + (Number(p.percent) || 0), 0);
            if (openId !== bp.id) {
              return (
                <button className="cs-bp-row" key={bp.id} onClick={() => setOpenId(bp.id)}>
                  <div className="cs-bp-row-main">
                    <span className="cs-bp-row-name">{bp.name || "Untitled blueprint"}</span>
                    <span className="cs-bp-row-type">{bp.phases.length} phase{bp.phases.length !== 1 ? "s" : ""}</span>
                  </div>
                  <span className={`cs-total ${phaseTotal === 100 ? "ok" : ""}`}>{phaseTotal}%</span>
                  <Chevron dir="right" />
                </button>
              );
            }
            return (
              <div className="cs-bp" key={bp.id}>
                <div className="cs-bp-bar cs-bp-bar-edit">
                  <input className="cs-bp-nameinput" placeholder="Untitled blueprint" value={bp.name}
                    onChange={(e) => patchBp(bp.id, { name: e.target.value })} />
                  <button className="cl-remove cs-bp-del" onClick={() => removeBp(bp.id)} aria-label="Remove blueprint">×</button>
                  <button className="cs-bp-collapse" onClick={() => setOpenId(null)} aria-label="Collapse"><Chevron dir="up" /></button>
                </div>
                <div className="cs-phases-head">
                  <span className="cs-label">Phases</span>
                  <span className={`cs-total ${phaseTotal === 100 ? "ok" : ""}`}>{phaseTotal}% / 100</span>
                </div>
                {bp.phases.length === 0 && <p className="cl-hint cs-empty">No phases yet — add the first one below.</p>}
                {bp.phases.map((ph, i) => (
                  <div className="cs-phase" key={ph.id}>
                    <div className="cs-phase-head">
                      <span className="cs-phase-num">{i + 1}</span>
                      <input className="cl-input cs-phase-name" placeholder="Phase name" value={ph.name} onChange={(e) => patchPhase(bp.id, ph.id, { name: e.target.value })} />
                      <div className="cs-pct-wrap">
                        <input type="number" min="0" max="100" className="cl-input cs-pct cat-nospin" value={ph.percent}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => patchPhase(bp.id, ph.id, { percent: Number(e.target.value) || 0 })} />
                        <span className="cs-pct-sign">%</span>
                      </div>
                      <button className="cl-remove" onClick={() => removePhase(bp.id, ph.id)} aria-label="Remove phase">×</button>
                    </div>
                    <div className="cs-tasks">
                      {ph.tasks.map((t) => (
                        <div className="cs-task" key={t.id}>
                          <span className="cs-task-dot" />
                          <input className="cl-input" placeholder="Task name" value={t.name} onChange={(e) => patchTask(bp.id, ph.id, t.id, e.target.value)} />
                          <button className="cl-remove" onClick={() => removeTask(bp.id, ph.id, t.id)} aria-label="Remove task">×</button>
                        </div>
                      ))}
                      <div className="cs-task-foot"><button className="cl-add" onClick={() => addTask(bp.id, ph.id)}>+ Add task</button></div>
                    </div>
                  </div>
                ))}
                <button className="cl-add cs-add-phase" onClick={() => addPhase(bp.id)}>+ Add phase</button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}