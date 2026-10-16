/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import {
  listCompanies, saveCompany, deleteCompany, companyContactCounts, listContacts,
  myProfile, isSalesLead, listEmployees, loadCompanyAssignees, setCompanyAssignees,
  listCompanyFields, addCompanyField, updateCompanyField, deleteCompanyField,
  listContactFields, saveContact,
  loadRelationshipSets, type RelationshipSets,
  loadPrefs, savePref, setCompanyParent,
  companyStatus, type RelStatus, REL_SYSTEM, relLabel, relationshipOptions, sectorOptions, guessSector, DEFAULT_SECTORS,
  listCrmOptions, addCrmOption, deleteCrmOption, type CrmOption,
  loadHistory, type HistoryEntry, descendantsOf, groupRootOf,
  type Company, type Contact, type Employee, type CompanyField, type ContactField, type Billing,
} from "./companiesApi";
import { searchPlaces, lookupPostal, postalLooksComplete, provinceFromPostal, countryName, matchCountry, type AddressHit } from "../contacts/contactProfile";
import "../clients/ClientsPage.css";
import CompanyImport from "./CompanyImport";
import ContactExport from "../contacts/ContactExport";
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
  const [exporting, setExporting] = useState(false);
  const [ctrl1, setCtrl1] = useState<{ field: string; action: string; min?: string; max?: string; values?: string[]; text?: string }>({ field: "", action: "" });
  const [ctrl2, setCtrl2] = useState<{ field: string; action: string; min?: string; max?: string; values?: string[]; text?: string }>({ field: "", action: "" });
  const [rel, setRel] = useState<RelationshipSets | null>(null);
  const [fRel, setFRel] = useState("");
  const [columns, setColumns] = useState<string[]>(["vat_number", "address", "contacts"]);
  const [options, setOptions] = useState<CrmOption[]>([]);
  const reloadOptions = async () => setOptions(await listCrmOptions().catch(() => []));

  const reload = async () => {
    void reloadOptions();
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
    { key: "phone", label: "Mobile", type: "text" },
    { key: "landline", label: "Landline", type: "text" },
    { key: "sector", label: "Sector", type: "select" },
    { key: "postal_code", label: "Postal code", type: "text" },
    { key: "city", label: "City", type: "select" },
    { key: "province", label: "Province / state", type: "select" },
    { key: "country", label: "Country", type: "select" },
    { key: "contacts_count", label: "Number of contacts", type: "number" },
    { key: "created_by", label: "Created by", type: "select" },
    { key: "created_at", label: "Created on", type: "date" },
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
    if (key === "created_by") return [{ value: "in", label: "Is one of…" }, { value: "has", label: "Is known" }, { value: "empty", label: "Unknown" }];
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
    if (key === "imported_by" || key === "created_by") return employees.filter((e) => companies.some((c) => (c as any)[key] === e.id)).map((e) => ({ value: e.id, label: e.name }));
    if (key === "sector") return [...new Set([...sectorOptions(options), ...companies.map((c) => String(c.sector ?? "").trim()).filter(Boolean)])].map((v) => ({ value: v, label: v }));
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

  // Relationship filter. "tracking" / "notracking" look only at sales
  // (a client can also be in a deal); "none" means neither; "tag:…" is one of your types.
  const relMatches = (c: Company, f: string) => {
    const s = companyStatus(c, rel);
    if (f.startsWith("tag:")) return (c.relationship ?? []).includes(f.slice(4));
    if (f === "client") return s.client;
    if (f === "tracking") return s.sales;
    if (f === "notracking") return !s.sales;
    return !s.client && !s.sales;
  };
  const customTypes = relationshipOptions(options).filter((o) => !o.system);

  const shown = companies.filter((c) => {
    // Sales people only see the companies they have been assigned to.
    if (!lead && me && !(assignees[c.id!] ?? []).includes(me.id)) return false;
    if (!passesFilter(c, ctrl1)) return false;
    if (!passesFilter(c, ctrl2)) return false;
    if (fRel && !relMatches(c, fRel)) return false;
    const n = norm(q.trim());
    if (!n) return true;
    return [c.name, c.legal_name, c.vat_number, c.street, c.city, c.province, c.country, c.postal_code, c.sector]
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
    { key: "phone", label: "Mobile" },
    { key: "landline", label: "Landline" },
    { key: "sector", label: "Sector" },
    { key: "group", label: "Group" },
    { key: "created_by", label: "Created by" },
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
    if (key === "phone") return <span className="co-lmono">{phoneText(c.phone, c.phone_ext) || "—"}</span>;
    if (key === "landline") return <span className="co-lmono">{phoneText(c.landline, c.landline_ext) || "—"}</span>;
    if (key === "sector") return <span className="co-laddr">{c.sector || "—"}</span>;
    if (key === "group") return <span className="co-laddr">{c.parent_id ? `↳ ${companies.find((x) => x.id === c.parent_id)?.name ?? "—"}` : companies.some((x) => x.parent_id === c.id) ? "Top of a group" : "—"}</span>;
    if (key === "created_by") return <span className="co-laddr">{employees.find((e) => e.id === c.created_by)?.name ?? "—"}</span>;
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
              ...customTypes.map((o) => ({ value: `tag:${o.key}`, label: o.label })),
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
          { key: "export", group: "Data", label: "Export", hint: "Pick companies by client, deal, phase or contact", icon: AM_ICON.export, tone: "violet", shortcut: "E", onSelect: () => setExporting(true) },
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
                          <StatusPills status={companyStatus(c, rel)} tags={c.relationship} />
                        </span>
                        {(c.legal_name || c.parent_id) && (
                          <span className="co-lsub">{[c.legal_name, c.parent_id ? `part of ${companies.find((x) => x.id === c.parent_id)?.name ?? "a group"}` : ""].filter(Boolean).join(" · ")}</span>
                        )}
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
                            </span>
                            <span className="co-person-pos">{ct.position || "No position"}</span>
                          </span>
                          <span className="co-person-contact">
                            {ct.email && <a href={`mailto:${ct.email}`} onClick={(e) => e.stopPropagation()}>{ct.email}</a>}
                            {ct.phone && <em>{phoneText(ct.phone, ct.phone_ext)}</em>}
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
          key={editing.id ?? "new"}
          company={editing}
          companies={companies}
          rel={rel}
          options={options}
          onOptionsChanged={reloadOptions}
          onOpenCompany={(id) => { const x = companies.find((y) => y.id === id); if (x) setEditing(structuredClone(x)); }}
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

      {exporting && (
        <ContactExport
          root="company"
          companies={companies.filter((c) => lead || !me || (assignees[c.id!] ?? []).includes(me.id))}
          contacts={contacts}
          contactFields={contactFields}
          shownIds={shown.map((c) => c.id as string)}
          onClose={() => setExporting(false)}
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
          options={options}
          onOptionsChanged={reloadOptions}
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
                  <span className="co-pick-name">{name(ct)}</span>
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
    first_name: "", last_name: "", position: "", email: "", phone: "", phone_ext: "", is_billing: false, notes: "", companyIds: [], custom: {},
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
        <PhoneField label="Mobile" value={c.phone} ext={c.phone_ext} onValue={(v) => set({ phone: v })} onExt={(v) => set({ phone_ext: v })} />
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

function CompanyEditor({ company, companies, employees, fields, contacts, contactFields, canAssign, assigned, rel, options, onOptionsChanged, onClose, onSaved, onDeleted, onOpenContact, onOpenCompany }: {
  company: Company; companies: Company[]; employees: Employee[]; fields: CompanyField[]; contacts: Contact[]; contactFields: ContactField[]; canAssign: boolean; assigned: string[];
  rel: RelationshipSets | null;
  /** Your own sectors and relationship types. */
  options: CrmOption[];
  onOptionsChanged: () => Promise<void> | void;
  onClose: () => void; onSaved: () => void; onDeleted: () => void;
  /** Open a contact on the Contacts page. */
  onOpenContact: (id: string) => void;
  /** Open another company (from the group). */
  onOpenCompany: (id: string) => void;
}) {
  const [c, setC] = useState<Company>(() => ({ relationship: [], billing: {}, ...company }));
  const [initial] = useState(() => JSON.stringify({ relationship: [], billing: {}, ...company }));
  // Contacts linked to this company, edited live in the drawer.
  const linkedInitial = company.id ? contacts.filter((ct) => ct.companyIds.includes(company.id!)) : [];
  const [linked, setLinked] = useState<Contact[]>(linkedInitial);
  // New contacts created inline (not yet in the DB); saved when the company saves.
  const [newContacts, setNewContacts] = useState<Contact[]>([]);
  const [addingContact, setAddingContact] = useState(false);
  const [pendingRemoveIds, setPendingRemoveIds] = useState<string[]>([]);
  const [who, setWho] = useState<string[]>(assigned);
  // companies directly below this one in the group (saved with the company)
  const childInitial = company.id ? companies.filter((x) => x.parent_id === company.id).map((x) => x.id!) : [];
  const [children, setChildren] = useState<string[]>(childInitial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Company>) => setC((x) => ({ ...x, ...patch }));
  const dirty = () => JSON.stringify(c) !== initial || newContacts.length > 0 || pendingRemoveIds.length > 0 || children.join() !== childInitial.join();

  const { closing, close } = useDrawerClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const setCustom = (fieldId: string, value: any) =>
    setC((x) => ({ ...x, custom: { ...(x.custom ?? {}), [fieldId]: value } }));
  const customVal = (fieldId: string) => (c.custom ?? {})[fieldId];

  // ---- sector: picked from the list; for a new company we guess it from the name / website ----
  const sectors = sectorOptions(options);
  const [sectorTouched, setSectorTouched] = useState(!!company.sector);
  const [sectorAuto, setSectorAuto] = useState(false);
  const guess = guessSector(c);
  useEffect(() => {
    if (c.id || sectorTouched) return;
    if ((c.sector ?? "") !== guess) { set({ sector: guess || null }); setSectorAuto(!!guess); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guess]);
  const [newSector, setNewSector] = useState<string | null>(null);
  const addSector = async () => {
    const label = (newSector ?? "").trim();
    if (!label) { setNewSector(null); return; }
    const e = await addCrmOption("sector", label);
    if (e) { setErr(e); return; }
    await onOptionsChanged();
    set({ sector: label }); setSectorTouched(true); setSectorAuto(false); setNewSector(null);
  };

  // ---- what the company is to us ----
  const status = companyStatus(c, rel);
  const tags = c.relationship ?? [];
  const relOpts = relationshipOptions(options);
  const isOn = (k: string) => k === "crm" || tags.includes(k) || (k === "client" && status.client) || (k === "sales" && status.sales);
  const lockedWhy = (k: string) => k === "crm" ? "Every company is in the CRM"
    : k === "client" && status.client && !tags.includes(k) ? "It is a client (on the Clients page)"
    : k === "sales" && status.sales && !tags.includes(k) ? `It has deals${status.pipelines.length ? ` in ${status.pipelines.join(", ")}` : ""}` : "";
  const toggleTag = (k: string) => set({ relationship: tags.includes(k) ? tags.filter((x) => x !== k) : [...tags, k] });
  const [newType, setNewType] = useState<string | null>(null);
  const addType = async () => {
    const label = (newType ?? "").trim();
    if (!label) { setNewType(null); return; }
    const e = await addCrmOption("relationship", label);
    if (e) { setErr(e); return; }
    await onOptionsChanged();
    if (!tags.includes(label)) set({ relationship: [...tags, label] });
    setNewType(null);
  };

  // ---- billing ----
  const bill = c.billing ?? {};
  const setBill = (patch: Partial<Billing>) => set({ billing: { ...bill, ...patch } });
  const billFilled = !!(bill.name || bill.email || bill.phone || bill.notes);

  // ---- group ----
  const below = c.id ? descendantsOf(c.id, companies) : new Set<string>();
  const parentChoices = companies.filter((x) => x.id && x.id !== c.id && !below.has(x.id));
  const childChoices = companies.filter((x) => x.id && x.id !== c.id && x.id !== c.parent_id && !children.includes(x.id)
    && !(c.id && x.id === groupRootOf(c.id, companies)) && !isAbove(x.id, c.parent_id ?? null, companies));
  const nameOf = (id?: string | null) => companies.find((x) => x.id === id)?.name ?? "—";
  // the group as it will be once saved (this company's parent and children as edited here)
  const groupView = companies.filter((x) => x.id !== c.id).map((x) => {
    if (children.includes(x.id!)) return { ...x, parent_id: c.id ?? "__self" };
    if (x.parent_id === c.id && c.id && !children.includes(x.id!)) return { ...x, parent_id: null };
    return x;
  });
  const selfNode: Company = { ...c, id: c.id ?? "__self", name: c.name || "This company" };
  const graphCompanies = [...groupView, selfNode];
  const groupSize = (() => { const root = groupRootOf(selfNode.id!, graphCompanies); return 1 + descendantsOf(root, graphCompanies).size; })();

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
      // the group: companies added below this one, and ones taken out
      for (const id of children.filter((x) => !childInitial.includes(x))) {
        const ge = await setCompanyParent(id, companyId);
        if (ge) { setBusy(false); setErr(`${nameOf(id)}: ${ge}`); return; }
      }
      for (const id of childInitial.filter((x) => !children.includes(x))) await setCompanyParent(id, null);
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
  const leaveFor = (go: () => void) => { if (dirty() && !confirm("Leave this company without saving your changes?")) return; close(go); };

  // ---- history: field names and values in words ----
  const FIELD_NAMES: Record<string, string> = {
    name: "Name", legal_name: "Legal name", vat_number: "VAT / Tax ID", reg_number: "Registration nº", website: "Website", email: "Email",
    phone: "Mobile", phone_ext: "Mobile ext.", landline: "Landline", landline_ext: "Landline ext.", notes: "Notes", street: "Street",
    addr_number: "Number", addr_details: "Address details", postal_code: "Postal code", city: "City", province: "Province", country: "Country",
    sector: "Sector", relationship: "Type", billing: "Billing details", parent_id: "Parent company",
  };
  const histLabel = (k: string) => k.startsWith("custom.") ? fields.find((f) => f.id === k.slice(7))?.label ?? null : FIELD_NAMES[k] ?? null;
  const histValue = (k: string, v: any) => {
    if (v == null || v === "") return "—";
    if (k === "parent_id") return nameOf(v);
    if (k === "relationship" && Array.isArray(v)) return v.length ? v.map(relLabel).join(", ") : "—";
    if (k === "billing" && typeof v === "object") return [v.name, v.email, phoneText(v.phone, v.phone_ext)].filter(Boolean).join(" · ") || "—";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return String(v);
  };

  // ---- the panel: a hero on top, a section index on the left that follows the scroll ----
  const { bodyRef, active, goTo } = useDrawerSections("company");
  const peopleCount = linked.length + newContacts.length;
  const site = (c.website ?? "").trim();
  const siteHref = site ? (/^https?:\/\//i.test(site) ? site : `https://${site}`) : "";
  const creator = c.created_by ? employees.find((e) => e.id === c.created_by)?.name : null;
  const createdOn = c.created_at ? new Date(c.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  const sections: DwNavItem[] = [
    { k: "company", label: "Company", icon: "id" },
    { k: "reach", label: "Contact details", icon: "mail" },
    { k: "address", label: "Address", icon: "pin" },
    { k: "billing", label: "Billing", icon: "euro", count: billFilled ? 1 : 0 },
    { k: "group", label: "Group", icon: "tree", count: groupSize > 1 ? groupSize : 0 },
    { k: "people", label: "Contacts", icon: "users", count: peopleCount },
    ...(canAssign ? [{ k: "access", label: "Visibility", icon: "lock", count: who.length }] : []),
    ...(fields.length ? [{ k: "custom", label: "Additional details", icon: "sliders" }] : []),
    { k: "notes", label: "Notes", icon: "note" },
    { k: "history", label: "History", icon: "clock" },
  ];

  return (
    <div className={`dw-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={() => close()}>
      <div className="dw is-wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={c.name || "New company"}>
        <header className="dw-hero">
          <span className="dw-hero-av">{(c.name || "+").trim().slice(0, 1).toUpperCase()}</span>
          <div className="dw-hero-txt">
            <span className="dw-eyebrow">{c.id ? "Company" : "New company"}{c.sector ? ` · ${c.sector}` : ""}</span>
            <h2 className="dw-title">{c.name || "New company"}</h2>
            <p className="dw-hero-sub">
              {[c.legal_name, c.vat_number].filter(Boolean).join(" · ") || "Fill in the details below"}
              {c.parent_id ? <> · part of <b>{nameOf(c.parent_id)}</b></> : null}
            </p>
            <div className="dw-hero-tags">
              <StatusPills status={status} tags={tags} hero />
              {site && <a className="dw-tag" href={siteHref} target="_blank" rel="noreferrer"><DwIcon name="link" />{site.replace(/^https?:\/\//i, "").replace(/\/$/, "")}</a>}
              {c.email && <a className="dw-tag" href={`mailto:${c.email}`}><DwIcon name="mail" />{c.email}</a>}
              {c.phone && <a className="dw-tag" href={telHref(c.phone, c.phone_ext)}><DwIcon name="phone" />{phoneText(c.phone, c.phone_ext)}</a>}
              {c.landline && <a className="dw-tag" href={telHref(c.landline, c.landline_ext)}><DwIcon name="phone" />{phoneText(c.landline, c.landline_ext)}</a>}
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
              <DwSecHead icon="id" title="Company" hint="Its name, how it is registered, its sector and what it is to you"
                aside={c.id && (creator || createdOn) ? <span className="dw-created"><DwIcon name="person" />{creator ? `Created by ${creator}` : "Created"}{createdOn ? ` · ${createdOn}` : ""}</span> : undefined} />
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
                <div className={`dw-f dw-col2 ${sectorAuto ? "is-auto" : ""}`}>
                  <label>Sector{sectorAuto && <span className="dw-f-assist">Guessed from the name — change it if it's wrong</span>}</label>
                  {newSector === null ? (
                    <div className="dw-sector">
                      <Select value={c.sector ?? ""} placeholder="Choose a sector…"
                        onChange={(v) => { if (v === "__add") { setNewSector(""); return; } set({ sector: v || null }); setSectorTouched(true); setSectorAuto(false); }}
                        options={[{ value: "", label: "— No sector" }, ...sectors.map((s) => ({ value: s, label: s })),
                          ...(c.sector && !sectors.includes(c.sector) ? [{ value: c.sector, label: `${c.sector} (as imported)` }] : []),
                          { value: "__add", label: "+ Add a sector…" }]} />
                      {!c.sector && guess && (
                        <button type="button" className="dw-suggest" onClick={() => { set({ sector: guess }); setSectorTouched(true); }}>
                          <DwIcon name="spark" />Looks like <b>{guess}</b>
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="dw-inline-add">
                      <input autoFocus value={newSector} onChange={(e) => setNewSector(e.target.value)} placeholder="New sector name"
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addSector(); } if (e.key === "Escape") { e.stopPropagation(); setNewSector(null); } }} />
                      <button type="button" className="dw-save" onClick={() => void addSector()}>Add</button>
                      <button type="button" className="dw-cancel" onClick={() => setNewSector(null)}>Cancel</button>
                    </div>
                  )}
                </div>
              </div>
              <div className="dw-rel">
                <span className="dw-f-label">What it is to you</span>
                <div className="dw-rel-chips">
                  {relOpts.map((o, i) => {
                    const on = isOn(o.key), why = lockedWhy(o.key);
                    return (
                      <button type="button" key={o.key} className={`dw-rel-chip ${on ? "is-on" : ""} ${o.system ? `is-sys is-${o.key}` : ""} ${why ? "is-locked" : ""}`}
                        style={{ ["--i" as string]: i } as CSSProperties} aria-pressed={on} disabled={!!why} title={why || (o.system ? REL_SYSTEM.find((r) => r.key === o.key)?.hint : "")}
                        onClick={() => toggleTag(o.key)}>
                        <i>{on ? "✓" : "+"}</i>{o.label}{why && o.key !== "crm" && <em>auto</em>}
                      </button>
                    );
                  })}
                  {newType === null ? (
                    <button type="button" className="dw-rel-chip is-new" onClick={() => setNewType("")}>+ New type</button>
                  ) : (
                    <span className="dw-rel-add">
                      <input autoFocus value={newType} onChange={(e) => setNewType(e.target.value)} placeholder="e.g. Partner"
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addType(); } if (e.key === "Escape") { e.stopPropagation(); setNewType(null); } }}
                        onBlur={() => { if (!(newType ?? "").trim()) setNewType(null); }} />
                      <button type="button" onClick={() => void addType()}>Add</button>
                    </span>
                  )}
                </div>
              </div>
            </section>

            <section className="dw-sec" data-sec="reach" data-tone="blue">
              <DwSecHead icon="mail" title="Contact details" hint="Website and the company's general email and phones" />
              <div className="dw-grid">
                <div className="dw-f"><label>Website</label>
                  <input value={c.website ?? ""} onChange={(e) => set({ website: e.target.value })} placeholder="https://" />
                </div>
                <div className="dw-f"><label>Email</label>
                  <input type="email" value={c.email ?? ""} onChange={(e) => set({ email: e.target.value })} placeholder="info@company.com" />
                </div>
                <PhoneField label="Mobile" value={c.phone} ext={c.phone_ext} onValue={(v) => set({ phone: v })} onExt={(v) => set({ phone_ext: v })} placeholder="+34 600 000 000" />
                <PhoneField label="Landline" value={c.landline} ext={c.landline_ext} onValue={(v) => set({ landline: v })} onExt={(v) => set({ landline_ext: v })} placeholder="+34 910 000 000" />
              </div>
            </section>

            <section className="dw-sec" data-sec="address" data-tone="amber">
              <DwSecHead icon="pin" title="Address" hint="Where the company is based — start typing the street or the postal code" />
              <AddressFields value={c} onChange={(p) => set(p as Partial<Company>)} countryAs="name" withDetails />
            </section>

            <section className="dw-sec" data-sec="billing" data-tone="green">
              <DwSecHead icon="euro" title="Billing" hint="Who receives the invoices — a person, a shared inbox, a phone… whatever you need"
                aside={billFilled ? <span className="dw-pill is-ok">Set</span> : undefined} />
              <div className="dw-grid">
                <div className="dw-f"><label>Name</label>
                  <input value={bill.name ?? ""} onChange={(e) => setBill({ name: e.target.value })} placeholder="e.g. Accounts payable" />
                </div>
                <div className="dw-f"><label>Email</label>
                  <input type="email" value={bill.email ?? ""} onChange={(e) => setBill({ email: e.target.value })} placeholder="invoices@company.com" />
                </div>
                <PhoneField label="Phone" value={bill.phone} ext={bill.phone_ext} onValue={(v) => setBill({ phone: v })} onExt={(v) => setBill({ phone_ext: v })} placeholder="+34 910 000 000" />
                <div className="dw-f"><label>Notes</label>
                  <input value={bill.notes ?? ""} onChange={(e) => setBill({ notes: e.target.value })} placeholder="e.g. PO number on every invoice" />
                </div>
              </div>
              {(linked.length > 0 || newContacts.length > 0) && (
                <div className="dw-copyfrom">
                  <span>Copy from a contact:</span>
                  {[...linked, ...newContacts].slice(0, 6).map((ct, i) => (
                    <button type="button" key={ct.id ?? `n${i}`} onClick={() => setBill({ name: contactName(ct), email: ct.email ?? "", phone: ct.phone ?? "", phone_ext: ct.phone_ext ?? "" })}>
                      <span>{(ct.first_name?.[0] ?? "?").toUpperCase()}</span>{contactName(ct)}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="dw-sec" data-sec="group" data-tone="indigo">
              <DwSecHead icon="tree" title="Group" hint="Companies of the same group, and which one sits above which"
                aside={groupSize > 1 ? <span className="dw-pill">{groupSize} companies</span> : undefined} />
              <div className="dw-grid">
                <div className="dw-f"><label>Parent company</label>
                  <Select value={c.parent_id ?? ""} onChange={(v) => set({ parent_id: v || null })} placeholder="None — top of its group"
                    options={[{ value: "", label: "None — top of its group" }, ...parentChoices.map((x) => ({ value: x.id!, label: x.name }))]} />
                </div>
                <div className="dw-f"><label>Add a company below this one</label>
                  <Select value="" onChange={(v) => v && setChildren((xs) => [...xs, v])} placeholder="+ Add a subsidiary"
                    options={childChoices.map((x) => ({ value: x.id!, label: x.parent_id ? `${x.name} (now under ${nameOf(x.parent_id)})` : x.name }))} />
                </div>
              </div>
              {groupSize > 1 ? (
                <GroupTree companies={graphCompanies} focus={selfNode.id!}
                  onOpen={(id) => id !== selfNode.id && leaveFor(() => onOpenCompany(id))}
                  onDetach={(id) => setChildren((xs) => xs.filter((x) => x !== id))} detachable={children} />
              ) : (
                <p className="dw-empty-hint">On its own. Pick a parent company or add the companies below it to build the group.</p>
              )}
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
                      onClick={() => leaveFor(() => onOpenContact(ct.id!))}>
                      <span className="co-cc-name">{contactName(ct)}<span className="co-cc-go"><DwIcon name="arrow" /></span></span>
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

            <HistorySection entity="company" id={c.id} employees={employees} fieldLabel={histLabel} formatValue={histValue} />
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

/** Is `id` above `of` in the group (its parent, grandparent…)? */
function isAbove(id: string, of: string | null, companies: Company[]): boolean {
  const seen = new Set<string>();
  let cur = of;
  while (cur && !seen.has(cur)) {
    if (cur === id) return true;
    seen.add(cur);
    cur = companies.find((x) => x.id === cur)?.parent_id ?? null;
  }
  return false;
}

/**
 * The whole group as an org chart: the top company first, the ones below it
 * underneath, lines between them. The company being edited is highlighted;
 * click another one to open it.
 */
function GroupTree({ companies, focus, onOpen, onDetach, detachable }: {
  companies: Company[]; focus: string; onOpen: (id: string) => void;
  onDetach: (id: string) => void; detachable: string[];
}) {
  const root = groupRootOf(focus, companies);
  const kids = (id: string) => companies.filter((x) => x.parent_id === id).sort((a, b) => a.name.localeCompare(b.name));
  const path = new Set<string>();
  for (let cur: string | null | undefined = focus, n = 0; cur && n < 50; n++) { path.add(cur); cur = companies.find((x) => x.id === cur)?.parent_id; }
  let order = 0;
  const node = (id: string, depth: number): ReactNode => {
    const co = companies.find((x) => x.id === id);
    if (!co || depth > 12) return null;
    const ch = kids(id);
    const i = order++;
    return (
      <li key={id} className={`gt-li ${ch.length ? "has-kids" : ""}`}>
        <div className={`gt-node ${id === focus ? "is-focus" : ""} ${path.has(id) && id !== focus ? "is-path" : ""}`} style={{ ["--i" as string]: i } as CSSProperties}>
          <button type="button" className="gt-open" onClick={() => onOpen(id)} disabled={id === focus} title={id === focus ? "This company" : `Open ${co.name}`}>
            <span className="gt-av">{(co.name || "?").slice(0, 1).toUpperCase()}</span>
            <span className="gt-txt"><b>{co.name}</b><em>{id === focus ? (id === root ? "This company · top of the group" : "This company") : id === root ? "Top of the group" : [co.sector, co.city].filter(Boolean).join(" · ") || "—"}</em></span>
          </button>
          {detachable.includes(id) && <button type="button" className="gt-x" onClick={() => onDetach(id)} aria-label={`Take ${co.name} out of the group`}>×</button>}
        </div>
        {ch.length > 0 && <ul className="gt-ul">{ch.map((k) => node(k.id!, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <div className="gt">
      <ul className="gt-ul is-root">{node(root, 0)}</ul>
    </div>
  );
}
// ============================ Field settings modal ============================
function FieldSettings({ fields, options, onOptionsChanged, availableColumns, columns, onColumns, onClose, onChanged }: {
  fields: CompanyField[];
  options: CrmOption[];
  onOptionsChanged: () => Promise<void> | void;
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

          <OptionList kind="sector" title="Sectors" options={options} onChanged={onOptionsChanged}
            builtIn={DEFAULT_SECTORS.map((s) => s.label)} placeholder="e.g. Aerospace"
            hint="Every company can have one. New companies get one guessed from their name; imports match what the file says." />
          <OptionList kind="relationship" title="What a company can be" options={options} onChanged={onOptionsChanged}
            builtIn={REL_SYSTEM.map((r) => r.label)} placeholder="e.g. Partner, Supplier"
            hint="CRM, In sales and Client are switched on by themselves; add your own (Partner, Supplier…) to pick by hand." />

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

/** A list you can add to (sectors, relationship types): the built-in ones, then yours with a remove button. */
function OptionList({ kind, title, hint, options, builtIn, placeholder, onChanged }: {
  kind: CrmOption["kind"]; title: string; hint: string; options: CrmOption[]; builtIn: string[]; placeholder: string;
  onChanged: () => Promise<void> | void;
}) {
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const mine = options.filter((o) => o.kind === kind);
  const add = async () => {
    const l = label.trim();
    if (!l) return;
    if ([...builtIn, ...mine.map((o) => o.label)].some((x) => x.toLowerCase() === l.toLowerCase())) { setErr(`“${l}” is already there.`); return; }
    const e = await addCrmOption(kind, l, mine.length);
    if (e) { setErr(/crm_options/i.test(e) ? "Run the CRM upgrade in Supabase first." : e); return; }
    setLabel(""); setErr(null); await onChanged();
  };
  return (
    <div className="dw-sec">
      <p className="dw-sec-title">{title}</p>
      <p className="dw-empty-hint" style={{ marginTop: 0 }}>{hint}</p>
      <div className="cf-opts">
        {builtIn.map((b) => <span key={b} className="cf-opt is-builtin">{b}</span>)}
        {mine.map((o) => (
          <span key={o.id} className="cf-opt">{o.label}
            <button type="button" aria-label={`Remove ${o.label}`} onClick={async () => { if (confirm(`Remove “${o.label}” from the list? Companies that have it keep it.`)) { await deleteCrmOption(o.id); await onChanged(); } }}>×</button>
          </span>
        ))}
      </div>
      <div className="cf-opt-add">
        <input value={label} onChange={(e) => { setLabel(e.target.value); setErr(null); }} placeholder={placeholder}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }} />
        <button type="button" className="dw-save" onClick={() => void add()} disabled={!label.trim()}>+ Add</button>
      </div>
      {err && <p className="dw-err">{err}</p>}
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
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  trend: "M3 17l6-6 4 4 8-8M15 7h6v6",
  tag: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
  plus: "M12 5v14M5 12h14",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  pen: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  unlink: "M9 15l6-6M10 6l1-1a5 5 0 0 1 7 7l-1 1M14 18l-1 1a5 5 0 0 1-7-7l1-1M3 3l18 18",
  flag: "M5 21V4M5 4h12l-2 4 2 4H5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  tree: "M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18",
  dot: "M12 12h.01",
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
// ============================ Shared CRM pieces (Companies and Contacts) ============================

/** A phone and its extension, side by side. */
export function PhoneField({ label, value, ext, onValue, onExt, placeholder }: {
  label: string; value?: string | null; ext?: string | null;
  onValue: (v: string) => void; onExt: (v: string) => void; placeholder?: string;
}) {
  return (
    <div className="dw-f"><label>{label}</label>
      <div className="dw-phone">
        <input value={value ?? ""} onChange={(e) => onValue(e.target.value)} placeholder={placeholder} inputMode="tel" autoComplete="off" />
        <span className="dw-phone-sep" aria-hidden="true">ext.</span>
        <input className="dw-ext" value={ext ?? ""} onChange={(e) => onExt(e.target.value)} placeholder="—" aria-label={`${label} extension`} inputMode="numeric" />
      </div>
    </div>
  );
}
/** "tel:" link that dials the extension after a pause. */
export const telHref = (phone?: string | null, ext?: string | null) =>
  `tel:${(phone ?? "").replace(/[^\d+]/g, "")}${ext ? `,${String(ext).replace(/\D/g, "")}` : ""}`;
export const phoneText = (phone?: string | null, ext?: string | null) => (phone ? `${phone}${ext ? ` · ext. ${ext}` : ""}` : "");

/** The client / in-sales pills — the same on Companies and Contacts. */
export function StatusPills({ status, tags = [], hero }: { status: RelStatus; tags?: string[]; hero?: boolean }) {
  const custom = tags.filter((t) => t !== "sales" && t !== "client" && t !== "crm");
  const pipes = status.pipelines;
  const salesTxt = `In sales${pipes.length ? ` · ${pipes[0]}${pipes.length > 1 ? ` +${pipes.length - 1}` : ""}` : ""}`;
  if (hero) return (
    <>
      {status.client && <span className="dw-tag is-ok"><DwIcon name="star" />Client</span>}
      {status.sales && <span className="dw-tag is-sales" title={pipes.join(", ")}><DwIcon name="trend" />{salesTxt}</span>}
      {custom.map((t) => <span key={t} className="dw-tag"><DwIcon name="tag" />{t}</span>)}
    </>
  );
  return (
    <>
      {status.client && <span className="co-rel co-rel-client">Client</span>}
      {status.sales && <span className="co-rel co-rel-tracking" title={pipes.join(", ")}>{salesTxt}</span>}
      {custom.slice(0, 2).map((t) => <span key={t} className="co-rel co-rel-tag">{t}</span>)}
    </>
  );
}

// ---- floating list under a field (portal: the panel scrolls and clips) ----
function useFloatingUnder(anchor: React.RefObject<HTMLElement | null>, open: boolean) {
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, top: r.bottom + 6, width: Math.max(r.width, 320) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open, anchor]);
  return pos;
}

/** A text field that suggests places as you type (streets or towns). */
function PlaceInput({ value, onType, onPick, kind, near, placeholder, auto, inputRef }: {
  value: string; onType: (v: string) => void; onPick: (h: AddressHit) => void;
  kind: "address" | "city"; near: { city?: string; country?: string }; placeholder?: string; auto?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hits, setHits] = useState<AddressHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hi, setHi] = useState(0);
  const typed = useRef(false);
  const pos = useFloatingUnder(wrap, open && (hits.length > 0 || busy));

  useEffect(() => {
    if (!typed.current) return;
    const q = value.trim();
    if (q.length < 3) { setHits([]); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    const t = window.setTimeout(() => {
      searchPlaces(q, kind, near, ctl.signal)
        .then((h) => { setHits(h); setHi(0); setBusy(false); })
        .catch(() => {});
    }, 260);
    return () => { window.clearTimeout(t); ctl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, kind, near.city, near.country]);

  const pick = (h: AddressHit) => { typed.current = false; setOpen(false); setHits([]); onPick(h); };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open || !hits.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(hits[hi]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };

  return (
    <div className={`dw-place ${auto ? "is-auto" : ""}`} ref={wrap}>
      <input ref={inputRef} value={value} placeholder={placeholder} autoComplete="off"
        onChange={(e) => { typed.current = true; setOpen(true); onType(e.target.value); }}
        onFocus={() => { if (hits.length) setOpen(true); }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKey} />
      {busy && <span className="dw-place-spin" aria-hidden="true" />}
      {auto && !busy && <span className="dw-place-auto" title="Filled in for you">auto</span>}
      {open && pos && (hits.length > 0 || busy) && createPortal(
        <div className="dw-sugg" style={{ left: pos.left, top: pos.top, width: pos.width }} onMouseDown={(e) => e.preventDefault()} role="listbox">
          {hits.map((h, i) => (
            <button type="button" key={h.key} role="option" aria-selected={i === hi} className={`dw-sugg-opt ${i === hi ? "is-hi" : ""}`}
              onMouseEnter={() => setHi(i)} onClick={() => pick(h)} style={{ ["--i" as string]: i } as CSSProperties}>
              <i><DwIcon name={h.kind === "city" ? "building" : "pin"} /></i>
              <span><b>{h.label}</b><em>{h.sub}</em></span>
            </button>
          ))}
          {!hits.length && busy && <p className="dw-sugg-empty">Looking…</p>}
          <span className="dw-sugg-foot">Addresses © OpenStreetMap</span>
        </div>,
        document.body,
      )}
    </div>
  );
}

export interface AddrValue {
  street?: string | null; addr_number?: string | null; addr_details?: string | null; postal_code?: string | null;
  city?: string | null; province?: string | null; country?: string | null;
}
type AddrKey = keyof AddrValue;

/**
 * The address block, filling itself in: pick a street and the rest comes with it,
 * type a postal code and the town, province and country appear, pick a town and
 * you get its province and country. Only empty fields (or ones it filled before)
 * are filled on their own; what you typed is never overwritten.
 */
export function AddressFields({ value, onChange, countryAs, req, renderCountry, withDetails }: {
  value: AddrValue;
  onChange: (patch: Partial<AddrValue>) => void;
  /** Contacts keep the ISO code ("ES"), companies the name ("Spain"). */
  countryAs: "code" | "name";
  req?: (k: AddrKey) => ReactNode;
  /** A custom country control (the contacts' searchable list); a text field otherwise. */
  renderCountry?: () => ReactNode;
  withDetails?: boolean;
}) {
  const [auto, setAuto] = useState<Set<AddrKey>>(new Set());
  const [cityChoices, setCityChoices] = useState<string[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const numberRef = useRef<HTMLInputElement>(null);
  // a postal code that came with a picked street: the town came with it too, nothing to ask
  const pickedPostal = useRef<string | null>(null);
  const v = (k: AddrKey) => String(value[k] ?? "");
  const cc = matchCountry(value.country) ?? "";
  const countryOut = (code?: string) => (!code ? undefined : countryAs === "code" ? code : countryName(code));

  /** Fill fields: `force` overwrites, otherwise only empty ones and ones we filled before. */
  const fill = (p: Partial<Record<AddrKey, string | undefined>>, force: boolean) => {
    const patch: Partial<AddrValue> = {};
    const filled: AddrKey[] = [];
    (Object.keys(p) as AddrKey[]).forEach((k) => {
      const nv = (p[k] ?? "").trim();
      if (!nv || nv === v(k)) return;
      if (force || !v(k).trim() || auto.has(k)) { patch[k] = nv; filled.push(k); }
    });
    if (!filled.length) return;
    onChange(patch);
    setAuto((s) => { const n = new Set(s); filled.forEach((k) => n.add(k)); return n; });
  };
  const typed = (k: AddrKey, val: string) => {
    onChange({ [k]: val } as Partial<AddrValue>);
    if (auto.has(k)) setAuto((s) => { const n = new Set(s); n.delete(k); return n; });
  };

  // postal code → town(s), province, country
  const postal = v("postal_code");
  useEffect(() => {
    setHint(null);
    if (!postalLooksComplete(postal, value.country || undefined)) { setCityChoices([]); return; }
    // the province comes at once (Spain), the towns after a short trip
    const prov = provinceFromPostal(postal, value.country || undefined);
    if (prov) fill({ province: prov, country: countryOut(cc || "ES") }, false);
    if (pickedPostal.current === postal) return;
    pickedPostal.current = null;
    const ctl = new AbortController();
    lookupPostal(postal, value.country || undefined, ctl.signal).then((r) => {
      if (!r) return;
      fill({ province: r.province, country: countryOut(r.country) }, false);
      const city = v("city").trim();
      if (r.cities.length === 1) {
        if (!city || auto.has("city")) fill({ city: r.cities[0] }, true);
        else if (norm(city) !== norm(r.cities[0])) setHint(r.cities[0]);
        setCityChoices([]);
      } else if (r.cities.length > 1) {
        if (!city || auto.has("city")) setCityChoices(r.cities.slice(0, 8));
        else if (!r.cities.some((x) => norm(x) === norm(city))) setCityChoices(r.cities.slice(0, 8));
      }
    }).catch(() => {});
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postal]);

  const pickStreet = (h: AddressHit) => {
    if (h.postal_code && h.city) pickedPostal.current = h.postal_code;
    fill({ street: h.street, addr_number: h.number, postal_code: h.postal_code, city: h.city, province: h.province, country: countryOut(h.country) }, true);
    setCityChoices([]); setHint(null);
    if (!h.number && !v("addr_number")) window.setTimeout(() => numberRef.current?.focus(), 30);
  };
  const pickCity = (h: AddressHit) => {
    fill({ city: h.city }, true);
    fill({ province: h.province, country: countryOut(h.country), postal_code: h.postal_code }, false);
    setCityChoices([]); setHint(null);
  };
  // typed a town without picking it: look it up quietly for the province and country
  const settleCity = () => {
    const city = v("city").trim();
    if (city.length < 3 || (v("province") && v("country"))) return;
    searchPlaces(city, "city", { country: value.country || undefined }).then((hs) => {
      const h = hs.find((x) => norm(x.city ?? "") === norm(city)) ?? hs[0];
      if (h && norm(h.city ?? "") === norm(city)) fill({ province: h.province, country: countryOut(h.country) }, false);
    }).catch(() => {});
  };
  const mark = (k: AddrKey) => (auto.has(k) ? "is-auto" : "");

  return (
    <div className="dw-addr">
      <div className="dw-grid is-3">
        <div className="dw-f dw-col2"><label>Street{req?.("street")}<span className="dw-f-assist">Type to search</span></label>
          <PlaceInput value={v("street")} onType={(x) => typed("street", x)} onPick={pickStreet} kind="address" auto={auto.has("street")}
            near={{ city: v("city") || undefined, country: value.country || undefined }} placeholder="e.g. Calle de Alcalá 42" />
        </div>
        <div className={`dw-f ${mark("addr_number")}`}><label>Number{req?.("addr_number")}</label>
          <input ref={numberRef} value={v("addr_number")} onChange={(e) => typed("addr_number", e.target.value)} placeholder="e.g. 42" />
        </div>
        {withDetails && (
          <div className="dw-f"><label>Details (floor, door…)</label>
            <input value={v("addr_details")} onChange={(e) => typed("addr_details", e.target.value)} placeholder="e.g. 3º B" />
          </div>
        )}
        <div className={`dw-f ${mark("postal_code")}`}><label>Postal code{req?.("postal_code")}</label>
          <input value={postal} onChange={(e) => typed("postal_code", e.target.value)} placeholder="e.g. 28014" inputMode="numeric" />
        </div>
        <div className="dw-f"><label>City{req?.("city")}</label>
          <div onBlur={settleCity}>
            <PlaceInput value={v("city")} onType={(x) => { typed("city", x); setHint(null); }} onPick={pickCity} kind="city" auto={auto.has("city")}
              near={{ country: value.country || undefined }} placeholder="e.g. Madrid" />
          </div>
        </div>
        <div className={`dw-f ${mark("province")}`}><label>Province / state{req?.("province")}</label>
          <input value={v("province")} onChange={(e) => typed("province", e.target.value)} placeholder="e.g. Madrid" />
        </div>
        <div className={`dw-f ${withDetails ? "dw-col2" : ""} ${renderCountry ? "" : mark("country")}`}><label>Country{req?.("country")}</label>
          {renderCountry ? renderCountry() : <input value={v("country")} onChange={(e) => typed("country", e.target.value)} placeholder="e.g. Spain" />}
        </div>
      </div>
      {(cityChoices.length > 0 || hint) && (
        <div className="dw-addr-hint">
          <DwIcon name="pin" />
          {hint ? (
            <>
              <span>Postal code {postal} is <b>{hint}</b>.</span>
              <button type="button" onClick={() => { fill({ city: hint }, true); setHint(null); }}>Use {hint}</button>
            </>
          ) : (
            <>
              <span>{postal} covers several towns:</span>
              {cityChoices.map((x) => <button type="button" key={x} className={norm(x) === norm(v("city")) ? "is-on" : ""} onClick={() => { fill({ city: x }, true); setCityChoices([]); }}>{x}</button>)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---- History ----
const HIST_TONE: Record<string, string> = {
  created: "green", imported: "blue", edited: "slate", linked: "indigo", unlinked: "rose",
  sales: "amber", pipeline: "amber", phase: "amber", deal_status: "amber", client: "green",
};
const HIST_ICON: Record<string, string> = {
  created: "plus", imported: "upload", edited: "pen", linked: "link", unlinked: "unlink",
  sales: "trend", pipeline: "trend", phase: "trend", deal_status: "flag", client: "star",
};
function whenText(iso: string) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const rel = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago` : mins < 60 * 24 * 30 ? `${Math.round(mins / 1440)} d ago` : "";
  const abs = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return { rel, abs };
}
const showVal = (v: any): string => {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "object") return Object.values(v).filter(Boolean).join(" · ") || "—";
  return String(v);
};

/**
 * Everything that happened to a company or contact, newest first: when it came in
 * (by hand or by an import), every edit field by field, links, deals, pipelines,
 * becoming a client — and who did it. Written by the database (crm_history).
 */
export function HistorySection({ entity, id, employees, fieldLabel, formatValue }: {
  entity: "company" | "contact"; id?: string; employees: Employee[];
  /** Name of a changed field ("phone" → "Phone"); null hides it. Custom fields come as "custom.<id>". */
  fieldLabel: (key: string) => string | null;
  /** How to show a stored value (company ids → names, country codes → countries…). */
  formatValue?: (key: string, v: any) => string;
}) {
  const [rows, setRows] = useState<HistoryEntry[] | null | undefined>(undefined);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!id) { setRows([]); return; }
    let alive = true;
    loadHistory(entity, id).then((r) => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, [entity, id]);

  const who = (a: string | null) => (a ? employees.find((e) => e.id === a)?.name ?? "Someone" : "System");
  const fmt = (k: string, v: any) => formatValue?.(k, v) ?? showVal(v);
  const title = (r: HistoryEntry): ReactNode => {
    const d = r.detail ?? {};
    switch (r.action) {
      case "created": return entity === "company" ? "Company created" : "Contact created";
      case "imported": return "Imported from a file";
      case "edited": { const n = Object.keys(d.changes ?? {}).filter((k) => fieldLabel(k) !== null).length; return `Edited ${n} ${n === 1 ? "field" : "fields"}`; }
      case "linked": return entity === "company" ? <>Contact <b>{d.contact || "—"}</b> added</> : <>Linked to <b>{d.company || "a company"}</b></>;
      case "unlinked": return entity === "company" ? <>Contact <b>{d.contact || "—"}</b> removed</> : <>No longer at <b>{d.company || "a company"}</b></>;
      case "sales": return <>Entered sales{d.pipeline ? <> · <b>{d.pipeline}</b></> : null}{d.via_company ? " (with its company)" : ""}</>;
      case "pipeline": return <>Moved to the <b>{d.pipeline || "—"}</b> pipeline</>;
      case "phase": return <>Phase → <b>{d.phase || "—"}</b>{d.pipeline ? ` · ${d.pipeline}` : ""}</>;
      case "deal_status": return d.status === "won" ? <>Deal <b>won</b></> : d.status === "lost" ? <>Deal <b>lost</b></> : <>Deal {d.status || "updated"}</>;
      case "client": return <>Became a <b>client</b></>;
      default: return r.action;
    }
  };
  const shown = rows ? (all ? rows : rows.slice(0, 12)) : [];

  return (
    <section className="dw-sec" data-sec="history" data-tone="slate">
      <DwSecHead icon="clock" title="History" hint="Everything that happened here, and who did it"
        aside={rows && rows.length ? <span className="dw-pill">{rows.length}</span> : undefined} />
      {!id && <p className="dw-empty-hint">The history starts once it is saved.</p>}
      {id && rows === undefined && <p className="dw-empty-hint">Loading…</p>}
      {id && rows === null && <p className="dw-empty-hint">The history isn't switched on yet — run the CRM upgrade in Supabase.</p>}
      {id && rows && rows.length === 0 && <p className="dw-empty-hint">Nothing recorded yet.</p>}
      {shown.length > 0 && (
        <ol className="dw-hist">
          {shown.map((r, i) => {
            const t = whenText(r.at);
            const ch = r.action === "edited" ? Object.entries((r.detail?.changes ?? {}) as Record<string, [any, any]>).filter(([k]) => fieldLabel(k) !== null) : [];
            if (r.action === "edited" && !ch.length) return null;
            return (
              <li key={r.id} className="dw-hist-row" data-tone={HIST_TONE[r.action] ?? "slate"} style={{ ["--i" as string]: Math.min(i, 10) } as CSSProperties}>
                <span className="dw-hist-dot"><DwIcon name={HIST_ICON[r.action] ?? "dot"} /></span>
                <div className="dw-hist-main">
                  <p className="dw-hist-t">{title(r)}</p>
                  {r.detail?.deal && (r.action === "sales" || r.action === "deal_status") && <p className="dw-hist-sub">{r.detail.deal}</p>}
                  {r.action === "client" && r.detail?.client && <p className="dw-hist-sub">{r.detail.client}</p>}
                  {ch.length > 0 && (
                    <ul className="dw-hist-ch">
                      {ch.slice(0, 8).map(([k, [o, n]]) => (
                        <li key={k}><span>{fieldLabel(k)}</span><s>{fmt(k, o)}</s><DwIcon name="arrow" /><b>{fmt(k, n)}</b></li>
                      ))}
                      {ch.length > 8 && <li className="is-more">+{ch.length - 8} more</li>}
                    </ul>
                  )}
                  <p className="dw-hist-by">{who(r.actor)}{r.detail?.backfill ? " · from earlier records" : ""} · <time title={t.abs}>{t.rel || t.abs}</time></p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {rows && rows.length > 12 && (
        <button type="button" className="dw-hist-more" onClick={() => setAll((x) => !x)}>{all ? "Show less" : `Show all ${rows.length}`}</button>
      )}
    </section>
  );
}
