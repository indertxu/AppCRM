/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import {
  listContacts, saveContact, deleteContact, listCompanies,
  myProfile, isSalesLead, listEmployees, loadContactAssignees, setContactAssignees,
  listContactFields, addContactField, updateContactField, deleteContactField,
  loadRelationshipSets, type RelationshipSets, contactStatus,
  loadPrefs, savePref,
  type Contact, type Company, type Employee, type ContactField,
} from "../companies/companiesApi";
import {
  AddressFields, PhoneField, StatusPills, HistorySection, phoneText, telHref,
  FilterBar, FilterChips, SortHead, applyView, nextSort, emptyView, useSavedViews, useStoredView, type FField,
  useBulkSelection, BulkBar, BulkCheck, type BulkAction, DataCleanup,
} from "../companies/CompaniesPage";
import "../clients/ClientsPage.css";
import "../companies/CompaniesPage.css";
import ContactImport from "./ContactImport";
import ContactExport from "./ContactExport";
import ActionsMenu, { AM_ICON } from "../../framework/ActionsMenu";
import { LinkedInExtensionModal } from "./LinkedInCapture";
import {
  PROFILE_FIELDS, isRequired, isProfileKey, missingProfile, tidyProfile, formatAddress,
  languageOptions, languageName, countryOptions, countryLabel, withProfileCodes, normalizeLinkedIn, isLinkedIn, linkedInHandle, isReservedLabel,
  type ProfileKey,
} from "./contactProfile";
import "./ContactsPage.css";

const empty = (): Contact => ({
  first_name: "", last_name: "", position: "", email: "", phone: "", phone_ext: "", landline: "", landline_ext: "", is_billing: false, notes: "", companyIds: [],
  street: "", addr_number: "", postal_code: "", city: "", province: "", country: "", language: "", linkedin: "",
});

