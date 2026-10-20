/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../api/supabase";
import {
  loadProducts, loadServices, saveProduct, deleteProduct, saveService, deleteService,
  type Product, type Service, type ProductTier, type TierDuration,
  calcTotal, emptyCalculator, emptyCalcVariable,
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

      {tab === "products" ? (
        <section className="cat-body">
          <div className="cat-list-head">
            <span className="cat-eyebrow">Your products</span>
            <button className="cat-add" onClick={() => setEditingProduct(newProduct())}>+ New product</button>
          </div>
          {products.length === 0 ? (
            <p className="cat-empty">No products yet. Create one to define its tiers and pricing.</p>
          ) : (
            <div className="cat-grid">
              {products.map((p) => (
                <button key={p.id} className="cat-prod-card" onClick={() => setEditingProduct(structuredClone(p))}>
                  <span className={`cat-prod-icon ${kindClass(p.kind)}`} style={{ ["--kc" as any]: kindColor(p.kind) }}>
                    <KindIcon kind={p.kind} />
                  </span>
                  <span className="cat-prod-info">
                    <span className="cat-prod-name">{p.name || "Untitled product"}</span>
                    <span className="cat-svc-meta">
                      <span className="cat-pill is-kind" style={{ ["--kc" as any]: kindColor(p.kind) }}>{kindLabel(p.kind, kinds)}</span>
                      {p.in_proposals === false && <NotInProposals />}
                      <span className="cat-svc-count">
                        {p.billing === "recurring" ? (p.billing_period === "yearly" ? "Yearly" : "Monthly") : "One-time"} · {p.tiers.length} tier{p.tiers.length !== 1 ? "s" : ""}
                      </span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : tab === "services" ? (
        <section className="cat-body">
          <div className="cat-list-head">
            <span className="cat-eyebrow">Your services</span>
            <button className="cat-add" onClick={() => setEditingService(newService())}>+ New service</button>
          </div>
          {services.length === 0 ? (
            <p className="cat-empty">No services yet. Create one to set hourly or daily rates.</p>
          ) : (
            <div className="cat-grid">
              {services.map((s) => (
                <button key={s.id} className="cat-svc-card" onClick={() => setEditingService(structuredClone(s))}>
                  <span className="cat-svc-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="7" width="18" height="13" rx="2" />
                      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M3 12h18" />
                    </svg>
                  </span>
                  <span className="cat-svc-info">
                    <span className="cat-svc-name">{s.name || "Untitled service"}</span>
                    <span className="cat-svc-meta">
                      <span className="cat-pill svc">per {s.rate_unit}</span>
                      <span className="cat-svc-min">min {s.min_unit ?? (s.rate_unit === "hour" ? 0.5 : 0.25)}{s.rate_unit === "hour" ? "h" : "d"}</span>
                      <span className="cat-svc-count">{s.roles.length} role{s.roles.length !== 1 ? "s" : ""}</span>
                      {s.in_proposals === false && <NotInProposals />}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
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
          onSaved={async () => { setEditingProduct(null); await reload(); }}
          onDeleted={async () => { setEditingProduct(null); await reload(); }}
        />
      )}
      {editingService && (
        <ServiceEditor
          service={editingService}
          blueprints={blueprints}
          roles={roles}
          onClose={() => setEditingService(null)}
          onSaved={async () => { setEditingService(null); await reload(); }}
          onDeleted={async () => { setEditingService(null); await reload(); }}
        />
      )}
    </div>
  );
}

// ============================ Product editor ============================
function ProductEditor({ product, kinds, kindOptions, onKindsChanged, onClose, onSaved, onDeleted }: {
  product: Product; kinds: string[]; kindOptions: CrmOption[]; onKindsChanged: () => void;
  onClose: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const [p, setP] = useState<Product>(product);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Product>) => setP((x) => ({ ...x, ...patch }));
  const perSuffix = p.billing === "recurring" ? (p.billing_period === "yearly" ? "/yr" : "/mo") : "";

  const setTier = (i: number, patch: Partial<ProductTier>) =>
    setP((x) => ({ ...x, tiers: x.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const addTier = () =>
    setP((x) => ({ ...x, tiers: [...x.tiers, { name: "", price: 0, sort: x.tiers.length, durations: [] }] }));
  const removeTier = (i: number) =>
    setP((x) => ({ ...x, tiers: x.tiers.filter((_, j) => j !== i) }));

  const addDuration = (ti: number) =>
    setTier(ti, { durations: [...p.tiers[ti].durations, { months: 12, discount_pct: 0, sort: p.tiers[ti].durations.length }] });
  const setDuration = (ti: number, di: number, patch: Partial<TierDuration>) =>
    setTier(ti, { durations: p.tiers[ti].durations.map((d, j) => (j === di ? { ...d, ...patch } : d)) });
  const removeDuration = (ti: number, di: number) =>
    setTier(ti, { durations: p.tiers[ti].durations.filter((_, j) => j !== di) });

  const save = async () => {
    if (!p.name.trim()) { setErr("Give the product a name."); return; }
    setBusy(true); setErr(null);
    const e = await saveProduct(p);
    setBusy(false);
    if (e) setErr(e); else onSaved();
  };
  const remove = async () => {
    if (!p.id) return onClose();
    if (!confirm(`Delete "${p.name}" permanently?`)) return;
    await deleteProduct(p.id);
    onDeleted();
  };

  return (
    <div className="cat-backdrop" onMouseDown={onClose}>
      <div className="cat-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cat-modal-head">
          <div>
            <span className="cat-modal-eyebrow">{p.id ? "Edit product" : "New product"}</span>
            <h2 className="cat-modal-title">{p.name || "Untitled product"}</h2>
          </div>
          <div className="cat-head-right">
            <ProposalSwitch on={p.in_proposals !== false} onChange={(v) => set({ in_proposals: v })} />
            <button className="cat-x" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="cat-modal-body">
          <div className="cat-field">
            <label>Product name</label>
            <input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Analytics Suite" />
          </div>

          <div className="cat-field-row">
            <div className="cat-field">
              <label>Type</label>
              <KindPicker value={p.kind} kinds={kinds} options={kindOptions} onChange={(k) => set({ kind: k })} onKindsChanged={onKindsChanged} />
            </div>
            <div className="cat-field">
              <label>Billing</label>
              <div className="cat-seg">
                <button className={p.billing === "recurring" ? "on" : ""} onClick={() => set({ billing: "recurring" })}>Recurring</button>
                <button className={p.billing === "one_time" ? "on" : ""} onClick={() => set({ billing: "one_time" })}>One-time</button>
              </div>
            </div>
          </div>

          {p.billing === "recurring" && (
            <div className="cat-field">
              <label>Billed every</label>
              <div className="cat-seg">
                <button className={(p.billing_period ?? "monthly") === "monthly" ? "on" : ""} onClick={() => set({ billing_period: "monthly" })}>Monthly</button>
                <button className={p.billing_period === "yearly" ? "on" : ""} onClick={() => set({ billing_period: "yearly" })}>Yearly</button>
              </div>
            </div>
          )}

          <div className="cat-tiers-head">
            <span className="cat-eyebrow">Tiers</span>
            <button className="cat-mini-add" onClick={addTier}>+ Add tier</button>
          </div>

          {p.tiers.map((t, ti) => (
            <div key={ti} className="cat-tier">
              <div className="cat-tier-row">
                <input className="cat-tier-name" value={t.name} onChange={(e) => setTier(ti, { name: e.target.value })} placeholder="Tier name (e.g. Pro)" />
                <div className="cat-price-input">
                  <span>€</span>
                  <input type="number" min="0" className="cat-nospin" value={t.price} onFocus={(e) => e.target.select()} onChange={(e) => setTier(ti, { price: Number(e.target.value) || 0 })} />
                  {p.billing === "recurring" && <em>{perSuffix}</em>}
                </div>
                {p.tiers.length > 1 && <button className="cat-tier-del" onClick={() => removeTier(ti)} aria-label="Remove tier">×</button>}
              </div>

              {p.billing === "recurring" && (
                <div className="cat-durations">
                  <div className="cat-durations-head">
                    <span>Contract durations (discount on longer commitment)</span>
                    <button className="cat-mini-add" onClick={() => addDuration(ti)}>+ Duration</button>
                  </div>
                  {t.durations.length === 0 ? (
                    <p className="cat-dur-empty">No durations — this tier is billed at its base price.</p>
                  ) : (
                    t.durations.map((d, di) => (
                      <div key={di} className="cat-dur-row">
                        <div className="cat-dur-field">
                          <input type="number" min="1" className="cat-nospin" value={d.months} onFocus={(e) => e.target.select()} onChange={(e) => setDuration(ti, di, { months: Number(e.target.value) || 1 })} />
                          <span>months</span>
                        </div>
                        <div className="cat-dur-field">
                          <input type="number" min="0" max="100" className="cat-nospin" value={d.discount_pct}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => setDuration(ti, di, { discount_pct: Number(e.target.value) || 0 })} />
                          <span>% off</span>
                        </div>
                        <span className="cat-dur-result">= {money(t.price * (1 - d.discount_pct / 100))}{perSuffix}</span>
                        <button className="cat-tier-del" onClick={() => removeDuration(ti, di)}>×</button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}

          <CalculatorEditor
            calc={p.calculator}
            onChange={(c) => set({ calculator: c ? { ...c, owner_type: "product" } : null })}
            ownerType="product"
            basePrice={p.tiers[0]?.price ?? 0}
            currencySuffix={perSuffix}
          />

          {err && <p className="cat-error">{err}</p>}
        </div>

        <div className="cat-modal-foot">
          {p.id && <button className="cat-delete" onClick={remove}>Delete</button>}
          <div className="cat-foot-right">
            <button className="cat-cancel" onClick={onClose}>Cancel</button>
            <button className="cat-save" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save product"}</button>
          </div>
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
  onClose: () => void; onSaved: () => void; onDeleted: () => void;
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
    if (e) setErr(e); else onSaved();
  };
  const remove = async () => {
    if (!s.id) return onClose();
    if (!confirm(`Delete "${s.name}" permanently?`)) return;
    await deleteService(s.id);
    onDeleted();
  };

  return (
    <div className="cat-backdrop" onMouseDown={onClose}>
      <div className="cat-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cat-modal-head">
          <div>
            <span className="cat-modal-eyebrow">{s.id ? "Edit service" : "New service"}</span>
            <h2 className="cat-modal-title">{s.name || "Untitled service"}</h2>
          </div>
          <div className="cat-head-right">
            <ProposalSwitch on={s.in_proposals !== false} onChange={(v) => setS((x) => ({ ...x, in_proposals: v }))} />
            <button className="cat-x" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="cat-modal-body">
          <section className="cat-sec">
            <p className="cat-sec-title">Service</p>
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
          </section>

          <section className="cat-sec">
            <p className="cat-sec-title">Delivery</p>
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
          </section>

          <section className="cat-sec">
            <div className="cat-sec-head">
              <p className="cat-sec-title">Roles and rates</p>
              {s.roles.length > 0 && (
                <span className="cat-sec-count">{s.roles.length} of {roles.length}</span>
              )}
            </div>

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
          </section>

          <section className="cat-sec">
          <CalculatorEditor
            calc={s.calculator}
            onChange={(c) => set({ calculator: c ? { ...c, owner_type: "service" } : null })}
            ownerType="service"
            basePrice={0}
            unit={s.rate_unit}
            rates={s.roles.filter((r) => r.role_id).map((r, k) => ({ id: r.role_id, label: roleName(r.role_id) || "Role", price: Number(r.price) || 0, main: s.roles.some((x) => x.is_main) ? !!r.is_main : k === 0 }))}
            allRoles={roles}
          />
          </section>

          {err && <p className="cat-error">{err}</p>}
        </div>

        <div className="cat-modal-foot">
          {s.id && <button className="cat-delete" onClick={remove}>Delete</button>}
          <div className="cat-foot-right">
            <button className="cat-cancel" onClick={onClose}>Cancel</button>
            <button className="cat-save" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save service"}</button>
          </div>
        </div>
      </div>
    </div>
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