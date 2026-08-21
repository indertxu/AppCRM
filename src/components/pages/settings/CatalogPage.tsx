/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../api/supabase";
import {
  loadProducts, loadServices, saveProduct, deleteProduct, saveService, deleteService,
  type Product, type Service, type ProductTier, type ServiceRole, type TierDuration,
} from "./catalogApi";
import {
  loadBlueprintData, saveBlueprintData,
  type Blueprint, type ProjectType, type ClientRole, type BlueprintPhase,
} from "./blueprintsApi";
import Select from "../../framework/Select";
import "../clients/ClientsPage.css";
import "./CatalogPage.css";

interface Props { onBack: () => void; }

type Tab = "products" | "services" | "blueprints";

const money = (n: number) => `€${(Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export default function CatalogPage({ onBack }: Props) {
  const [tab, setTab] = useState<Tab>("products");
  const [products, setProducts] = useState<Product[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [roles, setRoles] = useState<ClientRole[]>([]);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingService, setEditingService] = useState<Service | null>(null);

  const reload = async () => {
    setProducts(await loadProducts().catch(() => []));
    setServices(await loadServices().catch(() => []));
    const bp = await loadBlueprintData().catch(() => null);
    if (bp) { setBlueprints(bp.blueprints); setRoles(bp.roles); }
  };
  useEffect(() => { reload(); }, []);

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name || "Role";

  const newProduct = (): Product => ({
    name: "", kind: "saas", billing: "recurring", billing_period: "monthly", description: "", active: true,
    tiers: [{ name: "Standard", price: 0, sort: 0, durations: [] }],
  });
  const newService = (): Service => ({
    name: "", rate_unit: "hour", description: "", active: true,
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
                  <span className={`cat-prod-icon ${p.kind}`}>
                    {p.kind === "saas" ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 10a6 6 0 0 0-11.3-2.7A4.5 4.5 0 0 0 7 16h11a4 4 0 0 0 0-8z" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 7v10l9 4 9-4V7" /><path d="M12 11v10" />
                      </svg>
                    )}
                  </span>
                  <span className="cat-prod-info">
                    <span className="cat-prod-name">{p.name || "Untitled product"}</span>
                    <span className="cat-svc-meta">
                      <span className={`cat-pill ${p.kind}`}>{p.kind === "saas" ? "SaaS" : "Physical"}</span>
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
                      <span className="cat-svc-count">{s.roles.length} role{s.roles.length !== 1 ? "s" : ""}</span>
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
function ProductEditor({ product, onClose, onSaved, onDeleted }: {
  product: Product; onClose: () => void; onSaved: () => void; onDeleted: () => void;
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
          <button className="cat-x" onClick={onClose}>×</button>
        </div>

        <div className="cat-modal-body">
          <div className="cat-field">
            <label>Product name</label>
            <input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Analytics Suite" />
          </div>

          <div className="cat-field-row">
            <div className="cat-field">
              <label>Type</label>
              <div className="cat-seg">
                <button className={p.kind === "saas" ? "on" : ""} onClick={() => set({ kind: "saas" })}>SaaS</button>
                <button className={p.kind === "physical" ? "on" : ""} onClick={() => set({ kind: "physical" })}>Physical</button>
              </div>
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
                  <input type="number" min="0" value={t.price} onChange={(e) => setTier(ti, { price: Number(e.target.value) || 0 })} />
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
                          <input type="number" min="1" value={d.months} onChange={(e) => setDuration(ti, di, { months: Number(e.target.value) || 1 })} />
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

// ============================ Service editor ============================
function ServiceEditor({ service, blueprints, roles, onClose, onSaved, onDeleted }: {
  service: Service; blueprints: Blueprint[]; roles: ClientRole[]; onClose: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const [s, setS] = useState<Service>(service);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Service>) => setS((x) => ({ ...x, ...patch }));

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name || "Role";
  const usedRoleIds = new Set(s.roles.map((r) => r.role_id));
  const available = roles.filter((r) => !usedRoleIds.has(r.id));

  const addRole = (roleId: string) =>
    setS((x) => ({ ...x, roles: [...x.roles, { role_id: roleId, price: 0, sort: x.roles.length }] }));
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
          <button className="cat-x" onClick={onClose}>×</button>
        </div>

        <div className="cat-modal-body">
          <div className="cat-field">
            <label>Service name</label>
            <input value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Consulting" />
          </div>

          <div className="cat-field">
            <label>Billed per</label>
            <div className="cat-seg">
              <button className={s.rate_unit === "hour" ? "on" : ""} onClick={() => set({ rate_unit: "hour" })}>Hour</button>
              <button className={s.rate_unit === "day" ? "on" : ""} onClick={() => set({ rate_unit: "day" })}>Day</button>
            </div>
          </div>

          <div className="cat-field">
            <label>Blueprint (optional)</label>
            <Select
              value={s.blueprint_id ?? ""}
              onChange={(v) => set({ blueprint_id: v || null })}
              placeholder="— No blueprint —"
              options={[{ value: "", label: "— No blueprint —" }, ...blueprints.map((b) => ({ value: b.id, label: b.name || "Untitled blueprint" }))]}
            />
            <span className="cat-hint">Assign a phase blueprint to structure engagements for this service.</span>
          </div>

          <div className="cat-tiers-head">
            <span className="cat-eyebrow">Roles &amp; rates</span>
          </div>

          {roles.length === 0 ? (
            <p className="cat-hint">No roles yet. Create roles in the Blueprints tab first, then assign their rates here.</p>
          ) : (
            <>
              {s.roles.length === 0 && <p className="cat-hint" style={{ marginBottom: 10 }}>No roles assigned yet. Add one below.</p>}
              {s.roles.map((r, ri) => (
                <div key={ri} className="cat-tier">
                  <div className="cat-tier-row">
                    <span className="cat-role-name">{roleName(r.role_id)}</span>
                    <div className="cat-price-input">
                      <span>€</span>
                      <input type="number" min="0" value={r.price} onChange={(e) => setRolePrice(ri, Number(e.target.value) || 0)} />
                      <em>/{s.rate_unit[0]}</em>
                    </div>
                    <button className="cat-tier-del" onClick={() => removeRole(ri)} aria-label="Remove role">×</button>
                  </div>
                </div>
              ))}
              {available.length > 0 && (
                <div className="cat-add-role">
                  <Select
                    value=""
                    onChange={(v) => v && addRole(v)}
                    placeholder="+ Add role"
                    options={available.map((r) => ({ value: r.id, label: r.name || "Untitled role" }))}
                  />
                </div>
              )}
            </>
          )}

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
  const [sub, setSub] = useState<"blueprints" | "roles">("blueprints");
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
    setSaving(false);
    skipDirty.current = true;   // the reload below shouldn't count as a new edit
    setSavedAt(Date.now());
    onChanged();
  };

  // roles
  const addRole = () => { const id = uid(); setRoles((r) => [...r, { id, name: "", userIds: [], isSupervision: false }]); setOpenRoleId(id); };
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
                    <span className="cs-bp-row-name">{role.name || "Untitled role"}</span>
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
                <div className="ncm-tax-row" style={{ marginBottom: 12 }}>
                  <span className="ncm-tax-label">Paid at supervision rate</span>
                  <button type="button" role="switch" aria-checked={role.isSupervision}
                    className={`ncm-switch ${role.isSupervision ? "on" : ""}`}
                    onClick={() => patchRole(role.id, { isSupervision: !role.isSupervision })}>
                    <span className="ncm-switch-knob" />
                  </button>
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