import { useEffect, useRef, useState } from "react";
import type { Client, Project, Contact, Phase, TeamMember, ClientRole, ProjectType, Blueprint } from "./ClientsPage";
import { effectiveRate, effectiveSupervisionRate } from "./ClientsPage";
import DatePicker from "../../framework/DatePicker";
import Select from "../../framework/Select";
import { supabase } from "../../api/supabase";

const uid = () => crypto.randomUUID();
const emptyAddr = { street: "", number: "", details: "", postalCode: "", city: "", country: "" };

/**
 * Numeric input that shows an empty box instead of a literal 0, so typing
 * doesn't produce "0900". Keeps its own text while focused; commits a number.
 */
function NumField({
  value, onChange, className = "cl-input", ...rest
}: {
  value: number;
  onChange: (n: number) => void;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === 0 ? "" : String(value));
  return (
    <input
      type="number"
      inputMode="decimal"
      className={className}
      value={shown}
      onChange={(e) => { const v = e.target.value; setText(v); onChange(v === "" ? 0 : Number(v) || 0); }}
      onFocus={(e) => { if (value === 0) setText(""); e.target.select(); }}
      onBlur={() => setText(null)}
      {...rest}
    />
  );
}

interface Props {
  onSave: (client: Client, project: Project) => void;
  onClose: () => void;
  project?: Project | null;
roles: ClientRole[];
  projectTypes: ProjectType[];
  blueprints: Blueprint[];
  client?: Client | null;
  /** What sales actually sold, shown alongside the form as a reference. */
  soldFrom?: {
    company?: string; pipeline?: string; total: number;
    services: {
      label: string; price: number; days?: number; kind?: string; gross?: number; discount?: number;
      rows?: { label: string; detail: string; amount: number; discount: number; days?: number; rate?: number }[];
    }[];
  } | null;
}

