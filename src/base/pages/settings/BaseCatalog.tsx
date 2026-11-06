/* =====================================================================
   BASE · Settings › Products & Services — one simple page.
   Every product is a card you edit in place: name, kind (your own list,
   editable right there), how it bills (recurring every month / year, or
   one time) and its price — one price, or several tiers with a price each.
   Nothing else: no description, no "where it shows up", no commitment
   discounts, no calculator. Whatever the full app keeps on a product
   (description, proposals switch, multi-year terms, tier durations,
   calculator) is carried along untouched when a card is saved, so a
   company moved back to Enterprise finds it all.
   ===================================================================== */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../../components/api/supabase";
import { loadProducts, saveProduct, deleteProduct, type Product, type ProductTier } from "./catalogApi";
import { listCrmOptions, addCrmOption, deleteCrmOption, renameCrmOption, productKindOptions, type CrmOption } from "../companies/companiesApi";
import { loadBaseServices, type BaseService } from "./baseServicesApi";
import { ServiceCard, ServiceModal, SERVICE_COLOR } from "./BaseServices";
import NewWalkthrough from "./NewWalkthrough";
import "./CatalogPage.css";
import "./BaseCatalog.css";

const kindKey = (k: string | null | undefined) => String(k ?? "").trim().toLowerCase();
const KIND_HUES = ["#d1685f", "#c9973a", "#7c5cd6", "#2f9e8f", "#d0628f", "#5b7fd6", "#8a6d3b", "#4f9b4a"];
const kindColor = (k: string | null | undefined) => {
  const key = kindKey(k);
  if (key === "saas") return "#12b57f";
  if (key === "physical") return "#3c7fb8";
  let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return KIND_HUES[h % KIND_HUES.length];
};
const kindLabel = (k: string | null | undefined, kinds: string[]) =>
  kinds.find((o) => kindKey(o) === kindKey(k)) ?? (kindKey(k) === "saas" ? "SaaS" : String(k ?? "").trim() || "No kind");
const unitOf = (p: Product) => (p.billing === "one_time" ? "one time" : p.billing_period === "yearly" ? "/ year" : p.billing_period === "weekly" ? "/ week" : "/ month");
const snap = (p: Product) => JSON.stringify({ n: p.name, k: p.kind, b: p.billing, bp: p.billing_period, t: p.tiers.map((t) => [t.name, Number(t.price) || 0]) });

const I = {
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  x: "M6 6l12 12M18 6L6 18",
  pen: "M4 20h4L19 9l-4-4L4 16v4z",
  check: "M5 12.5l4.2 4.2L19 7",
  chev: "M6 9l6 6 6-6",
  box: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  steps: "M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10",
};
const Ico = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

