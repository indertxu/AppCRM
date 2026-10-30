/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Client, Project, Contact, Phase, TeamMember, ClientRole, ProjectType, Blueprint, RoleLine } from "./clientsTypes";
import { lineRate, roleCounts, roleColor, roleNameOf, sortRoles, legacyRoleMap, resolvedLinesOf, legacyColumnsOf } from "./clientsTypes";
import DatePicker from "../../framework/DatePicker";
import Select from "../../framework/Select";
import { CountryPicker } from "../companies/CompaniesPage";
import { supabase } from "../../api/supabase";
import "./ClientsPage.css";

const uid = () => crypto.randomUUID();
const emptyAddr = { street: "", number: "", details: "", postalCode: "", city: "", country: "" };
const eur = (n: number) => `${Math.round(n).toLocaleString()} €`;
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const reduceMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const vars = (o: Record<string, string | number>) => o as React.CSSProperties;

/**
 * Numeric input that shows an empty box instead of a literal 0, so typing
 * doesn't produce "0900". Keeps its own text while focused; commits a number.
 */
function NumField({
  value, onChange, className = "pf-input", ...rest
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

/** Eased count-up so the live totals glide instead of jumping. */
function useCount(target: number, ms = 700) {
  const [v, setV] = useState(target);
  const shown = useRef(target);
  useEffect(() => {
    if (reduceMotion()) { shown.current = target; setV(target); return; }
    const a = shown.current, t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const x = a + (target - a) * (1 - Math.pow(1 - k, 3));
      shown.current = x; setV(x);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
const Num = ({ v, suffix }: { v: number; suffix?: string }) => <>{Math.round(useCount(v)).toLocaleString()}{suffix}</>;

const IC: Record<string, string> = {
  building: "M3 21h18M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M16 9h3a2 2 0 0 1 2 2v10M9 7h3M9 11h3M9 15h3",
  pin: "M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  briefcase: "M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  receipt: "M4 2v20l3-2 3 2 3-2 3 2 3-2 1 .7V2l-1 .7-3-2-3 2-3-2-3 2-3-2zM8 8h8M8 12h8M8 16h5",
  layers: "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  phone: "M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z",
  plus: "M12 5v14M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
  check: "M5 13l4 4L19 7",
  trash: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  grip: "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
  pen: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  tag: "M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  spark: "M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z",
};
const Ico = ({ n, s = 16 }: { n: string; s?: number }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={IC[n] ?? ""} />
  </svg>
);

function Card({ icon, tone, title, sub, i, actions, className = "", children }: {
  icon: string; tone: string; title: string; sub?: React.ReactNode; i: number; actions?: React.ReactNode; className?: string; children: React.ReactNode;
}) {
  return (
    <section className={`pf-card ${className}`} style={vars({ "--i": i })}>
      <header className="pf-card-h">
        <span className="pf-card-ico" data-tone={tone}><Ico n={icon} s={16} /></span>
        <div className="pf-card-t"><h3>{title}</h3>{sub && <small>{sub}</small>}</div>
        {actions && <div className="pf-card-act">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`pf-field ${wide ? "is-wide" : ""}`}><span>{label}</span>{children}</label>;
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`pf-switch ${on ? "is-on" : ""}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

/** Small segmented picker with a sliding ink, used for the discount mode. */
function Chips<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  const i = Math.max(0, options.findIndex((o) => o.v === value));
  return (
    <div className="pf-chips" style={vars({ "--n": options.length, "--i": i })}>
      <span className="pf-chips-ink" aria-hidden="true" />
      {options.map((o) => <button type="button" key={o.v} className={o.v === value ? "is-on" : ""} onClick={() => onChange(o.v)}>{o.label}</button>)}
    </div>
  );
}

/**
 * The roles a project was sold with: each one its days, its rate and its own
 * discount on that rate. Roles come from the catalogue; a role that doesn't
 * count for the consultant's billing (a connector, say) is marked as such.
 * Also used when a sales handoff is turned into a project.
 */
export function RoleLinesEditor({ lines, roles, onChange, unit = "day", rateOf }: {
  lines: RoleLine[];
  roles: ClientRole[];
  onChange: (lines: RoleLine[]) => void;
  unit?: "day" | "hour";
  /** The list price of a role when it is added (the service's price for it). */
  rateOf?: (roleId: string) => number | undefined;
}) {
  const sorted = sortRoles(roles);
  const set = (i: number, patch: Partial<RoleLine>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const add = (roleId: string) => {
    if (!roleId) return;
    onChange([...lines, { roleId, days: 0, rate: rateOf?.(roleId) ?? lines[0]?.rate ?? 0, discountMode: "none", discountValue: 0 }]);
  };
  const remove = (i: number) => onChange(lines.filter((_, k) => k !== i));
  const free = sorted.filter((r) => !lines.some((l) => l.roleId === r.id));
  const u = unit === "hour" ? "h" : "d";
  return (
    <div className="rle">
      {lines.length === 0 ? (
        <p className="rle-empty"><Ico n="users" s={18} />No roles yet — add the roles this project was sold with.</p>
      ) : (
        <ul className="rle-list">
          {lines.map((l, i) => {
            const r = roles.find((x) => x.id === l.roleId);
            const at = sorted.findIndex((x) => x.id === l.roleId);
            const counts = roleCounts(l.roleId, roles);
            const eff = lineRate(l);
            const opts = sorted.filter((x) => x.id === l.roleId || !lines.some((y) => y.roleId === x.id)).map((x) => ({ value: x.id, label: x.name }));
            if (!r) opts.unshift({ value: l.roleId, label: roleNameOf(l.roleId, roles) });
            return (
              <li key={`${l.roleId}-${i}`} className="rle-row" style={vars({ "--c": roleColor(r, at < 0 ? i : at), "--i": i })}>
                <div className="rle-h">
                  <span className="rle-dot" aria-hidden="true" />
                  <div className="rle-role"><Select value={l.roleId} onChange={(v) => v && set(i, { roleId: v })} options={opts} /></div>
                  <span className={`rle-tag ${counts ? "is-on" : ""}`} title={counts ? "Time on this role counts for the consultant's billing and bonus" : "Time on this role doesn't count for the consultant's billing"}>
                    {counts ? "Counts for billing" : "Doesn't count"}
                  </span>
                  <b className="rle-amt">{eur(l.days * eff)}</b>
                  <button type="button" className="pf-icon is-danger" onClick={() => remove(i)} aria-label="Remove role"><Ico n="trash" s={14} /></button>
                </div>
                <div className="rle-f">
                  <Field label={unit === "hour" ? "Hours" : "Days"}><div className="pf-unit"><NumField min="0" value={l.days} onChange={(n) => set(i, { days: n })} /><i>{u}</i></div></Field>
                  <Field label={`Price / ${unit}`}><div className="pf-unit"><NumField min="0" value={l.rate} onChange={(n) => set(i, { rate: n })} /><i>€</i></div></Field>
                  <div className="rle-disc">
                    <span className="pf-label">Discount</span>
                    <Chips value={l.discountMode} onChange={(v) => set(i, { discountMode: v, discountValue: v === "none" ? 0 : l.discountValue })} options={[
                      { v: "none", label: "None" }, { v: "rate", label: `€ / ${unit}` }, { v: "percent", label: `% / ${unit}` },
                    ]} />
                    <div className={`pf-disc-val ${l.discountMode !== "none" ? "is-on" : ""}`}>
                      <div className="pf-unit"><NumField min="0" value={l.discountValue} onChange={(n) => set(i, { discountValue: n })} disabled={l.discountMode === "none"} /><i>{l.discountMode === "percent" ? "%" : "€"}</i></div>
                    </div>
                    {eff !== l.rate && <small className="rle-eff">{eur(eff)} / {unit}</small>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {free.length > 0 && (
        <div className="rle-add">
          <Select value="" onChange={add} options={free.map((x) => ({ value: x.id, label: x.name }))} placeholder="+ Add a role" />
        </div>
      )}
    </div>
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

type Tab = "details" | "contacts" | "pricing" | "plan";

export default function NewClientForm({ onSave, onClose, roles = [], projectTypes = [], blueprints = [], client = null, project = null, soldFrom = null }: Props) {
  const [tab, setTab] = useState<Tab>("details");
  const [closing, setClosing] = useState(false);
  const [showSold, setShowSold] = useState(!!soldFrom);

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
  const [overIndex, setOverIndex] = useState<number | null>(null);

  /** The roles sold, each with its days, rate and discount (old projects are read through the legacy columns). */
  const [lines, setLines] = useState<RoleLine[]>(() => (project ? resolvedLinesOf(project, legacyRoleMap(roles)) : []));
  /** Only a discount on the whole project stays at project level; per-day discounts are per role. */
  const [discountMode, setDiscountMode] = useState<"none" | "total">(project?.discountMode === "total" ? "total" : "none");
  const [discountValue, setDiscountValue] = useState(project?.discountMode === "total" ? project.discountValue : 0);
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
      if (!(e.target as HTMLElement).closest(".pf-ac")) { setStreetOpen(false); setNumOpen(false); }
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

  const pickStreet = (item: AcItem) => {
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

  const pickNumber = (item: AcItem) => {
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
    setOverIndex(null);
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
  const setTask = (phId: string, tId: string, nm: string) =>
    setPhases((p) => p.map((x) => x.id !== phId ? x : { ...x, tasks: x.tasks.map((t) => (t.id === tId ? { ...t, name: nm } : t)) }));
  const removeTask = (phId: string, tId: string) =>
    setPhases((p) => p.map((x) => x.id !== phId ? x : { ...x, tasks: x.tasks.filter((t) => t.id !== tId) }));
  const applyBlueprint = (bpId: string) => {
    const bp = blueprints.find((b) => b.id === bpId);
    if (!bp) return;
    const total = lines.reduce((s, l) => s + l.days, 0);
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

  const maxDays = lines.reduce((s, l) => s + l.days, 0);
  const countedDays = lines.filter((l) => roleCounts(l.roleId, roles)).reduce((s, l) => s + l.days, 0);
  const phaseTotal = phases.reduce((s, p) => s + (Number(p.days) || 0), 0);
  const remaining = maxDays - phaseTotal;
  const grossValue = lines.reduce((s, l) => s + l.days * lineRate(l), 0);
  const value = discountMode === "total" ? Math.max(0, grossValue - discountValue) : grossValue;
  const listValue = lines.reduce((s, l) => s + l.days * l.rate, 0);
  const savings = listValue - value;
  const effRate = maxDays > 0 ? value / maxDays : 0;
  const listRate = maxDays > 0 ? listValue / maxDays : 0;
  const tax = taxed ? value * (taxRate / 100) : 0;
  const canSave = name.trim().length > 0;
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "";
  const editingProject = !!project?.projectTypeId || !!project?.kickoffDate;
  const svc = projectTypes.find((t) => t.id === projectTypeId);
  const service = svc?.name ?? "";
  const unit = "day" as const;
  const svcRate = (roleId: string) => svc?.roles?.find((r) => r.roleId === roleId)?.price;
  /** Picking a service on a project with no roles yet brings in the service's roles at their list price. */
  const pickService = (id: string) => {
    setProjectTypeId(id);
    const s = projectTypes.find((t) => t.id === id);
    if (!lines.length && s?.roles?.length) {
      const ordered = [...s.roles].sort((a, b) => Number(b.isMain) - Number(a.isMain));
      setLines(ordered.filter((r) => roles.some((x) => x.id === r.roleId))
        .map((r) => ({ roleId: r.roleId, days: 0, rate: r.price, discountMode: "none" as const, discountValue: 0 })));
    }
  };

  // everything the form edits, to know when there are unsaved changes
  const snapshot = JSON.stringify([name, legalName, vatNumber, projectTypeId, kickoffDate, signingDate, addr, contacts, lines,
    discountMode, discountValue, taxed, taxRate, paymentDays, phases, team]);
  const initial = useRef(snapshot);
  const dirty = snapshot !== initial.current;

  const closingRef = useRef(false);
  const [askDiscard, setAskDiscard] = useState(false);
  const askRef = useRef(false);
  askRef.current = askDiscard;
  const requestClose = (force = false) => {
    if (closingRef.current) return;
    if (dirty && !force) { setAskDiscard(true); return; }
    setAskDiscard(false);
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(onClose, reduceMotion() ? 0 : 260);
  };
  const closeRef = useRef(requestClose);
  useEffect(() => { closeRef.current = requestClose; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // a date or select popover handles its own Escape
      if (document.querySelector(".sel-layer, .dp-layer, .tp-layer")) return;
      if (askRef.current) { setAskDiscard(false); return; }
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        roleLines: lines.filter((l) => l.roleId),
        ...(() => {
          const c = legacyColumnsOf(lines, roles);
          return {
            consultorDays: c.consultor_days, connectorDays: c.connector_days, pricePerDay: c.price_per_day,
            supervisionDays: 0, supervisionPrice: 0, supervisionDiscountMode: "none" as const, supervisionDiscountValue: 0,
          };
        })(),
        taxed, taxRate: taxed ? taxRate : 0, paymentDays,
        discountMode, discountValue: discountMode === "none" ? 0 : discountValue,
        phases, team,
        status: project?.status ?? "open",
        endDate: project?.endDate ?? "",
      },
    );
  };

  /* ---- tabs + sliding ink ---- */
  const TABS: { v: Tab; label: string; n?: number; warn?: boolean }[] = [
    { v: "details", label: "Details", warn: !canSave },
    { v: "contacts", label: "Contacts", n: contacts.length },
    { v: "pricing", label: "Pricing" },
    { v: "plan", label: "Plan & team", n: phases.length || undefined, warn: remaining < 0 },
  ];
  const tabsRef = useRef<HTMLElement>(null);
  const [ink, setInk] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const nav = tabsRef.current;
    if (!nav) return;
    const place = () => {
      const b = nav.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
      if (b) setInk({ x: b.offsetLeft, w: b.offsetWidth });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [tab]);

  const blueprintOptions = useMemo(() => blueprints.filter((b) => {
    // A service points at its blueprint from the catalogue.
    const svc = projectTypes.find((s) => s.id === projectTypeId);
    if (svc?.blueprintId) return b.id === svc.blueprintId;
    return !projectTypeId || b.projectTypeId === projectTypeId;
  }).map((b) => ({ value: b.id, label: b.name || "Untitled blueprint" })), [blueprints, projectTypes, projectTypeId]);

  const planPct = maxDays > 0 ? Math.min(100, (phaseTotal / maxDays) * 100) : 0;
  const title = client ? name || "Client" : name || "New client";
  const eyebrow = client ? (editingProject ? "Edit project" : "New project") : "New client";
  const saveLabel = editingProject ? "Save changes" : client ? "Create project" : "Create client";

  return (
    <div className={`pf-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={() => requestClose()}>
      <div className={`pf ${soldFrom && showSold ? "has-sold" : ""}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={eyebrow}>
        {/* ---------- header ---------- */}
        <header className="pf-head">
          <span className="pf-glow" aria-hidden="true" />
          <button className="pf-x" onClick={() => requestClose()} aria-label="Close"><Ico n="x" s={17} /></button>
          <div className="pf-head-row">
            <div className="pf-id">
              <span className="pf-av">{initials(title)}</span>
              <div className="pf-id-t">
                <span className="pf-eyebrow">{eyebrow}</span>
                <h2 className="pf-title">{title}</h2>
                <div className="pf-meta">
                  {service ? <span><Ico n="tag" s={12} />{service}</span> : <span className="is-muted">No service yet</span>}
                  {kickoffDate && <span><Ico n="clock" s={12} />Kick-off {new Date(`${kickoffDate}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>}
                </div>
              </div>
            </div>
            <div className="pf-kpis">
              <div className="pf-kpi" style={vars({ "--i": 0 })}><span>Days</span><b><Num v={maxDays} /></b><small>{lines.length ? `${lines.length} role${lines.length === 1 ? "" : "s"} · ${countedDays} count` : "no roles yet"}</small></div>
              <div className="pf-kpi" style={vars({ "--i": 1 })}><span>Rate</span><b><Num v={effRate} /><em>€</em></b><small>{Math.round(effRate) !== Math.round(listRate) ? `list ${eur(listRate)}` : "per day, average"}</small></div>
              <div className="pf-kpi is-plan" style={vars({ "--i": 2 })}>
                <span>Planned</span><b className={remaining < 0 ? "is-over" : ""}><Num v={phaseTotal} /><em>/ {maxDays}d</em></b>
                <i className="pf-kpi-bar"><i style={{ width: `${planPct}%` }} className={remaining < 0 ? "is-over" : ""} /></i>
              </div>
              <div className="pf-kpi is-value" style={vars({ "--i": 3 })}><span>Value</span><b><Num v={value} /><em>€</em></b><small>{savings > 0 ? `−${eur(savings)} discount` : taxed ? `+${taxRate}% tax` : "before tax"}</small></div>
            </div>
          </div>
          <nav className="pf-tabs" ref={tabsRef} role="tablist">
            {ink && <span className="pf-tabs-ink" style={{ transform: `translateX(${ink.x}px)`, width: ink.w }} aria-hidden="true" />}
            {TABS.map((t, i) => (
              <button key={t.v} data-tab={t.v} role="tab" aria-selected={tab === t.v} className={tab === t.v ? "is-on" : ""}
                style={vars({ "--i": i })} onClick={() => setTab(t.v)}>
                <em>{i + 1}</em>{t.label}
                {t.n != null && <i>{t.n}</i>}
                {t.warn && <span className="pf-warn" aria-label="Needs attention" />}
              </button>
            ))}
            {soldFrom && (
              <button className={`pf-soldbtn ${showSold ? "is-on" : ""}`} onClick={() => setShowSold((v) => !v)}>
                <Ico n="eye" s={14} />Sold in sales
              </button>
            )}
          </nav>
        </header>

        {/* ---------- body ---------- */}
        <div className="pf-main">
          <div className="pf-body">
            <div className="pf-panel" key={tab}>
              {tab === "details" && (
                <div className="pf-grid is-2">
                  <Card icon="building" tone="green" title="Client" sub="Who the engagement is for" i={0}>
                    <div className="pf-fields">
                      <Field label="Client name" wide>
                        <input className={`pf-input ${!canSave ? "is-req" : ""}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Konsolidator Iberia" autoFocus={!client} />
                      </Field>
                      <Field label="Legal name"><input className="pf-input" value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Registered legal name" /></Field>
                      <Field label="VAT number"><input className="pf-input" value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} placeholder="e.g. ESB12345678" /></Field>
                      <Field label="Service" wide>
                        <Select value={projectTypeId} onChange={pickService} options={projectTypes.map((t) => ({ value: t.id, label: t.name }))} placeholder="Select service" />
                      </Field>
                      <Field label="Kick-off"><DatePicker value={kickoffDate} onChange={setKickoff} /></Field>
                      <Field label="Signing"><DatePicker value={signingDate} onChange={setSigning} /></Field>
                    </div>
                  </Card>

                  <Card icon="pin" tone="blue" title="Address" sub="Type a street and pick a suggestion" i={1}>
                    <div className="pf-fields">
                      <Field label="Street" wide>
                        <div className="pf-ac">
                          <input className="pf-input" placeholder="Start typing a street or address…" value={addr.street}
                            onChange={(e) => setAddrField("street", e.target.value)} onFocus={() => streetSug.length > 0 && setStreetOpen(true)} />
                          {streetOpen && streetSug.length > 0 && (
                            <div className="pf-ac-list">
                              {streetSug.map((sg, idx) => (
                                <button type="button" key={idx} style={vars({ "--i": idx })} onMouseDown={(e) => e.preventDefault()} onClick={() => pickStreet(sg)}>
                                  <Ico n="pin" s={13} />{sg.display_name}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </Field>
                      <Field label="Number">
                        <div className="pf-ac">
                          <input className="pf-input" value={addr.number} onChange={(e) => setAddrField("number", e.target.value)} onFocus={() => numSug.length > 0 && setNumOpen(true)} />
                          {numOpen && numSug.length > 0 && !streetOpen && (
                            <div className="pf-ac-list">
                              {numSug.map((sg, idx) => (
                                <button type="button" key={idx} style={vars({ "--i": idx })} onMouseDown={(e) => e.preventDefault()} onClick={() => pickNumber(sg)}>
                                  <b>{sg.address?.house_number}</b>{sg.display_name}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </Field>
                      <Field label="Details"><input className="pf-input" value={addr.details} onChange={(e) => setAddrField("details", e.target.value)} placeholder="Floor, door…" /></Field>
                      <Field label="Postal code"><input className="pf-input" value={addr.postalCode} onChange={(e) => setAddrField("postalCode", e.target.value)} /></Field>
                      <Field label="City"><input className="pf-input" value={addr.city} onChange={(e) => setAddrField("city", e.target.value)} /></Field>
                      <Field label="Country" wide><CountryPicker value={addr.country} as="name" onChange={(v) => setAddrField("country", v)} /></Field>
                    </div>
                  </Card>
                </div>
              )}

              {tab === "contacts" && (
                <Card icon="users" tone="violet" title="Contacts" i={0} className="is-narrow"
                  sub={contacts.length ? "Drag to set priority — #1 is the main contact" : "Who you talk to at the client"}
                  actions={<button className="pf-btn is-ghost" onClick={addContact}><Ico n="plus" s={14} />Add contact</button>}>
                  {contacts.length === 0 ? (
                    <button className="pf-empty" onClick={addContact}><Ico n="users" s={22} /><span>No contacts yet — add the first one</span></button>
                  ) : (
                    <ol className="pf-contacts">
                      {contacts.map((c, i) => {
                        const editing = editContact === c.id || !c.name;
                        return (
                          <li key={c.id || `c${i}`} style={vars({ "--i": i })}
                            className={`pf-contact ${editing ? "is-editing" : ""} ${dragIndex === i ? "is-drag" : ""} ${overIndex === i && dragIndex !== i ? "is-over" : ""}`}
                            onDragOver={(e) => { e.preventDefault(); setOverIndex(i); }} onDragLeave={() => setOverIndex(null)} onDrop={() => onDrop(i)}>
                            <span className="pf-grip" draggable onDragStart={() => setDragIndex(i)} onDragEnd={() => { setDragIndex(null); setOverIndex(null); }} title="Drag to reorder">
                              <Ico n="grip" s={16} />
                            </span>
                            <span className="pf-prio">{i + 1}</span>
                            {!editing ? (
                              <>
                                <button className="pf-contact-main" onClick={() => setEditContact(c.id)}>
                                  <span className="pf-ava" style={vars({ "--h": hue(c.name) })}>{initials(c.name)}</span>
                                  <span className="pf-contact-id">
                                    <b>{c.name}{c.billing && <em>Billing</em>}</b>
                                    <small>{[c.position, c.email, c.phone].filter(Boolean).join(" · ") || "No details"}</small>
                                  </span>
                                  <span className="pf-contact-edit"><Ico n="pen" s={14} /></span>
                                </button>
                                <button className="pf-icon is-danger" onClick={() => removeContact(c.id)} aria-label="Remove"><Ico n="trash" s={14} /></button>
                              </>
                            ) : (
                              <div className="pf-contact-form">
                                <div className="pf-fields is-3">
                                  <Field label="Name"><input className="pf-input" autoFocus placeholder="Full name" value={c.name} onChange={(e) => setContactField(c.id, "name", e.target.value)} /></Field>
                                  <Field label="Position"><input className="pf-input" placeholder="e.g. CFO" value={c.position} onChange={(e) => setContactField(c.id, "position", e.target.value)} /></Field>
                                  <Field label="Email"><input className="pf-input" placeholder="name@company.com" value={c.email} onChange={(e) => setContactField(c.id, "email", e.target.value)} /></Field>
                                  <Field label="Phone"><input className="pf-input" placeholder="+34 …" value={c.phone} onChange={(e) => setContactField(c.id, "phone", e.target.value)} /></Field>
                                </div>
                                <div className="pf-contact-foot">
                                  <label className="pf-toggle"><Switch on={c.billing} onChange={(v) => setContactField(c.id, "billing", v)} label="Billing contact" />Billing contact</label>
                                  <button className="pf-icon is-danger" onClick={() => removeContact(c.id)} aria-label="Remove"><Ico n="trash" s={14} /></button>
                                  <button className="pf-btn" onClick={() => setEditContact(null)} disabled={!c.name}><Ico n="check" s={14} />Done</button>
                                </div>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </Card>
              )}

              {tab === "pricing" && (
                <div className="pf-grid is-pricing">
                  <div className="pf-col">
                    <Card icon="briefcase" tone="green" title="Roles" sub="What was sold, role by role — each with its own rate and discount" i={0}>
                      <RoleLinesEditor lines={lines} roles={roles} onChange={setLines} unit={unit} rateOf={svcRate} />
                      <div className="pf-disc">
                        <span className="pf-label">Discount on the whole project</span>
                        <Chips value={discountMode} onChange={setDiscountMode} options={[{ v: "none", label: "None" }, { v: "total", label: "€ total" }]} />
                        <div className={`pf-disc-val ${discountMode !== "none" ? "is-on" : ""}`}>
                          <div className="pf-unit"><NumField min="0" value={discountValue} onChange={setDiscountValue} disabled={discountMode === "none"} /><i>€</i></div>
                        </div>
                      </div>
                    </Card>
                    <Card icon="clock" tone="blue" title="Terms" i={1}>
                      <div className="pf-terms">
                        <label className="pf-toggle"><Switch on={taxed} onChange={setTaxed} label="Taxed" />Taxed</label>
                        <div className={`pf-disc-val ${taxed ? "is-on" : ""}`}>
                          <div className="pf-unit"><NumField min="0" max="100" value={taxRate} onChange={setTaxRate} disabled={!taxed} placeholder="Rate" /><i>%</i></div>
                        </div>
                        <Field label="Days to pay from invoice"><div className="pf-unit"><NumField min="0" value={paymentDays} onChange={setPaymentDays} /><i>days</i></div></Field>
                      </div>
                    </Card>
                  </div>

                  <aside className="pf-receipt" style={vars({ "--i": 3 })}>
                    <header><Ico n="receipt" s={16} /><b>Quote</b><small>live</small></header>
                    <dl>
                      {lines.length === 0 && <div><dt>No roles yet</dt><dd>0 €</dd></div>}
                      {lines.map((l, k) => (
                        <div key={`${l.roleId}-${k}`}><dt>{roleNameOf(l.roleId, roles)} <small>{l.days}d × {eur(lineRate(l))}</small></dt><dd><Num v={l.days * lineRate(l)} suffix=" €" /></dd></div>
                      ))}
                      {discountMode === "total" && discountValue > 0 && <div className="is-disc"><dt>Discount on total</dt><dd>−{eur(Math.min(discountValue, grossValue))}</dd></div>}
                      {savings > 0 && <div className="is-save"><dt>Discount given</dt><dd>{eur(savings)}</dd></div>}
                      <div className="is-total"><dt>Total</dt><dd><Num v={value} suffix=" €" /></dd></div>
                      {taxed && <div><dt>Tax <small>{taxRate}%</small></dt><dd><Num v={tax} suffix=" €" /></dd></div>}
                      {taxed && <div className="is-grand"><dt>With tax</dt><dd><Num v={value + tax} suffix=" €" /></dd></div>}
                    </dl>
                    <p>{paymentDays ? `Paid ${paymentDays} days after each invoice.` : "No payment term set."}</p>
                  </aside>
                </div>
              )}

              {tab === "plan" && (
                <div className="pf-grid is-plan">
                  <Card icon="layers" tone="green" title="Phases" i={0}
                    sub={<span className={remaining < 0 ? "is-over" : ""}>{phaseTotal} of {maxDays} days planned · {remaining < 0 ? `${Math.abs(remaining)} over` : `${remaining} left`}</span>}
                    actions={<>
                      {blueprintOptions.length > 0 && <div className="pf-bp"><Select value="" onChange={applyBlueprint} options={blueprintOptions} placeholder="Apply a blueprint" /></div>}
                      <button className="pf-btn is-ghost" onClick={addPhase}><Ico n="plus" s={14} />Phase</button>
                    </>}>
                    <div className="pf-alloc">
                      {phases.map((p, i) => (
                        <span key={p.id} title={`${p.name || `Phase ${i + 1}`} · ${p.days}d`}
                          style={vars({ width: `${maxDays > 0 ? Math.min(100, ((Number(p.days) || 0) / Math.max(maxDays, phaseTotal)) * 100) : 0}%`, "--h": (150 + i * 37) % 360 })} />
                      ))}
                    </div>
                    {phases.length === 0 ? (
                      <button className="pf-empty" onClick={addPhase}><Ico n="layers" s={22} /><span>No phases yet — add one or apply a blueprint</span></button>
                    ) : (
                      <ol className="pf-phases">
                        {phases.map((p, i) => (
                          <li key={p.id} className="pf-phase" style={vars({ "--i": i, "--h": (150 + i * 37) % 360 })}>
                            <div className="pf-phase-h">
                              <span className="pf-phase-n">{i + 1}</span>
                              <input className="pf-input is-title" placeholder="Phase name" value={p.name} onChange={(e) => setPhase(p.id, "name", e.target.value)} />
                              <div className="pf-unit is-days"><NumField min="0" value={p.days} onChange={(n) => setPhase(p.id, "days", n)} /><i>d</i></div>
                              <button className="pf-icon is-danger" onClick={() => removePhase(p.id)} aria-label="Remove phase"><Ico n="trash" s={14} /></button>
                            </div>
                            <ul className="pf-ptasks">
                              {(p.tasks ?? []).map((t) => (
                                <li key={t.id}>
                                  <span className="pf-pdot" />
                                  <input className="pf-input is-flat" placeholder="Task" value={t.name} onChange={(e) => setTask(p.id, t.id, e.target.value)} />
                                  <button className="pf-icon" onClick={() => removeTask(p.id, t.id)} aria-label="Remove task"><Ico n="x" s={13} /></button>
                                </li>
                              ))}
                              <li><button className="pf-addtask" onClick={() => addTask(p.id)}><Ico n="plus" s={13} />Task</button></li>
                            </ul>
                          </li>
                        ))}
                      </ol>
                    )}
                  </Card>

                  <Card icon="users" tone="violet" title="Team" sub={team.length ? `${team.length} assigned` : "Who delivers it"} i={1}
                    actions={<button className="pf-btn is-ghost" onClick={addMember}><Ico n="plus" s={14} />Add</button>}>
                    {team.length === 0 ? (
                      <button className="pf-empty" onClick={addMember}><Ico n="users" s={22} /><span>No one assigned yet</span></button>
                    ) : (
                      <ul className="pf-team">
                        {team.map((m, i) => {
                          const editing = editMember === m.id || !m.userId;
                          if (!editing) {
                            return (
                              <li key={m.id} className="pf-member" style={vars({ "--i": i })}>
                                <button className="pf-member-main" onClick={() => setEditMember(m.id)}>
                                  <span className="pf-ava" style={vars({ "--h": hue(m.name) })}>{initials(m.name)}</span>
                                  <span className="pf-contact-id"><b>{m.name}</b><small>{roleName(m.role) || "No role"}</small></span>
                                </button>
                                <button className="pf-icon is-danger" onClick={() => removeMember(m.id)} aria-label="Remove"><Ico n="trash" s={14} /></button>
                              </li>
                            );
                          }
                          const role = roles.find((r) => r.id === m.role);
                          const opts = (role?.userIds ?? [])
                            .map((id) => people.find((p) => p.id === id))
                            .filter((p): p is { id: string; name: string } => Boolean(p))
                            .map((p) => ({ value: p.id, label: p.name }));
                          return (
                            <li key={m.id} className="pf-member is-editing" style={vars({ "--i": i })}>
                              <div className="pf-member-form">
                                <Select value={m.role} onChange={(v) => setMemberRole(m.id, v)} options={roles.map((r) => ({ value: r.id, label: r.name }))} placeholder="Select role" />
                                <Select value={m.userId ?? ""} onChange={(v) => setMemberUser(m.id, v)} options={opts} placeholder={m.role ? "Select person" : "Pick a role first"} disabled={!m.role} />
                              </div>
                              <button className="pf-icon is-danger" onClick={() => removeMember(m.id)} aria-label="Remove"><Ico n="trash" s={14} /></button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Card>
                </div>
              )}
            </div>
          </div>

          {/* what sales sold, as a reference */}
          {soldFrom && (
            <aside className={`pf-sold ${showSold ? "is-on" : ""}`} aria-hidden={!showSold}>
              <div className="pf-sold-in">
                <span className="pf-eyebrow">Sold in sales</span>
                <h4>{soldFrom.company}</h4>
                {soldFrom.pipeline && <p className="pf-sold-dest">{soldFrom.pipeline}</p>}
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
                        <div className="pf-sold-svc" key={i}>
                          <div className="pf-sold-svc-h"><span>{s.label}</span><b>{s.days ? `${s.days}d` : ""}</b></div>
                          {s.rows && s.rows.length > 0 && (
                            <table>
                              <thead><tr><th>Variable</th><th>Days</th><th>Rate</th><th>Amount</th></tr></thead>
                              <tbody>
                                {s.rows.map((r, k) => (
                                  <tr key={k}>
                                    <td title={r.detail}>{r.label}</td>
                                    <td>{r.days != null ? r.days : ""}</td>
                                    <td>{r.rate != null ? r.rate.toLocaleString("es-ES") : ""}</td>
                                    <td><b>{Math.round(r.amount).toLocaleString("es-ES")}</b></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      ))}
                      <dl className="pf-sold-sum">
                        <div><dt>Gross</dt><dd>{Math.round(gross).toLocaleString("es-ES")} €</dd></div>
                        {disc > 0 && <div className="is-disc"><dt>Discount</dt><dd>-{Math.round(disc).toLocaleString("es-ES")} €</dd></div>}
                        <div className="is-total"><dt>Total</dt><dd>{Math.round(net).toLocaleString("es-ES")} €</dd></div>
                        {days > 0 && <div><dt>Days</dt><dd>{days}</dd></div>}
                        {days > 0 && <div><dt>Per day</dt><dd>{Math.round(net / days).toLocaleString("es-ES")} €</dd></div>}
                      </dl>
                      {prods.length > 0 && <p className="pf-sold-ctx">Sold with {prods.map((s) => s.label).join(", ")} — licence, not delivered here.</p>}
                    </>
                  );
                })()}
              </div>
            </aside>
          )}
        </div>

        {/* ---------- footer ---------- */}
        <footer className="pf-foot">
          <span className={`pf-dirty ${dirty ? "is-on" : ""}`}><i />{dirty ? "Unsaved changes" : "No changes"}</span>
          <div className="pf-steps">
            {tab !== "details" && <button className="pf-btn is-ghost" onClick={() => setTab(TABS[TABS.findIndex((t) => t.v === tab) - 1].v)}>Back</button>}
            {tab !== "plan" && <button className="pf-btn is-ghost" onClick={() => setTab(TABS[TABS.findIndex((t) => t.v === tab) + 1].v)}>Next</button>}
          </div>
          <button className="pf-btn is-quiet" onClick={() => requestClose()}>Cancel</button>
          <button className="pf-btn is-save" onClick={submit} disabled={!canSave} title={canSave ? saveLabel : "Give the client a name first"}>
            <Ico n={editingProject ? "check" : "plus"} s={15} />{saveLabel}
          </button>
        </footer>

        {askDiscard && (
          <div className="pf-ask" onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setAskDiscard(false); }}>
            <div className="pf-ask-card" role="alertdialog" aria-modal="true" aria-label="Discard changes">
              <span className="pf-ask-ic"><Ico n="x" s={20} /></span>
              <h3>Discard your changes?</h3>
              <p>What you changed in this {editingProject ? "project" : client ? "project" : "client"} will be lost.</p>
              <div className="pf-ask-act">
                <button className="pf-btn is-quiet" autoFocus onClick={() => setAskDiscard(false)}>Keep editing</button>
                <button className="pf-btn is-danger" onClick={() => requestClose(true)}>Discard</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
