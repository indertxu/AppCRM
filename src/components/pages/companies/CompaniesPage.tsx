/* eslint-disable @typescript-eslint/no-explicit-any */
import { isPartnerField, usePartnerNames } from "../sales/extras/FieldInput";
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSecuritySection } from "../settings/PageAccessModal";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import Select from "../../framework/Select";
import DatePicker from "../../framework/DatePicker";
import {
  listCompanies, saveCompany, deleteCompany, companyContactCounts, listContacts, linkContactToCompany, unlinkContactFromCompany, renameCrmOption,
  myProfile, isSalesLead, listEmployees, loadCompanyAssignees, setCompanyAssignees,
  listCompanyFields, addCompanyField, updateCompanyField, deleteCompanyField,
  listContactFields, saveContact,
  loadRelationshipSets, type RelationshipSets,
  loadPrefs, savePref, setCompanyParent, syncCompanyBilling,
  companyStatus, type RelStatus, REL_SYSTEM, relLabel, relationshipOptions, sectorOptions, sourceOptions, guessSector, DEFAULT_SECTORS,
  listCrmOptions, addCrmOption, removeCrmOption, crmOptionUses, type CrmOption,
  partnerCompanies, partnerList, setPartnerType,
  loadHistory, type HistoryEntry, descendantsOf, groupRootOf,
  type Company, type Contact, type Employee, type CompanyField, type ContactField, type Billing,
  renameCustomValue, customList,
  listCompanyDeals, type DealRef,
  setFixedRequired, useRequiredFields,
  companiesList, companiesIds, companiesCount, companiesRows, companiesFacets, companiesLight, companyPeople, searchContacts,
  type CompanyFacets, type ServerView, insertMany, deleteMany, updateMany, friendlyDbError,
} from "./companiesApi";
import { supabase } from "../../api/supabase";
import { logoCandidates } from "../clients/clientsTypes";
import { searchPlaces, lookupPostal, postalLooksComplete, provinceFromPostal, countryName, matchCountry, normalizeLinkedIn, isLinkedIn, linkedInHandle, type AddressHit,
  fixedFieldsOf, isFixedRequired, missingFixed, type ReqScope, languageOptions, countryList, countryLabel } from "../contacts/contactProfile";
import "../clients/ClientsPage.css";
import "../sales/extras/TrackingFields.css";
import CompanyImport from "./CompanyImport";
import { PageLoader } from "../../framework/AppLayout";
import ContactExport from "../contacts/ContactExport";
import ActionsMenu, { AM_ICON } from "../../framework/ActionsMenu";
import "./CompaniesPage.css";

const empty = (): Company => ({
  name: "", legal_name: "", vat_number: "", reg_number: "", website: "", linkedin: "", phone: "", email: "", notes: "",
  street: "", addr_number: "", addr_details: "", postal_code: "", city: "", province: "", country: "",
});

/** Settings gear, for the "… settings" entry of the actions menu. */
export const GEAR = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;

// Strip accents/diacritics so "brujula" matches "brújula".
const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** Rows asked from the database at a time (server mode). */
const CO_BLOCK = 100;
/** What the database sends with each company row (51_companies_server.sql). */
const coSrv = (c: Company) => c as Company & { __types?: string[]; __status?: string[]; __pipes?: string[]; __parentName?: string | null; __kids?: number; __count?: number; __assignees?: string[] };

