/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import {
  listContacts, saveContact, deleteContact, listCompanies,
  myProfile, isSalesLead, listEmployees, loadContactAssignees, setContactAssignees,
  listContactFields, addContactField, updateContactField, deleteContactField,
  loadRelationshipSets, type RelationshipSets,
  loadPrefs, savePref,
  type Contact, type Company, type Employee, type ContactField,
} from "../companies/companiesApi";
import "../clients/ClientsPage.css";
import "../companies/CompaniesPage.css";
import ContactImport from "./ContactImport";
import ContactExport from "./ContactExport";
import SalesMultiFilter from "../sales/sales/SalesMultiFilter";
import ActionsMenu, { AM_ICON } from "../../framework/ActionsMenu";
import "./ContactsPage.css";

const empty = (): Contact => ({
  first_name: "", last_name: "", position: "", email: "", phone: "", is_billing: false, notes: "", companyIds: [],
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
  const [importing, setImporting] = useState(false);
  const [columns, setColumns] = useState<string[]>(["position", "email", "companies"]);
  const [ctrl1, setCtrl1] = useState<{ field: string; action: string; min?: string; max?: string; values?: string[]; text?: string }>({ field: "", action: "" });
  const [ctrl2, setCtrl2] = useState<{ field: string; action: string; min?: string; max?: string; values?: string[]; text?: string }>({ field: "", action: "" });
  const [exporting, setExporting] = useState(false);
  const [rel, setRel] = useState<RelationshipSets | null>(null);
  const [fRel, setFRel] = useState("");  // "", "client", "tracking", "notracking", "none"
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

  // All columns the user can pick from: fixed ones + custom fields.
  const availableColumns = [
    { key: "position", label: "Position" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "companies", label: "Companies" },
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
    if (key === "phone") return <span className="ct-lmuted">{c.phone || "—"}</span>;
    if (key === "companies") return c.companyIds.length === 0
      ? <span className="ct-lmuted">—</span>
      : <span className="ct-lcompanies">
          {c.companyIds.slice(0, 2).map((id) => <span key={id} className="ct-chip">{companyName(id)}</span>)}
          {c.companyIds.length > 2 && <span className="ct-chip ct-chip-more">+{c.companyIds.length - 2}</span>}
        </span>;
    // custom field
    const f = fieldById(key);
    const v = (c.custom ?? {})[key];
    if (!f) return <span className="ct-lmuted">—</span>;
    if (v == null || v === "") return <span className="ct-lmuted">—</span>;
    if (f.type === "boolean") return <span className="ct-lmuted">{v ? "Yes" : "No"}</span>;
    return <span className="ct-lmuted">{String(v)}</span>;
  };

  // ---- Compound filter + sort controls ----
  // The "type" of any filterable field, fixed or custom.
  const fieldType = (key: string): "text" | "number" | "date" | "boolean" | "select" => {
    if (key === "email" || key === "position" || key === "phone" || key === "companies" || key === "name") return "text";
    if (key === "imported_at") return "date";
    if (key === "imported_by") return "select";
    return fieldById(key)?.type ?? "text";
  };
  // The comparable value of a contact for a field key.
  const valueOf = (c: Contact, key: string): any => {
    if (key === "name") return fullName(c);
    if (key === "position") return c.position ?? "";
    if (key === "email") return c.email ?? "";
    if (key === "phone") return c.phone ?? "";
    if (key === "companies") return c.companyIds.map(companyName).join(", ");
    // import provenance (stamped by the database; filterable, never shown on the contact)
    if (key === "imported_by") return (c as any).imported_by ?? "";
    if (key === "imported_at") return (c as any).imported_at ?? "";
    return (c.custom ?? {})[key];
  };
  // What a filter can do with a field, based on its type (the first one is the default).
  const actionsFor = (key: string): { value: string; label: string }[] => {
    if (!key) return [];
    const t = fieldType(key);
    const blanks = [{ value: "has", label: "Has a value" }, { value: "empty", label: "Is empty" }];
    if (key === "companies") return [{ value: "in", label: "Is one of…" }, { value: "has", label: "Has a company" }, { value: "empty", label: "No company" }, { value: "asc", label: "A → Z" }];
    if (key === "imported_by") return [{ value: "in", label: "Is one of…" }, { value: "has", label: "Was imported" }, { value: "empty", label: "Added by hand" }];
    if (t === "select") return [{ value: "in", label: "Is one of…" }, ...blanks];
    if (t === "boolean") return [{ value: "only_yes", label: "Yes" }, { value: "only_no", label: "No" }];
    if (t === "number") return [{ value: "range", label: "Between…" }, { value: "desc", label: "High → low" }, { value: "asc", label: "Low → high" }, ...blanks];
    if (t === "date") return [
      { value: "last30", label: "Last 30 days" }, { value: "this_month", label: "This month" }, { value: "this_year", label: "This year" },
      { value: "next30", label: "Next 30 days" }, { value: "past", label: "Before today" }, { value: "custom", label: "Between dates…" },
      { value: "desc", label: "Newest first" }, { value: "asc", label: "Oldest first" }, ...blanks,
    ];
    return [{ value: "contains", label: "Contains…" }, { value: "asc", label: "A → Z" }, { value: "desc", label: "Z → A" }, ...blanks];
  };
  /** Choices for "Is one of…": a choice field's options, or the companies. */
  const choicesFor = (key: string) => key === "companies"
    ? companies.map((co) => ({ value: co.id as string, label: co.name })).sort((a, b) => a.label.localeCompare(b.label))
    : key === "imported_by"
    ? employees.filter((e) => contacts.some((c) => (c as any).imported_by === e.id)).map((e) => ({ value: e.id, label: e.name }))
    : (fieldById(key)?.options ?? []).map((o) => ({ value: o, label: o }));
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
  // Field options for the control (name + fixed + custom).
  const filterFieldOptions = [
    { value: "", label: "No filter" },
    { value: "name", label: "Name" },
    ...availableColumns.map((c) => ({ value: c.key, label: c.label })),
    { value: "imported_by", label: "Imported by" },
    { value: "imported_at", label: "Imported on" },
  ];

  // Apply one control as a filter (returns true = keep).
  const passesFilter = (c: Contact, ctrl: { field: string; action: string; min?: string; max?: string; values?: string[]; text?: string }) => {
    if (!ctrl.field || !ctrl.action) return true;
    const v = valueOf(c, ctrl.field);
    const blank = v == null || v === "" || (ctrl.field === "companies" && !c.companyIds.length);
    if (ctrl.action === "has") return !blank;
    if (ctrl.action === "empty") return blank;
    if (ctrl.action === "only_yes") return !!v;
    if (ctrl.action === "only_no") return !v;
    if (ctrl.action === "in") {
      const picked = ctrl.values ?? [];
      if (!picked.length) return true; // nothing chosen yet → no filter
      return ctrl.field === "companies" ? c.companyIds.some((id) => picked.includes(id)) : picked.includes(String(v ?? ""));
    }
    if (ctrl.action === "contains") {
      const t = (ctrl.text ?? "").trim();
      return !t || norm(String(v ?? "")).includes(norm(t));
    }
    const win = fieldType(ctrl.field) === "date" ? dateWindow(ctrl.action, ctrl) : null;
    if (win) { const d = String(v ?? "").slice(0, 10); return !!d && d >= win[0] && d <= win[1]; }
    if (ctrl.action.startsWith("eq:")) return String(v ?? "") === ctrl.action.slice(3);
    if (ctrl.action === "range") {
      const n = Number(v);
      if (v == null || v === "" || Number.isNaN(n)) return false; // no value → out of any range
      if (ctrl.min !== undefined && ctrl.min !== "" && n < Number(ctrl.min)) return false;
      if (ctrl.max !== undefined && ctrl.max !== "" && n > Number(ctrl.max)) return false;
      return true;
    }
    return true; // asc/desc are sorts, not filters
  };
  // Compare two contacts for one sort control. 0 if the control isn't a sort.
  const cmp = (a: Contact, b: Contact, ctrl: { field: string; action: string; min?: string; max?: string; values?: string[]; text?: string }) => {
    if (!ctrl.field || (ctrl.action !== "asc" && ctrl.action !== "desc")) return 0;
    const t = fieldType(ctrl.field);
    let av = valueOf(a, ctrl.field), bv = valueOf(b, ctrl.field);
    let r = 0;
    if (t === "number") { r = (Number(av) || 0) - (Number(bv) || 0); }
    else if (t === "date") { r = String(av ?? "").localeCompare(String(bv ?? "")); }
    else { r = String(av ?? "").localeCompare(String(bv ?? ""), undefined, { sensitivity: "base" }); }
    return ctrl.action === "desc" ? -r : r;
  };

  // "client" (in the Clients page), "tracking" (in any deal), or "none".
  const relOf = (c: Contact): "client" | "tracking" | "none" => {
    if (rel && c.id && rel.clientContactIds.has(c.id)) return "client";
    if (rel && c.id && rel.trackingContactIds.has(c.id)) return "tracking";
    return "none";
  };

  // Relationship filter. "tracking" / "notracking" look only at sales
  // trackings (a client can also be in one); "none" means neither.
  const inTracking = (c: Contact) => !!(rel && c.id && rel.trackingContactIds.has(c.id));
  const relMatches = (c: Contact, f: string) => {
    if (f === "tracking") return inTracking(c);
    if (f === "notracking") return !inTracking(c);
    return relOf(c) === f;
  };

  const shown = contacts.filter((c) => {
    // Sales people only see the contacts they have been given access to.
    if (!lead && me && !(assignees[c.id!] ?? []).includes(me.id)) return false;
    // Compound custom filters.
    if (!passesFilter(c, ctrl1)) return false;
    if (!passesFilter(c, ctrl2)) return false;
    if (fRel && !relMatches(c, fRel)) return false;
    const n = norm(q.trim());
    if (!n) return true;
    const companyNames = c.companyIds.map(companyName).join(" ");
    return [fullName(c), c.position, c.email, companyNames].some((v) => norm(v ?? "").includes(n));
  }).sort((a, b) => {
    // Compound sort: control 1 is primary, control 2 breaks ties.
    const r1 = cmp(a, b, ctrl1);
    if (r1 !== 0) return r1;
    return cmp(a, b, ctrl2);
  });

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
        <span className="ct-kpi"><b>{shown.length}</b>{shown.length === 1 ? "contact" : "contacts"}</span>
        <div className="ct-search">
          <span className="ct-search-ico">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, position or company…" />
          {q && <button onClick={() => setQ("")}>×</button>}
        </div>
        <div className="ct-cfilter">
          <Select value={fRel} onChange={setFRel} placeholder="Any relationship"
            options={[
              { value: "", label: "Any relationship" },
              { value: "client", label: "Clients" },
              { value: "tracking", label: "In sales tracking" },
              { value: "notracking", label: "No sales tracking" },
              { value: "none", label: "Not yet in play" },
            ]} />
        </div>
        <div className="ct-cfilters">
          {[{ c: ctrl1, set: setCtrl1 }, { c: ctrl2, set: setCtrl2 }].map((ctl, i) => (
            <div className="ct-cfilter" key={i}>
              <Select value={ctl.c.field}
                onChange={(field) => { const acts = actionsFor(field); ctl.set({ field, action: acts[0]?.value ?? "" }); }}
                options={filterFieldOptions} placeholder={`Filter ${i + 1}`} />
              {ctl.c.field && (
                <Select value={ctl.c.action}
                  onChange={(action) => ctl.set({ ...ctl.c, action })}
                  options={actionsFor(ctl.c.field)} placeholder="How" />
              )}
              {ctl.c.action === "in" && (
                <div className="ct-fvals">
                  <SalesMultiFilter values={ctl.c.values ?? []} onChange={(v) => ctl.set({ ...ctl.c, values: v })}
                    options={choicesFor(ctl.c.field)} placeholder="Choose…" searchFrom={7} noun={ctl.c.field === "companies" ? "companies" : ctl.c.field === "imported_by" ? "people" : "options"} />
                </div>
              )}
              {ctl.c.action === "contains" && (
                <input className="ct-ftext" value={ctl.c.text ?? ""} onChange={(e) => ctl.set({ ...ctl.c, text: e.target.value })} placeholder="Text…" />
              )}
              {ctl.c.action === "custom" && (
                <div className="ct-fdates">
                  <DatePicker value={ctl.c.min ?? ""} onChange={(d) => ctl.set({ ...ctl.c, min: d })} placeholder="From" />
                  <span className="ct-range-sep">–</span>
                  <DatePicker value={ctl.c.max ?? ""} onChange={(d) => ctl.set({ ...ctl.c, max: d })} placeholder="To" />
                </div>
              )}
              {ctl.c.action === "range" && (
                <div className="ct-range">
                  <input type="number" placeholder="Min" value={ctl.c.min ?? ""} onFocus={(e) => e.target.select()}
                    onChange={(e) => ctl.set({ ...ctl.c, min: e.target.value })} />
                  <span className="ct-range-sep">–</span>
                  <input type="number" placeholder="Max" value={ctl.c.max ?? ""} onFocus={(e) => e.target.select()}
                    onChange={(e) => ctl.set({ ...ctl.c, max: e.target.value })} />
                </div>
              )}
            </div>
          ))}
        </div>
        <ActionsMenu items={[
          { key: "new", group: "Create", label: "New contact", hint: "Add one person by hand", icon: AM_ICON.plus, primary: true, tone: "green", shortcut: "N", onSelect: () => setEditing(empty()) },
          { key: "import", group: "Data", label: "Import", hint: "From Excel or CSV, with their companies", icon: AM_ICON.import, tone: "blue", shortcut: "I", onSelect: () => setImporting(true) },
          { key: "export", group: "Data", label: "Export", hint: "Pick contacts by company, deal or phase", icon: AM_ICON.export, tone: "violet", shortcut: "E", onSelect: () => setExporting(true) },
          { key: "fields", group: "Setup", label: "Fields & columns", hint: "Custom fields and what the list shows", icon: AM_ICON.fields, tone: "amber", shortcut: "F", onSelect: () => setShowFieldSettings(true) },
        ]} />
      </header>

      {shown.length === 0 ? (
        <p className="cl-hint">{contacts.length === 0 ? "No contacts yet. Add your first one." : "No contacts match your search."}</p>
      ) : (
        <div className="ct-scroll">
          <div className="ct-lrow ct-lhead" style={{ gridTemplateColumns: `1.9fr ${activeColumns.map(() => "1.4fr").join(" ")}` }}>
            <span>Name</span>
            {activeColumns.map((k) => <span key={k}>{columnLabel(k)}</span>)}
          </div>
          <div className="ct-list">
            {shown.map((c) => (
              <button key={c.id} className="ct-lrow" onClick={() => setEditing(structuredClone(c))}
                style={{ gridTemplateColumns: `1.9fr ${activeColumns.map(() => "1.4fr").join(" ")}` }}>
                <span className="ct-lcell ct-lid">
                  <span className="ct-avatar">{fullName(c).slice(0, 1).toUpperCase()}</span>
                  <span className="ct-lname">{fullName(c)}{c.is_billing && <i className="ct-billing" title="Billing contact">€</i>}</span>
                  {(() => { const r = relOf(c); return r === "none" ? null : (
                    <span className={`ct-rel ct-rel-${r}`}>{r === "client" ? "Client" : "In tracking"}</span>
                  ); })()}
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
          assigned={assignees[editing.id!] ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
          onDeleted={async () => { setEditing(null); await reload(); }}
        />
      )}

      {exporting && (
        <ContactExport
          contacts={contacts.filter((c) => lead || !me || (assignees[c.id!] ?? []).includes(me.id))}
          companies={companies}
          contactFields={fields}
          shownIds={shown.map((c) => c.id as string)}
          onClose={() => setExporting(false)}
        />
      )}

      {importing && (
        <ContactImport
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
          onChanged={async () => { setFields(await listContactFields().catch(() => [])); }}
        />
      )}
    </div>
  );
}

function ContactEditor({ contact, companies, employees, fields, canAssign, assigned, onClose, onSaved, onDeleted }: {
  contact: Contact; companies: Company[]; employees: Employee[]; fields: ContactField[]; canAssign: boolean; assigned: string[];
  onClose: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const [c, setC] = useState<Contact>(contact);
  const [who, setWho] = useState<string[]>(assigned);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Contact>) => setC((x) => ({ ...x, ...patch }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const companyName = (id: string) => companies.find((x) => x.id === id)?.name ?? "—";
  const available = companies.filter((co) => !c.companyIds.includes(co.id!));
  const addCompany = (id: string) => set({ companyIds: [...c.companyIds, id] });
  const removeCompany = (id: string) => set({ companyIds: c.companyIds.filter((x) => x !== id) });

  const setCustom = (fieldId: string, value: any) =>
    setC((x) => ({ ...x, custom: { ...(x.custom ?? {}), [fieldId]: value } }));
  const customVal = (fieldId: string) => (c.custom ?? {})[fieldId];

  const save = async () => {
    if (!c.first_name.trim()) { setErr("A first name is required."); return; }
    // Enforce required custom fields.
    for (const f of fields) {
      if (!f.required) continue;
      const v = customVal(f.id);
      const empty = v == null || v === "" || (f.type === "boolean" && v === false);
      if (empty) { setErr(`"${f.label}" is required.`); return; }
    }
    setBusy(true); setErr(null);
    const e = await saveContact(c);
    if (!e && c.id) await setContactAssignees(c.id, who).catch(() => {});
    setBusy(false);
    if (e) setErr(e); else onSaved();
  };
  const remove = async () => {
    if (!c.id) return onClose();
    if (!confirm(`Delete "${[c.first_name, c.last_name].filter(Boolean).join(" ")}" permanently?`)) return;
    await deleteContact(c.id);
    onDeleted();
  };

  return (
    <div className="dw-backdrop" onMouseDown={onClose}>
      <div className="dw" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dw-head">
          <div>
            <span className="dw-eyebrow">{c.id ? "Edit contact" : "New contact"}</span>
            <h2 className="dw-title">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "New contact"}</h2>
          </div>
          <button className="dw-x" onClick={onClose}>×</button>
        </div>

        <div className="dw-body">
          <div className="dw-sec">
            <p className="dw-sec-title">Person</p>
            <div className="dw-grid">
              <div className="dw-f"><label>First name *</label>
                <input value={c.first_name} onChange={(e) => set({ first_name: e.target.value })} />
              </div>
              <div className="dw-f"><label>Last name</label>
                <input value={c.last_name ?? ""} onChange={(e) => set({ last_name: e.target.value })} />
              </div>
              <div className="dw-f dw-col2"><label>Position / title</label>
                <input value={c.position ?? ""} onChange={(e) => set({ position: e.target.value })} placeholder="e.g. CFO" />
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
            <div className="dw-toggle">
              <div className="dw-toggle-txt">
                <b>Billing contact</b>
                <span>Mark if invoices should go to this person.</span>
              </div>
              <button type="button" role="switch" aria-checked={c.is_billing}
                className={`dw-switch ${c.is_billing ? "on" : ""}`}
                onClick={() => set({ is_billing: !c.is_billing })}>
                <span className="dw-switch-knob" />
              </button>
            </div>
          </div>

          <div className="dw-sec">
            <p className="dw-sec-title">Companies</p>
            <div className="dw-chips">
              {c.companyIds.map((id) => (
                <span key={id} className="dw-chip">{companyName(id)}<button onClick={() => removeCompany(id)} aria-label="Remove">×</button></span>
              ))}
            </div>
            {c.companyIds.length === 0 && <p className="dw-empty-hint">Not linked to any company (optional).</p>}
            {available.length > 0 && (
              <Select value="" onChange={(v) => v && addCompany(v)} placeholder="+ Link a company"
                options={available.map((co) => ({ value: co.id!, label: co.name }))} />
            )}
          </div>

          {canAssign && (
            <div className="dw-sec">
              <p className="dw-sec-title">Who can see this contact</p>
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
            <textarea className="dw-area" value={c.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="Anything worth remembering…" />
          </div>

          {err && <p className="dw-err">{err}</p>}
        </div>

        <div className="dw-foot">
          {c.id && <button className="dw-del" onClick={remove}>Delete</button>}
          <div className="dw-foot-right">
            <button className="dw-cancel" onClick={onClose}>Cancel</button>
            <button className="dw-save" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save contact"}</button>
          </div>
        </div>
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refresh = async () => { await onChanged(); setItems(await listContactFields().catch(() => [])); };

  const add = async () => {
    if (!label.trim()) return;
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
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. LinkedIn, Birthday, VIP" />
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