export default function BaseCatalog({ onBack }: { onBack: () => void }) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [opts, setOpts] = useState<CrmOption[]>([]);
  /** New cards not saved yet (newest first), by a key of their own. */
  const [fresh, setFresh] = useState<{ key: string; p: Product }[]>([]);
  const seq = useRef(0);
  const kinds = productKindOptions(opts);
  const kindOptions = useMemo(() => opts.filter((o) => o.kind === "product_kind"), [opts]);
  const reloadKinds = async () => setOpts(await listCrmOptions().catch(() => []));
  const [services, setServices] = useState<BaseService[] | null>(null);
  /** The service open in its pop-up (a new one has no id). */
  const [svc, setSvc] = useState<BaseService | null>(null);
  useEffect(() => {
    void reloadKinds();
    loadProducts().then(setProducts).catch(() => setProducts([]));
    loadBaseServices().then(setServices).catch(() => setServices([]));
  }, []);
  /** "New": first what you're creating — a product or a service. */
  const [choosing, setChoosing] = useState(false);
  /** A new one starts with the walkthrough (closing it carries on in the usual editor). */
  const [walk, setWalk] = useState<"product" | "service" | null>(null);
  const total = (products?.length ?? 0) + fresh.length + (services?.length ?? 0);
  const loading = products === null || services === null;

  return (
    <div className="cat bc">
      <header className="cat-head bc-head">
        <button className="cat-back" onClick={onBack} aria-label="Back">‹</button>
        <div className="bc-head-txt">
          <h1 className="cat-title">Products &amp; Services</h1>
          <p className="bc-sub">What you sell and how it bills: products with their price, services with their steps.</p>
        </div>
        <NewMenu open={choosing} onOpen={setChoosing} onProduct={() => { setChoosing(false); setWalk("product"); }} onService={() => { setChoosing(false); setWalk("service"); }} />
      </header>

      {loading ? (
        <div className="bc-cols" aria-busy="true">{[0, 1].map((c) => <div key={c} className="bc-list">{[0, 1, 2].map((i) => <div key={i} className="bc-row is-ghost" />)}</div>)}</div>
      ) : total === 0 ? (
        <div className="bc-start">
          <h2>Add your first product or service</h2>
          <p>Pick what you want to create first — you can add the other one any time.</p>
          <div className="bc-start-pick">
            <Choice kind="product" onClick={() => setWalk("product")} />
            <Choice kind="service" onClick={() => setWalk("service")} />
          </div>
        </div>
      ) : (
        <div className="bc-cols">
          <section className="bc-col" style={{ ["--kc" as string]: "#12b57f" }}>
            <header className="bc-col-h">
              <span className="bc-col-ico"><Ico d={I.box} s={16} /></span>
              <div><b>Products</b><small>{(products?.length ?? 0) + fresh.length} · priced once, weekly, monthly or yearly</small></div>
              <button type="button" className="bc-col-add" onClick={() => setWalk("product")}><Ico d={I.plus} s={14} />Product</button>
            </header>
            <div className="bc-list">
              {fresh.map(({ key, p }) => (
                <ProductCard key={key} product={p} isNew kinds={kinds} kindOptions={kindOptions} onKindsChanged={reloadKinds}
                  onSaved={(saved) => { setFresh((f) => f.filter((x) => x.key !== key)); setProducts((ps) => [saved, ...(ps ?? [])]); }}
                  onDeleted={() => setFresh((f) => f.filter((x) => x.key !== key))} />
              ))}
              {products.map((p) => (
                <ProductCard key={p.id} product={p} kinds={kinds} kindOptions={kindOptions} onKindsChanged={async () => {
                  await reloadKinds();
                  setProducts(await loadProducts().catch(() => products));   // a renamed kind renames it on the products too
                }}
                  onSaved={(saved) => setProducts((ps) => (ps ?? []).map((x) => (x.id === saved.id ? saved : x)))}
                  onDeleted={() => setProducts((ps) => (ps ?? []).filter((x) => x.id !== p.id))} />
              ))}
              {!products.length && !fresh.length && <button type="button" className="bc-empty" onClick={() => setWalk("product")}><Ico d={I.plus} s={15} />Add your first product</button>}
            </div>
          </section>
          <section className="bc-col" style={{ ["--kc" as string]: SERVICE_COLOR }}>
            <header className="bc-col-h">
              <span className="bc-col-ico"><Ico d={I.steps} s={16} /></span>
              <div><b>Services</b><small>{services?.length ?? 0} · work you deliver, in steps</small></div>
              <button type="button" className="bc-col-add" onClick={() => setWalk("service")}><Ico d={I.plus} s={14} />Service</button>
            </header>
            <div className="bc-list">
              {(services ?? []).map((sv) => <ServiceCard key={sv.id} service={sv} onOpen={() => setSvc(sv)} />)}
              {!services?.length && <button type="button" className="bc-empty" onClick={() => setWalk("service")}><Ico d={I.plus} s={15} />Add your first service</button>}
            </div>
          </section>
        </div>
      )}

      {walk && (
        <NewWalkthrough kind={walk} kinds={kinds} onClose={() => setWalk(null)}
          onSkipProduct={(p) => setFresh((f) => [{ key: `new-${++seq.current}`, p }, ...f])}
          onSkipService={(sv) => setSvc(sv)}
          onCreatedProduct={(p) => setProducts((ps) => [p, ...(ps ?? []).filter((x) => x.id !== p.id)])}
          onCreatedService={(sv) => setServices((list) => [...(list ?? []), sv])} />
      )}
      {svc && (
        <ServiceModal key={svc.id ?? "new"} service={svc} onClose={() => setSvc(null)}
          onSaved={(saved) => {
            setServices((list) => (list ?? []).some((x) => x.id === saved.id) ? (list ?? []).map((x) => (x.id === saved.id ? saved : x)) : [...(list ?? []), saved]);
            setSvc(null);
          }}
          onDeleted={() => { setServices((list) => (list ?? []).filter((x) => x.id !== svc.id)); setSvc(null); }} />
      )}
    </div>
  );
}