export default function CompaniesPage() {
  const navigate = useNavigate();
  const [companies, setCompanies] = useState<Company[]>([]);
  /** False until the first load finishes — shows the shared loader instead of "No companies yet". */
  const [loaded, setLoaded] = useState(false);
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
  const [exporting, setExporting] = useState(false);
  const [rel, setRel] = useState<RelationshipSets | null>(null);
  // filters + sort (remembered on this browser), and the views you saved
  const [view, setView] = useStoredView("np-companies-view", emptyView([{ key: "name", dir: "asc" }]));
  const [savedViews, setSavedViews] = useSavedViews("companyViews");
  const [columns, setColumns] = useState<string[]>(["vat_number", "address", "contacts"]);
  const [compact, setCompact] = useState(false);
  const [options, setOptions] = useState<CrmOption[]>([]);
  const reloadOptions = async () => setOptions(await listCrmOptions().catch(() => []));

  // ---- Server mode (51_companies_server.sql): the database filters, sorts, counts and pages the list ----
  /** null until known; true = only the rows on screen come down; false = the old way (everything here). */
  const [server, setServer] = useState<boolean | null>(null);
  const [srvRows, setSrvRows] = useState<Company[]>([]);
  const [srvTotal, setSrvTotal] = useState(0);
  const [srvAll, setSrvAll] = useState<number | null>(null);
  const [srvErr, setSrvErr] = useState<string | null>(null);
  const [srvTick, setSrvTick] = useState(0);
  const [facets, setFacets] = useState<CompanyFacets | null>(null);
  const [allIds, setAllIds] = useState<string[] | null>(null);
  /** id + name + group of every company (pickers, group tree), read when first needed. */
  const [light, setLight] = useState<Company[] | null>(null);
  const [peopleCache, setPeopleCache] = useState<Map<string, Contact[]>>(new Map());
  const [editPeople, setEditPeople] = useState<Contact[]>([]);
  const srvGen = useRef(0);
  const srvLoading = useRef(false);
  const srvKeep = useRef(0);
  const srvRefresh = () => {
    srvKeep.current = srvRows.length;
    setSrvTick((x) => x + 1);
    setPeopleCache(new Map());
    companiesCount(emptyView(), "").then((n) => { if (n != null) setSrvAll(n); }).catch(() => {});
    companiesFacets().then((f) => { if (f) setFacets(f); }).catch(() => {});
    if (light) companiesLight(true).then(setLight).catch(() => {});
  };

  /** After a save in the panel: just that row is read again and put back where it is (the list keeps its place). */
  const refreshRow = (saved: Company, isNew: boolean) => {
    if (!saved.id) return;
    if (server) {
      if (isNew) { srvRefresh(); return; }
      companiesRows([saved.id]).then((r) => {
        const row = r[0]; if (!row) return;
        setSrvRows((rows) => rows.map((x) => (x.id === row.id ? row : x)));
        setPeopleCache((m) => { const n = new Map(m); n.delete(row.id!); return n; });
      }).catch(() => {});
      companiesFacets().then((f) => { if (f) setFacets(f); }).catch(() => {});
      if (light) companiesLight(true).then(setLight).catch(() => {});
      return;
    }
    setCompanies((cs) => (cs.some((x) => x.id === saved.id) ? cs.map((x) => (x.id === saved.id ? { ...x, ...saved } : x)) : [...cs, saved]));
    Promise.all([listContacts(), companyContactCounts(), loadCompanyAssignees()])
      .then(([cts, cnt, asg]) => { setContacts(cts); setCounts(cnt); setAssignees(asg); }).catch(() => {});
  };
  const reload = async () => {
    void reloadOptions();
    if (server) { srvRefresh(); return; }
    // companies and their people arrive together: a company opened while its
    // people were still loading used to show none (and "0 contacts")
    const [cos, cts, cnt] = await Promise.all([
      listCompanies().catch(() => [] as Company[]),
      listContacts().catch(() => [] as Contact[]),
      companyContactCounts().catch(() => ({} as Record<string, number>)),
    ]);
    setCompanies(cos);
    setContacts(cts);
    setCounts(cnt);
    // the rest at once (they were read one after the other)
    const [asg, fs, cfs, rs] = await Promise.all([
      loadCompanyAssignees().catch(() => ({} as Record<string, string[]>)),
      listCompanyFields().catch(() => [] as CompanyField[]),
      listContactFields().catch(() => [] as ContactField[]),
      loadRelationshipSets().catch(() => null),
    ]);
    setAssignees(asg); setFields(fs); setContactFields(cfs); setRel(rs);
    setLoaded(true);
  };
  useEffect(() => {
    myProfile().then(setMe).catch(() => {});
    listEmployees().then(setEmployees).catch(() => {});
    loadPrefs().then((p) => { if (Array.isArray(p.companyColumns)) setColumns(p.companyColumns); if (typeof p.companyCompact === "boolean") setCompact(p.companyCompact); }).catch(() => {});
    // The database runs the list when 51_companies_server.sql is in; otherwise everything is read here (old way).
    companiesCount(emptyView(), "").then((n) => {
      if (n == null) { setServer(false); reload(); return; }
      setSrvAll(n); setServer(true);
      void reloadOptions();
      listCompanyFields().then(setFields).catch(() => {});
      listContactFields().then(setContactFields).catch(() => {});
      companiesFacets().then((f) => { if (f) setFacets(f); }).catch(() => {});
    }).catch(() => { setServer(false); reload(); });
  }, []);

  // Opened from a company pill on Contacts: jump straight into that company.
  // panelCompanyId: the panel that was open when you went to one of its contacts — coming back reopens it.
  // backTo: opened from a contact's panel — closing this one takes you back there.
  const location = useLocation();
  const [backTo, setBackTo] = useState(false);
  useEffect(() => {
    const st = (location.state as any) ?? {};
    const id = st.focusCompanyId ?? st.panelCompanyId;
    if (!id) return;
    const keep = !st.focusCompanyId;   // panelCompanyId stays on this history entry, for the next Back
    setBackTo(!!st.backTo);
    if (server) {
      companiesRows([id]).then((r) => { if (r[0]) setEditing(structuredClone(r[0])); }).catch(() => {});
      if (!keep) navigate(location.pathname, { replace: true, state: null });
      return;
    }
    if (companies.length === 0) return;
    const c = companies.find((x) => x.id === id);
    if (c) setEditing(structuredClone(c));
    if (!keep) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, companies, server]);
  /** The panel closes: back to the contact it was opened from, else just closed (and not reopened by Back). */
  const closePanel = () => {
    setEditing(null);
    if (backTo) { setBackTo(false); navigate(-1); return; }
    if ((location.state as any)?.panelCompanyId) navigate(location.pathname, { replace: true, state: null });
  };

  const lead = isSalesLead(me);

  // ---- Every field the list can be filtered and sorted by ----
  const emp = (id?: string | null) => employees.find((e) => e.id === id)?.name ?? "";
  const people = () => employees.map((e) => ({ value: e.id, label: e.name }));
  const valuesOf = (get: (c: Company) => unknown, facet?: "city" | "province" | "country") => () =>
    [...new Set(server && facet ? (facets?.[facet] ?? []).map((v) => String(v).trim()).filter(Boolean) : companies.map((c) => String(get(c) ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: facet === "country" ? countryLabel(v) : v }));
  // built once per load (they were rebuilt on every render, and the people of each row were found by scanning every contact)
  const kids = useMemo(() => { const m = new Map<string, number>(); companies.forEach((c) => { if (c.parent_id) m.set(c.parent_id, (m.get(c.parent_id) ?? 0) + 1); }); return m; }, [companies]);
  const coName = useMemo(() => new Map(companies.map((c) => [c.id as string, c.name])), [companies]);
  const peopleOf = useMemo(() => {
    const m = new Map<string, Contact[]>();
    contacts.forEach((ct) => ct.companyIds.forEach((id) => { const l = m.get(id); if (l) l.push(ct); else m.set(id, [ct]); }));
    return m;
  }, [contacts]);
  const ctOf = useMemo(() => { const m = new Map<string, string[]>(); peopleOf.forEach((l, id) => m.set(id, l.filter((ct) => ct.id).map((ct) => ct.id as string))); return m; }, [peopleOf]);
  const addrOf = (c: Company) => [c.street, c.addr_number, c.postal_code, c.city, c.province, c.country].filter(Boolean).join(", ");
  /** Where a company stands: from its row (server mode) or worked out here. */
  const stOf = (c: Company): RelStatus => { const s = coSrv(c).__status; return s ? { client: s.includes("client"), sales: s.includes("sales"), pipelines: coSrv(c).__pipes ?? [] } : companyStatus(c, rel); };
  const cntOf = (c: Company) => coSrv(c).__count ?? counts[c.id as string] ?? 0;
  const kidsOf = (c: Company) => coSrv(c).__kids ?? kids.get(c.id ?? "") ?? 0;
  const parentNameOf = (c: Company) => coSrv(c).__parentName ?? (c.parent_id ? coName.get(c.parent_id) : undefined);
  function asgOf(c: Company): string[] { return coSrv(c).__assignees ?? assignees[c.id ?? ""] ?? []; }
  const statusTags = (c: Company) => { const s = stOf(c); return [...(s.client ? ["client"] : []), ...(s.sales ? ["sales"] : []), ...(!s.client && !s.sales ? ["none"] : [])]; };
  const typeRank = (c: Company) => typeSortKey(typeTags(c));
  const typeTags = (c: Company) => { const t = coSrv(c).__types; if (t) return t; const s = stOf(c); return [...new Set(["crm", ...(c.relationship ?? []), ...(s.client ? ["client"] : []), ...(s.sales ? ["sales"] : [])])]; };
  const allPipes = () => (server ? [...(facets?.pipelines ?? [])] : [...new Set(Object.values(rel?.pipesByCompany ?? {}).flat())]).sort().map((p) => ({ value: p, label: p }));
  const billing = (c: Company) => c.billing ?? {};
  const filterFields: FField<Company>[] = [
    { key: "name", label: "Name", group: "Company", type: "text", get: (c) => c.name },
    { key: "legal_name", label: "Legal name", group: "Company", type: "text", get: (c) => c.legal_name },
    { key: "vat_number", label: "VAT / Tax ID", group: "Company", type: "text", get: (c) => c.vat_number },
    { key: "sector", label: "Sector", group: "Company", type: "select", get: (c) => c.sector, options: () => [...new Set([...sectorOptions(options), ...(server ? facets?.sector ?? [] : companies.map((c) => c.sector ?? "").filter(Boolean))])].map((v) => ({ value: v, label: v })) },
    { key: "source", label: "Source", group: "Company", type: "select", get: (c) => c.source ?? "", options: () => [...new Set([...sourceOptions(options), ...(server ? facets?.source ?? [] : companies.map((c) => c.source ?? "").filter(Boolean))])].map((v) => ({ value: v, label: v })) },
    { key: "relationship", label: "Type (client, partner…)", group: "Company", type: "multi", get: typeTags, sort: typeRank, options: () => relationshipOptions(options).map((o) => ({ value: o.key, label: o.label })) },
    { key: "website", label: "Website", group: "Contact details", type: "text", get: (c) => c.website },
    { key: "linkedin", label: "LinkedIn", group: "Contact details", type: "text", get: (c) => c.linkedin },
    { key: "email", label: "Email", group: "Contact details", type: "text", get: (c) => c.email },
    { key: "phone", label: "Mobile", group: "Contact details", type: "text", get: (c) => phoneText(c.phone, c.phone_ext) },
    { key: "landline", label: "Landline", group: "Contact details", type: "text", get: (c) => phoneText(c.landline, c.landline_ext) },
    { key: "status", label: "Sales status", group: "Sales", type: "multi", get: statusTags, options: () => [{ value: "client", label: "Client" }, { value: "sales", label: "In sales" }, { value: "none", label: "Not yet in play" }] },
    { key: "pipelines", label: "Pipeline", group: "Sales", type: "multi", get: (c) => (coSrv(c).__pipes ?? (c.id ? rel?.pipesByCompany[c.id] ?? [] : [])), options: allPipes },
    { key: "address", label: "Full address", group: "Address", type: "text", get: addrOf },
    { key: "street", label: "Street", group: "Address", type: "text", get: (c) => [c.street, c.addr_number].filter(Boolean).join(" ") },
    { key: "postal_code", label: "Postal code", group: "Address", type: "text", get: (c) => c.postal_code },
    { key: "city", label: "City", group: "Address", type: "select", get: (c) => (c.city ?? "").trim(), options: valuesOf((c) => c.city, "city") },
    { key: "province", label: "Province / state", group: "Address", type: "select", get: (c) => (c.province ?? "").trim(), options: valuesOf((c) => c.province, "province") },
    { key: "country", label: "Country", group: "Address", type: "select", get: (c) => (c.country ?? "").trim(), options: valuesOf((c) => c.country, "country") },
    { key: "addr_complete", label: "Address complete", group: "Address", type: "boolean", get: (c) => !!(c.street && c.postal_code && c.city && c.country) },
    { key: "parent", label: "Parent company", group: "Group", type: "select", get: (c) => c.parent_id ?? "", options: () => server ? [...(facets?.parents ?? [])] : companies.filter((c) => c.id && kids.has(c.id)).map((c) => ({ value: c.id!, label: c.name })).sort((a, b) => a.label.localeCompare(b.label)) },
    { key: "in_group", label: "Part of a group", group: "Group", type: "boolean", get: (c) => !!c.parent_id || kidsOf(c) > 0 },
    { key: "subsidiaries", label: "Number of subsidiaries", group: "Group", type: "number", get: (c) => kidsOf(c) },
    { key: "contacts_count", label: "Number of contacts", group: "People", type: "number", get: (c) => cntOf(c) },
    { key: "contacts", label: "Contacts", group: "People", type: "multi", get: (c) => ctOf.get(c.id ?? "") ?? [], options: () => server ? [...(facets?.contacts ?? [])] : contacts.filter((ct) => ct.id).map((ct) => ({ value: ct.id!, label: [ct.first_name, ct.last_name].filter(Boolean).join(" ") || ct.email || "Unnamed" })) },
    { key: "billing_set", label: "Has billing details", group: "Billing", type: "boolean", get: (c) => !!(billing(c).name || billing(c).email || billing(c).phone) },
    { key: "billing_name", label: "Billing name", group: "Billing", type: "text", get: (c) => billing(c).name },
    { key: "billing_email", label: "Billing email", group: "Billing", type: "text", get: (c) => billing(c).email },
    { key: "visible_to", label: "Visible to", group: "Record", type: "multi", get: (c) => asgOf(c), options: people },
    { key: "created_by", label: "Created by", group: "Record", type: "select", get: (c) => c.created_by ?? "", options: people, sort: (c) => emp(c.created_by) || null },
    { key: "created_at", label: "Created on", group: "Record", type: "date", get: (c) => c.created_at },
    { key: "imported_by", label: "Imported by", group: "Record", type: "select", get: (c) => (c as any).imported_by ?? "", options: people },
    { key: "imported_at", label: "Imported on", group: "Record", type: "date", get: (c) => (c as any).imported_at },
    { key: "notes", label: "Notes", group: "Record", type: "text", get: (c) => c.notes },
    ...fields.map((f): FField<Company> => ({
      key: f.id, label: f.label, group: "Your fields", type: f.type === "multiselect" ? "multi" : f.type,
      get: (c) => (f.type === "multiselect" ? customList((c.custom ?? {})[f.id]) : (c.custom ?? {})[f.id]),
      ...(isChoiceType(f.type) ? { options: () => [...new Set([...f.options, ...(f.type === "multiselect" ? (server ? facets?.custom?.[f.id] ?? [] : companies.flatMap((c) => customList((c.custom ?? {})[f.id]))) : [])])].map((o) => ({ value: o, label: o })) } : {}),
    })),
  ];
  // the header of each column sorts by this field
  const sortKeyOf = (col: string) => (col === "contacts" ? "contacts_count" : col === "group" ? "parent" : col);

  // Sales people only see the companies they have been assigned to.
  const visible = useMemo(() => companies.filter((c) => lead || !me || (assignees[c.id!] ?? []).includes(me.id)), [companies, lead, me, assignees]);
  // the search text of each company, once per load; typing filters a beat later in the background
  const hayOf = useMemo(() => new Map(companies.map((c) => [c, norm([c.name, c.legal_name, c.vat_number, c.street, c.city, c.province, c.country, c.postal_code, c.sector, c.source, c.email, c.website].filter(Boolean).join(" \u0001 "))])), [companies]);
  const dq = useDeferredValue(q);
  const searched = useMemo(() => {
    const n = norm(dq.trim());
    if (!n) return visible;
    return visible.filter((c) => (hayOf.get(c) ?? "").includes(n));
  }, [visible, dq, hayOf]);
  const fieldsRef = useRef(filterFields);
  fieldsRef.current = filterFields;
  const localShown = useMemo(
    () => (server ? [] : applyView(searched, fieldsRef.current, view, (a, b) => a.name.localeCompare(b.name))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, searched, view, counts, rel, fields, contactFields, options, peopleOf, assignees, employees],
  );
  const shown = server ? srvRows : localShown;
  /** How many companies match (server mode: counted by the database). */
  const listLen = server ? srvTotal : shown.length;
  const allLen = server ? srvAll ?? srvTotal : visible.length;

  // ---- Server mode: the view as the database reads it; the first rows, then more as you scroll ----
  const serverView = useMemo<ServerView>(() => {
    const byKey = new Map(fieldsRef.current.map((f) => [f.key, f]));
    return {
      match: view.match,
      conds: view.conds.filter((c) => byKey.has(c.field)).map((c) => ({ ...c, type: byKey.get(c.field)!.type })),
      sort: view.sort.filter((x) => byKey.has(x.key)).map((x) => ({ ...x, type: byKey.get(x.key)!.type })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, fields]);
  const srvQuery = useRef({ view: serverView, q: "" });
  useEffect(() => {
    if (!server) return;
    const gen = ++srvGen.current;
    srvQuery.current = { view: serverView, q: dq };
    setAllIds(null);
    // after a save the list keeps as many rows as it had (it doesn't jump back to the first 100)
    const want = Math.min(500, Math.max(CO_BLOCK, srvKeep.current));
    srvKeep.current = 0;
    const t = setTimeout(() => {
      srvLoading.current = true;
      companiesList(serverView, dq, 0, want).then((r) => {
        if (!r || gen !== srvGen.current) return;
        setSrvRows(r.rows); setSrvTotal(r.total); setSrvErr(null); setLoaded(true);
      }).catch((e) => { if (gen === srvGen.current) { setSrvErr(String((e as any)?.message ?? e)); setLoaded(true); } })
        .finally(() => { if (gen === srvGen.current) srvLoading.current = false; });
    }, gen === 1 ? 0 : 120);
    return () => clearTimeout(t);
  }, [server, serverView, dq, srvTick]);
  const loadMore = () => {
    if (!server || srvLoading.current || srvRows.length >= srvTotal) return;
    const gen = srvGen.current, qy = srvQuery.current, from = srvRows.length;
    srvLoading.current = true;
    companiesList(qy.view, qy.q, from, CO_BLOCK).then((r) => {
      if (!r || gen !== srvGen.current) return;
      setSrvRows((cur) => (cur.length === from ? [...cur, ...r.rows] : cur)); setSrvTotal(r.total);
    }).catch(() => {}).finally(() => { if (gen === srvGen.current) srvLoading.current = false; });
  };
  const loadAllIds = () => {
    const gen = srvGen.current, qy = srvQuery.current;
    return companiesIds(qy.view, qy.q).then((ids) => { if (gen === srvGen.current) setAllIds(ids); return ids; });
  };
  const needLight = () => { if (server && !light) companiesLight().then(setLight).catch(() => {}); };
  // long lists grow as you scroll (a row can open its people, so rows aren't all the same height)
  const [renderN, setRenderN] = useState(120);
  useEffect(() => { setRenderN(120); }, [dq, view]);

  // ---- Multi-select: tag, assign, group, export or delete many companies ----
  const shownIds = useMemo(() => (server && allIds ? allIds : shown.map((c) => c.id as string)), [server, allIds, shown]);
  const bulk = useBulkSelection(shownIds);
  // selecting in server mode: every id of the list once (select all, shift-click), and the names for "Part of a group"
  useEffect(() => { if (server && bulk.active) { if (!allIds) loadAllIds().catch(() => {}); needLight(); } }, [server, bulk.active, allIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const wantAll = useRef(false);
  const toggleAllRows = () => {
    if (server && !allIds && !bulk.allOn) { wantAll.current = true; loadAllIds().catch(() => { wantAll.current = false; }); return; }
    bulk.toggleAll();
  };
  useEffect(() => { if (wantAll.current && allIds) { wantAll.current = false; bulk.toggleAll(); } }, [allIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const [exportIds, setExportIds] = useState<string[] | null>(null);
  const pickedList = useMemo(() => (bulk.sel.size ? (server ? srvRows : companies).filter((c) => bulk.sel.has(c.id as string)) : []), [bulk.sel, companies, server, srvRows]);
  const pickedCos = () => pickedList;
  /** The full rows of the selection (server mode: read from the database). */
  const pickCos = async (): Promise<Company[]> => (server ? companiesRows(bulk.ids) : pickedList);
  const allCos = server ? light ?? [] : companies;
  const BI = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
  /** Changes only the fields asked for (nothing else on the company is rewritten), a few at a time;
   *  the same change on every company goes as one request per 80. */
  const saveMany = async (patch: (c: Company) => Partial<Company> | null, label: string) => {
    const todo = (await pickCos()).map((c) => ({ c, p: patch(c) })).filter((x): x is { c: Company; p: Partial<Company> } => !!x.p && !!x.c.id);
    const same = todo.length > 0 && todo.every((x) => JSON.stringify(x.p) === JSON.stringify(todo[0].p));
    const r = same
      ? await updateMany("companies", todo.map((x) => x.c.id as string), todo[0].p as Record<string, unknown>).then((e) => ({ ok: e ? 0 : todo.length, error: e }))
      : await inPool(todo, async ({ c, p }) => { const { error } = await supabase.from("companies").update(p).eq("id", c.id as string); return error ? friendlyDbError(error.message) : null; });
    await reload();
    if (r.error) return r.error;
    bulk.clear();
    return { done: `${label} · ${r.ok} ${r.ok === 1 ? "company" : "companies"}` };
  };
  const bulkActions: BulkAction[] = [
    {
      key: "assign", label: "Assign to", icon: BI("M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"),
      options: employees.map((e) => ({ value: e.id, label: e.name, hint: e.role?.replace(/_/g, " ") })),
      disabledReason: lead ? undefined : "Only boss and sales managers can assign companies.",
      run: async (v) => {
        if (!v) return null;
        const rows = (await pickCos()).filter((c) => c.id && !asgOf(c).includes(v)).map((c) => ({ company_id: c.id, profile_id: v }));
        const err = await insertMany("company_assignees", rows);
        await reload();
        if (err) return err;
        bulk.clear();
        return { done: `${employees.find((e) => e.id === v)?.name ?? "They"} now see ${rows.length} more` };
      },
    },
    {
      key: "type", label: "Add a type", icon: BI("M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01"),
      options: relationshipOptions(options).map((o) => ({ value: o.key, label: o.label })),
      run: (v) => (v ? saveMany((c) => ((c.relationship ?? []).includes(v) ? null : { relationship: [...(c.relationship ?? []), v] }), `Tagged ${relLabel(v)}`) : null),
    },
    {
      key: "untype", label: "Remove a type", more: true, icon: BI("M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM15 9l-6 6"),
      options: relationshipOptions(options).filter((o) => pickedCos().some((c) => (c.relationship ?? []).includes(o.key))).map((o) => ({ value: o.key, label: o.label })),
      run: (v) => (v ? saveMany((c) => ((c.relationship ?? []).includes(v) ? { relationship: (c.relationship ?? []).filter((x) => x !== v) } : null), `Untagged ${relLabel(v)}`) : null),
    },
    {
      key: "sector", label: "Set sector", more: true, icon: BI("M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1"),
      options: [...new Set([...sectorOptions(options), ...(server ? facets?.sector ?? [] : companies.map((c) => c.sector ?? "").filter(Boolean))])].sort().map((v) => ({ value: v, label: v })),
      run: (v) => (v ? saveMany((c) => (c.sector === v ? null : { sector: v }), `Sector ${v}`) : null),
    },
    {
      key: "source", label: "Set source", more: true, icon: BI("M12 22s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 15.8 12 22 12 22zM12 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"),
      options: [...new Set([...sourceOptions(options), ...(server ? facets?.source ?? [] : companies.map((c) => c.source ?? "").filter(Boolean))])].map((v) => ({ value: v, label: v })),
      run: (v) => (v ? saveMany((c) => (c.source === v ? null : { source: v }), `Source ${v}`) : null),
    },
    ...(fields.some((f) => f.type === "multiselect") ? [{
      key: "tagf", label: "Add a choice", more: true, icon: BI("M3 7l2 2 4-4M3 15l2 2 4-4M13 7h8M13 15h8"),
      options: fields.filter((f) => f.type === "multiselect").flatMap((f) => f.options.map((o) => ({ value: `${f.id}\u0001${o}`, label: o, group: f.label }))),
      run: (v?: string) => {
        if (!v) return null;
        const [fid, opt] = v.split("\u0001");
        return saveMany((c) => { const cur = customList((c.custom ?? {})[fid]); return cur.includes(opt) ? null : { custom: { ...(c.custom ?? {}), [fid]: [...cur, opt] } }; }, `Added ${opt}`);
      },
    }, {
      key: "untagf", label: "Remove a choice", more: true, icon: BI("M3 7l2 2 4-4M3 15l2 2 4-4M13 11h8"),
      options: fields.filter((f) => f.type === "multiselect").flatMap((f) => [...new Set(pickedCos().flatMap((c) => customList((c.custom ?? {})[f.id])))].map((o) => ({ value: `${f.id}\u0001${o}`, label: o, group: f.label }))),
      run: (v?: string) => {
        if (!v) return null;
        const [fid, opt] = v.split("\u0001");
        return saveMany((c) => { const cur = customList((c.custom ?? {})[fid]); return cur.includes(opt) ? { custom: { ...(c.custom ?? {}), [fid]: cur.filter((x) => x !== opt) } } : null; }, `Removed ${opt}`);
      },
    }] as BulkAction[] : []),
    {
      key: "group", label: "Part of a group", more: true, icon: BI("M4 3h8v6H4zM12 15h8v6h-8zM8 9v4a2 2 0 0 0 2 2h2"),
      options: [{ value: "__none", label: "No group", hint: "Make them standalone" }, ...allCos.filter((c) => !bulk.has(c.id as string)).map((c) => ({ value: c.id as string, label: c.name }))],
      run: async (v) => {
        if (!v) return null;
        const n = bulk.ids.length;
        const e = await updateMany("companies", bulk.ids, { parent_id: v === "__none" ? null : v });
        await reload();
        if (e) return e;
        bulk.clear();
        return { done: v === "__none" ? `${n} made standalone` : `${n} now part of ${allCos.find((c) => c.id === v)?.name ?? "the group"}` };
      },
    },
    {
      key: "export", label: "Export these", more: true, icon: BI("M12 3v12M7 10l5 5 5-5M5 21h14"),
      run: () => { setExportIds(bulk.ids); setExporting(true); return null; },
    },
    {
      key: "delete", label: "Delete", danger: true, more: true, icon: BI("M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"),
      disabledReason: lead ? undefined : "Only boss and sales managers can delete companies.",
      run: async () => {
        const n = bulk.ids.length;
        const e = await deleteMany("companies", bulk.ids);
        await reload();
        if (e) return e;
        bulk.clear();
        return { done: `${n} deleted` };
      },
    },
  ];
  // Merge: exactly two picked → one company (79_merge_records.sql)
  const [merging, setMerging] = useState<[Company, Company] | null>(null);
  bulkActions.unshift({
    key: "merge", label: "Merge", icon: BI("M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6M18 3v6a6 6 0 0 1-6 6M12 15v6"),
    disabledReason: !lead ? "Only boss and sales managers can merge companies." : bulk.ids.length !== 2 ? "Pick exactly two companies to merge them." : undefined,
    run: async () => {
      const rows = await pickCos();
      if (rows.length !== 2) return "Pick exactly two companies to merge them.";
      setMerging([structuredClone(rows[0]), structuredClone(rows[1])]);
      return null;
    },
  });
  const mergeFields: MergeField[] = [
    { key: "name", label: "Common name" }, { key: "legal_name", label: "Legal name" }, { key: "vat_number", label: "VAT / Tax ID" },
    { key: "reg_number", label: "Registration nº" }, { key: "website", label: "Website" }, { key: "linkedin", label: "LinkedIn" },
    { key: "email", label: "Email" }, { key: "phone", label: "Mobile" }, { key: "landline", label: "Telephone" },
    { key: "street", label: "Street" }, { key: "addr_number", label: "Number" }, { key: "addr_details", label: "Address details" },
    { key: "postal_code", label: "Postal code" }, { key: "city", label: "City" }, { key: "province", label: "Province" },
    { key: "country", label: "Country", text: (v) => countryLabel(v) }, { key: "sector", label: "Sector" }, { key: "source", label: "Source" },
    { key: "billing", label: "Billing" }, { key: "notes", label: "Notes" },
    ...fields.map((f) => ({ key: `custom.${f.id}`, label: f.label })),
  ];
  const onSort = (key: string, add: boolean) => setView({ ...view, sort: nextSort(view.sort, key, add) });
  const [filtersOpenTick, setFiltersOpenTick] = useState(0);
  const fieldById = (id: string) => fields.find((f) => f.id === id);

  const contactsOf = (companyId: string) => (server ? peopleCache.get(companyId) ?? [] : peopleOf.get(companyId) ?? []);
  // server mode: a company's people are read when you open its row
  useEffect(() => {
    if (!server || !open || peopleCache.has(open)) return;
    const id = open;
    companyPeople(id).then((list) => setPeopleCache((m) => new Map(m).set(id, list))).catch(() => setPeopleCache((m) => new Map(m).set(id, [])));
  }, [server, open, peopleCache]);
  // server mode: the panel gets the company's people and the company names (pickers, group tree)
  useEffect(() => {
    if (!server || !editing) return;
    needLight();
    setEditPeople([]);
    if (editing.id) companyPeople(editing.id).then(setEditPeople).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, editing?.id]);
  // Export (server mode): the export needs every company and contact, read only when you export
  const [exportData, setExportData] = useState<{ companies: Company[]; contacts: Contact[]; shown: string[] } | null>(null);
  useEffect(() => {
    if (!exporting || !server || exportData) return;
    let off = false;
    Promise.all([
      listCompanies(), listContacts(), lead ? Promise.resolve(null) : loadCompanyAssignees(),
      exportIds ? Promise.resolve(exportIds) : allIds ? Promise.resolve(allIds) : loadAllIds(),
    ]).then(([cos, cts, asg, ids]) => {
      if (off) return;
      const mine = asg && me ? cos.filter((c) => (asg[c.id!] ?? []).includes(me.id)) : cos;
      setExportData({ companies: mine, contacts: cts, shown: ids });
    }).catch(() => { if (!off) { setExporting(false); setExportIds(null); } });
    return () => { off = true; };
  }, [exporting, server]); // eslint-disable-line react-hooks/exhaustive-deps

  const addrLine = (c: Company) =>
    [c.street, c.addr_number, c.city, c.country].filter(Boolean).join(", ") || "—";

  // Configurable overview columns (Name is always first).
  const availableColumns = [
    { key: "relationship", label: "Types" },
    { key: "vat_number", label: "VAT / Tax ID" },
    { key: "address", label: "Address" },
    { key: "city", label: "City" },
    { key: "country", label: "Country" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Mobile" },
    { key: "landline", label: "Landline" },
    { key: "sector", label: "Sector" },
    { key: "source", label: "Source" },
    { key: "group", label: "Group" },
    { key: "created_by", label: "Created by" },
    { key: "contacts", label: "Contacts" },
    ...fields.map((f) => ({ key: f.id, label: f.label })),
  ];
  const columnLabel = (key: string) => availableColumns.find((c) => c.key === key)?.label ?? key;
  const activeColumns = columns.filter((k) => availableColumns.some((c) => c.key === k));
  // The contacts counter + dropdown always sits at the far right of the card,
  // in its own narrow column, whatever position it has in the column settings.
  const dataColumns = activeColumns.filter((k) => k !== "contacts");
  const showContacts = activeColumns.includes("contacts");
  // Every column keeps a readable width; when they don't fit, the list scrolls sideways (the name stays put).
  const colMin = (k: string) => (k === "address" ? 220 : k === "email" || k === "relationship" ? 190 : k === "vat_number" || k === "phone" || k === "landline" ? 130 : 150);
  const rowGrid = ["minmax(260px, 2.4fr)", ...dataColumns.map((k) => `minmax(${colMin(k)}px, 1.4fr)`), ...(showContacts ? ["minmax(70px, auto)"] : [])].join(" ");
  const rowMin = 260 + dataColumns.reduce((n, k) => n + colMin(k), 0) + (showContacts ? 70 : 0) + 20 * (dataColumns.length + (showContacts ? 1 : 0)) + 40;
  const setColumnsPersist = (next: string[]) => { setColumns(next); savePref("companyColumns", next).catch(() => {}); };

  const renderCell = (c: Company, key: string) => {
    if (key === "relationship") return <TypeChips tags={typeTags(c).map((tag) => ({ tag }))} pipelines={stOf(c).pipelines} />;
    if (key === "vat_number") return <span className="co-lmono">{c.vat_number || "—"}</span>;
    if (key === "address") return <span className="co-laddr">{addrLine(c)}</span>;
    if (key === "city") return <span className="co-laddr">{c.city || "—"}</span>;
    if (key === "country") return <span className="co-laddr">{c.country ? countryLabel(c.country) : "—"}</span>;
    if (key === "email") return <span className="co-laddr">{c.email || "—"}</span>;
    if (key === "phone") return <span className="co-lmono">{phoneText(c.phone, c.phone_ext) || "—"}</span>;
    if (key === "landline") return <span className="co-lmono">{phoneText(c.landline, c.landline_ext) || "—"}</span>;
    if (key === "sector") return <span className="co-laddr">{c.sector || "—"}</span>;
    if (key === "source") return <span className="co-laddr">{c.source || "—"}</span>;
    if (key === "group") return <span className="co-laddr">{c.parent_id ? `↳ ${parentNameOf(c) ?? "—"}` : kidsOf(c) > 0 ? "Top of a group" : "—"}</span>;
    if (key === "created_by") return <span className="co-laddr">{employees.find((e) => e.id === c.created_by)?.name ?? "—"}</span>;
    if (key === "contacts") return (
      <span className="co-lright">
        <button className={`co-expand ${open === c.id ? "is-on" : ""}`}
          aria-expanded={open === c.id} aria-label="Show contacts"
          onClick={(e) => { e.stopPropagation(); setOpen(open === c.id ? null : c.id!); }}>
          <b className="co-lbadge">{cntOf(c)}</b>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={open === c.id ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} /></svg>
        </button>
      </span>
    );
    // custom field
    const f = fieldById(key);
    const v = (c.custom ?? {})[key];
    if (f?.type === "multiselect") return <CustomChips value={v} />;
    if (!f || v == null || v === "") return <span className="co-laddr">—</span>;
    if (f.type === "boolean") return <span className="co-laddr">{v ? "Yes" : "No"}</span>;
    return <span className="co-laddr">{String(v)}</span>;
  };

  // The rows only change with the list itself — opening, editing or closing a company panel does not
  // re-render (or re-measure) thousands of rows underneath it.
  const dataKey = dataColumns.join("|");
  const listRows = useMemo(() => shown.slice(0, server ? shown.length : renderN).map((c) => {
              const people = contactsOf(c.id!);
              const isOpen = open === c.id;
              return (
                <div className="co-item" key={c.id}>
                  <div className={`co-lrow ${bulk.has(c.id as string) ? "is-sel" : ""} ${bulk.active ? "is-selecting" : ""}`} role="button" tabIndex={0}
                    style={{ gridTemplateColumns: rowGrid }}
                    onClick={(e) => { if (bulk.active || e.shiftKey || e.metaKey || e.ctrlKey) bulk.toggle(c.id as string, e.shiftKey); else setEditing(structuredClone(c)); }}
                    onKeyDown={(e) => { if (e.key === "Enter") setEditing(structuredClone(c)); }}>
                    <span className="co-lcell co-lid">
                      <span className="co-av-wrap">
                        <CompanyLogo name={c.name || "?"} website={c.website} className="co-avatar" />
                        <BulkCheck on={bulk.has(c.id as string)} onToggle={(e) => bulk.toggle(c.id as string, e.shiftKey)} label={`Select ${c.name}`} />
                      </span>
                      <span className="co-lid-text">
                        <span className="co-lname-row">
                          <span className="co-lname">{c.name}</span>
                          {!dataColumns.includes("relationship") && <StatusPills status={stOf(c)} tags={c.relationship} />}
                        </span>
                        {(c.legal_name || c.parent_id) && (
                          <span className="co-lsub">{[c.legal_name, c.parent_id ? `part of ${parentNameOf(c) ?? "a group"}` : ""].filter(Boolean).join(" · ")}</span>
                        )}
                      </span>
                    </span>
                    {dataColumns.map((k) => <span key={k} className="co-lcell">{renderCell(c, k)}</span>)}
                    {showContacts && <span className="co-lcell co-lcontacts">{renderCell(c, "contacts")}</span>}
                  </div>

                  {isOpen && (
                    <div className="co-people">
                      {server && !peopleCache.has(c.id!) ? (
                        <p className="co-people-empty">Loading their people…</p>
                      ) : people.length === 0 ? (
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
            }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, renderN, open, bulk.sel, rowGrid, dataKey, showContacts, rel, counts, coName, kids, peopleOf, employees, fields, server, peopleCache]);

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
        <span className="co-kpi"><b>{listLen.toLocaleString("en-GB")}</b>{listLen !== allLen ? `of ${allLen.toLocaleString("en-GB")} ` : ""}{allLen === 1 ? "company" : "companies"}</span>
        <div className="co-search">
          <span className="co-search-ico">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, VAT, address…" />
          {q && <button onClick={() => setQ("")}>×</button>}
        </div>
        <FilterBar fields={filterFields} view={view} onView={setView} total={allLen} shown={listLen} noun={["company", "companies"]}
          saved={savedViews} onSaved={setSavedViews} openSignal={filtersOpenTick} />
        <ActionsMenu items={[
          { key: "new", group: "Create", label: "New company", hint: "Add one company by hand", icon: AM_ICON.plus, primary: true, tone: "green", shortcut: "N", onSelect: () => setEditing(empty()) },
          { key: "fields", group: "Setup", label: "Columns", hint: "What the list shows, and in which order", icon: AM_ICON.fields, tone: "amber", shortcut: "F", onSelect: () => setShowFieldSettings(true) },
        ]} />
      </header>

      <FilterChips fields={filterFields} view={view} onView={setView} onEdit={() => setFiltersOpenTick((x) => x + 1)} shown={listLen} total={allLen} noun={["company", "companies"]} />

      {server && srvErr && <p className="cl-hint is-error">{srvErr} <button type="button" className="ct-retry" onClick={() => setSrvTick((x) => x + 1)}>Try again</button></p>}
      {!loaded || server === null ? <PageLoader label="Loading companies…" fill={false} /> : listLen === 0 ? (
        <p className="cl-hint">{(server ? srvAll === 0 : companies.length === 0) ? "No companies yet. Create your first one." : "No companies match your search and filters."}</p>
      ) : (
        <div className={`co-scroll is-xscroll ${compact ? "is-compact" : ""}`} style={{ ["--row-min" as string]: `${rowMin}px` } as CSSProperties}
          onScroll={(e) => {
            const el = e.currentTarget; el.classList.toggle("is-scrolled-x", el.scrollLeft > 4); el.classList.toggle("is-scrolled-y", el.scrollTop > 2);
            if (server) { if (el.scrollTop + el.clientHeight > el.scrollHeight - 1600) loadMore(); }
            else if (renderN < shown.length && el.scrollTop + el.clientHeight > el.scrollHeight - 1600) setRenderN((n) => Math.min(shown.length, n + 160));
          }}>
          {/* the sticky header sits on an opaque band of the page colour: rows never show above or around it */}
          <div className="co-lhead-wrap">
          <div className="co-lrow co-lhead" style={{ gridTemplateColumns: rowGrid }}>
            <span className="co-lid-head"><BulkCheck on={bulk.allOn} partial={bulk.someOn} onToggle={toggleAllRows} label="Select every company shown" /><SortHead label="Company" k="name" sort={view.sort} onSort={onSort} /></span>
            {dataColumns.map((k) => <span key={k} className="co-lhcell"><SortHead label={columnLabel(k)} k={sortKeyOf(k)} sort={view.sort} onSort={onSort} /></span>)}
            {showContacts && <span className="co-lright co-lcontacts"><SortHead label={columnLabel("contacts")} k="contacts_count" sort={view.sort} onSort={onSort} /></span>}
          </div>
          </div>
          <div className="co-list">
            {listRows}
            {server && srvRows.length < srvTotal && (
              <div className="co-more"><button type="button" onClick={loadMore}>Show more · {(srvTotal - srvRows.length).toLocaleString("en-GB")} to go</button></div>
            )}
          </div>
        </div>
      )}

      {merging && (
        <MergeModal kind="company" noun="companies" records={merging} fields={mergeFields} nameOf={(c) => c.name}
          join={(keep, other) => ({ relationship: [...new Set([...(keep.relationship ?? []), ...(other.relationship ?? [])])], parent_id: keep.parent_id ?? (other.parent_id !== keep.id ? other.parent_id : null) ?? null })}
          save={(m) => saveCompany(m)}
          onClose={() => setMerging(null)}
          onDone={() => { setMerging(null); bulk.clear(); void reload(); }} />
      )}

      {editing && (
        <CompanyEditor
          key={editing.id ?? "new"}
          company={editing}
          companies={server ? light ?? [] : companies}
          rel={rel}
          options={options}
          onOptionsChanged={reloadOptions}
          onOpenCompany={(id) => {
            if (server) { companiesRows([id]).then((r) => { if (r[0]) setEditing(structuredClone(r[0])); }).catch(() => {}); return; }
            const x = companies.find((y) => y.id === id); if (x) setEditing(structuredClone(x));
          }}
          employees={employees}
          fields={fields}
          contacts={server ? editPeople : contacts}
          searchContacts={server ? (q: string) => searchContacts(q) : undefined}
          contactFields={contactFields}
          canAssign={lead}
          assigned={asgOf(editing)}
          onClose={closePanel}
          onSaved={(saved, isNew) => refreshRow(saved, isNew)}
          onDeleted={async () => { const back = backTo; closePanel(); if (!back) await reload(); }}
          onOpenContact={(id) => {
            // this panel comes back when you return from the contact (its button, or the browser's Back)
            if (editing.id) navigate(location.pathname, { replace: true, state: { panelCompanyId: editing.id, backTo } });
            navigate("/contacts", { state: { focusContactId: id, backTo: true } });
          }}
        />
      )}

      {exporting && !server && (
        <ContactExport
          root="company"
          companies={companies.filter((c) => lead || !me || (assignees[c.id!] ?? []).includes(me.id))}
          contacts={contacts}
          contactFields={contactFields}
          shownIds={exportIds ?? shownIds}
          onClose={() => { setExporting(false); setExportIds(null); }}
        />
      )}
      {exporting && server && (exportData
        ? <ContactExport
            root="company"
            companies={exportData.companies}
            contacts={exportData.contacts}
            contactFields={contactFields}
            shownIds={exportData.shown}
            onClose={() => { setExporting(false); setExportIds(null); setExportData(null); }}
          />
        : <div className="dw-backdrop"><PageLoader label="Getting the companies ready to export…" fill={false} /></div>)}

      <BulkBar count={bulk.ids.length} noun={["company", "companies"]} actions={bulkActions} onClear={bulk.clear}
        onSelectAll={toggleAllRows} allOn={bulk.allOn} total={listLen} />

      {showFieldSettings && (
        <FieldSettings
          availableColumns={availableColumns}
          columns={activeColumns}
          onColumns={setColumnsPersist}
          compact={compact} onCompact={(v) => { setCompact(v); savePref("companyCompact", v).catch(() => {}); }}
          onClose={() => setShowFieldSettings(false)}
        />
      )}
    </div>
  );
}

// Searchable dropdown to link an existing contact to the company.
function ContactPicker({ contacts, onPick, search }: {
  contacts: Contact[]; onPick: (id: string, ct?: Contact) => void;
  /** Server mode: people are searched in the database as you type (the directory isn't in the page). */
  search?: (q: string) => Promise<Contact[]>;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const name = (ct: Contact) => [ct.first_name, ct.last_name].filter(Boolean).join(" ") || "Unnamed";
  const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const nq = norm(q.trim());
  // A directory can have tens of thousands of people: the search text is built once, and at most
  // PICK_MAX matches are drawn (type to narrow down).
  const hay = useMemo(() => (open ? contacts.map((ct) => norm(`${name(ct)} ${ct.email ?? ""} ${ct.position ?? ""}`)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contacts, open]);
  const PICK_MAX = 80;
  const [found, setFound] = useState<Contact[] | null>(null);
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    if (!searchRef.current || !open) return;
    let off = false;
    const t = setTimeout(() => { searchRef.current?.(q.trim()).then((r) => { if (!off) setFound(r); }).catch(() => { if (!off) setFound([]); }); }, q ? 220 : 0);
    return () => { off = true; clearTimeout(t); };
  }, [!!search, open, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const { results, more } = useMemo(() => {
    if (!open) return { results: [] as Contact[], more: 0 };
    if (search) return { results: (found ?? []).slice(0, PICK_MAX), more: 0 };
    const out: Contact[] = []; let n = 0;
    for (let i = 0; i < contacts.length; i++) {
      if (nq && !hay[i]?.includes(nq)) continue;
      n++; if (out.length < PICK_MAX) out.push(contacts[i]);
    }
    return { results: out, more: n - out.length };
  }, [contacts, hay, nq, open, search, found]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => { if (open) { setQ(""); setActive(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => { setActive(0); }, [q]);

  const pick = (ct: Contact) => { if (ct?.id) { onPick(ct.id, ct); setOpen(false); } };
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
            {results.length === 0 && <p className="co-pick-empty">{search && found === null ? "Searching…" : "No contacts match."}</p>}
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
            {more > 0 && <p className="co-pick-empty">{more.toLocaleString("en-GB")} more · type to narrow down</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// Inline "create a new contact" form used inside CompanyEditor.
// Shows the basics plus any other built-in field the team made required (Settings › Contacts page).
function NewContactInline({ fields, onAdd, onCancel }: {
  fields: ContactField[];
  onAdd: (c: Contact) => void;
  onCancel: () => void;
}) {
  const [c, setC] = useState<Contact>({
    first_name: "", last_name: "", position: "", email: "", phone: "", phone_ext: "", is_billing: false, notes: "", companyIds: [], custom: {},
  });
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  useRequiredFields();
  const set = (patch: Partial<Contact>) => setC((x) => ({ ...x, ...patch }));
  const setCustom = (id: string, v: any) => setC((x) => ({ ...x, custom: { ...(x.custom ?? {}), [id]: v } }));
  const customVal = (id: string) => (c.custom ?? {})[id];
  const isReq = (k: string) => isFixedRequired("contact", k);
  const rq = (k: string) => (isReq(k) ? <span className="dw-req"> *</span> : null);
  // it is created inside this company, so "Company" is always there
  const asSaved = { ...c, companyIds: ["this"] };
  const miss = (k: string) => tried && isReq(k) && missingFixed("contact", asSaved, [k]).length > 0;
  const mc = (k: string) => (miss(k) ? "is-missing" : "");
  const ADDR = ["street", "addr_number", "postal_code", "city", "province", "country"];
  const needAddr = ADDR.some(isReq);
  const [langs] = useState(() => [{ value: "", label: "— Not set" }, ...languageOptions()]);

  const add = () => {
    if (!c.first_name.trim()) { setTried(true); setErr("A first name is required."); return; }
    const missing = missingFixed("contact", asSaved);
    const missCustom = fields.filter((f) => {
      if (!f.required) return false;
      const v = customVal(f.id);
      return v == null || v === "" || (f.type === "boolean" && v === false) || (Array.isArray(v) && v.length === 0);
    }).map((f) => f.label);
    if (missing.length || missCustom.length) { setTried(true); setErr(`Required — please fill in: ${[...missing, ...missCustom].join(", ")}.`); return; }
    onAdd(c);
  };

  return (
    <div className="co-cc-form">
      <div className="dw-grid">
        <div className={`dw-f ${tried && !c.first_name.trim() ? "is-missing" : ""}`}><label>First name *</label>
          <input autoFocus value={c.first_name} onChange={(e) => set({ first_name: e.target.value })} />
        </div>
        <div className={`dw-f ${mc("last_name")}`}><label>Last name{rq("last_name")}</label>
          <input value={c.last_name ?? ""} onChange={(e) => set({ last_name: e.target.value })} />
        </div>
        <div className={`dw-f ${mc("position")}`}><label>Position{rq("position")}</label>
          <input value={c.position ?? ""} onChange={(e) => set({ position: e.target.value })} />
        </div>
        <div className={`dw-f ${mc("email")}`}><label>Email{rq("email")}</label>
          <input value={c.email ?? ""} onChange={(e) => set({ email: e.target.value })} />
        </div>
        <PhoneField label="Mobile" value={c.phone} ext={c.phone_ext} onValue={(v) => set({ phone: v })} onExt={(v) => set({ phone_ext: v })} req={isReq("phone")} missing={miss("phone")} />
        {isReq("landline") && (
          <PhoneField label="Telephone" value={c.landline} ext={c.landline_ext} onValue={(v) => set({ landline: v })} onExt={(v) => set({ landline_ext: v })} req missing={miss("landline")} />
        )}
        {isReq("linkedin") && (
          <div className={`dw-f ${mc("linkedin")}`}><label>LinkedIn{rq("linkedin")}</label>
            <input value={c.linkedin ?? ""} placeholder="linkedin.com/in/…" onChange={(e) => set({ linkedin: e.target.value })}
              onBlur={(e) => set({ linkedin: normalizeLinkedIn(e.target.value) })} />
          </div>
        )}
        {isReq("language") && (
          <div className={`dw-f ${mc("language")}`}><label>Language{rq("language")}</label>
            <Select value={c.language ?? ""} onChange={(v) => set({ language: v })} options={langs} placeholder="Choose a language…" />
          </div>
        )}
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
            {f.type === "multiselect" && <MultiChoice value={customVal(f.id)} options={f.options} onChange={(v) => setCustom(f.id, v)} />}
          </div>
        ))}
      </div>
      {needAddr && (
        <>
          <div className="dw-subh"><DwIcon name="pin" />Address</div>
          <AddressFields value={c} onChange={(p) => set(p as Partial<Contact>)} countryAs="code" req={(k) => rq(k)} missing={(k) => miss(k)}
            renderCountry={() => <CountryPicker value={c.country} as="code" onChange={(v) => set({ country: v })} />} />
        </>
      )}
      {err && <p className="dw-err" style={{ marginTop: 10 }}>{err}</p>}
      <div className="co-cc-form-foot">
        <button type="button" className="dw-cancel" onClick={onCancel}>Cancel</button>
        <button type="button" className="dw-save" onClick={add}>Add contact</button>
      </div>
    </div>
  );
}

function CompanyEditor({ company, companies, employees, fields, contacts, contactFields, canAssign, assigned, rel, options, onOptionsChanged, onClose, onSaved, onDeleted, onOpenContact, onOpenCompany, searchContacts: findContacts }: {
  company: Company; companies: Company[]; employees: Employee[]; fields: CompanyField[]; contacts: Contact[]; contactFields: ContactField[]; canAssign: boolean; assigned: string[];
  /** Server mode: "Link existing contact" searches the database. */
  searchContacts?: (q: string) => Promise<Contact[]>;
  rel: RelationshipSets | null;
  /** Your own sectors and relationship types. */
  options: CrmOption[];
  onOptionsChanged: () => Promise<void> | void;
  /** Saved: the panel stays open on the saved company (the list updates that row). */
  onClose: () => void; onSaved: (saved: Company, isNew: boolean) => void; onDeleted: () => void;
  /** Open a contact on the Contacts page. */
  onOpenContact: (id: string) => void;
  /** Open another company (from the group). */
  onOpenCompany: (id: string) => void;
}) {
  const [c, setC] = useState<Company>(() => ({ relationship: [], billing: {}, ...company }));
  const [initial, setInitial] = useState(() => JSON.stringify({ relationship: [], billing: {}, ...company }));
  /** A moment of "Saved" in the footer after a save (the panel stays open). */
  const [savedAt, setSavedAt] = useState(0);
  useEffect(() => { if (!savedAt) return; const t = window.setTimeout(() => setSavedAt(0), 2600); return () => window.clearTimeout(t); }, [savedAt]);
  // Contacts linked to this company, edited live in the drawer.
  // Lookups over the whole directory built once per load (not on every keystroke): 15k companies / 25k contacts.
  const coIdx = useMemo(() => companyIndex(companies), [companies]);
  const [linked, setLinked] = useState<Contact[]>(() => (company.id ? contacts.filter((ct) => ct.companyIds.includes(company.id!)) : []));
  // The people may still be loading when the panel opens (or reload after a save
  // elsewhere): follow the list until you add or take someone off here yourself.
  const [linkTouched, setLinkTouched] = useState(false);
  useEffect(() => {
    if (linkTouched || !company.id) return;
    setLinked(contacts.filter((ct) => ct.companyIds.includes(company.id!)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts]);
  // New contacts created inline (not yet in the DB); saved when the company saves.
  const [newContacts, setNewContacts] = useState<Contact[]>([]);
  const [addingContact, setAddingContact] = useState(false);
  const [pendingRemoveIds, setPendingRemoveIds] = useState<string[]>([]);
  const [who, setWho] = useState<string[]>(assigned);
  // companies directly below this one in the group (saved with the company)
  const [childInitial, setChildInitial] = useState<string[]>(() => (company.id ? [...(coIdx.kidsOf.get(company.id) ?? [])] : []));
  const [children, setChildren] = useState<string[]>(childInitial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Company>) => setC((x) => ({ ...x, ...patch }));
  // required built-in fields (Settings › Companies page › Required fields): "*" on the label, red once a save was tried
  useRequiredFields();
  const [tried, setTried] = useState(false);
  const rq = (k: string) => (isFixedRequired("company", k) ? <span className="dw-req"> *</span> : null);
  const isReq = (k: string) => isFixedRequired("company", k);
  const miss = (k: string) => tried && isReq(k) && missingFixed("company", c, [k]).length > 0;
  const mc = (k: string) => (miss(k) ? "is-missing" : "");
  const dirty = () => JSON.stringify(c) !== initial || newContacts.length > 0 || pendingRemoveIds.length > 0 || children.join() !== childInitial.join();

  const { closing, close } = useDrawerClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // ---- the company's deals (read-only list; each opens in Deals) ----
  const navigate = useNavigate();
  const [deals, setDeals] = useState<DealRef[] | null>(company.id ? null : []);
  useEffect(() => {
    if (!c.id) return;
    let alive = true;
    listCompanyDeals(c.id).then((d) => { if (alive) setDeals(d); }).catch(() => { if (alive) setDeals([]); });
    return () => { alive = false; };
  }, [c.id]);

  const setCustom = (fieldId: string, value: any) =>
    setC((x) => ({ ...x, custom: { ...(x.custom ?? {}), [fieldId]: value } }));
  const customVal = (fieldId: string) => (c.custom ?? {})[fieldId];

  // ---- sector: picked from the list; for a new company we guess it from the name / website ----
  const sectors = sectorOptions(options);
  /** Where companies come from: the list kept in Settings › Companies page. */
  const sources = sourceOptions(options);
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
  const status: RelStatus = coSrv(company).__status
    ? { client: coSrv(company).__status!.includes("client"), sales: coSrv(company).__status!.includes("sales"), pipelines: coSrv(company).__pipes ?? [] }
    : companyStatus(c, rel);
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

  // a dropdown called "…partner…" lists the partners (companies with a partner type), plus what it already holds
  const partnerNames = usePartnerNames(fields.some(isPartnerField));
  const optsOf = (f: CompanyField): string[] => {
    if (!isPartnerField(f) || !partnerNames) return f.options;
    const held = ([] as unknown[]).concat(customVal(f.id) ?? []).map(String).filter((v) => v && !partnerNames.includes(v));
    return [...partnerNames, ...held];
  };
  // ---- billing ----
  const bill = c.billing ?? {};
  const setBill = (patch: Partial<Billing>) => set({ billing: { ...bill, ...patch } });
  const billFilled = !!(bill.name || bill.email || bill.phone || bill.notes);

  // ---- group ----
  // Everything below works on the maps of coIdx, and the pickers' option lists are kept between renders
  // (they only change when the group does), so typing in the panel never walks the whole directory.
  const nameOf = (id?: string | null) => (id ? coIdx.byId.get(id)?.name : undefined) ?? "—";
  const childKey = children.join(",");
  const parentOptions = useMemo(() => {
    const below = c.id ? coIdx.descendants(c.id) : new Set<string>();
    return [{ value: "", label: "None — top of its group" },
      ...companies.filter((x) => x.id && x.id !== c.id && !below.has(x.id)).map((x) => ({ value: x.id!, label: x.name }))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, coIdx, c.id]);
  const childOptions = useMemo(() => {
    const kids = new Set(children);
    const root = c.id ? coIdx.rootOf(c.id) : null;
    const above = coIdx.ancestors(c.parent_id ?? null); // c.parent_id and every company above it
    return companies.filter((x) => x.id && x.id !== c.id && x.id !== c.parent_id && !kids.has(x.id) && x.id !== root && !above.has(x.id))
      .map((x) => ({ value: x.id!, label: x.parent_id ? `${x.name} (now under ${coIdx.byId.get(x.parent_id)?.name ?? "—"})` : x.name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, coIdx, c.id, c.parent_id, childKey]);
  // the group as it will be once saved (this company's parent and children as edited here) — only the
  // companies that can be in it: the chain above, the tree under its top, the children picked here and theirs
  const groupView = useMemo(() => {
    const ids = new Set<string>();
    coIdx.ancestors(c.parent_id ?? null).forEach((id) => ids.add(id));
    const top = c.parent_id ? coIdx.rootOf(c.parent_id) : null;
    if (top) { ids.add(top); coIdx.descendants(top).forEach((id) => ids.add(id)); }
    if (c.id) coIdx.descendants(c.id).forEach((id) => ids.add(id));
    children.forEach((id) => { ids.add(id); coIdx.descendants(id).forEach((x) => ids.add(x)); });
    if (c.id) ids.delete(c.id);
    const kids = new Set(children);
    return Array.from(ids).map((id) => coIdx.byId.get(id)).filter((x): x is Company => !!x).map((x) => {
      if (kids.has(x.id!)) return { ...x, parent_id: c.id ?? "__self" };
      if (x.parent_id === c.id && c.id && !kids.has(x.id!)) return { ...x, parent_id: null };
      return x;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coIdx, c.id, c.parent_id, childKey]);
  const selfNode: Company = { ...c, id: c.id ?? "__self", name: c.name || "This company" };
  const graphCompanies = [...groupView, selfNode];
  const groupSize = (() => { const root = groupRootOf(selfNode.id!, graphCompanies); return 1 + descendantsOf(root, graphCompanies).size; })();

  const contactName = (ct: Contact) => [ct.first_name, ct.last_name].filter(Boolean).join(" ") || "Unnamed";
  // Existing contacts not yet linked here, for the "add existing" picker.
  const attachable = useMemo(() => {
    const out = new Set<string | undefined>(linked.map((x) => x.id));
    pendingRemoveIds.forEach((id) => out.add(id));
    return contacts.filter((ct) => ct.id && !out.has(ct.id));
  }, [contacts, linked, pendingRemoveIds]);
  const attachExisting = (id: string, picked?: Contact) => {
    const ct = picked ?? contacts.find((x) => x.id === id); if (!ct) return;
    if (linked.some((x) => x.id === id)) return;
    setLinkTouched(true);
    setLinked((xs) => [...xs, ct]);
    setPendingRemoveIds((xs) => xs.filter((x) => x !== id));
  };
  const detachExisting = (id: string) => {
    setLinkTouched(true);
    setLinked((xs) => xs.filter((x) => x.id !== id));
    if (contacts.some((x) => x.id === id)) setPendingRemoveIds((xs) => [...xs, id]);
  };
  const removeNewContact = (i: number) => setNewContacts((xs) => xs.filter((_, j) => j !== i));

  const save = async () => {
    if (!c.name.trim()) { setErr("Give the company a name."); return; }
    const li = normalizeLinkedIn(c.linkedin);
    if (li && !isLinkedIn(li)) { setErr("LinkedIn: paste the company page link (linkedin.com/company/…)."); return; }
    c.linkedin = li || null;
    const missing = missingFixed("company", c);
    const missCustom = fields.filter((f) => {
      if (!f.required) return false;
      const v = customVal(f.id);
      return v == null || v === "" || (f.type === "boolean" && v === false) || (Array.isArray(v) && v.length === 0);
    }).map((f) => f.label);
    if (missing.length || missCustom.length) {
      setTried(true);
      const all = [...missing, ...missCustom];
      setErr(`Required — please fill in: ${all.join(", ")}.`);
      window.setTimeout(() => goTo(missing.length ? "company" : "custom"), 30);
      return;
    }
    setBusy(true); setErr(null);
    const e = await saveCompany(c);
    if (e) { setBusy(false); setErr(e); return; }
    // saveCompany sets c.id on insert; use it to link contacts.
    const companyId = c.id;
    if (companyId) {
      await setCompanyAssignees(companyId, who).catch(() => {});
      // billing changed: the clients' products and projects follow
      const billBefore: Billing = (JSON.parse(initial) as Company).billing ?? {};
      if (company.id) await syncCompanyBilling(companyId, billBefore, c.billing ?? {}).catch(() => {});
      // the group: companies added below this one, and ones taken out
      for (const id of children.filter((x) => !childInitial.includes(x))) {
        const ge = await setCompanyParent(id, companyId);
        if (ge) { setBusy(false); setErr(`${nameOf(id)}: ${ge}`); return; }
      }
      for (const id of childInitial.filter((x) => !children.includes(x))) await setCompanyParent(id, null);
      // Newly created contacts: save each, linked to this company.
      const made: Contact[] = [];
      for (const nc of newContacts) {
        const row = { ...nc, companyIds: [companyId] };
        const err = await saveContact(row);
        if (err) { setBusy(false); setErr(`Contact "${contactName(nc)}": ${err}`); return; }
        made.push(row);
      }
      if (made.length) { setLinked((xs) => [...xs, ...made]); setNewContacts([]); }
      // Existing contacts newly attached here: add just this link (the rest of the contact,
      // and its other companies, are left exactly as they are in the database).
      for (const ct of linked) {
        if (!ct.id) continue;
        if (!ct.companyIds.includes(companyId)) {
          const err = await linkContactToCompany(ct.id, companyId);
          if (err) { setBusy(false); setErr(`Contact "${contactName(ct)}": ${err}`); return; }
        }
      }
      // Contacts detached here: drop just this link.
      for (const id of pendingRemoveIds) {
        const ct = contacts.find((x) => x.id === id);
        if (ct?.id) {
          const err = await unlinkContactFromCompany(ct.id, companyId);
          if (err) { setBusy(false); setErr(`Contact "${contactName(ct)}": ${err}`); return; }
        }
      }
    }
    setBusy(false);
    // the panel stays open where you were: what was saved is the new starting point
    const isNew = !company.id;
    const saved: Company = { ...c };
    setC(saved); setInitial(JSON.stringify(saved)); setTried(false);
    setPendingRemoveIds([]); setChildInitial(children); setLinkTouched(true);
    setSavedAt(Date.now());
    onSaved(saved, isNew);
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
    name: "Name", legal_name: "Legal name", vat_number: "VAT / Tax ID", reg_number: "Registration nº", website: "Website", linkedin: "LinkedIn", email: "Email",
    phone: "Mobile", phone_ext: "Mobile ext.", landline: "Landline", landline_ext: "Landline ext.", notes: "Notes", street: "Street",
    addr_number: "Number", addr_details: "Address details", postal_code: "Postal code", city: "City", province: "Province", country: "Country",
    sector: "Sector", source: "Source", relationship: "Type", billing: "Billing details", parent_id: "Parent company",
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
    { k: "company", label: "Company information", icon: "id" },
    { k: "custom", label: "Additional details", icon: "sliders", count: fields.length ? fields.filter((f) => { const v = customVal(f.id); return v != null && v !== "" && v !== false; }).length : 0 },
    { k: "deals", label: "Deals", icon: "trend", count: deals?.length ?? 0 },
    { k: "people", label: "Contacts", icon: "users", count: peopleCount },
    { k: "notes", label: "Notes", icon: "note" },
    { k: "group", label: "Group", icon: "tree", count: groupSize > 1 ? groupSize : 0 },
    { k: "history", label: "History", icon: "clock" },
    ...(canAssign ? [{ k: "access", label: "Visibility", icon: "lock", count: who.length }] : []),
  ];

  return (
    <div className={`dw-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={() => close()}>
      <div className="dw is-wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={c.name || "New company"}>
        <header className="dw-hero">
          <CompanyLogo name={c.name || "+"} website={c.website} className="dw-hero-av" />
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
              {isLinkedIn(c.linkedin) && <a className="dw-tag" href={c.linkedin!} target="_blank" rel="noreferrer"><DwIcon name="link" />LinkedIn</a>}
              {c.email && <a className="dw-tag" href={`mailto:${c.email}`}><DwIcon name="mail" />{c.email}</a>}
              {c.phone && <a className="dw-tag" href={telHref(c.phone, c.phone_ext)}><DwIcon name="phone" />{phoneText(c.phone, c.phone_ext)}</a>}
              {c.landline && <a className="dw-tag" href={telHref(c.landline, c.landline_ext)}><DwIcon name="phone" />{phoneText(c.landline, c.landline_ext)}</a>}
              {(c.city || c.country) && <span className="dw-tag"><DwIcon name="pin" />{[c.city, c.country ? countryLabel(c.country) : ""].filter(Boolean).join(", ")}</span>}
              <button type="button" className="dw-tag" onClick={() => goTo("people")}><DwIcon name="users" />{peopleCount} {peopleCount === 1 ? "contact" : "contacts"}</button>
            </div>
          </div>
          <button className="dw-x" onClick={() => close()} aria-label="Close">×</button>
        </header>

        <div className="dw-layout">
          <DwNav items={sections} active={active} onGo={goTo} />

          <div className="dw-body" ref={bodyRef}>
            <section className="dw-sec" data-sec="company" data-tone="green">
              <DwSecHead icon="id" title="Company information" hint="Who they are, where they are, how to reach them and what they are to you"
                aside={c.id && (creator || createdOn) ? <span className="dw-created"><DwIcon name="person" />{creator ? `Created by ${creator}` : "Created"}{createdOn ? ` · ${createdOn}` : ""}</span> : undefined} />
              <div className="dw-grid">
                <div className="dw-f"><label>Common name<span className="dw-req"> *</span></label>
                  <input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Acme" />
                </div>
                <div className={`dw-f ${mc("legal_name")}`}><label>Legal name{rq("legal_name")}</label>
                  <input value={c.legal_name ?? ""} onChange={(e) => set({ legal_name: e.target.value })} placeholder="e.g. Acme Holdings S.L." />
                </div>
                <div className={`dw-f ${mc("vat_number")}`}><label>VAT / Tax ID{rq("vat_number")}</label>
                  <input value={c.vat_number ?? ""} onChange={(e) => set({ vat_number: e.target.value })} placeholder="e.g. B12345678" />
                </div>
              </div>
              <div className="dw-subh"><DwIcon name="pin" />Address</div>
              <AddressFields value={c} onChange={(p) => set(p as Partial<Company>)} countryAs="name" withDetails req={(k) => rq(k)} missing={(k) => miss(k)} />
              <div className="dw-subh"><DwIcon name="globe" />Sector, web &amp; phones</div>
              <div className="dw-grid">
                <div className={`dw-f dw-col2 ${sectorAuto ? "is-auto" : ""} ${mc("sector")}`}>
                  <label>Sector{rq("sector")}{sectorAuto && <span className="dw-f-assist">Guessed from the name — change it if it's wrong</span>}</label>
                  {newSector === null ? (
                    <div className="dw-sector">
                      <Select value={c.sector ?? ""} placeholder="Choose a sector…"
                        onChange={(v) => { if (v === "__add") { setNewSector(""); return; } set({ sector: v || null }); setSectorTouched(true); setSectorAuto(false); }}
                        options={[{ value: "", label: "— No sector" }, ...sectors.map((s) => ({ value: s, label: s })),
                          ...(c.sector && !sectors.includes(c.sector) ? [{ value: c.sector, label: `${c.sector} (as imported)` }] : [])]} />
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
                <div className={`dw-f ${mc("website")}`}><label>Website{rq("website")}</label>
                  <input value={c.website ?? ""} onChange={(e) => set({ website: e.target.value })} placeholder="https://" />
                </div>
                <div className={`dw-f ${mc("linkedin")}`}><label>LinkedIn{rq("linkedin")}</label>
                  <input value={c.linkedin ?? ""} placeholder="linkedin.com/company/…" title={c.linkedin ? linkedInHandle(c.linkedin) : undefined}
                    onChange={(e) => set({ linkedin: e.target.value })}
                    onBlur={(e) => set({ linkedin: normalizeLinkedIn(e.target.value) })} />
                </div>
                <PhoneField label="Telephone" value={c.landline} ext={c.landline_ext} onValue={(v) => set({ landline: v })} onExt={(v) => set({ landline_ext: v })} placeholder="+34 910 000 000" req={isReq("landline")} missing={miss("landline")} />
                <PhoneField label="Mobile" value={c.phone} ext={c.phone_ext} onValue={(v) => set({ phone: v })} onExt={(v) => set({ phone_ext: v })} placeholder="+34 600 000 000" req={isReq("phone")} missing={miss("phone")} />
                <div className={`dw-f ${mc("email")}`}><label>Email{rq("email")}</label>
                  <input type="email" value={c.email ?? ""} onChange={(e) => set({ email: e.target.value })} placeholder="info@company.com" />
                </div>
                <div className={`dw-f dw-col2 ${mc("source")}`}><label>Source{rq("source")}</label>
                  <Select value={c.source ?? ""} placeholder="Where did it come from?"
                    onChange={(v) => set({ source: v || null })}
                    options={[{ value: "", label: "— No source" }, ...sources.map((x) => ({ value: x, label: x })),
                      ...(c.source && !sources.includes(c.source) ? [{ value: c.source, label: `${c.source} (as imported)` }] : [])]} />
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
                    null /* new types are added in Settings › Companies page */
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
              <div className="dw-subh"><DwIcon name="euro" />Billing{billFilled && <span className="dw-pill is-ok">Set</span>}</div>
              <div className="dw-grid">
                <div className={`dw-f ${mc("billing_name")}`}><label>Name{rq("billing_name")}</label>
                  <input value={bill.name ?? ""} onChange={(e) => setBill({ name: e.target.value })} placeholder="e.g. Accounts payable" />
                </div>
                <div className={`dw-f ${mc("billing_email")}`}><label>Email{rq("billing_email")}</label>
                  <input type="email" value={bill.email ?? ""} onChange={(e) => setBill({ email: e.target.value })} placeholder="invoices@company.com" />
                </div>
                <PhoneField label="Phone" value={bill.phone} ext={bill.phone_ext} onValue={(v) => setBill({ phone: v })} onExt={(v) => setBill({ phone_ext: v })} placeholder="+34 910 000 000" req={isReq("billing_phone")} missing={miss("billing_phone")} />
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

            {(
              <section className="dw-sec" data-sec="custom" data-tone="slate">
                <DwSecHead icon="sliders" title="Additional details" hint="Your own fields — set them up in Settings › Companies page" />
                {fields.length === 0 && <p className="dw-empty-hint">No custom fields yet.</p>}
                <div className="dw-grid">
                  {fields.map((f) => (
                    <div className={`dw-f ${f.type === "text" || isChoiceType(f.type) ? "dw-col2" : ""}`} key={f.id}>
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
                          placeholder="Select…" searchable={isPartnerField(f)}
                          options={[{ value: "", label: "—" }, ...optsOf(f).map((o) => ({ value: o, label: o }))]} />
                      )}
                      {f.type === "multiselect" && (
                        <MultiChoice value={customVal(f.id)} options={optsOf(f)} onChange={(v) => setCustom(f.id, v)}
                          onCreate={canAssign && !isPartnerField(f) ? (_label, next) => updateCompanyField(f.id, { options: next }) : undefined} />
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="dw-sec" data-sec="deals" data-tone="blue">
              <DwSecHead icon="trend" title="Deals" hint="Every opportunity with this company — click one to open it, or start a new one"
                aside={<span className="dw-sec-acts">{deals && deals.length ? <span className="dw-pill">{deals.length}</span> : null}
                  {c.id && <NewDealButton onClick={() => leaveFor(() => navigate(newDealUrl({ company: { id: c.id!, name: c.name } })))} />}</span>} />
              {!c.id ? <p className="dw-empty-hint">Save the company first; its deals show here.</p>
                : <DealRows deals={deals} empty="No deals with this company yet." onOpen={(id) => leaveFor(() => navigate(`/sales?tracking=${id}`))} />}
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
                    <ConfirmX className="co-cc-x" label="Unlink contact" question="Unlink?" onConfirm={() => detachExisting(ct.id!)} />
                  </div>
                ))}
                {newContacts.map((ct, i) => (
                  <div className="co-cc-row" key={`new-${i}`}>
                    <span className="co-cc-avatar co-cc-avatar-new">{(ct.first_name?.[0] ?? "+").toUpperCase()}</span>
                    <div className="co-cc-main">
                      <span className="co-cc-name">{contactName(ct)}<i className="co-cc-newtag">New</i></span>
                      <span className="co-cc-meta">{[ct.position, ct.email].filter(Boolean).join(" · ") || "—"}</span>
                    </div>
                    <ConfirmX className="co-cc-x" label="Remove contact" onConfirm={() => removeNewContact(i)} />
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
                    <ContactPicker contacts={attachable} onPick={attachExisting}
                      search={findContacts ? (q) => findContacts(q).then((list) => list.filter((ct) => ct.id && !linked.some((x) => x.id === ct.id))) : undefined} />
                  )}
                  <button type="button" className="co-cc-new-btn" onClick={() => setAddingContact(true)}>+ New contact</button>
                </div>
              )}
            </section>

            <section className="dw-sec" data-sec="notes" data-tone="rose">
              <DwSecHead icon="note" title="Notes" hint="Anything worth remembering about this company" />
              <textarea className="dw-area" value={c.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="History, how you work with them, next steps…" />
            </section>

            <section className="dw-sec" data-sec="group" data-tone="indigo">
              <DwSecHead icon="tree" title="Group" hint="Companies of the same group, and which one sits above which"
                aside={groupSize > 1 ? <span className="dw-pill">{groupSize} companies</span> : undefined} />
              <div className="dw-grid">
                <div className="dw-f"><label>Parent company</label>
                  <Select value={c.parent_id ?? ""} onChange={(v) => set({ parent_id: v || null })} placeholder="None — top of its group"
                    options={parentOptions} />
                </div>
                <div className="dw-f"><label>Add a company below this one</label>
                  <Select value="" onChange={(v) => v && setChildren((xs) => [...xs, v])} placeholder="+ Add a subsidiary"
                    options={childOptions} />
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

            <HistorySection entity="company" id={c.id} employees={employees} fieldLabel={histLabel} formatValue={histValue} />
            {canAssign && (
              <section className="dw-sec" data-sec="access" data-tone="violet">
                <DwSecHead icon="lock" title="Visibility" hint="Who in the team can see this company" />
                <div className="dw-chips">
                  {who.map((id) => (
                    <span key={id} className="dw-chip">
                      <DwIcon name="person" />{employees.find((e) => e.id === id)?.name ?? "Unknown"}
                      <ConfirmX label="Remove access" question="Remove?" onConfirm={() => setWho((xs) => xs.filter((x) => x !== id))} />
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

          </div>
        </div>

        <footer className="dw-foot">
          {c.id && <button className="dw-del" onClick={remove}>Delete</button>}
          <span className={`dw-foot-note ${err ? "is-err" : savedAt ? "is-ok" : !c.name.trim() || missingFixed("company", c).length ? "is-warn" : ""}`}>
            {err ?? (savedAt ? "Saved ✓" : !c.name.trim() ? "Give the company a name to save it."
              : missingFixed("company", c).length ? `Still missing: ${missingFixed("company", c).join(", ")}` : "Nothing is saved until you click Save.")}
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
/** Lookups over all companies, built once per load: by id, children of each company, and the group walks. */
function companyIndex(companies: Company[]) {
  const byId = new Map<string, Company>();
  const kidsOf = new Map<string, string[]>();
  companies.forEach((x) => {
    if (!x.id) return;
    byId.set(x.id, x);
    if (x.parent_id) { const a = kidsOf.get(x.parent_id); if (a) a.push(x.id); else kidsOf.set(x.parent_id, [x.id]); }
  });
  /** The company at the top of id's group. */
  const rootOf = (id: string) => { const seen = new Set<string>(); let cur = id; for (;;) { const p = byId.get(cur)?.parent_id; if (!p || seen.has(p)) return cur; seen.add(cur); cur = p; } };
  /** Every company below id (not id itself). */
  const descendants = (id: string) => { const out = new Set<string>(); const st = [id]; while (st.length) { const k = kidsOf.get(st.pop()!) ?? []; k.forEach((x) => { if (!out.has(x)) { out.add(x); st.push(x); } }); } return out; };
  /** `of` and every company above it. */
  const ancestors = (of: string | null) => { const out = new Set<string>(); let cur = of; while (cur && !out.has(cur)) { out.add(cur); cur = byId.get(cur)?.parent_id ?? null; } return out; };
  return { byId, kidsOf, rootOf, descendants, ancestors };
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
          {detachable.includes(id) && <ConfirmX className="gt-x" label={`Take ${co.name} out of the group`} question="Take out?" onConfirm={() => onDetach(id)} />}
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
/** The list's columns (Name first, up to 4 more, drag to reorder) — on the Companies page. */
function FieldSettings({ availableColumns, columns, onColumns, compact, onCompact, onClose }: {
  availableColumns: { key: string; label: string }[];
  columns: string[];
  onColumns: (next: string[]) => void;
  compact?: boolean; onCompact?: (v: boolean) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dw-backdrop" onMouseDown={onClose}>
      <div className="dw dw-narrow" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dw-head">
          <div>
            <span className="dw-eyebrow">Configure</span>
            <h2 className="dw-title">Company list columns</h2>
          </div>
          <button className="dw-x" onClick={onClose}>×</button>
        </div>
        <div className="dw-body">
          <div className="dw-sec">
            <p className="dw-sec-title">Overview columns</p>
            <ColumnsEditor availableColumns={availableColumns} columns={columns} onColumns={onColumns} compact={compact} onCompact={onCompact} />
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

/** Name first, then as many columns as you like, dragged into order (Companies and Contacts lists).
 *  With many, the list scrolls sideways and the name stays in place. Optional compact rows. */
export function ColumnsEditor({ availableColumns, columns, onColumns, compact, onCompact }: {
  availableColumns: { key: string; label: string }[]; columns: string[]; onColumns: (next: string[]) => void;
  compact?: boolean; onCompact?: (v: boolean) => void;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  return (
    <>
      <p className="dw-empty-hint" style={{ marginTop: 0 }}>Name is always first. Add as many columns as you need and drag to reorder — when they don't fit, the list scrolls sideways and the name stays in place.</p>
      {onCompact && (
        <button type="button" role="switch" aria-checked={!!compact} className={`cfe-req cf-compact ${compact ? "is-on" : ""}`} onClick={() => onCompact(!compact)}>
          <i />Compact rows — fit more on screen
        </button>
      )}
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
            <button className="cf-col-x" onClick={() => onColumns(columns.filter((x) => x !== k))} aria-label="Remove column" title="Hide this column (you can add it back any time)">×</button>
          </div>
        ))}
      </div>
      {availableColumns.some((c) => !columns.includes(c.key)) && (
        <div className="cf-col-add">
          <Select value="" onChange={(v) => v && onColumns([...columns, v])} placeholder="+ Add column"
            options={[{ value: "", label: "+ Add column" }, ...availableColumns.filter((c) => !columns.includes(c.key)).map((c) => ({ value: c.key, label: c.label }))]} />
        </div>
      )}
    </>
  );
}

type CustomFieldLike = { id: string; label: string; type: "text" | "number" | "date" | "boolean" | "select" | "multiselect"; required: boolean; options: string[] };
const FIELD_TYPE_LABEL: Record<CustomFieldLike["type"], string> = { text: "Text", number: "Number", date: "Date", boolean: "Yes / No", select: "Dropdown", multiselect: "Multiple choice" };
/** Fields with a list of options: a dropdown (one) or multiple choice (several, like tags). */
export const isChoiceType = (t: string) => t === "select" || t === "multiselect";
// the same icons as the Deal fields (Settings › Deals page)
const FIELD_TYPE_ICON: Record<CustomFieldLike["type"], string> = {
  text: "M4 6h16M4 12h10M4 18h7", number: "M9 4 7 20M17 4l-2 16M4 9h16M3 15h16", date: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  boolean: "M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", select: "M4 7h16M4 12h16M4 17h10M18 15l2 2-2 2",
  multiselect: "M3 7l2 2 4-4M3 15l2 2 4-4M13 7h8M13 15h8",
};
/* ---------- Multiple-choice custom fields (several options at once, like tags) ---------- */
const mcNorm = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/** Pick several options of a multiple-choice field: chips + a search list that opens under them.
 *  `onCreate` (people allowed to edit fields) adds a new option to the field on the fly. */
export function MultiChoice({ value, options, onChange, onCreate, placeholder = "Choose…" }: {
  value: unknown; options: string[]; onChange: (v: string[]) => void;
  /** Adds a new option to the field; gets the label and the full option list to save (includes earlier ones made here). */
  onCreate?: (label: string, nextOptions: string[]) => Promise<unknown> | unknown; placeholder?: string;
}) {
  const sel = customList(value);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  /** Options created here — the parent's field list may not have reloaded yet. */
  const [made, setMade] = useState<string[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) { setOpen(false); setQ(""); } };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const all = [...new Set([...options, ...made, ...sel])];
  const list = all.filter((o) => !q.trim() || mcNorm(o).includes(mcNorm(q)));
  const canCreate = !!onCreate && !!q.trim() && !all.some((o) => mcNorm(o) === mcNorm(q));
  const toggle = (o: string) => onChange(sel.includes(o) ? sel.filter((x) => x !== o) : [...sel, o]);
  const create = async () => {
    const label = q.trim();
    if (!label || !onCreate) return;
    await onCreate(label, [...new Set([...options, ...made, label])]);
    setMade((m) => [...m, label]);
    onChange([...sel, label]); setQ(""); setHi(0);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.stopPropagation(); setOpen(false); setQ(""); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, list.length - (canCreate ? 0 : 1))); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (hi < list.length && list[hi]) { toggle(list[hi]); setQ(""); } else if (canCreate) void create();
      return;
    }
    if (e.key === "Backspace" && !q && sel.length) onChange(sel.slice(0, -1));
  };
  return (
    <div className={`mc ${open ? "is-open" : ""}`} ref={wrapRef}>
      <div className="mc-box" onClick={() => { setOpen(true); inputRef.current?.focus(); }}>
        {sel.map((o) => (
          <span className="mc-chip" key={o}>
            {o}
            <button type="button" aria-label={`Remove ${o}`} onClick={(e) => { e.stopPropagation(); toggle(o); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>
            </button>
          </span>
        ))}
        <input ref={inputRef} className="mc-input" value={q} placeholder={sel.length ? "Add…" : placeholder}
          onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }} onKeyDown={onKey} />
        <svg className="mc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </div>
      {open && (
        <div className="mc-list" role="listbox" aria-multiselectable="true">
          {list.map((o, i) => (
            <button type="button" key={o} role="option" aria-selected={sel.includes(o)}
              className={`mc-opt ${sel.includes(o) ? "is-on" : ""} ${i === hi ? "is-hi" : ""}`}
              onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHi(i)} onClick={() => toggle(o)}>
              <i aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></i>
              <span>{o}</span>
            </button>
          ))}
          {canCreate && (
            <button type="button" className={`mc-opt is-new ${hi === list.length ? "is-hi" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => void create()}>
              <i aria-hidden="true">+</i><span>Create “{q.trim()}”</span>
            </button>
          )}
          {!list.length && !canCreate && <p className="mc-empty">{all.length ? "Nothing matches." : "No options yet — add them in Settings."}</p>}
        </div>
      )}
    </div>
  );
}

/** A multiple-choice value in a list cell: the first chips, then "+N". */
export function CustomChips({ value, max = 2 }: { value: unknown; max?: number }) {
  const list = customList(value);
  if (!list.length) return <span className="co-laddr">—</span>;
  return (
    <span className="mc-cell" title={list.join(", ")}>
      {list.slice(0, max).map((o) => <span className="mc-chip is-sm" key={o}>{o}</span>)}
      {list.length > max && <span className="mc-more">+{list.length - max}</span>}
    </span>
  );
}

/* ---------- Custom fields of companies and contacts — the same editor as Deal fields (Settings › Deals page) ---------- */
const CF_TYPES: CustomFieldLike["type"][] = ["text", "number", "date", "boolean", "select", "multiselect"];
const CF_TYPE_HINT: Record<CustomFieldLike["type"], string> = {
  text: "Free text, e.g. a reference or a nickname",
  number: "A figure, e.g. employees or licences",
  date: "A date, e.g. a birthday or renewal",
  boolean: "Yes or no, e.g. NDA signed",
  select: "One choice from your own list",
  multiselect: "Several choices at once, like tags",
};
const CfIco = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const CfUp = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>;
const CfDown = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>;
const CfX = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>;
const cfNorm = (x: string) => x.trim().toLowerCase();

/**
 * Custom fields of companies or contacts — built like the Deal fields editor:
 * the list (drag or arrows to reorder, required on/off, edit name / type / each
 * option, delete) and below it "Add a field" with the type cards. `api` says
 * where they are stored; `noun` is what they're on ("contact", "company").
 */
export function CustomFieldsEditor({ fields, api, examples, isReserved, onChanged, noun = "record" }: {
  fields: CustomFieldLike[];
  api: {
    add: (f: { label: string; type: CustomFieldLike["type"]; required: boolean; options: string[]; sort: number }) => Promise<unknown>;
    update: (id: string, patch: Partial<{ label: string; type: CustomFieldLike["type"]; required: boolean; options: string[]; sort: number }>) => Promise<unknown>;
    remove: (id: string) => Promise<unknown>;
    /** A dropdown option was renamed: move the stored values to the new name. */
    renameValue?: (fieldId: string, from: string, to: string) => Promise<unknown>;
  };
  /** Placeholders for the name and the dropdown options. */
  examples: { name: string; options: string };
  /** A label that is already a built-in field (refused). */
  isReserved?: (label: string) => boolean;
  onChanged: () => Promise<void> | void;
  /** What the fields are on, for the texts ("contact", "company"). */
  noun?: string;
}) {
  const nouns = noun === "company" ? "companies" : `${noun}s`;
  const [items, setItems] = useState<CustomFieldLike[]>(fields);
  useEffect(() => { setItems(fields); }, [fields]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [askDel, setAskDel] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // new field
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomFieldLike["type"]>("text");
  const [required, setRequired] = useState(false);
  const [newOpts, setNewOpts] = useState<string[]>([]);
  const [optDraft, setOptDraft] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  /** Runs a change, then reloads the list; errors show under it. */
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      if (typeof r === "string" && r) setErr(r);
      else if (r && typeof r === "object" && "error" in (r as any) && (r as any).error) setErr(String((r as any).error?.message ?? (r as any).error));
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    await onChanged();
    setBusy(false);
  };
  const choice = isChoiceType(type);
  const dup = !!label.trim() && items.some((f) => cfNorm(f.label) === cfNorm(label));
  const reserved = !!label.trim() && !!isReserved?.(label.trim());
  const canAdd = !!label.trim() && !dup && !reserved && (!choice || newOpts.length > 0 || !!optDraft.trim());
  // typing a comma or pasting a list splits it into options
  const pushOpts = (raw: string) => {
    const parts = raw.split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);
    setOptDraft("");
    if (!parts.length) return;
    setNewOpts((xs) => { const out = [...xs]; parts.forEach((p) => { if (!out.some((o) => cfNorm(o) === cfNorm(p))) out.push(p); }); return out; });
  };
  const add = () => {
    if (!canAdd) return;
    const options = choice ? [...newOpts, ...optDraft.split(/[,\n;]/).map((x) => x.trim()).filter((x) => x && !newOpts.some((o) => cfNorm(o) === cfNorm(x)))] : [];
    void run(async () => {
      const r = await api.add({ label: label.trim(), type, required, options, sort: items.length });
      setLabel(""); setType("text"); setRequired(false); setNewOpts([]); setOptDraft(""); nameRef.current?.focus();
      return r && typeof r === "object" && "error" in (r as any) ? r : null;
    });
  };
  const reorder = (ids: string[]) => {
    const next = ids.map((id) => items.find((f) => f.id === id)!).filter(Boolean);
    setItems(next);
    void run(() => Promise.all(next.map((f, k) => api.update(f.id, { sort: k }))));
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const ids = items.map((f) => f.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(ids);
  };
  const drop = (target: string) => {
    const from = dragId; setDragId(null); setOverId(null);
    if (!from || from === target) return;
    const ids = items.map((f) => f.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(target), 0, from);
    reorder(ids);
  };

  return (
    <div className="dw dw-narrow tfm is-inline cfx">
      <div className="dw-body">
      <p className="tfm-where">
        Extra information every {noun} can carry. Fields show up when you <b>open a {noun}</b>, as <b>columns and filters</b> in the list, and in <b>Import</b> and <b>Export</b>.
      </p>

      <div className="dw-sec">
        <p className="dw-sec-title">Your fields{items.length > 0 && <span className="tfm-count">{items.length}</span>}</p>
        {items.length === 0 ? (
          <p className="tfe-empty">No {noun} fields yet. Add the first one below.</p>
        ) : (
          <ul className="tfe-list">
            {items.map((f, i) => editing === f.id ? (
              <CfFieldEditor key={f.id} field={f} others={items.filter((x) => x.id !== f.id)} isReserved={isReserved} nouns={nouns}
                onCancel={() => setEditing(null)}
                onSave={async (patch, renames) => {
                  await run(async () => {
                    await api.update(f.id, patch);
                    if (api.renameValue) for (const [from, to] of renames) await api.renameValue(f.id, from, to);
                  });
                  setEditing(null);
                }} />
            ) : (
              <li key={f.id} style={{ ["--i" as string]: i } as CSSProperties}
                className={`tfe-row ${dragId === f.id ? "is-dragging" : ""} ${overId === f.id && dragId !== f.id ? "is-over" : ""}`}
                draggable={!editing}
                onDragStart={(e) => { setDragId(f.id); e.dataTransfer.effectAllowed = "move"; }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
                onDragOver={(e) => { if (!dragId) return; e.preventDefault(); if (overId !== f.id) setOverId(f.id); }}
                onDrop={(e) => { e.preventDefault(); drop(f.id); }}>
                <span className="tfe-move">
                  <button type="button" disabled={i === 0 || busy} onClick={() => move(i, -1)} aria-label="Move up" title="Move up"><CfUp /></button>
                  <button type="button" disabled={i === items.length - 1 || busy} onClick={() => move(i, 1)} aria-label="Move down" title="Move down"><CfDown /></button>
                </span>
                <span className={`tfe-ico is-${f.type}`}><CfIco d={FIELD_TYPE_ICON[f.type]} /></span>
                <span className="tfe-main">
                  <b>{f.label}</b>
                  <small>{FIELD_TYPE_LABEL[f.type]}{isChoiceType(f.type) ? ` · ${f.options.length} option${f.options.length === 1 ? "" : "s"}` : ""}</small>
                  {isChoiceType(f.type) && f.options.length > 0 && (
                    <span className="tfe-chips" title={f.options.join("\n")}>
                      {f.options.slice(0, 5).map((o, k) => <i key={k}>{o}</i>)}
                      {f.options.length > 5 && <i className="is-more">+{f.options.length - 5}</i>}
                    </span>
                  )}
                </span>
                <button type="button" role="switch" aria-checked={f.required} disabled={busy}
                  className={`tfe-req ${f.required ? "is-on" : ""}`} onClick={() => void run(() => api.update(f.id, { required: !f.required }))}>
                  <i />Required
                </button>
                <button type="button" className="tfe-btn" onClick={() => { setEditing(f.id); setAskDel(null); }} aria-label={`Edit ${f.label}`} title="Edit name, type and options">
                  <CfIco d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                </button>
                {askDel === f.id ? (
                  <span className="tfe-ask">
                    Delete?
                    <button type="button" className="is-yes" disabled={busy} onClick={() => { setAskDel(null); void run(() => api.remove(f.id)); }}>Yes</button>
                    <button type="button" onClick={() => setAskDel(null)}>No</button>
                  </span>
                ) : (
                  <button type="button" className="tfe-btn is-del" onClick={() => setAskDel(f.id)} disabled={busy} aria-label={`Delete ${f.label}`}
                    title={`Delete — ${nouns} keep the value already stored, but it won't show anymore`}>
                    <CfIco d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {items.length > 1 && <p className="tfm-hint">Use the arrows or drag a row to change the order. The pencil edits a field's name, type and each of its options.</p>}
      </div>

      <div className="dw-sec">
        <p className="dw-sec-title">Add a field</p>
        <div className="dw-grid">
          <div className="dw-f dw-col2"><label>Field name</label>
            <input ref={nameRef} value={label} onChange={(e) => { setLabel(e.target.value); setErr(null); }} placeholder={examples.name}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
          </div>
          <div className="dw-f dw-col2"><label>Type</label>
            <div className="tfm-types" role="radiogroup" aria-label="Type">
              {CF_TYPES.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? "is-on" : ""} onClick={() => setType(t)}>
                  <b><CfIco d={FIELD_TYPE_ICON[t]} />{FIELD_TYPE_LABEL[t]}</b><span>{CF_TYPE_HINT[t]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className={`tfe-newopts dw-col2 ${choice ? "is-on" : ""}`}>
            <div className="tfe-newopts-in">
              <label className="tfe-k">Options <em>{newOpts.length}</em></label>
              {newOpts.length > 0 && (
                <ul className="tfe-optlist">
                  {newOpts.map((o, k) => (
                    <li key={`${k}-${o}`}>
                      <span className="tfe-mv">
                        <button type="button" disabled={k === 0} tabIndex={choice ? 0 : -1} onClick={() => setNewOpts((xs) => { const c = [...xs]; [c[k - 1], c[k]] = [c[k], c[k - 1]]; return c; })} aria-label="Move up"><CfUp /></button>
                        <button type="button" disabled={k === newOpts.length - 1} tabIndex={choice ? 0 : -1} onClick={() => setNewOpts((xs) => { const c = [...xs]; [c[k + 1], c[k]] = [c[k], c[k + 1]]; return c; })} aria-label="Move down"><CfDown /></button>
                      </span>
                      <input value={o} tabIndex={choice ? 0 : -1}
                        onChange={(e) => { const v = e.target.value; setNewOpts((xs) => xs.map((x, j) => (j === k ? v : x))); }}
                        onBlur={() => setNewOpts((xs) => xs.map((x) => x.trim()).filter(Boolean))} />
                      <button type="button" className="tfe-x" tabIndex={choice ? 0 : -1} onClick={() => setNewOpts((xs) => xs.filter((_, j) => j !== k))} aria-label={`Remove ${o}`}><CfX /></button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="tfe-optadd">
                <input value={optDraft} tabIndex={choice ? 0 : -1}
                  placeholder={newOpts.length ? "Add another option…" : `Type an option and press Enter — e.g. ${examples.options.split(",")[0]?.trim() || "Gold"}`}
                  onChange={(e) => { const v = e.target.value; if (/[,\n;]/.test(v)) pushOpts(v); else setOptDraft(v); }}
                  onPaste={(e) => { const t = e.clipboardData.getData("text"); if (/[,\n;]/.test(t)) { e.preventDefault(); pushOpts(optDraft + t); } }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); pushOpts(optDraft); } }} />
                <button type="button" onClick={() => pushOpts(optDraft)} disabled={!optDraft.trim()} tabIndex={choice ? 0 : -1}>+ Add option</button>
              </div>
            </div>
          </div>
          <div className="dw-f dw-col2 tfm-reqline">
            <button type="button" role="switch" aria-checked={required}
              className={`dw-switch ${required ? "on" : ""}`} onClick={() => setRequired((v) => !v)}>
              <span className="dw-switch-knob" />
            </button>
            <span><b>Required</b> · a {noun} can't be saved without it</span>
          </div>
        </div>
        {dup && <p className="dw-err">There's already a field called “{label.trim()}”.</p>}
        {reserved && <p className="dw-err">“{label.trim()}” is already a built-in field.</p>}
        {choice && label.trim() && !newOpts.length && !optDraft.trim() && <p className="tfm-hint">Add at least one option.</p>}
        <button type="button" className="dw-save cf-add" onClick={add} disabled={busy || !canAdd}>{busy ? "Saving…" : "+ Add field"}</button>
      </div>
      {err && <p className="dw-err">{err}</p>}
      </div>
    </div>
  );
}

/** One custom field opened for editing: name, type and — for dropdowns — each option on its own line. */
function CfFieldEditor({ field, others, isReserved, nouns, onCancel, onSave }: {
  field: CustomFieldLike; others: CustomFieldLike[];
  isReserved?: (label: string) => boolean;
  nouns: string;
  onCancel: () => void;
  onSave: (patch: { label: string; type: CustomFieldLike["type"]; options: string[] }, renames: [string, string][]) => Promise<void>;
}) {
  const [label, setLabel] = useState(field.label);
  const [type, setType] = useState<CustomFieldLike["type"]>(field.type);
  // each option remembers its name when the editor opened, so a rename moves the stored values
  const [opts, setOpts] = useState<{ k: number; was: string | null; v: string }[]>(() => field.options.map((o, k) => ({ k, was: o, v: o })));
  const [newOpt, setNewOpt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nextK = useRef(field.options.length + 1);
  const addOpt = () => {
    const v = newOpt.trim();
    if (!v) return;
    if (opts.some((o) => cfNorm(o.v) === cfNorm(v))) { setErr(`“${v}” is already an option.`); return; }
    setOpts((xs) => [...xs, { k: nextK.current++, was: null, v }]); setNewOpt(""); setErr(null);
  };
  const moveOpt = (i: number, d: number) => setOpts((xs) => {
    const j = i + d; if (j < 0 || j >= xs.length) return xs;
    const c = [...xs]; [c[i], c[j]] = [c[j], c[i]]; return c;
  });
  const save = async () => {
    const l = label.trim();
    if (!l) { setErr("The field needs a name."); return; }
    if (cfNorm(l) !== cfNorm(field.label)) {
      if (isReserved?.(l)) { setErr(`“${l}” is already a built-in field.`); return; }
      if (others.some((f) => cfNorm(f.label) === cfNorm(l))) { setErr(`There is already a field called “${l}”.`); return; }
    }
    const clean = opts.map((o) => ({ ...o, v: o.v.trim() })).filter((o) => o.v);
    const seen = new Set<string>();
    for (const o of clean) { if (seen.has(cfNorm(o.v))) { setErr(`“${o.v}” is in the list twice.`); return; } seen.add(cfNorm(o.v)); }
    if (isChoiceType(type) && !clean.length) { setErr("Add at least one option."); return; }
    setBusy(true); setErr(null);
    const renames: [string, string][] = isChoiceType(type) ? clean.filter((o) => o.was && o.was !== o.v).map((o) => [o.was!, o.v]) : [];
    await onSave({ label: l, type, options: isChoiceType(type) ? clean.map((o) => o.v) : [] }, renames);
    setBusy(false);
  };
  const renamed = opts.filter((o) => o.was && o.v.trim() && o.was !== o.v.trim()).length;
  return (
    <li className="tfe-row is-editing">
      <div className="tfe-ed">
        <label className="tfe-f">
          <span className="tfe-k">Name</span>
          <input value={label} autoFocus onChange={(e) => { setLabel(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
        </label>
        <div className="tfe-f">
          <span className="tfe-k">Type</span>
          <div className="tfe-typeseg" role="radiogroup" aria-label="Type">
            {CF_TYPES.map((t) => (
              <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? "is-on" : ""} onClick={() => { setType(t); setErr(null); }}>
                <CfIco d={FIELD_TYPE_ICON[t]} />{FIELD_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        {type !== field.type && <p className="tfe-warn">{field.type === "select" && type === "multiselect"
          ? `Each of the ${nouns} keeps its current choice and can now take more.`
          : `Values already saved on ${nouns} stay as they are; ones that don't fit the new type may show empty.`}</p>}
        {isChoiceType(type) && (
          <div className="tfe-f">
            <span className="tfe-k">Options <em>{opts.length}</em></span>
            <ul className="tfe-optlist">
              {opts.map((o, i) => (
                <li key={o.k}>
                  <span className="tfe-mv">
                    <button type="button" disabled={i === 0} onClick={() => moveOpt(i, -1)} aria-label="Move up"><CfUp /></button>
                    <button type="button" disabled={i === opts.length - 1} onClick={() => moveOpt(i, 1)} aria-label="Move down"><CfDown /></button>
                  </span>
                  <input value={o.v} onChange={(e) => { const v = e.target.value; setOpts((xs) => xs.map((x) => (x.k === o.k ? { ...x, v } : x))); setErr(null); }}
                    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
                  {o.was && o.was !== o.v.trim() && o.v.trim() && <small className="tfe-was" title={`${nouns[0].toUpperCase()}${nouns.slice(1)} with the old value get the new one`}>was “{o.was}”</small>}
                  {!o.was && <small className="tfe-was is-new">new</small>}
                  <button type="button" className="tfe-x" onClick={() => setOpts((xs) => xs.filter((x) => x.k !== o.k))} aria-label={`Remove ${o.v}`} title={`Remove — ${nouns} keep the old value`}>
                    <CfX />
                  </button>
                </li>
              ))}
            </ul>
            <div className="tfe-optadd">
              <input value={newOpt} placeholder="Add an option…" onChange={(e) => { setNewOpt(e.target.value); setErr(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOpt(); } }} />
              <button type="button" onClick={addOpt} disabled={!newOpt.trim()}>+ Add option</button>
            </div>
          </div>
        )}
        {err && <p className="dw-err">{err}</p>}
        <div className="tfe-foot">
          {renamed > 0 && <span className="tfe-foot-note">{renamed} renamed option{renamed === 1 ? "" : "s"} will be updated on every {nouns === "companies" ? "company" : nouns.replace(/s$/, "")}.</span>}
          <button type="button" className="tfe-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="dw-save" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save field"}</button>
        </div>
      </div>
    </li>
  );
}

/** A list you can add to (sectors, sources, relationship types): the built-in ones, then yours with a remove button. */
function OptionList({ kind, title, hint, options, builtIn, placeholder, onChanged, bare = false, partnerSwitch = false }: {
  kind: CrmOption["kind"]; title?: string; hint?: string; options: CrmOption[]; builtIn: string[]; placeholder: string;
  onChanged: () => Promise<void> | void;
  /** Without its own card and title (inside a settings section). */
  bare?: boolean;
  /** Each of your types can be switched on as a partner type (company types). */
  partnerSwitch?: boolean;
}) {
  const [partnerBusy, setPartnerBusy] = useState<string | null>(null);
  const togglePartner = async (o: CrmOption, on: boolean) => {
    setPartnerBusy(o.id);
    const e = await setPartnerType(o, on);
    setPartnerBusy(null);
    if (e) { setErr(e); return; }
    setErr(null); await onChanged();
  };
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [askDel, setAskDelRaw] = useState<string | null>(null);
  // how many companies use the one being removed (null while counting)
  const [uses, setUses] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);
  const setAskDel = (id: string | null) => {
    setAskDelRaw(id); setUses(null);
    const o = id ? options.find((x) => x.id === id) : null;
    if (o) crmOptionUses(o).then((n) => setUses(n)).catch(() => setUses(0));
  };
  const remove = async (o: CrmOption) => {
    setRemoving(true);
    const e = await removeCrmOption(o);
    setRemoving(false);
    if (e) { setErr(e); return; }
    setAskDel(null); await onChanged();
  };
  // renaming one of yours: its id and the name being typed
  const [edit, setEdit] = useState<{ id: string; label: string } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const mine = options.filter((o) => o.kind === kind);
  const saveEdit = async () => {
    if (!edit) return;
    const o = mine.find((x) => x.id === edit.id);
    const l = edit.label.trim();
    if (!o || !l || l === o.label) { setEdit(null); return; }
    if ([...builtIn, ...mine.filter((x) => x.id !== o.id).map((x) => x.label)].some((x) => x.toLowerCase() === l.toLowerCase())) { setErr(`“${l}” is already there.`); return; }
    setSavingEdit(true);
    const e = await renameCrmOption(o, l);
    setSavingEdit(false);
    if (e) { setErr(e); return; }
    setEdit(null); setErr(null); await onChanged();
  };
  const add = async () => {
    const l = label.trim();
    if (!l) return;
    if ([...builtIn, ...mine.map((o) => o.label)].some((x) => x.toLowerCase() === l.toLowerCase())) { setErr(`“${l}” is already there.`); return; }
    const e = await addCrmOption(kind, l, mine.length);
    if (e) { setErr(/crm_options/i.test(e) ? "Run the CRM upgrade in Supabase first." : e); return; }
    setLabel(""); setErr(null); await onChanged();
  };
  const body = (
    <>
      <div className="cf-opts">
        {builtIn.map((b) => <span key={b} className="cf-opt is-builtin" title="Built in">{b}</span>)}
        {mine.map((o) => edit?.id === o.id ? (
          <span key={o.id} className="cf-opt is-editing">
            <input autoFocus value={edit.label} disabled={savingEdit} aria-label={`New name for ${o.label}`}
              onChange={(e) => { setEdit({ id: o.id, label: e.target.value }); setErr(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveEdit(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEdit(null); } }}
              size={Math.max(6, edit.label.length + 1)} />
            <button type="button" className="is-yes" onClick={() => void saveEdit()} disabled={savingEdit || !edit.label.trim()} title="Save — every record with it is renamed too">{savingEdit ? "…" : "save"}</button>
            <button type="button" onClick={() => setEdit(null)} disabled={savingEdit}>cancel</button>
          </span>
        ) : (
          <span key={o.id} className={`cf-opt ${askDel === o.id ? "is-asking" : ""} ${partnerSwitch && (o.is_partner ?? /partner/i.test(o.label)) ? "is-partner" : ""}`}>
            {partnerSwitch && askDel !== o.id && (() => {
              const on = o.is_partner ?? /partner/i.test(o.label);
              return (
                <button type="button" className={`cf-opt-partner ${on ? "is-on" : ""}`} aria-pressed={on} disabled={partnerBusy === o.id}
                  title={on ? `Partner type: companies typed “${o.label}” are partners. Press to stop.` : `Make “${o.label}” a partner type: its companies become partners`}
                  onClick={() => void togglePartner(o, !on)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PARTNER_ICON} /></svg>
                </button>
              );
            })()}
            {o.label}
            {askDel !== o.id && (
              <button type="button" className="cf-opt-edit" aria-label={`Rename ${o.label}`} title="Rename — every record with it follows"
                onClick={() => { setAskDel(null); setErr(null); setEdit({ id: o.id, label: o.label }); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" /></svg>
              </button>
            )}
            {askDel === o.id ? (
              <span className="cf-opt-ask">
                {uses === null ? "checking…" : uses === 0 ? "remove?" : kind === "relationship"
                  ? `remove from ${uses} ${uses === 1 ? "company" : "companies"}?`
                  : `remove? ${uses} ${uses === 1 ? "company loses it" : "companies lose it"}`}
                <button type="button" className="is-yes" disabled={uses === null || removing} onClick={() => void remove(o)}>{removing ? "…" : "yes"}</button>
                <button type="button" onClick={() => setAskDel(null)} disabled={removing}>no</button>
              </span>
            ) : (
              <button type="button" aria-label={`Remove ${o.label}`} title={kind === "product_kind" ? "Remove from the list" : "Remove from the list and from every company that has it"} onClick={() => setAskDel(o.id)}>×</button>
            )}
          </span>
        ))}
        {!builtIn.length && !mine.length && <span className="cf-opt-none">Nothing on the list yet.</span>}
      </div>
      <div className="cf-opt-add">
        <input value={label} onChange={(e) => { setLabel(e.target.value); setErr(null); }} placeholder={placeholder}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }} />
        <button type="button" className="dw-save" onClick={() => void add()} disabled={!label.trim()}>+ Add</button>
      </div>
      {err && <p className="dw-err">{err}</p>}
    </>
  );
  if (bare) return body;
  return (
    <div className="dw-sec">
      {title && <p className="dw-sec-title">{title}</p>}
      {hint && <p className="dw-empty-hint" style={{ marginTop: 0 }}>{hint}</p>}
      {body}
    </div>
  );
}

// ============================ Side panel building blocks ============================
// (Same look on Contacts and Companies — the styles are in CompaniesPage.css, "Drawer editor".)
const DW_ICON: Record<string, string> = {
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4",
  calendar: "M3 9h18M8 3v4M16 3v4M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
  ticket: "M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM14 5v12",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 13h8",
  heart: "M12 20.5s-7.5-4.4-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.8-7.5 10.2-7.5 10.2z",
  megaphone: "M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1zM16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10",
  grid: "M3 3h8v7H3zM13 3h8v4.5h-8zM13 10.5h8V21h-8zM3 13h8v8H3z",
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
  asterisk: "M12 4v16M5.1 8l13.8 8M5.1 16l13.8-8",
  dot: "M12 12h.01",
};
function DwIcon({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={DW_ICON[name] ?? ""} /></svg>;
}

/** A remove "×" that asks first: the first click turns it into "Remove? Yes / No". */
export function ConfirmX({ onConfirm, label = "Remove", question, className = "", children }: {
  onConfirm: () => void; label?: string; question?: string; className?: string; children?: ReactNode;
}) {
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    if (!ask) return;
    const t = window.setTimeout(() => setAsk(false), 6000);
    return () => window.clearTimeout(t);
  }, [ask]);
  if (ask) return (
    <span className="cx-ask" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <span>{question ?? `${label}?`}</span>
      <button type="button" className="is-yes" autoFocus onClick={(e) => { e.stopPropagation(); setAsk(false); onConfirm(); }}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setAsk(false); } }}>Yes</button>
      <button type="button" onClick={(e) => { e.stopPropagation(); setAsk(false); }}>No</button>
    </span>
  );
  return (
    <button type="button" className={`cx-x ${className}`} aria-label={label} title={label}
      onClick={(e) => { e.stopPropagation(); setAsk(true); }}>{children ?? "×"}</button>
  );
}

/** Deals as rows: name, pipeline · phase, status; click opens the deal. Optional remove (asks first) and add buttons. */
export function DealRows({ deals, empty, onOpen, onRemove, onAdd, removeLabel = "Take off this deal" }: {
  deals: (DealRef & { pending?: "add" | "remove" })[] | null; empty: string;
  onOpen: (id: string) => void;
  onRemove?: (d: DealRef) => void;
  onAdd?: (d: DealRef) => void;
  removeLabel?: string;
}) {
  // A big account can have hundreds of deals: the first ones straight away, the rest on demand.
  const [all, setAll] = useState(false);
  if (deals === null) return <p className="dw-empty-hint">Loading deals…</p>;
  if (!deals.length) return <p className="dw-empty-hint">{empty}</p>;
  const DEAL_ROWS = 30;
  const rows = all ? deals : deals.slice(0, DEAL_ROWS);
  return (
    <div className="dl-list">
      {rows.map((d) => {
        const st = d.won ? "won" : d.status === "lost" ? "lost" : d.status === "paused" ? "hold" : "open";
        return (
          <div key={d.id} className={`dl-row is-${st} ${d.pending ? `is-pending-${d.pending}` : ""}`}>
            <span className="dl-ico"><DwIcon name="trend" /></span>
            <button type="button" className="dl-main" onClick={() => onOpen(d.id)} title="Open this deal">
              <span className="dl-name">{d.name}<span className="dl-go"><DwIcon name="arrow" /></span></span>
              <span className="dl-meta">{[d.companyName && d.companyName !== d.name ? d.companyName : "", d.pipeline, d.phase].filter(Boolean).join(" · ") || "—"}</span>
            </button>
            {d.pending === "add" && <span className="dl-tag is-new">Added</span>}
            <span className={`dl-st is-${st}`}>{st === "won" ? "Won" : st === "lost" ? "Lost" : st === "hold" ? "On hold" : "Open"}</span>
            {onAdd && <button type="button" className="dl-add" onClick={() => onAdd(d)} title="Put this contact on the deal">+ Add</button>}
            {onRemove && <ConfirmX onConfirm={() => onRemove(d)} label={removeLabel} question="Take off?" />}
          </div>
        );
      })}
      {rows.length < deals.length && (
        <button type="button" className="dl-more" onClick={() => setAll(true)}>Show all {deals.length.toLocaleString("en-GB")} deals</button>
      )}
    </div>
  );
}

// ============================ Merge two records ============================
export interface MergeField { key: string; label: string; text?: (v: any) => string; group?: string }
const mgEmpty = (v: unknown) => v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0)
  || (typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every(mgEmpty));
const mgGet = (rec: any, key: string) => (key.startsWith("custom.") ? (rec.custom ?? {})[key.slice(7)] : rec[key]);
const mgText = (f: MergeField, v: any) => (mgEmpty(v) ? "—" : f.text ? f.text(v) : Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "object" ? Object.values(v).filter((x) => !mgEmpty(x)).join(" · ") : String(v));
/**
 * Two contacts or two companies become one: pick the one that stays, then for each field that differs
 * which value it keeps (its own by default, the other's where it has none). Lists (types, emails,
 * companies) are joined. Everything that pointed to the other one moves over (79_merge_records.sql)
 * and the other one is deleted.
 */
export function MergeModal<T extends { id?: string | null }>({ kind, noun, records, fields, nameOf, join, save, onClose, onDone }: {
  kind: "company" | "contact"; /** "companies", "contacts" */ noun: string; records: [T, T]; fields: MergeField[];
  nameOf: (r: T) => string;
  /** The lists both have, joined (types, extra emails, companies…). */
  join?: (keep: T, other: T) => Partial<T>;
  save: (merged: T) => Promise<string | null>;
  onClose: () => void; onDone: (kept: T) => void;
}) {
  const [keepIx, setKeepIx] = useState<0 | 1>(0);
  const keep = records[keepIx], other = records[keepIx === 0 ? 1 : 0];
  /** For each field: the record whose value is kept (0 / 1). */
  const [pick, setPick] = useState<Record<string, 0 | 1>>({});
  const differs = fields.filter((f) => JSON.stringify(mgGet(records[0], f.key) ?? null) !== JSON.stringify(mgGet(records[1], f.key) ?? null)
    && !(mgEmpty(mgGet(records[0], f.key)) && mgEmpty(mgGet(records[1], f.key))));
  const same = fields.length - differs.length;
  const chosen = (f: MergeField): 0 | 1 => {
    if (pick[f.key] !== undefined) return pick[f.key];
    return mgEmpty(mgGet(keep, f.key)) ? (keepIx === 0 ? 1 : 0) : keepIx;
  };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  const run = async () => {
    setBusy(true); setErr(null);
    const merged: any = structuredClone(keep);
    differs.forEach((f) => {
      const v = mgGet(records[chosen(f)], f.key);
      if (f.key.startsWith("custom.")) merged.custom = { ...(merged.custom ?? {}), [f.key.slice(7)]: v };
      else merged[f.key] = v;
    });
    Object.assign(merged, join?.(merged, other) ?? {});
    const e = await save(merged);
    if (e) { setBusy(false); setErr(e); return; }
    const { error } = await supabase.rpc("merge_records", { p_kind: kind, p_keep: keep.id, p_drop: other.id });
    setBusy(false);
    if (error) {
      setErr(/merge_records/i.test(error.message) && /function|schema cache/i.test(error.message)
        ? "Run 79_merge_records.sql in Supabase to merge records." : error.message);
      return;
    }
    onDone(merged);
  };
  return createPortal(
    <div className="mrg-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="mrg" role="dialog" aria-modal="true" aria-label={`Merge two ${noun}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="mrg-head">
          <span className="mrg-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6M18 3v6a6 6 0 0 1-6 6M12 15v6" /></svg></span>
          <div className="mrg-head-txt"><h2>Merge two {noun}</h2><p>Pick the one that stays and what it keeps. The other one is deleted.</p></div>
          <button type="button" className="mrg-x" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </header>
        <div className="mrg-body">
          <div className="mrg-row is-head">
            <span className="mrg-label">Keep</span>
            {records.map((r, i) => (
              <button type="button" key={r.id ?? i} className={`mrg-rec ${keepIx === i ? "is-keep" : ""}`} onClick={() => { setKeepIx(i as 0 | 1); setPick({}); }} aria-pressed={keepIx === i}>
                <i aria-hidden="true">{keepIx === i ? "✓" : ""}</i>
                <span><b>{nameOf(r) || "—"}</b><em>{keepIx === i ? "Stays" : "Merged into the other, then deleted"}</em></span>
              </button>
            ))}
          </div>
          {differs.length === 0 && <p className="mrg-same">Every field is the same — only the links (deals, people, history…) move over.</p>}
          {differs.map((f) => {
            const c = chosen(f);
            return (
              <div className="mrg-row" key={f.key}>
                <span className="mrg-label">{f.label}</span>
                {records.map((r, i) => {
                  const v = mgGet(r, f.key);
                  return (
                    <button type="button" key={i} className={`mrg-val ${c === i ? "is-on" : ""} ${mgEmpty(v) ? "is-empty" : ""}`} disabled={mgEmpty(v) && c !== i}
                      onClick={() => setPick((p) => ({ ...p, [f.key]: i as 0 | 1 }))} title={mgText(f, v)}>
                      <i aria-hidden="true" />{mgText(f, v)}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {same > 0 && differs.length > 0 && <p className="mrg-same">{same} other field{same === 1 ? " is" : "s are"} the same (or empty) in both.</p>}
        </div>
        <footer className="mrg-foot">
          <span className={`mrg-note ${err ? "is-err" : ""}`}>{err ?? `Deals, ${kind === "company" ? "contacts, clients" : "companies"}, notes and history of “${nameOf(other) || "the other"}” move to “${nameOf(keep) || "this one"}”.`}</span>
          <button type="button" className="dw-cancel" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="dw-save" onClick={() => void run()} disabled={busy}>{busy ? "Merging…" : `Merge into ${nameOf(keep) || "this one"}`}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** A new deal in Sales with this company and / or this person already picked. */
export function newDealUrl(p: { company?: { id: string; name: string } | null; contact?: { id: string; name: string } | null }) {
  const q = new URLSearchParams({ new: "1" });
  if (p.company) { q.set("company", p.company.id); q.set("coname", p.company.name); }
  if (p.contact) { q.set("contact", p.contact.id); q.set("ctname", p.contact.name); }
  return `/sales?${q.toString()}`;
}
/** "+ New deal" on a panel's Deals section. */
export function NewDealButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="dl-new" onClick={onClick} title="Start a new deal in Sales with this already picked"><span aria-hidden="true">+</span>New deal</button>;
}

/** A company's logo from its website (first candidate that loads with a real size), else its initial. */
export function CompanyLogo({ name, website, className = "" }: { name: string; website?: string | null; className?: string }) {
  const cands = logoCandidates(website);
  const [i, setI] = useState(0);
  useEffect(() => { setI(0); }, [website]);
  const src = cands[i];
  if (!src) return <span className={className}>{(name || "?").trim().slice(0, 1).toUpperCase()}</span>;
  return (
    <span className={`${className} has-logo`}>
      <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer"
        onLoad={(e) => { if ((e.currentTarget.naturalWidth || 0) <= 16) setI((x) => x + 1); }}
        onError={() => setI((x) => x + 1)} />
    </span>
  );
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
export function PhoneField({ label, value, ext, onValue, onExt, placeholder, req, missing }: {
  label: string; value?: string | null; ext?: string | null;
  onValue: (v: string) => void; onExt: (v: string) => void; placeholder?: string;
  /** Required: shows the "*". */
  req?: boolean;
  /** Required and still empty after a save was tried. */
  missing?: boolean;
}) {
  return (
    <div className={`dw-f ${missing ? "is-missing" : ""}`}><label>{label}{req && <span className="dw-req"> *</span>}</label>
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
export function StatusPills({ status, tags = [], hero, from }: {
  status: RelStatus; tags?: string[]; hero?: boolean;
  /** Where each pill comes from (contacts: the companies they work for), shown on hover. */
  from?: Record<string, string[]>;
}) {
  const custom = tags.filter((t) => t !== "sales" && t !== "client" && t !== "crm");
  const pipes = status.pipelines;
  const salesTxt = `In sales${pipes.length ? ` · ${pipes[0]}${pipes.length > 1 ? ` +${pipes.length - 1}` : ""}` : ""}`;
  const via = (k: string) => (from?.[k]?.length ? `from ${from[k].join(", ")}` : "");
  const tip = (...parts: string[]) => parts.filter(Boolean).join(" · ") || undefined;
  if (hero) return (
    <>
      {status.client && <span className="dw-tag is-ok" title={tip(via("client"))}><DwIcon name="star" />Client</span>}
      {status.sales && <span className="dw-tag is-sales" title={tip(pipes.join(", "), via("sales"))}><DwIcon name="trend" />{salesTxt}</span>}
      {custom.map((t) => <span key={t} className="dw-tag" title={tip(via(t))}><DwIcon name="tag" />{relLabel(t)}</span>)}
    </>
  );
  return (
    <>
      {status.client && <span className="co-rel co-rel-client" title={tip(via("client"))}>Client</span>}
      {status.sales && <span className="co-rel co-rel-tracking" title={tip(pipes.join(", "), via("sales"))}>{salesTxt}</span>}
      {custom.slice(0, 2).map((t) => <span key={t} className="co-rel co-rel-tag" title={tip(via(t))}>{relLabel(t)}</span>)}
      {custom.length > 2 && <span className="co-rel co-rel-inh-more" title={custom.slice(2).map((t) => [relLabel(t), via(t)].filter(Boolean).join(" — ")).join("\n")}>+{custom.length - 2}</span>}
    </>
  );
}

/** Sorting by type: clients first, then in sales, then your own types (A→Z), CRM-only last. */
export const typeSortKey = (tags: string[]) =>
  `${tags.includes("client") ? 0 : 1}${tags.includes("sales") ? 0 : 1}${tags.filter((t) => t !== "crm" && t !== "client" && t !== "sales").map((t) => t.toLowerCase()).sort().join(",") || "~"}`;

/**
 * Every type of a company or contact as chips, in one order on both pages:
 * CRM, Client, In sales, then your own (Partner, Supplier…). Used by the
 * "Types" column; hovering a chip says where it comes from.
 */
export function TypeChips({ tags, pipelines = [], max = 4 }: { tags: { tag: string; from?: string[] }[]; pipelines?: string[]; max?: number }) {
  const order = (k: string) => (k === "crm" ? 0 : k === "client" ? 1 : k === "sales" ? 2 : 3);
  const list = [...tags].sort((a, b) => order(a.tag) - order(b.tag));
  const cls = (k: string) => (k === "crm" ? "co-rel co-rel-inh is-crm" : k === "client" ? "co-rel co-rel-client" : k === "sales" ? "co-rel co-rel-tracking" : "co-rel co-rel-tag");
  const tip = (t: { tag: string; from?: string[] }) =>
    [relLabel(t.tag), t.tag === "sales" && pipelines.length ? pipelines.join(", ") : "", t.from?.length ? `from ${t.from.join(", ")}` : ""].filter(Boolean).join(" · ");
  return (
    <span className="co-types">
      {list.slice(0, max).map((t) => <span key={t.tag} className={cls(t.tag)} title={tip(t)}>{relLabel(t.tag)}</span>)}
      {list.length > max && <span className="co-rel co-rel-inh-more" title={list.slice(max).map(tip).join("\n")}>+{list.length - max}</span>}
    </span>
  );
}

/**
 * The types a contact gets from its companies (CRM, Client, In sales, Partner…),
 * marked with a small building so you can tell they come from the company.
 * In the list only your own types show (client / in sales are already in the
 * status pills); the panel shows them all, with the company they come from.
 */
export function InheritedTags({ tags, hero, max = 2 }: { tags: { tag: string; from: string[] }[]; hero?: boolean; max?: number }) {
  const bld = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={DW_ICON.building} /></svg>;
  const why = (t: { tag: string; from: string[] }) => `${relLabel(t.tag)} — from ${t.from.join(", ")}`;
  if (hero) {
    const shown = tags.filter((t) => t.tag !== "client" && t.tag !== "sales");
    return <>{shown.map((t) => (
      <span key={t.tag} className="dw-tag is-inh" title={why(t)}><DwIcon name="building" />{relLabel(t.tag)}<small>{t.from.length > 1 ? `${t.from.length} companies` : t.from[0]}</small></span>
    ))}</>;
  }
  const own = tags.filter((t) => t.tag !== "crm" && t.tag !== "client" && t.tag !== "sales");
  if (!own.length) return null;
  return (
    <>
      {own.slice(0, max).map((t) => <span key={t.tag} className="co-rel co-rel-inh" title={why(t)}>{bld}<span>{relLabel(t.tag)}</span></span>)}
      {own.length > max && <span className="co-rel co-rel-inh co-rel-inh-more" title={own.slice(max).map(why).join("\n")}>+{own.length - max}</span>}
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

/* ═══════════════════════ address globe ═══════════════════════
 * A panel beside the editor that follows the address as it is typed: the
 * globe turns to the country (lit up), then flies down to the town and the
 * street. Same recipe as the LocationMap of the other app, all free, no key:
 *   · MapLibre GL (globe projection + flyTo)
 *   · OpenFreeMap styles ("liberty", "positron" as fallback)
 *   · world-atlas (Natural Earth 1:50m) to light up the country
 *   · Photon (OpenStreetMap) to find the place
 * Loaded on demand the first time the panel opens.
 */
type GlobeLevel = "country" | "region" | "city" | "street";
interface GlobeTarget { lon: number; lat: number; zoom: number; level: GlobeLevel; label: string }

const MAP_STYLES = ["https://tiles.openfreemap.org/styles/liberty", "https://tiles.openfreemap.org/styles/positron"];
// ISO 3166 alpha-2 → numeric (world-atlas ids are numeric)
const ISO_NUM = (() => {
  const raw = "AW533AF004AO024AI660AX248AL008AD020AE784AR032AM051AS016AQ010TF260AG028AU036AT040AZ031BI108BE056BJ204BQ535BF854BD050BG100BH048BS044BA070BL652BY112BZ084BM060BO068BR076BB052BN096BT064BV074BW072CF140CA124CC166CH756CL152CN156CI384CM120CD180CG178CK184CO170KM174CV132CR188CU192CW531CX162KY136CY196CZ203DE276DJ262DM212DK208DO214DZ012EC218EG818ER232EH732ES724EE233ET231FI246FJ242FK238FR250FO234FM583GA266GB826GE268GG831GH288GI292GN324GP312GM270GW624GQ226GR300GD308GL304GT320GF254GU316GY328HK344HM334HN340HR191HT332HU348ID360IM833IN356IO086IE372IR364IQ368IS352IL376IT380JM388JE832JO400JP392KZ398KE404KG417KH116KI296KN659KR410KW414LA418LB422LR430LY434LC662LI438LK144LS426LT440LU442LV428MO446MF663MA504MC492MD498MG450MV462MX484MH584MK807ML466MT470MM104ME499MN496MP580MZ508MR478MS500MQ474MU480MW454MY458YT175NA516NC540NE562NF574NG566NI558NU570NL528NO578NP524NR520NZ554OM512PK586PA591PN612PE604PH608PW585PG598PL616PR630KP408PT620PY600PS275PF258QA634RE638RO642RU643RW646SA682SD729SN686SG702GS239SH654SJ744SB090SL694SV222SM674SO706PM666RS688SS728ST678SR740SK703SI705SE752SZ748SX534SC690SY760TC796TD148TG768TH764TJ762TK772TM795TL626TO776TT780TN788TR792TV798TW158TZ834UG800UA804UM581UY858US840UZ860VA336VC670VE862VG092VI850VN704VU548WF876WS882YE887ZA710ZM894ZW716";
  const m = new Map<string, string>();
  for (let i = 0; i < raw.length; i += 5) m.set(raw.slice(i, i + 2), raw.slice(i + 2, i + 5));
  return m;
})();

type MapLib = { ml: any; byId: Map<string, any> };
let mapLibPromise: Promise<MapLib> | null = null;
/** MapLibre, its worker (Vite: ?worker&url), its CSS and the countries — once, on demand. */
const loadMapLib = () => (mapLibPromise ??= Promise.all([
  import("maplibre-gl"),
  import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
  import("maplibre-gl/dist/maplibre-gl.css"),
  import("topojson-client"),
  import("world-atlas/countries-50m.json?url"),
]).then(async ([ml, worker, , topo, worldUrl]) => {
  const lib: any = (ml as any).default ?? ml;
  lib.setWorkerUrl(worker.default);
  const w = await (await fetch(worldUrl.default)).json();
  const feats = ((topo as any).feature(w, w.objects.countries).features ?? []) as any[];
  return { ml: lib, byId: new Map(feats.map((f) => [String(f.id ?? f.properties?.name), f])) };
}).catch((err) => { mapLibPromise = null; throw err; }));   // can be retried

/** The main part of a country (without far-away territories), as bounds. */
function mainBounds(feature: any): [[number, number], [number, number]] | null {
  const g = feature?.geometry;
  if (!g) return null;
  const polys: number[][][][] = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  const box = (rings: number[][][]) => {
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    rings[0].forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
    return [x0, y0, x1, y1];
  };
  const area = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1]);
  const boxes = polys.map(box).sort((a, b) => area(b) - area(a));
  const big = boxes[0];
  const near = boxes.filter((b) => b[0] < big[2] + 6 && b[2] > big[0] - 6 && b[1] < big[3] + 6 && b[3] > big[1] - 6);
  return [[Math.min(...near.map((b) => b[0])), Math.min(...near.map((b) => b[1]))], [Math.max(...near.map((b) => b[2])), Math.max(...near.map((b) => b[3]))]];
}

const geoCache = new Map<string, Promise<GlobeTarget | null>>();
/** The most precise place we can find for what has been typed so far. */
function locate(a: AddrValue): Promise<GlobeTarget | null> {
  const s = (x?: string | null) => String(x ?? "").trim();
  const cc = matchCountry(a.country) ?? "";
  const country = cc ? countryName(cc) : s(a.country);
  const street = [s(a.street), s(a.addr_number)].filter(Boolean).join(" ");
  const town = s(a.city), prov = s(a.province), postal = s(a.postal_code);
  let level: GlobeLevel, q: string, label: string;
  if (street && (town || postal)) { level = "street"; q = [street, [postal, town].filter(Boolean).join(" "), country].filter(Boolean).join(", "); label = street; }
  else if (town || postal) { level = "city"; q = [[postal, town].filter(Boolean).join(" "), prov, country].filter(Boolean).join(", "); label = town || postal; }
  else if (prov) { level = "region"; q = [prov, country].filter(Boolean).join(", "); label = prov; }
  else if (country) { level = "country"; q = country; label = country; }
  else return Promise.resolve(null);
  if (!geoCache.has(q)) {
    const tag = level === "country" ? "&osm_tag=place:country" : "";
    const p = fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6${tag}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: any) => {
        const feats = (d?.features ?? []) as any[];
        // keep to the chosen country
        const f = feats.find((x) => !cc || String(x.properties?.countrycode ?? "").toUpperCase() === cc) ?? null;
        const c = f?.geometry?.coordinates;
        if (!c) return null;
        const pp = f.properties ?? {};
        let zoom = ({ house: 17, street: 16, locality: 15, district: 14, postcode: 14, city: 12, county: 10, state: 8, country: 5 } as Record<string, number>)[pp.type] ?? 13;
        if (Array.isArray(pp.extent) && pp.type !== "house" && pp.type !== "street") {
          const [x0, y0, x1, y1] = pp.extent as number[];
          const span = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0) * 1.6, 1e-4);
          zoom = Math.max(5, Math.min(16, Math.floor(Math.log2((600 * 360) / (256 * span)))));
        }
        return { lon: c[0], lat: c[1], zoom: Math.min(16.5, zoom), level, label };
      })
      .catch(() => { geoCache.delete(q); return null; });
    geoCache.set(q, p);
  }
  return geoCache.get(q)!;
}

/** The globe/map panel. `value` is the address being edited; it stays mounted once opened. */
function AddressGlobe({ value, anchor, open, host }: { value: AddrValue; anchor: React.RefObject<HTMLElement | null>; open: boolean; host?: React.RefObject<HTMLElement | null> }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const userMoved = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [target, setTarget] = useState<GlobeTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [lib, setLib] = useState<MapLib | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(0);
  useEffect(() => { if (open) setMounted(true); }, [open]);

  // to the left of the editor, same height
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      // laid over a given panel (e.g. the contacts column of the won-deal client step)
      if (host?.current) {
        const h = host.current.getBoundingClientRect();
        setBox(h.width < 240 || h.height < 200 ? null : { left: h.left, top: h.top, width: h.width, height: h.height });
        return;
      }
      const dw = anchor.current?.closest(".dw") as HTMLElement | null;
      const r = dw?.getBoundingClientRect();
      if (!r) { setBox(null); return; }
      const width = Math.min(r.width, r.left - 28);
      setBox(width < 300 ? null : { left: r.left - 14 - width, top: r.top, width, height: r.height });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, anchor, host]);

  useEffect(() => {
    if (!mounted) return;
    let off = false;
    loadMapLib().then((l) => { if (!off) { setLib(l); setFailed(false); } }).catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [mounted, attempt]);

  // the map, once per library
  const hasBox = !!box;
  useEffect(() => {
    if (!lib || !elRef.current || !hasBox) return undefined;
    const { ml } = lib;
    const locale = (navigator.language || "es").slice(0, 2);
    let styleIdx = 0, styleOk = false;
    const map = new ml.Map({
      container: elRef.current, style: MAP_STYLES[0], center: [8, 30], zoom: 1.1,
      attributionControl: { compact: true }, scrollZoom: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    });
    mapRef.current = map;
    map.addControl(new ml.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("error", () => { if (!styleOk && styleIdx < MAP_STYLES.length - 1) map.setStyle(MAP_STYLES[++styleIdx]); });
    map.on("style.load", () => {
      styleOk = true;
      try { map.setProjection({ type: "globe" }); } catch { /* older style spec */ }
      // labels in the user's language when the name exists
      (map.getStyle().layers ?? []).forEach((l: any) => {
        if (l.type !== "symbol") return;
        const tf = map.getLayoutProperty(l.id, "text-field");
        if (tf && JSON.stringify(tf).includes('"name')) {
          try { map.setLayoutProperty(l.id, "text-field", ["coalesce", ["get", `name:${locale}`], ["get", "name:latin"], ["get", "name"]]); } catch { /* no name */ }
        }
      });
      const firstLabel = (map.getStyle().layers ?? []).find((l: any) => l.type === "symbol")?.id;
      if (!map.getSource("sel-country")) map.addSource("sel-country", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      if (!map.getLayer("sel-country-fill")) map.addLayer({ id: "sel-country-fill", type: "fill", source: "sel-country", paint: { "fill-color": "#12b57f", "fill-opacity": 0.18 } }, firstLabel);
      if (!map.getLayer("sel-country-line")) map.addLayer({ id: "sel-country-line", type: "line", source: "sel-country", paint: { "line-color": "#0a6f4d", "line-width": 2 } }, firstLabel);
      setReady((r) => r + 1);
    });
    map.on("dragstart", () => { userMoved.current = true; });
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(elRef.current);
    return () => { ro.disconnect(); markerRef.current?.remove(); markerRef.current = null; map.remove(); mapRef.current = null; };
  }, [lib, hasBox]);

  // what to look at: the most precise part typed so far (looked up after a pause)
  const key = [value.country, value.province, value.city, value.postal_code, value.street, value.addr_number].map((x) => String(x ?? "").trim()).join("|");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true);
    const t = window.setTimeout(() => {
      locate(value).then((tg) => { if (!alive) return; setBusy(false); setTarget(tg); });
    }, 450);
    return () => { alive = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);

  const cc = matchCountry(value.country) ?? "";
  const feature = lib && cc ? lib.byId.get(cc === "XK" ? "Kosovo" : ISO_NUM.get(cc) ?? "") ?? null : null;
  const point = target && target.level !== "country" ? target : null;

  // nothing yet: the globe turns slowly
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || cc || point || !open) return undefined;
    userMoved.current = false;
    let raf = 0;
    const tick = () => {
      if (!userMoved.current && !map.isMoving()) { const c = map.getCenter(); map.setCenter([c.lng + 0.08, c.lat]); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, cc, point, open]);

  // the country: light it up and fly to it
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.getSource("sel-country")?.setData({ type: "FeatureCollection", features: feature ? [feature] : [] });
    if (point) return;
    const b = feature ? mainBounds(feature) : null;
    const cam = b ? map.cameraForBounds(b, { padding: 50, maxZoom: 6.5 }) : null;
    if (cam) map.flyTo({ ...cam, speed: 0.9, curve: 1.5, essential: true });
    else if (target) map.flyTo({ center: [target.lon, target.lat], zoom: 4, speed: 0.9, curve: 1.5, essential: true });
  }, [ready, feature, point, target]);

  // a place: down to the town or the street, with the pin
  const pKey = point ? `${point.lat},${point.lon},${point.zoom}` : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !lib) return;
    markerRef.current?.remove(); markerRef.current = null;
    if (!point) return;
    markerRef.current = new lib.ml.Marker({ color: point.level === "street" ? "#12b57f" : "#0b3a2b" }).setLngLat([point.lon, point.lat]).addTo(map);
    map.flyTo({ center: [point.lon, point.lat], zoom: Math.min(16.5, point.zoom), speed: 1.1, curve: 1.6, essential: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, lib, pKey]);

  if (!mounted || !box) return null;
  const s = (x?: string | null) => String(x ?? "").trim();
  const crumbs = [
    { k: "world", t: "World", on: true },
    { k: "country", t: cc ? countryName(cc) : s(value.country), on: !!s(value.country) },
    { k: "region", t: s(value.province), on: !!s(value.province) },
    { k: "city", t: [s(value.postal_code), s(value.city)].filter(Boolean).join(" "), on: !!(s(value.city) || s(value.postal_code)) },
    { k: "street", t: [s(value.street), s(value.addr_number)].filter(Boolean).join(" "), on: !!s(value.street) },
  ].filter((c) => c.on);
  const reached = target?.level ?? "world";

  return createPortal(
    <div className={`ag ${open ? "" : "is-hidden"} ${host ? "is-hosted" : ""}`} style={{ left: box.left, top: box.top, width: box.width, height: box.height, ...(host ? { zIndex: 4000 } : {}) }}>
      <div className="ag-map"><div ref={elRef} style={{ width: "100%", height: "100%" }} /></div>
      {!lib && !failed && <div className="ag-loading"><i className="ag-spin" />Loading the map…</div>}
      {failed && (
        <div className="ag-loading">
          <button type="button" onClick={() => setAttempt((a) => a + 1)}>The map could not load · Retry</button>
        </div>
      )}
      <div className="ag-top">
        <span className="ag-eyebrow">
          {busy ? <><i className="ag-spin" />Locating…</> : target ? "Located" : "Where is it?"}
          {cc && <img className="ag-flag" src={`https://flagcdn.com/${cc.toLowerCase()}.svg`} alt="" />}
        </span>
        <div className="ag-crumbs">
          {crumbs.map((c, i) => (
            <span key={c.k} className={`ag-crumb ${c.k === reached ? "is-here" : ""}`} style={{ ["--i" as string]: i } as CSSProperties}>{c.t}</span>
          ))}
        </div>
      </div>
      {target && (
        <div className="ag-foot">
          <span className="ag-coords">{Math.abs(target.lat).toFixed(4)}° {target.lat >= 0 ? "N" : "S"} · {Math.abs(target.lon).toFixed(4)}° {target.lon >= 0 ? "E" : "W"}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}


/**
 * The address block, filling itself in: pick a street and the rest comes with it,
 * type a postal code and the town, province and country appear, pick a town and
 * you get its province and country. Only empty fields (or ones it filled before)
 * are filled on their own; what you typed is never overwritten.
 */
/** The one country picker of the app (contacts, companies, clients, projects): full country names, searchable in
 *  English or Spanish. Saves the ISO code ("ES") or the name ("Spain"), as the record keeps it. */
export function CountryPicker({ value, onChange, as, placeholder = "Choose a country…", size }: {
  value: string | null | undefined; onChange: (v: string) => void; as: "code" | "name"; placeholder?: string; size?: "sm" | "md";
}) {
  const base = useMemo(() => countryList().map((x) => ({ value: x.code, label: x.en, hint: x.es !== x.en ? x.es : undefined })), []);
  const raw = String(value ?? "").trim();
  const code = matchCountry(raw) ?? "";
  // something typed in by an import that isn't a country still shows (and can be replaced)
  const opts = [{ value: "", label: "— Not set" }, ...(raw && !code ? [{ value: `raw:${raw}`, label: `${raw} (as imported)` }] : []), ...base];
  return (
    <Select value={code || (raw ? `raw:${raw}` : "")} options={opts} searchable placeholder={placeholder} size={size} aria-label="Country"
      onChange={(v) => { if (v.startsWith("raw:")) return; onChange(!v ? "" : as === "code" ? v : countryName(v)); }} />
  );
}

export function AddressFields({ value, onChange, countryAs, req, missing, renderCountry, withDetails, globeHost }: {
  value: AddrValue;
  /** Show the map over this panel instead of beside the editor drawer. */
  globeHost?: React.RefObject<HTMLElement | null>;
  /** Required and still empty after a save was tried: shown in red. */
  missing?: (k: AddrKey) => boolean;
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
  // the globe beside the editor: open while the address is being edited
  const addrRef = useRef<HTMLDivElement>(null);
  const [globe, setGlobe] = useState(false);
  const keepGlobe = () => setGlobe(true);
  // the address "zone": its fields, the map itself, the street/town suggestions and the country list
  const inZone = (t: EventTarget | null) => {
    if (!(t instanceof Element)) return false;
    return !!(addrRef.current?.contains(t) || t.closest(".ag, .dw-sugg, .sel-pop"));
  };
  // focus went to something else (Tab, a click on another field…): close at once
  const dropGlobe = (e: React.FocusEvent) => { if (e.relatedTarget && !inZone(e.relatedTarget)) setGlobe(false); };
  // a click anywhere outside the zone, or Esc: close at once (using the map keeps it open)
  useEffect(() => {
    if (!globe) return undefined;
    const down = (e: PointerEvent) => { if (!inZone(e.target)) setGlobe(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".dw-sugg, .sel-pop")) return;
      e.stopPropagation(); setGlobe(false);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globe]);

  const miss = (k: AddrKey) => (missing?.(k) ? "is-missing" : "");
  return (
    <div className="dw-addr" ref={addrRef} onFocus={keepGlobe} onBlur={dropGlobe}>
      <AddressGlobe value={value} anchor={addrRef} open={globe} host={globeHost} />
      <div className="dw-grid is-3">
        <div className={`dw-f dw-col2 ${miss("street")}`}><label>Street{req?.("street")}<span className="dw-f-assist">Type to search</span></label>
          <PlaceInput value={v("street")} onType={(x) => typed("street", x)} onPick={pickStreet} kind="address" auto={auto.has("street")}
            near={{ city: v("city") || undefined, country: value.country || undefined }} placeholder="e.g. Calle de Alcalá 42" />
        </div>
        <div className={`dw-f ${mark("addr_number")} ${miss("addr_number")}`}><label>Number{req?.("addr_number")}</label>
          <input ref={numberRef} value={v("addr_number")} onChange={(e) => typed("addr_number", e.target.value)} placeholder="e.g. 42" />
        </div>
        {withDetails && (
          <div className="dw-f"><label>Details (floor, door…)</label>
            <input value={v("addr_details")} onChange={(e) => typed("addr_details", e.target.value)} placeholder="e.g. 3º B" />
          </div>
        )}
        <div className={`dw-f ${mark("postal_code")} ${miss("postal_code")}`}><label>Postal code{req?.("postal_code")}</label>
          <input value={postal} onChange={(e) => typed("postal_code", e.target.value)} placeholder="e.g. 28014" inputMode="numeric" />
        </div>
        <div className={`dw-f ${miss("city")}`}><label>City{req?.("city")}</label>
          <div onBlur={settleCity}>
            <PlaceInput value={v("city")} onType={(x) => { typed("city", x); setHint(null); }} onPick={pickCity} kind="city" auto={auto.has("city")}
              near={{ country: value.country || undefined }} placeholder="e.g. Madrid" />
          </div>
        </div>
        <div className={`dw-f ${mark("province")} ${miss("province")}`}><label>Province / state{req?.("province")}</label>
          <input value={v("province")} onChange={(e) => typed("province", e.target.value)} placeholder="e.g. Madrid" />
        </div>
        <div className={`dw-f ${withDetails ? "dw-col2" : ""} ${renderCountry ? "" : mark("country")} ${miss("country")}`}><label>Country{req?.("country")}</label>
          {renderCountry ? renderCountry() : <CountryPicker value={v("country")} as={countryAs} onChange={(x) => typed("country", x)} />}
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

// ============================ Filtering & sorting (Companies and Contacts) ============================
//
// Every field of a list is described once (FField): its name, its group, its kind
// and how to read it from a row. Filters (FCond) and sorting work on any of them;
// a view (FView) is the filters + how they combine + the sort, and can be saved.

export type FType = "text" | "number" | "date" | "select" | "multi" | "boolean";
export interface FOpt { value: string; label: string }
export interface FField<T> {
  key: string; label: string; group: string; type: FType;
  /** The value of a row: a string / number / ISO date / boolean, or a list for "multi". */
  get: (r: T) => any;
  /** Choices of a "select" / "multi" field (value → label). */
  options?: () => FOpt[];
  /** What to sort by, when it isn't the value itself. */
  sort?: (r: T) => string | number | null;
}
export interface FCond { id: string; field: string; op: string; text?: string; values?: string[]; min?: string; max?: string }
export interface FSort { key: string; dir: "asc" | "desc" }
export interface FView { match: "all" | "any"; conds: FCond[]; sort: FSort[] }
export const emptyView = (sort: FSort[] = []): FView => ({ match: "all", conds: [], sort });

const FX_OPS: Record<FType, FOpt[]> = {
  text: [{ value: "contains", label: "contains" }, { value: "ncontains", label: "doesn't contain" }, { value: "is", label: "is exactly" }, { value: "starts", label: "starts with" }, { value: "has", label: "has a value" }, { value: "empty", label: "is empty" }],
  number: [{ value: "between", label: "is between" }, { value: "gt", label: "is more than" }, { value: "lt", label: "is less than" }, { value: "eq", label: "equals" }, { value: "has", label: "has a value" }, { value: "empty", label: "is empty" }],
  date: [{ value: "last7", label: "in the last 7 days" }, { value: "last30", label: "in the last 30 days" }, { value: "last90", label: "in the last 90 days" }, { value: "this_month", label: "this month" }, { value: "this_year", label: "this year" },
    { value: "next30", label: "in the next 30 days" }, { value: "before", label: "is before" }, { value: "after", label: "is after" }, { value: "between", label: "is between" }, { value: "has", label: "has a date" }, { value: "empty", label: "has no date" }],
  select: [{ value: "in", label: "is any of" }, { value: "nin", label: "is none of" }, { value: "has", label: "has a value" }, { value: "empty", label: "is empty" }],
  multi: [{ value: "any", label: "includes any of" }, { value: "all", label: "includes all of" }, { value: "none", label: "includes none of" }, { value: "has", label: "has any" }, { value: "empty", label: "has none" }],
  boolean: [{ value: "yes", label: "is yes" }, { value: "no", label: "is no" }],
};
const fxNorm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const fxBlank = (v: any) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
const fxIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Does this condition need a value before it filters anything? */
const fxNeedsValue = (op: string) => !["has", "empty", "yes", "no", "last7", "last30", "last90", "this_month", "this_year", "next30"].includes(op);
const fxReady = (c: FCond) => {
  if (!fxNeedsValue(c.op)) return true;
  if (["in", "nin", "any", "all", "none"].includes(c.op)) return !!c.values?.length;
  if (c.op === "between") return !!(c.min || c.max);
  if (["gt", "lt", "eq", "before", "after"].includes(c.op)) return !!c.min;
  return !!(c.text ?? "").trim();
};

function fxMatch<T>(f: FField<T>, c: FCond, row: T): boolean {
  const v = f.get(row);
  if (c.op === "has") return !fxBlank(v) && v !== false;
  if (c.op === "empty") return fxBlank(v) || v === false;
  switch (f.type) {
    case "text": {
      const s = fxNorm(v), q = fxNorm(c.text);
      if (c.op === "contains") return s.includes(q);
      if (c.op === "ncontains") return !s.includes(q);
      if (c.op === "is") return s === q;
      if (c.op === "starts") return s.startsWith(q);
      return true;
    }
    case "number": {
      if (fxBlank(v) || Number.isNaN(Number(v))) return false;
      const n = Number(v), a = c.min === "" || c.min == null ? null : Number(c.min), b = c.max === "" || c.max == null ? null : Number(c.max);
      if (c.op === "gt") return a == null || n > a;
      if (c.op === "lt") return a == null || n < a;
      if (c.op === "eq") return a == null || n === a;
      return (a == null || n >= a) && (b == null || n <= b);
    }
    case "date": {
      if (fxBlank(v)) return false;
      const d = String(v).slice(0, 10), now = new Date(), y = now.getFullYear(), m = now.getMonth(), day = now.getDate();
      const win: Record<string, [string, string]> = {
        last7: [fxIso(new Date(y, m, day - 7)), fxIso(now)], last30: [fxIso(new Date(y, m, day - 30)), fxIso(now)], last90: [fxIso(new Date(y, m, day - 90)), fxIso(now)],
        this_month: [fxIso(new Date(y, m, 1)), fxIso(new Date(y, m + 1, 0))], this_year: [`${y}-01-01`, `${y}-12-31`], next30: [fxIso(now), fxIso(new Date(y, m, day + 30))],
      };
      if (win[c.op]) return d >= win[c.op][0] && d <= win[c.op][1];
      if (c.op === "before") return !c.min || d < c.min;
      if (c.op === "after") return !c.min || d > c.min;
      return (!c.min || d >= c.min) && (!c.max || d <= c.max);
    }
    case "select": {
      const s = String(v ?? "");
      if (c.op === "in") return (c.values ?? []).includes(s);
      if (c.op === "nin") return !(c.values ?? []).includes(s);
      return true;
    }
    case "multi": {
      const list = (Array.isArray(v) ? v : fxBlank(v) ? [] : [v]).map(String);
      const want = c.values ?? [];
      if (c.op === "any") return want.some((x) => list.includes(x));
      if (c.op === "all") return want.every((x) => list.includes(x));
      if (c.op === "none") return !want.some((x) => list.includes(x));
      return true;
    }
    case "boolean": return c.op === "yes" ? !!v : !v;
  }
  return true;
}

/** Rows that pass the view's filters, sorted by its sort (unfinished filters are ignored). */
/** One collator for every sort: localeCompare with options builds a new one per comparison (seconds on 25k rows). */
const VIEW_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function applyView<T>(rows: T[], fields: FField<T>[], view: FView, tieBreak?: (a: T, b: T) => number): T[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const conds = view.conds.filter((c) => byKey.has(c.field) && fxReady(c));
  const kept = !conds.length ? rows.slice() : rows.filter((r) => {
    const hits = conds.map((c) => fxMatch(byKey.get(c.field)!, c, r));
    return view.match === "any" ? hits.some(Boolean) : hits.every(Boolean);
  });
  const sorts = view.sort.filter((s) => byKey.has(s.key));
  if (!sorts.length) return tieBreak ? kept.sort(tieBreak) : kept;
  // sort values once per row
  const labelMaps = new Map<string, Map<string, string>>();
  const labelOf = (f: FField<T>, x: any) => {
    if (!f.options) return String(x);
    if (!labelMaps.has(f.key)) labelMaps.set(f.key, new Map(f.options().map((o) => [o.value, o.label])));
    return labelMaps.get(f.key)!.get(String(x)) ?? String(x);
  };
  const val = (f: FField<T>, r: T): string | number | null => {
    if (f.sort) return f.sort(r);
    const v = f.get(r);
    if (fxBlank(v)) return null;
    if (f.type === "number") return Number.isNaN(Number(v)) ? null : Number(v);
    if (f.type === "boolean") return v ? 1 : 0;
    if (f.type === "multi") return (Array.isArray(v) ? v : [v]).map((x) => labelOf(f, x)).sort().join(", ");
    if (f.type === "select") return labelOf(f, v);
    return String(v);
  };
  const cache = new Map<T, (string | number | null)[]>();
  kept.forEach((r) => cache.set(r, sorts.map((s) => val(byKey.get(s.key)!, r))));
  return kept.sort((a, b) => {
    const va = cache.get(a)!, vb = cache.get(b)!;
    for (let i = 0; i < sorts.length; i++) {
      const x = va[i], y = vb[i];
      if (x === y) continue;
      if (x == null) return 1;           // empty values always last
      if (y == null) return -1;
      const r = typeof x === "number" && typeof y === "number" ? x - y : VIEW_COLLATOR.compare(String(x), String(y));
      if (r) return sorts[i].dir === "desc" ? -r : r;
    }
    return tieBreak ? tieBreak(a, b) : 0;
  });
}

/** Click a column header: sort by it (asc → desc → off). Shift-click adds it as a further sort. */
export function nextSort(sort: FSort[], key: string, add: boolean): FSort[] {
  const cur = sort.find((s) => s.key === key);
  const flip: FSort | null = !cur ? { key, dir: "asc" } : cur.dir === "asc" ? { key, dir: "desc" } : null;
  if (add) return flip ? (cur ? sort.map((s) => (s.key === key ? flip : s)) : [...sort, flip]) : sort.filter((s) => s.key !== key);
  return flip ? [flip] : [];
}

/** A column header that sorts the list. */
export function SortHead({ label, k, sort, onSort, className, title }: { label: ReactNode; k: string; sort: FSort[]; onSort: (key: string, add: boolean) => void; className?: string; title?: string }) {
  const i = sort.findIndex((s) => s.key === k);
  const s = sort[i];
  return (
    <button type="button" className={`fx-sort ${s ? `is-${s.dir}` : ""} ${className ?? ""}`} title={title ?? "Click to sort · Shift-click to sort by several columns"}
      onClick={(e) => onSort(k, e.shiftKey)} aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : "none"}>
      <span>{label}</span>
      <i aria-hidden="true">
        <svg viewBox="0 0 12 16"><path className="fx-up" d="M6 1l4 5H2z" /><path className="fx-down" d="M6 15l4-5H2z" /></svg>
        {s && sort.length > 1 && <b>{i + 1}</b>}
      </i>
    </button>
  );
}

const fxUid = () => Math.random().toString(36).slice(2, 9);
function fxSummary<T>(f: FField<T>, c: FCond): string {
  const op = FX_OPS[f.type].find((o) => o.value === c.op)?.label ?? c.op;
  if (!fxNeedsValue(c.op)) return op;
  if (c.values) {
    const opts = f.options?.() ?? [];
    const names = c.values.map((v) => opts.find((o) => o.value === v)?.label ?? v);
    return `${op} ${names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ") || "…"}`;
  }
  const d = (x?: string) => (x && f.type === "date" ? new Date(x).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : x);
  if (c.op === "between") return `${op} ${d(c.min) || "…"} and ${d(c.max) || "…"}`;
  if (c.min != null) return `${op} ${d(c.min) || "…"}`;
  return `${op} “${c.text ?? ""}”`;
}

/** Checkbox list with a search box, for "is any of" values. */
function FxValues({ options, values, onChange }: { options: FOpt[]; values: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const n = fxNorm(q);
  const list = n ? options.filter((o) => fxNorm(o.label).includes(n)) : options;
  const toggle = (v: string) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  return (
    <div className="fx-vals">
      {options.length > 7 && <input className="fx-vals-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${options.length}…`} />}
      <div className="fx-vals-list">
        {list.slice(0, 200).map((o) => (
          <label key={o.value} className={values.includes(o.value) ? "is-on" : ""}>
            <input type="checkbox" checked={values.includes(o.value)} onChange={() => toggle(o.value)} />
            <i aria-hidden="true">✓</i><span>{o.label}</span>
          </label>
        ))}
        {!list.length && <p className="fx-vals-none">{options.length ? "No matches" : "No values yet"}</p>}
      </div>
      {values.length > 0 && <button type="button" className="fx-vals-clear" onClick={() => onChange([])}>Clear {values.length} selected</button>}
    </div>
  );
}

/** One filter row: field · how · value. */
function FxRow<T>({ c, f, onChange, onRemove, onPickField, i }: { c: FCond; f: FField<T>; onChange: (c: FCond) => void; onRemove: () => void; onPickField: () => void; i: number }) {
  const set = (p: Partial<FCond>) => onChange({ ...c, ...p });
  const setOp = (op: string) => {
    const multi = ["in", "nin", "any", "all", "none"].includes(op);
    onChange({ id: c.id, field: c.field, op, ...(multi ? { values: c.values ?? [] } : {}), ...(op === "between" || ["gt", "lt", "eq", "before", "after"].includes(op) ? { min: c.min ?? "", max: op === "between" ? c.max ?? "" : undefined } : {}), ...(f.type === "text" ? { text: c.text ?? "" } : {}) });
  };
  const multi = ["in", "nin", "any", "all", "none"].includes(c.op);
  return (
    <div className={`fx-row ${fxReady(c) ? "" : "is-unready"}`} style={{ ["--i" as string]: i } as CSSProperties}>
      <div className="fx-row-top">
        <button type="button" className="fx-field" onClick={onPickField} title="Change the field"><em>{f.group}</em>{f.label}</button>
        <Select size="sm" className="fx-op" value={c.op} onChange={setOp} options={FX_OPS[f.type]} />
        {f.type === "text" && fxNeedsValue(c.op) && <input className="fx-in" autoFocus value={c.text ?? ""} onChange={(e) => set({ text: e.target.value })} placeholder="Type…" />}
        {f.type === "number" && fxNeedsValue(c.op) && (
          <span className="fx-pair">
            <input className="fx-in is-num" type="number" value={c.min ?? ""} onChange={(e) => set({ min: e.target.value })} placeholder={c.op === "between" ? "From" : "Value"} />
            {c.op === "between" && <><span>and</span><input className="fx-in is-num" type="number" value={c.max ?? ""} onChange={(e) => set({ max: e.target.value })} placeholder="To" /></>}
          </span>
        )}
        {f.type === "date" && ["before", "after", "between"].includes(c.op) && (
          <span className="fx-pair is-date">
            <DatePicker value={c.min ?? ""} onChange={(d) => set({ min: d })} placeholder={c.op === "between" ? "From" : "Date"} />
            {c.op === "between" && <><span>and</span><DatePicker value={c.max ?? ""} onChange={(d) => set({ max: d })} placeholder="To" /></>}
          </span>
        )}
        <button type="button" className="fx-x" onClick={onRemove} aria-label="Remove this filter">×</button>
      </div>
      {multi && <FxValues options={f.options?.() ?? []} values={c.values ?? []} onChange={(values) => set({ values })} />}
    </div>
  );
}

/** Searchable, grouped list of fields. */
function FxFieldPicker<T>({ fields, onPick, onCancel }: { fields: FField<T>[]; onPick: (f: FField<T>) => void; onCancel?: () => void }) {
  const [q, setQ] = useState("");
  const n = fxNorm(q);
  const list = n ? fields.filter((f) => fxNorm(`${f.label} ${f.group}`).includes(n)) : fields;
  const groups = [...new Set(list.map((f) => f.group))];
  return (
    <div className="fx-pick">
      <div className="fx-pick-q">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter by… (${fields.length} fields)`}
          onKeyDown={(e) => { if (e.key === "Enter" && list[0]) onPick(list[0]); if (e.key === "Escape") { e.stopPropagation(); onCancel?.(); } }} />
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
      <div className="fx-pick-list">
        {groups.map((g) => (
          <div key={g} className="fx-pick-g">
            <span>{g}</span>
            <div>
              {list.filter((f) => f.group === g).map((f) => (
                <button type="button" key={f.key} onClick={() => onPick(f)}><i data-t={f.type} />{f.label}</button>
              ))}
            </div>
          </div>
        ))}
        {!list.length && <p className="fx-vals-none">No field matches “{q}”</p>}
      </div>
    </div>
  );
}

export interface SavedView { name: string; view: FView }

/**
 * The filter bar: a "Filters" button opening the builder, the active filters as
 * chips under the header, a live counter, and saved views.
 */
export function FilterBar<T>({ fields, view, onView, total, shown, noun, saved, onSaved, openSignal }: {
  fields: FField<T>[]; view: FView; onView: (v: FView) => void;
  total: number; shown: number; noun: [string, string];
  saved: SavedView[]; onSaved: (list: SavedView[]) => void;
  /** Changes when something outside (a chip) asks to open the builder. */
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<string | null>(null); // "new" or the id of the filter whose field changes
  const [viewsOpen, setViewsOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const vbtn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const vpanel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [vpos, setVpos] = useState<{ top: number; left: number } | null>(null);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const conds = view.conds.filter((c) => byKey.has(c.field));
  const active = conds.filter(fxReady);

  useLayoutEffect(() => {
    if (!open && !viewsOpen) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r && open) { const width = Math.min(620, window.innerWidth - 24); setPos({ top: r.bottom + 8, left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)), width }); }
      const v = vbtn.current?.getBoundingClientRect();
      if (v && viewsOpen) setVpos({ top: v.bottom + 8, left: Math.max(12, Math.min(v.left, window.innerWidth - 300)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, viewsOpen]);
  useEffect(() => {
    if (!open && !viewsOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if ((t as Element).closest?.(".dp-pop, .dp-layer, .sel-pop, .sel-layer")) return; // a date picker opened from a filter
      if (open && !panel.current?.contains(t) && !btn.current?.contains(t)) { setOpen(false); setPicking(null); }
      if (viewsOpen && !vpanel.current?.contains(t) && !vbtn.current?.contains(t)) { setViewsOpen(false); setNaming(null); }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setViewsOpen(false); setPicking(null); } };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open, viewsOpen]);

  const setConds = (cs: FCond[]) => onView({ ...view, conds: cs });
  const firstOp = (f: FField<T>) => FX_OPS[f.type][0].value;
  const newCond = (f: FField<T>): FCond => {
    const op = firstOp(f);
    return { id: fxUid(), field: f.key, op, ...(["in", "any"].includes(op) ? { values: [] } : {}), ...(f.type === "number" ? { min: "", max: "" } : {}), ...(f.type === "text" ? { text: "" } : {}) };
  };
  const pick = (f: FField<T>) => {
    if (picking === "new") setConds([...view.conds, newCond(f)]);
    else if (picking) setConds(view.conds.map((c) => (c.id === picking ? { ...newCond(f), id: c.id } : c)));
    setPicking(null);
  };
  const openBuilder = (addFirst = false) => { setOpen(true); setViewsOpen(false); setPicking(addFirst || !conds.length ? "new" : null); };
  const clear = () => onView({ ...view, conds: [] });
  useEffect(() => { if (openSignal) { setOpen(true); setViewsOpen(false); setPicking(null); } }, [openSignal]);
  const sameView = (a: FView, b: FView) => JSON.stringify([a.match, a.conds, a.sort]) === JSON.stringify([b.match, b.conds, b.sort]);
  const current = saved.find((s) => sameView(s.view, view));

  return (
    <>
      <div className="fx-tools">
        <button ref={btn} type="button" className={`fx-btn ${open ? "is-open" : ""} ${active.length ? "is-active" : ""}`} onClick={() => (open ? setOpen(false) : openBuilder())}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18l-7 8v6l-4 2v-8z" /></svg>
          Filters{active.length > 0 && <b>{active.length}</b>}
        </button>
        <button ref={vbtn} type="button" className={`fx-btn is-views ${viewsOpen ? "is-open" : ""}`} onClick={() => { setViewsOpen((x) => !x); setOpen(false); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
          {current ? current.name : "Views"}{saved.length > 0 && !current && <em>{saved.length}</em>}
        </button>
      </div>

      {open && pos && createPortal(
        <div ref={panel} className="fx-panel" style={{ top: pos.top, left: pos.left, width: pos.width }} role="dialog" aria-label="Filters">
          <header className="fx-panel-h">
            <b>Filters</b>
            {conds.length > 1 && (
              <span className="fx-match">
                Show {noun[1]} that match
                <span className="fx-seg">
                  <button type="button" className={view.match === "all" ? "is-on" : ""} onClick={() => onView({ ...view, match: "all" })}>all</button>
                  <button type="button" className={view.match === "any" ? "is-on" : ""} onClick={() => onView({ ...view, match: "any" })}>any</button>
                </span>
                of these
              </span>
            )}
            <span className="fx-count"><b>{shown.toLocaleString("en-GB")}</b> of {total.toLocaleString("en-GB")}</span>
          </header>
          <div className="fx-panel-b">
            {conds.map((c, i) => {
              const f = byKey.get(c.field)!;
              return picking === c.id ? <FxFieldPicker key={c.id} fields={fields} onPick={pick} onCancel={() => setPicking(null)} /> : (
                <div key={c.id} className="fx-row-wrap">
                  {i > 0 && <span className="fx-join">{view.match === "all" ? "and" : "or"}</span>}
                  <FxRow c={c} f={f} i={i} onChange={(nc) => setConds(view.conds.map((x) => (x.id === c.id ? nc : x)))}
                    onRemove={() => setConds(view.conds.filter((x) => x.id !== c.id))} onPickField={() => setPicking(c.id)} />
                </div>
              );
            })}
            {picking === "new" ? (
              <FxFieldPicker fields={fields} onPick={pick} onCancel={conds.length ? () => setPicking(null) : undefined} />
            ) : (
              <button type="button" className="fx-add" onClick={() => setPicking("new")}>+ Add a filter</button>
            )}
          </div>
          <footer className="fx-panel-f">
            {conds.length > 0 && <button type="button" className="fx-link" onClick={clear}>Clear all</button>}
            <span />
            {active.length > 0 && <button type="button" className="fx-link" onClick={() => { setViewsOpen(true); setOpen(false); setNaming(""); }}>Save as a view…</button>}
            <button type="button" className="fx-done" onClick={() => setOpen(false)}>Show {shown.toLocaleString("en-GB")} {shown === 1 ? noun[0] : noun[1]}</button>
          </footer>
        </div>,
        document.body,
      )}

      {viewsOpen && vpos && createPortal(
        <div ref={vpanel} className="fx-views" style={{ top: vpos.top, left: vpos.left }}>
          <span className="fx-views-k">Saved views</span>
          <button type="button" className={`fx-view ${!conds.length && !view.sort.length ? "is-on" : ""}`} onClick={() => { onView(emptyView()); setViewsOpen(false); }}>
            <b>Everything</b><small>No filters</small>
          </button>
          {saved.map((s, i) => (
            <div key={s.name + i} className={`fx-view ${current === s ? "is-on" : ""}`}>
              <button type="button" onClick={() => { onView(s.view); setViewsOpen(false); }}>
                <b>{s.name}</b><small>{s.view.conds.length} {s.view.conds.length === 1 ? "filter" : "filters"}{s.view.sort.length ? " · sorted" : ""}</small>
              </button>
              <button type="button" className="fx-view-x" aria-label={`Delete ${s.name}`} onClick={() => onSaved(saved.filter((x) => x !== s))}>×</button>
            </div>
          ))}
          {naming !== null ? (
            <form className="fx-name" onSubmit={(e) => { e.preventDefault(); const n = naming.trim(); if (!n) return; onSaved([...saved.filter((x) => x.name !== n), { name: n, view }]); setNaming(null); }}>
              <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="e.g. Clients in Madrid" />
              <button type="submit" disabled={!naming.trim()}>Save</button>
            </form>
          ) : (
            <button type="button" className="fx-add" disabled={!active.length && !view.sort.length} onClick={() => setNaming("")}>
              {active.length || view.sort.length ? "+ Save what's on screen" : "Add filters to save a view"}
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

/** The active filters as chips (click one to edit, × to drop it). */
export function FilterChips<T>({ fields, view, onView, onEdit, shown, total, noun }: {
  fields: FField<T>[]; view: FView; onView: (v: FView) => void; onEdit: () => void; shown: number; total: number; noun: [string, string];
}) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const active = view.conds.filter((c) => byKey.has(c.field) && fxReady(c));
  const all = view.sort.filter((s) => byKey.has(s.key));
  // the usual A → Z by name needs no chip
  const sorted = all.length === 1 && all[0].key === "name" && all[0].dir === "asc" ? [] : all;
  if (!active.length && !sorted.length) return null;
  return (
    <div className="fx-chips">
      <span className="fx-chips-n"><b>{shown.toLocaleString("en-GB")}</b> of {total.toLocaleString("en-GB")} {total === 1 ? noun[0] : noun[1]}</span>
      {active.map((c, i) => {
        const f = byKey.get(c.field)!;
        return (
          <span key={c.id} className="fx-chip" style={{ ["--i" as string]: i } as CSSProperties}>
            {i > 0 && <em>{view.match === "all" ? "and" : "or"}</em>}
            <button type="button" onClick={onEdit}><b>{f.label}</b> {fxSummary(f, c)}</button>
            <button type="button" className="fx-chip-x" aria-label="Remove" onClick={() => onView({ ...view, conds: view.conds.filter((x) => x.id !== c.id) })}>×</button>
          </span>
        );
      })}
      {sorted.length > 0 && (
        <span className="fx-chip is-sort">
          <button type="button" onClick={() => onView({ ...view, sort: [] })} title="Click to remove the sort">
            Sorted by {sorted.map((s) => `${byKey.get(s.key)!.label} ${s.dir === "asc" ? "↑" : "↓"}`).join(", then ")}
          </button>
          <button type="button" className="fx-chip-x" aria-label="Remove sort" onClick={() => onView({ ...view, sort: [] })}>×</button>
        </span>
      )}
      {active.length > 0 && <button type="button" className="fx-chips-clear" onClick={() => onView({ ...view, conds: [] })}>Clear filters</button>}
    </div>
  );
}

/** Saved views kept per person (profiles.prefs). */
export function useSavedViews(prefKey: string): [SavedView[], (list: SavedView[]) => void] {
  const [list, setList] = useState<SavedView[]>([]);
  useEffect(() => { loadPrefs().then((p) => { if (Array.isArray(p[prefKey])) setList(p[prefKey]); }).catch(() => {}); }, [prefKey]);
  const save = (next: SavedView[]) => { setList(next); savePref(prefKey, next).catch(() => {}); };
  return [list, save];
}
/** The current filters + sort, remembered on this browser between visits. */
export function useStoredView(storeKey: string, initial: FView): [FView, (v: FView) => void] {
  const [view, setView] = useState<FView>(() => {
    try { const raw = localStorage.getItem(storeKey); if (raw) { const v = JSON.parse(raw); if (v && Array.isArray(v.conds) && Array.isArray(v.sort)) return { match: v.match === "any" ? "any" : "all", conds: v.conds, sort: v.sort }; } } catch { /* no storage */ }
    return initial;
  });
  const set = (v: FView) => { setView(v); try { localStorage.setItem(storeKey, JSON.stringify(v)); } catch { /* no storage */ } };
  return [view, set];
}

/* =====================================================================
   Multi-select for lists (deals, contacts…): pick rows, then act on all
   of them from a bar that floats over the bottom of the page.
   ===================================================================== */
export interface BulkAction {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Pick one of these first (a pipeline, a company, a person…). `group` puts a heading over a run of options. */
  options?: { value: string; label: string; hint?: string; group?: string }[];
  /** Type a value first instead: a date or a percentage. */
  input?: "date" | "percent";
  /** Ask "Sure?" before running (deleting). */
  danger?: boolean;
  /** Shown instead of running, e.g. no permission. */
  disabledReason?: string;
  /** Tucked under "More" so the bar stays short. */
  more?: boolean;
  /** A second question once an option is picked (e.g. which phase of the chosen pipeline). */
  next?: (value: string) => { title: string; options: { value: string; label: string; hint?: string; group?: string }[] } | null;
  /** Returns an error text, or { done } with what happened. `sub` is the answer to `next`. */
  run: (value?: string, sub?: string) => Promise<string | null | void | { done: string }> | string | null | void | { done: string };
}

/** Runs `fn` over the items a few at a time (fast without flooding the connection); returns how many went fine and the first error. */
export async function inPool<T>(items: T[], fn: (x: T) => Promise<unknown>, size = 6): Promise<{ ok: number; error: string | null }> {
  let ok = 0, error: string | null = null, i = 0;
  const worker = async () => {
    while (i < items.length) {
      const x = items[i++];
      try {
        const r = await fn(x);
        if (typeof r === "string" && r) { error ??= r; } else ok++;
      } catch (e: any) { error ??= e?.message ?? String(e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return { ok, error };
}

export function useBulkSelection(order: string[]) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const last = useRef<string | null>(null);
  // Rows that left the list (filtered out, deleted) drop out of the selection.
  useEffect(() => {
    setSel((cur) => {
      if (!cur.size) return cur;
      const keep = new Set(order);
      const next = new Set([...cur].filter((id) => keep.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [order]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string, range = false) => {
    setSel((cur) => {
      const next = new Set(cur);
      if (range && last.current && order.includes(last.current)) {
        const a = order.indexOf(last.current), b = order.indexOf(id);
        const [from, to] = a < b ? [a, b] : [b, a];
        order.slice(from, to + 1).forEach((x) => next.add(x));
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    last.current = id;
  };
  const allOn = order.length > 0 && sel.size >= order.length && order.every((id) => sel.has(id));
  const toggleAll = () => setSel(allOn ? new Set() : new Set(order));
  // an empty selection stays the same object: clearing nothing (Esc anywhere) must not re-render every row
  const clear = () => setSel((cur) => (cur.size ? new Set() : cur));
  return { sel, ids: [...sel], has: (id: string) => sel.has(id), toggle, toggleAll, allOn, someOn: sel.size > 0 && !allOn, clear, active: sel.size > 0 };
}

/** The round tick used on rows and in the list header. */
export function BulkCheck({ on, partial, onToggle, label }: { on: boolean; partial?: boolean; onToggle: (e: React.MouseEvent) => void; label: string }) {
  return (
    <span role="checkbox" aria-checked={partial ? "mixed" : on} aria-label={label} tabIndex={0}
      className={`bk-check ${on ? "is-on" : ""} ${partial ? "is-partial" : ""}`}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggle(e); }}
      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.stopPropagation(); e.preventDefault(); onToggle(e as any); } }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
        {partial ? <path d="M6 12h12" /> : <path d="M5 12.5l4.5 4.5L19 7.5" />}
      </svg>
    </span>
  );
}

export function BulkBar({ count, noun, actions, onClear, onSelectAll, allOn, total }: {
  count: number; noun: [string, string]; actions: BulkAction[]; onClear: () => void; onSelectAll?: () => void; allOn?: boolean; total?: number;
}) {
  const [open, setOpen] = useState<string | null>(null);   // an action's picker, or "__more"
  const [armed, setArmed] = useState<{ key: string; value?: string } | null>(null);
  // the second question of an action (e.g. the phase, once the pipeline is picked)
  const [step2, setStep2] = useState<{ key: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [val, setVal] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(null); setArmed(null); setStep2(null); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { if (step2) setStep2(null); else if (open || armed) { setOpen(null); setArmed(null); } else onClear(); } };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, armed, step2, onClear]);
  useEffect(() => { if (!msg) return; const t = window.setTimeout(() => setMsg(null), 4000); return () => window.clearTimeout(t); }, [msg]);
  if (count === 0 && !msg) return null;

  const go = async (a: BulkAction, value?: string, sub?: string) => {
    if (a.disabledReason) { setMsg({ ok: false, text: a.disabledReason }); setOpen(null); return; }
    // an action with a second question asks it first
    if (a.next && value != null && sub == null && a.next(value)) { setStep2({ key: a.key, value }); setQ(""); return; }
    if (a.danger && (!armed || armed.key !== a.key || armed.value !== value)) { setArmed({ key: a.key, value }); setOpen(null); return; }
    setArmed(null); setOpen(null); setStep2(null); setBusy(a.key);
    try {
      const r = await a.run(value, sub);
      if (r && typeof r === "object") setMsg({ ok: true, text: r.done });
      else if (r) setMsg({ ok: false, text: r });
      else setMsg({ ok: true, text: "Done" });
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? String(e) }); }
    setBusy(null);
  };
  const openPicker = (a: BulkAction) => {
    if (a.disabledReason) { setMsg({ ok: false, text: a.disabledReason }); setOpen(null); return; }
    if (a.options || a.input) { setOpen(open === a.key ? null : a.key); setQ(""); setVal(""); setStep2(null); } else void go(a);
  };
  const main = actions.filter((a) => !a.more), extra = actions.filter((a) => a.more);
  const current = actions.find((a) => a.key === open);

  const picker = (a: BulkAction) => {
    const second = step2?.key === a.key && a.next ? a.next(step2.value) : null;
    if (second) {
      const first = a.options?.find((o) => o.value === step2!.value);
      return (
        <div className="bk-pop is-step2" role="dialog" aria-label={second.title}>
          <p className="bk-pop-title">
            <button type="button" className="bk-pop-back" onClick={() => setStep2(null)} aria-label="Back">‹</button>
            {second.title}
          </p>
          {first && <p className="bk-pop-crumb">{a.label}: <b>{first.label}</b> · {count} {count === 1 ? noun[0] : noun[1]}</p>}
          {second.options.length > 7 && <input className="bk-pop-q" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />}
          <div className="bk-pop-list">
            {second.options.filter((o) => !q || `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q.toLowerCase())).map((o, i, arr) => (
              <div key={o.value} className="bk-pop-row">
                {o.group && o.group !== arr[i - 1]?.group && <span className="bk-pop-group">{o.group}</span>}
                <button type="button" role="option" className="bk-pop-opt" onClick={() => void go(a, step2!.value, o.value)}>
                  <span>{o.label}</span>{o.hint && <small>{o.hint}</small>}
                </button>
              </div>
            ))}
            {second.options.length === 0 && <p className="bk-pop-empty">Nothing to pick</p>}
          </div>
        </div>
      );
    }
    return (
    <div className="bk-pop" role="dialog" aria-label={a.label}>
      <p className="bk-pop-title">{a.label} · {count} {count === 1 ? noun[0] : noun[1]}</p>
      {a.input ? (
        <form className="bk-pop-input" onSubmit={(e) => { e.preventDefault(); if (val !== "") void go(a, val); }}>
          {a.input === "date"
            ? <input type="date" autoFocus value={val} onChange={(e) => setVal(e.target.value)} />
            : <span className="bk-pop-pct"><input type="number" min={0} max={100} step={5} autoFocus value={val} onChange={(e) => setVal(e.target.value)} placeholder="0–100" /><em>%</em></span>}
          <button type="submit" disabled={val === ""}>Apply</button>
          <button type="button" className="is-clear" onClick={() => void go(a, "")}>Clear it</button>
        </form>
      ) : (
        <>
          {(a.options?.length ?? 0) > 7 && <input className="bk-pop-q" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />}
          <div className="bk-pop-list">
            {(a.options ?? []).filter((o) => !q || `${o.label} ${o.hint ?? ""} ${o.group ?? ""}`.toLowerCase().includes(q.toLowerCase())).map((o, i, arr) => (
              <div key={o.value} className="bk-pop-row">
                {o.group && o.group !== arr[i - 1]?.group && <span className="bk-pop-group">{o.group}</span>}
                <button type="button" role="option" className="bk-pop-opt" onClick={() => void go(a, o.value)}>
                  <span>{o.label}</span>{o.hint && <small>{o.hint}</small>}
                </button>
              </div>
            ))}
            {(a.options?.length ?? 0) === 0 && <p className="bk-pop-empty">Nothing to pick</p>}
          </div>
        </>
      )}
    </div>
    );
  };

  return createPortal(
    <div className="bk-bar" ref={ref} role="toolbar" aria-label="Selected items">
      {count > 0 && (
        <>
          <span className="bk-count"><b>{count}</b> {count === 1 ? noun[0] : noun[1]} selected</span>
          {onSelectAll && !allOn && <button type="button" className="bk-link" onClick={onSelectAll}>Select all{total ? ` ${total}` : ""}</button>}
          <span className="bk-sep" />
          {main.map((a) => {
            const isArmed = armed?.key === a.key;
            return (
              <div className="bk-act-wrap" key={a.key}>
                <button type="button" className={`bk-act ${a.danger ? "is-danger" : ""} ${isArmed ? "is-armed" : ""} ${a.disabledReason ? "is-off" : ""} ${open === a.key ? "is-open" : ""}`}
                  disabled={busy !== null} title={a.disabledReason}
                  onClick={() => (isArmed ? void go(a, armed?.value) : openPicker(a))}>
                  {busy === a.key ? <i className="bk-spin" /> : a.icon}
                  {isArmed ? `Sure? ${a.label} ${count}` : a.label}
                  {(a.options || a.input) && !isArmed && <svg className="bk-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>}
                </button>
                {open === a.key && picker(a)}
              </div>
            );
          })}
          {extra.length > 0 && (
            <div className="bk-act-wrap">
              <button type="button" className={`bk-act ${open === "__more" || (current?.more ?? false) ? "is-open" : ""} ${armed && extra.some((a) => a.key === armed.key) ? "is-armed" : ""}`}
                disabled={busy !== null}
                onClick={() => {
                  const ar = armed && extra.find((a) => a.key === armed.key);
                  if (ar) { void go(ar, armed!.value); return; }
                  setOpen(open === "__more" || current?.more ? null : "__more");
                }}>
                {busy && extra.some((a) => a.key === busy) ? <i className="bk-spin" /> : <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>}
                {armed && extra.some((a) => a.key === armed.key) ? `Sure? ${extra.find((a) => a.key === armed!.key)!.label} ${count}` : "More"}
              </button>
              {open === "__more" && (
                <div className="bk-pop bk-more" role="menu">
                  {extra.map((a) => (
                    <button type="button" role="menuitem" key={a.key} className={`bk-more-opt ${a.danger ? "is-danger" : ""} ${a.disabledReason ? "is-off" : ""}`}
                      title={a.disabledReason} onClick={() => openPicker(a)}>
                      <span className="bk-more-ico">{a.icon}</span>
                      <span>{a.label}</span>
                      {(a.options || a.input) && <svg className="bk-more-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>}
                    </button>
                  ))}
                </div>
              )}
              {current?.more && picker(current)}
            </div>
          )}
          <button type="button" className="bk-x" onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)">×</button>
        </>
      )}
      {msg && <span className={`bk-msg ${msg.ok ? "is-ok" : "is-err"}`}>{msg.text}</span>}
    </div>,
    document.body,
  );
}

/* =====================================================================
   Data clean-up: names and addresses imported before the importer could
   tell them apart. Finds what looks wrong, shows before → after, and fixes
   only what you leave ticked.
   ===================================================================== */
type CleanKind = "people" | "companies" | "addresses";
interface CleanFix { id: string; kind: CleanKind; entity: "contact" | "company"; who: string; before: string; after: string; sure: boolean; base: any; patch: Record<string, any> }

export function DataCleanup({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [fixes, setFixes] = useState<CleanFix[] | null>(null);
  const [tab, setTab] = useState<CleanKind>("people");
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ ok: number; failed: string[] } | null>(null);

  useEffect(() => {
    (async () => {
      const { dedupePersonName, splitCompanyNames, splitStreetNumber } = await import("../sales/extras/dealImportEngine");
      const [contacts, companies] = await Promise.all([listContacts().catch(() => []), listCompanies().catch(() => [])]);
      const out: CleanFix[] = [];
      const fn = (f?: string | null, l?: string | null) => [f, l].filter(Boolean).join(" ") || "—";
      contacts.forEach((c) => {
        const dd = dedupePersonName(c.first_name, c.last_name);
        if (dd) out.push({
          id: `p:${c.id}`, kind: "people", entity: "contact", who: fn(c.first_name, c.last_name), sure: dd.sure,
          before: `${c.first_name} · ${c.last_name}`, after: `${dd.first} · ${dd.last ?? ""}`,
          base: c, patch: { first_name: dd.first, last_name: dd.last },
        });
        const sp = !c.addr_number ? splitStreetNumber(c.street) : null;
        if (sp) out.push({
          id: `a:c:${c.id}`, kind: "addresses", entity: "contact", who: fn(c.first_name, c.last_name), sure: true,
          before: c.street ?? "", after: `${sp.street} · nº ${sp.number}${sp.details ? ` · ${sp.details}` : ""}`,
          // contacts have no floor/door field: it stays with the street
          base: c, patch: { street: sp.details ? `${sp.street}, ${sp.details}` : sp.street, addr_number: sp.number },
        });
      });
      companies.forEach((co) => {
        const nm = splitCompanyNames(co.name, co.legal_name);
        if (nm.name && (nm.name !== co.name || (nm.legal ?? "") !== (co.legal_name ?? ""))) out.push({
          id: `n:${co.id}`, kind: "companies", entity: "company", who: co.name, sure: true,
          before: `${co.name}${co.legal_name ? ` · legal: ${co.legal_name}` : " · no legal name"}`,
          after: `${nm.name} · legal: ${nm.legal ?? "—"}`,
          base: co, patch: { name: nm.name, legal_name: nm.legal },
        });
        const sp = !co.addr_number ? splitStreetNumber(co.street) : null;
        if (sp) out.push({
          id: `a:o:${co.id}`, kind: "addresses", entity: "company", who: co.name, sure: true,
          before: co.street ?? "", after: `${sp.street} · nº ${sp.number}${sp.details ? ` · ${sp.details}` : ""}`,
          base: co, patch: { street: sp.street, addr_number: sp.number, addr_details: co.addr_details || sp.details },
        });
      });
      setFixes(out);
      // the less sure ones start unticked
      setOff(new Set(out.filter((f) => !f.sure).map((f) => f.id)));
      const first = (["people", "companies", "addresses"] as CleanKind[]).find((k) => out.some((f) => f.kind === k));
      if (first) setTab(first);
    })();
  }, []);

  const list = (fixes ?? []).filter((f) => f.kind === tab);
  const count = (k: CleanKind) => (fixes ?? []).filter((f) => f.kind === k).length;
  const picked = (fixes ?? []).filter((f) => !off.has(f.id));
  const allOn = list.length > 0 && list.every((f) => !off.has(f.id));
  const flip = (id: string) => setOff((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const flipAll = () => setOff((s) => { const n = new Set(s); list.forEach((f) => (allOn ? n.add(f.id) : n.delete(f.id))); return n; });

  const apply = async () => {
    // Fixes on the same contact or company are saved together, in one go.
    const byEntity = new Map<string, { f: CleanFix; patch: Record<string, any>; n: number }>();
    picked.forEach((f) => {
      const k = `${f.entity}:${f.base.id}`;
      const cur = byEntity.get(k);
      if (cur) { Object.assign(cur.patch, f.patch); cur.n++; } else byEntity.set(k, { f, patch: { ...f.patch }, n: 1 });
    });
    const todo = [...byEntity.values()];
    setBusy({ done: 0, total: todo.length });
    let ok = 0; const failed: string[] = [];
    for (let i = 0; i < todo.length; i++) {
      const { f, patch, n } = todo[i];
      const row = { ...f.base, ...patch };
      const err = await (f.entity === "contact" ? saveContact(row) : saveCompany(row)).catch((e: any) => e?.message ?? "Failed");
      if (err) failed.push(`${f.who}: ${err}`); else ok += n;
      setBusy({ done: i + 1, total: todo.length });
    }
    setBusy(null); setResult({ ok, failed });
    onDone();
  };

  const TABS: [CleanKind, string, string][] = [
    ["people", "Contact names", "The surname repeated in the first name"],
    ["companies", "Company names", "Legal form (S.L., S.A.…) moved to the legal name"],
    ["addresses", "Addresses", "Street and number split apart"],
  ];

  return (
    <div className="dw-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="dw dc-cl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Clean up data">
        <div className="dw-head">
          <div>
            <span className="dw-eyebrow">Data quality</span>
            <h2 className="dw-title">Clean up names and addresses</h2>
          </div>
          <button className="dw-x" onClick={onClose} disabled={!!busy}>×</button>
        </div>
        <div className="dw-body">
          {!fixes ? <p className="dc-cl-empty">Looking through your contacts and companies…</p> : result ? (
            <div className="dc-cl-done">
              <b>{result.ok} fixed</b>
              {result.failed.length > 0 && <><span>{result.failed.length} couldn't be saved:</span><ul>{result.failed.slice(0, 20).map((f) => <li key={f}>{f}</li>)}</ul></>}
              <button className="dc-cl-apply" onClick={onClose}>Close</button>
            </div>
          ) : fixes.length === 0 ? <p className="dc-cl-empty">Nothing to fix — names and addresses look clean.</p> : (
            <>
              <div className="dc-cl-tabs" role="tablist">
                {TABS.map(([k, label, hint]) => (
                  <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "is-on" : ""} onClick={() => setTab(k)} disabled={count(k) === 0}>
                    <b>{label}</b><small>{hint}</small><i>{count(k)}</i>
                  </button>
                ))}
              </div>
              <div className="dc-cl-head">
                <BulkCheck on={allOn} partial={!allOn && list.some((f) => !off.has(f.id))} onToggle={flipAll} label="Tick all" />
                <span>{list.filter((f) => !off.has(f.id)).length} of {list.length} ticked</span>
                {list.some((f) => !f.sure) && <em>“Check” ones may be a compound name — left unticked</em>}
              </div>
              <div className="dc-cl-list">
                {list.map((f) => (
                  <div key={f.id} className={`dc-cl-row ${off.has(f.id) ? "is-off" : ""}`} onClick={() => flip(f.id)}>
                    <BulkCheck on={!off.has(f.id)} onToggle={() => flip(f.id)} label={`Fix ${f.who}`} />
                    <span className="dc-cl-who">{f.who}{!f.sure && <i>Check</i>}<small>{f.entity}</small></span>
                    <span className="dc-cl-before">{f.before}</span>
                    <span className="dc-cl-arrow">→</span>
                    <span className="dc-cl-after">{f.after}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        {fixes && fixes.length > 0 && !result && (
          <div className="dc-cl-foot">
            <span>{picked.length} changes across all tabs</span>
            <button className="dc-cl-apply" onClick={apply} disabled={!!busy || picked.length === 0}>
              {busy ? `Saving ${busy.done} / ${busy.total}…` : `Apply ${picked.length} changes`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================ Settings pages (Companies, Contacts, Client page) ============================
export interface DataTool { key: string; title: string; hint: string; icon: ReactNode; tone: string; onOpen: () => void }
/** The data tools of a list (import, export, clean-up…) as a row of cards. */
export function DataTools({ items }: { items: DataTool[] }) {
  return (
    <div className="crm-tools">
      {items.map((t, i) => (
        <button key={t.key} type="button" className="crm-tool" style={{ ["--tone" as string]: t.tone, ["--i" as string]: i } as CSSProperties} onClick={t.onOpen}>
          <span className="crm-tool-ico">{t.icon}</span>
          <span className="crm-tool-txt"><b>{t.title}</b><small>{t.hint}</small></span>
          <svg className="crm-tool-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      ))}
    </div>
  );
}

/**
 * Settings › Companies / Contacts page › Required fields: which built-in fields
 * must be filled in before a company / contact can be saved (the name always is),
 * next to the custom fields' own "Required" switch, so it is all in one place.
 */
export function RequiredFieldsEditor({ scope, custom, onCustomToggle }: {
  scope: ReqScope;
  custom: { id: string; label: string; required: boolean }[];
  onCustomToggle: (id: string, on: boolean) => Promise<unknown>;
}) {
  useRequiredFields();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const all = fixedFieldsOf(scope);
  const groups = [...new Set(all.map((f) => f.group))];
  const flip = async (key: string) => {
    setBusy(key); setErr(null);
    const e = await setFixedRequired(scope, key, !isFixedRequired(scope, key));
    setBusy(null);
    if (e) setErr(e);
  };
  const flipCustom = async (id: string, on: boolean) => {
    setBusy(`c:${id}`); setErr(null);
    try { await onCustomToggle(id, on); } catch (e: any) { setErr(e?.message ?? "Could not save."); }
    setBusy(null);
  };
  const noun = scope === "company" ? "company" : "contact";
  let n = 0;
  const Item = ({ k, label, on, locked, onClick, isBusy }: { k: string; label: string; on: boolean; locked?: boolean; onClick?: () => void; isBusy?: boolean }) => (
    <button key={k} type="button" role="switch" aria-checked={on} disabled={locked || isBusy}
      className={`rqf-item ${on ? "is-on" : ""} ${locked ? "is-locked" : ""} ${isBusy ? "is-busy" : ""}`}
      style={{ ["--i" as string]: n++ } as CSSProperties} onClick={onClick}
      title={locked ? `Every ${noun} needs it` : on ? "Required — click to make it optional" : "Optional — click to make it required"}>
      <span className="rqf-sw"><i /></span>
      <b>{label}</b>
      {locked ? <em>Always</em> : on ? <em className="is-req">Required</em> : null}
    </button>
  );
  const onCount = all.filter((f) => !f.locked && isFixedRequired(scope, f.key)).length + custom.filter((f) => f.required).length;
  return (
    <div className="rqf">
      <p className="rqf-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
        <span>Required fields get a <b>*</b> and must be filled in before a {noun} can be saved. Imports flag the rows that miss them. <b>{onCount}</b> required now.</span>
      </p>
      {groups.map((g) => (
        <div className="rqf-group" key={g}>
          <span className="rqf-h">{g}</span>
          <div className="rqf-grid">
            {all.filter((f) => f.group === g).map((f) => Item({
              k: f.key, label: f.label, on: !!f.locked || isFixedRequired(scope, f.key), locked: f.locked, isBusy: busy === f.key, onClick: () => void flip(f.key),
            }))}
          </div>
        </div>
      ))}
      {custom.length > 0 && (
        <div className="rqf-group">
          <span className="rqf-h">Your custom fields</span>
          <div className="rqf-grid">
            {custom.map((f) => Item({ k: `c:${f.id}`, label: f.label, on: f.required, isBusy: busy === `c:${f.id}`, onClick: () => void flipCustom(f.id, !f.required) }))}
          </div>
        </div>
      )}
      {err && <p className="dw-err">{err}</p>}
    </div>
  );
}

export interface SxSection {
  k: string; label: string; icon: string; title: string; hint: string;
  tone?: "green" | "blue" | "amber" | "indigo" | "violet" | "slate" | "rose";
  count?: number; aside?: ReactNode; body: ReactNode;
}
/**
 * A settings page: the usual Settings header, a sticky index of its sections on
 * the left (follows the scroll, jumps on click) and the sections as cards that
 * fold open and closed. Same feel as the company / contact panel, laid out as a page.
 */
export function SettingsShell({ icon, title, sub, tags, sections, onBack }: {
  icon: string; eyebrow?: string; title: string; sub: string; tags?: ReactNode; sections: SxSection[]; onBack: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  /** Only the sections scroll; the header and the index stay put. */
  const mainRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState(sections[0]?.k ?? "");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const lock = useRef(0);
  // which section is on screen
  useEffect(() => {
    const sc = mainRef.current;
    if (!sc) return;
    const onScroll = () => {
      if (Date.now() < lock.current) return;
      const secs = Array.from(sc.querySelectorAll<HTMLElement>("[data-sec]"));
      if (!secs.length) return;
      const top = sc.getBoundingClientRect().top;
      let cur = secs[0].dataset.sec!;
      for (const el of secs) if (el.getBoundingClientRect().top - top <= 120) cur = el.dataset.sec!;
      if (sc.scrollTop > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) cur = secs[secs.length - 1].dataset.sec!;
      setActive(cur);
    };
    onScroll();
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
  }, []);
  const scrollTo = (k: string) => {
    const sc = mainRef.current;
    const el = sc?.querySelector<HTMLElement>(`[data-sec="${k}"]`);
    if (!sc || !el) return;
    setActive(k);
    lock.current = Date.now() + 800;
    sc.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 4), behavior: "smooth" });
    el.classList.remove("is-flash"); void el.offsetWidth; el.classList.add("is-flash");
    window.setTimeout(() => el.classList.remove("is-flash"), 1200);
  };
  const go = (k: string) => {
    if (closed.has(k)) { setClosed((x) => { const n = new Set(x); n.delete(k); return n; }); window.setTimeout(() => scrollTo(k), 80); }
    else scrollTo(k);
  };
  const toggle = (k: string) => setClosed((x) => { const n = new Set(x); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allClosed = sections.every((s) => closed.has(s.k));
  // the white pill that slides to the active item
  const [ink, setInk] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(".sx-nav-item.is-on");
    if (el) setInk({ top: el.offsetTop, height: el.offsetHeight });
  }, [active, sections.length]);
  return (
    <div className="st sx" ref={rootRef}>
      <header className="st-bar st-bar-back sx-bar">
        <button className="uv-back" onClick={onBack}>‹ Settings</button>
        <div className="sx-bar-row">
          <span className="sx-badge"><DwIcon name={icon} /></span>
          <div className="sx-bar-txt">
            <h1 className="st-title">{title}</h1>
            <p className="st-sub">{sub}</p>
          </div>
          {tags && <div className="sx-tags">{tags}</div>}
        </div>
      </header>
      <div className="sx-layout">
        <aside className="sx-side">
          <nav className="sx-nav" ref={navRef} aria-label="Sections">
            {ink && <span className="sx-nav-ink" style={{ top: ink.top, height: ink.height }} aria-hidden="true" />}
            {sections.map((s, i) => (
              <button key={s.k} type="button" className={`sx-nav-item ${active === s.k ? "is-on" : ""}`} data-tone={s.tone ?? "green"}
                style={{ ["--n" as string]: i } as CSSProperties} onClick={() => go(s.k)}>
                <i><DwIcon name={s.icon} /></i>
                <span>{s.label}</span>
                {s.count != null && s.count > 0 && <em>{s.count}</em>}
              </button>
            ))}
          </nav>
          <button type="button" className="sx-foldall" onClick={() => setClosed(allClosed ? new Set() : new Set(sections.map((s) => s.k)))}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={allClosed ? "M7 10l5 5 5-5M7 4l5 5 5-5" : "M7 14l5-5 5 5M7 20l5-5 5 5"} /></svg>
            {allClosed ? "Open all" : "Fold all"}
          </button>
        </aside>
        <div className="sx-main" ref={mainRef}>
          {sections.map((s, i) => {
            const open = !closed.has(s.k);
            return (
              <section key={s.k} className={`dw-sec sx-sec ${open ? "is-open" : ""}`} data-sec={s.k} data-tone={s.tone ?? "green"}
                style={{ ["--n" as string]: i } as CSSProperties}>
                <div className="sx-sec-h" onClick={() => toggle(s.k)}>
                  <DwSecHead icon={s.icon} title={s.title} hint={s.hint}
                    aside={<>
                      {s.aside}
                      {s.count != null && <span className="dw-pill">{s.count}</span>}
                      <button type="button" className="sx-chev" aria-expanded={open} aria-label={open ? `Fold ${s.label}` : `Open ${s.label}`}
                        onClick={(e) => { e.stopPropagation(); toggle(s.k); }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                      </button>
                    </>} />
                </div>
                <div className="sx-fold" inert={!open ? true : undefined}>
                  <div className="sx-fold-in">{s.body}</div>
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Settings › Companies page: what sets up the Companies list — its custom
 * fields, the sector / source / type lists — and its data tools (import,
 * export, clean-up). The Companies page only links here.
 */
// ---- Partners: what a partner always takes (its panel) ----
/** A handshake: partner types and partners. */
const PARTNER_ICON = "M11 17l2 2a1 1 0 1 0 3-3M14 14l2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4M21 3l1 11h-2M3 3L2 14l6.5 6.5a1 1 0 1 0 3-3M3 4h8";
export function CompanySettings({ onBack }: { onBack: () => void }) {
  const secSection = useSecuritySection("companies");
  const [fields, setFields] = useState<CompanyField[]>([]);
  const [options, setOptions] = useState<CrmOption[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactFields, setContactFields] = useState<ContactField[]>([]);
  const [tool, setTool] = useState<"import" | "export" | "cleanup" | null>(null);
  const reloadOptions = async () => { setOptions(await listCrmOptions().catch(() => [])); void partnerList(true); };
  const reloadFields = async () => setFields(await listCompanyFields().catch(() => []));
  const load = async () => {
    const [f, o, co, ct, cf] = await Promise.all([
      listCompanyFields().catch(() => []), listCrmOptions().catch(() => []), listCompanies().catch(() => []),
      listContacts().catch(() => []), listContactFields().catch(() => []),
    ]);
    setFields(f); setOptions(o); setCompanies(co); setContacts(ct); setContactFields(cf);
  };
  useEffect(() => { void load(); }, []);
  const partners = partnerCompanies(companies);
  const partnerTypes = options.filter((o) => o.kind === "relationship" && (o.is_partner ?? /partner/i.test(o.label)));
  const I = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
  const n = (kind: CrmOption["kind"]) => options.filter((o) => o.kind === kind).length;
  const used = (get: (c: Company) => string | null | undefined) => new Set(companies.map(get).filter(Boolean)).size;
  return (
    <>
      <SettingsShell icon="building" title="Companies page" sub="Custom fields, the lists you pick from, and bringing companies in and out"
        onBack={onBack}
        tags={<>
          <span className="sx-tag"><DwIcon name="building" />{companies.length.toLocaleString("en-GB")} compan{companies.length === 1 ? "y" : "ies"}</span>
          <span className="sx-tag"><DwIcon name="sliders" />{fields.length} custom field{fields.length === 1 ? "" : "s"}</span>
          <span className="sx-tag"><DwIcon name="pin" />{n("source")} source{n("source") === 1 ? "" : "s"}</span>
        </>}
        sections={[
          { k: "data", label: "Import & export", icon: "upload", tone: "blue", title: "Import, export & clean-up", hint: "Bring companies in from a file, take them out, and tidy what is there",
            body: <DataTools items={[
              { key: "import", title: "Import", hint: "Companies from Excel or CSV, with their contacts", icon: I("M12 15V3M7 8l5-5 5 5M5 21h14"), tone: "#3f7fd8", onOpen: () => setTool("import") },
              { key: "export", title: "Export", hint: "Pick companies by client, deal, phase or contact", icon: I("M12 3v12M7 10l5 5 5-5M5 21h14"), tone: "#8b5cf6", onOpen: () => setTool("export") },
              { key: "cleanup", title: "Clean up data", hint: "Fix doubled surnames, legal names and street numbers", icon: I("M3 21l9-9M12.2 6.2l5.6 5.6M14 4l6 6-8 8-6-6z"), tone: "#d98324", onOpen: () => setTool("cleanup") },
            ]} /> },
          { k: "sectors", label: "Sectors", icon: "tag", tone: "green", count: DEFAULT_SECTORS.length + n("sector"),
            title: "Sectors", hint: `Every company can have one; new ones get it guessed from their name · ${used((c) => c.sector)} in use`,
            body: <OptionList bare kind="sector" options={options} onChanged={reloadOptions} builtIn={DEFAULT_SECTORS.map((x) => x.label)} placeholder="Add a sector, e.g. Aerospace" /> },
          { k: "sources", label: "Sources", icon: "pin", tone: "amber", count: n("source"),
            title: "Sources", hint: `Where a company came from; imports match what the file says · ${used((c) => c.source)} in use`,
            body: <OptionList bare kind="source" options={options} onChanged={reloadOptions} builtIn={[]} placeholder="Add a source, e.g. Website, Event, Partner" /> },
          { k: "types", label: "Types", icon: "star", tone: "violet", count: REL_SYSTEM.length + n("relationship"),
            title: "What a company can be", hint: "CRM, In sales and Client switch on by themselves; add your own (Partner, Supplier…) to pick by hand. Switch one on as a partner type: its companies are your partners.",
            body: <>
              <OptionList bare kind="relationship" options={options} onChanged={reloadOptions} builtIn={REL_SYSTEM.map((r) => r.label)} placeholder="Add a type, e.g. Partner, Supplier" partnerSwitch />
              <p className="cf-partner-note">
                <DwIcon name="users" />
                {partnerTypes.length
                  ? <span><b>{partners.length.toLocaleString("en-GB")} partner{partners.length === 1 ? "" : "s"}</b> — companies typed {partnerTypes.map((o) => `“${o.label}”`).join(" or ")}. They are the partners offered on a deal line in the calculator, where what each one takes is set.</span>
                  : <span>No partner type yet: press the handshake on a type (e.g. Partner) and the companies with it become your partners.</span>}
              </p>
            </> },
          { k: "fields", label: "Custom fields", icon: "sliders", tone: "indigo", count: fields.length,
            title: "Custom fields", hint: "Extra fields on every company, in its panel under Additional details",
            body: <CustomFieldsEditor noun="company" fields={fields} onChanged={reloadFields}
              api={{ add: (f) => addCompanyField(f), update: (id, patch) => updateCompanyField(id, patch), remove: (id) => deleteCompanyField(id), renameValue: (id, from, to) => renameCustomValue("companies", id, from, to) }}
              examples={{ name: "Field name, e.g. Founded, Key account", options: "SME, Mid-market, Enterprise" }} /> },
          { k: "required", label: "Required fields", icon: "asterisk", tone: "amber",
            title: "Required fields", hint: "What must be filled in before a company can be saved — built-in fields and your own",
            body: <RequiredFieldsEditor scope="company" custom={fields}
              onCustomToggle={async (id, on) => { await updateCompanyField(id, { required: on }); await reloadFields(); }} /> },
          ...(secSection ? [secSection] : []),
        ]} />
      {tool === "import" && <CompanyImport fields={fields} onClose={() => setTool(null)} onDone={async () => { await load(); }} />}
      {tool === "export" && (
        <ContactExport root="company" companies={companies} contacts={contacts} contactFields={contactFields}
          shownIds={companies.map((c) => c.id as string)} onClose={() => setTool(null)} />
      )}
      {tool === "cleanup" && <DataCleanup onClose={() => setTool(null)} onDone={() => { void load(); }} />}
    </>
  );
}
