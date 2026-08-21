/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Select from "../../framework/Select";
import { listContacts, saveContact, deleteContact, listCompanies, type Contact, type Company } from "../companies/companiesApi";
import "../clients/ClientsPage.css";
import "../companies/CompaniesPage.css";
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

  const reload = async () => {
    setContacts(await listContacts().catch(() => []));
    setCompanies(await listCompanies().catch(() => []));
  };
  useEffect(() => { reload(); }, []);

  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? "—";
  const shown = contacts.filter((c) => {
    const n = norm(q.trim());
    if (!n) return true;
    const companyNames = c.companyIds.map(companyName).join(" ");
    return [fullName(c), c.position, c.email, companyNames].some((v) => norm(v ?? "").includes(n));
  });

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
        <button className="cl-primary" onClick={() => setEditing(empty())}>+ New contact</button>
      </header>

      {shown.length === 0 ? (
        <p className="cl-hint">{contacts.length === 0 ? "No contacts yet. Add your first one." : "No contacts match your search."}</p>
      ) : (
        <div className="ct-scroll">
          <div className="ct-lrow ct-lhead">
            <span>Name</span>
            <span>Position</span>
            <span>Email</span>
            <span>Companies</span>
          </div>
          <div className="ct-list">
            {shown.map((c) => (
              <button key={c.id} className="ct-lrow" onClick={() => setEditing(structuredClone(c))}>
                <span className="ct-lcell ct-lid">
                  <span className="ct-avatar">{fullName(c).slice(0, 1).toUpperCase()}</span>
                  <span className="ct-lname">{fullName(c)}{c.is_billing && <i className="ct-billing" title="Billing contact">€</i>}</span>
                </span>
                <span className="ct-lcell ct-lmuted">{c.position || "—"}</span>
                <span className="ct-lcell ct-lemail">{c.email || "—"}</span>
                <span className="ct-lcell ct-lcompanies">
                  {c.companyIds.length === 0 ? <span className="ct-lmuted">—</span> : (
                    <>
                      {c.companyIds.slice(0, 2).map((id) => <span key={id} className="ct-chip">{companyName(id)}</span>)}
                      {c.companyIds.length > 2 && <span className="ct-chip ct-chip-more">+{c.companyIds.length - 2}</span>}
                    </>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <ContactEditor
          contact={editing}
          companies={companies}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
          onDeleted={async () => { setEditing(null); await reload(); }}
        />
      )}
    </div>
  );
}

function ContactEditor({ contact, companies, onClose, onSaved, onDeleted }: {
  contact: Contact; companies: Company[]; onClose: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const [c, setC] = useState<Contact>(contact);
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

  const save = async () => {
    if (!c.first_name.trim()) { setErr("A first name is required."); return; }
    setBusy(true); setErr(null);
    const e = await saveContact(c);
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