const fullName = (c: Contact) => [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed";

// Strip accents/diacritics so "brujula" matches "brújula".
const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export default function ContactsPage() {
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [q, setQ] = useState("");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [assignees, setAssignees] = useState<Record<string, string[]>>({});
  const [me, setMe] = useState<{ id: string; role: string; is_superadmin: boolean } | null>(null);
  const [fields, setFields] = useState<ContactField[]>([]);
  const [showFieldSettings, setShowFieldSettings] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [columns, setColumns] = useState<string[]>(["position", "email", "companies"]);
  const [exporting, setExporting] = useState(false);
  const [linkedInOpen, setLinkedInOpen] = useState(false);
  const [rel, setRel] = useState<RelationshipSets | null>(null);
  // filters + sort (remembered on this browser), and the views you saved
  const [view, setView] = useStoredView("np-contacts-view", emptyView([{ key: "name", dir: "asc" }]));
  const [savedViews, setSavedViews] = useSavedViews("contactViews");
  const [filtersOpenTick, setFiltersOpenTick] = useState(0);
  const location = useLocation();

  const reload = async () => {
    setContacts(await listContacts().catch(() => []));
    setCompanies(await listCompanies().catch(() => []));
    setAssignees(await loadContactAssignees().catch(() => ({})));
    setFields(await listContactFields().catch(() => []));
    setRel(await loadRelationshipSets().catch(() => null));
  };
  useEffect(() => {
    myProfile().then(setMe).catch(() => {});
    listEmployees().then(setEmployees).catch(() => {});
    loadPrefs().then((p) => { if (Array.isArray(p.contactColumns)) setColumns(p.contactColumns); }).catch(() => {});
    reload();
  }, []);

  // Opened from a company row: jump straight into that contact.
  useEffect(() => {
    const id = (location.state as any)?.focusContactId;
    if (!id || contacts.length === 0) return;
    const c = contacts.find((x) => x.id === id);
    if (c) setEditing(structuredClone(c));
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, contacts]);

  const lead = isSalesLead(me);

  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? "—";
  // Company pill in the list → that company on the Companies page, with its panel open.
  const openCompany = (id: string) => navigate("/companies", { state: { focusCompanyId: id } });

  // All columns the user can pick from: fixed ones + custom fields.
  const availableColumns = [
    { key: "position", label: "Position" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Mobile" },
    { key: "landline", label: "Landline" },
    { key: "companies", label: "Companies" },
    { key: "address", label: "Address" },
    { key: "city", label: "City" },
    { key: "province", label: "Province" },
    { key: "postal_code", label: "Postal code" },
    { key: "country", label: "Country" },
    { key: "language", label: "Language" },
    { key: "linkedin", label: "LinkedIn" },
    ...fields.map((f) => ({ key: f.id, label: f.label })),
  ];
  const columnLabel = (key: string) => availableColumns.find((c) => c.key === key)?.label ?? key;
  const activeColumns = columns.filter((k) => availableColumns.some((c) => c.key === k)).slice(0, 4);

  const setColumnsPersist = (next: string[]) => { setColumns(next); savePref("contactColumns", next).catch(() => {}); };

  // Render one cell for a given column key + contact.
  const fieldById = (id: string) => fields.find((f) => f.id === id);
  const renderCell = (c: Contact, key: string) => {
    if (key === "position") return <span className="ct-lmuted">{c.position || "—"}</span>;
    if (key === "email") return <span className="ct-lemail">{c.email || "—"}</span>;
    if (key === "phone") return <span className="ct-lmuted">{phoneText(c.phone, c.phone_ext) || "—"}</span>;
    if (key === "landline") return <span className="ct-lmuted">{phoneText(c.landline, c.landline_ext) || "—"}</span>;
    if (key === "companies") return c.companyIds.length === 0
      ? <span className="ct-lmuted">—</span>
      : <span className="ct-lcompanies">
          {c.companyIds.slice(0, 2).map((id) => (
            <span key={id} className="ct-chip is-link" role="link" tabIndex={0} title={`Open ${companyName(id)}`}
              onClick={(e) => { e.stopPropagation(); openCompany(id); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); openCompany(id); } }}>
              {companyName(id)}
            </span>
          ))}
          {c.companyIds.length > 2 && <span className="ct-chip ct-chip-more">+{c.companyIds.length - 2}</span>}
        </span>;
    // built-in profile fields
    if (key === "address") return <span className="ct-lmuted">{formatAddress(c) || "—"}</span>;
    if (key === "language") return <span className="ct-lmuted">{c.language ? languageName(c.language) : "—"}</span>;
    if (key === "country") return <span className="ct-lmuted">{c.country ? countryLabel(c.country) : "—"}</span>;
    if (key === "linkedin") return <span className="ct-lemail" title={c.linkedin ?? ""}>{c.linkedin ? linkedInHandle(c.linkedin) : "—"}</span>;
    if (isProfileKey(key)) return <span className="ct-lmuted">{(c as any)[key] || "—"}</span>;
    // custom field
    const f = fieldById(key);
    const v = (c.custom ?? {})[key];
    if (!f) return <span className="ct-lmuted">—</span>;
    if (v == null || v === "") return <span className="ct-lmuted">—</span>;
    if (f.type === "boolean") return <span className="ct-lmuted">{v ? "Yes" : "No"}</span>;
    return <span className="ct-lmuted">{String(v)}</span>;
  };

  // ---- Every field the list can be filtered and sorted by ----
  const people = () => employees.map((e) => ({ value: e.id, label: e.name }));
  const valuesOf = (get: (c: Contact) => unknown, label?: (v: string) => string) => () =>
    [...new Set(contacts.map((c) => String(get(c) ?? "").trim()).filter(Boolean))].map((v) => ({ value: v, label: label ? label(v) : v })).sort((a, b) => a.label.localeCompare(b.label));
  const coById = new Map(companies.map((co) => [co.id as string, co]));
  const statusOf = (c: Contact) => contactStatus(c, rel, companies);
  const statusTags = (c: Contact) => { const s = statusOf(c); return [...(s.client ? ["client"] : []), ...(s.sales ? ["sales"] : []), ...(!s.client && !s.sales ? ["none"] : [])]; };
  const coList = (c: Contact) => c.companyIds.map((id) => coById.get(id)).filter((x): x is Company => !!x);
  const allPipes = () => [...new Set([...Object.values(rel?.pipesByContact ?? {}).flat(), ...Object.values(rel?.pipesByCompany ?? {}).flat()])].sort().map((p) => ({ value: p, label: p }));
  const coValues = (get: (co: Company) => string[]) => () => [...new Set(companies.flatMap(get).filter(Boolean))].sort().map((v) => ({ value: v, label: v }));
  const filterFields: FField<Contact>[] = [
    { key: "name", label: "Name", group: "Person", type: "text", get: fullName },
    { key: "first_name", label: "First name", group: "Person", type: "text", get: (c) => c.first_name },
    { key: "last_name", label: "Last name", group: "Person", type: "text", get: (c) => c.last_name },
    { key: "position", label: "Position", group: "Person", type: "text", get: (c) => c.position },
    { key: "email", label: "Email", group: "Contact details", type: "text", get: (c) => c.email },
    { key: "phone", label: "Mobile", group: "Contact details", type: "text", get: (c) => phoneText(c.phone, c.phone_ext) },
    { key: "landline", label: "Landline", group: "Contact details", type: "text", get: (c) => phoneText(c.landline, c.landline_ext) },
    { key: "linkedin", label: "LinkedIn", group: "Contact details", type: "text", get: (c) => c.linkedin },
    { key: "language", label: "Language", group: "Contact details", type: "select", get: (c) => c.language ?? "", options: valuesOf((c) => c.language, (v) => languageName(v)) },
    { key: "companies", label: "Company", group: "Companies", type: "multi", get: (c) => c.companyIds, options: () => companies.filter((co) => co.id).map((co) => ({ value: co.id!, label: co.name })).sort((a, b) => a.label.localeCompare(b.label)) },
    { key: "companies_count", label: "Number of companies", group: "Companies", type: "number", get: (c) => c.companyIds.length },
    { key: "co_sector", label: "Company sector", group: "Companies", type: "multi", get: (c) => coList(c).map((co) => co.sector ?? "").filter(Boolean), options: coValues((co) => [co.sector ?? ""]) },
    { key: "co_type", label: "Company type (client, partner…)", group: "Companies", type: "multi", get: (c) => [...new Set(coList(c).flatMap((co) => co.relationship ?? []))], options: coValues((co) => co.relationship ?? []) },
    { key: "co_city", label: "Company city", group: "Companies", type: "multi", get: (c) => coList(c).map((co) => (co.city ?? "").trim()).filter(Boolean), options: coValues((co) => [(co.city ?? "").trim()]) },
    { key: "status", label: "Sales status", group: "Sales", type: "multi", get: statusTags, options: () => [{ value: "client", label: "Client" }, { value: "sales", label: "In sales" }, { value: "none", label: "Not yet in play" }] },
    { key: "pipelines", label: "Pipeline", group: "Sales", type: "multi", get: (c) => statusOf(c).pipelines, options: allPipes },
    { key: "address", label: "Full address", group: "Address", type: "text", get: (c) => formatAddress(c) },
    { key: "street", label: "Street", group: "Address", type: "text", get: (c) => [c.street, c.addr_number].filter(Boolean).join(" ") },
    { key: "postal_code", label: "Postal code", group: "Address", type: "text", get: (c) => c.postal_code },
    { key: "city", label: "City", group: "Address", type: "select", get: (c) => (c.city ?? "").trim(), options: valuesOf((c) => c.city) },
    { key: "province", label: "Province / state", group: "Address", type: "select", get: (c) => (c.province ?? "").trim(), options: valuesOf((c) => c.province) },
    { key: "country", label: "Country", group: "Address", type: "select", get: (c) => c.country ?? "", options: valuesOf((c) => c.country, (v) => countryLabel(v)) },
    { key: "addr_complete", label: "Address complete", group: "Address", type: "boolean", get: (c) => missingProfile(c).length === 0 },
    { key: "visible_to", label: "Visible to", group: "Record", type: "multi", get: (c) => assignees[c.id ?? ""] ?? [], options: people },
    { key: "created_at", label: "Created on", group: "Record", type: "date", get: (c) => (c as any).created_at },
    { key: "imported_by", label: "Imported by", group: "Record", type: "select", get: (c) => (c as any).imported_by ?? "", options: people },
    { key: "imported_at", label: "Imported on", group: "Record", type: "date", get: (c) => (c as any).imported_at },
    { key: "notes", label: "Notes", group: "Record", type: "text", get: (c) => c.notes },
    ...fields.map((f): FField<Contact> => ({
      key: f.id, label: f.label, group: "Your fields", type: f.type === "select" ? "select" : f.type,
      get: (c) => (c.custom ?? {})[f.id], ...(f.type === "select" ? { options: () => f.options.map((o) => ({ value: o, label: o })) } : {}),
    })),
  ];

  // Sales people only see the contacts they have been given access to.
  const visible = contacts.filter((c) => lead || !me || (assignees[c.id!] ?? []).includes(me.id));
  const searched = (() => {
    const n = norm(q.trim());
    if (!n) return visible;
    return visible.filter((c) => [fullName(c), c.position, c.email, c.phone, c.city, c.province, c.companyIds.map(companyName).join(" ")].some((v) => norm(v ?? "").includes(n)));
  })();
  const shown = applyView(searched, filterFields, view, (a, b) => fullName(a).localeCompare(fullName(b)));
  const onSort = (key: string, add: boolean) => setView({ ...view, sort: nextSort(view.sort, key, add) });

  // ---- Multi-select: link, assign, export or delete many contacts at once ----
  const bulk = useBulkSelection(shown.map((c) => c.id as string));
  const [exportIds, setExportIds] = useState<string[] | null>(null);
  const picked = () => contacts.filter((c) => bulk.has(c.id as string));
  const bulkActions: BulkAction[] = [
    {
      key: "company", label: "Add to company",
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="10" height="18" rx="1.5" /><path d="M14 8h6v13H4M18 2v4M16 4h4" /></svg>,
      options: companies.map((co) => ({ value: co.id as string, label: co.name })),
      run: async (v) => {
        if (!v) return null;
        for (const c of picked()) {
          if (c.companyIds.includes(v)) continue;
          const err = await saveContact({ ...c, companyIds: [...c.companyIds, v] });
          if (err) return err;
        }
        await reload(); bulk.clear();
        return null;
      },
    },
    {
      key: "uncompany", label: "Remove from company", more: true,
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="10" height="18" rx="1.5" /><path d="M14 8h6v13H4M16 4h4" /></svg>,
      options: companies.filter((co) => picked().some((c) => c.companyIds.includes(co.id as string))).map((co) => ({ value: co.id as string, label: co.name })),
      run: async (v) => {
        if (!v) return null;
        let n = 0;
        for (const c of picked()) {
          if (!c.companyIds.includes(v)) continue;
          const err = await saveContact({ ...c, companyIds: c.companyIds.filter((x) => x !== v) });
          if (err) return err;
          n++;
        }
        await reload(); bulk.clear();
        return { done: `${n} taken off ${companies.find((co) => co.id === v)?.name ?? "the company"}` };
      },
    },
    {
      key: "assign", label: "Assign to",
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" /></svg>,
      options: employees.map((e) => ({ value: e.id, label: e.name, hint: e.role?.replace(/_/g, " ") })),
      disabledReason: lead ? undefined : "Only boss and sales managers can assign contacts.",
      run: async (v) => {
        if (!v) return null;
        for (const c of picked()) {
          const cur = assignees[c.id as string] ?? [];
          if (!cur.includes(v)) await setContactAssignees(c.id as string, [...cur, v]);
        }
        await reload(); bulk.clear();
        return null;
      },
    },
    {
      key: "export", label: "Export these", more: true,
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>,
      run: () => { setExportIds(bulk.ids); setExporting(true); return null; },
    },
    {
      key: "delete", label: "Delete", danger: true, more: true,
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>,
      disabledReason: lead ? undefined : "Only boss and sales managers can delete contacts.",
      run: async () => {
        for (const id of bulk.ids) { const err = await deleteContact(id); if (err) { await reload(); return err; } }
        bulk.clear(); await reload();
        return null;
      },
    },
  ];

  if (me && !isSalesLead(me) && me.role !== "sales") {
    return (
      <div className="ct">
        <header className="ct-head">
          <button className="ct-back" onClick={() => navigate("/home")} aria-label="Back">‹</button>
          <h1 className="ct-title">Contacts</h1>
        </header>
        <p className="cl-hint">This page is only available to the sales team.</p>
      </div>
    );
  }

  return (
    <div className="ct">
      <header className="ct-head">
        <button className="ct-back" onClick={() => navigate("/home")} aria-label="Back">‹</button>
        <h1 className="ct-title">Contacts</h1>
        <span className="ct-kpi"><b>{shown.length.toLocaleString("en-GB")}</b>{shown.length !== visible.length ? `of ${visible.length.toLocaleString("en-GB")} ` : ""}{visible.length === 1 ? "contact" : "contacts"}</span>
        <div className="ct-search">
          <span className="ct-search-ico">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, position, company or city…" />
          {q && <button onClick={() => setQ("")}>×</button>}
        </div>
        <FilterBar fields={filterFields} view={view} onView={setView} total={visible.length} shown={shown.length} noun={["contact", "contacts"]}
          saved={savedViews} onSaved={setSavedViews} openSignal={filtersOpenTick} />
        <ActionsMenu items={[
          { key: "new", group: "Create", label: "New contact", hint: "Add one person by hand", icon: AM_ICON.plus, primary: true, tone: "green", shortcut: "N", onSelect: () => setEditing(empty()) },
          { key: "import", group: "Data", label: "Import", hint: "From Excel or CSV, with their companies", icon: AM_ICON.import, tone: "blue", shortcut: "I", onSelect: () => setImporting(true) },
          { key: "export", group: "Data", label: "Export", hint: "Pick contacts by company, deal or phase", icon: AM_ICON.export, tone: "violet", shortcut: "E", onSelect: () => setExporting(true) },
          { key: "linkedin", group: "Data", label: "Save from LinkedIn", hint: "Browser extension: add people & companies from LinkedIn", icon: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2zM4 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" /></svg>, tone: "blue", shortcut: "L", onSelect: () => setLinkedInOpen(true) },
          { key: "fields", group: "Setup", label: "Fields & columns", hint: "Custom fields and what the list shows", icon: AM_ICON.fields, tone: "amber", shortcut: "F", onSelect: () => setShowFieldSettings(true) },
          ...(lead ? [{ key: "cleanup", group: "Setup", label: "Clean up data", hint: "Fix doubled surnames, legal names and street numbers", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4l5 5M4 20l7-7M13.5 5.5l5 5-7.5 7.5H6v-5z" /></svg>, tone: "amber" as const, onSelect: () => setCleaning(true) },] : []),
        ]} />
      </header>

      <FilterChips fields={filterFields} view={view} onView={setView} onEdit={() => setFiltersOpenTick((x) => x + 1)} shown={shown.length} total={visible.length} noun={["contact", "contacts"]} />

      {shown.length === 0 ? (
        <p className="cl-hint">{contacts.length === 0 ? "No contacts yet. Add your first one." : "No contacts match your search and filters."}</p>
      ) : (
        <div className="ct-scroll">
          <div className="ct-lrow ct-lhead" style={{ gridTemplateColumns: `1.9fr ${activeColumns.map(() => "1.4fr").join(" ")}` }}>
            <span className="ct-lid-head"><BulkCheck on={bulk.allOn} partial={bulk.someOn} onToggle={bulk.toggleAll} label="Select every contact shown" /><SortHead label="Name" k="name" sort={view.sort} onSort={onSort} /></span>
            {activeColumns.map((k) => <span key={k}><SortHead label={columnLabel(k)} k={k} sort={view.sort} onSort={onSort} /></span>)}
          </div>
          <div className="ct-list">
            {shown.map((c) => (
              <button key={c.id} className={`ct-lrow ${bulk.has(c.id as string) ? "is-sel" : ""} ${bulk.active ? "is-selecting" : ""}`}
                onClick={(e) => { if (bulk.active || e.shiftKey || e.metaKey || e.ctrlKey) bulk.toggle(c.id as string, e.shiftKey); else setEditing(structuredClone(c)); }}
                style={{ gridTemplateColumns: `1.9fr ${activeColumns.map(() => "1.4fr").join(" ")}` }}>
                <span className="ct-lcell ct-lid">
                  <span className="ct-av-wrap">
                    <span className="ct-avatar">{fullName(c).slice(0, 1).toUpperCase()}</span>
                    <BulkCheck on={bulk.has(c.id as string)} onToggle={(e) => bulk.toggle(c.id as string, e.shiftKey)} label={`Select ${fullName(c)}`} />
                  </span>
                  <span className="ct-lname">{fullName(c)}</span>
                  <StatusPills status={statusOf(c)} />
                </span>
                {activeColumns.map((k) => <span key={k} className="ct-lcell">{renderCell(c, k)}</span>)}
              </button>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <ContactEditor
          contact={editing}
          companies={companies}
          employees={employees}
          fields={fields}
          canAssign={lead}
          rel={rel}
          assigned={assignees[editing.id!] ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
          onDeleted={async () => { setEditing(null); await reload(); }}
          onOpenCompany={openCompany}
        />
      )}

      {exporting && (
        <ContactExport
          contacts={contacts.filter((c) => lead || !me || (assignees[c.id!] ?? []).includes(me.id))}
          companies={companies}
          contactFields={fields}
          shownIds={exportIds ?? shown.map((c) => c.id as string)}
          onClose={() => { setExporting(false); setExportIds(null); }}
        />
      )}

      <BulkBar count={bulk.ids.length} noun={["contact", "contacts"]} actions={bulkActions} onClear={bulk.clear}
        onSelectAll={bulk.toggleAll} allOn={bulk.allOn} total={shown.length} />

      {linkedInOpen && <LinkedInExtensionModal onClose={() => setLinkedInOpen(false)} />}

      {importing && (
        <ContactImport
          fields={fields}
          onClose={() => setImporting(false)}
          onDone={async () => { await reload(); }}
        />
      )}

      {cleaning && <DataCleanup onClose={() => setCleaning(false)} onDone={() => { void reload(); }} />}
      {showFieldSettings && (
        <FieldSettings
          fields={fields}
          availableColumns={availableColumns}
          columns={activeColumns}
          onColumns={setColumnsPersist}
          onClose={() => setShowFieldSettings(false)}
          onChanged={async () => { setFields(await listContactFields().catch(() => [])); }}
        />
      )}
    </div>
  );
}

function ContactEditor({ contact, companies, employees, fields, canAssign, assigned, rel, onClose, onSaved, onDeleted, onOpenCompany }: {
  contact: Contact; companies: Company[]; employees: Employee[]; fields: ContactField[]; canAssign: boolean; assigned: string[];
  rel: RelationshipSets | null;
  onClose: () => void; onSaved: () => void; onDeleted: () => void;
  /** Open a company on the Companies page. */
  onOpenCompany: (id: string) => void;
}) {
  // old free-text values ("España", "Español") become codes as soon as the contact is opened
  const [c, setC] = useState<Contact>(() => withProfileCodes(contact));
  const [initial] = useState(() => JSON.stringify(withProfileCodes(contact)));
  const [who, setWho] = useState<string[]>(assigned);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Contact>) => setC((x) => ({ ...x, ...patch }));

  const { closing, close } = useDrawerClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const companyName = (id: string) => companies.find((x) => x.id === id)?.name ?? "—";
  const available = companies.filter((co) => !c.companyIds.includes(co.id!));
  const addCompany = (id: string) => set({ companyIds: [...c.companyIds, id] });
  const removeCompany = (id: string) => set({ companyIds: c.companyIds.filter((x) => x !== id) });

  const setCustom = (fieldId: string, value: any) =>
    setC((x) => ({ ...x, custom: { ...(x.custom ?? {}), [fieldId]: value } }));
  const customVal = (fieldId: string) => (c.custom ?? {})[fieldId];

  // Built-in fields: a "*" when required, and the pick lists (built once).
  const req = (k: ProfileKey) => (isRequired(k) ? <span className="dw-req"> *</span> : null);
  const [langOpts] = useState(() => [{ value: "__none", label: "— Not set" }, ...languageOptions()]);
  const [countryOpts] = useState(() => countryOptions());
  // A country typed in by an import that isn't in the list still shows (and can be replaced).
  const countryChoices = c.country && !countryOpts.some((o) => o.value === c.country)
    ? [{ value: c.country, label: `${c.country} (as imported)` }, ...countryOpts] : countryOpts;
  const langChoices = c.language && !langOpts.some((o) => o.value === c.language)
    ? [langOpts[0], { value: c.language, label: `${c.language} (as imported)` }, ...langOpts.slice(1)] : langOpts;

  const save = async () => {
    if (!c.first_name.trim()) { setErr("A first name is required."); return; }
    // Built-in required fields (address…).
    const missing = missingProfile(c);
    if (missing.length) { setErr(`Please fill in: ${missing.join(", ")}.`); return; }
    const linkedin = normalizeLinkedIn(c.linkedin);
    if (linkedin && !isLinkedIn(linkedin)) { setErr("LinkedIn: paste the profile link (linkedin.com/in/…)."); return; }
    // Enforce required custom fields.
    for (const f of fields) {
      if (!f.required) continue;
      const v = customVal(f.id);
      const empty = v == null || v === "" || (f.type === "boolean" && v === false);
      if (empty) { setErr(`"${f.label}" is required.`); return; }
    }
    setBusy(true); setErr(null);
    const toSave: Contact = { ...c, ...tidyProfile(c) };
    const e = await saveContact(toSave);
    // saveContact fills in the id of a new contact on the object it was given
    if (!e && toSave.id) await setContactAssignees(toSave.id, who).catch(() => {});
    setBusy(false);
    if (e) setErr(e); else close(onSaved);
  };
  const remove = async () => {
    if (!c.id) return close();
    if (!confirm(`Delete "${[c.first_name, c.last_name].filter(Boolean).join(" ")}" permanently?`)) return;
    await deleteContact(c.id);
    close(onDeleted);
  };

  // ---- the panel: a hero on top, a section index on the left that follows the scroll ----
  const { bodyRef, active, goTo } = useDrawerSections("person");
  const displayName = [c.first_name, c.last_name].filter(Boolean).join(" ");
  const initials = [c.first_name, c.last_name].map((x) => (x ?? "").trim()[0] ?? "").join("").toUpperCase();
  const missing = missingProfile(c);
  const li = normalizeLinkedIn(c.linkedin);
  const sections: DwNavItem[] = [
    { k: "person", label: "Person", icon: "person" },
    { k: "reach", label: "Contact details", icon: "mail" },
    { k: "address", label: "Address", icon: "pin", warn: missing.length > 0 },
    { k: "companies", label: "Companies", icon: "building", count: c.companyIds.length },
    ...(canAssign ? [{ k: "access", label: "Visibility", icon: "lock", count: who.length }] : []),
    ...(fields.length ? [{ k: "custom", label: "Additional details", icon: "sliders" }] : []),
    { k: "notes", label: "Notes", icon: "note" },
    { k: "history", label: "History", icon: "clock" },
  ];
  const status = contactStatus(c, rel, companies);
  // history: field names and values in words
  const FIELD_NAMES: Record<string, string> = {
    first_name: "First name", last_name: "Last name", position: "Position", email: "Email", phone: "Mobile", phone_ext: "Mobile ext.",
    landline: "Landline", landline_ext: "Landline ext.", notes: "Notes", street: "Street", addr_number: "Number", postal_code: "Postal code",
    city: "City", province: "Province", country: "Country", language: "Language", linkedin: "LinkedIn",
  };
  const histLabel = (k: string) => k.startsWith("custom.") ? fields.find((f) => f.id === k.slice(7))?.label ?? null : FIELD_NAMES[k] ?? null;
  const histValue = (k: string, v: any) => v == null || v === "" ? "—" : k === "country" ? countryLabel(v) : k === "language" ? languageName(String(v)) : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);

  return (
    <div className={`dw-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={() => close()}>
      <div className="dw is-wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={displayName || "New contact"}>
        <header className="dw-hero">
          <span className="dw-hero-av is-round">{initials || "+"}</span>
          <div className="dw-hero-txt">
            <span className="dw-eyebrow">{c.id ? "Contact" : "New contact"}</span>
            <h2 className="dw-title">{displayName || "New contact"}</h2>
            <p className="dw-hero-sub">{[c.position, c.companyIds.map(companyName).join(", ")].filter(Boolean).join(" · ") || "Fill in the details below"}</p>
            <div className="dw-hero-tags">
              <StatusPills status={status} hero />
              {c.email && <a className="dw-tag" href={`mailto:${c.email}`}><DwIcon name="mail" />{c.email}</a>}
              {c.phone && <a className="dw-tag" href={telHref(c.phone, c.phone_ext)}><DwIcon name="phone" />{phoneText(c.phone, c.phone_ext)}</a>}
              {c.landline && <a className="dw-tag" href={telHref(c.landline, c.landline_ext)}><DwIcon name="phone" />{phoneText(c.landline, c.landline_ext)}</a>}
              {isLinkedIn(li) && <a className="dw-tag" href={li} target="_blank" rel="noreferrer"><DwIcon name="link" />LinkedIn</a>}
              {(c.city || c.country) && <span className="dw-tag"><DwIcon name="pin" />{[c.city, c.country ? countryLabel(c.country) : ""].filter(Boolean).join(", ")}</span>}
              {c.language && <span className="dw-tag"><DwIcon name="globe" />{languageName(c.language)}</span>}
              {missing.length > 0 && <button type="button" className="dw-tag is-warn" onClick={() => goTo("address")}>Address incomplete</button>}
            </div>
          </div>
          <button className="dw-x" onClick={() => close()} aria-label="Close">×</button>
        </header>

        <div className="dw-layout">
          <DwNav items={sections} active={active} onGo={goTo} />

          <div className="dw-body" ref={bodyRef}>
            <section className="dw-sec" data-sec="person" data-tone="green">
              <DwSecHead icon="person" title="Person" hint="Who they are and what they do" />
              <div className="dw-grid">
                <div className="dw-f"><label>First name<span className="dw-req"> *</span></label>
                  <input value={c.first_name} onChange={(e) => set({ first_name: e.target.value })} placeholder="e.g. Ana" />
                </div>
                <div className="dw-f"><label>Last name</label>
                  <input value={c.last_name ?? ""} onChange={(e) => set({ last_name: e.target.value })} placeholder="e.g. López García" />
                </div>
                <div className="dw-f dw-col2"><label>Position / title</label>
                  <input value={c.position ?? ""} onChange={(e) => set({ position: e.target.value })} placeholder="e.g. CFO" />
                </div>
              </div>
            </section>

            <section className="dw-sec" data-sec="reach" data-tone="blue">
              <DwSecHead icon="mail" title="Contact details" hint="How to reach them, and in which language" />
              <div className="dw-grid">
                <div className="dw-f"><label>Email</label>
                  <input type="email" value={c.email ?? ""} onChange={(e) => set({ email: e.target.value })} placeholder="name@company.com" />
                </div>
                <PhoneField label="Mobile" value={c.phone} ext={c.phone_ext} onValue={(v) => set({ phone: v })} onExt={(v) => set({ phone_ext: v })} placeholder="+34 600 000 000" />
                <PhoneField label="Landline" value={c.landline} ext={c.landline_ext} onValue={(v) => set({ landline: v })} onExt={(v) => set({ landline_ext: v })} placeholder="+34 910 000 000" />
                <div className="dw-f"><label>LinkedIn{req("linkedin")}</label>
                  <input value={c.linkedin ?? ""} placeholder="linkedin.com/in/…"
                    onChange={(e) => set({ linkedin: e.target.value })}
                    onBlur={(e) => set({ linkedin: normalizeLinkedIn(e.target.value) })} />
                </div>
                <div className="dw-f"><label>Language{req("language")}</label>
                  <ProfilePicker value={c.language || "__none"} options={langChoices} placeholder="Choose a language…"
                    onChange={(v) => set({ language: v === "__none" ? "" : v })} />
                </div>
              </div>
            </section>

            <section className="dw-sec" data-sec="address" data-tone="amber">
              <DwSecHead icon="pin" title="Address" hint="Where they are — start typing the street or the postal code"
                aside={missing.length ? <span className="dw-pill is-warn">{missing.length} missing</span> : <span className="dw-pill is-ok">Complete</span>} />
              <AddressFields value={c} onChange={(p) => set(p as Partial<Contact>)} countryAs="code" req={(k) => req(k as ProfileKey)}
                renderCountry={() => (
                  <ProfilePicker value={c.country ?? ""} options={countryChoices} placeholder="Choose a country…"
                    onChange={(v) => set({ country: v })} />
                )} />
            </section>

            <section className="dw-sec" data-sec="companies" data-tone="indigo">
              <DwSecHead icon="building" title="Companies" hint="Where they work — a contact can belong to several"
                aside={c.companyIds.length ? <span className="dw-pill">{c.companyIds.length}</span> : undefined} />
              <div className="dw-chips">
                {c.companyIds.map((id) => (
                  <span key={id} className="dw-chip is-link">
                    <button type="button" className="dw-chip-go" title={`Open ${companyName(id)} in Companies`}
                      onClick={() => { if (JSON.stringify(c) !== initial && !confirm("Leave this contact without saving your changes?")) return; close(() => onOpenCompany(id)); }}>
                      <DwIcon name="building" />{companyName(id)}<span className="dw-chip-arrow"><DwIcon name="arrow" /></span>
                    </button>
                    <button onClick={() => removeCompany(id)} aria-label="Remove">×</button>
                  </span>
                ))}
              </div>
              {c.companyIds.length === 0 && <p className="dw-empty-hint">Not linked to any company yet (optional).</p>}
              {available.length > 0 && (
                <Select value="" onChange={(v) => v && addCompany(v)} placeholder="+ Link a company"
                  options={available.map((co) => ({ value: co.id!, label: co.name }))} />
              )}
            </section>

            {canAssign && (
              <section className="dw-sec" data-sec="access" data-tone="violet">
                <DwSecHead icon="lock" title="Visibility" hint="Who in the team can see this contact" />
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
              <DwSecHead icon="note" title="Notes" hint="Anything worth remembering about this person" />
              <textarea className="dw-area" value={c.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="How you met, what they care about, next steps…" />
            </section>

            <HistorySection entity="contact" id={c.id} employees={employees} fieldLabel={histLabel} formatValue={histValue} />
          </div>
        </div>

        <footer className="dw-foot">
          {c.id && <button className="dw-del" onClick={remove}>Delete</button>}
          <span className={`dw-foot-note ${err ? "is-err" : missing.length ? "is-warn" : ""}`}>
            {err ?? (missing.length ? `Still missing: ${missing.join(", ")}` : c.id ? "Everything required is filled in." : "Nothing is saved until you click Save.")}
          </span>
          <div className="dw-foot-right">
            <button className="dw-cancel" onClick={() => close()}>Cancel</button>
            <button className="dw-save" onClick={save} disabled={busy}>{busy ? "Saving…" : c.id ? "Save changes" : "Create contact"}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
// ============================ Field settings modal ============================
function FieldSettings({ fields, availableColumns, columns, onColumns, onClose, onChanged }: {
  fields: ContactField[];
  availableColumns: { key: string; label: string }[];
  columns: string[];
  onColumns: (next: string[]) => void;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [items, setItems] = useState<ContactField[]>(fields);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // new-field draft
  const [label, setLabel] = useState("");
  const [type, setType] = useState<ContactField["type"]>("text");
  const [required, setRequired] = useState(false);
  const [optionsText, setOptionsText] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refresh = async () => { await onChanged(); setItems(await listContactFields().catch(() => [])); };

  const add = async () => {
    if (!label.trim()) return;
    if (isReservedLabel(label)) { setAddErr(`“${label.trim()}” is already a built-in field on every contact.`); return; }
    setAddErr(null);
    setBusy(true);
    const options = type === "select" ? optionsText.split(",").map((s) => s.trim()).filter(Boolean) : [];
    await addContactField({ label: label.trim(), type, required, options, sort: items.length });
    setLabel(""); setType("text"); setRequired(false); setOptionsText("");
    await refresh();
    setBusy(false);
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this field? Existing contacts keep their stored value but it won't show anymore.")) return;
    await deleteContactField(id);
    await refresh();
  };
  const toggleRequired = async (f: ContactField) => {
    await updateContactField(f.id, { required: !f.required });
    await refresh();
  };

  const TYPE_LABEL: Record<ContactField["type"], string> = {
    text: "Text", number: "Number", date: "Date", boolean: "Yes / No", select: "Dropdown",
  };

  return (
    <div className="dw-backdrop" onMouseDown={onClose}>
      <div className="dw dw-narrow" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dw-head">
          <div>
            <span className="dw-eyebrow">Configure</span>
            <h2 className="dw-title">Contact fields</h2>
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
                    // insert dragged before/after k depending on cursor position in the row
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
            <p className="dw-sec-title">Built-in fields</p>
            <div className="cf-list">
              {PROFILE_FIELDS.map((f) => (
                <div className="cf-row is-builtin" key={f.key}>
                  <div className="cf-row-main">
                    <span className="cf-row-name">{f.label}</span>
                    <span className="cf-row-type">{f.key === "language" ? "Language list" : f.key === "country" ? "Country list" : f.key === "linkedin" ? "LinkedIn link" : f.key === "province" ? "Text · filled from the postal code" : "Text"} · on every contact</span>
                  </div>
                  {f.required && <span className="cf-col-tag">required</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="dw-sec">
            <p className="dw-sec-title">Your custom fields</p>
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
                      className={`cf-req ${f.required ? "on" : ""}`} onClick={() => toggleRequired(f)}
                      title="Required">Required</button>
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
                <input value={label} onChange={(e) => { setLabel(e.target.value); setAddErr(null); }} placeholder="e.g. Birthday, VIP, Source" />
              </div>
              <div className="dw-f"><label>Type</label>
                <Select value={type} onChange={(v) => setType(v as ContactField["type"])}
                  options={[
                    { value: "text", label: "Text" },
                    { value: "number", label: "Number" },
                    { value: "date", label: "Date" },
                    { value: "boolean", label: "Yes / No" },
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
                  <input value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder="e.g. Low, Medium, High" />
                </div>
              )}
            </div>
            {addErr && <p className="dw-err">{addErr}</p>}
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

// ============================ Searchable picker (country, language) ============================
/**
 * Searchable single-choice picker for long lists (countries, languages) inside
 * the contact editor. The list opens attached to the field (below, or above when
 * there's no room), follows it when the editor scrolls, and scrolls on its own
 * with the mouse wheel. Keyboard: ↑ ↓ Enter, Esc closes only the list.
 */
interface PickOption { value: string; label: string }

interface Pos { left: number; width: number; top?: number; bottom?: number; maxH: number }

function ProfilePicker({ value, options, onChange, placeholder = "Choose…" }: {
  value: string;
  options: PickOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<Pos | null>(null);
  const trigRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const n = norm(q.trim());
    return n ? options.filter((o) => norm(o.label).includes(n) || norm(o.value) === n) : options;
  }, [q, options]);

  const place = () => {
    const r = trigRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const width = Math.max(r.width, 260);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    if (below >= 240 || below >= above) setPos({ left, width, top: r.bottom + 4, maxH: Math.max(160, Math.min(340, below)) });
    else setPos({ left, width, bottom: window.innerHeight - r.top + 4, maxH: Math.max(160, Math.min(340, above)) });
  };
  const openMenu = () => {
    place(); setQ("");
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const pick = (v: string) => { onChange(v); setOpen(false); trigRef.current?.focus(); };

  // close on a click outside; follow the field when anything around it scrolls or resizes
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !trigRef.current?.contains(t)) setOpen(false);
    };
    const onMove = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) place(); };
    // capture phase: the editor stops mousedown from bubbling, so a normal listener would never hear it
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  // keep the highlighted row visible (also shows the current choice when the list opens)
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[hi]) pick(shown[hi].value); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); trigRef.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <>
      <button ref={trigRef} type="button" className={`pp-trigger ${open ? "is-open" : ""} ${current ? "" : "is-empty"}`}
        aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) { e.preventDefault(); openMenu(); } }}>
        <span>{current?.label ?? placeholder}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className="pp-menu" role="listbox" onMouseDown={(e) => e.stopPropagation()}
          style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}>
          <input className="pp-search" autoFocus value={q} placeholder="Search…" aria-label="Search"
            onChange={(e) => { setQ(e.target.value); setHi(0); }} onKeyDown={onKey} />
          <div ref={listRef} className="pp-list">
            {shown.map((o, i) => (
              <button type="button" key={o.value} data-i={i} role="option" aria-selected={o.value === value}
                className={`pp-opt ${i === hi ? "is-hi" : ""} ${o.value === value ? "is-on" : ""}`}
                onMouseEnter={() => setHi(i)} onClick={() => pick(o.value)}>
                <span>{o.label}</span>{o.value === value && <b>✓</b>}
              </button>
            ))}
            {!shown.length && <p className="pp-empty">No matches</p>}
          </div>
        </div>,
        document.body,
      )}
    </>
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
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
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