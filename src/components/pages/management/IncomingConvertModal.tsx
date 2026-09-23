/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import { markHandoffConverted, type Handoff } from "../sales/salesApi";
import DatePicker from "../../framework/DatePicker";
import Select from "../../framework/Select";
import type { Phase, TeamMember, ClientRole, ProjectType, Blueprint } from "./ClientsPage";
import "./IncomingConvertModal.css";

const uid = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()));
const eur = (n: number) => Math.round(n).toLocaleString("en-US");
const num = (n: number) => Number(n).toLocaleString("es-ES", { maximumFractionDigits: 2 });

/** Eased count-up for the header value (presentation only). */
function useCountUp(target: number, ms = 700) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { from.current = target; setV(target); return; }
    let raf = 0;
    const start = from.current, t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      const cur = start + (target - start) * e;
      from.current = cur; setV(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function NumField({ value, onChange, min = 0, step = 1, suffix }: {
  value: number; onChange: (n: number) => void; min?: number; step?: number; suffix?: string;
}) {
  return (
    <div className="icm-num">
      <input type="number" min={min} step={step} value={value === 0 ? "" : value}
        placeholder="0" onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />
      {suffix && <em>{suffix}</em>}
    </div>
  );
}

interface Props {
  handoff: Handoff;
  onClose: () => void;
  onConverted: () => void;
}

export default function IncomingConvertModal({ handoff, onClose, onConverted }: Props) {
  // Reference data (same sources as the Clients page)
  const [projectTypes, setProjectTypes] = useState<ProjectType[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [roles, setRoles] = useState<ClientRole[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [clientId, setClientId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  // Engagement fields
  const [projectTypeId, setProjectTypeId] = useState("");
  const [signingDate, setSigning] = useState("");
  const [kickoffDate, setKickoff] = useState("");
  const [consultorDays, setConsultorDays] = useState(0);
  const [connectorDays, setConnectorDays] = useState(0);
  const [pricePerDay, setPricePerDay] = useState(0);
  const [supervisionDays, setSupervisionDays] = useState(0);
  const [supervisionPrice, setSupervisionPrice] = useState(0);
  const [paymentDays, setPaymentDays] = useState(0);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [editMember, setEditMember] = useState<string | null>(null);

  // --- Sales breakdown (read-only) -----------------------------------------
  const svcs = useMemo(() => (handoff.services ?? []).filter((s) => s.kind !== "product"), [handoff]);
  const prods = useMemo(() => (handoff.services ?? []).filter((s) => s.kind === "product"), [handoff]);
  const soldDays = useMemo(() => svcs.reduce((s, x) => s + (Number(x.days) || 0), 0), [svcs]);
  const soldValue = useMemo(() => svcs.reduce((s, x) => s + (Number(x.price) || 0), 0), [svcs]);
  const soldRate = soldDays > 0 ? soldValue / soldDays : (svcs[0]?.rate ?? 0);

  useEffect(() => {
    (async () => {
      const [pts, bps, rls, cli] = await Promise.all([
        supabase.from("services").select("id,name,blueprint_id,active").order("name"),
        supabase.from("phase_blueprints").select("*"),
        supabase.from("client_roles").select("*"),
        handoff.company_id
          ? supabase.from("clients").select("id, project_type_id, signing_date, payment_days").eq("company_id", handoff.company_id).limit(1)
          : Promise.resolve({ data: [] } as any),
      ]);
      setProjectTypes(((pts.data ?? []) as any[]).filter((r) => r.active !== false)
        .map((r) => ({ id: r.id, name: r.name, blueprintId: r.blueprint_id ?? null })));
      setBlueprints(((bps.data ?? []) as any[]).map((r) => ({
        id: r.id, name: r.name ?? "", projectTypeId: r.service_id ?? r.project_type_id ?? "", phases: r.phases ?? [],
      })));
      setRoles(((rls.data ?? []) as any[]).map((r) => ({
        id: r.id, name: r.name ?? "", userIds: r.user_ids ?? [], isSupervision: !!r.is_supervision,
      })));

      // Auto-fill from the client sales already created.
      const c: any = (cli as any).data?.[0];
      if (c) {
        setClientId(c.id);
        if (c.project_type_id) setProjectTypeId(c.project_type_id);
        if (c.signing_date) setSigning(c.signing_date);
        setPaymentDays(Number(c.payment_days) || 0);
      }
      // Rate comes from what sales sold; consultancy days start from the sold days.
      setPricePerDay(Math.round(soldDays > 0 ? soldValue / soldDays : (svcs[0]?.rate ?? 0)));
      setConsultorDays(Math.round(soldDays));
      setReady(true);
    })();

    supabase.functions.invoke("manage-users", { body: { action: "list" } }).then(({ data }) => {
      type U = { id: string; first_name?: string | null; last_name?: string | null; username?: string | null; email?: string | null };
      setPeople(((data?.users ?? []) as U[]).map((u) => ({
        id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—",
      })));
    }).catch(() => {});
  }, [handoff.company_id]); // eslint-disable-line

  // If project type has a blueprint in the catalogue and we haven't matched by
  // name yet, try to line the project type up with a sold service by name.
  useEffect(() => {
    if (projectTypeId || !projectTypes.length || !svcs.length) return;
    const primary = [...svcs].sort((a, b) => (b.days ?? 0) - (a.days ?? 0))[0];
    const match = projectTypes.find((p) => p.name.toLowerCase() === (primary?.label ?? "").toLowerCase());
    if (match) setProjectTypeId(match.id);
  }, [projectTypes, svcs, projectTypeId]);

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
  const addMember = () => { const id = uid(); setTeam((t) => [...t, { id, name: "", role: "", userId: "" }]); setEditMember(id); };
  const setMemberRole = (id: string, roleId: string) => setTeam((t) => t.map((x) => (x.id === id ? { ...x, role: roleId, userId: "", name: "" } : x)));
  const setMemberUser = (id: string, userId: string) => { setTeam((t) => t.map((x) => (x.id === id ? { ...x, userId, name: people.find((p) => p.id === userId)?.name ?? "" } : x))); setEditMember(null); };
  const removeMember = (id: string) => setTeam((t) => t.filter((x) => x.id !== id));
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "";

  // Phase editing (same model as the Clients form)
  const setPhaseField = (id: string, patch: Partial<Phase>) => setPhases((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removePhase = (id: string) => setPhases((p) => p.filter((x) => x.id !== id));
  const addPhase = () => setPhases((p) => [...p, { id: uid(), name: "", days: 0, tasks: [] }]);

  const totalConsultancy = consultorDays + connectorDays;
  const value = totalConsultancy * pricePerDay + supervisionDays * supervisionPrice;
  const phaseTotal = phases.reduce((s, p) => s + (Number(p.days) || 0), 0);
  const maxDays = totalConsultancy + supervisionDays;
  const ptName = projectTypes.find((p) => p.id === projectTypeId)?.name ?? "—";

  const canSave = !!clientId && !!kickoffDate && (consultorDays + connectorDays + supervisionDays) > 0 && !saving;

  const save = async () => {
    if (!canSave || !clientId) return;
    setSaving(true);
    try {
      const projectId = uid();
      const { error } = await supabase.from("projects").upsert({
        id: projectId,
        client_id: clientId,
        service_id: projectTypeId || null,
        kickoff_date: kickoffDate || null,
        signing_date: signingDate || null,
        consultor_days: consultorDays,
        connector_days: connectorDays,
        price_per_day: pricePerDay,
        supervision_days: supervisionDays,
        supervision_price: supervisionPrice,
        payment_days: paymentDays,
        phases, team,
        status: "open",
      });
      if (error) { alert(`Could not create project: ${error.message}`); return; }
      await markHandoffConverted(handoff.id, clientId, projectId).catch(() => {});
      onConverted();
    } finally { setSaving(false); }
  };

  /* ---------- presentation ---------- */
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => onCloseRef.current(), reduced ? 0 : 280);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [requestClose]);
  const shownValue = useCountUp(value);
  // Why the button is off, from the same conditions canSave checks.
  const missing = !ready ? null
    : !clientId ? "No client found for this company yet"
    : !kickoffDate ? "Pick a kick-off date to create the project"
    : (consultorDays + connectorDays + supervisionDays) <= 0 ? "Add at least one day"
    : null;
  const phasePct = maxDays > 0 ? Math.min(100, (phaseTotal / maxDays) * 100) : 0;
  const over = phaseTotal > maxDays;

  // Rendered at the top of the page so no parent stacking layer can sit above it.
  return createPortal(
    <div className={`icm-root ${closing ? "is-closing" : ""}`}>
      <div className="icm-backdrop" onMouseDown={requestClose} />
      <div className="icm" role="dialog" aria-modal="true" aria-label={`Build project for ${handoff.company_name || "this handoff"}`}>
        <div className="icm-aurora" aria-hidden="true"><i /><i /><span /></div>

        {/* Header */}
        <header className="icm-head">
          <div className="icm-head-id">
            <span className="icm-av">{(handoff.company_name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>
            <div className="icm-head-txt">
              <span className="icm-eyebrow">Build project from a handoff</span>
              <h2 className="icm-title">{handoff.company_name || "New project"}</h2>
              <p className="icm-route">
                <span>Sales</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7" /></svg>
                <b>{handoff.dest_pipeline_name || "Delivery"}</b>
              </p>
            </div>
          </div>
          <div className="icm-head-right">
            <div className="icm-total">
              <span>Engagement value</span>
              <b>{eur(shownValue)}<em>€</em></b>
            </div>
            <div className="icm-go">
              <button type="button" className="icm-primary" disabled={!canSave} onClick={save}>
                {saving ? "Creating…" : "Create project"}
                {!saving && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7" /></svg>}
              </button>
              {missing && <small className="icm-missing">{missing}</small>}
            </div>
            <button type="button" className="icm-x" onClick={requestClose} aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
              <kbd>Esc</kbd>
            </button>
          </div>
        </header>

        <div className="icm-body">
          {/* LEFT — what sales sent, read only */}
          <aside className="icm-left">
            <div className="icm-left-head">
              <span className="icm-sec-eyebrow">Sent by sales</span>
              <span className="icm-locked">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 8 0v4" /></svg>
                Read-only
              </span>
            </div>
            <ul className="icm-sold">
              {svcs.map((s, i) => (
                <li className="icm-sold-item" key={i} style={{ animationDelay: `${i * 60 + 250}ms` }}>
                  <div className="icm-sold-top">
                    <span className="icm-sold-name">{s.label}</span>
                    <span className="icm-sold-amt">{eur(s.price || 0)} €</span>
                  </div>
                  <div className="icm-sold-meta">
                    {s.days ? <span>{num(s.days)} days</span> : null}
                    {s.rate ? <span>{eur(s.rate)} €/day</span> : null}
                  </div>
                  {(s.rows ?? []).length > 0 && (
                    <ul className="icm-sold-rows">
                      {(s.rows ?? []).map((r, j) => (
                        <li key={j}>
                          <span className="icm-r-l">{r.label}</span>
                          <span className="icm-r-a">{eur(r.amount)} €</span>
                          <span className="icm-r-d">{r.detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {prods.length > 0 && (
              <div className="icm-sold-prods">
                <span className="icm-sec-eyebrow">Sold with</span>
                <div>{prods.map((p, i) => <em key={i}>{p.label}{p.price > 0 ? ` · ${eur(p.price)} €` : ""}</em>)}</div>
              </div>
            )}
            <div className="icm-sold-foot">
              <div><span>Days sold</span><b>{num(soldDays)}</b></div>
              <div><span>Value</span><b>{eur(soldValue)} €</b></div>
              <div><span>Rate</span><b>{eur(soldRate)} €/d</b></div>
            </div>
          </aside>

          {/* RIGHT — engagement */}
          <section className="icm-right">
            {!ready ? (
              <div className="icm-loading"><span /><span /><span /></div>
            ) : (
              <>
                {/* Auto-filled context */}
                <div className="icm-auto">
                  <div className="icm-auto-cell">
                    <span>Project type</span>
                    <b>{ptName}</b>
                    <i>from sales</i>
                  </div>
                  <div className="icm-auto-cell">
                    <span>Signing date</span>
                    <b>{signingDate ? new Date(signingDate).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—"}</b>
                    <i>from sales</i>
                  </div>
                  <div className="icm-auto-cell">
                    <span>Payment terms</span>
                    <b>{paymentDays} net days</b>
                    <i>from sales</i>
                  </div>
                </div>

                {/* Kick-off */}
                <div className={`icm-block ${kickoffDate ? "is-done" : "is-needed"}`} style={{ animationDelay: "280ms" }}>
                  <div className="icm-block-head">
                    <span className="icm-step">1</span>
                    <span className="icm-sec-title">Kick-off date</span>
                    {!kickoffDate && <span className="icm-req">Required</span>}
                  </div>
                  <div className="icm-date"><DatePicker value={kickoffDate} onChange={setKickoff} placeholder="Select kick-off" /></div>
                </div>

                {/* Consultancy */}
                <div className="icm-block" style={{ animationDelay: "330ms" }}>
                  <div className="icm-block-head">
                    <span className="icm-step">2</span>
                    <span className="icm-sec-title">Consultancy</span>
                    <span className="icm-rate-pill">{eur(pricePerDay)} €/day <em>from the sold rate</em></span>
                  </div>
                  <div className="icm-grid2">
                    <div className="icm-field"><label>Consultor days</label><NumField value={consultorDays} onChange={setConsultorDays} suffix="d" /></div>
                    <div className="icm-field"><label>Connector days</label><NumField value={connectorDays} onChange={setConnectorDays} suffix="d" /></div>
                  </div>
                  <div className="icm-line"><span>{num(totalConsultancy)} days × {eur(pricePerDay)} €</span><b>{eur(totalConsultancy * pricePerDay)} €</b></div>
                </div>

                {/* Supervision */}
                <div className="icm-block" style={{ animationDelay: "380ms" }}>
                  <div className="icm-block-head">
                    <span className="icm-step">3</span>
                    <span className="icm-sec-title">Supervision</span>
                  </div>
                  <div className="icm-grid2">
                    <div className="icm-field"><label>Days</label><NumField value={supervisionDays} onChange={setSupervisionDays} suffix="d" /></div>
                    <div className="icm-field"><label>Price / day</label><NumField value={supervisionPrice} onChange={setSupervisionPrice} suffix="€" /></div>
                  </div>
                  {supervisionDays > 0 && <div className="icm-line"><span>{num(supervisionDays)} days × {eur(supervisionPrice)} €</span><b>{eur(supervisionDays * supervisionPrice)} €</b></div>}
                </div>

                {/* Blueprint + phases */}
                <div className="icm-block" style={{ animationDelay: "430ms" }}>
                  <div className="icm-block-head">
                    <span className="icm-step">4</span>
                    <span className="icm-sec-title">Phases</span>
                    <span className="icm-phase-sum" data-over={over ? "1" : undefined}>{num(phaseTotal)} / {num(maxDays)} days</span>
                  </div>
                  <span className={`icm-alloc ${over ? "is-over" : ""}`} aria-hidden="true"><i style={{ width: `${phasePct}%` }} /></span>
                  <div className="icm-bp">
                    <Select value="" onChange={applyBlueprint}
                      options={blueprints.filter((b) => {
                        const svc = projectTypes.find((s) => s.id === projectTypeId);
                        if (svc?.blueprintId) return b.id === svc.blueprintId;
                        return !projectTypeId || b.projectTypeId === projectTypeId;
                      }).map((b) => ({ value: b.id, label: b.name || "Untitled blueprint" }))}
                      placeholder="Apply a blueprint" />
                  </div>
                  {phases.length === 0 && <p className="icm-hint">No phases yet. Apply a blueprint or add one.</p>}
                  <ul className="icm-phases">
                    {phases.map((p, pi) => (
                      <li className="icm-phase" key={p.id}>
                        <span className="icm-phase-n">{pi + 1}</span>
                        <input className="icm-phase-name" value={p.name} placeholder="Phase name" onChange={(e) => setPhaseField(p.id, { name: e.target.value })} />
                        <div className="icm-num icm-phase-days"><input type="number" min={0} value={p.days === 0 ? "" : p.days} placeholder="0" onChange={(e) => setPhaseField(p.id, { days: e.target.value === "" ? 0 : Number(e.target.value) })} /><em>d</em></div>
                        <button type="button" className="icm-rm" onClick={() => removePhase(p.id)} aria-label="Remove phase">×</button>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="icm-add" onClick={addPhase}>+ Add phase</button>
                </div>

                {/* Team */}
                <div className="icm-block" style={{ animationDelay: "480ms" }}>
                  <div className="icm-block-head">
                    <span className="icm-step">5</span>
                    <span className="icm-sec-title">Team</span>
                    {team.length > 0 && <span className="icm-phase-sum">{team.filter((m) => m.userId).length} assigned</span>}
                  </div>
                  {team.length === 0 && <p className="icm-hint">No one assigned yet.</p>}
                  <ul className="icm-team">
                    {team.map((m) => {
                      const role = roles.find((r) => r.id === m.role);
                      const opts = (role?.userIds ?? []).map((uidv) => ({ value: uidv, label: people.find((p) => p.id === uidv)?.name ?? "—" }));
                      const isEditing = editMember === m.id || !m.userId;
                      return (
                        <li className="icm-member" key={m.id}>
                          {isEditing ? (
                            <>
                              <Select value={m.role} onChange={(v) => setMemberRole(m.id, v)} options={roles.map((r) => ({ value: r.id, label: r.name }))} placeholder="Select role" />
                              <Select value={m.userId} onChange={(v) => setMemberUser(m.id, v)} options={opts} placeholder={m.role ? "Select person" : "Pick a role first"} disabled={!m.role} />
                            </>
                          ) : (
                            <button type="button" className="icm-member-set" onClick={() => setEditMember(m.id)} title="Change">
                              <span className="icm-member-av">{(m.name || "?").charAt(0).toUpperCase()}</span>
                              <span><b>{m.name}</b><small>{roleName(m.role)}</small></span>
                            </button>
                          )}
                          <button type="button" className="icm-rm" onClick={() => removeMember(m.id)} aria-label="Remove member">×</button>
                        </li>
                      );
                    })}
                  </ul>
                  <button type="button" className="icm-add" onClick={addMember}>+ Add member</button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body
  );
}