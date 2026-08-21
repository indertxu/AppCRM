/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listCompanies, saveCompany, deleteCompany, companyContactCounts, type Company } from "./companiesApi";
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

  const reload = async () => {
    setCompanies(await listCompanies().catch(() => []));
    setCounts(await companyContactCounts().catch(() => ({})));
  };
  useEffect(() => { reload(); }, []);

  const shown = companies.filter((c) => {
    const n = norm(q.trim());
    if (!n) return true;
    return [c.name, c.legal_name, c.vat_number, c.street, c.city, c.province, c.country, c.postal_code]
      .some((v) => norm(v ?? "").includes(n));
  });

  const addrLine = (c: Company) =>
    [c.street, c.addr_number, c.city, c.country].filter(Boolean).join(", ") || "—";

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
            {shown.map((c) => (
              <button key={c.id} className="co-lrow" onClick={() => setEditing(structuredClone(c))}>
                <span className="co-lcell co-lid">
                  <span className="co-avatar">{(c.name || "?").slice(0, 1).toUpperCase()}</span>
                  <span className="co-lid-text">
                    <span className="co-lname">{c.name}</span>
                    {c.legal_name && <span className="co-lsub">{c.legal_name}</span>}
                  </span>
                </span>
                <span className="co-lcell co-lmono">{c.vat_number || "—"}</span>
                <span className="co-lcell co-laddr">{addrLine(c)}</span>
                <span className="co-lcell co-lright"><b className="co-lbadge">{counts[c.id!] ?? 0}</b></span>
              </button>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <CompanyEditor
          company={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
          onDeleted={async () => { setEditing(null); await reload(); }}
        />
      )}
    </div>
  );
}

function CompanyEditor({ company, onClose, onSaved, onDeleted }: {
  company: Company; onClose: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const [c, setC] = useState<Company>(company);
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