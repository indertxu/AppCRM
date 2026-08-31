/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Select from "../../framework/Select";
import {
  listCompanies, saveCompany, deleteCompany, companyContactCounts, listContacts,
  myProfile, isSalesLead, listEmployees, loadCompanyAssignees, setCompanyAssignees,
  type Company, type Contact, type Employee,
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

  const reload = async () => {
    setCompanies(await listCompanies().catch(() => []));
    setCounts(await companyContactCounts().catch(() => ({})));
    setContacts(await listContacts().catch(() => []));
    setAssignees(await loadCompanyAssignees().catch(() => ({})));
  };
  useEffect(() => {
    myProfile().then(setMe).catch(() => {});
    listEmployees().then(setEmployees).catch(() => {});
    reload();
  }, []);

  const lead = isSalesLead(me);

  const shown = companies.filter((c) => {
    // Sales people only see the companies they have been assigned to.
    if (!lead && me && !(assignees[c.id!] ?? []).includes(me.id)) return false;
    const n = norm(q.trim());
    if (!n) return true;
    return [c.name, c.legal_name, c.vat_number, c.street, c.city, c.province, c.country, c.postal_code]
      .some((v) => norm(v ?? "").includes(n));
  });

  const contactsOf = (companyId: string) => contacts.filter((ct) => ct.companyIds.includes(companyId));

  const addrLine = (c: Company) =>
    [c.street, c.addr_number, c.city, c.country].filter(Boolean).join(", ") || "—";

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
        <button className="cl-primary" onClick={() => setEditing(empty())}>+ New company</button>
      </header>

      {shown.length === 0 ? (
        <p className="cl-hint">{companies.length === 0 ? "No companies yet. Create your first one." : "No companies match your search."}</p>
      ) : (
        <div className="co-scroll">
          <div className="co-lrow co-lhead">
            <span>Company</span>
            <span>VAT / Tax ID</span>
            <span>Address</span>
            <span className="co-lright">Contacts</span>
          </div>
          <div className="co-list">
            {shown.map((c) => {
              const people = contactsOf(c.id!);
              const isOpen = open === c.id;
              return (
                <div className="co-item" key={c.id}>
                  <div className="co-lrow" role="button" tabIndex={0}
                    onClick={() => setEditing(structuredClone(c))}
                    onKeyDown={(e) => { if (e.key === "Enter") setEditing(structuredClone(c)); }}>
                    <span className="co-lcell co-lid">
                      <span className="co-avatar">{(c.name || "?").slice(0, 1).toUpperCase()}</span>
                      <span className="co-lid-text">
                        <span className="co-lname">{c.name}</span>
                        {c.legal_name && <span className="co-lsub">{c.legal_name}</span>}
                      </span>
                    </span>
                    <span className="co-lcell co-lmono">{c.vat_number || "—"}</span>
                    <span className="co-lcell co-laddr">{addrLine(c)}</span>
                    <span className="co-lcell co-lright">
                      <button className={`co-expand ${isOpen ? "is-on" : ""}`}
                        aria-expanded={isOpen} aria-label="Show contacts"
                        onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : c.id!); }}>
                        <b className="co-lbadge">{counts[c.id!] ?? 0}</b>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={isOpen ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} /></svg>
                      </button>
                    </span>
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
          canAssign={lead}
          assigned={assignees[editing.id!] ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
          onDeleted={async () => { setEditing(null); await reload(); }}
        />
      )}
    </div>
  );
}

function CompanyEditor({ company, employees, canAssign, assigned, onClose, onSaved, onDeleted }: {
  company: Company; employees: Employee[]; canAssign: boolean; assigned: string[];
  onClose: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const [c, setC] = useState<Company>(company);
  const [who, setWho] = useState<string[]>(assigned);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Company>) => setC((x) => ({ ...x, ...patch }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (!c.name.trim()) { setErr("Give the company a name."); return; }
    setBusy(true); setErr(null);
    const e = await saveCompany(c);
    if (!e && c.id) await setCompanyAssignees(c.id, who).catch(() => {});
    setBusy(false);
    if (e) setErr(e); else onSaved();
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