import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { companyPeople, globalSearch, searchContacts, type Company, type Contact } from "../../companies/companiesApi";
import { loadPipeline, type Pipeline, type Phase } from "../../settings/pipelineApi";
import type { Product } from "../../settings/catalogApi";
import { createTracking, setTrackingEmployees, setTrackingOwner } from "./salesApi";
import FieldInput from "../extras/FieldInput";
import { cleanCustom, isEmptyValue, missingRequired, type TrackingField } from "../extras/trackingFieldsApi";
import DealRolePicker from "../extras/DealRolePicker";
import { rolesFor, resolveDealRole, orderPhases, type SalesRole } from "../extras/salesRolesApi";
import { supabase } from "../../../api/supabase";
import "../extras/TrackingFields.css";

const fullName = (c: Contact) => [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Contact";
/** A few companies to pick from before typing: the newest ones. */
async function startCompanies(): Promise<{ id: string; name: string }[]> {
  const { data } = await supabase.from("companies").select("id, name").order("created_at", { ascending: false }).limit(30);
  return ((data ?? []) as { id: string; name: string }[]).filter((c) => c.name);
}
/** A few contacts to pick from before typing (the list the Contacts page shows first, else the newest). */
async function startContacts(): Promise<Contact[]> {
  const viaList = await searchContacts("", 30).catch(() => [] as Contact[]);
  if (viaList.length) return viaList;
  const { data } = await supabase.from("contacts").select("id, first_name, last_name, email, position").order("created_at", { ascending: false }).limit(30);
  return (data ?? []) as Contact[];
}
/** The people of a company: from the contacts list, else straight from the links. */
async function peopleOf(companyId: string): Promise<Contact[]> {
  const viaList = await companyPeople(companyId).catch(() => [] as Contact[]);
  if (viaList.length) return viaList;
  const { data: links } = await supabase.from("company_contacts").select("contact_id").eq("company_id", companyId);
  const ids = ((links ?? []) as { contact_id: string }[]).map((l) => l.contact_id);
  if (!ids.length) return [];
  const { data } = await supabase.from("contacts").select("id, first_name, last_name, email, position").in("id", ids.slice(0, 500));
  return ((data ?? []) as Contact[]).map((c) => ({ ...c, companyIds: [companyId] }));
}

const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Type-to-filter dropdown. Same job as framework/Select but the trigger is a
 * real text input that narrows the options as you type.
 *
 * The list is rendered through a portal with position:fixed because the drawer
 * body (.dw-body) scrolls with overflow-y:auto and would clip it otherwise.
 */
type ComboOpt = { value: string; label: string; group?: string; pref?: boolean; hint?: string };
function Combo({ value, onChange, options, placeholder, clearOnSelect = false, emptyText = "No matches", loadOptions }: {
  value: string;
  onChange: (v: string, picked?: ComboOpt) => void;
  /** `group` puts a small header above the first option of each group; `pref` highlights the option. */
  options: ComboOpt[];
  placeholder?: string;
  clearOnSelect?: boolean;
  emptyText?: string;
  /** Long lists kept in the database: more options are asked for as you type (after the local ones). */
  loadOptions?: (q: string) => Promise<ComboOpt[]>;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number; maxH: number; up: boolean } | null>(null);
  const [remote, setRemote] = useState<ComboOpt[]>([]);
  const [picked, setPicked] = useState<ComboOpt | null>(null);
  const loadRef = useRef(loadOptions);
  loadRef.current = loadOptions;
  useEffect(() => {
    if (!open || !loadRef.current || !query.trim()) { setRemote([]); return; }
    let off = false;
    const t = setTimeout(() => { loadRef.current?.(query.trim()).then((r) => { if (!off) setRemote(r); }).catch(() => {}); }, 200);
    return () => { off = true; clearTimeout(t); };
  }, [open, query, !!loadOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = options.find((o) => o.value === value) ?? (picked?.value === value ? picked : undefined);

  const filtered = useMemo(() => {
    const n = norm(query.trim());
    const local = n ? options.filter((o) => norm(o.label).includes(n)) : options;
    if (!remote.length) return local;
    const seen = new Set(local.map((o) => o.value));
    return [...local, ...remote.filter((o) => !seen.has(o.value))];
  }, [options, query, remote]);

  const place = () => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 14;
    const above = r.top - 14;
    const up = below < 190 && above > below;
    setBox({
      left: r.left, width: r.width, up,
      top: up ? r.top - 6 : r.bottom + 6,
      maxH: Math.max(150, Math.min(300, up ? above : below)),
    });
  };

  useEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => { window.removeEventListener("scroll", onMove, true); window.removeEventListener("resize", onMove); };
  }, [open]);

  useEffect(() => { setHi(0); }, [query, open]);

  const close = () => { setOpen(false); setQuery(""); };
  const commit = (v: string) => { const o = filtered.find((x) => x.value === v); if (o) setPicked(o); onChange(v, o); close(); };

  const onKey = (e: any) => {
    if (e.key === "Escape") {
      // Don't let Escape bubble to the drawer, which would close the whole modal.
      if (open) { e.stopPropagation(); close(); }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setQuery(""); setOpen(true); return; }
      setHi((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); const o = filtered[hi]; if (o) commit(o.value); }
  };

  return (
    <div className="cbo" ref={wrapRef}>
      <input
        className={`cbo-input ${open ? "is-open" : ""}`}
        value={open ? query : selected?.label ?? ""}
        placeholder={open ? selected?.label || placeholder || "Type to search…" : placeholder}
        onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { if (!open) { setQuery(""); setOpen(true); } }}
        onKeyDown={onKey}
      />
      <svg className="cbo-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
      {open && box && createPortal(
        <>
          <div className="cbo-layer" onMouseDown={close} />
          <div
            className="cbo-pop"
            style={{
              left: box.left, width: box.width, maxHeight: box.maxH,
              ...(box.up ? { bottom: window.innerHeight - box.top } : { top: box.top }),
            }}
          >
            {filtered.length === 0 ? (
              <div className="cbo-empty">{emptyText}</div>
            ) : filtered.map((o, i) => (
              <Fragment key={o.value || "__blank"}>
                {o.group && o.group !== filtered[i - 1]?.group && (
                  <div className={`cbo-group ${o.pref ? "is-pref" : ""}`}>{o.group}</div>
                )}
                <button
                  type="button"
                  className={`cbo-option ${o.pref ? "is-pref" : ""} ${i === hi ? "is-hi" : ""} ${!clearOnSelect && o.value === value ? "is-sel" : ""}`}
                  onMouseEnter={() => setHi(i)}
                  onMouseDown={(e) => { e.preventDefault(); commit(o.value); }}
                >
                  <span className="cbo-label">{o.label}</span>
                  {o.hint && <span className="cbo-hint">{o.hint}</span>}
                </button>
              </Fragment>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/** "New tracking" drawer: who, pipeline, products, and the company's own deal fields. */
export default function NewTracking({ companies, contacts, pipelines, products, fields = [], people = [], me = null, roles = [], phaseByPipe = {}, level = "team", onClose, onCreated, lean = false }: {
  companies: Company[]; contacts: Contact[]; pipelines: Pipeline[]; products: Product[];
  /** The directories stay in the database: companies and contacts are searched as you type. */
  lean?: boolean;
  /** Custom deal fields (Actions → Deal fields), shown under "Details". */
  fields?: TrackingField[];
  /** People who can be put on the deal (active employees). */
  people?: { id: string; name: string; role?: string }[];
  /** Sales roles: each person on the deal shows theirs, and picks one when they have several. */
  roles?: SalesRole[];
  /** Phases per pipeline (to describe how far a role sees). */
  phaseByPipe?: Record<string, Phase[]>;
  /** How far this person may go (Who sees what → Adjust settings → New tracking):
   *  self = they own it alone · team = they're on it and can add people · anyone = can leave themselves off. */
  level?: "self" | "team" | "anyone";
  /** Who is creating it. A sales lead may leave themselves off; anyone else stays on their own deal. */
  me?: { id: string; lead: boolean } | null;
  onClose: () => void; onCreated: (id: string) => void;
}) {
  // Who is on the deal from the start, and who owns it (the creator by default).
  const [team, setTeam] = useState<string[]>(me ? [me.id] : []);
  const [owner, setOwner] = useState<string | null>(me?.id ?? null);
  useEffect(() => {
    if (me && team.length === 0) { setTeam([me.id]); setOwner((o) => o ?? me.id); }
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const personName = (id: string) => people.find((p) => p.id === id)?.name ?? "—";
  const locked = (id: string) => !!me && (level === "self" || (!me.lead && level !== "anyone")) && id === me.id;
  const solo = level === "self";
  const removePerson = (id: string) => { setTeam((t) => t.filter((x) => x !== id)); setOwner((o) => (o === id ? null : o)); };
  const [companyId, setCompanyId] = useState("");
  const [dealName, setDealName] = useState("");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [pipelineId, setPipelineId] = useState("");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [custom, setCustom] = useState<Record<string, any>>({});
  const [tried, setTried] = useState(false);
  /** The role each person plays on this deal, when they have more than one. */
  const [dealRoles, setDealRoles] = useState<Record<string, string>>({});
  const isLeadJob = (id: string) => ["boss", "sales_manager"].includes((people.find((p) => p.id === id)?.role ?? "").toLowerCase());
  const pipeName = pipelines.find((p) => p.id === pipelineId)?.name ?? "";
  const describeRole = (r: SalesRole): string | null => {
    if (!pipelineId) return null;
    const sc = r.scopes.find((x) => x.pipeline_id === pipelineId);
    if (!sc) return null;
    const ph = orderPhases(phaseByPipe[pipelineId] ?? []).find((x) => x.id === sc.max_phase_id);
    const reach = sc.max_phase_id ? `Sees it up to ${ph?.name ?? "a set phase"}` : "Sees it in every phase";
    return sc.handover_to && sc.max_phase_id ? `${reach}, then it goes to ${personName(sc.handover_to)}` : reach;
  };
  /** People on the deal who still have to pick between several roles. */
  const unpicked = team.filter((id) => rolesFor(roles, id, pipelineId).fit.length > 1 && !resolveDealRole(roles, id, pipelineId, dealRoles[id]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // lean: the picked company's people (read from the database) and the people picked by search
  const [coPeople, setCoPeople] = useState<Contact[]>([]);
  const [pickedPeople, setPickedPeople] = useState<Contact[]>([]);
  const [pickedCo, setPickedCo] = useState<Company | null>(null);
  useEffect(() => {
    if (!lean || !companyId) { setCoPeople([]); return; }
    let off = false;
    peopleOf(companyId).then((r) => { if (!off) setCoPeople(r); }).catch(() => {});
    return () => { off = true; };
  }, [lean, companyId]);
  // lean: something to pick from before typing — the newest companies and contacts.
  const [startCos, setStartCos] = useState<{ id: string; name: string }[]>([]);
  const [startPeople, setStartPeople] = useState<Contact[]>([]);
  useEffect(() => {
    if (!lean) return;
    let off = false;
    startCompanies().then((r) => { if (!off) setStartCos(r); }).catch(() => {});
    startContacts().then((r) => { if (!off) setStartPeople(r); }).catch(() => {});
    return () => { off = true; };
  }, [lean]);
  const pool = lean ? [...coPeople, ...pickedPeople, ...startPeople] : contacts;
  const contactName = (id: string) => {
    const c = pool.find((x) => x.id === id) ?? contacts.find((x) => x.id === id);
    return c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "-";
  };
  const availableContacts = (lean
    ? [...coPeople, ...startPeople.filter((c) => !coPeople.some((x) => x.id === c.id))]
    : contacts).filter((c) => !contactIds.includes(c.id!));
  // With a company picked, its own contacts come first (highlighted), then everyone else.
  const company = companies.find((c) => c.id === companyId) ?? (pickedCo?.id === companyId ? pickedCo : null);
  const findCompanies = useMemo(() => (lean
    ? (q: string) => globalSearch(q, ["company"], 30).then((r) => (r ?? []).map((h) => ({ value: h.id, label: h.label, hint: h.sub ?? undefined, group: "All companies" })))
    : undefined), [lean]);
  const findContacts = useMemo(() => (lean
    ? (q: string) => searchContacts(q, 30).then((r) => {
      setPickedPeople((cur) => [...cur, ...r.filter((c) => !cur.some((x) => x.id === c.id))]);
      return r.filter((c) => !contactIds.includes(c.id!)).map((c) => ({ value: c.id!, label: fullName(c), hint: c.position || c.email || undefined, group: company ? "Other contacts" : undefined }));
    })
    : undefined), [lean, contactIds, company]);
  const contactOptions = useMemo(() => {
    const opt = (c: Contact, pref: boolean) => ({
      value: c.id!, label: fullName(c), pref,
      group: company ? (pref ? `From ${company.name}` : "Other contacts") : undefined,
      hint: pref ? c.position || undefined : lean ? c.position || c.email || undefined : undefined,
    });
    if (!company) return availableContacts.map((c) => opt(c, false));
    // the company's own people: what was read for it (lean), or its links
    const isOwn = (c: Contact) => (c.companyIds ?? []).includes(company.id!) || (lean && coPeople.some((x) => x.id === c.id));
    const own = availableContacts.filter(isOwn);
    const rest = availableContacts.filter((c) => !isOwn(c));
    return [...own.map((c) => opt(c, true)), ...rest.map((c) => opt(c, false))];
  }, [contacts, contactIds, company, coPeople, startPeople, lean]); // eslint-disable-line react-hooks/exhaustive-deps
  const ownCount = contactOptions.filter((o) => o.pref).length;
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? "-";
  const availableProducts = products.filter((p) => !productIds.includes(p.id!));

  const create = async () => {
    if (!pipelineId) { setErr("Pick a pipeline."); return; }
    if (!companyId && contactIds.length === 0) { setErr("Pick a company or at least one contact."); return; }
    if (unpicked.length) { setTried(true); setErr(`Choose the role ${personName(unpicked[0])} plays on this deal.`); return; }
    const gap = missingRequired(fields, custom);
    if (gap) { setTried(true); setErr(`"${gap.label}" is required.`); return; }
    setBusy(true); setErr(null);
    const { phases } = await loadPipeline(pipelineId).catch(() => ({ phases: [] as Phase[] }));
    const firstPhase = phases.filter((p) => p.sales_visible !== false)[0]?.id ?? phases[0]?.id ?? null;
    const id = await createTracking({
      company_id: companyId || null, pipeline_id: pipelineId,
      // Seed each product with its first tier price so Potential revenue
      // is not empty the moment the tracking opens.
      products: productIds.map((pid) => ({
        id: pid,
        price: products.find((p) => p.id === pid)?.tiers?.[0]?.price ?? 0,
      })),
      current_phase_id: firstPhase, contactIds,
      deal_name: dealName,
      custom: cleanCustom(custom),
      deal_roles: Object.fromEntries(
        Array.from(new Set([...team, ...(owner ? [owner] : [])]))
          .map((pid) => [pid, resolveDealRole(roles, pid, pipelineId, dealRoles[pid])?.id] as const)
          .filter((x): x is readonly [string, string] => !!x[1]),
      ),
    });
    setBusy(false);
    if (!id) { setErr("Could not create the deal."); return; }
    // The people picked here are on the deal; the owner gets the star.
    const finalTeam = Array.from(new Set([...team, ...(owner ? [owner] : [])]));
    if (finalTeam.length) await setTrackingEmployees(id, finalTeam).catch(() => {});
    if (owner) await setTrackingOwner(id, owner).catch(() => {});
    onCreated(id);
  };

  return (
    <div className="dw-backdrop" onMouseDown={onClose}>
      <div className="dw" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dw-head">
          <div>
            <span className="dw-eyebrow">New deal</span>
            <h2 className="dw-title">Start following a client</h2>
          </div>
          <button className="dw-x" onClick={onClose}>×</button>
        </div>
        <div className="dw-body">
          <div className="dw-sec">
            <p className="dw-sec-title">Who</p>
            <div className="dw-f dw-col2" style={{ marginBottom: 12 }}>
              <label>Company</label>
              <Combo value={companyId} onChange={(v, o) => { setCompanyId(v); if (lean && v && o) setPickedCo({ id: v, name: o.label } as Company); }} placeholder="Type to search companies…"
                emptyText={lean ? "Type a name to search" : "No company matches"} loadOptions={findCompanies}
                options={[{ value: "", label: "- No company -" }, ...(lean
                  ? [...(company ? [{ value: company.id!, label: company.name }] : []), ...startCos.filter((c) => c.id !== company?.id).map((c) => ({ value: c.id, label: c.name, group: "Recently added" }))]
                  : companies.map((c) => ({ value: c.id!, label: c.name })))]} />
            </div>
            <div className="dw-f" style={{ marginBottom: 12 }}>
              <label htmlFor="nt-deal-name">Deal name <span className="nt-optional">optional</span></label>
              <input id="nt-deal-name" className="tfi-in" value={dealName} maxLength={120} onChange={(e) => setDealName(e.target.value)}
                placeholder={company ? `e.g. ${company.name} — licence renewal 2027` : "e.g. Licence renewal 2027"} />
              <small className="nt-name-hint">{dealName.trim() ? "This is how the deal shows in Deals and in Outlook." : company ? `Leave it empty to call it “${company.name}”.` : "Leave it empty to use the company or contact name."}</small>
            </div>
            <label className="dw-f-label">Contacts</label>
            <div className="dw-chips">
              {contactIds.map((id) => (
                <span key={id} className="dw-chip">{contactName(id)}<button onClick={() => setContactIds((xs) => xs.filter((x) => x !== id))}>×</button></span>
              ))}
            </div>
            {(lean || availableContacts.length > 0) && (
              <Combo value="" clearOnSelect onChange={(v, o) => {
                if (!v) return;
                setContactIds((xs) => [...xs, v]);
                // keep the name of someone picked from the list read for this deal
                if (lean && o && !pool.some((c) => c.id === v)) setPickedPeople((cur) => [...cur, { id: v, first_name: o.label, last_name: "" } as Contact]);
              }} loadOptions={findContacts}
                placeholder={company && ownCount ? `Type to search… ${company.name}'s contacts come first` : "Type to search contacts…"} emptyText="No contact matches"
                options={contactOptions} />
            )}
          </div>
          <div className="dw-sec">
            <p className="dw-sec-title">Pipeline</p>
            <Combo value={pipelineId} onChange={setPipelineId} placeholder="Type to search pipelines…"
              emptyText="No pipeline matches"
              options={pipelines.map((p) => ({ value: p.id, label: p.name }))} />
          </div>
          <div className="dw-sec nt-people">
            <p className="dw-sec-title">People on this deal</p>
            {team.length === 0 && <p className="dw-empty-hint">Nobody yet. Add who works on this deal.</p>}
            <div className="nt-people-list">
              {team.map((id) => (
                <div key={id} className={`nt-person ${owner === id ? "is-owner" : ""}`}>
                  <span className="nt-person-av">{personName(id).slice(0, 1).toUpperCase()}</span>
                  <div className={`nt-person-main ${tried && unpicked.includes(id) ? "is-missing" : ""}`}>
                    <span className="nt-person-name">{personName(id)}{me?.id === id && <em>you</em>}</span>
                    {(() => {
                      const { all, fit } = rolesFor(roles, id, pipelineId);
                      if (all.length && !fit.length && !isLeadJob(id)) {
                        return <small className="nt-person-warn">None of their roles covers {pipeName || "this pipeline"} — they won't see this deal.</small>;
                      }
                      return (
                        <DealRolePicker roles={fit} personName={personName(id)} describe={describeRole}
                          value={resolveDealRole(roles, id, pipelineId, dealRoles[id])?.id ?? null}
                          onChange={(rid) => setDealRoles((d) => ({ ...d, [id]: rid }))} />
                      );
                    })()}
                  </div>
                  {owner === id && <span className="nt-person-tag">Owner</span>}
                  <button type="button" className={`nt-star ${owner === id ? "is-on" : ""}`} onClick={() => !solo && setOwner(owner === id ? null : id)} disabled={solo}
                    title={owner === id ? "Remove as owner" : "Make owner"} aria-label={owner === id ? "Remove as owner" : "Make owner"}>
                    <svg viewBox="0 0 24 24" fill={owner === id ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l3 6.5 7 .6-5.3 4.6 1.6 6.9L12 17.8 5.7 20.6l1.6-6.9L2 9.1l7-.6z" /></svg>
                  </button>
                  {!locked(id) && <button type="button" className="nt-person-x" onClick={() => removePerson(id)} aria-label={`Remove ${personName(id)}`}>×</button>}
                </div>
              ))}
            </div>
            {!solo && people.some((p) => !team.includes(p.id)) && (
              <Combo value="" clearOnSelect onChange={(v) => v && setTeam((t) => (t.includes(v) ? t : [...t, v]))}
                placeholder="Type to add people…" emptyText="Nobody matches"
                options={people.filter((p) => !team.includes(p.id)).map((p) => {
                  const rs = rolesFor(roles, p.id).all;
                  return { value: p.id, label: p.name, hint: rs.length ? rs.map((r) => r.name).join(" · ") : undefined };
                })} />
            )}
            <p className="nt-people-hint">{solo ? "You'll own this deal. Ask a manager to add more people." : <>Tap the star to choose who owns the deal.{roles.length > 0 && " If someone has several roles, pick the one they play here."}</>}</p>
          </div>
          <div className="dw-sec">
            <p className="dw-sec-title">Products</p>
            <div className="dw-chips">
              {productIds.map((id) => (
                <span key={id} className="dw-chip">{productName(id)}
                  <button onClick={() => setProductIds((xs) => xs.filter((x) => x !== id))} aria-label="Remove">×</button>
                </span>
              ))}
            </div>
            {productIds.length === 0 && <p className="dw-empty-hint">No products yet (optional). Add as many as the deal covers.</p>}
            {availableProducts.length > 0 && (
              <Combo value="" clearOnSelect onChange={(v) => v && setProductIds((xs) => [...xs, v])}
                placeholder="Type to search products…" emptyText="No product matches"
                options={availableProducts.map((p) => ({ value: p.id!, label: p.name }))} />
            )}
          </div>
          {fields.length > 0 && (
            <div className="dw-sec nt-fields">
              <p className="dw-sec-title">Details</p>
              <div className="dw-grid">
                {fields.map((f) => (
                  <div key={f.id} className={`dw-f ${f.type === "text" || f.type === "select" ? "dw-col2" : ""} ${tried && f.required && isEmptyValue(f, custom[f.id]) ? "is-missing" : ""}`}>
                    <label>{f.label}{f.required && <i title="Required">*</i>}</label>
                    <FieldInput field={f} value={custom[f.id]} onChange={(v) => setCustom((x) => ({ ...x, [f.id]: v }))} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {err && <p className="dw-err">{err}</p>}
        </div>
        <div className="dw-foot">
          <div className="dw-foot-right">
            <button className="dw-cancel" onClick={onClose}>Cancel</button>
            <button className="dw-save" onClick={create} disabled={busy}>{busy ? "Creating..." : "Start tracking"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}