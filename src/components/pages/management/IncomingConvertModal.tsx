/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../api/supabase";
import { markHandoffConverted, type Handoff } from "../sales/sales/salesApi";
import DatePicker from "../../framework/DatePicker";
import Select from "../../framework/Select";
import type { Phase, TeamMember, ClientRole, ProjectType, Blueprint } from "./ClientsPage";
import { destFolder, destOptions, type HandoffDoc, type HandoffPackage } from "../sales/trackings/HandoffConfirmServices";
import { FileIcon, kindOf, prettySize, openTrackingFile } from "../sales/trackings/TrackingFiles";
import { copyIntoClientFolders } from "../clients/ClientDirectory";
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
  /** Discounts sales gave: consultancy as € off the total, supervision as € off each day. */
  const [discount, setDiscount] = useState(0);
  const [supDiscount, setSupDiscount] = useState(0);
  const [paymentDays, setPaymentDays] = useState(0);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [editMember, setEditMember] = useState<string | null>(null);

  // --- What sales handed over that lands on the client ----------------------
  const pkg: HandoffPackage | null = (handoff as any).package?.v ? (handoff as any).package : null;
  /** The client as it is now, to compare with what sales sent. */
  const [clientNow, setClientNow] = useState<any>(null);
  /** keep = leave the client as is · fill = only empty fields · update = overwrite with sales' data. */
  const [clientMode, setClientMode] = useState<"keep" | "fill" | "update">(pkg?.client?.mode === "update" ? "update" : "fill");
  const [folders, setFolders] = useState<string[]>([]);
  const [existing, setExisting] = useState<{ folder: string; name: string; size: number | null }[]>([]);
  const [docDest, setDocDest] = useState<Record<string, string>>({});
  /** What sales sold, split: consultancy and supervision days at their own rates. */
  const [sold, setSold] = useState<{ conDays: number; conRate: number; supDays: number; supRate: number } | null>(null);

  // --- Sales breakdown (read-only) -----------------------------------------
  const svcs = useMemo(() => (handoff.services ?? []).filter((s) => s.kind !== "product"), [handoff]);
  const prods = useMemo(() => (handoff.services ?? []).filter((s) => s.kind === "product"), [handoff]);
  const soldDays = useMemo(() => svcs.reduce((s, x) => s + (Number(x.days) || 0), 0), [svcs]);
  const soldValue = useMemo(() => svcs.reduce((s, x) => s + (Number(x.price) || 0), 0), [svcs]);
  const soldRate = soldDays > 0 ? soldValue / soldDays : (svcs[0]?.rate ?? 0);

  useEffect(() => {
    (async () => {
      // Names of the calculator variables marked as supervision (Settings): older
      // handoffs don't carry the flag, so their rows are matched by name.
      const supNames = new Set<string>();
      {
        const { data, error } = await supabase.from("calculator_variables").select("name").eq("is_supervision", true);
        if (!error) (data ?? []).forEach((v: any) => v.name && supNames.add(String(v.name).trim().toLowerCase()));
      }
      const [pts, bps, rls, cli] = await Promise.all([
        supabase.from("services").select("id,name,blueprint_id,active").order("name"),
        supabase.from("phase_blueprints").select("*"),
        supabase.from("client_roles").select("*"),
        handoff.company_id
          ? supabase.from("clients").select("*").eq("company_id", handoff.company_id).limit(1)
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
        setClientNow(c);
        if (c.project_type_id) setProjectTypeId(c.project_type_id);
        if (c.signing_date) setSigning(c.signing_date);
        setPaymentDays(Number(pkg?.client?.paymentDays ?? c.payment_days) || 0);
        // The client's folders and files: offered as destinations, and used to
        // spot documents that are already there.
        const [{ data: fo }, { data: fi }] = await Promise.all([
          supabase.from("client_folders").select("id, name, parent_id").eq("client_id", c.id),
          supabase.from("client_files").select("name, size_bytes, folder_id").eq("client_id", c.id),
        ]);
        const roots = ((fo ?? []) as any[]).filter((f) => !f.parent_id);
        setFolders(roots.map((f) => String(f.name)));
        const nameOf = new Map(roots.map((f) => [f.id, String(f.name)]));
        const ex = ((fi ?? []) as any[]).filter((f) => nameOf.has(f.folder_id)).map((f) => ({ folder: nameOf.get(f.folder_id)!, name: String(f.name), size: f.size_bytes ?? null }));
        setExisting(ex);
        // Default destination: what sales picked, unless that exact file is already in that folder.
        const dd: Record<string, string> = {};
        (pkg?.documents ?? []).forEach((d) => {
          const dest = d.dest ?? "skip";
          const folder = destFolder(dest);
          const dup = !!folder && ex.some((x) => x.folder.toLowerCase() === folder.toLowerCase() && x.name === d.name && (x.size == null || d.size == null || x.size === d.size));
          dd[d.id] = dup ? "skip" : dest;
        });
        setDocDest(dd);
      }
      // Split what sales sold: the calculator's supervision variable gives the
      // supervision days and their rate; everything else is consultancy, at the
      // line's own rate (not an average of the two).
      let supDays = 0, supValue = 0, conDays = 0, conValue = 0, supOff = 0, soldNet = 0;
      svcs.forEach((sv: any) => {
        const total = Number(sv.days) || 0;
        const rows = (sv.rows ?? []) as any[];
        const supRows = rows.filter((r) => r.supervision || supNames.has(String(r.label ?? "").trim().toLowerCase()));
        const sd = sv.supervision_days != null ? Number(sv.supervision_days) || 0 : supRows.reduce((a, r) => a + (Number(r.days) || 0), 0);
        const sr = sv.supervision_rate != null ? Number(sv.supervision_rate) || 0
          : sd > 0 ? supRows.reduce((a, r) => a + (Number(r.amount) || 0), 0) / sd : 0;
        const cd = Math.max(0, total - sd);
        const cr = Number(sv.rate) || (total > 0 ? (Number(sv.price) || 0) / total : 0);
        supDays += sd; supValue += sd * sr; conDays += cd; conValue += cd * cr;
        supOff += supRows.reduce((a, r) => a + (Number(r.discount) || 0), 0);
        soldNet += Number(sv.price) || 0;
      });
      // Whatever the full rates add up to beyond what was sold is the discount
      // sales gave (row discounts): supervision keeps its own, the rest comes off
      // the consultancy total, so the project is worth exactly what was sold.
      const supPerDay = supDays > 0 ? Math.round((supOff / supDays) * 100) / 100 : 0;
      const conRateR = Math.round(conDays > 0 ? conValue / conDays : 0);
      const supRateR = Math.round(supDays > 0 ? supValue / supDays : 0);
      const grossAtRates = conDays * conRateR + supDays * Math.max(0, supRateR - supPerDay);
      const rest = Math.round((grossAtRates - soldNet) * 100) / 100;
      setSupDiscount(supPerDay);
      setDiscount(rest > 0.5 ? rest : 0);
      setConsultorDays(Math.round(conDays * 100) / 100);
      setPricePerDay(Math.round(conDays > 0 ? conValue / conDays : (svcs[0]?.rate ?? 0)));
      setSupervisionDays(Math.round(supDays * 100) / 100);
      setSupervisionPrice(Math.round(supDays > 0 ? supValue / supDays : 0));
      setSold({ conDays, conRate: conDays > 0 ? conValue / conDays : 0, supDays, supRate: supDays > 0 ? supValue / supDays : 0 });
      // The signing date comes from sales (per service in the handoff).
      const signed = (pkg?.services ?? []).map((x) => x.signingDate).filter(Boolean).sort()[0];
      if (signed) setSigning(signed);
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
  const consultancyNet = Math.max(0, totalConsultancy * pricePerDay - discount);
  const supervisionNet = supervisionDays * Math.max(0, supervisionPrice - supDiscount);
  const value = consultancyNet + supervisionNet;
  const phaseTotal = phases.reduce((s, p) => s + (Number(p.days) || 0), 0);
  const maxDays = totalConsultancy + supervisionDays;
  const ptName = projectTypes.find((p) => p.id === projectTypeId)?.name ?? "—";

  /* ---- client details: what changes for each choice ---- */
  const CLIENT_FIELDS: { key: string; label: string; now: (c: any) => string; sent: (p: NonNullable<HandoffPackage["client"]>) => string }[] = [
    { key: "legal_name", label: "Legal name", now: (c) => c?.legal_name ?? "", sent: (p) => p.legalName ?? "" },
    { key: "vat_number", label: "VAT / Tax ID", now: (c) => c?.vat_number ?? "", sent: (p) => p.vatNumber ?? "" },
    { key: "payment_days", label: "Payment terms", now: (c) => (c?.payment_days != null && c.payment_days !== "" ? String(c.payment_days) : ""), sent: (p) => (p.paymentDays != null ? String(p.paymentDays) : "") },
    ...(["street", "number", "details", "postalCode", "city", "country"] as const).map((k) => ({
      key: `address.${k}`, label: { street: "Street", number: "Number", details: "Address details", postalCode: "Postal code", city: "City", country: "Country" }[k],
      now: (c: any) => String(c?.address?.[k] ?? ""), sent: (p: any) => String(p.address?.[k] ?? ""),
    })),
  ];
  const clientRows = pkg?.client ? CLIENT_FIELDS.map((f) => {
    const now = f.now(clientNow).trim(); const sent = f.sent(pkg.client!).trim();
    const takes = !!sent && sent !== now && (clientMode === "update" || (clientMode === "fill" && !now));
    return { ...f, nowV: now, sentV: sent, differs: !!sent && sent !== now, takes };
  }) : [];
  const changing = clientRows.filter((r) => r.takes).length;
  const clientPatch = (): Record<string, any> | null => {
    if (!pkg?.client || clientMode === "keep" || !changing) return null;
    const patch: Record<string, any> = {};
    const addr = { ...(clientNow?.address ?? {}) };
    let addrTouched = false;
    clientRows.filter((r) => r.takes).forEach((r) => {
      if (r.key.startsWith("address.")) { addr[r.key.slice(8)] = r.sentV; addrTouched = true; }
      else if (r.key === "payment_days") patch.payment_days = Number(r.sentV) || 0;
      else patch[r.key] = r.sentV;
    });
    if (addrTouched) patch.address = addr;
    return patch;
  };
  const docOpts = useMemo(() => destOptions(folders), [folders]);
  const isDup = (d: HandoffDoc, dest: string) => {
    const folder = destFolder(dest);
    return !!folder && existing.some((x) => x.folder.toLowerCase() === folder.toLowerCase() && x.name === d.name && (x.size == null || d.size == null || x.size === d.size));
  };
  const docsIn = (pkg?.documents ?? []).filter((d) => destFolder(docDest[d.id] ?? "skip")).length;

  const canSave = !!clientId && !!signingDate && !!kickoffDate && (consultorDays + connectorDays + supervisionDays) > 0 && !saving;

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
        discount_mode: discount > 0 ? "total" : "none",
        discount_value: discount > 0 ? discount : 0,
        supervision_discount_mode: supDiscount > 0 ? "rate" : "none",
        supervision_discount_value: supDiscount > 0 ? supDiscount : 0,
        payment_days: paymentDays,
        phases, team,
        status: "open",
      });
      if (error) { alert(`Could not create project: ${error.message}`); return; }

      const problems: string[] = [];
      // Client details, as chosen: keep, fill only the blanks, or update.
      const patch = clientPatch();
      if (patch) {
        const { error: cErr } = await supabase.from("clients").update(patch).eq("id", clientId);
        if (cErr) problems.push(`Client details: ${cErr.message}`);
      }
      // Documents are added to the client's folders, next to what is already there.
      const docs = (pkg?.documents ?? []).map((d) => ({ d, folder: destFolder(docDest[d.id] ?? "skip") })).filter((x): x is { d: HandoffDoc; folder: string } => !!x.folder);
      if (docs.length) {
        const res = await copyIntoClientFolders(clientId, docs.map(({ d, folder }) => ({
          key: d.id, fromBucket: d.bucket, fromPath: d.path, name: d.name, mime: d.mime, size: d.size, note: d.note, folder,
        })));
        problems.push(...res.errors);
        const copied = Object.keys(res.done);
        // The sales copy no longer needs to show on the client page.
        if (copied.length) await Promise.resolve(supabase.from("tracking_files").update({ share_client: false }).in("id", copied)).catch(() => null);
      }

      await markHandoffConverted(handoff.id, clientId, projectId).catch(() => {});
      if (problems.length) alert(`Project created. Some things could not be brought over:\n\n${problems.join("\n")}`);
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
    : !signingDate ? "Set the signing date"
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
            <div className="icm-total" title="Engagement value" aria-label={`Engagement value: ${eur(value)} €`}>
              <i aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 6.5A6.5 6.5 0 1 0 17 17.5M4 10.5h9M4 13.5h9" /></svg>
              </i>
              <b>{eur(shownValue)}<em>€</em></b>
            </div>
            <button type="button" className="icm-primary" disabled={!canSave} onClick={save} title={missing ?? undefined}>
              {missing && (
                <span className="icm-missing-ico" aria-label={missing}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
                </span>
              )}
              {saving ? "Creating…" : "Create project"}
              {!saving && !missing && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7" /></svg>}
            </button>
            <button type="button" className="icm-x" onClick={requestClose} aria-label="Close (Esc)" title="Close (Esc)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
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
                          <span className="icm-r-a">{eur(r.amount)} €{r.discount ? <i className="icm-r-off"> −{eur(r.discount)} €</i> : null}</span>
                          <span className="icm-r-d">{r.detail}</span>
                        </li>
                      ))}
                      {/* What the rows add up to vs what was sold: the gap is the discount. */}
                      {Math.round((s.rows ?? []).reduce((a, r) => a + (Number(r.amount) || 0), 0) - (Number(s.price) || 0)) > 0 && (
                        <li className="icm-r-sum">
                          <span className="icm-r-l">Discount given</span>
                          <span className="icm-r-a">−{eur((s.rows ?? []).reduce((a, r) => a + (Number(r.amount) || 0), 0) - (Number(s.price) || 0))} €</span>
                        </li>
                      )}
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
              {sold && sold.supDays > 0 ? (
                <>
                  <div><span>Consultancy</span><b>{num(sold.conDays)}d · {eur(sold.conRate)} €</b></div>
                  <div><span>Supervision</span><b>{num(sold.supDays)}d · {eur(sold.supRate)} €</b></div>
                </>
              ) : <div><span>Rate</span><b>{eur(sold?.conRate || soldRate)} €/d</b></div>}
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
                  <div className={`icm-auto-cell ${signingDate ? "" : "is-needed"}`}>
                    <span>Signing date</span>
                    {(pkg?.services ?? []).some((x) => x.signingDate) && signingDate ? (
                      <>
                        <b>{new Date(`${signingDate}T12:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}</b>
                        <i>from sales</i>
                      </>
                    ) : (
                      <>
                        <div className="icm-auto-date"><DatePicker value={signingDate} onChange={setSigning} placeholder="Pick the date" /></div>
                        <i className="is-warn">{signingDate ? "set here" : "sales didn't send it"}</i>
                      </>
                    )}
                  </div>
                  <div className="icm-auto-cell">
                    <span>Payment terms</span>
                    <b>{paymentDays} net days</b>
                    <i>from sales</i>
                  </div>
                </div>

                {/* What lands on the client */}
                {pkg && (pkg.client || (pkg.documents?.length ?? 0) > 0 || (pkg.notes?.length ?? 0) > 0 || (pkg.tasks?.length ?? 0) > 0) && (
                  <div className="icm-block icm-bring" style={{ animationDelay: "250ms" }}>
                    <div className="icm-block-head">
                      <span className="icm-step">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" /></svg>
                      </span>
                      <span className="icm-sec-title">Bring into the client</span>
                      <span className="icm-phase-sum">{clientNow?.name ?? handoff.company_name}</span>
                    </div>

                    {pkg.client && (
                      <div className="icm-bring-part">
                        <div className="icm-bring-t">
                          <b>Client details</b>
                          <span>{clientMode === "keep" ? "Nothing changes" : changing ? `${changing} field${changing === 1 ? "" : "s"} will change` : "Already up to date"}</span>
                        </div>
                        <div className="icm-modes" role="radiogroup" aria-label="Client details">
                          {([
                            ["keep", "Keep current", "Leave the client as it is"],
                            ["fill", "Fill the blanks", "Only add what is missing"],
                            ["update", "Update", "Take everything sales sent"],
                          ] as const).map(([v, t, sub]) => (
                            <button type="button" key={v} role="radio" aria-checked={clientMode === v} className={clientMode === v ? "is-on" : ""} onClick={() => setClientMode(v)}>
                              <b>{t}</b><small>{sub}</small>
                            </button>
                          ))}
                        </div>
                        {pkg.client.mode === "update" && <p className="icm-hint">Sales suggested updating the details.</p>}
                        {clientRows.some((r) => r.differs) ? (
                          <table className="icm-diff">
                            <thead><tr><th /><th>On the client</th><th>Sent by sales</th></tr></thead>
                            <tbody>
                              {clientRows.filter((r) => r.differs).map((r) => (
                                <tr key={r.key} className={r.takes ? "is-taking" : ""}>
                                  <th>{r.label}</th>
                                  <td className={r.takes ? "is-old" : ""}>{r.nowV || <em>empty</em>}</td>
                                  <td>{r.sentV}{r.takes && <i>will be saved</i>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : <p className="icm-hint">Sales sent the same details the client already has.</p>}
                      </div>
                    )}

                    {(pkg.documents?.length ?? 0) > 0 && (
                      <div className="icm-bring-part">
                        <div className="icm-bring-t">
                          <b>Documents</b>
                          <span>{docsIn} of {pkg.documents!.length} added · existing files are never replaced</span>
                        </div>
                        <ul className="icm-docs">
                          {pkg.documents!.map((d) => {
                            const dest = docDest[d.id] ?? "skip";
                            const dupHere = isDup(d, d.dest ?? "skip");
                            return (
                              <li key={d.id} className={`icm-doc ${dest === "skip" ? "is-skip" : ""}`}>
                                <FileIcon kind={kindOf(d.name, d.mime)} />
                                <span className="icm-doc-main">
                                  <button type="button" onClick={() => openTrackingFile(d.path, d.bucket)} title={`Open ${d.name}`}>{d.name}</button>
                                  <small>
                                    {d.lineLabel ? `${d.lineLabel}${d.version ? ` · ${d.version}` : ""} · ` : ""}{prettySize(d.size)}
                                    {dupHere && <em> · already in {destFolder(d.dest ?? "skip")}</em>}
                                  </small>
                                </span>
                                <span className="icm-doc-dest">
                                  <Select size="sm" value={dest} onChange={(v) => setDocDest((m) => ({ ...m, [d.id]: v }))} options={docOpts} aria-label={`Where ${d.name} goes`} />
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}

                    {((pkg.notes?.length ?? 0) > 0 || (pkg.tasks?.length ?? 0) > 0) && (
                      <p className="icm-bring-note">
                        {[
                          pkg.notes?.length ? `${pkg.notes.length} note${pkg.notes.length === 1 ? "" : "s"}` : "",
                          pkg.tasks?.length ? `${pkg.tasks.length} task${pkg.tasks.length === 1 ? "" : "s"}` : "",
                        ].filter(Boolean).join(" and ")} from this sale show on the client in their own block, apart from the client's own.
                      </p>
                    )}
                  </div>
                )}

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
                    <span className="icm-rate-pill">{num(consultorDays + supervisionDays)} days sold <em>{num(supervisionDays)} go to supervision</em></span>
                  </div>
                  <div className="icm-grid3">
                    <div className="icm-field"><label>Consultor days</label><NumField value={consultorDays} onChange={setConsultorDays} suffix="d" /></div>
                    <div className="icm-field"><label>Connector days</label><NumField value={connectorDays} onChange={setConnectorDays} suffix="d" /></div>
                    <div className="icm-field"><label>Price / day</label><NumField value={pricePerDay} onChange={setPricePerDay} suffix="€" /></div>
                  </div>
                  <div className="icm-grid3">
                    <div className="icm-field"><label>Discount (€ off the total)</label><NumField value={discount} onChange={setDiscount} suffix="€" /></div>
                  </div>
                  <div className="icm-line">
                    <span>{num(totalConsultancy)} days × {eur(pricePerDay)} €{discount > 0 ? ` − ${eur(discount)} € discount` : ""}</span>
                    <b>{eur(consultancyNet)} €</b>
                  </div>
                </div>

                {/* Supervision */}
                <div className="icm-block" style={{ animationDelay: "380ms" }}>
                  <div className="icm-block-head">
                    <span className="icm-step">3</span>
                    <span className="icm-sec-title">Supervision</span>
                  </div>
                  <div className="icm-grid3">
                    <div className="icm-field"><label>Days</label><NumField value={supervisionDays} onChange={setSupervisionDays} suffix="d" /></div>
                    <div className="icm-field"><label>Price / day</label><NumField value={supervisionPrice} onChange={setSupervisionPrice} suffix="€" /></div>
                    <div className="icm-field"><label>Discount / day</label><NumField value={supDiscount} onChange={setSupDiscount} suffix="€" /></div>
                  </div>
                  {supervisionDays > 0 && (
                    <div className="icm-line">
                      <span>{num(supervisionDays)} days × {eur(Math.max(0, supervisionPrice - supDiscount))} €{supDiscount > 0 ? ` (${eur(supervisionPrice)} − ${eur(supDiscount)})` : ""}</span>
                      <b>{eur(supervisionNet)} €</b>
                    </div>
                  )}
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