export default function NewClientForm({ onSave, onClose, roles = [], projectTypes = [], blueprints = [], client = null, project = null, soldFrom = null }: Props) {
  const [tab, setTab] = useState<"client" | "engagement">("client");

const [name, setName] = useState(client?.name ?? "");
const [legalName, setLegalName] = useState(project?.legalName ?? "");
  const [vatNumber, setVatNumber] = useState(project?.vatNumber ?? "");
const [projectTypeId, setProjectTypeId] = useState(project?.projectTypeId ?? "");
  const [kickoffDate, setKickoff] = useState(project?.kickoffDate ?? "");
  const [signingDate, setSigning] = useState(project?.signingDate ?? "");
const [addr, setAddr] = useState(project?.address ?? { ...emptyAddr });

const [contacts, setContacts] = useState<Contact[]>(project?.contacts ?? []);
const [editContact, setEditContact] = useState<string | null>(null);
const [streetSug, setStreetSug] = useState<{ display_name: string; address?: Record<string, string> }[]>([]);
const [numSug, setNumSug] = useState<{ display_name: string; address?: Record<string, string> }[]>([]);
const [streetOpen, setStreetOpen] = useState(false);
const [numOpen, setNumOpen] = useState(false);
const skipStreet = useRef(!!project);
  const skipNumber = useRef(!!project);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

const [consultorDays, setConsultorDays] = useState(project?.consultorDays ?? 0);
  const [connectorDays, setConnectorDays] = useState(project?.connectorDays ?? 0);
  const [pricePerDay, setPricePerDay] = useState(project?.pricePerDay ?? 0);
  const [discountMode, setDiscountMode] = useState<"none" | "rate" | "total" | "percent">(project?.discountMode ?? "none");
  const [discountValue, setDiscountValue] = useState(project?.discountValue ?? 0);
  const [supervisionDays, setSupervisionDays] = useState(project?.supervisionDays ?? 0);
  const [supervisionPrice, setSupervisionPrice] = useState(project?.supervisionPrice ?? 0);
  const [supDiscountMode, setSupDiscountMode] = useState<"none" | "rate" | "percent">(project?.supervisionDiscountMode ?? "none");
  const [supDiscountValue, setSupDiscountValue] = useState(project?.supervisionDiscountValue ?? 0);
  const [taxed, setTaxed] = useState(project?.taxed ?? false);
  const [taxRate, setTaxRate] = useState(project?.taxRate ?? 0);
  const [paymentDays, setPaymentDays] = useState(project?.paymentDays ?? 0);
  const [phases, setPhases] = useState<Phase[]>(project?.phases ?? []);
  const [team, setTeam] = useState<TeamMember[]>(project?.team ?? []);
  const [editMember, setEditMember] = useState<string | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(({ data }) => {
      type U = { id: string; first_name?: string | null; last_name?: string | null; username?: string | null; email?: string | null };
      setPeople(((data?.users ?? []) as U[]).map((u) => ({
        id: u.id,
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—",
      })));
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

const setAddrField = (f: keyof typeof emptyAddr, v: string) => setAddr((a) => ({ ...a, [f]: v }));

  type AcItem = { display_name: string; address?: Record<string, string> };
  const photonToItems = (d: any): AcItem[] => {
    const feats = Array.isArray(d?.features) ? d.features : [];
    return feats.map((f: any) => {
      const p = f?.properties ?? {};
      const line = [p.name, p.housenumber, p.street, p.postcode, p.city, p.state, p.country].filter(Boolean);
      return {
        display_name: Array.from(new Set(line)).join(", ") || p.name || "Unknown place",
        address: {
          road: p.street ?? (p.osm_key === "highway" ? p.name : "") ?? "",
          house_number: p.housenumber ?? "",
          postcode: p.postcode ?? "",
          city: p.city ?? p.town ?? p.village ?? p.municipality ?? "",
          country: p.country ?? "",
        },
      };
    });
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ncm-ac")) {
        setStreetOpen(false);
        setNumOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

useEffect(() => {
if (skipStreet.current) { skipStreet.current = false; return; }
if (project && addr.street === project.address?.street) return;
    const t = setTimeout(async () => {
      if (addr.street.trim().length < 3) { setStreetSug([]); return; }
      try {
        const r = await fetch(`https://photon.komoot.io/api/?limit=6&lang=default&q=${encodeURIComponent(addr.street)}`);
        const d = await r.json();
        const items = photonToItems(d); setStreetSug(items); setStreetOpen(items.length > 0);
      } catch { setStreetSug([]); }
    }, 250);
    return () => clearTimeout(t);
}, [addr.street, project]);

const pickStreet = (item: { display_name: string; address?: Record<string, string> }) => {
    const a = item.address ?? {};
skipStreet.current = true;
    skipNumber.current = true;
    setAddr({
      street: a.road ?? a.pedestrian ?? a.neighbourhood ?? item.display_name,
      number: a.house_number ?? "",
      details: "",
      postalCode: a.postcode ?? "",
      city: a.city ?? a.town ?? a.village ?? a.municipality ?? "",
      country: a.country ?? "",
    });
setStreetSug([]);
    setNumSug([]);
  };

useEffect(() => {
if (skipNumber.current) { skipNumber.current = false; return; }
if (project && addr.number === project.address?.number) return;
    const t = setTimeout(async () => {
      if (!addr.street.trim() || addr.number.trim().length < 1) { setNumSug([]); return; }
      try {
        const r = await fetch(`https://photon.komoot.io/api/?limit=6&lang=default&q=${encodeURIComponent(`${addr.street} ${addr.number}`)}`);
        const d = await r.json();
        const items = photonToItems(d).filter((x) => x.address?.house_number); setNumSug(items); setNumOpen(items.length > 0);
      } catch { setNumSug([]); }
    }, 250);
    return () => clearTimeout(t);
}, [addr.number, addr.street, project]);

  const pickNumber = (item: { display_name: string; address?: Record<string, string> }) => {
    const a = item.address ?? {};
    setAddr((prev) => ({
      ...prev,
      number: a.house_number ?? prev.number,
      postalCode: a.postcode ?? prev.postalCode,
      city: a.city ?? a.town ?? a.village ?? a.municipality ?? prev.city,
      country: a.country ?? prev.country,
    }));
    setNumSug([]);
  };


  // Contacts
  const addContact = () => {
    const id = uid();
setContacts((c) => [...c, { id, name: "", position: "", email: "", phone: "", billing: false }]);
    setEditContact(id);
  };
  const setContactField = (id: string, f: keyof Contact, v: string | boolean) =>
    setContacts((c) => c.map((x) => (x.id === id ? ({ ...x, [f]: v } as Contact) : x)));
  const removeContact = (id: string) => setContacts((c) => c.filter((x) => x.id !== id));
  const onDrop = (i: number) => {
    if (dragIndex === null || dragIndex === i) return setDragIndex(null);
    setContacts((cs) => {
      const arr = [...cs];
      const [moved] = arr.splice(dragIndex, 1);
      arr.splice(i, 0, moved);
      return arr;
    });
    setDragIndex(null);
  };

  // Phases + tasks
  const addPhase = () => setPhases((p) => [...p, { id: uid(), name: "", days: 0, tasks: [] }]);
  const setPhase = (id: string, f: "name" | "days", v: string | number) =>
    setPhases((p) => p.map((x) => (x.id === id ? { ...x, [f]: v } : x)));
  const removePhase = (id: string) => setPhases((p) => p.filter((x) => x.id !== id));
  const addTask = (phId: string) =>
    setPhases((p) => p.map((x) => x.id !== phId ? x : { ...x, tasks: [...(x.tasks ?? []), { id: uid(), name: "" }] }));
  const setTask = (phId: string, tId: string, name: string) =>
    setPhases((p) => p.map((x) => x.id !== phId ? x : { ...x, tasks: x.tasks.map((t) => (t.id === tId ? { ...t, name } : t)) }));
  const removeTask = (phId: string, tId: string) =>
    setPhases((p) => p.map((x) => x.id !== phId ? x : { ...x, tasks: x.tasks.filter((t) => t.id !== tId) }));
  const applyBlueprint = (bpId: string) => {
    const bp = blueprints.find((b) => b.id === bpId);
    if (!bp) return;
    const total = consultorDays + connectorDays + supervisionDays;
    setPhases(bp.phases.map((ph) => ({
      id: uid(), name: ph.name,
      days: Math.round(((Number(ph.percent) || 0) / 100) * total),
      tasks: (ph.tasks ?? []).map((t) => ({ id: uid(), name: t.name })),
    })));
  };

  // Team
  const addMember = () => {
    const id = uid();
    setTeam((t) => [...t, { id, name: "", role: "", userId: "" }]);
    setEditMember(id);
  };
  const setMemberRole = (id: string, roleId: string) =>
    setTeam((t) => t.map((x) => (x.id === id ? { ...x, role: roleId, userId: "", name: "" } : x)));
  const setMemberUser = (id: string, userId: string) => {
    setTeam((t) => t.map((x) => (x.id === id ? { ...x, userId, name: people.find((p) => p.id === userId)?.name ?? "" } : x)));
    setEditMember(null);
  };
  const removeMember = (id: string) => setTeam((t) => t.filter((x) => x.id !== id));

  const totalConsultancy = consultorDays + connectorDays;
  const maxDays = totalConsultancy + supervisionDays;
  const phaseTotal = phases.reduce((s, p) => s + (Number(p.days) || 0), 0);
  const remaining = maxDays - phaseTotal;
const effRate = effectiveRate(pricePerDay, discountMode, discountValue);
  const effSupRate = effectiveSupervisionRate(supervisionPrice, supDiscountMode, supDiscountValue);
  const grossValue = totalConsultancy * effRate + supervisionDays * effSupRate;
  const value = discountMode === "total" ? Math.max(0, grossValue - discountValue) : grossValue;
  const savings = totalConsultancy * pricePerDay + supervisionDays * supervisionPrice - value;
  const canSave = name.trim().length > 0;
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "";

const submit = () => {
    if (!canSave) return;
    const clientId = client?.id ?? uid();
    onSave(
{ id: clientId, name: name.trim() },
      {
        id: project?.id ?? uid(),
        clientId,
        legalName,
        vatNumber,
        address: addr,
        contacts,
        projectTypeId,
        kickoffDate,
        signingDate,
        consultorDays, connectorDays, pricePerDay,
        supervisionDays, supervisionPrice,
        taxed, taxRate: taxed ? taxRate : 0, paymentDays,
        discountMode, discountValue: discountMode === "none" ? 0 : discountValue,
        supervisionDiscountMode: supDiscountMode, supervisionDiscountValue: supDiscountMode === "none" ? 0 : supDiscountValue,
        phases, team,
        status: project?.status ?? "open",
      }
    );
  };

  return (
    <div className="ncm-backdrop" onMouseDown={onClose}>
      {soldFrom && (
        <aside className="ncm-sold" onMouseDown={(e) => e.stopPropagation()}>
          <span className="ncm-sold-eyebrow">Sold in sales</span>
          <h4 className="ncm-sold-title">{soldFrom.company}</h4>
          {soldFrom.pipeline && <p className="ncm-sold-dest">{soldFrom.pipeline}</p>}

          {(() => {
            const svc = soldFrom.services.filter((s) => s.kind !== "product");
            const prods = soldFrom.services.filter((s) => s.kind === "product");
            const gross = svc.reduce((a, s) => a + (s.gross ?? s.price ?? 0), 0);
            const disc = svc.reduce((a, s) => a + (s.discount ?? 0), 0);
            const net = svc.reduce((a, s) => a + (s.price ?? 0), 0);
            const days = svc.reduce((a, s) => a + (s.days ?? 0), 0);
            return (
              <>
                {svc.map((s, i) => (
                  <div className="ncm-sold-svc" key={i}>
                    <div className="ncm-sold-svc-hd">
                      <span>{s.label}</span>
                      <b>{s.days ? `${s.days}d` : ""}</b>
                    </div>
                    {s.rows && s.rows.length > 0 && (
                      <table className="ncm-sold-tbl">
                        <thead>
                          <tr><th>Variable</th><th className="ncm-num">Days</th><th className="ncm-num">Rate</th><th className="ncm-num">Amount</th></tr>
                        </thead>
                        <tbody>
                          {s.rows.map((r, k) => (
                            <tr key={k}>
                              <td title={r.detail}>{r.label}</td>
                              <td className="ncm-num">{r.days != null ? r.days : ""}</td>
                              <td className="ncm-num">{r.rate != null ? r.rate.toLocaleString("es-ES") : ""}</td>
                              <td className="ncm-num ncm-strong">{Math.round(r.amount).toLocaleString("es-ES")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ))}

                <dl className="ncm-sold-sum">
                  <div><dt>Gross</dt><dd>{Math.round(gross).toLocaleString("es-ES")} €</dd></div>
                  {disc > 0 && (
                    <div className="is-disc">
                      <dt>Discount</dt>
                      <dd>-{Math.round(disc).toLocaleString("es-ES")} €</dd>
                    </div>
                  )}
                  <div className="is-total"><dt>Total</dt><dd>{Math.round(net).toLocaleString("es-ES")} €</dd></div>
                  {days > 0 && <div className="is-meta"><dt>Days</dt><dd>{days}</dd></div>}
                  {days > 0 && <div className="is-meta"><dt>Per day</dt><dd>{Math.round(net / days).toLocaleString("es-ES")} €</dd></div>}
                </dl>

                {prods.length > 0 && (
                  <p className="ncm-sold-ctx">
                    Sold with {prods.map((s) => s.label).join(", ")} — licence, not delivered here.
                  </p>
                )}
              </>
            );
          })()}
        </aside>
      )}
      <div className="ncm-card ncm-card-wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="ncm-head">
<div className="ncm-head-left">
<span className="ncm-eyebrow">{client ? (project?.projectTypeId || project?.kickoffDate ? "Edit project" : "New project") : "New client"}</span>
            <h2 className="ncm-title">{client ? name || "Client" : "Create an engagement"}</h2>
          </div>
          <div className="ncm-head-actions">
            <div className="ncm-seg" data-tab={tab}>
              <span className="ncm-seg-slider" />
              <button className={tab === "client" ? "is-on" : ""} onClick={() => setTab("client")}>Client & contacts</button>
              <button className={tab === "engagement" ? "is-on" : ""} onClick={() => setTab("engagement")}>Engagement</button>
            </div>
            {(() => {
              const editing = !!project?.projectTypeId || !!project?.kickoffDate;
              const label = editing ? "Save changes" : client ? "Create project" : "Create client";
              return (
                <button className={`ncm-create ${editing ? "is-save" : ""}`} onClick={submit} disabled={!canSave} aria-label={label} title={label}>
                  {editing ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                  ) : "+"}
                </button>
              );
            })()}
            <button className="ncm-x" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        {tab === "client" ? (
          <div className="ncm-body ncm-body-3">
            {/* Client */}
            <div className="ncm-col">
              <section className="ncm-section ncm-grow">
                <h3 className="ncm-section-title">Client</h3>
                <div className="cl-field"><label>Client name</label>
                  <input className="cl-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Konsolidator Iberia" /></div>
                <div className="cl-field" style={{ marginTop: 12 }}><label>Legal name</label>
                  <input className="cl-input" value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Registered legal name" /></div>
                <div className="cl-field" style={{ marginTop: 12 }}><label>Company VAT number</label>
                  <input className="cl-input" value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} placeholder="e.g. ESB12345678" /></div>
                <div className="cl-field" style={{ marginTop: 12 }}><label>Project type</label>
                  <Select value={projectTypeId} onChange={setProjectTypeId}
                    options={projectTypes.map((t) => ({ value: t.id, label: t.name }))} placeholder="Select service" /></div>
                <div className="ncm-two">
                  <div className="cl-field"><label>Kick-off</label><DatePicker value={kickoffDate} onChange={setKickoff} /></div>
                  <div className="cl-field"><label>Signing</label><DatePicker value={signingDate} onChange={setSigning} /></div>
                </div>
              </section>
            </div>

            {/* Address */}
            <div className="ncm-col">
              <section className="ncm-section ncm-grow">
                <h3 className="ncm-section-title">Address</h3>
<div className="cl-field ncm-ac"><label>Street</label>
                  <input className="cl-input" placeholder="Start typing a street or address…" value={addr.street}
                    onChange={(e) => setAddrField("street", e.target.value)}
                    onFocus={() => streetSug.length > 0 && setStreetOpen(true)} />
                  {streetOpen && streetSug.length > 0 && (
                    <div className="ncm-ac-list">
                      {streetSug.map((sg, idx) => (
                        <button type="button" className="ncm-ac-item" key={idx} onMouseDown={(e) => e.preventDefault()} onClick={() => pickStreet(sg)}>{sg.display_name}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="ncm-two" style={{ marginTop: 12 }}>
                 <div className="cl-field ncm-ac"><label>Number</label>
                    <input className="cl-input" value={addr.number}
                      onChange={(e) => setAddrField("number", e.target.value)}
                      onFocus={() => numSug.length > 0 && setNumOpen(true)} />
                   {numOpen && numSug.length > 0 && !streetOpen && (
                      <div className="ncm-ac-list">
                        {numSug.map((sg, idx) => (
                          <button type="button" className="ncm-ac-item" key={idx} onMouseDown={(e) => e.preventDefault()} onClick={() => pickNumber(sg)}>
                            <strong>{sg.address?.house_number}</strong> · {sg.display_name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="cl-field"><label>Details</label><input className="cl-input" value={addr.details} onChange={(e) => setAddrField("details", e.target.value)} placeholder="Floor, door, etc." /></div>
                </div>
                <div className="ncm-two">
                  <div className="cl-field"><label>Postal code</label><input className="cl-input" value={addr.postalCode} onChange={(e) => setAddrField("postalCode", e.target.value)} /></div>
                  <div className="cl-field"><label>City</label><input className="cl-input" value={addr.city} onChange={(e) => setAddrField("city", e.target.value)} /></div>
                </div>
                <div className="cl-field" style={{ marginTop: 12 }}><label>Country</label>
                  <input className="cl-input" value={addr.country} onChange={(e) => setAddrField("country", e.target.value)} /></div>
              </section>
            </div>

            {/* Contacts */}
            <div className="ncm-col">
              <section className="ncm-section ncm-grow">
                <div className="ncm-section-head">
                  <h3 className="ncm-section-title">Contacts</h3>
                  <button className="cl-add" onClick={addContact}>+ Add</button>
                </div>
                <p className="cl-hint" style={{ marginBottom: 8 }}>Drag to set priority.</p>
                <div className="ncm-list">
                  {contacts.length === 0 && <p className="cl-hint">No contacts yet.</p>}
                  {contacts.map((c, i) => {
                    const editing = editContact === c.id || !c.name;
                    return (
                      <div className="ncm-contact-item" key={c.id}
                        onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(i)}>
                        <span className="ncm-grip" draggable onDragStart={() => setDragIndex(i)} title="Drag to reorder">⠿</span>
                        <div className="ncm-contact-body">
                          {!editing ? (
                            <div className="ncm-crow">
                              <button className="ncm-crow-main" onClick={() => setEditContact(c.id)}>
<span className="ncm-crow-name">
                                  <span className="ncm-prio">{i + 1}</span>
                                  <span className="ncm-crow-stack">
                                    <span>{c.name}{c.billing && <span className="ncm-bill">Billing</span>}</span>
                                    {c.position && <span className="ncm-crow-sub">{c.position}</span>}
                                  </span>
                                </span>
                                <span className="ncm-crow-tags">
                                  {c.email && <span className="ncm-tag">✉</span>}
                                  {c.phone && <span className="ncm-tag">☎</span>}
                                </span>
                              </button>
                              <button className="cl-remove" onClick={() => removeContact(c.id)} aria-label="Remove">×</button>
                            </div>
                          ) : (
                            <div className="ncm-contact">
<input className="cl-input" placeholder="Name" value={c.name} onChange={(e) => setContactField(c.id, "name", e.target.value)} />
                              <input className="cl-input" placeholder="Position (e.g. CFO)" value={c.position} onChange={(e) => setContactField(c.id, "position", e.target.value)} />
                              <input className="cl-input" placeholder="Email" value={c.email} onChange={(e) => setContactField(c.id, "email", e.target.value)} />
                              <div className="ncm-contact-row">
                                <input className="cl-input" placeholder="Phone" value={c.phone} onChange={(e) => setContactField(c.id, "phone", e.target.value)} />
                                <button className="cl-remove" onClick={() => removeContact(c.id)} aria-label="Remove">×</button>
                              </div>
                              <div className="ncm-tax-row">
                                <span className="ncm-tax-label">Billing contact</span>
                                <button type="button" role="switch" aria-checked={c.billing}
                                  className={`ncm-switch ${c.billing ? "on" : ""}`}
                                  onClick={() => setContactField(c.id, "billing", !c.billing)}>
                                  <span className="ncm-switch-knob" />
                                </button>
                              </div>
                              <button className="cl-add ncm-done" onClick={() => setEditContact(null)} disabled={!c.name}>Done</button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>
        ) : (
          <div className="ncm-body ncm-body-eng">
            {/* Summary + money */}
            <div className="ncm-col ncm-col-scroll">
              <section className="ncm-section">
                <h3 className="ncm-section-title">Consultancy</h3>
                <div className="ncm-three">
                  <div className="cl-field"><label>Consultor</label><NumField min="0" value={consultorDays} onChange={setConsultorDays} /></div>
                  <div className="cl-field"><label>Connector</label><NumField min="0" value={connectorDays} onChange={setConnectorDays} /></div>
<div className="cl-field"><label>Price/day</label><NumField min="0" value={pricePerDay} onChange={setPricePerDay} /></div>
                </div>
                <div className="ncm-two" style={{ marginTop: 12 }}>
                  <div className="cl-field"><label>Discount</label>
                    <Select value={discountMode} onChange={(v) => setDiscountMode(v as "none" | "rate" | "total" | "percent")}
                      options={[
                        { value: "none", label: "No discount" },
                        { value: "rate", label: "Off daily rate (€)" },
                        { value: "percent", label: "Off daily rate (%)" },
                        { value: "total", label: "Off total price" },
                      ]} />
                  </div>
                  {discountMode !== "none" && (
                    <div className="cl-field"><label>{discountMode === "rate" ? "Amount / day" : discountMode === "percent" ? "Percent / day" : "Amount off total"}</label>
                      <NumField min="0" value={discountValue} onChange={setDiscountValue} /></div>
                  )}
                </div>
              </section>
              <section className="ncm-section">
                <h3 className="ncm-section-title">Supervision</h3>
                <div className="ncm-two">
                  <div className="cl-field"><label>Days</label><NumField min="0" value={supervisionDays} onChange={setSupervisionDays} /></div>
                  <div className="cl-field"><label>Price/day</label><NumField min="0" value={supervisionPrice} onChange={setSupervisionPrice} /></div>
                </div>
                <div className="ncm-two" style={{ marginTop: 12 }}>
                  <div className="cl-field"><label>Discount</label>
                    <Select value={supDiscountMode} onChange={(v) => setSupDiscountMode(v as "none" | "rate" | "percent")}
                      options={[
                        { value: "none", label: "No discount" },
                        { value: "rate", label: "Off daily rate (€)" },
                        { value: "percent", label: "Off daily rate (%)" },
                      ]} />
                  </div>
                  {supDiscountMode !== "none" && (
                    <div className="cl-field"><label>{supDiscountMode === "rate" ? "Amount / day" : "Percent / day"}</label>
                      <NumField min="0" value={supDiscountValue} onChange={setSupDiscountValue} /></div>
                  )}
                </div>
                <div className="ncm-tax-row">
                  <span className="ncm-tax-label">Taxed</span>
                  <button type="button" role="switch" aria-checked={taxed} className={`ncm-switch ${taxed ? "on" : ""}`} onClick={() => setTaxed((v) => !v)}>
                    <span className="ncm-switch-knob" />
                  </button>
                  {taxed && (<NumField min="0" max="100" className="cl-input ncm-tax-input" placeholder="Rate %" value={taxRate} onChange={setTaxRate} />)}
                </div>
              </section>
              <section className="ncm-section">
                <h3 className="ncm-section-title">Payment period</h3>
                <div className="cl-field"><label>Days to pay from invoice</label>
                  <NumField min="0" value={paymentDays} onChange={setPaymentDays} /></div>
              </section>
            </div>

{/* Summary + Team */}
            <div className="ncm-col">
              <section className="ncm-section">
                <h3 className="ncm-section-title">Summary</h3>
                <div className="ncm-summary">
                  <div><span>Consultancy</span><strong>{totalConsultancy}d</strong></div>
                  <div><span>Supervision</span><strong>{supervisionDays}d</strong></div>
                  <div><span>Phases</span><strong>{phaseTotal}/{maxDays}d</strong></div>
<div><span>Est. value</span><strong>{value.toLocaleString()}</strong></div>
                </div>
                {savings > 0 && (
                  <p className="cl-hint" style={{ marginTop: 10 }}>
                    Discount applied: −{savings.toLocaleString()}
                    {(discountMode === "rate" || discountMode === "percent") && ` (${effRate.toFixed(0)}/day)`}
                  </p>
                )}
              </section>

              <section className="ncm-section ncm-grow">
                <div className="ncm-section-head">
                  <h3 className="ncm-section-title">Team</h3>
                  <button className="cl-add" onClick={addMember}>+ Add</button>
                </div>
                <div className="ncm-list">
                  {team.length === 0 && <p className="cl-hint">No one assigned yet.</p>}
                  {team.map((m) => {
                    const editing = editMember === m.id || !m.userId;
                    if (!editing) {
                      return (
                        <div className="ncm-crow" key={m.id}>
                          <button className="ncm-crow-main" onClick={() => setEditMember(m.id)}>
                            <span className="ncm-crow-name">{m.name}</span>
                            <span className="ncm-crow-sub">{roleName(m.role)}</span>
                          </button>
                          <button className="cl-remove" onClick={() => removeMember(m.id)} aria-label="Remove">×</button>
                        </div>
                      );
                    }
                    const role = roles.find((r) => r.id === m.role);
                    const opts = (role?.userIds ?? [])
                      .map((id) => people.find((p) => p.id === id))
                      .filter((p): p is { id: string; name: string } => Boolean(p))
                      .map((p) => ({ value: p.id, label: p.name }));
                    return (
                      <div className="ncm-member" key={m.id}>
                        <Select value={m.role} onChange={(v) => setMemberRole(m.id, v)}
                          options={roles.map((r) => ({ value: r.id, label: r.name }))} placeholder="Select role" />
                        <div className="ncm-member-row">
                          <Select value={m.userId ?? ""} onChange={(v) => setMemberUser(m.id, v)}
                            options={opts} placeholder={m.role ? "Select person" : "Pick a role first"} disabled={!m.role} />
                          <button className="cl-remove" onClick={() => removeMember(m.id)} aria-label="Remove">×</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>

            {/* Phases */}
            <div className="ncm-col ncm-col-wide">
              <section className="ncm-section ncm-grow">
                <div className="ncm-section-head">
                  <h3 className="ncm-section-title">Phases</h3>
                  <button className="cl-add" onClick={addPhase}>+ Add phase</button>
                </div>
                <div className="ncm-blueprint">
                  <Select value="" onChange={applyBlueprint}
                    options={blueprints.filter((b) => {
                      // A service points at its blueprint from the catalogue.
                      const svc = projectTypes.find((s) => s.id === projectTypeId);
                      if (svc?.blueprintId) return b.id === svc.blueprintId;
                      return !projectTypeId || b.projectTypeId === projectTypeId;
                    })
                      .map((b) => ({ value: b.id, label: b.name || "Untitled blueprint" }))}
                    placeholder="Apply a blueprint" />
                </div>
                <div className="ncm-alloc">
                  <div className="ncm-alloc-head">
                    <span>{phaseTotal} of {maxDays} days planned</span>
                    <span className={remaining < 0 ? "is-over" : ""}>{remaining < 0 ? `${Math.abs(remaining)} over` : `${remaining} left`}</span>
                  </div>
                  <div className="ncm-bar">
                    <div className="ncm-bar-fill" data-over={remaining < 0} style={{ width: `${maxDays > 0 ? Math.min(100, (phaseTotal / maxDays) * 100) : 0}%` }} />
                  </div>
                </div>
                <div className="ncm-list">
                  {phases.length === 0 && <p className="cl-hint">No phases yet.</p>}
                  {phases.map((p, i) => (
                    <div className="ncm-pblock" key={p.id}>
                      <div className="ncm-phead">
                        <span className="ncm-pnum">{i + 1}</span>
                        <input className="cl-input" placeholder="Phase name" value={p.name} onChange={(e) => setPhase(p.id, "name", e.target.value)} />
                        <div className="ncm-days-wrap">
                          <NumField min="0" className="cl-input ncm-days" value={p.days} onChange={(n) => setPhase(p.id, "days", n)} />
                          <span className="ncm-days-sign">d</span>
                        </div>
                        <button className="cl-remove" onClick={() => removePhase(p.id)} aria-label="Remove phase">×</button>
                      </div>
                      <div className="ncm-ptasks">
                        {(p.tasks ?? []).map((t) => (
                          <div className="ncm-ptask" key={t.id}>
                            <span className="ncm-pdot" />
                            <input className="cl-input" placeholder="Task" value={t.name} onChange={(e) => setTask(p.id, t.id, e.target.value)} />
                            <button className="cl-remove" onClick={() => removeTask(p.id, t.id)} aria-label="Remove task">×</button>
                          </div>
                        ))}
                        <button className="cl-add" onClick={() => addTask(p.id)}>+ Task</button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}