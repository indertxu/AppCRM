import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import "./NewTracking.css";

import { PicOr } from "../../../framework/avatars";
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
function Combo({ value, onChange, options, placeholder, clearOnSelect = false, multi = false, emptyText = "No matches", loadOptions }: {
  value: string;
  onChange: (v: string, picked?: ComboOpt) => void;
  /** `group` puts a small header above the first option of each group; `pref` highlights the option. */
  options: ComboOpt[];
  placeholder?: string;
  clearOnSelect?: boolean;
  /** Pick several in a row: the list stays open after each pick (clicking outside or Escape closes it). */
  multi?: boolean;
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
  // several picks in a row: what's picked shows above the field and pushes it down — the list follows it
  useEffect(() => { if (open) requestAnimationFrame(place); }, [options.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { setOpen(false); setQuery(""); };
  const commit = (v: string) => {
    const o = filtered.find((x) => x.value === v);
    if (o) setPicked(o);
    onChange(v, o);
    if (multi) { setHi((i) => Math.max(0, Math.min(i, filtered.length - 2))); return; }
    close();
  };

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
export default function NewTracking({ companies, contacts, pipelines, products, fields = [], people = [], me = null, roles = [], phaseByPipe = {}, level = "team", onClose, onCreated, lean = false, preset }: {
  /** Opened from a company or a contact panel: that company and those people are already picked. */
  preset?: { company?: { id: string; name: string } | null; contacts?: { id: string; name: string }[] };
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
  const [companyId, setCompanyId] = useState(preset?.company?.id ?? "");
  const [dealName, setDealName] = useState("");
  const [contactIds, setContactIds] = useState<string[]>(() => (preset?.contacts ?? []).map((x) => x.id));
  const [pipelineId, setPipelineId] = useState("");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [custom, setCustom] = useState<Record<string, any>>({});
  const [tried, setTried] = useState(false);
  const [step, setStep] = useState(0);
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
  const [pickedPeople, setPickedPeople] = useState<Contact[]>(() => (preset?.contacts ?? []).map((x) => ({ id: x.id, first_name: x.name, last_name: "", companyIds: [] }) as unknown as Contact));
  const [pickedCo, setPickedCo] = useState<Company | null>(() => (preset?.company ? ({ id: preset.company.id, name: preset.company.name, relationship: [] } as unknown as Company) : null));
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

  /* ---------- step by step: Client → Pipeline → Team → Products & details ---------- */
  const STEPS = [
    { k: "who", label: "Client", hint: "Who the deal is with" },
    { k: "pipe", label: "Pipeline", hint: "Where it runs" },
    { k: "team", label: "Team", hint: "Who works on it" },
    { k: "extra", label: fields.length ? "Products & details" : "Products", hint: "What it covers" },
  ];
  const stepError = (i: number): string | null => {
    if (i === 0) return !companyId && contactIds.length === 0 ? "Pick a company or at least one contact." : null;
    if (i === 1) return !pipelineId ? "Pick a pipeline." : null;
    if (i === 2) return unpicked.length ? `Choose the role ${personName(unpicked[0])} plays on this deal.` : null;
    const gap = missingRequired(fields, custom);
    return gap ? `"${gap.label}" is required.` : null;
  };
  // a step's message goes away as soon as what it asked for is there
  const stepOk = !stepError(step);
  useEffect(() => { if (stepOk) setErr(null); }, [stepOk, step]);
  const firstBad = () => { for (let i = 0; i < STEPS.length; i++) if (stepError(i)) return i; return -1; };
  const go = (i: number) => {
    if (i <= step) { setErr(null); setStep(i); return; }
    for (let j = step; j < i; j++) {
      const e = stepError(j);
      if (e) { setTried(true); setErr(e); setStep(j); return; }
    }
    setErr(null); setTried(false); setStep(i);
  };
  const finish = () => {
    const bad = firstBad();
    if (bad >= 0) { setTried(true); setErr(stepError(bad)); setStep(bad); return; }
    void create();
  };
  const summary = [
    company?.name ?? (contactIds.length ? `${contactIds.length} ${contactIds.length === 1 ? "contact" : "contacts"}` : ""),
    pipeName,
    team.length ? `${team.length} ${team.length === 1 ? "person" : "people"}${owner ? ` · ${personName(owner).split(" ")[0]} owns it` : ""}` : "",
    productIds.length ? `${productIds.length} ${productIds.length === 1 ? "product" : "products"}` : "Optional",
  ];
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "·";
  const ico = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
  const I = {
    who: "M3 21V7l9-4 9 4v14M9 21v-6h6v6M8 10h.01M12 10h.01M16 10h.01",
    pipe: "M4 6h16M4 12h10M4 18h6",
    team: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    extra: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7 12 12l8.7-5M12 22V12",
    name: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
    check: "M5 12l5 5L20 7",
  };
  const card = (icon: string, title: string, hint: ReactNode, body: ReactNode, cls = "") => (
    <section className={`nt2-card ${cls}`}>
      <header className="nt2-card-h"><span className="nt2-card-ico">{ico(icon)}</span><span><h3>{title}</h3><small>{hint}</small></span></header>
      {body}
    </section>
  );
  const ownSuggest = contactOptions.filter((o) => o.pref).slice(0, 10);
  const productCards = products.length <= 40;
  const title = dealName.trim() || company?.name || (contactIds[0] ? contactName(contactIds[0]) : "") || "Start following a client";

  return (
    <div className="dw-backdrop" onMouseDown={onClose}>
      <div className="dw nt2" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="New deal">
        <header className="nt2-hero">
          <div className="nt2-hero-txt">
            <span className="nt2-eyebrow">New deal · step {step + 1} of {STEPS.length}</span>
            <h2>{title}</h2>
          </div>
          <button className="nt2-x" onClick={onClose} aria-label="Close">×</button>
          <ol className="nt2-steps">
            {STEPS.map((s, i) => {
              return (
                <li key={s.k}>
                  <button type="button" className={`nt2-step ${i === step ? "is-on" : ""} ${i < step ? "is-done" : ""}`} onClick={() => go(i)} aria-current={i === step ? "step" : undefined}>
                    <i>{i < step ? ico(I.check) : i + 1}</i>
                    <span><b>{s.label}</b><small>{i <= step && summary[i] && i !== 3 ? summary[i] : s.hint}</small></span>
                  </button>
                </li>
              );
            })}
          </ol>
        </header>

        <div className="nt2-body">
          <div className="nt2-stage" key={step}>
            {step === 0 && <>
              {card(I.who, "Company", "The client or prospect this deal is with", (
                <Combo value={companyId} onChange={(v, o) => { setCompanyId(v); if (lean && v && o) setPickedCo({ id: v, name: o.label } as Company); }} placeholder="Type to search companies…"
                  emptyText={lean ? "Type a name to search" : "No company matches"} loadOptions={findCompanies}
                  options={[{ value: "", label: "- No company -" }, ...(lean
                    ? [...(company ? [{ value: company.id!, label: company.name }] : []), ...startCos.filter((c) => c.id !== company?.id).map((c) => ({ value: c.id, label: c.name, group: "Recently added" }))]
                    : companies.map((c) => ({ value: c.id!, label: c.name })))]} />
              ))}
              {card(I.team, "Contacts", company ? <>The people at {company.name} you're talking to</> : "The people you're talking to", <>
                {contactIds.length > 0 && (
                  <div className="nt2-chips">
                    {contactIds.map((id) => (
                      <span key={id} className="nt2-chip"><i>{initials(contactName(id))}</i>{contactName(id)}
                        <button type="button" onClick={() => setContactIds((xs) => xs.filter((x) => x !== id))} aria-label={`Remove ${contactName(id)}`}>×</button></span>
                    ))}
                  </div>
                )}
                {company && ownSuggest.length > 0 && (
                  <div className="nt2-sugs">
                    <small>From {company.name}</small>
                    {ownSuggest.map((o) => (
                      <button key={o.value} type="button" className="nt2-sug" onClick={() => setContactIds((xs) => (xs.includes(o.value) ? xs : [...xs, o.value]))} title={o.hint}>
                        <span>+</span>{o.label}{o.hint && <em>{o.hint}</em>}
                      </button>
                    ))}
                  </div>
                )}
                {(lean || availableContacts.length > 0) && (
                  <Combo value="" clearOnSelect multi onChange={(v, o) => {
                    if (!v) return;
                    setContactIds((xs) => (xs.includes(v) ? xs : [...xs, v]));
                    if (lean && o && !pool.some((c) => c.id === v)) setPickedPeople((cur) => [...cur, { id: v, first_name: o.label, last_name: "" } as Contact]);
                  }} loadOptions={findContacts}
                    placeholder={company && ownCount ? "Search anyone else…" : "Type to search contacts…"} emptyText="No contact matches"
                    options={contactOptions} />
                )}
              </>)}
              {card(I.name, "Deal name", <>Optional — {dealName.trim() ? "this is how it shows in Deals and in Outlook" : company ? `empty, it's called “${company.name}”` : "empty, it takes the company or contact name"}</>, (
                <input className="nt2-in" value={dealName} maxLength={120} onChange={(e) => setDealName(e.target.value)} aria-label="Deal name"
                  placeholder={company ? `e.g. ${company.name} — licence renewal 2027` : "e.g. Licence renewal 2027"} />
              ))}
            </>}

            {step === 1 && card(I.pipe, "Pipeline", "Where the deal runs — it starts in the pipeline's first phase", (
              <div className="nt2-grid">
                {pipelines.map((p, i) => {
                  const ph = orderPhases(phaseByPipe[p.id] ?? []);
                  const on = pipelineId === p.id;
                  return (
                    <button key={p.id} type="button" className={`nt2-opt ${on ? "is-on" : ""}`} style={{ "--i": i } as CSSProperties} onClick={() => { setPipelineId(p.id); setErr(null); }} aria-pressed={on}>
                      <i className="nt2-radio" />
                      <span className="nt2-opt-t">
                        <b>{p.name}</b>
                        {p.description ? <small>{p.description}</small> : ph.length > 0 && <small>{ph.length} phases · starts in {ph[0].name}</small>}
                      </span>
                      {(p.is_renewal || p.expansion_kind) && <em>{p.is_renewal ? "Renewals" : p.expansion_kind === "upsell" ? "Upsell" : "Cross-sell"}</em>}
                    </button>
                  );
                })}
                {pipelines.length === 0 && <p className="nt2-empty">No pipeline you can use yet — ask an admin to add one in Settings › Pipelines.</p>}
              </div>
            ))}

            {step === 2 && card(I.team, "People on this deal", solo ? "You'll own this deal. Ask a manager to add more people." : <>Tap the star to choose who owns it{roles.length > 0 && "; if someone has several roles, pick the one they play here"}</>, <>
              <div className="nt-people-list nt2-people">
                {team.length === 0 && <p className="nt2-empty">Nobody yet. Add who works on this deal.</p>}
                {team.map((id) => (
                  <div key={id} className={`nt-person ${owner === id ? "is-owner" : ""}`}>
                    <span className="nt-person-av"><PicOr name={personName(id)}>{initials(personName(id))}</PicOr></span>
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
                <Combo value="" clearOnSelect multi onChange={(v) => v && setTeam((t) => (t.includes(v) ? t : [...t, v]))}
                  placeholder="Add someone…" emptyText="Nobody matches"
                  options={people.filter((p) => !team.includes(p.id)).map((p) => {
                    const rs = rolesFor(roles, p.id).all;
                    return { value: p.id, label: p.name, hint: rs.length ? rs.map((r) => r.name).join(" · ") : undefined };
                  })} />
              )}
            </>)}

            {step === 3 && <>
              {card(I.extra, "Products", "Optional — what the deal covers; prices come in on the deal's calculator", productCards ? (
                <div className="nt2-grid is-small">
                  {products.map((p, i) => {
                    const on = productIds.includes(p.id!);
                    return (
                      <button key={p.id} type="button" className={`nt2-opt is-check ${on ? "is-on" : ""}`} style={{ "--i": i } as CSSProperties} aria-pressed={on}
                        onClick={() => setProductIds((xs) => (on ? xs.filter((x) => x !== p.id) : [...xs, p.id!]))}>
                        <i className="nt2-tick">{on && ico(I.check)}</i>
                        <span className="nt2-opt-t"><b>{p.name}</b><small>{[p.kind, p.billing === "recurring" ? `Recurring${p.billing_period ? ` · ${p.billing_period}` : ""}` : "One-time"].filter(Boolean).join(" · ")}</small></span>
                      </button>
                    );
                  })}
                  {products.length === 0 && <p className="nt2-empty">No products in the catalogue yet.</p>}
                </div>
              ) : <>
                {productIds.length > 0 && (
                  <div className="nt2-chips">
                    {productIds.map((id) => (
                      <span key={id} className="nt2-chip">{productName(id)}<button type="button" onClick={() => setProductIds((xs) => xs.filter((x) => x !== id))} aria-label="Remove">×</button></span>
                    ))}
                  </div>
                )}
                {availableProducts.length > 0 && (
                  <Combo value="" clearOnSelect multi onChange={(v) => v && setProductIds((xs) => (xs.includes(v) ? xs : [...xs, v]))}
                    placeholder="Type to search products…" emptyText="No product matches"
                    options={availableProducts.map((p) => ({ value: p.id!, label: p.name }))} />
                )}
              </>)}
              {fields.length > 0 && card(I.name, "Details", "Your company's own fields for deals", (
                <div className="dw-grid nt-fields">
                  {fields.map((f) => (
                    <div key={f.id} className={`dw-f ${f.type === "text" || f.type === "select" ? "dw-col2" : ""} ${tried && f.required && isEmptyValue(f, custom[f.id]) ? "is-missing" : ""}`}>
                      <label>{f.label}{f.required && <i title="Required">*</i>}</label>
                      <FieldInput field={f} value={custom[f.id]} onChange={(v) => setCustom((x) => ({ ...x, [f.id]: v }))} />
                    </div>
                  ))}
                </div>
              ))}
              {/* what will be created */}
              <section className="nt2-review">
                <span className="nt2-review-k">Ready to start</span>
                <b>{title}</b>
                <span className="nt2-review-l">
                  {summary.slice(0, 3).filter(Boolean).map((t, i) => <em key={i}>{t}</em>)}
                  {productIds.length > 0 && <em>{summary[3]}</em>}
                </span>
              </section>
            </>}
          </div>
          {err && <p className="nt2-err" role="alert">{err}</p>}
        </div>

        <footer className="nt2-foot">
          <button type="button" className="nt2-btn is-ghost" onClick={onClose}>Cancel</button>
          <span className="nt2-foot-sp" />
          {step > 0 && <button type="button" className="nt2-btn" onClick={() => go(step - 1)}>Back</button>}
          {step < STEPS.length - 1
            ? <button type="button" className="nt2-btn is-main" onClick={() => go(step + 1)}>Next: {STEPS[step + 1].label}<span aria-hidden="true">→</span></button>
            : <button type="button" className="nt2-btn is-main" onClick={finish} disabled={busy}>{busy ? "Creating…" : "Start tracking"}</button>}
        </footer>
      </div>
    </div>
  );
}