const CHOICE = {
  product: { color: "#12b57f", icon: I.box, title: "Product", text: "Something you sell at a price: software, a licence, a box. Once, or every month or year." },
  service: { color: SERVICE_COLOR, icon: I.steps, title: "Service", text: "Work you deliver in steps. Billed upfront, by step, monthly, or by the hour or day." },
};
/** One of the two big choices (empty page, and the New menu). */
function Choice({ kind, onClick, compact = false }: { kind: "product" | "service"; onClick: () => void; compact?: boolean }) {
  const c = CHOICE[kind];
  return (
    <button type="button" className={`bc-choice ${compact ? "is-compact" : ""}`} style={{ ["--kc" as string]: c.color }} onClick={onClick}>
      <span className="bc-choice-ico"><Ico d={c.icon} s={compact ? 18 : 22} /></span>
      <span className="bc-choice-txt"><b>{c.title}</b><small>{c.text}</small></span>
    </button>
  );
}
/** "New": a small menu — Product or Service. */
function NewMenu({ open, onOpen, onProduct, onService }: { open: boolean; onOpen: (o: boolean) => void; onProduct: () => void; onService: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="bc-newwrap" ref={box}>
      <button type="button" className={`bc-new ${open ? "is-open" : ""}`} onClick={() => onOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <Ico d={I.plus} s={15} />New<Ico d={I.chev} s={14} />
      </button>
      {open && (
        <div className="bc-newmenu" role="menu" aria-label="What do you want to create?">
          <span className="bc-newmenu-h">What do you want to create?</span>
          <Choice compact kind="product" onClick={onProduct} />
          <Choice compact kind="service" onClick={onService} />
        </div>
      )}
    </div>
  );
}

// ============================ one product ============================
function ProductCard({ product, isNew = false, kinds, kindOptions, onKindsChanged, onSaved, onDeleted }: {
  product: Product; isNew?: boolean; kinds: string[]; kindOptions: CrmOption[];
  onKindsChanged: () => void | Promise<void>; onSaved: (p: Product) => void; onDeleted: () => void;
}) {
  const [p, setP] = useState<Product>(() => structuredClone(product));
  const [base, setBase] = useState(() => snap(product));
  // a new copy of the product from the page (after a save, or a reload because a kind changed): take it only
  // when it really is different from what this card started from — your unsaved edits stay otherwise
  useEffect(() => {
    if (snap(product) === base) return;
    setP(structuredClone(product)); setBase(snap(product));
  }, [product]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = isNew || snap(p) !== base;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [askDel, setAskDel] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (isNew) nameRef.current?.focus(); }, [isNew]);

  const set = (patch: Partial<Product>) => { setP((x) => ({ ...x, ...patch })); setErr(null); };
  const setTier = (i: number, patch: Partial<ProductTier>) => set({ tiers: p.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const addTier = () => {
    const names = ["Basic", "Pro", "Enterprise", "Premium", "Ultimate"];
    const tiers = p.tiers.length === 1 && p.tiers[0].name === "Standard" ? [{ ...p.tiers[0], name: "Basic" }] : p.tiers;
    const name = names.find((n) => !tiers.some((t) => t.name === n)) ?? `Tier ${tiers.length + 1}`;
    set({ tiers: [...tiers, { name, price: 0, sort: tiers.length, durations: [] }] });
  };
  const removeTier = (i: number) => {
    const tiers = p.tiers.filter((_, j) => j !== i);
    set({ tiers: tiers.length === 1 && !tiers[0].name.trim() ? [{ ...tiers[0], name: "Standard" }] : tiers });
  };

  const save = async () => {
    if (!p.name.trim()) { setErr("Give the product a name."); nameRef.current?.focus(); return; }
    if (p.tiers.length > 1 && p.tiers.some((t) => !t.name.trim())) { setErr("Every tier needs a name."); return; }
    setBusy(true);
    const clean: Product = { ...p, name: p.name.trim(), tiers: p.tiers.map((t, i) => ({ ...t, name: t.name.trim() || "Standard", price: Number(t.price) || 0, sort: i })) };
    const msg = await saveProduct(clean);
    setBusy(false);
    if (msg && !/^Saved, but/.test(msg)) { setErr(msg); return; }
    // read it back (the product's id and its new tiers)
    const fresh = (await loadProducts().catch(() => [])).find((x) => (clean.id ? x.id === clean.id : x.name === clean.name && x.kind === clean.kind));
    const saved = fresh ?? clean;
    setBase(snap(saved)); setSavedAt(Date.now());
    onSaved(saved);
  };
  const discard = () => { if (isNew) { onDeleted(); return; } setP(structuredClone(product)); setErr(null); };
  const remove = async () => {
    if (isNew || !p.id) { onDeleted(); return; }
    setBusy(true);
    const msg = await deleteProduct(p.id);
    setBusy(false);
    if (msg) { setErr(/foreign|violates|referenc/i.test(msg) ? "It's used on clients or deals, so it can't be deleted." : msg); setAskDel(false); return; }
    onDeleted();
  };
  const justSaved = savedAt > 0 && Date.now() - savedAt < 2400 && !dirty;
  useEffect(() => { if (!savedAt) return; const t = window.setTimeout(() => setSavedAt(0), 2400); return () => window.clearTimeout(t); }, [savedAt]);

  const mode: "weekly" | "monthly" | "yearly" | "one_time" = p.billing === "one_time" ? "one_time" : p.billing_period === "yearly" ? "yearly" : p.billing_period === "weekly" ? "weekly" : "monthly";
  const setMode = (m: typeof mode) => set(m === "one_time" ? { billing: "one_time" } : { billing: "recurring", billing_period: m });
  const tiered = p.tiers.length > 1;
  const initials = p.name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  const unit = unitOf(p);
  const [open, setOpen] = useState(isNew);
  if (!open && !dirty && !err) {
    const prices = p.tiers.map((t) => Number(t.price) || 0);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return (
      <button type="button" className="bc-row" style={{ ["--kc" as string]: kindColor(p.kind) }} onClick={() => setOpen(true)} aria-expanded={false}>
        <span className="bc-row-tile" aria-hidden="true">{initials || <Ico d={I.box} s={16} />}</span>
        <span className="bc-row-main">
          <b>{p.name || "Untitled product"}</b>
          <span className="bc-row-tags"><em className="is-kind"><i />{kindLabel(p.kind, kinds)}</em><em>{mode === "one_time" ? "One time" : mode === "yearly" ? "Yearly" : mode === "weekly" ? "Weekly" : "Monthly"}</em>{tiered && <em>{p.tiers.length} tiers</em>}</span>
        </span>
        <span className="bc-row-viz" aria-hidden="true">
          {p.tiers.map((t, i) => <i key={i} style={{ height: `${hi ? Math.max(18, ((Number(t.price) || 0) / hi) * 100) : 18}%`, ["--i" as string]: i }} title={t.name} />)}
        </span>
        <span className="bc-row-price"><b>€{fmt(lo)}{hi !== lo ? `–${fmt(hi)}` : ""}</b><small>{unit}</small></span>
        <span className="bc-row-chev" aria-hidden="true"><Ico d={I.chev} s={16} /></span>
      </button>
    );
  }
  return (
    <section className={`bc-card is-open ${dirty ? "is-dirty" : ""} ${isNew ? "is-new" : ""} ${askDel ? "is-asking" : ""}`} style={{ ["--kc" as string]: kindColor(p.kind) }}
      onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && dirty) { e.preventDefault(); void save(); } }}>
      <div className="bc-band" aria-hidden="true" />

      <header className="bc-hd">
        <span className="bc-tile" aria-hidden="true">{initials || <Ico d={I.box} s={20} />}</span>
        <div className="bc-hd-txt">
          <input ref={nameRef} className={`bc-name ${err && !p.name.trim() ? "is-err" : ""}`} value={p.name} placeholder="Product name"
            onChange={(e) => set({ name: e.target.value })} aria-label="Product name" />
          <KindMenu value={p.kind} kinds={kinds} options={kindOptions} onChange={(k) => set({ kind: k })} onKindsChanged={onKindsChanged} />
        </div>
        <div className="bc-hd-tools">
          {!isNew && !dirty && !askDel && <button type="button" className="bc-icon-btn is-fold" onClick={() => setOpen(false)} aria-label="Collapse" title="Collapse"><Ico d={I.chev} s={15} /></button>}
          {askDel ? (
            <span className="bc-del-ask">
              <button type="button" className="is-yes" onClick={remove} disabled={busy}>Delete</button>
              <button type="button" onClick={() => setAskDel(false)}>Keep</button>
            </span>
          ) : (
            <button type="button" className="bc-icon-btn" onClick={() => (isNew ? onDeleted() : setAskDel(true))} aria-label={isNew ? "Discard" : "Delete product"} title={isNew ? "Discard" : "Delete"}>
              <Ico d={isNew ? I.x : I.trash} s={15} />
            </button>
          )}
        </div>
      </header>

      <div className="bc-bill" role="radiogroup" aria-label="Billing" style={{ ["--b" as string]: ["weekly", "monthly", "yearly", "one_time"].indexOf(mode) }}>
        <span className="bc-bill-light" aria-hidden="true" />
        {([["weekly", "Weekly"], ["monthly", "Monthly"], ["yearly", "Yearly"], ["one_time", "One time"]] as const).map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "is-on" : ""} onClick={() => setMode(m)}>{label}</button>
        ))}
      </div>

      {tiered ? (
        <div className="bc-tiers-wrap">
        <div className="bc-tiers-h">
          <span>{p.tiers.length} tiers</span>
          <button type="button" className="bc-link" onClick={addTier}><Ico d={I.plus} s={13} />Add tier</button>
        </div>
        <div className="bc-tiers" role="list" aria-label="Tiers" style={{ ["--n" as string]: p.tiers.length }}>
          {p.tiers.map((t, i) => (
            <div key={i} role="listitem" className="bc-tier" style={{ ["--i" as string]: i }}>
              <div className="bc-tier-top">
                <input className="bc-tier-name" value={t.name} placeholder="Tier name" onChange={(e) => setTier(i, { name: e.target.value })} aria-label="Tier name" />
                <button type="button" className="bc-tier-x" onClick={() => removeTier(i)} aria-label={`Remove ${t.name || "tier"}`} title="Remove tier"><Ico d={I.x} s={12} /></button>
              </div>
              <Money size="tile" value={t.price} onChange={(v) => setTier(i, { price: v })} />
              <span className="bc-tier-unit">{unit}</span>
            </div>
          ))}
        </div>
        </div>
      ) : (
        <div className="bc-hero">
          <div className="bc-hero-price">
            <Money size="hero" value={p.tiers[0]?.price ?? 0} onChange={(v) => setTier(0, { price: v })} />
            <span className="bc-hero-unit">{unit}</span>
          </div>
          <button type="button" className="bc-link" onClick={addTier}><Ico d={I.plus} s={13} />Add tiers</button>
        </div>
      )}

      <footer className={`bc-foot ${dirty || err || justSaved ? "is-shown" : ""}`}>
        {err ? <span className="bc-err">{err}</span> : justSaved ? <span className="bc-ok"><Ico d={I.check} s={14} />Saved</span> : <span className="bc-hint">Unsaved changes</span>}
        {dirty && (
          <span className="bc-foot-act">
            <button type="button" className="bc-ghost" onClick={discard} disabled={busy}>{isNew ? "Cancel" : "Discard"}</button>
            <button type="button" className="bc-save" onClick={save} disabled={busy}>{busy ? "Saving…" : isNew ? "Create product" : "Save"}</button>
          </span>
        )}
      </footer>
    </section>
  );
}

