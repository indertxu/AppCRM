/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
import CompanyImport from "./CompanyImport";
import SalesMultiFilter from "../sales/sales/SalesMultiFilter";
import ActionsMenu, { AM_ICON } from "../../framework/ActionsMenu";
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
  const [importing, setImporting] = useState(false);
  const [ctrl1, setCtrl1] = useState<{ field: string; action: string; min?: string; max?: string; values?: string[]; text?: string }>({ field: "", action: "" });
  const [ctrl2, setCtrl2] = useState<{ field: string; action: string; min?: string; max?: string; values?: string[]; text?: string }>({ field: "", action: "" });
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

  // Opened from a company pill on Contacts: jump straight into that company.
  const location = useLocation();
  useEffect(() => {
    const id = (location.state as any)?.focusCompanyId;
    if (!id || companies.length === 0) return;
    const c = companies.find((x) => x.id === id);
    if (c) setEditing(structuredClone(c));
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, companies]);

  const lead = isSalesLead(me);

  // ---- Compound filter + sort controls ----
  // Fixed fields: text ones, short lists (picked from the values you have), and
  // the import provenance (stamped by the database, filterable, never shown).
  const fixedFields: { key: string; label: string; type: "text" | "number" | "date" | "select" }[] = [
    { key: "name", label: "Name", type: "text" },
    { key: "legal_name", label: "Legal name", type: "text" },
    { key: "vat_number", label: "VAT / Tax ID", type: "text" },
    { key: "website", label: "Website", type: "text" },
    { key: "email", label: "Email", type: "text" },
    { key: "phone", label: "Phone", type: "text" },
    { key: "postal_code", label: "Postal code", type: "text" },
    { key: "city", label: "City", type: "select" },
    { key: "province", label: "Province / state", type: "select" },
    { key: "country", label: "Country", type: "select" },
    { key: "contacts_count", label: "Number of contacts", type: "number" },
    { key: "imported_by", label: "Imported by", type: "select" },
    { key: "imported_at", label: "Imported on", type: "date" },
  ];
  const filterFieldOptions = [
    { value: "", label: "No filter" },
    ...fixedFields.map((f) => ({ value: f.key, label: f.label })),
    ...fields.map((f) => ({ value: f.id, label: f.label })),
  ];
  const fieldById = (id: string) => fields.find((f) => f.id === id);
  const fieldType = (key: string): "text" | "number" | "date" | "boolean" | "select" =>
    fixedFields.find((f) => f.key === key)?.type ?? fieldById(key)?.type ?? "text";
  const valueOf = (c: Company, key: string): any => {
    if (key === "contacts_count") return counts[c.id as string] ?? 0;
    if (fixedFields.some((f) => f.key === key)) return (c as any)[key] ?? "";
    return (c.custom ?? {})[key];
  };
  // What a filter can do with a field, based on its type (the first one is the default).
  const actionsFor = (key: string): { value: string; label: string }[] => {
    if (!key) return [];
    const t = fieldType(key);
    const blanks = [{ value: "has", label: "Has a value" }, { value: "empty", label: "Is empty" }];
    if (key === "imported_by") return [{ value: "in", label: "Is one of…" }, { value: "has", label: "Was imported" }, { value: "empty", label: "Added by hand" }];
    if (t === "select") return [{ value: "in", label: "Is one of…" }, ...blanks];
    if (t === "boolean") return [{ value: "only_yes", label: "Yes" }, { value: "only_no", label: "No" }];
    if (t === "number") return [{ value: "range", label: "Between…" }, { value: "desc", label: "High → low" }, { value: "asc", label: "Low → high" }, ...(key === "contacts_count" ? [] : blanks)];
    if (t === "date") return [
      { value: "last30", label: "Last 30 days" }, { value: "this_month", label: "This month" }, { value: "this_year", label: "This year" },
      { value: "next30", label: "Next 30 days" }, { value: "past", label: "Before today" }, { value: "custom", label: "Between dates…" },
      { value: "desc", label: "Newest first" }, { value: "asc", label: "Oldest first" }, ...blanks,
    ];
    return [{ value: "contains", label: "Contains…" }, { value: "asc", label: "A → Z" }, { value: "desc", label: "Z → A" }, ...blanks];
  };
  /** Choices for "Is one of…": people who imported, the values you have for city/province/country, or a field's options. */
  const choicesFor = (key: string): { value: string; label: string }[] => {
    if (key === "imported_by") return employees.filter((e) => companies.some((c) => (c as any).imported_by === e.id)).map((e) => ({ value: e.id, label: e.name }));
    if (key === "city" || key === "province" || key === "country")
      return [...new Set(companies.map((c) => String((c as any)[key] ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
    return (fieldById(key)?.options ?? []).map((o) => ({ value: o, label: o }));
  };
  const dayIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dateWindow = (action: string, ctrl: { min?: string; max?: string }): [string, string] | null => {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    if (action === "last30") return [dayIso(new Date(y, m, d - 30)), dayIso(now)];
    if (action === "next30") return [dayIso(now), dayIso(new Date(y, m, d + 30))];
    if (action === "this_month") return [dayIso(new Date(y, m, 1)), dayIso(new Date(y, m + 1, 0))];
    if (action === "this_year") return [`${y}-01-01`, `${y}-12-31`];
    if (action === "past") return ["0000-01-01", dayIso(new Date(y, m, d - 1))];
    if (action === "custom") return [ctrl.min || "0000-01-01", ctrl.max || "9999-12-31"];
    return null;
  };
  const passesFilter = (c: Company, ctrl: { field: string; action: string; min?: string; max?: string; values?: string[]; text?: string }) => {
    if (!ctrl.field || !ctrl.action) return true;
    const v = valueOf(c, ctrl.field);
    const blank = v == null || v === "";
    if (ctrl.action === "has") return !blank;
    if (ctrl.action === "empty") return blank;
    if (ctrl.action === "only_yes") return !!v;
    if (ctrl.action === "only_no") return !v;
    if (ctrl.action === "in") { const picked = ctrl.values ?? []; return !picked.length || picked.includes(String(v ?? "").trim()); }
    if (ctrl.action === "contains") { const t = (ctrl.text ?? "").trim(); return !t || norm(String(v ?? "")).includes(norm(t)); }
    const win = fieldType(ctrl.field) === "date" ? dateWindow(ctrl.action, ctrl) : null;
    if (win) { const d = String(v ?? "").slice(0, 10); return !!d && d >= win[0] && d <= win[1]; }
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
  const cmp = (a: Company, b: Company, ctrl: { field: string; action: string; min?: string; max?: string; values?: string[]; text?: string }) => {
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

  // Relationship filter. "tracking" / "notracking" look only at sales
  // trackings (a client can also be in one); "none" means neither.
  const inTracking = (c: Company) => !!(rel && c.id && rel.trackingCompanyIds.has(c.id));
  const relMatches = (c: Company, f: string) => {
    if (f === "tracking") return inTracking(c);
    if (f === "notracking") return !inTracking(c);
    return relOf(c) === f;
  };

  const shown = companies.filter((c) => {
    // Sales people only see the companies they have been assigned to.
    if (!lead && me && !(assignees[c.id!] ?? []).includes(me.id)) return false;
    if (!passesFilter(c, ctrl1)) return false;
    if (!passesFilter(c, ctrl2)) return false;
    if (fRel && !relMatches(c, fRel)) return false;
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
  // The contacts counter + dropdown always sits at the far right of the card,
  // in its own narrow column, whatever position it has in the column settings.
  const dataColumns = activeColumns.filter((k) => k !== "contacts");
  const showContacts = activeColumns.includes("contacts");
  const rowGrid = ["minmax(0, 2.4fr)", ...dataColumns.map(() => "minmax(0, 1.4fr)"), ...(showContacts ? ["auto"] : [])].join(" ");
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
              { value: "tracking", label: "In sales tracking" },
              { value: "notracking", label: "No sales tracking" },
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
              {ctl.c.action === "in" && (
                <div className="co-fvals">
                  <SalesMultiFilter values={ctl.c.values ?? []} onChange={(v) => ctl.set({ ...ctl.c, values: v })}
                    options={choicesFor(ctl.c.field)} placeholder="Choose…" searchFrom={7}
                    noun={ctl.c.field === "imported_by" ? "people" : ctl.c.field === "city" ? "cities" : ctl.c.field === "country" ? "countries" : "options"} />
                </div>
              )}
              {ctl.c.action === "contains" && (
                <input className="co-ftext" value={ctl.c.text ?? ""} onChange={(e) => ctl.set({ ...ctl.c, text: e.target.value })} placeholder="Text…" />
              )}
              {ctl.c.action === "custom" && (
                <div className="co-fdates">
                  <DatePicker value={ctl.c.min ?? ""} onChange={(d) => ctl.set({ ...ctl.c, min: d })} placeholder="From" />
                  <span className="co-range-sep">–</span>
                  <DatePicker value={ctl.c.max ?? ""} onChange={(d) => ctl.set({ ...ctl.c, max: d })} placeholder="To" />
                </div>
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
        <ActionsMenu items={[
          { key: "new", group: "Create", label: "New company", hint: "Add one company by hand", icon: AM_ICON.plus, primary: true, tone: "green", shortcut: "N", onSelect: () => setEditing(empty()) },
          { key: "import", group: "Data", label: "Import", hint: "Companies from Excel or CSV, with their contacts", icon: AM_ICON.import, tone: "blue", shortcut: "I", onSelect: () => setImporting(true) },
          { key: "fields", group: "Setup", label: "Fields & columns", hint: "Custom fields and what the list shows", icon: AM_ICON.fields, tone: "amber", shortcut: "F", onSelect: () => setShowFieldSettings(true) },
        ]} />
      </header>

      {shown.length === 0 ? (
        <p className="cl-hint">{companies.length === 0 ? "No companies yet. Create your first one." : "No companies match your search."}</p>
      ) : (
        <div className="co-scroll">
          <div className="co-lrow co-lhead" style={{ gridTemplateColumns: rowGrid }}>
            <span>Company</span>
            {dataColumns.map((k) => <span key={k} className="co-lhcell">{columnLabel(k)}</span>)}
            {showContacts && <span className="co-lright co-lcontacts">{columnLabel("contacts")}</span>}
          </div>
          <div className="co-list">
            {shown.map((c) => {
              const people = contactsOf(c.id!);
              const isOpen = open === c.id;
              return (
                <div className="co-item" key={c.id}>
                  <div className="co-lrow" role="button" tabIndex={0}
                    style={{ gridTemplateColumns: rowGrid }}
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
                    {dataColumns.map((k) => <span key={k} className="co-lcell">{renderCell(c, k)}</span>)}
                    {showContacts && <span className="co-lcell co-lcontacts">{renderCell(c, "contacts")}</span>}
                  </div>

                  {isOpen && (
                    <div className="co-people">
                      {people.length === 0 ? (
                        <p className="co-people-empty">No contacts linked to this company yet.</p>
                      ) : people.map((ct) => (
                        <div className="co-person is-link" key={ct.id} role="button" tabIndex={0} title="Open this contact"
                          onClick={() => navigate("/contacts", { state: { focusContactId: ct.id } })}
                          onKeyDown={(e) => { if (e.key === "Enter") navigate("/contacts", { state: { focusContactId: ct.id } }); }}>
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
                            onClick={(e) => { e.stopPropagation(); navigate("/contacts", { state: { focusContactId: ct.id } }); }}>
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
          onOpenContact={(id) => navigate("/contacts", { state: { focusContactId: id } })}
        />
      )}

      {importing && (
        <CompanyImport
          fields={fields}
          onClose={() => setImporting(false)}
          onDone={async () => { await reload(); }}
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

function CompanyEditor({ company, employees, fields, contacts, contactFields, canAssign, assigned, onClose, onSaved, onDeleted, onOpenContact }: {
  company: Company; employees: Employee[]; fields: CompanyField[]; contacts: Contact[]; contactFields: ContactField[]; canAssign: boolean; assigned: string[];
  onClose: () => void; onSaved: () => void; onDeleted: () => void;
  /** Open a contact on the Contacts page. */
  onOpenContact: (id: string) => void;
}) {
  const [c, setC] = useState<Company>(company);
  const [initial] = useState(() => JSON.stringify(company));
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

  const { closing, close } = useDrawerClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

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
    close(onSaved);
  };
  const remove = async () => {
    if (!c.id) return close();
    if (!confirm(`Delete "${c.name}" permanently?`)) return;
    await deleteCompany(c.id);
    close(onDeleted);
  };

  // ---- the panel: a hero on top, a section index on the left that follows the scroll ----
  const { bodyRef, active, goTo } = useDrawerSections("company");
  const peopleCount = linked.length + newContacts.length;
  const site = (c.website ?? "").trim();
  const siteHref = site ? (/^https?:\/\//i.test(site) ? site : `https://${site}`) : "";
  const sections: DwNavItem[] = [
    { k: "company", label: "Company", icon: "id" },
    { k: "reach", label: "Contact details", icon: "mail" },
    { k: "address", label: "Address", icon: "pin" },
    { k: "people", label: "Contacts", icon: "users", count: peopleCount },
    ...(canAssign ? [{ k: "access", label: "Visibility", icon: "lock", count: who.length }] : []),
    ...(fields.length ? [{ k: "custom", label: "Additional details", icon: "sliders" }] : []),
    { k: "notes", label: "Notes", icon: "note" },
  ];

  return (
    <div className={`dw-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={() => close()}>
      <div className="dw is-wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={c.name || "New company"}>
        <header className="dw-hero">
          <span className="dw-hero-av">{(c.name || "+").trim().slice(0, 1).toUpperCase()}</span>
          <div className="dw-hero-txt">
            <span className="dw-eyebrow">{c.id ? "Company" : "New company"}</span>
            <h2 className="dw-title">{c.name || "New company"}</h2>
            <p className="dw-hero-sub">{[c.legal_name, c.vat_number].filter(Boolean).join(" · ") || "Fill in the details below"}</p>
            <div className="dw-hero-tags">
              {site && <a className="dw-tag" href={siteHref} target="_blank" rel="noreferrer"><DwIcon name="link" />{site.replace(/^https?:\/\//i, "").replace(/\/$/, "")}</a>}
              {c.email && <a className="dw-tag" href={`mailto:${c.email}`}><DwIcon name="mail" />{c.email}</a>}
              {c.phone && <a className="dw-tag" href={`tel:${c.phone.replace(/\s+/g, "")}`}><DwIcon name="phone" />{c.phone}</a>}
              {(c.city || c.country) && <span className="dw-tag"><DwIcon name="pin" />{[c.city, c.country].filter(Boolean).join(", ")}</span>}
              <button type="button" className="dw-tag" onClick={() => goTo("people")}><DwIcon name="users" />{peopleCount} {peopleCount === 1 ? "contact" : "contacts"}</button>
            </div>
          </div>
          <button className="dw-x" onClick={() => close()} aria-label="Close">×</button>
        </header>

        <div className="dw-layout">
          <DwNav items={sections} active={active} onGo={goTo} />

          <div className="dw-body" ref={bodyRef}>
            <section className="dw-sec" data-sec="company" data-tone="green">
              <DwSecHead icon="id" title="Company" hint="Its name and how it is registered" />
              <div className="dw-grid">
                <div className="dw-f"><label>Common name<span className="dw-req"> *</span></label>
                  <input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Acme" />
                </div>
                <div className="dw-f"><label>Legal name</label>
                  <input value={c.legal_name ?? ""} onChange={(e) => set({ legal_name: e.target.value })} placeholder="e.g. Acme Holdings S.L." />
                </div>
                <div className="dw-f"><label>VAT / Tax ID</label>
                  <input value={c.vat_number ?? ""} onChange={(e) => set({ vat_number: e.target.value })} placeholder="e.g. B12345678" />
                </div>
                <div className="dw-f"><label>Registration nº</label>
                  <input value={c.reg_number ?? ""} onChange={(e) => set({ reg_number: e.target.value })} />
                </div>
              </div>
            </section>

            <section className="dw-sec" data-sec="reach" data-tone="blue">
              <DwSecHead icon="mail" title="Contact details" hint="Website and the company's general email and phone" />
              <div className="dw-grid">
                <div className="dw-f dw-col2"><label>Website</label>
                  <input value={c.website ?? ""} onChange={(e) => set({ website: e.target.value })} placeholder="https://" />
                </div>
                <div className="dw-f"><label>Email</label>
                  <input type="email" value={c.email ?? ""} onChange={(e) => set({ email: e.target.value })} placeholder="info@company.com" />
                </div>
                <div className="dw-f"><label>Phone</label>
                  <input value={c.phone ?? ""} onChange={(e) => set({ phone: e.target.value })} placeholder="+34 900 000 000" />
                </div>
              </div>
            </section>

            <section className="dw-sec" data-sec="address" data-tone="amber">
              <DwSecHead icon="pin" title="Address" hint="Where the company is based" />
              <div className="dw-grid is-3">
                <div className="dw-f dw-col2"><label>Street</label>
                  <input value={c.street ?? ""} onChange={(e) => set({ street: e.target.value })} placeholder="e.g. Paseo de la Castellana" />
                </div>
                <div className="dw-f"><label>Number</label>
                  <input value={c.addr_number ?? ""} onChange={(e) => set({ addr_number: e.target.value })} placeholder="e.g. 95" />
                </div>
                <div className="dw-f"><label>Details (floor, door…)</label>
                  <input value={c.addr_details ?? ""} onChange={(e) => set({ addr_details: e.target.value })} placeholder="e.g. 3º B" />
                </div>
                <div className="dw-f"><label>Postal code</label>
                  <input value={c.postal_code ?? ""} onChange={(e) => set({ postal_code: e.target.value })} placeholder="e.g. 28046" />
                </div>
                <div className="dw-f"><label>City</label>
                  <input value={c.city ?? ""} onChange={(e) => set({ city: e.target.value })} placeholder="e.g. Madrid" />
                </div>
                <div className="dw-f"><label>Province / State</label>
                  <input value={c.province ?? ""} onChange={(e) => set({ province: e.target.value })} />
                </div>
                <div className="dw-f dw-col2"><label>Country</label>
                  <input value={c.country ?? ""} onChange={(e) => set({ country: e.target.value })} />
                </div>
              </div>
            </section>

            <section className="dw-sec" data-sec="people" data-tone="indigo">
              <DwSecHead icon="users" title="Contacts" hint="People who work here — link existing ones or create new"
                aside={<span className="dw-pill">{peopleCount}</span>} />

              {peopleCount === 0 && !addingContact && (
                <p className="dw-empty-hint">No contacts yet. Link an existing one or create a new contact.</p>
              )}

              <div className="co-cc-list">
                {linked.map((ct) => (
                  <div className="co-cc-row is-link" key={ct.id}>
                    <span className="co-cc-avatar">{(ct.first_name?.[0] ?? "?").toUpperCase()}</span>
                    <button type="button" className="co-cc-main" title="Open this contact"
                      onClick={() => { if ((JSON.stringify(c) !== initial || newContacts.length || pendingRemoveIds.length) && !confirm("Leave this company without saving your changes?")) return; close(() => onOpenContact(ct.id!)); }}>
                      <span className="co-cc-name">{contactName(ct)}{ct.is_billing && <i className="co-cc-billing" title="Billing contact">€</i>}<span className="co-cc-go"><DwIcon name="arrow" /></span></span>
                      <span className="co-cc-meta">{[ct.position, ct.email].filter(Boolean).join(" · ") || "—"}</span>
                    </button>
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
            </section>

            {canAssign && (
              <section className="dw-sec" data-sec="access" data-tone="violet">
                <DwSecHead icon="lock" title="Visibility" hint="Who in the team can see this company" />
                <div className="dw-chips">
                  {who.map((id) => (
                    <span key={id} className="dw-chip">
                      <DwIcon name="person" />{employees.find((e) => e.id === id)?.name ?? "Unknown"}
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
              </section>
            )}

            {fields.length > 0 && (
              <section className="dw-sec" data-sec="custom" data-tone="slate">
                <DwSecHead icon="sliders" title="Additional details" hint="Your own fields — set them up in Fields & columns" />
                <div className="dw-grid">
                  {fields.map((f) => (
                    <div className={`dw-f ${f.type === "text" || f.type === "select" ? "dw-col2" : ""}`} key={f.id}>
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
              </section>
            )}

            <section className="dw-sec" data-sec="notes" data-tone="rose">
              <DwSecHead icon="note" title="Notes" hint="Anything worth remembering about this company" />
              <textarea className="dw-area" value={c.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="History, how you work with them, next steps…" />
            </section>
          </div>
        </div>

        <footer className="dw-foot">
          {c.id && <button className="dw-del" onClick={remove}>Delete</button>}
          <span className={`dw-foot-note ${err ? "is-err" : !c.name.trim() ? "is-warn" : ""}`}>
            {err ?? (!c.name.trim() ? "Give the company a name to save it." : "Nothing is saved until you click Save.")}
          </span>
          <div className="dw-foot-right">
            <button className="dw-cancel" onClick={() => close()}>Cancel</button>
            <button className="dw-save" onClick={save} disabled={busy}>{busy ? "Saving…" : c.id ? "Save changes" : "Create company"}</button>
          </div>
        </footer>
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

// ============================ Side panel building blocks ============================
// (Same look on Contacts and Companies — the styles are in CompaniesPage.css, "Drawer editor".)
const DW_ICON: Record<string, string> = {
  person: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  mail: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 7l9 6 9-6",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  pin: "M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  building: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4M9 9h.01M15 9h.01M9 13h.01M15 13h.01",
  lock: "M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 8 0v4",
  sliders: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  note: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5",
  euro: "M17.5 7.5a6 6 0 1 0 0 9M5 10.5h9M5 13.5h9",
  id: "M3 5h18v14H3zM7 10h4M7 14h6M15 10h2.5M15 14h2.5",
  arrow: "M5 12h13M13 6l6 6-6 6",
};
function DwIcon({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={DW_ICON[name] ?? ""} /></svg>;
}
/** Section title: coloured icon tile, name, one line saying what goes there, optional badge on the right. */
function DwSecHead({ icon, title, hint, aside }: { icon: string; title: string; hint: string; aside?: ReactNode }) {
  return (
    <div className="dw-sec-h">
      <span className="dw-sec-ico"><DwIcon name={icon} /></span>
      <div className="dw-sec-h-txt"><h3>{title}</h3><p>{hint}</p></div>
      {aside && <div className="dw-sec-aside">{aside}</div>}
    </div>
  );
}
interface DwNavItem { k: string; label: string; icon: string; count?: number; warn?: boolean }
/** The section index on the left of the panel. */
function DwNav({ items, active, onGo }: { items: DwNavItem[]; active: string; onGo: (k: string) => void }) {
  // a white pill that slides to the active section
  const ref = useRef<HTMLElement>(null);
  const [ink, setInk] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(".dw-nav-item.is-on");
    if (el) setInk({ top: el.offsetTop, height: el.offsetHeight });
  }, [active, items.length]);
  return (
    <nav className="dw-nav" aria-label="Sections" ref={ref}>
      {ink && <span className="dw-nav-ink" style={{ top: ink.top, height: ink.height }} aria-hidden="true" />}
      <span className="dw-nav-k">Sections</span>
      {items.map((s, i) => (
        <button key={s.k} type="button" className={`dw-nav-item ${active === s.k ? "is-on" : ""}`} style={{ ["--n" as string]: i } as CSSProperties} onClick={() => onGo(s.k)}>
          <i><DwIcon name={s.icon} /></i>
          <span>{s.label}</span>
          {s.warn ? <b className="dw-dot" title="Required fields missing" /> : s.count ? <em>{s.count}</em> : null}
        </button>
      ))}
    </nav>
  );
}
/** Which section is on screen (for the index), and smooth-scroll to one. Sections are marked with data-sec. */
function useDrawerSections(first: string) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(first);
  const lock = useRef<string | null>(null);
  const unlock = useRef(0);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onScroll = () => {
      // while it scrolls to a section picked in the index, the index stays on that one
      if (lock.current) { window.clearTimeout(unlock.current); unlock.current = window.setTimeout(() => { lock.current = null; }, 140); return; }
      const secs = Array.from(body.querySelectorAll<HTMLElement>("[data-sec]"));
      if (!secs.length) return;
      const line = body.getBoundingClientRect().top + 90;
      let cur = secs[0].dataset.sec!;
      for (const s of secs) if (s.getBoundingClientRect().top <= line) cur = s.dataset.sec!;
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) cur = secs[secs.length - 1].dataset.sec!;
      setActive(cur);
    };
    onScroll();
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, []);
  const goTo = (k: string) => {
    setActive(k);
    const body = bodyRef.current;
    const el = body?.querySelector<HTMLElement>(`[data-sec="${k}"]`);
    if (!body || !el) return;
    lock.current = k;
    window.clearTimeout(unlock.current);
    unlock.current = window.setTimeout(() => { lock.current = null; }, 700); // in case nothing needs to scroll
    // scroll only the panel's body (scrollIntoView would also nudge the panel itself)
    const top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 18;
    body.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    // a short glow so the eye lands on it
    el.classList.remove("is-flash"); void el.offsetWidth; el.classList.add("is-flash");
    window.setTimeout(() => el.classList.remove("is-flash"), 1200);
  };
  return { bodyRef, active, goTo };
}
/** Plays the panel's closing animation, then runs `after` (or onClose). */
function useDrawerClose(onClose: () => void) {
  const [closing, setClosing] = useState(false);
  const cb = useRef(onClose);
  cb.current = onClose;
  const busy = useRef(false);
  const close = useRef((after?: () => void) => {
    if (busy.current) return;
    busy.current = true; setClosing(true);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => (after ?? cb.current)(), reduce ? 0 : 280);
  }).current;
  return { closing, close };
}