/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import {
  listCompanies, saveCompany, deleteCompany, companyContactCounts, listContacts,
  myProfile, isSalesLead, listEmployees, loadCompanyAssignees, setCompanyAssignees,
  listCompanyFields, addCompanyField, updateCompanyField, deleteCompanyField,
  listContactFields, saveContact,
  loadRelationshipSets, type RelationshipSets,
  loadPrefs, savePref,
  type Company, type Contact, type Employee, type CompanyField, type ContactField,
} from "./companiesApi";
import "../clients/ClientsPage.css";
import "./CompaniesPage.css";

const empty = (): Company => ({
  name: "", legal_name: "", vat_number: "", reg_number: "", website: "", phone: "", email: "", notes: "",
  street: "", addr_number: "", addr_details: "", postal_code: "", city: "", province: "", country: "",
});

// Strip accents/diacritics so "brujula" matches "brújula".
const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export default function CompaniesPage() {
  const navigate = useNavigate();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<Company | null>(null);
  const [q, setQ] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [assignees, setAssignees] = useState<Record<string, string[]>>({});
  const [me, setMe] = useState<{ id: string; role: string; is_superadmin: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [fields, setFields] = useState<CompanyField[]>([]);
  const [contactFields, setContactFields] = useState<ContactField[]>([]);
  const [showFieldSettings, setShowFieldSettings] = useState(false);
  const [ctrl1, setCtrl1] = useState<{ field: string; action: string; min?: string; max?: string }>({ field: "", action: "" });
  const [ctrl2, setCtrl2] = useState<{ field: string; action: string; min?: string; max?: string }>({ field: "", action: "" });
  const [rel, setRel] = useState<RelationshipSets | null>(null);
  const [fRel, setFRel] = useState("");
  const [columns, setColumns] = useState<string[]>(["vat_number", "address", "contacts"]);

  const reload = async () => {
    setCompanies(await listCompanies().catch(() => []));
    setCounts(await companyContactCounts().catch(() => ({})));
    setContacts(await listContacts().catch(() => []));
    setAssignees(await loadCompanyAssignees().catch(() => ({})));
    setFields(await listCompanyFields().catch(() => []));
    setContactFields(await listContactFields().catch(() => []));
    setRel(await loadRelationshipSets().catch(() => null));
  };
  useEffect(() => {
    myProfile().then(setMe).catch(() => {});
    listEmployees().then(setEmployees).catch(() => {});
    loadPrefs().then((p) => { if (Array.isArray(p.companyColumns)) setColumns(p.companyColumns); }).catch(() => {});
    reload();
  }, []);

  const lead = isSalesLead(me);

  // ---- Compound filter + sort controls ----
  const fixedFields = [
    { key: "name", label: "Name" },
    { key: "vat_number", label: "VAT / Tax ID" },
    { key: "city", label: "City" },
    { key: "country", label: "Country" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
  ];
  const filterFieldOptions = [
    { value: "", label: "No filter" },
    ...fixedFields.map((f) => ({ value: f.key, label: f.label })),
    ...fields.map((f) => ({ value: f.id, label: f.label })),
  ];
  const fieldById = (id: string) => fields.find((f) => f.id === id);
  const fieldType = (key: string): "text" | "number" | "date" | "boolean" | "select" => {
    if (fixedFields.some((f) => f.key === key)) return "text";
    return fieldById(key)?.type ?? "text";
  };
  const valueOf = (c: Company, key: string): any => {
    if (fixedFields.some((f) => f.key === key)) return (c as any)[key] ?? "";
    return (c.custom ?? {})[key];
  };
  const actionsFor = (key: string): { value: string; label: string }[] => {
    if (!key) return [];
    const t = fieldType(key);
    if (t === "number") return [{ value: "desc", label: "High → low" }, { value: "asc", label: "Low → high" }, { value: "range", label: "Range…" }];
    if (t === "date") return [{ value: "desc", label: "Newest first" }, { value: "asc", label: "Oldest first" }];
    if (t === "boolean") return [{ value: "only_yes", label: "Only Yes" }, { value: "only_no", label: "Only No" }];
    if (t === "select") return (fieldById(key)?.options ?? []).map((o) => ({ value: `eq:${o}`, label: `Is “${o}”` }));
    return [{ value: "asc", label: "A → Z" }, { value: "desc", label: "Z → A" }];
  };
  const passesFilter = (c: Company, ctrl: { field: string; action: string; min?: string; max?: string }) => {
    if (!ctrl.field || !ctrl.action) return true;
    const v = valueOf(c, ctrl.field);
    if (ctrl.action === "only_yes") return !!v;
    if (ctrl.action === "only_no") return !v;
    if (ctrl.action.startsWith("eq:")) return String(v ?? "") === ctrl.action.slice(3);
    if (ctrl.action === "range") {
      const n = Number(v);
      if (v == null || v === "" || Number.isNaN(n)) return false;
      if (ctrl.min !== undefined && ctrl.min !== "" && n < Number(ctrl.min)) return false;
      if (ctrl.max !== undefined && ctrl.max !== "" && n > Number(ctrl.max)) return false;
      return true;
    }
    return true;
  };
  const cmp = (a: Company, b: Company, ctrl: { field: string; action: string; min?: string; max?: string }) => {
    if (!ctrl.field || (ctrl.action !== "asc" && ctrl.action !== "desc")) return 0;
    const t = fieldType(ctrl.field);
    const av = valueOf(a, ctrl.field), bv = valueOf(b, ctrl.field);
    let r = 0;
    if (t === "number") r = (Number(av) || 0) - (Number(bv) || 0);
    else if (t === "date") r = String(av ?? "").localeCompare(String(bv ?? ""));
    else r = String(av ?? "").localeCompare(String(bv ?? ""), undefined, { sensitivity: "base" });
    return ctrl.action === "desc" ? -r : r;
  };

  const relOf = (c: Company): "client" | "tracking" | "none" => {
    if (rel && c.id && rel.clientCompanyIds.has(c.id)) return "client";
    if (rel && c.id && rel.trackingCompanyIds.has(c.id)) return "tracking";
    return "none";
  };

  const shown = companies.filter((c) => {
    // Sales people only see the companies they have been assigned to.
    if (!lead && me && !(assignees[c.id!] ?? []).includes(me.id)) return false;
    if (!passesFilter(c, ctrl1)) return false;
    if (!passesFilter(c, ctrl2)) return false;
    if (fRel && relOf(c) !== fRel) return false;
    const n = norm(q.trim());
    if (!n) return true;
    return [c.name, c.legal_name, c.vat_number, c.street, c.city, c.province, c.country, c.postal_code]
      .some((v) => norm(v ?? "").includes(n));
  }).sort((a, b) => {
    const r1 = cmp(a, b, ctrl1);
    if (r1 !== 0) return r1;
    return cmp(a, b, ctrl2);
  });

  const contactsOf = (companyId: string) => contacts.filter((ct) => ct.companyIds.includes(companyId));

  const addrLine = (c: Company) =>
    [c.street, c.addr_number, c.city, c.country].filter(Boolean).join(", ") || "—";

  // Configurable overview columns (Name is always first).
  const availableColumns = [
    { key: "vat_number", label: "VAT / Tax ID" },
    { key: "address", label: "Address" },
    { key: "city", label: "City" },
    { key: "country", label: "Country" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "contacts", label: "Contacts" },
    ...fields.map((f) => ({ key: f.id, label: f.label })),
  ];
  const columnLabel = (key: string) => availableColumns.find((c) => c.key === key)?.label ?? key;
  const activeColumns = columns.filter((k) => availableColumns.some((c) => c.key === k)).slice(0, 4);
  const setColumnsPersist = (next: string[]) => { setColumns(next); savePref("companyColumns", next).catch(() => {}); };

  const renderCell = (c: Company, key: string) => {
    if (key === "vat_number") return <span className="co-lmono">{c.vat_number || "—"}</span>;
    if (key === "address") return <span className="co-laddr">{addrLine(c)}</span>;
    if (key === "city") return <span className="co-laddr">{c.city || "—"}</span>;
    if (key === "country") return <span className="co-laddr">{c.country || "—"}</span>;
    if (key === "email") return <span className="co-laddr">{c.email || "—"}</span>;
    if (key === "phone") return <span className="co-lmono">{c.phone || "—"}</span>;
    if (key === "contacts") return (
      <span className="co-lright">
        <button className={`co-expand ${open === c.id ? "is-on" : ""}`}
          aria-expanded={open === c.id} aria-label="Show contacts"
          onClick={(e) => { e.stopPropagation(); setOpen(open === c.id ? null : c.id!); }}>
          <b className="co-lbadge">{counts[c.id!] ?? 0}</b>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={open === c.id ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} /></svg>
        </button>
      </span>
    );
    // custom field
    const f = fieldById(key);
    const v = (c.custom ?? {})[key];
    if (!f || v == null || v === "") return <span className="co-laddr">—</span>;
    if (f.type === "boolean") return <span className="co-laddr">{v ? "Yes" : "No"}</span>;
    return <span className="co-laddr">{String(v)}</span>;
  };

  if (me && !isSalesLead(me) && me.role !== "sales") {
    return (
      <div className="co">
        <header className="co-head">
          <button className="co-back" onClick={() => navigate("/home")} aria-label="Back">‹</button>
          <h1 className="co-title">Companies</h1>
        </header>
        <p className="cl-hint">This page is only available to the sales team.</p>
      </div>
    );
  }

  return (
    <div className="co">
      <header className="co-head">
        <button className="co-back" onClick={() => navigate("/home")} aria-label="Back">‹</button>
        <h1 className="co-title">Companies</h1>
        <span className="co-kpi"><b>{shown.length}</b>{shown.length === 1 ? "company" : "companies"}</span>
        <div className="co-search">
          <span className="co-search-ico">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or address…" />
          {q && <button onClick={() => setQ("")}>×</button>}
        </div>
        <div className="co-cfilter">
          <Select value={fRel} onChange={setFRel} placeholder="Any relationship"
            options={[
              { value: "", label: "Any relationship" },
              { value: "client", label: "Clients" },
              { value: "tracking", label: "In a tracking" },
              { value: "none", label: "Not yet in play" },
            ]} />
        </div>
        <div className="co-cfilters">
          {[{ c: ctrl1, set: setCtrl1 }, { c: ctrl2, set: setCtrl2 }].map((ctl, i) => (
            <div className="co-cfilter" key={i}>
              <Select value={ctl.c.field}
                onChange={(field) => { const acts = actionsFor(field); ctl.set({ field, action: acts[0]?.value ?? "" }); }}
                options={filterFieldOptions} placeholder={`Filter ${i + 1}`} />
              {ctl.c.field && (
                <Select value={ctl.c.action} onChange={(action) => ctl.set({ ...ctl.c, action })}
                  options={actionsFor(ctl.c.field)} placeholder="How" />
              )}
              {ctl.c.action === "range" && (
                <div className="co-range">
                  <input type="number" placeholder="Min" value={ctl.c.min ?? ""} onFocus={(e) => e.target.select()}
                    onChange={(e) => ctl.set({ ...ctl.c, min: e.target.value })} />
                  <span className="co-range-sep">–</span>
                  <input type="number" placeholder="Max" value={ctl.c.max ?? ""} onFocus={(e) => e.target.select()}
                    onChange={(e) => ctl.set({ ...ctl.c, max: e.target.value })} />
                </div>
              )}
            </div>
          ))}
        </div>
        <button className="co-settings" onClick={() => setShowFieldSettings(true)} title="Configure company fields" aria-label="Configure fields">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
          Fields
        </button>
        <button className="cl-primary" onClick={() => setEditing(empty())}>+ New company</button>
      </header>

      {shown.length === 0 ? (
        <p className="cl-hint">{companies.length === 0 ? "No companies yet. Create your first one." : "No companies match your search."}</p>
      ) : (
        <div className="co-scroll">
          <div className="co-lrow co-lhead" style={{ gridTemplateColumns: `2.4fr ${activeColumns.map(() => "1.4fr").join(" ")}` }}>
            <span>Company</span>
            {activeColumns.map((k) => <span key={k} className={k === "contacts" ? "co-lright" : ""}>{columnLabel(k)}</span>)}
          </div>
          <div className="co-list">
            {shown.map((c) => {
              const people = contactsOf(c.id!);
              const isOpen = open === c.id;
              return (
                <div className="co-item" key={c.id}>
                  <div className="co-lrow" role="button" tabIndex={0}
                    style={{ gridTemplateColumns: `2.4fr ${activeColumns.map(() => "1.4fr").join(" ")}` }}
                    onClick={() => setEditing(structuredClone(c))}
                    onKeyDown={(e) => { if (e.key === "Enter") setEditing(structuredClone(c)); }}>
                    <span className="co-lcell co-lid">
                      <span className="co-avatar">{(c.name || "?").slice(0, 1).toUpperCase()}</span>
                      <span className="co-lid-text">
                        <span className="co-lname-row">
                          <span className="co-lname">{c.name}</span>
                          {(() => { const r = relOf(c); return r === "none" ? null : (
                            <span className={`co-rel co-rel-${r}`}>{r === "client" ? "Client" : "In tracking"}</span>
                          ); })()}
                        </span>
                        {c.legal_name && <span className="co-lsub">{c.legal_name}</span>}
                      </span>
                    </span>
                    {activeColumns.map((k) => <span key={k} className="co-lcell">{renderCell(c, k)}</span>)}
                  </div>

                  {isOpen && (
                    <div className="co-people">
                      {people.length === 0 ? (
                        <p className="co-people-empty">No contacts linked to this company yet.</p>
                      ) : people.map((ct) => (
                        <div className="co-person" key={ct.id}>
                          <span className="co-person-av">{(ct.first_name || "?").slice(0, 1).toUpperCase()}</span>
                          <span className="co-person-main">
                            <span className="co-person-name">
                              {[ct.first_name, ct.last_name].filter(Boolean).join(" ")}
                              {ct.is_billing && <i className="co-person-bill" title="Billing contact">€</i>}
                            </span>
                            <span className="co-person-pos">{ct.position || "No position"}</span>
                          </span>
                          <span className="co-person-contact">
                            {ct.email && <a href={`mailto:${ct.email}`} onClick={(e) => e.stopPropagation()}>{ct.email}</a>}
                            {ct.phone && <em>{ct.phone}</em>}
                          </span>
                          <button className="co-person-go"
                            onClick={() => navigate("/contacts", { state: { focusContactId: ct.id } })}>
                            Edit contact
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M12 5l7 7-7 7" /></svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {editing && (
        <CompanyEditor
          company={editing}
          employees={employees}
          fields={fields}
          contacts={contacts}
          contactFields={contactFields}
          canAssign={lead}
          assigned={assignees[editing.id!] ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
          onDeleted={async () => { setEditing(null); await reload(); }}
        />
      )}

      {showFieldSettings && (
        <FieldSettings
          fields={fields}
          availableColumns={availableColumns}
          columns={activeColumns}
          onColumns={setColumnsPersist}
          onClose={() => setShowFieldSettings(false)}
          onChanged={async () => { setFields(await listCompanyFields().catch(() => [])); }}
        />
      )}
    </div>
  );
}

// Searchable dropdown to link an existing contact to the company.
function ContactPicker({ contacts, onPick }: { contacts: Contact[]; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const name = (ct: Contact) => [ct.first_name, ct.last_name].filter(Boolean).join(" ") || "Unnamed";
  const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const nq = norm(q.trim());
  const results = !nq ? contacts
    : contacts.filter((ct) => norm(`${name(ct)} ${ct.email ?? ""} ${ct.position ?? ""}`).includes(nq));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => { if (open) { setQ(""); setActive(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => { setActive(0); }, [q]);

  const pick = (ct: Contact) => { if (ct?.id) { onPick(ct.id); setOpen(false); } };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (results[active]) pick(results[active]); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };

  return (
    <div className="co-cc-pick co-pick" ref={wrapRef}>
      <button type="button" className={`co-pick-trigger ${open ? "is-open" : ""}`} onClick={() => setOpen((v) => !v)}>
        <span>+ Link existing contact</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="co-pick-menu">
          <div className="co-pick-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search contacts…" />
          </div>
          <div className="co-pick-list">
            {results.length === 0 && <p className="co-pick-empty">No contacts match.</p>}
            {results.map((ct, i) => (
              <button type="button" key={ct.id}
                className={`co-pick-opt ${i === active ? "is-active" : ""}`}
                onMouseEnter={() => setActive(i)} onClick={() => pick(ct)}>
                <span className="co-pick-avatar">{(ct.first_name?.[0] ?? "?").toUpperCase()}</span>
                <span className="co-pick-txt">
                  <span className="co-pick-name">{name(ct)}{ct.is_billing && <i className="co-cc-billing" title="Billing contact">€</i>}</span>
                  <span className="co-pick-meta">{[ct.position, ct.email].filter(Boolean).join(" · ") || "—"}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Inline "create a new contact" form used inside CompanyEditor.
function NewContactInline({ fields, onAdd, onCancel }: {
  fields: ContactField[];
  onAdd: (c: Contact) => void;
  onCancel: () => void;
}) {
  const [c, setC] = useState<Contact>({
    first_name: "", last_name: "", position: "", email: "", phone: "", is_billing: false, notes: "", companyIds: [], custom: {},
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Contact>) => setC((x) => ({ ...x, ...patch }));
  const setCustom = (id: string, v: any) => setC((x) => ({ ...x, custom: { ...(x.custom ?? {}), [id]: v } }));
  const customVal = (id: string) => (c.custom ?? {})[id];

  const add = () => {
    if (!c.first_name.trim()) { setErr("A first name is required."); return; }
    for (const f of fields) {
      if (!f.required) continue;
      const v = customVal(f.id);
      const empty = v == null || v === "" || (f.type === "boolean" && v === false);
      if (empty) { setErr(`"${f.label}" is required.`); return; }
    }
    onAdd(c);
  };

  return (
    <div className="co-cc-form">
      <div className="dw-grid">
        <div className="dw-f"><label>First name *</label>
          <input autoFocus value={c.first_name} onChange={(e) => set({ first_name: e.target.value })} />
        </div>
        <div className="dw-f"><label>Last name</label>
          <input value={c.last_name ?? ""} onChange={(e) => set({ last_name: e.target.value })} />
        </div>
        <div className="dw-f"><label>Position</label>
          <input value={c.position ?? ""} onChange={(e) => set({ position: e.target.value })} />
        </div>
        <div className="dw-f"><label>Email</label>
          <input value={c.email ?? ""} onChange={(e) => set({ email: e.target.value })} />
        </div>
        <div className="dw-f"><label>Phone</label>
          <input value={c.phone ?? ""} onChange={(e) => set({ phone: e.target.value })} />
        </div>
        <div className="dw-f">
          <label>Billing contact</label>
          <button type="button" role="switch" aria-checked={c.is_billing}
            className={`dw-switch ${c.is_billing ? "on" : ""}`} onClick={() => set({ is_billing: !c.is_billing })}>
            <span className="dw-switch-knob" />
          </button>
        </div>
        {fields.map((f) => (
          <div className="dw-f dw-col2" key={f.id}>
            <label>{f.label}{f.required && <span className="dw-req"> *</span>}</label>
            {f.type === "text" && <input value={customVal(f.id) ?? ""} onChange={(e) => setCustom(f.id, e.target.value)} />}
            {f.type === "number" && <input type="number" value={customVal(f.id) ?? ""} onFocus={(e) => e.target.select()}
              onChange={(e) => setCustom(f.id, e.target.value === "" ? "" : Number(e.target.value))} />}
            {f.type === "date" && <DatePicker value={customVal(f.id) ?? ""} onChange={(v) => setCustom(f.id, v)} />}
            {f.type === "boolean" && (
              <button type="button" role="switch" aria-checked={!!customVal(f.id)}
                className={`dw-switch ${customVal(f.id) ? "on" : ""}`} onClick={() => setCustom(f.id, !customVal(f.id))}>
                <span className="dw-switch-knob" />
              </button>
            )}
            {f.type === "select" && (
              <Select value={customVal(f.id) ?? ""} onChange={(v) => setCustom(f.id, v)} placeholder="Select…"
                options={[{ value: "", label: "—" }, ...f.options.map((o) => ({ value: o, label: o }))]} />
            )}
          </div>
        ))}
      </div>
      {err && <p className="dw-err" style={{ marginTop: 10 }}>{err}</p>}
      <div className="co-cc-form-foot">
        <button type="button" className="dw-cancel" onClick={onCancel}>Cancel</button>
        <button type="button" className="dw-save" onClick={add}>Add contact</button>
      </div>
    </div>
  );
}

function CompanyEditor({ company, employees, fields, contacts, contactFields, canAssign, assigned, onClose, onSaved, onDeleted }: {
  company: Company; employees: Employee[]; fields: CompanyField[]; contacts: Contact[]; contactFields: ContactField[]; canAssign: boolean; assigned: string[];
  onClose: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const [c, setC] = useState<Company>(company);
  // Contacts linked to this company, edited live in the drawer.
  const linkedInitial = company.id ? contacts.filter((ct) => ct.companyIds.includes(company.id!)) : [];
  const [linked, setLinked] = useState<Contact[]>(linkedInitial);
  // New contacts created inline (not yet in the DB); saved when the company saves.
  const [newContacts, setNewContacts] = useState<Contact[]>([]);
  const [addingContact, setAddingContact] = useState(false);
  const [pendingRemoveIds, setPendingRemoveIds] = useState<string[]>([]);
  const [who, setWho] = useState<string[]>(assigned);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Company>) => setC((x) => ({ ...x, ...patch }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setCustom = (fieldId: string, value: any) =>
    setC((x) => ({ ...x, custom: { ...(x.custom ?? {}), [fieldId]: value } }));
  const customVal = (fieldId: string) => (c.custom ?? {})[fieldId];

  const contactName = (ct: Contact) => [ct.first_name, ct.last_name].filter(Boolean).join(" ") || "Unnamed";
  // Existing contacts not yet linked here, for the "add existing" picker.
  const linkedIds = new Set(linked.map((x) => x.id));
  const attachable = contacts.filter((ct) => ct.id && !linkedIds.has(ct.id) && !pendingRemoveIds.includes(ct.id!));
  const attachExisting = (id: string) => {
    const ct = contacts.find((x) => x.id === id); if (!ct) return;
    setLinked((xs) => [...xs, ct]);
    setPendingRemoveIds((xs) => xs.filter((x) => x !== id));
  };
  const detachExisting = (id: string) => {
    setLinked((xs) => xs.filter((x) => x.id !== id));
    if (contacts.some((x) => x.id === id)) setPendingRemoveIds((xs) => [...xs, id]);
  };
  const removeNewContact = (i: number) => setNewContacts((xs) => xs.filter((_, j) => j !== i));

  const save = async () => {
    if (!c.name.trim()) { setErr("Give the company a name."); return; }
    for (const f of fields) {
      if (!f.required) continue;
      const v = customVal(f.id);
      const empty = v == null || v === "" || (f.type === "boolean" && v === false);
      if (empty) { setErr(`"${f.label}" is required.`); return; }
    }
    setBusy(true); setErr(null);
    const e = await saveCompany(c);
    if (e) { setBusy(false); setErr(e); return; }
    // saveCompany sets c.id on insert; use it to link contacts.
    const companyId = c.id;
    if (companyId) {
      await setCompanyAssignees(companyId, who).catch(() => {});
      // Newly created contacts: save each, linked to this company.
      for (const nc of newContacts) {
        const err = await saveContact({ ...nc, companyIds: [companyId] });
        if (err) { setBusy(false); setErr(`Contact "${contactName(nc)}": ${err}`); return; }
      }
      // Existing contacts newly attached here: add this company to their links.
      for (const ct of linked) {
        if (!ct.id) continue;
        if (!ct.companyIds.includes(companyId)) {
          const err = await saveContact({ ...ct, companyIds: [...ct.companyIds, companyId] });
          if (err) { setBusy(false); setErr(`Contact "${contactName(ct)}": ${err}`); return; }
        }
      }
      // Contacts detached here: drop this company from their links.
      for (const id of pendingRemoveIds) {
        const ct = contacts.find((x) => x.id === id);
        if (ct && ct.companyIds.includes(companyId)) {
          const err = await saveContact({ ...ct, companyIds: ct.companyIds.filter((x) => x !== companyId) });
          if (err) { setBusy(false); setErr(`Contact "${contactName(ct)}": ${err}`); return; }
        }
      }
    }
    setBusy(false);
    onSaved();
  };
  const remove = async () => {
    if (!c.id) return onClose();
    if (!confirm(`Delete "${c.name}" permanently?`)) return;
    await deleteCompany(c.id);
    onDeleted();
  };

  return (
    <div className="dw-backdrop" onMouseDown={onClose}>
      <div className="dw" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dw-head">
          <div>
            <span className="dw-eyebrow">{c.id ? "Edit company" : "New company"}</span>
            <h2 className="dw-title">{c.name || "Untitled company"}</h2>
          </div>
          <button className="dw-x" onClick={onClose}>×</button>
        </div>

        <div className="dw-body">
          <div className="dw-sec">
            <p className="dw-sec-title">Company</p>
            <div className="dw-grid">
              <div className="dw-f dw-col2"><label>Common name *</label>
                <input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Acme" />
              </div>
              <div className="dw-f dw-col2"><label>Legal name</label>
                <input value={c.legal_name ?? ""} onChange={(e) => set({ legal_name: e.target.value })} placeholder="e.g. Acme Holdings S.L." />
              </div>
              <div className="dw-f"><label>VAT / Tax ID</label>
                <input value={c.vat_number ?? ""} onChange={(e) => set({ vat_number: e.target.value })} />
              </div>
              <div className="dw-f"><label>Registration nº</label>
                <input value={c.reg_number ?? ""} onChange={(e) => set({ reg_number: e.target.value })} />
              </div>
              <div className="dw-f dw-col2"><label>Website</label>
                <input value={c.website ?? ""} onChange={(e) => set({ website: e.target.value })} placeholder="https://" />
              </div>
              <div className="dw-f"><label>Email</label>
                <input value={c.email ?? ""} onChange={(e) => set({ email: e.target.value })} />
              </div>
              <div className="dw-f"><label>Phone</label>
                <input value={c.phone ?? ""} onChange={(e) => set({ phone: e.target.value })} />
              </div>
            </div>
          </div>

          <div className="dw-sec">
            <p className="dw-sec-title">Address</p>
            <div className="dw-grid">
              <div className="dw-f dw-col2"><label>Street</label>
                <input value={c.street ?? ""} onChange={(e) => set({ street: e.target.value })} />
              </div>
              <div className="dw-f"><label>Number</label>
                <input value={c.addr_number ?? ""} onChange={(e) => set({ addr_number: e.target.value })} />
              </div>
              <div className="dw-f"><label>Details (floor, door…)</label>
                <input value={c.addr_details ?? ""} onChange={(e) => set({ addr_details: e.target.value })} />
              </div>
              <div className="dw-f"><label>Postal code</label>
                <input value={c.postal_code ?? ""} onChange={(e) => set({ postal_code: e.target.value })} />
              </div>
              <div className="dw-f"><label>City</label>
                <input value={c.city ?? ""} onChange={(e) => set({ city: e.target.value })} />
              </div>
              <div className="dw-f"><label>Province / State</label>
                <input value={c.province ?? ""} onChange={(e) => set({ province: e.target.value })} />
              </div>
              <div className="dw-f"><label>Country</label>
                <input value={c.country ?? ""} onChange={(e) => set({ country: e.target.value })} />
              </div>
            </div>
          </div>

          <div className="dw-sec">
            <div className="dw-sec-head-row">
              <p className="dw-sec-title" style={{ margin: 0 }}>Contacts</p>
              <span className="co-cc-count">{linked.length + newContacts.length}</span>
            </div>

            {(linked.length + newContacts.length) === 0 && !addingContact && (
              <p className="dw-empty-hint" style={{ marginTop: 0 }}>No contacts yet. Link an existing one or create a new contact.</p>
            )}

            <div className="co-cc-list">
              {linked.map((ct) => (
                <div className="co-cc-row" key={ct.id}>
                  <span className="co-cc-avatar">{(ct.first_name?.[0] ?? "?").toUpperCase()}</span>
                  <div className="co-cc-main">
                    <span className="co-cc-name">{contactName(ct)}{ct.is_billing && <i className="co-cc-billing" title="Billing contact">€</i>}</span>
                    <span className="co-cc-meta">{[ct.position, ct.email].filter(Boolean).join(" · ") || "—"}</span>
                  </div>
                  <button type="button" className="co-cc-x" aria-label="Unlink contact" onClick={() => detachExisting(ct.id!)}>×</button>
                </div>
              ))}
              {newContacts.map((ct, i) => (
                <div className="co-cc-row" key={`new-${i}`}>
                  <span className="co-cc-avatar co-cc-avatar-new">{(ct.first_name?.[0] ?? "+").toUpperCase()}</span>
                  <div className="co-cc-main">
                    <span className="co-cc-name">{contactName(ct)}<i className="co-cc-newtag">New</i></span>
                    <span className="co-cc-meta">{[ct.position, ct.email].filter(Boolean).join(" · ") || "—"}</span>
                  </div>
                  <button type="button" className="co-cc-x" aria-label="Remove contact" onClick={() => removeNewContact(i)}>×</button>
                </div>
              ))}
            </div>

            {addingContact ? (
              <NewContactInline
                fields={contactFields}
                onCancel={() => setAddingContact(false)}
                onAdd={(ct) => { setNewContacts((xs) => [...xs, ct]); setAddingContact(false); }}
              />
            ) : (
              <div className="co-cc-actions">
                {attachable.length > 0 && (
                  <ContactPicker contacts={attachable} onPick={attachExisting} />
                )}
                <button type="button" className="co-cc-new-btn" onClick={() => setAddingContact(true)}>+ New contact</button>
              </div>
            )}
          </div>

          {canAssign && (
            <div className="dw-sec">
              <p className="dw-sec-title">Who can see this company</p>
              <div className="dw-chips">
                {who.map((id) => (
                  <span key={id} className="dw-chip">
                    {employees.find((e) => e.id === id)?.name ?? "Unknown"}
                    <button onClick={() => setWho((xs) => xs.filter((x) => x !== id))} aria-label="Remove">×</button>
                  </span>
                ))}
              </div>
              {who.length === 0 && (
                <p className="dw-empty-hint">Only boss and sales managers can see it. Add people to widen access.</p>
              )}
              {employees.filter((e) => !who.includes(e.id)).length > 0 && (
                <Select value="" onChange={(v) => v && setWho((xs) => [...xs, v])} placeholder="+ Give access to"
                  options={employees.filter((e) => !who.includes(e.id)).map((e) => ({ value: e.id, label: e.name }))} />
              )}
            </div>
          )}

          {fields.length > 0 && (
            <div className="dw-sec">
              <p className="dw-sec-title">Additional details</p>
              <div className="dw-grid">
                {fields.map((f) => (
                  <div className="dw-f dw-col2" key={f.id}>
                    <label>{f.label}{f.required && <span className="dw-req"> *</span>}</label>
                    {f.type === "text" && (
                      <input value={customVal(f.id) ?? ""} onChange={(e) => setCustom(f.id, e.target.value)} />
                    )}
                    {f.type === "number" && (
                      <input type="number" value={customVal(f.id) ?? ""} onFocus={(e) => e.target.select()}
                        onChange={(e) => setCustom(f.id, e.target.value === "" ? "" : Number(e.target.value))} />
                    )}
                    {f.type === "date" && (
                      <DatePicker value={customVal(f.id) ?? ""} onChange={(v) => setCustom(f.id, v)} />
                    )}
                    {f.type === "boolean" && (
                      <button type="button" role="switch" aria-checked={!!customVal(f.id)}
                        className={`dw-switch ${customVal(f.id) ? "on" : ""}`}
                        onClick={() => setCustom(f.id, !customVal(f.id))}>
                        <span className="dw-switch-knob" />
                      </button>
                    )}
                    {f.type === "select" && (
                      <Select value={customVal(f.id) ?? ""} onChange={(v) => setCustom(f.id, v)}
                        placeholder="Select…"
                        options={[{ value: "", label: "—" }, ...f.options.map((o) => ({ value: o, label: o }))]} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="dw-sec">
            <p className="dw-sec-title">Notes</p>
            <textarea className="dw-area" value={c.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="Anything worth remembering about this company…" />
          </div>

          {err && <p className="dw-err">{err}</p>}
        </div>

        <div className="dw-foot">
          {c.id && <button className="dw-del" onClick={remove}>Delete</button>}
          <div className="dw-foot-right">
            <button className="dw-cancel" onClick={onClose}>Cancel</button>
            <button className="dw-save" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save company"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
// ============================ Field settings modal ============================
function FieldSettings({ fields, availableColumns, columns, onColumns, onClose, onChanged }: {
  fields: CompanyField[];
  availableColumns: { key: string; label: string }[];
  columns: string[];
  onColumns: (next: string[]) => void;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [items, setItems] = useState<CompanyField[]>(fields);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CompanyField["type"]>("text");
  const [required, setRequired] = useState(false);
  const [optionsText, setOptionsText] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refresh = async () => { await onChanged(); setItems(await listCompanyFields().catch(() => [])); };
  const add = async () => {
    if (!label.trim()) return;
    setBusy(true);
    const options = type === "select" ? optionsText.split(",").map((s) => s.trim()).filter(Boolean) : [];
    await addCompanyField({ label: label.trim(), type, required, options, sort: items.length });
    setLabel(""); setType("text"); setRequired(false); setOptionsText("");
    await refresh();
    setBusy(false);
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this field? Existing companies keep their stored value but it won't show anymore.")) return;
    await deleteCompanyField(id);
    await refresh();
  };
  const toggleRequired = async (f: CompanyField) => { await updateCompanyField(f.id, { required: !f.required }); await refresh(); };

  const TYPE_LABEL: Record<CompanyField["type"], string> = {
    text: "Text", number: "Number", date: "Date", boolean: "Yes / No", select: "Dropdown",
  };

  return (
    <div className="dw-backdrop" onMouseDown={onClose}>
      <div className="dw dw-narrow" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dw-head">
          <div>
            <span className="dw-eyebrow">Configure</span>
            <h2 className="dw-title">Company fields</h2>
          </div>
          <button className="dw-x" onClick={onClose}>×</button>
        </div>

        <div className="dw-body">
          <div className="dw-sec">
            <p className="dw-sec-title">Overview columns</p>
            <p className="dw-empty-hint" style={{ marginTop: 0 }}>Name is always first. Pick up to 4 more and drag to reorder.</p>
            <div className="cf-cols">
              <div className="cf-col cf-col-fixed"><span className="cf-col-grip">⋮⋮</span>Name<span className="cf-col-tag">fixed</span></div>
              {columns.map((k) => (
                <div key={k}
                  className={`cf-col ${dragKey === k ? "is-dragging" : ""} ${dragOver === k ? "is-over" : ""}`}
                  draggable
                  onDragStart={(e) => { setDragKey(k); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setDragKey(null); setDragOver(null); }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (k !== dragOver) setDragOver(k); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!dragKey || dragKey === k) { setDragKey(null); setDragOver(null); return; }
                    const rect = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY > rect.top + rect.height / 2;
                    const next = columns.filter((x) => x !== dragKey);
                    let idx = next.indexOf(k);
                    if (after) idx += 1;
                    next.splice(idx, 0, dragKey);
                    onColumns(next); setDragKey(null); setDragOver(null);
                  }}>
                  <span className="cf-col-grip">⋮⋮</span>
                  {availableColumns.find((c) => c.key === k)?.label ?? k}
                  <button className="cf-col-x" onClick={() => onColumns(columns.filter((x) => x !== k))} aria-label="Remove column">×</button>
                </div>
              ))}
            </div>
            {columns.length < 4 && availableColumns.some((c) => !columns.includes(c.key)) && (
              <div className="cf-col-add">
                <Select value="" onChange={(v) => v && onColumns([...columns, v])} placeholder="+ Add column"
                  options={[{ value: "", label: "+ Add column" }, ...availableColumns.filter((c) => !columns.includes(c.key)).map((c) => ({ value: c.key, label: c.label }))]} />
              </div>
            )}
          </div>

          <div className="dw-sec">
            <p className="dw-sec-title">Current fields</p>
            {items.length === 0 ? (
              <p className="dw-empty-hint">No custom fields yet. Add one below.</p>
            ) : (
              <div className="cf-list">
                {items.map((f) => (
                  <div className="cf-row" key={f.id}>
                    <div className="cf-row-main">
                      <span className="cf-row-name">{f.label}</span>
                      <span className="cf-row-type">{TYPE_LABEL[f.type]}{f.type === "select" && f.options.length ? ` · ${f.options.length} options` : ""}</span>
                    </div>
                    <button type="button" role="switch" aria-checked={f.required}
                      className={`cf-req ${f.required ? "on" : ""}`} onClick={() => toggleRequired(f)}>Required</button>
                    <button className="cf-del" onClick={() => remove(f.id)} aria-label="Delete field">×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="dw-sec">
            <p className="dw-sec-title">Add a field</p>
            <div className="dw-grid">
              <div className="dw-f dw-col2"><label>Field name</label>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sector, Founded, Key account" />
              </div>
              <div className="dw-f"><label>Type</label>
                <Select value={type} onChange={(v) => setType(v as CompanyField["type"])}
                  options={[
                    { value: "text", label: "Text" }, { value: "number", label: "Number" },
                    { value: "date", label: "Date" }, { value: "boolean", label: "Yes / No" },
                    { value: "select", label: "Dropdown" },
                  ]} />
              </div>
              <div className="dw-f"><label>Required</label>
                <button type="button" role="switch" aria-checked={required}
                  className={`dw-switch ${required ? "on" : ""}`} onClick={() => setRequired((v) => !v)}>
                  <span className="dw-switch-knob" />
                </button>
              </div>
              {type === "select" && (
                <div className="dw-f dw-col2"><label>Options (comma-separated)</label>
                  <input value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder="e.g. SME, Mid-market, Enterprise" />
                </div>
              )}
            </div>
            <button className="dw-save cf-add" onClick={add} disabled={busy || !label.trim()}>{busy ? "Adding…" : "+ Add field"}</button>
          </div>
        </div>

        <div className="dw-foot">
          <div className="dw-foot-right">
            <button className="dw-save" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}