/** "4.800" / "4,800" / "12,5" / "12.5" → a number (the app writes 1.234.567,5). */
const parseAmount = (raw: string) => {
  let t = raw.replace(/[^\d.,]/g, "");
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
};
const showAmount = (n: number) => (n ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "");

/** A euro amount, typed in place: formatted at rest (4.800), plain while you type. */
function Money({ value, onChange, size }: { value: number; onChange: (v: number) => void; size: "hero" | "tile" }) {
  const [txt, setTxt] = useState(() => showAmount(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setTxt(showAmount(value)); }, [value]);
  return (
    <label className={`bc-money is-${size}`}>
      <span className="bc-cur">€</span>
      <input inputMode="decimal" value={txt} placeholder="0" size={Math.max(1, (txt || "0").length)}
        onFocus={(e) => {
          // plain digits while you type, all selected at once (no frame later: the first key would be lost)
          focused.current = true;
          const raw = value ? String(value).replace(".", ",") : "";
          e.target.value = raw; e.target.select(); setTxt(raw);
        }}
        onBlur={() => { focused.current = false; setTxt(showAmount(value)); }}
        onChange={(e) => { setTxt(e.target.value); onChange(parseAmount(e.target.value)); }} aria-label="Price" />
    </label>
  );
}

// ============================ kind picker (your own list, editable here) ============================
function KindMenu({ value, kinds, options, onChange, onKindsChanged }: {
  value: string; kinds: string[]; options: CrmOption[]; onChange: (k: string) => void; onKindsChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ from: string; to: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const b = btn.current?.getBoundingClientRect();
    if (b) setPos({ top: b.bottom + 6, left: Math.min(b.left, window.innerWidth - 300) });
    const off = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) { setOpen(false); setEditing(null); } };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setEditing(null); } };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);

  /** Your list lives in crm_options; until you touch it, it's the two defaults (SaaS, Physical) — save them first. */
  const ensureStored = async (except?: string) => {
    if (options.length) return;
    for (const [i, k] of kinds.filter((k) => kindKey(k) !== kindKey(except)).entries()) await addCrmOption("product_kind", k, i);
  };
  const add = async () => {
    const label = draft.trim();
    if (!label) return;
    if (kinds.some((k) => kindKey(k) === kindKey(label))) { onChange(kinds.find((k) => kindKey(k) === kindKey(label))!); setDraft(""); setOpen(false); return; }
    await ensureStored();
    const e = await addCrmOption("product_kind", label, kinds.length);
    if (e) { setMsg(e); return; }
    setDraft(""); setMsg(null);
    await onKindsChanged();
    onChange(label); setOpen(false);
  };
  const rename = async () => {
    if (!editing) return;
    const to = editing.to.trim();
    if (!to || to === editing.from) { setEditing(null); return; }
    if (kinds.some((k) => kindKey(k) === kindKey(to) && kindKey(k) !== kindKey(editing.from))) { setMsg(`“${to}” is already on the list.`); return; }
    let e: string | null;
    const opt = options.find((o) => kindKey(o.label) === kindKey(editing.from));
    if (opt) e = await renameCrmOption(opt, to);
    else { await ensureStored(editing.from); e = await addCrmOption("product_kind", to, kinds.indexOf(editing.from)); }
    if (e) { setMsg(e); return; }
    // the products of that kind take the new name too
    await supabase.from("products").update({ kind: to }).eq("kind", editing.from);
    if (kindKey(value) === kindKey(editing.from)) onChange(to);
    setEditing(null); setMsg(null);
    await onKindsChanged();
  };
  const remove = async (k: string) => {
    await ensureStored(k);
    const opt = options.find((o) => kindKey(o.label) === kindKey(k));
    if (opt) { const e = await deleteCrmOption(opt.id); if (e) { setMsg(e); return; } }
    setMsg(null);
    await onKindsChanged();
  };

  return (
    <>
      <button ref={btn} type="button" className={`bc-kind ${open ? "is-open" : ""}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <i aria-hidden="true" />{kindLabel(value, kinds)}<Ico d={I.chev} s={13} />
      </button>
      {open && pos && createPortal(
        <div ref={pop} className="bc-kind-pop" style={{ top: pos.top, left: pos.left }} role="listbox" aria-label="Kind">
          <ul>
            {kinds.map((k) => (
              <li key={k} style={{ ["--kc" as string]: kindColor(k) }} className={kindKey(k) === kindKey(value) ? "is-on" : ""}>
                {editing && kindKey(editing.from) === kindKey(k) ? (
                  <input autoFocus onFocus={(e) => e.currentTarget.select()} value={editing.to} onChange={(e) => setEditing({ ...editing, to: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void rename(); } if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } }}
                    onBlur={() => void rename()} aria-label={`Rename ${k}`} />
                ) : (
                  <>
                    <button type="button" className="bc-kind-pick" role="option" aria-selected={kindKey(k) === kindKey(value)} onClick={() => { onChange(k); setOpen(false); }}>
                      <i aria-hidden="true" />{k}{kindKey(k) === kindKey(value) && <Ico d={I.check} s={13} />}
                    </button>
                    <button type="button" className="bc-kind-tool" onClick={() => setEditing({ from: k, to: k })} aria-label={`Rename ${k}`} title="Rename"><Ico d={I.pen} s={12} /></button>
                    {kinds.length > 1 && <button type="button" className="bc-kind-tool" onClick={() => void remove(k)} aria-label={`Remove ${k}`} title="Remove from the list"><Ico d={I.x} s={12} /></button>}
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="bc-kind-add">
            <input value={draft} placeholder="New kind…" onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }} aria-label="New kind" />
            <button type="button" disabled={!draft.trim()} onClick={() => void add()}>Add</button>
          </div>
          {msg && <p className="bc-kind-msg">{msg}</p>}
        </div>,
        document.body,
      )}
    </>
  );
}
